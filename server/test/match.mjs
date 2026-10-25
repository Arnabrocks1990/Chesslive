// Matchmaking + default rating. Needs a running server (BASE, default http://localhost:8001) and the local database
// (DATABASE_URL) to give one test user a high rating.
//   node test/match.mjs
import pg from "pg";
import { io } from "socket.io-client";

const BASE = process.env.BASE || "http://localhost:8001";
const DB = process.env.DATABASE_URL || "postgresql://chess:chess@localhost:5455/chess";
let failed = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  -> " + extra : ""}`); if (!ok) failed++; };
const post = async (p, body, t) => (await fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json", ...(t && { authorization: "Bearer " + t }) }, body: JSON.stringify(body) })).json();
const get = async (p, t) => (await fetch(BASE + p, { headers: { authorization: "Bearer " + t } })).json();
const tag = Math.floor(Math.random() * 1e6);
const mk = async (name) => { const u = await post("/api/register", { username: `${name}${tag}`, password: "secret123" }); return u; };

/** A connected player that records the 'matched' event. */
function player(u) {
  const s = io(BASE, { auth: { token: u.token }, transports: ["websocket"] });
  const p = { u, s, matched: null, ready: new Promise((r) => s.on("connect", r)) };
  s.on("matched", (m) => (p.matched = m));
  p.find = (minutes, increment = 0) => new Promise((r) => s.emit("findMatch", { minutes, increment }, r));
  return p;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms) => { const t = Date.now(); while (Date.now() - t < ms && !f()) await wait(100); return f(); };

const A = await mk("mA"), B = await mk("mB"), C = await mk("mC"), D = await mk("mD"), E = await mk("mE");
check("a new account starts at 600 Elo", (await get("/api/me", A.token)).rating === 600, String((await get("/api/me", A.token)).rating));

const db = new pg.Pool({ connectionString: DB });
await db.query(`UPDATE users SET rating=1800 WHERE username=$1`, [`mC${tag}`]);

const [pa, pb, pc, pd, pe] = [A, B, C, D, E].map(player);
await Promise.all([pa, pb, pc, pd, pe].map((p) => p.ready));

// 1. two similar ratings, same time control -> paired into one game, different colours
await pa.find(10); await pb.find(10);
check("two 600-rated players with the same time control are matched", await until(() => pa.matched && pb.matched, 8000));
check("both are sent to the same game", pa.matched?.code && pa.matched.code === pb.matched?.code);
check("they get opposite colours", pa.matched?.color !== pb.matched?.color, `${pa.matched?.color} / ${pb.matched?.color}`);
if (pa.matched) {
  const g = await get(`/api/games/${pa.matched.code}`, A.token);
  check("the game is already active with both seats filled", g.status === "active" && g.white && g.black, `${g.white} vs ${g.black}`);
}

// 2. Elo-aware: 1800 vs 600 must not be paired straight away, and a different time control must not match
await pc.find(10); await pd.find(10);
await wait(6000);
check("1800 vs 600 are NOT paired while their rating gap exceeds the window", !pc.matched && !pd.matched);
await pe.find(5); // different time control from D
await wait(3000);
check("a different time control is never paired", !pd.matched && !pe.matched);

// 3. a closer-rated player arrives -> D (600) and a second 600 player pair up while C keeps waiting
const F = await mk("mF"); const pf = player(F); await pf.ready; await pf.find(10);
check("a close-rated newcomer pairs with the waiting 600 player, not the 1800 one", await until(() => pd.matched && pf.matched, 8000) && !pc.matched);

// 4. cancel leaves the queue; disconnect too
pc.s.emit("cancelMatch", null, () => {});
const G = await mk("mG"); const pg2 = player(G); await pg2.ready; await pg2.find(10);
await wait(1000);
check("a cancelled search is not matched", !pc.matched);
pg2.s.close(); pe.s.emit("cancelMatch", null, () => {});

await db.query(`DELETE FROM games WHERE white_id IN (SELECT id FROM users WHERE username LIKE $1) OR black_id IN (SELECT id FROM users WHERE username LIKE $1)`, [`%${tag}`]);
await db.query(`DELETE FROM users WHERE username ~ $1`, [`^m[A-G]${tag}$`]);
await db.end();
for (const p of [pa, pb, pc, pd, pe, pf]) p.s.close();
console.log(failed ? `\n${failed} FAILED` : "\nAll checks passed");
process.exit(failed ? 1 : 0);
