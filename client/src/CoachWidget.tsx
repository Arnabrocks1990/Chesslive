import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { api } from "./api";
import { stepText } from "./lang";

// Floating coach assistant. Deliberately not rendered on game pages: the coach never helps during live play.

interface Brief {
  player: { id: number; platform: string; username: string };
  plan: { focus_themes: string[]; diagnosis: string; nudge: string | null } | null;
  analysedGames: number; drills: { total: number; attempted: number };
  latestRun: { id: number; status: string; trigger: string } | null;
  running: boolean; themeLabels: Record<string, string>;
}
interface Step { id: number; tool: string; output_summary: string }
interface Msg { from: "you" | "coach"; text: string; mode?: string }

const KEY = "coach.player";
const SEEN = "coach.seenRun";
const CHIPS = ["What should I work on today?", "Why do I keep losing material?", "Am I improving?"];

export default function CoachWidget() {
  const { pathname } = useLocation();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const [playerId, setPlayerId] = useState<number | null>(() => Number(localStorage.getItem(KEY)) || null);
  const [brief, setBrief] = useState<Brief | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [seen, setSeen] = useState(() => Number(localStorage.getItem(SEEN)) || 0);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [q, setQ] = useState("");
  const [asking, setAsking] = useState(false);
  const [username, setUsername] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    if (!playerId) return;
    try {
      const b = await api<Brief>(`/coach/players/${playerId}`);
      setBrief(b);
      if (b.latestRun) {
        const r = await api<{ steps: Step[] }>(`/coach/runs/${b.latestRun.id}`);
        setSteps(r.steps);
      }
    } catch (e: any) {
      if (/not found/i.test(e.message)) { localStorage.removeItem(KEY); setPlayerId(null); setBrief(null); }
    }
  }, [playerId]);

  useEffect(() => {
    load();
    const t = setInterval(load, open || brief?.running ? 3000 : 15000);
    return () => clearInterval(t);
  }, [load, open, brief?.running]);

  useEffect(() => { logRef.current?.scrollTo({ top: logRef.current.scrollHeight }); }, [msgs, asking, steps.length]);

  const latest = brief?.latestRun?.id ?? 0;
  const unseen = !open && latest > seen && !brief?.running;
  useEffect(() => {
    if (open && latest) { localStorage.setItem(SEEN, String(latest)); setSeen(latest); }
  }, [open, latest]);

  if (pathname.startsWith("/g/")) return null; // fair play: no coach during a live game

  const working = !!brief?.running;
  const act = async (path: string) => {
    if (!playerId) return;
    setErr("");
    try { await api(`/coach/players/${playerId}/${path}`, {}); await load(); } catch (e: any) { setErr(e.message); }
  };
  async function ask(text: string) {
    if (!playerId || !text.trim() || asking) return;
    setMsgs((m) => [...m, { from: "you", text }]);
    setQ(""); setAsking(true);
    try {
      const r = await api<{ answer: string; mode: string }>(`/coach/players/${playerId}/ask`, { question: text });
      setMsgs((m) => [...m, { from: "coach", text: r.answer, mode: r.mode }]);
    } catch (e: any) { setMsgs((m) => [...m, { from: "coach", text: `Sorry: ${e.message}` }]); }
    setAsking(false);
  }
  async function onboard(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setErr("");
    try {
      const r = await api<{ playerId: number }>("/coach/players", { platform: "lichess", username: username.trim() });
      localStorage.setItem(KEY, String(r.playerId));
      setPlayerId(r.playerId);
    } catch (e2: any) { setErr(e2.message); } finally { setBusy(false); }
  }

  return (
    <>
      {open && (
        <aside className="cw-panel" role="dialog" aria-label="AI Coach">
          <header>
            <span className={`cw-dot ${working ? "work" : ""}`} />
            <b>Coach</b>
            <span className="muted small">{working ? "working on your games…" : playerId ? "ready" : "not set up"}</span>
            <button className="cw-x" onClick={() => setOpen(false)} aria-label="Close">×</button>
          </header>
          <div className="cw-body" ref={logRef}>
            {!playerId ? (
              <form onSubmit={onboard} className="cw-onboard">
                <p>I read your finished games, find the mistakes you repeat, and build drills from them. Then I keep watching for new games.</p>
                <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Lichess username" required />
                <button className="primary" disabled={busy}>{busy ? "Checking…" : "Start coaching"}</button>
                <Link to="/coach" onClick={() => setOpen(false)} className="muted small">More options (Chess.com, PGN)</Link>
              </form>
            ) : (
              <>
                <div className="cw-card">
                  <div className="muted small">{brief?.player.platform === "pgn" ? "Uploaded games" : brief?.player.username} · {brief?.analysedGames ?? 0} games analysed</div>
                  {brief?.plan ? (
                    <>
                      <div><b>Focus:</b> {brief.plan.focus_themes.map((t) => brief.themeLabels[t] ?? t).join(", ")}</div>
                      <div className="muted small">{brief.drills.total} drills ready · {brief.drills.attempted} tried</div>
                    </>
                  ) : <div className="muted">{working ? "Building your first plan…" : "No plan yet."}</div>}
                </div>
                <div className="cw-steps">
                  {steps.slice(-5).map((s) => (
                    <div key={s.id} className={s.output_summary === "running..." || /^(Stockfish|Analyzing) /.test(s.output_summary) ? "live" : ""}>
                      <code>{s.tool}</code> {stepText(s.output_summary)}
                    </div>
                  ))}
                </div>
                {msgs.map((m, i) => (
                  <div key={i} className={`cw-msg ${m.from}`}>{m.text}{m.mode === "rules" && <span className="muted small"> (from your plan)</span>}</div>
                ))}
                {asking && <div className="cw-msg coach muted">Thinking…</div>}
              </>
            )}
            {err && <div className="error">{err}</div>}
          </div>
          {playerId && (
            <footer>
              <div className="cw-actions">
                <button onClick={() => { setOpen(false); nav(`/coach/${playerId}`); }}>Open report</button>
                <button disabled={working} onClick={() => act("run")}>Run now</button>
                <button disabled={working} onClick={() => act("simulate")} title="Demo: inject a stored game">Simulate game</button>
              </div>
              <div className="cw-chips">{CHIPS.map((c) => <button key={c} onClick={() => ask(c)} disabled={asking || !brief?.plan}>{c}</button>)}</div>
              <form onSubmit={(e) => { e.preventDefault(); ask(q); }} className="cw-ask">
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask your coach…" disabled={!brief?.plan} />
                <button className="primary" disabled={asking || !q.trim()}>Ask</button>
              </form>
            </footer>
          )}
        </aside>
      )}
      <button className={`cw-fab ${working ? "work" : ""}`} onClick={() => setOpen((o) => !o)} aria-label="Open AI Coach" title="AI Coach">
        <span>♞</span>
        {(working || unseen) && <i className="cw-badge" />}
      </button>
    </>
  );
}
