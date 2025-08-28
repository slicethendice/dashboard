// server/getQuote.js
async function getQuote({ inMint, outMint, amount }) {
  const params = new URLSearchParams({
    inputMint: inMint,
    outputMint: outMint,
    amount: String(amount), // base units of input mint
    slippageBps: "50",
    swapMode: "ExactIn",
    onlyDirectRoutes: "true",
  });
  const r = await fetch(`https://quote-api.jup.ag/v6/quote?${params}`);
  if (!r.ok) throw new Error(`jup ${r.status}`);
  const data = await r.json();

  // pick first route or flat shape
  const q = Array.isArray(data?.data) ? data.data[0] : data;
  if (!q) throw new Error("no route");

  // decimals can be on route or top-level; default to 0 if absent
  const inDecimals = q.inputMintDecimals ?? data.inputMintDecimals ?? 0;
  const outDecimals = q.outputMintDecimals ?? data.outputMintDecimals ?? 0;
  const inAmountBN = Number(amount); // given by caller
  const outAmountBN = Number(q.outAmount ?? 0); // from Jupiter

  if (!(inAmountBN > 0) || !(outAmountBN > 0)) throw new Error("bad amounts");

  const inFloat = inAmountBN / 10 ** inDecimals;
  const outFloat = outAmountBN / 10 ** outDecimals;
  const price = outFloat / inFloat; // price in terms of output mint

  return {
    price,
    inAmount: inAmountBN,
    outAmount: outAmountBN,
    inDecimals,
    outDecimals,
  };
}

module.exports = { getQuote };
