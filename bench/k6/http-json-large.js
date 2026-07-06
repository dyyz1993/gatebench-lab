import http from 'k6/http';
import { check } from 'k6';

export let options = {
  vus: parseInt(__ENV.CONCURRENCY || '10'),
  duration: `${parseInt(__ENV.DURATION_SEC || '60')}s`,
  thresholds: { http_req_failed: ['rate<0.01'] },
};

const BASE = __ENV.TARGET_URL || 'http://localhost:8080';

// Generate ~1MB JSON body once per VU (init context)
const largePayload = JSON.stringify({
  data: 'x'.repeat(1024 * 1024),
  timestamp: Date.now(),
});

export default function () {
  const res = http.post(`${BASE}/json/large`, largePayload, {
    headers: { 'Content-Type': 'application/json' },
  });
  check(res, { 'status 200': (r) => r.status === 200 });
}
