# Save safety and continuing an existing game

## Where the save lives

Kittens Game saves browser progress in `localStorage` for `kittensgame.com`. The commonly used save key is:

```text
com.nuclearunicorn.kittengame.savedata
```

That means there is no separate online account for this helper to log into. The userscript works because it runs in the same browser page that already contains your save.

## Back up before automation

Before enabling any reset or prestige automation:

1. Open Kittens Game.
2. Go to **Options**.
3. Click **Export**.
4. Copy the exported save string somewhere safe.

If automation makes a decision you dislike, you can use **Import** to restore the backup string.

## Why reset automation is disabled by default

Kitten Scientists can automate chronosphere/prestige/reset decisions. Those actions may be correct for a speedrun or long-term strategy, but they can look like lost progress if thresholds are wrong for your current save. Since this repository cannot see your live game, both profiles deliberately set:

```json
{ "timeControl": { "reset": { "enabled": false } } }
```

After backing up, you can opt into reset automation manually inside the Kitten Scientists UI and tune thresholds for your actual stage of the game.
