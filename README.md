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
| **Autopilot: play forward** *(default)* | Turns **on every safe automation**: continuous job rebalancing, building, research, crafting, trade, faith, space, hunting, festivals, and time acceleration. It **auto-tunes every build threshold** (buys the moment something is affordable) and **refines surplus catnip into wood** to break the classic early wood/mineral starvation. You never touch a number. It plays the game for you. |
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
- **🧭 Plan:** the concrete building/research/upgrade target, what is missing, and a compact
  have/need resource sheet.
- **👷 Jobs:** the resources jobs are currently balancing around and the target that caused it.
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

Resource-starvation upgrades are part of that scoring too: if coal is depleted, upgrades
whose names/effects/unlocks help coal or smelters get a large boost, so **Coal Furnace**
can beat a random affordable build and become the active plan. Similar hints exist for
wood, minerals/iron, catnip, science, manpower/hunting, and faith.

## Workshop crafting prerequisites

When the active target needs a crafted resource, the helper now follows the recipe chain
and crafts the missing intermediate instead of waiting forever. For example, if a target
needs **gear**, and you have enough ingredients to make **steel**, it will craft steel
from iron + coal, then craft the higher-level item when possible. The same recipe-chain
logic feeds job balancing, so missing steel pushes work toward the raw inputs behind it
(coal/geologists and minerals/iron support) instead of treating steel as an impossible
resource.

## Jobs & hunting (managed for you)

The helper takes over **job rebalancing** and **hunting** directly (KS's own versions are
turned off so they don't fight it):

- **All non-engineer kittens are rebalanced continuously**, not just idle kittens. If science
  is capped, scholars are moved away; if faith is capped, priests are moved away; if the
  current target mostly needs wood, workers move toward the best wood route. You'll see
  `👷 rebalanced` lines in the log.
- **Pathway math:** when wood is short it compares *woodcutter* (direct wood) vs
  *farmer* (catnip, which it refines into wood) using live production rates, and picks
  whichever gives more wood per kitten.
- **Hunters** are sent automatically from the real game resource (`manpower`, displayed as
  catpower) once there is enough for at least one hunt and before storage fills, so luxury
  items get replenished instead of wasting capped catpower.

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
package.json                      npm run validate
LICENSE                           MIT (this wrapper). Kitten Scientists is MIT too.
```

## Credits

Built on **[Kitten Scientists](https://github.com/kitten-science/kitten-scientists)**
(MIT) and **[Kittens Game](https://kittensgame.com)** by Nuclear Unicorn. This wrapper is
MIT-licensed.
