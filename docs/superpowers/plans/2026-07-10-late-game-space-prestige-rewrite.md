# Late-Game Space and Prestige Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the helper autonomously complete Space and post-Space progression, including trade-backed rare resources and explicitly armed prestige actions, without sacrificing safety or reservation coherence.

**Architecture:** Replace isolated resource heuristics with one acquisition-route graph shared by reachability, ETA, jobs, reservations, diagnostics, and diplomacy. Normalize Space, Time, and transcendence metadata behind controller-aware adapters, add a late-game frontier above repeat economy growth, and place every mutation behind a semantic action broker. Irreversible prestige actions require a persistent arm flag, native checkpoint, fresh precondition check, capital floors, one-action cooldown, and measured postcondition.

**Tech Stack:** Native JavaScript userscript, Kittens Game public manager/controller APIs, Node.js VM smoke harness, npm validation and simulation scripts.

## Global Constraints

- Work on a `codex/` development branch; do not implement on `main`.
- Follow red-green-refactor for every behavior change: add one focused assertion, run it and observe the intended failure, implement the minimum behavior, then rerun the focused suite.
- Use native public managers/controllers for all mutations; no raw resource/count mutation and no generic `space.build()` fallback.
- World reset, challenge reset, time skip, time-crystal shatter, and unknown actions remain forbidden.
- Transcend, Adore, and alicorn sacrifice require the persistent `kgh.prestigeArmed` flag, which defaults to `false` and is changed only by a deliberate panel control or debug API used by tests.
- Remove the global `gamePage.opts.noConfirm = true` mutation.
- At most one diplomacy mutation and one irreversible prestige mutation may execute per planner tick.
- Every trade and rare-capital action must respect the complete reservation ledger and output storage headroom.
- In the supplied 39.85-alicorn/1-time-crystal state, no alicorn sacrifice may execute or be recommended while Alicorn Stable still requires 20 alicorns.
- Preserve early-game safety, genuine power recovery, first-reset population milestones, active research contracts, and bounded unicorn-to-tears behavior.
- Update `@version`, `HELPER_VERSION`, and `package.json` together from `2.20.6` to `2.21.0` only in the release task.

---

### Task 1: Install the semantic action broker and persistent prestige arm

**Files:**
- Modify: `scripts/smoke.mjs` near the existing reset safety fixture and panel helpers
- Modify: `src/kittens-game-helper.user.js` near storage constants, `applyProfile`, purchase execution, panel markup, and `window.__kghDebug`

**Interfaces:**
- Produces: `ACTION_POLICY = { SAFE_REPEATABLE, RARE_CAPITAL, AUTHORIZED_PRESTIGE, FORBIDDEN }`
- Produces: `actionPolicyFor(actionId) -> string`
- Produces: `executeSemanticAction({ id, policy, invoke, snapshot, verify }) -> { ok, reason, before, after }`
- Produces: `prestigeAutomationArmed() -> boolean`
- Produces: `setPrestigeAutomationArmed(value) -> boolean`
- Consumes later: every purchase and prestige mutation calls `executeSemanticAction`

- [ ] **Step 1: Write failing broker and authorization tests.** Add smoke assertions that `applyProfile()` leaves `gamePage.opts.noConfirm` unchanged; direct broker attempts for `resetWorld`, `shatter`, `timeSkip`, and an unknown ID call zero invokers; `transcend` calls zero invokers while disarmed; and arming/disarming round-trips through storage. Add a panel assertion that the arm control reads `Prestige automation: OFF` by default and `ARMED` after one click.

```js
let forbiddenCalls = 0;
dbg.setPrestigeAutomationArmed(false);
const denied = dbg.executeSemanticAction({ id: "resetWorld", invoke: () => { forbiddenCalls += 1; } });
check("late game A: forbidden execution is fail-closed", !denied.ok && forbiddenCalls === 0);
const disarmed = dbg.executeSemanticAction({ id: "transcend", invoke: () => { forbiddenCalls += 1; } });
check("late game A: prestige requires explicit arm", !disarmed.ok && forbiddenCalls === 0);
```

- [ ] **Step 2: Run `npm.cmd run smoke` and confirm the new assertions fail** because the broker/debug APIs and panel control do not exist and `applyProfile` forces `noConfirm=true`.

- [ ] **Step 3: Implement the minimum fail-closed broker.** Store authorization under `kgh.prestigeArmed`; map exact prestige/forbidden IDs plus the structured safe families `candidate:{build,research,upgrade,religion,ziggurat,transcendence,space,time,policy,stage}:<nativeName>`, `craft:<nativeName>`, `trade:<raceName>`, `praise`, and `sacrificeUnicorns`; reject every other ID and every mismatched caller-supplied policy; catch invocation errors; verify optional postconditions; and enforce `lastIrreversibleActionAt` for `RARE_CAPITAL` and `AUTHORIZED_PRESTIGE`.

```js
const PRESTIGE_ARM_KEY = "kgh.prestigeArmed";
const ACTION_POLICY = Object.freeze({
  SAFE_REPEATABLE: "safe-repeatable",
  RARE_CAPITAL: "rare-capital",
  AUTHORIZED_PRESTIGE: "authorized-prestige",
  FORBIDDEN: "forbidden",
});
const ACTION_IDS = new Map([
  ["transcend", ACTION_POLICY.AUTHORIZED_PRESTIGE],
  ["adore", ACTION_POLICY.AUTHORIZED_PRESTIGE],
  ["sacrificeAlicorns", ACTION_POLICY.RARE_CAPITAL],
  ["resetWorld", ACTION_POLICY.FORBIDDEN],
  ["shatter", ACTION_POLICY.FORBIDDEN],
  ["timeSkip", ACTION_POLICY.FORBIDDEN],
]);
```

- [ ] **Step 4: Route `buyCandidate` through the broker and remove global confirmation mutation.** Candidate purchases use `candidate:${kind}:${meta.name}` and are accepted only when `kind` belongs to the safe-family set above; denied substrings remain discovery defense, while the broker is authoritative at execution. A failed invocation or postcondition invalidates the cached plan and benches that action through the existing purchase-failure mechanism. `applyProfile` may kick a tick but must not change `opts.noConfirm`.

- [ ] **Step 5: Add the persistent panel control and debug methods.** The button must show current state, persist one deliberate click, invalidate the planner cache, and never arm itself during install/migration.

- [ ] **Step 6: Rerun `npm.cmd run smoke`; confirm all Task 1 assertions pass; run `git diff --check`; commit with `feat: add fail-closed action broker`.**

### Task 2: Build live trade math and the unified acquisition graph

**Files:**
- Modify: `scripts/smoke.mjs` around Test AE and trade fixtures
- Modify: `src/kittens-game-helper.user.js` near reachability, candidate ETA, and trade-path helpers

**Interfaces:**
- Consumes: `resourceMap`, `craftByName`, `sacrificeConversionFor`, `unlockedRaces`, `tradePricesForRace`
- Produces: `validRaceSell(race, sell) -> boolean`
- Produces: `expectedTradeYield(race, sell) -> number`
- Produces: `acquisitionPathFor(resources, name, amount, context?, seen?) -> { reachable, eta, kind, resource, amount, inputs, race, expectedYield, blockers, nextStep }`
- Replaces: titanium-only reachability branch and uranium-to-miner shortcut

- [ ] **Step 1: Replace mock percentage chances with live-style fractions and add failing numeric assertions.** Use Dragon uranium `chance: 0.95`, summer delta `0.35`, and embassy-gated thorium. Assert uranium is eligible before the resource is unlocked, expected seasonal yield uses `1.35`, and thorium remains invalid below embassy level 5.

```js
const dragonSell = { name: "uranium", value: 1, chance: 0.95, width: 0, seasons: { summer: 0.35 } };
check("late game B: live fractional trade chance", Math.abs(dbg.expectedTradeYield(dragons, dragonSell) - 1.2825) < 1e-6);
```

- [ ] **Step 2: Split Test AE into two failing cases.** With zero uranium and no valid seller, the first uranium-consuming producer remains blocked. With Dragons unlocked, the same target is reachable with `kind === "trade"`, finite ETA, and `nextStep.race.name === "dragons"`. Add a Leviathan/time-crystal case with the same reachability contract.

- [ ] **Step 3: Run `npm.cmd run smoke` and confirm numeric-yield and trade-reachability assertions fail for the current `/100` math and missing trade route.**

- [ ] **Step 4: Implement native-first trade math.** Use `diplomacy.isValidTrade`, `getResourceTradeChance`, and other public helpers when available. The fallback validates `minLevel`, treats chance as a fraction, multiplies by `1 + seasonDelta`, and incorporates standing/trade-ratio/energy effects available in the fixture without inventing a flat embassy multiplier.

- [ ] **Step 5: Implement recursive acquisition routes.** Evaluate bank/passive, direct job production, craft, bounded conversion, valid trade, and producer/storage bridge nodes. Detect cycles with keys of `resource:amountBucket`; return explicit blockers instead of `Infinity` without a reason. For trade nodes recursively acquire each trade price and use the slowest input ETA.

```js
const acquisitionPathFor = (resources, name, amount, context = {}, seen = new Set()) => ({
  reachable: false,
  eta: Number.POSITIVE_INFINITY,
  kind: "blocked",
  resource: name,
  amount,
  inputs: [],
  blockers: [`no acquisition path for ${resTitle(resources, name)}`],
  nextStep: null,
});
```

The shown object is the required blocked return shape; replace its fields with the selected reachable route when a route exists.

- [ ] **Step 6: Make reachability, `solveCraftChain`, `waitSecondsForCandidate`, and hard-input scoring consume the route.** Remove the special Zebra titanium wait from those callers; Zebra becomes an ordinary trade route. Preserve unicorn-to-tears as a bounded conversion node.

- [ ] **Step 7: Expose focused debug methods, rerun smoke, run `git diff --check`, and commit with `feat: unify late-game resource acquisition`.**

### Task 3: Consolidate diplomacy execution and reservation-aware route funding

**Files:**
- Modify: `scripts/smoke.mjs` trade integration fixtures
- Modify: `src/kittens-game-helper.user.js` in `manageTrade`, `manageDiplomacy`, reservation ledgers, diplomacy pressure, and tick ordering

**Interfaces:**
- Consumes: `acquisitionPathFor`, `buildReservationLedger`, `executeSemanticAction`
- Produces: `activeAcquisitionRoute(target, resources) -> route | null`
- Produces: `boundedTradeBatch(route, ledger, resources) -> number`
- Produces: one `manageDiplomacy(resources, goalKey)` mutation owner
- Removes: tick call to the legacy `manageTrade`

- [ ] **Step 1: Add a failing single-mutation regression.** Arrange a state where both legacy Zebra trading and targeted trading are eligible, tick once, and assert exactly one diplomacy trade API call. Reproduce the supplied log pattern in which two calls previously appeared seconds apart.

- [ ] **Step 2: Add failing reservation and nested-route regressions.** Assert Dragon trades never cross active/manual/unicorn/survival titanium, catpower, gold, or unobtainium floors; output batches stop at uranium/time-crystal headroom; and insufficient Dragon titanium selects a Zebra titanium sub-step before a Dragon uranium step.

- [ ] **Step 3: Run `npm.cmd run smoke` and confirm the one-call, complete-ledger, and nested-route assertions fail.**

- [ ] **Step 4: Implement `activeAcquisitionRoute` and `boundedTradeBatch`.** Compute the route from the target's direct deficits, use the complete merged ledger, cap by exact expected deficit and output headroom, and re-read prices/resources immediately before execution.

- [ ] **Step 5: Merge all trade behavior into `manageDiplomacy`.** Enforce this order: required race reveal/preparation, active route trade, safe overflow trade, then relevant embassy. Use one shared cooldown and return immediately after any mutation. Delete the tick invocation of `manageTrade` and remove unreachable duplicate executor code after tests pass.

- [ ] **Step 6: Feed acquisition inputs into jobs and diagnostics.** Dragon uranium pressures titanium/catpower/gold; a nested Zebra route additionally pressures slab and ship/catpower inputs; it never creates a synthetic miner need for uranium.

- [ ] **Step 7: Rerun smoke and the supplied diagnostic-shaped fixture, run `git diff --check`, and commit with `fix: make diplomacy follow acquisition routes`.**

### Task 4: Normalize Space metadata and add the late-game progression frontier

**Files:**
- Modify: `scripts/smoke.mjs` Test AC and new late-game frontier/effect cases
- Modify: `scripts/simulate.mjs` Space fixture shapes
- Modify: `src/kittens-game-helper.user.js` Space enumeration, pricing, controller routing, effect parsing, scoring, strategic layers, and Space diagnostics

**Interfaces:**
- Produces: `spaceDescriptors() -> Array<{ subtype, meta, planet, gateState, completionState }>`
- Produces: `spaceDescriptorFor(meta) -> descriptor | null`
- Produces: `spaceGateState(descriptor) -> { open, reason, predecessor, transitEta, requiredTech, requiredUpgrade }`
- Produces: `spaceMarginalProfile(descriptor, resources) -> effect profile`
- Produces: `bestLateGameFrontier(candidates, resources, goalKey) -> { candidate, route, reason } | null`
- Produces: `STRATEGIC_LAYERS.lateGameFrontier = "Late-game progression frontier"`

- [ ] **Step 1: Correct fixtures before adding behavior.** Put `sattelite`, `spaceElevator`, and all other structures under `space.planets[].buildings`; leave only missions in `space.programs`; remove generic `gamePage.space.build()` from controller tests; provide controller-only `buyItem` effects.

- [ ] **Step 2: Add failing purchase/gate tests.** Verify a controller-only mission unlocks its planet/downstream mission, a controller-only `sattelite` planet building increments, and gate text distinguishes predecessor mission, planet transit, required technology, and `upgrades.spaceBuilding` dependency.

- [ ] **Step 3: Add failing ranking regression for the supplied state.** With open Piscine/Helios missions, zero Planet Crackers/Lunar Outposts/Moon Bases, capped uranium/unobtainium, and a buildable repeat Accelerator, assert the selected layer is `Late-game progression frontier` and its target is the first reachable mission/producer/storage bridge rather than Accelerator.

- [ ] **Step 4: Add table-driven failing marginal-effect tests** for Space Elevator, Sunlifter, Containment Chamber/Heatsink, Sunforge, Navigation Relay, Terraforming Station/Hydroponics, HR Harvester/Entangler, Tectonic/Molten Core, and ordinary resource/storage effects.

- [ ] **Step 5: Run focused smoke and simulate commands; confirm controller, ranking, gate, and marginal-effect assertions fail.**

- [ ] **Step 6: Implement descriptor-based enumeration and controller routing.** Preserve planet ownership; derive completion without treating an in-transit one-time mission as repeatable; query live controller prices; use exact mission and planet-building controllers; bench an action when its native controller is unavailable.

- [ ] **Step 7: Apply gateway/unlock value to every candidate kind and implement `bestLateGameFrontier`.** Rank first-copy unlocks, missing-resource producers, live cap bridges, then infrastructure required by the selected acquisition route. Insert the layer below power/food/fuel safety and active research contracts, but above workshop roadmap, repeat expansion, and generic economy growth.

- [ ] **Step 8: Implement marginal effect adapters and actionable Space diagnostics.** Static adapters cover named effect families from the design; copied-state read-only projection handles synergy calculations. The report includes the owning planet and exact gate reason.

- [ ] **Step 9: Rerun smoke and simulate, run `git diff --check`, and commit with `feat: add dependency-aware Space frontier`.**

### Task 5: Add Time/transcendence adapters and authorized prestige execution

**Files:**
- Modify: `scripts/smoke.mjs` religion/time fixtures and irreversible-action cases
- Modify: `src/kittens-game-helper.user.js` religion enumeration, Time descriptors/controllers, capital ledger, prestige planner, panel status, diagnostics, and unlock watcher

**Interfaces:**
- Produces: `transcendenceUpgrades() -> Array<meta>` and candidate kind `transcendence`
- Produces: `timeDescriptorFor(meta) -> { subtype: "chronoforge" | "voidspace", meta }`
- Produces: `rareCapitalFloor(resources, target) -> Record<string, number>`
- Produces: `prestigeProjection(resources) -> { transcend, adore, alicorn, status }`
- Produces: `managePrestige(resources, target) -> boolean`
- Consumes: `executeSemanticAction`, `acquisitionPathFor`, complete reservation ledger

- [ ] **Step 1: Add failing adapter tests.** A transcendence upgrade must be discovered and bought through `TranscendenceBtnController`; a Chronoforge item must use `ChronoforgeBtnController`; a Void Space item must use `VoidSpaceBtnController` and its live price. The raw `transcend` action must never become a candidate.

- [ ] **Step 2: Add failing prestige-policy tests.** While disarmed, projections may appear but no irreversible API runs. While armed, Transcend requires a successful native checkpoint, exact next-tier affordability, one-tier postcondition, and retained upgrade floor. Adore requires positive projected epiphany gain and bounded Solar Revolution recovery. When both qualify, one tick runs Transcend only.

- [ ] **Step 3: Add failing alicorn tests.** The supplied 39.85 alicorn/1 time-crystal/Alicorn Stable 20 state must return a protected-floor blocker and zero calls. A positive fixture with an exact two-crystal deficit, no faster Leviathan route, sufficient post-floor alicorns, and a successful checkpoint executes one 25-alicorn batch, verifies the measured time-crystal gain, then cools down.

- [ ] **Step 4: Run `npm.cmd run smoke` and confirm adapter/controller/policy assertions fail.**

- [ ] **Step 5: Implement candidate adapters and live prices.** Add transcendence upgrades to gathering, scoring, purchase routing, queue lookup, unlock watching, and diagnostics. Distinguish Chronoforge/Void Space by manager membership and use the correct controller for both pricing and purchase.

- [ ] **Step 6: Implement the rare-capital ledger.** Reserve direct costs for reachable alicorn/time-crystal/relic/void/karma/paragon purchases, active/manual targets, and the next required progression gate. Merge these floors into purchase, trade, transformation, and surplus ledgers.

- [ ] **Step 7: Implement prestige projections using native manager values.** Read worship, epiphany, tier, `_getTranscendNextPrice()`, and native Adore projection/calculation APIs. If a native calculation is absent, report the action unavailable rather than inventing a destructive formula.

- [ ] **Step 8: Implement `managePrestige` through the broker.** Call a native save/checkpoint first; re-read state; run at most one of Transcend, Adore, or alicorn sacrifice; verify exact postcondition; log before/after values; set cooldown; invalidate caches. Never call internal reset helpers.

- [ ] **Step 9: Rerun smoke, run `git diff --check`, and commit with `feat: automate armed late-game prestige`.**

### Task 6: Make processors fuel-aware and complete late-game observability

**Files:**
- Modify: `scripts/smoke.mjs` processor, expansion, diagnostics, and unlock-watch fixtures
- Modify: `src/kittens-game-helper.user.js` converter control, expansion checkpoint, diagnostics, unlock watcher, and tick order

**Interfaces:**
- Produces: `sustainableProcessorCount(meta, resources, ledger, horizonSeconds) -> number`
- Produces: bounded post-reset expansion checkpoint state
- Consumes: active acquisition route, rare-capital floor, Space/Time/transcendence descriptors

- [ ] **Step 1: Add failing fuel-budget tests.** Reserve uranium for a first producer/upgrade, assert Reactors cannot consume it, then add steady uranium income and assert only the count sustainable over the processor horizon resumes. Add the equivalent Lunar Outpost uranium-consumption case.

- [ ] **Step 2: Add a failing post-reset research non-starvation case.** With a full 169-kitten village and Chronophysics actionable, allow at most one housing checkpoint before the research/late-game frontier starts; preserve the existing first-reset milestone fixture.

- [ ] **Step 3: Add failing diagnostics/unlock assertions.** Reports must contain acquisition route, diplomacy yield/bounds, Space gate reason, Transcendence, Chronoforge, Void Space, prestige projections, rare floors, and processor fuel budget. Newly unlocked Space/Time/transcendence metadata must invalidate a stale plan.

- [ ] **Step 4: Run `npm.cmd run smoke` and confirm the fuel, starvation, report, and unlock assertions fail.**

- [ ] **Step 5: Implement sustainable processor counts.** Project per-unit consumption over a fixed 60-second horizon, subtract the merged ledger/floors, include positive net income, and choose the largest integer count that does not violate the budget. Apply it to Reactors and other fuel consumers while preserving power constraints.

- [ ] **Step 6: Bound repeat expansion.** Persist a single post-reset population checkpoint, then yield to an actionable gateway research or late-game frontier until that target completes or becomes invalid. Do not weaken first-reset population requirements or food safety.

- [ ] **Step 7: Complete diagnostics and unlock watching.** Print route nodes with ETA and blockers, trade expected yield and batch cap, descriptor gate reasons, prestige/action-broker state, and sustainable processor counts. Watch every candidate family added by Tasks 4 and 5.

- [ ] **Step 8: Rerun smoke, run `git diff --check`, and commit with `fix: coordinate late-game fuel and diagnostics`.**

### Task 7: Add end-to-end simulations, release documentation, and final verification

**Files:**
- Modify: `scripts/simulate.mjs`
- Modify: `scripts/validate.mjs`
- Modify: `scripts/smoke.mjs` only for final integration gaps revealed by simulation
- Modify: `src/kittens-game-helper.user.js` version metadata and final integration fixes
- Modify: `README.md`
- Modify: `package.json`

**Interfaces:**
- Consumes all earlier task interfaces
- Produces release `2.21.0`

- [ ] **Step 1: Add failing end-to-end simulation phases** for Dragon uranium bootstrap, uranium-to-unobtainium Space progression, antimatter/containment, active Leviathans and departure, transcendence upgrades, armed prestige, and Void Space. Each phase must assert both the purchased/progressed state and the visible plan/action explanation.

- [ ] **Step 2: Run `npm.cmd run simulate` and confirm every new phase fails for its intended missing integration, not fixture errors.**

- [ ] **Step 3: Apply only integration fixes required by the simulations.** Do not weaken focused assertions or add raw-state fallbacks. Rerun each phase after its fix.

- [ ] **Step 4: Update validation invariants.** Require the action broker, persistent arm key, acquisition graph, one diplomacy owner, normalized descriptor adapters, correct Time controllers, and version parity. Remove assertions that require global `noConfirm` or encode alicorn sacrifice as universally denied.

- [ ] **Step 5: Update README.** Document Space dependency planning, Dragon/Leviathan routes, one-time prestige arming, exact irreversible safeguards, rare-capital floors, diagnostics, and the still-forbidden reset/shatter/time-skip actions.

- [ ] **Step 6: Bump `@version`, `HELPER_VERSION`, and `package.json` to `2.21.0`.**

- [ ] **Step 7: Run fresh full verification.** Execute `npm.cmd test`, require exit code 0 and zero failed checks; run `git diff --check`; inspect `git status --short`; and compare the final diff against the design spec requirement by requirement.

- [ ] **Step 8: Commit with `release: complete late-game autonomy rewrite`.** Request a broad whole-branch code review. Fix every Critical/Important finding with focused tests and re-review until approved.

- [ ] **Step 9: Rerun `npm.cmd test` after review fixes, merge the development branch to `main`, rerun `npm.cmd test` on `main`, and push `origin main`.**
