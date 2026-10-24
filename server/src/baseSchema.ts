import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./db.js";

/**
 * Applies db/init.sql (idempotent: CREATE ... IF NOT EXISTS) so a brand-new database, such as a fresh
 * Render Postgres, gets the base tables and the pgvector extension. Docker still runs the same file on
 * first start. An advisory lock keeps the web server and the admin server from racing on a fresh DB.
 */
export async function ensureBaseSchema() {
  const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../db/init.sql");
  const sql = fs.readFileSync(file, "utf8");
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(727001)");
    await client.query(sql);
  } finally {
    await client.query("SELECT pg_advisory_unlock(727001)").catch(() => undefined);
    client.release();
  }
}
