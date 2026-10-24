// Outage test: Postgres goes away under a running server, then comes back. Nothing is restarted by hand.
// Needs the docker-compose stack and the game server on :8001. Takes about a minute.
import { execSync } from "node:child_process";
import { io } from "socket.io-client";

const BASE = process.env.BASE || "http://localhost:8001";
const COMPOSE = new URL("../../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
let failed = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  -> " + extra : ""}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dc = (cmd) => execSync(`docker compose ${cmd}`, { cwd: COMPOSE, stdio: "pipe" }).toString();
const timed = async (path, token) => {
  const t0 = Date.now();
  try {
    const r = await fetch(BASE + path, { headers: token ? { authorization: "Bearer " + token } : {}, signal: AbortSignal.timeout(25_000) });
    return { status: r.status, ms: Date.now() - t0, body: await r.json().catch(() => ({})) };
  } catch (e) { return { status: 0, ms: Date.now() - t0, body: { error: String(e.message) } }; }
};
const post = async (path, body, token) => {
  const r = await fetch(BASE + path, { method: "POST", headers: { "content-type": "application/json", ...(token && { authorization: "Bearer " + token }) }, body: JSON.stringify(body) });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};

const tag = Math.floor(Math.random() * 1e6);
const user = (await post("/api/register", { username: `outage_${tag}`, password: "secret123" })).data;
check("server healthy before the outage", (await timed("/healthz")).status === 200);

console.log("... stopping Postgres");
dc("stop postgres");
await sleep(2000);
const h = await timed("/healthz");
check("during the outage /healthz fails fast with 503 (no hang)", h.status === 503 && h.ms < 15_000, `${h.status} in ${h.ms}ms`);
const me = await timed("/api/me", user.token);
check("an API call returns a friendly 503", me.status === 503 && /database/i.test(me.body.error || ""), `${me.status} "${me.body.error}"`);
const coach = await timed("/api/coach/players", user.token);
check("coach endpoints fail the same way", coach.status === 503, `${coach.status} in ${coach.ms}ms`);
check("the server process is still alive (static pages keep working)", (await fetch(BASE + "/")).status === 200);

console.log("... starting Postgres");
dc("start postgres");
let back = false, t0 = Date.now();
while (Date.now() - t0 < 60_000) { if ((await timed("/healthz")).status === 200) { back = true; break; } await sleep(2000); }
check("the server recovers by itself once Postgres is back", back, `${Math.round((Date.now() - t0) / 1000)}s`);
check("the same login still works (sessions survive the outage)", (await timed("/api/me", user.token)).status === 200);

// the worker must also have reconnected: a bot game needs it
const sock = await new Promise((r) => { const s = io(BASE, { auth: { token: user.token } }); s.on("connect", () => r(s)); });
const emit = (ev, p) => new Promise((r) => sock.emit(ev, p, r));
const { code } = (await post("/api/games", { color: "white", minutes: 10, vsBot: true, level: "easy" }, user.token)).data;
let plies = 0;
sock.on("state", (g) => { if (g.code === code) plies = g.moves.length; });
await emit("join", code);
await emit("move", { code, from: "e2", to: "e4" });
for (let i = 0; i < 40 && plies < 2; i++) await sleep(1000);
check("after the outage the bot still replies (worker reconnected)", plies >= 2, `plies=${plies}`);
sock.close();

console.log(failed ? `\n${failed} FAILED` : "\nAll checks passed");
process.exit(failed ? 1 : 0);
