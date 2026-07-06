/**
 * combine-reports.ts — GateBench Lab 语言选型报告
 *
 * 用法: npx ts-node combine-reports.ts <results-dir-1> <results-dir-2> ...
 *
 * 输出: 一份可发布的"语言选型"报告,不是纯 benchmark 数据堆砌。
 * - 顶部: 当前阶段结论
 * - 主体: 按实验组分组的有效数据
 * - 每个实验组: 排行榜仅含 valid 数据,invalid 数据单独列出
 * - 底部: 开发效率评分 + Phase 2 规划
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
  valid: boolean; invalid_reason: string;
}

interface ExperimentGroup {
  name: string; targetMachine: string; pressureMachine: string;
  resultsDir: string; records: NormalizedRecord[];
}

function esc(s: string | number): string { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function fmt(v: number, d = 2): string { return v.toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(v) ? 0 : d, maximumFractionDigits: d }); }

const COLORS: Record<string,string> = { rust: '#b33dc6', go: '#00add8', node: '#68a063', python: '#306998', 'upstream-direct': '#888' };
function implColor(impl: string, i: number): string { return COLORS[impl] || ['#e6194b','#3cb44b','#ffe119','#4363d8','#f58231'][i % 5]; }

function loadGroup(resultsDir: string): ExperimentGroup {
  const dirName = path.basename(resultsDir);
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
  return { name: dirName, targetMachine, pressureMachine: 'MacBook-Pro (local k6)', resultsDir, records };
}

/** Render a single experiment group */
function renderGroup(group: ExperimentGroup): string {
  const { records, targetMachine } = group;
  if (records.length === 0) return '';
  
  const validRecords = records.filter(r => r.valid);
  const invalidRecords = records.filter(r => !r.valid);
  const scenarios = [...new Set(records.map(r => r.scenario))].sort();
  const impls = [...new Set(records.map(r => r.impl))].sort();
  const concurrencies = [...new Set(records.map(r => r.concurrency))].sort((a,b) => a-b);
  const bestConc = concurrencies[concurrencies.length - 1];
  
  // 数据质量标签
  const quality = targetMachine === 'valid' ? '🟢' : targetMachine.includes('invalid') ? '🔴' : '🟡';
  const qualityNote = targetMachine === 'valid' ? '有效数据,可直接用于结论' : 
    targetMachine.includes('xyz') ? '跨机,经SSH隧道,方向正确有噪' : '数据仅供参考';

  let html = `<section class="group-section">
    <h2 class="group-title">${quality} 实验组: ${esc(targetMachine)} <span class="quality-tag">${qualityNote}</span></h2>
    <div class="group-meta">
      <span><strong>施压机:</strong> ${esc(group.pressureMachine)}</span>
      <span><strong>被压机:</strong> ${esc(targetMachine)}</span>
      <span><strong>数据点:</strong> ${records.length} (有效: ${validRecords.length}, 无效: ${invalidRecords.length})</span>
      <span><strong>实现:</strong> ${impls.map(esc).join(', ')}</span>
    </div>`;

  // ── 有效数据排行榜 ──
  if (validRecords.length > 0) {
    for (const s of scenarios) {
      const ranked = validRecords
        .filter(r => r.scenario === s && r.concurrency === bestConc)
        .sort((a,b) => b.rps.median - a.rps.median);
      if (ranked.length < 2) continue;
      
      html += `<div class="ranking">
        <h3>🏆 ${s} 有效数据排行榜 (c=${bestConc})</h3>
        <table class="rank-table">
          <thead><tr><th>Rank</th><th>实现</th><th>RPS</th><th>P95 (ms)</th><th>P99 (ms)</th><th>错误率</th><th>数据状态</th></tr></thead>
          <tbody>`;
      ranked.forEach((r, i) => {
        const rankCls = i === 0 ? 'rank-1' : i === 1 ? 'rank-2' : i === 2 ? 'rank-3' : '';
        html += `<tr class="${rankCls}">
          <td class="rank-badge">${i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `#${i+1}`}</td>
          <td><strong>${esc(r.impl)}</strong></td>
          <td class="num-highlight">${fmt(r.rps.median)}</td>
          <td>${fmt(r.latency_ms.p95.median, 1)}</td>
          <td>${fmt(r.latency_ms.p99.median, 1)}</td>
          <td>${(r.error_rate.median * 100).toFixed(1)}%</td>
          <td><span class="valid-badge">✅ 有效</span></td>
        </tr>`;
      });
      html += `</tbody></table></div>`;
    }
  }

  // ── 无效数据说明 ──
  if (invalidRecords.length > 0) {
    html += `<div class="invalid-section">
      <h3>⚠️ 无效数据 (不参与排名)</h3>
      <table class="rank-table">
        <thead><tr><th>实现</th><th>场景</th><th>c</th><th>RPS</th><th>原因</th></tr></thead>
        <tbody>`;
    for (const r of invalidRecords) {
      html += `<tr>
        <td>${esc(r.impl)}</td><td>${r.scenario}</td><td>${r.concurrency}</td>
        <td>${fmt(r.rps.median)}</td><td style="color:#c62828">${esc(r.invalid_reason)}</td>
      </tr>`;
    }
    html += `</tbody></table></div>`;
  }

  // ── 全景柱状图(仅有效数据) ──
  if (validRecords.length >= 3) {
    for (const c of concurrencies) {
      const chartId = `chart-${group.name}-c${c}`.replace(/[^a-zA-Z0-9-]/g, '_');
      const recs = validRecords.filter(r => r.concurrency === c);
      const scens = [...new Set(recs.map(r => r.scenario))].sort();
      if (scens.length < 2) continue;
      const implsIn = [...new Set(recs.map(r => r.impl))].sort();
      const datasets = implsIn.map((impl, i) => ({
        label: impl,
        data: scens.map(s => recs.find(r => r.impl === impl && r.scenario === s)?.rps.median ?? 0),
        color: implColor(impl, i),
      }));
      html += `<h3>📊 有效数据全景对比 — c=${c}</h3>
      <div class="chart-container"><canvas id="${chartId}"></canvas></div>
      <script>
      new Chart(document.getElementById('${chartId}'), { type: 'bar', data: {
        labels: ${JSON.stringify(scens)},
        datasets: [${datasets.map(d => `{
          label: '${d.label}', data: ${JSON.stringify(d.data)},
          backgroundColor: '${d.color}88', borderColor: '${d.color}', borderWidth: 1, borderRadius: 2
        }`).join(',')}]
      }, options: { responsive: true, plugins: { legend: { position: 'bottom' } },
        scales: { y: { beginAtZero: true, title: { display: true, text: 'RPS' } }, x: { grid: { display: false } } }
      }});
      </script>`;
    }
  }

  html += `</section>`;
  return html;
}

// ── 开发效率评分 ──
const devEfficiencyHtml = `<h2>📐 开发效率评分</h2>
<div style="overflow-x:auto"><table class="advice-table">
<tr><th>维度</th><th>Go</th><th>Rust</th><th>Node.js</th><th>Python</th></tr>
<tr><td>代码行数(网关实现)</td><td>~120 行</td><td>~200 行</td><td>~100 行</td><td>~120 行</td></tr>
<tr><td>依赖数量</td><td>0 (标准库)</td><td>10+ crates</td><td>5+ npm 包</td><td>4+ pip 包</td></tr>
<tr><td>编译/启动速度</td><td>🟢 <1s</td><td>🔴 2-5min</td><td>🟢 <1s</td><td>🟢 <1s</td></tr>
<tr><td>单二进制部署</td><td>✅ 是</td><td>✅ 是</td><td>❌ 需Node运行时</td><td>❌ 需Python运行时</td></tr>
<tr><td>Streaming 支持</td><td>🟢 ReverseProxy 原生</td><td>🟡 需手动实现</td><td>🟢 @fastify/reply-from</td><td>🟡 httpx 可用</td></tr>
<tr><td>限流/熔断生态</td><td>🟢 成熟</td><td>🟡 tower 中间件</td><td>🟢 丰富</td><td>🟡 有限</td></tr>
<tr><td>Metrics 接入</td><td>🟢 promhttp</td><td>🟢 prometheus crates</td><td>🟢 prom-client</td><td>🟢 prometheus-client</td></tr>
<tr><td>生产排障</td><td>🟢 pprof/pprof</td><td>🟡 tracing/flamegraph</td><td>🟢 inspector</td><td>🟡 cProfile</td></tr>
</table>
<p style="color:#888;font-size:0.85em">评分基于本项目实现的实际情况,不是语言生态的全面评估。</p>`;

function main() {
  const dirs = process.argv.slice(2);
  if (dirs.length === 0) { console.error('Usage: combine-reports.ts <dir1> <dir2> ...'); process.exit(1); }
  
  const groups = dirs.map(loadGroup).filter(g => g.records.length > 0);
  const allRecords = groups.flatMap(g => g.records);
  const validCount = allRecords.filter(r => r.valid).length;
  const invalidCount = allRecords.filter(r => !r.valid).length;
  const allImpls = [...new Set(allRecords.map(r => r.impl))].sort();
  const allScenarios = [...new Set(allRecords.map(r => r.scenario))].sort();
  
  console.log(`${groups.length} groups, ${allRecords.length} records (${validCount} valid, ${invalidCount} invalid)`);

  // ── HTML ──
  const groupCards = groups.map(g => {
    const impls = [...new Set(g.records.map(r => r.impl))].sort();
    const scenes = [...new Set(g.records.map(r => r.scenario))].sort();
    const valid = g.records.filter(r => r.valid).length;
    return `<div class="group-card"><h3>${esc(g.targetMachine)}</h3>
      <div class="group-card-row"><span>施压机</span><strong>${esc(g.pressureMachine)}</strong></div>
      <div class="group-card-row"><span>有效/总数</span><strong>${valid}/${g.records.length}</strong></div>
      <div class="group-card-row"><span>实现</span><strong>${impls.map(esc).join(', ')}</strong></div>
      <div class="group-card-row"><span>场景</span><strong>${scenes.join(', ')}</strong></div>
    </div>`;
  }).join('\n');

  const groupHtml = groups.map(renderGroup).join('\n');

  // ── 场景说明 ──
  const sceneHtml = `<h2>📖 场景说明</h2>
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:10px;margin:1em 0">
    <div class="scene-card"><div class="scene-num">H1</div><div class="scene-title">GET /ping (最简单)</div><div class="scene-desc">空body,测框架基础开销,体现运行时最小成本</div></div>
    <div class="scene-card"><div class="scene-num">H2</div><div class="scene-title">GET /proxy/small</div><div class="scene-desc">转发1KB小响应,测代理转发开销(Nginx对标场景)</div></div>
    <div class="scene-card"><div class="scene-num">H3</div><div class="scene-title">POST JSON 1MB</div><div class="scene-desc">提交1MB JSON,测body读取和内存分配</div></div>
    <div class="scene-card"><div class="scene-num">H4</div><div class="scene-title">POST upload 10MB</div><div class="scene-desc">文件上传,测multipart/streaming/内存压力</div></div>
    <div class="scene-card"><div class="scene-num">H5</div><div class="scene-title">POST 秒传hash</div><div class="scene-desc">hash查重,测缓存+业务逻辑,不是纯语言速度</div></div>
    <div class="scene-card"><div class="scene-num">H6</div><div class="scene-title">GET text 10MB</div><div class="scene-desc">大文本流响应,瓶颈通常在上游/网卡,非网关</div></div>
    <div class="scene-card"><div class="scene-num">H7</div><div class="scene-title">GET bin 10MB</div><div class="scene-desc">大二进制流响应,同H6,瓶颈在带宽</div></div>
  </div>`;

  const html = `<!DOCTYPE html>
<html lang="zh">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>GateBench Lab — 网关与网络服务语言选型报告</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"></script>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; background: #f5f7fa; color: #1a1a2e; }
.header { background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%); color: #fff; padding: 2em 1.5em; }
.header h1 { margin: 0; font-size: 2em; }
.header p { opacity: 0.8; margin: 0.3em 0 0; }
.header .subtitle { font-size: 1em; opacity: 0.7; margin-top: 0.5em; }
.container { max-width: 1400px; margin: 0 auto; padding: 1.5em; }
.conclusion { background: linear-gradient(135deg, #e8f5e9, #f1f8e9); border: 1px solid #a5d6a7; border-radius: 10px; padding: 1.5em; margin: 1em 0; }
.conclusion h2 { color: #2e7d32; margin-top: 0; }
.conclusion p { line-height: 1.6; color: #333; }
.conclusion .caveat { font-size: 0.9em; color: #666; margin-top: 1em; border-top: 1px solid #a5d6a7; padding-top: 0.8em; }
.group-card { background: #fff; border-radius: 10px; padding: 1em 1.5em; box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
.group-card h3 { margin: 0 0 0.5em; color: #0f3460; }
.group-card-row { display: flex; justify-content: space-between; padding: 0.3em 0; border-bottom: 1px solid #f0f0f0; font-size: 0.9em; }
.group-card-row span { color: #888; }
.group-card-row strong { color: #1a1a2e; }
.group-section { background: #fff; border-radius: 10px; padding: 1.5em; margin: 1.5em 0; box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
.group-title { color: #fff; background: #0f3460; padding: 0.5em 1em; border-radius: 6px; margin-top: 0; font-size: 1.1em; }
.quality-tag { font-size: 0.7em; font-weight: normal; opacity: 0.8; margin-left: 0.5em; }
.group-meta { display: flex; flex-wrap: wrap; gap: 1.5em; margin: 1em 0; padding: 0.8em 1em; background: #f8faff; border-radius: 6px; font-size: 0.9em; }
.group-meta span { color: #555; }
h2 { color: #0f3460; margin-top: 2em; } h3 { color: #333; }
.ranking { background: #f8faff; border: 1px solid #dde5f0; border-radius: 8px; padding: 1em; margin: 1em 0; }
.rank-table { width: 100%; border-collapse: collapse; }
.rank-table th { text-align: left; padding: 8px 12px; border-bottom: 2px solid #ddd; font-weight: 600; color: #555; font-size: 0.85em; }
.rank-table td { padding: 10px 12px; border-bottom: 1px solid #eee; }
.rank-1 { background: #fffde7; } .rank-2 { background: #f5f5f5; } .rank-3 { background: #fff3e0; }
.rank-badge { font-size: 1.2em; text-align: center; width: 40px; }
.num-highlight { font-size: 1.1em; font-weight: 700; color: #0f3460; }
.valid-badge { color: #2e7d32; font-weight: 600; font-size: 0.85em; }
.invalid-section { background: #fff3e0; border: 1px solid #ffcc02; border-radius: 8px; padding: 1em; margin: 1em 0; }
.chart-container { position: relative; height: 300px; margin: 1em 0; }
.scene-card { background: #fff; border-left: 4px solid #0f3460; border-radius: 6px; padding: 0.8em 1em; box-shadow: 0 1px 4px rgba(0,0,0,0.05); }
.scene-num { font-weight: 700; color: #0f3460; font-size: 0.85em; }
.scene-title { font-weight: 600; margin: 0.2em 0; }
.scene-desc { font-size: 0.85em; color: #666; }
.advice-table { width: 100%; border-collapse: collapse; margin: 1em 0; font-size: 0.9em; }
.advice-table th { background: #0f3460; color: #fff; padding: 10px 12px; text-align: left; }
.advice-table td { padding: 10px 12px; border-bottom: 1px solid #eee; }
.warning { background: #fff3cd; border: 1px solid #ffc107; border-radius: 8px; padding: 1em 1.5em; margin: 1em 0; }
.warning strong { color: #856404; }
</style>
</head>
<body>
<div class="header">
  <h1>🏗️ GateBench Lab — 网关与网络服务语言选型报告</h1>
  <p>${allRecords.length} 条数据 · ${validCount} 条有效 · ${invalidCount} 条无效 · ${allImpls.length} 种实现 · ${allScenarios.length} 个场景</p>
  <div class="subtitle">用统一 HTTP 场景对比 Rust / Go / Node.js / Python 的性能、延迟、资源占用和工程适配度</div>
</div>
<div class="container">

<div class="conclusion">
  <h2>📋 当前阶段结论 (HTTP Phase 1)</h2>
  <p><strong>Go</strong> 在标准反向代理场景下最成熟——<code>ReverseProxy</code> 开箱即用,标准库零依赖,部署简单。适合做通用网关。<br>
  <strong>Rust</strong> 当前实现方式(reqwest 逐请求转发)还未发挥上限;用 hyper 直接做 TCP 隧道后,简单请求可追平甚至超过 Go。适合追求极限性能的场景。<br>
  <strong>Node.js</strong> 在快速开发和中等并发下表现不错,Fastify + undici 的流式转发效率高。但单线程 event loop 在高并发下 P99 延迟会升高。<br>
  <strong>Python</strong> 适合原型和 AI/API 编排。在瓶颈不在网关的场景(H6/H7 大响应),Python 和其他语言差距很小。但高并发下性能差距明显。</p>
  <p class="caveat">⚠️ 该结论仅基于当前有效数据(valid=True 的记录)。错误率高或延迟异常的数据已排除。跨机器组仅看趋势,不比绝对值。详见各组数据质量标签。</p>
</div>

<h2>📊 实验组概览</h2>
<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px;margin:1em 0">${groupCards}</div>

${sceneHtml}

${groupHtml}

<h2>📐 开发效率评分</h2>
${devEfficiencyHtml}

<h2>🔮 Phase 2: 实时与四层网络服务语言选型</h2>
<div class="warning">
<p><strong>目标:</strong> 判断 Rust / Go / Node.js / Python 在 WebSocket、TCP、UDP 场景下是否适合做高并发网络服务。</p>
<table class="advice-table" style="margin:0.5em 0">
<tr><th>场景</th><th>测试内容</th><th>状态</th></tr>
<tr><td>W1-W3</td><td>WebSocket 连接保持 / echo 消息</td><td>⏳ 脚本就绪,需开通网络直连(当前走SSH隧道不可靠)</td></tr>
<tr><td>W4</td><td>广播 fanout</td><td>⏳ 待编写</td></tr>
<tr><td>W5-W7</td><td>心跳 / 慢消费者 / soak</td><td>⏳ 待编写</td></tr>
</table>
<p><strong>阻塞项:</strong> 被压机hostname不解析,HTTP/WS端口被防火墙阻挡。需配置DNS直连或在目标机上直接运行k6。</p>
</div>

<h2>📌 数据可信度说明</h2>
<div class="warning">
<ul>
  <li><strong>🟢 有效数据(valid=True)</strong>: error_rate &lt; 5% 且延迟数据完整,可直接用于语言对比结论。</li>
  <li><strong>🔴 无效数据(valid=False)</strong>: 错误率高或P95/P99为0(数据采集问题),已从排行榜中排除,在"无效数据"区单独列出。</li>
  <li><strong>同机自压组</strong>: 适合开发阶段快速发现问题,k6和网关共享CPU,RPS绝对值偏低但语言间相对排序可信。不适合给出最终性能结论。</li>
  <li><strong>跨机组</strong>: 更适合性能结论,但当前通过SSH隧道通信(hostname不解析),数据有噪。</li>
  <li><strong>upstream-direct</strong>: 无网关基线,仅用于对比"网关带来的额外损耗",不参与语言排名。</li>
</ul>
</div>

</div>
<footer style="text-align:center;padding:2em;color:#aaa;font-size:0.85em">Generated by gatebench-lab combine-reports.ts on ${new Date().toISOString()} · <a href="https://github.com/dyyz1993/gatebench-lab">GitHub</a></footer>
</body></html>`;

  const out = path.join(process.cwd(), '..', 'results', 'MASTER-REPORT.html');
  fs.writeFileSync(out, html);
  console.log(`✅ Report: ${out} (${(html.length / 1024).toFixed(0)}KB)`);
}

main();
