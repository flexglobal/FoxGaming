const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const port = process.env.PORT || 10000; // Render часто использует 10000
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: CORS_ORIGIN, methods: ["GET", "POST"] },
});

app.get("/health", (_, res) => res.sendStatus(200));

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
  console.log(`Сигналинг запущен на порту ${port}`);
});
