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
  // Recursive prerequisite planning: gateway techs and goal frontiers.
  "gatewayValue",
  "frontierFor",
  "goalFrontierNames",
  // Policies: non-exclusive auto-buy; exclusive (blocks-list) stays manual.
  "policyIsExclusive",
  "autoPolicyChoice",
  // Village care that must stay wired in.
  "maybePromoteKittens",
  "resetTickCache",
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
