const http = require("http");
const path = require("path");
const express = require("express");
const { Server } = require("socket.io");

const { registerSocketHandlers } = require("./sockets");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;
const publicDir = path.join(__dirname, "..", "public");

app.use(express.static(publicDir));

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

registerSocketHandlers(io);

server.listen(PORT, () => {
  console.log(`Quiz server running on http://localhost:${PORT}`);
});
