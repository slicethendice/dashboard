// store.js
export const store = {
  isTrading: false,
  currentToken: null, // { mint, symbol, etc. }
  lastQuote: null, // current quote from getQuote()
  buyPrice: null, // quote when token was bought
  sellPrice: null, // final quote when selling (optional)
  lastTradeTime: null, // timestamp of last buy/sell
  quoteHistory: [], // track quote trend if needed
  tradeStatus: "IDLE", // IDLE, BOUGHT, WAITING_TO_SELL, SOLD, ERROR
  pnlEstimate: null, // profit/loss estimate %
  tradeCount: 0, // # of trades made in session

  // Reset store when starting new token
  reset() {
    this.isTrading = false;
    this.currentToken = null;
    this.lastQuote = null;
    this.buyPrice = null;
    this.sellPrice = null;
    this.lastTradeTime = null;
    this.quoteHistory = [];
    this.tradeStatus = "IDLE";
    this.pnlEstimate = null;
    this.tradeCount = 0;
  },
};
