/**
 * Metal Slug Web — Cloudflare Worker + Durable Object Relay
 * =========================================================
 * Serves the static Metal Slug Web build (via Workers Static Assets) AND runs a
 * global low-latency WebSocket Co-op Relay + Room Browser inside a single Durable Object
 * (`MetalSlugRelayHub`).
 *
 * Compatible with the Cloudflare Workers Free Plan (`new_sqlite_classes`).
 *
 * Endpoints:
 *   GET /api/info          -> { mode: "cloudflare-durable-object", activeRooms, defaultRoomPort }
 *   GET /api/rooms         -> { rooms: [{ port, name, game, playerCount, maxPlayers, hasHost, createdAt }] }
 *   WS  /?room=7777&...    -> Upgrades to WebSocket and routes to the MetalSlugRelayHub Durable Object
 */

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

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function parseRoomPort(raw, fallback = DEFAULT_ROOM_PORT) {
  if (!raw) return fallback;
  const n = Number.parseInt(String(raw), 10);
  if (Number.isFinite(n) && n >= MIN_ROOM_PORT && n <= MAX_ROOM_PORT) {
    return n;
  }
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
  const jsonBytes = new TextEncoder().encode(JSON.stringify(payloadObj));
  const out = new Uint8Array(1 + jsonBytes.length);
  out[0] = frameType;
  out.set(jsonBytes, 1);
  return out;
}

function encodeReasonFrame(frameType, reason) {
  const textBytes = new TextEncoder().encode(String(reason || ""));
  const out = new Uint8Array(1 + textBytes.length);
  out[0] = frameType;
  out.set(textBytes, 1);
  return out;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const upgradeHeader = request.headers.get("Upgrade") || "";
    if (
      upgradeHeader.toLowerCase() === "websocket" ||
      url.pathname.startsWith("/api/") ||
      url.pathname === "/ws"
    ) {
      const id = env.RELAY_HUB.idFromName("global-metalslug-hub");
      const stub = env.RELAY_HUB.get(id);
      return stub.fetch(request);
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response("Metal Slug Web Relay Worker is online.", {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8", ...CORS_HEADERS },
    });
  },
};

export class MetalSlugRelayHub {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    /**
     * Map<number, {
     *   port: number,
     *   name: string,
     *   game: string,
     *   createdAt: number,
     *   host: WebSocket | null,
     *   client: WebSocket | null
     * }>
     */
    this.rooms = new Map();
    /**
     * Map<WebSocket, { port: number, role: 1 | 2 }>
     * role 1 = Host (Player 1), role 2 = Client (Player 2)
     */
    this.peers = new Map();
  }

  getRoomSummaries() {
    const list = [];
    for (const [port, room] of this.rooms.entries()) {
      const playerCount = (room.host ? 1 : 0) + (room.client ? 1 : 0);
      if (playerCount === 0) {
        this.rooms.delete(port);
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

  broadcastRoomInfo(room) {
    const payload = {
      port: room.port,
      name: room.name,
      game: room.game,
      playerCount: (room.host ? 1 : 0) + (room.client ? 1 : 0),
      hasHost: Boolean(room.host),
      hasClient: Boolean(room.client),
    };
    if (room.host) {
      this.safeSend(room.host, encodeJsonFrame(FRAME_ROOM_INFO, { ...payload, role: 1 }));
    }
    if (room.client) {
      this.safeSend(room.client, encodeJsonFrame(FRAME_ROOM_INFO, { ...payload, role: 2 }));
    }
  }

  safeSend(ws, data) {
    try {
      ws.send(data);
    } catch (_) {
      // Ignore send errors on closing sockets
    }
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/api/info") {
      const rooms = this.getRoomSummaries();
      return Response.json(
        {
          mode: "cloudflare-durable-object",
          activeRooms: rooms.length,
          defaultRoomPort: DEFAULT_ROOM_PORT,
        },
        { headers: { "Cache-Control": "no-store", ...CORS_HEADERS } }
      );
    }

    if (url.pathname === "/api/rooms") {
      return Response.json(
        { rooms: this.getRoomSummaries() },
        { headers: { "Cache-Control": "no-store", ...CORS_HEADERS } }
      );
    }

    const upgradeHeader = request.headers.get("Upgrade") || "";
    if (upgradeHeader.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket Upgrade", { status: 426, headers: CORS_HEADERS });
    }

    const pair = new WebSocketPair();
    const [clientSocket, serverSocket] = Object.values(pair);
    serverSocket.accept();

    const port = parseRoomPort(url.searchParams.get("room"), DEFAULT_ROOM_PORT);
    const requestedName = url.searchParams.get("name");
    const requestedGame = url.searchParams.get("game");
    const requestedRole = (url.searchParams.get("role") || "auto").toLowerCase();

    let room = this.rooms.get(port);
    if (!room) {
      room = {
        port,
        name: sanitizeRoomName(requestedName, port),
        game: sanitizeGameId(requestedGame),
        createdAt: Date.now(),
        host: null,
        client: null,
      };
      this.rooms.set(port, room);
    } else {
      if (requestedName && !room.host) {
        room.name = sanitizeRoomName(requestedName, port);
      }
      if (requestedGame && !room.host) {
        room.game = sanitizeGameId(requestedGame);
      }
    }

    let assignedRole = 0;
    if (requestedRole === "host") {
      if (room.host) {
        this.safeSend(
          serverSocket,
          encodeReasonFrame(FRAME_REJECTED, `Room ${port} already has a Player 1 Host.`)
        );
        serverSocket.close(1008, "Room already has a host");
        return new Response(null, { status: 101, webSocket: clientSocket });
      }
      assignedRole = 1;
      room.host = serverSocket;
      if (requestedName) room.name = sanitizeRoomName(requestedName, port);
      if (requestedGame) room.game = sanitizeGameId(requestedGame);
    } else if (requestedRole === "client") {
      if (room.client) {
        this.safeSend(
          serverSocket,
          encodeReasonFrame(FRAME_REJECTED, `Room ${port} already has a Player 2 Client.`)
        );
        serverSocket.close(1008, "Room is full");
        return new Response(null, { status: 101, webSocket: clientSocket });
      }
      assignedRole = 2;
      room.client = serverSocket;
    } else {
      // Auto-assign: first player becomes Host (P1), second becomes Client (P2)
      if (!room.host) {
        assignedRole = 1;
        room.host = serverSocket;
        if (requestedName) room.name = sanitizeRoomName(requestedName, port);
        if (requestedGame) room.game = sanitizeGameId(requestedGame);
      } else if (!room.client) {
        assignedRole = 2;
        room.client = serverSocket;
      } else {
        this.safeSend(
          serverSocket,
          encodeReasonFrame(FRAME_REJECTED, `Room ${port} is full (2/2 players).`)
        );
        serverSocket.close(1008, "Room is full (2/2)");
        return new Response(null, { status: 101, webSocket: clientSocket });
      }
    }

    this.peers.set(serverSocket, { port, role: assignedRole });

    // Notify this socket of its assigned role and room info
    this.safeSend(serverSocket, new Uint8Array([FRAME_HOST_ASSIGNED, assignedRole]));
    this.broadcastRoomInfo(room);

    // If both Host and Client are now present, notify both sides that peer is connected
    if (room.host && room.client) {
      if (assignedRole === 2) {
        this.safeSend(room.host, new Uint8Array([FRAME_PEER_CONNECTED, 2]));
        this.safeSend(room.client, new Uint8Array([FRAME_PEER_CONNECTED, 1]));
      } else {
        this.safeSend(room.client, new Uint8Array([FRAME_PEER_CONNECTED, 1]));
        this.safeSend(room.host, new Uint8Array([FRAME_PEER_CONNECTED, 2]));
      }
    }

    serverSocket.addEventListener("message", (event) => {
      this.handleMessage(serverSocket, event.data);
    });

    const onDisconnect = () => {
      this.handleDisconnect(serverSocket);
    };
    serverSocket.addEventListener("close", onDisconnect);
    serverSocket.addEventListener("error", onDisconnect);

    return new Response(null, { status: 101, webSocket: clientSocket });
  }

  handleMessage(ws, rawData) {
    const peer = this.peers.get(ws);
    if (!peer) return;
    const room = this.rooms.get(peer.port);
    if (!room) return;

    let bytes;
    if (rawData instanceof ArrayBuffer) {
      bytes = new Uint8Array(rawData);
    } else if (ArrayBuffer.isView(rawData)) {
      bytes = new Uint8Array(rawData.buffer, rawData.byteOffset, rawData.byteLength);
    } else if (typeof rawData === "string") {
      bytes = new TextEncoder().encode(rawData);
    } else {
      return;
    }

    if (bytes.length < 1) return;
    const frameType = bytes[0];

    if (frameType === FRAME_DATA) {
      const target = peer.role === 1 ? room.client : room.host;
      if (target) {
        this.safeSend(target, bytes);
      }
      return;
    }

    if (frameType === FRAME_UPDATE_ROOM && peer.role === 1) {
      try {
        const meta = JSON.parse(new TextDecoder().decode(bytes.subarray(1)));
        if (meta.name) room.name = sanitizeRoomName(meta.name, room.port);
        if (meta.game) room.game = sanitizeGameId(meta.game);
        this.broadcastRoomInfo(room);
      } catch (_) {
        // Ignore malformed metadata JSON
      }
    }
  }

  handleDisconnect(ws) {
    const peer = this.peers.get(ws);
    if (!peer) return;
    this.peers.delete(ws);

    const room = this.rooms.get(peer.port);
    if (!room) return;

    if (peer.role === 1 && room.host === ws) {
      room.host = null;
      if (room.client) {
        // Promote remaining client to Host (Player 1) so the room stays alive
        const promoted = room.client;
        room.client = null;
        room.host = promoted;
        this.peers.set(promoted, { port: room.port, role: 1 });
        this.safeSend(promoted, new Uint8Array([FRAME_PEER_DISCONNECTED, 1]));
        this.safeSend(promoted, new Uint8Array([FRAME_HOST_ASSIGNED, 1]));
        this.broadcastRoomInfo(room);
      }
    } else if (peer.role === 2 && room.client === ws) {
      room.client = null;
      if (room.host) {
        this.safeSend(room.host, new Uint8Array([FRAME_PEER_DISCONNECTED, 2]));
        this.broadcastRoomInfo(room);
      }
    }

    if (!room.host && !room.client) {
      this.rooms.delete(peer.port);
    }
  }
}
