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
3. Install this script: open the
   [direct raw userscript](https://raw.githubusercontent.com/ianhuxx/kittens-game-helper/main/src/kittens-game-helper.user.js)
   → Tampermonkey offers to install/update it → **Install** or **Update**.
   If an older pasted copy is still installed, replace it once with the raw link above
   so Tampermonkey can track future updates.
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

The helper does not change the game's global confirmation setting. Every mutation goes
through a semantic action broker: ordinary purchases/trades/crafts are safe repeatable
actions, rare-capital spends receive extra floors, and unknown actions fail closed.
**World reset, challenge reset, time skip and time-crystal shattering are always
forbidden.** Transcend, Adore and alicorn sacrifice are separate, explicitly armed
prestige actions with the safeguards described below. The repeatable **unicorn→tears
sacrifice** remains a bounded ziggurat-planner conversion and never touches alicorns.

## Late-game autonomy and safety (v2.21.0)

Late-game progression uses the same locked target and reservation ledger as the early
game, but plans a dependency **frontier** instead of scoring Space objects in isolation.
A mission or first building that opens a planet/resource/controller wins before another
repeat Accelerator. The plan remains the real destination while **Now** reports its
current prerequisite: Planet Cracker uranium production, Dragon uranium, Lunar Outpost
unobtainium, Moon Base storage, Sunlifter antimatter, Heatsink, or Containment Chamber.
Missions and planet buildings retain their owning planet and native controller; Time
descriptors keep Chronoforge and Void Space on their distinct native controllers.

- **Dragon route:** uranium is reachable through live Dragon trades even before its bar
  is unlocked. If titanium is short, the recursive route first funds Zebra titanium,
  then trades Dragons, then buys the original Space target. The displayed plan never
  changes into a phantom uranium/miner job.
- **Leviathan route:** active Leviathans supply time crystals, relics, sorrow and other
  trade-only capital from live eligibility, chance, seasonal yield and embassy rules.
  A departure invalidates the route immediately. One diplomacy executor owns reveal,
  targeted trade, optional surplus trade and embassy work, with at most one mutation per
  planner tick.
- **Rare-capital floors:** alicorns, time crystals, relics, void, karma and paragon needed
  by the active plan, manual queue, reachable prestige/upgrade roadmap and policy
  reservations are protected. Trades, processors, parallel buys and alicorn batches may
  spend only true surplus above the merged floor.

Prestige automation defaults **OFF**. One deliberate click on **Prestige automation**
stores `kgh.prestigeArmed`; the authorization persists until you disarm it, and disarming
takes effect before the next planner tick. Before every Transcend, Adore or alicorn batch,
the broker must create and verify a fresh native checkpoint, reread live state, recompute
the exact before/after projection, preserve every reservation/protected floor, execute at
most one native public action, verify the measured postcondition, and enter a real-wall-
time cooldown. Transcend must advance exactly one tier while retaining upgrade epiphany;
Adore requires positive projected gain and bounded Solar Revolution recovery; alicorn
sacrifice requires a concrete active time-crystal deficit, no faster passive or Leviathan
route, full-sequence capital/headroom, and executes only one 25-alicorn batch before
replanning. No internal reset helper or raw counter mutation is permitted.

The copied diagnostics report makes these decisions inspectable: nested acquisition
steps and ETAs, selected race/yield/batch/floors, Space predecessor/transit/technology/
upgrade gates, ordinary/ziggurat/transcendence religion, Chronoforge versus Void Space,
prestige projections/blockers/cooldown, processor fuel budgets, and recent measured
actions all appear with the owning subsystem.

Lifecycle, clock and pollution controls are part of the same release:

- Persisted metadata cannot bypass native lifecycle gates. Research waits for the
  Science surface (or Library ×1), workshop upgrades/crafts wait for Workshop ×1, and
  Ziggurat content waits for its technology, resources, source building and native
  reveal. A closing gate releases the plan without benching a purchase.
- Automation timing follows **delivered game ticks**, not a fictional selected speed.
  The report shows requested versus measured speed; cheap action and full planning/
  render lanes never overlap. Ordinary cooldowns scale with delivered progress, while
  irreversible cooldowns and UI feedback remain real wall time.
- Pollution recovery reads the native level, slope, equilibrium, clean-energy share and
  threshold ETA. When pollution is materially worsening it can buy sequestration/clean
  power and throttle nonessential polluters while preserving converters required by
  food, power or the active acquisition route. The Pollution diagnostic names top
  contributors, active penalties and the recovery action or blocker.

## What the panel shows

The bottom-right box is a live dashboard, organized into cards (v2.14.0):

- **Plan card** — the concrete target, what is missing, a rough ETA and a compact
  have/need sheet (**🧭 Plan**), what it can do right this second (**🎯 Now**), the
  current **⚖ Bottleneck**, the **🔬 Next science**, and the goal line.
- **Top targets card** — the LIVE score ranking: the plan's top rivals with their
  current scores, per-tick ▲/▼ trend arrows, readiness (`ready`) or ETA, and the
  active plan highlighted — so "why is X the plan?" is answered at a glance.
- **Reset advisor card** — an explicit, color-coded verdict that is always visible
  (see "When should I reset?" below).
- **Manual queue card** — the queue picker (sorted by kind, then name — the list
  never reshuffles while you browse it) and the current queue with reorder/remove.
- **Subsystems & automation details** (collapsed) — one line per subsystem:
  **👷 Jobs**, **🛒 Buy** (`saving for Library (reserving Wood)`), **🛡 Reserve**,
  **👑 Leader**, **🧰 Craft**, **⚙ Processing**, **☀ Religion**, **🦄 Unicorns**,
  **🎉 Festival**, **🤝 Diplomacy**, **📜 Policies**, plus the full details line.
- **Recent actions** — a running log of what it actually built / researched /
  traded / praised, with a **Copy** button that exports a full diagnostics report.

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

## Ziggurat / unicorn economy (v2.11.0)

The unicorn loop — Unicorn Pastures make unicorns, sacrificing 2 500 unicorns at a
Ziggurat yields one tear **per ziggurat built**, and tears (+ivory/gold/megaliths) buy the
ziggurat upgrades (Unicorn Tomb → Ivory Tower → …) that multiply unicorn production and
eventually unlock alicorns — is fully automated:

- Every open step (**buy a pasture**, **each ziggurat upgrade**, **build another
  Ziggurat first**) is ranked in one currency, **unicorn-equivalents**, using live rates:
  a tear costs `2 500 ÷ ziggurats` unicorns, an upgrade's gain is measured against your
  live unicorn income, and the fastest payback wins.
- The **sacrifice is bounded**: it converts exactly the tears deficit of the chosen
  upgrade (whole batches only), never a speculative dump, and it respects every active
  reservation. Nothing else may spend the unicorns being saved for it.
- **When to rush ziggurats:** if one more Ziggurat would cut ≥25 % off the chosen
  upgrade's unicorn bill (tears get cheaper with every ziggurat), the planner builds the
  Ziggurat *before* sacrificing and says so in the 🦄 panel line.
- An upgrade whose first copy **unlocks alicorns** (Ivory Tower) may claim the plan even
  when its payback is slow — it's new content, not just production.
- Queue a specific ziggurat upgrade in the manual build queue and the unicorn sacrifice
  will fund *that* item instead of the planner's pick. Alicorn sacrifice is unrelated:
  it remains off unless prestige automation is deliberately armed and every target,
  checkpoint, route, floor, headroom and cooldown safeguard above passes.

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

Storage-blocked targets redirect only into measured storage: if **Biochemistry** or
**Nuclear Fission** needs more science than the live cap, the helper reads every current
building stage's actual `scienceMax`/usable compendium-cap effect, projects repeated
price-scaled copies through the *whole* deficit, and chooses the fastest full closure.
A Temple qualifies only when its live effects genuinely add usable science storage; a
name, description, or `scienceRatio` production bonus cannot masquerade as cap growth.
**More automation details** lists the alternatives, gain per copy, copies required,
closure percentage, ETA, and why each slower/incomplete option lost.

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
- Shared-bank research is explicitly phased. For **Robotics**, for example, the helper
  may spend/refill science to assemble Blueprints first, then switches to a final-bank
  phase that protects the completed intermediates and accumulates the 140K science
  purchase price. Unrelated crafting, trade, and purchases never gain access to that
  target-owned bank.

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
- **Current building stages are first-class.** A transformed Library is displayed and
  valued as its live **Data Center** stage; the same applies to Broadcast Towers,
  Breweries, and future staged buildings. Labels, effects, prices, counts, and
  processing behavior all come from the active stage.
- **New resource recipes bootstrap themselves.** The unlock watcher includes resources
  and workshop crafts. If live metadata says a hidden building/resource needs the first
  unit of a newly craftable input, a generic Resource bootstrap target makes that unit
  and reveals the downstream content—no per-resource patch is required.
- **Converters are discovered, not listed.** Any owned building that both consumes and
  produces per-tick resources (smelter, calciner, mint, upgraded steamworks, and
  whatever the game adds next) is found from its effects and paused/resumed around the
  plan's reservations.
- **Housing scales with need.** Huts/Log Houses/Mansions are worth little while beds are
  free and surge when population growth is blocked. Before the first reset, full housing
  creates an Expansion checkpoint toward the 130-kitten/Concrete Huts milestone; with
  healthy bed headroom, fast research remains eligible. The reset advisor reports the
  manual reset's marginal karma, paragon efficiency, and observed paragon/day—the helper
  still never clicks reset itself.
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

The late game is covered by the same engine: dependency-aware **Space missions and planet
buildings**, **transcendence upgrades**, and **Chronoforge / Void Space** structures are
gated, scored, reserved for, and bought through their exact native controllers, so the
planner does not go blank after Rocketry.

## Policies: fully automatic — exclusive picks included

Policies with an empty `blocks` list can never lock anything out — the helper buys those
on sight (📜 in the log). **Mutually exclusive** policies (Liberty vs Tradition,
Monarchy vs Republic vs Autocracy…) are auto-adopted too (v2.13.0): the helper ranks each
group's sides with the same effect-based scorer as every other candidate and adopts the
best one itself, logging what it was chosen over. While the pick is still unaffordable,
its culture bill is held in the shared reservation ledger — festivals, embassies and
surplus buys leave that bank alone until the policy lands. The panel still shows the
pending pick with pros/cons, and the **Policy** dropdown remains as a manual override;
queueing a policy in the manual build queue pins the choice — the autopilot will never
adopt a rival side that would foreclose your queued pick.

## Workshop crafting prerequisites and overflow control

When the active target needs a crafted resource, the helper follows the recipe chain and
crafts the missing intermediate instead of waiting forever. For example, if a target
needs **gear**, and you have enough ingredients to make **steel**, it will craft steel
from iron + coal, then craft the higher-level item when possible. The same recipe-chain
logic feeds job balancing, so missing steel pushes work toward the raw inputs behind it
(coal/geologists and minerals/iron support) instead of treating steel as impossible.
If a resource is both craftable and directly job-produced, the job path stays primary:
for example a Hut's missing **wood** is displayed and scored as Wood work, while
Refine Catnip remains an optional surplus shortcut rather than turning the whole plan
into a giant catnip target. But when a final price sits **above the resource's storage
cap**, the target is storage-blocked no matter how the resource is produced (v2.14.0):
a capped bank clamps at its cap, so crafting can fill it *to* the cap but never hold
more. The plan releases such a target, remembers not to re-pick it, and grows the cap
(Barn/Warehouse) first — the fix for the post-reset "Library 202/200 wood, plan stuck
forever" stall.

It also watches resource storage pressure. If there is **no active reserve**, hot inputs
can be converted into useful workshop goods such as beams, slabs, plates, steel, gears,
parchment, manuscripts, compendiums, or blueprints. If a plan is actively saving, overflow
is narrowed to target-chain crafts (plus safe catnip→wood support), and every craft only
ever consumes the surplus above the reservation floor — so unrelated Metal Plate or slab
conversion can never steal the run-up to the focused build/research.

## Native trade, religion, festivals and star events

Everything Kitten Scientists used to cover is now done directly through the game's API:

- **Trade.** One diplomacy executor first reveals/prepares the race required by the active
  acquisition route, then funds and executes its bounded targeted trade. Only when no
  active route needs diplomacy inputs may it make a true-surplus trade or buy an embassy.
  Dragon, Zebra and Leviathan steps therefore share one owner and one reservation ledger.
- **Religion.** Faith-priced religion upgrades are planned and bought like anything else;
  **Praise the Sun** fires (converting the faith bank to worship) only when faith is near
  its cap *and* no faith upgrade is still being saved for, so it never burns the bank an
  upgrade needs.
- **Festivals.** Once Drama & Poetry is researched, Festival maintenance becomes a
  visible economic layer. It reads the live price, housing headroom and happiness payoff,
  holds/refills the festival when the return is worthwhile, and defers whenever even one
  input is protected by the active reservation.
- **Star events.** Astronomical events are claimed the instant they appear
  (`calendar.observeHandler`) for free science and starcharts.

## Safe building stage changes

Unlocked upgrades and downgrades are evaluated as real transactions, not free label
swaps. Before using the game's own staging controller, the helper calculates the 50%
sale refund, any refund lost to storage overflow, the price-scaled target-stage rebuild,
the copy count required to restore current economic utility, temporary downtime cost,
energy/consumption penalties, cap safety, and opportunity-cost-adjusted payback. A change
must be materially better and repay within the planning horizon. After the switch, the
rebuild is an atomic reservation-backed continuation until effect parity is restored;
then a cooldown prevents upgrade/downgrade oscillation. Stage changes remain reversible
transactions; forbidden reset/shatter/time-skip actions never enter this path.

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
  gives more wood per kitten. The dependency planner feeds this comparison a real Wood
  need, not the Refine Catnip recipe, so large Hut/Log House deficits don't accidentally
  rebalance the village into all-farmer refine mode.
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

## When should I reset? (the Reset advisor card)

Resets trade your current run for permanent bonuses (Paragon/Karma). The panel's
**Reset advisor card** (v2.14.0) is always visible and gives one explicit, color-coded
verdict instead of a stat line you had to decode:

- **Do NOT reset** (gray) — below 35 kittens nothing is banked at all.
- **Too early** (gray) — 35–69 kittens bank a little karma but zero paragon; the
  headline shows exactly what a reset now would bank.
- **First reset target** (amber) — before your first reset, aim for **130+ kittens with
  Concrete Huts** (live progress shown, e.g. `100/130`): that banks ~60 paragon, enough
  for Diplomacy + the first price-ratio metaphysics next run.
- **Keep pushing** (green) — kitten arrivals are still healthy; the card shows the live
  paragon/day and what a reset now would bank anyway.
- **Reset is beneficial NOW** (red) — paragon/day has flattened (arrivals no longer keep
  up), so banking and restarting compounds faster than continuing this run.

The world reset itself is intentionally **never automated**, regardless of the advisor or
prestige arm. Challenge reset, time skip and time-crystal shattering are equally
forbidden. The prestige arm authorizes only the guarded Transcend, Adore and target-bound
alicorn policies described above. When the card says GO and you have **exported a
backup**, perform the world reset yourself in the game's **Time Control** tab.

## Files

```
src/kittens-game-helper.user.js   The userscript (the whole thing; no dependencies)
scripts/validate.mjs              Sanity check: parses, is fully native (no KS), reset-safe
scripts/smoke.mjs                 Behavioral test: runs the script against a mocked game and
                                  proves the plan reserves & pushes through, gateway techs win,
                                  policies auto-adopt (exclusive picks ranked, pending bill
                                  reserved), leader/promotions/jobs fire, and
                                  the native praise/festival/trade/observe subsystems work
scripts/simulate.mjs              Multi-scenario harness (npm run simulate): drives the bot
                                  through early / mid / titanium-trap / titanium-needed /
                                  craft-chain / lifecycle / pollution plus Dragon uranium,
                                  uranium→unobtainium, antimatter/containment, Leviathan
                                  departure, Transcendence, armed prestige and Void Space;
                                  asserts progressed state and visible plan/action explanations
package.json                      npm test (validate + smoke + simulate)
LICENSE                           MIT
```

## Credits

For **[Kittens Game](https://kittensgame.com)** by Nuclear Unicorn. This helper began as a
wrapper around **[Kitten Scientists](https://github.com/kitten-science/kitten-scientists)**
(MIT) and owes its early design to it; it is now fully self-contained and drives the game's
native API directly. MIT-licensed.
