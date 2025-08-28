// app.js — Express API server with Helius stream integration + DIAGNOSTIC LOGGING
// - Control routes: /api/stream/start, /api/stream/stop, /api/stream/status
// - Analytics routes: /api/review, /api/ohlc
// - Health: /api/health
// - Verbose, structured logs

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const crypto = require("crypto");

const { createWalletMintStream } = require("./heliusStream");

const app = express();
const PORT = Number(process.env.PORT || 1234);

// Simple structured logger
function jlog(level, msg, ctx = {}) {
  const line = { level, msg, ts: new Date().toISOString(), ...ctx };
  console.log(JSON.stringify(line));
}

// Attach a req-id to every request
app.use((req, _res, next) => {
  req.id = crypto.randomBytes(4).toString("hex");
  jlog("info", "request", {
    reqId: req.id,
    method: req.method,
    url: req.originalUrl,
    ip: req.ip,
    ua: req.headers["user-agent"],
  });
  next();
});

app.use(cors());
app.use(express.json({ limit: "512kb" }));

// --- Health (under /api) ---
app.get("/api/health", (_req, res) => {
  jlog("info", "[health] hit /api/health");
  res.status(200).json({ ok: true, ts: Date.now() });
});

// --- Helius stream wiring (no hardcoded wallet/mint) ---
async function saveEventToDB(event) {
  // TODO: replace with your DB write (Mongo/PG/etc)
  // await db.collection("wallet_mint_events").insertOne(event);
}

const stream = createWalletMintStream({
  heliusApiKey: process.env.HELIUS_API_KEY,
  onEvent: (e) =>
    saveEventToDB(e).catch((err) =>
      jlog("error", "[stream] saveEventToDB failed", {
        err: err.message || String(err),
      })
    ),
  onLog: ({ level, msg, context }) =>
    jlog(`stream:${level}`, msg, context || {}),
});

// Track connection state locally to make /status reliable even if the stream impl lacks it
let connectedFlag = false;

// Helper: start/stop adapter (supports connect/disconnect OR start/stop)
async function startStreamImpl(args) {
  if (typeof stream.connect === "function") return stream.connect(args);
  if (typeof stream.start === "function") return stream.start(args);
  throw new Error("No start/connect method on stream");
}
async function stopStreamImpl() {
  if (typeof stream.disconnect === "function") return stream.disconnect();
  if (typeof stream.stop === "function") return stream.stop();
  throw new Error("No stop/disconnect method on stream");
}
function isStreamConnected() {
  if (typeof stream.isConnected === "function") return !!stream.isConnected();
  if ("connected" in stream) return !!stream.connected;
  return connectedFlag; // fall back to our local flag
}

// Helpers
function isBase58(s) {
  return typeof s === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,48}$/.test(s);
}

// Canonical handlers
const startStream = async (req, res) => {
  const { wallet, mint } =
    (req.body && Object.keys(req.body).length ? req.body : req.query) || {};
  const reqId = req.id;

  if (!wallet && !mint) {
    return res
      .status(400)
      .json({ ok: false, error: "Provide wallet and/or mint" });
  }

  // Basic base58 validation to avoid obvious bad inputs
  if (wallet && !isBase58(wallet)) {
    return res
      .status(400)
      .json({ ok: false, error: "Invalid wallet (base58 expected)" });
  }
  if (mint && !isBase58(mint)) {
    return res
      .status(400)
      .json({ ok: false, error: "Invalid mint (base58 expected)" });
  }

  try {
    await startStreamImpl({ wallet, mint });
    currentPair = { wallet: wallet || null, mint: mint || null };
    connectedFlag = true; // mark connected
    jlog("info", "/api/stream/start connected", { reqId, wallet, mint });
    res.json({ ok: true, status: "connected", wallet, mint });
  } catch (e) {
    jlog("error", "/api/stream/start failed", {
      reqId,
      err: e.message || String(e),
    });
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};

const stopStream = async (req, res) => {
  const reqId = req.id;
  try {
    await stopStreamImpl();
    const prev = currentPair;
    currentPair = { wallet: null, mint: null };
    connectedFlag = false; // mark disconnected
    jlog("info", "/api/stream/stop ok", { reqId, prev });
    res.json({ ok: true, status: "stopped", prev });
  } catch (e) {
    jlog("error", "/api/stream/stop failed", {
      reqId,
      err: e.message || String(e),
    });
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};

// --- Stream routes (POST canonical; GET alias for quick testing) ---
app.post("/api/stream/start", startStream);
app.get("/api/stream/start", startStream); // optional GET alias

app.post("/api/stream/stop", stopStream);
app.get("/api/stream/stop", stopStream); // optional GET alias

app.get("/api/stream/status", (_req, res) => {
  res.json({ ok: true, connected: isStreamConnected(), pair: currentPair });
});

// --- Helius RPC helper with timings + retries + logging ---
const HELIUS_REST_URL = `https://mainnet.helius-rpc.com/?api-key=${
  process.env.HELIUS_API_KEY || ""
}`;

async function heliusRPC(
  method,
  params,
  { timeoutMs = 8000, retries = 2, reqId = "-" } = {}
) {
  const t0 = Date.now();
  let lastErr = null;
  for (let i = 0; i <= retries; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(HELIUS_REST_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok)
        throw new Error(`HTTP ${res.status} ${res.statusText}: ${text}`);
      const json = JSON.parse(text);
      if (json.error)
        throw new Error(`${json.error.code} ${json.error.message}`);
      const dt = Date.now() - t0;
      jlog("info", "heliusRPC ok", { reqId, method, dt });
      return json.result;
    } catch (e) {
      lastErr = e;
      const dt = Date.now() - t0;
      jlog("warn", "heliusRPC retry", {
        reqId,
        method,
        attempt: i,
        err: e.message || String(e),
        dt,
      });
      await new Promise((r) => setTimeout(r, 250 * (i + 1)));
    }
  }
  throw lastErr || new Error("Unknown heliusRPC error");
}

// ... (rest of your existing analytics/review/ohlc/route-listing code is unchanged)

// Keep whatever you already had here; omitted for brevity in this snippet.
// (Your /api/review, /api/ohlc, /api/_routes, 404 handler, and app.listen are unchanged.)

// NOTE: these variables were referenced above; keep them where they originally were.
let currentPair = { wallet: null, mint: null };

// --- Catch-all 404 handler ---
app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: "Not Found",
    method: req.method,
    path: req.originalUrl,
  });
});

// --- Start server ---
app.listen(PORT, () => {
  jlog("info", `API server listening on http://localhost:${PORT}`);
});
