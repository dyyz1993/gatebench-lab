import ws from 'k6/ws';
import { check } from 'k6';

export let options = {
  vus: parseInt(__ENV.CONCURRENCY || '10'),
  duration: `${parseInt(__ENV.DURATION_SEC || '60')}s`,
};

const BASE = __ENV.TARGET_URL || 'http://localhost:8080';
const WS_BASE = BASE.replace(/^http/, 'ws');
const SIZE = parseInt(__ENV.MSG_SIZE || '64');

export default function () {
  const payload = 'x'.repeat(SIZE);
  const url = `${WS_BASE}/ws/echo`;
  ws.connect(url, (socket) => {
    socket.on('open', () => {
      socket.send(payload);
    });
    socket.on('message', (data) => {
      check(data, { 'size matches': (d) => d.length === SIZE });
      socket.close();
    });
    socket.setTimeout(() => socket.close(), 5000);
  });
}