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
  { name: "ship", label: "Ship", unlocked: true, prices: [{ name: "scaffold", val: 1 }] },
  { name: "parchment", label: "Parchment", unlocked: true, prices: [{ name: "furs", val: 175 }] },
  { name: "manuscript", label: "Manuscript", unlocked: true, prices: [{ name: "culture", val: 400 }, { name: "parchment", val: 25 }] },
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

const calendar = { festivalDays: 0 };

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
};

const perTick = { catnip: -0.4, wood: 0.4, minerals: 0.3, science: 0.2, culture: 0.2, manpower: 0.2, iron: 0.05, coal: 0.01, gold: 0.01 };

const diplomacy = {
  races: [
    { name: "lizards", title: "Lizards", unlocked: true, embassyLevel: 0, tradeTotal: 0, embassyPrices: [] },
  ],
  get: (name) => diplomacy.races.find((race) => race.name === name),
  getManpowerCost: () => 50,
  getGoldCost: () => 15,
};

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
    policies,
    get: (name) => techs.find((t) => t.name === name),
    getPrices: (meta) => (meta && meta.prices) || [],
  },
  religion: {
    faith: 200,
    religionUpgrades,
  },
  workshop: {
    upgrades: workshopUpgrades,
    crafts,
    get: (name) => workshopUpgrades.find((upgrade) => upgrade.name === name),
    getCraft: (name) => craft(name),
    getCraftPrice: (c) => (c && c.prices) || [],
    getPrices: (meta) => (meta && meta.prices) || [],
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
  getResCraftRatio: () => 0,
  ticksPerSecond: 5,
  getResourcePerTick: (name) => (Number.isFinite(perTick[name]) ? perTick[name] : 0),
  craft(name, amount) {
    const c = craft(name);
    if (!c || amount <= 0) return false;
    for (const p of c.prices) {
      if (res(p.name).value < p.val * amount) return false;
    }
    for (const p of c.prices) res(p.name).value -= p.val * amount;
    res(name).value += amount;
    return true;
  },
};

/* ------------------------------- fake KS ----------------------------------- */

const S = (extra = {}) => ({ enabled: false, ...extra });
const ksSettings = {
  engine: S({ interval: 2000, resources: S() }),
  bonfire: S({ trigger: 0.75, buildings: { library: S({ trigger: 0.9, max: 0 }), mine: S({ trigger: 0.9, max: 0 }) } }),
  science: S({
    trigger: 0.5,
    observe: S(),
    techs: { theology: S(), machinery: S(), trivia: S() },
    policies: { liberty: S(), openFairs: S() },
  }),
  religion: S({
    trigger: 0.2,
    faith: S({ trigger: 0.2 }),
    solarRevolution: S({ trigger: 0.2 }),
    adore: S(),
    sacrificeUnicorns: S(),
  }),
  space: S({ trigger: 1 }),
  time: S({ reset: S() }),
  trade: S({ trigger: 0.8 }),
  workshop: S({ crafts: { wood: S({ trigger: 0.95 }), beam: S({ trigger: 0.9 }) }, upgrades: { printingPress: S() } }),
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

check("script bootstrapped and applied KS settings", appliedSettings != null && typeof tickFn === "function");

/* Stage 1 — KS takeover + reservation holds (mine must NOT eat library wood) */
fakeNow += 5000;
tickFn();
check("KS bonfire buying disabled (helper owns builds)", appliedSettings.bonfire.enabled === false && appliedSettings.bonfire.buildings.mine.enabled === false);
check("KS tech buying disabled, star observation kept", appliedSettings.science.techs.machinery.enabled === false && appliedSettings.science.observe.enabled === true);
check("KS workshop upgrades disabled, crafts kept (catnip→wood at 50%)", appliedSettings.workshop.upgrades.printingPress.enabled === false && appliedSettings.workshop.crafts.wood.enabled === true && appliedSettings.workshop.crafts.wood.trigger === 0.5);
check("KS jobs/hunt/leader automations disabled (ours run)", appliedSettings.village.jobs.woodcutter.enabled === false && appliedSettings.village.hunt.enabled === false && appliedSettings.village.electLeader.enabled === false && appliedSettings.village.promoteLeader.enabled === false);
check("KS festivals stay on; resets/adore/sacrifice/policies stay off", appliedSettings.village.holdFestivals.enabled === true && appliedSettings.time.reset.enabled === false && appliedSettings.religion.adore.enabled === false && appliedSettings.religion.sacrificeUnicorns.enabled === false && appliedSettings.science.policies.liberty.enabled === false);
check(
  "religion progression waits to praise but still considers upgrades",
  appliedSettings.religion.trigger === 0.5
    && appliedSettings.religion.faith.trigger === 0.95
    && appliedSettings.religion.faith.enabled === false
    && appliedSettings.religion.solarRevolution.trigger === 0.25
    && /Solar Chant/.test(panelText(".kgh-religion")),
);

check("plan: Library chosen over storage-blocked Theology and cheap Mine", /Library/.test(panelText(".kgh-plan")));
check("ETA shown in plan line", /ETA/.test(panelText(".kgh-plan")));
check("plan: reservation visible in the panel", /reserving/i.test(panelText(".kgh-plan")) || /saving for/i.test(panelText(".kgh-buy")));
check("reservation: KS external spenders paused while focused plan saves", appliedSettings.trade.enabled === false && appliedSettings.space.enabled === false && appliedSettings.time.enabled === false && /paused Space\/Time\/Trade/.test(panelText(".kgh-external-spenders")));
check("reservation: affordable Mine NOT bought while Library saves up", buildings[1].val === 2);
check("policy: non-exclusive auto-bought", policies[2].researched === true);
check("policy: exclusive choices left for the player", policies[0].researched === false && policies[1].researched === false);
check("policy: panel flags the exclusive decision", /exclusive/i.test(panelText(".kgh-policy")));

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
check("crafted intermediate: upgrade bought in the same throttled tick", sawblades.researched === true && res("beam").value >= 0 && res("beam").value < 10);
check("focus panel names upgrade priority clearly", logText().includes("plan upgrade Sawblades") || /FOCUS: .*WORKSHOP UPGRADE/i.test(panelText(".kgh-plan")));

/* Cross-cutting village behaviors */
check("leader elected from traits", village.leader != null && village.leader.trait.name !== "none");
check("promotion: overflowing gold spent on kittens", promoteCalls > 0 && res("gold").value < 95);
check("jobs: starvation guard reinforced farmers (net catnip < 0)", job("farmer").value >= 3);
check("jobs: religion faith reserve directs priests", job("priest").value > 0);

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
check("recent actions: external trade resource swings are logged", /trade: .*Spice/.test(logText()) && /Gold/.test(logText()));

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
  prices: [{ name: "titanium", val: 10 }],
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
check("titanium path: catpower is saved for Zebra explorers before the first ship is ready", res("manpower").value === 400 && /paused Space\/Time\/Trade/.test(panelText(".kgh-external-spenders")));
check("titanium path: advisor explains the ship → explorer → Zebra trade route", /titanium path: craft first Ship/i.test(panelText(".kgh-plan")) && /titanium path: craft first Ship/i.test(panelText(".kgh-now")));
res("scaffold").value = 1;
res("manpower").value = 1100;
fakeNow += 25000;
tickFn();
check("titanium path: first ship crafted when titanium is blocking progression", res("ship").value >= 1);
check("titanium path: hidden Zebras discovered via explorers after first ship", zebras.unlocked === true && /Zebras|civilization/.test(logText()));
fakeNow += 25000;
tickFn();
check("titanium path: direct Zebra trade fallback obtains titanium for blocked upgrades", res("titanium").value > 0 && zebras.tradeTotal > 0);
check("titanium path: Zebra odds and ship/trade balance are shown", /ships.*%.*Ti\/trade avg.*build toward/i.test(panelText(".kgh-diplomacy")));
check("titanium path: trades fire in a batch, not one-at-a-time (faster than hand-trading)", zebras.tradeTotal > 1);


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
check("converters: an idle converter is switched ON when inputs are healthy and output wanted", blastForge.on === 3);

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
check("converters: converter restarts once the starved input recovers", blastForge.on === 3);


if (failures.length) {
  console.error(`\n✗ ${failures.length} smoke check(s) failed`);
  process.exit(1);
}
console.log("\n✓ All smoke checks passed — the plan reserves, pushes through, and recursion/policies behave.");
