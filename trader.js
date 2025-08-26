// engine/trader.js

const { getQuote } = require("../getQuote");
const { store } = require("../store");

const SOL_MINT = "So11111111111111111111111111111111111111112";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ===== Console colors =====
const C = {
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
};

// ===== Format sell stats for logging =====
function fmtSell({
  expectedSellInSOL,
  netProfit,
  timeHeldMs,
  edgeBps,
  impactBps,
  effectiveProfit,
}) {
  const pnl =
    netProfit === 0
      ? C.cyan("0.000000")
      : netProfit > 0
      ? C.green(netProfit.toFixed(6))
      : C.red(netProfit.toFixed(6));
  const ep =
    effectiveProfit === 0
      ? C.cyan("0.000000")
      : effectiveProfit > 0
      ? C.green(effectiveProfit.toFixed(6))
      : C.red(effectiveProfit.toFixed(6));
  return `📊 Sell: expectSOL=${expectedSellInSOL.toFixed(
    9
  )} | net=${pnl} | heldMs=${timeHeldMs} | edge=${Math.round(
    edgeBps
  )}bps | impact=${Math.round(impactBps)}bps | eff=${ep}`;
}

// ===== Execute Trade Loop =====

async function executeTradeCycle({
  tokenMint,
  tokenDecimals,
  tradeAmountSOL,
  BUY_DELAY_MS,
  SELL_DELAY_MS,
  profileConfig,
  logTrade,
}) {
  // ---------- BUY (SOL → token) ----------
  console.log("📡 Getting buy quote…");
  const buyQuote = await getQuote(
    SOL_MINT,
    tokenMint,
    Math.round(tradeAmountSOL * 1e9),
    "buy"
  );

  if (!buyQuote?.outAmount) {
    console.warn(`⚠ No buy route for ${tokenMint}`);
    return { success: false, netProfit: 0 };
  }

  const tokensOut = buyQuote.outAmount / 10 ** tokenDecimals;
  const buyPriceSOL = tradeAmountSOL;

  store.isTrading = true;
  store.lastTradeTime = Date.now();

  logTrade({
    phase: "buy",
    token: tokenMint,
    solIn: buyPriceSOL,
    tokensOut,
  });

  await sleep(BUY_DELAY_MS);

  // ---------- HOLD → SELL ----------
  let sold = false;
  let expectedSellInSOL = 0;
  let netProfit = 0;
  let peakSellSOL = 0;

  while (!sold) {
    const sellAmount = Math.round(tokensOut * 10 ** tokenDecimals);
    const sellQuote = await getQuote(tokenMint, SOL_MINT, sellAmount, "sell");

    if (!sellQuote?.outAmount) {
      await sleep(SELL_DELAY_MS);
      continue;
    }

    expectedSellInSOL = sellQuote.outAmount / 1e9;
    netProfit = expectedSellInSOL - buyPriceSOL;

    const buyPxPerToken = buyPriceSOL / tokensOut;
    const sellPxPerToken = expectedSellInSOL / tokensOut;
    const impactBps =
      Math.abs((sellPxPerToken - buyPxPerToken) / buyPxPerToken) * 1e4;
    const edgeBps = ((expectedSellInSOL - buyPriceSOL) / buyPriceSOL) * 1e4;

    const effectiveProfit =
      netProfit - (profileConfig.FEE_BUFFER_SOL ?? 0.00001);
    const timeHeldMs = Date.now() - store.lastTradeTime;
    if (expectedSellInSOL > peakSellSOL) peakSellSOL = expectedSellInSOL;

    console.log(
      fmtSell({
        expectedSellInSOL,
        netProfit,
        timeHeldMs,
        edgeBps,
        impactBps,
        effectiveProfit,
      })
    );

    logTrade({
      phase: "poll",
      token: tokenMint,
      expectedSellInSOL,
      netProfit,
      effectiveProfit,
      edgeBps: Math.round(edgeBps),
      impactBps: Math.round(impactBps),
      timeHeldMs,
    });

    // Exit Conditions
    if (
      effectiveProfit >= (profileConfig.MIN_PROFIT_SOL ?? 0.00002) &&
      Math.round(edgeBps) >= (profileConfig.TP_BUFFER_BPS ?? 6) &&
      Math.round(impactBps) <= (profileConfig.MAX_PRICE_IMPACT_BPS ?? 40)
    ) {
      sold = true;
    } else if (-netProfit >= (profileConfig.MAX_LOSS_SOL ?? 0.00002)) {
      sold = true;
    } else if (timeHeldMs >= (profileConfig.FORCE_EXIT_MS ?? 180000)) {
      sold = true;
    } else {
      await sleep(SELL_DELAY_MS);
    }
  }

  return {
    success: true,
    netProfit,
    expectedSellInSOL,
    updatedBankroll: tradeAmountSOL + netProfit,
  };
}

module.exports = {
  executeTradeCycle,
};
