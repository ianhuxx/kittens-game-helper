# Strategy notes

This helper intentionally uses Kitten Scientists' rule-based automation instead of ML. The goal is practical forward progress on your existing save.

## Recommended mode

Use **Autonomous: play forward** when you want the game to move without babysitting:

- Jobs are assigned automatically.
- Hunts fire near catpower cap.
- Bonfire buildings are bought near resource cap.
- Science and workshop automation are enabled.
- Crafting is enabled near resource cap.
- Resets stay disabled.

Use **Assisted: jobs + advice** when you want to make the big spending decisions yourself but still want job assignment and an on-screen next-action hint.

## Current-stage advice for the save shown in the screenshot

With 25 kittens around year 61, the immediate bottlenecks are usually storage, science, minerals/iron, and steady job balance. The helper now does three things for that stage:

1. Keeps kittens assigned instead of sitting idle.
2. Hunts when catpower is nearly full.
3. Shows the closest build/research/workshop target and the missing resource.

If the advisor says the next target needs science, you want more scholars/libraries/academies/observatories. If it needs minerals or iron, you want miners/geologists plus mines/quarries/smelters/calciners. If it needs wood, keep woodcutters and build storage/population as it becomes affordable.

## Safety

The helper does not enable reset/prestige automation. Reset automation is a later-game optimization and should only be configured manually after exporting a save backup.
