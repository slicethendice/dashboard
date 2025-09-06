// server/getQuote.js
// Jupiter quote with robust decimal handling + BigInt-safe price computation.
// Always returns price as OUT per 1 IN (e.g., USDC per 1 input token when vs=USDC).

const fetch = require("node-fetch");

// ----- Config for on-chain decimals lookup -----
const HELIUS_API_KEY = process.env.HELIUS_API_KEY || "";
const RPC_URL = HELIUS_API_KEY
  ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`
  : "https://api.mainnet-beta.solana.com";

// Simple in-memory cache for mint decimals
const DECIMALS_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const decimalsCache = new Map(); // mint -> { at, decimals }

async function getMintDecimalsOnChain(mint) {
  const now = Date.now();
  const hit = decimalsCache.get(mint);
  if (hit && now - hit.at < DECIMALS_TTL_MS) return hit.decimals;

  // Prefer getTokenSupply (has .value.decimals)
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "getTokenSupply",
    params: [mint],
  };

  try {
    const r = await fetch(RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`rpc_http_${r.status}`);
    const j = await r.json();
    const dec = j?.result?.value?.decimals;
    if (typeof dec === "number" && Number.isFinite(dec)) {
      decimalsCache.set(mint, { at: now, decimals: dec });
      return dec;
    }
  } catch (_) {
    // fall through to fallback below
  }

  // Fallback default (common SPL default, but only used if RPC fails)
  const fallback = 9;
  decimalsCache.set(mint, { at: now, decimals: fallback });
  return fallback;
}

// ----- Jupiter v6 quote URL -----
function jupQuoteURL({ inMint, outMint, amount }) {
  const params = new URLSearchParams({
    inputMint: inMint,
    outputMint: outMint,
    amount: String(amount), // base units of input
    swapMode: "ExactIn",
    slippageBps: "50",
    onlyDirectRoutes: "true",
  });
  return `https://quote-api.jup.ag/v6/quote?${params}`;
}

// ----- BigInt helpers for exact ratio math -----
const POW10 = Array.from({ length: 40 }, (_, i) => BigInt(10) ** BigInt(i)); // up to 1e39
const pow10n = (n) => (n < POW10.length ? POW10[n] : BigInt(10) ** BigInt(n));

function priceFromAmounts({
  inAmountStr,
  outAmountStr,
  inDec,
  outDec,
  scale = 12,
}) {
  const inAmt = BigInt(inAmountStr);
  const outAmt = BigInt(outAmountStr);
  if (inAmt === 0n) throw new Error("invalid_in_amount_zero");

  // price = (outAmt * 10^(inDec)) / (inAmt * 10^(outDec))
  const num = outAmt * pow10n(inDec + scale);
  const den = inAmt * pow10n(outDec);
  const q = num / den; // integer with `scale` implied decimals

  const s = q.toString().padStart(scale + 1, "0");
  const whole = s.slice(0, -scale);
  const frac = s.slice(-scale).replace(/0+$/, "");
  const str = frac ? `${whole}.${frac}` : whole;

  const asNum = Number(str);
  if (!Number.isFinite(asNum)) throw new Error("price_compute_overflow");
  return asNum;
}

function toNum(n) {
  const x = Number(n);
  return Number.isFinite(x) ? x : undefined;
}

// ----- Main: fetch and normalize a quote -----
async function getQuote({ inMint, outMint, amount }) {
  const url = jupQuoteURL({ inMint, outMint, amount });
  const resp = await fetch(url);

  if (resp.status === 429)
    throw Object.assign(new Error("jup 429"), { code: 429 });
  if (!resp.ok) throw new Error(`jup ${resp.status}`);

  const j = await resp.json();

  // v6 can return { data: [route,...] } or a flat object
  const q = Array.isArray(j?.data) ? j.data[0] : j;
  if (!q) throw new Error("jup 404");

  // Prefer Jupiter-provided price when present
  let price = toNum(q?.price);

  // Pull amounts as strings to preserve precision
  const inAmountStr = String(q?.inAmount ?? q?.inputAmount ?? amount ?? "0");
  const outAmountStr = String(q?.outAmount ?? q?.outputAmount ?? "0");

  // Decimals: use any provided by Jup; if missing, resolve on-chain
  let inDecimals =
    toNum(q?.inputMint?.decimals) ?? toNum(q?.inDecimals) ?? undefined;

  let outDecimals =
    toNum(q?.outputMint?.decimals) ?? toNum(q?.outDecimals) ?? undefined;

  if (!Number.isFinite(inDecimals)) {
    inDecimals = await getMintDecimalsOnChain(inMint);
  }
  if (!Number.isFinite(outDecimals)) {
    outDecimals = await getMintDecimalsOnChain(outMint);
  }

  // If price missing, compute exactly from integers
  if (!Number.isFinite(price)) {
    price = priceFromAmounts({
      inAmountStr,
      outAmountStr,
      inDec: inDecimals,
      outDec: outDecimals,
      scale: 12,
    });
  }

  if (!Number.isFinite(price) || price <= 0) {
    throw new Error("No price in Jupiter quote");
  }

  return {
    // OUT per 1 IN (e.g., USDC per 1 input token when outMint is USDC)
    price,
    inAmount: inAmountStr,
    outAmount: outAmountStr,
    inDecimals,
    outDecimals,
    context: {
      routeType: q?.routePlan ? "routePlan" : "simple",
      timeTaken: q?.timeTaken ?? j?.timeTaken,
    },
  };
}

module.exports = { getQuote };
