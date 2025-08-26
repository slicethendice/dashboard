// shutdown.js
const fs = require("fs");

const color = (c, s) => {
  const map = { red: 31, green: 32, yellow: 33, gray: 90 };
  return `\x1b[${map[c] || 0}m${s}\x1b[0m`;
};

function initShutdown({
  forbidNewBuys, // () => void
  getOpenPosition, // () => Promise<Position|null>
  pollTick, // (pos) => Promise<{ netProfitBps:number, minOutLamports:number }>
  sellNow, // (pos, minOutLamports) => Promise<string /* txid */>
  saveState, // () => Promise<void>
  logStream, // optional: fs.WriteStream
  maxExitWaitMs = 60_000, // wait up to 60s to get a decent exit
  maxLossBps = 50, // stop out if <= -50 bps on shutdown
  mode = "sell", // "sell" | "persist"  (persist = no forced exit)
}) {
  let shuttingDown = false;
  let cleaning = false;

  async function cleanup(reason) {
    if (cleaning) return;
    cleaning = true;
    shuttingDown = true;

    console.log("👋 Shutting down, flushing logs…", { reason });
    try {
      forbidNewBuys?.();
    } catch {}

    try {
      const pos = await getOpenPosition?.();
      if (pos && mode === "sell") {
        console.log("🛡️ Protecting open position before exit…", {
          mint: pos.mint,
          amount: pos.amount,
        });

        const start = Date.now();
        while (Date.now() - start < maxExitWaitMs) {
          const snap = await pollTick(pos); // { netProfitBps, minOutLamports }
          // Exit if profitable OR loss beyond clamp
          if (
            snap.netProfitBps >= 0 ||
            Math.abs(snap.netProfitBps) >= maxLossBps
          ) {
            try {
              const txid = await sellNow(pos, snap.minOutLamports);
              const tag =
                snap.netProfitBps >= 0
                  ? color("green", "✅ Sold on shutdown")
                  : color("red", "⚠️ Stop-out on shutdown");
              console.log(tag, { txid, netProfitBps: snap.netProfitBps });
              break;
            } catch (err) {
              console.log(
                color("red", "❌ Sell failed, retrying…"),
                err?.message || err
              );
            }
          }
          await new Promise((r) => setTimeout(r, 1500));
        }
      } else if (pos && mode === "persist") {
        console.log("💾 Persisting open position for resume later…", {
          mint: pos.mint,
          amount: pos.amount,
        });
      } else {
        console.log("ℹ️ No open position; safe to exit.");
      }
    } catch (e) {
      console.log(
        color("red", "⚠️ Shutdown protection error"),
        e?.message || e
      );
    }

    try {
      await saveState?.();
    } catch {}
    if (logStream) await new Promise((res) => logStream.end(res));

    process.exit(0);
  }

  ["SIGINT", "SIGTERM", "SIGHUP"].forEach((sig) =>
    process.on(sig, () => cleanup(sig))
  );
  process.on("uncaughtException", (e) => {
    console.log(color("red", "💥 Uncaught exception"), e);
    cleanup("uncaughtException");
  });
  process.on("unhandledRejection", (e) => {
    console.log(color("red", "💥 Unhandled rejection"), e);
    cleanup("unhandledRejection");
  });

  return {
    get shuttingDown() {
      return shuttingDown;
    },
  };
}

module.exports = { initShutdown };
