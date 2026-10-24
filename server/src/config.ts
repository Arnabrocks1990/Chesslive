export const config = {
  port: Number(process.env.PORT || 8001),
  databaseUrl: process.env.DATABASE_URL || "postgresql://chess:chess@localhost:5455/chess",
  redisUrl: process.env.REDIS_URL || "redis://localhost:6380",
  jwtSecret: process.env.JWT_SECRET || "dev-only-secret-change-me",
  adminUsername: process.env.ADMIN_USERNAME || "admin",
  adminPassword: process.env.ADMIN_PASSWORD || "admin123",
  // AI text goes through the Anthropic API (ANTHROPIC_API_KEY in server/.env). EXPLAIN=0 turns it off;
  // without a key every AI feature falls back to its rule-based version.
  explain: process.env.EXPLAIN !== "0" && !!process.env.ANTHROPIC_API_KEY,
  claudeModel: process.env.CLAUDE_MODEL || "claude-sonnet-5-5",
  claudeTimeoutMs: Number(process.env.CLAUDE_TIMEOUT_MS || 90_000),
};

/** In production (NODE_ENV=production) refuse to run with the development defaults for secrets. */
export function assertProductionConfig() {
  if (process.env.NODE_ENV !== "production") return;
  const problems: string[] = [];
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET === "dev-only-secret-change-me" || process.env.JWT_SECRET.length < 24) {
    problems.push("JWT_SECRET must be set to a random value of at least 24 characters");
  }
  if (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD === "admin123" || process.env.ADMIN_PASSWORD.length < 12) {
    problems.push("ADMIN_PASSWORD must be set to something other than the default, at least 12 characters");
  }
  if (problems.length) throw new Error("Refusing to start in production:\n - " + problems.join("\n - "));
}
