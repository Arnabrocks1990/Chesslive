// Time-control presets and the mode a given control falls into (same thresholds Lichess uses:
// estimated duration = base seconds + 40 x increment).
export interface Preset { minutes: number; increment: number }
export interface Mode { key: string; label: string; blurb: string; presets: Preset[] }

export const MODES: Mode[] = [
  { key: "bullet", label: "Bullet", blurb: "Lightning fast, under 3 minutes", presets: [{ minutes: 1, increment: 0 }, { minutes: 1, increment: 1 }, { minutes: 2, increment: 1 }] },
  { key: "blitz", label: "Blitz", blurb: "Quick games, 3 to 8 minutes", presets: [{ minutes: 3, increment: 0 }, { minutes: 3, increment: 2 }, { minutes: 5, increment: 0 }, { minutes: 5, increment: 3 }] },
  { key: "rapid", label: "Rapid", blurb: "Time to think, 8 to 25 minutes", presets: [{ minutes: 10, increment: 0 }, { minutes: 10, increment: 5 }, { minutes: 15, increment: 10 }] },
  { key: "classical", label: "Classical", blurb: "Slow and careful, 25+ minutes", presets: [{ minutes: 30, increment: 0 }, { minutes: 30, increment: 20 }, { minutes: 60, increment: 0 }] },
];

export function modeOf(baseSeconds: number, incSeconds: number): Mode {
  const est = baseSeconds + 40 * incSeconds;
  return MODES[est < 179 ? 0 : est < 479 ? 1 : est < 1499 ? 2 : 3];
}

export const tcLabel = (minutes: number, increment: number) => `${minutes}+${increment}`;
