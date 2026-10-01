# kora-monitor-bot

Push-only Telegram notifier for the self-hosted **Kora relayer**. It polls Solana
RPC and notifies (batched) about **new** transactions on:
- native SOL treasury (fee-payer balance)
- fee revenue token accounts (any tokens via ATA list)

Use `WATCH_*_FEE_TOKENS` (one list var per cluster) for tokens. No dedicated
variable per token/coin.

It is outbound-only: it never receives or relays Telegram messages.

**Batching**: collects everything seen during a poll tick and sends 1 (or few split)
message(s) per active target. Avoids Telegram rate limits and hundreds of
separate pings on bursts (hundreds of fee tx per minute).

**Visuals**: 🟢 <b>MAINNET</b> vs 🧪 <b>DEVNET</b> badges for instant cluster recognition.

Requires **Node 26+**. Built on `@solana/kit` (the current official Solana JS SDK).

Fully env-var driven — no config files, no required host paths/volumes. Balance
handling:

- `treasury` targets → `getBalance` (native SOL lamports).
- `fee` targets → `getTokenAccountBalance` on a specific SPL token account (ATA).
  The symbol (USDC / USDT / anything) is just a label you provide.
- Single-tx events show the spent/received delta. On bursts the bot sends a compact
  batch summary with net delta + count + recent tx links (instead of hundreds of msgs).
- The watched account address is always shown in full (`<code>` block, tap to
  copy) with a cluster-correct Solana Explorer link right next to it.
- **Runway** (SOL treasury only): every message with a treasury balance also prints
  roughly how many more sponsored txs that balance covers, per flow, with the per-tx
  cost used for the estimate in parentheses —
  `~72 CCTP (0.00410748) · ~144 +ATA (0.00205428) · ~19.8k plain (0.000015)`. Compare
  the bracketed figure with the `spent:` delta in the same message: a real tx costing
  visibly more means a network/priority-fee spike, and the runway is then optimistic.
  Costs are the measured mainnet
  figures (CCTP burn `0.00410748` SOL, first-time-recipient ATA rent `0.00203928` SOL
  + base fee, bare transfer `0.000015` SOL). Kora itself
  has **no minimum-balance setting** — its only limit is the per-tx ceiling
  `validation.max_allowed_lamports` (0.01 SOL), so once the balance drops under that
  the bot adds a top-up warning.

**Key point about tokens**: the fee-payer has a *different* token account (ATA)
for each mint. USDC revenue ATA and USDT revenue ATA are different addresses.
You specify the concrete ATA + symbol in the list.

On startup the bot sends one summary message listing the active targets and the
poll interval, so you can confirm it is live. For treasury targets that summary also
carries the current SOL balance and the runway lines, so the startup message alone
answers "how many more txs can we sponsor" (an RPC failure there degrades to
`balance: unavailable` instead of losing the summary). On the very first run for each
address it records the latest signature as a baseline and does **not** replay
history.

## Config (env)

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | yes | — | Bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | yes | — | Numeric chat id to notify |
| `POLL_INTERVAL_MS` | no | `60000` | Poll interval in ms |
| `DEVNET_RPC_URL` | no | `https://api.devnet.solana.com` | Devnet RPC |
| `MAINNET_RPC_URL` | no | `https://api.mainnet-beta.solana.com` | Mainnet RPC |
| `WATCH_DEVNET_TREASURY_ADDRESS` | no | (unset = not watched) | Devnet fee-payer **native SOL** balance |
| `WATCH_MAINNET_TREASURY_ADDRESS` | no | (unset = not watched) | Mainnet fee-payer **native SOL** balance |
| `WATCH_DEVNET_FEE_TOKENS` | no | (unset) | Devnet fee revenue **token accounts** (list).<br>Format: `ata1:SYMBOL,ata2:SYMBOL2` |
| `WATCH_MAINNET_FEE_TOKENS` | no | (unset) | Mainnet fee revenue **token accounts** (list).<br>Format: `ata1:SYMBOL,ata2:SYMBOL2` |

Treasury vars = native SOL. All fee tokens (USDC, USDT, others) go through the
`*_FEE_TOKENS` list vars (one per cluster). No per-coin variables.

## Run

Local (Node 26+):

```bash
cp .env.example .env   # fill in TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID
npm install
npm run dev            # tsx watch, hot reload
# or: npm run build && npm start
```

Docker:

```bash
cp .env.example .env   # fill in the vars you want, at minimum the two required ones
docker compose up -d --build
```

No `./config` or `./data` host mounts — everything is env-driven. State (last-seen
signatures) lives inside the container only and does **not** survive container
recreation; that's an accepted tradeoff, not a bug.

## Tests

```bash
npm test        # builds, then runs the e2e suite (node:test, ~3s, no network)
```

`test/e2e.test.mjs` spawns the **real built bot** (`dist/index.js`) as a child process
with `test/fake-rpc.mjs` preloaded. That stub replaces `globalThis.fetch` before the bot
starts, so every Solana RPC call is answered from a scripted scenario and every Telegram
message is captured instead of sent — the run is hermetic (any unexpected outbound
request throws) and nothing inside the bot is mocked out. Each test drives the whole
path: env vars → RPC → state file → the rendered Telegram message.

Covered: startup summary (balance + runway, none for token accounts), the low-balance
warning under `max_allowed_lamports`, a new treasury tx (spent delta, runway, state
advance), an incoming token fee, burst batching with capped links, an RPC failure
degrading a single line instead of killing the bot, restart-with-state not re-announcing
history, and the empty-config exit.

Scenarios are plain JSON: per address, per RPC method, a list of responses consumed one
per call (the last entry repeats). Note the call order for a treasury — the startup
summary fetches the balance *before* the first poll does.

## Getting your `TELEGRAM_CHAT_ID`

Message **@userinfobot** on Telegram; it replies with your numeric id. Put that
number into `TELEGRAM_CHAT_ID`. For a group, add the bot to the group and use the
group's chat id.

## License

MIT, see [LICENSE](LICENSE).
