// ==UserScript==
// @name         Kittens Game Helper
// @namespace    https://github.com/ianhuxx/kittens-game-helper
// @version      1.1.2
// @description  Smart one-click autopilot for Kittens Game. Loads Kitten Scientists for crafting/trade/religion/festivals, but owns building/research/upgrade purchases itself: it picks a plan, RESERVES the resources the plan needs so cheaper buys can't eat them, buys the plan the moment it's affordable, and spends only true surplus on everything else. One universal decision framework — every candidate is scored by what its parsed game-metadata effects are worth to the CURRENT economy (production vs scarcity, storage vs live pressure, unlocks, goal alignment) minus how long it takes to afford; no per-item keyword lists. New content is handled automatically: freshly unlocked buildings/techs/upgrades (Mint, Mansion, Observatory, …) are detected, logged and immediately re-planned with a short evaluation boost, converter buildings are discovered from their live effects instead of name lists, and explorers/embassies are sent from the game's own prices. Goals are tech-tree milestones with live n/m progress or effect-category emphases. Recursive prerequisite planning, lookahead-aware job rebalancing (wood-vs-catnip pathway math + starvation guard), prerequisite crafting, overflow conversion, converter pausing, leader election, gold-overflow promotions, hunting. Prestige resets stay OFF.
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
  
  // =========================== SPEEDRUN STATE KEYS ============================
  const STATE_PREFIX = "kgh.state.";
  const STATE_RUN_START = STATE_PREFIX + "runStart";
  const STATE_PEAK_KITTENS = STATE_PREFIX + "peakKittens";
  const STATE_PEAK_PARAGON = STATE_PREFIX + "peakParagon";
  const STATE_PEAK_KARMA = STATE_PREFIX + "peakKarma";
  const STATE_TOTAL_RESETS = STATE_PREFIX + "totalResets";
  const STATE_PARAGON_HISTORY = STATE_PREFIX + "paragonHistory";
  const STATE_LAST_PARAGON_GAIN = STATE_PREFIX + "lastParagonGain";
  const STATE_LAST_PARAGON_TIME = STATE_PREFIX + "lastParagonTime";

  // ========================== SPEEDRUN CONSTANTS ==============================
  const TARGET_LOCK_MIN_EARLY = 30000;
  const TARGET_LOCK_MIN_MID = 60000;
  const TARGET_LOCK_MIN_LATE = 120000;
  const TARGET_LOCK_MAX_MS = 360000;
  const EARLY_GAME_KITTENS = 30;
  const EARLY_GAME_RESEARCH_COUNT = 8;
  const SPRINT_PROGRESS_THRESHOLD = 0.75;
  const RESET_PARAGON_PER_DAY_MIN = 8;
  const FAITH_INVEST_WORSHIP_MULTIPLIER = 1.08;

  const METAPHYSICS_ORDER = [
    { name: "engineering", cost: 5, label: "Engineering — price ratio -10%" },
    { name: "goldenRatio", cost: 15, label: "Golden Ratio — price ratio → 1.618/1" },
    { name: "divineProportion", cost: 50, label: "Divine Proportion — further price drop" },
    { name: "vitruvianFeline", cost: 100, label: "Vitruvian Feline — near-linear prices" },
    { name: "renaissance", cost: 750, label: "Renaissance — price ratio → 1.15/1" },
    { name: "chronomancy", cost: 30, label: "Chronomancy — time crystal basics (5+25)" },
    { name: "anachronomancy", cost: 375, label: "Anachronomancy — chronospheres (125+250)" },
  ];

  // ======================== CROSS-RUN STATE ==================================
  const stateGet = (key, fallback) => {
    try { const val = localStorage.getItem(key); return val != null ? JSON.parse(val) : fallback; }
    catch (e) { return fallback; }
  };
  const stateSet = (key, value) => {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* ignore */ }
  };

  const speedrunState = {
    runStart: stateGet(STATE_RUN_START, 0),
    peakKittens: stateGet(STATE_PEAK_KITTENS, 0),
    peakParagon: stateGet(STATE_PEAK_PARAGON, 0),
    peakKarma: stateGet(STATE_PEAK_KARMA, 0),
    totalResets: stateGet(STATE_TOTAL_RESETS, 0),
    paragonHistory: stateGet(STATE_PARAGON_HISTORY, []),
    lastParagonGain: stateGet(STATE_LAST_PARAGON_GAIN, 0),
    lastParagonTime: stateGet(STATE_LAST_PARAGON_TIME, 0),
  };

  const saveSpeedrunState = () => {
    stateSet(STATE_RUN_START, speedrunState.runStart);
    stateSet(STATE_PEAK_KITTENS, speedrunState.peakKittens);
    stateSet(STATE_PEAK_PARAGON, speedrunState.peakParagon);
    stateSet(STATE_PEAK_KARMA, speedrunState.peakKarma);
    stateSet(STATE_TOTAL_RESETS, speedrunState.totalResets);
    stateSet(STATE_PARAGON_HISTORY, speedrunState.paragonHistory.slice(-20));
    stateSet(STATE_LAST_PARAGON_GAIN, speedrunState.lastParagonGain);
    stateSet(STATE_LAST_PARAGON_TIME, speedrunState.lastParagonTime);
  };

  const detectRunRestart = () => {
    try {
      const kittens = totalKittenCount();
      const paragon = window.gamePage.paragonPoints || 0;
      const karma = typeof window.gamePage.getEffect === "function"
        ? window.gamePage.getEffect("karma") || 0 : 0;
      const totalResets = window.gamePage.totalResets || 0;
      if (totalResets > speedrunState.totalResets) {
        const now = Date.now();
        const lastGain = paragon - speedrunState.peakParagon;
        if (lastGain > 0) {
          speedrunState.paragonHistory.push({ time: now, gain: lastGain, kittens: speedrunState.peakKittens });
          speedrunState.paragonHistory = speedrunState.paragonHistory.slice(-20);
          speedrunState.lastParagonGain = lastGain;
          speedrunState.lastParagonTime = now;
        }
        speedrunState.totalResets = totalResets;
        speedrunState.runStart = now;
        speedrunState.peakKittens = kittens;
        speedrunState.peakParagon = paragon;
        speedrunState.peakKarma = karma;
        speedrunState.lastParagonGain = lastGain;
        speedrunState.lastParagonTime = now;
        saveSpeedrunState();
        pushLog("\u{1F504} new run detected \u2014 welcome back");
      }
      if (speedrunState.runStart === 0) speedrunState.runStart = Date.now();
      if (kittens > speedrunState.peakKittens) speedrunState.peakKittens = kittens;
      if (paragon > speedrunState.peakParagon) speedrunState.peakParagon = paragon;
      if (karma > speedrunState.peakKarma) speedrunState.peakKarma = karma;
    } catch (e) { /* ignore */ }
  };

  // =========================== PARAGON / KARMA AWARENESS =====================
  const getParagonProductionMultiplier = () => {
    try {
      const paragon = window.gamePage.paragonPoints || 0;
      const burned = window.gamePage.burnedParagon || 0;
      const burnedCap = (window.gamePage.calendar && window.gamePage.calendar.year > 40000) ? 400 : 100;
      const burnedDim = (window.gamePage.calendar && window.gamePage.calendar.year > 40000) ? 300 : 75;
      const pMult = Math.min(paragon * 0.01, 2.0);
      const bMult = Math.min(burned, burnedCap) * 0.01;
      const bDim = burned > burnedDim ? burnedDim * 0.01 + (burned - burnedDim) * 0.0005 : bMult;
      return 1 + pMult + bDim;
    } catch (e) { return 1; }
  };

  const getKarmaHappinessBonus = () => {
    try { return (speedrunState.peakKarma || 0) / 100; } catch (e) { return 0; }
  };

  const isEarlyGame = () => {
    const kittens = totalKittenCount();
    const researchCount = researchDoneCount();
    return kittens < EARLY_GAME_KITTENS && researchCount < EARLY_GAME_RESEARCH_COUNT;
  };

  const isMidGame = () => totalKittenCount() < 120;

  // =========================== RESET ADVISOR =================================
  let resetAdvisorText = "Reset advisor: tracking\u2026";

  const totalKittenCount = () => {
    try { return window.gamePage.village.sim.kittens.length; } catch (e) { return 0; }
  };

  const researchDoneCount = () => {
    try { return (window.gamePage.science.techs || []).filter(t => t && t.researched).length; } catch (e) { return 0; }
  };

  const currentParagon = () => {
    try { return window.gamePage.paragonPoints || 0; } catch (e) { return 0; }
  };

  const computeResetAdvisor = () => {
    try {
      detectRunRestart();
      const now = Date.now();
      const runDays = Math.max(0.001, (now - speedrunState.runStart) / 86400000);
      const kittens = totalKittenCount();
      const expectedParagon = Math.max(0, kittens - 70);
      const paragonPerDay = expectedParagon / runDays;
      let trend = "";
      const hist = speedrunState.paragonHistory;
      if (hist.length >= 2) {
        const recent = hist.slice(-3);
        const avgGain = recent.reduce((s, h) => s + h.gain, 0) / recent.length;
        if (avgGain > 0) {
          let totalDays = 0;
          for (let i = 0; i < recent.length; i++) {
            const h = recent[i];
            const idx = hist.indexOf(h);
            const prev = idx > 0 ? hist[idx - 1] : null;
            totalDays += prev ? (h.time - prev.time) / 86400000 : runDays;
          }
          const histRate = totalDays > 0 ? avgGain / Math.max(1, totalDays) : 0;
          trend = histRate > 0 ? " \u00b7 avg " + fmt(histRate) + "/day over last " + recent.length + " resets" : "";
        }
      }
      let recommendation = "";
      if (kittens < 35) {
        recommendation = "growing (need 35+ kittens for karma, 70+ for paragon)";
      } else if (kittens < 70) {
        const karmaGain = kittens - 35;
        recommendation = "push to 70+ kittens for paragon \u00b7 " + fmt(karmaGain) + " karma if reset now";
      } else if (paragonPerDay < RESET_PARAGON_PER_DAY_MIN) {
        recommendation = "DIMINISHING \u2014 consider reset now";
      } else {
        recommendation = "healthy growth \u00b7 push further";
      }
      const nextMeta = METAPHYSICS_ORDER.find(m => {
        try {
          const sci = window.gamePage.science;
          return !(sci && sci.get && sci.get(m.name) && sci.get(m.name).researched);
        } catch (e) { return true; }
      });
      const metaLine = nextMeta && currentParagon() >= nextMeta.cost
        ? " \u00b7 next meta: " + nextMeta.label + " (" + nextMeta.cost + "P, you have " + fmt(currentParagon()) + ")"
        : "";
      resetAdvisorText = "\u267B Reset: " + totalKittenCount() + " kittens \u00b7 " + fmt(expectedParagon)
        + " paragon now \u00b7 " + fmt(paragonPerDay) + "/day" + trend
        + " \u00b7 " + recommendation + metaLine;
      if (Math.random() < 0.1) saveSpeedrunState();
    } catch (e) { resetAdvisorText = "Reset advisor: \u2014"; }
  };

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
  // These sections are also paused dynamically while the active plan is saving
  // scarce resources.  That makes the reservation contract universal: KS trade,
  // space and time automations cannot drain gold/culture/catpower/etc. out from
  // under a focused build/research target.
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
  const PRIORITY_KEY = "kgh.priority";
  const DEFAULT_GOAL = "balanced";
  const DEFAULT_PRIORITY = "auto";const GOALS = {
    balanced: {
      label: "Balanced — steady all-round growth",
      target: null,
      emphasis: {},
    },
    speedrun: {
      label: "Speedrun — rapid expansion for fastest reset",
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


  const externalSectionHasPurchases = (section) => PURCHASE_SECTIONS.includes(section);

  const externalSpenderLabel = (section) => section.charAt(0).toUpperCase() + section.slice(1);

  // KS owns a few broad purchasing systems whose exact costs can vary by race,
  // era and unlock state.  Because those buyers run outside this helper's
  // purchase loop, they cannot call respectsReservations() before spending.
  // When the focused plan is still saving, pause those external spenders instead
  // of trying to mirror every possible KS trade/space/time price.  This is the
  // universal guard that prevents e.g. lizard trades from repeatedly consuming
  // the gold reserved for a Temple.
  let externalSpendersPlanText = "External spenders: watching KS trade/space/time";
  let diplomacyPrepText = "Diplomacy prep: watching trade unlocks";
  let externalSpendersPaused = false;
  let lastExternalSpenderLog = 0;

  const reservedResourceNames = (target, resources) => Object.keys(reservedNeedsFor(target, resources));

  const setExternalSpendersEnabled = (settings, enabled) => {
    if (!settings) return;
    for (const section of PURCHASE_SECTIONS) {
      if (!externalSectionHasPurchases(section) || !settings[section]) continue;
      setEnabledDeep(settings[section], enabled, section);
      if (enabled) setTriggersDeep(settings[section], 0);
    }
  };

  const protectPlanFromExternalSpenders = (resources, goalKey) => {
    try {
      if (getProfileName() !== "autopilot") return;
      const settings = window.kittenScientists && window.kittenScientists.getSettings && window.kittenScientists.getSettings();
      if (!settings) return;
      const target = getTargetCached(resources, goalKey);
      const reserved = target && !target.affordable ? reservedResourceNames(target, resources) : [];
      const explorerSave = shouldSaveForExplorers(resources);
      const shouldPause = reserved.length > 0 || explorerSave;
      setExternalSpendersEnabled(settings, !shouldPause);
      if (window.kittenScientists.setSettings) window.kittenScientists.setSettings(settings);

      if (shouldPause) {
        const shown = reserved.slice(0, 3).map((name) => resTitle(resources, name)).join("+");
        externalSpendersPlanText = explorerSave && !reserved.length
          ? "External spenders: paused Trade/Space/Time while saving Catpower for explorers"
          : `External spenders: paused ${PURCHASE_SECTIONS.map(externalSpenderLabel).join("/")} while saving ${shown} for ${labelOf(target.meta)}`;
        if (!externalSpendersPaused || Date.now() - lastExternalSpenderLog > 60000) {
          pushLog(`🛡 ${externalSpendersPlanText}`);
          lastExternalSpenderLog = Date.now();
        }
      } else {
        externalSpendersPlanText = `External spenders: ${PURCHASE_SECTIONS.map(externalSpenderLabel).join("/")} allowed (no active resource reserve)`;
      }
      externalSpendersPaused = shouldPause;
    } catch (error) {
      /* ignore external-spender pacing failures */
    }
  };

  let religionPlanText = "Religion: watching faith";

  const solarRevolutionLevel = () => {
    try { return window.gamePage.religion && window.gamePage.religion.solarRevolution ? window.gamePage.religion.solarRevolution : 0; }
    catch (e) { return 0; }
  };

  const faithWorshipForNextLevel = () => {
    try {
      const religion = window.gamePage && window.gamePage.religion;
      if (!religion) return Infinity;
      const current = religion.faith || 0;
      const sr = solarRevolutionLevel();
      const base = 500;
      const cost = base * Math.pow(1.1, sr);
      return Math.max(0, cost - current);
    } catch (e) { return Infinity; }
  };

  const reserveFaithForReligionProgression = (resources) => {
    try {
      const settings = window.kittenScientists && window.kittenScientists.getSettings && window.kittenScientists.getSettings();
      if (!settings || !settings.religion) return;
      configureReligionProgression(settings);
      const faith = getRes(resources, "faith");
      const faithVal = (faith && faith.value) || 0;
      const faithMax = (faith && faith.maxValue) || 0;
      const next = nextFaithReligionUpgrade(resources);
      const worshipNeeded = faithWorshipForNextLevel();
      const faithForNextSR = Math.max(0, worshipNeeded - faithVal);
      if (faithForNextSR > 0 && faithForNextSR < faithMax * 0.3 && faithVal > faithMax * 0.4) {
        setReligionPraiseState(settings, false);
        religionPlanText = `☀ Saving faith for Solar Revolution +1 (need ${fmt(faithForNextSR)} more)`;
      } else if (next) {
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

  const resetTickCache = () => {
    tickCache = {
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
      // Don't feed the catnip→wood→beam chain when wood is already abundant.
      // If wood storage is near cap AND the active plan doesn't need raw wood
      // (e.g. Observatory is waiting on iron, not wood), skip refining so
      // catnip stays available for food/housing instead of getting beamed.
      const wood = res.get("wood");
      if (wood && wood.maxValue && wood.value / wood.maxValue > 0.88) {
        const goalKey = getGoal();
        const target = getTargetCached(res, goalKey);
        // Check if the active target still needs raw wood directly
        let needsWood = false;
        if (target && !target.affordable) {
          for (const cost of pricesFor(target.kind, target.meta)) {
            if (cost && cost.name && cost.val > 0) {
              if (cost.name === "wood") { needsWood = true; break; }
              // If a craftable cost needs wood in its raw chain, count it
              if (craftByName(cost.name)) {
                const raw = rawPathRequirements(cost.name, Math.max(1, cost.val));
                if (raw.wood > 0) { needsWood = true; break; }
              }
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
    const net = typeof res.perTickCached === "number" ? res.perTickCached : productionFor(name);
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
  const overflowInputFloor = (target, resources, inputName, outputName) => {
    let floor = craftFloorFor(resources, inputName);
    if (!target) return floor;

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
        if (!hotInputs.length && !targetNeedsResource(target, name)) continue;
        let maxUnits = Number.MAX_VALUE;
        for (const price of prices) {
          const input = getRes(resources, price.name);
          const value = (input && input.value) || 0;
          const reserve = overflowInputFloor(target, resources, price.name, name);
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
  const PARAGON_MULTIPLIER = () => {
    try {
      if (tickCache._paragonMult == null) tickCache._paragonMult = getParagonProductionMultiplier();
      return tickCache._paragonMult;
    } catch (e) { return 1; }
  };

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
    try {
      const game = window.gamePage;
      if (game && typeof game.getResourcePerTick === "function") {
        const perTick = game.getResourcePerTick(resourceName, true);
        if (isFinite(perTick)) result = perTick * ticksPerSecond();
        tickCache.production[resourceName] = result;
        return result;
      }
      const res = getRes(resourceMap(), resourceName);
      if (res && isFinite(res.perTickCached)) {
        result = res.perTickCached * ticksPerSecond();
        tickCache.production[resourceName] = result;
        return result;
      }
      const prod = game && game.village && game.village.getResProduction ? game.village.getResProduction() : {};
      const value = prod[resourceName];
      result = isFinite(value) ? value * ticksPerSecond() : 0;
    } catch (error) {
      result = 0;
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
  const PROCESSOR_INPUTS = {
    smelter: ["wood", "minerals"],
    calciner: ["minerals", "oil"],
  };
  const PROCESSOR_OUTPUTS = {
    smelter: ["iron", "coal", "gold", "titanium"],
    calciner: ["iron", "titanium", "coal"],
  };

  const converterBuildings = () => {
    const out = [];
    const seen = new Set();
    for (const meta of buildingMetas()) {
      if (!meta || !meta.name || !(meta.val > 0) || seen.has(meta.name)) continue;
      const profile = processingProfileFor(meta);
      if ((profile.inputs.length && profile.outputs.length) || KNOWN_CONVERTERS.includes(meta.name)) {
        seen.add(meta.name);
        out.push(meta);
      }
    }
    return out;
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

      for (const meta of converterBuildings()) {
        const name = meta.name;
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
      economicValue(kind, meta, resources, goal, goalKey) +
      goalAlignmentBoost(kind, meta, goalKey) +
      spendBonusFor(kind, meta, resources) +
      manualPriorityBoostFor(kind, meta) +
      noveltyBoostFor(candidate);
    if (isEarlyGame()) {
      const unlockMult = meta.unlocks && meta.unlocks.length > 0 ? TUNING.earlyGameUnlockMult : 1;
      score += TUNING.earlyGameBonus * unlockMult;
    }
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

  const getTargetLockMs = () => {
    if (isEarlyGame()) return TARGET_LOCK_MIN_EARLY;
    if (isMidGame()) return TARGET_LOCK_MIN_MID;
    return TARGET_LOCK_MIN_LATE;
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
      const muchBetter = preferred && locked && age >= getTargetLockMs() && preferred.score > locked.score * 1.3 + 8;
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
    // Iron/titanium/uranium need lives inside "minerals" but the mineral cap
    // zeroing above should NOT starve them. Restore sub-resource needs so
    // miners keep running when the plan demands iron (e.g. Observatory).
    for (const sub of ["iron", "titanium", "uranium"]) {
      const sval = needs[sub];
      if (sval > 0 && (needs.minerals || 0) < 0.5) needs.minerals = Math.max(needs.minerals || 0, sval * 0.7);
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
      // Woodcutters still matter even when farmers refine catnip more efficiently:
      // farmers can hit job caps, and refineSurplusCatnip only fires at 86%+ catnip.
      // The +1 farmer bonus already gives farmers preference; this is a backstop.
      if (job.name === "woodcutter" && bestWoodJob() && bestWoodJob().name === "farmer") {
        weight = Math.max(weight, 0.8);
      }
      // Universal anti-waste rule: stop staffing a job whose output bank is
      // essentially full — unless the economy still wants it (hunting keeps
      // luxuries/mood up even when catpower is high).
      const keepForEconomy = needKey === "manpower" && huntingEconomyNeed(resources) > 0.5;
      if (resRatio(resources, needKey, 0) > 0.94 && !keepForEconomy) weight = 0;
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
      let threshold = economyNeed > 0.5 ? Math.max(huntCost, cp.maxValue * 0.25) : Math.max(huntCost, cp.maxValue * 0.75);
      // Exploration shares this bank. While an undiscovered trade partner is
      // waiting and the cap can fit the explorer fee, hold hunting back far
      // enough that it can never permanently starve "Send explorers"
      // (diplomacy runs earlier in the tick, so explorers get first claim).
      const exploreCost = hasLockedDiscoverableRace() ? explorerPrices()[0].val : 0;
      if (exploreCost > 0 && cp.maxValue > exploreCost * 1.15) {
        threshold = Math.max(threshold, Math.min(cp.maxValue * 0.95, exploreCost + huntCost));
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
      const sprintTag = target._sprint ? " 🚀SPRINT" : "";
      return `🎯 FOCUS: ${focusLabel(target)} — ${labelOf(target.meta)} · ${state} · ETA ${eta}${reserveNote}${sprintTag}${reqs ? ` (${reqs})` : ""}`;
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
  const isSprintCandidate = (target, resources) => {
    if (!target || target.affordable) return false;
    const p = evaluate(target.kind, target.meta, resources);
    return p.progress >= SPRINT_PROGRESS_THRESHOLD;
  };

  const executePlan = (resources, goalKey) => {
    try {
      if (getProfileName() !== "autopilot") return;
      const now = Date.now();
      computeResetAdvisor();
      const target = getTargetCached(resources, goalKey);
      const sprint = isSprintCandidate(target, resources);
      if (sprint && target) target._sprint = true;

      if (target && target.affordable && !buyBenched(targetId(target))) {
        lastAutoBuy = now;
        if (buyCandidate(target)) {
          pushLog(`🎯 plan ${target.kind} ${labelOf(target.meta)}`);
          buyPlanText = `Buy: plan completed — ${labelOf(target.meta)}`;
          activeTarget = null;
        } else if (noteBuyFailure(targetId(target))) {
          activeTarget = null;
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
      const readyFilter = sprint
        ? (c) => c.affordable && (!target || targetId(c) === targetId(target)) && !buyBenched(targetId(c))
        : (c) => c.affordable && (!target || targetId(c) !== targetId(target)) && !buyBenched(targetId(c)) && respectsReservations(c, reserved, resources);

      const ready = candidates.find(readyFilter);

      if (!ready) {
        const held = Object.keys(reserved);
        const sprintTag = sprint ? " 🚀SPRINT — holding all surplus for target" : "";
        buyPlanText = target && !target.affordable && held.length
          ? `Buy: saving for ${labelOf(target.meta)} (reserving ${held.slice(0, 3).map((name) => resTitle(resources, name)).join(", ")})${sprintTag}`
          : sprint ? `Buy: sprint — everything reserved for ${labelOf(target.meta)}` : "Buy: nothing affordable";
        return;
      }
      lastAutoBuy = now;
      if (buyCandidate(ready)) {
        pushLog(`${ready.kind === "upgrade" ? "⚙" : ready.kind === "research" ? "🔬" : "🏗"} ${sprint ? "sprint" : "surplus"} ${ready.kind} ${labelOf(ready.meta)}`);
        buyPlanText = sprint ? `Buy: SPRINT ${labelOf(ready.meta)}` : `Buy: ${labelOf(ready.meta)} from surplus`;
      } else {
        noteBuyFailure(targetId(ready));
      }
    } catch (error) { /* ignore */ }
  };

  // ================================ STARTUP ==================================
  const startWhenReady = () => {
    if (window.gamePage && window.kittenScientists) {
      applyProfile(DEFAULT_PROFILE);
    } else {
      setTimeout(startWhenReady, 500);
    }
  };
  startWhenReady();

})();
