const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { WebSocketServer } = require("ws");

const port = process.env.PORT || 10000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: CORS_ORIGIN, methods: ["GET", "POST"] },
});

app.get("/health", (_, res) => res.sendStatus(200));

// PeerJS WebSocket server — подключается напрямую к server, фильтр по пути /peerjs
const peerWss = new WebSocketServer({ server, path: '/peerjs' });
const peerClients = new Map();

peerWss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const peerId = url.searchParams.get('id') || '';
  const token = url.searchParams.get('token') || '';

  console.log(`[PeerJS] connection: id=${peerId} token=${token}`);

  if (!peerId) {
    console.log(`[PeerJS] rejected: missing id`);
    ws.close(4001, 'Missing id');
    return;
  }

  if (peerClients.has(peerId)) {
    console.log(`[PeerJS] replacing old session for id=${peerId}`);
    try { peerClients.get(peerId).ws.close(4003, 'Replaced'); } catch {}
    peerClients.delete(peerId);
  }

  peerClients.set(peerId, { ws, alive: true });

  ws.send(JSON.stringify({ type: 'OPEN', payload: { id: peerId, token } }));
  console.log(`[PeerJS] connected: ${peerId}`);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'HEARTBEAT') {
      const entry = peerClients.get(peerId);
      if (entry) entry.alive = true;
      return;
    }

    const dst = msg.dst;
    if (!dst) return;

    const target = peerClients.get(dst);
    if (!target) {
      return;
    }

    if (msg.type === 'OFFER' || msg.type === 'ANSWER' || msg.type === 'CANDIDATE') {
      console.log(`[PeerJS] relay ${msg.type} from ${peerId} to ${dst}`);
      try { target.ws.send(JSON.stringify({ type: msg.type, src: peerId, payload: msg.payload })); } catch {}
    } else if (msg.type === 'LEAVE') {
      try { target.ws.send(JSON.stringify({ type: 'LEAVE', src: peerId })); } catch {}
    }
  });

  ws.on('close', (code) => {
    console.log(`[PeerJS] disconnected: ${peerId} code=${code}`);
    peerClients.delete(peerId);
  });

  ws.on('error', (err) => {
    console.error(`[PeerJS] ws error: ${peerId}`, err.message);
  });

  ws.on('pong', () => {
    const entry = peerClients.get(peerId);
    if (entry) entry.alive = true;
  });
});

// Heartbeat every 30s
setInterval(() => {
  peerClients.forEach((entry, id) => {
    if (!entry.alive) {
      console.log(`[PeerJS] heartbeat timeout: ${id}`);
      entry.ws.terminate();
      peerClients.delete(id);
      return;
    }
    entry.alive = false;
    entry.ws.ping();
  });
}, 30000);

// Existing Socket.IO signaling
const peers = new Map();
io.on("connection", (socket) => {
  const id = socket.id;
  peers.set(id, { socket });
  socket.emit("registered", { id });

  socket.on("signal", ({ to, data }) => {
    const target = peers.get(to);
    if (target) {
      target.socket.emit("signal", { from: id, data });
    }
  });

  socket.on("disconnect", () => {
    peers.delete(id);
    socket.broadcast.emit("peer-left", { id });
  });
});

server.listen(port, () => {
  console.log(`Сервер запущен на порту ${port}`);
});
