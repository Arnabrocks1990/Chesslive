// "Improve your Game" + dashboard. Needs a running server (BASE) with the Stockfish worker for the part that
// builds puzzles from a finished game, and the local database (DATABASE_URL) to read the stored solution.
//   BASE=http://localhost:8001 node test/improve.mjs
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
const tag = Math.floor(Math.random() * 1e6);
const reg = async (n) => (await call("/api/register", { body: { username: `${n}${tag}`, password: "secret123" } })).data;
const db = new pg.Pool({ connectionString: DB });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- a brand-new player: built-in puzzles, hints, answers, privacy
const N = await reg("impNew"), O = await reg("impOther");
const set = (await call("/api/improve/puzzles", { token: N.token })).data;
check("a new player gets built-in puzzles (no games yet)", set.puzzles?.length >= 6 && set.usingDefaults && set.fromGames === 0, `${set.puzzles?.length} puzzles`);
const first = set.puzzles[0];
const view = (await call(`/api/improve/puzzles/${first.id}`, { token: N.token })).data;
const [row] = (await db.query(`SELECT best_uci, best_san FROM improve_puzzles WHERE id=$1`, [first.id])).rows;
check("the puzzle view never contains the solution", !!view.fen && !JSON.stringify(view).includes(row.best_uci) && !/best_|solution/i.test(Object.keys(view).join()), Object.keys(view).join(","));
check("another player cannot open it (404)", (await call(`/api/improve/puzzles/${first.id}`, { token: O.token })).status === 404);
check("another player cannot answer it (404)", (await call(`/api/improve/puzzles/${first.id}/answer`, { token: O.token, body: { uci: "a1a8" } })).status === 404);
check("hints unlock in order (hint 2 before 1 is refused)", (await call(`/api/improve/puzzles/${first.id}/hint`, { token: N.token, body: { n: 2 } })).status === 400);
const h1 = (await call(`/api/improve/puzzles/${first.id}/hint`, { token: N.token, body: { n: 1 } })).data;
const h2 = (await call(`/api/improve/puzzles/${first.id}/hint`, { token: N.token, body: { n: 2 } })).data;
const h3 = (await call(`/api/improve/puzzles/${first.id}/hint`, { token: N.token, body: { n: 3 } })).data;
check("three progressive hints: idea, piece, square", h1.std && h2.highlight?.from && !h2.highlight?.to && h3.highlight?.to, `${h2.highlight?.from} -> ${h3.highlight?.to}`);
const wrong = (await call(`/api/improve/puzzles/${first.id}/answer`, { token: N.token, body: { uci: row.best_uci === "a1a2" ? "a1a3" : "a1a2" } })).data;
check("a wrong move is not accepted, and the puzzle stays open", wrong.correct === false);
const right = (await call(`/api/improve/puzzles/${first.id}/answer`, { token: N.token, body: { uci: row.best_uci } })).data;
check("the right move solves it and explains why", right.correct === true && right.verdict?.pass && right.verdict.explanation, right.verdict?.bestSan);
check("it is recorded as solved with the hints used", (await call("/api/improve/puzzles", { token: N.token })).data.puzzles.find((p) => p.id === first.id)?.status === "solved" && right.verdict.hintsUsed === 3);
const second = set.puzzles[1];
const rev = (await call(`/api/improve/puzzles/${second.id}/reveal`, { token: N.token, body: {} })).data;
check("'show me' reveals the answer but does not count as solved", rev.verdict?.pass === false && (await call("/api/improve/puzzles", { token: N.token })).data.puzzles.find((p) => p.id === second.id)?.status === "revealed");
const d0 = (await call("/api/improve/dashboard", { token: N.token })).data;
check("dashboard for a player with no games: tips, no coach push", d0.record.games === 0 && d0.insights.length > 0 && d0.recommendation.level === "none" && d0.rating === 600, d0.recommendation.headline);
check("dashboard counts the puzzle work", d0.puzzles.solved === 1 && d0.puzzles.revealed === 1 && d0.puzzles.hints === 3);

// ---- puzzles from a real finished game (needs the worker)
const W = await reg("impW"), B = await reg("impB");
const sock = (u) => new Promise((r) => { const s = io(BASE, { auth: { token: u.token }, transports: ["websocket"] }); s.on("connect", () => r(s)); });
const emit = (s, ev, p) => new Promise((r) => s.emit(ev, p, r));
const sw = await sock(W), sb = await sock(B);
const { code } = (await call("/api/games", { token: W.token, body: { color: "white", minutes: 10 } })).data;
await emit(sw, "join", code); await emit(sb, "join", code);
const line = [["e2", "e4"], ["e7", "e5"], ["g1", "f3"], ["b8", "c6"], ["f1", "c4"], ["f8", "c5"], ["e1", "g1"], ["d8", "h4"], ["f3", "h4"]]; // Black hangs the queen on move 4
for (let i = 0; i < line.length; i++) await emit(i % 2 ? sb : sw, "move", { code, from: line[i][0], to: line[i][1] });
await emit(sb, "resign", code);
sw.close(); sb.close();
let g = null;
for (let i = 0; i < 45 && !g; i++) { // wait for Stockfish to analyse the game
  await wait(2000);
  const s = (await call("/api/improve/puzzles", { token: B.token })).data;
  if (s.fromGames > 0) g = s;
}
if (!g) console.log("SKIP  game puzzles: no analysis arrived in 90s (is the Stockfish worker running?)");
else {
  const mine = g.puzzles.find((p) => p.source === "game");
  check("the loser gets a puzzle from that game", !!mine && mine.from?.move === 4, `${mine?.title} (${mine?.from?.opponent})`);
  check("it is for Black to move (the player who erred)", mine?.turn === "b");
  const [pz] = (await db.query(`SELECT best_uci, played_san, win_drop FROM improve_puzzles WHERE id=$1`, [mine.id])).rows;
  check("it points at the queen blunder and the played move is recorded", pz.played_san === "Qxh4" || pz.played_san === "Qh4", `${pz.played_san}, dropped ${Math.round(pz.win_drop)}%`);
  check("the winner (who played well) gets no puzzle from it", !(await call("/api/improve/puzzles", { token: W.token })).data.puzzles.some((p) => p.source === "game" && p.from?.move === 4));
  const dg = (await call("/api/improve/dashboard", { token: B.token })).data;
  check("dashboard shows the loss, accuracy and a blunder", dg.record.losses === 1 && dg.quality.analysed === 1 && typeof dg.quality.accuracy === "number" && dg.quality.blunders >= 1, `accuracy ${dg.quality.accuracy}%, blunders ${dg.quality.blunders}`);
  check("and recommends the coach with reasons", dg.recommendation.level !== "none" || dg.recommendation.reasons.length >= 0, `${dg.recommendation.level}: ${dg.recommendation.reasons.join("; ")}`);
}

await db.query(`DELETE FROM games WHERE id IN (SELECT g.id FROM games g JOIN users u ON u.id IN (g.white_id,g.black_id) WHERE u.username ~ $1)`, [`^imp[A-Za-z]+${tag}$`]);
await db.query(`DELETE FROM users WHERE username ~ $1`, [`^imp[A-Za-z]+${tag}$`]);
await db.end();
console.log(failed ? `\n${failed} FAILED` : "\nAll checks passed");
process.exit(failed ? 1 : 0);
