import { Chess, PieceSymbol } from "chess.js";
import { query } from "../db.js";

// Same Lichess curve and thresholds as report.ts so the coach and the game report agree.
const winPct = (cp: number) => 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
const VALUE: Record<PieceSymbol, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 };

export const THEMES = ["hanging_piece", "missed_tactic", "missed_mate", "allowed_mate", "back_rank", "opening_error", "endgame_conversion", "time_trouble", "other"] as const;
export type Theme = (typeof THEMES)[number];
export const THEME_LABEL: Record<string, string> = {
  hanging_piece: "Hanging pieces", missed_tactic: "Missed tactics", missed_mate: "Missed mates", allowed_mate: "Allowed mates",
  back_rank: "Back-rank weakness", opening_error: "Opening errors", endgame_conversion: "Endgame conversion", time_trouble: "Time-trouble blunders", other: "Other mistakes",
};

interface Top { uci: string; san: string; eval_cp: number; mate: number | null; pv: string }
interface An { ply: number; fen: string; eval_cp: number; mate: number | null; top_moves: Top[] }
interface Mv { ply: number; san: string; uci: string; clock_ms: number }

const pieceCount = (c: Chess) => c.board().flat().filter(Boolean).length;

/** Material the opponent could win right now: the engine's best reply is a capture of an undefended (or more valuable) piece. */
function hangingAfter(fenAfter: string, reply: Top | undefined, mover: "w" | "b"): boolean {
  if (!reply || !reply.san.includes("x")) return false;
  const c = new Chess(fenAfter);
  const to = reply.uci.slice(2, 4) as any;
  const victim = c.get(to);
  const attacker = c.get(reply.uci.slice(0, 2) as any);
  if (!victim || victim.color !== mover || !attacker || VALUE[victim.type] < 3) return false;
  const defended = c.isAttacked(to, mover);
  return !defended || VALUE[victim.type] > VALUE[attacker.type];
}

/** Does the best move attack two or more higher-value pieces (or king + piece)? */
function isFork(fenBefore: string, uci: string): boolean {
  const c = new Chess(fenBefore);
  try { c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }); } catch { return false; }
  const to = uci.slice(2, 4);
  const mover = c.get(to as any);
  if (!mover) return false;
  // Pass the turn back to the mover to see what the moved piece would attack next.
  try {
    const flipped = new Chess(c.fen().replace(/ [wb] /, mover.color === "w" ? " w " : " b ").replace(/ [a-h][36] /, " - "));
    let count = 0;
    for (const m of flipped.moves({ verbose: true })) {
      if (m.from !== to || !m.captured) continue;
      if (VALUE[m.captured as PieceSymbol] > VALUE[mover.type] || m.captured === "k") count++;
    }
    return count >= 2;
  } catch { return false; }
}

export interface TaggedMistake {
  ply: number; severity: "inaccuracy" | "mistake" | "blunder"; phase: "opening" | "middlegame" | "endgame";
  themes: Theme[]; drop: number; playedSan: string; bestSan: string | null; bestUci: string | null;
  fenBefore: string; pv: string | null; evalBefore: number; evalAfter: number;
}

export function tagGame(color: "white" | "black", moves: Mv[], analyses: An[]): TaggedMistake[] {
  const at = new Map(analyses.map((a) => [a.ply, a]));
  const me = color === "white" ? "w" : "b";
  const out: TaggedMistake[] = [];
  for (const m of moves) {
    if ((m.ply % 2 === 1) !== (me === "w")) continue;
    const before = at.get(m.ply - 1), after = at.get(m.ply);
    if (!before || !after || !before.top_moves.length) continue;
    const pov = (cp: number) => (me === "w" ? cp : -cp);
    const eb = pov(before.eval_cp), ea = pov(after.eval_cp);
    const drop = Math.max(0, winPct(eb) - winPct(ea));
    if (drop <= 5 || before.top_moves[0].uci === m.uci) continue;
    const severity = drop > 20 ? "blunder" : drop > 10 ? "mistake" : "inaccuracy";
    const best = before.top_moves[0];
    const board = new Chess(before.fen);
    const pieces = pieceCount(board);
    const phase = m.ply <= 20 ? "opening" : pieces < 10 ? "endgame" : "middlegame";
    const themes: Theme[] = [];

    const myMateBefore = best.mate !== null && (best.mate > 0) === (me === "w");
    const theirMateAfter = after.mate !== null && (after.mate > 0) !== (me === "w");
    if (myMateBefore && !(after.mate !== null && (after.mate > 0) === (me === "w"))) themes.push("missed_mate");
    if (theirMateAfter) {
      themes.push("allowed_mate");
      const reply = after.top_moves[0];
      const rank = reply?.uci?.[3];
      const kingSq = new Chess(after.fen).board().flat().find((p) => p && p.type === "k" && p.color === me);
      if (reply && (rank === "1" || rank === "8") && kingSq && reply.san.endsWith("#")) {
        const sq = new Chess(after.fen).board().flat().findIndex((p) => p === kingSq);
        if (Math.floor(sq / 8) === (rank === "8" ? 0 : 7)) themes.push("back_rank");
      }
    }
    if (hangingAfter(after.fen, after.top_moves[0], me)) themes.push("hanging_piece");
    if (eb - ea > 200 && (best.san.includes("x") || best.san.includes("+") || isFork(before.fen, best.uci)) && !themes.includes("missed_mate"))
      themes.push("missed_tactic");
    if (phase === "opening" && drop > 10) themes.push("opening_error");
    if (eb >= 300 && pieces < 10 && ea < 100) themes.push("endgame_conversion");
    if (m.clock_ms > 0 && m.clock_ms < 30_000 && severity !== "inaccuracy") themes.push("time_trouble");
    if (!themes.length) themes.push("other");

    out.push({
      ply: m.ply, severity, phase, themes, drop: Math.round(drop * 10) / 10, playedSan: m.san, bestSan: best.san, bestUci: best.uci,
      fenBefore: before.fen, pv: best.pv ?? null, evalBefore: eb, evalAfter: ea,
    });
  }
  return out;
}

/** tag_mistakes tool: (re)computes and stores mistakes for one analysed game. */
export async function tagStoredGame(gameId: number): Promise<TaggedMistake[]> {
  const [g] = await query<{ player_id: number; player_color: "white" | "black" }>(`SELECT player_id, player_color FROM games WHERE id=$1`, [gameId]);
  const moves = await query<Mv>(`SELECT ply, san, uci, clock_ms FROM moves WHERE game_id=$1 ORDER BY ply`, [gameId]);
  const analyses = await query<An>(`SELECT ply, fen, eval_cp, mate, top_moves FROM analyses WHERE game_id=$1 ORDER BY ply`, [gameId]);
  const tagged = tagGame(g.player_color, moves, analyses);
  await query(`DELETE FROM mistakes WHERE game_id=$1`, [gameId]);
  for (const t of tagged) {
    await query(
      `INSERT INTO mistakes (game_id, player_id, ply, severity, phase, themes, win_pct_drop, played_san, best_san, best_uci, fen_before, pv, eval_before_cp, eval_after_cp)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [gameId, g.player_id, t.ply, t.severity, t.phase, t.themes, t.drop, t.playedSan, t.bestSan, t.bestUci, t.fenBefore, t.pv, t.evalBefore, t.evalAfter]
    );
  }
  return tagged;
}
