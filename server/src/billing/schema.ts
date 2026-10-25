import { query } from "../db.js";

export const DEFAULT_SETTINGS: Record<string, string> = {
  price_inr: "299", // per coach player, per 30 days (matches the existing coach price)
  // First-boot defaults only; after that the admin dashboard (Settings) is the source of truth.
  upi_id: process.env.UPI_ID || "yourname@bank",
  payee_name: process.env.PAYEE_NAME || "Your Name",
};

/** Idempotent: safe to run on every boot of either server. */
export async function ensureBillingSchema() {
  const stmts = [
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS blocked_at TIMESTAMPTZ`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS blocked_reason TEXT`,
    `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS payments (
       id           SERIAL PRIMARY KEY,
       user_id      INT NOT NULL REFERENCES users(id),
       player_id    INT,                      -- the coach player this payment unlocks
       plan         TEXT NOT NULL DEFAULT 'coach_pro',
       amount_inr   INT NOT NULL,
       reference    TEXT UNIQUE NOT NULL,     -- shown to the payer, put in the UPI note
       utr          TEXT,                     -- transaction id entered by the payer
       status       TEXT NOT NULL DEFAULT 'created', -- created | pending | confirmed | rejected | revoked
       admin_note   TEXT,
       created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
       submitted_at TIMESTAMPTZ,
       decided_at   TIMESTAMPTZ,
       decided_by   INT REFERENCES users(id))`,
    // one transaction id can back only one live payment
    `CREATE UNIQUE INDEX IF NOT EXISTS payments_utr_live ON payments (utr) WHERE utr IS NOT NULL AND status IN ('pending','confirmed')`,
    `CREATE INDEX IF NOT EXISTS payments_status ON payments (status, created_at DESC)`,
    `CREATE TABLE IF NOT EXISTS admin_audit (
       id SERIAL PRIMARY KEY,
       admin_id INT REFERENCES users(id),
       action TEXT NOT NULL,
       target_type TEXT,
       target_id INT,
       detail JSONB,
       created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  ];
  for (const s of stmts) await query(s);
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    await query(`INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO NOTHING`, [k, v]);
  }
}
