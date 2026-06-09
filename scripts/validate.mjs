import { readFile } from "node:fs/promises";
import { join } from "node:path";
import vm from "node:vm";

const root = new URL("..", import.meta.url);
const presetNames = ["assisted", "autonomous"];

for (const name of presetNames) {
  const raw = await readFile(new URL(`presets/${name}.json`, root), "utf8");
  const preset = JSON.parse(raw);
  if (!preset.settings?.engine?.enabled) {
    throw new Error(`${name} profile must enable the Kitten Scientists engine.`);
  }
  if (preset.settings?.timeControl?.reset?.enabled !== false) {
    throw new Error(`${name} profile must keep reset automation disabled by default.`);
  }
}

const userscript = await readFile(new URL("src/kittens-game-helper.user.js", root), "utf8");
const body = userscript.replace(/^\/\/ ==UserScript==[\s\S]*?^\/\/ ==\/UserScript==/m, "");
new vm.Script(body, { filename: join("src", "kittens-game-helper.user.js") });

console.log("Profiles are valid and the userscript parses.");
