# DESIGN — 网关能力设计

> 定义本项目各语言网关**必须实现**的能力边界,保证四语言对照公平。

---

## 1. Transparent Gateway(Phase 1 最小集)

Phase 1 各语言网关**必须且只**实现以下能力:

```
client → gateway → upstream-echo
        ├─ 1. 接收请求(读 header + body)
        ├─ 2. 选择 upstream(单后端,直连 upstream-echo)
        ├─ 3. 转发(原样透传 header + body,不改写)
        ├─ 4. 接收 upstream 响应
        └─ 5. 回传给 client(原样透传 status + header + body)
```

**明确不包含(留给 Phase 3):** 鉴权、限流、重试、熔断、路由表、header rewrite、trace id、metrics。

### 1.1 路由表(Phase 1 固定)

| 方法 | 路径 | 行为 |
|------|------|------|
| GET | `/ping` | 直接返回 `{"ok":true}`,不转发(测框架基础成本) |
| GET | `/proxy/small` | 转发到 upstream `/small` |
| POST | `/json/large` | 转发到 upstream `/echo-json` |
| POST | `/upload/file` | 转发到 upstream `/upload`(streaming/buffered 开关) |
| POST | `/upload/instant/init` | 网关本地查 hash 表,命中直接 200,miss 转发 upstream |
| GET | `/response/text?size=N` | 转发到 upstream `/text?size=N`(streaming/buffered 开关) |
| GET | `/response/bin?size=N` | 转发到 upstream `/bin?size=N`(streaming/buffered 开关) |

### 1.2 streaming / buffered 开关

通过环境变量 `GATEWAY_MODE=buffered|streaming` 控制,影响:
- 上传场景(H4):body 是全量读入内存再转发(buffered),还是边收边转(streaming)
- 大响应场景(H6/H7):响应是全量缓冲再发(buffered),还是分块转发(streaming)

两种模式必须都实现,否则无法对照 §1.1 的 H4/H6/H7 变体。

### 1.3 秒传 hash 表(场景 H5)

upstream 启动时预填一组已知 hash,命中率由 k6 脚本控制(发请求时携带命中/未命中的 hash)。网关持有 hash 集合的**内存副本**,`/upload/instant/init` 命中即返回 200,miss 则转发 upstream。

## 2. 框架版本基线

| 语言 | 框架 | 备注 |
|------|------|------|
| Rust | `axum` + `hyper` + `tower` | Tokio 生态,routing + middleware |
| Go | `net/http`(起步) | 必要时加 `chi`,但 Phase 1 先用标准库 |
| Node | `Fastify` | 低开销,内置 schema 序列化 |
| Python | `FastAPI`/`Starlette` + `Uvicorn` | 主对照 |
| Python 变体 | 同上 + `Granian` | Rust-based ASGI server,高性能对照 |

各语言**必须**用 release/prod 模式构建(见 BENCHMARK_SPEC §6)。

## 3. 对照组(Phase 1 必须)

除四种语言网关外,Phase 1 还需实现以下对照,否则无法定位损耗来源:

| 对照组 | 实现 | 作用 |
|--------|------|------|
| `upstream-direct` | 直接打 upstream-echo,不经网关 | 理论基线 |
| `nginx-gateway` | Nginx 反代到 upstream | 成熟网关基准 |

Phase 3 再加 `envoy-gateway` 对照。

## 4. Phase 3 网关能力(占位,后续冻结)

Phase 3 将在 transparent gateway 基础上叠加真实网关功能,届时另起设计冻结:

- 路由表(多 upstream,正则/前缀匹配)
- header rewrite
- upstream round-robin / weighted
- timeout
- retry
- rate limit
- access log
- trace id
- Prometheus metrics

Phase 3 上线后**再测一次**,才能量化"真实网关功能"带来的损耗。
