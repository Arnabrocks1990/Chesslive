import { useCallback, useEffect, useRef, useState } from "react";
import { Chess } from "chess.js";
import { Chessboard } from "react-chessboard";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "./api";
import { Hint, HintBox, LangTabs, PlainData, VerdictBody, arrowsFor, highlightStyles, useLang, usePlain, verdictSpeech } from "./lang";
import { ListenButton, VoiceToggle, useVoice } from "./voice";

export interface SessionRow {
  id: number; day: number; type: "drill" | "review" | "play"; theme: string; themeLabel: string; title: string; detail: string; minutes: number; goal: string;
  state: "locked" | "paywall" | "available" | "active" | "retry" | "done"; attempts: number; score: number | null; total: number | null; passed: boolean | null; game_code: string | null;
}
export interface Access { pro: boolean; freeDays: number; priceInr: number }

// ---- paywall: pay by UPI QR, then wait for the admin to confirm -----------------------------------------

interface BillingPayment {
  id: number; reference: string; amountInr: number; status: "created" | "pending" | "confirmed" | "rejected" | "revoked";
  utr: string | null; adminNote: string | null; submittedAt: string | null;
}
interface Billing { pro: boolean; priceInr: number; upi: { id: string; payee: string; qr: string; link: string | null }; payment: BillingPayment | null }

const copy = (t: string) => navigator.clipboard?.writeText(t).catch(() => {});

export function Paywall({ playerId, price, onPaid }: { playerId: number; price: number; onPaid: () => void }) {
  const [b, setB] = useState<Billing | null>(null);
  const [utr, setUtr] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const notified = useRef(false);

  const load = useCallback(() => api<Billing>(`/billing/coach/${playerId}`).then(setB).catch((e) => setErr(e.message)), [playerId]);
  useEffect(() => { load(); }, [load]);
  // While waiting for the admin, poll so the page unlocks by itself the moment the payment is confirmed.
  useEffect(() => {
    if (b?.payment?.status !== "pending") return;
    const id = setInterval(load, 8000);
    return () => clearInterval(id);
  }, [b?.payment?.status, load]);
  useEffect(() => {
    if (b?.pro && !notified.current) { notified.current = true; onPaid(); }
  }, [b?.pro, onPaid]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true); setErr("");
    try { await fn(); await load(); } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const startCheckout = () => act(async () => { setB(await api<Billing>(`/billing/coach/${playerId}/checkout`, {})); });
  const submit = () => act(async () => { await api(`/billing/payments/${b!.payment!.id}/submit`, { utr }); });

  const p = b?.payment;
  const intro = (
    <div>
      <b>Days 1–2 are free. Keep going from Day 3.</b>
      <div className="muted">Unlock Days 3–7: more exercises, a practice game judged by the coach, a weekly review, and a new plan built from your next games.</div>
    </div>
  );

  if (b?.pro) return <div className="paywall"><b>✓ Unlocked.</b> Days 3–7 are open for this profile.</div>;

  if (p?.status === "pending") {
    return (
      <div className="paywall pending">
        {intro}
        <div className="pendingbox">
          <b>⏳ Confirmation pending</b>
          <div>We have your payment details (₹{p.amountInr}, transaction <span className="mono">{p.utr}</span>). Days 3–7 unlock as soon as the payment is verified. This page updates by itself, no need to pay again.</div>
          <div className="muted small">Reference {p.reference} · submitted {p.submittedAt ? new Date(p.submittedAt).toLocaleString() : ""}</div>
        </div>
        {err && <div className="error">{err}</div>}
      </div>
    );
  }

  if (p?.status === "created") {
    return (
      <div className="paywall">
        {intro}
        <div className="upi">
          <img src={b!.upi.qr} alt={`UPI QR code for ${b!.upi.payee}`} width={220} height={390} />
          <div className="upi-steps">
            <ol>
              <li>Scan the QR with any UPI app and pay <b>₹{p.amountInr}</b> to <b>{b!.upi.payee}</b>.<br />
                <span className="muted small">UPI ID <span className="mono">{b!.upi.id}</span> <button className="link" onClick={() => copy(b!.upi.id)}>copy</button></span></li>
              <li>Put this in the payment note: <b className="mono">{p.reference}</b> <button className="link" onClick={() => copy(p.reference)}>copy</button></li>
              <li>Enter the transaction / UPI reference number from your payment app:</li>
            </ol>
            <div className="row">
              <input placeholder="e.g. 412345678901" value={utr} onChange={(e) => setUtr(e.target.value)} />
              <button className="primary" disabled={busy || utr.trim().length < 10} onClick={submit}>{busy ? "Sending…" : "I've paid"}</button>
            </div>
            {b!.upi.link && <a className="muted small" href={b!.upi.link}>On your phone? Open in a UPI app</a>}
            <div className="muted small">Nothing unlocks until the payment is verified. That usually takes a short while.</div>
            {err && <div className="error">{err}</div>}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="paywall">
      {intro}
      {p && (p.status === "rejected" || p.status === "revoked") && (
        <div className="rejected">
          {p.status === "rejected" ? "Your last payment could not be verified." : "Access from your last payment was withdrawn."}
          {p.adminNote && <> Reason: <i>{p.adminNote}</i>.</>} You can pay again below.
        </div>
      )}
      <button className="primary" disabled={busy || !b} onClick={startCheckout}>Unlock Days 3–7 · ₹{b?.priceInr ?? price}/month</button>
      {err && <div className="error">{err}</div>}
    </div>
  );
}

// ---- milestone timeline ------------------------------------------------------------------------------

const TYPE_LABEL = { drill: "Drill", review: "Review", play: "Practice game" } as const;
const NODE: Record<string, string> = { done: "✓", locked: "🔒", paywall: "₹", available: "", active: "▶", retry: "↻" };

export function Timeline({ playerId, sessions, access, readOnly, onChanged, plain }: { playerId: number; sessions: SessionRow[]; access: Access; readOnly?: boolean; onChanged?: () => void; plain?: PlainData | null }) {
  const nav = useNavigate();
  if (!sessions.length) return <p className="muted">Sessions appear after the coach builds your plan.</p>;
  const done = sessions.filter((s) => s.state === "done").length;
  const current = sessions.find((s) => s.state !== "done");
  return (
    <>
      <div className="milestones">
        <div className="bar"><span style={{ width: `${(done / sessions.length) * 100}%` }} /></div>
        <span className="muted small">{done} of {sessions.length} milestones reached</span>
      </div>
      <ol className="timeline">
        {sessions.map((s) => (
          <li key={s.id} className={`tl ${s.state} ${current?.id === s.id ? "current" : ""}`}>
            {s.day === access.freeDays + 1 && !access.pro && !readOnly && (
              <div className="tl-gate"><Paywall playerId={playerId} price={access.priceInr} onPaid={() => onChanged?.()} /></div>
            )}
            <div className="tl-node">{NODE[s.state] || s.day}</div>
            <div className="tl-card">
              <div className="tl-head">
                <b>Day {s.day} · {plain?.sessions?.[s.id]?.title ?? s.title}</b>
                <span className="muted small">{s.minutes} min · {TYPE_LABEL[s.type]}</span>
                {s.day > access.freeDays && !access.pro && <em className="badge pro">Pro</em>}
              </div>
              <div className="tl-detail">{plain?.sessions?.[s.id]?.detail ?? s.detail}</div>
              <div className="tl-goal">🎯 Outcome: {s.goal}</div>
              {s.state === "done" && (
                <div className={`tl-result ${s.passed ? "ok" : "support"}`}>
                  {s.passed ? "Milestone reached" : "Completed with support"} · {s.type === "play" ? `${s.score} blunder(s)` : `${s.score}/${s.total} correct`}
                </div>
              )}
              {!readOnly && (s.state === "available" || s.state === "active" || s.state === "retry") && (
                <button className="primary" onClick={() => nav(`/coach/${playerId}/day/${s.id}`)}>
                  {s.state === "active" ? "Continue" : s.state === "retry" ? "Try again" : "Start exercise"}
                </button>
              )}
              {s.state === "locked" && <div className="muted small">Reach the Day {s.day - 1} milestone to unlock.</div>}
              {s.state === "paywall" && !readOnly && <div className="muted small">Unlock with Pro to continue.</div>}
            </div>
          </li>
        ))}
      </ol>
      <div className="tl-end">🏁 Week milestone: finish all 7 days and the coach rebuilds your plan from your new results.</div>
    </>
  );
}

// ---- one day's exercise: learn, practise, milestone ------------------------------------------------------

interface Lesson { headline: string; why: string; habits: string[]; beforeEveryMove: string[] }
interface SessionView {
  session: SessionRow; lesson: Lesson; lessonPlain: Lesson;
  progress: { total: number; answered: number; results: (string | null)[] };
  question: { id: number; fen: string; turn: "w" | "b"; themes: string[] } | null;
  nextSessionId: number | null; nextDay: number | null; isLast: boolean; access: Access; playerId: number;
}

export function CoachSession() {
  const { id, sid } = useParams();
  const nav = useNavigate();
  const [v, setV] = useState<SessionView | null>(null);
  const [fen, setFen] = useState("");
  const [verdict, setVerdict] = useState<any>(null);
  const [outcome, setOutcome] = useState<any>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [hl, setHl] = useState<Hint["highlight"] | null>(null);
  const { lang } = useLang();
  const { speak } = useVoice();
  const { plain, state: plainState } = usePlain(Number(id), lang === "plain", true);

  const load = useCallback(async () => {
    const d = await api<SessionView>(`/coach/sessions/${sid}`);
    setV(d);
    if (d.question) setFen(d.question.fen);
    return d;
  }, [sid]);
  useEffect(() => { setVerdict(null); setOutcome(null); load().catch((e) => setErr(e.message)); }, [load]);
  // The coach reads each answer aloud, and the milestone result after the last one.
  useEffect(() => {
    if (!verdict) return;
    const done = outcome ? ` ${outcome.passed ? "Milestone reached." : outcome.status === "retry" ? "Not yet, try once more." : "Completed with support."} ${outcome.decision ?? ""}` : "";
    speak(verdictSpeech(verdict, lang) + done, { id: "verdict" });
  }, [verdict, outcome]); // eslint-disable-line react-hooks/exhaustive-deps
  // A practice game is judged after it ends and Stockfish has analysed it, so keep checking meanwhile.
  useEffect(() => {
    if (!v || v.session.type !== "play" || v.session.state !== "active") return;
    const t = setInterval(() => load().catch(() => {}), 4000);
    return () => clearInterval(t);
  }, [v, load]);

  if (!v) return <main className="coach"><p className={err ? "error" : "muted"}>{err || "Loading…"}</p></main>;
  const s = v.session;
  const lesson = lang === "plain" ? v.lessonPlain : v.lesson;
  const title = plain?.sessions?.[s.id]?.title ?? s.title;
  const detail = plain?.sessions?.[s.id]?.detail ?? s.detail;
  const start = async (force = false) => {
    setBusy(true); setErr("");
    try {
      const r = await api<{ gameCode?: string }>(`/coach/sessions/${s.id}/start`, { force });
      if (r.gameCode) return nav(`/g/${r.gameCode}`);
      setVerdict(null); setOutcome(null); await load();
    } catch (e: any) { setErr(e.message === "payment_required" ? "This day is part of Pro." : e.message); } finally { setBusy(false); }
  };
  const drop = (from: string, to: string) => {
    if (verdict || !v.question) return false;
    const c = new Chess(v.question.fen);
    let mv;
    try { mv = c.move({ from, to, promotion: "q" }); } catch { return false; }
    setFen(c.fen());
    api<any>(`/coach/session-questions/${v.question.id}/answer`, { uci: mv.from + mv.to + (mv.promotion ?? "") })
      .then((r) => { setVerdict(r.verdict); if (r.finished) setOutcome(r.outcome); })
      .catch((e) => setErr(e.message));
    return true;
  };
  const finished = !!outcome;
  const complete = finished || s.state === "done";
  const advance = outcome ? outcome.status === "done" : s.state === "done";
  const passed = outcome?.passed ?? s.passed;

  return (
    <main className="coach session">
      <Link to={`/coach/${id}`} className="muted">← Back to plan</Link>
      <div className="sess-head">
        <div className="tl-node big">{s.day}</div>
        <div><h1>Day {s.day} · {title}</h1><div className="muted">{s.minutes} min · {TYPE_LABEL[s.type]} · {s.themeLabel}</div></div>
        <div className="langslot"><LangTabs /><VoiceToggle />{plainState === "loading" && <span className="muted small">Simplifying…</span>}</div>
      </div>
      <div className="goalbar">🎯 <b>Outcome:</b> {s.goal}{s.attempts > 0 && s.state !== "done" ? <span className="muted"> · attempt {s.attempts}</span> : null}</div>
      {err && <div className="error">{err}</div>}

      {s.state === "paywall" && <Paywall playerId={v.playerId} price={v.access.priceInr} onPaid={() => load()} />}
      {s.state === "locked" && <section className="card"><b>Locked.</b> Reach the Day {s.day - 1} milestone first.</section>}

      <section className="card lesson">
        <div className="row between"><h2>1 · Learn: {lesson.headline}</h2><ListenButton id="lesson" label="Listen to the lesson" text={[lesson.headline, lesson.why, "Habits to build.", ...lesson.habits, "Before every move, ask.", ...lesson.beforeEveryMove].join(" ")} /></div>
        <p>{lesson.why}</p>
        <div className="two">
          <div><h3>Habits to build</h3><ul>{lesson.habits.map((h) => <li key={h}>{h}</li>)}</ul></div>
          <div><h3>Before every move, ask</h3><ul>{lesson.beforeEveryMove.map((h) => <li key={h}>{h}</li>)}</ul></div>
        </div>
        {detail && <div className="muted small">Coach note: {detail}</div>}
      </section>

      {(s.state === "available" || s.state === "retry") && !finished && s.type !== "play" && (
        <section className="card">
          <h2>2 · Practise</h2>
          <p className="muted">Positions come from your own games. {s.state === "retry" ? "The ones you missed come first." : ""}</p>
          <button className="primary" disabled={busy} onClick={() => start()}>{s.state === "retry" ? "Try again" : "Start exercise"}</button>
        </section>
      )}

      {s.type !== "play" && s.state === "active" && !finished && v.question && (
        <section className="card trainer">
          <Chessboard id="sess" position={verdict && lang === "plain" && verdict.fen ? verdict.fen : fen} customSquareStyles={verdict ? {} : highlightStyles(hl)} customArrows={arrowsFor(verdict, lang) as any} boardWidth={420} boardOrientation={v.question.turn === "w" ? "white" : "black"} arePiecesDraggable={!verdict} onPieceDrop={(f, t) => drop(f, t)} />
          <div className="drillside">
            <h2>2 · Find the better move</h2>
            <div className="dots">{Array.from({ length: v.progress.total }, (_, i) => <span key={i} className={`dot ${v.progress.results[i] ?? (i === v.progress.answered ? "now" : "")}`} />)}</div>
            <p>{v.question.turn === "w" ? "White" : "Black"} to move. This position is from <b>your own game</b>.</p>
            {!verdict && v.question && <HintBox resetKey={v.question.id} onHighlight={setHl} fetchHint={(n) => api<Hint>(`/coach/session-questions/${v.question!.id}/hint`, { n })} />}
            {verdict && (
              <div className={`verdict ${verdict.pass ? "pass" : "fail"}`}>
                <b>{verdict.pass ? "Correct" : "Not quite"}</b>{verdict.hintsUsed > 0 && <span className="muted small"> · used {verdict.hintsUsed} hint{verdict.hintsUsed > 1 ? "s" : ""}</span>}
                <VerdictBody v={verdict} />
                <button className="primary" onClick={() => { setVerdict(null); setHl(null); load(); }}>Next position</button>
              </div>
            )}
          </div>
        </section>
      )}
      {finished && verdict && (
        <section className="card">
          <div className={`verdict ${verdict.pass ? "pass" : "fail"}`}>
            <b>{verdict.pass ? "Correct" : "Not quite"}</b>
            <VerdictBody v={verdict} />
          </div>
        </section>
      )}

      {s.type === "play" && (s.state === "available" || s.state === "retry") && (
        <section className="card">
          <h2>2 · Practise: play a game</h2>
          <p>Play one game against the Stockfish bot (15+10). Use the safety checks above on every move. When it ends, the coach counts your blunders and the coach decides what happens next.</p>
          <button className="primary" disabled={busy} onClick={() => start()}>{busy ? "Setting up…" : "Start practice game"}</button>
        </section>
      )}
      {s.type === "play" && s.state === "active" && (
        <section className="card">
          <h2>2 · Practise: your game</h2>
          <p className="muted">Waiting for the game to finish and be analysed. This page updates by itself.</p>
          <div className="row">
            <button className="primary" onClick={() => nav(`/g/${s.game_code}`)}>Resume game</button>
            <button disabled={busy} onClick={() => start(true)}>Start a new game instead</button>
          </div>
        </section>
      )}

      {complete && (
        <section className={`card milestone ${passed ? "ok" : "support"}`}>
          <h2>{passed ? "🏁 Milestone reached" : outcome?.status === "retry" ? "Not yet, try once more" : "Completed with support"}</h2>
          <p>{outcome?.result ?? (s.type === "play" ? `${s.score} blunder(s)` : `${s.score}/${s.total} correct`)}</p>
          {outcome?.decision && <div className="coachsays"><b>Coach:</b> {outcome.decision}</div>}
          <div className="row">
            {outcome?.status === "retry" && <button className="primary" onClick={() => { setOutcome(null); setVerdict(null); load(); }}>Try again</button>}
            {advance && v.nextSessionId && <button className="primary" onClick={() => nav(`/coach/${id}/day/${v.nextSessionId}`)}>Continue to Day {v.nextDay}</button>}
            {advance && v.isLast && <button className="primary" onClick={() => nav(`/coach/${id}`)}>See your new plan</button>}
            <button onClick={() => nav(`/coach/${id}`)}>Back to plan</button>
          </div>
        </section>
      )}
    </main>
  );
}
