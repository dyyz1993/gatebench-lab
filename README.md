# 🏗️ gatebench-lab

[![Benchmark Report](https://img.shields.io/badge/📊-Benchmark%20Report-blue?style=for-the-badge)](https://dyyz1993.github.io/gatebench-lab/)
[![Rust](https://img.shields.io/badge/Rust-1.92-purple?logo=rust)](https://github.com/dyyz1993/gatebench-lab/tree/master/apps/gateway-rust)
[![Go](https://img.shields.io/badge/Go-1.23-blue?logo=go)](https://github.com/dyyz1993/gatebench-lab/tree/master/apps/gateway-go)
[![Node](https://img.shields.io/badge/Node-25-green?logo=nodedotjs)](https://github.com/dyyz1993/gatebench-lab/tree/master/apps/gateway-node)
[![Python](https://img.shields.io/badge/Python-3.8-blue?logo=python)](https://github.com/dyyz1993/gatebench-lab/tree/master/apps/gateway-python)
[![k6](https://img.shields.io/badge/k6-2.1-7d64ff?logo=k6)](https://k6.io/)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

多语言网关性能对照实验仓库。回答三个问题:

1. **同样网关逻辑下,Rust / Go / Node / Python 的吞吐、延时、资源占用差多少?**
2. **网关本身相对裸后端、Nginx/Envoy 这种成熟网关多了多少损耗?**
3. **在 GET、上传、大 JSON、大响应、二进制、WebSocket 下,瓶颈分别在哪里?**

---

## 📊 基准测试报告

👉 **[在线报告](https://dyyz1993.github.io/gatebench-lab/)** 👈

报告包含:
- ✅ **实验组分组** — 同机自压、跨机对照、上游基线,每组内部排名
- ✅ **场景说明(H1-H7)** — 从简单到复杂,每场景测试目标清晰标注
- ✅ **全景柱状图** — 横轴场景,分组柱子,一眼看到谁在哪个场景领先
- ✅ **排行榜** — 🥇🥈🥉 按 RPS 排序,含 P95/P99 延迟
- ✅ **深入原理分析** — 为什么 Rust 慢?为什么 Python 在 H6 不慢?实现差异全解析
- ✅ **优化前后对比** — Go/Rust 优化前后的性能变化数据
- ✅ **选型建议** — 按你的使用场景推荐语言

> 跨机数据当前标记无效(DNS 不可达),后续配置好网络环境后可重跑追加。

---

## 🏗️ 仓库结构

```
gatebench-lab/
  apps/
    upstream-echo/      # [Go] 统一后端 — 7 HTTP + 3 WebSocket 端点
    gateway-rust/       # [Rust] axum+hyper, 流式代理(已优化)
    gateway-go/         # [Go] net/http ReverseProxy, 连接池复用(已优化)
    gateway-node/       # [Node] Fastify + @fastify/reply-from(已优化)
    gateway-python/     # [Python] FastAPI+httpx(已优化)
  bench/
    k6/                 # 7 HTTP + 3 WebSocket 压测脚本
    wrk/                # wrk 补充脚本
  scripts/              # 运行/归一化/报告工具链
  results/              # 原始数据和报告
  docs/                 # GitHub Pages 报告
```

---

## 🚀 快速开始

### 本地运行单场景

```bash
# 编译 upstream-echo
cd apps/upstream-echo && go build -o upstream-echo . && cd ../..

# 启动上游
./apps/upstream-echo/upstream-echo &

# 编译并启动网关(以 Go 为例)
cd apps/gateway-go && go build -o gateway-go . && cd ../..
UPSTREAM_BASE_URL=http://localhost:9000 GATEWAY_MODE=buffered ./apps/gateway-go/gateway-go &

# 运行压测
TARGET_URL=http://localhost:8080 k6 run bench/k6/http-get.js --vus 10 --duration 30s
```

### 使用运行脚本

```bash
# 单场景
DURATION_SEC=30 bash scripts/run-one.sh go H1 100 buffered

# 全量矩阵(会跑较长时间)
IMPLS="go node python" CONCURRENCIES="10 100" DURATION_SEC=30 bash scripts/run-all.sh
```

### 生成报告

```bash
cd scripts
npx ts-node normalize-results.ts <results-dir>
npx ts-node generate-report.ts <results-dir>
# 或合并多组数据
npx ts-node combine-reports.ts <dir1> <dir2> ...
```

---

## 🧪 实验设计

| 实验组 | 施压机 | 被压机 | 目的 |
|--------|--------|--------|------|
| 同机自压 | MacBook-Pro | MacBook-Pro | 开发迭代,快速验证 |
| 跨机对照 | MacBook-Pro | jd/xyz-mac(待修复) | 真实网络环境 |
| 上游基线 | MacBook-Pro | MacBook-Pro | 无网关的原始性能 |

每组内部的语言对比有效,跨组仅看趋势。

---

## 🔬 优化结论

| 语言 | 关键优化 | 效果 |
|------|---------|------|
| **Go** | 共享 ReverseProxy + `MaxIdleConns=1000` 连接池 | H1 +16%, H2 +1150%*(旧代码缺连接池) |
| **Rust** | 流式代理(请求/响应体零缓冲透传) | H1 +34%, H2 +60%, H3 +8% |
| **Node** | undici 连接池 256 + pipelining 10 | 整体稳定 |
| **Python** | httpx max_keepalive=256 | 整体稳定 |

---

## 📋 分期路线

| Phase | 范围 | 状态 |
|-------|------|------|
| 0 | 实验规格冻结 | ✅ |
| 1 | HTTP MVP(7场景×5实现) | ✅ |
| 2 | WebSocket | ⬜ |
| 3 | 真实网关能力(限流/熔断/metrics) | ⬜ |

---

## 📄 许可

MIT
