import { Chess } from "chess.js";
import { query } from "../db.js";
import { lessonFor, plainLessonFor } from "./lessons.js";

// Hints and plain-language text are built deterministically from stored engine data,
// so they cannot invent chess facts. Nothing here calls the LLM.

const NAME: Record<string, string> = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };

export interface MoveInfo { piece: string; from: string; to: string; captured: string | null; check: boolean; castle: boolean; promotion: boolean; san: string }

export function moveInfo(fen: string, move: { uci?: string | null; san?: string | null }): MoveInfo | null {
  try {
    const c = new Chess(fen);
    const m = move.uci
      ? c.move({ from: move.uci.slice(0, 2), to: move.uci.slice(2, 4), promotion: move.uci[4] })
      : c.move(String(move.san));
    return {
      piece: NAME[m.piece], from: m.from, to: m.to, captured: m.captured ? NAME[m.captured] : null,
      check: /[+#]$/.test(m.san), castle: m.san.startsWith("O-O"), promotion: !!m.promotion, san: m.san,
    };
  } catch { return null; }
}

/** One short plain sentence for a move, with no notation and no square names. */
export function plainMove(m: MoveInfo | null): string {
  if (!m) return "the coach move";
  if (m.castle) return "castle your king to safety";
  let s = m.captured ? `use your ${m.piece} to capture their ${m.captured}` : `move your ${m.piece} to the highlighted square`;
  if (m.promotion) s += " and promote the pawn";
  if (m.check) s += ", giving check";
  return s;
}

interface Row { id: number; game_id: number; ply: number; themes: string[]; phase: string; fen_before: string; best_uci: string; best_san: string; played_san: string }

export async function loadMistake(id: number): Promise<Row | null> {
  const [m] = await query<Row>(`SELECT id, game_id, ply, themes, phase, fen_before, best_uci, best_san, played_san FROM mistakes WHERE id=$1`, [id]);
  return m ?? null;
}

/** Three progressive hints: what to think about, which piece, where it goes. */
export function hintFor(m: Row, n: number) {
  const lesson = lessonFor(m.themes.find((t) => t !== "other") ?? m.themes[0]);
  const best = moveInfo(m.fen_before, { uci: m.best_uci });
  if (!best) return null;
  const theme = m.themes.find((t) => t !== "other") ?? m.themes[0];
  const think = lesson.beforeEveryMove[0];
  const thinkPlain = plainLessonFor(theme).beforeEveryMove[0];
  const phase = m.phase === "opening" ? "early in the game" : m.phase === "endgame" ? "in an endgame" : "in the middle of the game";
  if (n === 1) {
    return { n, std: `Think about this first: ${think} This is a position ${phase}.`, plain: `Think about this first: ${thinkPlain} This is a position ${phase}.`, highlight: null };
  }
  if (n === 2) {
    return {
      n,
      std: `The coach move is made with your ${best.piece} (the one on ${best.from}).`,
      plain: `The coach move uses your ${best.piece}. It is highlighted on the board.`,
      highlight: { from: best.from, to: null },
    };
  }
  const extra = `${best.captured ? ` and captures their ${best.captured}` : ""}${best.check ? ", giving check" : ""}`;
  return {
    n,
    std: `It goes to ${best.to}${extra}.`,
    plain: `It goes to the second highlighted square${extra}.`,
    highlight: { from: best.from, to: best.to },
  };
}

/** What to show after an answer: both move descriptions, arrows data, and a plain-language reason. */
export async function verdictExtras(m: Row) {
  const best = moveInfo(m.fen_before, { uci: m.best_uci });
  const played = moveInfo(m.fen_before, { san: m.played_san });
  // The opponent's best reply to the played move, as analysed by Stockfish, tells us what the mistake cost.
  const [after] = await query<{ top_moves: { uci: string }[] }>(`SELECT top_moves FROM analyses WHERE game_id=$1 AND ply=$2`, [m.game_id, m.ply]);
  let victim: string | null = null;
  try {
    const reply = after?.top_moves?.[0]?.uci;
    if (reply && played) {
      const c = new Chess(m.fen_before);
      c.move(m.played_san);
      const r = c.move({ from: reply.slice(0, 2), to: reply.slice(2, 4), promotion: reply[4] });
      victim = r.captured ? NAME[r.captured] : null;
    }
  } catch { /* reason falls back to the generic line */ }
  const t = m.themes;
  let why: string;
  if (t.includes("missed_mate")) why = "There was a forced checkmate here. The coach move starts it.";
  else if (t.includes("allowed_mate")) why = "Your move let your opponent checkmate you.";
  else if (t.includes("hanging_piece") && played) why = victim
    ? `After you moved your ${played.piece}, your opponent could win your ${victim} for nothing or a bad trade.`
    : `After you moved your ${played.piece}, one of your pieces could be taken for free.`;
  else if (t.includes("missed_tactic")) why = "There was a stronger forcing move here: a capture, a check or an attack on two things at once.";
  else if (t.includes("opening_error")) why = "Early in the game this move gave away too much. The coach move keeps your position safe.";
  else if (t.includes("endgame_conversion")) why = "You were winning, but this move let the advantage slip.";
  else if (t.includes("time_trouble")) why = "This looks like a rushed move. A calm safety check would have found the better one.";
  else why = "The coach move is simply stronger in this position.";
  return {
    best, played, plainWhy: why,
    plainBest: plainMove(best), plainPlayed: played ? `you moved your ${played.piece}${played.captured ? ` and captured their ${played.captured}` : ""}` : null,
    arrows: { best: best ? [best.from, best.to] : null, played: played ? [played.from, played.to] : null },
  };
}
