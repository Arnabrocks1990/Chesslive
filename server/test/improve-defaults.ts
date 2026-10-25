// Checks every built-in puzzle: the position is legal, the stored solution is legal, and a short search agrees it
// is the best move by a clear margin (so a wrong "solution" can never ship).
//   npx tsx test/improve-defaults.ts
import { Chess, type Move } from "chess.js";
import { DEFAULT_PUZZLES } from "../src/improve/defaults.js";

const VAL: Record<string, number> = { p: 100, n: 300, b: 300, r: 500, q: 900, k: 0 };
const MATE = 100000;

function evalWhite(c: Chess): number {
  let s = 0;
  for (const row of c.board()) for (const p of row) if (p) s += (p.color === "w" ? 1 : -1) * VAL[p.type];
  return s;
}
/** Negamax with alpha-beta from the side to move's point of view. */
function search(c: Chess, depth: number, alpha: number, beta: number, ply: number): number {
  if (c.isCheckmate()) return -MATE + ply;
  if (c.isDraw() || c.isStalemate()) return 0;
  if (depth === 0) return (c.turn() === "w" ? 1 : -1) * evalWhite(c);
  let best = -Infinity;
  for (const m of c.moves({ verbose: true }) as Move[]) {
    c.move(m);
    const v = -search(c, depth - 1, -beta, -alpha, ply + 1);
    c.undo();
    if (v > best) best = v;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }
  return best;
}

let failed = 0;
for (const p of DEFAULT_PUZZLES) {
  const c = new Chess(p.fen);
  const scored = (c.moves({ verbose: true }) as Move[]).map((m) => {
    c.move(m);
    const v = -search(c, p.phase === "opening" ? 2 : 3, -Infinity, Infinity, 1); // 3 or 4 plies in total (openings have many moves)
    c.undo();
    return { uci: m.from + m.to + (m.promotion ?? ""), v };
  }).sort((a, b) => b.v - a.v);
  const mine = scored.find((s) => s.uci === p.best);
  const second = scored.find((s) => s.uci !== p.best);
  const isMate = !!mine && mine.v >= MATE - 10;
  const ok = !!mine && mine.v === scored[0].v && (!second || (isMate ? mine.v > second.v : mine.v - second.v >= 200));
  console.log(`${ok ? "PASS" : "FAIL"}  ${p.key.padEnd(16)} best=${p.best} (${mine?.v ?? "illegal"}) next=${second?.uci} (${second?.v})`);
  if (!ok) failed++;
}
if (new Set(DEFAULT_PUZZLES.map((p) => p.key)).size !== DEFAULT_PUZZLES.length) { console.log("FAIL  duplicate keys"); failed++; }
console.log(failed ? `\n${failed} FAILED` : "\nAll default puzzles verified");
process.exit(failed ? 1 : 0);
