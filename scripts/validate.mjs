// Sanity check for the userscript. Run with: npm run validate
//
// It does not (and cannot) drive a browser. It verifies that:
//   1. the userscript body parses (no syntax errors),
//   2. the Kitten Scientists @require pin is present,
//   3. the reset-safety denylist is intact (so we never auto-reset a save),
//   4. both profiles still exist,
//   5. the extra smart-play layers remain wired into the panel.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const scriptPath = fileURLToPath(new URL("../src/kittens-game-helper.user.js", import.meta.url));
const source = await readFile(scriptPath, "utf8");

const required = [
  // KS must be pinned so behavior is reproducible.
  "kitten-scientists/releases/download/v2.0.0-beta.11/",
  // Safety: irreversible automations must stay denied.
  "DENY_SUBSTRINGS",
  '"reset"',
  '"transcend"',
  '"sacrifice"',
  // Both profiles must exist.
  "autopilot",
  "assist",
  // The "build as soon as affordable" trigger fix must stay in place.
  "PURCHASE_SECTIONS",
  "setTriggersDeep",
  // Smart-play layers added on top of KS should stay wired in.
  "OVERFLOW_CRAFTS",
  "maybeSelectLeader",
  "kgh-leader",
  "kgh-craft",
  // Ready-now purchases must use the game UI controllers first so workshop
  // upgrades and bonfire buildings behave like hand-clicked buttons.
  "buyViaGameController",
  "UpgradeButtonController",
  "BuildingBtnModernController",
  // The plan should include a rough completion estimate.
  "formatEta",
  "ETA",
  "ticksPerSecond",
  "optimizeProcessing",
  "kgh-processing",
  // Kittens Game intentionally spells this resource ID as compedium.
  "compedium",
  // The helper owns bonfire/science/workshop-upgrade purchasing (KS's buyers
  // are disabled) so the plan can RESERVE resources and push through.
  "takeOverPurchasing",
  "executePlan",
  "reservedNeedsFor",
  "respectsReservations",
  "protectPlanFromExternalSpenders",
  "kgh-external-spenders",
  "kgh-buy",
  // Religion: praise waits for a high faith bank so upgrades get a chance.
  "configureReligionProgression",
  "RELIGION_PRAISE_TRIGGER",
  "reserveFaithForReligionProgression",
  "nextFaithReligionUpgrade",
  "kgh-religion",
  "ReligionBtnController",
  "refreshJobManagementUI",
  "candidate.kind === \"religion\"",
  "culture",
  // Diplomacy: KS usually owns trade, but the helper keeps a direct fallback for
  // explorers and embassies so catpower/culture caps become progress.
  "manageDiplomacy",
  "trackDiplomacyActionDeltas",
  "trackTradeResourceDeltas",
  "maybeSendExplorers",
  "maybeBuildEmbassy",
  "EmbassyButtonController",
  "kgh-diplomacy",
  // Recursive prerequisite planning: gateway techs and goal frontiers.
  "gatewayValue",
  "frontierFor",
  "goalFrontierNames",
  // Universal decision framework: candidates are scored from parsed game
  // metadata (effects) against the current economy — no keyword tables —
  // with every weight centralized in TUNING.
  "TUNING",
  "metaEffectProfile",
  "parseEffectEntry",
  "economicValue",
  "goalAlignmentBoost",
  "spendBonusFor",
  "scarcityWeight",
  // Goal system: tech-tree milestone closures with live progress, or
  // effect-category emphases.
  "goalClosureNames",
  "goalProgress",
  "goalSupportResources",
  "profileMatchesCategory",
  "emphasis",
  // Jobs discover what each job produces from the game's own metadata.
  "jobResourceFor",
  // The Apply button must never wrap its label ("Appl\\ny") — panel buttons
  // are pinned to content size.
  ".kgh-panel button{white-space:nowrap;flex:0 0 auto}",
  // Policies: non-exclusive auto-buy; exclusive (blocks-list) stays manual.
  "policyIsExclusive",
  "autoPolicyChoice",
  // Village care that must stay wired in.
  "maybePromoteKittens",
  "resetTickCache",
  // Calm hunting: chain pressure may not flood hunters at healthy furs/mood.
  "fursHealthy",
  // New-content awareness: fresh unlocks (Mint, Mansion, Observatory, …)
  // break the target lock, get logged and get a short evaluation boost.
  "watchNewUnlocks",
  "noveltyBoostFor",
  "🆕 unlocked",
  // Live effects: calculateEffects-backed numbers (Observatory science) are
  // refreshed before profiling so new unlocks are valued correctly.
  "refreshMetaEffects",
  // Converters are discovered from PerTickCon/Prod effects, not name lists.
  "converterBuildings",
  "PerTick(?:Base|Autoprod|Con|Prod)?",
  // Exploration reads the game's own explorer fee and is never starved by
  // auto-hunting (hunting holds the fee back while a race is discoverable).
  "explorerPrices",
  "hasLockedDiscoverableRace",
  // Housing value scales with how full the village is (Mansion timing).
  "housingSaturation",
];

const missing = required.filter((token) => !source.includes(token));
if (missing.length > 0) {
  console.error("✗ Missing required tokens:", missing.join(", "));
  process.exit(1);
}

// Strip the // ==UserScript== metadata block, then compile the body. Compiling
// (not running) catches syntax errors without needing browser globals.
const body = source.replace(/\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==/, "");
try {
  new vm.Script(body, { filename: "kittens-game-helper.user.js" });
} catch (error) {
  console.error("✗ Userscript failed to parse:", error.message);
  process.exit(1);
}

console.log("✓ Userscript parses, KS is pinned, and reset-safety denylist is intact.");
