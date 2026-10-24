import { Redis } from "ioredis";
import { config } from "../src/config.js";
import { query, pool } from "../src/db.js";
import { ensureCoachSchema } from "../src/coach/schema.js";
import { fetchLichess, storeGame } from "../src/coach/importer.js";
import { queueAnalysis, waitForAnalysis } from "../src/coach/analysis.js";
import { tagStoredGame } from "../src/coach/tagger.js";

const user = process.argv[2] || "DrNykterstein";
const n = Number(process.argv[3] || 2);
await ensureCoachSchema();
const redis = new Redis(config.redisUrl);
const [p] = await query<{ id: number }>(
  `INSERT INTO players (platform, username, share_token) VALUES ('lichess',$1,md5(random()::text)) ON CONFLICT (platform, username) DO UPDATE SET username=EXCLUDED.username RETURNING id`, [user]);
const games = await fetchLichess(user, n);
console.log("fetched", games.length);
for (const g of games) {
  const id = await storeGame(p.id, "lichess", g);
  if (!id) { console.log("already imported", g.externalId); continue; }
  const [row] = await query<{ code: string }>(`SELECT code FROM games WHERE id=$1`, [id]);
  const t0 = Date.now();
  const queued = await queueAnalysis(redis, id, row.code);
  const ok = await waitForAnalysis(id, 300_000, () => {});
  const tags = await tagStoredGame(id);
  console.log(`game ${g.externalId}: ${g.sans.length} plies, queued ${queued}, done=${ok} in ${((Date.now() - t0) / 1000).toFixed(1)}s, mistakes=${tags.length}`);
  for (const t of tags.slice(0, 6)) console.log("  ", t.ply, t.severity, t.phase, t.themes.join(","), t.playedSan, "->", t.bestSan, `(-${t.drop})`);
}
redis.disconnect(); await pool.end();
