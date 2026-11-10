# 🔥 Metal Slug Web Anthology (Metal Slug 1, 2 & 3) — 2-Player Online Co-op

A browser-native port of **Metal Slug (1996)**, **Metal Slug 2 (1998)**, and **Metal Slug 3 (2000)** running on a patched **FinalBurn Neo (FBNeo) Libretro WebAssembly** engine with **full 2-Player Online Co-op** powered by **Cloudflare Workers + Durable Objects** and **WebRTC P2P DataChannels**.

---

## ✨ Features

- **Complete Anthology in One App**: Switch seamlessly between **Metal Slug 1**, **Metal Slug 2**, and **Metal Slug 3** from the top arcade bar.
- **2-Player Online Co-op (Cloudflare Durable Objects + WebRTC P2P)**:
  - **Host Co-op / Room Browser / Invite Links (`?room=7777`)**: Create a room and share a 1-click invite link, or browse live rooms in the Room Browser.
  - **Automatic Machine-State Sync**: When Player 2 joins (or when the Host clicks **🔄 Sync Now**), the Host captures the live Neo Geo MVS hardware state (~1.5 MB), compresses it in-browser with `CompressionStream("gzip")` (~200 KB), and streams it to Player 2 so both emulators start from the exact same CPU cycle.
  - **60 FPS Deterministic Lockstep + WebRTC P2P Upgrade**: Exchanges 14-byte dual-redundant input frames (`[frame, mask, prevFrame, prevMask]`) over an unordered, zero-retransmit WebRTC `RTCDataChannel` with automatic fallback to the Cloudflare Durable Object WebSocket relay.
- **Cloudflare Workers Free Plan & GitHub Ready**:
  - Every static asset in `public/` is `<19 MiB` (well below Cloudflare Workers' 25 MiB limit and GitHub's 100 MiB limit). `mslug3.zip` is automatically split into 18 MiB chunks (`public/roms/chunks/mslug3.zip.part00`, `.part01`) and reassembled + cached in `IndexedDB` (`metalslug-cache-v1`).
  - `fbneo_libretro.wasm` is pre-patched for instant Metal Slug 3 decrypted C-ROM boot and gzipped to `10.80 MiB` (`public/cores/fbneo_libretro.wasm.bin`).

---

## 🚀 Quick Start (Local Development)

No external npm packages are required to run the local HTTP + WebSocket Co-op Relay server:

```bash
cd metalslugweb
node server.js
```

Then open **http://localhost:8080** in two browser windows:
1. In Window 1, click **📡 Host Co-op** -> **Create Room & Copy Link**.
2. In Window 2, open the copied invite link (e.g. `http://localhost:8080/?game=mslug&room=7777`) or click **🌐 Rooms** -> **Join P2**.
3. Click **🪙 Insert Coin** and **▶️ Start** on both players to play 2-Player Co-op!

---

## ☁️ Deploying to Cloudflare Workers + Durable Objects

This project is pre-configured in [`wrangler.toml`](./wrangler.toml) to deploy both the static game files (`./public`) and the `MetalSlugRelayHub` SQLite Durable Object (supported on the **Cloudflare Workers Free Plan**) in a single command:

```bash
cd metalslugweb
npx wrangler login
npx wrangler deploy
```

### Connecting GitHub (`https://github.com/GladstoneOG/metalslugweb`) to Cloudflare Workers Builds

If you connect your GitHub repository directly in the **Cloudflare Dashboard** (**Workers & Pages** -> **Create application** -> **Import a repository** -> select `GladstoneOG/metalslugweb`):
- **Build command**: *(leave empty, or `echo "Prebuilt static assets"`)*
- **Deploy command**: `npx wrangler deploy`
- Everything (Workers Static Assets + `MetalSlugRelayHub` Durable Object migration) is configured automatically via `wrangler.toml`.

---

## 🎮 Controls

| Arcade Action | Keyboard (Primary / Online) | Gamepad | Local P2 (Same Keyboard) |
| :--- | :--- | :--- | :--- |
| **Move / Aim** | `W` `A` `S` `D` or `Arrow Keys` | D-Pad / Left Stick | `Numpad 8/4/5/6` |
| **🔫 Fire Weapon (A)** | `J` or `Z` | West / Square (`X`) | `Numpad 1` |
| **🦘 Jump (B)** | `K` or `X` | South / Cross (`A`) | `Numpad 2` |
| **💣 Grenade / Bomb (C)** | `L` or `C` or `U` | North / RB (`Y`) | `Numpad 3` |
| **🚜 Slug Attack / Eject (D)** | `I` or `V` or `Space` | LB / Circle (`B`) | `Numpad 4` |
| **🪙 Insert Coin** | `5` or `Backspace` (or top bar button) | `Select` / `Back` | `Numpad 0` |
| **▶️ Start** | `1` or `Enter` (or top bar button) | `Start` | `Numpad Enter` / `2` |

---

## 🛠️ Rebuilding ROM Archives & Patched Core

If you ever need to regenerate `public/roms/*`, `public/cores/*`, and `public/assets/*` from the parent folder's GOG/DotEmu `Metal Slug`, `Metal Slug 2`, and `Metal Slug 3` directories:

```bash
python tools/build_web_roms.py
```
