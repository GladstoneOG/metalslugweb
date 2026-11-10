#!/usr/bin/env node
/**
 * Metal Slug Web — Local Zero-Dependency HTTP & Co-op WebSocket Relay Server
 * ==========================================================================
 * Mirrors the exact protocol of `cloudflare_worker.js` (`MetalSlugRelayHub`)
 * so local development (`node server.js` / `npm start`) behaves identically
 * to production Cloudflare Workers + Durable Objects.
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number.parseInt(process.env.PORT || "8080", 10);
const PUBLIC_DIR = path.join(__dirname, "public");

const FRAME_DATA = 0x01;
const FRAME_PEER_CONNECTED = 0x02;
const FRAME_PEER_DISCONNECTED = 0x03;
const FRAME_ROOM_INFO = 0x04;
const FRAME_HOST_ASSIGNED = 0x05;
const FRAME_UPDATE_ROOM = 0x06;
const FRAME_REJECTED = 0xff;

const DEFAULT_ROOM_PORT = 7777;
const MIN_ROOM_PORT = 1024;
const MAX_ROOM_PORT = 65535;
const VALID_GAMES = new Set(["mslug", "mslug2", "mslug3"]);

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".bin": "application/octet-stream",
  ".zip": "application/zip",
};

/**
 * Lightweight RFC 6455 WebSocket wrapper over a raw Node.js net.Socket
 */
class MiniWebSocket {
  constructor(socket) {
    this.socket = socket;
    this.closed = false;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = 0;
    this.onMessage = null;
    this.onClose = null;

    socket.setNoDelay(true);
    socket.on("data", (chunk) => this._onData(chunk));
    socket.on("close", () => this._emitClose());
    socket.on("error", () => this._emitClose());
  }

  _emitClose() {
    if (this.closed) return;
    this.closed = true;
    if (this.onClose) this.onClose();
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const firstByte = this.buffer[0];
      const secondByte = this.buffer[1];
      const fin = (firstByte & 0x80) !== 0;
      const opcode = firstByte & 0x0f;
      const masked = (secondByte & 0x80) !== 0;
      let payloadLen = secondByte & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (this.buffer.length < 4) return;
        payloadLen = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (this.buffer.length < 10) return;
        payloadLen = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }

      const maskLen = masked ? 4 : 0;
      if (this.buffer.length < offset + maskLen + payloadLen) return;

      const maskKey = masked ? this.buffer.subarray(offset, offset + 4) : null;
      offset += maskLen;
      const payload = Buffer.from(this.buffer.subarray(offset, offset + payloadLen));
      this.buffer = this.buffer.subarray(offset + payloadLen);

      if (masked && maskKey) {
        for (let i = 0; i < payload.length; i++) {
          payload[i] ^= maskKey[i & 3];
        }
      }

      if (opcode === 0x08) {
        // Close frame
        this.close();
        return;
      } else if (opcode === 0x09) {
        // Ping -> Pong
        this._sendFrame(0x0a, payload);
      } else if (opcode === 0x0a) {
        // Pong
      } else if (opcode === 0x01 || opcode === 0x02 || opcode === 0x00) {
        if (opcode !== 0x00) {
          this.fragmentOpcode = opcode;
          this.fragments = [payload];
        } else {
          this.fragments.push(payload);
        }
        if (fin) {
          const fullPayload = Buffer.concat(this.fragments);
          this.fragments = [];
          if (this.onMessage) {
            this.onMessage(new Uint8Array(fullPayload.buffer, fullPayload.byteOffset, fullPayload.byteLength));
          }
        }
      }
    }
  }

  _sendFrame(opcode, dataBuffer) {
    if (this.closed || !this.socket.writable) return;
    const len = dataBuffer.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x80 | opcode;
      header[1] = len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    try {
      this.socket.write(Buffer.concat([header, dataBuffer]));
    } catch (_) {
      this._emitClose();
    }
  }

  send(uint8OrBuffer) {
    const buf = Buffer.isBuffer(uint8OrBuffer)
      ? uint8OrBuffer
      : Buffer.from(uint8OrBuffer.buffer, uint8OrBuffer.byteOffset, uint8OrBuffer.byteLength);
    this._sendFrame(0x02, buf);
  }

  close() {
    if (this.closed) return;
    try {
      this._sendFrame(0x08, Buffer.alloc(0));
      this.socket.end();
    } catch (_) {}
    this._emitClose();
  }
}

const rooms = new Map();
const peers = new Map();

function parseRoomPort(raw, fallback = DEFAULT_ROOM_PORT) {
  if (!raw) return fallback;
  const n = Number.parseInt(String(raw), 10);
  if (Number.isFinite(n) && n >= MIN_ROOM_PORT && n <= MAX_ROOM_PORT) return n;
  return fallback;
}

function sanitizeRoomName(raw, port) {
  const cleaned = String(raw || "")
    .replace(/[\r\n\t<>]/g, " ")
    .trim()
    .slice(0, 40);
  return cleaned || `Mission #${port}`;
}

function sanitizeGameId(raw) {
  const cleaned = String(raw || "").trim().toLowerCase();
  return VALID_GAMES.has(cleaned) ? cleaned : "mslug";
}

function encodeJsonFrame(frameType, payloadObj) {
  const jsonBytes = Buffer.from(JSON.stringify(payloadObj), "utf-8");
  const out = Buffer.alloc(1 + jsonBytes.length);
  out[0] = frameType;
  jsonBytes.copy(out, 1);
  return out;
}

function encodeReasonFrame(frameType, reason) {
  const textBytes = Buffer.from(String(reason || ""), "utf-8");
  const out = Buffer.alloc(1 + textBytes.length);
  out[0] = frameType;
  textBytes.copy(out, 1);
  return out;
}

function getRoomSummaries() {
  const list = [];
  for (const [port, room] of rooms.entries()) {
    const playerCount = (room.host ? 1 : 0) + (room.client ? 1 : 0);
    if (playerCount === 0) {
      rooms.delete(port);
      continue;
    }
    list.push({
      port,
      name: room.name,
      game: room.game,
      playerCount,
      maxPlayers: 2,
      hasHost: Boolean(room.host),
      hasClient: Boolean(room.client),
      createdAt: room.createdAt,
    });
  }
  list.sort((a, b) => b.createdAt - a.createdAt);
  return list;
}

function broadcastRoomInfo(room) {
  const payload = {
    port: room.port,
    name: room.name,
    game: room.game,
    playerCount: (room.host ? 1 : 0) + (room.client ? 1 : 0),
    hasHost: Boolean(room.host),
    hasClient: Boolean(room.client),
  };
  if (room.host) room.host.send(encodeJsonFrame(FRAME_ROOM_INFO, { ...payload, role: 1 }));
  if (room.client) room.client.send(encodeJsonFrame(FRAME_ROOM_INFO, { ...payload, role: 2 }));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (url.pathname === "/api/info") {
    const activeRooms = getRoomSummaries();
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(
      JSON.stringify({
        mode: "local-node-relay",
        activeRooms: activeRooms.length,
        defaultRoomPort: DEFAULT_ROOM_PORT,
      })
    );
    return;
  }

  if (url.pathname === "/api/rooms") {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ rooms: getRoomSummaries() }));
    return;
  }

  let reqPath = decodeURIComponent(url.pathname);
  if (reqPath === "/") reqPath = "/index.html";

  const filePath = path.normalize(path.join(PUBLIC_DIR, reqPath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": stat.size,
      "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=3600",
    });
    fs.createReadStream(filePath).pipe(res);
  });
});

server.on("upgrade", (req, socket) => {
  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }

  const acceptKey = crypto
    .createHash("sha1")
    .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");

  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${acceptKey}`,
      "\r\n",
    ].join("\r\n")
  );

  const ws = new MiniWebSocket(socket);
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const port = parseRoomPort(url.searchParams.get("room"), DEFAULT_ROOM_PORT);
  const requestedName = url.searchParams.get("name");
  const requestedGame = url.searchParams.get("game");
  const requestedRole = (url.searchParams.get("role") || "auto").toLowerCase();

  let room = rooms.get(port);
  if (!room) {
    room = {
      port,
      name: sanitizeRoomName(requestedName, port),
      game: sanitizeGameId(requestedGame),
      createdAt: Date.now(),
      host: null,
      client: null,
    };
    rooms.set(port, room);
  } else {
    if (requestedName && !room.host) room.name = sanitizeRoomName(requestedName, port);
    if (requestedGame && !room.host) room.game = sanitizeGameId(requestedGame);
  }

  let assignedRole = 0;
  if (requestedRole === "host") {
    if (room.host) {
      ws.send(encodeReasonFrame(FRAME_REJECTED, `Room ${port} already has a Player 1 Host.`));
      ws.close();
      return;
    }
    assignedRole = 1;
    room.host = ws;
    if (requestedName) room.name = sanitizeRoomName(requestedName, port);
    if (requestedGame) room.game = sanitizeGameId(requestedGame);
  } else if (requestedRole === "client") {
    if (room.client) {
      ws.send(encodeReasonFrame(FRAME_REJECTED, `Room ${port} already has a Player 2 Client.`));
      ws.close();
      return;
    }
    assignedRole = 2;
    room.client = ws;
  } else {
    if (!room.host) {
      assignedRole = 1;
      room.host = ws;
      if (requestedName) room.name = sanitizeRoomName(requestedName, port);
      if (requestedGame) room.game = sanitizeGameId(requestedGame);
    } else if (!room.client) {
      assignedRole = 2;
      room.client = ws;
    } else {
      ws.send(encodeReasonFrame(FRAME_REJECTED, `Room ${port} is full (2/2 players).`));
      ws.close();
      return;
    }
  }

  peers.set(ws, { port, role: assignedRole });
  ws.send(Buffer.from([FRAME_HOST_ASSIGNED, assignedRole]));
  broadcastRoomInfo(room);

  if (room.host && room.client) {
    if (assignedRole === 2) {
      room.host.send(Buffer.from([FRAME_PEER_CONNECTED, 2]));
      room.client.send(Buffer.from([FRAME_PEER_CONNECTED, 1]));
    } else {
      room.client.send(Buffer.from([FRAME_PEER_CONNECTED, 1]));
      room.host.send(Buffer.from([FRAME_PEER_CONNECTED, 2]));
    }
  }

  ws.onMessage = (bytes) => {
    const peer = peers.get(ws);
    if (!peer || bytes.length < 1) return;
    const r = rooms.get(peer.port);
    if (!r) return;

    const frameType = bytes[0];
    if (frameType === FRAME_DATA) {
      const target = peer.role === 1 ? r.client : r.host;
      if (target) target.send(bytes);
      return;
    }

    if (frameType === FRAME_UPDATE_ROOM && peer.role === 1) {
      try {
        const meta = JSON.parse(Buffer.from(bytes.subarray(1)).toString("utf-8"));
        if (meta.name) r.name = sanitizeRoomName(meta.name, r.port);
        if (meta.game) r.game = sanitizeGameId(meta.game);
        broadcastRoomInfo(r);
      } catch (_) {}
    }
  };

  ws.onClose = () => {
    const peer = peers.get(ws);
    if (!peer) return;
    peers.delete(ws);
    const r = rooms.get(peer.port);
    if (!r) return;

    if (peer.role === 1 && r.host === ws) {
      r.host = null;
      if (r.client) {
        const promoted = r.client;
        r.client = null;
        r.host = promoted;
        peers.set(promoted, { port: r.port, role: 1 });
        promoted.send(Buffer.from([FRAME_PEER_DISCONNECTED, 1]));
        promoted.send(Buffer.from([FRAME_HOST_ASSIGNED, 1]));
        broadcastRoomInfo(r);
      }
    } else if (peer.role === 2 && r.client === ws) {
      r.client = null;
      if (r.host) {
        r.host.send(Buffer.from([FRAME_PEER_DISCONNECTED, 2]));
        broadcastRoomInfo(r);
      }
    }

    if (!r.host && !r.client) {
      rooms.delete(peer.port);
    }
  };
});

server.listen(PORT, () => {
  console.log(`\n========================================================`);
  console.log(`  METAL SLUG WEB (1, 2 & 3) — ONLINE CO-OP SERVER`);
  console.log(`  Local URL:  http://localhost:${PORT}`);
  console.log(`  Co-op Hub:  ws://localhost:${PORT}/?room=7777`);
  console.log(`========================================================\n`);
});
