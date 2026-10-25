import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { config } from "./config.js";
import { query } from "./db.js";

export interface User {
  id: number;
  username: string;
  role: "admin" | "player" | "guest" | "bot";
}

const NAME_RE = /^[A-Za-z0-9_ -]{2,24}$/;

export function signToken(user: User): string {
  return jwt.sign(user, config.jwtSecret, { expiresIn: "30d" });
}

// Accounts an admin has blocked. Kept in memory (checked on every request) and re-read from the database every
// few seconds, so a block made from the separate local admin dashboard takes effect here too.
const blocked = new Set<number>();
export const isBlocked = (id: number) => blocked.has(id);
/** Reloads the blocked set; returns the ids that are newly blocked (so their live connections can be dropped). */
export async function refreshBlocked(): Promise<number[]> {
  const rows = await query<{ id: number }>(`SELECT id FROM users WHERE blocked_at IS NOT NULL`);
  const next = new Set(rows.map((r) => r.id));
  const added = [...next].filter((id) => !blocked.has(id));
  blocked.clear();
  next.forEach((id) => blocked.add(id));
  return added;
}

// "Online now" = recently active. Any signed-in API request or socket heartbeat refreshes last_seen_at.
const touched = new Map<number, number>();
export function touchSeen(id: number, everyMs = 30_000) {
  const now = Date.now();
  if ((touched.get(id) ?? 0) > now - everyMs) return;
  touched.set(id, now);
  query(`UPDATE users SET last_seen_at=now() WHERE id=$1`, [id]).catch(() => {});
}

export function verifyToken(token: string): User | null {
  try {
    const { id, username, role } = jwt.verify(token, config.jwtSecret) as User;
    if (blocked.has(id)) return null;
    return { id, username, role };
  } catch {
    return null;
  }
}

/** Creates the admin account, or resets its password to ADMIN_PASSWORD (the env value is the source of truth). */
export async function ensureAdmin() {
  const hash = await bcrypt.hash(config.adminPassword, 10);
  await query(
    `INSERT INTO users (username, password_hash, role) VALUES ($1,$2,'admin')
     ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = 'admin'`,
    [config.adminUsername, hash]
  );
}

export async function register(username: string, password: string): Promise<User> {
  if (!NAME_RE.test(username)) throw new Error("Username must be 2-24 letters, digits, space, _ or -");
  if (!password || password.length < 6) throw new Error("Password must be at least 6 characters");
  const hash = await bcrypt.hash(password, 10);
  try {
    const [row] = await query<User>(
      `INSERT INTO users (username, password_hash, role) VALUES ($1,$2,'player') RETURNING id, username, role`,
      [username, hash]
    );
    return row;
  } catch (e: any) {
    if (e.code === "23505") throw new Error("Username already taken");
    throw e;
  }
}

export async function login(username: string, password: string): Promise<User> {
  const [row] = await query<User & { password_hash: string | null }>(
    `SELECT id, username, role, password_hash, blocked_at FROM users WHERE username = $1`,
    [username]
  );
  if (!row || !row.password_hash || !(await bcrypt.compare(password, row.password_hash))) {
    throw new Error("Invalid username or password");
  }
  if ((row as any).blocked_at) throw new Error("This account has been blocked by an administrator.");
  return { id: row.id, username: row.username, role: row.role };
}

export async function guest(name?: string): Promise<User> {
  const base = (name || "Guest").trim().slice(0, 16) || "Guest";
  for (let i = 0; i < 5; i++) {
    const username = `${base}-${Math.floor(1000 + Math.random() * 9000)}`;
    try {
      const [row] = await query<User>(
        `INSERT INTO users (username, role) VALUES ($1,'guest') RETURNING id, username, role`,
        [username]
      );
      return row;
    } catch (e: any) {
      if (e.code !== "23505") throw e;
    }
  }
  throw new Error("Could not create guest");
}

export async function ensureBot(): Promise<number> {
  const [row] = await query<{ id: number }>(
    `INSERT INTO users (username, role) VALUES ('Stockfish', 'bot')
     ON CONFLICT (username) DO UPDATE SET role = 'bot', password_hash = NULL RETURNING id`
  );
  return row.id;
}
