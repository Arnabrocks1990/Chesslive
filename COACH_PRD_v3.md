# PRD v3: Chess Live + AI Chess Coach + Learner Mode

Event: AIBD-26 (Oct 24, 2026). Track: AI for Learning.
Supersedes `COACH_PRD_v2_AGENTIC.md`. This version describes what is actually built in `C:\Automate\Chess` as of the end of the event build, with verification status. Cost and market figures are estimates and are marked as such.

## 1. One-line pitch
An AI chess coach that works on its own. It reads your finished games, finds the mistakes you keep repeating, turns them into a 7-day outcome-based plan you can actually practise, adapts the plan to your results, and keeps watching for new games. Complete beginners start in Learner mode, which teaches the rules from zero.

Chess.com tells you what you got wrong. This coach decides what you should practise next, checks that you did it, and adjusts.

## 2. Who it is for
| User | Need | Where they start |
|---|---|---|
| Absolute beginner | Learn the rules and play a first game without feeling lost | Learner mode (12 lessons, Beginner bot) |
| Improving player (about 600-1800) | Know what to fix and be drilled on their own mistakes | Coach: enter a Lichess username or paste PGN |
| Parent of a junior player | See that the child is practising and improving | Shareable report, progress card |
| Coach or academy (phase 2, not built) | See many students at once | Roadmap |

## 3. Problem
- Players repeat the same few mistake types for hundreds of games. Existing review is per game, full of engine language, and passive.
- Beginners hit a wall at the rules and notation (squares, "Nd4", "en prise") before they get any value.
- Human coaches solve both but are costly and cannot review every game.

## 4. What is built
Status key: **Verified** = exercised against the running system (API or real data). **Built** = implemented and builds/typechecks but not exercised end to end. **Stub** = visible placeholder.

### 4.1 Chess Live base (existing prototype, extended)
- Multiplayer games with invite links, clocks, resign/draw, Coach, Elo ratings, profiles, leaderboard, game reports. (Verified earlier; unchanged.)
- Live AI assist remains **admin-only**; the coach never assists players during a game.
- **Game modes (new):** Bullet (1+0, 1+1, 2+1), Blitz (3+0, 3+2, 5+0, 5+3), Rapid (10+0, 10+5, 15+10), Classical (30+0, 30+20, 60+0) and custom time. Mode label shown in "My games" and above the board. Verified: server honours each control. One shared Elo for all modes (no per-mode ratings).

### 4.2 AI Coach agent
| Capability | Detail | Status |
|---|---|---|
| Import | Lichess username (finished games, with clocks), pasted PGN. Chess.com importer written but the API returned 403 from this network | Lichess Verified; Chess.com untested; PGN Built |
| Analysis | Existing analysis worker, post-game queue. About 0.12 s per position measured (91-ply game in 11 s) | Verified |
| Mistake tagging | Rule-based: hanging piece, missed tactic, missed mate, allowed mate, back-rank, opening error, endgame conversion, time trouble, other. Thresholds match `report.ts` | Verified on real games; labels are "likely cause" |
| Weakness ranking | Score = frequency x win-chance loss x recency; per-100-moves trend between two windows of games; "other" never becomes a coaching focus | Verified |
| Planner | LLM decides one of keep_plan / adjust_focus / escalate / nudge / ask_more_games from structured facts; rules fallback if the call fails. Calls the Anthropic API (`ANTHROPIC_API_KEY` in `server/.env`, model `claude-sonnet-5-5`). Earlier verification ran on the Claude CLI; the API path is wired but not yet verified (the key supplied was rejected with 401) | Built |
| Plan and explanations | LLM writes diagnosis, 7-day plan and short explanations from engine data; template fallback | Verified; explanation grounding prompt tightened but only re-checked on later runs |
| Live trace | Every tool call and decision is stored (`agent_runs`, `agent_steps`) and shown live | Verified |
| Autonomy | Poller wakes the agent on new games or idleness (`COACH_POLL_MS`, `COACH_IDLE_HOURS`). "Simulate new game" injects a clearly labelled stored game as the demo backup | Simulate Verified; poller not observed firing (disabled in tests); idle nudge untested |
| Nudges | Stored as a preview only; nothing is sent | Stub |
| Report sharing, delete | Public read-only report by token; delete-my-data | Verified |

Division of labour: **The engine and rule code are the source of truth for chess facts. The LLM chooses, explains and writes.** Player-facing text calls the engine's move "the coach move".

### 4.3 Outcome-based 7-day plan (new)
The plan is no longer a list of advice. Each day is a session with a measurable outcome.
- **Session types:** drill (5 positions from the player's own mistakes, target 3 of 5), review (re-solve the toughest or previously missed positions), practice game (15+10 vs the bot, target at most 2 blunders, judged by the post-game the engine report).
- **Each day has three parts:** Learn (authored lesson with habits and a "before every move" checklist), Practise, Milestone.
- **Progression:** day N unlocks when day N-1 reaches its milestone. Timeline UI with done, current, locked and payment states and a milestones progress bar.
- **Adaptation (logged in the agent trace):** first miss keeps the day open with a retry set that puts missed positions first; second miss moves on "with support" and queues the missed positions in Train; finishing day 7 starts a weekly review run that builds the next plan.
- **Hints:** three per question, revealed one at a time on click, built deterministically from engine data (what to think about, which piece, where it goes). Hints used are recorded.
- Status: backend flow Verified through API (fail, retry, pass, unlock, lock, paywall, practice-game start). Practice-game judging after a played game not exercised. UI built and typechecked, not clicked through in a browser.

### 4.4 Plain English mode (new)
A "Standard | Plain English" tab (Standard is the default; Plain English is offered as the simpler option, and the choice is remembered).
- Moves described in words with arrows on the board instead of notation and square names; deterministic reasons ("After you moved your knight, your opponent could win your knight for nothing or a bad trade").
- Lessons and hints have authored plain versions.
- The plan text (diagnosis, rationale, day titles and notes) is reworded by one cached AI call that may only reword. Verified: 25 s once, then cached.
- Not simplified: the agent trace and the floating coach's free-text answers.

### 4.5 Monetisation (demo)
- Days 1-2 free; Days 3-7 require "Pro" at an assumed INR 299 per month. The server returns 402 for locked days.
- **The checkout is a labelled demo**: no money moves and no payment provider is connected. A real provider replaces the checkout handler.
- **Admin-only reset** (server-enforced 403 for everyone else): restarts the day sessions, drill counters and the demo payment so the demo can be repeated. Verified for admin and for a regular user.

### 4.5b Voiceover (new)
The coach reads lessons, hints, answers and milestone results aloud during the 7-day plan, in whichever language mode (Standard or Plain English) is showing. Notation is converted to words ("Nd4" becomes "knight to d4"). Primary voice: ElevenLabs through a server route (key never reaches the browser, phrases cached on disk, per-user hourly character cap). Fallback: the browser's speech engine, which uses the built-in Microsoft voices on Windows, used automatically when ElevenLabs has no key, is over quota or fails. Voice on/off toggle and a Listen / Replay button on each block. Verified: server route returns audio and serves repeats from cache; the browser playback and the Windows fallback have not been listened to in a browser. The free ElevenLabs plan allows 10,000 characters a month, which a busy demo can exhaust (then the fallback takes over).

### 4.6 Floating coach and navigation (new)
- Floating launcher on every page except live game pages (fair play): status, focus, live last steps, actions (open report, run now, simulate game), suggested questions and an "Ask your coach" box answered only from the player's analysed data.
- Top menu: Play, Learn, AI Coach. (A note for the record: an earlier build claimed this menu before it was actually in the page; it is in now.)

### 4.7 Learner mode (new)
For people who have never played chess.
- **12 interactive lessons:** board and goal, pawn, rook, bishop, queen, knight, king, piece values, check, checkmate (incl. stalemate), special moves (castling, promotion, en passant), how to start a game. Click-to-move with legal-move dots, quizzes, hints after two misses, "Show me" after three. Every position and solution was machine-checked.
- **Stars and XP:** 1-3 stars by mistakes; lesson XP 50/75/100; replays only improve the best result.
- **Beginner bot:** server-side, mostly random legal moves with occasional greedy captures and mate-in-one. Verified: replied to 6 of 6 moves in 0.8-1.5 s.
- **Server-verified XP:** finishing a Beginner-bot game (+40), first win (+100), first checkmate (+60), each paid once.
- **Levels:** Newcomer, Pawn, Knight, Bishop, Rook, Queen; completing all 12 lessons makes a Graduate.
- **Leaderboard reflection:** lobby leaderboard has a "Players" tab (Elo, with a learner badge such as "Pawn" next to learners) and a "Learners" tab ranked by XP. Lobby banner invites new players to start learning. Verified through API.
- **Known gap:** lesson completion is reported by the browser, so a technical user could claim lessons they did not do. Game XP is server-verified.

## 5. User workflows
1. **Beginner:** lobby banner or Learn menu, work through lessons, play the Beginner bot, appear on the Learners tab, graduate, then use the coach once they have finished games.
2. **Improving player:** enter a Lichess username, watch the agent trace (fetch, analyse, tag, rank, decide, plan), read diagnosis and weaknesses, start Day 1, use hints, hit milestones, play the practice game, get a new plan after day 7.
3. **Autonomy demo:** press "Simulate new game"; the agent wakes, re-analyses, changes the focus and writes plan v+1, with reasons in the trace.
4. **Admin demo:** reset the demo between runs.

## 6. Architecture (as built)
```
React UI (lobby, game, coach, timeline, sessions, learner, floating coach)
   | REST (polling for live trace)
Node/TS Express + Socket.IO server
   - coach/: importer, analysis queue, tagger, agent loop, sessions, hints, lessons, routes, poller
   - learner.ts: XP, levels, leaderboard, beginner bot
   - claude.ts: Anthropic API client for decisions and text (rules fallback when it fails)
   |                          |
Python worker (the engine)     Postgres (pgvector) + Redis, in Docker
```
Tables added: players, mistakes, drills, plans, plan_sessions, session_questions, subscriptions, plain_cache, agent_runs, agent_steps, learner_progress, learner_events; columns added to games (source, external_id, player_id, player_color, played_at) and users (learner). Created idempotently at boot.

## 7. Guardrails
- **Fair play:** analyses finished games only; no coach on live game pages; live assist stays admin-only.
- **Truth:** hints, plain text and drill answers are derived from stored engine output and rules; the LLM is prompted never to evaluate positions and to restate only engine data.
- **Consent and privacy:** public games of the entered username or uploaded PGN; delete-my-data.
- **Cost and safety:** step-limited deterministic loop, two LLM calls per run, rules fallback, one run per player at a time.
- **Human control:** the plan and every agent action are visible; admin reset is role-checked on the server.

## 8. Business model (estimates, not measured)
- Free: Days 1-2 and Learner mode. Pro: INR 299 per month (or about USD 4.99) for Days 3-7, practice-game judging, weekly review and autonomous updates. Academy seats are a phase-2 idea.
- Variable cost: the engine is near zero per game; LLM cost per run is an estimate of INR 3-8 on a mid-tier model; LLM calls now use the Anthropic API, so they are billed per token and no longer serialised.
- Market sizing in v2 stays as a rough estimate and should be re-verified before presenting.

## 9. Success metrics
**Hackathon:** 20 distinct real users outside the team complete an import and view a report; at least 10 start Day 1; at least 3 see a second agent run; at least 5 quotes; any pre-commit or demo-checkout clicks counted separately and labelled as demo. Count Learner-mode users separately.
**Product:** Day-1 completion, day-3 paywall reach, milestone pass rate, blunders per 100 moves trend, learner lesson completion and graduation, second-week return, cost per active user.

## 10. Risks and limitations
| Risk | Status |
|---|---|
| Not run in a browser by the builder; UI defects likely | Open: first thing to do is click through every screen |
| Real payments absent | By design for now |
| Anthropic API key rejected (401 invalid x-api-key) in the last test, so AI features currently run on rule fallbacks | Open: needs a valid key in `server/.env` |
| Chess.com import blocked here (403) | Use Lichess or PGN |
| Replit deployment: no Docker there, so Postgres+pgvector, Redis and the analysis worker need replacing | Not done; verify the engine on Replit before the event |
| Learner XP from lessons is client-reported | Known; server-side lesson verification is the fix |
| Tag labels can misfire; many mistakes land in "Other" | Labelled "likely cause" |
| Simulated games are fabricated openings with scripted endings | Always labelled "simulated" |
| Pre-built code vs event rules | Confirm with organisers and disclose |
| Single Elo across game modes; no chess variants | Not built |

## 11. Not built / roadmap
Real payments (Razorpay or Stripe); email or Telegram nudges (preview only today); coach/academy dashboard; spaced-repetition scheduling beyond the simple intervals; per-mode ratings; Chess960 and other variants; server-side lesson verification; Replit deployment; separate per-user coach accounts (players are currently shared across signed-in users, which is fine for a demo and not for production).

## 12. Demo script (3 minutes)
1. "Chess.com shows you what you got wrong. Our coach decides what you should practise, and keeps working." Enter a Lichess username; show the live agent trace.
2. Diagnosis and weaknesses; switch to **Plain English** to show the same advice in simple words with arrows.
3. Open the timeline: Day 1 exercise on a position from the player's own game, use a hint, answer, see the milestone.
4. Show the Day 3 paywall (demo checkout) and say plainly that payments are in test mode.
5. Press **Simulate new game**: the agent wakes, changes the plan, and explains why in the trace.
6. Show **Learner mode**: lesson on the board, the Beginner bot, and the Learners leaderboard tab.
7. Close with traction, pricing (free learner mode, Pro coach) and the unit economics above, labelled as estimates.

## 13. Changes since v2
Added: outcome-based sessions and timeline, adaptive retry logic, practice-game sessions, three progressive hints, "coach move" wording, Plain English mode, demo paywall and admin reset, floating coach with grounded Q&A, game modes, Learner mode with Beginner bot, XP and Learners leaderboard, top menu. Unchanged from v2 and still open: nudges beyond preview, coach dashboard, Replit adaptation.
