// swap.js

require("dotenv").config();
const bs58 = require("bs58");
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));
const {
  Connection,
  Keypair,
  VersionedTransaction,
} = require("@solana/web3.js");

// === CONFIG ===
const RPC_URL = process.env.RPC_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const connection = new Connection(RPC_URL, "confirmed");
const wallet = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));

// === HARDCODED TARGET ===
const OUTPUT_TOKEN = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // USDC
const AMOUNT_SOL = 0.01;
const SLIPPAGE_BPS = 500; // 5%

// === STEP 1: Get Quote ===
async function getQuote(inputMint, outputMint, amount) {
  const url = `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${SLIPPAGE_BPS}`;
  const res = await fetch(url);

  if (!res.ok) {
    console.error(`❌ HTTP ${res.status}: ${res.statusText}`);
    const errText = await res.text();
    console.error("Response body:", errText);
    return null;
  }

  const json = await res.json();

  if (!json.routePlan || json.routePlan.length === 0) {
    console.error("❌ No route in response:");
    console.dir(json, { depth: null });
    return null;
  }

  return json;
}

// === STEP 2: Get Swap Transaction ===
async function getSwapTransaction(route) {
  const res = await fetch("https://quote-api.jup.ag/v6/swap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse: route, // ✅ the actual fix
      userPublicKey: wallet.publicKey.toBase58(),
      wrapUnwrapSOL: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 10000,
    }),
  });

  if (!res.ok) {
    console.error(`❌ Swap API returned ${res.status} ${res.statusText}`);
    const body = await res.text();
    console.error("Response body:", body);
    return null;
  }

  const json = await res.json();
  if (!json.swapTransaction) {
    console.error("❌ Missing swapTransaction in response:");
    console.dir(json, { depth: null });
    return null;
  }

  return json.swapTransaction;
}

// === MAIN ===
(async () => {
  const inputMint = "So11111111111111111111111111111111111111112"; // wSOL
  const outputMint = OUTPUT_TOKEN;
  const amount = AMOUNT_SOL * 1e9; // lamports

  console.log("📡 Getting quote...");
  const quote = await getQuote(inputMint, outputMint, amount);
  if (!quote) return console.error("❌ No route found");

  console.log("✅ Quote found:", {
    in: quote.inAmount / 1e9,
    out: quote.outAmount / 1e9,
    route: quote.routePlan[0]?.swapInfo?.label,
  });

  console.log("🧱 Building transaction...");
  const swapTxB64 = await getSwapTransaction(quote);
  if (!swapTxB64) return console.error("❌ Failed to get swap tx");

  const txBuffer = Buffer.from(swapTxB64, "base64");
  const tx = VersionedTransaction.deserialize(txBuffer);

  console.log("🔐 Transaction ready to sign (but not sending):");
  console.log("Instructions:", tx.message.compiledInstructions.length);
  console.log("Recent blockhash:", tx.message.recentBlockhash);
  console.log("Fee payer:", tx.message.staticAccountKeys[0].toBase58());

  // === SIGN & SUBMIT ===
  const { sendAndConfirmRawTransaction } = require("@solana/web3.js");

  try {
    tx.sign([wallet]);
    const sig = await sendAndConfirmRawTransaction(connection, tx.serialize());
    console.log("✅ Swap submitted! Signature:", sig);
    console.log(`🔗 View: https://solana.fm/tx/${sig}`);
  } catch (err) {
    console.error("❌ Failed to send transaction:", err.message || err);
  }
})();
