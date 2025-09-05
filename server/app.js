require("dotenv").config();

const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const crypto = require("crypto");
const http = require("http");
const mongoose = require("mongoose");
const { Trade } = require("./models"); // uses your central schemas
const { getQuote } = require("./getQuote"); // make sure this exports getQuote

// ===== ENV & App bootstrap =====
const app = express();
const PORT = Number(process.env.PORT || 1234);
const ORIGIN = process.env.ORIGIN || ""; // e.g. https://dashboard.yourdomain.com
const NODE_ENV = process.env.NODE_ENV || "development";
const HELIUS_API_KEY = process.env.HELIUS_API_KEY || "";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// Warn if key missing (health still works; data endpoints will fail)
if (!HELIUS_API_KEY) {
  console.warn(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: "warn",
      msg: "HELIUS_API_KEY not set — data endpoints will be empty/fail",
    })
  );
}

// ===== Logging (JSON) =====
const DEBUG_API = process.env.DEBUG_API === "1"; // per-request logs
const DEBUG_HELIUS = process.env.DEBUG_HELIUS === "1"; // Helius RPC timings

function jlog(level, msg, ctx = {}) {
  try {
    const line = { ts: new Date().toISOString(), level, msg, ...ctx };
    console.log(JSON.stringify(line));
  } catch {
    console.log(`[${level}] ${msg}`);
  }
}

// Per-request logger and X-Request-Id header
app.use((req, res, next) => {
  const id =
    (crypto.randomUUID && crypto.randomUUID()) ||
    Math.random().toString(36).slice(2);
  req.id = id;
  res.setHeader("X-Request-Id", id);

  const started = process.hrtime.bigint();
  if (DEBUG_API) {
    jlog("info", "request", {
      reqId: id,
      method: req.method,
      url: req.originalUrl,
      ip: req.ip,
      ua: req.headers["user-agent"],
    });
  }
  res.on("finish", () => {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    jlog("info", "response", {
      reqId: id,
      method: req.method,
      url: req.originalUrl,
      status: res.statusCode,
      ms: Number(ms.toFixed(1)),
    });
  });
  next();
});

// Strict CORS if ORIGIN provided, else permissive (dev)
app.use(
  cors(
    ORIGIN
      ? {
          origin: ORIGIN.split(",").map((s) => s.trim()),
          credentials: false,
          methods: ["GET", "POST", "OPTIONS"],
          allowedHeaders: ["Content-Type", "X-Request-Id"],
          maxAge: 86400,
        }
      : {}
  )
);

// --- Mongo
if (!process.env.MONGO_URI) {
  jlog("warn", "MONGO_URI not set — /api/trades* will fail");
} else {
  mongoose
    .connect(process.env.MONGO_URI)
    .then(() => jlog("info", "[db] connected"))
    .catch((err) => jlog("error", "[db] connect failed", { err: err.message }));
}

app.disable("x-powered-by");
app.use(express.json({ limit: "512kb" }));

// ===== Helius helpers =====
const HELIUS_REST_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

async function heliusRPC(
  method,
  params,
  { timeoutMs = 8000, retries = 2, reqId = "-" } = {}
) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const started = process.hrtime.bigint();
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(HELIUS_REST_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: controller.signal,
      });
      clearTimeout(t);
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      if (!res.ok) throw new Error(`Helius HTTP ${res.status}`);
      const json = await res.json();
      if (json.error)
        throw new Error(`Helius RPC error: ${JSON.stringify(json.error)}`);
      if (DEBUG_HELIUS)
        jlog("debug", "helius ok", {
          reqId,
          method,
          ms: Number(ms.toFixed(1)),
          size: json?.result?.length,
        });
      return json.result;
    } catch (e) {
      clearTimeout(t);
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      lastErr = e;
      jlog("warn", "helius failed", {
        reqId,
        method,
        attempt: `${attempt + 1}/${retries + 1}`,
        ms: Number(ms.toFixed(1)),
        err: e.message || String(e),
      });
      await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
    }
  }
  throw lastErr || new Error("Helius RPC failed");
}

function rangeStartTs(range = "all") {
  const now = Date.now();
  const D = 24 * 60 * 60 * 1000;
  switch (String(range)) {
    case "day":
      return now - D;
    case "week":
      return now - 7 * D;
    case "month":
      return now - 30 * D;
    case "year":
      return now - 365 * D;
    case "all":
    default:
      return 0;
  }
}

// Page through signatures, stop when older than startTs
async function listSignaturesForAddress(
  address,
  {
    startTs = 0,
    endTs = Date.now(),
    pageLimit = 1000,
    hardLimit = 5000,
    reqId = "-",
  } = {}
) {
  const out = [];
  let before;
  while (out.length < hardLimit) {
    const page = await heliusRPC(
      "getSignaturesForAddress",
      [address, { limit: pageLimit, before }],
      { reqId }
    );
    if (!Array.isArray(page) || page.length === 0) break;

    for (const sig of page) {
      const ts = (sig.blockTime || 0) * 1000;
      if (ts && ts < startTs) return out;
      if (!ts || ts <= endTs) out.push(sig);
    }
    before = page[page.length - 1]?.signature;
    if (!before) break;
  }
  return out;
}

// Keep signature blockTime fallback to avoid empty charts when tx.blockTime is null
async function fetchWindowedTransactions({
  wallet,
  startTs = 0,
  endTs = Date.now(),
  detailConcurrency = 4,
  reqId = "-",
}) {
  const sigs = await listSignaturesForAddress(wallet, {
    startTs,
    endTs,
    pageLimit: 1000,
    hardLimit: 4000,
    reqId,
  });
  const sigList = sigs.map((s) => ({
    signature: s.signature,
    sigMs: s.blockTime ? s.blockTime * 1000 : null,
  }));
  const out = [];
  let i = 0;
  async function worker() {
    while (i < sigList.length) {
      const { signature, sigMs } = sigList[i++];
      try {
        const tx = await heliusRPC(
          "getTransaction",
          [
            signature,
            { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
          ],
          { reqId }
        );
        if (tx && tx.meta) out.push({ tx, sigMs });
      } catch (e) {
        jlog("warn", "getTransaction failed", {
          reqId,
          sig: signature,
          err: e.message || String(e),
        });
      }
    }
  }
  await Promise.all(Array.from({ length: detailConcurrency }, () => worker()));
  return out; // [{ tx, sigMs }]
}

// ===== (Optional) ATA resolution cache for accurate mint filtering =====
const ataCache = new Map(); // key: `${wallet}|${mint}` -> { at: ms, pubkeys: Set<string> }
const ATA_TTL_MS = 10 * 60 * 1000;

async function getWalletMintATAs(wallet, mint, { reqId = "-" } = {}) {
  const key = `${wallet}|${mint}`;
  const now = Date.now();
  const hit = ataCache.get(key);
  if (hit && now - hit.at < ATA_TTL_MS) return hit.pubkeys;

  const result = await heliusRPC(
    "getTokenAccountsByOwner",
    [wallet, { mint }, { encoding: "jsonParsed" }],
    { reqId }
  );

  const pubkeys = new Set(
    Array.isArray(result) ? result.map((r) => r?.pubkey).filter(Boolean) : []
  );
  ataCache.set(key, { at: now, pubkeys });
  return pubkeys;
}

// Flag transactions that touch a mint for a wallet or that wallet’s ATA(s)
function extractTrades({ transactions, wallet, mint, ataSet }) {
  const out = [];
  for (const tx of transactions) {
    const pre = tx.meta?.preTokenBalances || [];
    const post = tx.meta?.postTokenBalances || [];
    const all = pre.concat(post);
    const keys = (tx.transaction?.message?.accountKeys || []).map((k) =>
      typeof k === "string" ? k : k?.pubkey
    );

    let hit = false;
    for (const b of all) {
      if (b.mint !== mint) continue;
      // Prefer explicit owner, else map accountIndex
      const owner =
        b.owner ||
        (typeof b.accountIndex === "number" ? keys[b.accountIndex] : null);
      if (owner === wallet) {
        hit = true;
        break;
      }
      // Also accept direct hits on resolved ATA pubkeys (owner may not be present in some nodes)
      const acctPubkey =
        typeof b.accountIndex === "number" && b.accountIndex >= 0
          ? keys[b.accountIndex]
          : null;
      if (acctPubkey && ataSet && ataSet.has(acctPubkey)) {
        hit = true;
        break;
      }
    }
    if (hit)
      out.push({
        signature: tx.transaction.signatures?.[0],
        slot: tx.slot,
        ts: (tx.blockTime || 0) * 1000,
      });
  }
  return out;
}

// ===== Stream wiring (reuses your ./heliusStream.js) =====
const { createWalletMintStream } = require("./heliusStream");

async function saveEventToDB(event) {
  // TODO: plug in your DB write (Mongo/PG/etc)
  // await db.collection("wallet_mint_events").insertOne(event);
}

const stream = createWalletMintStream({
  heliusApiKey: HELIUS_API_KEY,
  onEvent: (e) =>
    saveEventToDB(e).catch((err) =>
      jlog("error", "[stream] saveEventToDB failed", {
        err: err.message || String(err),
      })
    ),
  onLog: ({ level, msg, context }) =>
    jlog(`stream:${level}`, msg, context || {}),
  // knobs are tunable here if needed
  // commitment: "finalized",
  // backfillLimit: 15,
  // maxDetailConcurrency: 2,
});

let currentPair = { wallet: null, mint: null };

// ===== /api router (mount BEFORE any static/catch-all) =====
const api = express.Router();

// Health & routes
api.get("/health", (_req, res) =>
  res.json({ ok: true, ts: Date.now(), env: NODE_ENV })
);
api.get("/_routes", (_req, res) => {
  try {
    const rows = [];
    api.stack.forEach((layer) => {
      if (layer.route) {
        const methods = Object.keys(layer.route.methods).map((m) =>
          m.toUpperCase()
        );
        methods.forEach((m) =>
          rows.push({ method: m, path: `/api${layer.route.path}` })
        );
      }
    });
    res.json({ ok: true, routes: rows });
  } catch (e) {
    res.json({ ok: false, error: e.message || String(e) });
  }
});

// Stream controls
api.post("/stream/start", async (req, res) => {
  const { wallet, mint } = req.body || {};
  if (!wallet || !mint)
    return res
      .status(400)
      .json({ ok: false, error: "'wallet' and 'mint' are required" });
  try {
    const same = currentPair.wallet === wallet && currentPair.mint === mint;
    if (same && stream.isConnected())
      return res.json({ ok: true, status: "connected", wallet, mint });

    if (currentPair.wallet && currentPair.mint)
      await stream.setPair({ wallet, mint });
    else await stream.start({ wallet, mint });

    currentPair = { wallet, mint };
    res.json({ ok: true, status: "connected", wallet, mint });
  } catch (e) {
    jlog("error", "/api/stream/start failed", { err: e.message || String(e) });
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

api.post("/stream/stop", async (_req, res) => {
  try {
    stream.stop();
    const prev = currentPair;
    currentPair = { wallet: null, mint: null };
    jlog("info", "/api/stream/stop ok", { prev });
    res.json({ ok: true, status: "stopped", prev });
  } catch (e) {
    jlog("error", "/api/stream/stop failed", { err: e.message || String(e) });
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

api.get("/stream/status", (_req, res) => {
  res.json({ ok: true, connected: stream.isConnected(), pair: currentPair });
});

// /api/review — counts only (until you wire PnL)
api.get("/review", async (req, res) => {
  const reqId = req.id;
  try {
    const { mint, wallet, range = "all" } = req.query;
    if (!wallet || !mint)
      return res.json({ trades: 0, winPct: 0, totalPnl: 0, avgPnl: 0 });

    const startTs = rangeStartTs(range);
    const endTs = Date.now();

    const txs = await fetchWindowedTransactions({
      wallet,
      startTs,
      endTs,
      reqId,
    });
    const ataSet = await getWalletMintATAs(wallet, mint, { reqId }); // resolve ATAs
    const trades = extractTrades({
      transactions: txs.map((t) => t.tx),
      wallet,
      mint,
      ataSet,
    });

    res.json({ trades: trades.length, winPct: 0, totalPnl: 0, avgPnl: 0 });
  } catch (e) {
    jlog("error", "/api/review failed", { reqId, err: e.message || String(e) });
    res.status(500).json({ error: String(e.message || e) });
  }
});

// /api/ohlc — pseudo-OHLC: hourly counts of wallet (optionally minted-filtered)
api.get("/ohlc", async (req, res) => {
  const reqId = req.id;
  try {
    const { wallet, mint, range = "week" } = req.query;
    if (!wallet) return res.json({ candles: [], granularity: "1h" });

    const startTs = rangeStartTs(range);
    const endTs = Date.now();
    const txs = await fetchWindowedTransactions({
      wallet,
      startTs,
      endTs,
      reqId,
    });

    let events = txs
      .map(({ tx, sigMs }) => {
        const ms = tx.blockTime ? tx.blockTime * 1000 : sigMs; // fallback on signature time
        return ms ? { ts: ms, tx } : null;
      })
      .filter(Boolean);

    if (mint) {
      const ataSet = await getWalletMintATAs(wallet, mint, { reqId });
      const signatures = new Set(
        extractTrades({
          transactions: txs.map((t) => t.tx),
          wallet,
          mint,
          ataSet,
        }).map((t) => t.signature)
      );
      events = events.filter((e) =>
        signatures.has(e.tx.transaction.signatures?.[0])
      );
    }

    // Bucket per hour → o=h=l=c=count, v=count (placeholder for charting)
    const buckets = new Map();
    for (const e of events) {
      const hour = Math.floor(e.ts / (60 * 60 * 1000)) * (60 * 60 * 1000);
      buckets.set(hour, (buckets.get(hour) || 0) + 1);
    }
    const times = Array.from(buckets.keys()).sort((a, b) => a - b);
    const candles = times.map((t) => {
      const v = buckets.get(t) || 0;
      return { t, o: v, h: v, l: v, c: v, v };
    });

    jlog("info", "ohlc buckets", {
      reqId,
      buckets: candles.length,
      events: events.length,
    });
    res.json({ candles, granularity: "1h" });
  } catch (e) {
    jlog("error", "/api/ohlc failed", { reqId, err: e.message || String(e) });
    res.status(500).json({ error: String(e.message || e) });
  }
});

// /api/wallet/summary — list mints this wallet touched in the window
api.get("/wallet/summary", async (req, res) => {
  const reqId = req.id;
  try {
    const { wallet, range = "month" } = req.query;
    if (!wallet)
      return res.status(400).json({ ok: false, error: "'wallet' is required" });

    const startTs = rangeStartTs(range);
    const txs = await fetchWindowedTransactions({
      wallet,
      startTs,
      endTs: Date.now(),
      reqId,
    });

    const counts = new Map();
    for (const { tx } of txs) {
      const pre = tx.meta?.preTokenBalances || [];
      const post = tx.meta?.postTokenBalances || [];
      const all = pre.concat(post);
      const keys = (tx.transaction?.message?.accountKeys || []).map((k) =>
        typeof k === "string" ? k : k?.pubkey
      );

      const touched = new Set();
      for (const b of all) {
        const mint = b.mint;
        if (!mint) continue;
        const owner =
          b.owner ||
          (typeof b.accountIndex === "number" ? keys[b.accountIndex] : null);
        if (owner === wallet) touched.add(mint);
      }
      for (const m of touched) counts.set(m, (counts.get(m) || 0) + 1);
    }

    const mints = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([mint, count]) => ({ mint, count }));

    res.json({ ok: true, wallet, range, totalTx: txs.length, mints });
  } catch (e) {
    jlog("error", "/api/wallet/summary failed", {
      reqId,
      err: e.message || String(e),
    });
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// /api/price — live quote (price of `mint` in USDC by default)
api.get("/price", async (req, res) => {
  try {
    const mint = req.query.mint;
    const vs = req.query.vs || USDC;
    const amount = String(req.query.amount || "1000000"); // base units of mint
    if (!mint) return res.status(400).json({ error: "mint required" });

    // getQuote should accept { inMint, outMint, amount } and return a shape with price
    const q = await getQuote({ inMint: mint, outMint: vs, amount });

    let price = Number(q?.price);
    if (
      !Number.isFinite(price) &&
      q?.outAmount &&
      q?.outDecimals != null &&
      q?.inDecimals != null
    ) {
      const out = Number(q.outAmount) / 10 ** Number(q.outDecimals);
      const inn = Number(amount) / 10 ** Number(q.inDecimals);
      price = out / inn;
    }

    if (!Number.isFinite(price))
      return res.status(502).json({ error: "bad quote shape", q });

    res.json({ ts: Date.now(), mint, vs, price });
  } catch (e) {
    jlog("error", "/api/price failed", { err: e.message || String(e) });
    res.status(500).json({ error: String(e.message || e) });
  }
});

// helper to build time filter
function buildQuery(req) {
  const q = {};
  if (req.query.mint) q.mint = req.query.mint;
  if (req.query.from || req.query.to) {
    q.ts = {};
    if (req.query.from) q.ts.$gte = new Date(req.query.from);
    if (req.query.to) q.ts.$lte = new Date(req.query.to);
  }
  return q;
}

// GET /api/trades
api.get("/trades", async (req, res) => {
  try {
    const q = buildQuery(req);
    const limit = Math.min(Number(req.query.limit || 500), 5000);
    const rows = await Trade.find(q).sort({ ts: -1 }).limit(limit).lean();
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// GET /api/trades/summary
api.get("/trades/summary", async (req, res) => {
  try {
    const q = buildQuery(req);
    const limit = Math.min(Number(req.query.limit || 500), 5000);
    const rows = await Trade.find(q).sort({ ts: -1 }).limit(limit).lean();

    const sells = rows.filter((r) => r.side === "SELL");
    const pnl = sells.map((s) => Number(s.pnl) || 0);
    const total = pnl.reduce((a, b) => a + b, 0);
    const trades = sells.length;
    const wins = pnl.filter((v) => v > 0).length;

    res.json({
      sells,
      pollsByCycle: [],
      kpis: {
        trades,
        winPct: trades ? (wins / trades) * 100 : 0,
        total,
        avg: trades ? total / trades : 0,
      },
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Mount router early (before any static/catch-all)
app.use("/api", api);

// Final 404 JSON
app.use((req, res) => {
  jlog("warn", "404", { method: req.method, path: req.originalUrl });
  res.status(404).json({ ok: false, status: 404, path: req.originalUrl });
});

// Server & graceful shutdown
const server = http.createServer(app);
server.keepAliveTimeout = 75_000; // AWS ALB default friendliness
server.headersTimeout = 79_000;

server.listen(PORT, () =>
  jlog("info", `API server listening on http://localhost:${PORT}`)
);

function shutdown(signal) {
  jlog("info", `received ${signal}, shutting down`);
  try {
    stream.stop?.();
  } catch {}
  server.close((err) => {
    if (err) {
      jlog("error", "server close error", { err: err.message || String(err) });
      process.exit(1);
    }
    process.exit(0);
  });
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
