# Deploying Chess Live to Render

What gets created from `render.yaml`:

| Resource | Type | Notes |
|---|---|---|
| `chesslive-web` | Web service (Node) | API, WebSocket game server and the built React app. Health check: `/healthz` |
| `chesslive-worker` | Background worker (Docker) | Python + a chess engine. **No free plan exists for workers** |
| `chesslive-db` | Postgres | pgvector is enabled by the server at first boot |
| `chesslive-redis` | Key Value (Redis-compatible) | Job queues; set to `noeviction` so jobs are never dropped |

The **admin dashboard is not deployed**. It can confirm payments, so it only listens on `127.0.0.1`. You run it on your own computer against the Render database (step 5).

## 1. Before you start

- The repo must contain `render.yaml` (it is in the repo root once this is committed and pushed).
- Decide the admin password now: **12+ characters**. In production the server refuses to start with the default password or a short/default `JWT_SECRET`.
- Optional: an Anthropic API key (AI explanations and coach text) and an ElevenLabs key (voiceover). Without them the app falls back to rule-based text and the browser's voice.
- Your UPI ID and payee name (the QR image itself is uploaded later, in the dashboard, not through git).

## 2. Create the Blueprint

1. In Render: **New > Blueprint**, connect the GitHub repo `Arnabrocks1990/Chesslive`, branch `main`.
2. Render reads `render.yaml` and shows the four resources. It will ask for the values marked `sync: false`: `ADMIN_PASSWORD`, `ANTHROPIC_API_KEY`, `ELEVENLABS_API_KEY`, `UPI_ID`, `PAYEE_NAME`. Leave the optional ones blank if you do not have them.
3. If Render offers a project/environment picker, choose your existing project. If it does not, create the Blueprint anyway and move the four resources into your project afterwards (each resource's Settings).
4. Click **Apply**. The first build takes several minutes (the worker image installs the engine).

If Render reports an error in `render.yaml`, it names the field. Fix it in the repo and push; the Blueprint re-validates.

## 3. Check it works

- Open the `chesslive-web` URL. The lobby should load. `https://<your-service>.onrender.com/healthz` should answer `{"ok":true}`.
- In the worker's logs you should see `worker ready`.
- Register an account, play a bot game: the bot's reply proves the web service, Redis and the worker are connected.
- Sign in as `admin` with your `ADMIN_PASSWORD` and open a game: the AI assist panel proves the analysis path.

## 4. Costs and plan choices

The Blueprint leaves plans at Render's defaults, so you pay for a web service, a worker, a Postgres and a Key Value instance. Things worth knowing:

- Free web services spin down after 15 minutes idle (bad for live games); free Postgres expires after 30 days; free Key Value does not persist data; workers have no free plan.
- Check the current prices on Render's pricing page before you apply.
- The engine on a small instance is slower: the worker is configured for about 0.5 CPU / 512 MB (`SF_THREADS=1`, `SF_HASH=64`, depth 14 live, 10 post-game). Raise these if you upgrade the worker.

## 5. Run the admin dashboard against production (your computer)

1. Render dashboard > `chesslive-db` > **Access Control**: add your current public IP (search "what is my ip"). Outside access is blocked until you do.
2. Copy the database's **External Database URL**.
3. In a terminal on your computer (PowerShell shown), in `C:\Automate\Chess\server`:

   ```powershell
   $env:DATABASE_URL = "<External Database URL>"
   $env:DATABASE_SSL = "require"
   npm run admin
   ```

   Open http://localhost:8003 and sign in with `admin` and the production `ADMIN_PASSWORD`. Do not put these in `server/.env`, or your local game server would start talking to production too.
4. **Settings > Payment QR image**: upload your QR. Players see it immediately. Also check the UPI ID, payee name and price there.
5. Your IP changes over time: if the dashboard cannot connect, update the allow-list entry.

The local admin process deliberately never resets the admin password, so it is safe to run against production.

## 6. Updating

Push to `main`; Render rebuilds and redeploys the web service and the worker. Schema changes are applied automatically at boot (`db/init.sql`, plus the `ensure*Schema` functions).

## 7. Limits to know about

- **One web instance only.** Live game state, clocks and Socket.IO rooms are held in the server's memory. Do not scale the web service to more than one instance.
- A deploy or restart of the web service interrupts live games for a few seconds; games resume from the database (the player to move gets the downtime back on their clock).
- The analysis worker is a single consumer; a long backlog (for example after many games finish together) delays bot replies and live suggestions.
- `ADMIN_PASSWORD` is applied on every boot of the web service: change it in Render's environment settings, not by editing the database.
- Back up the database (Render offers paid backups) before you rely on it for real payments data.
