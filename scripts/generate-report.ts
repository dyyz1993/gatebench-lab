/**
 * generate-report.ts
 *
 * Usage: npx ts-node generate-report.ts <results-dir>
 *
 * Reads normalized/*.json, generates a self-contained HTML report with:
 *   - Chart.js bar charts (RPS + latency)
 *   - Implementation rankings (sorted, color-coded)
 *   - Side-by-side concurrency comparison
 */

import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StatPoint { median: number; min: number; max: number; }

interface NormalizedRecord {
  impl: string; variant: string; scenario: string; machine: string;
  concurrency: number; duration_sec: number; runs: number;
  rps: StatPoint; throughput_mbps: StatPoint;
  latency_ms: { p50: StatPoint; p95: StatPoint; p99: StatPoint; };
  error_rate: StatPoint; cpu_avg_pct: StatPoint; mem_rss_mb: StatPoint;
  gc_pause_ms: StatPoint; open_fds: StatPoint; notes: string;
}

interface ScenarioFile { scenario: string; records: NormalizedRecord[]; }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function esc(s: string | number): string {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function fmt(v: number, d = 2): string {
  return v.toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(v) ? 0 : d, maximumFractionDigits: d });
}

/** Colors for implementations */
const COLORS: Record<string, string> = {
  rust: '#b33dc6', go: '#00add8', node: '#68a063', python: '#306998',
  'upstream-direct': '#888',
};
const FALLBACK_COLORS = ['#e6194b','#3cb44b','#ffe119','#4363d8','#f58231','#911eb4','#42d4f4','#f032e6'];
function implColor(impl: string, i: number): string {
  return COLORS[impl] || FALLBACK_COLORS[i % FALLBACK_COLORS.length];
}

// ---------------------------------------------------------------------------
// Chart generation (Chart.js CDN)
// ---------------------------------------------------------------------------

function chartJS(
  canvasId: string,
  labels: string[],
  datasets: { label: string; data: number[]; color: string }[],
  title: string,
  unit: string,
  reverse = false,
): string {
  return `new Chart(document.getElementById('${canvasId}'), {
    type: 'bar',
    data: {
      labels: ${JSON.stringify(labels)},
      datasets: [${datasets.map(d => `{
        label: ${JSON.stringify(d.label)},
        data: ${JSON.stringify(d.data)},
        backgroundColor: '${d.color}44',
        borderColor: '${d.color}',
        borderWidth: 2,
        borderRadius: 4,
      }`).join(',')}]
    },
    options: {
      responsive: true,
      plugins: {
        title: { display: true, text: ${JSON.stringify(title)}, font: { size: 14 } },
        legend: { position: 'bottom' },
      },
      scales: {
        y: { beginAtZero: true, title: { display: true, text: ${JSON.stringify(unit)} } },
        x: { grid: { display: false } }
      }
    }
  });`;
}

function rankingChart(canvasId: string, items: { label: string; value: number; color: string }[], title: string, unit: string): string {
  const sorted = [...items].sort((a, b) => b.value - a.value);
  const isLatency = unit.includes('ms');
  if (isLatency) sorted.sort((a, b) => a.value - b.value);
  return chartJS(canvasId,
    sorted.map(i => i.label),
    [{ label: title, data: sorted.map(i => i.value), color: sorted.length > 0 ? sorted[0].color : '#888' }],
    title, unit,
  );
}

// ---------------------------------------------------------------------------
// HTML sections
// ---------------------------------------------------------------------------

function renderSummaryCards(records: NormalizedRecord[]): string {
  const impls = new Set(records.map(r => r.impl));
  const scenes = new Set(records.map(r => r.scenario));
  const maxRps = Math.max(...records.map(r => r.rps.median));
  const bestImpl = records.find(r => r.rps.median === maxRps)?.impl || '?';
  return `<div style="display:flex;flex-wrap:wrap;gap:12px;margin:1em 0">
    <div class="card"><span class="card-num">${impls.size}</span><span class="card-label">Implementations</span></div>
    <div class="card"><span class="card-num">${scenes.size}</span><span class="card-label">Scenarios</span></div>
    <div class="card"><span class="card-num">${records.length}</span><span class="card-label">Data Points</span></div>
    <div class="card"><span class="card-num">${fmt(maxRps)}</span><span class="card-label">Peak RPS (${esc(bestImpl)})</span></div>
  </div>`;
}

function renderScenarioSection(scenario: string, records: NormalizedRecord[]): string {
  const concurrencies = [...new Set(records.map(r => r.concurrency))].sort((a, b) => a - b);
  const impls = [...new Set(records.map(r => r.impl))].sort();

  let html = `<section id="scenario-${scenario}">
<h2>Scenario: ${esc(scenario)}</h2>
<p>${records.length} data point(s), ${concurrencies.length} concurrency level(s), ${impls.length} implementation(s)</p>`;

  // ── RPS Ranking (best concurrency only, usually the highest) ──
  const bestConc = concurrencies[concurrencies.length - 1];
  const rpsRanking = records
    .filter(r => r.concurrency === bestConc)
    .sort((a, b) => b.rps.median - a.rps.median);

  if (rpsRanking.length > 1) {
    html += `<div class="ranking">
      <h3>🏆 RPS Ranking at c=${bestConc} <span class="rank-subtitle">(Higher is better)</span></h3>
      <table class="rank-table">
        <thead><tr><th>Rank</th><th>Implementation</th><th>RPS</th><th>P95 (ms)</th><th>P99 (ms)</th><th>Error %</th></tr></thead>
        <tbody>`;
    rpsRanking.forEach((r, i) => {
      const rankClass = i === 0 ? 'rank-1' : i === 1 ? 'rank-2' : i === 2 ? 'rank-3' : '';
      html += `<tr class="${rankClass}">
        <td class="rank-badge">${i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `#${i + 1}`}</td>
        <td><strong>${esc(r.impl)}</strong></td>
        <td class="num-highlight">${fmt(r.rps.median)}</td>
        <td>${fmt(r.latency_ms.p95.median, 1)}</td>
        <td>${fmt(r.latency_ms.p99.median, 1)}</td>
        <td>${r.error_rate.median > 0 ? (r.error_rate.median * 100).toFixed(1) + '%' : '0%'}</td>
      </tr>`;
    });
    html += `</tbody></table></div>`;
  }

  // ── RPS Bar Chart (grouped by concurrency) ──
  const chartId = `chart-${scenario}`;
  const labels = concurrencies.map(c => `Concurrency ${c}`);
  const datasets = impls.map((impl, idx) => ({
    label: impl,
    data: concurrencies.map(c => records.find(r => r.impl === impl && r.concurrency === c)?.rps.median ?? 0),
    color: implColor(impl, idx),
  }));

  html += `<div class="chart-container">
    <canvas id="${chartId}"></canvas>
  </div>
  <script>${chartJS(chartId, labels, datasets, `${scenario}: RPS by Implementation`, 'Requests/sec')}</script>`;

  // ── P50 / P95 / P99 Latency Charts ──
  for (const metric of ['p50', 'p95', 'p99'] as const) {
    const chartIdL = `chart-${scenario}-${metric}`;
    const latDatasets = impls.map((impl, idx) => ({
      label: impl,
      data: concurrencies.map(c => records.find(r => r.impl === impl && r.concurrency === c)?.latency_ms[metric].median ?? 0),
      color: implColor(impl, idx),
    }));
    html += `<div class="chart-container">
      <canvas id="${chartIdL}"></canvas>
    </div>
    <script>${chartJS(chartIdL, labels, latDatasets, `${scenario}: P${metric.toUpperCase()} Latency`, 'ms')}</script>`;
  }

  // ── Detailed table ──
  html += `<h3>Detailed Results</h3>
  <div style="overflow-x:auto"><table class="detail-table">
    <thead><tr>
      <th>Implementation</th><th>Concurrency</th><th>RPS</th><th>Throughput</th>
      <th>P50 (ms)</th><th>P95 (ms)</th><th>P99 (ms)</th><th>Error %</th>
    </tr></thead><tbody>`;

  for (const impl of impls) {
    for (const c of concurrencies) {
      const r = records.find(rec => rec.impl === impl && rec.concurrency === c);
      if (!r) continue;
      const rpsPct = rpsRanking.length > 0 ? (r.rps.median / rpsRanking[0].rps.median * 100) : 100;
      html += `<tr>
        <td><strong>${esc(impl)}</strong></td>
        <td>${c}</td>
        <td><div class="rps-bar-cell"><div class="rps-bar" style="width:${rpsPct}%"></div><span>${fmt(r.rps.median)}</span></div></td>
        <td>${fmt(r.throughput_mbps.median, 1)} MB/s</td>
        <td>${fmt(r.latency_ms.p50.median, 1)}</td>
        <td>${fmt(r.latency_ms.p95.median, 1)}</td>
        <td>${fmt(r.latency_ms.p99.median, 1)}</td>
        <td>${r.error_rate.median > 0 ? (r.error_rate.median * 100).toFixed(2) + '%' : '0%'}</td>
      </tr>`;
    }
  }

  html += `</tbody></table></div></section>`;
  return html;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const resultsDir = process.argv[2];
  if (!resultsDir) { console.error('Usage: npx ts-node generate-report.ts <results-dir>'); process.exit(1); }

  const normalizedDir = path.join(resultsDir, 'normalized');
  const files = fs.readdirSync(normalizedDir).filter(f => f.endsWith('.json'));

  const scenarios: ScenarioFile[] = [];
  for (const file of files) {
    const data = JSON.parse(fs.readFileSync(path.join(normalizedDir, file), 'utf-8'));
    scenarios.push(data);
    console.log(`  Loaded ${data.scenario}: ${data.records.length} records`);
  }

  const allRecords: NormalizedRecord[] = scenarios.flatMap(s => s.records);
  const machine = [...new Set(allRecords.map(r => r.machine))][0] || 'unknown';
  const scenarioNames = scenarios.map(s => s.scenario);
  const impls = [...new Set(allRecords.map(r => r.impl))].sort();

  // ── Build HTML ──
  const tableOfContents = scenarios.map(s =>
    `<li><a href="#scenario-${s.scenario}">${s.scenario}</a> (${s.records.length} records)</li>`
  ).join('\n');

  const bodyHtml = scenarios.map(s => renderScenarioSection(s.scenario, s.records)).join('\n');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Gateway Benchmark Report — ${esc(machine)}</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"></script>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 0; background: #f5f7fa; color: #1a1a2e; }
.header { background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%); color: #fff; padding: 2em 1.5em; }
.header h1 { margin: 0; font-size: 2em; }
.header p { opacity: 0.8; margin: 0.3em 0 0; }
.container { max-width: 1200px; margin: 0 auto; padding: 1.5em; }
.toc { background: #fff; border-radius: 10px; padding: 1em 1.5em; margin-bottom: 2em; box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
.toc h2 { margin-top: 0; font-size: 1.1em; color: #555; }
.toc ul { columns: 2; column-gap: 2em; margin: 0; padding-left: 1.5em; }
.toc li { margin: 0.3em 0; }
.toc a { color: #0f3460; text-decoration: none; }
.toc a:hover { text-decoration: underline; }
.card { background: #fff; border-radius: 10px; padding: 1em 1.5em; min-width: 120px; box-shadow: 0 2px 8px rgba(0,0,0,0.06); text-align: center; flex: 1; }
.card-num { display: block; font-size: 1.8em; font-weight: 700; color: #0f3460; }
.card-label { font-size: 0.8em; color: #888; text-transform: uppercase; letter-spacing: 0.5px; }
section { background: #fff; border-radius: 10px; padding: 1.5em; margin: 1.5em 0; box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
section h2 { margin: 0 0 0.3em; color: #0f3460; border-bottom: 2px solid #e8ecf1; padding-bottom: 0.5em; }
section h3 { margin: 1em 0 0.5em; color: #333; }
.ranking { background: #f8faff; border: 1px solid #dde5f0; border-radius: 8px; padding: 1em; margin: 1em 0; }
.rank-subtitle { font-size: 0.8em; font-weight: normal; color: #888; }
.rank-table { width: 100%; border-collapse: collapse; margin: 0.5em 0; }
.rank-table th { text-align: left; padding: 8px 12px; border-bottom: 2px solid #ddd; font-weight: 600; color: #555; font-size: 0.85em; text-transform: uppercase; }
.rank-table td { padding: 10px 12px; border-bottom: 1px solid #eee; }
.rank-1 { background: #fffde7; }
.rank-2 { background: #f5f5f5; }
.rank-3 { background: #fff3e0; }
.rank-badge { font-size: 1.2em; text-align: center; width: 40px; }
.num-highlight { font-size: 1.1em; font-weight: 700; color: #0f3460; }
.chart-container { position: relative; height: 300px; margin: 1em 0; }
.detail-table { width: 100%; border-collapse: collapse; font-size: 0.9em; }
.detail-table th { text-align: left; padding: 8px 10px; background: #f0f4f8; border-bottom: 2px solid #dde5f0; font-weight: 600; color: #555; font-size: 0.85em; }
.detail-table td { padding: 8px 10px; border-bottom: 1px solid #eee; }
.detail-table tr:hover td { background: #f8faff; }
.rps-bar-cell { display: flex; align-items: center; gap: 8px; }
.rps-bar { height: 16px; background: linear-gradient(90deg, #4caf50, #81c784); border-radius: 3px; min-width: 2px; transition: width 0.3s; }
.meta { background: #fff; border-radius: 10px; padding: 1em 1.5em; margin: 1em 0; box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
.meta dt { font-weight: 600; margin-top: 0.5em; color: #555; }
.meta dd { margin-left: 1em; color: #777; }
footer { text-align: center; padding: 2em; color: #aaa; font-size: 0.85em; }
</style>
</head>
<body>

<div class="header">
  <h1>🏗️ Gateway Benchmark Report</h1>
  <p>Machine: <strong>${esc(machine)}</strong> — ${allRecords.length} data points across ${scenarios.length} scenarios · ${impls.length} implementations</p>
</div>

<div class="container">

<div class="meta">
  <dl>
    <dt>Machine</dt><dd>${esc(machine)}</dd>
    <dt>Results directory</dt><dd>${esc(resultsDir)}</dd>
    <dt>Generated</dt><dd>${new Date().toISOString()}</dd>
    <dt>Implementations</dt><dd>${impls.map(i => esc(i)).join(', ')}</dd>
    <dt>Scenarios</dt><dd>${scenarioNames.join(', ')}</dd>
    <dt>Total records</dt><dd>${allRecords.length}</dd>
    <dt>Methodology</dt><dd>Per BENCHMARK_SPEC.md — median of runs, warm-up excluded, min/max retained. Cross-machine comparison not applicable.</dd>
  </dl>
</div>

${renderSummaryCards(allRecords)}

<div class="toc">
  <h2>📋 Scenarios</h2>
  <ul>${tableOfContents}</ul>
</div>

${bodyHtml}

<h2 style="color:#0f3460;margin-top:2em">📌 Known Limitations</h2>
<div class="meta">
<ul>
  <li><strong>Single-machine self-pressure:</strong> k6 and gateway on same machine may reduce absolute RPS. Relative comparisons remain valid.</li>
  <li><strong>CPU/MEM/GC data</strong> depend on monitoring pipeline not yet attached.</li>
  <li><strong>Cross-machine reports</strong> are independent; compare trends not absolute values across machines.</li>
  <li><strong>N/A scenarios</strong> marked with — indicate environment constraints (e.g., no Node on xyz-mac, H4 upload timeout).</li>
</ul>
</div>

</div>

<footer>
  <p>Generated by gatebench-lab <code>generate-report.ts</code> on ${new Date().toISOString()}</p>
</footer>

</body>
</html>`;

  const reportPath = path.join(resultsDir, 'report.html');
  fs.writeFileSync(reportPath, html);
  console.log(`Report generated at: ${reportPath}`);
  console.log(`  Scenarios: ${scenarios.length}`);
  console.log(`  Total records: ${allRecords.length}`);
}

main();
