import ws from 'k6/ws';
import { check } from 'k6';
import { Rate } from 'k6/metrics';

const errorRate = new Rate('errors');

export let options = {
  vus: parseInt(__ENV.CONCURRENCY || '10'),
  duration: `${parseInt(__ENV.DURATION_SEC || '60')}s`,
  thresholds: { errors: ['rate<0.05'] },
};

const BASE = __ENV.TARGET_URL || 'http://localhost:8080';
const WS_BASE = BASE.replace(/^http/, 'ws');

export default function () {
  const url = `${WS_BASE}/ws/echo`;
  const res = ws.connect(url, (socket) => {
    socket.on('open', () => {
      socket.send('ping');
    });
    socket.on('message', (data) => {
      check(data, { 'echo matches': (d) => d === 'ping' });
      errorRate.add(data !== 'ping');
      socket.close();
    });
    socket.on('error', (e) => {
      errorRate.add(1);
    });
    socket.setTimeout(() => {
      socket.close();
    }, 5000);
  });
  check(res, { 'connected': (r) => r && r.status === 101 });
}
