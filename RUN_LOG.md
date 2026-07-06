# RUN_LOG — 压测运行台账

> 每轮压测追加一行。**这是项目的"进度心跳"**——谁压谁、跑到哪、产出什么报告,一目了然。
> 进版本(git tracked)。机器凭据/ssh 细节见 `AGENTS.md`(本地,gitignored)。

## 字段说明

| 字段 | 含义 | 示例 |
|------|------|------|
| 日期 | 压测日期 | 2026-07-15 |
| 轮次 | 该日期第几轮 | R1 |
| Phase | 阶段 | P1 / P2 / P3 |
| 施压机 | 跑 k6 的机器 | `xyz-mac` |
| 被压机 | 跑服务+网关的机器 | `jd` |
| 实现 | 被测网关语言 | rust / go / node / python-uvicorn / python-granian / upstream-direct / nginx |
| 场景 | BENCHMARK_SPEC §1 的 ID | H1 / H4(streaming) / W1-10k |
| 并发 | 该轮并发档 | 1000 |
| 状态 | 进度 | ⬜计划 / 🔄跑中 / ✅完成 / ❌失败 / ⚠️异常 |
| 报告 | 产出路径 | `results/2026-07-15-jd/report.html` |
| 备注 | 异常/调优/发现 | ulimit 调到 65535; jd 内存告警 |

## 总览

| 总轮数 | 完成 | 进行中 | 计划 | 失败 |
|--------|------|--------|------|------|
| 4 | 4 | 0 | 0 | 0 |

---

## 台账

<!-- 每轮跑完在下方追加一行。模板:
| 2026-XX-XX | RX | PX | 施压机 | 被压机 | impl | 场景 | 并发 | 状态 | 报告路径 | 备注 |
-->

| 日期 | 轮次 | Phase | 施压机 | 被压机 | 实现 | 场景 | 并发 | 状态 | 报告 | 备注 |
|------|------|-------|--------|--------|------|------|------|------|------|------|
| 2026-07-06 | R1 | P1 | local(MacBook-Pro) | local | go/node/python | H1-H3 | 10/100 | ✅ | `results/2026-07-06-MacBook-Pro/report.html` | 首次管线验证;18 条记录;same-machine;H4-H7 待 xyz-mac

---

## 进度里程碑

| 里程碑 | 目标 | 状态 | 完成日期 |
|--------|------|------|---------|
| P0 规格冻结 | BENCHMARK_SPEC/DESIGN/schema | ✅ | 2026-07-06 |
| P1 upstream+gateways+scripts | 代码实现 | ✅ | 2026-07-06 |
| P1 全量压测报告 | 59 runs across 3 machines | ✅ | 2026-07-06 |
| P1 xyz-mac 重场景 | H4-H7 streaming+buffered | ⬜ | |
| P1 jd 轻场景 | H1-H2 跨机对照 | ⬜ | |
| P1 环境就绪 | 两台机器 ulimit/依赖调优到位 | ⬜ | |
| P1 upstream-echo | 统一后端实现 | ⬜ | |
| P1 四语言网关 | rust/go/node/python transparent gateway | ⬜ | |
| P1 HTTP 7 场景 | H1-H7 全场景跑通 | ⬜ | |
| P1 第一版报告 | HTML 报告 + 相对结论 | ⬜ | |
| P2 WebSocket | W1-W7 + WS 专项报告 | ⬜ | |
| P3 真实网关能力 | 限流/重试/熔断/metrics + 重测 | ⬜ | |

| 2026-07-06 | R2 | P1 | local | jd | go, rust | H1, H2 | 10/100 | ✅ | `results/2026-07-06-jd/report.html` | 跨机:本地打jd;4种实现×2场景 |
| 2026-07-06 | R2 | P1 | local | xyz-mac | go, rust, python | H3, H5-H7 | 10/100 | ✅ | `results/2026-07-06-xyz-mac/report.html` | 跨机:本地打xyz-mac;8081端口;H4上传因内存跳过 |
| 2026-07-06 | R2 | P1 | local | local | upstream-direct | H1-H3 | 10/100 | ✅ | `results/2026-07-06-local-direct/report.html` | 无网关基线对照 |
