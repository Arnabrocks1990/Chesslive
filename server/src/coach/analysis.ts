import { Chess } from "chess.js";
import type { Redis } from "ioredis";
import { query } from "../db.js";

/** Queues Stockfish jobs for every unanalysed position of a game (post-game queue, never the live one). */
export async function queueAnalysis(redis: Redis, gameId: number, code: string): Promise<number> {
  const have = new Set((await query<{ ply: number }>(`SELECT ply FROM analyses WHERE game_id=$1`, [gameId])).map((r) => r.ply));
  const moves = await query<{ ply: number; san: string }>(`SELECT ply, san FROM moves WHERE game_id=$1 ORDER BY ply`, [gameId]);
  const replay = new Chess();
  const job = (ply: number, fen: string) => JSON.stringify({ gameId, code, ply, fen, kind: "post" });
  const jobs: string[] = [];
  if (!have.has(0)) jobs.push(job(0, replay.fen()));
  for (const m of moves) {
    replay.move(m.san);
    if (have.has(m.ply)) continue;
    if (replay.isGameOver()) {
      // No moves for the engine to suggest in a terminal position; score it from the rules.
      const cp = replay.isCheckmate() ? (replay.turn() === "w" ? -10000 : 10000) : 0;
      await query(`INSERT INTO analyses (game_id, ply, fen, top_moves, eval_cp) VALUES ($1,$2,$3,'[]',$4) ON CONFLICT DO NOTHING`, [gameId, m.ply, replay.fen(), cp]);
    } else jobs.push(job(m.ply, replay.fen()));
  }
  if (jobs.length) await redis.lpush("analysis:post", ...jobs);
  return jobs.length;
}

export async function analysisProgress(gameId: number) {
  const [a] = await query<{ n: string }>(`SELECT COUNT(*) n FROM analyses WHERE game_id=$1`, [gameId]);
  const [m] = await query<{ n: string }>(`SELECT COUNT(*) n FROM moves WHERE game_id=$1`, [gameId]);
  return { done: Number(a.n), total: Number(m.n) + 1 };
}

/** Waits until the worker has analysed the whole game (or the deadline passes). */
export async function waitForAnalysis(gameId: number, timeoutMs: number, onTick?: (p: { done: number; total: number }) => void) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const p = await analysisProgress(gameId);
    onTick?.(p);
    if (p.done >= p.total) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 1500));
  }
}
