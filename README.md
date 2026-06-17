# 🐱 Kittens Game Helper

One-click **autopilot** for [Kittens Game](https://kittensgame.com/web/) that runs in
your browser, **continues the save you already have**, and shows you what to build or
research next.

It is **self-contained**: it reads and drives the game's own API (`window.gamePage`)
directly — there is no third-party automation library to install, load, or fight. The
helper owns every decision that spends resources for the active plan (builds, research,
workshop/religion upgrades, space programs, time structures, crafting, trade, diplomacy,
jobs, hunting, festivals and star events) and runs them all from **one tick loop** that
consults a single reservation, so nothing ever undercuts the plan. Prestige **resets**
stay off so your progress is never wiped.

> **Why not machine learning?** Kittens Game is deterministic and already "solved" by
> well-known heuristics. There is no published ML/RL bot for it, and a rule-based tool
> beats ML here — it would be slower, harder, and worse. So this uses a transparent,
> rule-based decision engine instead.

## Quick start (about 2 minutes)

1. **Back up your save first.** In the game: **Options → Export**, and copy the text
   somewhere safe. (Automation changes your real save; this is your undo.)
2. Install a userscript manager: **[Tampermonkey](https://www.tampermonkey.net/)**
   (Chrome/Edge/Firefox/Safari).
3. Install this script: open
   [`src/kittens-game-helper.user.js`](src/kittens-game-helper.user.js) → click **Raw**
   → Tampermonkey offers to install it → **Install**.
   (Or open Tampermonkey → *Create a new script*, paste the file contents, save.)
   There is **nothing else to install** — the helper has no external dependency.
4. Open / refresh **<https://kittensgame.com/web/>**.
5. A 🐱 **Kittens Helper** box appears bottom-right. It already started on **Autopilot**.

That's it — it plays in the same browser tab where your save lives. There is no account
to log into; the game is stored locally in your browser.

## What it does

The helper picks a plan, **reserves the resources the plan needs**, buys the plan the
moment it's affordable via the game's own button controllers, and spends only true
surplus on everything else. Because the helper is the *only* thing spending, active-plan
inputs can never be silently converted into side crafts such as Metal Plate, or traded
away — every spender (planner, crafting, trade, diplomacy) checks the same reservation
first. It also **refines surplus catnip into wood** to break the classic early
wood/mineral starvation. You never touch a number.

The first thing it does on load is set the game's **no-confirm** option, so automation is
never blocked by a pop-up dialog. It keeps prestige **resets OFF**, plus every other
irreversible / resource-burning action (transcend, sacrifice unicorns/alicorns, time-skip,
shatter time crystals): those are filtered out of every candidate and trade list, so the
helper *continues* your game and can never reset it behind your back.

## What the panel shows

The bottom-right box is a live dashboard:

- **Helper:** `running ✓` — the helper's own tick loop is alive (heartbeat); the title
  also shows the installed version.
- **⚖ Bottleneck:** the thing currently holding you back — a *capped* resource being
  wasted (e.g. `science capped — build more storage`) or a *starved* one
  (e.g. `wood starved (refining catnip)`).
- **🔬 Next science:** the next tech to aim for and what you still need for it.
- **🧭 Plan:** the concrete building/research/upgrade target, what is missing, a rough ETA
  until it should be affordable, and a compact have/need resource sheet.
- **👷 Jobs:** the resources jobs are currently balancing around and the target that caused it.
- **🛒 Buy:** what the purchase loop is doing — `saving for Library (reserving Wood)` while
  the plan accumulates, or the last surplus purchase it allowed.
- **🛡 Reserve:** what resources are currently held for the plan (or for explorers).
- **👑 Leader:** the currently selected leader trait/kitten chosen for the active bottleneck.
- **🧰 Craft:** prerequisite crafting plus overflow conversions that prevent near-capped inputs from being wasted.
- **☀ Religion / 🤝 Diplomacy:** what praise/upgrades and trade/explorers/embassies are doing.
- **🎯 Now:** what it can build/buy right this second.
- **Recent actions:** a running log of what it actually built / researched / upgraded /
  traded / praised, kept across the session so you can see it working.

## One autopilot — no modes

There are **no goal modes or priority dropdowns**. A single autopilot always picks the
most valuable reachable step from one universal scoring framework (see below), keeps the
whole economy alive, and chases gateway techs on its own. Nothing to configure.

## Manual build queue (override the autopilot)

When you want something specific built next — a Magneto, a workshop upgrade, a particular
tech — add it to the **manual build queue** in the panel:

- Pick it from the **“Add to build queue…”** dropdown (it lists the buildings, research
  and upgrades currently open) and press **＋ Queue**.
- The queue shows your items with **▲ / ▼** to reorder and **✕** to remove. It's saved
  between sessions.
- The front-most **actionable** queued item becomes the plan and overrides the autopilot
  (even an in-progress research sprint). The helper reserves its resources, crafts its
  chain, and buys it the moment it's affordable.
- A queued item that can't be acted on yet (still locked, or its science price can't fit
  your cap) is **skipped**, not stalled — the next workable item, or the autopilot, takes
  over. Finished items drop off automatically.

So the autopilot handles the steady grind, and the queue is your steering wheel for
anything you want prioritised.

## Minimal UI

The helper bar header has one button:

- **– / +** — minimizes the helper bar down to just its title, and restores it. The
  choice is remembered between sessions.

## Plans that push through (reservation-backed execution)

The old failure mode: the panel says *“Plan: build Library”*, wood accumulates… and a
Mine gets built instead, because every automated buyer purchased whatever became
affordable first. That cannot happen here:

1. The helper is the **only** actor that spends resources. It buys buildings, research,
   workshop/religion upgrades, space programs and time structures itself, through the
   game's own button controllers (exactly like a hand-click).
2. The helper picks the most **valuable** reachable step as the plan — not the cheapest
   ready one — using one universal scoring framework: each candidate's *parsed metadata
   effects* (`woodPerTick`, `scienceMax`, `maxKittens`, …) are priced against the current
   economy (production weighted by scarcity, storage by live pressure, plus unlocks, goal
   alignment, and a spend-before-store bonus for research that drains an almost-full
   science bank), minus how long it would take to afford. There are no per-item keyword
   lists; every weight lives in one `TUNING` table.
3. While the plan is unaffordable, its costs (and the raw chain behind crafted costs) are
   **reserved**. Crafting, trade and surplus purchases are allowed only from the surplus
   that doesn't dip into the reservation. The 🛒/🛡 lines show what's being held.
4. The moment the plan is affordable, the helper buys it itself (🎯 in the log) and moves
   on. Purchases that keep failing get benched for a while so the plan never wedges on a
   broken button.
5. The plan stays locked until it completes, becomes storage-blocked, or a rival is *much*
   better — ordinary score wobble no longer flips it.

Storage-blocked targets still redirect into storage: if **Theology** needs more science
than your science cap, Libraries/Academies/Observatories get boosted until the cap can
actually hold the price, and the ⚖/🧭 lines say so.

### Research sprints (persistent unlock contracts)

A research that needs a multi-tick **craft chain** — e.g. Acoustics ← Compendium ←
Manuscript ← Parchment ← Furs — becomes an *active research sprint*: a contract that owns
the plan until the tech is researched or genuinely hard-blocked.

- A sprint can **start** from capped/near-capped science *or* any clear actionable
  research chain; once started, science being below cap (which is *expected* — crafting
  Compendium spends it) **never** cancels it.
- While a sprint is valid, long projects (Temple, religion, ziggurat, space/time) are
  **deferred** and may not reserve the chain's resources (no more "craft Manuscript for
  Temple" while Acoustics is open).
- A research whose **final** science price exceeds your science cap (e.g. Electricity at
  71.25K with a 60.27K cap) is **storage-blocked** — it informs the storage layer but can
  never become the active craft target.
- Jobs follow the chain: **Hunters** for furs/parchment/compendium, scholars only when a
  science refill below cap is the real bottleneck, priests suppressed unless faith is
  capped or the tech costs faith, farmers at the catnip safety floor only. The compact
  panel shows `🎯 Focus / Layer: Research sprint / Need`; the protected chain, deferrals
  and job drivers live under **More automation details**.

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
  holds enough catpower back that it can never starve "Send explorers." If titanium is
  the bottleneck, the helper follows the live game flow: craft the first ship, reveal
  hidden Zebras with explorers, then run a reserved direct Zebra trade fallback for
  titanium before spending on slower side goals. Embassies keep being built from each
  race's live prices.

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

## One coherent plan: what it shows is what it does

Every subsystem is subordinate to the **one locked plan**, so the panel never says one
thing while the bot does another. When the plan is blocked on a resource, the helper
resolves the prerequisite the right way and the display names that exact sub-action:

- **Craftable** (compendium ← manuscript ← parchment ← furs): it drives the whole craft
  chain toward the plan, and the plan's chain takes priority over the idle luxury reserve
  so it can't stall waiting on a happiness cushion (the catnip *starvation* reserve is
  never touched).
- **Produced by a building** (a Calciner needs oil → it builds the **Oil Well first**, then
  the Calciner becomes reachable). Any unlocked producer of a needed, un-craftable resource
  is built before the thing that needs it.
- **From trade** (titanium ← Zebra trades): the ship → explorer → Zebra-trade route runs
  **only while the locked plan actually needs titanium** — never just because titanium is
  low or some far-off candidate uses it. With an unrelated plan, no Zebra trading happens
  and no "titanium path" is shown.

The late game is covered by the same engine: **space programs** and **Chronoforge / Void
structures** are scored, reserved for, and bought through the game's own controllers, just
like bonfire buildings — so the planner doesn't go blank after Rocketry.

## Policies: automatic where safe, yours where permanent

Policies with an empty `blocks` list can never lock anything out — the helper buys those
automatically (📜 in the log). **Mutually exclusive** policies (Liberty vs Tradition,
Monarchy vs Republic vs Autocracy…) are permanent strategy choices, so they stay manual:
the panel lists the pending exclusive choices with pros/cons and a **Policy** button, and
nothing is applied until you pick.

## Workshop crafting prerequisites and overflow control

When the active target needs a crafted resource, the helper follows the recipe chain and
crafts the missing intermediate instead of waiting forever. For example, if a target
needs **gear**, and you have enough ingredients to make **steel**, it will craft steel
from iron + coal, then craft the higher-level item when possible. The same recipe-chain
logic feeds job balancing, so missing steel pushes work toward the raw inputs behind it
(coal/geologists and minerals/iron support) instead of treating steel as impossible.

It also watches resource storage pressure. If there is **no active reserve**, hot inputs
can be converted into useful workshop goods such as beams, slabs, plates, steel, gears,
parchment, manuscripts, compendiums, or blueprints. If a plan is actively saving, overflow
is narrowed to target-chain crafts (plus safe catnip→wood support), and every craft only
ever consumes the surplus above the reservation floor — so unrelated Metal Plate or slab
conversion can never steal the run-up to the focused build/research.

## Native trade, religion, festivals and star events

Everything Kitten Scientists used to cover is now done directly through the game's API:

- **Trade.** When catpower is near its cap (and would otherwise be wasted), nothing is
  reserved, and the explorer path isn't saving catpower, the helper trades with the
  partner whose goods you most need room for — `diplomacy.tradeAll(race)`. The Zebra →
  titanium route keeps its dedicated ship/explorer/trade logic.
- **Religion.** Faith-priced religion upgrades are planned and bought like anything else;
  **Praise the Sun** fires (converting the faith bank to worship) only when faith is near
  its cap *and* no faith upgrade is still being saved for, so it never burns the bank an
  upgrade needs.
- **Festivals.** Once Drama & Poetry is researched, the helper holds a festival
  (`village.holdFestival`) when it's affordable, its inputs aren't reserved, and the
  current festival is nearly over — doubling birth rate and lifting happiness.
- **Star events.** Astronomical events are claimed the instant they appear
  (`calendar.observeHandler`) for free science and starcharts.

## Leader selection & promotions

The helper elects a leader when the village has eligible kittens, picking the trait that
best matches the current bottleneck: scientists for science-heavy research, metallurgists
for steel/gear/plate paths, chemists for concrete/kerosene/thorium paths, engineers for
general crafting, managers when hunting and happiness are lagging, merchants for
trade-heavy work, and wise kittens for faith/religion pressure.

Promotions cost gold, so they are gated on **overflowing gold only**: when gold sits above
~92% of its cap (where income is about to be wasted at the cap), the helper promotes
kittens (🎖 in the log). Gold below that band is left alone for trade and gold-priced
buildings.

## Jobs & hunting (managed for you)

- **All non-engineer kittens are rebalanced continuously**, not just idle kittens. Which
  resource each job produces is discovered from the game's own job metadata, so new jobs
  are managed automatically. If a job's output bank is essentially full its workers move
  away; if the current target mostly needs wood, workers move toward the best wood route.
- **Lookahead demand:** jobs don't serve only the single locked plan. The next few
  runner-up candidates contribute a smaller share of demand, so science keeps flowing
  for the next tech while wood gathers for the current build.
- **Pathway math:** when wood is short it compares *woodcutter* (direct wood) vs *farmer*
  (catnip, which it refines into wood) using live production rates, and picks whichever
  gives more wood per kitten.
- **Starvation guard:** the helper watches the *net* catnip rate (the game's own number,
  which includes kitten demand, seasons and weather). The moment catnip goes net-negative
  with the pantry draining — hello, winter — farmers are reinforced before anyone starves.
- **Luxury-aware hunting:** hunters are valued as an economic production boost, not just a
  capped-resource dump. If furs/ivory/spice are low or village happiness is below normal,
  the helper staffs hunters and hunts earlier to refill luxuries and recover the global
  mood multiplier; if luxuries are healthy, it falls back to hunting before catpower
  storage fills.

## If nothing seems to move

- Check the **Helper:** line in the box — it should say **running ✓**.
- Read the **⚖ Bottleneck** line — it names the exact resource holding you back and what
  the helper is doing about it.
- The helper buys **as soon as affordable** and refines surplus catnip into wood, so there
  are no thresholds to tune.

## Turning on resets later (advanced, optional)

Resets trade your current run for permanent bonuses (Paragon/Karma). This **wipes the
current game**, so it is intentionally never automated here — reset/transcend/sacrifice/
time-skip actions are filtered out of every decision the helper makes. If you want a
reset after you've **exported a backup**, do it yourself in the game's **Time Control**
tab.

## Files

```
src/kittens-game-helper.user.js   The userscript (the whole thing; no dependencies)
scripts/validate.mjs              Sanity check: parses, is fully native (no KS), reset-safe
scripts/smoke.mjs                 Behavioral test: runs the script against a mocked game and
                                  proves the plan reserves & pushes through, gateway techs win,
                                  policies split auto/manual, leader/promotions/jobs fire, and
                                  the native praise/festival/trade/observe subsystems work
scripts/simulate.mjs              Multi-scenario harness (npm run simulate): drives the bot
                                  through early / mid / titanium-trap / titanium-needed /
                                  craft-chain / oil-well-producer / late-game-space states and
                                  asserts progress, plan↔action coherence, no off-plan titanium,
                                  and that prerequisite chains (craft, produce, trade) are driven
package.json                      npm test (validate + smoke + simulate)
LICENSE                           MIT
```

## Credits

For **[Kittens Game](https://kittensgame.com)** by Nuclear Unicorn. This helper began as a
wrapper around **[Kitten Scientists](https://github.com/kitten-science/kitten-scientists)**
(MIT) and owes its early design to it; it is now fully self-contained and drives the game's
native API directly. MIT-licensed.
