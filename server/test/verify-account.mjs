// Account-ownership check for coach profiles. Starts a stand-in for Lichess / Chess.com (the server must be run
// with LICHESS_BASE and CHESSCOM_BASE pointing at it) so the bio/location text can be controlled.
//   LICHESS_BASE=http://localhost:9911 CHESSCOM_BASE=http://localhost:9911 PORT=8011 npx tsx src/index.ts
//   BASE=http://localhost:8011 node test/verify-account.mjs
import http from "node:http";
import pg from "pg";

const BASE = process.env.BASE || "http://localhost:8011";
const DB = process.env.DATABASE_URL || "postgresql://chess:chess@localhost:5455/chess";
let failed = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  -> " + extra : ""}`); if (!ok) failed++; };

// stand-in sites: what each account's public text says
const bio = { lichess: new Map(), chesscom: new Map() };
const mock = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  let m;
  if ((m = /^\/api\/user\/([^/]+)$/.exec(u.pathname))) {
    const t = bio.lichess.get(m[1].toLowerCase());
    return t === undefined ? (res.statusCode = 404, res.end("{}")) : res.end(JSON.stringify({ id: m[1].toLowerCase(), profile: { bio: t } }));
  }
  if ((m = /^\/pub\/player\/([^/]+)$/.exec(u.pathname))) {
    const t = bio.chesscom.get(m[1].toLowerCase());
    return t === undefined ? (res.statusCode = 404, res.end("{}")) : res.end(JSON.stringify({ username: m[1].toLowerCase(), location: t }));
  }
  if (/^\/api\/games\/user\//.test(u.pathname)) return res.end(""); // no games: the run ends quickly
  if (/^\/pub\/player\/[^/]+\/games\/archives$/.test(u.pathname)) return res.end(JSON.stringify({ archives: [] }));
  res.statusCode = 404; res.end("{}");
});
await new Promise((r) => mock.listen(9911, r));

const call = async (path, { body, token } = {}) => {
  const r = await fetch(BASE + path, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", ...(token && { authorization: "Bearer " + token }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};
const tag = Math.floor(Math.random() * 1e6);
const reg = async (n) => (await call("/api/register", { body: { username: `${n}${tag}`, password: "secret123" } })).data;
const U = await reg("vfyU"), V = await reg("vfyV");
const admin = (await call("/api/login", { body: { username: "admin", password: process.env.ADMIN_PASSWORD || "admin123" } })).data;
const add = (token, platform, username) => call("/api/coach/players", { token, body: { platform, username } });

bio.lichess.set("vfyacct", "I love chess");
bio.chesscom.set("vfyacct", "Kolkata");

check("an account that does not exist is refused as not found", (await add(U.token, "lichess", "nobody_here")).status === 400);
const a1 = await add(U.token, "lichess", "vfyacct");
check("a real account without our code is refused and a code is issued", a1.status === 403 && a1.data.needsVerification && /^cl-[0-9a-f]{8}$/.test(a1.data.code), `${a1.data.code} -> ${a1.data.field}`);
const a2 = await add(U.token, "lichess", "vfyacct");
check("the same code comes back on retry (stable)", a2.data.code === a1.data.code);
check("a profile is NOT created while unverified", (await call("/api/coach/players", { token: U.token })).data.length === 0);

bio.lichess.set("vfyacct", `I love chess ${a1.data.code.toUpperCase()}`);
const a3 = await add(U.token, "lichess", "vfyacct");
check("with the code in the biography (any letter case) the profile is created", a3.status === 200 && a3.data.playerId, JSON.stringify(a3.data));

bio.lichess.set("vfyacct", "I love chess"); // code removed afterwards
check("proof is not withdrawn if the code is removed later", (await add(U.token, "lichess", "vfyacct")).status === 200);

const b1 = await add(V.token, "lichess", "vfyacct");
check("a different user cannot reuse U's proof: gets their own code", b1.status === 403 && b1.data.code !== a1.data.code);
bio.lichess.set("vfyacct", `x ${a1.data.code}`); // U's code only
check("another user's code in the bio does not verify V", (await add(V.token, "lichess", "vfyacct")).status === 403);

const c1 = await add(U.token, "chesscom", "vfyacct");
check("Chess.com is checked too (via the Location field)", c1.status === 403 && c1.data.field === "Location");
bio.chesscom.set("vfyacct", `Kolkata ${c1.data.code}`);
check("and verifies once the code is in the Location", (await add(U.token, "chesscom", "vfyacct")).status === 200);

if (admin.token) {
  bio.lichess.set("adminacct", "no code");
  check("admins are exempt (they review other people's accounts)", (await add(admin.token, "lichess", "adminacct")).status === 200);
} else console.log("SKIP  admin exemption (could not log in as admin; set ADMIN_PASSWORD)");

const pgn = await call("/api/coach/players", { token: V.token, body: { platform: "pgn", color: "white", pgn: '[Event "x"]\n[White "You"]\n[Black "Opp"]\n[Result "1-0"]\n\n1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0' } });
check("pasting a PGN needs no verification", pgn.status === 200);

const db = new pg.Pool({ connectionString: DB });
await db.query(`DELETE FROM players WHERE owner_id IN (SELECT id FROM users WHERE username ~ $1) OR username IN ('adminacct')`, [`^vfy[UV]${tag}$`]);
await db.query(`DELETE FROM users WHERE username ~ $1`, [`^vfy[UV]${tag}$`]);
await db.end();
mock.close();
console.log(failed ? `\n${failed} FAILED` : "\nAll checks passed");
process.exit(failed ? 1 : 0);
