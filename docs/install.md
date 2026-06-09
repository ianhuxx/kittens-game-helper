# Install guide

## Fast path

1. In Kittens Game, go to **Options → Export** and copy your save somewhere safe.
2. Install Tampermonkey for your browser.
3. Create a new userscript.
4. Paste the full contents of `src/kittens-game-helper.user.js`.
5. Save the userscript.
6. Open `https://kittensgame.com/web/` or refresh your existing tab.
7. In the **Kittens Helper** box, choose **Autonomous: play forward** and click **Apply**.

The helper runs on the same page as your current browser save, so it continues your existing game.

## What to expect

- Kitten Scientists appears in the page.
- The helper applies the selected profile after Kitten Scientists finishes loading.
- Free kittens get assigned to jobs automatically.
- Catpower gets hunted near cap.
- In Autonomous mode, safe build/research/workshop/craft automations are enabled.
- The helper box shows `NOW:` when something can be bought/researched now, or `NEXT:` plus the missing resource when it is waiting.

## If automation is not moving

1. Confirm Tampermonkey says the userscript is enabled on `kittensgame.com`.
2. Select **Autonomous: play forward**.
3. Click **Apply** again.
4. Read the bottom-right advisor line. If it says `NEXT: ... need wood/minerals/science`, the bot is waiting for resources, not broken.
5. Open the Kitten Scientists section and confirm these sections are enabled: **Village**, **Bonfire**, **Science**, **Workshop**, and **Time Control**.

Do not enable reset/prestige automation until you have exported a backup save.
