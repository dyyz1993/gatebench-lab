import http from 'k6/http';
import { check } from 'k6';

export let options = {
  vus: parseInt(__ENV.CONCURRENCY || '10'),
  duration: `${parseInt(__ENV.DURATION_SEC || '60')}s`,
  thresholds: { http_req_failed: ['rate<0.01'] },
};

const BASE = __ENV.TARGET_URL || 'http://localhost:8080';

// Generate 10MB of random data once per VU
const fileContent = randomString(10 * 1024 * 1024);

function randomString(size) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < size; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

export default function () {
  const data = { file: http.file(fileContent, 'test.bin', 'application/octet-stream') };
  const res = http.post(`${BASE}/upload/file`, data);
  check(res, { 'status 200': (r) => r.status === 200 });
}
