// "Improve your Game": puzzles built from a player's last five finished games (the positions where Stockfish
// found a clearly better move than the one played), topped up with built-in puzzles for new players, plus a
// personal performance dashboard that recommends the AI Coach when the numbers say it would help.
// Hints and verdict text are the coach's own (coach/hints.ts), so both features teach the same way.
import type { Express, Request, Response } from "express";
import type { User } from "../auth.js";
import { isDbUnavailable, query } from "../db.js";
import { THEME_LABEL, tagGame } from "../coach/tagger.js";
import { hintFor, verdictExtras } from "../coach/hints.js";
import { DEFAULT_PUZZLES } from "./defaults.js";
import { DAILY_POOL } from "./dailyPool.js";

// The daily puzzle: one position per calendar day, the same for everybody, picked from the verified pool.
// Solving it extends the streak; a day is "today" in this time zone.
const DAILY_TZ = process.env.DAILY_TZ || "Asia/Kolkata";
const STREAK_GOAL = 5;
const POOL = [...DEFAULT_PUZZLES, ...DAILY_POOL];

const GAMES_FOR_PUZZLES = 5; // puzzles come from this many most recent finished games
const PER_GAME = 3; // the biggest mistakes of each game
const MIN_SET = 6; // a set is topped up with built-in puzzles until it has at least this many
const MIN_PLIES = 8; // shorter games have nothing to learn from
const MIN_DROP = 10; // win-chance points lost: a "mistake" or worse, not an inaccuracy

const winPct = (cp: number) => 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);

export async function ensureImproveSchema() {
  for (const sql of [
    `CREATE TABLE IF NOT EXISTS improve_puzzles (
       id SERIAL PRIMARY KEY,
       user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
       source TEXT NOT NULL,                 -- game | default
       game_id INT REFERENCES games(id) ON DELETE CASCADE,
       ply INT,
       default_key TEXT,
       title TEXT NOT NULL,
       fen TEXT NOT NULL,
       best_uci TEXT NOT NULL,
       best_san TEXT,
       alt_ucis TEXT[] NOT NULL DEFAULT '{}', -- other moves the engine rates about as good
       played_san TEXT,
       themes TEXT[] NOT NULL,
       phase TEXT NOT NULL,
       severity TEXT,
       win_drop REAL,
       pv TEXT,
       idea TEXT,
       status TEXT NOT NULL DEFAULT 'new',   -- new | solved | revealed
       attempts INT NOT NULL DEFAULT 0,
       hints_used INT NOT NULL DEFAULT 0,
       solved_at TIMESTAMPTZ,
       created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
    `CREATE UNIQUE INDEX IF NOT EXISTS improve_puzzles_game_uq ON improve_puzzles (user_id, game_id, ply) WHERE source = 'game'`,
    `CREATE UNIQUE INDEX IF NOT EXISTS improve_puzzles_default_uq ON improve_puzzles (user_id, default_key) WHERE source = 'default'`,
    `ALTER TABLE improve_puzzles ADD COLUMN IF NOT EXISTS daily_date DATE`,
    `CREATE UNIQUE INDEX IF NOT EXISTS improve_puzzles_daily_uq ON improve_puzzles (user_id, daily_date) WHERE source = 'daily'`,
  ]) await query(sql);
}

// ---- building the puzzle set ---------------------------------------------------------------------------

interface Mv { ply: number; san: string; uci: string; clock_ms: number }
interface Top { uci: string; san: string; eval_cp: number; mate: number | null; pv: string }
interface An { ply: number; fen: string; eval_cp: number; mate: number | null; top_moves: Top[] }

async function lastGames(userId: number, n: number) {
  return query<{ id: number; white_id: number | null; black_id: number | null; created_at: string; result: string | null; vs_bot: boolean }>(
    `SELECT g.id, g.white_id, g.black_id, g.created_at, g.result, g.vs_bot,
            (SELECT count(*) FROM moves m WHERE m.game_id = g.id)::int AS plies
     FROM games g
     WHERE (g.white_id = $1 OR g.black_id = $1) AND g.status = 'finished' AND g.player_id IS NULL
       AND (SELECT count(*) FROM moves m WHERE m.game_id = g.id) >= $3
     ORDER BY g.ended_at DESC NULLS LAST, g.id DESC LIMIT $2`,
    [userId, n, MIN_PLIES]
  );
}

async function loadGame(gameId: number) {
  const moves = await query<Mv>(`SELECT ply, san, uci, clock_ms FROM moves WHERE game_id=$1 ORDER BY ply`, [gameId]);
  const analyses = await query<An>(`SELECT ply, fen, eval_cp, mate, top_moves FROM analyses WHERE game_id=$1 ORDER BY ply`, [gameId]);
  return { moves, analyses, complete: analyses.length >= moves.length + 1 }; // the worker analyses every position after the game
}

const colorOf = (g: { white_id: number | null }, userId: number): "white" | "black" => (g.white_id === userId ? "white" : "black");

/** Mines the player's last games for puzzles. Idempotent: a mistake becomes one puzzle, ever. */
async function addGamePuzzles(userId: number) {
  const games = await lastGames(userId, GAMES_FOR_PUZZLES);
  for (const g of games) {
    const { moves, analyses, complete } = await loadGame(g.id);
    if (!complete) continue; // still being analysed: picked up on a later visit
    const color = colorOf(g, userId);
    const me = color === "white" ? 1 : -1;
    const found = tagGame(color, moves, analyses)
      .filter((m) => m.drop >= MIN_DROP && m.bestUci && m.bestSan)
      .sort((a, b) => b.drop - a.drop)
      .slice(0, PER_GAME);
    for (const m of found) {
      const before = analyses.find((a) => a.ply === m.ply - 1)!;
      const best = before.top_moves[0];
      const alts = before.top_moves.slice(1).filter((t) => winPct(me * best.eval_cp) - winPct(me * t.eval_cp) <= 3).map((t) => t.uci);
      const theme = m.themes.find((t) => t !== "other") ?? "other";
      await query(
        `INSERT INTO improve_puzzles (user_id, source, game_id, ply, title, fen, best_uci, best_san, alt_ucis, played_san, themes, phase, severity, win_drop, pv)
         VALUES ($1,'game',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT DO NOTHING`,
        [userId, g.id, m.ply, `${THEME_LABEL[theme] ?? "Better move"} · move ${Math.ceil(m.ply / 2)}`, m.fenBefore, m.bestUci, m.bestSan, alts, m.playedSan, m.themes, m.phase, m.severity, m.drop, m.pv]
      );
    }
  }
  return games.map((g) => g.id);
}

/** Built-in puzzles, easiest first (harder ones first for stronger players), for whoever has too few of their own. */
async function topUpWithDefaults(userId: number, recentGameIds: number[], rating: number) {
  const [{ n }] = await query<{ n: number }>(
    `SELECT count(*)::int n FROM improve_puzzles WHERE user_id=$1 AND status='new' AND (source='default' OR game_id = ANY($2))`, [userId, recentGameIds]);
  const have = new Set((await query<{ default_key: string }>(`SELECT default_key FROM improve_puzzles WHERE user_id=$1 AND source='default'`, [userId])).map((r) => r.default_key));
  const need = MIN_SET - n;
  if (need <= 0) return;
  const order = rating >= 900 ? [2, 3, 1] : [1, 2, 3];
  const pool = DEFAULT_PUZZLES.filter((p) => !have.has(p.key)).sort((a, b) => order.indexOf(a.level) - order.indexOf(b.level));
  for (const p of pool.slice(0, need)) {
    await query(
      `INSERT INTO improve_puzzles (user_id, source, default_key, title, fen, best_uci, themes, phase, idea)
       VALUES ($1,'default',$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
      [userId, p.key, p.title, p.fen, p.best, p.themes, p.phase, p.idea]
    );
  }
}

async function userRating(userId: number) {
  const [u] = await query<{ rating: number }>(`SELECT rating FROM users WHERE id=$1`, [userId]);
  return u?.rating ?? 600;
}

export async function puzzleSet(userId: number) {
  const recent = await addGamePuzzles(userId);
  await topUpWithDefaults(userId, recent, await userRating(userId));
  const rows = await query<any>(
    `SELECT p.id, p.source, p.title, p.themes, p.phase, p.status, p.severity, p.hints_used, p.attempts, p.fen, p.ply, p.game_id,
            g.code AS game_code, g.created_at AS game_at,
            CASE WHEN g.white_id = $1 THEN b.username ELSE w.username END AS opponent
     FROM improve_puzzles p
     LEFT JOIN games g ON g.id = p.game_id
     LEFT JOIN users w ON w.id = g.white_id LEFT JOIN users b ON b.id = g.black_id
     WHERE p.user_id = $1 AND (p.source = 'default' OR p.game_id = ANY($2))
     ORDER BY (p.source = 'game') DESC, g.created_at DESC NULLS LAST, p.ply, p.id`,
    [userId, recent]
  );
  const turnOf = (fen: string) => fen.split(" ")[1];
  const puzzles = rows.map((r: any) => ({
    id: r.id, source: r.source, title: r.title, themes: r.themes, themeLabel: THEME_LABEL[r.themes.find((t: string) => t !== "other") ?? "other"] ?? "Tactics",
    phase: r.phase, status: r.status, severity: r.severity, hintsUsed: r.hints_used, turn: turnOf(r.fen),
    from: r.source === "game" ? { opponent: r.opponent, at: r.game_at, move: Math.ceil(r.ply / 2), code: r.game_code } : null,
  }));
  return {
    puzzles,
    fromGames: puzzles.filter((p) => p.source === "game").length,
    gamesConsidered: recent.length,
    usingDefaults: puzzles.some((p) => p.source === "default"),
    solved: puzzles.filter((p) => p.status === "solved").length,
  };
}

// ---- daily puzzle + streak ----------------------------------------------------------------------------

const dayNumber = (d: string) => Math.floor(Date.parse(d + "T00:00:00Z") / 86_400_000);
const dayString = (n: number) => new Date(n * 86_400_000).toISOString().slice(0, 10);

async function today(): Promise<string> {
  const [r] = await query<{ d: string }>(`SELECT to_char((now() AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS d`, [DAILY_TZ]);
  return r.d;
}

/** Days on which the player solved that day's puzzle (on that same day), as a streak summary. */
export async function streakOf(userId: number, todayStr?: string) {
  const t = todayStr ?? (await today());
  const rows = await query<{ d: string }>(
    `SELECT to_char(daily_date, 'YYYY-MM-DD') AS d FROM improve_puzzles
     WHERE user_id = $1 AND source = 'daily' AND status = 'solved' AND (solved_at AT TIME ZONE $2)::date = daily_date
     ORDER BY daily_date`, [userId, DAILY_TZ]);
  const done = new Set(rows.map((r) => dayNumber(r.d)));
  const tn = dayNumber(t);
  // the streak is alive if today or yesterday is done (today can still be completed)
  let cur = 0;
  for (let n = done.has(tn) ? tn : tn - 1; done.has(n); n--) cur++;
  let best = 0, run = 0, prev = -Infinity;
  for (const n of [...done].sort((a, b) => a - b)) { run = n === prev + 1 ? run + 1 : 1; best = Math.max(best, run); prev = n; }
  return {
    current: cur, best, goal: STREAK_GOAL, goalReached: cur >= STREAK_GOAL, doneToday: done.has(tn), totalSolved: done.size,
    last5: Array.from({ length: STREAK_GOAL }, (_, i) => { const n = tn - (STREAK_GOAL - 1 - i); return { date: dayString(n), done: done.has(n), today: n === tn }; }),
  };
}

/** Today's puzzle for this player (created on first ask), with their streak. */
export async function dailyFor(userId: number) {
  const t = await today();
  const p = POOL[dayNumber(t) % POOL.length];
  await query(
    `INSERT INTO improve_puzzles (user_id, source, default_key, daily_date, title, fen, best_uci, themes, phase, idea)
     VALUES ($1,'daily',$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
    [userId, p.key, t, `Daily puzzle: ${p.title}`, p.fen, p.best, p.themes, p.phase, p.idea]
  );
  const [row] = await query<any>(`SELECT id, title, status, hints_used, fen FROM improve_puzzles WHERE user_id=$1 AND source='daily' AND daily_date=$2`, [userId, t]);
  return {
    date: t,
    puzzle: { id: row.id, title: row.title, status: row.status, hintsUsed: row.hints_used, turn: row.fen.split(" ")[1] },
    streak: await streakOf(userId, t),
  };
}

// ---- dashboard -----------------------------------------------------------------------------------------

/** Lichess-style accuracy from the average win-chance lost per move. */
const accuracyOf = (avgDrop: number) => Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * avgDrop) - 3.1669));

function moveDrops(color: "white" | "black", moves: Mv[], analyses: An[]) {
  const at = new Map(analyses.map((a) => [a.ply, a]));
  const me = color === "white" ? 1 : -1;
  const drops: number[] = [];
  for (const m of moves) {
    if ((m.ply % 2 === 1) !== (color === "white")) continue;
    const b = at.get(m.ply - 1), a = at.get(m.ply);
    if (!b || !a) continue;
    drops.push(Math.max(0, winPct(me * b.eval_cp) - winPct(me * a.eval_cp)));
  }
  return drops;
}

export async function dashboard(user: User) {
  const [me] = await query<{ rating: number; rated_games: number }>(`SELECT rating, rated_games FROM users WHERE id=$1`, [user.id]);
  const finished = await query<any>(
    `SELECT g.id, g.code, g.white_id, g.black_id, g.result, g.vs_bot, g.bot_elo, g.created_at, g.ended_at, g.termination,
            g.time_control_sec, g.white_change, g.black_change,
            (SELECT count(*) FROM moves m WHERE m.game_id = g.id)::int AS plies
     FROM games g
     WHERE (g.white_id = $1 OR g.black_id = $1) AND g.status = 'finished' AND g.player_id IS NULL
     ORDER BY g.ended_at DESC NULLS LAST, g.id DESC LIMIT 50`,
    [user.id]
  );
  const rec = { games: finished.length, wins: 0, losses: 0, draws: 0, white: { g: 0, w: 0 }, black: { g: 0, w: 0 }, vsBot: { g: 0, w: 0 }, vsHuman: { g: 0, w: 0 }, timeouts: 0, resignations: 0 };
  for (const g of finished) {
    const color = colorOf(g, user.id);
    const won = g.result === (color === "white" ? "1-0" : "0-1");
    const draw = g.result === "1/2-1/2";
    if (won) rec.wins++; else if (draw) rec.draws++; else if (g.result) rec.losses++;
    rec[color].g++; if (won) rec[color].w++;
    const k = g.vs_bot ? "vsBot" : "vsHuman"; rec[k].g++; if (won) rec[k].w++;
    if (!won && !draw && g.termination === "timeout") rec.timeouts++;
    if (!won && !draw && g.termination === "resignation") rec.resignations++;
  }

  // rating history: walk back from today's rating, undoing each game's change
  const rated = finished.filter((g) => (g.white_id === user.id ? g.white_change : g.black_change) !== null);
  let r = me.rating;
  const history: { at: string; rating: number }[] = [];
  for (const g of rated) {
    history.unshift({ at: g.ended_at ?? g.created_at, rating: r });
    r -= g.white_id === user.id ? g.white_change : g.black_change;
  }
  if (rated.length) history.unshift({ at: rated[rated.length - 1].created_at, rating: r });
  const ratingDelta = history.length > 1 ? history[history.length - 1].rating - history[0].rating : 0;

  // engine-based quality, from up to 15 analysed games
  const perGame: { code: string; accuracy: number; blunders: number; mistakes: number; result: string; at: string }[] = [];
  const phaseCount = { opening: 0, middlegame: 0, endgame: 0 };
  const themeCount: Record<string, number> = {};
  let blunders = 0, mistakes = 0, inaccuracies = 0, analysed = 0;
  for (const g of finished) {
    if (analysed >= 15) break;
    const { moves, analyses, complete } = await loadGame(g.id);
    if (!complete || moves.length < MIN_PLIES) continue;
    const color = colorOf(g, user.id);
    const tagged = tagGame(color, moves, analyses);
    const drops = moveDrops(color, moves, analyses);
    if (!drops.length) continue;
    analysed++;
    const b = tagged.filter((t) => t.severity === "blunder").length, m = tagged.filter((t) => t.severity === "mistake").length;
    blunders += b; mistakes += m; inaccuracies += tagged.filter((t) => t.severity === "inaccuracy").length;
    for (const t of tagged) {
      if (t.severity === "inaccuracy") continue;
      phaseCount[t.phase]++;
      for (const th of t.themes) themeCount[th] = (themeCount[th] ?? 0) + 1;
    }
    const won = g.result === (color === "white" ? "1-0" : "0-1");
    perGame.push({ code: g.code, accuracy: Math.round(accuracyOf(drops.reduce((a, d) => a + d, 0) / drops.length)), blunders: b, mistakes: m, result: won ? "win" : g.result === "1/2-1/2" ? "draw" : "loss", at: g.ended_at ?? g.created_at });
  }
  const accuracy = perGame.length ? Math.round(perGame.reduce((a, g) => a + g.accuracy, 0) / perGame.length) : null;
  const themes = Object.entries(themeCount).filter(([t]) => t !== "other").sort((a, b) => b[1] - a[1]).map(([key, n]) => ({ key, label: THEME_LABEL[key] ?? key, count: n }));
  const weakestPhase = (Object.entries(phaseCount).sort((a, b) => b[1] - a[1])[0] as [string, number] | undefined);

  const [pz] = await query<any>(
    `SELECT count(*)::int total,
            count(*) FILTER (WHERE status='solved')::int solved,
            count(*) FILTER (WHERE status='solved' AND hints_used=0)::int solved_clean,
            count(*) FILTER (WHERE status='revealed')::int revealed,
            coalesce(sum(hints_used),0)::int hints
     FROM improve_puzzles WHERE user_id=$1`, [user.id]);
  const [coachRow] = await query<any>(
    `SELECT count(*)::int profiles,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM subscriptions s WHERE s.player_id = p.id AND s.status='active' AND s.expires_at > now()))::int pro
     FROM players p WHERE p.owner_id=$1`, [user.id]).catch(() => [{ profiles: 0, pro: 0 }]);

  // ---- insights + recommendation (plain rules over the numbers above, nothing invented)
  const insights: { tone: "good" | "warn" | "tip"; text: string }[] = [];
  const winRate = rec.games ? Math.round((rec.wins / rec.games) * 100) : null;
  if (!rec.games) insights.push({ tone: "tip", text: "Play your first game to start building your dashboard. Finished games are analysed by Stockfish within a minute or two." });
  else if (!analysed) insights.push({ tone: "tip", text: "Your games are still being analysed. Check back in a minute for accuracy and mistake insights." });
  if (accuracy !== null) insights.push({ tone: accuracy >= 80 ? "good" : accuracy >= 65 ? "tip" : "warn", text: `Your average accuracy over the last ${analysed} analysed game${analysed > 1 ? "s" : ""} is ${accuracy}%.` });
  if (analysed) {
    const per = (blunders / analysed).toFixed(1);
    insights.push({ tone: blunders / analysed >= 2 ? "warn" : blunders / analysed < 1 ? "good" : "tip", text: `You make ${per} blunder${per === "1.0" ? "" : "s"} per game on average. Most games at your level are decided by the first big blunder.` });
  }
  if (weakestPhase && weakestPhase[1] >= 2) insights.push({ tone: "warn", text: `Most of your costly mistakes happen in the ${weakestPhase[0]} (${weakestPhase[1]} of ${blunders + mistakes}).` });
  if (themes[0] && themes[0].count >= 2) insights.push({ tone: "warn", text: `Your most repeated problem is "${themes[0].label}" (${themes[0].count} times). Fixing one habit beats studying everything.` });
  if (rec.timeouts >= 2) insights.push({ tone: "warn", text: `${rec.timeouts} of your losses were on time. Try a slower time control, or move faster in the opening.` });
  if (rec.white.g >= 3 && rec.black.g >= 3) {
    const w = Math.round((rec.white.w / rec.white.g) * 100), b = Math.round((rec.black.w / rec.black.g) * 100);
    if (Math.abs(w - b) >= 25) insights.push({ tone: "tip", text: `You win ${w}% with White but ${b}% with Black. Your ${w > b ? "Black" : "White"} openings need attention.` });
  }
  if (history.length > 2) insights.push({ tone: ratingDelta >= 0 ? "good" : "warn", text: `Your rating moved ${ratingDelta >= 0 ? "+" : ""}${ratingDelta} over your last ${rated.length} rated game${rated.length > 1 ? "s" : ""}.` });
  if (pz.total > 0 && pz.solved + pz.revealed >= 3) insights.push({ tone: pz.solved_clean / Math.max(1, pz.solved + pz.revealed) >= 0.5 ? "good" : "tip", text: `You solved ${pz.solved} of ${pz.solved + pz.revealed} puzzles you attempted, ${pz.solved_clean} of them without a hint.` });

  const reasons: string[] = [];
  let score = 0;
  if (analysed && blunders / analysed >= 2) { score += 2; reasons.push(`${(blunders / analysed).toFixed(1)} blunders per game`); }
  else if (analysed && blunders / analysed >= 1) { score += 1; reasons.push(`${(blunders / analysed).toFixed(1)} blunders per game`); }
  if (accuracy !== null && accuracy < 60) { score += 2; reasons.push(`accuracy of only ${accuracy}%`); }
  else if (accuracy !== null && accuracy < 75) { score += 1; reasons.push(`accuracy of ${accuracy}%`); }
  if (themes[0] && themes[0].count >= 3) { score += 2; reasons.push(`"${themes[0].label}" keeps repeating (${themes[0].count} times)`); }
  if (pz.solved + pz.revealed >= 3 && pz.solved_clean / (pz.solved + pz.revealed) < 0.4) { score += 1; reasons.push("puzzles are still hard without hints"); }
  if (rec.games >= 5 && (rec.wins / rec.games) < 0.35) { score += 1; reasons.push(`a ${winRate}% win rate`); }
  if (rated.length >= 5 && ratingDelta < -30) { score += 1; reasons.push(`your rating fell ${-ratingDelta} points recently`); }
  const streak = await streakOf(user.id);
  if (streak.current >= 2) insights.push({ tone: "good", text: `🔥 You are on a ${streak.current}-day puzzle streak${streak.current >= STREAK_GOAL ? ". The 5-day goal is done, keep it going" : `. ${STREAK_GOAL - streak.current} more day${STREAK_GOAL - streak.current === 1 ? "" : "s"} to the ${STREAK_GOAL}-day badge`}.` });
  else if (!streak.doneToday && pz.total > 0) insights.push({ tone: "tip", text: "Solve today's daily puzzle to start a streak." });
  const level = !analysed ? "none" : score >= 4 ? "strong" : score >= 2 ? "suggested" : "none";
  const recommendation = {
    level,
    headline: level === "strong" ? "The AI Coach would help you most right now" : level === "suggested" ? "The AI Coach could speed up your progress" : analysed ? "You're doing fine on your own. The Coach is there when you want a plan" : "Play a few games to unlock personal advice",
    reasons,
    pitch: "The coach reads your own games, finds the habit that costs you the most, and builds a 7-day plan with short exercises and hints. Days 1 and 2 are free.",
    hasCoach: coachRow.profiles > 0, isPro: coachRow.pro > 0,
  };

  return {
    rating: me.rating, ratedGames: me.rated_games, record: { ...rec, winRate }, ratingHistory: history, ratingDelta,
    quality: { analysed, accuracy, blunders, mistakes, inaccuracies, perGame: perGame.slice().reverse(), phases: phaseCount, themes },
    puzzles: { total: pz.total, solved: pz.solved, solvedClean: pz.solved_clean, revealed: pz.revealed, hints: pz.hints },
    insights, recommendation, streak: await streakOf(user.id),
  };
}

// ---- routes --------------------------------------------------------------------------------------------

export function registerImproveRoutes(app: Express, authed: (req: Request, res: Response) => User | null) {
  const wrap = (fn: (req: Request, res: Response, u: User) => Promise<unknown>) => (req: Request, res: Response) => {
    const u = authed(req, res);
    if (!u) return;
    fn(req, res, u).catch((e) => {
      if (isDbUnavailable(e)) return void res.status(503).json({ error: "The server could not reach its database. Please try again in a moment." });
      if (e instanceof Error && e.name === "ImproveError") return void res.status(e.message === "Puzzle not found" ? 404 : 400).json({ error: e.message });
      console.error(e);
      res.status(500).json({ error: "Server error" });
    });
  };
  const fail = (msg: string): never => { const e = new Error(msg); e.name = "ImproveError"; throw e; };
  const mine = async (req: Request, u: User) => {
    const [p] = await query<any>(`SELECT * FROM improve_puzzles WHERE id=$1 AND user_id=$2`, [Number(req.params.id), u.id]); // someone else's puzzle looks like a missing one
    return p ?? fail("Puzzle not found");
  };
  const asRow = (p: any) => ({ id: p.id, game_id: p.game_id ?? 0, ply: p.ply ?? 0, themes: p.themes, phase: p.phase, fen_before: p.fen, best_uci: p.best_uci, best_san: p.best_san ?? "", played_san: p.played_san ?? "" });

  app.get("/api/improve/puzzles", wrap(async (_req, res, u) => res.json(await puzzleSet(u.id))));
  app.get("/api/improve/daily", wrap(async (_req, res, u) => res.json(await dailyFor(u.id))));
  app.get("/api/improve/dashboard", wrap(async (_req, res, u) => res.json(await dashboard(u))));

  app.get("/api/improve/puzzles/:id", wrap(async (req, res, u) => {
    const p = await mine(req, u);
    const [g] = p.game_id ? await query<any>(`SELECT code, created_at FROM games WHERE id=$1`, [p.game_id]) : [null];
    res.json({
      id: p.id, source: p.source, title: p.title, fen: p.fen, turn: p.fen.split(" ")[1], themes: p.themes, phase: p.phase,
      status: p.status, hintsUsed: p.hints_used, attempts: p.attempts,
      daily: p.source === "daily",
      context: p.source === "daily" ? "Today's puzzle, the same for everyone. Solve it to keep your streak going. Hints are free to use." : p.source === "game" ? `This position is from your game (move ${Math.ceil(p.ply / 2)}). In the game you played ${p.played_san} and it cost you ${Math.round(p.win_drop)}% of your winning chances. Find the better move.` : "Find the best move.",
      gameCode: g?.code ?? null,
    });
  }));

  // Hints unlock one at a time, exactly as in the coach.
  app.post("/api/improve/puzzles/:id/hint", wrap(async (req, res, u) => {
    const p = await mine(req, u);
    const n = Number(req.body?.n);
    if (![1, 2, 3].includes(n) || n > p.hints_used + 1) return fail("Hints unlock one at a time");
    const h = hintFor(asRow(p), n);
    if (!h) return fail("No hint available for this position");
    if (p.status === "new") await query(`UPDATE improve_puzzles SET hints_used=GREATEST(hints_used,$2) WHERE id=$1`, [p.id, n]);
    res.json(h);
  }));

  const verdictOf = async (p: any, pass: boolean) => {
    const extras = await verdictExtras(asRow(p));
    const lost = p.source === "game" && p.win_drop ? ` In the game you played ${p.played_san}, which cost ${Math.round(p.win_drop)}% of your winning chances.` : "";
    return {
      pass, bestSan: p.best_san ?? extras.best?.san, pv: p.pv, youPlayedInGame: p.played_san, hintsUsed: p.hints_used, fen: p.fen, ...extras,
      explanation: (p.idea ?? "") + lost,
      plainWhy: p.idea ?? extras.plainWhy,
    };
  };

  app.post("/api/improve/puzzles/:id/answer", wrap(async (req, res, u) => {
    const p = await mine(req, u);
    const uci = String(req.body?.uci ?? "");
    if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) return fail("That is not a move");
    const correct = uci === p.best_uci || p.alt_ucis.includes(uci);
    if (p.status !== "new") return res.json({ correct, already: true, verdict: await verdictOf(p, p.status === "solved") });
    await query(`UPDATE improve_puzzles SET attempts = attempts + 1 WHERE id=$1`, [p.id]);
    if (!correct) return void res.json({ correct: false, attempts: p.attempts + 1 });
    await query(`UPDATE improve_puzzles SET status='solved', solved_at=now() WHERE id=$1 AND status='new'`, [p.id]);
    res.json({ correct: true, alternative: uci !== p.best_uci, verdict: await verdictOf(p, true), streak: p.source === "daily" ? await streakOf(u.id) : undefined });
  }));

  // "Show me": counts as not solved, but teaches the answer.
  app.post("/api/improve/puzzles/:id/reveal", wrap(async (req, res, u) => {
    const p = await mine(req, u);
    if (p.status === "new") await query(`UPDATE improve_puzzles SET status='revealed' WHERE id=$1 AND status='new'`, [p.id]);
    res.json({ verdict: await verdictOf(p, p.status === "solved") });
  }));
}
