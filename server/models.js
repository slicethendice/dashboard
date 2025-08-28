// server/models.js
const mongoose = require("mongoose");
const { Schema } = mongoose;

const TradeSchema = new Schema(
  {
    ts: { type: Date, index: true },
    mint: String,
    wallet: String,
    side: String,
    price: Number,
    qty: String,
    tx: String,
    source: String,
    pnl: Number,
  },
  { collection: "trades", strict: false }
);

const TokenSchema = new Schema(
  {
    mint: { type: String, unique: true },
    symbol: String,
    name: String,
    decimals: Number,
    logoURI: String,
  },
  { collection: "tokens", strict: false }
);

const QuoteSchema = new Schema(
  {
    ts: { type: Date, index: true },
    mint: String,
    price: Number,
  },
  { collection: "quotes", strict: false }
);

const ConfigSchema = new Schema(
  {
    key: { type: String, unique: true },
    value: Schema.Types.Mixed,
  },
  { collection: "config", strict: false }
);

// Guard against OverwriteModelError
const Trade = mongoose.models.Trade || mongoose.model("Trade", TradeSchema);
const Token = mongoose.models.Token || mongoose.model("Token", TokenSchema);
const Quote = mongoose.models.Quote || mongoose.model("Quote", QuoteSchema);
const Config = mongoose.models.Config || mongoose.model("Config", ConfigSchema);

module.exports = { Trade, Token, Quote, Config };
