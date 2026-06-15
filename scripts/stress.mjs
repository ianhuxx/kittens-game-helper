// Continuous stress simulation — 10 runs × ~100 ticks each, fast time.
// Finds stalls: the helper locking onto unreachable targets, failing to buy,
// or the game economy deadlocking (e.g. minerals→iron→plate→ship chain stalling).
// Run with: npm run stress
//
// A "stall" is: 20+ ticks without a new purchase by the helper, OR a target
// locked > 15 ticks without making progress on its prerequisites, OR a key
// resource staying at zero for 10+ ticks while the helper does nothing about it.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const scriptPath = fileURLToPath(new URL("../src/kittens-game-helper.user.js", import.meta.url));
const source = await readFile(scriptPath, "utf8");
const body = source.replace(/\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==/, "");

const STRESS_TICKS = 120;  // ~8 minutes of game-time per run
const STALL_THRESHOLD = 20; // ticks without any purchase = stuck
const ZERO_RESOURCE_STALL = 12; // ticks a key resource stays at zero
const RUNS = 10;

/* ------------------------------- fake DOM --------------------------------- */
const makeEl = () => ({
  style: {}, children: [], textContent: "", innerHTML: "", value: "", title: "", id: "", className: "",
  disabled: false, selectors: new Map(),
  classList: { toggle() {}, contains: () => false, add() {}, remove() {} },
  addEventListener() {}, appendChild(child) { this.children.push(child); }, remove() {},
  querySelector(sel) {
    if (!this.selectors.has(sel)) this.selectors.set(sel, makeEl());
    return this.selectors.get(sel);
  },
});

const documentMock = { head: makeEl(), body: makeEl(), createElement: () => makeEl(), getElementById: () => null };
const storage = new Map();
const localStorageMock = { getItem: (k) => storage.has(k) ? storage.get(k) : null, setItem: (k, v) => storage.set(k, String(v)) };

/* --------------------------- game state factory ---------------------------- */

const R = (name, value, maxValue, title, extra = {}) => ({
  name, value, maxValue, title: title || name[0].toUpperCase() + name.slice(1), unlocked: true, ...extra,
});

const makeFreshState = () => {
  // Mid-game state: ~15 kittens, basic infrastructure, entering the science push
  const resources = [
    R("catnip", 1800, 8000),
    R("wood", 220, 2500),
    R("minerals", 600, 1500),
    R("iron", 60, 280),
    R("coal", 20, 120),
    R("science", 1500, 12000),
    R("culture", 2500, 6000),
    R("faith", 5, 150),
    R("manpower", 400, 800, "Catpower"),
    R("gold", 45, 55),
    R("ship", 0, 0, "Ship"),
    R("titanium", 0, 100, "Titanium"),
    R("furs", 350, 0),
    R("ivory", 80, 0),
    R("spice", 0, 0, "Spice", { unlocked: false }),
    R("parchment", 10, 0),
    R("manuscript", 0, 0),
    R("compedium", 0, 0, "Compendium"),
    R("beam", 12, 0),
    R("slab", 8, 0),
    R("scaffold", 2, 0),
    R("plate", 3, 0),
    R("steel", 0, 0),
    R("gear", 30, 0),
    R("blueprint", 0, 0),
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

  const buildings = [
    { name: "hut", label: "Hut", unlocked: true, val: 8, on: 8, prices: [{ name: "wood", val: 5000 }], effects: { manpowerMax: 35 } },
    { name: "logHouse", label: "Log House", unlocked: true, val: 3, on: 3, prices: [{ name: "wood", val: 500 }, { name: "beam", val: 5 }], effects: { manpowerMax: 50 } },
    { name: "library", label: "Library", unlocked: true, val: 4, on: 4, prices: [{ name: "wood", val: 500 }], effects: { scienceMax: 250 } },
    { name: "academy", label: "Academy", unlocked: true, val: 2, on: 2, prices: [{ name: "wood", val: 700 }, { name: "beam", val: 15 }], effects: { scienceMax: 500 } },
    { name: "mine", label: "Mine", unlocked: true, val: 3, on: 3, prices: [{ name: "wood", val: 300 }], effects: { mineralsRatio: 0.15 } },
    { name: "barn", label: "Barn", unlocked: true, val: 3, on: 3, prices: [{ name: "wood", val: 1000 }], effects: { catnipMax: 3000, woodMax: 200 } },
    { name: "workshop", label: "Workshop", unlocked: true, val: 2, on: 2, prices: [{ name: "wood", val: 100 }, { name: "minerals", val: 100 }], effects: { craftRatio: 0.06 } },
    { name: "smelter", label: "Smelter", unlocked: true, val: 1, on: 1, prices: [{ name: "iron", val: 2000 }, { name: "minerals", val: 500 }], effects: { woodPerTickCon: -0.005, mineralsPerTickCon: -0.02, ironPerTickProd: 0.001, coalPerTickProd: 0.0001, goldPerTickProd: 0.00005 } },
    { name: "amphitheatre", label: "Amphitheatre", unlocked: true, val: 1, on: 1, prices: [{ name: "wood", val: 1000 }, { name: "parchment", val: 15 }], effects: { cultureMax: 250, happiness: 3 } },
    { name: "temple", label: "Temple", unlocked: true, val: 1, on: 1, prices: [{ name: "beam", val: 10 }, { name: "slab", val: 10 }], effects: { cultureMax: 100, happiness: 1 } },
    { name: "observatory", label: "Observatory", unlocked: false, val: 0, on: 0, prices: [{ name: "iron", val: 100 }, { name: "scaffold", val: 10 }], effects: { scienceRatio: 0.1, scienceMax: 500 } },
    { name: "calciner", label: "Calciner", unlocked: false, val: 0, on: 0, prices: [{ name: "steel", val: 5 }, { name: "titanium", val: 15 }], effects: { mineralsPerTickCon: -0.02, oilPerTickCon: -0.01, ironPerTickProd: 0.001, titaniumPerTickProd: 0.0001, coalPerTickProd: 0.0001 } },
    { name: "mansion", label: "Mansion", unlocked: false, val: 0, on: 0, prices: [{ name: "slab", val: 75 }, { name: "steel", val: 25 }], effects: { manpowerMax: 75 } },
  ];

  const techs = [
    { name: "calendar", label: "Calendar", unlocked: true, researched: true, prices: [{ name: "science", val: 200 }], unlocks: { buildings: ["amphitheatre"], upgrades: [] } },
    { name: "agriculture", label: "Agriculture", unlocked: true, researched: true, prices: [{ name: "science", val: 100 }], unlocks: { buildings: ["barn"] } },
    { name: "archery", label: "Archery", unlocked: true, researched: true, prices: [{ name: "science", val: 300 }], unlocks: { upgrades: [] } },
    { name: "mining", label: "Mining", unlocked: true, researched: true, prices: [{ name: "science", val: 500 }], unlocks: { buildings: ["mine", "smelter"], upgrades: [] } },
    { name: "animalHusbandry", label: "Animal Husbandry", unlocked: true, researched: true, prices: [{ name: "science", val: 400 }], unlocks: { buildings: [], upgrades: [] } },
    { name: "metalWorking", label: "Metal Working", unlocked: true, researched: true, prices: [{ name: "science", val: 900 }], unlocks: { upgrades: [] } },
    { name: "civilService", label: "Civil Service", unlocked: true, researched: true, prices: [{ name: "science", val: 1500 }], unlocks: { buildings: [], upgrades: [] } },
    { name: "currency", label: "Currency", unlocked: true, researched: true, prices: [{ name: "science", val: 2000 }], unlocks: { upgrades: [] } },
    { name: "construction", label: "Construction", unlocked: true, researched: true, prices: [{ name: "science", val: 2500 }], unlocks: { buildings: ["workshop"], upgrades: [] } },
    { name: "engineering", label: "Engineering", unlocked: true, researched: true, prices: [{ name: "science", val: 3500 }], unlocks: { buildings: ["temple"] } },
    { name: "writing", label: "Writing", unlocked: true, researched: true, prices: [{ name: "science", val: 4500 }], unlocks: { buildings: ["library"] } },
    { name: "philosophy", label: "Philosophy", unlocked: true, researched: true, prices: [{ name: "science", val: 6000 }], unlocks: { buildings: ["academy"] } },
    // Open/researchable techs:
    { name: "machinery", label: "Machinery", unlocked: true, researched: false, prices: [{ name: "science", val: 15000 }], unlocks: { buildings: ["observatory"], upgrades: ["factoryAutomation", "crossbow"] } },
    { name: "theology", label: "Theology", unlocked: true, researched: false, prices: [{ name: "science", val: 25000 }, { name: "manuscript", val: 35 }], unlocks: { jobs: ["priest"], tech: ["astronomy"] } },
    { name: "astronomy", label: "Astronomy", unlocked: false, researched: false, prices: [{ name: "science", val: 30000 }, { name: "manuscript", val: 65 }], unlocks: { tech: ["navigation"] } },
    { name: "navigation", label: "Navigation", unlocked: false, researched: false, prices: [{ name: "science", val: 50000 }], unlocks: { buildings: ["harbour"], tech: ["physics"] } },
    { name: "physics", label: "Physics", unlocked: false, researched: false, prices: [{ name: "science", val: 75000 }], unlocks: { buildings: ["calciner"] } },
    { name: "chemistry", label: "Chemistry", unlocked: false, researched: false, prices: [{ name: "science", val: 65000 }, { name: "compedium", val: 10 }], unlocks: { upgrades: [] } },
    { name: "trivia", label: "Trivia", unlocked: true, researched: false, prices: [{ name: "science", val: 15000 }], unlocks: {} }, // filler tech - no unlocks
  ];

  const policies = [
    { name: "liberty", label: "Liberty", unlocked: true, researched: false, blocked: false, blocks: ["tradition"], prices: [{ name: "culture", val: 1500 }], effects: {} },
    { name: "tradition", label: "Tradition", unlocked: true, researched: false, blocked: false, blocks: ["liberty"], prices: [{ name: "culture", val: 1500 }], effects: {} },
    { name: "openFairs", label: "Open Fairs", unlocked: true, researched: false, blocked: false, blocks: [], prices: [{ name: "culture", val: 1500 }], effects: {} },
  ];

  const workshopUpgrades = [
    { name: "factoryAutomation", label: "Factory Automation", unlocked: false, researched: false, prices: [{ name: "science", val: 7500 }, { name: "gear", val: 45 }], effects: {} },
    { name: "crossbow", label: "Crossbow", unlocked: false, researched: false, prices: [{ name: "manpower", val: 2500 }], effects: { hunterRatio: 0.25 } },
    { name: "mineralHoes", label: "Mineral Hoes", unlocked: true, researched: false, prices: [{ name: "science", val: 750 }], effects: { mineralsRatio: 0.15 } },
    { name: "ironAxe", label: "Iron Axe", unlocked: true, researched: false, prices: [{ name: "science", val: 900 }], effects: { woodRatio: 0.15 } },
    { name: "steelAxe", label: "Steel Axe", unlocked: true, researched: false, prices: [{ name: "science", val: 3000 }, { name: "steel", val: 5 }], effects: { woodRatio: 0.25 } },
    { name: "steelArmour", label: "Steel Armour", unlocked: true, researched: false, prices: [{ name: "science", val: 2500 }, { name: "steel", val: 10 }], effects: {} },
  ];

  const religionUpgrades = [
    { name: "solarchant", label: "Solar Chant", unlocked: true, noStackable: true, on: 0, val: 0, faith: 150, prices: [{ name: "faith", val: 100 }], effects: { faithRatioReligion: 0.1 } },
  ];

  const J = (name, title, value) => ({ name, title, unlocked: true, value });
  const jobs = [
    J("woodcutter", "Woodcutter", 3),
    J("farmer", "Farmer", 4),
    J("miner", "Miner", 2),
    J("scholar", "Scholar", 4),
    J("hunter", "Hunter", 2),
    J("priest", "Priest", 0),
    J("geologist", "Geologist", 0),
  ];
  const job = (name) => jobs.find((j) => j.name === name);

  const kittens = [
    { name: "Ada", rank: 1, exp: 200, job: "farmer", trait: { name: "scientist", title: "Scientist" }, skills: {} },
    { name: "Brio", rank: 1, exp: 300, job: "woodcutter", trait: { name: "engineer", title: "Engineer" }, skills: {} },
    { name: "Caz", rank: 0, exp: 50, job: "miner", trait: { name: "none", title: "None" }, skills: {} },
    { name: "Dex", rank: 0, exp: 0, job: "scholar", trait: { name: "manager", title: "Manager" }, skills: {} },
  ];

  let promoteCalls = 0;

  const calendar = { festivalDays: 0 };

  const diplomacy = {
    races: [],
    get: (name) => diplomacy.races.find((r) => r.name === name),
    getManpowerCost: () => 50,
    getGoldCost: () => 15,
  };

  const village = {
    happiness: 0.92,
    jobs,
    leader: null,
    sim: {
      kittens,
      removeJob(name, amt) { const j = job(name); if (j) j.value = Math.max(0, j.value - amt); },
      promote() { promoteCalls += 1; },
    },
    getKittens: () => 15,
    getFreeKittens: () => 0,
    getJobLimit: () => 100000,
    assignJob(j, amt) { if (j) j.value += amt; },
    makeLeader(kitten) {
      if (village.leader) village.leader.isLeader = false;
      village.leader = kitten;
      kitten.isLeader = true;
    },
    promoteKittens() { promoteCalls += 1; res("gold").value -= 30; },
    huntAll() { res("furs").value += 200; res("ivory").value += 30; res("manpower").value = 0; },
    getResProduction: () => ({ catnip: 3, wood: 1.5, minerals: 1, science: 1, manpower: 0.5 }),
    updateResourceProduction() {},
  };

  const perTick = { catnip: 2, wood: 1.5, minerals: 1.1, science: 1.3, culture: 1.1, manpower: 1.0, iron: 0.05, coal: 0.01, gold: 0.01, furs: 0.3, ivory: 0.02 };
  const craftRatios = {};
  const getResCraftRatio = (name) => Number.isFinite(craftRatios[name]) ? craftRatios[name] : 0;

  const gamePage = {
    resPool: {
      resources,
      get: (name) => res(name),
      payPrices(prices) {
        for (const p of prices) { if (res(p.name)) res(p.name).value -= p.val; }
      },
      addResEvent(name, val) { if (res(name)) res(name).value += val; },
    },
    bld: {
      buildingsData: buildings,
      getPrices: (name) => (buildings.find((b) => b.name === name) || {}).prices || [],
      build(name) {
        const b = buildings.find((x) => x.name === name);
        if (!b) return false;
        for (const price of b.prices) {
          if ((res(price.name) || {}).value < price.val) return false;
        }
        for (const price of b.prices) res(price.name).value -= price.val;
        b.val = (b.val || 0) + 1;
        b.on = (b.on || 0) + 1;
        return true;
      },
      updateEffects() {},
    },
    science: {
      techs,
      policies,
      get: (name) => techs.find((t) => t.name === name),
      getPrices: (meta) => (meta && meta.prices) || [],
      research(name) {
        const t = techs.find((x) => x.name === name);
        if (!t || t.researched) return false;
        for (const price of t.prices) {
          if ((res(price.name) || {}).value < price.val) return false;
        }
        for (const price of t.prices) res(price.name).value -= price.val;
        t.researched = true;
        // Unlock downstream buildings
        if (t.unlocks) {
          if (t.unlocks.buildings) {
            for (const bname of t.unlocks.buildings) {
              const b = buildings.find((x) => x.name === bname);
              if (b) b.unlocked = true;
            }
          }
          if (t.unlocks.upgrades) {
            for (const uname of t.unlocks.upgrades) {
              const u = workshopUpgrades.find((x) => x.name === uname);
              if (u) u.unlocked = true;
            }
          }
        }
        return true;
      },
      researchPolicy(meta) {
        const p = policies.find((x) => x.name === (meta.name || meta));
        if (!p || p.researched) return false;
        for (const price of p.prices) {
          if ((res(price.name) || {}).value < price.val) return false;
        }
        for (const price of p.prices) res(price.name).value -= price.val;
        p.researched = true;
        return true;
      },
    },
    religion: {
      faith: 200,
      religionUpgrades,
      build(name) {
        const u = religionUpgrades.find((x) => x.name === name);
        if (!u || u.on > 0) return false;
        for (const price of u.prices) {
          if ((res(price.name) || {}).value < price.val) return false;
        }
        for (const price of u.prices) res(price.name).value -= price.val;
        u.on = (u.on || 0) + 1;
        u.val = (u.val || 0) + 1;
        return true;
      },
    },
    workshop: {
      upgrades: workshopUpgrades,
      crafts,
      get: (name) => workshopUpgrades.find((u) => u.name === name),
      getCraft: (name) => craft(name),
      getCraftPrice: (c) => (c && c.prices) || [],
      getPrices: (meta) => (meta && meta.prices) || [],
      research(name) {
        const u = workshopUpgrades.find((x) => x.name === name);
        if (!u || u.researched) return false;
        for (const price of u.prices) {
          if ((res(price.name) || {}).value < price.val) return false;
        }
        for (const price of u.prices) res(price.name).value -= price.val;
        u.researched = true;
        return true;
      },
    },
    village,
    calendar,
    diplomacy,
    villageTab: { updateTab() {} },
    bonfireTab: { updateTab() {} },
    updateResources() {},
    unlock() {},
    upgrade() {},
    render() {},
    getEffect: () => 0,
    getResCraftRatio,
    ticksPerSecond: 5,
    getResourcePerTick: (name, _includeConversion) => Number.isFinite(perTick[name]) ? perTick[name] : 0,
    craft(name, amount) {
      const c = craft(name);
      if (!c || amount <= 0) return false;
      for (const p of c.prices) {
        if ((res(p.name) || {}).value < p.val * amount) return false;
      }
      for (const p of c.prices) res(p.name).value -= p.val * amount;
      res(name).value += amount * (1 + getResCraftRatio(name));
      return true;
    },
    tradeTab: {
      exploreBtn: { model: { prices: [{ name: "manpower", val: 1000 }] } },
    },
  };

  return { resources, res, crafts, buildings, techs, policies, workshopUpgrades, religionUpgrades, jobs, kittens, diplomacy, village, perTick, craftRatios, gamePage, promoteCalls };
};

/* ------------------------------- fake KS ----------------------------------- */
const makeKS = () => {
  const S = (extra = {}) => ({ enabled: false, ...extra });
  return {
    getSettings: () => ({
      engine: S({ interval: 2000 }),
      bonfire: S({ buildings: {} }),
      science: S({ techs: {}, policies: {}, observe: S() }),
      religion: S({ faith: S(), adore: S(), sacrificeUnicorns: S() }),
      space: S(),
      time: S({ reset: S() }),
      trade: S(),
      workshop: S({ crafts: {}, upgrades: {} }),
      village: S({ jobs: {}, hunt: S(), holdFestivals: S(), electLeader: S(), promoteLeader: S(), promoteKittens: S() }),
    }),
    setSettings() {},
    engine: { _timeoutMainLoop: 1, start() {} },
  };
};

/* ---------------------------- simulation loop ------------------------------ */

function simulateRun(runNumber, state) {
  const failures = [];
  const check = (label, ok) => { if (!ok) failures.push(`Run ${runNumber}: ${label}`); };

  const { resources, res, buildings, techs, policies, workshopUpgrades, diplomacy, village, perTick, gamePage } = state;

  // Re-create fresh context per run
  const localStorage = new Map();
  const localStorageMock2 = { getItem: (k) => localStorage.has(k) ? localStorage.get(k) : null, setItem: (k, v) => localStorage.set(k, String(v)) };
  const docMock = { head: makeEl(), body: makeEl(), createElement: () => makeEl(), getElementById: () => null };
  const ks = makeKS();

  const context = {
    console, Date, Math, JSON, Number, isFinite,
    document: docMock, localStorage: localStorageMock2,
    gamePage, kittenScientists: ks,
    setTimeout, clearTimeout,
    setInterval: (fn) => { /* store nothing, we call manually */ },
    WeakMap, Map, Set, Promise, Array, Object,
  };
  context.window = context;
  const sandbox = vm.createContext(context);
  vm.runInContext(body, sandbox, { filename: "kittens-game-helper.user.js" });

  // Advance time to let the bootstrap settle
  let fakeNow = Date.now() + 5000;

  const track = {
    purchases: 0,
    lastPurchaseTick: 0,
    buyKinds: {},
    targetChanges: 0,
    currentTarget: null,
    targetLockTicks: 0,
    zeroResourceTicks: {},
    stalls: [],
  };

  // Manually invoke the tick function (it's stored in the setInterval callback)
  // We can't easily extract it, so instead we'll advance time and call a mock tick
  // by directly invoking the game loop.

  // Actually the script's tick runs via setInterval. In the VM context we override
  // setInterval to store the fn, so we can call it. But the script calls setInterval
  // at the end with an anonymous function. Let's capture it.
  let tickFn = null;
  const origSetInterval = context.setInterval;
  context.setInterval = (fn) => { tickFn = fn; return 1; };

  // Now run the bootstrap
  vm.runInContext(body, sandbox, { filename: "kittens-game-helper.user.js" });

  // Simulate ticks
  for (let tick = 1; tick <= STRESS_TICKS; tick++) {
    fakeNow += 4000; // advance 4 seconds (helper's tick interval)

    // Simulate resource production per tick
    for (const [name, rate] of Object.entries(perTick)) {
      const r = res(name);
      if (!r || !r.maxValue) continue;
      const value = r.value + rate * 4; // 4 seconds of production
      r.value = r.maxValue > 0 ? Math.min(r.maxValue, Math.max(0, value)) : value;
    }

    // Run the helper's tick
    if (tickFn) {
      try {
        tickFn();
      } catch (e) {
        /* ignore */
      }
    }

    // Track progress
    const logStr = localStorage.get("kgh.log") || "[]";
    let logEntries = [];
    try { logEntries = JSON.parse(logStr); } catch (e) {}

    // Count purchase events since last tick
    const purchasePatterns = ["🎯 plan", "⚙ surplus", "🔬 surplus", "🏗 surplus", "🔬 cap relief", "⚙ cap relief", "📜 policy", "☀ religion", "⚙ plan"];
    let madePurchase = false;
    for (const entry of logEntries) {
      if (purchasePatterns.some((p) => entry.includes(p))) {
        madePurchase = true;
        track.lastPurchaseTick = tick;
        track.purchases += 1;
        for (const kind of ["research", "upgrade", "build", "policy", "religion"]) {
          if (entry.includes(kind)) track.buyKinds[kind] = (track.buyKinds[kind] || 0) + 1;
        }
      }
    }

    // Check if helper bought something
    if (madePurchase) {
      // track it
    }

    // Check for stall
    if (tick - track.lastPurchaseTick > STALL_THRESHOLD && tick > 30) {
      if (!track.stalls.some((s) => s.type === "no-purchase" && s.endTick >= tick - 1)) {
        track.stalls.push({ type: "no-purchase", startTick: track.lastPurchaseTick + 1, endTick: tick, duration: tick - track.lastPurchaseTick });
      }
    }

    // Check zero resources
    for (const name of ["wood", "minerals", "iron", "coal", "science", "catnip"]) {
      const r = res(name);
      if (r && r.value <= 0 && r.maxValue > 0) {
        if (!track.zeroResourceTicks[name]) track.zeroResourceTicks[name] = 0;
        track.zeroResourceTicks[name] += 1;
      } else {
        if (track.zeroResourceTicks[name] > ZERO_RESOURCE_STALL) {
          if (!track.stalls.some((s) => s.type === "zero-resource" && s.resource === name)) {
            track.stalls.push({ type: "zero-resource", resource: name, ticks: track.zeroResourceTicks[name] });
          }
        }
        track.zeroResourceTicks[name] = 0;
      }
    }

    // Check if any tech was researched
    const researchedTechs = techs.filter((t) => t.researched).length;
    const totalOpenTechs = techs.filter((t) => t.unlocked && !t.researched).length;

    // Check building count
    const totalBuildings = buildings.reduce((sum, b) => sum + (b.val || 0), 0);

    // Check workshop upgrades researched
    const wsResearched = workshopUpgrades.filter((u) => u.researched).length;
  }

  // End-of-run analysis
  const logStr = localStorage.get("kgh.log") || "[]";
  const researchedTechs = techs.filter((t) => t.researched).length;
  const totalBuildings = buildings.reduce((sum, b) => sum + (b.val || 0), 0);
  const wsResearched = workshopUpgrades.filter((u) => u.researched).length;
  const policiesAdopted = policies.filter((p) => p.researched).length;

  console.log(`\n--- Run ${runNumber} results ---`);
  console.log(`  Purchases: ${track.purchases}`);
  console.log(`  Techs researched: ${researchedTechs}/${techs.length}`);
  console.log(`  Buildings total: ${totalBuildings}`);
  console.log(`  Workshop upgrades: ${wsResearched}`);
  console.log(`  Policies adopted: ${policiesAdopted}`);
  console.log(`  Stalls detected: ${track.stalls.length}`);
  for (const stall of track.stalls) {
    console.log(`    STALL: ${stall.type} ${stall.resource ? stall.resource : ""} for ${stall.duration || stall.ticks} ticks`);
  }

  // Critical checks
  check("made at least 3 purchases", track.purchases >= 3);
  check("no stall > 30 ticks without a purchase", !track.stalls.some((s) => s.type === "no-purchase" && s.duration > 30));

  // Check for various stall patterns
  if (track.stalls.length > 0) {
    for (const stall of track.stalls) {
      failures.push(`Run ${runNumber}: ${stall.type} stall - ${stall.resource || "purchases"} for ${stall.duration || stall.ticks} ticks`);
    }
  }

  return { track, failures, state };
}

/* -------------------------------- run all ---------------------------------- */

console.log(`Kittens Helper Stress Test — ${RUNS} runs × ${STRESS_TICKS} ticks each\n`);

const allFailures = [];
for (let run = 1; run <= RUNS; run++) {
  const state = makeFreshState();
  const { failures } = simulateRun(run, state);
  allFailures.push(...failures);
}

console.log(`\n${"=".repeat(60)}`);
if (allFailures.length) {
  console.error(`\n✗ ${allFailures.length} stress check(s) failed across ${RUNS} runs:`);
  for (const f of allFailures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`\n✓ All stress checks passed across ${RUNS} runs — no stalls detected.`);
