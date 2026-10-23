import type { AchievementDef, StatDef } from "vibecade-sdk";

export const STATS: StatDef[] = [
  { key: "best_time", label: "Best stage", aggregate: "min", format: "ms" },
  { key: "finishes", label: "Finishes", aggregate: "sum", format: "number" },
  { key: "air_ms", label: "Air time", aggregate: "max", format: "ms" },
];

export const ACHIEVEMENTS: AchievementDef[] = [
  { id: "finish", name: "Stage cleared", description: "Finish a lunar stage.", icon: "🏁", xp: 25 },
  { id: "clean", name: "Clean stainless", description: "Finish without a reset.", icon: "✨", xp: 40 },
  { id: "air", name: "Big air", description: "Spend 4 seconds off the regolith in one stage.", icon: "🦅", xp: 30 },
  { id: "sub70", name: "Sub-70", description: "Finish a stage in under 70 seconds.", icon: "⚡", xp: 60 },
  { id: "beatbot", name: "Dust the pace truck", description: "Beat the practice truck.", icon: "🛻", xp: 20 },
  { id: "boosts", name: "Three kicks", description: "Fire three drift boosts in one stage.", icon: "🔥", xp: 20 },
];

export const MANIFEST = {
  slug: "moon-race",
  name: "Moon Race",
  tagline: "Monster Cybertrucks. Same lunar stage. Lowest time wins.",
  description:
    "A 3D dirt rally on the Moon. You and your rival get the same seeded regolith stage and drive lifted stainless wedge trucks — huge tires, long low-gravity jumps, drift boosts. Hit every gate in order. Fastest time wins (lower is better), live or async.",
  category: "games",
  icon: "🛻",
  accent: "linear-gradient(135deg,#ff8a1e,#7eb6ff)",
  url: "https://github.com/hovtgc/vibecade-moon-race",
  modes: ["live", "async", "practice"],
  players: { min: 2, max: 2 },
  teams: 0,
  spectators: true,
  turnBased: false,
  setup: false,
  scoring: "low",
  authority: "client",
  stats: STATS,
  achievements: ACHIEVEMENTS,
  howTo: [
    "Gas with W. A turns left, D turns right. Hold Space to drift.",
    "Release the drift for a boost. Cross every gate in order.",
    "Lowest stage time wins. Both trucks run the same seeded moon.",
  ],
} as const;
