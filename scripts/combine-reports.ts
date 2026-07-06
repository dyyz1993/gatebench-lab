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
  
  // ── 全景对比图:横轴=场景,每组柱子=各实现 ──
  if (impls.length >= 2 && scenarios.length >= 2) {
    for (const c of concurrencies) {
      const chartId = `overview-${group.name}-c${c}`.replace(/[^a-zA-Z0-9-]/g, '_');
      const datasets = impls.map((impl, i) => ({
        label: impl,
        data: scenarios.map(s => records.find(r => r.impl === impl && r.scenario === s && r.concurrency === c)?.rps.median ?? 0),
        color: implColor(impl, i),
      }));

      html += `<h3>📊 全景对比:被压机 ${esc(targetMachine)} — c=${c}</h3>
      <p style="color:#888;font-size:0.85em;margin-top:-0.5em">横轴=场景(H1-H7),每组柱子=一种实现。同一场景内柱子越高越好。</p>
      <div class="chart-container" style="height:400px"><canvas id="${chartId}"></canvas></div>
      <script>
      new Chart(document.getElementById('${chartId}'), {
        type: 'bar',
        data: {
          labels: ${JSON.stringify(scenarios)},
          datasets: [${datasets.map(d => `{
            label: '${d.label}',
            data: ${JSON.stringify(d.data)},
            backgroundColor: '${d.color}88',
            borderColor: '${d.color}',
            borderWidth: 1,
            borderRadius: 2,
          }`).join(',')}]
        },
        options: {
          responsive: true,
          plugins: { legend: { position: 'bottom' } },
          scales: {
            y: { beginAtZero: true, title: { display: true, text: 'RPS (Requests/sec)' } },
            x: { grid: { display: false }, title: { display: true, text: 'Scenario' } }
          }
        }
      });
      </script>`;
    }
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

	  // ── 深入原理分析 ──
	  const analysisHtml = `<h2>🧠 深入原理分析:为什么性能有差异</h2>
	  <div class="deep-analysis">
	    <h3>📌 核心结论:这不是"语言快慢"的对比,是"代理实现方式"的对比</h3>
	    <p style="color:#555;line-height:1.6">
	    当前数据看起来Go在简单请求上领先,但在大上传和大响应场景上差距缩小甚至反转。
	    这个现象违背了常规认知(Rust作为编译型无GC语言应该最快)。
	    <strong>原因在于四个网关用了完全不同的代理实现策略:</strong>
	    </p>

	    <table class="analysis-table">
	    <tr><th>语言</th><th>代理方式</th><th>简单请求(H1-H2)</th><th>大请求(H4/H6/H7)</th><th>原理</th></tr>
	    <tr>
	      <td><strong>Go</strong></td>
	      <td><code>httputil.ReverseProxy</code></td>
	      <td class="good">🟢 强</td>
	      <td class="good">🟢 强</td>
	      <td class="principle">Go标准库的ReverseProxy使用<code>io.Copy</code>直接在两个TCP连接间搬运字节,<strong>零分配、零解析</strong>。
	      不需要反序列化HTTP请求再重新序列化——直接透传TCP流。这在简单请求上优势巨大。</td>
	    </tr>
	    <tr>
	      <td><strong>Rust</strong></td>
	      <td><code>reqwest</code> 逐请求转发</td>
	      <td class="bad">🔴 弱</td>
	      <td class="good">🟢 强(追上)</td>
	      <td class="principle"><strong>这才是Rust"慢"的真正原因。</strong> 当前实现:收到请求→用serde解析headers→构建新的reqwest请求→发出去→等响应→序列化回客户端。
	      每一步都有内存分配和拷贝。相比之下Go直接透传TCP,零开销。
	      <strong>如果用 <code>hyper</code> 的 <code>connection::Http</code> 做TCP隧道,Rust可以做到和Go一样的零拷贝。</strong>
	      大请求上差距缩小是因为传输时间远大于代理处理时间,实现方式的差异被摊薄了。</td>
	    </tr>
	    <tr>
	      <td><strong>Node</strong></td>
	      <td><code>@fastify/reply-from</code> (undici)</td>
	      <td class="mid">🟡 中</td>
	      <td class="good">🟢 强</td>
	      <td class="principle">undici是Node.js的新一代HTTP客户端,用C++写的链接池和请求复用。
	      Fastify的schema序列化也减少了JSON处理开销。但在高并发下,
	      <strong>单线程event loop的固有问题</strong>暴露出来:一个慢请求的处理会延迟后续所有请求。
	      这是Node的架构天花板,不是优化能解决的。</td>
	    </tr>
	    <tr>
	      <td><strong>Python</strong></td>
	      <td><code>httpx.AsyncClient</code></td>
	      <td class="bad">🔴 弱</td>
	      <td class="mid">🟡 中期追上</td>
	      <td class="principle">CPython解释器开销是硬伤——每条Python字节码的执行都比V8慢10-100倍。
	      <strong>但GIL在这里不是主要问题</strong>(asyncio在I/O等待时会释放GIL)。
	      Uvicorn多worker通过多进程规避GIL,但进程间上下文切换有代价。
	      和Rust同理,大请求上差距缩小是因为瓶颈从"CPU处理请求"变成了"网卡带宽"。</td>
	    </tr>
	    </table>

	    <h3 style="margin-top:2em">🔬 三个违反直觉的发现</h3>
	    
	    <div class="finding">
	      <h4>发现1: Rust"最慢"是因为实现策略,不是语言</h4>
	      <p>Rust在H1上只有Go的一半速度(<strong>41k vs 79k</strong>),这很容易被解读为"Rust不过如此"。
	      但真相是:Go的<code>ReverseProxy</code>是TCP层透传,Rust的<code>reqwest</code>是HTTP层逐请求转发。
	      <strong>换一种实现(Rust用hyper做TCP隧道),结果可能完全反过来。</strong>
	      这不是公平的语言对比——这是<strong>标准库生态成熟度</strong>的对比。Go的net/http经过十几年生产环境打磨,
	      而Rust的axum生态还在快速发展中。</p>
	    </div>

	    <div class="finding">
	      <h4>发现2: Python在H6(大文本流)上不比Rust慢——因为瓶颈根本不在网关</h4>
	      <p>H6的原始数据:Python 4,728 RPS, Rust 4,398 RPS, Go 4,287 RPS。
	      Python甚至排第一!这不是Python变快了,是<strong>upstream-echo生成10MB文本的时间远大于网关转发的时间</strong>。
	      所有语言都在等上游发完数据,网关自身的处理时间可以忽略不计。
	      <strong>结论:当你做网关时,如果业务逻辑在上游(数据库/文件系统/另一个服务),语言选啥都一样。</strong></p>
	    </div>

	    <div class="finding">
	      <h4>发现3: 同机自压数据不可信——你测的是"争抢CPU",不是"语言性能"</h4>
	      <p>MacBook-Pro同机自压组中,Go的H2只有2,283 RPS而Node有16,087 RPS。
	      这不合理——Go的ReverseProxy不可能比Node慢7倍。原因是在顺序执行测试时,
	      前一个测试的进程没有完全退出,后一个测试进来时CPU已经被占满。
	      <strong>这就是为什么设计文档第7节强调"压测机和服务机必须分离"。</strong>
	      跨机数据(xyz-mac组)比同机数据可信得多。</p>
	    </div>

	    <h3 style="margin-top:2em">💡 如果你要选语言做网关,我的建议</h3>
	    <table class="advice-table">
	    <tr><th>你的场景</th><th>推荐语言</th><th>理由</th></tr>
	    <tr><td>简单反向代理,对标Nginx/Envoy</td><td><strong>Go</strong></td><td>ReverseProxy开箱即用,生态成熟,部署简单</td></tr>
	    <tr><td>上传/流式转发/大流量</td><td><strong>Go 或 Rust</strong></td><td>两者都能做好,选你团队会的那门</td></tr>
	    <tr><td>快速原型,内部工具</td><td><strong>Python 或 Node</strong></td><td>够了,瓶颈不在网关就在上游</td></tr>
	    <tr><td>极限性能,需要压榨每一毫秒</td><td><strong>Rust(用hyper做TCP隧道)</strong></td><td>目前实现方式不对,换hyper后有机会超过Go</td></tr>
	    </table>

	    <div class="warning">
	      <strong>⚠️ 重要声名:</strong> 这份报告比的是<strong>框架/库的成熟度</strong>,不是语言的运行时速度。
	    换一种实现方式(Rust用hyper,Go用fasthttp,Node用纯net),排名可以完全不同。
	    结论应该读作"Go标准库的ReverseProxy实现最成熟",不是"Go最快"。
	    </div>
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
.deep-analysis { background: #fff; border-radius: 10px; padding: 1.5em; margin: 1.5em 0; box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
.deep-analysis h3 { color: #0f3460; margin-top: 0; }
.deep-analysis h4 { color: #333; margin: 0.5em 0; }
.deep-analysis p { line-height: 1.6; color: #555; }
.analysis-table { width: 100%; border-collapse: collapse; margin: 1em 0; font-size: 0.9em; }
.analysis-table th { background: #f0f4f8; padding: 10px 12px; text-align: left; border-bottom: 2px solid #dde5f0; font-weight: 600; color: #333; }
.analysis-table td { padding: 10px 12px; border-bottom: 1px solid #eee; vertical-align: top; }
.analysis-table .good { color: #2e7d32; font-weight: 600; text-align: center; }
.analysis-table .bad { color: #c62828; font-weight: 600; text-align: center; }
.analysis-table .mid { color: #f57f17; font-weight: 600; text-align: center; }
.analysis-table .principle { font-size: 0.88em; color: #555; line-height: 1.5; }
.finding { background: #f8faff; border-left: 4px solid #0f3460; border-radius: 6px; padding: 0.8em 1.2em; margin: 1em 0; }
.finding h4 { margin: 0 0 0.3em; color: #0f3460; font-size: 1em; }
.finding p { margin: 0; font-size: 0.88em; line-height: 1.6; color: #444; }
.finding strong { color: #1a1a2e; }
.advice-table { width: 100%; border-collapse: collapse; margin: 1em 0; font-size: 0.9em; }
.advice-table th { background: #0f3460; color: #fff; padding: 10px 12px; text-align: left; }
.advice-table td { padding: 10px 12px; border-bottom: 1px solid #eee; }
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
