import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "./api";

interface Profile {
  username: string; role: string; rating: number; ratedGames: number; games: number; winRate: number | null;
  record: { wins: number; draws: number; losses: number };
  restricted?: boolean; analysedGames: number; avgAccuracy: number | null;
  blundersPer100Moves: number | null; mistakesPer100Moves: number | null;
  openings: { line: string; games: number; wins: number }[];
  recent: { code: string; white: string | null; black: string | null; result: string | null; vsBot: boolean }[];
}

export default function ProfilePage() {
  const { username = "" } = useParams();
  const [p, setP] = useState<Profile | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    setP(null);
    api<Profile>(`/profile/${encodeURIComponent(username)}`).then(setP).catch((e) => setError(e.message));
  }, [username]);

  if (error) return <div className="center"><div className="card error">{error}</div></div>;
  if (!p) return <div className="center muted">Loading…</div>;
  const stat = (label: string, v: string | number | null) => (
    <div className="card stat"><span className="muted">{label}</span><b>{v ?? "–"}</b></div>
  );
  return (
    <main className="profile">
      <h2>{p.username} {p.role === "admin" && <em className="badge">admin</em>}</h2>
      <div className="stats">
        {stat("Elo rating", p.rating)}
        {stat("Games", p.games)}
        {stat("W / D / L", `${p.record.wins} / ${p.record.draws} / ${p.record.losses}`)}
        {stat("Score", p.winRate === null ? null : `${p.winRate}%`)}
        {!p.restricted && stat("Avg accuracy", p.avgAccuracy === null ? null : `${p.avgAccuracy}%`)}
        {!p.restricted && stat("Blunders / 100 moves", p.blundersPer100Moves)}
        {!p.restricted && stat("Mistakes / 100 moves", p.mistakesPer100Moves)}
      </div>
      {p.restricted ? (
        <p className="muted">🔒 Play-quality analysis and openings are private to {p.username}.</p>
      ) : (
        <p className="muted">Accuracy and error rates use the {p.analysedGames} most recent fully analysed game(s).</p>
      )}
      {!p.restricted && <section className="card">
        <h3>Most played openings (first 4 plies)</h3>
        {p.openings.length === 0 && <p className="muted">No finished games yet.</p>}
        <ul className="games">
          {p.openings.map((o) => (
            <li key={o.line}><span>{o.line}</span><span className="muted">{o.games} game(s), {o.wins} won</span></li>
          ))}
        </ul>
      </section>}
      <section className="card">
        <h3>Recent games</h3>
        <ul className="games">
          {p.recent.map((g) => (
            <li key={g.code}>
              <Link to={`/g/${g.code}`}>{g.white} vs {g.black}</Link>
              <span className="muted">{g.result}{g.vsBot ? " · vs bot" : ""}</span>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
