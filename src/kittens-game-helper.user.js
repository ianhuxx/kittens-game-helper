// ==UserScript==
// @name         Kittens Game Helper
// @namespace    https://github.com/local/kittens-game-helper
// @version      0.3.0
// @description  Minimal Kitten Scientists loader with job automation and a next-action advisor for your existing browser save.
// @author       OpenAI
// @match        https://kittensgame.com/web/
// @match        https://kittensgame.com/beta/
// @match        https://kittensgame.com/alpha/
// @require      https://github.com/kitten-science/kitten-scientists/releases/download/v2.0.0-beta.11/kitten-scientists-2.0.0-beta.11.user.js
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function kittensGameHelper() {
  "use strict";

  const STORAGE_KEY = "kgh.profile";
  const DEFAULT_PROFILE = "autonomous";
  const JOBS = ["farmer", "woodcutter", "scholar", "miner", "hunter", "geologist", "priest", "engineer"];

  const JOB_LIMITS = {
    assisted: { farmer: 3, woodcutter: -1, scholar: -1, miner: -1, hunter: 4, geologist: -1, priest: -1, engineer: -1 },
    autonomous: { farmer: 2, woodcutter: -1, scholar: -1, miner: -1, hunter: 3, geologist: -1, priest: -1, engineer: -1 }
  };

  const PROFILES = {
    assisted: {
      label: "Assisted: jobs + advice",
      note: "Jobs, hunting, observing, and next-step advice are ON. Buying/research stays mostly in your control.",
      patch: {
        engine: { enabled: true, interval: 1500, ksColumn: { enabled: true } },
        village: {
          enabled: true,
          hunt: { enabled: true, trigger: 0.95 },
          promoteLeader: { enabled: true },
          promoteKittens: { enabled: false },
          jobs: {}
        },
        science: { enabled: true, observe: { enabled: true } },
        timeControl: {
          enabled: true,
          accelerateTime: { enabled: true, trigger: 1 },
          timeSkip: { enabled: false },
          reset: { enabled: false }
        }
      }
    },
    autonomous: {
      label: "Autonomous: play forward",
      note: "Jobs, hunting, buildings, research, upgrades, crafting, and safe time controls are ON. Resets are still OFF.",
      patch: {
        engine: { enabled: true, interval: 1000, ksColumn: { enabled: true } },
        bonfire: {
          enabled: true,
          trigger: 0.95,
          gatherCatnip: { enabled: true },
          turnOnSteamworks: { enabled: true },
          turnOnMagnetos: { enabled: true },
          turnOnReactors: { enabled: true },
          upgradeBuildings: { enabled: false }
        },
        village: {
          enabled: true,
          hunt: { enabled: true, trigger: 0.95 },
          holdFestivals: { enabled: true },
          promoteLeader: { enabled: true },
          promoteKittens: { enabled: false },
          jobs: {}
        },
        science: { enabled: true, observe: { enabled: true } },
        workshop: { enabled: true, trigger: 0.95 },
        timeControl: {
          enabled: true,
          accelerateTime: { enabled: true, trigger: 1 },
          timeSkip: { enabled: true, trigger: 5, max: 0, ignoreOverheat: { enabled: false } },
          reset: { enabled: false }
        }
      }
    }
  };

  const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

  const selectedProfile = () => {
    const name = localStorage.getItem(STORAGE_KEY);
    return PROFILES[name] ? name : DEFAULT_PROFILE;
  };

  const merge = (target, patch) => {
    for (const [key, value] of Object.entries(patch)) {
      const targetValue = target[key];
      if (value && typeof value === "object" && !Array.isArray(value)) {
        target[key] = merge(targetValue && typeof targetValue === "object" ? { ...targetValue } : {}, value);
      } else {
        target[key] = value;
      }
    }
    return target;
  };

  const waitForKittenScientists = async () => {
    for (let i = 0; i < 240; i += 1) {
      if (window.kittenScientists?.getSettings && window.kittenScientists?.setSettings && window.gamePage?.resPool) {
        return window.kittenScientists;
      }
      await delay(250);
    }
    throw new Error("Kitten Scientists did not finish loading.");
  };

  const setAllEnabled = (items, { trigger = 0.95, max = -1 } = {}) => {
    if (!items || typeof items !== "object") {
      return;
    }
    for (const item of Object.values(items)) {
      if (!item || typeof item !== "object") {
        continue;
      }
      item.enabled = true;
      if ("trigger" in item) {
        item.trigger = trigger;
      }
      if ("max" in item) {
        item.max = max;
      }
    }
  };

  const configureJobs = (settings, profileName) => {
    const jobs = settings.village?.jobs;
    if (!jobs) {
      return;
    }
    const limits = JOB_LIMITS[profileName] || JOB_LIMITS.autonomous;
    for (const job of JOBS) {
      jobs[job] = { ...(jobs[job] || {}), enabled: true, max: limits[job] };
    }
  };

  const configureAutonomous = settings => {
    setAllEnabled(settings.bonfire?.buildings, { trigger: 0.95, max: -1 });
    setAllEnabled(settings.science?.techs?.techs, { trigger: 0.95 });
    setAllEnabled(settings.science?.policies?.policies, { trigger: 0.95 });
    setAllEnabled(settings.workshop?.upgrades?.upgrades, { trigger: 0.95 });
    setAllEnabled(settings.workshop?.crafts, { trigger: 0.95, max: -1 });

    // Keep risky irreversible/large-sell automation off unless the player enables it manually in KS.
    if (settings.timeControl?.reset) {
      settings.timeControl.reset.enabled = false;
    }
    if (settings.bonfire?.upgradeBuildings) {
      settings.bonfire.upgradeBuildings.enabled = false;
    }
  };

  const applyProfile = name => {
    const profileName = PROFILES[name] ? name : DEFAULT_PROFILE;
    const currentSettings = window.kittenScientists.getSettings();
    const nextSettings = merge({ ...currentSettings }, PROFILES[profileName].patch);

    configureJobs(nextSettings, profileName);
    if (profileName === "autonomous") {
      configureAutonomous(nextSettings);
    }

    window.kittenScientists.setSettings(nextSettings);
    localStorage.setItem(STORAGE_KEY, profileName);
    console.info(`[KGH] Applied ${PROFILES[profileName].label}; reset automation remains OFF.`);
    updateAdvisor();
  };

  const resourceMap = () => {
    const map = new Map();
    for (const resource of window.gamePage?.resPool?.resources || []) {
      map.set(resource.name, resource);
    }
    return map;
  };

  const itemCosts = item => item?.prices || item?.price || item?.cost || [];

  const canConsider = item => item && item.unlocked !== false && item.researched !== true && item.val !== item.max;

  const formatNumber = value => value >= 1000 ? value.toLocaleString(undefined, { maximumFractionDigits: 0 }) : value.toLocaleString(undefined, { maximumFractionDigits: 2 });

  const candidateProgress = (candidate, resources) => {
    const costs = itemCosts(candidate.item).filter(cost => cost?.name && Number.isFinite(cost.val) && cost.val > 0);
    if (!costs.length) {
      return { affordable: false, progress: 0, missing: "unknown costs" };
    }

    let affordable = true;
    let progress = 1;
    const missing = [];
    for (const cost of costs) {
      const resource = resources.get(cost.name);
      const have = resource?.value || 0;
      progress = Math.min(progress, have / cost.val);
      if (have < cost.val) {
        affordable = false;
        missing.push(`${formatNumber(cost.val - have)} ${resource?.title || cost.name}`);
      }
    }

    return { affordable, progress, missing: missing.slice(0, 3).join(", ") };
  };

  const collectCandidates = () => {
    const game = window.gamePage;
    const candidates = [];

    for (const tech of game?.science?.techs || []) {
      if (canConsider(tech)) {
        candidates.push({ type: "research", label: tech.label || tech.title || tech.name, item: tech, weight: 4 });
      }
    }
    for (const upgrade of game?.workshop?.upgrades || []) {
      if (canConsider(upgrade)) {
        candidates.push({ type: "workshop", label: upgrade.label || upgrade.title || upgrade.name, item: upgrade, weight: 3 });
      }
    }
    for (const building of game?.bld?.buildings || []) {
      if (canConsider(building)) {
        candidates.push({ type: "build", label: building.label || building.title || building.name, item: building, weight: 2 });
      }
    }

    return candidates;
  };

  const getNextAction = () => {
    const resources = resourceMap();
    const candidates = collectCandidates()
      .map(candidate => ({ ...candidate, ...candidateProgress(candidate, resources) }))
      .filter(candidate => candidate.progress > 0 || candidate.affordable);

    const affordable = candidates
      .filter(candidate => candidate.affordable)
      .sort((a, b) => b.weight - a.weight)[0];
    if (affordable) {
      return `NOW: ${affordable.type} ${affordable.label} — affordable.`;
    }

    const nearest = candidates.sort((a, b) => (b.progress + b.weight / 100) - (a.progress + a.weight / 100))[0];
    if (nearest) {
      return `NEXT: ${nearest.type} ${nearest.label} — need ${nearest.missing}.`;
    }

    return "No next item found yet. Keep KS enabled and check unlocked tabs.";
  };

  let advisorLine;
  const updateAdvisor = () => {
    if (advisorLine) {
      advisorLine.textContent = getNextAction();
    }
  };

  const addProfilePicker = () => {
    const box = document.createElement("div");
    box.innerHTML = `
      <strong>Kittens Helper</strong>
      <select aria-label="Kittens Helper profile">
        <option value="autonomous">Autonomous: play forward</option>
        <option value="assisted">Assisted: jobs + advice</option>
      </select>
      <button type="button">Apply</button>
      <small class="kgh-note"></small>
      <small class="kgh-advisor">Checking next step…</small>
      <small>Resets/prestige stay OFF. Export a save before changing reset settings in KS.</small>
    `;
    box.style.cssText = "position:fixed;right:12px;bottom:12px;z-index:9999;max-width:310px;padding:8px;background:#2b2118;color:#f7ead0;border:1px solid #9b7a4d;border-radius:4px;font:12px sans-serif;display:grid;gap:5px;box-shadow:0 2px 8px #0008";

    const picker = box.querySelector("select");
    const button = box.querySelector("button");
    const note = box.querySelector(".kgh-note");
    advisorLine = box.querySelector(".kgh-advisor");

    const syncText = () => {
      note.textContent = PROFILES[picker.value].note;
      updateAdvisor();
    };

    picker.value = selectedProfile();
    picker.addEventListener("change", syncText);
    button.addEventListener("click", () => applyProfile(picker.value));

    document.body.append(box);
    syncText();
    setInterval(updateAdvisor, 10000);
  };

  waitForKittenScientists()
    .then(() => {
      applyProfile(selectedProfile());
      addProfilePicker();
    })
    .catch(error => console.error("[KGH] Failed to start.", error));
})();
