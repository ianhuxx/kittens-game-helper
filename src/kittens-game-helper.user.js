// ==UserScript==
// @name         Kittens Game Helper
// @namespace    https://github.com/ianhuxx/kittens-game-helper
// @version      2.2.0
// @description  Self-contained one-click autopilot for Kittens Game — no external library. It reads and drives the game's own API (window.gamePage) directly: it picks a plan, RESERVES the resources that plan needs so cheaper buys can't eat them, buys the plan the moment it's affordable via the game's own button controllers, and spends only true surplus on everything else. One universal decision framework — every candidate (building, research, workshop/religion upgrade, space program, time structure) is scored by what its parsed game-metadata effects are worth to the CURRENT economy (production vs scarcity, storage vs live pressure, unlocks, goal alignment) minus how long it takes to afford; no per-item keyword lists. Handles crafting, overflow conversion, converter pausing, trade, diplomacy/explorers/embassies, religion praise + upgrades, festivals, star events, lookahead-aware job rebalancing, leader election, gold-overflow promotions and hunting — all natively, as a single source of truth with one tick loop and no settings races. Irreversible actions (prestige reset/transcend/sacrifice/shatter/time-skip) are filtered out of every candidate and trade list, so they can never fire.
// @author       ianhuxx
// @match        https://kittensgame.com/web/*
// @match        https://kittensgame.com/beta/*
// @match        https://kittensgame.com/alpha/*
// @match        https://*.kittensgame.com/*
// @match        http://bloodrizer.ru/games/kittens/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/*
 * Kittens Game Helper — a self-contained autopilot that drives the game's own
 * API directly (no Kitten Scientists, no third-party engine to fight).
 * On every page load it:
 *   1. waits for the game (window.gamePage.resPool + bld),
 *   2. sets gamePage.opts.noConfirm so automation is never blocked by a dialog,
 *   3. runs ONE tick loop that plans, reserves, buys, crafts, trades, manages
 *      jobs/leader/hunting/religion/festivals and claims star events — every
 *      spender consulting the same reservation so they never undercut the plan,
 *   4. keeps irreversible actions out of every candidate/trade list (isDeniedKey),
 *   5. shows a panel: bottleneck, next science, plan, and a live action log.
 */

(function kittensGameHelper() {
  "use strict";

  const STORAGE_KEY = "kgh.autopilot";
  const LOG_KEY = "kgh.log";
  const HELPER_VERSION = "2.2.0";

  // Speedrun helpers are advisory and scoring nudges only: the helper still
  // never clicks reset/transcend/sacrifice/time-skip actions.
  const SPEEDRUN_STATE_PREFIX = "kgh.speedrun.";
  const SPEEDRUN_RUN_START_KEY = SPEEDRUN_STATE_PREFIX + "runStart";
  const SPEEDRUN_PEAK_KITTENS_KEY = SPEEDRUN_STATE_PREFIX + "peakKittens";
  const SPEEDRUN_LAST_RESET_COUNT_KEY = SPEEDRUN_STATE_PREFIX + "lastResetCount";
  const SPEEDRUN_PARAGON_HISTORY_KEY = SPEEDRUN_STATE_PREFIX + "paragonHistory";
  const TARGET_LOCK_MIN_EARLY_MS = 30000;
  const TARGET_LOCK_MIN_MID_MS = 60000;
  const TARGET_LOCK_MIN_LATE_MS = 120000;
  const EARLY_GAME_KITTENS = 30;
  const EARLY_GAME_RESEARCH_COUNT = 8;
  const SPRINT_PROGRESS_THRESHOLD = 0.75;
  const RESET_ADVISOR_MIN_PARAGON_PER_DAY = 8;
  const METAPHYSICS_ORDER = [
    { name: "engineering", cost: 5, label: "Engineering" },
    { name: "goldenRatio", cost: 15, label: "Golden Ratio" },
    { name: "divineProportion", cost: 50, label: "Divine Proportion" },
    { name: "vitruvianFeline", cost: 100, label: "Vitruvian Feline" },
    { name: "renaissance", cost: 750, label: "Renaissance" },
    { name: "chronomancy", cost: 30, label: "Chronomancy chain" },
    { name: "anachronomancy", cost: 375, label: "Anachronomancy chain" },
  ];

  // Irreversible / permanent / resource-burning actions. Matched by name and
  // kept OUT of every candidate and trade list, so the helper can never reset,
  // transcend, sacrifice, shatter time crystals or time-skip. This is the single
  // native safety guard now that there is no external engine to disable.
  const DENY_SUBSTRINGS = ["reset", "transcend", "sacrifice", "shatter", "timeskip"];
  const DENY_EXACT = new Set([
    "adore",
    "policies", // permanent, often exclusive choices — left to the player
  ]);

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Autopilot is the only mode — on by default; the header toggle is a label for
  // the current state. Resets always stay off regardless (see isDeniedKey).
  const isAutopilotOn = () => {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored !== "0";
  };

  // Goals steer the advisor toward a destination you pick (autopilot still
  // grows the whole economy so you never stall). A goal is one of two shapes,
  // and NEITHER uses keyword lists — relevance is computed from game data:
  //  - a MILESTONE goal names a target tech; the planner walks the live tech
  //    tree, pushes every prerequisite, and reports progress as "n/m techs";
  //  - an EMPHASIS goal multiplies effect categories (production, housing,
  //    happiness, …) that are matched against each candidate's parsed effects.
  const GOAL_KEY = "kgh.goal";
  const PRIORITY_KEY = "kgh.priority";
  const DEFAULT_GOAL = "balanced";
  const DEFAULT_PRIORITY = "auto";
  const GOALS = {
    balanced: {
      label: "Balanced — steady all-round growth",
      target: null,
      emphasis: {},
    },
    speedrun: {
      label: "Speedrun — reset-aware expansion",
      target: null,
      emphasis: { housing: 2.5, production: 1.5, science: 1.4, storage: 1.2 },
    },
    space: {
      label: "Reach Space — race to Rocketry",
      target: "rocketry",
      emphasis: { science: 1.5 },
    },
    production: {
      label: "Industry — max resource production",
      target: null,
      emphasis: { production: 1.8, storage: 1.2 },
    },
    population: {
      label: "Population — more kittens, happier kittens",
      target: null,
      emphasis: { housing: 2.2, happiness: 1.6, food: 1.5 },
    },
  };

  const PRIORITIES = {
    auto: { label: "Auto priority — universal scoring" },
    speedrun: { label: "Speedrun: housing > science > production" },
    science: { label: "Manual: science first" },
    workshop: { label: "Manual: workshop upgrades first" },
    bonfire: { label: "Manual: bonfire buildings first" },
    storage: { label: "Manual: storage/caps first" },
    production: { label: "Manual: production first" },
  };

  const getGoal = () => {
    const stored = localStorage.getItem(GOAL_KEY);
    return GOALS[stored] ? stored : DEFAULT_GOAL;
  };

  const getPriority = () => {
    const stored = localStorage.getItem(PRIORITY_KEY);
    return PRIORITIES[stored] ? stored : DEFAULT_PRIORITY;
  };

  /* --------------------------- manual build queue ---------------------------
   * The single autopilot picks the best next action on its own, but the player
   * can force specific buildings / research / workshop upgrades to the FRONT of
   * the plan from the panel.  The queue is an ordered list of { id, val } where
   * id is the planner's own `${kind}:${name}` targetId and val is meta.val at
   * enqueue time, so a building counts as DONE once one more has been built. The
   * planner consumes the front-most ACTIONABLE item (see pickQueuedTarget); a
   * blocked/unreachable item is skipped so a bad pick can never stall the bot.
   */
  const QUEUE_KEY = "kgh.queue";
  const readQueue = () => {
    try {
      const raw = JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]");
      return Array.isArray(raw) ? raw.filter((item) => item && typeof item.id === "string") : [];
    } catch (error) {
      return [];
    }
  };
  const writeQueue = (queue) => {
    try {
      localStorage.setItem(QUEUE_KEY, JSON.stringify(queue.slice(0, 24)));
    } catch (error) {
      /* storage unavailable — queue is best-effort */
    }
  };
  const queueHas = (id) => readQueue().some((item) => item.id === id);
  const queueAdd = (id, val) => {
    if (!id || queueHas(id)) return;
    const queue = readQueue();
    queue.push({ id, val: isFinite(val) ? Number(val) : 0 });
    writeQueue(queue);
  };
  const queueRemove = (id) => writeQueue(readQueue().filter((item) => item.id !== id));
  const queueMove = (id, dir) => {
    const queue = readQueue();
    const i = queue.findIndex((item) => item.id === id);
    if (i < 0) return;
    const j = i + (dir < 0 ? -1 : 1);
    if (j < 0 || j >= queue.length) return;
    const tmp = queue[i];
    queue[i] = queue[j];
    queue[j] = tmp;
    writeQueue(queue);
  };

  const metaText = (meta) => `${meta.name || ""} ${meta.label || ""} ${meta.title || ""}`.toLowerCase();

  /* --------------------------- settings management --------------------------- */

  const isDeniedKey = (key) => {
    if (!key) return false;
    if (DENY_EXACT.has(key)) return true;
    const lower = String(key).toLowerCase();
    return DENY_SUBSTRINGS.some((needle) => lower.includes(needle));
  };

  // Praise the Sun converts the whole faith bank into worship, so we only do it
  // when faith is near its storage cap and no faith-priced upgrade is pending.
  const RELIGION_PRAISE_TRIGGER = 0.95;

  // The helper drives the game's own API directly — there is no external engine
  // to configure, enable or fight. "Applying" the profile just makes sure the
  // game will not pop a confirmation dialog mid-automation (build-all, policy,
  // Adore the Galaxy) and kicks an immediate tick. Irreversible actions
  // (reset/transcend/sacrifice/shatter/timeskip) never enter any candidate or
  // trade list — isDeniedKey() filters them out — so they can never fire.
  const applyProfile = () => {
    try {
      if (window.gamePage && window.gamePage.opts) window.gamePage.opts.noConfirm = true;
    } catch (error) {
      /* a missing opts object just means dialogs stay manual; harmless */
    }
    pushLog(`▶ Autopilot applied — ${isAutopilotOn() ? "ON" : "OFF"}`);
    tick();
  };

  /* ------------------------------ game reading ------------------------------ */

  const fmt = (value) => {
    if (!isFinite(value)) return String(value);
    const abs = Math.abs(value);
    if (abs >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
    if (abs >= 1e3) return `${(value / 1e3).toFixed(2)}K`;
    return `${Math.round(value * 100) / 100}`;
  };

  const readJson = (key, fallback) => {
    try {
      const raw = localStorage.getItem(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch (error) {
      return fallback;
    }
  };

  const writeJson = (key, value) => {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (error) { /* ignore */ }
  };

  const totalKittenCount = () => {
    try { return (window.gamePage.village.sim.kittens || []).length; } catch (error) { return 0; }
  };

  const researchedTechCount = () => {
    try { return (window.gamePage.science.techs || []).filter((tech) => tech && tech.researched).length; } catch (error) { return 0; }
  };

  const isEarlyGame = () => totalKittenCount() < EARLY_GAME_KITTENS && researchedTechCount() < EARLY_GAME_RESEARCH_COUNT;
  const isMidGame = () => totalKittenCount() < 120;
  const speedrunMode = () => getGoal() === "speedrun" || getPriority() === "speedrun";

  const metaphysicsResearched = (name) => {
    try {
      const meta = window.gamePage.science.get(name);
      return !!(meta && meta.researched);
    } catch (error) {
      return false;
    }
  };

  const currentParagon = () => {
    try { return window.gamePage.paragonPoints || 0; } catch (error) { return 0; }
  };

  let resetAdvisorText = "♻ Reset advisor: tracking this run…";

  const computeResetAdvisor = () => {
    try {
      const now = Date.now();
      const resetCount = window.gamePage.totalResets || 0;
      const kittens = totalKittenCount();
      const paragon = currentParagon();
      let runStart = readJson(SPEEDRUN_RUN_START_KEY, now);
      let peakKittens = readJson(SPEEDRUN_PEAK_KITTENS_KEY, kittens);
      let lastResetCount = readJson(SPEEDRUN_LAST_RESET_COUNT_KEY, resetCount);
      const history = readJson(SPEEDRUN_PARAGON_HISTORY_KEY, []);

      if (resetCount !== lastResetCount || kittens < Math.max(5, peakKittens * 0.35)) {
        if (peakKittens >= 35) history.push({ time: now, kittens: peakKittens, paragon });
        runStart = now;
        peakKittens = kittens;
        lastResetCount = resetCount;
        writeJson(SPEEDRUN_PARAGON_HISTORY_KEY, history.slice(-10));
        writeJson(SPEEDRUN_LAST_RESET_COUNT_KEY, lastResetCount);
        pushLog("🔄 new run detected — reset advisor restarted tracking");
      }

      peakKittens = Math.max(peakKittens, kittens);
      writeJson(SPEEDRUN_RUN_START_KEY, runStart);
      writeJson(SPEEDRUN_PEAK_KITTENS_KEY, peakKittens);

      const runDays = Math.max(0.01, (now - runStart) / 86400000);
      const expectedParagon = Math.max(0, kittens - 70);
      const expectedKarma = Math.max(0, kittens - 35);
      const paragonPerDay = expectedParagon / runDays;
      const nextMeta = METAPHYSICS_ORDER.find((item) => !metaphysicsResearched(item.name));
      const metaText = nextMeta
        ? ` · next meta: ${nextMeta.label} (${nextMeta.cost}P${paragon >= nextMeta.cost ? ", affordable" : ""})`
        : " · core metaphysics plan complete";
      const advice = kittens < 70
        ? `push to 70+ kittens (${fmt(expectedKarma)} karma if reset now)`
        : paragonPerDay < RESET_ADVISOR_MIN_PARAGON_PER_DAY
          ? "slow paragon/day — consider a manual reset after checking your save"
          : "healthy paragon/day — keep pushing";
      resetAdvisorText = `♻ Reset: ${kittens} kittens · ${fmt(expectedParagon)}P now · ${fmt(paragonPerDay)}P/day · ${advice}${metaText}`;
    } catch (error) {
      resetAdvisorText = "♻ Reset advisor: unavailable";
    }
  };

  const resourceMap = () => {
    if (tickCache.resources) return tickCache.resources;
    const map = new Map();
    try {
      for (const res of window.gamePage.resPool.resources) {
        map.set(res.name, res);
        if (res.name === "manpower") map.set("catpower", res);
      }
    } catch (error) {
      /* ignore */
    }
    tickCache.resources = map;
    return map;
  };

  const buildingMetas = () => {
    const out = [];
    const bld = window.gamePage && window.gamePage.bld;
    if (!bld) return out;
    try {
      if (Array.isArray(bld.buildingsData)) return bld.buildingsData;
      if (Array.isArray(bld.meta)) {
        for (const group of bld.meta) {
          const arr = group && (group.meta || group);
          if (Array.isArray(arr)) out.push(...arr);
        }
      }
    } catch (error) {
      /* ignore */
    }
    return out;
  };

  // Space programs and Chronoforge/Void structures are stackable buildings of
  // the SAME controller family as bonfire buildings, so the planner treats them
  // as extra "build"-style candidates (kinds "space"/"time"). This is what lets
  // the reservation-backed planner finally cover the late game. Enumerated
  // defensively — these managers are empty until the relevant tech unlocks them.
  const spaceMetas = () => {
    try {
      const space = window.gamePage && window.gamePage.space;
      return Array.isArray(space && space.programs) ? space.programs : [];
    } catch (error) {
      return [];
    }
  };

  const timeMetas = () => {
    const out = [];
    try {
      const time = window.gamePage && window.gamePage.time;
      if (Array.isArray(time && time.chronoforgeUpgrades)) out.push(...time.chronoforgeUpgrades);
      if (Array.isArray(time && time.voidspaceUpgrades)) out.push(...time.voidspaceUpgrades);
    } catch (error) {
      /* ignore */
    }
    return out;
  };

  // Current scaled price of a stackable meta: base × priceRatio^owned. Mirrors
  // BuildingStackableBtnController for planning/affordability; the real buy still
  // goes through the game's own controller (exact discounts) in buyViaGameController.
  const scaledStackablePrices = (meta) => {
    const base = (meta && (meta.prices || meta.price)) || [];
    const ratio = (meta && meta.priceRatio) || 1;
    const owned = (meta && meta.val) || 0;
    if (ratio === 1 || owned === 0 || !base.length) return base;
    const mult = Math.pow(ratio, owned);
    return base.map((price) => ({ name: price.name, val: price.val * mult }));
  };

  // Kinds whose "owned" count is a numeric val (vs a researched flag).
  const VAL_BASED_KINDS = new Set(["build", "space", "time"]);

  // Space/time candidate is open while unlocked and (for one-time missions) not
  // already built; stackable structures stay open.
  const spaceTimeOpen = (meta) =>
    meta && meta.unlocked !== false && meta.researched !== true && !(meta.noStackable && (meta.on || meta.val || 0) >= 1);

  const pricesFor = (kind, meta) => {
    try {
      if (kind === "build" && window.gamePage.bld.getPrices) {
        return window.gamePage.bld.getPrices(meta.name) || meta.prices || [];
      }
      if (kind === "space" || kind === "time") return scaledStackablePrices(meta);
      if ((kind === "research" || kind === "policy") && window.gamePage.science.getPrices) {
        return window.gamePage.science.getPrices(meta) || meta.prices || [];
      }
      if (kind === "upgrade" && window.gamePage.workshop) {
        const workshop = window.gamePage.workshop;
        if (typeof workshop.getPrices === "function") return workshop.getPrices(meta) || meta.prices || [];
        if (typeof workshop.getPrice === "function") return workshop.getPrice(meta) || meta.prices || [];
      }
      if (kind === "religion") return religionUpgradePrices(meta);
    } catch (error) {
      /* ignore */
    }
    return meta.prices || meta.price || [];
  };

  const isOpen = (meta) => meta && meta.unlocked !== false && meta.researched !== true;
  const labelOf = (meta) => meta.label || meta.title || meta.name || "?";

  const evaluate = (kind, meta, resources) => {
    const costs = pricesFor(kind, meta).filter(
      (cost) => cost && cost.name && isFinite(cost.val) && cost.val > 0,
    );
    if (!costs.length) return { affordable: false, progress: 0, missing: "" };
    let affordable = true;
    let progress = 1;
    const missing = [];
    for (const cost of costs) {
      const res = getRes(resources, cost.name);
      const have = (res && res.value) || 0;
      const possible = have + craftablePotential(cost.name);
      progress = Math.min(progress, possible / cost.val);
      if (have < cost.val) {
        affordable = false;
        const cap = liveCapFor(resources, cost.name);
        const storageHint = res && cap > 0 && cost.val > cap && !craftByName(cost.name)
          ? ` (storage cap ${fmt(cap)})`
          : "";
        const craftHint = !storageHint && craftByName(cost.name) ? ` (craft ${craftLabel(cost.name)})` : "";
        missing.push(`${fmt(cost.val - have)} ${(res && res.title) || cost.name}${storageHint || craftHint}`);
      }
    }
    return { affordable, progress, missing: missing.slice(0, 3).join(", ") };
  };

  const religionUpgrades = () => {
    try {
      const religion = window.gamePage && window.gamePage.religion;
      return Array.isArray(religion && religion.religionUpgrades) ? religion.religionUpgrades : [];
    } catch (error) {
      return [];
    }
  };

  const religionWorship = () => {
    try {
      return (window.gamePage && window.gamePage.religion && window.gamePage.religion.faith) || 0;
    } catch (error) {
      return 0;
    }
  };

  const religionUpgradePurchased = (meta) => !!(meta && ((meta.noStackable && (meta.on || meta.val || 0) > 0) || meta.researched));

  const religionUpgradeVisible = (meta) => {
    if (!meta || meta.unlocked === false || religionUpgradePurchased(meta)) return false;
    return !isFinite(meta.faith) || religionWorship() >= meta.faith || (meta.on || 0) > 0;
  };

  const religionUpgradePrices = (meta) => {
    try {
      const game = window.gamePage;
      const Controller = getGlobalPath(["com", "nuclearunicorn", "game", "ui", "ReligionBtnController"]);
      if (game && typeof Controller === "function") {
        const controller = new Controller(game);
        const model = controller.fetchModel({ id: meta.name, controller });
        if (model && typeof controller.getPrices === "function") return controller.getPrices(model) || meta.prices || [];
      }
    } catch (error) {
      /* fall through to raw metadata prices */
    }
    return (meta && (meta.prices || meta.price)) || [];
  };

  const nextFaithReligionUpgrade = (resources) => {
    const faith = getRes(resources, "faith");
    if (!faith) return null;
    const candidates = [];
    for (const meta of religionUpgrades()) {
      if (!religionUpgradeVisible(meta)) continue;
      const prices = religionUpgradePrices(meta);
      const faithPrice = prices.find((price) => price && price.name === "faith" && price.val > 0);
      if (!faithPrice) continue;
      if (faith.maxValue > 0 && faithPrice.val > faith.maxValue) continue;
      const evaluation = evaluate("religion", { ...meta, prices }, resources);
      candidates.push({ meta, faithPrice: faithPrice.val, ...evaluation });
    }
    return candidates
      .filter((candidate) => faith.value < candidate.faithPrice || candidate.affordable)
      .sort((a, b) => {
        if (a.affordable !== b.affordable) return a.affordable ? -1 : 1;
        if (b.progress !== a.progress) return b.progress - a.progress;
        return a.faithPrice - b.faithPrice;
      })[0] || null;
  };

  let diplomacyPrepText = "Diplomacy prep: watching trade unlocks";

  const reservedResourceNames = (target, resources) => Object.keys(reservedNeedsFor(target, resources));

  // Craft-chain reachability: which craft outputs feed the active target. The
  // native overflow crafter uses this so that, during a reserve, only crafts
  // that actually advance the focused plan (plus safe catnip→wood) run, while
  // its own reservation floors keep reserved raw inputs from being consumed.
  const craftChainOutputsFor = (name, out = new Set(), depth = 0) => {
    if (depth > 5 || !name || out.has(name)) return out;
    const craft = craftByName(name);
    if (!craft) return out;
    out.add(name);
    for (const price of craftPricesFor(craft)) {
      if (price && price.name) craftChainOutputsFor(price.name, out, depth + 1);
    }
    return out;
  };

  const targetCraftOutputsFor = (target, resources) => {
    const allowed = new Set();
    if (!target) return allowed;
    for (const cost of pricesFor(target.kind, target.meta)) {
      if (!cost || !cost.name || !isFinite(cost.val) || cost.val <= 0) continue;
      const have = ((getRes(resources || resourceMap(), cost.name) || {}).value) || 0;
      if (have >= cost.val && !craftByName(cost.name)) continue;
      craftChainOutputsFor(cost.name, allowed);
    }
    return allowed;
  };

  const craftOutputHelpsTarget = (target, outputName, resources) => {
    if (!target || !outputName) return false;
    return targetCraftOutputsFor(target, resources).has(outputName);
  };


  const TARGET_TRADE_CHAIN = new Set(["parchment", "manuscript", "compedium", "compendium"]);
  let stickyTargetChainReserve = { until: 0, names: new Set(), label: "" };

  const activeTargetChainResources = (target, resources) => {
    const names = new Set();
    if (!target || target.affordable) return names;
    for (const cost of pricesFor(target.kind, target.meta)) {
      if (!cost || !cost.name || !isFinite(cost.val) || cost.val <= 0) continue;
      const have = ((getRes(resources || resourceMap(), cost.name) || {}).value) || 0;
      if (have >= cost.val) continue;
      if (TARGET_TRADE_CHAIN.has(cost.name)) {
        craftChainOutputsFor(cost.name, names);
        names.add(cost.name);
      }
    }
    return names;
  };

  const refreshStickyTargetChainReserve = (target, resources) => {
    const names = activeTargetChainResources(target, resources);
    if (names.size) {
      stickyTargetChainReserve = { until: Date.now() + 120000, names, label: labelOf(target.meta) };
    }
    return names;
  };

  const stickyReservesResource = (name) => stickyTargetChainReserve.names.has(name) && Date.now() < stickyTargetChainReserve.until;

  // --- native reservation status ---------------------------------------------
  // The helper is now the ONLY actor that spends resources, and every spender it
  // owns (planner, prerequisite/overflow crafting, trade, diplomacy) already
  // consults reservedNeedsFor()/respectsReservations() before spending. There is
  // nothing external left to pause — this line just reports what is reserved.
  let reservePlanText = "Reserve: no active reservation";

  const updateReserveStatus = (resources, goalKey) => {
    try {
      const target = getTargetCached(resources, goalKey);
      const reserved = target && !target.affordable ? reservedResourceNames(target, resources) : [];
      const explorerSave = shouldSaveForExplorers(resources, goalKey);
      if (reserved.length) {
        const shown = reserved.slice(0, 3).map((name) => resTitle(resources, name)).join("+");
        reservePlanText = `Reserve: holding ${shown} for ${labelOf(target.meta)}`;
      } else if (explorerSave) {
        reservePlanText = "Reserve: holding Catpower for explorers";
      } else {
        reservePlanText = "Reserve: no active reservation — surplus free to spend";
      }
    } catch (error) {
      /* ignore reserve-status failures */
    }
  };

  // --- native praise control --------------------------------------------------
  // Praise the Sun is a pure faith→worship conversion (religion.praise()). We
  // fire it directly only when faith is near its cap AND no faith-priced upgrade
  // is still being saved for, so we never spend the bank an upgrade still needs.
  // (Religion *upgrades* themselves are bought by the planner via ReligionBtnController.)
  let religionPlanText = "Religion: watching faith";

  const managePraise = (resources) => {
    try {
      const religion = window.gamePage && window.gamePage.religion;
      if (!religion || typeof religion.praise !== "function") return;
      const next = nextFaithReligionUpgrade(resources);
      if (next) {
        religionPlanText = next.affordable
          ? `Religion: ${labelOf(next.meta)} ready; holding praise until it is bought`
          : `Religion: saving faith for ${labelOf(next.meta)} (${next.missing || "faith needed"})`;
        return; // hold the faith bank for the pending upgrade
      }
      const faith = getRes(resources, "faith");
      if (faith && faith.maxValue > 0 && faith.value / faith.maxValue >= RELIGION_PRAISE_TRIGGER) {
        religion.praise();
        religionPlanText = "Religion: praised the sun (faith → worship)";
        pushLog("☀ praised the sun");
      } else {
        religionPlanText = "Religion: praise waits near cap; no faith upgrade pending";
      }
    } catch (error) {
      /* ignore praise failures */
    }
  };

  // --- native astronomical events --------------------------------------------
  // KS used to claim star events; now we call the game's own observe handler
  // directly the moment one is available (free science + starcharts).
  const maybeObserveStars = () => {
    try {
      const calendar = window.gamePage && window.gamePage.calendar;
      if (!calendar || typeof calendar.observeHandler !== "function") return;
      if ((calendar.observeRemainingTime || 0) > 0) {
        calendar.observeHandler();
        pushLog("🔭 observed an astronomical event (science + starcharts)");
      }
    } catch (error) {
      /* ignore */
    }
  };

  // --- native festivals -------------------------------------------------------
  // Drama & Poetry unlocks festivals (double birth rate + happiness while
  // active). village.holdFestival() sets the duration but does NOT pay, so we
  // pay the exact cost the in-game button charges. Reservation- and waste-aware:
  // never dips into a saving plan, and only refreshes when the current festival
  // is nearly over (with the carnivals perk holdFestival stacks, so this still
  // only spends when the buffer is low).
  const FESTIVAL_COST = [
    { name: "manpower", val: 1500 },
    { name: "culture", val: 5000 },
    { name: "parchment", val: 2500 },
  ];

  const maybeHoldFestival = (resources) => {
    try {
      const game = window.gamePage;
      const village = game && game.village;
      const calendar = game && game.calendar;
      if (!village || !calendar || typeof village.holdFestival !== "function") return;
      const drama = game.science && game.science.get && game.science.get("drama");
      if (!drama || !drama.researched) return;
      if (!FESTIVAL_COST.every((cost) => ((getRes(resources, cost.name) || {}).value || 0) >= cost.val)) return;
      const target = getTargetCached(resources, getGoal());
      const reserved = target && !target.affordable ? reservedNeedsFor(target, resources) : {};
      if (FESTIVAL_COST.some((cost) => (reserved[cost.name] || 0) > 0)) return;
      const buffer = calendar.daysPerSeason || 100;
      if ((calendar.festivalDays || 0) > buffer) return;
      village.holdFestival(1);
      if (game.resPool && typeof game.resPool.addResEvent === "function") {
        for (const cost of FESTIVAL_COST) game.resPool.addResEvent(cost.name, -cost.val);
      }
      pushLog("🎉 held a festival (happiness + birth rate up)");
    } catch (error) {
      /* ignore festival failures */
    }
  };

  // --- native surplus trading -------------------------------------------------
  // KS used to own general trade; now we trade directly. tradeAll() pays its own
  // catpower+gold+goods cost, so this only decides WHEN to trade: when catpower
  // is near its cap (otherwise wasted at the ceiling), nothing is reserved, the
  // explorer/zebra-titanium path isn't saving catpower, and a trade partner
  // actually sells something we still have room to store.
  let lastTradeAt = 0;

  const tradeWantScore = (race, resources) => {
    let score = 0;
    for (const sell of (race && race.sells) || []) {
      if (!sell || !sell.name) continue;
      const res = getRes(resources, sell.name);
      if (!res || res.unlocked === false) continue;
      if (res.maxValue > 0 && res.value / res.maxValue > 0.95) continue; // no room — skip
      const fill = res.maxValue > 0 ? res.value / res.maxValue : 0.5;
      score += (1 - fill) * (sell.value || 1) * (sell.chance ? sell.chance / 100 : 1);
    }
    return score;
  };

  const manageTrade = (resources, goalKey) => {
    try {
      if (Date.now() - lastTradeAt < 12000) return; // pace trading
      const game = window.gamePage;
      const diplomacy = game && game.diplomacy;
      if (!diplomacy || typeof diplomacy.tradeAll !== "function" || typeof diplomacy.getMaxTradeAmt !== "function") return;
      const races = (diplomacy.races || []).filter((race) => race && race.unlocked && !race.collapsed);
      if (!races.length) return;
      const catpower = getRes(resources, "manpower");
      const gold = getRes(resources, "gold");
      if (!catpower || !gold) return;
      const target = getTargetCached(resources, goalKey);
      const reserved = target && !target.affordable ? reservedNeedsFor(target, resources) : {};
      refreshStickyTargetChainReserve(target, resources);
      const targeted = races
        .map((race) => targetTradeScore(race, target, resources, reserved))
        .filter((item) => item && item.score > 0.0005)
        .sort((a, b) => b.score - a.score)[0];
      if (targeted && !shouldSaveForExplorers(resources, goalKey)) {
        const race = targeted.race;
        const measured = withActionResourceDeltas(() => diplomacy.tradeAll(race), tradeDeltaNamesForRace(race, targeted.prices));
        lastTradeAt = Date.now();
        diplomacyPlanText = `Targeted trade: ${race.title || race.name || "partner"} for ${labelOf(target.meta)} Compendium chain`;
        pushLog(`🤝 ${race.title || race.name || "partner"} trade: ${measured.suffix}; reason target-chain ${labelOf(target.meta)}`);
        return;
      }
      if ((reserved.manpower || 0) > 0 || (reserved.gold || 0) > 0) return; // plan owns these
      if (shouldSaveForExplorers(resources, goalKey)) return; // explorers get first call on catpower
      const catpowerHot = catpower.maxValue > 0 && catpower.value / catpower.maxValue > 0.9;
      if (!catpowerHot) return; // only convert near-capped (otherwise-wasted) catpower
      // A trade also pays the race's "buys" goods, so never trade with a partner
      // whose buy good the plan is reserving.
      const buysReserved = (race) => (race.buys || []).some((buy) => buy && (reserved[buy.name] || 0) > 0);
      let best = null;
      let bestScore = 0;
      for (const race of races) {
        if (buysReserved(race)) continue;
        const score = tradeWantScore(race, resources);
        if (score > bestScore && diplomacy.getMaxTradeAmt(race) >= 1) {
          best = race;
          bestScore = score;
        }
      }
      if (best) {
        const measured = withActionResourceDeltas(() => diplomacy.tradeAll(best), tradeDeltaNamesForRace(best));
        lastTradeAt = Date.now();
        pushLog(`🤝 ${best.title || best.name || "partner"} trade: ${measured.suffix}; reason surplus catpower near cap`);
      }
    } catch (error) {
      /* ignore trade failures */
    }
  };

  /* ------------------------------ per-tick cache ----------------------------- */

  // Candidate gathering, target choice and storage-pressure scans are expensive
  // (storage pressure alone walks every meta) and were being recomputed by every
  // consumer each tick — sometimes disagreeing mid-tick. Compute once, share.
  let tickCache = {
    resources: null,
    production: Object.create(null),
    candidates: null,
    target: undefined,
    pressure: null,
    goalFrontier: null,
    goalClosure: null,
    goalSupport: null,
    fxRefreshed: new WeakSet(),
  };

  // Live resource telemetry.  The game API can expose production through
  // several cached fields depending on version/mods, and those fields sometimes
  // lag behind UI/controller updates.  Keep a short rolling observation of the
  // actual resource bars so cap, rate and ETA math can prefer what is happening
  // on the current save over any baked-in assumption.
  const RESOURCE_TELEMETRY_MAX_AGE_MS = 15000;
  const RESOURCE_TELEMETRY_MIN_SPAN_MS = 3500;
  const RESOURCE_TELEMETRY_MAX_SAMPLES = 8;
  const resourceTelemetry = Object.create(null);

  const liveResourceCap = (res) => {
    if (!res) return 0;
    for (const key of ["maxValue", "maxValueCached", "maxValueBase"]) {
      const value = res[key];
      if (isFinite(value) && value > 0) return value;
    }
    return 0;
  };

  const sampleResourceTelemetry = () => {
    const now = Date.now();
    try {
      for (const res of window.gamePage.resPool.resources || []) {
        if (!res || !res.name || !isFinite(res.value)) continue;
        const key = res.name === "catpower" ? "manpower" : res.name;
        const entry = resourceTelemetry[key] || (resourceTelemetry[key] = { samples: [] });
        entry.cap = liveResourceCap(res);
        entry.title = res.title || res.name;
        entry.samples.push({ t: now, value: res.value, cap: entry.cap });
        while (entry.samples.length > RESOURCE_TELEMETRY_MAX_SAMPLES) entry.samples.shift();
        while (entry.samples.length > 1 && now - entry.samples[0].t > RESOURCE_TELEMETRY_MAX_AGE_MS) entry.samples.shift();
      }
    } catch (error) {
      /* the game is still booting */
    }
  };

  const observedProductionFor = (name) => {
    const entry = resourceTelemetry[name === "catpower" ? "manpower" : name];
    if (!entry || entry.samples.length < 2) return null;
    const first = entry.samples[0];
    const last = entry.samples[entry.samples.length - 1];
    const span = last.t - first.t;
    if (span < RESOURCE_TELEMETRY_MIN_SPAN_MS) return null;
    const delta = last.value - first.value;
    if (!isFinite(delta)) return null;
    return delta / (span / 1000);
  };

  const liveCapFor = (resources, name) => {
    const res = getRes(resources, name);
    const telemetry = resourceTelemetry[name === "catpower" ? "manpower" : name];
    return Math.max(liveResourceCap(res), (telemetry && telemetry.cap) || 0);
  };

  const resetTickCache = () => {
    tickCache = {
      resources: null,
      production: Object.create(null),
      candidates: null,
      target: undefined,
      pressure: null,
      producerDemand: null,
      goalFrontier: null,
      goalClosure: null,
      goalSupport: null,
      fxRefreshed: new WeakSet(),
    };
  };

  const getCandidatesCached = (resources, goalKey) => {
    if (!tickCache.candidates) tickCache.candidates = gatherCandidates(resources, goalKey);
    return tickCache.candidates;
  };

  const getTargetCached = (resources, goalKey) => {
    if (tickCache.target === undefined) tickCache.target = chooseWorkTarget(resources, goalKey);
    return tickCache.target;
  };

  const goalKeyFor = (goal) => Object.entries(GOALS).find(([, info]) => info === goal)?.[0] || getGoal();

  const getStoragePressureCached = (resources, goal, goalKey = goalKeyFor(goal)) => {
    if (!tickCache.pressure) tickCache.pressure = storageBlockPressure(resources, goal, goalKey);
    return tickCache.pressure;
  };

  const getProductionDemandCached = (resources, goalKey) => {
    if (!tickCache.producerDemand) tickCache.producerDemand = productionDemand(resources, goalKey);
    return tickCache.producerDemand;
  };

  /* ------------------------- economy balancing action ------------------------ */

  // Backup to the KS craft setting above: directly refine catnip surplus into
  // wood when catnip is piling up, keeping the same food reserve used by the
  // universal crafting rules below. Use the resilient craftUnits wrapper (not a
  // single game API shape), because Kittens Game has changed craft entrypoints.
  const refineSurplusCatnip = () => {
    try {
      const res = resourceMap();
      const catnip = res.get("catnip");
      if (!catnip || !catnip.maxValue || !craftByName("wood")) return;
      const catnipRatio = catnip.value / catnip.maxValue;
      if (catnipRatio < 0.86) return;
      const wood = res.get("wood");
      if (wood && wood.maxValue && wood.value / wood.maxValue > 0.88) {
        const target = getTargetCached(res, getGoal());
        let needsWood = false;
        if (target && !target.affordable) {
          for (const cost of pricesFor(target.kind, target.meta)) {
            if (!cost || !cost.name || cost.val <= 0) continue;
            if (cost.name === "wood") { needsWood = true; break; }
            if (craftByName(cost.name) && (rawPathRequirements(cost.name, Math.max(1, cost.val)).wood || 0) > 0) {
              needsWood = true;
              break;
            }
          }
        }
        if (!needsWood) return;
      }
      const spendable = catnip.value - craftFloorFor(res, "catnip");
      if (spendable <= 0) return;
      const price = craftPricesFor(craftByName("wood")).find((p) => p && p.name === "catnip" && p.val > 0);
      const costPer = price && price.val > 0 ? price.val : woodCatnipCost();
      const woodToMake = Math.floor(spendable / costPer);
      if (woodToMake >= 1) craftUnits("wood", Math.max(1, Math.ceil(woodToMake * 0.35)));
    } catch (error) {
      /* ignore */
    }
  };


  const craftByName = (name) => {
    try {
      const craft = window.gamePage.workshop.getCraft && window.gamePage.workshop.getCraft(name);
      return craft && craft.unlocked !== false ? craft : null;
    } catch (error) {
      return null;
    }
  };

  const craftPricesFor = (craft) => {
    try {
      if (window.gamePage.workshop.getCraftPrice) return window.gamePage.workshop.getCraftPrice(craft) || craft.prices || [];
    } catch (error) {
      /* fall through */
    }
    return (craft && craft.prices) || [];
  };

  const craftRatioFor = (name) => {
    try {
      return typeof window.gamePage.getResCraftRatio === "function" ? window.gamePage.getResCraftRatio(name) || 0 : 0;
    } catch (error) {
      return 0;
    }
  };

  const craftReserveFor = (resources, name) => {
    const res = getRes(resources, name);
    if (!res || !res.maxValue) return 0;
    if (name === "catnip") return res.maxValue * 0.5;
    if (name === "manpower" || name === "catpower") return 100;
    return 0;
  };

  const craftLabel = (name) => {
    const craft = craftByName(name);
    const res = resourceMap().get(name);
    return (craft && craft.label) || (res && res.title) || name;
  };

  const rawWorkNeedName = (name, depth = 0) => {
    if (["wood", "beam", "scaffold", "ship"].includes(name)) return "wood";
    if (["minerals", "iron", "titanium", "uranium"].includes(name)) return "minerals";
    if (["coal", "gold"].includes(name)) return "coal";
    if (["furs", "ivory", "spice", "unicorns"].includes(name)) return "manpower";
    if (["science", "blueprint", "compendium", "compedium"].includes(name)) return "science";
    if (name === "faith") return "faith";
    // Resources the static shortcuts don't know (new game content): if a job
    // produces it the jobs system can staff it directly; otherwise follow the
    // converter building that outputs it back to that converter's raw input.
    if (depth < 3) {
      try {
        for (const job of managedJobs()) {
          if (jobResourceFor(job) === name) return name;
        }
        for (const meta of buildingMetas()) {
          if (!meta || !(meta.val > 0)) continue;
          const profile = processingProfileFor(meta);
          if (!profile.outputs.includes(name) || !profile.inputs.length) continue;
          return rawWorkNeedName(profile.inputs[0], depth + 1);
        }
      } catch (error) {
        /* fall through to the name itself */
      }
    }
    return name;
  };


  const craftablePotential = (name, depth = 0) => {
    if (depth > 4) return 0;
    const craft = craftByName(name);
    if (!craft) return 0;
    const prices = craftPricesFor(craft).filter((p) => p && p.name && p.val > 0);
    if (!prices.length) return 0;
    const resources = resourceMap();
    let baseUnits = Number.MAX_VALUE;
    for (const price of prices) {
      const res = getRes(resources, price.name);
      const reserve = craftReserveFor(resources, price.name);
      const direct = Math.max(0, ((res && res.value) || 0) - reserve);
      const recursive = craftablePotential(price.name, depth + 1);
      baseUnits = Math.min(baseUnits, (direct + recursive) / price.val);
    }
    return baseUnits === Number.MAX_VALUE ? 0 : Math.floor(baseUnits) * (1 + craftRatioFor(name));
  };

  const scoreResourcePathNeed = (needs, name, weight, depth = 0) => {
    if (depth > 4) {
      scoreNeed(needs, rawWorkNeedName(name), weight);
      return;
    }
    const craft = craftByName(name);
    if (!craft) {
      scoreNeed(needs, rawWorkNeedName(name), weight);
      return;
    }
    const prices = craftPricesFor(craft).filter((p) => p && p.name && p.val > 0);
    if (!prices.length) {
      scoreNeed(needs, rawWorkNeedName(name), weight);
      return;
    }
    for (const price of prices) scoreResourcePathNeed(needs, price.name, weight / prices.length, depth + 1);
  };

  let craftPlanText = "Craft: waiting…";
  let lastCraftLog = 0;

  const craftUnits = (name, units) => {
    if (!isFinite(units) || units <= 0) return false;
    const before = (getRes(resourceMap(), name) || { value: 0 }).value || 0;
    const craft = craftByName(name);
    const attempts = [
      () => (typeof window.gamePage.craft === "function" ? window.gamePage.craft(name, units) : false),
      () => (window.gamePage.workshop && typeof window.gamePage.workshop.craft === "function" ? window.gamePage.workshop.craft(craft || name, units) : false),
      () => (window.gamePage.workshop && typeof window.gamePage.workshop.craft === "function" ? window.gamePage.workshop.craft(name, units, true) : false),
    ];
    for (const attempt of attempts) {
      try {
        const result = attempt();
        const after = (getRes(resourceMap(), name) || { value: 0 }).value || 0;
        if (result !== false && after > before) return true;
      } catch (error) {
        /* try the next API shape */
      }
    }
    return false;
  };

  // Liquid floor crafting must respect: food/catpower reserves plus a luxury
  // cushion — furs/ivory/spice above zero are a happiness bonus, so crafting
  // (e.g. furs→parchment for a manuscript chain) must never wipe them out.
  // forPlanChain: when a craft serves the ACTIVE PLAN (e.g. furs → parchment →
  // manuscript → compendium for a tech the plan needs), keep only a minimal
  // luxury cushion so the plan's own chain is never blocked by the idle
  // happiness reserve. Idle/overflow crafting keeps the larger cushion. The
  // catnip starvation reserve and catpower reserve are NEVER relaxed.
  const craftFloorFor = (resources, name, forPlanChain = false) => {
    let floor = craftReserveFor(resources, name);
    if (LUXURY_RESOURCES.includes(name)) {
      floor = Math.max(floor, luxuryStockTarget(resources, name) * (forPlanChain ? 1 : 3));
    }
    return floor;
  };

  // Craft toward `targetAmount` of a resource, recursively crafting missing
  // inputs first. Partial fills are fine: if inputs only cover a third of the
  // deficit, craft that third now instead of stalling until everything fits.
  const tryCraftResource = (name, targetAmount, depth = 0, target = null, topOutputName = name) => {
    if (depth > 5 || !isFinite(targetAmount) || targetAmount <= 0) return false;
    const resources = resourceMap();
    const current = getRes(resources, name);
    const have = (current && current.value) || 0;
    if (have >= targetAmount) return true;

    const craft = craftByName(name);
    if (!craft) return false;
    const prices = craftPricesFor(craft).filter((p) => p && p.name && p.val > 0);
    if (!prices.length) return false;

    const deficit = targetAmount - have;
    const wantUnits = Math.max(1, Math.ceil(deficit / Math.max(1, 1 + craftRatioFor(name))));
    for (const price of prices) {
      const neededInput = price.val * wantUnits;
      const input = getRes(resourceMap(), price.name);
      if (((input && input.value) || 0) < neededInput) {
        tryCraftResource(price.name, neededInput, depth + 1, target, topOutputName); // best effort, clamp below
      }
    }

    const fresh = resourceMap();
    let units = wantUnits;
    for (const price of prices) {
      const input = getRes(fresh, price.name);
      // This craft is serving the active plan's chain, so reserve only a minimal
      // luxury cushion (forPlanChain) — the plan must not be blocked by the idle
      // happiness reserve, but the catnip starvation reserve still holds.
      const floor = target ? overflowInputFloor(target, fresh, price.name, topOutputName, true) : craftFloorFor(fresh, price.name);
      const available = Math.max(0, ((input && input.value) || 0) - floor);
      units = Math.min(units, Math.floor(available / price.val));
    }
    if (units <= 0) return false;

    const measured = withActionResourceDeltas(() => craftUnits(name, units));
    if (measured.result) {
      craftPlanText = `Craft: made ${fmt(units * (1 + craftRatioFor(name)))} ${craftLabel(name)}`;
      if (Date.now() - lastCraftLog > 15000) {
        pushLog(`🧰 ${craftPlanText}: ${measured.suffix}${target ? `; reason ${labelOf(target.meta)} chain` : ""}`);
        lastCraftLog = Date.now();
      }
      return units >= wantUnits;
    }
    return false;
  };


  const OVERFLOW_CRAFTS = ["wood", "beam", "slab", "plate", "steel", "gear", "concrate", "alloy", "eludium", "scaffold", "ship", "parchment", "manuscript", "compedium", "blueprint"];
  let overflowPlanText = "Overflow: watching storage";
  let lastOverflowLog = 0;

  const craftableResourceNames = () => {
    const names = new Set(OVERFLOW_CRAFTS);
    try {
      const crafts = window.gamePage && window.gamePage.workshop && window.gamePage.workshop.crafts;
      const list = Array.isArray(crafts) ? crafts : Object.values(crafts || {});
      for (const craft of list) {
        if (craft && craft.name && craft.unlocked !== false) names.add(craft.name);
      }
    } catch (error) {
      /* keep the curated fallback list */
    }
    return [...names];
  };

  const wouldWasteResource = (resources, name) => {
    const res = getRes(resources, name);
    if (!res || !res.maxValue || res.unlocked === false) return false;
    const ratio = res.value / res.maxValue;
    const net = productionFor(name);
    return ratio > 0.93 || (ratio > 0.86 && net > 0);
  };

  const targetNeedsResource = (target, name) => {
    if (!target) return false;
    return pricesFor(target.kind, target.meta).some((cost) => cost && cost.name === name && cost.val > ((getRes(resourceMap(), name) || { value: 0 }).value || 0));
  };

  // Overflow crafting is allowed to convert a hot input only when that input is
  // genuinely surplus to the active plan.  The floor is computed from the plan's
  // direct prices plus raw craft-chain requirements for every missing target
  // resource EXCEPT the output currently being crafted.  That exception lets
  // overflow crafting still help by making a needed intermediate (minerals →
  // slab when the focus needs slabs), while preventing contradictions such as
  // minerals → slab when the focus itself is still reserving minerals.
  const overflowInputFloor = (target, resources, inputName, outputName, forPlanChain = false) => {
    let floor = craftFloorFor(resources, inputName, forPlanChain);
    if (stickyReservesResource(inputName) && inputName !== outputName && !stickyReservesResource(outputName)) return Number.MAX_SAFE_INTEGER;
    if (!target) return floor;

    const chain = refreshStickyTargetChainReserve(target, resources);
    if (chain.has(inputName) && inputName !== outputName && !chain.has(outputName)) return Number.MAX_SAFE_INTEGER;

    // If the active target directly needs this input and is still short, no
    // lower-priority craft may consume it. This closes the Observatory trap:
    // crafting Plate for missing Scaffold must wait until the direct Iron bill
    // is already covered.
    const directInputCost = pricesFor(target.kind, target.meta).find((cost) => cost && cost.name === inputName && isFinite(cost.val) && cost.val > 0);
    if (directInputCost && inputName !== outputName) {
      const haveDirect = ((getRes(resources, inputName) || {}).value) || 0;
      if (haveDirect < directInputCost.val) return Number.MAX_SAFE_INTEGER;
    }

    const converterInputs = converterInputsNeededForMissingCosts(target, resources);
    if (converterInputs.has(inputName) && inputName !== outputName) return Number.MAX_SAFE_INTEGER;

    for (const cost of pricesFor(target.kind, target.meta)) {
      if (!cost || !cost.name || !isFinite(cost.val) || cost.val <= 0) continue;
      const res = getRes(resources, cost.name);
      if (res && res.maxValue > 0 && cost.val > res.maxValue && !craftByName(cost.name)) continue;

      if (cost.name === inputName) floor = Math.max(floor, cost.val);
      if (cost.name === outputName) continue;

      const have = ((getRes(resources, cost.name) || {}).value) || 0;
      const deficit = Math.max(0, cost.val - have - craftablePotential(cost.name));
      if (deficit <= 0 || !craftByName(cost.name)) continue;
      const raw = rawPathRequirements(cost.name, deficit);
      if (raw[inputName] > 0) floor = Math.max(floor, raw[inputName]);
    }

    return floor;
  };

  const craftOverflowResources = (resources, goalKey) => {
    try {
      const target = getTargetCached(resources, goalKey);
      const scored = [];
      for (const name of craftableResourceNames()) {
        const craft = craftByName(name);
        if (!craft) continue;
        const prices = craftPricesFor(craft).filter((p) => p && p.name && p.val > 0);
        if (!prices.length) continue;
        const output = getRes(resources, name);
        if (output && output.maxValue && output.value / output.maxValue > 0.92 && !targetNeedsResource(target, name)) continue;
        const hotInputs = prices.filter((price) => wouldWasteResource(resources, price.name));
        const activeReserve = target && !target.affordable;
        const helpsTarget = targetNeedsResource(target, name) || craftOutputHelpsTarget(target, name, resources);
        const safeWoodOverflow = name === "wood" && !targetNeedsResource(target, "catnip") && wouldWasteResource(resources, "catnip");
        if (activeReserve && !helpsTarget && !safeWoodOverflow) continue;
        if (!hotInputs.length && !helpsTarget) continue;
        let maxUnits = Number.MAX_VALUE;
        for (const price of prices) {
          const input = getRes(resources, price.name);
          const value = (input && input.value) || 0;
          const reserve = overflowInputFloor(target, resources, price.name, name);
          maxUnits = Math.min(maxUnits, Math.floor(Math.max(0, value - reserve) / price.val));
        }
        if (!isFinite(maxUnits) || maxUnits < 1) continue;
        const targetBoost = targetNeedsResource(target, name) || craftOutputHelpsTarget(target, name, resources) ? 100 : 0;
        const heat = hotInputs.reduce((sum, price) => sum + Math.max(0, resRatio(resources, price.name, 0) - 0.86), 0);
        scored.push({ name, maxUnits, score: targetBoost + heat });
      }
      const best = scored.sort((a, b) => b.score - a.score)[0];
      if (!best) {
        overflowPlanText = "Overflow: watching storage";
        return;
      }
      const units = Math.max(1, Math.min(best.maxUnits, best.score >= 100 ? Math.ceil(best.maxUnits * 0.5) : Math.ceil(best.maxUnits * 0.2)));
      const measured = withActionResourceDeltas(() => craftUnits(best.name, units));
      if (measured.result) {
        overflowPlanText = `Overflow: converted surplus into ${craftLabel(best.name)}`;
        if (Date.now() - lastOverflowLog > 20000) {
          pushLog(`📦 ${overflowPlanText}: ${measured.suffix}; reason overflow/capped storage`);
          lastOverflowLog = Date.now();
        }
      }
    } catch (error) {
      /* ignore */
    }
  };

  const craftTowardTarget = (resources, goalKey) => {
    try {
      const target = getTargetCached(resources, goalKey);
      if (!target || target.affordable) {
        craftPlanText = "Craft: no intermediate needed";
        return;
      }
      let planned = "";
      for (const cost of pricesFor(target.kind, target.meta)) {
        if (!cost || !cost.name || !isFinite(cost.val) || cost.val <= 0) continue;
        const have = (getRes(resourceMap(), cost.name) || { value: 0 }).value || 0;
        if (have < cost.val && craftByName(cost.name)) {
          if (!planned) {
            planned = `Craft: ${craftLabel(cost.name)} for ${labelOf(target.meta)}`;
            craftPlanText = planned;
          }
          tryCraftResource(cost.name, cost.val, 0, target, cost.name); // may overwrite plan text with "made N …"
        }
      }
      if (!planned) craftPlanText = "Craft: gathering raw inputs";
    } catch (error) {
      /* ignore */
    }
  };

  /* ----------------------- job balancing & hunting (ours) ------------------- */

  const jobByName = (name) => {
    try {
      return (window.gamePage.village.jobs || []).find((j) => j.name === name && j.unlocked !== false) || null;
    } catch (error) {
      return null;
    }
  };

  const woodCatnipCost = () => {
    try {
      const craft = window.gamePage.workshop.getCraft && window.gamePage.workshop.getCraft("wood");
      const price = craft && craftPricesFor(craft).find((p) => p.name === "catnip");
      if (price && price.val > 0) return price.val;
    } catch (error) {
      /* no live craft price yet */
    }
    return null;
  };

  // Live catnip production multiplier from the current season + weather — the
  // "[+50%]" badge in the resource bar (spring +50%, winter −75%, ±15% for
  // warm/cold).  getResProduction() returns GROSS village catnip WITHOUT this
  // modifier (the game applies it in calcResourcePerTick), so the wood-vs-farm
  // trade must fold it in or it silently uses an out-of-season rate.  getWeatherMod
  // returns the additive delta the badge shows, so the multiplier is 1 + delta.
  // Falls back to 1 when the calendar isn't available.
  const catnipWeatherMultiplier = () => {
    try {
      const cal = window.gamePage && window.gamePage.calendar;
      if (!cal || typeof cal.getWeatherMod !== "function") return 1;
      const mod = cal.getWeatherMod();
      const mult = isFinite(mod) ? 1 + mod : 1;
      return mult > 0 ? mult : 1;
    } catch (error) {
      return 1;
    }
  };

  const jobMarginalProductionPerSecond = (job, resourceName) => {
    if (!job || !resourceName) return null;
    const key = resourceName === "catpower" ? "manpower" : resourceName;
    try {
      const count = Math.max(0, Number(job.value) || 0);
      // Prefer the LIVE figure: the game's CURRENT village production for this
      // resource divided by the staffed count.  Production is linear in kitten
      // count, so the average equals the marginal, and this already reflects live
      // happiness, leader and production-ratio bonuses — not a baked-in base rate.
      const village = window.gamePage && window.gamePage.village;
      if (count > 0 && village && typeof village.getResProduction === "function") {
        const prod = village.getResProduction() || {};
        const total = prod[key];
        if (isFinite(total) && total > 0) return (total * ticksPerSecond()) / count;
      }
      // Unstaffed (or no live signal yet): fall back to the base per-tick modifier.
      if (job.modifiers && isFinite(job.modifiers[key])) return job.modifiers[key] * ticksPerSecond();
    } catch (error) {
      /* no stable marginal signal for this job yet */
    }
    return null;
  };

  // Pathway math: to get more WOOD, is it better to add a Woodcutter (direct) or a
  // Farmer (catnip, which we refine into wood)?  Everything here is read LIVE so the
  // answer tracks the current board, not baked-in base rates:
  //   • woodPerCutter — live per-cutter village output, lifted to the true wood rate
  //     so global wood ratios (Lumber Mills etc., applied above village output) count.
  //   • catnipPerFarmer — live per-farmer village output × the current season/weather
  //     catnip multiplier (spring boosts, winter guts the farm→wood route).
  //   • the refine yields (1 + craftRatio) wood per 100 catnip, not 1.
  const bestWoodJob = () => {
    try {
      const cutter = jobByName("woodcutter");
      const farmer = jobByName("farmer");
      if (!cutter) return farmer;
      if (!farmer) return cutter;
      const woodBase = jobMarginalProductionPerSecond(cutter, "wood");
      const catnipBase = jobMarginalProductionPerSecond(farmer, "catnip");
      if (woodBase == null || catnipBase == null) return cutter; // not enough live data → direct
      // The true live wood/s (productionFor → getResourcePerTick) folds in Lumber
      // Mills and every other woodRatio applied above raw village output; per cutter
      // that is the fuller marginal.  max() so a noisy/low sample can't penalise it.
      const cutterCount = Math.max(1, Number(cutter.value) || 0);
      const woodPerCutter = Math.max(woodBase, productionFor("wood") / cutterCount);
      const catnipPerFarmer = catnipBase * catnipWeatherMultiplier();
      const refineCost = woodCatnipCost();
      if (!(refineCost > 0)) return cutter;
      const woodViaRefine = (catnipPerFarmer / refineCost) * (1 + craftRatioFor("wood"));
      return woodViaRefine > woodPerCutter ? farmer : cutter;
    } catch (error) {
      return jobByName("woodcutter");
    }
  };

  const RES_JOB = {
    minerals: "miner",
    science: "scholar",
    catnip: "farmer",
    coal: "geologist",
    faith: "priest",
    manpower: "hunter",
    catpower: "hunter",
  };
  // Fallback job → produced-resource map. The live mapping is discovered from
  // each job's own `modifiers` metadata (see jobResourceFor), so new jobs the
  // game adds are managed automatically; this map only covers jobs that don't
  // expose modifiers.
  const JOB_RESOURCE = {
    woodcutter: "wood",
    farmer: "catnip",
    miner: "minerals",
    scholar: "science",
    hunter: "manpower",
    priest: "faith",
    geologist: "coal",
  };

  const jobResourceFor = (job) => {
    if (!job) return null;
    const modifiers = job.modifiers;
    if (modifiers && typeof modifiers === "object") {
      let best = null;
      for (const [name, amount] of Object.entries(modifiers)) {
        if (!isFinite(amount) || amount <= 0) continue;
        if (!getRes(resourceMap(), name)) continue;
        if (!best || amount > best.amount) best = { name, amount };
      }
      if (best) return best.name;
    }
    return JOB_RESOURCE[job.name] || null;
  };
  const LUXURY_RESOURCES = ["furs", "ivory", "spice"];
  const HELPER_TICK_MS = 2000;
  const JOB_REBALANCE_MIN_MS = 20000;
  const JOB_WEIGHT_SMOOTHING = 0.35;
  const JOB_COUNT_DEADBAND_RATIO = 0.08;
  let smoothedJobWeights = {};
  let lastJobRun = 0;
  let lastJobLog = 0;
  let lastJobSignature = "";
  let jobPlanText = "Jobs: waiting…";
  let jobSuppressText = "";
  let lastJobContext = "";

  const getRes = (resources, name) => resources.get(name) || (name === "catpower" ? resources.get("manpower") : null);

  const resRatio = (resources, name, fallback = 1) => {
    const r = getRes(resources, name);
    const cap = liveCapFor(resources, name);
    return r && cap > 0 ? r.value / cap : fallback;
  };

  const resTitle = (resources, name) => {
    const r = getRes(resources, name);
    if (name === "manpower" || name === "catpower") return (r && r.title) || "Catpower";
    return (r && r.title) || name;
  };


  const villageKittens = () => {
    try {
      return Math.max(0, Math.floor(window.gamePage.village.getKittens ? window.gamePage.village.getKittens() : 0));
    } catch (error) {
      return 0;
    }
  };

  // 0..1 — how full the village is. Housing is worth little while beds are
  // free and a lot when population growth is blocked by it, so Mansions/Huts
  // surge in the scoring exactly when they matter.
  const housingSaturation = () => {
    try {
      const village = window.gamePage.village;
      const max = village.maxKittens || (village.sim && village.sim.maxKittens) || 0;
      if (!(max > 0)) return 0;
      return Math.min(1, villageKittens() / max);
    } catch (error) {
      return 0;
    }
  };

  // village.happiness is a RATIO (1.4 = 140%, floor 0.25) and can legitimately
  // exceed 2.0 late game. Only treat it as a percent if it's clearly one.
  const currentHappinessRatio = () => {
    try {
      const village = window.gamePage.village;
      const raw = typeof village.getHappiness === "function" ? village.getHappiness() : village.happiness;
      if (!isFinite(raw) || raw <= 0) return 1;
      return raw > 10 ? raw / 100 : raw;
    } catch (error) {
      return 1;
    }
  };

  const luxuryStockTarget = (resources, name) => {
    const kittens = Math.max(1, villageKittens());
    const res = getRes(resources, name);
    if (res && res.maxValue > 0) return Math.max(25, Math.min(res.maxValue * 0.25, kittens * 4));
    return Math.max(25, kittens * 4);
  };

  const luxuryShortageScore = (resources) => {
    let score = 0;
    for (const name of LUXURY_RESOURCES) {
      const res = getRes(resources, name);
      if (!res || res.unlocked === false) continue;
      const value = Math.max(0, res.value || 0);
      const target = luxuryStockTarget(resources, name);
      if (target <= 0) continue;
      score += Math.max(0, 1 - Math.min(1, value / target));
    }
    return score;
  };

  // Hunting is not just "avoid capped catpower": furs/ivory/spice lift village
  // happiness, and happiness is a global production multiplier.  If luxuries are
  // empty or mood is below normal, keep some settlement kittens on hunters so the
  // next hunt can restore that multiplier instead of assigning everyone to raw
  // gathering jobs.
  const huntingEconomyNeed = (resources) => {
    if (!jobByName("hunter")) return 0;
    const cpRatio = resRatio(resources, "manpower", 0);
    const shortage = luxuryShortageScore(resources);
    const happinessGap = Math.max(0, 1 - currentHappinessRatio());
    let need = shortage * 5 + happinessGap * 18;
    if (cpRatio < 0.25 && (shortage > 0.35 || happinessGap > 0.02)) need += 4;
    if (cpRatio > 0.9 && shortage < 0.5 && happinessGap < 0.02) need = Math.min(need, 0.5);
    return need;
  };

  const scoreNeed = (needs, name, weight) => {
    if (!name || !isFinite(weight) || weight <= 0) return;
    const key = name === "catpower" ? "manpower" : name;
    needs[key] = (needs[key] || 0) + weight;
  };

  const effectText = (meta) => {
    const parts = [metaText(meta)];
    for (const key of ["effects", "calculateEffects", "unlocks", "upgrades", "stages"]) {
      const value = meta && meta[key];
      if (!value || typeof value !== "object") continue;
      try {
        parts.push(JSON.stringify(value));
      } catch (error) {
        parts.push(Object.keys(value).join(" "));
      }
    }
    return parts.join(" ").toLowerCase();
  };

  /* ---------------------- universal effect understanding --------------------- */

  // Every scoring constant lives here. The decision framework is uniform:
  // a candidate's score is its expected VALUE — production gains, storage
  // relief, unlocks and goal alignment, all read from parsed game metadata —
  // minus its COST (time to afford, storage blocks). Tune weights here instead
  // of hunting per-item special cases through the code.
  const TUNING = {
    kindPrior: { research: 12, upgrade: 12, religion: 11, build: 4, policy: 6 },
    affordBonus: 6, // fully affordable right now
    progressScale: 5, // partial affordability, 0..1
    gatewayScale: 3, // per item a tech unlocks (recursively dampened)
    gatewayCap: 24,
    frontierBoost: 20, // unlocked tech on the path to the goal milestone
    goalClosureBoost: 14, // any tech on the path to the goal milestone
    emphasisScale: 10, // per (multiplier - 1) of a matching goal emphasis
    unlockAlignBoost: 8, // tech unlocking emphasis-matching content
    supportProductionBoost: 6, // produces a resource the goal frontier needs
    supportStorageBoost: 4, // stores a resource the goal frontier needs
    productionScale: 24, // relative production / ratio gains
    spendBonus: 10, // consumes an almost-full spendable bank (science…)
    manualPriorityBoost: 22, // optional player override, still inside scoring
    noveltyBoost: 9, // freshly unlocked content gets a short evaluation window
    earlyGameBonus: 4, // cold-start: favor first unlocks before economy data is rich
    earlyGameUnlockMult: 2.2,
    storageReliefCap: 30, // max boost from relieving live storage pressure
    housingValue: 6,
    happinessScale: 8,
    idleStoragePenalty: 10, // pure-storage item nothing currently needs
    waitPenaltyCap: 14, // log-scaled time-to-afford penalty
    unreachablePenalty: 22, // no production path at all
    storageBlockPenalty: 48, // a cost sits above a storage cap
    producerPrereqBoost: 30, // build the producer of a resource the focus needs but can't make
                             // (e.g. Oil Well before a Calciner that needs oil)
    pressureKind: { research: 34, upgrade: 24, religion: 14, build: 14 },
    pressureGatewayScale: 8,
    pressureGatewayCap: 26,
    pressureClosureBoost: 20,
  };

  // Instead of keyword tables, read the game's own metadata: every building,
  // tech, upgrade and religion item exposes an `effects` object whose keys
  // follow regular naming conventions (`woodPerTick`, `scienceMax`,
  // `mineralsRatio`, `maxKittens`, `catnipDemandRatio`, …). Parsing those keys
  // yields what a candidate actually DOES — production, storage, multipliers,
  // housing — so scoring adapts to any content the game adds instead of
  // relying on hand-kept name lists.
  let resourceNamesCache = { count: -1, names: [] };
  const knownResourceNames = () => {
    try {
      const list = window.gamePage.resPool.resources;
      if (list.length !== resourceNamesCache.count) {
        resourceNamesCache = { count: list.length, names: list.map((r) => r.name).filter(Boolean) };
      }
    } catch (error) {
      /* keep the previous cache */
    }
    return resourceNamesCache.names;
  };

  const matchResourcePrefix = (key) => {
    let best = null;
    for (const name of knownResourceNames()) {
      if (key.startsWith(name) && (!best || name.length > best.length)) best = name;
    }
    return best;
  };

  const emptyEffectProfile = () => ({ perTick: {}, max: {}, ratio: {}, demand: {}, housing: 0, happiness: 0, craft: 0 });

  const addEffectProfile = (target, source, scale = 1) => {
    if (!source || !isFinite(scale) || scale <= 0) return target;
    for (const group of ["perTick", "max", "ratio", "demand"]) {
      for (const [name, amount] of Object.entries(source[group] || {})) {
        if (!isFinite(amount) || amount === 0) continue;
        target[group][name] = (target[group][name] || 0) + amount * scale;
      }
    }
    target.housing += (source.housing || 0) * scale;
    target.happiness += (source.happiness || 0) * scale;
    target.craft += (source.craft || 0) * scale;
    return target;
  };

  const parseEffectEntry = (profile, key, value) => {
    if (!isFinite(value) || value === 0) return;
    if (key === "maxKittens") {
      profile.housing += value;
      return;
    }
    if (/happiness/i.test(key)) {
      profile.happiness += value;
      return;
    }
    if (key === "craftRatio") {
      profile.craft += value;
      return;
    }
    const resource = matchResourcePrefix(key);
    if (resource) {
      const rest = key.slice(resource.length);
      if (/^PerTick/.test(rest)) {
        profile.perTick[resource] = (profile.perTick[resource] || 0) + value;
        return;
      }
      if (/^Max(Ratio)?$/.test(rest)) {
        const cap = ((getRes(resourceMap(), resource) || {}).maxValue) || 0;
        const amount = /Ratio$/.test(rest) ? value * cap : value;
        profile.max[resource] = (profile.max[resource] || 0) + amount;
        return;
      }
      if (/^(Global|Super)?Ratio/.test(rest)) {
        profile.ratio[resource] = (profile.ratio[resource] || 0) + value;
        return;
      }
      if (/^Demand/.test(rest)) {
        profile.demand[resource] = (profile.demand[resource] || 0) + value;
        return;
      }
    }
    // `<job>Ratio` boosts a job's output (hunterRatio, geologistRatio…) — map
    // it to the resource that job produces.
    const jobMatch = key.match(/^([a-z]+?)Ratio$/);
    if (jobMatch && JOB_RESOURCE[jobMatch[1]]) {
      const produced = JOB_RESOURCE[jobMatch[1]];
      profile.ratio[produced] = (profile.ratio[produced] || 0) + value;
    }
  };

  // Many buildings only get their real numbers when the game runs their
  // calculateEffects (the Observatory's scienceRatio/scienceMax exist ONLY
  // there; the metadata carries placeholders). Refresh once per tick before
  // profiling, so freshly unlocked content is valued from live effects.
  const refreshMetaEffects = (meta) => {
    if (!meta || typeof meta.calculateEffects !== "function" || tickCache.fxRefreshed.has(meta)) return;
    tickCache.fxRefreshed.add(meta);
    try {
      meta.calculateEffects(meta, window.gamePage);
    } catch (error) {
      /* keep the existing effect values */
    }
  };

  const metaEffectProfile = (meta) => {
    const profile = emptyEffectProfile();
    if (!meta || typeof meta !== "object") return profile;
    refreshMetaEffects(meta);
    const sources = [];
    if (meta.effects && typeof meta.effects === "object") sources.push(meta.effects);
    if (Array.isArray(meta.stages) && isFinite(meta.stage) && meta.stages[meta.stage] && meta.stages[meta.stage].effects) {
      sources.push(meta.stages[meta.stage].effects);
    }
    for (const effects of sources) {
      for (const [key, value] of Object.entries(effects)) parseEffectEntry(profile, key, value);
    }
    return profile;
  };

  const scaledEffectProfileFromEntries = (entries) => {
    const profile = emptyEffectProfile();
    for (const [key, value, scale] of entries) parseEffectEntry(profile, key, value * scale);
    return profile;
  };

  // Some upgrades do not expose their own direct `effects`; instead, buying
  // them changes the calculated effects of existing buildings listed in
  // `upgrades.buildings` (for example an automation upgrade can make a
  // powered building produce a crafted resource).  Score that as a normal
  // effect delta: temporarily evaluate the affected building as if this
  // candidate were researched, diff its numeric effects, then restore the live
  // game metadata.  This keeps hidden building-upgrade synergies generic and
  // expandable instead of hard-coding individual upgrade names.
  const affectedBuildingDeltaProfile = (meta) => {
    const profile = emptyEffectProfile();
    const names = meta && meta.upgrades && Array.isArray(meta.upgrades.buildings) ? meta.upgrades.buildings : [];
    if (!names.length) return profile;
    const game = window.gamePage;
    for (const name of names) {
      const building = buildingByName(name);
      if (!building || typeof building.calculateEffects !== "function") continue;
      const activeCount = Math.max(0, building.on || building.val || 0);
      const ownedCount = Math.max(0, building.val || activeCount);
      if (activeCount <= 0 && ownedCount <= 0) continue;

      const beforeEffects = { ...(building.effects || {}) };
      const beforeDescription = building.description;
      const wasResearched = !!meta.researched;
      try {
        meta.researched = true;
        building.effects = { ...beforeEffects };
        building.calculateEffects(building, game);
        const deltaEntries = [];
        for (const key of new Set([...Object.keys(beforeEffects), ...Object.keys(building.effects || {})])) {
          const before = beforeEffects[key] || 0;
          const after = (building.effects && building.effects[key]) || 0;
          const delta = after - before;
          if (!isFinite(delta) || delta === 0) continue;
          const perTickLike = /PerTick|Autoprod|Prod|Con/i.test(key);
          deltaEntries.push([key, delta, perTickLike ? activeCount : ownedCount]);
        }
        addEffectProfile(profile, scaledEffectProfileFromEntries(deltaEntries));
      } catch (error) {
        /* ignore metadata shapes we cannot safely evaluate */
      } finally {
        meta.researched = wasResearched;
        building.effects = beforeEffects;
        building.description = beforeDescription;
      }
    }
    return profile;
  };

  const candidateEffectProfile = (kind, meta) => {
    const profile = metaEffectProfile(meta);
    if (kind === "upgrade") addEffectProfile(profile, affectedBuildingDeltaProfile(meta));
    return profile;
  };

  const effectiveMetaProfile = (meta) => {
    const profile = metaEffectProfile(meta);
    if (meta && meta.upgrades && Array.isArray(meta.upgrades.buildings)) {
      addEffectProfile(profile, affectedBuildingDeltaProfile(meta));
    }
    return profile;
  };

  // 0..~1.2 — how starved the economy is for a resource: low stock and zero
  // production both raise it. Used to weight production/ratio gains, so the
  // same building is worth more when its output is the actual bottleneck.
  const scarcityWeight = (resources, name) => {
    const res = getRes(resources, name);
    if (!res || res.unlocked === false) return 0;
    const ratio = resRatio(resources, name, res.value > 0 ? 1 : 0);
    let weight = Math.max(0, 0.5 - ratio) * 1.4;
    if (productionFor(name) <= 0 && ratio < 0.8) weight += 0.5;
    return weight;
  };

  const ticksPerSecond = () => {
    try {
      const game = window.gamePage;
      for (const key of ["getTicksPerSecondUI", "getTicksPerSecond"]) {
        if (game && typeof game[key] === "function") {
          const value = game[key]();
          if (isFinite(value) && value > 0) return value;
        }
      }
      for (const value of [game && game.ticksPerSecond, game && game.rate]) {
        if (isFinite(value) && value > 0) return value;
      }
    } catch (error) {
      /* use the browser default below */
    }
    return 5;
  };

  // Kittens Game stores production as per-tick values internally, while the left
  // resource column shows per-second rates. ETAs must use the same unit players
  // see, and they must include buildings/processors, not only village jobs.
  const productionFor = (name) => {
    const resourceName = name === "catpower" ? "manpower" : name;
    if (Object.prototype.hasOwnProperty.call(tickCache.production, resourceName)) return tickCache.production[resourceName];
    let result = 0;
    const observed = observedProductionFor(resourceName);
    try {
      const game = window.gamePage;
      if (game && typeof game.getResourcePerTick === "function") {
        const perTick = game.getResourcePerTick(resourceName, true);
        if (isFinite(perTick)) result = perTick * ticksPerSecond();
        // Prefer the live bar delta once we have enough samples.  This catches
        // production changed by seasonal modifiers, processing buildings,
        // worker reassignment and temporary effects before cached API fields
        // settle.  Large one-off jumps (trade/craft/build spends) are ignored
        // here by trusting the API when the sample wildly disagrees.
        if (observed != null && Math.abs(observed - result) <= Math.max(25, Math.abs(result) * 3)) {
          result = observed;
        }
        tickCache.production[resourceName] = result;
        return result;
      }
      const res = getRes(resourceMap(), resourceName);
      if (res && isFinite(res.perTickCached)) {
        result = res.perTickCached * ticksPerSecond();
        if (observed != null && Math.abs(observed - result) <= Math.max(25, Math.abs(result) * 3)) {
          result = observed;
        }
        tickCache.production[resourceName] = result;
        return result;
      }
      const prod = game && game.village && game.village.getResProduction ? game.village.getResProduction() : {};
      const value = prod[resourceName];
      result = isFinite(value) ? value * ticksPerSecond() : 0;
    } catch (error) {
      result = 0;
    }
    if (observed != null && (result === 0 || Math.abs(observed - result) <= Math.max(25, Math.abs(result) * 3))) {
      result = observed;
    }
    tickCache.production[resourceName] = result;
    return result;
  };

  const rawPathRequirements = (name, amount, out = {}, depth = 0) => {
    if (depth > 5 || !isFinite(amount) || amount <= 0) return out;
    const craft = craftByName(name);
    if (!craft) {
      const raw = rawWorkNeedName(name);
      out[raw] = (out[raw] || 0) + amount;
      return out;
    }
    const prices = craftPricesFor(craft).filter((p) => p && p.name && p.val > 0);
    if (!prices.length) {
      const raw = rawWorkNeedName(name);
      out[raw] = (out[raw] || 0) + amount;
      return out;
    }
    const resources = resourceMap();
    const baseUnits = Math.max(1, Math.ceil(amount / Math.max(1, 1 + craftRatioFor(name))));
    for (const price of prices) {
      const inputNeed = price.val * baseUnits;
      // Intermediate craft stock already on hand counts toward this chain.  For
      // example, a Manuscript plan should consume existing Parchment before
      // expanding the whole chain into Furs pressure; raw resource stock is still
      // handled by scoreRawDeficits so it is not subtracted twice.
      const inputStock = craftByName(price.name)
        ? Math.max(0, (((getRes(resources, price.name) || {}).value) || 0) - craftFloorFor(resources, price.name))
        : 0;
      rawPathRequirements(price.name, Math.max(0, inputNeed - inputStock), out, depth + 1);
    }
    return out;
  };

  const scoreRawDeficits = (needs, resources, requirements, baseWeight) => {
    const entries = Object.entries(requirements).filter(([, required]) => required > 0);
    if (!entries.length) return;
    const pressures = entries.map(([name, required]) => {
      const res = getRes(resources, name);
      const have = Math.max(0, (res && res.value) || 0);
      const shortage = Math.max(0, required - have);
      const shortageRatio = shortage / required;
      const lowStock = 1 - Math.min(1, resRatio(resources, name, have >= required ? 1 : 0));
      const prod = productionFor(name);
      const prodPenalty = prod <= 0 ? 1 : Math.min(1, shortage / Math.max(1, prod * 600));
      return [name, Math.max(0, shortageRatio * 1.6 + lowStock * 0.8 + prodPenalty * 0.6)];
    });
    const totalPressure = pressures.reduce((sum, [, pressure]) => sum + pressure, 0) || 1;
    for (const [name, pressure] of pressures) {
      if (pressure <= 0) continue;
      const imbalanceBoost = name === "coal" && (requirements.iron || 0) > 0 ? 1.45 : 1;
      scoreNeed(needs, name, baseWeight * imbalanceBoost * (pressure / totalPressure));
    }
  };

  // "Pure storage": parsed effects show capacity but no production or housing.
  const isStorageMeta = (meta) => {
    const profile = metaEffectProfile(meta);
    return Object.keys(profile.max).length > 0 &&
      !Object.keys(profile.perTick).length &&
      !Object.keys(profile.ratio).length &&
      !profile.housing;
  };

  // Storage is only worth chasing while something still wants it: live
  // pressure from blocked candidates, or a capped bank wasting production.
  const storageStillWanted = (meta, resources, pressure) =>
    Object.keys(metaEffectProfile(meta).max).some(
      (name) => (pressure[name] || 0) > 0 || resRatio(resources, name, 0) > 0.9,
    );

  const directStorageBlockers = (kind, meta, resources) => {
    const blockers = [];
    for (const cost of pricesFor(kind, meta)) {
      if (!cost || !cost.name || !isFinite(cost.val) || cost.val <= 0) continue;
      if (craftByName(cost.name)) continue;
      const res = getRes(resources, cost.name);
      const cap = liveCapFor(resources, cost.name);
      if (!res || cap <= 0 || cost.val <= cap) continue;
      blockers.push({ name: cost.name, need: cost.val, max: cap });
    }
    return blockers;
  };

  const storageBlockerText = (kind, meta, resources) =>
    directStorageBlockers(kind, meta, resources)
      .slice(0, 2)
      .map((blocker) => `${resTitle(resources, blocker.name)} storage ${fmt(blocker.max)}/${fmt(blocker.need)}`)
      .join(", ");

  // Which blocked items may create storage pressure. Balanced mode lets most
  // real blockers count; focused goals only listen to items that demonstrably
  // advance the goal — membership in the milestone's tech closure, alignment
  // with the goal's emphasis categories (parsed effects, including what a tech
  // UNLOCKS), or producing/storing a resource the goal frontier still needs.
  // This is what stops a side upgrade just over a cap from turning a focused
  // run into an endless warehouse detour.
  const storageBlockerIsFocused = (kind, meta, goal, goalKey) => {
    if (goalKey === "balanced") {
      if (kind === "research") return gatewayValue(meta) >= 1;
      if (kind === "upgrade" || kind === "religion") return true;
      const profile = metaEffectProfile(meta);
      return Object.keys(profile.perTick).length > 0 || Object.keys(profile.ratio).length > 0 || profile.housing > 0;
    }
    if (kind === "research" && goalClosureNames(goalKey).has(meta.name)) return true;
    if (profileMatchesEmphasis(meta, goal)) return true;
    if (kind === "research" && techUnlocksAligned(meta, goal)) return true;
    if (goal && goal.target) {
      const support = goalSupportResources(goalKey);
      const profile = metaEffectProfile(meta);
      for (const group of [profile.perTick, profile.ratio, profile.max]) {
        for (const name of Object.keys(group)) {
          if (support.has(name)) return true;
        }
      }
    }
    return false;
  };

  const storageBlockPressure = (resources, goal, goalKey) => {
    const pressure = {};
    const visit = (kind, meta) => {
      if (!isOpen(meta)) return;
      const blockers = directStorageBlockers(kind, meta, resources);
      if (!blockers.length || !storageBlockerIsFocused(kind, meta, goal, goalKey)) return;
      let weight = TUNING.pressureKind[kind] || 14;
      if (kind === "research") {
        weight += Math.min(TUNING.pressureGatewayCap, gatewayValue(meta) * TUNING.pressureGatewayScale);
        if (goalClosureNames(goalKey).has(meta.name)) weight += TUNING.pressureClosureBoost;
      }
      for (const blocker of blockers) {
        // Prefer storage that makes the current focus reachable. A tech that is
        // wildly beyond the current cap (e.g. 617K science vs 29K cap) should not
        // drown out a plan that is only waiting on gatherable resources.
        const closeness = Math.max(0.05, Math.min(1, blocker.max / Math.max(1, blocker.need)));
        pressure[blocker.name] = (pressure[blocker.name] || 0) + weight * closeness;
      }
    };

    try {
      for (const t of window.gamePage.science.techs || []) visit("research", t);
    } catch (error) {
      /* ignore */
    }
    try {
      for (const u of window.gamePage.workshop.upgrades || []) visit("upgrade", u);
    } catch (error) {
      /* ignore */
    }
    try {
      for (const u of religionUpgrades()) {
        if (religionUpgradeVisible(u)) visit("religion", u);
      }
    } catch (error) {
      /* ignore */
    }
    try {
      for (const b of buildingMetas()) visit("build", b);
    } catch (error) {
      /* ignore */
    }
    return pressure;
  };

  // Buildings whose live effects PRODUCE a per-tick resource. This is the
  // generic form of the titanium ship/trade path: when the focus is blocked on a
  // resource the village has no source for and can't craft (e.g. a Calciner that
  // needs oil), find the building that makes it (the Oil Well) so the planner can
  // prioritise building the producer first instead of locking an unreachable target.
  const producerBuildingsFor = (name) => {
    const out = [];
    try {
      for (const meta of buildingMetas()) {
        if (!meta || meta.unlocked === false) continue;
        const profile = metaEffectProfile(meta);
        if ((profile.perTick[name] || 0) > 0) out.push(meta);
      }
    } catch (error) {
      /* ignore */
    }
    return out;
  };

  // Resources a FOCUSED candidate needs but the village cannot obtain yet: not
  // craftable, no current production, short of the cost — but a producer building
  // exists. Titanium is excluded (the Zebra/ship path owns it). The result keys
  // are resource names with unmet demand; candidateScore boosts their producers.
  const productionDemand = (resources, goalKey) => {
    const demand = {};
    const goal = GOALS[goalKey];
    const visit = (kind, meta) => {
      if (!isOpen(meta) || !storageBlockerIsFocused(kind, meta, goal, goalKey)) return;
      for (const cost of pricesFor(kind, meta)) {
        if (!cost || !cost.name || !isFinite(cost.val) || cost.val <= 0) continue;
        if (cost.name === "titanium" || craftByName(cost.name)) continue;
        const have = ((getRes(resources, cost.name) || {}).value) || 0;
        if (have >= cost.val || productionFor(cost.name) > 0) continue;
        if (producerBuildingsFor(cost.name).length) demand[cost.name] = (demand[cost.name] || 0) + 1;
      }
    };
    try { for (const t of techList()) visit("research", t); } catch (error) { /* ignore */ }
    try { for (const u of window.gamePage.workshop.upgrades || []) visit("upgrade", u); } catch (error) { /* ignore */ }
    try { for (const u of religionUpgrades()) if (religionUpgradeVisible(u)) visit("religion", u); } catch (error) { /* ignore */ }
    try { for (const b of buildingMetas()) visit("build", b); } catch (error) { /* ignore */ }
    return demand;
  };


  /* -------------------- recursive prerequisite planning ---------------------- */

  // The tech tree is a DAG: tech.unlocks.tech lists children. Walking it both
  // ways gives the two things the old scorer lacked:
  //  - gatewayValue: how much a tech opens up RECURSIVELY (Theology opens the
  //    whole religion branch, Machinery opens Steamworks + key upgrades), so
  //    gateway techs outrank cheap filler;
  //  - frontier: for a LOCKED milestone (like a goal target), the unlocked,
  //    unresearched ancestor techs that actually advance toward it right now.
  let unlockGraphCache = { stamp: "", parents: null, values: null };

  const techList = () => {
    try {
      return window.gamePage.science.techs || [];
    } catch (error) {
      return [];
    }
  };

  const unlockListsOf = (meta) => {
    const lists = [];
    for (const key of ["unlocks", "upgrades"]) {
      const node = meta && meta[key];
      if (!node || typeof node !== "object") continue;
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) lists.push(value);
      }
    }
    return lists;
  };

  const unlockGraph = () => {
    const techs = techList();
    const stamp = `${techs.length}:${techs.filter((t) => t && t.researched).length}`;
    if (unlockGraphCache.parents && unlockGraphCache.stamp === stamp) return unlockGraphCache;
    const parents = {};
    for (const tech of techs) {
      if (!tech || !tech.name) continue;
      const children = (tech.unlocks && tech.unlocks.tech) || [];
      for (const child of children) {
        (parents[child] = parents[child] || []).push(tech);
      }
    }
    unlockGraphCache = { stamp, parents, values: {} };
    return unlockGraphCache;
  };

  const techByName = (name) => techList().find((t) => t && t.name === name) || null;

  // Direct unlock count plus a dampened share of unresearched child techs'
  // value: a tech that opens branches keeps scoring after its children appear.
  const gatewayValue = (tech, depth = 0, seen = new Set()) => {
    if (!tech || !tech.name || depth > 3 || seen.has(tech.name)) return 0;
    seen.add(tech.name);
    const graph = unlockGraph();
    if (depth === 0 && isFinite(graph.values[tech.name])) return graph.values[tech.name];
    let value = unlockListsOf(tech).reduce((sum, list) => sum + list.length, 0);
    for (const childName of (tech.unlocks && tech.unlocks.tech) || []) {
      const child = techByName(childName);
      if (child && !child.researched) value += 0.45 * gatewayValue(child, depth + 1, seen);
    }
    if (depth === 0) graph.values[tech.name] = value;
    return value;
  };

  // Unlocked, unresearched ancestors of a locked tech — the researchable steps
  // that move toward it. Empty when the tech is already open or researched.
  const frontierFor = (techName, depth = 0, seen = new Set()) => {
    if (!techName || depth > 10 || seen.has(techName)) return [];
    seen.add(techName);
    const meta = techByName(techName);
    if (!meta || meta.researched) return [];
    if (meta.unlocked !== false) return [meta];
    const out = [];
    for (const parent of unlockGraph().parents[techName] || []) {
      if (!parent || parent.researched) continue;
      out.push(...frontierFor(parent.name, depth + 1, seen));
    }
    return out;
  };

  const goalMilestoneTech = (goalKey) => {
    const goal = GOALS[goalKey];
    if (!goal || !goal.target) return null;
    return techByName(goal.target) || techList().find((t) => t && metaText(t).includes(goal.target)) || null;
  };

  // Tech names worth pulling toward for the chosen goal: if the goal's
  // milestone tech is locked, its frontier ancestors get a strong boost.
  const goalFrontierNames = (goalKey) => {
    if (tickCache.goalFrontier) return tickCache.goalFrontier;
    const names = new Set();
    const milestone = goalMilestoneTech(goalKey);
    if (milestone && !milestone.researched) {
      if (milestone.unlocked !== false) names.add(milestone.name);
      else for (const tech of frontierFor(milestone.name)) names.add(tech.name);
    }
    tickCache.goalFrontier = names;
    return names;
  };

  // Every unresearched tech on the path to the goal milestone (the milestone's
  // prerequisite closure). Frontier techs are the researchable subset; closure
  // membership marks the rest as goal-relevant even while still locked.
  const goalClosureNames = (goalKey) => {
    if (tickCache.goalClosure) return tickCache.goalClosure;
    const names = new Set();
    const milestone = goalMilestoneTech(goalKey);
    if (milestone && !milestone.researched) {
      const stack = [milestone.name];
      const seen = new Set();
      while (stack.length) {
        const name = stack.pop();
        if (seen.has(name)) continue;
        seen.add(name);
        const meta = techByName(name);
        if (!meta || meta.researched) continue;
        names.add(name);
        for (const parent of unlockGraph().parents[name] || []) {
          if (parent && !parent.researched) stack.push(parent.name);
        }
      }
    }
    tickCache.goalClosure = names;
    return names;
  };

  // Researched/total counts over the milestone's full ancestor chain — powers
  // the "n/m techs" goal progress line.
  const goalProgress = (goalKey) => {
    const milestone = goalMilestoneTech(goalKey);
    if (!milestone) return null;
    const seen = new Set();
    const stack = [milestone.name];
    let total = 0;
    let done = 0;
    while (stack.length) {
      const name = stack.pop();
      if (seen.has(name)) continue;
      seen.add(name);
      const meta = techByName(name);
      if (!meta) continue;
      total += 1;
      if (meta.researched) done += 1;
      for (const parent of unlockGraph().parents[name] || []) {
        if (parent) stack.push(parent.name);
      }
    }
    return { done, total, milestone };
  };

  // Raw resources the goal's frontier techs still need (their prices expanded
  // through craft chains). Anything that produces or stores one of these is
  // genuinely advancing the goal — computed, not keyword-matched.
  const goalSupportResources = (goalKey) => {
    if (tickCache.goalSupport) return tickCache.goalSupport;
    const names = new Set();
    for (const techName of goalFrontierNames(goalKey)) {
      const meta = techByName(techName);
      if (!meta) continue;
      for (const cost of pricesFor("research", meta)) {
        if (!cost || !cost.name || !isFinite(cost.val) || cost.val <= 0) continue;
        names.add(cost.name);
        const raw = rawPathRequirements(cost.name, cost.val);
        for (const name of Object.keys(raw)) names.add(name);
      }
    }
    tickCache.goalSupport = names;
    return names;
  };

  // Does a parsed effect profile fall into a goal emphasis category?
  const profileMatchesCategory = (profile, category) => {
    if (category === "production") {
      return Object.values(profile.perTick).some((v) => v > 0) || Object.values(profile.ratio).some((v) => v > 0);
    }
    if (category === "housing") return profile.housing > 0;
    if (category === "happiness") return profile.happiness > 0;
    if (category === "food") {
      return (profile.perTick.catnip || 0) > 0 || (profile.ratio.catnip || 0) > 0 || (profile.demand.catnip || 0) < 0;
    }
    if (category === "science") {
      return (profile.perTick.science || 0) > 0 || (profile.ratio.science || 0) > 0 || (profile.max.science || 0) > 0;
    }
    if (category === "storage") return Object.keys(profile.max).length > 0;
    return false;
  };

  const profileMatchesEmphasis = (meta, goal) => {
    const emphasis = (goal && goal.emphasis) || {};
    const profile = effectiveMetaProfile(meta);
    return Object.entries(emphasis).some(([category, mult]) => mult > 1 && profileMatchesCategory(profile, category));
  };

  const upgradeByName = (name) => {
    try {
      return (window.gamePage.workshop.upgrades || []).find((u) => u && u.name === name) || null;
    } catch (error) {
      return null;
    }
  };

  // A tech with no aligned effects of its own can still advance an emphasis
  // goal through what it UNLOCKS (Machinery → Steamworks for an industry
  // focus): check the unlocked buildings/upgrades' parsed profiles.
  const techUnlocksAligned = (meta, goal) => {
    const unlocks = (meta && meta.unlocks) || {};
    for (const key of ["buildings", "upgrades"]) {
      const list = unlocks[key];
      if (!Array.isArray(list)) continue;
      for (const name of list) {
        const child = buildingByName(name) || upgradeByName(name);
        if (child && profileMatchesEmphasis(child, goal)) return true;
      }
    }
    return false;
  };

  // Goal alignment without keyword lists: milestone goals score techs by tech-
  // tree closure membership and anything by whether it produces/stores what
  // the goal's frontier techs still need; emphasis goals scale matching effect
  // categories.
  const goalAlignmentBoost = (kind, meta, goalKey) => {
    const goal = GOALS[goalKey];
    if (!goal) return 0;
    let boost = 0;
    if (kind === "research" && goalClosureNames(goalKey).has(meta.name)) boost += TUNING.goalClosureBoost;
    const profile = candidateEffectProfile(kind, meta);
    for (const [category, mult] of Object.entries(goal.emphasis || {})) {
      if (mult > 1 && profileMatchesCategory(profile, category)) boost += (mult - 1) * TUNING.emphasisScale;
    }
    if (kind === "research" && techUnlocksAligned(meta, goal)) boost += TUNING.unlockAlignBoost;
    if (goal.target) {
      const support = goalSupportResources(goalKey);
      if (Object.entries(profile.perTick).some(([name, amount]) => amount > 0 && support.has(name)) ||
          Object.entries(profile.ratio).some(([name, amount]) => amount > 0 && support.has(name))) {
        boost += TUNING.supportProductionBoost;
      }
      if (Object.keys(profile.max).some((name) => support.has(name))) boost += TUNING.supportStorageBoost;
    }
    return boost;
  };

  // Spend-before-store: research/upgrades that consume an almost-full
  // spendable bank (science, faith, culture, catpower) convert otherwise-
  // wasted income into progress and free the cap for the next item — prefer
  // them over raising that cap.
  const spendBonusFor = (kind, meta, resources) => {
    if (kind === "build") return 0;
    let bonus = 0;
    for (const cost of pricesFor(kind, meta)) {
      if (!cost || !cost.name || !isFinite(cost.val) || cost.val <= 0) continue;
      if (!SPENDABLE.includes(cost.name)) continue;
      const res = getRes(resources, cost.name);
      if (!res || !(res.maxValue > 0) || cost.val > res.maxValue) continue;
      const ratio = res.value / res.maxValue;
      if (ratio <= 0.7) continue;
      bonus = Math.max(bonus, TUNING.spendBonus * Math.min(1, res.value / cost.val));
    }
    return bonus;
  };

  const priorityMatchesCandidate = (kind, meta, priority) => {
    if (!priority || priority === "auto") return false;
    const profile = candidateEffectProfile(kind, meta);
    if (priority === "science") return kind === "research";
    if (priority === "workshop") return kind === "upgrade";
    if (priority === "bonfire") return kind === "build";
    if (priority === "storage") return Object.keys(profile.max).length > 0;
    if (priority === "production") {
      return Object.values(profile.perTick).some((v) => v > 0) || Object.values(profile.ratio).some((v) => v > 0);
    }
    return false;
  };

  const manualPriorityBoostFor = (kind, meta) =>
    priorityMatchesCandidate(kind, meta, getPriority()) ? TUNING.manualPriorityBoost : 0;

  // Universal value model: read what a candidate actually does from its parsed
  // effects and price its worth against the CURRENT economy — relative
  // production gains scaled by scarcity, storage scaled by live pressure,
  // housing/happiness by their global multipliers. No per-item keyword boosts.
  const economicValue = (kind, meta, resources, goal, goalKey) => {
    const profile = candidateEffectProfile(kind, meta);
    const pressure = getStoragePressureCached(resources, goal, goalKey);
    const tps = ticksPerSecond();
    let value = 0;
    for (const [name, amount] of Object.entries(profile.perTick)) {
      const perSecond = amount * tps;
      const current = productionFor(name);
      if (perSecond > 0) {
        const relative = perSecond / (Math.abs(current) + perSecond);
        value += relative * (0.35 + scarcityWeight(resources, name)) * TUNING.productionScale;
      } else if (perSecond < 0) {
        const drain = -perSecond / (Math.max(0, current) - perSecond + 0.001);
        value -= Math.min(8, drain * scarcityWeight(resources, name) * TUNING.productionScale * 0.5);
      }
    }
    for (const [name, amount] of Object.entries(profile.ratio)) {
      if (amount <= 0 || productionFor(name) <= 0) continue;
      value += Math.min(1, amount) * (0.35 + scarcityWeight(resources, name)) * TUNING.productionScale * 0.8;
    }
    for (const [name, amount] of Object.entries(profile.max)) {
      if (amount <= 0) continue;
      const relief = pressure[name] || 0;
      if (relief > 0) value += Math.min(TUNING.storageReliefCap, relief);
      else if (!SPENDABLE.includes(name) && resRatio(resources, name, 0) > 0.93 && productionFor(name) > 0) value += 5;
    }
    for (const [name, amount] of Object.entries(profile.demand)) {
      if (amount < 0) value += Math.min(6, -amount * 10 * (0.35 + scarcityWeight(resources, name)));
    }
    if (profile.housing > 0) value += TUNING.housingValue * (0.6 + housingSaturation() * 1.8);
    if (profile.happiness > 0) {
      value += Math.min(TUNING.happinessScale, profile.happiness * (0.5 + Math.max(0, 1 - currentHappinessRatio()) * 4));
    }
    return value;
  };

  const rawProductionForNeed = (name) => {
    const direct = productionFor(name);
    if (name !== "wood") return direct;
    const catnipToWood = productionFor("catnip") / woodCatnipCost();
    return Math.max(direct, direct + Math.max(0, catnipToWood));
  };

  const buildingByName = (name) => buildingMetas().find((meta) => meta && meta.name === name) || null;

  // Match every per-tick effect spelling the game uses — PerTick, PerTickBase,
  // PerTickAutoprod, PerTickCon, PerTickProd — so converters like the Mint
  // (goldPerTickCon/manpowerPerTickCon → fursPerTickProd/ivoryPerTickProd) are
  // recognized from metadata alone, with no name list to maintain.
  const effectResourceName = (effectKey) => {
    const match = String(effectKey || "").match(/^([a-z][a-z0-9]*?)PerTick(?:Base|Autoprod|Con|Prod)?$/i);
    return match ? match[1] : null;
  };

  const resourceNamesFromPrices = (kind, meta) =>
    pricesFor(kind, meta)
      .map((cost) => cost && cost.name)
      .filter(Boolean);

  const processingProfileFor = (meta) => {
    refreshMetaEffects(meta);
    const effects = (meta && meta.effects) || {};
    const inputs = [];
    const outputs = [];
    for (const [key, value] of Object.entries(effects)) {
      if (!isFinite(value) || value === 0) continue;
      const name = effectResourceName(key);
      if (!name) continue;
      if (value < 0) inputs.push(name);
      if (value > 0) outputs.push(name);
    }
    return { inputs: [...new Set(inputs)], outputs: [...new Set(outputs)] };
  };

  // Converters are DISCOVERED, not listed: any owned building whose live
  // effects both consume (…PerTickCon) and produce (…PerTickProd/Autoprod)
  // resources qualifies — smelter, calciner, mint, upgraded steamworks lines
  // and whatever the game adds next. The static input/output maps below are
  // only a fallback for metas whose effects are temporarily unreadable.
  const KNOWN_CONVERTERS = ["smelter", "calciner"];
  // Toggle buildings that are pure benefit while ON (a production/ratio bonus,
  // not a resource-draining conversion).  We keep these switched on for the
  // player instead of leaving the on/off button to be flipped by hand.  If the
  // game ever gives them a real input drain, the live-effect profile picks it
  // up and the starvation guard below throttles them like any other converter.
  const ALWAYS_ON_TOGGLES = ["steamworks"];
  const PROCESSOR_INPUTS = {
    smelter: ["wood", "minerals"],
    calciner: ["minerals", "oil"],
  };
  const PROCESSOR_OUTPUTS = {
    smelter: ["iron", "coal", "gold", "titanium"],
    calciner: ["iron", "titanium", "coal"],
  };

  // A building is "togglable" when the game exposes an on/off count we can set.
  const hasOnToggle = (meta) => meta && typeof meta.on === "number" && meta.val > 0;

  const converterBuildings = () => {
    const out = [];
    const seen = new Set();
    for (const meta of buildingMetas()) {
      if (!meta || !meta.name || meta.unlocked === false || !(meta.val > 0) || seen.has(meta.name)) continue;
      const profile = processingProfileFor(meta);
      const isConverter = profile.inputs.length && profile.outputs.length;
      const managedToggle = hasOnToggle(meta) && (KNOWN_CONVERTERS.includes(meta.name) || ALWAYS_ON_TOGGLES.includes(meta.name));
      if (isConverter || managedToggle) {
        seen.add(meta.name);
        out.push(meta);
      }
    }
    return out;
  };

  const resCapped = (resources, name) => {
    const r = getRes(resources, name);
    return !!(r && r.maxValue > 0 && r.value >= r.maxValue * 0.985);
  };
  const pausedProcessors = {};
  let processingPlanText = "Processing: watching converters";
  let lastProcessingLog = 0;
  // Two thresholds give the on/off controller hysteresis so it cannot flap a
  // converter every 4-second tick: pause an input once it drops below STARVE,
  // but do not resume until it climbs back above RESUME.
  const PROCESSOR_STARVE_RATIO = 0.08;
  const PROCESSOR_RESUME_RATIO = 0.22;

  const refreshAfterProcessorChange = () => {
    try {
      const game = window.gamePage;
      if (game && game.bld && typeof game.bld.updateEffects === "function") game.bld.updateEffects();
      if (game && typeof game.updateResources === "function") game.updateResources();
      if (game && game.bonfireTab && typeof game.bonfireTab.updateTab === "function") game.bonfireTab.updateTab();
    } catch (error) {
      /* ignore UI refresh failures */
    }
  };

  const setProcessorOn = (meta, count) => {
    if (!meta || !isFinite(count)) return false;
    const next = Math.max(0, Math.min(meta.val || 0, Math.floor(count)));
    if ((meta.on || 0) === next) return false;
    meta.on = next;
    refreshAfterProcessorChange();
    return true;
  };

  const missingDirectCosts = (target, resources) => {
    const missing = new Set();
    if (!target) return missing;
    for (const cost of pricesFor(target.kind, target.meta)) {
      if (!cost || !cost.name || !isFinite(cost.val) || cost.val <= 0) continue;
      const have = ((getRes(resources, cost.name) || {}).value) || 0;
      if (have + craftablePotential(cost.name) < cost.val) missing.add(cost.name);
    }
    return missing;
  };

  const converterInputNamesForOutput = (outputName) => {
    const inputs = new Set();
    for (const meta of buildingMetas()) {
      if (!meta || meta.unlocked === false || !(meta.val > 0)) continue;
      const profile = processingProfileFor(meta);
      if (!profile.outputs.includes(outputName)) continue;
      for (const input of profile.inputs) {
        if (getRes(resourceMap(), input)) inputs.add(input);
      }
    }
    return inputs;
  };

  const converterInputsNeededForMissingCosts = (target, resources) => {
    const needed = new Set();
    if (!target) return needed;
    for (const cost of pricesFor(target.kind, target.meta)) {
      if (!cost || !cost.name || !isFinite(cost.val) || cost.val <= 0) continue;
      const have = ((getRes(resources, cost.name) || {}).value) || 0;
      const deficit = Math.max(0, cost.val - have - craftablePotential(cost.name));
      if (deficit <= 0) continue;
      for (const input of converterInputNamesForOutput(cost.name)) needed.add(input);
    }
    return needed;
  };

  const resourcesNeededForTarget = (target, resources) => {
    const needed = new Set(resourceNamesFromPrices(target.kind, target.meta));
    for (const cost of pricesFor(target.kind, target.meta)) {
      if (!cost || !cost.name || !isFinite(cost.val) || cost.val <= 0) continue;
      const have = ((getRes(resources, cost.name) || {}).value) || 0;
      const deficit = Math.max(0, cost.val - have - craftablePotential(cost.name));
      if (deficit <= 0) continue;
      const raw = {};
      rawPathRequirements(cost.name, deficit, raw);
      for (const name of Object.keys(raw)) needed.add(name);
      for (const name of converterInputNamesForOutput(cost.name)) needed.add(name);
    }
    return needed;
  };

  // Decide what each converter should be doing this tick.  Unlike the old
  // one-way "pause when it steals a plan input" logic, this is a full on/off
  // controller: converters (and pure-benefit toggles like the Steamworks) run
  // at FULL by default so the player never has to flip the switch by hand, and
  // are only throttled to 0 for a concrete reason — a plan conflict, a starved
  // input, or producing nothing but capped output.  Returns the target `on`
  // count plus a short reason used for the log line and hysteresis.
  const reservedHoldFor = (reserved, input) =>
    (reserved[input] || 0) || (input === "manpower" ? reserved.catpower || 0 : input === "catpower" ? reserved.manpower || 0 : 0);

  const desiredProcessorState = (meta, resources, missing, needed, reserved) => {
    const name = meta.name;
    const profile = processingProfileFor(meta);
    // Keep only real resources: a live effect can list a pseudo-output such as
    // `cathPollution` that has no resPool entry, so it is never "capped" and
    // would keep the converter looking productive (burning inputs into full
    // storage) forever.  Filtering to actual resources makes the cap and
    // starvation tests below see only what is really produced/consumed.
    const isRealRes = (resName) => !!getRes(resources, resName);
    const inputs = (profile.inputs.length ? profile.inputs : PROCESSOR_INPUTS[name] || []).filter(isRealRes);
    const outputs = (profile.outputs.length ? profile.outputs : PROCESSOR_OUTPUTS[name] || []).filter(isRealRes);
    const full = Math.max(0, meta.val || 0);
    const wasStarvePaused = pausedProcessors[name] && pausedProcessors[name].reason === "starve";
    const lowRatio = wasStarvePaused ? PROCESSOR_RESUME_RATIO : PROCESSOR_STARVE_RATIO;
    const usefulOutputs = outputs.filter((output) => needed.has(output));

    // (a) Plan conflict — the converter eats a resource the focused plan is
    // short on OR has RESERVED (and isn't abundantly above that reservation)
    // while producing nothing the plan needs.  Yield the input so a converter
    // started at full by default cannot drain a stock the plan is saving — e.g.
    // an Academy waiting on science still keeps the minerals it has reserved.
    // Inputs sitting near their cap are exempt: converting that overflow is
    // safe (the reservation keeps a fat buffer) and avoids wasting the surplus.
    const conflictingInputs = usefulOutputs.length ? [] : inputs.filter((input) => {
      if (resRatio(resources, input, 1) >= 0.85) return false;
      return missing.has(input) || reservedHoldFor(reserved, input) > 0;
    });
    if (conflictingInputs.length > 0) {
      return { on: 0, reason: "plan", detail: `saving ${conflictingInputs.map((input) => resTitle(resources, input)).join("+")}` };
    }

    // (b) Base-economy starvation — an input is critically low AND already net
    // draining, so running on would pin it at zero and starve the wider economy
    // (e.g. a Smelter holding wood at 0 to chase a trickle of titanium).  This
    // is NOT overridden by a "needed output": a converter run dry produces
    // almost nothing yet keeps the foundational resource pinned, so protecting
    // the input always wins — the blocking output comes from another path.
    const starvedInputs = inputs.filter((input) => resRatio(resources, input, 1) < lowRatio && productionFor(input) <= 0);
    if (starvedInputs.length > 0) {
      // If this converter is the path to a resource the focused plan is waiting
      // on, do not shut it off completely just because an input is below the
      // broad starvation threshold.  That created a deadlock in mid-game iron
      // saves: the helper would focus an Observatory, reserve its iron, then
      // pause every Smelter "protecting wood", leaving the missing iron to come
      // only from incidental trades.  Keep a small trickle running while there
      // is actual input stock, so the plan advances without letting the whole
      // converter fleet pin the foundation resource at zero.
      const hasInputStock = inputs.every((input) => (((getRes(resources, input) || {}).value) || 0) > 0);
      if (usefulOutputs.length > 0 && hasInputStock) {
        return { on: Math.min(full, Math.max(1, Math.ceil(full * 0.25))), reason: "run", detail: "" };
      }
      return { on: 0, reason: "starve", detail: `protecting ${starvedInputs.map((input) => resTitle(resources, input)).join("+")}` };
    }

    // (c) Nothing useful to make — every output is capped and unneeded, so the
    // converter would just burn inputs into full storage.  Idle it.
    const outputsWanted = outputs.length === 0 || outputs.some((output) => needed.has(output) || !resCapped(resources, output));
    if (!outputsWanted) {
      return { on: 0, reason: "capped", detail: `${outputs.map((output) => resTitle(resources, output)).join("+")} full` };
    }

    // Otherwise: run it at full.
    return { on: full, reason: "run", detail: "" };
  };

  const optimizeProcessing = (resources, goalKey) => {
    try {
      const converters = converterBuildings();
      if (!converters.length) {
        processingPlanText = "Processing: watching converters";
        return;
      }
      const target = getTargetCached(resources, goalKey);
      const missing = target ? missingDirectCosts(target, resources) : new Set();
      const needed = target ? resourcesNeededForTarget(target, resources) : new Set();
      const reserved = target ? reservedNeedsFor(target, resources) : {};
      const changed = [];

      for (const meta of converters) {
        const name = meta.name;
        const currentOn = Math.max(0, meta.on || 0);
        const state = desiredProcessorState(meta, resources, missing, needed, reserved);

        if (state.on <= 0) {
          if (currentOn > 0) {
            pausedProcessors[name] = { on: currentOn, label: labelOf(meta), reason: state.reason };
            if (setProcessorOn(meta, 0)) changed.push(`paused ${labelOf(meta)}${state.detail ? ` (${state.detail})` : ""}`);
          } else if (pausedProcessors[name]) {
            // Keep remembering why it is off so hysteresis/reporting hold.
            pausedProcessors[name].reason = state.reason;
          }
        } else if (currentOn < state.on) {
          if (setProcessorOn(meta, state.on)) {
            changed.push(pausedProcessors[name] ? `resumed ${labelOf(meta)}` : `started ${labelOf(meta)}`);
          }
          delete pausedProcessors[name];
        } else if (pausedProcessors[name]) {
          // Already at/above target and no longer throttled — clear the memo.
          delete pausedProcessors[name];
        }
      }

      if (changed.length) {
        const forText = target && changed.some((item) => /started|resumed/.test(item)) ? ` for ${labelOf(target.meta)}` : "";
        processingPlanText = `Processing: ${changed.join("; ")}${forText}`;
        if (Date.now() - lastProcessingLog > 20000) {
          pushLog(`⚙ ${processingPlanText}`);
          lastProcessingLog = Date.now();
        }
      } else {
        const paused = Object.values(pausedProcessors).map((item) => item.label).filter(Boolean);
        processingPlanText = paused.length ? `Processing: paused ${paused.join(", ")}` : "Processing: converters running";
      }
    } catch (error) {
      /* ignore */
    }
  };

  const waitSecondsForCandidate = (candidate, resources) => {
    if (candidate.affordable) return 0;
    if (directStorageBlockers(candidate.kind, candidate.meta, resources).length) return Number.POSITIVE_INFINITY;
    let worst = 0;
    for (const cost of pricesFor(candidate.kind, candidate.meta)) {
      if (!cost || !cost.name || !isFinite(cost.val) || cost.val <= 0) continue;
      const have = ((getRes(resources, cost.name) || {}).value) || 0;
      const deficit = Math.max(0, cost.val - have - craftablePotential(cost.name));
      if (deficit <= 0) continue;
      if (cost.name === "titanium") {
        const titaniumWait = waitSecondsForZebraTitanium(deficit, resources);
        if (isFinite(titaniumWait)) {
          worst = Math.max(worst, titaniumWait);
          continue;
        }
      }
      // Resources with their own positive net production (wood, minerals…)
      // arrive directly — don't expand them into a craft chain, or a negative
      // catnip rate would mark a 25-second wood wait as "never".
      const directProd = rawProductionForNeed(cost.name);
      if (directProd > 0) {
        worst = Math.max(worst, deficit / directProd);
        continue;
      }
      const raw = {};
      rawPathRequirements(cost.name, deficit, raw);
      const rawEntries = Object.entries(raw);
      if (!rawEntries.length) {
        worst = Math.max(worst, Number.POSITIVE_INFINITY);
        continue;
      }
      for (const [name, amount] of rawEntries) {
        const missing = Math.max(0, amount);
        const prod = rawProductionForNeed(name);
        if (missing <= 0) continue;
        if (prod <= 0) return Number.POSITIVE_INFINITY;
        worst = Math.max(worst, missing / prod);
      }
    }
    return worst;
  };

  // Titanium usually has no ordinary positive production when Mansions and
  // early workshop upgrades first appear. Treating a titanium deficit as a raw
  // "no production" blocker makes those targets look unreachable; treating the
  // current titanium bar as if it will fill by itself makes their ETA read
  // "≈1s" while the player is really waiting on gold/catpower/slabs for Zebra
  // trades.  Model the live Zebra trade route as the production path instead:
  // expected titanium per trade determines how many caravans are needed, and
  // the ETA is the slowest ETA among the resources needed to pay those trades.
  const waitSecondsForZebraTitanium = (titaniumDeficit, resources) => {
    if (!isFinite(titaniumDeficit) || titaniumDeficit <= 0) return 0;
    const zebras = raceByName("zebras");
    if (!zebras || !zebras.unlocked) return Number.POSITIVE_INFINITY;
    const expectedTitanium = Math.max(0, zebraTitaniumStats(resources).expected || 0);
    if (expectedTitanium <= 0) return Number.POSITIVE_INFINITY;
    const tradesNeeded = Math.ceil(titaniumDeficit / expectedTitanium);
    if (tradesNeeded <= 0) return 0;
    let worst = 0;
    for (const price of tradePricesForRace(zebras)) {
      if (!price || !price.name || !isFinite(price.val) || price.val <= 0) continue;
      const required = price.val * tradesNeeded;
      const have = resourceValue(resources, price.name);
      const deficit = Math.max(0, required - have - craftablePotential(price.name));
      if (deficit <= 0) continue;
      const prod = rawProductionForNeed(price.name);
      if (prod <= 0) return Number.POSITIVE_INFINITY;
      worst = Math.max(worst, deficit / prod);
    }
    return worst;
  };

  // VALUE-based scoring. Deliberately NOT dominated by "affordable right now":
  // the executor opportunistically buys cheap ready items from surplus anyway,
  // so the PLAN should be the most valuable reachable step — and the
  // reservation system makes saving for it actually work. One framework for
  // every kind: score = value (parsed economic effects + unlocks + goal
  // alignment + spend-before-store) − cost (time to afford, storage blocks).
  const candidateScore = (candidate, resources, goal, goalKey) => {
    const { kind, meta } = candidate;
    const wait = waitSecondsForCandidate(candidate, resources);
    const waitPenalty = isFinite(wait)
      ? Math.min(TUNING.waitPenaltyCap, Math.log10(wait + 1) * 4)
      : TUNING.unreachablePenalty;
    const storageBlockPenalty = directStorageBlockers(kind, meta, resources).length > 0 ? TUNING.storageBlockPenalty : 0;
    const pressure = getStoragePressureCached(resources, goal, goalKey);
    const idleStoragePenalty = isStorageMeta(meta) && !candidate.affordable && !storageStillWanted(meta, resources, pressure)
      ? TUNING.idleStoragePenalty
      : 0;
    const affordBonus = candidate.affordable
      ? TUNING.affordBonus
      : Math.min(1, Math.max(0, candidate.progress || 0)) * TUNING.progressScale;
    let score = (TUNING.kindPrior[kind] || 3) + affordBonus +
      economicValue(kind, meta, resources, goal, goalKey) +
      goalAlignmentBoost(kind, meta, goalKey) +
      spendBonusFor(kind, meta, resources) +
      manualPriorityBoostFor(kind, meta) +
      noveltyBoostFor(candidate);
    if (speedrunMode() && isEarlyGame()) {
      const profile = candidateEffectProfile(kind, meta);
      const firstInstance = kind === "build" && (!meta.val || meta.val <= 0);
      const unlocksContent = (meta.unlocks && meta.unlocks.length) || (profile.unlocks && profile.unlocks.length);
      score += TUNING.earlyGameBonus * (firstInstance ? 1.4 : 1) * (unlocksContent ? TUNING.earlyGameUnlockMult : 1);
    }
    if (kind === "research") {
      score += Math.min(TUNING.gatewayCap, gatewayValue(meta) * TUNING.gatewayScale);
      if (goalFrontierNames(goalKey).has(meta.name)) score += TUNING.frontierBoost;
    }
    // Producer prerequisite: if this building makes a resource a focused target
    // needs but can't produce or craft (oil for a Calciner), lift it so it is
    // built first — the generic version of the titanium ship/trade path.
    if (kind === "build") {
      const prodDemand = getProductionDemandCached(resources, goalKey);
      if (Object.keys(prodDemand).length) {
        const buildProfile = candidateEffectProfile(kind, meta);
        for (const name of Object.keys(buildProfile.perTick || {})) {
          if ((buildProfile.perTick[name] || 0) > 0 && (prodDemand[name] || 0) > 0) {
            score += TUNING.producerPrereqBoost;
            break;
          }
        }
      }
    }
    return score - waitPenalty - idleStoragePenalty - storageBlockPenalty;
  };

  const gatherCandidates = (resources, goalKey) => {
    const goal = GOALS[goalKey];
    const candidates = [];
    try {
      for (const t of window.gamePage.science.techs || []) {
        if (isOpen(t)) candidates.push({ kind: "research", weight: 4, meta: t });
      }
    } catch (error) {
      /* ignore */
    }
    try {
      for (const u of window.gamePage.workshop.upgrades || []) {
        if (isOpen(u)) candidates.push({ kind: "upgrade", weight: 3, meta: u });
      }
    } catch (error) {
      /* ignore */
    }
    try {
      for (const u of religionUpgrades()) {
        if (religionUpgradeVisible(u)) candidates.push({ kind: "religion", weight: 3, meta: u });
      }
    } catch (error) {
      /* ignore */
    }
    try {
      for (const b of buildingMetas()) {
        if (b && b.unlocked !== false) candidates.push({ kind: "build", weight: 2, meta: b });
      }
    } catch (error) {
      /* ignore */
    }
    try {
      for (const p of spaceMetas()) {
        if (spaceTimeOpen(p)) candidates.push({ kind: "space", weight: 2, meta: p });
      }
    } catch (error) {
      /* ignore */
    }
    try {
      for (const t of timeMetas()) {
        if (spaceTimeOpen(t)) candidates.push({ kind: "time", weight: 2, meta: t });
      }
    } catch (error) {
      /* ignore */
    }
    return candidates
      // Native safety guard: irreversible/permanent actions (reset, transcend,
      // sacrifice, shatter, time-skip, adore) can never become a plan target.
      .filter((c) => c.meta && !isDeniedKey(c.meta.name) && !isNoopPolicyCandidate(c))
      .map((c) => {
        const evaluation = evaluate(c.kind, c.meta, resources);
        const withEvaluation = { ...c, ...evaluation };
        return { ...withEvaluation, score: candidateScore(withEvaluation, resources, goal, goalKey) };
      })
      .sort((a, b) => b.score - a.score);
  };

  /* ---------------- phase-gated hierarchical planner ---------------- */

  // Ordered planner layers.  The highest layer that yields a target wins:
  //   researchSprint > hardUnlock/storage > production/housing/economy > longProject.
  // The Research-sprint layer is a persistent CONTRACT (see activeSprint below):
  // once a sprint owns the plan it is validated — not re-derived — each tick, so
  // spending science on Compendium (which drops science below cap) does NOT hand
  // the plan back to generic scoring / Temple.
  const STRATEGIC_LAYERS = {
    manualQueue: "Manual queue",
    researchSprint: "Research sprint",
    hardUnlock: "Hard unlock / milestone",
    scienceStorageUnlock: "Science storage unlock",
    storage: "Storage blocker",
    production: "Production bottleneck",
    housing: "Housing / population",
    economy: "Economy / normal growth",
    longProject: "Long project",
  };

  let lastStrategicDecision = null;

  const resValueOf = (resources, name) => ((getRes(resources, name) || {}).value) || 0;
  const resMaxOf = (resources, name) => ((getRes(resources, name) || {}).maxValue) || 0;
  const isNearResourceCap = (resources, name, ratio = CAP_RELIEF_RATIO) => {
    const max = resMaxOf(resources, name);
    return max > 0 && resValueOf(resources, name) / max >= ratio;
  };

  const craftChainNamesFor = (name, out = new Set(), depth = 0) => {
    if (!name || depth > 6 || out.has(name)) return out;
    out.add(name);
    const craft = craftByName(name);
    if (!craft) return out;
    for (const price of craftPricesFor(craft)) {
      if (price && price.name) craftChainNamesFor(price.name, out, depth + 1);
    }
    return out;
  };

  const candidateCraftChainResources = (candidate) => {
    const names = new Set();
    if (!candidate) return names;
    for (const cost of pricesFor(candidate.kind, candidate.meta)) {
      if (!cost || !cost.name || cost.val <= 0) continue;
      craftChainNamesFor(cost.name, names);
    }
    return names;
  };

  const candidateUsesAnyCraftChain = (candidate, chain) => {
    if (!candidate || !chain || !chain.size) return false;
    for (const cost of pricesFor(candidate.kind, candidate.meta)) {
      if (cost && chain.has(cost.name)) return true;
    }
    return false;
  };

  const CAPPED_REFILL_RESOURCES = new Set(["science", "culture", "faith"]);
  const HUNT_OUTPUT_RESOURCES = new Set(["furs", "ivory", "spice"]);

  // Repeated cap-drain reachability for craft chains.  A target may need more
  // total science/culture than the bank can hold (e.g. many Compendium crafts),
  // but that is still reachable by spending a capped bank, waiting for refill,
  // and spending it again.  Reject only when one individual craft/research step
  // cannot fit in storage, or when an input has no production/craft/trade path.
  const capDrainReachabilityFor = (resources, name, amount, depth = 0, stack = new Set()) => {
    if (!isFinite(amount) || amount <= 0) return { reachable: true, eta: 0, chain: new Set([name]) };
    if (depth > 8 || stack.has(name)) return { reachable: false, eta: Number.POSITIVE_INFINITY, reason: `no path for ${name}`, chain: new Set([name]) };
    const chain = new Set([name]);
    const max = resMaxOf(resources, name);
    const have = resValueOf(resources, name);
    const deficit = Math.max(0, amount - have);
    const prod = rawProductionForNeed(name);
    if (max > 0 && amount > max && !CAPPED_REFILL_RESOURCES.has(name) && !craftByName(name)) {
      return { reachable: false, eta: Number.POSITIVE_INFINITY, reason: `${resTitle(resources, name)} storage cap blocks ${fmt(amount)}`, chain };
    }
    if (deficit <= 0) return { reachable: true, eta: 0, chain };

    const craft = craftByName(name);
    if (craft) {
      const prices = craftPricesFor(craft).filter((p) => p && p.name && p.val > 0);
      if (!prices.length) return { reachable: false, eta: Number.POSITIVE_INFINITY, reason: `no priced craft path for ${name}`, chain };
      const units = Math.max(1, Math.ceil(deficit / Math.max(1, 1 + craftRatioFor(name))));
      let eta = 0;
      for (const price of prices) {
        const inputCap = resMaxOf(resources, price.name);
        if (inputCap > 0 && price.val > inputCap) {
          return { reachable: false, perStepCapBlocked: true, eta: Number.POSITIVE_INFINITY, reason: `${resTitle(resources, price.name)} cap below one ${craftLabel(name)} craft`, chain };
        }
        const child = capDrainReachabilityFor(resources, price.name, price.val * units, depth + 1, new Set([...stack, name]));
        for (const item of child.chain || []) chain.add(item);
        if (!child.reachable) return { ...child, chain };
        eta = Math.max(eta, child.eta || 0);
      }
      return { reachable: true, eta, chain };
    }

    // Hunts are a repeatable production path, not a one-time storage check.
    // A compendium chain can need many waves of furs; requiring all cumulative
    // furs or catpower up front made capped Acoustics look unreachable whenever
    // catpower was temporarily low.  If catpower can refill (or is already
    // stocked enough for a hunt), furs are reachable by waiting and hunting.
    if (HUNT_OUTPUT_RESOURCES.has(name)) {
      chain.add("manpower");
      const huntCost = Math.max(1, 100 - (typeof window.gamePage.getEffect === "function" ? (window.gamePage.getEffect("huntCatpowerDiscount") || 0) : 0));
      const cp = getRes(resources, "manpower") || getRes(resources, "catpower");
      const cpHave = (cp && cp.value) || 0;
      const cpProd = rawProductionForNeed("manpower");
      if (cpHave >= huntCost || cpProd > 0) {
        const cpWait = cpHave >= huntCost ? 0 : (huntCost - cpHave) / cpProd;
        // Use a conservative per-hunt yield. The exact yield varies by game
        // state, but a positive hunt route is enough for ownership decisions;
        // the executor/job balancer will repeat hunts until the chain clears.
        const hunts = Math.ceil(deficit / 50);
        return { reachable: true, eta: cpWait + Math.max(0, hunts - 1) * huntCost / Math.max(cpProd || huntCost, 1), chain };
      }
    }

    if (prod > 0 || name === "titanium") {
      return { reachable: true, eta: prod > 0 ? deficit / prod : waitSecondsForZebraTitanium(deficit, resources), chain };
    }
    if (CAPPED_REFILL_RESOURCES.has(name)) {
      if (max > 0 && amount > max) return { reachable: true, eta: prod > 0 ? deficit / prod : 0, chain };
      return { reachable: prod > 0, eta: prod > 0 ? deficit / prod : Number.POSITIVE_INFINITY, reason: `no ${resTitle(resources, name)} refill`, chain };
    }
    return { reachable: false, eta: Number.POSITIVE_INFINITY, reason: `no path for ${resTitle(resources, name)}`, chain };
  };

  const hasObtainablePathFor = (resources, name, amount) => capDrainReachabilityFor(resources, name, amount).reachable;

  const researchScienceCost = (tech) => {
    const price = pricesFor("research", tech).find((cost) => cost && cost.name === "science" && isFinite(cost.val) && cost.val > 0);
    return price ? price.val : 0;
  };

  // Cap-drain banks are spent-and-refilled across ticks (science/culture/faith).
  // Their final purchase must fit storage all at once, but a craft chain may need
  // far more cumulative units than the cap holds — that is reachable by repeated
  // spend/refill cycles.  Huntable resources are produced by repeatable hunts.
  const CAP_DRAIN_RESOURCES = new Set(["science", "culture", "faith"]);
  const HUNTABLE_RESOURCES = new Set(["furs", "ivory", "spice"]);

  const scienceStorageReason = (tech, resources) => {
    const cost = researchScienceCost(tech);
    const max = resMaxOf(resources, "science");
    return `science storage blocked ${fmt(max)}/${fmt(cost)}`;
  };

  // A research's own final science price must fit current science storage. If it
  // does not, the tech is storage-blocked (Electricity) — it may inform the
  // storage layer but can NEVER be an active research-sprint craft target.
  const finalScienceFitsCap = (tech, resources) => {
    const cost = researchScienceCost(tech);
    const max = resMaxOf(resources, "science");
    return !(cost > 0 && max > 0 && cost > max);
  };

  /* ----------------------------- craft-chain solver -------------------------
   * Can `target` (any candidate) actually be reached from the current board?
   * Returns a rich, testable result rather than a single boolean:
   *   { reachable, hardBlocked, blockers, protectedChain, currentStep,
   *     neededText, eta, perStepCapsOk, finalPurchaseCapsOk }
   * Cumulative cap-drain cost (science/culture across many Compendium crafts)
   * does NOT need to fit at once; only each individual craft/research STEP and
   * the final tech purchase must fit storage.
   */
  const deepestActionableStep = (resources, name, depth = 0, seen = new Set()) => {
    if (depth > 7 || seen.has(name)) return name;
    seen.add(name);
    const craft = craftByName(name);
    if (!craft) return name; // raw / produced / huntable input — make it directly
    const prices = craftPricesFor(craft).filter((p) => p && p.name && p.val > 0);
    // Descend into a craftable input that is itself still short.
    for (const price of prices) {
      if (resValueOf(resources, price.name) < price.val && craftByName(price.name)) {
        return deepestActionableStep(resources, price.name, depth + 1, seen);
      }
    }
    // Otherwise surface a short non-craft input (furs to hunt, science to refill).
    for (const price of prices) {
      if (resValueOf(resources, price.name) < price.val && !craftByName(price.name)) return price.name;
    }
    return name; // every input on hand — craft this now
  };

  const solveCraftChain = (resources, target) => {
    const protectedChain = new Set();
    const blockers = [];
    let eta = 0;
    let perStepCapsOk = true;
    let finalPurchaseCapsOk = true;
    let firstShortCraft = null;

    for (const cost of pricesFor(target.kind, target.meta)) {
      if (!cost || !cost.name || !isFinite(cost.val) || cost.val <= 0) continue;
      const cap = resMaxOf(resources, cost.name);
      const have = resValueOf(resources, cost.name);
      // Direct final cost in a non-craftable bank above its cap = storage-blocked.
      if (!craftByName(cost.name) && cap > 0 && cost.val > cap && !HUNTABLE_RESOURCES.has(cost.name)) {
        finalPurchaseCapsOk = false;
        protectedChain.add(cost.name);
        blockers.push({ name: cost.name, kind: "finalCap", need: cost.val, cap, text: `${resTitle(resources, cost.name)} storage ${fmt(cap)}/${fmt(cost.val)}` });
        continue;
      }
      if (have >= cost.val) { protectedChain.add(cost.name); continue; }
      if (craftByName(cost.name) && !firstShortCraft) firstShortCraft = cost.name;
      const reach = capDrainReachabilityFor(resources, cost.name, cost.val);
      for (const item of reach.chain || []) protectedChain.add(item);
      eta = Math.max(eta, isFinite(reach.eta) ? reach.eta : 0);
      if (reach.perStepCapBlocked) perStepCapsOk = false;
      if (!reach.reachable) {
        blockers.push({ name: cost.name, kind: reach.perStepCapBlocked ? "stepCap" : "unreachable", text: reach.reason || `no path for ${resTitle(resources, cost.name)}` });
      }
    }

    const currentStep = firstShortCraft ? deepestActionableStep(resources, firstShortCraft) : "";
    const hardBlocked = !finalPurchaseCapsOk || !perStepCapsOk || blockers.some((b) => b.kind === "unreachable");
    const reachable = !hardBlocked;
    const missing = pricesFor(target.kind, target.meta)
      .filter((cost) => cost && cost.name && cost.val > 0 && resValueOf(resources, cost.name) < cost.val)
      .map((cost) => `${fmt(cost.val - resValueOf(resources, cost.name))} ${craftByName(cost.name) ? craftLabel(cost.name) : resTitle(resources, cost.name)}`);
    return { reachable, hardBlocked, blockers, protectedChain, currentStep, neededText: missing.slice(0, 3).join(", "), eta, perStepCapsOk, finalPurchaseCapsOk };
  };

  /* ------------------------- research-sprint contracts ----------------------
   * A research SPRINT is a persistent contract owning the plan while an
   * actionable tech is assembled across many ticks.  It is the structural fix
   * for the "science cap layer disappears → Temple" bug: science being near cap
   * can START a sprint, but is NEVER required to KEEP it.
   */
  let activeSprint = null;
  // {
  //   id, techName, startedAt, reason, protectedChain, lastValidatedAt,
  //   blockers, currentStep, solver, candidate
  // }

  // A tech is "chain-gated" when it still needs a craftable intermediate it does
  // not yet hold enough of (Compendium for Acoustics).  This is the multi-tick
  // case that must persist as a sprint even when science is well below cap.
  const researchChainGated = (tech, resources) =>
    pricesFor("research", tech).some((cost) =>
      cost && cost.name && cost.val > 0 && craftByName(cost.name) && resValueOf(resources, cost.name) < cost.val);

  // What can START a new sprint: science at/near cap, OR a clear actionable
  // craft-chain path.  (Cheap science-only techs go through normal scoring.)
  const sprintTriggered = (tech, resources) =>
    isNearResourceCap(resources, "science") || researchChainGated(tech, resources);

  // Build the actionable / deferred research buckets for sprint planning.
  // Actionable: open, unresearched, final science fits cap, chain reachable, and
  // sprint-triggered.  Deferred: storage-blocked (Electricity) or hard-blocked.
  const actionableResearchSprints = (candidates, resources, goalKey) => {
    const actionable = [];
    const deferred = [];
    for (const candidate of candidates) {
      if (candidate.kind !== "research" || !candidate.meta || candidate.meta.researched || !isOpen(candidate.meta)) continue;
      if (!finalScienceFitsCap(candidate.meta, resources)) {
        deferred.push({ candidate, reason: scienceStorageReason(candidate.meta, resources), kind: "storage" });
        continue;
      }
      const solver = solveCraftChain(resources, candidate);
      if (!solver.reachable) {
        deferred.push({ candidate, reason: (solver.blockers[0] && solver.blockers[0].text) || "unreachable prerequisite", kind: "hardBlocked" });
        continue;
      }
      if (!sprintTriggered(candidate.meta, resources)) continue; // actionable but not a multi-tick sprint
      const profile = candidateEffectProfile(candidate.kind, candidate.meta);
      const goalPath = goalFrontierNames(goalKey).has(candidate.meta.name) || goalClosureNames(goalKey).has(candidate.meta.name);
      const unlockValue = gatewayValue(candidate.meta) + (profile.unlocks || []).length + Object.keys(profile.perTick || {}).length;
      const sciCost = researchScienceCost(candidate.meta);
      const phaseScore = (goalPath ? 10000 : 0) + unlockValue * 100 - (solver.eta || 0) / 60 - sciCost / 100000;
      actionable.push({ candidate, solver, phaseScore });
    }
    actionable.sort((a, b) => b.phaseScore - a.phaseScore);
    return { actionable, deferred };
  };

  const sprintCandidate = (sprint, candidates) =>
    candidates.find((c) => c.kind === "research" && c.meta && c.meta.name === sprint.techName) || null;

  // A sprint stays valid while its tech is still open, unresearched, its final
  // science cost fits cap and its chain is not hard-blocked.  Crucially this does
  // NOT require science near cap and does NOT require it to still be chain-gated.
  const sprintStillValid = (sprint, candidates, resources) => {
    if (!sprint) return { valid: false };
    const candidate = sprintCandidate(sprint, candidates);
    if (!candidate) return { valid: false, reason: `${sprint.techName} no longer available` };
    const meta = candidate.meta;
    if (meta.researched) return { valid: false, reason: `${labelOf(meta)} researched` };
    if (!isOpen(meta)) return { valid: false, reason: `${labelOf(meta)} no longer open` };
    if (!finalScienceFitsCap(meta, resources)) return { valid: false, reason: scienceStorageReason(meta, resources) };
    const solver = solveCraftChain(resources, candidate);
    if (solver.hardBlocked) return { valid: false, reason: (solver.blockers[0] && solver.blockers[0].text) || "hard-blocked" };
    return { valid: true, candidate, solver };
  };

  // Validate the existing sprint (keep it), else discover a new one. Returns
  // { sprint, deferred, actionable }.  Pure on resources except for the
  // module-level activeSprint contract it manages.
  const planResearchSprint = (candidates, resources, goalKey) => {
    const { actionable, deferred } = actionableResearchSprints(candidates, resources, goalKey);
    if (activeSprint) {
      const check = sprintStillValid(activeSprint, candidates, resources);
      if (check.valid) {
        activeSprint.lastValidatedAt = Date.now();
        activeSprint.candidate = check.candidate;
        activeSprint.solver = check.solver;
        activeSprint.protectedChain = check.solver.protectedChain.size ? check.solver.protectedChain : activeSprint.protectedChain;
        activeSprint.currentStep = check.solver.currentStep;
        activeSprint.blockers = check.solver.blockers;
        return { sprint: activeSprint, deferred, actionable };
      }
      if (check.reason) pushLog(`✅ research sprint ended: ${check.reason}`);
      activeSprint = null;
    }
    if (actionable.length) {
      const best = actionable[0];
      activeSprint = {
        id: targetId(best.candidate),
        techName: best.candidate.meta.name,
        startedAt: Date.now(),
        lastValidatedAt: Date.now(),
        reason: isNearResourceCap(resources, "science") ? "science at cap" : "actionable research chain",
        protectedChain: best.solver.protectedChain,
        blockers: best.solver.blockers,
        currentStep: best.solver.currentStep,
        solver: best.solver,
        candidate: best.candidate,
      };
      pushLog(`🔬 research sprint: ${labelOf(best.candidate.meta)} (${activeSprint.reason})`);
      return { sprint: activeSprint, deferred, actionable };
    }
    return { sprint: null, deferred, actionable };
  };



  const scienceStorageGain = (candidate) => {
    if (!candidate) return 0;
    const profile = candidateEffectProfile(candidate.kind, candidate.meta);
    return Math.max(0, (profile.max && profile.max.science) || 0) + Math.max(0, (profile.ratio && profile.ratio.science) || 0) * Math.max(1, resMaxOf(resourceMap(), "science"));
  };

  const scienceStorageUnlockCandidate = (candidate, resources) => {
    if (!candidate || candidate.kind === "policy") return false;
    if (candidate.kind === "research" && candidate.meta && !finalScienceFitsCap(candidate.meta, resources)) return false;
    const profile = candidateEffectProfile(candidate.kind, candidate.meta);
    if (((profile.max && profile.max.science) || 0) > 0 || ((profile.ratio && profile.ratio.science) || 0) > 0) return true;
    const text = effectText(candidate.meta);
    return /scienceMax|scienceMaxRatio|science storage|science cap|observatory|academy|library/i.test(text);
  };

  // The next blocked tech counts as a near-term storage "sprint" only when it can
  // be reached by at most ~doubling the current science cap.  A tech far above the
  // cap (e.g. 4x) is a long storage grind — forcing it would spam endless Libraries
  // ahead of real economy growth, so those fall back to normal scoring instead.
  const SCIENCE_UNLOCK_REACH = 2;

  // Science-storage unlock is a UNIVERSAL invariant — goal-independent (balanced,
  // speedrun, milestone) AND science-VALUE-independent.  The trigger is purely
  // structural: the NEXT valuable research (cheapest open, unresearched, content-
  // unlocking tech) cannot fit the science CAP.  When that holds, science will
  // climb to the cap and stall there forever until storage grows, so we grow
  // science storage instead of (a) targeting that research directly or (b) letting
  // any long project such as Temple win — regardless of how much science is banked
  // right now.  This is the fix for the regression where the plan flickered back to
  // Temple the moment science dropped below the cap mid-build (releasing the
  // reserved Observatory inputs).  We pick the best actionable cap-growth candidate
  // (Library / Academy / Observatory / any scienceMax-style effect).  Returns null
  // when the next valuable tech already fits the cap (just research it), when it is
  // too far above the cap to be a near-term sprint, or when nothing actionable can
  // grow the cap — the "unless no science-storage candidate is actionable" escape,
  // after which normal scoring (and eventually a long project) may resume.
  // Sticky cap-growth choice.  The game frequently doesn't expose a building's
  // scienceMax/scienceRatio until calculateEffects runs, so scienceStorageGain can
  // tie at 0 and the secondary score/wait keys wobble tick-to-tick — which made the
  // plan flicker between e.g. Library and Observatory.  We remember the chosen
  // building and keep it until it leaves the option set or a rival is clearly
  // better, so the planner commits instead of oscillating.
  let activeScienceUnlockId = null;

  const bestScienceStorageUnlock = (candidates, resources) => {
    const max = resMaxOf(resources, "science");
    if (max <= 0) { activeScienceUnlockId = null; return null; }
    // The next valuable research = cheapest open, unresearched, content-unlocking
    // tech.  A filler tech with no unlocks (no gateway value) must never anchor a
    // storage sprint, so it is excluded here.
    const next = candidates
      .filter((c) => c.kind === "research" && c.meta && isOpen(c.meta) && gatewayValue(c.meta) > 0)
      .map((c) => ({ c, cost: researchScienceCost(c.meta) }))
      .filter((item) => item.cost > 0)
      .sort((a, b) => a.cost - b.cost)[0];
    // The next valuable tech is missing, already fits the cap (just research it),
    // or is too far above the cap to be a near-term sprint → not a storage problem.
    if (!next || next.cost <= max || next.cost > max * SCIENCE_UNLOCK_REACH) {
      activeScienceUnlockId = null;
      return null;
    }
    const blocked = next.c;
    const need = Math.max(0, next.cost - max);
    const options = candidates
      .filter((candidate) => targetId(candidate) !== targetId(blocked))
      .filter((candidate) => scienceStorageUnlockCandidate(candidate, resources))
      .filter((candidate) => !directStorageBlockers(candidate.kind, candidate.meta, resources).length)
      .map((candidate) => ({ candidate, gain: scienceStorageGain(candidate), wait: waitSecondsForCandidate(candidate, resources) }))
      .filter((item) => isFinite(item.wait));
    if (!options.length) { activeScienceUnlockId = null; return null; }
    options.sort((a, b) => (b.gain - a.gain) || ((b.candidate.score || 0) - (a.candidate.score || 0)) || (a.wait - b.wait));
    // Commit to the prior choice while it is still a valid option; only switch when
    // a rival actually grows the cap meaningfully more (>20% gain).  When gains tie
    // at 0 this always keeps the prior pick, killing the Library↔Observatory flicker.
    const best = options[0];
    const prior = activeScienceUnlockId && options.find((o) => targetId(o.candidate) === activeScienceUnlockId);
    const chosen = prior && !(best.gain > 0 && best.gain > prior.gain * 1.2) ? prior : best;
    activeScienceUnlockId = targetId(chosen.candidate);
    return { target: chosen.candidate, blocked, need };
  };

  // Resolve the front-most ACTIONABLE manual-queue item to a strategic target.
  // Completed items (researched / one more built) are dropped from storage; an
  // item that isn't currently a reachable candidate (still locked, or storage-
  // blocked) is skipped so the queue can never stall the bot — the next workable
  // item, or the autopilot, takes over.  Returns { candidate, solver } or null.
  // Resolve a queued targetId to its live game meta even when it is no longer a
  // candidate (e.g. a researched tech drops out of the open list) — needed so a
  // completed item can be detected and removed.
  const lookupMetaById = (id) => {
    const [kind, name] = String(id).split(":");
    try {
      if (kind === "research") return techByName(name);
      if (kind === "build") return buildingByName(name);
      if (kind === "upgrade") return (window.gamePage.workshop.upgrades || []).find((u) => u.name === name) || null;
      if (kind === "religion") return religionUpgrades().find((u) => u.name === name) || null;
      if (kind === "space") return spaceMetas().find((m) => m.name === name) || null;
      if (kind === "time") return timeMetas().find((m) => m.name === name) || null;
    } catch (error) {
      /* meta not available */
    }
    return null;
  };

  const queueItemDone = (item) => {
    const [kind] = String(item.id).split(":");
    const meta = lookupMetaById(item.id);
    if (!meta) return false; // unknown / not yet unlocked → keep it queued
    if (kind === "research" || kind === "upgrade" || kind === "policy") return !!meta.researched;
    if (kind === "religion") return religionUpgradePurchased(meta);
    return (Number(meta.val) || 0) > (Number(item.val) || 0); // one more built
  };

  const pickQueuedTarget = (candidates, resources) => {
    const queue = readQueue();
    if (!queue.length) return null;
    let chosen = null;
    let changed = false;
    const remaining = [];
    for (const item of queue) {
      if (queueItemDone(item)) { changed = true; continue; } // drop finished item, advance
      remaining.push(item);
      if (chosen) continue;
      const candidate = findCandidateById(candidates, item.id);
      if (candidate) {
        const solver = solveCraftChain(resources, candidate);
        if (solver.reachable) chosen = { candidate, solver }; // first actionable item wins
      }
    }
    if (changed) writeQueue(remaining);
    return chosen;
  };

  const classifyCandidateLayer = (candidate, resources, goalKey) => {
    if (!candidate) return STRATEGIC_LAYERS.economy;
    if (candidate.kind === "research" || candidate.kind === "upgrade") {
      const profile = candidateEffectProfile(candidate.kind, candidate.meta);
      if (goalFrontierNames(goalKey).has(candidate.meta.name) || goalClosureNames(goalKey).has(candidate.meta.name) ||
          gatewayValue(candidate.meta) > 0 || (profile.unlocks || []).length || Object.keys(profile.perTick || {}).length) {
        return STRATEGIC_LAYERS.hardUnlock;
      }
    }
    if (directStorageBlockers(candidate.kind, candidate.meta, resources).length > 0 || isStorageMeta(candidate.meta)) return STRATEGIC_LAYERS.storage;
    if (candidate.kind === "build" && ["hut", "logHouse", "mansion"].includes(candidate.meta && candidate.meta.name)) return STRATEGIC_LAYERS.housing;
    if (candidate.kind === "religion" || candidate.kind === "space" || candidate.kind === "time" ||
        (candidate.kind === "build" && ["temple", "ziggurat"].includes(candidate.meta && candidate.meta.name))) return STRATEGIC_LAYERS.longProject;
    return STRATEGIC_LAYERS.economy;
  };

  const isLongProject = (candidate, resources, goalKey) =>
    !!candidate && classifyCandidateLayer(candidate, resources, goalKey) === STRATEGIC_LAYERS.longProject;

  // Items deferred behind an active sprint, for the details panel: storage-blocked
  // future research (Electricity) and long projects / chain-users (Temple).
  const buildSprintDeferrals = (candidates, resources, goalKey, target, protectedChain, deferred) => {
    const out = [];
    for (const item of deferred) out.push({ target: item.candidate, reason: item.reason });
    const chainUsers = candidates
      .filter((c) => c !== target && targetId(c) !== targetId(target))
      .filter((c) => isLongProject(c, resources, goalKey) || candidateUsesAnyCraftChain(c, protectedChain))
      .sort((a, b) => (b.score || 0) - (a.score || 0))
      .slice(0, 3)
      .map((c) => ({
        target: c,
        reason: candidateUsesAnyCraftChain(c, protectedChain)
          ? `active Research sprint owns ${[...protectedChain].filter((n) => craftByName(n)).slice(0, 2).map((n) => resTitle(resources, n)).join("/") || "craft"} chain`
          : "deferred behind active Research sprint",
      }));
    for (const item of chainUsers) out.push(item);
    return out.slice(0, 6);
  };

  /* ------------------------------ layer selector ----------------------------
   * Ordered: safety guard (upstream) → active/new research sprint → storage /
   * economy scoring → long project.  Long projects can only win when no sprint
   * owns the plan.
   */
  const selectStrategicTarget = (resources, goalKey) => {
    const candidates = gatherCandidates(resources, goalKey);

    // Manual queue wins outright when its front item is actionable — the player's
    // explicit pick (Magneto, a workshop upgrade, a specific tech) outranks the
    // autopilot.  A blocked/locked queue item is skipped inside pickQueuedTarget,
    // so this never stalls the bot; it just falls through to autopilot below.
    const queued = pickQueuedTarget(candidates, resources);
    if (queued && queued.candidate) {
      const protectedChain = queued.solver.protectedChain && queued.solver.protectedChain.size
        ? queued.solver.protectedChain : candidateCraftChainResources(queued.candidate);
      return {
        candidates,
        target: queued.candidate,
        layer: STRATEGIC_LAYERS.manualQueue,
        reason: `manual queue: ${labelOf(queued.candidate.meta)}`,
        protectedChain,
        rejectedTopCandidates: [],
      };
    }

    const { sprint, deferred } = planResearchSprint(candidates, resources, goalKey);

    if (sprint && sprint.candidate) {
      const target = sprint.candidate;
      const protectedChain = sprint.protectedChain && sprint.protectedChain.size ? sprint.protectedChain : candidateCraftChainResources(target);
      const chainText = [...protectedChain].filter((n) => craftByName(n)).slice(0, 3).map((n) => resTitle(resources, n)).join("→") || "science";
      return {
        candidates,
        target,
        layer: STRATEGIC_LAYERS.researchSprint,
        reason: `${labelOf(target.meta)} research sprint owns the ${chainText} chain`,
        protectedChain,
        sprint,
        rejectedTopCandidates: buildSprintDeferrals(candidates, resources, goalKey, target, protectedChain, deferred),
      };
    }

    const scienceUnlock = bestScienceStorageUnlock(candidates, resources);
    if (scienceUnlock && scienceUnlock.target) {
      const target = scienceUnlock.target;
      return {
        candidates,
        target,
        layer: STRATEGIC_LAYERS.scienceStorageUnlock,
        reason: `${labelOf(scienceUnlock.blocked.meta)} is storage-blocked; adding ${fmt(scienceUnlock.need)} science storage`,
        protectedChain: candidateCraftChainResources(target),
        scienceStorageBlocker: scienceUnlock,
        rejectedTopCandidates: [
          { target: scienceUnlock.blocked, reason: `storage-blocked: need +${fmt(scienceUnlock.need)} science storage` },
          ...candidates.filter((candidate) => isLongProject(candidate, resources, goalKey)).slice(0, 2).map((candidate) => ({ target: candidate, reason: `deferred until ${labelOf(scienceUnlock.blocked.meta)} fits science storage` })),
        ],
      };
    }

    // No sprint/storage-unlock: fall back to the mature ROI scorer (storage / production /
    // housing / economy / long project), which already raises storage blockers
    // and producer prerequisites by pressure.
    const target = candidates[0] || null;
    const activeLayer = classifyCandidateLayer(target, resources, goalKey);
    const rejected = candidates.find((candidate) => targetId(candidate) !== targetId(target)) || null;
    return {
      candidates,
      target,
      layer: activeLayer,
      reason: `selected best candidate inside ${activeLayer} layer`,
      protectedChain: candidateCraftChainResources(target),
      rejectedTopCandidates: rejected ? [{ target: rejected, reason: `lower score inside ${activeLayer} layer` }] : [],
    };
  };

  const CAP_RELIEF_RATIO = 0.985;

  // Catpower/manpower has its own relief valve (hunting), so urgent purchase
  // relief is for banks whose income is otherwise wasted at the cap.
  const CAPPED_PURCHASE_RESOURCES = ["science", "culture", "faith"];

  const cappedSpendableResources = (resources) => CAPPED_PURCHASE_RESOURCES.filter((name) => {
    const res = getRes(resources, name);
    return res && res.maxValue > 0 && res.value / res.maxValue >= CAP_RELIEF_RATIO;
  });

  const candidateSpendsAny = (candidate, names) => {
    if (!candidate || !names || !names.length) return false;
    return pricesFor(candidate.kind, candidate.meta).some((cost) => cost && names.includes(cost.name));
  };

  const TARGET_LOCK_MAX_MS = 360000;
  const getTargetLockMinMs = () => {
    if (isEarlyGame()) return TARGET_LOCK_MIN_EARLY_MS;
    if (isMidGame()) return TARGET_LOCK_MIN_MID_MS;
    return TARGET_LOCK_MIN_LATE_MS;
  };
  const TARGET_READY_GRACE_MS = 20000;
  let activeTarget = null;

  const targetId = (candidate) => candidate && candidate.meta ? `${candidate.kind}:${candidate.meta.name || labelOf(candidate.meta)}` : "";

  const findCandidateById = (candidates, id) => candidates.find((candidate) => targetId(candidate) === id) || null;

  const targetComplete = (candidate) => {
    if (!candidate || !candidate.meta) return true;
    if (candidate.kind === "research" || candidate.kind === "upgrade" || candidate.kind === "policy") return !!candidate.meta.researched;
    if (candidate.kind === "religion") return religionUpgradePurchased(candidate.meta);
    if (VAL_BASED_KINDS.has(candidate.kind) && activeTarget && activeTarget.id === targetId(candidate)) {
      return (candidate.meta.val || 0) > (activeTarget.initialVal || 0) && Date.now() - activeTarget.startedAt > TARGET_READY_GRACE_MS;
    }
    return false;
  };

  /* --------------------------- new-unlock watching --------------------------- */

  // The game keeps opening new content as you play (Mint, Mansion, Observatory,
  // new techs/upgrades/religion items, …). When something NEW becomes available
  // the autopilot must notice on its own: log it, break the current target lock
  // so the next plan choice weighs the newcomer, and give it a short evaluation
  // boost so fresh options are folded into the progression instead of waiting
  // behind an old lock. This is fully generic — anything gatherCandidates can
  // see is watched, so future game content needs no code changes.
  const NOVELTY_MS = 10 * 60 * 1000;
  let knownUnlockIds = null; // null until the first tick seeds the baseline
  const noveltyUntil = {};

  const noveltyBoostFor = (candidate) => {
    const until = noveltyUntil[targetId(candidate)];
    return until && until > Date.now() ? TUNING.noveltyBoost : 0;
  };

  const watchNewUnlocks = () => {
    try {
      const ids = new Set();
      const fresh = [];
      const note = (kind, meta, open) => {
        if (!open || !meta || !meta.name) return;
        const id = `${kind}:${meta.name}`;
        ids.add(id);
        if (knownUnlockIds && !knownUnlockIds.has(id)) fresh.push({ id, meta });
      };
      for (const t of techList()) note("research", t, isOpen(t));
      try {
        for (const u of window.gamePage.workshop.upgrades || []) note("upgrade", u, isOpen(u));
      } catch (error) {
        /* ignore */
      }
      for (const u of religionUpgrades()) note("religion", u, religionUpgradeVisible(u));
      for (const b of buildingMetas()) note("build", b, !!b && b.unlocked !== false);
      if (knownUnlockIds && fresh.length) {
        const now = Date.now();
        for (const item of fresh) noveltyUntil[item.id] = now + NOVELTY_MS;
        activeTarget = null; // replan with the newcomers in the running
        const shown = fresh.slice(0, 3).map((item) => labelOf(item.meta)).join(", ");
        pushLog(`🆕 unlocked: ${shown}${fresh.length > 3 ? ` +${fresh.length - 3} more` : ""} — replanning`);
      }
      knownUnlockIds = ids;
    } catch (error) {
      /* ignore unlock-watch failures */
    }
  };

  const chooseWorkTarget = (resources, goalKey) => {
    const decision = selectStrategicTarget(resources, goalKey);
    lastStrategicDecision = decision;
    tickCache.candidates = decision.candidates;
    const candidates = decision.candidates;
    const preferred = decision.target || candidates[0] || null;
    const now = Date.now();

    // Structural override layers OWN the plan directly and must never be held
    // back by a stale economy target lock (e.g. a half-saved Temple): a valid
    // research sprint is its own cross-tick contract (validated in
    // planResearchSprint), and a science-storage unlock outranks every long
    // project while a valuable tech is cap-blocked.  Return that target directly.
    if (decision.layer === STRATEGIC_LAYERS.manualQueue ||
        decision.layer === STRATEGIC_LAYERS.researchSprint ||
        decision.layer === STRATEGIC_LAYERS.scienceStorageUnlock) {
      activeTarget = null;
      return preferred;
    }

    // Non-sprint economy lock: makes ordinary plans (Library, Mine, …) PUSH
    // THROUGH. The executor reserves the locked target's resources and buys it
    // the moment it is ready, so the lock only breaks on completion, a storage
    // block, a long timeout, a far-cheaper research, or a much better rival.
    if (activeTarget) {
      const locked = findCandidateById(candidates, activeTarget.id);
      const age = now - activeTarget.startedAt;
      const lockedWait = locked ? waitSecondsForCandidate(locked, resources) : 0;
      const preferredWait = preferred ? waitSecondsForCandidate(preferred, resources) : Number.POSITIVE_INFINITY;
      const lockedIsStaleStorage = locked && isStorageMeta(locked.meta) && !locked.affordable && lockedWait > 900 &&
        !storageStillWanted(locked.meta, resources, getStoragePressureCached(resources, GOALS[goalKey], goalKey));
      const lockedIsStorageBlocked = locked && directStorageBlockers(locked.kind, locked.meta, resources).length > 0;
      const muchBetter = preferred && locked && age >= getTargetLockMinMs() && preferred.score > locked.score * 1.3 + 8;
      const nearTechBreak = locked && preferred && preferred.kind === "research" && lockedWait > 900 && preferredWait < 900 && targetId(locked) !== targetId(preferred);
      if (!locked || targetComplete(locked) || age > TARGET_LOCK_MAX_MS || lockedIsStaleStorage ||
          lockedIsStorageBlocked || nearTechBreak) {
        activeTarget = null;
      } else if (!muchBetter) {
        lastStrategicDecision.target = locked;
        return locked;
      } else {
        activeTarget = null;
      }
    }

    if (preferred) {
      activeTarget = {
        id: targetId(preferred),
        startedAt: now,
        initialVal: VAL_BASED_KINDS.has(preferred.kind) ? preferred.meta.val || 0 : 0,
        layer: decision.layer,
      };
    }
    return preferred;
  };

  // While a research sprint owns the plan, jobs serve the sprint's craft chain
  // and nothing else: missing Compendium → Manuscript/Science, Manuscript →
  // Parchment/Culture, Parchment → Furs, Furs → Catpower/Hunter.  Priests and
  // scholars are suppressed unless their bank is the genuine bottleneck.
  const researchSprintJobNeeds = (sprint, resources) => {
    const needs = {};
    const target = sprint.candidate;
    const chain = sprint.protectedChain || new Set();
    jobSuppressText = "Suppressed: faith baseline during Research sprint";

    // Map each still-missing chain cost onto the jobs that can refill it. This
    // walks craft prices recursively, so Furs lands on Hunters (manpower).
    for (const cost of pricesFor(target.kind, target.meta)) {
      if (!cost || !cost.name || !isFinite(cost.val) || cost.val <= 0) continue;
      if (resValueOf(resources, cost.name) >= cost.val) continue;
      if (cost.name === "science") continue; // cap-aware scholar handling below
      scoreResourcePathNeed(needs, cost.name, 22);
    }

    // Hunters: boosted when furs / parchment / manuscript / compendium is the
    // live bottleneck (catpower turns into furs turns into the whole chain).
    const hasShortCraftCost = pricesFor(target.kind, target.meta).some((c) =>
      c && c.name && c.val > 0 && craftByName(c.name) && resValueOf(resources, c.name) < c.val);
    const chainNeedsFurs = hasShortCraftCost &&
      ["furs", "parchment", "manuscript", "compedium", "compendium"].some((name) => chain.has(name));
    if (chainNeedsFurs && jobByName("hunter")) scoreNeed(needs, "manpower", 26);

    // Scholars: 0 while science is capped; allowed only when science is genuinely
    // the refill bottleneck — below the final research cost AND not near cap.
    const sciCost = researchScienceCost(target.meta);
    const sciHave = resValueOf(resources, "science");
    if (jobByName("scholar") && !isNearResourceCap(resources, "science") && sciHave < sciCost) {
      scoreNeed(needs, "science", 6);
    }

    // Priests: suppressed unless faith is capped or the tech itself costs faith.
    const targetCostsFaith = pricesFor(target.kind, target.meta).some((cost) => cost && cost.name === "faith");
    if (jobByName("priest") && (isNearResourceCap(resources, "faith") || targetCostsFaith)) {
      scoreNeed(needs, "faith", 6);
      jobSuppressText = "";
    }

    // Farmers: catnip safety floor only (the starvation guard in desiredJobCounts
    // still forces them on net-negative catnip / a draining pantry).
    if (resRatio(resources, "catnip") < 0.25) scoreNeed(needs, "catnip", 14);
    // Wood floor so the economy does not seize while hunters run the chain.
    if (resRatio(resources, "wood") < 0.3) scoreNeed(needs, "wood", 4 * (0.3 - resRatio(resources, "wood")) / 0.3);

    // Anti-waste: never staff a capped bank (keeps scholars off full science).
    for (const name of ["science", "faith", "culture"]) {
      if (resRatio(resources, name) > 0.94) needs[name] = 0;
    }
    return { needs, target };
  };

  const resourceNeeds = (goalKey, resources) => {
    const needs = {};
    const target = getTargetCached(resources, goalKey);
    const sprint = lastStrategicDecision && lastStrategicDecision.layer === STRATEGIC_LAYERS.researchSprint
      ? lastStrategicDecision.sprint : null;
    if (sprint && sprint.candidate && !target?.affordable) {
      return researchSprintJobNeeds(sprint, resources);
    }
    jobSuppressText = "";
    if (target && !target.affordable) {
      for (const blocker of directStorageBlockers(target.kind, target.meta, resources)) {
        const closeness = Math.max(0.05, Math.min(1, blocker.max / Math.max(1, blocker.need)));
        scoreNeed(needs, blocker.name, 12 + Math.min(18, closeness * 18));
      }
      const rawRequirements = {};
      for (const cost of pricesFor(target.kind, target.meta)) {
        if (!cost || !cost.name || !isFinite(cost.val) || cost.val <= 0) continue;
        const res = getRes(resources, cost.name);
        const have = (res && res.value) || 0;
        if (have < cost.val) {
          const missing = cost.val - have;
          scoreResourcePathNeed(needs, cost.name, 4 * (1 - Math.min(0.98, have / cost.val)) + 1);
          rawPathRequirements(cost.name, missing, rawRequirements);
        }
      }
      scoreRawDeficits(needs, resources, rawRequirements, 14);
    }

    // Science-storage unlock: while we build the cap-growth building, keep
    // scholars refilling science toward the cap-blocked tech, so it becomes
    // buyable the instant the cap opens.  Without this, science sits at the OLD
    // cap with scholars idle, the tech never turns affordable, and the unlock
    // never completes on its own (the "no scholar / no science / I buy it myself"
    // loop).  Suppressed only when science is genuinely at the cap (anti-waste).
    if (lastStrategicDecision && lastStrategicDecision.scienceStorageBlocker &&
        jobByName("scholar") && !isNearResourceCap(resources, "science")) {
      scoreNeed(needs, "science", 8);
    }

    // Lookahead: the next few runner-up candidates also pull a little weight,
    // so jobs and crafting serve the steps right behind the plan instead of
    // whiplashing to a single target — science keeps flowing for the next tech
    // while wood gathers for the current build, and vice versa.
    let lookaheads = 0;
    for (const candidate of getCandidatesCached(resources, goalKey)) {
      if (lookaheads >= 3) break;
      if (candidate.affordable || candidate.score <= 0) continue;
      if (target && targetId(candidate) === targetId(target)) continue;
      const raw = {};
      for (const cost of pricesFor(candidate.kind, candidate.meta)) {
        if (!cost || !cost.name || !isFinite(cost.val) || cost.val <= 0) continue;
        const res = getRes(resources, cost.name);
        if (res && res.maxValue > 0 && cost.val > res.maxValue) continue; // storage planner's job
        const have = (res && res.value) || 0;
        if (have < cost.val) rawPathRequirements(cost.name, cost.val - have, raw);
      }
      if (Object.keys(raw).length) {
        scoreRawDeficits(needs, resources, raw, 4);
        lookaheads += 1;
      }
    }

    const religionTarget = nextFaithReligionUpgrade(resources);
    if (religionTarget && !religionTarget.affordable) {
      for (const cost of pricesFor("religion", religionTarget.meta)) {
        if (!cost || !cost.name || !isFinite(cost.val) || cost.val <= 0) continue;
        const have = ((getRes(resources, cost.name) || {}).value) || 0;
        if (have < cost.val) scoreNeed(needs, cost.name, cost.name === "faith" ? 10 : 4);
      }
    }

    for (const [name, amount] of Object.entries(getStoragePressureCached(resources, GOALS[goalKey], goalKey))) {
      scoreNeed(needs, name, Math.min(18, amount / 3));
    }

    // Safety and anti-waste: do not keep producing capped spendables; push low raw
    // resources and food instead. This is what moves scholars away when science is full.
    if (resRatio(resources, "catnip") < 0.25) scoreNeed(needs, "catnip", 14);
    if (resRatio(resources, "wood") < 0.3) scoreNeed(needs, "wood", 7 * (0.3 - resRatio(resources, "wood")) / 0.3);
    if (resRatio(resources, "minerals") < 0.3) scoreNeed(needs, "minerals", 6 * (0.3 - resRatio(resources, "minerals")) / 0.3);
    const emphasis = (GOALS[goalKey] && GOALS[goalKey].emphasis) || {};
    if ((emphasis.science || 1) > 1 && resRatio(resources, "science") < 0.92) scoreNeed(needs, "science", 3);
    // Faith has no always-visible "next tech" equivalent, but it is a capped
    // bank with compounding religion value.  Keep a small live-data baseline
    // when priests exist and faith has storage headroom; the cap check below
    // still removes the need the moment the actual bar is full.
    if (jobByName("priest") && resRatio(resources, "faith", 1) < 0.9) scoreNeed(needs, "faith", 2);

    // Include the same immediate diplomacy work the executor will try later in
    // the tick.  Trade routes and explorers are resource sinks just like a
    // building price: if Zebra titanium is queued but catpower/gold/slabs are
    // missing, the job balancer must see those deficits instead of optimizing
    // only for the visible build target (for example, a library's wood).
    for (const [name, weight] of Object.entries(diplomacyResourcePressure(resources, goalKey))) {
      scoreNeed(needs, name, weight);
    }
    scoreNeed(needs, "manpower", huntingEconomyNeed(resources));
    if ((emphasis.production || 1) > 1) scoreNeed(needs, resRatio(resources, "minerals") <= resRatio(resources, "wood") ? "minerals" : "wood", 3);
    if ((emphasis.food || 1) > 1 || (emphasis.housing || 1) > 1) scoreNeed(needs, "catnip", 3);

    for (const name of ["science", "faith", "culture", "manpower"]) {
      if (name === "manpower" && huntingEconomyNeed(resources) > 0.5) continue;
      if (resRatio(resources, name) > 0.94) needs[name] = 0;
    }
    for (const name of ["wood", "minerals", "catnip", "coal"]) {
      if (resRatio(resources, name) > 0.96) needs[name] = Math.min(needs[name] || 0, 0.25);
    }
    const mineralSubNeed = (needs.iron || 0) + (needs.titanium || 0) + (needs.uranium || 0);
    if (mineralSubNeed > 0) {
      needs.minerals = Math.max(needs.minerals || 0, mineralSubNeed * 0.7);
    }

    if (!Object.values(needs).some((v) => v > 0)) {
      scoreNeed(needs, "wood", resRatio(resources, "wood") < 0.95 ? 2 : 0);
      scoreNeed(needs, "minerals", resRatio(resources, "minerals") < 0.95 ? 2 : 0);
      scoreNeed(needs, "science", resRatio(resources, "science") < 0.9 ? 1 : 0);
    }
    return { needs, target };
  };

  // Manage every unlocked resource-producing job. Engineers are left alone:
  // they run KS's crafting queue and are reserved out of the worker pool.
  const managedJobs = () => {
    try {
      return (window.gamePage.village.jobs || []).filter(
        (job) => job && job.unlocked !== false && job.name !== "engineer" && jobResourceFor(job),
      );
    } catch (error) {
      return [];
    }
  };

  const unassignJobByName = (village, name, amt) => {
    if (amt <= 0) return;
    if (village.sim && typeof village.sim.removeJob === "function") {
      village.sim.removeJob(name, amt);
      return;
    }
    const kittens = (village.sim && village.sim.kittens) || [];
    for (const kitten of kittens) {
      if (amt <= 0) break;
      if (kitten.job === name && typeof village.unassignJob === "function") {
        village.unassignJob(kitten);
        amt -= 1;
      }
    }
  };

  const desiredJobCounts = (goalKey, resources) => {
    const village = window.gamePage.village;
    const jobs = managedJobs();
    const totalWorkers = Math.max(0, Math.floor(village.getDiligentKittens ? village.getDiligentKittens() : village.getKittens()));
    const reserved = (jobByName("engineer") && jobByName("engineer").value) || 0;
    const total = Math.max(0, totalWorkers - reserved);
    const { needs, target } = resourceNeeds(goalKey, resources);
    const weights = {};
    // Jobs whose output bank is full are HARD-zeroed: a scholar on a capped
    // science bank produces pure waste, so it leaves immediately instead of
    // decaying through the smoother over many ticks (this is what keeps
    // scholars at 0 the instant science caps, even mid research-sprint).
    const cappedZeroJobs = new Set();

    // Wood demand goes ALL-IN on the single most economical source (after food is
    // covered by the farmer/starvation needs).  If refining a farmer's catnip wins
    // the live comparison, woodcutters drop out of the wood need entirely (the
    // net-wood starvation guard below still re-staffs them in an emergency);
    // otherwise woodcutters take the whole wood demand and farmers stay on food.
    const woodViaFarmer = (needs.wood || 0) > 0 && ((bestWoodJob() || {}).name === "farmer");

    for (const job of jobs) {
      const produced = jobResourceFor(job);
      const needKey = produced === "catpower" ? "manpower" : produced;
      let weight = needs[needKey] || 0;
      if (job.name === "woodcutter" && (needs.wood || 0) > 0 && !woodViaFarmer) weight = Math.max(weight, needs.wood);
      if (job.name === "farmer" && woodViaFarmer) weight = Math.max(weight, needs.wood + 1);
      // Universal anti-waste rule: stop staffing a job whose output bank is
      // essentially full — unless the economy still wants it (hunting keeps
      // luxuries/mood up even when catpower is high).
      const keepForEconomy = needKey === "manpower" && huntingEconomyNeed(resources) > 0.5;
      if (resRatio(resources, needKey, 0) > 0.94 && !keepForEconomy) { weight = 0; cappedZeroJobs.add(job.name); }
      // Hunting beyond the luxury/mood need is busywork: when furs are well
      // stocked and the village is happy, crafting-chain pressure (parchment →
      // furs → catpower) must not march half the settlement into the woods.
      if (job.name === "hunter" && huntingEconomyNeed(resources) <= 0.5) {
        const furs = getRes(resources, "furs");
        const fursHealthy = furs && (furs.value || 0) > luxuryStockTarget(resources, "furs") * 2;
        if (fursHealthy && currentHappinessRatio() >= 1) weight = Math.min(weight, 2.5);
      }
      weights[job.name] = Math.max(0, weight);
    }

    // Starvation guard: if catnip is NET NEGATIVE (winter, big population) and
    // the pantry is draining, force farmers before kittens start dying.
    const netCatnipPerSecond = productionFor("catnip");
    if (jobByName("farmer") && netCatnipPerSecond < 0 && resRatio(resources, "catnip") < 0.6) {
      weights.farmer = Math.max(weights.farmer || 0, 10 + Math.min(25, -netCatnipPerSecond * 2));
    }
    if (resRatio(resources, "catnip") < 0.2 && jobByName("farmer")) weights.farmer = Math.max(weights.farmer || 0, 20);

    // Wood starvation guard (symmetric to the catnip one): when wood is NET
    // NEGATIVE and the bank is draining, staff woodcutters directly.  Without
    // this, a plan that does not itself list wood leaves the wood pathway
    // unstaffed; wood drains to ~0 and that silently pauses the Smelter
    // (no iron → no plate → no ships → titanium stalls) even while catnip
    // overflows by hundreds per second.
    const netWoodPerSecond = productionFor("wood");
    const woodcutterJob = jobByName("woodcutter");
    if (woodcutterJob && netWoodPerSecond < 0 && resRatio(resources, "wood") < 0.5) {
      weights.woodcutter = Math.max(weights.woodcutter || 0, 8 + Math.min(20, -netWoodPerSecond));
    }
    if (!Object.values(weights).some((w) => w > 0)) {
      const fallback = bestWoodJob() || jobByName("woodcutter") || jobByName("farmer") || jobs[0];
      if (fallback) weights[fallback.name] = 1;
    }

    // When entering, leaving, or switching a research sprint, the prior smoothed
    // distribution must NOT linger — reset it so the new chain's jobs take over
    // immediately instead of decaying the old priest/farmer-heavy split over many
    // ticks.  (Within steady economy mode the sprint id stays "", so ordinary
    // target changes never reset the smoothing and the village does not churn.)
    const jobContext = lastStrategicDecision && lastStrategicDecision.layer === STRATEGIC_LAYERS.researchSprint && lastStrategicDecision.sprint
      ? lastStrategicDecision.sprint.id : "";
    if (jobContext !== lastJobContext) {
      smoothedJobWeights = {};
      lastJobContext = jobContext;
    }

    // Smooth noisy per-tick weights so tiny ratio changes do not whip kittens
    // back and forth between jobs.  Safety overrides (starving catnip) still
    // win because they push the raw weight far above the smoothed baseline.
    const nextSmoothed = {};
    for (const job of jobs) {
      const raw = weights[job.name] || 0;
      const previous = smoothedJobWeights[job.name];
      nextSmoothed[job.name] = previous == null ? raw : previous * (1 - JOB_WEIGHT_SMOOTHING) + raw * JOB_WEIGHT_SMOOTHING;
      if (cappedZeroJobs.has(job.name)) nextSmoothed[job.name] = 0; // capped bank → drop staffing now, not over many ticks
      if (raw === 0 && nextSmoothed[job.name] < 0.2) nextSmoothed[job.name] = 0;
      weights[job.name] = nextSmoothed[job.name];
    }
    smoothedJobWeights = nextSmoothed;

    const desired = {};
    for (const job of jobs) desired[job.name] = 0;
    const sum = Object.values(weights).reduce((a, b) => a + b, 0) || 1;
    let assigned = 0;
    for (const job of jobs) {
      const count = Math.floor(total * ((weights[job.name] || 0) / sum));
      desired[job.name] = Math.min(count, village.getJobLimit ? village.getJobLimit(job.name) : count);
      assigned += desired[job.name];
    }
    const ranked = jobs.slice().sort((a, b) => (weights[b.name] || 0) - (weights[a.name] || 0));
    for (let i = 0; assigned < total && ranked.length; i += 1) {
      const job = ranked[i % ranked.length];
      if ((weights[job.name] || 0) <= 0) break;
      const limit = village.getJobLimit ? village.getJobLimit(job.name) : 100000;
      if (desired[job.name] < limit) {
        desired[job.name] += 1;
        assigned += 1;
      }
      if (i > total + jobs.length) break;
    }

    // Deadband around the current assignment.  If the smoothed plan only wants
    // to move a couple of kittens, keep the existing jobs and let future ticks
    // accumulate into a real signal instead of churn.
    const current = {};
    let currentAssigned = 0;
    for (const job of jobs) {
      current[job.name] = Math.max(0, Math.floor(job.value || 0));
      currentAssigned += current[job.name];
    }
    const free = Math.max(0, Math.floor(village.getFreeKittens ? village.getFreeKittens() : 0));
    const perJobDeadband = Math.max(1, Math.floor(total * JOB_COUNT_DEADBAND_RATIO));
    const totalMoveWanted = jobs.reduce((sumMoves, job) => sumMoves + Math.max(0, current[job.name] - (desired[job.name] || 0)), 0);
    if (free <= 0 && currentAssigned === total && totalMoveWanted < Math.max(3, perJobDeadband * 2)) {
      for (const job of jobs) desired[job.name] = current[job.name];
    } else {
      for (const job of jobs) {
        // Assigning the FIRST kitten to a needed job is a real signal, not
        // churn — only deadband jobs that are already staffed.
        if (current[job.name] === 0 && (desired[job.name] || 0) > 0) continue;
        if (Math.abs((desired[job.name] || 0) - current[job.name]) <= perJobDeadband) desired[job.name] = current[job.name];
      }
      assigned = Object.values(desired).reduce((a, b) => a + b, 0);
      for (let i = 0; assigned < total && ranked.length; i += 1) {
        const job = ranked[i % ranked.length];
        if ((weights[job.name] || 0) <= 0) break;
        const limit = village.getJobLimit ? village.getJobLimit(job.name) : 100000;
        if (desired[job.name] < limit) {
          desired[job.name] += 1;
          assigned += 1;
        }
        if (i > total + jobs.length) break;
      }
      for (const job of ranked.slice().reverse()) {
        while (assigned > total && desired[job.name] > 0) {
          desired[job.name] -= 1;
          assigned -= 1;
        }
      }
    }

    const sprint = lastStrategicDecision && lastStrategicDecision.layer === STRATEGIC_LAYERS.researchSprint
      ? lastStrategicDecision.sprint : null;
    if (sprint && (needs.manpower || 0) > 0) {
      jobPlanText = `Jobs: Hunters for furs/parchment/compendium`;
    } else {
      const needLine = Object.entries(needs)
        .filter(([, w]) => w > 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([name]) => resTitle(resources, name))
        .join(" + ");
      jobPlanText = `Jobs: ${needLine || "balanced"}${target ? ` for ${labelOf(target.meta)}` : ""}`;
    }
    return desired;
  };

  const formatJobDistribution = (jobs, counts) => jobs
    .map((job) => `${job.title || job.name} ${Math.max(0, Math.floor(counts[job.name] || 0))}`)
    .join(", ");

  const refreshJobManagementUI = (village) => {
    try {
      const game = window.gamePage;
      if (village && typeof village.updateResourceProduction === "function") village.updateResourceProduction();
      if (game && game.villageTab && typeof game.villageTab.updateTab === "function") game.villageTab.updateTab();
      if (game && game.tabs) {
        for (const tab of game.tabs) {
          if (/village|management/i.test(`${tab && (tab.name || tab.tabName || tab.id || "")}`) && typeof tab.updateTab === "function") {
            tab.updateTab();
          }
        }
      }
      if (game && typeof game.updateResources === "function") game.updateResources();
      if (game && typeof game.render === "function") game.render();
    } catch (error) {
      /* ignore UI refresh failures */
    }
  };

  const balanceJobs = (goalKey, resources) => {
    try {
      const village = window.gamePage.village;
      if (!village || typeof village.getFreeKittens !== "function" || typeof village.assignJob !== "function") return;
      const desired = desiredJobCounts(goalKey, resources);
      const jobs = managedJobs();
      const current = {};
      for (const job of jobs) current[job.name] = Math.max(0, Math.floor(job.value || 0));
      const now = Date.now();
      const signature = jobs.map((j) => `${j.name}:${desired[j.name] || 0}`).join("|");
      if (now - lastJobRun < JOB_REBALANCE_MIN_MS && Math.floor(village.getFreeKittens()) <= 0) return;
      if (signature === lastJobSignature && Math.floor(village.getFreeKittens()) <= 0) return;
      lastJobRun = now;

      for (const job of jobs) {
        const extra = current[job.name] - (desired[job.name] || 0);
        if (extra > 0) unassignJobByName(village, job.name, extra);
      }
      let moved = 0;
      for (const job of jobs) {
        const fresh = jobByName(job.name);
        const need = (desired[job.name] || 0) - ((fresh && fresh.value) || 0);
        if (need > 0) {
          village.assignJob(fresh || job, need);
          moved += need;
        }
      }
      refreshJobManagementUI(village);
      lastJobSignature = signature;
      if (moved > 0 && now - lastJobLog > 15000) {
        const after = {};
        for (const job of jobs) {
          const fresh = jobByName(job.name);
          after[job.name] = (fresh && fresh.value) || 0;
        }
        pushLog(`👷 rebalanced ${moved} kittens: ${formatJobDistribution(jobs, after)}`);
        lastJobLog = now;
      }
    } catch (error) {
      /* ignore */
    }
  };

  let lastHuntLog = 0;
  const autoHunt = (resources) => {
    try {
      const village = window.gamePage.village;
      const cp = resources.get("manpower") || resources.get("catpower");
      if (!village || !cp || !cp.maxValue || typeof village.huntAll !== "function") return;
      const discount = typeof window.gamePage.getEffect === "function" ? window.gamePage.getEffect("huntCatpowerDiscount") : 0;
      const huntCost = Math.max(1, 100 - discount);
      const target = getTargetCached(resources, getGoal());
      // A research sprint whose chain still needs furs/parchment/manuscript/
      // compendium turns hunting into plan work: drop the threshold so we hunt
      // as soon as a hunt is affordable, instead of waiting near the cap.
      const sprint = lastStrategicDecision && lastStrategicDecision.layer === STRATEGIC_LAYERS.researchSprint
        ? lastStrategicDecision.sprint : null;
      const chainHuntNeed = !!sprint &&
        [...(lastStrategicDecision.protectedChain || new Set())]
          .some((name) => ["furs", "parchment", "manuscript", "compedium", "compendium"].includes(name));
      const economyNeed = huntingEconomyNeed(resources);
      let threshold = chainHuntNeed ? Math.max(huntCost, cp.maxValue * 0.08) :
        economyNeed > 0.5 ? Math.max(huntCost, cp.maxValue * 0.25) : Math.max(huntCost, cp.maxValue * 0.75);
      // Exploration shares this bank. While an undiscovered trade partner is
      // waiting and the cap can fit the explorer fee, hold hunting back far
      // enough that it can never permanently starve "Send explorers"
      // (diplomacy runs earlier in the tick, so explorers get first claim).
      const exploreCost = (hasLockedDiscoverableRace() || titaniumDiscoveryPending(resources, getGoal())) ? explorerPrices()[0].val : 0;
      if (exploreCost > 0 && cp.maxValue > exploreCost * 1.15) {
        threshold = Math.max(threshold, Math.min(cp.maxValue * 0.95, exploreCost + huntCost));
      }
      if (cp.value >= threshold) {
        const measured = withActionResourceDeltas(() => village.huntAll(), new Set(["manpower", "furs", "ivory"]));
        if (Date.now() - lastHuntLog > 30000) {
          const chainLabel = sprint && sprint.candidate ? labelOf(sprint.candidate.meta) : "research";
          const reason = chainHuntNeed ? `furs for ${chainLabel} chain` : economyNeed > 0.5 ? "luxuries/mood" : "catpower near cap";
          const legacyPhrase = chainHuntNeed ? `; sent hunters for furs for ${chainLabel} chain` : "";
          pushLog(`🏹 hunting: ${measured.suffix}; reason ${reason}${legacyPhrase}`);
          lastHuntLog = Date.now();
        }
      }
    } catch (error) {
      /* ignore */
    }
  };

  /* ------------------------------ the advisor ------------------------------- */

  const SPENDABLE = ["science", "culture", "faith", "manpower"];
  const RAW = ["wood", "minerals", "iron", "coal"];

  const getBottleneck = (resources) => {
    for (const name of SPENDABLE) {
      const r = resources.get(name);
      const cap = liveCapFor(resources, name);
      if (r && cap > 0 && r.value >= cap * 0.99) {
        const fix = name === "manpower" ? "send hunters" : "build more storage / spend it";
        const rate = productionFor(name);
        return `${r.title || name} is capped (${fmt(r.value)}/${fmt(cap)}, ${rate >= 0 ? "+" : ""}${fmt(rate)}/s live) — ${fix}`;
      }
    }
    for (const name of RAW) {
      const r = resources.get(name);
      const cap = liveCapFor(resources, name);
      if (r && cap > 0 && r.value < cap * 0.05) {
        const tip = name === "wood" ? " (refining catnip)" : " (more production/jobs)";
        return `${r.title || name} starved${tip}`;
      }
    }
    return "economy looks balanced";
  };

  const getNextScience = (resources, goalKey) => {
    try {
      const techs = (window.gamePage.science.techs || []).filter(isOpen);
      if (!techs.length) return "all researched / none unlocked";

      // The panel should explain the active plan first.  A distant storage-blocked
      // tech can be useful as background pressure, but it should not replace the
      // near-term science the autopilot is actually saving/crafting for.
      const target = getTargetCached(resources, goalKey);
      if (target && target.kind === "research" && isOpen(target.meta)) {
        const block = storageBlockerText("research", target.meta, resources);
        if (target.affordable) return `${labelOf(target.meta)} (ready now)`;
        if (block) return `${labelOf(target.meta)} — blocked by ${block}`;
        return `${labelOf(target.meta)} — need ${target.missing || "prerequisites"}`;
      }

      let scored = techs.map((t) => ({ t, ...evaluate("research", t, resources) }));
      const closure = goalClosureNames(goalKey);
      if (closure.size) {
        const matches = scored.filter((s) => closure.has(s.t.name));
        if (matches.length) scored = matches; // prefer research on the goal path
      }
      const ready = scored.find((s) => s.affordable);
      if (ready) return `${labelOf(ready.t)} (ready now)`;
      const near = scored.filter((s) => s.progress > 0).sort((a, b) => b.progress - a.progress)[0];
      if (near) return `${labelOf(near.t)} — need ${near.missing}`;
      const blocked = scored.find((s) => storageBlockerText("research", s.t, resources));
      if (blocked) return `${labelOf(blocked.t)} — blocked by ${storageBlockerText("research", blocked.t, resources)}`;
      return "gathering prerequisites";
    } catch (error) {
      return "—";
    }
  };

  // One line summarising the chosen goal. Milestone goals show real progress
  // ("4/9 techs · next: Astronomy"); emphasis goals show what is being favored.
  const getGoalLine = (resources, goalKey) => {
    const goal = GOALS[goalKey];
    if (!goal) return "";
    try {
      if (goal.target) {
        const progress = goalProgress(goalKey);
        if (!progress) return `🏁 ${goal.label}: milestone not visible yet — growing the economy toward it`;
        const { done, total, milestone } = progress;
        if (milestone.researched) return `🏁 ${goal.label}: ${labelOf(milestone)} researched ✓`;
        const nextName = [...goalFrontierNames(goalKey)][0];
        const next = nextName ? techByName(nextName) : null;
        let stepText = "";
        if (next) {
          const e = evaluate("research", next, resources);
          stepText = ` · next: ${labelOf(next)}${e.affordable ? " (ready!)" : e.missing ? ` (need ${e.missing})` : ""}`;
        }
        const pct = total ? Math.round((done / total) * 100) : 0;
        return `🏁 ${goal.label}: ${done}/${total} techs (${pct}%)${stepText}`;
      }
      const favored = Object.entries(goal.emphasis || {})
        .filter(([, mult]) => mult > 1)
        .map(([category]) => category);
      if (!favored.length && getPriority() === "auto") return ""; // balanced — no extra line needed
      if (!favored.length) return `🏁 ${goal.label}: override ${PRIORITIES[getPriority()].label.replace(/^Manual: /, "")}`;
      const target = getTargetCached(resources, goalKey);
      const targetText = target ? ` · focusing ${labelOf(target.meta)}` : "";
      const priority = getPriority();
      const priorityText = priority !== "auto" ? ` · override ${PRIORITIES[priority].label.replace(/^Manual: /, "")}` : "";
      return `🏁 ${goal.label}: favoring ${favored.join(", ")}${priorityText}${targetText}`;
    } catch (error) {
      return `🏁 ${goal.label}`;
    }
  };


  const titaniumRouteHint = (resources, goalKey) => {
    // Identical scope to titaniumNeededSoon(): the panel's titanium line shows
    // exactly when (and only when) the bot is actually running the titanium path.
    if (!titaniumNeededSoon(resources, goalKey)) return "";
    const zebras = raceByName("zebras");
    if (zebras && zebras.unlocked) {
      const missing = tradePricesForRace(zebras)
        .filter((price) => price && price.name && resourceValue(resources, price.name) < price.val)
        .map((price) => `${fmt(price.val - resourceValue(resources, price.name))} ${resTitle(resources, price.name)}`)
        .slice(0, 2)
        .join(", ");
      return missing ? `Zebra trade needs ${missing}` : "trade Zebras for titanium";
    }
    if (resourceValue(resources, "ship") < 1) return "craft first Ship to reveal Zebras";
    const exploreMissing = explorerPrices()
      .filter((price) => price && price.name && resourceValue(resources, price.name) < price.val)
      .map((price) => `${fmt(price.val - resourceValue(resources, price.name))} ${resTitle(resources, price.name)}`)
      .slice(0, 2)
      .join(", ");
    return exploreMissing ? `save ${exploreMissing} for explorers, then trade Zebras` : "send explorers to meet Zebras, then trade titanium";
  };

  const formatRequirements = (kind, meta, resources) => {
    const parts = [];
    for (const cost of pricesFor(kind, meta)) {
      if (!cost || !cost.name || !isFinite(cost.val) || cost.val <= 0) continue;
      const res = getRes(resources, cost.name);
      const have = (res && res.value) || 0;
      const title = resTitle(resources, cost.name);
      parts.push(`${title} ${fmt(Math.min(have, cost.val))}/${fmt(cost.val)}`);
    }
    return parts.slice(0, 4).join(" · ");
  };

  const formatEta = (seconds) => {
    if (!isFinite(seconds)) return "unknown";
    if (seconds <= 0) return "now";
    if (seconds < 60) return `≈${Math.ceil(seconds)}s`;
    const minutes = Math.ceil(seconds / 60);
    if (minutes < 60) return `≈${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const remMinutes = minutes % 60;
    if (hours < 24) return `≈${hours}h${remMinutes ? ` ${remMinutes}m` : ""}`;
    const days = Math.floor(hours / 24);
    const remHours = hours % 24;
    return `≈${days}d${remHours ? ` ${remHours}h` : ""}`;
  };

  const KIND_LABELS = {
    build: "BUILDING",
    research: "SCIENCE",
    upgrade: "WORKSHOP UPGRADE",
    religion: "RELIGION UPGRADE",
    policy: "POLICY",
    space: "SPACE PROGRAM",
    time: "TIME STRUCTURE",
  };

  const KIND_ICONS = { build: "🏗", research: "🔬", upgrade: "⚙", religion: "☀", policy: "📜", space: "🚀", time: "⏳" };

  const focusLabel = (candidate) => `${KIND_ICONS[candidate.kind] || "🎯"} ${KIND_LABELS[candidate.kind] || candidate.kind.toUpperCase()}`;

  // Compact "Need:" summary — the still-missing direct costs (cap-drain banks
  // and craft intermediates), e.g. "12.29K Science, 27.2 Compendium".
  const planNeedSummary = (resources, target) => {
    const out = [];
    for (const cost of pricesFor(target.kind, target.meta)) {
      if (!cost || !cost.name || !isFinite(cost.val) || cost.val <= 0) continue;
      const have = resValueOf(resources, cost.name);
      if (have >= cost.val) continue;
      const label = craftByName(cost.name) ? craftLabel(cost.name) : resTitle(resources, cost.name);
      out.push(`${fmt(cost.val - have)} ${label}`);
    }
    return out.slice(0, 3);
  };

  // MAIN panel — must stay compact: Focus + Layer + Need only.  All reasoning
  // (protected chain, deferrals, ETA) lives in "More automation details".
  const getPlanLine = (resources, goalKey) => {
    try {
      const target = getTargetCached(resources, goalKey);
      if (!target) return "🎯 Focus: scanning";
      const layer = (lastStrategicDecision && lastStrategicDecision.layer) || STRATEGIC_LAYERS.economy;
      const storageBlocker = lastStrategicDecision && lastStrategicDecision.scienceStorageBlocker;
      const needs = planNeedSummary(resources, target);
      const needLine = storageBlocker
        ? `+${fmt(storageBlocker.need)} science storage (${labelOf(storageBlocker.blocked.meta)} is storage-blocked)`
        : target.affordable ? "ready now" : needs.join(", ") || target.missing || "prerequisites";
      return `🎯 Focus: ${labelOf(target.meta)}\nLayer: ${layer}\nNeed: ${needLine}`;
    } catch (error) {
      return "🎯 Focus: —";
    }
  };

  // Ordered chain members for display, craft order top-down (Compendium →
  // Manuscript → Parchment → Furs), filtered to the interesting craft/hunt steps.
  const protectedChainLabels = (resources, chain) =>
    [...(chain || new Set())]
      .filter((name) => craftByName(name) || HUNTABLE_RESOURCES.has(name))
      .slice(0, 6)
      .map((name) => resTitle(resources, name));

  const getAutomationDetailsLine = (resources, goalKey) => {
    try {
      const target = getTargetCached(resources, goalKey);
      if (!target) return "";
      const decision = lastStrategicDecision;
      // Research-sprint details: protected chain + deferrals + job drivers.
      if (decision && decision.layer === STRATEGIC_LAYERS.researchSprint && decision.sprint) {
        const parts = [];
        const chain = protectedChainLabels(resources, decision.protectedChain);
        if (chain.length) parts.push(`Protected chain: ${chain.join(" → ")}`);
        for (const item of (decision.rejectedTopCandidates || []).filter((i) => i && i.target).slice(0, 4)) {
          parts.push(`Deferred ${labelOf(item.target.meta)}: ${item.reason}`);
        }
        if (jobPlanText) parts.push(jobPlanText.replace(/^Jobs:\s*/, "Jobs: "));
        if (jobSuppressText) parts.push(jobSuppressText);
        return parts.join(" · ");
      }
      if (decision && decision.layer === STRATEGIC_LAYERS.scienceStorageUnlock && decision.scienceStorageBlocker) {
        const blocker = decision.scienceStorageBlocker;
        const eta = formatEta(waitSecondsForCandidate(target, resources));
        const rejected = (decision.rejectedTopCandidates || []).filter((item) => item && item.target).slice(0, 3);
        const rejectNote = rejected.length ? ` · deferred ${rejected.map((item) => `${labelOf(item.target.meta)} (${item.reason})`).join("; ")}` : "";
        return `${labelOf(blocker.blocked.meta)} is storage-blocked · Need +${fmt(blocker.need)} science storage · Now ${target.affordable ? "buy" : "build"} ${labelOf(target.meta)} · ETA ${eta}${rejectNote}`;
      }
      // Economy details: state + ETA + reservation + deferrals (unchanged shape).
      const storageBlock = storageBlockerText(target.kind, target.meta, resources);
      const state = target.affordable ? "ready now" : storageBlock ? `storage-blocked: ${storageBlock}` : `missing ${target.missing || "prerequisites"}`;
      const eta = formatEta(waitSecondsForCandidate(target, resources));
      const reserved = target.affordable ? [] : Object.keys(reservedNeedsFor(target, resources));
      const reserveNote = reserved.length ? ` · reserving ${reserved.slice(0, 4).map((name) => resTitle(resources, name)).join("+")}` : "";
      const rejected = (decision && decision.rejectedTopCandidates || []).filter((item) => item && item.target).slice(0, 3);
      const rejectNote = rejected.length ? ` · deferred ${rejected.map((item) => `${labelOf(item.target.meta)} (${item.reason})`).join("; ")}` : "";
      const titaniumHint = titaniumRouteHint(resources, goalKey);
      return `${focusLabel(target)} ${labelOf(target.meta)} · ${state} · ETA ${eta}${reserveNote}${rejectNote}${titaniumHint ? ` · titanium path: ${titaniumHint}` : ""}`;
    } catch (error) {
      return "";
    }
  };

  // "12 Scaffold" — the craft label with the number still needed (deficit folded
  // through the craft-ratio bonus), so the panel shows how much is being made.
  const craftQtyText = (resources, name) => {
    const craft = craftByName(name);
    if (!craft) return resTitle(resources, name);
    const need = (() => {
      // How many of this craft the current target still needs.
      const target = lastStrategicDecision && lastStrategicDecision.target;
      const cost = target ? pricesFor(target.kind, target.meta).find((c) => c && c.name === name) : null;
      const deficit = cost ? cost.val - resValueOf(resources, name) : 0;
      return deficit > 0 ? Math.max(1, Math.ceil(deficit / Math.max(1, 1 + craftRatioFor(name)))) : 0;
    })();
    return `${need > 0 ? fmt(need) + " " : ""}${craftLabel(name)}`;
  };

  const getNowAction = (resources, goalKey) => {
    const target = getTargetCached(resources, goalKey);
    if (!target) return "scanning…";
    if (target.affordable) return `buying ${focusLabel(target).toLowerCase()} ${labelOf(target.meta)}`;
    const decision = lastStrategicDecision;
    // Research-sprint action: surface the immediate chain step (craft / hunt /
    // refill), e.g. "craft Compendium for Acoustics chain".
    if (decision && decision.layer === STRATEGIC_LAYERS.researchSprint && decision.sprint) {
      const label = labelOf(target.meta);
      const step = decision.sprint.currentStep;
      if (step && HUNTABLE_RESOURCES.has(step)) return `hunt for ${resTitle(resources, step)} for ${label} chain`;
      if (step && craftByName(step)) return `craft ${craftQtyText(resources, step)} for ${label} chain`;
      if (step && CAP_DRAIN_RESOURCES.has(step)) return `wait/refill ${resTitle(resources, step)} for ${label} chain`;
      // No craftable step short → only the cap-drain banks remain to refill.
      const shortBank = pricesFor(target.kind, target.meta).find((c) => c && c.name && CAP_DRAIN_RESOURCES.has(c.name) && resValueOf(resources, c.name) < c.val);
      if (shortBank) return `wait/refill ${resTitle(resources, shortBank.name)} for ${label} chain`;
      return `advancing ${label} chain`;
    }
    const titaniumHint = titaniumRouteHint(resources, goalKey);
    if (titaniumHint) return `titanium path: ${titaniumHint}`;
    const craftable = pricesFor(target.kind, target.meta).find((cost) => cost && cost.name && cost.val > ((getRes(resources, cost.name) || {}).value || 0) && craftByName(cost.name));
    if (craftable) {
      // Surface the immediate actionable step (e.g. Beam before Scaffold) and how
      // many to craft, so the panel shows what is actually being converted.
      const step = deepestActionableStep(resources, craftable.name);
      if (HUNTABLE_RESOURCES.has(step)) return `hunt for ${resTitle(resources, step)} for ${labelOf(target.meta)}`;
      const via = step !== craftable.name && craftByName(step) ? ` (via ${craftLabel(step)})` : "";
      return `craft ${craftQtyText(resources, craftable.name)}${via} for ${labelOf(target.meta)}`;
    }
    return `gather ${target.missing || "prerequisites"} (reserved)`;
  };


  const AUTOBUY_MIN_MS = 2500;
  let lastAutoBuy = 0;

  const findCapReliefPurchase = (resources, goalKey, target, reserved) => {
    const capped = cappedSpendableResources(resources);
    if (!capped.length) return null;
    return getCandidatesCached(resources, goalKey).find((candidate) =>
      candidate.affordable &&
      (!target || targetId(candidate) !== targetId(target)) &&
      !buyBenched(targetId(candidate)) &&
      candidateSpendsAny(candidate, capped) &&
      respectsReservations(candidate, reserved, resources));
  };

  const purchaseComplete = (candidate, initialVal) => {
    if (!candidate || !candidate.meta) return false;
    if (VAL_BASED_KINDS.has(candidate.kind)) return ((candidate.meta.val || 0) > (initialVal || 0));
    if (candidate.kind === "religion") return religionUpgradePurchased(candidate.meta);
    return !!candidate.meta.researched;
  };

  const getGlobalPath = (path) => {
    try {
      return path.reduce((node, key) => node && node[key], window);
    } catch (error) {
      return null;
    }
  };

  const controllerSpecFor = (kind) => {
    if (kind === "research") {
      return {
        path: ["com", "nuclearunicorn", "game", "ui", "TechButtonController"],
        opts: (name) => ({ id: name }),
      };
    }
    if (kind === "upgrade") {
      return {
        path: ["com", "nuclearunicorn", "game", "ui", "UpgradeButtonController"],
        opts: (name) => ({ id: name }),
      };
    }
    if (kind === "policy") {
      return {
        path: ["com", "nuclearunicorn", "game", "ui", "PolicyButtonController"],
        opts: (name) => ({ id: name }),
      };
    }
    if (kind === "religion") {
      return {
        path: ["com", "nuclearunicorn", "game", "ui", "ReligionBtnController"],
        opts: (name) => ({ id: name }),
      };
    }
    if (kind === "build") {
      return {
        path: ["classes", "ui", "btn", "BuildingBtnModernController"],
        opts: (name) => ({ building: name }),
      };
    }
    if (kind === "space") {
      return {
        path: ["com", "nuclearunicorn", "game", "ui", "SpaceProgramBtnController"],
        opts: (name) => ({ id: name }),
      };
    }
    if (kind === "time") {
      // Chronoforge controller for CFU; Void-space metas fall through to the
      // reservation-safe raw-metadata buy path (which pays prices + increments val).
      return {
        path: ["classes", "ui", "time", "ChronoforgeBtnController"],
        opts: (name) => ({ id: name }),
      };
    }
    return null;
  };

  const buyViaGameController = (candidate) => {
    const game = window.gamePage;
    const meta = candidate && candidate.meta;
    const name = meta && meta.name;
    const spec = controllerSpecFor(candidate && candidate.kind);
    const Controller = spec && getGlobalPath(spec.path);
    if (!game || !name || typeof Controller !== "function") return false;
    const controller = new Controller(game);
    if (!controller || typeof controller.fetchModel !== "function" || typeof controller.buyItem !== "function") return false;
    const opts = { ...spec.opts(name), controller };
    const model = controller.fetchModel(opts);
    if (!model) return false;
    if (typeof controller.updateEnabled === "function") controller.updateEnabled(model);
    const result = controller.buyItem(model, { boughtByQueue: true });
    return !!(result && result.itemBought) || purchaseComplete(candidate, VAL_BASED_KINDS.has(candidate.kind) ? ((meta.val || 0) - 1) : 0);
  };

  const canPayPrices = (prices) => {
    const resources = resourceMap();
    return prices.every((price) => {
      const res = getRes(resources, price.name);
      return res && (res.value || 0) >= price.val;
    });
  };

  const ALLOW_RAW_METADATA_BUY_FALLBACK = false;

  const rawPayPrices = (prices) => {
    const game = window.gamePage;
    if (!game || !game.resPool) return false;
    if (typeof game.resPool.payPrices === "function") {
      game.resPool.payPrices(prices);
      return true;
    }
    for (const price of prices) {
      if (typeof game.resPool.addResEvent === "function") {
        game.resPool.addResEvent(price.name, -price.val);
      } else {
        const res = game.resPool.get && game.resPool.get(price.name);
        if (!res) return false;
        res.value -= price.val;
      }
    }
    return true;
  };

  const applyRawPurchaseEffects = (candidate) => {
    const game = window.gamePage;
    const meta = candidate.meta;
    if (VAL_BASED_KINDS.has(candidate.kind) || candidate.kind === "religion") {
      meta.val = (meta.val || 0) + 1;
      meta.on = (meta.on || 0) + 1;
    } else {
      meta.researched = true;
    }
    if (meta.handler) meta.handler(game, meta);
    if (meta.unlocks && game.unlock) game.unlock(meta.unlocks);
    if (meta.upgrades && game.upgrade) game.upgrade(meta.upgrades);
    if (meta.calculateEffects) meta.calculateEffects(meta, game);
    if (game.render) game.render();
  };

  const buyViaRawMetadata = (candidate) => {
    const prices = pricesFor(candidate.kind, candidate.meta).filter((price) => price && price.name && price.val > 0);
    if (!prices.length || !canPayPrices(prices) || !rawPayPrices(prices)) return false;
    applyRawPurchaseEffects(candidate);
    return true;
  };

  const purchaseAttemptsFor = (candidate) => {
    const game = window.gamePage;
    const meta = candidate.meta;
    const name = meta && meta.name;
    if (!game || !meta || !name) return [];
    const attempts = [
      () => buyViaGameController(candidate),
    ];
    if (candidate.kind === "research" || candidate.kind === "policy") {
      attempts.push(
        () => candidate.kind === "policy" && game.science && typeof game.science.researchPolicy === "function" && game.science.researchPolicy(name),
        () => candidate.kind === "policy" && game.science && typeof game.science.researchPolicy === "function" && game.science.researchPolicy(meta),
        () => game.science && typeof game.science.research === "function" && game.science.research(name),
        () => game.science && typeof game.science.research === "function" && game.science.research(meta),
      );
    }
    if (candidate.kind === "upgrade") {
      attempts.push(
        () => game.workshop && typeof game.workshop.research === "function" && game.workshop.research(name),
        () => game.workshop && typeof game.workshop.research === "function" && game.workshop.research(meta),
      );
    }
    if (candidate.kind === "religion") {
      attempts.push(
        () => game.religion && typeof game.religion.build === "function" && game.religion.build(name),
        () => game.religion && typeof game.religion.build === "function" && game.religion.build(candidate.meta),
      );
    }
    if (candidate.kind === "build") {
      attempts.push(
        () => game.bld && typeof game.bld.build === "function" && game.bld.build(name),
        () => game.bld && typeof game.bld.build === "function" && game.bld.build(name, 1),
        () => game.bld && typeof game.bld.construct === "function" && game.bld.construct(name),
      );
    }
    if (candidate.kind === "space") {
      attempts.push(
        () => game.space && typeof game.space.build === "function" && game.space.build(name),
        () => game.space && typeof game.space.build === "function" && game.space.build(candidate.meta),
        () => game.space && typeof game.space.buildProgram === "function" && game.space.buildProgram(name),
        () => game.space && typeof game.space.buildProgram === "function" && game.space.buildProgram(candidate.meta),
      );
    }
    if (candidate.kind === "time") {
      attempts.push(
        () => game.time && typeof game.time.build === "function" && game.time.build(name),
        () => game.time && typeof game.time.build === "function" && game.time.build(candidate.meta),
        () => game.time && typeof game.time.buy === "function" && game.time.buy(name),
        () => game.time && typeof game.time.buy === "function" && game.time.buy(candidate.meta),
      );
    }
    if (ALLOW_RAW_METADATA_BUY_FALLBACK) {
      attempts.push(() => buyViaRawMetadata(candidate));
    }
    return attempts;
  };

  const buyCandidate = (candidate) => {
    const initialVal = VAL_BASED_KINDS.has(candidate.kind) ? candidate.meta.val || 0 : 0;
    for (const attempt of purchaseAttemptsFor(candidate)) {
      try {
        attempt();
      } catch (error) {
        /* try the next API shape */
      }
      if (purchaseComplete(candidate, initialVal)) return true;
    }
    return false;
  };

  // What the active plan still needs, by resource — held back from every other
  // purchase so the plan actually completes instead of being eaten by cheaper
  // buys (the classic "plan says Library, a Mine gets built" failure).
  // Costs above a storage cap are NOT reserved: saving can never reach those,
  // the storage planner handles them instead.
  const reservedNeedsFor = (target, resources) => {
    const reserved = {};
    if (!target || target.affordable) return reserved;
    // For a research sprint we protect the CRAFT chain (Compendium/Manuscript/
    // Parchment/Furs), not the cap-drain banks: science/culture are spent and
    // refilled continuously, and over-reserving them would block chain
    // accelerators (e.g. a Printing Press that produces manuscripts).  We only
    // reserve a cap-drain bank once it is near cap (about to complete the buy).
    const isSprintTarget = target.kind === "research" && activeSprint && activeSprint.candidate &&
      targetId(target) === activeSprint.id;
    for (const cost of pricesFor(target.kind, target.meta)) {
      if (!cost || !cost.name || !isFinite(cost.val) || cost.val <= 0) continue;
      if (isSprintTarget && CAP_DRAIN_RESOURCES.has(cost.name) && !isNearResourceCap(resources, cost.name)) continue;
      const res = getRes(resources, cost.name);
      if (res && res.maxValue > 0 && cost.val > res.maxValue) continue;
      reserved[cost.name] = Math.max(reserved[cost.name] || 0, cost.val);
      const have = (res && res.value) || 0;
      // Costs the crafting loop must assemble (no direct production) also hold
      // their raw chain, or competitors drain the wood meant for beams. Costs
      // that produce on their own (wood, minerals…) reserve only themselves.
      if (have < cost.val && craftByName(cost.name) && rawProductionForNeed(cost.name) <= 0) {
        const raw = rawPathRequirements(cost.name, cost.val - have);
        for (const [name, amount] of Object.entries(raw)) {
          const rawRes = getRes(resources, name);
          if (rawRes && rawRes.maxValue > 0 && amount > rawRes.maxValue) continue;
          reserved[name] = (reserved[name] || 0) + amount;
        }
      }
    }
    return reserved;
  };

  const respectsReservations = (candidate, reserved, resources) => {
    for (const cost of pricesFor(candidate.kind, candidate.meta)) {
      if (!cost || !cost.name || !isFinite(cost.val) || cost.val <= 0) continue;
      const hold = reserved[cost.name] || (cost.name === "catpower" ? reserved.manpower || 0 : 0);
      if (hold <= 0) continue;
      const stock = ((getRes(resources, cost.name) || {}).value) || 0;
      if (stock - cost.val < hold) return false;
    }
    return true;
  };

  // Purchases that keep silently failing (controller/API mismatch for that one
  // item) get benched so the plan and the surplus buyer can move on.
  const failedBuys = {};
  const buyBenched = (id) => {
    const entry = failedBuys[id];
    return !!entry && entry.until > Date.now();
  };
  const noteBuyFailure = (id) => {
    const entry = failedBuys[id] || { count: 0, until: 0 };
    entry.count += 1;
    entry.until = Date.now() + (entry.count >= 3 ? 300000 : 12000);
    failedBuys[id] = entry;
    return entry.count >= 3;
  };

  let buyPlanText = "Buy: waiting…";

  // The purchase loop, replacing KS's bonfire/science/workshop-upgrade buyers:
  //  1. buy the PLAN the moment it is affordable;
  //  2. auto-buy policies that block no alternatives (exclusive ones stay manual);
  //  3. spend only unreserved surplus on everything else, best-scored first.
  // Assist mode stays advisory-only.
  const isSprintCandidate = (target, resources) => {
    if (!speedrunMode() || !target || target.affordable) return false;
    return evaluate(target.kind, target.meta, resources).progress >= SPRINT_PROGRESS_THRESHOLD;
  };

  const executePlan = (resources, goalKey) => {
    try {
      computeResetAdvisor();
      const now = Date.now();
      const target = getTargetCached(resources, goalKey);
      const sprint = isSprintCandidate(target, resources);
      if (target) target._sprint = sprint;

      // Plan purchases are latency-sensitive: if we just crafted the exact
      // beams/slabs/etc. for a building, raw inputs may still be draining in the
      // background.  Do not let the generic buy throttle insert another tick of
      // delay between "ready" and the actual click.  Surplus/policy buys below
      // remain throttled so the helper does not spam incidental purchases.
      if (target && target.affordable && !buyBenched(targetId(target))) {
        lastAutoBuy = now;
        if (buyCandidate(target)) {
          pushLog(`🎯 plan ${target.kind} ${labelOf(target.meta)}`);
          buyPlanText = `Buy: plan completed — ${labelOf(target.meta)}`;
          activeTarget = null;
        } else if (noteBuyFailure(targetId(target))) {
          activeTarget = null; // benched — let the plan move on
        }
        return;
      }

      const reserved = reservedNeedsFor(target, resources);
      const capRelief = findCapReliefPurchase(resources, goalKey, target, reserved);
      if (capRelief && !sprint) {
        lastAutoBuy = now;
        if (buyCandidate(capRelief)) {
          pushLog(`${capRelief.kind === "upgrade" ? "⚙" : capRelief.kind === "research" ? "🔬" : "🎯"} cap relief ${capRelief.kind} ${labelOf(capRelief.meta)}`);
          buyPlanText = `Buy: spent capped resources on ${labelOf(capRelief.meta)}`;
        } else {
          noteBuyFailure(targetId(capRelief));
        }
        return;
      }

      if (now - lastAutoBuy < AUTOBUY_MIN_MS) return;

      if (!sprint) {
        const policy = autoPolicyChoice(resources, goalKey);
        if (policy && !buyBenched(targetId(policy))) {
          lastAutoBuy = now;
          if (buyCandidate(policy)) {
            pushLog(`📜 policy ${labelOf(policy.meta)} (blocks nothing)`);
          } else {
            noteBuyFailure(targetId(policy));
          }
          return;
        }
      }

      const candidates = getCandidatesCached(resources, goalKey);
      const ready = candidates.find((candidate) =>
        !sprint &&
        candidate.affordable &&
        (!target || targetId(candidate) !== targetId(target)) &&
        !buyBenched(targetId(candidate)) &&
        respectsReservations(candidate, reserved, resources));
      if (!ready) {
        const held = Object.keys(reserved);
        const sprintTag = sprint ? " · 🚀 sprint holding surplus" : "";
        buyPlanText = target && !target.affordable && held.length
          ? `Buy: saving for ${labelOf(target.meta)} (reserving ${held.slice(0, 3).map((name) => resTitle(resources, name)).join(", ")})${sprintTag}`
          : sprint && target ? `Buy: sprint — holding all surplus for ${labelOf(target.meta)}` : "Buy: nothing affordable";
        return;
      }
      lastAutoBuy = now;
      if (buyCandidate(ready)) {
        pushLog(`${ready.kind === "upgrade" ? "⚙" : ready.kind === "research" ? "🔬" : "🏗"} surplus ${ready.kind} ${labelOf(ready.meta)}`);
        buyPlanText = `Buy: ${labelOf(ready.meta)} from surplus`;
      } else {
        noteBuyFailure(targetId(ready));
      }
    } catch (error) {
      /* ignore */
    }
  };

  /* ------------------------ diplomacy safety net (ours) ----------------------- */

  // KS normally owns trade, but exploration/embassy clicks are important enough
  // to keep a direct, reservation-aware fallback here. This is generic over the
  // game's live race metadata: it reads each race's current embassy prices and
  // lets the diplomacy manager decide which civilization an explorer discovers.
  let diplomacyPlanText = "Diplomacy: watching trade";
  let lastDiplomacyAction = 0;

  // Zebra titanium is special: ships improve both the chance and the payout.
  // Kittens Game's live formula is 15% + 0.35 percentage points per ship
  // (capped at certainty), and 1.5 titanium + 0.03 per ship when it hits.
  // Use that expected value to decide when to build the fleet before burning
  // slabs/gold/catpower on lots of low-odds trades.
  const ZEBRA_TITANIUM_BASE_CHANCE = 0.15;
  const ZEBRA_TITANIUM_CHANCE_PER_SHIP = 0.0035;
  const ZEBRA_TITANIUM_BASE_AMOUNT = 1.5;
  const ZEBRA_TITANIUM_AMOUNT_PER_SHIP = 0.03;
  const ZEBRA_TITANIUM_GUARANTEE_SHIPS = Math.ceil((1 - ZEBRA_TITANIUM_BASE_CHANCE) / ZEBRA_TITANIUM_CHANCE_PER_SHIP);

  const zebraTitaniumStats = (resources) => {
    const ships = resourceValue(resources, "ship");
    const chance = Math.min(1, ZEBRA_TITANIUM_BASE_CHANCE + ships * ZEBRA_TITANIUM_CHANCE_PER_SHIP);
    const amount = ZEBRA_TITANIUM_BASE_AMOUNT + ships * ZEBRA_TITANIUM_AMOUNT_PER_SHIP;
    return {
      ships,
      chance,
      amount,
      expected: chance * amount,
      shipsToGuarantee: Math.max(0, ZEBRA_TITANIUM_GUARANTEE_SHIPS - Math.floor(ships)),
    };
  };

  const titaniumDemandAmount = (resources, goalKey) => {
    const have = resourceValue(resources, "titanium");
    let demand = 0;
    const inspect = (candidate) => {
      if (!candidate || candidate.affordable) return;
      for (const cost of pricesFor(candidate.kind, candidate.meta)) {
        if (cost && cost.name === "titanium" && cost.val > have) demand = Math.max(demand, cost.val - have);
      }
    };
    inspect(getTargetCached(resources, goalKey));
    for (const candidate of getCandidatesCached(resources, goalKey).slice(0, 12)) inspect(candidate);
    return demand;
  };

  // Ships are also stored like any resource: if the save caps the ship count
  // (Harbour-limited storage etc.), there is no point planning a fleet larger
  // than we can actually hold — building toward it just spins on a full bar.
  const shipCapacity = (resources) => {
    const ship = getRes(resources, "ship");
    return ship && ship.maxValue > 0 ? ship.maxValue : Number.POSITIVE_INFINITY;
  };
  const shipsAreCapped = (resources) => {
    const ship = getRes(resources, "ship");
    return !!(ship && ship.maxValue > 0 && ship.value >= ship.maxValue - 0.5);
  };

  const desiredZebraShipCount = (resources, goalKey) => {
    const demand = titaniumDemandAmount(resources, goalKey);
    if (demand <= 0) return 0;
    const byDemand = demand <= 10 ? 25 : demand <= 50 ? 50 : demand <= 150 ? 100 : ZEBRA_TITANIUM_GUARANTEE_SHIPS;
    // Never plan past the ship storage cap — at the cap the fleet is as big as
    // it will get, so the helper should just trade at the resulting odds.
    return Math.min(byDemand, Math.floor(shipCapacity(resources)));
  };

  const zebraTitaniumOddsText = (resources, goalKey) => {
    const stats = zebraTitaniumStats(resources);
    const goalShips = desiredZebraShipCount(resources, goalKey);
    const goalText = goalShips > Math.floor(stats.ships) ? `; build toward ${goalShips} ships before spam-trading` : "; trade now";
    const guaranteeText = stats.shipsToGuarantee > 0 ? `; +${stats.shipsToGuarantee} ships to 100%` : "; 100% hit chance";
    return `${fmt(stats.ships)} ships → ${(stats.chance * 100).toFixed(1)}% × ${fmt(stats.amount)} Ti = ${fmt(stats.expected)} Ti/trade avg${goalText}${guaranteeText}`;
  };

  const shipCraftWouldStealFromActivePlan = (resources, goalKey) => {
    const target = getTargetCached(resources, goalKey);
    if (!target || target.affordable || targetMissingResource(target, resources, "titanium")) return false;
    const reserved = reservedNeedsFor(target, resources);
    return ["scaffold", "plate", "starchart", "slab", "beam", "wood", "minerals", "iron", "coal"].some((name) => (reserved[name] || 0) > 0);
  };

  const unlockedRaces = () => {
    try {
      const races = window.gamePage && window.gamePage.diplomacy && window.gamePage.diplomacy.races;
      return (Array.isArray(races) ? races : []).filter((race) => race && race.unlocked);
    } catch (error) {
      return [];
    }
  };

  const hasLockedDiscoverableRace = () => hasDiscoverableRaceNow(resourceMap());

  const raceByName = (name) => {
    try {
      const diplomacy = window.gamePage && window.gamePage.diplomacy;
      if (diplomacy && typeof diplomacy.get === "function") return diplomacy.get(name);
      const races = (diplomacy && diplomacy.races) || [];
      return (Array.isArray(races) ? races : []).find((race) => race && race.name === name) || null;
    } catch (error) {
      return null;
    }
  };

  const resourceValue = (resources, name) => ((getRes(resources, name) || {}).value) || 0;

  const hiddenRaceDiscoverableNow = (race, resources) => {
    if (!race || race.unlocked || !race.hidden) return false;
    if (race.name === "nagas") return resourceValue(resources, "culture") >= 1500;
    if (race.name === "zebras") return resourceValue(resources, "ship") >= 1;
    if (race.name === "spiders") return resourceValue(resources, "ship") >= 100 && ((getRes(resources, "science") || {}).maxValue || 0) > 125000;
    if (race.name === "dragons") {
      try {
        const tech = window.gamePage.science && window.gamePage.science.get && window.gamePage.science.get("nuclearFission");
        return !!(tech && tech.researched);
      } catch (error) {
        return false;
      }
    }
    return false;
  };

  const hasDiscoverableRaceNow = (resources) => {
    try {
      const diplomacy = window.gamePage && window.gamePage.diplomacy;
      const races = (diplomacy && diplomacy.races) || [];
      return (Array.isArray(races) ? races : []).some((race) => race && !race.unlocked && (!race.hidden || hiddenRaceDiscoverableNow(race, resources)));
    } catch (error) {
      return false;
    }
  };

  const explorerFeeCanFit = (resources) => explorerPrices().every((price) => {
    const res = getRes(resources, price.name);
    return !res || !res.maxValue || res.maxValue >= price.val;
  });

  const titaniumDiscoveryPending = (resources, goalKey) => {
    if (!explorerFeeCanFit(resources)) return false;
    const zebras = raceByName("zebras");
    if (!zebras || zebras.unlocked) return false;
    if (!titaniumNeededSoon(resources, goalKey)) return false;
    return resourceValue(resources, "ship") >= 1 || !!craftByName("ship");
  };

  const shouldSaveForExplorers = (resources, goalKey) => {
    if (!explorerFeeCanFit(resources)) return false;
    if (!hasDiscoverableRaceNow(resources) && !titaniumDiscoveryPending(resources, goalKey)) return false;
    return explorerPrices().some((price) => resourceValue(resources, price.name) < price.val);
  };

  const targetMissingResource = (target, resources, name) => {
    if (!target || target.affordable) return false;
    return pricesFor(target.kind, target.meta).some((cost) => cost && cost.name === name && resourceValue(resources, name) < cost.val);
  };

  // Titanium acquisition (ship craft → explorers → Zebra trade) is a SUB-ACTION
  // of the locked plan, never a standalone goal. It fires only when the current
  // target genuinely needs titanium — as a direct cost, or hidden behind a
  // craftable cost (e.g. alloy = titanium + steel). Previously this also fired on
  // global titanium scarcity (titanium < 50% cap) or on ANY of the top-12
  // candidates needing titanium, which made the bot run Zebra trades and ship
  // crafts while the panel showed an unrelated plan — the displayed plan and the
  // actual spending disagreed. Scoping it to the locked target keeps them in sync
  // (it matches titaniumRouteHint(), which drives the panel's titanium line).
  const titaniumNeededSoon = (resources, goalKey) => {
    const target = getTargetCached(resources, goalKey);
    if (!target || target.affordable) return false;
    if (targetMissingResource(target, resources, "titanium")) return true;
    for (const cost of pricesFor(target.kind, target.meta)) {
      if (!cost || !cost.name || !isFinite(cost.val) || cost.val <= 0) continue;
      const have = resourceValue(resources, cost.name);
      if (have >= cost.val || !craftByName(cost.name)) continue;
      const raw = rawPathRequirements(cost.name, Math.max(1, cost.val - have));
      if ((raw.titanium || 0) > 0) return true;
    }
    return false;
  };

  const tradePricesForRace = (race) => {
    const prices = [];
    try {
      const diplomacy = window.gamePage && window.gamePage.diplomacy;
      const manpowerCost = diplomacy && typeof diplomacy.getManpowerCost === "function" ? diplomacy.getManpowerCost() : (diplomacy && diplomacy.baseManpowerCost) || 50;
      const goldCost = diplomacy && typeof diplomacy.getGoldCost === "function" ? diplomacy.getGoldCost() : (diplomacy && diplomacy.baseGoldCost) || 15;
      if (manpowerCost > 0) prices.push({ name: "manpower", val: manpowerCost });
      if (goldCost > 0) prices.push({ name: "gold", val: goldCost });
    } catch (error) {
      prices.push({ name: "manpower", val: 50 }, { name: "gold", val: 15 });
    }
    const buy = race && race.buys && race.buys[0];
    if (buy && buy.name && buy.val > 0) prices.push({ name: buy.name, val: buy.val });
    return prices;
  };

  const tradeWithRace = (race, count = 1) => {
    const diplomacy = window.gamePage && window.gamePage.diplomacy;
    const amount = Math.max(1, Math.floor(count) || 1);
    const beforeTitanium = resourceValue(resourceMap(), "titanium");
    const costsBefore = tradePricesForRace(race).map((price) => ({ name: price.name, value: resourceValue(resourceMap(), price.name) }));
    if (!diplomacy || !race) return false;
    try {
      if (typeof diplomacy.tradeMultiple === "function") diplomacy.tradeMultiple(race, amount);
      else if (typeof diplomacy.trade === "function") {
        for (let i = 0; i < amount; i += 1) diplomacy.trade(race);
      } else if (typeof diplomacy.tradeAll === "function") diplomacy.tradeAll(race);
    } catch (error) {
      return false;
    }
    if (resourceValue(resourceMap(), "titanium") > beforeTitanium) return true;
    return costsBefore.some(({ name, value }) => resourceValue(resourceMap(), name) < value);
  };

  // How many Zebra trades we can fire in one batch.  Single-trade-per-tick is
  // why hand-trading feels faster than the bot: with a 10s diplomacy throttle a
  // 15%-odds trade trickles in titanium.  We batch up to what the SURPLUS (after
  // plan reservations) can pay, but never more than is needed to cover the
  // current titanium demand, and never enough to overflow the titanium cap.
  const MAX_TRADE_BATCH = 50;
  const affordableTradeCount = (prices, reserved, resources) => {
    let count = Infinity;
    for (const price of prices) {
      if (!price || !price.name || !isFinite(price.val) || price.val <= 0) continue;
      const stock = resourceValue(resources, price.name);
      const hold = reserved[price.name] || (price.name === "catpower" ? reserved.manpower || 0 : 0);
      const spendable = Math.max(0, stock - Math.max(0, hold));
      count = Math.min(count, Math.floor(spendable / price.val));
    }
    return isFinite(count) ? Math.max(0, count) : 0;
  };

  const zebraTradeBatchSize = (resources, reserved, goalKey, prices) => {
    const affordable = affordableTradeCount(prices, reserved, resources);
    if (affordable <= 0) return 0;
    const stats = zebraTitaniumStats(resources);
    const perTrade = Math.max(0.1, stats.expected); // expected titanium per trade
    const demand = titaniumDemandAmount(resources, goalKey);
    const titanium = getRes(resources, "titanium");
    // Enough trades to expect to cover the demand (at least one), capped so a
    // lucky all-hit batch cannot blow far past the storage cap.
    let batch = Math.max(1, Math.ceil(Math.max(demand, perTrade) / perTrade));
    if (titanium && titanium.maxValue > 0) {
      const headroom = Math.max(0, titanium.maxValue - titanium.value);
      batch = Math.min(batch, Math.max(1, Math.ceil(headroom / Math.max(0.1, stats.amount))));
    }
    return Math.max(1, Math.min(batch, affordable, MAX_TRADE_BATCH));
  };

  const craftDiplomacyPrerequisites = (resources, goalKey) => {
    try {
      if (!titaniumNeededSoon(resources, goalKey)) {
        diplomacyPrepText = "Diplomacy prep: watching trade unlocks";
        return;
      }
      const zebras = raceByName("zebras");
      const ships = resourceValue(resources, "ship");
      const shipCraftBlocked = shipCraftWouldStealFromActivePlan(resources, goalKey);
      if (shipCraftBlocked) {
        const target = getTargetCached(resources, goalKey);
        diplomacyPrepText = `Diplomacy prep: ${zebraTitaniumOddsText(resources, goalKey)}; finishing ${labelOf(target.meta)} first`;
      } else if (ships < 1 && craftByName("ship")) {
        diplomacyPrepText = "Diplomacy prep: crafting first ship to reveal Zebras";
        tryCraftResource("ship", 1);
      } else if (ships >= 1 && zebras && !zebras.unlocked) {
        diplomacyPrepText = "Diplomacy prep: saving Catpower to send explorers for Zebras";
      } else if (zebras && zebras.unlocked && craftByName("ship")) {
        const targetShips = desiredZebraShipCount(resources, goalKey);
        diplomacyPrepText = `Diplomacy prep: ${zebraTitaniumOddsText(resources, goalKey)}`;
        if (shipsAreCapped(resources)) {
          // Ship storage is full — the fleet can't grow, so don't spin on a
          // capped bar; just keep trading at whatever odds the cap allows.
          diplomacyPrepText = `Diplomacy prep: ship fleet at storage cap (${fmt(shipCapacity(resources))}) — trading at current odds`;
        } else if (targetShips > Math.floor(ships)) {
          // Build toward the WHOLE intended fleet from surplus this tick
          // (tryCraftResource partial-fills and honours plan reservations), so
          // trade odds and payout ramp quickly instead of crawling up one ship
          // per tick while low-odds trades trickle in titanium and stall the plan.
          tryCraftResource("ship", targetShips);
        }
      }
    } catch (error) {
      /* ignore diplomacy prerequisite crafting failures */
    }
  };


  const diplomacyResourcePressure = (resources, goalKey) => {
    const pressure = {};
    const addPriceDeficits = (prices, multiplier = 1) => {
      for (const price of prices || []) {
        if (!price || !price.name || !isFinite(price.val) || price.val <= 0) continue;
        const have = resourceValue(resources, price.name) + craftablePotential(price.name);
        const deficit = Math.max(0, price.val - have);
        if (deficit <= 0) continue;
        const cap = (getRes(resources, price.name) || {}).maxValue || 0;
        const capScale = cap > 0 ? Math.min(1, deficit / cap) : 0.5;
        pressure[price.name === "catpower" ? "manpower" : price.name] = (pressure[price.name === "catpower" ? "manpower" : price.name] || 0) + multiplier * (2 + capScale * 10);
      }
    };

    if (shouldSaveForExplorers(resources, goalKey)) addPriceDeficits(explorerPrices(), 1.4);

    if (titaniumNeededSoon(resources, goalKey)) {
      const zebras = raceByName("zebras");
      if (zebras && zebras.unlocked) {
        addPriceDeficits(tradePricesForRace(zebras), 1.8);
      }
    }

    return pressure;
  };

  const pricesRespectReservations = (prices, reserved, resources) => prices.every((price) => {
    if (!price || !price.name || !isFinite(price.val) || price.val <= 0) return true;
    const hold = reserved[price.name] || (price.name === "catpower" ? reserved.manpower || 0 : 0);
    if (hold <= 0) return true;
    const stock = ((getRes(resources, price.name) || {}).value) || 0;
    return stock - price.val >= hold;
  });

  const writingResearched = () => {
    try {
      const writing = window.gamePage.science && window.gamePage.science.get && window.gamePage.science.get("writing");
      return !writing || writing.researched;
    } catch (error) {
      return true;
    }
  };

  const embassyPricesForRace = (race) => {
    try {
      const game = window.gamePage;
      const Controller = getGlobalPath(["classes", "diplomacy", "ui", "EmbassyButtonController"]);
      if (game && typeof Controller === "function") {
        const controller = new Controller(game);
        const model = controller.fetchModel({ prices: race.embassyPrices, race, controller });
        if (model && typeof controller.getPrices === "function") return controller.getPrices(model) || race.embassyPrices || [];
      }
    } catch (error) {
      /* fall through to metadata pricing */
    }
    const reduction = (() => {
      try { return 1 - (window.gamePage.getEffect("embassyCostReduction") || 0); } catch (error) { return 1; }
    })();
    const fakeBought = (() => {
      try { return window.gamePage.getEffect("embassyFakeBought") || 0; } catch (error) { return 0; }
    })();
    return (race.embassyPrices || []).map((price) => ({ ...price, val: price.val * reduction * Math.pow(1.15, (race.embassyLevel || 0) + fakeBought) }));
  };

  const buyEmbassyForRace = (race) => {
    const game = window.gamePage;
    const before = race.embassyLevel || 0;
    try {
      const Controller = getGlobalPath(["classes", "diplomacy", "ui", "EmbassyButtonController"]);
      if (game && typeof Controller === "function") {
        const controller = new Controller(game);
        const model = controller.fetchModel({ prices: race.embassyPrices, race, controller });
        if (model && typeof controller.buyItem === "function") controller.buyItem(model, { boughtByQueue: true });
        if ((race.embassyLevel || 0) > before) return true;
      }
    } catch (error) {
      /* try raw metadata below */
    }
    const prices = embassyPricesForRace(race).filter((price) => price && price.name && price.val > 0);
    if (!prices.length || !canPayPrices(prices) || !rawPayPrices(prices)) return false;
    race.embassyLevel = before + 1;
    if (game && game.diplomacy && typeof game.diplomacy.triggerOnEmbassyCountChanged === "function") game.diplomacy.triggerOnEmbassyCountChanged();
    if (game && typeof game.render === "function") game.render();
    return (race.embassyLevel || 0) > before;
  };

  // The live "Send explorers" fee (1000 catpower stock) read from the game's
  // own trade-tab button when present, so cost changes track the game itself.
  const explorerPrices = () => {
    try {
      const btn = window.gamePage.tradeTab && window.gamePage.tradeTab.exploreBtn;
      const prices = (btn && btn.model && btn.model.prices) || (btn && btn.opts && btn.opts.prices);
      const manpower = Array.isArray(prices) && prices.find((price) => price && price.name === "manpower" && price.val > 0);
      if (manpower) return [{ name: "manpower", val: manpower.val }];
    } catch (error) {
      /* fall through to the stock fee */
    }
    return [{ name: "manpower", val: 1000 }];
  };

  // Discovering a trade partner beats hoarding catpower: explore as soon as
  // the fee fits and the plan's reservations allow it. (The old near-cap gate
  // could deadlock against auto-hunting, which fires below it — explorers
  // would then never be sent for the rest of the run.)
  const maybeSendExplorers = (resources, reserved) => {
    const game = window.gamePage;
    const diplomacy = game && game.diplomacy;
    if (!diplomacy || typeof diplomacy.unlockRandomRace !== "function") return false;
    const price = explorerPrices();
    if (!hasLockedDiscoverableRace() || !canPayPrices(price) || !pricesRespectReservations(price, reserved, resources)) return false;
    const before = unlockedRaces().length;
    if (!rawPayPrices(price)) return false;
    const race = diplomacy.unlockRandomRace();
    if (!race && game.resPool && typeof game.resPool.addResEvent === "function") game.resPool.addResEvent("manpower", price[0].val * 0.95);
    if (game && typeof game.render === "function") game.render();
    const after = unlockedRaces().length;
    if (after > before || race) {
      diplomacyPlanText = `Diplomacy: sent explorers; met ${(race && (race.title || race.name)) || "a civilization"}`;
      pushLog(`🧭 ${diplomacyPlanText}`);
      return true;
    }
    diplomacyPlanText = "Diplomacy: explorers need later unlock conditions";
    return false;
  };

  const maybeTradeForTitanium = (resources, reserved, goalKey) => {
    const titanium = getRes(resources, "titanium");
    const targetNeedsTitanium = titaniumNeededSoon(resources, goalKey);
    if (!targetNeedsTitanium) return false;
    if (titanium && titanium.maxValue > 0 && titanium.value >= titanium.maxValue * 0.995) {
      const target = getTargetCached(resources, goalKey);
      const stillMissingTitanium = targetMissingResource(target, resources, "titanium");
      diplomacyPlanText = stillMissingTitanium
        ? "Diplomacy: titanium capped below the plan cost — build storage before more Zebra trades"
        : "Diplomacy: titanium is full; saving the other plan costs before spending it";
      return false;
    }
    const zebras = raceByName("zebras");
    if (!zebras || !zebras.unlocked) return false;
    const prices = tradePricesForRace(zebras);
    const odds = zebraTitaniumOddsText(resources, goalKey);
    if (!prices.length || !canPayPrices(prices) || !pricesRespectReservations(prices, reserved, resources)) {
      const missing = prices
        .filter((price) => price && price.name && resourceValue(resources, price.name) < price.val)
        .map((price) => `${fmt(price.val - resourceValue(resources, price.name))} ${resTitle(resources, price.name)}`)
        .slice(0, 3)
        .join(", ");
      diplomacyPlanText = missing ? `Diplomacy: Zebra titanium trade needs ${missing} · ${odds}` : `Diplomacy: holding Zebra trade for plan reservations · ${odds}`;
      return false;
    }
    const batch = zebraTradeBatchSize(resources, reserved, goalKey, prices);
    const measured = withActionResourceDeltas(() => tradeWithRace(zebras, batch), tradeDeltaNamesForRace(zebras, prices));
    if (measured.result) {
      const batchNote = batch > 1 ? `×${batch}` : "";
      diplomacyPlanText = `Diplomacy: traded with Zebras${batchNote} for titanium path · ${odds}`;
      pushLog(`🦓 Zebras trade${batchNote ? ` ${batchNote}` : ""}: ${measured.suffix}; reason titanium path`);
      return true;
    }
    return false;
  };


  const tradeSellExpected = (sell) => {
    if (!sell || !sell.name) return 0;
    const amount = isFinite(sell.value) ? sell.value : (isFinite(sell.val) ? sell.val : 0);
    const chance = isFinite(sell.chance) ? sell.chance / 100 : 1;
    return Math.max(0, amount * Math.max(0, Math.min(1, chance || 0)));
  };

  const targetTradeChainDemand = (target, resources) => {
    const demand = {};
    if (!target || target.affordable) return demand;
    for (const cost of pricesFor(target.kind, target.meta)) {
      if (!cost || !cost.name || !isFinite(cost.val) || cost.val <= 0) continue;
      if (!TARGET_TRADE_CHAIN.has(cost.name)) continue;
      const have = resourceValue(resources, cost.name);
      const missing = Math.max(0, cost.val - have - craftablePotential(cost.name));
      if (missing <= 0 && have >= cost.val) continue;
      demand[cost.name] = Math.max(demand[cost.name] || 0, Math.max(1, cost.val - have));
      for (const name of craftChainOutputsFor(cost.name)) demand[name] = Math.max(demand[name] || 0, 1);
    }
    return demand;
  };

  const targetTradeYieldValue = (demand, sellName, amount) => {
    if (!amount || amount <= 0) return 0;
    if (demand.compedium && sellName === "compedium") return amount;
    if (demand.compedium && sellName === "compendium") return amount;
    if (demand.compedium && sellName === "manuscript") return amount / 50;
    if (demand.compedium && sellName === "parchment") return amount / (50 * 25);
    if (demand.compedium && sellName === "furs") return amount / (50 * 25 * 175);
    if (demand.manuscript && sellName === "manuscript") return amount / 50;
    if (demand.manuscript && sellName === "parchment") return amount / (50 * 25);
    if (demand.parchment && sellName === "parchment") return amount / (50 * 25);
    return 0;
  };

  const targetTradeScore = (race, target, resources, reserved) => {
    const demand = targetTradeChainDemand(target, resources);
    if (!Object.keys(demand).length) return null;
    const prices = tradePricesForRace(race);
    if (!prices.length || !pricesRespectReservations(prices, reserved, resources)) return null;
    const affordable = affordableTradeCount(prices, reserved, resources);
    if (affordable <= 0) return null;
    let value = 0;
    const goods = [];
    for (const sell of race.sells || []) {
      const expected = tradeSellExpected(sell);
      const contribution = targetTradeYieldValue(demand, sell.name, expected);
      if (contribution > 0) {
        value += contribution;
        goods.push({ name: sell.name, expected });
      }
    }
    if (value <= 0) return null;
    const scarcePenalty = prices.some((price) => {
      const stock = resourceValue(resources, price.name);
      const cap = ((getRes(resources, price.name) || {}).maxValue) || 0;
      return cap > 0 && stock / cap < 0.15;
    }) ? 0.25 : 0;
    return { race, prices, affordable, goods, score: value - scarcePenalty, value };
  };

  const maybeTradeForTargetChain = (resources, reserved, goalKey, target) => {
    const options = unlockedRaces()
      .map((race) => targetTradeScore(race, target, resources, reserved))
      .filter((item) => item && item.score > 0.0005)
      .sort((a, b) => b.score - a.score);
    const best = options[0];
    if (!best) return false;
    const batch = Math.max(1, Math.min(best.affordable, 10));
    const measured = withActionResourceDeltas(() => tradeWithRace(best.race, batch), tradeDeltaNamesForRace(best.race, best.prices));
    if (!measured.result) return false;
    const raceName = best.race.title || best.race.name || "civilization";
    diplomacyPlanText = `Targeted trade: ${raceName} for ${labelOf(target.meta)} Compendium chain`;
    pushLog(`🤝 ${raceName} trade${batch > 1 ? ` ×${batch}` : ""}: ${measured.suffix}; reason target-chain ${labelOf(target.meta)}`);
    return true;
  };

  const maybeBuildEmbassy = (resources, reserved) => {
    if (!writingResearched()) return false;
    const races = unlockedRaces()
      .filter((race) => race.embassyPrices && race.embassyPrices.length)
      .map((race) => ({ race, prices: embassyPricesForRace(race) }))
      .filter((item) => item.prices.length && canPayPrices(item.prices) && pricesRespectReservations(item.prices, reserved, resources))
      .sort((a, b) => (a.race.embassyLevel || 0) - (b.race.embassyLevel || 0));
    const next = races[0];
    if (!next) return false;
    const measured = withActionResourceDeltas(() => buyEmbassyForRace(next.race), new Set(next.prices.map((price) => price.name)));
    if (measured.result) {
      diplomacyPlanText = `Diplomacy: built embassy with ${next.race.title || next.race.name} (level ${next.race.embassyLevel || 1})`;
      pushLog(`🏛 embassy with ${next.race.title || next.race.name}: ${measured.spent || "cost paid"}; level ${next.race.embassyLevel || 1}; reason diplomacy`);
      return true;
    }
    return false;
  };

  // The Zebra Relations policies (culture-cost, mutually exclusive) change how
  // the Zebras deal with us; Appeasement is the trade-friendly side — better
  // relations and trade outcomes.  The generic policy automation leaves
  // exclusive choices to the player, but when titanium is gated behind Zebra
  // trades this policy IS the bottleneck lever, so adopt the trade side as a
  // one-time pick instead of leaving it unbought while titanium stalls.
  const zebraTradePolicyMeta = () => {
    for (const meta of policyMetas()) {
      if (!policyOpen(meta)) continue;
      const id = `${(meta && meta.name) || ""} ${labelOf(meta)}`.toLowerCase();
      if (/zebra/.test(id) && /appeas/.test(id)) return meta;
    }
    return null;
  };

  const maybeAdoptZebraTradePolicy = (resources, reserved, goalKey) => {
    if (!titaniumNeededSoon(resources, goalKey)) return false;
    const zebras = raceByName("zebras");
    if (!zebras || !zebras.unlocked) return false;
    const meta = zebraTradePolicyMeta();
    if (!meta) return false;
    const candidate = { kind: "policy", meta, ...evaluate("policy", meta, resources) };
    const prices = pricesFor("policy", meta);
    if (!candidate.affordable || !pricesRespectReservations(prices, reserved, resources)) {
      diplomacyPlanText = `Diplomacy: saving for ${labelOf(meta)} — improves Zebra titanium trades`;
      return false;
    }
    if (buyCandidate(candidate)) {
      diplomacyPlanText = `Diplomacy: adopted ${labelOf(meta)} to improve Zebra titanium trades`;
      pushLog(`📜 ${diplomacyPlanText}`);
      return true;
    }
    return false;
  };

  const manageDiplomacy = (resources, goalKey) => {
    try {
      if (Date.now() - lastDiplomacyAction < 10000) return;
      const target = getTargetCached(resources, goalKey);
      const reserved = reservedNeedsFor(target, resources);
      refreshStickyTargetChainReserve(target, resources);
      if (maybeAdoptZebraTradePolicy(resources, reserved, goalKey) || maybeSendExplorers(resources, reserved) || maybeTradeForTitanium(resources, reserved, goalKey) || maybeTradeForTargetChain(resources, reserved, goalKey, target) || maybeBuildEmbassy(resources, reserved)) {
        lastDiplomacyAction = Date.now();
        return;
      }
      const raceCount = unlockedRaces().length;
      const prep = diplomacyPrepText && !/watching/.test(diplomacyPrepText) ? ` · ${diplomacyPrepText.replace(/^Diplomacy prep: /, "")}` : "";
      const zebraOdds = raceByName("zebras") && raceByName("zebras").unlocked && titaniumNeededSoon(resources, goalKey) ? ` · ${zebraTitaniumOddsText(resources, goalKey)}` : "";
      diplomacyPlanText = raceCount ? `Diplomacy: ${raceCount} trade partner${raceCount === 1 ? "" : "s"}; embassies watched${prep || zebraOdds}` : `Diplomacy: saving catpower for explorers${prep}`;
    } catch (error) {
      /* ignore diplomacy fallback failures */
    }
  };

  /* ------------------------------ action log -------------------------------- */

  let actionLog = [];
  try {
    actionLog = JSON.parse(localStorage.getItem(LOG_KEY)) || [];
  } catch (error) {
    actionLog = [];
  }

  const prev = { build: {}, tech: {}, upgrade: {}, resource: {}, race: {} };
  let seeded = false;
  let logBox;

  const renderLog = () => {
    if (logBox) logBox.textContent = actionLog.slice(0, 12).join("\n") || "(waiting…)";
  };

  const pushLog = (text) => {
    const time = new Date().toLocaleTimeString();
    actionLog.unshift(`${time}  ${text}`);
    actionLog = actionLog.slice(0, 50);
    try {
      localStorage.setItem(LOG_KEY, JSON.stringify(actionLog));
    } catch (error) {
      /* ignore */
    }
    renderLog();
  };

  // Recent-action logging is action-scoped, not tick-scoped: every automation
  // click/craft/trade/hunt takes a resource snapshot immediately before and
  // after that exact operation.  This prevents same-tick side effects (hunters,
  // embassies, overflow crafts, job changes, normal production) from being
  // merged into one misleading "trade" line.
  const resourceSnapshot = () => resourceMap();

  const resourceDeltasBetween = (before, after, names = null) => {
    const wanted = names ? new Set([...names].filter(Boolean)) : null;
    const seen = new Set([...(before ? before.keys() : []), ...(after ? after.keys() : [])]);
    return [...seen]
      .filter((name) => !wanted || wanted.has(name))
      .map((name) => ({ name, delta: resourceValue(after, name) - resourceValue(before, name) }))
      .filter(({ delta }) => Math.abs(delta) > 0.0001);
  };

  const formatResourceDeltaList = (resources, deltas, sign) => deltas
    .filter(({ delta }) => sign > 0 ? delta > 0 : delta < 0)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, 6)
    .map(({ name, delta }) => formatDelta(resources, name, delta))
    .join(", ");

  const formatActionDeltas = (before, after, names = null) => {
    const deltas = resourceDeltasBetween(before, after, names);
    const gained = formatResourceDeltaList(after, deltas, 1);
    const spent = formatResourceDeltaList(after, deltas, -1);
    return { deltas, gained, spent, suffix: `${gained || "no resource gain"}${spent ? ` (${spent})` : ""}` };
  };

  const tradeDeltaNamesForRace = (race, prices = null) => new Set([
    ...((prices || tradePricesForRace(race)).map((price) => price && price.name)),
    ...(((race && race.sells) || []).map((sell) => sell && sell.name)),
    ...(((race && race.buys) || []).map((buy) => buy && buy.name)),
  ].filter(Boolean));

  const withActionResourceDeltas = (action, names = null) => {
    const before = resourceSnapshot();
    const result = action();
    const after = resourceSnapshot();
    return { result, before, after, ...formatActionDeltas(before, after, names) };
  };


  const diplomacyRaces = (game) => {
    try {
      const races = game && game.diplomacy && game.diplomacy.races;
      return Array.isArray(races) ? races : [];
    } catch (error) {
      return [];
    }
  };

  const raceKey = (race) => String((race && (race.name || race.title)) || "unknown");

  const raceTradeCount = (race) => {
    for (const key of ["tradeTotal", "totalTrades", "tradeCount", "trades", "buys"]) {
      const value = race && race[key];
      if (isFinite(value)) return value;
    }
    return null;
  };

  const trackDiplomacyActionDeltas = (game) => {
    for (const race of diplomacyRaces(game)) {
      if (!race) continue;
      const key = raceKey(race);
      const before = prev.race[key] || {};
      const now = {
        unlocked: !!race.unlocked,
        embassyLevel: race.embassyLevel || 0,
        tradeCount: raceTradeCount(race),
      };
      if (seeded && before.unlocked === false && now.unlocked) {
        pushLog(`🧭 met ${race.title || race.name || "a civilization"}`);
      }
      if (seeded && now.embassyLevel > (before.embassyLevel || 0)) {
        pushLog(`🤝 embassy with ${race.title || race.name || "civilization"} → ${now.embassyLevel}`);
      }
      if (seeded && now.tradeCount != null && before.tradeCount != null && now.tradeCount > before.tradeCount) {
        pushLog(`📋 cycle summary: ${race.title || race.name || "civilization"} trade counter → ${now.tradeCount} (resource deltas not action-scoped)`);
      }
      prev.race[key] = now;
    }
  };

  const formatDelta = (resources, name, amount) => `${amount > 0 ? "+" : ""}${fmt(amount)} ${resTitle(resources, name)}`;

  // Detect what changed in game state and log it (no dependency on KS/game log
  // message formats — we just diff building counts and researched flags).
  const trackActions = () => {
    try {
      const game = window.gamePage;
      for (const b of buildingMetas()) {
        if (!b || !b.name) continue;
        const now = b.val || 0;
        if (seeded && prev.build[b.name] != null && now > prev.build[b.name]) {
          pushLog(`🏗 ${labelOf(b)} → ${now}`);
        }
        prev.build[b.name] = now;
      }
      for (const t of game.science.techs || []) {
        if (!t || !t.name) continue;
        if (seeded && prev.tech[t.name] === false && t.researched) {
          pushLog(`🔬 researched ${labelOf(t)}`);
        }
        prev.tech[t.name] = !!t.researched;
      }
      for (const u of game.workshop.upgrades || []) {
        if (!u || !u.name) continue;
        if (seeded && prev.upgrade[u.name] === false && u.researched) {
          pushLog(`⚙ ${labelOf(u)}`);
        }
        prev.upgrade[u.name] = !!u.researched;
      }
      trackDiplomacyActionDeltas(game);
      seeded = true;
    } catch (error) {
      /* ignore */
    }
  };


  /* -------------------------- leader specialization -------------------------- */

  const LEADER_RECHECK_MS = 90000;
  let lastLeaderCheck = 0;
  let leaderPlanText = "Leader: waiting…";

  const desiredLeaderTraits = (goalKey, resources) => {
    const target = getTargetCached(resources, goalKey);
    const emphasis = (GOALS[goalKey] && GOALS[goalKey].emphasis) || {};
    const traits = [];
    const text = target ? `${target.kind} ${effectText(target.meta)}` : "";
    const costs = target ? pricesFor(target.kind, target.meta).map((cost) => cost && cost.name).filter(Boolean) : [];

    if ((target && target.kind === "research") || costs.includes("science") || (emphasis.science || 1) > 1) traits.push("scientist");
    if (costs.some((name) => ["steel", "gear", "alloy", "plate"].includes(name)) || /steel|gear|alloy|plate|coal|smelter|furnace/.test(text)) traits.push("metallurgist");
    if (costs.some((name) => ["concrate", "kerosene", "thorium", "eludium"].includes(name)) || /concrete|concrate|kerosene|thorium|reactor|eludium/.test(text)) traits.push("chemist");
    if (costs.some((name) => ["beam", "slab", "parchment", "manuscript", "compedium", "blueprint"].includes(name)) || /workshop|craft|beam|slab|blueprint/.test(text)) traits.push("engineer");
    if (huntingEconomyNeed(resources) > 3 || resRatio(resources, "manpower", 0) < 0.35) traits.push("manager");
    if (target && target.kind === "trade") traits.push("merchant");
    if (costs.includes("faith") || ((emphasis.production || 1) > 1 && resRatio(resources, "faith", 1) < 0.6)) traits.push("wise");
    traits.push("engineer", "scientist", "manager", "metallurgist", "wise", "merchant", "chemist");
    return [...new Set(traits)];
  };

  const kittenScore = (kitten, traitName, targetJob) => {
    let score = 0;
    if (kitten.trait && kitten.trait.name === traitName) score += 1000;
    if (kitten.job && kitten.job === targetJob) score += 120;
    if (kitten.isLeader) score += 25;
    score += Math.min(500, (kitten.rank || 0) * 30 + ((kitten.exp || 0) / 500));
    try {
      const skills = kitten.skills || {};
      const skill = skills[targetJob];
      if (skill && isFinite(skill)) score += Math.min(150, skill / 10);
    } catch (error) {
      /* ignore */
    }
    return score;
  };

  const policyMetas = () => {
    try {
      const science = window.gamePage && window.gamePage.science;
      const pools = [science && science.policies, science && science.policy, science && science.policiesData];
      for (const pool of pools) {
        if (Array.isArray(pool)) return pool;
      }
    } catch (error) {
      /* ignore */
    }
    return [];
  };

  const policyOpen = (meta) => isOpen(meta) && meta.blocked !== true && meta.disabled !== true;

  const isSocialismPolicy = (meta) => {
    const id = `${(meta && meta.name) || ""} ${labelOf(meta)}`.toLowerCase();
    return /\bsocialism\b/.test(id);
  };

  const isNoopPolicyCandidate = (candidate) => candidate && candidate.kind === "policy" && isSocialismPolicy(candidate.meta);

  // A policy with an empty `blocks` list forecloses nothing — buying it can
  // never lock you out of another choice, so it's safe to automate. Exclusive
  // policies (liberty vs tradition, monarchy vs republic …) stay manual.
  const policyIsExclusive = (meta) => Array.isArray(meta && meta.blocks) && meta.blocks.length > 0;

  const autoPolicyChoice = (resources, goalKey) => {
    for (const meta of policyMetas()) {
      if (!policyOpen(meta) || policyIsExclusive(meta) || isSocialismPolicy(meta)) continue;
      const candidate = { kind: "policy", meta, ...evaluate("policy", meta, resources) };
      if (candidate.affordable) return candidate;
    }
    return null;
  };

  const summarizeEffects = (meta) => {
    const effects = (meta && meta.effects) || {};
    const pros = [];
    const cons = [];
    for (const [key, raw] of Object.entries(effects)) {
      if (!isFinite(raw) || raw === 0) continue;
      const label = key
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/PerTick/g, "/tick")
        .replace(/Ratio/g, " ratio")
        .replace(/Max/g, " storage")
        .toLowerCase();
      const item = `${raw > 0 ? "+" : ""}${fmt(raw)} ${label}`;
      (raw > 0 ? pros : cons).push(item);
    }
    const text = effectText(meta);
    if (!pros.length && /science|scholar|library|academy|observatory/.test(text)) pros.push("helps science progress");
    if (!pros.length && /production|worker|mineral|wood|coal|craft|engineer/.test(text)) pros.push("helps production/crafting");
    if (!cons.length && /unhappiness|happiness.*-|-.*happiness/.test(text)) cons.push("may reduce happiness");
    return {
      pros: pros.slice(0, 3),
      cons: cons.slice(0, 3),
    };
  };

  // Exclusive policies are ranked with the same universal framework as every
  // other candidate: parsed economic effects plus goal alignment, minus the
  // number of visible downsides.
  const policyScore = (meta, resources, goalKey) => {
    const goal = GOALS[goalKey];
    const { cons } = summarizeEffects(meta);
    let score = economicValue("policy", meta, resources, goal, goalKey) + goalAlignmentBoost("policy", meta, goalKey);
    score -= cons.length * 4;
    return score;
  };

  // Only EXCLUSIVE policies appear here — the executor auto-buys the rest.
  const availablePolicyChoices = (resources, goalKey) => policyMetas()
    .filter((meta) => policyOpen(meta) && policyIsExclusive(meta) && !isSocialismPolicy(meta))
    .map((meta) => ({ kind: "policy", meta, ...evaluate("policy", meta, resources), score: policyScore(meta, resources, goalKey) }))
    .sort((a, b) => b.score - a.score);

  const policyAdviceLine = (resources, goalKey) => {
    const choices = availablePolicyChoices(resources, goalKey);
    if (!choices.length) return "Policies: non-exclusive auto-buy; no exclusive choice pending";
    const best = choices[0];
    const { pros, cons } = summarizeEffects(best.meta);
    const state = best.affordable ? "ready" : `need ${best.missing || "resources"}`;
    return `Policies: exclusive choice! rec ${labelOf(best.meta)} (blocks ${(best.meta.blocks || []).join(", ")}) (${state}) · pros: ${(pros.length ? pros : ["unlocks future choices"]).join("; ")} · cons: ${(cons.length ? cons : ["none obvious"]).join("; ")}`;
  };

  const buyPolicyChoice = (name) => {
    const meta = policyMetas().find((policy) => policy && policy.name === name);
    if (!meta) return false;
    const candidate = { kind: "policy", meta, ...evaluate("policy", meta, resourceMap()) };
    if (!candidate.affordable) return false;
    for (const attempt of purchaseAttemptsFor(candidate)) {
      try {
        attempt();
      } catch (error) {
        /* try next API shape */
      }
      if (purchaseComplete(candidate, 0)) {
        pushLog(`📜 policy ${labelOf(meta)}`);
        return true;
      }
    }
    return false;
  };

  const maybeSelectLeader = (goalKey, resources) => {
    try {
      const now = Date.now();
      if (now - lastLeaderCheck < LEADER_RECHECK_MS) return;
      lastLeaderCheck = now;
      const village = window.gamePage.village;
      if (!village || typeof village.makeLeader !== "function" || !village.sim || !Array.isArray(village.sim.kittens)) return;
      const kittens = village.sim.kittens.filter((kitten) => kitten && kitten.trait && kitten.trait.name && kitten.trait.name !== "none");
      if (!kittens.length) return;
      const traits = desiredLeaderTraits(goalKey, resources);
      const { needs } = resourceNeeds(goalKey, resources);
      const bestNeed = Object.entries(needs).sort((a, b) => b[1] - a[1])[0];
      const targetJob = bestNeed ? (RES_JOB[bestNeed[0]] || bestNeed[0]) : "engineer";
      let best = null;
      for (const trait of traits) {
        const candidate = kittens
          .filter((kitten) => kitten.trait && kitten.trait.name === trait)
          .sort((a, b) => kittenScore(b, trait, targetJob) - kittenScore(a, trait, targetJob))[0];
        if (candidate) {
          best = { kitten: candidate, trait };
          break;
        }
      }
      if (!best || best.kitten.isLeader) {
        if (village.leader) leaderPlanText = `Leader: ${village.leader.trait.title || village.leader.trait.name} (${village.leader.name || "kitten"})`;
        return;
      }
      village.makeLeader(best.kitten);
      leaderPlanText = `Leader: ${best.kitten.trait.title || best.trait} (${best.kitten.name || "kitten"})`;
      pushLog(`👑 ${leaderPlanText}`);
    } catch (error) {
      /* ignore */
    }
  };

  // Promotions are a pure win when gold would otherwise overflow at the cap:
  // they turn wasted income into permanently better workers. Gold below the
  // overflow band is left alone for trade and gold-priced builds.
  let nextPromoteAttempt = 0;

  const maybePromoteKittens = (resources) => {
    try {
      const village = window.gamePage.village;
      const gold = getRes(resources, "gold");
      if (!village || !gold || !(gold.maxValue > 0)) return;
      const now = Date.now();
      if (gold.value < gold.maxValue * 0.92 || now < nextPromoteAttempt) return;
      const before = gold.value;
      try {
        if (typeof village.promoteKittens === "function") {
          village.promoteKittens();
        } else if (village.leader && village.sim && typeof village.sim.promote === "function") {
          village.sim.promote(village.leader, (village.leader.rank || 0) + 1);
        }
      } catch (error) {
        /* promotion API mismatch — skip */
      }
      if (gold.value < before - 1) {
        nextPromoteAttempt = now + 30000;
        pushLog("🎖 promoted kittens (gold was capping)");
      } else {
        nextPromoteAttempt = now + 300000; // nobody promotable (exp/gold) — back off
      }
    } catch (error) {
      /* ignore */
    }
  };

  /* ------------------------------- main loop -------------------------------- */

  let statusEl;
  let goalEl;
  let bottleneckEl;
  let scienceEl;
  let planEl;
  let jobsEl;
  let buyEl;
  let resetEl;
  let leaderEl;
  let craftEl;
  let processingEl;
  let reserveStatusEl;
  let religionEl;
  let diplomacyEl;
  let policyEl;
  let policySelectEl;
  let policyApplyEl;
  let nowEl;
  let noteEl;
  let queueSelectEl;
  let queueAddEl;
  let queueListEl;

  // Human label for a queued targetId ("build:magneto" → "🏗 Magneto"), resolved
  // against the live candidate when possible so it shows the game's own name.
  const KIND_QUEUE_ICON = { build: "🏗", research: "🔬", upgrade: "⚙", religion: "☀", space: "🚀", time: "⏳", policy: "📜" };
  const queueItemLabel = (id, candidates) => {
    const candidate = findCandidateById(candidates || [], id);
    const [kind, name] = id.split(":");
    const icon = KIND_QUEUE_ICON[kind] || "🎯";
    return `${icon} ${candidate ? labelOf(candidate.meta) : name}`;
  };

  // Populate the "add to queue" picker with the buyable/open candidates not
  // already queued, and render the current queue with reorder/remove controls.
  const renderQueueControl = (resources, goalKey) => {
    if (!queueSelectEl || !queueListEl) return;
    const candidates = getCandidatesCached(resources, goalKey);
    const queued = new Set(readQueue().map((item) => item.id));
    const current = queueSelectEl.value;
    const pickable = candidates
      .filter((c) => ["build", "research", "upgrade", "religion", "space", "time"].includes(c.kind))
      .filter((c) => !queued.has(targetId(c)) && !targetComplete(c))
      .slice(0, 60);
    queueSelectEl.innerHTML = "";
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = pickable.length ? "Add to build queue…" : "Nothing new to queue";
    queueSelectEl.appendChild(placeholder);
    for (const c of pickable) {
      const option = document.createElement("option");
      option.value = targetId(c);
      option.textContent = `${queueItemLabel(targetId(c), candidates)}${c.affordable ? " — ready" : ""}`;
      queueSelectEl.appendChild(option);
    }
    const options = queueSelectEl.options ? [...queueSelectEl.options] : [];
    if (options.some((o) => o.value === current)) queueSelectEl.value = current;

    const queue = readQueue();
    queueListEl.innerHTML = "";
    queue.forEach((item, index) => {
      const row = document.createElement("div");
      row.className = "kgh-row";
      row.style.cssText = "gap:3px;align-items:center;justify-content:space-between";
      const label = document.createElement("span");
      label.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
      label.textContent = `${index + 1}. ${queueItemLabel(item.id, candidates)}`;
      const controls = document.createElement("span");
      controls.style.cssText = "white-space:nowrap;flex:0 0 auto";
      controls.innerHTML =
        `<button type="button" class="kgh-hbtn" data-id="${item.id}" data-action="up" title="Move up">▲</button>` +
        `<button type="button" class="kgh-hbtn" data-id="${item.id}" data-action="down" title="Move down">▼</button>` +
        `<button type="button" class="kgh-hbtn" data-id="${item.id}" data-action="remove" title="Remove">✕</button>`;
      row.appendChild(label);
      row.appendChild(controls);
      queueListEl.appendChild(row);
    });
  };

  const renderPolicyControl = (resources, goalKey) => {
    if (!policyEl) return;
    const choices = availablePolicyChoices(resources, goalKey);
    policyEl.textContent = `📜 ${policyAdviceLine(resources, goalKey)}`;
    if (!policySelectEl || !policyApplyEl) return;
    const current = policySelectEl.value;
    policySelectEl.innerHTML = "";
    if (!choices.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "No exclusive policy pending (others auto-buy)";
      policySelectEl.appendChild(option);
      policySelectEl.disabled = true;
      policyApplyEl.disabled = true;
      return;
    }
    for (const choice of choices.slice(0, 6)) {
      const option = document.createElement("option");
      option.value = choice.meta.name;
      option.textContent = `${choice === choices[0] ? "★ " : ""}${labelOf(choice.meta)} — ${choice.affordable ? "ready" : `need ${choice.missing || "resources"}`}`;
      policySelectEl.appendChild(option);
    }
    policySelectEl.disabled = false;
    policySelectEl.value = choices.some((choice) => choice.meta.name === current) ? current : choices[0].meta.name;
    const selected = choices.find((choice) => choice.meta.name === policySelectEl.value);
    policyApplyEl.disabled = !selected || !selected.affordable;
  };

  // The helper drives the game itself — there is no external engine. "Running"
  // just means our own loop is ticking; the heartbeat is the last tick time.
  let lastTickAt = 0;
  const helperRunning = () => lastTickAt > 0 && Date.now() - lastTickAt < 15000;

  const tick = () => {
    try {
      resetTickCache();
      sampleResourceTelemetry();
      let resources = resourceMap();
      const goal = getGoal();
      computeResetAdvisor();
      watchNewUnlocks();
      maybeObserveStars();
      refineSurplusCatnip();
      optimizeProcessing(resources, goal);
      craftTowardTarget(resources, goal);
      craftDiplomacyPrerequisites(resources, goal);
      // Crafting or trade can turn a plan affordable immediately. Re-read and
      // try the locked plan BEFORE any surplus/overflow conversion, otherwise a
      // generic craft can spend the exact raw resource window the plan needed.
      resetTickCache();
      resources = resourceMap();
      updateReserveStatus(resources, goal);
      executePlan(resources, goal);
      resetTickCache();
      resources = resourceMap();
      craftOverflowResources(resources, goal);
      resetTickCache();
      resources = resourceMap();
      managePraise(resources);
      // Purchases can change resource stocks, caps, unlocks and per-tick effects;
      // re-read before diplomacy/jobs so later decisions are based on the board
      // after the buy, not on the planning snapshot from before it.
      resetTickCache();
      resources = resourceMap();
      manageDiplomacy(resources, goal);
      manageTrade(resources, goal);
      resetTickCache();
      resources = resourceMap();
      balanceJobs(goal, resources);
      maybeSelectLeader(goal, resources);
      maybePromoteKittens(resources);
      autoHunt(resources);
      maybeHoldFestival(resources);
      trackActions();
      if (statusEl) statusEl.textContent = `Helper: ${helperRunning() ? "running ✓" : "starting…"}`;
      if (goalEl) {
        const line = getGoalLine(resources, goal);
        goalEl.textContent = line;
        goalEl.style.display = line ? "" : "none";
      }
      if (bottleneckEl) bottleneckEl.textContent = `⚖ ${getBottleneck(resources)}`;
      if (scienceEl) scienceEl.textContent = `🔬 Next science: ${getNextScience(resources, goal)}`;
      if (planEl) planEl.textContent = getPlanLine(resources, goal);
      if (noteEl) noteEl.textContent = getAutomationDetailsLine(resources, goal);
      if (jobsEl) jobsEl.textContent = `👷 ${jobPlanText}`;
      if (buyEl) buyEl.textContent = `🛒 ${buyPlanText}`;
      if (resetEl) resetEl.textContent = resetAdvisorText;
      if (leaderEl) leaderEl.textContent = `👑 ${leaderPlanText}`;
      if (craftEl) craftEl.textContent = `🧰 ${craftPlanText} · ${overflowPlanText}`;
      if (processingEl) processingEl.textContent = `⚙ ${processingPlanText}`;
      if (reserveStatusEl) reserveStatusEl.textContent = `🛡 ${reservePlanText}`;
      if (religionEl) religionEl.textContent = `☀ ${religionPlanText}`;
      if (diplomacyEl) diplomacyEl.textContent = `🤝 ${diplomacyPlanText}`;
      renderPolicyControl(resources, goal);
      renderQueueControl(resources, goal);
      if (nowEl) nowEl.textContent = `🎯 Now: ${getNowAction(resources, goal)}`;
      lastTickAt = Date.now();
    } catch (error) {
      /* ignore */
    }
  };

  /* ------------------------------- the panel -------------------------------- */

  const MIN_KEY = "kgh.min";

  const buildPanel = () => {
    if (!document.body) {
      setTimeout(buildPanel, 250);
      return;
    }
    const oldPanel = document.querySelector ? document.querySelector(".kgh-panel") : null;
    if (oldPanel) oldPanel.remove();
    const oldStyle = document.getElementById("kgh-style");
    if (oldStyle) oldStyle.remove();
    const style = document.createElement("style");
    style.id = "kgh-style";
    style.textContent =
      "body.kgh-helper-ready{overflow-x:hidden}" +
      ".kgh-panel{box-sizing:border-box;width:min(320px,calc(100dvw - 16px));max-width:calc(100dvw - 16px);" +
      "max-height:calc(100dvh - 16px);overflow:auto;overflow-x:hidden;contain:layout style;" +
      "user-select:text;-webkit-user-select:text}" +
      ".kgh-panel *{box-sizing:border-box;min-width:0;max-width:100%}" +
      ".kgh-panel small,.kgh-panel pre,.kgh-panel div{overflow-wrap:anywhere;word-break:normal}" +
      ".kgh-panel select{width:100%;min-width:0;user-select:auto;-webkit-user-select:auto}" +
      ".kgh-row{display:flex;gap:6px;min-width:0}" +
      ".kgh-grow{flex:1 1 auto;min-width:0}" +
      // Buttons must never shrink or wrap their label ("Appl\ny"): the panel's
      // global min-width:0 lets flex squeeze them, so pin them to content size.
      ".kgh-panel button{white-space:nowrap;flex:0 0 auto}" +
      ".kgh-note{display:block;color:#d9ccae;opacity:.78}" +
      ".kgh-details{border-top:1px solid #9b7a4d50;padding-top:3px}" +
      ".kgh-details>summary{cursor:pointer;opacity:.82;list-style:none}" +
      ".kgh-details>summary::-webkit-details-marker{display:none}" +
      ".kgh-details-body{display:grid;gap:4px;margin-top:4px}" +
      ".kgh-log{overflow:hidden auto}" +
      ".kgh-hbtn{cursor:pointer;background:transparent;color:#f7ead0;border:1px solid #9b7a4d;" +
      "border-radius:3px;font-size:11px;padding:1px 6px;margin-left:4px;flex:0 0 auto}" +
      "@media (max-width:700px){.kgh-panel{left:8px!important;right:8px!important;bottom:8px!important;width:auto!important;max-height:45dvh}}";
    document.head.appendChild(style);

    const box = document.createElement("div");
    box.className = "kgh-panel";
    box.style.cssText =
      "position:fixed;right:8px;bottom:8px;z-index:99999;padding:8px 9px;" +
      "background:#2b2118;color:#f7ead0;border:1px solid #9b7a4d;border-radius:5px;" +
      "font:12px/1.35 sans-serif;display:grid;gap:5px;box-shadow:0 2px 10px #0009";
    box.innerHTML = [
      '<div class="kgh-row" style="justify-content:space-between;align-items:center">',
      '<strong style="font-size:13px">🐱 Kittens Helper</strong><small style="opacity:.7;margin-left:4px">v' + HELPER_VERSION + '</small>',
      '<span style="white-space:nowrap"><button type="button" class="kgh-hbtn kgh-min" title="Minimize">–</button></span></div>',
      '<div class="kgh-body" style="display:grid;gap:5px">',
      '<div class="kgh-row"><button type="button" class="kgh-autopilot kgh-grow" style="cursor:pointer">Autopilot: ON</button></div>',
      // Single autopilot — no goal modes.  The manual build queue lets you force
      // specific buildings / research / workshop upgrades to the front of the plan.
      '<div class="kgh-row" style="gap:4px"><select class="kgh-queue-select kgh-grow" aria-label="add to build queue" style="min-width:0"></select>',
      '<button type="button" class="kgh-queue-add" style="cursor:pointer" title="Force this to the front of the plan">＋ Queue</button></div>',
      '<div class="kgh-queue-list" style="display:grid;gap:2px"></div>',
      '<small class="kgh-status" style="color:#9fd0ff">…</small>',
      '<small class="kgh-goal-line" style="color:#d8b6ff"></small>',
      '<small class="kgh-bottleneck" style="color:#f0b8a0">…</small>',
      '<small class="kgh-science" style="color:#bfe6a0">…</small>',
      '<small class="kgh-plan" style="color:#a7e8e0;font-weight:700">…</small>',
      '<small class="kgh-now" style="color:#e6d79a">…</small>',
      '<details class="kgh-details"><summary>More automation details</summary><div class="kgh-details-body">',
      '<small class="kgh-note"></small>',
      '<small class="kgh-jobs" style="color:#f3c37b">…</small>',
      '<small class="kgh-buy" style="color:#b8e2ff">…</small>',
      '<small class="kgh-reset" style="color:#a7f0b4">…</small>',
      '<small class="kgh-leader" style="color:#ffd18f">…</small>',
      '<small class="kgh-craft" style="color:#cdb7ff">…</small>',
      '<small class="kgh-processing" style="color:#c8d0ff">…</small>',
      '<small class="kgh-reserve" style="color:#9fd0ff">…</small>',
      '<small class="kgh-religion" style="color:#ffe3a3">…</small>',
      '<small class="kgh-diplomacy" style="color:#b7f0d0">…</small>',
      '<small class="kgh-policy" style="color:#ffc6e0">…</small>',
      '<div class="kgh-row" style="gap:4px"><select class="kgh-policy-select kgh-grow" aria-label="policy"></select>',
      '<button type="button" class="kgh-policy-apply" style="cursor:pointer" title="Apply the selected policy only after you choose it">Policy</button></div>',
      '<small style="opacity:.65">Resets stay OFF. Back up your save (Options → Export) first.</small>',
      '</div></details>',
      '<div style="opacity:.8;border-top:1px solid #9b7a4d50;padding-top:3px">Recent actions:</div>',
      '<pre class="kgh-log" style="margin:0;max-height:78px;white-space:pre-wrap;' +
        'font:11px/1.35 monospace;color:#d9ccae;background:#0003;padding:4px;border-radius:3px">…</pre>',
      "</div>",
    ].join("");

    const toggleBtn = box.querySelector(".kgh-autopilot");
    const minBtn = box.querySelector(".kgh-min");
    queueSelectEl = box.querySelector(".kgh-queue-select");
    queueAddEl = box.querySelector(".kgh-queue-add");
    queueListEl = box.querySelector(".kgh-queue-list");
    const body = box.querySelector(".kgh-body");
    statusEl = box.querySelector(".kgh-status");
    goalEl = box.querySelector(".kgh-goal-line");
    bottleneckEl = box.querySelector(".kgh-bottleneck");
    scienceEl = box.querySelector(".kgh-science");
    planEl = box.querySelector(".kgh-plan");
    jobsEl = box.querySelector(".kgh-jobs");
    buyEl = box.querySelector(".kgh-buy");
    resetEl = box.querySelector(".kgh-reset");
    leaderEl = box.querySelector(".kgh-leader");
    craftEl = box.querySelector(".kgh-craft");
    processingEl = box.querySelector(".kgh-processing");
    reserveStatusEl = box.querySelector(".kgh-reserve");
    religionEl = box.querySelector(".kgh-religion");
    diplomacyEl = box.querySelector(".kgh-diplomacy");
    policyEl = box.querySelector(".kgh-policy");
    policySelectEl = box.querySelector(".kgh-policy-select");
    policyApplyEl = box.querySelector(".kgh-policy-apply");
    nowEl = box.querySelector(".kgh-now");
    noteEl = box.querySelector(".kgh-note");
    logBox = box.querySelector(".kgh-log");

    const syncToggle = () => {
      toggleBtn.textContent = `Autopilot: ${isAutopilotOn() ? "ON" : "OFF"}`;
      toggleBtn.style.background = isAutopilotOn() ? "#2d6b3f" : "#5a3a3a";
    };
    toggleBtn.addEventListener("click", () => {
      const next = isAutopilotOn() ? "0" : "1";
      localStorage.setItem(STORAGE_KEY, next);
      syncToggle();
      applyProfile();
    });
    syncToggle();
    // Manual build queue: add the selected candidate, then re-plan immediately.
    queueAddEl.addEventListener("click", () => {
      const id = queueSelectEl && queueSelectEl.value;
      if (!id) return;
      const candidate = findCandidateById(getCandidatesCached(resourceMap(), getGoal()), id);
      queueAdd(id, candidate ? (Number(candidate.meta.val) || 0) : 0);
      activeTarget = null;
      tick();
    });
    // Delegated controls for the queue rows (▲ up, ▼ down, ✕ remove).
    queueListEl.addEventListener("click", (event) => {
      const btn = event.target && event.target.closest ? event.target.closest("button[data-id]") : null;
      if (!btn) return;
      const id = btn.getAttribute("data-id");
      const action = btn.getAttribute("data-action");
      if (action === "up") queueMove(id, -1);
      else if (action === "down") queueMove(id, 1);
      else if (action === "remove") queueRemove(id);
      activeTarget = null;
      tick();
    });
    policyApplyEl.addEventListener("click", () => {
      if (policySelectEl.value && buyPolicyChoice(policySelectEl.value)) tick();
    });
    policySelectEl.addEventListener("change", () => renderPolicyControl(resourceMap(), getGoal()));

    const applyMin = (min) => {
      body.style.display = min ? "none" : "grid";
      minBtn.textContent = min ? "+" : "–";
      localStorage.setItem(MIN_KEY, min ? "1" : "0");
    };
    minBtn.addEventListener("click", () => applyMin(body.style.display !== "none"));

    document.body.classList.add("kgh-helper-ready");
    document.body.appendChild(box);
    applyMin(localStorage.getItem(MIN_KEY) === "1");
    renderLog();
    tick();
    setInterval(tick, HELPER_TICK_MS);
  };

  window.__kghDebug = {
    selectStrategicTarget(goalKey = getGoal()) {
      resetTickCache();
      const resources = resourceMap();
      const decision = selectStrategicTarget(resources, goalKey);
      lastStrategicDecision = decision;
      tickCache.candidates = decision.candidates;
      return decision;
    },
    reservedNeedsFor(target) {
      return reservedNeedsFor(target, resourceMap());
    },
    planText(goalKey = getGoal()) {
      resetTickCache();
      const resources = resourceMap();
      return getPlanLine(resources, goalKey);
    },
    detailsText(goalKey = getGoal()) {
      resetTickCache();
      const resources = resourceMap();
      getTargetCached(resources, goalKey);
      return getAutomationDetailsLine(resources, goalKey);
    },
    nowText(goalKey = getGoal()) {
      resetTickCache();
      const resources = resourceMap();
      return getNowAction(resources, goalKey);
    },
    activeSprint() {
      return activeSprint;
    },
    solveChain(candidate) {
      return solveCraftChain(resourceMap(), candidate);
    },
    bestWoodJob() {
      return bestWoodJob();
    },
    queue: () => readQueue(),
    queueAdd: (id, val) => queueAdd(id, val),
    queueRemove: (id) => queueRemove(id),
    queueClear: () => writeQueue([]),
    forceActiveTarget(candidate) {
      // A debug/manual target override resets ALL locks so the planner starts
      // from a clean state (mirrors an explicit player priority change).
      activeSprint = null;
      activeScienceUnlockId = null;
      activeTarget = candidate ? {
        id: targetId(candidate),
        startedAt: Date.now() - getTargetLockMinMs() - 1000,
        initialVal: VAL_BASED_KINDS.has(candidate.kind) ? candidate.meta.val || 0 : 0,
      } : null;
    },
    targetId,
  };

  /* ------------------------------- bootstrap -------------------------------- */

  // We only need the game itself now — no third-party library to wait for. The
  // helper reads and drives window.gamePage directly, so it boots as soon as the
  // game's resource pool exists.
  const gameReady = () =>
    window.gamePage &&
    window.gamePage.resPool &&
    Array.isArray(window.gamePage.resPool.resources) &&
    window.gamePage.bld;

  const waitForGame = async () => {
    for (let i = 0; i < 240; i += 1) {
      if (gameReady()) return;
      await delay(250);
    }
    throw new Error("Kittens Game did not finish loading.");
  };

  waitForGame()
    .then(() => {
      applyProfile(); // sets opts.noConfirm before any purchase can fire a dialog
      buildPanel();
    })
    .catch((error) => console.error("[KGH] Failed to start:", error));
})();
