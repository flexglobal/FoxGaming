const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { PeerServer } = require("peer");

const port = process.env.PORT || 10000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: CORS_ORIGIN, methods: ["GET", "POST"] },
});

app.get("/health", (_, res) => res.sendStatus(200));

PeerServer({ server, path: "/peerjs", allowDiscovery: true });

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
