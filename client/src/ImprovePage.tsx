import { useCallback, useEffect, useState } from "react";
import { Chess } from "chess.js";
import { Chessboard } from "react-chessboard";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "./api";
import { Hint, HintBox, VerdictBody, highlightStyles } from "./lang";

interface PuzzleRow {
  id: number; source: "game" | "default"; title: string; themeLabel: string; phase: string; status: "new" | "solved" | "revealed";
  hintsUsed: number; turn: "w" | "b"; from: { opponent: string | null; at: string; move: number; code: string } | null;
}
interface PuzzleSet { puzzles: PuzzleRow[]; fromGames: number; gamesConsidered: number; usingDefaults: boolean; solved: number }

const MARK = { new: "●", solved: "✓", revealed: "○" } as const;
const day = (d: string) => new Date(d).toLocaleDateString([], { dateStyle: "medium" });

export function ImproveHome() {
  const nav = useNavigate();
  const [set, setSet] = useState<PuzzleSet | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => { api<PuzzleSet>("/improve/puzzles").then(setSet).catch((e) => setErr(e.message)); }, []);
  if (!set) return <main className="improve"><p className={err ? "error" : "muted"}>{err || "Building your puzzles from your recent games…"}</p></main>;
  const total = set.puzzles.length;
  const next = set.puzzles.find((p) => p.status === "new");
  return (
    <main className="improve">
      <div className="row between">
        <h1>🧩 Improve your Game</h1>
        <Link to="/dashboard" className="link">📊 My dashboard</Link>
      </div>
      <p className="muted">
        {set.fromGames > 0
          ? `Puzzles built from your last ${set.gamesConsidered} game${set.gamesConsidered > 1 ? "s" : ""}: the positions where you had a clearly better move. Find it, and use the hints if you get stuck.`
          : "Practice puzzles to start with. Once you have played a few games, this page fills with positions from your own games."}
      </p>
      {set.fromGames > 0 && set.usingDefaults && <p className="muted small">A few practice puzzles are mixed in because your games gave fewer than six.</p>}
      <div className="card progresscard">
        <b>{set.solved} of {total} solved</b>
        <div className="bar"><span style={{ width: `${total ? (set.solved / total) * 100 : 0}%` }} /></div>
        {next ? <button className="primary" onClick={() => nav(`/improve/${next.id}`)}>{set.solved ? "Continue" : "Start"}</button> : <span className="muted">All done. Play more games for fresh puzzles.</span>}
      </div>
      <ul className="puzzles">
        {set.puzzles.map((p) => (
          <li key={p.id} className={p.status}>
            <Link to={`/improve/${p.id}`}>
              <span className="mark">{MARK[p.status]}</span>
              <span className="ptitle"><b>{p.title}</b><span className="muted small">{p.source === "game" && p.from ? `From your game vs ${p.from.opponent ?? "an opponent"} · ${day(p.from.at)}` : "Practice puzzle"}</span></span>
              <span className="muted small">{p.turn === "w" ? "White" : "Black"} to move · {p.phase}</span>
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}

interface PuzzleView { id: number; source: string; title: string; fen: string; turn: "w" | "b"; status: string; hintsUsed: number; context: string; gameCode: string | null }

export function ImprovePuzzle() {
  const { id } = useParams();
  const nav = useNavigate();
  const [p, setP] = useState<PuzzleView | null>(null);
  const [fen, setFen] = useState("");
  const [verdict, setVerdict] = useState<any>(null);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [hl, setHl] = useState<Hint["highlight"] | null>(null);

  const load = useCallback(async () => {
    const d = await api<PuzzleView>(`/improve/puzzles/${id}`);
    setP(d); setFen(d.fen); setMsg(""); setErr(""); setHl(null);
    // an already-finished puzzle shows its answer straight away
    if (d.status !== "new") setVerdict((await api<any>(`/improve/puzzles/${id}/reveal`, {})).verdict);
    else setVerdict(null);
  }, [id]);
  useEffect(() => { load().catch((e) => setErr(e.message)); }, [load]);

  const drop = (from: string, to: string) => {
    if (!p || verdict || busy) return false;
    const c = new Chess(p.fen);
    let mv;
    try { mv = c.move({ from, to, promotion: "q" }); } catch { return false; }
    setFen(c.fen()); setBusy(true); setMsg(""); setErr("");
    api<any>(`/improve/puzzles/${p.id}/answer`, { uci: mv.from + mv.to + (mv.promotion ?? "") })
      .then((r) => {
        if (r.correct) { setVerdict(r.verdict); setMsg(r.alternative ? "Also a strong move. The engine rates it about the same as the main line." : ""); }
        else { setFen(p.fen); setMsg("Not the best move here. Look again, or ask for a hint."); }
      })
      .catch((e) => { setFen(p.fen); setErr(`${e.message} Your move was not recorded. Try again.`); })
      .finally(() => setBusy(false));
    return true;
  };
  const showSolution = async () => {
    if (!p) return;
    setBusy(true);
    try { setVerdict((await api<any>(`/improve/puzzles/${p.id}/reveal`, {})).verdict); } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const goNext = async () => {
    const set = await api<PuzzleSet>("/improve/puzzles");
    const nxt = set.puzzles.find((x) => x.status === "new" && x.id !== p?.id);
    nav(nxt ? `/improve/${nxt.id}` : "/improve");
  };

  if (!p) return <main className="improve"><p className={err ? "error" : "muted"}>{err || "Loading…"}</p></main>;
  const best = verdict?.best ? [[verdict.best.from, verdict.best.to, "rgb(60,170,90)"]] : [];
  return (
    <main className="improve puzzle">
      <Link to="/improve" className="muted">← All puzzles</Link>
      <h1>{p.title}</h1>
      <section className="card trainer">
        <Chessboard id="improve" position={fen} boardWidth={420} boardOrientation={p.turn === "w" ? "white" : "black"}
          arePiecesDraggable={!verdict && !busy} onPieceDrop={(f, t) => drop(f, t)}
          customSquareStyles={verdict ? {} : highlightStyles(hl)} customArrows={best as any} />
        <div className="drillside">
          <p><b>{p.turn === "w" ? "White" : "Black"} to move.</b> {p.context}</p>
          {!verdict && <HintBox resetKey={p.id} onHighlight={setHl} fetchHint={(n) => api<Hint>(`/improve/puzzles/${p.id}/hint`, { n })} />}
          {msg && !verdict && <div className="verdict fail">{msg}</div>}
          {err && <div className="error">{err}</div>}
          {!verdict && <button disabled={busy} onClick={showSolution}>Show me the answer</button>}
          {verdict && (
            <div className={`verdict ${verdict.pass ? "pass" : "fail"}`}>
              <b>{verdict.pass ? "Solved" : "The answer"}</b>
              {verdict.pass && verdict.hintsUsed > 0 && <span className="muted small"> · used {verdict.hintsUsed} hint{verdict.hintsUsed > 1 ? "s" : ""}</span>}
              {msg && <div className="muted small">{msg}</div>}
              <VerdictBody v={verdict} />
              <div className="row">
                <button className="primary" onClick={goNext}>Next puzzle</button>
                {p.gameCode && <Link to={`/g/${p.gameCode}`} className="link">Review the game</Link>}
              </div>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
