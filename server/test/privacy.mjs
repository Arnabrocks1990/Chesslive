// Privacy test: one user must not be able to read or change another user's coach profile, analysis,
// game reports or play-quality stats. Admins can see everything. Needs the game server on :8001.
// Takes ~1 minute (a real coach run is created). Creates and removes its own data.
import crypto from "node:crypto";
import fs from "node:fs";
import { io } from "socket.io-client";
import pg from "pg";

const BASE = "http://localhost:8001";
const tag = crypto.randomBytes(3).toString("hex");
let failed = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  -> " + extra : ""}`); if (!ok) failed++; };
const call = async (path, { body, token, method } = {}) => {
  const res = await fetch(BASE + path, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json", ...(token && { authorization: "Bearer " + token }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reg = async (n) => (await call("/api/register", { body: { username: `${n}_${tag}`, password: "secret123" } })).data;

const A = await reg("owner"), B = await reg("snoop"), C = await reg("opponent");
const admin = (await call("/api/login", { body: { username: "admin", password: process.env.ADMIN_PASSWORD || "admin123" } })).data;
const db = new pg.Pool({ connectionString: "postgresql://chess:chess@localhost:5455/chess" });

// ---- owner builds a real coach profile
const samples = JSON.parse(fs.readFileSync(new URL("./fixtures/sample-games.json", import.meta.url), "utf8"));
const created = await call("/api/coach/players", { body: { platform: "pgn", name: "You", pgn: samples.map((s) => s.pgn).join("\n\n"), goal: "privacy test" }, token: A.token });
const pid = created.data.playerId;
check("owner can create a coach profile", !!pid);
let ov;
for (let i = 0; i < 60; i++) { ov = (await call(`/api/coach/players/${pid}`, { token: A.token })).data; if ((ov.sessions || []).length >= 5) break; await sleep(3000); }
check("coach built a plan for the owner", (ov.sessions || []).length >= 5, `${(ov.sessions || []).length} sessions`);
const sessionId = ov.sessions[0].id;
const runId = ov.latestRun?.id;
const drill = (await call(`/api/coach/players/${pid}/drills/next`, { token: A.token })).data.drill;
const shareToken = ov.player.share_token;

// ---- owner has full access
check("owner reads own profile", (await call(`/api/coach/players/${pid}`, { token: A.token })).status === 200);
check("owner's list contains it", (await call("/api/coach/players", { token: A.token })).data.some((p) => p.id === pid));
check("owner reads own session", (await call(`/api/coach/sessions/${sessionId}`, { token: A.token })).status === 200);
if (runId) check("owner reads own agent run", (await call(`/api/coach/runs/${runId}`, { token: A.token })).status === 200);

// ---- another user is blocked everywhere (404, same as 'does not exist')
const blocked = [
  ["GET", `/api/coach/players/${pid}`],
  ["GET", `/api/coach/players/${pid}/drills/next`],
  ["POST", `/api/coach/players/${pid}/ask`, { question: "what are my weaknesses?" }],
  ["POST", `/api/coach/players/${pid}/plain`, {}],
  ["POST", `/api/coach/players/${pid}/run`, {}],
  ["POST", `/api/coach/players/${pid}/simulate`, {}],
  ["POST", `/api/coach/players/${pid}/checkout`, {}],
  ["GET", `/api/coach/sessions/${sessionId}`],
  ["POST", `/api/coach/sessions/${sessionId}/start`, {}],
  ...(runId ? [["GET", `/api/coach/runs/${runId}`]] : []),
  ...(drill ? [["POST", `/api/coach/drills/${drill.id}/answer`, { uci: "e2e4" }], ["POST", `/api/coach/drills/${drill.id}/hint`, { n: 1 }]] : []),
  ["GET", `/api/billing/coach/${pid}`],
  ["POST", `/api/billing/coach/${pid}/checkout`, {}],
];
for (const [m, path, body] of blocked) {
  const r = await call(path, { method: m, body: m === "POST" ? body ?? {} : undefined, token: B.token });
  check(`other user blocked: ${m} ${path.replace("/api/", "")}`, r.status === 404 || r.status === 400, `HTTP ${r.status} ${r.data.error ?? ""}`);
}
check("other user's list does not show it", !(await call("/api/coach/players", { token: B.token })).data.some((p) => p.id === pid));
const id404 = await call(`/api/coach/players/99999999`, { token: B.token });
const priv404 = await call(`/api/coach/players/${pid}`, { token: B.token });
check("'not yours' looks identical to 'does not exist'", id404.status === priv404.status && id404.data.error === priv404.data.error);
check("signed-out request gets 401", (await call(`/api/coach/players/${pid}`)).status === 401);
const delTry = await call(`/api/coach/players/${pid}/delete`, { body: {}, token: B.token });
check("other user cannot delete it", delTry.status === 404);
check("profile still exists after the delete attempt", (await call(`/api/coach/players/${pid}`, { token: A.token })).status === 200);

// ---- admin sees everything
check("admin reads the profile", (await call(`/api/coach/players/${pid}`, { token: admin.token })).status === 200);
const adminList = (await call("/api/coach/players", { token: admin.token })).data;
check("admin's list includes it, with the owner's name", adminList.some((p) => p.id === pid && p.owner === `owner_${tag}`));

// ---- explicit share link stays public (the owner chose to create it)
check("owner's share link works without sign-in", (await fetch(`${BASE}/api/coach/share/${shareToken}`)).status === 200);

// ---- game report + profile stats
const code = (await call("/api/games", { body: { color: "white", minutes: 5 }, token: A.token })).data.code;
const sock = (t) => new Promise((r) => { const s = io(BASE, { auth: { token: t } }); s.on("connect", () => r(s)); });
const emit = (s, ev, p) => new Promise((r) => s.emit(ev, p, r));
const [sa, sc] = [await sock(A.token), await sock(C.token)];
await emit(sa, "join", code); await emit(sc, "join", code);
for (const [s, f, t] of [[sa, "e2", "e4"], [sc, "e7", "e5"], [sa, "g1", "f3"], [sc, "b8", "c6"]]) await emit(s, "move", { code, from: f, to: t });
await emit(sc, "resign", code);
sa.close(); sc.close();
check("game participant A reads the report", (await call(`/api/games/${code}/report`, { token: A.token })).status === 200);
check("game participant C reads the report", (await call(`/api/games/${code}/report`, { token: C.token })).status === 200);
check("outsider B cannot read the report", (await call(`/api/games/${code}/report`, { token: B.token })).status === 404);
check("signed-out request cannot read the report", (await call(`/api/games/${code}/report`)).status === 401);
check("admin reads the report", (await call(`/api/games/${code}/report`, { token: admin.token })).status === 200);

const own = (await call(`/api/profile/owner_${tag}`, { token: A.token })).data;
const seenByB = (await call(`/api/profile/owner_${tag}`, { token: B.token })).data;
const seenByAdmin = (await call(`/api/profile/owner_${tag}`, { token: admin.token })).data;
check("owner sees own play-quality stats", own.restricted === false);
check("other user sees rating/record but no analysis", seenByB.restricted === true && seenByB.rating > 0 && seenByB.avgAccuracy === null && seenByB.blundersPer100Moves === null && seenByB.openings.length === 0, JSON.stringify({ r: seenByB.restricted, acc: seenByB.avgAccuracy, op: seenByB.openings.length }));
check("admin sees the full profile", seenByAdmin.restricted === false);

// ---- cleanup
await call(`/api/coach/players/${pid}/delete`, { body: {}, token: A.token });
const ids = [A.user.id, B.user.id, C.user.id];
await db.query(`DELETE FROM games WHERE white_id = ANY($1) OR black_id = ANY($1)`, [ids]);
await db.query(`DELETE FROM users WHERE id = ANY($1)`, [ids]);
await db.end();
console.log(failed ? `\n${failed} FAILED` : "\nAll checks passed");
process.exit(failed ? 1 : 0);
