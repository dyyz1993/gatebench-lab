use std::collections::HashMap;
use std::env;
use std::sync::Arc;

use axum::{
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::Response,
    routing::{get, post},
    Json, Router,
};
use axum::body::Body;
use bytes::Bytes;
use futures_util::{StreamExt, TryStreamExt};
use http_body_util::{BodyExt, BodyStream};
use serde_json::{json, Value};
use tokio::sync::RwLock;
use tower_http::cors::CorsLayer;

// ---------------------------------------------------------------------------
// HashCache – instant-upload deduplication (秒传)
// ---------------------------------------------------------------------------
#[derive(Clone, Default)]
pub struct HashCache {
    inner: Arc<RwLock<HashMap<String, bool>>>,
}

impl HashCache {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub async fn contains(&self, key: &str) -> bool {
        let map = self.inner.read().await;
        map.contains_key(key)
    }

    pub async fn insert(&self, key: String, value: bool) {
        let mut map = self.inner.write().await;
        map.insert(key, value);
    }
}

// ---------------------------------------------------------------------------
// Shared application state
// ---------------------------------------------------------------------------
#[derive(Clone)]
pub struct AppState {
    pub hash_cache: HashCache,
    pub upstream_base_url: String,
    pub gateway_mode: String,
    pub client: reqwest::Client,
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/// GET /ping – 直接返回 {"ok":true}
async fn ping_handler() -> Json<Value> {
    Json(json!({"ok": true}))
}

/// GET /health – 返回 200
async fn health_handler() -> StatusCode {
    StatusCode::OK
}

/// GET /proxy/small – 转发到 {upstream_base_url}/small
///
/// 将上游的 status / headers / body 全部透传给客户端。
async fn proxy_small_handler(
    State(state): State<AppState>,
) -> (StatusCode, HeaderMap, Bytes) {
    let resp = match state
        .client
        .get(format!("{}/small", state.upstream_base_url))
        .send()
        .await
    {
        Ok(r) => r,
        Err(_) => return (StatusCode::BAD_GATEWAY, HeaderMap::new(), Bytes::new()),
    };

    let status = resp.status();
    let headers = resp.headers().clone();
    let body = resp.bytes().await.unwrap_or_default();
    (status, headers, body)
}

/// POST /json/large – 转发到 {upstream_base_url}/echo-json
///
/// 透传原始 Bytes body（不做 JSON 反序列化）。
async fn json_large_handler(
    State(state): State<AppState>,
    body: Bytes,
) -> (StatusCode, HeaderMap, Bytes) {
    let resp = match state
        .client
        .post(format!("{}/echo-json", state.upstream_base_url))
        .header("Content-Type", "application/json")
        .body(body)
        .send()
        .await
    {
        Ok(r) => r,
        Err(_) => return (StatusCode::BAD_GATEWAY, HeaderMap::new(), Bytes::new()),
    };

    let status = resp.status();
    let headers = resp.headers().clone();
    let body = resp.bytes().await.unwrap_or_default();
    (status, headers, body)
}

/// POST /upload/file – 转发到 {upstream_base_url}/upload
///
/// 根据 GATEWAY_MODE 环境变量决定行为：
///   - "buffered"  : 先读入全部 bytes 再转发
///   - "streaming" : 将请求 body 以 stream 方式透传给上游
async fn upload_file_handler(
    State(state): State<AppState>,
    body: Body,
) -> Response<Body> {
    let upstream_url = format!("{}/upload", state.upstream_base_url);

    let resp = match state.gateway_mode.as_str() {
        "buffered" => {
            let collected = match body.collect().await {
                Ok(c) => c,
                Err(_) => {
                    let mut res = Response::new(Body::from("failed to read request body"));
                    *res.status_mut() = StatusCode::BAD_REQUEST;
                    return res;
                }
            };
            let bytes = collected.to_bytes();

            match state.client.post(&upstream_url).body(bytes).send().await {
                Ok(r) => r,
                Err(_) => {
                    let mut res = Response::new(Body::from("upstream error"));
                    *res.status_mut() = StatusCode::BAD_GATEWAY;
                    return res;
                }
            }
        }
        "streaming" => {
            let stream = BodyStream::new(body).map(|result| {
                result
                    .map(|frame| frame.data_ref().cloned().unwrap_or_default())
                    .map_err(|e| Box::new(e) as Box<dyn std::error::Error + Send + Sync>)
            });
            let reqwest_body = reqwest::Body::wrap_stream(stream);

            match state
                .client
                .post(&upstream_url)
                .body(reqwest_body)
                .send()
                .await
            {
                Ok(r) => r,
                Err(_) => {
                    let mut res = Response::new(Body::from("upstream error"));
                    *res.status_mut() = StatusCode::BAD_GATEWAY;
                    return res;
                }
            }
        }
        _ => {
            let mut res = Response::new(Body::from(format!(
                "unsupported gateway mode: {}",
                state.gateway_mode
            )));
            *res.status_mut() = StatusCode::BAD_REQUEST;
            return res;
        }
    };

    let status = resp.status();
    let headers = resp.headers().clone();
    let body_bytes = resp.bytes().await.unwrap_or_default();

    let mut response = Response::new(Body::from(body_bytes));
    *response.status_mut() = status;
    for (k, v) in headers.iter() {
        response.headers_mut().insert(k, v.clone());
    }
    response
}

/// POST /upload/instant/init – 本地 hash 表查重（秒传）
///
/// 请求体: { "hash": "..." }
///   命中   → 返回 200 { "instant": true }
///   未命中 → 转发到上游 /instant/verify?hash=...，若上游返回 200 则插入缓存
async fn upload_instant_init_handler(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> (StatusCode, HeaderMap, Bytes) {
    let hash = match body.get("hash").and_then(|v| v.as_str()) {
        Some(h) => h,
        None => {
            return (
                StatusCode::BAD_REQUEST,
                HeaderMap::new(),
                Bytes::new(),
            );
        }
    };

    // 缓存命中 → 直接返回秒传成功
    if state.hash_cache.contains(hash).await {
        let resp_body = json!({"instant": true});
        let bytes = serde_json::to_vec(&resp_body).unwrap_or_default().into();
        let mut headers = HeaderMap::new();
        headers.insert(
            "content-type",
            "application/json".parse().unwrap(),
        );
        return (StatusCode::OK, headers, bytes);
    }

    // 缓存未命中 → 转发到上游
    let resp = match state
        .client
        .get(format!(
            "{}/instant/verify?hash={}",
            state.upstream_base_url,
            urlencoding(hash)
        ))
        .send()
        .await
    {
        Ok(r) => r,
        Err(_) => return (StatusCode::BAD_GATEWAY, HeaderMap::new(), Bytes::new()),
    };

    if resp.status().is_success() {
        state.hash_cache.insert(hash.to_string(), true).await;
    }

    let status = resp.status();
    let headers = resp.headers().clone();
    let body_bytes = resp.bytes().await.unwrap_or_default();
    (status, headers, body_bytes)
}

/// GET /response/text – 转发到 {upstream_base_url}/text?size={size}
///
/// 流式返回上游响应（不做全量缓冲）。
async fn response_text_handler(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> Response<Body> {
    let size = params.get("size").cloned().unwrap_or_else(|| "10mb".to_string());

    let resp = match state
        .client
        .get(format!("{}/text?size={}", state.upstream_base_url, size))
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            let mut res = Response::new(Body::from(format!("upstream error: {e}")));
            *res.status_mut() = StatusCode::BAD_GATEWAY;
            return res;
        }
    };

    let status = resp.status();
    let headers = resp.headers().clone();

    let stream = resp
        .bytes_stream()
        .map_err(|e| Box::new(e) as Box<dyn std::error::Error + Send + Sync>);
    let body = Body::from_stream(stream);

    let mut response = Response::new(body);
    *response.status_mut() = status;
    for (k, v) in headers.iter() {
        response.headers_mut().insert(k, v.clone());
    }
    response
}

/// GET /response/bin – 转发到 {upstream_base_url}/bin?size={size}
///
/// 流式返回上游响应（不做全量缓冲）。
async fn response_bin_handler(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> Response<Body> {
    let size = params.get("size").cloned().unwrap_or_else(|| "10mb".to_string());

    let resp = match state
        .client
        .get(format!("{}/bin?size={}", state.upstream_base_url, size))
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            let mut res = Response::new(Body::from(format!("upstream error: {e}")));
            *res.status_mut() = StatusCode::BAD_GATEWAY;
            return res;
        }
    };

    let status = resp.status();
    let headers = resp.headers().clone();

    let stream = resp
        .bytes_stream()
        .map_err(|e| Box::new(e) as Box<dyn std::error::Error + Send + Sync>);
    let body = Body::from_stream(stream);

    let mut response = Response::new(body);
    *response.status_mut() = status;
    for (k, v) in headers.iter() {
        response.headers_mut().insert(k, v.clone());
    }
    response
}

// ---------------------------------------------------------------------------
// URL encoding helper (for instant-verify hash parameter)
// ---------------------------------------------------------------------------
fn urlencoding(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    for byte in s.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                result.push(byte as char);
            }
            _ => {
                result.push_str(&format!("%{:02X}", byte));
            }
        }
    }
    result
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
#[tokio::main]
async fn main() {
    // Read upstream base URL from environment (default: http://localhost:9000)
    let upstream_base_url = env::var("UPSTREAM_BASE_URL")
        .unwrap_or_else(|_| "http://localhost:9000".to_string());

    // Read gateway mode from environment (default: buffered)
    let gateway_mode =
        env::var("GATEWAY_MODE").unwrap_or_else(|_| "buffered".to_string());

    let state = AppState {
        hash_cache: HashCache::new(),
        upstream_base_url,
        gateway_mode,
        client: reqwest::Client::new(),
    };

    let app = Router::new()
        .route("/ping", get(ping_handler))
        .route("/health", get(health_handler))
        .route("/proxy/small", get(proxy_small_handler))
        .route("/json/large", post(json_large_handler))
        .route("/upload/file", post(upload_file_handler))
        .route("/upload/instant/init", post(upload_instant_init_handler))
        .route("/response/text", get(response_text_handler))
        .route("/response/bin", get(response_bin_handler))
        .layer(CorsLayer::permissive())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind("0.0.0.0:8080")
        .await
        .expect("Failed to bind to 0.0.0.0:8080");

    axum::serve(listener, app)
        .await
        .expect("Server error");
}
