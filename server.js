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

// PeerJS custom WebSocket server
const peerWss = new WebSocketServer({ noServer: true });
const peerClients = new Map(); // id -> { ws, alive }

peerWss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const peerId = url.searchParams.get('id') || '';
  const token = url.searchParams.get('token') || '';

  if (!peerId) { ws.close(4001, 'Missing id'); return; }
  if (peerClients.has(peerId)) { ws.close(4002, 'ID taken'); return; }

  peerClients.set(peerId, { ws, alive: true });
  ws.send(JSON.stringify({ type: 'OPEN', payload: { id: peerId, token } }));

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
      ws.send(JSON.stringify({ type: 'ERROR', payload: `Peer ${dst} not found` }));
      return;
    }

    if (msg.type === 'OFFER' || msg.type === 'ANSWER' || msg.type === 'CANDIDATE') {
      target.ws.send(JSON.stringify({ type: msg.type, src: peerId, payload: msg.payload }));
    } else if (msg.type === 'LEAVE') {
      target.ws.send(JSON.stringify({ type: 'LEAVE', src: peerId }));
    }
  });

  ws.on('close', () => {
    peerClients.delete(peerId);
    peerClients.forEach((entry) => {
      entry.ws.send(JSON.stringify({ type: 'LEAVE', src: peerId }));
    });
  });

  ws.on('pong', () => {
    const entry = peerClients.get(peerId);
    if (entry) entry.alive = true;
  });
});

// Heartbeat interval
setInterval(() => {
  peerClients.forEach((entry, id) => {
    if (!entry.alive) {
      entry.ws.terminate();
      peerClients.delete(id);
      return;
    }
    entry.alive = false;
    entry.ws.ping();
  });
}, 30000);

// Route WebSocket upgrades — Socket.IO and PeerJS must not conflict
const ioListeners = server.rawListeners('upgrade');
server.removeAllListeners('upgrade');
server.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname.startsWith('/socket.io')) {
    // Forward to Socket.IO
    for (const fn of ioListeners) {
      fn.call(server, req, socket, head);
    }
  } else {
    // Forward to PeerJS WebSocket server
    peerWss.handleUpgrade(req, socket, head, (ws) => {
      peerWss.emit('connection', ws, req);
    });
  }
});

// Keep existing Socket.IO signaling
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
