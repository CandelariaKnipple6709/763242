/**
 * camswap signaling server
 * ---------------------------------------------------------------
 * Two jobs in one small server:
 *
 *  1. Serves the "studio" control page (./public/studio.html) as a
 *     plain static site — this is the page the moderator opens in
 *     any Windows browser. No OBS, no separate app: they upload and
 *     edit image scenes right there and switch which one is live.
 *
 *  2. Runs a minimal WebSocket relay that pairs exactly two peers in
 *     a "room":
 *       - the "sender" (the studio page, publishing whatever scene
 *         is currently live as a canvas-captured WebRTC video track)
 *       - the "receiver" (the WKUserScript running inside the iOS
 *         app's WKWebView)
 *
 *     The relay does NOT touch media at all — it only forwards JSON
 *     signaling messages (SDP offers/answers, ICE candidates)
 *     between the two sockets in the same room. Video flows directly
 *     peer-to-peer over WebRTC once the connection is established.
 *
 * Run:
 *   npm install
 *   PORT=8080 node server.js
 *   -> open http://localhost:8080/ for the studio page
 *
 * For real usage put this behind TLS (wss:// / https://), e.g. via a
 * reverse proxy (nginx/Caddy) or a host that terminates TLS for you.
 * Browsers (including WKWebView) will refuse plain ws:// signaling
 * from an https:// page, and mixed-content rules on iOS are strict,
 * so wss:// is effectively required outside of local testing.
 * ---------------------------------------------------------------
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function serveStatic(req, res) {
  let reqPath = req.url.split('?')[0];
  if (reqPath === '/') reqPath = '/studio.html';

  // Strip any ".." segments so requests can't escape PUBLIC_DIR.
  const safePath = path.normalize(reqPath).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// roomId -> { sender: ws|null, receiver: ws|null }
const rooms = new Map();

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, { sender: null, receiver: null });
  }
  return rooms.get(roomId);
}

function otherRole(role) {
  return role === 'sender' ? 'receiver' : 'sender';
}

function cleanupSocket(ws) {
  if (!ws.roomId || !ws.role) return;
  const room = rooms.get(ws.roomId);
  if (!room) return;
  if (room[ws.role] === ws) {
    room[ws.role] = null;
  }
  // notify the peer, if still connected
  const peer = room[otherRole(ws.role)];
  if (peer && peer.readyState === peer.OPEN) {
    peer.send(JSON.stringify({ type: 'peer-left' }));
  }
  if (!room.sender && !room.receiver) {
    rooms.delete(ws.roomId);
  }
}

const httpServer = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }
  serveStatic(req, res);
});

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      return; // ignore malformed frames
    }

    // First message from any client must be a "join"
    if (msg.type === 'join') {
      const { room: roomId, role } = msg;
      if (!roomId || (role !== 'sender' && role !== 'receiver')) {
        ws.send(JSON.stringify({ type: 'error', message: 'join requires room and role (sender|receiver)' }));
        return;
      }
      const room = getRoom(roomId);
      if (room[role]) {
        ws.send(JSON.stringify({ type: 'error', message: `a ${role} is already connected to room ${roomId}` }));
        ws.close();
        return;
      }
      room[role] = ws;
      ws.roomId = roomId;
      ws.role = role;
      ws.send(JSON.stringify({ type: 'joined', room: roomId, role }));

      const peer = room[otherRole(role)];
      if (peer && peer.readyState === peer.OPEN) {
        peer.send(JSON.stringify({ type: 'peer-joined' }));
        ws.send(JSON.stringify({ type: 'peer-joined' }));
      }
      return;
    }

    // All other message types (offer/answer/ice-candidate/bye) are
    // just forwarded verbatim to whichever peer is in the same room.
    if (!ws.roomId || !ws.role) return;
    const room = rooms.get(ws.roomId);
    if (!room) return;
    const peer = room[otherRole(ws.role)];
    if (peer && peer.readyState === peer.OPEN) {
      peer.send(JSON.stringify(msg));
    }
  });

  ws.on('close', () => cleanupSocket(ws));
  ws.on('error', () => cleanupSocket(ws));
});

// Basic liveness ping so dead sockets (e.g. phone backgrounded /
// network dropped) get cleaned up instead of leaking a "ghost" peer.
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      cleanupSocket(ws);
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => clearInterval(interval));

httpServer.listen(PORT, () => {
  console.log(`camswap signaling server listening on :${PORT}`);
});
