use std::collections::HashMap;
use std::env;
use std::sync::Arc;
use std::time::Duration;

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
use http_body_util::BodyExt;
use hyper_util::client::legacy::{Client, connect::HttpConnector};
use hyper_util::rt::TokioExecutor;
use serde_json::{json, Value};
use tokio::sync::RwLock;
use tower_http::cors::CorsLayer;

// ---------------------------------------------------------------------------
// HashCache
// ---------------------------------------------------------------------------
#[derive(Clone, Default)]
pub struct HashCache {
    inner: Arc<RwLock<HashMap<String, bool>>>,
}
impl HashCache {
    pub fn new() -> Self { Self { inner: Arc::new(RwLock::new(HashMap::new())) } }
    pub async fn contains(&self, key: &str) -> bool { self.inner.read().await.contains_key(key) }
    pub async fn insert(&self, key: String, value: bool) { self.inner.write().await.insert(key, value); }
}

#[derive(Clone)]
pub struct AppState {
    pub hash_cache: HashCache,
    pub upstream_base_url: String,
    pub client: Client<HttpConnector, Body>,
}

fn is_hop_by_hop(key: &str) -> bool {
    matches!(key.to_lowercase().as_str(),
        "connection" | "keep-alive" | "proxy-authenticate" | "proxy-authorization"
        | "te" | "trailers" | "transfer-encoding" | "upgrade" | "host")
}

/// Generic proxy: forward request to upstream using hyper client directly
async fn proxy(
    state: &AppState,
    method: &str,
    target: &str,
    query: Option<&str>,
    headers: &HeaderMap,
    body: Body,
) -> Response<Body> {
    let url = match query {
        Some(q) => format!("{}{}?{}", state.upstream_base_url, target, q),
        None => format!("{}{}", state.upstream_base_url, target),
    };
    let uri: hyper::Uri = match url.parse() {
        Ok(u) => u,
        Err(_) => return Response::builder().status(500).body(Body::from("bad url")).unwrap(),
    };

    let mut builder = hyper::Request::builder().method(method).uri(uri);
    for (k, v) in headers.iter() {
        if !is_hop_by_hop(k.as_str()) {
            builder = builder.header(k.as_str(), v.as_bytes());
        }
    }
    let req = match builder.body(body) {
        Ok(r) => r,
        Err(_) => return Response::builder().status(500).body(Body::from("bad req")).unwrap(),
    };

    let resp = match state.client.request(req).await {
        Ok(r) => r,
        Err(e) => return Response::builder().status(502).body(Body::from(format!("{e}"))).unwrap(),
    };

    let status = resp.status();
    let resp_hdrs = resp.headers().clone();
    let stream = resp.into_body().into_data_stream()
        .map(|r| r.map_err(|e| Box::new(e) as Box<dyn std::error::Error + Send + Sync>));
    let mut res = Response::new(Body::from_stream(stream));
    *res.status_mut() = status;
    for (k, v) in resp_hdrs.iter() {
        if !is_hop_by_hop(k.as_str()) { res.headers_mut().insert(k, v.clone()); }
    }
    res
}

// ---- Routes ----

async fn ping() -> Json<Value> { Json(json!({"ok": true})) }
async fn health() -> StatusCode { StatusCode::OK }

async fn get_proxy(
    State(st): State<AppState>, req: axum::http::Request<Body>,
) -> Response<Body> {
    let p = req.uri().path().to_owned();
    let q = req.uri().query().map(|s| s.to_owned());
    let h = req.headers().clone();
    let b = req.into_body();
    let (target, method) = match p.as_str() {
        "/proxy/small" => ("/small", "GET"),
        "/response/text" => ("/text", "GET"),
        "/response/bin" => ("/bin", "GET"),
        _ => return Response::builder().status(404).body(Body::from("")).unwrap(),
    };
    proxy(&st, method, target, q.as_deref(), &h, b).await
}

async fn post_proxy(
    State(st): State<AppState>, req: axum::http::Request<Body>,
) -> Response<Body> {
    let p = req.uri().path().to_owned();
    let q = req.uri().query().map(|s| s.to_owned());
    let h = req.headers().clone();
    let b = req.into_body();
    let target = match p.as_str() {
        "/json/large" => "/echo-json",
        "/upload/file" => "/upload",
        _ => return Response::builder().status(404).body(Body::from("")).unwrap(),
    };
    proxy(&st, "POST", target, q.as_deref(), &h, b).await
}

async fn instant_init(
    State(st): State<AppState>, Json(body): Json<Value>,
) -> (StatusCode, HeaderMap, Bytes) {
    let hash = match body.get("hash").and_then(|v| v.as_str()) {
        Some(h) => h,
        None => return (StatusCode::BAD_REQUEST, HeaderMap::new(), Bytes::new()),
    };
    if st.hash_cache.contains(hash).await {
        let b = serde_json::to_vec(&json!({"instant": true})).unwrap_or_default().into();
        let mut h = HeaderMap::new();
        h.insert("content-type", HeaderValue::from_static("application/json"));
        return (StatusCode::OK, h, b);
    }
    let uri: hyper::Uri = format!("{}/instant/verify?hash={}", st.upstream_base_url, hash).parse().unwrap();
    let req = hyper::Request::get(uri).body(Body::empty()).unwrap();
    match st.client.request(req).await {
        Ok(resp) => {
            if resp.status().is_success() { st.hash_cache.insert(hash.to_string(), true).await; }
            let s = resp.status();
            let h = resp.headers().clone();
            let b = match http_body_util::BodyExt::collect(resp.into_body()).await {
                Ok(collected) => collected.to_bytes(),
                Err(_) => Bytes::new(),
            };
            (s, h, b)
        }
        Err(_) => (StatusCode::BAD_GATEWAY, HeaderMap::new(), Bytes::new()),
    }
}

#[tokio::main]
async fn main() {
    let upstream = env::var("UPSTREAM_BASE_URL").unwrap_or_else(|_| "http://localhost:9000".into());
    let port = env::var("PORT").unwrap_or_else(|_| "8080".into());

    let client = Client::builder(TokioExecutor::new())
        .pool_idle_timeout(Duration::from_secs(90))
        .pool_max_idle_per_host(256)
        .build_http();

    let app = Router::new()
        .route("/ping", get(ping)).route("/health", get(health))
        .route("/proxy/small", get(get_proxy))
        .route("/json/large", post(post_proxy))
        .route("/upload/file", post(post_proxy))
        .route("/upload/instant/init", post(instant_init))
        .route("/response/text", get(get_proxy))
        .route("/response/bin", get(get_proxy))
        .layer(CorsLayer::permissive())
        .with_state(AppState {
            hash_cache: HashCache::new(),
            upstream_base_url: upstream,
            client,
        });

    let addr = format!("0.0.0.0:{}", port);
    println!("rust-hyper gateway on {}", addr);
    axum::serve(tokio::net::TcpListener::bind(&addr).await.unwrap(), app).await.unwrap();
}
