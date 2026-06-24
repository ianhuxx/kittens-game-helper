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

### 4. Read every rate LIVE — never bake in base numbers

Production, conversion and marginal-per-kitten math must read the game's CURRENT
state, not a baked-in base modifier:

- Per-resource rates go through `productionFor` (→ `game.getResourcePerTick`, cross-
  checked against the observed resource-bar delta), so seasonal modifiers,
  processing buildings and reassignment are all reflected.
- Marginal per-kitten output uses live `village.getResProduction()` ÷ staffed count
  (production is linear in count, so average == marginal); the base `job.modifiers`
  rate is a fallback only when a job is unstaffed.
- Catnip output MUST be multiplied by the live season/weather modifier
  (`catnipWeatherMultiplier` → `calendar.getWeatherMod`, the "[+50%]" badge) — it is
  applied above village output, so `getResProduction` omits it.
- The catnip→wood (and any) conversion yields `1 + craftRatioFor(name)` per craft,
  not 1 — fold the live craft-ratio bonus into pathway comparisons.
- `bestWoodJob` is the canonical example: it weighs a live woodcutter's wood/s
  (incl. Lumber-Mill woodRatio) against refining a farmer's in-season catnip,
  bonus-adjusted. Test D5 pins this; if you touch it, keep the comparison live.

## Strategic planner — selection invariants

There is a SINGLE autopilot — no user-facing goal modes or priority dropdown
(v2.2.0). The `goalKey` plumbing still exists internally and the test suite
exercises it with several keys, but real play always runs the one neutral goal
(`balanced` via `getGoal()`), so layers are GOAL-INDEPENDENT in practice. The
panel exposes a **manual build queue** instead of modes.

`selectStrategicTarget` chooses a target through ordered layers (highest wins):

```
Stage rebuild              atomic continuation after a reversible stage change
Manual queue               ← the player's queued pick, when its front item is actionable
Expansion checkpoint       housing pressure / reset-efficiency population milestone
Resource bootstrap         first live recipe unit needed to reveal new content
Research sprint            persistent cross-tick contract to assemble a buyable tech
Hard unlock / milestone    a tech/upgrade that opens new content or the goal path
Science storage unlock     ← science cap blocks the next valuable tech
Festival maintenance       live housing/happiness payoff, reservation-safe
Building stage transition  reversible change with opportunity-costed rebuild parity
Storage blocker            a resource cap is actively wasting income
Production bottleneck       a needed resource has no production/craft path
Housing / population
Economy / normal growth     the general ROI scorer
Long project               Temple, Ziggurat, religion/space/time structures
```

- **The manual queue overrides everything when actionable.** `pickQueuedTarget`
  returns the front-most queued item that resolves to a reachable candidate
  (`solveCraftChain().reachable`); blocked/locked items are skipped so a bad pick
  can never stall the bot, and completed items (`queueItemDone`) auto-remove. It
  bypasses the economy target-lock like the other structural layers. The queue is
  persisted under `kgh.queue` as `[{ id: "kind:name", val }]`.

Key invariants (see comments in the source for the why):

- **All building reads use the active stage.** Keep raw metadata only as stable
  controller identity. Labels, effects, prices, processing and scoring must use
  `liveMetaView`; do not merge base and stage effects or infer current behavior
  from the raw/base name.

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
- **Science cap candidates must close the measured deficit.** `scienceRatio` is
  production, not storage. Rank only positive live usable-cap effects, project
  repeated price-scaled copies, prefer full closure over partial closure, and
  expose every option's gain/copies/closure/ETA in diagnostics. Text/name matches
  must never qualify an option.
- **Shared-bank research is phased.** A tech such as Robotics may first spend and
  refill science to make Blueprints, then enter a final-bank phase. Only the
  active target may cycle its own cap-drain bank; every external spender still
  sees the complete target ledger.
- **Unlock discovery includes resources and crafts.** Generic bootstrap planning
  reads live hidden-building prices/thresholds and makes the first required craft
  unit without adding a resource-name rule.
- **Stage changes are full transactions.** Evaluate adjacent unlocked stages using
  the 50% refund, bank-limited usable refund, price-scaled parity rebuild,
  downtime utility, energy/consumption penalties, cap safety and payback. Execute
  only through `StagingBldBtnController.deltagrade`; then reserve and rebuild to
  parity before any other plan, with cooldown/hysteresis preventing oscillation.
- **Festivals and expansion are planning layers, not side effects.** Festival live
  prices must respect the active ledger. Housing checkpoints should interrupt
  research only under real population pressure / first-reset milestone pressure;
  the reset itself remains advisory and permanently disabled.
- **Storage-blocked banks never become craft targets.** A tech whose final
  science price can't fit storage is deferred, not crafted toward (no compendiums
  for Electricity until the final cost fits).
- **No-op policies are excluded from planning** (`isNoopPolicyCandidate`, e.g.
  Socialism) — they are never gathered as candidates, auto-bought, or advised.
- **Any non-target spender must evaluate expanded spend impact against the active target ledger.** Direct price checks are insufficient: surplus buys, cap relief, policies, diplomacy, trade, overflow crafting and other spenders must compare their direct costs plus crafted/raw chain impact against `buildTargetLedger()`/`violatesTargetLock()` so a ship/scaffold/plate/slab-style buy cannot consume the material chain being saved for the active focus.
