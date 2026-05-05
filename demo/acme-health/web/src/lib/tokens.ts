// Motion timings (seconds) and curve — mirrors DECISIONS.md §2 motion table.
export const motion = {
  micro: 0.2, // 200ms
  pane: 0.32, // 320ms
  txidEnter: 0.6, // 600ms
  ease: [0.16, 1, 0.3, 1] as const,
} as const;

// Type scale in pixels — DECISIONS.md §2.
export const fontSize = {
  xs: 12,
  sm: 13,
  base: 14,
  md: 16,
  lg: 18,
  xl: 22,
  "2xl": 28,
  "3xl": 36,
  "4xl": 48,
} as const;
