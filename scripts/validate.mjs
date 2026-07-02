// Sanity check for the userscript. Run with: npm run validate
//
// It does not (and cannot) drive a browser. It verifies that:
//   1. the userscript body parses (no syntax errors),
//   2. the bot is fully NATIVE — no Kitten Scientists / external engine,
//   3. the reset-safety guard is intact (irreversible actions can't be planned),
//   4. native execution + every smart-play layer is still wired in.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const scriptPath = fileURLToPath(new URL("../src/kittens-game-helper.user.js", import.meta.url));
const source = await readFile(scriptPath, "utf8");
const readmePath = fileURLToPath(new URL("../README.md", import.meta.url));
const readme = await readFile(readmePath, "utf8");
const rawScriptUrl = "https://raw.githubusercontent.com/ianhuxx/kittens-game-helper/main/src/kittens-game-helper.user.js";

// The helper now drives the game's own API directly. None of these may appear:
// any reintroduction of Kitten Scientists or a settings-tree bridge is a
// regression of the native rewrite.
const forbidden = [
  "kittenScientists",
  "kitten-scientists",
  "@require",
  "getSettings",
  "setSettings",
  "_timeoutMainLoop",
];
const leaked = forbidden.filter((token) => source.includes(token));
if (leaked.length > 0) {
  console.error("✗ Native rewrite regressed — found external-engine tokens:", leaked.join(", "));
  process.exit(1);
}

const required = [
  // Boots on the game alone, and suppresses confirm dialogs natively.
  "waitForGame",
  "gameReady",
  "opts.noConfirm",
  // Reset-safety: irreversible actions are filtered OUT of every candidate list.
  "DENY_SUBSTRINGS",
  '"reset"',
  '"transcend"',
  '"sacrifice"',
  "isDeniedKey",
  "!isDeniedKey(c.meta.name)",
  // Autopilot toggle must exist.
  "autopilot",
  // Native execution: purchases go through the game's own button controllers.
  "buyViaGameController",
  "UpgradeButtonController",
  "BuildingBtnModernController",
  "TechButtonController",
  "ReligionBtnController",
  // Native subsystems that replaced KS (praise / stars / festivals / trade) and
  // the reservation status line that replaced the external-spender pauser.
  "managePraise",
  "religion.praise",
  "maybeObserveStars",
  "observeHandler",
  "maybeHoldFestival",
  "holdFestival",
  "manageTrade",
  "tradeAll",
  "updateReserveStatus",
  "RELIGION_PRAISE_TRIGGER",
  // Plan execution + the reservation contract every native spender consults.
  "executePlan",
  "gatherCandidates",
  "reservedNeedsFor",
  "respectsReservations",
  "kgh-reserve",
  "kgh-buy",
  // Persistent research-sprint contracts (v2.1.0 planner restructure): a sprint
  // started by capped/near-cap science OR a clear actionable craft chain, then
  // validated (NOT re-derived) each tick so spending science on Compendium never
  // hands the plan back to Temple / generic scoring.
  "activeSprint",
  "solveCraftChain",
  "planResearchSprint",
  "sprintStillValid",
  "finalScienceFitsCap",
  "researchSprintJobNeeds",
  "Research sprint",
  "STRATEGIC_LAYERS",
  // Science-storage unlock layer: when science is capped and the next valuable
  // tech is storage-blocked, grow science storage (Library/Academy/Observatory)
  // instead of letting Temple / a long project win — goal-INDEPENDENT.
  "Science storage unlock",
  "bestScienceStorageUnlock",
  "scienceStorageUnlockCandidate",
  "SCIENCE_UNLOCK_REACH",
  // Single-autopilot rework: one autopilot + a persistent manual build queue
  // that overrides the planner when its front item is actionable.
  "Manual queue",
  "pickQueuedTarget",
  "renderQueueControl",
  "kgh-queue-list",
  // Socialism (and any other no-op policy) must never influence planning.
  "isNoopPolicyCandidate",
  "isSocialismPolicy",
  // The plan should include a rough completion estimate.
  "formatEta",
  "ETA",
  "ticksPerSecond",
  "optimizeProcessing",
  "kgh-processing",
  // Kittens Game intentionally spells this resource ID as compedium.
  "compedium",
  // Universal decision framework: candidates scored from parsed game metadata
  // (effects) against the current economy — no keyword tables — every weight in TUNING.
  "TUNING",
  "metaEffectProfile",
  "parseEffectEntry",
  "economicValue",
  "goalAlignmentBoost",
  "spendBonusFor",
  "scarcityWeight",
  // Recursive prerequisite planning: gateway techs and goal frontiers.
  "gatewayValue",
  "frontierFor",
  "goalFrontierNames",
  // Goal system: tech-tree milestone closures with live progress, or emphases.
  "goalClosureNames",
  "goalProgress",
  "goalSupportResources",
  "profileMatchesCategory",
  "emphasis",
  // Crafting + overflow control (reservation-aware, our crafter is the only one).
  "OVERFLOW_CRAFTS",
  "craftTowardTarget",
  "craftOverflowResources",
  "kgh-craft",
  // Religion upgrades are planned natively; faith reserve directs priests.
  'candidate.kind === "religion"',
  "nextFaithReligionUpgrade",
  "kgh-religion",
  "culture",
  // Jobs discover what each job produces from the game's own metadata.
  "jobResourceFor",
  "refreshJobManagementUI",
  // Village care that must stay wired in (native village API).
  "maybeSelectLeader",
  "maybePromoteKittens",
  "kgh-leader",
  "resetTickCache",
  // Calm hunting: chain pressure may not flood hunters at healthy furs/mood.
  "fursHealthy",
  // The autopilot toggle button must never wrap its label.
  ".kgh-panel button{white-space:nowrap;flex:0 0 auto}",
  // Policies: non-exclusive auto-buy; exclusive (blocks-list) stays manual.
  "policyIsExclusive",
  "autoPolicyChoice",
  // Diplomacy: explorers/embassies sent from the game's own prices.
  "manageDiplomacy",
  "maybeSendExplorers",
  "maybeBuildEmbassy",
  "EmbassyButtonController",
  "kgh-diplomacy",
  "zebraTitaniumStats",
  "desiredZebraShipCount",
  "shipCraftWouldStealFromActivePlan",
  // New-content awareness: fresh unlocks broke the lock, logged, boosted.
  "watchNewUnlocks",
  "noveltyBoostFor",
  "🆕 unlocked",
  "refreshMetaEffects",
  // Converters discovered from PerTickCon/Prod effects, not name lists.
  "converterBuildings",
  "PerTick(?:Base|Autoprod|Con|Prod)?",
  "explorerPrices",
  "hasLockedDiscoverableRace",
  // Housing value scales with how full the village is (Mansion timing).
  "housingSaturation",
  // Plan ↔ action coherence: the titanium/Zebra path is a SUB-ACTION of the
  // locked plan (fires only when the target needs titanium), and plan-directed
  // crafting uses a relaxed luxury floor so the plan's own chain isn't starved.
  "titaniumNeededSoon",
  "titaniumRouteHint",
  "forPlanChain",
  // Producer prerequisite: build the producer of a needed-but-unproduced,
  // uncraftable resource (Oil Well before a Calciner that needs oil).
  "producerBuildingsFor",
  "productionDemand",
  "producerPrereqBoost",
  // The reservation-backed planner now also covers the late game (space
  // programs + Chronoforge/Void structures), via the game's own controllers.
  "spaceMetas",
  "timeMetas",
  "scaledStackablePrices",
  "VAL_BASED_KINDS",
  "SpaceProgramBtnController",
  "ChronoforgeBtnController",
  // Purchase safety: the raw-metadata buy fallback stays OFF by default; official
  // controller/API purchase only. If it fails, the item is benched, never poked.
  "ALLOW_RAW_METADATA_BUY_FALLBACK = false",
  // Ziggurat / unicorn path (v2.11.0): ziggurat upgrades are first-class
  // candidates, ranked against Unicorn Pastures in unicorn-equivalents, funded
  // by the bounded unicorn→tears sacrifice (the only sacrifice ever performed;
  // alicorn sacrifice stays denied), with the "rush ziggurats" tear-discount rule.
  "zigguratUpgrades",
  "ZigguratBtnController",
  'candidate.kind === "ziggurat"',
  "sacrificeConversionFor",
  "sacrificePotentialFor",
  "unicornEconomyPlan",
  "bestUnicornPathTarget",
  "manageUnicornReligion",
  "unicornPathReservationLedger",
  "UNICORN_ZIG_FIRST_SAVINGS",
  "Ziggurat / unicorn path",
  "kgh-unicorn",
];

const missing = required.filter((token) => !source.includes(token));
if (missing.length > 0) {
  console.error("✗ Missing required tokens:", missing.join(", "));
  process.exit(1);
}

// Version consistency: @version, HELPER_VERSION and package.json must always
// agree.  Every change is expected to bump the version (see CLAUDE.md), so a
// mismatch here usually means a bump was forgotten in one of the three places.
const metaVersion = (source.match(/@version\s+([0-9]+\.[0-9]+\.[0-9]+)/) || [])[1];
const constVersion = (source.match(/HELPER_VERSION\s*=\s*"([0-9]+\.[0-9]+\.[0-9]+)"/) || [])[1];
const pkg = JSON.parse(await readFile(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));
if (!metaVersion || !constVersion || metaVersion !== constVersion || metaVersion !== pkg.version) {
  console.error(`✗ Version mismatch — @version=${metaVersion}, HELPER_VERSION=${constVersion}, package.json=${pkg.version} (all three must match; bump every update).`);
  process.exit(1);
}

const updateUrl = (source.match(/@updateURL\s+(\S+)/) || [])[1];
const downloadUrl = (source.match(/@downloadURL\s+(\S+)/) || [])[1];
if (updateUrl !== rawScriptUrl || downloadUrl !== rawScriptUrl) {
  console.error(`✗ Userscript update metadata must point to ${rawScriptUrl}.`);
  process.exit(1);
}

if (!readme.includes(rawScriptUrl)) {
  console.error(`✗ README install/update steps must include the direct raw userscript URL: ${rawScriptUrl}`);
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

console.log(`✓ Userscript parses, is fully native (no Kitten Scientists), reset-safety guard intact, version ${pkg.version} consistent.`);
