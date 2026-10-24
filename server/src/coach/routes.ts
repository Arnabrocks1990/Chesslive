import crypto from "node:crypto";
import type { Express, Request, Response } from "express";
import type { Redis } from "ioredis";
import { Chess } from "chess.js";
import { isDbUnavailable, query } from "../db.js";
import { askClaude } from "../claude.js";
import { config } from "../config.js";
import { evaluateProgress, isRunning, rankWeaknesses, startRun } from "./agent.js";
import { fetchChessCom, fetchLichess, parseGame, splitPgns, storeGame } from "./importer.js";
import { SAMPLE_GAMES } from "./samples.js";
import { hintFor, loadMistake, verdictExtras } from "./hints.js";
import { accessFor, activateSubscription, answerQuestion, listSessions, resolvePlay, sessionView, startSession } from "./sessions.js";
import { THEME_LABEL } from "./tagger.js";

type User = import("../auth.js").User;
type Authed = (req: Request, res: Response) => User | null;

const INTERVALS = [1, 3, 7, 14];
const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response) =>
  fn(req, res).catch((e) => {
    if (isDbUnavailable(e)) return void res.status(503).json({ error: "The server could not reach its database. Please try again in a moment." });
    const user = /not found|Network error|returned \d+|PGN|Provide|must|No games|already|Finish|Not enough|Hints unlock|No hint|No plan/i.test(e.message);
    if (!user) console.error(e);
    res.status(user ? 400 : 500).json({ error: user ? e.message : "Server error" });
  });

async function overview(playerId: number, hooks?: { weekly: () => Promise<unknown> }) {
  const [player] = await query<any>(`SELECT id, platform, username, goal, autopoll, share_token, last_checked_at, created_at FROM players WHERE id=$1`, [playerId]);
  if (!player) return null;
  const [plan] = await query<any>(`SELECT version, focus_themes, diagnosis, items, rationale, nudge, created_at FROM plans WHERE player_id=$1 ORDER BY version DESC LIMIT 1`, [playerId]);
  const rank = await rankWeaknesses(playerId);
  const progress = await evaluateProgress(playerId);
  const examples = await query<any>(
    `SELECT m.id, m.ply, m.severity, m.phase, m.themes, m.win_pct_drop, m.played_san, m.best_san, m.pv, m.fen_before, m.explanation, g.code, g.source
     FROM mistakes m JOIN games g ON g.id=m.game_id WHERE m.player_id=$1 AND m.severity <> 'inaccuracy' ORDER BY m.win_pct_drop DESC LIMIT 6`, [playerId]);
  const [counts] = await query<any>(
    `SELECT COUNT(*) games,
            COUNT(*) FILTER (WHERE source='simulated') simulated,
            COUNT(*) FILTER (WHERE (SELECT COUNT(*) FROM analyses a WHERE a.game_id=games.id) < (SELECT COUNT(*) FROM moves m WHERE m.game_id=games.id)+1) pending
     FROM games WHERE player_id=$1`, [playerId]);
  const [drill] = await query<any>(`SELECT COUNT(*) total, COALESCE(SUM(attempts),0) attempts, COALESCE(SUM(passes),0) passes, COUNT(*) FILTER (WHERE attempts>0) attempted FROM drills WHERE player_id=$1`, [playerId]);
  const [run] = await query<any>(`SELECT id, status, trigger, mode, decision, error, started_at, ended_at FROM agent_runs WHERE player_id=$1 ORDER BY id DESC LIMIT 1`, [playerId]);
  const runs = await query<any>(`SELECT id, trigger, status, mode, decision, started_at, ended_at FROM agent_runs WHERE player_id=$1 ORDER BY id DESC LIMIT 8`, [playerId]);
  return {
    player, plan: plan ?? null, weaknesses: rank.rows.map((w) => ({ ...w })), analysedGames: rank.games, totals: rank.total, progress, examples,
    games: { total: Number(counts.games), simulated: Number(counts.simulated), pending: Number(counts.pending) },
    drills: { total: Number(drill.total), attempts: Number(drill.attempts), passes: Number(drill.passes), attempted: Number(drill.attempted) },
    latestRun: run ?? null, runs, running: isRunning(playerId), themeLabels: THEME_LABEL,
    exampleExtras: Object.fromEntries(await Promise.all(examples.map(async (x: any) => { const m = await loadMistake(x.id); return [x.id, m ? await verdictExtras(m) : null]; }))),
    sessions: await listSessions(playerId, hooks), access: await accessFor(playerId),
  };
}

export function registerCoachRoutes(app: Express, redis: Redis, authed: Authed, createBotGame: (user: User) => Promise<string>) {
  const guard = (fn: (req: Request, res: Response) => Promise<unknown>) =>
    wrap(async (req, res) => { if (!authed(req, res)) return; await fn(req, res); });

  // Onboard by username (Lichess / Chess.com) or pasted PGN. Starts the first agent run.
  app.post("/api/coach/players", guard(async (req, res) => {
    const platform = String(req.body.platform || "lichess");
    const goal = req.body.goal ? String(req.body.goal).slice(0, 200) : null;
    if (platform === "pgn") {
      const name = String(req.body.name || "").trim().slice(0, 40) || "You";
      const pgn = String(req.body.pgn || "");
      const who = String(req.body.color || name);
      if (!pgn.trim()) throw new Error("Provide a PGN");
      const games = splitPgns(pgn).map((p) => parseGame(p, who)).filter(Boolean);
      if (!games.length) throw new Error(`No games found for "${who}" in that PGN. Choose your colour or match the name in the White/Black tags.`);
      const [p] = await query<{ id: number }>(
        `INSERT INTO players (platform, username, goal, share_token, owner_id) VALUES ('pgn',$1,$2,$3,$4)
         ON CONFLICT (owner_id, platform, username) DO UPDATE SET goal=COALESCE(EXCLUDED.goal, players.goal) RETURNING id`,
        [`${name}-${crypto.randomBytes(2).toString("hex")}`, goal, crypto.randomBytes(8).toString("hex"), authed(req, res)!.id]);
      const ids: number[] = [];
      for (const g of games.slice(0, 20)) { const id = await storeGame(p.id, "pgn", g!); if (id) ids.push(id); }
      const runId = await startRun(redis, p.id, "onboarding", { extraGameIds: ids });
      return res.json({ playerId: p.id, runId });
    }
    if (platform !== "lichess" && platform !== "chesscom") throw new Error("Platform must be lichess, chesscom or pgn");
    const username = String(req.body.username || "").trim();
    if (!/^[A-Za-z0-9_-]{2,30}$/.test(username)) throw new Error("Enter a valid username");
    // Verify the account exists before creating anything.
    const probe = platform === "lichess" ? await fetchLichess(username, 1) : await fetchChessCom(username, 1);
    void probe;
    const [p] = await query<{ id: number }>(
      `INSERT INTO players (platform, username, goal, share_token, owner_id) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (owner_id, platform, username) DO UPDATE SET goal=COALESCE(EXCLUDED.goal, players.goal) RETURNING id`,
      [platform, username.toLowerCase(), goal, crypto.randomBytes(8).toString("hex"), authed(req, res)!.id]);
    const runId = await startRun(redis, p.id, "onboarding");
    res.json({ playerId: p.id, runId });
  }));

  // Each user sees only their own profiles; admins see everyone's (with the owner's name).
  app.get("/api/coach/players", guard(async (req, res) => {
    const user = authed(req, res)!;
    res.json(await query(`SELECT p.id, p.platform, p.username, p.created_at, u.username AS owner,
      (SELECT COUNT(*) FROM games g WHERE g.player_id=p.id) games
      FROM players p LEFT JOIN users u ON u.id=p.owner_id
      WHERE ($1::boolean OR p.owner_id=$2) ORDER BY p.id DESC LIMIT 20`, [user.role === "admin", user.id]));
  }));

  const weeklyFor = (playerId: number) => ({ weekly: () => startRun(redis, playerId, "weekly") });

  app.get("/api/coach/players/:id", guard(async (req, res) => {
    const o = await overview(Number(req.params.id), weeklyFor(Number(req.params.id)));
    if (!o) return res.status(404).json({ error: "Player not found" });
    res.json(o);
  }));

  app.get("/api/coach/runs/:id", guard(async (req, res) => {
    const [run] = await query<any>(`SELECT * FROM agent_runs WHERE id=$1`, [Number(req.params.id)]);
    if (!run) return res.status(404).json({ error: "Run not found" });
    const steps = await query<any>(`SELECT id, n, tool, input, output_summary, note, ts FROM agent_steps WHERE run_id=$1 ORDER BY n`, [run.id]);
    res.json({ run, steps });
  }));

  app.post("/api/coach/players/:id/run", guard(async (req, res) => {
    res.json({ runId: await startRun(redis, Number(req.params.id), "manual") });
  }));

  // Autonomy demo fallback: inject a stored game as if the player had just finished it.
  app.post("/api/coach/players/:id/simulate", guard(async (req, res) => {
    const playerId = Number(req.params.id);
    const used = new Set((await query<{ external_id: string }>(`SELECT external_id FROM games WHERE player_id=$1 AND source='simulated'`, [playerId])).map((r) => r.external_id));
    const sample = SAMPLE_GAMES.find((s) => !used.has(s.id));
    if (!sample) throw new Error("All simulated games were already used");
    const g = parseGame(sample.pgn, sample.color, sample.id);
    if (!g) throw new Error("Simulated game could not be parsed");
    g.playedAt = new Date();
    const id = await storeGame(playerId, "simulated", g);
    res.json({ runId: await startRun(redis, playerId, "simulated", { extraGameIds: id ? [id] : [] }) });
  }));

  // Floating-assistant Q&A: answers only from the player's own analysed data.
  app.post("/api/coach/players/:id/ask", guard(async (req, res) => {
    const o = await overview(Number(req.params.id));
    if (!o) return res.status(404).json({ error: "Player not found" });
    const question = String(req.body.question || "").trim().slice(0, 300);
    if (!question) throw new Error("Provide a question");
    const facts = {
      goal: o.player.goal, analysedGames: o.analysedGames,
      weaknesses: o.weaknesses.filter((w) => w.theme !== "other").slice(0, 5).map((w) => ({ pattern: w.label, times: w.count, per100: w.per100, before: w.prevPer100, trend: w.trend })),
      focus: o.plan?.focus_themes.map((t: string) => o.themeLabels[t] ?? t), diagnosis: o.plan?.diagnosis,
      today: o.plan?.items.slice(0, 2), progress: o.progress, drills: o.drills,
      costliestMistakes: o.examples.slice(0, 3).map((x) => ({ played: x.played_san, stockfishPrefers: x.best_san, winChanceLost: Math.round(x.win_pct_drop), line: x.pv, why: x.explanation })),
    };
    const fallback = () => o.plan
      ? `Your plan focuses on ${o.plan.focus_themes.map((t: string) => o.themeLabels[t] ?? t).join(", ")}. ${o.plan.diagnosis}`
      : "I need at least 3 analysed games before I can say anything reliable. Let the coach run first.";
    if (!config.explain || !o.analysedGames) return res.json({ answer: fallback(), mode: "rules" });
    const prompt = [
      "You are a concise chess coach inside a floating assistant. Answer ONLY from the facts JSON; it came from engine analysis and rule tags. Never evaluate positions yourself or invent numbers, moves or games. Call the engine's preferred move 'the coach move' and never say Stockfish.",
      "If the question is not about improving at chess or the data does not cover it, say so in one sentence and suggest what you can answer. Max 80 words, plain text, no markdown.",
      `Facts: ${JSON.stringify(facts)}`,
      `Question: ${question}`,
    ].join("\n");
    try {
      const answer = await Promise.race([askClaude(prompt), new Promise<string>((_, rej) => setTimeout(() => rej(new Error("timed out")), 60_000))]);
      res.json({ answer, mode: "llm" });
    } catch {
      res.json({ answer: fallback(), mode: "rules" });
    }
  }));

  // Plain English version of the plan text. One AI call, cached per plan; it may only reword, not add facts.
  app.post("/api/coach/players/:id/plain", guard(async (req, res) => {
    const pid = Number(req.params.id);
    const [plan] = await query<any>(`SELECT id, diagnosis, rationale FROM plans WHERE player_id=$1 ORDER BY version DESC LIMIT 1`, [pid]);
    if (!plan) throw new Error("No plan yet");
    const [cached] = await query<any>(`SELECT data FROM plain_cache WHERE plan_id=$1`, [plan.id]);
    if (cached) return res.json(cached.data);
    const sessions = await listSessions(pid, weeklyFor(pid));
    const source = { diagnosis: plan.diagnosis, rationale: plan.rationale, sessions: Object.fromEntries(sessions.map((s) => [s.id, { title: s.title, detail: s.detail }])) };
    const prompt = [
      "Rewrite this chess coaching text in very simple English for a beginner or a child.",
      "Rules: no chess notation (no Nd4, Bc3, 47. e4 or move numbers), no square names like e4 or d5, no jargon (say 'a piece nobody protects' instead of 'hanging piece' or 'undefended'). Use piece names and plain words only.",
      "Keep every number and every fact exactly as given. Do not add new advice or new facts. Never mention Stockfish; call it 'the coach'. Keep each text no longer than the original.",
      "Return JSON only with exactly the same keys and structure as the input.",
      `Input: ${JSON.stringify(source)}`,
    ].join("\n");
    let data: any;
    try {
      const raw = await Promise.race([askClaude(prompt), new Promise<string>((_, rej) => setTimeout(() => rej(new Error("timed out")), 90_000))]);
      data = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
      if (typeof data.diagnosis !== "string" || typeof data.sessions !== "object") throw new Error("bad shape");
    } catch (e: any) {
      return res.status(502).json({ error: `Could not simplify right now (${e.message}). Showing the standard text.` });
    }
    await query(`INSERT INTO plain_cache (plan_id, data) VALUES ($1,$2) ON CONFLICT (plan_id) DO UPDATE SET data=EXCLUDED.data`, [plan.id, JSON.stringify(data)]);
    res.json(data);
  }));

  app.post("/api/coach/players/:id/delete", guard(async (req, res) => {
    const id = Number(req.params.id);
    await query(`DELETE FROM games WHERE player_id=$1`, [id]);
    // Plan sessions (and, by cascade, their questions) and the cached plain-English text hold the player's data too.
    await query(`DELETE FROM plain_cache WHERE plan_id IN (SELECT id FROM plans WHERE player_id=$1)`, [id]).catch(() => undefined);
    await query(`DELETE FROM plan_sessions WHERE player_id=$1`, [id]).catch(() => undefined);
    for (const t of ["drills", "plans", "agent_runs", "mistakes"]) await query(`DELETE FROM ${t} WHERE player_id=$1`, [id]).catch(() => undefined);
    await query(`DELETE FROM players WHERE id=$1`, [id]);
    res.json({ ok: true });
  }));

  // ---- outcome-based daily sessions ------------------------------------------------------
  const sessionOwner = async (id: number) => (await query<{ player_id: number }>(`SELECT player_id FROM plan_sessions WHERE id=$1`, [id]))[0]?.player_id;

  app.get("/api/coach/sessions/:id", guard(async (req, res) => {
    const pid = await sessionOwner(Number(req.params.id));
    if (!pid) return res.status(404).json({ error: "Session not found" });
    const v = await sessionView(Number(req.params.id), pid, weeklyFor(pid));
    res.json({ ...v, access: await accessFor(pid), playerId: pid });
  }));

  app.post("/api/coach/sessions/:id/start", guard(async (req, res) => {
    const user = authed(req, res)!;
    const id = Number(req.params.id);
    const pid = await sessionOwner(id);
    if (!pid) return res.status(404).json({ error: "Session not found" });
    const s = (await listSessions(pid, weeklyFor(pid))).find((x) => x.id === id)!;
    if (s.state === "paywall") return res.status(402).json({ error: "payment_required" });
    if (s.state === "locked") throw new Error("Finish the previous day's milestone first");
    if (s.state === "done") throw new Error("This day is already complete");
    res.json(await startSession(id, { createBotGame: () => createBotGame(user), force: !!req.body.force }));
  }));

  app.post("/api/coach/session-questions/:id/answer", guard(async (req, res) => {
    const [q] = await query<{ session_id: number }>(`SELECT session_id FROM session_questions WHERE id=$1`, [Number(req.params.id)]);
    if (!q) return res.status(404).json({ error: "Question not found" });
    const pid = await sessionOwner(q.session_id);
    const s = (await listSessions(pid!, weeklyFor(pid!))).find((x) => x.id === q.session_id)!;
    if (s.state === "paywall") return res.status(402).json({ error: "payment_required" });
    res.json(await answerQuestion(Number(req.params.id), String(req.body.uci || ""), weeklyFor(pid!)));
  }));

  // Hints are revealed one at a time, only when asked for.
  app.post("/api/coach/session-questions/:id/hint", guard(async (req, res) => {
    const [q] = await query<any>(`SELECT id, mistake_id, hints_used FROM session_questions WHERE id=$1`, [Number(req.params.id)]);
    if (!q) return res.status(404).json({ error: "Question not found" });
    const n = Number(req.body.n);
    if (![1, 2, 3].includes(n) || n > q.hints_used + 1) throw new Error("Hints unlock one at a time");
    const m = await loadMistake(q.mistake_id);
    const h = m && hintFor(m, n);
    if (!h) throw new Error("No hint available for this position");
    await query(`UPDATE session_questions SET hints_used=GREATEST(hints_used,$2) WHERE id=$1`, [q.id, n]);
    res.json(h);
  }));

  app.post("/api/coach/drills/:id/hint", guard(async (req, res) => {
    const [d] = await query<{ mistake_id: number }>(`SELECT mistake_id FROM drills WHERE id=$1`, [Number(req.params.id)]);
    if (!d) return res.status(404).json({ error: "Drill not found" });
    const n = Number(req.body.n);
    if (![1, 2, 3].includes(n)) throw new Error("Hints unlock one at a time");
    const m = await loadMistake(d.mistake_id);
    const h = m && hintFor(m, n);
    if (!h) throw new Error("No hint available for this position");
    res.json(h);
  }));

  // Demo reset. Admin only: enforced here on the server, the button is only a convenience.
  app.post("/api/coach/players/:id/admin/reset-exercises", guard(async (req, res) => {
    const user = authed(req, res)!;
    if (user.role !== "admin") return res.status(403).json({ error: "Admin only" });
    const pid = Number(req.params.id);
    if (isRunning(pid)) throw new Error("Wait for the coach run to finish before resetting");
    const ids = (await query<{ id: number }>(`SELECT id FROM plan_sessions WHERE player_id=$1`, [pid])).map((r) => r.id);
    await query(`DELETE FROM session_questions WHERE session_id = ANY($1::int[])`, [ids]);
    await query(
      `UPDATE plan_sessions SET status='pending', attempts=0, score=NULL, total=NULL, passed=NULL, completed_at=NULL, started_at=NULL, game_code=NULL,
         goal=REGEXP_REPLACE(goal, 'of [0-9]+', 'of 5') WHERE player_id=$1`, [pid]);
    await query(`UPDATE drills SET attempts=0, passes=0, last_result=NULL, interval_days=1, due_at=now() WHERE player_id=$1`, [pid]);
    await query(`DELETE FROM agent_runs WHERE player_id=$1 AND trigger='session'`, [pid]);
    // Only demo payments are cleared; a real subscription is never touched by a reset.
    const demo = await query(`DELETE FROM subscriptions WHERE player_id=$1 AND provider='demo' RETURNING id`, [pid]);
    console.log(`coach: admin ${user.username} reset exercises for player ${pid}`);
    res.json({ ok: true, sessionsReset: ids.length, demoPaymentsCleared: demo.length });
  }));

  // The demo checkout (free instant unlock) is gone. Payment is now QR/UPI + admin confirmation:
  // see /api/billing/* here and the confirm action on the admin server (port 8003).
  app.post("/api/coach/players/:id/checkout", guard(async (_req, res) => {
    res.status(410).json({ error: "Demo checkout has been removed. Pay via the QR code; access unlocks once the admin confirms." });
  }));

  // ---- drills ---------------------------------------------------------------------
  app.get("/api/coach/players/:id/drills/next", guard(async (req, res) => {
    const [d] = await query<any>(
      `SELECT d.id, d.attempts, m.fen_before fen, m.themes, m.phase, m.severity
       FROM drills d JOIN mistakes m ON m.id=d.mistake_id WHERE d.player_id=$1
       ORDER BY (d.due_at <= now()) DESC, d.attempts ASC, d.due_at ASC, d.id LIMIT 1`, [Number(req.params.id)]);
    if (!d) return res.json({ drill: null });
    const turn = new Chess(d.fen).turn();
    const [left] = await query<{ n: string }>(`SELECT COUNT(*) n FROM drills WHERE player_id=$1 AND due_at <= now()`, [Number(req.params.id)]);
    res.json({ drill: { id: d.id, fen: d.fen, turn, themes: d.themes, phase: d.phase, dueCount: Number(left.n) } });
  }));

  app.post("/api/coach/drills/:id/answer", guard(async (req, res) => {
    const [d] = await query<any>(
      `SELECT d.*, m.best_uci, m.best_san, m.pv, m.played_san, m.explanation, m.fen_before FROM drills d JOIN mistakes m ON m.id=d.mistake_id WHERE d.id=$1`, [Number(req.params.id)]);
    if (!d) return res.status(404).json({ error: "Drill not found" });
    const uci = String(req.body.uci || "");
    const pass = uci === d.best_uci;
    const next = pass ? INTERVALS[Math.min(INTERVALS.indexOf(d.interval_days) + 1, INTERVALS.length - 1)] : 1;
    await query(
      `UPDATE drills SET attempts=attempts+1, passes=passes+$2::int, last_result=$3::text, interval_days=$4::int,
        due_at = CASE WHEN $2::int=1 THEN now() + make_interval(days => $4::int) ELSE now() END WHERE id=$1`,
      [d.id, pass ? 1 : 0, pass ? "pass" : "fail", next]);
    const mistake = await loadMistake(d.mistake_id);
    res.json({ pass, bestSan: d.best_san, bestUci: d.best_uci, pv: d.pv, youPlayedInGame: d.played_san, explanation: d.explanation, nextReviewDays: pass ? next : 0, fen: d.fen_before, ...(mistake ? await verdictExtras(mistake) : {}) });
  }));

  // Public, read-only shareable report (the token is the access control).
  app.get("/api/coach/share/:token", wrap(async (req, res) => {
    const [p] = await query<{ id: number }>(`SELECT id FROM players WHERE share_token=$1`, [req.params.token]);
    if (!p) return res.status(404).json({ error: "Report not found" });
    const o = await overview(p.id);
    res.json({ ...o, runs: undefined, latestRun: undefined });
  }));
}

// ---- autonomy: the agent wakes itself when new games appear or the player goes quiet ------------------
export function startPoller(redis: Redis) {
  const every = Number(process.env.COACH_POLL_MS || 300_000);
  const idleMs = Number(process.env.COACH_IDLE_HOURS || 72) * 3_600_000;
  if (every <= 0) return;
  setInterval(async () => {
    try {
      const players = await query<any>(`SELECT * FROM players WHERE autopoll AND platform IN ('lichess','chesscom')
        AND EXISTS (SELECT 1 FROM plans WHERE plans.player_id=players.id)`);
      for (const p of players) {
        if (isRunning(p.id)) continue;
        const fetched = p.platform === "lichess" ? await fetchLichess(p.username, 3, p.last_checked_at) : await fetchChessCom(p.username, 3, p.last_checked_at);
        const fresh: boolean[] = [];
        for (const g of fetched) fresh.push(!(await query(`SELECT 1 FROM games WHERE source=$1 AND external_id=$2`, [p.platform, g.externalId])).length);
        if (fresh.some(Boolean)) { console.log(`coach: new games for ${p.username}, waking agent`); await startRun(redis, p.id, "new_games"); continue; }
        const [idle] = await query<any>(
          `SELECT (SELECT MAX(created_at) FROM plans WHERE player_id=$1) plan_at,
                  (SELECT MAX(started_at) FROM agent_runs WHERE player_id=$1) run_at,
                  (SELECT COALESCE(SUM(attempts),0) FROM drills WHERE player_id=$1) attempts`, [p.id]);
        if (Number(idle.attempts) === 0 && Date.now() - new Date(idle.run_at).getTime() > idleMs) await startRun(redis, p.id, "idle");
      }
    } catch (e: any) {
      console.warn("coach poll skipped:", e.message);
    }
  }, every).unref();
}
