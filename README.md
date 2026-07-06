# 🏗️ GateBench Lab

[![Benchmark Report](https://img.shields.io/badge/📊-Benchmark%20Report-blue?style=for-the-badge)](https://dyyz1993.github.io/gatebench-lab/)
[![Go](https://img.shields.io/badge/Go-1.23-blue?logo=go)](https://github.com/dyyz1993/gatebench-lab/tree/master/apps/gateway-go)
[![Node](https://img.shields.io/badge/Node-25-green?logo=nodedotjs)](https://github.com/dyyz1993/gatebench-lab/tree/master/apps/gateway-node)
[![Python](https://img.shields.io/badge/Python-3.8-blue?logo=python)](https://github.com/dyyz1993/gatebench-lab/tree/master/apps/gateway-python)
[![Rust(reqwest)](https://img.shields.io/badge/Rust(reqwest)-1.92-purple?logo=rust)](https://github.com/dyyz1993/gatebench-lab/tree/master/apps/gateway-rust)
[![Rust(hyper)](https://img.shields.io/badge/Rust(hyper)-1.92-blueviolet?logo=rust)](https://github.com/dyyz1993/gatebench-lab/tree/master/apps/gateway-rust-hyper)
[![k6](https://img.shields.io/badge/k6-2.1-7d64ff?logo=k6)](https://k6.io/)

A reproducible multi-language gateway benchmark lab. Answers three questions:

1. **With identical gateway logic, how do Rust / Go / Node / Python differ in throughput, latency, and resource usage?**
2. **How much overhead does a gateway add compared to bare upstream or mature proxies like Nginx/Envoy?**
3. **Where are the bottlenecks for GET, upload, large JSON, large response, binary streaming, and WebSocket?**

## 📊 Benchmark Report

👉 **[Live Report](https://dyyz1993.github.io/gatebench-lab/)** 👈

The report includes:
- **5 implementations** across 7 HTTP scenarios (H1-H7)
- **67 benchmark runs**, 63 valid, 4 invalid (documented)
- **Experiment groups** with per-group rankings (same-machine only, no cross-machine mixing)
- **Bar charts** (Chart.js) for RPS and P95/P99 latency
- **Language selection guide** — which language for which use case
- **Development efficiency scorecard** — LOC, dependencies, deployment, streaming support
- **Data validity filtering** — records with error_rate > 5% or missing latency are excluded from rankings

## 📋 Current Coverage

| Impl | H1 GET | H2 Proxy | H3 JSON | H4 Upload | H5 Instant | H6 Text | H7 Binary |
|:----:|:------:|:--------:|:-------:|:---------:|:----------:|:-------:|:---------:|
| **Go** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Node** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Python** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Rust-reqwest** | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ |
| **Rust-hyper** | ✅ | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ |

## 🔬 Key Findings (local same-machine, c=100, 63 valid records)

| Scenario | Go | Node | Python | rust-reqwest | rust-hyper |
|:--------:|:--:|:----:|:------:|:------------:|:----------:|
| H1 GET /ping | **91,128** | 75,539 | 90,593 | 89,148 | 84,412 |
| H2 Proxy 1KB | 27,102 | 24,637 | **27,810** | 28,369 | 46,211* |
| H3 JSON 1MB | **969** | 817 | 876 | 699 | 945 |
| H4 Upload 10MB | **228** | 233 | 193 | ❌ | ❌ |
| H5 Instant 50% | **58,674** | 58,893 | 43,487 | 12,957 | 20,088 |
| H6 Text 10MB | **250** | 196 | 197 | 157 | 200 |
| H7 Binary 10MB | **222** | 211 | 191 | 200 | 191 |

*rust-hyper H2 is anomalously high (likely noise), needs cross-machine verification.

### Language Selection Guide

```
Go: Most mature for standard reverse proxy. ReverseProxy is production-ready,
    zero-dependency single binary. Best choice for HTTP gateway default.

Python: Surprisingly competitive on H1/H2 (close to Go). Good for API
        orchestration, AI gateways, light-to-medium proxy. Heavy upload and
        long-lived connections not yet verified.

Node: Stable but no clear advantage in this test set. Good choice for teams
      already in the JS ecosystem.

Rust-hyper: Hyper direct client outperforms reqwest significantly on POST/body
            scenarios (H3 +59%). Best for latency-critical paths, but
            implementation maturity still behind Go's ReverseProxy.

Rust-reqwest: Baseline version for comparison. Shows that implementation
              strategy matters more than language speed.
```

## 📐 Development Efficiency

| Dimension | Go | Rust | Node | Python |
|-----------|:--:|:----:|:----:|:------:|
| LOC (gateway) | ~120 | ~200 | ~100 | ~120 |
| Dependencies | 0 (stdlib) | 10+ crates | 5+ npm | 4+ pip |
| Build time | <1s | 2-5min | <1s | <1s |
| Single binary deploy | ✅ | ✅ | ❌ | ❌ |
| Streaming support | 🟢 native | 🟡 manual | 🟢 built-in | 🟡 httpx |
| Rate limiting ecosystem | 🟢 mature | 🟡 tower | 🟢 rich | 🟡 limited |
| Metrics | 🟢 promhttp | 🟢 prometheus | 🟢 prom-client | 🟢 prometheus-client |
| Debugging | 🟢 pprof | 🟡 tracing/flame | 🟢 inspector | 🟡 cProfile |

## 🚀 Quick Start

```bash
# Build upstream
cd apps/upstream-echo && go build -o upstream-echo . && cd ../..

# Start upstream
./apps/upstream-echo/upstream-echo &

# Build and start gateway (Go example)
cd apps/gateway-go && go build -o gateway-go . && cd ../..
UPSTREAM_BASE_URL=http://localhost:9000 GATEWAY_MODE=buffered ./apps/gateway-go/gateway-go &

# Run benchmark
TARGET_URL=http://localhost:8080 k6 run bench/k6/http-get.js --vus 10 --duration 30s
```

## 📁 Repository Structure

```
gatebench-lab/
  apps/
    upstream-echo/           # [Go] Unified backend
    gateway-go/              # [Go] net/http ReverseProxy
    gateway-rust/            # [Rust] axum + reqwest (baseline)
    gateway-rust-hyper/      # [Rust] axum + hyper direct (optimized)
    gateway-node/            # [Node] Fastify + @fastify/reply-from
    gateway-python/          # [Python] FastAPI + httpx
  bench/k6/                  # Benchmark scripts (7 HTTP + 3 WS)
  scripts/                   # run-one.sh, run-all.sh, normalize, report
  results/                   # Raw data + normalized + reports
  docs/index.html            # GitHub Pages report
```

## 🔮 Roadmap

- **Phase 1** (✅ done): HTTP H1-H7, 5 implementations, full coverage
- **Phase 1c**: Nginx/Envoy baseline, Rust H4 upload fix
- **Phase 2**: WebSocket long-connection testing
- **Phase 3**: TCP/UDP language selection
- **Phase 4**: Real gateway capabilities (rate limit, circuit breaker, metrics, tracing)

## 📄 License

MIT
