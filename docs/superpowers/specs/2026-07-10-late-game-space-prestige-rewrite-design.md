# Late-Game Space and Prestige Rewrite Design

## Objective

Make Kittens Helper complete late-game progression without manual Space selection or manual resource bootstrapping. The helper must understand the full dependency chain across missions, planet buildings, storage, converters, crafts, trades, religion, transcendence upgrades, Chronoforge, and Void Space. It may automatically execute Transcend, Adore, and alicorn sacrifice because the user explicitly authorized those irreversible actions, but only through the fail-closed policy below.

The supplied v2.20.6 diagnostic is the primary regression state. In that state Piscine Mission and Helios Mission are open, uranium is capped, Lunar Outpost and Planet Cracker are unbuilt, unobtainium storage blocks numerous upgrades, and a repeat Accelerator incorrectly owns a multi-hour plan.

## Scope

This rewrite covers:

- Space missions and every planet building exposed by the live game metadata.
- Resource acquisition through passive income, jobs, crafting, bounded transformations, and diplomacy trades.
- Uranium bootstrap through Dragons, including nested Zebra titanium funding when required.
- The uranium-to-unobtainium Space loop: Planet Cracker, Lunar Outpost, Moon Base, and downstream storage/upgrade gates.
- Leviathan acquisition of time crystals, relics, sorrow, and other trade-only resources.
- Transcendence upgrades, Chronoforge upgrades, and Void Space upgrades with their correct controller families.
- Automatic Transcend, Adore, and alicorn sacrifice under explicit safeguards.
- Late-game diagnostics, action logging, and realistic regression simulations.

It does not automate world reset, challenge selection, time skipping, time-crystal shattering, save importing, or raw game-state mutation.

## Architecture

### 1. Unified acquisition graph

Introduce a single acquisition planner for a requested resource amount. It returns a normalized route containing availability, ETA, expected yield, nested input requirements, output headroom, blockers, and the next executable step.

Supported route nodes are:

- existing bank and passive production;
- job-backed production;
- craft recipes and their recursive raw inputs;
- bounded transformations such as unicorns to tears and alicorns to time crystals;
- race trades validated with the game's native diplomacy eligibility and yield APIs;
- producer or storage candidates that create a missing resource path.

All reachability, candidate ETA, scoring, job pressure, reservations, diagnostics, and diplomacy execution must consume this same route. The current titanium-only reachability exception and the static rule that maps uranium demand to miners will be removed.

The strategic target remains the actual progression item. If an Accelerator or Lunar Outpost needs uranium, the plan remains that item while the current sub-action reads "trade Dragons for uranium." Nested routes may produce a sequence such as Zebra titanium, then Dragon uranium, then the target purchase.

### 2. Normalized late-game descriptors

Space and Time metadata will be wrapped in descriptors that preserve the owning subsystem and controller family.

A Space descriptor contains its subtype (`mission` or `planetBuilding`), raw metadata, owning planet, gate state, completion state, live price provider, controller specification, and marginal effect profile. Mission and planet-building adapters separately enumerate, price, execute, and verify purchases. No generic `space.build()` fallback may prove a controller test successful.

A Time descriptor distinguishes Chronoforge from Void Space and uses `ChronoforgeBtnController` or `VoidSpaceBtnController` respectively, including live controller prices. Transcendence upgrades are a separate repeatable candidate family using the native Transcendence upgrade controller; they are not confused with the irreversible Transcend action.

### 3. Late-game progression frontier

Add a strategic layer above ordinary economy growth but below immediate safety recovery. It ranks dependency frontiers rather than isolated items.

The layer prioritizes:

1. A first mission or first building that unlocks a planet, downstream mission, resource, storage family, or controller family.
2. A producer that creates a currently missing resource path.
3. Storage that removes a live cap blocker for a reachable high-value target.
4. A converter or infrastructure bridge required by the selected frontier.
5. Repeatable economic copies only after the frontier is healthy or outside the configured planning horizon.

Gateway value applies to all candidate kinds, not research alone. Space candidates are not automatically classified as long projects. The post-reset expansion layer may take one population checkpoint, but it must then yield to an actionable gateway research or late-game frontier so Chronophysics and similar technologies cannot starve indefinitely.

### 4. Marginal Space effects

Extend effect interpretation for live Space effect families that the generic resource parser misses. The adapter must value at least:

- `spaceRatio`, `prodTransferBonus`, and `oilReductionRatio`;
- antimatter production and containment capacity;
- broad storage ratios and planet-specific storage;
- travel/route speed;
- terraforming and hydroponics population effects;
- upgrade-only synergies such as Heatsink to Containment Chamber;
- HR Harvester and Entangler energy/hash mechanics;
- Tectonic and Molten Core synergy.

Where a static effect cannot represent the marginal value, use a safe read-only one-unit projection. The projection may call calculation functions against copied effect state but must not mutate owned counts or resources.

### 5. Single diplomacy executor

Replace the two competing trade loops with one executor that performs at most one diplomacy mutation per planner tick. Its order is:

1. Reveal or prepare the race required by the active acquisition route.
2. Fund and execute the active target's trade step.
3. Make an optional overflow trade only when no active route needs diplomacy resources.
4. Buy an embassy only when it improves the active route or safely spends true surplus.

Trade eligibility and expected yield use native game APIs when present. Fallback math uses fractional chance values, the seasonal multiplier `1 + delta`, embassy minimum levels, standing, global trade ratio, policies, challenges, and race energy. Tests and simulations must use live-style fractional chance metadata.

Every batch is bounded by the active deficit, output storage headroom, one-tick action limit, and the complete reservation ledger. The ledger includes the active plan, manual queue, unicorn path, rare-capital floors, survival catnip/catpower, and policy reservations. Jobs must fund the selected route's inputs; Dragon uranium therefore pressures titanium, catpower, and gold rather than minerals.

### 6. Fuel-aware processing

Converter control must preserve resources reserved by the active acquisition route. Reactors may consume only uranium remaining after the target and rare-capital floors. Resume logic chooses the largest count supported by projected uranium income and stock instead of toggling the entire fleet on or off. Lunar Outposts similarly run only at a count that the uranium route can support while continuing the selected unobtainium frontier.

## Irreversible Action Broker

All mutations flow through a semantic action broker. Each action has an explicit identifier and one policy class:

- `SAFE_REPEATABLE`: normal purchases, crafts, trades, praise, and bounded unicorn-to-tears conversion.
- `RARE_CAPITAL`: alicorn sacrifice and purchases spending time crystals, relics, void, karma, paragon, or other scarce permanent capital.
- `AUTHORIZED_PRESTIGE`: Transcend and Adore, enabled by the user's explicit authorization recorded in helper state.
- `FORBIDDEN`: world reset, challenge reset, time skip, shatter, raw metadata mutation, and unknown controller actions.

The broker is the final execution boundary. Candidate filtering remains defense in depth, but a denied or unknown action passed directly to the purchase function must still produce zero controller calls.

Global `gamePage.opts.noConfirm = true` will be removed. Repeatable controllers are invoked through their public APIs. Before an irreversible action, the broker must:

1. Verify persistent user authorization.
2. Create a fresh native save/checkpoint and refuse the action if no checkpoint API is available.
3. Re-read all relevant resources and metadata.
4. Recompute the action's projected before/after state.
5. Verify every reservation and protected floor.
6. Execute at most one irreversible action in the cycle through the native public controller or manager API.
7. Confirm the expected postcondition and log the measured delta.
8. Enter a cooldown before another irreversible action.

No irreversible action may call internal reset helpers or alter raw counters.

### Transcend and Adore policy

The prestige planner reads worship, epiphany, transcendence tier, the native next-tier cost, and the native projected Adore gain.

- Transcend may run only when the native action is available, the full next-tier price is funded, the projected tier increases by exactly one, and the remaining epiphany does not violate a transcendence-upgrade reservation.
- Adore may run only when its projected epiphany gain is positive, no pending faith purchase or Transcend would be made worse by waiting one cycle, and the projected recovery of the temporary Solar Revolution loss is inside the planner horizon.
- When both are appropriate, Transcend occurs before Adore. The broker performs one action, re-plans from fresh state, and may perform the second only in a later cycle.
- Praise remains a safe repeatable action and runs only after the prestige action has been revalidated.

The diagnostics must show the projected gain, retained capital, blocker, and cooldown even when no action fires.

### Alicorn sacrifice policy

Alicorn sacrifice may run only for a concrete active target's time-crystal deficit. The planner first compares passive production and a valid Leviathan trade route. It then computes the minimum whole sacrifice batches needed and preserves a dynamic alicorn floor covering every reachable alicorn-priced purchase and current rare-capital reservation.

Only one batch may execute per irreversible cycle. The helper re-plans after each batch. In the supplied state it must not sacrifice because 39.85 alicorns minus the 25-alicorn batch would leave less than the 20 required for Alicorn Stable, while the existing time crystal already covers Stasis Chambers.

## Diagnostics and Observability

Diagnostics will add:

- the active acquisition route with each nested step and ETA;
- the selected diplomacy path, expected live yield, batch bound, and reservation floors;
- Space gates that distinguish predecessor mission, planet not reached or in transit, required technology, and building-upgrade gate;
- Religion sections for ordinary, ziggurat, and transcendence upgrades;
- Time sections for Chronoforge and Void Space;
- prestige projections and explicit reasons that Transcend, Adore, or alicorn sacrifice did or did not run;
- processor fuel budgets and sustainable active counts.

The unlock watcher must include Space missions, planet buildings, transcendence upgrades, Chronoforge, and Void Space so newly exposed late-game content forces a re-plan.

## Error Handling

- Missing native controllers or price providers make the action unavailable and produce a diagnostic; they do not fall back to raw state mutation.
- A race that departs, becomes invalid, or lacks its embassy requirement invalidates the route immediately.
- If a checkpoint, precondition, or postcondition check fails, the broker records the failure and suppresses further irreversible actions for the cooldown.
- Cycles in acquisition routes are detected and reported as blockers.
- A storage-blocked output cannot trigger a trade or transformation batch beyond current headroom.
- A failed purchase invalidates the cached plan and forces a fresh metadata read.

## Testing Strategy

Every behavior change follows red-green-refactor. Tests must fail for the intended missing behavior before production code is changed.

Required regression groups:

1. Live trade math with fractional chances, positive and negative seasons, embassy minimum levels, standing, and native eligibility.
2. Dragon uranium bootstrap with Dragons already unlocked and with race discovery required.
3. Nested Zebra titanium to Dragon uranium acquisition.
4. Leviathan time-crystal/relic routes, departure invalidation, and unobtainium reservations.
5. One diplomacy mutation per tick and complete-ledger batch bounds.
6. Fuel-budgeted Reactors and Lunar Outposts.
7. Controller-only mission and planet-building purchases with canonical live IDs, including `sattelite` and `concrate`.
8. First-copy mission and resource-producer frontier ranking over repeat Accelerators.
9. Gate reporting for predecessor mission, transit, required technology, and upgrade dependency.
10. Table-driven marginal Space effect coverage for every effect family listed above.
11. Correct Transcendence, Chronoforge, and Void Space discovery, pricing, and controllers.
12. Fail-closed direct execution tests for reset, shatter, time skip, unknown actions, and missing authorization.
13. Authorized Transcend and Adore projections, checkpoint requirement, action ordering, one-action limit, and measured postconditions.
14. Alicorn sacrifice protection using the supplied 39.85-alicorn state, plus a positive exact-deficit case.
15. Post-reset research non-starvation with a full village and pending Chronophysics.
16. End-to-end simulations for early Space, uranium/unobtainium, antimatter, Leviathans, transcendence upgrades, and Void Space.

The final gate runs validation, smoke tests, simulations, and any focused new suites. A broad code review must verify the full diff before merge.

## Delivery

The helper version, userscript metadata, README behavior description, diagnostics, and tests will be updated together. Work will occur on a `codex/` development branch, with task-scoped commits and reviews. After full verification, the completed branch will be merged to `main` and pushed to `origin` as requested.
