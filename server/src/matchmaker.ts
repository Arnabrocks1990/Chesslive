// Random matchmaking: players who ask for "find a match" wait here and are paired with someone of a similar
// Elo and the same time control. The acceptable rating gap widens the longer a player waits, so nobody is
// stuck forever when few people are online. In memory only: a waiting player is just a connected socket.
import type { Server } from "socket.io";
import type { User } from "./auth.js";
import { query } from "./db.js";
import type { GameManager } from "./games.js";

interface Ticket {
  user: User;
  socketId: string;
  minutes: number;
  increment: number;
  rating: number;
  since: number;
}

export const BASE_WINDOW = 100; // Elo points either side at the start
export const GROWTH_PER_SEC = 25; // the window widens by this much per second waited
export const ANYONE_AFTER_SEC = 45; // after this long the rating no longer matters
const PICK_FROM = 3; // choose randomly among this many closest-rated candidates, so repeat pairings vary

export const windowOf = (waitedSec: number) => (waitedSec >= ANYONE_AFTER_SEC ? Infinity : BASE_WINDOW + GROWTH_PER_SEC * waitedSec);

/** Pure pairing step (exported for tests): returns the pairs to start and the tickets still waiting. */
export function pairUp(tickets: Ticket[], now: number, rnd: () => number = Math.random): { pairs: [Ticket, Ticket][]; rest: Ticket[] } {
  const pool = [...tickets].sort((a, b) => a.since - b.since); // longest waiting is served first
  const pairs: [Ticket, Ticket][] = [];
  const rest: Ticket[] = [];
  while (pool.length) {
    const a = pool.shift()!;
    const wa = windowOf((now - a.since) / 1000);
    const near = pool
      .filter((b) => b.user.id !== a.user.id && b.minutes === a.minutes && b.increment === a.increment)
      // either side's patience is enough: a long-waiting player can be picked up by a fresh one
      .filter((b) => Math.abs(b.rating - a.rating) <= Math.max(wa, windowOf((now - b.since) / 1000)))
      .sort((x, y) => Math.abs(x.rating - a.rating) - Math.abs(y.rating - a.rating))
      .slice(0, PICK_FROM);
    if (!near.length) {
      rest.push(a);
      continue;
    }
    const b = near[Math.floor(rnd() * near.length)];
    pool.splice(pool.indexOf(b), 1);
    pairs.push([a, b]);
  }
  return { pairs, rest };
}

export class Matchmaker {
  private queue = new Map<number, Ticket>(); // one ticket per user
  private busy = false;

  constructor(private io: Server, private games: GameManager) {
    setInterval(() => void this.tick(), 2000).unref();
  }

  async enqueue(user: User, socketId: string, minutes: number, increment: number) {
    minutes = Math.min(180, Math.max(1, Math.floor(Number(minutes)) || 10));
    increment = Math.min(60, Math.max(0, Math.floor(Number(increment)) || 0));
    const [row] = await query<{ rating: number }>(`SELECT rating FROM users WHERE id=$1`, [user.id]);
    const ticket: Ticket = { user, socketId, minutes, increment, rating: row?.rating ?? 600, since: Date.now() };
    this.queue.set(user.id, ticket); // asking again (another tab / new time control) replaces the old ticket
    void this.tick();
    return { rating: ticket.rating, waiting: this.queue.size };
  }

  cancel(userId: number, socketId?: string) {
    const t = this.queue.get(userId);
    if (t && (!socketId || t.socketId === socketId)) this.queue.delete(userId);
  }

  get size() {
    return this.queue.size;
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const now = Date.now();
      // drop tickets whose socket has gone away
      for (const [id, t] of this.queue) if (!this.io.sockets.sockets.has(t.socketId)) this.queue.delete(id);
      const { pairs } = pairUp([...this.queue.values()], now);
      for (const [a, b] of pairs) {
        this.queue.delete(a.user.id);
        this.queue.delete(b.user.id);
        await this.start(a, b);
      }
      for (const t of this.queue.values()) {
        const waited = (now - t.since) / 1000;
        const w = windowOf(waited);
        this.io.to(t.socketId).emit("matchStatus", { waiting: this.queue.size, seconds: Math.floor(waited), range: Number.isFinite(w) ? w : null, rating: t.rating });
      }
    } finally {
      this.busy = false;
    }
  }

  private async start(a: Ticket, b: Ticket) {
    try {
      const [white, black] = Math.random() < 0.5 ? [a, b] : [b, a]; // colours are random
      const code = await this.games.create(white.user, { color: "white", minutes: a.minutes, increment: a.increment });
      await this.games.join(code, white.user);
      await this.games.join(code, black.user); // both seats filled: the game starts
      for (const [me, opp] of [[a, b], [b, a]] as const) {
        this.io.to(me.socketId).emit("matched", { code, opponent: opp.user.username, opponentRating: opp.rating, color: me === white ? "white" : "black" });
      }
    } catch (e) {
      console.error("matchmaking failed to start a game:", e);
      for (const t of [a, b]) this.io.to(t.socketId).emit("matchError", { error: "Could not start the game. Please search again." });
    }
  }
}
