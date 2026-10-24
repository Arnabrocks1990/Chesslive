// Admin dashboard server. Separate process from the game server, on its own port (default 8003),
// bound to 127.0.0.1 only. The API itself lives in router.ts (the game server mounts it too).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { assertProductionConfig } from "../config.js";
import { ensureBaseSchema } from "../baseSchema.js";
import { ensureBillingSchema } from "../billing/schema.js";
import { ensureCoachSchema } from "../coach/schema.js";
import { adminRouter } from "./router.js";

const PORT = Number(process.env.ADMIN_PORT || 8003);
const HOST = "127.0.0.1";

const app = express();

// DNS-rebinding guard: only answer requests addressed to localhost on our port.
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);
app.use((req, res, next) => (ALLOWED_HOSTS.has(String(req.headers.host)) ? next() : void res.status(421).send("Misdirected request")));
app.use("/api/admin", adminRouter);

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
