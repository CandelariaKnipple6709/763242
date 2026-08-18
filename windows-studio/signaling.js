/**
 * Same signaling relay as signaling-server/server.js, extracted into a
 * reusable function so it can run embedded inside the Electron main
 * process (no separate `node server.js` step for the Windows app) while
 * staying testable on its own with plain Node.
 *
 * Pairs exactly two peers per room ("sender" = this app, "receiver" =
 * the iOS app) and relays SDP/ICE JSON between them. No media passes
 * through this server at all.
 */
const http = require('http');
const { WebSocketServer } = require('ws');

function otherRole(role) {
  return role === 'sender' ? 'receiver' : 'sender';
}

/**
 * @param {object} opts
 * @param {number} opts.port
 * @param {(msg: string) => void} [opts.log]
 * @returns {{ httpServer: http.Server, wss: WebSocketServer, close: () => void }}
 */
function startSignalingServer({ port, log = () => {} }) {
  const rooms = new Map(); // roomId -> { sender: ws|null, receiver: ws|null }

  function getRoom(roomId) {
    if (!rooms.has(roomId)) rooms.set(roomId, { sender: null, receiver: null });
    return rooms.get(roomId);
  }

  function cleanupSocket(ws) {
    if (!ws.roomId || !ws.role) return;
    const room = rooms.get(ws.roomId);
    if (!room) return;
    if (room[ws.role] === ws) room[ws.role] = null;
    const peer = room[otherRole(ws.role)];
    if (peer && peer.readyState === peer.OPEN) {
      peer.send(JSON.stringify({ type: 'peer-left' }));
    }
    if (!room.sender && !room.receiver) rooms.delete(ws.roomId);
  }

  const httpServer = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (e) { return; }

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

  httpServer.listen(port, '0.0.0.0', () => {
    log(`camswap embedded signaling server listening on :${port}`);
  });

  return {
    httpServer,
    wss,
    close() {
      clearInterval(interval);
      wss.close();
      httpServer.close();
    }
  };
}

module.exports = { startSignalingServer };
