import { io, Socket } from "socket.io-client";

export interface User { id: number; username: string; role: "admin" | "player" | "guest" }

const KEY = "chess.token";
export const getToken = () => localStorage.getItem(KEY);
export const setToken = (t: string | null) => (t ? localStorage.setItem(KEY, t) : localStorage.removeItem(KEY));

export async function api<T = any>(path: string, body?: unknown): Promise<T> {
  const token = getToken();
  const res = await fetch("/api" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...(token && { authorization: `Bearer ${token}` }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
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
