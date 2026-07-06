# BENCHMARK SPEC — 实验规格(冻结)

> **状态:Phase 0 冻结。** 本文件所有数值已定死,Phase 1+ 实现必须严格遵循,不得擅自修改。
> 修改需走变更记录(文末 §变更记录),且历史结果作废重测。

---

## 1. 场景定义与数据大小

每个场景**每档只取一个代表值**,不留开放区间。需多档时另起独立场景行。

### 1.1 HTTP 场景(Phase 1)

| ID | 场景 | 接口 | 冻结值 | 绑定机器 | 目的 |
|----|------|------|--------|---------|------|
| H1 | 小 GET | `GET /ping` | 空 body,响应 `{"ok":true}` | jd | 框架/路由基础开销 |
| H2 | 代理 GET | `GET /proxy/small` | 后端返回 **1 KB** JSON | jd | 网关转发开销 |
| H3 | 大 JSON | `POST /json/large` | 请求 body = **1 MB** JSON | xyz-mac | body 读取 + JSON 解析 + 内存分配 |
| H4 | 文件上传 | `POST /upload/file` | multipart,**10 MB** | xyz-mac | multipart 解析 + stream/缓冲 |
| H5 | 秒传 init | `POST /upload/instant/init` | 命中率三档: **0% / 50% / 90%** | xyz-mac | hash 查重逻辑开销 |
| H6 | 大文本响应 | `GET /response/text?size=10mb` | **10 MB** 纯文本 | xyz-mac | response streaming |
| H7 | 二进制响应 | `GET /response/bin?size=10mb` | **10 MB** 随机字节 | xyz-mac | 二进制吞吐 + sendfile/stream |

**H4/H6/H7 各分两个变体:**

| 变体 | 定义 |
|------|------|
| `buffered` | 请求/响应**全量读入内存**再转发(`Vec<u8>` / `[]byte` / `Buffer` / `bytes`) |
| `streaming` | **边收边转**,不全量驻留(stream / pipe / chunk) |

> Phase 1 实现必须同时提供两个变体的开关(环境变量或路由参数),否则无法对照。

### 1.2 WebSocket 场景(Phase 2)

| ID | 场景 | 冻结值 | 绑定机器 |
|----|------|--------|---------|
| W1 | 连接保持 | 连接数 **1k / 5k / 10k** 三档 | xyz-mac |
| W2 | echo 消息 | **64 B** | xyz-mac |
| W3 | echo 消息 | **1 KB / 64 KB** 两档 | xyz-mac |
| W4 | 广播 fanout | 1 发 → N 收,N = **100 / 1000** | xyz-mac |
| W5 | 心跳 | ping/pong 间隔 **5s** | xyz-mac |
| W6 | 慢消费者 | 接收方 sleep **100ms/包** | xyz-mac |
| W7 | 长连接 soak | **30 min** | xyz-mac |

---

## 2. 运行参数

| 项 | HTTP 场景 | WebSocket 场景 |
|----|----------|---------------|
| 并发梯度 | **10, 100, 500, 1000, 2000**(5 档) | W1 连接:1k/5k/10k;其余场景并发 = **100** |
| 单轮时长 | **60 s** | W1/W7:30 min;其余 **60 s** |
| warm-up | **30 s**,不计入统计 | **30 s** |
| 重复次数 | 每场景每并发 **5 次** | 5 次(W7 soak 例外:**1 次**) |
| 取值 | 取 **median**,保留 min/max | 同 |

---

## 3. worker 策略

按机器逻辑核数定 worker 数,**保证四种语言同一台机器上 worker 数一致**。

| 机器 | 逻辑核 | worker 数 |
|------|--------|----------|
| xyz-mac | 4 | **4** |
| jd | 2 | **2** |

各语言 worker 实现:

| 语言 | xyz-mac(worker=4) | jd(worker=2) |
|------|-------------------|--------------|
| Rust | tokio 多线程 runtime,worker_threads=4 | worker_threads=2 |
| Go | GOMAXPROCS=4 | GOMAXPROCS=2 |
| Node | cluster 模式,4 worker | 2 worker |
| Python | Uvicorn workers=4 | workers=2 |

Python 额外变体:`Granian workers=4`(Rust-based ASGI server),作为高性能对照,与 Uvicorn 并列。

---

## 4. 统计口径

每条结果记录必须采集以下字段(对应 `docs/RESULTS_SCHEMA.md`):

| 字段 | 取值口径 |
|------|---------|
| `rps` | k6 报告的 `http_reqs`(HTTP)或 `ws_sessions`(WS 建连) |
| `throughput_mbps` | k6 `data_sent + data_received` / 时长 / 1e6 |
| `latency_p50/p95/p99_ms` | k6 `iteration_duration` 或 `http_req_waiting` 分位 |
| `error_rate` | `http_req_failed`(HTTP) / WS 断线率 |
| `cpu_avg_pct` | 压测期间服务进程 CPU 采样均值(`pidstat` / `ps`) |
| `mem_rss_mb` | 压测结束前 RSS 采样峰值 |
| `gc_pause_ms` | 语言运行时 GC 暂停峰值(Node:perf hooks;Python:gc.get_stats;Go:runtime/trace;Rust:无 GC,填 0) |
| `open_fds` | 压测期间 `/proc/<pid>/fd` 或 `lsof` 最大值 |

**采样频率:** CPU/RSS 每 **1 s** 采一次;FD 每 **5 s** 采一次。

---

## 5. 实验环境

> 详见 `AGENTS.md`(本地,gitignored)的机器探测记录。此处只冻结结构性参数。

### 5.1 机器分工(冻结)

**定位:当前两台机器为开发迭代 + 相对结论用途,非正式发布基准。** 正式结论需达 §5.5 理想规格,见 §5.5 及 §5.6 变更规则。

| 机器 | ssh 别名 | OS | CPU | 内存 | 定位 | 绑定场景 |
|------|---------|-----|-----|------|------|---------|
| 服务机 A | `xyz-mac` | macOS | i5-7267U 2P/4L | 8 GB | 开发主力 | H3-H7, W1-W7 |
| 服务机 B | `jd` | Ubuntu 24.04 | Xeon Gold 6148 1P/2L | 1.9 GB | 轻量基线 | H1, H2 |

**拓扑:** 压测机 = 服务机(单机自压测,现阶段无第三台)。CPU 争抢影响在结果 `notes` 字段标注。

**结论效力声明:** 在 §5.5 理想机器到位前,所有结果标注「**dev/相对结论**」:可用于语言间相对排序与瓶颈定位,**不作为对外绝对性能声明**。

### 5.2 调优项(冻结,压测前必须执行)

| 机器 | 参数 | 默认 | 目标 |
|------|------|------|------|
| xyz-mac | `ulimit -n` | 256 | **65535** |
| xyz-mac | `kern.ipc.somaxconn` | 128 | **4096** |
| jd | `ulimit -n` | 1024 | **65535** |
| jd | `net.core.somaxconn` | 4096 | 4096(已达标) |

### 5.3 容器资源限制(冻结)

**不设 cgroup 限制**,让进程跑满,记录上限。原因:Phase 0-2 关注语言本身能力,而非容器调度。

### 5.4 依赖版本基线

压测前所有依赖 lock,版本写入 `results/<date>/env.lock`:

| 语言 | 锁文件 |
|------|--------|
| Rust | `Cargo.lock` |
| Go | `go.sum` |
| Node | `package-lock.json` |
| Python | `requirements.txt`(或 `poetry.lock`) |

### 5.5 理想正式压测机(选机标准 — 未来达标即升级)

当前两台机器做开发迭代足够,但内存/CPU 规格限制了下结论的严谨性。**未来拿到符合以下规格的机器,即作为正式基准重测**,结果效力从「dev/相对结论」升级为「正式结论」。

**理想服务机规格:**

| 维度 | 要求 | 理由 |
|------|------|------|
| CPU | **≥ 8 物理核**(16 逻辑) | 多语言 worker=核数对照才有意义;8 核是主流服务器入门 |
| 内存 | **≥ 32 GB**(可用率 > 80%) | 100MB 上传 × 高并发 + 10k WS 连接 + k6 自身开销 |
| 磁盘 | ≥ 100 GB SSD | 多轮 100MB 上传原始数据 + 日志 |
| OS | **Linux**(Ubuntu 22.04+/Debian) | macOS 网络/调度特性与生产不符;内核参数调优更标准 |
| `ulimit -n` | ≥ 65535(默认或可调) | 10k 并发连接必需 |
| 网络 | 万兆或机房内同 VPC(到压测机 < 0.5ms) | 排除网络成为瓶颈 |
| 独占性 | 专用机,压测期间无其他负载 | 避免背景噪声污染数据 |

**理想压测机(与服务机分离):** 与服务机同机房、同 VPC,规格不低于服务机(避免 k6 自身成瓶颈)。压测机和服务机**必须分离**(设计文档第 7 节硬性要求)。

**判断公式:** `正式结论达标 = 服务机满足上表全部「要求」 AND 存在独立的压测机 AND 拓扑为 C/S 分离`。

### 5.6 机器升级时的变更规则

1. 拿到更强机器 → 在 `AGENTS.md` §1 补充新机器探测记录
2. 把 §5.1 表格的「正式基准」机器行替换为新机器(旧的保留为「历史/开发」行)
3. 在文末 §变更记录登记:`<日期> v<版本> 升级正式基准机 → <新机器名>`
4. **历史所有 dev/相对结果不删**,但标注为「pre-<新机器>」,正式结论只采用新机器结果

---

## 6. 公平性规则(Checklist)

每次正式压测前逐项确认:

- [ ] 全部 release/prod 模式(Rust `--release` / Go 正常 build / Node `NODE_ENV=production` / Python 关 reload)
- [ ] worker 数与机器核数匹配(§3)
- [ ] 固定硬件(§5),无其他重负载进程
- [ ] 依赖版本 lock(§5.4)
- [ ] 每场景每并发至少 5 次,取 median(§2)
- [ ] 每轮正式前 warm-up 30 s(§2)
- [ ] streaming/buffered 分组测试(H4/H6/H7,§1.1)
- [ ] 压测机与服务机分工固定(§5.1),记录 CPU 争抢标注
- [ ] 记录系统参数(CPU 型号/核数/内存/内核/ulimit/网卡/磁盘,写入 `env.lock`)
- [ ] 同一场景的四种语言**同机对照**(跨机器只比相对结论)

---

## 变更记录

| 日期 | 版本 | 变更 | 原因 |
|------|------|------|------|
| 2026-07-06 | v0.1 | Phase 0 初始冻结 | — |
| 2026-07-06 | v0.2 | 新增 §5.5 理想正式压测机选机标准、§5.6 升级规则;§5.1 标注当前为 dev/相对结论 | 现有机器规格不足正式发布,留升级路径 |
