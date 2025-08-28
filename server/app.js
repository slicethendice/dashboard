// app.js — Express API server with Helius stream integration

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const crypto = require("crypto");

const { createWalletMintStream } = require("./heliusStream");

const app = express();
const PORT = Number(process.env.PORT || 1234);

// Structured logger
function jlog(level, msg, ctx = {}) {
  const line = { level, msg, ts: new Date().toISOString(), ...ctx };
  console.log(JSON.stringify(line));
}

// req-id
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

// Health
app.get("/api/health", (_req, res) => {
  jlog("info", "[health] hit /api/health");
  res.status(200).json({ ok: true, ts: Date.now() });
});

// --- Stream wiring ---
async function saveEventToDB(_event) {
  // plug in your DB if desired
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

let connectedFlag = false;
let currentPair = { wallet: null, mint: null };

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
  return connectedFlag;
}

function isBase58(s) {
  return typeof s === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
}

const startStream = async (req, res) => {
  const payload =
    (req.body && Object.keys(req.body).length ? req.body : req.query) || {};
  const wallet = payload.wallet || null;
  const mint = payload.mint || null;
  const reqId = req.id;

  // REQUIRE BOTH for your use case
  if (!wallet || !mint) {
    return res
      .status(400)
      .json({ ok: false, error: "Provide BOTH wallet and mint" });
  }
  if (!isBase58(wallet)) {
    return res
      .status(400)
      .json({ ok: false, error: "Invalid wallet (base58 expected)" });
  }
  if (!isBase58(mint)) {
    return res
      .status(400)
      .json({ ok: false, error: "Invalid mint (base58 expected)" });
  }

  try {
    await startStreamImpl({ wallet, mint });
    currentPair = { wallet, mint };
    connectedFlag = true;
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
    connectedFlag = false;
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

app.post("/api/stream/start", startStream);
app.get("/api/stream/start", startStream);

app.post("/api/stream/stop", stopStream);
app.get("/api/stream/stop", stopStream);

app.get("/api/stream/status", (_req, res) => {
  res.json({ ok: true, connected: isStreamConnected(), pair: currentPair });
});

// --- 404 ---
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
