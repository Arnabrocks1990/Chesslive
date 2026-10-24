import crypto from "node:crypto";
import { Chess } from "chess.js";
import { query } from "../db.js";

export type Platform = "lichess" | "chesscom" | "pgn";

export interface ImportedGame {
  externalId: string;
  playerColor: "white" | "black";
  result: "1-0" | "0-1" | "1/2-1/2" | "*";
  sans: string[];
  clocksMs: (number | null)[]; // mover's remaining clock after each ply, if known
  playedAt: Date | null;
  timeControlSec: number;
  pgn: string;
}

/** Corporate networks drop the odd connection; retry before giving up. */
async function fetchRetry(url: string | URL, init: RequestInit, tries = 3): Promise<Response> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try { return await fetch(url, init); } catch (e) { last = e; await new Promise((r) => setTimeout(r, 1500 * (i + 1))); }
  }
  throw new Error(`Network error reaching ${new URL(String(url)).host}: ${(last as any)?.cause?.code || (last as Error).message}`);
}

const UA = `ChessCoach/0.1 (hackathon prototype${process.env.CONTACT_EMAIL ? `; contact ${process.env.CONTACT_EMAIL}` : ""})`;

/** Lichess: public NDJSON export of the user's finished games. */
export async function fetchLichess(username: string, max: number, since?: Date | null): Promise<ImportedGame[]> {
  const url = new URL(`https://lichess.org/api/games/user/${encodeURIComponent(username)}`);
  url.searchParams.set("max", String(max));
  url.searchParams.set("moves", "true");
  url.searchParams.set("clocks", "true");
  url.searchParams.set("finished", "true");
  if (since) url.searchParams.set("since", String(since.getTime()));
  const res = await fetchRetry(url, { headers: { accept: "application/x-ndjson", "user-agent": UA }, signal: AbortSignal.timeout(30_000) });
  if (res.status === 404) throw new Error(`Lichess user "${username}" not found`);
  if (!res.ok) throw new Error(`Lichess returned ${res.status}`);
  const out: ImportedGame[] = [];
  for (const line of (await res.text()).split("\n")) {
    if (!line.trim()) continue;
    const g = JSON.parse(line);
    if (g.variant && g.variant !== "standard") continue;
    if (!g.moves) continue;
    const white = String(g.players?.white?.user?.name || "").toLowerCase() === username.toLowerCase();
    const black = String(g.players?.black?.user?.name || "").toLowerCase() === username.toLowerCase();
    if (!white && !black) continue;
    const result = g.winner === "white" ? "1-0" : g.winner === "black" ? "0-1" : g.status === "draw" || g.status === "stalemate" ? "1/2-1/2" : "*";
    if (result === "*") continue; // aborted / still playing
    const sans = String(g.moves).split(" ").filter(Boolean);
    const clocks: (number | null)[] = Array.isArray(g.clocks) ? g.clocks.map((c: number) => c * 10) : [];
    out.push({
      externalId: g.id,
      playerColor: white ? "white" : "black",
      result,
      sans,
      clocksMs: sans.map((_, i) => clocks[i] ?? null),
      playedAt: g.createdAt ? new Date(g.createdAt) : null,
      timeControlSec: Number(g.clock?.initial ?? 0),
      pgn: "",
    });
  }
  return out;
}

/** Chess.com: monthly archives, newest first, until `max` games are collected. */
export async function fetchChessCom(username: string, max: number, since?: Date | null): Promise<ImportedGame[]> {
  const base = `https://api.chess.com/pub/player/${encodeURIComponent(username.toLowerCase())}`;
  const get = async (u: string) => {
    const r = await fetchRetry(u, { headers: { "user-agent": UA, accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
    if (r.status === 404) throw new Error(`Chess.com user "${username}" not found`);
    if (!r.ok) throw new Error(`Chess.com returned ${r.status} (use PGN paste if this persists)`);
    return r.json() as Promise<any>;
  };
  const archives: string[] = (await get(`${base}/games/archives`)).archives || [];
  const out: ImportedGame[] = [];
  for (const url of archives.reverse()) {
    const month = await get(url);
    for (const g of [...(month.games || [])].reverse()) {
      if (g.rules !== "chess" || !g.pgn) continue;
      if (since && g.end_time && g.end_time * 1000 <= since.getTime()) continue;
      const parsed = parseGame(g.pgn, username, String(g.url || g.uuid).split("/").pop()!);
      if (parsed) out.push(parsed);
      if (out.length >= max) return out;
    }
  }
  return out;
}

/** Parses one PGN. `who` is a username matched against the White/Black headers, or "white"/"black". */
export function parseGame(pgn: string, who: string, externalId?: string): ImportedGame | null {
  const chess = new Chess();
  try { chess.loadPgn(pgn); } catch { return null; }
  const h = chess.header();
  const name = who.toLowerCase();
  const color: "white" | "black" | null =
    name === "white" || name === "black" ? name
    : String(h.White || "").toLowerCase() === name ? "white"
    : String(h.Black || "").toLowerCase() === name ? "black" : null;
  if (!color) return null;
  const result = (["1-0", "0-1", "1/2-1/2"].includes(String(h.Result)) ? h.Result : "*") as ImportedGame["result"];
  if (result === "*") return null;
  const history = chess.history();
  if (!history.length) return null;
  // Chess.com/Lichess PGNs carry {[%clk h:mm:ss.s]} comments after each move.
  const clks = [...pgn.matchAll(/\[%clk (\d+):(\d+):(\d+(?:\.\d+)?)\]/g)].map((m) => (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000);
  const tc = /^(\d+)/.exec(String(h.TimeControl || ""));
  const date = h.UTCDate && h.UTCTime ? new Date(`${String(h.UTCDate).replace(/\./g, "-")}T${h.UTCTime}Z`) : null;
  return {
    externalId: externalId || String(h.Link || "").split("/").pop() || crypto.createHash("sha1").update(pgn).digest("hex").slice(0, 12),
    playerColor: color, result, sans: history,
    clocksMs: history.map((_, i) => clks[i] ?? null),
    playedAt: date && !isNaN(+date) ? date : null,
    timeControlSec: tc ? Number(tc[1]) : 0,
    pgn,
  };
}

export function splitPgns(text: string): string[] {
  return text.split(/\n\s*\n(?=\[Event )/).map((s) => s.trim()).filter(Boolean);
}

/** Stores a game and its moves. Returns the game id, or null if it was already imported. */
export async function storeGame(playerId: number, source: string, g: ImportedGame): Promise<number | null> {
  // Duplicates are per player: importing the same game twice is a no-op, but two different players (friends who
  // played each other, or two people pasting the same PGN) must each get their own copy.
  const exists = await query(`SELECT id FROM games WHERE player_id=$1 AND source=$2 AND external_id=$3`, [playerId, source, g.externalId]);
  if (exists.length) return null;
  const replay = new Chess();
  const rows: [number, string, string, string, number][] = [];
  for (let i = 0; i < g.sans.length; i++) {
    const m = replay.move(g.sans[i]);
    rows.push([i + 1, m.san, m.from + m.to + (m.promotion || ""), replay.fen(), g.clocksMs[i] ?? 0]);
  }
  const code = "imp-" + crypto.randomBytes(5).toString("hex");
  const [row] = await query<{ id: number }>(
    `INSERT INTO games (code, time_control_sec, status, result, termination, pgn, source, external_id, player_id, player_color, played_at, ended_at)
     VALUES ($1,$2,'finished',$3,'imported',$4,$5,$6,$7,$8,$9, now()) RETURNING id`,
    [code, g.timeControlSec, g.result, g.pgn || replay.pgn(), source, g.externalId, playerId, g.playerColor, g.playedAt]
  );
  for (const [ply, san, uci, fen, clock] of rows) {
    await query(`INSERT INTO moves (game_id, ply, san, uci, fen_after, clock_ms) VALUES ($1,$2,$3,$4,$5,$6)`, [row.id, ply, san, uci, fen, clock]);
  }
  return row.id;
}
