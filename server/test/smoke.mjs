import { io } from "socket.io-client";
const BASE = "http://localhost:8001";
const post = async (p, body, token) => (await fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json", ...(token && { authorization: "Bearer " + token }) }, body: JSON.stringify(body) })).json();
const sock = (token) => new Promise((res) => { const s = io(BASE, { auth: { token } }); s.on("connect", () => res(s)); });
const emit = (s, ev, p) => new Promise((r) => s.emit(ev, p, r));
const tag = Math.floor(Math.random() * 1e6);

const a = await post("/api/register", { username: "alice" + tag, password: "secret1" });
const b = await post("/api/guest", { name: "Bob" });
const admin = await post("/api/login", { username: "admin", password: "admin123" });
const { code } = await post("/api/games", { color: "white", minutes: 5 }, a.token);
console.log("game", code);

const [sa, sb, sx] = await Promise.all([sock(a.token), sock(b.token), sock(admin.token)]);
sx.on("suggestion", (r) => console.log("ADMIN suggestion ply", r.ply, r.top_moves.map((m) => m.san + "(" + m.eval_cp + ")").join(" "), r.explanation ? "| " + r.explanation.slice(0, 120) : ""));
let leaked = false;
sa.on("suggestion", () => (leaked = true)); sb.on("suggestion", () => (leaked = true));
console.log("join a", await emit(sa, "join", code), "join b", await emit(sb, "join", code), "join admin", await emit(sx, "join", code));
const seq = [[sa, "e2", "e4"], [sb, "e7", "e5"], [sa, "g1", "f3"], [sb, "b8", "c6"]];
for (const [s, from, to] of seq) console.log(from + to, await emit(s, "move", { code, from, to }));
console.log("illegal by wrong side:", await emit(sb, "move", { code, from: "d2", to: "d4" }));
await new Promise((r) => setTimeout(r, 20000));
console.log("resign", await emit(sb, "resign", code));
await new Promise((r) => setTimeout(r, 25000));
const rep = await (await fetch(`${BASE}/api/games/${code}/report`, { headers: { authorization: "Bearer " + a.token } })).json();
console.log("report ready", rep.ready, rep.progress, rep.white, rep.black);
console.log("suggestion leaked to players:", leaked);
process.exit(0);
