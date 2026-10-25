// Built-in puzzles for players who have no analysed games yet (and to top up when a player has fewer than a
// full set of their own). Every position is checked by test/improve-defaults.ts: the solution is legal and is
// the clear best move in a short search, so a "correct" answer is never an accident of the data.
export interface DefaultPuzzle {
  key: string;
  title: string;
  /** Same theme names as the coach's tagger, so hints and recommendations speak one language. */
  themes: string[];
  phase: "opening" | "middlegame" | "endgame";
  /** 1 = first steps, 2 = needs a plan, 3 = needs calculation. Served in this order. */
  level: 1 | 2 | 3;
  fen: string;
  /** The winning move in UCI. */
  best: string;
  /** What to say after solving it: why this move works. */
  idea: string;
}

export const DEFAULT_PUZZLES: DefaultPuzzle[] = [
  { key: "mate-ra8", title: "Mate in 1: back rank", themes: ["missed_mate", "back_rank"], phase: "endgame", level: 1,
    fen: "6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1", best: "a1a8",
    idea: "The black king is boxed in by its own pawns. A rook on the back rank gives check and nothing can block it or capture it." },
  { key: "mate-ladder", title: "Mate in 1: ladder", themes: ["missed_mate"], phase: "endgame", level: 1,
    fen: "7k/R7/8/8/8/8/8/1R4K1 w - - 0 1", best: "b1b8",
    idea: "One rook cuts off the 7th rank, the other delivers check on the 8th. The king has no squares left." },
  { key: "mate-king-rook", title: "Mate in 1: king and rook", themes: ["missed_mate"], phase: "endgame", level: 1,
    fen: "k7/8/1K6/8/8/8/8/7R w - - 0 1", best: "h1h8",
    idea: "Your king covers the squares next to the black king; the rook checks along the edge. Check the escape squares before you move." },
  { key: "free-queen", title: "A queen for nothing", themes: ["hanging_piece"], phase: "middlegame", level: 1,
    fen: "4k3/8/8/3q4/8/2N5/8/4K3 w - - 0 1", best: "c3d5",
    idea: "The queen is attacked by your knight and nothing defends it. Before every move ask: what is hanging?" },
  { key: "free-bishop", title: "Take the loose bishop", themes: ["hanging_piece"], phase: "middlegame", level: 1,
    fen: "8/5k2/8/3b4/8/8/5PPP/3R2K1 w - - 0 1", best: "d1d5",
    idea: "The bishop on d5 has no defender. A piece that nobody protects is a free gift." },
  { key: "mate-queen", title: "Mate in 1: queen", themes: ["missed_mate"], phase: "endgame", level: 1,
    fen: "k7/8/1K6/8/8/8/8/6Q1 w - - 0 1", best: "g1g8",
    idea: "The queen checks along the 8th rank while your king covers a7 and b7. Count the escape squares before you play." },
  { key: "smothered", title: "Smothered mate", themes: ["missed_mate"], phase: "middlegame", level: 2,
    fen: "6rk/6pp/8/6N1/8/8/8/6K1 w - - 0 1", best: "g5f7",
    idea: "The king is smothered by its own rook and pawns. A knight check cannot be blocked, and none of the king's neighbours are free." },
  { key: "knight-fork-rook", title: "Fork the king and rook", themes: ["missed_tactic"], phase: "middlegame", level: 2,
    fen: "7k/8/7r/4N3/8/8/8/6K1 w - - 0 1", best: "e5f7",
    idea: "A knight check that also attacks a rook wins the rook, because the king must move first." },
  { key: "knight-fork-c7", title: "The royal fork", themes: ["missed_tactic"], phase: "middlegame", level: 2,
    fen: "r3k3/8/8/1N6/8/8/8/4K3 w - - 0 1", best: "b5c7",
    idea: "From c7 the knight checks the king and attacks the rook on a8 at the same time." },
  { key: "queen-fork", title: "Queen check, then rook", themes: ["missed_tactic"], phase: "middlegame", level: 2,
    fen: "r5k1/6pp/8/8/8/8/5PPP/3Q2K1 w - - 0 1", best: "d1d5",
    idea: "The queen on d5 gives check along one diagonal and attacks the rook along the other. Look for checks that attack a second piece." },
  { key: "scholar", title: "Finish it: Qxf7#", themes: ["missed_mate", "opening_error"], phase: "opening", level: 2,
    fen: "r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4", best: "h5f7",
    idea: "f7 is defended only by the king, and the bishop on c4 supports the queen there. Early in the game, watch for the weak f7 square." },
  { key: "legal", title: "Legal's mate", themes: ["missed_mate", "opening_error"], phase: "opening", level: 3,
    fen: "rn1qkbnr/ppp2pp1/3p3p/4N3/2B1P3/2N5/PPPP1PPP/R1BbK2R w KQkq - 0 6", best: "c4f7",
    idea: "Giving up the queen was a trap. Bxf7+ forces the king to e7, and then Nd5 is checkmate." },
];
