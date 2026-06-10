// Behavioral smoke test for the userscript. Run with: npm run smoke
//
// The userscript wraps almost everything in try/catch, so a logic bug fails
// SILENTLY in the real game. This harness runs the script against a faithful
// mock of gamePage + kittenScientists and asserts the automations actually
// fire: settings safety, overflow crafting, festival funding, leader election,
// gold-overflow promotion, cap-aware planning and the starvation guard.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const scriptPath = fileURLToPath(new URL("../src/kittens-game-helper.user.js", import.meta.url));
const source = await readFile(scriptPath, "utf8");
const body = source.replace(/\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==/, "");

/* ------------------------------- fake DOM --------------------------------- */

const makeEl = () => {
  const el = {
    style: {},
    children: [],
    textContent: "",
    innerHTML: "",
    value: "",
    title: "",
    id: "",
    selectors: new Map(),
    classList: { toggle() {}, contains: () => false },
    addEventListener() {},
    appendChild(child) {
      this.children.push(child);
    },
    querySelector(sel) {
      if (!this.selectors.has(sel)) this.selectors.set(sel, makeEl());
      return this.selectors.get(sel);
    },
  };
  return el;
};

const documentMock = {
  head: makeEl(),
  body: makeEl(),
  createElement: () => makeEl(),
};

const storage = new Map();
const localStorageMock = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)),
};

/* ------------------------------ fake game ---------------------------------- */

const R = (name, value, maxValue, title, extra = {}) => ({
  name,
  value,
  maxValue,
  title: title || name[0].toUpperCase() + name.slice(1),
  unlocked: true,
  calculatePerTick: true,
  ...extra,
});

const resources = [
  R("catnip", 2500, 5000),
  R("wood", 2850, 3000), // 95% of cap → overflow → beams
  R("minerals", 600, 1000),
  R("iron", 150, 300),
  R("coal", 20, 60),
  R("science", 5900, 6000), // capped, and Theology costs 9000 → storage plan
  R("culture", 5600, 6000), // capping, but festival budget must survive
  R("faith", 10, 100),
  R("manpower", 1700, 2000, "Catpower"), // enough for a festival
  R("gold", 95, 100), // overflowing → promotions
  R("furs", 5000, 0), // uncapped luxury → parchment skim, cushion kept
  R("ivory", 200, 0),
  R("spice", 0, 0, "Spice", { unlocked: false }),
  R("parchment", 3000, 0),
  R("manuscript", 10, 0),
  R("compedium", 0, 0, "Compendium"),
  R("blueprint", 0, 0),
  R("beam", 60, 0),
  R("slab", 0, 0),
  R("plate", 0, 0),
  R("steel", 0, 0),
  R("titanium", 0, 100),
  R("oil", 0, 100),
  R("uranium", 0, 100),
  R("unobtainium", 0, 100),
];
const res = (name) => resources.find((r) => r.name === name);

const crafts = [
  { name: "wood", label: "Refine Catnip", unlocked: true, prices: [{ name: "catnip", val: 100 }] },
  { name: "beam", label: "Beam", unlocked: true, prices: [{ name: "wood", val: 175 }] },
  { name: "slab", label: "Slab", unlocked: true, prices: [{ name: "minerals", val: 250 }] },
  { name: "plate", label: "Plate", unlocked: true, prices: [{ name: "iron", val: 125 }] },
  { name: "steel", label: "Steel", unlocked: true, prices: [{ name: "coal", val: 100 }, { name: "iron", val: 100 }] },
  { name: "parchment", label: "Parchment", unlocked: true, prices: [{ name: "furs", val: 175 }] },
  { name: "manuscript", label: "Manuscript", unlocked: true, prices: [{ name: "culture", val: 400 }, { name: "parchment", val: 25 }] },
  { name: "compedium", label: "Compendium", unlocked: true, prices: [{ name: "science", val: 10000 }, { name: "manuscript", val: 50 }] },
];
const craftByName = (name) => crafts.find((c) => c.name === name);

const buildings = [
  { name: "barn", label: "Barn", unlocked: true, val: 2, prices: [{ name: "wood", val: 75 }], effects: { catnipMax: 5000, woodMax: 200 } },
  { name: "library", label: "Library", unlocked: true, val: 3, prices: [{ name: "wood", val: 25 }], effects: { scienceMax: 250, cultureMax: 25 } },
  { name: "hut", label: "Hut", unlocked: true, val: 2, prices: [{ name: "wood", val: 100 }], effects: { manpowerMax: 75 } },
  {
    name: "amphitheatre",
    label: "Amphitheatre",
    unlocked: true,
    val: 0,
    prices: [{ name: "wood", val: 200 }, { name: "minerals", val: 400 }, { name: "manuscript", val: 50 }],
    effects: { happiness: 0.048, culturePerTickBase: 0.005 },
  },
];

const techs = [
  {
    name: "theology",
    label: "Theology",
    unlocked: true,
    researched: false,
    prices: [{ name: "science", val: 9000 }, { name: "manuscript", val: 35 }],
  },
  { name: "drama", label: "Drama and Poetry", unlocked: true, researched: true, prices: [] },
];

const upgrades = [
  {
    name: "expandedBarns",
    label: "Expanded Barns",
    unlocked: true,
    researched: false,
    prices: [{ name: "wood", val: 500 }, { name: "minerals", val: 250 }, { name: "iron", val: 50 }],
    effects: { barnRatio: 0.75 },
  },
];

const J = (name, title, value) => ({ name, title, unlocked: true, value });
const jobs = [
  J("woodcutter", "Woodcutter", 3),
  J("farmer", "Farmer", 2),
  J("miner", "Miner", 1),
  J("scholar", "Scholar", 2),
  J("hunter", "Hunter", 1),
  J("priest", "Priest", 0),
  J("geologist", "Geologist", 0),
];
const job = (name) => jobs.find((j) => j.name === name);

const kittens = [
  { name: "Ada", rank: 0, job: "farmer", trait: { name: "scientist", title: "Scientist" } },
  { name: "Brio", rank: 1, job: "woodcutter", trait: { name: "engineer", title: "Engineer" } },
  { name: "Caz", rank: 0, job: "miner", trait: { name: "none", title: "None" } },
];

let huntAllCalls = 0;
let promoteCalls = 0;

const village = {
  happiness: 0.92, // ratio — below 100% so mood logic engages
  jobs,
  leader: null,
  sim: {
    kittens,
    removeJob(name, amt) {
      const j = job(name);
      if (j) j.value = Math.max(0, j.value - amt);
    },
    promote() {
      promoteCalls += 1;
    },
  },
  getKittens: () => 10,
  getFreeKittens: () => 1,
  getJobLimit: () => 100000,
  assignJob(j, amt) {
    if (j) j.value += amt;
  },
  makeLeader(kitten) {
    village.leader = kitten;
  },
  promoteKittens() {
    promoteCalls += 1;
    res("gold").value -= 30; // promotion spends gold
  },
  huntAll() {
    huntAllCalls += 1;
    res("furs").value += 200;
    res("manpower").value = 0;
  },
  holdFestival(amt) {
    calendar.festivalDays += 200 * amt;
  },
  getResProduction: () => ({ catnip: 5, wood: 2, minerals: 1.5, science: 1, manpower: 0.5, coal: 0.1, faith: 0.05 }),
  updateResourceProduction() {},
};

const calendar = { festivalDays: 0 };

const perTick = { catnip: -2, wood: 0.5, minerals: 0.4, science: 0.6, culture: 0.2, manpower: 0.5, iron: 0.1, coal: 0.05, faith: 0.01, gold: 0.02 };

const gamePage = {
  resPool: {
    resources,
    get: (name) => res(name),
    payPrices(prices) {
      for (const p of prices) res(p.name).value -= p.val;
    },
  },
  bld: {
    buildingsData: buildings,
    getPrices: (name) => (buildings.find((b) => b.name === name) || {}).prices || [],
  },
  science: {
    techs,
    get: (name) => techs.find((t) => t.name === name),
  },
  workshop: {
    upgrades,
    crafts,
    getCraft: (name) => craftByName(name),
    getCraftPrice: (craft) => (craft && craft.prices) || [],
  },
  village,
  calendar,
  challenges: { isActive: () => false },
  villageTab: { updateTab() {} },
  updateResources() {},
  getEffect: () => 0,
  getResCraftRatio: () => 0,
  getResourcePerTick: (name) => (Number.isFinite(perTick[name]) ? perTick[name] : 0),
  craft(name, amount) {
    const craft = craftByName(name);
    if (!craft || amount <= 0) return false;
    for (const p of craft.prices) {
      if (res(p.name).value < p.val * amount) return false;
    }
    for (const p of craft.prices) res(p.name).value -= p.val * amount;
    res(name).value += amount;
    return true;
  },
};

/* ------------------------------- fake KS ----------------------------------- */

const S = (extra = {}) => ({ enabled: false, ...extra });
const ksSettings = {
  engine: S({ interval: 2000, resources: S() }),
  bonfire: S({ trigger: 0.75, buildings: { barn: S({ trigger: 0.9, max: 0 }) } }),
  science: S({ trigger: 0.5, observe: S(), techs: { theology: S({ trigger: 1 }) } }),
  religion: S({ trigger: 0.2, adore: S(), sacrificeUnicorns: S() }),
  space: S({ trigger: 1 }),
  time: S({ reset: S() }),
  trade: S({ trigger: 0.8 }),
  workshop: S({ crafts: { wood: S({ trigger: 0.95 }), beam: S({ trigger: 0.9 }) } }),
  village: S({
    jobs: { woodcutter: S(), farmer: S() },
    hunt: S({ trigger: 0.98 }),
    holdFestivals: S(),
    electLeader: S(),
    promoteLeader: S(),
    promoteKittens: S({ trigger: 1 }),
  }),
};

let appliedSettings = null;
const kittenScientists = {
  getSettings: () => ksSettings,
  setSettings(s) {
    appliedSettings = s;
  },
  engine: { _timeoutMainLoop: 1, start() {} },
};

/* ------------------------------ run the script ----------------------------- */

const intervalFns = [];
const context = {
  console,
  Date,
  Math,
  JSON,
  Number,
  isFinite,
  document: documentMock,
  localStorage: localStorageMock,
  gamePage,
  kittenScientists,
  setTimeout,
  clearTimeout,
  setInterval: (fn) => {
    intervalFns.push(fn);
    return 0;
  },
  WeakMap,
  Map,
  Set,
  Promise,
  Array,
  Object,
};
context.window = context;
vm.createContext(context);
vm.runInContext(body, context, { filename: "kittens-game-helper.user.js" });

// Let the async bootstrap (waitForKittenScientists → applyProfile + buildPanel)
// finish, then run a few extra ticks by hand.
await new Promise((resolve) => setTimeout(resolve, 100));
const tickFn = intervalFns[0];
if (typeof tickFn === "function") {
  tickFn();
  await new Promise((resolve) => setTimeout(resolve, 20));
  tickFn();
}

/* -------------------------------- assertions ------------------------------- */

const failures = [];
const check = (label, ok) => {
  console.log(`${ok ? "✓" : "✗"} ${label}`);
  if (!ok) failures.push(label);
};

const logText = (localStorageMock.getItem("kgh.log") || "[]").toString();
const panelText = (sel) => {
  // the panel box is the second created element appended to document.body
  for (const child of documentMock.body.children) {
    if (child.selectors && child.selectors.has(sel)) return child.selectors.get(sel).textContent;
  }
  return "";
};

check("script bootstrapped and applied KS settings", appliedSettings != null);
if (appliedSettings) {
  check("KS jobs automation disabled (we manage jobs)", appliedSettings.village.jobs.woodcutter.enabled === false);
  check("KS hunt automation disabled (we manage hunts)", appliedSettings.village.hunt.enabled === false);
  check("KS electLeader disabled (we elect the leader)", appliedSettings.village.electLeader.enabled === false);
  check("KS promoteLeader disabled (we promote on gold overflow)", appliedSettings.village.promoteLeader.enabled === false);
  check("KS promoteKittens stays denied", appliedSettings.village.promoteKittens.enabled === false);
  check("KS festivals stay enabled", appliedSettings.village.holdFestivals.enabled === true);
  check("reset automation stays OFF", appliedSettings.time.reset.enabled === false);
  check("adore (faith reset) stays OFF", appliedSettings.religion.adore.enabled === false);
  check("sacrifice automation stays OFF", appliedSettings.religion.sacrificeUnicorns.enabled === false);
  check("purchase triggers zeroed (buy when affordable)", appliedSettings.bonfire.trigger === 0 && appliedSettings.science.trigger === 0);
  check("zero build limits raised", appliedSettings.bonfire.buildings.barn.max === 1e9);
  check("catnip→wood refining enabled at half-full", appliedSettings.workshop.crafts.wood.enabled === true && appliedSettings.workshop.crafts.wood.trigger === 0.5);
}

check("overflow: capping wood converted into beams", res("beam").value > 60);
check("overflow: surplus furs skimmed into parchment", res("parchment").value > 526 - 1 && res("furs").value < 5000);
check("overflow: luxury cushion kept (furs not drained)", res("furs").value > 100);
check("overflow: science NOT burned below an almost-affordable cap", res("science").value >= 5000);
check("festival: started and actually paid for", calendar.festivalDays > 0 && res("culture").value <= 600 + 50);
check("leader: engineer elected (crafting era beats scientist)", village.leader != null && village.leader.trait.name === "engineer");
check("promotion: overflowing gold spent on kittens", promoteCalls > 0 && res("gold").value < 95);
check("jobs: scholars pulled off capped science", job("scholar").value === 0);
check("jobs: starvation guard reinforced farmers (net catnip < 0)", job("farmer").value >= 3);
check("planning: cap-blocked tech redirected to storage (bottleneck line)", /cap .*blocks the plan|storage/i.test(panelText(".kgh-bottleneck")));
check("planning: plan targets a reachable build, not the blocked tech", !/Theology/.test(panelText(".kgh-plan")));
check("panel: mood/leader line rendered", /Mood \d+%/.test(panelText(".kgh-village")));
check("log: actions recorded", logText.includes("applied"));

if (failures.length) {
  console.error(`\n✗ ${failures.length} smoke check(s) failed`);
  process.exit(1);
}
console.log("\n✓ All smoke checks passed — automations fire against the mocked game.");
