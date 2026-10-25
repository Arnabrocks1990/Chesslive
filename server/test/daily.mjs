// Daily puzzle + streak. Needs a running server (BASE) and the local database (DATABASE_URL) to back-date solved days.
//   BASE=http://localhost:8011 node test/daily.mjs
import pg from "pg";

const BASE = process.env.BASE || "http://localhost:8001";
const DB = process.env.DATABASE_URL || "postgresql://chess:chess@localhost:5455/chess";
const TZ = process.env.DAILY_TZ || "Asia/Kolkata";
let failed = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  -> " + extra : ""}`); if (!ok) failed++; };
const call = async (path, { body, token } = {}) => {
  const r = await fetch(BASE + path, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", ...(token && { authorization: "Bearer " + token }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};
const tag = Math.floor(Math.random() * 1e6);
const reg = async (n) => (await call("/api/register", { body: { username: `${n}${tag}`, password: "secret123" } })).data;
const db = new pg.Pool({ connectionString: DB });

const A = await reg("dayA"), B = await reg("dayB");
const a = (await call("/api/improve/daily", { token: A.token })).data;
const b = (await call("/api/improve/daily", { token: B.token })).data;
check("everyone gets a daily puzzle for today", !!a.puzzle?.id && /^\d{4}-\d\d-\d\d$/.test(a.date), `${a.date}: ${a.puzzle?.title}`);
const fenOf = async (id) => (await db.query(`SELECT fen, best_uci FROM improve_puzzles WHERE id=$1`, [id])).rows[0];
const fa = await fenOf(a.puzzle.id), fb = await fenOf(b.puzzle.id);
check("it is the same position for every player", fa.fen === fb.fen);
check("asking again returns the same puzzle (not a new one)", (await call("/api/improve/daily", { token: A.token })).data.puzzle.id === a.puzzle.id);
check("it is not in the regular puzzle list", !(await call("/api/improve/puzzles", { token: A.token })).data.puzzles.some((p) => p.id === a.puzzle.id));
check("a fresh player has no streak yet", a.streak.current === 0 && !a.streak.doneToday && a.streak.goal === 5 && a.streak.last5.length === 5 && a.streak.last5[4].today);

const view = (await call(`/api/improve/puzzles/${a.puzzle.id}`, { token: A.token })).data;
check("the puzzle view is marked daily and hides the solution", view.daily === true && !JSON.stringify(view).includes(fa.best_uci));
const h1 = (await call(`/api/improve/puzzles/${a.puzzle.id}/hint`, { token: A.token, body: { n: 1 } })).data;
const h2 = (await call(`/api/improve/puzzles/${a.puzzle.id}/hint`, { token: A.token, body: { n: 2 } })).data;
const h3 = (await call(`/api/improve/puzzles/${a.puzzle.id}/hint`, { token: A.token, body: { n: 3 } })).data;
check("the daily puzzle has the same three hints", !!h1.std && !!h2.highlight?.from && !!h3.highlight?.to);

const wrong = (await call(`/api/improve/puzzles/${a.puzzle.id}/answer`, { token: A.token, body: { uci: fa.best_uci === "a1a2" ? "a1a3" : "a1a2" } })).data;
check("a wrong move does not count", wrong.correct === false && (await call("/api/improve/daily", { token: A.token })).data.streak.current === 0);
const ok = (await call(`/api/improve/puzzles/${a.puzzle.id}/answer`, { token: A.token, body: { uci: fa.best_uci } })).data;
check("solving it starts a 1-day streak, shown right in the answer", ok.correct === true && ok.streak?.current === 1 && ok.streak.doneToday && ok.streak.last5[4].done, JSON.stringify(ok.streak?.last5?.map((d) => d.done)));
const rev = (await call(`/api/improve/puzzles/${b.puzzle.id}/reveal`, { token: B.token, body: {} })).data;
check("'show me the answer' does not extend the streak", rev.verdict && (await call("/api/improve/daily", { token: B.token })).data.streak.current === 0);

// back-dated days: build 4 earlier solved days for player A, then break the chain
const uid = (await call("/api/me", { token: A.token })).data.user.id;
const today = a.date;
const put = (offset, solvedOffset = offset) => db.query(
  `INSERT INTO improve_puzzles (user_id, source, default_key, daily_date, title, fen, best_uci, themes, phase, status, solved_at)
   VALUES ($1,'daily',$2,($3::date - $4::int),'t',$5,$6,'{other}','middlegame','solved', (($3::date - $7::int)::timestamp + interval '12 hours') AT TIME ZONE $8)`,
  [uid, `bk${offset}`, today, offset, fa.fen, fa.best_uci, solvedOffset, TZ]);
for (const o of [1, 2, 3, 4]) await put(o);
let dash = (await call("/api/improve/dashboard", { token: A.token })).data;
check("five consecutive days make a 5-day streak and unlock the goal", dash.streak.current === 5 && dash.streak.goalReached && dash.streak.best === 5, JSON.stringify(dash.streak.last5.map((d) => d.done)));
check("the dashboard says so", dash.insights.some((i) => /5-day goal/.test(i.text)) && dash.streak.totalSolved === 5);
await db.query(`DELETE FROM improve_puzzles WHERE user_id=$1 AND default_key='bk2'`, [uid]);
dash = (await call("/api/improve/dashboard", { token: A.token })).data;
check("a missed day breaks the chain (today + yesterday remain), best streak keeps the longer run", dash.streak.current === 2 && dash.streak.best === 2 && !dash.streak.goalReached, `current ${dash.streak.current}, best ${dash.streak.best}`);
// solved a day late (solved_at is today but the puzzle was for the day before) must not count
await db.query(`UPDATE improve_puzzles SET solved_at = now() WHERE user_id=$1 AND default_key='bk1'`, [uid]);
dash = (await call("/api/improve/dashboard", { token: A.token })).data;
check("solving yesterday's puzzle a day late does not count", dash.streak.current === 1, `current ${dash.streak.current}`);
// the streak stays alive until the end of today: no solve today, yesterday done
await db.query(`UPDATE improve_puzzles SET status='new', solved_at=NULL WHERE user_id=$1 AND daily_date=$2::date`, [uid, today]);
await db.query(`UPDATE improve_puzzles SET solved_at = ((daily_date)::timestamp + interval '12 hours') AT TIME ZONE $2 WHERE user_id=$1 AND default_key='bk1'`, [uid, TZ]);
dash = (await call("/api/improve/dashboard", { token: A.token })).data;
check("with today still open the streak is alive from yesterday", dash.streak.current === 1, `current ${dash.streak.current}, doneToday ${dash.streak.doneToday}`);
check("and the dashboard nudges them to solve today's puzzle", dash.streak.doneToday === false);

await db.query(`DELETE FROM users WHERE username ~ $1`, [`^day[AB]${tag}$`]);
await db.end();
console.log(failed ? `\n${failed} FAILED` : "\nAll checks passed");
process.exit(failed ? 1 : 0);
