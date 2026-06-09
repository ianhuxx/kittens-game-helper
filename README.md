# Kittens Game Helper

A small Tampermonkey helper for running [Kitten Scientists](https://github.com/kitten-science/kitten-scientists) against an existing [Kittens Game](https://kittensgame.com/web/) browser save.

The helper does **not** create a new save and does **not** log into an online account. Kittens Game stores progress in the browser tab's `localStorage`, and this userscript runs in that same tab. When you open `kittensgame.com`, Kitten Scientists loads, the selected helper profile is applied, and automation continues from the game state already present in your browser.

## What this gives you

- **Assisted profile (default):** starts the automation engine, keeps prestige/reset automation off, and is intended for a save you already care about.
- **Autonomous profile:** more hands-off time-control settings, still with reset automation off by default for safety.
- **In-game switcher:** a small bottom-right panel lets you switch between Assisted and Autonomous.
- **Pinned engine:** the helper loads Kitten Scientists `v2.0.0-beta.11` so the settings API and profile behavior are predictable.

## Safety first

Prestige/reset automation can intentionally wipe current-run progress for long-term gain. Because this repository cannot inspect or validate your live save, both shipped profiles keep `timeControl.reset.enabled` set to `false`. If you later want true reset automation, export a backup first and then configure reset thresholds inside Kitten Scientists itself.

See [the install guide](docs/install.md) and [save safety notes](docs/save-safety.md) before using the autonomous profile.
