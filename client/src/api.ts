import { io, Socket } from "socket.io-client";

export interface User { id: number; username: string; role: "admin" | "player" | "guest" }

const KEY = "chess.token";
export const getToken = () => localStorage.getItem(KEY);
export const setToken = (t: string | null) => (t ? localStorage.setItem(KEY, t) : localStorage.removeItem(KEY));

const TIMEOUT_MS = 20_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const OFFLINE_MESSAGE = "Can't reach the server. Check your connection and try again.";

/**
 * JSON call to the game server.
 * - Times out after 20s instead of hanging forever.
 * - GETs are retried (3 tries) on network failures and 503; POSTs are never auto-retried, because repeating
 *   an action (an answer, a payment) must be a deliberate choice.
 * - Network failures read as a sentence, not the browser's raw "Failed to fetch".
 * - An expired/invalid login (401) signs you out cleanly instead of leaving every screen broken.
 */
export async function api<T = any>(path: string, body?: unknown): Promise<T> {
  const method = body === undefined ? "GET" : "POST";
  const tries = method === "GET" ? 3 : 1;
  for (let i = 0; ; i++) {
    const token = getToken();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch("/api" + path, {
        method,
        headers: { "content-type": "application/json", ...(token && { authorization: `Bearer ${token}` }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctl.signal,
      });
      clearTimeout(timer);
      if (res.status === 401 && token) {
        setToken(null);
        window.location.assign("/");
        throw new Error("Your session expired. Please sign in again.");
      }
      if (res.status === 503 && i < tries - 1) { await sleep(700 * (i + 1)); continue; }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      return data;
    } catch (e: any) {
      clearTimeout(timer);
      const network = e?.name === "AbortError" || e instanceof TypeError;
      if (!network) throw e;
      if (i < tries - 1) { await sleep(700 * (i + 1)); continue; }
      throw new Error(OFFLINE_MESSAGE);
    }
  }
}

export function connectSocket(): Socket {
  return io({ auth: { token: getToken() } });
}

// ---- shared game types --------------------------------------------------

export interface Seat { id: number; name: string; rating: number | null }
export interface GameState {
  code: string;
  fen: string;
  moves: { san: string; uci: string }[];
  lastMove: { from: string; to: string } | null;
  white: Seat | null;
  black: Seat | null;
  status: "waiting" | "active" | "finished";
  result: string | null;
  termination: string | null;
  drawOffer: "w" | "b" | null;
  vsBot: boolean;
  ratingChange: { white: number | null; black: number | null } | null;
  inCheck: boolean;
  turn: "w" | "b";
  clock: { w: number; b: number; running: "w" | "b" | null; serverNow: number };
  timeControl?: { baseMs: number; incMs: number };
}

export interface Candidate { uci: string; san: string; eval_cp: number; mate: number | null; pv: string }
export interface Suggestion {
  ply: number;
  fen: string;
  top_moves: Candidate[];
  eval_cp: number;
  mate: number | null;
  similar: { fen: string; result: string | null; similarity: number }[] | null;
  explanation?: string | null;
  learned_win_prob?: number | null;
}
