import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";
import { Redis } from "ioredis";
import { Server } from "socket.io";
import * as auth from "./auth.js";
import { askClaude } from "./claude.js";
import { assertProductionConfig, config } from "./config.js";
import { ensureBaseSchema } from "./baseSchema.js";
import { isDbUnavailable, query } from "./db.js";
import { GameError, GameManager } from "./games.js";
import { buildReport } from "./report.js";
import { buildProfile } from "./profile.js";
import { ensureCoachSchema } from "./coach/schema.js";
import { registerCoachRoutes, startPoller } from "./coach/routes.js";
import { registerTtsRoutes } from "./tts.js";
import { ensureLearnerSchema, learnerBadges, registerLearnerRoutes } from "./learner.js";
import { ensureBillingSchema } from "./billing/schema.js";
import { registerBillingRoutes } from "./billing/routes.js";
import { coachOwnerGate } from "./coach/access.js";
import { adminRouter } from "./admin/router.js";
import { Matchmaker } from "./matchmaker.js";
import { ensureImproveSchema, registerImproveRoutes } from "./improve/index.js";

const app = express();
app.use(cors());
app.set("trust proxy", 1); // behind Render's proxy: req.ip is the visitor (admin login rate limit)
// The admin API takes its own (larger) JSON parser for the QR upload, so it is mounted before the default one.
// Every route in it requires a signed-in admin (re-checked against the database).
app.use("/api/admin", adminRouter);
app.use(express.json());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
const redis = new Redis(config.redisUrl);
const sub = new Redis(config.redisUrl);
// ioredis reconnects by itself; without a handler every failed attempt prints an 'Unhandled error event' stack.
let lastRedisLog = 0;
for (const r of [redis, sub]) r.on("error", (e) => { if (Date.now() - lastRedisLog > 30_000) { lastRedisLog = Date.now(); console.error("redis unavailable (retrying):", e.message); } });
process.on("unhandledRejection", (e) => console.error("unhandled rejection:", e));
const games = new GameManager(io, redis);
const matchmaker = new Matchmaker(io, games);

// ---- REST -----------------------------------------------------------------

const wrap =
  (fn: (req: express.Request, res: express.Response) => Promise<unknown>) =>
  (req: express.Request, res: express.Response) =>
    fn(req, res).catch((e) => {
      if (isDbUnavailable(e)) return void res.status(503).json({ error: "The server could not reach its database. Please try again in a moment." });
      const status = e instanceof GameError || /taken|Invalid|must be|blocked/.test(e.message) ? 400 : 500;
      if (status === 500) console.error(e);
      res.status(status).json({ error: status === 500 ? "Server error" : e.message });
    });

const session = (u: auth.User) => { auth.touchSeen(u.id); return { token: auth.signToken(u), user: u }; };

app.post("/api/register", wrap(async (req, res) => res.json(session(await auth.register(req.body.username, req.body.password)))));
app.post("/api/login", wrap(async (req, res) => res.json(session(await auth.login(req.body.username, req.body.password)))));
app.post("/api/guest", wrap(async (req, res) => res.json(session(await auth.guest(req.body?.name)))));

function authed(req: express.Request, res: express.Response): auth.User | null {
  const user = auth.verifyToken((req.headers.authorization || "").replace(/^Bearer /, ""));
  if (!user) res.status(401).json({ error: "Not signed in" });
  else auth.touchSeen(user.id);
  return user;
}

// Render health check: confirms the process is up and the database answers.
app.get("/healthz", wrap(async (_req, res) => { await query("SELECT 1"); res.json({ ok: true }); }));

app.get("/api/me", wrap(async (req, res) => {
  const user = authed(req, res);
  if (!user) return;
  const [row] = await query<{ rating: number; rated_games: number }>(`SELECT rating, rated_games FROM users WHERE id=$1`, [user.id]);
  if (!row) return res.status(401).json({ error: "Not signed in" });
  res.json({ user, rating: row.rating, ratedGames: row.rated_games });
}));

app.get("/api/leaderboard", wrap(async (req, res) => {
  if (!authed(req, res)) return;
  const rows = await query<{ id: number; username: string; rating: number; ratedGames: number }>(
    `SELECT id, username, rating, rated_games AS "ratedGames" FROM users
     WHERE role <> 'bot' AND rated_games > 0 ORDER BY rating DESC, rated_games DESC LIMIT 20`
  );
  const badges = await learnerBadges(rows.map((r) => r.id));
  res.json(rows.map(({ id, ...r }) => ({ ...r, learner: badges.get(id) ?? null })));
}));

app.post("/api/games", wrap(async (req, res) => {
  const user = authed(req, res);
  if (user) res.json({ code: await games.create(user, req.body || {}) });
}));

app.get("/api/games/mine", wrap(async (req, res) => {
  const user = authed(req, res);
  if (!user) return;
  res.json(
    await query(
      `SELECT g.code, g.status, g.result, g.termination, g.time_control_sec, g.increment_sec, g.created_at,
              w.username AS white, b.username AS black
       FROM games g LEFT JOIN users w ON w.id=g.white_id LEFT JOIN users b ON b.id=g.black_id
       WHERE g.white_id=$1 OR g.black_id=$1 ORDER BY g.created_at DESC LIMIT 50`,
      [user.id]
    )
  );
}));

app.get("/api/profile/:username", wrap(async (req, res) => {
  const viewer = authed(req, res);
  if (!viewer) return;
  const p = await buildProfile(req.params.username, viewer);
  if (!p) return res.status(404).json({ error: "Player not found" });
  res.json(p);
}));

app.get("/api/games/:code", wrap(async (req, res) => {
  const g = await games.get(req.params.code);
  if (!g) return res.status(404).json({ error: "Game not found" });
  res.json(games.view(g));
}));

// The analysis of a game is private to the two players (and admins).
app.get("/api/games/:code/report", wrap(async (req, res) => {
  const viewer = authed(req, res);
  if (!viewer) return;
  const g = await games.get(req.params.code);
  if (!g || (viewer.role !== "admin" && g.white?.id !== viewer.id && g.black?.id !== viewer.id)) return res.status(404).json({ error: "Game not found" });
  if (g.status !== "finished") return res.status(400).json({ error: "Report is available after the game ends" });
  res.json(await buildReport(g.id));
}));

app.get("/api/games/:code/pgn", wrap(async (req, res) => {
  const [row] = await query<{ pgn: string | null }>(`SELECT pgn FROM games WHERE code=$1`, [req.params.code]);
  if (!row?.pgn) return res.status(404).json({ error: "PGN not available" });
  res.type("application/x-chess-pgn").send(row.pgn);
}));

registerLearnerRoutes(app, (req, res) => authed(req, res));
registerBillingRoutes(app, (req, res) => authed(req, res));
registerTtsRoutes(app, (req, res) => authed(req, res));
registerImproveRoutes(app, (req, res) => authed(req, res));
app.use("/api/coach", coachOwnerGate); // profile data is private to its owner (and admins)
registerCoachRoutes(app, redis, (req, res) => authed(req, res), (user) => games.create(user, { color: "random", minutes: 15, increment: 10, vsBot: true, level: "medium" }));

// ---- Realtime -------------------------------------------------------------

io.use((socket, next) => {
  const user = auth.verifyToken(String(socket.handshake.auth?.token || ""));
  if (!user) return next(new Error("unauthorized"));
  socket.data.user = user;
  next();
});

// Presence heartbeat: everyone with an open socket counts as online. Blocked accounts are dropped within seconds.
setInterval(() => {
  for (const s of io.sockets.sockets.values()) if (s.data.user) auth.touchSeen(s.data.user.id, 25_000);
}, 30_000).unref();
async function dropBlocked() {
  await auth.refreshBlocked(); // picks up blocks made from the separate local admin dashboard
  for (const s of io.sockets.sockets.values()) if (s.data.user && auth.isBlocked(s.data.user.id)) { s.emit("blocked"); s.disconnect(true); }
}
setInterval(() => dropBlocked().catch(() => {}), 5_000).unref();

type Ack = (r: { ok: boolean; error?: string }) => void;
const safe = (ack: Ack | undefined, fn: () => Promise<unknown>) =>
  fn().then(
    () => ack?.({ ok: true }),
    (e) => {
      if (!(e instanceof GameError)) console.error(e);
      ack?.({ ok: false, error: e instanceof GameError ? e.message : "Server error" });
    }
  );

io.on("connection", (socket) => {
  const user: auth.User = socket.data.user;

  socket.on("join", (code: string, ack?: Ack) =>
    safe(ack, async () => {
      const g = await games.join(String(code), user);
      socket.join(g.code);
      socket.emit("state", games.view(g));
      if (user.role === "admin") await sendAdminSuggestion(socket, g.code);
    })
  );
  // Random matchmaking by Elo + time control; the "matched" event tells both players which game to open.
  socket.on("findMatch", (p: { minutes?: number; increment?: number }, ack?: Ack) =>
    safe(ack, async () => {
      if (user.role === "bot") throw new GameError("Not available");
      await matchmaker.enqueue(user, socket.id, Number(p?.minutes), Number(p?.increment));
    })
  );
  socket.on("cancelMatch", (_p: unknown, ack?: Ack) => safe(ack, async () => matchmaker.cancel(user.id, socket.id)));
  socket.on("disconnect", () => matchmaker.cancel(user.id, socket.id));
  socket.on("move", (p: { code: string; from: string; to: string; promotion?: string }, ack?: Ack) =>
    safe(ack, () => games.move(String(p.code), user, p))
  );
  socket.on("playBot", (p: { code: string; level?: string }, ack?: Ack) =>
    safe(ack, () => games.playBot(String(p.code), user, p.level))
  );
  socket.on("resign", (code: string, ack?: Ack) => safe(ack, () => games.resign(String(code), user)));
  socket.on("draw", (p: { code: string; action: "offer" | "accept" | "decline" }, ack?: Ack) =>
    safe(ack, () => games.draw(String(p.code), user, p.action))
  );
  socket.on("chat", (p: { code: string; text: string }) => {
    if (!socket.rooms.has(String(p.code))) return;
    const text = String(p.text || "").slice(0, 300);
    if (text) io.to(p.code).emit("chat", { user: user.username, text, ts: Date.now() });
  });
});

/** Late-joining admins get the analysis for the current position (or it is requested). */
async function sendAdminSuggestion(socket: any, code: string) {
  const g = games.peek(code);
  if (!g || g.status !== "active") return;
  const ply = g.moves.length;
  const [row] = await query<any>(`SELECT * FROM analyses WHERE game_id=$1 AND ply=$2 AND similar_positions IS NOT NULL`, [g.id, ply]);
  if (row) {
    socket.emit("suggestion", {
      code, ply, fen: row.fen, top_moves: row.top_moves, eval_cp: row.eval_cp, mate: row.mate,
      similar: row.similar_positions, explanation: row.explanation,
    });
  } else {
    await games.enqueueIfAdminWatching(g);
  }
}

// ---- Analysis results -> admins only --------------------------------------

async function emitToAdmins(code: string, event: string, payload: unknown) {
  for (const s of await io.in(code).fetchSockets()) {
    if (s.data.user?.role === "admin") s.emit(event, payload);
  }
}

function explainPrompt(r: any, turn: string): string {
  const side = turn === "w" ? "White" : "Black";
  const lines = r.top_moves.map((m: any, i: number) => {
    const ev = m.mate !== null && m.mate !== undefined ? `mate in ${Math.abs(m.mate)}` : `${(m.eval_cp / 100).toFixed(2)}`;
    return `${i + 1}. ${m.san} (eval ${ev}, White's view) line: ${m.pv}`;
  });
  const sim = (r.similar || [])
    .filter((s: any) => s.result)
    .map((s: any) => s.result);
  const history = sim.length ? `Similar positions from past games ended: ${sim.join(", ")}.` : "";
  return [
    "You are a concise chess coach. Reply with plain text only, no tools, no markdown, at most 2 short sentences (under 45 words total).",
    `Position (FEN): ${r.fen}. ${side} to move.`,
    "Stockfish's top candidate moves:",
    ...lines,
    history,
    `Explain why ${r.top_moves[0].san} is best for ${side}, and the main idea/threat to watch for.`,
  ].join("\n");
}

sub.subscribe("analysis:results");
sub.on("message", async (_channel, msg) => {
  try {
    const r = JSON.parse(msg);
    if (r.kind === "bot") return void (await games.botMove(r.code, r.fen, r.uci));
    if (r.kind !== "live") return;
    const g = games.peek(r.code);
    if (!g || g.status !== "active" || r.ply !== g.moves.length) return; // stale result
    await emitToAdmins(r.code, "suggestion", r);
    if (!config.explain) return;
    try {
      const explanation = await askClaude(explainPrompt(r, g.chess.turn()));
      await query(`UPDATE analyses SET explanation=$3 WHERE game_id=$1 AND ply=$2`, [r.gameId, r.ply, explanation]);
      if (g.moves.length === r.ply) await emitToAdmins(r.code, "suggestion", { ...r, explanation });
    } catch (e: any) {
      console.warn("explanation skipped:", e.message);
    }
  } catch (e) {
    console.error("bad analysis result", e);
  }
});

// ---- Static client + boot ---------------------------------------------------

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../client/dist");
if (fs.existsSync(dist)) {
  // Hashed bundles never change, so they can be cached hard; index.html must always be revalidated
  // so a rebuild is picked up. A missing /assets file must 404: answering it with index.html (200,
  // text/html) makes the browser silently refuse the script and leaves a blank page.
  app.use("/assets", express.static(path.join(dist, "assets"), { immutable: true, maxAge: "1y", fallthrough: false }));
  app.use("/assets", (_err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(404).type("text/plain").send("Not found"));
  // The payment QR lives in the database (uploaded from the admin dashboard) so it never has to be committed
  // to git. A file at client/public/payment-qr.png is still honoured as a fallback for local use.
  app.get("/payment-qr.png", wrap(async (_req, res) => {
    const rows = await query<{ key: string; value: string }>(`SELECT key, value FROM settings WHERE key IN ('qr_image','qr_type')`);
    const img = rows.find((r) => r.key === "qr_image")?.value;
    if (img) {
      res.setHeader("Cache-Control", "no-cache");
      return void res.type(rows.find((r) => r.key === "qr_type")?.value || "image/png").send(Buffer.from(img, "base64"));
    }
    const file = path.join(dist, "payment-qr.png");
    if (fs.existsSync(file)) return void res.sendFile(file);
    res.status(404).type("text/plain").send("No payment QR has been uploaded yet");
  }));
  // The admin dashboard (same UI as the local one) at /admin/. The page is just a shell: it shows a sign-in form
  // and every API call behind it requires an admin token. The game client only links to it for admins.
  const adminDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../admin/dist");
  if (fs.existsSync(adminDist)) {
    app.get(/^\/admin$/, (_req, res) => res.redirect(301, "/admin/")); // regex: a string route would also match /admin/ and loop
    app.use("/admin/assets", express.static(path.join(adminDist, "assets"), { immutable: true, maxAge: "1y", fallthrough: false }));
    app.use("/admin/assets", (_err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(404).type("text/plain").send("Not found"));
    app.get(/^\/admin\/.*/, (_req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.sendFile(path.join(adminDist, "index.html"));
    });
  }
  app.use(express.static(dist, { index: false }));
  app.get(/^\/(?!api|socket\.io).*/, (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.sendFile(path.join(dist, "index.html"));
  });
}

assertProductionConfig();
await ensureBaseSchema();
await ensureBillingSchema();
await ensureCoachSchema();
await ensureLearnerSchema();
await ensureImproveSchema();
startPoller(redis);
await auth.ensureAdmin();
await auth.refreshBlocked();
games.botId = await auth.ensureBot();
await games.resumeActive();
server.listen(config.port, () => console.log(`Chess server on http://localhost:${config.port}`));
