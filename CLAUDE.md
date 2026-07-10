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
list and must stay that way. One deliberate carve-out (v2.11.0): the repeatable
unicorn→tears sacrifice is performed by the `manageUnicornReligion` subsystem —
never as a candidate — bounded to the measured tears deficit of the ziggurat
upgrade the unicorn planner picked, at the live exchange rate. Alicorn sacrifice
(time crystals → prestige territory) remains fully denied.

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
- Directly job-produced resources that also have craft buttons remain direct work
  targets. Wood is the canonical case: an IN-CAP Hut/Log House deficit should be
  displayed and scored as Wood, then `bestWoodJob` chooses Woodcutters vs Farmers; the
  dependency graph must not pre-collapse the whole target into Refine Catnip.
- **A final price above a CAPPED bank is storage-blocked no matter how the
  resource is produced** (v2.14.0, reversing the v2.11 craft carve-out). Capped
  banks clamp AT their cap, so Refine Catnip can fill wood TO the cap but never
  hold the 202/200 a scaled Library wants — the old "craft-reachable above cap"
  exemption in `directStorageBlockers` / `solveCraftChain` / `buildTargetLedger`
  left the plan locked on an unattainable target forever after a reset. Now such
  a target reads IMPOSSIBLE, the lock breaks with a `rejectedTargets` cooldown
  ("storage cap blocks the final price"), nothing is reserved for it, and the
  storage layer grows the cap so the build resumes on its own. Intermediate
  CUMULATIVE chain needs stay exempt (`capDrainReachabilityFor` models their
  spend-and-refill cycles), as do hunt-refilled luxuries. `directStorageBlockers`
  is the single final-cap test (the expansion layer's identical
  `finalPurchaseCapBlockers` copy was merged into it). Test AG pins the whole
  loop against the live post-reset stall that motivated it; Test W2 keeps the
  in-cap direct-work half.

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
Ziggurat / unicorn path    a funded unicorn-economy step reserves its shared costs
Economy / normal growth     the general ROI scorer
Long project               Temple, Ziggurat, religion/space/time structures
```

- **The manual queue overrides everything when actionable.** `pickQueuedTarget`
  returns the front-most queued item that resolves to a reachable candidate
  (`solveCraftChain().reachable`); blocked/locked items are skipped so a bad pick
  can never stall the bot, and completed items (`queueItemDone`) auto-remove. It
  bypasses the economy target-lock like the other structural layers — and that
  bypass is enforced in `chooseWorkTarget` as a lock TAKEOVER
  (`manualQueueTakeover`, v2.12.0): an actionable queue pick is never
  score/ETA/age-gated behind whatever the autopilot locked earlier. Why the
  queue is or is not driving the plan (front item + the exact blocker text) is
  kept in `queuePlanText` and shown as the `Queue:` subsystem line in the
  diagnostics report. The queue is persisted under `kgh.queue` as
  `[{ id: "kind:name", val }]`. Test AE pins the takeover and the blocked-item
  diagnostics.

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
- **An emergency may only break the plan lock toward a target that ADDRESSES it.**
  A food crisis (catnip <8% and net-negative — already handled by the farmer
  failsafe) may break the lock only toward a catnip producer/store/booster
  (`foodHelpingCandidate`); a power crisis only toward a net-positive generator.
  Critically, the power emergency reads **raw** Wt (`isPowerEmergency`), not
  effective Wt: an effective-only dip (raw Wt fine, Data Centers merely paused for
  power) is NOT an emergency, so a held plan stops ping-ponging between Power
  recovery / Expansion / Science storage every tick and finishing none of them.
  The power-recovery LAYER still reads effective Wt to *start* recovery; only the
  lock *break* is gated on a genuine raw shortfall.
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
- **A sprint paced by a no-job cap-drain trickle GROWS that resource instead of
  freezing the village** (v2.12.0). Culture is the only cap-drain bank no job can
  work (science has scholars, faith has priests), so 35 Manuscripts against
  +0.04 culture/s is a multi-day passive wait that hunting cannot shorten.
  `sprintCapDrainPacing` computes the CUMULATIVE trickle bill through
  `rawPathRequirements` (35×400 culture, never one craft-step), and when the
  wait exceeds `SPRINT_PACING_REDIRECT_S` the sprint keeps its contract but
  redirects the plan target to the best live per-tick producer of that resource
  (Amphitheatre) via the sticky `bestSprintPacingBooster` — storage-only growers
  (cultureMax) never qualify, because bigger batches don't shorten a
  production-bound wait. While redirected: the tech's chain stays reserved
  (`sprintRedirectChainLedger` merges into both the reservation ledger and
  `executePlan`'s surplus gate), jobs revert to normal target-driven needs
  (miners return; the hunter flood only runs when hunting actually paces the
  chain), and the lock follows the contract (`sprintRedirectTakeover`). The
  redirect releases on its own once production catches up. Test AE pins all of
  this against the live save that motivated it.
  Two v2.15.0 amendments (the live 62.54K-science Chemistry/Temple stall):
  **the conveyor keeps CRAFTING while redirected** — `craftTowardTarget` also
  crafts the sprint tech's chain, flooring the plan target's own direct prices
  (`sprintRedirectCraftTarget` + `directPriceFloors`), so a full culture bank
  converts into manuscripts instead of pinning at its cap the moment the
  producer's own manuscript bill happens to be banked — and **the booster pick
  charges each option's own drain of the trickling resource**
  (`boosterPacingSelfDrain`): `(missing + drain)/(prod + gain)` must beat the
  plain wait, so a Temple priced in 81 manuscripts (≈11K culture) can never be
  chosen to "grow culture" it consumes. Test AE pins both directions.
- **Chain jobs follow a chain-gated research target across EVERY layer**
  (v2.16.0). `researchSprintJobNeeds` used to engage only when the
  Research-sprint LAYER owned the plan, so a manual-queue Electricity pick
  (science capped, 67 Compendium → 1K Manuscript → 8K Parchment → ~450K furs)
  fell through to the generic job scorer: 33 Woodcutters/19 Miners chased the
  low wood bank and the rank-2 lookahead candidates while 9 Hunters starved
  the fur chain that actually paced the plan. Now ANY unaffordable research
  target still chain-gated (`researchChainGated`) gets the sprint's chain
  jobs regardless of layer, with four supporting rules keeping the flood
  honest: (1) `targetFurDeficit` (leaf-name `rawPathRequirements`) measures
  the plan's outstanding fur bill, and while it is positive the
  "furs stocked + happy village" busywork clamp and the catpower near-cap
  hard-zero both yield — a 450K-fur bill is a pacer, not busywork; (2)
  scholars keep cycling the science bank during the intermediate phase
  (`sharedInputs` carries science) even when the bank exceeds the tech's
  final price, since compendium/blueprint crafts spend far past it; (3) a
  craftable intermediate no job produces (compendium/manuscript/parchment) is
  NEVER written into `needs` by the climb push (sprint AND generic paths) —
  dead keys staffed nobody but won the bottleneck sort and mislabeled the
  leader/jobs lines; (4) when hunting is the top need the leader promotes the
  Manager trait over the static research→Scientist preference, and the job
  smoothing reset keys on `chainContext` so a queue takeover re-staffs
  immediately instead of decaying the old wood-heavy split over many ticks.
  Test AJ pins all of it against the live save.
- **Rank-order candidates form parallel tiers and are worked simultaneously**
  (v2.15.0). While the plan target waits on a non-craftable trickle (Temple's
  last 124 gold at +0.2/s), `craftTowardParallelCandidates` (runs after the
  plan buy and overflow each tick) crafts the missing intermediates of the
  top-ranked candidates strictly ABOVE `parallelReservationFloors` — the merged
  reservation ledger PLUS the active target's and redirected sprint's BANKED
  direct prices, which `buildTargetLedger` deliberately drops from `reserved` —
  and buys a candidate (throttled, one per tick) once every floor survives the
  spend. A candidate with a non-craftable deficit above its floor (a rival gold
  bill) is skipped whole; cap-drain banks carrying a sprint's cumulative bill
  read as permanent floors and are therefore never spendable here. Surfaced as
  the `Parallel:` segment of the Craft line in the panel and report. Test AI
  pins the floors, the surplus craft, the completing buy and the rival skip.
- **The Workshop roadmap is the sole owner of the deep upgrade backlog**
  (v2.20.6). Ready upgrades enter immediately; non-ready upgrades enter only
  when their cumulative craft-chain ETA is finite and within one hour. The
  roadmap is sticky within the normal 25% hysteresis band, reserves and crafts
  through the ordinary active-plan contract, and resumes after genuine safety
  preemption. Parallel work never scans past its normal ranked window and never
  executes a pending roadmap takeover while an older plan lock still owns the
  tick. Craft-only ETAs multiply every recipe input by every required unit;
  the one-step refill exception applies only to craft outputs with positive
  direct production. Power-recovery locks release as soon as effective power
  is healthy instead of finishing an obsolete generator project.
  One v2.19.0 amendment remains: **an affordable GO stage swap executes from
  the parallel pass** — `executePlan`'s surplus/cap-relief paths skip kind
  `stage`, so a
  fully banked transition could never fire while a research sprint or
  science-storage layer owned the plan (live: Amphitheatre→Broadcast Tower
  at "GO, payback ≈7s" sat frozen for the whole culture-paced Genetics
  sprint it would have accelerated). The swap must clear every reservation
  floor with its net bill; the atomic rebuild contract then outranks the
  plan as usual (Test X6).
- **A staffable resource is never "unreachable".** `capDrainReachabilityFor`
  treats a resource with a direct job path (minerals with every miner
  temporarily pulled elsewhere) as reachable, with one marginal worker's live
  output (`directJobRatePerSecondFor`) as the conservative rate floor —
  otherwise a job override that empties the mines makes every minerals-priced
  candidate read "impossible", which is exactly the deadlock that keeps the
  override alive.
- **Unlock discovery includes resources and crafts — but only for craft-ONLY
  resources.** Generic bootstrap planning reads live hidden-building
  prices/thresholds and makes the first required craft unit (first Manuscript /
  Concrete / Tanker) without adding a resource-name rule. Three gates keep it
  from re-creating the v2.11.5 "revealing Log House instead of buying ready
  work" stall that briefly disabled the whole layer: the price resource must
  have NO direct job path and NO live production (wood accrues through normal
  work — the game reveals wood-priced buildings on its own), the hidden
  building's unlock source must be owned (`hiddenBuildingBootstrapAllowed`),
  and the reveal craft must be quick (`BOOTSTRAP_MAX_ETA_S`). Test U pins both
  directions.
- **Stage changes are full transactions, decided at the UNIT level** (v2.17.0).
  Evaluate adjacent unlocked stages using the 50% refund, bank-limited usable
  refund and price-scaled parity rebuild; execute only through
  `StagingBldBtnController.deltagrade`; then reserve and rebuild to parity
  before any other plan (`pendingStageRebuild`, persisted under
  `kgh.stageRebuild` so a reload can't unguard the refunded bank). Four rules
  keep the trigger honest — all pinned by Test X4: (1) **watts are utility**:
  `stageEnergyUtility` credits `energyProduction` from the live grid
  (demand-gated, tightness-scaled, winter-floored), so Aqueduct→Hydro Plant /
  Pasture→Solar Farm can actually fire when power matters and a generator
  downgrade reads as the utility loss it is — with no consumers, watts are
  worth 0 and the food stage wins; (2) **unit hysteresis, not parity
  remainder**: parity equalizes aggregate utility by construction, so the
  decision is `targetUnitUtility > currentUnitUtility × 1.05` and payback =
  gather delay + rebuild-downtime recouped by the ceil() remainder (linear)
  plus the growth-rate advantage of the reset price curve (quadratic, via
  `stageCopyGatherSeconds`); an exact-ratio upgrade (15 Libraries → 5 Data
  Centers) no longer reads "worse after rebuild" forever; (3) **the net
  rebuild bill is a final price**: any net cost above a live cap is
  storage-blocked (v2.14 invariant) and the analysis reports it instead of
  letting a never-affordable candidate flap the plan lock; (4) **a val-0
  stack switches for free** (no parity, empty net bill, affordable on sight)
  — the post-reset "Hydro Plant stuck where an Aqueduct should be" fix.
  Per-building cooldown plus a longer reverse-direction guard
  (`stageReverseGuard`) prevent refund-burning oscillation.
  Two v2.18.0 amendments (the live 71-Library / 79-Aqueduct save where no
  stage ever upgraded): **the gather ETA is bounded separately from the
  payback horizon** — while the net bill accrues the old stack keeps
  producing, so gather time is delay, not loss; charging it against the 6h
  payback horizon made every mature stack's transition permanently
  non-actionable (a 71-Library parity bill simply takes hours to fund). The
  horizon now bounds only the true loss recovery (`recoup`: rebuild downtime
  + refund burn), and a separate `STAGE_GATHER_HORIZON_SECONDS` (24h) keeps
  the plan from chasing week-long bills. And **every staged building's
  best-transition verdict is diagnostics** (`stagePlanText`): actionable or
  the exact blocking reason (worse per unit / storage cap / gather horizon /
  cooldown), shown as the `Stage:` subsystem line in the panel and report —
  a silently vetoed transition is indistinguishable from a bug otherwise.
  Test X5 pins both.
- **Festivals and expansion are planning layers, not side effects.** Festival live
  prices must respect the active ledger. Housing checkpoints should interrupt
  research only under real population pressure / first-reset milestone pressure;
  the reset itself remains advisory and permanently disabled.
- **Storage-blocked banks never become craft targets.** A tech whose final
  science price can't fit storage is deferred, not crafted toward (no compendiums
  for Electricity until the final cost fits).
- **The unicorn economy is ranked in ONE currency and its sacrifice is bounded.**
  Ziggurat upgrades are first-class candidates (kind `ziggurat`, val-based,
  bought via `ZigguratBtnController` / the religion tab's own buttons).
  `unicornEconomyPlan` prices every open step — Unicorn Pasture, each ziggurat
  upgrade, building another Ziggurat first — in unicorn-equivalents (a tear
  costs `batch ÷ ziggurats` unicorns, both read live) and ranks by payback
  against LIVE unicorn income; an upgrade whose first copy unlocks alicorns is
  exempt from the payback horizon but never from reachability. When one more
  Ziggurat saves ≥`UNICORN_ZIG_FIRST_SAVINGS` of the pick's unicorn bill and is
  itself reachable, the Ziggurat is built BEFORE sacrificing. The sacrifice
  (`manageUnicornReligion`) serves the ACTIVE target when it is tear-priced
  (manual queue wins), otherwise the ranked pick; it converts exactly the tears
  deficit in whole batches, spends no externally-reserved unicorns, and the
  reservation ledger holds the unicorns a pending tears bill needs
  (`unicornPathReservationLedger` + the tears branch in `buildTargetLedger`) so
  surplus pasture buys can't eat the bank. Tears reachability/ETA flows through
  `sacrificeConversionFor` in `capDrainReachabilityFor` / `waitSecondsForSacrifice`
  — never treat tears as a dead-end resource. Test AD pins all of this.
- **Exclusive policies auto-adopt, and the pending pick is culture-chain state**
  (v2.13.0). `autoPolicyChoice` buys non-exclusive policies on sight and
  otherwise adopts the ranked best side of each exclusive group
  (`policyScore` → `availablePolicyChoices` → `bestAdoptableExclusivePolicy`) —
  no manual holdback. Guard rails: a side is never adopted while an OPEN rival
  ranks strictly higher (ties can't deadlock — the comparison is strict); a
  researched side de-facto blocks its rivals even when the game's `blocked`
  flag lags (`policyBlockedByRival`); a policy queued in the manual queue is
  player intent — the auto-pick never adopts a side that would foreclose it
  (`queuedPolicyNames` filter); and the trade-friendly Zebra side outranks
  Bellicosity so the generic pick can't settle that group against the
  diplomacy layer's titanium lever (`maybeAdoptZebraTradePolicy` stays as the
  fast path). While the ranked pick is still UNAFFORDABLE its full price is
  culture-chain state: `pendingPolicyReservationLedger` holds the bill in
  `buildReservationLedger`, `executePlan`'s cap-relief/surplus gate and the
  side-festival check (`festivalCanPay`), so festivals, embassies and surplus
  buys can't eat the bank the policy is accruing — amounts only, never a hard
  chain lock, and the plan target itself is never gated by it. A price above
  the live storage cap reserves nothing (storage growth is someone else's
  layer), and the hold releases the moment the pick is affordable or its group
  settles. The policy buy itself must clear the FULL reservation ledger
  (`reservedNeedsFor`), never just the target's prices. Test AF pins the whole
  contract; Stage 1 / Stage 14 pin tick-level adoption.
- **No-op policies are excluded from planning** (`isNoopPolicyCandidate`, e.g.
  Socialism) — they are never gathered as candidates, auto-bought, or advised.
- **Panel data is contract-tested, not cosmetic** (v2.14.0). The queue picker
  presents a FIXED browsable order — kind group, then name
  (`queuePickerEntries` / `QUEUE_KIND_ORDER`), signature-gated so an open
  dropdown never rebuilds under the cursor; the Top-targets card renders
  `rankingRows` (live scores, per-tick trend arrows, readiness/ETA, the active
  plan always included — even synthetic layer targets like festivals); and the
  reset advisor exposes an explicit verdict (`resetAdvisorState`:
  wait/target/ok/go with headline + "reset now banks +P/+karma" detail) in an
  always-visible card instead of a stat line inside the collapsed details.
  Test AH pins all three through `__kghDebug`.
- **Manual game speed is additive and reversible** (v2.20.0). The panel's ⏩
  selector arms `setInterval(game.tick)` with (multiplier − 1) × 5 extra
  ticks/s on top of the native scheduler — 1× arms nothing, nothing inside
  the game is mutated (never override `game.rate`), and the choice persists
  under `kgh.tickSpeed`. Planning stays speed-agnostic because every rate the
  helper uses is read live. Relatedly, the reset advisor reads metaphysics
  perks from `gamePage.prestige` — never `science.get`, whose tech/perk name
  collision marked the unowned Engineering perk as researched AND
  console.error'd "Failed to get tech" on every tick. Tests AL/AM pin both.
- **Any non-target spender must evaluate expanded spend impact against the active target ledger.** Direct price checks are insufficient: surplus buys, cap relief, policies, diplomacy, trade, overflow crafting and other spenders must compare their direct costs plus crafted/raw chain impact against `buildTargetLedger()`/`violatesTargetLock()` so a ship/scaffold/plate/slab-style buy cannot consume the material chain being saved for the active focus.
