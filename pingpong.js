require("dotenv").config();

const fs = require("fs");
const { PublicKey, Connection } = require("@solana/web3.js");
const { getMint } = require("@solana/spl-token");
const { getQuote } = require("./getQuote");
const { store } = require("./store");
const { waitForEntrySignal } = require("./engine/signalEngine");
const { passesBuyGuards } = require("./engine/buyGuard");
const { executeTradeCycle } = require("./engine/trader");

const RUN = require("./config/run");
const PROFILES = require("./config/profiles");

// ===== RPC connection =====
const RPC_URL = process.env.RPC_URL;
if (!RPC_URL) {
  console.error("ERROR: Missing RPC_URL in .env");
  process.exit(1);
}
const connection = new Connection(RPC_URL, "confirmed");

// ===== Console colors + tiny logging =====
const C = {
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  gray: (s) => `\x1b[90m${s}\x1b[0m`,
};
const ts = () => new Date().toISOString();
const LOG_DIR = "logs";
fs.mkdirSync(LOG_DIR, { recursive: true });
const SESSION_TS = ts().replace(/[:.]/g, "-");
const TRADE_LOG = `${LOG_DIR}/trades_${SESSION_TS}.jsonl`;
const tradeStream = fs.createWriteStream(TRADE_LOG, { flags: "a" });
const logTrade = (obj) =>
  tradeStream.write(JSON.stringify({ t: ts(), ...obj }) + "\n");

// ===== Graceful stop controls =====
const FLAG_PATH = "shutdown.flag";
let stopRequested = false;
process.on("SIGUSR1", () => {
  stopRequested = true;
  console.log("🛑 Stop requested (SIGUSR1). Finishing current cycle…");
});

// ===== Sleep =====
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ===== Bankroll compounding =====
let bankrollSol = RUN.START_BANKROLL_SOL ?? RUN.TRADE_AMOUNT_SOL;

// ===== Active profile =====
const ACTIVE_PROFILE = process.env.PROFILE || "baseline";
const P = PROFILES[ACTIVE_PROFILE];
if (!P) {
  console.error(
    `ERROR: Unknown profile "${ACTIVE_PROFILE}". Add it to config/profiles.js or set PROFILE=baseline`
  );
  process.exit(1);
}

// ===== Decimals cache + guard =====
const DECIMALS = {};
async function getDecimals(mintStr) {
  if (!mintStr) {
    console.warn(
      "⚠ getDecimals called with null/undefined mintStr, defaulting to 9"
    );
    return 9;
  }
  if (DECIMALS[mintStr]) return DECIMALS[mintStr];
  try {
    const mintInfo = await getMint(connection, new PublicKey(mintStr));
    DECIMALS[mintStr] = mintInfo.decimals;
    return mintInfo.decimals;
  } catch (e) {
    console.warn(
      `⚠ Failed to fetch decimals for ${mintStr}, defaulting to 9: ${
        e?.message || e
      }`
    );
    return 9;
  }
}

// ===== Re-entry guard (minimal cooldown) =====
async function shouldReenter() {
  if (!global.lastExitAt) return true;
  return Date.now() - global.lastExitAt >= (P.REENTRY_COOLDOWN_MS || 30000);
}

// ===== Authority check =====
async function checkAuthorityRenounced(mint) {
  try {
    const accInfo = await connection.getParsedAccountInfo(new PublicKey(mint));
    const info = accInfo?.value?.data?.parsed?.info;
    return {
      mintAuthority: info?.mintAuthority ?? null,
      freezeAuthority: info?.freezeAuthority ?? null,
    };
  } catch (err) {
    console.warn("⚠️ Authority check failed:", err.message || err);
    return { mintAuthority: null, freezeAuthority: null };
  }
}

// ===== Main loop =====
async function main() {
  try {
    console.log(
      `🚀 Starting pingpong | token=${RUN.tokenMint} | profile=${ACTIVE_PROFILE}`
    );
    console.log(`⚙️ RUN:`, RUN);

    console.log("🔍 Checking mint & freeze authority...");
    const { mintAuthority, freezeAuthority } = await checkAuthorityRenounced(
      RUN.tokenMint
    );

    if (mintAuthority || freezeAuthority) {
      console.log(C.red("🚫 Token is not fully renounced — aborting."));
      console.log(`🔐 mintAuthority: ${mintAuthority || "null"}`);
      console.log(`🧊 freezeAuthority: ${freezeAuthority || "null"}`);
      return;
    }

    console.log(C.green("✅ Token is fully renounced — proceeding...\n"));

    const tokenDecimals = await getDecimals(RUN.tokenMint);
    let cycle = 0;

    while (cycle < RUN.MAX_CYCLES) {
      RUN.TRADE_AMOUNT_SOL = bankrollSol;

      if (stopRequested || fs.existsSync(FLAG_PATH)) {
        console.log("🛑 Stop requested — exiting after this cycle.");
        break;
      }

      if (!(await shouldReenter())) {
        await sleep(RUN.SELL_DELAY_MS);
        continue;
      }

      store.reset?.();
      console.log(
        `\n🔁 Cycle #${cycle + 1} | tradeSOL=${RUN.TRADE_AMOUNT_SOL}`
      );

      const entryOK = await waitForEntrySignal(
        RUN.tokenMint,
        RUN.TRADE_AMOUNT_SOL,
        tokenDecimals,
        P.ENTRY_SIGNAL || {}
      );
      if (!entryOK) {
        cycle++;
        continue;
      }

      const guardOK = await passesBuyGuards(
        RUN.tokenMint,
        RUN.TRADE_AMOUNT_SOL,
        tokenDecimals,
        P.BUY_GUARD || {}
      );
      if (!guardOK) {
        console.warn("⚠ Buy guard failed (downtrend/slide) — skipping cycle.");
        cycle++;
        await sleep(RUN.SELL_DELAY_MS);
        continue;
      }

      // ===== Execute trade cycle (buy → hold → sell) =====
      const tradeResult = await executeTradeCycle({
        tokenMint: RUN.tokenMint,
        tokenDecimals,
        tradeAmountSOL: RUN.TRADE_AMOUNT_SOL,
        BUY_DELAY_MS: RUN.BUY_DELAY_MS,
        SELL_DELAY_MS: RUN.SELL_DELAY_MS,
        profileConfig: P,
        logTrade,
      });

      if (!tradeResult.success) {
        cycle++;
        continue;
      }

      bankrollSol = tradeResult.updatedBankroll;
      global.lastExitAt = Date.now();

      logTrade({
        phase: "sell",
        cycle: cycle + 1,
        token: RUN.tokenMint,
        sellSOL: tradeResult.expectedSellInSOL,
        netProfit: tradeResult.netProfit,
        bankrollSol,
      });

      const pnlColor = tradeResult.netProfit >= 0 ? C.green : C.red;
      console.log(
        `✅ Cycle #${cycle + 1} closed | PnL: ${pnlColor(
          tradeResult.netProfit.toFixed(6)
        )} SOL | Bankroll: ${bankrollSol.toFixed(6)} SOL`
      );

      cycle++;
      await sleep(200);
    }

    console.log(C.yellow("\n👋 Done. Flushing logs…"));
    tradeStream.end();
  } catch (err) {
    console.error(
      C.red("💥 Fatal runtime error in main:"),
      err?.message || err
    );
    tradeStream.end?.();
    process.exit(1);
  }
}

process.on("SIGINT", () => {
  console.log("\n^C");
  process.exit(0);
});
process.on("SIGTERM", () => process.exit(0));

main().catch((e) => {
  console.error(C.red("💥 Fatal error:"), e?.message || e);
  process.exit(1);
});
