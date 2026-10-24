import { ReactNode, createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { getToken } from "./api";

// Voiceover for the 7-day learning phase.
// 1) ElevenLabs audio, fetched through our server (the key never reaches the browser, and phrases are cached there).
// 2) If that is unavailable for any reason, the browser's own speech engine reads the text.
//    On Windows that is the built-in Microsoft voices, which is the fallback requested.

const KEY = "coach.voice";
type Engine = "elevenlabs" | "windows" | null;

interface VoiceCtx {
  enabled: boolean; setEnabled: (on: boolean) => void;
  speak: (text: string, opts?: { force?: boolean; id?: string }) => void;
  stop: () => void;
  speaking: string | null;   // id of what is being read, if anything
  engine: Engine;            // which voice was used last
}
const Ctx = createContext<VoiceCtx>({ enabled: false, setEnabled: () => {}, speak: () => {}, stop: () => {}, speaking: null, engine: null });
export const useVoice = () => useContext(Ctx);

/** Turns chess notation into words a voice can read ("Nd4" -> "knight to d4"). */
export function speakable(text: string): string {
  const piece: Record<string, string> = { K: "king", Q: "queen", R: "rook", B: "bishop", N: "knight" };
  return String(text ?? "")
    .replace(/\b\d+\.(\.\.)?\s*/g, "")                       // move numbers: "47." / "9..."
    .replace(/O-O-O/g, "castles queenside").replace(/O-O/g, "castles kingside")
    .replace(/\b([KQRBN])([a-h]?[1-8]?)(x?)([a-h][1-8])(=[QRBN])?([+#]?)/g, (_m, p, _d, cap, sq, promo, chk) =>
      `${piece[p]} ${cap ? "takes" : "to"} ${sq}${promo ? " promoting" : ""}${chk === "#" ? ", checkmate" : chk === "+" ? ", check" : ""}`)
    .replace(/\b([a-h])x([a-h][1-8])\b/g, "pawn takes $2")
    .replace(/\s+/g, " ").trim();
}

/** Splits long text into pieces the server will accept, breaking on sentence ends. */
export function chunks(text: string, max = 450): string[] {
  const out: string[] = [];
  let cur = "";
  for (const s of text.split(/(?<=[.!?])\s+/)) {
    if ((cur + " " + s).trim().length > max && cur) { out.push(cur.trim()); cur = s; } else cur = `${cur} ${s}`;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.flatMap((c) => (c.length > max ? c.match(new RegExp(`.{1,${max}}`, "g")) ?? [c] : [c]));
}

function pickWindowsVoice(): SpeechSynthesisVoice | undefined {
  const vs = window.speechSynthesis?.getVoices?.() ?? [];
  const en = vs.filter((v) => /^en/i.test(v.lang));
  return en.find((v) => /Microsoft.*(Aria|Jenny|Guy|Zira|Sonia|Natural)/i.test(v.name)) ?? en.find((v) => /Microsoft/i.test(v.name)) ?? en.find((v) => v.default) ?? en[0];
}

export function VoiceProvider({ children }: { children: ReactNode }) {
  const [enabled, setOn] = useState(() => localStorage.getItem(KEY) !== "off");
  const [speaking, setSpeaking] = useState<string | null>(null);
  const [engine, setEngine] = useState<Engine>(null);
  const run = useRef(0);
  const audio = useRef<HTMLAudioElement | null>(null);
  const serverDown = useRef(0); // skip the server for a minute after it said "use the browser voice"

  const stop = useCallback(() => {
    run.current++;
    audio.current?.pause();
    audio.current = null;
    window.speechSynthesis?.cancel();
    setSpeaking(null);
  }, []);

  const setEnabled = (on: boolean) => { localStorage.setItem(KEY, on ? "on" : "off"); setOn(on); if (!on) stop(); };

  const playServer = async (text: string, mine: number): Promise<boolean> => {
    if (Date.now() < serverDown.current) return false;
    try {
      const r = await fetch("/api/coach/tts", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${getToken()}` }, body: JSON.stringify({ text }) });
      if (!r.ok) { if (r.status === 503) serverDown.current = Date.now() + 60_000; return false; }
      if (run.current !== mine) return true; // stopped while loading
      const url = URL.createObjectURL(await r.blob());
      const a = new Audio(url);
      audio.current = a;
      await new Promise<void>((res, rej) => { a.onended = () => res(); a.onerror = () => rej(new Error("audio error")); a.play().catch(rej); });
      URL.revokeObjectURL(url);
      setEngine("elevenlabs");
      return true;
    } catch { return false; }
  };

  const playWindows = (text: string, mine: number) =>
    new Promise<void>((res) => {
      const synth = window.speechSynthesis;
      if (!synth) return res();
      const u = new SpeechSynthesisUtterance(text);
      const v = pickWindowsVoice();
      if (v) { u.voice = v; u.lang = v.lang; }
      u.rate = 0.98;
      u.onend = () => res(); u.onerror = () => res();
      if (run.current !== mine) return res();
      setEngine("windows");
      synth.speak(u);
    });

  const speak = useCallback((raw: string, opts: { force?: boolean; id?: string } = {}) => {
    if (!enabled && !opts.force) return;
    const text = speakable(raw);
    if (!text) return;
    stop();
    const mine = run.current;
    setSpeaking(opts.id ?? text.slice(0, 40));
    (async () => {
      for (const part of chunks(text)) {
        if (run.current !== mine) return;
        if (!(await playServer(part, mine))) { if (run.current === mine) await playWindows(part, mine); }
      }
      if (run.current === mine) setSpeaking(null);
    })();
  }, [enabled, stop]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { window.speechSynthesis?.getVoices?.(); return stop; }, [stop]); // warm up the voice list, stop on unmount

  return <Ctx.Provider value={{ enabled, setEnabled, speak, stop, speaking, engine }}>{children}</Ctx.Provider>;
}

/** On/off switch for automatic voiceover (hints and answers are read aloud when on). */
export function VoiceToggle() {
  const { enabled, setEnabled, engine } = useVoice();
  return (
    <button className={`voicetoggle ${enabled ? "on" : ""}`} onClick={() => setEnabled(!enabled)} title="Read hints, lessons and answers aloud" aria-pressed={enabled}>
      {enabled ? "🔊 Voice on" : "🔇 Voice off"}{enabled && engine ? <em>{engine === "elevenlabs" ? "AI voice" : "Windows voice"}</em> : null}
    </button>
  );
}

/** Reads one block of text aloud, or stops it. Works even when automatic voice is off. */
export function ListenButton({ text, id, label = "Listen" }: { text: string; id: string; label?: string }) {
  const { speak, stop, speaking } = useVoice();
  const active = speaking === id;
  return <button className="listen" onClick={() => (active ? stop() : speak(text, { force: true, id }))} aria-label={active ? "Stop" : label}>{active ? "⏹ Stop" : `🔊 ${label}`}</button>;
}
