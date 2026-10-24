import type { Express, Request, Response } from "express";
import type { User } from "../auth.js";
import { isDbUnavailable } from "../db.js";
import { BillingError, coachBilling, startCheckout, submitUtr } from "./service.js";

type Authed = (req: Request, res: Response) => User | null;

/** Player-facing payment endpoints. Nothing here can confirm a payment; only the admin server can. */
export function registerBillingRoutes(app: Express, authed: Authed) {
  const guard = (fn: (req: Request, res: Response, user: User) => Promise<unknown>) => (req: Request, res: Response) => {
    const user = authed(req, res);
    if (!user) return;
    fn(req, res, user).catch((e) => {
      if (e instanceof BillingError) return void res.status(400).json({ error: e.message });
      if (isDbUnavailable(e)) return void res.status(503).json({ error: "The server could not reach its database. Please try again in a moment." });
      console.error(e);
      res.status(500).json({ error: "Server error" });
    });
  };

  app.get("/api/billing/coach/:playerId", guard(async (req, res, user) => res.json(await coachBilling(user, Number(req.params.playerId)))));

  app.post("/api/billing/coach/:playerId/checkout", guard(async (req, res, user) => {
    const pid = Number(req.params.playerId);
    await startCheckout(user, pid);
    res.json(await coachBilling(user, pid));
  }));

  app.post("/api/billing/payments/:id/submit", guard(async (req, res, user) => {
    await submitUtr(user, Number(req.params.id), req.body?.utr);
    res.json({ ok: true });
  }));
}
