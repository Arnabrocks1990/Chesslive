// Rebuilds every rating from scratch by replaying all finished games in the order they ended,
// with the same rules as live games. Safe to re-run: the result is deterministic.
//   npx tsx src/backfill-elo.ts          (dry run: prints what would change)
//   npx tsx src/backfill-elo.ts --apply  (writes users.rating / rated_games / games.*_change)
import { query, pool } from "./db.js";
import { FULL_STRENGTH_ELO, MIN_RATED_PLIES, START_RATING, eloChange, scoreOf, type Side } from "./elo.js";

const apply = process.argv.includes("--apply");

const users = await query<{ id: number; username: string; role: string; rating: number }>(`SELECT id, username, role, rating FROM users`);
const state = new Map(users.map((u) => [u.id, { rating: START_RATING, games: 0 }]));
const name = new Map(users.map((u) => [u.id, u.username]));
const role = new Map(users.map((u) => [u.id, u.role]));

const games = await query<any>(
  `SELECT g.id, g.white_id, g.black_id, g.result, g.vs_bot, g.bot_elo,
          (SELECT count(*) FROM moves m WHERE m.game_id = g.id)::int AS plies
   FROM games g WHERE g.status = 'finished' AND g.result IS NOT NULL ORDER BY g.ended_at, g.id`
);

const changes: { id: number; w: number | null; b: number | null }[] = [];
let rated = 0;
for (const g of games) {
  if (!g.white_id || !g.black_id || g.plies < MIN_RATED_PLIES) {
    changes.push({ id: g.id, w: null, b: null });
    continue;
  }
  const side = (id: number): Side => {
    const isBot = role.get(id) === "bot";
    if (isBot) return { rating: g.bot_elo ?? FULL_STRENGTH_ELO, games: 30, bot: true };
    const s = state.get(id)!;
    return { rating: s.rating, games: s.games, bot: false };
  };
  const { white, black } = eloChange(side(g.white_id), side(g.black_id), scoreOf(g.result));
  for (const [id, d] of [[g.white_id, white], [g.black_id, black]] as const) {
    if (d === null) continue;
    const s = state.get(id)!;
    s.rating = Math.max(100, s.rating + d);
    s.games++;
  }
  changes.push({ id: g.id, w: white, b: black });
  rated++;
}

console.log(`${games.length} finished games, ${rated} rated, ${games.length - rated} unrated (too short / incomplete)`);
for (const u of users) {
  if (role.get(u.id) === "bot") continue;
  const s = state.get(u.id)!;
  if (s.games || u.rating !== START_RATING) console.log(`${name.get(u.id)!.padEnd(20)} ${u.rating} -> ${s.rating}  (${s.games} rated games)`);
}

if (!apply) {
  console.log("\nDry run only. Re-run with --apply to write.");
} else {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`UPDATE users SET rating = $1, rated_games = 0`, [START_RATING]);
    for (const [id, s] of state) await client.query(`UPDATE users SET rating=$2, rated_games=$3 WHERE id=$1`, [id, s.rating, s.games]);
    for (const c of changes) await client.query(`UPDATE games SET white_change=$2, black_change=$3 WHERE id=$1`, [c.id, c.w, c.b]);
    await client.query("COMMIT");
    console.log("\nApplied.");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
await pool.end();
