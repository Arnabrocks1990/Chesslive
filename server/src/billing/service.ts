import crypto from "node:crypto";
import { query } from "../db.js";
import type { User } from "../auth.js";
import { DEFAULT_SETTINGS } from "./schema.js";
import { ownsPlayer } from "../coach/access.js";

export class BillingError extends Error {}

export async function getSettings(): Promise<Record<string, string>> {
  const rows = await query<{ key: string; value: string }>(`SELECT key, value FROM settings`);
  return { ...DEFAULT_SETTINGS, ...Object.fromEntries(rows.map((r) => [r.key, r.value])) };
}

export async function getPriceInr(): Promise<number> {
  return Number((await getSettings()).price_inr) || Number(DEFAULT_SETTINGS.price_inr);
}

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I to avoid misreads
const newReference = () => "CHS-" + Array.from(crypto.randomBytes(6), (b) => ALPHABET[b % ALPHABET.length]).join("");

export const UTR_RE = /^[A-Za-z0-9]{10,30}$/;

export interface PaymentRow {
  id: number; user_id: number; player_id: number | null; amount_inr: number; reference: string; utr: string | null;
  status: "created" | "pending" | "confirmed" | "rejected" | "revoked"; admin_note: string | null;
  created_at: string; submitted_at: string | null; decided_at: string | null;
}

const publicPayment = (p: PaymentRow | undefined) =>
  p && {
    id: p.id, reference: p.reference, amountInr: p.amount_inr, status: p.status, utr: p.utr, adminNote: p.admin_note,
    createdAt: p.created_at, submittedAt: p.submitted_at, decidedAt: p.decided_at,
  };

async function assertPlayer(user: User, playerId: number) {
  if (!(await ownsPlayer(user, playerId))) throw new BillingError("Coach profile not found");
}

const isActive = async (playerId: number) =>
  !!(await query(`SELECT 1 FROM subscriptions WHERE player_id=$1 AND status='active' AND expires_at > now() LIMIT 1`, [playerId]))[0];

/** The state the paywall renders: payee details, price and this user's latest payment for the player. */
export async function coachBilling(user: User, playerId: number) {
  await assertPlayer(user, playerId);
  const s = await getSettings();
  const [latest] = await query<PaymentRow>(`SELECT * FROM payments WHERE user_id=$1 AND player_id=$2 ORDER BY id DESC LIMIT 1`, [user.id, playerId]);
  const pay = publicPayment(latest);
  return {
    pro: await isActive(playerId),
    priceInr: Number(s.price_inr),
    upi: {
      id: s.upi_id,
      payee: s.payee_name,
      qr: "/payment-qr.png",
      link:
        pay && ["created", "pending"].includes(pay.status)
          ? `upi://pay?pa=${encodeURIComponent(s.upi_id)}&pn=${encodeURIComponent(s.payee_name)}&am=${pay.amountInr}&cu=INR&tn=${encodeURIComponent(pay.reference)}`
          : null,
    },
    payment: pay ?? null,
  };
}

/** Opens (or resumes) a payment for this user + coach player. Nothing is unlocked by this call. */
export async function startCheckout(user: User, playerId: number) {
  if (user.role === "guest") throw new BillingError("Create a free account (not a guest) before paying, so the payment stays linked to you");
  await assertPlayer(user, playerId);
  const [open] = await query<PaymentRow>(
    `SELECT * FROM payments WHERE user_id=$1 AND player_id=$2 AND status IN ('created','pending') ORDER BY id DESC LIMIT 1`,
    [user.id, playerId]
  );
  if (open) return;
  if (await isActive(playerId)) throw new BillingError("This coach profile is already unlocked");
  const [{ n }] = await query<{ n: number }>(`SELECT count(*)::int n FROM payments WHERE user_id=$1 AND status IN ('created','pending')`, [user.id]);
  if (n >= 3) throw new BillingError("You already have 3 open payments. Finish or wait for those first");
  await query(`INSERT INTO payments (user_id, player_id, amount_inr, reference) VALUES ($1,$2,$3,$4)`, [
    user.id, playerId, await getPriceInr(), newReference(),
  ]);
}

/** The payer says they have paid and gives the transaction id. Status becomes pending until an admin confirms. */
export async function submitUtr(user: User, paymentId: number, utrRaw: string) {
  const utr = String(utrRaw || "").trim().toUpperCase();
  if (!UTR_RE.test(utr)) throw new BillingError("Enter the transaction / UPI reference number from your payment app (10-30 letters or digits)");
  const [p] = await query<PaymentRow>(`SELECT * FROM payments WHERE id=$1 AND user_id=$2`, [paymentId, user.id]);
  if (!p) throw new BillingError("Payment not found");
  if (!["created", "pending"].includes(p.status)) throw new BillingError("This payment can no longer be edited");
  try {
    await query(`UPDATE payments SET utr=$2, status='pending', submitted_at=now() WHERE id=$1`, [p.id, utr]);
  } catch (e: any) {
    if (e.code === "23505") throw new BillingError("This transaction ID has already been used for another payment");
    throw e;
  }
}
