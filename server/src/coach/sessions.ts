import { query } from "../db.js";
import { getPriceInr } from "../billing/service.js";
import { buildReport } from "../report.js";
import { loadMistake, verdictExtras } from "./hints.js";
import { lessonFor, plainLessonFor } from "./lessons.js";
import { THEME_LABEL, THEMES } from "./tagger.js";

export const FREE_DAYS = 2;
export const PRICE_INR = 299;
const MAX_BLUNDERS = 2;
const SET_SIZE = 5;

const locks = new Map<number, Promise<unknown>>();
/**
 * Runs fn after any earlier call for the same session has finished. A double-click, a retry or two tabs must not
 * start two question sets, count one answer twice, or evaluate one milestone twice. (One web instance by design.)
 */
export function withSessionLock<T>(sessionId: number, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(sessionId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.catch(() => undefined);
  locks.set(sessionId, tail);
  void tail.then(() => { if (locks.get(sessionId) === tail) locks.delete(sessionId); });
  return next;
}

export type State = "locked" | "paywall" | "available" | "active" | "retry" | "done";

export async function isPro(playerId: number) {
  const [s] = await query(`SELECT 1 FROM subscriptions WHERE player_id=$1 AND status='active' AND expires_at > now() LIMIT 1`, [playerId]);
  return !!s;
}

export const accessFor = async (playerId: number) => ({ pro: await isPro(playerId), freeDays: FREE_DAYS, priceInr: await getPriceInr() });

/** Turns the plan's seven items into executable sessions, each with a measurable outcome. */
export async function buildSessions(playerId: number, planId: number, items: any[], focus: string[]) {
  const main = focus[0] ?? "other";
  for (let i = 0; i < 7; i++) {
    const it = items[i] ?? {};
    const type = it.type === "play" ? "play" : it.type === "review" ? "review" : "drill";
    const theme = THEMES.includes(it.theme) ? it.theme : focus.length ? focus[i % focus.length] : main;
    const label = (THEME_LABEL[theme] ?? theme).toLowerCase();
    const goal =
      type === "play" ? `Finish a practice game with at most ${MAX_BLUNDERS} blunders`
      : type === "review" ? `Re-solve at least 3 of ${SET_SIZE} of your toughest positions`
      : `Solve at least 3 of ${SET_SIZE} positions from your own ${label} mistakes`;
    await query(
      `INSERT INTO plan_sessions (player_id, plan_id, day, type, theme, title, detail, minutes, goal) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (plan_id, day) DO NOTHING`,
      [playerId, planId, i + 1, type, theme, String(it.title || `Day ${i + 1}`).slice(0, 120), String(it.detail || "").slice(0, 500), Math.min(30, Number(it.minutes) || 10), goal]
    );
  }
}

const derive = (rows: any[], pro: boolean) => {
  let prevDone = true;
  return rows.map((s) => {
    let state: State;
    if (s.status === "done") state = "done";
    else if (!prevDone) state = "locked";
    else if (s.day > FREE_DAYS && !pro) state = "paywall";
    else state = s.status === "active" ? "active" : s.status === "retry" ? "retry" : "available";
    prevDone = s.status === "done";
    return { ...s, state };
  });
};

export async function latestPlanId(playerId: number) {
  const [p] = await query<{ id: number }>(`SELECT id FROM plans WHERE player_id=$1 ORDER BY version DESC LIMIT 1`, [playerId]);
  return p?.id ?? null;
}

export async function listSessions(playerId: number, hooks?: { weekly: () => Promise<unknown> }) {
  const planId = await latestPlanId(playerId);
  if (!planId) return [];
  let rows = await query<any>(
    `SELECT id, day, type, theme, title, detail, minutes, goal, status, attempts, score, total, passed, game_code, completed_at
     FROM plan_sessions WHERE plan_id=$1 ORDER BY day`, [planId]);
  if (!rows.length) { // plans saved before sessions existed
    const [p] = await query<any>(`SELECT items, focus_themes FROM plans WHERE id=$1`, [planId]);
    await buildSessions(playerId, planId, p.items, p.focus_themes);
    rows = await query<any>(`SELECT id, status, type FROM plan_sessions WHERE plan_id=$1 ORDER BY day`, [planId]);
  }
  for (const r of rows) if (r.type === "play" && r.status === "active") await resolvePlay(r.id, hooks).catch(() => undefined);
  const fresh = await query<any>(
    `SELECT id, day, type, theme, title, detail, minutes, goal, status, attempts, score, total, passed, game_code, completed_at
     FROM plan_sessions WHERE plan_id=$1 ORDER BY day`, [planId]);
  return derive(fresh, await isPro(playerId)).map((s) => ({ ...s, themeLabel: THEME_LABEL[s.theme] ?? s.theme }));
}

async function pickQuestions(s: any): Promise<number[]> {
  const failedHere = (await query<{ mistake_id: number }>(`SELECT DISTINCT mistake_id FROM session_questions WHERE session_id=$1 AND result='fail'`, [s.id])).map((r) => r.mistake_id);
  const usedElsewhere = (await query<{ mistake_id: number }>(
    `SELECT DISTINCT q.mistake_id FROM session_questions q JOIN plan_sessions p ON p.id=q.session_id WHERE p.plan_id=$1 AND p.id<>$2`, [s.plan_id, s.id])).map((r) => r.mistake_id);
  const failedAny = (await query<{ mistake_id: number }>(
    `SELECT DISTINCT q.mistake_id FROM session_questions q JOIN plan_sessions p ON p.id=q.session_id WHERE p.plan_id=$1 AND q.result='fail'`, [s.plan_id])).map((r) => r.mistake_id);
  const run = (theme: string | null, prefer: number[]) => query<{ id: number }>(
    `SELECT m.id FROM mistakes m WHERE m.player_id=$1 AND m.best_uci IS NOT NULL AND m.severity IN ('mistake','blunder')
       AND ($2::text IS NULL OR m.themes && ARRAY[$2]::text[])
     ORDER BY (m.id = ANY($3::int[])) DESC, (m.id = ANY($4::int[])) ASC, m.win_pct_drop DESC LIMIT $5`,
    [s.player_id, theme, prefer, usedElsewhere, SET_SIZE]);
  const prefer = s.type === "review" ? [...failedHere, ...failedAny] : failedHere;
  let rows = await run(s.type === "review" ? null : s.theme, prefer);
  if (rows.length < 2 && s.type !== "review") rows = await run(null, prefer);
  return rows.map((r) => r.id);
}

/** Starts (or resumes) a session. Practice games need a callback that creates a bot game for the user. */
export function startSession(sessionId: number, ctx: { createBotGame: () => Promise<string>; force?: boolean }) {
  return withSessionLock(sessionId, () => startSessionLocked(sessionId, ctx));
}

async function startSessionLocked(sessionId: number, ctx: { createBotGame: () => Promise<string>; force?: boolean }) {
  const [s] = await query<any>(`SELECT * FROM plan_sessions WHERE id=$1`, [sessionId]);
  if (!s) throw new Error("Session not found");
  if (s.type === "play") {
    if (s.status === "active" && s.game_code && !ctx.force) return { gameCode: s.game_code };
    const code = await ctx.createBotGame();
    await query(`UPDATE plan_sessions SET status='active', game_code=$2, attempts=attempts+1, started_at=COALESCE(started_at, now()) WHERE id=$1`, [s.id, code]);
    return { gameCode: code };
  }
  const open = await query(`SELECT 1 FROM session_questions WHERE session_id=$1 AND attempt=$2 AND result IS NULL`, [s.id, s.attempts]);
  if (s.status === "active" && open.length) return {}; // resume the current attempt
  const ids = await pickQuestions(s);
  if (!ids.length) throw new Error("Not enough positions from your games yet. Play or import more games and the coach will build this set.");
  const attempt = s.attempts + 1;
  for (const id of ids) await query(`INSERT INTO session_questions (session_id, attempt, mistake_id) VALUES ($1,$2,$3)`, [s.id, attempt, id]);
  const need = Math.max(1, Math.ceil(ids.length * 0.6));
  const goal = s.type === "review" ? `Re-solve at least ${need} of ${ids.length} of your toughest positions` : `Solve at least ${need} of ${ids.length} positions from your own ${(THEME_LABEL[s.theme] ?? "").toLowerCase()} mistakes`;
  await query(`UPDATE plan_sessions SET status='active', attempts=$2, total=$3, goal=$4, started_at=COALESCE(started_at, now()) WHERE id=$1`, [s.id, attempt, ids.length, goal]);
  return {};
}

export async function sessionView(sessionId: number, playerId: number, hooks?: { weekly: () => Promise<unknown> }) {
  const all = await listSessions(playerId, hooks);
  const s = all.find((x) => x.id === sessionId);
  if (!s) return null;
  const qs = await query<any>(
    `SELECT q.id, q.result, m.fen_before fen, m.themes FROM session_questions q JOIN mistakes m ON m.id=q.mistake_id
     WHERE q.session_id=$1 AND q.attempt=$2 ORDER BY q.id`, [sessionId, s.attempts]);
  const next = qs.find((q) => q.result === null);
  const nextSession = all.find((x) => x.day === s.day + 1) ?? null;
  const lesson = lessonFor(s.theme);
  return {
    session: s, lesson, lessonPlain: plainLessonFor(s.theme),
    progress: { total: qs.length, answered: qs.filter((q) => q.result).length, results: qs.map((q) => q.result) },
    question: next && s.state !== "done" ? { id: next.id, fen: next.fen, turn: next.fen.split(" ")[1], themes: next.themes } : null,
    nextSessionId: nextSession?.id ?? null, nextDay: nextSession?.day ?? null,
    isLast: !nextSession,
  };
}

/** Records one answer. Returns the verdict and, when the set is finished, the session outcome. */
export async function answerQuestion(questionId: number, uci: string, hooks: { weekly: () => Promise<unknown> }) {
  const [pre] = await query<{ session_id: number }>(`SELECT session_id FROM session_questions WHERE id=$1`, [questionId]);
  if (!pre) throw new Error("Question not found");
  return withSessionLock(pre.session_id, () => answerLocked(questionId, uci, hooks));
}

async function answerLocked(questionId: number, uci: string, hooks: { weekly: () => Promise<unknown> }) {
  const [q] = await query<any>(
    `SELECT q.*, m.best_uci, m.best_san, m.pv, m.played_san, m.explanation, m.player_id FROM session_questions q JOIN mistakes m ON m.id=q.mistake_id WHERE q.id=$1`, [questionId]);
  if (!q) throw new Error("Question not found");
  if (q.result) throw new Error("Question already answered");
  const pass = uci === q.best_uci;
  // Atomic as well as locked: only the call that flips result from NULL gets to count the answer.
  const claimed = await query(`UPDATE session_questions SET result=$2, answered_at=now() WHERE id=$1 AND result IS NULL RETURNING id`, [q.id, pass ? "pass" : "fail"]);
  if (!claimed.length) throw new Error("Question already answered");
  await query(
    `INSERT INTO drills (player_id, mistake_id, attempts, passes, last_result, interval_days, due_at)
     VALUES ($1,$2,1,$3,$4,1, CASE WHEN $3::int=1 THEN now() + interval '1 day' ELSE now() END)
     ON CONFLICT (player_id, mistake_id) DO UPDATE SET attempts=drills.attempts+1, passes=drills.passes+$3::int, last_result=$4::text,
       due_at = CASE WHEN $3::int=1 THEN now() + interval '1 day' ELSE now() END`,
    [q.player_id, q.mistake_id, pass ? 1 : 0, pass ? "pass" : "fail"]);
  const left = await query(`SELECT 1 FROM session_questions WHERE session_id=$1 AND attempt=$2 AND result IS NULL`, [q.session_id, q.attempt]);
  const mistake = await loadMistake(q.mistake_id);
  const verdict = { pass, bestSan: q.best_san, bestUci: q.best_uci, pv: q.pv, youPlayedInGame: q.played_san, explanation: q.explanation, hintsUsed: q.hints_used, fen: mistake?.fen_before, ...(mistake ? await verdictExtras(mistake) : {}) };
  if (left.length) return { verdict, finished: false as const };
  const rows = await query<{ result: string }>(`SELECT result FROM session_questions WHERE session_id=$1 AND attempt=$2`, [q.session_id, q.attempt]);
  const outcome = await finishSession(q.session_id, rows.filter((r) => r.result === "pass").length, rows.length, hooks);
  return { verdict, finished: true as const, outcome };
}

/** Completes an attempt, then lets the agent adapt the plan and logs what it did. */
async function finishSession(sessionId: number, score: number, total: number, hooks: { weekly: () => Promise<unknown> }, kind: "set" | "game" = "set") {
  const [s] = await query<any>(`SELECT * FROM plan_sessions WHERE id=$1`, [sessionId]);
  const need = kind === "game" ? MAX_BLUNDERS : Math.max(1, Math.ceil(total * 0.6));
  const passed = kind === "game" ? score <= MAX_BLUNDERS : score >= need;
  const status = passed || s.attempts >= 2 ? "done" : "retry";
  await query(`UPDATE plan_sessions SET status=$2, score=$3, total=$4, passed=$5, completed_at=now() WHERE id=$1`, [s.id, status, score, total, passed]);
  const [last] = await query<{ d: number }>(`SELECT MAX(day) d FROM plan_sessions WHERE plan_id=$1`, [s.plan_id]);
  const isLast = s.day === last.d;
  const result = kind === "game" ? `${score} blunder(s) (target at most ${MAX_BLUNDERS})` : `${score}/${total} (target ${need})`;
  let decision: string;
  if (!passed && status === "retry") decision = "Day stays open. The retry set puts the positions you missed first, so the weakness is practised until it sticks.";
  else if (!passed) {
    await query(`UPDATE drills SET due_at=now() WHERE player_id=$1 AND last_result='fail'`, [s.player_id]);
    decision = `Second attempt missed the target. Moving on with support: the positions you missed are queued first in your Train tab.${isLast ? "" : ` Day ${s.day + 1} is unlocked.`}`;
  } else if (kind === "set" && score === total) decision = `Perfect score. ${isLast ? "" : `Day ${s.day + 1} is unlocked.`} This theme is logged as improving for the weekly review.`;
  else decision = isLast ? "Milestone reached." : `Milestone reached. Day ${s.day + 1} is unlocked.`;
  if (status === "done" && isLast) decision += " Week complete: starting the weekly review to build your next plan.";

  const [run] = await query<{ id: number }>(`INSERT INTO agent_runs (player_id, trigger, status, mode, ended_at) VALUES ($1,'session','done','rules', now()) RETURNING id`, [s.player_id]);
  const steps: [string, string, string | null][] = [
    ["evaluate_session", `Day ${s.day} "${s.title}": ${result} -> milestone ${passed ? "reached" : "not reached"}`, null],
    ["adapt_plan", decision.split(". ")[0] + ".", decision],
  ];
  for (const [i, [tool, summary, note]] of steps.entries())
    await query(`INSERT INTO agent_steps (run_id, n, tool, input, output_summary, note) VALUES ($1,$2,$3,$4,$5,$6)`, [run.id, i + 1, tool, JSON.stringify({ session: s.id }), summary, note]);
  if (status === "done" && isLast) hooks.weekly().catch((e) => console.error("weekly run failed", e));
  return { passed, status, score, total, need, result, decision, attempts: s.attempts, day: s.day, runId: run.id };
}

/** Practice games are judged by Stockfish's post-game report once the game is over. */
export function resolvePlay(sessionId: number, hooks?: { weekly: () => Promise<unknown> }) {
  return withSessionLock(sessionId, () => resolvePlayLocked(sessionId, hooks));
}

async function resolvePlayLocked(sessionId: number, hooks?: { weekly: () => Promise<unknown> }) {
  const [s] = await query<any>(`SELECT * FROM plan_sessions WHERE id=$1`, [sessionId]);
  if (!s || s.type !== "play" || s.status !== "active" || !s.game_code) return null;
  const [g] = await query<any>(`SELECT id, status, white_id, created_by FROM games WHERE code=$1`, [s.game_code]);
  if (!g || g.status !== "finished") return { waiting: "game" as const };
  const rep = await buildReport(g.id);
  if (!rep.ready) return { waiting: "analysis" as const, progress: rep.progress };
  const mine = g.white_id === g.created_by ? rep.white : rep.black;
  return { outcome: await finishSession(s.id, mine.blunders, 0, hooks ?? { weekly: async () => undefined }, "game") };
}

export async function activateSubscription(playerId: number, provider: string, reference: string) {
  await query(`INSERT INTO subscriptions (player_id, status, provider, reference, amount_inr, expires_at) VALUES ($1,'active',$2,$3,$4, now() + interval '30 days')`, [playerId, provider, reference, PRICE_INR]);
}
