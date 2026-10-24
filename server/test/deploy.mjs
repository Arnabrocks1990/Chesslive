// Deployment smoke test: run against a web server + admin server that share a (fresh) database.
//   WEB=http://localhost:8011 ADMIN=http://localhost:8013 ADMIN_PASSWORD=... node test/deploy.mjs
// Checks health, the admin account/password handling, and the payment-QR upload + serving.
const WEB = process.env.WEB || "http://localhost:8001";
const ADMIN = process.env.ADMIN || "http://localhost:8003";
const PASSWORD = process.env.ADMIN_PASSWORD;
if (!PASSWORD) { console.error("Set ADMIN_PASSWORD to the admin password the web server was started with"); process.exit(2); }

let failed = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  -> " + extra : ""}`); if (!ok) failed++; };
const post = async (base, path, body, token) => {
  const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...(token && { authorization: "Bearer " + token }) }, body: JSON.stringify(body) });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};

// 1x1 PNG
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

const health = await fetch(WEB + "/healthz");
check("web /healthz answers 200 and checks the database", health.status === 200 && (await health.json()).ok === true);
check("the SPA is served", (await fetch(WEB + "/")).status === 200);
// With no upload: a clean 404 on Render (no file in git), or the local fallback image on a dev machine.
// What must never happen is the SPA's HTML answering with 200 (the browser would show a broken image silently).
const before = await fetch(WEB + "/payment-qr.png");
check("no QR uploaded yet -> /payment-qr.png is a 404 or an image, never the HTML page",
  before.status === 404 || (before.status === 200 && (before.headers.get("content-type") || "").startsWith("image/")), `${before.status} ${before.headers.get("content-type")}`);

let r = await post(ADMIN, "/api/admin/login", { username: "admin", password: "admin123" });
check("the old default password does NOT work", r.status === 401);
r = await post(ADMIN, "/api/admin/login", { username: "admin", password: PASSWORD });
check("the configured admin password works on the admin dashboard", r.status === 200 && !!r.data.token);
const token = r.data.token;

const settings = await (await fetch(ADMIN + "/api/admin/settings", { headers: { authorization: "Bearer " + token } })).json();
check("settings report no QR yet and never leak the image blob", settings.qr_set === false && !("qr_image" in settings));

const dataUrl = "data:image/png;base64," + PNG.toString("base64");
r = await post(ADMIN, "/api/admin/settings/qr", { dataUrl });
check("QR upload needs an admin token", r.status === 401);
r = await post(ADMIN, "/api/admin/settings/qr", { dataUrl: "data:text/html;base64,PGgxPmhpPC9oMT4=" }, token);
check("non-image upload refused", r.status === 400, r.data.error);
r = await post(ADMIN, "/api/admin/settings/qr", { dataUrl: "data:image/png;base64," + Buffer.from("not really a png").toString("base64") }, token);
check("fake PNG (wrong magic bytes) refused", r.status === 400, r.data.error);
r = await post(ADMIN, "/api/admin/settings/qr", { dataUrl: "data:image/png;base64," + Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(700_000)]).toString("base64") }, token);
check("oversized image refused", r.status === 400, r.data.error);
r = await post(ADMIN, "/api/admin/settings/qr", { dataUrl }, token);
check("valid PNG accepted", r.status === 200 && r.data.bytes === PNG.length);

const img = await fetch(WEB + "/payment-qr.png");
const bytes = Buffer.from(await img.arrayBuffer());
check("web server now serves the uploaded QR from the database", img.status === 200 && img.headers.get("content-type")?.startsWith("image/png") && bytes.equals(PNG), `${img.status} ${img.headers.get("content-type")} ${bytes.length}B`);
check("QR is not cached stale", /no-cache/.test(img.headers.get("cache-control") || ""));
const after = await (await fetch(ADMIN + "/api/admin/settings", { headers: { authorization: "Bearer " + token } })).json();
check("settings now say a QR is stored", after.qr_set === true);

// the admin process must not have changed the admin account: web-server login still works with the same password
r = await post(WEB, "/api/login", { username: "admin", password: PASSWORD });
check("web server login still works (admin dashboard did not reset the password)", r.status === 200);
r = await post(WEB, "/api/login", { username: "admin", password: "admin123" });
check("web server rejects the default password", r.status === 400 || r.status === 401);

console.log(failed ? `\n${failed} FAILED` : "\nAll checks passed");
process.exit(failed ? 1 : 0);
