# Results JSON Schema

> 压测结果归一化输出格式。`scripts/normalize-results.ts` 把 k6/wrk 的原始输出转成此格式;`scripts/generate-report.ts` 消费此格式生成报告。
> 与 `BENCHMARK_SPEC.md` §4 统计口径一一对应。

## 单条结果记录

每条记录对应「某实现 × 某场景 × 某并发 × 某变体」的 5 次运行聚合(median,保留 min/max)。

```json
{
  "impl": "rust",
  "variant": "streaming",
  "scenario": "upload-10mb",
  "machine": "xyz-mac",
  "concurrency": 1000,
  "duration_sec": 60,
  "runs": 5,
  "rps": { "median": 12000, "min": 11200, "max": 12800 },
  "throughput_mbps": { "median": 850, "min": 800, "max": 880 },
  "latency_ms": {
    "p50": { "median": 8,   "min": 7,   "max": 9 },
    "p95": { "median": 38,  "min": 35,  "max": 45 },
    "p99": { "median": 120, "min": 110, "max": 140 }
  },
  "error_rate":  { "median": 0.001, "min": 0, "max": 0.003 },
  "cpu_avg_pct": { "median": 720, "min": 680, "max": 750 },
  "mem_rss_mb":  { "median": 380, "min": 350, "max": 420 },
  "gc_pause_ms": { "median": 0,   "min": 0,   "max": 2 },
  "open_fds":    { "median": 5200,"min": 4800,"max": 5500 },
  "notes": "单机自压测,CPU 争抢可能影响绝对值"
}
```

## 字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `impl` | enum | `rust` / `go` / `node` / `python-uvicorn` / `python-granian` / `upstream-direct` / `nginx` |
| `variant` | enum | `n/a` / `buffered` / `streaming`(仅 H4/H6/H7 适用) |
| `scenario` | string | BENCHMARK_SPEC §1 的场景 ID 或名(如 `upload-10mb`、`ws-echo-64b`) |
| `machine` | enum | `xyz-mac` / `jd` |
| `concurrency` | int | 并发数(WS 场景为连接数) |
| `duration_sec` | int | 正式测试时长(不含 warm-up) |
| `runs` | int | 重复次数(通常 5,soak 场景 1) |
| `rps` | object | 每秒请求数,median/min/max |
| `throughput_mbps` | object | 双向吞吐 MB/s |
| `latency_ms.{p50,p95,p99}` | object | 分位延迟 ms |
| `error_rate` | object | 失败率 0-1 |
| `cpu_avg_pct` | object | 进程 CPU 均值(% × 核数,如 720 = 用满 ~7.2 核) |
| `mem_rss_mb` | object | RSS 峰值 MB |
| `gc_pause_ms` | object | GC 暂停峰值(Rust 填 0) |
| `open_fds` | object | 打开文件描述符最大值 |
| `notes` | string | 备注(如 CPU 争抢、环境异常) |

## 文件组织

```
results/<YYYY-MM-DD>/
  raw/              # gitignored,k6/wrk 原始输出
    <impl>-<scenario>-c<concurrency>-<variant>-run<N>.json
  normalized/       # 进版本
    <scenario>.json   # 该场景下所有 impl/并发/变体的数组
  env.lock          # 进版本,环境与依赖快照
  report.html       # 进版本,最终报告
```

`normalized/<scenario>.json` 是数组:

```json
{
  "scenario": "upload-10mb",
  "records": [ { /* 单条记录 */ }, ... ]
}
```
