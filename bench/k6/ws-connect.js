import ws from 'k6/ws';
import { check } from 'k6';

export let options = {
  vus: parseInt(__ENV.CONCURRENCY || '100'),
  duration: `${parseInt(__ENV.DURATION_SEC || '30')}s`,
};

const BASE = __ENV.TARGET_URL || 'http://localhost:8080';
const WS_BASE = BASE.replace(/^http/, 'ws');

export default function () {
  const url = `${WS_BASE}/ws/echo`;
  ws.connect(url, (socket) => {
    socket.on('open', () => {
      // keep alive - don't close
    });
    socket.on('error', () => {});
    // Don't close - this tests connection hold
  });
}
