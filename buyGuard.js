// engine/buyGuard.js

const { getQuote } = require("../getQuote");

const SOL_MINT = "So11111111111111111111111111111111111111112";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ===== Console colors =====
const C = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
};

// ===== Math Helpers =====
function slopeBpsPerSec(series) {
  if (series.length < 2) return 0;
  const t0 = series[0].t,
    p0 = series[0].p;
  const tn = series[series.length - 1].t,
    pn = series[series.length - 1].p;
  const dt = (tn - t0) / 1000;
  if (dt <= 0) return 0;
  return (((pn - p0) / p0) * 10000) / dt;
}

function maxDropPctFromRecentMax(series) {
  if (!series.length) return 0;
  let m = -Infinity;
  const curr = series[series.length - 1].p;
  for (const x of series) m = Math.max(m, x.p);
  return m > 0 ? ((m - curr) / m) * 100 : 0;
}

// ===== Ring Buffer =====
class Ring {
  constructor(size) {
    this.size = size;
    this.arr = [];
  }
  push(v) {
    this.arr.push(v);
    if (this.arr.length > this.size) this.arr.shift();
  }
  get values() {
    return this.arr;
  }
  get length() {
    return this.arr.length;
  }
}

// ===== Price probe =====
async function spotSOLPerToken(mint, probeSolLamports, tokenDecimals) {
  const q = await getQuote(SOL_MINT, mint, probeSolLamports);
  if (!q?.outAmount) return null;
  const tokens = q.outAmount / 10 ** tokenDecimals;
  if (tokens <= 0) return null;
  const solIn = probeSolLamports / 1e9;
  return solIn / tokens;
}

// ===== Slide Guard Logic =====

async function passesBuyGuards(
  mint,
  tradeAmountSOL,
  tokenDecimals,
  guardCfg = {}
) {
  const LOOKBACK_MS = guardCfg.LOOKBACK_MS ?? 6000;
  const SAMPLES = guardCfg.SAMPLES ?? 6;
  const MIN_SLOPE = guardCfg.MIN_SLOPE_BPS_PER_SEC ?? 0;
  const MAX_DROP = guardCfg.MAX_DROP_PCT_WINDOW ?? 1.5;
  const PROBE_SOL = guardCfg.PROBE_SOL ?? Math.min(0.002, tradeAmountSOL / 4);

  const stepMs = Math.max(
    200,
    Math.floor(LOOKBACK_MS / Math.max(2, SAMPLES - 1))
  );
  const prices = [];
  const start = Date.now();
  const probeLamports = Math.max(1, Math.floor(PROBE_SOL * 1e9));

  for (let i = 0; i < SAMPLES; i++) {
    const p = await spotSOLPerToken(mint, probeLamports, tokenDecimals);
    if (p != null) prices.push({ t: Date.now(), p });
    if (i < SAMPLES - 1) await sleep(stepMs);
    if (Date.now() - start > LOOKBACK_MS + 1500) break;
  }

  if (prices.length < 3) return true;

  const slope = slopeBpsPerSec(prices);
  const dropPct = maxDropPctFromRecentMax(prices);
  const ok = slope >= MIN_SLOPE && dropPct <= MAX_DROP;

  const slopeStr =
    slope >= MIN_SLOPE
      ? C.green(`${slope.toFixed(2)}bps/s`)
      : C.red(`${slope.toFixed(2)}bps/s`);
  const dropStr =
    dropPct <= MAX_DROP
      ? C.green(`${dropPct.toFixed(2)}%`)
      : C.red(`${dropPct.toFixed(2)}%`);
  const okStr = ok ? C.green("true") : C.red("false");

  console.log(`🧯 Guard: slope=${slopeStr} | drop=${dropStr} | ok=${okStr}`);
  return ok;
}

module.exports = {
  passesBuyGuards,
};
