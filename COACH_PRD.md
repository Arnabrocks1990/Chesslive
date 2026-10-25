# PRD + MVP: AI Chess Coach (post-game, pattern-based)

Status: Draft for AIBD-26 (Oct 24, 2026). Extends the existing Chess Live codebase; does not replace `PRD.md`.
Track: AI for Learning.

## 1. One-line pitch
Chess.com tells you which move was wrong. We tell you **why you keep making the same mistake and what to practise this week**, from your own games, on any platform.

## 2. Problem
- Learners at 600-1800 Elo repeat the same few mistake types (hanging pieces, missed forks, losing won endgames, blundering in time trouble) for hundreds of games.
- Existing game review is per-game and engine-speak ("-2.3 after Nxe5"). It does not aggregate across games, explain at the learner's level, or produce a practice plan.
- Human coaches do this but cost far more and do not scale to reviewing every game.

## 3. Users
| User | Need | Why they pay |
|---|---|---|
| Improving player (adult or teen) | Know what to fix, get drills | Cheaper than a coach; visible progress |
| Parent of a junior player | Coach in the pocket | Already pay for coaching/tournaments |
| Coach / academy (phase 2) | See every student's recurring weaknesses in one dashboard | Saves hours per week; per-seat pricing |

## 4. Positioning vs. alternatives
| | Chess.com / Lichess review | ChatGPT alone | This product |
|---|---|---|---|
| Per-game engine eval | Yes | Unreliable (LLMs misjudge positions) | Yes (the engine) |
| Plain-language reason | Limited | Yes, but ungrounded | Yes, grounded in engine lines |
| Cross-game pattern diagnosis | No | No | **Yes (core)** |
| Weekly plan + drills from *your* mistakes | Generic puzzles | No | **Yes (core)** |
| Works across platforms / own games | Own platform only | Manual paste | **Lichess + Chess.com + PGN** |

Honest caveat: Chess.com could add pattern tracking. Defence is speed, platform neutrality, and the coach/academy relationship.

## 5. MVP scope (hackathon, 12 hours)

### P0: must work in the live demo
1. **Import:** enter a Lichess or Chess.com username -> fetch last 10-20 games (public APIs, no auth). Also paste PGN.
2. **Analyse:** the engine analyses every position of the user's games (existing worker, `post` jobs). Progress bar while running.
3. **Tag mistakes:** each blunder/mistake gets a phase (opening/middlegame/endgame) and a theme (see section 8). Rule-based, deterministic.
4. **Weakness report:** top 3 recurring weaknesses with counts and one example position each, e.g. "You hang pieces to forks: 7 times in 12 games."
5. **LLM coach summary:** one call per report -> plain-language diagnosis at the player's level + a 7-day plan. Grounded in the tagged mistakes and engine lines passed in the prompt (the model never evaluates positions itself).
6. **Mistake Trainer:** replay your own blunder positions on a board and find the best move (answer = stored engine's top move). No puzzle database needed.
7. **Shareable report page** (public link + screenshot-friendly) for the demo and for distribution.

### P1: if time allows
- Second-visit comparison: "blunders per 100 moves: 4.2 -> 3.1" after the user's next batch of games (retention evidence).
- Time-trouble tagging from `[%clk]` PGN comments.
- Coach dashboard (list of student usernames, aggregate weaknesses).
- Email/WhatsApp share of the report.

### Not in MVP
Live in-game assistance for non-admins (stays disabled; fair-play stance in `PRD.md` section 14), multiplayer/Elo/leaderboard (exists, not part of the pitch), tournaments, mobile app, payments beyond a stub.

## 6. User flow
1. Landing page: "Find your 3 chess weaknesses in 2 minutes." Input: Lichess/Chess.com username.
2. Import + analysis progress (target under 2-3 minutes for 10 games).
3. Report: accuracy, weakness cards, coach summary, 7-day plan.
4. "Train your mistakes": 10 positions from your own games.
5. "Come back after your next 10 games" -> progress comparison.

## 7. Functional requirements
- F1 Fetch games: Lichess `GET /api/games/user/{user}?max=N&clocks=true&opening=true` (NDJSON/PGN); Chess.com `GET /pub/player/{user}/games/{YYYY}/{MM}`. Respect rate limits; cache by game id.
- F2 Identify which side the user played; only that side's moves are judged.
- F3 Analysis depth: 10-12 for imports (existing `POST_DEPTH`); run multiple worker replicas to cut wall-clock time; cache analysis by FEN.
- F4 Mistake classification reuses existing win-percentage drop thresholds in `report.ts` (inaccuracy >5, mistake >10, blunder >20).
- F5 Theme tagger (python-chess, in the worker or a new module).
- F6 Aggregation per user: counts by theme and phase, blunders per 100 moves, accuracy trend.
- F7 One LLM call per report with structured JSON output: `diagnosis`, `per_weakness_explanations[3]`, `weekly_plan[7]`.
- F8 Trainer: serve stored positions with the best move hidden; check the user's move; show the engine line and explanation.
- F9 Report persistence and public share URL.

## 8. Mistake taxonomy (rule-based, MVP)
| Theme | Detection |
|---|---|
| Hanging piece | After the played move, opponent has a capture that wins material per static exchange; engine best move did not leave it |
| Missed tactic (fork/capture/check) | Engine best move gains over about 200 cp and is a capture, check, or a move after which the moved piece attacks 2+ higher-value pieces |
| Missed mate / allowed mate | Engine score is a mate for or against that the played move changed |
| Back-rank weakness | Played or allowed mate on rank 1/8 with own king boxed by own pawns |
| Opening error | Mistake or blunder at ply 20 or earlier |
| Endgame conversion | Player had +300 cp or better, fewer than 10 pieces, and fell below +100 |
| Time trouble (P1) | Blunder with under 10% of the clock or under 30 s remaining |
| Other | Anything not matched; still shown with the engine's better move |

Themes are heuristics. Label them "likely cause" in the UI; do not over-claim.

## 9. Data model changes (on top of `db/init.sql`)
- `games`: add `source` (native|lichess|chesscom|pgn), `external_id`, `player_name`, `player_color`. `white_id`/`black_id` are already nullable, so imported games need no fake users.
- `moves`: `clock_ms` exists; backfill from PGN clock comments when present.
- New `mistakes` (game_id, ply, phase, theme[], drop, played_san, best_san, fen_before, explanation).
- New `reports` (id, source_username, created_at, stats jsonb, llm_summary jsonb, share_slug).
- Existing `analyses`, `position_embeddings`, similar-position retrieval and the logistic model can stay; they are not needed for the coach demo.

## 10. AI pipeline
1. Fetch -> store -> enqueue `post` jobs (existing Redis queue `analysis:post`).
2. Worker analyses each position; new step computes themes for the user's mistakes.
3. When all jobs finish, the server aggregates and calls the LLM once.
4. Prompt includes: rating estimate, top 3 theme counts, 3 example positions with FEN, played move, best move, engine line. Instructions: explain simply, never invent evaluations, output JSON.
5. Store report; render.

**LLM access note:** `server/src/claude.ts` shells out to the Claude Code CLI on the team plan, serialised, one call at a time. That is fine for you alone on localhost, but for other people using it at the event it will be slow (queue) and runs on an organisation seat. For the public demo use the Anthropic API with an API key and a fast model, one call per report (about 3-4k tokens in, 1-2k out), and keep the CLI path only as a dev fallback. Check your company's policy on using the team plan for a side project.

## 11. Business model (pitch version)
- Free: 1 report (10 games) per month.
- Pro: INR 299/month or USD 4.99/month: unlimited imports, weekly plan, progress tracking, trainer.
- Academy: INR 99 per student per month, coach dashboard (phase 2).
- Unit cost: about INR 1-4 per report call plus compute; engine cost is near zero per game at depth 12.

## 12. Success metrics
Hackathon: 20 distinct users who import a username or PGN and view a report; at least 8 complete a trainer set; at least 5 give a one-line quote; any paid or pre-commit sign-ups (even INR 99).
Product: reports per user, second-visit rate, blunders per 100 moves trend, trainer completion, coach inquiries.

## 13. Risks
| Risk | Mitigation |
|---|---|
| Import API limits or username typos | Cache; paste-PGN fallback; clear errors |
| Analysis too slow for live demo | Pre-analyse your own demo account; depth 10; 2-4 worker replicas; cap at 10 games |
| Theme heuristics misfire | Label as "likely cause"; keep "Other"; show the engine move regardless |
| LLM hallucinating chess facts | Feed engine lines; model explains, never calculates |
| Cheating perception | Entire product is post-game; live assist stays admin-only |
| Pre-built code vs. event rules | The event brief says build from kickoff. Ask the organisers whether code started earlier is allowed, and disclose it in the pitch |
| Defensibility | Cross-game memory, platform neutrality, coach/academy channel |

## 14. Build plan mapped to existing code
| Task | Reuse | New work |
|---|---|---|
| engine analysis, queue | `worker/worker.py` (`post` jobs), `analyse()` | Add theme tagging; run N replicas in `docker-compose.yml` |
| Mistake labels, accuracy | `server/src/report.ts` | Persist to `mistakes`; add `phase` |
| Profile aggregation | `server/src/profile.ts` | Cross-game theme aggregation endpoint |
| Game storage | `games`, `moves`, `analyses` | `source`/`player_color` columns; PGN importer |
| Board UI, replay | `client/src/GamePage.tsx` | Trainer mode (hide best move, check answer) |
| Report page | `ProfilePage.tsx` styling | `ReportPage.tsx` + public slug |
| Explanations | `server/src/claude.ts` | New `coachReport.ts` using the API, JSON output |
| Auth, Elo, multiplayer | Leave as is | None for MVP |

Suggested order: (1) importer + enqueue, (2) theme tagger + `mistakes`, (3) aggregation + LLM report, (4) report page, (5) trainer, (6) landing page and polish, (7) deploy with a public URL.

## 15. Demo script (3 minutes)
1. "Chess.com says what you got wrong. Watch what we say about *this* player's last 10 games."
2. Enter a real Lichess username live. Show the progress bar.
3. Report: "7 blunders were hanging pieces, 5 were missed forks, you lose most advantages in the endgame."
4. Open the trainer: solve one of your own blunder positions.
5. Show the 7-day plan and the before/after number from a returning user.
6. Close with traction (users, repeats, quotes) and pricing (consumer sub plus academy seats).
