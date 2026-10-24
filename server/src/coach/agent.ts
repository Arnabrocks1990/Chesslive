import type { Redis } from "ioredis";
import { askClaude } from "../claude.js";
import { config } from "../config.js";
import { query } from "../db.js";
import { queueAnalysis, waitForAnalysis } from "./analysis.js";
import { fetchChessCom, fetchLichess, storeGame } from "./importer.js";
import { buildSessions } from "./sessions.js";
import { THEME_LABEL, tagStoredGame } from "./tagger.js";

// Stockfish and rules own every chess fact. The LLM only decides, prioritises, explains and writes,
// and it is given engine output to ground each statement.

const FREE_DAYS_NOTE = 2;
const RECENT = 5;      // games per comparison window
const MAX_GAMES = Number(process.env.COACH_MAX_GAMES || 10);
const running = new Set<number>();
export const isRunning = (playerId: number) => running.has(playerId);

// ---- step trace ---------------------------------------------------------------

class Trace {
  n = 0;
  constructor(public runId: number) {}
  async begin(tool: string, input: unknown = {}) {
    const [r] = await query<{ id: number }>(
      `INSERT INTO agent_steps (run_id, n, tool, input, output_summary) VALUES ($1,$2,$3,$4,'running...') RETURNING id`,
      [this.runId, ++this.n, tool, JSON.stringify(input)]
    );
    return r.id;
  }
  async progress(id: number, text: string) {
    await query(`UPDATE agent_steps SET output_summary=$2 WHERE id=$1`, [id, text]);
  }
  async end(id: number, summary: string, note?: string) {
    await query(`UPDATE agent_steps SET output_summary=$2, note=$3, ts=now() WHERE id=$1`, [id, summary, note ?? null]);
  }
  /** Runs one tool call as a visible step. */
  async tool<T>(tool: string, input: unknown, fn: (id: number) => Promise<{ summary: string; note?: string; value: T }>): Promise<T> {
    const id = await this.begin(tool, input);
    try {
      const r = await fn(id);
      await this.end(id, r.summary, r.note);
      return r.value;
    } catch (e: any) {
      await this.end(id, `failed: ${e.message}`);
      throw e;
    }
  }
}

// ---- deterministic tools ----------------------------------------------------------

export interface WeaknessRow { theme: string; label: string; count: number; score: number; per100: number; prevPer100: number | null; trend: "improving" | "worsening" | "flat" | "new" | "unknown" }

async function windowGames(playerId: number) {
  return query<{ id: number; plies: number }>(
    `SELECT g.id, (SELECT COUNT(*) FROM moves m WHERE m.game_id=g.id) AS plies
     FROM games g WHERE g.player_id=$1 AND g.status='finished'
       AND (SELECT COUNT(*) FROM analyses a WHERE a.game_id=g.id) = (SELECT COUNT(*) FROM moves m WHERE m.game_id=g.id) + 1
     ORDER BY COALESCE(g.played_at, g.created_at) DESC, g.id DESC LIMIT 30`,
    [playerId]
  );
}

const playerMoves = (plies: number, color: string) => (color === "white" ? Math.ceil(plies / 2) : Math.floor(plies / 2));

export async function rankWeaknesses(playerId: number): Promise<{ games: number; rows: WeaknessRow[]; total: { mistakes: number; blunders: number } }> {
  const games = await windowGames(playerId);
  if (!games.length) return { games: 0, rows: [], total: { mistakes: 0, blunders: 0 } };
  const ids = games.map((g) => g.id);
  const colors = new Map((await query<{ id: number; player_color: string }>(`SELECT id, player_color FROM games WHERE id = ANY($1)`, [ids])).map((r) => [r.id, r.player_color]));
  const ms = await query<{ game_id: number; severity: string; themes: string[]; win_pct_drop: number }>(
    `SELECT game_id, severity, themes, win_pct_drop FROM mistakes WHERE game_id = ANY($1)`, [ids]);
  const idx = new Map(ids.map((id, i) => [id, i]));
  const movesIn = (list: number[]) => games.filter((g) => list.includes(g.id)).reduce((s, g) => s + playerMoves(Number(g.plies), colors.get(g.id)!), 0);
  const recent = ids.slice(0, RECENT), prev = ids.slice(RECENT, RECENT * 2);
  const agg = new Map<string, { count: number; score: number; recent: number; prev: number }>();
  for (const m of ms) {
    if (m.severity === "inaccuracy") continue;
    const w = Math.pow(0.9, idx.get(m.game_id)!);
    const themes = m.themes.length > 1 ? m.themes.filter((t) => t !== "other") : m.themes;
    for (const t of themes) {
      const a = agg.get(t) ?? { count: 0, score: 0, recent: 0, prev: 0 };
      a.count++; a.score += w * (m.win_pct_drop / 10);
      if (recent.includes(m.game_id)) a.recent++; else if (prev.includes(m.game_id)) a.prev++;
      agg.set(t, a);
    }
  }
  const rm = Math.max(1, movesIn(recent)), pm = movesIn(prev);
  const havePrev = prev.length >= 3 && pm > 0;
  const rows = [...agg.entries()].map(([theme, a]): WeaknessRow => {
    const per100 = (a.recent / rm) * 100, prevPer100 = havePrev ? (a.prev / pm) * 100 : null;
    const trend = prevPer100 === null ? "unknown" : prevPer100 === 0 ? (per100 > 0 ? "new" : "flat") : per100 < prevPer100 * 0.8 ? "improving" : per100 > prevPer100 * 1.2 ? "worsening" : "flat";
    return { theme, label: THEME_LABEL[theme] ?? theme, count: a.count, score: Math.round(a.score * 10) / 10, per100: Math.round(per100 * 10) / 10, prevPer100: prevPer100 === null ? null : Math.round(prevPer100 * 10) / 10, trend };
  }).sort((a, b) => b.score - a.score);
  return { games: games.length, rows, total: { mistakes: ms.filter((m) => m.severity !== "inaccuracy").length, blunders: ms.filter((m) => m.severity === "blunder").length } };
}

export async function evaluateProgress(playerId: number) {
  const games = await windowGames(playerId);
  const ids = games.map((g) => g.id);
  if (ids.length < 2) return { enough: false as const, games: ids.length };
  const colors = new Map((await query<{ id: number; player_color: string }>(`SELECT id, player_color FROM games WHERE id = ANY($1)`, [ids])).map((r) => [r.id, r.player_color]));
  const ms = await query<{ game_id: number; severity: string; win_pct_drop: number }>(`SELECT game_id, severity, win_pct_drop FROM mistakes WHERE game_id = ANY($1)`, [ids]);
  const stats = (list: number[]) => {
    const moves = Math.max(1, games.filter((g) => list.includes(g.id)).reduce((s, g) => s + playerMoves(Number(g.plies), colors.get(g.id)!), 0));
    const mine = ms.filter((m) => list.includes(m.game_id));
    return {
      games: list.length, moves,
      blundersPer100: Math.round((mine.filter((m) => m.severity === "blunder").length / moves) * 1000) / 10,
      mistakesPer100: Math.round((mine.filter((m) => m.severity === "mistake").length / moves) * 1000) / 10,
      avgLossPerMove: Math.round((mine.reduce((s, m) => s + m.win_pct_drop, 0) / moves) * 100) / 100,
    };
  };
  const recent = stats(ids.slice(0, RECENT)), prev = ids.length > RECENT ? stats(ids.slice(RECENT, RECENT * 2)) : null;
  return { enough: true as const, recent, prev: prev && prev.games >= 2 ? prev : null };
}

async function generateDrills(playerId: number, themes: string[], n: number) {
  const pool = await query<{ id: number }>(
    `SELECT m.id FROM mistakes m
     WHERE m.player_id=$1 AND m.severity IN ('mistake','blunder') AND m.best_uci IS NOT NULL AND m.themes && $2::text[]
       AND NOT EXISTS (SELECT 1 FROM drills d WHERE d.mistake_id=m.id)
     ORDER BY m.win_pct_drop DESC LIMIT $3`, [playerId, themes, n]);
  for (const r of pool) await query(`INSERT INTO drills (player_id, mistake_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [playerId, r.id]);
  const [open] = await query<{ n: string; attempted: string }>(
    `SELECT COUNT(*) n, COUNT(*) FILTER (WHERE attempts>0) attempted FROM drills WHERE player_id=$1`, [playerId]);
  return { added: pool.length, total: Number(open.n), attempted: Number(open.attempted) };
}

async function fetchNewGames(redis: Redis, player: any, max: number) {
  if (player.platform === "pgn") return [] as number[];
  const since: Date | null = player.last_checked_at ?? null;
  const fetched = player.platform === "lichess" ? await fetchLichess(player.username, max, since) : await fetchChessCom(player.username, max, since);
  const ids: number[] = [];
  for (const g of fetched.slice(0, max)) {
    const id = await storeGame(player.id, player.platform, g);
    if (id) ids.push(id);
  }
  await query(`UPDATE players SET last_checked_at=now() WHERE id=$1`, [player.id]);
  return ids;
}

// ---- LLM steps (with rules fallback so the demo never depends on one CLI call) --------

const parseJson = (text: string) => {
  const s = text.indexOf("{"), e = text.lastIndexOf("}");
  return JSON.parse(text.slice(s, e + 1));
};
const withTimeout = <T,>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error("LLM timed out")), ms))]);
const ask = (prompt: string) => (config.explain ? withTimeout(askClaude(prompt), 75_000) : Promise.reject(new Error("LLM disabled (EXPLAIN=0)")));

type Action = "keep_plan" | "adjust_focus" | "escalate" | "nudge" | "ask_more_games";
interface Decision { action: Action; focus_themes: string[]; rationale: string; nudge: string | null; mode: "llm" | "rules" }

function rulesDecision(ctx: any): Decision {
  const top = ctx.weaknesses.slice(0, 3).map((w: WeaknessRow) => w.theme);
  const improving = ctx.weaknesses.filter((w: WeaknessRow) => w.trend === "improving").map((w: WeaknessRow) => w.theme);
  const base = { mode: "rules" as const, nudge: null };
  if (ctx.games < 3) return { ...base, action: "ask_more_games", focus_themes: top, rationale: `Only ${ctx.games} analysed game(s). Too few to draw reliable conclusions, so I will wait for more games.` };
  const focus = ctx.weaknesses.filter((w: WeaknessRow) => w.trend !== "improving").slice(0, 3).map((w: WeaknessRow) => w.theme);
  const same = ctx.previousFocus.length && focus.every((t: string) => ctx.previousFocus.includes(t));
  if (!ctx.previousFocus.length) return { ...base, action: "adjust_focus", focus_themes: focus, rationale: `First plan. Focusing on the three costliest recurring patterns: ${focus.map((t: string) => THEME_LABEL[t]).join(", ")}.` };
  if (improving.length) return { ...base, action: "escalate", focus_themes: focus, rationale: `${improving.map((t: string) => THEME_LABEL[t]).join(", ")} improved against the previous window, so drill time moves to the next-ranked weakness.` };
  return same
    ? { ...base, action: "keep_plan", focus_themes: focus, rationale: "The same patterns still cost the most, so the focus stays and the drills are refreshed with new positions." }
    : { ...base, action: "adjust_focus", focus_themes: focus, rationale: "New games shifted the ranking, so the plan focus changes to match." };
}

async function decide(ctx: any): Promise<Decision> {
  const prompt = [
    "You are the planning step of an autonomous chess coach. Stockfish and rule tags produced every number below; do not evaluate positions yourself.",
    "Choose ONE action: keep_plan | adjust_focus | escalate | nudge | ask_more_games.",
    "Rules: under 3 analysed games => ask_more_games. A theme with trend 'improving' should lose focus to the next-ranked theme (escalate). Same top themes as the previous plan => keep_plan. Otherwise adjust_focus. Use 'nudge' only if the player has been idle.",
    "focus_themes must be 1-3 keys taken only from the weakness list.",
    `Context JSON: ${JSON.stringify(ctx)}`,
    'Reply with JSON only: {"action": "...", "focus_themes": ["..."], "rationale": "one or two sentences naming the numbers you used", "nudge": "short friendly message or null"}',
  ].join("\n");
  try {
    const d = parseJson(await ask(prompt));
    const valid = ctx.weaknesses.map((w: WeaknessRow) => w.theme);
    const focus = (d.focus_themes || []).filter((t: string) => valid.includes(t)).slice(0, 3);
    if (!["keep_plan", "adjust_focus", "escalate", "nudge", "ask_more_games"].includes(d.action) || !focus.length) throw new Error("invalid decision");
    return { action: d.action, focus_themes: focus, rationale: String(d.rationale || "").slice(0, 400), nudge: d.nudge ? String(d.nudge).slice(0, 300) : null, mode: "llm" };
  } catch (e: any) {
    const r = rulesDecision(ctx);
    r.rationale += ` (rule-based: ${e.message})`;
    return r;
  }
}

function templatePlan(focus: string[], minutes: number) {
  const items = Array.from({ length: 7 }, (_, i) => {
    const day = i + 1;
    if (day === 7) return { day, title: "Weekly review", minutes: 10, type: "review", theme: focus[0], detail: "Replay your two costliest mistakes from this week and say out loud what you missed." };
    if (day % 3 === 0) return { day, title: "Play one slow game", minutes: minutes, type: "play", theme: focus[i % focus.length], detail: `Play one game at 15+10. Before every move, check for ${THEME_LABEL[focus[i % focus.length]].toLowerCase()}.` };
    return { day, title: `Drills: ${THEME_LABEL[focus[i % focus.length]]}`, minutes: Math.min(minutes, 10), type: "drill", theme: focus[i % focus.length], detail: "Solve the drills from your own games in the Train tab." };
  });
  return { items };
}

async function writePlan(player: any, d: Decision, weaknesses: WeaknessRow[], examples: any[]) {
  const focus = d.focus_themes;
  const prompt = [
    "You are a friendly, concrete chess coach. All chess facts come from the engine data below; never evaluate positions from your own knowledge. Never write the word Stockfish: call the engine's preferred move 'the coach move'.",
    `Player goal: ${player.goal || "get stronger"}. Focus themes: ${focus.map((t) => `${t} (${THEME_LABEL[t]})`).join(", ")}.`,
    `Weakness table (from the player's games): ${JSON.stringify(weaknesses.slice(0, 5))}`,
    `Costliest mistakes, with Stockfish's better move: ${JSON.stringify(examples)}`,
    "Write: (1) a plain-language diagnosis, max 90 words, citing the numbers; (2) a 7-day plan, each day max 15 minutes, built mostly from drills on the player's own mistakes, with one slow game and one review day; (3) for each example mistake a max 40-word explanation. STRICT: restate only what the engine data shows (the played move, the coach move, the first moves of 'pv', and the win-chance drop). Do not claim what a piece 'controls', 'coordinates' or 'keeps active' unless a move in the pv literally captures, checks or moves it. If the pv does not make the reason clear, say the coach move is stronger and the reason is not obvious from the line.",
    'JSON only: {"diagnosis": "...", "items": [{"day": 1, "title": "...", "minutes": 10, "type": "drill|play|review", "theme": "<theme key>", "detail": "..."}], "explanations": [{"mistake_id": 0, "text": "..."}]}',
  ].join("\n");
  try {
    const p = parseJson(await ask(prompt));
    if (!Array.isArray(p.items) || p.items.length < 5 || !p.diagnosis) throw new Error("incomplete plan");
    return { diagnosis: String(p.diagnosis).slice(0, 700), items: p.items.slice(0, 7), explanations: Array.isArray(p.explanations) ? p.explanations : [], mode: "llm" as const };
  } catch (e: any) {
    const top = weaknesses[0];
    const diagnosis = top
      ? `Across ${weaknesses.reduce((s, w) => s + w.count, 0)} costly moves, your biggest recurring problem is "${top.label.toLowerCase()}" (${top.count} times, ${top.per100} per 100 moves). Focus: ${focus.map((t) => THEME_LABEL[t]).join(", ")}.`
      : "Not enough costly mistakes yet to find a pattern.";
    const explanations = examples.map((x) => ({ mistake_id: x.id, text: `You played ${x.played}, which lost ${x.drop} win-percentage points. The coach move is ${x.best}${x.pv ? ` (line: ${x.pv})` : ""}.` }));
    return { diagnosis: diagnosis + ` (template: ${e.message})`, ...templatePlan(focus, 12), explanations, mode: "rules" as const };
  }
}

// ---- the agent loop -----------------------------------------------------------

export async function startRun(redis: Redis, playerId: number, trigger: "onboarding" | "new_games" | "weekly" | "manual" | "idle" | "simulated", opts: { extraGameIds?: number[] } = {}) {
  if (running.has(playerId)) {
    const [r] = await query<{ id: number }>(`SELECT id FROM agent_runs WHERE player_id=$1 AND status='running' ORDER BY id DESC LIMIT 1`, [playerId]);
    return r?.id ?? 0;
  }
  const [run] = await query<{ id: number }>(`INSERT INTO agent_runs (player_id, trigger) VALUES ($1,$2) RETURNING id`, [playerId, trigger]);
  running.add(playerId);
  runLoop(redis, playerId, run.id, trigger, opts).catch(async (e) => {
    console.error("agent run failed", e);
    await query(`UPDATE agent_runs SET status='failed', error=$2, ended_at=now() WHERE id=$1`, [run.id, String(e.message).slice(0, 400)]);
  }).finally(() => running.delete(playerId));
  return run.id;
}

async function runLoop(redis: Redis, playerId: number, runId: number, trigger: string, opts: { extraGameIds?: number[] }) {
  const t = new Trace(runId);
  const [player] = await query<any>(`SELECT * FROM players WHERE id=$1`, [playerId]);

  // OBSERVE
  const memory = await t.tool("get_player_memory", { player: player.username }, async () => {
    const [plan] = await query<any>(`SELECT * FROM plans WHERE player_id=$1 ORDER BY version DESC LIMIT 1`, [playerId]);
    const [g] = await query<{ n: string }>(`SELECT COUNT(*) n FROM games WHERE player_id=$1`, [playerId]);
    const [d] = await query<{ n: string; last: string | null }>(`SELECT COALESCE(SUM(attempts),0) n, MAX(due_at)::text last FROM drills WHERE player_id=$1`, [playerId]);
    return { value: { plan, games: Number(g.n), drillAttempts: Number(d.n) }, summary: plan ? `Plan v${plan.version} exists (focus: ${plan.focus_themes.map((x: string) => THEME_LABEL[x] ?? x).join(", ")}); ${g.n} games stored; ${d.n} drill attempts` : `No plan yet; ${g.n} games stored` };
  });

  let newIds: number[] = [...(opts.extraGameIds ?? [])];
  if (trigger !== "idle") {
    if (player.platform !== "pgn" && trigger !== "simulated") {
      const fetched = await t.tool("fetch_games", { platform: player.platform, username: player.username, since: player.last_checked_at, max: MAX_GAMES }, async () => {
        const ids = await fetchNewGames(redis, player, memory.games ? 20 : MAX_GAMES);
        return { value: ids, summary: ids.length ? `Fetched ${ids.length} new finished game(s)` : "No new finished games found" };
      });
      newIds = newIds.concat(fetched);
    }
    // ANALYSE
    let positions = 0;
    for (const id of newIds) {
      const [g] = await query<{ code: string; plies: string }>(`SELECT code, (SELECT COUNT(*) FROM moves WHERE game_id=games.id)::text plies FROM games WHERE id=$1`, [id]);
      await t.tool("analyse_game", { game: g.code, plies: Number(g.plies) }, async (stepId) => {
        await queueAnalysis(redis, id, g.code);
        const ok = await waitForAnalysis(id, 240_000, (p) => void t.progress(stepId, `Stockfish ${p.done}/${p.total} positions`));
        if (!ok) throw new Error("analysis timed out");
        positions += Number(g.plies) + 1;
        return { value: null, summary: `Analysed ${Number(g.plies) + 1} positions` };
      });
      await t.tool("tag_mistakes", { game: g.code }, async () => {
        const tags = await tagStoredGame(id);
        const sev = (s: string) => tags.filter((x) => x.severity === s).length;
        return { value: tags, summary: `${sev("blunder")} blunders, ${sev("mistake")} mistakes, ${sev("inaccuracy")} inaccuracies tagged` };
      });
    }
  }

  // DIAGNOSE
  const rank = await t.tool("rank_weaknesses", {}, async () => {
    const r = await rankWeaknesses(playerId);
    return { value: r, summary: r.rows.length ? `Top patterns: ${r.rows.slice(0, 3).map((w) => `${w.label} (${w.count}x, ${w.trend})`).join("; ")}` : `${r.games} game(s) analysed, no costly patterns yet`, note: r.games < 3 ? "Fewer than 3 analysed games; conclusions are weak." : undefined };
  });
  const progress = await evaluateProgress(playerId);
  const [lastPlan] = await query<any>(`SELECT * FROM plans WHERE player_id=$1 ORDER BY version DESC LIMIT 1`, [playerId]);
  const [drillStat] = await query<{ attempts: string; passes: string; last: string | null }>(`SELECT COALESCE(SUM(attempts),0) attempts, COALESCE(SUM(passes),0) passes, MAX(due_at)::text last FROM drills WHERE player_id=$1`, [playerId]);

  // DECIDE
  // "Other" is not actionable, so it never becomes a coaching focus unless nothing else was found.
  const actionable = rank.rows.filter((w) => w.theme !== "other");
  const focusPool = actionable.length ? actionable : rank.rows;
  const ctx = {
    games: rank.games, newGames: newIds.length, trigger, goal: player.goal, previousFocus: lastPlan?.focus_themes ?? [],
    weaknesses: focusPool.slice(0, 6).map(({ theme, label, count, per100, prevPer100, trend }) => ({ theme, label, count, per100, prevPer100, trend })),
    progress, drills: { attempts: Number(drillStat.attempts), passes: Number(drillStat.passes) },
  };
  if (!rank.rows.length && trigger !== "idle") {
    await t.tool("decide", ctx, async () => ({ value: null, summary: "ask_more_games: no recurring pattern to plan around yet", note: "Import more games or wait for new ones." }));
    await query(`UPDATE agent_runs SET status='done', mode='rules', decision=$2, ended_at=now() WHERE id=$1`, [runId, JSON.stringify({ action: "ask_more_games" })]);
    return;
  }
  const decision = await t.tool("decide", { newGames: ctx.newGames, games: ctx.games, previousFocus: ctx.previousFocus }, async () => {
    const d = await decide(ctx);
    return { value: d, summary: `${d.action} -> focus on ${d.focus_themes.map((x) => THEME_LABEL[x] ?? x).join(", ") || "n/a"}`, note: `[${d.mode}] ${d.rationale}` };
  });
  if (decision.action === "ask_more_games") {
    await query(`UPDATE agent_runs SET status='done', mode=$2, decision=$3, ended_at=now() WHERE id=$1`, [runId, decision.mode, JSON.stringify(decision)]);
    return;
  }

  // ACT
  if (decision.action !== "nudge") {
    await t.tool("generate_drills", { themes: decision.focus_themes, n: 8 }, async () => {
      const r = await generateDrills(playerId, decision.focus_themes, 8);
      return { value: r, summary: `Added ${r.added} drill(s) from your own mistakes (${r.total} total)` };
    });
    const examples = (await query<any>(
      `SELECT m.id, m.played_san played, m.best_san best, m.pv, m.win_pct_drop drop, m.fen_before fen, m.themes
       FROM mistakes m WHERE m.player_id=$1 AND m.severity IN ('mistake','blunder') AND m.themes && $2::text[]
       ORDER BY m.win_pct_drop DESC LIMIT 3`, [playerId, decision.focus_themes])).map((x: any) => ({ ...x, drop: Math.round(x.drop) }));
    const plan = await t.tool("write_plan", { focus: decision.focus_themes, examples: examples.length }, async () => {
      const p = await writePlan(player, decision, focusPool, examples);
      return { value: p, summary: `Wrote a 7-day plan (${p.mode === "llm" ? "AI" : "template"})`, note: p.diagnosis };
    });
    await t.tool("explain_positions", { count: examples.length }, async () => {
      let saved = 0;
      for (const ex of plan.explanations) {
        if (!examples.some((x: any) => x.id === Number(ex.mistake_id)) || !ex.text) continue;
        await query(`UPDATE mistakes SET explanation=$2 WHERE id=$1`, [Number(ex.mistake_id), String(ex.text).slice(0, 400)]);
        saved++;
      }
      return { value: saved, summary: `Saved ${saved} grounded explanation(s)` };
    });
    await t.tool("update_memory", { plan: "new version" }, async () => {
      const version = (lastPlan?.version ?? 0) + 1;
      const [saved] = await query<{ id: number }>(`INSERT INTO plans (player_id, version, focus_themes, diagnosis, items, rationale, nudge) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [playerId, version, JSON.stringify(decision.focus_themes), plan.diagnosis, JSON.stringify(plan.items), decision.rationale, decision.nudge]);
      await buildSessions(playerId, saved.id, plan.items, decision.focus_themes);
      return { value: version, summary: `Saved plan v${version} with 7 outcome-based sessions (days 1-${FREE_DAYS_NOTE} free)` };
    });
  } else {
    await t.tool("send_nudge", { channel: "in-app (preview)" }, async () => {
      const text = decision.nudge || "A 5-minute drill set is waiting. Two quick positions from your own games.";
      await query(`UPDATE plans SET nudge=$2 WHERE id=(SELECT id FROM plans WHERE player_id=$1 ORDER BY version DESC LIMIT 1)`, [playerId, text]);
      return { value: null, summary: `Nudge saved as preview: "${text}"`, note: "Nudges are preview-only until the player opts in to a channel." };
    });
  }

  // EVALUATE
  await t.tool<unknown>("evaluate_progress", {}, async () => {
    const p = await evaluateProgress(playerId);
    if (!p.enough) return { value: p, summary: "Not enough games to compare windows yet" };
    const r = p.recent, pv = p.prev;
    return { value: p, summary: pv ? `Blunders per 100 moves ${pv.blundersPer100} -> ${r.blundersPer100}; avg win% lost per move ${pv.avgLossPerMove} -> ${r.avgLossPerMove}` : `Baseline set: ${r.blundersPer100} blunders per 100 moves over ${r.games} games`, note: pv ? undefined : "Comparison appears once there are two windows of games." };
  });
  await query(`UPDATE agent_runs SET status='done', mode=$2, decision=$3, ended_at=now() WHERE id=$1`, [runId, decision.mode, JSON.stringify(decision)]);
}
