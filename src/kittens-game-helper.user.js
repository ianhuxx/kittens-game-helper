// ==UserScript==
// @name         Kittens Game Helper
// @namespace    https://github.com/ianhuxx/kittens-game-helper
// @version      2.20.6
// @description  Self-contained one-click autopilot for Kittens Game — no external library. It reads and drives the game's own API (window.gamePage) directly: it picks a plan, RESERVES the resources that plan needs so cheaper buys can't eat them, buys the plan the moment it's affordable via the game's own button controllers, and spends only true surplus on everything else. One universal decision framework — every candidate (building, research, workshop/religion upgrade, space program, time structure) is scored by what its parsed game-metadata effects are worth to the CURRENT economy (production vs scarcity, storage vs live pressure, unlocks, goal alignment) minus how long it takes to afford; no per-item keyword lists. Handles crafting, overflow conversion, converter pausing, trade, diplomacy/explorers/embassies, religion praise + upgrades, the ziggurat/unicorn economy (pastures vs ziggurat upgrades vs building more ziggurats, with bounded unicorn→tears sacrifices), festivals, star events, lookahead-aware job rebalancing, leader election, gold-overflow promotions and hunting — all natively, as a single source of truth with one tick loop and no settings races. Irreversible prestige actions (reset/transcend/shatter/time-skip/alicorn sacrifice) are filtered out of every candidate and trade list, so they can never fire; the only sacrifice the helper ever performs is the bounded unicorn→tears conversion that funds the ziggurat upgrade its unicorn planner picked.
// @author       ianhuxx
// @match        https://kittensgame.com/web/*
// @match        https://kittensgame.com/beta/*
// @match        https://kittensgame.com/alpha/*
// @match        https://*.kittensgame.com/*
// @match        http://bloodrizer.ru/games/kittens/*
// @run-at       document-idle
// @grant        none
// @updateURL    https://raw.githubusercontent.com/ianhuxx/kittens-game-helper/main/src/kittens-game-helper.user.js
// @downloadURL  https://raw.githubusercontent.com/ianhuxx/kittens-game-helper/main/src/kittens-game-helper.user.js
// @supportURL   https://github.com/ianhuxx/kittens-game-helper/issues
// ==/UserScript==

/*
 * Kittens Game Helper — a self-contained autopilot that drives the game's own
 * API directly (no Kitten Scientists, no third-party engine to fight).
 * On every page load it:
 *   1. waits for the game (window.gamePage.resPool + bld),
 *   2. runs ONE tick loop that plans, reserves, buys, crafts, trades, manages
 *      jobs/leader/hunting/religion/festivals and claims star events — every
 *      spender consulting the same reservation so they never undercut the plan,
 *   3. keeps irreversible actions out of every candidate/trade list (isDeniedKey),
 *   4. shows a panel: bottleneck, next science, plan, and a live action log.
 */

(function kittensGameHelper() {
  "use strict";

  const STORAGE_KEY = "kgh.autopilot";
  const LOG_KEY = "kgh.log";
  const PRESTIGE_ARM_KEY = "kgh.prestigeArmed";
  const HELPER_VERSION = "2.20.6";

  // Speedrun helpers are advisory and scoring nudges only: the helper still
  // never clicks reset/transcend/sacrifice/time-skip actions.
  const SPEEDRUN_STATE_PREFIX = "kgh.speedrun.";
  const SPEEDRUN_RUN_START_KEY = SPEEDRUN_STATE_PREFIX + "runStart";
  const SPEEDRUN_PEAK_KITTENS_KEY = SPEEDRUN_STATE_PREFIX + "peakKittens";
  const SPEEDRUN_LAST_RESET_COUNT_KEY = SPEEDRUN_STATE_PREFIX + "lastResetCount";
  const SPEEDRUN_PARAGON_HISTORY_KEY = SPEEDRUN_STATE_PREFIX + "paragonHistory";
  const SPEEDRUN_LAST_RESTART_LOG_KEY = SPEEDRUN_STATE_PREFIX + "lastRestartLog";
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
  // NOTE: "sacrifice" staying on this list means a sacrifice BUTTON can never
  // become a plan/candidate target. The unicorn planner's bounded unicorn→tears
  // conversion (manageUnicornReligion) is a separate subsystem, like hunting or
  // praise: it only converts the measured tears deficit of the ziggurat upgrade
  // it has chosen, at the game's live exchange rate, and never touches alicorns
  // (alicorn sacrifice feeds time crystals / shatter and stays fully denied).
  const DENY_SUBSTRINGS = ["reset", "transcend", "sacrifice", "shatter", "timeskip"];
  const DENY_EXACT = new Set([
    "adore",
    // Policy purchases flow ONLY through autoPolicyChoice (non-exclusive on
    // sight, exclusive groups by ranked best side) — never through generic
    // candidate lists, so any raw button/key named "policies" stays denied.
    "policies",
  ]);
  const ACTION_POLICY = Object.freeze({
    SAFE_REPEATABLE: "safe-repeatable",
    RARE_CAPITAL: "rare-capital",
    AUTHORIZED_PRESTIGE: "authorized-prestige",
    FORBIDDEN: "forbidden",
  });
  const ACTION_IDS = new Map([
    ["transcend", ACTION_POLICY.AUTHORIZED_PRESTIGE],
    ["adore", ACTION_POLICY.AUTHORIZED_PRESTIGE],
    ["sacrificeAlicorns", ACTION_POLICY.RARE_CAPITAL],
    ["resetWorld", ACTION_POLICY.FORBIDDEN],
    ["shatter", ACTION_POLICY.FORBIDDEN],
    ["timeSkip", ACTION_POLICY.FORBIDDEN],
  ]);
  const SAFE_CANDIDATE_KINDS = new Set([
    "build", "research", "upgrade", "religion", "ziggurat",
    "transcendence", "space", "time", "policy", "stage",
  ]);
  const SAFE_ACTION_NAME = /^[A-Za-z0-9_.-]+$/;
  const IRREVERSIBLE_ACTION_COOLDOWN_MS = 30000;
  let lastIrreversibleActionAt = 0;

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Autopilot is the only mode — on by default; the header toggle is a label for
  // the current state. Resets always stay off regardless (see isDeniedKey).
  const isAutopilotOn = () => {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored !== "0";
  };

  let syncPrestigeArmControl = () => {};
  const prestigeAutomationArmed = () => localStorage.getItem(PRESTIGE_ARM_KEY) === "1";
  const setPrestigeAutomationArmed = (value) => {
    const armed = value === true;
    try {
      localStorage.setItem(PRESTIGE_ARM_KEY, armed ? "1" : "0");
    } catch (error) {
      return false;
    }
    invalidatePlannerState();
    syncPrestigeArmControl();
    return prestigeAutomationArmed();
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

  const actionPolicyFor = (actionId) => {
    if (typeof actionId !== "string" || !actionId) return ACTION_POLICY.FORBIDDEN;
    if (ACTION_IDS.has(actionId)) return ACTION_IDS.get(actionId);
    if (actionId === "praise" || actionId === "sacrificeUnicorns") return ACTION_POLICY.SAFE_REPEATABLE;
    const candidate = /^candidate:([^:]+):([^:]+)$/.exec(actionId);
    if (candidate && SAFE_CANDIDATE_KINDS.has(candidate[1]) && SAFE_ACTION_NAME.test(candidate[2])) {
      return ACTION_POLICY.SAFE_REPEATABLE;
    }
    const repeatable = /^(craft|trade|explore|embassy):([^:]+)$/.exec(actionId);
    if (repeatable && SAFE_ACTION_NAME.test(repeatable[2])) return ACTION_POLICY.SAFE_REPEATABLE;
    return ACTION_POLICY.FORBIDDEN;
  };

  const executeSemanticAction = ({ id, policy, invoke, snapshot, verify } = {}) => {
    const resolvedPolicy = actionPolicyFor(id);
    const result = { ok: false, reason: "", before: null, after: null };
    if (resolvedPolicy === ACTION_POLICY.FORBIDDEN) {
      result.reason = ACTION_IDS.has(id) ? "action forbidden" : "unknown action";
      return result;
    }
    if (policy != null && policy !== resolvedPolicy) {
      result.reason = "action policy mismatch";
      return result;
    }
    if (typeof invoke !== "function") {
      result.reason = "missing action invoker";
      return result;
    }
    const irreversible = resolvedPolicy === ACTION_POLICY.RARE_CAPITAL || resolvedPolicy === ACTION_POLICY.AUTHORIZED_PRESTIGE;
    if (irreversible && !prestigeAutomationArmed()) {
      result.reason = "prestige automation is not armed";
      return result;
    }
    const now = Date.now();
    if (irreversible && lastIrreversibleActionAt && now - lastIrreversibleActionAt < IRREVERSIBLE_ACTION_COOLDOWN_MS) {
      result.reason = "irreversible action cooldown";
      return result;
    }
    if (irreversible) lastIrreversibleActionAt = now;
    try {
      if (typeof snapshot === "function") result.before = snapshot();
      invoke();
      if (typeof snapshot === "function") result.after = snapshot();
      if (typeof verify === "function" && !verify(result.before, result.after)) {
        result.reason = "postcondition failed";
        return result;
      }
    } catch (error) {
      result.reason = `action invocation failed: ${error && error.message ? error.message : String(error)}`;
      return result;
    }
    result.ok = true;
    result.reason = "executed";
    return result;
  };

  // Praise the Sun converts the whole faith bank into worship, so we only do it
  // when faith is near its storage cap and no faith-priced upgrade is pending.
  const RELIGION_PRAISE_TRIGGER = 0.95;

  // The helper drives the game's own API directly — there is no external engine
  // to configure, enable or fight. "Applying" the profile kicks an immediate
  // tick without weakening the game's global confirmation setting.
  // Irreversible actions
  // (reset/transcend/sacrifice/shatter/timeskip) never enter any candidate or
  // trade list — isDeniedKey() filters them out — so they can never fire.
  const applyProfile = () => {
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

  // Metaphysics perks live in the PRESTIGE manager, never in science.
  // science.get(perkName) both misreads them — the "engineering" TECH made the
  // unowned Engineering perk look researched, skipping it in the advisor — and
  // console.errors "Failed to get tech for tech name 'goldenRatio'" on every
  // advisor tick, flooding the browser console. Scan prestige.perks directly
  // (a pure read that can never log); getPerk is only a fallback shape.
  const metaphysicsResearched = (name) => {
    try {
      const prestige = window.gamePage.prestige;
      if (!prestige) return false;
      if (Array.isArray(prestige.perks)) {
        const perk = prestige.perks.find((item) => item && item.name === name);
        return !!(perk && (perk.researched || perk.owned || perk.on));
      }
      const perk = typeof prestige.getPerk === "function" ? prestige.getPerk(name) : null;
      return !!(perk && (perk.researched || perk.owned || perk.on));
    } catch (error) {
      return false;
    }
  };

  const currentParagon = () => {
    try { return window.gamePage.paragonPoints || 0; } catch (error) { return 0; }
  };

  // `totalResets` is absent or stale at zero in some imported/older saves.
  // Earned paragon and cumulative karma-kittens are irreversible evidence that
  // at least one reset already happened, so first-run planning must honor them.
  const hasPriorReset = () => {
    try {
      const game = window.gamePage;
      return (game.totalResets || 0) > 0 || (game.paragonPoints || 0) > 0 || (game.karmaKittens || 0) > 0;
    } catch (error) {
      return false;
    }
  };

  // Karma gained on reset is NOT linear in kittens (the old `kittens - 35`
  // estimate overstated it ~8×). The game banks "karma kittens" in tiers — a
  // run of N kittens contributes (N-35) + (N-60)·3 + (N-100)·4 … — then converts
  // the RUNNING cumulative total through a diminishing-returns root:
  //   karma = (√(1 + 8·kk/5) − 1) / 2.
  // So 100 kittens bank 65 + 40·3 = 185 kk → ≈8 karma, not 65; at 60 kittens
  // it's 25 kk → ≈2.7 karma, not 25. We read the live cumulative `karmaKittens`
  // so the figure shown is the MARGINAL karma this reset would actually add
  // (golden rule #4 — read the rate live, never bake in a base number). Only the
  // ≤100 tiers are encoded; the advisor only surfaces karma below 70 kittens,
  // where higher tiers never apply.
  const KARMA_KITTEN_TIERS = [
    { over: 35, mult: 1 },
    { over: 60, mult: 3 },
    { over: 100, mult: 4 },
  ];
  const karmaKittensForRun = (kittens) => {
    let kk = 0;
    for (const tier of KARMA_KITTEN_TIERS) {
      if (kittens > tier.over) kk += (kittens - tier.over) * tier.mult;
    }
    return kk;
  };
  const karmaScoreFor = (karmaKittens) => (karmaKittens > 0 ? (Math.sqrt(1 + (8 * karmaKittens) / 5) - 1) / 2 : 0);
  const expectedResetKarma = (kittens) => {
    const runKk = karmaKittensForRun(kittens);
    if (runKk <= 0) return 0;
    let banked = 0;
    try { banked = window.gamePage.karmaKittens || 0; } catch (error) { /* fresh save / no prior karma */ }
    return Math.max(0, karmaScoreFor(banked + runKk) - karmaScoreFor(banked));
  };

  let resetAdvisorText = "♻ Reset advisor: tracking this run…";
  // Structured advisor state for the panel card: an explicit verdict the player
  // can read at a glance (the old single line buried WHEN a reset pays off).
  // tone: "wait" (too early), "target" (milestone set), "ok" (keep pushing),
  // "go" (reset is beneficial now). The reset itself stays advisory-only.
  let resetAdvisorState = { tone: "wait", headline: "Reset advisor: tracking this run…", detail: "" };

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
        const lastRestartLog = readJson(SPEEDRUN_LAST_RESTART_LOG_KEY, 0);
        if (now - lastRestartLog > 60000) {
          writeJson(SPEEDRUN_LAST_RESTART_LOG_KEY, now);
          pushLog("🔄 new run detected — reset advisor restarted tracking");
        }
      }

      peakKittens = Math.max(peakKittens, kittens);
      writeJson(SPEEDRUN_RUN_START_KEY, runStart);
      writeJson(SPEEDRUN_PEAK_KITTENS_KEY, peakKittens);

      const runDays = Math.max(0.01, (now - runStart) / 86400000);
      const expectedParagon = Math.max(0, kittens - 70);
      const expectedKarma = expectedResetKarma(kittens);
      const paragonPerDay = expectedParagon / runDays;
      // Math Hacks: a reset banks (kittens − 70) paragon, so the fraction of the
      // run's kittens that actually convert to paragon is (kittens − 70)/kittens.
      // It rises steeply early and flattens hard later (500 vs 1000 kittens is
      // only ~7%), which is exactly why the guide says reset once you can no
      // longer keep up with arrivals rather than chasing the last few percent.
      const paragonEfficiency = kittens > 70 ? (kittens - 70) / kittens : 0;
      const effText = kittens >= 70 ? ` · ${Math.round(paragonEfficiency * 100)}% paragon-eff` : "";
      const nextMeta = METAPHYSICS_ORDER.find((item) => !metaphysicsResearched(item.name));
      const metaText = nextMeta
        ? ` · next meta: ${nextMeta.label} (${nextMeta.cost}P${paragon >= nextMeta.cost ? ", affordable" : ""})`
        : " · core metaphysics plan complete";
      // Monstrous Advice / Sagefault: the first reset wants Concrete Huts + 130+
      // kittens (≈60 paragon), enough to buy Diplomacy and the first price-ratio
      // metas — the foundation every later run compounds on. Only surface this
      // before the very first reset; afterward fall back to the paragon/day read.
      // The verdict is explicit: WAIT (a reset now banks ~nothing), TARGET (a
      // concrete milestone with a live progress count), OK (healthy pace, keep
      // pushing) or GO (paragon/day has flattened — resetting now compounds
      // faster than continuing this run).
      const bank = `reset now banks +${fmt(expectedParagon)} paragon, +${fmt(expectedKarma)} karma`;
      if (kittens < 35) {
        resetAdvisorState = {
          tone: "wait",
          headline: `Do NOT reset — nothing is banked below 35 kittens (${kittens}/35)`,
          detail: `karma starts at 35 kittens, paragon at 70 · ${bank}`,
        };
      } else if (kittens < 70) {
        resetAdvisorState = {
          tone: "wait",
          headline: `Too early — +${fmt(expectedKarma)} karma if reset now, but paragon needs 70+ kittens (${kittens}/70)`,
          detail: `${bank} · every kitten past 70 adds +1 paragon`,
        };
      } else if (!hasPriorReset() && kittens < 130) {
        resetAdvisorState = {
          tone: "target",
          headline: `First reset target: 130+ kittens with Concrete Huts (${kittens}/130)`,
          detail: `${bank} · at 130+ (~60P) the next run affords Diplomacy + the first price-ratio metaphysics`,
        };
      } else if (paragonPerDay < RESET_ADVISOR_MIN_PARAGON_PER_DAY) {
        resetAdvisorState = {
          tone: "go",
          headline: `Reset is beneficial NOW — this run has flattened (${fmt(paragonPerDay)} P/day)`,
          detail: `${bank} · kitten arrivals no longer keep up, so banking and restarting compounds faster · reset manually via Time Control after exporting a backup`,
        };
      } else {
        resetAdvisorState = {
          tone: "ok",
          headline: `Keep pushing — healthy pace (${fmt(paragonPerDay)} P/day)`,
          detail: `${bank} · reset when arrivals stop keeping up (advisor flips when P/day drops below ${fmt(RESET_ADVISOR_MIN_PARAGON_PER_DAY)})`,
        };
      }
      resetAdvisorState.detail += metaText;
      resetAdvisorText = `♻ Reset: ${kittens} kittens · ${fmt(expectedParagon)}P now${effText} · ${fmt(paragonPerDay)}P/day · ${resetAdvisorState.headline}${metaText}`;
    } catch (error) {
      resetAdvisorText = "♻ Reset advisor: unavailable";
      resetAdvisorState = { tone: "wait", headline: "Reset advisor: unavailable", detail: "" };
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

  // Kittens Game keeps a stable raw building id in `buildingsData`, then overlays
  // the active stage through BuildingMeta.getMeta().  Planner identity must stay
  // raw (controllers buy by that id), while every read must use the same active
  // label/effects/prices the player sees.
  const rawBuildingFor = (meta) => {
    if (!meta) return null;
    try {
      return buildingMetas().find((building) => building === meta || (building && building.name === meta.name)) || null;
    } catch (error) {
      return null;
    }
  };

  const liveMetaView = (meta, stageOverride = null) => {
    const raw = rawBuildingFor(meta);
    if (!raw) return meta;
    refreshMetaEffects(raw);
    if (!Array.isArray(raw.stages) || !raw.stages.length) return raw;
    const requested = stageOverride == null ? Number(raw.stage) || 0 : Number(stageOverride) || 0;
    const stage = Math.max(0, Math.min(raw.stages.length - 1, requested));
    return { ...raw, ...(raw.stages[stage] || {}), stage };
  };

  // Space programs (one-time planet-unlock missions, e.g. orbitalLaunch) and
  // Chronoforge/Void structures are stackable buildings of the SAME controller
  // family as bonfire buildings, so the planner treats them as extra
  // "build"-style candidates (kinds "space"/"time"). This is what lets the
  // reservation-backed planner finally cover the late game. Enumerated
  // defensively — these managers are empty until the relevant tech unlocks them.
  //
  // Space ALSO has a second, separate structure: each reached planet
  // (`space.planets[]`) carries its own `buildings[]` array — the actual Cath
  // "Satellite" (internal name `sattelite`), Space Elevator, Space Station,
  // etc. These are stackable buildings too (val/on/priceRatio), but they are
  // NOT in `space.programs` — a candidate scanner that only reads `programs`
  // silently never sees them. Both lists feed the same "space" candidate kind;
  // `isSpacePlanetBuilding` tells purchase/pricing which controller family a
  // given meta belongs to (missions vs planet buildings use different game
  // controllers — see `controllerSpecFor` / `spacePricesFor`).
  const spaceProgramMetas = () => {
    try {
      const space = window.gamePage && window.gamePage.space;
      return Array.isArray(space && space.programs) ? space.programs : [];
    } catch (error) {
      return [];
    }
  };

  const spacePlanetBuildingMetas = () => {
    const out = [];
    try {
      const space = window.gamePage && window.gamePage.space;
      const planets = Array.isArray(space && space.planets) ? space.planets : [];
      for (const planet of planets) {
        if (Array.isArray(planet && planet.buildings)) out.push(...planet.buildings);
      }
    } catch (error) {
      /* ignore */
    }
    return out;
  };

  const spaceMetas = () => [...spaceProgramMetas(), ...spacePlanetBuildingMetas()];

  const isSpacePlanetBuilding = (meta) => spacePlanetBuildingMetas().includes(meta);

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
  const VAL_BASED_KINDS = new Set(["build", "space", "time", "ziggurat"]);

  // Space/time candidate is open while unlocked and (for one-time missions) not
  // already built; stackable structures stay open.
  const spaceTimeOpen = (meta) =>
    meta && meta.unlocked !== false && meta.researched !== true && !(meta.noStackable && (meta.on || meta.val || 0) >= 1);

  // Space missions and planet buildings scale price differently in the live
  // game (missions: flat priceRatio^val; planet buildings: priceRatio^val with
  // a special 1.05 oil ratio, PLUS live *CostReduction effects), so read the
  // real controller's getPrices when available instead of re-deriving the
  // formula — same reasoning as `religionUpgradePrices`. Falls back to the
  // naive scaled formula (also what the test harness, which has no dojo
  // controllers, exercises).
  const spacePricesFor = (meta) => {
    try {
      const game = window.gamePage;
      const Controller = getGlobalPath(
        isSpacePlanetBuilding(meta)
          ? ["classes", "ui", "space", "PlanetBuildingBtnController"]
          : ["com", "nuclearunicorn", "game", "ui", "SpaceProgramBtnController"],
      );
      if (typeof Controller === "function") {
        const controller = new Controller(game);
        const model = controller.fetchModel({ id: meta.name, controller });
        if (model && typeof controller.getPrices === "function") {
          const live = controller.getPrices(model);
          if (Array.isArray(live) && live.length) return live;
        }
      }
    } catch (error) {
      /* fall through to the scaled fallback */
    }
    return scaledStackablePrices(meta);
  };

  const pricesFor = (kind, meta) => {
    try {
      if (kind === "bootstrap" || kind === "festival" || kind === "stage") return meta.prices || [];
      if (kind === "build" && window.gamePage.bld.getPrices) {
        const livePrices = window.gamePage.bld.getPrices(meta.name);
        return Array.isArray(livePrices) && livePrices.length ? livePrices : meta.prices || [];
      }
      if (kind === "space") return spacePricesFor(meta);
      if (kind === "time") return scaledStackablePrices(meta);
      if ((kind === "research" || kind === "policy") && window.gamePage.science.getPrices) {
        return window.gamePage.science.getPrices(meta) || meta.prices || [];
      }
      if (kind === "upgrade" && window.gamePage.workshop) {
        const workshop = window.gamePage.workshop;
        if (typeof workshop.getPrices === "function") return workshop.getPrices(meta) || meta.prices || [];
        if (typeof workshop.getPrice === "function") return workshop.getPrice(meta) || meta.prices || [];
      }
      if (kind === "religion") return religionUpgradePrices(meta);
      if (kind === "ziggurat") return zigguratUpgradePrices(meta);
    } catch (error) {
      /* ignore */
    }
    return meta.prices || meta.price || [];
  };

  const isOpen = (meta) => meta && meta.unlocked !== false && meta.researched !== true;
  const labelOf = (meta) => {
    const live = liveMetaView(meta) || meta;
    return (live && (live.label || live.title || live.name)) || "?";
  };

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
      const possible = have + craftablePotential(cost.name) + sacrificePotentialFor(resources, cost.name);
      progress = Math.min(progress, possible / cost.val);
      if (have < cost.val) {
        affordable = false;
        const cap = liveCapFor(resources, cost.name);
        // A capped bank below the price is a storage problem even when the
        // resource is craftable — crafting cannot fill past the cap.
        const storageHint = res && cap > 0 && cost.val > cap
          ? ` (storage cap ${fmt(cap)})`
          : "";
        const craftHint = !storageHint && craftByName(cost.name) ? ` (craft ${craftLabel(cost.name)})` : "";
        const sacrificeHint = !storageHint && !craftHint && sacrificeConversionFor(cost.name) ? " (sacrifice unicorns)" : "";
        missing.push(`${fmt(cost.val - have)} ${(res && res.title) || cost.name}${storageHint || craftHint || sacrificeHint}`);
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

  /* --------------------- ziggurat upgrades / unicorn tears --------------------
   * The Ziggurat branch of the Religion tab (Unicorn Tomb, Ivory Tower, …) is a
   * separate candidate kind ("ziggurat"): stackable, val-based, priced in tears/
   * ivory/gold/megaliths and bought through the game's ZigguratBtnController.
   * Tears have NO production or craft path — they only come from the bounded
   * unicorn→tears sacrifice — so everything that reasons about reachability,
   * ETA or reservations for a tears cost goes through sacrificeConversionFor,
   * which reads the live exchange rate (batch size from the game's own button
   * model when available, one tear per ziggurat per batch from the live count).
   */
  const zigguratUpgrades = () => {
    try {
      const religion = window.gamePage && window.gamePage.religion;
      return Array.isArray(religion && religion.zigguratUpgrades) ? religion.zigguratUpgrades : [];
    } catch (error) {
      return [];
    }
  };

  const zigguratCount = () => {
    const meta = buildingByName("ziggurat");
    return (meta && meta.val) || 0;
  };

  // A ziggurat upgrade is workable once its metadata is unlocked AND at least
  // one Ziggurat stands (no ziggurat → no tears → nothing to plan with).
  const zigguratUpgradeVisible = (meta) => !!meta && meta.unlocked !== false && zigguratCount() >= 1;

  const zigguratUpgradePrices = (meta) => {
    try {
      const game = window.gamePage;
      const Controller = getGlobalPath(["com", "nuclearunicorn", "game", "ui", "ZigguratBtnController"]);
      if (game && typeof Controller === "function") {
        const controller = new Controller(game);
        const model = controller.fetchModel({ id: meta.name, controller });
        if (model && typeof controller.getPrices === "function") {
          const live = controller.getPrices(model);
          if (Array.isArray(live) && live.length) return live;
        }
      }
    } catch (error) {
      /* fall through to the scaled fallback */
    }
    return scaledStackablePrices(meta);
  };

  // Base batch size of the game's "Sacrifice Unicorns" ritual; the live button
  // model's price overrides this whenever the Religion tab has been rendered.
  const UNICORNS_PER_SACRIFICE = 2500;

  const sacrificeUnicornsButton = () => {
    try {
      const tab = window.gamePage && window.gamePage.religionTab;
      return (tab && tab.sacrificeBtn) || null;
    } catch (error) {
      return null;
    }
  };

  // The live unicorn→tears exchange: `inputPerChunk` unicorns buy `gainPerChunk`
  // tears per batch (the game grants one tear per ziggurat per batch). Returns
  // null for every resource except tears, and while no ziggurat stands.
  const sacrificeConversionFor = (name) => {
    if (name !== "tears") return null;
    const gainPerChunk = zigguratCount();
    if (!(gainPerChunk >= 1)) return null;
    let inputPerChunk = UNICORNS_PER_SACRIFICE;
    try {
      const btn = sacrificeUnicornsButton();
      const prices = btn && btn.model && btn.model.prices;
      const unicornPrice = Array.isArray(prices) && prices.find((price) => price && price.name === "unicorns" && price.val > 0);
      if (unicornPrice) inputPerChunk = unicornPrice.val;
    } catch (error) {
      /* keep the base batch size */
    }
    return { inputName: "unicorns", inputPerChunk, gainPerChunk };
  };

  // Tears obtainable RIGHT NOW from the banked unicorns (whole batches only).
  const sacrificePotentialFor = (resources, name) => {
    const conversion = sacrificeConversionFor(name);
    if (!conversion) return 0;
    const bank = ((getRes(resources, conversion.inputName) || {}).value) || 0;
    return Math.floor(Math.max(0, bank) / conversion.inputPerChunk) * conversion.gainPerChunk;
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
      // Only expand the craft chain for components that are still genuinely
      // missing after netting current inventory.  An oversupplied craftable
      // direct cost (Magneto gear/blueprint, for example) must not make its
      // whole upstream chain look like active-plan work.
      if (have >= cost.val) continue;
      craftChainOutputsFor(cost.name, allowed);
    }
    return allowed;
  };

  const craftOutputHelpsTarget = (target, outputName, resources) => {
    if (!target || !outputName) return false;
    return targetCraftOutputsFor(target, resources).has(outputName);
  };

  const directTargetCostFor = (target, name) => pricesFor(target.kind, target.meta)
    .find((cost) => cost && cost.name === name && isFinite(cost.val) && cost.val > 0);

  const oversuppliedForTarget = (target, resources, name) => {
    const cost = target && directTargetCostFor(target, name);
    return !!(cost && resValueOf(resources || resourceMap(), name) >= cost.val * 1.05);
  };

  const doesCraftAdvanceActivePlan = (target, resources, outputName) => {
    if (!target || !outputName) return false;
    if (oversuppliedForTarget(target, resources, outputName)) return false;
    return targetNeedsResource(target, outputName) || craftOutputHelpsTarget(target, outputName, resources);
  };


  let stickyTargetChainReserve = { until: 0, names: new Set(), label: "" };

  const activeTargetChainResources = (target, resources) => {
    const names = new Set();
    if (!target || target.affordable) return names;
    const ledger = buildTargetLedger(target, resources || resourceMap());
    for (const name of ledger.critical) names.add(name);
    return names;
  };

  // When the science-storage-unlock layer is in play (we're growing the science
  // cap so a blocked tech like Biology can fit), ALSO reserve the blocked
  // tech's crafted-chain resources (compendium / manuscript / parchment / furs).
  // Without this, the active target is Library/Academy whose own chain is
  // wood/beam — so the overflow crafter cheerfully melts the player's hard-won
  // compendium stock into blueprint while we wait for the cap to grow.  The
  // research-sprint layer already protects them directly (its target IS the
  // blocked tech), so this only adds protection during the storage-unlock layer.
  const blockedTechChainAdditions = (resources) => {
    const decision = lastStrategicDecision;
    if (!decision || decision.layer !== STRATEGIC_LAYERS.scienceStorageUnlock) return null;
    const blocker = decision.scienceStorageBlocker;
    const blocked = blocker && blocker.blocked;
    if (!blocked) return null;
    return activeTargetChainResources(blocked, resources);
  };

  const refreshStickyTargetChainReserve = (target, resources) => {
    const names = activeTargetChainResources(target, resources);
    const blockedExtras = blockedTechChainAdditions(resources);
    if (blockedExtras) for (const name of blockedExtras) names.add(name);
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

  let festivalPlanText = "Festival: waiting for Drama & Poetry";

  const festivalPrices = () => {
    try {
      const button = window.gamePage && window.gamePage.villageTab && window.gamePage.villageTab.festivalBtn;
      const model = button && button.model;
      const prices = model && (model.prices || (model.controller && model.controller.getPrices && model.controller.getPrices(model)));
      if (Array.isArray(prices) && prices.length) return prices.map((price) => ({ name: price.name, val: price.val }));
    } catch (error) {
      /* use the canonical live game price */
    }
    return FESTIVAL_COST.map((price) => ({ ...price }));
  };

  const festivalCanPay = (target = null, resources = resourceMap()) => {
    const prices = festivalPrices();
    if (!prices.every((cost) => resValueOf(resources, cost.name) >= cost.val)) return false;
    // A festival the PLANNER picked owns its bill; a side refresh must respect
    // both the active plan's ledger and the culture the pending exclusive
    // policy pick is saving toward (pendingPolicyReservationLedger).
    if (!target || target.kind === "festival") return true;
    const ledger = buildTargetLedger(target, resources);
    const reserved = { ...ledger.reserved };
    for (const [name, amount] of Object.entries(pendingPolicyReservationLedger(resources).reserved)) {
      reserved[name] = Math.max(reserved[name] || 0, amount);
    }
    return !targetLockViolationForPrices(prices, ledger, resources) && pricesRespectReservations(prices, reserved, resources);
  };

  const festivalOpportunity = (resources = resourceMap()) => {
    try {
      const game = window.gamePage;
      const village = game && game.village;
      const calendar = game && game.calendar;
      const drama = game && game.science && game.science.get && game.science.get("drama");
      if (!drama || !drama.researched || !village || !calendar) {
        festivalPlanText = "Festival: locked until Drama & Poetry";
        return { candidate: null, layer: STRATEGIC_LAYERS.festival, status: festivalPlanText };
      }
      const buffer = calendar.daysPerSeason || 100;
      const remaining = Math.max(0, calendar.festivalDays || 0);
      if (remaining > buffer) {
        festivalPlanText = `Festival: active — ${fmt(remaining)} days remaining`;
        return { candidate: null, layer: STRATEGIC_LAYERS.festival, active: true, remaining, status: festivalPlanText };
      }
      const max = village.maxKittens || (village.sim && village.sim.maxKittens) || 0;
      const freeBeds = Math.max(0, max - villageKittens());
      const happiness = currentHappinessRatio();
      const happinessGain = 0.3 * (1 + Math.max(0, (game.getEffect && game.getEffect("festivalRatio")) || 0));
      const useful = freeBeds > 0 || happiness < 1.3;
      const meta = { name: "festival", label: "Festival", prices: festivalPrices(), effects: { happiness: happinessGain } };
      const candidate = { kind: "festival", weight: 5, meta, ...evaluate("festival", meta, resources) };
      const eta = waitSecondsForCandidate(candidate, resources);
      const benefit = Math.max(0, 1.3 - happiness) * 30 + Math.min(20, freeBeds * 2) + happinessGain * 20;
      candidate.score = benefit - (isFinite(eta) ? Math.log10(eta + 1) * 4 : 30);
      if (!useful || candidate.score <= 0) {
        festivalPlanText = `Festival: deferred — ${!useful ? "no housing/happiness payoff" : `payback too slow (${formatEta(eta)})`}`;
        return { candidate: null, layer: STRATEGIC_LAYERS.festival, eta, benefit, status: festivalPlanText };
      }
      const missing = meta.prices.filter((cost) => resValueOf(resources, cost.name) < cost.val)
        .map((cost) => `${fmt(cost.val - resValueOf(resources, cost.name))} ${resTitle(resources, cost.name)}`);
      festivalPlanText = candidate.affordable ? "Festival: ready — happiness and kitten arrivals" : `Festival: saving — ${missing.slice(0, 3).join(", ")}`;
      return { candidate, layer: STRATEGIC_LAYERS.festival, eta, benefit, freeBeds, happiness, status: festivalPlanText };
    } catch (error) {
      festivalPlanText = "Festival: unavailable";
      return { candidate: null, layer: STRATEGIC_LAYERS.festival, status: festivalPlanText };
    }
  };

  const buyFestivalCandidate = () => {
    const game = window.gamePage;
    const beforeDays = (game.calendar && game.calendar.festivalDays) || 0;
    try {
      const button = game.villageTab && game.villageTab.festivalBtn;
      const model = button && button.model;
      const controller = (button && button.controller) || (model && model.controller);
      if (controller && model && typeof controller.buyItem === "function") {
        const result = controller.buyItem(model, { boughtByQueue: true });
        if ((result && result.itemBought) || ((game.calendar.festivalDays || 0) > beforeDays)) return true;
      }
    } catch (error) {
      /* use the native manager fallback */
    }
    const prices = festivalPrices();
    if (!canPayPrices(prices) || !game.village || typeof game.village.holdFestival !== "function") return false;
    game.village.holdFestival(1);
    if (game.resPool && typeof game.resPool.payPrices === "function") game.resPool.payPrices(prices);
    else for (const cost of prices) game.resPool.addResEvent(cost.name, -cost.val);
    return (game.calendar.festivalDays || 0) > beforeDays;
  };

  const maybeHoldFestival = (resources) => {
    try {
      const game = window.gamePage;
      const village = game && game.village;
      const calendar = game && game.calendar;
      if (!village || !calendar || typeof village.holdFestival !== "function") return;
      const drama = game.science && game.science.get && game.science.get("drama");
      if (!drama || !drama.researched) return;
      const target = getTargetCached(resources, getGoal());
      if (!festivalCanPay(target, resources)) {
        festivalPlanText = `Festival: deferred — resources reserved for ${target ? labelOf(target.meta) : "active plan"}`;
        return;
      }
      const buffer = calendar.daysPerSeason || 100;
      if ((calendar.festivalDays || 0) > buffer) return;
      if (buyFestivalCandidate()) {
        festivalPlanText = `Festival: active — ${fmt(calendar.festivalDays || 0)} days remaining`;
        pushLog("🎉 held a festival (happiness + birth rate up)");
      }
    } catch (error) {
      /* ignore festival failures */
    }
  };

  // --- native surplus trade scoring ------------------------------------------
  // Execution lives exclusively in manageDiplomacy; this scorer only ranks a
  // safe overflow partner after the active acquisition route has had first call.
  const tradeWantScore = (race, resources) => {
    let score = 0;
    for (const sell of (race && race.sells) || []) {
      if (!sell || !sell.name || !validRaceSell(race, sell)) continue;
      const res = getRes(resources, sell.name);
      if (!res && sell.name !== "uranium" && race.name !== "leviathans") continue;
      if (res && res.maxValue > 0 && res.value / res.maxValue > 0.95) continue; // no room — skip
      const fill = res && res.maxValue > 0 ? res.value / res.maxValue : 0.5;
      score += (1 - fill) * expectedTradeYield(race, sell);
    }
    return score;
  };

  /* ------------------------------ per-tick cache ----------------------------- */

  // Candidate gathering, target choice and storage-pressure scans are expensive
  // (storage pressure alone walks every meta) and were being recomputed by every
  // consumer each tick — sometimes disagreeing mid-tick. Compute once, share.
  let plannerCycleId = 0;
  let activePlanSnapshot = { cycleId: -1, target: undefined };

  let tickCache = {
    resources: null,
    production: Object.create(null),
    candidates: null,
    target: undefined,
    pendingPolicy: undefined,
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

  // Discrete helper actions are not production.  Restart samples for every
  // resource an action changed so a craft/trade/buy cannot become a bogus
  // negative (or positive) ticker rate on the next planner pass.
  const markTelemetryDiscontinuity = (deltas) => {
    const now = Date.now();
    for (const item of deltas || []) {
      const name = item && (item.name === "catpower" ? "manpower" : item.name);
      if (!name) continue;
      const res = getRes(resourceMap(), name);
      const entry = resourceTelemetry[name] || (resourceTelemetry[name] = { samples: [] });
      entry.discontinuityAt = now;
      entry.cap = liveResourceCap(res);
      entry.title = (res && (res.title || res.name)) || name;
      entry.samples = res && isFinite(res.value) ? [{ t: now, value: res.value, cap: entry.cap }] : [];
    }
  };

  const observedProductionFor = (name) => {
    const entry = resourceTelemetry[name === "catpower" ? "manpower" : name];
    if (!entry || entry.samples.length < 2) return null;
    const first = entry.samples[0];
    const last = entry.samples[entry.samples.length - 1];
    const span = last.t - first.t;
    if (span < RESOURCE_TELEMETRY_MIN_SPAN_MS) return null;
    // A capped resource bar is flat because production is clipped, not because
    // its ticker is zero.  Likewise, do not bridge a known discrete action.
    if (entry.samples.some((sample) => sample.cap > 0 && sample.value >= sample.cap * 0.985)) return null;
    if (entry.discontinuityAt && entry.discontinuityAt >= first.t && entry.discontinuityAt <= last.t) return null;
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
      pendingPolicy: undefined,
      pressure: null,
      producerDemand: null,
      goalFrontier: null,
      goalClosure: null,
      goalSupport: null,
      fxRefreshed: new WeakSet(),
    };
  };

  const invalidatePlannerState = () => {
    activePlanSnapshot = { cycleId: -1, target: undefined };
    activeTarget = null;
    resetTickCache();
  };

  const getCandidatesCached = (resources, goalKey) => {
    if (!tickCache.candidates) tickCache.candidates = gatherCandidates(resources, goalKey);
    return tickCache.candidates;
  };

  const getTargetCached = (resources, goalKey) => {
    if (activePlanSnapshot.cycleId === plannerCycleId && activePlanSnapshot.target !== undefined) {
      tickCache.target = activePlanSnapshot.target;
      return activePlanSnapshot.target;
    }
    if (tickCache.target === undefined) tickCache.target = chooseWorkTarget(resources, goalKey);
    activePlanSnapshot = { cycleId: plannerCycleId, target: tickCache.target };
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
    if (["minerals", "iron", "titanium"].includes(name)) return "minerals";
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

  const resourceHasDirectJobPath = (name) => {
    if (!name) return false;
    const key = name === "catpower" ? "manpower" : name;
    try {
      for (const job of managedJobs()) {
        const produced = jobResourceFor(job);
        if ((produced === "catpower" ? "manpower" : produced) === key) return true;
      }
    } catch (error) {
      /* managed jobs are advisory; fall back to craft-chain handling */
    }
    return false;
  };

  // One marginal worker's live output for a staffable resource.  Used as the
  // conservative rate floor when the resource currently reads 0/s only because
  // its job is unstaffed (all miners pulled to hunt): the job balancer WILL
  // staff it the moment a plan needs it, so it is a wait, not a dead end.
  const directJobRatePerSecondFor = (name) => {
    const key = name === "catpower" ? "manpower" : name;
    try {
      for (const job of managedJobs()) {
        const produced = jobResourceFor(job);
        if ((produced === "catpower" ? "manpower" : produced) !== key) continue;
        const rate = jobMarginalProductionPerSecond(job, key);
        if (isFinite(rate) && rate > 0) return rate;
      }
    } catch (error) {
      /* no live job signal */
    }
    return 0;
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
    if (!craft || resourceHasDirectJobPath(name)) {
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
  // `extraFloors` holds per-resource banks this craft may never dip below ON
  // TOP of the computed floors — the redirected-sprint conveyor floors the
  // plan target's direct prices with it, and the parallel-tier pass floors
  // the whole reservation ledger.
  const tryCraftResource = (name, targetAmount, depth = 0, target = null, topOutputName = name, extraFloors = null) => {
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
        tryCraftResource(price.name, neededInput, depth + 1, target, topOutputName, extraFloors); // best effort, clamp below
      }
    }

    const fresh = resourceMap();
    let units = wantUnits;
    for (const price of prices) {
      const input = getRes(fresh, price.name);
      // This craft is serving the active plan's chain, so reserve only a minimal
      // luxury cushion (forPlanChain) — the plan must not be blocked by the idle
      // happiness reserve, but the catnip starvation reserve still holds.
      let floor = target ? overflowInputFloor(target, fresh, price.name, topOutputName, true) : craftFloorFor(fresh, price.name);
      if (extraFloors && (extraFloors[price.name] || 0) > floor) floor = extraFloors[price.name];
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
    const ownedIntermediateSpend = targetOwnsIntermediateSpend(target, resources, inputName, outputName, forPlanChain);
    if (!ownedIntermediateSpend && stickyReservesResource(inputName) && inputName !== outputName && !stickyReservesResource(outputName)) return Number.MAX_SAFE_INTEGER;
    if (!target) return floor;

    const chain = refreshStickyTargetChainReserve(target, resources);
    if (!ownedIntermediateSpend && chain.has(inputName) && inputName !== outputName && !chain.has(outputName)) return Number.MAX_SAFE_INTEGER;

    // If the active target directly needs this input and is still short, no
    // lower-priority craft may consume it. This closes the Observatory trap:
    // crafting Plate for missing Scaffold must wait until the direct Iron bill
    // is already covered.
    const directInputCost = pricesFor(target.kind, target.meta).find((cost) => cost && cost.name === inputName && isFinite(cost.val) && cost.val > 0);
    if (directInputCost && inputName !== outputName) {
      const haveDirect = ((getRes(resources, inputName) || {}).value) || 0;
      if (haveDirect < directInputCost.val && !ownedIntermediateSpend) return Number.MAX_SAFE_INTEGER;
      // Direct/final costs are hard reserves. Active-plan crafting may spend the
      // surplus above that final bank, but it must not drain the final purchase
      // amount just because the same raw resource also appears in a craft chain.
      // Research is special: science/culture craft costs are rolling banks during
      // the intermediate phase (e.g. Blueprint/Compendium chains), so the phase
      // model explicitly marks shared inputs that may cycle before refilling.
      const phase = target.kind === "research" ? researchTargetPhase(target, resources) : null;
      const rollingResearchInput = phase && phase.phase === "intermediate" && phase.sharedInputs.has(inputName);
      if (!rollingResearchInput) floor = Math.max(floor, directInputCost.val);
    }

    const converterInputs = converterInputsNeededForMissingCosts(target, resources);
    if (!ownedIntermediateSpend && converterInputs.has(inputName) && inputName !== outputName) return Number.MAX_SAFE_INTEGER;

    for (const cost of pricesFor(target.kind, target.meta)) {
      if (!cost || !cost.name || !isFinite(cost.val) || cost.val <= 0) continue;
      const res = getRes(resources, cost.name);
      if (res && res.maxValue > 0 && cost.val > res.maxValue && !craftByName(cost.name)) continue;

      if (cost.name === inputName && !ownedIntermediateSpend) floor = Math.max(floor, cost.val);
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
        const helpsTarget = doesCraftAdvanceActivePlan(target, resources, name);
        const safeWoodOverflow = name === "wood" && !targetNeedsResource(target, "catnip") && wouldWasteResource(resources, "catnip");
        const safeCultureOverflow = ["parchment", "manuscript", "compedium", "blueprint"].includes(name) &&
          wouldWasteResource(resources, "culture") &&
          prices.every((price) => !((reservedNeedsFor(target, resources)[price.name] || 0) > 0 && resourceValue(resources, price.name) <= reservedNeedsFor(target, resources)[price.name]));
        if (activeReserve && !helpsTarget && !safeWoodOverflow && !safeCultureOverflow) continue;
        if (!hotInputs.length && !helpsTarget) continue;
        let maxUnits = Number.MAX_VALUE;
        for (const price of prices) {
          const input = getRes(resources, price.name);
          const value = (input && input.value) || 0;
          const reserve = overflowInputFloor(target, resources, price.name, name, helpsTarget);
          maxUnits = Math.min(maxUnits, Math.floor(Math.max(0, value - reserve) / price.val));
          if (value - reserve <= 0 && (reservedNeedsFor(target, resources)[price.name] || 0) > 0 && Date.now() - lastOverflowLog > 20000) {
            const sources = buildReservationLedger(target, resources).sources[price.name] || [];
            pushLog(`📦 Overflow skipped: ${resTitle(resources, price.name)} reserved for ${sources[0] || "active plan"}.`);
            lastOverflowLog = Date.now();
          }
        }
        if (!isFinite(maxUnits) || maxUnits < 1) continue;
        const targetBoost = doesCraftAdvanceActivePlan(target, resources, name) ? 100 : 0;
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
        const activeCraft = doesCraftAdvanceActivePlan(target, resources, best.name);
        overflowPlanText = activeCraft
          ? `Craft-before-reserve: converted capped resources into ${craftLabel(best.name)}`
          : `Overflow: converted surplus into ${craftLabel(best.name)}`;
        if (Date.now() - lastOverflowLog > 20000) {
          const hot = craftPricesFor(craftByName(best.name)).filter((price) => price && wouldWasteResource(resources, price.name));
          const capped = hot.map((price) => `${resTitle(resources, price.name)} at ${fmt(resRatio(resources, price.name) * 100)}%`).join("+");
          const advance = activeCraft ? ` for ${labelOf(target.meta)}. This is rolling craft cost, not a hard storage blocker` : "; reason overflow/capped storage";
          pushLog(`📦 ${overflowPlanText}${capped ? ` (${capped})` : ""}: ${measured.suffix}${advance}`);
          lastOverflowLog = Date.now();
        }
      }
    } catch (error) {
      /* ignore */
    }
  };

  // While a sprint pacing redirect points the plan at a producer building, the
  // sprint tech is no longer the plan target — but its chain must KEEP
  // converting the trickling bank every time it fills (culture → manuscripts →
  // compendiums).  v2.14.0 and earlier only crafted the plan target's own
  // price deficits here, so the moment the producer's manuscript bill was
  // banked every chain craft stopped, culture pinned at its cap, and the
  // sprint's "≈38m" wait never shrank (the live 62.54K-science Chemistry
  // stall).  This returns the sprint candidate whenever the redirect owns the
  // plan through a different target.
  const sprintRedirectCraftTarget = (target) => {
    if (!activeSprint || !activeSprint.candidate) return null;
    if (!lastStrategicDecision || !lastStrategicDecision.sprintRedirect) return null;
    if (target && targetId(target) === activeSprint.id) return null;
    return activeSprint.candidate;
  };

  // The plan target's DIRECT prices, as craft floors: the redirected sprint's
  // chain crafts may consume everything ABOVE the producer's own bill, so the
  // conveyor and the producer purchase advance in parallel instead of stealing
  // from each other (Chemistry's compendium crafts leave Temple's 81
  // manuscripts banked; manuscript crafts leave Amphitheatre's parchment).
  const directPriceFloors = (candidate) => {
    const floors = {};
    if (!candidate || !candidate.meta) return floors;
    for (const cost of pricesFor(candidate.kind, candidate.meta)) {
      if (!cost || !cost.name || !isFinite(cost.val) || cost.val <= 0) continue;
      floors[cost.name] = Math.max(floors[cost.name] || 0, cost.val);
    }
    return floors;
  };

  const craftTowardTarget = (resources, goalKey) => {
    try {
      const target = getTargetCached(resources, goalKey);
      const redirectTech = sprintRedirectCraftTarget(target);
      if (!target || (target.affordable && !redirectTech)) {
        craftPlanText = "Craft: no intermediate needed";
        return;
      }
      let planned = "";
      if (!target.affordable) {
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
      }
      if (redirectTech) {
        // Keep the redirected sprint's conveyor running: craft its chain from
        // everything above the plan target's own direct bill, so the trickling
        // bank (culture) is converted the moment it fills instead of wasting
        // at its cap while the producer building saves toward gold.
        const floors = directPriceFloors(target);
        for (const cost of pricesFor(redirectTech.kind, redirectTech.meta)) {
          if (!cost || !cost.name || !isFinite(cost.val) || cost.val <= 0) continue;
          const have = (getRes(resourceMap(), cost.name) || { value: 0 }).value || 0;
          if (have < cost.val && craftByName(cost.name)) {
            if (!planned) {
              planned = `Craft: ${craftLabel(cost.name)} for redirected sprint ${labelOf(redirectTech.meta)}`;
              craftPlanText = planned;
            }
            tryCraftResource(cost.name, cost.val, 0, redirectTech, cost.name, floors);
          }
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
      if (village && typeof village.getResProduction === "function") {
        const prod = village.getResProduction() || {};
        const total = prod[key];
        if (isFinite(total) && total > 0) return count > 0 ? (total * ticksPerSecond()) / count : total * ticksPerSecond();
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
  const JOB_REBALANCE_MIN_MS = 45000;
  const JOB_WEIGHT_SMOOTHING = 0.2;
  const JOB_COUNT_DEADBAND_RATIO = 0.12;
  const CLIMB_PUSH_WEIGHT = 10;
  let smoothedJobWeights = {};
  let lastJobRun = 0;
  let lastJobLog = 0;
  let lastStarvationLog = 0;
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
    const live = liveMetaView(meta) || meta;
    const parts = [metaText(live)];
    for (const key of ["effects", "calculateEffects", "unlocks", "upgrades", "stages"]) {
      const value = live && live[key];
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
    kindPrior: { research: 12, upgrade: 12, religion: 11, ziggurat: 9, build: 4, policy: 6 },
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
    powerHeadroom: 1,
    powerEmergencyBoost: 180,
    powerDeficitPenalty: 160,
    powerWinterPenalty: 45,
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

  const emptyEffectProfile = () => ({ perTick: {}, max: {}, ratio: {}, demand: {}, housing: 0, happiness: 0, craft: 0, energyProduction: 0, energyConsumption: 0 });

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
    target.energyProduction += (source.energyProduction || 0) * scale;
    target.energyConsumption += (source.energyConsumption || 0) * scale;
    return target;
  };

  const parseEffectEntry = (profile, key, value) => {
    if (!isFinite(value) || value === 0) return;
    if (key === "energyProduction") {
      profile.energyProduction += value;
      return;
    }
    if (key === "energyConsumption") {
      profile.energyConsumption += value;
      return;
    }
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

  const powerStatus = () => {
    try {
      const pool = window.gamePage && window.gamePage.resPool || {};
      const prod = Number(pool.energyProd) || 0;
      const cons = Number(pool.energyCons) || 0;
      const winterProd = Number(pool.energyWinterProd);
      const safeWinterProd = isFinite(winterProd) ? winterProd : prod;
      return { prod, cons, delta: prod - cons, winterProd: safeWinterProd, winterDelta: safeWinterProd - cons };
    } catch (error) {
      return { prod: 0, cons: 0, delta: 0, winterProd: 0, winterDelta: 0 };
    }
  };

  const profileNetEnergy = (profile) => (profile && profile.energyProduction || 0) - (profile && profile.energyConsumption || 0);
  const candidateNetEnergy = (candidate) => candidate ? profileNetEnergy(candidateEffectProfile(candidate.kind, candidate.meta)) : 0;
  const isPowerEmergency = () => {
    const power = powerStatus();
    return power.delta < 0 || power.winterDelta < 0;
  };

  // Does building this candidate actually relieve a FOOD crisis?  True when it
  // adds catnip production, catnip storage, a catnip production multiplier, or
  // cuts catnip demand.  Used so a transient winter catnip dip (already handled
  // by the farmer failsafe) can only break the plan lock to switch toward a
  // catnip building — never to ping-pong between unrelated targets.
  const foodHelpingCandidate = (candidate) => {
    if (!candidate || !candidate.meta) return false;
    const profile = metaEffectProfile(candidate.meta);
    return (profile.perTick.catnip || 0) > 0 ||
      (profile.max.catnip || 0) > 0 ||
      (profile.ratio.catnip || 0) > 0 ||
      (profile.demand.catnip || 0) < 0;
  };

  const metaEffectProfile = (meta) => {
    const profile = emptyEffectProfile();
    if (!meta || typeof meta !== "object") return profile;
    const live = liveMetaView(meta) || meta;
    refreshMetaEffects(meta);
    const refreshed = liveMetaView(meta) || live;
    const effects = refreshed.effects && typeof refreshed.effects === "object" ? refreshed.effects : {};
    for (const [key, value] of Object.entries(effects)) parseEffectEntry(profile, key, value);
    return profile;
  };

  const expansionPressure = () => {
    try {
      const game = window.gamePage;
      const village = game.village;
      const kittens = villageKittens();
      const max = village.maxKittens || (village.sim && village.sim.maxKittens) || 0;
      if (!(max > 0)) return { score: 0, kittens, max: 0, free: 0, saturation: 0, milestone: 0 };
      const free = Math.max(0, max - kittens);
      const saturation = Math.min(1, kittens / max);
      const firstReset = !hasPriorReset();
      const milestone = firstReset ? 130 : Math.max(70, kittens);
      const milestoneGap = firstReset ? Math.max(0, milestone - kittens) / milestone : 0;
      const cappedBoost = free <= 0 ? 1 : free <= 2 ? 0.75 : Math.max(0, 1 - free / Math.max(5, max * 0.15));
      const score = Math.min(2, Math.pow(saturation, 3) * (0.7 + cappedBoost) * (firstReset && milestoneGap > 0 ? 1.35 : 1));
      return { score, kittens, max, free, saturation, milestone, firstReset, milestoneGap };
    } catch (error) {
      return { score: 0, kittens: 0, max: 0, free: 0, saturation: 0, milestone: 0 };
    }
  };

  const bestExpansionCheckpoint = (candidates, resources) => {
    const pressure = expansionPressure();
    if (pressure.score < 0.8) return null;
    // Food gate: expansion buys population CAPACITY, but every new kitten eats
    // catnip.  When catnip is already NET-NEGATIVE the colony cannot feed the
    // kittens it has — growing the cap (and the housing grind that funds it:
    // diverting farmers→woodcutters and refining catnip→wood) only deepens the
    // starvation, exactly the death spiral a full-but-starving village showed
    // (catnip draining at -112/s while a 500K-wood Hut stayed locked in).  Stand
    // down until food is positive again; the starvation guard re-staffs farmers
    // and the economy layers can fix catnip storage/production first.  Once
    // catnip is net-positive (a real surplus to grow into) expansion re-qualifies.
    if (productionFor("catnip") < 0) return null;
    const options = candidates
      .filter((candidate) => candidate && candidate.kind === "build")
      .map((candidate) => {
        const slots = Math.max(0, candidateEffectProfile(candidate.kind, candidate.meta).housing || 0);
        const eta = waitSecondsForCandidate(candidate, resources);
        const value = slots > 0 && isFinite(eta) ? pressure.score * slots * 20 / (1 + Math.log10(eta + 1)) : 0;
        return { candidate, slots, eta, value };
      })
      .filter((option) =>
        option.value > 0 &&
        !directStorageBlockers(option.candidate.kind, option.candidate.meta, resources).length)
      .sort((a, b) => b.value - a.value || a.eta - b.eta);
    return options.length ? { ...options[0], pressure, options: options.slice(0, 3) } : null;
  };

  const WORKSHOP_PROJECT_MAX_ETA_S = 3600;
  let activeWorkshopRoadmapId = null;

  // One owner for the whole workshop backlog. Ready upgrades enter
  // immediately; non-ready upgrades enter only when their TRUE cumulative
  // craft-chain bill fits a bounded funding horizon. The active-plan ledger
  // then owns reservation, crafting and purchase like every other real plan.
  const bestWorkshopRoadmap = (candidates, resources) => {
    if (!hasPriorReset()) {
      activeWorkshopRoadmapId = null;
      return null;
    }
    const options = [];
    for (const candidate of candidates || []) {
      if (!candidate || candidate.kind !== "upgrade" || !candidate.meta || !isOpen(candidate.meta)) continue;
      if (buyBenched(targetId(candidate))) continue;
      if (directStorageBlockers(candidate.kind, candidate.meta, resources).length) continue;
      const solver = solveCraftChain(resources, candidate);
      if (!solver.reachable || solver.hardBlocked) continue;
      const ready = !!candidate.affordable;
      const eta = ready ? 0 : waitSecondsForCandidate(candidate, resources);
      if (!ready && (!isFinite(eta) || eta > WORKSHOP_PROJECT_MAX_ETA_S)) continue;
      const numerator = Math.max(0, candidate.score || 0) + Math.max(0, gatewayValue(candidate.meta));
      const value = numerator / (1 + Math.log10(eta + 1));
      if (!ready && !(value > 0)) continue;
      options.push({ candidate, eta, ready, value, solver });
    }
    if (!options.length) {
      activeWorkshopRoadmapId = null;
      return null;
    }
    options.sort((a, b) => Number(b.ready) - Number(a.ready) || b.value - a.value || a.eta - b.eta);
    const best = options[0];
    const prior = activeWorkshopRoadmapId
      ? options.find((option) => targetId(option.candidate) === activeWorkshopRoadmapId)
      : null;
    const keepPrior = prior && (prior.ready || !best.ready) && best.value <= prior.value * PLAN_HYSTERESIS_MULT;
    const chosen = keepPrior ? prior : best;
    activeWorkshopRoadmapId = targetId(chosen.candidate);
    return chosen;
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
        if (observed != null &&
            (result === 0 || Math.sign(observed) === Math.sign(result)) &&
            Math.abs(observed - result) <= Math.max(1, Math.abs(result) * 0.35)) {
          result = observed;
        }
        tickCache.production[resourceName] = result;
        return result;
      }
      const res = getRes(resourceMap(), resourceName);
      if (res && isFinite(res.perTickCached)) {
        result = res.perTickCached * ticksPerSecond();
        if (observed != null &&
            (result === 0 || Math.sign(observed) === Math.sign(result)) &&
            Math.abs(observed - result) <= Math.max(1, Math.abs(result) * 0.35)) {
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
    if (observed != null && (result === 0 ||
        (Math.sign(observed) === Math.sign(result) && Math.abs(observed - result) <= Math.max(1, Math.abs(result) * 0.35)))) {
      result = observed;
    }
    tickCache.production[resourceName] = result;
    return result;
  };

  // A genuine FOOD EMERGENCY: the pantry is nearly empty AND catnip is still
  // net-negative, so kittens are dying right now.  Every survival override keys
  // off this one predicate — the farmer failsafe in desiredJobCounts AND the
  // job-rebalance throttle bypass in balanceJobs — so the executor can re-staff
  // farmers on the SAME tick instead of waiting out the 45s anti-churn timer.
  const isFoodEmergency = (resources) =>
    !!resources && resRatio(resources, "catnip") < 0.05 && productionFor("catnip") < 0;

  // keepLeafNames: key leaves by the resource itself ("furs") instead of the
  // job-need name ("manpower") — callers that must tell a hunt-refilled fur
  // bill apart from generic catpower pressure need the un-folded name.
  const rawPathRequirements = (name, amount, out = {}, depth = 0, keepLeafNames = false) => {
    if (depth > 5 || !isFinite(amount) || amount <= 0) return out;
    const craft = craftByName(name);
    if (!craft || resourceHasDirectJobPath(name)) {
      const raw = keepLeafNames ? name : rawWorkNeedName(name);
      out[raw] = (out[raw] || 0) + amount;
      return out;
    }
    const prices = craftPricesFor(craft).filter((p) => p && p.name && p.val > 0);
    if (!prices.length) {
      const raw = keepLeafNames ? name : rawWorkNeedName(name);
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
      rawPathRequirements(price.name, Math.max(0, inputNeed - inputStock), out, depth + 1, keepLeafNames);
    }
    return out;
  };

  // The active plan's outstanding FURS bill beyond current stock.  A queued
  // Electricity (67 Compendium → 1K Manuscript → 8K Parchment → ~450K furs)
  // is paced by hunting even while the furs BANK looks "healthy" against the
  // small luxury/mood target — so the busywork clamp that stands hunters down
  // on a stocked fur bank must yield to a live chain deficit, and near-cap
  // catpower must not hard-zero the hunters mid hunt-cycle.
  const targetFurDeficit = (target, resources) => {
    if (!target || target.affordable || !target.meta) return 0;
    const raw = {};
    for (const cost of pricesFor(target.kind, target.meta)) {
      if (!cost || !cost.name || !isFinite(cost.val) || cost.val <= 0 || !craftByName(cost.name)) continue;
      const missing = cost.val - resValueOf(resources, cost.name);
      if (missing > 0) rawPathRequirements(cost.name, missing, raw, 0, true);
    }
    if (!(raw.furs > 0)) return 0;
    return Math.max(0, raw.furs - Math.max(0, resValueOf(resources, "furs")));
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

  // A final price in a CAPPED bank above its live cap is a storage block no
  // matter how the resource is produced: the game clamps a capped bank AT its
  // cap, so crafting/jobs can only fill it TO the cap, never past it (v2.14.0
  // — the post-reset "Library wood 202/200, target never changes" stall).
  // Craftable-but-capped raw banks (wood via Refine Catnip) are blocked exactly
  // like science; genuinely uncapped crafted goods (beam/slab, cap 0) and
  // hunt-refilled luxuries are exempt. This is the single final-purchase cap
  // test — the expansion layer's old separate copy (finalPurchaseCapBlockers)
  // was identical and merged into it.
  const directStorageBlockers = (kind, meta, resources) => {
    const blockers = [];
    for (const cost of pricesFor(kind, meta)) {
      if (!cost || !cost.name || !isFinite(cost.val) || cost.val <= 0) continue;
      if (HUNTABLE_RESOURCES.has(cost.name)) continue;
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
    if (profile.housing > 0) value += TUNING.housingValue * Math.max(1, profile.housing) * (0.6 + housingSaturation() * 1.8);
    if (profile.happiness > 0) {
      value += Math.min(TUNING.happinessScale, profile.happiness * (0.5 + Math.max(0, 1 - currentHappinessRatio()) * 4));
    }
    const power = powerStatus();
    const netEnergy = profileNetEnergy(profile);
    if (netEnergy > 0 && (power.delta < TUNING.powerHeadroom || power.winterDelta < 0)) {
      const deficit = Math.max(0, TUNING.powerHeadroom - power.delta, -power.winterDelta);
      value += TUNING.powerEmergencyBoost * Math.min(2, netEnergy / Math.max(1, deficit));
    }
    if ((profile.energyConsumption || 0) > 0) {
      const projected = power.delta - profile.energyConsumption;
      const projectedWinter = power.winterDelta - profile.energyConsumption;
      if (projected < TUNING.powerHeadroom) value -= TUNING.powerDeficitPenalty * (TUNING.powerHeadroom - projected);
      if (projectedWinter < 0) value -= TUNING.powerWinterPenalty * -projectedWinter;
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
    const effects = ((liveMetaView(meta) || meta) && (liveMetaView(meta) || meta).effects) || {};
    const inputs = [];
    const outputs = [];
    let energyProduction = 0;
    let energyConsumption = 0;
    for (const [key, value] of Object.entries(effects)) {
      if (key === "energyProduction") energyProduction += Number(value) || 0;
      if (key === "energyConsumption") energyConsumption += Number(value) || 0;
      if (!isFinite(value) || value === 0) continue;
      const name = effectResourceName(key);
      if (!name) continue;
      if (value < 0) inputs.push(name);
      if (value > 0) outputs.push(name);
    }
    return { inputs: [...new Set(inputs)], outputs: [...new Set(outputs)], energyProduction, energyConsumption, netEnergy: energyProduction - energyConsumption };
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
      const isPowerToggle = hasOnToggle(meta) && (profile.energyProduction || profile.energyConsumption);
      const managedToggle = hasOnToggle(meta) && (KNOWN_CONVERTERS.includes(meta.name) || ALWAYS_ON_TOGGLES.includes(meta.name));
      if (isConverter || managedToggle || isPowerToggle) {
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

  // Latent power demand: consumption that is currently OFF *only* because the
  // processing controller paused it to protect Wt.  The game's energyCons drops
  // the instant a Data Center / Calciner is idled, so powerStatus() then reports
  // a FALSE surplus.  Acting on that surplus — building or targeting yet another
  // power consumer — forces processing to pause it again next tick, which is the
  // Data-Center on/off oscillation the player sees.  Counting the paused-for-power
  // consumers gives the planner the TRUE power picture so it keeps recovering
  // power until everything can actually run, instead of flip-flopping.  Only
  // reason==="power" pauses count: a converter idled for a starved input or a
  // capped output is not blocked on Wt, so resuming it is not a power decision.
  const latentPowerDemand = () => {
    let demand = 0;
    try {
      for (const meta of converterBuildings()) {
        const memo = pausedProcessors[meta.name];
        if (!memo || memo.reason !== "power") continue;
        const profile = processingProfileFor(meta);
        const perUnitNet = (profile.energyProduction || 0) - (profile.energyConsumption || 0);
        if (perUnitNet < 0) demand += -perUnitNet * Math.max(0, memo.on || meta.val || 0);
      }
    } catch (error) {
      /* ignore */
    }
    return demand;
  };

  // powerStatus() minus the latent demand above: the headroom that is REALLY free
  // once every consumer we paused for power is allowed to run again.  Planning
  // gates read this so an idled Data Center can't masquerade as spare power.
  const effectivePowerStatus = () => {
    const power = powerStatus();
    const latent = latentPowerDemand();
    return { ...power, latent, delta: power.delta - latent, winterDelta: power.winterDelta - latent };
  };

  // A net-power-negative building is only safe to build/target when the truly
  // free headroom (effective power) still clears the deficit after one more copy
  // runs.  Positive / neutral-energy buildings are always safe.  Used to keep the
  // science-storage layer from picking a power-hungry Data Center / Bio Lab while
  // Wt is short — it would just get paused, stalling both science and power.
  const powerSafeToBuild = (candidate) => {
    const net = candidateNetEnergy(candidate);
    if (net >= 0) return true;
    const power = effectivePowerStatus();
    return power.delta + net >= TUNING.powerHeadroom && power.winterDelta + net >= 0;
  };

  let processingPlanText = "Processing: watching converters";
  let lastProcessingLog = 0;
  // Two thresholds give the on/off controller hysteresis so it cannot flap a
  // converter every 4-second tick: pause an input once it drops below STARVE,
  // but do not resume until it climbs back above RESUME.
  const PROCESSOR_STARVE_RATIO = 0.08;
  const PROCESSOR_RESUME_RATIO = 0.22;
  const PROCESSOR_MIN_RUN_MS = 20000;
  const PROCESSOR_MIN_PAUSE_MS = 20000;
  const processorTransitions = {};

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

  const desiredProcessorState = (meta, resources, missing, needed, reserved, powerOverride) => {
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
    const healthyInputs = inputs.length && inputs.every((input) => resRatio(resources, input, 1) >= 0.85 || productionFor(input) > 0);
    // powerOverride lets optimizeProcessing thread a running projection through the
    // pass: the game's energyCons can lag a tick, so without it several consumers
    // would all resume off the same stale "safe" reading and oversubscribe Wt.
    const power = powerOverride || powerStatus();
    const netEnergy = (profile.energyProduction || 0) - (profile.energyConsumption || 0);
    const powerEmergency = power.delta < 0 || power.winterDelta < 0;
    const hardStarvedInputs = inputs.filter((input) => resRatio(resources, input, 1) < lowRatio && productionFor(input) <= 0);
    if (full > 0 && netEnergy > 0 && powerEmergency && hardStarvedInputs.length === 0) {
      return { on: full, reason: "power", detail: `power deficit ${fmt(power.delta)} Wt` };
    }
    if (full > 0 && netEnergy < 0 && (power.delta + netEnergy < TUNING.powerHeadroom || power.winterDelta + netEnergy < 0)) {
      return { on: 0, reason: "power", detail: "protecting Wt" };
    }
    const wantedOutputs = outputs.some((output) => !resCapped(resources, output) || needed.has(output));
    if (full > 0 && (meta.on || 0) <= 0 && healthyInputs && wantedOutputs) {
      return { on: full, reason: "run", detail: "healthy inputs" };
    }

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
      // Running power projection for THIS pass.  Each toggle advances it by the
      // marginal Wt it changes, so a later converter sees power as it will be
      // after the earlier toggles in the same pass — not the stale start-of-pass
      // reading the game's pool may still report.  This stops several consumers
      // all resuming off one "safe" snapshot and oversubscribing Wt.
      let projected = powerStatus();
      const advanceProjection = (meta, fromOn, toOn) => {
        const profile = processingProfileFor(meta);
        const perUnitNet = (profile.energyProduction || 0) - (profile.energyConsumption || 0);
        const deltaWt = (toOn - fromOn) * perUnitNet;
        projected = { ...projected, delta: projected.delta + deltaWt, winterDelta: projected.winterDelta + deltaWt };
      };

      for (const meta of converters) {
        const name = meta.name;
        const currentOn = Math.max(0, meta.on || 0);
        const state = desiredProcessorState(meta, resources, missing, needed, reserved, projected);
        const transition = processorTransitions[name] || { state: currentOn > 0 ? "run" : "pause", at: 0 };
        const desiredMode = state.on > 0 ? "run" : "pause";
        if (transition.at > 0 && transition.state !== desiredMode) {
          const min = transition.state === "run" ? PROCESSOR_MIN_RUN_MS : PROCESSOR_MIN_PAUSE_MS;
          if (Date.now() - transition.at < min) {
            processingPlanText = `Processing: holding ${labelOf(meta)} ${transition.state === "run" ? "running" : "paused"} (cooldown)`;
            continue;
          }
        }

        if (state.on <= 0) {
          if (currentOn > 0) {
            pausedProcessors[name] = { on: currentOn, label: labelOf(meta), reason: state.reason };
            if (setProcessorOn(meta, 0)) {
              processorTransitions[name] = { state: "pause", at: Date.now() };
              changed.push(`paused ${labelOf(meta)}${state.detail ? ` (${state.detail})` : ""}`);
              advanceProjection(meta, currentOn, 0);
            }
          } else if (pausedProcessors[name]) {
            // Keep remembering why it is off so hysteresis/reporting hold.
            pausedProcessors[name].reason = state.reason;
          }
        } else if (currentOn < state.on) {
          if (setProcessorOn(meta, state.on)) {
            processorTransitions[name] = { state: "run", at: Date.now() };
            changed.push(pausedProcessors[name] ? `resumed ${labelOf(meta)}` : `started ${labelOf(meta)}`);
            advanceProjection(meta, currentOn, state.on);
          }
          delete pausedProcessors[name];
        } else if (pausedProcessors[name]) {
          // Already at/above target and no longer throttled — clear the memo.
          delete pausedProcessors[name];
        }
      }

      if (changed.length) {
        const power = powerStatus();
        for (let i = 0; i < changed.length; i += 1) {
          if (/started|resumed/.test(changed[i]) && power.delta < 0) changed[i] += ` (power deficit ${fmt(power.delta)} Wt)`;
        }
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

  const keepHealthyConvertersStable = (resources) => {
    try {
      for (const meta of converterBuildings()) {
        if (!hasOnToggle(meta) || (meta.on || 0) > 0) continue;
        const profile = processingProfileFor(meta);
        const inputs = (profile.inputs.length ? profile.inputs : PROCESSOR_INPUTS[meta.name] || []).filter((name) => getRes(resources, name));
        const outputs = (profile.outputs.length ? profile.outputs : PROCESSOR_OUTPUTS[meta.name] || []).filter((name) => getRes(resources, name));
        if (!inputs.length || !outputs.length) continue;
        if (inputs.every((name) => resRatio(resources, name, 1) >= 0.85) && outputs.some((name) => !resCapped(resources, name))) {
          const transition = processorTransitions[meta.name];
          if (!transition || Date.now() - transition.at >= PROCESSOR_MIN_PAUSE_MS) setProcessorOn(meta, meta.val || 0);
        }
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
      const route = acquisitionPathFor(resources, cost.name, cost.val, { finalPurchase: true });
      if (!route.reachable) return Number.POSITIVE_INFINITY;
      worst = Math.max(worst, route.eta);
    }
    return worst;
  };

  // VALUE-based scoring. Deliberately NOT dominated by "affordable right now":
  // the executor opportunistically buys cheap ready items from surplus anyway,
  // so the PLAN should be the most valuable reachable step — and the
  // reservation system makes saving for it actually work. One framework for
  // every kind: score = value (parsed economic effects + unlocks + goal
  // alignment + spend-before-store) − cost (time to afford, storage blocks).
  const hasUnreachableDirectInput = (candidate, resources) =>
    pricesFor(candidate.kind, candidate.meta).some((cost) => {
      if (!cost || !cost.name || !isFinite(cost.val) || cost.val <= 0) return false;
      if (resValueOf(resources, cost.name) >= cost.val) return false;
      return !acquisitionPathFor(resources, cost.name, cost.val, { finalPurchase: true }).reachable;
    });

  const candidateScore = (candidate, resources, goal, goalKey) => {
    const { kind, meta } = candidate;
    const wait = waitSecondsForCandidate(candidate, resources);
    const unreachableHardBlocked = hasUnreachableDirectInput(candidate, resources);
    const waitPenalty = isFinite(wait)
      ? Math.min(TUNING.waitPenaltyCap, Math.log10(wait + 1) * 4)
      : TUNING.unreachablePenalty;
    const storageBlockPenalty = directStorageBlockers(kind, meta, resources).length > 0 ? TUNING.storageBlockPenalty : 0;
    const unreachableBlockPenalty = unreachableHardBlocked ? TUNING.storageBlockPenalty + TUNING.unreachablePenalty : 0;
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
    if (kind === "build" && !unreachableHardBlocked) {
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
    return score - waitPenalty - idleStoragePenalty - storageBlockPenalty - unreachableBlockPenalty;
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
      for (const u of zigguratUpgrades()) {
        if (zigguratUpgradeVisible(u)) candidates.push({ kind: "ziggurat", weight: 3, meta: u });
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
    resourceBootstrap: "Resource bootstrap",
    expansion: "Expansion checkpoint",
    workshopRoadmap: "Workshop roadmap",
    festival: "Festival maintenance",
    stageTransition: "Building stage transition",
    stageRebuild: "Stage rebuild",
    hardUnlock: "Hard unlock / milestone",
    scienceStorageUnlock: "Science storage unlock",
    storage: "Storage blocker",
    power: "Power recovery",
    production: "Production bottleneck",
    housing: "Housing / population",
    unicornPath: "Ziggurat / unicorn path",
    economy: "Economy / normal growth",
    longProject: "Long project",
  };

  let lastStrategicDecision = null;

  // Sticky power-recovery choice.  net÷ETA is the right ranking (fastest Wt per
  // second of wait), but ETA rides live trade luck and craft progress, so the raw
  // winner wobbles between e.g. Solar Farm and Magneto every tick — the plan then
  // flaps and finishes neither.  We commit to the prior generator while it stays
  // a valid option and only switch when a rival is materially better, mirroring
  // the science-storage commit.
  let activePowerRecoveryId = null;
  let lastPowerRecoveryDiagnostic = {
    rawDelta: 0, winterDelta: 0, latent: 0, pausedDemand: 0, deficit: 0,
    action: "not evaluated",
  };
  const bestPowerRecoveryTarget = (candidates, resources) => {
    // Gate on EFFECTIVE power (raw minus the demand of consumers we paused only to
    // protect Wt).  Without this, the instant processing idles a Data Center the
    // raw delta turns positive, this layer yields, the science-storage layer picks
    // that very Data Center, processing pauses it again → oscillation.  Effective
    // power stays in deficit until enough generation exists to run everything, so
    // we keep recovering power continuously instead of bouncing.
    const raw = powerStatus();
    const power = effectivePowerStatus();
    const deficit = Math.max(0, -power.delta, -power.winterDelta);
    lastPowerRecoveryDiagnostic = {
      rawDelta: raw.delta,
      winterDelta: power.winterDelta,
      rawWinterDelta: raw.winterDelta,
      latent: power.latent || 0,
      pausedDemand: power.latent || 0,
      deficit,
      action: "",
    };
    if (power.delta >= 0 && power.winterDelta >= 0) {
      activePowerRecoveryId = null;
      lastPowerRecoveryDiagnostic.action = `Power recovery skipped: effective delta +${fmt(power.delta)} Wt, winter delta +${fmt(power.winterDelta)} Wt, latent demand ${fmt(power.latent || 0)} Wt.`;
      return null;
    }
    const options = (candidates || [])
      .filter((candidate) => candidate && candidateNetEnergy(candidate) > 0)
      .filter((candidate) => directStorageBlockers(candidate.kind, candidate.meta, resources).length === 0)
      .map((candidate) => {
        const net = candidateNetEnergy(candidate);
        const eta = waitSecondsForCandidate(candidate, resources);
        const etaFactor = isFinite(eta) ? Math.max(1, eta) : Number.POSITIVE_INFINITY;
        return { candidate, net, eta, value: net / etaFactor };
      })
      .filter((option) => isFinite(option.value) && option.value > 0)
      .sort((a, b) => b.value - a.value || b.net - a.net || a.eta - b.eta);
    if (!options.length) {
      activePowerRecoveryId = null;
      lastPowerRecoveryDiagnostic.action = `Power recovery needed (${fmt(deficit)} Wt deficit) but no valid generator target is available.`;
      return null;
    }
    const best = options[0];
    const prior = activePowerRecoveryId && options.find((option) => targetId(option.candidate) === activePowerRecoveryId);
    const chosen = prior && best.value <= prior.value * 1.25 ? prior : best;
    activePowerRecoveryId = targetId(chosen.candidate);
    lastPowerRecoveryDiagnostic.action = `selected ${labelOf(chosen.candidate.meta)} for computed deficit ${fmt(deficit)} Wt`;
    return chosen.candidate;
  };

  /* ------------------------ converter-fuel starvation -----------------------
   * A converter (Magneto, Calciner, …) burns a NON-craftable fuel (oil) made by a
   * producer building (Oil Well).  When that fuel is pinned at/near zero with
   * non-positive net production, desiredProcessorState starve-pauses the converter
   * every tick — the Magneto/Calciner on/off churn the player sees, plus the lost
   * power and iron.  The economy scorer already ranks the producer #1 (the
   * producerPrereq boost), but a structural hold (research sprint / science
   * storage) outranks economy, so the fuel never recovers on its own.  This makes
   * the long-defined STRATEGIC_LAYERS.production a real layer: a starved converter
   * fleet is treated like a power deficit and its producer is built first.
   */
  const converterFuelStarvation = (resources) => {
    const fuels = new Set();
    for (const meta of converterBuildings()) {
      const profile = processingProfileFor(meta);
      const inputs = profile.inputs.length ? profile.inputs : (PROCESSOR_INPUTS[meta.name] || []);
      for (const input of inputs) {
        if (fuels.has(input) || !getRes(resources, input)) continue;
        // Food has its own farmer failsafe; a craftable input is assembled on
        // demand, not pumped by a producer building, so it is not a "fuel".
        if (input === "catnip" || craftByName(input)) continue;
        if (resRatio(resources, input, 1) >= PROCESSOR_STARVE_RATIO) continue; // not pinned low
        if (productionFor(input) > 0) continue;                                // already climbing
        if (!producerBuildingsFor(input).length) continue;                     // nothing can build it
        fuels.add(input);
      }
    }
    return fuels;
  };

  // Sticky producer choice, mirroring the power-recovery commit so the pick cannot
  // wobble tick-to-tick.  Building producers permanently raises fuel production, so
  // the layer converges (it yields the moment net fuel production turns positive).
  let activeConverterFuelId = null;
  let lastConverterFuelDiagnostic = { fuel: "", action: "not evaluated" };
  const bestConverterFuelTarget = (candidates, resources) => {
    const fuels = converterFuelStarvation(resources);
    if (!fuels.size) { activeConverterFuelId = null; lastConverterFuelDiagnostic = { fuel: "", action: "no starved converter fuel" }; return null; }
    const fuelText = [...fuels].join("+");
    const options = (candidates || [])
      .filter((c) => c && c.kind === "build" && c.meta)
      .filter((c) => {
        const profile = candidateEffectProfile(c.kind, c.meta);
        return Object.keys(profile.perTick || {}).some((n) => fuels.has(n) && (profile.perTick[n] || 0) > 0);
      })
      .filter((c) => directStorageBlockers(c.kind, c.meta, resources).length === 0)
      .filter((c) => powerSafeToBuild(c))
      .filter((c) => solveCraftChain(resources, c).reachable)
      .map((c) => ({ candidate: c, eta: waitSecondsForCandidate(c, resources), score: c.score || 0 }))
      .filter((o) => isFinite(o.eta))
      .sort((a, b) => (b.score - a.score) || (a.eta - b.eta));
    if (!options.length) { activeConverterFuelId = null; lastConverterFuelDiagnostic = { fuel: fuelText, action: `${fuelText} starved but no buildable producer is reachable` }; return null; }
    const best = options[0];
    const prior = activeConverterFuelId && options.find((o) => targetId(o.candidate) === activeConverterFuelId);
    const chosen = prior && best.score <= prior.score * 1.25 ? prior : best;
    activeConverterFuelId = targetId(chosen.candidate);
    lastConverterFuelDiagnostic = { fuel: fuelText, action: `building ${labelOf(chosen.candidate.meta)} to relieve starved ${fuelText}` };
    return chosen.candidate;
  };

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
  const capDrainReachabilityFor = (resources, name, amount, depth = 0, stack = new Set(), refillCycles = false) => {
    if (!isFinite(amount) || amount <= 0) return { reachable: true, eta: 0, chain: new Set([name]) };
    if (depth > 8 || stack.has(name)) return { reachable: false, eta: Number.POSITIVE_INFINITY, reason: `no path for ${name}`, chain: new Set([name]) };
    const chain = new Set([name]);
    const max = resMaxOf(resources, name);
    const have = resValueOf(resources, name);
    const deficit = Math.max(0, amount - have);
    const prod = rawProductionForNeed(name);
    if (!refillCycles && max > 0 && amount > max && !CAPPED_REFILL_RESOURCES.has(name) && !craftByName(name)) {
      return { reachable: false, eta: Number.POSITIVE_INFINITY, reason: `${resTitle(resources, name)} storage cap blocks ${fmt(amount)}`, chain };
    }
    if (deficit <= 0) return { reachable: true, eta: 0, chain };

    const unifiedRoute = acquisitionPathFor(resources, name, amount, { refillCycles });
    if (unifiedRoute.reachable && unifiedRoute.kind !== "craft") {
      routeResourcesInto(unifiedRoute, chain);
      return { reachable: true, eta: unifiedRoute.eta, chain, route: unifiedRoute };
    }

    const craft = craftByName(name);
    // Some raw resources (notably wood via Refine Catnip) are also exposed as
    // workshop crafts.  Treat their full deficit as a time/producible bottleneck
    // instead of requiring enough input storage to craft the entire missing
    // amount in one batch.  Only one incremental craft step must fit.
    const incrementalDirectCraft = prod > 0 && rawWorkNeedName(name) === name;
    if (incrementalDirectCraft) {
      return { reachable: true, eta: deficit / prod, chain };
    }
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
        const childAmount = incrementalDirectCraft ? price.val : price.val * units;
        const child = capDrainReachabilityFor(resources, price.name, childAmount, depth + 1, new Set([...stack, name]), true);
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

    if (prod > 0) {
      return { reachable: true, eta: deficit / prod, chain };
    }
    if (CAPPED_REFILL_RESOURCES.has(name)) {
      // Faith has its own religion-banking safety rules (food stress, non-faith
      // gates, background priest trickle). Do not make those long projects look
      // structurally active just because priests could be reassigned; ordinary
      // capped banks like science can use the generic job-path fallback.
      const hasJobPath = name !== "faith" && resourceHasDirectJobPath(name);
      const jobRate = hasJobPath ? directJobRatePerSecondFor(name) : 0;
      const refillRate = prod > 0 ? prod : (jobRate > 0 ? jobRate : 0);
      const reachable = prod > 0 || jobRate > 0;
      const eta = refillRate > 0 ? deficit / refillRate : Number.POSITIVE_INFINITY;
      if (max > 0 && amount > max) return { reachable, eta, reason: reachable ? undefined : `no ${resTitle(resources, name)} refill`, chain };
      return { reachable, eta, reason: reachable ? undefined : `no ${resTitle(resources, name)} refill`, chain };
    }
    // A staffable resource (minerals with every miner temporarily pulled to
    // another job, catnip with no farmers in autumn, …) is never a dead end:
    // the job balancer assigns workers the moment a plan needs it.  Reading
    // "production 0 → unreachable" here made every minerals-priced candidate
    // look impossible exactly when a sprint's job override had emptied the
    // mines, which then kept the deadlock alive.  Model one marginal worker
    // as the conservative rate floor instead.
    if (resourceHasDirectJobPath(name)) {
      const jobRate = directJobRatePerSecondFor(name);
      if (jobRate > 0) return { reachable: true, eta: deficit / jobRate, chain };
    }
    // Tears have no production/craft path: they arrive through the bounded
    // unicorn→tears sacrifice, batch by batch, so a tears deficit is reachable
    // whenever the banked unicorns already cover it or unicorn income exists.
    const sacrifice = sacrificeConversionFor(name);
    if (sacrifice) {
      chain.add(sacrifice.inputName);
      const banked = sacrificePotentialFor(resources, name);
      if (deficit <= banked) return { reachable: true, eta: 0, chain };
      const inputProd = rawProductionForNeed(sacrifice.inputName);
      if (inputProd > 0) {
        const chunks = Math.ceil((deficit - banked) / sacrifice.gainPerChunk);
        return { reachable: true, eta: (chunks * sacrifice.inputPerChunk) / inputProd, chain };
      }
      return { reachable: false, eta: Number.POSITIVE_INFINITY, reason: `no ${resTitle(resources, sacrifice.inputName)} income to sacrifice for ${resTitle(resources, name)}`, chain };
    }
    return { reachable: false, eta: Number.POSITIVE_INFINITY, reason: (unifiedRoute.blockers || [])[0] || `no acquisition path for ${resTitle(resources, name)}`, chain, route: unifiedRoute };
  };

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
    const routes = [];
    let eta = 0;
    let perStepCapsOk = true;
    let finalPurchaseCapsOk = true;
    let firstShortCraft = null;

    for (const cost of pricesFor(target.kind, target.meta)) {
      if (!cost || !cost.name || !isFinite(cost.val) || cost.val <= 0) continue;
      const cap = resMaxOf(resources, cost.name);
      const have = resValueOf(resources, cost.name);
      // Direct final cost in a CAPPED bank above its cap = storage-blocked,
      // craftable or not: the bank clamps at its cap, so Refine Catnip can
      // fill wood TO the cap but never hold the 202/200 a Library wants —
      // intermediate cumulative needs stay exempt (capDrainReachabilityFor
      // models their spend-and-refill cycles).
      if (cap > 0 && cost.val > cap && !HUNTABLE_RESOURCES.has(cost.name)) {
        finalPurchaseCapsOk = false;
        protectedChain.add(cost.name);
        blockers.push({ name: cost.name, kind: "finalCap", need: cost.val, cap, text: `${resTitle(resources, cost.name)} storage ${fmt(cap)}/${fmt(cost.val)}` });
        continue;
      }
      if (have >= cost.val) { protectedChain.add(cost.name); continue; }
      if (craftByName(cost.name) && !firstShortCraft) firstShortCraft = cost.name;
      const route = acquisitionPathFor(resources, cost.name, cost.val, { finalPurchase: true });
      routes.push(route);
      routeResourcesInto(route, protectedChain);
      eta = Math.max(eta, isFinite(route.eta) ? route.eta : 0);
      const perStepCapBlocked = (route.blockers || []).some((text) => /cap below one/i.test(text));
      if (perStepCapBlocked) perStepCapsOk = false;
      if (!route.reachable) {
        blockers.push({ name: cost.name, kind: perStepCapBlocked ? "stepCap" : "unreachable", text: (route.blockers || [])[0] || `no acquisition path for ${resTitle(resources, cost.name)}` });
      }
    }

    const currentStep = firstShortCraft ? deepestActionableStep(resources, firstShortCraft) : "";
    const hardBlocked = !finalPurchaseCapsOk || !perStepCapsOk || blockers.some((b) => b.kind === "unreachable");
    const reachable = !hardBlocked;
    const missing = pricesFor(target.kind, target.meta)
      .filter((cost) => cost && cost.name && cost.val > 0 && resValueOf(resources, cost.name) < cost.val)
      .map((cost) => `${fmt(cost.val - resValueOf(resources, cost.name))} ${craftByName(cost.name) ? craftLabel(cost.name) : resTitle(resources, cost.name)}`);
    return { reachable, hardBlocked, blockers, protectedChain, currentStep, neededText: missing.slice(0, 3).join(", "), eta, perStepCapsOk, finalPurchaseCapsOk, routes };
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

  // Research can require a final bank and intermediates that consume that same
  // bank (Robotics: 140K science + 80 Blueprints, while Blueprints/Compendia
  // consume science).  Treat this as an explicit sequence instead of trying to
  // reserve the final bank and craft the intermediates simultaneously.
  const researchTargetPhase = (target, resources = resourceMap()) => {
    if (!target || target.kind !== "research" || !target.meta) {
      return { phase: "purchase", craftCosts: [], finalCosts: [], sharedInputs: new Set(), explanation: "ready" };
    }
    const costs = pricesFor(target.kind, target.meta).filter((cost) => cost && cost.name && isFinite(cost.val) && cost.val > 0);
    const craftCosts = costs.filter((cost) => craftByName(cost.name) && resValueOf(resources, cost.name) < cost.val);
    const finalCosts = costs.filter((cost) => !craftByName(cost.name) && resValueOf(resources, cost.name) < cost.val);
    const sharedInputs = new Set();
    for (const craftCost of craftCosts) {
      const raw = rawPathRequirements(craftCost.name, Math.max(0, craftCost.val - resValueOf(resources, craftCost.name)));
      for (const finalCost of costs.filter((cost) => !craftByName(cost.name))) {
        if ((raw[finalCost.name] || 0) > 0) sharedInputs.add(finalCost.name);
      }
    }
    if (costs.every((cost) => resValueOf(resources, cost.name) >= cost.val)) {
      return { phase: "purchase", craftCosts: [], finalCosts: [], sharedInputs, explanation: `${labelOf(target.meta)} ready to buy` };
    }
    if (craftCosts.length) {
      const shown = craftCosts.slice(0, 2).map((cost) => `${fmt(cost.val - resValueOf(resources, cost.name))} ${craftLabel(cost.name)}`).join(" + ");
      const transfer = sharedInputs.size ? ` (${[...sharedInputs].map((name) => resTitle(resources, name)).join("+")} cycles into intermediates)` : "";
      return { phase: "intermediate", craftCosts, finalCosts, sharedInputs, explanation: `craft ${shown}${transfer}, then refill final bank` };
    }
    const shown = finalCosts.slice(0, 2).map((cost) => `${fmt(cost.val - resValueOf(resources, cost.name))} ${resTitle(resources, cost.name)}`).join(" + ");
    return { phase: "final-bank", craftCosts: [], finalCosts, sharedInputs, explanation: `refill ${shown} for ${labelOf(target.meta)}` };
  };

  const targetOwnsIntermediateSpend = (target, resources, inputName, outputName, forPlanChain) => {
    if (!target || !inputName || !outputName || inputName === outputName) return false;
    if (!forPlanChain && !wouldWasteResource(resources, inputName)) return false;
    if (!craftOutputHelpsTarget(target, outputName, resources) && !targetNeedsResource(target, outputName)) return false;
    const directInputCost = pricesFor(target.kind, target.meta)
      .find((cost) => cost && cost.name === inputName && isFinite(cost.val) && cost.val > 0);
    if (directInputCost && resValueOf(resources, inputName) < directInputCost.val) {
      if (forPlanChain || resRatio(resources, inputName, 0) < 0.95) return false;
    }

    // The active plan owns its craft chain.  A reserve on raw/rolling inputs
    // (science for compendia, furs for parchment, catnip for wood, etc.) means
    // "do not spend outside this plan", not "freeze this resource in raw
    // form".  If the output is a still-needed active-plan intermediate, let the
    // craft consume the input down to the ordinary survival/luxury floor.
    const outputNeed = pricesFor(target.kind, target.meta)
      .find((cost) => cost && cost.name === outputName && isFinite(cost.val) && cost.val > 0);
    if (outputNeed && resValueOf(resources, outputName) < outputNeed.val) return true;

    for (const cost of pricesFor(target.kind, target.meta)) {
      if (!cost || !cost.name || !isFinite(cost.val) || cost.val <= 0 || !craftByName(cost.name)) continue;
      const deficit = Math.max(0, cost.val - resValueOf(resources, cost.name));
      if (deficit <= 0) continue;
      const raw = rawPathRequirements(cost.name, deficit);
      if ((raw[inputName] || 0) > 0 && craftChainOutputsFor(cost.name).has(outputName)) return true;
    }

    // Research sprints have an additional final-bank/refill phase where science
    // and crafted culture resources intentionally cycle through intermediates
    // before the final buy.  Keep the older explicit phase test as a backstop.
    if (target.kind === "research") {
      const phase = researchTargetPhase(target, resources);
      return phase.phase === "intermediate" &&
        phase.sharedInputs.has(inputName) &&
        phase.craftCosts.some((cost) => cost.name === outputName && resValueOf(resources, outputName) < cost.val);
    }
    return false;
  };

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
      // A filler tech with no unlocks (no gateway value) must never anchor a
      // multi-tick sprint — otherwise, when science sits near the cap, a cheap
      // dead-end tech can hijack the sprint ahead of a manuscript-gated gateway
      // tech (e.g. Trivia over Astronomy on the way to Rocketry). Cheap filler is
      // still bought through normal economy scoring; it just can't own the plan.
      // This mirrors the same guard in the science-storage-unlock layer.
      if (gatewayValue(candidate.meta) <= 0) continue;
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

  /* --------------------- sprint cap-drain pacing redirect -------------------
   * A sprint's craft chain can be paced by a cap-drain bank NO job can work
   * (culture is the only one in practice: science has scholars, faith has
   * priests).  35 Manuscripts at 400 culture each against +0.04 culture/s is a
   * multi-DAY passive wait — hunting more furs does not shorten it by one
   * second.  When that trickle leg dominates, the sprint contract stays alive
   * (chain still protected, manuscripts still crafted every time the bank
   * fills), but the PLAN target redirects to the best live producer of the
   * trickling resource (Amphitheatre for culture) so the wait is spent
   * shortening itself instead of freezing the village.  Without an actionable
   * producer the sprint behaves exactly as before.
   */
  const SPRINT_PACING_REDIRECT_S = 1800; // redirect when the passive wait exceeds 30 minutes

  const sprintCapDrainPacing = (candidate, resources) => {
    if (!candidate || !candidate.meta) return null;
    let worst = null;
    for (const cost of pricesFor(candidate.kind, candidate.meta)) {
      if (!cost || !cost.name || !isFinite(cost.val) || cost.val <= 0 || !craftByName(cost.name)) continue;
      const deficit = cost.val - resValueOf(resources, cost.name);
      if (deficit <= 0) continue;
      const raw = rawPathRequirements(cost.name, deficit);
      for (const [name, amount] of Object.entries(raw)) {
        if (!CAP_DRAIN_RESOURCES.has(name) || resourceHasDirectJobPath(name)) continue;
        const missing = Math.max(0, amount - resValueOf(resources, name));
        if (missing <= 0) continue;
        const prod = productionFor(name);
        const wait = prod > 0 ? missing / prod : Number.POSITIVE_INFINITY;
        if (wait > SPRINT_PACING_REDIRECT_S && (!worst || wait > worst.wait)) {
          worst = { name, missing, prod, wait };
        }
      }
    }
    return worst;
  };

  // Sticky booster pick (mirrors the power/science-unlock commits): rank live
  // per-tick producers of the trickling resource by gain per second of wait and
  // keep the incumbent while it remains an option, so the redirect cannot
  // oscillate between two near-equal producers tick to tick.  Storage-only
  // growers (cultureMax) are deliberately excluded — bigger batches do not
  // shorten a production-bound wait.
  let activeSprintPacingBoostId = null;

  // The producer's own bill in the trickling resource, direct or through its
  // craft chain (a Temple priced in Manuscripts spends ~81 × 400 culture — the
  // very bank the redirect is trying to grow).  Charged gross: even when the
  // manuscripts are already banked, buying the producer consumes them and the
  // sprint's cumulative bill must re-craft every one.
  const boosterPacingSelfDrain = (candidate, pacingName) => {
    let drain = 0;
    for (const cost of pricesFor(candidate.kind, candidate.meta)) {
      if (!cost || !cost.name || !isFinite(cost.val) || cost.val <= 0) continue;
      if (cost.name === pacingName) {
        drain += cost.val;
        continue;
      }
      if (!craftByName(cost.name)) continue;
      drain += Math.max(0, rawPathRequirements(cost.name, cost.val)[pacingName] || 0);
    }
    return drain;
  };

  const bestSprintPacingBooster = (candidates, resources, pacing) => {
    if (!pacing) {
      activeSprintPacingBoostId = null;
      return null;
    }
    const options = [];
    for (const candidate of candidates) {
      if (!candidate || !candidate.meta || candidate.kind === "policy" || candidate.kind === "stage") continue;
      const profile = candidateEffectProfile(candidate.kind, candidate.meta);
      const gain = (profile.perTick && profile.perTick[pacing.name]) || 0;
      if (!(gain > 0)) continue;
      const solver = solveCraftChain(resources, candidate);
      if (!solver.reachable) continue;
      const eta = waitSecondsForCandidate(candidate, resources);
      if (!isFinite(eta) || eta >= pacing.wait) continue; // slower than just waiting → useless
      // A booster must SHORTEN the total wait after paying its own bill in the
      // trickling resource: (missing + drain) at the boosted rate must beat
      // missing at the current rate, or the "booster" only sets the sprint
      // back (the live Temple whose 81-manuscript price cost ~11K culture for
      // a small culture/s gain).
      const gainPerSecond = gain * ticksPerSecond();
      const drain = boosterPacingSelfDrain(candidate, pacing.name);
      const boostedWait = (pacing.missing + drain) / Math.max(1e-6, pacing.prod + gainPerSecond);
      if (boostedWait >= pacing.wait) continue;
      options.push({ candidate, gain, eta });
    }
    if (!options.length) {
      activeSprintPacingBoostId = null;
      return null;
    }
    options.sort((a, b) => (b.gain / Math.max(60, b.eta)) - (a.gain / Math.max(60, a.eta)));
    const sticky = activeSprintPacingBoostId
      ? options.find((option) => targetId(option.candidate) === activeSprintPacingBoostId)
      : null;
    const chosen = sticky || options[0];
    activeSprintPacingBoostId = targetId(chosen.candidate);
    return chosen;
  };

  const usableScienceStorageFromEffects = (effects, scale = 1, resources = resourceMap()) => {
    const profile = profileFromEffects(effects || {});
    const direct = Math.max(0, (profile.max && profile.max.science) || 0) * Math.max(0, scale);
    const compendiumCeiling = Math.max(0, (((effects || {}).scienceMaxCompendia) || 0)) * Math.max(0, scale);
    const usableCompendiumHeadroom = Math.max(0, resValueOf(resources, "compedium") * 10 - resMaxOf(resources, "science"));
    return direct + Math.min(compendiumCeiling, usableCompendiumHeadroom);
  };

  const stagedScienceStorageGain = (candidate, resources = resourceMap()) => {
    const analysis = candidate && candidate.meta && candidate.meta.analysis;
    if (!analysis) return 0;
    const currentCount = Math.max(0, analysis.active || analysis.owned || 0);
    const targetCount = Math.max(0, analysis.parityCount || 0);
    const current = usableScienceStorageFromEffects(analysis.currentEffects, currentCount, resources);
    const target = usableScienceStorageFromEffects(analysis.targetEffects, targetCount, resources);
    return Math.max(0, target - current);
  };

  const scienceStorageGain = (candidate, resources = resourceMap()) => {
    if (!candidate) return 0;
    if (candidate.kind === "stage") return stagedScienceStorageGain(candidate, resources);
    const profile = candidateEffectProfile(candidate.kind, candidate.meta);
    const direct = Math.max(0, (profile.max && profile.max.science) || 0);
    // Data Centers also lift the Compendium-derived ceiling.  Only its usable
    // headroom can raise the current resource cap; scienceRatio is production
    // and deliberately contributes nothing here.
    const live = liveMetaView(candidate.meta) || candidate.meta || {};
    const compendiumCeiling = Math.max(0, (((live.effects || {}).scienceMaxCompendia) || 0));
    const usableCompendiumHeadroom = Math.max(0, resValueOf(resources, "compedium") * 10 - resMaxOf(resources, "science"));
    return direct + Math.min(compendiumCeiling, usableCompendiumHeadroom);
  };

  const scienceStorageUnlockCandidate = (candidate, resources) => {
    if (!candidate || candidate.kind === "policy") return false;
    if (candidate.kind === "research" && candidate.meta && !finalScienceFitsCap(candidate.meta, resources)) return false;
    return scienceStorageGain(candidate, resources) > 0;
  };

  const projectScienceClosure = (candidate, need, resources) => {
    const gain = scienceStorageGain(candidate, resources);
    if (!(gain > 0) || !(need > 0)) return { reachable: false, gain, copies: 0, projectedGain: 0, closure: 0, eta: Number.POSITIVE_INFINITY, prices: [] };
    if (candidate && candidate.kind === "stage") {
      const prices = pricesFor(candidate.kind, candidate.meta).filter((price) => price && price.name && price.val > 0);
      let eta = 0;
      let reachable = true;
      for (const price of prices) {
        const reach = capDrainReachabilityFor(resources, price.name, price.val);
        if (!reach.reachable) reachable = false;
        eta = Math.max(eta, reach.eta || 0);
      }
      return {
        reachable,
        gain,
        copies: 1,
        projectedGain: gain,
        closure: Math.min(1, gain / need),
        eta: reachable ? eta : Number.POSITIVE_INFINITY,
        prices,
      };
    }
    const copies = Math.min(100, Math.max(1, Math.ceil(need / gain)));
    const ratio = Math.max(1, Number((liveMetaView(candidate.meta) || candidate.meta || {}).priceRatio) || 1);
    const firstPrices = pricesFor(candidate.kind, candidate.meta).filter((price) => price && price.name && price.val > 0);
    const totals = new Map();
    for (let copy = 0; copy < copies; copy += 1) {
      const mult = Math.pow(ratio, copy);
      for (const price of firstPrices) totals.set(price.name, (totals.get(price.name) || 0) + price.val * mult);
    }
    let eta = 0;
    let reachable = firstPrices.length > 0;
    for (const [name, amount] of totals) {
      const reach = capDrainReachabilityFor(resources, name, amount);
      if (!reach.reachable) reachable = false;
      eta = Math.max(eta, reach.eta || 0);
    }
    const projectedGain = gain * copies;
    return {
      reachable,
      gain,
      copies,
      projectedGain,
      closure: Math.min(1, projectedGain / need),
      eta: reachable ? eta : Number.POSITIVE_INFINITY,
      prices: [...totals].map(([name, val]) => ({ name, val })),
    };
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
  let activeScienceUnlockContext = null;
  const scienceUnlockOptionId = (candidate) => {
    const raw = candidate && rawBuildingFor(candidate.meta);
    return `${targetId(candidate)}@${raw && isFinite(raw.stage) ? raw.stage : 0}`;
  };

  const bestScienceStorageUnlock = (candidates, resources) => {
    const max = resMaxOf(resources, "science");
    if (max <= 0) { activeScienceUnlockId = null; activeScienceUnlockContext = null; return null; }
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
      activeScienceUnlockContext = null;
      return null;
    }
    const blocked = next.c;
    const need = Math.max(0, next.cost - max);
    const blockerContext = targetId(blocked);
    if (activeScienceUnlockContext && activeScienceUnlockContext !== blockerContext) activeScienceUnlockId = null;
    activeScienceUnlockContext = blockerContext;
    const options = candidates
      .filter((candidate) => targetId(candidate) !== targetId(blocked))
      .filter((candidate) => scienceStorageUnlockCandidate(candidate, resources))
      .filter((candidate) => !directStorageBlockers(candidate.kind, candidate.meta, resources).length)
      // A power-hungry cap building (Data Center, Bio Lab) is no use while Wt is
      // short: the processing controller pauses it on sight, so it grows neither
      // science nor anything else.  Prefer a power-neutral Library/Academy/
      // Observatory; if none is actionable the layer yields and power recovery
      // (which already outranks this layer) keeps building generators first.
      .filter((candidate) => powerSafeToBuild(candidate))
      .map((candidate) => ({ candidate, ...projectScienceClosure(candidate, need, resources), wait: waitSecondsForCandidate(candidate, resources) }))
      .filter((item) => item.reachable && isFinite(item.eta));
    if (!options.length) { activeScienceUnlockId = null; activeScienceUnlockContext = null; return null; }
    // Rank storage fixes by the actual storage problem, not generic ROI: prefer
    // cheap/immediate cap gain per limiting-resource ETA, with a penalty for
    // transitive craft chains that collide with the manual queue. This makes a
    // close Library keep winning over a flashy Observatory/Bio Lab/Temple unless
    // the latter is materially faster.
    const queueLedger = manualQueueReservationLedger(resources);
    for (const option of options) {
      const ledger = buildTargetLedger(option.candidate, resources);
      const conflict = Object.keys(ledger.reserved).some((name) => (queueLedger.reserved[name] || 0) > 0) ? 1 : 0;
      const eta = Math.max(1, option.eta);
      const work = eta + option.copies * 0.25;
      option.planScore = option.closure / Math.max(1, work) /
        (1 + Object.keys(ledger.reserved).length * 0.04 + conflict * 0.75);
    }
    options.sort((a, b) => (b.closure - a.closure) || (b.planScore - a.planScore) || (a.eta - b.eta) || (a.copies - b.copies) || (b.gain - a.gain) || ((b.candidate.score || 0) - (a.candidate.score || 0)));
    // Commit to the prior choice while it is still a valid option; only switch when
    // a rival actually improves the storage ETA/score by a meaningful hysteresis
    // margin.  When gains tie at 0 this always keeps the prior pick, killing the
    // Library↔Observatory flicker.
    const best = options[0];
    const prior = activeScienceUnlockId && options.find((o) => scienceUnlockOptionId(o.candidate) === activeScienceUnlockId);
    const chosen = prior && !(best.closure > prior.closure + 0.2 ||
      (best.closure >= prior.closure && best.planScore > prior.planScore * 1.25 && best.eta < prior.eta * 0.8)) ? prior : best;
    activeScienceUnlockId = scienceUnlockOptionId(chosen.candidate);
    return { target: chosen.candidate, blocked, need, options: options.slice(0, 3) };
  };

  // Some buildings stay hidden until the player owns a fraction of a newly
  // craftable price resource.  Discover that requirement from live metadata
  // instead of keeping a list of Concrete/Tanker/etc. special cases.
  const metaGrantsBuilding = (meta, buildingName) => {
    if (!meta || !buildingName) return false;
    for (const node of [meta.unlocks, meta.upgrades]) {
      if (!node || typeof node !== "object") continue;
      for (const list of [node.buildings, node.building]) {
        if (Array.isArray(list) && list.includes(buildingName)) return true;
      }
    }
    return false;
  };

  const hiddenBuildingBootstrapAllowed = (raw) => {
    const live = liveMetaView(raw) || raw;
    if (raw.defaultUnlockable || (live && live.defaultUnlockable)) return true;
    const name = raw && raw.name;
    if (!name) return false;
    try {
      for (const source of buildingMetas()) {
        if (source && source.name !== name && metaGrantsBuilding(source, name) && (source.val || source.on || 0) > 0) return true;
      }
    } catch (error) {
      /* ignore source scan failures */
    }
    try {
      for (const source of techList()) {
        if (source && metaGrantsBuilding(source, name) && source.researched) return true;
      }
    } catch (error) {
      /* ignore source scan failures */
    }
    try {
      for (const source of (window.gamePage.workshop && window.gamePage.workshop.upgrades) || []) {
        if (source && metaGrantsBuilding(source, name) && (source.researched || source.on || source.val)) return true;
      }
    } catch (error) {
      /* ignore source scan failures */
    }
    try {
      for (const source of religionUpgrades()) {
        if (source && metaGrantsBuilding(source, name) && religionUpgradePurchased(source)) return true;
      }
    } catch (error) {
      /* ignore source scan failures */
    }
    return false;
  };

  // Reveal-crafting is only a FOCUS when nothing else would ever make the
  // resource: a craft-only price resource with no job path and no live
  // production (the first Manuscript, Concrete, Tanker).  A price resource
  // with an ordinary work path (wood for Log House / Lumber Mill / Academy)
  // accrues through normal play and the game reveals the building on its own —
  // focusing those stalled early saves on "revealing" instead of buying ready
  // work (the v2.11.5 regression that disabled this layer entirely).  The
  // reveal craft must also be quick (reach ETA-bounded) so a weak economy is
  // never parked on a long reveal grind.
  const BOOTSTRAP_MAX_ETA_S = 3600;

  const bootstrapResourceCandidate = (resources = resourceMap()) => {
    const options = [];
    for (const raw of buildingMetas()) {
      if (!raw || raw.unlocked !== false || !(raw.unlockable || raw.defaultUnlockable)) continue;
      if (!hiddenBuildingBootstrapAllowed(raw)) continue;
      const live = liveMetaView(raw) || raw;
      const ratio = isFinite(live.unlockRatio) ? Math.max(0, live.unlockRatio) : null;
      if (ratio == null || ratio <= 0) continue;
      for (const price of live.prices || raw.prices || []) {
        if (!price || !price.name || !(price.val > 0) || !craftByName(price.name)) continue;
        if (resourceHasDirectJobPath(price.name) || rawProductionForNeed(price.name) > 0) continue;
        const targetAmount = Math.max(1, price.val * ratio);
        const have = resValueOf(resources, price.name);
        if (have >= targetAmount) continue;
        const meta = {
          name: `bootstrap-${price.name}-for-${raw.name}`,
          label: `${craftLabel(price.name)} for ${labelOf(raw)}`,
          prices: [{ name: price.name, val: targetAmount }],
          outputName: price.name,
          targetAmount,
          downstreamName: raw.name,
          downstreamLabel: labelOf(raw),
        };
        const candidate = { kind: "bootstrap", weight: 5, meta, ...evaluate("bootstrap", meta, resources), score: 100 };
        const reach = capDrainReachabilityFor(resources, price.name, targetAmount);
        if (reach.reachable && (reach.eta || 0) <= BOOTSTRAP_MAX_ETA_S) options.push({ candidate, eta: reach.eta || 0 });
      }
    }
    options.sort((a, b) => a.eta - b.eta || a.candidate.meta.targetAmount - b.candidate.meta.targetAmount);
    return options.length ? options[0].candidate : null;
  };

  /* ---------------- opportunity-costed staged-building transitions --------- */

  const STAGE_PAYBACK_HORIZON_SECONDS = 6 * 60 * 60;
  // The net-bill GATHER time gets its own (much longer) bound instead of being
  // charged against the payback horizon.  While the bill accrues the old stack
  // keeps producing — gathering costs nothing but delay — yet a mature stack
  // (79 Aqueducts, 71 Libraries) has a parity rebuild bill whose gather ETA
  // alone exceeds 6h, so folding it into payback made every big-stack upgrade
  // (Aqueduct→Hydro Plant, Library→Data Center, …) permanently non-actionable.
  // The 6h payback horizon now bounds only the true loss recovery (rebuild
  // downtime + refund burn, recouped by remainder + growth advantage); the
  // gather bound below merely keeps the plan from chasing a week-long bill.
  const STAGE_GATHER_HORIZON_SECONDS = 24 * 60 * 60;
  const STAGE_COOLDOWN_MS = 10 * 60 * 1000;
  // A stage change burns half the old stack, so flapping back is genuinely
  // expensive: after any transition the REVERSE direction stays blocked much
  // longer than the general per-building cooldown. Seasonal pressure swings
  // (winter catnip dips) must not churn Solar Farm ↔ Pasture every cycle —
  // the farmer failsafe owns transient food dips, not the stage layer.
  const STAGE_REVERSE_COOLDOWN_MS = 60 * 60 * 1000;
  // Rebuild downtime model: with the net bill banked before the sell, parity
  // copies go back up at roughly one executor buy per plan tick.
  const STAGE_REBUILD_SECONDS_PER_COPY = 4;
  const STAGE_GATHER_FLOOR_SECONDS = 30;
  const stageCooldownUntil = Object.create(null);
  const stageReverseGuard = Object.create(null);
  const STAGE_REBUILD_KEY = "kgh.stageRebuild";
  // The sell half of a stage change must survive a page reload — otherwise
  // the refunded bank loses its atomic-rebuild reservation and surplus buys
  // eat it before effect parity is restored.
  let pendingStageRebuild = (() => {
    try {
      const stored = JSON.parse(localStorage.getItem(STAGE_REBUILD_KEY) || "null");
      return stored && typeof stored.buildingName === "string" && isFinite(stored.stage) && isFinite(stored.targetCount)
        ? stored : null;
    } catch (error) {
      return null;
    }
  })();
  const setPendingStageRebuild = (value) => {
    pendingStageRebuild = value;
    try {
      if (value) {
        localStorage.setItem(STAGE_REBUILD_KEY, JSON.stringify({
          buildingName: value.buildingName, stage: value.stage, targetCount: value.targetCount, startedAt: value.startedAt,
        }));
      } else {
        localStorage.removeItem(STAGE_REBUILD_KEY);
      }
    } catch (error) {
      /* storage unavailable — the contract stays in-memory */
    }
  };

  const profileFromEffects = (effects) => {
    const profile = emptyEffectProfile();
    for (const [key, value] of Object.entries(effects || {})) parseEffectEntry(profile, key, value);
    return profile;
  };

  const stageMetaView = (raw, stage) => {
    if (!raw || !Array.isArray(raw.stages) || !raw.stages.length) return liveMetaView(raw) || raw;
    const bounded = Math.max(0, Math.min(raw.stages.length - 1, Number(stage) || 0));
    if (bounded === (Number(raw.stage) || 0)) return liveMetaView(raw, bounded);
    // Calculate the alternate stage on a clone so dynamic values (notably Data
    // Center scienceMax) are visible without changing the live save.
    const clone = {
      ...raw,
      stage: bounded,
      val: 0,
      on: 0,
      effects: { ...(raw.effects || {}) },
      stages: raw.stages.map((item) => ({ ...item, effects: { ...((item && item.effects) || {}) } })),
    };
    try {
      if (typeof raw.calculateEffects === "function") raw.calculateEffects(clone, window.gamePage);
    } catch (error) {
      /* static stage metadata remains usable */
    }
    return { ...clone, ...(clone.stages[bounded] || {}), stage: bounded };
  };

  // Watts have utility only when the live grid actually consumes them —
  // otherwise a Hydro Plant would outrank the Aqueduct's catnip before
  // electricity even exists, and the free post-reset downgrade back to the
  // catnip stage could never win. A strained grid values each new Wt far
  // above an overbuilt one; the winter production floor keeps solar-style
  // generators honest. Without this credit generator stages read as worth
  // ~nothing, so Aqueduct→Hydro Plant could literally never pass the utility
  // gate while a spurious generator DOWNGRADE could (held back only by the
  // hard power veto).
  const stageEnergyUtility = (watts) => {
    if (!(watts > 0)) return 0;
    const power = powerStatus();
    const demand = Math.max(0, power.cons);
    if (!(demand > 0)) return 0;
    const supply = Math.max(0, Math.min(power.prod, power.winterProd));
    const tightness = Math.min(2, demand / Math.max(1, supply));
    return Math.min(30, (watts / Math.max(1, supply + watts)) * 12 * (0.5 + tightness));
  };

  const stageUnitUtility = (view, resources) => {
    const profile = profileFromEffects((view && view.effects) || {});
    let utility = 0;
    const catnipRatio = resRatio(resources, "catnip", 1);
    const catnipRate = productionFor("catnip");
    const catnipPressure = Math.max(
      0,
      catnipRatio < 0.5 ? (0.5 - catnipRatio) * 2 : 0,
      catnipRate < 0 ? Math.min(2, -catnipRate / Math.max(1, Math.abs(catnipRate))) : 0,
    );
    for (const [name, amount] of Object.entries(profile.max || {})) {
      const cap = Math.max(1, resMaxOf(resources, name));
      const pressure = resRatio(resources, name, 0);
      utility += Math.max(0, amount) / cap * (8 + pressure * 24);
    }
    for (const [name, amount] of Object.entries(profile.perTick || {})) {
      const perSecond = amount * ticksPerSecond();
      const current = Math.abs(productionFor(name));
      utility += perSecond > 0 ? perSecond / Math.max(0.01, current + perSecond) * 12 : perSecond / Math.max(0.01, current - perSecond) * 8;
    }
    for (const [name, amount] of Object.entries(profile.ratio || {})) {
      if (amount > 0 && productionFor(name) > 0) utility += Math.min(2, amount) * 8;
      if (name === "catnip" && amount > 0 && catnipPressure > 0) {
        // Food-pressure stage checks must value live catnip relief even when
        // net catnip is currently negative; the ordinary positive-production
        // ratio branch above deliberately skips that emergency case.
        utility += Math.min(3, amount) * (18 + catnipPressure * 34);
        if (rawProductionForNeed("wood") <= 0 || resRatio(resources, "wood", 1) < 0.35) {
          utility += Math.min(2, amount) * catnipPressure * (1 + craftRatioFor("wood")) * 8;
        }
      }
    }
    for (const [name, amount] of Object.entries(profile.demand || {})) {
      if (amount < 0) utility += Math.min(8, -amount * 80 * (name === "catnip" ? 1 + catnipPressure : 1));
    }
    utility += Math.max(0, profile.housing || 0) * 8;
    utility += Math.max(0, profile.happiness || 0) * 5;
    utility += stageEnergyUtility(profile.energyProduction || 0);
    const effects = (view && view.effects) || {};
    utility -= Math.max(0, effects.energyConsumption || 0) * 0.8;
    for (const [key, value] of Object.entries(effects)) {
      if (/PerTickCon$/i.test(key) && value < 0) utility -= Math.min(10, Math.abs(value) * ticksPerSecond());
    }
    return Math.max(0.0001, utility);
  };

  const addPriceMap = (map, name, amount) => {
    if (!name || !(amount > 0)) return;
    map[name] = (map[name] || 0) + amount;
  };

  const currentStagePriceModel = (raw) => {
    const currentStage = Math.max(0, Number(raw && raw.stage) || 0);
    const view = stageMetaView(raw, currentStage) || {};
    const baseRatio = Math.max(1, Number(view.priceRatio || raw.priceRatio) || 1);
    let liveRatio = baseRatio;
    let livePrices = [];
    try {
      const bld = window.gamePage && window.gamePage.bld;
      if (bld && typeof bld.getPriceRatio === "function") liveRatio = Math.max(1, Number(bld.getPriceRatio(raw.name)) || baseRatio);
      if (bld && typeof bld.getPrices === "function") livePrices = bld.getPrices(raw.name) || [];
    } catch (error) {
      /* use conservative stage metadata */
    }
    const owned = Math.max(0, Number(raw && raw.val) || 0);
    const modifiers = {};
    for (const base of view.prices || []) {
      const live = livePrices.find((price) => price && price.name === base.name);
      const undiscounted = base.val * Math.pow(liveRatio, owned);
      if (live && live.val >= 0 && undiscounted > 0) modifiers[base.name] = Math.max(0, live.val / undiscounted);
    }
    return { stage: currentStage, ratio: liveRatio, modifiers };
  };

  const cumulativeStagePrices = (raw, stage, count) => {
    const view = stageMetaView(raw, stage) || {};
    const liveModel = currentStagePriceModel(raw);
    // The live manager can calculate the active stage exactly. For an alternate
    // stage, keep its metadata ratio (normally an upper bound after reductions)
    // but carry across measured building/resource cost-reduction modifiers.
    const ratio = stage === liveModel.stage
      ? liveModel.ratio
      : Math.max(1, Number(view.priceRatio || raw.priceRatio) || 1);
    const totals = {};
    for (let index = 0; index < Math.max(0, count); index += 1) {
      const mult = Math.pow(ratio, index);
      for (const price of view.prices || []) {
        const modifier = Object.prototype.hasOwnProperty.call(liveModel.modifiers, price.name) ? liveModel.modifiers[price.name] : 1;
        addPriceMap(totals, price.name, price.val * mult * modifier);
      }
    }
    return totals;
  };

  const remainingStagePrices = (raw, stage, targetCount) => {
    const owned = Math.max(0, Number(raw && raw.val) || 0);
    const throughTarget = cumulativeStagePrices(raw, stage, Math.max(owned, targetCount));
    const alreadyOwned = cumulativeStagePrices(raw, stage, owned);
    const remaining = {};
    for (const name of new Set([...Object.keys(throughTarget), ...Object.keys(alreadyOwned)])) {
      const amount = Math.max(0, (throughTarget[name] || 0) - (alreadyOwned[name] || 0));
      if (amount > 0) remaining[name] = amount;
    }
    return remaining;
  };

  const refundableStagePrices = (raw, stage, count) => {
    const invested = cumulativeStagePrices(raw, stage, count);
    const refund = {};
    for (const [name, amount] of Object.entries(invested)) {
      const res = getRes(resourceMap(), name);
      let refundable = true;
      try { if (res && typeof res.isRefundable === "function") refundable = !!res.isRefundable(window.gamePage); } catch (error) { /* assume normal resource */ }
      if (refundable) refund[name] = amount * 0.5;
    }
    return refund;
  };

  // Live seconds to fund ONE more copy at the given stage/count — the common
  // denominator for comparing growth rates across stages. The floor keeps an
  // already-banked price from reading as an infinite build rate.
  const stageCopyGatherSeconds = (raw, stage, count, resources) => {
    const view = stageMetaView(raw, stage) || {};
    const model = currentStagePriceModel(raw);
    const ratio = stage === model.stage ? model.ratio : Math.max(1, Number(view.priceRatio || raw.priceRatio) || 1);
    let seconds = 0;
    for (const price of view.prices || []) {
      if (!price || !price.name || !(price.val > 0)) continue;
      const modifier = Object.prototype.hasOwnProperty.call(model.modifiers, price.name) ? model.modifiers[price.name] : 1;
      const reach = capDrainReachabilityFor(resources, price.name, price.val * Math.pow(ratio, Math.max(0, count)) * modifier);
      if (!reach.reachable) return Number.POSITIVE_INFINITY;
      seconds = Math.max(seconds, reach.eta || 0);
    }
    return Math.max(STAGE_GATHER_FLOOR_SECONDS, seconds);
  };

  // Seconds until remainder·t + ½·growth·t² covers `loss` utility-seconds —
  // a standing utility surplus recoups linearly, a growth-rate advantage
  // quadratically, and a decaying advantage may never get there.
  const recoupSeconds = (loss, linearRate, growthRate) => {
    if (!(loss > 0)) return 0;
    const r = Math.max(0, linearRate || 0);
    const g = isFinite(growthRate) ? growthRate : 0;
    if (Math.abs(g) < 1e-9) return r > 1e-9 ? loss / r : Number.POSITIVE_INFINITY;
    const disc = r * r + 2 * g * loss;
    if (disc <= 0) return Number.POSITIVE_INFINITY;
    const root = Math.sqrt(disc);
    return g > 0 ? (root - r) / g : (r - root) / -g;
  };

  const stageTransitionAnalysis = (raw, toStage, resources = resourceMap()) => {
    if (!raw || !Array.isArray(raw.stages)) return { actionable: false, reason: "not a staged building" };
    const fromStage = Math.max(0, Number(raw.stage) || 0);
    const targetStage = Math.max(0, Math.min(raw.stages.length - 1, Number(toStage) || 0));
    if (targetStage === fromStage) return { actionable: false, reason: "already on target stage" };
    const targetStageMeta = raw.stages[targetStage];
    if (!targetStageMeta || targetStageMeta.stageUnlocked === false) return { actionable: false, reason: "target stage locked" };
    const currentView = stageMetaView(raw, fromStage);
    const targetView = stageMetaView(raw, targetStage);
    const owned = Math.max(0, Number(raw.val) || 0);
    const active = Math.max(0, Number(raw.on) || owned);
    const currentUnitUtility = stageUnitUtility(currentView, resources);
    const targetUnitUtility = stageUnitUtility(targetView, resources);
    const currentUtility = currentUnitUtility * active;
    // parityCount restores the aggregate utility the old stack provided. A
    // stack that was never built (val 0) has nothing to restore — the switch
    // itself is free and executes immediately. The 1e-6 slack keeps floating-
    // point dust from buying a needless extra copy on an exact-ratio parity.
    const maxParity = Math.max(1, owned * 10 || 10);
    const parityCount = owned > 0
      ? Math.min(maxParity, Math.max(1, Math.ceil(currentUtility / Math.max(0.0001, targetUnitUtility) - 1e-6)))
      : 0;
    const targetUtility = targetUnitUtility * parityCount;
    const refund = refundableStagePrices(raw, fromStage, owned);
    const rebuild = cumulativeStagePrices(raw, targetStage, parityCount);
    // The game sells the old stack before rebuilding. Only the part of each
    // refund that fits in the live bank is guaranteed to survive that moment;
    // treat overflow as lost rather than optimistically funding the rebuild.
    const usableRefund = {};
    const refundLoss = {};
    for (const [name, amount] of Object.entries(refund)) {
      const cap = resMaxOf(resources, name);
      const headroom = cap > 0 ? Math.max(0, cap - resValueOf(resources, name)) : amount;
      usableRefund[name] = Math.min(amount, headroom);
      if (amount > usableRefund[name]) refundLoss[name] = amount - usableRefund[name];
    }
    const net = {};
    for (const name of new Set([...Object.keys(rebuild), ...Object.keys(usableRefund)])) {
      net[name] = Math.max(0, (rebuild[name] || 0) - (usableRefund[name] || 0));
      if (!(net[name] > 0)) delete net[name];
    }
    // The switch only fires once the whole net bill is BANKED (the sell and
    // the parity rebuild are one atomic transaction), so a net price above a
    // live cap is storage-blocked no matter how the resource is produced —
    // the same v2.14 final-cap invariant as ordinary purchases. Without this
    // the layer kept re-picking a never-affordable transition, flapping the
    // plan lock every reject-cooldown instead of yielding to the storage
    // planner that could actually grow the cap.
    const capBlockers = [];
    for (const [name, amount] of Object.entries(net)) {
      const cap = resMaxOf(resources, name);
      if (cap > 0 && amount > cap) capBlockers.push(`${resTitle(resources, name)} storage ${fmt(cap)}/${fmt(amount)}`);
    }
    let reachable = true;
    let eta = 0;
    for (const [name, amount] of Object.entries(net)) {
      const reach = capDrainReachabilityFor(resources, name, amount);
      if (!reach.reachable) reachable = false;
      eta = Math.max(eta, reach.eta || 0);
    }
    const currentProfile = profileFromEffects((currentView && currentView.effects) || {});
    const targetProfile = profileFromEffects((targetView && targetView.effects) || {});
    const safetyVetoes = [];
    for (const name of new Set([...Object.keys(currentProfile.max || {}), ...Object.keys(targetProfile.max || {})])) {
      const lostCapacity = Math.max(0, (currentProfile.max[name] || 0) * owned - (targetProfile.max[name] || 0) * parityCount);
      const postCap = Math.max(0, resMaxOf(resources, name) - lostCapacity);
      if (lostCapacity > 0 && resValueOf(resources, name) > postCap * 0.98) safetyVetoes.push(`${resTitle(resources, name)} would exceed post-transition cap`);
    }
    const currentNetEnergy = profileNetEnergy(currentProfile) * active;
    const targetNetEnergy = profileNetEnergy(targetProfile) * parityCount;
    const netEnergyDelta = targetNetEnergy - currentNetEnergy;
    if (netEnergyDelta < 0) {
      const power = powerStatus();
      if (power.delta + netEnergyDelta < TUNING.powerHeadroom || power.winterDelta + netEnergyDelta < 0) {
        safetyVetoes.push("target stage would break power safety");
      }
    }
    // Parity equalizes aggregate utility BY CONSTRUCTION, so the old
    // "targetUtility > currentUtility × 1.05" test only measured the ceil()
    // remainder: an exact-ratio upgrade (15 Libraries → 5 Data Centers at 3×
    // the unit) read "worse after rebuild" forever. The real question is
    // unit-level — is one target building worth more than one current
    // building right now? — with 5% hysteresis so the reverse transition can
    // never qualify at the same time.
    const unitAdvantage = targetUnitUtility - currentUnitUtility;
    const unitBetter = targetUnitUtility > currentUnitUtility * 1.05;
    // While the net bill accrues the old stack keeps producing, so gather
    // time (eta) only DELAYS the payoff. The genuine downtime is the rebuild
    // window after the sell — parity copies going back up one buy at a time.
    const lostUtility = currentUtility * parityCount * STAGE_REBUILD_SECONDS_PER_COPY / 2;
    // The lasting return is growth-rate: after parity the next copy is priced
    // at ratio^parityCount instead of ratio^owned and carries the better
    // unit. Compare utility per funding-second on both sides with the same
    // live gather ETAs; the standing remainder (the ceil() surplus, when any)
    // recoups linearly on top.
    const remainder = Math.max(0, targetUtility - currentUtility);
    const growthAdvantage = owned > 0
      ? targetUnitUtility / stageCopyGatherSeconds(raw, targetStage, parityCount, resources) -
        currentUnitUtility / stageCopyGatherSeconds(raw, fromStage, owned, resources)
      : 0;
    const recoup = owned > 0 ? recoupSeconds(lostUtility, remainder, growthAdvantage) : 0;
    const payback = owned > 0 ? eta + recoup : 0;
    // Ranking gain keeps exact-parity transitions (remainder 0) sortable and
    // gives free val-0 switches their unit advantage as the score.
    const rankGain = remainder + Math.max(0, unitAdvantage);
    const actionable = reachable && !capBlockers.length && !safetyVetoes.length && unitBetter &&
      recoup <= STAGE_PAYBACK_HORIZON_SECONDS && eta <= STAGE_GATHER_HORIZON_SECONDS;
    const reason = actionable
      ? (owned > 0
        ? `unit utility +${Math.round((targetUnitUtility / Math.max(0.0001, currentUnitUtility) - 1) * 100)}%, payback ${formatEta(payback)}`
        : "free switch — nothing built to sell")
      : !unitBetter ? "target stage utility is worse per unit"
        : safetyVetoes.length ? `safety veto: ${safetyVetoes[0]}`
          : capBlockers.length ? `storage cap blocks the net rebuild bill (${capBlockers[0]})`
            : !reachable ? "rebuild chain unreachable"
              : recoup > STAGE_PAYBACK_HORIZON_SECONDS ? `payback ${formatEta(recoup)} exceeds planning horizon`
                : `net bill gather ${formatEta(eta)} exceeds the ${formatEta(STAGE_GATHER_HORIZON_SECONDS)} funding horizon`;
    return {
      actionable, reason, raw, fromStage, toStage: targetStage, fromLabel: currentView.label || raw.name,
      toLabel: targetView.label || raw.name, owned, active, currentUnitUtility, targetUnitUtility,
      currentUtility, targetUtility, parityCount, refund, usableRefund, refundLoss, rebuild, net, eta, lostUtility,
      incrementalUtility: remainder, unitAdvantage, growthAdvantage, rankGain, capBlockers, recoup, payback, safetyVetoes,
      currentEffects: { ...((currentView && currentView.effects) || {}) },
      targetEffects: { ...((targetView && targetView.effects) || {}) },
    };
  };

  const stageTransitionCandidate = (raw, toStage, resources = resourceMap(), precomputed = null) => {
    const analysis = precomputed || stageTransitionAnalysis(raw, toStage, resources);
    if (!analysis.actionable) return null;
    const prices = Object.entries(analysis.net).map(([name, val]) => ({ name, val }));
    const meta = {
      name: `stage-${raw.name}-${analysis.fromStage}-to-${analysis.toStage}`,
      label: `${analysis.toStage > analysis.fromStage ? "Upgrade" : "Downgrade"} ${analysis.fromLabel} → ${analysis.toLabel}`,
      prices,
      effects: analysis.targetEffects,
      building: raw,
      buildingName: raw.name,
      delta: analysis.toStage - analysis.fromStage,
      analysis,
      unlocked: true,
    };
    const evaluated = evaluate("stage", meta, resources);
    // A val-0 switch has no net bill; evaluate() reads "no costs" as
    // unaffordable, but a free transition is buyable on sight.
    if (!prices.length) Object.assign(evaluated, { affordable: true, progress: 1, missing: "" });
    return { kind: "stage", weight: 5, meta, ...evaluated, score: 60 + Math.min(40, analysis.rankGain) };
  };

  // Every staged building's best-transition verdict — actionable or the exact
  // blocking reason.  Non-actionable analyses used to be dropped silently, so
  // the panel/report could not answer "why hasn't Aqueduct→Hydro Plant /
  // Library→Data Center happened yet?".  Surfaced as the `Stage:` subsystem
  // line and pinned by Test X5.
  let stagePlanText = "Stage: no staged buildings unlocked";
  const stageTransitionCandidates = (resources = resourceMap()) => {
    const options = [];
    const verdicts = [];
    const now = Date.now();
    for (const raw of buildingMetas()) {
      // val 0 is deliberately allowed: switching an empty stack is free (no
      // refund, no downtime), which is exactly the post-reset "Hydro Plant
      // stuck where an Aqueduct should be" fix.
      if (!raw || !Array.isArray(raw.stages) || raw.unlocked === false) continue;
      if ((stageCooldownUntil[raw.name] || 0) > now) {
        verdicts.push(`${labelOf(raw)} on cooldown ${formatEta(((stageCooldownUntil[raw.name] || 0) - now) / 1000)}`);
        continue;
      }
      const stage = Math.max(0, Number(raw.stage) || 0);
      const guard = stageReverseGuard[raw.name];
      let best = null;
      for (const toStage of [stage - 1, stage + 1]) {
        if (toStage < 0 || toStage >= raw.stages.length) continue;
        if (guard && guard.until > now && Math.sign(toStage - stage) === -Math.sign(guard.direction)) continue;
        const analysis = stageTransitionAnalysis(raw, toStage, resources);
        const candidate = analysis.actionable ? stageTransitionCandidate(raw, toStage, resources, analysis) : null;
        if (candidate) options.push(candidate);
        if (!best ||
            (analysis.actionable && !best.actionable) ||
            (!!analysis.actionable === !!best.actionable && (analysis.rankGain || 0) > (best.rankGain || 0))) {
          best = analysis;
        }
      }
      if (best && best.fromLabel && best.toLabel) {
        verdicts.push(`${best.fromLabel}→${best.toLabel}: ${best.actionable ? `GO — ${best.reason}` : best.reason}`);
      }
    }
    stagePlanText = verdicts.length ? `Stage: ${verdicts.join(" · ")}` : "Stage: no staged buildings unlocked";
    return options;
  };

  const bestStageTransition = (resources = resourceMap(), candidates = null) => {
    const options = candidates ? [...candidates] : stageTransitionCandidates(resources);
    options.sort((a, b) => (b.meta.analysis.rankGain / Math.max(1, b.meta.analysis.payback + 1)) -
      (a.meta.analysis.rankGain / Math.max(1, a.meta.analysis.payback + 1)));
    return options[0] || null;
  };

  const pendingStageRebuildCandidate = (candidates, resources) => {
    if (!pendingStageRebuild) return null;
    const raw = buildingMetas().find((building) => building && building.name === pendingStageRebuild.buildingName);
    if (!raw || (Number(raw.stage) || 0) !== pendingStageRebuild.stage) {
      setPendingStageRebuild(null);
      return null;
    }
    if ((raw.val || 0) >= pendingStageRebuild.targetCount) {
      setPendingStageRebuild(null);
      return null;
    }
    const candidate = candidates.find((item) => item.kind === "build" && item.meta === raw) ||
      { kind: "build", weight: 5, meta: raw, ...evaluate("build", raw, resources), score: 100 };
    candidate._stageRebuild = {
      ...pendingStageRebuild,
      remainingPrices: remainingStagePrices(raw, pendingStageRebuild.stage, pendingStageRebuild.targetCount),
    };
    return candidate;
  };

  const executeStageTransitionCandidate = (candidate) => {
    if (!candidate || candidate.kind !== "stage" || !candidate.meta || !candidate.meta.building) return false;
    const raw = candidate.meta.building;
    const beforeStage = Number(raw.stage) || 0;
    const Controller = getGlobalPath(["classes", "ui", "btn", "StagingBldBtnController"]);
    if (typeof Controller !== "function") return false;
    try {
      const controller = new Controller(window.gamePage);
      const opts = { building: raw.name, controller };
      const model = controller.fetchModel(opts);
      if (!model || typeof controller.deltagrade !== "function") return false;
      controller.deltagrade(model, candidate.meta.delta);
      if ((Number(raw.stage) || 0) === beforeStage) return false;
      // A free val-0 switch has no parity to restore — no rebuild contract
      // (and it must not clobber another building's pending contract).
      if (candidate.meta.analysis.parityCount > 0) {
        setPendingStageRebuild({
          buildingName: raw.name,
          stage: Number(raw.stage) || 0,
          targetCount: candidate.meta.analysis.parityCount,
          startedAt: Date.now(),
          analysis: candidate.meta.analysis,
        });
      } else if (pendingStageRebuild && pendingStageRebuild.buildingName === raw.name) {
        setPendingStageRebuild(null);
      }
      stageCooldownUntil[raw.name] = Date.now() + STAGE_COOLDOWN_MS;
      stageReverseGuard[raw.name] = { direction: candidate.meta.delta, until: Date.now() + STAGE_REVERSE_COOLDOWN_MS };
      return true;
    } catch (error) {
      return false;
    }
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
      if (kind === "ziggurat") return zigguratUpgrades().find((u) => u.name === name) || null;
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

  // Why the manual queue is / is not driving the plan, for the panel and the
  // diagnostics report — "my queue is not pushing through" must be answerable
  // from the report alone (front item + the exact blocker).
  let queuePlanText = "Queue: empty";

  const pickQueuedTarget = (candidates, resources) => {
    const queue = readQueue();
    if (!queue.length) {
      queuePlanText = "Queue: empty";
      return null;
    }
    let chosen = null;
    let changed = false;
    let frontStatus = "";
    const remaining = [];
    for (const item of queue) {
      if (queueItemDone(item)) { changed = true; continue; } // drop finished item, advance
      remaining.push(item);
      if (chosen) continue;
      const candidate = findCandidateById(candidates, item.id);
      if (!candidate) {
        const meta = lookupMetaById(item.id);
        if (!frontStatus) frontStatus = `${meta ? labelOf(meta) : item.id} waiting to unlock — skipped`;
        continue;
      }
      const solver = solveCraftChain(resources, candidate);
      if (solver.reachable) {
        chosen = { candidate, solver }; // first actionable item wins
      } else if (!frontStatus) {
        const blocker = (solver.blockers && solver.blockers[0] && solver.blockers[0].text) || "chain unreachable";
        frontStatus = `${labelOf(candidate.meta)} blocked — ${blocker}; skipped`;
      }
    }
    if (changed) writeQueue(remaining);
    const extra = remaining.length > 1 ? ` (+${remaining.length - 1} more queued)` : "";
    queuePlanText = !remaining.length ? "Queue: empty"
      : chosen ? `Queue: driving the plan — ${labelOf(chosen.candidate.meta)}${frontStatus ? ` (ahead of it: ${frontStatus})` : ""}${extra}`
      : `Queue: ${frontStatus || "nothing actionable"}${extra}`;
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
    if (candidate.kind === "religion" || candidate.kind === "ziggurat" || candidate.kind === "space" || candidate.kind === "time" ||
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

  /* ------------------------- ziggurat / unicorn path -------------------------
   * The unicorn economy is a parallel currency loop the player used to run by
   * hand: Unicorn Pastures make unicorns; sacrificing unicorns at a Ziggurat
   * yields tears; tears + ivory/gold/megaliths buy the ziggurat upgrades that
   * multiply unicorn production and eventually unlock alicorns.  The planner
   * ranks every open step of that loop in ONE currency — unicorn-equivalents —
   * so "buy a pasture", "sacrifice for the Tomb" and "build another Ziggurat
   * first" are directly comparable (all rates read LIVE, per rule 4):
   *   - a pasture's marginal gain is live unicorn production ÷ owned pastures
   *     (base production is linear in count); its cost is its live price;
   *   - a ratio upgrade's gain is P × Δr ÷ (1 + r), with P (live unicorns/s)
   *     and r (live unicornsRatioReligion) both read from the game; its
   *     unicorn cost is tears × (batch ÷ ziggurats) + any direct unicorns;
   *   - one more Ziggurat cuts every future tear to batch ÷ (z+1) unicorns, so
   *     when that saving covers ≥25% of the chosen upgrade's unicorn bill AND
   *     the Ziggurat itself is reachable, the planner builds the Ziggurat
   *     BEFORE sacrificing (the "rush ziggurats" rule).
   * The layer claims the plan only when the pick's unicorn side is already
   * funded (bank + sacrificable tears) and the SHARED currencies (ivory, gold,
   * megaliths) are what's missing — exactly when a reservation finishes the
   * purchase instead of surplus buys eating it.  An upgrade whose first copy
   * unlocks alicorns is a content unlock and may claim regardless of payback.
   * Everything else (the actual sacrifice, pasture-vs-upgrade balance, status)
   * runs in the manageUnicornReligion subsystem every tick.
   */
  const UNICORN_PAYBACK_HORIZON_S = 6 * 3600; // rush only reasonably-paced upgrades
  const UNICORN_ZIG_FIRST_SAVINGS = 0.25;     // build a Ziggurat first when it saves ≥25% of the pick's unicorn bill
  const UNICORN_SACRIFICE_MIN_MS = 15000;     // batch sacrifices; keeps the action log readable

  let unicornPlanText = "Unicorns: watching the unicorn economy";
  let unicornPlanCache = { key: null, plan: null };
  let activeUnicornPathId = null; // sticky pick (mirrors the power/science commits)
  let lastUnicornSacrificeAt = 0;

  const unicornItemId = (item) => `${item.kind}:${item.meta.name}`;

  // Live religion multiplier on unicorn production: prefer the game's own
  // getEffect; fall back to summing owned upgrades' live metadata.
  const liveUnicornReligionRatio = () => {
    try {
      const viaEffect = window.gamePage.getEffect && window.gamePage.getEffect("unicornsRatioReligion");
      if (isFinite(viaEffect) && viaEffect > 0) return viaEffect;
    } catch (error) {
      /* fall through to metadata */
    }
    let total = 0;
    for (const meta of zigguratUpgrades()) {
      const each = meta && meta.effects && meta.effects.unicornsRatioReligion;
      if (isFinite(each) && each > 0) total += each * (meta.val || 0);
    }
    return total;
  };

  // Unicorn-denominated share of a price list: direct unicorns plus tears at
  // the live sacrifice exchange rate.  Shared currencies (ivory, gold,
  // megaliths…) are gated by ordinary affordability/reservations instead of
  // being folded into this ranking.
  const unicornEquivalentCost = (prices) => {
    let unicorns = 0;
    let tears = 0;
    for (const price of prices || []) {
      if (!price || !isFinite(price.val) || price.val <= 0) continue;
      if (price.name === "unicorns") unicorns += price.val;
      if (price.name === "tears") tears += price.val;
    }
    const conversion = sacrificeConversionFor("tears");
    const tearCost = tears > 0
      ? (conversion ? tears * (conversion.inputPerChunk / conversion.gainPerChunk) : Number.POSITIVE_INFINITY)
      : 0;
    return { unicorns, tears, total: unicorns + tearCost };
  };

  const unicornEconomyPlan = (resources) => {
    const plan = { open: false, items: [], best: null, zigguratFirst: null, summary: [], action: "" };
    const pasture = buildingByName("unicornPasture");
    const pastureOpen = !!pasture && pasture.unlocked !== false;
    const zigs = zigguratCount();
    const upgradesOpen = zigs >= 1 && zigguratUpgrades().some((u) => zigguratUpgradeVisible(u));
    if (!pastureOpen && !upgradesOpen) {
      plan.action = "unicorn economy not open yet";
      return plan;
    }
    plan.open = true;
    const production = Math.max(0, productionFor("unicorns"));
    const religionRatio = liveUnicornReligionRatio();
    const items = [];
    if (pastureOpen) {
      const prices = pricesFor("build", pasture);
      const owned = pasture.val || 0;
      const perTickBase = (pasture.effects && pasture.effects.unicornsPerTickBase) || 0;
      // Marginal pasture output: live production ÷ owned count; the metadata
      // base × live multiplier is the fallback only while none are built yet.
      const gain = owned > 0 && production > 0
        ? production / owned
        : perTickBase * ticksPerSecond() * (1 + religionRatio);
      items.push({ kind: "build", meta: pasture, prices, cost: unicornEquivalentCost(prices), gain, unlocksAlicorns: false, label: labelOf(pasture) });
    }
    if (zigs >= 1) {
      const alicornRes = getRes(resources, "alicorn");
      const alicornsKnown = !!alicornRes && (alicornRes.unlocked === true || (alicornRes.value || 0) > 0);
      for (const meta of zigguratUpgrades()) {
        if (!zigguratUpgradeVisible(meta)) continue;
        const prices = pricesFor("ziggurat", meta);
        const deltaRatio = (meta.effects && meta.effects.unicornsRatioReligion) || 0;
        const gain = production > 0 && deltaRatio > 0 ? production * (deltaRatio / (1 + religionRatio)) : 0;
        const unlocksAlicorns = ((meta.effects && meta.effects.alicornChance) || 0) > 0 && (meta.val || 0) === 0 && !alicornsKnown;
        items.push({ kind: "ziggurat", meta, prices, cost: unicornEquivalentCost(prices), gain, unlocksAlicorns, label: labelOf(meta) });
      }
    }
    for (const item of items) {
      item.payback = item.gain > 0 && isFinite(item.cost.total) && item.cost.total > 0
        ? item.cost.total / item.gain
        : Number.POSITIVE_INFINITY;
    }
    // Rank by fastest unicorn payback: cheap upgrades compound unicorn income,
    // which then funds the expensive ones (and the alicorn unlock) sooner.
    // `unlocksAlicorns` stays a claim-horizon exemption, not a rank override.
    items.sort((a, b) => a.payback - b.payback || a.cost.total - b.cost.total);
    plan.items = items;
    let best = items.find((item) => isFinite(item.payback)) || items.find((item) => item.unlocksAlicorns) || null;
    // Commit to the prior pick while it stays within 25% of the new winner, so
    // slow-moving payback ties can't flip the sacrifice target every tick.
    if (best && activeUnicornPathId && unicornItemId(best) !== activeUnicornPathId) {
      const prior = items.find((item) => unicornItemId(item) === activeUnicornPathId);
      if (prior && (prior.unlocksAlicorns || !best.unlocksAlicorns) &&
          isFinite(prior.payback) && prior.payback <= best.payback * 1.25) {
        best = prior;
      }
    }
    activeUnicornPathId = best ? unicornItemId(best) : null;
    plan.best = best;
    // "Rush ziggurats" rule: when one more Ziggurat saves a big slice of the
    // pick's tear bill and is itself reachable, hold the sacrifice for it.
    if (best && best.cost.tears > 0) {
      const zigMeta = buildingByName("ziggurat");
      const conversion = sacrificeConversionFor("tears");
      if (zigMeta && zigMeta.unlocked !== false && conversion && isFinite(best.cost.total) && best.cost.total > 0) {
        const savings = best.cost.tears * conversion.inputPerChunk * (1 / zigs - 1 / (zigs + 1));
        if (savings >= best.cost.total * UNICORN_ZIG_FIRST_SAVINGS &&
            solveCraftChain(resources, { kind: "build", meta: zigMeta, affordable: false }).reachable) {
          plan.zigguratFirst = { savings, share: savings / best.cost.total };
        }
      }
    }
    plan.summary = items.slice(0, 5).map((item) => {
      const tearsPart = item.cost.tears > 0 ? ` (${fmt(item.cost.tears)} tears)` : "";
      const paybackPart = isFinite(item.payback) ? ` · payback ${formatEta(item.payback)}` : " · no unicorn gain";
      const alicornPart = item.unlocksAlicorns ? " · unlocks alicorns" : "";
      return `${item.label}: +${fmt(item.gain)}/s for ${fmt(item.cost.total)} unicorn-eq${tearsPart}${paybackPart}${alicornPart}`;
    });
    return plan;
  };

  // Keyed on the tickCache object: resetTickCache() makes a fresh one, so both
  // the tick loop and the debug/test paths invalidate this plan together.
  const getUnicornPlanCached = (resources) => {
    if (unicornPlanCache.key === tickCache && unicornPlanCache.plan) return unicornPlanCache.plan;
    const plan = unicornEconomyPlan(resources);
    unicornPlanCache = { key: tickCache, plan };
    return plan;
  };

  // Unicorn side of an item = its direct unicorn price plus the unicorns its
  // remaining tears deficit will consume through whole sacrifice batches.
  const unicornSideFunded = (resources, item) => {
    const prices = item.prices || [];
    const unicornPrice = prices.find((price) => price && price.name === "unicorns" && price.val > 0);
    const tearsPrice = prices.find((price) => price && price.name === "tears" && price.val > 0);
    const missingTears = Math.max(0, (tearsPrice ? tearsPrice.val : 0) - resValueOf(resources, "tears"));
    const conversion = sacrificeConversionFor("tears");
    if (missingTears > 0 && !conversion) return false;
    const unicornsForTears = missingTears > 0 ? Math.ceil(missingTears / conversion.gainPerChunk) * conversion.inputPerChunk : 0;
    return resValueOf(resources, "unicorns") >= (unicornPrice ? unicornPrice.val : 0) + unicornsForTears;
  };

  const bestUnicornPathTarget = (candidates, resources) => {
    const plan = getUnicornPlanCached(resources);
    const best = plan.open ? plan.best : null;
    if (!best) return null;
    // Rushes are gated on the pick being genuinely worth focus: a fast unicorn
    // payback, or the alicorn content unlock.
    if (!(best.unlocksAlicorns || best.payback <= UNICORN_PAYBACK_HORIZON_S)) return null;
    if (plan.zigguratFirst) {
      const zigCandidate = candidates.find((candidate) => candidate.kind === "build" && candidate.meta && candidate.meta.name === "ziggurat");
      if (zigCandidate && !zigCandidate.affordable) {
        return {
          candidate: zigCandidate,
          plan,
          reason: `next Ziggurat cuts ${labelOf(best.meta)}'s tear bill ${Math.round(plan.zigguratFirst.share * 100)}% (≈${fmt(plan.zigguratFirst.savings)} unicorns saved)`,
        };
      }
      return null; // an affordable Ziggurat is grabbed by the ordinary executor
    }
    const candidate = findCandidateById(candidates, unicornItemId(best));
    if (!candidate || candidate.affordable) return null; // affordable picks need no plan slot
    if (!unicornSideFunded(resources, best)) return null; // still banking unicorns — nothing to reserve
    if (!solveCraftChain(resources, candidate).reachable) return null;
    return {
      candidate,
      plan,
      reason: `${labelOf(best.meta)}'s unicorn bill is funded (${fmt(best.cost.total)} unicorn-eq); reserving the remaining costs`,
    };
  };

  // While the unicorn planner saves toward a tear-priced upgrade, hold the
  // unicorns its sacrifice will consume — otherwise a surplus Unicorn Pasture
  // buy eats the bank between sacrifices.  Merged into the shared reservation
  // ledger under the "unicorn path" source.
  const unicornPathReservationLedger = (resources) => {
    const out = { reserved: {}, critical: new Set(), sources: {} };
    try {
      const plan = getUnicornPlanCached(resources);
      const best = plan.open ? plan.best : null;
      const conversion = sacrificeConversionFor("tears");
      if (!best || !conversion || !(best.cost.tears > 0)) return out;
      const missingTears = Math.max(0, best.cost.tears - resValueOf(resources, "tears"));
      if (missingTears <= 0) return out;
      out.reserved.unicorns = Math.ceil(missingTears / conversion.gainPerChunk) * conversion.inputPerChunk;
      out.critical.add("unicorns");
      out.sources.unicorns = ["unicorn path"];
    } catch (error) {
      /* advisory reserve only */
    }
    return out;
  };

  // Unicorns some OTHER focus has dibs on: the active plan (when it is not the
  // item this sacrifice serves) and any manual-queue item other than it.  The
  // "unicorn path" background reserve and the served item's own ledger are the
  // sacrifice's OWN budget and must not deadlock it.
  const externalUnicornReserveFor = (resources, servedId, target) => {
    let hold = 0;
    try {
      if (target && targetId(target) !== servedId) {
        hold = Math.max(hold, (buildTargetLedger(target, resources).reserved || {}).unicorns || 0);
      }
      for (const item of readQueue()) {
        if (String(item.id) === servedId || queueItemDone(item)) continue;
        const meta = lookupMetaById(item.id);
        if (!meta) continue;
        const [kind] = String(item.id).split(":");
        const candidate = { kind, meta, affordable: false };
        if (!solveCraftChain(resources, candidate).reachable) continue;
        hold = Math.max(hold, (buildTargetLedger(candidate, resources).reserved || {}).unicorns || 0);
      }
    } catch (error) {
      /* treat unreadable reserves as zero */
    }
    return hold;
  };

  const executeUnicornSacrifice = (chunks) => {
    const btn = sacrificeUnicornsButton();
    if (!btn || !btn.controller || !btn.model) return { gained: 0, reason: "sacrifice button unavailable (open the Religion tab once)" };
    const before = resValueOf(resourceMap(), "tears");
    const attempts = [
      () => typeof btn.controller._transform === "function" && btn.controller._transform(btn.model, chunks),
      () => typeof btn.controller.transform === "function" && btn.controller.transform(btn.model, chunks),
      () => typeof btn.controller.sacrifice === "function" && btn.controller.sacrifice(btn.model, chunks),
    ];
    for (const attempt of attempts) {
      try {
        attempt();
      } catch (error) {
        /* try the next API shape */
      }
      const gained = resValueOf(resourceMap(), "tears") - before;
      if (gained > 0) return { gained, reason: "" };
    }
    return { gained: 0, reason: "sacrifice call had no effect" };
  };

  // Tick subsystem: balance the unicorn loop and perform the bounded sacrifice.
  //  - the ACTIVE PLAN wins: if the current target itself is tear-priced (a
  //    manual-queue ziggurat upgrade, or this layer's own claim), the sacrifice
  //    serves it; otherwise it serves the planner's ranked best pick;
  //  - the "rush ziggurats" hold defers sacrificing while one more Ziggurat
  //    would cut the bill (never when it would override an explicit target);
  //  - only the measured tears deficit is converted, in whole batches, from
  //    unicorns no other focus has reserved.
  const manageUnicornReligion = (resources, goalKey) => {
    try {
      const plan = getUnicornPlanCached(resources);
      if (!plan.open) {
        unicornPlanText = `Unicorns: ${plan.action || "unicorn economy not open yet"}`;
        return;
      }
      const target = getTargetCached(resources, goalKey);
      const targetTears = target && pricesFor(target.kind, target.meta)
        .find((price) => price && price.name === "tears" && isFinite(price.val) && price.val > 0);
      const served = targetTears
        ? { id: targetId(target), label: labelOf(target.meta), tearsCost: targetTears.val, explicit: true }
        : plan.best && plan.best.cost.tears > 0
          ? { id: unicornItemId(plan.best), label: labelOf(plan.best.meta), tearsCost: plan.best.cost.tears, explicit: false }
          : null;
      if (!served) {
        unicornPlanText = plan.best
          ? `Unicorns: saving unicorns for ${labelOf(plan.best.meta)} (best payback ${isFinite(plan.best.payback) ? formatEta(plan.best.payback) : "n/a"}); no sacrifice needed`
          : "Unicorns: no unicorn upgrade worth ranking yet";
        return;
      }
      if (!served.explicit && plan.zigguratFirst) {
        unicornPlanText = `Unicorns: holding sacrifice — next Ziggurat cuts ${served.label}'s tear bill ${Math.round(plan.zigguratFirst.share * 100)}%`;
        return;
      }
      const conversion = sacrificeConversionFor("tears");
      if (!conversion) {
        unicornPlanText = "Unicorns: build a Ziggurat to enable tear sacrifices";
        return;
      }
      const missingTears = Math.max(0, served.tearsCost - resValueOf(resources, "tears"));
      if (missingTears <= 0) {
        unicornPlanText = `Unicorns: tears ready for ${served.label}; waiting on the other costs`;
        return;
      }
      const chunksNeeded = Math.ceil(missingTears / conversion.gainPerChunk);
      const externalReserve = externalUnicornReserveFor(resources, served.id, target);
      const spendable = Math.max(0, resValueOf(resources, "unicorns") - externalReserve);
      const chunks = Math.min(chunksNeeded, Math.floor(spendable / conversion.inputPerChunk));
      if (chunks <= 0) {
        unicornPlanText = `Unicorns: banking unicorns to sacrifice for ${served.label} (${fmt(missingTears)} tears short)`;
        return;
      }
      if (Date.now() - lastUnicornSacrificeAt < UNICORN_SACRIFICE_MIN_MS) {
        unicornPlanText = `Unicorns: sacrifice for ${served.label} queued (batching)`;
        return;
      }
      const result = executeUnicornSacrifice(chunks);
      if (result.gained > 0) {
        lastUnicornSacrificeAt = Date.now();
        // The sacrifice may have just completed the served target's tears bill:
        // drop the per-tick plan snapshot so the executor's re-read sees the
        // fresh affordability and buys THIS tick (same latency contract crafts get).
        activePlanSnapshot = { cycleId: -1, target: undefined };
        unicornPlanText = `Unicorns: sacrificed ${fmt(chunks * conversion.inputPerChunk)} unicorns → +${fmt(result.gained)} tears for ${served.label}`;
        pushLog(`🦄 sacrificed ${fmt(chunks * conversion.inputPerChunk)} unicorns → +${fmt(result.gained)} tears for ${served.label}`);
      } else {
        unicornPlanText = `Unicorns: ${result.reason || "sacrifice unavailable"}`;
      }
    } catch (error) {
      /* ignore unicorn-subsystem failures */
    }
  };

  /* ------------------------------ layer selector ----------------------------
   * Ordered: safety guard (upstream) → active/new research sprint → storage /
   * economy scoring → long project.  Long projects can only win when no sprint
   * owns the plan.
   */
  const selectStrategicTarget = (resources, goalKey) => {
    const baseCandidates = gatherCandidates(resources, goalKey);
    // Stage transitions are structural candidates, not economy afterthoughts:
    // if a staged rebuild solves the active bottleneck (science cap, power, or
    // food pressure), it must compete inside that layer before a normal building
    // claims the plan.
    const stageCandidates = stageTransitionCandidates(resources);
    const candidates = [...stageCandidates, ...baseCandidates];

    // A stage switch sells the old stack before the replacement stack can be
    // rebuilt. Treat that rebuild as one atomic planning contract: it outranks
    // every new project and keeps the full net rebuild bill reserved until
    // effect parity is restored.
    const stageRebuild = pendingStageRebuildCandidate(candidates, resources);
    if (stageRebuild) {
      return {
        candidates: [stageRebuild, ...candidates.filter((candidate) => targetId(candidate) !== targetId(stageRebuild))],
        target: stageRebuild,
        layer: STRATEGIC_LAYERS.stageRebuild,
        reason: `rebuilding ${labelOf(stageRebuild.meta)} ${stageRebuild.meta.val || 0}/${stageRebuild._stageRebuild.targetCount} after stage change`,
        protectedChain: candidateCraftChainResources(stageRebuild),
        stageRebuild: stageRebuild._stageRebuild,
        rejectedTopCandidates: candidates.slice(0, 2).map((target) => ({ target, reason: "deferred until stage-change effect parity is restored" })),
      };
    }

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

    // Keep an existing research contract stable, but let a newly exposed craft
    // bootstrap downstream content before starting yet another sprint.
    const powerTarget = bestPowerRecoveryTarget(candidates, resources);
    if (powerTarget) {
      const net = candidateNetEnergy(powerTarget);
      const power = effectivePowerStatus();
      const deficit = Math.max(0, -power.delta, -power.winterDelta);
      return {
        candidates: [powerTarget, ...candidates.filter((candidate) => targetId(candidate) !== targetId(powerTarget))],
        target: powerTarget,
        layer: STRATEGIC_LAYERS.power,
        reason: `power deficit ${fmt(deficit)} Wt; adding +${fmt(net)} Wt from ${labelOf(powerTarget.meta)}`,
        protectedChain: candidateCraftChainResources(powerTarget),
        rejectedTopCandidates: candidates.slice(0, 3).map((target) => ({ target, reason: "deferred until power has safe headroom" })),
      };
    }

    // Converter-fuel starvation ranks with power recovery (above the research
    // sprint / science-storage holds): a chronically empty fuel like oil keeps
    // starve-pausing the Magneto/Calciner fleet, so its producer is built first.
    const fuelTarget = bestConverterFuelTarget(candidates, resources);
    if (fuelTarget) {
      return {
        candidates: [fuelTarget, ...candidates.filter((candidate) => targetId(candidate) !== targetId(fuelTarget))],
        target: fuelTarget,
        layer: STRATEGIC_LAYERS.production,
        reason: lastConverterFuelDiagnostic.action,
        protectedChain: candidateCraftChainResources(fuelTarget),
        rejectedTopCandidates: candidates.slice(0, 3)
          .filter((target) => targetId(target) !== targetId(fuelTarget))
          .map((target) => ({ target, reason: `deferred until ${lastConverterFuelDiagnostic.fuel} stops starving the converters` })),
      };
    }

    if (!activeSprint) {
      const workshopRoadmap = bestWorkshopRoadmap(candidates, resources);
      if (workshopRoadmap) {
        const target = workshopRoadmap.candidate;
        return {
          candidates: [target, ...candidates.filter((candidate) => targetId(candidate) !== targetId(target))],
          target,
          layer: STRATEGIC_LAYERS.workshopRoadmap,
          reason: workshopRoadmap.ready
            ? `${labelOf(target.meta)} is ready for immediate workshop purchase`
            : `${labelOf(target.meta)} is the best fundable workshop project (ETA ${formatEta(workshopRoadmap.eta)})`,
          protectedChain: workshopRoadmap.solver.protectedChain.size
            ? workshopRoadmap.solver.protectedChain
            : candidateCraftChainResources(target),
          workshopRoadmap,
          rejectedTopCandidates: candidates
            .filter((candidate) => candidate.kind === "upgrade" && targetId(candidate) !== targetId(target))
            .slice(0, 2)
            .map((candidate) => ({ target: candidate, reason: `lower workshop roadmap value or beyond ${formatEta(WORKSHOP_PROJECT_MAX_ETA_S)} horizon` })),
        };
      }
      const expansion = bestExpansionCheckpoint(candidates, resources);
      if (expansion) {
        const target = expansion.candidate;
        return {
          candidates,
          target,
          layer: STRATEGIC_LAYERS.expansion,
          reason: `population ${expansion.pressure.kittens}/${expansion.pressure.max}; +${fmt(expansion.slots)} slots advances ${expansion.pressure.firstReset ? `${expansion.pressure.milestone}-kitten first reset` : "population growth"}`,
          protectedChain: candidateCraftChainResources(target),
          expansion,
          rejectedTopCandidates: candidates.filter((candidate) => candidate.kind === "research").slice(0, 2).map((candidate) => ({ target: candidate, reason: "deferred behind population-cap expansion" })),
        };
      }
      const bootstrap = bootstrapResourceCandidate(resources);
      if (bootstrap) {
        return {
          candidates: [bootstrap, ...candidates],
          target: bootstrap,
          layer: STRATEGIC_LAYERS.resourceBootstrap,
          reason: `crafting ${fmt(bootstrap.meta.targetAmount)} ${craftLabel(bootstrap.meta.outputName)} reveals ${bootstrap.meta.downstreamLabel}`,
          protectedChain: candidateCraftChainResources(bootstrap),
          rejectedTopCandidates: candidates.slice(0, 2).map((target) => ({ target, reason: `deferred until ${bootstrap.meta.downstreamLabel} is revealed` })),
        };
      }
    }

    const { sprint, deferred } = planResearchSprint(candidates, resources, goalKey);

    if (sprint && sprint.candidate) {
      const target = sprint.candidate;
      const protectedChain = sprint.protectedChain && sprint.protectedChain.size ? sprint.protectedChain : candidateCraftChainResources(target);
      const chainText = [...protectedChain].filter((n) => craftByName(n)).slice(0, 3).map((n) => resTitle(resources, n)).join("→") || "science";
      // Trickle-leg redirect: when the chain is paced by a no-job cap-drain
      // bank (culture), point the plan at the best live producer of that bank
      // while the sprint contract keeps protecting the chain.
      const pacing = sprintCapDrainPacing(target, resources);
      const booster = pacing ? bestSprintPacingBooster(candidates, resources, pacing) : (activeSprintPacingBoostId = null, null);
      if (booster) {
        const boosted = booster.candidate;
        const mergedChain = new Set([...protectedChain, ...candidateCraftChainResources(boosted)]);
        return {
          candidates,
          target: boosted,
          layer: STRATEGIC_LAYERS.researchSprint,
          reason: `${labelOf(target.meta)} chain is ${resTitle(resources, pacing.name)}-bound (+${fmt(pacing.prod)}/s, ${formatEta(pacing.wait)}); growing ${resTitle(resources, pacing.name)} via ${labelOf(boosted.meta)}`,
          protectedChain: mergedChain,
          sprint,
          sprintRedirect: { candidate: boosted, ...pacing },
          rejectedTopCandidates: [
            { target, reason: `${resTitle(resources, pacing.name)} refill ${formatEta(pacing.wait)} at +${fmt(pacing.prod)}/s paces the chain` },
            ...buildSprintDeferrals(candidates, resources, goalKey, target, protectedChain, deferred)
              .filter((item) => item && item.target && targetId(item.target) !== targetId(boosted)),
          ].slice(0, 6),
        };
      }
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

    const festival = festivalOpportunity(resources);
    if (festival && festival.candidate) {
      const target = festival.candidate;
      return {
        candidates: [target, ...candidates],
        target,
        layer: STRATEGIC_LAYERS.festival,
        reason: `festival payoff ${fmt(festival.benefit)}; happiness ${Math.round(festival.happiness * 100)}%; ${festival.freeBeds} free housing`,
        protectedChain: candidateCraftChainResources(target),
        festival,
        rejectedTopCandidates: candidates.slice(0, 2).map((candidate) => ({ target: candidate, reason: "festival maintenance has faster economy-wide payback" })),
      };
    }

    const stageTarget = bestStageTransition(resources, stageCandidates);
    if (stageTarget) {
      const analysis = stageTarget.meta.analysis;
      return {
        candidates: [stageTarget, ...candidates],
        target: stageTarget,
        layer: STRATEGIC_LAYERS.stageTransition,
        reason: `${analysis.fromLabel} to ${analysis.toLabel}: ${analysis.reason}; rebuild ${analysis.parityCount} for effect parity`,
        protectedChain: candidateCraftChainResources(stageTarget),
        stageTransition: analysis,
        rejectedTopCandidates: candidates.slice(0, 2).map((target) => ({ target, reason: "stage transition has a shorter opportunity-cost-adjusted payback" })),
      };
    }

    // Ziggurat / unicorn path: claim the plan when the chosen unicorn-economy
    // step is funded on the unicorn side (or a Ziggurat should be rushed first)
    // so its shared-currency costs get reserved instead of eaten by surplus buys.
    const unicornPath = bestUnicornPathTarget(candidates, resources);
    if (unicornPath && unicornPath.candidate) {
      return {
        candidates,
        target: unicornPath.candidate,
        layer: STRATEGIC_LAYERS.unicornPath,
        reason: unicornPath.reason,
        protectedChain: candidateCraftChainResources(unicornPath.candidate),
        unicornPath: unicornPath.plan,
        rejectedTopCandidates: candidates.slice(0, 2)
          .filter((candidate) => targetId(candidate) !== targetId(unicornPath.candidate))
          .map((candidate) => ({ target: candidate, reason: "deferred while the funded unicorn-path step completes" })),
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
  const PLAN_HYSTERESIS_MULT = 1.25;
  const PLAN_SCORE_GAIN_THRESHOLD = PLAN_HYSTERESIS_MULT - 1;
  const ActivePlan = "ActivePlan";
  const getTargetLockMinMs = () => {
    if (isEarlyGame()) return TARGET_LOCK_MIN_EARLY_MS;
    if (isMidGame()) return TARGET_LOCK_MIN_MID_MS;
    return TARGET_LOCK_MIN_LATE_MS;
  };
  const TARGET_READY_GRACE_MS = 20000;
  let activeTarget = null;
  let activePlanDebug = { reason: "none", rejected: [], blocked: "" };

  const targetId = (candidate) => candidate && candidate.meta ? `${candidate.kind}:${candidate.meta.name || labelOf(candidate.meta)}` : "";

  const candidateScoreGain = (from, to) => {
    if (!from || !to || !isFinite(from.score || Number.NaN) || (from.score || 0) <= 0) return 0;
    return ((to.score || 0) / Math.max(1, from.score)) - 1;
  };

  const candidateMeetsSwitchScoreGain = (from, to) => candidateScoreGain(from, to) >= PLAN_SCORE_GAIN_THRESHOLD;

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

  const FEASIBILITY = { READY: "READY", BLOCKED_PRODUCIBLE: "BLOCKED/PRODUCIBLE", IMPOSSIBLE: "IMPOSSIBLE" };

  const classifyTargetFeasibility = (candidate, resources) => {
    if (!candidate || !candidate.meta) return { status: FEASIBILITY.IMPOSSIBLE, reason: "missing target" };
    if (!isOpen(candidate.meta) && candidate.kind !== "build") return { status: FEASIBILITY.IMPOSSIBLE, reason: "target unavailable" };
    const solver = solveCraftChain(resources, candidate);
    if (solver.hardBlocked) {
      const hard = (solver.blockers || []).find((b) => b.kind === "finalCap" || b.kind === "stepCap" || b.kind === "unreachable");
      return { status: FEASIBILITY.IMPOSSIBLE, reason: hard ? hard.text || hard.kind : "hard blocked", solver };
    }
    const missing = pricesFor(candidate.kind, candidate.meta).some((cost) => cost && cost.name && cost.val > resValueOf(resources, cost.name));
    return { status: missing ? FEASIBILITY.BLOCKED_PRODUCIBLE : FEASIBILITY.READY, reason: missing ? "waiting on producible resources" : "ready", solver };
  };

  const targetProgressSignature = (candidate, resources) => {
    if (!candidate) return "";
    return pricesFor(candidate.kind, candidate.meta)
      .map((cost) => `${cost.name}:${Math.floor(Math.min(cost.val || 0, resValueOf(resources, cost.name)))}`)
      .join("|");
  };

  const switchRejected = (from, to, why, details = {}) => {
    activePlanDebug.rejected = [{ target: to, reason: why }];
    if (Date.now() - (activePlanDebug.lastRejectLog || 0) > 20000) {
      const scoreGain = details.scoreGain != null ? details.scoreGain : candidateScoreGain(from, to);
      const pct = Math.round(scoreGain * 100);
      const neededPct = Math.round(PLAN_SCORE_GAIN_THRESHOLD * 100);
      const blockers = [];
      if (details.age != null && details.minAge != null && details.age < details.minAge) {
        blockers.push(`lock age ${formatEta(details.age / 1000)} < ${formatEta(details.minAge / 1000)} minimum`);
      }
      if (details.scoreBetter === false && scoreGain < PLAN_SCORE_GAIN_THRESHOLD) blockers.push(`score gain ${Math.max(0, pct)}% < ${neededPct}% threshold`);
      if (details.etaBetter === false && isFinite(details.lockedWait || Number.NaN) && isFinite(details.preferredWait || Number.NaN)) {
        blockers.push(`ETA ${formatEta(details.preferredWait)} is not 25% faster than ${formatEta(details.lockedWait)}`);
      }
      const whyText = blockers.length ? blockers.join("; ") : why;
      const fromScore = from ? (from.score || 0) : 0;
      const toScore = to ? (to.score || 0) : 0;
      const absDelta = toScore - fromScore;
      const scoreText = absDelta > 0
        ? `improvement ${fmt(absDelta)} (${Math.max(0, pct)}%)`
        : `no score improvement (${fmt(absDelta)}, ${pct}%)`;
      pushLog(`🔒 Plan switch rejected: ${to ? labelOf(to.meta) : "none"} score ${fmt(toScore)} vs current ${from ? labelOf(from.meta) : "none"} ${fmt(fromScore)}; ${scoreText}; ETA candidate ${formatEta(details.preferredWait)} vs current ${formatEta(details.lockedWait)}; ${whyText}`);
      activePlanDebug.lastRejectLog = Date.now();
    }
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
      for (const u of zigguratUpgrades()) note("ziggurat", u, zigguratUpgradeVisible(u));
      for (const b of buildingMetas()) note("build", b, !!b && b.unlocked !== false);
      try {
        for (const res of window.gamePage.resPool.resources || []) note("resource", { ...res, label: res.title || res.name }, !!res && res.unlocked !== false);
        const crafts = window.gamePage.workshop && window.gamePage.workshop.crafts;
        for (const craft of (Array.isArray(crafts) ? crafts : Object.values(crafts || {}))) {
          note("craft", craft, !!craft && craft.unlocked !== false);
        }
      } catch (error) {
        /* resources/crafts can still be booting */
      }
      if (knownUnlockIds && fresh.length) {
        const now = Date.now();
        for (const item of fresh) noveltyUntil[item.id] = now + NOVELTY_MS;
        resourceNamesCache = { count: -1, names: [] };
        activeTarget = null; // replan with the newcomers in the running
        const shown = fresh.slice(0, 3).map((item) => labelOf(item.meta)).join(", ");
        pushLog(`🆕 unlocked: ${shown}${fresh.length > 3 ? ` +${fresh.length - 3} more` : ""} — replanning`);
      }
      knownUnlockIds = ids;
    } catch (error) {
      /* ignore unlock-watch failures */
    }
  };

  // The last-logged plan summary is reused across ticks so a change in either
  // the active strategic layer OR the target itself is pushed to the action log
  // exactly once — giving the player a per-decision breadcrumb to debug "why is
  // the plan suddenly X?" without flooding the log every tick.
  let lastLoggedPlanSummary = "";
  const rejectedTargets = new Map();
  const PLAN_REJECT_COOLDOWN_MS = 30000;
  const logThrottle = Object.create(null);

  const pushPlanLog = (text, throttleMs = 15000) => {
    const now = Date.now();
    if (now - (logThrottle[text] || 0) < throttleMs) return;
    logThrottle[text] = now;
    pushLog(text);
  };

  const chooseWorkTarget = (resources, goalKey) => {
    const decision = selectStrategicTarget(resources, goalKey);
    lastStrategicDecision = decision;
    tickCache.candidates = decision.candidates;
    const candidates = decision.candidates;
    const preferred = decision.target || candidates[0] || null;
    // Preserve the selector's preferred target even when hysteresis returns the
    // old lock as the active target. Side executors must not act on this pending
    // takeover before it actually owns the plan.
    lastStrategicDecision.preferredTarget = preferred;
    const now = Date.now();
    const summary = `${decision.layer || "?"}::${targetId(preferred) || "(none)"}`;
    if (summary !== lastLoggedPlanSummary) {
      lastLoggedPlanSummary = summary;
      const label = preferred && preferred.meta ? labelOf(preferred.meta) : "no target";
      const reasonExtra = decision.scienceStorageBlocker && decision.scienceStorageBlocker.blocked
        ? ` (cap-blocked: ${labelOf(decision.scienceStorageBlocker.blocked.meta)})` : "";
      pushLog(`🧠 plan layer → ${decision.layer || "?"}: ${label}${reasonExtra}`);
    }

    // ActivePlan lock: every layer, including science-storage and manual queue,
    // gets the same cross-tick contract.  Structural layers may START a plan, but
    // may not oscillate Library/Bio Lab/Observatory/Temple every tick unless the
    // target completed, became impossible, stopped progressing for the timeout,
    // the user changed queue priority, or a real emergency wins.
    if (activeTarget) {
      const locked = findCandidateById(candidates, activeTarget.id);
      const age = now - activeTarget.startedAt;
      const lockedWait = locked ? waitSecondsForCandidate(locked, resources) : 0;
      const preferredWait = preferred ? waitSecondsForCandidate(preferred, resources) : Number.POSITIVE_INFINITY;
      const progress = locked ? targetProgressSignature(locked, resources) : "";
      if (progress && progress !== activeTarget.lastProgressSignature) {
        activeTarget.lastProgressSignature = progress;
        activeTarget.lastProgressAt = now;
      }
      const noProgress = now - (activeTarget.lastProgressAt || activeTarget.startedAt) > TARGET_LOCK_MAX_MS;
      const manualQueueChanged = activeTarget.queueSignature !== JSON.stringify(readQueue());
      const feasibility = locked ? classifyTargetFeasibility(locked, resources) : { status: FEASIBILITY.IMPOSSIBLE };
      const impossible = locked && feasibility.status === FEASIBILITY.IMPOSSIBLE;
      const completed = locked && targetComplete(locked);
      const same = locked && preferred && targetId(locked) === targetId(preferred);
      // An emergency may only BREAK a held plan to switch to a target that
      // actually ADDRESSES it.  Two failure modes this guards against, both seen
      // live as a 2-second plan ping-pong that finished nothing:
      //   • a transient winter catnip dip (already handled by the farmer
      //     failsafe) was unlocking the plan every tick even though the rival
      //     target — Magneto / Hut / Bio Lab — does nothing for food;
      //   • an EFFECTIVE-only power dip (raw Wt is fine, Data Centers are merely
      //     paused) is NOT a real emergency — isPowerEmergency reads RAW power, so
      //     it stays false here and the held plan no longer flaps to the power
      //     layer and back.
      // A genuine raw-power deficit still hands the plan to a generator, and a
      // real food crisis still hands it to a catnip building.
      const catnipEmergency = resRatio(resources, "catnip", 1) < 0.08 && productionFor("catnip") < 0;
      const emergency = !same && (
        (catnipEmergency && foodHelpingCandidate(preferred)) ||
        (isPowerEmergency() && candidateNetEnergy(preferred) > 0)
      );
      const structuralLayerTakeover = preferred && decision.layer === STRATEGIC_LAYERS.scienceStorageUnlock &&
        activeTarget.layer !== STRATEGIC_LAYERS.scienceStorageUnlock;
      // The manual queue overrides everything when actionable (documented layer
      // invariant): the player's explicit pick must not be score-gated behind
      // whatever the autopilot locked before the queue item became reachable.
      const manualQueueTakeover = preferred && !same && decision.layer === STRATEGIC_LAYERS.manualQueue &&
        activeTarget.layer !== STRATEGIC_LAYERS.manualQueue;
      // A sprint trickle-leg redirect engaging or releasing swaps the sprint's
      // plan target (tech ↔ producer building) inside the same live contract;
      // the lock must follow the contract, not pin the stale step.
      const sprintRedirectTakeover = preferred && !same &&
        decision.layer === STRATEGIC_LAYERS.researchSprint &&
        activeTarget.layer === STRATEGIC_LAYERS.researchSprint &&
        !!decision.sprintRedirect !== !!activeTarget.sprintRedirect;
      // A newly detected converter-fuel starvation (oil pinned at zero, the
      // Magneto/Calciner fleet starve-pausing) breaks a held plan toward its
      // producer immediately — the same prompt takeover power recovery gets,
      // since the loss compounds every tick the fuel stays empty.
      const productionTakeover = preferred && decision.layer === STRATEGIC_LAYERS.production &&
        activeTarget.layer !== STRATEGIC_LAYERS.production;
      // Power recovery is a conditional safety contract, not an ordinary
      // six-minute project. The moment the effective grid is healthy the power
      // layer yields; release its old generator lock on that same tick instead
      // of finishing a now-unnecessary multi-hour Alloy bill.
      const resolvedConditionalLock = activeTarget.layer === STRATEGIC_LAYERS.power &&
        decision.layer !== STRATEGIC_LAYERS.power;
      const lockedIsStaleStorage = locked && isStorageMeta(locked.meta) && !locked.affordable && lockedWait > 900 &&
        !storageStillWanted(locked.meta, resources, getStoragePressureCached(resources, GOALS[goalKey], goalKey));
      // directStorageBlockers covers every capped final price (craftable or
      // not), so the expansion layer's old separate final-cap break is
      // subsumed by this one condition.
      const lockedIsStorageBlocked = locked && directStorageBlockers(locked.kind, locked.meta, resources).length > 0;
      const scoreGain = preferred && locked ? candidateScoreGain(locked, preferred) : 0;
      const scoreBetter = preferred && locked && candidateMeetsSwitchScoreGain(locked, preferred);
      const etaBetter = preferredWait < lockedWait * 0.75;
      const muchBetter = preferred && locked && age >= getTargetLockMinMs() && scoreBetter && (etaBetter || !isFinite(lockedWait));
      const nearTechBreak = locked && preferred && preferred.kind === "research" && lockedWait > 900 && preferredWait < 900 && targetId(locked) !== targetId(preferred);
      if (!locked || completed || impossible || noProgress || manualQueueChanged || emergency || structuralLayerTakeover || manualQueueTakeover || sprintRedirectTakeover || productionTakeover || resolvedConditionalLock || age > TARGET_LOCK_MAX_MS ||
          lockedIsStaleStorage || lockedIsStorageBlocked || nearTechBreak) {
        const reason = !locked ? "target unavailable" : completed ? "target completed" : impossible ? "target impossible" :
          noProgress ? "blocked with no measurable progress" : manualQueueChanged ? "manual queue changed" :
          manualQueueTakeover ? "manual queue takeover" :
          sprintRedirectTakeover ? "sprint pacing redirect" :
          lockedIsStorageBlocked ? "storage cap blocks the final price" :
          structuralLayerTakeover ? "science storage emergency" : productionTakeover ? "converter-fuel starvation" :
          resolvedConditionalLock ? "power recovery resolved" :
          emergency ? "emergency" : "lock timeout";
        pushPlanLog(`🔓 Plan switch accepted: ${reason}`, 20000);
        // A storage-blocked target must not be re-picked next tick (that was
        // the post-reset Library↔lock loop) — cool it down like an impossible
        // one; the storage layer owns the plan until the cap grows.
        if ((impossible || lockedIsStorageBlocked) && locked) {
          rejectedTargets.set(targetId(locked), { reason: feasibility.reason || reason, at: now });
        }
        activeTarget = null;
      } else if (!same && !muchBetter) {
        switchRejected(locked, preferred, `locked ${labelOf(locked.meta)} age ${formatEta(age / 1000)}`, {
          age,
          minAge: getTargetLockMinMs(),
          scoreBetter,
          scoreGain,
          etaBetter,
          lockedWait,
          preferredWait,
        });
        lastStrategicDecision.target = locked;
        lastStrategicDecision.layer = activeTarget.layer || decision.layer;
        activePlanDebug.reason = activeTarget.reason || decision.reason || "locked";
        return locked;
      } else if (same || age < getTargetLockMinMs()) {
        lastStrategicDecision.target = locked;
        activePlanDebug.reason = activeTarget.reason || decision.reason || "locked";
        return locked;
      } else {
        pushPlanLog(`🔓 Plan switch accepted: ${preferred ? labelOf(preferred.meta) : "none"} beat ${labelOf(locked.meta)} by hysteresis`, 20000);
        activeTarget = null;
      }
    }

    // ActivePlan lock makes ordinary plans (Library, Mine, …) PUSH
    // THROUGH. The executor reserves the locked target's resources and buys it
    // the moment it is ready, so the lock only breaks on completion, a storage
    // block, a long timeout, a far-cheaper research, or a much better rival.
    if (preferred) {
      const rejected = rejectedTargets.get(targetId(preferred));
      if (rejected && now - rejected.at < PLAN_REJECT_COOLDOWN_MS) {
        activePlanDebug.rejected = [{ target: preferred, reason: `recently rejected: ${rejected.reason}` }];
        return null;
      }
      activeTarget = {
        id: targetId(preferred),
        startedAt: now,
        lastProgressAt: now,
        lastProgressSignature: targetProgressSignature(preferred, resources),
        initialVal: VAL_BASED_KINDS.has(preferred.kind) ? preferred.meta.val || 0 : 0,
        layer: decision.layer,
        reason: decision.reason,
        sprintRedirect: !!decision.sprintRedirect,
        queueSignature: JSON.stringify(readQueue()),
      };
      const reserved = buildTargetLedger(preferred, resources).reserved;
      const deficits = Object.entries(reserved)
        .map(([name, amount]) => [name, Math.max(0, amount - resValueOf(resources, name))])
        .filter(([, amount]) => amount > 0)
        .slice(0, 4)
        .map(([name, amount]) => `${resTitle(resources, name)} ${fmt(amount)}`)
        .join(", ");
      pushPlanLog(`🔒 Plan locked: ${labelOf(preferred.meta)} for ${decision.layer}; remaining deficits: ${deficits || "none"}`, 20000);
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
      const route = acquisitionPathFor(resources, cost.name, cost.val, { finalPurchase: true });
      const actionableTrade = actionableTradeRouteFor(route);
      if (route.reachable && actionableTrade) scoreAcquisitionRouteInputs(needs, resources, route, 22);
      else scoreResourcePathNeed(needs, cost.name, 22);
    }

    // Hunters: boosted when furs / parchment / manuscript / compendium is the
    // live bottleneck (catpower turns into furs turns into the whole chain).
    // The passed chain can be sparse (a queue pick's solver may only carry the
    // top-level craft), so the live fur bill is the authoritative signal.
    const hasShortCraftCost = pricesFor(target.kind, target.meta).some((c) =>
      c && c.name && c.val > 0 && craftByName(c.name) && resValueOf(resources, c.name) < c.val);
    const chainNeedsFurs = hasShortCraftCost &&
      (["furs", "parchment", "manuscript", "compedium", "compendium"].some((name) => chain.has(name)) ||
        targetFurDeficit(target, resources) > 0);
    if (chainNeedsFurs && jobByName("hunter")) scoreNeed(needs, "manpower", 26);

    // Scholars: 0 while science is capped; allowed when science is genuinely
    // the refill bottleneck — below the final research cost — OR while the
    // intermediate phase CYCLES science through crafts (a Compendium bill
    // spends the bank far past the final cost, so the bank must be refilled
    // between crafts even when it currently exceeds the tech's own price).
    const sciCost = researchScienceCost(target.meta);
    const sciHave = resValueOf(resources, "science");
    const phase = researchTargetPhase(target, resources);
    const scienceCycles = phase.phase === "intermediate" && phase.sharedInputs.has("science");
    if (jobByName("scholar") && !isNearResourceCap(resources, "science") && (sciHave < sciCost || scienceCycles)) {
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

    // Anti-waste: never staff a capped bank (keeps scholars off full science) —
    // unless the sprint still needs to bank MORE of it within the cap.
    const climbNeeds = targetClimbNeeds(target, resources);
    for (const name of ["science", "faith", "culture"]) {
      if (climbNeeds[name]) continue;
      if (resRatio(resources, name) > 0.94) needs[name] = 0;
    }
    for (const name of Object.keys(climbNeeds)) {
      // A craftable intermediate NO job produces (compendium / manuscript /
      // parchment) must never become a needs key: no job matches it, so the
      // weight staffs nobody — but it wins the "bottleneck" sort and points
      // the leader/diagnostics at a phantom job.  Its real pressure already
      // flowed through the craft-chain scoring above (science/culture/furs).
      if (craftByName(name) && !resourceHasDirectJobPath(name)) continue;
      if (resRatio(resources, name) > 0.9) {
        const key = name === "catpower" ? "manpower" : name;
        needs[key] = Math.max(needs[key] || 0, CLIMB_PUSH_WEIGHT);
      }
    }
    return { needs, target, chainContext: `research-chain:${(target.meta && target.meta.name) || targetId(target)}` };
  };

  const resourceNeeds = (goalKey, resources) => {
    const needs = {};
    const target = getTargetCached(resources, goalKey);
    const sprint = lastStrategicDecision && lastStrategicDecision.layer === STRATEGIC_LAYERS.researchSprint
      ? lastStrategicDecision.sprint : null;
    // While a trickle-leg redirect is live (Theology paced by +0.04/s culture,
    // plan pointed at an Amphitheatre), jobs must serve the redirect target's
    // economy (miners for its minerals) — flooding hunters for furs cannot
    // shorten a culture wait by a single second.
    const sprintRedirected = lastStrategicDecision && lastStrategicDecision.sprintRedirect;
    if (sprint && sprint.candidate && !sprintRedirected && !target?.affordable) {
      return researchSprintJobNeeds(sprint, resources);
    }
    // A chain-gated research target owns the chain jobs no matter WHICH layer
    // holds the plan.  The live v2.15 stall: a manual-queue Electricity pick
    // (67 Compendium → 1K Manuscript → 8K Parchment → furs) fell through to
    // this generic scorer, which staffed 33 woodcutters and 19 miners for the
    // low wood bank and the rank-2 lookahead candidates while 9 hunters
    // starved the fur chain that actually paced the plan.  Chain-gated
    // research (a craftable price still short) gets the exact hunter/scholar
    // chain jobs a sprint contract gets; plain science-bank techs keep the
    // generic path below (its scholar clauses already cover them).
    if (!sprintRedirected && target && !target.affordable && target.kind === "research" &&
        target.meta && researchChainGated(target.meta, resources)) {
      const contract = {
        candidate: target,
        protectedChain: (lastStrategicDecision && lastStrategicDecision.protectedChain) || candidateCraftChainResources(target),
      };
      return researchSprintJobNeeds(contract, resources);
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
          const weight = 4 * (1 - Math.min(0.98, have / cost.val)) + 1;
          const route = acquisitionPathFor(resources, cost.name, cost.val, { finalPurchase: true });
          const actionableTrade = actionableTradeRouteFor(route);
          if (route.reachable && actionableTrade) scoreAcquisitionRouteInputs(needs, resources, route, weight);
          else {
            scoreResourcePathNeed(needs, cost.name, weight);
            rawPathRequirements(cost.name, missing, rawRequirements);
          }
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

    const openResearchNeedingScience = getCandidatesCached(resources, goalKey).find((candidate) => {
      if (!candidate || candidate.kind !== "research" || !candidate.meta || !isOpen(candidate.meta)) return false;
      const scienceCost = researchScienceCost(candidate.meta);
      return scienceCost > resValueOf(resources, "science") &&
        finalScienceFitsCap(candidate.meta, resources) &&
        (gatewayValue(candidate.meta) > 0 || (candidate.score || 0) > 0);
    });
    if (openResearchNeedingScience && jobByName("scholar") && resRatio(resources, "science") < 0.92) {
      scoreNeed(needs, "science", totalKittenCount() < EARLY_GAME_KITTENS ? 6 : 3);
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
      let acquisitionWork = false;
      for (const cost of pricesFor(candidate.kind, candidate.meta)) {
        if (!cost || !cost.name || !isFinite(cost.val) || cost.val <= 0) continue;
        if (cost.name === "faith") continue; // dedicated faith gating below owns priest pressure
        const res = getRes(resources, cost.name);
        if (res && res.maxValue > 0 && cost.val > res.maxValue) continue; // storage planner's job
        const have = (res && res.value) || 0;
        if (have >= cost.val) continue;
        const route = acquisitionPathFor(resources, cost.name, cost.val, { finalPurchase: true });
        if (route.reachable && actionableTradeRouteFor(route)) {
          scoreAcquisitionRouteInputs(needs, resources, route, 1.5);
          acquisitionWork = true;
        } else {
          rawPathRequirements(cost.name, cost.val - have, raw);
        }
      }
      if (Object.keys(raw).length) {
        scoreRawDeficits(needs, resources, raw, 4);
      }
      if (acquisitionWork || Object.keys(raw).length) lookaheads += 1;
    }

    // Discretionary faith banking (priests filling faith toward a future religion
    // upgrade) must YIELD in two cases.  (1) When the colony is food-stressed:
    // nextFaithReligionUpgrade injects a fat faith need (weight 10) the moment ANY
    // religion upgrade is pending — regardless of the active plan — which is how
    // ~16 Priests kept banking faith while catnip drained to 0 and kittens starved.
    // (2) When religion is NOT the active plan: the full weight-10 push is for an
    // ACTIVE religion target (one whose price spends faith); an unrelated future
    // upgrade is background work that must not crowd out the live build/research
    // plan (this is what put ~30 of 120 kittens on Priest while a no-faith
    // science-storage build starved for its own chain).  A religion upgrade
    // nothing is waiting on does not outrank feeding the colony or the active
    // plan's own chain: bank it at full weight only when catnip is not
    // net-negative (or is net-negative but still well-stocked) AND the active
    // TARGET spends faith; otherwise the small weight-2 baseline keeps a trickle.
    const targetNeedsFaith = target && !target.affordable &&
      pricesFor(target.kind, target.meta).some((cost) => cost && cost.name === "faith" && cost.val > 0);
    const foodStressed = productionFor("catnip") < 0 && resRatio(resources, "catnip") < 0.5;
    const allowFaithBanking = !foodStressed || targetNeedsFaith;
    const religionTarget = allowFaithBanking ? nextFaithReligionUpgrade(resources) : null;
    // Faith is only worth banking while it is the LIMITING cost of the pending
    // upgrade.  Live, Apocrypha needs ~5K faith AND ~5K gold while gold trickles
    // in at +0.3/s; faith was already 79% there, so filling it first just pinned
    // the bank at the cap with nothing to spend it on (praise is held for a
    // pending upgrade) while ~11 Priests ran for nothing.  When a far-off
    // non-faith cost is the real gate, priests stand down and let it resolve;
    // faith banking resumes the moment faith becomes the binding constraint.
    let faithIsBinding = true;
    if (religionTarget && !religionTarget.affordable) {
      const upgradeCosts = pricesFor("religion", religionTarget.meta)
        .filter((cost) => cost && cost.name && isFinite(cost.val) && cost.val > 0);
      const ratioOf = (cost) => resValueOf(resources, cost.name) / cost.val;
      const faithCost = upgradeCosts.find((cost) => cost.name === "faith");
      const nonFaithMinRatio = upgradeCosts
        .filter((cost) => cost.name !== "faith")
        .reduce((min, cost) => Math.min(min, ratioOf(cost)), 1);
      faithIsBinding = !faithCost || ratioOf(faithCost) <= nonFaithMinRatio + 0.15;
      // The fat faith need (weight 10) belongs to an ACTIVE religion push — the
      // live plan's own target spends faith.  A future upgrade we are merely
      // *able* to save toward is background work: banking it at full weight put
      // ~25-30% of the colony on Priest while an unrelated active plan (e.g. a
      // science-storage building that costs no faith) starved for its own chain.
      // When religion is not the focus, fall through to the small weight-2
      // baseline below so a few priests keep the bank trickling up without
      // crowding out the plan.  The upgrade's non-faith gate (gold/spice) is
      // still surfaced so the bot makes background progress toward it (Test E3).
      for (const cost of upgradeCosts) {
        if (resValueOf(resources, cost.name) >= cost.val) continue;
        if (cost.name === "faith") {
          if (faithIsBinding && targetNeedsFaith) scoreNeed(needs, "faith", 10);
        } else {
          scoreNeed(needs, cost.name, 4);
        }
      }
      if (!faithIsBinding && jobByName("priest")) {
        const gate = upgradeCosts
          .filter((cost) => cost.name !== "faith" && resValueOf(resources, cost.name) < cost.val)
          .map((cost) => resTitle(resources, cost.name)).join("/") || "another cost";
        jobSuppressText = `Suppressed: faith banked enough — ${labelOf(religionTarget.meta)} is gated on ${gate}, not faith`;
      } else if (faithIsBinding && !targetNeedsFaith && jobByName("priest")) {
        jobSuppressText = `Suppressed: ${labelOf(religionTarget.meta)} is not the active plan — banking faith at background level only`;
      }
    } else if (!allowFaithBanking && jobByName("priest")) {
      jobSuppressText = "Suppressed: faith banking while catnip is net-negative (food first)";
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
    if (allowFaithBanking && faithIsBinding && jobByName("priest") && resRatio(resources, "faith", 1) < 0.9) scoreNeed(needs, "faith", 2);

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

    // Final-push exception: a resource the active target still needs to bank
    // MORE of (and that fits the cap) must NOT be cut by the cap anti-waste
    // rules below — otherwise a tech/building whose cost lands between 94% and
    // 100% of the cap stalls a few units short forever.
    const climbNeeds = targetClimbNeeds(target, resources);
    for (const name of ["science", "faith", "culture", "manpower"]) {
      if (name === "manpower" && huntingEconomyNeed(resources) > 0.5) continue;
      if (climbNeeds[name]) continue;
      if (resRatio(resources, name) > 0.94) needs[name] = 0;
    }
    for (const name of ["wood", "minerals", "catnip", "coal"]) {
      if (climbNeeds[name]) continue;
      if (resRatio(resources, name) > 0.96) needs[name] = Math.min(needs[name] || 0, 0.25);
    }
    for (const name of Object.keys(climbNeeds)) {
      // Same phantom-key guard as the sprint path: a craftable intermediate
      // no job produces (compendium / manuscript / parchment) staffs nobody,
      // yet the uncapped-resource ratio fallback (1) always trips the >0.9
      // test — the dead key then wins the bottleneck sort and mislabels the
      // leader/jobs line.  Its pressure already flowed through the craft
      // chain scoring above.
      if (craftByName(name) && !resourceHasDirectJobPath(name)) continue;
      if (resRatio(resources, name) > 0.9) {
        const key = name === "catpower" ? "manpower" : name;
        needs[key] = Math.max(needs[key] || 0, CLIMB_PUSH_WEIGHT);
      }
    }
    const mineralSubNeed = (needs.iron || 0) + (needs.titanium || 0);
    if (mineralSubNeed > 0) {
      needs.minerals = Math.max(needs.minerals || 0, mineralSubNeed * 0.7);
    }

    // Treat an about-to-expire festival as part of the same planning chain as
    // buys/crafts: if Drama unlocked festivals and the current festival buffer
    // is low, jobs should see the missing catpower/culture/parchment before the
    // holdFestival executor runs.  The executor still respects target reserves,
    // so this nudges production without stealing a locked build/research chain.
    try {
      const game = window.gamePage;
      const calendar = game && game.calendar;
      const drama = game && game.science && game.science.get && game.science.get("drama");
      const buffer = calendar && (calendar.daysPerSeason || 100);
      if (drama && drama.researched && calendar && (calendar.festivalDays || 0) <= buffer) {
        const reserved = target && !target.affordable ? reservedNeedsFor(target, resources) : {};
        for (const cost of FESTIVAL_COST) {
          const have = resValueOf(resources, cost.name);
          if ((reserved[cost.name] || 0) <= 0 && have < cost.val) {
            scoreNeed(needs, cost.name === "manpower" ? "manpower" : cost.name, Math.min(4, (cost.val - have) / Math.max(cost.val, 1) * 4));
          }
        }
      }
    } catch (error) {
      /* festival pressure is advisory only */
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
    const { needs, target, chainContext } = resourceNeeds(goalKey, resources);
    // Resources the active target still needs to climb toward within the cap are
    // exempt from the per-job cap anti-waste below, so the producing job keeps
    // working through the final push instead of hard-zeroing a few units short.
    const climbNeeds = targetClimbNeeds(target, resources);
    // A live fur bill in the plan's craft chain means hunting IS the plan:
    // the "furs are stocked, stand hunters down" clamp and the catpower
    // near-cap hard-zero must both yield while it is outstanding.
    const planFurDeficit = targetFurDeficit(target, resources);
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
      const climbing = !!(climbNeeds[needKey] ||
        (needKey === "manpower" && (climbNeeds.catpower || planFurDeficit > 0)));
      if (resRatio(resources, needKey, 0) > 0.94 && !keepForEconomy && !climbing) { weight = 0; cappedZeroJobs.add(job.name); }
      // Hunting beyond the luxury/mood need is busywork: when furs are well
      // stocked and the village is happy, crafting-chain pressure (parchment →
      // furs → catpower) must not march half the settlement into the woods.
      // EXCEPT when the active plan's chain still owes furs beyond the bank:
      // a 450K-fur Compendium bill is a plan pacer, not busywork, and the
      // clamp would freeze the flood the moment the bank passed the small
      // luxury/mood target.
      if (job.name === "hunter" && huntingEconomyNeed(resources) <= 0.5 && planFurDeficit <= 0) {
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
    // Wood bottleneck hysteresis: when the active plan needs wood and catnip is
    // safely positive, keep a direct wood-production path staffed.  Do not flip
    // Woodcutters to 0 while also refining catnip into wood unless food safety
    // actually requires it.
    const activeNeedsWood = !!(target && !target.affordable && targetClimbNeeds(target, resources).wood);
    if (woodcutterJob && activeNeedsWood && productionFor("catnip") > 0 && resRatio(resources, "catnip") > 0.25) {
      weights.woodcutter = Math.max(weights.woodcutter || 0, 6);
    }
    if (!Object.values(weights).some((w) => w > 0)) {
      const fallback = bestWoodJob() || jobByName("woodcutter") || jobByName("farmer") || jobs[0];
      if (fallback) weights[fallback.name] = 1;
    }

    // When entering, leaving, or switching a research chain-jobs contract
    // (sprint OR a chain-gated research target under the manual queue), the
    // prior smoothed distribution must NOT linger — reset it so the new
    // chain's jobs take over immediately instead of decaying the old
    // wood/miner-heavy split over many ticks.  (Within steady economy mode
    // the context stays "", so ordinary target changes never reset the
    // smoothing and the village does not churn.)
    const jobContext = chainContext || "";
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

    if (chainContext && (needs.manpower || 0) > 0) {
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

    // ── Starvation FAILSAFE (absolute, plan-independent survival override) ───
    // Job COUNTS are handed out in proportion to the weight SUM (see the
    // proportional split above), so even a maxed catnip "guard" weight only buys
    // a FRACTION of the village once coal/mineral/faith demands pile weight on
    // too.  That is exactly how a full colony let 19 kittens STARVE TO DEATH
    // while 24 Geologists and 16 Priests kept working and catnip sat pinned at
    // 0.  A weight nudge cannot guarantee survival — a hard count must.  When the
    // pantry is nearly empty AND catnip is still net-negative, kittens are dying
    // NOW: force enough farmers to flip catnip non-negative (plus a tiny refill
    // buffer), pulling them from the most-staffed non-farmer jobs.  No building
    // plan, leader bottleneck or research sprint outranks not starving, so this
    // runs LAST — after smoothing, deadband and every other adjustment — where
    // nothing downstream can undo it.
    const farmerJob = jobByName("farmer");
    if (farmerJob && isFoodEmergency(resources)) {
      const liveFarmers = Math.max(0, Math.floor(farmerJob.value || 0));
      const perFarmer = (jobMarginalProductionPerSecond(farmerJob, "catnip") || 0) * catnipWeatherMultiplier();
      const deficit = Math.max(0, -productionFor("catnip"));
      // Farmers needed to cover the live shortfall plus a small buffer to rebuild
      // the pantry.  Then take the MAX with "half the village farms": a single
      // per-farmer marginal sample can read far too high (one tick of leader/
      // happiness bonus), which would otherwise size the flood at a couple of
      // kittens and let the colony keep starving.  Half the village guarantees a
      // decisive response; it self-corrects up to `total` if still net-negative
      // next tick, and disengages the moment catnip climbs back above 5%.
      let targetFarmers = perFarmer > 0
        ? liveFarmers + Math.ceil(deficit / perFarmer) + 2
        : Math.ceil(total * 0.7);
      targetFarmers = Math.max(targetFarmers, Math.ceil(total * 0.5));
      const farmerLimit = village.getJobLimit ? village.getJobLimit("farmer") : Number.POSITIVE_INFINITY;
      targetFarmers = Math.min(targetFarmers, total, isFinite(farmerLimit) ? farmerLimit : total);
      let shortfall = targetFarmers - (desired.farmer || 0);
      if (shortfall > 0) {
        const donors = jobs
          .filter((job) => job.name !== "farmer")
          .sort((a, b) => (desired[b.name] || 0) - (desired[a.name] || 0));
        for (const job of donors) {
          if (shortfall <= 0) break;
          const take = Math.min(shortfall, desired[job.name] || 0);
          desired[job.name] = (desired[job.name] || 0) - take;
          desired.farmer = (desired.farmer || 0) + take;
          shortfall -= take;
        }
        jobPlanText = "Jobs: ⚠ EMERGENCY farming — pantry empty, feeding kittens first";
        if (Date.now() - lastStarvationLog > 10000) {
          pushLog(`🚑 Starvation failsafe: farming ${desired.farmer}/${total} kittens (catnip ${fmt(productionFor("catnip"))}/s)`);
          lastStarvationLog = Date.now();
        }
      }
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
      // Anti-churn throttle: with no free kittens, normally rebalance at most once
      // per JOB_REBALANCE_MIN_MS and skip an unchanged plan.  But a FOOD EMERGENCY
      // cannot wait 45s — that window is exactly long enough for catnip to crash
      // to 0 and kittens to starve before the executor is allowed to re-staff
      // farmers.  So the emergency bypasses BOTH guards and re-applies the farmer
      // failsafe every tick until the pantry climbs back out of the red.
      const emergency = isFoodEmergency(resources);
      if (!emergency) {
        if (now - lastJobRun < JOB_REBALANCE_MIN_MS && Math.floor(village.getFreeKittens()) <= 0) return;
        if (signature === lastJobSignature && Math.floor(village.getFreeKittens()) <= 0) return;
      }
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
      const tradeRoute = activeAcquisitionRoute(target, resources);
      if (tradeRoute && tradeRoute.nextStep && tradeRoute.nextStep.kind === "trade" &&
          tradePricesForRace(tradeRoute.nextStep.race).some((price) => price && (price.name === "manpower" || price.name === "catpower"))) {
        return;
      }
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
      // A preparation mutation (for example crafting the first Zebra-reveal
      // ship) consumes diplomacy's one action for this tick. Keep an already
      // funded explorer bank intact so the next cooldown slot can reveal the
      // race instead of hunting the fee away in the same tick.
      if (exploreCost > 0 && cp.value >= exploreCost) return;
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
    const power = powerStatus();
    if (power.delta < 0) return `power deficit (${fmt(power.delta)} Wt) — build/enable positive-Wt generators before more powered buildings`;
    for (const name of SPENDABLE) {
      const r = resources.get(name);
      const cap = liveCapFor(resources, name);
      if (r && cap > 0 && r.value >= cap * 0.99) {
        const storageBlocker = lastStrategicDecision && lastStrategicDecision.scienceStorageBlocker;
        const storageTarget = lastStrategicDecision && lastStrategicDecision.target;
        const activeStorageMeta = name === "science" && activeTarget
          ? lookupMetaById(activeTarget.id)
          : null;
        const activeStorageFix = activeStorageMeta && scienceStorageUnlockCandidate({ kind: String(activeTarget.id).split(":")[0], meta: activeStorageMeta }, resources)
          ? activeStorageMeta
          : null;
        const capFixMeta = storageBlocker && storageTarget ? storageTarget.meta : activeStorageFix;
        const storageFix = name === "science" && capFixMeta
          ? `building ${labelOf(capFixMeta)} to raise the cap`
          : "build more storage / spend it";
        const fix = name === "manpower" ? "send hunters" : storageFix;
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
    time: "TIME STRUCTURE",
    festival: "FESTIVAL",
    stage: "BUILDING STAGE",
  };

  const KIND_ICONS = { build: "🏗", research: "🔬", upgrade: "⚙", religion: "☀", policy: "📜", space: "🚀", time: "⏳", festival: "🎉", stage: "⇄" };

  // Space missions (orbitalLaunch, moonMission, ...) and planet buildings
  // (Cath's Satellite, Space Elevator, ...) share the "space" candidate kind
  // but are different game concepts — label them distinctly for diagnostics.
  const kindLabelFor = (candidate) => {
    if (candidate.kind === "space") return isSpacePlanetBuilding(candidate.meta) ? "SPACE BUILDING" : "SPACE PROGRAM";
    return KIND_LABELS[candidate.kind] || candidate.kind.toUpperCase();
  };

  const focusLabel = (candidate) => `${KIND_ICONS[candidate.kind] || "🎯"} ${kindLabelFor(candidate)}`;

  // Compact "Need:" summary — the still-missing direct costs (cap-drain banks
  // and craft intermediates), e.g. "12.29K Science, 27.2 Compendium".
  const planNeedSummary = (resources, target) => {
    const out = [];
    for (const cost of pricesFor(target.kind, target.meta)) {
      if (!cost || !cost.name || !isFinite(cost.val) || cost.val <= 0) continue;
      const have = resValueOf(resources, cost.name);
      if (have >= cost.val) continue;
      const label = craftByName(cost.name) && !resourceHasDirectJobPath(cost.name)
        ? craftLabel(cost.name)
        : resTitle(resources, cost.name);
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
      const phase = target.kind === "research" ? researchTargetPhase(target, resources) : null;
      const phaseLine = phase && phase.phase !== "purchase" ? `\nPhase: ${phase.explanation}` : "";
      const redirect = lastStrategicDecision && lastStrategicDecision.sprintRedirect;
      const redirectLine = redirect && lastStrategicDecision.sprint && lastStrategicDecision.sprint.candidate
        ? `\nSprint: ${labelOf(lastStrategicDecision.sprint.candidate.meta)} is ${resTitle(resources, redirect.name)}-bound (${formatEta(redirect.wait)} at +${fmt(redirect.prod)}/s) — growing ${resTitle(resources, redirect.name)} first`
        : "";
      return `🎯 Focus: ${labelOf(target.meta)}\nLayer: ${layer}${phaseLine}${redirectLine}\nNeed: ${needLine}`;
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
      const lockAge = activeTarget && activeTarget.id === targetId(target) ? formatEta((Date.now() - activeTarget.startedAt) / 1000) : "unlocked";
      const lockText = `ActivePlan: ${labelOf(target.meta)} · lock ${lockAge} · reason ${activePlanDebug.reason || (decision && decision.reason) || "selected"}`;
      const reserveLedger = buildReservationLedger(target, resources);
      const reserveBySource = Object.entries(reserveLedger.reserved).slice(0, 5)
        .map(([name, amount]) => `${resTitle(resources, name)} ${fmt(amount)} (${(reserveLedger.sources[name] || ["active plan"])[0]})`)
        .join("; ");
      const topSource = (decision && decision.candidates || getCandidatesCached(resources, goalKey))
        .filter((candidate) => !(decision && decision.layer === STRATEGIC_LAYERS.scienceStorageUnlock && isLongProject(candidate, resources, goalKey)));
      const topCandidates = topSource.slice(0, 3)
        .map((candidate) => `${labelOf(candidate.meta)} score ${fmt(candidate.score || 0)} ETA ${formatEta(waitSecondsForCandidate(candidate, resources))}`)
        .join("; ");
      const power = powerStatus();
      const effPower = effectivePowerStatus();
      const pd = lastPowerRecoveryDiagnostic || {};
      const powerDebug = `Power: prod ${fmt(power.prod)} Wt, cons ${fmt(power.cons)} Wt, delta ${fmt(power.delta)} Wt, winter ${fmt(power.winterDelta)} Wt, latent ${fmt(effPower.latent || 0)} Wt, computed deficit ${fmt(Math.max(0, -effPower.delta, -effPower.winterDelta))} Wt, ${pd.action || "Power recovery not evaluated"}`;
      const baseDebug = `${powerDebug} · ${lockText} · Target score ${fmt(target.score || 0)} ETA ${formatEta(waitSecondsForCandidate(target, resources))} · Top candidates: ${topCandidates || "none"} · Reservations: ${reserveBySource || "none"} · Next: ${getNowAction(resources, goalKey)}`;
      const phase = target.kind === "research" ? researchTargetPhase(target, resources) : null;
      const phaseDebug = phase && phase.phase !== "purchase" ? `${baseDebug} · Research phase ${phase.phase}: ${phase.explanation}` : baseDebug;
      // Research-sprint details: protected chain + deferrals + job drivers.
      if (decision && decision.layer === STRATEGIC_LAYERS.researchSprint && decision.sprint) {
        const parts = [];
        parts.push(phaseDebug);
        if (decision.sprintRedirect && decision.sprint.candidate) {
          parts.push(`Trickle leg: ${labelOf(decision.sprint.candidate.meta)} needs ${fmt(decision.sprintRedirect.missing)} ${resTitle(resources, decision.sprintRedirect.name)} at +${fmt(decision.sprintRedirect.prod)}/s (${formatEta(decision.sprintRedirect.wait)}) — growing it via ${labelOf(target.meta)}`);
        }
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
        const rejected = (decision.rejectedTopCandidates || [])
          .filter((item) => item && item.target && !isLongProject(item.target, resources, goalKey)).slice(0, 3);
        const rejectNote = rejected.length ? ` · deferred ${rejected.map((item) => `${labelOf(item.target.meta)} (${item.reason})`).join("; ")}` : "";
        const optionNote = (blocker.options || []).length
          ? ` · Cap options: ${blocker.options.map((option) => `${labelOf(option.candidate.meta)} +${fmt(option.gain)}/copy ×${option.copies} = ${Math.round(option.closure * 100)}% closure, ETA ${formatEta(option.eta)}${targetId(option.candidate) === targetId(target) ? " (chosen)" : " (slower/incomplete)"}`).join("; ")}`
          : "";
        return `${phaseDebug} · ${labelOf(blocker.blocked.meta)} is storage-blocked · Need +${fmt(blocker.need)} science storage · Now ${target.affordable ? "buy" : "build"} ${labelOf(target.meta)} · ETA ${eta}${optionNote}${rejectNote}`;
      }
      if (decision && decision.layer === STRATEGIC_LAYERS.stageTransition && decision.stageTransition) {
        const stage = decision.stageTransition;
        const prices = (map) => Object.entries(map || {}).map(([name, amount]) => `${resTitle(resources, name)} ${fmt(amount)}`).join("+") || "none";
        const lostRefund = Object.keys(stage.refundLoss || {}).length ? ` (overflow loss ${prices(stage.refundLoss)})` : "";
        return `${phaseDebug} · Stage analysis: ${stage.fromLabel} → ${stage.toLabel} · refund ${prices(stage.usableRefund)} usable${lostRefund} · parity rebuild ${stage.parityCount} costing ${prices(stage.rebuild)} · net reserve ${prices(stage.net)} · downtime opportunity cost ${fmt(stage.lostUtility)} utility-seconds · payback ${formatEta(stage.payback)} · safety ${stage.safetyVetoes.length ? stage.safetyVetoes.join("; ") : "passed"}`;
      }
      if (decision && decision.layer === STRATEGIC_LAYERS.stageRebuild && decision.stageRebuild) {
        return `${phaseDebug} · Stage rebuild continuation: ${labelOf(target.meta)} ${target.meta.val || 0}/${decision.stageRebuild.targetCount} · all rebuild inputs remain reserved until effect parity is restored`;
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
      return `${phaseDebug} · ${focusLabel(target)} ${labelOf(target.meta)} · ${state} · ETA ${eta}${reserveNote}${rejectNote}${titaniumHint ? ` · titanium path: ${titaniumHint}` : ""}`;
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
      if (decision.sprintRedirect && decision.sprint.candidate) {
        return `build ${labelOf(target.meta)} to grow ${resTitle(resources, decision.sprintRedirect.name)} for ${labelOf(decision.sprint.candidate.meta)} chain`;
      }
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
    const directShort = pricesFor(target.kind, target.meta).find((cost) => cost && cost.name && cost.val > ((getRes(resources, cost.name) || {}).value || 0));
    const craftable = directShort && craftByName(directShort.name) && rawWorkNeedName(directShort.name) !== directShort.name ? directShort : null;
    if (craftable) {
      // Surface the immediate actionable step (e.g. Beam before Scaffold) and how
      // many to craft, so the panel shows what is actually being converted.
      const step = deepestActionableStep(resources, craftable.name);
      if (HUNTABLE_RESOURCES.has(step)) return `hunt for ${resTitle(resources, step)} for ${labelOf(target.meta)}`;
      const via = step !== craftable.name && craftByName(step) ? ` (via ${craftLabel(step)})` : "";
      return `craft ${craftQtyText(resources, craftable.name)}${via} for ${labelOf(target.meta)}`;
    }
    if (directShort && rawWorkNeedName(directShort.name) === directShort.name) {
      const safe = craftByName(directShort.name) ? craftablePotential(directShort.name) : 0;
      const chunk = safe > 0 ? `; safe ${craftLabel(directShort.name)} chunk available: ${fmt(safe)} ${resTitle(resources, directShort.name)}` : "; refine only surplus above reserve";
      return `accumulate ${resTitle(resources, directShort.name)} for ${labelOf(target.meta)}${chunk}`;
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
      candidate.kind !== "stage" &&
      (!target || targetId(candidate) !== targetId(target)) &&
      !buyBenched(targetId(candidate)) &&
      candidateSpendsAny(candidate, capped) &&
      respectsReservations(candidate, reserved, resources, buildTargetLedger(target, resources)));
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

  const controllerSpecFor = (kind, meta) => {
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
    if (kind === "ziggurat") {
      return {
        path: ["com", "nuclearunicorn", "game", "ui", "ZigguratBtnController"],
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
      // Missions (space.programs, e.g. orbitalLaunch) and planet buildings
      // (space.planets[].buildings, e.g. Cath's Satellite) share the "space"
      // candidate kind but are bought through different game controllers.
      return isSpacePlanetBuilding(meta)
        ? { path: ["classes", "ui", "space", "PlanetBuildingBtnController"], opts: (name) => ({ id: name }) }
        : { path: ["com", "nuclearunicorn", "game", "ui", "SpaceProgramBtnController"], opts: (name) => ({ id: name }) };
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

  // Ziggurat upgrades buy through the game's own ZigguratBtnController
  // (primary path in buyViaGameController).  When that class is unavailable,
  // the rendered Religion-tab buttons are the fallback — the same controller
  // instances the player clicks, so discounts stay exact.
  const buyViaZigguratTabButton = (name) => {
    try {
      const tab = window.gamePage && window.gamePage.religionTab;
      const buttons = (tab && (tab.zgUpgradeButtons || tab.zgUpgradeBtns)) || [];
      for (const button of buttons) {
        const id = button && ((button.opts && button.opts.id) || (button.model && button.model.options && button.model.options.id) || button.id);
        if (id !== name || !button.controller || typeof button.controller.buyItem !== "function") continue;
        const result = button.controller.buyItem(button.model, { boughtByQueue: true });
        return !!(result && result.itemBought);
      }
    } catch (error) {
      /* fall through to the next purchase attempt */
    }
    return false;
  };

  const buyViaGameController = (candidate) => {
    const game = window.gamePage;
    const meta = candidate && candidate.meta;
    const name = meta && meta.name;
    const spec = controllerSpecFor(candidate && candidate.kind, meta);
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
    if (candidate.kind === "ziggurat") {
      attempts.push(() => buyViaZigguratTabButton(name));
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
    if (candidate && candidate.kind === "festival") {
      const before = resourceSnapshot();
      const bought = buyFestivalCandidate();
      if (bought) markTelemetryDiscontinuity(resourceDeltasBetween(before, resourceSnapshot()));
      return bought;
    }
    if (!candidate || !candidate.meta || !candidate.meta.name) return false;
    const initialVal = VAL_BASED_KINDS.has(candidate.kind) ? candidate.meta.val || 0 : 0;
    let stageChanged = false;
    const result = executeSemanticAction({
      id: `candidate:${candidate.kind}:${candidate.meta.name}`,
      policy: ACTION_POLICY.SAFE_REPEATABLE,
      snapshot: resourceSnapshot,
      invoke: () => {
        if (candidate.kind === "stage") {
          stageChanged = executeStageTransitionCandidate(candidate);
          return;
        }
        for (const attempt of purchaseAttemptsFor(candidate)) {
          try {
            attempt();
          } catch (error) {
            /* try the next public API shape */
          }
          if (purchaseComplete(candidate, initialVal)) return;
        }
      },
      verify: () => candidate.kind === "stage" ? stageChanged : purchaseComplete(candidate, initialVal),
    });
    if (result.ok) {
      markTelemetryDiscontinuity(resourceDeltasBetween(result.before, result.after));
      return true;
    }
    if (actionPolicyFor(`candidate:${candidate.kind}:${candidate.meta.name}`) !== ACTION_POLICY.FORBIDDEN) {
      activePlanSnapshot = { cycleId: -1, target: undefined };
      resetTickCache();
    }
    return false;
  };

  // What the active plan still needs, by resource — held back from every other
  // purchase so the plan actually completes instead of being eaten by cheaper
  // buys (the classic "plan says Library, a Mine gets built" failure).
  // Costs above a storage cap are NOT reserved: saving can never reach those,
  // the storage planner handles them instead.
  const addLedgerNeed = (ledger, name, amount = 0) => {
    if (!name) return;
    ledger.critical.add(name);
    if (amount > 0) ledger.reserved[name] = Math.max(ledger.reserved[name] || 0, amount);
  };

  const addCraftClosureToLedger = (ledger, name, amount, resources, depth = 0) => {
    if (!name || depth > 6) return;
    addLedgerNeed(ledger, name, amount);
    const craft = craftByName(name);
    if (!craft) return;
    const prices = craftPricesFor(craft).filter((p) => p && p.name && p.val > 0);
    if (!prices.length) return;
    const baseUnits = Math.max(1, Math.ceil(Math.max(0, amount || 1) / Math.max(1, 1 + craftRatioFor(name))));
    for (const price of prices) {
      addLedgerNeed(ledger, price.name, price.val * baseUnits);
      addCraftClosureToLedger(ledger, price.name, price.val * baseUnits, resources, depth + 1);
    }
  };

  const buildTargetLedger = (target, resources) => {
    const ledger = { target, reserved: {}, missing: {}, direct: {}, crafted: new Set(), critical: new Set() };
    // Stage changes are two-step transactions (sell, then rebuild), so their
    // entire net bill remains reserved even when today's stock can cover it.
    // Ordinary affordable targets are bought immediately and need no ledger.
    if (!target || (target.affordable && target.kind !== "stage" && !target._stageRebuild)) return ledger;
    const isSprintTarget = target.kind === "research" && activeSprint && activeSprint.candidate && targetId(target) === activeSprint.id;
    const targetPrices = target._stageRebuild && target._stageRebuild.remainingPrices
      ? Object.entries(target._stageRebuild.remainingPrices).map(([name, val]) => ({ name, val }))
      : pricesFor(target.kind, target.meta);
    for (const cost of targetPrices) {
      if (!cost || !cost.name || !isFinite(cost.val) || cost.val <= 0) continue;
      if (isSprintTarget && CAP_DRAIN_RESOURCES.has(cost.name) && !isNearResourceCap(resources, cost.name)) continue;
      const res = getRes(resources, cost.name);
      // An above-cap final price is unattainable until storage grows (capped
      // banks clamp at their cap, craftable or not) — reserving it would only
      // freeze the bank for a purchase that cannot complete.
      if (res && res.maxValue > 0 && cost.val > res.maxValue && !target._stageRebuild) continue;
      const have = (res && res.value) || 0;
      // A multi-copy rebuild can cost more than one bank can hold. Reserve a
      // full live bank in that case; each copy spends it down and the atomic
      // continuation refills it without allowing any side spender through.
      const reservable = target._stageRebuild && res && res.maxValue > 0 ? Math.min(cost.val, res.maxValue) : cost.val;
      const missing = Math.max(0, reservable - have);
      ledger.direct[cost.name] = Math.max(ledger.direct[cost.name] || 0, reservable);
      ledger.missing[cost.name] = Math.max(ledger.missing[cost.name] || 0, missing);
      ledger.critical.add(cost.name);
      // Reserve only components that remain unsatisfied after inventory netting.
      // If the player already holds enough Gear/Blueprint for a Magneto, those
      // components (and their upstream Science/Compendium/Manuscript chains) are
      // deliberately left out of the active reserve.
      if (missing <= 0 && target.kind !== "stage" && !target._stageRebuild) continue;
      addLedgerNeed(ledger, cost.name, reservable);
      if (craftByName(cost.name) && rawWorkNeedName(cost.name) !== cost.name) {
        ledger.crafted.add(cost.name);
        addCraftClosureToLedger(ledger, cost.name, Math.max(1, missing), resources);
        const raw = rawPathRequirements(cost.name, Math.max(1, missing));
        for (const [name, amount] of Object.entries(raw)) addLedgerNeed(ledger, name, amount);
      }
      // A tears deficit is funded by the bounded unicorn→tears sacrifice, so
      // reserve the unicorns that conversion will consume — otherwise a surplus
      // Unicorn Pasture buy could eat the bank mid-save.
      const sacrifice = sacrificeConversionFor(cost.name);
      if (sacrifice && missing > 0) {
        addLedgerNeed(ledger, sacrifice.inputName, Math.ceil(missing / sacrifice.gainPerChunk) * sacrifice.inputPerChunk);
      }
    }
    return ledger;
  };

  const mergeLedger = (into, ledger, source = "active plan") => {
    for (const [name, amount] of Object.entries((ledger && ledger.reserved) || {})) {
      into.reserved[name] = Math.max(into.reserved[name] || 0, amount);
      (into.sources[name] || (into.sources[name] = [])).push(source);
    }
    for (const name of (ledger && ledger.critical) || []) into.critical.add(name);
    return into;
  };

  const manualQueueReservationLedger = (resources) => {
    const out = { reserved: {}, critical: new Set(), sources: {} };
    for (const item of readQueue()) {
      if (queueItemDone(item)) continue;
      const meta = lookupMetaById(item.id);
      const [kind] = String(item.id).split(":");
      if (!meta) continue;
      const candidate = { kind, meta, affordable: false };
      // Reserve ONLY for queue items the bot can actually work toward right now —
      // the same reachability gate pickQueuedTarget uses to choose one.  A
      // storage-blocked queued tech (e.g. Biochemistry, whose final pure-science
      // cost is several times the science cap) is NOT yet actionable: its craft
      // intermediates cycle science incrementally, so reserving the whole chain
      // (an unsatisfiable, >cap science hold) only locked every other spender and
      // stalled the plan.  Once science storage grows enough that the final cost
      // fits the cap, the item becomes reachable and is both selected AND reserved
      // together — keeping the "craft first, spend pure science last" ordering.
      if (!solveCraftChain(resources, candidate).reachable) continue;
      mergeLedger(out, buildTargetLedger(candidate, resources), `manual queue ${labelOf(meta)}`);
    }
    return out;
  };

  // While a sprint trickle-leg redirect points the plan at a producer building,
  // the sprint tech's own chain (manuscripts, their parchment/furs legs) must
  // stay reserved — otherwise a surplus Temple buy could eat the manuscripts
  // the moment the plan target stops being the tech itself.
  const sprintRedirectChainLedger = (resources, target) => {
    const redirectTech = sprintRedirectCraftTarget(target);
    return redirectTech ? buildTargetLedger(redirectTech, resources) : null;
  };

  const survivalReservationLedger = (resources) => {
    const out = { reserved: {}, critical: new Set(), sources: {} };
    const catnip = getRes(resources, "catnip");
    if (catnip) {
      const floor = craftReserveFor(resources, "catnip");
      out.reserved.catnip = Math.max(out.reserved.catnip || 0, floor);
      out.critical.add("catnip");
      out.sources.catnip = ["survival"];
    }
    const cp = getRes(resources, "manpower") || getRes(resources, "catpower");
    if (cp) {
      const floor = craftReserveFor(resources, "manpower");
      out.reserved.manpower = Math.max(out.reserved.manpower || 0, floor);
      out.critical.add("manpower");
      out.sources.manpower = ["survival"];
    }
    return out;
  };

  const buildReservationLedger = (target, resources) => {
    const out = { target, reserved: {}, critical: new Set(), sources: {} };
    mergeLedger(out, buildTargetLedger(target, resources), target ? `active plan ${labelOf(target.meta)}` : "active plan");
    const sprintChain = sprintRedirectChainLedger(resources, target);
    if (sprintChain) mergeLedger(out, sprintChain, `research sprint ${labelOf(activeSprint.candidate.meta)}`);
    mergeLedger(out, manualQueueReservationLedger(resources), "manual queue");
    mergeLedger(out, unicornPathReservationLedger(resources), "unicorn path");
    mergeLedger(out, pendingPolicyReservationLedger(resources), "policy choice");
    mergeLedger(out, survivalReservationLedger(resources), "survival");
    return out;
  };

  const reservedNeedsFor = (target, resources) => buildReservationLedger(target, resources).reserved;

  // Resources the active target still needs to bank MORE of, where the needed
  // amount fits under the cap (so saving toward it is actually possible).  These
  // must be exempt from the >0.94 cap anti-waste rule: when a tech/building cost
  // lands between 94% and 100% of the cap, the producing job (scholars for a
  // science tech) otherwise gets hard-zeroed a few units short and the plan
  // stalls forever.  Storage-blocked costs are not in the ledger's reserved set,
  // so a cap-blocked tech never triggers this (the storage-unlock layer owns that
  // case instead).
  const targetClimbNeeds = (target, resources) => {
    const climb = {};
    if (!target || target.affordable) return climb;
    for (const [name, amount] of Object.entries(reservedNeedsFor(target, resources))) {
      if (!(amount > 0)) continue;
      const res = getRes(resources, name);
      if (!res) continue;
      const cap = res.maxValue || 0;
      if (cap > 0 && amount > cap) continue;
      if ((res.value || 0) >= amount) continue;
      const route = acquisitionPathFor(resources, name, amount, { finalPurchase: true });
      if (route.reachable && (route.kind === "trade" || route.kind === "discovery")) continue;
      climb[name] = amount;
    }
    return climb;
  };

  const spendImpactForPrices = (prices, resources) => {
    const impact = {};
    const critical = new Set();
    const add = (name, amount = 0) => {
      if (!name) return;
      critical.add(name);
      impact[name] = (impact[name] || 0) + Math.max(0, amount || 0);
    };
    for (const cost of prices || []) {
      if (!cost || !cost.name || !isFinite(cost.val) || cost.val <= 0) continue;
      add(cost.name, cost.val);
      if (craftByName(cost.name)) {
        for (const name of craftChainOutputsFor(cost.name)) critical.add(name);
        const raw = rawPathRequirements(cost.name, Math.max(1, cost.val));
        for (const [name, amount] of Object.entries(raw)) add(name, amount);
      }
    }
    return { impact, critical };
  };

  const spendImpactForCandidate = (candidate, resources) => spendImpactForPrices(pricesFor(candidate.kind, candidate.meta), resources);

  const targetLockViolationForPrices = (prices, ledger, resources) => {
    if (!ledger || !ledger.target || !ledger.critical || !ledger.critical.size) return null;
    const spend = spendImpactForPrices(prices, resources);
    const overlaps = [...spend.critical].filter((name) => ledger.critical.has(name));
    if (!overlaps.length) return null;
    for (const [name, amount] of Object.entries(spend.impact)) {
      const hold = ledger.reserved[name] || (name === "catpower" ? ledger.reserved.manpower || 0 : 0);
      if (hold > 0) {
        const stock = resourceValue(resources, name);
        if (stock - amount < hold) return { names: overlaps, reason: `target lock — spends ${overlaps.slice(0, 6).join("/")} chain reserved for ${labelOf(ledger.target.meta)}` };
      }
    }
    return { names: overlaps, reason: `target lock — spends ${overlaps.slice(0, 6).join("/")} chain reserved for ${labelOf(ledger.target.meta)}` };
  };

  const violatesTargetLock = (candidate, ledger, resources) => targetLockViolationForPrices(pricesFor(candidate.kind, candidate.meta), ledger, resources);

  const respectsReservations = (candidate, reserved, resources, ledger = null) => !violatesTargetLock(candidate, ledger, resources) && pricesRespectReservations(pricesFor(candidate.kind, candidate.meta), reserved, resources);

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
  //  2. auto-buy policies — non-exclusive on sight, exclusive groups by ranked
  //     best side; a pending pick's bill is reserved as culture-chain state;
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

      const ledger = buildTargetLedger(target, resources);
      // A redirected sprint's chain stays reserved against surplus/cap-relief
      // buys even though the plan target is the producer building.
      const sprintChain = sprintRedirectChainLedger(resources, target);
      if (sprintChain) {
        for (const [name, amount] of Object.entries(sprintChain.reserved)) {
          ledger.reserved[name] = Math.max(ledger.reserved[name] || 0, amount);
        }
        for (const name of sprintChain.critical) ledger.critical.add(name);
      }
      // The pending exclusive policy's bill is culture-chain state: cap relief
      // and surplus buys below must leave that bank alone while it accrues.
      // Amounts only — the policy save is a bank hold like the unicorn path,
      // not a hard chain lock, so ledger.critical stays the target's own chain.
      const policyHold = pendingPolicyReservationLedger(resources, goalKey);
      for (const [name, amount] of Object.entries(policyHold.reserved)) {
        ledger.reserved[name] = Math.max(ledger.reserved[name] || 0, amount);
      }
      const reserved = ledger.reserved;
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
        // Exclusive picks also clear the FULL reservation ledger (manual queue,
        // unicorn path, a higher-ranked pending pick from another group) — a
        // policy buy must not eat culture some other focus is saving. The
        // pending pick itself never appears in that ledger while affordable.
        const policy = autoPolicyChoice(resources, goalKey);
        if (policy && !buyBenched(targetId(policy)) && !violatesTargetLock(policy, ledger, resources) &&
            pricesRespectReservations(pricesFor("policy", policy.meta), reservedNeedsFor(target, resources), resources)) {
          lastAutoBuy = now;
          if (buyCandidate(policy)) {
            const blocks = (policy.meta.blocks || []).filter(Boolean);
            pushLog(`📜 policy ${labelOf(policy.meta)}${blocks.length ? ` — chosen over ${blocks.join(", ")}` : " (blocks nothing)"}`);
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
        candidate.kind !== "stage" &&
        (!target || targetId(candidate) !== targetId(target)) &&
        !buyBenched(targetId(candidate)) &&
        respectsReservations(candidate, reserved, resources, ledger));
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

  /* --------------------------- parallel-tier work ---------------------------
   * While the active plan waits on a non-craftable trickle (Temple's last 124
   * gold at +0.2/s), every other capped income stream used to idle: the top-
   * ranked Harbour needed 6.75 Scaffold that nobody would craft while wood and
   * minerals burned at their caps.  Rank-ordered candidates form parallel
   * tiers: a candidate whose spend clears the COMPLETE reservation ledger —
   * including the active target's banked direct prices and the redirected
   * sprint's chain — is independent work, not a rival.  This pass crafts such
   * a candidate's missing intermediates strictly ABOVE those floors and buys
   * it once it is affordable with every floor intact.  Anything that would dip
   * a held bank is skipped, so the plan's savings stay untouchable; cap-drain
   * banks (culture/science/faith) carry the sprint's cumulative bill as a
   * floor and are therefore never spendable here.
   */
  const PARALLEL_TIER_SCAN = 8;   // ranked candidates inspected per tick
  const PARALLEL_TIER_CRAFTS = 2; // distinct candidates crafted toward per tick
  let parallelPlanText = "Parallel: idle";

  // Floors a parallel spender must leave intact: the merged reservation ledger
  // (active plan, redirected sprint chain, manual queue, unicorn path, policy
  // hold, survival) plus the active target's and the redirected sprint's
  // BANKED direct prices.  buildTargetLedger deliberately drops satisfied
  // costs from `reserved` (they need no saving), but a parallel buy eating
  // Temple's banked 203 slabs would un-afford the plan just the same.
  const parallelReservationFloors = (target, resources) => {
    const merged = buildReservationLedger(target, resources);
    const floors = { ...merged.reserved };
    const raiseDirect = (ledger) => {
      for (const [name, amount] of Object.entries((ledger && ledger.direct) || {})) {
        floors[name] = Math.max(floors[name] || 0, amount);
      }
    };
    raiseDirect(buildTargetLedger(target, resources));
    raiseDirect(sprintRedirectChainLedger(resources, target));
    return floors;
  };

  const priceClearsParallelFloor = (price, floors, resources) => {
    const floor = floors[price.name] || (price.name === "catpower" ? floors.manpower || 0 : 0);
    if (!(floor > 0)) return true;
    return ((((getRes(resources, price.name) || {}).value) || 0) - price.val) >= floor;
  };

  const craftTowardParallelCandidates = (resources, goalKey) => {
    try {
      const target = getTargetCached(resources, goalKey);
      if (!target || target.affordable) {
        parallelPlanText = "Parallel: idle";
        return;
      }
      if (isSprintCandidate(target, resources)) {
        parallelPlanText = "Parallel: sprint holds all surplus";
        return;
      }
      const floors = parallelReservationFloors(target, resources);
      // A GO stage transition whose net bill is fully banked is parallel work
      // too. The layers above the stage layer (research sprint, science-storage
      // unlock) can hold the plan for hours, and executePlan's surplus and
      // cap-relief paths deliberately skip kind "stage" — so an affordable
      // swap could otherwise never fire while a structural layer owns the plan
      // (live: Amphitheatre→Broadcast Tower read "GO, payback ≈7s" at rank 1
      // for the whole culture-paced Genetics sprint it would have
      // accelerated). Execute the best swap whose net prices clear every
      // reservation floor; the atomic rebuild contract then outranks the plan
      // as usual until parity is restored.
      if (!pendingStageRebuild && Date.now() - lastAutoBuy >= AUTOBUY_MIN_MS) {
        const swaps = stageTransitionCandidates(resources)
          .filter((candidate) => candidate && candidate.affordable && !buyBenched(targetId(candidate)) &&
            (candidate.meta.prices || []).every((price) => priceClearsParallelFloor(price, floors, resources)))
          .sort((a, b) => (b.meta.analysis.rankGain / Math.max(1, b.meta.analysis.payback + 1)) -
            (a.meta.analysis.rankGain / Math.max(1, a.meta.analysis.payback + 1)));
        if (swaps.length) {
          lastAutoBuy = Date.now();
          if (executeStageTransitionCandidate(swaps[0])) {
            parallelPlanText = `Parallel: staged ${labelOf(swaps[0].meta)}`;
            pushLog(`🏭 parallel stage ${labelOf(swaps[0].meta)} (${swaps[0].meta.analysis.reason}; ${labelOf(target.meta)} keeps its reserves)`);
            return;
          }
          noteBuyFailure(targetId(swaps[0]));
        }
      }
      const candidates = getCandidatesCached(resources, goalKey);
      const worked = [];
      let boughtThisTick = false;
      let inspected = 0;
      const strategicPreferredId = lastStrategicDecision && lastStrategicDecision.preferredTarget
        ? targetId(lastStrategicDecision.preferredTarget)
        : "";
      for (let index = 0; index < candidates.length && worked.length < PARALLEL_TIER_CRAFTS; index += 1) {
        if (inspected >= PARALLEL_TIER_SCAN) break;
        const candidate = candidates[index];
        if (!candidate || !candidate.meta) continue;
        if (candidate.kind === "stage" || candidate.kind === "policy" || candidate.kind === "festival") continue;
        if (targetId(candidate) === targetId(target)) continue;
        // If hysteresis is still holding the old plan, the newly preferred
        // roadmap target must wait to become the plan; parallel work is not a
        // second executor for the pending takeover.
        if (targetId(candidate) === strategicPreferredId) continue;
        if (activeSprint && activeSprint.id && targetId(candidate) === activeSprint.id) continue; // the sprint contract owns its tech
        if (buyBenched(targetId(candidate))) continue;
        inspected += 1;
        const prices = pricesFor(candidate.kind, candidate.meta).filter((price) => price && price.name && isFinite(price.val) && price.val > 0);
        if (!prices.length) continue;
        if (directStorageBlockers(candidate.kind, candidate.meta, resources).length) continue;
        // Every price must either be banked above its floor already or be
        // craftable — a non-craftable deficit (a rival gold bill) means this
        // candidate cannot be finished from surplus; skip it whole.
        const shorts = prices.filter((price) => {
          const floor = floors[price.name] || (price.name === "catpower" ? floors.manpower || 0 : 0);
          const have = (((getRes(resources, price.name) || {}).value) || 0);
          return have < price.val + Math.max(0, floor);
        });
        // A short whose BANK already covers the price is only reservation-HELD
        // (a sprint's cap-drain science bank carrying the cumulative bill):
        // the hold releases on its own when the sprint completes, so the
        // candidate can still finish from surplus later — keep readying its
        // genuinely missing craftable materials instead of skipping it whole.
        // Live, every science-priced workshop upgrade froze for the entire
        // multi-hour Genetics sprint because 52-100K science read as a
        // non-craftable deficit against the 2.73M reserved bank. Only a truly
        // missing non-craftable price (a rival gold bill) still skips whole,
        // and the buy below still requires EVERY floor to clear.
        const trulyMissing = shorts.filter((price) => ((((getRes(resources, price.name) || {}).value) || 0) < price.val));
        if (trulyMissing.some((price) => !craftByName(price.name))) continue;
        if (!shorts.length) {
          // Fully banked above every floor: finish it, throttled like any buy.
          if (boughtThisTick || !candidate.affordable) continue;
          const now = Date.now();
          if (now - lastAutoBuy < AUTOBUY_MIN_MS) continue;
          if (!prices.every((price) => priceClearsParallelFloor(price, floors, resources))) continue;
          lastAutoBuy = now;
          if (buyCandidate(candidate)) {
            boughtThisTick = true;
            worked.push(`${labelOf(candidate.meta)} built`);
            pushLog(`🏗 parallel ${candidate.kind} ${labelOf(candidate.meta)} (rank ${index + 1}; ${labelOf(target.meta)} keeps its reserves)`);
          } else {
            noteBuyFailure(targetId(candidate));
          }
          continue;
        }
        // Craft every CRAFTABLE short above its floor — a craftable bank-held
        // price (Harbour's slab above the Temple's banked 200) is completed by
        // crafting MORE, never by dipping the held bank (the v2.15 contract).
        // A non-craftable bank-held price (the sprint's science) just waits
        // for its hold to release; when nothing is craftable there is nothing
        // to do this tick.  target=null keeps the conservative idle cushions
        // on luxuries; the floors map carries every held bank, so this can
        // only convert genuine surplus.
        const craftableShorts = shorts.filter((price) => craftByName(price.name));
        if (!craftableShorts.length) continue;
        let craftedAny = false;
        for (const price of craftableShorts) {
          const floor = Math.max(0, floors[price.name] || 0);
          const before = (((getRes(resourceMap(), price.name) || {}).value) || 0);
          tryCraftResource(price.name, price.val + floor, 0, null, price.name, floors);
          if ((((getRes(resourceMap(), price.name) || {}).value) || 0) > before) craftedAny = true;
        }
        if (craftedAny) worked.push(`${craftLabel(craftableShorts[0].name)} for ${labelOf(candidate.meta)} (rank ${index + 1})`);
      }
      parallelPlanText = worked.length
        ? `Parallel: ${worked.join(" · ")}`
        : `Parallel: top tiers wait (reserves for ${labelOf(target.meta)} intact)`;
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

  const tradeWithRace = (race, count = 1, preferAll = false) => {
    const diplomacy = window.gamePage && window.gamePage.diplomacy;
    const amount = Math.max(1, Math.floor(count) || 1);
    if (!diplomacy || !race) return false;
    const prices = tradePricesForRace(race);
    const names = tradeDeltaNamesForRace(race, prices);
    const snapshot = () => Object.fromEntries([...names].map((name) => [name, resourceValue(resourceMap(), name)]));
    const changed = (before, after) => Object.keys(before || {}).some((name) => after[name] !== before[name]);
    const result = executeSemanticAction({
      id: `trade:${race.name}`,
      policy: ACTION_POLICY.SAFE_REPEATABLE,
      snapshot,
      invoke: () => {
        if (preferAll && typeof diplomacy.tradeAll === "function") diplomacy.tradeAll(race);
        else if (typeof diplomacy.tradeMultiple === "function") diplomacy.tradeMultiple(race, amount);
        else if (typeof diplomacy.trade === "function") diplomacy.trade(race);
      },
      verify: changed,
    });
    return result.ok;
  };

  // How many Zebra trades we can fire in one batch.  Single-trade-per-tick is
  // why hand-trading feels faster than the bot: with a 10s diplomacy throttle a
  // 15%-odds trade trickles in titanium.  We batch up to what the SURPLUS (after
  // plan reservations) can pay, but never more than is needed to cover the
  // current titanium demand, and never enough to overflow the titanium cap.
  const MAX_TRADE_BATCH = 50;
  const reservationFloorFor = (reserved, name) => {
    if (!reserved || !name) return 0;
    if (name === "manpower" || name === "catpower") {
      return Math.max(0, reserved.manpower || 0, reserved.catpower || 0);
    }
    return Math.max(0, reserved[name] || 0);
  };

  const affordableTradeCount = (prices, reserved, resources) => {
    let count = Infinity;
    for (const price of prices) {
      if (!price || !price.name || !isFinite(price.val) || price.val <= 0) continue;
      const stock = resourceValue(resources, price.name);
      const hold = reservationFloorFor(reserved, price.name);
      const spendable = Math.max(0, stock - Math.max(0, hold));
      count = Math.min(count, Math.floor(spendable / price.val));
    }
    return isFinite(count) ? Math.max(0, count) : 0;
  };

  const boundedTradeBatch = (route, ledger, resources) => {
    const step = route && route.nextStep;
    const race = step && step.kind === "trade" ? step.race : null;
    if (!route || !route.reachable || !race) return 0;
    const liveResources = resources || resourceMap();
    const prices = tradePricesForRace(race);
    const affordable = affordableTradeCount(prices, (ledger && ledger.reserved) || {}, liveResources);
    if (affordable <= 0) return 0;

    const outputName = step.resource || route.resource;
    const output = getRes(liveResources, outputName);
    const current = resourceValue(liveResources, outputName);
    const deficit = Math.max(0, (Number(route.amount) || 0) - current);
    if (!(deficit > 0)) return 0;
    const expected = Math.max(0, Number(step.expectedYield) || Number(route.expectedYield) ||
      (step.sell ? expectedTradeYield(race, step.sell) : 0));
    if (!(expected > 0)) return 0;

    const deficitBound = Math.max(1, Math.ceil(deficit / expected));
    const headroom = output && output.maxValue > 0
      ? Math.max(0, output.maxValue - current)
      : Number.POSITIVE_INFINITY;
    if (headroom <= 0) return 0;
    const headroomBound = isFinite(headroom) ? Math.max(0, Math.floor(headroom / expected)) : Number.POSITIVE_INFINITY;
    if (headroomBound <= 0) return 0;
    const routeBound = step.trades > 0 ? Math.ceil(step.trades) : Number.POSITIVE_INFINITY;
    return Math.max(0, Math.min(affordable, deficitBound, headroomBound, routeBound, MAX_TRADE_BATCH));
  };

  const craftDiplomacyPrerequisites = (resources, goalKey) => {
    const before = resourceSnapshot();
    try {
      if (!titaniumNeededSoon(resources, goalKey)) {
        diplomacyPrepText = "Diplomacy prep: watching trade unlocks";
        return false;
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
      return resourceDeltasBetween(before, resourceSnapshot()).length > 0;
    } catch (error) {
      /* ignore diplomacy prerequisite crafting failures */
      return false;
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

    const target = getTargetCached(resources, goalKey);
    const route = activeAcquisitionRoute(target, resources);
    if (route && route.nextStep && route.nextStep.race) {
      addPriceDeficits(tradePricesForRace(route.nextStep.race), 1.8);
      if (isZebraTitaniumTradeRoute(route)) {
        const wantedShips = desiredZebraShipCount(resources, goalKey);
        const fleetShort = resourceValue(resources, "ship") < wantedShips;
        pressure.ship = Math.max(pressure.ship || 0, fleetShort ? 8 : 2);
      }
    }

    return pressure;
  };

  const pricesRespectReservations = (prices, reserved, resources) => prices.every((price) => {
    if (!price || !price.name || !isFinite(price.val) || price.val <= 0) return true;
    const hold = reservationFloorFor(reserved, price.name);
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
    try {
      const Controller = getGlobalPath(["classes", "diplomacy", "ui", "EmbassyButtonController"]);
      if (!game || typeof Controller !== "function") return null;
      const controller = new Controller(game);
      if (typeof controller.fetchModel !== "function" || typeof controller.buyItem !== "function") return null;
      const model = controller.fetchModel({ prices: race.embassyPrices, race, controller });
      if (!model) return null;
      const snapshot = () => ({ level: race.embassyLevel || 0, resources: resourceSnapshot() });
      const result = executeSemanticAction({
        id: `embassy:${race.name}`,
        policy: ACTION_POLICY.SAFE_REPEATABLE,
        snapshot,
        invoke: () => controller.buyItem(model, { boughtByQueue: true }),
        verify: (before, after) => after.level !== before.level || resourceDeltasBetween(before.resources, after.resources).length > 0,
      });
      return result.ok;
    } catch (error) {
      return false;
    }
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
    const button = game && game.tradeTab && game.tradeTab.exploreBtn;
    const controller = button && button.controller;
    const model = button && button.model;
    const price = explorerPrices();
    if (!hasLockedDiscoverableRace() || !canPayPrices(price) || !pricesRespectReservations(price, reserved, resources)) return false;
    if (!controller || !model || typeof controller.buyItem !== "function") {
      diplomacyPlanText = "Diplomacy: explorer controller unavailable; no action taken";
      return null;
    }
    const snapshot = () => ({
      unlocked: new Set(unlockedRaces()),
      resources: resourceSnapshot(),
    });
    const result = executeSemanticAction({
      id: "explore:races",
      policy: ACTION_POLICY.SAFE_REPEATABLE,
      snapshot,
      invoke: () => controller.buyItem(model, { boughtByQueue: true }),
      verify: (before, after) => after.unlocked.size !== before.unlocked.size || resourceDeltasBetween(before.resources, after.resources).length > 0,
    });
    if (result.ok) {
      const race = [...result.after.unlocked].find((item) => !result.before.unlocked.has(item)) || null;
      diplomacyPlanText = race
        ? `Diplomacy: sent explorers; met ${race.title || race.name || "a civilization"}`
        : "Diplomacy: explorer action used resources; no race revealed";
      pushLog(`🧭 ${diplomacyPlanText}`);
      return true;
    }
    diplomacyPlanText = "Diplomacy: explorers need later unlock conditions";
    return false;
  };

  // Live season name read from the game's calendar.  Used to fold the per-sell
  // season multiplier into the expected yield, which the game already applies
  // when tradeAll() actually fires — so our scoring lines up with reality
  // (a Winter Furs trade IS worth less than a Summer one).
  const currentTradeSeasonName = () => {
    try {
      const cal = window.gamePage && window.gamePage.calendar;
      if (!cal) return null;
      if (typeof cal.getCurSeason === "function") {
        const s = cal.getCurSeason();
        if (s && s.name) return s.name;
      }
      if (Array.isArray(cal.seasons) && isFinite(cal.season)) {
        const s = cal.seasons[cal.season];
        if (s && s.name) return s.name;
      }
    } catch (error) {
      /* ignore */
    }
    return null;
  };

  const tradeSeasonMultiplier = (sell) => {
    const season = currentTradeSeasonName();
    if (!season || !sell || !sell.seasons || typeof sell.seasons !== "object") return 1;
    const delta = sell.seasons[season];
    return isFinite(delta) ? Math.max(0, 1 + delta) : 1;
  };

  const validRaceSell = (race, sell) => {
    if (!race || !race.unlocked || !sell || !sell.name) return false;
    const diplomacy = window.gamePage && window.gamePage.diplomacy;
    if (diplomacy && typeof diplomacy.isValidTrade === "function") {
      try {
        return !!diplomacy.isValidTrade(sell, race);
      } catch (error) {
        /* use the live-compatible fallback below */
      }
    }
    if (sell.minLevel && (race.embassyLevel || 0) < sell.minLevel) return false;
    const resource = getRes(resourceMap(), sell.name);
    return !!(resource && resource.unlocked !== false) || sell.name === "uranium" || race.name === "leviathans";
  };

  const tradeStandingMultiplier = (race, diplomacy) => {
    let standing = isFinite(race && race.standing) ? race.standing : 0;
    if (diplomacy && typeof diplomacy.getFinalStanding === "function") {
      try {
        const live = diplomacy.getFinalStanding(race);
        if (isFinite(live)) standing = live;
      } catch (error) {
        /* use race metadata */
      }
    }
    return standing < 0 ? Math.max(0, 1 + standing) : 1 + standing * 0.25;
  };

  const tradeRatioMultiplier = (race, diplomacy) => {
    let ratio = 0;
    if (diplomacy && typeof diplomacy.getTradeRatio === "function") {
      try { ratio += Number(diplomacy.getTradeRatio()) || 0; } catch (error) { /* no live ratio */ }
    } else {
      try { ratio += Number(window.gamePage.getEffect("tradeRatio")) || 0; } catch (error) { /* no effect API */ }
    }
    if (diplomacy && typeof diplomacy.calculateTradeBonusFromPolicies === "function") {
      try { ratio += Number(diplomacy.calculateTradeBonusFromPolicies(race.name, window.gamePage)) || 0; } catch (error) { /* no policy bonus */ }
    }
    return Math.max(0, 1 + ratio);
  };

  const expectedTradeYield = (race, sell) => {
    if (!validRaceSell(race, sell)) return 0;
    const amount = isFinite(sell.value) ? sell.value : (isFinite(sell.val) ? sell.val : 0);
    const diplomacy = window.gamePage && window.gamePage.diplomacy;
    let chance = isFinite(sell.chance) ? sell.chance : 1;
    if (diplomacy && typeof diplomacy.getResourceTradeChance === "function") {
      try {
        const live = diplomacy.getResourceTradeChance(sell, race);
        if (isFinite(live)) chance = live;
      } catch (error) {
        /* use the fractional metadata chance */
      }
    }
    const seasonMult = tradeSeasonMultiplier(sell);
    const standingMult = tradeStandingMultiplier(race, diplomacy);
    const ratioMult = tradeRatioMultiplier(race, diplomacy);
    const energyMult = Math.max(0, 1 + (Number(race.energy) || 0) * 0.02);
    return Math.max(0, amount * Math.max(0, Math.min(1, chance || 0)) * seasonMult * standingMult * ratioMult * energyMult);
  };

  const tradeSellExpected = (sell, race = null) => race ? expectedTradeYield(race, sell) : 0;

  const acquisitionAmountBucket = (amount) => Math.max(0, Math.ceil(Math.log2(Math.max(0, amount) + 1)));

  const blockedAcquisitionPath = (resources, name, amount, blockers = []) => ({
    reachable: false,
    eta: Number.POSITIVE_INFINITY,
    kind: "blocked",
    resource: name,
    amount,
    inputs: [],
    race: null,
    expectedYield: 0,
    blockers: blockers.length ? blockers : [`no acquisition path for ${resTitle(resources, name)}`],
    nextStep: null,
  });

  const reachableAcquisitionPath = (name, amount, kind, eta, extras = {}) => ({
    reachable: true,
    eta: Math.max(0, Number(eta) || 0),
    kind,
    resource: name,
    amount,
    inputs: [],
    race: null,
    expectedYield: 0,
    blockers: [],
    nextStep: { kind, resource: name },
    ...extras,
  });

  const acquisitionRoutePriority = (route) => ({
    bank: 0,
    passive: 1,
    job: 2,
    craft: 3,
    hunt: 4,
    conversion: 5,
    discovery: 6,
    trade: 7,
    producer: 8,
    storage: 9,
  })[route.kind] ?? 99;

  const acquisitionBridgeCandidates = () => [
    ...buildingMetas().map((meta) => ({ kind: "build", meta })),
    ...spaceMetas().map((meta) => ({ kind: "space", meta })),
    ...timeMetas().map((meta) => ({ kind: "time", meta })),
  ].filter(({ kind, meta }) => meta && meta.name && (kind === "build" ? isOpen(meta) : spaceTimeOpen(meta)));

  const routeResourcesInto = (route, chain) => {
    if (!route) return chain;
    if (route.resource) chain.add(route.resource);
    for (const input of route.inputs || []) routeResourcesInto(input, chain);
    return chain;
  };

  const acquisitionPathFor = (resources, name, amount, context = {}, seen = new Set()) => {
    const requested = Math.max(0, Number(amount) || 0);
    const key = `${name}:${acquisitionAmountBucket(requested)}`;
    if (seen.has(key)) return blockedAcquisitionPath(resources, name, requested, [`acquisition cycle at ${key}`]);
    const branchSeen = new Set(seen);
    branchSeen.add(key);

    const have = resValueOf(resources, name);
    const deficit = Math.max(0, requested - have);
    if (deficit <= 0) {
      return reachableAcquisitionPath(name, requested, "bank", 0, { nextStep: { kind: "bank", resource: name } });
    }

    const max = resMaxOf(resources, name);
    const storageBlocked = !context.refillCycles && max > 0 && requested > max;
    const routes = [];
    const rejected = [];

    if (storageBlocked) {
      for (const bridge of acquisitionBridgeCandidates()) {
        const profile = candidateEffectProfile(bridge.kind, bridge.meta);
        const gain = Number(profile.max && profile.max[name]) || 0;
        if (!(gain > 0)) continue;
        const copies = Math.max(1, Math.ceil((requested - max) / gain));
        const inputs = [];
        let eta = 0;
        let reachable = true;
        for (const price of pricesFor(bridge.kind, bridge.meta).filter((p) => p && p.name && p.val > 0)) {
          const input = acquisitionPathFor(resources, price.name, price.val * copies, { ...context, refillCycles: true }, branchSeen);
          inputs.push(input);
          if (!input.reachable) reachable = false;
          else eta = Math.max(eta, input.eta);
        }
        if (!reachable) {
          rejected.push(...inputs.flatMap((input) => input.blockers || []));
          continue;
        }
        routes.push(reachableAcquisitionPath(name, requested, "storage", eta, {
          inputs,
          nextStep: { kind: "storage", candidateKind: bridge.kind, meta: bridge.meta, copies, resource: name },
        }));
      }
      if (!routes.length) {
        return blockedAcquisitionPath(resources, name, requested, [
          `${resTitle(resources, name)} storage cap ${fmt(max)}/${fmt(requested)}`,
          ...rejected.slice(0, 2),
        ]);
      }
      return routes.sort((a, b) => a.eta - b.eta)[0];
    }

    const passiveRate = rawProductionForNeed(name);
    if (passiveRate > 0) routes.push(reachableAcquisitionPath(name, requested, "passive", deficit / passiveRate));

    if (resourceHasDirectJobPath(name)) {
      const jobRate = directJobRatePerSecondFor(name);
      if (jobRate > 0) routes.push(reachableAcquisitionPath(name, requested, "job", deficit / jobRate));
      else rejected.push(`no positive direct job rate for ${resTitle(resources, name)}`);
    }

    const craft = craftByName(name);
    if (craft) {
      const prices = craftPricesFor(craft).filter((price) => price && price.name && price.val > 0);
      const output = Math.max(0.000001, 1 + craftRatioFor(name));
      const units = Math.max(1, Math.ceil(deficit / output));
      const inputs = [];
      let eta = 0;
      let reachable = prices.length > 0;
      for (const price of prices) {
        const inputCap = resMaxOf(resources, price.name);
        if (inputCap > 0 && price.val > inputCap) {
          reachable = false;
          rejected.push(`${resTitle(resources, price.name)} cap below one ${craftLabel(name)} craft`);
          continue;
        }
        const input = acquisitionPathFor(resources, price.name, price.val * units, { ...context, refillCycles: true }, branchSeen);
        inputs.push(input);
        if (!input.reachable) {
          reachable = false;
          rejected.push(...(input.blockers || []));
        } else eta = Math.max(eta, input.eta);
      }
      if (reachable) {
        routes.push(reachableAcquisitionPath(name, requested, "craft", eta, {
          inputs,
          nextStep: { kind: "craft", resource: name, craft, units },
        }));
      }
    }

    if (HUNT_OUTPUT_RESOURCES.has(name)) {
      const huntCost = Math.max(1, 100 - (typeof window.gamePage.getEffect === "function" ? (window.gamePage.getEffect("huntCatpowerDiscount") || 0) : 0));
      const hunts = Math.max(1, Math.ceil(deficit / 50));
      const input = acquisitionPathFor(resources, "manpower", huntCost * hunts, { ...context, refillCycles: true }, branchSeen);
      if (input.reachable) {
        routes.push(reachableAcquisitionPath(name, requested, "hunt", input.eta, {
          inputs: [input],
          nextStep: { kind: "hunt", resource: name, hunts },
        }));
      } else rejected.push(...(input.blockers || []));
    }

    const conversion = sacrificeConversionFor(name);
    if (conversion) {
      const chunks = Math.max(1, Math.ceil(deficit / conversion.gainPerChunk));
      const input = acquisitionPathFor(resources, conversion.inputName, chunks * conversion.inputPerChunk, { ...context, refillCycles: true }, branchSeen);
      if (input.reachable) {
        routes.push(reachableAcquisitionPath(name, requested, "conversion", input.eta, {
          inputs: [input],
          expectedYield: conversion.gainPerChunk,
          nextStep: { kind: "conversion", resource: name, conversion, chunks },
        }));
      } else rejected.push(...(input.blockers || []));
    }

    const diplomacyRaces = (() => {
      try {
        const races = window.gamePage && window.gamePage.diplomacy && window.gamePage.diplomacy.races;
        return Array.isArray(races) ? races : [];
      } catch (error) {
        return [];
      }
    })();
    const lockedZebras = name === "titanium" ? diplomacyRaces.find((race) => race && race.name === "zebras" && !race.unlocked) : null;
    if (lockedZebras && (hiddenRaceDiscoverableNow(lockedZebras, resources) || craftByName("ship"))) {
      const inputs = [acquisitionPathFor(resources, "ship", 1, { ...context, refillCycles: false }, branchSeen)];
      for (const price of explorerPrices()) {
        if (!price || !price.name || !(price.val > 0)) continue;
        inputs.push(acquisitionPathFor(resources, price.name, price.val, { ...context, refillCycles: false }, branchSeen));
      }
      if (inputs.every((input) => input.reachable)) {
        const eta = inputs.reduce((worst, input) => Math.max(worst, input.eta), 0);
        routes.push(reachableAcquisitionPath(name, requested, "discovery", eta, {
          inputs,
          race: lockedZebras,
          nextStep: { kind: "discovery", resource: name, race: lockedZebras },
        }));
      } else rejected.push(...inputs.flatMap((input) => input.blockers || []));
    }

    for (const race of unlockedRaces()) {
      const sells = [...((race && race.sells) || [])];
      if (race && race.name === "zebras") {
        const stats = zebraTitaniumStats(resources);
        sells.push({ name: "titanium", value: stats.amount, chance: stats.chance, width: 0, zebraTitanium: true });
      }
      for (const sell of sells) {
        if (!sell || sell.name !== name || !validRaceSell(race, sell)) continue;
        const expectedYield = sell.zebraTitanium ? zebraTitaniumStats(resources).expected : expectedTradeYield(race, sell);
        if (!(expectedYield > 0)) continue;
        const trades = Math.max(1, Math.ceil(deficit / expectedYield));
        const inputs = [];
        let eta = 0;
        let reachable = true;
        for (const price of tradePricesForRace(race)) {
          if (!price || !price.name || !(price.val > 0)) continue;
          const input = acquisitionPathFor(resources, price.name, price.val * trades, { ...context, refillCycles: true }, branchSeen);
          inputs.push(input);
          if (!input.reachable) {
            reachable = false;
            rejected.push(...(input.blockers || []));
          } else eta = Math.max(eta, input.eta);
        }
        if (reachable) {
          routes.push(reachableAcquisitionPath(name, requested, "trade", eta, {
            inputs,
            race,
            expectedYield,
            nextStep: { kind: "trade", resource: name, race, sell, trades, expectedYield },
          }));
        }
      }
    }

    for (const bridge of acquisitionBridgeCandidates()) {
      const profile = candidateEffectProfile(bridge.kind, bridge.meta);
      const gainPerTick = Number(profile.perTick && profile.perTick[name]) || 0;
      if (!(gainPerTick > 0)) continue;
      const inputs = [];
      let eta = deficit / Math.max(0.000001, gainPerTick * ticksPerSecond());
      let reachable = true;
      const owned = Math.max(0, Number(bridge.meta.on) || Number(bridge.meta.val) || 0);
      const bridgePrices = owned > 0 ? [] : pricesFor(bridge.kind, bridge.meta).filter((p) => p && p.name && p.val > 0);
      for (const price of bridgePrices) {
        const input = acquisitionPathFor(resources, price.name, price.val, { ...context, refillCycles: false }, branchSeen);
        inputs.push(input);
        if (!input.reachable) {
          reachable = false;
          rejected.push(...(input.blockers || []));
        } else eta = Math.max(eta, input.eta);
      }
      if (reachable) {
        routes.push(reachableAcquisitionPath(name, requested, "producer", eta, {
          inputs,
          nextStep: { kind: "producer", candidateKind: bridge.kind, meta: bridge.meta, resource: name },
        }));
      }
    }

    if (!routes.length) {
      return blockedAcquisitionPath(resources, name, requested, [
        `no acquisition path for ${resTitle(resources, name)}`,
        ...[...new Set(rejected)].slice(0, 3),
      ]);
    }
    return routes.sort((a, b) => acquisitionRoutePriority(a) - acquisitionRoutePriority(b) || a.eta - b.eta)[0];
  };

  const acquisitionRoutesForTarget = (target, resources) => {
    if (!target || target.affordable) return [];
    return pricesFor(target.kind, target.meta)
      .filter((cost) => cost && cost.name && isFinite(cost.val) && cost.val > resValueOf(resources, cost.name))
      .map((cost) => ({ cost, route: acquisitionPathFor(resources, cost.name, cost.val, { finalPurchase: true }) }));
  };

  // A selected acquisition root can be a craft, producer, or storage bridge
  // whose prerequisite is itself traded. Walk prerequisites before the root so
  // the first returned trade is the one executable now (for example, trade
  // Zebras for titanium before attempting the Dragon trade that spends it).
  const actionableTradeRoutesIn = (route, seen = new Set()) => {
    if (!route || !route.reachable || seen.has(route)) return [];
    seen.add(route);
    const nested = [];
    for (const input of route.inputs || []) nested.push(...actionableTradeRoutesIn(input, seen));
    if (nested.length) return nested;
    const step = route.nextStep;
    return step && step.kind === "trade" && step.race ? [route] : [];
  };

  const actionableTradeRouteFor = (route) => actionableTradeRoutesIn(route)
    .sort((a, b) => b.eta - a.eta)[0] || null;

  const activeAcquisitionRoute = (target, resources) => acquisitionRoutesForTarget(target, resources)
    .map(({ route }) => actionableTradeRouteFor(route))
    .filter(Boolean)
    .sort((a, b) => b.eta - a.eta)[0] || null;

  const isZebraTitaniumTradeRoute = (route) => !!(route && route.nextStep &&
    route.nextStep.kind === "trade" && route.nextStep.resource === "titanium" &&
    route.nextStep.race && route.nextStep.race.name === "zebras");

  const scoreAcquisitionRouteInputs = (needs, resources, route, weight, seen = new Set()) => {
    if (!route || !route.reachable || seen.has(route)) return;
    seen.add(route);
    for (const input of route.inputs || []) {
      if (!input || !input.resource) continue;
      const required = Math.max(0, Number(input.amount) || 0);
      const have = resValueOf(resources, input.resource);
      const shortage = Math.max(0, required - have);
      if (shortage > 0) {
        const shortageRatio = shortage / Math.max(required, 1);
        scoreNeed(needs, input.resource, weight * (0.5 + shortageRatio));
      }
      if (input.inputs && input.inputs.length) {
        scoreAcquisitionRouteInputs(needs, resources, input, weight * 0.75, seen);
      }
    }
  };

  const targetTradeChainDemand = (target, resources) => {
    const demand = {};
    if (!target) return demand;
    for (const cost of pricesFor(target.kind, target.meta)) {
      if (!cost || !cost.name || !isFinite(cost.val) || cost.val <= 0) continue;
      const have = resourceValue(resources, cost.name);
      const missing = Math.max(0, cost.val - have);
      if (missing <= 0 && !craftByName(cost.name)) continue;
      demand[cost.name] = Math.max(demand[cost.name] || 0, Math.max(1, missing || cost.val));
      if (craftByName(cost.name)) {
        for (const name of craftChainOutputsFor(cost.name)) demand[name] = Math.max(demand[name] || 0, 1);
        const raw = rawPathRequirements(cost.name, Math.max(1, missing || cost.val));
        for (const [name, amount] of Object.entries(raw)) demand[name] = Math.max(demand[name] || 0, amount || 1);
      }
    }
    return demand;
  };

  const targetTradeYieldValue = (demand, sellName, amount) => {
    if (!amount || amount <= 0) return 0;
    if ((demand.compedium || demand.compendium) && (sellName === "compedium" || sellName === "compendium")) return amount;
    if ((demand.compedium || demand.compendium) && sellName === "manuscript") return amount / 50;
    if ((demand.compedium || demand.compendium || demand.manuscript) && sellName === "parchment") return amount / (50 * 25);
    if ((demand.compedium || demand.compendium || demand.manuscript || demand.parchment) && sellName === "furs") return amount / (50 * 25 * 175);
    if (!demand[sellName]) return 0;
    return amount / Math.max(1, demand[sellName]);
  };


  const targetTradeChainLabel = (target, resources) => {
    const demand = targetTradeChainDemand(target, resources);
    if (demand.compedium || demand.compendium || demand.manuscript || demand.parchment) return "Compendium chain";
    const priority = ["wood", "scaffold", "ship", "plate", "slab", "steel", "beam"];
    const hit = priority.find((name) => demand[name] > 0);
    return hit ? `${resTitle(resources, hit)}/${labelOf(target.meta)} chain` : "material chain";
  };

  // ─── v2.4 cost-benefit: trade-vs-craft pathway timing ──────────────────────
  // Per-second production rate.  productionFor() already folds in the live
  // bar delta and conversion-aware getResourcePerTick, so this is a single
  // accurate clock-rate for each resource.  Catpower aliases to manpower.
  const productionRateFor = (name) => productionFor(name);

  // How long until we passively accumulate `amount` of `name`, starting from
  // the current stock — used for both "how long until enough catpower to fund
  // a trade batch" and "how long until enough furs to craft a manuscript".
  // Returns Infinity when there is no positive production (the path is
  // structurally blocked, not just slow).
  const secondsToAccumulate = (name, amount, resources) => {
    const have = resourceValue(resources, name);
    const deficit = Math.max(0, amount - have);
    if (deficit <= 0) return 0;
    const rate = productionRateFor(name);
    if (!isFinite(rate) || rate <= 0) return Number.POSITIVE_INFINITY;
    return deficit / rate;
  };

  // Wall-clock seconds to assemble `amount` of `name` by CRAFTING — i.e. by
  // producing every leaf raw input the recipe chain ultimately needs and
  // letting whichever is slowest gate the rest.  Direct (uncrafted) demand
  // is its own cost.
  const craftPathSecondsFor = (name, amount, resources) => {
    if (amount <= 0) return 0;
    if (!craftByName(name)) return secondsToAccumulate(name, amount, resources);
    const raw = rawPathRequirements(name, amount);
    let worst = 0;
    for (const [rawName, rawAmount] of Object.entries(raw)) {
      const sec = secondsToAccumulate(rawName, rawAmount, resources);
      if (sec > worst) worst = sec;
    }
    return worst;
  };

  // Wall-clock seconds to deliver `amount` of `sellName` from `race` by
  // TRADING — i.e. by funding the trade-price batch (catpower + gold + any
  // goods the race buys) often enough to expect `amount` of the sale.
  // Chance, season and embassy bonuses already feed into tradeSellExpected.
  const tradePathSecondsFor = (race, sellName, amount, resources) => {
    if (!race || amount <= 0) return Number.POSITIVE_INFINITY;
    const sell = (race.sells || []).find((s) => s && s.name === sellName);
    if (!sell) return Number.POSITIVE_INFINITY;
    const yieldPerTrade = tradeSellExpected(sell, race);
    if (yieldPerTrade <= 0) return Number.POSITIVE_INFINITY;
    const tradesNeeded = amount / yieldPerTrade;
    const prices = tradePricesForRace(race);
    if (!prices.length) return Number.POSITIVE_INFINITY;
    let worst = 0;
    for (const price of prices) {
      if (!price || !isFinite(price.val) || price.val <= 0) continue;
      const total = price.val * tradesNeeded;
      const sec = secondsToAccumulate(price.name, total, resources);
      if (sec > worst) worst = sec;
    }
    return worst;
  };

  // For each demand resource in the chain, pick the FASTER of crafting it
  // directly (or producing it from leaf inputs) and trading for it.  The
  // result drives both the scoring boost in targetTradeScore and the
  // diplomacy panel text so the player can SEE the comparison.
  const analyzeTargetDemandPaths = (target, resources) => {
    const demand = targetTradeChainDemand(target, resources);
    const analysis = [];
    if (!target || !Object.keys(demand).length) return analysis;
    const races = unlockedRaces();
    for (const [name, amount] of Object.entries(demand)) {
      if (!name || !(amount > 0)) continue;
      // Only score demand resources that are an output of some race's `sells`
      // OR are directly craftable; otherwise the comparison is meaningless.
      const sellerOptions = races
        .map((race) => ({ race, seconds: tradePathSecondsFor(race, name, amount, resources) }))
        .filter((opt) => isFinite(opt.seconds))
        .sort((a, b) => a.seconds - b.seconds);
      const craftSeconds = craftPathSecondsFor(name, amount, resources);
      const bestTrade = sellerOptions[0] || null;
      const tradeSeconds = bestTrade ? bestTrade.seconds : Number.POSITIVE_INFINITY;
      let winner = "craft";
      if (isFinite(tradeSeconds) && tradeSeconds * 1.1 < craftSeconds) winner = "trade";
      else if (!isFinite(craftSeconds) && isFinite(tradeSeconds)) winner = "trade";
      analysis.push({ name, amount, craftSeconds, tradeSeconds, bestTrade, winner });
    }
    return analysis;
  };

  // Cache the pathway analysis per tick so the panel text, the scoring boost
  // and the gate decision all read the same numbers (and the work runs once).
  const targetPathwayAnalysis = (target, resources) => {
    if (!target || !tickCache) return analyzeTargetDemandPaths(target, resources);
    if (!tickCache.pathways) tickCache.pathways = new Map();
    const key = targetId(target) || "__no_target__";
    if (!tickCache.pathways.has(key)) tickCache.pathways.set(key, analyzeTargetDemandPaths(target, resources));
    return tickCache.pathways.get(key);
  };

  // Trade-vs-craft speed ratio for a specific race: weighted average of the
  // demand resources THIS race covers.  >1 means trading this race is faster
  // than crafting; <1 means crafting wins.  Used as a multiplier on the
  // chain-demand value so the SCORE actually reflects "how much faster?".
  const tradeSpeedMultiplierFor = (race, target, resources) => {
    const analysis = targetPathwayAnalysis(target, resources);
    if (!analysis.length || !race || !race.sells) return 1;
    const sellNames = new Set(race.sells.map((s) => s && s.name).filter(Boolean));
    const relevant = analysis.filter((row) => sellNames.has(row.name));
    if (!relevant.length) return 1;
    let cumulative = 0;
    let weights = 0;
    for (const row of relevant) {
      const tradeSecs = tradePathSecondsFor(race, row.name, row.amount, resources);
      if (!isFinite(tradeSecs) || tradeSecs <= 0) continue;
      const craftSecs = row.craftSeconds;
      // Speed ratio: how much faster trade is than craft (clamped 0.25–4).
      const ratio = isFinite(craftSecs) && craftSecs > 0 ? craftSecs / tradeSecs : 1.5;
      cumulative += Math.max(0.25, Math.min(4, ratio));
      weights += 1;
    }
    return weights > 0 ? cumulative / weights : 1;
  };

  const targetTradeScore = (race, target, resources, reserved) => {
    const demand = targetTradeChainDemand(target, resources);
    if (!Object.keys(demand).length) return null;
    const prices = tradePricesForRace(race);
    const ledger = buildTargetLedger(target, resources);
    if (!prices.length || targetLockViolationForPrices(prices, ledger, resources)) return null;
    const affordable = affordableTradeCount(prices, {}, resources);
    if (affordable <= 0) return null;
    let value = 0;
    const goods = [];
    for (const sell of race.sells || []) {
      const expected = tradeSellExpected(sell, race);
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
    // Multiply by the trade-vs-craft speed ratio so the planner picks the
    // partner whose path is ACTUALLY faster, not just the one with the most
    // chain coverage on paper.  When crafting is faster the multiplier is
    // <1 and the trade slides down the ranking (or below the 0.0005 floor).
    const speedMultiplier = tradeSpeedMultiplierFor(race, target, resources);
    return { race, prices, affordable, goods, score: (value - scarcePenalty) * speedMultiplier, value, speedMultiplier };
  };

  const maybeTradeForTargetChain = (resources, ledger, goalKey, target) => {
    if (shouldSaveForExplorers(resources, goalKey)) return false;
    // Recompute from the live board immediately before funding and execution;
    // earlier preparation may have changed prices, stocks, or the nested step.
    const liveResources = resourceMap();
    const route = activeAcquisitionRoute(target, liveResources);
    if (!route || !route.nextStep) return false;
    const liveLedger = buildReservationLedger(target, liveResources);
    const race = route.nextStep.race;
    const prices = tradePricesForRace(race);
    const batch = boundedTradeBatch(route, liveLedger, liveResources);
    if (!prices.length || batch <= 0 || !pricesRespectReservations(prices, liveLedger.reserved || {}, liveResources)) return false;
    const diplomacy = window.gamePage && window.gamePage.diplomacy;
    const nativeBatch = diplomacy && typeof diplomacy.tradeMultiple === "function" ? batch : 1;
    const measured = withActionResourceDeltas(() => tradeWithRace(race, nativeBatch), tradeDeltaNamesForRace(race, prices));
    if (!measured.result) return false;
    const raceName = race.title || race.name || "civilization";
    const odds = isZebraTitaniumTradeRoute(route) ? ` · ${zebraTitaniumOddsText(liveResources, goalKey)}` : "";
    diplomacyPlanText = `Targeted trade: ${raceName} for ${labelOf(target.meta)} ${resTitle(liveResources, route.resource)} route${odds}`;
    pushLog(`🤝 ${raceName} trade${nativeBatch > 1 ? ` ×${nativeBatch}` : ""}: ${measured.suffix}; reason selected ${resTitle(liveResources, route.resource)} route for ${labelOf(target.meta)}`);
    return true;
  };

  const safeOverflowTradeBatch = (race, ledger, resources) => {
    const prices = tradePricesForRace(race);
    let batch = Math.min(MAX_TRADE_BATCH, affordableTradeCount(prices, (ledger && ledger.reserved) || {}, resources));
    for (const sell of (race && race.sells) || []) {
      if (!validRaceSell(race, sell)) continue;
      const output = getRes(resources, sell.name);
      const expected = expectedTradeYield(race, sell);
      if (!output || !(output.maxValue > 0) || !(expected > 0)) continue;
      const headroom = Math.max(0, output.maxValue - output.value);
      batch = Math.min(batch, headroom > 0 ? Math.max(0, Math.floor(headroom / expected)) : 0);
    }
    return Math.max(0, batch);
  };

  const maybeTradeSurplus = (resources, ledger, goalKey) => {
    const game = window.gamePage;
    const diplomacy = game && game.diplomacy;
    if (!diplomacy || shouldSaveForExplorers(resources, goalKey)) return false;
    const catpower = getRes(resources, "manpower");
    if (!catpower || !(catpower.maxValue > 0) || catpower.value / catpower.maxValue <= 0.9) return false;
    let best = null;
    let bestScore = 0;
    let bestBatch = 0;
    for (const race of unlockedRaces().filter((item) => item && !item.collapsed)) {
      const prices = tradePricesForRace(race);
      if (!prices.length || !pricesRespectReservations(prices, ledger.reserved || {}, resources)) continue;
      const batch = safeOverflowTradeBatch(race, ledger, resources);
      const score = tradeWantScore(race, resources);
      if (batch > 0 && score > bestScore) {
        best = race;
        bestScore = score;
        bestBatch = batch;
      }
    }
    if (!best) return false;
    const nativeBatch = typeof diplomacy.tradeMultiple === "function" ? bestBatch : 1;
    const prices = tradePricesForRace(best);
    const measured = withActionResourceDeltas(
      () => tradeWithRace(best, nativeBatch),
      tradeDeltaNamesForRace(best, prices),
    );
    if (!measured.result) return false;
    diplomacyPlanText = `Diplomacy: surplus trade with ${best.title || best.name || "partner"}`;
    pushLog(`🤝 ${best.title || best.name || "partner"} trade: ${measured.suffix}; reason surplus catpower near cap`);
    return true;
  };

  const maybeBuildEmbassy = (resources, reserved, route = null) => {
    if (!writingResearched()) return false;
    const relevantRace = route && route.nextStep && route.nextStep.race;
    const races = unlockedRaces()
      .filter((race) => race.embassyPrices && race.embassyPrices.length)
      .map((race) => ({ race, prices: embassyPricesForRace(race) }))
      .filter((item) => item.prices.length && canPayPrices(item.prices) && pricesRespectReservations(item.prices, reserved, resources))
      .sort((a, b) => Number(b.race === relevantRace) - Number(a.race === relevantRace) || (a.race.embassyLevel || 0) - (b.race.embassyLevel || 0));
    const next = races[0];
    if (!next) return false;
    const beforeLevel = next.race.embassyLevel || 0;
    const measured = withActionResourceDeltas(() => buyEmbassyForRace(next.race), new Set(next.prices.map((price) => price.name)));
    if (measured.result === null) {
      diplomacyPlanText = "Diplomacy: embassy controller unavailable; no action taken";
      return null;
    }
    if (measured.result) {
      const built = (next.race.embassyLevel || 0) > beforeLevel;
      diplomacyPlanText = built
        ? `Diplomacy: built embassy with ${next.race.title || next.race.name} (level ${next.race.embassyLevel || 1})`
        : `Diplomacy: embassy action with ${next.race.title || next.race.name} changed resources; level unchanged`;
      pushLog(`🏛 ${diplomacyPlanText}${measured.spent ? `; ${measured.spent}` : ""}`);
      return true;
    }
    return false;
  };

  // The Zebra Relations policies (culture-cost, mutually exclusive) change how
  // the Zebras deal with us; Appeasement is the trade-friendly side — better
  // relations and trade outcomes.  The generic automation now adopts exclusive
  // policies on its own (and policyScore prefers this side, so the two paths
  // can never adopt opposite sides), but when titanium is gated behind Zebra
  // trades this policy IS the bottleneck lever — keep the direct fast path so
  // it is adopted even while the generic step is throttled or lock-gated.
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
      const ledger = buildReservationLedger(target, resources);
      const reserved = ledger.reserved;
      refreshStickyTargetChainReserve(target, resources);

      // One owner, one mutation, one cooldown: reveal/preparation first, then
      // the selected acquisition route, safe overflow, and only then embassies.
      if (craftDiplomacyPrerequisites(resources, goalKey) ||
          maybeAdoptZebraTradePolicy(resources, reserved, goalKey)) {
        lastDiplomacyAction = Date.now();
        return;
      }
      const explorerResult = maybeSendExplorers(resources, reserved);
      if (explorerResult !== false) {
        if (explorerResult === true) lastDiplomacyAction = Date.now();
        return;
      }
      const route = activeAcquisitionRoute(target, resources);
      if (maybeTradeForTargetChain(resources, ledger, goalKey, target) ||
          maybeTradeSurplus(resources, ledger, goalKey)) {
        lastDiplomacyAction = Date.now();
        return;
      }
      const embassyResult = maybeBuildEmbassy(resources, reserved, route);
      if (embassyResult !== false) {
        if (embassyResult === true) lastDiplomacyAction = Date.now();
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

  // Bigger log buffer + bigger visible window so a debugging session can
  // scroll back through several minutes of decisions (v2.3.0): the player
  // can copy/paste the panel log to debug "why did the bot just do X?".
  const LOG_DISPLAY_LIMIT = 80;
  const LOG_STORAGE_LIMIT = 300;

  const renderLog = () => {
    if (logBox) logBox.textContent = actionLog.slice(0, LOG_DISPLAY_LIMIT).join("\n") || "(waiting…)";
  };

  const pushLog = (text) => {
    const time = new Date().toLocaleTimeString();
    actionLog.unshift(`${time}  ${text}`);
    actionLog = actionLog.slice(0, LOG_STORAGE_LIMIT);
    try {
      localStorage.setItem(LOG_KEY, JSON.stringify(actionLog));
    } catch (error) {
      /* ignore */
    }
    renderLog();
  };

  // --- diagnostics census helpers --------------------------------------------
  // The player asked the diagnostics dump to also show, per building, how many
  // are built and what the NEXT one costs, plus which workshop upgrades are still
  // locked and what gates them.  Everything reads LIVE (active-stage prices via
  // pricesFor / evaluate), so the numbers match exactly what the game shows.
  const formatPriceList = (resources, kind, meta) => {
    const prices = pricesFor(kind, meta).filter((p) => p && p.name && isFinite(p.val) && p.val > 0);
    if (!prices.length) return "free";
    return prices.map((p) => `${fmt(p.val)} ${resTitle(resources, p.name)}`).join(", ");
  };

  const buildingsReportLines = (resources) => {
    const lines = [];
    for (const meta of buildingMetas()) {
      if (!meta || !meta.name || isDeniedKey(meta.name)) continue; // never advertise resets etc.
      const live = liveMetaView(meta) || meta;
      if (live.unlocked === false) continue; // unlocked (visible) buildings only
      const val = live.val || 0;
      const on = live.on;
      const onText = on != null && on !== val ? ` (${fmt(on)} on)` : "";
      const ev = evaluate("build", meta, resources);
      const status = ev.affordable ? "buildable now" : (ev.missing ? `need ${ev.missing}` : "—");
      lines.push(`  ${labelOf(meta)} ×${fmt(val)}${onText} · next ${formatPriceList(resources, "build", meta)} · ${status}`);
    }
    return lines;
  };

  // Which still-unsatisfied tech / upgrade / building grants a locked workshop
  // upgrade (walks every unlocks.upgrades list and prefers an un-done gate so the
  // report names the actual blocker, not an already-finished one).
  const upgradeUnlockGate = (upgradeName) => {
    try {
      const game = window.gamePage;
      const sources = [];
      const collect = (list, doneOf, kind) => {
        for (const item of list || []) {
          const ups = (item && item.unlocks && item.unlocks.upgrades) || [];
          if (ups.includes(upgradeName)) sources.push({ label: labelOf(item), done: doneOf(item), kind });
        }
      };
      collect((game.science && game.science.techs) || [], (t) => !!t.researched, "tech");
      collect((game.workshop && game.workshop.upgrades) || [], (u) => !!u.researched, "upgrade");
      collect(buildingMetas(), (b) => (b.val || 0) > 0, "building");
      return sources.find((s) => !s.done) || sources[0] || null;
    } catch (error) {
      return null;
    }
  };

  const workshopReportLines = (resources) => {
    const lines = [];
    const upgrades = (window.gamePage && window.gamePage.workshop && window.gamePage.workshop.upgrades) || [];
    for (const u of upgrades) {
      if (!u || !u.name || u.researched) continue; // pending (unresearched) upgrades only
      if (u.unlocked === false) {
        const gate = upgradeUnlockGate(u.name);
        lines.push(`  ${labelOf(u)} · LOCKED${gate ? ` — needs ${gate.label}` : ""} · costs ${formatPriceList(resources, "upgrade", u)}`);
      } else {
        const ev = evaluate("upgrade", u, resources);
        lines.push(`  ${labelOf(u)} · ${ev.affordable ? "READY now" : `need ${ev.missing || "—"}`} · costs ${formatPriceList(resources, "upgrade", u)}`);
      }
    }
    return lines;
  };

  // Planet buildings gate on `requiredTech` (tech names) directly, unlike
  // workshop upgrades which are gated indirectly via `unlocks.upgrades` lists.
  const spaceUnlockGate = (meta) => {
    if (!meta || !Array.isArray(meta.requiredTech) || !meta.requiredTech.length) return null;
    const names = meta.requiredTech
      .map((techName) => {
        const tech = techByName(techName);
        return tech && !tech.researched ? labelOf(tech) : null;
      })
      .filter(Boolean);
    return names.length ? names.join(", ") : null;
  };

  // Space missions (space.programs) AND planet buildings (space.planets[].buildings,
  // e.g. Cath's Satellite) — separate from the WORKSHOP section above, which only
  // covers workshop upgrades like Solar Satellites / Satellite Navigation / Satellite
  // Radio and must never be confused with an actual buildable space structure.
  const spaceReportLines = (resources) => {
    const lines = [];
    for (const meta of spaceMetas()) {
      if (!meta || !meta.name || isDeniedKey(meta.name)) continue;
      if (meta.noStackable && (meta.on || meta.val || 0) >= 1) continue; // one-time mission already complete
      if (meta.unlocked === false) {
        const gate = spaceUnlockGate(meta);
        lines.push(`  ${labelOf(meta)} · LOCKED${gate ? ` — needs ${gate}` : ""} · costs ${formatPriceList(resources, "space", meta)}`);
        continue;
      }
      const val = meta.val || 0;
      const ev = evaluate("space", meta, resources);
      const status = ev.affordable ? "buildable now" : (ev.missing ? `need ${ev.missing}` : "—");
      lines.push(`  ${labelOf(meta)} ×${fmt(val)} · next ${formatPriceList(resources, "space", meta)} · ${status}`);
    }
    return lines;
  };

  // Live job census so the report explains "why are N kittens on Priest?" — the
  // counts plus the Jobs need line (and any jobSuppressText) tell the whole story.
  const jobsReportLine = () => {
    try {
      const village = window.gamePage.village;
      const parts = (village.jobs || [])
        .filter((j) => j && j.unlocked !== false && (j.value || 0) > 0)
        .map((j) => `${j.title || j.name} ${fmt(j.value || 0)}`);
      const free = village.getFreeKittens ? Math.max(0, Math.floor(village.getFreeKittens())) : 0;
      const leader = village.leader ? ` · leader ${village.leader.name || "?"}` : "";
      return `${parts.join(" · ") || "(none assigned)"}${free > 0 ? ` · free ${free}` : ""}${leader}`;
    } catch (error) {
      return "(job census unavailable)";
    }
  };

  // One-shot diagnostics dump for debugging "why did the bot just do X?".  The
  // panel shows only a few live lines and the game page itself can't be fully
  // copied, so this assembles the WHOLE decision picture — plan, power (including
  // the latent demand of consumers paused to protect Wt), per-converter
  // processing state, every subsystem line, a full resource snapshot, the ranked
  // candidate list and the recent action log — into one clipboard-friendly block.
  // Exposed on the panel Copy button and as window.__kghDebug.report().
  const buildDiagnosticsReport = () => {
    const lines = [];
    const push = (text) => lines.push(text);
    try {
      const goal = getGoal();
      resetTickCache();
      const resources = resourceMap();
      getTargetCached(resources, goal);
      const cal = (window.gamePage && window.gamePage.calendar) || {};
      const seasonTitle = (cal.seasons && cal.seasons[cal.season] && cal.seasons[cal.season].title) || cal.season;
      const kittens = getRes(resources, "kittens");
      push(`🐱 Kittens Helper v${HELPER_VERSION} — diagnostics @ ${new Date().toLocaleString()}${tickSpeed > 1 ? ` · speed ${tickSpeed}×` : ""}`);
      if (isFinite(cal.year)) push(`Game: Year ${cal.year} — ${seasonTitle}, day ${Math.floor(cal.day || 0)} · ${kittens ? fmt(kittens.value) : "?"} kittens`);
      push("");
      push("— PLAN —");
      push(`Bottleneck: ${getBottleneck(resources)}`);
      push(`Next science: ${getNextScience(resources, goal)}`);
      push(getPlanLine(resources, goal).replace(/\n/g, " · "));
      push(`Now: ${getNowAction(resources, goal)}`);
      const details = getAutomationDetailsLine(resources, goal);
      if (details) push(details);
      push("");
      const power = powerStatus();
      const eff = effectivePowerStatus();
      push("— POWER —");
      push(`prod ${fmt(power.prod)} · cons ${fmt(power.cons)} · delta ${fmt(power.delta)} Wt · winter ${fmt(power.winterDelta)} Wt`);
      push(`latent paused-for-power demand ${fmt(eff.latent)} Wt → effective delta ${fmt(eff.delta)} Wt (winter ${fmt(eff.winterDelta)} Wt)`);
      push(`computed deficit ${fmt(Math.max(0, -eff.delta, -eff.winterDelta))} Wt · selected/skipped: ${(lastPowerRecoveryDiagnostic && lastPowerRecoveryDiagnostic.action) || "not evaluated"}`);
      push(`converter fuel: ${(lastConverterFuelDiagnostic && lastConverterFuelDiagnostic.action) || "not evaluated"}`);
      push("");
      push("— PROCESSING —");
      push(processingPlanText);
      for (const meta of converterBuildings()) {
        const profile = processingProfileFor(meta);
        const net = (profile.energyProduction || 0) - (profile.energyConsumption || 0);
        const memo = pausedProcessors[meta.name];
        push(`  ${labelOf(meta)}: on ${meta.on || 0}/${meta.val || 0} · net ${fmt(net)} Wt/ea${memo ? ` · paused (${memo.reason})` : ""}`);
      }
      push("");
      push("— SUBSYSTEMS —");
      push(`Jobs: ${jobPlanText}${jobSuppressText ? ` · ${jobSuppressText}` : ""}`);
      push(`  census: ${jobsReportLine()}`);
      push(`Craft: ${craftPlanText} · ${overflowPlanText} · ${parallelPlanText}`);
      push(`Buy: ${buyPlanText}`);
      push(`Queue: ${queuePlanText}`);
      push(stagePlanText);
      push(`Leader: ${leaderPlanText}`);
      push(`Reserve: ${reservePlanText}`);
      push(`Religion: ${religionPlanText}`);
      push(`Unicorns: ${unicornPlanText}`);
      try {
        for (const line of (getUnicornPlanCached(resources).summary || []).slice(0, 4)) push(`  ${line}`);
      } catch (error) {
        /* unicorn summary is optional */
      }
      push(`Festival: ${festivalPlanText}`);
      push(`Diplomacy: ${diplomacyPlanText}`);
      push("");
      push("— RESOURCES —");
      try {
        for (const r of ((window.gamePage && window.gamePage.resPool && window.gamePage.resPool.resources) || [])) {
          if (!r || r.unlocked === false || (!(r.value > 0) && !(r.maxValue > 0))) continue;
          const rate = productionFor(r.name);
          const cap = r.maxValue > 0 ? `/${fmt(r.maxValue)}` : "";
          const rateText = isFinite(rate) && rate !== 0 ? ` ${rate > 0 ? "+" : ""}${fmt(rate)}/s` : "";
          push(`  ${r.title || r.name}: ${fmt(r.value)}${cap}${rateText}`);
        }
      } catch (error) {
        push("  (resource snapshot unavailable)");
      }
      push("");
      push("— BUILDINGS (count · next incremental cost) —");
      try {
        const lines2 = buildingsReportLines(resources);
        if (lines2.length) for (const line of lines2) push(line);
        else push("  (no buildings unlocked)");
      } catch (error) {
        push("  (building census unavailable)");
      }
      push("");
      push("— WORKSHOP (pending upgrades · lock/requirement) —");
      try {
        const lines3 = workshopReportLines(resources);
        if (lines3.length) for (const line of lines3) push(line);
        else push("  (all unlocked upgrades researched)");
      } catch (error) {
        push("  (workshop census unavailable)");
      }
      push("");
      push("— SPACE (missions · planet buildings · lock/requirement) —");
      try {
        const lines4 = spaceReportLines(resources);
        if (lines4.length) for (const line of lines4) push(line);
        else push("  (no space content reached yet)");
      } catch (error) {
        push("  (space census unavailable)");
      }
      push("");
      push("— TOP CANDIDATES —");
      try {
        const candidates = getCandidatesCached(resources, goal) || [];
        for (const candidate of candidates.slice(0, 8)) {
          push(`  ${labelOf(candidate.meta)} [${candidate.kind}] score ${fmt(candidate.score || 0)} ETA ${formatEta(waitSecondsForCandidate(candidate, resources))}${candidate.affordable ? " · ready" : ""}`);
        }
      } catch (error) {
        push("  (candidate list unavailable)");
      }
      push("");
      push(`— RECENT ACTIONS (${Math.min(actionLog.length, LOG_DISPLAY_LIMIT)}) —`);
      push(actionLog.slice(0, LOG_DISPLAY_LIMIT).join("\n") || "(none yet)");
    } catch (error) {
      push(`(diagnostics error: ${error && error.message})`);
    }
    return lines.join("\n");
  };

  // Recent-action logging is action-scoped, not tick-scoped: every automation
  // click/craft/trade/hunt takes a resource snapshot immediately before and
  // after that exact operation.  This prevents same-tick side effects (hunters,
  // embassies, overflow crafts, job changes, normal production) from being
  // merged into one misleading "trade" line.
  //
  // CRITICAL: the snapshot must capture NUMERIC values, not references.  The
  // live resourceMap() stores references to the game's `res` objects whose
  // `.value` mutates in place — so a before/after that both read `res.value`
  // would always be equal (delta == 0), and the log would always say
  // "no resource gain".  Snapping to a name→value Map fixes that.
  const resourceSnapshot = () => {
    const snap = new Map();
    try {
      const pool = window.gamePage && window.gamePage.resPool;
      if (pool && Array.isArray(pool.resources)) {
        for (const res of pool.resources) {
          if (res && res.name) snap.set(res.name, Number(res.value) || 0);
        }
      }
    } catch (error) {
      /* ignore */
    }
    return snap;
  };

  const snapValue = (snap, name) => {
    if (!snap) return 0;
    if (snap.has(name)) return snap.get(name) || 0;
    if (name === "catpower" && snap.has("manpower")) return snap.get("manpower") || 0;
    return 0;
  };

  const resourceDeltasBetween = (before, after, names = null) => {
    const wanted = names ? new Set([...names].filter(Boolean)) : null;
    const seen = new Set([...(before ? before.keys() : []), ...(after ? after.keys() : [])]);
    return [...seen]
      .filter((name) => !wanted || wanted.has(name))
      .map((name) => ({ name, delta: snapValue(after, name) - snapValue(before, name) }))
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
    const liveRes = resourceMap();
    const gained = formatResourceDeltaList(liveRes, deltas, 1);
    const spent = formatResourceDeltaList(liveRes, deltas, -1);
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
    const formatted = formatActionDeltas(before, after, names);
    markTelemetryDiscontinuity(formatted.deltas);
    return { result, before, after, ...formatted };
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
  const LEADER_CONTEXT_RECHECK_MS = 15000;
  const LEADER_SCORE_GAIN_THRESHOLD = 140;
  const PROMOTION_LEADER_GAIN_THRESHOLD = 260;
  let lastLeaderCheck = 0;
  let lastLeaderContext = "";
  let lastLeaderDecisionLog = 0;
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

  // researchPolicy marks rivals `blocked` when a side is adopted, but the flag
  // can lag (save-load order, mid-tick state). A policy whose rival is already
  // researched is closed regardless, so the helper can never try to adopt both
  // sides of an exclusive pair.
  const policyBlockedByRival = (meta) => policyMetas().some((other) =>
    other && other !== meta && other.researched === true && Array.isArray(other.blocks) && other.blocks.includes(meta && meta.name));

  const policyOpen = (meta) => isOpen(meta) && meta.blocked !== true && meta.disabled !== true && !policyBlockedByRival(meta);

  const isSocialismPolicy = (meta) => {
    const id = `${(meta && meta.name) || ""} ${labelOf(meta)}`.toLowerCase();
    return /\bsocialism\b/.test(id);
  };

  const isNoopPolicyCandidate = (candidate) => candidate && candidate.kind === "policy" && isSocialismPolicy(candidate.meta);

  // A policy with an empty `blocks` list forecloses nothing — buying it can
  // never lock you out of another choice, so it's bought on sight. Exclusive
  // policies (liberty vs tradition, monarchy vs republic …) are auto-adopted
  // too (v2.13.0): the helper picks the ranked best side of each group itself
  // instead of holding the choice for a manual click.
  const policyIsExclusive = (meta) => Array.isArray(meta && meta.blocks) && meta.blocks.length > 0;

  // The manual queue is explicit player intent: an exclusive side the player
  // queued must never be forced or foreclosed by the auto-pick, so any choice
  // that blocks a pending queued policy is ineligible for auto-adoption (the
  // queued side itself remains eligible — buying it just completes the queue).
  const queuedPolicyNames = () => {
    const names = new Set();
    try {
      for (const item of readQueue()) {
        const [kind, name] = String(item.id).split(":");
        if (kind === "policy" && name && !queueItemDone(item)) names.add(name);
      }
    } catch (error) {
      /* unreadable queue — nothing excluded */
    }
    return names;
  };

  const autoEligiblePolicyChoices = (resources, goalKey) => {
    const queued = queuedPolicyNames();
    return availablePolicyChoices(resources, goalKey).filter((choice) =>
      queued.has(choice.meta.name) || !(choice.meta.blocks || []).some((name) => queued.has(name)));
  };

  // The best affordable exclusive side that no OPEN rival strictly outranks.
  // A rival with a higher score is worth saving for instead of settling, but a
  // tied rival must not deadlock the group (empty-effect pairs tie at 0), so
  // the comparison is strict.
  const bestAdoptableExclusivePolicy = (resources, goalKey) => {
    const choices = autoEligiblePolicyChoices(resources, goalKey);
    for (const choice of choices) {
      if (!choice.affordable) continue;
      const rivalOutranks = choices.some((other) => other !== choice && other.score > choice.score &&
        ((other.meta.blocks || []).includes(choice.meta.name) || (choice.meta.blocks || []).includes(other.meta.name)));
      if (!rivalOutranks) return choice;
    }
    return null;
  };

  const autoPolicyChoice = (resources, goalKey) => {
    for (const meta of policyMetas()) {
      if (!policyOpen(meta) || policyIsExclusive(meta) || isSocialismPolicy(meta)) continue;
      const candidate = { kind: "policy", meta, ...evaluate("policy", meta, resources) };
      if (candidate.affordable) return candidate;
    }
    return bestAdoptableExclusivePolicy(resources, goalKey);
  };

  // The ranked exclusive pick while it is still UNAFFORDABLE — the policy the
  // helper is saving toward. Cached per tick: it anchors reservation ledgers,
  // which are rebuilt many times per pass.
  const getPendingPolicyCached = (resources, goalKey = getGoal()) => {
    if (tickCache.pendingPolicy === undefined) {
      const best = autoEligiblePolicyChoices(resources, goalKey)[0] || null;
      tickCache.pendingPolicy = best && !best.affordable ? best : null;
    }
    return tickCache.pendingPolicy;
  };

  // The chosen exclusive policy is culture-chain state while it saves: hold its
  // still-unaffordable price so festivals, embassies, cap relief and surplus
  // buys can't eat the bank the policy is accruing. A price above the live
  // storage cap is a storage problem, not a savings problem — nothing is
  // reserved for it (cap growth is owned by the normal scorer/storage layers).
  // The pick's own purchase never self-blocks: a pending (unaffordable) pick
  // holds the reserve, an affordable pick clears it and buys.
  const pendingPolicyReservationLedger = (resources, goalKey = getGoal()) => {
    const out = { reserved: {}, critical: new Set(), sources: {} };
    try {
      const best = getPendingPolicyCached(resources, goalKey);
      if (!best) return out;
      for (const cost of pricesFor("policy", best.meta)) {
        if (!cost || !cost.name || !isFinite(cost.val) || cost.val <= 0) continue;
        const cap = liveCapFor(resources, cost.name);
        if (cap > 0 && cost.val > cap) continue;
        out.reserved[cost.name] = Math.max(out.reserved[cost.name] || 0, cost.val);
        out.critical.add(cost.name);
        out.sources[cost.name] = [`policy ${labelOf(best.meta)}`];
      }
    } catch (error) {
      /* advisory reserve only */
    }
    return out;
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
    // The Zebra Relations pair parses to no economic effects, but Appeasement
    // is the trade-friendly side (better relations → titanium trades) and the
    // diplomacy layer's titanium lever (maybeAdoptZebraTradePolicy) adopts
    // exactly that side. Prefer it here so the generic auto-pick can never
    // foreclose the titanium path by settling the group toward Bellicosity.
    const id = `${(meta && meta.name) || ""} ${labelOf(meta)}`.toLowerCase();
    if (/zebra/.test(id) && /appeas/.test(id)) score += 6;
    return score;
  };

  // Only EXCLUSIVE policies appear here — ranked; the executor adopts the best.
  const availablePolicyChoices = (resources, goalKey) => policyMetas()
    .filter((meta) => policyOpen(meta) && policyIsExclusive(meta) && !isSocialismPolicy(meta))
    .map((meta) => ({ kind: "policy", meta, ...evaluate("policy", meta, resources), score: policyScore(meta, resources, goalKey) }))
    .sort((a, b) => b.score - a.score);

  const policyAdviceLine = (resources, goalKey) => {
    const choices = availablePolicyChoices(resources, goalKey);
    if (!choices.length) return "Policies: auto-adopt; nothing pending";
    const best = choices[0];
    const { pros, cons } = summarizeEffects(best.meta);
    const heldNote = !best.affordable && Object.keys(pendingPolicyReservationLedger(resources, goalKey).reserved).length ? "; bank reserved" : "";
    const state = best.affordable ? "adopting" : `saving — need ${best.missing || "resources"}${heldNote}`;
    return `Policies: exclusive auto-pick ${labelOf(best.meta)} over ${(best.meta.blocks || []).join(", ")} (${state}) · pros: ${(pros.length ? pros : ["unlocks future choices"]).join("; ")} · cons: ${(cons.length ? cons : ["none obvious"]).join("; ")}`;
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

  const leaderOpportunity = (goalKey, resources) => {
    const village = window.gamePage.village;
    if (!village || !village.sim || !Array.isArray(village.sim.kittens)) return null;
    const target = getTargetCached(resources, goalKey);
    const { needs } = resourceNeeds(goalKey, resources);
    const bestNeed = Object.entries(needs).filter(([, weight]) => weight > 0).sort((a, b) => b[1] - a[1])[0];
    const bottleneck = bestNeed ? bestNeed[0] : "balanced";
    const targetJob = bestNeed ? (RES_JOB[bestNeed[0]] || bestNeed[0]) : "engineer";
    const traits = desiredLeaderTraits(goalKey, resources);
    // When hunting paces the plan (the fur-chain flood makes manpower the top
    // need), a Manager multiplies every hunt's yield, while the static
    // research preference (Scientist) boosts scholars parked at 0 on a capped
    // science bank — promote the hunting trait to the front of the list.
    if (targetJob === "hunter") {
      const managerAt = traits.indexOf("manager");
      if (managerAt >= 0) traits.splice(managerAt, 1);
      traits.unshift("manager");
    }
    const kittens = village.sim.kittens.filter((kitten) => kitten && kitten.trait && kitten.trait.name && kitten.trait.name !== "none");
    const targetLabel = target ? labelOf(target.meta) : GOALS[goalKey].label;
    let best = null;
    for (const trait of traits) {
      for (const kitten of kittens) {
        if (!kitten.trait || kitten.trait.name !== trait) continue;
        const score = kittenScore(kitten, trait, targetJob);
        if (!best || score > best.score) best = { kitten, trait, score };
      }
      if (best && best.trait === trait) break;
    }
    const current = village.leader || null;
    const currentTrait = current && current.trait && current.trait.name;
    const currentScore = currentTrait ? kittenScore(current, currentTrait, targetJob) : 0;
    const gain = best ? best.score - currentScore : 0;
    const climbNeeds = targetClimbNeeds(target, resources);
    const stuckNearCap = !!Object.keys(climbNeeds).find((name) => resRatio(resources, name) > 0.88 && resValueOf(resources, name) < (reservedNeedsFor(target, resources)[name] || 0));
    const context = `${target ? `${target.kind}:${target.meta && target.meta.name || ""}` : `goal:${goalKey}`}:${bottleneck}`;
    return { target, targetLabel, needs, bottleneck, targetJob, traits, best, current, currentTrait, currentScore, gain, context, stuckNearCap };
  };

  const maybeLogLeaderDecision = (text, minMs = 60000) => {
    const now = Date.now();
    if (now - lastLeaderDecisionLog < minMs) return;
    lastLeaderDecisionLog = now;
    pushLog(text);
  };

  const maybeSelectLeader = (goalKey, resources) => {
    try {
      const now = Date.now();
      const village = window.gamePage.village;
      if (!village || typeof village.makeLeader !== "function") return false;
      const opportunity = leaderOpportunity(goalKey, resources);
      if (!opportunity || !opportunity.best) return false;
      const contextChanged = opportunity.context !== lastLeaderContext;
      const minDelay = contextChanged || opportunity.stuckNearCap ? LEADER_CONTEXT_RECHECK_MS : LEADER_RECHECK_MS;
      if (now - lastLeaderCheck < minDelay) return false;
      lastLeaderCheck = now;
      lastLeaderContext = opportunity.context;

      const reason = `${opportunity.targetLabel}; bottleneck ${opportunity.bottleneck}; job ${opportunity.targetJob}`;
      if (opportunity.best.kitten.isLeader) {
        leaderPlanText = `Leader: ${opportunity.best.kitten.trait.title || opportunity.best.trait} (${opportunity.best.kitten.name || "kitten"}) for ${reason}`;
        maybeLogLeaderDecision(`👑 leader kept: ${opportunity.best.kitten.name || "kitten"}/${opportunity.best.trait} already best for ${reason}`, 90000);
        return false;
      }
      if (opportunity.gain < LEADER_SCORE_GAIN_THRESHOLD && !opportunity.stuckNearCap) {
        const currentName = opportunity.current ? (opportunity.current.name || "current leader") : "none";
        leaderPlanText = `Leader: ${currentName}; skipped swap for ${reason} (gain ${fmt(opportunity.gain)})`;
        maybeLogLeaderDecision(`👑 leader skipped: best ${opportunity.best.kitten.name || "kitten"}/${opportunity.best.trait} gain ${fmt(opportunity.gain)} too small for ${reason}`, 90000);
        return false;
      }
      village.makeLeader(opportunity.best.kitten);
      if (typeof village.updateResourceProduction === "function") village.updateResourceProduction();
      leaderPlanText = `Leader: ${opportunity.best.kitten.trait.title || opportunity.best.trait} (${opportunity.best.kitten.name || "kitten"}) for ${reason}`;
      pushLog(`👑 leader set: ${opportunity.best.kitten.name || "kitten"}/${opportunity.best.trait}; ${reason}; score +${fmt(opportunity.gain)}`);
      return true;
    } catch (error) {
      return false;
    }
  };

  // Promotions are a pure win when gold would otherwise overflow at the cap:
  // they turn wasted income into permanently better workers. Gold below the
  // overflow band is left alone for trade and gold-priced builds.
  let nextPromoteAttempt = 0;

  const maybePromoteKittens = (resources, goalKey = getGoal()) => {
    try {
      const village = window.gamePage.village;
      const gold = getRes(resources, "gold");
      if (!village || !gold || !(gold.maxValue > 0)) return false;
      const now = Date.now();
      if (now < nextPromoteAttempt) return false;
      const target = getTargetCached(resources, goalKey);
      const reserved = target && !target.affordable ? reservedNeedsFor(target, resources) : {};
      const reserveGold = reserved.gold || 0;
      const overflowGold = gold.value >= gold.maxValue * 0.92;
      const opportunity = leaderOpportunity(goalKey, resources);
      const leaderGain = opportunity && opportunity.best ? opportunity.gain : 0;
      const reserveSafe = reserveGold <= 0 || gold.value - reserveGold > gold.maxValue * 0.08;
      if (!reserveSafe) {
        nextPromoteAttempt = now + 60000;
        maybeLogLeaderDecision(`🎖 promotion skipped: gold reserved for ${target ? labelOf(target.meta) : "active plan"}`, 90000);
        return false;
      }
      if (!overflowGold && leaderGain < PROMOTION_LEADER_GAIN_THRESHOLD) return false;
      const before = gold.value;
      try {
        if (typeof village.promoteKittens === "function") {
          village.promoteKittens();
        } else if (opportunity && opportunity.best && village.sim && typeof village.sim.promote === "function") {
          village.sim.promote(opportunity.best.kitten, (opportunity.best.kitten.rank || 0) + 1);
        } else if (village.leader && village.sim && typeof village.sim.promote === "function") {
          village.sim.promote(village.leader, (village.leader.rank || 0) + 1);
        }
      } catch (error) {
        /* promotion API mismatch — skip */
      }
      if (gold.value < before - 1) {
        nextPromoteAttempt = now + (overflowGold ? 30000 : 180000);
        const why = overflowGold ? "gold was capping" : `leader gain ${fmt(leaderGain)} for ${opportunity ? opportunity.targetLabel : "active plan"}`;
        pushLog(`🎖 promoted kittens (${why})`);
        return true;
      }
      nextPromoteAttempt = now + 300000; // nobody promotable (exp/gold) — back off
      maybeLogLeaderDecision(`🎖 promotion skipped: no promotable kitten for ${opportunity ? opportunity.targetLabel : "active plan"}`, 120000);
      return false;
    } catch (error) {
      return false;
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
  let unicornEl;
  let festivalEl;
  let diplomacyEl;
  let stageEl;
  let policyEl;
  let policySelectEl;
  let policyApplyEl;
  let nowEl;
  let noteEl;
  let queueSelectEl;
  let queueAddEl;
  let queueListEl;
  let rankingEl;
  let resetHeadEl;
  let resetCardEl;

  // Human label for a queued targetId ("build:magneto" → "🏗 Magneto"), resolved
  // against the live candidate when possible so it shows the game's own name.
  const KIND_QUEUE_ICON = { build: "🏗", research: "🔬", upgrade: "⚙", religion: "☀", space: "🚀", time: "⏳", policy: "📜" };
  const queueItemLabel = (id, candidates) => {
    const candidate = findCandidateById(candidates || [], id);
    const [kind, name] = id.split(":");
    const icon = KIND_QUEUE_ICON[kind] || "🎯";
    return `${icon} ${candidate ? labelOf(candidate.meta) : name}`;
  };

  // The queue picker is sorted by KIND then NAME — a fixed, browsable order.
  // Sorting by live score (the old behavior) reshuffled the list every tick,
  // which made the dropdown impossible to scan while it was open (v2.14.0).
  const QUEUE_KIND_ORDER = ["build", "research", "upgrade", "religion", "space", "time"];
  const QUEUE_KIND_GROUP = { build: "🏗 Buildings", research: "🔬 Research", upgrade: "⚙ Workshop", religion: "☀ Religion", space: "🚀 Space", time: "⏳ Time" };
  const queuePickerEntries = (resources, goalKey) => {
    const candidates = getCandidatesCached(resources, goalKey);
    const queued = new Set(readQueue().map((item) => item.id));
    return candidates
      .filter((c) => QUEUE_KIND_ORDER.includes(c.kind))
      .filter((c) => !queued.has(targetId(c)) && !targetComplete(c))
      .map((c) => ({ id: targetId(c), kind: c.kind, label: labelOf(c.meta), ready: !!c.affordable }))
      .sort((a, b) => (QUEUE_KIND_ORDER.indexOf(a.kind) - QUEUE_KIND_ORDER.indexOf(b.kind)) || a.label.localeCompare(b.label))
      .slice(0, 80);
  };

  // Populate the "add to queue" picker with the buyable/open candidates not
  // already queued, and render the current queue with reorder/remove controls.
  // Both halves are signature-gated: the DOM is only rebuilt when the option
  // SET actually changes, so an open dropdown never jumps under the cursor.
  const renderQueueControl = (resources, goalKey) => {
    if (!queueSelectEl || !queueListEl) return;
    const candidates = getCandidatesCached(resources, goalKey);
    const entries = queuePickerEntries(resources, goalKey);
    const pickerSig = entries.map((entry) => `${entry.id}${entry.ready ? "!" : ""}`).join("|");
    if (queueSelectEl._kghSig !== pickerSig) {
      queueSelectEl._kghSig = pickerSig;
      const current = queueSelectEl.value;
      queueSelectEl.innerHTML = "";
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = entries.length ? "Add to build queue…" : "Nothing new to queue";
      queueSelectEl.appendChild(placeholder);
      let group = null;
      let groupKind = null;
      for (const entry of entries) {
        if (entry.kind !== groupKind) {
          groupKind = entry.kind;
          group = document.createElement("optgroup");
          group.label = QUEUE_KIND_GROUP[entry.kind] || entry.kind;
          queueSelectEl.appendChild(group);
        }
        const option = document.createElement("option");
        option.value = entry.id;
        option.textContent = `${entry.label}${entry.ready ? " ✓ ready" : ""}`;
        (group || queueSelectEl).appendChild(option);
      }
      const options = queueSelectEl.options ? [...queueSelectEl.options] : [];
      if (options.some((o) => o.value === current)) queueSelectEl.value = current;
    }

    const queue = readQueue();
    const listSig = queue.map((item) => item.id).join("|");
    if (queueListEl._kghSig === listSig) return;
    queueListEl._kghSig = listSig;
    queueListEl.innerHTML = "";
    queue.forEach((item, index) => {
      const row = document.createElement("div");
      row.className = "kgh-row kgh-queue-item";
      const label = document.createElement("span");
      label.className = "kgh-queue-label";
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

  /* ------------------------- live target ranking ---------------------------- */

  // Top-of-the-board score ranking, refreshed every tick: the plan's top rivals
  // with their CURRENT scores, an up/down trend against the previous tick, and
  // readiness/ETA — so "why is X the plan?" is visible at a glance instead of
  // buried in the diagnostics report.
  const esc = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  let lastRankingScores = Object.create(null);

  const rankingRows = (resources, goalKey) => {
    const candidates = getCandidatesCached(resources, goalKey) || [];
    const target = getTargetCached(resources, goalKey);
    const targetKey = target ? targetId(target) : null;
    const top = candidates.slice(0, 5);
    if (targetKey && !top.some((c) => targetId(c) === targetKey)) {
      // The plan target always appears — even a synthetic layer target
      // (festival, stage change, bootstrap) that gatherCandidates never lists.
      top.push(findCandidateById(candidates, targetKey) || target);
    }
    const rows = top.map((c) => {
      const id = targetId(c);
      const score = c.score || 0;
      const prev = lastRankingScores[id];
      const delta = prev == null ? 0 : score - prev;
      return {
        id,
        rank: candidates.indexOf(c) + 1,
        label: labelOf(c.meta),
        icon: KIND_QUEUE_ICON[c.kind] || KIND_ICONS[c.kind] || "🎯",
        score,
        delta,
        trend: Math.abs(delta) < 0.05 ? "flat" : delta > 0 ? "up" : "down",
        ready: !!c.affordable,
        eta: waitSecondsForCandidate(c, resources),
        active: id === targetKey,
      };
    });
    const next = Object.create(null);
    for (const c of candidates.slice(0, 12)) next[targetId(c)] = c.score || 0;
    lastRankingScores = next;
    return rows;
  };

  const renderRankingControl = (resources, goalKey) => {
    if (!rankingEl) return;
    const rows = rankingRows(resources, goalKey);
    if (!rows.length) {
      rankingEl.innerHTML = '<div class="kgh-rk-empty">No open candidates yet</div>';
      return;
    }
    rankingEl.innerHTML = rows.map((row) => {
      const arrow = row.trend === "up" ? "▲" : row.trend === "down" ? "▼" : "·";
      const deltaTitle = row.trend === "flat" ? "score steady" : `score ${row.delta > 0 ? "+" : ""}${fmt(row.delta)} vs last tick`;
      const state = row.ready ? '<span class="kgh-rk-ready">ready</span>' : `<span class="kgh-rk-eta">${esc(formatEta(row.eta))}</span>`;
      return `<div class="kgh-rk${row.active ? " kgh-rk-on" : ""}" title="${esc(deltaTitle)}">` +
        `<span class="kgh-rk-n">${row.rank > 0 ? row.rank : "•"}</span>` +
        `<span class="kgh-rk-name">${esc(`${row.icon} ${row.label}`)}${row.active ? ' <span class="kgh-rk-plan">plan</span>' : ""}</span>` +
        `<span class="kgh-rk-tr kgh-rk-${row.trend}">${arrow}</span>` +
        `<span class="kgh-rk-score">${esc(fmt(row.score))}</span>` +
        state +
        "</div>";
    }).join("");
  };

  const renderPolicyControl = (resources, goalKey) => {
    if (!policyEl) return;
    const choices = availablePolicyChoices(resources, goalKey);
    policyEl.textContent = `📜 ${policyAdviceLine(resources, goalKey)}`;
    if (!policySelectEl || !policyApplyEl) return;
    // Same anti-flicker contract as the queue picker: only rebuild the options
    // when the choice SET changes, so an open dropdown never jumps.
    const policySig = choices.slice(0, 6).map((choice) => `${choice.meta.name}${choice.affordable ? "!" : ""}`).join("|");
    if (policySelectEl._kghSig === policySig) return;
    policySelectEl._kghSig = policySig;
    const current = policySelectEl.value;
    policySelectEl.innerHTML = "";
    if (!choices.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "No exclusive policy pending (all auto-adopt)";
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

  const renderOffPanel = () => {
    const OFF_MSG = "Autopilot OFF — toggle ON to resume";
    if (statusEl) statusEl.textContent = "Helper: autopilot OFF — no actions";
    if (planEl) planEl.textContent = `⏸ ${OFF_MSG}`;
    if (nowEl) nowEl.textContent = "🎯 Now: paused (autopilot off)";
    if (bottleneckEl) bottleneckEl.textContent = "";
    if (scienceEl) scienceEl.textContent = "";
    if (noteEl) noteEl.textContent = "";
    if (jobsEl) jobsEl.textContent = "";
    if (buyEl) buyEl.textContent = "";
    if (resetEl) resetEl.textContent = "";
    if (leaderEl) leaderEl.textContent = "";
    if (craftEl) craftEl.textContent = "";
    if (processingEl) processingEl.textContent = "";
    if (reserveStatusEl) reserveStatusEl.textContent = "";
    if (religionEl) religionEl.textContent = "";
    if (festivalEl) festivalEl.textContent = "";
    if (diplomacyEl) diplomacyEl.textContent = "";
    if (policyEl) policyEl.textContent = "";
    if (rankingEl) rankingEl.innerHTML = '<div class="kgh-rk-empty">Paused (autopilot off)</div>';
    if (resetHeadEl) resetHeadEl.textContent = "Paused (autopilot off)";
    if (goalEl) { goalEl.textContent = ""; goalEl.style.display = "none"; }
  };

  const tick = () => {
    try {
      plannerCycleId += 1;
      activePlanSnapshot = { cycleId: plannerCycleId, target: undefined };
      resetTickCache();
      // Autopilot OFF means the helper takes NO actions — no buys, crafts,
      // trades, hunts, job moves, leader changes, festivals, praise, policies
      // or queue execution.  The panel just shows the OFF state and the log
      // history so the player can decide when to flip it back on.  This is
      // the single gate: every spender is reached through this tick.
      if (!isAutopilotOn()) {
        renderOffPanel();
        return;
      }
      sampleResourceTelemetry();
      let resources = resourceMap();
      const goal = getGoal();
      computeResetAdvisor();
      watchNewUnlocks();
      maybeObserveStars();
      refineSurplusCatnip();
      optimizeProcessing(resources, goal);
      keepHealthyConvertersStable(resources);
      craftTowardTarget(resources, goal);
      // The unicorn subsystem runs BEFORE the plan executor for the same reason
      // crafting does: a sacrifice can complete a ziggurat upgrade's tears bill
      // this very tick, and the buy should follow immediately.
      manageUnicornReligion(resources, goal);
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
      // Parallel tiers run AFTER the plan buy and overflow: rank-order
      // candidates whose full bill clears the reservation ledger are crafted
      // toward and finished from genuine surplus while the plan waits on a
      // non-craftable trickle.
      craftTowardParallelCandidates(resources, goal);
      resetTickCache();
      resources = resourceMap();
      managePraise(resources);
      // Purchases can change resource stocks, caps, unlocks and per-tick effects;
      // re-read before diplomacy/jobs so later decisions are based on the board
      // after the buy, not on the planning snapshot from before it.
      resetTickCache();
      resources = resourceMap();
      manageDiplomacy(resources, goal);
      resetTickCache();
      resources = resourceMap();
      if (maybePromoteKittens(resources, goal)) {
        resetTickCache();
        resources = resourceMap();
      }
      if (maybeSelectLeader(goal, resources)) {
        resetTickCache();
        resources = resourceMap();
      }
      balanceJobs(goal, resources);
      autoHunt(resources);
      maybeHoldFestival(resources);
      festivalOpportunity(resources);
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
      if (resetHeadEl) resetHeadEl.textContent = resetAdvisorState.headline;
      if (resetCardEl && resetCardEl.setAttribute) resetCardEl.setAttribute("data-tone", resetAdvisorState.tone);
      if (resetEl) resetEl.textContent = resetAdvisorState.detail || resetAdvisorText;
      if (leaderEl) leaderEl.textContent = `👑 ${leaderPlanText}`;
      if (craftEl) craftEl.textContent = `🧰 ${craftPlanText} · ${overflowPlanText} · ${parallelPlanText}`;
      if (processingEl) processingEl.textContent = `⚙ ${processingPlanText}`;
      if (reserveStatusEl) reserveStatusEl.textContent = `🛡 ${reservePlanText}`;
      if (religionEl) religionEl.textContent = `☀ ${religionPlanText}`;
      if (unicornEl) unicornEl.textContent = `🦄 ${unicornPlanText}`;
      if (festivalEl) festivalEl.textContent = `🎉 ${festivalPlanText}`;
      if (diplomacyEl) diplomacyEl.textContent = `🤝 ${diplomacyPlanText}`;
      if (stageEl) stageEl.textContent = `🏭 ${stagePlanText}`;
      renderPolicyControl(resources, goal);
      renderQueueControl(resources, goal);
      renderRankingControl(resources, goal);
      if (nowEl) nowEl.textContent = `🎯 Now: ${getNowAction(resources, goal)}`;
      lastTickAt = Date.now();
    } catch (error) {
      /* ignore */
    }
  };

  /* ------------------------------ game speed ------------------------------- */

  // Manual ticker boost — the community `setInterval(game.tick)` trick, made
  // panel-controlled: the game's own scheduler keeps running at its native
  // ~5 ticks/s and this adds (multiplier − 1) × 5 extra ticks per second on
  // top, so 1× arms nothing and N× advances the game N× in wall-clock terms.
  // Nothing inside the game is mutated (no game.rate override): clearing the
  // interval instantly restores native speed, and the choice persists across
  // reloads under kgh.tickSpeed. The helper's planning stays correct at any
  // speed because every rate it uses is read live (observed resource deltas
  // simply reflect the boosted wall clock, so ETAs remain wall-clock-true).
  const TICK_SPEED_KEY = "kgh.tickSpeed";
  // Very high multipliers are machine-bound: each beat runs its extra ticks
  // synchronously, so when a burst takes longer than the 200ms beat the game
  // simply runs as fast as the machine allows instead of stacking up work.
  const TICK_SPEED_OPTIONS = [1, 2, 3, 5, 10, 20, 50];
  const TICK_SPEED_BEAT_MS = 200; // one beat per native tick at 5/s
  let tickSpeedTimer = null;
  let tickSpeed = (() => {
    try {
      const stored = Number(localStorage.getItem(TICK_SPEED_KEY));
      return TICK_SPEED_OPTIONS.includes(stored) ? stored : 1;
    } catch (error) {
      return 1;
    }
  })();

  const applyTickSpeed = (multiplier) => {
    tickSpeed = TICK_SPEED_OPTIONS.includes(multiplier) ? multiplier : 1;
    try { localStorage.setItem(TICK_SPEED_KEY, String(tickSpeed)); } catch (error) { /* keep the in-memory choice */ }
    if (tickSpeedTimer !== null) {
      try { clearInterval(tickSpeedTimer); } catch (error) { /* timer already gone */ }
      tickSpeedTimer = null;
    }
    if (tickSpeed <= 1) return tickSpeed;
    const extraPerBeat = tickSpeed - 1;
    tickSpeedTimer = setInterval(() => {
      try {
        const game = window.gamePage;
        if (!game || typeof game.tick !== "function") return;
        for (let i = 0; i < extraPerBeat; i += 1) game.tick();
      } catch (error) {
        /* a bad tick must not kill the booster */
      }
    }, TICK_SPEED_BEAT_MS);
    return tickSpeed;
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
      ".kgh-panel{--kgh-bg:#221a13;--kgh-card:#2d241b;--kgh-line:#ffffff14;--kgh-text:#f2e8d5;--kgh-dim:#b3a488;" +
      "--kgh-accent:#8fd8c8;--kgh-good:#8ee6a0;--kgh-warn:#ffd489;--kgh-alert:#ff9d7a;" +
      "box-sizing:border-box;width:min(340px,calc(100dvw - 16px));max-width:calc(100dvw - 16px);" +
      "max-height:calc(100dvh - 16px);overflow:auto;overflow-x:hidden;contain:layout style;" +
      "user-select:text;-webkit-user-select:text;scrollbar-width:thin}" +
      ".kgh-panel *{box-sizing:border-box;min-width:0;max-width:100%}" +
      ".kgh-panel small,.kgh-panel pre,.kgh-panel div{overflow-wrap:anywhere;word-break:normal}" +
      ".kgh-panel select{width:100%;min-width:0;user-select:auto;-webkit-user-select:auto;" +
      "background:#1b140e;color:var(--kgh-text);border:1px solid var(--kgh-line);border-radius:6px;padding:3px 4px}" +
      ".kgh-row{display:flex;gap:6px;min-width:0}" +
      ".kgh-grow{flex:1 1 auto;min-width:0}" +
      // Buttons must never shrink or wrap their label ("Appl\ny"): the panel's
      // global min-width:0 lets flex squeeze them, so pin them to content size.
      ".kgh-panel button{white-space:nowrap;flex:0 0 auto}" +
      // …except the full-width autopilot toggle, which must fill its row.
      ".kgh-panel .kgh-autopilot{flex:1 1 auto;background:#2d6b3f;color:#f2e8d5}" +
      // The speed selector shares the autopilot row: the panel-wide
      // select{width:100%} rule would make it claim the whole row and overlap
      // the toggle, so pin it to its content size.
      ".kgh-panel .kgh-speed{width:auto;flex:0 0 auto}" +
      ".kgh-card{background:var(--kgh-card);border:1px solid var(--kgh-line);border-radius:8px;padding:6px 8px;display:grid;gap:3px}" +
      ".kgh-sect{font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:var(--kgh-dim);font-weight:700}" +
      ".kgh-note{display:block;color:#d9ccae;opacity:.78}" +
      ".kgh-details{border-top:1px solid var(--kgh-line);padding-top:4px}" +
      ".kgh-details>summary{cursor:pointer;opacity:.82;list-style:none;font-size:11px;color:var(--kgh-dim)}" +
      ".kgh-details>summary::-webkit-details-marker{display:none}" +
      ".kgh-details>summary::before{content:'▸ '}" +
      ".kgh-details[open]>summary::before{content:'▾ '}" +
      ".kgh-details-body{display:grid;gap:4px;margin-top:5px}" +
      ".kgh-log{overflow:hidden auto}" +
      ".kgh-hbtn{cursor:pointer;background:#ffffff0a;color:var(--kgh-text);border:1px solid #ffffff22;" +
      "border-radius:5px;font-size:11px;padding:1px 7px;margin-left:4px;flex:0 0 auto}" +
      ".kgh-hbtn:hover{background:#ffffff1c}" +
      ".kgh-queue-item{gap:3px;align-items:center;justify-content:space-between;background:#ffffff08;border-radius:5px;padding:2px 5px}" +
      ".kgh-queue-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
      // Live target ranking rows: rank · name · trend · score · readiness.
      ".kgh-rk{display:grid;grid-template-columns:14px minmax(0,1fr) 12px auto auto;gap:5px;align-items:baseline;" +
      "padding:2px 5px;border-radius:5px;font-size:11.5px}" +
      ".kgh-rk-on{background:#8fd8c81a;box-shadow:inset 2px 0 0 var(--kgh-accent)}" +
      ".kgh-rk-n{color:var(--kgh-dim);font-size:10px;text-align:right}" +
      ".kgh-rk-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
      ".kgh-rk-plan{color:var(--kgh-accent);font-size:9px;letter-spacing:.08em;text-transform:uppercase;font-weight:700}" +
      ".kgh-rk-tr{text-align:center;font-size:10px}" +
      ".kgh-rk-up{color:var(--kgh-good)}.kgh-rk-down{color:var(--kgh-alert)}.kgh-rk-flat{color:var(--kgh-dim)}" +
      ".kgh-rk-score{font-variant-numeric:tabular-nums;font-weight:700;color:var(--kgh-text)}" +
      ".kgh-rk-eta{color:var(--kgh-dim);font-size:10px;font-variant-numeric:tabular-nums;min-width:34px;text-align:right}" +
      ".kgh-rk-ready{color:var(--kgh-good);font-size:9.5px;letter-spacing:.06em;text-transform:uppercase;font-weight:700;text-align:right}" +
      ".kgh-rk-empty{color:var(--kgh-dim);font-size:11px}" +
      // Reset advisor card: the verdict is a headline, colored by tone.
      ".kgh-reset-head{font-weight:700;font-size:12px}" +
      '.kgh-reset-card[data-tone="wait"] .kgh-reset-head{color:var(--kgh-dim)}' +
      '.kgh-reset-card[data-tone="target"] .kgh-reset-head{color:var(--kgh-warn)}' +
      '.kgh-reset-card[data-tone="ok"] .kgh-reset-head{color:var(--kgh-good)}' +
      '.kgh-reset-card[data-tone="go"] .kgh-reset-head{color:var(--kgh-alert)}' +
      "@media (max-width:700px){.kgh-panel{left:8px!important;right:8px!important;bottom:8px!important;width:auto!important;max-height:45dvh}}";
    document.head.appendChild(style);

    const box = document.createElement("div");
    box.className = "kgh-panel";
    box.style.cssText =
      "position:fixed;right:8px;bottom:8px;z-index:99999;padding:8px;" +
      "background:linear-gradient(180deg,#241b14,#1e1712);color:#f2e8d5;border:1px solid #ffffff1f;border-radius:10px;" +
      "font:12px/1.4 system-ui,-apple-system,'Segoe UI',sans-serif;display:grid;gap:6px;box-shadow:0 6px 24px #000a";
    box.innerHTML = [
      '<div class="kgh-row" style="justify-content:space-between;align-items:center">',
      '<span style="display:flex;align-items:baseline;gap:5px;min-width:0"><strong style="font-size:13px">🐱 Kittens Helper</strong>',
      '<small style="opacity:.55">v' + HELPER_VERSION + '</small></span>',
      '<span style="white-space:nowrap;display:flex;align-items:center"><small class="kgh-status" style="color:var(--kgh-dim)">…</small>',
      '<button type="button" class="kgh-hbtn kgh-min" title="Minimize">–</button></span></div>',
      '<div class="kgh-body" style="display:grid;gap:6px">',
      '<div class="kgh-row" style="gap:4px"><button type="button" class="kgh-autopilot kgh-grow" style="cursor:pointer;border-radius:6px;border:1px solid #ffffff22;padding:4px">Autopilot: ON</button>',
      '<select class="kgh-speed" aria-label="game speed" title="Game speed: extra game.tick() calls on top of the native ticker. 1× is fully native; higher multiplies real-time progress. Reversible instantly.">' +
        TICK_SPEED_OPTIONS.map((mult) => `<option value="${mult}">⏩ ${mult}×</option>`).join("") +
      "</select></div>",

      // PLAN — what the autopilot is doing and why, at a glance.
      '<div class="kgh-card"><span class="kgh-sect">Plan</span>',
      '<small class="kgh-plan" style="color:#a7e8e0;font-weight:700">…</small>',
      '<small class="kgh-now" style="color:#e6d79a">…</small>',
      '<small class="kgh-bottleneck" style="color:#f0b8a0">…</small>',
      '<small class="kgh-science" style="color:#bfe6a0">…</small>',
      '<small class="kgh-goal-line" style="color:#d8b6ff"></small></div>',

      // TOP TARGETS — the live ranking with score trends.
      '<div class="kgh-card"><span class="kgh-sect">Top targets · live score</span>',
      '<div class="kgh-ranking" style="display:grid;gap:1px"></div></div>',

      // RESET ADVISOR — an explicit verdict, always visible.
      '<div class="kgh-card kgh-reset-card" data-tone="wait"><span class="kgh-sect">Reset advisor</span>',
      '<span class="kgh-reset-head">…</span>',
      '<small class="kgh-reset" style="color:#a7f0b4">…</small></div>',

      // QUEUE — the manual override lane.
      '<div class="kgh-card"><span class="kgh-sect">Manual queue</span>',
      '<div class="kgh-row" style="gap:4px"><select class="kgh-queue-select kgh-grow" aria-label="add to build queue" style="min-width:0"></select>',
      '<button type="button" class="kgh-queue-add" style="cursor:pointer" title="Force this to the front of the plan">＋ Queue</button></div>',
      '<div class="kgh-queue-list" style="display:grid;gap:2px"></div></div>',

      '<details class="kgh-details"><summary>Subsystems &amp; automation details</summary><div class="kgh-details-body">',
      '<button type="button" class="kgh-prestige-arm" style="cursor:pointer;border-radius:6px;border:1px solid #ffffff22;padding:4px;color:var(--kgh-text)" title="Explicitly authorize Transcend, Adore, and alicorn sacrifice automation">Prestige automation: OFF</button>',
      '<small class="kgh-note"></small>',
      '<small class="kgh-jobs" style="color:#f3c37b">…</small>',
      '<small class="kgh-buy" style="color:#b8e2ff">…</small>',
      '<small class="kgh-leader" style="color:#ffd18f">…</small>',
      '<small class="kgh-craft" style="color:#cdb7ff">…</small>',
      '<small class="kgh-processing" style="color:#c8d0ff">…</small>',
      '<small class="kgh-reserve" style="color:#9fd0ff">…</small>',
      '<small class="kgh-religion" style="color:#ffe3a3">…</small>',
      '<small class="kgh-unicorn" style="color:#e8c7ff">…</small>',
      '<small class="kgh-festival" style="color:#ffd18f">…</small>',
      '<small class="kgh-diplomacy" style="color:#b7f0d0">…</small>',
      '<small class="kgh-stage" style="color:#ffcfa8">…</small>',
      '<small class="kgh-policy" style="color:#ffc6e0">…</small>',
      '<div class="kgh-row" style="gap:4px"><select class="kgh-policy-select kgh-grow" aria-label="policy"></select>',
      '<button type="button" class="kgh-policy-apply" style="cursor:pointer" title="Manual override — the autopilot auto-adopts the ranked best side on its own; queue a policy to pin a different side">Policy</button></div>',
      '<small style="opacity:.65">Resets stay OFF. Back up your save (Options → Export) first.</small>',
      '</div></details>',
      '<div style="opacity:.8;display:flex;justify-content:space-between;align-items:center"><span class="kgh-sect">Recent actions</span><button type="button" class="kgh-hbtn kgh-log-copy" title="Copy a full diagnostics report (plan, power, processing, resources, candidates, log) for debugging">Copy</button></div>',
      '<pre class="kgh-log" style="margin:0;max-height:220px;white-space:pre-wrap;' +
        'font:11px/1.35 ui-monospace,monospace;color:#d9ccae;background:#00000038;padding:5px 6px;border-radius:6px;border:1px solid var(--kgh-line)">…</pre>',
      "</div>",
    ].join("");

    const toggleBtn = box.querySelector(".kgh-autopilot");
    const minBtn = box.querySelector(".kgh-min");
    const logCopyBtn = box.querySelector(".kgh-log-copy");
    const prestigeArmBtn = box.querySelector(".kgh-prestige-arm");
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
    unicornEl = box.querySelector(".kgh-unicorn");
    festivalEl = box.querySelector(".kgh-festival");
    diplomacyEl = box.querySelector(".kgh-diplomacy");
    stageEl = box.querySelector(".kgh-stage");
    policyEl = box.querySelector(".kgh-policy");
    policySelectEl = box.querySelector(".kgh-policy-select");
    policyApplyEl = box.querySelector(".kgh-policy-apply");
    nowEl = box.querySelector(".kgh-now");
    noteEl = box.querySelector(".kgh-note");
    rankingEl = box.querySelector(".kgh-ranking");
    resetHeadEl = box.querySelector(".kgh-reset-head");
    resetCardEl = box.querySelector(".kgh-reset-card");
    logBox = box.querySelector(".kgh-log");

    const speedEl = box.querySelector(".kgh-speed");
    if (speedEl) {
      speedEl.value = String(tickSpeed);
      speedEl.addEventListener("change", () => {
        applyTickSpeed(Number(speedEl.value) || 1);
        speedEl.value = String(tickSpeed);
        pushLog(`⏩ game speed ${tickSpeed}× ${tickSpeed > 1 ? `(+${(tickSpeed - 1) * 5} extra ticks/s via game.tick)` : "(native ticker only)"}`);
      });
    }

    const syncToggle = () => {
      toggleBtn.textContent = `Autopilot: ${isAutopilotOn() ? "ON" : "OFF"}`;
      toggleBtn.style.background = isAutopilotOn() ? "#2d6b3f" : "#5a3a3a";
    };
    syncPrestigeArmControl = () => {
      const armed = prestigeAutomationArmed();
      prestigeArmBtn.textContent = `Prestige automation: ${armed ? "ARMED" : "OFF"}`;
      prestigeArmBtn.style.background = armed ? "#7a3f2f" : "#2d241b";
    };
    prestigeArmBtn.addEventListener("click", () => {
      setPrestigeAutomationArmed(!prestigeAutomationArmed());
    });
    syncPrestigeArmControl();
    toggleBtn.addEventListener("click", () => {
      const next = isAutopilotOn() ? "0" : "1";
      localStorage.setItem(STORAGE_KEY, next);
      syncToggle();
      applyProfile();
      tick();
    });
    syncToggle();
    if (logCopyBtn) {
      logCopyBtn.addEventListener("click", () => {
        try {
          // Copy the FULL diagnostics report (plan + power + processing + resources
          // + candidates + log), not just the visible log, so a single click hands
          // over everything needed to debug a run.
          const text = buildDiagnosticsReport();
          if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text);
            logCopyBtn.textContent = "Copied report";
            setTimeout(() => { logCopyBtn.textContent = "Copy"; }, 1500);
          }
        } catch (error) {
          /* clipboard may be restricted; user can select manually */
        }
      });
    }
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
    ACTION_POLICY,
    actionPolicyFor,
    executeSemanticAction,
    prestigeAutomationArmed,
    setPrestigeAutomationArmed,
    selectStrategicTarget(goalKey = getGoal()) {
      activePlanSnapshot = { cycleId: -1, target: undefined };
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
    bottleneckText(goalKey = getGoal()) {
      activePlanSnapshot = { cycleId: -1, target: undefined };
      resetTickCache();
      const resources = resourceMap();
      const decision = selectStrategicTarget(resources, goalKey);
      lastStrategicDecision = decision;
      tickCache.candidates = decision.candidates;
      return getBottleneck(resources);
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
    resourceNeeds(goalKey = getGoal()) {
      resetTickCache();
      return resourceNeeds(goalKey, resourceMap());
    },
    desiredJobCounts(goalKey = getGoal()) {
      resetTickCache();
      return desiredJobCounts(goalKey, resourceMap());
    },
    leaderOpportunity(goalKey = getGoal()) {
      resetTickCache();
      return leaderOpportunity(goalKey, resourceMap());
    },
    solveChain(candidate) {
      return solveCraftChain(resourceMap(), candidate);
    },
    validRaceSell(race, sell) {
      return validRaceSell(race, sell);
    },
    expectedTradeYield(race, sell) {
      return expectedTradeYield(race, sell);
    },
    acquisitionPathFor(name, amount, context = {}) {
      resetTickCache();
      return acquisitionPathFor(resourceMap(), name, amount, context);
    },
    activeAcquisitionRoute(target) {
      resetTickCache();
      return activeAcquisitionRoute(target, resourceMap());
    },
    boundedTradeBatch(route, ledger) {
      resetTickCache();
      return boundedTradeBatch(route, ledger, resourceMap());
    },
    buildReservationLedger(target) {
      resetTickCache();
      return buildReservationLedger(target, resourceMap());
    },
    manageDiplomacy(goalKey = getGoal()) {
      resetTickCache();
      const resources = resourceMap();
      manageDiplomacy(resources, goalKey);
      return diplomacyPlanText;
    },
    maybeTradeForTargetChain(target, goalKey = getGoal()) {
      resetTickCache();
      const resources = resourceMap();
      return maybeTradeForTargetChain(resources, buildReservationLedger(target, resources), goalKey, target);
    },
    classifyTargetFeasibility(candidate) {
      return classifyTargetFeasibility(candidate, resourceMap());
    },
    waitSecondsForCandidate(candidate) {
      resetTickCache();
      return waitSecondsForCandidate(candidate, resourceMap());
    },
    bestWoodJob() {
      return bestWoodJob();
    },
    expectedResetKarma(kittens) {
      return expectedResetKarma(kittens);
    },
    karmaKittensForRun(kittens) {
      return karmaKittensForRun(kittens);
    },
    resetAdvisor() {
      computeResetAdvisor();
      return resetAdvisorText;
    },
    resetAdvisorState() {
      computeResetAdvisor();
      return resetAdvisorState;
    },
    rankingRows(goalKey = getGoal()) {
      activePlanSnapshot = { cycleId: -1, target: undefined };
      resetTickCache();
      return rankingRows(resourceMap(), goalKey);
    },
    queuePickerEntries(goalKey = getGoal()) {
      resetTickCache();
      return queuePickerEntries(resourceMap(), goalKey);
    },
    candidateById(id, goalKey = getGoal()) {
      activePlanSnapshot = { cycleId: -1, target: undefined };
      resetTickCache();
      return findCandidateById(getCandidatesCached(resourceMap(), goalKey), id);
    },
    candidateRank(id, goalKey = getGoal()) {
      resetTickCache();
      const list = getCandidatesCached(resourceMap(), goalKey);
      const found = findCandidateById(list, id);
      return found ? list.indexOf(found) + 1 : -1;
    },
    queue: () => readQueue(),
    queueAdd: (id, val) => queueAdd(id, val),
    queueRemove: (id) => queueRemove(id),
    queueClear: () => writeQueue([]),
    queueStatus: () => queuePlanText,
    policyAdvice(goalKey = getGoal()) {
      resetTickCache();
      return policyAdviceLine(resourceMap(), goalKey);
    },
    autoPolicyChoice(goalKey = getGoal()) {
      resetTickCache();
      return autoPolicyChoice(resourceMap(), goalKey);
    },
    pendingPolicyReserve(goalKey = getGoal()) {
      resetTickCache();
      return pendingPolicyReservationLedger(resourceMap(), goalKey).reserved;
    },
    festivalCanPay(target = null) {
      resetTickCache();
      return festivalCanPay(target, resourceMap());
    },
    executePlan(goalKey = getGoal()) {
      resetTickCache();
      executePlan(resourceMap(), goalKey);
      return buyPlanText;
    },
    craftTowardTarget(goalKey = getGoal()) {
      activePlanSnapshot = { cycleId: -1, target: undefined };
      resetTickCache();
      craftTowardTarget(resourceMap(), goalKey);
      return craftPlanText;
    },
    craftTowardParallelCandidates(goalKey = getGoal()) {
      activePlanSnapshot = { cycleId: -1, target: undefined };
      resetTickCache();
      craftTowardParallelCandidates(resourceMap(), goalKey);
      return parallelPlanText;
    },
    parallelReservationFloors(goalKey = getGoal()) {
      resetTickCache();
      const resources = resourceMap();
      return parallelReservationFloors(getTargetCached(resources, goalKey), resources);
    },
    sprintCapDrainPacing(candidate) {
      resetTickCache();
      return sprintCapDrainPacing(candidate, resourceMap());
    },
    forceActiveTarget(candidate, layer = null, ageMs = 0) {
      // A debug/manual target override resets ALL locks so the planner starts
      // from a clean state (mirrors an explicit player priority change).  Tests
      // may pass a layer and a synthetic age to exercise the lock-hold paths.
      activeSprint = null;
      activeScienceUnlockId = null;
      activeScienceUnlockContext = null;
      activePowerRecoveryId = null;
      activeWorkshopRoadmapId = null;
      activeSprintPacingBoostId = null;
      const startedAt = Date.now() - Math.max(0, ageMs);
      activeTarget = candidate ? {
        id: targetId(candidate),
        startedAt,
        lastProgressAt: startedAt,
        lastProgressSignature: targetProgressSignature(candidate, resourceMap()),
        initialVal: VAL_BASED_KINDS.has(candidate.kind) ? candidate.meta.val || 0 : 0,
        layer,
        queueSignature: JSON.stringify(readQueue()),
      } : null;
    },
    chooseWorkTarget(goalKey = getGoal()) {
      activePlanSnapshot = { cycleId: -1, target: undefined };
      resetTickCache();
      return chooseWorkTarget(resourceMap(), goalKey);
    },
    foodHelpingCandidate,
    targetId,
    candidateScoreGain,
    candidateMeetsSwitchScoreGain,
    buildTargetLedger(target) { return buildTargetLedger(target, resourceMap()); },
    spendImpactForCandidate(candidate) { return spendImpactForCandidate(candidate, resourceMap()); },
    violatesTargetLock(candidate, target) { return violatesTargetLock(candidate, buildTargetLedger(target, resourceMap()), resourceMap()); },
    targetTradeScore(race, target) { return targetTradeScore(race, target, resourceMap(), reservedNeedsFor(target, resourceMap())); },
    targetPathwayAnalysis(target) { return targetPathwayAnalysis(target, resourceMap()); },
    craftPathSecondsFor(name, amount) { return craftPathSecondsFor(name, amount, resourceMap()); },
    tradePathSecondsFor(race, sellName, amount) { return tradePathSecondsFor(race, sellName, amount, resourceMap()); },
    tradeSpeedMultiplierFor(race, target) { return tradeSpeedMultiplierFor(race, target, resourceMap()); },
    liveMetaView,
    labelOf,
    metaEffectProfile,
    candidateEffectProfile,
    powerStatus,
    effectivePowerStatus,
    latentPowerDemand,
    powerRecoveryDiagnostic: () => lastPowerRecoveryDiagnostic,
    doesCraftAdvanceActivePlan(candidate, outputName) { return doesCraftAdvanceActivePlan(candidate, resourceMap(), outputName); },
    powerSafeToBuild,
    profileNetEnergy,
    candidateNetEnergy,
    isPowerEmergency,
    report: () => buildDiagnosticsReport(),
    candidateScore(candidate, goalKey = getGoal()) {
      resetTickCache();
      return candidateScore(candidate, resourceMap(), GOALS[goalKey], goalKey);
    },
    desiredProcessorState(meta) {
      resetTickCache();
      return desiredProcessorState(meta, resourceMap(), new Set(), new Set(), {});
    },
    optimizeProcessing(goalKey = getGoal()) {
      resetTickCache();
      optimizeProcessing(resourceMap(), goalKey);
      return processingPlanText;
    },
    sampleResourceTelemetry,
    clearResourceTelemetry(name) {
      if (name) delete resourceTelemetry[name === "catpower" ? "manpower" : name];
      else for (const key of Object.keys(resourceTelemetry)) delete resourceTelemetry[key];
    },
    productionFor(name) {
      resetTickCache();
      return productionFor(name);
    },
    researchTargetPhase(target) { return researchTargetPhase(target, resourceMap()); },
    overflowInputFloor(target, inputName, outputName, forPlanChain = false) {
      return overflowInputFloor(target, resourceMap(), inputName, outputName, forPlanChain);
    },
    bootstrapResourceCandidate() {
      resetTickCache();
      return bootstrapResourceCandidate(resourceMap());
    },
    scienceStorageGain(candidate) {
      resetTickCache();
      return scienceStorageGain(candidate);
    },
    scienceStorageUnlockCandidate(candidate) {
      resetTickCache();
      return scienceStorageUnlockCandidate(candidate, resourceMap());
    },
    projectScienceClosure(candidate, need) {
      resetTickCache();
      return projectScienceClosure(candidate, need, resourceMap());
    },
    bestScienceStorageUnlock(candidates) {
      resetTickCache();
      return bestScienceStorageUnlock(candidates, resourceMap());
    },
    bestPowerRecoveryTarget(candidates) {
      resetTickCache();
      return bestPowerRecoveryTarget(candidates, resourceMap());
    },
    converterFuelStarvation() {
      resetTickCache();
      return [...converterFuelStarvation(resourceMap())];
    },
    bestConverterFuelTarget(candidates) {
      resetTickCache();
      return bestConverterFuelTarget(candidates || gatherCandidates(resourceMap(), getGoal()), resourceMap());
    },
    expansionPressure,
    bestExpansionCheckpoint(goalKey = getGoal()) {
      resetTickCache();
      const resources = resourceMap();
      return bestExpansionCheckpoint(gatherCandidates(resources, goalKey), resources);
    },
    unicornEconomyPlan() {
      resetTickCache();
      return unicornEconomyPlan(resourceMap());
    },
    bestUnicornPathTarget(candidates, goalKey = getGoal()) {
      resetTickCache();
      const resources = resourceMap();
      return bestUnicornPathTarget(candidates || gatherCandidates(resources, goalKey), resources);
    },
    manageUnicornReligion(goalKey = getGoal()) {
      resetTickCache();
      manageUnicornReligion(resourceMap(), goalKey);
      return unicornPlanText;
    },
    clearUnicornPathState() {
      activeUnicornPathId = null;
      lastUnicornSacrificeAt = 0;
      unicornPlanCache = { key: null, plan: null };
    },
    sacrificeConversionFor,
    sacrificePotentialFor(name) { return sacrificePotentialFor(resourceMap(), name); },
    unicornPlanText: () => unicornPlanText,
    festivalOpportunity() {
      resetTickCache();
      return festivalOpportunity(resourceMap());
    },
    festivalCanPay(target) {
      resetTickCache();
      return festivalCanPay(target, resourceMap());
    },
    festivalStatus() {
      resetTickCache();
      festivalOpportunity(resourceMap());
      return festivalPlanText;
    },
    stageTransitionAnalysis(raw, toStage) {
      resetTickCache();
      return stageTransitionAnalysis(raw, toStage, resourceMap());
    },
    stageTransitionCandidate(raw, toStage) {
      resetTickCache();
      return stageTransitionCandidate(raw, toStage, resourceMap());
    },
    bestStageTransition() {
      resetTickCache();
      return bestStageTransition(resourceMap());
    },
    pendingStageRebuildCandidate() {
      resetTickCache();
      const resources = resourceMap();
      return pendingStageRebuildCandidate(gatherCandidates(resources, getGoal()), resources);
    },
    executeStageTransitionCandidate,
    pendingStageRebuild: () => pendingStageRebuild,
    tickSpeed: () => tickSpeed,
    applyTickSpeed,
    stageStatus() {
      resetTickCache();
      stageTransitionCandidates(resourceMap());
      return stagePlanText;
    },
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
      applyProfile();
      buildPanel();
      applyTickSpeed(tickSpeed); // re-arm the persisted manual game speed
    })
    .catch((error) => console.error("[KGH] Failed to start:", error));
})();
