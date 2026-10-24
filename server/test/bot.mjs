import { io } from "socket.io-client";
import { Chess } from "chess.js";
const BASE = "http://localhost:8001";
const post = async (p, body, token) => (await fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json", ...(token && { authorization: "Bearer " + token }) }, body: JSON.stringify(body) })).json();
const get = async (p, token) => (await fetch(BASE + p, { headers: { authorization: "Bearer " + token } })).json();
const me = await post("/api/register", { username: "tester" + Math.floor(Math.random() * 1e6), password: "secret1" });
const s = io(BASE, { auth: { token: me.token } });
await new Promise((r) => s.on("connect", r));
const emit = (ev, p) => new Promise((r) => s.emit(ev, p, r));

async function play(color, level, maxPly) {
  const { code } = await post("/api/games", { color, minutes: 10, vsBot: true, level }, me.token);
  let state, done;
  const finished = new Promise((r) => (done = r));
  s.on("state", (g) => { if (g.code !== code) return; state = g; step(); });
  let busy = false;
  async function step() {
    if (busy || !state) return;
    if (state.status === "finished") return done();
    const mySide = color === "white" ? "w" : "b";
    if (state.status !== "active" || state.turn !== mySide) return;
    if (state.moves.length >= maxPly) { busy = true; await emit("resign", code); busy = false; return; }
    busy = true;
    const c = new Chess(state.fen); const ms = c.moves({ verbose: true });
    const m = ms[Math.floor(Math.random() * ms.length)];
    const r = await emit("move", { code, from: m.from, to: m.to, promotion: m.promotion || "q" });
    if (!r.ok) console.log("move rejected", r.error);
    busy = false;
  }
  await emit("join", code);
  await Promise.race([finished, new Promise((r) => setTimeout(r, 60000))]);
  s.off("state");
  console.log(`${color}/${level}: ${state.white?.name} vs ${state.black?.name}, plies ${state.moves.length}, ${state.result} (${state.termination}), vsBot=${state.vsBot}`);
  return code;
}
const codes = [];
codes.push(await play("white", "easy", 24));
codes.push(await play("black", "medium", 24));   // bot moves first here
codes.push(await play("white", "hard", 24));
codes.push(await play("black", "max", 24));
console.log("profile:", JSON.stringify(await get("/api/profile/" + me.user.username, me.token)).slice(0, 400));
process.exit(0);
