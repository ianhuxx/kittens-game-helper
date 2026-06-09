# Install guide

## Fast path

1. Export a backup from Kittens Game: **Options** → **Export**.
2. Install Tampermonkey.
3. Paste [`../src/kittens-game-helper.user.js`](../src/kittens-game-helper.user.js) into a new Tampermonkey script.
4. Save it.
5. Refresh `https://kittensgame.com/web/`.

You should see the normal Kitten Scientists UI plus a tiny **Kittens Helper** profile picker in the bottom-right corner.

## Profiles

- **Assisted: no resets** is the default. Use it when you want automation but still want control over big decisions.
- **Autonomous: safe** runs the automation loop faster and enables safe time-skip automation. It still keeps reset automation off.

The selected profile is stored in browser `localStorage` under `kgh.profile` and is applied every time the page loads.

## Why this continues your current save

Kittens Game stores browser saves in `localStorage` on `kittensgame.com`. This helper runs inside that same page, so Kitten Scientists acts on the game that is already loaded. There is no separate account login or save import step.
