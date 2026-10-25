import type { RequestHandler } from "express";
import { verifyToken, type User } from "../auth.js";
import { query } from "../db.js";

/** A coach profile is private to its owner; admins can see every profile. */
export async function ownsPlayer(user: Pick<User, "id" | "role">, playerId: number): Promise<boolean> {
  if (!Number.isInteger(playerId)) return false;
  const rows =
    user.role === "admin"
      ? await query(`SELECT 1 FROM players WHERE id=$1`, [playerId])
      : await query(`SELECT 1 FROM players WHERE id=$1 AND owner_id=$2`, [playerId, user.id]);
  return rows.length > 0;
}

// Every coach URL that points at someone's data, mapped to the profile it belongs to.
const RESOLVERS: [RegExp, (id: number) => Promise<number | undefined>][] = [
  [/^\/players\/(\d+)(?:\/|$)/, async (id) => id],
  [/^\/runs\/(\d+)$/, async (id) => (await query<{ player_id: number }>(`SELECT player_id FROM agent_runs WHERE id=$1`, [id]))[0]?.player_id],
  [/^\/sessions\/(\d+)(?:\/|$)/, async (id) => (await query<{ player_id: number }>(`SELECT player_id FROM plan_sessions WHERE id=$1`, [id]))[0]?.player_id],
  [
    /^\/session-questions\/(\d+)(?:\/|$)/,
    async (id) =>
      (await query<{ player_id: number }>(`SELECT s.player_id FROM session_questions q JOIN plan_sessions s ON s.id=q.session_id WHERE q.id=$1`, [id]))[0]?.player_id,
  ],
  [/^\/drills\/(\d+)(?:\/|$)/, async (id) => (await query<{ player_id: number }>(`SELECT player_id FROM drills WHERE id=$1`, [id]))[0]?.player_id],
];

/**
 * Mount on /api/coach BEFORE the coach routes. Any route that addresses a profile, run, session, question
 * or drill is refused unless the caller owns that profile (or is an admin). "Not yours" and "does not exist"
 * look identical (404) so profile ids cannot be probed. Exempt: creating/listing profiles (handlers scope those
 * to the caller), the owner's public share link, and text-to-speech.
 */
export const coachOwnerGate: RequestHandler = (req, res, next) => {
  const hit = RESOLVERS.map(([re, fn]) => [re.exec(req.path), fn] as const).find(([m]) => m);
  if (!hit) return next();
  const user = verifyToken((req.headers.authorization || "").replace(/^Bearer /, ""));
  if (!user) return void res.status(401).json({ error: "Not signed in" });
  const [m, resolve] = hit;
  (async () => {
    const pid = await resolve(Number(m![1]));
    if (pid === undefined || !(await ownsPlayer(user, pid))) return void res.status(404).json({ error: "Not found" });
    if (user.role !== "admin") {
      const [p] = await query<{ revoked_at: string | null }>(`SELECT revoked_at FROM players WHERE id=$1`, [pid]);
      if (p?.revoked_at) return void res.status(403).json({ error: "An administrator has revoked access to this coach profile." });
    }
    next();
  })().catch(next);
};
