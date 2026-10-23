/** The page at GET /accuracy: the live model's error against MTS's, period by period, from /accuracy.json. */
export const ACCURACY_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Arrival Model Accuracy</title>
<style>
  :root { --bg: #f7f8f3; --card: #fff; --text: #17301b; --muted: #5e6b50; --line: #dfe5d3; --ours: #2f7a3a; --mts: #9a8f7e; --good: #2f7a3a; --bad: #b4655b; }
  @media (prefers-color-scheme: dark) { :root { --bg: #121812; --card: #1a221a; --text: #e6ecd9; --muted: #a2ad93; --line: #2c3a2c; --ours: #8fd18a; --mts: #8d8475; --good: #8fd18a; --bad: #e6998f; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 980px; margin: 0 auto; padding: 24px 16px 48px; display: grid; gap: 18px; }
  h1 { margin: 0; font-size: 22px; }
  p { margin: 0; color: var(--muted); }
  .controls { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  select, button { font: inherit; padding: 6px 10px; border-radius: 8px; border: 1px solid var(--line); background: var(--card); color: var(--text); }
  button.on { background: var(--text); color: var(--bg); }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 10px; }
  .tile { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 12px 14px; }
  .tile b { display: block; font-size: 24px; font-variant-numeric: tabular-nums; }
  .tile span { color: var(--muted); font-size: 13px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 14px; overflow-x: auto; }
  svg text { fill: var(--muted); font-size: 11px; }
  .legend { display: flex; gap: 16px; font-size: 13px; color: var(--muted); margin-bottom: 6px; }
  .legend i { display: inline-block; width: 18px; height: 3px; border-radius: 2px; vertical-align: middle; margin-right: 6px; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; font-variant-numeric: tabular-nums; }
  th, td { text-align: right; padding: 5px 8px; border-bottom: 1px solid var(--line); white-space: nowrap; }
  th:first-child, td:first-child { text-align: left; }
  th { color: var(--muted); font-weight: 600; }
  .good { color: var(--good); } .bad { color: var(--bad); }
</style>
</head>
<body>
<main>
  <div>
    <h1>Arrival model accuracy</h1>
    <p>How far off each bus arrival prediction was once the bus came: the live model against MTS's own prediction. Lower is better.</p>
  </div>
  <div class="controls">
    <button id="by-hour" class="on">By hour</button>
    <button id="by-day">By day</button>
    <select id="horizon" aria-label="How far ahead"></select>
    <span id="status" style="color: var(--muted); font-size: 13px"></span>
  </div>
  <div class="tiles" id="tiles"></div>
  <div class="card">
    <div class="legend"><span><i style="background: var(--ours)"></i>Our average error</span><span><i style="background: var(--mts)"></i>MTS's average error</span></div>
    <div id="chart"></div>
  </div>
  <div class="card"><table id="table"></table></div>
</main>
<script>
  let by = "hour", data = null;
  const $ = (id) => document.getElementById(id);
  const sec = (s) => s == null ? "–" : s < 90 ? Math.round(s) + " s" : (s / 60).toFixed(1) + " min";
  async function load() {
    $("status").textContent = "Loading…";
    try {
      data = await (await fetch("accuracy.json?by=" + by)).json();
      const horizons = [...new Set(data.rows.map((r) => r.horizon))].sort((a, b) => (a === "all" ? -1 : b === "all" ? 1 : parseFloat(a) - parseFloat(b)));
      const sel = $("horizon"), keep = sel.value || "all";
      sel.innerHTML = horizons.map((h) => '<option value="' + h + '">' + (h === "all" ? "All horizons" : h + " ahead") + "</option>").join("");
      sel.value = horizons.includes(keep) ? keep : "all";
      $("status").textContent = data.scored.toLocaleString() + " predictions scored";
      draw();
    } catch (e) { $("status").textContent = "Couldn't load: " + e; }
  }
  function draw() {
    const rows = data.rows.filter((r) => r.horizon === $("horizon").value);
    const last = rows[rows.length - 1], first = rows[0];
    $("tiles").innerHTML = last ? [
      [sec(last.ourMeanError), "our average error, latest " + by],
      [sec(last.mtsMeanError), "MTS's, same " + by],
      [(last.improvement > 0 ? "−" : "+") + Math.abs(last.improvement) + "%", "our error vs MTS's, latest " + by],
      [last.ourWithinMinute + "%", "of ours within a minute (MTS " + last.mtsWithinMinute + "%)"],
      [first && rows.length > 1 ? ((last.improvement - first.improvement > 0 ? "+" : "") + (last.improvement - first.improvement).toFixed(1) + " pts") : "–", "change in improvement since the first " + by],
    ].map(([v, l]) => '<div class="tile"><b>' + v + "</b><span>" + l + "</span></div>").join("") : '<div class="tile"><b>–</b><span>Nothing scored yet</span></div>';
    // Chart: both errors over time.
    const W = Math.max(640, rows.length * 18), H = 260, L = 46, R = 12, T = 10, B = 34;
    const max = Math.max(60, ...rows.map((r) => Math.max(r.ourMeanError, r.mtsMeanError))) * 1.1;
    const x = (i) => L + (rows.length < 2 ? (W - L - R) / 2 : (i / (rows.length - 1)) * (W - L - R));
    const y = (v) => T + (1 - v / max) * (H - T - B);
    const line = (k, c) => '<polyline fill="none" stroke="' + c + '" stroke-width="2.5" stroke-linejoin="round" points="' + rows.map((r, i) => x(i) + "," + y(r[k])).join(" ") + '"/>' + rows.map((r, i) => '<circle cx="' + x(i) + '" cy="' + y(r[k]) + '" r="2.5" fill="' + c + '"><title>' + r.period + ": " + sec(r[k]) + "</title></circle>").join("");
    const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => { const v = max * f; return '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y(v) + '" y2="' + y(v) + '" stroke="var(--line)"/><text x="' + (L - 6) + '" y="' + (y(v) + 4) + '" text-anchor="end">' + Math.round(v) + "s</text>"; }).join("");
    const every = Math.max(1, Math.ceil(rows.length / 10));
    const labels = rows.map((r, i) => i % every ? "" : '<text x="' + x(i) + '" y="' + (H - 12) + '" text-anchor="middle">' + (by === "hour" ? r.period.slice(5) : r.period.slice(5)) + "</text>").join("");
    $("chart").innerHTML = rows.length ? '<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + " " + H + '">' + ticks + labels + line("mtsMeanError", "var(--mts)") + line("ourMeanError", "var(--ours)") + "</svg>" : "<p>Nothing scored yet: predictions are scored once their buses have had time to arrive.</p>";
    $("table").innerHTML = "<tr><th>" + (by === "hour" ? "Hour" : "Day") + "</th><th>Scored</th><th>Our error</th><th>MTS's error</th><th>Better by</th><th>Ours ≤1 min</th><th>MTS ≤1 min</th></tr>" +
      [...rows].reverse().map((r) => "<tr><td>" + r.period + "</td><td>" + r.n.toLocaleString() + "</td><td>" + sec(r.ourMeanError) + "</td><td>" + sec(r.mtsMeanError) + '</td><td class="' + (r.improvement > 0 ? "good" : r.improvement < 0 ? "bad" : "") + '">' + r.improvement + "%</td><td>" + r.ourWithinMinute + "%</td><td>" + r.mtsWithinMinute + "%</td></tr>").join("");
  }
  $("by-hour").onclick = () => { by = "hour"; $("by-hour").classList.add("on"); $("by-day").classList.remove("on"); load(); };
  $("by-day").onclick = () => { by = "day"; $("by-day").classList.add("on"); $("by-hour").classList.remove("on"); load(); };
  $("horizon").onchange = draw;
  load();
  setInterval(load, 5 * 60_000);
</script>
</body>
</html>`;
