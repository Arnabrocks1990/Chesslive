import { query } from "./db.js";

// Win probability (0-100) from a centipawn score, same curve Lichess uses.
const winPct = (cp: number) => 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
const accuracy = (drop: number) => Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * drop) - 3.1669));

interface MoveRow { ply: number; san: string; uci: string }
interface AnalysisRow { ply: number; eval_cp: number; top_moves: { uci: string; san: string }[] }

export async function buildReport(gameId: number) {
  const moves = await query<MoveRow>(`SELECT ply, san, uci FROM moves WHERE game_id=$1 ORDER BY ply`, [gameId]);
  const analyses = await query<AnalysisRow>(
    `SELECT ply, eval_cp, top_moves FROM analyses WHERE game_id=$1 ORDER BY ply`,
    [gameId]
  );
  const byPly = new Map(analyses.map((a) => [a.ply, a]));
  const total = moves.length + 1;
  const ready = analyses.length >= total;

  const rows = moves.map((m) => {
    const before = byPly.get(m.ply - 1);
    const after = byPly.get(m.ply);
    const white = m.ply % 2 === 1;
    let drop: number | null = null;
    let label = "";
    if (before && after) {
      const wb = winPct(before.eval_cp);
      const wa = winPct(after.eval_cp);
      drop = Math.max(0, white ? wb - wa : wa - wb);
      label = drop > 20 ? "blunder" : drop > 10 ? "mistake" : drop > 5 ? "inaccuracy" : "";
    }
    return {
      ply: m.ply,
      san: m.san,
      color: white ? "white" : "black",
      drop,
      label,
      best: before?.top_moves?.[0]?.san ?? null,
      playedBest: before?.top_moves?.[0]?.uci === m.uci,
      evalAfter: after?.eval_cp ?? null,
    };
  });

  const summary = (color: string) => {
    const mine = rows.filter((r) => r.color === color && r.drop !== null);
    const count = (l: string) => mine.filter((r) => r.label === l).length;
    return {
      accuracy: mine.length ? Math.round(mine.reduce((s, r) => s + accuracy(r.drop!), 0) / mine.length) : null,
      blunders: count("blunder"),
      mistakes: count("mistake"),
      inaccuracies: count("inaccuracy"),
      bestMoves: mine.filter((r) => r.playedBest).length,
    };
  };

  return {
    ready,
    progress: { done: analyses.length, total },
    white: summary("white"),
    black: summary("black"),
    moves: rows,
  };
}
