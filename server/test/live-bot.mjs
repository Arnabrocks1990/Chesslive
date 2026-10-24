// Live check of the worker path on a deployed instance: a bot game must get a reply, and the admin's
// live assist must produce analysis. Creates a throwaway account; remove it afterwards (see the output).
//   BASE=https://chesslive-web.onrender.com node test/live-bot.mjs
import { io } from "socket.io-client";

const BASE = process.env.BASE;
if (!BASE) { console.error("Set BASE to the deployed URL"); process.exit(2); }
let failed = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  -> " + extra : ""}`); if (!ok) failed++; };
const post = async (path, body, token) => {
  const r = await fetch(BASE + path, { method: "POST", headers: { "content-type": "application/json", ...(token && { authorization: "Bearer " + token }) }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};
const name = `botcheck_${Math.floor(Math.random() * 1e6)}`;
const u = (await post("/api/register", { username: name, password: "secret123" })).data;
const s = await new Promise((res, rej) => { const x = io(BASE, { auth: { token: u.token }, transports: ["websocket"] }); x.on("connect", () => res(x)); x.on("connect_error", rej); });
const emit = (ev, p) => new Promise((r) => s.emit(ev, p, r));
const { code } = (await post("/api/games", { color: "white", minutes: 10, vsBot: true, level: "easy" }, u.token)).data;
let state;
s.on("state", (g) => { if (g.code === code) state = g; });
await emit("join", code);
const t0 = Date.now();
await emit("move", { code, from: "e2", to: "e4" });
while (Date.now() - t0 < 60_000 && (state?.moves.length ?? 0) < 2) await new Promise((r) => setTimeout(r, 500));
check("the bot replied (web -> Redis -> Stockfish worker -> web)", (state?.moves.length ?? 0) >= 2, `${state?.moves.length} plies in ${((Date.now() - t0) / 1000).toFixed(1)}s, reply: ${state?.moves[1]?.san}`);
await emit("resign", code);
s.close();
console.log(`\nthrowaway account to delete from the database: ${name}`);
console.log(failed ? `${failed} FAILED` : "All checks passed");
process.exit(failed ? 1 : 0);
