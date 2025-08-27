// index.js
const $ = (id) => document.getElementById(id);
const set = (id, v) => {
  const el = $(id);
  if (el) el.textContent = v;
};

async function api(path, params = {}) {
  const q = new URLSearchParams(params).toString();
  const res = await fetch(`${path}${q ? `?${q}` : ""}`);
  if (!res.ok) throw new Error(path);
  return res.json();
}

function renderKPIs(k) {
  set("kpi-trades", String(k.trades ?? 0));
  set("kpi-win", Number.isFinite(k.winPct) ? `${k.winPct.toFixed(1)}%` : "–");
  set("kpi-total", Number.isFinite(k.total) ? k.total.toFixed(6) : "0.000000");
  set("kpi-avg", Number.isFinite(k.avg) ? k.avg.toFixed(6) : "0.000000");
}

function renderTable(rows) {
  const tb = $("tbody");
  tb.innerHTML = "";
  for (const r of rows) {
    const tr = document.createElement("tr");
    tr.className = "border-b border-gray-700";
    tr.innerHTML = `
      <td class="px-4 py-2">${r.ts ? dayjs(r.ts).format("HH:mm:ss") : "–"}</td>
      <td class="px-4 py-2">${r.side || ""}</td>
      <td class="px-4 py-2">${
        Number.isFinite(r.price) ? r.price.toFixed(8) : "–"
      }</td>
      <td class="px-4 py-2">${r.qty || ""}</td>`;
    tb.appendChild(tr);
  }
}

let chart;
function renderChart(entriesExits, live) {
  const ctx = $("chart").getContext("2d");
  const points = entriesExits.map((r) => ({
    x: r.ts,
    y: r.price,
    side: r.side,
  }));
  const buy = points.filter((p) => p.side === "BUY");
  const sell = points.filter((p) => p.side === "SELL");

  const datasets = [
    {
      type: "scatter",
      label: "Buys",
      data: buy,
      pointRadius: 4,
      showLine: false,
    },
    {
      type: "scatter",
      label: "Sells",
      data: sell,
      pointRadius: 4,
      showLine: false,
    },
  ];
  if (live?.price) {
    datasets.push({
      type: "line",
      label: "Live",
      data: points.length
        ? [
            { x: points[0].x, y: live.price },
            { x: points[points.length - 1].x, y: live.price },
          ]
        : [],
      borderWidth: 1,
      tension: 0,
    });
  }

  if (chart) chart.destroy();
  chart = new Chart(ctx, {
    data: { datasets },
    options: {
      parsing: false,
      scales: {
        x: { type: "time", adapters: { date: dayjs } },
        y: { beginAtZero: false },
      },
      plugins: { legend: { labels: { color: "#e5e7eb" } } },
    },
  });
}

async function load() {
  const mint = $("mint")?.value?.trim();
  const [trades, summary] = await Promise.all([
    api("/api/trades", { mint, limit: 500 }),
    api("/api/trades/summary", { mint, limit: 500 }),
  ]);
  renderKPIs(summary.kpis || {});
  renderTable(trades);

  let live = null;
  if (mint) {
    try {
      live = await api("/api/price", { mint, amount: "1000000" });
    } catch {}
  }
  renderChart(
    trades.map((t) => ({ ts: t.ts, price: t.price, side: t.side })),
    live
  );
}

$("refresh")?.addEventListener("click", () => load().catch(console.error));
load().catch(console.error);
