import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Chess, Square } from "chess.js";
import { Chessboard } from "react-chessboard";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "./api";
import { LESSONS, Step } from "./learn/curriculum";

export interface LearnerMe {
  mode: boolean; title: string; level: number; xp: number; nextTitle: string | null; nextAt: number | null; floor: number;
  lessons: Record<string, number>; lessonsDone: number; totalLessons: number; graduated: boolean; rank: number | null;
}

const Stars = ({ n, of = 3 }: { n: number; of?: number }) => <span className="stars" aria-label={`${n} of ${of} stars`}>{Array.from({ length: of }, (_, i) => <i key={i} className={i < n ? "on" : ""}>★</i>)}</span>;

export function XpBar({ me }: { me: LearnerMe }) {
  const pct = me.nextAt ? Math.min(100, ((me.xp - me.floor) / (me.nextAt - me.floor)) * 100) : 100;
  return (
    <div className="xpbar">
      <div className="row between"><b>{me.title}</b><span className="muted small">{me.xp} XP{me.nextAt ? ` · ${me.nextAt - me.xp} to ${me.nextTitle}` : ""}</span></div>
      <div className="bar"><span style={{ width: `${pct}%` }} /></div>
    </div>
  );
}

// ---- home: the learning path ---------------------------------------------------------------------------

export function LearnHome() {
  const nav = useNavigate();
  const [me, setMe] = useState<LearnerMe | null>(null);
  const [board, setBoard] = useState<{ username: string; title: string; xp: number; lessons: number; total: number }[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const load = useCallback(async () => {
    setMe(await api<LearnerMe>("/learn/me"));
    setBoard(await api<typeof board>("/leaderboard/learners").catch(() => []));
  }, []);
  useEffect(() => { load().catch((e) => setErr(e.message)); }, [load]);

  const playBot = async () => {
    setBusy(true);
    try { const r = await api<{ code: string }>("/games", { color: "white", minutes: 15, increment: 10, vsBot: true, level: "beginner" }); nav(`/g/${r.code}`); }
    catch (e: any) { setErr(e.message); setBusy(false); }
  };
  if (!me) return <main className="learn"><p className={err ? "error" : "muted"}>{err || "Loading…"}</p></main>;
  const firstOpen = LESSONS.findIndex((l) => !me.lessons[l.key]);

  return (
    <main className="learn">
      <section className="card learnhead">
        <div>
          <h1>🎓 Learner mode</h1>
          <p className="muted">New to chess? Start here. Short, hands-on lessons teach you how every piece moves, how to win, and how to start a game. No experience needed.</p>
        </div>
        <XpBar me={me} />
        <div className="row">
          <span className="muted small">{me.lessonsDone} of {me.totalLessons} lessons done{me.rank ? ` · #${me.rank} among learners` : ""}{me.graduated ? " · Graduate" : ""}</span>
          <button className={me.mode ? "" : "primary"} onClick={async () => setMe(await api<LearnerMe>("/learn/mode", { on: !me.mode }))}>{me.mode ? "Learner mode: on" : "Turn learner mode on"}</button>
        </div>
      </section>

      <ol className="path">
        {LESSONS.map((l, i) => {
          const stars = me.lessons[l.key] ?? 0;
          const unlocked = i === 0 || !!me.lessons[LESSONS[i - 1].key];
          const current = i === firstOpen;
          return (
            <li key={l.key} className={`pnode ${stars ? "done" : unlocked ? "open" : "locked"} ${current ? "current" : ""}`}>
              <div className="pdot">{stars ? "✓" : unlocked ? i + 1 : "🔒"}</div>
              <div className="pcard">
                <div className="row between">
                  <div><b>{i + 1}. {l.title}</b><div className="muted small">{l.blurb} · about {l.minutes} min</div></div>
                  {stars > 0 && <Stars n={stars} />}
                </div>
                {unlocked ? <button className={current ? "primary" : ""} onClick={() => nav(`/learn/${l.key}`)}>{stars ? "Practise again" : current ? "Start lesson" : "Start"}</button>
                  : <div className="muted small">Finish lesson {i} to unlock.</div>}
              </div>
            </li>
          );
        })}
        <li className={`pnode ${me.graduated ? "done" : "open"}`}>
          <div className="pdot">🏁</div>
          <div className="pcard">
            <b>Play your first game</b>
            <div className="muted small">Face the Beginner bot. It plays gently and makes mistakes on purpose. Finishing a game and winning earn bonus XP.</div>
            <button className="primary" disabled={busy} onClick={playBot}>{busy ? "Setting up…" : "Play the Beginner bot"}</button>
          </div>
        </li>
      </ol>
      {err && <div className="error">{err}</div>}

      <section className="card">
        <h2>Top learners</h2>
        {board.length === 0 ? <p className="muted">Be the first on the board. Finish a lesson to appear here.</p> : (
          <ol className="board">{board.slice(0, 8).map((r) => <li key={r.username}>{r.username} <span className="muted small">{r.title} · {r.lessons}/{r.total} lessons</span><b>{r.xp} XP</b></li>)}</ol>
        )}
      </section>
    </main>
  );
}

// ---- one lesson ----------------------------------------------------------------------------------------------

const START = "4k3/8/8/8/8/8/8/4K3 w - - 0 1";
const dot = { background: "radial-gradient(circle, rgba(0,0,0,.35) 22%, transparent 24%)" };
const ring = { background: "radial-gradient(circle, transparent 55%, rgba(80,200,120,.75) 58%, rgba(80,200,120,.75) 70%, transparent 72%)" };

export function LessonPlayer() {
  const { key } = useParams();
  const nav = useNavigate();
  const lesson = useMemo(() => LESSONS.find((l) => l.key === key), [key]);
  const idx = LESSONS.findIndex((l) => l.key === key);
  const [i, setI] = useState(0);
  const [fen, setFen] = useState(START);
  const [sel, setSel] = useState<string | null>(null);
  const [solved, setSolved] = useState(false);
  const [mistakes, setMistakes] = useState(0);
  const [stepMistakes, setStepMistakes] = useState(0);
  const [msg, setMsg] = useState<{ kind: "ok" | "bad" | "tip"; text: string } | null>(null);
  const [picked, setPicked] = useState<number | null>(null);
  const [result, setResult] = useState<{ stars: number; gained: number; me: LearnerMe } | null>(null);
  const [busy, setBusy] = useState(false);
  const game = useRef(new Chess());

  const step: Step | undefined = lesson?.steps[i];
  const enter = useCallback((s: Step) => {
    const f = s.t === "click" ? START : "fen" in s && s.fen ? s.fen : START;
    game.current = new Chess(f);
    setFen(f); setSel(null); setSolved(s.t === "info"); setStepMistakes(0); setPicked(null); setMsg(null);
  }, []);
  useEffect(() => { if (step) enter(step); }, [step, enter]);
  useEffect(() => { setI(0); setResult(null); setMistakes(0); }, [key]);

  if (!lesson || !step) return <main className="learn"><p className="muted">Lesson not found. <Link to="/learn">Back to the path</Link></p></main>;

  const mistake = (text: string, hint = true) => {
    setMistakes((m) => m + 1);
    const n = stepMistakes + 1;
    setStepMistakes(n);
    setMsg({ kind: "bad", text: n >= 2 && hint && "hint" in step ? `${text} Hint: ${(step as any).hint}` : text });
  };

  const accepts = (s: Extract<Step, { t: "move" }>, m: { from: string; to: string; promotion?: string }) => {
    if (s.from && m.from !== s.from) return false;
    if (s.uci) return s.uci.includes(m.from + m.to) || s.uci.includes(m.from + m.to + (m.promotion ?? ""));
    if (s.to) return s.to.includes(m.to);
    if (s.any) return true;
    if (s.mate || s.check) { const t = new Chess(fen); t.move({ from: m.from, to: m.to, promotion: "q" }); return s.mate ? t.isCheckmate() : t.inCheck(); }
    return false;
  };

  /** Used by both drag and click-to-move. Returns true if the move was applied. */
  const attempt = (from: string, to: string): boolean => {
    if (solved || step.t !== "move") return false;
    const legal = game.current.moves({ square: from as Square, verbose: true }).find((m) => m.to === to);
    if (!legal) { mistake((step.wrong?.[to]) ?? "That piece can't move there. Click it to see where it can go.", false); setSel(null); return false; }
    if (!accepts(step, { from, to, promotion: legal.promotion })) { mistake(step.wrong?.[to] ?? "That's a legal move, but not the one this exercise asks for. Try again."); setSel(null); return false; }
    game.current.move({ from, to, promotion: "q" });
    setFen(game.current.fen()); setSel(null); setSolved(true);
    setMsg({ kind: "ok", text: step.success ?? "Correct! Well done." });
    return true;
  };

  const squareClick = (sq: string) => {
    if (step.t === "click") {
      if (solved) return;
      if (step.to.includes(sq)) { setSolved(true); setMsg({ kind: "ok", text: `Yes, that's ${sq}!` }); }
      else mistake(`That's ${sq}. Look again.`);
      return;
    }
    if (step.t !== "move" || solved) return;
    if (sel && sel !== sq && attempt(sel, sq)) return;
    const piece = game.current.get(sq as Square);
    if (piece && piece.color === game.current.turn()) {
      if (step.from && sq !== step.from) { setMsg({ kind: "tip", text: "This exercise is about the highlighted piece. Click that one." }); return; }
      setSel(sq === sel ? null : sq); setMsg(null);
    } else if (sel) setSel(null);
  };

  // squares: selected piece, legal destinations as dots, targets as rings, hint markers
  const styles: Record<string, React.CSSProperties> = {};
  if (step.t === "info" && step.marks) step.marks.forEach((m) => (styles[m] = { background: "rgba(255,200,0,.35)" }));
  if (step.t === "move") {
    if (!solved && step.from) styles[step.from] = { background: "rgba(255,200,0,.4)" };
    if (!solved) (step.marks ?? []).forEach((m) => (styles[m] = { ...(styles[m] ?? {}), ...ring }));
    if (sel && !solved) {
      styles[sel] = { background: "rgba(255,200,0,.55)" };
      game.current.moves({ square: sel as Square, verbose: true }).forEach((m) => (styles[m.to] = { ...(styles[m.to] ?? {}), ...(game.current.get(m.to as Square) ? { background: "radial-gradient(circle, transparent 60%, rgba(220,80,80,.6) 62%)" } : dot) }));
    }
  }
  if (step.t === "click" && stepMistakes >= 2 && !solved) step.to.forEach((m) => (styles[m] = ring));
  const arrows = step.t === "info" && step.arrows ? (step.arrows.map(([a, b]) => [a, b, "rgb(60,170,90)"]) as any) : [];

  const last = i === lesson.steps.length - 1;
  const nextLesson = LESSONS[idx + 1];
  const finish = async () => {
    setBusy(true);
    const stars = mistakes <= 1 ? 3 : mistakes <= 4 ? 2 : 1;
    try {
      const before = await api<LearnerMe>("/learn/me");
      const me = await api<LearnerMe>(`/learn/lessons/${lesson.key}`, { stars });
      setResult({ stars: Math.max(stars, before.lessons[lesson.key] ?? 0), gained: me.xp - before.xp, me });
    } finally { setBusy(false); }
  };
  const advance = () => (last ? finish() : setI(i + 1));
  const playBot = async () => {
    const r = await api<{ code: string }>("/games", { color: "white", minutes: 15, increment: 10, vsBot: true, level: "beginner" });
    nav(`/g/${r.code}`);
  };

  if (result) {
    return (
      <main className="learn">
        <section className="card done">
          <h1>Lesson complete 🎉</h1>
          <Stars n={result.stars} />
          <p>{lesson.title}: {result.gained > 0 ? `+${result.gained} XP` : "no new XP (you already had this result)"}</p>
          <XpBar me={result.me} />
          <div className="row">
            {nextLesson ? <button className="primary" onClick={() => nav(`/learn/${nextLesson.key}`)}>Next: {nextLesson.title}</button>
              : <button className="primary" onClick={playBot}>Play the Beginner bot</button>}
            <button onClick={() => nav("/learn")}>Back to the path</button>
          </div>
        </section>
      </main>
    );
  }

  const interactive = step.t === "move" || step.t === "click";
  return (
    <main className="learn">
      <Link to="/learn" className="muted">← Learning path</Link>
      <div className="row between"><h1>{idx + 1}. {lesson.title}</h1><span className="muted small">Step {i + 1} of {lesson.steps.length}</span></div>
      <div className="bar"><span style={{ width: `${((i + (solved ? 1 : 0)) / lesson.steps.length) * 100}%` }} /></div>
      <div className="lesson-grid">
        <div className="lesson-board">
          <Chessboard id="learn" position={fen} boardWidth={Math.min(440, typeof window !== "undefined" ? window.innerWidth - 32 : 440)} arePiecesDraggable={interactive && !solved && step.t === "move"}
            onPieceDrop={(f, t) => attempt(f, t)} onSquareClick={squareClick} customSquareStyles={styles} customArrows={arrows} animationDuration={200} />
        </div>
        <div className="lesson-side card">
          {step.t === "info" && (<><h2>{step.title}</h2><p>{step.text}</p></>)}
          {step.t === "move" && (<><div className="task">Your turn</div><h2>{step.prompt}</h2><div className="muted small">Click a piece to see where it can go, then click the square. You can also drag it.</div></>)}
          {step.t === "click" && (<><div className="task">Your turn</div><h2>{step.prompt}</h2></>)}
          {step.t === "quiz" && (
            <>
              <h2>{step.q}</h2>
              <div className="options">
                {step.options.map((o, k) => (
                  <button key={o} disabled={solved} className={picked === k ? (k === step.answer ? "right" : "wrong") : solved && k === step.answer ? "right" : ""}
                    onClick={() => { setPicked(k); if (k === step.answer) { setSolved(true); setMsg({ kind: "ok", text: step.explain }); } else mistake("Not quite. Have another go.", false); }}>{o}</button>
                ))}
              </div>
            </>
          )}
          {msg && <div className={`lmsg ${msg.kind}`}>{msg.text}</div>}
          {interactive && !solved && stepMistakes >= 3 && <button className="ghost" onClick={() => { setSolved(true); setMsg({ kind: "tip", text: "No problem. Watch what the answer looks like, then keep going." }); if (step.t === "move" && step.uci) { const m = step.uci[0]; game.current.move({ from: m.slice(0, 2), to: m.slice(2, 4), promotion: "q" }); setFen(game.current.fen()); } }}>Show me</button>}
          <div className="row">
            <button className="primary" disabled={!solved || busy} onClick={advance}>{last ? (busy ? "Saving…" : "Finish lesson") : "Next"}</button>
            {i > 0 && <button onClick={() => setI(i - 1)}>Back</button>}
          </div>
        </div>
      </div>
    </main>
  );
}
