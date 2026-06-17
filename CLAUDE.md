# Kittens Game Helper — contributor guide

Single-file Tampermonkey userscript that autopilots [Kittens Game](https://kittensgame.com)
by driving the game's own `window.gamePage` API. Everything lives in
`src/kittens-game-helper.user.js`; tests live in `scripts/`.

## Golden rules

### 1. Bump the version on EVERY change (even one-liners)

There are **three** version strings and they must always match:

| Location | Field |
| --- | --- |
| `src/kittens-game-helper.user.js` | `// @version      X.Y.Z` (UserScript header) |
| `src/kittens-game-helper.user.js` | `const HELPER_VERSION = "X.Y.Z";` |
| `package.json` | `"version": "X.Y.Z"` |

Use semver: patch (`Z`) for fixes/tweaks, minor (`Y`) for new behavior, major
(`X`) for a planner/architecture overhaul. `npm run validate` fails if the three
strings disagree, so a forgotten bump is caught by the test suite. Tampermonkey
also relies on a rising `@version` to offer the update, so this is user-visible.

### 2. Tests must pass before every commit

```
npm test   # validate (static + version) → smoke (behavioral) → simulate (multi-tick)
```

When you change planner behavior, add/extend a regression test that reproduces
the exact live state you are fixing. The smoke harness exposes `window.__kghDebug`
(`selectStrategicTarget`, `planText`, `nowText`, `detailsText`, `activeSprint`, …)
so a scenario can be asserted from the real decision path, not a reimplementation.

### 3. Keep it one file, fully native, reset-safe

No external libraries, no Kitten Scientists bridge. Irreversible actions
(reset/transcend/sacrifice/shatter/time-skip) are filtered out of every candidate
list and must stay that way.

## Strategic planner — selection invariants

`selectStrategicTarget` chooses a target through ordered layers (highest wins).
These are GOAL-INDEPENDENT unless noted — balanced, speedrun and milestone goals
share the same structural priority so a fix in one mode can't regress another:

```
Research sprint            persistent cross-tick contract to assemble a buyable tech
Hard unlock / milestone    a tech/upgrade that opens new content or the goal path
Science storage unlock     ← science is capped AND the next valuable tech is storage-blocked
Storage blocker            a resource cap is actively wasting income
Production bottleneck       a needed resource has no production/craft path
Housing / population
Economy / normal growth     the general ROI scorer
Long project               Temple, Ziggurat, religion/space/time structures
```

Key invariants (see comments in the source for the why):

- **Science storage unlock outranks long projects, and its trigger is UNIVERSAL.**
  It is goal-independent AND science-VALUE-independent: the only condition is
  structural — the *next valuable research* (cheapest open, unresearched,
  content-unlocking tech) cannot fit the science cap (cost > science max, but
  within `SCIENCE_UNLOCK_REACH`× the cap). When that holds, science will climb to
  the cap and stall there until storage grows, so the planner targets the best
  actionable cap-growth building (Library / Academy / Observatory / any
  `scienceMax`-style effect) — never the blocked tech directly, never a Temple —
  *no matter how much science is currently banked*. Do NOT gate this on
  "science is near cap": that made the plan flicker back to Temple the moment
  science dropped below the cap mid-build. "Valuable" means the tech actually
  unlocks content (`gatewayValue > 0`); a filler tech can't anchor a storage
  sprint. If the next valuable tech already fits the cap (just research it), is
  too far above the cap, or no cap-growth candidate is actionable, the layer
  yields and normal scoring (eventually a long project) resumes.
- **Structural layers own the plan directly.** A live research sprint and a
  science-storage unlock both bypass the economy target-lock, so a half-saved
  Temple can never hold the plan hostage.
- **The science-storage unlock COMMITS to one building (no flicker).** The game
  often doesn't expose a building's `scienceMax`/`scienceRatio` until
  `calculateEffects` runs, so `scienceStorageGain` ties at 0 and the secondary
  score/wait keys wobble tick-to-tick. Because this layer bypasses the lock, that
  wobble used to flip the plan between Library and Observatory every tick. The
  layer remembers its pick (`activeScienceUnlockId`) and keeps it until it leaves
  the option set or a rival grows the cap >20% more — so it commits instead of
  oscillating.
- **Storage-blocked banks never become craft targets.** A tech whose final
  science price can't fit storage is deferred, not crafted toward (no compendiums
  for Electricity until the final cost fits).
- **No-op policies are excluded from planning** (`isNoopPolicyCandidate`, e.g.
  Socialism) — they are never gathered as candidates, auto-bought, or advised.
