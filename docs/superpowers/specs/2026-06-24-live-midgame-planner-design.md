# Live Midgame Planner Design

## Goal

Make the helper choose the fastest sensible midgame progression from the player's actual save state. Science-cap blockers must produce a direct, measurable cap fix; staged buildings must use their current in-game identity; housing must remain competitive on the route to a productive manual reset; and every automated action must remain reservation-safe. Prestige resets and every other irreversible action remain disabled.

## Findings

The current planner reads bonfire candidates from raw `buildingsData`. Kittens Game overlays the active stage through `BuildingMeta.getMeta()`, so the raw object can expose a base label, base effects, or placeholder effects while the game is actually showing Data Center, Broadcast Tower, Solar Farm, Hydro Plant, or another stage.

The science-storage layer also has three valuation defects:

1. A name/text fallback can admit an option without a measured positive science-cap effect.
2. `scienceStorageGain` treats `scienceRatio` as storage by multiplying it by the current science cap. In Kittens Game, `scienceRatio` is science production, not capacity.
3. Ranking only the next purchase's gain divided by its ETA ignores how many repeated purchases are needed to close the whole cap deficit. A cheap, weak option can therefore remain sticky even when it cannot close the blocker efficiently.

Research sprints are intentionally persistent, but a new sprint can repeatedly start whenever science is near its cap. Housing is only a normal scored candidate and currently receives the same base value for any positive housing effect, so a gateway research chain can continuously outrank population growth even when the village is at its kitten cap and still below a sensible first-reset population.

Festivals currently run as a late tick side action with fixed costs. The gate only rejects a festival when any same-name resource is reserved; it does not verify that paying the full festival price leaves the reserved quantity intact. Festival state is also absent from the persistent panel, so a held or blocked festival is easy to miss. Because a festival adds happiness and doubles kitten arrival rate, it should be valued as timed economy maintenance rather than an invisible convenience action.

The unlock watcher currently sees open buildings, research, upgrades, and religion items, but it does not see newly unlocked resources or workshop crafts. Hidden-but-unlockable buildings can require the player to hold a fraction of a newly craftable resource before the game exposes them. Without a generic bootstrap path, new content can remain invisible to the planner until the player manually crafts the first Concrete, Tanker, or future resource.

The Robotics-style research chain exposes a separate phase bug. Robotics needs both a final science bank and Blueprints, while crafting Blueprints and their Compendia also consumes science. The current direct-input guard permanently reserves the final 140K science before the 80 Blueprints exist. With a science cap only slightly above 140K, no Blueprint craft can ever fit in the unreserved remainder, so science appears to stop immediately below Robotics. Removing the reserve entirely would cause the opposite failure: repeatedly draining the final bank without clearly preserving the research contract.

Observed production telemetry averages resource-bar deltas across helper actions and capped periods. A craft, trade, purchase, or cap clip can therefore look like continuous negative or zero production and override the game's ticker API. This can misdirect ETAs, job allocation, and the explanation shown to the player.

The existing test suite passes before changes. This establishes a green baseline rather than hiding an existing failure.

## Architecture

### 1. Live metadata view

Keep the raw metadata object as the candidate's stable identity and controller target. Add a side-effect-free live view for reading:

- For staged bonfire buildings, refresh `calculateEffects`, then merge the raw metadata with exactly the active `stages[stage]` entry, matching Kittens Game's `BuildingMeta` semantics.
- For ordinary buildings and non-building candidates, use their current metadata directly.
- Read display labels, effects, descriptions, and stage prices from this live view. Continue using the game's own price APIs for scaled purchase prices and discounts.
- Parse only the active effect object. Do not sum base placeholders and active-stage effects.

This view becomes the common source for UI labels, candidate effect profiles, science-cap analysis, processing discovery, manual queue labels, and debug output.

### 2. Evidence-based science-cap planning

A science-storage candidate must have a measured positive marginal capacity contribution in its live effect profile. Remove building-name and descriptive-text admission from this structural layer.

Capacity gain includes only effects that actually feed usable science capacity, such as live `scienceMax` and the usable portion of `scienceMaxCompendia`. `scienceRatio` remains a production multiplier and contributes no capacity gain.

For each option, project repeated purchases using the game's live scaled prices until one of these terminal states:

- the blocker deficit is closed;
- a purchase becomes storage- or production-unreachable;
- a small projection bound is reached.

Rank options primarily by reachable cap deficit closed per total projected ETA, then by full-closure ETA, reservation conflicts, and generic economic score. A target that closes only a small fraction of the deficit cannot stay sticky against a materially faster full solution. Stickiness is scoped to the blocked research and active building stage; it resets when either changes.

The selected decision records all considered options with live label, current stage, per-copy gain, projected copies, projected gain, ETA, closure percentage, and rejection reason.

### 3. Staged-building transitions with opportunity-cost accounting

Expose adjacent unlocked stages as reversible `stage` candidates. Both upgrades and downgrades are eligible, but they never run as opportunistic side actions. A transition must be the active reserved plan.

For every transition, calculate:

- the current stage's owned count, active count, live effects, energy/input costs, and current economic utility;
- the game's guaranteed refundable proceeds from selling every current copy, using the live price curve, the controller's 50% refund, refundable-resource rules, and current discounts;
- the target stage's cumulative rebuild cost and scaled price curve;
- the smallest rebuild count that reaches bottleneck parity and the smallest count that produces a material net improvement;
- the temporary loss of production, storage, housing, and other active effects during the rebuild ETA;
- the value of changed energy consumption and resource drains;
- any post-transition cap regression that would strand currently held resources or block the active plan;
- payback time: transition loss plus rebuild cost, net of conservative refunds, divided by the target stage's incremental live economic value.

A transition is actionable only when the target stage is unlocked, the rebuild chain is reachable, post-sale stock plus conservative refunds covers the reserved rebuild and safety buffers, no critical resource becomes dangerously over-cap, and payback fits the current planning horizon. The transition ledger reserves the rebuild inputs and their raw craft chain before the controller is invoked.

The planner uses Kittens Game's `StagingBldBtnController.deltagrade` so the game owns refunds, stage mutation, recalculation, render, and undo registration. After the change, the same active plan continues as rebuilding the new live stage. A cooldown and improvement hysteresis prevent stage thrashing.

### 4. Reset-aware balanced progression

Resets remain manual and forbidden to the action engine. The existing reset advisor supplies progression context:

- before the first reset, the current 130-kitten/Concrete Huts recommendation is the expansion milestone;
- after the first reset, live paragon-per-day and population-cap pressure provide the planning horizon.

Add a generic expansion-pressure calculation from live kitten count, kitten cap, free housing, population growth, reset count, and reset milestone distance. Housing value scales with both the number of kitten slots added and the current expansion pressure.

Before starting a new research sprint, compare its projected time and unlock value with the best reachable housing expansion. When population is at or near its cap and expansion has a better milestone-adjusted payoff, housing owns an `Expansion checkpoint` layer. An already active research sprint remains a stable contract unless its feasibility changes or the expansion opportunity becomes materially superior; this preserves reservation stability without allowing endless science tunnel vision.

This is effect-based rather than item-based: any current or future building stage exposing positive `maxKittens` can satisfy expansion pressure.

### 5. Festival maintenance

Represent one festival year as a live `festival` candidate with the game's current price, remaining duration, and measured benefits. Its value combines:

- the production increase from the live happiness change across the staffed economy;
- the faster kitten arrival rate while free housing exists;
- live festival modifiers from perks, policies, buildings, and cycle effects;
- the remaining useful duration, so an active festival is not refreshed wastefully without Carnivals;
- the ETA and opportunity cost of 1,500 catpower, 5,000 culture, and 2,500 parchment through their actual production/craft chains.

When its benefit repays its cost inside the useful duration, an expired or nearly expired festival competes in a visible `Festival maintenance` layer. It may become the active reserved plan when maintaining uptime is materially better than the next research, housing, or economy option. Otherwise it remains a surplus action and explains why it was deferred.

Festival execution uses the live festival button/controller when available so Kittens Game owns payment and duration changes. A fallback may call `holdFestival` and pay the exact live model price once, but never both. The full expanded spend is checked with `violatesTargetLock`/`pricesRespectReservations`; paying a festival must leave every active-plan reservation intact.

The panel reports `Festival: active — <duration>`, `Festival: saving — <missing resources>`, or `Festival: deferred — <opportunity-cost/reservation reason>` so festival behavior is continuously observable rather than visible only in the action log.

### 6. Generic resource and craft bootstrap

Extend live unlock discovery to resources and workshop crafts. Identity and display always come from current game objects: internal IDs such as `concrate` remain controller keys, while the panel uses the live resource/craft title such as `Concrete`.

For each hidden-but-unlockable building or stage, inspect its live prices and `unlockRatio`. If an unlocked craft can produce a missing threshold resource, create a `Resource bootstrap` candidate for the smallest amount that can reveal that downstream content. Also permit a one-unit probe for a genuinely fresh craft when the live metadata names downstream buildings, stages, upgrades, crafts, or storage effects that are not yet observable.

Bootstrap candidates use the normal recursive craft solver, ETA model, and target ledger. They never blindly craft every unlocked item, never rely on a hard-coded resource list, and never consume an active plan reservation. Once the output exists or the downstream content opens, the bootstrap completes and normal scoring evaluates the new candidates.

The unlock watcher logs new resource/craft labels, clears stale candidate/effect/resource-name caches, and breaks the target lock only when the newcomer changes reachable planning options.

### 7. Phase-aware research chains

Split a research contract into explicit phases derived from its live prices:

1. **Intermediate phase:** create all missing craftable direct costs. The active target may spend a shared direct bank, such as science, through its own intermediate chain. Side actions still see that bank as target-owned and cannot spend it.
2. **Final-bank phase:** after craftable direct costs are complete, reserve and refill the final non-craftable prices.
3. **Purchase phase:** buy immediately when every direct price is present.

The target-owned craft allowance is narrow: it applies only when the craft output is itself a missing direct price of the same target, only for the calculated number of units, and only through the solver's protected chain. It ends as soon as the intermediate requirement is met. This lets Robotics cycle science into exactly the required Blueprints, then accumulate and preserve 140K science, without allowing overflow crafting, festivals, trades, upgrades, or surplus purchases to drain that bank.

The UI reports the phase and expected bank cycling explicitly, for example: `Phase: craft 80 Blueprints (science cycles into intermediates), then refill 140K Science for Robotics`.

### 8. Authoritative ticker and telemetry reads

Use `game.getResourcePerTick(name, true)` as the authoritative continuous production rate when available. Resource-bar telemetry remains an independent cross-check, but it may replace the API value only when:

- the sample window is below the cap and not clipped;
- no discrete helper action changed that resource during the window;
- the observed and API rates have compatible direction and a tight relative tolerance.

Every wrapped action marks changed resources as telemetry discontinuities and restarts their sample windows. Successful controller purchases and unwrapped game actions do the same through before/after snapshots. A capped flat bar is reported as `capped` rather than zero production, and a target-owned craft drain is reported as a discrete transfer rather than negative ticker production.

### 9. Reservation and safety invariants

- Every purchase, craft, trade, policy, upgrade, stage transition, and downgrade checks the active target ledger.
- Festival payment checks its complete direct and crafted-resource spend against the same ledger; merely detecting a shared resource name is not sufficient.
- Bootstrap crafting and phase-aware research crafting remain target-owned actions; every unrelated spender sees their protected resources as reserved.
- Stage rebuild costs and their transitive raw inputs enter the same reservation ledger before transition.
- No side action may consume current stock or expected refundable proceeds needed by the active plan.
- Irreversible actions remain denied: reset, transcend, sacrifice, shatter, time-skip, and equivalents.
- Failed controller actions are benched through the existing mechanism; no raw metadata purchase fallback is enabled.

## UI and diagnostics

The compact panel continues to show Focus, Layer, and Need, using the current in-game label. Automation details add:

- science blocker, current cap, required cap, and exact deficit;
- each cap option's measured gain, projected copies, closure percentage, ETA, and rejection reason;
- active raw building ID plus live stage label;
- stage-transition refund, rebuild-to-parity cost, temporary lost utility, payback ETA, and safety vetoes;
- population saturation, reset milestone distance, best housing option, and why research or expansion won;
- festival remaining duration, live benefit/payback estimate, missing inputs, and reservation or opportunity-cost deferrals;
- newly unlocked resource/craft candidates and the downstream threshold that justifies each bootstrap;
- research phase, remaining intermediates, final-bank target, and intentional resource transfers into the target chain;
- ticker API rate, uncontaminated observed rate, cap clipping, and ignored discrete-action deltas when they disagree;
- reservation sources for transition and rebuild resources.

Debug details are explanatory only and do not weaken reservation checks.

## Testing

Use test-driven development and extend the real smoke harness rather than reimplementing planner logic.

Regression scenarios will cover:

1. A raw `library` at stage 1 is displayed and scored as Data Center with current stage effects and prices.
2. Broadcast Tower and Brewery labels/effects remain current and do not regress to base-stage assumptions.
3. Temple with zero live `scienceMax` is rejected from science-cap options even if its metadata text mentions science; Temple with a genuine positive cap effect is measured but loses when its projected closure ETA is worse.
4. `scienceRatio` does not inflate predicted storage gain.
5. A roughly 105K cap blocked by roughly 145K research chooses the fastest projected direct cap solution and explains every rejected option.
6. Sticky cap choice resets when blocker or building stage changes and yields to a materially better full-closure option.
7. A staged upgrade reserves rebuild resources, accounts for 50% refunds and lost effects, invokes only the staging controller, and continues rebuilding under the same plan.
8. An uneconomic upgrade or downgrade is rejected with its payback/safety reason; a later beneficial downgrade can win without oscillation.
9. Near-cap population below the first-reset milestone chooses effect-derived housing over starting another lower-payoff research sprint.
10. Research still wins when housing has headroom or its projected payoff is worse.
11. An expired high-value festival becomes visible maintenance, is held through the game controller, and reports its active duration.
12. A festival waits when its full payment would cross an active plan reservation, but can spend true surplus above the reservation.
13. A festival with poor payback or no free housing is deferred with a visible reason instead of blindly consuming resources.
14. A newly unlocked live craft with a hidden downstream building threshold creates the minimum first resource generically and reveals the building without a name rule.
15. Live `concrate` metadata is displayed as Concrete and invalidates stale resource/craft caches when it unlocks.
16. Robotics with a cap just above 140K spends science only into its missing Blueprint/Compendium chain, completes 80 Blueprints, then preserves and refills the final 140K bank.
17. An unrelated overflow craft, festival, trade, or upgrade cannot use Robotics' protected science during either phase.
18. Capped science telemetry does not overwrite positive ticker production with zero, and discrete craft/purchase deltas do not become negative production.
19. All existing reservation, research sprint, irreversible-action, and simulation checks remain green.

Run `npm.cmd test` after focused red/green cycles. Bump all three version strings together from 2.4.6 to 2.5.0 because this adds planner behavior and staged-transition capability.

## Delivery

Commit the design, implementation plan, tests, source changes, and version bump. Merge the completed work into `main` only after a fresh full validation run. Report any failure as either new or baseline; the captured baseline currently has zero failures.
