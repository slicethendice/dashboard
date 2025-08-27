// getQuote.js
// const fetch = (...args) =>
//   import("node-fetch").then(({ default: fetch }) => fetch(...args));

// const SLIPPAGE_BPS = 1000; // Adjust as needed

// async function getQuote(inputMint, outputMint, amount) {
//   const url = `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${SLIPPAGE_BPS}`;

//   const res = await fetch(url);

//   if (!res.ok) {
//     console.error(`❌ HTTP ${res.status}: ${res.statusText}`);
//     const errText = await res.text();
//     console.error("Response body:", errText);
//     return null;
//   }

//   const json = await res.json();

//   if (!json.routePlan || json.routePlan.length === 0) {
//     console.error("❌ No route in response:");
//     console.dir(json, { depth: null });
//     return null;
//   }

//   return json;
// }

// module.exports = { getQuote };

// getQuote.js
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

const { store } = require("./store");
const P = require("./config/profiles").baseline; // TODO: swap with active profile if needed

const QUOTE_CACHE = new Map();
let lastFetchTimestamps = [];

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

function throttleRateLimit() {
  const now = Date.now();
  lastFetchTimestamps = lastFetchTimestamps.filter((ts) => now - ts < 60000);
  if (lastFetchTimestamps.length >= (P.RATE_LIMIT_RPM || 60)) {
    const oldest = lastFetchTimestamps[0];
    const wait = 60000 - (now - oldest);
    return wait > 0 ? wait : 0;
  }
  return 0;
}

function getCacheKey(inputMint, outputMint, amount) {
  return `${inputMint}_${outputMint}_${amount}`;
}

async function getQuote(inputMint, outputMint, amount) {
  const SLIPPAGE_BPS = 1000;
  const jitter = Math.floor(Math.random() * (P.QUOTE_JITTER_MS || 200));
  const cacheKey = getCacheKey(inputMint, outputMint, amount);
  const now = Date.now();

  // Check cache
  const cached = QUOTE_CACHE.get(cacheKey);
  if (cached && now - cached.ts < (P.QUOTE_CACHE_MS || 1000)) {
    return cached.data;
  }

  const waitMs = throttleRateLimit();
  if (waitMs > 0) {
    console.log(`⏳ Rate limit hit — delaying ${waitMs}ms…`);
    await sleep(waitMs + jitter);
  } else {
    await sleep(jitter);
  }

  const url = `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${SLIPPAGE_BPS}`;
  let attempt = 0;

  while (attempt < 5) {
    try {
      const res = await fetch(url);

      if (!res.ok) {
        const text = await res.text();
        console.warn(`❌ [${res.status}] ${res.statusText}: ${text}`);

        if (res.status === 429) {
          const backoff = Math.min(
            (P.BACKOFF_BASE_MS || 800) * 2 ** attempt,
            P.BACKOFF_MAX_MS || 6000
          );
          console.log(`⏳ Retrying in ${backoff}ms…`);
          await sleep(backoff);
          attempt++;
          continue;
        }

        return null;
      }

      const json = await res.json();
      if (!json.routePlan || json.routePlan.length === 0) {
        console.warn("❌ No route in quote response");
        return null;
      }

      lastFetchTimestamps.push(Date.now());
      QUOTE_CACHE.set(cacheKey, { data: json, ts: Date.now() });

      return json;
    } catch (err) {
      console.warn("❌ Quote fetch error:", err.message || err);
      const retryMs = 1000 + 500 * attempt;
      console.log(`⏳ Retrying in ${retryMs}ms…`);
      await sleep(retryMs);
      attempt++;
    }
  }

  return null;
}

module.exports = { getQuote };
