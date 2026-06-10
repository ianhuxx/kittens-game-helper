// Sanity check for the userscript. Run with: npm run validate
//
// It does not (and cannot) drive a browser. It verifies that:
//   1. the userscript body parses (no syntax errors),
//   2. the Kitten Scientists @require pin is present,
//   3. the reset-safety denylist is intact (so we never auto-reset a save),
//   4. both profiles still exist.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const scriptPath = fileURLToPath(new URL("../src/kittens-game-helper.user.js", import.meta.url));
const source = await readFile(scriptPath, "utf8");

const required = [
  // KS must be pinned so behavior is reproducible.
  "kitten-scientists/releases/download/v2.0.0-beta.11/",
  // Safety: irreversible automations must stay denied.
  "DENY_SUBSTRINGS",
  '"reset"',
  '"transcend"',
  '"sacrifice"',
  // Both profiles must exist.
  "autopilot",
  "assist",
  // The "build as soon as affordable" trigger fix must stay in place.
  "PURCHASE_SECTIONS",
  "setTriggersDeep",
  // Cap-aware planning: blocked targets must redirect into storage builds.
  "capBlocked",
  "capReliefBoost",
  // Overflow protection: capped resources get converted, never wasted.
  "preventResourceOverruns",
  "OVERFLOW_CONVERSIONS",
  // Village care: leader election/promotion and the festival backup.
  "manageLeader",
  "maybeHoldFestival",
  // KS's own jobs/hunt/leader automations must stay off (we manage them).
  "disableKSManagedAutomations",
  // Festivals must PAY before holdFestival (which itself charges nothing).
  "payPrices",
];

const missing = required.filter((token) => !source.includes(token));
if (missing.length > 0) {
  console.error("✗ Missing required tokens:", missing.join(", "));
  process.exit(1);
}

// Strip the // ==UserScript== metadata block, then compile the body. Compiling
// (not running) catches syntax errors without needing browser globals.
const body = source.replace(/\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==/, "");
try {
  new vm.Script(body, { filename: "kittens-game-helper.user.js" });
} catch (error) {
  console.error("✗ Userscript failed to parse:", error.message);
  process.exit(1);
}

console.log("✓ Userscript parses, KS is pinned, and reset-safety denylist is intact.");
