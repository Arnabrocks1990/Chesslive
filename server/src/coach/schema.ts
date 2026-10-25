import { query } from "../db.js";
import { VERIFY_DDL } from "./verify.js";

// Idempotent: runs on every boot so existing databases pick up the coach tables without a volume reset.
export async function ensureCoachSchema() {
  const ddl = [
    `ALTER TABLE games ADD COLUMN IF NOT EXISTS source TEXT`,
    `ALTER TABLE games ADD COLUMN IF NOT EXISTS external_id TEXT`,
    `ALTER TABLE games ADD COLUMN IF NOT EXISTS player_id INT`,
    `ALTER TABLE games ADD COLUMN IF NOT EXISTS player_color TEXT`,
    `ALTER TABLE games ADD COLUMN IF NOT EXISTS played_at TIMESTAMPTZ`,
    // Was global (source, external_id), which made a second player's import of the same game silently store nothing.
    `DROP INDEX IF EXISTS games_source_ext`,
    `CREATE UNIQUE INDEX IF NOT EXISTS games_player_source_ext ON games(player_id, source, external_id) WHERE external_id IS NOT NULL`,
    `CREATE TABLE IF NOT EXISTS players (
       id SERIAL PRIMARY KEY,
       platform TEXT NOT NULL,            -- lichess | chesscom | pgn
       username TEXT NOT NULL,
       goal TEXT,
       autopoll BOOLEAN NOT NULL DEFAULT true,
       share_token TEXT UNIQUE NOT NULL,
       last_checked_at TIMESTAMPTZ,
       created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
       UNIQUE (platform, username))`,
    // Profiles are private to the user who created them (admins see all).
    `ALTER TABLE players ADD COLUMN IF NOT EXISTS owner_id INT REFERENCES users(id)`,
    `ALTER TABLE players DROP CONSTRAINT IF EXISTS players_platform_username_key`,
    `CREATE UNIQUE INDEX IF NOT EXISTS players_owner_platform_username ON players (owner_id, platform, username)`,
    VERIFY_DDL,
    `UPDATE players SET owner_id = (SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1) WHERE owner_id IS NULL`,
    `CREATE TABLE IF NOT EXISTS mistakes (
       id SERIAL PRIMARY KEY,
       game_id INT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
       player_id INT NOT NULL,
       ply INT NOT NULL,
       severity TEXT NOT NULL,            -- inaccuracy | mistake | blunder
       phase TEXT NOT NULL,               -- opening | middlegame | endgame
       themes TEXT[] NOT NULL,
       win_pct_drop REAL NOT NULL,
       played_san TEXT NOT NULL,
       best_san TEXT,
       best_uci TEXT,
       fen_before TEXT NOT NULL,
       pv TEXT,
       eval_before_cp INT,
       eval_after_cp INT,
       explanation TEXT,
       UNIQUE (game_id, ply))`,
    `CREATE TABLE IF NOT EXISTS drills (
       id SERIAL PRIMARY KEY,
       player_id INT NOT NULL,
       mistake_id INT NOT NULL REFERENCES mistakes(id) ON DELETE CASCADE,
       due_at TIMESTAMPTZ NOT NULL DEFAULT now(),
       attempts INT NOT NULL DEFAULT 0,
       passes INT NOT NULL DEFAULT 0,
       last_result TEXT,
       interval_days INT NOT NULL DEFAULT 1,
       UNIQUE (player_id, mistake_id))`,
    `CREATE TABLE IF NOT EXISTS plans (
       id SERIAL PRIMARY KEY,
       player_id INT NOT NULL,
       version INT NOT NULL,
       focus_themes JSONB NOT NULL,
       diagnosis TEXT,
       items JSONB NOT NULL,
       rationale TEXT,
       nudge TEXT,
       created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
    `CREATE TABLE IF NOT EXISTS plan_sessions (
       id SERIAL PRIMARY KEY,
       player_id INT NOT NULL,
       plan_id INT NOT NULL,
       day INT NOT NULL,
       type TEXT NOT NULL,                -- drill | review | play
       theme TEXT,
       title TEXT NOT NULL,
       detail TEXT,
       minutes INT NOT NULL DEFAULT 10,
       goal TEXT NOT NULL,
       status TEXT NOT NULL DEFAULT 'pending',   -- pending | active | retry | done
       attempts INT NOT NULL DEFAULT 0,
       score INT,
       total INT,
       passed BOOLEAN,
       game_code TEXT,
       started_at TIMESTAMPTZ,
       completed_at TIMESTAMPTZ,
       UNIQUE (plan_id, day))`,
    `CREATE TABLE IF NOT EXISTS session_questions (
       id SERIAL PRIMARY KEY,
       session_id INT NOT NULL REFERENCES plan_sessions(id) ON DELETE CASCADE,
       attempt INT NOT NULL,
       mistake_id INT NOT NULL,
       result TEXT,
       answered_at TIMESTAMPTZ)`,
    `ALTER TABLE session_questions ADD COLUMN IF NOT EXISTS hints_used INT NOT NULL DEFAULT 0`,
    `CREATE TABLE IF NOT EXISTS plain_cache (
       plan_id INT PRIMARY KEY,
       data JSONB NOT NULL,
       created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
    `CREATE TABLE IF NOT EXISTS subscriptions (
       id SERIAL PRIMARY KEY,
       player_id INT NOT NULL,
       status TEXT NOT NULL,              -- active | cancelled
       provider TEXT NOT NULL,            -- demo | razorpay | stripe
       reference TEXT,
       amount_inr INT NOT NULL,
       started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
       expires_at TIMESTAMPTZ NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS agent_runs (
       id SERIAL PRIMARY KEY,
       player_id INT NOT NULL,
       trigger TEXT NOT NULL,
       status TEXT NOT NULL DEFAULT 'running',  -- running | done | failed
       mode TEXT,                                -- llm | rules
       decision JSONB,
       error TEXT,
       started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
       ended_at TIMESTAMPTZ)`,
    `CREATE TABLE IF NOT EXISTS agent_steps (
       id SERIAL PRIMARY KEY,
       run_id INT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
       n INT NOT NULL,
       tool TEXT NOT NULL,
       input JSONB,
       output_summary TEXT,
       note TEXT,
       ts TIMESTAMPTZ NOT NULL DEFAULT now())`,
  ];
  for (const sql of ddl) await query(sql);
}
