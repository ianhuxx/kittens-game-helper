# Workshop Checkpoint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent post-reset housing expansion from indefinitely reserving resources away from materially better workshop upgrades that are already affordable.

**Architecture:** Add a pure selector that compares the best ready workshop upgrade with the live expansion candidate using the existing 25% score-gain threshold. Invoke it only in the expansion branch, after higher safety layers and before returning the expansion target.

**Tech Stack:** Native JavaScript userscript, Node.js VM smoke harness, npm validation and simulation scripts.

## Global Constraints

- First-reset expansion remains higher priority than every automatic workshop checkpoint.
- Manual queue, stage rebuild, power recovery, and converter-fuel recovery remain unchanged.
- Purchases continue through official game controllers and never bypass reservations.
- Bump all three version strings from `2.20.3` to `2.20.4`.

---

### Task 1: Select a ready workshop upgrade before post-reset expansion

**Files:**
- Modify: `scripts/smoke.mjs` in the Test W reset-aware expansion fixture
- Modify: `src/kittens-game-helper.user.js` near `bestExpansionCheckpoint`, `STRATEGIC_LAYERS`, and the expansion branch of `selectStrategicTarget`
- Modify: `package.json`

**Interfaces:**
- Consumes: `bestExpansionCheckpoint(candidates, resources)`, `candidateMeetsSwitchScoreGain(from, to)`, `solveCraftChain(resources, candidate)`, and `buyBenched(id)`
- Produces: `bestReadyWorkshopCheckpoint(candidates, resources, expansion)` returning a candidate or `null`, plus `STRATEGIC_LAYERS.workshopCheckpoint`

- [ ] **Step 1: Write the failing regression**

Extend Test W with a post-reset, full-village fixture containing an affordable
upgrade whose score is more than 25% above the housing candidate. Assert that
`selectStrategicTarget("balanced")` returns the upgrade under `Workshop checkpoint`.
Then set `totalResets=0`, `paragonPoints=0`, and `karmaKittens=0` and assert the
same board returns `Expansion checkpoint`.

- [ ] **Step 2: Verify the regression fails for the missing layer**

Run: `npm.cmd run smoke`

Expected: the post-reset workshop-checkpoint assertion fails while the existing
first-reset expansion assertion remains green.

- [ ] **Step 3: Implement the minimal selector and planner branch**

Add `bestReadyWorkshopCheckpoint` that rejects missing/first-reset expansion,
filters to open affordable non-benched upgrades with reachable craft chains,
sorts by score, and returns the winner only when
`candidateMeetsSwitchScoreGain(expansion.candidate, winner)` is true. Add the
new layer label and return it before the existing expansion return, including a
reason naming both candidates and a deferred-expansion diagnostic.

- [ ] **Step 4: Bump the release version**

Change `@version`, `HELPER_VERSION`, and `package.json` from `2.20.3` to `2.20.4`.

- [ ] **Step 5: Verify behavior and regressions**

Run: `npm.cmd test`

Expected: validation passes with version `2.20.4`, every smoke check passes,
and all seven 80-tick simulations pass without coherence violations.

- [ ] **Step 6: Commit, merge, verify, and push**

Commit the implementation, fast-forward merge `codex/workshop-checkpoint` into
`main`, rerun `npm.cmd test` on merged `main`, and push `origin main`.

