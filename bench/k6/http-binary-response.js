import http from 'k6/http';
import { check } from 'k6';

export let options = {
  vus: parseInt(__ENV.CONCURRENCY || '10'),
  duration: `${parseInt(__ENV.DURATION_SEC || '60')}s`,
  thresholds: { http_req_failed: ['rate<0.01'] },
};

const BASE = __ENV.TARGET_URL || 'http://localhost:8080';

export default function () {
  const res = http.get(`${BASE}/response/bin?size=10mb`);
  check(res, { 'status 200': (r) => r.status === 200 });
}
