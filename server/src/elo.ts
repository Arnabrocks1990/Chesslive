export const START_RATING = 600; // new accounts start here (accounts created earlier keep the rating they had)
export const MIN_RATED_PLIES = 4; // very short games are not rated (stops rating farming by instant resignation)
export const FULL_STRENGTH_ELO = 3200; // rating the full-strength bot counts as when rating its opponent

export interface Side {
  rating: number;
  games: number;
  bot: boolean;
}

const kFactor = (games: number) => (games < 30 ? 32 : 20);

/** Standard Elo. `score` is White's result (1, 0.5, 0). The bot is never rated (null change). */
export function eloChange(w: Side, b: Side, score: number) {
  const expectedW = 1 / (1 + 10 ** ((b.rating - w.rating) / 400));
  return {
    white: w.bot ? null : Math.round(kFactor(w.games) * (score - expectedW)),
    black: b.bot ? null : Math.round(kFactor(b.games) * (expectedW - score)),
  };
}

export const scoreOf = (result: string) => (result === "1-0" ? 1 : result === "0-1" ? 0 : 0.5);
