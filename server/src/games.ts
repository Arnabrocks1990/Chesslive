import crypto from "node:crypto";
import { Chess } from "chess.js";
import type { Redis } from "ioredis";
import type { Server } from "socket.io";
import type { User } from "./auth.js";
import { query } from "./db.js";
import { BEGINNER_BOT_ELO, awardGameEvents, beginnerChoice } from "./learner.js";
import { FULL_STRENGTH_ELO, MIN_RATED_PLIES, START_RATING, eloChange, scoreOf, type Side } from "./elo.js";

type Color = "w" | "b";
interface Seat { id: number; name: string; rating: number | null }
interface MoveRec { san: string; uci: string }

export interface Live {
  id: number;
  code: string;
  chess: Chess;
  white: Seat | null;
  black: Seat | null;
  createdBy: number;
  baseMs: number;
  incMs: number;
  ms: { w: number; b: number };
  turnStartedAt: number | null;
  status: "waiting" | "active" | "finished";
  result: string | null;
  termination: string | null;
  drawOffer: Color | null;
  moves: MoveRec[];
  timer: NodeJS.Timeout | null;
  bot: { color: Color; elo: number | null } | null;
  ratingChange: { white: number | null; black: number | null } | null;
}

export class GameError extends Error {}

const BOT_ELO: Record<string, number> = { beginner: BEGINNER_BOT_ELO, easy: 1400, medium: 1800, hard: 2300 }; // anything else = full strength

export class GameManager {
  private games = new Map<string, Live>();
  botId = 0;

  constructor(private io: Server, private redis: Redis) {}

  // ---- creation / loading ------------------------------------------------

  async create(user: User, opts: { color?: string; minutes?: number; increment?: number; vsBot?: boolean; level?: string }) {
    const minutes = Math.min(180, Math.max(1, Number(opts.minutes) || 10));
    const increment = Math.min(60, Math.max(0, Number(opts.increment) || 0));
    let color = opts.color === "white" || opts.color === "black" ? opts.color : Math.random() < 0.5 ? "white" : "black";
    const code = crypto.randomBytes(5).toString("hex");
    const vsBot = !!opts.vsBot;
    const elo = vsBot ? BOT_ELO[String(opts.level)] ?? null : null;
    const other = vsBot ? this.botId : null;
    await query(
      `INSERT INTO games (code, white_id, black_id, created_by, creator_color, time_control_sec, increment_sec, vs_bot, bot_elo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [code, color === "white" ? user.id : other, color === "black" ? user.id : other, user.id, color, minutes * 60, increment, vsBot, elo]
    );
    return code;
  }

  async get(code: string): Promise<Live | null> {
    const cached = this.games.get(code);
    if (cached) return cached;
    const [g] = await query<any>(
      `SELECT g.*, w.username AS white_name, w.rating AS white_rating, b.username AS black_name, b.rating AS black_rating
       FROM games g LEFT JOIN users w ON w.id=g.white_id LEFT JOIN users b ON b.id=g.black_id
       WHERE g.code=$1`,
      [code]
    );
    if (!g) return null;
    const moveRows = await query<any>(`SELECT san, uci, clock_ms FROM moves WHERE game_id=$1 ORDER BY ply`, [g.id]);
    const chess = new Chess();
    const ms = { w: g.time_control_sec * 1000, b: g.time_control_sec * 1000 };
    moveRows.forEach((m, i) => {
      chess.move(m.san);
      ms[i % 2 === 0 ? "w" : "b"] = m.clock_ms;
    });
    const live: Live = {
      id: g.id,
      code,
      chess,
      white: g.white_id ? { id: g.white_id, name: g.white_name, rating: g.white_id === this.botId ? null : g.white_rating } : null,
      black: g.black_id ? { id: g.black_id, name: g.black_name, rating: g.black_id === this.botId ? null : g.black_rating } : null,
      createdBy: g.created_by,
      baseMs: g.time_control_sec * 1000,
      incMs: g.increment_sec * 1000,
      ms,
      turnStartedAt: g.status === "active" ? Date.now() : null,
      status: g.status,
      result: g.result,
      termination: g.termination,
      drawOffer: null,
      moves: moveRows.map((m) => ({ san: m.san, uci: m.uci })),
      timer: null,
      ratingChange: g.white_change === null && g.black_change === null ? null : { white: g.white_change, black: g.black_change },
      bot: g.vs_bot ? { color: g.white_id === this.botId ? "w" : "b", elo: g.bot_elo } : null,
    };
    this.games.set(code, live);
    if (live.status === "active") this.armTimer(live);
    return live;
  }

  async resumeActive() {
    const rows = await query<{ code: string }>(`SELECT code FROM games WHERE status='active'`);
    for (const r of rows) await this.get(r.code);
  }

  // ---- state -------------------------------------------------------------

  private liveMs(g: Live) {
    const ms = { ...g.ms };
    if (g.status === "active" && g.turnStartedAt) ms[g.chess.turn()] -= Date.now() - g.turnStartedAt;
    return { w: Math.max(0, ms.w), b: Math.max(0, ms.b) };
  }

  view(g: Live) {
    const last = g.moves.length ? g.moves[g.moves.length - 1].uci : null;
    return {
      code: g.code,
      id: g.id,
      fen: g.chess.fen(),
      moves: g.moves,
      lastMove: last ? { from: last.slice(0, 2), to: last.slice(2, 4) } : null,
      white: g.white,
      black: g.black,
      status: g.status,
      result: g.result,
      termination: g.termination,
      drawOffer: g.drawOffer,
      vsBot: !!g.bot,
      ratingChange: g.ratingChange,
      inCheck: g.chess.inCheck(),
      turn: g.chess.turn(),
      timeControl: { baseMs: g.baseMs, incMs: g.incMs },
      clock: { ...this.liveMs(g), running: g.status === "active" ? g.chess.turn() : null, serverNow: Date.now() },
    };
  }

  private broadcast(g: Live) {
    this.io.to(g.code).emit("state", this.view(g));
  }

  // ---- actions -----------------------------------------------------------

  async join(code: string, user: User) {
    const g = await this.get(code);
    if (!g) throw new GameError("Game not found");
    const mine = g.white?.id === user.id || g.black?.id === user.id;
    if (!mine && g.status === "waiting") {
      const seat = { id: user.id, name: user.username, rating: await this.ratingOf(user.id) };
      if (!g.white) g.white = seat;
      else if (!g.black) g.black = seat;
      await query(`UPDATE games SET white_id=$2, black_id=$3 WHERE id=$1`, [g.id, g.white?.id ?? null, g.black?.id ?? null]);
    }
    if (g.status === "waiting" && g.white && g.black) {
      g.status = "active";
      g.turnStartedAt = Date.now();
      await query(`UPDATE games SET status='active' WHERE id=$1`, [g.id]);
      this.armTimer(g);
      this.enqueueIfAdminWatching(g);
      this.maybeBotMove(g);
    }
    this.broadcast(g);
    return g;
  }

  /** No opponent showed up: seat the Stockfish bot in the empty seat and start the game. */
  async playBot(code: string, user: User, level?: string) {
    const g = await this.get(code);
    if (!g) throw new GameError("Game not found");
    if (g.status !== "waiting" || (g.white && g.black)) throw new GameError("An opponent has already joined");
    if (g.white?.id !== user.id && g.black?.id !== user.id) throw new GameError("Only the player who created the game can do this");
    const elo = BOT_ELO[String(level)] ?? null;
    const seat = { id: this.botId, name: "Stockfish", rating: null };
    if (!g.white) g.white = seat;
    else g.black = seat;
    g.bot = { color: g.white === seat ? "w" : "b", elo };
    await query(`UPDATE games SET white_id=$2, black_id=$3, vs_bot=true, bot_elo=$4 WHERE id=$1`, [
      g.id, g.white?.id ?? null, g.black?.id ?? null, elo,
    ]);
    await this.join(code, user); // both seats filled -> game starts, bot moves if it is White
  }

  async move(code: string, user: User, m: { from: string; to: string; promotion?: string }) {
    const g = await this.get(code);
    if (!g || g.status !== "active") throw new GameError("Game is not active");
    const color = g.chess.turn();
    const seat = color === "w" ? g.white : g.black;
    if (!seat || seat.id !== user.id) throw new GameError("Not your turn");

    const now = Date.now();
    const remaining = g.ms[color] - (now - (g.turnStartedAt ?? now));
    if (remaining <= 0) {
      await this.finish(g, color === "w" ? "0-1" : "1-0", "timeout");
      throw new GameError("Time is up");
    }
    let played;
    try {
      played = g.chess.move({ from: m.from, to: m.to, promotion: m.promotion });
    } catch {
      throw new GameError("Illegal move");
    }
    g.ms[color] = remaining + g.incMs;
    g.turnStartedAt = now;
    g.drawOffer = null;
    g.moves.push({ san: played.san, uci: played.from + played.to + (played.promotion ?? "") });
    const ply = g.moves.length;
    await query(
      `INSERT INTO moves (game_id, ply, san, uci, fen_after, clock_ms) VALUES ($1,$2,$3,$4,$5,$6)`,
      [g.id, ply, played.san, g.moves[ply - 1].uci, g.chess.fen(), g.ms[color]]
    );

    if (g.chess.isGameOver()) {
      const term = g.chess.isCheckmate()
        ? "checkmate"
        : g.chess.isStalemate()
          ? "stalemate"
          : g.chess.isThreefoldRepetition()
            ? "repetition"
            : g.chess.isInsufficientMaterial()
              ? "insufficient material"
              : "draw";
      const result = g.chess.isCheckmate() ? (color === "w" ? "1-0" : "0-1") : "1/2-1/2";
      await this.finish(g, result, term);
      return;
    }
    this.armTimer(g);
    this.broadcast(g);
    this.enqueueIfAdminWatching(g);
    this.maybeBotMove(g);
  }

  async resign(code: string, user: User) {
    const g = await this.get(code);
    if (!g || g.status !== "active") throw new GameError("Game is not active");
    const color = g.white?.id === user.id ? "w" : g.black?.id === user.id ? "b" : null;
    if (!color) throw new GameError("You are not a player");
    await this.finish(g, color === "w" ? "0-1" : "1-0", "resignation");
  }

  async draw(code: string, user: User, action: "offer" | "accept" | "decline") {
    const g = await this.get(code);
    if (!g || g.status !== "active") throw new GameError("Game is not active");
    const color: Color | null = g.white?.id === user.id ? "w" : g.black?.id === user.id ? "b" : null;
    if (!color) throw new GameError("You are not a player");
    if (action === "offer") g.drawOffer = color;
    else if (g.drawOffer && g.drawOffer !== color) {
      if (action === "accept") return this.finish(g, "1/2-1/2", "agreement");
      g.drawOffer = null;
    }
    this.broadcast(g);
  }

  // ---- clocks / finishing ------------------------------------------------

  private armTimer(g: Live) {
    if (g.timer) clearTimeout(g.timer);
    if (g.status !== "active" || !g.turnStartedAt) return;
    const color = g.chess.turn();
    const left = g.ms[color] - (Date.now() - g.turnStartedAt);
    g.timer = setTimeout(() => {
      if (g.status === "active" && g.chess.turn() === color) {
        this.finish(g, color === "w" ? "0-1" : "1-0", "timeout").catch((e) => console.error("timeout finish failed", e));
      }
    }, Math.max(0, left) + 50);
  }

  private async finish(g: Live, result: string, termination: string) {
    if (g.status === "finished") return;
    if (g.timer) clearTimeout(g.timer);
    g.timer = null;
    g.status = "finished";
    g.result = result;
    g.termination = termination;
    g.drawOffer = null;
    if (g.turnStartedAt) g.ms[g.chess.turn()] = this.liveMs(g)[g.chess.turn()];
    g.turnStartedAt = null;

    g.chess.header("White", g.white?.name ?? "?", "Black", g.black?.name ?? "?", "Result", result, "Termination", termination);
    await query(`UPDATE games SET status='finished', result=$2, termination=$3, pgn=$4, ended_at=now() WHERE id=$1`, [
      g.id, result, termination, g.chess.pgn(),
    ]);
    await query(`UPDATE position_embeddings SET result=$2 WHERE game_id=$1`, [g.id, result]);
    g.ratingChange = await this.rate(g).catch((e) => {
      console.error("rating update failed", e);
      return null;
    });
    awardGameEvents(g).catch((e) => console.error("learner xp failed", e));
    this.broadcast(g);
    this.queuePostGameAnalysis(g).catch((e) => console.error("post-game queue failed", e));
  }

  // ---- Elo ---------------------------------------------------------------

  private async ratingOf(userId: number): Promise<number> {
    const [r] = await query<{ rating: number }>(`SELECT rating FROM users WHERE id=$1`, [userId]);
    return r?.rating ?? START_RATING;
  }

  /** Standard Elo (K=32 for a player's first 30 rated games, then 20). The bot is never rated;
   *  its opponent is rated against the bot's nominal strength. */
  private async rate(g: Live) {
    if (!g.white || !g.black || !g.result || g.moves.length < MIN_RATED_PLIES) return null;
    const rows = await query<{ id: number; rating: number; rated_games: number }>(
      `SELECT id, rating, rated_games FROM users WHERE id = ANY($1)`,
      [[g.white.id, g.black.id]]
    );
    const side = (seat: Seat, isBot: boolean): Side => {
      if (isBot) return { rating: g.bot!.elo ?? FULL_STRENGTH_ELO, games: 30, bot: true };
      const u = rows.find((r) => r.id === seat.id);
      return { rating: u?.rating ?? START_RATING, games: u?.rated_games ?? 0, bot: false };
    };
    const { white: dw, black: db } = eloChange(
      side(g.white, g.bot?.color === "w"),
      side(g.black, g.bot?.color === "b"),
      scoreOf(g.result)
    );
    for (const [seat, d] of [[g.white, dw], [g.black, db]] as const) {
      if (d === null) continue;
      const before = rows.find((r) => r.id === seat.id)?.rating ?? START_RATING;
      const after = Math.max(100, before + d);
      await query(`UPDATE users SET rating=$2, rated_games=rated_games+1 WHERE id=$1`, [seat.id, after]);
      seat.rating = after;
    }
    await query(`UPDATE games SET white_change=$2, black_change=$3 WHERE id=$1`, [g.id, dw, db]);
    return { white: dw, black: db };
  }

  // ---- analysis queue ----------------------------------------------------

  private job(g: Live, ply: number, fen: string, kind: "live" | "post") {
    return JSON.stringify({ gameId: g.id, code: g.code, ply, fen, kind });
  }

  /** Live suggestions are admin-only, so only spend engine time when an admin is in the room. */
  async enqueueIfAdminWatching(g: Live) {
    const socks = await this.io.in(g.code).fetchSockets();
    if (!socks.some((s) => s.data.user?.role === "admin")) return;
    await this.redis.lpush("analysis:live", this.job(g, g.moves.length, g.chess.fen(), "live"));
  }

  async queuePostGameAnalysis(g: Live) {
    const have = new Set((await query<{ ply: number }>(`SELECT ply FROM analyses WHERE game_id=$1`, [g.id])).map((r) => r.ply));
    const replay = new Chess();
    const jobs: string[] = [];
    const synthetic: [number, string, number][] = [];
    if (!have.has(0)) jobs.push(this.job(g, 0, replay.fen(), "post"));
    g.moves.forEach((m, i) => {
      replay.move(m.san);
      if (have.has(i + 1)) return;
      if (replay.isGameOver()) {
        // Terminal positions have no moves for the engine to suggest; score them from the result.
        const cp = replay.isCheckmate() ? (replay.turn() === "w" ? -10000 : 10000) : 0;
        synthetic.push([i + 1, replay.fen(), cp]);
      } else jobs.push(this.job(g, i + 1, replay.fen(), "post"));
    });
    for (const [ply, fen, cp] of synthetic) {
      await query(
        `INSERT INTO analyses (game_id, ply, fen, top_moves, eval_cp) VALUES ($1,$2,$3,'[]',$4) ON CONFLICT DO NOTHING`,
        [g.id, ply, fen, cp]
      );
    }
    if (jobs.length) await this.redis.lpush("analysis:post", ...jobs);
    // Queue is FIFO (LPUSH + BRPOP), so training runs after this game's positions are analysed and labelled.
    await this.redis.lpush("analysis:post", JSON.stringify({ kind: "train" }));
  }

  /** Asks the worker for the bot's reply when it is the bot's turn. */
  maybeBotMove(g: Live) {
    if (!g.bot || g.status !== "active" || g.chess.turn() !== g.bot.color) return;
    if (g.bot.elo === BEGINNER_BOT_ELO) { // the Beginner bot is played here, with a short pause so it feels human
      const fen = g.chess.fen();
      const pick = beginnerChoice(g.chess.moves({ verbose: true }) as any);
      setTimeout(() => this.botMove(g.code, fen, pick.from + pick.to + (pick.promotion ?? "")).catch((e) => console.error("beginner bot failed", e)), 600 + Math.random() * 900);
      return;
    }
    this.redis
      .lpush("analysis:bot", JSON.stringify({ kind: "bot", gameId: g.id, code: g.code, fen: g.chess.fen(), elo: g.bot.elo }))
      .catch((e) => console.error("bot enqueue failed", e));
  }

  async botMove(code: string, fen: string, uci: string) {
    const g = this.games.get(code);
    if (!g?.bot || g.status !== "active" || g.chess.fen() !== fen) return; // stale reply
    await this.move(code, { id: this.botId, username: "Stockfish", role: "bot" }, {
      from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.slice(4) || undefined,
    });
  }

  peek(code: string) {
    return this.games.get(code);
  }
}
