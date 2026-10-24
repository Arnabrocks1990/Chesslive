import { FormEvent, ReactNode, createContext, useContext, useEffect, useState } from "react";
import { Link, NavLink, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { User, api, getToken, setToken } from "./api";
import GamePage from "./GamePage";
import ProfilePage from "./ProfilePage";
import { CoachHome, CoachPlayer, CoachShare } from "./CoachPage";
import { CoachSession } from "./CoachSession";
import CoachWidget from "./CoachWidget";
import { LangProvider } from "./lang";
import { VoiceProvider } from "./voice";
import { MODES, modeOf, tcLabel } from "./timeMode";
import { LearnHome, LearnerMe, LessonPlayer, XpBar } from "./LearnPage";

interface AuthCtx { user: User; logout: () => void }
const Auth = createContext<AuthCtx>(null as unknown as AuthCtx);
export const useAuth = () => useContext(Auth);

function AuthForm({ onDone }: { onDone: (u: User) => void }) {
  const [mode, setMode] = useState<"login" | "register" | "guest">("guest");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const body = mode === "guest" ? { name: username } : { username, password };
      const s = await api<{ token: string; user: User }>(mode === "guest" ? "/guest" : "/" + mode, body);
      setToken(s.token);
      onDone(s.user);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="center">
      <form className="card auth" onSubmit={submit}>
        <h1>♞ Chess Live</h1>
        <div className="tabs">
          {(["guest", "login", "register"] as const).map((m) => (
            <button type="button" key={m} className={mode === m ? "active" : ""} onClick={() => setMode(m)}>
              {m === "guest" ? "Guest" : m === "login" ? "Sign in" : "Register"}
            </button>
          ))}
        </div>
        <input
          placeholder={mode === "guest" ? "Display name (optional)" : "Username"}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoFocus
        />
        {mode !== "guest" && (
          <input type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} />
        )}
        {error && <div className="error">{error}</div>}
        <button className="primary" disabled={busy}>
          {mode === "guest" ? "Play as guest" : mode === "login" ? "Sign in" : "Create account"}
        </button>
      </form>
    </div>
  );
}

/** Admin only: registered-user count + pending payments, linking to the admin dashboard in a new tab. */
function AdminLink() {
  const [t, setT] = useState<{ users: number; games: number; pending_payments: number; revenue_inr: number } | null>(null);
  useEffect(() => {
    const load = () => api<{ totals: any }>("/admin/overview").then((r) => setT(r.totals)).catch(() => {});
    load();
    const id = setInterval(load, 30000);
    return () => clearInterval(id);
  }, []);
  return (
    <a href="/admin/" target="_blank" rel="noopener" className="coachlink" title={t ? `${t.users} registered users · ${t.games} games · ${t.pending_payments} payments awaiting review · ₹${t.revenue_inr.toLocaleString("en-IN")} confirmed` : "Admin dashboard"}>
      🛡 Admin{t ? ` · ${t.users} users` : ""}{t && t.pending_payments > 0 ? ` · ${t.pending_payments} pending` : ""}
    </a>
  );
}

function Shell({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [checked, setChecked] = useState(false);
  const [rating, setRating] = useState<number | null>(null);
  const location = useLocation();

  useEffect(() => {
    if (!getToken()) return setChecked(true);
    api<{ user: User; rating: number }>("/me")
      .then((r) => {
        setUser(r.user);
        setRating(r.rating);
      })
      .catch(() => setToken(null))
      .finally(() => setChecked(true));
  }, [user === null, location.pathname]); // refresh the rating after games

  if (!checked) return null;
  if (!user) return <AuthForm onDone={setUser} />;
  const logout = () => {
    setToken(null);
    setUser(null);
  };
  return (
    <Auth.Provider value={{ user, logout }}>
      <header className="topbar">
        <nav className="topnav">
          <Link to="/" className="brand">♞ Chess Live</Link>
          <NavLink to="/" end>Play</NavLink>
          <NavLink to="/learn" className="learnlink">🎓 Learn</NavLink>
          <NavLink to="/coach" className="coachlink">✦ AI Coach</NavLink>
          {user.role === "admin" && <AdminLink />}
        </nav>
        <span className="who">
          <Link to={`/u/${encodeURIComponent(user.username)}`} className="link">{user.username}</Link>
          {rating !== null && <span className="muted"> ({rating})</span>}
          {user.role === "admin" && <em className="badge">admin</em>}
          <button className="link" onClick={logout}>Sign out</button>
        </span>
      </header>
      {children}
      <CoachWidget />
    </Auth.Provider>
  );
}

interface GameRow {
  code: string; status: string; result: string | null; white: string | null; black: string | null;
  time_control_sec: number; increment_sec: number;
}

function Lobby() {
  const nav = useNavigate();
  const [color, setColor] = useState("random");
  const [minutes, setMinutes] = useState(10);
  const [increment, setIncrement] = useState(0);
  const [custom, setCustom] = useState(false);
  const picked = modeOf(minutes * 60, increment);
  const [vsBot, setVsBot] = useState(false);
  const [level, setLevel] = useState("medium");
  const [code, setCode] = useState("");
  const [games, setGames] = useState<GameRow[]>([]);
  const [error, setError] = useState("");
  const [board, setBoard] = useState<{ username: string; rating: number; ratedGames: number; learner: { title: string; graduated: boolean } | null }[]>([]);
  const [lboard, setLboard] = useState<{ username: string; title: string; xp: number; lessons: number; total: number }[]>([]);
  const [tab, setTab] = useState<"players" | "learners">("players");
  const [me, setMe] = useState<LearnerMe | null>(null);

  useEffect(() => {
    api<GameRow[]>("/games/mine").then(setGames).catch(() => {});
    api<typeof board>("/leaderboard").then(setBoard).catch(() => {});
    api<typeof lboard>("/leaderboard/learners").then(setLboard).catch(() => {});
    api<LearnerMe>("/learn/me").then(setMe).catch(() => {});
  }, []);

  async function create() {
    try {
      const r = await api<{ code: string }>("/games", { color, minutes, increment, vsBot, level });
      nav(`/g/${r.code}`);
    } catch (e: any) {
      setError(e.message);
    }
  }

  return (
    <main className="lobby">
      {me && (
        <section className="card learnbanner">
          {me.lessonsDone === 0 && !me.mode ? (
            <>
              <div><h2>New to chess?</h2><p className="muted">Try Learner mode: short hands-on lessons that teach the rules from zero, then a gentle bot to practise on.</p></div>
              <button className="primary" onClick={() => nav("/learn")}>Start learning</button>
            </>
          ) : (
            <>
              <div><h2>🎓 Learner mode</h2><XpBar me={me} /><div className="muted small">{me.lessonsDone} of {me.totalLessons} lessons done</div></div>
              <button className="primary" onClick={() => nav("/learn")}>{me.graduated ? "Review lessons" : "Continue learning"}</button>
            </>
          )}
        </section>
      )}
      <section className="card">
        <h2>New game</h2>
        <label>Play as
          <select value={color} onChange={(e) => setColor(e.target.value)}>
            <option value="random">Random</option>
            <option value="white">White</option>
            <option value="black">Black</option>
          </select>
        </label>
        <div className="modes">
          <div className="muted small">Game mode</div>
          {MODES.map((m) => (
            <div key={m.key} className={`mode ${!custom && picked.key === m.key ? "on" : ""}`}>
              <div className="modehead"><b>{m.label}</b><span className="muted small">{m.blurb}</span></div>
              <div className="presets">
                {m.presets.map((p) => (
                  <button type="button" key={tcLabel(p.minutes, p.increment)}
                    className={!custom && minutes === p.minutes && increment === p.increment ? "active" : ""}
                    onClick={() => { setCustom(false); setMinutes(p.minutes); setIncrement(p.increment); }}>
                    {tcLabel(p.minutes, p.increment)}
                  </button>
                ))}
              </div>
            </div>
          ))}
          <button type="button" className={`customtoggle ${custom ? "active" : ""}`} onClick={() => setCustom((c) => !c)}>Custom time</button>
          {custom && (
            <div className="row">
              <label>Minutes per side<input type="number" min={1} max={180} value={minutes} onChange={(e) => setMinutes(+e.target.value)} /></label>
              <label>Increment (sec)<input type="number" min={0} max={60} value={increment} onChange={(e) => setIncrement(+e.target.value)} /></label>
            </div>
          )}
          <div className="muted small">Selected: <b>{picked.label}</b> · {tcLabel(minutes, increment)}</div>
        </div>
        <label className="check">
          <input type="checkbox" checked={vsBot} onChange={(e) => setVsBot(e.target.checked)} /> Play against the Stockfish bot
        </label>
        {vsBot && (
          <label>Bot strength
            <select value={level} onChange={(e) => setLevel(e.target.value)}>
              <option value="beginner">Beginner (for learners)</option>
              <option value="easy">Easy (~1400)</option>
              <option value="medium">Medium (~1800)</option>
              <option value="hard">Hard (~2300)</option>
              <option value="max">Maximum</option>
            </select>
          </label>
        )}
        <button className="primary" onClick={create}>{vsBot ? "Start game vs bot" : "Create game & get invite link"}</button>
        {error && <div className="error">{error}</div>}
      </section>

      <section className="card">
        <h2>Join with a code</h2>
        <div className="row">
          <input placeholder="Game code" value={code} onChange={(e) => setCode(e.target.value.trim())} />
          <button className="primary" disabled={!code} onClick={() => nav(`/g/${code}`)}>Join</button>
        </div>
        <h2 style={{ marginTop: 24 }}>My games</h2>
        {games.length === 0 && <p className="muted">No games yet.</p>}
        <ul className="games">
          {games.map((g) => (
            <li key={g.code}>
              <Link to={`/g/${g.code}`}>
                {g.white ?? "?"} vs {g.black ?? "waiting…"}
              </Link>
              <span className="muted">
                {modeOf(g.time_control_sec, g.increment_sec).label} {g.time_control_sec / 60}+{g.increment_sec} · {g.status === "finished" ? g.result : g.status}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h2>Leaderboard</h2>
        <div className="tabs">
          <button className={tab === "players" ? "active" : ""} onClick={() => setTab("players")}>Players</button>
          <button className={tab === "learners" ? "active" : ""} onClick={() => setTab("learners")}>🎓 Learners</button>
        </div>
        {tab === "players" ? (
          <>
            <p className="muted">Everyone starts at 1200 Elo.</p>
            {board.length === 0 && <p className="muted">No rated games yet.</p>}
            <ol className="board">
              {board.map((r) => (
                <li key={r.username}>
                  <Link to={`/u/${encodeURIComponent(r.username)}`}>{r.username}</Link>
                  {r.learner && <em className={`badge ${r.learner.graduated ? "grad" : ""}`}>🎓 {r.learner.title}</em>}
                  <b>{r.rating}</b>
                </li>
              ))}
            </ol>
          </>
        ) : (
          <>
            <p className="muted">New players ranked by what they have learned. Finish lessons and play the Beginner bot to earn XP.</p>
            {lboard.length === 0 && <p className="muted">No learners yet. <Link to="/learn">Start the first lesson.</Link></p>}
            <ol className="board">
              {lboard.map((r) => (
                <li key={r.username}>
                  <Link to={`/u/${encodeURIComponent(r.username)}`}>{r.username}</Link>
                  <em className={`badge ${r.title === "Graduate" ? "grad" : ""}`}>{r.title}</em>
                  <span className="muted small"> {r.lessons}/{r.total}</span>
                  <b>{r.xp} XP</b>
                </li>
              ))}
            </ol>
          </>
        )}
      </section>
    </main>
  );
}

export default function App() {
  return (
    <LangProvider>
    <VoiceProvider>
    <Routes>
      <Route path="/coach/share/:token" element={<CoachShare />} />
      <Route
        path="*"
        element={
          <Shell>
            <Routes>
              <Route path="/" element={<Lobby />} />
              <Route path="/g/:code" element={<GamePage />} />
              <Route path="/u/:username" element={<ProfilePage />} />
              <Route path="/learn" element={<LearnHome />} />
              <Route path="/learn/:key" element={<LessonPlayer />} />
              <Route path="/coach" element={<CoachHome />} />
              <Route path="/coach/:id" element={<CoachPlayer />} />
              <Route path="/coach/:id/day/:sid" element={<CoachSession />} />
            </Routes>
          </Shell>
        }
      />
    </Routes>
    </VoiceProvider>
    </LangProvider>
  );
}
