# gatebench-lab

多语言网关性能对照实验仓库。

## 项目目的

回答三个问题:

1. **同样网关逻辑下,Rust / Go / Node / Python 的吞吐、延时、资源占用差多少?**
2. **网关本身相对裸后端、Nginx/Envoy 这种成熟网关多了多少损耗?**
3. **在 GET、上传、大 JSON、大响应、二进制、WebSocket 下,瓶颈分别在哪里?**

## 目录结构

```
gatebench-lab/
  apps/
    upstream-echo/      # 统一后端,做对照基线
    gateway-rust/       # Rust 网关
    gateway-go/         # Go 网关
    gateway-node/       # Node 网关
    gateway-python/     # Python 网关
  bench/
    k6/                 # k6 压测脚本(HTTP/WS/混合流量)
    wrk/                # wrk 补充脚本(GET 极限吞吐)
  infra/                # Docker Compose / Prometheus / Grafana
  scripts/              # run-one.sh / run-all.sh / 归一化 / 报告生成
  results/<date>/       # 原始(raw/, gitignored) + 归一化(normalized/)
  docs/
  README.md
  DESIGN.md             # 网关能力设计
  BENCHMARK_SPEC.md     # 冻结的实验规格(核心)
  RUN_LOG.md            # 压测运行台账(每轮追加:谁压谁/进度/报告)
  AGENTS.md             # [本地,gitignored] 任务追踪/敏感信息
```

## 分期路线

| Phase | 范围 | 交付 |
|-------|------|------|
| **0** 实验规格冻结 | BENCHMARK_SPEC / DESIGN / 仓库骨架 / 结果 schema | 冻结文档(本期) |
| 1 HTTP MVP | 统一后端 + 四语言 transparent gateway + 7 HTTP 场景 + HTML 报告 | 第一版结论 |
| 2 WebSocket | WS echo/broadcast/heartbeat + 连接数/延迟/慢消费者/soak | WS 专项结论 |
| 3 真实网关能力 | 路由/限流/重试/熔断/日志/trace/metrics + Grafana + runner 复跑 | 严谨公开版 |

工期(1 名熟练工程师):最小可跑版 5–7 天 / HTTP 完整版 2–3 周 / HTTP+WS 3–5 周 / 严谨版 6–8 周。

## 如何运行 / 如何看结果

> **TBD — Phase 1 补充。** Phase 0 只冻结规格,不实现代码。

Phase 1 后将提供:
- `scripts/run-one.sh <impl> <scenario>` 跑单个场景
- `scripts/run-all.sh` 跑全量矩阵
- `scripts/normalize-results.ts` 把 raw 输出归一化为统一 JSON
- `scripts/generate-report.ts` 生成 `results/<date>-<host>/report.html`

## 运行台账

每轮压测的「施压机 / 被压机 / 场景 / 进度 / 报告」记录在 **`RUN_LOG.md`**。看项目进度直接看这个文件。

## 公平性

所有实验都遵循 `BENCHMARK_SPEC.md` 的「公平性规则」章节(release 模式、worker 一致、固定硬件、依赖 lock、5 次取 median、warm-up、streaming/buffered 分组、记录系统参数)。

## 当前状态

**Phase 0 进行中** —— 实验规格冻结。详见 `AGENTS.md`(本地)任务追踪表。
