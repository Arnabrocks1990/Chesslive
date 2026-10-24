import { query } from "./db.js";
import { buildReport } from "./report.js";

/** Player profile built from stored games: record, openings, and (where analysed) play quality. */
export async function buildProfile(username: string, viewer: { id: number; role: string }) {
  const [user] = await query<{ id: number; username: string; role: string; rating: number; rated_games: number; created_at: string }>(
    `SELECT id, username, role, rating, rated_games, created_at FROM users WHERE username=$1`,
    [username]
  );
  if (!user) return null;
  // Rating and record are public (they are on the leaderboard); play-quality analysis and openings are private.
  const canSeeAnalysis = viewer.role === "admin" || viewer.id === user.id;

  const games = await query<any>(
    `SELECT g.id, g.code, g.result, g.white_id, g.vs_bot, w.username AS white, b.username AS black,
            (SELECT string_agg(san, ' ' ORDER BY ply) FROM moves m WHERE m.game_id=g.id AND m.ply<=4) AS opening
     FROM games g LEFT JOIN users w ON w.id=g.white_id LEFT JOIN users b ON b.id=g.black_id
     WHERE (g.white_id=$1 OR g.black_id=$1) AND g.status='finished' ORDER BY g.ended_at DESC`,
    [user.id]
  );

  const record = { wins: 0, draws: 0, losses: 0 };
  const openings = new Map<string, { games: number; wins: number }>();
  for (const g of games) {
    const asWhite = g.white_id === user.id;
    const won = (g.result === "1-0" && asWhite) || (g.result === "0-1" && !asWhite);
    if (g.result === "1/2-1/2") record.draws++;
    else if (won) record.wins++;
    else record.losses++;
    if (canSeeAnalysis && g.opening) {
      const key = `${asWhite ? "White" : "Black"}: ${g.opening}`;
      const o = openings.get(key) ?? { games: 0, wins: 0 };
      o.games++;
      if (won) o.wins++;
      openings.set(key, o);
    }
  }

  // Play quality from the most recent fully analysed games.
  let acc = 0, accN = 0, blunders = 0, mistakes = 0, moveCount = 0;
  for (const g of canSeeAnalysis ? games.slice(0, 20) : []) {
    const rep = await buildReport(g.id);
    if (!rep.ready) continue;
    const mine = g.white_id === user.id ? rep.white : rep.black;
    if (mine.accuracy === null) continue;
    acc += mine.accuracy;
    accN++;
    blunders += mine.blunders;
    mistakes += mine.mistakes;
    moveCount += rep.moves.filter((m) => m.color === (g.white_id === user.id ? "white" : "black")).length;
  }

  const total = games.length;
  return {
    username: user.username,
    role: user.role,
    rating: user.rating,
    ratedGames: user.rated_games,
    memberSince: user.created_at,
    games: total,
    record,
    winRate: total ? Math.round((100 * (record.wins + record.draws / 2)) / total) : null,
    restricted: !canSeeAnalysis,
    analysedGames: accN,
    avgAccuracy: accN ? Math.round(acc / accN) : null,
    blundersPer100Moves: moveCount ? Math.round((blunders * 1000) / moveCount) / 10 : null,
    mistakesPer100Moves: moveCount ? Math.round((mistakes * 1000) / moveCount) / 10 : null,
    openings: [...openings.entries()]
      .map(([line, o]) => ({ line, ...o }))
      .sort((a, b) => b.games - a.games)
      .slice(0, 5),
    recent: games.slice(0, 10).map((g) => ({
      code: g.code, white: g.white, black: g.black, result: g.result, vsBot: g.vs_bot,
    })),
  };
}
