// Sanity check for the userscript. Run with: npm run validate
//
// It does not (and cannot) drive a browser. It verifies that:
//   1. the userscript body parses (no syntax errors),
//   2. the bot is fully NATIVE — no Kitten Scientists / external engine,
//   3. every mutation crosses the fail-closed semantic action broker,
//   4. native execution + every smart-play layer is still wired in,
//   5. the three release versions match exactly.

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
  // Boots on the game alone without mutating global confirmation settings.
  "waitForGame",
  "gameReady",
  // Candidate filtering remains defense in depth. The semantic broker is the
  // final fail-closed boundary for safe, rare-capital, prestige, and forbidden
  // actions; alicorn sacrifice is not treated as universally denied.
  "DENY_SUBSTRINGS",
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
  "manageDiplomacy",
  "tradeAll",
  "updateReserveStatus",
  "RELIGION_PRAISE_TRIGGER",
  // Plan execution + the reservation contract every native spender consults.
  "executePlan",
  "gatherCandidates",
  // One recursive acquisition graph owns reachability, nested inputs, ETA,
  // active trade steps, reservations, and bounded execution.
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
  // v2.14.0 — a final price above a CAPPED bank is storage-blocked even when
  // the resource is craftable (banks clamp at their cap): the lock breaks with
  // a cooldown and the storage layer grows the cap instead of re-picking the
  // unattainable target forever (the post-reset Library stall).
  "storage cap blocks the final price",
  "directStorageBlockers",
  // v2.14.0 UI: live top-target ranking with score trends, a stable
  // kind-then-name queue picker, and an explicit reset-advisor verdict card.
  "rankingRows",
  "renderRankingControl",
  "kgh-ranking",
  "queuePickerEntries",
  "QUEUE_KIND_ORDER",
  "resetAdvisorState",
  "kgh-reset-card",
  // Policies: non-exclusive auto-buy on sight; exclusive groups auto-adopt the
  // ranked best side, and the pending pick's bill is culture-chain state held
  // in every reservation ledger while it saves (v2.13.0). A researched side
  // de-facto blocks its rivals; a queued rival is never forced or foreclosed.
  "policyIsExclusive",
  "autoPolicyChoice",
  "bestAdoptableExclusivePolicy",
  "pendingPolicyReservationLedger",
  "policyBlockedByRival",
  "queuedPolicyNames",
  // Diplomacy: explorers/embassies sent from the game's own prices.
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
  "spaceDescriptors",
  "spaceDescriptorFor",
  "spaceNativeAdapter",
  "timeMetas",
  "nativeStackableAdapter",
  "transcendenceNativeAdapter",
  "scaledStackablePrices",
  "VAL_BASED_KINDS",
  "SpaceProgramBtnController",
  "PlanetBuildingBtnController",
  "TranscendenceBtnController",
  // Purchase safety: the raw-metadata buy fallback stays OFF by default; official
  // controller/API purchase only. If it fails, the item is benched, never poked.
  "ALLOW_RAW_METADATA_BUY_FALLBACK = false",
  // Ziggurat / unicorn path (v2.11.0): ziggurat upgrades are first-class
  // candidates, ranked against Unicorn Pastures in unicorn-equivalents, funded
  // by the bounded unicorn→tears sacrifice. Alicorn sacrifice is a distinct
  // rare-capital prestige action, permitted only when persistently armed and
  // freshly checkpointed; the "rush ziggurats" tear-discount rule stays local.
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

// Extract a named const-arrow function without trusting comments or unrelated
// occurrences elsewhere in the file. This is deliberately dependency-free so
// `npm run validate` remains a one-command release gate.
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const matchingDelimiter = (text, start, open, close) => {
  let depth = 0;
  let quote = null;
  let lineComment = false;
  let blockComment = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") { blockComment = false; index += 1; }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "/" && next === "/") { lineComment = true; index += 1; continue; }
    if (char === "/" && next === "*") { blockComment = true; index += 1; continue; }
    if (char === "'" || char === '"' || char === "`") { quote = char; continue; }
    if (char === open) depth += 1;
    if (char === close && --depth === 0) return index;
  }
  return -1;
};

const expressionEnd = (text, start) => {
  const stack = [];
  const pairs = { "(": ")", "[": "]", "{": "}" };
  let quote = null;
  let lineComment = false;
  let blockComment = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") { blockComment = false; index += 1; }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "/" && next === "/") { lineComment = true; index += 1; continue; }
    if (char === "/" && next === "*") { blockComment = true; index += 1; continue; }
    if (char === "'" || char === '"' || char === "`") { quote = char; continue; }
    if (pairs[char]) stack.push(pairs[char]);
    else if (stack.length && char === stack[stack.length - 1]) stack.pop();
    else if (char === ";" && stack.length === 0) return index;
  }
  return -1;
};

const maskNoise = (text, maskStrings) => {
  // Regex/string indices are UTF-16 code-unit offsets. split("") preserves
  // those offsets across emoji; spread syntax would collapse each surrogate
  // pair and point later definition matches at the wrong raw-source position.
  const out = text.split("");
  const regexPrefixKeywords = new Set(["await", "case", "delete", "do", "else", "in", "instanceof", "new", "of", "return", "throw", "typeof", "void", "yield"]);
  const regexCanStartAt = (index) => {
    let cursor = index - 1;
    while (cursor >= 0 && /\s/.test(out[cursor])) cursor -= 1;
    if (cursor < 0) return true;
    if (/[({[=,:;!?&|+*%^~<>-]/.test(out[cursor])) return true;
    if (!/[A-Za-z0-9_$]/.test(out[cursor])) return false;
    const end = cursor + 1;
    while (cursor >= 0 && /[A-Za-z0-9_$]/.test(out[cursor])) cursor -= 1;
    return regexPrefixKeywords.has(out.slice(cursor + 1, end).join(""));
  };
  const modes = [{ type: "code", templateDepth: null }];
  const mask = (index) => {
    if (text[index] !== "\n" && text[index] !== "\r") out[index] = " ";
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    const mode = modes[modes.length - 1];
    if (mode.type === "lineComment") {
      if (char === "\n") modes.pop();
      else mask(index);
      continue;
    }
    if (mode.type === "blockComment") {
      mask(index);
      if (char === "*" && next === "/") { mask(index + 1); modes.pop(); index += 1; }
      continue;
    }
    if (mode.type === "string") {
      if (maskStrings) mask(index);
      if (mode.escaped) mode.escaped = false;
      else if (char === "\\") mode.escaped = true;
      else if (char === mode.quote) modes.pop();
      continue;
    }
    if (mode.type === "template") {
      if (maskStrings) mask(index);
      if (mode.escaped) { mode.escaped = false; continue; }
      if (char === "\\") { mode.escaped = true; continue; }
      if (char === "`") { modes.pop(); continue; }
      if (char === "$" && next === "{") {
        if (maskStrings) mask(index + 1);
        modes.push({ type: "code", templateDepth: 1 });
        index += 1;
      }
      continue;
    }
    if (mode.templateDepth != null) {
      if (char === "{") mode.templateDepth += 1;
      else if (char === "}" && --mode.templateDepth === 0) {
        if (maskStrings) mask(index);
        modes.pop();
        continue;
      }
    }
    if (char === "/" && next === "/") { mask(index); mask(index + 1); modes.push({ type: "lineComment" }); index += 1; continue; }
    if (char === "/" && next === "*") { mask(index); mask(index + 1); modes.push({ type: "blockComment" }); index += 1; continue; }
    if (char === "/" && regexCanStartAt(index)) {
      let regexEscaped = false;
      let inCharacterClass = false;
      if (maskStrings) mask(index);
      for (index += 1; index < text.length; index += 1) {
        const regexChar = text[index];
        if (maskStrings) mask(index);
        if (regexEscaped) { regexEscaped = false; continue; }
        if (regexChar === "\\") { regexEscaped = true; continue; }
        if (regexChar === "[") { inCharacterClass = true; continue; }
        if (regexChar === "]") { inCharacterClass = false; continue; }
        if (regexChar === "/" && !inCharacterClass) {
          while (/[A-Za-z]/.test(text[index + 1] || "")) { index += 1; if (maskStrings) mask(index); }
          break;
        }
      }
      continue;
    }
    if (char === "'" || char === '"') {
      if (maskStrings) mask(index);
      modes.push({ type: "string", quote: char, escaped: false });
      continue;
    }
    if (char === "`") {
      if (maskStrings) mask(index);
      modes.push({ type: "template", escaped: false });
    }
  }
  return out.join("");
};

const functionView = (candidateSource, name) => {
  const code = maskNoise(candidateSource, true);
  const definition = new RegExp(`\\bconst\\s+${escapeRegex(name)}\\s*=`, "g");
  const matches = [...code.matchAll(definition)];
  if (matches.length !== 1) return { error: `${name} must have exactly one const-arrow definition (found ${matches.length})` };
  const definitionStart = matches[0].index;
  const arrow = code.indexOf("=>", definitionStart + matches[0][0].length);
  if (arrow < 0) return { error: `${name} is not an arrow function` };
  let start = arrow + 2;
  while (/\s/.test(candidateSource[start] || "")) start += 1;
  const end = candidateSource[start] === "{"
    ? matchingDelimiter(candidateSource, start, "{", "}")
    : expressionEnd(candidateSource, start);
  if (end < 0) return { error: `${name} body could not be extracted` };
  const raw = candidateSource.slice(start, end + 1);
  return {
    definitionStart,
    start,
    end: end + 1,
    raw,
    code: maskNoise(raw, true),
    uncommented: maskNoise(raw, false),
  };
};

const constBindingView = (candidateSource, name) => {
  const code = maskNoise(candidateSource, true);
  const definition = new RegExp(`\\bconst\\s+${escapeRegex(name)}\\s*=`, "g");
  const matches = [...code.matchAll(definition)];
  if (matches.length !== 1) return { error: `${name} must have exactly one live const binding (found ${matches.length})` };
  const start = matches[0].index;
  const valueStart = start + matches[0][0].length;
  const end = expressionEnd(candidateSource, valueStart);
  if (end < 0) return { error: `${name} binding could not be extracted` };
  return { start, end: end + 1, raw: candidateSource.slice(start, end + 1) };
};

const calls = (view, callee) => !!view && !view.error && new RegExp(`\\b${escapeRegex(callee)}\\s*\\(`).test(view.code);
const memberCalls = (view, owner, method) => !!view && !view.error &&
  new RegExp(`\\b${escapeRegex(owner)}\\s*\\.\\s*${escapeRegex(method)}\\s*\\(`).test(view.code);

const criticalStructureIssues = (candidateSource) => {
  const issues = [];
  const views = new Map();
  const view = (name) => {
    if (!views.has(name)) views.set(name, functionView(candidateSource, name));
    const found = views.get(name);
    if (found.error && !issues.includes(found.error)) issues.push(found.error);
    return found;
  };
  const requireCalls = (owner, callees) => {
    const ownerView = view(owner);
    if (ownerView.error) return;
    for (const callee of callees) {
      if (!calls(ownerView, callee)) issues.push(`${owner} must call ${callee}`);
    }
  };
  const requireText = (owner, pattern, label) => {
    const ownerView = view(owner);
    if (!ownerView.error && !pattern.test(ownerView.uncommented)) issues.push(`${owner} must ${label}`);
  };

  const armBinding = constBindingView(candidateSource, "PRESTIGE_ARM_KEY");
  if (armBinding.error) issues.push(armBinding.error);
  else if (!/\bconst\s+PRESTIGE_ARM_KEY\s*=\s*"kgh\.prestigeArmed"\s*;/.test(armBinding.raw)) {
    issues.push("PRESTIGE_ARM_KEY must bind the persistent kgh.prestigeArmed key");
  }
  const capabilityBinding = constBindingView(candidateSource, "IRREVERSIBLE_EXECUTION_TOKEN");
  if (capabilityBinding.error) issues.push(capabilityBinding.error);

  // All live purchase/trade/explorer/prestige mutation entry points cross the
  // broker. A declaration or a comment elsewhere cannot satisfy this.
  for (const owner of ["buyCandidate", "tradeWithRace", "buyEmbassyForRace", "maybeSendExplorers", "managePrestige"]) {
    requireCalls(owner, ["executeSemanticAction"]);
  }
  requireCalls("executeSemanticAction", ["actionPolicyFor", "prestigeAutomationArmed"]);
  requireCalls("actionPolicyFor", ["isDeniedKey"]);
  const policyView = view("actionPolicyFor");
  if (!policyView.error && !memberCalls(policyView, "ACTION_IDS", "get")) issues.push("actionPolicyFor must read the semantic ACTION_IDS registry");
  requireText("actionPolicyFor", /ACTION_POLICY\s*\.\s*FORBIDDEN/, "fail closed for unknown actions");
  requireText("actionPolicyFor", /ACTION_POLICY\s*\.\s*SAFE_REPEATABLE/, "classify safe repeatable actions");
  requireText("executeSemanticAction", /ACTION_POLICY\s*\.\s*RARE_CAPITAL/, "recognize rare-capital actions as irreversible");
  requireText("executeSemanticAction", /ACTION_POLICY\s*\.\s*AUTHORIZED_PRESTIGE/, "recognize authorized prestige as irreversible");
  requireText("executeSemanticAction", /authorizationToken\s*!==\s*IRREVERSIBLE_EXECUTION_TOKEN/, "require the irreversible authorization token");
  requireText("executeSemanticAction", /checkpointedBefore\s*==\s*null/, "require a fresh checkpoint object");
  requireText("executeSemanticAction", /lastIrreversibleActionAt/, "enforce the irreversible-action cooldown");

  // The policy boundary reads the persistent arm on every decision, and the
  // getter itself must read the dedicated localStorage key.
  const armView = view("prestigeAutomationArmed");
  if (!armView.error && !/localStorage\s*\.\s*getItem\s*\(\s*PRESTIGE_ARM_KEY\s*\)/.test(armView.code)) {
    issues.push("prestigeAutomationArmed must read PRESTIGE_ARM_KEY from localStorage");
  }
  requireCalls("managePrestige", ["prestigeAutomationArmed"]);

  // An irreversible prestige action checkpoints through the native save API,
  // revalidates, and only then enters the semantic broker.
  const prestigeView = view("managePrestige");
  if (!prestigeView.error) {
    const checkpointIndex = prestigeView.code.search(/\bcreateNativeCheckpoint\s*\(/);
    const brokerIndex = prestigeView.code.search(/\bexecuteSemanticAction\s*\(/);
    if (checkpointIndex < 0 || brokerIndex < 0 || checkpointIndex >= brokerIndex) {
      issues.push("managePrestige must checkpoint before broker execution");
    }
    if (!/authorizationToken\s*:\s*IRREVERSIBLE_EXECUTION_TOKEN/.test(prestigeView.code) ||
        !/checkpointedBefore\s*,/.test(prestigeView.code)) {
      issues.push("managePrestige must pass its authorization token and checkpoint snapshot to the broker");
    }
  }
  const checkpointView = view("createNativeCheckpoint");
  if (!checkpointView.error) {
    if (!memberCalls(checkpointView, "game", "save")) issues.push("createNativeCheckpoint must call game.save");
    if (!memberCalls(checkpointView, "game", "_saveDataToString")) issues.push("createNativeCheckpoint must serialize the native save");
    if (!calls(checkpointView, "persistedNativeSaveBlob")) issues.push("createNativeCheckpoint must verify persisted native save data");
  }

  // The acquisition graph is not merely declared: planning/job pressure,
  // diplomacy pressure, reservation policy, and live trade execution consume it.
  requireCalls("resourceNeeds", ["acquisitionPathFor", "actionableTradeRouteFor", "scoreAcquisitionRouteInputs"]);
  requireCalls("diplomacyResourcePressure", ["activeAcquisitionRoute"]);
  requireCalls("acquisitionPathFor", ["acquisitionPathFor"]);
  requireCalls("acquisitionRoutesForTarget", ["acquisitionPathFor"]);
  requireCalls("actionableTradeRouteFor", ["actionableTradeRoutesIn"]);
  requireCalls("scoreAcquisitionRouteInputs", ["scoreAcquisitionRouteInputs"]);
  view("boundedTradeBatch");
  requireCalls("buildReservationLedger", ["buildTargetLedger", "rareCapitalFloor"]);
  requireCalls("reservedNeedsFor", ["buildReservationLedger"]);
  requireCalls("activeAcquisitionRoute", ["acquisitionRoutesForTarget", "actionableTradeRouteFor"]);
  requireCalls("manageDiplomacy", ["buildReservationLedger", "activeAcquisitionRoute", "maybeTradeForTargetChain"]);
  requireCalls("maybeTradeForTargetChain", ["activeAcquisitionRoute", "buildReservationLedger", "boundedTradeBatch", "tradeWithRace"]);

  // Both pricing/discovery and purchase execution normalize Time metadata via
  // timeDescriptorFor before selecting Chronoforge versus Void Space.
  requireText("timeDescriptorFor", /chronoforgeUpgrades[\s\S]*subtype\s*:\s*"chronoforge"/, "normalize Chronoforge membership");
  requireText("timeDescriptorFor", /voidspaceUpgrades[\s\S]*subtype\s*:\s*"voidspace"/, "normalize Void Space membership");
  requireCalls("timeNativeAdapter", ["timeDescriptorFor", "nativeStackableAdapter"]);
  requireText("timeNativeAdapter", /descriptor\s*\.\s*subtype\s*===\s*"voidspace"\s*\?\s*"VoidSpaceBtnController"\s*:\s*"ChronoforgeBtnController"/, "select the normalized pricing controller");
  requireCalls("controllerSpecFor", ["timeDescriptorFor"]);
  requireText("controllerSpecFor", /descriptor\s*\.\s*subtype\s*===\s*"voidspace"\s*\?\s*"VoidSpaceBtnController"\s*:\s*"ChronoforgeBtnController"/, "select the normalized execution controller");
  requireCalls("buyViaGameController", ["controllerSpecFor"]);
  const buyView = view("buyViaGameController");
  if (!buyView.error && !memberCalls(buyView, "controller", "buyItem")) issues.push("buyViaGameController must execute the selected native controller");

  return issues;
};

const actualStructureIssues = criticalStructureIssues(source);
if (actualStructureIssues.length > 0) {
  console.error("Critical structural invariants failed:", actualStructureIssues.join("; "));
  process.exit(1);
}

const rewriteFunction = (candidateSource, owner, rewrite) => {
  const found = functionView(candidateSource, owner);
  if (found.error) return candidateSource;
  const rewritten = rewrite(found.raw);
  if (rewritten === found.raw) return candidateSource;
  return candidateSource.slice(0, found.start) + rewritten + candidateSource.slice(found.end);
};

const disconnectCall = (candidateSource, owner, callee) => rewriteFunction(candidateSource, owner, (raw) => raw.replace(
    new RegExp(`\\b${escapeRegex(callee)}\\s*\\(`, "g"),
    `/* ${callee}( dead/comment-only token ) */ disconnected${callee}(`,
  ));

const structuralSabotageProbes = [
  ["broker call path", "buyCandidate", "executeSemanticAction"],
  ["semantic action policy", "actionPolicyFor", "isDeniedKey"],
  ["persistent arm read", "executeSemanticAction", "prestigeAutomationArmed"],
  ["native prestige checkpoint", "managePrestige", "createNativeCheckpoint"],
  ["recursive acquisition graph", "acquisitionPathFor", "acquisitionPathFor"],
  ["planning acquisition graph", "resourceNeeds", "acquisitionPathFor"],
  ["pressure acquisition graph", "diplomacyResourcePressure", "activeAcquisitionRoute"],
  ["diplomacy acquisition graph", "maybeTradeForTargetChain", "boundedTradeBatch"],
  ["Time pricing normalization", "timeNativeAdapter", "timeDescriptorFor"],
  ["Time execution normalization", "controllerSpecFor", "timeDescriptorFor"],
];
for (const [label, owner, callee] of structuralSabotageProbes) {
  const sabotaged = disconnectCall(source, owner, callee);
  if (sabotaged === source) {
    console.error(`Validator self-test could not create ${label} sabotage.`);
    process.exit(1);
  }
  if (criticalStructureIssues(sabotaged).length === 0) {
    console.error(`Validator self-test: ${label} escaped while its token remained commented/unreferenced.`);
    process.exit(1);
  }
}

const directStructuralSabotages = [
  ["persistent arm-key binding", () => source.replace(
    'const PRESTIGE_ARM_KEY = "kgh.prestigeArmed";',
    'const PRESTIGE_ARM_KEY = "disconnected.prestige.arm"; /* const PRESTIGE_ARM_KEY = "kgh.prestigeArmed"; */',
  )],
  ["persistent arm storage read", () => rewriteFunction(source, "prestigeAutomationArmed", (raw) => raw.replace(
    /localStorage\s*\.\s*getItem\s*\(\s*PRESTIGE_ARM_KEY\s*\)/,
    "/* localStorage.getItem(PRESTIGE_ARM_KEY) */ disconnectedArmRead(PRESTIGE_ARM_KEY)",
  ))],
  ["native checkpoint save", () => rewriteFunction(source, "createNativeCheckpoint", (raw) => raw.replace(
    /\bgame\s*\.\s*save\s*\(/,
    "/* game.save( dead/comment-only token ) */ disconnectedNativeSave(",
  ))],
  ["Time execution controller branch", () => rewriteFunction(source, "controllerSpecFor", (raw) => raw.replace(
    /descriptor\s*\.\s*subtype\s*===\s*"voidspace"\s*\?\s*"VoidSpaceBtnController"\s*:\s*"ChronoforgeBtnController"/,
    '/* descriptor.subtype === "voidspace" ? "VoidSpaceBtnController" : "ChronoforgeBtnController" */ "ChronoforgeBtnController"',
  ))],
];
for (const [label, makeSabotage] of directStructuralSabotages) {
  const sabotaged = makeSabotage();
  if (sabotaged === source) {
    console.error(`Validator self-test could not create ${label} sabotage.`);
    process.exit(1);
  }
  if (criticalStructureIssues(sabotaged).length === 0) {
    console.error(`Validator self-test: ${label} escaped while its token remained commented/unreferenced.`);
    process.exit(1);
  }
}

const definitionDiscoveryFailures = [];
const buyCandidateDefinition = functionView(source, "buyCandidate");
if (buyCandidateDefinition.error) {
  definitionDiscoveryFailures.push("could not locate the live buyCandidate fixture definition");
} else {
  const commentedLiveDefinition = source.slice(0, buyCandidateDefinition.definitionStart) +
    "/* " + source.slice(buyCandidateDefinition.definitionStart, buyCandidateDefinition.end) + " */" +
    source.slice(buyCandidateDefinition.end);
  if (criticalStructureIssues(commentedLiveDefinition).length === 0) {
    definitionDiscoveryFailures.push("entirely commented buyCandidate definition escaped structural validation");
  }
}
const harmlessCommentedDuplicate = `${source}\n/* const buyCandidate = () => false; */`;
if (criticalStructureIssues(harmlessCommentedDuplicate).length > 0) {
  definitionDiscoveryFailures.push("harmless commented buyCandidate duplicate was counted as live");
}
const harmlessDiplomacyDuplicate = `${source}\n/* const manageDiplomacy = () => false; */`;
const liveDiplomacyOwnerCount = (maskNoise(harmlessDiplomacyDuplicate, true).match(/const\s+manageDiplomacy\s*=/g) || []).length;
if (liveDiplomacyOwnerCount !== 1) {
  definitionDiscoveryFailures.push(`harmless commented diplomacy duplicate changed live owner count to ${liveDiplomacyOwnerCount}`);
}
if (definitionDiscoveryFailures.length > 0) {
  console.error("Validator definition-discovery self-tests failed:", definitionDiscoveryFailures.join("; "));
  process.exit(1);
}

// One executor owns all diplomacy mutations. The removed legacy trade loop
// and global no-confirm mutation are architectural regressions, not optional
// implementation details.
const liveSource = maskNoise(source, true);
const diplomacyOwnerDefinitions = liveSource.match(/const\s+manageDiplomacy\s*=/g) || [];
if (diplomacyOwnerDefinitions.length !== 1 || /\bmanageTrade\b/.test(liveSource)) {
  console.error(`Diplomacy ownership invariant failed: owners=${diplomacyOwnerDefinitions.length}, legacy=${/\bmanageTrade\b/.test(liveSource)}.`);
  process.exit(1);
}
if (/opts\.noConfirm\s*=/.test(liveSource)) {
  console.error("Global confirmation settings must not be mutated; irreversible actions belong to the semantic broker.");
  process.exit(1);
}

// Version consistency: @version, HELPER_VERSION and package.json must always
// agree.  Every change is expected to bump the version (see CLAUDE.md), so a
// mismatch here usually means a bump was forgotten in one of the three places.
const metaVersion = (source.match(/@version\s+([0-9]+\.[0-9]+\.[0-9]+)/) || [])[1];
const constVersion = (source.match(/HELPER_VERSION\s*=\s*"([0-9]+\.[0-9]+\.[0-9]+)"/) || [])[1];
const pkg = JSON.parse(await readFile(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));
if (!metaVersion || !constVersion || metaVersion !== constVersion || metaVersion !== pkg.version) {
  console.error(`✗ Version mismatch — @version=${metaVersion}, HELPER_VERSION=${constVersion}, package.json=${pkg.version}; all three release fields require exact parity.`);
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

console.log(`✓ Userscript parses, is fully native, broker-guarded, single-owner diplomacy and normalized late-game adapters are intact, and release version ${pkg.version} matches exactly.`);
