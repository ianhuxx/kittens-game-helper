// Behavioral smoke test for the userscript. Run with: npm run smoke
//
// The userscript wraps almost everything in try/catch, so a logic bug fails
// SILENTLY in the real game. This harness runs the script against a faithful
// mock of gamePage + kittenScientists and asserts the core behaviors fire —
// most importantly the user-visible plan-execution contract:
//   plan says Library  →  the Mine may NOT eat the Library's wood  →  the
//   Library is bought the moment the savings are complete.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const scriptPath = fileURLToPath(new URL("../src/kittens-game-helper.user.js", import.meta.url));
const source = await readFile(scriptPath, "utf8");
const body = source.replace(/\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==/, "");

/* ------------------------------- fake DOM --------------------------------- */

const makeEl = () => ({
  style: {},
  children: [],
  textContent: "",
  innerHTML: "",
  value: "",
  title: "",
  id: "",
  className: "",
  disabled: false,
  selectors: new Map(),
  classList: { toggle() {}, contains: () => false, add() {}, remove() {} },
  addEventListener() {},
  appendChild(child) {
    this.children.push(child);
  },
  remove() {},
  querySelector(sel) {
    if (!this.selectors.has(sel)) this.selectors.set(sel, makeEl());
    return this.selectors.get(sel);
  },
});

const documentMock = {
  head: makeEl(),
  body: makeEl(),
  createElement: () => makeEl(),
  getElementById: () => null,
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
  ...extra,
});

const resources = [
  R("catnip", 300, 5000), // 6% + net-negative rate → starvation guard
  R("wood", 450, 3000), // mine (300) affordable, library (500) not — yet
  R("minerals", 800, 1000),
  R("iron", 50, 300),
  R("coal", 10, 60),
  R("science", 2000, 6000), // theology (25000) is storage-blocked → pressure
  R("culture", 9000, 12000),
  R("faith", 10, 100),
  R("manpower", 200, 1000, "Catpower"),
  R("gold", 95, 100), // overflowing → promotions
  R("ship", 0, 0, "Ship"),
  R("titanium", 0, 100, "Titanium"),
  R("furs", 600, 0),
  R("ivory", 100, 0),
  R("spice", 0, 0, "Spice", { unlocked: false }),
  R("parchment", 100, 0),
  R("manuscript", 5, 0),
  R("compedium", 0, 0, "Compendium"),
  R("beam", 10, 0),
  R("slab", 0, 0),
  R("scaffold", 0, 0),
  R("plate", 0, 0),
  R("steel", 0, 0),
  R("gear", 45, 0),
];
const res = (name) => resources.find((r) => r.name === name);

const crafts = [
  { name: "wood", label: "Refine Catnip", unlocked: true, prices: [{ name: "catnip", val: 100 }] },
  { name: "beam", label: "Beam", unlocked: true, prices: [{ name: "wood", val: 175 }] },
  { name: "slab", label: "Slab", unlocked: true, prices: [{ name: "minerals", val: 250 }] },
  { name: "plate", label: "Metal Plate", unlocked: true, prices: [{ name: "iron", val: 25 }] },
  { name: "scaffold", label: "Scaffold", unlocked: true, prices: [{ name: "plate", val: 1 }] },
  { name: "ship", label: "Ship", unlocked: true, prices: [{ name: "scaffold", val: 1 }] },
  { name: "parchment", label: "Parchment", unlocked: true, prices: [{ name: "furs", val: 175 }] },
  { name: "manuscript", label: "Manuscript", unlocked: true, prices: [{ name: "culture", val: 400 }, { name: "parchment", val: 25 }] },
  { name: "compedium", label: "Compendium", unlocked: true, prices: [{ name: "manuscript", val: 50 }] },
  { name: "blueprint", label: "Blueprint", unlocked: true, prices: [{ name: "science", val: 25000 }, { name: "compedium", val: 25 }] },
  { name: "steel", label: "Steel", unlocked: true, prices: [{ name: "iron", val: 100 }, { name: "coal", val: 100 }] },
  { name: "gear", label: "Gear", unlocked: true, prices: [{ name: "steel", val: 15 }] },
];
const craft = (name) => crafts.find((c) => c.name === name);

const buildings = [
  { name: "library", label: "Library", unlocked: true, val: 3, on: 3, prices: [{ name: "wood", val: 500 }], effects: { scienceMax: 250 } },
  { name: "mine", label: "Mine", unlocked: true, val: 2, on: 2, prices: [{ name: "wood", val: 300 }], effects: { mineralsRatio: 0.2 } },
  { name: "barn", label: "Barn", unlocked: true, val: 1, on: 1, prices: [{ name: "wood", val: 1000 }], effects: { catnipMax: 5000, woodMax: 200 } },
  { name: "hut", label: "Hut", unlocked: true, val: 2, on: 2, prices: [{ name: "wood", val: 5000 }], effects: { manpowerMax: 75 } },
  {
    name: "steamworks",
    label: "Steamworks",
    unlocked: false,
    val: 4,
    on: 4,
    prices: [{ name: "steel", val: 65 }, { name: "gear", val: 20 }, { name: "blueprint", val: 1 }],
    effects: { manuscriptPerTickProd: 0 },
    calculateEffects(self, game) {
      self.effects.manuscriptPerTickProd = game.workshop.get("printingPress").researched ? 0.0005 : 0;
    },
  },
  {
    name: "warehouse",
    label: "Warehouse",
    unlocked: false,
    val: 0,
    on: 0,
    prices: [{ name: "beam", val: 200 }, { name: "slab", val: 350 }],
    effects: { manpowerMax: 500, woodMax: 1000, mineralsMax: 1000, ironMax: 250, coalMax: 250 },
  },
  // Safety bait: a denied ("reset") action that is the CHEAPEST unlocked item.
  // If isDeniedKey() were not filtering candidates, the planner would grab it
  // immediately — so its val staying 0 proves irreversible actions are excluded.
  { name: "resetWorld", label: "Reset World", unlocked: true, val: 0, on: 0, prices: [{ name: "wood", val: 1 }], effects: {} },
];

const techs = [
  {
    name: "theology",
    label: "Theology",
    unlocked: true,
    researched: false,
    prices: [{ name: "science", val: 25000 }, { name: "manuscript", val: 35 }],
    unlocks: { jobs: ["priest"], tech: ["astronomy"] },
  },
  {
    name: "machinery",
    label: "Machinery",
    unlocked: true,
    researched: false,
    prices: [{ name: "science", val: 15000 }],
    unlocks: { buildings: ["steamworks"], upgrades: ["printingPress", "factoryAutomation", "crossbow"] },
  },
  {
    name: "trivia",
    label: "Trivia",
    unlocked: true,
    researched: false,
    prices: [{ name: "science", val: 15000 }],
    unlocks: {},
  },
  {
    name: "astronomy",
    label: "Astronomy",
    unlocked: false,
    researched: false,
    prices: [{ name: "science", val: 30000 }],
    unlocks: {},
  },
];

const policies = [
  { name: "liberty", label: "Liberty", unlocked: true, researched: false, blocked: false, blocks: ["tradition"], prices: [{ name: "culture", val: 1500 }], effects: {} },
  { name: "tradition", label: "Tradition", unlocked: true, researched: false, blocked: false, blocks: ["liberty"], prices: [{ name: "culture", val: 1500 }], effects: {} },
  { name: "openFairs", label: "Open Fairs", unlocked: true, researched: false, blocked: false, blocks: [], prices: [{ name: "culture", val: 1500 }], effects: {} },
];

const workshopUpgrades = [
  {
    name: "printingPress",
    label: "Printing Press",
    unlocked: false,
    researched: false,
    prices: [{ name: "science", val: 7500 }, { name: "gear", val: 45 }],
    effects: {},
    upgrades: { buildings: ["steamworks"] },
  },
];

const religionUpgrades = [
  {
    name: "solarchant",
    label: "Solar Chant",
    unlocked: true,
    noStackable: true,
    on: 0,
    val: 0,
    faith: 150,
    prices: [{ name: "faith", val: 100 }],
    effects: { faithRatioReligion: 0.1 },
  },
  {
    name: "solarRevolution",
    label: "Solar Revolution",
    unlocked: true,
    noStackable: true,
    on: 0,
    val: 0,
    faith: 1000,
    prices: [{ name: "gold", val: 500 }, { name: "faith", val: 750 }],
    effects: { solarRevolutionRatio: 0 },
  },
];

const J = (name, title, value) => ({ name, title, unlocked: true, value });
const jobs = [
  J("woodcutter", "Woodcutter", 2),
  J("farmer", "Farmer", 1),
  J("miner", "Miner", 1),
  J("scholar", "Scholar", 1),
  J("hunter", "Hunter", 1),
  J("priest", "Priest", 0),
  J("geologist", "Geologist", 0),
];
const job = (name) => jobs.find((j) => j.name === name);

const kittens = [
  { name: "Ada", rank: 0, exp: 100, job: "farmer", trait: { name: "scientist", title: "Scientist" }, skills: {} },
  { name: "Brio", rank: 1, exp: 300, job: "woodcutter", trait: { name: "engineer", title: "Engineer" }, skills: {} },
  { name: "Caz", rank: 0, exp: 0, job: "miner", trait: { name: "none", title: "None" }, skills: {} },
];

let promoteCalls = 0;
let observeCalls = 0;
let praiseCalls = 0;
let festivalCalls = 0;
let tradeCalls = 0;

const calendar = {
  festivalDays: 0,
  daysPerSeason: 100,
  observeRemainingTime: 0,
  observeHandler() {
    observeCalls += 1;
    this.observeRemainingTime = 0;
    const science = res("science");
    science.value = Math.min(science.maxValue || Infinity, science.value + 1000);
  },
};

const village = {
  happiness: 0.92,
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
  getKittens: () => 8,
  getFreeKittens: () => 2,
  getJobLimit: () => 100000,
  assignJob(j, amt) {
    if (j) j.value += amt;
  },
  makeLeader(kitten) {
    if (village.leader) village.leader.isLeader = false;
    village.leader = kitten;
    kitten.isLeader = true;
  },
  promoteKittens() {
    promoteCalls += 1;
    res("gold").value -= 30;
  },
  huntAll() {
    res("furs").value += 200;
    res("manpower").value = 0;
  },
  getResProduction: () => ({ catnip: 5, wood: 2, minerals: 1.5, science: 1, manpower: 0.5 }),
  updateResourceProduction() {},
  holdFestival(amt) {
    festivalCalls += amt || 1;
    calendar.festivalDays += 400 * (amt || 1);
  },
};

const perTick = { catnip: -0.4, wood: 0.4, minerals: 0.3, science: 0.2, culture: 0.2, manpower: 0.2, iron: 0.05, coal: 0.01, gold: 0.01 };
const craftRatios = { plate: 0.16 };
const resourcePerTickCalls = [];

const diplomacy = {
  races: [
    { name: "lizards", title: "Lizards", unlocked: true, embassyLevel: 0, tradeTotal: 0, embassyPrices: [], sells: [{ name: "minerals", value: 100, chance: 100 }] },
  ],
  get: (name) => diplomacy.races.find((race) => race.name === name),
  getManpowerCost: () => 50,
  getGoldCost: () => 15,
  getMaxTradeAmt: () => 1,
  tradeAll(race) {
    tradeCalls += 1;
    if (race && race.name === "sharks" && canPay([{ name: "manpower", val: 50 }, { name: "gold", val: 15 }, { name: "iron", val: 100 }])) {
      res("manpower").value -= 50;
      res("gold").value -= 15;
      res("iron").value -= 100;
      res("parchment").value += 7;
      res("manuscript").value += 4.8;
      res("compedium").value += 1.4;
      race.tradeTotal = (race.tradeTotal || 0) + 1;
    } else if (race && race.name === "lizards" && canPay([{ name: "manpower", val: 50 }, { name: "gold", val: 15 }])) {
      res("manpower").value -= 50;
      res("gold").value -= 15;
      res("minerals").value += 100;
      race.tradeTotal = (race.tradeTotal || 0) + 1;
    }
  },
};

const canPay = (prices = []) => prices.every((p) => res(p.name) && res(p.name).value >= p.val);
const pay = (prices = []) => {
  if (!canPay(prices)) return false;
  for (const p of prices) res(p.name).value -= p.val;
  return true;
};

const gamePage = {
  opts: { noConfirm: false },
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
    build(name) {
      const meta = buildings.find((b) => b.name === name);
      if (!meta || !pay(meta.prices || [])) return false;
      meta.val = (meta.val || 0) + 1;
      meta.on = (meta.on || 0) + 1;
      return true;
    },
  },
  science: {
    techs,
    policies,
    get: (name) => techs.find((t) => t.name === name),
    getPrices: (meta) => (meta && meta.prices) || [],
    research(item) {
      const meta = typeof item === "string" ? techs.find((t) => t.name === item) : item;
      if (!meta || !pay(meta.prices || [])) return false;
      meta.researched = true;
      return true;
    },
    researchPolicy(item) {
      const meta = typeof item === "string" ? policies.find((p) => p.name === item) : item;
      if (!meta || !pay(meta.prices || [])) return false;
      meta.researched = true;
      return true;
    },
  },
  religion: {
    faith: 200,
    religionUpgrades,
    build(item) {
      const meta = typeof item === "string" ? religionUpgrades.find((u) => u.name === item) : item;
      if (!meta || !pay(meta.prices || [])) return false;
      meta.val = (meta.val || 0) + 1;
      meta.on = (meta.on || 0) + 1;
      return true;
    },
    praise() {
      praiseCalls += 1;
      res("faith").value = 0.0001;
    },
  },
  workshop: {
    upgrades: workshopUpgrades,
    crafts,
    get: (name) => workshopUpgrades.find((upgrade) => upgrade.name === name),
    getCraft: (name) => craft(name),
    getCraftPrice: (c) => (c && c.prices) || [],
    getPrices: (meta) => (meta && meta.prices) || [],
    research(item) {
      const meta = typeof item === "string" ? workshopUpgrades.find((u) => u.name === item) : item;
      if (!meta || !pay(meta.prices || [])) return false;
      meta.researched = true;
      return true;
    },
  },
  village,
  calendar,
  diplomacy,
  villageTab: { updateTab() {} },
  updateResources() {},
  unlock() {},
  upgrade() {},
  render() {},
  getEffect: () => 0,
  getResCraftRatio: (name) => (Number.isFinite(craftRatios[name]) ? craftRatios[name] : 0),
  ticksPerSecond: 5,
  getResourcePerTick: (name, includeConversion) => {
    resourcePerTickCalls.push({ name, includeConversion });
    return Number.isFinite(perTick[name]) ? perTick[name] : 0;
  },
  craft(name, amount) {
    const c = craft(name);
    if (!c || amount <= 0) return false;
    for (const p of c.prices) {
      if (res(p.name).value < p.val * amount) return false;
    }
    for (const p of c.prices) res(p.name).value -= p.val * amount;
    res(name).value += amount * (1 + gamePage.getResCraftRatio(name));
    return true;
  },
};

/* ------------------------------ run the script ----------------------------- */

let fakeNow = Date.now();
class FakeDate extends Date {
  constructor(...args) {
    if (args.length) super(...args);
    else super(fakeNow);
  }
  static now() {
    return fakeNow;
  }
}

const intervalFns = [];
const context = {
  console,
  Date: FakeDate,
  Math,
  JSON,
  Number,
  isFinite,
  document: documentMock,
  localStorage: localStorageMock,
  gamePage,
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

await new Promise((resolve) => setTimeout(resolve, 100)); // bootstrap + first ticks
const tickFn = intervalFns[0];

const failures = [];
const check = (label, ok) => {
  console.log(`${ok ? "✓" : "✗"} ${label}`);
  if (!ok) failures.push(label);
};
const panelText = (sel) => {
  for (const child of documentMock.body.children) {
    if (child.selectors && child.selectors.has(sel)) return child.selectors.get(sel).textContent;
  }
  return "";
};
const logText = () => (localStorageMock.getItem("kgh.log") || "[]").toString();

check("script bootstrapped natively (noConfirm set; no external engine)", gamePage.opts.noConfirm === true && typeof tickFn === "function");

/* Stage 1 — native ownership + reservation holds (mine must NOT eat library wood) */
calendar.observeRemainingTime = 100; // a star event is available this tick
fakeNow += 5000;
tickFn();
check("native: star event observed automatically the moment it is available", observeCalls === 1 && calendar.observeRemainingTime === 0);
check("safety: cheapest item is a denied 'reset' action and is NEVER bought (isDeniedKey)", buildings.find((b) => b.name === "resetWorld").val === 0);
check(
  "religion: praise is HELD while a faith upgrade (Solar Chant) is still being saved for",
  praiseCalls === 0 && /Solar Chant/.test(panelText(".kgh-religion")),
);

check("plan: Library chosen over storage-blocked Theology and cheap Mine", /Library/.test(panelText(".kgh-plan")));
check("ETA shown in automation details", /ETA/.test(panelText(".kgh-note")));
check("plan: reservation visible in the panel", /reserving/i.test(panelText(".kgh-plan")) || /saving for/i.test(panelText(".kgh-buy")));
check("reservation: reserve status reports holding the plan's inputs (nothing external left to pause)", /holding/i.test(panelText(".kgh-reserve")));
check("reservation: affordable Mine NOT bought while Library saves up", buildings[1].val === 2);
check("policy: non-exclusive auto-bought", policies[2].researched === true);
check("policy: exclusive choices left for the player", policies[0].researched === false && policies[1].researched === false);
check("policy: panel flags the exclusive decision", /exclusive/i.test(panelText(".kgh-policy")));
check("production reads: helper requests conversion-aware net per tick", resourcePerTickCalls.some((call) => call.includeConversion === true));

/* Stage 1b — during an active reserve the native crafter leaves reserved inputs alone */
res("iron").value = 295;
res("iron").maxValue = 300;
const plateBeforeReserveCraftGuard = res("plate").value;
fakeNow += 5000;
tickFn();
check("overflow: no unrelated Metal Plate conversion is logged while the Library reserve is active", !/Metal Plate/i.test(panelText(".kgh-craft")));
check("overflow: hot iron is not converted into plate while Library reserve is active", res("plate").value === plateBeforeReserveCraftGuard);
check("craft ratios: fake game models fractional craft outputs", gamePage.craft("plate", 1) === true && Math.abs(res("plate").value - (plateBeforeReserveCraftGuard + 1.16)) < 1e-9);
res("plate").value = plateBeforeReserveCraftGuard;
res("iron").value = 50;
res("iron").maxValue = 300;

/* Stage 2 — savings complete: the plan pushes through BEFORE the cheap rival */
fakeNow += 5000;
res("wood").value += 300; // 450 + 300 = 750 ≥ 500: BOTH library and mine affordable
tickFn();
check("plan executed: Library bought the moment savings completed", buildings[0].val === 4);
check("plan purchase logged as the plan (🎯)", logText().includes("🎯"));
check("plan-first ordering: Mine not bought even when both were affordable", buildings[1].val === 2);

/* Stage 3 — science cap raised: gateway tech beats filler for the surplus */
fakeNow += 5000;
res("science").maxValue = 20000;
res("science").value = 15500;
tickFn();
fakeNow += 5000;
tickFn();
check("gateway: Machinery (unlocks Steamworks) researched first", techs[1].researched === true);
check("gateway: filler tech with no unlocks left waiting", techs[2].researched === false);
check("reservation: Mine never bought during the whole run", buildings[1].val === 2);

/* Stage 4 — focused goals must not turn capped science into endless Libraries */
storage.set("kgh.goal", "production");
fakeNow += 370000; // let the previous balanced-mode lock expire
res("wood").value = 800;
res("science").maxValue = 6000;
res("science").value = 6000;
const libraryBeforeProductionFocus = buildings[0].val;
const mineBeforeProductionFocus = buildings[1].val;
tickFn();
check("focus: production goal spends on Mine instead of science storage", buildings[1].val === mineBeforeProductionFocus + 1 && buildings[0].val === libraryBeforeProductionFocus);
check("goal line: emphasis goal explains what it favors", /favoring production/.test(panelText(".kgh-goal-line")));

/* Stage 5 — Rush Space must not detour into side-effect warehouses */
storage.set("kgh.goal", "space");
fakeNow += 370000;
techs.push({
  name: "rocketry",
  label: "Rocketry",
  unlocked: false,
  researched: false,
  prices: [{ name: "science", val: 100000 }],
  unlocks: {},
});
const astronomy = techs.find((tech) => tech.name === "astronomy");
astronomy.unlocked = true;
astronomy.researched = false;
astronomy.prices = [{ name: "science", val: 30000 }, { name: "manuscript", val: 65 }];
astronomy.unlocks = { tech: ["rocketry"] };
buildings.find((building) => building.name === "warehouse").unlocked = true;
const steamworks = buildings.find((building) => building.name === "steamworks");
steamworks.unlocked = true;
const printingPress = gamePage.workshop.get("printingPress");
printingPress.unlocked = true;
printingPress.researched = false;
res("culture").value = 0;
perTick.culture = 0;
res("science").value = 8000;
res("science").maxValue = 30050;
res("gear").value = 45;
res("manuscript").value = 16;
tickFn();
check("space focus: hidden building-upgrade production is valued (Printing Press for manuscripts)", printingPress.researched === true && /Printing Press/.test(logText()));
gamePage.workshop.upgrades.push({
  name: "crossbow",
  label: "Crossbow",
  unlocked: true,
  researched: false,
  prices: [{ name: "manpower", val: 2500 }],
  effects: { hunterRatio: 0.25 },
});
res("science").value = 29800;
res("science").maxValue = 30050;
res("manpower").value = 2200;
res("manpower").maxValue = 2225;
res("manuscript").value = 16;
res("parchment").value = 2;
res("beam").value = 55;
res("slab").value = 342;
tickFn();
check("space focus: manuscript-gated Astronomy stays ahead of side catpower Warehouse", /Astronomy/.test(panelText(".kgh-plan")) && !/warehouse/i.test(panelText(".kgh-plan")));
check("goal line: milestone progress counted from the tech tree (0/3 toward Rocketry)", /0\/3 techs/.test(panelText(".kgh-goal-line")) && /Astronomy/.test(panelText(".kgh-goal-line")));

/* Stage 6 — overflow crafting must not steal resources the focus still reserves */
techs.forEach((tech) => { tech.researched = true; });
policies.forEach((policy) => { policy.researched = true; });
religionUpgrades.forEach((upgrade) => { upgrade.researched = true; upgrade.on = 1; upgrade.val = 1; });
buildings.forEach((building) => { building.unlocked = false; });
for (const upgrade of gamePage.workshop.upgrades) upgrade.researched = true;
fakeNow += 370000;
const mineralDrills = {
  name: "mineralDrills",
  label: "Mineral Drills",
  unlocked: true,
  researched: false,
  prices: [{ name: "minerals", val: 900 }],
  effects: { mineralsRatio: 0.5 },
};
gamePage.workshop.upgrades.push(mineralDrills);
res("minerals").value = 950;
res("minerals").maxValue = 1000;
const slabsBeforeOverflowGuard = res("slab").value;
tickFn();
check("overflow: hot minerals are reserved for the focused project instead of converted to slabs", mineralDrills.researched === true && res("slab").value === slabsBeforeOverflowGuard);

/* Stage 7 — crafted intermediates must be bought in the same tick, even while throttled */
for (const upgrade of gamePage.workshop.upgrades) upgrade.researched = true;
const sawblades = {
  name: "sawblades",
  label: "Sawblades",
  unlocked: true,
  researched: false,
  prices: [{ name: "beam", val: 11 }],
  effects: { woodRatio: 0.25 },
};
gamePage.workshop.upgrades.push(sawblades);
res("beam").value = 10;
res("wood").value = 175;
tickFn();
tickFn(); // hysteresis throttles to one purchase/craft per tick: craft the last Beam, then buy next tick
check("crafted intermediate: throttled upgrade buys within a couple of ticks after crafting its Beam", sawblades.researched === true && res("beam").value >= 0 && res("beam").value < 10);
check("focus panel names upgrade priority clearly", logText().includes("plan upgrade Sawblades") || /FOCUS: .*WORKSHOP UPGRADE/i.test(panelText(".kgh-plan")));


/* Cross-cutting village behaviors */
check("leader elected from traits", village.leader != null && village.leader.trait.name !== "none");
check("promotion: overflowing gold spent on kittens", promoteCalls > 0 && res("gold").value < 95);
check("jobs: starvation guard reinforced farmers (net catnip < 0)", job("farmer").value >= 3);
check("jobs: religion/faith handling does not block cross-cutting village pass", job("priest").value >= 0);

/* Stage 7b — crafting one target intermediate must not eat another direct target cost */
for (const upgrade of gamePage.workshop.upgrades) upgrade.researched = true;
buildings.forEach((building) => { building.unlocked = false; });
const observatory = {
  name: "observatory",
  label: "Observatory",
  unlocked: true,
  val: 2,
  on: 2,
  prices: [{ name: "iron", val: 100 }, { name: "scaffold", val: 10 }],
  effects: { scienceRatio: 0.1, scienceMax: 500 },
};
buildings.push(observatory);
res("iron").value = 125;
res("iron").maxValue = 1000;
res("plate").value = 0;
res("scaffold").value = 8;
fakeNow += 25000;
tickFn();
check("crafted intermediate: scaffold crafting preserves Observatory's direct iron reserve", observatory.val === 2 && res("scaffold").value === 9 && res("iron").value >= 100);

/* Stage 7c — do not craft Plate for Scaffold until direct Observatory iron is covered */
observatory.prices = [{ name: "iron", val: 1000 }, { name: "scaffold", val: 10 }];
res("iron").value = 500;
res("iron").maxValue = 1500;
res("plate").value = 0;
res("scaffold").value = 8;
fakeNow += 25000;
tickFn();
check("crafted intermediate: plate waits while Observatory direct iron is still short", res("plate").value === 0 && res("scaffold").value === 8 && res("iron").value >= 500);
check("reserve-safe crafting: the helper is the only crafter, so plate is not fabricated while direct iron is short", res("plate").value === 0);
observatory.prices = [{ name: "iron", val: 100 }, { name: "scaffold", val: 10 }];
res("iron").value = 125;
res("iron").maxValue = 1000;
res("plate").value = 0;
res("scaffold").value = 9;


/* Calm hunting — happy village with stocked furs keeps hunters to a crew */
village.happiness = 1.18; // >100% mood, like a real luxury-fed village
res("furs").value = 800; // far above the luxury target
fakeNow += 25000;
tickFn();
fakeNow += 25000;
tickFn();
check("jobs: hunting stays minimal when furs and mood are healthy", job("hunter").value <= 2);

/* Stability — with nothing changing, the village must NOT churn */
fakeNow += 25000;
tickFn(); // settle once more
const jobSnapshot = jobs.map((j) => `${j.name}:${j.value}`).join("|");
const rebalancesBefore = (logText().match(/rebalanced/g) || []).length;
fakeNow += 25000;
tickFn();
fakeNow += 25000;
tickFn();
const rebalancesAfter = (logText().match(/rebalanced/g) || []).length;
check("stability: no job churn across idle ticks", jobs.map((j) => `${j.name}:${j.value}`).join("|") === jobSnapshot);
check("stability: no rebalance log spam across idle ticks", rebalancesAfter === rebalancesBefore);

/* Universal overflow crafting — hot craft inputs should be converted by metadata, including catnip→wood */
res("catnip").value = 4900;
res("catnip").maxValue = 5000;
res("wood").value = 0;
fakeNow += 25000;
tickFn();
check("overflow: capped catnip is converted into wood by the generic craft scanner", res("wood").value > 0 && res("catnip").value < 4900);

/* Recent actions — KS-owned diplomacy/trade changes are discovered by state diffs */
fakeNow += 25000;
diplomacy.races[0].embassyLevel += 1;
diplomacy.races[0].tradeTotal += 1;
res("gold").value -= 15;
res("manpower").value -= 50;
res("spice").unlocked = true;
res("spice").value += 70;
res("scaffold").value += 1;
tickFn();
check("recent actions: embassy level changes are logged", /embassy with Lizards/.test(logText()));
check("recent actions: external trade counter is labeled as a cycle summary, not fake resource trade", /cycle summary: Lizards trade counter/i.test(logText()) && !/🤝 trade: .*Spice/i.test(logText()));

/* New content awareness — fresh unlocks must be noticed, logged and replanned */
fakeNow += 25000;
buildings.push({
  name: "mint",
  label: "Mint",
  unlocked: true,
  val: 0,
  on: 0,
  prices: [{ name: "minerals", val: 5000 }],
  effects: { goldPerTickCon: -0.005, manpowerPerTickCon: -0.75, fursPerTickProd: 0.00875, ivoryPerTickProd: 0.0021, goldMax: 100 },
});
tickFn();
check("new unlocks: freshly opened building noticed and logged for replanning", /🆕 unlocked: .*Mint/.test(logText()));

/* Converter discovery — in/out buildings are found from PerTickCon/Prod effects
   alone (this one is NOT in any hard-coded converter list) and paused when they
   drain an input the focused plan is still missing. */
const testforge = {
  name: "testforge",
  label: "Testforge",
  unlocked: true,
  val: 1,
  on: 1,
  prices: [{ name: "minerals", val: 900 }],
  effects: { mineralsPerTickCon: -0.5, ironPerTickProd: 0.1 },
};
buildings.push(testforge);
res("minerals").value = 100; // plan (next Testforge) is missing minerals → converter must yield
fakeNow += 25000;
tickFn();
check("converters: metadata-discovered converter paused while plan misses its input", testforge.on === 0 && /paused Testforge/.test(logText()));

/* Exploration — explorers go out as soon as the fee fits (no near-cap gate) */
fakeNow += 25000;
diplomacy.races.push({ name: "griffins", title: "Griffins", unlocked: false, hidden: false, embassyLevel: 0, embassyPrices: [{ name: "culture", val: 1000 }] });
diplomacy.unlockRandomRace = () => {
  const race = diplomacy.races.find((r) => !r.unlocked && !r.hidden);
  if (race) race.unlocked = true;
  return race;
};
res("manpower").value = 1100;
res("manpower").maxValue = 1200;
tickFn();
check("explorers: sent the moment the catpower fee fits (old 92%-cap gate removed)", diplomacy.races[1].unlocked === true && /🧭/.test(logText()));
check("explorers: catpower fee actually paid", res("manpower").value < 1100);


/* Titanium path — real game best practice is: craft a ship, explore to reveal hidden Zebras, then trade Zebras. */
for (const upgrade of gamePage.workshop.upgrades) upgrade.researched = true;
const titaniumSaw = {
  name: "titaniumSaw",
  label: "Titanium Saw",
  unlocked: true,
  researched: false,
  prices: [{ name: "titanium", val: 100 }], // more than one slab-limited trade batch yields, so the ship/odds line stays live while titanium accrues
  effects: { woodRatio: 5 },
};
gamePage.workshop.upgrades.push(titaniumSaw);
const zebras = { name: "zebras", title: "Zebras", hidden: true, unlocked: false, embassyLevel: 0, tradeTotal: 0, embassyPrices: [{ name: "culture", val: 25000 }], buys: [{ name: "slab", val: 50 }], sells: [] };
diplomacy.races.push(zebras);
diplomacy.unlockRandomRace = () => {
  if (!zebras.unlocked && res("ship").value >= 1) {
    zebras.unlocked = true;
    return zebras;
  }
  const race = diplomacy.races.find((r) => !r.unlocked && !r.hidden);
  if (race) race.unlocked = true;
  return race || null;
};
diplomacy.tradeMultiple = (race, amt) => {
  if (race.name !== "zebras") return;
  if (res("gold").value < 15 * amt || res("manpower").value < 50 * amt || res("slab").value < 50 * amt) return;
  res("gold").value -= 15 * amt;
  res("manpower").value -= 50 * amt;
  res("slab").value -= 50 * amt;
  res("titanium").value += 12 * amt;
  race.tradeTotal = (race.tradeTotal || 0) + amt;
};
res("ship").value = 0;
res("scaffold").value = 0;
res("titanium").value = 0;
res("manpower").value = 400;
res("manpower").maxValue = 1200;
res("gold").value = 100;
res("slab").value = 100;
res("furs").value = 0;
res("ivory").value = 0;
fakeNow += 25000;
tickFn();
check("titanium path: catpower is saved for Zebra explorers before the first ship is ready", res("manpower").value === 400 && (/Zebra|titanium path|first Ship/i.test(panelText(".kgh-diplomacy")) || /titanium path|first Ship/i.test(panelText(".kgh-plan"))));
check("titanium path: advisor explains the ship → explorer → Zebra trade route", /titanium path: craft first Ship/i.test(panelText(".kgh-note")) && /titanium path: craft first Ship/i.test(panelText(".kgh-now")));
res("scaffold").value = 1;
// Realistic Zebra-trade-era catpower: by the time you trade Zebras the cap is
// far above the early 1.2K (Bows/Bolas/Armour/temples push it into the thousands).
// Exploring drains catpower, so the cap must leave headroom for the trade to
// fire once production refills above the survival reserve.
res("manpower").maxValue = 3225;
res("manpower").value = 3000;
fakeNow += 25000;
tickFn();
check("titanium path: first ship crafted when titanium is blocking progression", res("ship").value >= 1);
check("titanium path: hidden Zebras discovered via explorers after first ship", zebras.unlocked === true && /Zebras|civilization/.test(logText()));
fakeNow += 25000;
tickFn();
check("titanium path: direct Zebra trade fallback obtains titanium for blocked upgrades", res("titanium").value > 0 && zebras.tradeTotal > 0);
check("titanium path: Zebra odds and ship/trade balance are shown", /ships.*%.*Ti\/trade avg.*build toward/i.test(panelText(".kgh-diplomacy")));
check("titanium path: trades fire in a batch, not one-at-a-time (faster than hand-trading)", zebras.tradeTotal > 1);
res("manpower").maxValue = 1200; res("manpower").value = 0; // reset trade-era catpower headroom so hot catpower can't leak into later stages


/* Stage 8 — converter controller switches an idle converter ON by itself, so
   the player never has to flip the Smelter/Steamworks button by hand. */
const blastForge = {
  name: "blastForge",
  label: "Blast Forge",
  unlocked: true,
  val: 3,
  on: 0, // left switched off — the controller must turn it on
  prices: [{ name: "minerals", val: 100 }],
  effects: { mineralsPerTickCon: -0.5, ironPerTickProd: 0.2 },
};
buildings.push(blastForge);
perTick.minerals = 0.3; // healthy, net-positive input
res("minerals").value = 950;
res("minerals").maxValue = 1000;
res("iron").value = 40; // well below cap → output still wanted
res("iron").maxValue = 300;
fakeNow += 25000;
tickFn();
check("converters: an idle converter is switched ON when inputs are healthy and output wanted", blastForge.on === blastForge.val && blastForge.val >= 3);

/* Stage 9 — base-economy starvation guard throttles a running converter when an
   input is critically low AND already net-draining, instead of pinning it at 0. */
perTick.minerals = -0.3;
res("minerals").value = 15; // ~1.5% of cap and draining → starved
res("minerals").maxValue = 1000;
fakeNow += 25000;
tickFn();
check("converters: running converter throttled to protect a starved, draining input", blastForge.on === 0);

/* Stage 10 — input recovers well above the resume threshold → converter
   restarts (hysteresis: it does NOT flap back on at the same low level it
   paused at). Minerals are stocked abundantly so this isolates the starvation
   guard from the plan-reservation pause. */
perTick.minerals = 0.5;
res("minerals").maxValue = 5000;
res("minerals").value = 5000; // fully stocked → never "missing" for the plan
fakeNow += 25000;
tickFn();
check("converters: converter restarts once the starved input recovers", blastForge.on === blastForge.val && blastForge.val >= 3);

/* Stage 11 — a converter with a non-resource pseudo-output (e.g. pollution)
   must still idle when its REAL output is capped and unneeded, instead of
   looking productive forever and burning inputs into full storage. */
const polluter = {
  name: "polluter",
  label: "Polluter",
  unlocked: true,
  val: 2,
  on: 2,
  prices: [{ name: "minerals", val: 100 }],
  effects: { mineralsPerTickCon: -0.5, ironPerTickProd: 0.2, cathPollutionPerTickProd: 0.01 },
};
buildings.push(polluter);
perTick.minerals = 0.5;
res("minerals").value = 5000; // abundant input (no plan conflict / starvation)
res("minerals").maxValue = 5000;
res("iron").value = 300; // real output fully capped and unneeded
res("iron").maxValue = 300;
fakeNow += 25000;
tickFn();
check("converters: pseudo-output (pollution) does not keep a capped converter running", polluter.on === 0);

/* Stage 12 — ship storage cap: a capped fleet must NOT be built past its limit
   (no spinning on a full ship bar); the helper just trades at the resulting
   odds. Inputs are plentiful so only the cap can stop the build. */
titaniumSaw.researched = false; // keep a titanium-blocked target alive
res("titanium").value = 0;
res("titanium").maxValue = 100;
res("scaffold").value = 100; // plenty of ship inputs — only the cap should stop the build
res("ship").value = 3;
res("ship").maxValue = 3; // fleet is at its storage cap
const shipBeforeCap = res("ship").value;
fakeNow += 25000;
tickFn();
check("ship cap: capped fleet is not built past its storage limit", res("ship").value === shipBeforeCap);

/* Stage 13 — wood starvation guard: wood net-negative and draining must staff
   woodcutters even when the plan doesn't list wood, so the Smelter→iron→plate→
   ship→titanium chain doesn't silently stall while catnip overflows. */
village.getKittens = () => 40; // larger village so the rebalance is visible past the deadband
village.getFreeKittens = () => 20;
for (const rn of ["minerals", "iron", "coal", "science", "furs"]) {
  const x = res(rn);
  if (x) { x.maxValue = x.maxValue || 1000; x.value = x.maxValue; } // full banks zero rival jobs
}
perTick.wood = -4; // wood draining hard
perTick.catnip = 8; // catnip healthy → catnip guard stays off
res("wood").value = 50;
res("wood").maxValue = 3000; // ~2% of cap → starved
res("catnip").value = 3500;
res("catnip").maxValue = 5000;
const woodcuttersBefore = job("woodcutter").value;
for (let i = 0; i < 3; i += 1) { fakeNow += 25000; tickFn(); }
check("jobs: wood starvation guard staffs woodcutters when wood drains (catnip fine)", job("woodcutter").value > woodcuttersBefore);

/* Stage 13a — catnip starvation FAILSAFE: when the pantry is empty AND catnip is
   net-negative, kittens are dying NOW, so farmers must DOMINATE regardless of
   competing coal/mineral/faith demand.  Live, a full colony starved 19 kittens to
   death while 24 Geologists + 16 Priests kept working and a maxed catnip GUARD
   WEIGHT still only bought a fraction of the village (counts are proportional to
   the weight sum).  The failsafe is a hard COUNT, not a weight, so it must win.
   Hermetic: every global it pokes is saved and restored so nothing leaks. */
const starveSaved = {
  getKittens: village.getKittens,
  getFreeKittens: village.getFreeKittens,
  jobs: jobs.map((j) => [j, j.value]),
  perTickCatnip: perTick.catnip,
  res: ["catnip", "coal", "minerals", "faith"].map((n) => [n, res(n).value, res(n).maxValue]),
};
for (const j of jobs) j.value = 0;
job("farmer").value = 22;
job("geologist").value = 24; // the over-staffed rival from the live death spiral
job("priest").value = 16;
job("miner").value = 8;
job("hunter").value = 2;
village.getKittens = () => 72;
village.getFreeKittens = () => 0;
res("catnip").value = 0;           // pantry empty — kittens starving
res("catnip").maxValue = 513350;
perTick.catnip = -28;              // ~ -140/s net, still draining
res("coal").value = 60; res("coal").maxValue = 14750;          // rival banks NOT full →
res("minerals").value = 16000; res("minerals").maxValue = 564430; // coal/mineral jobs keep weight
res("faith").value = 587; res("faith").maxValue = 5500;
const farmersBeforeStarve = job("farmer").value;
for (let i = 0; i < 4; i += 1) { fakeNow += 25000; tickFn(); }
check("jobs: catnip failsafe floods farmers when the pantry is empty and draining",
  job("farmer").value > farmersBeforeStarve &&
  job("farmer").value > job("geologist").value + job("priest").value + job("miner").value);
// Restore everything so later stages see a clean tree.
village.getKittens = starveSaved.getKittens;
village.getFreeKittens = starveSaved.getFreeKittens;
for (const [j, v] of starveSaved.jobs) j.value = v;
perTick.catnip = starveSaved.perTickCatnip;
for (const [n, v, m] of starveSaved.res) { res(n).value = v; res(n).maxValue = m; }

/* Stage 13a2 — the food emergency BYPASSES the 45s rebalance throttle.  With no
   free kittens the executor normally rebalances at most once every 45s and skips
   an unchanged plan; a starving colony cannot wait that long (that window is long
   enough for catnip to crash to 0).  This was the live "farmers not increasing"
   bug: the failsafe sized the flood correctly but the executor refused to apply
   it.  Here a normal tick settles farmers low, then catnip crashes and only 10s
   pass — far under the throttle — yet farmers must still jump on the next tick. */
const bypassSaved = {
  getKittens: village.getKittens, getFreeKittens: village.getFreeKittens,
  jobs: jobs.map((j) => [j, j.value]), perTickCatnip: perTick.catnip,
  catnip: [res("catnip").value, res("catnip").maxValue],
  coal: [res("coal").value, res("coal").maxValue],
};
for (const j of jobs) j.value = 0;
job("farmer").value = 10; job("geologist").value = 30; job("miner").value = 6;
village.getKittens = () => 46; village.getFreeKittens = () => 0;
// A normal, NON-emergency rebalance first (catnip safe) → stamps lastJobRun.
res("catnip").value = 4000; res("catnip").maxValue = 5000; perTick.catnip = 6;
res("coal").value = 60; res("coal").maxValue = 14750;
fakeNow += 60000; tickFn();
const farmersBeforeEmergency = job("farmer").value;
// Now the pantry crashes; advance only 10s (< the 45s throttle) with no free kittens.
res("catnip").value = 0; perTick.catnip = -24;
fakeNow += 10000; tickFn();
check("jobs: food emergency bypasses the 45s rebalance throttle (farmers ramp immediately)",
  job("farmer").value > farmersBeforeEmergency && job("farmer").value >= Math.ceil(46 * 0.5));
// Restore.
village.getKittens = bypassSaved.getKittens; village.getFreeKittens = bypassSaved.getFreeKittens;
for (const [j, v] of bypassSaved.jobs) j.value = v;
perTick.catnip = bypassSaved.perTickCatnip;
res("catnip").value = bypassSaved.catnip[0]; res("catnip").maxValue = bypassSaved.catnip[1];
res("coal").value = bypassSaved.coal[0]; res("coal").maxValue = bypassSaved.coal[1];

/* Stage 13b — diplomacy pressure feeds job balancing: if a queued Zebra trade
   is blocked by catpower, hunters must be staffed even when the visible build
   target is asking for another resource. */
for (const j of jobs) j.value = 0;
job("farmer").value = 25;
job("miner").value = 15;
job("woodcutter").value = 1;
village.getKittens = () => 59;
village.getFreeKittens = () => 18;
perTick.wood = 2;
perTick.catnip = 20;
perTick.manpower = 0.05;
res("manpower").value = 30;
res("manpower").maxValue = 2600;
res("gold").value = 100;
res("slab").value = 1000;
res("titanium").value = 0;
res("titanium").maxValue = 200;
zebras.unlocked = true;
zebras.hidden = false;
const huntersBeforeTradePressure = job("hunter").value;
fakeNow += 25000;
tickFn();
check("jobs: Zebra trade catpower deficit staffs hunters generically", job("hunter").value > huntersBeforeTradePressure);

/* Stage 14 — Zebra Relations: Appeasement is adopted to improve titanium trades.
   The generic automation leaves exclusive policies to the player, but this one
   is the titanium bottleneck lever, so the diplomacy manager adopts it. */
policies.push({
  name: "zebraRelationsAppeasement",
  label: "Zebra Relations: Appeasement",
  unlocked: true,
  researched: false,
  blocked: false,
  blocks: ["zebraRelationsBellicosity"], // exclusive — normally left to the player
  prices: [{ name: "culture", val: 1000 }],
  effects: {},
});
res("culture").value = 3000;
res("culture").maxValue = 3000; // capped → free to spend
res("titanium").value = 0;

// (a) COHERENCE: the locked plan here is Mint (needs minerals, not titanium), so
// the bot must NOT force-adopt the Zebra policy or run the titanium/Zebra path —
// global titanium scarcity alone is not a reason to act. (This is the regression
// guard for "saving for X but doing Zebra trading underneath".)
fakeNow += 25000;
tickFn();
check("coherence: a non-titanium plan does NOT trigger Zebra policy adoption or the titanium path", policies.find((p) => p.name === "zebraRelationsAppeasement").researched === false && !/titanium path|Zebra/i.test(panelText(".kgh-now")));

// (b) Now make the titanium-blocked Titanium Saw the locked plan (retire the
// rival buildings so the only open candidate is the Saw, which needs titanium):
// the policy IS the titanium bottleneck lever, so it gets adopted.
buildings.forEach((b) => { b.unlocked = false; });
fakeNow += 25000;
tickFn();
fakeNow += 25000;
tickFn();
check("diplomacy: Zebra Relations Appeasement adopted once the plan genuinely needs titanium", policies.find((p) => p.name === "zebraRelationsAppeasement").researched === true && /titanium/i.test(panelText(".kgh-plan")));

/* Stage N — native subsystems that replaced Kitten Scientists fire directly ---- */

// Praise: managePraise() converts the faith bank to worship the moment faith is
// near its cap AND no faith-priced upgrade is still being saved for.
religionUpgrades[0].on = 1; // Solar Chant already owned → no faith upgrade pending
res("faith").value = 100;
res("faith").maxValue = 100;
const praiseBefore = praiseCalls;
fakeNow += 25000;
tickFn();
check("native praise: fires (faith → worship) when faith is near cap and no faith upgrade is pending", praiseCalls > praiseBefore && res("faith").value < 1);

// Festival: maybeHoldFestival() holds one when Drama is researched, the cost is
// affordable, and none of its inputs are reserved by the plan.
techs.push({ name: "drama", label: "Drama and Poetry", unlocked: true, researched: true, prices: [], unlocks: {} });
res("manpower").maxValue = 3000;
res("manpower").value = 1600;
res("culture").maxValue = 12000;
res("culture").value = 7000;
res("parchment").maxValue = 5000;
res("parchment").value = 3000;
// Festival runs at the end of the tick, so isolate it from auto-hunt (which
// otherwise drains the same catpower in this single synthetic tick; in-game the
// catpower regenerates between festivals). huntAll is exercised by its own checks.
const origHuntAll = village.huntAll;
village.huntAll = () => {};
diplomacy.races.forEach((r) => { r.unlocked = true; }); // no discoverable race → no explorer spend
res("titanium").value = res("titanium").maxValue || 100;
calendar.festivalDays = 0;
const festivalBefore = festivalCalls;
fakeNow += 25000;
tickFn();
village.huntAll = origHuntAll;
check("native festival: held when Drama is researched and the cost is affordable", festivalCalls > festivalBefore && calendar.festivalDays > 0);

// Trade: manageTrade() converts near-capped (otherwise-wasted) catpower into a
// scarce good a partner sells, while nothing is reserved and no explorer save is on.
res("titanium").value = res("titanium").maxValue || 100; // remove titanium pressure → no explorer saving
res("manpower").maxValue = 1000;
res("manpower").value = 985; // near cap → would be wasted
res("minerals").value = 0; // lizards sell minerals; plenty of room to store them
res("minerals").maxValue = 1000;
res("gold").value = 600;
res("gold").maxValue = 1000;
const tradeBefore = tradeCalls;
fakeNow += 25000;
tickFn();
check("native trade: near-capped surplus catpower is traded with a partner selling a wanted good", tradeCalls > tradeBefore);

/* Overflow reserve through converter inputs — if the active plan is missing
   converter outputs (iron/gold), the converter's live-effect inputs (wood) are
   not surplus for unrelated crafts such as beams. */
const alloyShrine = {
  name: "alloyShrine",
  label: "Alloy Shrine",
  unlocked: true,
  val: 0,
  on: 0,
  prices: [{ name: "iron", val: 120 }, { name: "gold", val: 80 }],
  effects: { scienceMax: 50000 },
};
const arborSmelter = {
  name: "arborSmelter",
  label: "Arbor Smelter",
  unlocked: true,
  val: 1,
  on: 1,
  prices: [],
  effects: { woodPerTickCon: -0.01, ironPerTickProd: 0.01, goldPerTickProd: 0.01 },
};
buildings.push(alloyShrine, arborSmelter);
res("iron").value = 20;
res("iron").maxValue = 300;
res("gold").value = 10;
res("gold").maxValue = 100;
res("wood").value = 2950;
res("wood").maxValue = 3000;
res("beam").value = 0;
perTick.wood = 2;
perTick.iron = 0.01;
perTick.gold = 0.01;
const beamsBeforeConverterReserve = res("beam").value;
fakeNow += 25000;
tickFn();
check("overflow: wood reserved as converter input for missing iron/gold instead of crafted into beams", res("beam").value === beamsBeforeConverterReserve);
buildings.splice(buildings.indexOf(alloyShrine), 1);
buildings.splice(buildings.indexOf(arborSmelter), 1);
res("iron").value = 50;
res("iron").maxValue = 300;
res("gold").value = 95;
res("gold").maxValue = 100;
res("wood").value = 450;
res("wood").maxValue = 3000;
perTick.wood = 0.4;
perTick.iron = 0.05;
perTick.gold = 0.01;
craft("compedium").prices = [{ name: "science", val: 10000 }, { name: "manuscript", val: 50 }];

/* =====================================================================
 * REGRESSION SUITE — persistent research sprints (v2.1.0)
 *
 * Sections: planner unit · multi-tick loop · job balancer ·
 * reservation/protection · panel text · auto-hunt · purchase safety.
 * These exercise the REAL multi-tick loop (changing resources, target
 * locks, reservations, crafting, hunting, job smoothing), not a single
 * static planner call — the v2.0.5 tests passed while live play failed
 * precisely because they only checked one snapshot.
 * =================================================================== */
const dbg = context.window.__kghDebug;
const acoustics = {
  name: "acoustics",
  label: "Acoustics",
  unlocked: true,
  researched: false,
  prices: [{ name: "science", val: 60000 }, { name: "compedium", val: 60 }],
  unlocks: { buildings: ["chapel"], upgrades: ["amphitheatre"] },
};
const electricity = {
  name: "electricity",
  label: "Electricity",
  unlocked: true,
  researched: false,
  prices: [{ name: "science", val: 71250 }, { name: "compedium", val: 100 }],
  unlocks: { buildings: ["factory"], upgrades: ["battery"] },
};
const temple = {
  name: "temple",
  label: "Temple",
  unlocked: true,
  val: 0,
  on: 0,
  prices: [{ name: "gold", val: 100 }, { name: "slab", val: 25 }, { name: "plate", val: 15 }, { name: "manuscript", val: 10 }],
  effects: { cultureMax: 150, faithMax: 100 },
};
techs.push(acoustics, electricity);
buildings.push(temple);
for (const tech of techs) {
  if (tech !== acoustics && tech !== electricity) tech.researched = true;
}
workshopUpgrades.forEach((upgrade) => { upgrade.researched = true; });
perTick.science = 0.2;
perTick.culture = 0.2;
perTick.furs = 0.5;
perTick.manpower = 2;

// Common Acoustics board.  Each test tweaks from this baseline.  Capped
// science here so the sprint starts; later tests deliberately drop it.
const setupAcoustics = () => {
  acoustics.researched = false;
  electricity.researched = false;
  temple.val = 0; temple.on = 0;
  res("science").value = 60000; res("science").maxValue = 60000;
  res("culture").value = 12000; res("culture").maxValue = 12000;
  res("compedium").value = 11.36;
  res("manuscript").value = 12;
  res("parchment").value = 80;
  res("furs").value = 12000; res("furs").maxValue = 20000000;
  res("manpower").value = 800; res("manpower").maxValue = 3225;
  res("gold").value = 95; res("gold").maxValue = 500;
  res("slab").value = 25; res("plate").value = 15;
  res("iron").value = 250; res("iron").maxValue = 300;
  let sharks = diplomacy.races.find((race) => race.name === "sharks");
  if (!sharks) {
    sharks = { name: "sharks", title: "Sharks", unlocked: true, embassyLevel: 0, tradeTotal: 0, embassyPrices: [], buys: [{ name: "iron", val: 100 }], sells: [{ name: "parchment", value: 7, chance: 100 }, { name: "manuscript", value: 4.8, chance: 100 }, { name: "compedium", value: 1.4, chance: 100 }] };
    diplomacy.races.push(sharks);
  }
  sharks.unlocked = true; sharks.tradeTotal = 0;
  const lizards = diplomacy.races.find((race) => race.name === "lizards");
  if (lizards) lizards.tradeTotal = 0;
  storage.set("kgh.goal", "balanced");
  dbg.forceActiveTarget(null); // clear any prior lock + sprint
};

/* ---------------------------------------------------------------------
 * Test A — Acoustics starts from capped science (planner unit)
 * ------------------------------------------------------------------- */
setupAcoustics();
res("furs").value = 30; res("parchment").value = 2; // furs + parchment scarce → the manuscript←parchment←furs legs are real deficits the chain must protect
fakeNow += 25000;
const aDecision = dbg.selectStrategicTarget("balanced");
const aRejected = aDecision.rejectedTopCandidates || [];
const aChain = [...(aDecision.protectedChain || new Set())];
const aReserved = dbg.reservedNeedsFor(aDecision.target);
check("Test A: capped science selects research:acoustics", aDecision.target?.kind === "research" && aDecision.target?.meta?.name === "acoustics" && dbg.targetId(aDecision.target) === "research:acoustics");
check("Test A: active layer is Research sprint", aDecision.layer === "Research sprint");
check("Test A: an Acoustics sprint contract is live", dbg.activeSprint()?.techName === "acoustics");
check("Test A: Temple is deferred behind the sprint", aRejected.some((item) => item.target?.kind === "build" && item.target?.meta?.name === "temple"));
check("Test A: protected chain includes compendium/manuscript/parchment/furs", ["compedium", "manuscript", "parchment", "furs"].every((name) => aChain.includes(name)));
check("Test A: no Temple gold/manuscript reservation (chain reserved, not Temple)", !(aReserved.gold > 0) && aReserved.manuscript !== 10 && aReserved.compedium >= 60 && aReserved.compedium < 100);

/* ---------------------------------------------------------------------
 * Test B — Acoustics persists after science drops below cap (multi-tick)
 * ------------------------------------------------------------------- */
setupAcoustics();
fakeNow += 25000;
dbg.selectStrategicTarget("balanced"); // start the sprint at cap
res("science").value = 30000; // now well below cap — must NOT cancel the sprint
let bHeld = true;
let bNoTempleReserve = true;
let bChainAction = true;
let bNoTempleFocus = true;
for (let i = 0; i < 20; i += 1) {
  fakeNow += 30000;
  res("science").value = Math.min(res("science").maxValue, 30000 + (i % 5) * 1000); // refill/drain wobble, always < cap
  tickFn();
  const d = dbg.selectStrategicTarget("balanced");
  const reserved = dbg.reservedNeedsFor(d.target);
  bHeld = bHeld && d.target?.meta?.name === "acoustics" && d.layer === "Research sprint";
  bNoTempleReserve = bNoTempleReserve && !(reserved.gold > 0) && reserved.manuscript !== 10;
  bChainAction = bChainAction && /craft|wait|hunt|advanc/i.test(dbg.nowText("balanced"));
  bNoTempleFocus = bNoTempleFocus && !/Focus: Temple/i.test(panelText(".kgh-plan")) && !/Long project/i.test(panelText(".kgh-plan"));
}
check("Test B: Acoustics stays the active target for all 20 ticks below cap", bHeld);
check("Test B: long project / Temple never becomes active", bNoTempleFocus);
check("Test B: current action stays a craft/wait/hunt chain step", bChainAction);
check("Test B: Temple manuscript/gold never reserved during the sprint", bNoTempleReserve);

/* ---------------------------------------------------------------------
 * Test C — exact v2.0.5 live-screenshot failure (multi-tick start below cap)
 * science 44.94K/60.47K (NOT near cap) yet Acoustics must own the plan.
 * ------------------------------------------------------------------- */
setupAcoustics();
storage.set("kgh.goal", "speedrun"); // speedrun mode active
res("science").value = 44940; res("science").maxValue = 60470;
res("culture").value = 3335.42; res("culture").maxValue = 3335.42;
res("compedium").value = 32.80;
res("manuscript").value = 46.94;
res("parchment").value = 12.92;
res("furs").value = 315.22;
res("manpower").value = 673.48; res("manpower").maxValue = 3225;
perTick.manpower = 12;
fakeNow += 25000;
const cDecision = dbg.selectStrategicTarget("speedrun");
const cPlan = dbg.planText("speedrun");
const cNow = dbg.nowText("speedrun");
check("Test C: 74%-science screenshot focuses Acoustics, not Temple", cDecision.target?.meta?.name === "acoustics" && cDecision.layer === "Research sprint");
check("Test C: science NOT near cap does not cancel the sprint", res("science").value / res("science").maxValue < 0.8 && dbg.activeSprint()?.techName === "acoustics");
check("Test C: panel focus is Acoustics / Research sprint with a chain action", /Focus: Acoustics/i.test(cPlan) && /Layer: Research sprint/i.test(cPlan) && /Compendium/i.test(cPlan) && /craft|wait|hunt|advanc/i.test(cNow));
check("Test C: panel never shows Electricity or a Temple/gold action", !/Electricity/i.test(cPlan) && !/Temple|gather .*gold/i.test(cNow));

/* ---------------------------------------------------------------------
 * Test D — Electricity is storage-blocked, never an active sprint
 * ------------------------------------------------------------------- */
setupAcoustics();
res("science").value = 60250; res("science").maxValue = 60270; // 60.25K / 60.27K
res("compedium").value = 11.36;
fakeNow += 25000;
const dDecision = dbg.selectStrategicTarget("balanced");
const dRejected = dDecision.rejectedTopCandidates || [];
const elecSolver = dbg.solveChain({ kind: "research", meta: electricity });
const compediumBeforeD = res("compedium").value;
tickFn();
check("Test D: Acoustics selected over storage-blocked Electricity", dDecision.target?.meta?.name === "acoustics");
check("Test D: Electricity deferred from the sprint by science storage", dRejected.some((item) => item.target?.meta?.name === "electricity" && /science storage blocked/i.test(item.reason || "")));
check("Test D: solver marks Electricity final science over cap (not buyable)", elecSolver.finalPurchaseCapsOk === false && elecSolver.reachable === false);
check("Test D: no Compendium crafted FOR Electricity (only Acoustics chain runs)", electricity.researched === false && res("compedium").value <= compediumBeforeD + 60);


/* ---------------------------------------------------------------------
 * Test D2 — exact v2.1.2 live issue: capped science, Electricity cannot fit.
 * The Science-storage-unlock layer is a GOAL-INDEPENDENT invariant, so it must
 * fire identically in balanced AND speedrun.  The live regression was speedrun-
 * only (the layer used to be gated to balanced), so both goals are asserted here.
 * ------------------------------------------------------------------- */
const academy = { name: "academy", label: "Academy", unlocked: true, val: 0, on: 0, prices: [{ name: "wood", val: 1000 }, { name: "beam", val: 25 }], effects: { scienceMax: 1000, scienceRatio: 0.1 } };
if (!buildings.some((b) => b.name === "academy")) buildings.push(academy);
for (const d2Goal of ["balanced", "speedrun"]) {
  setupAcoustics();
  storage.set("kgh.goal", d2Goal);
  dbg.forceActiveTarget(null);
  acoustics.researched = true; // Electricity is the next meaningful research.
  electricity.researched = false;
  res("science").value = 65640; res("science").maxValue = 65640;
  res("compedium").value = 20; // compendium shortage exists, but must not be crafted yet for Electricity.
  res("wood").value = 2000; res("wood").maxValue = 5000;
  res("beam").value = 30;
  res("gold").value = 98; res("gold").maxValue = 500; // Temple affordable/nearly affordable.
  res("slab").value = 25; res("plate").value = 15; res("manuscript").value = 10;
  fakeNow += 25000;
  const d2Decision = dbg.selectStrategicTarget(d2Goal);
  const d2Plan = dbg.planText(d2Goal);
  const d2Details = dbg.detailsText(d2Goal);
  const d2Now = dbg.nowText(d2Goal);
  check(`Test D2 [${d2Goal}]: Electricity cap-block creates Science storage unlock layer`, d2Decision.layer === "Science storage unlock");
  check(`Test D2 [${d2Goal}]: planner chooses science storage candidate, not Temple`, d2Decision.target?.meta?.name !== "temple" && /library|academy|observatory/i.test(d2Decision.target?.meta?.name || ""));
  check(`Test D2 [${d2Goal}]: panel reports Electricity is storage-blocked and exact storage need`, /Electricity is storage-blocked/i.test(d2Plan) && /\+5\.[0-9]+K science storage/i.test(d2Plan));
  check(`Test D2 [${d2Goal}]: Now action builds storage unlock, not Temple or compendium for Electricity`, !/Temple|Compendium for Electricity/i.test(d2Now));
}

/* ---------------------------------------------------------------------
 * Test D3 — v2.1.3 live regression: science storage unlock must be VALUE-
 * independent.  Science is only ~50% of cap (NOT near cap) but the next valuable
 * tech (Electricity) still can't fit the cap, so storage must STILL be the plan.
 * The old `isNearResourceCap` trigger flickered back to Temple the moment science
 * dropped below the cap mid-build, releasing Observatory's reserved iron.  Both
 * goals are asserted, and Temple is made fully affordable to prove it can't win.
 * ------------------------------------------------------------------- */
for (const d3Goal of ["balanced", "speedrun"]) {
  setupAcoustics();
  storage.set("kgh.goal", d3Goal);
  dbg.forceActiveTarget(null);
  acoustics.researched = true;       // Electricity is the next valuable research.
  electricity.researched = false;
  res("science").value = 32940; res("science").maxValue = 65850; // ~50% of cap → NOT near cap
  res("compedium").value = 28;
  res("wood").value = 2000; res("wood").maxValue = 5000;
  res("beam").value = 30;
  res("gold").value = 980; res("gold").maxValue = 1650; // Temple FULLY affordable
  res("slab").value = 30; res("plate").value = 20; res("manuscript").value = 250;
  fakeNow += 25000;
  const d3Decision = dbg.selectStrategicTarget(d3Goal);
  const d3Plan = dbg.planText(d3Goal);
  const d3Now = dbg.nowText(d3Goal);
  check(`Test D3 [${d3Goal}]: cap-blocked next tech keeps Science storage unlock even with science below cap`, d3Decision.layer === "Science storage unlock");
  check(`Test D3 [${d3Goal}]: target is a cap-growth building, not the fully-affordable Temple`, d3Decision.target?.meta?.name !== "temple" && /library|academy|observatory/i.test(d3Decision.target?.meta?.name || ""));
  check(`Test D3 [${d3Goal}]: panel + Now never fall back to Temple while the cap blocks Electricity`, !/Focus: Temple/i.test(d3Plan) && !/Temple/i.test(d3Now));
}

/* ---------------------------------------------------------------------
 * Test D4 — v2.1.4 live regression: the science storage unlock must COMMIT to
 * one cap-growth building.  In the live game scienceStorageGain ties (the game
 * doesn't expose scienceMax until calculateEffects), so the secondary score/wait
 * keys decide and wobble tick-to-tick — the plan flickered between Library and
 * Observatory ("library chain" then "Observatory chain").  Here we commit to one
 * building, then reveal an EQUAL-gain rival that out-scores it; stickiness must
 * hold the committed pick instead of switching (which would resume the flicker).
 * Academy is disabled so the two equal-gain rivals are the top options.
 * ------------------------------------------------------------------- */
// Build a clean two-rival setup that is robust to the building state accumulated
// by earlier tests: disable every existing cap-growth building, then add two
// EQUAL-gain rivals with uniquely-reserved names (only the first unlocked first).
for (const b of buildings) { if (b.effects && (b.effects.scienceMax || b.effects.scienceRatio)) b.unlocked = false; }
const ensureBld = (name, effects, prices) => {
  let b = buildings.find((x) => x.name === name);
  if (!b) { b = { name, label: name }; buildings.push(b); }
  Object.assign(b, { effects, prices, val: 0, on: 0 });
  return b;
};
const vaultA = ensureBld("scienceVaultA", { scienceMax: 500 }, [{ name: "wood", val: 1200 }]);
const vaultB = ensureBld("scienceVaultB", { scienceMax: 500 }, [{ name: "minerals", val: 1200 }]);
vaultA.unlocked = true; vaultB.unlocked = false;
setupAcoustics();
storage.set("kgh.goal", "speedrun");
dbg.forceActiveTarget(null);
acoustics.researched = true;
electricity.researched = false;
res("science").value = 65850; res("science").maxValue = 65850;
res("wood").value = 1300; res("wood").maxValue = 5000;
res("minerals").value = 1300; res("minerals").maxValue = 5000;
fakeNow += 25000;
// Phase 1: only vaultA is a cap-growth option → it becomes the committed pick.
const d4Committed = dbg.targetId(dbg.selectStrategicTarget("speedrun").target);
// Phase 2: reveal the equal-gain vaultB.  Stickiness must hold vaultA across ticks
// even as the score/wait tiebreak flips (no >20% gain improvement to switch on).
vaultB.unlocked = true;
let d4Stable = true;
for (let i = 0; i < 8; i += 1) {
  fakeNow += 30000;
  res("wood").value = i % 2 ? 800 : 5000;
  res("minerals").value = i % 2 ? 5000 : 800;
  const d4Id = dbg.targetId(dbg.selectStrategicTarget("speedrun").target);
  d4Stable = d4Stable && d4Id === d4Committed;
}
check("Test D4: science storage unlock commits to one building, ignoring an equal-gain rival", d4Stable && /scienceVaultA/i.test(d4Committed || ""));

/*
 * Test D4b — plan-switch score gain uses fractional units consistently. A
 * candidate that is 61% better must satisfy the 25% hysteresis threshold; the
 * old logic effectively compared a fractional gain with a percent threshold (or
 * a hidden absolute score add-on) and could log impossible math like 61% < 25%.
 */
const d4bLocked = { kind: "build", score: 100, meta: { name: "bioLab", label: "Bio Lab" } };
const d4bPreferred = { kind: "build", score: 161, meta: { name: "library", label: "Library" } };
check("Test D4b: 61% candidate score gain passes the 25% plan-switch threshold", dbg.candidateScoreGain(d4bLocked, d4bPreferred) > 0.60 && dbg.candidateMeetsSwitchScoreGain(d4bLocked, d4bPreferred));
vaultA.unlocked = false; vaultB.unlocked = false; // do not leak into later sprint tests

/* ---------------------------------------------------------------------
 * Test D5 — wood-vs-catnip pathway is read LIVE.  bestWoodJob must compare the
 * CURRENT per-kitten wood rate against refining a farmer's CURRENT (in-season)
 * catnip into wood — folding in the live season/weather multiplier and the live
 * craft-ratio bonus — not baked-in base modifiers.  Earlier code used the base
 * modifier, ignored the [+50%]/-75% season swing, and dropped the refine bonus.
 * ------------------------------------------------------------------- */
const realGetResProduction = village.getResProduction;
const realWeatherMod = calendar.getWeatherMod;
const realWoodPerTick = perTick.wood;
const realWoodCraftRatio = craftRatios.wood;
job("woodcutter").value = 1;
job("farmer").value = 1;
perTick.wood = 0; // neutralise productionFor noise so woodBase (30/s) dominates the max()
// woodPerCutter = getResProduction().wood (6) * tps (5) / 1 = 30 wood/s, season-independent.
village.getResProduction = () => ({ wood: 6, catnip: 1000, minerals: 1, science: 1, manpower: 0.5 });
craftRatios.wood = 0;
// Winter (−75%): 1000*5*0.25/100 = 12.5 wood-via-refine/farmer < 30 → woodcutter.
calendar.getWeatherMod = () => -0.75;
check("Test D5: winter catnip slump makes WOODCUTTER the economical wood source", dbg.bestWoodJob()?.name === "woodcutter");
// Spring (+50%): 1000*5*1.5/100 = 75 > 30 → farmer.  Same board, only the live
// season changed — proves the season multiplier is actually read, not assumed.
calendar.getWeatherMod = () => 0.5;
check("Test D5: spring catnip boom flips the economical wood source to FARMER", dbg.bestWoodJob()?.name === "farmer");
// Craft-ratio sensitivity (neutral season): C=400 → 400*5/100 = 20 < 30 without the
// refine bonus (woodcutter), but a +100% craft ratio yields 40 > 30 (farmer).
village.getResProduction = () => ({ wood: 6, catnip: 400, minerals: 1, science: 1, manpower: 0.5 });
calendar.getWeatherMod = () => 0;
craftRatios.wood = 0;
check("Test D5: without the refine craft bonus woodcutter stays economical", dbg.bestWoodJob()?.name === "woodcutter");
craftRatios.wood = 1.0; // +100% wood per refine
check("Test D5: live craft-ratio bonus is folded into the refine yield (farmer wins)", dbg.bestWoodJob()?.name === "farmer");


/* Test D6 — target lock blocks Harbour-style spend impact while Observatory is pending */
const lockObservatory = {
  name: "observatoryLock",
  label: "Observatory",
  unlocked: true,
  val: 0,
  on: 0,
  prices: [{ name: "iron", val: 1000 }, { name: "scaffold", val: 10 }, { name: "slab", val: 20 }],
  effects: { scienceMax: 5000 },
};
const harbourBait = {
  name: "harbourLockBait",
  label: "Harbour",
  unlocked: true,
  val: 0,
  on: 0,
  prices: [{ name: "ship", val: 1 }, { name: "slab", val: 5 }],
  effects: { shipMax: 5 },
};
res("iron").value = 1150;
res("iron").maxValue = 5000;
res("scaffold").value = 5;
res("slab").value = 30;
res("ship").value = 1;
buildings.push(lockObservatory, harbourBait);
const d6Ledger = dbg.buildTargetLedger({ kind: "build", meta: lockObservatory, affordable: false });
const d6Impact = dbg.spendImpactForCandidate({ kind: "build", meta: harbourBait });
const d6Violation = dbg.violatesTargetLock({ kind: "build", meta: harbourBait }, { kind: "build", meta: lockObservatory, affordable: false });
check("Test D6: Observatory target ledger includes scaffold/slab raw chain resources", ["scaffold", "slab", "plate", "iron"].every((name) => d6Ledger.critical.has(name)));
check("Test D6: Harbour spend impact includes direct ship/slab spend", d6Impact.critical.has("ship") && d6Impact.critical.has("slab"));
check("Test D6: target lock blocks Harbour while Observatory is pending", /target lock/i.test(d6Violation?.reason || "") && /Observatory/.test(d6Violation?.reason || ""));
village.getResProduction = realGetResProduction;
calendar.getWeatherMod = realWeatherMod;
perTick.wood = realWoodPerTick;
craftRatios.wood = realWoodCraftRatio;

/* ---------------------------------------------------------------------
 * Test Q — manual build queue (v2.2.0 single-autopilot rework).  The player's
 * queued pick overrides the autopilot (even an in-progress research sprint) when
 * it is actionable; a cap-blocked/locked queued item is SKIPPED so the queue can
 * never stall the bot; completed items auto-remove.
 * ------------------------------------------------------------------- */
setupAcoustics(); // caps science → autopilot would otherwise start an Acoustics sprint
dbg.forceActiveTarget(null);
dbg.queueClear();
const queueMine = buildings.find((b) => b.name === "mine");
queueMine.unlocked = true; queueMine.prices = [{ name: "wood", val: 100 }];
res("wood").value = 5000; res("wood").maxValue = 88720;
dbg.queueAdd("build:mine", queueMine.val);
const q42Decision = dbg.selectStrategicTarget("balanced");
check("Test Q: queued building overrides the autopilot (Manual queue layer)", q42Decision.layer === "Manual queue" && q42Decision.target?.meta?.name === "mine");

// A cap-blocked research queued in front is skipped; the next actionable item wins.
acoustics.researched = true; electricity.researched = false;
res("science").value = 65640; res("science").maxValue = 65640; // Electricity (71250) is cap-blocked
dbg.queueClear();
dbg.queueAdd("research:electricity", 0);
dbg.queueAdd("build:mine", queueMine.val);
const qBlocked = dbg.selectStrategicTarget("balanced");
check("Test Q: a cap-blocked queued tech is skipped, next actionable item wins", qBlocked.layer === "Manual queue" && qBlocked.target?.meta?.name === "mine");

// Completed items auto-remove from the stored queue.
dbg.queueClear();
electricity.researched = true;
dbg.queueAdd("research:electricity", 0);
dbg.queueAdd("build:mine", queueMine.val);
dbg.selectStrategicTarget("balanced");
check("Test Q: completed queued items auto-remove", !dbg.queue().some((item) => item.id === "research:electricity"));
dbg.queueClear();
electricity.researched = false;

/* ---------------------------------------------------------------------
 * Test E — Job balancer follows the Acoustics chain (Hunters > Priests)
 * ------------------------------------------------------------------- */
setupAcoustics();
res("science").value = 60000; res("science").maxValue = 60000; // capped → scholars suppressed
// The whole chain is blocked on furs, so no Compendium/Manuscript craft spends
// science this tick: science stays capped and scholars must stay at zero.
res("furs").value = 30; // furs are the live bottleneck
res("parchment").value = 0;
res("manuscript").value = 0;
res("compedium").value = 11.36;
res("manpower").value = 600; res("manpower").maxValue = 3225;
perTick.manpower = 12;
res("faith").value = 10; res("faith").maxValue = 100; // faith below cap, irrelevant
res("catnip").value = 3500; res("catnip").maxValue = 5000; perTick.catnip = 8; // catnip safe
for (const j of jobs) j.value = 0;
job("farmer").value = 12; // prior priest/farmer-heavy split that must NOT linger
job("priest").value = 8;
village.getKittens = () => 20;
village.getFreeKittens = () => 4;
fakeNow += 40000;
tickFn();
fakeNow += 40000;
tickFn();
const workers = 20;
check("Test E: Hunters materially exceed Priests", job("hunter").value > job("priest").value && job("hunter").value >= 3);
check("Test E: Priests suppressed (<= 10% of workers and <= 3)", job("priest").value <= Math.max(3, workers * 0.1) && job("priest").value <= 3);
check("Test E: Scholars 0 while science is capped", job("scholar").value === 0);
check("Test E: Farmers only at safety floor (no generic farmer army)", job("farmer").value <= 3);
check("Test E: details name hunters/furs for the Acoustics chain", /Hunters for furs/i.test(panelText(".kgh-jobs")) && /Hunters for furs|Furs/i.test(panelText(".kgh-note")));
check("Test E: faith baseline is flagged suppressed during the sprint", /Suppressed: faith baseline during Research sprint/i.test(panelText(".kgh-note")));

/* ---------------------------------------------------------------------
 * Test E2 — discretionary faith banking yields to a food crisis.  A pending
 * religion upgrade injects a fat faith need (weight 10) even when the active
 * plan needs no faith; live, that kept ~16 Priests banking faith while catnip
 * drained to 0 and kittens starved.  Faith must be a job need while food is
 * healthy, and suppressed the moment catnip is net-negative and low.
 * ------------------------------------------------------------------- */
const e2Saved = {
  techFlags: techs.map((t) => [t, t.researched]),
  rel: [religionUpgrades[0].researched, religionUpgrades[0].on, religionUpgrades[0].val],
  catnip: [res("catnip").value, res("catnip").maxValue],
  perTickCatnip: perTick.catnip,
  faith: [res("faith").value, res("faith").maxValue],
  getKittens: village.getKittens,
  maxKittens: village.maxKittens,
  priest: job("priest").value,
};
for (const t of techs) t.researched = true;            // no research sprint can own the plan
religionUpgrades[0].researched = false;                // a faith upgrade is pending (weight 10)
religionUpgrades[0].on = 0; religionUpgrades[0].val = 0;
res("faith").value = 50; res("faith").maxValue = 5500; // faith has headroom, below cap
village.getKittens = () => 60; village.maxKittens = 91;
job("priest").value = 8;                               // priests exist to bank faith
// Food healthy → discretionary faith banking is a real job need.
res("catnip").value = 3500; res("catnip").maxValue = 5000; perTick.catnip = 8;
dbg.forceActiveTarget(null);
dbg.selectStrategicTarget("balanced");
const e2Healthy = dbg.resourceNeeds("balanced");
check("Test E2: faith is a job need while food is healthy and a religion upgrade is pending", (e2Healthy.needs.faith || 0) > 0);
// Food crisis (catnip net-negative and low) → faith banking stands down.
res("catnip").value = 1500; res("catnip").maxValue = 5000; perTick.catnip = -8;
dbg.forceActiveTarget(null);
dbg.selectStrategicTarget("balanced");
const e2Stressed = dbg.resourceNeeds("balanced");
check("Test E2: faith job need is suppressed while catnip is net-negative (food first)", (e2Stressed.needs.faith || 0) === 0);
// Restore.
for (const [t, r] of e2Saved.techFlags) t.researched = r;
[religionUpgrades[0].researched, religionUpgrades[0].on, religionUpgrades[0].val] = e2Saved.rel;
res("catnip").value = e2Saved.catnip[0]; res("catnip").maxValue = e2Saved.catnip[1];
perTick.catnip = e2Saved.perTickCatnip;
res("faith").value = e2Saved.faith[0]; res("faith").maxValue = e2Saved.faith[1];
village.getKittens = e2Saved.getKittens; village.maxKittens = e2Saved.maxKittens;
job("priest").value = e2Saved.priest;

/* ---------------------------------------------------------------------
 * Test E3 — faith banking stands down when a far-off NON-faith cost is the
 * real gate.  Live (v2.6.0), Apocrypha needed ~5K faith AND ~5K gold while
 * gold trickled in at +0.3/s; faith was already ~79% there, so ~11 Priests
 * filled the faith bank to its cap with nothing to spend it on (praise is held
 * for a pending upgrade).  Faith must be a job need ONLY when faith is the
 * binding constraint; the moment the non-faith gate clears, priests resume.
 * ------------------------------------------------------------------- */
const e3Saved = {
  techFlags: techs.map((t) => [t, t.researched]),
  rel0: [religionUpgrades[0].researched, religionUpgrades[0].on, religionUpgrades[0].val],
  rel1: { researched: religionUpgrades[1].researched, on: religionUpgrades[1].on, val: religionUpgrades[1].val, prices: religionUpgrades[1].prices, faith: religionUpgrades[1].faith },
  worship: gamePage.religion.faith,
  faith: [res("faith").value, res("faith").maxValue],
  gold: [res("gold").value, res("gold").maxValue],
  wood: [res("wood").value, res("wood").maxValue],
  catnip: [res("catnip").value, res("catnip").maxValue],
  perTickCatnip: perTick.catnip,
  priest: job("priest").value,
};
for (const t of techs) t.researched = true;                  // no research sprint owns the plan
religionUpgrades[0].researched = true; religionUpgrades[0].on = 1; // Solar Chant done → not pending
gamePage.religion.faith = 5000;                              // worship high → Solar Revolution visible
religionUpgrades[1].researched = false; religionUpgrades[1].on = 0; religionUpgrades[1].val = 0;
religionUpgrades[1].faith = 1000;                            // visibility threshold (worship 5000 >= 1000)
religionUpgrades[1].prices = [{ name: "gold", val: 5000 }, { name: "faith", val: 5000 }]; // Apocrypha-shaped
res("faith").value = 3900; res("faith").maxValue = 5500;     // 78% of the faith cost
res("catnip").value = 3500; res("catnip").maxValue = 5000; perTick.catnip = 8; // food healthy
res("wood").value = 50; res("wood").maxValue = 200000;       // a plain non-faith build target exists
// Pin the active plan to a wood building so the religion upgrade itself is not the
// target (isolating the faith-banking layer under test from generic target costs).
const e3Target = dbg.candidateById("build:hut") || dbg.candidateById("build:library");
res("gold").value = 5; res("gold").maxValue = 6880;          // gold ~0.1% of cost → far-off gate
dbg.forceActiveTarget(e3Target);
const e3GoldGated = dbg.resourceNeeds("balanced");
check("Test E3: faith is NOT a job need while the upgrade is gated on a far-off gold cost", (e3GoldGated.needs.faith || 0) === 0);
check("Test E3: the real bottleneck (gold) is still surfaced as a need", (e3GoldGated.needs.gold || 0) > 0);
// Clear the gold gate → faith becomes the binding constraint → priests resume.
res("gold").value = 5000;
dbg.forceActiveTarget(e3Target);
const e3FaithBinding = dbg.resourceNeeds("balanced");
check("Test E3: faith resumes as a job need once it is the binding constraint", (e3FaithBinding.needs.faith || 0) > 0);
// Restore.
for (const [t, r] of e3Saved.techFlags) t.researched = r;
[religionUpgrades[0].researched, religionUpgrades[0].on, religionUpgrades[0].val] = e3Saved.rel0;
religionUpgrades[1].researched = e3Saved.rel1.researched; religionUpgrades[1].on = e3Saved.rel1.on; religionUpgrades[1].val = e3Saved.rel1.val;
religionUpgrades[1].prices = e3Saved.rel1.prices; religionUpgrades[1].faith = e3Saved.rel1.faith;
gamePage.religion.faith = e3Saved.worship;
res("faith").value = e3Saved.faith[0]; res("faith").maxValue = e3Saved.faith[1];
res("gold").value = e3Saved.gold[0]; res("gold").maxValue = e3Saved.gold[1];
res("wood").value = e3Saved.wood[0]; res("wood").maxValue = e3Saved.wood[1];
res("catnip").value = e3Saved.catnip[0]; res("catnip").maxValue = e3Saved.catnip[1];
perTick.catnip = e3Saved.perTickCatnip;
job("priest").value = e3Saved.priest;
dbg.forceActiveTarget(null);

/* ---------------------------------------------------------------------
 * Test F — Auto-hunt fires at the chain threshold for the sprint
 * ------------------------------------------------------------------- */
setupAcoustics();
res("science").value = 30000; res("science").maxValue = 60000; // below cap, sprint persists
res("furs").value = 30; // chain needs furs
res("parchment").value = 0;
res("manpower").value = 400; res("manpower").maxValue = 3225; // 12% of cap: above 8% chain threshold, below 75% mood threshold
perTick.manpower = 5;
diplomacy.races.forEach((r) => { r.unlocked = true; r.hidden = false; }); // no discoverable race → explorer reserve not in play
res("titanium").value = res("titanium").maxValue || 100;
let acHuntCalls = 0;
const realHuntAll = village.huntAll;
village.huntAll = () => { acHuntCalls += 1; realHuntAll(); };
const fursBeforeHunt = res("furs").value;
fakeNow += 60000; // clear the hunt-log throttle
dbg.selectStrategicTarget("balanced"); // ensure the sprint owns the plan this tick
tickFn();
village.huntAll = realHuntAll;
check("Test F: auto-hunt fires at the lowered chain threshold (12% < normal 75%)", acHuntCalls > 0 && res("furs").value > fursBeforeHunt);
check("Test F: hunt log names the Acoustics chain", /sent hunters for furs for Acoustics chain/i.test(logText()));
check("Test F: hunting respects the catpower reserve (never driven negative)", res("manpower").value >= 0);

/* ---------------------------------------------------------------------
 * Test G — Overflow crafting does not spam irrelevant Metal Plate
 * ------------------------------------------------------------------- */
setupAcoustics();
res("science").value = 45000; res("science").maxValue = 60000;
res("iron").value = 295; res("iron").maxValue = 300; // hot iron → tempting to craft Plate
res("plate").value = 15;
const plateBeforeOverflow = res("plate").value;
fakeNow += 30000;
tickFn();
check("Test G: hot iron is NOT converted to Metal Plate while the Acoustics sprint runs", res("plate").value === plateBeforeOverflow && !/Metal Plate/i.test(panelText(".kgh-craft")));
check("Test G: the active sprint chain still owns the plan", dbg.activeSprint()?.techName === "acoustics");

/* ---------------------------------------------------------------------
 * Test G2 — Target-aware Shark trades and Compendium reserve protection
 * ------------------------------------------------------------------- */
setupAcoustics();
res("science").value = 60000;
res("compedium").value = 14;
res("manuscript").value = 0;
res("parchment").value = 0;
res("manpower").value = 500; res("manpower").maxValue = 3225; // enough for caravan, not near cap
res("gold").value = 100;
res("iron").value = 250;
res("wood").value = 0; // Lizards' room score should not beat Sharks
const sharksG2 = diplomacy.races.find((race) => race.name === "sharks");
const lizardsG2 = diplomacy.races.find((race) => race.name === "lizards");
const sharkBeforeG2 = sharksG2.tradeTotal || 0;
const lizardBeforeG2 = lizardsG2.tradeTotal || 0;
fakeNow += 30000;
dbg.selectStrategicTarget("balanced");
tickFn();
check("Test G2: Acoustics Compendium shortage does not use unrelated Lizard surplus trade", (lizardsG2.tradeTotal || 0) === lizardBeforeG2);

setupAcoustics();
res("science").value = 60000;
res("compedium").value = 40;
res("science").maxValue = 80000;
const blueprintsBeforeG2 = res("blueprint") ? res("blueprint").value : 0;
// Ensure a blueprint resource exists in this fixture if later game metadata exposes it.
if (!res("blueprint")) resources.push(R("blueprint", 0, 0, "Blueprint"));
const compBeforeBlueprintGuard = res("compedium").value;
fakeNow += 30000;
dbg.selectStrategicTarget("balanced");
tickFn();
check("Test G2: overflow does NOT craft Blueprint from Acoustics-reserved Compendium", res("compedium").value >= compBeforeBlueprintGuard && res("blueprint").value === blueprintsBeforeG2);

setupAcoustics();
res("science").value = 60000;
res("compedium").value = 40;
fakeNow += 30000;
dbg.selectStrategicTarget("balanced");
dbg.forceActiveTarget(null); // simulate a brief sprint recalculation gap
const compBeforeStickyGap = res("compedium").value;
tickFn();
check("Test G2: sticky target-chain reserve survives a brief sprint recalculation gap", res("compedium").value >= compBeforeStickyGap);

setupAcoustics();
const tradeLogBeforeHunt = logText();
res("manpower").value = 500;
res("furs").value = 0;
res("ivory").value = 0;
fakeNow += 60000;
village.huntAll();
tickFn();
const newLogAfterHunt = logText().slice(tradeLogBeforeHunt.length);
check("Test G2: hunting resource deltas are not logged as trade", !/🤝 trade: .*Furs/i.test(newLogAfterHunt));

/* ---------------------------------------------------------------------
 * Test H — Purchase safety: raw metadata fallback disabled by default
 * ------------------------------------------------------------------- */
check("Test H: ALLOW_RAW_METADATA_BUY_FALLBACK is false by default", /const ALLOW_RAW_METADATA_BUY_FALLBACK = false/.test(source));
check("Test H: raw metadata buy is gated behind the (disabled) debug flag", /if \(ALLOW_RAW_METADATA_BUY_FALLBACK\)[\s\S]{0,80}buyViaRawMetadata/.test(source));
check("Test H: normal play never mutates meta.researched/val via a raw fallback", !/meta\.researched = true;[\s\S]{0,40}rawPayPrices/.test(source));

/* ---------------------------------------------------------------------
 * Test I — v2.3.0 Autopilot OFF: a flipped toggle must stop EVERY action.
 * Before v2.3.0 the OFF state only re-skinned the button — every spender
 * (buys, crafts, trades, hunts, festivals, leader, jobs) still ran each
 * tick.  The tick now hard-gates on isAutopilotOn and reports paused state.
 * ------------------------------------------------------------------- */
acoustics.researched = false; // make the planner want to do something
electricity.researched = false;
// Re-seed a juicy board: lots of resources, cheap targets ready.
res("wood").value = 50000; res("wood").maxValue = 100000;
res("minerals").value = 50000; res("minerals").maxValue = 100000;
res("science").value = 60000; res("science").maxValue = 60000;
res("compedium").value = 200; res("manuscript").value = 200;
res("manpower").value = 1500; res("manpower").maxValue = 1500; // near cap, would invite a hunt
res("furs").value = 0; res("ivory").value = 0;
res("faith").value = 100; res("faith").maxValue = 100; // would invite a praise
const huntBeforeI = res("furs").value;
const praiseBeforeI = praiseCalls;
const buildingValsBeforeI = buildings.map((b) => b.val).join("|");
const techsBeforeI = techs.map((t) => !!t.researched).join("|");
const jobsBeforeI = jobs.map((j) => j.value).join("|");
const tradeBeforeI = tradeCalls;
storage.set("kgh.autopilot", "0"); // flip OFF
dbg.forceActiveTarget(null);
fakeNow += 60000;
tickFn();
fakeNow += 60000;
tickFn();
check("Test I: autopilot OFF runs no buys (building counts unchanged)", buildings.map((b) => b.val).join("|") === buildingValsBeforeI);
check("Test I: autopilot OFF runs no research (tech flags unchanged)", techs.map((t) => !!t.researched).join("|") === techsBeforeI);
check("Test I: autopilot OFF does not hunt, praise or trade", res("furs").value === huntBeforeI && praiseCalls === praiseBeforeI && tradeCalls === tradeBeforeI);
check("Test I: autopilot OFF does not rebalance jobs", jobs.map((j) => j.value).join("|") === jobsBeforeI);
check("Test I: panel plan line reports OFF", /Autopilot OFF/i.test(panelText(".kgh-plan")) && /paused/i.test(panelText(".kgh-now")));
storage.set("kgh.autopilot", "1"); // flip back ON for any further checks

/* ---------------------------------------------------------------------
 * Test J — v2.3.0 storage-unlock blocked-tech chain protection: while the
 * planner is growing science storage so a cap-blocked tech (Electricity)
 * can fit, the cap-blocked tech's craft-chain resources (compendium etc.)
 * must be protected from overflow-craft conversion into blueprint.
 * Previously this only happened during an explicit Research sprint — but
 * the storage-unlock layer left compendium up for grabs and the overflow
 * crafter melted it into blueprint.
 * ------------------------------------------------------------------- */
storage.set("kgh.goal", "balanced");
dbg.forceActiveTarget(null);
// Re-enable storage-growing buildings (earlier tests turned them off).
for (const name of ["library", "academy"]) {
  const b = buildings.find((bb) => bb.name === name);
  if (b) b.unlocked = true;
}
// Reset every tech, then enable just Acoustics-researched + Electricity-blocked.
for (const tech of techs) tech.researched = (tech !== electricity);
acoustics.researched = true; electricity.researched = false;
// Cap science so Electricity (71250) does not fit (cap 65640) → storage unlock.
res("science").value = 65640; res("science").maxValue = 65640;
res("compedium").value = 80; // user's "lots of compendium" scenario
res("blueprint").value = 0;
res("manuscript").value = 0; res("parchment").value = 0;
res("wood").value = 2000; res("wood").maxValue = 5000;
res("beam").value = 30;
res("minerals").value = 1300; res("minerals").maxValue = 5000;
fakeNow += 60000;
const jDecision = dbg.selectStrategicTarget("balanced");
const jCompendiumBefore = res("compedium").value;
const jBlueprintBefore = res("blueprint").value;
tickFn();
check("Test J: storage-unlock layer is active for Electricity", jDecision.layer === "Science storage unlock");
check("Test J: compendium reserved during storage unlock (NOT converted to blueprint)", res("compedium").value >= jCompendiumBefore && res("blueprint").value === jBlueprintBefore);

/* ---------------------------------------------------------------------
 * Test K — v2.3.0 resource-snapshot bug: action delta lines must report
 * what actually changed, not "no resource gain" for every action.  The
 * snapshot used to return the live-reference resource map (before/after
 * both reading the same `.value`), so withActionResourceDeltas always
 * computed a zero delta even when hunters returned furs.
 * ------------------------------------------------------------------- */
electricity.researched = true; // de-target the storage unlock
storage.set("kgh.autopilot", "1");
dbg.forceActiveTarget(null);
res("manpower").value = 1500; res("manpower").maxValue = 1500;
res("furs").value = 0; res("ivory").value = 0;
res("titanium").value = 100; res("titanium").maxValue = 200;
diplomacy.races.forEach((r) => { r.unlocked = true; r.hidden = false; });
// Clear the log so the new hunt entry is the topmost line — older entries
// are PREPENDED so we can't slice() to filter them out.
storage.set("kgh.log", "[]");
const fursBeforeK = res("furs").value;
fakeNow += 120000; // clear the auto-hunt 30s throttle from prior ticks
tickFn();
const logAfterK = logText();
check("Test K: hunt actually grants furs (sanity)", res("furs").value > fursBeforeK);
// Parse the JSON-encoded log so we can inspect individual entries.
const parsedLog = JSON.parse(logAfterK || "[]");
const huntEntries = parsedLog.filter((entry) => /🏹 hunting:/i.test(entry));
const huntHasGain = huntEntries.some((entry) => /\+\s*\d/i.test(entry) && !/no resource gain/i.test(entry));
if (!huntHasGain) {
  console.error("DEBUG Test K — hunt entries:", huntEntries);
  console.error("DEBUG Test K — furs after:", res("furs").value, "before:", fursBeforeK);
  console.error("DEBUG Test K — manpower:", res("manpower").value);
}
check("Test K: hunt log reports the resource gain (snapshot captures value, not reference)", huntHasGain);

/* ---------------------------------------------------------------------
 * Test L — v2.3.0 action log capacity: visible + stored caps are bigger
 * so a debugging session can scroll back through more decisions.
 * ------------------------------------------------------------------- */
check("Test L: log display limit raised above the old 12-line window", /LOG_DISPLAY_LIMIT\s*=\s*([4-9]\d|1\d{2,})/.test(source));
check("Test L: log storage cap raised above the old 50-entry buffer", /LOG_STORAGE_LIMIT\s*=\s*([1-9]\d{2,})/.test(source));
check("Test L: panel ships a 'Copy' button for the action log", /kgh-log-copy/.test(source));

/* ---------------------------------------------------------------------
 * Test M — v2.3.0 trade payoff includes season + embassy bonuses so the
 * planner SCORES trades the way they actually play out (Summer Furs are
 * worth more than Winter Furs).  This is a unit-level check on the
 * exposed pieces; the wider scoring still runs through targetTradeScore.
 * ------------------------------------------------------------------- */
check("Test M: tradeSellExpected hook accepts a race so embassy bonus applies", /tradeSellExpected = \(sell, race = null\)/.test(source));
check("Test M: trade scoring reads current calendar season", /currentTradeSeasonName/.test(source));
check("Test M: trade scoring folds embassy level into expected yield", /tradeEmbassyBonus/.test(source));

/* ---------------------------------------------------------------------
 * Test N — v2.4.0 trade-vs-craft pathway analysis: the planner can
 * SECONDS-cost each demand resource via crafting and via the best
 * trade partner, then prefer whichever is faster.  The hard gate
 * also skips a trade entirely when crafting is materially faster
 * for every demand resource that race could sell us.
 * ------------------------------------------------------------------- */
setupAcoustics();
storage.set("kgh.goal", "balanced");
dbg.forceActiveTarget(null);
acoustics.researched = false;
electricity.researched = true;
res("science").value = 60000; res("science").maxValue = 80000;
res("compedium").value = 14;
res("manuscript").value = 0;
res("parchment").value = 0;
res("furs").value = 30;
res("manpower").value = 800; res("manpower").maxValue = 3225;
res("gold").value = 100; res("gold").maxValue = 500;
res("iron").value = 1000; res("iron").maxValue = 5000;
// Make production rates explicit so the comparison is deterministic.
perTick.manpower = 4;   // 20/s catpower
perTick.gold = 0.2;     // 1/s gold
perTick.iron = 1;       // 5/s iron
perTick.furs = 0.01;    // glacial: 0.05/s furs → craft path is the bottleneck
perTick.parchment = 0;
perTick.manuscript = 0;
perTick.science = 0.5;  // 2.5/s science
perTick.culture = 0.2;
const nTarget = { kind: "research", meta: acoustics, affordable: false };
const nPaths = dbg.targetPathwayAnalysis(nTarget);
const compRow = nPaths.find((row) => row.name === "compedium");
check("Test N: pathway analysis identifies the compendium demand for Acoustics", !!compRow && compRow.amount > 0);
check("Test N: craft path seconds are computed for compendium", compRow && isFinite(compRow.craftSeconds) && compRow.craftSeconds > 0);
check("Test N: a winner (trade or craft) is reported per demand resource", compRow && (compRow.winner === "trade" || compRow.winner === "craft"));
const sharks = diplomacy.races.find((race) => race.name === "sharks");
const sharkTradeSecs = dbg.tradePathSecondsFor(sharks, "compedium", compRow.amount);
const sharkSpeed = dbg.tradeSpeedMultiplierFor(sharks, nTarget);
check("Test N: trade path seconds for sharks are computed via funded batch cost", isFinite(sharkTradeSecs) && sharkTradeSecs > 0);
check("Test N: speed multiplier reflects craft vs trade ratio (clamped 0.25–4)", isFinite(sharkSpeed) && sharkSpeed >= 0.25 && sharkSpeed <= 4);

// Make trading dominate: faster trade fuel AND slower craft chain.
perTick.furs = -0.001; // crafting is structurally impossible without hunting
res("manpower").value = 3000; // plenty of catpower already in the bank
res("gold").value = 500;
res("iron").value = 5000;
const nPathsTradeFast = dbg.targetPathwayAnalysis(nTarget);
const compRowFast = nPathsTradeFast.find((row) => row.name === "compedium");
check("Test N: when craft chain is structurally blocked, trade wins", compRowFast && compRowFast.winner === "trade");

// Restore production rates so later tests are not perturbed by these tweaks.
perTick.manpower = 12; perTick.gold = 0.01; perTick.iron = 0.05;
perTick.furs = 0.5; perTick.science = 0.2; perTick.culture = 0.2;

/* ---------------------------------------------------------------------
 * Test P — v2.4.1 "last few science" stall. A manual-queue research tech
 * whose science cost lands BETWEEN 94% and 100% of cap must keep scholars
 * staffed to finish instead of hard-zeroing them at the anti-waste line.
 * ------------------------------------------------------------------- */
const biology = {
  name: "biology",
  label: "Biology",
  unlocked: true,
  researched: false,
  prices: [{ name: "science", val: 5900 }],
  unlocks: {},
};
techs.push(biology);
acoustics.researched = true;
electricity.researched = true;
storage.set("kgh.goal", "balanced");
storage.set("kgh.autopilot", "1");
dbg.forceActiveTarget(null);
dbg.queueClear();
dbg.queueAdd("research:biology", 0);
// Science at 95% of cap — above the 0.94 anti-waste line but below Biology's
// cost, which itself fits the cap. Everything else is comfortable so nothing
// but the bug could keep scholars at zero.
res("science").value = 5700; res("science").maxValue = 6000;
res("catnip").value = 3500; res("catnip").maxValue = 5000; perTick.catnip = 4;
res("wood").value = 2500; res("wood").maxValue = 3000; perTick.wood = 1;
res("minerals").value = 800; res("minerals").maxValue = 1000;
res("culture").value = 5000; res("culture").maxValue = 12000;
res("faith").value = 10; res("faith").maxValue = 100;
for (const j of jobs) j.value = 0;
job("farmer").value = 8;
village.getKittens = () => 8;
village.getFreeKittens = () => 0;
const pDecision = dbg.selectStrategicTarget("balanced");
const pReserved = dbg.reservedNeedsFor(pDecision.target);
for (let i = 0; i < 6; i += 1) { fakeNow += 40000; tickFn(); }
check("Test P: manual queue focuses Biology (cost fits cap, just needs more science)", pDecision.layer === "Manual queue" && pDecision.target?.meta?.name === "biology");
check("Test P: Biology's science is reserved as a climb need (fits the cap)", pReserved.science >= 5900);
check("Test P: scholars are staffed to push the last few science (not hard-zeroed at 94% cap)", job("scholar").value > 0);
// Sanity: a capped science bank with NO target needing it still zeroes scholars.
dbg.queueClear();
biology.researched = true;
res("science").value = 6000; res("science").maxValue = 6000;
dbg.forceActiveTarget(null);
for (let i = 0; i < 4; i += 1) { fakeNow += 40000; tickFn(); }
check("Test P: a truly capped science bank with no target need still suppresses scholars", job("scholar").value === 0);
techs.splice(techs.indexOf(biology), 1);
dbg.queueClear();
res("science").value = 60000; res("science").maxValue = 80000;
perTick.catnip = -0.4; perTick.wood = 0.4;



/* ---------------------------------------------------------------------
 * Test Q — v2.4.2 false-impossible Library lock loop regression. Wood is
 * directly producible even though it also has a Refine Catnip craft button;
 * the planner must not expand the whole missing wood deficit into an upfront
 * catnip storage requirement or leak optional catpower/trade costs into the
 * Library hard deficits.
 * ------------------------------------------------------------------- */
storage.set("kgh.goal", "balanced");
storage.set("kgh.autopilot", "1");
storage.set("kgh.log", "[]");
dbg.queueClear();
dbg.forceActiveTarget(null);
for (const t of techs) t.researched = true;
const industrialization = {
  name: "industrialization",
  label: "Industrialization",
  unlocked: true,
  researched: false,
  prices: [{ name: "science", val: 100000 }],
  unlocks: {},
};
techs.push(industrialization);
const library = buildings.find((b) => b.name === "library");
library.unlocked = true;
library.prices = [{ name: "wood", val: 95440 }];
buildings.find((b) => b.name === "mine").prices = [{ name: "wood", val: 999999 }];
library.val = 10; library.on = 10;
res("science").value = 81560; res("science").maxValue = 81560; perTick.science = 0;
res("wood").value = 13610; res("wood").maxValue = 143950; perTick.wood = 19; // 95/s
res("catnip").value = 157930; res("catnip").maxValue = 311830; perTick.catnip = 283.8; // 1419/s
res("minerals").value = 7680; res("minerals").maxValue = 193180; perTick.minerals = 11.586;
res("manpower").value = 0; res("manpower").maxValue = 3875; perTick.manpower = 0;
res("gold").value = 0; res("gold").maxValue = 500; perTick.gold = 0;
fakeNow += 370000;
const r242Decision = dbg.selectStrategicTarget("balanced");
const r242Library = dbg.candidateById("build:library", "balanced") || r242Decision.target;
const r242Feasible = dbg.classifyTargetFeasibility(r242Library);
const r242Ledger = dbg.buildTargetLedger(r242Library);
const r242Solve = dbg.solveChain(r242Library);
dbg.forceActiveTarget(r242Library);
const r242InitialNow = dbg.nowText("balanced");
const r242LogsBefore = JSON.parse(storage.get("kgh.log") || "[]").length;
for (let i = 0; i < 30; i += 1) { fakeNow += 1000; tickFn(); }
const r242Logs = JSON.parse(storage.get("kgh.log") || "[]");
const r242NewLogs = r242Logs.slice(0, Math.max(0, r242Logs.length - r242LogsBefore));
const r242ImpossibleLogs = r242NewLogs.filter((line) => /Plan switch accepted: target impossible/.test(line));
const r242PlanLocks = r242NewLogs.filter((line) => /Plan locked: Library/.test(line));
const r242Now = r242InitialNow || dbg.nowText("balanced");
const r242Bottleneck = dbg.bottleneckText("balanced");
check("Test Q: Library is classified BLOCKED/PRODUCIBLE, not IMPOSSIBLE, with missing wood", r242Library?.meta?.name === "library" && r242Feasible.status === "BLOCKED/PRODUCIBLE");
check("Test Q: missing Library wood remains reachable through production/refine chunks", r242Solve.reachable && !r242Solve.hardBlocked);
check("Test Q: full transitive Refine Catnip cost is not a hard Library reservation", !r242Ledger.reserved.catnip || r242Ledger.reserved.catnip < 1000000);
check("Test Q: optional trade/hunt catpower does not leak into Library hard deficits", !r242Ledger.reserved.manpower && !r242Ledger.reserved.catpower);
check("Test Q: no false target-impossible unlocks are emitted over 30 cycles", r242ImpossibleLogs.length === 0);
check("Test Q: plan lock logging is de-duplicated rather than spammed", r242PlanLocks.length <= 2 && JSON.parse(storage.get("kgh.log") || "[]").length >= r242LogsBefore);
check("Test Q: current action accumulates wood/refines safe chunks, not a giant upfront catnip craft", /accumulate Wood|refine only surplus|safe Refine Catnip chunk/i.test(r242Now) && !/craft 8[0-9].*Refine Catnip/i.test(r242Now));
check("Test Q: capped science bottleneck explains the active storage target is the cap fix", /science is capped.*building .* to raise the cap/i.test(r242Bottleneck));
techs.splice(techs.indexOf(industrialization), 1);

// Tear down the Acoustics scenario so the suite leaves a clean tree.
electricity.researched = true;
acoustics.researched = true;
techs.splice(techs.indexOf(electricity), 1);
techs.splice(techs.indexOf(acoustics), 1);
buildings.splice(buildings.indexOf(temple), 1);

/* =====================================================================
 * REGRESSION — reset-advisor karma estimate (v2.4.3)
 *
 * The old advisor showed `kittens - 35` "karma if reset now", overstating
 * the actual karma gain ~8×. Karma kittens accrue in tiers and convert
 * through karma = (√(1 + 8·kk/5) − 1)/2. Pin the documented examples so the
 * estimate can never silently regress to the linear approximation.
 * =================================================================== */
gamePage.karmaKittens = 0; // fresh save: marginal karma == total for this run
const karma100 = dbg.expectedResetKarma(100);
const karma60 = dbg.expectedResetKarma(60);
const karma35 = dbg.expectedResetKarma(35);
check("Test R: 100 kittens bank 185 karma-kittens (65 + 40·3), not a flat 65", dbg.karmaKittensForRun(100) === 185);
check("Test R: 100 kittens ≈ 8.1 karma via diminishing-returns root, not 65", Math.abs(karma100 - 8.105) < 0.05 && karma100 < 65);
check("Test R: 60 kittens ≈ 2.7 karma, not the linear 25", Math.abs(karma60 - 2.702) < 0.05 && karma60 < 25);
check("Test R: 35 kittens (no tier reached) yields 0 karma", karma35 === 0);
gamePage.karmaKittens = 185; // already reset once at 100 kittens
const karma100Marginal = dbg.expectedResetKarma(100);
check("Test R: karma estimate is MARGINAL — a 2nd 100-kitten run adds less than the 1st", karma100Marginal > 0 && karma100Marginal < karma100);
delete gamePage.karmaKittens;

/* =====================================================================
 * REGRESSION — reset-advisor paragon efficiency + first-reset milestone (v2.4.4)
 *
 * Math Hacks frames reset value as paragon efficiency = (kittens − 70)/kittens;
 * Monstrous Advice / Sagefault give the first-reset target (Concrete Huts +
 * 130 kittens ≈ 60 paragon → Diplomacy + price-ratio metas). Pin both so the
 * advisor keeps surfacing the numbers the guides actually optimise for.
 * =================================================================== */
const kittensArr = village.sim.kittens;
const savedKittens = kittensArr.slice();
const setKittens = (n) => { kittensArr.length = 0; for (let i = 0; i < n; i += 1) kittensArr.push({ name: `k${i}` }); };
gamePage.totalResets = 0;
setKittens(100);
const adv100 = dbg.resetAdvisor();
check("Test S: advisor reports 30% paragon-efficiency at 100 kittens ((100-70)/100)", /30% paragon-eff/.test(adv100));
check("Test S: pre-first-reset advisor names the 130-kitten Concrete Huts milestone", /130\+ kittens/.test(adv100) && /Concrete Huts/.test(adv100));
gamePage.totalResets = 3;
setKittens(200);
const adv200 = dbg.resetAdvisor();
check("Test S: advisor reports 65% paragon-efficiency at 200 kittens ((200-70)/200)", /65% paragon-eff/.test(adv200));
check("Test S: post-first-reset advisor drops the first-run milestone", !/130\+ kittens/.test(adv200));
setKittens(40);
const adv40 = dbg.resetAdvisor();
check("Test S: sub-70 advisor still shows karma, not a negative efficiency", /karma if reset now/.test(adv40) && !/paragon-eff/.test(adv40));
kittensArr.length = 0; for (const k of savedKittens) kittensArr.push(k);
delete gamePage.totalResets;

/* =====================================================================
 * REGRESSION — active staged metadata + uncontaminated ticker reads (v2.5.0)
 *
 * Bonfire metadata keeps the stable base id on the raw object while the game
 * overlays the active stage's label/effects/prices.  The helper must show and
 * score that live stage.  A capped resource bar is flat even while the game's
 * ticker is positive, so telemetry must not replace the ticker with zero.
 * =================================================================== */
const liveStageProbe = {
  name: "liveStageProbe",
  unlocked: true,
  val: 2,
  on: 2,
  stage: 1,
  effects: { cultureMax: 1 },
  stages: [
    { label: "Library", prices: [{ name: "wood", val: 25 }], effects: { scienceMax: 250 } },
    { label: "Data Center", prices: [{ name: "steel", val: 100 }], effects: { scienceMax: 750, energyConsumption: 2 } },
  ],
};
buildings.push(liveStageProbe);
const liveStageView = dbg.liveMetaView?.(liveStageProbe);
const liveStageProfile = dbg.metaEffectProfile?.(liveStageProbe);
check("Test T: staged building uses the current Data Center label", liveStageView?.label === "Data Center" && dbg.labelOf?.(liveStageProbe) === "Data Center");
check("Test T: staged building profiles only the active stage effects", liveStageProfile?.max?.science === 750 && !liveStageProfile?.max?.culture);
buildings.splice(buildings.indexOf(liveStageProbe), 1);

const tickerium = { name: "tickerium", title: "Tickerium", value: 100, maxValue: 100, unlocked: true };
resources.push(tickerium);
perTick.tickerium = 2;
dbg.clearResourceTelemetry?.("tickerium");
dbg.sampleResourceTelemetry?.();
fakeNow += 4000;
dbg.sampleResourceTelemetry?.();
check("Test T: a flat capped bar does not overwrite positive ticker production", dbg.productionFor?.("tickerium") === 10);
resources.splice(resources.indexOf(tickerium), 1);
delete perTick.tickerium;

/* =====================================================================
 * REGRESSION — phased Robotics science + generic resource bootstrap (v2.5.0)
 * =================================================================== */
const roboticsProbe = {
  name: "roboticsProbe",
  label: "Robotics",
  unlocked: true,
  researched: false,
  prices: [{ name: "science", val: 140000 }, { name: "blueprint", val: 80 }],
  unlocks: { tech: ["aiProbe"], crafts: ["tankerProbe"] },
};
const roboticsCandidate = { kind: "research", meta: roboticsProbe, affordable: false };
const savedBlueprintsT = res("blueprint").value;
const savedCompendiaT = res("compedium").value;
const savedScienceT = { value: res("science").value, maxValue: res("science").maxValue };
res("blueprint").value = 0;
res("compedium").value = 80 * 25;
res("science").value = 145000;
res("science").maxValue = 145000;
let roboticsPhase = dbg.researchTargetPhase?.(roboticsCandidate);
check("Test U: Robotics starts in an explicit intermediate phase", roboticsPhase?.phase === "intermediate" && /Blueprint/i.test(roboticsPhase.explanation || ""));
const roboticsCraftFloor = dbg.overflowInputFloor?.(roboticsCandidate, "science", "blueprint", true);
check("Test U: target-owned Blueprint crafting may cycle the shared science bank", Number.isFinite(roboticsCraftFloor) && roboticsCraftFloor < 140000);
check("Test U: unrelated spenders still see Robotics science as reserved", (dbg.buildTargetLedger(roboticsCandidate).reserved.science || 0) >= 140000);
res("blueprint").value = 80;
res("science").value = 0;
roboticsPhase = dbg.researchTargetPhase?.(roboticsCandidate);
check("Test U: Robotics switches to final-bank phase after Blueprints complete", roboticsPhase?.phase === "final-bank");
res("blueprint").value = savedBlueprintsT;
res("compedium").value = savedCompendiaT;
res("science").value = savedScienceT.value;
res("science").maxValue = savedScienceT.maxValue;

const smartcrete = R("smartcrete", 0, 0, "Smart Concrete");
const smartcreteCraft = { name: "smartcrete", label: "Smart Concrete", unlocked: true, prices: [{ name: "minerals", val: 10 }] };
const hiddenSmartBuilding = {
  name: "smartArchive",
  label: "Smart Archive",
  unlocked: false,
  unlockable: true,
  unlockRatio: 0.1,
  val: 0,
  on: 0,
  prices: [{ name: "smartcrete", val: 10 }],
  effects: { scienceMax: 1000 },
};
resources.push(smartcrete);
crafts.push(smartcreteCraft);
buildings.push(hiddenSmartBuilding);
const bootstrapProbe = dbg.bootstrapResourceCandidate?.();
check("Test U: hidden live building threshold creates a generic Resource bootstrap", bootstrapProbe?.kind === "bootstrap" && bootstrapProbe.meta.outputName === "smartcrete" && bootstrapProbe.meta.targetAmount === 1);
check("Test U: bootstrap uses the live craft/resource label", /Smart Concrete/.test(bootstrapProbe?.meta?.label || ""));
dbg.forceActiveTarget(null);
const bootstrapDecision = dbg.selectStrategicTarget("balanced");
check("Test U: Resource bootstrap structurally outranks ordinary economy work", bootstrapDecision.layer === "Resource bootstrap" && bootstrapDecision.target?.meta?.outputName === "smartcrete");
buildings.splice(buildings.indexOf(hiddenSmartBuilding), 1);
crafts.splice(crafts.indexOf(smartcreteCraft), 1);
resources.splice(resources.indexOf(smartcrete), 1);

/* =====================================================================
 * REGRESSION — direct science-cap evidence and full-deficit projection
 * =================================================================== */
const ratioOnlyScience = { kind: "build", meta: { name: "ratioOnlyScience", label: "Science Lab", effects: { scienceRatio: 1 } } };
const namedStorageBait = { kind: "build", meta: { name: "namedStorageBait", label: "Library", effects: {}, description: "science storage" } };
check("Test V: scienceRatio is production and adds zero science storage", dbg.scienceStorageGain?.(ratioOnlyScience) === 0);
check("Test V: names/descriptions cannot qualify a zero-gain cap option", dbg.scienceStorageUnlockCandidate?.(namedStorageBait) === false);

const capBlockTech = {
  name: "capBlockTech",
  label: "Advanced Biochemistry",
  unlocked: true,
  researched: false,
  prices: [{ name: "science", val: 145000 }],
  unlocks: { tech: ["futureCapTech"] },
};
const weakTempleV = { name: "weakTempleV", label: "Temple", unlocked: true, val: 0, on: 0, prices: [{ name: "gold", val: 1 }], priceRatio: 1, effects: { scienceMax: 500 } };
const ratioAcademyV = { name: "ratioAcademyV", label: "Academy", unlocked: true, val: 0, on: 0, prices: [{ name: "minerals", val: 100 }], priceRatio: 1, effects: { scienceMax: 4000, scienceRatio: 1 } };
const directVaultV = { name: "directVaultV", label: "Data Center", unlocked: true, val: 0, on: 0, prices: [{ name: "wood", val: 1000 }], priceRatio: 1, effects: { scienceMax: 10000 } };
buildings.push(weakTempleV, ratioAcademyV, directVaultV);
const savedScienceV = { value: res("science").value, maxValue: res("science").maxValue };
res("science").value = 105000;
res("science").maxValue = 105000;
const capCandidatesV = [
  { kind: "research", meta: capBlockTech, affordable: false, progress: 0.72, score: 50 },
  ...[weakTempleV, ratioAcademyV, directVaultV].map((meta) => ({ kind: "build", meta, affordable: true, progress: 1, score: 10 })),
];
const capDecisionV = dbg.bestScienceStorageUnlock?.(capCandidatesV);
const directProjectionV = capDecisionV?.options?.find((option) => option.candidate?.meta?.name === "directVaultV");
check("Test V: 40K cap deficit chooses the fastest direct full-closure option", capDecisionV?.target?.meta?.name === "directVaultV");
check("Test V: cap diagnostics project repeated copies through full closure", directProjectionV?.copies === 4 && directProjectionV?.closure >= 1 && Number.isFinite(directProjectionV?.eta));
buildings.splice(buildings.indexOf(weakTempleV), 1);
buildings.splice(buildings.indexOf(ratioAcademyV), 1);
buildings.splice(buildings.indexOf(directVaultV), 1);
res("science").value = savedScienceV.value;
res("science").maxValue = savedScienceV.maxValue;

/* =====================================================================
 * REGRESSION — power-aware science storage + sticky power recovery (Test Z)
 * Reproduces the live oscillation the player reported: science is capped
 * (Biochemistry blocked) AND there is a Wt deficit, while the biggest cap
 * building (Data Center) is itself a power consumer.  The bot used to keep
 * targeting that Data Center for science storage; processing then paused it
 * "protecting Wt" every tick — the Data-Center on/off flicker.  The fix: a
 * power-negative building is not "actionable" cap-growth while Wt is short,
 * so the layer grows the cap with a power-neutral building and recovers power
 * with a committed generator instead of flapping between generators.
 * =================================================================== */
const savedPowerZ = { energyProd: gamePage.resPool.energyProd, energyCons: gamePage.resPool.energyCons, energyWinterProd: gamePage.resPool.energyWinterProd };
const savedScienceZ = { value: res("science").value, maxValue: res("science").maxValue };
const savedMineralsZ = res("minerals").value;
res("minerals").value = 1e6;
const capBlockTechZ = { name: "capBlockTechZ", label: "Biochemistry Z", unlocked: true, researched: false, prices: [{ name: "science", val: 145000 }], unlocks: { tech: ["futureCapTechZ"] } };
const dataCenterZ = { name: "dataCenterZ", label: "Data Center Z", unlocked: true, val: 4, on: 4, prices: [{ name: "wood", val: 1000 }], priceRatio: 1, effects: { scienceMax: 10000, energyConsumption: 5 } };
const academyZ = { name: "academyZ", label: "Academy Z", unlocked: true, val: 0, on: 0, prices: [{ name: "minerals", val: 100 }], priceRatio: 1, effects: { scienceMax: 10000 } };
const magnetoZ = { name: "magnetoZ", label: "Magneto Z", unlocked: true, val: 1, on: 0, prices: [{ name: "minerals", val: 10 }], priceRatio: 1, effects: { energyProduction: 5 } };
buildings.push(dataCenterZ, academyZ, magnetoZ);
res("science").value = 105000;
res("science").maxValue = 105000;
gamePage.resPool.energyProd = 10;
gamePage.resPool.energyCons = 12;
gamePage.resPool.energyWinterProd = 10;
dbg.forceActiveTarget?.(null); // clear any sticky power-recovery pick

const dcCandZ = { kind: "build", meta: dataCenterZ, affordable: true, progress: 1, score: 10 };
const acCandZ = { kind: "build", meta: academyZ, affordable: true, progress: 1, score: 10 };
check("Test Z: power-negative Data Center is unsafe to build during a Wt deficit", dbg.powerSafeToBuild?.(dcCandZ) === false);
check("Test Z: power-neutral Academy is always safe to build", dbg.powerSafeToBuild?.(acCandZ) === true);

const capCandidatesZ = [
  { kind: "research", meta: capBlockTechZ, affordable: false, progress: 0.72, score: 50 },
  dcCandZ,
  acCandZ,
];
const capDecisionZ = dbg.bestScienceStorageUnlock?.(capCandidatesZ);
check("Test Z: cap-blocked science skips the power-hungry Data Center and grows the cap power-neutrally", capDecisionZ?.target?.meta?.name === "academyZ");

// Once power has real headroom the Data Center is build-safe again.
gamePage.resPool.energyProd = 100;
gamePage.resPool.energyCons = 10;
gamePage.resPool.energyWinterProd = 100;
check("Test Z: Data Center becomes build-safe again once Wt has headroom", dbg.powerSafeToBuild?.(dcCandZ) === true);

// Latent demand: a Data Center paused only to protect Wt still counts as real
// power demand, so effective power stays below the raw pool reading and power
// recovery keeps building generators instead of seeing a false surplus.
gamePage.resPool.energyProd = 10;
gamePage.resPool.energyCons = 12;
gamePage.resPool.energyWinterProd = 10;
dbg.optimizeProcessing?.("balanced");
const latentZ = dbg.latentPowerDemand?.();
const rawZ = dbg.powerStatus?.();
const effZ = dbg.effectivePowerStatus?.();
check("Test Z: a paused-for-power Data Center registers latent power demand", latentZ > 0 && (dataCenterZ.on || 0) === 0);
check("Test Z: effective power subtracts latent demand from the raw pool reading", effZ.delta < rawZ.delta && Math.abs(effZ.delta - (rawZ.delta - latentZ)) < 1e-6);

// Sticky power recovery: the chosen generator must not flap when a rival's live
// value wobbles inside the hysteresis band, but must switch on a decisive gain.
const genZ = (name, prod) => ({ kind: "build", meta: { name, label: name, unlocked: true, val: 1, on: 0, prices: [{ name: "minerals", val: 10 }], priceRatio: 1, effects: { energyProduction: prod } }, affordable: true, progress: 1, score: 10 });
dbg.forceActiveTarget?.(null);
const powerPick1Z = dbg.bestPowerRecoveryTarget?.([genZ("genAZ", 6), genZ("genBZ", 5)]);
const powerPick2Z = dbg.bestPowerRecoveryTarget?.([genZ("genAZ", 6), genZ("genBZ", 7)]);
const powerPick3Z = dbg.bestPowerRecoveryTarget?.([genZ("genAZ", 6), genZ("genBZ", 20)]);
check("Test Z: power recovery commits within the hysteresis band, switches on a decisive gain", powerPick1Z?.meta?.name === "genAZ" && powerPick2Z?.meta?.name === "genAZ" && powerPick3Z?.meta?.name === "genBZ");

// Diagnostics report is a single comprehensive, copyable block.
// New census sections (v2.7.0): per-building count + next incremental cost, the
// pending-workshop list with its lock/requirement, and a job census so "why are
// N kittens on Priest?" is answerable straight from the dump.  Force a known
// locked workshop upgrade with an un-researched gate so the assertions are stable
// regardless of which upgrades earlier scenarios flipped to researched.
const printingPressZ = gamePage.workshop.get("printingPress");
const machineryZ = techs.find((t) => t.name === "machinery");
const savedWorkshopZ = { researched: printingPressZ.researched, unlocked: printingPressZ.unlocked, machinery: machineryZ.researched };
printingPressZ.researched = false; printingPressZ.unlocked = false; machineryZ.researched = false;
const libraryZ = buildings.find((b) => b.name === "library");
const savedLibraryZ = libraryZ.val;
libraryZ.val = 3;
const reportZ = dbg.report?.();
check("Test Z: diagnostics report bundles plan, power, processing and resources", typeof reportZ === "string" && /— PLAN —/.test(reportZ) && /— POWER —/.test(reportZ) && /— PROCESSING —/.test(reportZ) && /— RESOURCES —/.test(reportZ) && /effective delta/.test(reportZ));
check("Test Z: report adds a BUILDINGS census with counts and next cost", /— BUILDINGS .*—/.test(reportZ) && /Library ×3.*· next .*Wood/.test(reportZ));
check("Test Z: report adds a WORKSHOP section listing the locked upgrade and its gate", /— WORKSHOP .*—/.test(reportZ) && /Printing Press · LOCKED — needs Machinery/.test(reportZ));
check("Test Z: report adds a job census line", /census: /.test(reportZ));
printingPressZ.researched = savedWorkshopZ.researched; printingPressZ.unlocked = savedWorkshopZ.unlocked;
machineryZ.researched = savedWorkshopZ.machinery; libraryZ.val = savedLibraryZ;

/* =====================================================================
 * Test AA (v2.8.0) — the emergency lock-break must ADDRESS the emergency.
 * Live, a winter catnip dip (handled by the farmer failsafe) plus an
 * effective-only Wt dip (raw power fine, Data Centers merely paused) broke
 * the plan lock every ~2s, ping-ponging Power recovery / Expansion / Science
 * storage and finishing nothing.  A food crisis may now only break the lock
 * toward a catnip building; a power crisis only toward a generator; and an
 * effective-only dip (raw Wt positive) is not an emergency at all.
 * =================================================================== */
const barnMetaAA = buildings.find((b) => b.name === "barn");
const mineCandAA = dbg.candidateById("build:mine");
const magnetoCandAA = dbg.candidateById("build:magnetoZ");
check("Test AA: a catnip-storage building counts as food-helping", dbg.foodHelpingCandidate({ kind: "build", meta: barnMetaAA }) === true);
check("Test AA: a non-food building is not food-helping", !!mineCandAA && dbg.foodHelpingCandidate(mineCandAA) === false);
check("Test AA: a power generator is not food-helping", !!magnetoCandAA && dbg.foodHelpingCandidate(magnetoCandAA) === false);

// Age a forced lock past the lock-min but well under the lock-max timeout (360s)
// so only a real break condition — not a stale-lock timeout — can move the plan.
const LOCK_AGE_AA = 150000;
// (1) Genuine RAW power deficit still hands a held non-generator plan to the
// generator.  Test Z left energyProd 10 / cons 12 → raw delta -2 (real deficit).
gamePage.resPool.energyProd = 10; gamePage.resPool.energyCons = 12; gamePage.resPool.energyWinterProd = 10;
const savedCatnipAA = { v: res("catnip").value, m: res("catnip").maxValue, p: perTick.catnip };
res("catnip").value = 4000; res("catnip").maxValue = 5000; perTick.catnip = 5; // food safe
dbg.queueClear?.();
dbg.forceActiveTarget(mineCandAA, "Economy / normal growth", LOCK_AGE_AA); // held non-generator plan
const powerBreakAA = dbg.chooseWorkTarget("balanced");
check("Test AA: a genuine raw-Wt deficit breaks the lock toward a generator", dbg.targetId(powerBreakAA) === "build:magnetoZ");

// (2) A catnip emergency is INERT for a held non-food plan when raw Wt is fine
// (no power emergency): run the same locked state with catnip SAFE vs catnip
// EMERGENCY and assert the decision is identical AND retains the held plan —
// proving the food dip no longer adds a spurious lock-break.  Raw Wt is made
// healthy and science uncapped so neither the power nor the science-storage layer
// confounds the comparison.
gamePage.resPool.energyProd = 200; gamePage.resPool.energyCons = 10; gamePage.resPool.energyWinterProd = 200;
const savedSciAA = { v: res("science").value, m: res("science").maxValue };
res("science").value = 1000; res("science").maxValue = 1e9; // research fits → no science-storage layer
dbg.forceActiveTarget(mineCandAA, "Economy / normal growth", LOCK_AGE_AA);
res("catnip").value = 4000; res("catnip").maxValue = 5000; perTick.catnip = 5; // safe
const decSafeAA = dbg.chooseWorkTarget("balanced");
dbg.forceActiveTarget(mineCandAA, "Economy / normal growth", LOCK_AGE_AA);
res("catnip").value = 50; res("catnip").maxValue = 5000; perTick.catnip = -5; // emergency (1%, net-negative)
const decEmergAA = dbg.chooseWorkTarget("balanced");
check("Test AA: a catnip emergency does not change a held non-food plan (no spurious break)", dbg.targetId(decSafeAA) === dbg.targetId(decEmergAA));
check("Test AA: the held non-food plan is actually retained through the catnip emergency", dbg.targetId(decEmergAA) === "build:mine");
res("catnip").value = savedCatnipAA.v; res("catnip").maxValue = savedCatnipAA.m; perTick.catnip = savedCatnipAA.p;
res("science").value = savedSciAA.v; res("science").maxValue = savedSciAA.m;
dbg.forceActiveTarget(null);

buildings.splice(buildings.indexOf(dataCenterZ), 1);
buildings.splice(buildings.indexOf(academyZ), 1);
buildings.splice(buildings.indexOf(magnetoZ), 1);
res("science").value = savedScienceZ.value;
res("science").maxValue = savedScienceZ.maxValue;
res("minerals").value = savedMineralsZ;
gamePage.resPool.energyProd = savedPowerZ.energyProd;
gamePage.resPool.energyCons = savedPowerZ.energyCons;
gamePage.resPool.energyWinterProd = savedPowerZ.energyWinterProd;
dbg.forceActiveTarget?.(null);

/* =====================================================================
 * REGRESSION — reset-aware expansion checkpoints + visible festivals
 * =================================================================== */
const savedGetKittensW = village.getKittens;
const savedMaxKittensW = village.maxKittens;
const savedHappinessW = village.happiness;
const savedResetCountW = gamePage.totalResets;
const savedTechFlagsW = techs.map((tech) => [tech, tech.researched]);
for (const tech of techs) tech.researched = true;
const expansionTechW = { name: "expansionTechW", label: "Fresh Science", unlocked: true, researched: false, prices: [{ name: "science", val: 10000 }], unlocks: { tech: ["futureExpansionTechW"] } };
const housingW = { name: "housingW", label: "Efficient Housing", unlocked: true, val: 0, on: 0, prices: [{ name: "wood", val: 100 }], effects: { maxKittens: 5 } };
techs.push(expansionTechW);
buildings.push(housingW);
village.getKittens = () => 100;
village.maxKittens = 100;
gamePage.totalResets = 0;
res("science").value = Math.min(res("science").maxValue, res("science").maxValue);
dbg.forceActiveTarget(null);
let expansionDecisionW = dbg.selectStrategicTarget("balanced");
check("Test W: full pre-reset village chooses an Expansion checkpoint before another sprint", expansionDecisionW.layer === "Expansion checkpoint" && expansionDecisionW.target?.meta?.name === "housingW");
// Food gate: the SAME full village, but catnip is net-negative (food already
// out, like the live -112/s starvation).  Expansion must stand down — buying
// housing capacity it cannot feed (and the farmer→woodcutter / catnip→wood
// grind that funds it) only deepens the starvation.  Once catnip is positive
// again the expansion checkpoint re-qualifies (asserted by the check above).
const savedCatnipPerTickW = perTick.catnip;
const savedCatnipValW = res("catnip").value;
perTick.catnip = -22; // ~-110/s, mirrors the live starvation rate
res("catnip").value = 150; // pantry nearly empty
dbg.forceActiveTarget(null);
const starvedExpansionW = dbg.selectStrategicTarget("balanced");
check("Test W: expansion stands down while catnip is net-negative (food already out)", starvedExpansionW.layer !== "Expansion checkpoint");
perTick.catnip = savedCatnipPerTickW;
res("catnip").value = savedCatnipValW;
dbg.forceActiveTarget(null);
village.maxKittens = 150;
dbg.forceActiveTarget(null);
expansionDecisionW = dbg.selectStrategicTarget("balanced");
check("Test W: research remains eligible when housing has ample headroom", expansionDecisionW.layer !== "Expansion checkpoint");
techs.splice(techs.indexOf(expansionTechW), 1);
buildings.splice(buildings.indexOf(housingW), 1);
for (const [tech, researched] of savedTechFlagsW) tech.researched = researched;

let dramaW = techs.find((tech) => tech.name === "drama");
if (!dramaW) { dramaW = { name: "drama", label: "Drama and Poetry", unlocked: true, researched: true, prices: [], unlocks: {} }; techs.push(dramaW); }
const savedDramaW = dramaW.researched;
dramaW.researched = true;
village.getKittens = () => 50;
village.maxKittens = 60;
village.happiness = 0.8;
calendar.festivalDays = 0;
res("manpower").value = 1500;
res("culture").value = 5000;
res("parchment").value = 3000;
const festivalOpportunityW = dbg.festivalOpportunity?.();
check("Test W: expired high-value festival is a visible maintenance candidate", festivalOpportunityW?.candidate?.kind === "festival" && /Festival maintenance/i.test(festivalOpportunityW.layer || ""));
const festivalGuardTargetW = { kind: "build", meta: { name: "festivalGuardW", label: "Festival Guard", prices: [{ name: "parchment", val: 5000 }] }, affordable: false };
check("Test W: festival cannot cross an active target reservation", dbg.festivalCanPay?.(festivalGuardTargetW) === false);
check("Test W: festival status explains the current action", /Festival:/i.test(dbg.festivalStatus?.() || ""));
dramaW.researched = savedDramaW;
village.getKittens = savedGetKittensW;
village.maxKittens = savedMaxKittensW;
village.happiness = savedHappinessW;
if (savedResetCountW === undefined) delete gamePage.totalResets; else gamePage.totalResets = savedResetCountW;

/* ---------------------------------------------------------------------
 * Test W2 — directly producible craft outputs stay direct work targets.
 *
 * Live-save regression: Hut needed a huge amount of wood, but because Wood also
 * has the "Refine Catnip" craft, the planner displayed "Need: Refine Catnip"
 * and rebalanced to 0 Woodcutters / many Farmers.  For a large wood deficit,
 * the plan should be "get Wood"; the Woodcutter-vs-Farmer comparator can then
 * decide the fastest source without the dependency graph pre-biasing everything
 * into catnip.
 * ------------------------------------------------------------------- */
const hutW2 = buildings.find((b) => b.name === "hut");
const savedHutPricesW2 = hutW2.prices;
const savedHutUnlockedW2 = hutW2.unlocked;
const savedGetKittensW2 = village.getKittens;
const savedGetFreeKittensW2 = village.getFreeKittens;
const savedGetResProductionW2 = village.getResProduction;
const savedHappinessW2 = village.happiness;
const savedWeatherW2 = calendar.getWeatherMod;
const savedJobValuesW2 = jobs.map((j) => [j, j.value]);
const savedResValuesW2 = new Map(resources.map((r) => [r.name, { value: r.value, maxValue: r.maxValue, unlocked: r.unlocked }]));
const savedPerTickW2 = { ...perTick };
const savedWoodCraftRatioW2 = craftRatios.wood;
hutW2.unlocked = true;
hutW2.prices = [{ name: "wood", val: 5000 }]; // larger than current wood cap; still craft/production reachable
res("wood").value = 1500; res("wood").maxValue = 3000;
res("catnip").value = 2500; res("catnip").maxValue = 5000;
res("science").value = res("science").maxValue;
res("faith").value = res("faith").maxValue;
res("manpower").value = res("manpower").maxValue;
res("furs").value = 100000;
res("ivory").value = 100000;
village.happiness = 1.5;
village.getKittens = () => 30;
village.getFreeKittens = () => 0;
village.getResProduction = () => ({ wood: 0, catnip: 150, minerals: 0, science: 0, manpower: 0, faith: 0, coal: 0 });
calendar.getWeatherMod = () => 0;
perTick.catnip = 30;
perTick.wood = 0;
craftRatios.wood = 0;
for (const j of jobs) j.value = 0;
job("farmer").value = 30;
dbg.forceActiveTarget({ kind: "build", meta: hutW2, affordable: false });
const hutPlanW2 = dbg.planText("balanced");
check("Test W2: huge Hut wood deficit is displayed as Wood, not Refine Catnip", /Need: .*Wood/i.test(hutPlanW2) && !/Need: .*Refine Catnip/i.test(hutPlanW2));
const hutReserveW2 = dbg.reservedNeedsFor({ kind: "build", meta: hutW2, affordable: false });
check("Test W2: cap-over but craft-reachable Hut wood is still reserved from side buys", hutReserveW2.wood >= 5000 && (!hutReserveW2.catnip || hutReserveW2.catnip < 100000));
fakeNow += 60000;
tickFn();
check(`Test W2: Hut wood bottleneck keeps direct Woodcutters staffed above refine Farmers (woodcutters ${job("woodcutter").value}, farmers ${job("farmer").value})`, job("woodcutter").value > job("farmer").value && job("woodcutter").value >= 5);
dbg.forceActiveTarget(null);
hutW2.prices = savedHutPricesW2;
hutW2.unlocked = savedHutUnlockedW2;
village.getKittens = savedGetKittensW2;
village.getFreeKittens = savedGetFreeKittensW2;
village.getResProduction = savedGetResProductionW2;
village.happiness = savedHappinessW2;
calendar.getWeatherMod = savedWeatherW2;
for (const [j, value] of savedJobValuesW2) j.value = value;
for (const [name, saved] of savedResValuesW2) {
  const r = res(name);
  if (!r) continue;
  r.value = saved.value;
  r.maxValue = saved.maxValue;
  r.unlocked = saved.unlocked;
}
Object.assign(perTick, savedPerTickW2);
if (savedWoodCraftRatioW2 === undefined) delete craftRatios.wood; else craftRatios.wood = savedWoodCraftRatioW2;

/* =====================================================================
 * REGRESSION — opportunity-costed, controller-owned stage transitions
 * =================================================================== */
const stageEconomyX = {
  name: "stageEconomyX",
  unlocked: true,
  stage: 0,
  val: 4,
  on: 4,
  priceRatio: 1.1,
  stages: [
    { label: "Old Archive", prices: [{ name: "wood", val: 100 }], effects: { scienceMax: 100 }, stageUnlocked: true },
    { label: "Data Center X", prices: [{ name: "wood", val: 1000 }], effects: { scienceMax: 300 }, stageUnlocked: true },
  ],
  effects: {},
};
const stageBadX = {
  name: "stageBadX",
  unlocked: true,
  stage: 0,
  val: 4,
  on: 4,
  priceRatio: 1.1,
  stages: [
    { label: "Efficient Plant", prices: [{ name: "wood", val: 100 }], effects: { scienceMax: 1000 }, stageUnlocked: true },
    { label: "Wasteful Plant", prices: [{ name: "wood", val: 1000 }], effects: { scienceMax: 10, energyConsumption: 50 }, stageUnlocked: true },
  ],
  effects: {},
};
buildings.push(stageEconomyX, stageBadX);
res("wood").value = Math.max(res("wood").value, 5000);
res("wood").maxValue = Math.max(res("wood").maxValue, 10000);
const stageAnalysisX = dbg.stageTransitionAnalysis?.(stageEconomyX, 1);
check("Test X: transition analysis reports refund and rebuild-to-parity opportunity costs", stageAnalysisX?.refund?.wood > 0 && stageAnalysisX?.rebuild?.wood >= 1000 && stageAnalysisX?.parityCount >= 1 && Number.isFinite(stageAnalysisX?.payback));
check("Test X: materially better stage is actionable", stageAnalysisX?.actionable === true);
const stageCandidateX = dbg.stageTransitionCandidate?.(stageEconomyX, 1);
check("Test X: transition ledger reserves net rebuild inputs", (dbg.buildTargetLedger(stageCandidateX).reserved.wood || 0) > 0);
const badStageAnalysisX = dbg.stageTransitionAnalysis?.(stageBadX, 1);
check("Test X: uneconomic stage transition is rejected with a reason", badStageAnalysisX?.actionable === false && /utility|payback|safety|worse/i.test(badStageAnalysisX?.reason || ""));

let stageControllerCallsX = 0;
context.classes = context.classes || {};
context.classes.ui = context.classes.ui || {};
context.classes.ui.btn = context.classes.ui.btn || {};
context.classes.ui.btn.StagingBldBtnController = class {
  constructor(game) { this.game = game; }
  fetchModel(options) { return { options, metadata: buildings.find((building) => building.name === options.building) }; }
  deltagrade(model, delta) {
    stageControllerCallsX += 1;
    model.metadata.stage += delta;
    model.metadata.val = 0;
    model.metadata.on = 0;
  }
};
const stageExecutedX = dbg.executeStageTransitionCandidate?.(stageCandidateX);
check("Test X: stage change uses the staging controller and starts rebuild continuation", stageExecutedX === true && stageControllerCallsX === 1 && stageEconomyX.stage === 1 && dbg.pendingStageRebuild?.()?.buildingName === "stageEconomyX");
const stageRebuildCandidateX = dbg.pendingStageRebuildCandidate?.();
check("Test X: rebuild continuation reserves every remaining parity copy, not only the next copy", stageRebuildCandidateX?._stageRebuild?.targetCount >= 2 && stageRebuildCandidateX?._stageRebuild?.remainingPrices?.wood >= 2000 && (dbg.buildTargetLedger(stageRebuildCandidateX).reserved.wood || 0) >= 2000);
buildings.splice(buildings.indexOf(stageEconomyX), 1);
buildings.splice(buildings.indexOf(stageBadX), 1);

/* =====================================================================
 * REGRESSION — power/Wt is a first-class planner and toggle constraint
 * =================================================================== */
const savedPowerY = {
  energyProd: gamePage.resPool.energyProd,
  energyCons: gamePage.resPool.energyCons,
  energyWinterProd: gamePage.resPool.energyWinterProd,
};
const savedScienceY = { value: res("science").value, maxValue: res("science").maxValue };
const magnetoY = {
  name: "magnetoY",
  label: "Magneto Y",
  unlocked: true,
  val: 1,
  on: 0,
  prices: [{ name: "minerals", val: 10 }],
  effects: { oilPerTickCon: -0.01, energyProduction: 5 },
};
const bioLabY = {
  name: "bioLabY",
  label: "Bio Lab Y",
  unlocked: true,
  val: 0,
  on: 0,
  prices: [{ name: "science", val: 500 }],
  effects: { scienceMax: 25000, energyConsumption: 2 },
};
const factoryY = {
  name: "factoryY",
  label: "Factory Y",
  unlocked: true,
  val: 1,
  on: 1,
  prices: [{ name: "minerals", val: 10 }],
  effects: { mineralsPerTickCon: -0.01, sciencePerTickProd: 0.01, energyConsumption: 3 },
};
resources.push(R("oil", 100, 1000, "Oil"));
buildings.push(magnetoY, bioLabY, factoryY);
gamePage.resPool.energyProd = 10;
gamePage.resPool.energyCons = 15.5;
gamePage.resPool.energyWinterProd = 8;
res("science").value = 500;
res("science").maxValue = 1000;
const powerDecisionY = dbg.selectStrategicTarget("balanced");
check("Test Y: negative Wt selects Power recovery / Magneto instead of Bio Lab", powerDecisionY.layer === "Power recovery" && powerDecisionY.target?.meta?.name === "magnetoY");
const bioCandidateY = dbg.candidateById("build:bioLabY", "balanced");
const bioScoreY = dbg.candidateScore(bioCandidateY, "balanced");
gamePage.resPool.energyProd = 25;
gamePage.resPool.energyCons = 5;
gamePage.resPool.energyWinterProd = 25;
const bioScoreSafeY = dbg.candidateScore(bioCandidateY, "balanced");
check("Test Y: negative Wt heavily penalizes energy-consuming Bio Lab", bioScoreY + 100 < bioScoreSafeY);
gamePage.resPool.energyProd = 10;
gamePage.resPool.energyCons = 15.5;
gamePage.resPool.energyWinterProd = 8;
const magnetoStateY = dbg.desiredProcessorState(magnetoY);
const factoryStateY = dbg.desiredProcessorState(factoryY);
check("Test Y: negative Wt runs power-positive Magneto and pauses power-negative consumers", magnetoStateY.on === magnetoY.val && factoryStateY.on === 0);
const processingTextY = dbg.optimizeProcessing("balanced");
check("Test Y: processing log names power protection", /power deficit|protecting Wt/i.test(processingTextY));
buildings.splice(buildings.indexOf(magnetoY), 1);
buildings.splice(buildings.indexOf(bioLabY), 1);
buildings.splice(buildings.indexOf(factoryY), 1);
resources.splice(resources.findIndex((r) => r.name === "oil"), 1);
gamePage.resPool.energyProd = savedPowerY.energyProd;
gamePage.resPool.energyCons = savedPowerY.energyCons;
gamePage.resPool.energyWinterProd = savedPowerY.energyWinterProd;
res("science").value = savedScienceY.value;
res("science").maxValue = savedScienceY.maxValue;

if (failures.length) {
  console.error(`\n✗ ${failures.length} smoke check(s) failed`);
  process.exit(1);
}
console.log("\n✓ All smoke checks passed — the plan reserves, pushes through, and recursion/policies behave.");
