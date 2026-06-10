// ==UserScript==
// @name         Kittens Game Helper
// @namespace    https://github.com/ianhuxx/kittens-game-helper
// @version      0.11.0
// @description  Smart one-click autopilot for Kittens Game. Loads Kitten Scientists, turns on every SAFE automation, plans around storage caps (builds barns/libraries when a target exceeds a cap), converts about-to-overflow resources into beams/slabs/plates/steel/compendia, continuously rebalances kitten jobs (with wood-vs-catnip pathway math and a winter starvation guard), crafts workshop prerequisites like steel→gear with partial fills, elects + promotes the best leader, keeps cats happy via luxuries and festivals, sends hunters, and shows the bottleneck + next science + goal + a live action log. Prestige resets stay OFF.
// @author       ianhuxx
// @match        https://kittensgame.com/web/*
// @match        https://kittensgame.com/beta/*
// @match        https://kittensgame.com/alpha/*
// @match        https://*.kittensgame.com/*
// @match        http://bloodrizer.ru/games/kittens/*
// @require      https://github.com/kitten-science/kitten-scientists/releases/download/v2.0.0-beta.11/kitten-scientists-2.0.0-beta.11.user.js
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/*
 * Kittens Game Helper — smart autopilot on top of Kitten Scientists (KS).
 * On every page load it:
 *   1. waits for the game (window.gamePage) and KS (window.kittenScientists),
 *   2. enables every SAFE automation by walking the live KS settings tree,
 *   3. sets build/research triggers to "buy as soon as affordable" and tells KS
 *      to refine surplus catnip into wood (the usual early-game bottleneck),
 *   4. forces irreversible / permanent / resource-burning automations OFF,
 *   5. takes over jobs, hunting, crafting, overflow control, leader election
 *      and festivals with target-aware logic,
 *   6. shows a panel: bottleneck, next science, mood/leader, and a live log.
 */

(function kittensGameHelper() {
  "use strict";

  const STORAGE_KEY = "kgh.profile";
  const LOG_KEY = "kgh.log";
  const DEFAULT_PROFILE = "autopilot";
  const KS_FALLBACK_LOADER = "https://kitten-science.com/stable.js";

  // Irreversible / permanent / resource-burning / log-hiding automations.
  // Matched by key name anywhere in the KS settings tree and forced OFF.
  const DENY_SUBSTRINGS = ["reset", "transcend", "sacrifice", "shatter", "timeskip"];
  const DENY_EXACT = new Set([
    "adore",
    "upgradeBuildings",
    "promoteKittens", // KS's version stays off — we promote ourselves, gated on overflowing gold
    "policies", // permanent, often exclusive choices — left to the player
    "filters", // KS log filters — keep off so the activity log stays visible
  ]);

  // Build/research/buy sections gated by a storage-percent "trigger". Setting
  // these to 0 means "buy as soon as it's affordable". "workshop" is excluded so
  // crafting doesn't convert every raw resource and starve building/research.
  const PURCHASE_SECTIONS = ["bonfire", "science", "religion", "space", "time", "trade"];

  const PROFILE_INFO = {
    autopilot: {
      label: "Autopilot: play forward",
      note: "Builds the instant things are affordable, plans storage when a target exceeds a resource cap, converts about-to-overflow resources into crafted goods, continuously rebalances all non-engineer kitten jobs (with wood-vs-catnip pathway math and a starvation guard), crafts prerequisites like steel→gear, elects and promotes the best leader, keeps cats happy via hunts and festivals. Prestige resets stay OFF.",
    },
    assist: {
      label: "Assist: jobs + advice",
      note: "Job rebalancing, luxury-aware hunting, overflow-protective crafting, leader care, festivals and event-observing run. You decide what to build/research — the advisor tells you what's next.",
    },
  };

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const getProfileName = () => {
    const stored = localStorage.getItem(STORAGE_KEY);
    return PROFILE_INFO[stored] ? stored : DEFAULT_PROFILE;
  };

  // Goals steer the advisor toward a target you pick (autopilot still grows the
  // whole economy so you never stall). Each goal has a named milestone "target"
  // plus keywords used to prioritize matching research/buildings.
  const GOAL_KEY = "kgh.goal";
  const DEFAULT_GOAL = "balanced";
  const GOALS = {
    balanced: { label: "Balanced", target: null, keywords: [] },
    space: {
      label: "Rush Space",
      target: "rocketry",
      keywords: ["space", "rocket", "satellite", "orbital", "moon", "oil"],
    },
    production: {
      label: "Max production",
      target: "factory",
      keywords: ["mine", "lumber", "steam", "magneto", "factory", "accelerator", "calciner", "smelt", "reactor", "quarry", "mint"],
    },
    population: {
      label: "Max population",
      target: "mansion",
      keywords: ["hut", "house", "mansion", "aqueduct", "pasture", "amphitheat", "brewery"],
    },
  };

  const getGoal = () => {
    const stored = localStorage.getItem(GOAL_KEY);
    return GOALS[stored] ? stored : DEFAULT_GOAL;
  };

  const metaText = (meta) => `${meta.name || ""} ${meta.label || ""} ${meta.title || ""}`.toLowerCase();
  const matchesKeywords = (meta, keywords) => {
    const text = metaText(meta);
    return keywords.some((k) => text.includes(k));
  };

  /* --------------------------- settings management --------------------------- */

  const isDeniedKey = (key) => {
    if (!key) return false;
    if (DENY_EXACT.has(key)) return true;
    const lower = String(key).toLowerCase();
    return DENY_SUBSTRINGS.some((needle) => lower.includes(needle));
  };

  const setEnabledDeep = (node, value, key) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) setEnabledDeep(child, value);
      return;
    }
    if (isDeniedKey(key)) {
      if ("enabled" in node) node.enabled = false;
      return;
    }
    if ("enabled" in node) node.enabled = value;
    for (const [childKey, childVal] of Object.entries(node)) {
      if (childKey === "enabled") continue;
      if (childVal && typeof childVal === "object") setEnabledDeep(childVal, value, childKey);
    }
  };

  const setTriggersDeep = (node, value) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) setTriggersDeep(child, value);
      return;
    }
    if (typeof node.trigger === "number") node.trigger = value;
    for (const child of Object.values(node)) {
      if (child && typeof child === "object") setTriggersDeep(child, value);
    }
  };

  // A build limit ("max") of 0 means "never build this". Raise those so every
  // unlocked structure keeps getting built.
  const raiseZeroMaxes = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) raiseZeroMaxes(child);
      return;
    }
    if (typeof node.max === "number" && node.max === 0) node.max = 1e9;
    for (const child of Object.values(node)) {
      if (child && typeof child === "object") raiseZeroMaxes(child);
    }
  };

  // We manage jobs, hunting, leader election and promotions ourselves
  // (goal-aware, with pathway math and gold-overflow gating), so turn OFF KS's
  // own versions to stop the two systems fighting. Festivals and the rest of
  // the Village section stay on.
  const disableKSManagedAutomations = (settings) => {
    const village = settings && settings.village;
    if (!village) return;
    const jobs = village.jobs || village.job;
    if (jobs && typeof jobs === "object") {
      for (const job of Object.values(jobs)) {
        if (job && typeof job === "object") job.enabled = false;
      }
    }
    for (const key of ["hunt", "electLeader", "promoteLeader"]) {
      if (village[key] && typeof village[key] === "object") village[key].enabled = false;
    }
  };

  // Tell KS to refine surplus catnip into wood. Catnip is the one resource that
  // overflows early, while wood/minerals starve — this breaks that deadlock.
  const enableCatnipRefining = (settings) => {
    const crafts = settings.workshop && (settings.workshop.crafts || settings.workshop.resources);
    if (crafts && crafts.wood && typeof crafts.wood === "object") {
      crafts.wood.enabled = true;
      crafts.wood.trigger = 0.5; // refine only when catnip is over half-full
    }
  };

  const buildSettings = (profileName) => {
    const settings = window.kittenScientists.getSettings();

    if (profileName === "assist") {
      setEnabledDeep(settings, false);
      if (settings.engine) {
        settings.engine.enabled = true;
        settings.engine.interval = 1500;
      }
      if (settings.village) setEnabledDeep(settings.village, true, "village");
      if (settings.science) {
        settings.science.enabled = true;
        if (settings.science.observe) setEnabledDeep(settings.science.observe, true, "observe");
      }
    } else {
      setEnabledDeep(settings, true);
      if (settings.engine) {
        settings.engine.enabled = true;
        settings.engine.interval = 1000;
        if (settings.engine.resources) settings.engine.resources.enabled = false;
      }
      for (const section of PURCHASE_SECTIONS) {
        if (settings[section]) setTriggersDeep(settings[section], 0);
      }
      for (const section of ["bonfire", "space", "time"]) {
        if (settings[section]) raiseZeroMaxes(settings[section]);
      }
      enableCatnipRefining(settings);
    }

    disableKSManagedAutomations(settings);
    return settings;
  };

  const ensureEngineRunning = () => {
    try {
      const engine = window.kittenScientists && window.kittenScientists.engine;
      if (engine && engine._timeoutMainLoop == null && typeof engine.start === "function") {
        engine.start(false);
      }
    } catch (error) {
      /* the enabled flag will start it on the next KS tick */
    }
  };

  const applyProfile = (profileName) => {
    const name = PROFILE_INFO[profileName] ? profileName : DEFAULT_PROFILE;
    window.kittenScientists.setSettings(buildSettings(name));
    localStorage.setItem(STORAGE_KEY, name);
    ensureEngineRunning();
    pushLog(`▶ ${PROFILE_INFO[name].label} applied`);
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

  const resourceMap = () => {
    const map = new Map();
    try {
      for (const res of window.gamePage.resPool.resources) {
        map.set(res.name, res);
        if (res.name === "manpower") map.set("catpower", res);
      }
    } catch (error) {
      /* ignore */
    }
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

  const pricesFor = (kind, meta) => {
    try {
      if (kind === "build" && window.gamePage.bld.getPrices) {
        return window.gamePage.bld.getPrices(meta.name) || meta.prices || [];
      }
    } catch (error) {
      /* ignore */
    }
    return meta.prices || meta.price || [];
  };

  const isOpen = (meta) => meta && meta.unlocked !== false && meta.researched !== true;
  const labelOf = (meta) => meta.label || meta.title || meta.name || "?";

  // Evaluate a candidate's costs. capBlocked lists costs that exceed a resource
  // CAP — those can never be afforded by waiting, only by building storage; each
  // entry carries how close the cap is (cap/cost) so urgency can be scaled.
  const evaluate = (kind, meta, resources) => {
    const costs = pricesFor(kind, meta).filter(
      (cost) => cost && cost.name && isFinite(cost.val) && cost.val > 0,
    );
    if (!costs.length) return { affordable: false, progress: 0, missing: "", capBlocked: [] };
    let affordable = true;
    let progress = 1;
    const missing = [];
    const capBlocked = [];
    for (const cost of costs) {
      const res = getRes(resources, cost.name);
      const have = (res && res.value) || 0;
      const possible = have + craftablePotential(cost.name);
      progress = Math.min(progress, possible / cost.val);
      if (res && res.maxValue > 0 && cost.val > res.maxValue) {
        affordable = false;
        capBlocked.push({ name: cost.name, ratio: res.maxValue / cost.val });
        missing.push(`${(res && res.title) || cost.name} cap ${fmt(res.maxValue)} < ${fmt(cost.val)} — storage first`);
        continue;
      }
      if (have < cost.val) {
        affordable = false;
        const craftHint = craftByName(cost.name) ? ` (craft ${craftLabel(cost.name)})` : "";
        missing.push(`${fmt(cost.val - have)} ${(res && res.title) || cost.name}${craftHint}`);
      }
    }
    return { affordable, progress, missing: missing.slice(0, 3).join(", "), capBlocked };
  };

  /* ------------------------------ per-tick cache ----------------------------- */

  // Candidate gathering walks every building/tech/upgrade and stringifies their
  // effects, and chooseWorkTarget manages the target lock. Compute both once per
  // tick and share the result with jobs, crafting, overflow control and every
  // panel line so they all agree on the same plan.
  let tickCache = { candidates: null, target: undefined, capNeeds: null };
  let effectTextCache = new WeakMap();

  const resetTickCache = () => {
    tickCache = { candidates: null, target: undefined, capNeeds: null };
    effectTextCache = new WeakMap();
  };

  const getCandidatesCached = (resources, goalKey) => {
    if (!tickCache.candidates) tickCache.candidates = gatherCandidates(resources, goalKey);
    return tickCache.candidates;
  };

  const getTargetCached = (resources, goalKey) => {
    if (tickCache.target === undefined) tickCache.target = chooseWorkTarget(resources, goalKey);
    return tickCache.target;
  };

  /* ------------------------- economy balancing action ------------------------ */

  // Backup to the KS craft setting above: directly refine the catnip surplus
  // into wood when catnip is piling up and wood is low, keeping a food reserve.
  const refineSurplusCatnip = () => {
    try {
      const game = window.gamePage;
      if (typeof game.craft !== "function") return;
      const res = resourceMap();
      const catnip = res.get("catnip");
      const wood = res.get("wood");
      if (!catnip || !wood || !catnip.maxValue) return;
      const catnipRatio = catnip.value / catnip.maxValue;
      const woodRatio = wood.maxValue ? wood.value / wood.maxValue : 0;
      if (catnipRatio < 0.6 || woodRatio > 0.4) return; // catnip piling AND wood low
      const spendable = catnip.value - catnip.maxValue * 0.5; // keep half for food
      if (spendable <= 0) return;
      let costPer = 100;
      try {
        const craft = game.workshop.getCraft && game.workshop.getCraft("wood");
        const price = craft && craft.prices && craft.prices.find((p) => p.name === "catnip");
        if (price && price.val > 0) costPer = price.val;
      } catch (error) {
        /* use default ratio */
      }
      const woodToMake = Math.floor(spendable / costPer);
      if (woodToMake >= 1) game.craft("wood", woodToMake);
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

  const rawWorkNeedName = (name) => {
    if (["wood", "beam", "scaffold", "ship"].includes(name)) return "wood";
    if (["minerals", "iron", "titanium", "uranium"].includes(name)) return "minerals";
    if (["coal", "gold"].includes(name)) return "coal";
    if (["furs", "ivory", "unicorns"].includes(name)) return "manpower";
    if (["science", "blueprint", "compedium", "compendium"].includes(name)) return "science";
    if (name === "faith") return "faith";
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

  // Craft toward `targetAmount` of a resource, recursively crafting missing
  // inputs first. Partial fills are fine: if inputs only cover a third of the
  // deficit, craft that third now instead of stalling until everything fits.
  const tryCraftResource = (name, targetAmount, depth = 0) => {
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
        tryCraftResource(price.name, neededInput, depth + 1); // best effort, then clamp below
      }
    }

    const fresh = resourceMap();
    let units = wantUnits;
    for (const price of prices) {
      const input = getRes(fresh, price.name);
      const available = Math.max(0, ((input && input.value) || 0) - craftingFloorFor(fresh, price.name));
      units = Math.min(units, Math.floor(available / price.val));
    }
    if (units <= 0) return false;

    if (craftUnits(name, units)) {
      craftPlanText = `Craft: made ${fmt(units * (1 + craftRatioFor(name)))} ${craftLabel(name)}`;
      if (Date.now() - lastCraftLog > 15000) {
        pushLog(`🧰 ${craftPlanText}`);
        lastCraftLog = Date.now();
      }
      return units >= wantUnits;
    }
    return false;
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
          tryCraftResource(cost.name, cost.val); // may overwrite plan text with "made N …"
        }
      }
      if (!planned) craftPlanText = "Craft: gathering raw inputs";
    } catch (error) {
      /* ignore */
    }
  };

  /* ------------------------- overflow protection ----------------------------- */

  // When a capped resource is about to overflow, its production is pure waste.
  // Convert the excess into durable crafted goods (which have no cap and feed
  // future builds) instead of letting it evaporate. Reserves protect what the
  // active target needs; compendia/manuscripts even RAISE the science/culture
  // caps, turning waste into permanent storage.
  const OVERFLOW_CONVERSIONS = [
    { from: "wood", to: "beam" },
    { from: "minerals", to: "slab" },
    { from: "iron", to: "plate" },
    { from: "coal", to: "steel" },
    { from: "titanium", to: "alloy" },
    { from: "oil", to: "kerosene" },
    { from: "uranium", to: "thorium" },
    { from: "unobtainium", to: "eludium" },
    { from: "culture", to: "manuscript" },
    { from: "science", to: "compedium" }, // the game really spells it "compedium"
    { from: "furs", to: "parchment" },
  ];
  const OVERFLOW_TRIGGER = 0.93; // start converting at 93% of cap
  const OVERFLOW_FLOOR = 0.85; // convert down to 85%, keep the rest liquid
  let lastOverflowLog = 0;

  // Total amount of `name` the active target still charges — kept liquid so
  // overflow conversion never eats what the plan is saving up for.
  const targetCostFor = (resources, goalKey, name) => {
    const target = getTargetCached(resources, goalKey);
    if (!target || !target.meta) return 0;
    let total = 0;
    for (const cost of pricesFor(target.kind, target.meta)) {
      if (cost && cost.name === name && isFinite(cost.val) && cost.val > 0) total += cost.val;
    }
    return total;
  };

  // Festivals are a recurring spend on culture/parchment/catpower — once drama
  // is researched, keep their price out of crafting so a festival is always
  // affordable the moment one can start. Skipped while the resource's cap is
  // too small to ever hold the price (early game — festivals can't happen yet).
  const festivalReserveFor = (resources, name) => {
    try {
      const drama = window.gamePage.science && window.gamePage.science.get && window.gamePage.science.get("drama");
      if (!drama || !drama.researched) return 0;
      const price = FESTIVAL_PRICES.find((p) => p.name === name || (name === "catpower" && p.name === "manpower"));
      if (!price) return 0;
      const res = getRes(resources, name);
      if (res && res.maxValue > 0 && res.maxValue < price.val * 1.1) return 0;
      return price.val * 1.1;
    } catch (error) {
      return 0;
    }
  };

  // Liquid floor EVERY crafting path must respect: food/catpower reserves, the
  // festival budget, and a luxury cushion — furs/ivory/spice above zero are a
  // happiness bonus, so crafting must never wipe them out.
  const craftingFloorFor = (resources, name) => {
    let floor = Math.max(craftReserveFor(resources, name), festivalReserveFor(resources, name));
    if (LUXURY_RESOURCES.includes(name)) floor = Math.max(floor, luxuryStockTarget(resources, name) * 3);
    return floor;
  };

  const overflowReserve = (resources, goalKey, name) => {
    let reserve = craftingFloorFor(resources, name);
    const res = getRes(resources, name);
    const targetCost = targetCostFor(resources, goalKey, name);
    // Hold what the active target needs — unless that exceeds the cap, where
    // hoarding can never reach it anyway (and converting may raise the cap).
    if (!(res && res.maxValue > 0 && targetCost > res.maxValue)) reserve += targetCost * 1.05;
    return reserve;
  };

  const preventResourceOverruns = (resources, goalKey) => {
    for (const conversion of OVERFLOW_CONVERSIONS) {
      try {
        const res = getRes(resources, conversion.from);
        if (!res || res.unlocked === false) continue;
        const craft = craftByName(conversion.to);
        if (!craft) continue;
        const prices = craftPricesFor(craft).filter((p) => p && p.name && p.val > 0);
        const fromPrice = prices.find((p) => p.name === conversion.from);
        if (!fromPrice) continue;

        const reserve = overflowReserve(resources, goalKey, conversion.from);
        let spendable;
        if (res.maxValue > 0) {
          if (res.value < res.maxValue * OVERFLOW_TRIGGER) continue;
          spendable = res.value - Math.max(res.maxValue * OVERFLOW_FLOOR, reserve);
        } else {
          // Uncapped sources (furs): only skim well above the luxury reserve.
          spendable = res.value - Math.max(reserve * 2, 400);
        }
        if (spendable < fromPrice.val) continue;

        let units = Math.floor(spendable / fromPrice.val);
        for (const price of prices) {
          if (price === fromPrice) continue;
          const input = getRes(resources, price.name);
          const inputValue = (input && input.value) || 0;
          let keep = overflowReserve(resources, goalKey, price.name);
          // Secondary inputs aren't overflowing — don't starve them: capped ones
          // stay above 40% of cap, crafted stockpiles lose at most half a pass.
          if (input && input.maxValue > 0) keep = Math.max(keep, input.maxValue * 0.4);
          else keep = Math.max(keep, inputValue * 0.5);
          units = Math.min(units, Math.floor(Math.max(0, inputValue - keep) / price.val));
        }
        if (units < 1) continue;

        if (craftUnits(conversion.to, units) && Date.now() - lastOverflowLog > 20000) {
          pushLog(`♻ ${fmt(units * (1 + craftRatioFor(conversion.to)))} ${craftLabel(conversion.to)} (${conversion.from} was capping)`);
          lastOverflowLog = Date.now();
        }
      } catch (error) {
        /* try the next conversion */
      }
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
      const price = craft && craft.prices && craft.prices.find((p) => p.name === "catnip");
      if (price && price.val > 0) return price.val;
    } catch (error) {
      /* default */
    }
    return 100;
  };

  // Pathway math: to get more WOOD, is it better to add a Woodcutter (direct) or
  // a Farmer (catnip, which we refine into wood)? Compare wood-per-kitten of each.
  const bestWoodJob = () => {
    try {
      const prod = window.gamePage.village.getResProduction ? window.gamePage.village.getResProduction() : {};
      const cutter = jobByName("woodcutter");
      const farmer = jobByName("farmer");
      if (!cutter) return farmer;
      if (!farmer) return cutter;
      const woodPerCutter = cutter.value > 0 && prod.wood ? prod.wood / cutter.value : null;
      const catnipPerFarmer = farmer.value > 0 && prod.catnip ? prod.catnip / farmer.value : null;
      if (woodPerCutter == null || catnipPerFarmer == null) return cutter; // not enough data → direct
      const woodViaRefine = catnipPerFarmer / woodCatnipCost();
      return woodViaRefine > woodPerCutter ? farmer : cutter;
    } catch (error) {
      return jobByName("woodcutter");
    }
  };

  const MANAGED_JOBS = ["woodcutter", "farmer", "miner", "scholar", "hunter", "priest", "geologist"];
  const JOB_RESOURCE = {
    woodcutter: "wood",
    farmer: "catnip",
    miner: "minerals",
    scholar: "science",
    hunter: "manpower",
    priest: "faith",
    geologist: "coal",
  };
  const LUXURY_RESOURCES = ["furs", "ivory", "spice"];
  const JOB_REBALANCE_MIN_MS = 3500;
  let lastJobRun = 0;
  let lastJobLog = 0;
  let lastJobSignature = "";
  let jobPlanText = "Jobs: waiting…";

  const getRes = (resources, name) => resources.get(name) || (name === "catpower" ? resources.get("manpower") : null);

  const resRatio = (resources, name, fallback = 1) => {
    const r = getRes(resources, name);
    return r && r.maxValue > 0 ? r.value / r.maxValue : fallback;
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

  const SHORTAGE_KEYWORDS = {
    coal: ["coal", "furnace", "steel", "pyrolysis", "combustion", "injector", "smelter", "calciner"],
    wood: ["wood", "lumber", "sawmill", "forestry", "beam", "scaffold"],
    minerals: ["minerals", "mine", "quarry", "iron", "smelter", "calciner"],
    catnip: ["catnip", "field", "pasture", "aqueduct", "unicorn pasture", "hydroponics"],
    science: ["science", "library", "academy", "observatory", "biolab", "data center"],
    manpower: ["manpower", "catpower", "hunter", "archery", "composite bow", "crossbow", "bolas"],
    faith: ["faith", "temple", "chapel", "solar", "religion"],
  };

  const effectText = (meta) => {
    const cached = meta && typeof meta === "object" ? effectTextCache.get(meta) : null;
    if (cached != null) return cached;
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
    const text = parts.join(" ").toLowerCase();
    if (meta && typeof meta === "object") {
      try {
        effectTextCache.set(meta, text);
      } catch (error) {
        /* non-cacheable meta */
      }
    }
    return text;
  };

  // Merged effects object for a meta: top-level effects plus the active stage's
  // effects (staged buildings like Library → Data Center swap their effects).
  const effectsOf = (meta) => {
    const out = {};
    if (meta && meta.effects && typeof meta.effects === "object") Object.assign(out, meta.effects);
    try {
      const stage = meta && Array.isArray(meta.stages) && meta.stages[meta.stage || 0];
      if (stage && stage.effects && typeof stage.effects === "object") Object.assign(out, stage.effects);
    } catch (error) {
      /* ignore */
    }
    return out;
  };

  const effectName = (name) => (name === "catpower" ? "manpower" : name);

  // Does this candidate's effect table actually produce/boost `resourceName`?
  // Matches real game effect keys: catnipPerTickBase, mineralsRatio,
  // coalRatioGlobal, catnipDemandRatio (demand reduction helps too), etc.
  const producesResource = (meta, resourceName) => {
    const eff = effectsOf(meta);
    const wanted = effectName(resourceName).toLowerCase();
    for (const key of Object.keys(eff)) {
      if (!isFinite(eff[key]) || eff[key] === 0) continue;
      const lower = key.toLowerCase();
      if (!lower.startsWith(wanted)) continue;
      const tail = lower.slice(wanted.length);
      if (
        tail.startsWith("pertick") ||
        tail.startsWith("ratio") ||
        tail.startsWith("global") ||
        tail.startsWith("autoprod") ||
        tail.startsWith("demandratio")
      ) {
        return true;
      }
    }
    return false;
  };

  // Which resources each storage-ratio upgrade key expands (workshop upgrades
  // like "Expanded Barns" carry barnRatio etc. instead of direct ...Max keys).
  const STORAGE_RATIO_KEYS = {
    barnratio: ["catnip", "wood", "minerals", "iron"],
    warehouseratio: ["wood", "minerals", "iron", "coal", "titanium"],
    harborratio: ["catnip", "wood", "minerals", "coal", "iron", "titanium", "gold"],
    acceleratorratio: ["catnip", "wood", "minerals", "iron", "coal", "gold", "titanium", "oil", "uranium"],
  };

  const raisesCapFor = (meta, resourceName) => {
    const eff = effectsOf(meta);
    const wanted = effectName(resourceName).toLowerCase();
    for (const key of Object.keys(eff)) {
      if (!isFinite(eff[key]) || eff[key] === 0) continue;
      const lower = key.toLowerCase();
      if (lower.startsWith(`${wanted}max`)) return true;
      const expanded = STORAGE_RATIO_KEYS[lower];
      if (expanded && expanded.includes(wanted)) return true;
    }
    return false;
  };

  const helpsShortage = (meta, resourceName) => {
    const text = effectText(meta);
    const keywords = SHORTAGE_KEYWORDS[resourceName] || [resourceName];
    return keywords.some((word) => text.includes(word));
  };

  const productionFor = (name) => {
    try {
      const prod = window.gamePage.village.getResProduction ? window.gamePage.village.getResProduction() : {};
      const value = prod[name === "catpower" ? "manpower" : name];
      return isFinite(value) ? value : 0;
    } catch (error) {
      return 0;
    }
  };

  // Net per-tick rate including consumption — the game's own number, so it sees
  // buildings, kitten demand, seasons and weather, not just village jobs.
  const perTickRate = (name) => {
    try {
      const value = window.gamePage.getResourcePerTick(effectName(name), true);
      return isFinite(value) ? value : 0;
    } catch (error) {
      return 0;
    }
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
    const baseUnits = Math.max(1, Math.ceil(amount / Math.max(1, 1 + craftRatioFor(name))));
    for (const price of prices) rawPathRequirements(price.name, price.val * baseUnits, out, depth + 1);
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

  const shortageBoost = (meta, resources) => {
    let boost = 0;
    for (const [name, keywords] of Object.entries(SHORTAGE_KEYWORDS)) {
      const ratio = resRatio(resources, name, 1);
      const stockBoost = Math.max(0, 0.45 - ratio);
      const prod = productionFor(name);
      const prodBoost = prod <= 0 && ratio < 0.8 ? 0.25 : 0;
      if (stockBoost <= 0 && prodBoost <= 0) continue;
      // Real effect keys beat name keywords — check those first and strongest.
      if (producesResource(meta, name)) boost += (stockBoost + prodBoost) * 34;
      if (helpsShortage(meta, name)) boost += (stockBoost + prodBoost) * (name === "coal" ? 42 : 26);
      if (name === "coal" && keywords.some((word) => metaText(meta).includes(word))) boost += (stockBoost + prodBoost) * 22;
    }
    const iron = getRes(resources, "iron");
    const coal = getRes(resources, "coal");
    if (iron && coal && iron.unlocked !== false && coal.unlocked !== false && helpsShortage(meta, "coal")) {
      const ironRatio = resRatio(resources, "iron", 0);
      const coalRatio = resRatio(resources, "coal", 0);
      boost += Math.max(0, ironRatio - coalRatio) * 30;
    }
    return boost;
  };

  // How many things (techs, buildings, upgrades, jobs…) does this meta unlock?
  // Unlock-rich steps open whole branches and deserve priority.
  const unlockCount = (meta) => {
    const unlocks = meta && meta.unlocks;
    if (!unlocks || typeof unlocks !== "object") return 0;
    let count = 0;
    for (const value of Object.values(unlocks)) {
      if (Array.isArray(value)) count += value.length;
    }
    return count;
  };

  // Small bonus for targets we could afford SOON at current net rates: a build
  // 30 seconds away beats an equally-scored one 2 hours away.
  const timeToAffordBonus = (kind, meta, resources) => {
    let worstTicks = 0;
    for (const cost of pricesFor(kind, meta)) {
      if (!cost || !cost.name || !isFinite(cost.val) || cost.val <= 0) continue;
      const res = getRes(resources, cost.name);
      const have = (res && res.value) || 0;
      if (have >= cost.val) continue;
      const rate = perTickRate(cost.name);
      if (rate <= 0) return 0; // not currently producible — no bonus
      worstTicks = Math.max(worstTicks, (cost.val - have) / rate);
    }
    if (worstTicks <= 0) return 0;
    const minutes = worstTicks / 300; // game runs ~5 ticks/sec
    return Math.max(0, 4 - Math.log10(1 + minutes) * 3);
  };

  const strategicBoost = (kind, meta, resources, goal) => {
    const text = effectText(meta);
    let boost = 0;
    if (/automation|factory|engineer|steam|magneto|reactor|accelerator|calciner/.test(text)) boost += 8;
    if (/storage|barn|warehouse|harbor|container|tank|library|academy/.test(text)) {
      const capped = ["wood", "minerals", "iron", "coal", "science", "culture", "faith", "manpower"].some(
        (name) => resRatio(resources, name, 0) > 0.9,
      );
      boost += capped ? 7 : 2;
    }
    if (/hut|house|mansion|population|kitten/.test(text)) boost += 4;
    if (kind === "upgrade" && /furnace|coal|pyrolysis|combustion|smelter/.test(text)) boost += 5;
    boost += Math.min(6, unlockCount(meta) * 1.2);
    // Unhappy village? Amphitheatres, broadcast towers, sun altars and other
    // happiness effects recover the global production multiplier.
    const moodGap = Math.max(0, 1 - currentHappinessRatio());
    if (moodGap > 0.01 && ("happiness" in effectsOf(meta) || /happiness|amphitheatre|broadcast|sun altar/.test(text))) {
      boost += Math.min(9, 3 + moodGap * 20);
    }
    if (goal && goal.keywords.length && matchesKeywords(meta, goal.keywords)) boost += 10;
    return boost;
  };

  // Boost candidates that raise the caps blocking promising targets. Urgency is
  // appeal × closeness, so a target at 80% of the needed cap pushes storage hard
  // while a far-future tech barely registers.
  const capReliefBoost = (meta, capNeeds) => {
    let boost = 0;
    for (const [name, urgency] of Object.entries(capNeeds || {})) {
      if (urgency > 0 && raisesCapFor(meta, name)) boost += Math.min(24, urgency * 4);
    }
    return boost;
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
      for (const b of buildingMetas()) {
        if (b && b.unlocked !== false) candidates.push({ kind: "build", weight: 2, meta: b });
      }
    } catch (error) {
      /* ignore */
    }

    const evaluated = candidates.map((c) => ({ ...c, ...evaluate(c.kind, c.meta, resources) }));

    // Storage planning: when a promising candidate can never be afforded because
    // a cost exceeds a resource cap, raise demand for whatever lifts that cap.
    const capNeeds = {};
    for (const c of evaluated) {
      if (!c.capBlocked.length) continue;
      const appeal =
        c.weight + c.progress + (goal && goal.keywords.length && matchesKeywords(c.meta, goal.keywords) ? 2 : 0);
      for (const blocked of c.capBlocked) {
        const urgency = appeal * Math.min(1, Math.max(0, blocked.ratio));
        capNeeds[blocked.name] = Math.max(capNeeds[blocked.name] || 0, urgency);
      }
    }
    tickCache.capNeeds = capNeeds;

    return evaluated
      .map((c) => {
        const blockedPenalty = c.capBlocked.length ? 8 + 2 * c.capBlocked.length : 0;
        const score =
          c.weight +
          c.progress +
          shortageBoost(c.meta, resources) +
          strategicBoost(c.kind, c.meta, resources, goal) +
          capReliefBoost(c.meta, capNeeds) +
          timeToAffordBonus(c.kind, c.meta, resources) -
          blockedPenalty;
        return { ...c, score };
      })
      .sort((a, b) => b.score - a.score);
  };

  const TARGET_LOCK_MIN_MS = 120000;
  const TARGET_LOCK_MAX_MS = 360000;
  const TARGET_READY_GRACE_MS = 20000;
  let activeTarget = null;

  const targetId = (candidate) => candidate && candidate.meta ? `${candidate.kind}:${candidate.meta.name || labelOf(candidate.meta)}` : "";

  const findCandidateById = (candidates, id) => candidates.find((candidate) => targetId(candidate) === id) || null;

  const targetComplete = (candidate) => {
    if (!candidate || !candidate.meta) return true;
    if (candidate.kind === "research" || candidate.kind === "upgrade") return !!candidate.meta.researched;
    if (candidate.kind === "build" && activeTarget && activeTarget.id === targetId(candidate)) {
      return (candidate.meta.val || 0) > (activeTarget.initialVal || 0) && Date.now() - activeTarget.startedAt > TARGET_READY_GRACE_MS;
    }
    return false;
  };

  const chooseWorkTarget = (resources, goalKey) => {
    const candidates = getCandidatesCached(resources, goalKey);
    // Prefer reachable plans: cap-blocked candidates need storage first, so they
    // only become the target when nothing reachable exists.
    const preferred =
      candidates.find((c) => !c.affordable && c.missing && !c.capBlocked.length) ||
      candidates.find((c) => !c.affordable && c.missing) ||
      candidates.find((c) => c.affordable) ||
      null;
    const now = Date.now();

    if (activeTarget) {
      const locked = findCandidateById(candidates, activeTarget.id);
      const age = now - activeTarget.startedAt;
      if (!locked || targetComplete(locked) || age > TARGET_LOCK_MAX_MS || (locked.affordable && age > TARGET_READY_GRACE_MS)) {
        activeTarget = null;
      } else if (age < TARGET_LOCK_MIN_MS || !preferred || locked.score >= preferred.score * 0.7) {
        return locked;
      } else {
        activeTarget = null;
      }
    }

    if (preferred) {
      activeTarget = {
        id: targetId(preferred),
        startedAt: now,
        initialVal: preferred.kind === "build" ? preferred.meta.val || 0 : 0,
      };
    }
    return preferred;
  };

  const resourceNeeds = (goalKey, resources) => {
    const needs = {};
    const target = getTargetCached(resources, goalKey);
    if (target && !target.affordable) {
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

    // Storage pressure: when the plan is blocked by a cap, the jobs that build
    // storage materials (wood/minerals for barns and warehouses) matter most.
    const capNeeds = tickCache.capNeeds || {};
    if (Object.keys(capNeeds).length) {
      scoreNeed(needs, "wood", 2);
      scoreNeed(needs, "minerals", 2);
    }

    // Safety and anti-waste: do not keep producing capped spendables; push low raw
    // resources and food instead. This is what moves scholars away when science is full.
    if (resRatio(resources, "catnip") < 0.25) scoreNeed(needs, "catnip", 14);
    if (resRatio(resources, "wood") < 0.3) scoreNeed(needs, "wood", 7 * (0.3 - resRatio(resources, "wood")) / 0.3);
    if (resRatio(resources, "minerals") < 0.3) scoreNeed(needs, "minerals", 6 * (0.3 - resRatio(resources, "minerals")) / 0.3);
    if (goalKey === "space" && resRatio(resources, "science") < 0.92) scoreNeed(needs, "science", 3);
    scoreNeed(needs, "manpower", huntingEconomyNeed(resources));
    if (goalKey === "production") scoreNeed(needs, resRatio(resources, "minerals") <= resRatio(resources, "wood") ? "minerals" : "wood", 3);
    if (goalKey === "population") scoreNeed(needs, "catnip", 3);

    for (const name of ["science", "faith", "culture", "manpower"]) {
      if (name === "manpower" && huntingEconomyNeed(resources) > 0.5) continue;
      if (resRatio(resources, name) > 0.94) needs[name] = 0;
    }
    for (const name of ["wood", "minerals", "catnip", "coal"]) {
      if (resRatio(resources, name) > 0.96) needs[name] = Math.min(needs[name] || 0, 0.25);
    }

    if (!Object.values(needs).some((v) => v > 0)) {
      scoreNeed(needs, "wood", resRatio(resources, "wood") < 0.95 ? 2 : 0);
      scoreNeed(needs, "minerals", resRatio(resources, "minerals") < 0.95 ? 2 : 0);
      scoreNeed(needs, "science", resRatio(resources, "science") < 0.9 ? 1 : 0);
    }
    return { needs, target };
  };

  const managedJobs = () => MANAGED_JOBS.map(jobByName).filter(Boolean);

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

    for (const job of jobs) {
      const res = JOB_RESOURCE[job.name];
      let weight = needs[res] || 0;
      if (job.name === "woodcutter" && needs.wood > 0) weight = Math.max(weight, needs.wood);
      if (job.name === "farmer" && needs.wood > 0 && bestWoodJob() && bestWoodJob().name === "farmer") {
        weight = Math.max(weight, needs.wood + 1);
      }
      if (job.name === "woodcutter" && bestWoodJob() && bestWoodJob().name === "farmer") {
        weight = Math.min(weight, 0.25);
      }
      if (job.name === "scholar" && resRatio(resources, "science") > 0.94) weight = 0;
      if (job.name === "priest" && resRatio(resources, "faith") > 0.94) weight = 0;
      if (job.name === "hunter" && resRatio(resources, "manpower") > 0.94 && huntingEconomyNeed(resources) <= 0.5) weight = 0;
      if (job.name === "geologist" && resRatio(resources, "coal") > 0.96) weight = 0;
      weights[job.name] = Math.max(0, weight);
    }

    // Starvation guard: if catnip is NET NEGATIVE (winter, big population) and
    // the pantry is draining, force farmers before kittens start dying.
    const netCatnip = perTickRate("catnip");
    if (jobByName("farmer") && netCatnip < 0 && resRatio(resources, "catnip") < 0.6) {
      weights.farmer = Math.max(weights.farmer || 0, 10 + Math.min(25, -netCatnip * 2));
    }
    if (resRatio(resources, "catnip") < 0.2 && jobByName("farmer")) weights.farmer = Math.max(weights.farmer || 0, 20);
    if (!Object.values(weights).some((w) => w > 0)) {
      const fallback = bestWoodJob() || jobByName("woodcutter") || jobByName("farmer") || jobs[0];
      if (fallback) weights[fallback.name] = 1;
    }

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

    const needLine = Object.entries(needs)
      .filter(([, w]) => w > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([name]) => resTitle(resources, name))
      .join(" + ");
    jobPlanText = `Jobs: ${needLine || "balanced"}${target ? ` for ${labelOf(target.meta)}` : ""}`;
    return desired;
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
      try {
        if (typeof village.updateResourceProduction === "function") village.updateResourceProduction();
        if (window.gamePage.villageTab && typeof window.gamePage.villageTab.updateTab === "function") window.gamePage.villageTab.updateTab();
        if (typeof window.gamePage.updateResources === "function") window.gamePage.updateResources();
      } catch (error) {
        /* ignore UI refresh failures */
      }
      lastJobSignature = signature;
      if (moved > 0 && now - lastJobLog > 15000) {
        const summary = jobs
          .filter((j) => desired[j.name] > 0)
          .sort((a, b) => desired[b.name] - desired[a.name])
          .slice(0, 3)
          .map((j) => `${j.title || j.name} ${desired[j.name]}`)
          .join(", ");
        pushLog(`👷 rebalanced: ${summary}`);
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
      const economyNeed = huntingEconomyNeed(resources);
      let threshold = economyNeed > 0.5 ? Math.max(huntCost, cp.maxValue * 0.25) : Math.max(huntCost, cp.maxValue * 0.75);
      // huntAll drains ALL catpower — if a festival is one catpower-fill away
      // (other costs ready, no festival running), hold hunts until it fires.
      // Skipped while luxuries are short: refilling furs comes first.
      if (economyNeed <= 0.5) {
        const reserve = festivalCatpowerReserve(resources);
        if (reserve > 0) threshold = Math.max(threshold, reserve + huntCost);
      }
      if (cp.value >= threshold) {
        village.huntAll();
        if (Date.now() - lastHuntLog > 30000) {
          const reason = economyNeed > 0.5 ? " for luxuries/mood" : "";
          pushLog(`🏹 sent hunters${reason}`);
          lastHuntLog = Date.now();
        }
      }
    } catch (error) {
      /* ignore */
    }
  };

  /* --------------------- leader, promotions & festivals ---------------------- */

  // Leader trait bonuses (from the game's getEffectLeader): engineer +5% craft,
  // metallurgist +10% metal crafts, chemist +7.5% chemical crafts, merchant +3%
  // trade, manager +50% hunting, scientist −5% science prices, wise −10%
  // faith/gold prices on religion. Scientist compounds while research is the
  // main spend; engineer takes over once steel-era crafting dominates.
  const TRAIT_BASE_SCORE = { scientist: 6, engineer: 6, merchant: 4, manager: 4, metallurgist: 4, chemist: 3, wise: 3, none: 0 };

  const buildingCount = (name) => {
    try {
      const meta = buildingMetas().find((b) => b && b.name === name);
      return (meta && meta.val) || 0;
    } catch (error) {
      return 0;
    }
  };

  const researchedTechCount = () => {
    try {
      return (window.gamePage.science.techs || []).filter((t) => t && t.researched).length;
    } catch (error) {
      return 0;
    }
  };

  const traitScore = (traitName, resources) => {
    let score = TRAIT_BASE_SCORE[traitName] != null ? TRAIT_BASE_SCORE[traitName] : 2;
    if (traitName === "scientist") score += researchedTechCount() < 45 ? 4 : 1;
    if (traitName === "engineer") score += craftByName("steel") ? 5 : 0;
    if (traitName === "metallurgist") score += buildingCount("smelter") >= 4 ? 4 : 0;
    if (traitName === "chemist") score += craftByName("kerosene") || craftByName("concrate") ? 4 : 0;
    if (traitName === "merchant") score += buildingCount("tradepost") >= 1 ? 3 : 0;
    if (traitName === "manager") score += huntingEconomyNeed(resources) > 0.5 ? 3 : 0;
    if (traitName === "wise") score += buildingCount("temple") >= 1 ? 2 : 0;
    return score;
  };

  const kittenTraitName = (kitten) => (kitten && kitten.trait && kitten.trait.name) || "none";

  let lastLeaderCheck = 0;
  let nextPromoteAttempt = 0;

  // Elect the best-trait kitten as leader (with hysteresis so we don't churn),
  // and spend NEAR-CAP gold on promotions — gold sitting at the cap is wasted,
  // promotions turn it into permanent production.
  const manageLeader = (resources) => {
    try {
      const game = window.gamePage;
      const village = game.village;
      const sim = village && village.sim;
      if (!village || !sim || !Array.isArray(sim.kittens) || sim.kittens.length === 0) return;
      try {
        if (game.challenges && typeof game.challenges.isActive === "function" && game.challenges.isActive("anarchy")) return;
      } catch (error) {
        /* no challenges API — proceed */
      }

      const now = Date.now();
      if (now - lastLeaderCheck >= 45000 && typeof village.makeLeader === "function") {
        lastLeaderCheck = now;
        let best = null;
        let bestScore = -1;
        for (const kitten of sim.kittens) {
          const trait = kittenTraitName(kitten);
          if (trait === "none") continue;
          const score = traitScore(trait, resources) + Math.min(3, (kitten.rank || 0) * 0.5);
          if (score > bestScore) {
            bestScore = score;
            best = kitten;
          }
        }
        const leader = village.leader;
        const leaderScore = leader
          ? traitScore(kittenTraitName(leader), resources) + Math.min(3, (leader.rank || 0) * 0.5)
          : -1;
        if (best && (!leader || bestScore > leaderScore + 1.5)) {
          village.makeLeader(best);
          const traitTitle = (best.trait && (best.trait.title || best.trait.name)) || "?";
          pushLog(`👑 elected ${best.name || "kitten"} (${traitTitle})`);
        }
      }

      const gold = getRes(resources, "gold");
      if (gold && gold.maxValue > 0 && gold.value >= gold.maxValue * 0.92 && now >= nextPromoteAttempt) {
        const before = gold.value;
        try {
          if (typeof village.promoteKittens === "function") {
            village.promoteKittens();
          } else if (village.leader && typeof sim.promote === "function") {
            sim.promote(village.leader, (village.leader.rank || 0) + 1);
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
      }
    } catch (error) {
      /* ignore */
    }
  };

  // Festival backup behind KS's own automation. village.holdFestival() does NOT
  // charge resources, so pay the real button price first — never start one we
  // didn't pay for.
  const FESTIVAL_PRICES = [
    { name: "manpower", val: 1500 },
    { name: "culture", val: 5000 },
    { name: "parchment", val: 2500 },
  ];
  let lastFestivalTry = 0;

  // Catpower worth holding back from hunts because a festival could start as
  // soon as it accumulates (no festival running, drama researched, the other
  // costs already covered, and the cap can actually hold the price).
  const festivalCatpowerReserve = (resources) => {
    try {
      const game = window.gamePage;
      if ((game.calendar.festivalDays || 0) > 0) return 0;
      const drama = game.science && game.science.get && game.science.get("drama");
      if (!drama || !drama.researched) return 0;
      const manpowerPrice = FESTIVAL_PRICES.find((p) => p.name === "manpower");
      const cp = getRes(resources, "manpower");
      if (!manpowerPrice || !cp || !(cp.maxValue > manpowerPrice.val * 1.15)) return 0;
      for (const price of FESTIVAL_PRICES) {
        if (price.name === "manpower") continue;
        const res = getRes(resources, price.name);
        if (!res || (res.value || 0) < price.val * 1.1) return 0;
      }
      return manpowerPrice.val * 1.1;
    } catch (error) {
      return 0;
    }
  };

  const maybeHoldFestival = (resources) => {
    try {
      const game = window.gamePage;
      const village = game.village;
      const calendar = game.calendar;
      if (!village || !calendar || typeof village.holdFestival !== "function") return;
      if ((calendar.festivalDays || 0) > 0) return; // already celebrating
      const drama = game.science && game.science.get && game.science.get("drama");
      if (!drama || !drama.researched) return;
      const now = Date.now();
      if (now - lastFestivalTry < 30000) return;
      for (const price of FESTIVAL_PRICES) {
        const res = getRes(resources, price.name);
        if (!res || (res.value || 0) < price.val * 1.1) return; // afford with headroom
      }
      if (!game.resPool || typeof game.resPool.payPrices !== "function") return;
      lastFestivalTry = now;
      game.resPool.payPrices(FESTIVAL_PRICES);
      village.holdFestival(1);
      pushLog("🎪 festival started (+happiness)");
    } catch (error) {
      /* ignore */
    }
  };

  const villageStatusLine = () => {
    try {
      const village = window.gamePage.village;
      const mood = Math.round(currentHappinessRatio() * 100);
      const leader = village && village.leader;
      const leaderText = leader
        ? `${(leader.trait && (leader.trait.title || leader.trait.name)) || "?"}${leader.rank ? ` r${leader.rank}` : ""}`
        : "none yet";
      const festival = (() => {
        try {
          return (window.gamePage.calendar.festivalDays || 0) > 0 ? " · 🎪 festival" : "";
        } catch (error) {
          return "";
        }
      })();
      return `😊 Mood ${mood}% · 👑 Leader: ${leaderText}${festival}`;
    } catch (error) {
      return "";
    }
  };

  /* ------------------------------ the advisor ------------------------------- */

  const SPENDABLE = ["science", "culture", "faith", "manpower"];
  const RAW = ["wood", "minerals", "iron", "coal"];

  const getBottleneck = (resources) => {
    // Cap-blocked plans come first: they name the storage that unblocks progress.
    const capNeeds = tickCache.capNeeds || {};
    const blocked = Object.entries(capNeeds).sort((a, b) => b[1] - a[1])[0];
    if (blocked && blocked[1] >= 2) {
      const res = getRes(resources, blocked[0]);
      if (res && res.maxValue > 0) {
        return `${res.title || blocked[0]} cap ${fmt(res.maxValue)} blocks the plan — building storage`;
      }
    }
    for (const name of SPENDABLE) {
      const r = resources.get(name);
      if (r && r.maxValue > 0 && r.value >= r.maxValue * 0.99) {
        const fix = name === "manpower" ? "send hunters" : "build more storage / spend it";
        return `${r.title || name} is capped — ${fix}`;
      }
    }
    for (const name of RAW) {
      const r = resources.get(name);
      if (r && r.maxValue > 0 && r.value < r.maxValue * 0.05) {
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
      let scored = techs.map((t) => ({ t, ...evaluate("research", t, resources) }));
      const goal = GOALS[goalKey];
      if (goal && goal.keywords.length) {
        const matches = scored.filter((s) => matchesKeywords(s.t, goal.keywords));
        if (matches.length) scored = matches; // prefer goal-relevant research
      }
      const ready = scored.find((s) => s.affordable);
      if (ready) return `${labelOf(ready.t)} (ready now)`;
      const near = scored.filter((s) => s.progress > 0).sort((a, b) => b.progress - a.progress)[0];
      return near ? `${labelOf(near.t)} — need ${near.missing}` : "gathering prerequisites";
    } catch (error) {
      return "—";
    }
  };

  // One line summarising progress toward the chosen goal's milestone.
  const getGoalLine = (resources, goalKey) => {
    const goal = GOALS[goalKey];
    if (!goal || !goal.target) return "";
    try {
      for (const t of window.gamePage.science.techs || []) {
        if (metaText(t).includes(goal.target)) {
          if (t.researched) return `🏁 ${goal.label}: ${labelOf(t)} researched ✓`;
          if (t.unlocked === false) return `🏁 ${goal.label}: ${labelOf(t)} locked — researching toward it`;
          const e = evaluate("research", t, resources);
          return `🏁 ${goal.label}: ${labelOf(t)} — ${e.affordable ? "ready!" : "need " + e.missing}`;
        }
      }
      for (const b of buildingMetas()) {
        if (metaText(b).includes(goal.target)) {
          if (b.unlocked === false) return `🏁 ${goal.label}: ${labelOf(b)} locked`;
          const e = evaluate("build", b, resources);
          return `🏁 ${goal.label}: ${labelOf(b)} ×${b.val || 0} — ${e.affordable ? "can build now" : "need " + e.missing}`;
        }
      }
      return `🏁 ${goal.label}: target not unlocked yet`;
    } catch (error) {
      return `🏁 ${goal.label}`;
    }
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

  const getPlanLine = (resources, goalKey) => {
    try {
      const target = getTargetCached(resources, goalKey);
      if (!target) return "🧭 Plan: scanning unlocked buildings/research";
      const reqs = formatRequirements(target.kind, target.meta, resources);
      const state = target.affordable ? "ready now" : `missing ${target.missing || "prerequisites"}`;
      return `🧭 Plan: ${target.kind} ${labelOf(target.meta)} — ${state}${reqs ? ` (${reqs})` : ""}`;
    } catch (error) {
      return "🧭 Plan: —";
    }
  };

  const getNowAction = (resources, goalKey) => {
    const ready = getCandidatesCached(resources, goalKey).find((c) => c.affordable);
    return ready ? `${ready.kind} ${labelOf(ready.meta)}` : "gathering…";
  };

  /* ------------------------------ action log -------------------------------- */

  let actionLog = [];
  try {
    actionLog = JSON.parse(localStorage.getItem(LOG_KEY)) || [];
  } catch (error) {
    actionLog = [];
  }

  const prev = { build: {}, tech: {}, upgrade: {} };
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
      seeded = true;
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
  let villageEl;
  let nowEl;

  const engineRunning = () => {
    try {
      return window.kittenScientists.engine._timeoutMainLoop != null;
    } catch (error) {
      return false;
    }
  };

  const tick = () => {
    try {
      resetTickCache();
      const resources = resourceMap();
      const goal = getGoal();
      refineSurplusCatnip();
      preventResourceOverruns(resources, goal);
      craftTowardTarget(resources, goal);
      balanceJobs(goal, resources);
      manageLeader(resources);
      maybeHoldFestival(resources); // festivals claim catpower before hunts do
      autoHunt(resources);
      trackActions();
      if (statusEl) statusEl.textContent = `KS engine: ${engineRunning() ? "running ✓" : "stopped ✗ — click Apply"}`;
      if (goalEl) {
        const line = getGoalLine(resources, goal);
        goalEl.textContent = line;
        goalEl.style.display = line ? "" : "none";
      }
      if (bottleneckEl) bottleneckEl.textContent = `⚖ ${getBottleneck(resources)}`;
      if (scienceEl) scienceEl.textContent = `🔬 Next science: ${getNextScience(resources, goal)}`;
      if (planEl) planEl.textContent = getPlanLine(resources, goal);
      if (jobsEl) jobsEl.textContent = `👷 ${jobPlanText}`;
      if (villageEl) villageEl.textContent = villageStatusLine();
      if (nowEl) nowEl.textContent = `🎯 Now: ${getNowAction(resources, goal)}`;
    } catch (error) {
      /* ignore */
    }
  };

  /* ------------------------------- the panel -------------------------------- */

  const KS_HIDE_KEY = "kgh.hideKS";
  const MIN_KEY = "kgh.min";

  // Hide/show the Kitten Scientists panel (its UI root is .kitten-scientists,
  // inside #ksColumn). Automation keeps running either way.
  const applyKSHidden = (hidden, btn) => {
    document.body.classList.toggle("kgh-hide-ks", hidden);
    localStorage.setItem(KS_HIDE_KEY, hidden ? "1" : "0");
    if (btn) {
      btn.textContent = hidden ? "Show KS" : "Hide KS";
      btn.title = hidden ? "Show the Kitten Scientists settings panel" : "Hide the Kitten Scientists settings panel";
    }
  };

  const buildPanel = () => {
    const style = document.createElement("style");
    style.id = "kgh-style";
    style.textContent =
      "body.kgh-hide-ks #ksColumn,body.kgh-hide-ks .kitten-scientists{display:none!important}" +
      ".kgh-hbtn{cursor:pointer;background:transparent;color:#f7ead0;border:1px solid #9b7a4d;" +
      "border-radius:3px;font-size:11px;padding:1px 6px;margin-left:4px}";
    document.head.appendChild(style);

    const box = document.createElement("div");
    box.style.cssText =
      "position:fixed;right:12px;bottom:12px;z-index:99999;width:300px;padding:9px 10px;" +
      "background:#2b2118;color:#f7ead0;border:1px solid #9b7a4d;border-radius:5px;" +
      "font:12px/1.4 sans-serif;display:grid;gap:5px;box-shadow:0 2px 10px #0009";
    box.innerHTML = [
      '<div style="display:flex;justify-content:space-between;align-items:center">',
      '<strong style="font-size:13px">🐱 Kittens Helper</strong>',
      '<span style="white-space:nowrap"><button type="button" class="kgh-hbtn kgh-ks">Show KS</button>',
      '<button type="button" class="kgh-hbtn kgh-min" title="Minimize">–</button></span></div>',
      '<div class="kgh-body" style="display:grid;gap:5px">',
      '<div style="display:flex;gap:6px"><select style="flex:1" aria-label="profile">',
      '<option value="autopilot">Autopilot: play forward</option>',
      '<option value="assist">Assist: jobs + advice</option>',
      "</select><button type=\"button\" class=\"kgh-apply\" style=\"cursor:pointer\">Apply</button></div>",
      '<select class="kgh-goal" aria-label="goal" style="width:100%">',
      '<option value="balanced">🏁 Goal: Balanced</option>',
      '<option value="space">🏁 Goal: Rush Space</option>',
      '<option value="production">🏁 Goal: Max production</option>',
      '<option value="population">🏁 Goal: Max population</option>',
      "</select>",
      '<small class="kgh-status" style="color:#9fd0ff">…</small>',
      '<small class="kgh-note" style="opacity:.8"></small>',
      '<small class="kgh-goal-line" style="color:#d8b6ff"></small>',
      '<small class="kgh-bottleneck" style="color:#f0b8a0">…</small>',
      '<small class="kgh-science" style="color:#bfe6a0">…</small>',
      '<small class="kgh-plan" style="color:#a7e8e0">…</small>',
      '<small class="kgh-jobs" style="color:#f3c37b">…</small>',
      '<small class="kgh-village" style="color:#ffd9e8">…</small>',
      '<small class="kgh-now" style="color:#e6d79a">…</small>',
      '<div style="opacity:.8;border-top:1px solid #9b7a4d50;padding-top:3px">Recent actions:</div>',
      '<pre class="kgh-log" style="margin:0;max-height:92px;overflow:auto;white-space:pre-wrap;' +
        'font:11px/1.35 monospace;color:#d9ccae;background:#0003;padding:4px;border-radius:3px">…</pre>',
      '<small style="opacity:.65">Resets stay OFF. Back up your save (Options → Export) first.</small>',
      "</div>",
    ].join("");

    const select = box.querySelector("select");
    const goalSelect = box.querySelector(".kgh-goal");
    const button = box.querySelector(".kgh-apply");
    const note = box.querySelector(".kgh-note");
    const ksBtn = box.querySelector(".kgh-ks");
    const minBtn = box.querySelector(".kgh-min");
    const body = box.querySelector(".kgh-body");
    statusEl = box.querySelector(".kgh-status");
    goalEl = box.querySelector(".kgh-goal-line");
    bottleneckEl = box.querySelector(".kgh-bottleneck");
    scienceEl = box.querySelector(".kgh-science");
    planEl = box.querySelector(".kgh-plan");
    jobsEl = box.querySelector(".kgh-jobs");
    villageEl = box.querySelector(".kgh-village");
    nowEl = box.querySelector(".kgh-now");
    logBox = box.querySelector(".kgh-log");

    select.value = getProfileName();
    select.addEventListener("change", () => {
      note.textContent = PROFILE_INFO[select.value].note;
    });
    goalSelect.value = getGoal();
    goalSelect.addEventListener("change", () => {
      localStorage.setItem(GOAL_KEY, goalSelect.value);
      tick();
    });
    button.addEventListener("click", () => applyProfile(select.value));

    ksBtn.addEventListener("click", () => {
      applyKSHidden(!document.body.classList.contains("kgh-hide-ks"), ksBtn);
    });
    const applyMin = (min) => {
      body.style.display = min ? "none" : "grid";
      minBtn.textContent = min ? "+" : "–";
      localStorage.setItem(MIN_KEY, min ? "1" : "0");
    };
    minBtn.addEventListener("click", () => applyMin(body.style.display !== "none"));

    document.body.appendChild(box);
    note.textContent = PROFILE_INFO[select.value].note;
    applyKSHidden(localStorage.getItem(KS_HIDE_KEY) !== "0", ksBtn); // default hidden = minimal
    applyMin(localStorage.getItem(MIN_KEY) === "1");
    renderLog();
    tick();
    setInterval(tick, 3000);
  };

  /* ------------------------------- bootstrap -------------------------------- */

  const ksReady = () =>
    window.kittenScientists &&
    typeof window.kittenScientists.getSettings === "function" &&
    typeof window.kittenScientists.setSettings === "function" &&
    window.gamePage &&
    window.gamePage.resPool;

  const injectFallbackLoader = () => {
    try {
      const script = document.createElement("script");
      script.src = KS_FALLBACK_LOADER;
      document.body.appendChild(script);
    } catch (error) {
      /* ignore */
    }
  };

  const waitForKittenScientists = async () => {
    let injectedFallback = false;
    for (let i = 0; i < 200; i += 1) {
      if (ksReady()) return;
      if (i === 40 && !injectedFallback) {
        injectedFallback = true;
        injectFallbackLoader();
      }
      await delay(250);
    }
    throw new Error("Kitten Scientists did not finish loading.");
  };

  waitForKittenScientists()
    .then(() => {
      applyProfile(getProfileName());
      buildPanel();
    })
    .catch((error) => console.error("[KGH] Failed to start:", error));
})();
