// engine/signalEngine.js

const { PublicKey } = require("@solana/web3.js");
const { getQuote } = require("../getQuote");
const { Connection } = require("@solana/web3.js");

const RPC_URL = process.env.RPC_URL;
const connection = new Connection(RPC_URL, "confirmed");

const SOL_MINT = "So11111111111111111111111111111111111111112";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ===== Colored Console Output =====
const C = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
};

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

// ===== Price Helpers =====

async function spotSOLPerToken(mint, probeSolLamports, tokenDecimals) {
  const q = await getQuote(SOL_MINT, mint, probeSolLamports);
  if (!q?.outAmount) return null;
  const tokens = q.outAmount / 10 ** tokenDecimals;
  if (tokens <= 0) return null;
  const solIn = probeSolLamports / 1e9;
  return solIn / tokens;
}

async function approxSpreadBps(mint, probeSolLamports, tokenDecimals) {
  const q1 = await getQuote(SOL_MINT, mint, probeSolLamports);
  if (!q1?.outAmount) return null;

  const tokenBase = q1.outAmount;
  const q2 = await getQuote(mint, SOL_MINT, tokenBase);
  if (!q2?.outAmount) return null;

  const solIn = probeSolLamports / 1e9;
  const solOut = q2.outAmount / 1e9;
  const loss = (solIn - solOut) / solIn;
  return Math.max(0, loss * 10000);
}

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

function sma(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function maxDropPctFromRecentMax(series) {
  if (!series.length) return 0;
  let m = -Infinity;
  const curr = series[series.length - 1].p;
  for (const x of series) m = Math.max(m, x.p);
  return m > 0 ? ((m - curr) / m) * 100 : 0;
}

// ===== Entry Signal Engine =====

async function waitForEntrySignal(
  mint,
  tradeAmountSOL,
  tokenDecimals,
  cfg = {}
) {
  const MAX_WAIT_MS = cfg.MAX_WAIT_MS ?? 180000;
  const SAMPLE_MS = cfg.SAMPLE_MS ?? 1000;
  const WINDOW_SAMPLES = cfg.WINDOW_SAMPLES ?? 20;
  const MIN_UP_SLOPE = cfg.MIN_UP_SLOPE_BPS_SEC ?? 3;
  const MIN_ABOVE_SMA_BPS = cfg.MIN_ABOVE_SMA_BPS ?? 5;
  const MIN_BREAKOUT_PCT = cfg.MIN_BREAKOUT_PCT ?? 0.3;
  const MAX_DROP_PCT = cfg.MAX_DROP_PCT_WINDOW ?? 1.5;
  const MAX_SPREAD_BPS = cfg.MAX_SPREAD_BPS ?? 60;
  const MAX_IMPACT_BPS = cfg.MAX_IMPACT_BPS ?? 40;
  const OK_ROUTE_STREAK = cfg.OK_ROUTE_STREAK ?? 2;
  const PROBE_SOL = cfg.PROBE_SOL ?? 0.002;

  const buf = new Ring(WINDOW_SAMPLES);
  const probeLamports = Math.max(1, Math.floor(PROBE_SOL * 1e9));
  const start = Date.now();
  let okStreak = 0;

  while (Date.now() - start < MAX_WAIT_MS) {
    const spread = await approxSpreadBps(mint, probeLamports, tokenDecimals);
    const routeOK = spread != null;
    okStreak = routeOK ? okStreak + 1 : 0;
    if (!routeOK || okStreak < OK_ROUTE_STREAK) {
      await sleep(SAMPLE_MS);
      continue;
    }
    if (spread > MAX_SPREAD_BPS) {
      await sleep(SAMPLE_MS);
      continue;
    }

    const p = await spotSOLPerToken(mint, probeLamports, tokenDecimals);
    if (p != null) buf.push({ t: Date.now(), p });

    if (buf.length >= Math.max(4, Math.floor(WINDOW_SAMPLES / 2))) {
      const slope = slopeBpsPerSec(buf.values);
      const prices = buf.values.map((x) => x.p);
      const smaVal = sma(prices);
      const curr = prices[prices.length - 1];
      const aboveSmaBps = smaVal > 0 ? ((curr - smaVal) / smaVal) * 10000 : 0;
      const maxP = Math.max(...prices);
      const breakoutPct = maxP > 0 ? ((curr - maxP) / maxP) * 100 : 0;
      const dropPct = maxDropPctFromRecentMax(buf.values);

      const slopeOK = slope >= MIN_UP_SLOPE;
      const aboveSmaOK = aboveSmaBps >= MIN_ABOVE_SMA_BPS;
      const breakoutOK = breakoutPct >= MIN_BREAKOUT_PCT;
      const notSliding = dropPct <= MAX_DROP_PCT;

      const ok = (slopeOK && aboveSmaOK && notSliding) || breakoutOK;

      const slopeStr = slopeOK
        ? C.green(`${slope.toFixed(2)}bps/s`)
        : C.red(`${slope.toFixed(2)}bps/s`);
      const smaStr = aboveSmaOK
        ? C.green(`${aboveSmaBps.toFixed(1)}bps`)
        : C.red(`${aboveSmaBps.toFixed(1)}bps`);
      const breakoutStr = breakoutOK
        ? C.green(`${breakoutPct.toFixed(2)}%`)
        : C.red(`${breakoutPct.toFixed(2)}%`);
      const dropStr = notSliding
        ? C.green(`${dropPct.toFixed(2)}%`)
        : C.red(`${dropPct.toFixed(2)}%`);
      const spreadStr =
        spread <= MAX_SPREAD_BPS
          ? C.green(`${Math.round(spread)}bps`)
          : C.red(`${Math.round(spread)}bps`);
      const okStr = ok ? C.green("true") : C.red("false");

      console.log(
        `⏱️ EntryWatch: slope=${slopeStr} | +SMA=${smaStr} | breakout=${breakoutStr} | drop=${dropStr} | spread=${spreadStr} | ok=${okStr}`
      );

      if (ok) return true;
    }

    await sleep(SAMPLE_MS);
  }

  console.warn("⌛ Entry wait expired — no signal.");
  return false;
}

module.exports = {
  waitForEntrySignal,
};
