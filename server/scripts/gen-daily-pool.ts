// Generates src/improve/dailyPool.ts: extra verified puzzles for the daily puzzle rotation.
// Positions come from seeded random games, so they are legal but unfamiliar; each one is kept only if the answer is
// clear: either the only move that checkmates, or a capture that wins a clear amount of material in a short search.
//   npx tsx scripts/gen-daily-pool.ts [mates] [material]      (writes the file; re-running gives the same puzzles)
import fs from "node:fs";
import { Chess, type Move } from "chess.js";

const WANT_MATE = Number(process.argv[2] || 22);
const WANT_MAT = Number(process.argv[3] || 22);
const BUDGET_MS = Number(process.argv[4] || 240_000); // stop and write what we have after this long
const started = Date.now();
const VAL: Record<string, number> = { p: 100, n: 300, b: 300, r: 500, q: 900, k: 0 };
const MATE = 100000;

let seed = 20261025;
const rnd = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

const material = (c: Chess) => { let s = 0; for (const row of c.board()) for (const p of row) if (p) s += (p.color === "w" ? 1 : -1) * VAL[p.type]; return s; };
function search(c: Chess, depth: number, alpha: number, beta: number, ply: number): number {
  if (c.isCheckmate()) return -MATE + ply;
  if (c.isDraw() || c.isStalemate()) return 0;
  if (depth === 0) return (c.turn() === "w" ? 1 : -1) * material(c);
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
const uci = (m: Move) => m.from + m.to + (m.promotion ?? "");
const pieces = (c: Chess) => c.board().flat().filter(Boolean).length;

function randomPosition(): Chess | null {
  const c = new Chess();
  const plies = 16 + Math.floor(rnd() * 44);
  for (let i = 0; i < plies; i++) {
    const ms = c.moves({ verbose: true }) as Move[];
    if (!ms.length || c.isGameOver()) return null;
    // mostly sensible-ish: prefer captures a little so material changes hands and positions open up
    const caps = ms.filter((m) => m.captured);
    c.move((caps.length && rnd() < 0.35 ? caps : ms)[Math.floor(rnd() * (caps.length && rnd() < 0.35 ? caps.length : ms.length))] ?? ms[0]);
  }
  return c.isGameOver() || c.inCheck() ? null : c;
}

const out: any[] = [];
const seen = new Set<string>();
let mates = 0, mats = 0, tried = 0;
const phaseOf = (c: Chess) => (pieces(c) < 10 ? "endgame" : "middlegame");

while ((mates < WANT_MATE || mats < WANT_MAT) && Date.now() - started < BUDGET_MS) {
  tried++;
  if (tried % 3000 === 0) console.log(`... ${tried} positions, ${mates} mates, ${mats} material`);
  const played = randomPosition();
  if (!played) continue;
  const c = new Chess(played.fen()); // no history: much faster draw/repetition checks in the search
  const fen = c.fen();
  if (seen.has(fen)) continue;
  const c2 = c; // c keeps the whole game history, which makes draw checks slow: search on a fresh copy instead
  void c2;
  const moves = c.moves({ verbose: true }) as Move[];
  if (moves.length < 8) continue;
  const mating = moves.filter((m) => { c.move(m); const mate = c.isCheckmate(); c.undo(); return mate; });
  if (mating.length === 1 && mates < WANT_MATE) {
    seen.add(fen); mates++;
    out.push({ key: `daily-m${mates}`, title: "Mate in 1", themes: ["missed_mate"], phase: phaseOf(c), level: 1, fen, best: uci(mating[0]),
      idea: "Look at every check. One of them is checkmate: the king has no safe square and nothing can capture the checking piece." });
    continue;
  }
  if (mating.length || mats >= WANT_MAT) continue;
  // material: a capture of a loose piece worth at least a knight, then confirmed by a short search
  const loose = moves.filter((m) => m.captured && VAL[m.captured] >= 300 && !(() => { c.move(m); const d = c.isAttacked(m.to, c.turn() === "w" ? "b" : "w"); c.undo(); return d; })());
  if (!loose.length) continue;
  const base = (c.turn() === "w" ? 1 : -1) * material(c);
  // stage 1 (cheap, root + one reply): only keep positions where a loose-piece capture clearly leads
  const quick = moves.map((m) => { c.move(m); const v = -search(c, 1, -Infinity, Infinity, 1); c.undo(); return { m, v }; }).sort((a, b) => b.v - a.v);
  if (!(quick[0].v - base >= 280 && quick[0].v - quick[1].v >= 250 && quick[0].m.captured && loose.some((l) => uci(l) === uci(quick[0].m)))) continue;
  // stage 2 (root + two plies): confirm it still holds one move deeper
  const scored = moves.map((m) => { c.move(m); const v = -search(c, 2, -Infinity, Infinity, 1); c.undo(); return { m, v }; }).sort((a, b) => b.v - a.v);
  if (uci(scored[0].m) === uci(quick[0].m) && scored[0].v - base >= 280 && scored[0].v - scored[1].v >= 250) {
    seen.add(fen); mats++;
    out.push({ key: `daily-w${mats}`, title: "Win material", themes: ["hanging_piece"], phase: phaseOf(c), level: 2, fen, best: uci(scored[0].m),
      idea: "One of your opponent's pieces is not protected. Before every move ask: what is hanging? Free material decides games." });
  }
}

const body = `// Generated by scripts/gen-daily-pool.ts (seeded, reproducible). Verified by test/improve-defaults.ts.
import type { DefaultPuzzle } from "./defaults.js";

export const DAILY_POOL: DefaultPuzzle[] = ${JSON.stringify(out, null, 2)};
`;
fs.writeFileSync(new URL("../src/improve/dailyPool.ts", import.meta.url), body);
console.log(`wrote ${out.length} puzzles (${mates} mates, ${mats} material) after ${tried} random positions`);
