const http = require("http");
const os = require("os");
const path = require("path");
const express = require("express");
const { Server } = require("socket.io");

const { registerSocketHandlers } = require("./sockets");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const HOST = process.env.HOST || "0.0.0.0";
const PORT = process.env.PORT || 3000;
const publicDir = path.join(__dirname, "..", "public");
const contentSecurityPolicy = [
  "default-src 'self'",
  "img-src 'self' https://api.dicebear.com data: blob:",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self' ws: wss:",
].join("; ");

function getNetworkUrls(port) {
  const interfaces = os.networkInterfaces();
  const urls = [];

  for (const addresses of Object.values(interfaces)) {
    for (const address of addresses || []) {
      if (address.family !== "IPv4" || address.internal) {
        continue;
      }

      urls.push(`http://${address.address}:${port}`);
    }
  }

  return urls;
}

app.use((_, res, next) => {
  res.setHeader("Content-Security-Policy", contentSecurityPolicy);
  next();
});

app.use(express.static(publicDir));

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

registerSocketHandlers(io);

server.listen(PORT, HOST, () => {
  console.log(`Quiz server running on http://localhost:${PORT}`);

  const networkUrls = getNetworkUrls(PORT);
  if (networkUrls.length > 0) {
    console.log("Available on the local network:");
    for (const url of networkUrls) {
      console.log(`  - ${url}`);
    }
  }
});
