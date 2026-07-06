/**
 * combine-reports.ts
 *
 * Usage: npx ts-node combine-reports.ts <results-dir-1> <results-dir-2> ...
 *
 * Reads normalized data from MULTIPLE result directories,
 * merges into ONE master report with all scenarios × implementations.
 * Missing combos shown as — (grey).
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

// ---------------------------------------------------------------------------
// Load all normalized data from multiple dirs
// ---------------------------------------------------------------------------

function loadAllRecords(resultDirs: string[]): NormalizedRecord[] {
  const all: NormalizedRecord[] = [];
  for (const dir of resultDirs) {
    const normalizedDir = path.join(dir, 'normalized');
    if (!fs.existsSync(normalizedDir)) continue;
    const files = fs.readdirSync(normalizedDir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      const data = JSON.parse(fs.readFileSync(path.join(normalizedDir, file), 'utf-8'));
      for (const rec of data.records as NormalizedRecord[]) {
        // Add machine info from notes if not set
        if (!rec.machine) {
          const dirName = path.basename(dir);
          rec.machine = dirName.replace(/^\d{4}-\d{2}-\d{2}-?/, '') || dirName;
        }
        all.push(rec);
      }
    }
  }
  return all;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function esc(s: string | number): string {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function fmt(v: number, d = 2): string {
  return v.toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(v) ? 0 : d, maximumFractionDigits: d });
}

const COLORS: Record<string, string> = {
  rust: '#b33dc6', go: '#00add8', node: '#68a063', python: '#306998',
  'upstream-direct': '#888',
};

function implColor(impl: string, i: number): string {
  return COLORS[impl] || ['#e6194b','#3cb44b','#ffe119','#4363d8','#f58231','#911eb4','#42d4f4'][i % 7];
}

function na(): string {
  return '<td class="na">—</td>';
}

function cell(v: string | number, cls = ''): string {
  return `<td class="${cls}">${esc(v)}</td>`;
}

// ---------------------------------------------------------------------------
// Master Report
// ---------------------------------------------------------------------------

function main() {
  const resultDirs = process.argv.slice(2);
  if (resultDirs.length === 0) {
    console.error('Usage: npx ts-node combine-reports.ts <results-dir-1> <results-dir-2> ...');
    console.error('  Combines all normalized data into one master report.');
    process.exit(1);
  }

  const allRecords = loadAllRecords(resultDirs);
  console.log(`Loaded ${allRecords.length} records from ${resultDirs.length} directories`);

  if (allRecords.length === 0) {
    console.error('No records loaded. Check that directories contain normalized/*.json');
    process.exit(1);
  }

  // Enumerate all scenarios, implementations, concurrencies
  const allScenarios = [...new Set(allRecords.map(r => r.scenario))].sort();
  const allImpls = [...new Set(allRecords.map(r => r.impl))].sort();
  const allConcurrencies = [...new Set(allRecords.map(r => r.concurrency))].sort((a, b) => a - b);
  const allMachines = [...new Set(allRecords.map(r => r.machine))];

  // Build lookup: key = `${impl}|${scenario}|${concurrency}`
  const lookup = new Map<string, NormalizedRecord>();
  for (const r of allRecords) {
    const key = `${r.impl}|${r.scenario}|${r.concurrency}`;
    // If multiple records for same key (different machines), keep the one with highest RPS
    const existing = lookup.get(key);
    if (!existing || r.rps.median > existing.rps.median) {
      lookup.set(key, r);
    }
  }
  // Also store machine info per key for annotation
  const machineLookup = new Map<string, string[]>();
  for (const r of allRecords) {
    const key = `${r.impl}|${r.scenario}|${r.concurrency}`;
    if (!machineLookup.has(key)) machineLookup.set(key, []);
    machineLookup.get(key)!.push(r.machine);
  }

  // Best RPS per scenario (for bar scaling)
  const bestRps: Record<string, number> = {};
  for (const s of allScenarios) {
    bestRps[s] = Math.max(...allRecords.filter(r => r.scenario === s).map(r => r.rps.median));
  }

  // Best RPS across all scenarios (for overall peak)
  const globalPeakRps = Math.max(...allRecords.map(r => r.rps.median));
  const globalPeakImpl = allRecords.find(r => r.rps.median === globalPeakRps)?.impl || '?';

  // ── Build HTML ──
  // Title: "Master Benchmark Report" with counts
  const machineList = [...new Set(allRecords.map(r => r.machine))].join(', ');

  // Summary cards
  const summaryCards = `
    <div class="card"><span class="card-num">${allImpls.length}</span><span class="card-label">Implementations</span></div>
    <div class="card"><span class="card-num">${allScenarios.length}</span><span class="card-label">Scenarios</span></div>
    <div class="card"><span class="card-num">${allRecords.length}</span><span class="card-label">Data Points</span></div>
    <div class="card"><span class="card-num">${fmt(globalPeakRps)}</span><span class="card-label">Peak RPS (${esc(globalPeakImpl)})</span></div>
  `;

  // ── Master Matrix Table ──
  // Rows = implementations, Columns = scenario+concurrency
  let matrixHtml = `<h2>📊 Full Coverage Matrix</h2>
<p style="color:#888;margin:-0.5em 0 1em">Cells show RPS. Grey — = untested. Machine annotation in parentheses.</p>
<div style="overflow-x:auto"><table class="matrix-table">
<thead><tr>
  <th>Implementation</th>`;
  for (const s of allScenarios) {
    for (const c of allConcurrencies) {
      matrixHtml += `<th>${s}<br><small>c=${c}</small></th>`;
    }
  }
  matrixHtml += `</tr></thead><tbody>`;

  for (const impl of allImpls) {
    matrixHtml += `<tr><td><strong>${esc(impl)}</strong></td>`;
    for (const s of allScenarios) {
      for (const c of allConcurrencies) {
        const key = `${impl}|${s}|${c}`;
        const rec = lookup.get(key);
        if (rec) {
          const pct = bestRps[s] > 0 ? (rec.rps.median / bestRps[s] * 100) : 0;
          const machines = machineLookup.get(key) || [];
          const machineNote = [...new Set(machines)].join('/');
          matrixHtml += `<td>
            <div class="rps-bar-cell">
              <div class="rps-bar" style="width:${Math.max(pct, 1)}%"></div>
              <span>${fmt(rec.rps.median)}</span>
            </div>
            <span class="machine-tag">${esc(machineNote)}</span>
          </td>`;
        } else {
          matrixHtml += na();
        }
      }
    }
    matrixHtml += '</tr>';
  }
  matrixHtml += '</tbody></table></div>';

  // ── Ranking Charts (highest concurrency only) ──
  const bestConc = allConcurrencies[allConcurrencies.length - 1];
  let rankingHtml = `<h2>🏆 Rankings at c=${bestConc} (highest concurrency)</h2>`;

  for (const s of allScenarios) {
    const ranked = allRecords
      .filter(r => r.scenario === s && r.concurrency === bestConc)
      .sort((a, b) => b.rps.median - a.rps.median);

    if (ranked.length === 0) continue;

    rankingHtml += `<div class="ranking">
      <h3>${esc(s)} <span class="rank-subtitle">sorted by RPS ↓</span></h3>
      <table class="rank-table">
        <thead><tr><th>Rank</th><th>Implementation</th><th>RPS</th><th>P95 (ms)</th><th>P99 (ms)</th><th>Error %</th><th>Machine</th></tr></thead>
        <tbody>`;
    ranked.forEach((r, i) => {
      const rankClass = i === 0 ? 'rank-1' : i === 1 ? 'rank-2' : i === 2 ? 'rank-3' : '';
      rankingHtml += `<tr class="${rankClass}">
        <td class="rank-badge">${i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `#${i + 1}`}</td>
        <td><strong>${esc(r.impl)}</strong></td>
        <td class="num-highlight">${fmt(r.rps.median)}</td>
        <td>${fmt(r.latency_ms.p95.median, 1)}</td>
        <td>${fmt(r.latency_ms.p99.median, 1)}</td>
        <td>${r.error_rate.median > 0 ? (r.error_rate.median * 100).toFixed(1) + '%' : '0%'}</td>
        <td>${esc(r.machine)}</td>
      </tr>`;
    });
    rankingHtml += `</tbody></table></div>`;
  }

  // ── Detailed Tables per Scenario ──
  let detailHtml = `<h2>📋 Detailed Results by Scenario</h2>`;
  for (const s of allScenarios) {
    const recs = allRecords.filter(r => r.scenario === s);
    const implsInScene = [...new Set(recs.map(r => r.impl))].sort();
    detailHtml += `<h3>${esc(s)}</h3>
    <div style="overflow-x:auto"><table class="detail-table">
      <thead><tr>
        <th>Implementation</th><th>c</th><th>RPS</th><th>MB/s</th>
        <th>P50 (ms)</th><th>P95 (ms)</th><th>P99 (ms)</th><th>Error %</th><th>Machine</th>
      </tr></thead><tbody>`;
    const sceneBestRps = Math.max(...recs.map(r => r.rps.median));
    for (const impl of implsInScene) {
      for (const c of allConcurrencies) {
        const r = recs.find(rec => rec.impl === impl && rec.concurrency === c);
        if (!r) continue;
        const pct = sceneBestRps > 0 ? (r.rps.median / sceneBestRps * 100) : 0;
        detailHtml += `<tr>
          <td><strong>${esc(impl)}</strong></td>
          <td>${c}</td>
          <td><div class="rps-bar-cell"><div class="rps-bar" style="width:${Math.max(pct,1)}%"></div><span>${fmt(r.rps.median)}</span></div></td>
          <td>${fmt(r.throughput_mbps.median, 1)}</td>
          <td>${fmt(r.latency_ms.p50.median, 1)}</td>
          <td>${fmt(r.latency_ms.p95.median, 1)}</td>
          <td>${fmt(r.latency_ms.p99.median, 1)}</td>
          <td>${r.error_rate.median > 0 ? (r.error_rate.median * 100).toFixed(2) + '%' : '0%'}</td>
          <td>${esc(r.machine)}</td>
        </tr>`;
      }
    }
    detailHtml += `</tbody></table></div>`;
  }

  // ── Chart.js Master Charts ──
  // One set of bar charts per scenario
  let chartHtml = `<h2>📈 Visual Comparison</h2>`;
  for (const s of allScenarios) {
    const recs = allRecords.filter(r => r.scenario === s);
    const implsInScene = [...new Set(recs.map(r => r.impl))].sort();
    const concurrenciesInScene = [...new Set(recs.map(r => r.concurrency))].sort((a, b) => a - b);

    const chartId = `master-chart-${s}`;
    const labels = concurrenciesInScene.map(c => `c=${c}`);
    const datasets = implsInScene.map((impl, idx) => ({
      label: impl,
      data: concurrenciesInScene.map(c => recs.find(r => r.impl === impl && r.concurrency === c)?.rps.median ?? 0),
      color: implColor(impl, idx),
    }));

    chartHtml += `<h3>${esc(s)} — RPS</h3>
    <div class="chart-container"><canvas id="${chartId}"></canvas></div>
    <script>
    new Chart(document.getElementById('${chartId}'), {
      type: 'bar',
      data: {
        labels: ${JSON.stringify(labels)},
        datasets: [${datasets.map(d => `{
          label: '${d.label}',
          data: ${JSON.stringify(d.data)},
          backgroundColor: '${d.color}44',
          borderColor: '${d.color}',
          borderWidth: 2,
          borderRadius: 4,
        }`).join(',')}]
      },
      options: {
        responsive: true,
        plugins: { title: { display: false }, legend: { position: 'bottom' } },
        scales: { y: { beginAtZero: true, title: { display: true, text: 'Requests/sec' } }, x: { grid: { display: false } } }
      }
    });
    </script>`;

    // Latency charts
    for (const metric of ['p95', 'p99'] as const) {
      const latId = `master-${s}-${metric}`;
      const latDatasets = implsInScene.map((impl, idx) => ({
        label: impl,
        data: concurrenciesInScene.map(c => {
          const r = recs.find(rec => rec.impl === impl && rec.concurrency === c);
          return r ? r.latency_ms[metric].median : 0;
        }),
        color: implColor(impl, idx),
      }));
      chartHtml += `<h3>${esc(s)} — P${metric.toUpperCase()} Latency</h3>
      <div class="chart-container"><canvas id="${latId}"></canvas></div>
      <script>
      new Chart(document.getElementById('${latId}'), {
        type: 'bar',
        data: {
          labels: ${JSON.stringify(labels)},
          datasets: [${latDatasets.map(d => `{
            label: '${d.label}',
            data: ${JSON.stringify(d.data)},
            backgroundColor: '${d.color}44',
            borderColor: '${d.color}',
            borderWidth: 2,
            borderRadius: 4,
          }`).join(',')}]
        },
        options: {
          responsive: true,
          plugins: { title: { display: false }, legend: { position: 'bottom' } },
          scales: { y: { beginAtZero: true, title: { display: true, text: 'ms' } }, x: { grid: { display: false } } }
        }
      });
      </script>`;
    }
  }

  // ── Machine Legend ──
  const machineLegend = [...new Set(allRecords.map(r => `${r.machine}`))].join(', ');

  // ── Assembly ──
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Gateway Master Benchmark Report</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"></script>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 0; background: #f5f7fa; color: #1a1a2e; }
.header { background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%); color: #fff; padding: 2em 1.5em; }
.header h1 { margin: 0; font-size: 2em; }
.header p { opacity: 0.8; margin: 0.3em 0 0; }
.container { max-width: 1400px; margin: 0 auto; padding: 1.5em; }
.card { background: #fff; border-radius: 10px; padding: 1em 1.5em; min-width: 120px; box-shadow: 0 2px 8px rgba(0,0,0,0.06); text-align: center; flex: 1; }
.card-num { display: block; font-size: 1.8em; font-weight: 700; color: #0f3460; }
.card-label { font-size: 0.8em; color: #888; text-transform: uppercase; letter-spacing: 0.5px; }
section { background: #fff; border-radius: 10px; padding: 1.5em; margin: 1.5em 0; box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
h2 { color: #0f3460; border-bottom: 2px solid #e8ecf1; padding-bottom: 0.5em; margin-top: 2em; }
h3 { color: #333; margin: 1em 0 0.5em; }
.ranking { background: #f8faff; border: 1px solid #dde5f0; border-radius: 8px; padding: 1em; margin: 1em 0; }
.rank-subtitle { font-size: 0.8em; font-weight: normal; color: #888; }
.rank-table { width: 100%; border-collapse: collapse; }
.rank-table th { text-align: left; padding: 8px 12px; border-bottom: 2px solid #ddd; font-weight: 600; color: #555; font-size: 0.85em; }
.rank-table td { padding: 10px 12px; border-bottom: 1px solid #eee; }
.rank-1 { background: #fffde7; } .rank-2 { background: #f5f5f5; } .rank-3 { background: #fff3e0; }
.rank-badge { font-size: 1.2em; text-align: center; width: 40px; }
.num-highlight { font-size: 1.1em; font-weight: 700; color: #0f3460; }
.chart-container { position: relative; height: 300px; margin: 1em 0; }
.matrix-table { width: 100%; border-collapse: collapse; font-size: 0.85em; }
.matrix-table th { text-align: center; padding: 8px; background: #f0f4f8; border-bottom: 2px solid #dde5f0; font-weight: 600; color: #555; vertical-align: bottom; }
.matrix-table td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #eee; min-width: 100px; }
.matrix-table tr:hover td { background: #f8faff; }
.machine-tag { font-size: 0.7em; color: #aaa; display: block; }
.na { text-align: center !important; color: #ddd; font-size: 1.2em; background: #fafafa; }
.detail-table { width: 100%; border-collapse: collapse; font-size: 0.88em; }
.detail-table th { text-align: left; padding: 8px 10px; background: #f0f4f8; border-bottom: 2px solid #dde5f0; font-weight: 600; color: #555; font-size: 0.85em; }
.detail-table td { padding: 6px 10px; border-bottom: 1px solid #eee; }
.detail-table tr:hover td { background: #f8faff; }
.rps-bar-cell { display: flex; align-items: center; gap: 6px; }
.rps-bar { height: 14px; background: linear-gradient(90deg, #4caf50, #81c784); border-radius: 3px; min-width: 2px; }
.meta { background: #fff; border-radius: 10px; padding: 1em 1.5em; margin: 1em 0; box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
.meta dt { font-weight: 600; margin-top: 0.5em; color: #555; }
.meta dd { margin-left: 1em; color: #777; }
.na-legend { background: #fafafa; color: #ddd; padding: 0.5em 1em; border-radius: 6px; display: inline-block; font-size: 0.85em; }
footer { text-align: center; padding: 2em; color: #aaa; font-size: 0.85em; }
</style>
</head>
<body>
<div class="header">
  <h1>🏗️ Gateway Master Benchmark Report</h1>
  <p>${allRecords.length} data points · ${allImpls.length} implementations · ${allScenarios.length} scenarios · Machines: ${esc(machineLegend)}</p>
</div>
<div class="container">
<div class="meta">
  <dl>
    <dt>Implementations</dt><dd>${allImpls.map(i => esc(i)).join(', ')}</dd>
    <dt>Scenarios</dt><dd>${allScenarios.join(', ')}</dd>
    <dt>Concurrency levels</dt><dd>${allConcurrencies.join(', ')}</dd>
    <dt>Machines</dt><dd>${esc(machineLegend)}</dd>
    <dt>Methodology</dt><dd>Per BENCHMARK_SPEC. Grey — = not tested on that combination. Cross-machine comparisons are trends only.</dd>
  </dl>
</div>
<div style="display:flex;flex-wrap:wrap;gap:12px;margin:1em 0">${summaryCards}</div>
<div class="na-legend">— = Not tested (machine limitation, skipped, or pending)</div>

${matrixHtml}
${rankingHtml}
${chartHtml}
${detailHtml}

<h2>📌 Known Limitations</h2>
<div class="meta">
<ul>
  <li><strong>H4 (10MB upload):</strong> Timed out in k6 init phase. Requires more memory or shorter payload.</li>
  <li><strong>Gaps in matrix:</strong> Node not tested on xyz-mac (no Node.js), Rust not tested on local Mac (cross-compile only).</li>
  <li><strong>Same-machine self-pressure:</strong> Local MacBook-Pro runs have k6 and gateway competing for CPU.</li>
  <li><strong>Nginx baseline:</strong> Not yet configured. upstream-direct is the current baseline.</li>
</ul>
</div>
</div>
<footer>Generated by gatebench-lab combine-reports.ts on ${new Date().toISOString()}</footer>
</body>
</html>`;

  // Write to current directory as master report
  const outputPath = path.join(process.cwd(), '..', 'results', 'MASTER-REPORT.html');
  fs.writeFileSync(outputPath, html);
  console.log(`✅ Master report: ${outputPath}`);
  console.log(`   ${allRecords.length} records from ${resultDirs.length} directories`);
  console.log(`   ${allImpls.length} implementations × ${allScenarios.length} scenarios × ${allConcurrencies.length} concurrency levels`);

  // Print coverage gaps
  for (const impl of allImpls) {
    for (const s of allScenarios) {
      for (const c of allConcurrencies) {
        const key = `${impl}|${s}|${c}`;
        if (!lookup.has(key)) {
          console.log(`   ⬜ Missing: ${impl} × ${s} × c=${c}`);
        }
      }
    }
  }
}

main();
