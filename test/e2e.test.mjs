// End-to-end tests: the REAL built bot (dist/index.js) is spawned as a child process
// with a preloaded stub (test/fake-rpc.mjs) that answers Solana RPC and swallows
// Telegram. Nothing here talks to the network, and no bot code is mocked out — each
// test drives the whole path env -> RPC -> state -> rendered Telegram message.
//
// Run with `npm test` (builds first). Requires no extra dependencies: node:test only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getBase58Decoder } from '@solana/kit';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const BOT_ROOT = dirname(TEST_DIR);
const ENTRY = join(BOT_ROOT, 'dist', 'index.js');
const PRELOAD = pathToFileURL(join(TEST_DIR, 'fake-rpc.mjs')).href;

// Real mainnet/devnet addresses from docs/ — they must be valid base58 pubkeys,
// because the bot runs them through @solana/kit's `address()` assertion.
const TREASURY = 'Hejav6DnaNd7XeAbV7Muu7PiifgYHPzXpZQDcqYNSNNg'; // mainnet fee-payer
const USDC_ATA = 'BHLNEsoCbtgHDUNd5qB1jeD2tRRF88676HGHrSJMd1Ly'; // mainnet USDC fee revenue
const DEVNET_TREASURY = 'FqqJ9aAgwGQBosT8Re3wdqqKVR7aTEvHez5P58MyvXrF'; // devnet fee-payer

// Deterministic, *valid* 64-byte signatures — `signature()` decodes and length-checks them.
function fakeSignature(seed) {
  const bytes = new Uint8Array(64);
  for (let i = 0; i < 64; i++) bytes[i] = (seed * 31 + i * 7 + 1) % 251;
  return getBase58Decoder().decode(bytes);
}

const SIG = Array.from({ length: 10 }, (_, i) => fakeSignature(i + 1));

function sig(s, blockTime = 1_750_000_000, err = null) {
  return { signature: s, blockTime, err };
}

/**
 * Spawn the built bot with a scripted RPC scenario and collect its Telegram messages.
 * Resolves as soon as `expectMessages` have been sent (then kills the bot), or when
 * the bot exits on its own, or on timeout.
 */
async function runBot({ scenario, env = {}, expectMessages = 1, timeoutMs = 10_000, stateSeed }) {
  const dir = await mkdtemp(join(tmpdir(), 'kora-bot-test-'));
  const stateFile = join(dir, 'state.json');
  if (stateSeed) writeFileSync(stateFile, JSON.stringify(stateSeed, null, 2));

  const child = spawn(
    process.execPath,
    ['--import', PRELOAD, ENTRY],
    {
      // cwd is the temp dir so a developer's real monitor-bot/.env can never leak in
      // (the bot loads dotenv from the current working directory).
      cwd: dir,
      env: {
        PATH: process.env.PATH,
        TELEGRAM_BOT_TOKEN: 'test:token',
        TELEGRAM_CHAT_ID: '424242',
        DEVNET_RPC_URL: 'http://rpc.test/devnet',
        MAINNET_RPC_URL: 'http://rpc.test/mainnet',
        POLL_INTERVAL_MS: '250',
        STATE_FILE: stateFile,
        FAKE_RPC: JSON.stringify(scenario ?? {}),
        ...env,
      },
    },
  );

  const messages = [];
  let stdout = '';
  let stderr = '';

  const done = new Promise((resolve) => {
    const finish = (exitCode) => resolve({ messages, stdout, stderr, exitCode, stateFile });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(null);
    }, timeoutMs);

    child.stdout.on('data', (buf) => {
      stdout += buf;
      for (const line of String(buf).split('\n')) {
        if (!line.startsWith('TG>>>')) continue;
        messages.push(JSON.parse(line.slice('TG>>>'.length)));
        if (messages.length >= expectMessages) {
          // Give the bot a moment to flush its state file before killing it.
          setTimeout(() => child.kill('SIGTERM'), 150);
        }
      }
    });
    child.stderr.on('data', (buf) => {
      stderr += buf;
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      finish(code);
    });
  });

  return done;
}

test('startup summary reports treasury balance + runway, and nothing extra for token accounts', async () => {
  const { messages, exitCode } = await runBot({
    expectMessages: 1,
    scenario: {
      [TREASURY]: {
        getBalance: [297_487_320],
        getSignaturesForAddress: [[sig(SIG[0])], []],
      },
      [USDC_ATA]: {
        getTokenAccountBalance: [{ amount: '1000000', decimals: 6 }],
        getSignaturesForAddress: [[sig(SIG[1])], []],
      },
    },
    env: {
      WATCH_MAINNET_TREASURY_ADDRESS: TREASURY,
      WATCH_MAINNET_FEE_TOKENS: `${USDC_ATA}:USDC`,
    },
  });

  assert.equal(messages.length, 1, 'exactly one startup message, no history notifications');
  const [msg] = messages;
  assert.match(msg, /Kora monitor started/);
  assert.match(msg, /balance: <b>0\.297487320 SOL<\/b>/);
  assert.ok(
    msg.includes('~72 CCTP (0.00410748) · ~144 +ATA (0.00205428) · ~19.8k plain (0.000015)'),
    `runway line missing or wrong:\n${msg}`,
  );
  // The token bullet must NOT carry a runway — token accounts never pay gas.
  assert.equal(msg.match(/runway/g).length, 1);
  assert.ok(!msg.includes('below the'), 'no top-up warning at a healthy balance');
  assert.notEqual(exitCode, 1);
});

test('startup summary warns when the balance is under the 0.01 SOL per-tx cap', async () => {
  const { messages } = await runBot({
    expectMessages: 1,
    scenario: {
      [TREASURY]: {
        getBalance: [9_000_000],
        getSignaturesForAddress: [[sig(SIG[0])], []],
      },
    },
    env: { WATCH_MAINNET_TREASURY_ADDRESS: TREASURY },
  });

  const [msg] = messages;
  assert.match(msg, /balance: <b>0\.009000000 SOL<\/b>/);
  assert.ok(msg.includes('~2 CCTP (0.00410748) · ~4 +ATA (0.00205428) · ~600 plain (0.000015)'), msg);
  assert.match(msg, /below the <b>0\.01 SOL<\/b> per-tx cap/);
});

test('a new treasury tx is reported with the spent delta, runway and explorer link', async () => {
  const { messages, stateFile } = await runBot({
    expectMessages: 2, // startup summary, then the tx notification
    scenario: {
      [TREASURY]: {
        // startup summary, first poll (baseline), then the poll that sees the new tx
        getBalance: [297_487_320, 297_487_320, 293_379_840],
        getSignaturesForAddress: [[sig(SIG[0])], [sig(SIG[1], 1_750_000_500)], []],
      },
    },
    env: { WATCH_MAINNET_TREASURY_ADDRESS: TREASURY },
  });

  assert.equal(messages.length, 2);
  const msg = messages[1];
  assert.match(msg, /📤 🟢 <b>MAINNET<\/b> · treasury/);
  assert.match(msg, /spent: <b>−0\.00410748 SOL<\/b>/);
  assert.match(msg, /balance: <b>0\.293379840 SOL<\/b> \(was 0\.29748732 SOL\)/);
  assert.ok(msg.includes('~71 CCTP (0.00410748)'), msg);
  assert.ok(msg.includes(`https://explorer.solana.com/tx/${SIG[1]}`), 'links to the new tx');

  const state = JSON.parse(await readFile(stateFile, 'utf8'));
  assert.equal(state[TREASURY].lastSignature, SIG[1], 'state advanced to the newest signature');
  assert.equal(state[TREASURY].lastBalanceRaw, '293379840');
});

test('incoming token fee is reported in token units and carries no runway line', async () => {
  const { messages } = await runBot({
    expectMessages: 2,
    scenario: {
      [USDC_ATA]: {
        getTokenAccountBalance: [
          { amount: '1000000', decimals: 6 },
          { amount: '1500000', decimals: 6 },
        ],
        getSignaturesForAddress: [[sig(SIG[0])], [sig(SIG[2])], []],
      },
    },
    env: { WATCH_MAINNET_FEE_TOKENS: `${USDC_ATA}:USDC` },
  });

  const msg = messages[1];
  assert.match(msg, /📥 🟢 <b>MAINNET<\/b> · fee \(USDC\)/);
  assert.match(msg, /received: <b>\+0\.5 USDC<\/b>/);
  assert.match(msg, /balance: <b>1\.5 USDC<\/b> \(was 1 USDC\)/);
  assert.ok(!msg.includes('runway'), 'token accounts pay no gas, so no runway estimate');
});

test('a burst of transactions is batched into one message with capped links', async () => {
  const burst = [7, 6, 5, 4, 3, 2, 1].map((i) => sig(SIG[i]));
  const { messages } = await runBot({
    expectMessages: 2,
    scenario: {
      [DEVNET_TREASURY]: {
        getBalance: [1_000_000_000, 1_000_000_000, 999_895_000],
        getSignaturesForAddress: [[sig(SIG[0])], burst, []],
      },
    },
    env: { WATCH_DEVNET_TREASURY_ADDRESS: DEVNET_TREASURY },
  });

  const msg = messages[1];
  assert.match(msg, /🧪 <b>DEVNET<\/b> · treasury/);
  assert.match(msg, /7 new transactions/);
  assert.match(msg, /net spent: <b>−0\.000105 SOL<\/b>/);
  assert.match(msg, /\+2 more/, 'only the 5 most recent links are shown');
  assert.equal((msg.match(/explorer\.solana\.com\/tx\//g) ?? []).length, 5);
  assert.ok(msg.includes('?cluster=devnet'), 'devnet links point at the devnet explorer');
});

test('an RPC failure during startup degrades one line instead of killing the bot', async () => {
  const { messages, stdout } = await runBot({
    expectMessages: 1,
    scenario: {
      [TREASURY]: {
        // startup summary fails, the following poll succeeds
        getBalance: ['error', 297_487_320],
        getSignaturesForAddress: [[sig(SIG[0])], []],
      },
    },
    env: { WATCH_MAINNET_TREASURY_ADDRESS: TREASURY },
  });

  const [msg] = messages;
  assert.match(msg, /balance: <i>unavailable \(RPC error\)<\/i>/);
  assert.ok(!msg.includes('runway'), 'no runway when the balance is unknown');
  assert.match(stdout, /baseline set for mainnet\/treasury/, 'the bot kept polling afterwards');
});

test('a restart with existing state does not re-announce historical transactions', async () => {
  const { messages, stdout } = await runBot({
    expectMessages: 1,
    scenario: {
      [TREASURY]: {
        getBalance: [297_487_320],
        getSignaturesForAddress: [[]], // nothing new since the stored signature
      },
    },
    env: { WATCH_MAINNET_TREASURY_ADDRESS: TREASURY },
    stateSeed: {
      [TREASURY]: {
        lastSignature: SIG[0],
        lastBalanceRaw: '297487320',
        decimals: 9,
        unit: 'SOL',
      },
    },
  });

  assert.equal(messages.length, 1, 'only the startup summary');
  assert.match(stdout, /loaded state for 1 address\(es\)/);
});

test('a config with no watch targets exits non-zero instead of idling silently', async () => {
  const { messages, exitCode, stderr } = await runBot({
    expectMessages: 99, // never reached: the bot must exit by itself
    timeoutMs: 8_000,
    scenario: {},
    env: {},
  });

  assert.equal(exitCode, 1);
  assert.equal(messages.length, 0, 'nothing is sent to Telegram');
  assert.match(stderr, /no watch targets configured/);
});
