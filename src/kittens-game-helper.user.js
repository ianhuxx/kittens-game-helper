// ==UserScript==
// @name         Kittens Game Helper
// @namespace    https://github.com/ianhuxx/kittens-game-helper
// @version      0.5.0
// @description  One-click autopilot for Kittens Game. Loads Kitten Scientists, turns on every SAFE automation (jobs, building, research, crafting, trade, faith, hunting, festivals), and shows what to build/research next. Prestige resets stay OFF, so it continues your existing save.
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
 * Kittens Game Helper
 * -------------------
 * A thin layer on top of Kitten Scientists (KS), the proven automation engine.
 * It does NOT reimplement the game logic. On every page load it:
 *   1. waits for the game (window.gamePage) and KS (window.kittenScientists),
 *   2. applies the selected profile by walking the LIVE KS settings tree and
 *      flipping every `enabled` flag on/off (so we never depend on fragile
 *      hard-coded setting paths that break between KS versions),
 *   3. forces all irreversible / resource-burning automations OFF so your
 *      existing save is never reset or drained by surprise,
 *   4. shows a tiny bottom-right panel: profile picker + a "what next" advisor.
 *
 * Two profiles:
 *   - "autopilot" (default): turn ON every safe automation. Plays the game.
 *   - "assist": only jobs, hunting, festivals and event-observing. You keep
 *     control of what to build/research; the advisor tells you what's next.
 */

(function kittensGameHelper() {
  "use strict";

  const STORAGE_KEY = "kgh.profile";
  const DEFAULT_PROFILE = "autopilot";
  // Official KS loader, used only as a fallback if the pinned @require ever fails.
  const KS_FALLBACK_LOADER = "https://kitten-science.com/stable.js";

  // Automations that are irreversible or spend hoardable resources. These are
  // matched by key name anywhere in the KS settings tree and forced OFF.
  const DENY_SUBSTRINGS = ["reset", "transcend", "sacrifice", "shatter", "timeskip"];
  const DENY_EXACT = new Set(["adore", "upgradeBuildings", "promoteKittens"]);

  const PROFILE_INFO = {
    autopilot: {
      label: "Autopilot: play forward",
      note: "Every safe automation is ON (jobs, building, research, crafting, trade, faith, space, hunting, festivals, time acceleration). Prestige resets stay OFF.",
    },
    assist: {
      label: "Assist: jobs + advice",
      note: "Only jobs, hunting, festivals and event-observing run. You decide what to build/research — the line below tells you what's next.",
    },
  };

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const getProfileName = () => {
    const stored = localStorage.getItem(STORAGE_KEY);
    return PROFILE_INFO[stored] ? stored : DEFAULT_PROFILE;
  };

  const isDeniedKey = (key) => {
    if (!key) return false;
    if (DENY_EXACT.has(key)) return true;
    const lower = String(key).toLowerCase();
    return DENY_SUBSTRINGS.some((needle) => lower.includes(needle));
  };

  // Recursively set every `enabled` flag in a KS settings subtree to `value`.
  // Denied subtrees are forced OFF and not descended into.
  const setEnabledDeep = (node, value, key) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) setEnabledDeep(child, value);
      return;
    }
    if (isDeniedKey(key)) {
      if ("enabled" in node) node.enabled = false;
      return; // never enable anything inside an irreversible automation
    }
    if ("enabled" in node) node.enabled = value;
    for (const [childKey, childVal] of Object.entries(node)) {
      if (childKey === "enabled") continue;
      if (childVal && typeof childVal === "object") {
        setEnabledDeep(childVal, value, childKey);
      }
    }
  };

  // Make sure idle kittens actually get distributed across all jobs.
  const enableAllJobs = (settings) => {
    const village = settings && settings.village;
    const jobs = village && (village.jobs || village.job);
    if (!jobs || typeof jobs !== "object") return;
    for (const job of Object.values(jobs)) {
      if (job && typeof job === "object") {
        job.enabled = true;
        if ("max" in job) job.max = -1; // -1 = no cap; let KS balance them
      }
    }
  };

  const buildSettings = (profileName) => {
    const settings = window.kittenScientists.getSettings();

    if (profileName === "assist") {
      // Clean slate: turn everything off, then switch on only the helpers.
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
      // Autopilot: turn ON every safe automation.
      setEnabledDeep(settings, true);
      if (settings.engine) {
        settings.engine.enabled = true;
        settings.engine.interval = 1000;
        // Resource control can auto-sell/consume stockpiles — keep it off.
        if (settings.engine.resources) settings.engine.resources.enabled = false;
      }
    }

    enableAllJobs(settings);
    return settings;
  };

  let started = false;
  const ensureEngineRunning = () => {
    if (started) return;
    started = true;
    // KS auto-runs when engine.enabled is true, but on a brand-new install the
    // loop may not have started yet. Nudge it once, defensively.
    try {
      const engine = window.kittenScientists && window.kittenScientists.engine;
      if (engine && typeof engine.start === "function" && engine.isProcessing !== true) {
        engine.start();
      }
    } catch (error) {
      /* enabled flag will start it on the next KS tick */
    }
  };

  const applyProfile = (profileName) => {
    const name = PROFILE_INFO[profileName] ? profileName : DEFAULT_PROFILE;
    const settings = buildSettings(name);
    window.kittenScientists.setSettings(settings);
    localStorage.setItem(STORAGE_KEY, name);
    ensureEngineRunning();
    console.info(`[KGH] Applied "${PROFILE_INFO[name].label}". Prestige resets remain OFF.`);
    updateAdvisor();
  };

  /* --------------------------- next-action advisor --------------------------- */

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

  const collectCandidates = () => {
    const game = window.gamePage;
    const out = [];
    if (!game) return out;
    try {
      for (const tech of game.science.techs || []) {
        if (isOpen(tech)) out.push({ kind: "research", weight: 4, meta: tech });
      }
    } catch (error) {
      /* ignore */
    }
    try {
      for (const upgrade of game.workshop.upgrades || []) {
        if (isOpen(upgrade)) out.push({ kind: "upgrade", weight: 3, meta: upgrade });
      }
    } catch (error) {
      /* ignore */
    }
    try {
      for (const building of buildingMetas()) {
        if (building && building.unlocked !== false) {
          out.push({ kind: "build", weight: 2, meta: building });
        }
      }
    } catch (error) {
      /* ignore */
    }
    return out;
  };

  const evaluate = (candidate, resources) => {
    const costs = pricesFor(candidate.kind, candidate.meta).filter(
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

  const labelOf = (meta) => meta.label || meta.title || meta.name || "?";

  const getAdvice = () => {
    const resources = resourceMap();
    const scored = collectCandidates()
      .map((candidate) => ({ ...candidate, ...evaluate(candidate, resources) }))
      .filter((candidate) => candidate.missing !== "" || candidate.affordable);

    const affordable = scored
      .filter((candidate) => candidate.affordable)
      .sort((a, b) => b.weight - a.weight)[0];

    const nearest = scored
      .filter((candidate) => !candidate.affordable && candidate.progress > 0)
      .sort((a, b) => b.progress + b.weight / 100 - (a.progress + a.weight / 100))[0];

    const now = affordable
      ? `NOW: ${affordable.kind} ${labelOf(affordable.meta)} — affordable`
      : "NOW: nothing affordable yet";
    const next = nearest
      ? `NEXT: ${nearest.kind} ${labelOf(nearest.meta)} — need ${nearest.missing}`
      : "NEXT: keep gathering; new options will unlock";
    return { now, next };
  };

  let nowLine;
  let nextLine;
  const updateAdvisor = () => {
    if (!nowLine || !nextLine) return;
    try {
      const advice = getAdvice();
      nowLine.textContent = advice.now;
      nextLine.textContent = advice.next;
    } catch (error) {
      nowLine.textContent = "Advisor unavailable (game still loading?)";
      nextLine.textContent = "";
    }
  };

  /* ------------------------------- the panel -------------------------------- */

  const buildPanel = () => {
    const box = document.createElement("div");
    box.style.cssText =
      "position:fixed;right:12px;bottom:12px;z-index:99999;max-width:320px;padding:9px 10px;" +
      "background:#2b2118;color:#f7ead0;border:1px solid #9b7a4d;border-radius:5px;" +
      "font:12px/1.4 sans-serif;display:grid;gap:6px;box-shadow:0 2px 10px #0009";
    box.innerHTML = [
      '<strong style="font-size:13px">🐱 Kittens Helper</strong>',
      '<div style="display:flex;gap:6px"><select style="flex:1" aria-label="profile">',
      '<option value="autopilot">Autopilot: play forward</option>',
      '<option value="assist">Assist: jobs + advice</option>',
      "</select>",
      '<button type="button" style="cursor:pointer">Apply</button></div>',
      '<small class="kgh-note" style="opacity:.85"></small>',
      '<small class="kgh-now" style="color:#bfe6a0">…</small>',
      '<small class="kgh-next" style="color:#e6d79a"></small>',
      '<small style="opacity:.7">Resets stay OFF. Back up your save (Options → Export) before turning resets on in KS.</small>',
    ].join("");

    const select = box.querySelector("select");
    const button = box.querySelector("button");
    const note = box.querySelector(".kgh-note");
    nowLine = box.querySelector(".kgh-now");
    nextLine = box.querySelector(".kgh-next");

    const syncNote = () => {
      note.textContent = PROFILE_INFO[select.value].note;
      updateAdvisor();
    };

    select.value = getProfileName();
    select.addEventListener("change", syncNote);
    button.addEventListener("click", () => applyProfile(select.value));

    document.body.appendChild(box);
    syncNote();
    setInterval(updateAdvisor, 5000);
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
      // ~10s in, if KS still isn't here the pinned @require may have failed —
      // try the official loader as a backup.
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
