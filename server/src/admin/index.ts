// Admin dashboard server. Separate process from the game server, on its own port (default 8003),
// bound to 127.0.0.1 only. It is the ONLY place a payment can be confirmed.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import * as auth from "../auth.js";
import { assertProductionConfig, config } from "../config.js";
import { ensureBaseSchema } from "../baseSchema.js";
import { pool, query } from "../db.js";
import { ensureBillingSchema } from "../billing/schema.js";
import { getSettings } from "../billing/service.js";
import { ensureCoachSchema } from "../coach/schema.js";

const PORT = Number(process.env.ADMIN_PORT || 8003);
const HOST = "127.0.0.1";
const SUBSCRIPTION_DAYS = 30; // must match the coach's subscription length

const app = express();
app.use(express.json({ limit: "1mb" })); // room for the QR image upload

// DNS-rebinding guard: only answer requests addressed to localhost on our port.
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);
app.use((req, res, next) => (ALLOWED_HOSTS.has(String(req.headers.host)) ? next() : void res.status(421).send("Misdirected request")));

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
const wrap =
  (fn: (req: express.Request, res: express.Response) => Promise<unknown>) =>
  (req: express.Request, res: express.Response) =>
    fn(req, res).catch((e) => {
      if (e instanceof HttpError) return void res.status(e.status).json({ error: e.message });
      console.error(e);
      res.status(500).json({ error: "Server error" });
    });

// ---- auth -----------------------------------------------------------------

const attempts = new Map<string, { n: number; reset: number }>();
app.post("/api/admin/login", wrap(async (req, res) => {
  const ip = req.socket.remoteAddress ?? "?";
  const a = attempts.get(ip);
  if (a && a.reset > Date.now() && a.n >= 8) throw new HttpError(429, "Too many attempts. Try again in a few minutes.");
  try {
    const user = await auth.login(String(req.body?.username ?? ""), String(req.body?.password ?? ""));
    if (user.role !== "admin") throw new Error("Invalid username or password");
    attempts.delete(ip);
    res.json({ token: auth.signToken(user), user });
  } catch {
    const cur = a && a.reset > Date.now() ? a : { n: 0, reset: Date.now() + 5 * 60_000 };
    cur.n++;
    attempts.set(ip, cur);
    throw new HttpError(401, "Invalid username or password");
  }
}));

type AdminReq = express.Request & { admin: { id: number; username: string } };
const requireAdmin: express.RequestHandler = (req, res, next) => {
  const user = auth.verifyToken((req.headers.authorization || "").replace(/^Bearer /, ""));
  if (!user || user.role !== "admin") return void res.status(401).json({ error: "Admin sign-in required" });
  // the token is only a hint; confirm against the database that the account is still an admin
  query<{ role: string }>(`SELECT role FROM users WHERE id=$1`, [user.id]).then(([row]) => {
    if (row?.role !== "admin") return void res.status(401).json({ error: "Admin sign-in required" });
    (req as AdminReq).admin = { id: user.id, username: user.username };
    next();
  }, next);
};
app.use("/api/admin", (req, res, next) => (req.path === "/login" ? next() : requireAdmin(req, res, next)));
const me = (req: express.Request) => (req as AdminReq).admin;

app.get("/api/admin/me", (req, res) =>
  res.json({ user: me(req), defaultPassword: config.adminPassword === "admin123", aiConfigured: !!process.env.ANTHROPIC_API_KEY })
);

// ---- overview ---------------------------------------------------------------

const safe = async <T>(p: Promise<T>, fallback: T): Promise<T> => p.catch(() => fallback);

app.get("/api/admin/overview", wrap(async (_req, res) => {
  const [t] = await query<any>(`
    SELECT
      (SELECT count(*) FROM users WHERE role <> 'bot')::int AS users,
      (SELECT count(*) FROM users WHERE role = 'guest')::int AS guests,
      (SELECT count(*) FROM users WHERE role <> 'bot' AND created_at > now() - interval '7 days')::int AS new_users_7d,
      (SELECT count(*) FROM users WHERE last_seen_at > now() - interval '24 hours')::int AS active_24h,
      (SELECT count(*) FROM games)::int AS games,
      (SELECT count(*) FROM games WHERE status = 'active')::int AS active_games,
      (SELECT count(*) FROM games WHERE status = 'finished')::int AS finished_games,
      (SELECT count(*) FROM games WHERE vs_bot)::int AS bot_games,
      (SELECT count(*) FROM moves)::int AS moves,
      (SELECT count(*) FROM analyses)::int AS analyses,
      (SELECT count(*) FROM position_embeddings)::int AS embeddings,
      (SELECT count(*) FROM payments WHERE status = 'pending')::int AS pending_payments,
      (SELECT count(*) FROM payments WHERE status = 'created')::int AS unsubmitted_payments,
      (SELECT count(*) FROM payments WHERE status = 'confirmed')::int AS confirmed_payments,
      (SELECT count(*) FROM payments WHERE status = 'rejected')::int AS rejected_payments,
      (SELECT coalesce(sum(amount_inr), 0) FROM payments WHERE status = 'confirmed')::int AS revenue_inr,
      (SELECT coalesce(sum(amount_inr), 0) FROM payments WHERE status = 'pending')::int AS pending_inr`);
  const series = await query(`
    SELECT to_char(d::date, 'YYYY-MM-DD') AS day,
           (SELECT count(*) FROM users u WHERE u.created_at::date = d::date AND u.role <> 'bot')::int AS signups,
           (SELECT count(*) FROM games g WHERE g.created_at::date = d::date)::int AS games
    FROM generate_series(now()::date - 13, now()::date, interval '1 day') d ORDER BY d`);
  const coach = await safe(
    query<any>(`
      SELECT (SELECT count(*) FROM players)::int AS profiles,
             (SELECT count(*) FROM agent_runs)::int AS runs,
             (SELECT count(*) FROM agent_runs WHERE status = 'failed')::int AS failed_runs,
             (SELECT count(*) FROM subscriptions WHERE status = 'active' AND expires_at > now())::int AS active_subs,
             (SELECT count(*) FROM subscriptions WHERE status = 'active' AND expires_at > now() AND provider = 'demo')::int AS demo_subs`).then((r) => r[0]),
    null
  );
  const [model] = await safe(query<any>(`SELECT n_samples, n_games, accuracy, trained_at FROM model_weights ORDER BY id DESC LIMIT 1`), []);
  res.json({ totals: t, series, coach, model: model ?? null });
}));

// ---- users --------------------------------------------------------------------

app.get("/api/admin/users", wrap(async (req, res) => {
  const q = String(req.query.q ?? "").trim().slice(0, 40);
  res.json(
    await query(
      `SELECT u.id, u.username, u.role, u.rating, u.rated_games, u.created_at, u.last_seen_at,
              (SELECT count(*) FROM games g WHERE g.white_id = u.id OR g.black_id = u.id)::int AS games,
              (SELECT max(g.created_at) FROM games g WHERE g.white_id = u.id OR g.black_id = u.id) AS last_game_at,
              (SELECT count(*) FROM payments p WHERE p.user_id = u.id AND p.status = 'confirmed')::int AS paid_count,
              (SELECT coalesce(sum(p.amount_inr), 0) FROM payments p WHERE p.user_id = u.id AND p.status = 'confirmed')::int AS paid_inr,
              (SELECT status FROM payments p WHERE p.user_id = u.id ORDER BY p.id DESC LIMIT 1) AS payment_status
       FROM users u WHERE u.role <> 'bot' AND ($1 = '' OR u.username ILIKE '%' || $1 || '%')
       ORDER BY u.created_at DESC LIMIT 300`,
      [q]
    )
  );
}));

app.get("/api/admin/users/:id", wrap(async (req, res) => {
  const id = Number(req.params.id);
  const [user] = await query<any>(`SELECT id, username, role, rating, rated_games, created_at, last_seen_at FROM users WHERE id=$1 AND role <> 'bot'`, [id]);
  if (!user) throw new HttpError(404, "User not found");
  const games = await query(
    `SELECT g.code, g.status, g.result, g.termination, g.vs_bot, g.created_at,
            w.username AS white, b.username AS black, CASE WHEN g.white_id = $1 THEN g.white_change ELSE g.black_change END AS elo_change
     FROM games g LEFT JOIN users w ON w.id = g.white_id LEFT JOIN users b ON b.id = g.black_id
     WHERE g.white_id = $1 OR g.black_id = $1 ORDER BY g.created_at DESC LIMIT 25`,
    [id]
  );
  const payments = await query(
    `SELECT p.id, p.reference, p.utr, p.status, p.amount_inr, p.admin_note, p.created_at, p.submitted_at, p.decided_at, pl.username AS player_username
     FROM payments p LEFT JOIN players pl ON pl.id = p.player_id WHERE p.user_id = $1 ORDER BY p.id DESC`,
    [id]
  );
  res.json({ user, games, payments });
}));

// ---- games ----------------------------------------------------------------------

app.get("/api/admin/games", wrap(async (req, res) => {
  const status = ["waiting", "active", "finished"].includes(String(req.query.status)) ? String(req.query.status) : "";
  res.json(
    await query(
      `SELECT g.id, g.code, g.status, g.result, g.termination, g.vs_bot, g.bot_elo, g.time_control_sec, g.increment_sec,
              g.created_at, g.ended_at, g.white_change, g.black_change,
              w.username AS white, b.username AS black,
              (SELECT count(*) FROM moves m WHERE m.game_id = g.id)::int AS plies
       FROM games g LEFT JOIN users w ON w.id = g.white_id LEFT JOIN users b ON b.id = g.black_id
       WHERE g.player_id IS NULL AND ($1 = '' OR g.status = $1) ORDER BY g.created_at DESC LIMIT 300`,
      [status]
    )
  );
}));

// ---- coach profiles + subscriptions ----------------------------------------------

app.get("/api/admin/coach", wrap(async (_req, res) => {
  const profiles = await safe(
    query(`SELECT pl.id, pl.platform, pl.username, pl.goal, pl.created_at, pl.last_checked_at,
                  (SELECT u.username FROM users u WHERE u.id = pl.owner_id) AS owner,
                  (SELECT count(*) FROM games g WHERE g.player_id = pl.id)::int AS games,
                  (SELECT count(*) FROM agent_runs r WHERE r.player_id = pl.id)::int AS runs,
                  EXISTS(SELECT 1 FROM subscriptions s WHERE s.player_id = pl.id AND s.status = 'active' AND s.expires_at > now()) AS pro
           FROM players pl ORDER BY pl.created_at DESC LIMIT 300`),
    []
  );
  const subscriptions = await safe(
    query(`SELECT s.id, s.player_id, pl.platform, pl.username AS player_username, s.status, s.provider, s.reference, s.amount_inr, s.started_at, s.expires_at
           FROM subscriptions s LEFT JOIN players pl ON pl.id = s.player_id ORDER BY s.id DESC LIMIT 300`),
    []
  );
  res.json({ profiles, subscriptions });
}));

// ---- payments ---------------------------------------------------------------------

const PAYMENT_STATUSES = ["created", "pending", "confirmed", "rejected", "revoked"];

app.get("/api/admin/payments", wrap(async (req, res) => {
  const status = PAYMENT_STATUSES.includes(String(req.query.status)) ? String(req.query.status) : "";
  res.json(
    await query(
      `SELECT p.id, p.user_id, u.username, u.role AS user_role, p.player_id, pl.platform, pl.username AS player_username,
              p.plan, p.amount_inr, p.reference, p.utr, p.status, p.admin_note,
              p.created_at, p.submitted_at, p.decided_at, a.username AS decided_by_name
       FROM payments p
       JOIN users u ON u.id = p.user_id
       LEFT JOIN players pl ON pl.id = p.player_id
       LEFT JOIN users a ON a.id = p.decided_by
       WHERE ($1 = '' OR p.status = $1)
       ORDER BY (p.status = 'pending') DESC, COALESCE(p.submitted_at, p.created_at) DESC LIMIT 300`,
      [status]
    )
  );
}));

/** Moves a payment to a new status inside one transaction, with the subscription change and an audit row. */
async function decide(paymentId: number, adminId: number, to: "confirmed" | "rejected" | "revoked", from: string[], note: string) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const { rows } = await c.query(
      `UPDATE payments SET status=$2, admin_note=$3, decided_at=now(), decided_by=$4
       WHERE id=$1 AND status = ANY($5) RETURNING *`,
      [paymentId, to, note || null, adminId, from]
    );
    const p = rows[0];
    if (!p) throw new HttpError(409, `This payment is not ${from.join(" or ")} any more. Refresh the list.`);
    if (to === "confirmed" && p.player_id) {
      await c.query(
        `INSERT INTO subscriptions (player_id, status, provider, reference, amount_inr, expires_at)
         VALUES ($1, 'active', 'upi_qr', $2, $3, now() + ($4 || ' days')::interval)`,
        [p.player_id, p.reference, p.amount_inr, String(SUBSCRIPTION_DAYS)]
      );
    }
    if (to === "revoked") {
      await c.query(`UPDATE subscriptions SET status='cancelled' WHERE provider='upi_qr' AND reference=$1`, [p.reference]);
    }
    await c.query(`INSERT INTO admin_audit (admin_id, action, target_type, target_id, detail) VALUES ($1,$2,'payment',$3,$4)`, [
      adminId, `payment.${to}`, paymentId,
      JSON.stringify({ reference: p.reference, utr: p.utr, amount_inr: p.amount_inr, user_id: p.user_id, player_id: p.player_id, note: note || null }),
    ]);
    await c.query("COMMIT");
    return p;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}

const noteOf = (req: express.Request) => String(req.body?.note ?? "").trim().slice(0, 300);
app.post("/api/admin/payments/:id/confirm", wrap(async (req, res) => res.json(await decide(Number(req.params.id), me(req).id, "confirmed", ["created", "pending"], noteOf(req)))));
app.post("/api/admin/payments/:id/reject", wrap(async (req, res) => {
  const note = noteOf(req);
  if (!note) throw new HttpError(400, "Give the payer a short reason (they will see it)");
  res.json(await decide(Number(req.params.id), me(req).id, "rejected", ["created", "pending"], note));
}));
app.post("/api/admin/payments/:id/revoke", wrap(async (req, res) => {
  const note = noteOf(req);
  if (!note) throw new HttpError(400, "A reason is required to revoke access");
  res.json(await decide(Number(req.params.id), me(req).id, "revoked", ["confirmed"], note));
}));

// ---- settings + audit ------------------------------------------------------------------

const QR_KEYS = ["qr_image", "qr_type"];
app.get("/api/admin/settings", wrap(async (_req, res) => {
  const all = await getSettings();
  res.json({ ...Object.fromEntries(Object.entries(all).filter(([k]) => !QR_KEYS.includes(k))), qr_set: !!all.qr_image });
}));

// Upload the payment QR image (PNG or JPEG, up to ~600 KB). Stored in the database, served by the game server.
app.post("/api/admin/settings/qr", wrap(async (req, res) => {
  const m = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/.exec(String(req.body?.dataUrl ?? ""));
  if (!m) throw new HttpError(400, "Choose a PNG or JPEG image");
  const bytes = Buffer.from(m[2], "base64");
  if (bytes.length > 600_000) throw new HttpError(400, "Image is too large (limit about 600 KB)");
  const isPng = bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const isJpeg = bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
  if (!(m[1] === "image/png" ? isPng : isJpeg)) throw new HttpError(400, "That file is not a valid image");
  for (const [k, v] of [["qr_image", m[2]], ["qr_type", m[1]]]) {
    await query(`INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [k, v]);
  }
  await query(`INSERT INTO admin_audit (admin_id, action, target_type, detail) VALUES ($1,'settings.qr','settings',$2)`, [
    me(req).id, JSON.stringify({ type: m[1], bytes: bytes.length }),
  ]);
  res.json({ ok: true, bytes: bytes.length });
}));
app.post("/api/admin/settings", wrap(async (req, res) => {
  const b = req.body ?? {};
  const price = Number(b.price_inr);
  if (!Number.isInteger(price) || price < 1 || price > 100000) throw new HttpError(400, "Price must be a whole number of rupees between 1 and 100000");
  const upi = String(b.upi_id ?? "").trim();
  if (!/^[A-Za-z0-9._-]{2,}@[A-Za-z0-9]{2,}$/.test(upi)) throw new HttpError(400, "That does not look like a UPI ID (name@bank)");
  const payee = String(b.payee_name ?? "").trim().slice(0, 60);
  if (!payee) throw new HttpError(400, "Payee name is required");
  const next = { price_inr: String(price), upi_id: upi, payee_name: payee };
  const before = await getSettings();
  for (const [k, v] of Object.entries(next)) {
    await query(`INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [k, v]);
  }
  await query(`INSERT INTO admin_audit (admin_id, action, target_type, detail) VALUES ($1,'settings.update','settings',$2)`, [
    me(req).id, JSON.stringify({ before: Object.fromEntries(Object.keys(next).map((k) => [k, before[k]])), after: next }),
  ]);
  res.json(await getSettings());
}));

app.get("/api/admin/audit", wrap(async (_req, res) =>
  res.json(
    await query(
      `SELECT a.id, a.action, a.target_type, a.target_id, a.detail, a.created_at, u.username AS admin
       FROM admin_audit a LEFT JOIN users u ON u.id = a.admin_id ORDER BY a.id DESC LIMIT 200`
    )
  )
));

// ---- static UI + boot ----------------------------------------------------------------------

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../admin/dist");
if (fs.existsSync(dist)) {
  app.use("/assets", express.static(path.join(dist, "assets"), { immutable: true, maxAge: "1y", fallthrough: false }));
  app.use("/assets", (_err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(404).type("text/plain").send("Not found"));
  app.get(/^\/(?!api).*/, (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.sendFile(path.join(dist, "index.html"));
  });
} else {
  app.get("/", (_req, res) => res.status(503).send("Admin UI is not built yet. Run: cd admin && npm install && npm run build"));
}

// Deliberately no ensureAdmin() here: this process often runs on a laptop against the production database,
// and it must never reset the production admin password. The web server owns the admin account.
assertProductionConfig();
await ensureBaseSchema();
await ensureBillingSchema();
await ensureCoachSchema();
app.listen(PORT, HOST, () => console.log(`Admin dashboard on http://localhost:${PORT} (bound to ${HOST} only)`));
