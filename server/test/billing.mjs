// End-to-end test of the QR payment flow: player (8001) <-> admin dashboard API (8003).
// Needs both servers running. Creates throwaway users and a throwaway coach profile.
import http from "node:http";
import crypto from "node:crypto";
import pg from "pg";

const MAIN = "http://localhost:8001", ADMIN = "http://localhost:8003";
const tag = crypto.randomBytes(3).toString("hex");
let failed = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  -> " + extra : ""}`); if (!ok) failed++; };

const call = async (base, path, { body, token, method } = {}) => {
  const res = await fetch(base + path, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json", ...(token && { authorization: "Bearer " + token }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
};
const register = async (name) => (await call(MAIN, "/api/register", { body: { username: `${name}_${tag}`, password: "secret123" } })).data;

const db = new pg.Pool({ connectionString: "postgresql://chess:chess@localhost:5455/chess" });
const alice = await register("alice"), bob = await register("bob");
const { rows: [player] } = await db.query(
  `INSERT INTO players (platform, username, share_token, owner_id) VALUES ('pgn', $1, $2, $3) RETURNING id`,
  [`billtest_${tag}`, crypto.randomBytes(8).toString("hex"), alice.user.id]);
const pid = player.id;
const guest = (await call(MAIN, "/api/guest", { body: { name: "Gus" } })).data;
const admin = (await call(ADMIN, "/api/admin/login", { body: { username: "admin", password: process.env.ADMIN_PASSWORD || "admin123" } })).data;
check("admin can sign in to the dashboard", !!admin.token);

// --- before paying
let r = await call(MAIN, `/api/billing/coach/${pid}`, { token: alice.token });
check("before payment: locked, no payment, price + UPI shown", r.data.pro === false && r.data.payment === null && r.data.priceInr > 0 && r.data.upi.id.includes("@"), JSON.stringify({ price: r.data.priceInr, upi: r.data.upi.id }));
r = await call(MAIN, `/api/coach/players/${pid}`, { token: alice.token });
check("coach reports pro=false before payment", r.data.access?.pro === false);

// --- bypasses are closed
r = await call(MAIN, `/api/coach/players/${pid}/checkout`, { body: {}, token: alice.token });
check("old free demo checkout is refused (410)", r.status === 410);
r = await call(MAIN, `/api/billing/coach/${pid}/checkout`, { body: {}, token: guest.token });
check("guest accounts cannot start a payment", r.status === 400, r.data.error);
r = await call(MAIN, `/api/admin/payments`, { token: alice.token });
check("game server has no admin/confirm endpoint", r.status === 404);

// --- checkout + submit
r = await call(MAIN, `/api/billing/coach/${pid}/checkout`, { body: {}, token: alice.token });
const pay = r.data.payment;
check("checkout creates a 'created' payment with a reference", pay?.status === "created" && /^CHS-[A-Z0-9]{6}$/.test(pay.reference), pay?.reference);
const again = await call(MAIN, `/api/billing/coach/${pid}/checkout`, { body: {}, token: alice.token });
check("repeated checkout resumes the same payment", again.data.payment.id === pay.id);
check("UPI deep link carries amount + reference", r.data.upi.link?.includes(`am=${pay.amountInr}`) && r.data.upi.link.includes(pay.reference));
r = await call(MAIN, `/api/billing/payments/${pay.id}/submit`, { body: { utr: "123" }, token: alice.token });
check("invalid transaction id rejected", r.status === 400);
r = await call(MAIN, `/api/billing/payments/${pay.id}/submit`, { body: { utr: "412345678901" }, token: bob.token });
check("another user cannot submit alice's payment", r.status === 400);
const utr = "4" + Math.floor(Math.random() * 1e11).toString().padStart(11, "0");
r = await call(MAIN, `/api/billing/payments/${pay.id}/submit`, { body: { utr }, token: alice.token });
check("alice submits her transaction id", r.status === 200);
r = await call(MAIN, `/api/billing/coach/${pid}`, { token: alice.token });
check("status is now 'pending' and still locked", r.data.payment.status === "pending" && r.data.pro === false);
r = await call(MAIN, `/api/coach/players/${pid}`, { token: alice.token });
check("coach still locked while pending", r.data.access?.pro === false);

// --- duplicate transaction id (bob pays for a profile of his own, using alice's transaction id)
const { rows: [bobProfile] } = await db.query(
  `INSERT INTO players (platform, username, share_token, owner_id) VALUES ('pgn', $1, $2, $3) RETURNING id`,
  [`billtest_bob_${tag}`, crypto.randomBytes(8).toString("hex"), bob.user.id]);
r = await call(MAIN, `/api/billing/coach/${pid}`, { token: bob.token });
check("bob cannot see or pay for alice's coach profile", r.status === 400 || r.status === 404, r.data.error);
await call(MAIN, `/api/billing/coach/${bobProfile.id}/checkout`, { body: {}, token: bob.token });
const bobPay = (await call(MAIN, `/api/billing/coach/${bobProfile.id}`, { token: bob.token })).data.payment;
r = await call(MAIN, `/api/billing/payments/${bobPay.id}/submit`, { body: { utr }, token: bob.token });
check("same transaction id cannot be reused by another payment", r.status === 400, r.data.error);

// --- admin dashboard security
r = await call(ADMIN, `/api/admin/payments`);
check("dashboard API needs a token (401)", r.status === 401);
r = await call(ADMIN, `/api/admin/payments`, { token: alice.token });
check("a normal user's token is refused (401)", r.status === 401);
r = await call(ADMIN, `/api/admin/login`, { body: { username: `alice_${tag}`, password: "secret123" } });
check("non-admin cannot sign in to the dashboard", r.status === 401);
const evil = await new Promise((resolve) => {
  const req = http.request({ host: "127.0.0.1", port: 8003, path: "/", headers: { Host: "evil.example:8003" } }, (res) => resolve(res.statusCode));
  req.end();
});
check("requests with a foreign Host header are refused (421)", evil === 421, String(evil));

// --- admin sees + confirms
r = await call(ADMIN, `/api/admin/payments?status=pending`, { token: admin.token });
const row = r.data.find((p) => p.id === pay.id);
check("admin sees the pending payment with payer, UTR, amount", row && row.username === `alice_${tag}` && row.utr === utr && row.amount_inr === pay.amountInr, row && `${row.username} ${row.utr} ₹${row.amount_inr}`);
r = await call(ADMIN, `/api/admin/payments/${pay.id}/confirm`, { body: { note: "checked in Paytm" }, token: admin.token });
check("admin confirms", r.status === 200 && r.data.status === "confirmed");
r = await call(ADMIN, `/api/admin/payments/${pay.id}/confirm`, { body: {}, token: admin.token });
check("confirming twice is refused (409)", r.status === 409);
r = await call(MAIN, `/api/billing/coach/${pid}`, { token: alice.token });
check("alice is now unlocked", r.data.pro === true && r.data.payment.status === "confirmed");
r = await call(MAIN, `/api/coach/players/${pid}`, { token: alice.token });
check("coach access.pro is true after confirmation", r.data.access?.pro === true);
const { rows: [sub] } = await db.query(`SELECT provider, reference, amount_inr, expires_at > now() + interval '29 days' AS ok FROM subscriptions WHERE player_id=$1 AND status='active'`, [pid]);
check("a 30-day 'upi_qr' subscription was created", sub?.provider === "upi_qr" && sub.reference === pay.reference && sub.ok);

// --- reject path (bob), reason visible to bob
r = await call(ADMIN, `/api/admin/payments/${bobPay.id}/reject`, { body: {}, token: admin.token });
check("reject needs a reason", r.status === 400);
r = await call(MAIN, `/api/billing/coach/${bobProfile.id}`, { token: bob.token });
check("confirming alice's payment does not confirm bob's own payment", r.data.payment.status === "created" && r.data.payment.id === bobPay.id && r.data.pro === false);

// --- revoke
r = await call(ADMIN, `/api/admin/payments/${pay.id}/revoke`, { body: { note: "refunded" }, token: admin.token });
check("admin can revoke", r.status === 200 && r.data.status === "revoked");
r = await call(MAIN, `/api/coach/players/${pid}`, { token: alice.token });
check("access is removed after revoke", r.data.access?.pro === false);

// --- admin data views
for (const [path, label] of [["/overview", "overview"], ["/users", "users"], ["/games", "games"], ["/coach", "coach"], ["/audit", "audit log"], ["/settings", "settings"]]) {
  r = await call(ADMIN, "/api/admin" + path, { token: admin.token });
  check(`dashboard ${label} loads`, r.status === 200);
}
r = await call(ADMIN, `/api/admin/audit`, { token: admin.token });
check("confirm + revoke are in the audit log", r.data.some((a) => a.action === "payment.confirmed" && a.target_id === pay.id) && r.data.some((a) => a.action === "payment.revoked" && a.target_id === pay.id));
r = await call(ADMIN, `/api/admin/settings`, { body: { price_inr: -5, upi_id: "x", payee_name: "" }, token: admin.token });
check("invalid settings are rejected", r.status === 400, r.data.error);

// cleanup of this test's data
for (const id of [pid, bobProfile.id]) {
  await db.query(`DELETE FROM subscriptions WHERE player_id=$1`, [id]);
  await db.query(`DELETE FROM payments WHERE player_id=$1`, [id]);
  await db.query(`DELETE FROM players WHERE id=$1`, [id]);
}
await db.query(`DELETE FROM admin_audit WHERE detail->>'user_id' IN ($1,$2)`, [String(alice.user.id), String(bob.user.id)]);
await db.query(`DELETE FROM users WHERE id IN ($1,$2)`, [alice.user.id, bob.user.id]);
await db.end();
console.log(failed ? `\n${failed} FAILED` : "\nAll checks passed");
process.exit(failed ? 1 : 0);
