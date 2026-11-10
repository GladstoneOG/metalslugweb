/**
 * Metal Slug Web — Multiplayer Relay Configuration
 * =================================================
 *
 * Leave `window.METALSLUG_RELAY_URL = ""` when deploying to Cloudflare Workers
 * (single command `npx wrangler deploy`) or running `npm start` locally —
 * the browser automatically connects to the same origin over `wss://` or `ws://`.
 *
 * If you host the static `/public` files separately (e.g. GitHub Pages) while running
 * the relay on Cloudflare Workers, set `window.METALSLUG_RELAY_URL` to your Worker URL:
 *   window.METALSLUG_RELAY_URL = "https://metalslugweb.<your-subdomain>.workers.dev";
 */
window.METALSLUG_RELAY_URL = window.METALSLUG_RELAY_URL || "";
