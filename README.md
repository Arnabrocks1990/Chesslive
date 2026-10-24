# Chesslive
Chess players rated roughly 600–1800 repeat the same few mistakes, such as hanging pieces, missing forks and losing won endgames, for hundreds of games, because existing game review is per-game, full of engine jargon, and passive: it never tells them what to practise or checks whether they improved. Human coaches solve this but cost t

## The app: Chess Live

Browser-based multiplayer chess with an AI move-suggestion agent. See [PRD.md](PRD.md).

## Run (localhost)

```
docker compose up -d --build      # Postgres+pgvector (5455), Redis (6380), Stockfish worker
cd client && npm install && npm run build
cd ../server && npm install && npm start
```

Open http://localhost:8001. The server also serves the built client.
Frontend dev with hot reload: `cd client && npm run dev` (http://localhost:5173, proxies to 8001).

Admin login: `admin` / `admin123` (override with `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `JWT_SECRET`).

## Configuration (`server/.env`, never committed)

| Variable | Purpose |
|---|---|
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | Admin login (defaults `admin` / `admin123`: **change before sharing the app**) |
| `JWT_SECRET` | Signing key for login tokens (the default is for local development only) |
| `ANTHROPIC_API_KEY` | Enables AI explanations and coach text; without it everything falls back to rules |
| `UPI_ID`, `PAYEE_NAME` | Payee shown on the coach paywall (first boot; later edit in the dashboard) |
| `CONTACT_EMAIL` | Optional contact added to the User-Agent sent to Lichess/Chess.com |
| `PORT` (8001), `ADMIN_PORT` (8003) | Server ports; the admin dashboard always binds to 127.0.0.1 |

## Behaviour

- Anyone can register, sign in, or play as a guest; a game is shared through its invite link (`/g/<code>`).
- Live AI assistance (top-3 moves, eval, arrows, Claude explanation, similar past positions) is sent **only to admin sockets**. Everyone else plays without it; the server never emits suggestions to non-admins.
- When a game ends, every position is analysed by the worker and a report (accuracy, mistakes, blunders) is available to all players.
- Every game, move, analysis and position embedding is stored in Postgres; similar-position retrieval uses pgvector.
- Elo ratings: every user starts at 1200. K=32 for the first 30 rated games, then 20. Games under 4 plies are unrated. Bot games are rated for the human against the bot's nominal strength (1400/1800/2300, max = 3200); the bot itself is never rated. Leaderboard in the lobby, rating on profiles and next to player names. Games finished before this feature were not rated retroactively.
- Play against the Stockfish bot (easy ~1400 / medium ~1800 / hard ~2300 / max) from the lobby.
- Profiles at `/u/<username>`: record, accuracy, blunder rate, openings, recent games.
- Learned model: after every finished game the worker retrains a logistic-regression "who wins from here" model on stored positions and their game results (needs 100+ labelled positions; validated on held-out games). Its White-win chance is shown in the admin assist panel. With few games it is weak and noisy.
- Explanations run through the Claude Code CLI (team plan, no API key). Set `EXPLAIN=0` to disable.

## AI Coach (agentic)

Open `/coach`. Enter a Lichess username (or paste a PGN) and the coach agent runs by itself: fetch games, Stockfish analysis, rule-based mistake tagging, weakness ranking, an LLM planning decision, drills built from your own mistakes, a 7-day plan, and a progress comparison. Every step is logged (`agent_runs`, `agent_steps`) and shown live in the UI. See `COACH_PRD_v2_AGENTIC.md`.

- Code: `server/src/coach/` (importer, analysis queue, tagger, agent, routes, samples), UI in `client/src/CoachPage.tsx`. Tables are created on boot (`schema.ts`), no volume reset needed.
- Autonomy: a poller (`COACH_POLL_MS`, default 5 min; `0` disables) wakes the agent when a followed account has new games, or when a player has been idle (`COACH_IDLE_HOURS`, default 72). The **Simulate new game** button injects a stored, clearly labelled game for demos.
- LLM decisions, plans, explanations and the coach chat use the Anthropic API. Put `ANTHROPIC_API_KEY` in `server/.env` (copy `server/.env.example`; `.env` is git-ignored; `npm start` loads it). `CLAUDE_MODEL` defaults to `claude-sonnet-5-5`. Without a key, or with `EXPLAIN=0`, every AI feature falls back to its rule-based version. Stockfish and rules own all chess facts.
- Voiceover: during the 7-day plan the coach reads lessons, hints, answers and milestone results aloud. ElevenLabs (`ELEVENLABS_API_KEY` in `server/.env`, voice `ELEVENLABS_VOICE_ID`, default Alice) is called through `POST /api/coach/tts` so the key stays on the server; audio is cached in `server/data/tts/`. If ElevenLabs is missing, over quota or down, the browser's own speech engine (the Windows voices on Windows) reads the text instead. The free plan is 10,000 characters a month, so repeats are cached and each user is limited to about 2,500 characters an hour. A Voice on/off switch sits next to the language tabs.
- Finished games only; no live-game assistance for players. `POST /api/coach/players/:id/delete` removes a player's data.
- Chess.com import is implemented but the API returned 403 from this network in testing; use Lichess or PGN paste if it does.

## Privacy

- **Coach profiles are private.** Each profile has an owner (`players.owner_id`). Every Coach URL that points at a profile, run, session, question or drill goes through one gate (`server/src/coach/access.ts`) that allows only the owner or an admin; anyone else gets a 404 that looks the same as "does not exist". The profile list shows only your own (admins see all, with the owner's name). Payment pages follow the same rule.
- **Game reports** (accuracy, blunders) are visible to the two players and admins only.
- **Player profiles** (`/u/<name>`): rating and win/draw/loss record are public (they are on the leaderboard); accuracy, blunder rate and openings are visible only to that player and admins.
- **Exception, by design:** the "Share report" link a profile's owner creates is readable by anyone who has it.
- Profiles that existed before ownership was added were assigned to the admin account.
- **Test:** `node server/test/privacy.mjs` (35 checks, about a minute; creates and removes its own data).

## Payments and the admin dashboard

- **What is paid:** AI Coach Days 3-7 (Days 1-2 stay free), per coach profile, 30 days. Price, UPI ID and payee name are editable in the dashboard (Settings); default 299 INR; the UPI ID and payee name come from `UPI_ID` / `PAYEE_NAME` on first boot.
- **Player flow:** on the Coach paywall the player scans the QR (`client/public/payment-qr.png`), puts the reference (`CHS-XXXXXX`) in the payment note, enters the transaction ID and clicks "I've paid". The paywall then shows **Confirmation pending** and polls; nothing unlocks yet. The old free "demo checkout" now returns 410.
- **Admin confirms:** the dashboard at **http://localhost:8003** lists payments (pending first). Confirm creates the 30-day `upi_qr` subscription and the player's page unlocks within seconds. Reject (reason shown to the payer) and Revoke are also there. Every action is written to the audit log.
- **Dashboard tabs:** Payments, Overview (users, games, revenue, coach, model), Users (with detail), Games, Coach (profiles and subscriptions, demo unlocks flagged), Settings, Audit log.
- **Run it:** `cd server && npm run admin` (separate process from `npm start`). Build the UI once: `cd admin && npm install && npm run build`. Port via `ADMIN_PORT`.
- **Security:** bound to 127.0.0.1 only, admin accounts only, foreign Host headers refused, login rate-limited, confirm/reject/revoke exist only on this server (the game server has no such endpoint). The dashboard warns while the admin password is still `admin123`; set `ADMIN_PASSWORD` in `server/.env`.
- **Your QR is not in the repo.** Put your own QR image at `client/public/payment-qr.png` (it is git-ignored because it shows your UPI ID), set `UPI_ID` and `PAYEE_NAME` in `server/.env` before the first start (or edit them later in the dashboard's Settings), and rebuild the client. If you change the UPI ID later, replace the image too.
- **Test:** with both servers running, `node server/test/billing.mjs` (37 checks; creates and removes its own data).

## Layout

- `server/` Node + TypeScript: REST, Socket.IO, game rules/clocks (chess.js), persistence, analysis queue
- `worker/` Python: Stockfish via python-chess, embeddings, pgvector writes
- `client/` React + Vite
- `db/init.sql` schema (runs on first container start; `docker compose down -v` to reset)

## Notes

- The worker image installs Python packages from `worker/wheels/` (git-ignored) because a corporate proxy can break TLS inside Docker builds. Create them once on the host before `docker compose up --build`:
  ```
  cd worker
  python -m pip download redis==5.2.1 "psycopg[binary]==3.2.3" numpy==2.1.3 typing_extensions -d wheels --platform manylinux2014_x86_64 --platform manylinux_2_28_x86_64 --platform manylinux_2_17_x86_64 --only-binary=:all: --python-version 3.12 --implementation cp
  python -m pip wheel chess==1.11.2 --no-deps -w wheels
  ```
  On a normal network you can instead change the Dockerfile to `pip install -r requirements.txt`.
- Smoke test (server must be running): `node server/test/smoke.mjs`.
