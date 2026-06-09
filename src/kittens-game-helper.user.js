// ==UserScript==
// @name         Kittens Game Helper
// @namespace    https://github.com/ianhuxx/kittens-game-helper
// @version      0.8.0
// @description  Smart one-click autopilot for Kittens Game. Loads Kitten Scientists, turns on every SAFE automation, auto-assigns idle kittens (with wood-vs-catnip pathway math), sends hunters, refines surplus catnip into wood, and shows the bottleneck + next science + goal + a live action log. Prestige resets stay OFF.
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
      note: "Builds the instant things are affordable, auto-assigns idle kittens to the best job (with wood-vs-catnip pathway math), sends hunters, and refines surplus catnip into wood. Prestige resets stay OFF.",
    },
    assist: {
      label: "Assist: jobs + advice",
      note: "Only jobs, hunting, festivals and event-observing run. You decide what to build/research — the advisor tells you what's next.",
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
      for (const res of window.gamePage.resPool.resources) map.set(res.name, res);
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
      const res = resources.get(cost.name);
      const have = (res && res.value) || 0;
      progress = Math.min(progress, have / cost.val);
      if (have < cost.val) {
        affordable = false;
        missing.push(`${fmt(cost.val - have)} ${(res && res.title) || cost.name}`);
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

  const RES_JOB = { minerals: "miner", science: "scholar", catnip: "farmer", coal: "geologist", faith: "priest" };

  // Decide which job idle kittens should go to, based on food safety, the current
  // bottleneck, and your chosen goal.
  const chooseJob = (goalKey, resources) => {
    const ratio = (n) => {
      const r = resources.get(n);
      return r && r.maxValue > 0 ? r.value / r.maxValue : 1;
    };
    if (ratio("catnip") < 0.15) return jobByName("farmer") || jobByName("woodcutter"); // food first
    let target;
    if (ratio("wood") < 0.1) target = "wood";
    else if (ratio("minerals") < 0.1) target = "minerals";
    else if (goalKey === "space") target = "science";
    else if (goalKey === "production") target = ratio("minerals") <= ratio("wood") ? "minerals" : "wood";
    else if (goalKey === "population") target = "catnip";
    else {
      const opts = ["wood", "minerals", "science"]
        .filter((n) => ratio(n) < 0.95)
        .sort((a, b) => ratio(a) - ratio(b));
      target = opts[0] || "science";
    }
    if (target === "wood") return bestWoodJob() || jobByName("woodcutter");
    return jobByName(RES_JOB[target]) || jobByName("scholar") || jobByName("farmer");
  };

  const balanceJobs = (goalKey, resources) => {
    try {
      const village = window.gamePage.village;
      if (!village || typeof village.getFreeKittens !== "function") return;
      const free = Math.floor(village.getFreeKittens());
      if (free <= 0) return;
      const job = chooseJob(goalKey, resources);
      if (job && typeof village.assignJob === "function") {
        village.assignJob(job, free);
        pushLog(`👷 ${free} → ${job.title || job.name}`);
      }
    } catch (error) {
      /* ignore */
    }
  };

  let lastHuntLog = 0;
  const autoHunt = (resources) => {
    try {
      const village = window.gamePage.village;
      const cp = resources.get("catpower");
      if (!village || !cp || !cp.maxValue || typeof village.huntAll !== "function") return;
      if (cp.value >= cp.maxValue * 0.9) {
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

  const SPENDABLE = ["science", "culture", "faith", "catpower"];
  const RAW = ["wood", "minerals", "iron", "coal"];

  const getBottleneck = (resources) => {
    for (const name of SPENDABLE) {
      const r = resources.get(name);
      if (r && r.maxValue > 0 && r.value >= r.maxValue * 0.99) {
        const fix = name === "catpower" ? "send hunters" : "build more storage / spend it";
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

  const getNowAction = (resources, goalKey) => {
    const goal = GOALS[goalKey];
    const candidates = [];
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
    const affordable = candidates
      .map((c) => ({ ...c, ...evaluate(c.kind, c.meta, resources) }))
      .filter((c) => c.affordable)
      .map((c) => ({
        ...c,
        weight: c.weight + (goal && goal.keywords.length && matchesKeywords(c.meta, goal.keywords) ? 10 : 0),
      }))
      .sort((a, b) => b.weight - a.weight)[0];
    return affordable ? `${affordable.kind} ${labelOf(affordable.meta)}` : "gathering…";
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
      if (nowEl) nowEl.textContent = `🎯 Now: ${getNowAction(resources, goal)}`;
    } catch (error) {
      /* ignore */
    }
  };

  /* ------------------------------- the panel -------------------------------- */

  const buildPanel = () => {
    const box = document.createElement("div");
    box.style.cssText =
      "position:fixed;right:12px;bottom:12px;z-index:99999;width:300px;padding:9px 10px;" +
      "background:#2b2118;color:#f7ead0;border:1px solid #9b7a4d;border-radius:5px;" +
      "font:12px/1.4 sans-serif;display:grid;gap:5px;box-shadow:0 2px 10px #0009";
    box.innerHTML = [
      '<strong style="font-size:13px">🐱 Kittens Helper</strong>',
      '<div style="display:flex;gap:6px"><select style="flex:1" aria-label="profile">',
      '<option value="autopilot">Autopilot: play forward</option>',
      '<option value="assist">Assist: jobs + advice</option>',
      "</select><button type=\"button\" style=\"cursor:pointer\">Apply</button></div>",
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
      '<small class="kgh-now" style="color:#e6d79a">…</small>',
      '<div style="opacity:.8;border-top:1px solid #9b7a4d50;padding-top:3px">Recent actions:</div>',
      '<pre class="kgh-log" style="margin:0;max-height:92px;overflow:auto;white-space:pre-wrap;' +
        'font:11px/1.35 monospace;color:#d9ccae;background:#0003;padding:4px;border-radius:3px">…</pre>',
      '<small style="opacity:.65">Resets stay OFF. Back up your save (Options → Export) first.</small>',
    ].join("");

    const select = box.querySelector("select");
    const goalSelect = box.querySelector(".kgh-goal");
    const button = box.querySelector("button");
    const note = box.querySelector(".kgh-note");
    statusEl = box.querySelector(".kgh-status");
    goalEl = box.querySelector(".kgh-goal-line");
    bottleneckEl = box.querySelector(".kgh-bottleneck");
    scienceEl = box.querySelector(".kgh-science");
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

    document.body.appendChild(box);
    note.textContent = PROFILE_INFO[select.value].note;
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
