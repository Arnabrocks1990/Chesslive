# PRD: Live Multiplayer Chess with an AI Move-Suggestion Agent

Status: Draft for review (no code written yet)
Date: 2026-10-22

## 1. Vision
A browser-based chess platform where players invite friends to live games, plus an AI agent that watches each live game, suggests the best next move, and stores every game and its analysis so its advice improves over time.

## 2. Open decision: fair play (must be settled before build)
A real-time "best move" engine inside a live game between humans is, by default, an engine-assist cheat. Chess.com, Lichess and similar platforms ban this. To keep the product legitimate, the agent runs under an explicit **Assist Mode** chosen at game creation:

| Mode | Who sees suggestions | Use case |
|---|---|---|
| Off (default for "Rated/Standard") | Nobody during play; full analysis after the game | Fair competition |
| Assisted (all players opt in) | Every player sees suggestions, visibly flagged in the UI | Casual/learning games |
| Coach | One player (e.g. a learner) vs. a bot or consenting opponent | Training |
| Spectator/Commentary | Spectators only, with a delay | Streaming, teaching |
| Vs. Bot | Human vs. the agent's engine | Practice |

Recommendation: ship Assisted, Coach, Spectator and Vs. Bot in v1, and always show opponents when assist is on. The rest of this PRD assumes this model.

## 3. Goals and non-goals
Goals
- Create a game, share an invite link, play live in the browser (moves under 150 ms end-to-end).
- Agent produces top-N moves with evaluation and an explanation within about 1.5 s of each position.
- Every game, move and analysis is persisted and searchable.
- Agent quality measurably improves as the game corpus grows (see section 6).

Non-goals (v1): native mobile apps, tournaments, money/betting, video chat, screen-scraping external sites (chess.com/lichess boards).

## 4. Users
- Casual player: invites a friend, wants a quick game with optional help.
- Learner: wants hints and explanations (Coach mode).
- Spectator: watches a live game with commentary.
- Admin: monitors abuse, engine load, and costs.

## 5. Functional requirements

### 5.1 Live game platform
- F1 Sign-up/login (email + OAuth) plus guest play via invite link.
- F2 Create game: time control (blitz/rapid/untimed), colour choice, assist mode.
- F3 Invite by unique link or username; lobby for pending invites.
- F4 Real-time board: legal-move validation, drag/click moves, promotion, castling, en passant, check/checkmate/stalemate, draw by repetition/50-move/agreement, resign, clocks.
- F5 Reconnect handling: refresh or network drop restores the game state and clock.
- F6 Spectators via link; in-game chat.
- F7 Game history, PGN export, replay.

### 5.2 AI agent
- A1 Starts automatically when a game becomes live (server subscribes to the game's move stream; no manual trigger).
- A2 After each move, returns the top 3 candidate moves, evaluation (centipawns/mate), principal variation, and a plain-language explanation.
- A3 Visible only according to Assist Mode (section 2); enforced server-side, never just hidden in the client.
- A4 Post-game report: accuracy, blunders/mistakes/inaccuracies, critical moments, opening identified.
- A5 Vs. Bot with selectable strength.

### 5.3 Memory and learning
- M1 Persist every game: PGN, per-move FEN, engine eval, suggestion given, move actually played, outcome.
- M2 Position embeddings in pgvector so the agent can retrieve similar past positions and what happened next.
- M3 Opening book and "what works here" statistics built from the corpus, shown alongside engine output.
- M4 Per-player profile: style, recurring mistakes, opening repertoire, used to personalise suggestions and explanations.
- M5 Feedback loop: record whether suggestions were followed and how they turned out.

## 6. How the agent actually "gets smarter" (honest scope)
The core move engine (Stockfish) does not learn from our games and will not get stronger from them. Improvement comes from layers around it:
1. Retrieval memory (pgvector): similar positions, past outcomes, opponent tendencies.
2. Player modelling: suggest moves a given player can realistically execute and exploit an opponent's known weaknesses.
3. Better explanations: an LLM turns engine lines plus retrieved history into coaching text; quality improves with more context.
4. Optional later (v2+): train a small policy/value model or fine-tune a human-like move predictor (Maia-style) on our corpus. This needs thousands of games and is not in v1.

Success metrics for "smarter": rising suggestion-follow-then-win rate, higher explanation helpfulness rating, and better opponent-move prediction accuracy as the corpus grows.

## 7. Non-functional requirements
- Latency: move broadcast p95 under 150 ms; suggestion p95 under 1.5 s at depth about 18.
- Scale target v1: 500 concurrent games, 5k registered users.
- Availability 99.5%; no lost moves (persist before ack).
- Security: authenticated WebSockets, server-authoritative game state, rate limits, server-side enforcement of assist visibility.
- Privacy: games are stored per user's consent; allow delete/export.
- Accessibility is out of scope for this phase.

## 8. Architecture

```
React SPA (Vite, TS)
  |  WebSocket (Socket.IO) + REST
Game/API server (Node.js + TypeScript)
  - auth, lobby, invites, game rooms, clocks, chess.js validation
  - publishes "move" events to Redis streams
  |                                |
PostgreSQL + pgvector        Analysis workers (Python)
  users, games, moves,         - Stockfish via UCI (engine pool)
  analysis, embeddings,        - embedding + retrieval (pgvector)
  player profiles              - LLM explanation (Claude API)
                               - post-game reports / profile updates
Redis: pub/sub, job queue, live game state cache
```

Flow: player moves -> server validates and persists -> broadcasts -> emits event -> worker runs Stockfish + retrieves similar positions + drafts explanation -> result pushed back through the server, filtered by assist mode -> clients render.

## 9. Technology choices

| Layer | Choice | Why |
|---|---|---|
| UI | React + TypeScript, Vite, react-chessboard, chess.js, Zustand/TanStack Query | Mature board components, shared types with the backend |
| Realtime | Socket.IO (WebSocket) | Rooms, reconnects, fallbacks built in |
| Backend API | Node.js + TypeScript (NestJS or Fastify) | See section 10 |
| Analysis | Python worker + Stockfish (UCI), python-chess | Best chess/ML ecosystem |
| DB | PostgreSQL 16 + pgvector (HNSW index) | As requested; one store for relational + vectors |
| ORM/migrations | Prisma or Drizzle (Node); SQLAlchemy only in workers | |
| Queue/cache | Redis (BullMQ or Streams) | Decouples game loop from CPU-heavy analysis |
| LLM | Claude API for explanations/coaching | Explanations grounded in engine lines and retrieved history |
| Infra | Docker Compose locally; containers on a cloud host; CPU-optimised workers | Stockfish is CPU-bound |
| Testing | Vitest, Playwright (multiplayer E2E), pytest | |

### Embedding positions in pgvector
Chess positions are not text. Options, in order of recommendation:
1. Feature vector: 12x64 piece-plane encoding (768 dims) plus side-to-move, castling and material features, reduced with PCA to about 128 dims. Simple, deterministic, no training needed.
2. Learned embedding from a small network trained on our own games (v2).
Cosine search with HNSW; store eval and outcome alongside each vector.

### Core schema (outline)
`users`, `games` (id, white, black, mode, pgn, result, time_control), `moves` (game_id, ply, san, fen, clock), `analyses` (move id, top_moves jsonb, eval, pv, explanation), `position_embeddings` (fen_hash, embedding vector(128), eval, outcome_stats), `player_profiles`, `suggestion_feedback`, `invites`.

## 10. Backend: Node.js vs Python

| | Node.js (TypeScript) | Python (FastAPI) |
|---|---|---|
| Realtime/WebSockets | Excellent: event loop suits many idle sockets, Socket.IO is mature | Good (FastAPI/websockets), but fewer batteries for rooms and reconnect |
| Shared code with React | Same language and types; chess.js on both sides | Separate types; duplicate validation logic |
| Chess/ML ecosystem | Adequate (chess.js, Stockfish via child process) | Best: python-chess, PyTorch, numpy, scikit-learn, embeddings tooling |
| CPU-heavy work | Blocks the event loop unless offloaded | Also GIL-limited, but easy to run as separate worker processes |
| Engine integration | Spawn Stockfish via UCI, fine | python-chess has first-class UCI engine support |
| Team velocity | One language across stack | Two languages if mixed with a JS frontend anyway |
| Hiring/maintenance | Large pool | Large pool |
| Learning/analytics roadmap | Weaker | Strong |

Recommendation: hybrid. Node.js + TypeScript for the realtime game server and API (where concurrency and shared types matter), and Python workers for analysis, embeddings, and later model training (where the ecosystem matters). They communicate through Redis and share Postgres. If you want a single-language v1 to start faster, use Node only and add the Python worker when you reach the learning phase (M4/section 6.4); Stockfish works fine from Node.

## 11. Plan of action

| Phase | Scope | Rough effort |
|---|---|---|
| 0. Foundations | Repo, Docker Compose (Postgres+pgvector, Redis), CI, schema, auth | 1 week |
| 1. Live chess MVP | Lobby, invite links, real-time board, clocks, reconnect, persistence, replay | 3 weeks |
| 2. Agent v1 | Stockfish worker, auto-start on live game, top-3 moves + eval, assist-mode enforcement, Vs. Bot | 2 weeks |
| 3. Memory | Store full analytics, position embeddings, similar-position retrieval, opening stats | 2 weeks |
| 4. Coaching | LLM explanations, post-game report, player profiles, feedback loop | 2 weeks |
| 5. Hardening | Load test (500 games), abuse limits, observability, deploy | 2 weeks |
| Later | Learned embeddings / human-like move model, spectator commentary, mobile | TBD |

Estimates assume one to two engineers; they are rough, to be refined after Phase 0.

## 12. Risks
- Cheating/ToS: mitigated by Assist Mode and server-side enforcement (section 2).
- Engine cost: Stockfish at depth 18 per move is CPU-heavy; mitigate with a worker pool, depth caps, caching by FEN, and analysing only assisted/coached games live.
- "Learning" expectation mismatch: see section 6; set expectations that the engine itself does not improve.
- Cold start: retrieval memory is useless with few games; seed with public PGN databases (e.g. Lichess open database, licence permitting).
- Realtime correctness (clocks, reconnects): server-authoritative state and thorough multiplayer E2E tests.

## 13. Out of scope / not building
Auto-capturing boards from other chess sites (chess.com, lichess, etc.) and suggesting moves in live games there. It violates their terms and is a cheating tool; it is not being built. Legitimate alternatives that can be added: import a finished game by PGN or link for post-game analysis, and analyse a position from a screenshot or board photo for study.

## 14. Decisions (confirmed 2026-10-22)
1. Fair play: live AI assistance is available to the **admin role only**; all other players play without it. Enforced server-side (suggestions are emitted only to admin sockets). The assist-mode table in section 2 is superseded by this rule; other modes can be added later.
2. Architecture: hybrid. Node.js + TypeScript game server, Python analysis worker.
3. Hosting: localhost for now (server on port 8001), AWS later.
4. Explanations: Claude Code CLI on the team plan, no API key.
5. No seeding from public game databases for now.
6. Project location: `C:\Automate\Chess`.
