// Admin controls: block / unblock a user, revoke a coach profile, online-now count, analyses used per user.
//   BASE=http://localhost:8011 ADMIN_PASSWORD=admin123 node test/admin-controls.mjs
import pg from "pg";
import { io } from "socket.io-client";

const BASE = process.env.BASE || "http://localhost:8001";
const DB = process.env.DATABASE_URL || "postgresql://chess:chess@localhost:5455/chess";
let failed = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  -> " + extra : ""}`); if (!ok) failed++; };
const call = async (path, { body, token } = {}) => {
  const r = await fetch(BASE + path, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", ...(token && { authorization: "Bearer " + token }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = Math.floor(Math.random() * 1e6);
const reg = async (n) => (await call("/api/register", { body: { username: `${n}${tag}`, password: "secret123" } })).data;
const sock = (u) => new Promise((res, rej) => { const s = io(BASE, { auth: { token: u.token }, transports: ["websocket"] }); s.on("connect", () => res(s)); s.on("connect_error", rej); });
const emit = (s, ev, p) => new Promise((r) => s.emit(ev, p, r));

const admin = (await call("/api/login", { body: { username: "admin", password: process.env.ADMIN_PASSWORD || "admin123" } })).data;
if (!admin.token) { console.error("Cannot log in as admin (set ADMIN_PASSWORD)"); process.exit(2); }
const A = (path, body) => call("/api/admin" + path, { token: admin.token, body });
const X = await reg("acX"), Y = await reg("acY");
const xid = X.user.id;

// ---- online now
await call("/api/me", { token: X.token }); await call("/api/me", { token: Y.token });
await wait(800);
const ov = (await A("/overview")).data;
check("overview counts users who are online now", ov.totals.online_now >= 3 && ov.online.some((o) => o.username === `acX${tag}`), `${ov.totals.online_now} online`);
const list = (await A(`/users?q=ac`)).data;
const rx = list.find((u) => u.id === xid);
check("the users list flags them online and carries analysis counts", rx?.online === true && typeof rx.positions_analysed === "number" && typeof rx.coach_runs === "number" && typeof rx.coach_positions === "number" && typeof rx.games_analysed === "number");

// ---- analyses per user, from a real analysed game (needs the Stockfish worker)
const sx = await sock(X), sy = await sock(Y);
const { code } = (await call("/api/games", { token: X.token, body: { color: "white", minutes: 10 } })).data;
await emit(sx, "join", code); await emit(sy, "join", code);
const line = [["e2", "e4"], ["e7", "e5"], ["g1", "f3"], ["b8", "c6"], ["f1", "c4"], ["f8", "c5"], ["e1", "g1"], ["d8", "h4"], ["f3", "h4"]];
for (let i = 0; i < line.length; i++) await emit(i % 2 ? sy : sx, "move", { code, from: line[i][0], to: line[i][1] });
await emit(sy, "resign", code);
let counted = null;
for (let i = 0; i < 40 && !counted; i++) {
  await wait(2000);
  const r = (await A(`/users?q=acX${tag}`)).data[0];
  if (r && r.positions_analysed >= 9) counted = r;
}
if (counted) check("analyses used = positions Stockfish evaluated in their games", counted.games_analysed === 1 && counted.positions_analysed >= 10, `${counted.positions_analysed} positions, ${counted.games_analysed} game`);
else console.log("SKIP  analyses per user: no analysis arrived in 80s (is the Stockfish worker running?)");
const detail = (await A(`/users/${xid}`)).data;
check("user detail carries the same breakdown and no block", detail.user.blocked_at === null && "positions_analysed" in detail.user && Array.isArray(detail.profiles));

// ---- block / unblock
check("a normal user cannot call the admin API", (await call(`/api/admin/users/${xid}/block`, { token: Y.token, body: {} })).status === 401);
check("an admin cannot block themselves", (await A(`/users/${admin.user.id}/block`, {})).status === 400);
check("an unknown user is a 404", (await A(`/users/99999999/block`, {})).status === 404);
let kicked = false; sx.on("blocked", () => (kicked = true)); let closed = false; sx.on("disconnect", () => (closed = true));
const blk = await A(`/users/${xid}/block`, { note: "spamming" });
check("admin can block a user (with a reason)", blk.status === 200);
check("their existing session stops working at once", (await call("/api/me", { token: X.token })).status === 401);
check("they cannot sign in again, and are told why", (await call("/api/login", { body: { username: `acX${tag}`, password: "secret123" } })).data.error?.includes("blocked"));
await wait(6500);
check("their open game connection is dropped", closed || !sx.connected, `blocked event: ${kicked}`);
check("the list and detail show them blocked with the reason", (await A(`/users?q=acX${tag}`)).data[0].blocked_at && (await A(`/users/${xid}`)).data.user.blocked_reason === "spamming");
check("other users are unaffected", (await call("/api/me", { token: Y.token })).status === 200);
check("the audit log records it", (await A("/audit")).data.some((a) => a.action === "user.block" && a.target_id === xid));
const un = await A(`/users/${xid}/unblock`, {});
const back = await call("/api/login", { body: { username: `acX${tag}`, password: "secret123" } });
check("unblocking lets them sign in again", un.status === 200 && !!back.data.token && (await call("/api/me", { token: back.data.token })).status === 200);

// ---- coach profile revoke
const pgn = '[Event "x"]\n[White "You"]\n[Black "Opp"]\n[Result "1-0"]\n\n1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0';
const prof = (await call("/api/coach/players", { token: back.data.token, body: { platform: "pgn", color: "white", pgn } })).data;
check("a coach profile is created (PGN needs no verification)", !!prof.playerId);
const rv = await A(`/coach/players/${prof.playerId}/revoke`, { note: "abuse" });
const after = await call(`/api/coach/players/${prof.playerId}`, { token: back.data.token });
check("a revoked profile is refused for its owner, with a clear message", rv.status === 200 && after.status === 403 && /revoked/i.test(after.data.error));
check("the owner's list marks it revoked", (await call("/api/coach/players", { token: back.data.token })).data.find((p) => p.id === prof.playerId)?.revoked === true);
check("the admin still sees it, flagged revoked", (await A("/coach")).data.profiles.find((p) => p.id === prof.playerId)?.revoked_at);
await A(`/coach/players/${prof.playerId}/restore`, {});
check("restoring gives access back", (await call(`/api/coach/players/${prof.playerId}`, { token: back.data.token })).status === 200);

sx.close(); sy.close();
const db = new pg.Pool({ connectionString: DB });
await db.query(`DELETE FROM games WHERE id IN (SELECT g.id FROM games g JOIN users u ON u.id IN (g.white_id,g.black_id) WHERE u.username ~ $1)`, [`^ac[XY]${tag}$`]);
await db.query(`DELETE FROM players WHERE owner_id IN (SELECT id FROM users WHERE username ~ $1)`, [`^ac[XY]${tag}$`]);
await db.query(`DELETE FROM users WHERE username ~ $1`, [`^ac[XY]${tag}$`]);
await db.end();
console.log(failed ? `\n${failed} FAILED` : "\nAll checks passed");
process.exit(failed ? 1 : 0);
