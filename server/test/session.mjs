// Coach session robustness test: double-clicks, concurrent answers, resume, hints, ordering.
// Needs the game server on :8001 (and the worker, which builds the plan). Takes about a minute.
// Creates and removes its own user + coach profile.
import crypto from "node:crypto";
import fs from "node:fs";
import pg from "pg";

const BASE = process.env.BASE || "http://localhost:8001";
const tag = crypto.randomBytes(3).toString("hex");
let failed = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  -> " + extra : ""}`); if (!ok) failed++; };
const call = async (path, { body, token } = {}) => {
  const r = await fetch(BASE + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...(token && { authorization: "Bearer " + token }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL || "postgresql://chess:chess@localhost:5455/chess" });
const q = async (sql, params = []) => (await db.query(sql, params)).rows;

const user = (await call("/api/register", { body: { username: `sess_${tag}`, password: "secret123" } })).data;
const T = user.token;
const samples = JSON.parse(fs.readFileSync(new URL("./fixtures/sample-games.json", import.meta.url), "utf8"));
const pid = (await call("/api/coach/players", { token: T, body: { platform: "pgn", name: "You", pgn: samples.map((s) => s.pgn).join("\n\n") } })).data.playerId;
let sessions = [];
for (let i = 0; i < 60; i++) { sessions = (await call(`/api/coach/players/${pid}`, { token: T })).data.sessions || []; if (sessions.length >= 5) break; await sleep(3000); }
check("coach built a 7-day plan", sessions.length >= 5, `${sessions.length} sessions`);
const day1 = sessions[0], day2 = sessions[1];
check("day 2 starts locked", day2.state === "locked");

// ---- 1. double-click on "Start exercise": must create ONE question set
const [a, b] = await Promise.all([call(`/api/coach/sessions/${day1.id}/start`, { token: T, body: {} }), call(`/api/coach/sessions/${day1.id}/start`, { token: T, body: {} })]);
check("both start requests succeed", a.status === 200 && b.status === 200, `${a.status}/${b.status}`);
const [{ n: nq }] = await q(`SELECT count(*)::int n FROM session_questions WHERE session_id=$1`, [day1.id]);
const [{ attempts, total }] = await q(`SELECT attempts, total FROM plan_sessions WHERE id=$1`, [day1.id]);
check("double-click created exactly one question set", nq === total && attempts === 1, `questions=${nq} total=${total} attempts=${attempts}`);

// ---- 2. concurrent answers to the same question: exactly one counts
let view = (await call(`/api/coach/sessions/${day1.id}`, { token: T })).data;
const qid = view.question.id;
const [m] = await q(`SELECT m.best_uci FROM session_questions sq JOIN mistakes m ON m.id=sq.mistake_id WHERE sq.id=$1`, [qid]);
const [x, y] = await Promise.all([call(`/api/coach/session-questions/${qid}/answer`, { token: T, body: { uci: m.best_uci } }), call(`/api/coach/session-questions/${qid}/answer`, { token: T, body: { uci: m.best_uci } })]);
check("one of two simultaneous answers is accepted, the other refused", [x.status, y.status].sort().join() === "200,400", `${x.status}/${y.status}`);
const [dr] = await q(`SELECT d.attempts FROM drills d JOIN mistakes mm ON mm.id=d.mistake_id JOIN session_questions sq ON sq.mistake_id=mm.id WHERE sq.id=$1`, [qid]);
check("the answer was recorded once (no double count in the drill history)", dr?.attempts === 1, `drill attempts=${dr?.attempts}`);

// ---- 3. hints reveal in order only
view = (await call(`/api/coach/sessions/${day1.id}`, { token: T })).data;
const q2 = view.question.id;
check("hint 2 before hint 1 is refused", (await call(`/api/coach/session-questions/${q2}/hint`, { token: T, body: { n: 2 } })).status === 400);
check("hint 1 works", (await call(`/api/coach/session-questions/${q2}/hint`, { token: T, body: { n: 1 } })).status === 200);

// ---- 4. resume: reloading the session shows the same open question, not a new set
const again = (await call(`/api/coach/sessions/${day1.id}`, { token: T })).data;
check("reload resumes the same question", again.question.id === q2 && again.progress.answered === 1, `answered=${again.progress.answered}`);
const resumed = await call(`/api/coach/sessions/${day1.id}/start`, { token: T, body: {} });
const [{ n: nq2 }] = await q(`SELECT count(*)::int n FROM session_questions WHERE session_id=$1`, [day1.id]);
check("calling start again mid-session does not add questions", resumed.status === 200 && nq2 === nq, `${nq} -> ${nq2}`);

// ---- 5. answer everything else, the last two at the same moment: the milestone must be evaluated once
const open = await q(`SELECT sq.id, m.best_uci FROM session_questions sq JOIN mistakes m ON m.id=sq.mistake_id WHERE sq.session_id=$1 AND sq.result IS NULL ORDER BY sq.id`, [day1.id]);
for (const o of open.slice(0, -2)) await call(`/api/coach/session-questions/${o.id}/answer`, { token: T, body: { uci: o.best_uci } });
const lastTwo = open.slice(-2);
const res = await Promise.all(lastTwo.map((o) => call(`/api/coach/session-questions/${o.id}/answer`, { token: T, body: { uci: o.best_uci } })));
check("both final answers accepted", res.every((r) => r.status === 200), res.map((r) => r.status).join("/"));
const [{ n: evals }] = await q(`SELECT count(*)::int n FROM agent_runs WHERE player_id=$1 AND trigger='session'`, [pid]);
check("the milestone was evaluated exactly once", evals === 1, `evaluations=${evals}`);
const done = (await call(`/api/coach/players/${pid}`, { token: T })).data.sessions;
check("day 1 is done and day 2 unlocked", done[0].state === "done" && done[1].state !== "locked", `${done[0].state}/${done[1].state}`);

// ---- 6. the same games imported by a second player must not be swallowed by the first player's import
const user2 = (await call("/api/register", { body: { username: `sess2_${tag}`, password: "secret123" } })).data;
const pid2 = (await call("/api/coach/players", { token: user2.token, body: { platform: "pgn", name: "You", pgn: samples.map((s) => s.pgn).join("\n\n") } })).data.playerId;
const ov2 = (await call(`/api/coach/players/${pid2}`, { token: user2.token })).data;
check("a second player importing the same games gets their own copy", Number(ov2.games?.total) === samples.length, `stored ${ov2.games?.total} of ${samples.length}`);
const again1 = (await call("/api/coach/players", { token: T, body: { platform: "pgn", name: "You", pgn: samples.map((s) => s.pgn).join("\n\n") } })).data.playerId;
check("importing for yourself twice still creates a separate profile, with its own games", !!again1 && again1 !== pid);
await call(`/api/coach/players/${again1}/delete`, { token: T, body: {} });
await call(`/api/coach/players/${pid2}/delete`, { token: user2.token, body: {} });
await q(`DELETE FROM users WHERE id=$1`, [user2.user.id]);

// ---- 7. "delete my data" removes everything about the profile, including its plan sessions
await call(`/api/coach/players/${pid}/delete`, { token: T, body: {} });
const [left] = await q(`SELECT (SELECT count(*) FROM plan_sessions WHERE player_id=$1)::int sessions, (SELECT count(*) FROM games WHERE player_id=$1)::int games, (SELECT count(*) FROM mistakes WHERE player_id=$1)::int mistakes, (SELECT count(*) FROM players WHERE id=$1)::int profile`, [pid]);
check("deleting a profile leaves no sessions, games, mistakes or profile row behind", left.sessions + left.games + left.mistakes + left.profile === 0, JSON.stringify(left));

// ---- cleanup
await call(`/api/coach/players/${pid}/delete`, { token: T, body: {} });
await q(`DELETE FROM users WHERE id=$1`, [user.user.id]);
await db.end();
console.log(failed ? `\n${failed} FAILED` : "\nAll checks passed");
process.exit(failed ? 1 : 0);
