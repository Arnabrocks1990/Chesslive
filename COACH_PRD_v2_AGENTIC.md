# PRD v2: Agentic AI Chess Coach

Event: AIBD-26 (Oct 24, 2026). Track: AI for Learning.
Supersedes `COACH_PRD.md`. Extends the existing Chess Live codebase (`PRD.md`, `worker/worker.py`, `server/src/report.ts`). All cost figures are estimates.

## 1. One-line pitch
An AI coach that **works on its own**: it watches your chess games, finds the mistakes you keep repeating, builds your weekly training plan, drills you on your own blunders, and adapts the plan as you improve.

Chess.com tells you what you got wrong. This coach decides what you should practise next, and keeps doing it every week without being asked.

## 2. Why it is agentic (not a report generator)
A report tool runs once when you ask. This product is an agent because it has all of the following:

| Agent property | How it shows up |
|---|---|
| **Goal** | "Reduce this player's recurring mistakes and raise their accuracy over the next 4 weeks" |
| **Autonomy** | Triggers itself when new games appear; no prompt needed |
| **Tools** | Fetch games, run the engine, tag mistakes, generate drills, update plan, send nudges, evaluate progress |
| **Memory** | Per-player profile: weaknesses, history, plan, drill results, preferences |
| **Planning loop** | Observe -> diagnose -> plan -> act -> evaluate -> adapt |
| **Adaptation** | Plan changes based on results (drills passed, weakness trend, new games) |
| **Observable trace** | Every action is logged and shown to the user ("what the coach did and why") |

Division of labour: **The engine and rule-based code are the source of truth for chess facts. The LLM decides what to do next, explains, prioritises and writes.** The LLM never evaluates positions itself.

## 3. Problem
- Players at roughly 600-1800 Elo repeat the same few mistake types for hundreds of games.
- Existing review is per-game, engine-speak, and passive: it waits for you to open it, and it never checks whether you improved.
- Human coaches do this well but are costly and cannot review every game.

## 4. Users
| User | Need | Why they pay |
|---|---|---|
| Improving player (adult or teen) | Know what to fix and get drilled on it | Cheaper than a coach; visible progress |
| Parent of a junior player | A coach that keeps the child on track and shows progress | Already pay for coaching and tournaments |
| Coach or academy (phase 2) | See every student's weaknesses and plan in one dashboard | Saves hours per week; per-seat pricing |

## 5. Agent design

### 5.1 Goal and triggers
- **Goal:** per player, lower recurring-mistake rate and raise accuracy; measured weekly.
- **Triggers:**
  1. Onboarding: user submits a Lichess or Chess.com username (or PGN).
  2. New games: the agent polls the player's account (about every 5 minutes in the demo, hourly otherwise) and wakes when new finished games appear.
  3. Weekly cycle: scheduled review and new plan.
  4. Idle player: no drills done for N days triggers a nudge.

### 5.2 Tools (what the agent can call)
| Tool | Type | Purpose |
|---|---|---|
| `fetch_games(username, platform, since)` | Deterministic | Pull recent finished games from Lichess or Chess.com public APIs |
| `analyse_game(game_id, depth)` | Deterministic (the engine) | Eval every position; store top moves and scores |
| `tag_mistakes(game_id)` | Deterministic (rules) | Classify each inaccuracy, mistake and blunder by phase and theme |
| `get_player_memory(player_id)` | Deterministic | Weakness counts, trend, current plan, drill history, preferences |
| `rank_weaknesses(player_id)` | Deterministic | Score themes by frequency x cost in win probability x recency |
| `generate_drills(player_id, theme, n)` | Deterministic | Build drill set from the player's own mistake positions (best move from stored engine analysis) |
| `write_plan(player_id, context)` | **LLM** | Compose the 7-day plan and plain-language diagnosis from structured inputs |
| `explain_position(position_id)` | **LLM**, grounded | Explain why the move failed, using the engine line supplied in the prompt |
| `send_nudge(player_id, channel, message)` | Side effect | Email or in-app (and Telegram if time allows); opt-in, rate-limited, preview mode in demo |
| `evaluate_progress(player_id)` | Deterministic | Compare blunders per 100 moves, accuracy, theme counts, drill pass rate with the previous window |
| `update_memory(player_id, patch)` | Deterministic | Persist conclusions and plan changes |

### 5.3 Agent loop (per wake-up)
```
OBSERVE   get_player_memory + check for new games (fetch_games since last run)
ANALYSE   analyse_game + tag_mistakes for each new game
DIAGNOSE  rank_weaknesses -> top 3 themes, compare with last window
DECIDE    LLM planner chooses: keep plan / adjust focus / escalate difficulty / nudge / do nothing
ACT       generate_drills, write_plan, explain_position, send_nudge as chosen
EVALUATE  evaluate_progress; record outcome and reasoning in the trace
REMEMBER  update_memory; schedule next wake-up
```
The planner is a Claude tool-use loop with a step cap (about 12 steps), a per-run token budget, and a fixed system prompt that forbids chess evaluation from the model's own knowledge.

### 5.4 Adaptation rules (examples the demo can show)
- A theme's rate falls for 2 consecutive windows -> mark as improving, reduce its drill share, add the next-ranked theme.
- Drill failed twice -> resurface it with an explanation and a simpler variant (spaced repetition: 1 day, 3 days, 7 days).
- No activity for 3 days -> send one short nudge with a 5-minute drill set.
- A new game shows the same blunder pattern -> raise that theme's priority and say so in the trace.
- Too few games (under 5) -> ask the user to import more instead of drawing weak conclusions.

### 5.5 Guardrails
- **Fair play:** the product analyses only finished games. No live in-game assistance for players; the existing admin-only live assist stays disabled in the coach experience.
- **Truth:** all chess claims come from engine output and rule tags passed to the model; low-confidence themes are labelled "likely cause".
- **Consent and privacy:** analyses only the user's own public games (or uploaded PGN); delete-my-data option; nudges only after opt-in.
- **Cost and safety:** step cap, token budget per run, rate limits on fetching and nudging, kill switch.
- **Human control:** the user can edit or reject the plan, mute nudges, and see a trace of every action.

## 6. User workflow
1. **Onboard (2 minutes):** enter a Lichess or Chess.com username; optional goal ("reach 1400 in 8 weeks") and weekly time available.
2. **Agent run #1 (visible):** a live trace streams: "Fetched 12 games -> analysed 480 positions -> found 3 patterns -> built your plan".
3. **First report:** accuracy, top 3 weaknesses with an example position each, plain-language diagnosis.
4. **Weekly plan:** 7-day plan with a daily 10-minute drill set drawn from the player's own mistakes.
5. **Train:** drill board (find the better move); instant explanation after each answer.
6. **Agent keeps working:** the player plays more games. The agent detects them, re-analyses, updates weakness trends, and adjusts the next drills. It sends a nudge when the player has been idle.
7. **Weekly review:** progress card ("hanging-piece blunders per 100 moves: 4.2 -> 2.9"), plan v2, and a short note on what changed and why.
8. **Coach view (P1):** a dashboard of several students with trends and flagged issues.

## 7. MVP scope (hackathon)

### P0 (must work in the live demo)
1. Import from Lichess or Chess.com username, or pasted PGN.
2. Analysis with the engine via the existing worker (`post` jobs) at depth 10-12; progress shown.
3. Rule-based mistake tagging (phase and theme) stored per game.
4. **Coach agent loop** with tool calls (observe, analyse, diagnose, plan, drills) and a **live step trace** in the UI.
5. Weakness report and 7-day plan written by the LLM from structured inputs.
6. Drill trainer built from the player's own blunder positions, with pass/fail results stored.
7. **Autonomy demo:** the agent polls for new games and, when one appears, re-runs and updates the plan automatically. (Backup: a "simulate new game" button that injects a stored game, so the demo does not depend on the user playing live.)
8. Progress comparison between two windows of games (even if one window is seeded).
9. Shareable report page.
10. Pricing page and **Sprint Pass checkout through Pine Labs** (sandbox/test mode), with webhook-verified entitlements and quota enforcement for agent runs. Test payments are labelled as test.

### P1 (if time allows)
- Pro monthly subscription through UPI AutoPay (needs Pine Labs account-manager enablement), GST invoices, refunds and cancellation.
- Nudges by email (and Telegram) with opt-in and preview mode.
- Spaced-repetition scheduling of drills.
- Coach dashboard for several students.
- Time-trouble tagging from PGN clock data.

### Not in MVP
Live in-game assistance, payments beyond a stub, native mobile, tournaments, WhatsApp integration, learned embeddings for the coach (existing pgvector memory can stay but is not needed).

## 8. Mistake taxonomy (rule-based)
| Theme | Detection |
|---|---|
| Hanging piece | After the move, the opponent wins material by capture; the engine's best move did not leave it |
| Missed tactic (fork, capture, check) | Engine best move gains over about 200 cp and is a capture, check, or lands a piece attacking 2+ higher-value pieces |
| Missed or allowed mate | Mate score appears or disappears because of the played move |
| Back-rank weakness | Mate on rank 1 or 8 with the king boxed in by its own pawns |
| Opening error | Mistake or blunder at ply 20 or earlier |
| Endgame conversion | Player had +300 cp or better with fewer than 10 pieces and dropped below +100 |
| Time trouble (P1) | Blunder with under 10% of clock or under 30 seconds left |
| Other | Anything unmatched; still shown with the engine's better move |

Thresholds reuse `report.ts`: inaccuracy more than 5, mistake more than 10, blunder more than 20 win-percentage points.

## 9. Data model (memory)
- `games`: add `source`, `external_id`, `player_name`, `player_color` (imported games need no fake users).
- `mistakes` (game_id, ply, phase, themes, win_pct_drop, played_san, best_san, fen_before, explanation).
- `players` (id, platform, username, goal, rating_estimate, preferences, last_checked_at).
- `weakness_stats` (player_id, window_start, window_end, theme, count, per_100_moves, trend).
- `plans` (player_id, version, focus_themes, items jsonb, rationale, created_at).
- `drills` (player_id, mistake_id, due_at, attempts, last_result, interval_days).
- `agent_runs` (player_id, trigger, started_at, ended_at, status, tokens, cost_est).
- `agent_steps` (run_id, n, tool, input, output_summary, reasoning_note).
- `nudges` (player_id, channel, message, sent_at, opened).
- Payments and entitlements: `plans`, `orders`, `payments`, `subscriptions`, `entitlements`, `usage_ledger` (see `COMMERCIAL_PLAN.md`, section 5).

## 10. Architecture
```
React UI (landing, report, plan, drills, live agent trace)
   | REST + SSE (stream agent steps)
Node/TS API
   - auth-light (guest or username), importers, scheduler (poller + weekly job)
   - Agent orchestrator: Claude tool-use loop (Anthropic API), step cap, budget
   - Tool layer: deterministic functions + LLM-backed functions
   |                         |
Analysis worker (Python)      DB: Postgres or SQLite (MVP)
   the engine via python-chess    games, mistakes, plans, drills, runs, steps
```
Reuse: `worker/worker.py` (the engine, `analyse`), `server/src/report.ts` (accuracy and labels), `profile.ts` (aggregation), board UI in `client/src/GamePage.tsx`.
Replace for the event: `server/src/claude.ts` shells out to the Claude Code CLI on the team plan; use the Anthropic API with an API key for multi-user use (the CLI path is serialised and runs on an organisation seat).

### Replit adaptation
Replit does not run Docker Compose. For the demo: SQLite or Replit Postgres instead of Postgres plus pgvector, an in-process job queue instead of Redis, the engine installed through Nix (or a bundled binary), a Reserved VM deployment, and secrets in Replit Secrets. Verify the engine launches on Replit before the event.

## 11. Business model, payments and commercial plan
Full detail: `COMMERCIAL_PLAN.md`. All figures are estimates.

### 11.1 Plans (India prices include 18% GST, to be confirmed)
| Plan | Price | Includes |
|---|---|---|
| Free | 0 | 1 analysis run (10 games) per month, basic report, 3 drills per week; no autonomous mode |
| Sprint Pass | INR 99 for 7 days (USD 1.99) | Autonomous coach for 7 days, plan, unlimited drills, progress report; one-time payment |
| Pro | INR 299 per month (USD 4.99); annual INR 2,499 | Autonomous coach, weekly plans, spaced-repetition drills, nudges, fair-use cap of 60 games per month |
| Academy | INR 99 per student per month plus GST, minimum 10 students | Coach dashboard, student summaries (phase 2) |

### 11.2 Unit economics (summary)
- Variable cost per Pro user about INR 25-60 per month (agent cycles plus the engine); Sprint Pass about INR 10-25.
- After GST and an assumed gateway fee of about 2%, gross margin is about 74-88% on Pro monthly and about 68-86% on Sprint Pass.
- Fixed cost about INR 6,000-22,000 per month (Render hosting covered by event credits at first). Break-even about 100-150 paying users. Free users cost about INR 3-8 each, so the free tier is capped.

### 11.3 Payments with Pine Labs
- **Provider:** Pine Labs Online (Plural). Documented features include Redirect Checkout, subscriptions based on UPI AutoPay, webhooks, and a UAT sandbox. Subscriptions must be enabled by the Pine Labs account manager. Confirm at the event what the "AgenticOrg" credits actually cover, because they may not include payment gateway access.
- **P0 scope:** Sprint Pass one-time payment through Redirect Checkout in sandbox/test mode; webhook handling with signature verification and idempotency; server-side entitlements and quotas; test transactions clearly labelled as test.
- **P1:** Pro monthly through UPI AutoPay subscription; GST invoices; refund, cancellation, pause and resume.
- **Later:** USD and international cards (confirm with Pine Labs, or add Stripe/Paddle), annual plan, Academy invoicing.
- **Design rule:** put payments behind a provider interface with a clearly marked test adapter, so the product still demos if sandbox access is delayed.
- **Entitlement rule:** an order unlocks a plan only after a verified webhook, never from the browser redirect alone.
- **Cost control:** every agent run writes to a usage ledger; quotas are enforced before a run starts, with an upgrade prompt.

## 12. Success metrics
**Hackathon:** 20 distinct users complete an import and view a report; at least 10 start a drill set; at least 3 are seen in a second agent run triggered by new games; at least 5 one-line quotes; any paid or pre-commit sign-ups.
**Product:** weekly active players, drill completion, blunder rate trend per 100 moves, second-week return, nudge-to-action rate, cost per active user.

## 13. Risks
| Risk | Mitigation |
|---|---|
| Analysis too slow for live users | Depth 10; run 2-4 worker processes; cap at 10 games; pre-analyse the demo account; queue with ETA |
| Autonomy demo depends on a live game | "Simulate new game" fallback with a stored game |
| Theme tags misfire | Label as "likely cause"; keep "Other"; always show the engine move |
| LLM chess hallucination | Evaluate only with the engine; pass engine lines; strict output schema |
| Agent loop cost or runaway | Step cap, token budget, kill switch, cheaper model for routine steps |
| Chess.com or Lichess API limits | Cache by game id; respect rate limits; PGN paste fallback |
| Competitors add pattern tracking | Cross-platform, coach-and-academy channel, drill and progress loop |
| Pre-built code vs. event rules | Confirm with organisers; disclose code started before kickoff |
| India willingness to pay | Academies and parents as buyers; price globally in USD |

## 14. Build plan (event day, Oct 24)
| Time | Task |
|---|---|
| 09:00-10:30 | Kickoff and ideation: lock this scope; decide demo account and seed data |
| 11:00-12:00 | Brand: name, landing page copy and page |
| 12:00-13:00 | Importer, DB changes, analysis queue wired, progress UI |
| 13:00-14:00 | Mistake tagger and `mistakes` table |
| 14:00-15:00 | Agent orchestrator, tool layer, step trace UI |
| 15:00-15:45 | Plan writer, drill trainer, progress comparison; in parallel (teammate): pricing page, Pine Labs sandbox checkout, webhook, entitlements |
| 15:45-16:00 | Deploy (Render, or Replit); smoke test; fallback recordings |
| 16:00-18:00 | GTM: recruit users by username; log runs; trigger second agent runs; collect quotes |
| 18:00-19:30 | Pitch deck, demo video, metrics |
| 19:30-21:00 | Live demo and judging |

## 15. Demo script (3 minutes)
1. "Chess.com shows you what you got wrong. Our coach decides what you should practise, then keeps working." Enter a real username.
2. Show the **live agent trace**: fetched games, analysed positions, found patterns, wrote a plan.
3. Report: "7 blunders were hanging pieces, 5 were missed forks, you lose most advantages in the endgame."
4. Solve one drill from the player's own game.
5. Trigger the **autonomous update**: a new game appears (or simulate it); the agent re-analyses and changes tomorrow's plan, with the trace showing why.
6. Show the progress card (before and after) and a nudge preview.
7. Close with traction, pricing (consumer plan plus academy seats), and unit economics.
