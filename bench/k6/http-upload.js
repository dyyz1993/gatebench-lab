import http from 'k6/http';
import { check } from 'k6';

export let options = {
  vus: parseInt(__ENV.CONCURRENCY || '10'),
  duration: `${parseInt(__ENV.DURATION_SEC || '60')}s`,
  thresholds: { http_req_failed: ['rate<0.01'] },
};

const BASE = __ENV.TARGET_URL || 'http://localhost:8080';
const FILE_SIZE = parseInt(__ENV.FILE_SIZE || '10485760'); // default 10MB

// Read pre-generated file from disk (fast, no string concat)
// Generate with: dd if=/dev/urandom of=/tmp/test-10mb.bin bs=1M count=10
// For no-file fallback, generate smaller payload inline
let fileContent;
try {
  fileContent = open('/tmp/test-10mb.bin', 'b');
} catch (e) {
  // Fallback: generate smaller payload for testing
  const size = Math.min(FILE_SIZE, 1024 * 1024); // max 1MB in fallback
  const buf = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    buf[i] = Math.floor(Math.random() * 256);
  }
  fileContent = String.fromCharCode(...buf);
}

export default function () {
  const data = { file: http.file(fileContent, 'test.bin', 'application/octet-stream') };
  const res = http.post(`${BASE}/upload/file`, data);
  check(res, { 'status 200': (r) => r.status === 200 });
}
