// review.js
require("dotenv").config();
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));
const { Connection, PublicKey } = require("@solana/web3.js");

const BIRDEYE_TOKEN_DATA_URL =
  "https://public-api.birdeye.so/defi/v3/token/market-data?address=";

const connection = new Connection(process.env.RPC_URL);

const mintAddress = process.argv[2];
if (!mintAddress) {
  console.error("❌ Please provide a mint address.");
  process.exit(1);
}

function formatNumber(num) {
  if (typeof num !== "number") return "0.00";
  return Number(num).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

const short = (s) =>
  s && s.length > 8 ? s.slice(0, 4) + "..." + s.slice(-4) : s ?? "Unknown";

async function getBirdeyeData(mint) {
  const res = await fetch(`${BIRDEYE_TOKEN_DATA_URL}${mint}`, {
    headers: {
      "x-api-key": process.env.BIRDEYE_API_KEY,
      "x-chain": "solana",
    },
  });
  if (!res.ok) return null;
  const json = await res.json();
  return json.data;
}

async function getMintMetadata(mint) {
  try {
    const info = await connection.getParsedAccountInfo(new PublicKey(mint));
    const data = info.value?.data?.parsed?.info;
    return {
      mintAuthority: short(data?.mintAuthority ?? "?"),
      freezeAuthority: short(data?.freezeAuthority ?? "?"),
      supply: data?.supply ?? "Unknown",
    };
  } catch {
    return {
      mintAuthority: "?",
      freezeAuthority: "?",
      supply: "Unknown",
    };
  }
}

function toUSD(value) {
  return value
    ? value.toLocaleString("en-US", { style: "currency", currency: "USD" })
    : "0.00";
}

(async () => {
  console.log("🧠 Token Review Summary");

  const birdeyeRaw = await getBirdeyeData(mintAddress);
  const birdeye = {
    liquidity: birdeyeRaw?.liquidity || 0,
    market_cap: birdeyeRaw?.market_cap || 0,
    v24hUSD: birdeyeRaw?.volume_24h || 0,
    name: birdeyeRaw?.name ?? "Unknown",
    dex: birdeyeRaw?.route ?? "Unknown",
    is_verified: birdeyeRaw?.is_verified ?? false,
  };

  console.log(birdeye); // Use this once to inspect full shape

  const mintMeta = await getMintMetadata(mintAddress);
  const name = birdeye?.name ?? "Unknown";
  const route = birdeye?.dex ?? "Unknown";
  const trusted = birdeye?.is_verified ? "✅ Yes" : "❌ No";
  const liquidity = formatNumber(birdeye.liquidity);
  const volume = toUSD(birdeye?.v24hUSD); // ✅ Matches how find.js works
  const mcap = formatNumber(birdeye.market_cap);
  const supply = mintMeta.supply;
  const mintAuth = mintMeta.mintAuthority;
  const freezeAuth = mintMeta.freezeAuthority;

  console.table({
    Name: name,
    Mint: short(mintAddress),
    Route: route,
    "Trusted?": trusted,
    "Liquidity ($)": liquidity,
    "24h Volume ($)": volume,
    "Market Cap ($)": mcap,
    "Token Supply": supply,
    "Mint Authority": mintAuth,
    "Freeze Authority": freezeAuth,
  });

  console.log("\n🔗 Useful Links:");
  console.log(
    `  • DEX Screener Chart: https://dexscreener.com/solana/${mintAddress}`
  );
  console.log(
    `  • Solscan Overview:   https://solscan.io/token/${mintAddress}?cluster=mainnet`
  );
  console.log(
    `  • SolanaFM Details:  https://solana.fm/address/${mintAddress}?cluster=mainnet-qn1`
  );
})();
