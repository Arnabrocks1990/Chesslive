import type { Express, Request, Response } from "express";
import { query } from "./db.js";
import type { User } from "./auth.js";

// Learner mode: a guided path for people who have never played chess. XP and levels drive a
// separate Learners leaderboard, so newcomers are compared with each other and not with rated players.

export const LESSONS = ["board", "pawn", "rook", "bishop", "queen", "knight", "king", "values", "check", "mate", "special", "plan"] as const;
export const BEGINNER_BOT_ELO = 600; // marker value: this bot is played by the server, not by Stockfish
const LESSON_XP = [0, 50, 75, 100]; // by stars
const EVENT_XP: Record<string, number> = { first_game: 40, first_win: 100, first_checkmate: 60 };

// Titles by XP. Finishing every lesson makes a player a Graduate whatever their XP.
const LEVELS = [
  { xp: 0, title: "Newcomer" }, { xp: 100, title: "Pawn" }, { xp: 250, title: "Knight" },
  { xp: 450, title: "Bishop" }, { xp: 700, title: "Rook" }, { xp: 1000, title: "Queen" },
];

export async function ensureLearnerSchema() {
  for (const sql of [
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS learner BOOLEAN NOT NULL DEFAULT false`,
    `CREATE TABLE IF NOT EXISTS learner_progress (
       user_id INT NOT NULL, lesson TEXT NOT NULL, stars INT NOT NULL, completed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
       PRIMARY KEY (user_id, lesson))`,
    `CREATE TABLE IF NOT EXISTS learner_events (
       user_id INT NOT NULL, key TEXT NOT NULL, xp INT NOT NULL, at TIMESTAMPTZ NOT NULL DEFAULT now(),
       PRIMARY KEY (user_id, key))`,
  ]) await query(sql);
}

export function levelOf(xp: number, graduated: boolean) {
  const idx = LEVELS.reduce((a, l, i) => (xp >= l.xp ? i : a), 0);
  const next = LEVELS[idx + 1] ?? null;
  return { title: graduated ? "Graduate" : LEVELS[idx].title, level: idx + 1, xp, nextTitle: next?.title ?? null, nextAt: next?.xp ?? null, floor: LEVELS[idx].xp };
}

const XP_SQL = `COALESCE((SELECT SUM(CASE stars WHEN 1 THEN ${LESSON_XP[1]} WHEN 2 THEN ${LESSON_XP[2]} ELSE ${LESSON_XP[3]} END) FROM learner_progress lp WHERE lp.user_id=u.id),0)
              + COALESCE((SELECT SUM(xp) FROM learner_events le WHERE le.user_id=u.id),0)`;

export async function learnerSummary(userId: number) {
  const [u] = await query<any>(
    `SELECT u.learner, (${XP_SQL})::int AS xp, (SELECT COUNT(*) FROM learner_progress lp WHERE lp.user_id=u.id)::int AS done FROM users u WHERE u.id=$1`, [userId]);
  const lessons = Object.fromEntries((await query<{ lesson: string; stars: number }>(`SELECT lesson, stars FROM learner_progress WHERE user_id=$1`, [userId])).map((r) => [r.lesson, r.stars]));
  const graduated = u.done >= LESSONS.length;
  const [rank] = await query<{ r: number }>(
    `SELECT COUNT(*)::int + 1 AS r FROM users u WHERE u.role <> 'bot' AND (${XP_SQL}) > $1`, [u.xp]);
  return { mode: u.learner, ...levelOf(u.xp, graduated), lessons, lessonsDone: u.done, totalLessons: LESSONS.length, graduated, rank: u.xp > 0 ? rank.r : null };
}

/** Adds a badge for the main leaderboard: learners show their level next to the rating. */
export async function learnerBadges(userIds: number[]) {
  if (!userIds.length) return new Map<number, { title: string; graduated: boolean }>();
  const rows = await query<any>(
    `SELECT u.id, u.learner, (${XP_SQL})::int AS xp, (SELECT COUNT(*) FROM learner_progress lp WHERE lp.user_id=u.id)::int AS done FROM users u WHERE u.id = ANY($1)`, [userIds]);
  const out = new Map<number, { title: string; graduated: boolean }>();
  for (const r of rows) if (r.learner || r.xp > 0) { const g = r.done >= LESSONS.length; out.set(r.id, { title: levelOf(r.xp, g).title, graduated: g }); }
  return out;
}

export async function learnersBoard() {
  const rows = await query<any>(
    `SELECT u.id, u.username, u.rating, (${XP_SQL})::int AS xp, (SELECT COUNT(*) FROM learner_progress lp WHERE lp.user_id=u.id)::int AS done
     FROM users u WHERE u.role <> 'bot' AND (u.learner OR EXISTS (SELECT 1 FROM learner_progress lp WHERE lp.user_id=u.id) OR EXISTS (SELECT 1 FROM learner_events le WHERE le.user_id=u.id))
     ORDER BY xp DESC, done DESC, u.username LIMIT 25`);
  return rows.map((r: any) => ({ username: r.username, lessons: r.done, total: LESSONS.length, ...levelOf(r.xp, r.done >= LESSONS.length) }));
}

/** Server-verified XP: only games against the Beginner bot count, and each milestone pays once. */
export async function awardGameEvents(g: { white: { id: number } | null; black: { id: number } | null; result: string | null; termination: string | null; moves: unknown[]; bot: { color: "w" | "b"; elo: number | null } | null }) {
  if (!g.bot || g.bot.elo !== BEGINNER_BOT_ELO || !g.result || g.moves.length < 4) return;
  const human = g.bot.color === "w" ? g.black : g.white;
  if (!human) return;
  const humanWon = g.result === (g.bot.color === "w" ? "0-1" : "1-0");
  const keys = ["first_game", ...(humanWon ? ["first_win"] : []), ...(humanWon && g.termination === "checkmate" ? ["first_checkmate"] : [])];
  for (const key of keys) await query(`INSERT INTO learner_events (user_id, key, xp) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [human.id, key, EVENT_XP[key]]);
}

/** A gentle opponent: mostly random, sometimes grabs a free capture or a mate in one. Never resigns. */
export function beginnerChoice(moves: { from: string; to: string; san: string; captured?: string; promotion?: string }[], rand = Math.random): { from: string; to: string; promotion?: string } {
  const VAL: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9 };
  const mate = moves.find((m) => m.san.endsWith("#"));
  if (mate && rand() < 0.6) return mate;
  const caps = moves.filter((m) => m.captured).sort((a, b) => (VAL[b.captured!] ?? 0) - (VAL[a.captured!] ?? 0));
  if (caps.length && rand() < 0.35) return caps[0];
  return moves[Math.floor(rand() * moves.length)];
}

export function registerLearnerRoutes(app: Express, authed: (req: Request, res: Response) => User | null) {
  const wrap = (fn: (req: Request, res: Response, u: User) => Promise<unknown>) => (req: Request, res: Response) => {
    const u = authed(req, res);
    if (!u) return;
    fn(req, res, u).catch((e) => { console.error(e); res.status(500).json({ error: "Server error" }); });
  };
  app.get("/api/learn/me", wrap(async (_req, res, u) => res.json(await learnerSummary(u.id))));
  app.post("/api/learn/mode", wrap(async (req, res, u) => {
    await query(`UPDATE users SET learner=$2 WHERE id=$1`, [u.id, !!req.body.on]);
    res.json(await learnerSummary(u.id));
  }));
  app.post("/api/learn/lessons/:key", wrap(async (req, res, u) => {
    const key = String(req.params.key);
    if (!(LESSONS as readonly string[]).includes(key)) return void res.status(404).json({ error: "Unknown lesson" });
    const stars = Math.min(3, Math.max(1, Math.round(Number(req.body.stars) || 1)));
    // Keep the best result; replaying a lesson can raise the stars but never pays XP twice for the same stars.
    await query(`INSERT INTO learner_progress (user_id, lesson, stars) VALUES ($1,$2,$3)
                 ON CONFLICT (user_id, lesson) DO UPDATE SET stars=GREATEST(learner_progress.stars, EXCLUDED.stars)`, [u.id, key, stars]);
    await query(`UPDATE users SET learner=true WHERE id=$1 AND NOT learner`, [u.id]);
    res.json(await learnerSummary(u.id));
  }));
  app.get("/api/leaderboard/learners", wrap(async (_req, res) => res.json(await learnersBoard())));
}
