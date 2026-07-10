# Workshop Roadmap Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give workshop upgrades one truthful, persistent scheduler that can fund non-ready upgrades without being trapped behind false ETAs or resolved safety locks.

**Architecture:** Repair cumulative craft ETA first, then make Power-recovery locks conditional, then replace the ready-only expansion checkpoint with a bounded sticky Workshop roadmap. Remove the competing deep-upgrade scan from parallel crafting so the roadmap is the sole backlog owner.

**Tech Stack:** Native JavaScript userscript, Node.js VM smoke harness, npm validation and simulation scripts.

## Global Constraints

- Keep official-controller purchases, target ledgers, and irreversible-action guards unchanged.
- Genuine power and food safety remain above workshop progression.
- Active research sprints retain their current contract.
- Non-ready workshop projects must have a corrected finite ETA no greater than 3,600 seconds.
- Bump all three version strings from `2.20.5` to `2.20.6`.

---

### Task 1: Correct cumulative craft-chain ETA

**Files:**
- Modify: `scripts/smoke.mjs`
- Modify: `src/kittens-game-helper.user.js` in `capDrainReachabilityFor` and `window.__kghDebug`

**Interfaces:**
- Consumes: `capDrainReachabilityFor(resources, name, amount)` and `waitSecondsForCandidate(candidate, resources)`
- Produces: cumulative input multiplication for craft-only resources and debug method `waitSecondsForCandidate(candidate)`

- [ ] Add synthetic Alloy, Steel, Titanium, Coal, and Iron state where one Alloy craft is banked but a 100-Alloy target requires many more crafts. Assert `waitSecondsForCandidate` is finite and greater than 60 seconds.
- [ ] Run `npm.cmd run smoke` and confirm the new ETA assertion fails because it returns zero.
- [ ] Compute `incrementalDirectCraft = prod > 0 && rawWorkNeedName(name) === name` once and use it both for the direct-production early return and for choosing one-step versus cumulative child input amounts.
- [ ] Expose `waitSecondsForCandidate(candidate)` through `window.__kghDebug` and rerun smoke until the regression passes.

### Task 2: Release resolved Power-recovery contracts

**Files:**
- Modify: `scripts/smoke.mjs` in Test Z/AA power-lock coverage
- Modify: `src/kittens-game-helper.user.js` in `chooseWorkTarget`

**Interfaces:**
- Consumes: `activeTarget.layer`, current `decision.layer`, and `STRATEGIC_LAYERS.power`
- Produces: `resolvedConditionalLock` lock-break reason

- [ ] Force a Power-recovery target lock, restore healthy effective power, and assert `chooseWorkTarget` does not return the old generator.
- [ ] Run `npm.cmd run smoke` and confirm the assertion fails by retaining the generator.
- [ ] Add a lock-break predicate for `activeTarget.layer === STRATEGIC_LAYERS.power && decision.layer !== STRATEGIC_LAYERS.power`, clear the lock immediately, and log `power recovery resolved`.
- [ ] Rerun smoke and confirm existing genuine-deficit lock-break tests remain green.

### Task 3: Replace the checkpoint with a bounded Workshop roadmap

**Files:**
- Modify: `scripts/smoke.mjs` in Test W and new workshop-roadmap cases
- Modify: `src/kittens-game-helper.user.js` near the old checkpoint, strategic layers, and `selectStrategicTarget`

**Interfaces:**
- Produces: `bestWorkshopRoadmap(candidates, resources)` returning `{ candidate, eta, ready, value }` or `null`
- Produces: `STRATEGIC_LAYERS.workshopRoadmap = "Workshop roadmap"`

- [ ] Change the ready-upgrade regression to expect `Workshop roadmap`; add a reachable non-ready Steel/Mining-style upgrade within 3,600 seconds and an Alloy-heavy upgrade beyond 3,600 seconds. Assert the former is selected and the latter rejected. Preserve the first-reset expansion assertion.
- [ ] Run smoke and confirm the new layer/non-ready assertions fail against the ready-only checkpoint.
- [ ] Implement a sticky roadmap id. Filter open upgrades through purchase bench, storage blocker, and craft-chain reachability. Admit ready upgrades or finite corrected ETAs at most 3,600 seconds. Sort ready first, then by `(max(0, score) + gatewayValue(meta)) / (1 + log10(eta + 1))`, retaining the sticky target within 25% of the winner.
- [ ] Invoke the roadmap after active/new safety layers and before expansion when no research sprint is active. Return normal protected-chain and diagnostics fields.
- [ ] Rerun smoke and confirm ready, non-ready, horizon, and first-reset checks pass.

### Task 4: Remove competing deep workshop parallel scan

**Files:**
- Modify: `scripts/smoke.mjs` Test AK/AK2 expectations
- Modify: `src/kittens-game-helper.user.js` in `craftTowardParallelCandidates`
- Modify: `package.json` and userscript version strings

**Interfaces:**
- Removes: `PARALLEL_UPGRADE_SCAN` and out-of-window upgrade traversal
- Retains: ordinary `PARALLEL_TIER_SCAN` and `PARALLEL_TIER_CRAFTS`

- [ ] Replace deep-backlog assertions with checks that out-of-window upgrades are untouched by parallel work and selected through the Workshop roadmap when within its horizon.
- [ ] Run smoke and confirm the changed ownership assertion fails before production removal.
- [ ] Simplify the parallel loop to stop at `PARALLEL_TIER_SCAN`; remove backlog counters and special upgrade eligibility.
- [ ] Bump `@version`, `HELPER_VERSION`, and `package.json` to `2.20.6`.
- [ ] Run `npm.cmd test`, inspect `git diff --check`, commit, merge to `main`, rerun `npm.cmd test`, and push `origin main`.

