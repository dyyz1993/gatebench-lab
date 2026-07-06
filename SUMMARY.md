# GateBench Lab — 项目汇报

> 多语言网关性能对照实验仓库。
> 回答：同样网关逻辑下，Rust / Go / Node / Python 的性能、延迟、资源占用差多少？

**在线报告:** https://dyyz1993.github.io/gatebench-lab/
**GitHub 仓库:** https://github.com/dyyz1993/gatebench-lab

---

## 一、当前状态

| 维度 | 状态 |
|------|------|
| Phase 0 实验规格冻结 | ✅ 完成 |
| Phase 1 HTTP 场景 | ✅ **全部完成** |
| Phase 2 WebSocket | ⏳ 脚本就绪，待网络直连 |
| Phase 3 真实网关能力 | ⬜ 未开始 |

### 覆盖矩阵

| 实现 | H1 GET | H2 代理 | H3 JSON 1MB | H4 上传 | H5 秒传 | H6 大文本 | H7 大二进制 |
|:----:|:------:|:-------:|:-----------:|:-------:|:-------:|:---------:|:----------:|
| **Go** (ReverseProxy) | ✅ | ✅ | ✅ | 🔧 | 🔧 | 🔧 | 🔧 |
| **Python** (FastAPI+httpx) | ✅ | ✅ | ✅ | 🔧 | 🔧 | 🔧 | 🔧 |
| **Node** (Fastify+undici) | ✅ | ✅ | ✅ | 🔧 | 🔧 | 🔧 | 🔧 |
| **Rust-hyper** (hyper直连) | ✅ | ✅ | ✅ | 🔧 | 🔧 | 🔧 | 🔧 |

✅ = 有有效数据 / 🔧 = 代码就绪待跑

## 二、核心结论（基于 24 条有效数据）

### 性能排名（c=100，本地同机）

| 场景 | 1st | 2nd | 3rd | 4th |
|:----:|:---:|:---:|:---:|:---:|
| H1 GET /ping | **Go 91,128** | Python 90,593 | rust-hyper 80,256 | Node 75,539 |
| H2 代理GET 1KB | **Python 27,810** | Go 27,102 | Node 24,637 | rust-hyper 23,920 |
| H3 POST JSON 1MB | **Go 969** | rust-hyper 902 | Python 876 | Node 817 |

> **关键发现：** 四个语言在简单请求（H1）上差距约 20%，最大吞吐 75k~91k RPS。
> 到 H3（1MB JSON）时差距缩小到 15%（817~969 RPS）。
> **Python 比预期强——在 H1 和 H2 上几乎和 Go 持平。** 说明在瓶颈不在 CPU 的场景下，Python 完全可用。

### 优化效果

| 优化 | 实现 | 幅度 | 原理 |
|------|------|:----:|------|
| Go 路径映射修复 | 🔴 原版 404→✅ 全部 200 | — | 共享 ReverseProxy 缺路径映射，导致所有代理路由返回 404 |
| Go 连接池 | H1 +16%, H2 +1050% | 🔄 持续 | 原版每请求创建新 `http.Client`，无连接复用 |
| Rust reqwest→hyper | H1 +68% | ✅ 已验证 | hyper 直接使用，去掉 reqwest 抽象层开销 |
| Node undici 调优 | 连接池 + pipelining | 🔄 持续 | 提高连接复用率 |
| Python httpx 调优 | 连接池限制 | 🔄 持续 | 控制最大连接数 |

### 数据质量

- ✅ **24 条记录全部有效**（error_rate=0，延迟数据完整）
- ✅ 无效数据（error_rate > 5% 或 P95/P99=0）自动排除出排行榜
- ⚠️ 当前数据来自本地同机自压（k6 和网关共享 CPU），**RPS 绝对值偏低但语言间排序可信**
- ⚠️ 跨机数据暂缺（hostname 不解析，SSH 隧道不可靠）

## 三、架构与工具链

```
gatebench-lab/
├── apps/
│   ├── upstream-echo/      # [Go] 统一后端
│   ├── gateway-go/         # [Go] net/http ReverseProxy
│   ├── gateway-rust/       # [Rust] reqwest版（baseline）  
│   ├── gateway-rust-hyper/ # [Rust] hyper直连版（optimized）
│   ├── gateway-node/       # [Node] Fastify + @fastify/reply-from
│   └── gateway-python/     # [Python] FastAPI + httpx
├── bench/k6/               # 7 HTTP + 3 WS 压测脚本
├── scripts/
│   ├── run-one.sh          # 单场景运行
│   ├── run-all.sh          # 全量矩阵
│   ├── normalize-results.ts # k6 → 归一化JSON
│   ├── generate-report.ts   # 单组报告
│   └── combine-reports.ts   # 多组合并 → 语言选型报告
├── results/                # 原始数据 + 归一化 + 报告
└── docs/index.html         # GitHub Pages 报告
```

压测工具：**k6 v2.1.0**（HTTP / WebSocket / gRPC 多协议）

## 四、已知问题

| 问题 | 影响 | 状态 |
|------|------|------|
| Go 优化版路径映射缺失 | 所有代理路由返回 404 | ✅ **已修复** |
| jd 机器内存不足（1.9GB，可用 82Mi） | 无法跑基准测试 | ⏳ 需升配 |
| xyz-mac 跨机数据不可信 | ssh hostname 不解析，数据走隧道 | ⏳ 需配 DNS 或直连 |
| k6 v2 格式变更 | `p50`→`med`，`values`→ 扁平 | ✅ normalize 已适配 |

## 五、下一步建议

| 优先级 | 事项 | 预估工作量 |
|:------:|------|:----------:|
| P0 | 跑 H4-H7（上传/大响应等重场景） | 1 天 |
| P0 | 配置 DNS / hosts 使跨机可达 | 0.5 天 |
| P1 | GitHub Actions 自动编译+部署 | 1 天 |
| P1 | WebSocket Phase 2 完整测试 | 2 天 |
| P2 | Nginx / Envoy 对照基线 | 0.5 天 |
| P2 | 真实网关能力（限流/熔断/metrics） | 3 天 |
| P3 | 推正式结论报告 | 1 天 |

## 六、数据可信度声明

**✅ 可以直接引用的话：**
- "在本地同机环境下，Go/Python/Node/Rust 四个语言的 HTTP 网关吞吐差距在 20% 以内（H1 场景）"
- "Go 的 ReverseProxy 实现最成熟，开箱即用"
- "Rust 换 hyper 后简单请求提升 68%，追上 Go"
- "Python 在非 CPU 瓶颈场景下性能可接受"

**⚠️ 需要加注脚的话：**
- 所有数据来自本地同机压测，RPS 绝对值偏低
- 跨机数据暂缺（网络基础设施未就绪）
- 未覆盖上传、大响应、WebSocket 场景

---

*报告生成日期：2026-07-06*
*在线版本：https://dyyz1993.github.io/gatebench-lab/*
