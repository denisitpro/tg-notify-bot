// Preloaded (`node --import ./test/fake-rpc.mjs`) BEFORE the bot starts, so the stub
// replaces `globalThis.fetch` before @solana/kit and the bot capture it.
//
// It makes an e2e run fully hermetic: every outbound call is answered locally.
//   - Solana RPC  -> scripted JSON-RPC responses from the FAKE_RPC scenario
//   - Telegram    -> swallowed, printed to stdout as one `TG>>>` line per message
// Anything else throws, so a test can never silently hit the real network.
//
// Scenario (env FAKE_RPC, JSON):
//   { "<address>": { "getBalance": [...], "getTokenAccountBalance": [...],
//                    "getSignaturesForAddress": [...] } }
// Each list is consumed one entry per call to that method on that address; once
// exhausted the LAST entry repeats forever (so "steady state" needs no padding).
// An entry of "error" makes that call fail with a JSON-RPC error.

const scenario = JSON.parse(process.env.FAKE_RPC ?? '{}');
const callCounts = new Map();

function nextResponse(address, method) {
  const list = scenario[address]?.[method];
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error(`fake-rpc: no scripted ${method} for ${address}`);
  }
  const key = `${address}|${method}`;
  const i = callCounts.get(key) ?? 0;
  callCounts.set(key, i + 1);
  return list[Math.min(i, list.length - 1)];
}

const CONTEXT = { context: { apiVersion: '2.1.0', slot: 100 } };

function resultFor(method, params) {
  const address = params?.[0];
  const entry = nextResponse(address, method);
  if (entry === 'error') return { error: { code: -32000, message: 'fake-rpc: injected failure' } };

  switch (method) {
    case 'getBalance':
      // entry: lamports (number)
      return { result: { ...CONTEXT, value: entry } };
    case 'getTokenAccountBalance': {
      // entry: { amount: "<raw>", decimals: n }
      const amount = String(entry.amount);
      const decimals = entry.decimals;
      const uiAmount = Number(amount) / 10 ** decimals;
      return {
        result: {
          ...CONTEXT,
          value: { amount, decimals, uiAmount, uiAmountString: String(uiAmount) },
        },
      };
    }
    case 'getSignaturesForAddress':
      // entry: [{ signature, blockTime, err }]
      return {
        result: entry.map((s, idx) => ({
          signature: s.signature,
          slot: 100 - idx,
          err: s.err ?? null,
          memo: null,
          blockTime: s.blockTime ?? null,
          confirmationStatus: 'finalized',
        })),
      };
    default:
      return { error: { code: -32601, message: `fake-rpc: unhandled method ${method}` } };
  }
}

function handleRpc(body) {
  const one = (req) => {
    let payload;
    try {
      payload = resultFor(req.method, req.params);
    } catch (e) {
      payload = { error: { code: -32000, message: String(e.message ?? e) } };
    }
    return { jsonrpc: '2.0', id: req.id, ...payload };
  };
  return Array.isArray(body) ? body.map(one) : one(body);
}

function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : (input?.url ?? String(input));

  if (url.includes('api.telegram.org')) {
    const { text } = JSON.parse(init.body);
    // One line per message so the test can parse stdout deterministically.
    console.log(`TG>>>${JSON.stringify(text)}`);
    return jsonResponse({ ok: true, result: { message_id: 1 } });
  }

  if (url.includes('rpc.test')) {
    return jsonResponse(handleRpc(JSON.parse(init.body)));
  }

  throw new Error(`fake-rpc: unexpected outbound request to ${url}`);
};
