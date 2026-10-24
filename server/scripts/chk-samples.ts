import { Chess } from "chess.js";
import { SAMPLE_GAMES } from "../src/coach/samples.js";
for (const s of SAMPLE_GAMES) {
  const c = new Chess();
  try { c.loadPgn(s.pgn); console.log(s.id, "ok", c.history().length, "plies"); continue; } catch {}
  // locate the first illegal move
  const moves = s.pgn.split("\n\n")[1].replace(/\d+\.\s*/g, "").replace(/[01]-[01]|1\/2-1\/2/, "").trim().split(/\s+/);
  const d = new Chess();
  for (let i = 0; i < moves.length; i++) { try { d.move(moves[i]); } catch { console.log(s.id, "illegal at ply", i + 1, moves[i], "fen", d.fen()); break; } }
}
