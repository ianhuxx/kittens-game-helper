# Strategy notes

Kittens Game automation is best treated as deterministic rule-based optimization rather than machine learning. The game state is visible, resource caps are explicit, and strong community automation already exists in Kitten Scientists.

## Practical profile split

### Assisted

Use this for an existing save you want to protect. It starts the engine and enables safe time controls, but keeps time skips and resets conservative/off so you can still decide when to spend rare resources or prestige.

### Autonomous

Use this when you want the tab to keep playing with less intervention. It lowers the engine interval and enables safe time-skip automation, but it still does not enable reset automation. Treat reset automation as a separate opt-in after exporting a backup.

## When to manually intervene

Even with automation, check in before:

- First time entering major new systems such as religion, space, time, or relics.
- Spending rare resources with opportunity costs.
- Any reset/prestige decision.
- Changing Kitten Scientists stock thresholds.

## Why not ML

Machine-learning automation is not a good fit for this helper:

- A browser userscript needs to be lightweight and transparent.
- The game is mostly deterministic and already has well-understood heuristics.
- Training would require many simulated games or risky live-game exploration.
- Rule-based automation is easier to inspect, tune, and disable.

Kitten Scientists already encodes the kind of strategy that would otherwise have to be rediscovered by an ML agent.
