// ==UserScript==
// @name         Kittens Game Helper
// @namespace    https://github.com/ianhuxx/kittens-game-helper
// @version      0.10.2
// @description  Smart one-click autopilot for Kittens Game. Loads Kitten Scientists, turns on every SAFE automation, continuously rebalances kitten jobs (with wood-vs-catnip pathway math), prioritizes resource-fixing upgrades like Coal Furnace, crafts workshop prerequisites like steel→gear, sends hunters, refines surplus catnip into wood, and shows the bottleneck + next science + goal + a live action log. Prestige resets stay OFF.
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
 *   5. shows a panel: bottleneck, next science, and a live log of what it did.
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
    "promoteKittens",
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
      note: "Builds the instant things are affordable, continuously rebalances all non-engineer kitten jobs toward the best work (with wood-vs-catnip pathway math), prioritizes resource-fixing workshop upgrades like Coal Furnace, crafts prerequisites like steel→gear, sends hunters, and refines surplus catnip into wood. Prestige resets stay OFF.",
    },
    assist: {
      label: "Assist: jobs + advice",
      note: "Only job rebalancing, hunting, festivals and event-observing run. You decide what to build/research — the advisor tells you what's next.",
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

  // We manage jobs + hunting ourselves (goal-aware, with pathway math), so turn
  // OFF KS's own job/hunt automation to stop the two systems fighting. Festivals,
  // leader, and the rest of the Village section stay on.
  const disableKSJobsAndHunt = (settings) => {
    const village = settings && settings.village;
    if (!village) return;
    const jobs = village.jobs || village.job;
    if (jobs && typeof jobs === "object") {
      for (const job of Object.values(jobs)) {
        if (job && typeof job === "object") job.enabled = false;
      }
    }
    if (village.hunt && typeof village.hunt === "object") village.hunt.enabled = false;
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

    disableKSJobsAndHunt(settings);
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
        const craftHint = craftByName(cost.name) ? ` (craft ${craftLabel(cost.name)})` : "";
        missing.push(`${fmt(cost.val - have)} ${(res && res.title) || cost.name}${craftHint}`);
      }
    }
    return { affordable, progress, missing: missing.slice(0, 3).join(", ") };
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
    if (["science", "blueprint", "compendium"].includes(name)) return "science";
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
    const baseUnits = Math.max(1, Math.ceil(deficit / (1 + craftRatioFor(name))));
    for (const price of prices) {
      const neededInput = price.val * baseUnits;
      const input = getRes(resourceMap(), price.name);
      if (((input && input.value) || 0) < neededInput && !tryCraftResource(price.name, neededInput, depth + 1)) {
        return false;
      }
    }

    const fresh = resourceMap();
    for (const price of prices) {
      const input = getRes(fresh, price.name);
      const value = (input && input.value) || 0;
      if (value - price.val * baseUnits < craftReserveFor(fresh, price.name)) return false;
    }

    try {
      const workshop = window.gamePage.workshop;
      const crafted = workshop && typeof workshop.craft === "function"
        ? workshop.craft(name, baseUnits, true)
        : window.gamePage.craft(name, baseUnits);
      if (crafted !== false) {
        craftPlanText = `Craft: made ${fmt(baseUnits * (1 + craftRatioFor(name)))} ${craftLabel(name)}`;
        if (Date.now() - lastCraftLog > 15000) {
          pushLog(`🧰 ${craftPlanText}`);
          lastCraftLog = Date.now();
        }
        return true;
      }
    } catch (error) {
      /* ignore */
    }
    return false;
  };

  const craftTowardTarget = (resources, goalKey) => {
    try {
      const target = chooseWorkTarget(resources, goalKey);
      if (!target || target.affordable) {
        craftPlanText = "Craft: no intermediate needed";
        return;
      }
      for (const cost of pricesFor(target.kind, target.meta)) {
        if (!cost || !cost.name || !isFinite(cost.val) || cost.val <= 0) continue;
        const have = (getRes(resourceMap(), cost.name) || { value: 0 }).value || 0;
        if (have < cost.val && craftByName(cost.name)) {
          craftPlanText = `Craft: ${craftLabel(cost.name)} for ${labelOf(target.meta)}`;
          tryCraftResource(cost.name, cost.val);
          return;
        }
      }
      craftPlanText = "Craft: gathering raw inputs";
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

  const RES_JOB = {
    minerals: "miner",
    science: "scholar",
    catnip: "farmer",
    coal: "geologist",
    faith: "priest",
    manpower: "hunter",
    catpower: "hunter",
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

  const scoreNeed = (needs, name, weight) => {
    if (!name || !isFinite(weight) || weight <= 0) return;
    const key = name === "catpower" ? "manpower" : name;
    needs[key] = (needs[key] || 0) + weight;
  };

  const SHORTAGE_KEYWORDS = {
    coal: ["coal", "furnace", "pyrolysis", "combustion", "injector", "smelter", "calciner"],
    wood: ["wood", "lumber", "sawmill", "forestry", "beam", "scaffold"],
    minerals: ["minerals", "mine", "quarry", "iron", "smelter", "calciner"],
    catnip: ["catnip", "field", "pasture", "aqueduct", "unicorn pasture", "hydroponics"],
    science: ["science", "library", "academy", "observatory", "biolab", "data center"],
    manpower: ["manpower", "catpower", "hunter", "archery", "composite bow", "crossbow", "bolas"],
    faith: ["faith", "temple", "chapel", "solar", "religion"],
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

  const helpsShortage = (meta, resourceName) => {
    const text = effectText(meta);
    const keywords = SHORTAGE_KEYWORDS[resourceName] || [resourceName];
    return keywords.some((word) => text.includes(word));
  };

  const shortageBoost = (meta, resources) => {
    let boost = 0;
    for (const [name, keywords] of Object.entries(SHORTAGE_KEYWORDS)) {
      const ratio = resRatio(resources, name, 1);
      if (ratio > 0.35) continue;
      if (helpsShortage(meta, name)) boost += (0.35 - ratio) * (name === "coal" ? 34 : 24);
      if (name === "coal" && keywords.some((word) => metaText(meta).includes(word))) boost += (0.35 - ratio) * 18;
    }
    return boost;
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
    if (goal && goal.keywords.length && matchesKeywords(meta, goal.keywords)) boost += 10;
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
    return candidates
      .map((c) => {
        const evaluation = evaluate(c.kind, c.meta, resources);
        const score = c.weight + evaluation.progress + shortageBoost(c.meta, resources) + strategicBoost(c.kind, c.meta, resources, goal);
        return { ...c, ...evaluation, score };
      })
      .sort((a, b) => b.score - a.score);
  };

  const chooseWorkTarget = (resources, goalKey) => {
    const candidates = gatherCandidates(resources, goalKey);
    return candidates.find((c) => !c.affordable && c.missing) || candidates.find((c) => c.affordable) || null;
  };

  const resourceNeeds = (goalKey, resources) => {
    const needs = {};
    const target = chooseWorkTarget(resources, goalKey);
    if (target && !target.affordable) {
      for (const cost of pricesFor(target.kind, target.meta)) {
        if (!cost || !cost.name || !isFinite(cost.val) || cost.val <= 0) continue;
        const res = getRes(resources, cost.name);
        const have = (res && res.value) || 0;
        if (have < cost.val) scoreResourcePathNeed(needs, cost.name, 8 * (1 - Math.min(0.98, have / cost.val)) + 2);
      }
    }

    // Safety and anti-waste: do not keep producing capped spendables; push low raw
    // resources and food instead. This is what moves scholars away when science is full.
    if (resRatio(resources, "catnip") < 0.25) scoreNeed(needs, "catnip", 14);
    if (resRatio(resources, "wood") < 0.3) scoreNeed(needs, "wood", 7 * (0.3 - resRatio(resources, "wood")) / 0.3);
    if (resRatio(resources, "minerals") < 0.3) scoreNeed(needs, "minerals", 6 * (0.3 - resRatio(resources, "minerals")) / 0.3);
    if (goalKey === "space" && resRatio(resources, "science") < 0.92) scoreNeed(needs, "science", 3);
    if (goalKey === "production") scoreNeed(needs, resRatio(resources, "minerals") <= resRatio(resources, "wood") ? "minerals" : "wood", 3);
    if (goalKey === "population") scoreNeed(needs, "catnip", 3);

    for (const name of ["science", "faith", "culture", "manpower"]) {
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

  // Decide which single job should receive a free/extra kitten as a fallback.
  const chooseJob = (goalKey, resources) => {
    const { needs } = resourceNeeds(goalKey, resources);
    const best = Object.entries(needs).sort((a, b) => b[1] - a[1])[0];
    const target = best && best[1] > 0 ? best[0] : "wood";
    if (target === "wood") return bestWoodJob() || jobByName("woodcutter");
    return jobByName(RES_JOB[target]) || jobByName("woodcutter") || jobByName("farmer");
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
      if (job.name === "hunter" && resRatio(resources, "manpower") > 0.94) weight = 0;
      if (job.name === "geologist" && resRatio(resources, "coal") > 0.96) weight = 0;
      weights[job.name] = Math.max(0, weight);
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
      const huntCost = 100 - (typeof window.gamePage.getEffect === "function" ? window.gamePage.getEffect("huntCatpowerDiscount") : 0);
      if (cp.value >= Math.max(huntCost, cp.maxValue * 0.75)) {
        village.huntAll();
        if (Date.now() - lastHuntLog > 30000) {
          pushLog("🏹 sent hunters");
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
      const target = chooseWorkTarget(resources, goalKey);
      if (!target) return "🧭 Plan: scanning unlocked buildings/research";
      const reqs = formatRequirements(target.kind, target.meta, resources);
      const state = target.affordable ? "ready now" : `missing ${target.missing || "prerequisites"}`;
      return `🧭 Plan: ${target.kind} ${labelOf(target.meta)} — ${state}${reqs ? ` (${reqs})` : ""}`;
    } catch (error) {
      return "🧭 Plan: —";
    }
  };

  const getNowAction = (resources, goalKey) => {
    const ready = gatherCandidates(resources, goalKey).find((c) => c.affordable);
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
      const resources = resourceMap();
      const goal = getGoal();
      refineSurplusCatnip();
      craftTowardTarget(resources, goal);
      balanceJobs(goal, resources);
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
    setInterval(tick, 4000);
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
