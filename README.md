# 🐱 Kittens Game Helper

One-click **autopilot** for [Kittens Game](https://kittensgame.com/web/) that runs in
your browser, **continues the save you already have**, and shows you what to build or
research next.

It is a thin wrapper around [**Kitten Scientists**](https://github.com/kitten-science/kitten-scientists)
(KS) — the proven, open-source automation engine for this game. This project doesn't
re-invent the automation; it loads KS, turns on every **safe** automation for you, and
keeps the dangerous stuff (prestige **resets**) off so your progress is never wiped.

> **Why not machine learning?** Kittens Game is deterministic and already "solved" by
> well-known heuristics. There is no published ML/RL bot for it, and rule-based tools
> like KS beat ML here. ML would be slower, harder, and worse — so this uses the proven
> rule-based engine instead.

## Quick start (about 2 minutes)

1. **Back up your save first.** In the game: **Options → Export**, and copy the text
   somewhere safe. (Automation changes your real save; this is your undo.)
2. Install a userscript manager: **[Tampermonkey](https://www.tampermonkey.net/)**
   (Chrome/Edge/Firefox/Safari).
3. Install this script: open
   [`src/kittens-game-helper.user.js`](src/kittens-game-helper.user.js) → click **Raw**
   → Tampermonkey offers to install it → **Install**.
   (Or open Tampermonkey → *Create a new script*, paste the file contents, save.)
4. Open / refresh **<https://kittensgame.com/web/>**.
5. A 🐱 **Kittens Helper** box appears bottom-right. It already started on
   **Autopilot**. To switch modes, pick one and click **Apply**.

That's it — it plays in the same browser tab where your save lives. There is no account
to log into; the game is stored locally in your browser.

## The two modes

| Mode | What it does |
| --- | --- |
| **Autopilot: play forward** *(default)* | The helper picks a plan, **reserves the resources the plan needs**, buys the plan the moment it's affordable, and spends only true surplus on everything else. Kitten Scientists keeps running crafting, trade, faith, space, festivals and time acceleration; the helper runs jobs, hunting, leader/promotions, policies (non-exclusive only) and all building/research/upgrade purchases. It also **refines surplus catnip into wood** to break the classic early wood/mineral starvation. You never touch a number. |
| **Assist: jobs + advice** | Only rebalances jobs, hunts, holds festivals and watches for star events. **You** decide what to build/research — the advisor line tells you what's next. |

**Both modes keep prestige resets OFF**, plus other irreversible/resource-burning
actions (transcend, sacrifice unicorns/alicorns, time-skip, shatter time crystals).
So it always *continues* your existing game — it will never reset it behind your back.

## What the panel shows

The bottom-right box is a live dashboard:

- **KS engine:** `running ✓` / `stopped` — confirms automation is actually ticking.
- **⚖ Bottleneck:** the thing currently holding you back — a *capped* resource being
  wasted (e.g. `science capped — build more storage`) or a *starved* one
  (e.g. `wood starved (refining catnip)`).
- **🔬 Next science:** the next tech to aim for and what you still need for it.
- **🧭 Plan:** the concrete building/research/upgrade target, what is missing, a rough ETA
  until it should be affordable, and a compact have/need resource sheet.
- **👷 Jobs:** the resources jobs are currently balancing around and the target that caused it.
- **🛒 Buy:** what the purchase loop is doing — `saving for Library (reserving Wood)` while
  the plan accumulates, or the last surplus purchase it allowed.
- **👑 Leader:** the currently selected leader trait/kitten chosen for the active bottleneck.
- **🧰 Craft:** prerequisite crafting plus overflow conversions that prevent near-capped inputs from being wasted.
- **🎯 Now:** what it can build/buy right this second.
- **Recent actions:** a running log of what it actually built / researched / upgraded,
  kept across the session so you can see it working.

## Pick a goal

The second dropdown steers the planner toward a destination you choose. A goal is one
of two shapes — and neither relies on keyword lists; relevance is computed from live
game data:

- **Milestone goals** (e.g. **Reach Space — race to Rocketry**) name a target tech. The
  planner walks the tech tree, treats every unresearched prerequisite as goal-relevant,
  and the **🏁 goal line** shows honest progress: `4/9 techs (44%) · next: Astronomy
  (need 12.00K science)`. Anything that produces or stores a resource the next goal
  techs still need also gets pulled forward.
- **Emphasis goals** (**Industry — max resource production**, **Population — more
  kittens, happier kittens**) multiply effect *categories*. Each candidate's parsed
  effects are matched against the emphasis — a building with production effects counts
  for Industry whatever it's called — and the goal line says what's being favored.

**Balanced** (the default) grows everything and still chases gateway techs. Whatever the
goal, autopilot keeps the whole economy alive so you never stall on a single branch.

## Minimal UI

The helper bar has two buttons in its header:

- **Show KS / Hide KS** — hides the big Kitten Scientists settings panel for a clean,
  minimal screen (automation keeps running). It's **hidden by default**; click **Show KS**
  any time you want to tweak KS directly.
- **– / +** — minimizes the helper bar down to just its title, and restores it.

Both choices are remembered between sessions.

## Plans that push through (reservation-backed execution)

The old failure mode: the panel says *“Plan: build Library”*, wood accumulates… and a
Mine gets built instead, because every automated buyer purchased whatever became
affordable first. That cannot happen anymore:

1. Kitten Scientists' bonfire/science/workshop-upgrade buyers are **switched off** —
   the helper is the only thing buying buildings, research and workshop upgrades.
   (KS keeps crafting, trade, religion, space, time and festivals.)
2. The helper picks the most **valuable** reachable step as the plan — not the
   cheapest ready one — using one universal scoring framework: each candidate's
   *parsed metadata effects* (`woodPerTick`, `scienceMax`, `maxKittens`, …) are priced
   against the current economy (production weighted by scarcity, storage by live
   pressure, plus unlocks, goal alignment, and a spend-before-store bonus for research
   that drains an almost-full science bank), minus how long it would take to afford.
   There are no per-item keyword lists; every weight lives in one `TUNING` table.
3. While the plan is unaffordable, its costs (and the raw chain behind crafted
   costs) are **reserved**. Other purchases are allowed only from surplus that
   doesn't dip into the reservation. The 🛒 line shows `saving for … (reserving …)`.
4. The moment the plan is affordable, the helper buys it itself (🎯 in the log) and
   moves on. Purchases that keep failing get benched for a while so the plan never
   wedges on a broken button.
5. The plan stays locked until it completes, becomes storage-blocked, or a rival is
   *much* better — ordinary score wobble no longer flips it.

Storage-blocked targets still redirect into storage: if **Theology** needs more science
than your science cap, Libraries/Academies/Observatories get boosted until the cap can
actually hold the price, and the ⚖/🧭 lines say so.

## New content is handled automatically

Nothing in the planner is a name list, so new game content never needs a code change:

- **New unlocks break the lock.** Every tick the helper diffs the set of available
  buildings, techs, workshop upgrades and religion items. When something new opens up
  (Mint, Mansion, Observatory, a fresh tech branch…) it logs `🆕 unlocked: … — replanning`,
  drops the current target lock so the newcomer competes immediately, and gives the new
  item a short scoring boost so it gets a fair evaluation instead of waiting behind an
  old plan.
- **Live effects, not metadata placeholders.** Buildings whose real numbers only exist
  in their `calculateEffects` (the Observatory's science bonus, the Mint's output) are
  refreshed before scoring, so they are valued for what they actually do.
- **Converters are discovered, not listed.** Any owned building that both consumes and
  produces per-tick resources (smelter, calciner, mint, upgraded steamworks, and
  whatever the game adds next) is found from its effects and paused/resumed around the
  plan's reservations.
- **Housing scales with need.** Huts/Log Houses/Mansions are worth little while beds are
  free and surge when population growth is blocked, so housing is built exactly when it
  matters.
- **Exploration runs itself.** The explorer fee is read from the game's own trade tab,
  explorers go out as soon as the fee fits the plan's reservations, and auto-hunting
  holds enough catpower back that it can never starve "Send explorers" (a deadlock in
  older versions). If titanium is the bottleneck, the helper follows the live game flow:
  craft the first ship, reveal hidden Zebras with explorers, then run a reserved direct
  Zebra trade fallback for titanium before spending on slower side goals. Embassies keep
  being built from each race's live prices.

## Recursive prerequisite planning

The tech tree is walked in both directions every tick:

- **Gateway value:** a tech is scored by everything it unlocks, recursively — so
  **Theology** (the whole religion branch) and **Machinery** (Steamworks + key workshop
  upgrades) outrank filler research of the same price, instead of never becoming the
  focus.
- **Goal frontier:** if your chosen goal's milestone (say **Rocketry**) is still locked,
  the helper walks the unlock graph backwards to the unlocked ancestor techs that lead
  to it and boosts exactly those.
- Crafted prerequisites recurse the same way (iron + coal → steel → gear), and jobs are
  pointed at the raw inputs behind the active plan.

## Policies: automatic where safe, yours where permanent

Policies with an empty `blocks` list can never lock anything out — the helper buys those
automatically (📜 in the log). **Mutually exclusive** policies (Liberty vs Tradition,
Monarchy vs Republic vs Autocracy…) are permanent strategy choices, so they stay manual:
the panel lists the pending exclusive choices with pros/cons and a **Policy** button, and
nothing is applied until you pick.

## Workshop crafting prerequisites and overflow control

When the active target needs a crafted resource, the helper follows the recipe chain
and crafts the missing intermediate instead of waiting forever. For example, if a target
needs **gear**, and you have enough ingredients to make **steel**, it will craft steel
from iron + coal, then craft the higher-level item when possible. The same recipe-chain
logic feeds job balancing, so missing steel pushes work toward the raw inputs behind it
(coal/geologists and minerals/iron support) instead of treating steel as an impossible
resource.

It also watches resource storage pressure. If wood, minerals, iron, coal, culture/science
inputs, or other craft inputs are close to capping, it converts a conservative slice into
useful workshop goods such as beams, slabs, plates, steel, gears, parchment, manuscripts,
compediums, or blueprints. It keeps reserves (especially catnip for food and catpower for
hunting) and prefers the craft that helps the current plan, so overflow becomes progress
instead of waste.


## Leader selection & promotions

The helper now elects a leader when the village has eligible kittens. It picks the trait
that best matches the current bottleneck: scientists for science-heavy research,
metallurgists for steel/gear/plate paths, chemists for concrete/kerosene/thorium paths,
engineers for general crafting, managers when hunting and happiness are lagging, merchants
for trade-heavy work, and wise kittens for faith/religion pressure.

Promotions cost gold, so they are gated on **overflowing gold only**: when gold sits above
~92% of its cap (where income is about to be wasted at the cap), the helper promotes
kittens — converting dead gold into permanently better workers (🎖 in the log). Gold below
that band is left alone for trade and gold-priced buildings.

## Jobs & hunting (managed for you)

The helper takes over **job rebalancing** and **hunting** directly (KS's own versions are
turned off so they don't fight it):

- **All non-engineer kittens are rebalanced continuously**, not just idle kittens. Which
  resource each job produces is discovered from the game's own job metadata, so new jobs
  are managed automatically. If a job's output bank is essentially full its workers move
  away; if the current target mostly needs wood, workers move toward the best wood route.
  You'll see `👷 rebalanced` lines in the log with the full managed-job distribution.
- **Lookahead demand:** jobs don't serve only the single locked plan. The next few
  runner-up candidates contribute a smaller share of demand, so science keeps flowing
  for the next tech while wood gathers for the current build — instead of the whole
  village whiplashing between "all scholars" and "all woodcutters".
- **Pathway math:** when wood is short it compares *woodcutter* (direct wood) vs
  *farmer* (catnip, which it refines into wood) using live production rates, and picks
  whichever gives more wood per kitten.
- **Starvation guard:** the helper watches the *net* catnip rate (the game's own number,
  which includes kitten demand, seasons and weather). The moment catnip goes net-negative
  with the pantry draining — hello, winter — farmers are reinforced before anyone starves,
  instead of reacting only after stocks are nearly empty.
- **Luxury-aware hunting:** the helper now values hunters as an economic production boost,
  not just a capped-resource dump. If furs/ivory/spice are low or village happiness is
  below normal, it assigns settlement kittens to hunters so they generate catpower for
  hunts, then hunts earlier to refill luxuries and recover the global mood multiplier.
  If luxuries are healthy, it falls back to the old anti-waste rule and hunts before
  catpower storage fills.

## If the helper disappears after reinstalling

Version **0.10.2** and newer fixes a userscript syntax conflict that could stop the entire
plugin before the 🐱 helper panel was drawn. If the box is missing after an update,
open Tampermonkey and make sure the installed script header shows `@version 0.10.2`
or newer, then refresh the Kittens Game tab.

## If nothing seems to move

- Check the **KS engine:** line in the box — it should say **running ✓**. If it says
  *stopped*, click **Apply**.
- Autopilot auto-sets every build/research **trigger to "as soon as affordable"** and
  refines surplus catnip into wood, so you never tune thresholds. Click **Apply** to re-apply.
- Read the **⚖ Bottleneck** line — it names the exact resource holding you back and what
  the helper is doing about it.

## Turning on resets later (advanced, optional)

Resets trade your current run for permanent bonuses (Paragon/Karma). This **wipes the
current game**, so it's intentionally not automated here. If you want it after you've
**exported a backup**, enable it yourself in **KS → Time Control → Reset** and configure
the thresholds.

## Files

```
src/kittens-game-helper.user.js   The userscript (the whole thing)
scripts/validate.mjs              Sanity check: script parses + reset-safety intact
scripts/smoke.mjs                 Behavioral test: runs the script against a mocked
                                  game and proves the plan reserves resources and
                                  pushes through, gateway techs win, policies split
                                  auto/manual, leader/promotions/jobs fire
package.json                      npm test (validate + smoke)
LICENSE                           MIT (this wrapper). Kitten Scientists is MIT too.
```

## Credits

Built on **[Kitten Scientists](https://github.com/kitten-science/kitten-scientists)**
(MIT) and **[Kittens Game](https://kittensgame.com)** by Nuclear Unicorn. This wrapper is
MIT-licensed.
