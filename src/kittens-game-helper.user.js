// ==UserScript==
// @name         Kittens Game Helper
// @namespace    https://github.com/local/kittens-game-helper
// @version      0.2.0
// @description  Minimal Kitten Scientists loader with safe Assisted / Autonomous profiles for your existing browser save.
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
  const DEFAULT_PROFILE = "assisted";

  const PROFILES = {
    assisted: {
      label: "Assisted: no resets",
      patch: {
        engine: { enabled: true, interval: 2000, ksColumn: { enabled: true } },
        timeControl: {
          enabled: true,
          accelerateTime: { enabled: true, trigger: 1 },
          timeSkip: { enabled: false },
          reset: { enabled: false }
        }
      }
    },
    autonomous: {
      label: "Autonomous: safe",
      patch: {
        engine: { enabled: true, interval: 1000, ksColumn: { enabled: true } },
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
      if (window.kittenScientists?.getSettings && window.kittenScientists?.setSettings) {
        return window.kittenScientists;
      }
      await delay(250);
    }
    throw new Error("Kitten Scientists did not finish loading.");
  };

  const applyProfile = name => {
    const profileName = PROFILES[name] ? name : DEFAULT_PROFILE;
    const currentSettings = window.kittenScientists.getSettings();
    window.kittenScientists.setSettings(merge({ ...currentSettings }, PROFILES[profileName].patch));
    localStorage.setItem(STORAGE_KEY, profileName);
    console.info(`[KGH] Applied ${PROFILES[profileName].label}; reset automation remains OFF.`);
  };

  const addProfilePicker = () => {
    const box = document.createElement("div");
    box.innerHTML = `
      <strong>Kittens Helper</strong>
      <select aria-label="Kittens Helper profile">
        <option value="assisted">Assisted: no resets</option>
        <option value="autonomous">Autonomous: safe</option>
      </select>
      <small>Export a save before turning on KS reset automation.</small>
    `;
    box.style.cssText = "position:fixed;right:12px;bottom:12px;z-index:9999;padding:8px;background:#2b2118;color:#f7ead0;border:1px solid #9b7a4d;border-radius:4px;font:12px sans-serif;display:grid;gap:5px";

    const picker = box.querySelector("select");
    picker.value = selectedProfile();
    picker.addEventListener("change", event => applyProfile(event.target.value));

    document.body.append(box);
  };

  waitForKittenScientists()
    .then(() => {
      applyProfile(selectedProfile());
      addProfilePicker();
    })
    .catch(error => console.error("[KGH] Failed to start.", error));
})();
