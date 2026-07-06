import os
from fastapi import FastAPI, Request
from fastapi.responses import Response
import httpx

app = FastAPI()

UPSTREAM_BASE_URL = os.getenv("UPSTREAM_BASE_URL", "http://localhost:9000")
GATEWAY_MODE = os.getenv("GATEWAY_MODE", "")

# Global HTTP client with connection pooling for forwarding requests
client = httpx.AsyncClient(
    timeout=60.0,
    limits=httpx.Limits(max_keepalive_connections=256, max_connections=1024),
)

# Simple in-memory hash set for instant upload (秒传)
_hash_cache: set[str] = set()


@app.get("/ping")
async def ping():
    return {"ok": True}


@app.get("/proxy/small")
async def proxy_small():
    try:
        resp = await client.get(f"{UPSTREAM_BASE_URL}/small")
        return Response(
            content=resp.content,
            status_code=resp.status_code,
            headers=dict(resp.headers),
        )
    except Exception as e:
        return Response(
            content=f'{{"error": "upstream request failed: {e}"}}',
            status_code=502,
            media_type="application/json",
        )


@app.post("/json/large")
async def json_large(request: Request):
    try:
        body = await request.body()
        resp = await client.post(
            f"{UPSTREAM_BASE_URL}/echo-json",
            content=body,
            headers={"Content-Type": "application/json"},
        )
        return Response(
            content=resp.content,
            status_code=resp.status_code,
            headers=dict(resp.headers),
        )
    except Exception as e:
        return Response(
            content=f'{{"error": "upstream request failed: {e}"}}',
            status_code=502,
            media_type="application/json",
        )


@app.post("/upload/file")
async def upload_file(request: Request):
    try:
        body = await request.body()
        content_type = request.headers.get("content-type", "")
        resp = await client.post(
            f"{UPSTREAM_BASE_URL}/upload",
            content=body,
            headers={"Content-Type": content_type},
        )
        return Response(
            content=resp.content,
            status_code=resp.status_code,
            headers=dict(resp.headers),
        )
    except Exception as e:
        return Response(
            content=f'{{"error": "upstream request failed: {e}"}}',
            status_code=502,
            media_type="application/json",
        )


@app.post("/upload/instant/init")
async def upload_instant_init(request: Request):
    try:
        data = await request.json()
        file_hash = data.get("hash")
        if file_hash in _hash_cache:
            return {"instant": True}
        # miss — verify with upstream
        resp = await client.get(
            f"{UPSTREAM_BASE_URL}/instant/verify", params={"hash": file_hash}
        )
        if resp.status_code == 200:
            _hash_cache.add(file_hash)
            return {"instant": True}
        return {"instant": False}
    except Exception as e:
        return Response(
            content=f'{{"error": "instant init failed: {e}"}}',
            status_code=502,
            media_type="application/json",
        )


@app.get("/response/text")
async def response_text(size: str = "10mb"):
    try:
        resp = await client.get(
            f"{UPSTREAM_BASE_URL}/text", params={"size": size}
        )
        return Response(
            content=resp.content,
            status_code=resp.status_code,
            headers=dict(resp.headers),
        )
    except Exception as e:
        return Response(
            content=f'{{"error": "upstream request failed: {e}"}}',
            status_code=502,
            media_type="application/json",
        )


@app.get("/response/bin")
async def response_bin(size: str = "10mb"):
    try:
        resp = await client.get(
            f"{UPSTREAM_BASE_URL}/bin", params={"size": size}
        )
        return Response(
            content=resp.content,
            status_code=resp.status_code,
            headers=dict(resp.headers),
        )
    except Exception as e:
        return Response(
            content=f'{{"error": "upstream request failed: {e}"}}',
            status_code=502,
            media_type="application/json",
        )


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.on_event("shutdown")
async def shutdown():
    await client.aclose()
