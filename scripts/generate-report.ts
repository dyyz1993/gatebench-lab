/**
 * generate-report.ts
 *
 * Usage: npx ts-node generate-report.ts <results-dir>
 *
 * Reads normalized/*.json files from a results directory (e.g.
 * results/2026-07-06-xyz-mac/), generates a self-contained HTML report
 * with comparison tables, latency breakdowns, and bar charts.
 *
 * The report groups data by scenario, then presents:
 *   - RPS comparison table (impl rows × concurrency cols)
 *   - P95/P99 latency tables
 *   - Visual bar charts for RPS comparison
 *   - Environment and notes section
 */

import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StatPoint {
  median: number;
  min: number;
  max: number;
}

interface NormalizedRecord {
  impl: string;
  variant: string;
  scenario: string;
  machine: string;
  concurrency: number;
  duration_sec: number;
  runs: number;
  rps: StatPoint;
  throughput_mbps: StatPoint;
  latency_ms: {
    p50: StatPoint;
    p95: StatPoint;
    p99: StatPoint;
  };
  error_rate: StatPoint;
  cpu_avg_pct: StatPoint;
  mem_rss_mb: StatPoint;
  gc_pause_ms: StatPoint;
  open_fds: StatPoint;
  notes: string;
}

interface ScenarioFile {
  scenario: string;
  records: NormalizedRecord[];
}

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

function escapeHtml(s: string | number): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmt(v: number, decimals = 2): string {
  if (Number.isInteger(v)) return v.toLocaleString('en-US');
  return v.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** Build a CSS bar element representing value relative to max. */
function bar(value: number, max: number, color = '#4caf50'): string {
  const pct = max > 0 ? (value / max) * 100 : 0;
  return `<span class="bar" style="width:${Math.max(pct, 1)}%;background:${color}"></span>${fmt(value)}`;
}

// ---------------------------------------------------------------------------
// Table builders
// ---------------------------------------------------------------------------

interface TableColumn {
  label: string;
  key: string;
}

/**
 * Build a pivoted table: impl × concurrency, cell shows the selected metric.
 */
function buildPivotTable(
  records: NormalizedRecord[],
  concurrencyLevels: number[],
  implList: string[],
  getValue: (r: NormalizedRecord) => string,
  getBar: ((r: NormalizedRecord, maxVal: number) => string) | null,
): string {
  // Compute max for bar scaling
  let maxVal = 0;
  if (getBar) {
    for (const r of records) {
      const v = parseFloat(getValue(r).replace(/,/g, ''));
      if (v > maxVal) maxVal = v;
    }
  }

  let html = '<table><thead><tr><th>Implementation</th>';
  for (const c of concurrencyLevels) {
    html += `<th>c=${c}</th>`;
  }
  html += '</tr></thead><tbody>';

  for (const impl of implList) {
    html += `<tr><td><strong>${escapeHtml(impl)}</strong></td>`;
    for (const c of concurrencyLevels) {
      const rec = records.find(r => r.impl === impl && r.concurrency === c);
      if (rec) {
        const val = getValue(rec);
        if (getBar && maxVal > 0) {
          const numVal = parseFloat(val.replace(/,/g, ''));
          html += `<td>${bar(numVal, maxVal)}</td>`;
        } else {
          html += `<td>${val}</td>`;
        }
      } else {
        html += '<td>—</td>';
      }
    }
    html += '</tr>';
  }

  html += '</tbody></table>';
  return html;
}

/**
 * Build a per-impl-row, concurrency-column table for a latency metric (p50/p95/p99).
 * Shows "median (min-max)" format.
 */
function buildLatencyTable(
  records: NormalizedRecord[],
  concurrencyLevels: number[],
  implList: string[],
  getLatency: (r: NormalizedRecord) => StatPoint,
): string {
  let html = '<table><thead><tr><th>Implementation</th>';
  for (const c of concurrencyLevels) {
    html += `<th>c=${c}</th>`;
  }
  html += '</tr></thead><tbody>';

  for (const impl of implList) {
    html += `<tr><td><strong>${escapeHtml(impl)}</strong></td>`;
    for (const c of concurrencyLevels) {
      const rec = records.find(r => r.impl === impl && r.concurrency === c);
      if (rec) {
        const lt = getLatency(rec);
        html += `<td>${fmt(lt.median, 1)} <span class="range">(${fmt(lt.min, 1)}–${fmt(lt.max, 1)})</span></td>`;
      } else {
        html += '<td>—</td>';
      }
    }
    html += '</tr>';
  }

  html += '</tbody></table>';
  return html;
}

/**
 * Build a combined variants table (streaming vs buffered) for H4/H6/H7.
 */
function buildVariantsTable(records: NormalizedRecord[]): string {
  // Group by (impl, concurrency) and show streaming vs buffered side by side
  const groups = new Map<string, { impl: string; concurrency: number; buffered?: NormalizedRecord; streaming?: NormalizedRecord }>();
  for (const r of records) {
    if (r.variant !== 'buffered' && r.variant !== 'streaming') continue;
    const key = `${r.impl}|${r.concurrency}`;
    if (!groups.has(key)) {
      groups.set(key, { impl: r.impl, concurrency: r.concurrency });
    }
    const g = groups.get(key)!;
    if (r.variant === 'buffered') g.buffered = r;
    if (r.variant === 'streaming') g.streaming = r;
  }

  let html = `<table>
<thead>
  <tr>
    <th>Implementation</th>
    <th>Concurrency</th>
    <th colspan="2">RPS</th>
    <th colspan="2">P95 Latency (ms)</th>
    <th colspan="2">P99 Latency (ms)</th>
  </tr>
  <tr>
    <th></th><th></th>
    <th>Buffered</th><th>Streaming</th>
    <th>Buffered</th><th>Streaming</th>
    <th>Buffered</th><th>Streaming</th>
  </tr>
</thead>
<tbody>`;

  const sorted = [...groups.values()].sort((a, b) => {
    if (a.impl !== b.impl) return a.impl.localeCompare(b.impl);
    return a.concurrency - b.concurrency;
  });

  for (const g of sorted) {
    html += `<tr>
      <td><strong>${escapeHtml(g.impl)}</strong></td>
      <td>${g.concurrency}</td>
      <td>${g.buffered ? fmt(g.buffered.rps.median) : '—'}</td>
      <td>${g.streaming ? fmt(g.streaming.rps.median) : '—'}</td>
      <td>${g.buffered ? fmt(g.buffered.latency_ms.p95.median, 1) : '—'}</td>
      <td>${g.streaming ? fmt(g.streaming.latency_ms.p95.median, 1) : '—'}</td>
      <td>${g.buffered ? fmt(g.buffered.latency_ms.p99.median, 1) : '—'}</td>
      <td>${g.streaming ? fmt(g.streaming.latency_ms.p99.median, 1) : '—'}</td>
    </tr>`;
  }

  html += '</tbody></table>';
  return html;
}

// ---------------------------------------------------------------------------
// Scenario report
// ---------------------------------------------------------------------------

function renderScenarioSection(scenario: string, records: NormalizedRecord[]): string {
  const isVariantScenario = ['H4', 'H6', 'H7'].includes(scenario) ||
    records.some(r => r.variant === 'buffered' || r.variant === 'streaming');

  // Collect unique concurrency levels and impls
  const concurrencyLevels = [...new Set(records.map(r => r.concurrency))].sort((a, b) => a - b);
  const implList = [...new Set(records.map(r => r.impl))].sort();

  const variantRecords = isVariantScenario
    ? records.filter(r => r.variant === 'buffered' || r.variant === 'streaming')
    : [];
  const standardRecords = isVariantScenario
    ? records.filter(r => r.variant === 'n/a' || (!r.variant || r.variant === ''))
    : records;

  let html = `<section id="scenario-${scenario}">
<h2>Scenario: ${escapeHtml(scenario)}</h2>
<p>${records.length} record(s), ${concurrencyLevels.length} concurrency level(s), ${implList.length} implementation(s)</p>
`;

  // Variants comparison (H4/H6/H7)
  if (variantRecords.length > 0) {
    html += `<h3>Streaming vs Buffered</h3>
<p>Comparison of <code>buffered</code> (full in-memory) vs <code>streaming</code> (chunked) variants.</p>`;
    html += buildVariantsTable(variantRecords);
  }

  const activeRecords = standardRecords.length > 0 ? standardRecords : records;

  // --- RPS table ---
  html += `<h3>Throughput (RPS) — Higher is better</h3>`;
  html += buildPivotTable(
    activeRecords,
    concurrencyLevels,
    implList,
    (r) => fmt(r.rps.median),
    (r, maxVal) => bar(r.rps.median, maxVal),
  );

  // --- P50 Latency table ---
  html += `<h3>P50 Latency (ms) — Lower is better</h3>`;
  html += buildLatencyTable(activeRecords, concurrencyLevels, implList, (r) => r.latency_ms.p50);

  // --- P95 Latency table ---
  html += `<h3>P95 Latency (ms) — Lower is better</h3>`;
  html += buildLatencyTable(activeRecords, concurrencyLevels, implList, (r) => r.latency_ms.p95);

  // --- P99 Latency table ---
  html += `<h3>P99 Latency (ms) — Lower is better</h3>`;
  html += buildLatencyTable(activeRecords, concurrencyLevels, implList, (r) => r.latency_ms.p99);

  // --- Error rate table ---
  html += `<h3>Error Rate — Lower is better</h3>`;
  html += buildPivotTable(
    activeRecords,
    concurrencyLevels,
    implList,
    (r) => (r.error_rate.median * 100).toFixed(3) + '%',
    null,
  );

  // --- CPU / Memory table (if data available) ---
  const hasCpu = activeRecords.some(r => r.cpu_avg_pct.median > 0);
  const hasMem = activeRecords.some(r => r.mem_rss_mb.median > 0);
  if (hasCpu || hasMem) {
    html += `<h3>Resource Usage</h3>`;
    if (hasCpu) {
      html += `<h4>CPU (% × cores)</h4>`;
      html += buildPivotTable(
        activeRecords,
        concurrencyLevels,
        implList,
        (r) => fmt(r.cpu_avg_pct.median, 0),
        null,
      );
    }
    if (hasMem) {
      html += `<h4>Memory RSS (MB)</h4>`;
      html += buildPivotTable(
        activeRecords,
        concurrencyLevels,
        implList,
        (r) => fmt(r.mem_rss_mb.median, 0),
        null,
      );
    }
  }

  // --- GC pause table (if data available) ---
  const hasGc = activeRecords.some(r => r.gc_pause_ms.median > 0);
  if (hasGc) {
    html += `<h4>GC Pause (ms)</h4>`;
    html += buildPivotTable(
      activeRecords,
      concurrencyLevels,
      implList,
      (r) => fmt(r.gc_pause_ms.median, 2),
      null,
    );
  }

  // --- Notes per record ---
  const noted = activeRecords.filter(r => r.notes);
  if (noted.length > 0) {
    html += `<h3>Notes</h3><ul>`;
    for (const r of noted) {
      html += `<li><strong>${escapeHtml(r.impl)} @ c=${r.concurrency}:</strong> ${escapeHtml(r.notes)}</li>`;
    }
    html += '</ul>';
  }

  html += '</section>';
  return html;
}

// ---------------------------------------------------------------------------
// Main render function
// ---------------------------------------------------------------------------

const CSS = `
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen,
    Ubuntu, Cantarell, 'Helvetica Neue', sans-serif;
  margin: 2em auto;
  max-width: 1200px;
  padding: 0 1em;
  color: #1a1a1a;
  background: #fafafa;
}
h1 { font-size: 1.8em; border-bottom: 2px solid #333; padding-bottom: 0.3em; }
h2 { font-size: 1.4em; margin-top: 2em; color: #2c3e50; border-bottom: 1px solid #ddd; padding-bottom: 0.2em; }
h3 { font-size: 1.1em; margin-top: 1.5em; color: #34495e; }
h4 { font-size: 1em; margin-top: 1em; color: #555; }
table {
  border-collapse: collapse;
  margin: 0.8em 0 1.5em;
  width: 100%;
  font-size: 0.9em;
  background: #fff;
  box-shadow: 0 1px 3px rgba(0,0,0,0.08);
}
th, td {
  border: 1px solid #d0d0d0;
  padding: 8px 12px;
  text-align: right;
  white-space: nowrap;
}
th {
  background: #f0f4f8;
  font-weight: 600;
  color: #2c3e50;
}
td:first-child, th:first-child {
  text-align: left;
}
tr:nth-child(even) td {
  background: #f8f9fa;
}
tr:hover td {
  background: #eef3f7;
}
.bar-wrapper {
  display: flex;
  align-items: center;
  gap: 6px;
}
.bar {
  display: inline-block;
  height: 18px;
  border-radius: 3px;
  vertical-align: middle;
  transition: width 0.2s;
  min-width: 2px;
}
.range {
  color: #888;
  font-size: 0.85em;
}
.meta {
  background: #fff;
  border: 1px solid #ddd;
  border-radius: 6px;
  padding: 1em 1.5em;
  margin: 1em 0;
}
.meta dt { font-weight: 600; margin-top: 0.5em; }
.meta dd { margin-left: 1em; color: #555; }
footer {
  margin-top: 3em;
  padding-top: 1em;
  border-top: 1px solid #ddd;
  font-size: 0.85em;
  color: #888;
}
.summary-card {
  display: inline-block;
  background: #fff;
  border: 1px solid #ddd;
  border-radius: 6px;
  padding: 0.8em 1.2em;
  margin: 0.3em;
  text-align: center;
}
.summary-card .num { font-size: 1.6em; font-weight: 700; color: #2c3e50; display: block; }
.summary-card .label { font-size: 0.8em; color: #888; }
`.trim();

function renderHTML(
  scenarioRecords: Map<string, NormalizedRecord[]>,
  machine: string,
  resultsDir: string,
): string {
  const now = new Date().toISOString();

  // Gather global stats
  let totalRecords = 0;
  let totalScenarios = 0;
  const allImpls = new Set<string>();
  for (const [, recs] of scenarioRecords) {
    totalRecords += recs.length;
    totalScenarios++;
    for (const r of recs) allImpls.add(r.impl);
  }

  let html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Gateway Benchmark Report — ${escapeHtml(machine)}</title>
<style>${CSS}</style>
</head>
<body>

<h1>Gateway Benchmark Report</h1>

<div class="meta">
<dl>
  <dt>Machine</dt><dd>${escapeHtml(machine)}</dd>
  <dt>Results directory</dt><dd>${escapeHtml(resultsDir)}</dd>
  <dt>Generated</dt><dd>${now}</dd>
  <dt>Implementations</dt><dd>${[...allImpls].sort().join(', ')}</dd>
  <dt>Scenarios</dt><dd>${totalScenarios}</dd>
  <dt>Total records</dt><dd>${totalRecords}</dd>
  <dt>Methodology</dt><dd>Per BENCHMARK_SPEC.md — median of 5 runs, min/max retained. Warm-up 30s excluded. Cross-machine comparison not applicable.</dd>
</dl>
</div>

<h2>Executive Summary</h2>
<p>
  This report compares gateway implementations (${[...allImpls].sort().join(', ')})
  across ${totalScenarios} benchmark scenarios on machine <strong>${escapeHtml(machine)}</strong>.
  Each cell shows the median value across repeated runs, with min–max range in parentheses.
  Bar lengths are scaled relative to the best (highest RPS / lowest latency) within each table.
</p>
`;

  // Render each scenario
  for (const [scenario, records] of scenarioRecords) {
    html += renderScenarioSection(scenario, records);
  }

  html += `
<h2>Controlled Variables</h2>
<ul>
  <li>Worker count fixed to machine logical cores per BENCHMARK_SPEC §3</li>
  <li>All builds in release/production mode</li>
  <li>Dependency versions locked in env.lock</li>
  <li>Warm-up period not counted in metrics</li>
  <li>Each (impl × scenario × concurrency) run 5 times, median reported</li>
</ul>

<h2>Known Limitations</h2>
<ul>
  <li><strong>Single-machine self-pressure</strong> (if applicable): k6 and gateway share resources;
      absolute RPS values may be lower than cross-machine setup. Relative comparisons remain valid.</li>
  <li><strong>CPU/MEM/GC/FD data</strong> depend on sidecar monitoring (pidstat, /proc) and may be absent
      in early runs. These fields are filled as the monitoring pipeline matures.</li>
  <li><strong>Cross-machine comparison:</strong> Reports from different machines are independent.
      Only compare trends, not absolute values, across machines.</li>
</ul>

<footer>
<p>Generated by gatebench-lab <code>generate-report.ts</code> on ${now}</p>
<p>Source: <code>${escapeHtml(resultsDir)}</code></p>
</footer>

</body>
</html>`;

  return html;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const resultsDir = process.argv[2];
  if (!resultsDir) {
    console.error('Usage: npx ts-node generate-report.ts <results-dir>');
    process.exit(1);
  }

  const normalizedDir = path.join(resultsDir, 'normalized');
  if (!fs.existsSync(normalizedDir)) {
    console.error(`Error: normalized/ directory not found at ${normalizedDir}`);
    console.error('Run normalize-results.ts first to generate normalized data.');
    process.exit(1);
  }

  const files = fs.readdirSync(normalizedDir).filter(f => f.endsWith('.json'));
  if (files.length === 0) {
    console.error('Error: no JSON files found in normalized/ directory');
    process.exit(1);
  }

  console.log(`Reading ${files.length} normalized file(s) from ${normalizedDir}`);

  // Infer machine name
  const dirName = path.basename(resultsDir);
  const machineMatch = dirName.match(/^\d{4}-\d{2}-\d{2}-(.+)$/);
  const machine = machineMatch ? machineMatch[1] : 'unknown';

  // Read all scenario files
  const scenarioRecords = new Map<string, NormalizedRecord[]>();
  for (const file of files) {
    const filePath = path.join(normalizedDir, file);
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const data: ScenarioFile = JSON.parse(content);
      scenarioRecords.set(data.scenario, data.records);
      console.log(`  Loaded ${data.scenario}: ${data.records.length} records`);
    } catch (err) {
      console.warn(`  Warning: skipping ${file}: ${err}`);
    }
  }

  if (scenarioRecords.size === 0) {
    console.error('No valid scenario data loaded.');
    process.exit(1);
  }

  // Generate HTML
  const html = renderHTML(scenarioRecords, machine, resultsDir);

  // Write report
  const reportPath = path.join(resultsDir, 'report.html');
  fs.writeFileSync(reportPath, html, 'utf-8');
  console.log(`\nReport generated at: ${reportPath}`);
  console.log(`  Scenarios: ${scenarioRecords.size}`);
  console.log(`  Total records: ${[...scenarioRecords.values()].reduce((s, r) => s + r.length, 0)}`);
}

main();
