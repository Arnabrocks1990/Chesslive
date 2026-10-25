import { io } from "socket.io-client";
const BASE = "http://localhost:8001";
const post = async (p, body, t) => (await fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json", ...(t && { authorization: "Bearer " + t }) }, body: JSON.stringify(body) })).json();
const get = async (p, t) => (await fetch(BASE + p, { headers: { authorization: "Bearer " + t } })).json();
const sock = (t) => new Promise((r) => { const s = io(BASE, { auth: { token: t } }); s.on("connect", () => r(s)); });
const emit = (s, ev, p) => new Promise((r) => s.emit(ev, p, r));
const tag = Math.floor(Math.random() * 1e6);
const A = await post("/api/register", { username: "eloA" + tag, password: "secret1" });
const B = await post("/api/register", { username: "eloB" + tag, password: "secret1" });
const sa = await sock(A.token), sb = await sock(B.token);
const rating = async (u) => (await get("/api/me", u.token)).rating;
console.log("start ratings:", await rating(A), await rating(B));

async function game(label, plies, ender) {
  const { code } = await post("/api/games", { color: "white", minutes: 10 }, A.token);
  let last; sa.on("state", (g) => g.code === code && (last = g));
  await emit(sa, "join", code); await emit(sb, "join", code);
  for (let i = 0; i < plies.length; i++) { const [f, t] = plies[i]; await emit(i % 2 ? sb : sa, "move", { code, from: f, to: t }); }
  if (ender) await ender(code);
  await new Promise((r) => setTimeout(r, 400)); sa.off("state");
  console.log(label, "->", last.result, "change", JSON.stringify(last.ratingChange), "| ratings now", await rating(A), await rating(B));
}
const scholar = [["e2","e4"],["e7","e5"],["d1","h5"],["b8","c6"],["f1","c4"],["g8","f6"],["h5","f7"]];
await game("1. equal ratings, White mates", scholar);                       // expect +16 / -16
await game("2. resign after 2 plies (unrated)", [["e2","e4"],["e7","e5"]], (c) => emit(sb, "resign", c));
await game("3. draw by agreement after 4 plies", [["g1","f3"],["g8","f6"],["f3","g1"],["f6","g8"]], async (c) => { await emit(sa, "draw", { code: c, action: "offer" }); await emit(sb, "draw", { code: c, action: "accept" }); });

// vs bot: A (now ~1216) beats nothing, but resigning to the easy bot (1400) should cost little
const { code } = await post("/api/games", { color: "white", minutes: 10, vsBot: true, level: "easy" }, A.token);
let last; sa.on("state", (g) => g.code === code && (last = g));
await emit(sa, "join", code);
for (const [f, t] of [["e2","e4"],["d2","d4"]]) { await new Promise((r) => setTimeout(r, 3000)); await emit(sa, "move", { code, from: f, to: t }).catch(() => {}); }
await new Promise((r) => setTimeout(r, 3000));
const before = await rating(A);
await emit(sa, "resign", code); await new Promise((r) => setTimeout(r, 500));
console.log("4. resign vs bot easy(1400): plies", last.moves.length, "change", JSON.stringify(last.ratingChange), "| rating", before, "->", await rating(A));
console.log("leaderboard top:", JSON.stringify((await get("/api/leaderboard", A.token)).slice(0, 3)));
console.log("bot never rated:", JSON.stringify((await get("/api/leaderboard", A.token)).filter((r) => r.username === "Coach")));
process.exit(0);
