'use strict';

require('dotenv').config();

const fastify = require('fastify')({ logger: true });

const PORT = parseInt(process.env.PORT || '8080', 10);
const UPSTREAM_BASE_URL = process.env.UPSTREAM_BASE_URL || 'http://localhost:9000';
const GATEWAY_MODE = process.env.GATEWAY_MODE || 'proxy';

// ---------------------------------------------------------------------------
// 注册 @fastify/reply-from 用于代理转发
//   base 设为基础 URL，路由中可直接用相对路径
//   undici: true 使用 undici 作为 HTTP 客户端（支持 HTTP/2）
// ---------------------------------------------------------------------------
fastify.register(require('@fastify/reply-from'), {
  base: UPSTREAM_BASE_URL,
  undici: true,
});

// ---------------------------------------------------------------------------
// 本地缓存 (用于 /upload/instant/init)
// ---------------------------------------------------------------------------
const hashCache = new Map();

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

// Health / liveness
fastify.get('/health', async (_req, reply) => {
  reply.code(200);
  return { status: 'ok' };
});

// Ping
fastify.get('/ping', async (_req, reply) => {
  return { ok: true };
});

// GET /proxy/small - 代理转发小响应，透传 query
fastify.get('/proxy/small', async (req, reply) => {
  return reply.from('/small', {
    queryString: req.query,
  });
});

// POST /json/large - 代理转发大 JSON body (body 透传)
fastify.post('/json/large', async (req, reply) => {
  return reply.from('/echo-json', {
    body: req.body,
  });
});

// POST /upload/file - 文件上传 (根据 GATEWAY_MODE 决定行为)
fastify.post('/upload/file', async (req, reply) => {
  if (GATEWAY_MODE === 'streaming') {
    // 流式转发：直接 pipe 到 upstream
    return reply.from('/upload');
  }

  // buffered 模式：先读取完整 body 再转发
  const chunks = [];
  for await (const chunk of req.raw) {
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);
  return reply.from('/upload', {
    body,
  });
});

// POST /upload/instant/init - 秒传校验
fastify.post('/upload/instant/init', async (req, reply) => {
  const { hash } = req.body || {};

  if (!hash) {
    reply.code(400);
    return { error: 'missing hash' };
  }

  // 本地缓存命中 → 秒传
  if (hashCache.has(hash)) {
    return { instant: true };
  }

  // 缓存未命中：向 upstream 校验
  try {
    const resp = await fetch(`${UPSTREAM_BASE_URL}/instant/verify?hash=${encodeURIComponent(hash)}`);
    if (resp.ok) {
      hashCache.set(hash, true);
      return { instant: true };
    }
    return { instant: false };
  } catch (err) {
    reply.code(502);
    return { error: 'upstream unreachable' };
  }
});

// GET /response/text - 代理转发文本响应，透传 query (size 参数)
fastify.get('/response/text', async (req, reply) => {
  return reply.from('/text', {
    queryString: req.query,
  });
});

// GET /response/bin - 代理转发二进制响应，透传 query
fastify.get('/response/bin', async (req, reply) => {
  return reply.from('/bin', {
    queryString: req.query,
  });
});

// ---------------------------------------------------------------------------
// 启动服务
// ---------------------------------------------------------------------------
const start = async () => {
  try {
    await fastify.listen({ port: PORT, host: '0.0.0.0' });
    console.log(`🚀 Gateway (mode=${GATEWAY_MODE}) listening on ${PORT}`);
    console.log(`   UPSTREAM_BASE_URL = ${UPSTREAM_BASE_URL}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
