// app.js — single-file version (new shape only)
// Requires Chart.js UMD from CDN (Chart global is available)

/* ---------- utils ---------- */
const num = (x) => {
  const n = Number(x);
  return Number.isFinite(n) ? n : NaN;
};
const pct = (n, d) =>
  Number.isFinite(n) && Number.isFinite(d) && d !== 0 ? (n / d) * 100 : NaN;
const sum = (arr) => arr.reduce((a, b) => a + (Number(b) || 0), 0);
const median = (arr) => {
  const a = arr
    .filter(Number.isFinite)
    .slice()
    .sort((x, y) => x - y);
  if (!a.length) return NaN;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
const cumulative = (arr) => {
  let s = 0;
  return arr.map((v) => (s += Number(v) || 0));
};
const bucketize = (values, binSize) => {
  const map = new Map();
  for (const v of values) {
    const n = Number(v);
    if (!Number.isFinite(n)) continue;
    const b = Math.floor(n / binSize) * binSize;
    const label = `${b}–${b + binSize}`;
    map.set(label, (map.get(label) || 0) + 1);
  }
  return { labels: [...map.keys()], data: [...map.values()] };
};

/* ---------- parsing ---------- */
function parseFileText(txt) {
  const lines = txt
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length > 1) {
    const out = [];
    for (const l of lines) {
      try {
        out.push(JSON.parse(l));
      } catch {}
    }
    if (out.length) return out;
  }
  try {
    const j = JSON.parse(txt);
    if (Array.isArray(j)) return j;
  } catch {}
  return [];
}

/* ---------- normalization (new shape only) ----------
 buy:  { phase:"buy",  cycle, solIn, tokensOut, entryMetrics:{ slope, spread, aboveSmaBps, breakoutPct } }
 poll: { phase:"poll", cycle, edgeBps, impactBps, spreadBps, timeHeldMs }
 sell: { phase:"sell", cycle, sellSOL, netProfit, bankrollSol, timeHeldMs, reason }
----------------------------------------------------- */
function normalizeTradesNewShape(rows) {
  const buys = new Map();
  const pollsByCycle = new Map();
  const sellsRaw = [];

  for (const r of rows) {
    if (!r) continue;
    if (r.phase === "buy") {
      const c = num(r.cycle);
      if (!c) continue;
      const m = r.entryMetrics || {};
      buys.set(c, {
        solIn: num(r.solIn),
        tokensOut: num(r.tokensOut),
        entrySlope: num(m.slope),
        entrySpread: num(m.spread),
        aboveSmaBps: num(m.aboveSmaBps),
        breakoutPct: num(m.breakoutPct),
      });
    } else if (r.phase === "poll") {
      const c = num(r.cycle);
      if (!c) continue;
      const arr = pollsByCycle.get(c) || [];
      arr.push({
        edgeBps: num(r.edgeBps),
        impactBps: num(r.impactBps),
        spreadBps: num(r.spreadBps),
        timeHeldMs: num(r.timeHeldMs),
      });
      pollsByCycle.set(c, arr);
    } else if (r.phase === "sell") {
      sellsRaw.push(r);
    }
  }

  const sells = sellsRaw.map((r, i) => {
    const c = num(r.cycle) || i + 1;
    const buy = buys.get(c);
    const buySOL = buy?.solIn;
    const sellSOL = num(r.sellSOL);
    const netProfit = num(r.netProfit);
    const timeHeldSec = num(r.timeHeldMs) / 1000;
    const bankroll = num(r.bankrollSol);
    const priceChangePct = Number.isFinite(buySOL)
      ? pct(sellSOL - buySOL, buySOL)
      : NaN;
    return {
      cycle: c,
      reason: r.reason || "unknown",
      buySOL,
      sellSOL,
      netProfit,
      priceChangePct,
      timeHeldSec,
      entrySlope: buy?.entrySlope,
      entrySpread: buy?.entrySpread,
      bankroll,
    };
  });

  return { sells, pollsByCycle };
}

/* ---------- charts ---------- */
let charts = [];
function clearCharts() {
  charts.forEach((ch) => {
    try {
      ch.destroy();
    } catch {}
  });
  charts = [];
}

function deriveBankrollSeries(sells) {
  const anyLogged = sells.some((s) => Number.isFinite(s.bankroll));
  if (anyLogged)
    return sells.map((s) => (Number.isFinite(s.bankroll) ? s.bankroll : NaN));
  const pnl = sells.map((s) => Number(s.netProfit) || 0);
  const cum = cumulative(pnl);
  const firstBuy = sells.find((s) => Number.isFinite(s.buySOL))?.buySOL;
  const start = Number.isFinite(firstBuy) ? firstBuy * 10 : 0; // heuristic for display only
  return cum.map((v) => start + v);
}

function renderCharts(
  sells,
  pollsByCycle,
  colorfulBars = false,
  hideZero = true
) {
  clearCharts();
  const cycles = sells.map((s) => s.cycle);
  const pnl = sells.map((s) => Number(s.netProfit) || 0);
  const pnlFiltered = hideZero
    ? pnl.map((v, i) => ({ v, i })).filter((x) => Math.abs(x.v) > 0)
    : pnl.map((v, i) => ({ v, i }));
  const labelsFiltered = pnlFiltered.map((x) => cycles[x.i]);
  const pnlValues = pnlFiltered.map((x) => x.v);
  const pnlCum = cumulative(pnl);

  const bankroll = deriveBankrollSeries(sells);
  const holds = sells.map((s) => Number(s.timeHeldSec));
  const entrySlope = sells.map((s) => Number(s.entrySlope));
  const entrySpread = sells.map((s) => Number(s.entrySpread));

  const medSpread = cycles.map((cyc) => {
    const arr = pollsByCycle.get(cyc) || [];
    const vals = arr.map((a) => a.spreadBps).filter(Number.isFinite);
    return median(vals);
  });

  const edgeImpact = cycles
    .map((cyc) => {
      const arr = pollsByCycle.get(cyc) || [];
      const last = arr.length ? arr[arr.length - 1] : null;
      return last &&
        Number.isFinite(last.edgeBps) &&
        Number.isFinite(last.impactBps)
        ? { x: last.impactBps, y: last.edgeBps }
        : null;
    })
    .filter(Boolean);

  const pos = colorfulBars ? "rgba(32,201,151,0.85)" : "rgba(80,150,80,0.85)";
  const neg = colorfulBars ? "rgba(255,107,129,0.85)" : "rgba(200,80,80,0.85)";

  const mk = (id, cfg) => {
    const el = document.getElementById(id);
    if (!el) return null;
    const c = new Chart(el, cfg);
    charts.push(c);
    return c;
  };

  // Per-cycle PnL
  mk("pnlBarChart", {
    type: "bar",
    data: {
      labels: labelsFiltered,
      datasets: [
        {
          label: "PnL (SOL)",
          data: pnlValues,
          backgroundColor: pnlValues.map((v) => (v >= 0 ? pos : neg)),
        },
      ],
    },
    options: {
      responsive: true,
      animation: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: { label: (c) => `${Number(c.raw).toFixed(6)} SOL` },
        },
      },
      scales: {
        x: { title: { display: true, text: "Cycle" } },
        y: { title: { display: true, text: "SOL" } },
      },
    },
  });

  // Cumulative PnL
  mk("pnlCumChart", {
    type: "line",
    data: {
      labels: cycles,
      datasets: [
        {
          label: "Cumulative PnL (SOL)",
          data: pnlCum,
          pointRadius: 0,
          tension: 0.25,
        },
      ],
    },
    options: {
      responsive: true,
      animation: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { title: { display: true, text: "Cycle" } },
        y: { title: { display: true, text: "SOL" } },
      },
    },
  });

  // Bankroll
  mk("bankrollChart", {
    type: "line",
    data: {
      labels: cycles,
      datasets: [
        {
          label: "Bankroll (SOL)",
          data: bankroll,
          pointRadius: 0,
          tension: 0.25,
        },
      ],
    },
    options: {
      responsive: true,
      animation: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { title: { display: true, text: "Cycle" } },
        y: { title: { display: true, text: "SOL" } },
      },
    },
  });

  // Hold histogram (10s bins)
  const { labels: holdBins, data: holdCounts } = (() => {
    const valid = holds.filter(Number.isFinite);
    return bucketize(valid, 10);
  })();
  mk("holdHistChart", {
    type: "bar",
    data: {
      labels: holdBins,
      datasets: [{ label: "Count", data: holdCounts }],
    },
    options: {
      responsive: true,
      animation: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { title: { display: true, text: "Hold Duration (s bins)" } },
        y: { beginAtZero: true, title: { display: true, text: "Trades" } },
      },
    },
  });

  // Entry metrics
  mk("entrySlopeChart", {
    type: "line",
    data: {
      labels: cycles,
      datasets: [
        {
          label: "Entry Slope (bps/s)",
          data: entrySlope,
          pointRadius: 0,
          tension: 0.25,
        },
      ],
    },
    options: {
      responsive: true,
      animation: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { title: { display: true, text: "Cycle" } },
        y: { title: { display: true, text: "bps/s" } },
      },
    },
  });
  mk("entrySpreadChart", {
    type: "line",
    data: {
      labels: cycles,
      datasets: [
        {
          label: "Entry Spread (bps)",
          data: entrySpread,
          pointRadius: 0,
          tension: 0.25,
        },
      ],
    },
    options: {
      responsive: true,
      animation: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { title: { display: true, text: "Cycle" } },
        y: { title: { display: true, text: "bps" } },
      },
    },
  });

  // Median spread during hold
  mk("medianSpreadChart", {
    type: "line",
    data: {
      labels: cycles,
      datasets: [
        {
          label: "Median Spread (bps)",
          data: medSpread,
          pointRadius: 0,
          tension: 0.25,
        },
      ],
    },
    options: {
      responsive: true,
      animation: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { title: { display: true, text: "Cycle" } },
        y: { title: { display: true, text: "bps" } },
      },
    },
  });

  // Edge vs Impact (scatter)
  mk("edgeImpactScatter", {
    type: "scatter",
    data: { datasets: [{ label: "Edge vs Impact", data: edgeImpact }] },
    options: {
      responsive: true,
      animation: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { title: { display: true, text: "Impact (bps)" } },
        y: { title: { display: true, text: "Edge (bps)" } },
      },
    },
  });
}

/* ---------- table + KPIs ---------- */
function renderTable(sells) {
  const tbody = document.querySelector("#tradesTable tbody");
  if (!tbody) return;
  tbody.innerHTML = "";
  for (const s of sells) {
    const pnl = Number(s.netProfit) || 0;
    const tr = document.createElement("tr");
    tr.className = "border-b border-gray-700";
    tr.innerHTML = `
      <td class="px-4 py-2">${s.cycle}</td>
      <td class="px-4 py-2">${s.reason}</td>
      <td class="px-4 py-2">${
        Number.isFinite(s.buySOL) ? s.buySOL.toFixed(6) : "–"
      }</td>
      <td class="px-4 py-2">${
        Number.isFinite(s.sellSOL) ? s.sellSOL.toFixed(6) : "–"
      }</td>
      <td class="px-4 py-2 ${
        pnl >= 0 ? "text-green-400" : "text-red-400"
      }">${pnl.toFixed(6)}</td>
      <td class="px-4 py-2">${
        Number.isFinite(s.priceChangePct) ? s.priceChangePct.toFixed(2) : "–"
      }</td>
      <td class="px-4 py-2">${
        Number.isFinite(s.timeHeldSec) ? s.timeHeldSec.toFixed(1) : "–"
      }</td>
      <td class="px-4 py-2">${
        Number.isFinite(s.entrySlope) ? s.entrySlope.toFixed(2) : "–"
      }</td>
      <td class="px-4 py-2">${
        Number.isFinite(s.entrySpread) ? s.entrySpread.toFixed(2) : "–"
      }</td>
      <td class="px-4 py-2">${
        Number.isFinite(s.bankroll) ? s.bankroll.toFixed(6) : "–"
      }</td>
    `;
    tbody.appendChild(tr);
  }
}

function renderKPIs(sells) {
  const trades = sells.length;
  const pnl = sells.map((s) => Number(s.netProfit) || 0);
  const wins = pnl.filter((v) => v > 0).length;
  const total = sum(pnl);
  const avg = trades ? total / trades : 0;

  const holds = sells.map((s) => Number(s.timeHeldSec)).filter(Number.isFinite);
  const p50 = median(holds);
  const p90 = (() => {
    const b = holds.slice().sort((x, y) => x - y);
    if (!b.length) return NaN;
    const idx = Math.floor(0.9 * (b.length - 1));
    return b[idx];
  })();

  const set = (id, v) => {
    const el = document.getElementById(id);
    if (el) el.textContent = v;
  };
  set("kpi-trades", trades.toString());
  set("kpi-win", trades ? `${((wins / trades) * 100).toFixed(1)}%` : "–");
  set("kpi-total", total.toFixed(6));
  set("kpi-avg", avg.toFixed(6));
  set(
    "kpi-holds",
    `${Number.isFinite(p50) ? p50.toFixed(1) : "–"} / ${
      Number.isFinite(p90) ? p90.toFixed(1) : "–"
    }`
  );
}

/* ---------- wiring ---------- */
(function main() {
  const fileInput = document.getElementById("fileInput");
  const toggleColors = document.getElementById("toggleColors");
  const hideZero = document.getElementById("hideZero");

  let state = { sells: [], pollsByCycle: new Map() };

  function refresh() {
    if (!state.sells.length) return;
    renderKPIs(state.sells);
    renderCharts(
      state.sells,
      state.pollsByCycle,
      !!(toggleColors && toggleColors.checked),
      !!(hideZero && hideZero.checked)
    );
    renderTable(state.sells);
  }

  if (fileInput) {
    fileInput.addEventListener("change", (e) => {
      const f = e.target.files?.[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        const rows = parseFileText(reader.result);
        const { sells, pollsByCycle } = normalizeTradesNewShape(rows);
        state = { sells, pollsByCycle };
        refresh();
      };
      reader.readAsText(f);
    });
  }
  if (toggleColors) toggleColors.addEventListener("change", refresh);
  if (hideZero) hideZero.addEventListener("change", refresh);
})();
