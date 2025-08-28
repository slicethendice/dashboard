// heliusStream.js — shared Helius wallet+mint streaming module (CommonJS)

const WebSocket = require("ws");
const fetch = require("node-fetch");
const fs = require("fs");
const path = require("path");

function createWalletMintStream(globalOpts = {}) {
  const cfg = Object.assign(
    {
      heliusApiKey: process.env.HELIUS_API_KEY,
      commitment: "finalized",
      persist: true,
      persistDir: ".helius_state",
      backfillLimit: 15,
      maxDetailConcurrency: 2,
      filterMode: "keywords",
      keywordRegex: /(Swap|Transfer|Initialize|Deposit|Withdraw)/i,
      logPredicate: null,
      rpcTimeoutMs: 7000,
      handshakeTimeoutMs: 8000,
      pingIntervalMs: 12000,
      pongTimeoutMs: 8000,
      maxBackoffMs: 5000,
      probeIntervalMs: 2000,
      noMsgTimeoutMs: 60000,
      onEvent: (e) => console.log("event", e),
      onLog: ({ level, msg, context }) =>
        console.log(`[${level}] ${msg}`, context || ""),
      saveEvent: null,
    },
    globalOpts || {}
  );

  if (!cfg.heliusApiKey)
    throw new Error(
      "Missing Helius API key (opts.heliusApiKey or env HELIUS_API_KEY)"
    );

  // WS uses atlas host; REST can stay on mainnet host
  const WS_URL = `wss://mainnet.helius-rpc.com/?api-key=${cfg.heliusApiKey}`;
  const REST_URL = `https://mainnet.helius-rpc.com/?api-key=${cfg.heliusApiKey}`;

  // State
  let ws = null;
  let timers = { ping: null, liveness: null, idle: null, probe: null };
  let backoffMs = 1000;
  let pair = { wallet: null, mint: null };
  let inflightDetails = 0;
  const seen = new Set();
  let shouldRun = false;

  // --- Persistence helpers ---
  function stateKey(w, m) {
    const a = (w || "none").slice(0, 6);
    const b = (m || "none").slice(0, 6);
    return `${a}_${b}`;
  }
  function stateFile(w, m) {
    return path.join(cfg.persistDir, `state_${stateKey(w, m)}.json`);
  }
  function loadState(w, m) {
    if (!cfg.persist) return { lastSlot: 0, lastSig: null };
    try {
      return JSON.parse(fs.readFileSync(stateFile(w, m)));
    } catch {
      return { lastSlot: 0, lastSig: null };
    }
  }
  function saveState(w, m, st) {
    if (!cfg.persist) return;
    try {
      fs.mkdirSync(cfg.persistDir, { recursive: true });
      fs.writeFileSync(stateFile(w, m), JSON.stringify(st));
    } catch {}
  }

  // --- Utils ---
  function remember(sig) {
    seen.add(sig);
    if (seen.size > 5000) seen.delete(seen.values().next().value);
  }
  function clearAllTimers() {
    for (const k of Object.keys(timers)) {
      const t = timers[k];
      if (t) {
        clearTimeout(t);
        clearInterval(t);
        timers[k] = null;
      }
    }
  }
  function scheduleReconnect(tag) {
    if (!shouldRun) return;
    backoffMs = Math.min(cfg.maxBackoffMs, Math.round(backoffMs * 1.5));
    cfg.onLog({
      level: "warn",
      msg: "Reconnect scheduled",
      context: { delayMs: backoffMs, tag },
    });
    timers.probe = setTimeout(async () => {
      try {
        await rpc("getLatestBlockhash", []);
        connect();
      } catch (e) {
        cfg.onLog({
          level: "warn",
          msg: "Probe failed; will retry",
          context: { err: e.message || String(e) },
        });
        scheduleReconnect("probe-failed");
      }
    }, backoffMs);
  }

  async function rpc(method, params) {
    const controller = new AbortController();
    const id = Math.floor(Math.random() * 1e6);
    const timeout = setTimeout(() => controller.abort(), cfg.rpcTimeoutMs);
    try {
      const res = await fetch(REST_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status} ${res.statusText}: ${text}`);
      }
      const j = await res.json();
      if (j.error) throw new Error(`${j.error.code} ${j.error.message}`);
      return j;
    } finally {
      clearTimeout(timeout);
    }
  }

  // Backfill by the wallet; filter by mint when emitting
  async function backfillOnce(wallet, mint, lastKnownSlot = 0) {
    try {
      cfg.onLog({
        level: "info",
        msg: "Backfill start",
        context: { limit: cfg.backfillLimit, wallet, mint },
      });
      if (!wallet) return; // require wallet for efficient backfill

      const since = Math.max(0, lastKnownSlot - 1);
      const sigsRes = await rpc("getSignaturesForAddress", [
        wallet,
        { limit: cfg.backfillLimit, minContextSlot: since },
      ]);
      const sigs = (sigsRes && sigsRes.result) || [];
      for (const { signature, slot } of sigs) {
        if (seen.has(signature)) continue;
        const ok = await txHasWalletMintPair(signature);
        if (!ok) continue;

        const event = {
          type: "event",
          source: "backfill",
          pair: { wallet, mint },
          slot,
          signature,
          err: null,
          log: "backfill-scan",
          ts: Date.now(),
        };
        if (cfg.saveEvent) await Promise.resolve(cfg.saveEvent(event));
        cfg.onEvent(event);
        remember(signature);
        const st = loadState(wallet, mint);
        st.lastSlot = Math.max(st.lastSlot || 0, slot);
        st.lastSig = signature;
        saveState(wallet, mint, st);
      }
    } catch (e) {
      cfg.onLog({
        level: "error",
        msg: "Backfill error",
        context: { err: e.message || String(e) },
      });
    }
  }

  function startHeartbeat() {
    if (timers.ping) clearInterval(timers.ping);
    if (timers.liveness) clearTimeout(timers.liveness);
    timers.ping = setInterval(() => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      try {
        ws.ping();
      } catch {}
      if (timers.liveness) clearTimeout(timers.liveness);
      timers.liveness = setTimeout(() => {
        cfg.onLog({ level: "warn", msg: "WS liveness timeout; terminating" });
        try {
          ws.terminate();
        } catch {}
      }, cfg.pongTimeoutMs);
    }, cfg.pingIntervalMs);

    ws.on("pong", () => {
      if (timers.liveness) clearTimeout(timers.liveness);
    });
  }

  function armIdleRecycle() {
    if (timers.idle) clearTimeout(timers.idle);
    timers.idle = setTimeout(() => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      cfg.onLog({
        level: "warn",
        msg: "No messages for a while — recycle socket",
      });
      try {
        ws.terminate();
      } catch {}
    }, cfg.noMsgTimeoutMs);
  }

  function buildSub() {
    // Mentions both wallet and mint to narrow down log feed
    const mentions = [];
    if (pair.wallet) mentions.push(pair.wallet);
    if (pair.mint && pair.mint !== pair.wallet) mentions.push(pair.mint);
    return {
      jsonrpc: "2.0",
      id: 1,
      method: "logsSubscribe",
      params: [{ mentions }, { commitment: cfg.commitment }],
    };
  }

  function isImportantLog(logs) {
    if (!Array.isArray(logs) || !logs.length) return false;
    if (cfg.filterMode === "keywords") {
      const re =
        cfg.keywordRegex || /(Swap|Transfer|Initialize|Deposit|Withdraw)/i;
      return logs.some((l) => re.test(l));
    }
    if (typeof cfg.logPredicate === "function")
      return logs.some(cfg.logPredicate);
    return true;
  }

  async function txHasWalletMintPair(signature) {
    try {
      const json = await rpc("getTransaction", [
        signature,
        { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
      ]);
      const tx = json && json.result;
      if (!tx || !tx.meta) return false;

      // Require that the tx touches BOTH the wallet and the mint
      // 1) mint appears in token balances
      let mintSeen = false;
      if (pair.mint) {
        const pre = tx.meta.preTokenBalances || [];
        const post = tx.meta.postTokenBalances || [];
        const all = pre.concat(post);
        for (const b of all) {
          if (b.mint === pair.mint) {
            mintSeen = true;
            break;
          }
        }
      }

      // 2) wallet appears in owners OR account keys
      let walletSeen = false;
      if (pair.wallet) {
        const pre = tx.meta.preTokenBalances || [];
        const post = tx.meta.postTokenBalances || [];
        const all = pre.concat(post);
        for (const b of all) {
          if (b.owner === pair.wallet) {
            walletSeen = true;
            break;
          }
        }
        if (!walletSeen) {
          const keys = (tx.transaction?.message?.accountKeys || []).map((k) =>
            typeof k === "string" ? k : k.pubkey
          );
          walletSeen = keys.includes(pair.wallet);
        }
      }

      return mintSeen && walletSeen;
    } catch (e) {
      cfg.onLog({
        level: "error",
        msg: "txHasWalletMintPair failed",
        context: { err: e.message || String(e) },
      });
      return false;
    }
  }

  function connect() {
    if (!shouldRun) return;
    if (!pair.wallet || !pair.mint) return; // must have both

    try {
      if (ws) ws.removeAllListeners();
    } catch {}
    clearAllTimers();

    ws = new WebSocket(WS_URL, {
      handshakeTimeout: cfg.handshakeTimeoutMs,
      perMessageDeflate: false,
    });

    ws.on("open", () => {
      cfg.onLog({ level: "info", msg: "Connected to Helius WS" });
      backoffMs = 1000;
      startHeartbeat();
      ws.send(JSON.stringify(buildSub()));
      cfg.onLog({
        level: "info",
        msg: "Sent subscription (mentions wallet+mint)",
        context: {
          wallet: pair.wallet,
          mint: pair.mint,
          commitment: cfg.commitment,
        },
      });
      armIdleRecycle();
    });

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.id === 1 && msg.result) {
          cfg.onLog({
            level: "info",
            msg: "Subscribed",
            context: { id: msg.result },
          });
          armIdleRecycle();
          return;
        }
        if (msg.method === "logsNotification") {
          armIdleRecycle();
          const { signature, logs, err } = msg.params.result.value;
          const { slot } = msg.params.result.context;
          if (seen.has(signature)) return;
          if (!isImportantLog(logs)) return;
          if (inflightDetails >= cfg.maxDetailConcurrency) return;

          inflightDetails++;
          (async () => {
            const ok = await txHasWalletMintPair(signature);
            inflightDetails--;
            if (!ok) return;

            const event = {
              type: "event",
              source: "stream",
              pair: { wallet: pair.wallet, mint: pair.mint },
              slot,
              signature,
              err: err || null,
              log: logs[0],
              ts: Date.now(),
            };
            if (cfg.saveEvent) await Promise.resolve(cfg.saveEvent(event));
            cfg.onEvent(event);
            remember(signature);
            const st = loadState(pair.wallet, pair.mint);
            st.lastSlot = slot;
            st.lastSig = signature;
            saveState(pair.wallet, pair.mint, st);
          })().catch((e) => {
            inflightDetails--;
            cfg.onLog({
              level: "error",
              msg: "detail fetch failed",
              context: { err: e.message || String(e) },
            });
          });
        }
      } catch (e) {
        cfg.onLog({
          level: "error",
          msg: "message parse failed",
          context: { err: e.message || String(e) },
        });
      }
    });

    ws.on("error", (err) => {
      cfg.onLog({
        level: "error",
        msg: "WS error",
        context: { err: (err && (err.message || String(err))) || "unknown" },
      });
      try {
        ws.terminate();
      } catch {}
    });

    ws.on("close", (code, reason) => {
      cfg.onLog({
        level: "warn",
        msg: "WS closed",
        context: {
          code,
          reason: (reason && reason.toString && reason.toString("utf8")) || "",
        },
      });
      scheduleReconnect("close");
    });

    ws.on &&
      ws.on("unexpected-response", (_, res) => {
        try {
          let body = "";
          res.on("data", (c) => (body += c.toString()));
          res.on("end", () =>
            cfg.onLog({
              level: "error",
              msg: "Unexpected WS response",
              context: {
                statusCode: res && res.statusCode,
                statusMessage: res && res.statusMessage,
                body: body.slice(0, 200),
              },
            })
          );
        } catch (e) {
          cfg.onLog({
            level: "error",
            msg: "Unexpected WS response (handler error)",
            context: { err: e.message || String(e) },
          });
        }
        try {
          ws.terminate();
        } catch {}
      });
  }

  async function start({ wallet, mint }) {
    // REQUIRE BOTH for your use case
    if (!wallet || !mint)
      throw new Error("start({ wallet, mint }) requires both fields");

    const base58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
    if (!base58.test(wallet))
      throw new Error("Invalid wallet (base58 expected)");
    if (!base58.test(mint)) throw new Error("Invalid mint (base58 expected)");

    // Preflight: verify API key works
    try {
      const probe = await fetch(REST_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getLatestBlockhash",
          params: [],
        }),
      });
      if (!probe.ok) {
        const txt = await probe.text();
        throw new Error(
          `HTTP ${probe.status} ${probe.statusText}: ${txt.slice(0, 150)}`
        );
      }
      const js = await probe.json();
      if (js.error)
        throw new Error(`RPC error ${js.error.code}: ${js.error.message}`);
      cfg.onLog({ level: "info", msg: "Helius HTTP probe OK" });
    } catch (e) {
      cfg.onLog({
        level: "error",
        msg: "Helius HTTP probe failed",
        context: { err: e.message || String(e) },
      });
      throw e;
    }

    pair = { wallet, mint };
    shouldRun = true;
    const st = loadState(pair.wallet, pair.mint);
    await backfillOnce(pair.wallet, pair.mint, st.lastSlot);
    connect();
  }

  function stop() {
    shouldRun = false;
    clearAllTimers();
    try {
      ws && ws.terminate();
    } catch {}
    ws = null;
  }

  function setPair({ wallet, mint }) {
    stop();
    return start({ wallet, mint });
  }

  function isConnected() {
    return !!ws && ws.readyState === WebSocket.OPEN;
  }

  return { start, stop, setPair, isConnected };
}

module.exports = { createWalletMintStream };
