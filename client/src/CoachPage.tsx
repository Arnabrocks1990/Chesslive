import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Chess } from "chess.js";
import { Chessboard } from "react-chessboard";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "./api";
import { useAuth } from "./App";
import { Access, SessionRow, Timeline } from "./CoachSession";
import { Extras, Hint, HintBox, LangTabs, PlainData, VerdictBody, arrowsFor, coachify, highlightStyles, useLang, usePlain, verdictSpeech } from "./lang";
import { VoiceToggle, useVoice } from "./voice";

// ---- types -------------------------------------------------------------------

interface Weakness { theme: string; label: string; count: number; score: number; per100: number; prevPer100: number | null; trend: string }
interface Example { id: number; ply: number; severity: string; phase: string; themes: string[]; win_pct_drop: number; played_san: string; best_san: string; pv: string; fen_before: string; explanation: string | null; code: string; source: string }
interface Window { games: number; blundersPer100: number; mistakesPer100: number; avgLossPerMove: number }
interface Overview {
  player: { id: number; platform: string; username: string; goal: string | null; share_token: string };
  plan: { version: number; focus_themes: string[]; diagnosis: string; items: { day: number; title: string; minutes: number; type: string; detail: string; theme?: string }[]; rationale: string; nudge: string | null; created_at: string } | null;
  weaknesses: Weakness[]; analysedGames: number; totals: { mistakes: number; blunders: number };
  progress: { enough: boolean; recent?: Window; prev?: Window | null };
  examples: Example[];
  games: { total: number; simulated: number; pending: number };
  drills: { total: number; attempts: number; passes: number; attempted: number };
  latestRun: { id: number; status: string; trigger: string; mode: string | null; decision: any; error: string | null } | null;
  runs: { id: number; trigger: string; status: string; started_at: string }[];
  running: boolean; themeLabels: Record<string, string>;
  sessions: SessionRow[]; access: Access; exampleExtras: Record<string, (Extras & { best?: unknown }) | null>;
}
interface Step { id: number; n: number; tool: string; output_summary: string; note: string | null }

const TRIGGER: Record<string, string> = { onboarding: "First run", new_games: "New games detected", weekly: "Weekly review", manual: "Manual run", idle: "Idle check", simulated: "Simulated new game" };
const TREND: Record<string, string> = { improving: "▼ improving", worsening: "▲ worsening", flat: "– flat", new: "● new", unknown: "—" };

// ---- live agent trace ---------------------------------------------------------------

function Trace({ runId, onDone }: { runId: number; onDone: () => void }) {
  const [data, setData] = useState<{ run: any; steps: Step[] } | null>(null);
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    let stop = false, finished = false;
    const tick = async () => {
      try {
        const d = await api<{ run: any; steps: Step[] }>(`/coach/runs/${runId}`);
        if (stop) return;
        setData(d);
        if (d.run.status !== "running" && !finished) { finished = true; done.current(); return; }
      } catch { /* retry on next tick */ }
      if (!stop && !finished) setTimeout(tick, 1500);
    };
    tick();
    return () => { stop = true; };
  }, [runId]);
  if (!data) return <p className="muted">Loading agent trace…</p>;
  const { run, steps } = data;
  return (
    <div className="trace">
      <div className="muted small">{TRIGGER[run.trigger] ?? run.trigger} · {run.status === "running" ? "working…" : run.status}{run.mode ? ` · decisions by ${run.mode === "llm" ? "AI planner" : "rules"}` : ""}</div>
      <ol>
        {steps.map((s) => (
          <li key={s.id} className={s.output_summary === "running..." || s.output_summary.startsWith("Stockfish ") ? "live" : s.output_summary.startsWith("failed") ? "bad" : "ok"}>
            <code>{s.tool}</code> <span>{s.output_summary}</span>
            {s.note && <div className="note">{s.note}</div>}
          </li>
        ))}
        {run.status === "running" && <li className="live"><span className="muted">…</span></li>}
      </ol>
      {run.status === "failed" && <div className="error">Run failed: {run.error}</div>}
    </div>
  );
}

// ---- report pieces (shared with the public share page) --------------------------------

function Report({ o, readOnly, onChanged, plain }: { o: Overview; readOnly?: boolean; onChanged?: () => void; plain?: PlainData | null }) {
  const p = o.progress;
  const { lang } = useLang();
  return (
    <>
      {o.plan && (
        <section className="card">
          <h2>Diagnosis</h2>
          <p>{plain?.diagnosis ?? o.plan.diagnosis}</p>
          <div className="muted small">Based on {o.analysedGames} analysed game(s){o.games.simulated ? `, including ${o.games.simulated} simulated demo game(s)` : ""}. Chess facts come from the engine; the AI only explains and plans.</div>
        </section>
      )}
      {o.weaknesses.length > 0 && (
        <section className="card">
          <h2>Your recurring weaknesses</h2>
          <table className="tbl">
            <thead><tr><th>Pattern</th><th>Times</th><th>Per 100 moves</th><th>Before</th><th>Trend</th></tr></thead>
            <tbody>
              {o.weaknesses.map((w) => (
                <tr key={w.theme} className={o.plan?.focus_themes.includes(w.theme) ? "focus" : ""}>
                  <td>{w.label}{o.plan?.focus_themes.includes(w.theme) && <em className="badge">focus</em>}</td>
                  <td>{w.count}</td><td>{w.per100}</td><td>{w.prevPer100 ?? "—"}</td><td className={`trend ${w.trend}`}>{TREND[w.trend]}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="muted small">Pattern labels are rule-based guesses ("likely cause"); the better move shown for each mistake always comes from the engine.</div>
        </section>
      )}
      {p.enough && p.recent && (
        <section className="card">
          <h2>Progress</h2>
          <div className="stats">
            <div className="stat"><b>{p.recent.blundersPer100}</b><span className="muted">blunders / 100 moves{p.prev ? ` (was ${p.prev.blundersPer100})` : ""}</span></div>
            <div className="stat"><b>{p.recent.mistakesPer100}</b><span className="muted">mistakes / 100 moves{p.prev ? ` (was ${p.prev.mistakesPer100})` : ""}</span></div>
            <div className="stat"><b>{p.recent.avgLossPerMove}</b><span className="muted">win % lost per move{p.prev ? ` (was ${p.prev.avgLossPerMove})` : ""}</span></div>
          </div>
          {!p.prev && <div className="muted small">Baseline from your latest {p.recent.games} games. The comparison appears once you have a second window of games.</div>}
        </section>
      )}
      {o.plan && (
        <section className="card">
          <h2>Your 7-day plan <span className="muted small">v{o.plan.version}</span></h2>
          <Timeline playerId={o.player.id} sessions={o.sessions ?? []} access={o.access} readOnly={readOnly} onChanged={onChanged} plain={plain} />
          <div className="muted small">Why this plan: {plain?.rationale ?? o.plan.rationale}</div>
          {o.plan.nudge && <div className="nudge">Nudge preview (not sent): “{o.plan.nudge}”</div>}
        </section>
      )}
      {o.examples.length > 0 && (
        <section className="card">
          <h2>Your costliest mistakes</h2>
          <div className="examples">
            {o.examples.slice(0, readOnly ? 3 : 6).map((x) => {
              const turn = new Chess(x.fen_before).turn();
              const ex = o.exampleExtras?.[x.id] as (Extras & { plainBest?: string }) | null | undefined;
              return (
                <div key={x.id} className="example">
                  <Chessboard id={`ex-${x.id}`} position={x.fen_before} boardWidth={200} arePiecesDraggable={false} boardOrientation={turn === "w" ? "white" : "black"} customArrows={arrowsFor(ex, lang) as any} />
                  <div>
                    <span className={`tag ${x.severity}`}>{x.severity}</span> <span className="muted small">{x.phase}{x.source === "simulated" ? " · simulated game" : ""}</span>
                    {lang === "plain" && ex ? (
                      <>
                        <div>Coach move: <b>{ex.plainBest}</b> <span className="muted">(you would have kept about {Math.round(x.win_pct_drop)}% more winning chance)</span></div>
                        {ex.plainPlayed && <div className="muted">In the game, {ex.plainPlayed}.</div>}
                        <div className="explain">{ex.plainWhy}</div>
                        <div className="muted small">Green arrow = coach move, red arrow = your move.</div>
                      </>
                    ) : (
                      <>
                        <div>You played <b>{x.played_san}</b>. Coach move: <b>{x.best_san}</b> <span className="muted">(−{Math.round(x.win_pct_drop)}% win chance)</span></div>
                        <div className="muted small">{x.themes.map((t) => o.themeLabels[t] ?? t).join(" · ")}</div>
                        {x.explanation && <div className="explain">{coachify(x.explanation)}</div>}
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </>
  );
}

// ---- drill trainer -------------------------------------------------------------------

interface Drill { id: number; fen: string; turn: "w" | "b"; themes: string[]; phase: string; dueCount: number }

function Trainer({ playerId, labels, onAnswered }: { playerId: number; labels: Record<string, string>; onAnswered: () => void }) {
  const [drill, setDrill] = useState<Drill | null | undefined>(undefined);
  const [result, setResult] = useState<any>(null);
  const [fen, setFen] = useState("");
  const [hl, setHl] = useState<Hint["highlight"] | null>(null);
  const { lang } = useLang();
  const { speak } = useVoice();
  useEffect(() => { if (result) speak(verdictSpeech(result, lang), { id: "verdict" }); }, [result]); // eslint-disable-line react-hooks/exhaustive-deps
  const load = useCallback(async () => {
    setResult(null);
    setHl(null);
    const r = await api<{ drill: Drill | null }>(`/coach/players/${playerId}/drills/next`);
    setDrill(r.drill);
    if (r.drill) setFen(r.drill.fen);
  }, [playerId]);
  useEffect(() => { load(); }, [load]);

  if (drill === undefined) return <p className="muted">Loading…</p>;
  if (drill === null) return <section className="card"><h2>Train</h2><p className="muted">No drills yet. The coach builds them from your own mistakes after its first run.</p></section>;

  const drop = (from: string, to: string) => {
    if (result) return false;
    const c = new Chess(drill.fen);
    let mv;
    try { mv = c.move({ from, to, promotion: "q" }); } catch { return false; }
    setFen(c.fen());
    api(`/coach/drills/${drill.id}/answer`, { uci: mv.from + mv.to + (mv.promotion ?? "") }).then((r) => { setResult(r); onAnswered(); });
    return true;
  };
  return (
    <section className="card trainer">
      <div>
        <Chessboard id="drill" position={result && lang === "plain" && result.fen ? result.fen : fen} customSquareStyles={result ? {} : highlightStyles(hl)} customArrows={arrowsFor(result, lang) as any} boardWidth={420} boardOrientation={drill.turn === "w" ? "white" : "black"} arePiecesDraggable={!result} onPieceDrop={(f, t) => drop(f, t)} />
      </div>
      <div className="drillside">
        <h2>Find the better move</h2>
        <p>This is a position from <b>your own game</b>. {drill.turn === "w" ? "White" : "Black"} to move. {drill.themes.map((t) => labels[t] ?? t).join(" · ")}</p>
        <div className="muted small">{drill.dueCount} drill(s) due</div>
        {!result && <HintBox resetKey={drill.id} onHighlight={setHl} fetchHint={(n) => api<Hint>(`/coach/drills/${drill.id}/hint`, { n })} />}
        {result && (
          <div className={`verdict ${result.pass ? "pass" : "fail"}`}>
            <b>{result.pass ? "Correct" : "Not quite"}</b>
            <VerdictBody v={result} />
            <div className="muted small">{result.pass ? `Comes back in ${result.nextReviewDays} day(s).` : "Will come back again soon."}</div>
            <button className="primary" onClick={load}>Next drill</button>
          </div>
        )}
      </div>
    </section>
  );
}

// ---- player page ------------------------------------------------------------------------

export function CoachPlayer() {
  const { id } = useParams();
  const playerId = Number(id);
  const [o, setO] = useState<Overview | null>(null);
  const [runId, setRunId] = useState<number | null>(null);
  const [tab, setTab] = useState<"coach" | "train">("coach");
  const [msg, setMsg] = useState("");
  const nav = useNavigate();
  const { lang } = useLang();
  const { user } = useAuth();

  const refresh = useCallback(async () => {
    const d = await api<Overview>(`/coach/players/${playerId}`);
    setO(d);
    return d;
  }, [playerId]);

  useEffect(() => {
    refresh().then((d) => { if (d.latestRun) setRunId(d.latestRun.id); }).catch((e) => setMsg(e.message));
  }, [refresh]);

  // The server-side poller can wake the agent on its own; notice a new run while this page is open.
  useEffect(() => {
    const t = setInterval(async () => {
      const d = await refresh().catch(() => null);
      if (d?.latestRun && d.latestRun.id !== runId) setRunId(d.latestRun.id);
    }, 8000);
    return () => clearInterval(t);
  }, [refresh, runId]);

  const start = async (path: string) => {
    setMsg("");
    try { const r = await api<{ runId: number }>(`/coach/players/${playerId}/${path}`, {}); setRunId(r.runId); refresh(); }
    catch (e: any) { setMsg(e.message); }
  };

  const { plain, state: plainState, error: plainError } = usePlain(playerId, lang === "plain", !!o?.plan);

  if (!o) return <main className="coach"><p className="muted">{msg || "Loading…"}</p></main>;
  const share = `${location.origin}/coach/share/${o.player.share_token}`;
  return (
    <main className="coach">
      <div className="coachhead">
        <div>
          <h1>{o.player.platform === "pgn" ? "Your uploaded games" : o.player.username} <em className="badge">{o.player.platform}</em></h1>
          {o.player.goal && <div className="muted">Goal: {o.player.goal}</div>}
        </div>
        <div className="row">
          <button onClick={() => start("run")} disabled={o.running}>Run coach now</button>
          <button onClick={() => start("simulate")} disabled={o.running} title="Injects a stored game as if you just finished it, to show the agent waking up">Simulate new game (demo)</button>
          <button onClick={() => { navigator.clipboard.writeText(share); setMsg("Share link copied"); }}>Share report</button>
          {user.role === "admin" && (
            <button title="Admin only: restart the day exercises and the demo payment so the demo can be run again" onClick={async () => {
              if (!confirm("Reset all exercise progress for this player and clear the demo payment? Days restart from Day 1 and the Day 3 paywall returns.")) return;
              try { const r = await api<{ sessionsReset: number }>(`/coach/players/${playerId}/admin/reset-exercises`, {}); setMsg(`Reset ${r.sessionsReset} day(s) for the demo`); await refresh(); }
              catch (e: any) { setMsg(e.message); }
            }}>↺ Reset demo (admin)</button>
          )}
          <button className="danger" onClick={async () => { if (confirm("Delete this player and all their games and plans?")) { await api(`/coach/players/${playerId}/delete`, {}); nav("/coach"); } }}>Delete my data</button>
        </div>
      </div>
      {msg && <div className="muted">{msg}</div>}
      <div className="langrow"><LangTabs /><VoiceToggle />{plainState === "loading" && <span className="muted small">Simplifying your plan…</span>}{plainState === "error" && <span className="muted small">{plainError}</span>}</div>
      <div className="tabs bigtabs">
        <button className={tab === "coach" ? "active" : ""} onClick={() => setTab("coach")}>Coach</button>
        <button className={tab === "train" ? "active" : ""} onClick={() => setTab("train")}>Train {o.drills.total ? `(${o.drills.total})` : ""}</button>
      </div>
      {tab === "coach" ? (
        <>
          <section className="card">
            <h2>What the coach did <span className="muted small">(every action is logged)</span></h2>
            {runId ? <Trace runId={runId} onDone={refresh} /> : <p className="muted">No run yet.</p>}
            {o.runs.length > 1 && (
              <div className="muted small runs">Earlier runs: {o.runs.filter((r) => r.id !== runId).map((r) => <button key={r.id} className="link" onClick={() => setRunId(r.id)}>#{r.id} {TRIGGER[r.trigger] ?? r.trigger}</button>)}</div>
            )}
          </section>
          {o.games.pending > 0 && !o.running && <div className="muted">{o.games.pending} game(s) still waiting for analysis.</div>}
          {!o.plan && !o.running && o.analysedGames < 3 && <section className="card"><b>Not enough games yet.</b> The coach needs at least 3 analysed games before it draws conclusions. Play or import more and it will pick them up.</section>}
          <Report o={o} onChanged={refresh} plain={plain} />
        </>
      ) : (
        <Trainer playerId={playerId} labels={o.themeLabels} onAnswered={refresh} />
      )}
      {tab === "train" && o.drills.attempts > 0 && <div className="muted">Solved {o.drills.passes} of {o.drills.attempts} attempts.</div>}
    </main>
  );
}

// ---- landing + onboarding ----------------------------------------------------------------------

export function CoachHome() {
  const nav = useNavigate();
  const [mode, setMode] = useState<"lichess" | "chesscom" | "pgn">("lichess");
  const [username, setUsername] = useState("");
  const [goal, setGoal] = useState("");
  const [pgn, setPgn] = useState("");
  const [color, setColor] = useState("white");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [verify, setVerify] = useState<{ code: string; field: string; settingsUrl: string; platform: string; username: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [players, setPlayers] = useState<{ id: number; platform: string; username: string; games: string }[]>([]);
  useEffect(() => { api<typeof players>("/coach/players").then(setPlayers).catch(() => {}); }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError("");
    try {
      const body = mode === "pgn" ? { platform: "pgn", pgn, color, goal } : { platform: mode, username, goal };
      const r = await api<{ playerId: number }>("/coach/players", body);
      nav(`/coach/${r.playerId}`);
    } catch (err: any) {
      // The account exists but we have not yet seen the user's code in its public profile.
      if (err.data?.needsVerification) { setVerify(err.data); setError(verify && verify.username === err.data.username ? "We could not see the code on your profile yet. Save it there, wait a few seconds, and try again." : ""); }
      else { setVerify(null); setError(err.message); }
    } finally { setBusy(false); }
  }
  return (
    <main className="coach">
      <section className="hero">
        <h1>An AI chess coach that works on its own.</h1>
        <p>Chess.com shows you what you got wrong. This coach decides what you should practise next, drills you on your <b>own</b> mistakes, and keeps updating your plan as new games appear.</p>
        <ul className="muted">
          <li>Reads your finished games and runs Stockfish on every move</li>
          <li>Finds the mistake patterns you keep repeating</li>
          <li>Builds your weekly plan and a drill set from your own blunders</li>
          <li>Wakes itself when you play new games, and shows every step it took</li>
        </ul>
      </section>
      <form className="card onboard" onSubmit={submit}>
        <h2>Start your coaching</h2>
        <div className="tabs">
          {(["lichess", "chesscom", "pgn"] as const).map((m) => <button type="button" key={m} className={mode === m ? "active" : ""} onClick={() => setMode(m)}>{m === "lichess" ? "Lichess" : m === "chesscom" ? "Chess.com" : "Paste PGN"}</button>)}
        </div>
        {mode !== "pgn" ? (
          <label>Your {mode === "lichess" ? "Lichess" : "Chess.com"} username<input value={username} onChange={(e) => { setUsername(e.target.value); setVerify(null); }} placeholder="e.g. your_username" required /></label>
        ) : (
          <>
            <label>PGN of your finished games<textarea rows={6} value={pgn} onChange={(e) => setPgn(e.target.value)} placeholder="Paste one or more PGNs" required /></label>
            <label>You played<select value={color} onChange={(e) => setColor(e.target.value)}><option value="white">White</option><option value="black">Black</option></select></label>
          </>
        )}
        <label>Your goal (optional)<input value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="e.g. reach 1400 in 8 weeks" /></label>
        {mode !== "pgn" && verify && verify.platform === mode && verify.username.toLowerCase() === username.trim().toLowerCase() && (
          <div className="verifybox">
            <b>Confirm this account is yours</b>
            <p>Add this code to the <b>{verify.field}</b> on your {mode === "lichess" ? "Lichess" : "Chess.com"} profile, save it, then press the button below. You can remove the code afterwards.</p>
            <div className="codeline">
              <code>{verify.code}</code>
              <button type="button" onClick={() => { navigator.clipboard?.writeText(verify.code).then(() => setCopied(true)).catch(() => {}); }}>{copied ? "Copied" : "Copy"}</button>
              <a href={verify.settingsUrl} target="_blank" rel="noopener noreferrer">Open my {mode === "lichess" ? "Lichess" : "Chess.com"} profile settings ↗</a>
            </div>
          </div>
        )}
        <button className="primary" disabled={busy}>{busy ? "Checking account…" : verify && mode !== "pgn" ? "I've added the code. Verify and analyse" : "Analyse my games"}</button>
        {error && <div className="error">{error}</div>}
        <div className="muted small">Only your own finished, public games are analysed, and we check the account is yours with a short code in your public profile (no password needed). Pasted PGNs need no check. No live-game assistance. You can delete your data any time.</div>
      </form>
      {players.length > 0 && (
        <section className="card">
          <h3>Recent players</h3>
          <ul className="games">{players.map((p) => <li key={p.id}><Link to={`/coach/${p.id}`}>{p.platform === "pgn" ? "Uploaded games" : p.username}</Link><span className="muted">{p.platform} · {p.games} games</span></li>)}</ul>
        </section>
      )}
    </main>
  );
}

// ---- public share page (no login) -----------------------------------------------------------------

export function CoachShare() {
  const { token } = useParams();
  const [o, setO] = useState<Overview | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    fetch(`/api/coach/share/${token}`).then(async (r) => (r.ok ? setO(await r.json()) : setErr((await r.json()).error))).catch(() => setErr("Could not load report"));
  }, [token]);
  if (err) return <main className="coach"><p className="error">{err}</p></main>;
  if (!o) return <main className="coach"><p className="muted">Loading…</p></main>;
  return (
    <main className="coach">
      <h1>Coaching report: {o.player.platform === "pgn" ? "uploaded games" : o.player.username} <em className="badge">shared</em></h1>
      <Report o={o} readOnly />
    </main>
  );
}
