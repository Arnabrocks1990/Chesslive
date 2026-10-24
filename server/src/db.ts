import pg from "pg";
import { config } from "./config.js";

// DATABASE_SSL=require encrypts the connection without verifying the certificate (libpq's sslmode=require),
// which is what Render documents for its external Postgres URL. Render's internal URL needs no SSL setting.
const ssl = process.env.DATABASE_SSL === "require" ? { rejectUnauthorized: false } : undefined;
export const pool = new pg.Pool({ connectionString: config.databaseUrl, ssl });

export async function query<T = any>(text: string, params: any[] = []): Promise<T[]> {
  const res = await pool.query(text, params);
  return res.rows as T[];
}
