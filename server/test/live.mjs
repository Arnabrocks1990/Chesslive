// Live smoke test against a deployed instance (Render): accounts, a two-player game over WebSockets,
// the admin login, and the coach paywall endpoint. Does not need the worker.
//   BASE=https://chesslive-web.onrender.com ADMIN_PASSWORD=... node test/live.mjs
import { io } from "socket.io-client";

const BASE = process.env.BASE;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!BASE) { console.error("Set BASE to the deployed URL"); process.exit(2); }
let failed = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  -> " + extra : ""}`); if (!ok) failed++; };
const call = async (path, { body, token } = {}) => {
  const r = await fetch(BASE + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...(token && { authorization: "Bearer " + token }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};
const sock = (token) => new Promise((res, rej) => { const s = io(BASE, { auth: { token }, transports: ["websocket"] }); s.on("connect", () => res(s)); s.on("connect_error", rej); });
const emit = (s, ev, p) => new Promise((r) => s.emit(ev, p, r));
const tag = Math.floor(Math.random() * 1e6);

const a = (await call("/api/register", { body: { username: `live_a${tag}`, password: "secret123" } })).data;
const b = (await call("/api/register", { body: { username: `live_b${tag}`, password: "secret123" } })).data;
check("accounts can be registered on the deployed database", !!a.token && !!b.token);
check("the session survives a round trip (/api/me)", (await call("/api/me", { token: a.token })).data.user?.username === `live_a${tag}`);

const { code } = (await call("/api/games", { body: { color: "white", minutes: 5 }, token: a.token })).data;
const [sa, sb] = [await sock(a.token), await sock(b.token)];
console.log("... websocket connected to the deployed server");
check("both players join", (await emit(sa, "join", code)).ok && (await emit(sb, "join", code)).ok);
const moves = [[sa, "e2", "e4"], [sb, "e7", "e5"], [sa, "g1", "f3"], [sb, "b8", "c6"]];
let ok = true;
for (const [s, from, to] of moves) ok = ok && (await emit(s, "move", { code, from, to })).ok;
check("four moves are accepted and persisted", ok);
check("the wrong side cannot move", (await emit(sb, "move", { code, from: "d2", to: "d4" })).ok === false);
const state = (await call(`/api/games/${code}`)).data;
check("the game state is served from the deployed database", state.moves?.length === 4 && state.status === "active", `${state.moves?.length} moves`);
await emit(sb, "resign", code);
sa.close(); sb.close();
await new Promise((r) => setTimeout(r, 500));
check("resignation finishes the game and updates Elo", (await call(`/api/games/${code}`)).data.status === "finished" && (await call("/api/me", { token: a.token })).data.rating >= 600);

check("the default admin password is refused", (await call("/api/login", { body: { username: "admin", password: "admin123" } })).status === 400);
if (ADMIN_PASSWORD) {
  const adm = await call("/api/login", { body: { username: "admin", password: ADMIN_PASSWORD } });
  check("the configured admin password works", adm.status === 200 && adm.data.user?.role === "admin");
}
check("coach billing endpoint is protected", (await call("/api/billing/coach/1")).status === 401);
check("the Elo leaderboard loads", (await call("/api/leaderboard", { token: a.token })).status === 200);

console.log(failed ? `\n${failed} FAILED` : "\nAll checks passed");
process.exit(failed ? 1 : 0);
