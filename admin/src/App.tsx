import { FormEvent, ReactNode, useCallback, useEffect, useState } from "react";

// ---- api ------------------------------------------------------------------------------

const KEY = "chess.admin.token";
// Opened from the game site (same origin, /admin/): reuse its sign-in so an admin does not log in twice.
// A non-admin token simply fails the admin API and lands on the sign-in form.
const getToken = () => localStorage.getItem(KEY) || localStorage.getItem("chess.token");

class AuthError extends Error {}

async function api<T = any>(path: string, body?: unknown): Promise<T> {
  const token = getToken();
  const res = await fetch("/api/admin" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...(token && { authorization: `Bearer ${token}` }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== "/login") throw new AuthError(data.error || "Signed out");
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const fmt = (d?: string | null) => (d ? new Date(d).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "–");
const inr = (n: number | null | undefined) => `₹${(n ?? 0).toLocaleString("en-IN")}`;

// ---- small pieces ---------------------------------------------------------------------

function Badge({ status }: { status: string }) {
  const label = status === "created" ? "not submitted" : status;
  return <span className={`pill ${status}`}>{label}</span>;
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="x" onClick={onClose}>×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: string }) {
  return (
    <div className={`stat ${tone ?? ""}`}>
      <span className="muted">{label}</span>
      <b>{value}</b>
      {sub && <span className="muted small">{sub}</span>}
    </div>
  );
}

function useLoad<T>(path: string, deps: unknown[] = [], every = 0, onAuth?: () => void) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(() => {
    api<T>(path).then((d) => { setData(d); setError(""); }).catch((e) => (e instanceof AuthError ? onAuth?.() : setError(e.message)));
  }, [path, onAuth]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    load();
    if (!every) return;
    const id = setInterval(load, every);
    return () => clearInterval(id);
  }, [load, every, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps
  return { data, error, reload: load };
}

// ---- login -----------------------------------------------------------------------------

function Login({ onDone }: { onDone: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const r = await api<{ token: string }>("/login", { username, password });
      localStorage.setItem(KEY, r.token);
      onDone();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="center">
      <form className="card login" onSubmit={submit}>
        <h1>♞ Chess Live Admin</h1>
        <p className="muted">Admin accounts only. This panel is reachable from this computer only.</p>
        <input placeholder="Admin username" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
        <input type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} />
        {error && <div className="error">{error}</div>}
        <button className="primary" disabled={busy || !username || !password}>Sign in</button>
      </form>
    </div>
  );
}

// ---- payments -----------------------------------------------------------------------------

interface Payment {
  id: number; user_id: number; username: string; user_role: string; player_id: number | null; platform: string | null; player_username: string | null;
  amount_inr: number; reference: string; utr: string | null; status: string; admin_note: string | null;
  created_at: string; submitted_at: string | null; decided_at: string | null; decided_by_name: string | null;
}

function Payments({ onAuth }: { onAuth: () => void }) {
  const [filter, setFilter] = useState("");
  const { data, error, reload } = useLoad<Payment[]>(`/payments?status=${filter}`, [], 10000, onAuth);
  const [action, setAction] = useState<{ kind: "confirm" | "reject" | "revoke"; p: Payment } | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function run() {
    if (!action) return;
    setBusy(true);
    setErr("");
    try {
      await api(`/payments/${action.p.id}/${action.kind}`, { note });
      setAction(null);
      setNote("");
      reload();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  const FILTERS: [string, string][] = [["", "All"], ["pending", "Awaiting confirmation"], ["created", "Not submitted"], ["confirmed", "Confirmed"], ["rejected", "Rejected"], ["revoked", "Revoked"]];
  return (
    <>
      <div className="chips">
        {FILTERS.map(([k, label]) => (
          <button key={k} className={filter === k ? "active" : ""} onClick={() => setFilter(k)}>{label}</button>
        ))}
        <span className="muted small">refreshes every 10s</span>
      </div>
      {error && <div className="error">{error}</div>}
      <div className="card tablewrap">
        <table>
          <thead>
            <tr><th>Status</th><th>Payer</th><th>Unlocks</th><th>Amount</th><th>Reference</th><th>UTR / txn ID</th><th>Submitted</th><th>Decision</th><th></th></tr>
          </thead>
          <tbody>
            {(data ?? []).map((p) => (
              <tr key={p.id} className={p.status === "pending" ? "hot" : ""}>
                <td><Badge status={p.status} /></td>
                <td>{p.username}<div className="muted small">{p.user_role} · #{p.user_id}</div></td>
                <td>{p.player_username ? `${p.platform}: ${p.player_username}` : "–"}</td>
                <td><b>{inr(p.amount_inr)}</b></td>
                <td className="mono">{p.reference}</td>
                <td className="mono">{p.utr ?? <span className="muted">not entered</span>}</td>
                <td>{fmt(p.submitted_at ?? p.created_at)}</td>
                <td>{p.decided_at ? <>{fmt(p.decided_at)}<div className="muted small">{p.decided_by_name}{p.admin_note ? ` · “${p.admin_note}”` : ""}</div></> : "–"}</td>
                <td className="actions">
                  {["pending", "created"].includes(p.status) && (
                    <>
                      <button className="primary" onClick={() => { setAction({ kind: "confirm", p }); setNote(""); setErr(""); }}>Confirm</button>
                      <button onClick={() => { setAction({ kind: "reject", p }); setNote(""); setErr(""); }}>Reject</button>
                    </>
                  )}
                  {p.status === "confirmed" && <button className="danger" onClick={() => { setAction({ kind: "revoke", p }); setNote(""); setErr(""); }}>Revoke</button>}
                </td>
              </tr>
            ))}
            {data && data.length === 0 && <tr><td colSpan={9} className="muted">No payments here yet.</td></tr>}
          </tbody>
        </table>
      </div>

      {action && (
        <Modal title={action.kind === "confirm" ? "Confirm payment received" : action.kind === "reject" ? "Reject payment" : "Revoke access"} onClose={() => setAction(null)}>
          <dl className="facts">
            <dt>Payer</dt><dd>{action.p.username} (#{action.p.user_id})</dd>
            <dt>Unlocks</dt><dd>{action.p.player_username ? `${action.p.platform}: ${action.p.player_username}` : "–"}</dd>
            <dt>Amount expected</dt><dd><b>{inr(action.p.amount_inr)}</b></dd>
            <dt>Reference</dt><dd className="mono">{action.p.reference}</dd>
            <dt>UTR / txn ID</dt><dd className="mono">{action.p.utr ?? "not entered by the payer"}</dd>
          </dl>
          {action.kind === "confirm" && (
            <p className="warn">Open your Paytm app and check that exactly {inr(action.p.amount_inr)} was received with this transaction ID. Confirming unlocks Days 3–7 for this coach profile for 30 days, immediately.</p>
          )}
          {action.kind === "revoke" && <p className="warn">This cancels the 30-day subscription this payment created. The payer will see the reason below.</p>}
          <label>{action.kind === "confirm" ? "Note (optional, internal)" : "Reason (shown to the payer)"}
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder={action.kind === "reject" ? "e.g. Amount received was ₹199, not ₹299" : ""} />
          </label>
          {err && <div className="error">{err}</div>}
          <div className="row">
            <button className={action.kind === "confirm" ? "primary" : "danger"} disabled={busy} onClick={run}>
              {busy ? "Working…" : action.kind === "confirm" ? `Yes, I received ${inr(action.p.amount_inr)} – unlock` : action.kind === "reject" ? "Reject" : "Revoke access"}
            </button>
            <button onClick={() => setAction(null)}>Cancel</button>
          </div>
        </Modal>
      )}
    </>
  );
}

// ---- overview -------------------------------------------------------------------------------

function Bars({ series }: { series: { day: string; signups: number; games: number }[] }) {
  const max = Math.max(1, ...series.flatMap((s) => [s.signups, s.games]));
  const w = 28;
  return (
    <svg viewBox={`0 0 ${series.length * w} 110`} className="bars" role="img" aria-label="Sign-ups and games for the last 14 days">
      {series.map((s, i) => (
        <g key={s.day} transform={`translate(${i * w},0)`}>
          <rect x={3} width={9} y={90 - (s.games / max) * 80} height={(s.games / max) * 80} className="b-games"><title>{s.day}: {s.games} games</title></rect>
          <rect x={14} width={9} y={90 - (s.signups / max) * 80} height={(s.signups / max) * 80} className="b-signups"><title>{s.day}: {s.signups} sign-ups</title></rect>
          {i % 2 === 0 && <text x={13} y={105} textAnchor="middle">{s.day.slice(8)}</text>}
        </g>
      ))}
    </svg>
  );
}

function Overview({ onAuth, goto }: { onAuth: () => void; goto: (t: string) => void }) {
  const { data, error } = useLoad<any>("/overview", [], 15000, onAuth);
  if (error) return <div className="error">{error}</div>;
  if (!data) return <p className="muted">Loading…</p>;
  const t = data.totals;
  return (
    <>
      {t.pending_payments > 0 && (
        <button className="alert" onClick={() => goto("payments")}>
          ⏳ {t.pending_payments} payment{t.pending_payments > 1 ? "s" : ""} ({inr(t.pending_inr)}) waiting for your confirmation. Review →
        </button>
      )}
      <h3>Payments</h3>
      <div className="stats">
        <Stat label="Revenue confirmed" value={inr(t.revenue_inr)} sub={`${t.confirmed_payments} payment(s)`} tone="good" />
        <Stat label="Awaiting confirmation" value={t.pending_payments} sub={inr(t.pending_inr)} tone={t.pending_payments ? "warn" : ""} />
        <Stat label="Started, not submitted" value={t.unsubmitted_payments} />
        <Stat label="Rejected" value={t.rejected_payments} />
      </div>
      <h3>Users</h3>
      <div className="stats">
        <Stat label="Total users" value={t.users} sub={`${t.guests} guests`} />
        <Stat label="New (7 days)" value={t.new_users_7d} />
        <Stat label="Active (24h)" value={t.active_24h} />
      </div>
      <h3>Games</h3>
      <div className="stats">
        <Stat label="Games" value={t.games} sub={`${t.finished_games} finished`} />
        <Stat label="Live now" value={t.active_games} />
        <Stat label="Vs bot" value={t.bot_games} />
        <Stat label="Moves stored" value={t.moves.toLocaleString()} />
        <Stat label="Positions analysed" value={t.analyses.toLocaleString()} sub={`${t.embeddings.toLocaleString()} embeddings`} />
      </div>
      {data.coach && (
        <>
          <h3>AI Coach</h3>
          <div className="stats">
            <Stat label="Coach profiles" value={data.coach.profiles} />
            <Stat label="Agent runs" value={data.coach.runs} sub={`${data.coach.failed_runs} failed`} tone={data.coach.failed_runs ? "warn" : ""} />
            <Stat label="Active subscriptions" value={data.coach.active_subs} sub={data.coach.demo_subs ? `${data.coach.demo_subs} are free demo unlocks` : undefined} tone={data.coach.demo_subs ? "warn" : ""} />
          </div>
        </>
      )}
      {data.model && (
        <p className="muted small">
          Win-prediction model: {data.model.n_samples} positions / {data.model.n_games} games, held-out accuracy {data.model.accuracy == null ? "–" : `${Math.round(data.model.accuracy * 100)}%`} (trained {fmt(data.model.trained_at)}).
        </p>
      )}
      <h3>Last 14 days</h3>
      <div className="card">
        <Bars series={data.series} />
        <div className="legend"><span><i className="b-games" /> games</span><span><i className="b-signups" /> sign-ups</span></div>
      </div>
    </>
  );
}

// ---- users ----------------------------------------------------------------------------------

function Users({ onAuth }: { onAuth: () => void }) {
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");
  useEffect(() => { const id = setTimeout(() => setTerm(q), 250); return () => clearTimeout(id); }, [q]);
  const { data, error } = useLoad<any[]>(`/users?q=${encodeURIComponent(term)}`, [], 0, onAuth);
  const [open, setOpen] = useState<number | null>(null);
  return (
    <>
      <input className="search" placeholder="Search username…" value={q} onChange={(e) => setQ(e.target.value)} />
      {error && <div className="error">{error}</div>}
      <div className="card tablewrap">
        <table>
          <thead><tr><th>User</th><th>Role</th><th>Elo</th><th>Games</th><th>Paid</th><th>Joined</th><th>Last seen</th><th>Last game</th></tr></thead>
          <tbody>
            {(data ?? []).map((u) => (
              <tr key={u.id} className="click" onClick={() => setOpen(u.id)}>
                <td><b>{u.username}</b><div className="muted small">#{u.id}</div></td>
                <td>{u.role}</td>
                <td>{u.rating}<div className="muted small">{u.rated_games} rated</div></td>
                <td>{u.games}</td>
                <td>{u.paid_count ? <>{inr(u.paid_inr)}</> : u.payment_status ? <Badge status={u.payment_status} /> : "–"}</td>
                <td>{fmt(u.created_at)}</td>
                <td>{fmt(u.last_seen_at)}</td>
                <td>{fmt(u.last_game_at)}</td>
              </tr>
            ))}
            {data && data.length === 0 && <tr><td colSpan={8} className="muted">No users found.</td></tr>}
          </tbody>
        </table>
      </div>
      {open !== null && <UserDetail id={open} onClose={() => setOpen(null)} onAuth={onAuth} />}
    </>
  );
}

function UserDetail({ id, onClose, onAuth }: { id: number; onClose: () => void; onAuth: () => void }) {
  const { data, error } = useLoad<any>(`/users/${id}`, [], 0, onAuth);
  return (
    <Modal title={data ? data.user.username : "User"} onClose={onClose}>
      {error && <div className="error">{error}</div>}
      {data && (
        <>
          <dl className="facts">
            <dt>Role</dt><dd>{data.user.role}</dd>
            <dt>Elo</dt><dd>{data.user.rating} ({data.user.rated_games} rated games)</dd>
            <dt>Joined</dt><dd>{fmt(data.user.created_at)}</dd>
            <dt>Last seen</dt><dd>{fmt(data.user.last_seen_at)}</dd>
          </dl>
          <h4>Payments</h4>
          {data.payments.length === 0 ? <p className="muted">None.</p> : (
            <table><thead><tr><th>Status</th><th>For</th><th>Amount</th><th>Reference</th><th>UTR</th><th>When</th></tr></thead><tbody>
              {data.payments.map((p: any) => (
                <tr key={p.id}><td><Badge status={p.status} /></td><td>{p.player_username ?? "–"}</td><td>{inr(p.amount_inr)}</td><td className="mono">{p.reference}</td><td className="mono">{p.utr ?? "–"}</td><td>{fmt(p.submitted_at ?? p.created_at)}</td></tr>
              ))}
            </tbody></table>
          )}
          <h4>Recent games</h4>
          {data.games.length === 0 ? <p className="muted">None.</p> : (
            <table><thead><tr><th>Game</th><th>Result</th><th>Elo</th><th>When</th></tr></thead><tbody>
              {data.games.map((g: any) => (
                <tr key={g.code}><td>{g.white ?? "?"} vs {g.black ?? "waiting"}{g.vs_bot ? " 🤖" : ""}</td><td>{g.status === "finished" ? `${g.result} (${g.termination})` : g.status}</td><td>{g.elo_change == null ? "–" : g.elo_change > 0 ? `+${g.elo_change}` : g.elo_change}</td><td>{fmt(g.created_at)}</td></tr>
              ))}
            </tbody></table>
          )}
        </>
      )}
    </Modal>
  );
}

// ---- games / coach / audit / settings -----------------------------------------------------------

function Games({ onAuth }: { onAuth: () => void }) {
  const [status, setStatus] = useState("");
  const { data, error } = useLoad<any[]>(`/games?status=${status}`, [], 15000, onAuth);
  return (
    <>
      <div className="chips">
        {[["", "All"], ["waiting", "Waiting"], ["active", "Live"], ["finished", "Finished"]].map(([k, l]) => (
          <button key={k} className={status === k ? "active" : ""} onClick={() => setStatus(k)}>{l}</button>
        ))}
      </div>
      {error && <div className="error">{error}</div>}
      <div className="card tablewrap">
        <table>
          <thead><tr><th>Players</th><th>Status</th><th>Result</th><th>Time</th><th>Moves</th><th>Elo Δ</th><th>Created</th></tr></thead>
          <tbody>
            {(data ?? []).map((g) => (
              <tr key={g.id}>
                <td>{g.white ?? "?"} vs {g.black ?? "waiting…"}{g.vs_bot ? <span className="muted small"> · bot {g.bot_elo ?? "max"}</span> : ""}<div className="muted small mono">{g.code}</div></td>
                <td>{g.status}</td>
                <td>{g.result ? `${g.result} · ${g.termination}` : "–"}</td>
                <td>{g.time_control_sec / 60}+{g.increment_sec}</td>
                <td>{Math.ceil(g.plies / 2)}</td>
                <td>{g.white_change == null && g.black_change == null ? "unrated" : `${g.white_change ?? "bot"} / ${g.black_change ?? "bot"}`}</td>
                <td>{fmt(g.created_at)}</td>
              </tr>
            ))}
            {data && data.length === 0 && <tr><td colSpan={7} className="muted">No games.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Coach({ onAuth }: { onAuth: () => void }) {
  const { data, error } = useLoad<any>("/coach", [], 15000, onAuth);
  if (error) return <div className="error">{error}</div>;
  if (!data) return <p className="muted">Loading…</p>;
  return (
    <>
      <h3>Coach profiles</h3>
      <div className="card tablewrap">
        <table>
          <thead><tr><th>Profile</th><th>Owner</th><th>Goal</th><th>Games</th><th>Agent runs</th><th>Access</th><th>Added</th><th>Last checked</th></tr></thead>
          <tbody>
            {data.profiles.map((p: any) => (
              <tr key={p.id}><td>{p.platform}: <b>{p.username}</b><div className="muted small">#{p.id}</div></td><td>{p.owner ?? <span className="muted">none</span>}</td><td>{p.goal ?? "–"}</td><td>{p.games}</td><td>{p.runs}</td><td>{p.pro ? <span className="pill confirmed">Pro</span> : <span className="pill created">free (Days 1–2)</span>}</td><td>{fmt(p.created_at)}</td><td>{fmt(p.last_checked_at)}</td></tr>
            ))}
            {data.profiles.length === 0 && <tr><td colSpan={8} className="muted">No coach profiles.</td></tr>}
          </tbody>
        </table>
      </div>
      <h3>Subscriptions</h3>
      <div className="card tablewrap">
        <table>
          <thead><tr><th>Profile</th><th>Provider</th><th>Reference</th><th>Amount</th><th>Status</th><th>Started</th><th>Expires</th></tr></thead>
          <tbody>
            {data.subscriptions.map((s: any) => (
              <tr key={s.id}>
                <td>{s.player_username ? `${s.platform}: ${s.player_username}` : `#${s.player_id}`}</td>
                <td>{s.provider === "demo" ? <span className="pill rejected" title="Created by the old demo checkout, no money was paid">demo (free)</span> : s.provider}</td>
                <td className="mono">{s.reference ?? "–"}</td><td>{inr(s.amount_inr)}</td><td>{s.status}</td><td>{fmt(s.started_at)}</td><td>{fmt(s.expires_at)}</td>
              </tr>
            ))}
            {data.subscriptions.length === 0 && <tr><td colSpan={7} className="muted">No subscriptions.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Audit({ onAuth }: { onAuth: () => void }) {
  const { data, error } = useLoad<any[]>("/audit", [], 0, onAuth);
  return (
    <>
      {error && <div className="error">{error}</div>}
      <div className="card tablewrap">
        <table>
          <thead><tr><th>When</th><th>Admin</th><th>Action</th><th>Target</th><th>Details</th></tr></thead>
          <tbody>
            {(data ?? []).map((a) => (
              <tr key={a.id}><td>{fmt(a.created_at)}</td><td>{a.admin}</td><td>{a.action}</td><td>{a.target_type ? `${a.target_type} #${a.target_id ?? ""}` : "–"}</td><td className="mono small">{a.detail ? JSON.stringify(a.detail) : ""}</td></tr>
            ))}
            {data && data.length === 0 && <tr><td colSpan={5} className="muted">Nothing yet. Every confirm, reject, revoke and settings change is logged here.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Settings({ onAuth }: { onAuth: () => void }) {
  const { data, reload } = useLoad<any>("/settings", [], 0, onAuth);
  const [f, setF] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState("");
  const [qr, setQr] = useState<string | null>(null);
  const [qrMsg, setQrMsg] = useState("");
  useEffect(() => { if (data) setF(data); }, [data]);
  async function save(e: FormEvent) {
    e.preventDefault();
    setMsg("");
    try {
      const { qr_set, ...rest } = f as any;
      void qr_set;
      setF(await api("/settings", rest));
      setMsg("Saved. New checkouts use these values.");
    } catch (err: any) {
      setMsg(err.message);
    }
  }
  function pick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    setQrMsg("");
    if (!file) return setQr(null);
    if (file.size > 600_000) return void (setQr(null), setQrMsg("That image is too large (limit about 600 KB)."));
    const r = new FileReader();
    r.onload = () => setQr(String(r.result));
    r.readAsDataURL(file);
  }
  async function uploadQr() {
    if (!qr) return;
    setQrMsg("");
    try {
      await api("/settings/qr", { dataUrl: qr });
      setQr(null);
      setQrMsg("QR image saved. Players see it right away.");
      reload();
    } catch (err: any) {
      setQrMsg(err.message);
    }
  }
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <>
      <form className="card settings" onSubmit={save}>
        <label>Price per coach profile (₹, 30 days)<input type="number" min={1} value={f.price_inr ?? ""} onChange={set("price_inr")} /></label>
        <label>UPI ID shown to payers<input value={f.upi_id ?? ""} onChange={set("upi_id")} /></label>
        <label>Payee name<input value={f.payee_name ?? ""} onChange={set("payee_name")} /></label>
        <p className="warn small">Changing the price does not affect payments already started. If you change the UPI ID, upload the matching QR image below, or players will scan the old account.</p>
        <div className="row"><button className="primary">Save</button><span className="muted">{msg}</span></div>
      </form>
      <div className="card settings" style={{ marginTop: 16 }}>
        <h4>Payment QR image</h4>
        <p className="muted small">Status: {data?.qr_set ? "an image is stored in the database and shown to players" : "no image uploaded yet (the paywall will show a broken picture)"}.</p>
        <input type="file" accept="image/png,image/jpeg" onChange={pick} />
        {qr && <img src={qr} alt="QR preview" style={{ maxWidth: 220, marginTop: 12, borderRadius: 8, background: "#fff" }} />}
        <div className="row"><button className="primary" disabled={!qr} onClick={uploadQr}>Upload QR</button><span className="muted">{qrMsg}</span></div>
        <p className="muted small">PNG or JPEG, up to about 600 KB. It is stored in the database, not in git.</p>
      </div>
    </>
  );
}

// ---- shell ---------------------------------------------------------------------------------------

const TABS: [string, string][] = [["payments", "Payments"], ["overview", "Overview"], ["users", "Users"], ["games", "Games"], ["coach", "Coach"], ["settings", "Settings"], ["audit", "Audit log"]];

export default function App() {
  const [authed, setAuthed] = useState(!!getToken());
  const [tab, setTab] = useState(() => localStorage.getItem("chess.admin.tab") || "payments");
  const signOut = useCallback(() => { localStorage.removeItem(KEY); localStorage.removeItem("chess.token"); setAuthed(false); }, []);
  const { data: me } = useLoad<any>("/me", [authed], 0, signOut);
  const { data: pend } = useLoad<any[]>("/payments?status=pending", [authed], 10000, signOut);
  const pending = authed ? pend?.length ?? 0 : 0;
  const goto = (t: string) => { setTab(t); localStorage.setItem("chess.admin.tab", t); };
  useEffect(() => { document.title = pending ? `(${pending}) Chess Live Admin` : "Chess Live Admin"; }, [pending]);

  if (!authed) return <Login onDone={() => setAuthed(true)} />;
  return (
    <>
      <header className="top">
        <b className="brand">♞ Chess Live · Admin</b>
        <nav>
          {TABS.map(([k, l]) => (
            <button key={k} className={tab === k ? "active" : ""} onClick={() => goto(k)}>
              {l}{k === "payments" && pending > 0 && <span className="count">{pending}</span>}
            </button>
          ))}
        </nav>
        <span className="who">{me?.user?.username}<button className="link" onClick={signOut}>Sign out</button></span>
      </header>
      {me?.defaultPassword && <div className="banner">⚠ The admin account is still using the default password (admin123). Set ADMIN_PASSWORD in server/.env and restart both servers.</div>}
      <main>
        {tab === "payments" && <Payments onAuth={signOut} />}
        {tab === "overview" && <Overview onAuth={signOut} goto={goto} />}
        {tab === "users" && <Users onAuth={signOut} />}
        {tab === "games" && <Games onAuth={signOut} />}
        {tab === "coach" && <Coach onAuth={signOut} />}
        {tab === "settings" && <Settings onAuth={signOut} />}
        {tab === "audit" && <Audit onAuth={signOut} />}
      </main>
    </>
  );
}
