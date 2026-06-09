# Kittens Game Helper

Minimal Tampermonkey helper for running [Kitten Scientists](https://github.com/kitten-science/kitten-scientists) on your existing [Kittens Game](https://kittensgame.com/web/) browser save.

## Quick start: simplest possible setup

1. **Back up first:** Kittens Game → **Options** → **Export** → copy the save string somewhere safe.
2. Install **Tampermonkey**.
3. Create a new Tampermonkey script and paste [`src/kittens-game-helper.user.js`](src/kittens-game-helper.user.js).
4. Open or refresh `https://kittensgame.com/web/`.
5. In the bottom-right **Kittens Helper** box, choose **Autonomous: play forward**, then click **Apply**.

That is it. It uses the save already in your browser, so it picks up exactly where you left off.

## If it looks like “nothing is moving”

Use **Autonomous: play forward** and click **Apply**. This version now turns on the parts that actually move the game forward:

- **Village jobs:** assigns free kittens into farmer, woodcutter, scholar, miner, hunter, geologist, priest, and engineer jobs.
- **Hunting:** spends catpower near cap so furs/ivory keep flowing.
- **Bonfire:** builds available buildings when resources are near cap.
- **Science:** observes astronomical events and enables research automation.
- **Workshop:** enables upgrade/crafting automation.
- **Advisor:** shows a plain-English `NOW:` or `NEXT:` line with the nearest build/research/workshop target and what resource is missing.

The game may still pause between purchases if the next thing needs resources. The advisor line is there to answer: “what is it waiting for?”

## Profiles

- **Autonomous: play forward** = recommended for hands-off play. Automates jobs, hunting, safe building, research, workshop upgrades, crafting, observing, and time acceleration.
- **Assisted: jobs + advice** = keeps purchases mostly in your control, but still assigns jobs, hunts near cap, observes events, and tells you the next target.

Both profiles keep `timeControl.reset.enabled` set to `false`. Prestige/reset automation is powerful but can wipe your current run, so only enable it manually inside Kitten Scientists after exporting a backup.

## What it does not do

- It does not create a new save.
- It does not need an online account.
- It does not upload your save anywhere.
- It does not turn on reset/prestige automation by default.

See [`docs/install.md`](docs/install.md) for a slightly longer install guide and [`docs/save-safety.md`](docs/save-safety.md) before enabling any reset automation inside Kitten Scientists.
