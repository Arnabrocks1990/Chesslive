// Proves that a Lichess / Chess.com account belongs to the person asking for coaching on it.
// The app gives the user a short code; they paste it into their public profile (Lichess: Biography,
// Chess.com: Location) and we look for it through the site's public API. No password or login is involved.
import crypto from "node:crypto";
import { query } from "../db.js";

type Platform = "lichess" | "chesscom";

// Overridable so tests can point at a stand-in server; production always uses the real sites.
const LICHESS = process.env.LICHESS_BASE || "https://lichess.org";
const CHESSCOM = process.env.CHESSCOM_BASE || "https://api.chess.com";

export const FIELD: Record<Platform, { name: string; url: string }> = {
  lichess: { name: "Biography", url: "https://lichess.org/account/profile" },
  chesscom: { name: "Location", url: "https://www.chess.com/settings" },
};

export const VERIFY_DDL = `CREATE TABLE IF NOT EXISTS coach_verifications (
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  username TEXT NOT NULL,
  code TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  verified_at TIMESTAMPTZ,
  PRIMARY KEY (user_id, platform, username))`;

/** The public free-text fields of the account, or an error if it does not exist. */
export async function profileText(platform: Platform, username: string): Promise<string> {
  const url = platform === "lichess" ? `${LICHESS}/api/user/${encodeURIComponent(username)}` : `${CHESSCOM}/pub/player/${encodeURIComponent(username.toLowerCase())}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: "application/json", "user-agent": "ChessLive/1.0 (account verification)" }, signal: AbortSignal.timeout(15_000) });
  } catch (e: any) {
    throw new Error(`Network error reaching ${new URL(url).host}: ${e?.cause?.code || e.message}`);
  }
  const site = platform === "lichess" ? "Lichess" : "Chess.com";
  if (res.status === 404) throw new Error(`${site} user "${username}" not found`);
  if (!res.ok) throw new Error(`${site} returned ${res.status}. Please try again in a moment.`);
  const j: any = await res.json().catch(() => ({}));
  const parts = platform === "lichess" ? [j.profile?.bio, j.profile?.location, j.profile?.realName] : [j.location, j.name];
  return parts.filter((p) => typeof p === "string").join("\n");
}

/** The user's code for this account (created once, then stable, so a page reload does not invalidate it). */
export async function codeFor(userId: number, platform: Platform, username: string) {
  const code = "cl-" + crypto.randomBytes(5).toString("hex").slice(0, 8);
  await query(
    `INSERT INTO coach_verifications (user_id, platform, username, code) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
    [userId, platform, username.toLowerCase(), code]
  );
  const [row] = await query<{ code: string; verified_at: string | null }>(
    `SELECT code, verified_at FROM coach_verifications WHERE user_id=$1 AND platform=$2 AND username=$3`, [userId, platform, username.toLowerCase()]);
  return row;
}

/** True once the account is proven to be theirs (now, or earlier: proof is not withdrawn if they later edit the profile). */
export async function isVerified(userId: number, platform: Platform, username: string): Promise<{ ok: boolean; code: string }> {
  const row = await codeFor(userId, platform, username);
  if (row.verified_at) return { ok: true, code: row.code };
  const text = await profileText(platform, username);
  if (!text.toLowerCase().includes(row.code.toLowerCase())) return { ok: false, code: row.code };
  await query(`UPDATE coach_verifications SET verified_at=now() WHERE user_id=$1 AND platform=$2 AND username=$3`, [userId, platform, username.toLowerCase()]);
  return { ok: true, code: row.code };
}
