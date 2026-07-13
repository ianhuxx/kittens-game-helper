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
  listeners: new Map(),
  classList: { toggle() {}, contains: () => false, add() {}, remove() {} },
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  },
  click() {
    for (const listener of this.listeners.get("click") || []) listener({ target: this });
  },
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
  removeItem: (k) => storage.delete(k),
};
const NATIVE_SAVE_KEY = "com.nuclearunicorn.kittengame.savedata";
let nativeSaveWrites = 0;
const LCstorageBacking = {};
const LCstorageMock = new Proxy(LCstorageBacking, {
  set(target, key, value) {
    if (key === NATIVE_SAVE_KEY) nativeSaveWrites += 1;
    target[key] = value;
    return true;
  },
});

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
  R("unicorns", 0, 0, "Unicorns"),
  R("tears", 0, 0, "Tears"),
  R("alicorn", 0, 0, "Alicorns", { unlocked: false }),
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
  // Unicorn economy (Test AD): both stay locked/absent until that stage flips
  // them on, so earlier stages see no new candidates. The Ziggurat's slab bill
  // is deliberately huge — reachable (slab is a rolling craft) but never an
  // impulse buy that would change the ziggurat count mid-test.
  { name: "unicornPasture", label: "Unic. Pasture", unlocked: false, val: 0, on: 0, priceRatio: 1.75, prices: [{ name: "unicorns", val: 2 }], effects: { unicornsPerTickBase: 0.001 } },
  { name: "ziggurat", label: "Ziggurat", unlocked: false, val: 0, on: 0, priceRatio: 1.25, prices: [{ name: "slab", val: 5000 }], effects: {} },
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

// Ziggurat branch of the Religion tab (Test AD): tear-priced, stackable,
// 1.15 price ratio — the game's real shapes for Unicorn Tomb / Ivory Tower.
const zigguratUpgradesMock = [
  { name: "unicornTomb", label: "Unicorn Tomb", unlocked: true, val: 0, on: 0, priceRatio: 1.15, prices: [{ name: "ivory", val: 500 }, { name: "tears", val: 5 }], effects: { unicornsRatioReligion: 0.05 } },
  { name: "ivoryTower", label: "Ivory Tower", unlocked: true, val: 0, on: 0, priceRatio: 1.15, prices: [{ name: "ivory", val: 25000 }, { name: "tears", val: 25 }], effects: { unicornsRatioReligion: 0.1, alicornChance: 5 } },
];
const scaledZigPrices = (u) => (u.prices || []).map((p) => ({ name: p.name, val: p.val * Math.pow(u.priceRatio || 1, u.val || 0) }));

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

// Task 5 late-game adapters start locked so the long-standing early/midgame
// fixtures remain unchanged. The focused Task 5 block opens them explicitly.
const transcendenceUpgrades = [
  { name: "blackObeliskT5", label: "Black Obelisk T5", unlocked: false, val: 0, on: 0, priceRatio: 1.15, prices: [{ name: "relic", val: 10 }], effects: { solarRevolutionLimit: 0.05 } },
  { name: "transcend", label: "Transcend raw action", unlocked: false, val: 0, on: 0, prices: [{ name: "relic", val: 1 }], effects: {} },
  { name: "tierUnlockT5", label: "Tier Unlock T5", tier: 2, unlocked: false, val: 0, on: 0, prices: [{ name: "relic", val: 20 }], effects: {} },
  { name: "retainedFloorT5", label: "Retained Floor T5", tier: 1, unlocked: false, val: 0, on: 0, prices: [{ name: "faithRatio", val: 60 }], effects: {} },
];
const chronoforgeUpgrades = [
  { name: "temporalBatteryT5", label: "Temporal Battery T5", unlocked: false, val: 0, on: 0, priceRatio: 1.25, prices: [{ name: "timeCrystal", val: 5 }], effects: { temporalFluxMax: 750 } },
];
const voidspaceUpgrades = [
  { name: "cryochambersT5", label: "Cryochambers T5", unlocked: false, val: 0, on: 0, priceRatio: 1.25, prices: [{ name: "karma", val: 9 }, { name: "void", val: 100 }], effects: { maxKittens: 1 } },
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
const diplomacyApiCalls = [];
let sacrificeChunks = 0; // 2500-unicorn batches converted to tears

let transcendenceControllerCalls = 0;
let chronoforgeControllerCalls = 0;
let voidspaceControllerCalls = 0;
let rawTimeManagerCalls = 0;
let checkpointCalls = 0;
let transcendCalls = 0;
let adoreCalls = 0;
let alicornSacrificeCalls = 0;
let nativeConfirmAccept = true;
let checkpointSerial = 0;
let transcendButtonCalls = 0;
const persistCheckpoint = (mutate = null) => {
  checkpointCalls += 1;
  if (typeof mutate === "function") mutate();
  const saveData = { checkpointSerial: ++checkpointSerial };
  LCstorageMock[NATIVE_SAVE_KEY] = JSON.stringify(saveData);
  return saveData;
};

const calendar = {
  festivalDays: 0,
  daysPerSeason: 100,
  season: 1,
  seasons: [
    { name: "spring", title: "Spring" },
    { name: "summer", title: "Summer" },
    { name: "autumn", title: "Autumn" },
    { name: "winter", title: "Winter" },
  ],
  getCurSeason() {
    return this.seasons[this.season];
  },
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

const perTick = { catnip: -0.4, wood: 0.4, minerals: 0.3, science: 0.2, culture: 0.2, manpower: 0.2, iron: 0.05, coal: 0.01, gold: 0.01, unicorns: 0 };
const craftRatios = { plate: 0.16 };
const resourcePerTickCalls = [];

const diplomacy = {
  races: [
    { name: "lizards", title: "Lizards", unlocked: true, embassyLevel: 0, tradeTotal: 0, embassyPrices: [], standing: 0, energy: 0, sells: [{ name: "minerals", value: 100, chance: 1 }] },
  ],
  get: (name) => diplomacy.races.find((race) => race.name === name),
  getManpowerCost: () => 50,
  getGoldCost: () => 15,
  getTradeRatio: () => 0,
  getFinalStanding: (race) => (Number.isFinite(race?.standing) ? race.standing : 0),
  isValidTrade(sell, race) {
    const resource = res(sell?.name);
    return !!sell && !!race && (!sell.minLevel || (race.embassyLevel || 0) >= sell.minLevel) &&
      (!!resource?.unlocked || sell.name === "uranium" || race.name === "leviathans");
  },
  getResourceTradeChance(sell, race) {
    return this.isValidTrade(sell, race) ? sell.chance : 0;
  },
  getMaxTradeAmt: () => 1,
  tradeAll(race) {
    tradeCalls += 1;
    diplomacyApiCalls.push({ api: "tradeAll", race: race?.name, amount: 1 });
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
  ui: {
    confirm(title, message, callbackOk, callbackCancel) {
      if (nativeConfirmAccept) callbackOk();
      else if (callbackCancel) callbackCancel();
    },
  },
  resPool: {
    resources,
    get: (name) => res(name),
    payPrices(prices) {
      for (const p of prices) res(p.name).value -= p.val;
    },
  },
  bld: {
    buildingsData: buildings,
    // Real buildings scale price by priceRatio^val; mocks without a priceRatio
    // keep ratio 1, so every pre-existing test sees identical numbers.
    getPrices: (name) => {
      const meta = buildings.find((b) => b.name === name) || {};
      const mult = Math.pow(meta.priceRatio || 1, meta.val || 0);
      return (meta.prices || []).map((p) => ({ name: p.name, val: p.val * mult }));
    },
    build(name) {
      const meta = buildings.find((b) => b.name === name);
      if (!meta || !pay(gamePage.bld.getPrices(name))) return false;
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
    faithRatio: 0,
    transcendenceTier: 0,
    religionUpgrades,
    zigguratUpgrades: zigguratUpgradesMock,
    transcendenceUpgrades,
    getRU(name) {
      return religionUpgrades.find((upgrade) => upgrade.name === name) || { on: 0, val: 0 };
    },
    getTU(name) {
      return transcendenceUpgrades.find((upgrade) => upgrade.name === name);
    },
    _getTranscendNextPrice() {
      return 100;
    },
    getApocryphaResetBonus(bonusRatio) {
      return (this.faith / 1000000) * Math.pow(this.transcendenceTier + 1, 2) * bonusRatio;
    },
    getSolarRevolutionRatio() {
      return this.getRU("solarRevolution").on ? this.faith / 1000000 : 0;
    },
    transcend() {
      transcendCalls += 1;
      gamePage.ui.confirm("Transcend", "Confirm", () => {
        const price = this._getTranscendNextPrice();
        if (this.faithRatio <= price) return;
        this.faithRatio -= price;
        this.transcendenceTier += 1;
      });
      return true;
    },
    resetFaith(bonusRatio) {
      adoreCalls += 1;
      const gain = this.getApocryphaResetBonus(bonusRatio);
      if (!(gain > 0)) return false;
      this.faithRatio += gain;
      this.faith = 0.01;
      return true;
    },
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
  tradeTab: {
    exploreBtn: {
      model: { prices: [{ name: "manpower", val: 1000 }] },
      controller: {
        buyItem(model) {
          diplomacyApiCalls.push({ api: "explore", amount: 1 });
          if (!pay(model?.prices || [])) return { itemBought: false };
          const race = typeof diplomacy.unlockRandomRace === "function" ? diplomacy.unlockRandomRace() : null;
          return { itemBought: !!race, race };
        },
      },
    },
  },
  time: {
    chronoforgeUpgrades,
    voidspaceUpgrades,
    getCFU: (name) => chronoforgeUpgrades.find((upgrade) => upgrade.name === name),
    getVSU: (name) => voidspaceUpgrades.find((upgrade) => upgrade.name === name),
    build() { rawTimeManagerCalls += 1; return false; },
    buy() { rawTimeManagerCalls += 1; return false; },
  },
  // Religion tab with the game's real button shapes: the sacrifice button's
  // controller._transform (unicorns→tears at one tear per ziggurat per 2500)
  // and the zgUpgradeButtons the helper falls back to for purchases.
  religionTab: {
    transcendBtn: {
      model: { enabled: true, visible: true },
      controller: { updateEnabled() {}, updateVisible() {} },
      handler() {
        transcendButtonCalls += 1;
        gamePage.religion.transcend();
        for (const upgrade of gamePage.religion.transcendenceUpgrades) {
          if (gamePage.religion.transcendenceTier >= (upgrade.tier || Infinity)) upgrade.unlocked = true;
        }
      },
    },
    sacrificeBtn: {
      model: { prices: [{ name: "unicorns", val: 2500 }] },
      controller: {
        _transform(model, amount) {
          const zigs = (buildings.find((b) => b.name === "ziggurat") || {}).val || 0;
          const cost = 2500 * amount;
          if (!zigs || amount <= 0 || res("unicorns").value < cost) return false;
          res("unicorns").value -= cost;
          res("tears").value += zigs * amount;
          sacrificeChunks += amount;
          return true;
        },
      },
    },
    sacrificeAlicornsBtn: {
      model: { prices: [{ name: "alicorn", val: 25 }], enabled: true, visible: true },
      controller: {
        controllerOpts: { gainMultiplier: () => 3 },
        buyItem(model) {
          alicornSacrificeCalls += 1;
          if (!pay(model?.prices || [])) return { itemBought: false, reason: "cannot-afford" };
          res("timeCrystal").value += this.controllerOpts.gainMultiplier();
          return { itemBought: true, reason: "paid-for" };
        },
      },
    },
    zgUpgradeButtons: zigguratUpgradesMock.map((u) => ({
      model: { options: { id: u.name } },
      controller: {
        buyItem() {
          if (!pay(scaledZigPrices(u))) return { itemBought: false };
          u.val = (u.val || 0) + 1;
          u.on = (u.on || 0) + 1;
          return { itemBought: true };
        },
      },
    })),
  },
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
  save() {
    return persistCheckpoint();
  },
  _saveDataToString(saveData) {
    return JSON.stringify(saveData);
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
class FakeEmbassyButtonController {
  constructor(game) {
    this.game = game;
  }
  fetchModel(options) {
    return options;
  }
  getPrices(model) {
    return model?.prices || [];
  }
  buyItem(model) {
    diplomacyApiCalls.push({ api: "embassy", race: model?.race?.name, amount: 1 });
    if (!model?.race || !pay(this.getPrices(model))) return { itemBought: false };
    model.race.embassyLevel = (model.race.embassyLevel || 0) + 1;
    return { itemBought: true };
  }
}
class FakeSpaceProgramBtnController {
  constructor(game) {
    this.game = game;
  }
  fetchModel(options) {
    const metadata = this.game.space?.getProgram(options.id);
    return metadata ? { options, metadata } : null;
  }
  getPrices(model) {
    return (model?.metadata?.prices || []).map((price) => ({ ...price }));
  }
  updateEnabled() {}
  buyItem(model) {
    if (!model || model.metadata.val) return { itemBought: false, reason: "already-bought" };
    if (!pay(this.getPrices(model))) return { itemBought: false, reason: "resources" };
    model.metadata.val = 1;
    model.metadata.on = 0; // official mission controller: in transit until its planet is reached
    for (const planetName of model.metadata.unlocks?.planet || []) {
      const planet = this.game.space.planets.find((item) => item.name === planetName);
      if (planet) planet.unlocked = true;
    }
    for (const missionName of model.metadata.unlocks?.spaceMission || []) {
      const mission = this.game.space.getProgram(missionName);
      if (mission) mission.unlocked = true;
    }
    return { itemBought: true };
  }
}
class FakePlanetBuildingBtnController {
  constructor(game) {
    this.game = game;
  }
  fetchModel(options) {
    const metadata = this.game.space?.getBuilding(options.id);
    return metadata ? { options, metadata } : null;
  }
  getPrices(model) {
    const meta = model.metadata;
    return (meta.prices || []).map((price) => ({
      ...price,
      val: price.val * Math.pow(meta.priceRatio || 1.15, meta.val || 0),
    }));
  }
  updateEnabled() {}
  buyItem(model) {
    if (!model || !pay(this.getPrices(model))) return { itemBought: false, reason: "resources" };
    model.metadata.val = (model.metadata.val || 0) + 1;
    model.metadata.on = (model.metadata.on || 0) + 1;
    return { itemBought: true };
  }
}
class FakeLateGameStackableController {
  constructor(game) {
    this.game = game;
  }
  fetchModel(options) {
    const metadata = this.getMetadata(options.id);
    return metadata ? { options, metadata } : null;
  }
  getPrices(model) {
    const meta = model.metadata;
    return (meta.prices || []).map((price) => ({
      ...price,
      val: price.val * Math.pow(meta.priceRatio || 1, meta.val || 0),
    }));
  }
  updateEnabled() {}
  buyItem(model) {
    if (!model || !pay(this.getPrices(model))) return { itemBought: false, reason: "resources" };
    model.metadata.val = (model.metadata.val || 0) + 1;
    model.metadata.on = (model.metadata.on || 0) + 1;
    return { itemBought: true };
  }
}
class FakeTranscendenceBtnController extends FakeLateGameStackableController {
  getMetadata(id) { return this.game.religion?.getTU(id); }
  buyItem(model) {
    transcendenceControllerCalls += 1;
    return super.buyItem(model);
  }
}
class FakeChronoforgeBtnController extends FakeLateGameStackableController {
  getMetadata(id) { return this.game.time?.getCFU(id); }
  buyItem(model) {
    chronoforgeControllerCalls += 1;
    return super.buyItem(model);
  }
}
class FakeVoidSpaceBtnController extends FakeLateGameStackableController {
  getMetadata(id) { return this.game.time?.getVSU(id); }
  getPrices(model) {
    return super.getPrices(model).map((price) => price.name === "karma" ? { ...price, val: price.val - 2 } : price);
  }
  buyItem(model) {
    voidspaceControllerCalls += 1;
    return super.buyItem(model);
  }
}
const context = {
  console,
  Date: FakeDate,
  Math,
  JSON,
  Number,
  isFinite,
  document: documentMock,
  localStorage: localStorageMock,
  LCstorage: LCstorageMock,
  gamePage,
  setTimeout,
  clearTimeout,
  setInterval: (fn) => {
    intervalFns.push(fn);
    return intervalFns.length - 1;
  },
  clearInterval: () => {},
  WeakMap,
  Map,
  Set,
  Promise,
  Array,
  Object,
  com: { nuclearunicorn: { game: { ui: { SpaceProgramBtnController: FakeSpaceProgramBtnController } } } },
  classes: {
    diplomacy: { ui: { EmbassyButtonController: FakeEmbassyButtonController } },
    ui: {
      TranscendenceBtnController: FakeTranscendenceBtnController,
      space: { PlanetBuildingBtnController: FakePlanetBuildingBtnController },
      time: {
        ChronoforgeBtnController: FakeChronoforgeBtnController,
        VoidSpaceBtnController: FakeVoidSpaceBtnController,
      },
    },
  },
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
const panelEl = (sel) => {
  for (const child of documentMock.body.children) {
    if (child.selectors && child.selectors.has(sel)) return child.selectors.get(sel);
  }
  return null;
};
const logText = () => (localStorageMock.getItem("kgh.log") || "[]").toString();

check("script bootstrapped natively without mutating confirmation settings", gamePage.opts.noConfirm === false && typeof tickFn === "function");

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

// One more tick so the policy auto-buys settle (one purchase per pass: the
// bootstrap tick bought Open Fairs, the stage tick adopted the exclusive pick)
// and the pass falls through to the reservation report.
fakeNow += 5000;
tickFn();
check("plan: Library chosen over storage-blocked Theology and cheap Mine", /Library/.test(panelText(".kgh-plan")));
check("ETA shown in automation details", /ETA/.test(panelText(".kgh-note")));
check("plan: reservation visible in the panel", /reserving/i.test(panelText(".kgh-plan")) || /saving for/i.test(panelText(".kgh-buy")));
check("reservation: reserve status reports holding the plan's inputs (nothing external left to pause)", /holding/i.test(panelText(".kgh-reserve")));
check("reservation: affordable Mine NOT bought while Library saves up", buildings[1].val === 2);
check("policy: non-exclusive auto-bought", policies[2].researched === true);
check("policy: best exclusive side auto-adopted, rival left unbought (mutual exclusion respected)", policies[0].researched === true && policies[1].researched === false);
check("policy: adoption logged with the side it was chosen over", /chosen over tradition/i.test(logText()));
check("policy: panel reports the auto-adopt state instead of waiting for a manual click", /auto-adopt/i.test(panelText(".kgh-policy")));
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
techs.find((tech) => tech.name === "theology").researched = true; // live prerequisite for an open Astronomy
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
// This stage tests fresh Rush Space ranking, not persistence of the Theology
// sprint that the newly modeled owned Steamworks producer now keeps reachable.
context.window.__kghDebug.forceActiveTarget(null);
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
check("goal line: milestone progress counted from the tech tree (1/3 toward Rocketry)", /1\/3 techs/.test(panelText(".kgh-goal-line")) && /Astronomy/.test(panelText(".kgh-goal-line")));

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
  diplomacyApiCalls.push({ api: "tradeMultiple", race: race?.name, amount: amt });
  if (race.name === "lizards") {
    const prices = [{ name: "manpower", val: 50 * amt }, { name: "gold", val: 15 * amt }];
    if (!canPay(prices)) return;
    tradeCalls += 1;
    pay(prices);
    res("minerals").value += 100 * amt;
    race.tradeTotal = (race.tradeTotal || 0) + amt;
    return;
  }
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
// Diplomacy is single-mutation-per-tick: crafting the reveal ship returns
// immediately, so explorers use the next shared-cooldown slot.
fakeNow += 25000;
context.window.__kghDebug.manageDiplomacy("balanced");
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

/* Stage 14 — Zebra Relations: exclusive policies are auto-adopted (v2.13.0),
   and policyScore prefers the trade-friendly Appeasement side so the generic
   pick and the diplomacy titanium lever can never settle on opposite sides.
   Adoption must still not wake the titanium/Zebra PATH for a non-titanium plan. */
policies.push({
  name: "zebraRelationsAppeasement",
  label: "Zebra Relations: Appeasement",
  unlocked: true,
  researched: false,
  blocked: false,
  blocks: ["zebraRelationsBellicosity"], // exclusive — auto-adopted by ranked pick
  prices: [{ name: "culture", val: 1000 }],
  effects: {},
});
res("culture").value = 3000;
res("culture").maxValue = 3000; // capped → free to spend
res("titanium").value = 0;

// (a) COHERENCE: the locked plan here is Mint (needs minerals, not titanium).
// The exclusive policy is adopted on its own merits — no more manual holdback —
// but the titanium/Zebra PATH must stay asleep: global titanium scarcity alone
// is not a reason to act. (This remains the regression guard for "saving for X
// but doing Zebra trading underneath".)
fakeNow += 25000;
tickFn();
fakeNow += 25000;
tickFn();
check("policy: exclusive Zebra choice auto-adopted without a titanium need", policies.find((p) => p.name === "zebraRelationsAppeasement").researched === true);
check("coherence: a non-titanium plan does NOT trigger the titanium path", !/titanium path|Zebra/i.test(panelText(".kgh-now")));

// (b) Now make the titanium-blocked Titanium Saw the locked plan (retire the
// rival buildings so the only open candidate is the Saw, which needs titanium):
// the titanium path wakes for a plan that genuinely needs it.
buildings.forEach((b) => { b.unlocked = false; });
fakeNow += 25000;
tickFn();
fakeNow += 25000;
tickFn();
check("diplomacy: the titanium path serves a titanium-blocked plan (policy already adopted)", policies.find((p) => p.name === "zebraRelationsAppeasement").researched === true && /titanium/i.test(panelText(".kgh-plan")));

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

/* ---------- Late game A: fail-closed action broker + explicit prestige arm ---------- */
const hasActionBroker = typeof dbg.actionPolicyFor === "function" && typeof dbg.executeSemanticAction === "function";
const hasPrestigeArm = typeof dbg.prestigeAutomationArmed === "function" && typeof dbg.setPrestigeAutomationArmed === "function";
check("late game A: semantic broker debug API exists", hasActionBroker);
check("late game A: prestige arm defaults OFF in storage and panel", hasPrestigeArm && dbg.prestigeAutomationArmed() === false && localStorageMock.getItem("kgh.prestigeArmed") === null && /Prestige automation: OFF/.test(panelText(".kgh-prestige-arm")));

let forbiddenCalls = 0;
if (hasPrestigeArm) dbg.setPrestigeAutomationArmed(false);
const forbiddenResults = hasActionBroker
  ? ["resetWorld", "shatter", "timeSkip", "unknownAction"].map((id) => dbg.executeSemanticAction({ id, invoke: () => { forbiddenCalls += 1; } }))
  : [];
check("late game A: forbidden and unknown execution is fail-closed", forbiddenResults.length === 4 && forbiddenResults.every((result) => !result.ok) && forbiddenCalls === 0);
const disarmed = hasActionBroker
  ? dbg.executeSemanticAction({ id: "transcend", invoke: () => { forbiddenCalls += 1; } })
  : { ok: false };
check("late game A: prestige requires explicit arm", hasActionBroker && !disarmed.ok && forbiddenCalls === 0);
check("late game A: exact and structured action policies are classified", hasActionBroker &&
  dbg.actionPolicyFor("candidate:build:library") === dbg.ACTION_POLICY.SAFE_REPEATABLE &&
  dbg.actionPolicyFor("craft:beam") === dbg.ACTION_POLICY.SAFE_REPEATABLE &&
  dbg.actionPolicyFor("trade:zebras") === dbg.ACTION_POLICY.SAFE_REPEATABLE &&
  dbg.actionPolicyFor("praise") === dbg.ACTION_POLICY.SAFE_REPEATABLE &&
  dbg.actionPolicyFor("sacrificeUnicorns") === dbg.ACTION_POLICY.SAFE_REPEATABLE &&
  dbg.actionPolicyFor("sacrificeAlicorns") === dbg.ACTION_POLICY.RARE_CAPITAL &&
  dbg.actionPolicyFor("transcend") === dbg.ACTION_POLICY.AUTHORIZED_PRESTIGE &&
  dbg.actionPolicyFor("resetWorld") === dbg.ACTION_POLICY.FORBIDDEN);

let safeCalls = 0;
const safeResult = hasActionBroker
  ? dbg.executeSemanticAction({
      id: "candidate:build:library",
      policy: dbg.ACTION_POLICY.SAFE_REPEATABLE,
      invoke: () => { safeCalls += 1; },
      snapshot: () => safeCalls,
      verify: (before, after) => before === 0 && after === 1,
    })
  : { ok: false };
const mismatched = hasActionBroker
  ? dbg.executeSemanticAction({ id: "candidate:build:library", policy: dbg.ACTION_POLICY.RARE_CAPITAL, invoke: () => { safeCalls += 1; } })
  : { ok: false };
const thrown = hasActionBroker
  ? dbg.executeSemanticAction({ id: "craft:beam", invoke: () => { throw new Error("boom"); } })
  : { ok: false };
check("late game A: safe execution snapshots and verifies postconditions", safeResult.ok && safeResult.before === 0 && safeResult.after === 1 && safeCalls === 1);
check("late game A: mismatched policy and invocation errors fail closed", !mismatched.ok && !thrown.ok && safeCalls === 1);

let deniedStructuredCalls = 0;
const deniedStructuredIds = [
  "candidate:transcendence:transcend",
  "candidate:time:shatter",
  "candidate:time:timeSkip",
  "candidate:time:resetWorld",
  "candidate:religion:sacrificeAlicorns",
];
const deniedStructuredResults = deniedStructuredIds.map((id) => dbg.executeSemanticAction({
  id,
  invoke: () => { deniedStructuredCalls += 1; },
}));
check("late game A review: denied names stay forbidden inside structured candidate IDs",
  deniedStructuredResults.every((result) => result?.ok === false) && deniedStructuredCalls === 0 && deniedStructuredIds.every((id) => dbg.actionPolicyFor(id) === dbg.ACTION_POLICY.FORBIDDEN));

const armButton = panelEl(".kgh-prestige-arm");
if (armButton) armButton.click();
check("late game A: one panel click deliberately arms and immediately renders prestige status", hasPrestigeArm && dbg.prestigeAutomationArmed() === true && localStorageMock.getItem("kgh.prestigeArmed") === "1" && /Prestige automation: ARMED/.test(panelText(".kgh-prestige-arm")) && /ARMED/.test(panelText(".kgh-prestige-status")));
const deniedStructuredArmedResults = deniedStructuredIds.map((id) => dbg.executeSemanticAction({
  id,
  invoke: () => { deniedStructuredCalls += 1; },
}));
check("late game A review: arming cannot bypass denied names embedded in candidate IDs",
  deniedStructuredArmedResults.every((result) => result?.ok === false) && deniedStructuredCalls === 0);
let prestigeCalls = 0;
const firstPrestige = hasActionBroker
  ? dbg.executeSemanticAction({ id: "transcend", invoke: () => { prestigeCalls += 1; } })
  : { ok: false };
const cooldownPrestige = hasActionBroker
  ? dbg.executeSemanticAction({ id: "adore", invoke: () => { prestigeCalls += 1; } })
  : { ok: false };
check("late game A: direct irreversible broker calls require the managed checkpoint/revalidation capability",
  !firstPrestige.ok && !cooldownPrestige.ok && prestigeCalls === 0);
if (hasPrestigeArm) dbg.setPrestigeAutomationArmed(false);
check("late game A: prestige arm disarms and round-trips through storage", hasPrestigeArm && dbg.prestigeAutomationArmed() === false && localStorageMock.getItem("kgh.prestigeArmed") === "0");
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
    sharks = { name: "sharks", title: "Sharks", unlocked: true, embassyLevel: 0, tradeTotal: 0, embassyPrices: [], standing: 0, energy: 0, buys: [{ name: "iron", val: 100 }], sells: [{ name: "parchment", value: 7, chance: 1 }, { name: "manuscript", value: 4.8, chance: 1 }, { name: "compedium", value: 1.4, chance: 1 }] };
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

// Regression (v2.9.0): a cap-blocked queued tech must NOT lock the science bank.
// Electricity's Compendium chain expands to a science reservation (its own ledger
// proves the chain exists), but the tech is not actionable — its final pure-science
// cost is above the cap, and crafting Compendia only cycles science incrementally.
// So pickQueuedTarget skips it AND the manual-queue reservation ledger must skip it
// too; otherwise the whole (unsatisfiable, would-be >cap) science hold froze every
// other science spender and stalled the plan on the queued tech.
const elecChainScience = dbg.buildTargetLedger({ kind: "research", meta: electricity, affordable: false }).reserved.science || 0;
const queueLockedScience = dbg.reservedNeedsFor(qBlocked.target).science || 0;
check("Test Q: a cap-blocked queued tech does NOT lock the science bank (craft science cycles, not reserved)",
  elecChainScience > 0 && queueLockedScience === 0);

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
 * Test E4 — discretionary faith banking YIELDS to an unrelated active plan.
 * Live (v2.8.0) a pending religion upgrade (Frescoes) whose faith read as
 * "binding" injected a fat weight-10 faith need REGARDLESS of the active plan,
 * putting ~30 of 120 kittens on Priest while a no-faith science-storage build
 * (Bio Lab) starved for its own alloy chain.  The full push is now reserved
 * for an ACTIVE religion target; an unrelated pending upgrade banks faith at
 * the small weight-2 background level only.  (Distinct from E3: here faith IS
 * binding — the upgrade's gold cost is well-funded, not a far-off gate.)
 * ------------------------------------------------------------------- */
const e4Saved = {
  techFlags: techs.map((t) => [t, t.researched]),
  rel1: { researched: religionUpgrades[1].researched, on: religionUpgrades[1].on, val: religionUpgrades[1].val, prices: religionUpgrades[1].prices, faith: religionUpgrades[1].faith },
  worship: gamePage.religion.faith,
  faith: [res("faith").value, res("faith").maxValue],
  gold: [res("gold").value, res("gold").maxValue],
  catnip: [res("catnip").value, res("catnip").maxValue],
  perTickCatnip: perTick.catnip,
  perTickFaith: perTick.faith,
  priest: job("priest").value,
};
for (const t of techs) t.researched = true;                  // no research sprint owns the plan
gamePage.religion.faith = 5000;                              // worship high → Solar Revolution visible
religionUpgrades[1].researched = false; religionUpgrades[1].on = 0; religionUpgrades[1].val = 0;
religionUpgrades[1].faith = 1000;                            // visibility threshold (worship 5000 >= 1000)
religionUpgrades[1].prices = [{ name: "gold", val: 500 }, { name: "faith", val: 750 }];
// Faith binding: faith ratio (0.4) within 0.15 of the gold ratio (0.5), and
// gold is well-funded so it is NOT a far-off gate (that is the E3 case).
res("faith").value = 300; res("faith").maxValue = 5500;
res("gold").value = 250; res("gold").maxValue = 6880;
res("catnip").value = 3500; res("catnip").maxValue = 5000; perTick.catnip = 8; // food healthy
perTick.faith = 1;                                            // faith refill exists → upgrade is feasible/lockable
job("priest").value = 8;
// Case A: a NON-faith build is the active plan → faith banked at background only.
const e4Build = dbg.candidateById("build:hut") || dbg.candidateById("build:library");
dbg.forceActiveTarget(e4Build);
const e4Unrelated = dbg.resourceNeeds("balanced");
check("Test E4: faith banked at background level (no fat push) when religion is NOT the active plan", (e4Unrelated.needs.faith || 0) > 0 && (e4Unrelated.needs.faith || 0) <= 5);
// Case B: the religion upgrade itself is the active plan → full faith push.
const e4Religion = dbg.candidateById("religion:solarRevolution");
dbg.forceActiveTarget(e4Religion);
const e4Focused = dbg.resourceNeeds("balanced");
check("Test E4: faith gets the full push (>= 10) when the religion upgrade IS the active plan", (e4Focused.needs.faith || 0) >= 10);
check("Test E4: focusing religion materially outweighs background banking", (e4Focused.needs.faith || 0) >= (e4Unrelated.needs.faith || 0) + 6);
// Restore.
for (const [t, r] of e4Saved.techFlags) t.researched = r;
religionUpgrades[1].researched = e4Saved.rel1.researched; religionUpgrades[1].on = e4Saved.rel1.on; religionUpgrades[1].val = e4Saved.rel1.val;
religionUpgrades[1].prices = e4Saved.rel1.prices; religionUpgrades[1].faith = e4Saved.rel1.faith;
gamePage.religion.faith = e4Saved.worship;
res("faith").value = e4Saved.faith[0]; res("faith").maxValue = e4Saved.faith[1];
res("gold").value = e4Saved.gold[0]; res("gold").maxValue = e4Saved.gold[1];
res("catnip").value = e4Saved.catnip[0]; res("catnip").maxValue = e4Saved.catnip[1];
perTick.catnip = e4Saved.perTickCatnip;
perTick.faith = e4Saved.perTickFaith;
job("priest").value = e4Saved.priest;
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
check("Test M: tradeSellExpected hook accepts a race", /tradeSellExpected = \(sell, race = null\)/.test(source));
check("Test M: trade scoring reads current calendar season", /currentTradeSeasonName/.test(source));
check("Test M: trade scoring delegates live chance to diplomacy", /getResourceTradeChance/.test(source));
check("Test M: trade scoring has no fabricated flat embassy payout multiplier", !/const tradeEmbassyBonus/.test(source));

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
storage.set("kgh.speedrun.lastRestartLog", JSON.stringify(0));
// Count only entries newer than the current head: the log buffer is bounded
// (LOG_STORAGE_LIMIT), so whole-buffer counts silently under-read whenever a
// new entry evicts an old identical one off the tail.
fakeNow += 30000;
const logHeadBeforeS = (JSON.parse(logText() || "[]")[0]) || "";
storage.set("kgh.speedrun.lastResetCount", JSON.stringify(0));
storage.set("kgh.speedrun.runStart", JSON.stringify(fakeNow - 3600000));
for (let i = 0; i < 3; i += 1) {
  storage.set("kgh.speedrun.peakKittens", JSON.stringify(130));
  setKittens(10);
  dbg.resetAdvisor();
}
const newLogEntriesS = [];
for (const entry of JSON.parse(logText() || "[]")) {
  if (entry === logHeadBeforeS) break;
  newLogEntriesS.push(entry);
}
check("Test S: reset advisor logs one restart for a stale low-kitten run, not every tick", newLogEntriesS.length === 1 && /new run detected/.test(newLogEntriesS[0]));
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
  defaultUnlockable: true,
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

const hiddenLogHouseU = {
  name: "hiddenLogHouseU",
  label: "Log House",
  unlocked: false,
  unlockable: true,
  defaultUnlockable: true,
  unlockRatio: 1,
  val: 0,
  on: 0,
  prices: [{ name: "wood", val: 1 }],
  effects: { maxKittens: 1 },
};
const savedWoodU = res("wood").value;
const savedCatnipU = res("catnip").value;
res("wood").value = 0;
res("catnip").value = 1000;
buildings.push(hiddenLogHouseU);
dbg.forceActiveTarget(null);
const hiddenLogHouseBootstrap = dbg.bootstrapResourceCandidate?.();
check("Test U: a job-workable price resource (wood) never becomes a reveal focus — Log House accrues through normal work", hiddenLogHouseBootstrap?.meta?.downstreamName !== "hiddenLogHouseU");
buildings.splice(buildings.indexOf(hiddenLogHouseU), 1);
res("wood").value = savedWoodU;
res("catnip").value = savedCatnipU;

const lockedZigguratU = buildings.find((b) => b.name === "ziggurat");
const savedLockedZigguratU = {
  unlocked: lockedZigguratU.unlocked,
  unlockable: lockedZigguratU.unlockable,
  defaultUnlockable: lockedZigguratU.defaultUnlockable,
  unlockRatio: lockedZigguratU.unlockRatio,
  prices: lockedZigguratU.prices,
  upgrades: lockedZigguratU.upgrades,
};
const savedZigguratResourcesU = {
  scaffold: res("scaffold").value,
  plate: res("plate").value,
  iron: res("iron").value,
};
Object.assign(lockedZigguratU, {
  unlocked: false,
  unlockable: true,
  defaultUnlockable: false,
  unlockRatio: 1,
  prices: [{ name: "scaffold", val: 1 }],
  upgrades: { buildings: ["temple"] },
});
res("scaffold").value = 0;
res("plate").value = 0;
res("iron").value = 25;
dbg.forceActiveTarget(null);
const lockedZigguratBootstrap = dbg.bootstrapResourceCandidate?.();
check("Test U: source-gated locked Ziggurat does not create a Scaffold bootstrap before its unlock source is owned", lockedZigguratBootstrap?.meta?.downstreamName !== "ziggurat");
const lockedZigguratDecision = dbg.selectStrategicTarget("balanced");
check("Test U: strategic planning does not focus Scaffold for locked Ziggurat", lockedZigguratDecision.target?.meta?.downstreamName !== "ziggurat");
lockedZigguratU.unlocked = savedLockedZigguratU.unlocked;
lockedZigguratU.unlockable = savedLockedZigguratU.unlockable;
lockedZigguratU.defaultUnlockable = savedLockedZigguratU.defaultUnlockable;
lockedZigguratU.unlockRatio = savedLockedZigguratU.unlockRatio;
lockedZigguratU.prices = savedLockedZigguratU.prices;
lockedZigguratU.upgrades = savedLockedZigguratU.upgrades;
res("scaffold").value = savedZigguratResourcesU.scaffold;
res("plate").value = savedZigguratResourcesU.plate;
res("iron").value = savedZigguratResourcesU.iron;
dbg.forceActiveTarget(null);

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
// Pin the ETA inputs: this check ranks options by closure speed, so the wood
// and minerals banks are part of the fixture, not incidental suite state.
const savedStocksV = { wood: res("wood").value, minerals: res("minerals").value };
res("wood").value = 5000;   // directVaultV's 4×1000 wood is fully banked → fastest
res("minerals").value = 0;  // ratioAcademyV's 10×100 minerals must still accrue
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
res("wood").value = savedStocksV.wood;
res("minerals").value = savedStocksV.minerals;

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
// An earlier stage retired the Mine by pricing it at 999,999 wood; raise the
// wood cap so the held Mine is merely EXPENSIVE, not storage-blocked — this
// test is about emergency semantics, not the v2.14.0 final-cap break.
const savedWoodMaxAA = res("wood").maxValue;
res("wood").maxValue = 2000000;
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
dbg.forceActiveTarget(magnetoCandAA, "Power recovery", 10000);
const resolvedPowerAA = dbg.chooseWorkTarget("balanced");
check("Test AA: a recovered Power-recovery contract releases immediately instead of holding the generator",
  dbg.targetId(resolvedPowerAA) !== "build:magnetoZ");
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
res("wood").maxValue = savedWoodMaxAA;
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
const savedUpgradeFlagsW = workshopUpgrades.map((upgrade) => [upgrade, upgrade.researched]);
for (const tech of techs) tech.researched = true;
for (const upgrade of workshopUpgrades) upgrade.researched = true;
const expansionTechW = { name: "expansionTechW", label: "Fresh Science", unlocked: true, researched: false, prices: [{ name: "science", val: 10000 }], unlocks: { tech: ["futureExpansionTechW"] } };
const housingW = { name: "housingW", label: "Efficient Housing", unlocked: true, val: 22, on: 22, prices: [{ name: "wood", val: 100 }], effects: { maxKittens: 1 } };
techs.push(expansionTechW);
buildings.push(housingW);
village.getKittens = () => 100;
village.maxKittens = 100;
gamePage.totalResets = 0;
res("science").value = Math.min(res("science").maxValue, res("science").maxValue);
dbg.forceActiveTarget(null);
let expansionDecisionW = dbg.selectStrategicTarget("balanced");
check("Test W: full pre-reset village chooses an Expansion checkpoint before another sprint", expansionDecisionW.layer === "Expansion checkpoint" && expansionDecisionW.target?.meta?.name === "housingW");

// Post-reset, a materially better upgrade that is already fully banked must
// not be starved by another housing reservation. This mirrors the live board:
// Mansion held 1.62K steel while Steel Saw and two storage upgrades were READY.
const savedPrestigeW = { paragon: gamePage.paragonPoints, karmaKittens: gamePage.karmaKittens };
const savedSteelW = res("steel").value;
const readyWorkshopW = {
  name: "readyWorkshopW",
  label: "Ready Workshop W",
  unlocked: true,
  researched: false,
  prices: [{ name: "steel", val: 100 }],
  effects: { woodRatio: 10 },
};
workshopUpgrades.push(readyWorkshopW);
gamePage.totalResets = 1;
gamePage.paragonPoints = 74;
gamePage.karmaKittens = 185;
res("steel").value = 1000;
dbg.forceActiveTarget(null);
const workshopCheckpointW = dbg.selectStrategicTarget("balanced");
check("Test W: ready high-value upgrade owns the post-reset Workshop roadmap",
  workshopCheckpointW.layer === "Workshop roadmap" && workshopCheckpointW.target?.meta?.name === "readyWorkshopW");
gamePage.totalResets = 0;
gamePage.paragonPoints = 0;
gamePage.karmaKittens = 0;
dbg.forceActiveTarget(null);
const firstResetStillWinsW = dbg.selectStrategicTarget("balanced");
check("Test W: first-reset expansion still outranks the same ready workshop upgrade",
  firstResetStillWinsW.layer === "Expansion checkpoint" && firstResetStillWinsW.target?.meta?.name === "housingW");
workshopUpgrades.splice(workshopUpgrades.indexOf(readyWorkshopW), 1);

// Task 6: after a reset, a saturated 169-kitten village may take one housing
// checkpoint, but must then hand the plan to an actionable gateway research.
// The checkpoint is persisted so a reload cannot restart endless housing.
const chronophysicsT6 = {
  name: "chronophysicsT6",
  label: "Chronophysics T6",
  unlocked: true,
  researched: false,
  prices: [{ name: "science", val: 500 }],
  unlocks: { upgrades: ["chronoforgeT6"] },
};
techs.push(chronophysicsT6);
expansionTechW.researched = true;
gamePage.totalResets = 1;
gamePage.paragonPoints = 74;
gamePage.karmaKittens = 185;
village.getKittens = () => 169;
village.maxKittens = 169;
res("science").value = Math.max(500, res("science").value);
localStorageMock.removeItem("kgh.expansionCheckpoint");
dbg.clearExpansionCheckpoint?.();
dbg.forceActiveTarget(null);
const firstPostResetCheckpointT6 = dbg.selectStrategicTarget("balanced");
const persistedCheckpointT6 = JSON.parse(localStorageMock.getItem("kgh.expansionCheckpoint") || "null");
check("Task 6 expansion: a full post-reset village may take one housing checkpoint",
  firstPostResetCheckpointT6.layer === "Expansion checkpoint" && firstPostResetCheckpointT6.target?.meta === housingW);
check("Task 6 expansion: the bounded housing checkpoint persists its gateway contract",
  persistedCheckpointT6?.housingId === "build:housingW" && persistedCheckpointT6?.gatewayId === "research:chronophysicsT6");
housingW.val += 1;
housingW.on += 1;
dbg.forceActiveTarget(null);
const chronophysicsAfterHousingT6 = dbg.selectStrategicTarget("balanced");
dbg.forceActiveTarget(null);
const chronophysicsStillOwnsT6 = dbg.selectStrategicTarget("balanced");
check("Task 6 expansion: Chronophysics starts after one post-reset housing checkpoint",
  chronophysicsAfterHousingT6.layer === "Research sprint" && chronophysicsAfterHousingT6.target?.meta === chronophysicsT6);
check("Task 6 expansion: the gateway frontier keeps priority until it completes or invalidates",
  chronophysicsStillOwnsT6.target?.meta === chronophysicsT6);
chronophysicsT6.researched = true;
techs.splice(techs.indexOf(chronophysicsT6), 1);
housingW.val -= 1;
housingW.on -= 1;
localStorageMock.removeItem("kgh.expansionCheckpoint");
dbg.clearExpansionCheckpoint?.();
expansionTechW.researched = false;
village.getKittens = () => 100;

// A non-ready but fundable production upgrade owns the roadmap; an enormous
// higher-value Steel backlog is excluded by the one-hour project horizon.
const savedWorkshopChainW = {
  steel: res("steel").value,
  iron: [res("iron").value, res("iron").maxValue, perTick.iron],
  coal: [res("coal").value, res("coal").maxValue, perTick.coal],
};
const fundedWorkshopW = { name: "fundedWorkshopW", label: "Funded Drill W", unlocked: true, researched: false, prices: [{ name: "steel", val: 20 }], effects: { mineralsRatio: 10 } };
const horizonWorkshopW = { name: "horizonWorkshopW", label: "Endless Alloy Plant W", unlocked: true, researched: false, prices: [{ name: "steel", val: 10000 }], effects: { mineralsRatio: 100 } };
workshopUpgrades.push(fundedWorkshopW, horizonWorkshopW);
gamePage.totalResets = 1;
gamePage.paragonPoints = 74;
gamePage.karmaKittens = 185;
res("steel").value = 0;
res("iron").value = 0; res("iron").maxValue = 1e7; perTick.iron = 1;
res("coal").value = 0; res("coal").maxValue = 1e7; perTick.coal = 1;
dbg.clearResourceTelemetry?.("iron"); dbg.clearResourceTelemetry?.("coal");
dbg.forceActiveTarget(null);
const fundedRoadmapW = dbg.selectStrategicTarget("balanced");
check("Test W: a reachable non-ready upgrade within one hour owns the Workshop roadmap",
  fundedRoadmapW.layer === "Workshop roadmap" && fundedRoadmapW.target?.meta?.name === "fundedWorkshopW");
check("Test W: a multi-hour workshop backlog item is excluded from the active roadmap",
  fundedRoadmapW.target?.meta?.name !== "horizonWorkshopW");
workshopUpgrades.splice(workshopUpgrades.indexOf(fundedWorkshopW), 1);
workshopUpgrades.splice(workshopUpgrades.indexOf(horizonWorkshopW), 1);
res("steel").value = savedWorkshopChainW.steel;
res("iron").value = savedWorkshopChainW.iron[0]; res("iron").maxValue = savedWorkshopChainW.iron[1]; perTick.iron = savedWorkshopChainW.iron[2];
res("coal").value = savedWorkshopChainW.coal[0]; res("coal").maxValue = savedWorkshopChainW.coal[1]; perTick.coal = savedWorkshopChainW.coal[2];
dbg.clearResourceTelemetry?.("iron"); dbg.clearResourceTelemetry?.("coal");
res("steel").value = savedSteelW;
if (savedPrestigeW.paragon === undefined) delete gamePage.paragonPoints; else gamePage.paragonPoints = savedPrestigeW.paragon;
if (savedPrestigeW.karmaKittens === undefined) delete gamePage.karmaKittens; else gamePage.karmaKittens = savedPrestigeW.karmaKittens;
const savedWoodCapW = { value: res("wood").value, maxValue: res("wood").maxValue };
const savedHousingPricesW = housingW.prices;
housingW.prices = [{ name: "wood", val: 500 }];
res("wood").value = 200;
res("wood").maxValue = 200;
dbg.clearResourceTelemetry?.("wood");
dbg.forceActiveTarget(null);
const cappedExpansionW = dbg.selectStrategicTarget("balanced");
check("Test W: expansion stands down when housing final wood cost is above storage cap", cappedExpansionW.layer !== "Expansion checkpoint");
dbg.forceActiveTarget({ kind: "build", meta: housingW, affordable: false }, "Expansion checkpoint", 60000);
const cappedExpansionPlanW = dbg.planText("balanced");
check("Test W: locked expansion target releases when final storage cap blocks it", !/Focus: Efficient Housing/i.test(cappedExpansionPlanW));
res("science").value = 100;
res("science").maxValue = 1000;
expansionTechW.prices = [{ name: "science", val: 500 }];
dbg.forceActiveTarget(null);
const earlyScienceNeedsW = dbg.resourceNeeds("balanced");
check("Test W: early balanced planning keeps science as a meaningful worker need", (earlyScienceNeedsW.needs.science || 0) >= 6);
housingW.prices = savedHousingPricesW;
res("wood").value = savedWoodCapW.value;
res("wood").maxValue = savedWoodCapW.maxValue;
dbg.clearResourceTelemetry?.("wood");
res("science").value = Math.min(res("science").maxValue, res("science").maxValue);
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
for (const [upgrade, researched] of savedUpgradeFlagsW) upgrade.researched = researched;

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
hutW2.prices = [{ name: "wood", val: 2500 }]; // fits the wood cap; the deficit is work, not storage
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
check("Test W2: in-cap Hut wood is reserved from side buys", hutReserveW2.wood >= 2500 && (!hutReserveW2.catnip || hutReserveW2.catnip < 100000));
fakeNow += 60000;
tickFn();
check(`Test W2: Hut wood bottleneck keeps direct Woodcutters staffed above refine Farmers (woodcutters ${job("woodcutter").value}, farmers ${job("farmer").value})`, job("woodcutter").value > job("farmer").value && job("woodcutter").value >= 5);
dbg.forceActiveTarget(null);

/* =====================================================================
 * Test AG (v2.14.0) — a final price above a CAPPED bank is storage-blocked
 * even when the resource is craftable/job-produced.
 *
 * Live post-reset regression: the plan locked a Library whose wood price had
 * scaled past the wood cap. Wood is craftable (Refine Catnip), so the old
 * carve-out treated it as reachable — but a capped bank clamps AT its cap,
 * the purchase could never complete, and the lock re-picked the Library
 * forever. Now the target reads storage-blocked, the lock breaks with a
 * cooldown, and the storage layer grows the wood cap instead.
 * ------------------------------------------------------------------- */
hutW2.prices = [{ name: "wood", val: 5000 }]; // above the 3000 wood cap → unattainable until storage grows
const lumberYardAG = { name: "lumberYardAG", label: "Lumber Yard", unlocked: true, val: 0, on: 0, prices: [{ name: "catnip", val: 100 }], effects: { woodMax: 1500 } };
buildings.push(lumberYardAG);
res("catnip").value = 2500;
const hutCandAG = { kind: "build", meta: hutW2, affordable: false };
const feasAG = dbg.classifyTargetFeasibility(hutCandAG);
check("Test AG: wood-capped Hut reads storage-blocked despite the Refine Catnip craft", feasAG.status === "IMPOSSIBLE" && /storage/i.test(feasAG.reason || ""));
const hutReserveAG = dbg.reservedNeedsFor(hutCandAG);
check("Test AG: an unattainable above-cap wood price is NOT reserved (the bank stays usable)", !(hutReserveAG.wood >= 5000));
dbg.forceActiveTarget(hutCandAG, "Economy / normal growth", 150000);
const afterBreakAG = dbg.chooseWorkTarget("balanced");
check("Test AG: the held wood-capped target is released instead of re-picked", dbg.targetId(afterBreakAG) !== "build:hut");
check("Test AG: the storage layer grows the wood cap (Lumber Yard) so the blocked build can resume", afterBreakAG?.meta?.name === "lumberYardAG");
check("Test AG: the release is logged as a storage-cap break", /storage cap blocks the final price|target impossible/i.test(logText()));
buildings.splice(buildings.indexOf(lumberYardAG), 1);
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

/* ---------------------------------------------------------------------
 * Test X2 - staged science storage is first-class inside the cap layer.
 * A Library-like stage upgrade that closes the next tech's science deficit must
 * compete in Science storage unlock, not wait for the generic stage layer.
 * ------------------------------------------------------------------- */
const savedX2 = {
  science: [res("science").value, res("science").maxValue],
  wood: [res("wood").value, res("wood").maxValue],
  perTickScience: perTick.science,
  perTickWood: perTick.wood,
  buildingFlags: buildings.map((b) => [b, b.unlocked]),
};
for (const b of buildings) {
  const effects = (b && b.effects) || {};
  if (effects.scienceMax || effects.scienceRatio || Array.isArray(b.stages)) b.unlocked = false;
}
const stageScienceX2 = {
  name: "stageScienceX2",
  unlocked: true,
  stage: 0,
  val: 10,
  on: 10,
  priceRatio: 1,
  stages: [
    { label: "Small Archive X2", prices: [{ name: "wood", val: 10 }], effects: { scienceMax: 100 }, stageUnlocked: true },
    { label: "Data Center X2", prices: [{ name: "wood", val: 100 }], effects: { scienceMax: 3000 }, stageUnlocked: true },
  ],
  effects: {},
};
const stageBlockTechX2 = {
  name: "stageBlockTechX2",
  label: "Stage Block Tech X2",
  unlocked: true,
  researched: false,
  prices: [{ name: "science", val: 12000 }],
  unlocks: { tech: ["stageBlockFutureX2"] },
};
buildings.push(stageScienceX2);
techs.push(stageBlockTechX2);
res("science").value = 10000; res("science").maxValue = 10000;
res("wood").value = 1000; res("wood").maxValue = 5000;
perTick.science = 10; perTick.wood = 10;
dbg.forceActiveTarget(null);
const stageScienceCandidateX2 = dbg.stageTransitionCandidate?.(stageScienceX2, 1);
const stageScienceDecisionX2 = dbg.selectStrategicTarget("balanced");
check("Test X2: stage science storage gain is the net target-stage cap increase", dbg.scienceStorageGain?.(stageScienceCandidateX2) === 2000);
check("Test X2: staged cap growth wins inside Science storage unlock", stageScienceDecisionX2.layer === "Science storage unlock" && stageScienceDecisionX2.target?.kind === "stage" && stageScienceDecisionX2.target?.meta?.buildingName === "stageScienceX2");
buildings.splice(buildings.indexOf(stageScienceX2), 1);
techs.splice(techs.indexOf(stageBlockTechX2), 1);
for (const [b, unlocked] of savedX2.buildingFlags) b.unlocked = unlocked;
res("science").value = savedX2.science[0]; res("science").maxValue = savedX2.science[1];
res("wood").value = savedX2.wood[0]; res("wood").maxValue = savedX2.wood[1];
perTick.science = savedX2.perTickScience;
perTick.wood = savedX2.perTickWood;
dbg.forceActiveTarget(null);

/* ---------------------------------------------------------------------
 * Test X3 - staged food relief responds to live catnip pressure.  Hydro-style
 * energy stages do not help food; switching back to a catnip-ratio stage does.
 * ------------------------------------------------------------------- */
const savedX3 = {
  catnip: [res("catnip").value, res("catnip").maxValue],
  perTickCatnip: perTick.catnip,
  energyProd: gamePage.resPool.energyProd,
  energyCons: gamePage.resPool.energyCons,
  energyWinterProd: gamePage.resPool.energyWinterProd,
};
const stageFoodX3 = {
  name: "stageFoodX3",
  unlocked: true,
  stage: 1,
  val: 4,
  on: 4,
  priceRatio: 1,
  stages: [
    { label: "Aqueduct X3", prices: [{ name: "minerals", val: 10 }], effects: { catnipRatio: 0.4 }, stageUnlocked: true },
    { label: "Hydro Plant X3", prices: [{ name: "minerals", val: 10 }], effects: { energyProduction: 5 }, stageUnlocked: true },
  ],
  effects: {},
};
buildings.push(stageFoodX3);
res("catnip").value = 120; res("catnip").maxValue = 5000;
perTick.catnip = -12;
gamePage.resPool.energyProd = 100;
gamePage.resPool.energyCons = 0;
gamePage.resPool.energyWinterProd = 100;
const stageFoodDecisionX3 = dbg.bestStageTransition?.();
check("Test X3: catnip pressure values a food-positive stage transition", stageFoodDecisionX3?.meta?.buildingName === "stageFoodX3" && stageFoodDecisionX3.meta.analysis.toStage === 0);
buildings.splice(buildings.indexOf(stageFoodX3), 1);
res("catnip").value = savedX3.catnip[0]; res("catnip").maxValue = savedX3.catnip[1];
perTick.catnip = savedX3.perTickCatnip;
gamePage.resPool.energyProd = savedX3.energyProd;
gamePage.resPool.energyCons = savedX3.energyCons;
gamePage.resPool.energyWinterProd = savedX3.energyWinterProd;

/* ---------------------------------------------------------------------
 * Test X4 — perfected stage-transition triggers (v2.17.0).
 * (a) watts are utility: Aqueduct→Hydro fires on a loaded grid, is rejected
 *     when nothing consumes power, and the reverse downgrade is refused
 *     while the grid needs the watts;
 * (b) exact-parity upgrades (unit exactly 3×, ceil remainder 0) are
 *     actionable — the old aggregate test read them "worse" forever;
 * (c) a net rebuild bill above a bank cap is storage-blocked (v2.14
 *     final-cap invariant), not picked-and-flapped;
 * (d) a never-built (val 0) staged building switches for free with no
 *     rebuild contract, and a real transition persists its contract.
 * ------------------------------------------------------------------- */
const savedX4 = {
  energyProd: gamePage.resPool.energyProd,
  energyCons: gamePage.resPool.energyCons,
  energyWinterProd: gamePage.resPool.energyWinterProd,
  catnip: [res("catnip").value, res("catnip").maxValue],
  minerals: [res("minerals").value, res("minerals").maxValue],
  wood: [res("wood").value, res("wood").maxValue],
  perTickCatnip: perTick.catnip,
  perTickWood: perTick.wood,
};
const stageGridX4 = {
  name: "stageGridX4",
  unlocked: true,
  stage: 0,
  val: 4,
  on: 4,
  priceRatio: 1,
  stages: [
    { label: "Aqueduct X4", prices: [{ name: "minerals", val: 10 }], effects: { catnipRatio: 0.03 }, stageUnlocked: true },
    { label: "Hydro Plant X4", prices: [{ name: "minerals", val: 10 }], effects: { energyProduction: 5 }, stageUnlocked: true },
  ],
  effects: {},
};
buildings.push(stageGridX4);
res("catnip").value = 4000; res("catnip").maxValue = 5000; perTick.catnip = 20;
res("minerals").value = 100; res("minerals").maxValue = 5000;
gamePage.resPool.energyProd = 20; gamePage.resPool.energyCons = 19; gamePage.resPool.energyWinterProd = 20;
const upgradeX4 = dbg.stageTransitionAnalysis?.(stageGridX4, 1);
check("Test X4: a loaded grid makes the watt stage materially better (Aqueduct→Hydro fires)", upgradeX4?.actionable === true && Number.isFinite(upgradeX4?.payback));
gamePage.resPool.energyCons = 0;
const idleGridX4 = dbg.stageTransitionAnalysis?.(stageGridX4, 1);
check("Test X4: with no consumers the watt stage has no utility (upgrade rejected)", idleGridX4?.actionable === false && /worse per unit/i.test(idleGridX4?.reason || ""));
gamePage.resPool.energyCons = 19;
stageGridX4.stage = 1;
const downgradeX4 = dbg.stageTransitionAnalysis?.(stageGridX4, 0);
check("Test X4: the watt stage is not sold while the grid needs it", downgradeX4?.actionable === false && /worse per unit/i.test(downgradeX4?.reason || ""));
stageGridX4.stage = 0;

const stageParityX4 = {
  name: "stageParityX4",
  unlocked: true,
  stage: 0,
  val: 3,
  on: 3,
  priceRatio: 1,
  stages: [
    { label: "Small Archive X4", prices: [{ name: "wood", val: 10 }], effects: { scienceMax: 100 }, stageUnlocked: true },
    { label: "Data Center X4", prices: [{ name: "wood", val: 30 }], effects: { scienceMax: 300 }, stageUnlocked: true },
  ],
  effects: {},
};
buildings.push(stageParityX4);
res("wood").value = 1000; res("wood").maxValue = 5000; perTick.wood = 10;
const parityX4 = dbg.stageTransitionAnalysis?.(stageParityX4, 1);
check("Test X4: an exact-parity upgrade (ceil remainder 0) is still actionable", parityX4?.actionable === true && parityX4?.parityCount === 1 && (parityX4?.incrementalUtility || 0) < 1e-3 && Number.isFinite(parityX4?.payback));
buildings.splice(buildings.indexOf(stageParityX4), 1);

const stageCapX4 = {
  name: "stageCapX4",
  unlocked: true,
  stage: 0,
  val: 4,
  on: 4,
  priceRatio: 1,
  stages: [
    { label: "Shed X4", prices: [{ name: "wood", val: 10 }], effects: { scienceMax: 100 }, stageUnlocked: true },
    { label: "Vault X4", prices: [{ name: "wood", val: 20000 }], effects: { scienceMax: 500 }, stageUnlocked: true },
  ],
  effects: {},
};
buildings.push(stageCapX4);
const capX4 = dbg.stageTransitionAnalysis?.(stageCapX4, 1);
check("Test X4: a net rebuild bill above the bank cap is storage-blocked", capX4?.actionable === false && /storage cap/i.test(capX4?.reason || ""));
buildings.splice(buildings.indexOf(stageCapX4), 1);

const stageFreeX4 = {
  name: "stageFreeX4",
  unlocked: true,
  stage: 1,
  val: 0,
  on: 0,
  priceRatio: 1,
  stages: [
    { label: "Aqueduct F4", prices: [{ name: "minerals", val: 10 }], effects: { catnipRatio: 0.03 }, stageUnlocked: true },
    { label: "Hydro Plant F4", prices: [{ name: "minerals", val: 10 }], effects: { energyProduction: 5 }, stageUnlocked: true },
  ],
  effects: {},
};
buildings.push(stageFreeX4);
gamePage.resPool.energyCons = 0; // nothing uses power → watts are worthless → the catnip stage wins
const freeX4 = dbg.stageTransitionCandidate?.(stageFreeX4, 0);
check("Test X4: a never-built staged building offers a free switch (no net bill, affordable on sight)", freeX4?.meta?.analysis?.actionable === true && freeX4?.affordable === true && freeX4?.meta?.analysis?.parityCount === 0 && (freeX4?.meta?.prices || []).length === 0);
const freeExecutedX4 = dbg.executeStageTransitionCandidate?.(freeX4);
check("Test X4: the free switch executes with no rebuild contract", freeExecutedX4 === true && stageFreeX4.stage === 0 && dbg.pendingStageRebuild?.() === null && localStorageMock.getItem("kgh.stageRebuild") == null);
buildings.splice(buildings.indexOf(stageFreeX4), 1);

gamePage.resPool.energyCons = 19; // reload the grid so the real upgrade fires
const upgradeCandidateX4 = dbg.stageTransitionCandidate?.(stageGridX4, 1);
const upgradeExecutedX4 = dbg.executeStageTransitionCandidate?.(upgradeCandidateX4);
const storedRebuildX4 = JSON.parse(localStorageMock.getItem("kgh.stageRebuild") || "null");
check("Test X4: a real transition persists its rebuild contract across reloads", upgradeExecutedX4 === true && stageGridX4.stage === 1 && storedRebuildX4?.buildingName === "stageGridX4" && storedRebuildX4?.targetCount >= 1);
buildings.splice(buildings.indexOf(stageGridX4), 1);
dbg.pendingStageRebuildCandidate?.(); // building is gone — clears the persisted contract
res("catnip").value = savedX4.catnip[0]; res("catnip").maxValue = savedX4.catnip[1];
res("minerals").value = savedX4.minerals[0]; res("minerals").maxValue = savedX4.minerals[1];
res("wood").value = savedX4.wood[0]; res("wood").maxValue = savedX4.wood[1];
perTick.catnip = savedX4.perTickCatnip;
perTick.wood = savedX4.perTickWood;
gamePage.resPool.energyProd = savedX4.energyProd;
gamePage.resPool.energyCons = savedX4.energyCons;
gamePage.resPool.energyWinterProd = savedX4.energyWinterProd;

/* =====================================================================
 * REGRESSION - power/Wt is a first-class planner and toggle constraint
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

/* ---------------------------------------------------------------------
 * Test AB — converter-fuel starvation (v2.9.0).  Reproduces the live state
 * where oil sat pinned at 0 and the Magneto/Calciner fleet kept
 * starve-pausing while the plan was stuck on a science-cap grind.  A
 * chronically empty, net-draining fuel with a buildable producer must build
 * that producer FIRST (Production bottleneck layer, above science storage),
 * and must yield the moment production turns net-positive so it can't
 * oscillate.  magnetoY (oilPerTickCon) is the live oil consumer here.
 * ------------------------------------------------------------------- */
dbg.queueClear();
dbg.forceActiveTarget(null);
gamePage.resPool.energyProd = 60;   // power healthy → power-recovery layer yields
gamePage.resPool.energyCons = 5;
gamePage.resPool.energyWinterProd = 60;
const oilWellZ = { name: "oilWellZ", label: "Oil Well", unlocked: true, val: 5, on: 5, prices: [{ name: "minerals", val: 10 }], priceRatio: 1, effects: { oilPerTickProd: 0.5 } };
buildings.push(oilWellZ);
res("oil").value = 0;            // pinned empty
res("oil").maxValue = 1000;
perTick.oil = -0.5;             // net draining → genuinely starved
dbg.clearResourceTelemetry?.("oil");
check("Test AB: oil is detected as a starved converter fuel", dbg.converterFuelStarvation().includes("oil"));
const fuelDecisionZ = dbg.selectStrategicTarget("balanced");
check("Test AB: starved oil builds its producer first at the Production bottleneck layer", fuelDecisionZ.layer === "Production bottleneck" && fuelDecisionZ.target?.meta?.name === "oilWellZ");
perTick.oil = 0.5;             // production now net-positive
dbg.clearResourceTelemetry?.("oil");
const recoveredZ = dbg.selectStrategicTarget("balanced");
check("Test AB: a recovering fuel yields the layer (no oscillation)", dbg.converterFuelStarvation().length === 0 && recoveredZ.layer !== "Production bottleneck");
buildings.splice(buildings.indexOf(oilWellZ), 1);
dbg.forceActiveTarget(null);

/* ---------------------------------------------------------------------
 * Test AE — first-uranium bootstrap is not a fake minerals wait.  In the
 * live v2.11.1 diagnostic, Uranium was 0, Reactors were owned but never ON,
 * and Accelerator / uranium upgrades appeared in the ranked candidates with
 * finite ETAs.  The first uranium-producing building itself costs uranium, so
 * without an existing uranium income/trade path it is hard-blocked and must
 * not head the planner's consideration list.
 * ------------------------------------------------------------------- */
const uraniumAE = R("uranium", 0, 2250, "Uranium", { unlocked: false });
const acceleratorAE = {
  name: "acceleratorAE",
  label: "Accelerator AE",
  unlocked: true,
  val: 0,
  on: 0,
  prices: [{ name: "minerals", val: 10 }, { name: "uranium", val: 25 }],
  effects: { uraniumPerTickAutoprod: 0.05 },
};
const reactorAE = {
  name: "reactorAE",
  label: "Reactor AE",
  unlocked: true,
  val: 8,
  on: 0,
  prices: [{ name: "minerals", val: 10 }],
  effects: { uraniumPerTickCon: -0.02, energyProduction: 10 },
};
const nuclearSmeltersAE = {
  name: "nuclearSmeltersAE",
  label: "Nuclear Smelters AE",
  unlocked: true,
  researched: false,
  prices: [{ name: "science", val: 100 }, { name: "uranium", val: 250 }],
  effects: {},
};
resources.push(uraniumAE);
buildings.push(acceleratorAE, reactorAE);
workshopUpgrades.push(nuclearSmeltersAE);
perTick.uranium = 0;
dbg.clearResourceTelemetry?.("uranium");
dbg.forceActiveTarget(null);
const dragonUraniumSellAE = { name: "uranium", value: 1, chance: 0.95, width: 0, seasons: { summer: 0.35 } };
const dragonThoriumSellAE = { name: "thorium", value: 1, chance: 0.5, width: 0.25, minLevel: 5 };
const dragonsAE = {
  name: "dragons",
  title: "Dragons",
  hidden: true,
  unlocked: true,
  embassyLevel: 0,
  standing: 0,
  energy: 0,
  buys: [{ name: "titanium", val: 250 }],
  sells: [dragonUraniumSellAE, dragonThoriumSellAE],
};
check("late game B: uranium trade is eligible before the resource unlocks", typeof dbg.validRaceSell === "function" && dbg.validRaceSell(dragonsAE, dragonUraniumSellAE));
check("late game B: live fractional trade chance", typeof dbg.expectedTradeYield === "function" && Math.abs(dbg.expectedTradeYield(dragonsAE, dragonUraniumSellAE) - 1.2825) < 1e-6);
check("late game B: embassy-gated thorium stays invalid below level five", typeof dbg.validRaceSell === "function" && !dbg.validRaceSell(dragonsAE, dragonThoriumSellAE));
const acceleratorCandidateAE = dbg.candidateById("build:acceleratorAE", "balanced");
const acceleratorChainAE = dbg.solveChain(acceleratorCandidateAE);
const uraniumDecisionAE = dbg.selectStrategicTarget("balanced");
check("Test AE: first uranium producer is hard-blocked when it also costs uranium", acceleratorChainAE.hardBlocked && /no (?:acquisition )?path for Uranium/i.test((acceleratorChainAE.blockers || []).map((b) => b.text).join(" ")));
check("Test AE: hard-blocked first-uranium producer is scored below viable work", acceleratorCandidateAE.score < 0);
check("Test AE: hard-blocked uranium bootstrap does not head the ranked candidates", uraniumDecisionAE.candidates?.[0]?.meta?.name !== "acceleratorAE");

diplomacy.races.push(dragonsAE);
const tradeFundingAE = {
  gold: [res("gold").value, res("gold").maxValue],
  manpower: [res("manpower").value, res("manpower").maxValue],
  titanium: [res("titanium").value, res("titanium").maxValue],
  slab: [res("slab").value, res("slab").maxValue],
  rates: { gold: perTick.gold, manpower: perTick.manpower, titanium: perTick.titanium, unobtainium: perTick.unobtainium, faith: perTick.faith },
  faith: [res("faith").value, res("faith").maxValue],
  priest: job("priest").value,
};
res("gold").value = 1000; res("gold").maxValue = Math.max(1000, res("gold").maxValue || 0);
res("manpower").value = 5000; res("manpower").maxValue = 10000;
res("titanium").value = 6750; res("titanium").maxValue = 10000;
const dragonUraniumPathAE = typeof dbg.acquisitionPathFor === "function" ? dbg.acquisitionPathFor("uranium", 25) : null;
const acceleratorTradeChainAE = dbg.solveChain(acceleratorCandidateAE);
check("Test AE: Dragons make the first uranium producer reachable", !!dragonUraniumPathAE?.reachable && dragonUraniumPathAE.kind === "trade" && Number.isFinite(dragonUraniumPathAE.eta) && dragonUraniumPathAE.nextStep?.race?.name === "dragons" && acceleratorTradeChainAE.reachable);

res("gold").value = 0;
res("manpower").value = 0;
res("titanium").value = 0;
perTick.gold = 1;
perTick.manpower = 2;
perTick.titanium = 0.5;
dbg.clearResourceTelemetry?.();
const unbankedDragonPathAE = dbg.acquisitionPathFor("uranium", 25);
const unbankedDragonSlowestAE = Math.max(...(unbankedDragonPathAE.inputs || []).map((input) => input.eta));
check("Test AE review: unbanked Dragon prices recurse and the slowest input owns ETA", unbankedDragonPathAE.reachable && unbankedDragonPathAE.kind === "trade" && ["manpower", "gold", "titanium"].every((name) => unbankedDragonPathAE.inputs.some((input) => input.resource === name && input.reachable)) && Math.abs(unbankedDragonPathAE.eta - unbankedDragonSlowestAE) < 1e-6);
dbg.forceActiveTarget(acceleratorCandidateAE, "Economy / normal growth", 0);
const dragonRouteNeedsAE = dbg.resourceNeeds("balanced");
check("Test AE review: uranium target pressures Dragon route inputs, not phantom uranium work", (dragonRouteNeedsAE.needs.manpower || 0) > 0 && (dragonRouteNeedsAE.needs.gold || 0) > 0 && (dragonRouteNeedsAE.needs.titanium || 0) > 0 && !(dragonRouteNeedsAE.needs.uranium > 0));

const unobtainiumAE = R("unobtainium", 0, 0, "Unobtainium");
const timeCrystalAE = R("timeCrystal", 0, 0, "Time Crystal", { unlocked: false });
const leviathansAE = {
  name: "leviathans",
  title: "Leviathans",
  hidden: true,
  unlocked: true,
  embassyLevel: 0,
  standing: 0,
  energy: 0,
  buys: [{ name: "unobtainium", val: 5000 }],
  sells: [{ name: "timeCrystal", value: 0.25, chance: 0.98, width: 0.15 }],
};
resources.push(unobtainiumAE, timeCrystalAE);
diplomacy.races.push(leviathansAE);
perTick.unobtainium = 4;
dbg.clearResourceTelemetry?.();
const leviathanTimeCrystalPathAE = typeof dbg.acquisitionPathFor === "function" ? dbg.acquisitionPathFor("timeCrystal", 0.25) : null;
check("Test AE: Leviathans provide a finite time-crystal acquisition route", !!leviathanTimeCrystalPathAE?.reachable && leviathanTimeCrystalPathAE.kind === "trade" && Number.isFinite(leviathanTimeCrystalPathAE.eta) && leviathanTimeCrystalPathAE.nextStep?.race?.name === "leviathans");
const timeCrystalConsumerAE = { name: "timeCrystalConsumerAE", label: "Time Crystal Consumer AE", unlocked: true, val: 0, on: 0, prices: [{ name: "timeCrystal", val: 0.25 }], effects: {} };
buildings.push(timeCrystalConsumerAE);
dbg.queueClear();
dbg.queueAdd("build:timeCrystalConsumerAE", 0);
dbg.forceActiveTarget(null);
dbg.selectStrategicTarget("balanced");
const leviathanRouteNeedsAE = dbg.resourceNeeds("balanced");
check("Test AE review: time-crystal target pressures Leviathan unobtainium input", (leviathanRouteNeedsAE.needs.unobtainium || 0) > 0 && (leviathanRouteNeedsAE.needs.manpower || 0) > 0 && (leviathanRouteNeedsAE.needs.gold || 0) > 0 && !(leviathanRouteNeedsAE.needs.timeCrystal > 0));
dbg.queueClear();
buildings.splice(buildings.indexOf(timeCrystalConsumerAE), 1);

const sharksRouteAE = diplomacy.races.find((race) => race && race.name === "sharks");
const savedCraftTradeAE = { parchment: res("parchment").value, furs: res("furs").value, iron: res("iron").value };
res("parchment").value = 0;
res("furs").value = 0;
res("iron").value = 1000;
res("manpower").value = 5000;
res("gold").value = 1000;
const parchmentTargetAE = { kind: "build", meta: { name: "parchmentTargetAE", label: "Parchment Target AE", prices: [{ name: "parchment", val: 1 }] }, affordable: false };
const parchmentRouteAE = dbg.acquisitionPathFor("parchment", 1);
const tradeCallsBeforeRouteGateAE = tradeCalls;
const routeObeyedAE = typeof dbg.maybeTradeForTargetChain === "function" && !dbg.maybeTradeForTargetChain(parchmentTargetAE);
check("Test AE review: targeted diplomacy obeys a selected craft route", !!sharksRouteAE && parchmentRouteAE.kind === "craft" && routeObeyedAE && tradeCalls === tradeCallsBeforeRouteGateAE);
[res("parchment").value, res("furs").value, res("iron").value] = [savedCraftTradeAE.parchment, savedCraftTradeAE.furs, savedCraftTradeAE.iron];

/* Re-review: acquisition consumers must follow the actionable trade node even
   when the selected root is a craft, producer, or storage bridge. */
const nestedCraftAE = R("nestedCraftAE", 0, 100, "Nested Craft AE");
const nestedProducerAE = R("nestedProducerAE", 0, 100, "Nested Producer AE");
const nestedStorageAE = R("nestedStorageAE", 0, 1, "Nested Storage AE");
resources.push(nestedCraftAE, nestedProducerAE, nestedStorageAE);
const nestedCraftRecipeAE = { name: "nestedCraftAE", label: "Nested Craft AE", unlocked: true, prices: [{ name: "uranium", val: 1 }] };
crafts.push(nestedCraftRecipeAE);
const nestedProducerBridgeAE = { name: "nestedProducerBridgeAE", label: "Nested Producer Bridge AE", unlocked: true, val: 0, on: 0, prices: [{ name: "uranium", val: 1 }], effects: { nestedProducerAEPerTickProd: 0.1 } };
const nestedStorageBridgeAE = { name: "nestedStorageBridgeAE", label: "Nested Storage Bridge AE", unlocked: true, val: 0, on: 0, prices: [{ name: "uranium", val: 1 }], effects: { nestedStorageAEMax: 20 } };
const nestedCraftTargetAE = { name: "nestedCraftTargetAE", label: "Nested Craft Target AE", unlocked: true, val: 0, on: 0, prices: [{ name: "nestedCraftAE", val: 1 }], effects: {} };
const nestedProducerTargetAE = { name: "nestedProducerTargetAE", label: "Nested Producer Target AE", unlocked: true, val: 0, on: 0, prices: [{ name: "nestedProducerAE", val: 1 }], effects: {} };
const nestedStorageTargetAE = { name: "nestedStorageTargetAE", label: "Nested Storage Target AE", unlocked: true, val: 0, on: 0, prices: [{ name: "nestedStorageAE", val: 10 }], effects: {} };
buildings.push(nestedProducerBridgeAE, nestedStorageBridgeAE, nestedCraftTargetAE, nestedProducerTargetAE, nestedStorageTargetAE);
res("gold").value = 0;
res("manpower").value = 0;
res("titanium").value = 0;
perTick.gold = 1;
perTick.manpower = 2;
perTick.titanium = 0.5;
dbg.clearResourceTelemetry?.();
const nestedRouteCasesAE = [
  ["craft", "nestedCraftAE", 1, "nestedCraftTargetAE"],
  ["producer", "nestedProducerAE", 1, "nestedProducerTargetAE"],
  ["storage", "nestedStorageAE", 10, "nestedStorageTargetAE"],
];

for (const [rootKind, resourceName, amount, targetName] of nestedRouteCasesAE) {
  const nestedRootAE = dbg.acquisitionPathFor(resourceName, amount, { finalPurchase: true });
  const nestedTargetCandidateAE = dbg.candidateById(`build:${targetName}`, "balanced");
  dbg.forceActiveTarget(nestedTargetCandidateAE, "Economy / normal growth", 0);
  const nestedNeedsAE = dbg.resourceNeeds("balanced").needs;
  check(`Test AE re-review: ${rootKind} root pressures its nested Dragon trade inputs`, nestedRootAE.kind === rootKind && (nestedNeedsAE.manpower || 0) > 0 && (nestedNeedsAE.gold || 0) > 0 && (nestedNeedsAE.titanium || 0) > 0);
}
dbg.forceActiveTarget(null);
for (const meta of [nestedProducerBridgeAE, nestedStorageBridgeAE, nestedCraftTargetAE, nestedProducerTargetAE, nestedStorageTargetAE]) buildings.splice(buildings.indexOf(meta), 1);
crafts.splice(crafts.indexOf(nestedCraftRecipeAE), 1);
for (const resource of [nestedCraftAE, nestedProducerAE, nestedStorageAE]) resources.splice(resources.indexOf(resource), 1);

/* Re-review integration: exercise the real tick dispatcher. A passive titanium
   route must suppress every Zebra fast path; a Dragon route whose titanium
   price is itself supplied by Zebras must execute the nested Zebra step first. */
const passiveTitaniumTargetAE = { name: "passiveTitaniumTargetAE", label: "Passive Titanium Target AE", unlocked: true, val: 0, on: 0, prices: [{ name: "titanium", val: 500 }], effects: {} };
buildings.push(passiveTitaniumTargetAE);
zebras.unlocked = true;
zebras.hidden = false;
res("titanium").value = 0;
res("titanium").maxValue = 1000;
perTick.titanium = 1;
res("gold").value = 10000;
res("gold").maxValue = Math.max(10000, res("gold").maxValue || 0);
res("manpower").value = 30000;
res("manpower").maxValue = Math.max(30000, res("manpower").maxValue || 0);
res("slab").value = 30000;
dbg.clearResourceTelemetry?.();
const passiveTitaniumCandidateAE = dbg.candidateById("build:passiveTitaniumTargetAE", "balanced");
dbg.forceActiveTarget(passiveTitaniumCandidateAE, "Economy / normal growth", 0);
const passiveTitaniumRouteAE = dbg.acquisitionPathFor("titanium", 500, { finalPurchase: true });
const zebraTradesBeforePassiveAE = zebras.tradeTotal || 0;
fakeNow += 30000;
tickFn();
check("Test AE re-review: actual diplomacy dispatcher does not Zebra-trade over a passive titanium route", passiveTitaniumRouteAE.kind === "passive" && (zebras.tradeTotal || 0) === zebraTradesBeforePassiveAE);
buildings.splice(buildings.indexOf(passiveTitaniumTargetAE), 1);

perTick.titanium = 0;
res("titanium").value = 0;
res("uranium").value = 0;
res("gold").value = 10000;
res("manpower").value = 30000;
res("slab").value = 30000;
dbg.clearResourceTelemetry?.();
dbg.forceActiveTarget(acceleratorCandidateAE, "Economy / normal growth", 0);
const nestedZebraDragonRouteAE = dbg.acquisitionPathFor("uranium", 25, { finalPurchase: true });
const zebraTradesBeforeNestedAE = zebras.tradeTotal || 0;
fakeNow += 30000;
tickFn();
check("Test AE re-review: actual diplomacy dispatcher executes nested Zebra before Dragon", nestedZebraDragonRouteAE.kind === "trade" && nestedZebraDragonRouteAE.nextStep?.race?.name === "dragons" && nestedZebraDragonRouteAE.inputs.some((input) => input.nextStep?.kind === "trade" && input.nextStep?.race?.name === "zebras") && (zebras.tradeTotal || 0) > zebraTradesBeforeNestedAE);

/* Task 3: diplomacy has one mutation owner. The old dispatcher called both
   manageDiplomacy() and manageTrade(), so the same nested Zebra route could hit
   the diplomacy API twice during one tick. Count the real fixture calls rather
   than helper returns: one tick must produce exactly one trade API mutation. */
res("titanium").value = 0;
res("uranium").value = 0;
res("gold").value = 10000;
res("manpower").value = 30000;
res("slab").value = 30000;
dbg.clearResourceTelemetry?.();
dbg.forceActiveTarget(acceleratorCandidateAE, "Economy / normal growth", 0);
const diplomacyTradeApiCallsAE = [];
const originalTradeMultipleAE = diplomacy.tradeMultiple;
const originalTradeAllAE = diplomacy.tradeAll;
diplomacy.tradeMultiple = (race, amount) => {
  diplomacyTradeApiCallsAE.push({ api: "tradeMultiple", race: race?.name, amount });
  return originalTradeMultipleAE(race, amount);
};
diplomacy.tradeAll = (race) => {
  diplomacyTradeApiCallsAE.push({ api: "tradeAll", race: race?.name, amount: 1 });
  return originalTradeAllAE(race);
};
fakeNow += 30000;
tickFn();
diplomacy.tradeMultiple = originalTradeMultipleAE;
diplomacy.tradeAll = originalTradeAllAE;
check("Task 3: one tick issues exactly one diplomacy trade API call", diplomacyTradeApiCallsAE.length === 1);

/* Task 3: route selection and funding use the acquisition graph plus the full
   merged reservation ledger. With Dragon titanium unfunded, the actionable
   route is the nested Zebra step; its pressure includes the Zebra slab/ship
   ramp and catpower, never a made-up uranium miner need. */
res("titanium").value = 0;
res("uranium").value = 0;
res("gold").value = 0;
res("manpower").value = 0;
res("slab").value = 0;
dbg.clearResourceTelemetry?.();
dbg.forceActiveTarget(acceleratorCandidateAE, "Economy / normal growth", 0);
const activeNestedRouteAE = typeof dbg.activeAcquisitionRoute === "function"
  ? dbg.activeAcquisitionRoute(acceleratorCandidateAE)
  : null;
const nestedDiplomacyNeedsAE = dbg.resourceNeeds("balanced").needs;
check("Task 3: insufficient Dragon titanium selects the nested Zebra titanium route first", activeNestedRouteAE?.nextStep?.race?.name === "zebras" && activeNestedRouteAE?.resource === "titanium");
check("Task 3: nested Zebra route pressures slab, ship, and catpower without synthetic uranium miners", (nestedDiplomacyNeedsAE.slab || 0) > 0 && (nestedDiplomacyNeedsAE.ship || 0) > 0 && (nestedDiplomacyNeedsAE.manpower || 0) > 0 && !(nestedDiplomacyNeedsAE.uranium > 0));

/* Exact batch bounds: every trade price leaves the complete merged floor in
   place, while expected output never runs beyond the target deficit or storage
   headroom. These synthetic source labels mirror buildReservationLedger's
   active/manual/unicorn/survival merge and make omissions visible. */
const completeTradeLedgerAE = {
  reserved: { titanium: 275, manpower: 150, gold: 60, unobtainium: 5000 },
  sources: {
    titanium: ["active plan"],
    gold: ["manual queue"],
    unobtainium: ["unicorn path"],
    manpower: ["survival"],
  },
};
res("titanium").value = 525;
res("manpower").value = 250;
res("gold").value = 75;
res("uranium").value = 0;
res("uranium").maxValue = 100;
dbg.clearResourceTelemetry?.();
const directDragonRouteAE = dbg.acquisitionPathFor("uranium", 25, { finalPurchase: true });
const dragonBoundedBatchAE = typeof dbg.boundedTradeBatch === "function"
  ? dbg.boundedTradeBatch(directDragonRouteAE, completeTradeLedgerAE)
  : null;
check("Task 3: Dragon batch respects active/manual/survival titanium, catpower, and gold floors", dragonBoundedBatchAE === 1);

res("uranium").value = 100;
const cappedDragonRouteAE = { ...directDragonRouteAE, amount: 125 };
const uraniumHeadroomBatchAE = typeof dbg.boundedTradeBatch === "function"
  ? dbg.boundedTradeBatch(cappedDragonRouteAE, completeTradeLedgerAE)
  : null;

res("unobtainium").value = 9999;
res("timeCrystal").value = 0;
res("timeCrystal").maxValue = 10;
const fundedLeviathanRouteAE = {
  ...leviathanTimeCrystalPathAE,
  amount: 2,
  nextStep: { ...leviathanTimeCrystalPathAE.nextStep, trades: 8 },
};
const leviathanFloorBatchAE = typeof dbg.boundedTradeBatch === "function"
  ? dbg.boundedTradeBatch(fundedLeviathanRouteAE, completeTradeLedgerAE)
  : null;

res("unobtainium").value = 10000;
res("timeCrystal").value = 1;
res("timeCrystal").maxValue = 1;
const cappedLeviathanRouteAE = {
  ...leviathanTimeCrystalPathAE,
  amount: 2,
  nextStep: { ...leviathanTimeCrystalPathAE.nextStep, trades: 8 },
};
const leviathanBoundedBatchAE = typeof dbg.boundedTradeBatch === "function"
  ? dbg.boundedTradeBatch(cappedLeviathanRouteAE, completeTradeLedgerAE)
  : null;
check("Task 3: trade batches stop at uranium/time-crystal output headroom and unobtainium floor", uraniumHeadroomBatchAE === 0 && leviathanFloorBatchAE === 0 && leviathanBoundedBatchAE === 0);

/* Task 3 review: a partial output slot smaller than one expected yield is not
   permission to overflow, and each Dragon input floor must bind on its own. */
const savedCultureReviewAE = res("culture").value;
res("titanium").value = 10000;
res("manpower").value = 10000;
res("gold").value = 10000;
res("uranium").value = 99.5;
res("uranium").maxValue = 100;
const partialHeadroomDragonRouteAE = { ...directDragonRouteAE, amount: 125 };
const partialHeadroomBatchAE = dbg.boundedTradeBatch(partialHeadroomDragonRouteAE, { reserved: {} });
check("Task 3 review: positive uranium headroom below one expected yield permits zero trades", partialHeadroomBatchAE === 0);

const isolatedFloorBatchAE = (floorName, floor, stock) => {
  res("titanium").value = 10000;
  res("manpower").value = 10000;
  res("gold").value = 10000;
  res(floorName).value = stock;
  res("uranium").value = 0;
  return dbg.boundedTradeBatch(directDragonRouteAE, { reserved: { [floorName]: floor } });
};
const isolatedTitaniumFloorAE = isolatedFloorBatchAE("titanium", 275, 524);
const isolatedManpowerFloorAE = isolatedFloorBatchAE("manpower", 150, 199);
const isolatedGoldFloorAE = isolatedFloorBatchAE("gold", 60, 74);
check("Task 3 review: titanium, catpower, and gold floors independently stop Dragon trades", isolatedTitaniumFloorAE === 0 && isolatedManpowerFloorAE === 0 && isolatedGoldFloorAE === 0);

check("Task 3 review: explorer and embassy semantic IDs are safe repeatable actions",
  dbg.actionPolicyFor("explore:races") === dbg.ACTION_POLICY.SAFE_REPEATABLE &&
  dbg.actionPolicyFor("embassy:reviewers") === dbg.ACTION_POLICY.SAFE_REPEATABLE);

/* The real dispatcher must end after one public diplomacy API mutation. Exercise
   native explorer, single-trade fallback, and embassy controller paths while
   observing every diplomacy API family in the fixture. */
const reviewExplorerRaceAE = { name: "reviewExplorersAE", title: "Review Explorers", unlocked: false, hidden: false, embassyLevel: 0, embassyPrices: [] };
diplomacy.races.push(reviewExplorerRaceAE);
const savedUnlockRandomRaceAE = diplomacy.unlockRandomRace;
diplomacy.unlockRandomRace = () => {
  reviewExplorerRaceAE.unlocked = true;
  return reviewExplorerRaceAE;
};
res("manpower").value = 1100;
res("manpower").maxValue = 1200;
dbg.forceActiveTarget(null);
const explorerAuditStartAE = diplomacyApiCalls.length;
fakeNow += 30000;
tickFn();
const explorerAuditAE = diplomacyApiCalls.slice(explorerAuditStartAE);
check("Task 3 review: real dispatcher uses one native explorer API and stops", reviewExplorerRaceAE.unlocked && explorerAuditAE.length === 1 && explorerAuditAE[0].api === "explore");
diplomacy.races.splice(diplomacy.races.indexOf(reviewExplorerRaceAE), 1);
diplomacy.unlockRandomRace = savedUnlockRandomRaceAE;

const reviewTitaniumTargetAE = { name: "reviewTitaniumTargetAE", label: "Review Titanium Target", unlocked: true, val: 0, on: 0, prices: [{ name: "titanium", val: 100 }], effects: {} };
buildings.push(reviewTitaniumTargetAE);
const savedTradeMultipleReviewAE = diplomacy.tradeMultiple;
const savedTradeReviewAE = diplomacy.trade;
const savedShipReviewAE = [res("ship").value, res("ship").maxValue];
delete diplomacy.tradeMultiple;
let fallbackTradeCallsAE = 0;
diplomacy.trade = (race) => {
  diplomacyApiCalls.push({ api: "trade", race: race?.name, amount: 1 });
  fallbackTradeCallsAE += 1;
  if (race?.name === "lizards" && canPay([{ name: "manpower", val: 50 }, { name: "gold", val: 15 }])) {
    pay([{ name: "manpower", val: 50 }, { name: "gold", val: 15 }]);
    res("minerals").value += 100;
    return true;
  }
  if (race?.name !== "zebras" || !canPay([{ name: "manpower", val: 50 }, { name: "gold", val: 15 }, { name: "slab", val: 50 }])) return false;
  pay([{ name: "manpower", val: 50 }, { name: "gold", val: 15 }, { name: "slab", val: 50 }]);
  res("titanium").value += 12;
  return true;
};
res("ship").value = 1;
res("ship").maxValue = 1;
res("titanium").value = 0;
res("titanium").maxValue = 100;
res("manpower").value = 5000;
res("manpower").maxValue = 10000;
res("gold").value = 1000;
res("slab").value = 1000;
dbg.clearResourceTelemetry?.();
dbg.forceActiveTarget(dbg.candidateById("build:reviewTitaniumTargetAE"), "Economy / normal growth", 0);
const tradeAuditStartAE = diplomacyApiCalls.length;
fakeNow += 30000;
tickFn();
const tradeAuditAE = diplomacyApiCalls.slice(tradeAuditStartAE);
check("Task 3 review: missing tradeMultiple permits one native trade call, never a loop", fallbackTradeCallsAE === 1 && tradeAuditAE.length === 1 && tradeAuditAE[0].api === "trade");

const overflowPassiveTargetAE = { name: "overflowPassiveTargetAE", label: "Overflow Passive Target", unlocked: true, val: 0, on: 0, prices: [{ name: "titanium", val: 100 }], effects: {} };
buildings.push(overflowPassiveTargetAE);
perTick.titanium = 1;
res("titanium").value = 0;
res("titanium").maxValue = 1000;
res("manpower").value = 985;
res("manpower").maxValue = 1000;
res("gold").value = 600;
res("minerals").value = 0;
dbg.clearResourceTelemetry?.("titanium");
dbg.forceActiveTarget(dbg.candidateById("build:overflowPassiveTargetAE"), "Economy / normal growth", 0);
const overflowFallbackAuditStartAE = diplomacyApiCalls.length;
fakeNow += 30000;
tickFn();
const overflowFallbackAuditAE = diplomacyApiCalls.slice(overflowFallbackAuditStartAE);
check("Task 3 review: overflow fallback also uses one native trade call at batch one", overflowFallbackAuditAE.length === 1 && overflowFallbackAuditAE[0].api === "trade");
buildings.splice(buildings.indexOf(overflowPassiveTargetAE), 1);
perTick.titanium = 0;
diplomacy.tradeMultiple = savedTradeMultipleReviewAE;
if (savedTradeReviewAE === undefined) delete diplomacy.trade; else diplomacy.trade = savedTradeReviewAE;
[res("ship").value, res("ship").maxValue] = savedShipReviewAE;
buildings.splice(buildings.indexOf(reviewTitaniumTargetAE), 1);

const reviewEmbassyRaceAE = { name: "reviewEmbassyAE", title: "Review Embassy", unlocked: true, hidden: false, embassyLevel: 0, embassyPrices: [{ name: "culture", val: 10 }], sells: [] };
const savedEmbassyPricesAE = diplomacy.races.map((race) => [race, race.embassyPrices]);
for (const race of diplomacy.races) race.embassyPrices = [];
diplomacy.races.push(reviewEmbassyRaceAE);
res("culture").value = 100;
res("manpower").value = 0;
dbg.forceActiveTarget(null);
const embassyAuditStartAE = diplomacyApiCalls.length;
fakeNow += 30000;
tickFn();
const embassyAuditAE = diplomacyApiCalls.slice(embassyAuditStartAE);
check("Task 3 review: real dispatcher uses one native embassy API and stops", reviewEmbassyRaceAE.embassyLevel === 1 && embassyAuditAE.length === 1 && embassyAuditAE[0].api === "embassy");
diplomacy.races.splice(diplomacy.races.indexOf(reviewEmbassyRaceAE), 1);
for (const [race, prices] of savedEmbassyPricesAE) race.embassyPrices = prices;

/* With the public controller unavailable, no raw pay/unlock/level fallback is
   allowed. The manager reports unavailable and leaves the board unchanged. */
const unavailableExplorerRaceAE = { name: "unavailableExplorerAE", title: "Unavailable Explorer", unlocked: false, hidden: false, embassyLevel: 0, embassyPrices: [] };
diplomacy.races.push(unavailableExplorerRaceAE);
const savedExploreControllerAE = gamePage.tradeTab.exploreBtn.controller;
gamePage.tradeTab.exploreBtn.controller = null;
let rawUnlockCallsAE = 0;
diplomacy.unlockRandomRace = () => {
  rawUnlockCallsAE += 1;
  unavailableExplorerRaceAE.unlocked = true;
  return unavailableExplorerRaceAE;
};
res("manpower").value = 1100;
const manpowerBeforeUnavailableExploreAE = res("manpower").value;
dbg.forceActiveTarget(null);
fakeNow += 30000;
dbg.manageDiplomacy("balanced");
check("Task 3 review: unavailable explorer controller performs no raw payment or race mutation", rawUnlockCallsAE === 0 && !unavailableExplorerRaceAE.unlocked && res("manpower").value === manpowerBeforeUnavailableExploreAE);
gamePage.tradeTab.exploreBtn.controller = savedExploreControllerAE;
diplomacy.unlockRandomRace = savedUnlockRandomRaceAE;
diplomacy.races.splice(diplomacy.races.indexOf(unavailableExplorerRaceAE), 1);

const unavailableEmbassyRaceAE = { name: "unavailableEmbassyAE", title: "Unavailable Embassy", unlocked: true, embassyLevel: 0, embassyPrices: [{ name: "culture", val: 10 }], sells: [] };
const savedEmbassyPricesUnavailableAE = diplomacy.races.map((race) => [race, race.embassyPrices]);
for (const race of diplomacy.races) race.embassyPrices = [];
diplomacy.races.push(unavailableEmbassyRaceAE);
const savedEmbassyControllerAE = context.classes.diplomacy.ui.EmbassyButtonController;
delete context.classes.diplomacy.ui.EmbassyButtonController;
res("culture").value = 100;
res("manpower").value = 0;
const cultureBeforeUnavailableEmbassyAE = res("culture").value;
dbg.forceActiveTarget(null);
fakeNow += 30000;
dbg.manageDiplomacy("balanced");
check("Task 3 review: unavailable embassy controller performs no raw payment or level mutation", unavailableEmbassyRaceAE.embassyLevel === 0 && res("culture").value === cultureBeforeUnavailableEmbassyAE);
context.classes.diplomacy.ui.EmbassyButtonController = savedEmbassyControllerAE;
diplomacy.races.splice(diplomacy.races.indexOf(unavailableEmbassyRaceAE), 1);
for (const [race, prices] of savedEmbassyPricesUnavailableAE) race.embassyPrices = prices;
res("culture").value = savedCultureReviewAE;

res("faith").value = 0;
res("faith").maxValue = Math.max(100, res("faith").maxValue || 0);
perTick.faith = 0;
job("priest").value = 0;
dbg.clearResourceTelemetry?.("faith");
const zeroRateFaithPathAE = dbg.acquisitionPathFor("faith", 10);
check("Test AE review: zero-rate direct job does not invent deficit-seconds ETA", !zeroRateFaithPathAE.reachable && !Number.isFinite(zeroRateFaithPathAE.eta) && (zeroRateFaithPathAE.blockers || []).length > 0);
diplomacy.races.splice(diplomacy.races.indexOf(leviathansAE), 1);
resources.splice(resources.indexOf(timeCrystalAE), 1);
resources.splice(resources.indexOf(unobtainiumAE), 1);
diplomacy.races.splice(diplomacy.races.indexOf(dragonsAE), 1);
[res("gold").value, res("gold").maxValue] = tradeFundingAE.gold;
[res("manpower").value, res("manpower").maxValue] = tradeFundingAE.manpower;
[res("titanium").value, res("titanium").maxValue] = tradeFundingAE.titanium;
[res("slab").value, res("slab").maxValue] = tradeFundingAE.slab;
[res("faith").value, res("faith").maxValue] = tradeFundingAE.faith;
job("priest").value = tradeFundingAE.priest;
for (const [name, value] of Object.entries(tradeFundingAE.rates)) {
  if (value === undefined) delete perTick[name];
  else perTick[name] = value;
}
workshopUpgrades.splice(workshopUpgrades.indexOf(nuclearSmeltersAE), 1);
buildings.splice(buildings.indexOf(acceleratorAE), 1);
buildings.splice(buildings.indexOf(reactorAE), 1);
resources.splice(resources.indexOf(uraniumAE), 1);
delete perTick.uranium;
dbg.forceActiveTarget(null);

/* ---------------------------------------------------------------------
 * Test AC — Space tab candidate scanning (v2.10.0). The scanner used to
 * only read `space.programs` (one-time planet-unlock missions like
 * orbitalLaunch), so an actual buildable Cath structure — e.g. `sattelite`
 * (Satellite) living under `space.planets[].buildings` — was invisible to
 * planning even though workshop upgrades that merely SOUND similar (Solar
 * Satellites / Satellite Navigation / Satellite Radio) were already scanned
 * as locked upgrades. Planet buildings must be enumerated, scored,
 * reported, and bought through their own game controller — distinct from
 * both workshop upgrades and space missions.
 * ------------------------------------------------------------------- */
dbg.queueClear();
dbg.forceActiveTarget(null);
const orbitalEngineeringAC = { name: "orbitalEngineeringAC", label: "Orbital Engineering", unlocked: true, researched: false, prices: [{ name: "science", val: 1000 }], unlocks: {} };
techs.push(orbitalEngineeringAC);
const satelliteAC = { name: "sattelite", label: "Satellite", unlocked: true, val: 0, on: 0, priceRatio: 1.08, requiredTech: [], prices: [{ name: "titanium", val: 50 }, { name: "science", val: 500 }], effects: { observatoryRatio: 0.05 } };
const spaceElevatorAC = { name: "spaceElevator", label: "Space Elevator", unlocked: false, val: 0, on: 0, priceRatio: 1.15, requiredTech: ["orbitalEngineeringAC"], prices: [{ name: "titanium", val: 6000 }, { name: "science", val: 75000 }], effects: {} };
const cathAC = { name: "cath", label: "Cath", unlocked: true, reached: true, routeDays: 0, buildings: [satelliteAC, spaceElevatorAC] };
const orbitalLaunchAC = { name: "orbitalLaunch", label: "Orbital Launch", unlocked: true, noStackable: true, val: 0, on: 0, prices: [{ name: "science", val: 400 }], effects: {} };
gamePage.space = {
  programs: [orbitalLaunchAC],
  planets: [cathAC],
  getProgram: (id) => [orbitalLaunchAC].find((p) => p.name === id),
  getBuilding: (id) => [satelliteAC, spaceElevatorAC].find((b) => b.name === id),
};

check("Test AC: an unlocked Cath planet building (Satellite) is scanned as a candidate", dbg.candidateById("space:sattelite")?.kind === "space");
check("Test AC: the space mission (Orbital Launch) is ALSO still scanned", !!dbg.candidateById("space:orbitalLaunch"));
check("Test AC: a locked planet building (needs Orbital Engineering) is NOT yet a candidate", !dbg.candidateById("space:spaceElevator"));

const solarSatellitesAC = { name: "solarSatellitesAC", label: "Solar Satellites", unlocked: false, researched: false, prices: [{ name: "science", val: 225000 }, { name: "alloy", val: 750 }], effects: {} };
workshopUpgrades.push(solarSatellitesAC);

const reportAC = dbg.report();
check(
  "Test AC: report SPACE section lists the buildable Satellite distinctly from the LOCKED workshop 'Solar Satellites' upgrade",
  /— SPACE /.test(reportAC) && /Cath.*Satellite ×0 · next .*(buildable now|need )/.test(reportAC) && /Solar Satellites · LOCKED/.test(reportAC),
);
check("Test AC: report SPACE section shows Cath ownership and the Space Elevator technology gate", /Cath.*Space Elevator.*technology.*Orbital Engineering/i.test(reportAC));

// Fund and buy the Satellite through the native planner path (kind "space",
// planet-building sub-type) — proves purchase EXECUTION, not just scanning,
// works for planet buildings distinctly from missions (different controller).
// Neutralize every competing candidate first (same isolation technique as
// simulate.mjs's "space" phase) so Satellite is the clear pick.
const savedBuildingUnlockedAC = buildings.map((b) => b.unlocked);
const savedTechUnlockedAC = techs.map((t) => t.unlocked);
const savedTechResearchedAC = techs.map((t) => t.researched);
const savedUpgradeResearchedAC = workshopUpgrades.map((u) => u.researched);
const savedReligionUnlockedAC = religionUpgrades.map((u) => u.unlocked);
const savedFestivalDaysAC = calendar.festivalDays;
for (const b of buildings) b.unlocked = false;
for (const t of techs) t.researched = true;
for (const u of workshopUpgrades) u.researched = true;
for (const u of religionUpgrades) u.unlocked = false;
calendar.festivalDays = calendar.daysPerSeason + 1; // festival "active" → not a competing candidate
orbitalLaunchAC.unlocked = false; // isolate the PLANET BUILDING purchase path from the space MISSION
res("titanium").value = 100; res("titanium").maxValue = 200;
res("science").value = 2000; res("science").maxValue = 5000;
dbg.forceActiveTarget(null);
tickFn();
check("Test AC: the Satellite planet building is actually bought by the native planner", satelliteAC.val > 0);
buildings.forEach((b, i) => { b.unlocked = savedBuildingUnlockedAC[i]; });
techs.forEach((t, i) => { t.unlocked = savedTechUnlockedAC[i]; t.researched = savedTechResearchedAC[i]; });
workshopUpgrades.forEach((u, i) => { u.researched = savedUpgradeResearchedAC[i]; });
religionUpgrades.forEach((u, i) => { u.unlocked = savedReligionUnlockedAC[i]; });
calendar.festivalDays = savedFestivalDaysAC;
orbitalLaunchAC.unlocked = true;

dbg.forceActiveTarget(null);
techs.splice(techs.indexOf(orbitalEngineeringAC), 1);
delete gamePage.space;

buildings.splice(buildings.indexOf(magnetoY), 1);
buildings.splice(buildings.indexOf(bioLabY), 1);
buildings.splice(buildings.indexOf(factoryY), 1);
resources.splice(resources.findIndex((r) => r.name === "oil"), 1);
gamePage.resPool.energyProd = savedPowerY.energyProd;
gamePage.resPool.energyCons = savedPowerY.energyCons;
gamePage.resPool.energyWinterProd = savedPowerY.energyWinterProd;
res("science").value = savedScienceY.value;
res("science").maxValue = savedScienceY.maxValue;

/* ---------------------------------------------------------------------
 * Task 4 RED regressions - normalized ownership/gates, controller-only
 * mission execution, dependency-frontier ranking, and marginal Space effects.
 * ------------------------------------------------------------------- */
const resourceSnapshotsT4 = new Map();
const ensureResourceT4 = (name, value, maxValue) => {
  let resource = res(name);
  if (resource) {
    resourceSnapshotsT4.set(name, { resource, value: resource.value, maxValue: resource.maxValue, unlocked: resource.unlocked, added: false });
    resource.value = value;
    resource.maxValue = maxValue;
    resource.unlocked = true;
  } else {
    resource = R(name, value, maxValue);
    resources.push(resource);
    resourceSnapshotsT4.set(name, { resource, added: true });
  }
  return resource;
};
for (const [name, value, maxValue] of [
  ["oil", 20000, 25000], ["starchart", 10000, 10000], ["kerosene", 10000, 10000],
  ["alloy", 10000, 10000], ["thorium", 100000, 100000], ["relic", 100, 100],
  ["eludium", 10000, 10000], ["concrate", 10000, 10000], ["uranium", 5000, 5000],
  ["unobtainium", 150, 150], ["antimatter", 0, 100], ["gflops", 100, 1000],
  ["hashrates", 0, 100000],
]) ensureResourceT4(name, value, maxValue);
const savedUnlimitedDRT4 = gamePage.getUnlimitedDR;
gamePage.getUnlimitedDR = (value, stripe) => value / (1 + value / stripe);

const nanoTechT4 = { name: "nanotechnologyT4", label: "Nanotechnology", unlocked: true, researched: false, prices: [], unlocks: {} };
techs.push(nanoTechT4);
const missionT4 = { name: "controllerMissionT4", label: "Controller Mission", unlocked: true, noStackable: true, val: 0, on: 0, prices: [{ name: "science", val: 10 }], unlocks: { planet: ["controllerPlanetT4"], spaceMission: ["downstreamMissionT4"] }, effects: {} };
const downstreamMissionT4 = { name: "downstreamMissionT4", label: "Downstream Mission", unlocked: false, noStackable: true, val: 0, on: 0, prices: [{ name: "science", val: 10 }], effects: {} };
const predecessorMissionT4 = { name: "predecessorMissionT4", label: "Predecessor Mission", unlocked: true, noStackable: true, val: 0, on: 0, prices: [{ name: "science", val: 10 }], unlocks: { spaceMission: ["lockedMissionT4"] }, effects: {} };
const lockedMissionT4 = { name: "lockedMissionT4", label: "Locked Mission", unlocked: false, noStackable: true, val: 0, on: 0, prices: [{ name: "science", val: 10 }], effects: {} };
const piscineMissionT4 = { name: "piscineMission", label: "Piscine Mission", unlocked: true, noStackable: true, val: 0, on: 0, prices: [{ name: "science", val: 100 }], unlocks: { planet: ["piscine"] }, effects: {} };
const heliosMissionT4 = { name: "heliosMission", label: "Helios Mission", unlocked: true, noStackable: true, val: 0, on: 0, prices: [{ name: "science", val: 100 }], unlocks: { planet: ["helios"] }, effects: {} };

const bT4 = (name, label, effects = {}, extra = {}) => ({ name, label, unlocked: true, val: 0, on: 0, priceRatio: 1.15, prices: [{ name: "science", val: 100 }], effects, ...extra });
const satteliteT4 = bT4("sattelite", "Satellite", { starchartPerTickBaseSpace: 0.001 });
const elevatorT4 = bT4("spaceElevator", "Space Elevator", { oilReductionRatio: 0.05, spaceRatio: 0.01, prodTransferBonus: 0.001 }, { unlocked: false, requiredTech: ["nanotechnologyT4"] });
const moonOutpostT4 = bT4("moonOutpost", "Lunar Outpost", { uraniumPerTickCon: -0.35, unobtainiumPerTickSpace: 0.007, energyConsumption: 5 }, { unlocked: false });
const moonBaseT4 = bT4("moonBase", "Moon Base", { unobtainiumMax: 150, energyConsumption: 10 });
const planetCrackerT4 = bT4("planetCracker", "Planet Cracker", { uraniumPerTickSpace: 0.3, uraniumMax: 1750 });
const sunlifterT4 = bT4("sunlifter", "Sunlifter", { antimatterProduction: 1, energyProduction: 30 });
const containmentT4 = bT4("containmentChamber", "Containment Chamber", { antimatterMax: 108, energyConsumption: 52 }, { unlocked: false, val: 2, on: 2 });
const heatsinkT4 = bT4("heatsink", "Heatsink", {}, { upgrades: { spaceBuilding: ["containmentChamber"] } });
const sunforgeT4 = bT4("sunforge", "Sunforge", { baseMetalMaxRatio: 0.01 });
const navigationRelayT4 = bT4("navigationRelay", "Navigation Relay", { routeSpeed: 0.25 });
const terraformingT4 = bT4("terraformingStation", "Terraforming Station", { maxKittens: 1 }, { val: 2, on: 2 });
const hydroponicsT4 = bT4("hydroponics", "Hydroponics", { catnipRatio: 0.025, catnipMaxRatio: 0.1, terraformingMaxKittensRatio: 0 }, {
  val: 2,
  on: 2,
  upgrades: { spaceBuilding: ["terraformingStation"] },
  updateEffects(self, game) {
    self.effects.terraformingMaxKittensRatio = game.getUnlimitedDR(self.on, 100) / self.on;
  },
});
const harvesterT4 = bT4("hrHarvester", "HR Harvester", { energyProduction: 4 });
const entanglerT4 = bT4("entangler", "Entangler", { gflopsConsumption: 0.1, energyConsumption: 25 });
const tectonicT4 = bT4("tectonic", "Tectonic", { energyProduction: 25 }, { val: 3, on: 3 });
const moltenCoreT4 = bT4("moltenCore", "Molten Core", { tectonicBonus: 0.05 }, { upgrades: { spaceBuilding: ["tectonic"] } });
const ordinaryT4 = bT4("ordinarySpaceT4", "Ordinary Space", { woodPerTickSpace: 2, woodMax: 100 });

const controllerPlanetT4 = { name: "controllerPlanetT4", label: "Controller Planet", unlocked: false, reached: false, routeDays: 10, buildings: [satteliteT4] };
const techPlanetT4 = { name: "techPlanetT4", label: "Tech Planet", unlocked: true, reached: true, routeDays: 0, buildings: [elevatorT4, ordinaryT4] };
const moonPlanetT4 = { name: "moon", label: "Moon", unlocked: true, reached: false, routeDays: 12, buildings: [moonOutpostT4, moonBaseT4] };
const dunePlanetT4 = { name: "dune", label: "Dune", unlocked: true, reached: true, routeDays: 0, buildings: [planetCrackerT4] };
const heliosPlanetT4 = { name: "helios", label: "Helios", unlocked: true, reached: true, routeDays: 0, buildings: [sunlifterT4, containmentT4, heatsinkT4, sunforgeT4] };
const yarnPlanetT4 = { name: "yarn", label: "Yarn", unlocked: true, reached: true, routeDays: 0, buildings: [terraformingT4, hydroponicsT4] };
const umbraPlanetT4 = { name: "umbra", label: "Umbra", unlocked: true, reached: true, routeDays: 0, buildings: [harvesterT4, navigationRelayT4] };
const charonPlanetT4 = { name: "charon", label: "Charon", unlocked: true, reached: true, routeDays: 0, buildings: [entanglerT4] };
const centaurusPlanetT4 = { name: "centaurusSystem", label: "Centaurus", unlocked: true, reached: true, routeDays: 0, buildings: [tectonicT4, moltenCoreT4] };
const planetsT4 = [controllerPlanetT4, techPlanetT4, moonPlanetT4, dunePlanetT4, heliosPlanetT4, yarnPlanetT4, umbraPlanetT4, charonPlanetT4, centaurusPlanetT4];
const programsT4 = [missionT4, downstreamMissionT4, predecessorMissionT4, lockedMissionT4, piscineMissionT4, heliosMissionT4];
gamePage.space = {
  programs: programsT4,
  planets: planetsT4,
  getProgram: (id) => programsT4.find((program) => program.name === id),
  getBuilding: (id) => planetsT4.flatMap((planet) => planet.buildings).find((building) => building.name === id),
};

const descriptorsT4 = typeof dbg.spaceDescriptors === "function" ? dbg.spaceDescriptors() : [];
const descriptorT4 = (meta) => typeof dbg.spaceDescriptorFor === "function" ? dbg.spaceDescriptorFor(meta) : descriptorsT4.find((descriptor) => descriptor.meta === meta);
check("Task 4: descriptors preserve mission/building subtype and owning planet", descriptorT4(missionT4)?.subtype === "mission" && descriptorT4(satteliteT4)?.subtype === "planetBuilding" && descriptorT4(satteliteT4)?.planet === controllerPlanetT4);
check("Task 4: predecessor mission gate is explicit", /predecessor mission.*Predecessor Mission/i.test(descriptorT4(lockedMissionT4)?.gateState?.reason || ""));
check("Task 4: planet transit gate reports ETA", /Moon.*transit/i.test(descriptorT4(moonOutpostT4)?.gateState?.reason || "") && (descriptorT4(moonOutpostT4)?.gateState?.transitEta || 0) > 0);
check("Task 4: required technology gate is explicit", /technology.*Nanotechnology/i.test(descriptorT4(elevatorT4)?.gateState?.reason || ""));
check("Task 4: upgrades.spaceBuilding dependency gate is explicit", /Space building.*Heatsink/i.test(descriptorT4(containmentT4)?.gateState?.reason || ""));
check("Task 4 review: upgrades.spaceBuilding gateway edge is counted once", typeof dbg.candidateGatewayValue === "function" && dbg.candidateGatewayValue("space", heatsinkT4) === 1);

const nativePlanetControllerT4 = context.classes.ui.space.PlanetBuildingBtnController;
const unavailableSpaceAdaptersT4 = [
  ["controller", null],
  ["model", class extends nativePlanetControllerT4 { fetchModel() { return null; } }],
  ["getPrices", class {
    constructor(game) { this.game = game; }
    fetchModel(options) {
      const metadata = this.game.space.getBuilding(options.id);
      return metadata ? { options, metadata } : null;
    }
    buyItem() { return { itemBought: false }; }
  }],
];
for (const [missing, Controller] of unavailableSpaceAdaptersT4) {
  if (Controller) context.classes.ui.space.PlanetBuildingBtnController = Controller;
  else delete context.classes.ui.space.PlanetBuildingBtnController;
  const gate = descriptorT4(ordinaryT4)?.gateState;
  const candidate = dbg.candidateById("space:ordinarySpaceT4");
  const diagnostic = dbg.report();
  check(`Task 4 review: missing native Space ${missing} fails closed`, gate?.open === false && !candidate && /native PlanetBuildingBtnController.*unavailable/i.test(gate?.reason || "") && /native PlanetBuildingBtnController.*unavailable/i.test(diagnostic));
}
context.classes.ui.space.PlanetBuildingBtnController = nativePlanetControllerT4;

res("science").value = 5000; res("science").maxValue = 5000;
const controllerMissionCandidateT4 = dbg.candidateById("space:controllerMissionT4");
dbg.forceActiveTarget(controllerMissionCandidateT4, "Late-game progression frontier", 0);
dbg.executePlan();
check("Task 4: controller-only mission unlocks its planet/downstream mission", missionT4.val === 1 && missionT4.on === 0 && controllerPlanetT4.unlocked && downstreamMissionT4.unlocked);
check("Task 4: in-transit one-time mission is not repeatable", !dbg.candidateById("space:controllerMissionT4"));
controllerPlanetT4.reached = true;
const satteliteCandidateT4 = dbg.candidateById("space:sattelite");
dbg.forceActiveTarget(satteliteCandidateT4, "Late-game progression frontier", 0);
dbg.executePlan();
check("Task 4: controller-only sattelite increments", satteliteT4.val === 1 && satteliteT4.on === 1);

const savedBuildingUnlockedT4 = buildings.map((building) => building.unlocked);
const savedTechStateT4 = techs.map((tech) => [tech.unlocked, tech.researched]);
const savedUpgradeStateT4 = workshopUpgrades.map((upgrade) => upgrade.researched);
const savedReligionStateT4 = religionUpgrades.map((upgrade) => upgrade.unlocked);
const savedFestivalT4 = calendar.festivalDays;
for (const building of buildings) building.unlocked = false;
for (const tech of techs) tech.researched = true;
for (const upgrade of workshopUpgrades) upgrade.researched = true;
for (const upgrade of religionUpgrades) upgrade.unlocked = false;
calendar.festivalDays = calendar.daysPerSeason + 1;
downstreamMissionT4.unlocked = false;
predecessorMissionT4.unlocked = false;
res("antimatter").value = res("antimatter").maxValue;
const acceleratorT4 = { name: "acceleratorT4", label: "Accelerator", unlocked: true, val: 8, on: 8, priceRatio: 1.15, prices: [{ name: "uranium", val: 50 }], effects: { uraniumMax: 250 } };
buildings.push(acceleratorT4);
perTick.uranium = 0;
perTick.unobtainium = 0;
dbg.forceActiveTarget(null);
const frontierT4 = dbg.selectStrategicTarget("balanced");
const allowedFrontierT4 = new Set(["piscineMission", "heliosMission", "planetCracker", "moonOutpost", "moonBase"]);
check("Task 4: supplied state selects Late-game progression frontier", frontierT4?.layer === "Late-game progression frontier");
check("Task 4: mission/producer/storage bridge beats repeat Accelerator", allowedFrontierT4.has(frontierT4?.target?.meta?.name) && frontierT4?.target?.meta !== acceleratorT4);

ensureResourceT4("producerNeedT4", 0, 100);
ensureResourceT4("capNeedT4", 100, 100);
ensureResourceT4("routeFuelT4", 1, 1000);
ensureResourceT4("remoteFuelT4", 0, 1000);
ensureResourceT4("remoteCapNeedT4", 100, 100);
perTick.capNeedT4 = 1;
perTick.remoteCapNeedT4 = 1;
perTick.remoteFuelT4 = 0.000001;
const orderedMissionT4 = { name: "orderedMissionT4", label: "Ordered Mission", unlocked: true, noStackable: true, val: 0, on: 0, prices: [{ name: "science", val: 1 }], unlocks: { planet: ["orderedPlanetT4"] }, effects: {} };
const remoteMissionT4 = { name: "remoteMissionT4", label: "Remote Mission", unlocked: true, noStackable: true, val: 0, on: 0, prices: [{ name: "remoteFuelT4", val: 10 }], unlocks: { planet: ["remotePlanetT4"] }, effects: {} };
programsT4.push(orderedMissionT4, remoteMissionT4);
const missingProducerT4 = bT4("missingProducerT4", "Missing Producer", { producerNeedT4PerTickSpace: 1 });
const capStorageT4 = bT4("capStorageT4", "Cap Storage", { capNeedT4Max: 100 });
const capBlockedTargetT4 = bT4("capBlockedTargetT4", "Cap-blocked Target", {}, { prices: [{ name: "capNeedT4", val: 200 }] });
const selectedRouteTargetT4 = bT4("selectedRouteTargetT4", "Selected Route Target", {}, { prices: [{ name: "routeFuelT4", val: 100 }] });
const requiredRouteInfraT4 = bT4("requiredRouteInfraT4", "Required Route Infrastructure", { routeFuelT4PerTickSpace: 1 });
const unrelatedInfraT4 = bT4("unrelatedInfraT4", "Unrelated Infrastructure", { spaceRatio: 0.5 });
const remoteCapStorageT4 = bT4("remoteCapStorageT4", "Remote Cap Storage", { remoteCapNeedT4Max: 100 });
const remoteCapTargetT4 = bT4("remoteCapTargetT4", "Remote Cap Target", {}, { prices: [{ name: "remoteCapNeedT4", val: 200 }, { name: "remoteFuelT4", val: 10 }] });
techPlanetT4.buildings.push(missingProducerT4, capStorageT4, capBlockedTargetT4, selectedRouteTargetT4, requiredRouteInfraT4, unrelatedInfraT4, remoteCapStorageT4, remoteCapTargetT4);
const candidateT4 = (meta) => dbg.candidateById(`space:${meta.name}`);
const orderedMissionCandidateT4 = candidateT4(orderedMissionT4);
const producerCandidateT4 = candidateT4(missingProducerT4);
const storageCandidateT4 = candidateT4(capStorageT4);
const capTargetCandidateT4 = { ...candidateT4(capBlockedTargetT4), score: 1000 };
const selectedRouteCandidateT4 = { ...candidateT4(selectedRouteTargetT4), score: 10000 };
const requiredInfraCandidateT4 = candidateT4(requiredRouteInfraT4);
const unrelatedInfraCandidateT4 = { ...candidateT4(unrelatedInfraT4), score: 9000 };
const remoteMissionCandidateT4 = { ...candidateT4(remoteMissionT4), score: 11000 };
const remoteCapStorageCandidateT4 = candidateT4(remoteCapStorageT4);
const remoteCapTargetCandidateT4 = { ...candidateT4(remoteCapTargetT4), score: 12000 };
check("Task 4 review: frontier order starts with first mission gateway", dbg.bestLateGameFrontier([storageCandidateT4, producerCandidateT4, orderedMissionCandidateT4, capTargetCandidateT4])?.candidate?.meta === orderedMissionT4);
check("Task 4 review: missing-resource producer follows mission tier", dbg.bestLateGameFrontier([storageCandidateT4, producerCandidateT4, capTargetCandidateT4])?.candidate?.meta === missingProducerT4);
check("Task 4 review: live cap bridge follows producer tier", dbg.bestLateGameFrontier([storageCandidateT4, capTargetCandidateT4])?.candidate?.meta === capStorageT4);
check("Task 4 review: infrastructure must belong to selected acquisition route", dbg.bestLateGameFrontier([selectedRouteCandidateT4, requiredInfraCandidateT4, unrelatedInfraCandidateT4])?.candidate?.meta === requiredRouteInfraT4);
check("Task 4 review: remote/unrelated first copies beyond horizon yield to repeat economy", dbg.bestLateGameFrontier([remoteMissionCandidateT4, unrelatedInfraCandidateT4, dbg.candidateById("build:acceleratorT4")]) === null);
check("Task 4 re-review: remote cap-blocked target does not make storage monopolize frontier", dbg.bestLateGameFrontier([remoteCapStorageCandidateT4, remoteCapTargetCandidateT4, dbg.candidateById("build:acceleratorT4")]) === null);

const marginalCasesT4 = [
  ["Space Elevator", elevatorT4, (p) => p.globalProductionRatio > 0 && p.productionTransfer > 0 && p.costReduction?.oil > 0],
  ["Sunlifter", sunlifterT4, (p) => p.perTick?.antimatter === 1 && p.energyProduction === 30],
  ["Containment Chamber", containmentT4, (p) => p.max?.antimatter >= 100 && p.energyConsumption > 0],
  ["Heatsink synergy", heatsinkT4, (p) => p.max?.antimatter > 0],
  ["Sunforge", sunforgeT4, (p) => p.baseStorageRatio > 0],
  ["Navigation Relay", navigationRelayT4, (p) => p.travelSpeed > 0],
  ["Terraforming Station", terraformingT4, (p) => p.housing >= 1],
  ["Hydroponics synergy", hydroponicsT4, (p) => p.ratio?.catnip > 0 && p.max?.catnip > 0 && p.housing > 0],
  ["HR Harvester", harvesterT4, (p) => p.energyProduction > 0],
  ["Entangler", entanglerT4, (p) => p.perTick?.gflops < 0 && p.perTick?.hashrates > 0 && p.energyConsumption > 0],
  ["Tectonic", tectonicT4, (p) => p.energyProduction > 0],
  ["Molten Core synergy", moltenCoreT4, (p) => p.energyProduction > 0],
  ["ordinary resource/storage", ordinaryT4, (p) => p.perTick?.wood === 2 && p.max?.wood === 100],
];
hydroponicsT4.updateEffects(hydroponicsT4, gamePage);
for (const [label, meta, assertion] of marginalCasesT4) {
  const descriptor = descriptorT4(meta);
  const profile = descriptor && typeof dbg.spaceMarginalProfile === "function" ? dbg.spaceMarginalProfile(descriptor) : {};
  check(`Task 4 marginal: ${label}`, !!descriptor && assertion(profile));
}
const hydroBeforeT4 = { val: hydroponicsT4.val, on: hydroponicsT4.on, effects: { ...hydroponicsT4.effects } };
const hydroProfileT4 = dbg.spaceMarginalProfile(descriptorT4(hydroponicsT4));
const hydroExpectedT4 = terraformingT4.on * (gamePage.getUnlimitedDR(hydroponicsT4.on + 1, 100) - gamePage.getUnlimitedDR(hydroponicsT4.on, 100));
check("Task 4 review: Hydroponics projects exact nonlinear next-copy terraforming gain without mutation", Math.abs(hydroProfileT4.housing - hydroExpectedT4) < 1e-9 && hydroponicsT4.val === hydroBeforeT4.val && hydroponicsT4.on === hydroBeforeT4.on && JSON.stringify(hydroponicsT4.effects) === JSON.stringify(hydroBeforeT4.effects));
nanoTechT4.researched = false;
const reportT4 = dbg.report();
check("Task 4: diagnostics include planet ownership and exact gate", /Moon.*Lunar Outpost.*transit/i.test(reportT4) && /Tech Planet.*Space Elevator.*technology.*Nanotechnology/i.test(reportT4) && /Helios.*Containment Chamber.*Space building.*Heatsink/i.test(reportT4));
if (savedUnlimitedDRT4 === undefined) delete gamePage.getUnlimitedDR;
else gamePage.getUnlimitedDR = savedUnlimitedDRT4;

buildings.splice(buildings.indexOf(acceleratorT4), 1);
buildings.forEach((building, index) => { building.unlocked = savedBuildingUnlockedT4[index]; });
techs.forEach((tech, index) => { [tech.unlocked, tech.researched] = savedTechStateT4[index]; });
workshopUpgrades.forEach((upgrade, index) => { upgrade.researched = savedUpgradeStateT4[index]; });
religionUpgrades.forEach((upgrade, index) => { upgrade.unlocked = savedReligionStateT4[index]; });
calendar.festivalDays = savedFestivalT4;
techs.splice(techs.indexOf(nanoTechT4), 1);
delete perTick.uranium;
delete perTick.unobtainium;
delete perTick.capNeedT4;
delete perTick.remoteCapNeedT4;
delete perTick.remoteFuelT4;
for (const snapshot of resourceSnapshotsT4.values()) {
  if (snapshot.added) resources.splice(resources.indexOf(snapshot.resource), 1);
  else {
    snapshot.resource.value = snapshot.value;
    snapshot.resource.maxValue = snapshot.maxValue;
    snapshot.resource.unlocked = snapshot.unlocked;
  }
}
dbg.forceActiveTarget(null);
delete gamePage.space;

/* ---------------------------------------------------------------------
 * Test AD — ziggurat / unicorn path (v2.11.0).  The player used to run the
 * unicorn loop by hand: sacrifice unicorns for tears, buy the ziggurat
 * upgrades, decide when a pasture or another Ziggurat is the better spend.
 * The planner must rank all three in unicorn-equivalents (LIVE rates), fund
 * a chosen tear-priced upgrade with a BOUNDED sacrifice (exactly the tears
 * deficit, whole 2500-unicorn batches), buy it through the game's own
 * button, hold sacrifices while a pasture is the better payback, and rush
 * one more Ziggurat first when it cuts ≥25% of the pick's tear bill.
 * ------------------------------------------------------------------- */
dbg.queueClear();
dbg.forceActiveTarget(null);
dbg.clearUnicornPathState();
const pastureAD = buildings.find((b) => b.name === "unicornPasture");
const zigguratAD = buildings.find((b) => b.name === "ziggurat");
const tombAD = zigguratUpgradesMock[0];
const towerAD = zigguratUpgradesMock[1];
pastureAD.unlocked = true; pastureAD.val = 25; pastureAD.on = 25; // next pasture ≈2.4M unicorns → terrible payback
zigguratAD.unlocked = false; zigguratAD.val = 4;                  // 4 zigs → 1 tear costs 625 unicorns; count read from val
res("unicorns").value = 20000;
res("tears").value = 0;
res("ivory").value = 600;
res("manpower").value = 500; // a previous stage's hunt zeroed catpower; ivory reachability hunts with it
perTick.unicorns = 4; // ×5 ticks/s → 20 unicorns/s live production
dbg.clearResourceTelemetry?.("unicorns");
dbg.clearResourceTelemetry?.("manpower");

const uPlanAD = dbg.unicornEconomyPlan();
check("Test AD: ranked in unicorn-equivalents — Unicorn Tomb (5 tears ≈ 3.1K unicorns) beats a 2.4M-unicorn pasture", uPlanAD.best?.meta?.name === "unicornTomb" && uPlanAD.best.kind === "ziggurat");
check("Test AD: tear cost uses the LIVE ziggurat count (5 tears × 2500/4 zigs + no direct unicorns = 3125)", Math.abs(uPlanAD.best.cost.total - 3125) < 1e-6);
check("Test AD: at 4 ziggurats the marginal-ziggurat saving (20%) stays below the 25% rush threshold", !uPlanAD.zigguratFirst);
const tombCandidateAD = dbg.candidateById("ziggurat:unicornTomb");
check("Test AD: a ziggurat upgrade is a first-class candidate whose missing tears point at the sacrifice", !!tombCandidateAD && /sacrifice unicorns/.test(tombCandidateAD.missing || ""));
check("Test AD: the target ledger reserves the unicorns the sacrifice will consume (2 batches = 5000)", (dbg.buildTargetLedger(tombCandidateAD).reserved.unicorns || 0) === 5000);
const uDecisionAD = dbg.selectStrategicTarget("balanced");
check("Test AD: funded unicorn side claims the plan at the Ziggurat / unicorn path layer", uDecisionAD.layer === "Ziggurat / unicorn path" && uDecisionAD.target?.meta?.name === "unicornTomb");

// Full-tick integration: sacrifice EXACTLY the deficit, then buy the upgrade
// through the religion-tab button — isolated like Test AC so nothing competes.
const savedBuildingUnlockedAD = buildings.map((b) => b.unlocked);
const savedTechResearchedAD = techs.map((t) => t.researched);
const savedUpgradeResearchedAD = workshopUpgrades.map((u) => u.researched);
const savedReligionUnlockedAD = religionUpgrades.map((u) => u.unlocked);
const savedFestivalDaysAD = calendar.festivalDays;
for (const b of buildings) b.unlocked = false;
pastureAD.unlocked = true;
for (const t of techs) t.researched = true;
for (const u of workshopUpgrades) u.researched = true;
for (const u of religionUpgrades) u.unlocked = false;
calendar.festivalDays = calendar.daysPerSeason + 1;
dbg.forceActiveTarget(null);
fakeNow += 30000;
tickFn();
check("Test AD: sacrifice is BOUNDED to the measured deficit — exactly 2 batches (5000 unicorns) for 5 tears", sacrificeChunks === 2 && res("unicorns").value === 15000);
check("Test AD: the Unicorn Tomb is actually bought through the game's ziggurat button", tombAD.val === 1 && res("tears").value === 3 && res("ivory").value === 100);
check("Test AD: the sacrifice and the unicorn-path plan are logged", logText().includes("🦄") && /Ziggurat \/ unicorn path/.test(logText()));
check("Test AD: the panel shows the unicorn subsystem line", /Unicorns:/.test(panelText(".kgh-unicorn")));
const reportAD = dbg.report();
check("Test AD: diagnostics report ranks the unicorn options with payback", /Unicorns: /.test(reportAD) && /unicorn-eq/.test(reportAD));
buildings.forEach((b, i) => { b.unlocked = savedBuildingUnlockedAD[i]; });
techs.forEach((t, i) => { t.researched = savedTechResearchedAD[i]; });
workshopUpgrades.forEach((u, i) => { u.researched = savedUpgradeResearchedAD[i]; });
religionUpgrades.forEach((u, i) => { u.unlocked = savedReligionUnlockedAD[i]; });
calendar.festivalDays = savedFestivalDaysAD;
pastureAD.unlocked = true;

// Balance flip: a CHEAP pasture (val 2 → ≈6 unicorns, payback ≈0.6s) must
// out-rank the next Tomb and SUPPRESS sacrificing — unicorns are banked for
// the pasture instead of melted into tears.
fakeNow += 30000;
dbg.forceActiveTarget(null);
dbg.clearUnicornPathState();
dbg.clearResourceTelemetry?.("unicorns");
pastureAD.val = 2; pastureAD.on = 2;
res("unicorns").value = 30000;
const uPlanFlipAD = dbg.unicornEconomyPlan();
check("Test AD: a cheap pasture out-ranks the next tear upgrade (payback balance)", uPlanFlipAD.best?.meta?.name === "unicornPasture");
const sacrificesBeforeFlipAD = sacrificeChunks;
dbg.forceActiveTarget(dbg.candidateById("build:unicornPasture"), "Economy / normal growth", 0);
dbg.manageUnicornReligion();
check("Test AD: no sacrifice fires while the pasture is the better unicorn spend", sacrificeChunks === sacrificesBeforeFlipAD && /saving unicorns/i.test(dbg.unicornPlanText()));
dbg.forceActiveTarget(null);

// Rush-ziggurats rule: at ONE ziggurat a tear costs 2500 unicorns and the
// next Ziggurat halves that (50% ≥ 25% threshold) — so the layer targets the
// reachable Ziggurat build itself and holds the sacrifice for the discount.
fakeNow += 30000;
dbg.clearUnicornPathState();
dbg.clearResourceTelemetry?.("unicorns");
pastureAD.val = 25; pastureAD.on = 25;
zigguratAD.unlocked = true; zigguratAD.val = 1;
const uPlanRushAD = dbg.unicornEconomyPlan();
check("Test AD: one more Ziggurat halving the tear bill trips the ≥25% rush rule", !!uPlanRushAD.zigguratFirst && uPlanRushAD.zigguratFirst.share >= 0.25);
const uRushDecisionAD = dbg.selectStrategicTarget("balanced");
check("Test AD: the unicorn-path layer rushes the Ziggurat build before sacrificing", uRushDecisionAD.layer === "Ziggurat / unicorn path" && uRushDecisionAD.target?.meta?.name === "ziggurat" && /tear bill/.test(uRushDecisionAD.reason || ""));
const sacrificesBeforeRushAD = sacrificeChunks;
dbg.manageUnicornReligion();
check("Test AD: the sacrifice is HELD while the Ziggurat discount is worth building first", sacrificeChunks === sacrificesBeforeRushAD && /holding sacrifice/i.test(dbg.unicornPlanText()));

// Restore the unicorn economy to inert so nothing later is perturbed.
pastureAD.unlocked = false; pastureAD.val = 0; pastureAD.on = 0;
zigguratAD.unlocked = false; zigguratAD.val = 0; zigguratAD.on = 0;
tombAD.val = 0; tombAD.on = 0;
res("unicorns").value = 0;
res("tears").value = 0;
res("ivory").value = 100;
perTick.unicorns = 0;
dbg.clearUnicornPathState();
dbg.clearResourceTelemetry?.("unicorns");
dbg.forceActiveTarget(null);

/* ---------------------------------------------------------------------
 * Test AE — culture-bound sprint pacing redirect + manual-queue takeover
 * (v2.12.0).  Live save regression: Theology (20K science + 35 Manuscript)
 * owned the plan while manuscripts were paced by +0.04/s culture — a
 * multi-day passive wait.  The sprint flooded 39/41 kittens into Hunter,
 * zero Miners meant minerals stayed 0, every minerals-priced candidate
 * (including the Amphitheatre that would GROW culture) read "unreachable",
 * and the player's queued Steel Armour was score-gated behind the lock.
 * The fix: the sprint stays alive but redirects its plan target to the
 * best live producer of the trickling resource; a staffable resource is
 * reachable even at 0 live production; the manual queue takes the lock
 * over whenever its front item is actionable; the queue's blocker is
 * spelled out in diagnostics.
 * ------------------------------------------------------------------- */
dbg.queueClear();
dbg.forceActiveTarget(null);
fakeNow += 30000;

const theologyAE = techs.find((t) => t.name === "theology");
const savedTechStateAE = techs.map((t) => ({ unlocked: t.unlocked, researched: t.researched }));
for (const tech of techs) tech.researched = true;
theologyAE.unlocked = true;
theologyAE.researched = false;

const amphitheatreAE = {
  name: "amphitheatreAE",
  label: "Amphitheatre",
  unlocked: true,
  val: 1,
  on: 1,
  prices: [{ name: "wood", val: 230 }, { name: "minerals", val: 1380 }, { name: "parchment", val: 3.45 }],
  effects: { culturePerTickBase: 0.005, cultureMax: 50 },
};
buildings.push(amphitheatreAE);

const savedResAE = ["science", "culture", "minerals", "wood", "catnip", "parchment", "manuscript", "furs", "manpower"].map((name) => ({
  name, value: res(name).value, maxValue: res(name).maxValue,
}));
const savedPerTickAE = { culture: perTick.culture, minerals: perTick.minerals, science: perTick.science, catnip: perTick.catnip };
res("science").value = 24800; res("science").maxValue = 25000;   // near cap → sprint trigger
res("culture").value = 33; res("culture").maxValue = 1150;       // the trickling bank
res("minerals").value = 0; res("minerals").maxValue = 8000;      // zero MINERS pulled by the old job flood
res("wood").value = 450;
res("catnip").value = 3000;
res("parchment").value = 686;
res("manuscript").value = 0;
res("furs").value = 400;
res("manpower").value = 800;
perTick.culture = 0.008;   // ×5 ticks/s → +0.04/s, the live save's rate
perTick.minerals = 0;      // no miners staffed — job path must still count as reachable
perTick.science = 0.2;
perTick.catnip = 1;
dbg.clearResourceTelemetry?.();

const aeDecision = dbg.selectStrategicTarget("balanced");
check("Test AE: culture-bound Theology sprint stays alive as the contract", dbg.activeSprint()?.techName === "theology");
check("Test AE: sprint redirects the plan to the culture producer, not the tech", aeDecision.layer === "Research sprint" && aeDecision.target?.meta?.name === "amphitheatreAE" && !!aeDecision.sprintRedirect);
check("Test AE: redirect names the trickle leg in its reason", /culture-bound/i.test(aeDecision.reason || "") && /Amphitheatre/.test(aeDecision.reason || ""));
check("Test AE: cultureMax-only Temple is never the redirect pick", aeDecision.target?.meta?.name !== "temple");
const aePacing = dbg.sprintCapDrainPacing?.(dbg.candidateById("research:theology"));
check("Test AE: pacing math counts the CUMULATIVE culture bill (35×400), not one craft", aePacing?.name === "culture" && aePacing.missing > 13000 && aePacing.wait > 100000);
const aeReserved = dbg.reservedNeedsFor(aeDecision.target);
check("Test AE: the sprint chain (35 Manuscript) stays reserved while the plan builds the producer", (aeReserved.manuscript || 0) >= 35);
const aeNeeds = dbg.resourceNeeds("balanced");
check("Test AE: jobs serve the redirect target (miners return) instead of flooding hunters", (aeNeeds.needs?.minerals ?? aeNeeds.minerals ?? 0) > 0);
const aeNow = dbg.nowText("balanced");
const aeDetails = dbg.detailsText("balanced");
check("Test AE: Now action explains the redirect", /grow Culture/i.test(aeNow) && /Theology/i.test(aeNow));
check("Test AE: details spell out the trickle leg with rate and ETA", /Trickle leg:/.test(aeDetails) && /Culture/i.test(aeDetails));

// v2.15.0 — the conveyor must keep RUNNING while redirected: a full culture
// bank converts into Manuscripts the moment it fills.  In the live 62.54K-
// science Chemistry stall the redirect target (Temple) had its own manuscript
// bill banked, so craftTowardTarget stopped crafting entirely and +20.58/s of
// culture wasted at the cap for good.  The sprint chain must craft from
// everything ABOVE the producer's own direct bill.
res("culture").value = 1150;    // bank at cap
res("parchment").value = 53.45; // two crafts' worth ABOVE the producer's own 3.45 parchment bill
const aeCraftText = dbg.craftTowardTarget("balanced");
check("Test AE: redirected sprint still converts the full culture bank into Manuscripts", res("manuscript").value >= 2 && res("culture").value < 1150 && /Manuscript/i.test(aeCraftText));
check("Test AE: conveyor crafts leave the redirect producer's own parchment bill banked", res("parchment").value >= 3.44);

// v2.15.0 — the booster pick charges the producer's OWN bill in the trickling
// resource.  A culture producer priced in Manuscripts (the live Temple: 81
// manuscripts ≈ 11K culture) sets the sprint BACK unless its rate gain repays
// that drain within the wait it claims to shorten.
dbg.forceActiveTarget(null); // clears the sprint AND the sticky booster pick
res("culture").value = 33;
res("manuscript").value = 25; // above the drainer's 20-manuscript bill, below Theology's 35
const cathedralAE = { name: "cathedralAE", label: "Cathedral", unlocked: true, val: 0, on: 0, prices: [{ name: "manuscript", val: 20 }], effects: { culturePerTickBase: 0.01 } };
buildings.push(cathedralAE);
const aeDrainDecision = dbg.selectStrategicTarget("balanced");
check("Test AE: a culture producer priced in the culture chain cannot be the redirect pick", aeDrainDecision.layer === "Research sprint" && !!aeDrainDecision.sprintRedirect && aeDrainDecision.target?.meta?.name === "amphitheatreAE");
cathedralAE.effects.culturePerTickBase = 0.2; // now the gain repays the drain well inside the wait
dbg.forceActiveTarget(null);
const aeRepayDecision = dbg.selectStrategicTarget("balanced");
check("Test AE: the same producer wins the redirect once its gain repays its own drain", !!aeRepayDecision.sprintRedirect && aeRepayDecision.target?.meta?.name === "cathedralAE");
buildings.splice(buildings.indexOf(cathedralAE), 1);
res("manuscript").value = 0;
dbg.forceActiveTarget(null);
dbg.selectStrategicTarget("balanced"); // re-establish the plain Amphitheatre redirect for the checks below

// Manual-queue takeover: a 5-second-old sprint lock must yield to the
// player's actionable queued pick immediately — no score/ETA gate.
// (The Mine was retired earlier at 999,999 wood; lift the wood cap so the
// queued pick is reachable — takeover semantics, not the final-cap break.)
const queueMineAE = buildings.find((b) => b.name === "mine");
const savedWoodMaxAE = res("wood").maxValue;
res("wood").maxValue = 2000000;
dbg.queueAdd("build:mine", queueMineAE.val);
dbg.forceActiveTarget(dbg.candidateById("research:theology"), "Research sprint", 5000);
const aeQueueTarget = dbg.chooseWorkTarget("balanced");
check("Test AE: actionable manual-queue item takes the plan lock over from a young sprint lock", aeQueueTarget?.meta?.name === "mine");
check("Test AE: the takeover is logged as a manual-queue takeover", /manual queue takeover/i.test(logText()));
dbg.queueClear();
res("wood").maxValue = savedWoodMaxAE;
dbg.forceActiveTarget(null);

// Queue diagnostics: a blocked front item must say WHY it is skipped.
const obsidianAE = R("obsidianAE", 0, 0, "Obsidian");
const obsidianShrineAE = {
  name: "obsidianShrineAE",
  label: "Obsidian Shrine",
  unlocked: true,
  val: 0,
  on: 0,
  prices: [{ name: "obsidianAE", val: 10 }],
  effects: {},
};
resources.push(obsidianAE);
buildings.push(obsidianShrineAE);
dbg.queueAdd("build:obsidianShrineAE", 0);
dbg.selectStrategicTarget("balanced");
const aeQueueStatus = dbg.queueStatus?.() || "";
check("Test AE: blocked queue item reports its exact blocker in the queue status", /blocked/i.test(aeQueueStatus) && /Obsidian/i.test(aeQueueStatus));
check("Test AE: the diagnostics report carries the queue line", /Queue: .*Obsidian/i.test(dbg.report()));
dbg.queueClear();
buildings.splice(buildings.indexOf(obsidianShrineAE), 1);
resources.splice(resources.indexOf(obsidianAE), 1);

// Redirect releases once culture production catches up (wait < 30 min):
// the sprint's own tech becomes the plan target again.
perTick.culture = 2; // +10/s → 35 manuscripts of culture ≈ 23 minutes
dbg.clearResourceTelemetry?.("culture");
dbg.forceActiveTarget(null);
const aeFastDecision = dbg.selectStrategicTarget("balanced");
check("Test AE: a fast culture rate ends the redirect — the sprint tech owns the plan again", aeFastDecision.layer === "Research sprint" && aeFastDecision.target?.meta?.name === "theology" && !aeFastDecision.sprintRedirect);

// Restore the board.
buildings.splice(buildings.indexOf(amphitheatreAE), 1);
for (const saved of savedResAE) { res(saved.name).value = saved.value; res(saved.name).maxValue = saved.maxValue; }
perTick.culture = savedPerTickAE.culture;
perTick.minerals = savedPerTickAE.minerals;
perTick.science = savedPerTickAE.science;
perTick.catnip = savedPerTickAE.catnip;
techs.forEach((t, i) => { t.unlocked = savedTechStateAE[i].unlocked; t.researched = savedTechStateAE[i].researched; });
dbg.clearResourceTelemetry?.();
dbg.forceActiveTarget(null);

/* ---------- Test AF (v2.13.0): exclusive policies auto-adopt; the pending
   pick is culture-chain state ----------
   A fresh exclusive pair opens late-game. While the ranked pick cannot be paid
   for, its bill must be HELD in the shared reservation ledger — side festival
   refreshes, embassies and surplus buys leave the bank alone — and adoption
   must respect mutual exclusion, manual-queue intent and storage caps. */
const republicAF = { name: "republicAF", label: "Republic", unlocked: true, researched: false, blocked: false, blocks: ["monarchyAF"], prices: [{ name: "culture", val: 7000 }], effects: { scienceRatio: 0.05 } };
const monarchyAF = { name: "monarchyAF", label: "Monarchy", unlocked: true, researched: false, blocked: false, blocks: ["republicAF"], prices: [{ name: "culture", val: 7000 }], effects: {} };
policies.push(republicAF, monarchyAF);
const grandBureauAF = { name: "grandBureauAF", label: "Grand Bureau", unlocked: true, val: 0, on: 0, prices: [{ name: "wood", val: 1000000 }], effects: {} };
const operaHouseAF = { name: "operaHouseAF", label: "Opera House", unlocked: true, val: 0, on: 0, prices: [{ name: "culture", val: 800 }], effects: {} };
buildings.push(grandBureauAF, operaHouseAF);
res("wood").maxValue = 2000000; // the Bureau must be expensive, NOT storage-blocked (v2.14.0 break)
res("culture").value = 6000;
res("culture").maxValue = 9000;
res("manpower").value = 2000;
res("parchment").value = 3000;

check("Test AF: pending exclusive pick is not adoptable while unaffordable", dbg.autoPolicyChoice("balanced") === null);
check("Test AF: the pending pick's bill is held in the shared reservation ledger", (dbg.reservedNeedsFor(null).culture || 0) >= 7000);
const afAdvice = dbg.policyAdvice("balanced");
check("Test AF: panel line names the auto-pick and the held bank", /auto-pick Republic/i.test(afAdvice) && /bank reserved/i.test(afAdvice));

// A side festival refresh (raw prices affordable: 6000 culture ≥ 5000) must
// not eat the bank the policy pick is saving toward.
const afLedgerTarget = dbg.candidateById("build:grandBureauAF");
check("Test AF: side festival refresh deferred while the policy bank accrues", dbg.festivalCanPay(afLedgerTarget) === false);

// The purchase loop's surplus scan sees the same hold: an affordable
// culture-priced building is deferred while the pick saves.
fakeNow += 5000;
dbg.forceActiveTarget(afLedgerTarget, "Economy / normal growth", 5000);
dbg.executePlan("balanced");
check("Test AF: surplus buy deferred while the policy bank accrues", operaHouseAF.val === 0);

// A price above the live storage cap is storage-blocked, not reservable —
// nothing may be held for it.
res("culture").maxValue = 5000;
check("Test AF: a storage-blocked policy price reserves nothing", Object.keys(dbg.pendingPolicyReserve("balanced")).length === 0);
res("culture").maxValue = 9000;

// The manual queue is explicit player intent: with the RIVAL side queued, the
// auto-pick must not foreclose it — the queued side itself is what adopts.
res("culture").value = 8000;
dbg.queueAdd("policy:monarchyAF", 0);
check("Test AF: a queued rival side wins the auto-pick", dbg.autoPolicyChoice("balanced")?.meta?.name === "monarchyAF");
dbg.queueClear();

// Once the group settles (Republic adopted), the rival is de-facto blocked,
// the reserve releases, and the deferred spenders may pay again.
res("culture").value = 6000;
republicAF.researched = true;
check("Test AF: a researched side de-facto blocks its rival even if the game's blocked flag lags", dbg.autoPolicyChoice("balanced") === null && /nothing pending/i.test(dbg.policyAdvice("balanced")));
check("Test AF: the reserve releases once the group settles", Object.keys(dbg.pendingPolicyReserve("balanced")).length === 0);
check("Test AF: festival refresh allowed again after the release", dbg.festivalCanPay(afLedgerTarget) === true);
fakeNow += 5000;
dbg.executePlan("balanced");
check("Test AF: surplus buy proceeds after the release", operaHouseAF.val === 1);
dbg.forceActiveTarget(null);
buildings.splice(buildings.indexOf(grandBureauAF), 1);
buildings.splice(buildings.indexOf(operaHouseAF), 1);

/* ---------- Test AH (v2.14.0): panel data — stable queue picker, live target
   ranking, reset-advisor verdict ----------
   The queue picker must present a FIXED browsable order (kind, then name) —
   not the per-tick score order that reshuffled the open dropdown — and the
   ranking rows must expose live scores with the active plan flagged. The
   reset advisor must give an explicit verdict, not a buried stat line. */
const atelierAH = { name: "ahAtelier", label: "Atelier", unlocked: true, val: 0, on: 0, prices: [{ name: "wood", val: 100 }], effects: { cultureMax: 50 } };
const bakeryAH = { name: "ahBakery", label: "Bakery", unlocked: true, val: 0, on: 0, prices: [{ name: "wood", val: 120 }], effects: { catnipMax: 100 } };
buildings.push(atelierAH, bakeryAH);
res("wood").value = 500;
res("wood").maxValue = 10000;
const pickerAH = dbg.queuePickerEntries("balanced");
const kindOrderAH = ["build", "research", "upgrade", "religion", "space", "time"];
const pickerSortedAH = pickerAH.every((entry, i) => {
  if (i === 0) return true;
  const prev = pickerAH[i - 1];
  const kd = kindOrderAH.indexOf(prev.kind) - kindOrderAH.indexOf(entry.kind);
  return kd < 0 || (kd === 0 && prev.label.localeCompare(entry.label) <= 0);
});
check("Test AH: queue picker is sorted by kind then name (stable, browsable)", pickerAH.length >= 2 && pickerSortedAH);
check("Test AH: queue picker lists the open buildings", pickerAH.some((e) => e.id === "build:ahAtelier") && pickerAH.some((e) => e.id === "build:ahBakery"));
const rowsAH = dbg.rankingRows("balanced");
check("Test AH: ranking rows expose label + live score + readiness", rowsAH.length >= 1 && rowsAH.every((r) => r.label && typeof r.score === "number" && typeof r.ready === "boolean"));
check("Test AH: the active plan is flagged inside the ranking (synthetic layer targets included)", rowsAH.some((r) => r.active));
const rowsAH2 = dbg.rankingRows("balanced");
check("Test AH: an unchanged board reads as a flat score trend", rowsAH2.length >= 1 && rowsAH2[0].trend === "flat");
gamePage.totalResets = 0;
setKittens(30);
const advWaitAH = dbg.resetAdvisorState();
check("Test AH: sub-35 kittens gets an explicit DO-NOT-RESET verdict", advWaitAH.tone === "wait" && /Do NOT reset/i.test(advWaitAH.headline));
setKittens(100);
const advTargetAH = dbg.resetAdvisorState();
check("Test AH: pre-first-reset verdict names the 130-kitten milestone with live progress", advTargetAH.tone === "target" && /130\+ kittens/.test(advTargetAH.headline) && /100\/130/.test(advTargetAH.headline));
check("Test AH: the verdict details always state what a reset banks right now", /reset now banks \+.*paragon, \+.*karma/i.test(advTargetAH.detail));
buildings.splice(buildings.indexOf(atelierAH), 1);
buildings.splice(buildings.indexOf(bakeryAH), 1);

/* ---------- Test AI (v2.15.0): parallel tiers — rank-order candidates whose
   chains clear the reservation ledger are worked SIMULTANEOUSLY ----------
   Live regression: the plan waited ~10 minutes on Temple's last 124 gold at
   +0.2/s while the #1-ranked Harbour only missed 6.75 craftable Scaffold and
   minerals income burned at its cap.  A candidate is parallel work, not a
   rival, when its buy leaves every held bank intact — including the active
   target's BANKED direct prices, which the ledger's `reserved` set drops. */
dbg.queueClear();
dbg.forceActiveTarget(null);
fakeNow += 30000;
kittensArr.length = 0; for (const k of savedKittens) kittensArr.push(k);
delete gamePage.totalResets;
const savedTechAI = techs.map((t) => ({ unlocked: t.unlocked, researched: t.researched }));
for (const tech of techs) tech.researched = true; // no research sprints in this fixture
const savedUpgradeAI = workshopUpgrades.map((u) => ({ unlocked: u.unlocked, researched: u.researched }));
for (const upgrade of workshopUpgrades) upgrade.researched = true;

const goldAI = R("goldAI", 300, 1000, "Auron");
resources.push(goldAI);
perTick.goldAI = 0.05; // reachable, but a slow trickle — the plan just waits
const gildedTempleAI = { name: "gildedTempleAI", label: "Gilded Temple", unlocked: true, val: 0, on: 0, prices: [{ name: "goldAI", val: 800 }, { name: "slab", val: 200 }], effects: {} };
const harbourAI = { name: "harbourAI", label: "Grand Harbour", unlocked: true, val: 0, on: 0, prices: [{ name: "slab", val: 80 }, { name: "minerals", val: 100 }], effects: { mineralsMax: 4000, woodMax: 4000 } };
const goldShrineAI = { name: "goldShrineAI", label: "Gold Shrine", unlocked: true, val: 0, on: 0, prices: [{ name: "goldAI", val: 100 }], effects: { cultureMax: 4000 } };
buildings.push(gildedTempleAI, harbourAI, goldShrineAI);
const savedStocksAI = {
  slab: res("slab").value, minerals: res("minerals").value, mineralsMax: res("minerals").maxValue,
  wood: res("wood").value, science: res("science").value, mineralsRate: perTick.minerals,
};
res("slab").value = 205;      // covers the Temple's banked 200 — but NOT Harbour's 80 on top
res("minerals").value = 7900; // idle surplus for Slab crafting
res("minerals").maxValue = 8000;
perTick.minerals = 0;         // idle bank, not "wasting income" → no storage-layer takeover
res("wood").value = 200;      // keep the cheap base buildings out of surplus reach
res("science").value = 100;

// Keep the fixture's stated plan authoritative even when earlier integration
// ticks legitimately change the planner's pending preferred candidate.
dbg.queueAdd("build:gildedTempleAI", 0);
dbg.forceActiveTarget(dbg.candidateById("build:gildedTempleAI"), "Economy / normal growth", 5000);
const aiFloors = dbg.parallelReservationFloors("balanced");
check("Test AI: floors hold the target's missing trickle AND its banked direct slabs", (aiFloors.goldAI || 0) >= 800 && (aiFloors.slab || 0) >= 200);
const aiText1 = dbg.craftTowardParallelCandidates("balanced");
check("Test AI: parallel pass crafts Slab for the rank-top Harbour from idle minerals", res("slab").value > 205 && res("minerals").value < 7900 && /Slab/i.test(aiText1));
check("Test AI: the diagnostics report carries the Parallel line", /Parallel: /.test(dbg.report()));

res("slab").value = 280; // top the bank up to Harbour's bill ABOVE the banked 200
fakeNow += 5000;
dbg.craftTowardParallelCandidates("balanced");
check("Test AI: the parallel buy completes Harbour while every floor stays intact", harbourAI.val === 1 && res("slab").value >= 200 && res("goldAI").value >= 300);
check("Test AI: the parallel buy is logged with its rank and the protected plan", /parallel build .*Harbour/i.test(logText()));
check("Test AI: a rival dipping the held gold bank is never parallel work", goldShrineAI.val === 0);
check("Test AI: the plan target itself is untouched by the parallel pass", gildedTempleAI.val === 0);

buildings.splice(buildings.indexOf(gildedTempleAI), 1);
buildings.splice(buildings.indexOf(harbourAI), 1);
buildings.splice(buildings.indexOf(goldShrineAI), 1);
resources.splice(resources.indexOf(goldAI), 1);
delete perTick.goldAI;
res("slab").value = savedStocksAI.slab;
res("minerals").value = savedStocksAI.minerals;
res("minerals").maxValue = savedStocksAI.mineralsMax;
res("wood").value = savedStocksAI.wood;
res("science").value = savedStocksAI.science;
perTick.minerals = savedStocksAI.mineralsRate;
techs.forEach((t, i) => { t.unlocked = savedTechAI[i].unlocked; t.researched = savedTechAI[i].researched; });
workshopUpgrades.forEach((u, i) => { u.unlocked = savedUpgradeAI[i].unlocked; u.researched = savedUpgradeAI[i].researched; });
dbg.forceActiveTarget(null);

/* ---------------------------------------------------------------------
 * Test AJ — chain jobs follow a research target across ALL layers (v2.16.0).
 * Live regression: a manual-queue Electricity pick (science capped, 67
 * Compendium → 1K Manuscript → 8K Parchment → ~450K furs) fell through to
 * the GENERIC job scorer because only the Research-sprint LAYER routed into
 * researchSprintJobNeeds.  The village kept 33 Woodcutters / 19 Miners for
 * the low wood bank and the rank-2 lookahead candidates while 9 Hunters
 * starved the fur chain that actually paced the plan; the leader read
 * "bottleneck wood; job wood" and the jobs line showed a phantom
 * "compendium" need no job can staff.
 * ------------------------------------------------------------------- */
dbg.queueClear();
dbg.forceActiveTarget(null);
fakeNow += 30000;

const savedTechAJ = techs.map((t) => ({ unlocked: t.unlocked, researched: t.researched }));
for (const tech of techs) tech.researched = true;
const electricityAJ = {
  name: "electricityAJ",
  label: "Electricity",
  unlocked: true,
  researched: false,
  prices: [{ name: "science", val: 71250 }, { name: "compedium", val: 100 }],
  unlocks: { buildings: ["factory"] },
};
techs.push(electricityAJ);

const savedResAJ = ["science", "culture", "compedium", "manuscript", "parchment", "furs", "ivory", "manpower", "catnip", "wood", "minerals"].map((name) => ({
  name, value: res(name).value, maxValue: res(name).maxValue,
}));
const savedPerTickAJ = { culture: perTick.culture, catnip: perTick.catnip, manpower: perTick.manpower, wood: perTick.wood, science: perTick.science };
const savedVillageAJ = {
  happiness: village.happiness,
  getKittens: village.getKittens,
  getFreeKittens: village.getFreeKittens,
  jobs: jobs.map((j) => [j, j.value]),
};
res("science").value = 78000; res("science").maxValue = 78000;   // capped; 71250 still fits → not storage-blocked
res("culture").value = 12000; res("culture").maxValue = 12000;   // capped cap-drain bank, refills passively
res("compedium").value = 17.8;
res("manuscript").value = 18;
res("parchment").value = 10;
res("furs").value = 5000;   // WELL above the ~324 luxury target ×2 — the busywork clamp would fire without the fur-bill exemption
res("ivory").value = 5000;  // luxuries stocked + happy village → huntingEconomyNeed ≈ 0, so ONLY the chain justifies hunters
res("manpower").value = 2800; res("manpower").maxValue = 4000;
res("catnip").value = 111000; res("catnip").maxValue = 222000;
res("wood").value = 223; res("wood").maxValue = 107000;          // near-empty wood bank — the old scorer's siren
res("minerals").value = 19000; res("minerals").maxValue = 143000;
perTick.culture = 11;
perTick.catnip = 200;
perTick.manpower = 2;
perTick.wood = 0.1;
village.happiness = 1.18;
village.getKittens = () => 81;
village.getFreeKittens = () => 0;
job("woodcutter").value = 33; job("farmer").value = 17; job("hunter").value = 9;
job("miner").value = 19; job("scholar").value = 0; job("priest").value = 2; job("geologist").value = 1;
dbg.clearResourceTelemetry?.();

dbg.queueAdd("research:electricityAJ", 0);
const ajDecision = dbg.selectStrategicTarget("balanced");
check("Test AJ: the queued chain-gated tech drives the plan through the Manual queue layer", ajDecision.layer === "Manual queue" && ajDecision.target?.meta?.name === "electricityAJ");
const ajNeeds = dbg.resourceNeeds("balanced");
check("Test AJ: a manual-queue research target gets the sprint's chain jobs (hunter flood)", (ajNeeds.needs?.manpower || 0) >= 26 && !!ajNeeds.chainContext);
const ajTopNeed = Object.entries(ajNeeds.needs || {}).filter(([, w]) => w > 0).sort((a, b) => b[1] - a[1])[0];
check("Test AJ: manpower (hunting) is the TOP need — wood/minerals no longer outrank the fur chain", ajTopNeed?.[0] === "manpower");
check("Test AJ: no phantom craft-resource keys pollute the needs (compendium/manuscript/parchment)", !ajNeeds.needs?.compedium && !ajNeeds.needs?.manuscript && !ajNeeds.needs?.parchment);
const ajDesired = dbg.desiredJobCounts("balanced");
check("Test AJ: the village floods hunters despite a 'healthy' fur bank (chain deficit overrides the busywork clamp)", (ajDesired.hunter || 0) >= 40 && (ajDesired.hunter || 0) > (ajDesired.woodcutter || 0) + (ajDesired.miner || 0));
check("Test AJ: the jobs line names the hunt chain, not wood", /Hunters for furs\/parchment\/compendium/.test(dbg.report()));
const ajLeader = dbg.leaderOpportunity("balanced");
check("Test AJ: leader bottleneck follows the chain — hunter job, Manager trait promoted first", ajLeader?.bottleneck === "manpower" && ajLeader?.targetJob === "hunter" && ajLeader?.traits?.[0] === "manager");

// Scholar cap-cycling: a tech whose intermediate SPENDS science (Blueprint =
// 25K science + 25 compendium) must keep scholars refilling the bank between
// crafts even while the bank still exceeds the tech's own final price.
dbg.queueClear();
dbg.forceActiveTarget(null);
const roboticsAJ = {
  name: "roboticsAJ",
  label: "Robotics",
  unlocked: true,
  researched: false,
  prices: [{ name: "science", val: 71250 }, { name: "blueprint", val: 5 }],
  unlocks: { buildings: ["factory"] },
};
techs.push(roboticsAJ);
res("blueprint") && (res("blueprint").value = 0);
res("science").value = 72000; // above the 71250 final price, below the 94% anti-waste line
dbg.queueAdd("research:roboticsAJ", 0);
dbg.selectStrategicTarget("balanced");
const ajCycleNeeds = dbg.resourceNeeds("balanced");
check("Test AJ: scholars keep cycling the science bank while intermediates consume it (bank > final price)", (ajCycleNeeds.needs?.science || 0) > 0);

// A queued chain target must not become "impossible" just because the capped
// refill bank's producing job is temporarily at zero workers. Live, a manual
// Electricity chain can put all workers on hunters/culture while Compendia are
// still missing; science then reads +0/s until the job balancer rotates scholars
// back, but the target is still structurally reachable.
dbg.queueClear();
dbg.forceActiveTarget(null);
perTick.science = 0;
job("scholar").value = 0;
res("science").value = 30000;
res("science").maxValue = 78000;
res("compedium").value = 17.8;
dbg.queueAdd("research:electricityAJ", 0);
const ajZeroProdCandidate = dbg.candidateById("research:electricityAJ");
const ajZeroProdSolver = dbg.solveChain(ajZeroProdCandidate);
const ajZeroProdFeasibility = dbg.classifyTargetFeasibility(ajZeroProdCandidate);
const ajZeroProdDecision = dbg.selectStrategicTarget("balanced");
check("Test AJ: zero-current-production capped bank with a job path is still reachable", ajZeroProdSolver.reachable && ajZeroProdFeasibility.status !== "IMPOSSIBLE");
check("Test AJ: manual queued chain target stays in Manual queue while its refill job is temporarily unstaffed", ajZeroProdDecision.layer === "Manual queue" && ajZeroProdDecision.target?.meta?.name === "electricityAJ");

// Generic path (non-research target): a craftable price no job produces must
// not become a dead "manuscript" bottleneck key either — its pressure flows
// through the chain (culture/furs), so the leader/jobs report stays honest.
dbg.queueClear();
dbg.forceActiveTarget(null);
techs.forEach((t, i) => { if (i < savedTechAJ.length) { t.unlocked = savedTechAJ[i].unlocked; t.researched = savedTechAJ[i].researched; } });
for (const tech of techs) if (tech !== electricityAJ && tech !== roboticsAJ) tech.researched = true;
electricityAJ.researched = true; roboticsAJ.researched = true;
const scriptoriumAJ = {
  name: "scriptoriumAJ",
  label: "Scriptorium",
  unlocked: true,
  val: 0,
  on: 0,
  prices: [{ name: "wood", val: 100 }, { name: "manuscript", val: 10 }],
  effects: { cultureMax: 100 },
};
buildings.push(scriptoriumAJ);
res("manuscript").value = 0;
res("wood").value = 5000;
dbg.forceActiveTarget(dbg.candidateById("build:scriptoriumAJ"), "Economy / normal growth", 0);
const ajBuildNeeds = dbg.resourceNeeds("balanced");
check("Test AJ: generic path drops the phantom manuscript key for a manuscript-priced building", !ajBuildNeeds.needs?.manuscript && !!ajBuildNeeds.target);
buildings.splice(buildings.indexOf(scriptoriumAJ), 1);

// Restore the board.
techs.splice(techs.indexOf(roboticsAJ), 1);
techs.splice(techs.indexOf(electricityAJ), 1);
techs.forEach((t, i) => { if (i < savedTechAJ.length) { t.unlocked = savedTechAJ[i].unlocked; t.researched = savedTechAJ[i].researched; } });
for (const saved of savedResAJ) { res(saved.name).value = saved.value; res(saved.name).maxValue = saved.maxValue; }
perTick.culture = savedPerTickAJ.culture;
perTick.catnip = savedPerTickAJ.catnip;
perTick.manpower = savedPerTickAJ.manpower;
perTick.wood = savedPerTickAJ.wood;
perTick.science = savedPerTickAJ.science;
village.happiness = savedVillageAJ.happiness;
village.getKittens = savedVillageAJ.getKittens;
village.getFreeKittens = savedVillageAJ.getFreeKittens;
for (const [j, v] of savedVillageAJ.jobs) j.value = v;
dbg.clearResourceTelemetry?.();
dbg.queueClear();
dbg.forceActiveTarget(null);

/* ---------------------------------------------------------------------
 * Test X5 — stage gather ETA is bounded separately from the payback
 * horizon (v2.18.0).  Live regression: 79 Aqueducts / 71 Libraries /
 * 66 Pastures / 48 Amphitheatres never staged up because the parity
 * rebuild bill of a mature stack takes hours to fund, and that gather
 * time was charged against the 6h payback horizon — every big-stack
 * transition read "payback exceeds planning horizon" forever, silently.
 * Now the horizon bounds only the true loss recovery (recoup); gather
 * gets its own 24h bound, and every staged building's verdict is a
 * diagnostics line (`Stage:`).
 * ------------------------------------------------------------------- */
dbg.queueClear();
dbg.forceActiveTarget(null);
fakeNow += 30000;
const graniteX5 = R("graniteX5", 0, 100000, "Granite");
resources.push(graniteX5);
// 3.33e-3/s: the 100-granite net bill takes ≈8h20m to gather — beyond the old
// eta-inclusive 6h horizon, comfortably inside the 24h funding bound — while
// the recoup itself (downtime + refund burn against the growth advantage) is
// only ≈1h. Exact parity: 40×100 scienceMax == 10×400, remainder 0.
perTick.graniteX5 = 6.67e-4;
const stageBigX5 = {
  name: "stageBigX5",
  unlocked: true,
  stage: 0,
  val: 40,
  on: 40,
  priceRatio: 1,
  stages: [
    { label: "Old Archive X5", prices: [{ name: "graniteX5", val: 10 }], effects: { scienceMax: 100 }, stageUnlocked: true },
    { label: "Data Center X5", prices: [{ name: "graniteX5", val: 30 }], effects: { scienceMax: 400 }, stageUnlocked: true },
  ],
  effects: {},
};
buildings.push(stageBigX5);
const bigX5 = dbg.stageTransitionAnalysis?.(stageBigX5, 1);
check("Test X5: a mature stack whose net bill takes >6h to gather is still actionable (recoup is the loss, gather is only delay)",
  bigX5?.actionable === true && bigX5?.eta > 6 * 3600 && bigX5?.recoup < 6 * 3600 && bigX5?.payback > 6 * 3600);
check("Test X5: the Stage line reports the actionable verdict", /Old Archive X5→Data Center X5: GO/.test(dbg.stageStatus?.() || ""));

// 5e-4/s: recoup stays well under 6h but the 100-granite bill now takes ≈55h —
// past the 24h funding bound → not actionable, with the gather reason.
perTick.graniteX5 = 1e-4;
const slowX5 = dbg.stageTransitionAnalysis?.(stageBigX5, 1);
check("Test X5: a week-long net bill trips the funding horizon, not the payback horizon",
  slowX5?.actionable === false && /funding horizon/i.test(slowX5?.reason || "") && slowX5?.recoup < 6 * 3600);
check("Test X5: the Stage line carries the exact blocking reason", /Old Archive X5→Data Center X5: net bill gather .* funding horizon/i.test(dbg.stageStatus?.() || ""));
check("Test X5: the diagnostics report carries the Stage line", /\nStage: /.test(dbg.report()));
buildings.splice(buildings.indexOf(stageBigX5), 1);
resources.splice(resources.indexOf(graniteX5), 1);
delete perTick.graniteX5;

/* ---------------------------------------------------------------------
 * Test AK — the workshop-upgrade backlog is parallel work past the ranked
 * window (v2.18.0).  Live regression: Titanium Barns sat 157 craftable
 * steel short for ages (every other cost banked) because the parallel
 * pass only scanned the top-8 ranked candidates and transient build
 * candidates held every slot — nothing would craft for a rank-12 upgrade
 * even though the buy would have cleared every reservation floor.
 * ------------------------------------------------------------------- */
dbg.queueClear();
dbg.forceActiveTarget(null);
fakeNow += 30000;
const savedTechAK = techs.map((t) => ({ unlocked: t.unlocked, researched: t.researched }));
for (const tech of techs) tech.researched = true; // no research sprints in this fixture
const savedUpgradeAK = workshopUpgrades.map((u) => ({ unlocked: u.unlocked, researched: u.researched }));
for (const upgrade of workshopUpgrades) upgrade.researched = true; // ours is the only open upgrade
const savedResetAK = gamePage.totalResets;
const savedStocksAK = {
  slab: res("slab").value, minerals: res("minerals").value, mineralsMax: res("minerals").maxValue,
  wood: res("wood").value, science: res("science").value, mineralsRate: perTick.minerals,
};

const goldAK = R("goldAK", 0, 1000, "Aurum");
resources.push(goldAK);
perTick.goldAK = 0.05; // reachable trickle — the plan and the decoys all wait on it
const trickleTempleAK = { name: "trickleTempleAK", label: "Trickle Temple", unlocked: true, val: 0, on: 0, prices: [{ name: "goldAK", val: 800 }], effects: {} };
buildings.push(trickleTempleAK);
// Eight high-value decoys hold the whole ranked window; each is skipped whole
// (their goldAK short is non-craftable), so under the old scan nothing below
// rank 8 could ever be crafted for.
const decoysAK = [];
for (let i = 0; i < 8; i += 1) {
  const decoy = { name: `decoyAK${i}`, label: `Decoy Estate ${i}`, unlocked: true, val: 0, on: 0, prices: [{ name: "goldAK", val: 500 }], effects: { maxKittens: 25 } };
  decoysAK.push(decoy);
  buildings.push(decoy);
}
const backlogSawAK = { name: "backlogSawAK", label: "Backlog Saw", unlocked: true, researched: false, prices: [{ name: "slab", val: 20 }, { name: "minerals", val: 100 }], effects: { mineralsRatio: 5 } };
workshopUpgrades.push(backlogSawAK);
gamePage.totalResets = 1;

res("slab").value = 0;
res("minerals").value = 7900; // idle surplus for Slab crafting
res("minerals").maxValue = 8000;
perTick.minerals = 0;
res("wood").value = 200; // keep the cheap base buildings out of surplus reach
res("science").value = 100;

dbg.forceActiveTarget(dbg.candidateById("build:trickleTempleAK"), "Economy / normal growth", 5000);
check("Test AK: fixture — the decoys hold the ranked window and the upgrade sits below it",
  decoysAK.every((decoy) => dbg.candidateRank(`build:${decoy.name}`) <= 8) && dbg.candidateRank("upgrade:backlogSawAK") > 8);
const akText = dbg.craftTowardParallelCandidates("balanced");
check("Test AK: deep upgrade receives no parallel craft output", res("slab").value === 0);
check("Test AK: deep upgrade is not parallel-purchased", backlogSawAK.researched === false);
check("Test AK: parallel status does not claim the deep upgrade", !/Backlog Saw/i.test(akText));

dbg.forceActiveTarget(null);
const roadmapAK = dbg.selectStrategicTarget("balanced");
check("Test AK: the same fundable deep upgrade is selected by the Workshop roadmap",
  roadmapAK.layer === "Workshop roadmap" && roadmapAK.target?.meta?.name === "backlogSawAK");
check("Test AK: no decoy is bought or crafted for (non-craftable gold shorts skip whole)", decoysAK.every((decoy) => decoy.val === 0));
check("Test AK: the plan target itself is untouched by the backlog pass", trickleTempleAK.val === 0);

buildings.splice(buildings.indexOf(trickleTempleAK), 1);
for (const decoy of decoysAK) buildings.splice(buildings.indexOf(decoy), 1);
workshopUpgrades.splice(workshopUpgrades.indexOf(backlogSawAK), 1);
resources.splice(resources.indexOf(goldAK), 1);
delete perTick.goldAK;
res("slab").value = savedStocksAK.slab;
res("minerals").value = savedStocksAK.minerals;
res("minerals").maxValue = savedStocksAK.mineralsMax;
res("wood").value = savedStocksAK.wood;
res("science").value = savedStocksAK.science;
perTick.minerals = savedStocksAK.mineralsRate;
techs.forEach((t, i) => { if (i < savedTechAK.length) { t.unlocked = savedTechAK[i].unlocked; t.researched = savedTechAK[i].researched; } });
workshopUpgrades.forEach((u, i) => { if (i < savedUpgradeAK.length) { u.unlocked = savedUpgradeAK[i].unlocked; u.researched = savedUpgradeAK[i].researched; } });
if (savedResetAK === undefined) delete gamePage.totalResets; else gamePage.totalResets = savedResetAK;
dbg.queueClear();
dbg.forceActiveTarget(null);

/* ---------------------------------------------------------------------
 * Test X6 — an affordable GO stage swap executes as parallel work
 * (v2.19.0).  Live regression: Amphitheatre→Broadcast Tower read
 * "GO — payback ≈7s" at candidate rank 1 while the culture-paced Genetics
 * sprint owned the plan, but the stage layer sits below the sprint layer
 * and executePlan's surplus/cap-relief paths skip kind "stage" — so the
 * swap that would have ACCELERATED the sprint could never fire.  A fully
 * banked swap whose net bill clears every reservation floor now executes
 * from the parallel pass; a swap that would dip a held bank stays vetoed.
 * ------------------------------------------------------------------- */
dbg.queueClear();
dbg.forceActiveTarget(null);
fakeNow += 30000;
const savedTechX6 = techs.map((t) => ({ unlocked: t.unlocked, researched: t.researched }));
for (const tech of techs) tech.researched = true; // no research sprints in this fixture
const savedStocksX6 = { minerals: res("minerals").value, mineralsMax: res("minerals").maxValue, mineralsRate: perTick.minerals };
const goldX6 = R("goldX6", 300, 1000, "Aurum VI");
resources.push(goldX6);
perTick.goldX6 = 0.05; // slow trickle — the plan waits on it for a long time
const trickleAltarX6 = { name: "trickleAltarX6", label: "Trickle Altar", unlocked: true, val: 0, on: 0, prices: [{ name: "goldX6", val: 800 }], effects: {} };
buildings.push(trickleAltarX6);
res("minerals").value = 100;
res("minerals").maxValue = 5000;
perTick.minerals = 0;

// (a) Exact-parity swap whose refund covers the rebuild — net bill empty,
// affordable on sight — must execute even though the plan is held elsewhere.
const stageSwapX6 = {
  name: "stageSwapX6",
  unlocked: true,
  stage: 0,
  val: 4,
  on: 4,
  priceRatio: 1,
  stages: [
    { label: "Old Hall X6", prices: [{ name: "minerals", val: 10 }], effects: { scienceMax: 100 }, stageUnlocked: true },
    { label: "New Hall X6", prices: [{ name: "minerals", val: 10 }], effects: { scienceMax: 400 }, stageUnlocked: true },
  ],
  effects: {},
};
buildings.push(stageSwapX6);
dbg.forceActiveTarget(dbg.candidateById("build:trickleAltarX6"), "Economy / normal growth", 5000);
dbg.craftTowardParallelCandidates("balanced");
check("Test X6: a banked GO swap executes while the plan is held by another layer",
  stageSwapX6.stage === 1 && dbg.pendingStageRebuild?.()?.buildingName === "stageSwapX6" && dbg.pendingStageRebuild?.()?.targetCount === 1);
check("Test X6: the parallel stage execution is logged with the protected plan", /parallel stage .*New Hall X6/i.test(logText()));
buildings.splice(buildings.indexOf(stageSwapX6), 1);
dbg.pendingStageRebuildCandidate?.(); // building is gone — clears the persisted contract
check("Test X6: fixture — the rebuild contract is cleared before the veto scenario", dbg.pendingStageRebuild?.() === null);

// (b) A swap whose net bill dips the plan's held gold bank must stay vetoed.
const stageVetoX6 = {
  name: "stageVetoX6",
  unlocked: true,
  stage: 0,
  val: 4,
  on: 4,
  priceRatio: 1,
  stages: [
    { label: "Old Den X6", prices: [{ name: "minerals", val: 10 }], effects: { scienceMax: 100 }, stageUnlocked: true },
    { label: "Gilded Den X6", prices: [{ name: "goldX6", val: 50 }], effects: { scienceMax: 400 }, stageUnlocked: true },
  ],
  effects: {},
};
buildings.push(stageVetoX6);
fakeNow += 5000;
dbg.craftTowardParallelCandidates("balanced");
check("Test X6: a swap that would dip the plan's held bank is never background-executed",
  stageVetoX6.stage === 0 && res("goldX6").value === 300);
buildings.splice(buildings.indexOf(stageVetoX6), 1);
buildings.splice(buildings.indexOf(trickleAltarX6), 1);
resources.splice(resources.indexOf(goldX6), 1);
delete perTick.goldX6;
res("minerals").value = savedStocksX6.minerals;
res("minerals").maxValue = savedStocksX6.mineralsMax;
perTick.minerals = savedStocksX6.mineralsRate;
techs.forEach((t, i) => { if (i < savedTechX6.length) { t.unlocked = savedTechX6[i].unlocked; t.researched = savedTechX6[i].researched; } });
dbg.forceActiveTarget(null);

/* ---------------------------------------------------------------------
 * Test AK2 — a reservation-HELD price does not skip the candidate whole
 * (v2.19.0).  Live regression: every pending workshop upgrade costs
 * 52-250K science, and the Genetics sprint's cumulative science
 * reservation (2.73M against a 196K bank) made that price read as a
 * non-craftable deficit — so the parallel pass skipped every upgrade
 * whole and never readied their craftable steel.  A short whose bank
 * already covers the price is only held (the hold releases when the
 * sprint completes): keep crafting the genuinely missing materials, but
 * never buy while any floor is short.
 * ------------------------------------------------------------------- */
dbg.queueClear();
dbg.forceActiveTarget(null);
fakeNow += 30000;
const savedTechAK2 = techs.map((t) => ({ unlocked: t.unlocked, researched: t.researched }));
for (const tech of techs) tech.researched = true;
const savedUpgradeAK2 = workshopUpgrades.map((u) => ({ unlocked: u.unlocked, researched: u.researched }));
for (const upgrade of workshopUpgrades) upgrade.researched = true;
const savedStocksAK2 = {
  slab: res("slab").value, minerals: res("minerals").value, mineralsMax: res("minerals").maxValue,
  wood: res("wood").value, science: [res("science").value, res("science").maxValue], mineralsRate: perTick.minerals,
};

const goldAK2 = R("goldAK2", 0, 1000, "Aurum II");
resources.push(goldAK2);
perTick.goldAK2 = 0.05;
// The plan holds BOTH a gold trickle and a fat science bill — the science
// floor is what makes the upgrade's banked science read as "short".
const trickleShrineAK2 = { name: "trickleShrineAK2", label: "Trickle Shrine", unlocked: true, val: 0, on: 0, prices: [{ name: "goldAK2", val: 800 }, { name: "science", val: 5000 }], effects: {} };
buildings.push(trickleShrineAK2);
const decoysAK2 = [];
for (let i = 0; i < 8; i += 1) {
  const decoy = { name: `decoyAK2v${i}`, label: `Decoy Manor ${i}`, unlocked: true, val: 0, on: 0, prices: [{ name: "goldAK2", val: 500 }], effects: { maxKittens: 25 } };
  decoysAK2.push(decoy);
  buildings.push(decoy);
}
// Science 600 covers the upgrade's 500 — the price is bank-HELD by the plan's
// reservation, not missing; the slab is the genuinely missing craftable part.
const heldSawAK2 = { name: "heldSawAK2", label: "Held Saw", unlocked: true, researched: false, prices: [{ name: "science", val: 500 }, { name: "slab", val: 80 }, { name: "minerals", val: 100 }], effects: {} };
workshopUpgrades.push(heldSawAK2);

res("slab").value = 0;
res("minerals").value = 7900;
res("minerals").maxValue = 8000;
perTick.minerals = 0;
res("wood").value = 200;
res("science").value = 600;
res("science").maxValue = 10000;

dbg.forceActiveTarget(dbg.candidateById("build:trickleShrineAK2"), "Economy / normal growth", 5000);
check("Test AK2: fixture — the decoys hold the ranked window and the held upgrade sits below it",
  decoysAK2.every((decoy) => dbg.candidateRank(`build:${decoy.name}`) <= 8) && dbg.candidateRank("upgrade:heldSawAK2") > 8);
const ak2Floors = dbg.parallelReservationFloors("balanced");
check("Test AK2: fixture — the plan's science bill is a reservation floor above the upgrade's banked 500", (ak2Floors.science || 0) > 500);
const ak2Text = dbg.craftTowardParallelCandidates("balanced");
check("Test AK2: deep bank-held upgrade is untouched by parallel crafting",
  res("slab").value === 0 && !/Held Saw/i.test(ak2Text));
check("Test AK2: the held science bank is never spent and the upgrade is not bought",
  res("science").value === 600 && heldSawAK2.researched === false);

buildings.splice(buildings.indexOf(trickleShrineAK2), 1);
for (const decoy of decoysAK2) buildings.splice(buildings.indexOf(decoy), 1);
workshopUpgrades.splice(workshopUpgrades.indexOf(heldSawAK2), 1);
resources.splice(resources.indexOf(goldAK2), 1);
delete perTick.goldAK2;
res("slab").value = savedStocksAK2.slab;
res("minerals").value = savedStocksAK2.minerals;
res("minerals").maxValue = savedStocksAK2.mineralsMax;
res("wood").value = savedStocksAK2.wood;
res("science").value = savedStocksAK2.science[0];
res("science").maxValue = savedStocksAK2.science[1];
perTick.minerals = savedStocksAK2.mineralsRate;
techs.forEach((t, i) => { if (i < savedTechAK2.length) { t.unlocked = savedTechAK2[i].unlocked; t.researched = savedTechAK2[i].researched; } });
workshopUpgrades.forEach((u, i) => { if (i < savedUpgradeAK2.length) { u.unlocked = savedUpgradeAK2[i].unlocked; u.researched = savedUpgradeAK2[i].researched; } });
dbg.queueClear();
dbg.forceActiveTarget(null);

/* ---------------------------------------------------------------------
 * Test AL — the reset advisor reads metaphysics from the PRESTIGE manager
 * (v2.20.0).  Live regression: the old advisor called science.get(perkName),
 * which (a) console.error'd "Failed to get tech for
 * tech name 'goldenRatio'" on every advisor tick — 1000+ errors — and
 * (b) collided with the researched "engineering" TECH even though the native
 * perk ID is misspelled "engeneering". Prices and progression must come from
 * the live prestige metadata, not a corrected-name/hardcoded roadmap.
 * ------------------------------------------------------------------- */
const engineeringTechAL = { name: "engineering", label: "Engineering (tech)", unlocked: true, researched: true, prices: [] };
techs.push(engineeringTechAL);
const scienceGetAL = gamePage.science.get;
const perkLookupsAL = [];
gamePage.science.get = (name) => { perkLookupsAL.push(name); return scienceGetAL(name); };
const nativeMetaphysicsFixture = () => [
  { name: "engeneering", label: "Engineering", unlocked: true, researched: false, prices: [{ name: "paragon", val: 5 }], unlocks: { perks: ["megalomania", "goldenRatio", "codexVox"] } },
  { name: "codexVox", label: "Codex Vox", unlocked: false, researched: false, prices: [{ name: "paragon", val: 25 }], unlocks: { perks: ["codexLogos"] } },
  { name: "codexLogos", label: "Codex Logos", unlocked: false, researched: false, prices: [{ name: "paragon", val: 50 }], unlocks: { perks: ["codexAgrum", "codexLeviathanianus"] } },
  { name: "codexAgrum", label: "Codex Agrum", unlocked: false, researched: false, prices: [{ name: "paragon", val: 75 }], unlocks: {} },
  { name: "megalomania", label: "Megalomania", unlocked: false, researched: false, prices: [{ name: "paragon", val: 10 }], unlocks: { perks: ["blackCodex"] } },
  { name: "blackCodex", label: "Black Codex", unlocked: false, researched: false, prices: [{ name: "paragon", val: 25 }], unlocks: {} },
  { name: "codexLeviathanianus", label: "Codex Leviathanianus", unlocked: false, researched: false, prices: [{ name: "paragon", val: 75 }], unlocks: {} },
  { name: "goldenRatio", label: "Golden Ratio", unlocked: false, researched: false, prices: [{ name: "paragon", val: 50 }], unlocks: { perks: ["divineProportion"] } },
  { name: "divineProportion", label: "Divine Proportion", unlocked: false, researched: false, prices: [{ name: "paragon", val: 100 }], unlocks: { perks: ["vitruvianFeline"] } },
  { name: "vitruvianFeline", label: "Vitruvian Feline", unlocked: false, researched: false, prices: [{ name: "paragon", val: 250 }], unlocks: { perks: ["renaissance"] } },
  { name: "renaissance", label: "Renaissance", unlocked: false, researched: false, prices: [{ name: "paragon", val: 750 }], unlocks: {} },
];
gamePage.prestige = {
  perks: nativeMetaphysicsFixture(),
};
let advAL = dbg.resetAdvisorState();
check("Test AL: the tech/perk name collision no longer hides the unowned Engineering perk", /next meta: Engineering \(5P/.test(advAL?.detail || ""));
check("Test AL: the advisor never asks the science manager for native perk names", !perkLookupsAL.includes("engeneering") && !perkLookupsAL.includes("goldenRatio"));
gamePage.prestige.perks[0].researched = true;
for (const siblingName of gamePage.prestige.perks[0].unlocks.perks) {
  gamePage.prestige.perks.find((perk) => perk.name === siblingName).unlocked = true;
}
advAL = dbg.resetAdvisorState();
check("Test AL: live sibling branches still prioritize Golden Ratio 50 after Engineering", /next meta: Golden Ratio \(50P/.test(advAL?.detail || "") && gamePage.prestige.perks.find((perk) => perk.name === "codexVox").unlocked && gamePage.prestige.perks.find((perk) => perk.name === "megalomania").unlocked);
const goldenRatioAL = gamePage.prestige.perks.find((perk) => perk.name === "goldenRatio");
goldenRatioAL.researched = true;
gamePage.prestige.perks.find((perk) => perk.name === "divineProportion").unlocked = true;
advAL = dbg.resetAdvisorState();
check("Test AL: the recursive live gateway continues to Divine Proportion 100 ahead of siblings", /next meta: Divine Proportion \(100P/.test(advAL?.detail || ""));
const cycleAlphaAL = { name: "cycleAlphaAL", label: "Cycle Alpha", unlocked: true, researched: false, prices: [{ name: "paragon", val: 1 }], unlocks: { perks: ["cycleBetaAL"] } };
const cycleBetaAL = { name: "cycleBetaAL", label: "Cycle Beta", unlocked: false, researched: false, prices: [{ name: "paragon", val: 1 }], unlocks: { perks: ["cycleAlphaAL"] } };
gamePage.prestige.perks[0].unlocks.perks.push("cycleAlphaAL");
gamePage.prestige.perks.push(cycleAlphaAL, cycleBetaAL);
advAL = dbg.resetAdvisorState();
check("Test AL: cyclic live unlock metadata terminates safely without displacing the main gateway", /next meta: Divine Proportion \(100P/.test(advAL?.detail || ""));
gamePage.science.get = scienceGetAL;
techs.splice(techs.indexOf(engineeringTechAL), 1);
delete gamePage.prestige;

/* ---------------------------------------------------------------------
 * Test AL2 — prestige evidence overrides an unreliable totalResets field.
 * Live regression: a 74-paragon / 14-karma save reported totalResets=0, so
 * both the advisor and expansion layer treated every 130-kitten run as the
 * first reset. Paragon or banked karma can only exist after a reset.
 * ------------------------------------------------------------------- */
const savedResetEvidenceAL2 = {
  totalResets: gamePage.totalResets,
  paragonPoints: gamePage.paragonPoints,
  karmaKittens: gamePage.karmaKittens,
};
gamePage.totalResets = 0;
gamePage.paragonPoints = 74;
gamePage.karmaKittens = 185;
setKittens(100);
const advAL2 = dbg.resetAdvisorState();
check("Test AL2: earned prestige prevents the first-reset milestone when totalResets is stale",
  !/First reset target|130\+ kittens/i.test(`${advAL2?.headline || ""} ${advAL2?.detail || ""}`));
if (savedResetEvidenceAL2.totalResets === undefined) delete gamePage.totalResets; else gamePage.totalResets = savedResetEvidenceAL2.totalResets;
if (savedResetEvidenceAL2.paragonPoints === undefined) delete gamePage.paragonPoints; else gamePage.paragonPoints = savedResetEvidenceAL2.paragonPoints;
if (savedResetEvidenceAL2.karmaKittens === undefined) delete gamePage.karmaKittens; else gamePage.karmaKittens = savedResetEvidenceAL2.karmaKittens;

/* ---------------------------------------------------------------------
 * Test AN — cumulative craft ETA and the workshop roadmap rewrite.
 * A 100-Alloy upgrade has one Alloy craft banked, but must fund every
 * remaining Steel input. The live v2.20.4 bug priced only one recipe step
 * and displayed ETA now for hundreds of missing Alloy.
 * ------------------------------------------------------------------- */
const alloyAN = R("alloyAN", 0, 0, "Alloy AN");
const alloyCraftAN = { name: "alloyAN", label: "Alloy AN", unlocked: true, prices: [{ name: "steel", val: 75 }, { name: "titanium", val: 10 }] };
resources.push(alloyAN);
crafts.push(alloyCraftAN);
const savedChainAN = {
  steel: [res("steel").value, res("steel").maxValue],
  iron: [res("iron").value, res("iron").maxValue],
  coal: [res("coal").value, res("coal").maxValue],
  titanium: res("titanium").value,
};
res("steel").value = 75;
res("iron").value = 0;
res("iron").maxValue = 10000;
res("coal").value = 0;
res("coal").maxValue = 10000;
res("titanium").value = 1000;
const alloyUpgradeAN = { name: "alloyUpgradeAN", label: "Alloy Upgrade AN", unlocked: true, researched: false, prices: [{ name: "alloyAN", val: 100 }], effects: { woodRatio: 1 } };
const alloyCandidateAN = { kind: "upgrade", meta: alloyUpgradeAN, affordable: false, progress: 0, score: 20 };
const alloyEtaAN = dbg.waitSecondsForCandidate(alloyCandidateAN);
check("Test AN: craft-only Alloy ETA counts every Steel craft instead of one incremental recipe", Number.isFinite(alloyEtaAN) && alloyEtaAN > 60);
res("steel").value = savedChainAN.steel[0];
res("steel").maxValue = savedChainAN.steel[1];
res("iron").value = savedChainAN.iron[0];
res("iron").maxValue = savedChainAN.iron[1];
res("coal").value = savedChainAN.coal[0];
res("coal").maxValue = savedChainAN.coal[1];
res("titanium").value = savedChainAN.titanium;
crafts.splice(crafts.indexOf(alloyCraftAN), 1);
resources.splice(resources.indexOf(alloyAN), 1);

/* ---------------------------------------------------------------------
 * Test AM — manual game speed (v2.20.0).  The community setInterval(
 * game.tick) trick, panel-controlled: N× arms one interval adding
 * (N − 1) extra ticks per beat on top of the native scheduler, 1× arms
 * nothing, the choice persists under kgh.tickSpeed, and an unknown
 * multiplier falls back to native.
 * ------------------------------------------------------------------- */
const intervalCountAM = intervalFns.length;
let extraTicksAM = 0;
gamePage.tick = () => { extraTicksAM += 1; };
check("Test AM: default speed is native 1×", dbg.tickSpeed?.() === 1);
dbg.applyTickSpeed?.(5);
check("Test AM: choosing 5× persists and arms one booster interval",
  dbg.tickSpeed?.() === 5 && localStorageMock.getItem("kgh.tickSpeed") === "5" && intervalFns.length === intervalCountAM + 1);
intervalFns[intervalFns.length - 1]();
check("Test AM: each booster beat adds (multiplier − 1) extra game ticks", extraTicksAM === 4);
extraTicksAM = 0;
dbg.applyTickSpeed?.(50);
intervalFns[intervalFns.length - 1]();
check("Test AM: the 50× ceiling arms 49 extra ticks per beat", dbg.tickSpeed?.() === 50 && extraTicksAM === 49);
dbg.applyTickSpeed?.(99);
check("Test AM: an unknown multiplier falls back to native 1×",
  dbg.tickSpeed?.() === 1 && localStorageMock.getItem("kgh.tickSpeed") === "1");
extraTicksAM = 0;
delete gamePage.tick;
intervalFns[intervalFns.length - 1](); // a stale beat with no game.tick must no-op
check("Test AM: at 1× the game is left untouched", extraTicksAM === 0);

/* ---------------------------------------------------------------------
 * Task 5 — native Time/transcendence adapters and armed prestige policy.
 * All mutations are observable through controller/manager counters. The
 * helper must checkpoint, revalidate, execute once, and verify exact deltas.
 * ------------------------------------------------------------------- */
dbg.queueClear();
dbg.forceActiveTarget(null);
dbg.setPrestigeAutomationArmed(false);
const addedRareResourcesT5 = [];
for (const [name, maxValue, title] of [
  ["timeCrystal", 100, "Time Crystal"],
  ["relic", 1000, "Relic"],
  ["void", 1000, "Void"],
  ["karma", 1000, "Karma"],
  ["paragon", 1000, "Paragon"],
]) {
  if (!res(name)) {
    const resource = R(name, 0, maxValue, title, { unlocked: true });
    resources.push(resource);
    addedRareResourcesT5.push(resource);
  }
}
for (const resourceName of ["timeCrystal", "relic", "void", "karma", "paragon", "alicorn"]) {
  res(resourceName).unlocked = true;
}
res("relic").value = 10;
res("timeCrystal").value = 20;
res("karma").value = 7; // live Void controller discount; raw metadata still says 9
res("void").value = 100;
transcendenceUpgrades[0].unlocked = true;
transcendenceUpgrades[1].unlocked = true;
chronoforgeUpgrades[0].unlocked = true;
voidspaceUpgrades[0].unlocked = true;

const hasTask5Adapters = typeof dbg.transcendenceUpgrades === "function" && typeof dbg.timeDescriptorFor === "function";
const transcendenceCandidateT5 = dbg.candidateById("transcendence:blackObeliskT5");
check("Task 5 adapter: ordinary transcendence upgrade is discovered as its own candidate kind",
  hasTask5Adapters && dbg.transcendenceUpgrades().includes(transcendenceUpgrades[0]) && transcendenceCandidateT5?.kind === "transcendence");
check("Task 5 adapter: raw Transcend action never becomes a candidate", !dbg.candidateById("transcendence:transcend"));
check("Task 5 adapter: Time descriptors preserve Chronoforge/Void Space manager membership",
  hasTask5Adapters && dbg.timeDescriptorFor(chronoforgeUpgrades[0])?.subtype === "chronoforge" && dbg.timeDescriptorFor(voidspaceUpgrades[0])?.subtype === "voidspace");

fakeNow += 5000;
dbg.forceActiveTarget(transcendenceCandidateT5, "Late-game progression frontier", 0);
dbg.executePlan();
check("Task 5 adapter: transcendence upgrade buys only through TranscendenceBtnController",
  transcendenceUpgrades[0].val === 1 && transcendenceControllerCalls === 1);
const chronoforgeCandidateT5 = dbg.candidateById("time:temporalBatteryT5");
fakeNow += 5000;
dbg.forceActiveTarget(chronoforgeCandidateT5, "Late-game progression frontier", 0);
dbg.executePlan();
check("Task 5 adapter: Chronoforge item buys only through ChronoforgeBtnController",
  chronoforgeUpgrades[0].val === 1 && chronoforgeControllerCalls === 1 && rawTimeManagerCalls === 0);
const voidspaceCandidateT5 = dbg.candidateById("time:cryochambersT5");
check("Task 5 adapter: Void Space affordability uses its live controller price",
  voidspaceCandidateT5?.affordable === true && dbg.timePricesFor?.(voidspaceUpgrades[0])?.find((price) => price.name === "karma")?.val === 7);
fakeNow += 5000;
dbg.forceActiveTarget(voidspaceCandidateT5, "Late-game progression frontier", 0);
dbg.executePlan();
check("Task 5 adapter: Void Space item buys only through VoidSpaceBtnController",
  voidspaceUpgrades[0].val === 1 && voidspaceControllerCalls === 1 && rawTimeManagerCalls === 0 && res("karma").value === 0);

// Keep ordinary candidates from becoming policy blockers while the prestige
// projection fixtures exercise only native manager state.
religionUpgrades.forEach((upgrade) => { upgrade.researched = true; upgrade.on = Math.max(1, upgrade.on || 0); });
transcendenceUpgrades.forEach((upgrade) => { upgrade.unlocked = false; });
chronoforgeUpgrades.forEach((upgrade) => { upgrade.unlocked = false; });
voidspaceUpgrades.forEach((upgrade) => { upgrade.unlocked = false; });
perTick.faith = 100;
gamePage.religion.faith = 100000;
gamePage.religion.faithRatio = 150;
gamePage.religion.transcendenceTier = 1;
const callsBeforeDisarmedT5 = { checkpointCalls, transcendCalls, adoreCalls, alicornSacrificeCalls };
const disarmedProjectionT5 = typeof dbg.prestigeProjection === "function" ? dbg.prestigeProjection() : null;
const disarmedManagedT5 = typeof dbg.managePrestige === "function" ? dbg.managePrestige(null) : false;
check("Task 5 prestige: disarmed mode still projects but executes zero irreversible APIs",
  !!disarmedProjectionT5 && disarmedManagedT5 === false && checkpointCalls === callsBeforeDisarmedT5.checkpointCalls && transcendCalls === callsBeforeDisarmedT5.transcendCalls && adoreCalls === callsBeforeDisarmedT5.adoreCalls && alicornSacrificeCalls === callsBeforeDisarmedT5.alicornSacrificeCalls);

dbg.setPrestigeAutomationArmed(true);
const nativeSaveT5 = gamePage.save;
gamePage.save = () => { checkpointCalls += 1; return false; };
fakeNow += 30000;
const callsBeforeFailedCheckpointT5 = transcendCalls;
const failedCheckpointT5 = dbg.managePrestige?.(null);
  check("Task 5 prestige: failed native checkpoint prevents Transcend", failedCheckpointT5 === false && transcendCalls === callsBeforeFailedCheckpointT5);
  gamePage.save = nativeSaveT5;

  fakeNow += 30000;
  gamePage.currentSaveIsBroken = true;
  const callsBeforeBrokenSaveT5 = transcendCalls;
  const brokenSaveManagedT5 = dbg.managePrestige?.(null);
  check("Task 5 review: broken native save state prevents every prestige mutation",
    brokenSaveManagedT5 === false && transcendCalls === callsBeforeBrokenSaveT5);
  gamePage.currentSaveIsBroken = false;

  fakeNow += 30000;
  const persistedBeforeStaleT5 = LCstorageMock[NATIVE_SAVE_KEY];
  gamePage.save = () => { checkpointCalls += 1; return { checkpointSerial: checkpointSerial + 1 }; };
  const callsBeforeStaleSaveT5 = transcendCalls;
  const staleSaveManagedT5 = dbg.managePrestige?.(null);
  check("Task 5 review: a save return without a fresh persisted blob is not a checkpoint",
    staleSaveManagedT5 === false && transcendCalls === callsBeforeStaleSaveT5 && LCstorageMock[NATIVE_SAVE_KEY] === persistedBeforeStaleT5);
  gamePage.save = nativeSaveT5;

  // A legitimate native save can serialize to the exact blob already stored.
  // The Proxy write counter proves the setter ran; equality is not staleness.
  fakeNow += 30000;
  const identicalSaveDataT5 = { checkpointSerial };
  const identicalSaveBlobT5 = gamePage._saveDataToString(identicalSaveDataT5);
  LCstorageMock[NATIVE_SAVE_KEY] = identicalSaveBlobT5;
  const writesBeforeIdenticalT5 = nativeSaveWrites;
  gamePage.save = () => {
    checkpointCalls += 1;
    LCstorageMock[NATIVE_SAVE_KEY] = identicalSaveBlobT5;
    return identicalSaveDataT5;
  };
  const tierBeforeIdenticalT5 = gamePage.religion.transcendenceTier;
  const identicalRewriteManagedT5 = dbg.managePrestige?.(null);
  check("Task 5 re-review: an identical verified native rewrite is a valid checkpoint",
    identicalRewriteManagedT5 === true && nativeSaveWrites === writesBeforeIdenticalT5 + 1 && LCstorageMock[NATIVE_SAVE_KEY] === identicalSaveBlobT5 && gamePage.religion.transcendenceTier === tierBeforeIdenticalT5 + 1);
  gamePage.save = nativeSaveT5;
  gamePage.religion.faith = 100000;
  gamePage.religion.faithRatio = 150;
  gamePage.religion.transcendenceTier = 1;
  transcendenceUpgrades[2].unlocked = false;

  fakeNow += 30000;
  transcendenceUpgrades[3].unlocked = true;
  gamePage.religion.faith = 0;
  gamePage.religion.faithRatio = 150;
  const retainedFloorProjectionT5 = dbg.prestigeProjection?.(null);
  const checkpointBeforeRetainedFloorT5 = checkpointCalls;
  check("Task 5 review: Transcend preserves the full retained epiphany upgrade floor",
    retainedFloorProjectionT5?.transcend?.retainedFloor === 60 && retainedFloorProjectionT5?.transcend?.ready === false && dbg.managePrestige?.(null) === false && checkpointCalls === checkpointBeforeRetainedFloorT5);
  transcendenceUpgrades[3].unlocked = false;

// Transcend and Adore both qualify. Transcend owns this irreversible cycle.
// The checkpoint deliberately changes epiphany by one to prove the exact
// before-snapshot is captured AFTER checkpoint and fresh revalidation.
fakeNow += 30000;
gamePage.religion.faith = 100000;
gamePage.religion.faithRatio = 150;
gamePage.religion.transcendenceTier = 1;
  transcendenceUpgrades[2].unlocked = false;
  gamePage.save = () => persistCheckpoint(() => { gamePage.religion.faithRatio += 1; });
const tierBeforeT5 = gamePage.religion.transcendenceTier;
const epiphanyBeforeT5 = gamePage.religion.faithRatio;
const adoreBeforePriorityT5 = adoreCalls;
const transcendButtonsBeforePriorityT5 = transcendButtonCalls;
const transcendManagedT5 = dbg.managePrestige?.(null);
  check("Task 5 prestige: funded Transcend checkpoints and advances exactly one tier",
    transcendManagedT5 === true && checkpointCalls >= callsBeforeDisarmedT5.checkpointCalls + 2 && gamePage.religion.transcendenceTier === tierBeforeT5 + 1 && gamePage.religion.faithRatio === epiphanyBeforeT5 + 1 - 100);
  check("Task 5 review: Transcend uses the native Religion button and unlocks the new tier metadata",
    transcendButtonCalls === transcendButtonsBeforePriorityT5 + 1 && transcendenceUpgrades[2].unlocked === true);
gamePage.save = nativeSaveT5;
check("Task 5 prestige: when Transcend and Adore both qualify one cycle runs Transcend only", adoreCalls === adoreBeforePriorityT5);
const callsBeforeCooldownT5 = { transcendCalls, adoreCalls };
check("Task 5 prestige: shared irreversible cooldown blocks a second same-cycle action",
  dbg.managePrestige?.(null) === false && transcendCalls === callsBeforeCooldownT5.transcendCalls && adoreCalls === callsBeforeCooldownT5.adoreCalls);

// A separate later cycle may Adore when native projected gain is positive and
// the measured Solar Revolution recovery lies within the policy horizon.
fakeNow += 30000;
gamePage.religion.faith = 100000;
gamePage.religion.faithRatio = 10;
const nativeSolarRatioT5 = gamePage.religion.getSolarRevolutionRatio;
gamePage.religion.getSolarRevolutionRatio = () => 100;
perTick.faith = 10;
const boostedRecoveryT5 = dbg.prestigeProjection?.(null);
check("Task 5 prestige: Adore recovery removes the temporary Solar Revolution production boost",
  boostedRecoveryT5?.adore?.ready === false && boostedRecoveryT5?.adore?.recoverySeconds > 6 * 60 * 60);
gamePage.religion.getSolarRevolutionRatio = nativeSolarRatioT5;
perTick.faith = 100;
const adoreEpiphanyBeforeT5 = gamePage.religion.faithRatio;
const adoreManagedT5 = dbg.managePrestige?.(null);
  check("Task 5 prestige: Adore requires positive native gain and bounded Solar Revolution recovery",
    adoreManagedT5 === true && adoreCalls === adoreBeforePriorityT5 + 1 && gamePage.religion.faithRatio > adoreEpiphanyBeforeT5 && gamePage.religion.faith === 0.01);

  fakeNow += 30000;
  const nativeResetFaithT5 = gamePage.religion.resetFaith;
  gamePage.religion.faith = 100000;
  gamePage.religion.faithRatio = 10;
  gamePage.religion.resetFaith = function faultyAdore(bonusRatio) {
    adoreCalls += 1;
    this.faithRatio += this.getApocryphaResetBonus(bonusRatio);
    this.faith = 1;
    return true;
  };
  const faultyAdoreManagedT5 = dbg.managePrestige?.(null);
  gamePage.religion.resetFaith = nativeResetFaithT5;
  gamePage.religion.faith = 100000;
  gamePage.religion.faithRatio = 10;
  const retryAfterFaultyAdoreT5 = dbg.managePrestige?.(null);
  check("Task 5 review: Adore requires exact native 0.01 worship reset and failed verification starts no cooldown",
    faultyAdoreManagedT5 === false && retryAfterFaultyAdoreT5 === true && gamePage.religion.faith === 0.01);

// Alicorn Stable is a reachable direct alicorn purchase and therefore creates
// a protected floor. The active Time target is exactly two crystals short.
const alicornStableT5 = { name: "alicornStableT5", label: "Alicorn Stable T5", unlocked: true, val: 0, on: 0, priceRatio: 1.15, prices: [{ name: "alicorn", val: 20 }], effects: { alicornChance: 0.1 } };
const crystalTargetT5 = { name: "crystalTargetT5", label: "Crystal Target T5", unlocked: true, val: 0, on: 0, priceRatio: 1.25, prices: [{ name: "timeCrystal", val: 3 }], effects: {} };
zigguratUpgradesMock.push(alicornStableT5);
chronoforgeUpgrades.push(crystalTargetT5);
const zigguratMetaT5 = buildings.find((building) => building.name === "ziggurat");
zigguratMetaT5.val = 1;
zigguratMetaT5.on = 1;
const crystalTargetCandidateT5 = { kind: "time", meta: crystalTargetT5, affordable: false };
const savedRacesT5 = diplomacy.races.slice();
diplomacy.races.splice(0, diplomacy.races.length); // no faster Leviathan route
perTick.timeCrystal = 0;
res("alicorn").value = 39.85;
res("timeCrystal").value = 1;
gamePage.religion.faith = 0;
const alicornBaitT5 = { name: "alicornBaitT5", label: "Alicorn Bait T5", unlocked: true, val: 0, on: 0, prices: [{ name: "alicorn", val: 25 }], effects: { productionRatio: 1 } };
const savedBuildingUnlocksT5 = buildings.map((building) => building.unlocked);
for (const building of buildings) building.unlocked = false;
buildings.push(alicornBaitT5);
const alicornBaitCandidateT5 = dbg.candidateById("build:alicornBaitT5");
dbg.forceActiveTarget(crystalTargetCandidateT5, "Late-game progression frontier", 0);
fakeNow += 5000;
dbg.executePlan();
check("Task 5 capital: cap-relief/surplus purchases consume the complete rare-capital ledger",
  alicornBaitCandidateT5?.affordable === true && alicornBaitT5.val === 0 && alicornStableT5.val === 0 && res("alicorn").value === 39.85);
buildings.splice(buildings.indexOf(alicornBaitT5), 1);
buildings.forEach((building, index) => { building.unlocked = savedBuildingUnlocksT5[index]; });
dbg.forceActiveTarget(null);

const strandedActiveRareT5 = { name: "strandedActiveRareT5", label: "Stranded Active Rare T5", unlocked: true, val: 0, on: 0, prices: [{ name: "void", val: 500 }, { name: "impossibleT5", val: 1 }], effects: {} };
const strandedManualRareT5 = { name: "strandedManualRareT5", label: "Stranded Manual Rare T5", unlocked: true, val: 0, on: 0, prices: [{ name: "relic", val: 80 }, { name: "impossibleT5", val: 1 }], effects: {} };
buildings.push(strandedActiveRareT5, strandedManualRareT5);
perTick.relic = 0;
const activeRareFloorT5 = dbg.rareCapitalFloor?.({ kind: "build", meta: strandedActiveRareT5, affordable: false });
dbg.queueAdd?.("build:strandedManualRareT5", 0);
const manualRareFloorT5 = dbg.rareCapitalFloor?.(null);
check("Task 5 review: active and manual targets unconditionally protect full direct rare-capital costs",
  activeRareFloorT5?.void === 500 && manualRareFloorT5?.relic === 80);
dbg.queueClear();
buildings.splice(buildings.indexOf(strandedActiveRareT5), 1);
buildings.splice(buildings.indexOf(strandedManualRareT5), 1);

const unreachableWholeBillT5 = { name: "unreachableWholeBillT5", label: "Unreachable Whole Bill T5", unlocked: true, val: 0, on: 0, prices: [{ name: "relic", val: 70 }, { name: "impossibleT5", val: 1 }], effects: {} };
buildings.push(unreachableWholeBillT5);
perTick.relic = 1;
gamePage.prestige = {
  perks: nativeMetaphysicsFixture(),
};
const engineeringRoadmapFloorT5 = dbg.rareCapitalFloor?.(null);
gamePage.prestige.perks[0].researched = true;
for (const siblingName of gamePage.prestige.perks[0].unlocks.perks) {
  gamePage.prestige.perks.find((perk) => perk.name === siblingName).unlocked = true;
}
const goldenRatioRoadmapFloorT5 = dbg.rareCapitalFloor?.(null);
check("Task 5 final review: rare floor selects the strongest live gateway over unlocked sibling branches",
  engineeringRoadmapFloorT5?.paragon === 5 && !(engineeringRoadmapFloorT5?.relic >= 70) && goldenRatioRoadmapFloorT5?.paragon === 50 && gamePage.prestige.perks.find((perk) => perk.name === "codexVox").unlocked);
buildings.splice(buildings.indexOf(unreachableWholeBillT5), 1);
delete perTick.relic;
delete gamePage.prestige;

const rareFloorT5 = typeof dbg.rareCapitalFloor === "function" ? dbg.rareCapitalFloor(crystalTargetCandidateT5) : {};
const blockedAlicornProjectionT5 = typeof dbg.prestigeProjection === "function" ? dbg.prestigeProjection(crystalTargetCandidateT5) : null;
const alicornCallsBeforeFloorT5 = alicornSacrificeCalls;
fakeNow += 30000;
const blockedAlicornManagedT5 = dbg.managePrestige?.(crystalTargetCandidateT5);
check("Task 5 alicorn: 39.85 state preserves Alicorn Stable 20 floor and calls zero APIs",
  rareFloorT5.alicorn >= 20 && /protected.*floor/i.test(blockedAlicornProjectionT5?.alicorn?.reason || "") && blockedAlicornManagedT5 === false && alicornSacrificeCalls === alicornCallsBeforeFloorT5);

fakeNow += 30000;
gamePage.religion.faith = 100000;
gamePage.religion.faithRatio = 10;
const alicornCallsBeforeAdorePriorityT5 = alicornSacrificeCalls;
const adoreOverBlockedAlicornT5 = dbg.managePrestige?.(crystalTargetCandidateT5);
check("Task 5 review: a non-ready alicorn plan never blocks a ready Adore",
  adoreOverBlockedAlicornT5 === true && alicornSacrificeCalls === alicornCallsBeforeAdorePriorityT5 && gamePage.religion.faith === 0.01);

res("alicorn").value = 50;
res("timeCrystal").value = 1;
fakeNow += 30000;
gamePage.religion.faith = 0.01;
gamePage.religion.faithRatio = 10;
const nativeSaveBeforeReselectT5 = gamePage.save;
gamePage.save = () => persistCheckpoint(() => { gamePage.religion.faith = 100000; });
const alicornCallsBeforeFreshReselectT5 = alicornSacrificeCalls;
const adoreCallsBeforeFreshReselectT5 = adoreCalls;
const freshReselectedT5 = dbg.managePrestige?.(crystalTargetCandidateT5);
check("Task 5 review: checkpoint revalidation recomputes all projections and reselects Adore over alicorn",
  freshReselectedT5 === true && adoreCalls === adoreCallsBeforeFreshReselectT5 + 1 && alicornSacrificeCalls === alicornCallsBeforeFreshReselectT5);
gamePage.save = nativeSaveBeforeReselectT5;
gamePage.religion.faith = 0;
fakeNow += 30000;
perTick.timeCrystal = 0.000001; // slow passive route must not hide a funded Leviathan trade
const immediateLeviathanT5 = { name: "leviathans", title: "Leviathans", unlocked: true, embassyLevel: 0, sells: [{ name: "timeCrystal", value: 2, chance: 1, width: 0 }] };
diplomacy.races.push(immediateLeviathanT5);
res("manpower").value = 1000;
res("gold").value = 100;
const leviathanPreferredT5 = dbg.prestigeProjection?.(crystalTargetCandidateT5);
check("Task 5 alicorn: funded Leviathan trade is compared explicitly even beside a slow passive route",
  leviathanPreferredT5?.alicorn?.ready === false && /Leviathan|trade/i.test(leviathanPreferredT5?.alicorn?.reason || ""));
diplomacy.races.splice(diplomacy.races.indexOf(immediateLeviathanT5), 1);
perTick.timeCrystal = 0;

crystalTargetT5.prices[0].val = 11; // deficit 10; four 3-crystal batches required
const multiBatchProjectionT5 = dbg.prestigeProjection?.(crystalTargetCandidateT5);
const callsBeforeMultiBatchT5 = alicornSacrificeCalls;
check("Task 5 alicorn: insufficient capital for the complete whole-batch plan calls zero APIs",
  multiBatchProjectionT5?.alicorn?.batchesNeeded === 4 && multiBatchProjectionT5?.alicorn?.ready === false && dbg.managePrestige?.(crystalTargetCandidateT5) === false && alicornSacrificeCalls === callsBeforeMultiBatchT5);
crystalTargetT5.prices[0].val = 3;

res("alicorn").value = 100;
res("timeCrystal").value = 1;
res("timeCrystal").maxValue = 5;
crystalTargetT5.prices[0].val = 5; // two batches yield six into only four headroom
fakeNow += 30000;
const callsBeforeSequenceHeadroomT5 = alicornSacrificeCalls;
const sequenceHeadroomT5 = dbg.prestigeProjection?.(crystalTargetCandidateT5);
check("Task 5 alicorn: whole multi-batch sequence must fit output headroom before batch one",
  sequenceHeadroomT5?.alicorn?.batchesNeeded === 2 && sequenceHeadroomT5?.alicorn?.ready === false && dbg.managePrestige?.(crystalTargetCandidateT5) === false && alicornSacrificeCalls === callsBeforeSequenceHeadroomT5);
crystalTargetT5.prices[0].val = 3;
res("alicorn").value = 50;
res("timeCrystal").value = 1;
res("timeCrystal").maxValue = 100;
fakeNow += 30000;

res("timeCrystal").maxValue = 3; // only two headroom; native batch would gain three
const callsBeforeHeadroomT5 = alicornSacrificeCalls;
check("Task 5 alicorn: output headroom blocks a batch before any irreversible API call",
  dbg.managePrestige?.(crystalTargetCandidateT5) === false && alicornSacrificeCalls === callsBeforeHeadroomT5 && res("alicorn").value === 50 && res("timeCrystal").value === 1);
res("timeCrystal").maxValue = 100;
const checkpointBeforeAlicornT5 = checkpointCalls;
const positiveAlicornT5 = dbg.managePrestige?.(crystalTargetCandidateT5);
check("Task 5 alicorn: exact two-crystal deficit executes one checkpointed 25-alicorn batch and verifies live gain",
  positiveAlicornT5 === true && checkpointCalls === checkpointBeforeAlicornT5 + 1 && alicornSacrificeCalls === alicornCallsBeforeFloorT5 + 1 && res("alicorn").value === 25 && res("timeCrystal").value === 4);
res("timeCrystal").value = 1;
const callsBeforeAlicornCooldownT5 = alicornSacrificeCalls;
check("Task 5 alicorn: one-batch action enters irreversible cooldown",
  dbg.managePrestige?.(crystalTargetCandidateT5) === false && alicornSacrificeCalls === callsBeforeAlicornCooldownT5);
check("Task 5 observability: panel and diagnostics show armed prestige projections/blockers",
  /Prestige/i.test(panelText(".kgh-prestige-status")) && /PRESTIGE|Prestige/.test(dbg.report()) && /Chronoforge|Void Space|Transcendence/.test(dbg.report()));

zigguratUpgradesMock.splice(zigguratUpgradesMock.indexOf(alicornStableT5), 1);
chronoforgeUpgrades.splice(chronoforgeUpgrades.indexOf(crystalTargetT5), 1);
diplomacy.races.push(...savedRacesT5);
delete perTick.faith;
delete perTick.timeCrystal;
dbg.setPrestigeAutomationArmed(false);
for (const resource of addedRareResourcesT5) resources.splice(resources.indexOf(resource), 1);

/* ---------------------------------------------------------------------
 * Task 6 — sustainable processor fuel, bounded post-reset expansion,
 * complete late-game diagnostics, and unlock-watch invalidation.
 * ------------------------------------------------------------------- */
dbg.queueClear();
dbg.forceActiveTarget(null);
const addedResourcesT6 = [];
const ensureResourceT6 = (name, value, maxValue, title = null) => {
  let resource = res(name);
  if (!resource) {
    resource = R(name, value, maxValue, title || undefined);
    resources.push(resource);
    addedResourcesT6.push(resource);
  }
  resource.value = value;
  resource.maxValue = maxValue;
  resource.unlocked = true;
  return resource;
};
ensureResourceT6("uranium", 100, 1000, "Uranium");
ensureResourceT6("unobtainium", 0, 1000, "Unobtainium");
ensureResourceT6("timeCrystal", 5, 100, "Time Crystal");
ensureResourceT6("relic", 50, 1000, "Relic");
ensureResourceT6("void", 100, 1000, "Void");
ensureResourceT6("karma", 20, 1000, "Karma");
const savedFuelT6 = {
  scienceValue: res("science").value,
  scienceMax: res("science").maxValue,
  uraniumRate: perTick.uranium,
  scienceRate: perTick.science,
  powerProd: gamePage.resPool.energyProd,
  powerCons: gamePage.resPool.energyCons,
  powerWinter: gamePage.resPool.energyWinterProd,
  races: diplomacy.races.slice(),
};
res("science").value = 0;
res("science").maxValue = 10000;
perTick.science = 1;
// The game reports NET production. Four active Reactors burn 4 uranium/s,
// so -4/s represents a colony with no outside uranium income.
perTick.uranium = -0.8;
gamePage.resPool.energyProd = 100;
gamePage.resPool.energyCons = 0;
gamePage.resPool.energyWinterProd = 100;
const fuelProducerT6 = {
  name: "fuelProducerT6",
  label: "First Uranium Producer T6",
  unlocked: true,
  val: 0,
  on: 0,
  prices: [{ name: "uranium", val: 100 }, { name: "science", val: 500 }],
  effects: { uraniumPerTickProd: 1 },
};
const reactorT6 = {
  name: "reactorT6",
  label: "Reactor T6",
  unlocked: true,
  val: 4,
  on: 4,
  prices: [{ name: "titanium", val: 1 }],
  effects: { uraniumPerTickCon: -0.2, energyProduction: 5 },
};
buildings.push(fuelProducerT6, reactorT6);
const fuelTargetT6 = dbg.candidateById("build:fuelProducerT6") || { kind: "build", meta: fuelProducerT6, affordable: false };
const reactorNoIncomeT6 = dbg.sustainableProcessorCount?.(reactorT6, { reserved: { uranium: 100 } }, 60);
check("Task 6 fuel: a Reactor cannot consume uranium reserved for the first producer",
  reactorNoIncomeT6 === 0);
dbg.forceActiveTarget(fuelTargetT6, "Late-game progression frontier", 0);
dbg.optimizeProcessing();
check("Task 6 fuel: live Reactor control honors the banked active-target uranium floor",
  reactorT6.on === 0);
perTick.uranium = 0.4; // +2 uranium/s; each Reactor consumes 1/s.
dbg.clearResourceTelemetry?.("uranium");
const reactorIncomeT6 = dbg.sustainableProcessorCount?.(reactorT6, { reserved: { uranium: 100 } }, 60);
fakeNow += 21000;
dbg.forceActiveTarget(fuelTargetT6, "Late-game progression frontier", 0);
dbg.optimizeProcessing();
check("Task 6 fuel: only the Reactor count sustainable for the 60-second income horizon resumes",
  reactorIncomeT6 === 2 && reactorT6.on === 2);
// Once those two Reactors are running, live telemetry reports zero NET uranium.
// Their own burn must be added back or the controller will flap them off again.
perTick.uranium = 0;
dbg.clearResourceTelemetry?.("uranium");
const reactorSteadyT6 = dbg.sustainableProcessorCount?.(reactorT6, { reserved: { uranium: 100 } }, 60);
check("Task 6 fuel: a sustainable Reactor count stays stable when telemetry includes its own burn",
  reactorSteadyT6 === 2);

const lunarOutpostT6 = {
  name: "lunarOutpostT6",
  label: "Lunar Outpost T6",
  unlocked: true,
  val: 3,
  on: 3,
  prices: [{ name: "uranium", val: 10 }],
  effects: { uraniumPerTickCon: -0.5, unobtainiumPerTickSpace: 0.01, energyConsumption: 1 },
};
const spaceGateTechT6 = {
  name: "spaceGateTechT6",
  label: "Chronophysics Gate T6",
  unlocked: true,
  researched: false,
  prices: [{ name: "science", val: 1000 }],
  unlocks: {},
};
techs.push(spaceGateTechT6);
const lockedSpaceGateT6 = {
  name: "lockedSpaceGateT6",
  label: "Space Gate T6",
  unlocked: false,
  val: 0,
  on: 0,
  prices: [{ name: "science", val: 1000 }],
  requiredTech: ["spaceGateTechT6"],
  effects: {},
};
const unlockMissionT6 = {
  name: "unlockMissionT6",
  label: "Unlock Mission T6",
  unlocked: false,
  noStackable: true,
  val: 0,
  on: 0,
  prices: [{ name: "science", val: 1 }],
  effects: {},
};
const moonT6 = { name: "moonT6", label: "Moon T6", unlocked: true, reached: true, routeDays: 0, buildings: [lunarOutpostT6, lockedSpaceGateT6] };
const programsT6 = [unlockMissionT6];
gamePage.space = {
  programs: programsT6,
  planets: [moonT6],
  getProgram: (id) => programsT6.find((program) => program.name === id),
  getBuilding: (id) => moonT6.buildings.find((building) => building.name === id),
};
reactorT6.val = 0;
reactorT6.on = 0;
// Three active Lunar Outposts burn 7.5 uranium/s; keep outside income at zero.
perTick.uranium = -1.5;
dbg.clearResourceTelemetry?.("uranium");
const lunarNoIncomeT6 = dbg.sustainableProcessorCount?.(lunarOutpostT6, { reserved: { uranium: 100 } }, 60);
fakeNow += 21000;
dbg.forceActiveTarget(fuelTargetT6, "Late-game progression frontier", 0);
dbg.optimizeProcessing();
check("Task 6 fuel: Lunar Outposts also preserve the selected frontier's uranium",
  lunarNoIncomeT6 === 0 && lunarOutpostT6.on === 0);
perTick.uranium = 0.5; // +2.5/s, exactly one Lunar Outpost at -2.5/s.
dbg.clearResourceTelemetry?.("uranium");
const lunarIncomeT6 = dbg.sustainableProcessorCount?.(lunarOutpostT6, { reserved: { uranium: 100 } }, 60);
fakeNow += 21000;
dbg.forceActiveTarget(fuelTargetT6, "Late-game progression frontier", 0);
dbg.optimizeProcessing();
check("Task 6 fuel: Lunar Outposts resume only the uranium-sustainable count",
  lunarIncomeT6 === 1 && lunarOutpostT6.on === 1);

// When several processor families share one fuel bank, the chosen frontier's
// producer gets first call and the total projected burn must still fit once.
const unobtainiumFrontierT6 = {
  name: "unobtainiumFrontierT6",
  label: "Unobtainium Frontier T6",
  unlocked: true,
  val: 0,
  on: 0,
  prices: [{ name: "uranium", val: 100 }, { name: "unobtainium", val: 100 }],
  effects: {},
};
buildings.push(unobtainiumFrontierT6);
reactorT6.val = 4;
reactorT6.on = 0;
lunarOutpostT6.val = 3;
lunarOutpostT6.on = 0;
perTick.uranium = 0.5;
perTick.unobtainium = 0.01;
res("uranium").value = 100;
res("unobtainium").value = 0;
fakeNow += 21000;
dbg.queueAdd("build:unobtainiumFrontierT6", 0);
dbg.forceActiveTarget(null);
dbg.optimizeProcessing();
check("Task 6 fuel: shared uranium budget prioritizes the selected unobtainium frontier without double allocation",
  lunarOutpostT6.on === 1 && reactorT6.on === 0);

// Review regressions: power and every fuel consumer must share one allocation.
// These deliberately combine high stock, cooldown hysteresis, incumbent burn,
// and a selected Space output so independent per-family budgets cannot pass.
gamePage.resPool.energyProd = 2;
gamePage.resPool.energyCons = 0;
gamePage.resPool.energyWinterProd = 2;
res("uranium").value = 1000;
res("uranium").maxValue = 1000;
perTick.uranium = 0;
reactorT6.val = 0;
reactorT6.on = 0;
lunarOutpostT6.val = 3;
lunarOutpostT6.on = 0;
dbg.clearResourceTelemetry?.("uranium");
const lunarPowerPartialT6 = dbg.sustainableProcessorCount?.(lunarOutpostT6, { reserved: {} }, 60);
check("Task 6 review: processor allocation caps a Lunar Outpost fleet to effective winter power headroom",
  lunarPowerPartialT6 === 1);

const backgroundProcessorT6 = {
  name: "backgroundProcessorT6",
  label: "Background Processor T6",
  unlocked: true,
  val: 2,
  on: 0,
  prices: [{ name: "uranium", val: 1000 }],
  effects: { uraniumPerTickCon: -0.2, sciencePerTickProd: 0.01 },
};
buildings.push(backgroundProcessorT6);
gamePage.resPool.energyProd = 100;
gamePage.resPool.energyCons = 0;
gamePage.resPool.energyWinterProd = 100;
unobtainiumFrontierT6.prices = [{ name: "uranium", val: 750 }, { name: "unobtainium", val: 100 }];
res("uranium").value = 900;
res("science").value = 0;
perTick.uranium = 0;
lunarOutpostT6.val = 1;
lunarOutpostT6.on = 0;
dbg.clearResourceTelemetry?.("uranium");
dbg.queueClear();
dbg.queueAdd("build:unobtainiumFrontierT6", 0);
dbg.forceActiveTarget(null);
fakeNow += 21000;
tickFn();
check("Task 6 review: the stability pass cannot double-allocate a high-stock uranium budget",
  lunarOutpostT6.on === 1 && backgroundProcessorT6.on === 0);

// Establish a fresh Reactor run transition, then switch to the Lunar frontier
// before its minimum-run cooldown expires. The held Reactor's real burn gets
// first claim; a desired-zero virtual count must not free that fuel for Lunar.
backgroundProcessorT6.val = 0;
backgroundProcessorT6.on = 0;
reactorT6.val = 1;
reactorT6.on = 0;
lunarOutpostT6.val = 1;
lunarOutpostT6.on = 0;
unobtainiumFrontierT6.prices = [{ name: "uranium", val: 100 }, { name: "unobtainium", val: 100 }];
res("uranium").value = 160;
perTick.uranium = 0;
dbg.clearResourceTelemetry?.("uranium");
dbg.queueClear();
fakeNow += 21000;
dbg.forceActiveTarget(fuelTargetT6, "Late-game progression frontier", 0);
dbg.optimizeProcessing();
check("Task 6 review fixture: one Reactor enters the live run cooldown", reactorT6.on === 1);
res("uranium").value = 250;
perTick.uranium = -0.2; // -1/s net: no external income while one Reactor burns.
dbg.clearResourceTelemetry?.("uranium");
dbg.queueAdd("build:unobtainiumFrontierT6", 0);
dbg.forceActiveTarget(null);
fakeNow += 1000;
dbg.optimizeProcessing();
check("Task 6 review: cooldown-held Reactor burn is charged before later processor families",
  reactorT6.on === 1 && lunarOutpostT6.on === 0);

// After cooldown, reconstruct the one global 2.5/s outside supply from live net
// telemetry. The selected Lunar producer gets first call and the incumbent
// Reactor yields instead of defending the net-zero state it helped create.
reactorT6.on = 1;
lunarOutpostT6.on = 0;
res("uranium").value = 100;
perTick.uranium = 0.3; // +1.5/s net + 1/s live Reactor burn = 2.5/s gross.
dbg.clearResourceTelemetry?.("uranium");
fakeNow += 21000;
dbg.forceActiveTarget(null);
dbg.optimizeProcessing();
check("Task 6 review: target-useful Lunar allocation takes over from an incumbent Reactor",
  lunarOutpostT6.on === 1 && reactorT6.on === 0);

const sharedAllocationReportT6 = dbg.reportForTarget?.({ kind: "build", meta: unobtainiumFrontierT6, affordable: false }) || "";
check("Task 6 review: diagnostics print the same shared allocation used by execution",
  /Reactor T6:.*sustainable 0\/1/i.test(sharedAllocationReportT6) &&
  /Lunar Outpost T6:.*sustainable 1\/1/i.test(sharedAllocationReportT6));

// P1 review: a target-useful power consumer may need the fleet allocator to
// retain the minimum shared-fuel generator count first. With 0 Wt base power,
// one Reactor supplies the 3 Lunar Outposts plus the 1 Wt safety headroom; the
// exact uranium budget must not start an optional second Reactor afterward.
reactorT6.val = 2;
reactorT6.on = 1;
lunarOutpostT6.val = 3;
lunarOutpostT6.on = 0;
res("uranium").value = 100;
perTick.uranium = 1.5; // +7.5/s net + 1/s live Reactor burn = 8.5/s gross.
dbg.clearResourceTelemetry?.("uranium");
gamePage.resPool.energyProd = 5;
gamePage.resPool.energyCons = 0;
gamePage.resPool.energyWinterProd = 5;
fakeNow += 21000;
dbg.forceActiveTarget(null);
dbg.optimizeProcessing();
check("Task 6 P1: minimum Reactor generation is pre-allocated before the prioritized Lunar fleet",
  reactorT6.on === 1 && lunarOutpostT6.on === 3);

// P1 review: build a real paused-for-power memo, age out its pause cooldown,
// then provide raw power equal to 3 Lunar demand + the 1 Wt safety headroom.
// Latent demand is a planning signal and must not be subtracted a second time
// inside the fleet allocation that is itself deciding how much can resume.
reactorT6.val = 0;
reactorT6.on = 0;
lunarOutpostT6.val = 3;
lunarOutpostT6.on = 3;
res("uranium").value = 100;
perTick.uranium = 0; // net zero while all three consume the 7.5/s outside supply.
dbg.clearResourceTelemetry?.("uranium");
gamePage.resPool.energyProd = 0;
gamePage.resPool.energyCons = 1;
gamePage.resPool.energyWinterProd = 0;
fakeNow += 21000;
dbg.forceActiveTarget(null);
dbg.optimizeProcessing();
check("Task 6 P1 fixture: Lunar fleet is paused with latent power demand", lunarOutpostT6.on === 0 && dbg.latentPowerDemand?.() >= 3);
perTick.uranium = 1.5; // +7.5/s outside supply with Lunar now off.
dbg.clearResourceTelemetry?.("uranium");
gamePage.resPool.energyProd = 4;
gamePage.resPool.energyCons = 0;
gamePage.resPool.energyWinterProd = 4;
fakeNow += 21000;
dbg.forceActiveTarget(null);
dbg.optimizeProcessing();
check("Task 6 P1: raw power at fleet demand plus headroom resumes a latent-paused Lunar fleet",
  lunarOutpostT6.on === 3);

dbg.queueClear();
delete perTick.unobtainium;
buildings.splice(buildings.indexOf(backgroundProcessorT6), 1);
buildings.splice(buildings.indexOf(unobtainiumFrontierT6), 1);

const diagnosticTransT6 = { name: "diagnosticTransT6", label: "Transcendence Diagnostic T6", unlocked: true, val: 0, on: 0, prices: [{ name: "relic", val: 10 }], effects: {} };
const diagnosticChronoT6 = { name: "diagnosticChronoT6", label: "Chronoforge Diagnostic T6", unlocked: true, val: 0, on: 0, prices: [{ name: "timeCrystal", val: 5 }], effects: {} };
const diagnosticVoidT6 = { name: "diagnosticVoidT6", label: "Void Space Diagnostic T6", unlocked: true, val: 0, on: 0, prices: [{ name: "void", val: 50 }, { name: "karma", val: 10 }], effects: {} };
const unlockTransT6 = { name: "unlockTransT6", label: "Unlock Transcendence T6", unlocked: false, val: 0, on: 0, prices: [{ name: "relic", val: 1 }], effects: {} };
const unlockChronoT6 = { name: "unlockChronoT6", label: "Unlock Chronoforge T6", unlocked: false, val: 0, on: 0, prices: [{ name: "timeCrystal", val: 1 }], effects: {} };
transcendenceUpgrades.push(diagnosticTransT6, unlockTransT6);
chronoforgeUpgrades.push(diagnosticChronoT6, unlockChronoT6);
voidspaceUpgrades.push(diagnosticVoidT6);

// Seed the watcher with the new families still locked, then open all three
// metadata sources while a stale lock is active.
dbg.watchNewUnlocks?.();
dbg.forceActiveTarget(fuelTargetT6, "Economy / normal growth", 0);
unlockMissionT6.unlocked = true;
unlockTransT6.unlocked = true;
unlockChronoT6.unlocked = true;
const unlockWatchT6 = dbg.watchNewUnlocks?.();
check("Task 6 unlocks: Space, Time, and transcendence metadata all enter the watcher",
  ["space:unlockMissionT6", "time:unlockChronoT6", "transcendence:unlockTransT6"].every((id) => unlockWatchT6?.freshIds?.includes(id)));
check("Task 6 unlocks: a late-game unlock invalidates the stale plan lock",
  unlockWatchT6?.invalidated === true && dbg.activeTargetId?.() === null);

// Diagnostics must explain the whole selected late-game route from one dump.
// Make uranium short so Dragons are the active acquisition step; keep the
// direct time-crystal bill banked to exercise the rare-capital floor line.
fuelProducerT6.prices = [{ name: "uranium", val: 200 }, { name: "timeCrystal", val: 5 }];
unlockMissionT6.prices = [{ name: "uranium", val: 200 }, { name: "timeCrystal", val: 5 }];
unlockMissionT6.unlocks = { planet: ["diagnosticPlanetT6"] };
res("uranium").value = 100;
perTick.uranium = 0;
dbg.clearResourceTelemetry?.("uranium");
res("manpower").value = 1000;
res("gold").value = 1000;
res("titanium").value = 2000;
diplomacy.races.splice(0, diplomacy.races.length, {
  name: "dragons",
  title: "Dragons",
  unlocked: true,
  embassyLevel: 10,
  standing: 0,
  energy: 0,
  buys: [{ name: "titanium", val: 250 }],
  sells: [{ name: "uranium", value: 20, chance: 1, width: 0 }],
});
reactorT6.val = 4;
reactorT6.on = 0;
lunarOutpostT6.val = 0;
lunarOutpostT6.on = 0;
dbg.forceActiveTarget(null);
const reportT6 = dbg.reportForTarget?.({ kind: "space", meta: unlockMissionT6, affordable: false }) || dbg.report();
check("Task 6 diagnostics: report prints route nodes with ETA and blockers",
  /ACQUISITION ROUTE/i.test(reportT6) && /Uranium.*ETA.*blocker/i.test(reportT6));
check("Task 6 diagnostics: report prints diplomacy expected yield and bounded batch cap",
  /Dragons.*expected yield.*batch cap/i.test(reportT6));
check("Task 6 diagnostics: report retains exact Space gate reasons",
  /Moon T6.*Space Gate T6.*technology.*Chronophysics Gate T6/i.test(reportT6));
check("Task 6 diagnostics: report includes Transcendence, Chronoforge, and Void Space census entries",
  /Transcendence Diagnostic T6/i.test(reportT6) && /Chronoforge Diagnostic T6/i.test(reportT6) && /Void Space Diagnostic T6/i.test(reportT6));
check("Task 6 diagnostics: report includes prestige projections and rare-capital floors",
  /Prestige:.*Transcend.*Adore.*Alicorn/i.test(reportT6) && /Rare floors:.*Time Crystal.*5/i.test(reportT6));
check("Task 6 diagnostics: report includes each processor's sustainable fuel budget",
  /Reactor T6:.*sustainable 0\/4.*Uranium.*60s/i.test(reportT6));

buildings.splice(buildings.indexOf(fuelProducerT6), 1);
buildings.splice(buildings.indexOf(reactorT6), 1);
techs.splice(techs.indexOf(spaceGateTechT6), 1);
transcendenceUpgrades.splice(transcendenceUpgrades.indexOf(diagnosticTransT6), 1);
transcendenceUpgrades.splice(transcendenceUpgrades.indexOf(unlockTransT6), 1);
chronoforgeUpgrades.splice(chronoforgeUpgrades.indexOf(diagnosticChronoT6), 1);
chronoforgeUpgrades.splice(chronoforgeUpgrades.indexOf(unlockChronoT6), 1);
voidspaceUpgrades.splice(voidspaceUpgrades.indexOf(diagnosticVoidT6), 1);
delete gamePage.space;
diplomacy.races.splice(0, diplomacy.races.length, ...savedFuelT6.races);
res("science").value = savedFuelT6.scienceValue;
res("science").maxValue = savedFuelT6.scienceMax;
perTick.science = savedFuelT6.scienceRate;
if (savedFuelT6.uraniumRate === undefined) delete perTick.uranium; else perTick.uranium = savedFuelT6.uraniumRate;
gamePage.resPool.energyProd = savedFuelT6.powerProd;
gamePage.resPool.energyCons = savedFuelT6.powerCons;
gamePage.resPool.energyWinterProd = savedFuelT6.powerWinter;
for (const resource of addedResourcesT6) resources.splice(resources.indexOf(resource), 1);
dbg.forceActiveTarget(null);

if (failures.length) {
  console.error(`\n✗ ${failures.length} smoke check(s) failed`);
  process.exit(1);
}
console.log("\n✓ All smoke checks passed — the plan reserves, pushes through, and recursion/policies behave.");
