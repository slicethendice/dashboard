// app.js
require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const path = require("path");

const { PORT = 5000, MONGO_URI } = process.env;
const app = express();
app.use(express.json());
app.use("/", express.static(path.join(__dirname))); // serve index.html + index.js

// --- Mongoose (inline model, read-only) ---
const { Schema, model } = require("mongoose");
const Trade = model(
  "Trade",
  new Schema(
    {
      ts: Date,
      mint: String,
      side: String,
      qty: String,
      price: Number,
    },
    { collection: "trades", strict: false }
  )
);

// --- summarize helper (entries/exits + KPIs) ---
function summarize(rows) {
  const sells = rows
    .filter((r) => r.side === "SELL")
    .map((r, i) => ({
      cycle: i + 1,
      reason: "sell",
      buySOL: NaN,
      sellSOL: r.price * Number(r.qty || 1),
      netProfit: Number.isFinite(r.pnl) ? r.pnl : 0,
      priceChangePct: NaN,
      timeHeldSec: NaN,
      entrySlope: NaN,
      entrySpread: NaN,
      bankroll: NaN,
    }));
  const trades = sells.length,
    total = sells.reduce((a, b) => a + (b.netProfit || 0), 0);
  const wins = sells.filter((s) => (s.netProfit || 0) > 0).length;
  return {
    sells,
    pollsByCycle: [],
    kpis: {
      trades,
      winPct: trades ? (wins / trades) * 100 : 0,
      total,
      avg: trades ? total / trades : 0,
      p50HoldSec: NaN,
      p90HoldSec: NaN,
    },
  };
}

// --- routes ---
app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.get("/api/trades", async (req, res) => {
  try {
    const q = {};
    if (req.query.mint) q.mint = req.query.mint;
    const limit = Math.min(Number(req.query.limit || 500), 5000);
    const rows = await Trade.find(q).sort({ ts: -1 }).limit(limit).lean();
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get("/api/trades/summary", async (req, res) => {
  try {
    const q = {};
    if (req.query.mint) q.mint = req.query.mint;
    const limit = Math.min(Number(req.query.limit || 500), 5000);
    const rows = await Trade.find(q).sort({ ts: -1 }).limit(limit).lean();
    res.json(summarize(rows));
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// live price (reuse your getQuote.js)
const { getQuote } = require("./getQuote.js"); // keep your file
app.get("/api/price", async (req, res) => {
  try {
    const {
      mint,
      vs = "So11111111111111111111111111111111111111112",
      amount = "1000000",
    } = req.query; // default 1e6 base units
    if (!mint) return res.status(400).json({ error: "mint required" });
    const quote = await getQuote({ inMint: mint, outMint: vs, amount });
    res.json(quote);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// --- boot ---
mongoose
  .connect(MONGO_URI)
  .then(() => {
    app.listen(PORT, () => console.log(`[api] http://localhost:${PORT}`));
  })
  .catch((err) => {
    console.error("[db] error:", err.message);
    process.exit(1);
  });
