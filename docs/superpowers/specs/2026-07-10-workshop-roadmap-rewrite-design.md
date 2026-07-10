# Workshop Roadmap Rewrite Design

## Problem and root cause

The v2.20.4 checkpoint can buy a workshop upgrade that is already affordable,
but it does not own non-ready workshop progression. Parallel crafting, normal
candidate scoring, expansion, and power recovery all compete to spend the same
resources.

The live v2.20.4 report proves the checkpoint itself fired and bought Space
Engineers. It also exposes the deeper stall: Magneto remained locked after
effective power recovered to +12 Wt, while 448 missing Alloy was displayed as
`ETA now`. The ETA is false because `capDrainReachabilityFor` reduces any craft
whose raw-work name equals its output to one recipe step, even when the resource
has no direct production. Alloy therefore prices one 75-Steel craft instead of
the cumulative Steel bill for every required Alloy craft.

## Alternatives considered

1. **Add another workshop exception to expansion.** Small, but it repeats the
   failed architecture and still cannot guide non-ready upgrades.
2. **Give parallel crafting a reserved workshop slot.** It improves background
   progress but cannot cross an active plan's reservation and leaves selection,
   ETA, and lock ownership contradictory.
3. **Create one Workshop roadmap owner and repair ETA/lock semantics.** This is
   the chosen design because it gives selection, reservation, crafting, buying,
   diagnostics, and resumption one source of truth.

## Workshop roadmap

Replace `bestReadyWorkshopCheckpoint` with `bestWorkshopRoadmap` and rename the
layer to `Workshop roadmap`.

The roadmap scans open workshop upgrades and rejects purchase-benched,
storage-blocked, and hard-blocked candidates. A ready upgrade is always eligible.
A non-ready upgrade is eligible only when its corrected cumulative ETA is finite
and no more than one hour. Options are ordered as follows:

1. ready before non-ready;
2. larger live value per logarithmic hour of ETA;
3. shorter ETA as a tie breaker.

The selected upgrade becomes a normal active plan. Existing target-ledger,
craft-chain, official-controller purchase, and lock machinery then reserve,
craft, and buy it without a second executor. A sticky roadmap id keeps the prior
upgrade while it remains within 25% of the current winner, including after a
safety preemption.

The roadmap runs after stage rebuild, manual queue, genuine power recovery, and
converter-fuel recovery, but before expansion and new research-sprint discovery.
An already-active research sprint remains unchanged.

## ETA and lock correctness

`capDrainReachabilityFor` may use a one-recipe incremental bill only when the
craft output also has positive direct production. Craft-only outputs such as
Alloy, Steel, Gear, and Blueprint must multiply every input by all required
craft units.

A plan created by `Power recovery` is conditional, not a six-minute ordinary
project. When the current strategic decision is no longer Power recovery, the
old power target lock releases immediately. Genuine raw-power emergencies retain
their existing priority and can preempt the Workshop roadmap.

## Single ownership

Remove the special `PARALLEL_UPGRADE_SCAN` path. Parallel work continues for the
ordinary ranked window but no longer acts as a second, partial workshop
scheduler. The Workshop roadmap is solely responsible for deep upgrade backlog
selection; normal execution remains responsible for crafting and purchase.

## Diagnostics and verification

The plan layer and reason must show `Workshop roadmap`, the selected upgrade,
whether it is ready or funded within the horizon, and its corrected ETA.

Regression coverage will prove:

- a large Alloy bill has a positive cumulative ETA rather than `now`;
- a recovered Power-recovery lock releases immediately;
- a ready upgrade wins the roadmap and first-reset expansion safety remains;
- a reachable non-ready upgrade within the horizon owns the roadmap;
- a multi-hour Alloy upgrade is rejected from the roadmap;
- parallel crafting no longer performs a deep special workshop scan.

Validation, all smoke checks, and all seven 80-tick simulations must pass before
merge and push.

