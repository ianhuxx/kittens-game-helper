// ==UserScript==
// @name         Kittens Game Helper
// @namespace    https://github.com/ianhuxx/kittens-game-helper
// @version      0.13.0
// @description  Smart one-click autopilot for Kittens Game. Loads Kitten Scientists for crafting/trade/religion/festivals, but owns building/research/upgrade purchases itself: it picks a plan, RESERVES the resources the plan needs so cheaper buys can't eat them, buys the plan the moment it's affordable, and spends only true surplus on everything else. One universal decision framework — every candidate is scored by what its parsed game-metadata effects are worth to the CURRENT economy (production vs scarcity, storage vs live pressure, unlocks, goal alignment) minus how long it takes to afford; no per-item keyword lists. Goals are tech-tree milestones with live n/m progress or effect-category emphases. Recursive prerequisite planning, lookahead-aware job rebalancing (wood-vs-catnip pathway math + starvation guard), prerequisite crafting, overflow conversion, smelter/calciner pausing, leader election, gold-overflow promotions, hunting. Prestige resets stay OFF.
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

  // KS sections we still let buy things, gated by a storage-percent "trigger".
  // Setting these to 0 means "buy as soon as it's affordable". Bonfire, science
  // and workshop upgrades are NOT here: the helper buys those itself so the plan
  // can reserve resources — KS would otherwise spend the savings on cheap items.
  // Religion is tuned separately: "Praise the Sun" converts banked faith, so it
  // should wait for near-cap faith instead of firing as soon as any faith exists.
  const PURCHASE_SECTIONS = ["space", "time", "trade"];

  const PROFILE_INFO = {
    autopilot: {
      label: "Autopilot: play forward",
      note: "Safe autopilot is on: the plan reserves what it needs and buys itself; jobs, crafting, hunting, leader and storage fixes run too. Resets stay OFF.",
    },
    assist: {
      label: "Assist: jobs + advice",
      note: "Light mode: jobs, hunting, festivals, event watching, and advice only. You choose builds and research.",
    },
  };

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const getProfileName = () => {
    const stored = localStorage.getItem(STORAGE_KEY);
    return PROFILE_INFO[stored] ? stored : DEFAULT_PROFILE;
  };

  // Goals steer the advisor toward a destination you pick (autopilot still
  // grows the whole economy so you never stall). A goal is one of two shapes,
  // and NEITHER uses keyword lists — relevance is computed from game data:
  //  - a MILESTONE goal names a target tech; the planner walks the live tech
  //    tree, pushes every prerequisite, and reports progress as "n/m techs";
  //  - an EMPHASIS goal multiplies effect categories (production, housing,
  //    happiness, …) that are matched against each candidate's parsed effects.
  const GOAL_KEY = "kgh.goal";
  const DEFAULT_GOAL = "balanced";
  const GOALS = {
    balanced: {
      label: "Balanced — steady all-round growth",
      target: null,
      emphasis: {},
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

  const getGoal = () => {
    const stored = localStorage.getItem(GOAL_KEY);
    return GOALS[stored] ? stored : DEFAULT_GOAL;
  };

  const metaText = (meta) => `${meta.name || ""} ${meta.label || ""} ${meta.title || ""}`.toLowerCase();

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
  const disableKSJobsAndHunt = (settings) => {
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

  const RELIGION_GENERAL_TRIGGER = 0.5;
  const RELIGION_UPGRADE_TRIGGER = 0.25;
  const RELIGION_PRAISE_TRIGGER = 0.95;

  const religionNodeType = (key) => {
    const lower = String(key || "").toLowerCase();
    if (lower.includes("praise") || lower === "faith" || lower.includes("faith")) return "praise";
    if (lower.includes("upgrade") || lower.includes("build") || lower.includes("solar") || lower.includes("apocrypha")) {
      return "upgrade";
    }
    return "general";
  };

  const tuneReligionNode = (node, key) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) tuneReligionNode(child, key);
      return;
    }
    if (isDeniedKey(key)) {
      if ("enabled" in node) node.enabled = false;
      return;
    }
    if ("enabled" in node) node.enabled = true;
    if (typeof node.trigger === "number") {
      const type = religionNodeType(key);
      node.trigger = type === "praise"
        ? RELIGION_PRAISE_TRIGGER
        : type === "upgrade"
          ? RELIGION_UPGRADE_TRIGGER
          : RELIGION_GENERAL_TRIGGER;
    }
    for (const [childKey, childVal] of Object.entries(node)) {
      if (childKey === "enabled" || childKey === "trigger") continue;
      if (childVal && typeof childVal === "object") tuneReligionNode(childVal, childKey);
    }
  };

  // Religion needs different pacing than trade/space/time.  Most religion
  // upgrades are progress, but "Praise the Sun" converts the faith bank into
  // worship; doing that at trigger 0 starves near-term upgrade choices.  Keep
  // upgrade buyers willing to act, force irreversible actions off via the deny
  // list, and only praise when faith is close to storage cap.
  const configureReligionProgression = (settings) => {
    if (!settings || !settings.religion) return;
    tuneReligionNode(settings.religion, "religion");
  };

  // The helper owns ALL building/research/workshop-upgrade purchasing so the
  // active plan can reserve resources. KS keeps crafting, trade, religion,
  // space, time and village automations — but its competing buyers go dark.
  const takeOverPurchasing = (settings) => {
    if (settings.bonfire) setEnabledDeep(settings.bonfire, false, "bonfire");
    const science = settings.science;
    if (science) {
      science.enabled = true; // the section stays on for observe (star events)
      for (const key of ["techs", "tech", "technologies"]) {
        if (science[key] && typeof science[key] === "object") setEnabledDeep(science[key], false, key);
      }
      if (science.observe) setEnabledDeep(science.observe, true, "observe");
    }
    const workshop = settings.workshop;
    if (workshop) {
      workshop.enabled = true; // crafts stay on
      for (const key of ["upgrades", "upgrade", "research", "technologies"]) {
        if (workshop[key] && typeof workshop[key] === "object") setEnabledDeep(workshop[key], false, key);
      }
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
      for (const section of ["space", "time"]) {
        if (settings[section]) raiseZeroMaxes(settings[section]);
      }
      configureReligionProgression(settings);
      takeOverPurchasing(settings);
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
        const storageHint = res && res.maxValue > 0 && cost.val > res.maxValue && !craftByName(cost.name)
          ? ` (storage cap ${fmt(res.maxValue)})`
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

  const setReligionPraiseState = (settings, enabled, trigger = RELIGION_PRAISE_TRIGGER) => {
    const visit = (node, key) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) {
        for (const child of node) visit(child, key);
        return;
      }
      if (religionNodeType(key) === "praise") {
        if ("enabled" in node) node.enabled = enabled;
        if (typeof node.trigger === "number") node.trigger = trigger;
        return;
      }
      for (const [childKey, childVal] of Object.entries(node)) {
        if (childVal && typeof childVal === "object") visit(childVal, childKey);
      }
    };
    if (settings && settings.religion) visit(settings.religion, "religion");
  };

  let religionPlanText = "Religion: watching faith";

  const reserveFaithForReligionProgression = (resources) => {
    try {
      const settings = window.kittenScientists && window.kittenScientists.getSettings && window.kittenScientists.getSettings();
      if (!settings || !settings.religion) return;
      configureReligionProgression(settings);
      const next = nextFaithReligionUpgrade(resources);
      if (next) {
        setReligionPraiseState(settings, false);
        religionPlanText = next.affordable
          ? `Religion: ${labelOf(next.meta)} ready; holding praise until it is bought`
          : `Religion: saving faith for ${labelOf(next.meta)} (${next.missing || "faith needed"})`;
      } else {
        setReligionPraiseState(settings, true, RELIGION_PRAISE_TRIGGER);
        religionPlanText = "Religion: praise waits near cap; no faith upgrade pending";
      }
      if (window.kittenScientists.setSettings) window.kittenScientists.setSettings(settings);
    } catch (error) {
      /* ignore religion pacing failures */
    }
  };

  /* ------------------------------ per-tick cache ----------------------------- */

  // Candidate gathering, target choice and storage-pressure scans are expensive
  // (storage pressure alone walks every meta) and were being recomputed by every
  // consumer each tick — sometimes disagreeing mid-tick. Compute once, share.
  let tickCache = { candidates: null, target: undefined, pressure: null, goalFrontier: null, goalClosure: null, goalSupport: null };

  const resetTickCache = () => {
    tickCache = { candidates: null, target: undefined, pressure: null, goalFrontier: null, goalClosure: null, goalSupport: null };
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
    if (["science", "blueprint", "compendium", "compedium"].includes(name)) return "science";
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

  // Liquid floor crafting must respect: food/catpower reserves plus a luxury
  // cushion — furs/ivory/spice above zero are a happiness bonus, so crafting
  // (e.g. furs→parchment for a manuscript chain) must never wipe them out.
  const craftFloorFor = (resources, name) => {
    let floor = craftReserveFor(resources, name);
    if (LUXURY_RESOURCES.includes(name)) floor = Math.max(floor, luxuryStockTarget(resources, name) * 3);
    return floor;
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
        tryCraftResource(price.name, neededInput, depth + 1); // best effort, clamp below
      }
    }

    const fresh = resourceMap();
    let units = wantUnits;
    for (const price of prices) {
      const input = getRes(fresh, price.name);
      const available = Math.max(0, ((input && input.value) || 0) - craftFloorFor(fresh, price.name));
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


  const OVERFLOW_CRAFTS = ["beam", "slab", "plate", "steel", "gear", "concrate", "alloy", "eludium", "scaffold", "ship", "parchment", "manuscript", "compedium", "blueprint"];
  let overflowPlanText = "Overflow: watching storage";
  let lastOverflowLog = 0;

  const wouldWasteResource = (resources, name) => {
    const res = getRes(resources, name);
    if (!res || !res.maxValue || res.unlocked === false) return false;
    const ratio = res.value / res.maxValue;
    const net = typeof res.perTickCached === "number" ? res.perTickCached : productionFor(name);
    return ratio > 0.93 || (ratio > 0.86 && net > 0);
  };

  const targetNeedsResource = (target, name) => {
    if (!target) return false;
    return pricesFor(target.kind, target.meta).some((cost) => cost && cost.name === name && cost.val > ((getRes(resourceMap(), name) || { value: 0 }).value || 0));
  };

  const craftOverflowResources = (resources, goalKey) => {
    try {
      const target = getTargetCached(resources, goalKey);
      const scored = [];
      for (const name of OVERFLOW_CRAFTS) {
        const craft = craftByName(name);
        if (!craft) continue;
        const prices = craftPricesFor(craft).filter((p) => p && p.name && p.val > 0);
        if (!prices.length) continue;
        const output = getRes(resources, name);
        if (output && output.maxValue && output.value / output.maxValue > 0.92 && !targetNeedsResource(target, name)) continue;
        const hotInputs = prices.filter((price) => wouldWasteResource(resources, price.name));
        if (!hotInputs.length && !targetNeedsResource(target, name)) continue;
        let maxUnits = Number.MAX_VALUE;
        for (const price of prices) {
          const input = getRes(resources, price.name);
          const value = (input && input.value) || 0;
          const reserve = craftReserveFor(resources, price.name);
          maxUnits = Math.min(maxUnits, Math.floor(Math.max(0, value - reserve) / price.val));
        }
        if (!isFinite(maxUnits) || maxUnits < 1) continue;
        const targetBoost = targetNeedsResource(target, name) ? 100 : 0;
        const heat = hotInputs.reduce((sum, price) => sum + Math.max(0, resRatio(resources, price.name, 0) - 0.86), 0);
        scored.push({ name, maxUnits, score: targetBoost + heat });
      }
      const best = scored.sort((a, b) => b.score - a.score)[0];
      if (!best) {
        overflowPlanText = "Overflow: watching storage";
        return;
      }
      const units = Math.max(1, Math.min(best.maxUnits, best.score >= 100 ? Math.ceil(best.maxUnits * 0.5) : Math.ceil(best.maxUnits * 0.2)));
      if (craftUnits(best.name, units)) {
        overflowPlanText = `Overflow: converted surplus into ${craftLabel(best.name)}`;
        if (Date.now() - lastOverflowLog > 20000) {
          pushLog(`📦 ${overflowPlanText}`);
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
          tryCraftResource(cost.name, cost.val); // may overwrite plan text with "made N …"
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
  const JOB_REBALANCE_MIN_MS = 20000;
  const JOB_WEIGHT_SMOOTHING = 0.35;
  const JOB_COUNT_DEADBAND_RATIO = 0.08;
  let smoothedJobWeights = {};
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
    storageReliefCap: 30, // max boost from relieving live storage pressure
    housingValue: 6,
    happinessScale: 8,
    idleStoragePenalty: 10, // pure-storage item nothing currently needs
    waitPenaltyCap: 14, // log-scaled time-to-afford penalty
    unreachablePenalty: 22, // no production path at all
    storageBlockPenalty: 48, // a cost sits above a storage cap
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

  const metaEffectProfile = (meta) => {
    const profile = emptyEffectProfile();
    if (!meta || typeof meta !== "object") return profile;
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
    try {
      const game = window.gamePage;
      const resourceName = name === "catpower" ? "manpower" : name;
      if (game && typeof game.getResourcePerTick === "function") {
        const perTick = game.getResourcePerTick(resourceName, true);
        if (isFinite(perTick)) return perTick * ticksPerSecond();
      }
      const res = getRes(resourceMap(), resourceName);
      if (res && isFinite(res.perTickCached)) return res.perTickCached * ticksPerSecond();
      const prod = game && game.village && game.village.getResProduction ? game.village.getResProduction() : {};
      const value = prod[resourceName];
      return isFinite(value) ? value * ticksPerSecond() : 0;
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
      if (!res || !res.maxValue || res.maxValue <= 0 || cost.val <= res.maxValue) continue;
      blockers.push({ name: cost.name, need: cost.val, max: res.maxValue });
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
    const profile = metaEffectProfile(meta);
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
    const profile = metaEffectProfile(meta);
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
      if (res.value / res.maxValue <= 0.7) continue;
      bonus = Math.max(bonus, TUNING.spendBonus * Math.min(1, res.value / cost.val));
    }
    return bonus;
  };

  // Universal value model: read what a candidate actually does from its parsed
  // effects and price its worth against the CURRENT economy — relative
  // production gains scaled by scarcity, storage scaled by live pressure,
  // housing/happiness by their global multipliers. No per-item keyword boosts.
  const economicValue = (meta, resources, goal, goalKey) => {
    const profile = metaEffectProfile(meta);
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
    if (profile.housing > 0) value += TUNING.housingValue;
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

  const effectResourceName = (effectKey) => {
    const match = String(effectKey || "").match(/^([a-z][a-z0-9]*)(?:PerTick|PerTickBase|PerTickAutoprod)$/i);
    return match ? match[1] : null;
  };

  const resourceNamesFromPrices = (kind, meta) =>
    pricesFor(kind, meta)
      .map((cost) => cost && cost.name)
      .filter(Boolean);

  const processingProfileFor = (meta) => {
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

  const PROCESSOR_NAMES = ["smelter", "calciner"];
  const PROCESSOR_INPUTS = {
    smelter: ["wood", "minerals"],
    calciner: ["minerals", "oil"],
  };
  const PROCESSOR_OUTPUTS = {
    smelter: ["iron", "coal", "gold", "titanium"],
    calciner: ["iron", "titanium", "coal"],
  };
  const pausedProcessors = {};
  let processingPlanText = "Processing: watching converters";
  let lastProcessingLog = 0;

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
    }
    return needed;
  };

  const optimizeProcessing = (resources, goalKey) => {
    try {
      const target = getTargetCached(resources, goalKey);
      if (!target) {
        processingPlanText = "Processing: watching converters";
        return;
      }
      const missing = missingDirectCosts(target, resources);
      const needed = resourcesNeededForTarget(target, resources);
      const changed = [];

      for (const name of PROCESSOR_NAMES) {
        const meta = buildingByName(name);
        if (!meta || !meta.val) continue;
        const profile = processingProfileFor(meta);
        const inputs = profile.inputs.length ? profile.inputs : PROCESSOR_INPUTS[name] || [];
        const outputs = profile.outputs.length ? profile.outputs : PROCESSOR_OUTPUTS[name] || [];
        const conflictingInputs = inputs.filter((input) => missing.has(input) && resRatio(resources, input, 1) < 0.85);
        const usefulOutputs = outputs.filter((output) => needed.has(output));
        const shouldPause = conflictingInputs.length > 0 && usefulOutputs.length === 0;
        const currentOn = Math.max(0, meta.on || 0);

        if (shouldPause && currentOn > 0) {
          pausedProcessors[name] = { on: currentOn, label: labelOf(meta) };
          if (setProcessorOn(meta, 0)) changed.push(`paused ${labelOf(meta)} (saving ${conflictingInputs.map((input) => resTitle(resources, input)).join("+")})`);
        } else if (!shouldPause && pausedProcessors[name]) {
          const restore = Math.min(meta.val || 0, pausedProcessors[name].on || meta.val || 0);
          if (setProcessorOn(meta, restore)) changed.push(`resumed ${labelOf(meta)}`);
          delete pausedProcessors[name];
        }
      }

      if (changed.length) {
        processingPlanText = `Processing: ${changed.join("; ")} for ${labelOf(target.meta)}`;
        if (Date.now() - lastProcessingLog > 20000) {
          pushLog(`⚙ ${processingPlanText}`);
          lastProcessingLog = Date.now();
        }
      } else {
        const paused = Object.values(pausedProcessors).map((item) => item.label).filter(Boolean);
        processingPlanText = paused.length ? `Processing: paused ${paused.join(", ")}` : "Processing: converters balanced";
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
      economicValue(meta, resources, goal, goalKey) +
      goalAlignmentBoost(kind, meta, goalKey) +
      spendBonusFor(kind, meta, resources);
    if (kind === "research") {
      score += Math.min(TUNING.gatewayCap, gatewayValue(meta) * TUNING.gatewayScale);
      if (goalFrontierNames(goalKey).has(meta.name)) score += TUNING.frontierBoost;
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
    return candidates
      .map((c) => {
        const evaluation = evaluate(c.kind, c.meta, resources);
        const withEvaluation = { ...c, ...evaluation };
        return { ...withEvaluation, score: candidateScore(withEvaluation, resources, goal, goalKey) };
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
    if (candidate.kind === "research" || candidate.kind === "upgrade" || candidate.kind === "policy") return !!candidate.meta.researched;
    if (candidate.kind === "religion") return religionUpgradePurchased(candidate.meta);
    if (candidate.kind === "build" && activeTarget && activeTarget.id === targetId(candidate)) {
      return (candidate.meta.val || 0) > (activeTarget.initialVal || 0) && Date.now() - activeTarget.startedAt > TARGET_READY_GRACE_MS;
    }
    return false;
  };

  const chooseWorkTarget = (resources, goalKey) => {
    const candidates = gatherCandidates(resources, goalKey);
    const preferred = candidates[0] || null;
    const now = Date.now();

    // The lock is what makes plans PUSH THROUGH. The executor reserves the
    // locked target's resources and buys it the moment it's ready, so the lock
    // only breaks on completion, a storage block, a long timeout, or a rival
    // that is MUCH better — never on ordinary score wobble.
    if (activeTarget) {
      const locked = findCandidateById(candidates, activeTarget.id);
      const age = now - activeTarget.startedAt;
      const lockedWait = locked ? waitSecondsForCandidate(locked, resources) : 0;
      const lockedIsStaleStorage = locked && isStorageMeta(locked.meta) && !locked.affordable && lockedWait > 900 &&
        !storageStillWanted(locked.meta, resources, getStoragePressureCached(resources, GOALS[goalKey], goalKey));
      const lockedIsStorageBlocked = locked && directStorageBlockers(locked.kind, locked.meta, resources).length > 0;
      const muchBetter = preferred && locked && age >= TARGET_LOCK_MIN_MS && preferred.score > locked.score * 1.3 + 8;
      if (!locked || targetComplete(locked) || age > TARGET_LOCK_MAX_MS || lockedIsStaleStorage || lockedIsStorageBlocked) {
        activeTarget = null;
      } else if (!muchBetter) {
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

    for (const job of jobs) {
      const produced = jobResourceFor(job);
      const needKey = produced === "catpower" ? "manpower" : produced;
      let weight = needs[needKey] || 0;
      if (job.name === "woodcutter" && needs.wood > 0) weight = Math.max(weight, needs.wood);
      if (job.name === "farmer" && needs.wood > 0 && bestWoodJob() && bestWoodJob().name === "farmer") {
        weight = Math.max(weight, needs.wood + 1);
      }
      if (job.name === "woodcutter" && bestWoodJob() && bestWoodJob().name === "farmer") {
        weight = Math.min(weight, 0.25);
      }
      // Universal anti-waste rule: stop staffing a job whose output bank is
      // essentially full — unless the economy still wants it (hunting keeps
      // luxuries/mood up even when catpower is high).
      const keepForEconomy = needKey === "manpower" && huntingEconomyNeed(resources) > 0.5;
      if (resRatio(resources, needKey, 0) > 0.94 && !keepForEconomy) weight = 0;
      weights[job.name] = Math.max(0, weight);
    }

    // Starvation guard: if catnip is NET NEGATIVE (winter, big population) and
    // the pantry is draining, force farmers before kittens start dying.
    const netCatnipPerSecond = productionFor("catnip");
    if (jobByName("farmer") && netCatnipPerSecond < 0 && resRatio(resources, "catnip") < 0.6) {
      weights.farmer = Math.max(weights.farmer || 0, 10 + Math.min(25, -netCatnipPerSecond * 2));
    }
    if (resRatio(resources, "catnip") < 0.2 && jobByName("farmer")) weights.farmer = Math.max(weights.farmer || 0, 20);
    if (!Object.values(weights).some((w) => w > 0)) {
      const fallback = bestWoodJob() || jobByName("woodcutter") || jobByName("farmer") || jobs[0];
      if (fallback) weights[fallback.name] = 1;
    }

    // Smooth noisy per-tick weights so tiny ratio changes do not whip kittens
    // back and forth between jobs.  Safety overrides (starving catnip) still
    // win because they push the raw weight far above the smoothed baseline.
    const nextSmoothed = {};
    for (const job of jobs) {
      const raw = weights[job.name] || 0;
      const previous = smoothedJobWeights[job.name];
      nextSmoothed[job.name] = previous == null ? raw : previous * (1 - JOB_WEIGHT_SMOOTHING) + raw * JOB_WEIGHT_SMOOTHING;
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

    const needLine = Object.entries(needs)
      .filter(([, w]) => w > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([name]) => resTitle(resources, name))
      .join(" + ");
    jobPlanText = `Jobs: ${needLine || "balanced"}${target ? ` for ${labelOf(target.meta)}` : ""}`;
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
      const economyNeed = huntingEconomyNeed(resources);
      const threshold = economyNeed > 0.5 ? Math.max(huntCost, cp.maxValue * 0.25) : Math.max(huntCost, cp.maxValue * 0.75);
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
      if (!favored.length) return ""; // balanced — no extra line needed
      const target = getTargetCached(resources, goalKey);
      const targetText = target ? ` · focusing ${labelOf(target.meta)}` : "";
      return `🏁 ${goal.label}: favoring ${favored.join(", ")}${targetText}`;
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
  };

  const KIND_ICONS = { build: "🏗", research: "🔬", upgrade: "⚙", religion: "☀", policy: "📜" };

  const focusLabel = (candidate) => `${KIND_ICONS[candidate.kind] || "🎯"} ${KIND_LABELS[candidate.kind] || candidate.kind.toUpperCase()}`;

  const getPlanLine = (resources, goalKey) => {
    try {
      const target = getTargetCached(resources, goalKey);
      if (!target) return "🎯 FOCUS: scanning unlocked buildings/research/upgrades";
      const reqs = formatRequirements(target.kind, target.meta, resources);
      const storageBlock = storageBlockerText(target.kind, target.meta, resources);
      const state = target.affordable ? "ready now" : storageBlock ? `storage-blocked: ${storageBlock}` : `missing ${target.missing || "prerequisites"}`;
      const eta = formatEta(waitSecondsForCandidate(target, resources));
      const reserved = target.affordable ? [] : Object.keys(reservedNeedsFor(target, resources));
      const reserveNote = reserved.length
        ? ` · reserving ${reserved.slice(0, 3).map((name) => resTitle(resources, name)).join("+")}`
        : "";
      return `🎯 FOCUS: ${focusLabel(target)} — ${labelOf(target.meta)} · ${state} · ETA ${eta}${reserveNote}${reqs ? ` (${reqs})` : ""}`;
    } catch (error) {
      return "🎯 FOCUS: —";
    }
  };

  const getNowAction = (resources, goalKey) => {
    const target = getTargetCached(resources, goalKey);
    if (!target) return "scanning…";
    if (target.affordable) return `buying ${focusLabel(target).toLowerCase()} ${labelOf(target.meta)}`;
    const craftable = pricesFor(target.kind, target.meta).find((cost) => cost && cost.name && cost.val > ((getRes(resources, cost.name) || {}).value || 0) && craftByName(cost.name));
    if (craftable) return `craft ${craftLabel(craftable.name)} for ${labelOf(target.meta)}`;
    return `gather ${target.missing || "prerequisites"} (reserved)`;
  };


  const AUTOBUY_MIN_MS = 2500;
  let lastAutoBuy = 0;

  const purchaseComplete = (candidate, initialVal) => {
    if (!candidate || !candidate.meta) return false;
    if (candidate.kind === "build") return ((candidate.meta.val || 0) > (initialVal || 0));
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
    return !!(result && result.itemBought) || purchaseComplete(candidate, candidate.kind === "build" ? ((meta.val || 0) - 1) : 0);
  };

  const canPayPrices = (prices) => {
    const resources = resourceMap();
    return prices.every((price) => {
      const res = getRes(resources, price.name);
      return res && (res.value || 0) >= price.val;
    });
  };

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
    if (candidate.kind === "build" || candidate.kind === "religion") {
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
      () => buyViaRawMetadata(candidate),
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
    return attempts;
  };

  const buyCandidate = (candidate) => {
    const initialVal = candidate.kind === "build" ? candidate.meta.val || 0 : 0;
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
    for (const cost of pricesFor(target.kind, target.meta)) {
      if (!cost || !cost.name || !isFinite(cost.val) || cost.val <= 0) continue;
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
  //  3. spend only unreserved surplus on anything else, best-scored first.
  // Assist mode stays advisory-only.
  const executePlan = (resources, goalKey) => {
    try {
      if (getProfileName() !== "autopilot") return;
      const now = Date.now();
      const target = getTargetCached(resources, goalKey);

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

      if (now - lastAutoBuy < AUTOBUY_MIN_MS) return;

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

      const reserved = reservedNeedsFor(target, resources);
      const candidates = getCandidatesCached(resources, goalKey);
      const ready = candidates.find((candidate) =>
        candidate.affordable &&
        (!target || targetId(candidate) !== targetId(target)) &&
        !buyBenched(targetId(candidate)) &&
        respectsReservations(candidate, reserved, resources));
      if (!ready) {
        const held = Object.keys(reserved);
        buyPlanText = target && !target.affordable && held.length
          ? `Buy: saving for ${labelOf(target.meta)} (reserving ${held.slice(0, 3).map((name) => resTitle(resources, name)).join(", ")})`
          : "Buy: nothing affordable";
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

  // A policy with an empty `blocks` list forecloses nothing — buying it can
  // never lock you out of another choice, so it's safe to automate. Exclusive
  // policies (liberty vs tradition, monarchy vs republic …) stay manual.
  const policyIsExclusive = (meta) => Array.isArray(meta && meta.blocks) && meta.blocks.length > 0;

  const autoPolicyChoice = (resources, goalKey) => {
    for (const meta of policyMetas()) {
      if (!policyOpen(meta) || policyIsExclusive(meta)) continue;
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
    let score = economicValue(meta, resources, goal, goalKey) + goalAlignmentBoost("policy", meta, goalKey);
    score -= cons.length * 4;
    return score;
  };

  // Only EXCLUSIVE policies appear here — the executor auto-buys the rest.
  const availablePolicyChoices = (resources, goalKey) => policyMetas()
    .filter((meta) => policyOpen(meta) && policyIsExclusive(meta))
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
  let leaderEl;
  let craftEl;
  let processingEl;
  let religionEl;
  let policyEl;
  let policySelectEl;
  let policyApplyEl;
  let nowEl;

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
      let resources = resourceMap();
      const goal = getGoal();
      refineSurplusCatnip();
      optimizeProcessing(resources, goal);
      craftTowardTarget(resources, goal);
      // Crafting can turn a plan affordable immediately.  Re-read resources and
      // rebuild the per-tick target cache before buying, otherwise the next tick
      // (and ongoing raw-resource drain) can steal the just-crafted window.
      resetTickCache();
      resources = resourceMap();
      craftOverflowResources(resources, goal);
      resetTickCache();
      resources = resourceMap();
      reserveFaithForReligionProgression(resources);
      executePlan(resources, goal);
      balanceJobs(goal, resources);
      maybeSelectLeader(goal, resources);
      maybePromoteKittens(resources);
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
      if (buyEl) buyEl.textContent = `🛒 ${buyPlanText}`;
      if (leaderEl) leaderEl.textContent = `👑 ${leaderPlanText}`;
      if (craftEl) craftEl.textContent = `🧰 ${craftPlanText} · ${overflowPlanText}`;
      if (processingEl) processingEl.textContent = `⚙ ${processingPlanText}`;
      if (religionEl) religionEl.textContent = `☀ ${religionPlanText}`;
      renderPolicyControl(resources, goal);
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
    const oldStyle = document.getElementById("kgh-style");
    if (oldStyle) oldStyle.remove();
    const style = document.createElement("style");
    style.id = "kgh-style";
    style.textContent =
      "body.kgh-hide-ks #ksColumn,body.kgh-hide-ks .kitten-scientists,body.kgh-hide-ks [id*=kitten-scientists],body.kgh-hide-ks [class*=kitten-scientists]{display:none!important}" +
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
      '<strong style="font-size:13px">🐱 Kittens Helper</strong>',
      '<span style="white-space:nowrap"><button type="button" class="kgh-hbtn kgh-ks">Show KS</button>',
      '<button type="button" class="kgh-hbtn kgh-min" title="Minimize">–</button></span></div>',
      '<div class="kgh-body" style="display:grid;gap:5px">',
      '<div class="kgh-row"><select class="kgh-grow" aria-label="profile">',
      '<option value="autopilot">Autopilot: play forward</option>',
      '<option value="assist">Assist: jobs + advice</option>',
      "</select><button type=\"button\" class=\"kgh-apply\" style=\"cursor:pointer\">Apply</button></div>",
      '<select class="kgh-goal" aria-label="goal" style="width:100%">',
      // Goal options come straight from GOALS so the dropdown, the planner and
      // the progress line can never drift apart.
      ...Object.entries(GOALS).map(([key, goal]) => `<option value="${key}">🏁 ${goal.label}</option>`),
      "</select>",
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
      '<small class="kgh-leader" style="color:#ffd18f">…</small>',
      '<small class="kgh-craft" style="color:#cdb7ff">…</small>',
      '<small class="kgh-processing" style="color:#c8d0ff">…</small>',
      '<small class="kgh-religion" style="color:#ffe3a3">…</small>',
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
    buyEl = box.querySelector(".kgh-buy");
    leaderEl = box.querySelector(".kgh-leader");
    craftEl = box.querySelector(".kgh-craft");
    processingEl = box.querySelector(".kgh-processing");
    religionEl = box.querySelector(".kgh-religion");
    policyEl = box.querySelector(".kgh-policy");
    policySelectEl = box.querySelector(".kgh-policy-select");
    policyApplyEl = box.querySelector(".kgh-policy-apply");
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
    policyApplyEl.addEventListener("click", () => {
      if (policySelectEl.value && buyPolicyChoice(policySelectEl.value)) tick();
    });
    policySelectEl.addEventListener("change", () => renderPolicyControl(resourceMap(), getGoal()));

    ksBtn.addEventListener("click", () => {
      applyKSHidden(!document.body.classList.contains("kgh-hide-ks"), ksBtn);
    });
    const applyMin = (min) => {
      body.style.display = min ? "none" : "grid";
      minBtn.textContent = min ? "+" : "–";
      localStorage.setItem(MIN_KEY, min ? "1" : "0");
    };
    minBtn.addEventListener("click", () => applyMin(body.style.display !== "none"));

    document.body.classList.add("kgh-helper-ready");
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
