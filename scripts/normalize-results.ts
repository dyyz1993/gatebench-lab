/**
 * normalize-results.ts
 *
 * Usage: npx ts-node normalize-results.ts <results-dir>
 *
 * Reads raw/ k6 JSON summary outputs from a results directory (e.g.
 * results/2026-07-06-xyz-mac/), parses them, groups by scenario, computes
 * median/min/max across repeated runs, and writes normalized JSON files
 * into normalized/.
 *
 * Filename pattern expected:
 *   <impl>-<scenario>-c<concurrency>-<variant>-run<N>.json
 *
 * Example:
 *   rust-H1-c100-buffered-run1.json
 *   go-H4-c500-streaming-run3.json
 */

import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface K6SummaryMetrics {
  http_reqs?: {
    type: string;
    contains: string;
    values: { rate: number; count: number };
  };
  http_req_duration?: {
    type: string;
    contains: string;
    values: {
      avg: number;
      med: number;
      max: number;
      min: number;
      [key: string]: unknown;
    };
  };
  http_req_failed?: {
    type: string;
    contains: string;
    values: { rate: number; passes: number; fails: number };
  };
  data_sent?: {
    type: string;
    contains: string;
    values: { count: number; rate: number };
  };
  data_received?: {
    type: string;
    contains: string;
    values: { count: number; rate: number };
  };
  iterations?: {
    type: string;
    contains: string;
    values: { count: number; rate: number };
  };
  vus?: {
    type: string;
    contains: string;
    values: { min: number; max: number };
  };
  // Raw k6 JSON can have metric names with dots as literal keys; some fields
  // may appear under slightly different names. We also accept flattened or
  // alternate naming (e.g. p(50) stored as "p50").
  [key: string]: unknown;
}

interface K6Summary {
  metrics: K6SummaryMetrics;
  /** Optional: top-level root_group summary */
  root_group?: {
    name: string;
    path: string;
    id: string;
    groups: unknown[];
    checks: unknown[];
  };
  /** Optional: run options snapshot */
  options?: {
    duration?: string;
    vus?: number;
    stages?: { duration: string; target: number }[];
    [key: string]: unknown;
  };
  /** Optional: environment info */
  environment?: Record<string, unknown>;
}

/** Median/min/max triplet — the core aggregation type. */
interface StatPoint {
  median: number;
  min: number;
  max: number;
}

/** A single normalized result record matching docs/RESULTS_SCHEMA.md. */
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

/** Grouped raw values before aggregation. */
interface RunGroup {
  rawRps: number[];
  rawThroughputMbps: number[];
  rawP50: number[];
  rawP95: number[];
  rawP99: number[];
  rawErrorRate: number[];
  rawCpu: number[];
  rawMem: number[];
  rawGc: number[];
  rawFds: number[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function min(values: number[]): number {
  return values.length === 0 ? 0 : Math.min(...values);
}

function max(values: number[]): number {
  return values.length === 0 ? 0 : Math.max(...values);
}

/** Safely read a numeric value from a k6 data field that may be nested. */
function numVal(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return parseFloat(v) || 0;
  return 0;
}

/** Try to extract a named sub-field from http_req_duration values. */
function extractPercentile(
  values: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  if (!values) return undefined;
  // Try dotted name first (e.g. "p(95)" in raw JSON)
  const dotted = values[key];
  if (dotted !== undefined) return numVal(dotted);
  // Try flattened name (e.g. "p95")
  const flat = values[key.replace(/[()]/g, '')];
  if (flat !== undefined) return numVal(flat);
  return undefined;
}

// ---------------------------------------------------------------------------
// Filename parsing
// ---------------------------------------------------------------------------

interface FileMeta {
  impl: string;
  scenario: string;
  concurrency: number;
  variant: string;
  run: number;
}

/**
 * Filename pattern: <impl>-<scenario>-c<concurrency>-<variant>-run<N>.json
 *
 * Examples:
 *   rust-H1-c100-buffered-run1.json
 *   go-H4-c500-streaming-run3.json
 *   node-H2-c10-n/a-run5.json          (variant "n/a" for non-streaming scenarios)
 *   python-uvicorn-H3-c1000-n/a-run2.json
 *   upstream-direct-H1-c10-n/a-run1.json
 *   nginx-H2-c100-n/a-run4.json
 *
 * Note: impl may contain hyphens (e.g. "python-uvicorn", "upstream-direct"),
 * so we need to parse from the right side anchored by known suffixes.
 */
function parseFilename(filename: string): FileMeta | null {
  const base = path.basename(filename, '.json');

  // Pattern: anchored from the right: -run<N> / -c<digits> / <variant> / <scenario> / <impl>
  // We use a regex that captures the full impl (which may include hyphens).
  // Strategy: match from the end backward.
  const match = base.match(
    /^(.+)-(\w+)-c(\d+)-(\w+)-run(\d+)$/,
  );
  if (!match) return null;

  const impl = match[1];
  const scenario = match[2];
  const concurrency = parseInt(match[3], 10);
  const variant = match[4];
  const run = parseInt(match[5], 10);

  if (isNaN(concurrency) || isNaN(run)) return null;

  return { impl, scenario, concurrency, variant, run };
}

// ---------------------------------------------------------------------------
// k6 JSON parsing
// ---------------------------------------------------------------------------

/**
 * Extract raw metric values from a k6 JSON summary output.
 *
 * Supports both k6 v1 (metrics nested in `values` field) and k6 v2 (flat).
 */
function parseK6Summary(filePath: string): {
  rps: number;
  throughputMbps: number;
  p50: number;
  p95: number;
  p99: number;
  errorRate: number;
  iterations: number;
  durationSec: number;
} {
  const content = fs.readFileSync(filePath, 'utf-8');
  const summary: K6Summary = JSON.parse(content);
  const m = summary.metrics;

  // Helper: get from values or flat
  function v(obj: Record<string, unknown> | undefined, key: string): number | undefined {
    if (!obj) return undefined;
    // Try flat key first (k6 v2)
    const flatVal = obj[key];
    if (flatVal !== undefined && typeof flatVal === 'number') return flatVal;
    // Try nested values (k6 v1): obj.values.key
    const inner = (obj as Record<string, unknown>)['values'] as Record<string, unknown> | undefined;
    if (inner) {
      const innerVal = inner[key];
      if (innerVal !== undefined && typeof innerVal === 'number') return innerVal;
    }
    return undefined;
  }

  // --- RPS ---
  const rps = v(m.http_reqs as Record<string, unknown>, 'rate') ?? 0;

  // --- Throughput ---
  const sent = v(m.data_sent as Record<string, unknown>, 'count') ?? 0;
  const recv = v(m.data_received as Record<string, unknown>, 'count') ?? 0;
  const iterCount = v(m.iterations as Record<string, unknown>, 'count') ?? 0;
  const iterRate = v(m.iterations as Record<string, unknown>, 'rate') ?? 0;
  let durationSec = 60;
  if (iterRate > 0 && iterCount > 0) {
    durationSec = iterCount / iterRate;
  } else if (rps > 0) {
    const reqCount = v(m.http_reqs as Record<string, unknown>, 'count') ?? 0;
    if (reqCount > 0) durationSec = reqCount / rps;
  }
  const totalBytes = sent + recv;
  const throughputMbps = durationSec > 0
    ? (totalBytes / durationSec) / 1_000_000
    : 0;

  // --- Latency percentiles ---
  // k6 v1: metrics.http_req_duration.values.{med, p(50), p(95), p(99)}
  // k6 v2: metrics.http_req_duration.{med, p(90), p(95)}
  // Work with the raw metric object directly
  const durRaw = m.http_req_duration as Record<string, unknown> | undefined;
  const durValues = (durRaw?.values as Record<string, unknown>) ?? durRaw ?? {};

  const p50 = extractPercentile(durValues, 'p(50)') ?? numVal(durValues['med']) ?? 0;
  const p95 = extractPercentile(durValues, 'p(95)') ?? 0;
  const p99 = extractPercentile(durValues, 'p(99)') ?? numVal(durValues['max']) ?? 0;

  // --- Error rate ---
  // k6 v1: http_req_failed.values.rate
  // k6 v2: http_req_failed.value
  const errRaw = m.http_req_failed as Record<string, unknown> | undefined;
  const errorRate = v(errRaw, 'rate') ?? numVal(errRaw?.value) ?? 0;

  return {
    rps: numVal(rps),
    throughputMbps,
    p50: numVal(p50),
    p95: numVal(p95),
    p99: numVal(p99),
    errorRate: numVal(errorRate),
    iterations: numVal(iterCount),
    durationSec: Math.round(durationSec),
  };
}

// ---------------------------------------------------------------------------
// Grouping & aggregation
// ---------------------------------------------------------------------------

interface GroupKey {
  impl: string;
  variant: string;
  scenario: string;
  machine: string;
  concurrency: number;
}

function groupKey(r: NormalizedRecord): string {
  return `${r.impl}|${r.variant}|${r.scenario}|${r.machine}|${r.concurrency}`;
}

function aggregateGroup(group: RunGroup): {
  rps: StatPoint;
  throughput_mbps: StatPoint;
  latency_ms: { p50: StatPoint; p95: StatPoint; p99: StatPoint };
  error_rate: StatPoint;
  cpu_avg_pct: StatPoint;
  mem_rss_mb: StatPoint;
  gc_pause_ms: StatPoint;
  open_fds: StatPoint;
} {
  return {
    rps: { median: median(group.rawRps), min: min(group.rawRps), max: max(group.rawRps) },
    throughput_mbps: { median: median(group.rawThroughputMbps), min: min(group.rawThroughputMbps), max: max(group.rawThroughputMbps) },
    latency_ms: {
      p50: { median: median(group.rawP50), min: min(group.rawP50), max: max(group.rawP50) },
      p95: { median: median(group.rawP95), min: min(group.rawP95), max: max(group.rawP95) },
      p99: { median: median(group.rawP99), min: min(group.rawP99), max: max(group.rawP99) },
    },
    error_rate: { median: median(group.rawErrorRate), min: min(group.rawErrorRate), max: max(group.rawErrorRate) },
    cpu_avg_pct: { median: median(group.rawCpu), min: min(group.rawCpu), max: max(group.rawCpu) },
    mem_rss_mb: { median: median(group.rawMem), min: min(group.rawMem), max: max(group.rawMem) },
    gc_pause_ms: { median: median(group.rawGc), min: min(group.rawGc), max: max(group.rawGc) },
    open_fds: { median: median(group.rawFds), min: min(group.rawFds), max: max(group.rawFds) },
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const resultsDir = process.argv[2];
  if (!resultsDir) {
    console.error('Usage: npx ts-node normalize-results.ts <results-dir>');
    console.error('  <results-dir> should contain raw/ and normalized/ subdirs');
    process.exit(1);
  }

  const rawDir = path.join(resultsDir, 'raw');
  const normalizedDir = path.join(resultsDir, 'normalized');

  // Verify raw dir exists
  if (!fs.existsSync(rawDir)) {
    console.error(`Error: raw/ directory not found at ${rawDir}`);
    process.exit(1);
  }

  fs.mkdirSync(normalizedDir, { recursive: true });

  const files = fs.readdirSync(rawDir).filter(f => f.endsWith('.json'));
  if (files.length === 0) {
    console.warn('Warning: no JSON files found in raw/ directory');
    return;
  }

  console.log(`Found ${files.length} raw result files`);

  // Infer machine name from directory path: results/<date>-<machine>/
  // e.g. results/2026-07-06-xyz-mac/ -> "xyz-mac"
  const dirName = path.basename(resultsDir);
  // Try to extract machine name after the date prefix (YYYY-MM-DD-<machine>)
  const machineMatch = dirName.match(/^\d{4}-\d{2}-\d{2}-(.+)$/);
  const machine = machineMatch ? machineMatch[1] : 'unknown';

  // Phase 1: parse all files
  interface ParsedRun {
    meta: FileMeta;
    data: ReturnType<typeof parseK6Summary>;
  }
  const parsedRuns: ParsedRun[] = [];
  const parseErrors: string[] = [];

  for (const file of files) {
    const meta = parseFilename(file);
    if (!meta) {
      parseErrors.push(file);
      continue;
    }
    const filePath = path.join(rawDir, file);
    try {
      const data = parseK6Summary(filePath);
      parsedRuns.push({ meta, data });
    } catch (err) {
      console.warn(`  Warning: failed to parse ${file}: ${err}`);
      parseErrors.push(file);
    }
  }

  if (parseErrors.length > 0) {
    console.warn(`\nSkipped ${parseErrors.length} file(s) with unrecognized names or parse errors:`);
    for (const f of parseErrors) {
      console.warn(`  - ${f}`);
    }
  }

  if (parsedRuns.length === 0) {
    console.error('No files could be parsed. Check filename format.');
    process.exit(1);
  }

  console.log(`Parsed ${parsedRuns.length} result files successfully`);

  // Phase 2: group by (impl, variant, scenario, machine, concurrency)
  // and collect raw metrics for aggregation.
  // We maintain a map from group key -> RunGroup, plus metadata for the first record.
  const groups = new Map<string, { group: RunGroup; firstMeta: FileMeta; firstData: ReturnType<typeof parseK6Summary> }>();

  for (const { meta, data } of parsedRuns) {
    const key = `${meta.impl}|${meta.variant}|${meta.scenario}|${machine}|${meta.concurrency}`;

    if (!groups.has(key)) {
      groups.set(key, {
        group: {
          rawRps: [],
          rawThroughputMbps: [],
          rawP50: [],
          rawP95: [],
          rawP99: [],
          rawErrorRate: [],
          rawCpu: [],
          rawMem: [],
          rawGc: [],
          rawFds: [],
        },
        firstMeta: meta,
        firstData: data,
      });
    }

    const entry = groups.get(key)!;
    entry.group.rawRps.push(data.rps);
    entry.group.rawThroughputMbps.push(data.throughputMbps);
    entry.group.rawP50.push(data.p50);
    entry.group.rawP95.push(data.p95);
    entry.group.rawP99.push(data.p99);
    entry.group.rawErrorRate.push(data.errorRate);
    // TODO: CPU/MEM/GC/FDS data come from sidecar monitoring scripts, not k6 JSON.
    // For now, leave them as 0 — they will be filled when the monitor pipeline is wired up.
    // entry.group.rawCpu.push(…);
    // entry.group.rawMem.push(…);
    // entry.group.rawGc.push(…);
    // entry.group.rawFds.push(…);
  }

  // Phase 3: aggregate each group into NormalizedRecord
  const scenarioMap = new Map<string, NormalizedRecord[]>();

  for (const [, entry] of groups) {
    const { group, firstMeta, firstData } = entry;
    const aggregated = aggregateGroup(group);

    const record: NormalizedRecord = {
      impl: firstMeta.impl,
      variant: firstMeta.variant,
      scenario: firstMeta.scenario,
      machine,
      concurrency: firstMeta.concurrency,
      duration_sec: firstData.durationSec,
      runs: group.rawRps.length,
      rps: aggregated.rps,
      throughput_mbps: aggregated.throughput_mbps,
      latency_ms: aggregated.latency_ms,
      error_rate: aggregated.error_rate,
      cpu_avg_pct: aggregated.cpu_avg_pct,
      mem_rss_mb: aggregated.mem_rss_mb,
      gc_pause_ms: aggregated.gc_pause_ms,
      open_fds: aggregated.open_fds,
      notes: '',
    };

    const scenario = firstMeta.scenario;
    if (!scenarioMap.has(scenario)) {
      scenarioMap.set(scenario, []);
    }
    scenarioMap.get(scenario)!.push(record);
  }

  // Phase 4: write per-scenario normalized files
  for (const [scenario, records] of scenarioMap) {
    // Sort records for deterministic output
    records.sort((a, b) => {
      if (a.impl !== b.impl) return a.impl.localeCompare(b.impl);
      if (a.concurrency !== b.concurrency) return a.concurrency - b.concurrency;
      return a.variant.localeCompare(b.variant);
    });

    const outputPath = path.join(normalizedDir, `${scenario}.json`);
    const content = JSON.stringify(
      { scenario, records },
      null,
      2,
    );
    fs.writeFileSync(outputPath, content, 'utf-8');
    console.log(`  Normalized: ${outputPath} (${records.length} records)`);
  }

  console.log('\nNormalization complete.');
  console.log(`  Input:  ${parsedRuns.length} runs from ${rawDir}`);
  console.log(`  Output: ${scenarioMap.size} scenario files in ${normalizedDir}`);
}

main();
