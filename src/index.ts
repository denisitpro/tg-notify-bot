import 'dotenv/config';
import {
  createSolanaRpc,
  address,
  signature,
  type Address,
  type Signature,
} from '@solana/kit';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';

// ---------------------------------------------------------------------------
// Kora relayer monitor bot (push-only).
//
// Polls Solana RPC once per interval and notifies (batched) about NEW txs on
// watched accounts: SOL treasury (native) + fee revenue **token accounts**
// (USDC, USDT, or any other) on devnet + mainnet.
//
// Design:
// - Treasury: WATCH_*_TREASURY_ADDRESS (native SOL via getBalance).
// - Tokens: WATCH_*_FEE_TOKENS = "ata1:SYMBOL,ata2:SYMBOL2" (one list var per cluster).
//   Each token has its own ATA address. No separate var per token.
// - No legacy per-coin variables.
//
// Key behaviors:
// - Batching to avoid Telegram rate limits on bursts.
// - Visual cluster badges: 🟢 MAINNET vs 🧪 DEVNET.
// ---------------------------------------------------------------------------

type Cluster = 'devnet' | 'mainnet';
type Kind = 'treasury' | 'fee';

// Visual cluster badge for messages (distinct emoji + bold text for devnet vs mainnet).
function clusterBadge(cluster: Cluster): string {
  if (cluster === 'mainnet') {
    return '🟢 <b>MAINNET</b>';
  }
  // devnet: test/experimental visual
  return '🧪 <b>DEVNET</b>';
}

// Resolved, ready-to-poll target (address branded, RPC url attached).
interface WatchTarget {
  cluster: Cluster;
  kind: Kind;
  symbol?: string; // display symbol for fee tokens, e.g. "USDC", "USDT", "FOO"
  description: string;
  address: Address;
  addressStr: string;
}

// --- Config -----------------------------------------------------------------
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS) || 60000;

const DEVNET_RPC_URL = process.env.DEVNET_RPC_URL || 'https://api.devnet.solana.com';
const MAINNET_RPC_URL = process.env.MAINNET_RPC_URL || 'https://api.mainnet-beta.solana.com';

const STATE_FILE = process.env.STATE_FILE || './data/state.json';

if (!BOT_TOKEN) {
  console.error('[monitor] Missing TELEGRAM_BOT_TOKEN in env');
  process.exit(1);
}
if (!CHAT_ID) {
  console.error('[monitor] Missing TELEGRAM_CHAT_ID in env');
  process.exit(1);
}

// --- One RPC client per cluster (reused across targets) ----------------------
const rpcs: Record<Cluster, ReturnType<typeof createSolanaRpc>> = {
  devnet: createSolanaRpc(DEVNET_RPC_URL),
  mainnet: createSolanaRpc(MAINNET_RPC_URL),
};

// --- Watch target loading ----------------------------------------------------
// Treasuries are special (native SOL balance via getBalance).
//
// Fee revenue uses list-style *_FEE_TOKENS (one var per cluster).
// Format:
//   "ATA1:SYMBOL1,ATA2:SYMBOL2"
//   (comma / space / semicolon separated, addr:symbol or addr=symbol)
//
// This is the only supported way. No per-coin variables.
// Each token has its own ATA (different address per mint).

function loadTreasury(envVar: string, cluster: Cluster, description: string): WatchTarget | null {
  const raw = process.env[envVar];
  const addr = typeof raw === 'string' ? raw.trim() : '';
  if (addr.length === 0) return null;
  return {
    cluster,
    kind: 'treasury',
    description,
    address: address(addr),
    addressStr: addr,
  };
}

// Parse a FEE_TOKENS list into targets. Makes it obvious these are for tokens.
function loadFeeTokens(envVar: string, cluster: Cluster): WatchTarget[] {
  const raw = process.env[envVar];
  if (typeof raw !== 'string' || raw.trim().length === 0) return [];

  const out: WatchTarget[] = [];
  // split on ,, ; or whitespace
  const parts = raw.split(/[,;\s]+/).map((p) => p.trim()).filter(Boolean);

  for (const part of parts) {
    // support "addr:SYMBOL" or "addr=SYMBOL"
    const [addrRaw, symRaw] = part.split(/[:=]/);
    const addr = (addrRaw || '').trim();
    if (!addr) continue;
    const symbol = (symRaw || 'TOKEN').trim().toUpperCase();

    out.push({
      cluster,
      kind: 'fee',
      symbol,
      description: `${cluster === 'devnet' ? 'Devnet' : 'Mainnet'} ${symbol} fee revenue`,
      address: address(addr),
      addressStr: addr,
    });
  }
  return out;
}

function loadTargets(): WatchTarget[] {
  const targets: WatchTarget[] = [];

  // Native SOL treasuries (one var each, special because getBalance not token balance)
  const devTreas = loadTreasury('WATCH_DEVNET_TREASURY_ADDRESS', 'devnet', 'Devnet fee-payer SOL treasury');
  if (devTreas) targets.push(devTreas);

  const mainTreas = loadTreasury('WATCH_MAINNET_TREASURY_ADDRESS', 'mainnet', 'Mainnet fee-payer SOL treasury');
  if (mainTreas) targets.push(mainTreas);

  // Fee token accounts — general list form (the recommended and only way now).
  // Add as many as you want in one var: addr1:USDC,addr2:USDT,addr3:FOO
  // No per-coin variables. One *_FEE_TOKENS per cluster.
  targets.push(...loadFeeTokens('WATCH_DEVNET_FEE_TOKENS', 'devnet'));
  targets.push(...loadFeeTokens('WATCH_MAINNET_FEE_TOKENS', 'mainnet'));

  return targets;
}

// --- State persistence ------------------------------------------------------
// state = { [address]: { lastSignature, lastBalanceRaw, decimals, unit } }
interface AddressState {
  lastSignature: string;
  lastBalanceRaw: string; // bigint serialized as a decimal string (JSON has no bigint)
  decimals: number;
  unit: string; // 'SOL' or the token symbol
}
type State = Record<string, AddressState>;
let state: State = {};

async function ensureStateDir(): Promise<void> {
  try {
    await mkdir(dirname(STATE_FILE), { recursive: true });
  } catch {
    // ignore
  }
}

async function loadState(): Promise<void> {
  try {
    const raw = await readFile(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw) as State;
    const values = Object.values(parsed);
    // Defensive guard: old state files stored a bare `address -> lastSignature`
    // string. Discard those instead of crashing on the new shape.
    if (values.length > 0 && typeof values[0] !== 'object') {
      console.log('[monitor] state file is in an old format, discarding and starting fresh');
      state = {};
      return;
    }
    state = parsed;
    console.log(
      `[monitor] loaded state for ${Object.keys(state).length} address(es) from ${STATE_FILE}`,
    );
  } catch {
    state = {};
    console.log('[monitor] no previous state, starting fresh');
  }
}

async function saveState(): Promise<void> {
  try {
    await ensureStateDir();
    await writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (e) {
    console.warn('[monitor] failed to save state', e);
  }
}

// --- Telegram (plain Bot API, no telegraf) ----------------------------------
async function sendTelegram(text: string): Promise<void> {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Telegram API ${res.status}: ${body}`);
  }
}

// --- Helpers ----------------------------------------------------------------
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function shortAddr(addr: string): string {
  if (addr.length <= 9) return addr;
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

function explorerTxUrl(sig: string, cluster: Cluster): string {
  const base = `https://explorer.solana.com/tx/${sig}`;
  return cluster === 'devnet' ? `${base}?cluster=devnet` : base;
}

function explorerAddressUrl(addr: string, cluster: Cluster): string {
  const base = `https://explorer.solana.com/address/${addr}`;
  return cluster === 'devnet' ? `${base}?cluster=devnet` : base;
}

// kit returns blockTime as a bigint (UnixTimestamp) or null.
function formatBlockTime(blockTime: bigint | null | undefined): string | null {
  if (blockTime == null) return null;
  return new Date(Number(blockTime) * 1000)
    .toISOString()
    .replace('T', ' ')
    .replace('.000Z', ' UTC');
}

// Header label for a target (e.g. "treasury" or "fee (USDC)" / "fee (USDT)").
function targetLabel(target: WatchTarget): string {
  if (target.kind === 'fee') {
    return target.symbol ? `fee (${target.symbol})` : 'fee';
  }
  return 'treasury';
}

// Raw on-chain balance, unformatted (bigint math to avoid float precision loss).
interface BalanceInfo {
  raw: bigint;
  decimals: number;
  unit: string; // 'SOL' for treasury, the token symbol for fee
}

// Fetch the account's current balance.
async function fetchBalanceInfo(target: WatchTarget): Promise<BalanceInfo> {
  const rpc = rpcs[target.cluster];
  if (target.kind === 'treasury') {
    // getBalance returns lamports as a bigint.
    const { value: lamports } = await rpc.getBalance(target.address).send();
    return { raw: lamports, decimals: 9, unit: 'SOL' };
  }
  // fee -> token account balance.
  const { value } = await rpc.getTokenAccountBalance(target.address).send();
  return { raw: BigInt(value.amount), decimals: value.decimals, unit: target.symbol ?? '' };
}

// Fixed-point divide raw by 10^decimals, trimming trailing zeros (and a
// trailing '.') for readability. Bigint math throughout — no float precision loss.
function formatAmount(raw: bigint, decimals: number): string {
  const neg = raw < 0n;
  const abs = neg ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = abs % base;
  const fracStr = decimals > 0 ? frac.toString().padStart(decimals, '0').replace(/0+$/, '') : '';
  const out = fracStr.length > 0 ? `${whole}.${fracStr}` : whole.toString();
  return neg ? `-${out}` : out;
}

// Signed delta for the "spent/received" line: '+' for received, U+2212 minus for spent.
function formatSignedDelta(delta: bigint, decimals: number): string {
  const sign = delta < 0n ? '−' : '+';
  const abs = delta < 0n ? -delta : delta;
  return `${sign}${formatAmount(abs, decimals)}`;
}

// Full balance display line. Treasury/SOL keeps the old fixed 9-decimal look;
// token balances use the trimmed formatAmount() (close to old uiAmountString).
function formatBalanceLine(info: BalanceInfo): string {
  if (info.unit === 'SOL') {
    return `${(Number(info.raw) / 1e9).toFixed(9)} SOL`;
  }
  const amount = formatAmount(info.raw, info.decimals);
  return info.unit ? `${amount} ${info.unit}` : amount;
}

// --- Fee-payer runway --------------------------------------------------------
// Kora has NO minimum-balance / minimum-fee setting. The only limit in its config is
// the PER-TX ceiling `validation.max_allowed_lamports` (0.01 SOL on our instances) —
// a tx that would cost the fee-payer more than that is refused. In practice the
// relayer simply stops sponsoring once the fee-payer runs out of SOL, so the useful
// number to show next to a treasury balance is how many more txs it still covers.
//
// The per-tx costs below are MEASURED on mainnet, not guessed — see
// docs/mainnet-state.md ("Confirmed fee economics") and docs/mainnet-mvp-plan.md:
//   plain  — base network fee only, recipient already has an ATA (0.000015 SOL)
//   +ATA   — first-time recipient: base fee + 0.00203928 SOL ATA rent
//   CCTP   — gasless CCTP v2 burn: 0.00410748 SOL (a new MessageSent account per burn)
const MAX_ALLOWED_LAMPORTS = 10_000_000n; // validation.max_allowed_lamports = 0.01 SOL

const TX_COSTS: { label: string; lamports: bigint }[] = [
  { label: 'CCTP', lamports: 4_107_480n },
  { label: '+ATA', lamports: 2_054_280n },
  { label: 'plain', lamports: 15_000n },
];

// Compact tx count so the runway line stays one short line (19832 -> "19.8k").
function formatTxCount(n: bigint): string {
  if (n < 10_000n) return n.toString();
  if (n < 1_000_000n) return `${(Number(n) / 1_000).toFixed(1)}k`;
  return `${(Number(n) / 1_000_000).toFixed(1)}M`;
}

// Runway lines for a native SOL treasury: roughly how many more sponsored txs the
// current balance covers, per flow. Empty for token accounts — they never pay gas.
//
// Each entry carries the per-tx cost the estimate is based on, in parentheses, so the
// `spent:` delta in the same message can be eyeballed against it — a real tx costing
// noticeably more than the bracketed figure means a network/priority-fee spike (or a
// flow we haven't measured), and the runway numbers are then optimistic.
function formatRunwayLines(info: BalanceInfo): string[] {
  if (info.unit !== 'SOL') return [];
  const runway = TX_COSTS.map(
    (c) => `~${formatTxCount(info.raw / c.lamports)} ${c.label} (${formatAmount(c.lamports, 9)})`,
  ).join(' · ');
  const lines = ['runway <i>(est. SOL/tx)</i>:', `<b>${runway}</b>`];
  if (info.raw < MAX_ALLOWED_LAMPORTS) {
    lines.push(
      '⚠️ below the <b>0.01 SOL</b> per-tx cap (<code>max_allowed_lamports</code>) — top up, the next sponsored tx can already fail',
    );
  }
  return lines;
}

// Fields we read off a signature entry (kit returns more, but these suffice).
interface SigInfo {
  signature: Signature;
  err: unknown;
  blockTime?: bigint | null;
}

// Activity detected in one poll tick for one target. Used for batched notifications.
interface DetectedActivity {
  target: WatchTarget;
  sigInfos: SigInfo[]; // chronological, oldest first
  current: BalanceInfo;
  netDelta: bigint;
  prevBalanceRaw: bigint;
}

// Build the Telegram message for a single new transaction.
function buildTxMessage(
  target: WatchTarget,
  info: SigInfo,
  current: BalanceInfo,
  delta: bigint,
): string {
  const when = formatBlockTime(info.blockTime);
  const link = explorerTxUrl(info.signature, target.cluster);
  const addrLink = explorerAddressUrl(target.addressStr, target.cluster);

  let icon: string;
  if (delta < 0n) icon = '📤';
  else if (delta > 0n) icon = '📥';
  else if (info.err) icon = '❌';
  else icon = 'ℹ️';

  const before = formatAmount(current.raw - delta, current.decimals);
  const unitSuffix = current.unit ? ` ${escapeHtml(current.unit)}` : '';

  const lines = [
    `${icon} ${clusterBadge(target.cluster)} · ${targetLabel(target)}`,
    target.description ? escapeHtml(target.description) : '',
    `<code>${escapeHtml(target.addressStr)}</code> · <a href="${addrLink}">↗ explorer</a>`,
    info.err ? '⚠️ tx failed' : '',
    delta !== 0n
      ? `${delta < 0n ? 'spent' : 'received'}: <b>${escapeHtml(formatSignedDelta(delta, current.decimals))}${unitSuffix}</b>`
      : '',
    `balance: <b>${escapeHtml(formatBalanceLine(current))}</b> (was ${escapeHtml(before)}${unitSuffix})`,
  ].filter((l) => l.length > 0);
  lines.push(...formatRunwayLines(current));
  if (when) lines.push(`🕒 ${escapeHtml(when)}`);
  lines.push(`<a href="${link}">${escapeHtml(shortAddr(info.signature))} ↗</a>`);
  return lines.join('\n');
}

// Build a compact summary for multiple transactions on the same target in one poll.
// Used to avoid sending hundreds of individual messages during bursts.
function buildBatchMessage(
  target: WatchTarget,
  sigInfos: SigInfo[],
  current: BalanceInfo,
  netDelta: bigint,
  prevRaw: bigint,
): string {
  const count = sigInfos.length;
  const lastWhen = formatBlockTime(sigInfos[sigInfos.length - 1]?.blockTime);
  const addrLink = explorerAddressUrl(target.addressStr, target.cluster);

  const icon = netDelta < 0n ? '📤' : netDelta > 0n ? '📥' : 'ℹ️';
  const unitSuffix = current.unit ? ` ${escapeHtml(current.unit)}` : '';
  const before = formatAmount(prevRaw, current.decimals);
  const failed = sigInfos.filter((s) => s.err).length;
  const extra = failed > 0 ? ` (${failed} failed)` : '';

  const lines: string[] = [
    `${icon} ${clusterBadge(target.cluster)} · ${targetLabel(target)}`,
    target.description ? escapeHtml(target.description) : '',
    `<code>${escapeHtml(target.addressStr)}</code> · <a href="${addrLink}">↗ explorer</a>`,
    `${count} new transaction${count !== 1 ? 's' : ''}${extra}`,
  ];
  if (netDelta !== 0n) {
    lines.push(
      `net ${netDelta < 0n ? 'spent' : 'received'}: <b>${escapeHtml(formatSignedDelta(netDelta, current.decimals))}${unitSuffix}</b>`,
    );
  }
  lines.push(
    `balance: <b>${escapeHtml(formatBalanceLine(current))}</b> (was ${escapeHtml(before)}${unitSuffix})`,
  );
  lines.push(...formatRunwayLines(current));
  if (lastWhen) lines.push(`🕒 last ${escapeHtml(lastWhen)}`);

  // Show up to 5 most recent tx links (newest at end of chrono list), +N more if burst larger.
  const maxShow = 5;
  const shown = sigInfos.slice(-maxShow);
  const links = shown
    .map((s) => {
      const short = escapeHtml(shortAddr(String(s.signature)));
      const url = explorerTxUrl(String(s.signature), target.cluster);
      return `<a href="${url}">${short}</a>`;
    })
    .join(' ');
  if (links) {
    lines.push(links + (count > maxShow ? `  +${count - maxShow} more` : ''));
  }

  return lines.join('\n');
}

// Helpers for safe batched sending (respect Telegram limits ~4096 chars/msg).
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunkForTelegram(text: string, max = 3900): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    // Prefer block boundary (\n\n), then line, else hard cut.
    let cut = rest.lastIndexOf('\n\n', max);
    if (cut < Math.floor(max * 0.65)) cut = rest.lastIndexOf('\n', max);
    if (cut < Math.floor(max * 0.5)) cut = max;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

async function sendLongMessage(text: string): Promise<void> {
  const chunks = chunkForTelegram(text);
  for (let i = 0; i < chunks.length; i++) {
    const prefix = chunks.length > 1 ? `<i>(${i + 1}/${chunks.length})</i>\n` : '';
    await sendTelegram(prefix + chunks[i]);
    if (i < chunks.length - 1) await sleep(180); // be gentle on rate limits
  }
}

async function notifyActivities(activities: DetectedActivity[]): Promise<void> {
  if (activities.length === 0) return;

  // Build one block per active target. Single-tx keeps the detailed per-tx format.
  const blocks: string[] = [];
  for (const act of activities) {
    if (act.sigInfos.length === 1) {
      const info = act.sigInfos[0];
      blocks.push(buildTxMessage(act.target, info, act.current, act.netDelta));
    } else {
      blocks.push(
        buildBatchMessage(act.target, act.sigInfos, act.current, act.netDelta, act.prevBalanceRaw),
      );
    }
  }

  const combined = blocks.join('\n\n');
  await sendLongMessage(combined);
}

// --- Poll logic -------------------------------------------------------------
async function pollTarget(target: WatchTarget): Promise<DetectedActivity | null> {
  const rpc = rpcs[target.cluster];
  const prev = state[target.addressStr];

  // First run for this address: set a baseline, do not notify for history.
  if (!prev) {
    const sigs = await rpc.getSignaturesForAddress(target.address, { limit: 1 }).send();
    if (sigs.length > 0) {
      let baseline: BalanceInfo;
      try {
        baseline = await fetchBalanceInfo(target);
      } catch (e) {
        console.warn(
          `[monitor] baseline balance fetch failed for ${target.cluster}/${target.kind} ${shortAddr(target.addressStr)}`,
          e,
        );
        // Store a zeroed baseline so the next real diff can still be computed.
        // The first delta after this will look bogus once but that's acceptable.
        baseline =
          target.kind === 'treasury'
            ? { raw: 0n, decimals: 9, unit: 'SOL' }
            : { raw: 0n, decimals: 0, unit: target.symbol ?? '' };
      }
      state[target.addressStr] = {
        lastSignature: sigs[0].signature,
        lastBalanceRaw: baseline.raw.toString(),
        decimals: baseline.decimals,
        unit: baseline.unit,
      };
      console.log(
        `[monitor] baseline set for ${target.cluster}/${target.kind} ${shortAddr(target.addressStr)} = ${shortAddr(sigs[0].signature)}`,
      );
    } else {
      console.log(
        `[monitor] no history yet for ${target.cluster}/${target.kind} ${shortAddr(target.addressStr)}`,
      );
    }
    return null;
  }

  // Fetch new signatures since the last stored one (newest-first from RPC).
  // Use high limit so we don't drop txs during bursts (RPC max is 1000).
  const sigs = await rpc
    .getSignaturesForAddress(target.address, { until: signature(prev.lastSignature), limit: 1000 })
    .send();
  if (sigs.length === 0) return null;

  // Fetch the current balance once (it's the same live value regardless of
  // how many new signatures showed up this tick).
  let current: BalanceInfo;
  try {
    current = await fetchBalanceInfo(target);
  } catch (e) {
    console.warn(
      `[monitor] balance fetch failed for ${target.cluster}/${target.kind} ${shortAddr(target.addressStr)}`,
      e,
    );
    // Fall back to the previous balance so the delta reads as zero instead of crashing.
    current = { raw: BigInt(prev.lastBalanceRaw), decimals: prev.decimals, unit: prev.unit };
  }
  const netDelta = current.raw - BigInt(prev.lastBalanceRaw);

  // Reverse to chronological order (oldest → newest).
  const chronological = [...sigs].reverse();

  // Update stored state to the newest returned (first element, newest-first) BEFORE notifying.
  state[target.addressStr] = {
    lastSignature: sigs[0].signature,
    lastBalanceRaw: current.raw.toString(),
    decimals: current.decimals,
    unit: current.unit,
  };

  // Return the activity for batched notification (prevents 1 msg per tx).
  return {
    target,
    sigInfos: chronological,
    current,
    netDelta,
    prevBalanceRaw: BigInt(prev.lastBalanceRaw),
  };
}

async function pollAll(targets: WatchTarget[]): Promise<void> {
  const activities: DetectedActivity[] = [];
  for (const target of targets) {
    try {
      const act = await pollTarget(target);
      if (act) activities.push(act);
    } catch (e) {
      // One bad RPC call must not block other targets or kill the loop.
      console.error(
        `[monitor] poll error for ${target.cluster}/${target.kind} ${shortAddr(target.addressStr)}`,
        e,
      );
    }
  }
  await saveState();

  // Batch notifications: 1 (or few) messages instead of 1-per-tx.
  // This prevents Telegram rate limit explosions on bursts (e.g. 300 tx/min).
  if (activities.length > 0) {
    try {
      await notifyActivities(activities);
      for (const act of activities) {
        const n = act.sigInfos.length;
        console.log(
          `[monitor] notified ${act.target.cluster}/${act.target.kind} ${shortAddr(act.target.addressStr)} (${n} tx${n === 1 ? '' : 's'})`,
        );
      }
    } catch (e) {
      console.error('[monitor] batch notify failed', e);
    }
  }
}

// --- Startup summary --------------------------------------------------------
async function sendStartupSummary(targets: WatchTarget[]): Promise<void> {
  const lines = [
    '🟢 <b>Kora monitor started</b>',
    `Poll interval: ${Math.round(POLL_INTERVAL_MS / 1000)}s`,
    '',
    '<b>Watching:</b>',
  ];
  for (const t of targets) {
    const desc = t.description ? ` — ${escapeHtml(t.description)}` : '';
    const link = explorerAddressUrl(t.addressStr, t.cluster);
    lines.push(
      `• ${clusterBadge(t.cluster)} · ${targetLabel(t)} · <code>${escapeHtml(t.addressStr)}</code> · <a href="${link}">↗ explorer</a>${desc}`,
    );
    // Treasuries: show the current SOL balance + runway right away, so the startup
    // message alone answers "how many more txs can we sponsor". A failed RPC here
    // must not cost us the whole summary — skip the line and keep going.
    if (t.kind !== 'treasury') continue;
    try {
      const info = await fetchBalanceInfo(t);
      lines.push(`  balance: <b>${escapeHtml(formatBalanceLine(info))}</b>`);
      lines.push(...formatRunwayLines(info).map((l) => `  ${l}`));
    } catch (e) {
      console.warn(`[monitor] startup balance fetch failed for ${shortAddr(t.addressStr)}`, e);
      lines.push('  balance: <i>unavailable (RPC error)</i>');
    }
  }
  await sendTelegram(lines.join('\n'));
}

// --- Main -------------------------------------------------------------------
async function main(): Promise<void> {
  console.log('[monitor] starting...');
  console.log(`[monitor] chat id: ${CHAT_ID}`);
  console.log(`[monitor] state file: ${STATE_FILE}`);
  console.log(`[monitor] poll interval: ${POLL_INTERVAL_MS}ms`);

  const targets = loadTargets();
  console.log(`[monitor] watching ${targets.length} target(s):`);
  for (const t of targets) {
    const rpcUrl = t.cluster === 'devnet' ? DEVNET_RPC_URL : MAINNET_RPC_URL;
    console.log(`[monitor]   ${t.cluster}/${targetLabel(t)} ${t.addressStr} via ${rpcUrl}`);
  }

  if (targets.length === 0) {
    console.error('[monitor] no watch targets configured (all addresses empty) — nothing to do');
    process.exit(1);
  }

  await loadState();

  try {
    await sendStartupSummary(targets);
  } catch (e) {
    console.error('[monitor] failed to send startup summary', e);
  }

  // Run the first tick immediately, then on an interval.
  await pollAll(targets);
  const timer = setInterval(() => {
    pollAll(targets).catch((e) => console.error('[monitor] tick failed', e));
  }, POLL_INTERVAL_MS);

  // Graceful shutdown.
  const shutdown = (sig: string) => {
    console.log(`[monitor] received ${sig}, shutting down`);
    clearInterval(timer);
    process.exit(0);
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  console.log('[monitor] ready.');
}

main().catch((e) => {
  console.error('[monitor] fatal error', e);
  process.exit(1);
});
