# Install guide

## Prerequisites

1. Use a normal web browser tab at one of the supported Kittens Game URLs:
   - `https://kittensgame.com/web/`
   - `https://kittensgame.com/beta/`
   - `https://kittensgame.com/alpha/`
2. Install a userscript manager such as Tampermonkey.
3. Confirm your current game opens normally before installing automation.

## Install the helper

1. Open `src/kittens-game-helper.user.js` from this repository.
2. Add it as a new userscript in Tampermonkey.
3. Save the userscript.
4. Open or refresh your Kittens Game tab.
5. Wait for the Kitten Scientists panel and the small **Kittens Helper** switcher in the bottom-right corner.

The helper `@require`s the pinned Kitten Scientists userscript from the GitHub release for `v2.0.0-beta.11`. Kitten Scientists starts first; then this helper waits for `window.kittenScientists`, reads its current settings, deep-merges the selected profile patch, and calls `setSettings()`.

## Pick a profile

- Use **Assisted (no resets)** if you want automation while keeping manual control over big decisions.
- Use **Autonomous (safe)** if you want the tab to be more hands-off. This profile enables more time-control automation but still leaves reset automation disabled.

The selected profile is saved in browser `localStorage` under `kgh.profile`, so the same profile is applied next time you open the tab.
