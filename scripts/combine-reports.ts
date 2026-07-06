/**
 * combine-reports.ts — 按实验组分组,组内排名,跨组不混排
 *
 * 用法: npx ts-node combine-reports.ts <results-dir-1> <results-dir-2> ...
 *
 * 每个目录 = 一个实验组(被压机固定)。施压机一律是跑 k6 的机器。
 * 组内: 同语言可对比、同场景可对比、跨场景看趋势。
 * 跨组: 只展示,不排名,不合并。
 */

import * as fs from 'fs';
import * as path from 'path';

interface StatPoint { median: number; min: number; max: number; }

interface NormalizedRecord {
  impl: string; variant: string; scenario: string; machine: string;
  concurrency: number; duration_sec: number; runs: number;
  rps: StatPoint; throughput_mbps: StatPoint;
  latency_ms: { p50: StatPoint; p95: StatPoint; p99: StatPoint; };
  error_rate: StatPoint; cpu_avg_pct: StatPoint; mem_rss_mb: StatPoint;
  gc_pause_ms: StatPoint; open_fds: StatPoint; notes: string;
}

interface ExperimentGroup {
  name: string;           // 目录名
  targetMachine: string;  // 被压机
  pressureMachine: string; // 施压机(k6 跑的地方,这里是固定的本机)
  resultsDir: string;
  records: NormalizedRecord[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function esc(s: string | number): string {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function fmt(v: number, d = 2): string {
  return v.toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(v) ? 0 : d, maximumFractionDigits: d });
}

const COLORS: Record<string,string> = {
  rust: '#b33dc6', go: '#00add8', node: '#68a063', python: '#306998', 'upstream-direct': '#888',
};
function implColor(impl: string, i: number): string {
  return COLORS[impl] || ['#e6194b','#3cb44b','#ffe119','#4363d8','#f58231','#911eb4'][i % 6];
}

function loadGroup(resultsDir: string): ExperimentGroup {
  const dirName = path.basename(resultsDir);
  // 从目录名提取被压机: 2026-07-06-jd → jd;2026-07-06-local-direct → local-direct
  const targetMachine = dirName.replace(/^\d{4}-\d{2}-\d{2}-?/, '') || dirName;
  
  const normalizedDir = path.join(resultsDir, 'normalized');
  const records: NormalizedRecord[] = [];
  if (fs.existsSync(normalizedDir)) {
    for (const f of fs.readdirSync(normalizedDir).filter(f => f.endsWith('.json'))) {
      const data = JSON.parse(fs.readFileSync(path.join(normalizedDir, f), 'utf-8'));
      for (const rec of data.records as NormalizedRecord[]) {
        if (!rec.machine) rec.machine = targetMachine;
        records.push(rec);
      }
    }
  }
  return {
    name: dirName,
    targetMachine,
    pressureMachine: 'MacBook-Pro (local k6)',
    resultsDir,
    records,
  };
}

// ---------------------------------------------------------------------------
// 渲染单个实验组的报告段
// ---------------------------------------------------------------------------

function renderGroup(group: ExperimentGroup): string {
  const { records, targetMachine } = group;
  if (records.length === 0) return '';
  
  const scenarios = [...new Set(records.map(r => r.scenario))].sort();
  const impls = [...new Set(records.map(r => r.impl))].sort();
  const concurrencies = [...new Set(records.map(r => r.concurrency))].sort((a,b) => a-b);
  const bestConc = concurrencies[concurrencies.length - 1];
  
  // ── 组标题 ──
  let html = `<section class="group-section">
    <h2 class="group-title">🔬 实验组:被压机 = ${esc(targetMachine)}</h2>
    <div class="group-meta">
      <span><strong>施压机:</strong> ${esc(group.pressureMachine)}</span>
      <span><strong>被压机:</strong> ${esc(targetMachine)}</span>
      <span><strong>数据点:</strong> ${records.length}</span>
      <span><strong>实现:</strong> ${impls.map(esc).join(', ')}</span>
      <span><strong>场景:</strong> ${scenarios.join(', ')}</span>
    </div>`;
  
  // ── 组内覆盖矩阵 ──
  html += `<h3>覆盖矩阵(RPS)</h3>
    <div style="overflow-x:auto"><table class="matrix-table">
    <thead><tr><th>实现 \\ 场景</th>`;
  for (const s of scenarios) {
    html += `<th>${s}</th>`;
  }
  html += `</tr></thead><tbody>`;
  for (const impl of impls) {
    html += `<tr><td><strong>${esc(impl)}</strong></td>`;
    for (const s of scenarios) {
      // 取该 impl×scenario 在组内的最高 RPS(组内可比)
      const recs = records.filter(r => r.impl === impl && r.scenario === s);
      if (recs.length > 0) {
        const best = Math.max(...recs.map(r => r.rps.median));
        const bestConcRec = recs.find(r => r.rps.median === best);
        html += `<td><span class="rps-value">${fmt(best)}</span><br><span class="machine-tag">c=${bestConcRec?.concurrency}</span></td>`;
      } else {
        html += `<td class="na">—</td>`;
      }
    }
    html += '</tr>';
  }
  html += '</tbody></table></div>';
  
  // ── 组内排行榜(按最高并发档的 RPS 排) ──
  for (const s of scenarios) {
    const ranked = records
      .filter(r => r.scenario === s && r.concurrency === bestConc)
      .sort((a,b) => b.rps.median - a.rps.median);
    if (ranked.length < 2) continue; // 只有一个实现的就不排了
    
    html += `<div class="ranking">
      <h3>🏆 ${s} 排行榜 (c=${bestConc}) <span class="rank-subtitle">被压机=${esc(targetMachine)},组内排序</span></h3>
      <table class="rank-table">
        <thead><tr><th>名次</th><th>实现</th><th>RPS</th><th>P95 (ms)</th><th>P99 (ms)</th><th>错误率</th></tr></thead>
        <tbody>`;
    ranked.forEach((r, i) => {
      const rankCls = i === 0 ? 'rank-1' : i === 1 ? 'rank-2' : i === 2 ? 'rank-3' : '';
      const badge = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `#${i+1}`;
      html += `<tr class="${rankCls}">
        <td class="rank-badge">${badge}</td>
        <td><strong>${esc(r.impl)}</strong></td>
        <td class="num-highlight">${fmt(r.rps.median)}</td>
        <td>${fmt(r.latency_ms.p95.median, 1)}</td>
        <td>${fmt(r.latency_ms.p99.median, 1)}</td>
        <td>${r.error_rate.median > 0 ? (r.error_rate.median*100).toFixed(1)+'%' : '0%'}</td>
      </tr>`;
    });
    html += `</tbody></table></div>`;
  }
  
  // ── 组内柱状图 ──
  for (const s of scenarios) {
    const recs = records.filter(r => r.scenario === s);
    const implsInS = [...new Set(recs.map(r => r.impl))].sort();
    if (implsInS.length === 0) continue;
    
    const chartId = `chart-${group.name}-${s}`.replace(/[^a-zA-Z0-9-]/g, '_');
    const labels = concurrencies.map(c => `c=${c}`);
    const datasets = implsInS.map((impl, i) => ({
      label: impl,
      data: concurrencies.map(c => recs.find(r => r.impl === impl && r.concurrency === c)?.rps.median ?? 0),
      color: implColor(impl, i),
    }));
    
    html += `<h3>${s} — RPS 对比(被压机 ${esc(targetMachine)})</h3>
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
          plugins: { legend: { position: 'bottom' } },
          scales: { y: { beginAtZero: true, title: { display: true, text: 'Requests/sec' } }, x: { grid: { display: false } } }
        }
      });
      </script>`;
  }
  
  // ── 雷达图:各实现能力分布(被压机维度) ──
  if (impls.length >= 2 && scenarios.length >= 3) {
    const radarId = `radar-${group.name}`.replace(/[^a-zA-Z0-9-]/g, '_');
    const bestConc = concurrencies[concurrencies.length - 1];
    
    // Normalize RPS per scenario: each scenario's max across impls = 100%
    const radarLabels = scenarios.map(s => `${s}`);
    const rawData: Record<string, number[]> = {};
    for (const impl of impls) {
      rawData[impl] = scenarios.map(s => {
        const rec = records.find(r => r.impl === impl && r.scenario === s && r.concurrency === bestConc);
        return rec ? rec.rps.median : 0;
      });
    }
    const scenarioMaxes = scenarios.map((_, si) => Math.max(...impls.map(impl => rawData[impl][si]), 1));
    
    const radarDatasets = impls.map((impl, i) => ({
      label: impl,
      data: rawData[impl].map((v, si) => (v / scenarioMaxes[si]) * 100),
      color: implColor(impl, i),
    }));

    html += `<h3>📊 能力雷达图(被压机 ${esc(targetMachine)}, c=${bestConc})</h3>
    <p style="color:#888;font-size:0.85em;margin-top:-0.5em">每个场景归一化到该组最高RPS=100%。越接近外圈越好。</p>
    <div class="chart-container" style="height:400px"><canvas id="${radarId}"></canvas></div>
    <script>
    new Chart(document.getElementById('${radarId}'), {
      type: 'radar',
      data: {
        labels: ${JSON.stringify(radarLabels)},
        datasets: [${radarDatasets.map(d => `{
          label: '${d.label}',
          data: ${JSON.stringify(d.data)},
          backgroundColor: '${d.color}22',
          borderColor: '${d.color}',
          borderWidth: 2,
          pointRadius: 4,
          pointBackgroundColor: '${d.color}',
        }`).join(',')}]
      },
      options: {
        responsive: true,
        plugins: { legend: { position: 'bottom' } },
        scales: {
          r: {
            beginAtZero: true,
            max: 100,
            ticks: { stepSize: 25, callback: v => v + '%' },
            grid: { color: '#ddd' },
            angleLines: { color: '#ddd' },
          }
        }
      }
    });
    </script>`;
  }

  // ── 组内详细表 ──
  html += `<h3>详细数据</h3>
    <div style="overflow-x:auto"><table class="detail-table">
    <thead><tr>
      <th>实现</th><th>场景</th><th>c</th><th>RPS</th><th>MB/s</th>
      <th>P50 (ms)</th><th>P95 (ms)</th><th>P99 (ms)</th><th>错误率</th>
    </tr></thead><tbody>`;
  for (const impl of impls) {
    for (const s of scenarios) {
      for (const c of concurrencies) {
        const r = records.find(rec => rec.impl === impl && rec.scenario === s && rec.concurrency === c);
        if (!r) continue;
        html += `<tr>
          <td><strong>${esc(impl)}</strong></td>
          <td>${s}</td>
          <td>${c}</td>
          <td>${fmt(r.rps.median)}</td>
          <td>${fmt(r.throughput_mbps.median, 1)}</td>
          <td>${fmt(r.latency_ms.p50.median, 1)}</td>
          <td>${fmt(r.latency_ms.p95.median, 1)}</td>
          <td>${fmt(r.latency_ms.p99.median, 1)}</td>
          <td>${r.error_rate.median > 0 ? (r.error_rate.median*100).toFixed(2)+'%' : '0%'}</td>
        </tr>`;
      }
    }
  }
  html += '</tbody></table></div></section>';
  
  return html;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const dirs = process.argv.slice(2);
  if (dirs.length === 0) {
    console.error('Usage: npx ts-node combine-reports.ts <dir1> <dir2> ...');
    process.exit(1);
  }
  
  const groups = dirs.map(loadGroup).filter(g => g.records.length > 0 && g.records !== null);
  console.log(`Loaded ${groups.length} experiment groups:`);
  for (const g of groups) {
    console.log(`  ${g.name}: ${g.records.length} records, target=${g.targetMachine}`);
  }
  
  const allRecords = groups.flatMap(g => g.records);
  const allImpls = [...new Set(allRecords.map(r => r.impl))].sort();
  const allScenarios = [...new Set(allRecords.map(r => r.scenario))].sort();
  
  // ── 实验组概览 ──
  const groupOverview = groups.map(g => {
    const impls = [...new Set(g.records.map(r => r.impl))].sort();
    const scenes = [...new Set(g.records.map(r => r.scenario))].sort();
    return `<div class="group-card">
      <h3>${esc(g.targetMachine)}</h3>
      <div class="group-card-row"><span>施压机</span><strong>${esc(g.pressureMachine)}</strong></div>
      <div class="group-card-row"><span>数据点</span><strong>${g.records.length}</strong></div>
      <div class="group-card-row"><span>实现</span><strong>${impls.map(esc).join(', ')}</strong></div>
      <div class="group-card-row"><span>场景</span><strong>${scenes.join(', ')}</strong></div>
    </div>`;
  }).join('\n');
  
  // ── 场景说明 ──
  const scenarioDescHtml = `<h2>📖 场景说明(从简单到复杂)</h2>
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:10px;margin:1em 0">
    <div class="scene-card"><div class="scene-num">H1</div><div class="scene-title">GET /ping</div><div class="scene-desc">最简单的请求,空body。测框架和路由的基础开销,体现语言运行时的最小成本。</div></div>
    <div class="scene-card"><div class="scene-num">H2</div><div class="scene-title">GET /proxy/small</div><div class="scene-desc">转发1KB小响应。测网关代理转发开销(Nginx反向代理也是干这个的)。</div></div>
    <div class="scene-card"><div class="scene-num">H3</div><div class="scene-title">POST /json/large 1MB</div><div class="scene-desc">提交1MB JSON body。测body读取、JSON解析、内存分配。Python的json.loads vs Rust的serde vs Go的encoding/json。</div></div>
    <div class="scene-card"><div class="scene-num">H4</div><div class="scene-title">POST /upload/file 10MB</div><div class="scene-desc">上传10MB文件(multipart)。测内存/磁盘缓冲策略、streaming能力。内存小的实现会先到瓶颈。</div></div>
    <div class="scene-card"><div class="scene-num">H5</div><div class="scene-title">POST /upload/instant/init</div><div class="scene-desc">秒传hash查重。测内存缓存查询性能+业务逻辑开销。这里体现的是"算法实现"差异,不是语言本身。</div></div>
    <div class="scene-card"><div class="scene-num">H6</div><div class="scene-title">GET /response/text 10MB</div><div class="scene-desc">返回10MB纯文本流。测response streaming、chunked transfer。这里瓶颈在网卡,语言差异会缩小。</div></div>
    <div class="scene-card"><div class="scene-num">H7</div><div class="scene-title">GET /response/bin 10MB</div><div class="scene-desc">返回10MB随机二进制。测二进制吞吐、sendfile能力。和H6类似,但无字符编码开销。</div></div>
  </div>`;

  // ── 能力分析 ──
  const analysisHtml = `<h2>🧠 能力总结</h2>
  <div class="analysis-grid">
    <div class="analysis-card">
      <h3>🟢 Go — 均衡之王</h3>
      <p>Go的<code>httputil.ReverseProxy</code>实现零拷贝代理转发,在简单请求(H1-H2)中表现最好。标准库HTTP支持成熟,部署简单(单二进制)。所有场景表现稳定,适合做通用网关。</p>
    </div>
    <div class="analysis-card">
      <h3>🟣 Rust — 上限最高,但实现深度影响结果</h3>
      <p>当前Rust实现用<code>reqwest</code>做逐请求代理转发,在简单请求上比Go的<code>ReverseProxy</code>慢(每次请求都开HTTP客户端)。但在大上传(H4)和大响应(H6-H7)场景,Rust逐渐追平甚至超过Go。<strong>这不是语言慢,是代理实现方式不同。</strong>用<code>hyper</code>直接做TCP隧道代理后会更强。</p>
    </div>
    <div class="analysis-card">
      <h3>🟢 Node — 简单请求够用,大负载下滑</h3>
      <p>Fastify的<code>reply.from()</code>流式转发在小请求上表现不错。但在高并发和大负载下,单进程event loop模型导致P99延迟升高。Node在I/O密集场景下可用,CPU密集场景不如Rust/Go。</p>
    </div>
    <div class="analysis-card">
      <h3>🔵 Python — 上手最快,性能最低,但可用</h3>
      <p>FastAPI+Uvicorn在低并发下可用,但高并发时worker模型和GC导致吞吐和延迟都差于其他语言。Python的优势是开发效率,不是运行时性能。<strong>但如果瓶颈在上游/网络,Python也能扛住</strong>(H6中Python RPS和Rust几乎一样,因为瓶颈不在网关)。</p>
    </div>
  </div>
  <div class="warning">
    <strong>⚠️ 重要:</strong> 以上排名是<strong>当前实现的排名</strong>,不是语言的绝对排名。
    Rust用<code>reqwest</code>逐请求代理 vs Go的<code>ReverseProxy</code>零拷贝实现——同一语言换实现方式,结果可以差数倍。
    结论应该读作"Go的ReverseProxy实现最成熟",而非"Go语言最快"。
  </div>`;

  // ── 各组报告 ──
  const groupReports = groups.map(renderGroup).join('\n');
  
  const html = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Gateway Benchmark — 实验组报告</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"></script>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; background: #f5f7fa; color: #1a1a2e; }
.header { background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%); color: #fff; padding: 2em 1.5em; }
.header h1 { margin: 0; font-size: 2em; }
.header p { opacity: 0.8; margin: 0.3em 0 0; }
.container { max-width: 1400px; margin: 0 auto; padding: 1.5em; }
.group-card { background: #fff; border-radius: 10px; padding: 1em 1.5em; box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
.group-card h3 { margin: 0 0 0.5em; color: #0f3460; }
.group-card-row { display: flex; justify-content: space-between; padding: 0.3em 0; border-bottom: 1px solid #f0f0f0; font-size: 0.9em; }
.group-card-row span { color: #888; }
.group-card-row strong { color: #1a1a2e; }
.group-section { background: #fff; border-radius: 10px; padding: 1.5em; margin: 1.5em 0; box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
.group-title { color: #fff; background: #0f3460; padding: 0.5em 1em; border-radius: 6px; margin-top: 0; }
.group-meta { display: flex; flex-wrap: wrap; gap: 1.5em; margin: 1em 0; padding: 0.8em 1em; background: #f8faff; border-radius: 6px; font-size: 0.9em; }
.group-meta span { color: #555; }
h2 { color: #0f3460; }
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
.matrix-table { width: 100%; border-collapse: collapse; font-size: 0.9em; }
.matrix-table th { text-align: center; padding: 8px; background: #f0f4f8; border-bottom: 2px solid #dde5f0; color: #555; }
.matrix-table td { text-align: center; padding: 8px; border-bottom: 1px solid #eee; }
.matrix-table tr:hover td { background: #f8faff; }
.rps-value { font-weight: 700; color: #0f3460; }
.machine-tag { font-size: 0.7em; color: #aaa; display: block; }
.na { color: #ddd; background: #fafafa; }
.detail-table { width: 100%; border-collapse: collapse; font-size: 0.88em; }
.detail-table th { text-align: left; padding: 8px 10px; background: #f0f4f8; border-bottom: 2px solid #dde5f0; color: #555; font-size: 0.85em; }
.detail-table td { padding: 6px 10px; border-bottom: 1px solid #eee; }
.detail-table tr:hover td { background: #f8faff; }
.warning { background: #fff3cd; border: 1px solid #ffc107; border-radius: 8px; padding: 1em 1.5em; margin: 1em 0; }
.warning strong { color: #856404; }
footer { text-align: center; padding: 2em; color: #aaa; font-size: 0.85em; }
.scene-card { background: #fff; border-left: 4px solid #0f3460; border-radius: 6px; padding: 0.8em 1em; box-shadow: 0 1px 4px rgba(0,0,0,0.05); }
.scene-num { font-weight: 700; color: #0f3460; font-size: 0.85em; }
.scene-title { font-weight: 600; margin: 0.2em 0; }
.scene-desc { font-size: 0.85em; color: #666; }
.analysis-grid { display: grid; grid-template-columns: repeat(auto-fit,minmax(350px,1fr)); gap: 12px; margin: 1em 0; }
.analysis-card { background: #fff; border-radius: 10px; padding: 1em 1.2em; box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
.analysis-card h3 { margin: 0 0 0.5em; font-size: 1em; }
.analysis-card p { margin: 0; font-size: 0.88em; line-height: 1.5; color: #555; }
.analysis-card code { background: #f0f0f0; padding: 1px 4px; border-radius: 3px; font-size: 0.9em; }
</style>
</head>
<body>
<div class="header">
  <h1>🏗️ Gateway Benchmark — 分组报告</h1>
  <p>${groups.length} 个实验组 · ${allRecords.length} 条记录 · ${allImpls.length} 实现 · ${allScenarios.length} 场景</p>
</div>
<div class="container">

<div class="warning">
  <strong>⚠️ 阅读说明:</strong>
  每个实验组内部(同一被压机)的数据可比,排行榜只在组内有效。
  <strong>跨组不可比</strong>——不同机器规格不同,跨组对比绝对值没有意义。
  跨组只看趋势(比如"Rust 在所有机器上都比 Python 快")。
</div>

<h2>📋 实验组概览</h2>
<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px;margin:1em 0">
${groupOverview}
</div>

${scenarioDescHtml}
${analysisHtml}

${groupReports}

<h2>📌 已知局限</h2>
<div class="warning">
<ul>
  <li><strong>施压机都是本机 MacBook-Pro</strong>:跨机实验组(jd/xyz-mac)的施压机和被压机分离,但施压机固定是本机,不是被压机自己的机器。</li>
  <li><strong>同机自压组(local)</strong>:k6 和网关在同一台机器上,会争抢 CPU,绝对值偏低。仅作开发参考。</li>
  <li><strong>upstream-direct 组</strong>:无网关基线,用于对比"网关带来的额外损耗"。</li>
  <li><strong>跨组不可比</strong>:不同被压机规格不同(macOS vs Linux, 2核 vs 4核),绝对值差异来自机器,不是语言。</li>
</ul>
</div>

</div>
<footer>Generated by gatebench-lab combine-reports.ts on ${new Date().toISOString()}</footer>
</body>
</html>`;
  
  const out = path.join(process.cwd(), '..', 'results', 'MASTER-REPORT.html');
  fs.writeFileSync(out, html);
  console.log(`\n✅ Master report: ${out}`);
}

main();
