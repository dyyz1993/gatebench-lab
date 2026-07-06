use std::collections::HashMap;
use std::env;
use std::sync::Arc;

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode, HeaderValue},
    response::Response,
    routing::{get, post},
    Json, Router,
};
use axum::body::Body;
use bytes::Bytes;
use futures_util::StreamExt;
use http_body_util::BodyStream;
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
        Self { inner: Arc::new(RwLock::new(HashMap::new())) }
    }
    pub async fn contains(&self, key: &str) -> bool {
        self.inner.read().await.contains_key(key)
    }
    pub async fn insert(&self, key: String, value: bool) {
        self.inner.write().await.insert(key, value);
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
// Hop-by-hop headers that MUST NOT be forwarded
// ---------------------------------------------------------------------------
fn is_hop_by_hop(key: &str) -> bool {
    matches!(key.to_lowercase().as_str(),
        "connection" | "keep-alive" | "proxy-authenticate" | "proxy-authorization"
        | "te" | "trailers" | "transfer-encoding" | "upgrade" | "host")
}

// ---------------------------------------------------------------------------
// Generic streaming proxy: forwards ANY request upstream, streams body both ways
// ---------------------------------------------------------------------------
async fn proxy_to_upstream(
    state: &AppState,
    method: &str,
    target_path: &str,
    query_string: Option<&str>,
    incoming_headers: &HeaderMap,
    incoming_body: Body,
) -> Response<Body> {
    let upstream_url = if let Some(qs) = query_string {
        format!("{}{}?{}", state.upstream_base_url, target_path, qs)
    } else {
        format!("{}{}", state.upstream_base_url, target_path)
    };

    // Build the proxied request with streaming body
    let body_stream = BodyStream::new(incoming_body).map(|result| {
        result
            .map(|frame| frame.data_ref().cloned().unwrap_or_default())
            .map_err(|e| Box::new(e) as Box<dyn std::error::Error + Send + Sync>)
    });
    let reqwest_body = reqwest::Body::wrap_stream(body_stream);

    let mut proxy_req = state
        .client
        .request(
            reqwest::Method::from_bytes(method.as_bytes()).unwrap(),
            &upstream_url,
        )
        .body(reqwest_body);

    // Forward headers (skip hop-by-hop)
    for (key, value) in incoming_headers.iter() {
        if !is_hop_by_hop(key.as_str()) {
            proxy_req = proxy_req.header(key.as_str(), value.as_bytes());
        }
    }

    // Send
    let resp = match proxy_req.send().await {
        Ok(r) => r,
        Err(e) => {
            let mut res = Response::new(Body::from(format!("upstream error: {e}")));
            *res.status_mut() = StatusCode::BAD_GATEWAY;
            return res;
        }
    };

    // Build streaming response
    let status = resp.status();
    let resp_headers = resp.headers().clone();

    let response_stream = resp
        .bytes_stream()
        .map(|item| item.map_err(|e| Box::new(e) as Box<dyn std::error::Error + Send + Sync>));
    let body = Body::from_stream(response_stream);

    let mut response = Response::new(body);
    *response.status_mut() = status;
    for (k, v) in resp_headers.iter() {
        if !is_hop_by_hop(k.as_str()) {
            response.headers_mut().insert(k, v.clone());
        }
    }
    response
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

/// Generic GET proxy handler
async fn get_proxy_handler(
    State(state): State<AppState>,
    req: axum::http::Request<Body>,
) -> Response<Body> {
    let path = req.uri().path().to_owned();
    let query = req.uri().query().map(|q| q.to_owned());
    let headers = req.headers().clone();
    let body = req.into_body();

    let (target_path, method) = match path.as_str() {
        "/proxy/small" => ("/small", "GET"),
        "/response/text" => ("/text", "GET"),
        "/response/bin" => ("/bin", "GET"),
        _ => return Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Body::from("not found"))
            .unwrap(),
    };

    proxy_to_upstream(
        &state,
        method,
        target_path,
        query.as_deref(),
        &headers,
        body,
    ).await
}

/// Generic POST proxy handler (json/large and upload/file)
async fn post_proxy_handler(
    State(state): State<AppState>,
    req: axum::http::Request<Body>,
) -> Response<Body> {
    let path = req.uri().path().to_owned();
    let query = req.uri().query().map(|q| q.to_owned());
    let headers = req.headers().clone();
    let body = req.into_body();

    let target_path = match path.as_str() {
        "/json/large" => "/echo-json",
        "/upload/file" => "/upload",
        _ => return Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Body::from("not found"))
            .unwrap(),
    };

    proxy_to_upstream(
        &state,
        "POST",
        target_path,
        query.as_deref(),
        &headers,
        body,
    ).await
}

/// POST /upload/instant/init – 本地 hash 表查重（秒传）
async fn upload_instant_init_handler(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> (StatusCode, HeaderMap, Bytes) {
    let hash = match body.get("hash").and_then(|v| v.as_str()) {
        Some(h) => h,
        None => return (StatusCode::BAD_REQUEST, HeaderMap::new(), Bytes::new()),
    };

    // 缓存命中 → 直接返回秒传成功
    if state.hash_cache.contains(hash).await {
        let bytes = serde_json::to_vec(&json!({"instant": true})).unwrap_or_default().into();
        let mut headers = HeaderMap::new();
        headers.insert("content-type", HeaderValue::from_static("application/json"));
        return (StatusCode::OK, headers, bytes);
    }

    // 缓存未命中 → 转发到上游验证
    let resp = match state
        .client
        .get(format!("{}/instant/verify?hash={}", state.upstream_base_url, urlencode(hash)))
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

// ---------------------------------------------------------------------------
// URL encoding helper
// ---------------------------------------------------------------------------
fn urlencode(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    for byte in s.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                result.push(byte as char);
            }
            _ => result.push_str(&format!("%{:02X}", byte)),
        }
    }
    result
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
#[tokio::main]
async fn main() {
    let upstream_base_url = env::var("UPSTREAM_BASE_URL")
        .unwrap_or_else(|_| "http://localhost:9000".to_string());
    let gateway_mode = env::var("GATEWAY_MODE").unwrap_or_else(|_| "buffered".to_string());
    let port = env::var("PORT").unwrap_or_else(|_| "8080".to_string());

    let state = AppState {
        hash_cache: HashCache::new(),
        upstream_base_url,
        gateway_mode,
        client: reqwest::Client::builder()
            .pool_max_idle_per_host(256)
            .build()
            .expect("reqwest client"),
    };

    let app = Router::new()
        .route("/ping", get(ping_handler))
        .route("/health", get(health_handler))
        .route("/proxy/small", get(get_proxy_handler))
        .route("/json/large", post(post_proxy_handler))
        .route("/upload/file", post(post_proxy_handler))
        .route("/upload/instant/init", post(upload_instant_init_handler))
        .route("/response/text", get(get_proxy_handler))
        .route("/response/bin", get(get_proxy_handler))
        .layer(CorsLayer::permissive())
        .with_state(state);

    let addr = format!("0.0.0.0:{}", port);
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .expect("Failed to bind");

    println!("Rust gateway listening on {}", addr);
    axum::serve(listener, app).await.expect("Server error");
}
