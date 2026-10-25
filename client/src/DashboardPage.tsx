import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "./api";

interface Dash {
  rating: number; ratedGames: number; ratingDelta: number;
  record: { games: number; wins: number; losses: number; draws: number; winRate: number | null; white: { g: number; w: number }; black: { g: number; w: number }; vsBot: { g: number; w: number }; vsHuman: { g: number; w: number } };
  ratingHistory: { at: string; rating: number }[];
  quality: { analysed: number; accuracy: number | null; blunders: number; mistakes: number; inaccuracies: number; perGame: { code: string; accuracy: number; blunders: number; result: string }[]; phases: Record<string, number>; themes: { key: string; label: string; count: number }[] };
  puzzles: { total: number; solved: number; solvedClean: number; revealed: number; hints: number };
  insights: { tone: "good" | "warn" | "tip"; text: string }[];
  recommendation: { level: "strong" | "suggested" | "none"; headline: string; reasons: string[]; pitch: string; hasCoach: boolean; isPro: boolean };
}

const ICON = { good: "✅", warn: "⚠️", tip: "💡" } as const;

function Spark({ points }: { points: number[] }) {
  if (points.length < 2) return <p className="muted small">Your rating chart appears after two rated games.</p>;
  const w = 320, h = 70, min = Math.min(...points), max = Math.max(...points), span = Math.max(1, max - min);
  const xy = points.map((p, i) => [(i / (points.length - 1)) * (w - 8) + 4, h - 6 - ((p - min) / span) * (h - 12)]);
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="spark" role="img" aria-label={`Rating from ${points[0]} to ${points[points.length - 1]}`}>
      <polyline points={xy.map((p) => p.join(",")).join(" ")} fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx={xy[xy.length - 1][0]} cy={xy[xy.length - 1][1]} r="3.5" fill="currentColor" />
    </svg>
  );
}

function Bars({ items, max }: { items: { label: string; value: number; tone?: string }[]; max?: number }) {
  const m = max ?? Math.max(1, ...items.map((i) => i.value));
  return (
    <div className="bars">
      {items.map((i) => (
        <div key={i.label} className="barrow"><span>{i.label}</span><div className="bar"><span className={i.tone} style={{ width: `${(i.value / m) * 100}%` }} /></div><b>{i.value}</b></div>
      ))}
    </div>
  );
}

export default function DashboardPage() {
  const [d, setD] = useState<Dash | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => { api<Dash>("/improve/dashboard").then(setD).catch((e) => setErr(e.message)); }, []);
  if (!d) return <main className="improve"><p className={err ? "error" : "muted"}>{err || "Crunching your games…"}</p></main>;
  const { record: r, quality: q, recommendation: rec } = d;
  const pct = (a: { g: number; w: number }) => (a.g ? `${Math.round((a.w / a.g) * 100)}%` : "–");
  return (
    <main className="improve dash">
      <div className="row between">
        <h1>📊 My performance</h1>
        <Link to="/improve" className="link">🧩 Improve your Game</Link>
      </div>

      <section className={`card coachrec ${rec.level}`}>
        <h2>{rec.level === "strong" ? "🎯 " : rec.level === "suggested" ? "✦ " : ""}{rec.headline}</h2>
        {rec.reasons.length > 0 && <p>Why: {rec.reasons.join(", ")}.</p>}
        <p className="muted">{rec.pitch}</p>
        {rec.isPro
          ? <Link to="/coach" className="btn primary">Open your coach</Link>
          : <Link to="/coach" className={`btn ${rec.level === "none" ? "" : "primary"}`}>{rec.hasCoach ? "Continue with the AI Coach" : "Try the AI Coach"}</Link>}
      </section>

      <div className="statgrid">
        <div className="card stat"><span className="muted small">Rating</span><b>{d.rating}</b><span className={d.ratingDelta >= 0 ? "up" : "down"}>{d.ratingHistory.length > 1 ? `${d.ratingDelta >= 0 ? "+" : ""}${d.ratingDelta} recently` : `${d.ratedGames} rated game${d.ratedGames === 1 ? "" : "s"}`}</span></div>
        <div className="card stat"><span className="muted small">Record</span><b>{r.wins}W · {r.draws}D · {r.losses}L</b><span className="muted small">{r.games} game{r.games === 1 ? "" : "s"}{r.winRate !== null ? ` · ${r.winRate}% wins` : ""}</span></div>
        <div className="card stat"><span className="muted small">Accuracy</span><b>{q.accuracy !== null ? `${q.accuracy}%` : "–"}</b><span className="muted small">{q.analysed ? `last ${q.analysed} analysed` : "no analysed games yet"}</span></div>
        <div className="card stat"><span className="muted small">Blunders / game</span><b>{q.analysed ? (q.blunders / q.analysed).toFixed(1) : "–"}</b><span className="muted small">{q.mistakes} mistakes · {q.inaccuracies} slips</span></div>
      </div>

      <section className="card">
        <h2>What we noticed</h2>
        <ul className="insights">
          {d.insights.map((i, k) => <li key={k} className={i.tone}><span>{ICON[i.tone]}</span><span>{i.text}</span></li>)}
        </ul>
      </section>

      <div className="two">
        <section className="card">
          <h2>Rating</h2>
          <Spark points={d.ratingHistory.map((h) => h.rating)} />
        </section>
        <section className="card">
          <h2>Results by situation</h2>
          <Bars max={100} items={[
            { label: "As White", value: r.white.g ? Math.round((r.white.w / r.white.g) * 100) : 0 },
            { label: "As Black", value: r.black.g ? Math.round((r.black.w / r.black.g) * 100) : 0 },
            { label: "Vs Coach", value: r.vsBot.g ? Math.round((r.vsBot.w / r.vsBot.g) * 100) : 0 },
            { label: "Vs players", value: r.vsHuman.g ? Math.round((r.vsHuman.w / r.vsHuman.g) * 100) : 0 },
          ]} />
          <p className="muted small">Win rate in % · White {pct(r.white)}, Black {pct(r.black)}</p>
        </section>
      </div>

      {q.analysed > 0 && (
        <div className="two">
          <section className="card">
            <h2>Where the costly mistakes happen</h2>
            <Bars items={[{ label: "Opening", value: q.phases.opening, tone: "warn" }, { label: "Middlegame", value: q.phases.middlegame, tone: "warn" }, { label: "Endgame", value: q.phases.endgame, tone: "warn" }]} />
            <h3>Habits to fix</h3>
            {q.themes.length === 0 ? <p className="muted small">No repeated pattern yet.</p> : <Bars items={q.themes.slice(0, 5).map((t) => ({ label: t.label, value: t.count, tone: "warn" }))} />}
          </section>
          <section className="card">
            <h2>Accuracy, game by game</h2>
            <div className="gamebars">
              {q.perGame.map((g) => (
                <Link key={g.code} to={`/g/${g.code}`} title={`${g.result} · ${g.accuracy}% · ${g.blunders} blunder(s)`} className={g.result}>
                  <span style={{ height: `${Math.max(4, g.accuracy)}%` }} />
                </Link>
              ))}
            </div>
            <p className="muted small">Oldest to newest. Green = win, red = loss. Click a bar to review the game.</p>
          </section>
        </div>
      )}

      <section className="card">
        <h2>Puzzle practice</h2>
        <p>{d.puzzles.total ? `${d.puzzles.solved} solved of ${d.puzzles.total} · ${d.puzzles.solvedClean} without a hint · ${d.puzzles.hints} hint${d.puzzles.hints === 1 ? "" : "s"} used` : "You have not tried a puzzle yet."}</p>
        <Link to="/improve" className="btn primary">{d.puzzles.total ? "Keep practising" : "Start your first puzzle"}</Link>
      </section>
    </main>
  );
}
