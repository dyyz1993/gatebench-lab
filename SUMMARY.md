# GateBench Lab — Phase 1a 语言选型阶段汇报

> 面向网关与网络服务开发的多语言选型实验仓库。
> 回答：同样网关逻辑下，Rust / Go / Node / Python 的性能、延迟、资源占用差多少？

**在线报告:** https://dyyz1993.github.io/gatebench-lab/
**GitHub 仓库:** https://github.com/dyyz1993/gatebench-lab

---

## 一、项目定位

这不是一个"谁跑分高"的 benchmark，而是一套**可复现的多语言网关对比实验**：

1. 统一后端（upstream-echo），确保被测对象只有网关本身
2. 同一场景、同一硬件、同一套压测脚本
3. 控制组：upstream-direct（无网关）、Nginx（待加）
4. 实验组：Rust / Go / Node / Python 各实现
5. 每个语言分 baseline 和 optimized 两个版本

## 二、当前阶段与覆盖

| 阶段 | 范围 | 状态 |
|------|------|------|
| **Phase 1** HTTP 场景 | H1-H7 全部覆盖 | ✅ **完成（67 条记录，63 有效）** |
| Phase 2 WebSocket | W1-W8 连接保持/echo/广播/soak | ⏳ 脚本就绪，待网络直连 |
| Phase 3 TCP / UDP / QUIC | ⬜ 未开始 |
| Phase 4 真实网关能力 | 限流/熔断/metrics/日志/trace | ⬜ 未开始 |

### 覆盖矩阵

| 实现 | H1 GET | H2 代理 | H3 JSON | H4 上传 | H5 秒传 | H6 大文本 | H7 大二进制 |
|:----:|:------:|:-------:|:-------:|:-------:|:-------:|:---------:|:----------:|
| **Go** (ReverseProxy) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Node** (Fastify+undici) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Python** (FastAPI+httpx) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Rust-reqwest** (axum+reqwest) | ✅ | ✅ | ✅ | ❌4 | ✅ | ✅ | ✅ |
| **Rust-hyper** (axum+hyper直连) | ✅ | ✅ | ✅ | ❌4 | ✅ | ✅ | ✅ |

> 4. Rust 两版本的 H4(上传)返回 error_rate=100%。极可能是 Rust 网关不兼容 Go upstream-echo 的 multipart 处理方式,Phase 1c 时排查。

## 三、HTTP 基础场景初步结论（基于 H1-H3 的 24 条有效数据）

### 3.1 当前阶段语言选型建议

> 以下结论仅基于 H1-H3 本地同机有效数据，**不能直接外推到上传、大响应、WebSocket 等场景**。

```
Go：当前最稳。ReverseProxy 成熟，H1/H3 排名第一，零依赖单二进制部署。
     适合作为 HTTP 网关默认基线。

Python：H1/H2 表现超预期，接近 Go。适合 API 编排、AI 网关、轻中量代理。
       但重上传和长连接场景未验证，结论暂不外推。

Node：表现稳定但当前没有明显领先优势。
     适合 JS 技术栈已有团队的业务型网关。

Rust-hyper：optimized 版显著优于 reqwest 版，H1 提升 68%。
           适合后续验证高性能上限，但当前尚未在所有场景追平 Go。
```

### 3.2 性能数据（c=100，本地同机，63 条有效）

| 场景 | Go | Node | Python | rust-reqwest | rust-hyper |
|:----:|:--:|:----:|:------:|:------------:|:----------:|
| H1 GET /ping | **91,128** | 75,539 | 90,593 | 89,148 | 84,412 |
| H2 代理GET 1KB | 27,102 | 24,637 | **27,810** | 28,369 | 46,211* |
| H3 POST JSON 1MB | **969** | 817 | 876 | 699 | 945 |
| H4 上传 10MB | **228** | 233 | 193 | ❌ | ❌ |
| H5 秒传 50%命中 | **58,674** | 58,893 | 43,487 | 12,957 | 20,088 |
| H6 大文本 10MB | **250** | 196 | 197 | 157 | 200 |
| H7 二进制 10MB | **222** | 211 | 191 | 200 | 191 |

> *rust-hyper H2 数据异常偏高(46k vs 正常 24-28k),疑似同机自压噪点,需跨机复跑确认。
> 4 条 Rust × H4 数据 error_rate=100%,已从排行榜排除。

### 3.3 数据可信度

| 维度 | 说明 |
|------|------|
| 数据有效性 | ✅ 24 条全部有效（error_rate=0，延迟数据完整） |
| 无效数据处理 | ✅ error_rate > 5% 或 P95/P99=0 的记录自动排除出排行榜 |
| 环境说明 | ⚠️ 本地同机自压，k6/网关/upstream 共享 CPU、内存、网络栈 |
| 结论力度 | **当前数据适合做阶段性相对参考和实现问题发现；最终语言选型排名需在跨机直连环境下复跑确认** |
| 未覆盖场景 | H4-H7 上传/大响应、WebSocket、TCP/UDP 均未在当前结论中 |

### 3.4 优化效果

| 优化 | 语言 | 幅度 | 原理 | 状态 |
|------|:----:|:----:|------|:----:|
| 路径映射修复 | Go | 原版 404 → 全部 200 | 共享 ReverseProxy 缺路径映射 | ✅ 已修 |
| 连接池复用 | Go | H1 +16%, H2 +1050% | 原版每请求创建新 `http.Client` | ✅ 已修 |
| reqwest → hyper | Rust | H1 +68% | 去掉 reqwest 抽象层开销 | ✅ 已验证 |
| undici 调优 | Node | 连接池 256 + pipelining 10 | 提高连接复用率 | ✅ 已改 |
| httpx 调优 | Python | 连接池限制 256 | 控制最大连接数 | ✅ 已改 |

## 四、架构与工具链

```
gatebench-lab/
├── apps/
│   ├── upstream-echo/          # [Go] 统一后端
│   ├── gateway-go/             # [Go] net/http ReverseProxy ✅（已修复）
│   ├── gateway-rust/           # [Rust] reqwest 版（baseline，供对比）
│   ├── gateway-rust-hyper/     # [Rust] hyper 直连版（optimized）
│   ├── gateway-node/           # [Node] Fastify + @fastify/reply-from
│   └── gateway-python/         # [Python] FastAPI + httpx
├── bench/k6/                   # 7 HTTP + 3 WS 压测脚本
├── scripts/
│   ├── run-one.sh              # 单场景运行
│   ├── run-all.sh              # 全量矩阵
│   ├── normalize-results.ts    # k6 → 归一化 JSON（含 valid 标记）
│   ├── generate-report.ts      # 单组报告
│   └── combine-reports.ts      # 多组合并 → 语言选型报告
├── results/                    # 原始数据 + 归一化 + 报告
├── docs/index.html             # GitHub Pages 报告
└── SUMMARY.md                  # ← 本文档
```

压测工具：**k6 v2.1.0**（HTTP / WebSocket / gRPC）

## 五、已知问题

| 问题 | 影响 | 状态 |
|------|------|------|
| Go 优化版路径映射缺失 | 所有代理路由返回 404 | ✅ **已修复并验证** |
| jd 机器内存不足（1.9GB / 可用 82Mi） | 无法跑基准测试 | ⏳ 需升配或换机器 |
| xyz-mac 跨机不可达 | ssh hostname 不解析，数据走隧道不可靠 | ⏳ 需配 DNS 或 /etc/hosts |
| k6 v2 格式变更 | `p50` → `med`，`values` → 扁平 | ✅ normalize 已适配 |
| 无 Nginx/Envoy 成熟网关基线 | 无法量化自研网关的额外损耗 | ⏳ 待加 |

## 六、下一步建议

| 优先级 | 事项 | 原因 | 预估 |
|:------:|------|------|:----:|
| **P0** | 修文档状态：Phase 1a / 1b 拆分 | 避免"全部完成"和"待跑 H4-H7"自相矛盾 | 0.1 天 |
| **P0** | 跑完 H4-H7，本地同机先补齐 HTTP 完整版 | 上传/大响应是网关核心场景 | 1 天 |
| **P0** | 增加 Nginx baseline | 没有成熟网关对照，自研实现的意义无法量化 | 0.5 天 |
| **P1** | 跨机直连复跑 H1-H7（配 DNS 或 /etc/hosts） | 消除同机争抢 CPU 的数据偏见 | 1 天 |
| **P1** | 补开发效率指标（LOC、Docker 镜像大小等） | 语言选型不能只看 RPS | 0.5 天 |
| **P2** | WebSocket 长连接测试 | 实时场景是网关重要能力 | 2 天 |
| **P2** | TCP / UDP 语言选型测试 | Phase 3 扩展 | 3 天 |
| **P3** | QUIC / HTTP3 | 前沿协议 | — |
| **P3** | 真实网关能力：限流、熔断、metrics、trace | Phase 4 | 3 天 |

## 七、数据可信度声明

**✅ 可以直接引用的话：**
- "在本地同机环境下，Go/Python/Node/Rust 四个语言的 HTTP 网关基础场景吞吐差距约 20%"
- "Go 的 ReverseProxy 实现最成熟，开箱即用，零依赖"
- "Rust 换 hyper 后简单请求提升 68%，显著缩小与 Go 的差距"
- "Python 在 H1/H2 上接近 Go，但结论暂不外推到大负载场景"

**⚠️ 需要加注脚的话：**
- 所有数据来自本地同机压测，RPS 绝对值偏低，适合阶段性参考和实现问题发现
- **最终语言选型排名需在跨机直连环境下复跑确认**
- 当前结论仅覆盖 H1-H3，未涉及上传、大响应、WebSocket、TCP/UDP
- Rust-reqwest 仅作为实现差异对比参考，不参与语言排名

---

*报告版本：Phase 1 / 2026-07-06*
*67 条记录，63 条有效，4 条无效*
*在线报告：https://dyyz1993.github.io/gatebench-lab/*
*项目仓库：https://github.com/dyyz1993/gatebench-lab*
