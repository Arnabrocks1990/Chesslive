import { ReactNode, createContext, useContext, useEffect, useState } from "react";
import { api } from "./api";
import { ListenButton, useVoice } from "./voice";

// Standard = chess notation and square names. Plain = simple words, with the move shown on the board instead.
export type Lang = "standard" | "plain";
const KEY = "coach.lang";
const Ctx = createContext<{ lang: Lang; setLang: (l: Lang) => void }>({ lang: "standard", setLang: () => {} });
export const useLang = () => useContext(Ctx);

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setL] = useState<Lang>(() => (localStorage.getItem(KEY) === "plain" ? "plain" : "standard"));
  const setLang = (l: Lang) => { localStorage.setItem(KEY, l); setL(l); };
  return <Ctx.Provider value={{ lang, setLang }}>{children}</Ctx.Provider>;
}

/** Suggestive tab: standard is the default, Plain English is offered as the simpler alternative. */
export function LangTabs() {
  const { lang, setLang } = useLang();
  return (
    <div className="langtabs" role="tablist" aria-label="Language">
      <button role="tab" aria-selected={lang === "standard"} className={lang === "standard" ? "on" : ""} onClick={() => setLang("standard")}>Standard</button>
      <button role="tab" aria-selected={lang === "plain"} className={lang === "plain" ? "on" : ""} onClick={() => setLang("plain")} title="Simple words instead of chess notation">
        Plain English {lang !== "plain" && <em>simpler ✦</em>}
      </button>
    </div>
  );
}

/** Player-facing text calls the engine "the coach". */
export const coachify = (t: string | null | undefined) =>
  String(t ?? "").replace(/(^|[.!?]\s+)Stockfish(?:'s)?/g, (_m, p) => `${p}The coach`).replace(/Stockfish(?:'s)?/g, "the coach");

// ---- hints ---------------------------------------------------------------------------

export interface Hint { n: number; std: string; plain: string; highlight: { from: string | null; to: string | null } | null }

export const highlightStyles = (h: Hint["highlight"] | null) => {
  const out: Record<string, React.CSSProperties> = {};
  if (h?.from) out[h.from] = { background: "rgba(255, 200, 0, 0.6)" };
  if (h?.to) out[h.to] = { background: "rgba(80, 200, 120, 0.65)" };
  return out;
};

/** Three hints, each revealed only when the player clicks for it. */
export function HintBox({ fetchHint, resetKey, onHighlight }: { fetchHint: (n: number) => Promise<Hint>; resetKey: unknown; onHighlight: (h: Hint["highlight"] | null) => void }) {
  const { lang } = useLang();
  const { speak } = useVoice();
  const [hints, setHints] = useState<Hint[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => { setHints([]); setErr(""); onHighlight(null); }, [resetKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const reveal = async () => {
    setBusy(true); setErr("");
    try {
      const h = await fetchHint(hints.length + 1);
      setHints((x) => [...x, h]);
      onHighlight(h.highlight);
      speak(lang === "plain" ? h.plain : h.std, { id: `hint-${h.n}` });
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <div className="hints">
      {hints.map((h) => <div key={h.n} className="hint"><b>Hint {h.n}</b> {lang === "plain" ? h.plain : h.std} <ListenButton id={`hint-${h.n}`} text={lang === "plain" ? h.plain : h.std} label="Replay" /></div>)}
      {hints.length < 3 && <button disabled={busy} onClick={reveal}>💡 {hints.length === 0 ? "Need a hint?" : `Another hint (${hints.length + 1} of 3)`}</button>}
      {err && <div className="error">{err}</div>}
    </div>
  );
}

// ---- verdict ---------------------------------------------------------------------------

export interface Extras {
  plainWhy?: string; plainBest?: string; plainPlayed?: string | null;
  arrows?: { best: [string, string] | null; played: [string, string] | null };
}

export const arrowsFor = (v: Extras | null | undefined, lang: Lang): [string, string, string][] =>
  lang === "plain" && v?.arrows
    ? [...(v.arrows.best ? [[...v.arrows.best, "rgb(60,170,90)"] as [string, string, string]] : []), ...(v.arrows.played ? [[...v.arrows.played, "rgb(200,70,70)"] as [string, string, string]] : [])]
    : [];

/** What the coach says out loud after an answer, in the language the player picked. */
export function verdictSpeech(v: any, lang: Lang): string {
  const head = v.pass ? "Correct." : "Not quite.";
  if (lang === "plain") return `${head} The coach move: ${v.plainBest ?? "see the arrows on the board"}. ${!v.pass && v.plainPlayed ? `In the game, ${v.plainPlayed}.` : ""} ${v.plainWhy ?? ""}`;
  return `${head} The coach move is ${v.bestSan}. ${!v.pass ? `In the game you played ${v.youPlayedInGame}.` : ""} ${coachify(v.explanation)}`;
}

export function VerdictBody({ v }: { v: any }) {
  const { lang } = useLang();
  return lang === "plain" ? (
    <>
      <div>Coach move: <b>{v.plainBest ?? "see the board"}</b></div>
      {!v.pass && v.plainPlayed && <div className="muted">In the game, {v.plainPlayed}.</div>}
      {v.plainWhy && <div className="explain">{v.plainWhy}</div>}
      <div className="muted small">On the board: green arrow = coach move{v.arrows?.played ? ", red arrow = your move in the game" : ""}.</div>
      <ListenButton id="verdict" text={verdictSpeech(v, "plain")} label="Hear it again" />
    </>
  ) : (
    <>
      <div>Coach move: <b>{v.bestSan}</b>{v.pv ? <span className="muted"> · {v.pv}</span> : null}</div>
      {!v.pass && v.youPlayedInGame && <div className="muted">In the game you played {v.youPlayedInGame}.</div>}
      {v.explanation && <div className="explain">{coachify(v.explanation)}</div>}
    </>
  );
}

// ---- plain-English plan text (one cached AI rewrite) -------------------------------------------

export interface PlainData { diagnosis: string; rationale?: string; sessions: Record<string, { title: string; detail: string }> }

export function usePlain(playerId: number | null, enabled: boolean, hasPlan: boolean) {
  const [data, setData] = useState<PlainData | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const [error, setError] = useState("");
  useEffect(() => {
    if (!enabled || !playerId || !hasPlan) return;
    let stop = false;
    setState("loading"); setError("");
    api<PlainData>(`/coach/players/${playerId}/plain`, {})
      .then((d) => { if (!stop) { setData(d); setState("idle"); } })
      .catch((e) => { if (!stop) { setData(null); setState("error"); setError(e.message); } });
    return () => { stop = true; };
  }, [enabled, playerId, hasPlan]);
  return { plain: enabled ? data : null, state, error };
}
