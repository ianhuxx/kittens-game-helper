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
| **Autopilot: play forward** *(default)* | Turns **on every safe automation**: continuous job rebalancing, building, research, crafting, trade, faith, space, hunting, festivals, and time acceleration. It **auto-tunes every build threshold** (buys the moment something is affordable), **plans storage when a target exceeds a resource cap**, **converts about-to-overflow resources into crafted goods**, **elects and promotes the best leader**, and **refines surplus catnip into wood** to break the classic early wood/mineral starvation. You never touch a number. It plays the game for you. |
| **Assist: jobs + advice** | Rebalances jobs, hunts, protects capped resources from overflowing, takes care of the leader and festivals, and watches for star events. **You** decide what to build/research — the advisor line tells you what's next. |

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
- **🧭 Plan:** the concrete building/research/upgrade target, what is missing, and a compact
  have/need resource sheet.
- **👷 Jobs:** the resources jobs are currently balancing around and the target that caused it.
- **😊 Mood / 👑 Leader:** current village happiness (the global production multiplier), who
  leads with which trait/rank, and whether a festival is running.
- **🎯 Now:** what it can build/buy right this second.
- **Recent actions:** a running log of what it actually built / researched / upgraded,
  kept across the session so you can see it working.

## Pick a goal

The second dropdown steers the advisor toward a target you choose — **Balanced**,
**Rush Space**, **Max production**, or **Max population**. It adds a **🏁 goal line**
showing progress to that milestone (e.g. *Rush Space → Rocketry locked, researching
toward it*), prioritises goal-relevant research in **🔬 Next science**, and highlights
goal buildings in **🎯 Now**. Autopilot still grows the whole economy so you never stall
waiting on a single branch.

## Minimal UI

The helper bar has two buttons in its header:

- **Show KS / Hide KS** — hides the big Kitten Scientists settings panel for a clean,
  minimal screen (automation keeps running). It's **hidden by default**; click **Show KS**
  any time you want to tweak KS directly.
- **– / +** — minimizes the helper bar down to just its title, and restores it.

Both choices are remembered between sessions.

## Smarter target choice

The helper no longer blindly chases the next visible button. It scores research, workshop
upgrades, and buildings together, with extra priority for automation/unlock steps,
production scale, resource-fixing workshop upgrades, storage when resources are capping,
and population growth. That means it can choose to scale first when growth is better long-term, rush science/automation when
that unlocks the next important branch, or prioritize an upgrade like **Coal Furnace**
when coal production is the thing blocking progress.

Scoring reads the **actual effect tables** of buildings and upgrades (production per tick,
ratio bonuses, storage maxes, happiness), not just their names, and prefers steps that
**unlock more of the tech tree** and that are **affordable soonest** at current production
rates. Resource-starvation upgrades are part of that scoring too: if coal is depleted,
upgrades whose names/effects/unlocks help coal or smelters get a large boost, so
**Coal Furnace** can beat a random affordable build and become the active plan. Similar
hints exist for wood, minerals/iron, catnip, science, manpower/hunting, and faith.

## Storage-aware planning (no more impossible targets)

A target that costs **more than a resource cap** (say, a tech needing 9,000 science when
your cap is 6,000) can *never* be afforded by waiting — only by building storage. The
helper now detects exactly this: cap-blocked candidates step aside as the active plan,
and everything that **raises the blocking cap** (barns, warehouses, harbors, libraries,
Expanded Barns-style upgrades — found via their real `…Max`/ratio effects) gets a large
scoring boost scaled by how close the cap is to the requirement. The ⚖ bottleneck line
tells you when this happens: `science cap 6.00K blocks the plan — building storage`.
Jobs feel it too: a cap-blocked plan adds weight to wood/minerals so the storage
buildings actually get built.

## Overflow protection (capped production is never wasted)

Production into a full storage bin evaporates. Before that happens (at ~93% of cap), the
helper converts the excess into **uncapped crafted goods** that future builds need
anyway: wood→beams, minerals→slabs, iron→plates, coal→steel, titanium→alloy,
oil→kerosene, uranium→thorium, unobtainium→eludium, culture→manuscripts,
science→compendia and surplus furs→parchment. Reserves keep it safe: it never converts
what the **active target** is saving up for, never drags a secondary ingredient below
40% of its cap, keeps festival parchment and a luxury cushion (furs/ivory/spice are
happiness!), and stops at 85% so there is always liquid stock. Converting capped science
into compendia even **raises the science cap**, turning waste into permanent storage.

## Workshop crafting prerequisites

When the active target needs a crafted resource, the helper now follows the recipe chain
and crafts the missing intermediate instead of waiting forever. For example, if a target
needs **gear**, and you have enough ingredients to make **steel**, it will craft steel
from iron + coal, then craft the higher-level item when possible. Crafting is
**partial-fill**: if inputs only cover a third of the deficit right now, it crafts that
third instead of stalling until everything fits at once. The same recipe-chain
logic feeds job balancing, so missing steel pushes work toward the raw inputs behind it
(coal/geologists and minerals/iron support) instead of treating steel as an impossible
resource.

## Mood & leaders (managed for you)

Happiness is a **global production multiplier**, so the helper works it actively:

- **Luxury-aware hunting** keeps furs/ivory stocked (each unique luxury is +10%
  happiness), and overflow crafting never drains the luxury cushion.
- **Festivals**: Kitten Scientists holds them, and the helper carries a backup that
  pays the real cost (1,500 catpower, 5,000 culture, 2,500 parchment) and starts one
  whenever none is running and the resources are comfortably there.
- **Happiness buildings** (amphitheatres, broadcast towers, sun-altar style effects) get
  a scoring boost whenever village mood is below 100%.
- **Leader election**: it scans every kitten's trait and elects the best one for the
  current phase — *scientist* while research dominates, *engineer* once steel-era
  crafting takes over, with *merchant/manager/metallurgist/chemist/wise* scored by how
  much you trade, hunt, smelt, refine oil, or push faith. Re-elections only happen for a
  clearly better kitten (no churn), and it respects the Anarchy challenge.
- **Promotions on overflowing gold**: when gold sits above ~92% of its cap (where income
  is about to be wasted), the helper promotes kittens — converting dead gold into
  permanently better workers. Kitten Scientists' own elect/promote automations are kept
  off so the two systems never fight.

## Jobs & hunting (managed for you)

The helper takes over **job rebalancing** and **hunting** directly (KS's own versions are
turned off so they don't fight it):

- **All non-engineer kittens are rebalanced continuously**, not just idle kittens. If science
  is capped, scholars are moved away; if faith is capped, priests are moved away; if the
  current target mostly needs wood, workers move toward the best wood route. You'll see
  `👷 rebalanced` lines in the log.
- **Starvation guard:** the helper watches the *net* catnip rate (the game's own number,
  which includes kitten demand, seasons and weather). The moment catnip goes net-negative
  with the pantry draining — hello, winter — farmers are reinforced before anyone starves,
  instead of reacting only after stocks are nearly empty.
- **Pathway math:** when wood is short it compares *woodcutter* (direct wood) vs
  *farmer* (catnip, which it refines into wood) using live production rates, and picks
  whichever gives more wood per kitten.
- **Luxury-aware hunting:** the helper now values hunters as an economic production boost,
  not just a capped-resource dump. If furs/ivory/spice are low or village happiness is
  below normal, it assigns settlement kittens to hunters so they generate catpower for
  hunts, then hunts earlier to refill luxuries and recover the global mood multiplier.
  If luxuries are healthy, it falls back to the old anti-waste rule and hunts before
  catpower storage fills.

## If the helper disappears after reinstalling

Version **0.10.2** fixes a userscript syntax conflict that could stop the entire
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
                                  game and asserts overflow crafting, festivals,
                                  leader election, promotions, cap-aware planning,
                                  job balancing and the starvation guard all fire
package.json                      npm test (validate + smoke)
LICENSE                           MIT (this wrapper). Kitten Scientists is MIT too.
```

## Credits

Built on **[Kitten Scientists](https://github.com/kitten-science/kitten-scientists)**
(MIT) and **[Kittens Game](https://kittensgame.com)** by Nuclear Unicorn. This wrapper is
MIT-licensed.
