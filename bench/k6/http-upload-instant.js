import http from 'k6/http';
import { check } from 'k6';
import crypto from 'k6/crypto';

export let options = {
  vus: parseInt(__ENV.CONCURRENCY || '10'),
  duration: `${parseInt(__ENV.DURATION_SEC || '60')}s`,
  thresholds: { http_req_failed: ['rate<0.01'] },
};

const BASE = __ENV.TARGET_URL || 'http://localhost:8080';
const HASH_HIT_RATE = parseInt(__ENV.HASH_HIT_RATE || '0');

// Generate known hashes matching upstream-echo's pre-populated list
function buildKnownHashes(count) {
  const hashes = [];
  for (let i = 0; i < count; i++) {
    const hash = crypto.sha256(`known-file-${i}`, 'hex');
    hashes.push(hash);
  }
  return hashes;
}

const knownHashes = buildKnownHashes(100);

export default function () {
  let hash;
  const rand = Math.random() * 100;
  if (rand < HASH_HIT_RATE) {
    hash = knownHashes[__VU % knownHashes.length];
  } else {
    hash = crypto.sha256(`random-file-${__VU}-${Date.now()}`, 'hex');
  }
  const res = http.post(`${BASE}/upload/instant/init`, JSON.stringify({ hash }), {
    headers: { 'Content-Type': 'application/json' },
  });
  check(res, { 'status 200': (r) => r.status === 200 });
}
