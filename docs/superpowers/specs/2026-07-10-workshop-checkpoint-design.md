# Workshop Checkpoint Design

## Problem

On a post-reset save at the kitten cap, the Expansion checkpoint can reserve a
shared crafted resource indefinitely. In the reported state, Mansion reserved
1.62K steel while Steel Saw, Titanium Barns, and Titanium Warehouses were fully
affordable. Expansion is a structural layer, so the upgrades' higher live scores
could not influence the decision and the parallel worker correctly refused to
violate the Mansion reservation.

## Decision

Add a narrow `Workshop checkpoint` immediately before post-reset expansion.
When expansion has a candidate, compare it with the highest-scoring fully
affordable workshop upgrade. The upgrade wins only when:

- the save has prior-reset evidence;
- the upgrade is open, reachable, and affordable now;
- it is not purchase-benched; and
- its live score beats the expansion candidate by the existing material-switch
  threshold of 25%.

The first-reset 130-kitten milestone remains absolute. Power recovery,
converter-fuel recovery, manual queue work, and stage rebuilds also retain their
existing higher priority.

## Planner and UI behavior

The selected upgrade becomes the active target under a new `Workshop checkpoint`
layer. Its normal target ledger reserves its complete bill, and the ordinary
executor purchases it through the official workshop controller. Diagnostics
explain that a ready upgrade is being taken before further population growth and
show the deferred expansion candidate.

If no upgrade clears every gate, selection is unchanged and Expansion proceeds.
No reservation is bypassed and no background purchase is added.

## Verification

Add a smoke regression modeled on the live state: prior-reset evidence, a full
village, an expansion candidate needing steel, and a higher-scoring affordable
upgrade sharing that steel. Assert that the Workshop checkpoint selects the
upgrade. Add the inverse assertion that a fresh save still selects the first-reset
expansion milestone. Run validation, smoke tests, and all simulations.

