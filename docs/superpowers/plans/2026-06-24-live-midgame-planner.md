# Live Midgame Planner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the userscript plan from active-stage/live resource metadata, complete shared-bank research chains, bootstrap newly unlocked crafts, balance research with housing/festivals, and automate only economically justified staged-building transitions.

**Architecture:** Keep raw game metadata as stable controller identity, but route all reads through live views and explicit candidate analyses. Structural decisions (research phases, cap closure, expansion, festival maintenance, resource bootstrap, and stage transitions) produce normal reservation-backed targets; no side spender bypasses the active ledger. Kittens Game's own controllers remain the only mutation path.

**Tech Stack:** Single-file ES2020 Tampermonkey userscript, Kittens Game `window.gamePage` APIs, Node smoke/simulation harnesses, npm validation scripts.

---

### Task 1: Live metadata and trustworthy production telemetry

**Files:**
- Modify: `src/kittens-game-helper.user.js` near `buildingMetas`, telemetry, `labelOf`, `metaEffectProfile`, and debug exports
- Test: `scripts/smoke.mjs` after the current metadata/science regressions

- [x] **Step 1: Write failing active-stage and ticker tests**

Add staged fake buildings whose raw object is `library`/`amphitheatre` but whose active stages are Data Center/Broadcast Tower. Assert `dbg.liveMetaView(raw).label`, `dbg.labelOf(raw)`, `dbg.metaEffectProfile(raw)`, and current prices read only the active stage. Add a positive `getResourcePerTick("science")` with a flat capped bar and assert `dbg.productionFor("science")` stays positive rather than becoming zero.

- [x] **Step 2: Run the focused smoke suite and verify RED**

Run: `npm.cmd run smoke`

Expected: FAIL for missing `liveMetaView` export/current-stage labels and capped telemetry overriding the API rate.

- [x] **Step 3: Implement live views and telemetry eligibility**

Add:

```js
const rawBuildingFor = (meta) => buildingMetas().find((b) => b === meta || (b && meta && b.name === meta.name)) || null;
const liveMetaView = (meta, stageOverride = null) => {
  const raw = rawBuildingFor(meta);
  if (!raw || !Array.isArray(raw.stages)) return meta;
  refreshMetaEffects(raw);
  const stage = stageOverride == null ? Math.max(0, Number(raw.stage) || 0) : stageOverride;
  return { ...raw, ...(raw.stages[stage] || {}), stage };
};
```

Use `liveMetaView` in `labelOf`, effect parsing, processing reads, and staged price/description diagnostics. Parse one active `effects` object rather than base plus stage.

Change observed telemetry to return metadata (`rate`, `clipped`, `eligible`) and accept it only below cap, after the minimum span, with no action discontinuity, same direction as the API rate, and tight tolerance. Add `markTelemetryDiscontinuity(deltas)` to reset samples changed by `withActionResourceDeltas` and successful buys.

- [x] **Step 4: Re-run smoke and verify GREEN**

Run: `npm.cmd run smoke`

Expected: new active-stage/ticker checks PASS and existing checks remain green.

- [x] **Step 5: Commit**

```powershell
git add src/kittens-game-helper.user.js scripts/smoke.mjs
git commit -m "fix: read live stages and ticker rates"
```

### Task 2: Phase-aware research contracts and generic craft bootstrap

**Files:**
- Modify: `src/kittens-game-helper.user.js` near craft solving, reservation ledger, unlock watcher, selector, and panel details
- Test: `scripts/smoke.mjs`

- [x] **Step 1: Write failing Robotics phase tests**

Create a fake Robotics target costing 140K science and 80 Blueprints with a 145K cap. Give Blueprint/Compendium their live science-consuming recipes. Assert the decision exposes `intermediate` phase, target-owned crafting may spend science below 140K only toward missing Blueprint/Compendium units, unrelated overflow/festival/purchases cannot spend it, and phase changes to `final-bank` after 80 Blueprints.

- [x] **Step 2: Write failing live bootstrap tests**

Add a newly unlocked craft with a live label and a hidden `unlockable` building whose price and `unlockRatio` require one output. Assert the watcher sees the craft/resource, the selector returns `Resource bootstrap`, exactly the threshold amount is crafted, the live label is shown, and an active target reservation prevents the probe.

- [x] **Step 3: Run smoke and verify RED**

Run: `npm.cmd run smoke`

Expected: FAIL because research has no phase model and resource/craft unlocks are not watched or planned.

- [x] **Step 4: Implement target phases**

Add `researchTargetPhase(target, resources)` returning:

```js
{ phase: "intermediate" | "final-bank" | "purchase", craftCosts, finalCosts, sharedInputs, explanation }
```

In `overflowInputFloor`, allow a direct final bank to be spent only when `forPlanChain` is true and `outputName` is a still-missing craftable direct cost of the same target. Clamp units through the existing solver. Keep the bank in the external target ledger throughout intermediate phase; only the target-owned craft path receives the allowance.

Show phase and intentional transfer in plan/debug/current-action text.

- [x] **Step 5: Implement resource/craft discovery and bootstrap targets**

Extend `watchNewUnlocks` with live resources (`unlocked !== false`) and unlocked workshop crafts. Clear resource-name/effect/candidate caches on changes. Add `bootstrapResourceCandidate(resources)` that scans hidden `unlockable` building live prices and `unlockRatio`, finds craftable deficits, and returns the smallest justified threshold as a pseudo candidate:

```js
{ kind: "bootstrap", meta: { name, label, prices, outputName, targetAmount, downstreamLabel } }
```

Support `bootstrap` in `pricesFor`, `targetId`, completion, selector, craft executor, and display. It is below manual queue/research continuation but above generic economy when it reveals reachable content.

- [x] **Step 6: Re-run smoke and verify GREEN**

Run: `npm.cmd run smoke`

Expected: Robotics phases and generic bootstrap checks PASS.

- [x] **Step 7: Commit**

```powershell
git add src/kittens-game-helper.user.js scripts/smoke.mjs
git commit -m "fix: phase research chains and bootstrap crafts"
```

### Task 3: Direct science-cap closure planning and diagnostics

**Files:**
- Modify: `src/kittens-game-helper.user.js` near science storage selection and automation details
- Test: `scripts/smoke.mjs`

- [ ] **Step 1: Write failing cap-projection tests**

Model a 105K cap, a 145K valuable research, Temple with zero or weak live `scienceMax`, Data Center/Observatory/Academy alternatives, and dynamic price ratios. Assert name text cannot qualify, `scienceRatio` adds zero storage, options project enough repeated copies to close 40K, the fastest full closure wins, sticky state resets on blocker/stage change, and diagnostics include every option's gain/copies/closure/ETA/rejection.

- [ ] **Step 2: Run smoke and verify RED**

Run: `npm.cmd run smoke`

Expected: FAIL because current gain includes `scienceRatio`, text fallback qualifies candidates, and ranking sees one copy only.

- [ ] **Step 3: Implement capacity evidence and projection**

Replace `scienceStorageUnlockCandidate` fallback matching with `scienceStorageGain(candidate) > 0`. Count live `scienceMax`; handle `scienceMaxCompendia` only up to current Compendium-derived usable headroom. Add cumulative projected prices and `projectScienceClosure(candidate, need, resources)` with bounded copies, reachability, total ETA, closure ratio, and conflict penalty.

Scope sticky key to `${blockedTech}:${targetId}:${activeStage}` and allow a full-closure option to replace a weak sticky choice whenever projected closure/payback is materially better.

- [ ] **Step 4: Re-run smoke and verify GREEN**

Run: `npm.cmd run smoke`

Expected: cap projection checks and all existing D2-D4 checks PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/kittens-game-helper.user.js scripts/smoke.mjs
git commit -m "fix: project direct science cap closure"
```

### Task 4: Expansion checkpoints and visible festival maintenance

**Files:**
- Modify: `src/kittens-game-helper.user.js` near strategic layers, housing score, festival execution, panel creation/rendering
- Test: `scripts/smoke.mjs`

- [ ] **Step 1: Write failing expansion/festival tests**

Assert a near-full village below the first-reset milestone selects the best effect-derived `maxKittens` candidate before starting another lower-payoff research sprint, while research wins with housing headroom. Assert an expired high-payback festival becomes `Festival maintenance`, uses the live controller, appears as active/saving/deferred in the panel, spends true surplus, and cannot cross a target reservation.

- [ ] **Step 2: Run smoke and verify RED**

Run: `npm.cmd run smoke`

Expected: FAIL because research sprint structurally wins and festival is an invisible late side action.

- [ ] **Step 3: Implement expansion pressure**

Add `expansionPressure()` from kitten count/cap, free beds, reset count, first-reset distance, and arrival rate. Scale housing by actual slots. Add `bestExpansionCheckpoint` before starting a new sprint; keep a valid active sprint unless expansion is materially superior.

- [ ] **Step 4: Implement festival candidate/status**

Build festival price from the rendered live model when available, otherwise the canonical live game cost. Estimate happiness-wide production gain, arrival benefit when free beds exist, duration, ETA, and payback. Add `festival` support to selection and execution. Call the live controller once; only use `holdFestival` plus exact payment as fallback. Check `targetLockViolationForPrices` and `pricesRespectReservations` against the full price.

Add a persistent panel element and `festivalPlanText` with active duration, saving deficits, or deferral reason.

- [ ] **Step 5: Re-run smoke and verify GREEN**

Run: `npm.cmd run smoke`

Expected: expansion and festival checks PASS with old festival/reservation tests green.

- [ ] **Step 6: Commit**

```powershell
git add src/kittens-game-helper.user.js scripts/smoke.mjs
git commit -m "feat: balance expansion and festival upkeep"
```

### Task 5: Opportunity-costed stage transitions

**Files:**
- Modify: `src/kittens-game-helper.user.js` near candidate gathering/scoring, reservations, controller execution, and debug details
- Test: `scripts/smoke.mjs`

- [ ] **Step 1: Write failing transition-analysis tests**

Create two-stage buildings with owned copies, live price ratios, 50% refunds, changed storage/production/energy effects, and unlocked adjacent stages. Assert analysis reports refund, rebuild-to-parity count/cost, temporary lost utility, payback, post-cap safety, and rejection reason. Assert an uneconomic change is rejected, an economic upgrade/downgrade becomes the active plan, its rebuild inputs are reserved, and cooldown prevents oscillation.

- [ ] **Step 2: Run smoke and verify RED**

Run: `npm.cmd run smoke`

Expected: FAIL because `stage` candidates and transition accounting do not exist.

- [ ] **Step 3: Implement transition analysis**

Add pure helpers for active/adjacent stage views, scaled stage prices, cumulative current-stage 50% refundable proceeds, target rebuild costs, per-unit economic utility, parity count, cap safety, and payback. Use live price-ratio/cost-reduction effects where available and expose conservative estimates when an effect cannot be simulated safely.

Generate adjacent unlocked `stage` candidates only when rebuild is reachable, net resources plus guaranteed refund cover safety buffers, target utility is materially better for current pressure, and payback fits the planning horizon.

- [ ] **Step 4: Implement transition execution and rebuild continuation**

Support `stage` in IDs, prices, completion, reservations, display, and `buyCandidate`. Invoke `StagingBldBtnController.deltagrade(model, delta)` only. Store `pendingStageRebuild` with target building/stage/count; on following ticks return the live build candidate until parity is restored. Clear it on completion/invalidation and enforce cooldown/hysteresis.

- [ ] **Step 5: Re-run smoke and verify GREEN**

Run: `npm.cmd run smoke`

Expected: transition accounting, controller, reservation, continuation, and stability checks PASS.

- [ ] **Step 6: Commit**

```powershell
git add src/kittens-game-helper.user.js scripts/smoke.mjs
git commit -m "feat: plan safe building stage transitions"
```

### Task 6: Version, documentation, full verification, and integration

**Files:**
- Modify: `src/kittens-game-helper.user.js` version header and `HELPER_VERSION`
- Modify: `package.json` version
- Modify: `README.md`, `CLAUDE.md`
- Test: `scripts/validate.mjs`, `scripts/smoke.mjs`, `scripts/simulate.mjs`

- [ ] **Step 1: Update user documentation and version**

Bump all version strings from `2.4.6` to `2.5.0`. Document live staged labels, direct cap projection, research phases, resource bootstrap, expansion checkpoints, festival status, stage opportunity costs, and unchanged irreversible-action safety.

- [ ] **Step 2: Run static/version validation**

Run: `npm.cmd run validate`

Expected: PASS with version 2.5.0 consistent.

- [ ] **Step 3: Run behavioral smoke tests**

Run: `npm.cmd run smoke`

Expected: all old and new checks PASS.

- [ ] **Step 4: Run multi-tick simulations**

Run: `npm.cmd run simulate`

Expected: all scenarios progress with zero coherence violations.

- [ ] **Step 5: Run the full suite fresh**

Run: `npm.cmd test`

Expected: validate, smoke, and simulate all PASS; compare with the captured zero-failure baseline.

- [ ] **Step 6: Commit release changes**

```powershell
git add src/kittens-game-helper.user.js scripts/smoke.mjs scripts/simulate.mjs scripts/validate.mjs README.md CLAUDE.md package.json docs/superpowers/plans/2026-06-24-live-midgame-planner.md
git commit -m "feat: make midgame planning live and phase aware"
```

- [ ] **Step 7: Push and integrate**

Push `main` to `origin/main` after confirming the branch is still based on the inspected upstream head and no remote changes conflict. If remote moved, fetch and merge non-destructively, re-run `npm.cmd test`, then push.
