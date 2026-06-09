// ==UserScript==
// @name         Kittens Game Helper
// @namespace    https://github.com/local/kittens-game-helper
// @version      0.1.0
// @description  Load Kitten Scientists with safe Assisted and Autonomous profiles for your existing kittensgame.com browser save.
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
      label: "Assisted (no resets)",
      help: "Starts Kitten Scientists and preserves your existing save; prestige/reset automation stays off.",
      settings: {
        engine: {
          enabled: true,
          interval: 2000,
          ksColumn: { enabled: true },
          highlighStock: { enabled: false }
        },
        timeControl: {
          enabled: true,
          accelerateTime: { enabled: true, trigger: 1 },
          timeSkip: { enabled: false, trigger: 5, max: 0 },
          reset: { enabled: false }
        }
      }
    },
    autonomous: {
      label: "Autonomous (safe)",
      help: "More hands-off automation and time controls; reset automation is still off until you opt in inside Kitten Scientists after exporting a backup.",
      settings: {
        engine: {
          enabled: true,
          interval: 1000,
          ksColumn: { enabled: true },
          highlighStock: { enabled: false }
        },
        timeControl: {
          enabled: true,
          accelerateTime: { enabled: true, trigger: 1 },
          timeSkip: {
            enabled: true,
            trigger: 5,
            max: 0,
            ignoreOverheat: { enabled: false }
          },
          reset: { enabled: false }
        }
      }
    }
  };

  const sleep = ms => new Promise(resolve => window.setTimeout(resolve, ms));

  const isPlainObject = value =>
    Object.prototype.toString.call(value) === "[object Object]";

  const deepMerge = (base, patch) => {
    const output = Array.isArray(base) ? [...base] : { ...base };

    for (const [key, value] of Object.entries(patch)) {
      if (isPlainObject(value) && isPlainObject(output[key])) {
        output[key] = deepMerge(output[key], value);
      } else {
        output[key] = value;
      }
    }

    return output;
  };

  const selectedProfileName = () => {
    const storedProfile = window.localStorage.getItem(STORAGE_KEY);
    return Object.hasOwn(PROFILES, storedProfile) ? storedProfile : DEFAULT_PROFILE;
  };

  const waitForKittenScientists = async () => {
    for (let attempt = 0; attempt < 240; attempt += 1) {
      if (
        window.gamePage &&
        window.kittenScientists &&
        typeof window.kittenScientists.getSettings === "function" &&
        typeof window.kittenScientists.setSettings === "function"
      ) {
        return window.kittenScientists;
      }
      await sleep(250);
    }

    throw new Error("Timed out waiting for Kitten Scientists to load.");
  };

  const applyProfile = profileName => {
    const profile = PROFILES[profileName] || PROFILES[DEFAULT_PROFILE];
    const ks = window.kittenScientists;

    if (!ks) {
      throw new Error("Kitten Scientists is not available yet.");
    }

    const currentSettings = ks.getSettings();
    const nextSettings = deepMerge(currentSettings, profile.settings);
    ks.setSettings(nextSettings);
    window.localStorage.setItem(STORAGE_KEY, profileName);
    console.info(`[KGH] Applied ${profile.label}.`, profile.help);
    return true;
  };

  const makeButton = (profileName, refresh) => {
    const button = document.createElement("button");
    const profile = PROFILES[profileName];
    button.type = "button";
    button.textContent = profile.label;
    button.title = profile.help;
    button.addEventListener("click", () => {
      applyProfile(profileName);
      refresh();
    });
    return button;
  };

  const installProfileSwitcher = () => {
    if (document.getElementById("kgh-profile-switcher")) {
      return;
    }

    const panel = document.createElement("section");
    panel.id = "kgh-profile-switcher";
    panel.style.cssText = [
      "position: fixed",
      "right: 12px",
      "bottom: 12px",
      "z-index: 10000",
      "max-width: 280px",
      "padding: 10px",
      "border: 1px solid rgba(150, 120, 80, 0.8)",
      "border-radius: 6px",
      "background: rgba(35, 28, 20, 0.94)",
      "color: #f7ead0",
      "font: 12px/1.35 Arial, sans-serif",
      "box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35)"
    ].join(";");

    const title = document.createElement("strong");
    title.textContent = "Kittens Helper";
    title.style.display = "block";

    const status = document.createElement("p");
    status.style.margin = "6px 0";

    const controls = document.createElement("div");
    controls.style.display = "grid";
    controls.style.gap = "6px";

    const refresh = () => {
      const name = selectedProfileName();
      status.textContent = `Active: ${PROFILES[name].label}`;
      for (const button of controls.querySelectorAll("button")) {
        button.disabled = button.textContent === PROFILES[name].label;
      }
    };

    controls.append(makeButton("assisted", refresh), makeButton("autonomous", refresh));

    const backup = document.createElement("p");
    backup.textContent = "Before enabling KS reset automation, export a save backup from Options → Export.";
    backup.style.margin = "6px 0 0";

    panel.append(title, status, controls, backup);
    document.body.append(panel);
    refresh();
  };

  const main = async () => {
    await waitForKittenScientists();
    applyProfile(selectedProfileName());
    installProfileSwitcher();
  };

  main().catch(error => console.error("[KGH] Failed to initialize.", error));
})();
