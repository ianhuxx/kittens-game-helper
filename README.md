# Kittens Game Helper

Minimal Tampermonkey helper for running [Kitten Scientists](https://github.com/kitten-science/kitten-scientists) on your existing [Kittens Game](https://kittensgame.com/web/) browser save.

## Quick start

1. **Back up your save first:** Kittens Game → **Options** → **Export** → copy the save string somewhere safe.
2. Install **Tampermonkey** in your browser.
3. Create a new Tampermonkey script and paste in [`src/kittens-game-helper.user.js`](src/kittens-game-helper.user.js).
4. Open or refresh `https://kittensgame.com/web/`.
5. Use the small **Kittens Helper** picker in the bottom-right corner:
   - **Assisted: no resets** = default, safest, keeps major decisions in your control.
   - **Autonomous: safe** = more hands-off, but still does **not** automate resets.

That is the whole setup. Your current game is picked up automatically because the userscript runs in the same browser tab where Kittens Game already stores your save.

## What it does

- Loads the pinned Kitten Scientists release `v2.0.0-beta.11`.
- Waits for `window.kittenScientists` to be ready.
- Applies one small profile patch with `setSettings()`.
- Saves your chosen profile in `localStorage` as `kgh.profile`.
- Keeps `timeControl.reset.enabled` set to `false` in both profiles.

## What it does not do

- It does not create a new save.
- It does not need an online account.
- It does not upload your save anywhere.
- It does not turn on reset/prestige automation by default.

See [`docs/install.md`](docs/install.md) for a slightly longer install guide and [`docs/save-safety.md`](docs/save-safety.md) before enabling any reset automation inside Kitten Scientists.
