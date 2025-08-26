const axios = require("axios");
const { Connection } = require("@solana/web3.js");
require("dotenv").config();

// --- ENV + Constants ---
const API_KEY = "8aed6e177c90437e94478b71c91db85d";
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const RPC_URL = "https://api.mainnet-beta.solana.com";
const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

const HEADERS = { "X-API-KEY": API_KEY, "x-chain": "solana" };
const V1_TOKEN_LIST_URL = "https://public-api.birdeye.so/defi/tokenlist";

const MINIMUM_LIQUIDITY_USD = 500;
const MINIMUM_24H_VOLUME_USD = 1000;

/**
 * Fetch authority metadata using Helius RPC
 */
async function fetchAuthoritiesFromHelius(mint) {
  try {
    const response = await axios.post(HELIUS_RPC, {
      jsonrpc: "2.0",
      id: 1,
      method: "getAccountInfo",
      params: [
        mint,
        {
          encoding: "jsonParsed",
        },
      ],
    });

    const info = response.data?.result?.value?.data?.parsed?.info;

    return {
      mint: info?.mintAuthority ?? null,
      freeze: info?.freezeAuthority ?? null,
    };
  } catch (err) {
    console.error(`❌ Error fetching metadata for ${mint}: ${err.message}`);
    return {
      mint: null,
      freeze: null,
    };
  }
}

/**
 * Token discovery + filtering logic
 */
async function findTokens(sortBy, title) {
  console.log(`\n🔍 Searching for tokens sorted by '${sortBy}'...\n`);

  try {
    const response = await axios.get(V1_TOKEN_LIST_URL, {
      headers: HEADERS,
      params: { sort_by: sortBy, sort_type: "desc", limit: 50 },
    });

    const tokens = response.data.data.tokens;
    if (!tokens || tokens.length === 0) {
      return console.log("✅ API call succeeded, but no tokens were returned.");
    }

    const passing = [];
    const rejected = [];

    for (const token of tokens) {
      const liquidity = token.liquidity || 0;
      const volume = token.v24hUSD || 0;

      const { mint, freeze } = await fetchAuthoritiesFromHelius(token.address);
      const hasMintRenounced = mint === null;
      const hasFreezeRenounced = freeze === null;

      const reasons = [];
      if (liquidity < MINIMUM_LIQUIDITY_USD) reasons.push("low liquidity");
      if (volume < MINIMUM_24H_VOLUME_USD) reasons.push("low volume");
      if (!hasMintRenounced || !hasFreezeRenounced)
        reasons.push("authority not renounced");

      if (reasons.length === 0) {
        passing.push({
          symbol: token.symbol,
          name: token.name,
          liquidity,
          volume,
        });
      } else {
        rejected.push({
          symbol: token.symbol,
          liquidity,
          volume,
          mint,
          freeze,
          reasons: reasons.join(", "),
        });
      }
    }

    if (passing.length === 0) {
      console.log(
        `✅ No tokens matched filters: liquidity > $${MINIMUM_LIQUIDITY_USD}, volume > $${MINIMUM_24H_VOLUME_USD}, authority renounced\n`
      );
    } else {
      console.log(`--- 🔥 ${title} (Found ${passing.length}) 🔥 ---`);
      console.table(
        passing.map((t) => ({
          Symbol: t.symbol,
          Name: t.name,
          Liquidity: `$${t.liquidity.toLocaleString()}`,
          Volume: `$${t.volume.toLocaleString()}`,
        }))
      );
    }
  } catch (err) {
    console.error("❌ Failed to fetch tokens.");
    console.error(err.message || err);
  }
}

/**
 * CLI Entrypoint
 */
async function main() {
  const command = process.argv[2];
  console.log(
    `====================================\n  Solana Token Finder\n====================================`
  );

  if (!HELIUS_API_KEY) {
    console.error("❌ Missing HELIUS_API_KEY in .env");
    process.exit(1);
  }

  switch (command) {
    case "trending":
      await findTokens("v24hChangePercent", "Top Trending by Price Change");
      break;
    case "volume":
      await findTokens("v24hUSD", "Top Tokens by 24h Volume");
      break;
    default:
      console.log("❓ Usage: node find.js [trending | volume]");
  }
}

main();
