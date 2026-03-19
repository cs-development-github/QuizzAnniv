const http = require("http");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const { Server } = require("socket.io");
const QRCode = require("qrcode");

const {
  registerSocketHandlers,
  listRooms,
  closeRoomById,
  createRoom,
} = require("./sockets");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const HOST = process.env.HOST || "0.0.0.0";
const PORT = process.env.PORT || 3000;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "";
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

function getPreferredBaseUrl(req) {
  if (PUBLIC_BASE_URL) {
    return PUBLIC_BASE_URL.replace(/\/$/, "");
  }

  const forwardedProtoHeader = req.get("x-forwarded-proto");
  const forwardedHost = req.get("x-forwarded-host");
  const forwardedProto = forwardedProtoHeader
    ? forwardedProtoHeader.split(",")[0].trim()
    : "";

  if (forwardedProto && forwardedHost) {
    return `${forwardedProto}://${forwardedHost}`;
  }

  return `${req.protocol}://${req.get("host")}`;
}

app.use((_, res, next) => {
  res.setHeader("Content-Security-Policy", contentSecurityPolicy);
  next();
});

app.use(express.static(publicDir));
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/", (_req, res) => {
  res.redirect("/admin");
});

app.get("/admin", (_req, res) => {
  res.sendFile(path.join(publicDir, "admin.html"));
});

app.get("/room-admin", (_req, res) => {
  res.sendFile(path.join(publicDir, "room-admin.html"));
});

app.get("/room/:roomId", (_req, res) => {
  res.sendFile(path.join(publicDir, "room.html"));
});

app.post("/api/rooms", async (req, res) => {
  const roomId = crypto.randomUUID().slice(0, 8);
  createRoom(roomId);
  const joinUrl = `${getPreferredBaseUrl(req)}/room/${roomId}`;
  const qrCodeDataUrl = await QRCode.toDataURL(joinUrl, {
    margin: 1,
    width: 320,
    color: {
      dark: "#2d1f24",
      light: "#fffaf5",
    },
  });

  res.status(201).json({
    roomId,
    joinUrl,
    qrCodeDataUrl,
  });
});

app.get("/api/room-admin/rooms", (_req, res) => {
  res.json({
    rooms: listRooms(),
  });
});

app.delete("/api/room-admin/rooms/:roomId", (req, res) => {
  const closed = closeRoomById(io, req.params.roomId);

  if (!closed) {
    res.status(404).json({ message: "Room introuvable." });
    return;
  }

  res.json({ ok: true });
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
