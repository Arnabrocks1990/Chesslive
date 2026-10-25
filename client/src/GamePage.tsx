import { Chess } from "chess.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Chessboard } from "react-chessboard";
import { useParams } from "react-router-dom";
import type { Socket } from "socket.io-client";
import { GameState, Suggestion, api, connectSocket } from "./api";
import { useAuth } from "./App";
import { modeOf } from "./timeMode";

const fmtClock = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const fmtEval = (cp: number, mate: number | null) =>
  mate !== null && mate !== undefined ? `M${Math.abs(mate)}` : `${cp > 0 ? "+" : ""}${(cp / 100).toFixed(2)}`;

const REASONS: Record<string, string> = {
  checkmate: "by checkmate", resignation: "by resignation", timeout: "on time",
  agreement: "by agreement", stalemate: "by stalemate", repetition: "by repetition",
};

export default function GamePage() {
  const { code = "" } = useParams();
  const { user } = useAuth();
  const [game, setGame] = useState<GameState | null>(null);
  const [fen, setFen] = useState("start");
  const [error, setError] = useState("");
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [chat, setChat] = useState<{ user: string; text: string }[]>([]);
  const [chatText, setChatText] = useState("");
  const [botLevel, setBotLevel] = useState("medium");
  const [, tick] = useState(0);
  const [bw, setBw] = useState(560);
  const socket = useRef<Socket | null>(null);
  const skew = useRef(0);

  useEffect(() => {
    const s = connectSocket();
    socket.current = s;
    s.on("connect", () => s.emit("join", code, (r: { ok: boolean; error?: string }) => !r.ok && setError(r.error || "Could not join")));
    s.on("state", (g: GameState) => {
      skew.current = Date.now() - g.clock.serverNow;
      setGame(g);
      setFen(g.fen);
    });
    s.on("suggestion", (r: Suggestion) => setSuggestion(r));
    s.on("chat", (m) => setChat((c) => [...c.slice(-99), m]));
    return () => void s.disconnect();
  }, [code]);

  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 200);
    const resize = () => setBw(Math.max(280, Math.min(620, window.innerWidth - 32, window.innerHeight - 190)));
    resize();
    window.addEventListener("resize", resize);
    return () => {
      clearInterval(id);
      window.removeEventListener("resize", resize);
    };
  }, []);

  const mySide = game?.white?.id === user.id ? "w" : game?.black?.id === user.id ? "b" : null;
  const orientation = mySide === "b" ? "black" : "white";
  const isAdmin = user.role === "admin";

  const send = useCallback(
    (from: string, to: string, promotion?: string) => {
      if (!game || game.status !== "active" || game.turn !== mySide) return false;
      const local = new Chess(game.fen);
      try {
        local.move({ from, to, promotion });
      } catch {
        return false;
      }
      setFen(local.fen()); // optimistic; the server's state event is authoritative
      socket.current?.emit("move", { code, from, to, promotion }, (r: { ok: boolean; error?: string }) => {
        if (!r.ok) {
          setError(r.error || "Move rejected");
          setFen(game.fen);
        }
      });
      return true;
    },
    [game, mySide, code]
  );

  const clockOf = (c: "w" | "b") => {
    if (!game) return 0;
    const base = game.clock[c];
    return game.clock.running === c ? base - (Date.now() - skew.current - game.clock.serverNow) : base;
  };

  const arrows = useMemo(() => {
    if (!isAdmin || !suggestion || !game || suggestion.fen !== game.fen || game.status !== "active") return [];
    const colors = ["rgb(46,204,113)", "rgb(241,196,15)", "rgb(230,126,34)"];
    return suggestion.top_moves.map((m, i) => [m.uci.slice(0, 2), m.uci.slice(2, 4), colors[i]] as [string, string, string]);
  }, [isAdmin, suggestion, game]);

  if (error && !game) return <div className="center"><div className="card error">{error}</div></div>;
  if (!game) return <div className="center muted">Connecting…</div>;

  const top = orientation === "white" ? "b" : "w";
  const bottom = orientation === "white" ? "w" : "b";
  const nameOf = (c: "w" | "b") => {
    const seat = c === "w" ? game.white : game.black;
    return seat ? `${seat.name}${seat.rating ? ` (${seat.rating})` : ""}` : "Waiting for opponent…";
  };
  const fmtChange = (d: number | null | undefined) => (d === null || d === undefined ? "Coach (unrated)" : d > 0 ? `+${d}` : d < 0 ? `−${-d}` : "±0");
  const inviteLink = `${location.origin}/g/${code}`;
  const squareStyles: Record<string, object> = {};
  if (game.lastMove) {
    squareStyles[game.lastMove.from] = { background: "rgba(255,213,0,.35)" };
    squareStyles[game.lastMove.to] = { background: "rgba(255,213,0,.45)" };
  }

  const bar = (c: "w" | "b") => (
    <div className={`player ${game.clock.running === c ? "running" : ""}`}>
      <span>{c === "w" ? "⬜" : "⬛"} {nameOf(c)}</span>
      <span className="clock">{fmtClock(clockOf(c))}</span>
    </div>
  );

  const outcome =
    game.status === "finished"
      ? game.result === "1/2-1/2"
        ? `Draw ${REASONS[game.termination ?? ""] ?? ""}`
        : `${game.result === "1-0" ? "White" : "Black"} wins ${REASONS[game.termination ?? ""] ?? ""}`
      : null;

  const rows: [string, string?][] = [];
  game.moves.forEach((m, i) => (i % 2 === 0 ? rows.push([m.san]) : (rows[rows.length - 1][1] = m.san)));

  return (
    <main className="game">
      <section className="boardcol">
        {game.timeControl && <div className="modebadge">{modeOf(game.timeControl.baseMs / 1000, game.timeControl.incMs / 1000).label} · {game.timeControl.baseMs / 60000}+{game.timeControl.incMs / 1000}</div>}
        {bar(top)}
        <div style={{ width: bw }}>
          <Chessboard
            id="board"
            position={fen}
            boardWidth={bw}
            boardOrientation={orientation}
            arePiecesDraggable={game.status === "active" && game.turn === mySide}
            onPieceDrop={(from, to, piece) => {
              const promo = piece[1] === "P" && (to[1] === "8" || to[1] === "1");
              return promo ? false : send(from, to);
            }}
            onPromotionCheck={(from, to, piece) => piece[1] === "P" && (to[1] === "8" || to[1] === "1") && game.turn === mySide}
            onPromotionPieceSelect={(piece, from, to) => {
              if (!piece || !from || !to) return false;
              return send(from, to, piece[1].toLowerCase());
            }}
            customArrows={arrows as any}
            customSquareStyles={squareStyles}
            customDarkSquareStyle={{ backgroundColor: "#6b8e5a" }}
            customLightSquareStyle={{ backgroundColor: "#eeeed2" }}
          />
        </div>
        {bar(bottom)}
        {error && <div className="error" onClick={() => setError("")}>{error}</div>}
      </section>

      <aside className="side">
        {game.status === "waiting" && (
          <div className="card">
            <h3>Invite a player</h3>
            <p className="muted">Share this link. The game starts when they join.</p>
            <div className="row">
              <input readOnly value={inviteLink} onFocus={(e) => e.target.select()} />
              <button className="primary" onClick={() => navigator.clipboard?.writeText(inviteLink)}>Copy</button>
            </div>
            {mySide && (
              <div className="botbox">
                <p className="muted">No opponent? Play Coach instead.</p>
                <div className="row">
                  <select value={botLevel} onChange={(e) => setBotLevel(e.target.value)}>
                    <option value="easy">Easy (~1400)</option>
                    <option value="medium">Medium (~1800)</option>
                    <option value="hard">Hard (~2300)</option>
                    <option value="max">Maximum</option>
                  </select>
                  <button
                    className="primary"
                    onClick={() =>
                      socket.current?.emit("playBot", { code, level: botLevel }, (r: { ok: boolean; error?: string }) => !r.ok && setError(r.error || "Could not start the game vs Coach"))
                    }
                  >
                    Play bot
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {outcome && (
          <div className="card outcome">
            {outcome}
            <div className="muted small">
              {game.ratingChange
                ? `Elo: ${game.white?.name} ${fmtChange(game.ratingChange.white)} · ${game.black?.name} ${fmtChange(game.ratingChange.black)}`
                : "Unrated (fewer than 4 moves)"}
            </div>
          </div>
        )}

        {isAdmin && game.status === "active" && <AssistPanel s={suggestion} game={game} />}

        <div className="card moves">
          <h3>Moves</h3>
          <ol>
            {rows.map((r, i) => (
              <li key={i}><b>{i + 1}.</b> {r[0]} {r[1]}</li>
            ))}
          </ol>
          {game.status === "active" && mySide && (
            <div className="row">
              {!game.vsBot && <button onClick={() => socket.current?.emit("draw", { code, action: "offer" })}>Offer draw</button>}
              <button className="danger" onClick={() => confirm("Resign this game?") && socket.current?.emit("resign", code)}>Resign</button>
            </div>
          )}
          {game.status === "active" && game.drawOffer && game.drawOffer !== mySide && mySide && (
            <div className="row">
              <span>Draw offered</span>
              <button className="primary" onClick={() => socket.current?.emit("draw", { code, action: "accept" })}>Accept</button>
              <button onClick={() => socket.current?.emit("draw", { code, action: "decline" })}>Decline</button>
            </div>
          )}
          {game.status === "finished" && <a className="link" href={`/api/games/${code}/pgn`}>Download PGN</a>}
        </div>

        {game.status === "finished" && <Report code={code} />}

        <div className="card chat">
          <h3>Chat</h3>
          <div className="log">{chat.map((m, i) => <div key={i}><b>{m.user}:</b> {m.text}</div>)}</div>
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              if (chatText.trim()) socket.current?.emit("chat", { code, text: chatText });
              setChatText("");
            }}
          >
            <input value={chatText} onChange={(e) => setChatText(e.target.value)} placeholder="Say something…" />
          </form>
        </div>
      </aside>
    </main>
  );
}

function AssistPanel({ s, game }: { s: Suggestion | null; game: GameState }) {
  const fresh = s && s.fen === game.fen;
  const results = (s?.similar ?? []).filter((x) => x.result);
  const tally = (r: string) => results.filter((x) => x.result === r).length;
  return (
    <div className="card assist">
      <h3>AI assist <em className="badge">admin only</em></h3>
      {!fresh ? (
        <p className="muted">Analysing position…</p>
      ) : (
        <>
          <p className="muted">Best for {game.turn === "w" ? "White" : "Black"} · eval {fmtEval(s.eval_cp, s.mate)}</p>
          <ol>
            {s.top_moves.map((m, i) => (
              <li key={m.uci} className={i === 0 ? "best" : ""}>
                <b>{m.san}</b> <span className="muted">{fmtEval(m.eval_cp, m.mate)}</span>
                <div className="pv">{m.pv}</div>
              </li>
            ))}
          </ol>
          {s.explanation && <p className="explain">{s.explanation}</p>}
          {typeof s.learned_win_prob === "number" && (
            <p className="muted">Learned model (trained on our games): White win chance {Math.round(s.learned_win_prob * 100)}%</p>
          )}
          {results.length > 0 && (
            <p className="muted">
              Similar past positions: {tally("1-0")} White wins · {tally("0-1")} Black wins · {tally("1/2-1/2")} draws
            </p>
          )}
        </>
      )}
    </div>
  );
}

interface ReportData {
  ready: boolean;
  progress: { done: number; total: number };
  white: Summary;
  black: Summary;
  moves: { ply: number; san: string; label: string; best: string | null; color: string }[];
}
interface Summary { accuracy: number | null; blunders: number; mistakes: number; inaccuracies: number }

function Report({ code }: { code: string }) {
  const [r, setR] = useState<ReportData | null>(null);
  useEffect(() => {
    let stop = false;
    const load = async () => {
      try {
        const data = await api<ReportData>(`/games/${code}/report`);
        if (stop) return;
        setR(data);
        if (!data.ready) setTimeout(load, 2500);
      } catch {
        if (!stop) setTimeout(load, 2500);
      }
    };
    load();
    return () => void (stop = true);
  }, [code]);

  if (!r) return <div className="card"><h3>Game report</h3><p className="muted">Preparing…</p></div>;
  const line = (label: string, s: Summary) => (
    <tr><td>{label}</td><td>{s.accuracy ?? "–"}%</td><td>{s.inaccuracies}</td><td>{s.mistakes}</td><td>{s.blunders}</td></tr>
  );
  const notable = r.moves.filter((m) => m.label);
  return (
    <div className="card report">
      <h3>Game report</h3>
      {!r.ready && <p className="muted">Analysing… {r.progress.done}/{r.progress.total}</p>}
      <table>
        <thead><tr><th></th><th>Accuracy</th><th>Inacc.</th><th>Mistakes</th><th>Blunders</th></tr></thead>
        <tbody>{line("White", r.white)}{line("Black", r.black)}</tbody>
      </table>
      {r.ready && notable.length > 0 && (
        <ul className="notable">
          {notable.map((m) => (
            <li key={m.ply}>
              {Math.ceil(m.ply / 2)}{m.color === "white" ? "." : "…"} {m.san} <span className={`tag ${m.label}`}>{m.label}</span>
              {m.best && <span className="muted"> best: {m.best}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
