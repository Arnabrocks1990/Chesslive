import pg from "pg";
import { config } from "./config.js";

// DATABASE_SSL=require encrypts the connection without verifying the certificate (libpq's sslmode=require),
// which is what Render documents for its external Postgres URL. Render's internal URL needs no SSL setting.
const ssl = process.env.DATABASE_SSL === "require" ? { rejectUnauthorized: false } : undefined;
export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  ssl,
  connectionTimeoutMillis: 8_000, // fail fast instead of hanging when Postgres is unreachable
  query_timeout: 30_000,
  keepAlive: true,
  max: 10,
});
// An idle connection dying (Postgres restarted, Docker paused) emits 'error'. Unhandled, that crashes the process.
pool.on("error", (e) => console.error("postgres pool error (will reconnect):", e.message));

/** True for errors that mean 'the database is unreachable right now' rather than 'the code is wrong'. */
export function isDbUnavailable(e: any): boolean {
  const codes = ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "57P01", "57P02", "57P03", "08006", "08001", "08004"];
  return codes.includes(e?.code) || /timeout exceeded|Connection terminated|connect ECONN|Query read timeout/i.test(String(e?.message));
}


export async function query<T = any>(text: string, params: any[] = []): Promise<T[]> {
  const res = await pool.query(text, params);
  return res.rows as T[];
}
