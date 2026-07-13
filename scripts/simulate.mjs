// Multi-scenario simulation harness. Run with: npm run simulate
//
// The old stress test ran ONE fixed scenario 10 times, which proves almost
// nothing. This drives the helper through DISTINCT game states — early, mid,
// a titanium "trap", a real titanium need, and a craft-chain (compendium) —
// each toward a chosen goal, for many ticks with live production, and asserts
// the things that actually matter and kept breaking:
//
//   • PROGRESS      — the bot keeps buying/advancing; it doesn't stall.
//   • COHERENCE     — what the panel DISPLAYS is what the bot DOES. In
//                     particular it never shows a "titanium path" while the
//                     focus is non-titanium, and it never runs the Zebra path
//                     for a plan that doesn't need titanium.
//   • CHAIN-DRIVE   — when the plan needs a CRAFTED resource (compendium ←
//                     manuscript ← parchment ← furs) the bot actually drives
//                     that chain instead of hunting/idling while the focus waits.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const scriptPath = fileURLToPath(new URL("../src/kittens-game-helper.user.js", import.meta.url));
const source = await readFile(scriptPath, "utf8");
const body = source.replace(/\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==/, "");

const TICKS = 80; // ~5 minutes of game-time per scenario

/* ------------------------------- fake DOM --------------------------------- */
const makeEl = () => ({
  style: {}, children: [], textContent: "", innerHTML: "", value: "", title: "", id: "", className: "",
  disabled: false, selectors: new Map(),
  classList: { toggle() {}, contains: () => false, add() {}, remove() {} },
  addEventListener() {}, appendChild(child) { this.children.push(child); }, remove() {},
  querySelector(sel) { if (!this.selectors.has(sel)) this.selectors.set(sel, makeEl()); return this.selectors.get(sel); },
});

const R = (name, value, maxValue, title, extra = {}) => ({
  name, value, maxValue, title: title || name[0].toUpperCase() + name.slice(1), unlocked: true, ...extra,
});

/* --------------------------- game state factory ---------------------------- */
// A faithful mid-game base; each scenario tweaks it (see applyPhase()).
const makeState = () => {
  const spies = {
    zebraTrades: 0, shipBuilt: 0, manuscriptMade: 0, compendiumMade: 0,
    parchmentMade: 0, festivals: 0, boosterTicks: 0, dragonTrades: 0,
    leviathanTrades: 0, transcendencePurchases: 0, chronoforgePurchases: 0,
    voidPurchases: 0, transcendCalls: 0, checkpoints: 0,
    planetBuildingPurchases: 0, planetBuildingPurchaseIds: [],
    rawSpaceManagerCalls: 0,
  };
  const mutationEvents = [];

  const resources = [
    R("catnip", 2000, 8000), R("wood", 400, 2500), R("minerals", 700, 1500),
    R("iron", 120, 280), R("coal", 40, 120), R("science", 4000, 12000),
    R("culture", 3000, 8000), R("faith", 10, 150), R("manpower", 300, 800, "Catpower"),
    R("gold", 40, 80), R("ship", 0, 0, "Ship"), R("titanium", 0, 0, "Titanium", { unlocked: false }),
    R("furs", 400, 0), R("ivory", 90, 0), R("spice", 0, 0, "Spice", { unlocked: false }),
    R("parchment", 20, 0), R("manuscript", 0, 0), R("compedium", 0, 0, "Compendium"),
    R("beam", 20, 0), R("slab", 15, 0), R("scaffold", 3, 0), R("plate", 5, 0),
    R("steel", 5, 0), R("gear", 30, 0), R("blueprint", 0, 0),
  ];
  const res = (name) => resources.find((r) => r.name === name);

  const crafts = [
    { name: "wood", label: "Refine Catnip", unlocked: true, prices: [{ name: "catnip", val: 100 }] },
    { name: "beam", label: "Beam", unlocked: true, prices: [{ name: "wood", val: 175 }] },
    { name: "slab", label: "Slab", unlocked: true, prices: [{ name: "minerals", val: 250 }] },
    { name: "plate", label: "Metal Plate", unlocked: true, prices: [{ name: "iron", val: 125 }] },
    { name: "scaffold", label: "Scaffold", unlocked: true, prices: [{ name: "beam", val: 50 }] },
    { name: "ship", label: "Ship", unlocked: true, prices: [{ name: "scaffold", val: 1 }, { name: "plate", val: 2 }] },
    { name: "parchment", label: "Parchment", unlocked: true, prices: [{ name: "furs", val: 175 }] },
    { name: "manuscript", label: "Manuscript", unlocked: true, prices: [{ name: "culture", val: 400 }, { name: "parchment", val: 25 }] },
    { name: "compedium", label: "Compendium", unlocked: true, prices: [{ name: "manuscript", val: 50 }] },
    { name: "blueprint", label: "Blueprint", unlocked: true, prices: [{ name: "science", val: 25000 }, { name: "compedium", val: 25 }] },
    { name: "steel", label: "Steel", unlocked: true, prices: [{ name: "iron", val: 100 }, { name: "coal", val: 100 }] },
    { name: "gear", label: "Gear", unlocked: true, prices: [{ name: "steel", val: 15 }] },
    { name: "alloy", label: "Alloy", unlocked: true, prices: [{ name: "titanium", val: 10 }, { name: "steel", val: 75 }] },
  ];
  const craft = (name) => crafts.find((c) => c.name === name);

  const buildings = [
    { name: "hut", label: "Hut", unlocked: true, val: 8, on: 8, prices: [{ name: "wood", val: 5000 }], effects: { manpowerMax: 35 } },
    { name: "logHouse", label: "Log House", unlocked: true, val: 3, on: 3, prices: [{ name: "wood", val: 500 }, { name: "beam", val: 5 }], effects: { manpowerMax: 50 } },
    { name: "library", label: "Library", unlocked: true, val: 6, on: 6, prices: [{ name: "wood", val: 600 }], effects: { scienceMax: 250 } },
    { name: "academy", label: "Academy", unlocked: true, val: 3, on: 3, prices: [{ name: "wood", val: 700 }, { name: "beam", val: 15 }], effects: { scienceMax: 500, scienceRatio: 0.2 } },
    { name: "mine", label: "Mine", unlocked: true, val: 4, on: 4, prices: [{ name: "wood", val: 400 }], effects: { mineralsRatio: 0.15 } },
    { name: "barn", label: "Barn", unlocked: true, val: 4, on: 4, prices: [{ name: "wood", val: 1200 }], effects: { catnipMax: 3000, woodMax: 200 } },
    { name: "warehouse", label: "Warehouse", unlocked: true, val: 2, on: 2, prices: [{ name: "beam", val: 25 }, { name: "slab", val: 30 }], effects: { ironMax: 120, mineralsMax: 200, woodMax: 150 } },
    { name: "workshop", label: "Workshop", unlocked: true, val: 3, on: 3, prices: [{ name: "wood", val: 100 }, { name: "minerals", val: 100 }], effects: { craftRatio: 0.06 } },
    { name: "smelter", label: "Smelter", unlocked: true, val: 2, on: 2, prices: [{ name: "iron", val: 2000 }, { name: "minerals", val: 500 }], effects: { mineralsPerTickCon: -0.02, ironPerTickProd: 0.002, coalPerTickProd: 0.0002 } },
    { name: "amphitheatre", label: "Amphitheatre", unlocked: true, val: 1, on: 1, prices: [{ name: "wood", val: 1000 }, { name: "parchment", val: 15 }], effects: { cultureMax: 200, happiness: 3 } },
    { name: "temple", label: "Temple", unlocked: true, val: 1, on: 1, prices: [{ name: "beam", val: 10 }, { name: "slab", val: 10 }], effects: { cultureMax: 150, happiness: 1, faithMax: 100 } },
    { name: "observatory", label: "Observatory", unlocked: false, val: 0, on: 0, prices: [{ name: "iron", val: 100 }, { name: "scaffold", val: 10 }], effects: { scienceRatio: 0.1, scienceMax: 500 } },
    { name: "calciner", label: "Calciner", unlocked: false, val: 0, on: 0, prices: [{ name: "steel", val: 5 }, { name: "titanium", val: 15 }], effects: { mineralsPerTickCon: -0.02, ironPerTickProd: 0.002, titaniumPerTickProd: 0.0005 } },
    { name: "mansion", label: "Mansion", unlocked: false, val: 0, on: 0, prices: [{ name: "slab", val: 75 }, { name: "steel", val: 25 }, { name: "titanium", val: 5 }], effects: { manpowerMax: 75 } },
  ];

  const techs = [
    { name: "mining", label: "Mining", unlocked: true, researched: true, prices: [{ name: "science", val: 500 }], unlocks: { buildings: ["mine", "smelter"] } },
    { name: "construction", label: "Construction", unlocked: true, researched: true, prices: [{ name: "science", val: 2500 }], unlocks: { buildings: ["workshop", "warehouse"] } },
    { name: "engineering", label: "Engineering", unlocked: true, researched: true, prices: [{ name: "science", val: 3500 }], unlocks: { buildings: ["temple"] } },
    { name: "writing", label: "Writing", unlocked: true, researched: true, prices: [{ name: "science", val: 4500 }], unlocks: { buildings: ["library"] } },
    { name: "philosophy", label: "Philosophy", unlocked: true, researched: true, prices: [{ name: "science", val: 6000 }], unlocks: { buildings: ["academy"] } },
    { name: "machinery", label: "Machinery", unlocked: true, researched: false, prices: [{ name: "science", val: 15000 }], unlocks: { buildings: ["observatory"], upgrades: ["factoryAutomation"] } },
    { name: "theology", label: "Theology", unlocked: true, researched: false, prices: [{ name: "science", val: 25000 }, { name: "manuscript", val: 35 }], unlocks: { jobs: ["priest"], tech: ["astronomy"] } },
    { name: "astronomy", label: "Astronomy", unlocked: false, researched: false, prices: [{ name: "science", val: 30000 }, { name: "manuscript", val: 65 }], unlocks: { tech: ["navigation"] } },
    { name: "navigation", label: "Navigation", unlocked: false, researched: false, prices: [{ name: "science", val: 50000 }], unlocks: { tech: ["physics"] } },
    { name: "physics", label: "Physics", unlocked: false, researched: false, prices: [{ name: "science", val: 75000 }], unlocks: { buildings: ["calciner"] } },
    { name: "chemistry", label: "Chemistry", unlocked: true, researched: false, prices: [{ name: "science", val: 60000 }, { name: "compedium", val: 10 }], unlocks: {} },
    { name: "trivia", label: "Trivia", unlocked: true, researched: false, prices: [{ name: "science", val: 15000 }], unlocks: {} },
  ];

  const policies = [
    { name: "liberty", label: "Liberty", unlocked: true, researched: false, blocked: false, blocks: ["tradition"], prices: [{ name: "culture", val: 1500 }], effects: {} },
    { name: "tradition", label: "Tradition", unlocked: true, researched: false, blocked: false, blocks: ["liberty"], prices: [{ name: "culture", val: 1500 }], effects: {} },
    { name: "openFairs", label: "Open Fairs", unlocked: true, researched: false, blocked: false, blocks: [], prices: [{ name: "culture", val: 1500 }], effects: {} },
  ];

  const workshopUpgrades = [
    { name: "factoryAutomation", label: "Factory Automation", unlocked: false, researched: false, prices: [{ name: "science", val: 7500 }, { name: "gear", val: 45 }], effects: {} },
    { name: "mineralHoes", label: "Mineral Hoes", unlocked: true, researched: false, prices: [{ name: "science", val: 750 }], effects: { mineralsRatio: 0.15 } },
    { name: "ironAxe", label: "Iron Axe", unlocked: true, researched: false, prices: [{ name: "science", val: 900 }], effects: { woodRatio: 0.15 } },
  ];

  const religionUpgrades = [
    { name: "solarchant", label: "Solar Chant", unlocked: true, noStackable: true, on: 0, val: 0, faith: 150, prices: [{ name: "faith", val: 100 }], effects: { faithRatioReligion: 0.1 } },
  ];

  const J = (name, title, value) => ({ name, title, unlocked: true, value });
  const jobs = [J("woodcutter", "Woodcutter", 4), J("farmer", "Farmer", 5), J("miner", "Miner", 3), J("scholar", "Scholar", 5), J("hunter", "Hunter", 2), J("priest", "Priest", 0), J("geologist", "Geologist", 0)];
  const job = (name) => jobs.find((j) => j.name === name);
  const kittens = [
    { name: "Ada", rank: 1, exp: 200, job: "farmer", trait: { name: "scientist", title: "Scientist" }, skills: {} },
    { name: "Brio", rank: 1, exp: 300, job: "woodcutter", trait: { name: "engineer", title: "Engineer" }, skills: {} },
    { name: "Caz", rank: 0, exp: 50, job: "miner", trait: { name: "metallurgist", title: "Metallurgist" }, skills: {} },
    { name: "Dex", rank: 0, exp: 0, job: "scholar", trait: { name: "manager", title: "Manager" }, skills: {} },
  ];

  const calendar = { festivalDays: 0, daysPerSeason: 100, observeRemainingTime: 0, observeHandler() { calendar.observeRemainingTime = 0; } };

  const diplomacy = {
    races: [],
    get: (name) => diplomacy.races.find((r) => r.name === name),
    getManpowerCost: () => 50, getGoldCost: () => 15, getMaxTradeAmt: () => 10,
    getTradeRatio: () => 0,
    getFinalStanding: (race) => Number(race?.standing) || 0,
    isValidTrade(sell, race) {
      const output = sell && res(sell.name);
      return !!sell && !!race && race.unlocked !== false && !race.collapsed &&
        (!sell.minLevel || (race.embassyLevel || 0) >= sell.minLevel) &&
        (!!output?.unlocked || sell.name === "uranium" || race.name === "leviathans");
    },
    getResourceTradeChance(sell, race) {
      return diplomacy.isValidTrade(sell, race) ? Number(sell.chance) || 0 : 0;
    },
    tradeMultiple(race, amt) {
      if (race && race.name === "zebras") spies.zebraTrades += amt || 1;
      if (race && race.name === "dragons") spies.dragonTrades += amt || 1;
      if (race && race.name === "leviathans") spies.leviathanTrades += amt || 1;
      const n = amt || 1;
      // model the cost so trades can't run for free
      res("manpower").value = Math.max(0, res("manpower").value - 50 * n);
      res("gold").value = Math.max(0, res("gold").value - 15 * n);
      if (race && race.buys) for (const b of race.buys) if (res(b.name)) res(b.name).value = Math.max(0, res(b.name).value - b.val * n);
      if (race && race.name === "zebras") res("titanium").value = Math.min(res("titanium").maxValue || Infinity, res("titanium").value + n * 1.5 * 0.15);
      if (race && race.name !== "zebras") {
        for (const sell of race.sells || []) {
          if (!diplomacy.isValidTrade(sell, race)) continue;
          const output = res(sell.name);
          if (!output) continue;
          const rawChance = diplomacy.getResourceTradeChance(sell, race);
          const chance = rawChance > 1 ? rawChance / 100 : rawChance;
          const gain = n * (Number(sell.value) || 0) * Math.max(0, chance);
          output.value = Math.min(output.maxValue || Infinity, output.value + gain);
          output.unlocked = true;
        }
      }
      if (race && race.name) mutationEvents.push({ action: `trade:${race.name}`, controller: "diplomacy" });
      return true;
    },
    trade(race) { diplomacy.tradeMultiple(race, 1); },
    tradeAll(race) { diplomacy.tradeMultiple(race, diplomacy.getMaxTradeAmt(race)); },
    unlockRandomRace() { return null; },
  };

  const village = {
    happiness: 1.0, jobs, leader: null,
    sim: { kittens, removeJob(name, amt) { const j = job(name); if (j) j.value = Math.max(0, j.value - amt); }, promote() {} },
    getKittens: () => kittens.length * 5, getFreeKittens: () => 0, getJobLimit: () => 100000,
    assignJob(j, amt) { if (j) j.value += amt; },
    makeLeader(k) { if (village.leader) village.leader.isLeader = false; village.leader = k; k.isLeader = true; },
    promoteKittens() { res("gold").value -= 30; },
    huntAll() { res("furs").value += 250; res("ivory").value += 40; res("manpower").value = 0; },
    holdFestival(amt) { spies.festivals += amt || 1; calendar.festivalDays += 400; },
    getResProduction: () => ({ catnip: 4, wood: 2, minerals: 1.5, science: 2, manpower: 0.6 }),
    updateResourceProduction() {},
  };

  const perTick = { catnip: 3, wood: 2.2, minerals: 1.6, science: 3.5, culture: 2.2, manpower: 1.2, iron: 0.3, coal: 0.08, gold: 0.05, furs: 0.5, ivory: 0.05 };
  const craftRatios = {};
  const getResCraftRatio = (name) => (Number.isFinite(craftRatios[name]) ? craftRatios[name] : 0);

  const gamePage = {
    opts: { noConfirm: false },
    resPool: {
      resources, get: (name) => res(name),
      payPrices(prices) { for (const p of prices) if (res(p.name)) res(p.name).value -= p.val; },
      addResEvent(name, val) { if (res(name)) res(name).value += val; },
    },
    bld: {
      buildingsData: buildings,
      getPrices: (name) => (buildings.find((b) => b.name === name) || {}).prices || [],
      build(name) {
        const b = buildings.find((x) => x.name === name);
        if (!b) return false;
        for (const p of b.prices) if ((res(p.name) || {}).value < p.val) return false;
        for (const p of b.prices) res(p.name).value -= p.val;
        b.val = (b.val || 0) + 1; b.on = (b.on || 0) + 1;
        return true;
      },
      updateEffects() {},
    },
    science: {
      techs, policies,
      get: (name) => techs.find((t) => t.name === name),
      getPrices: (meta) => (meta && meta.prices) || [],
      research(name) {
        const t = techs.find((x) => x.name === name);
        if (!t || t.researched) return false;
        for (const p of t.prices) if ((res(p.name) || {}).value < p.val) return false;
        for (const p of t.prices) res(p.name).value -= p.val;
        t.researched = true;
        if (t.unlocks) {
          for (const bn of t.unlocks.buildings || []) { const b = buildings.find((x) => x.name === bn); if (b) b.unlocked = true; }
          for (const un of t.unlocks.upgrades || []) { const u = workshopUpgrades.find((x) => x.name === un); if (u) u.unlocked = true; }
          for (const tn of t.unlocks.tech || []) { const x = techs.find((y) => y.name === tn); if (x) x.unlocked = true; }
        }
        return true;
      },
      researchPolicy(meta) {
        const p = policies.find((x) => x.name === (meta.name || meta));
        if (!p || p.researched) return false;
        for (const price of p.prices) if ((res(price.name) || {}).value < price.val) return false;
        for (const price of p.prices) res(price.name).value -= price.val;
        p.researched = true;
        return true;
      },
    },
    religion: {
      faith: 200, religionUpgrades,
      praise() { res("faith").value = 0.0001; },
      build(name) {
        const u = religionUpgrades.find((x) => x.name === name);
        if (!u || u.on > 0) return false;
        for (const p of u.prices) if ((res(p.name) || {}).value < p.val) return false;
        for (const p of u.prices) res(p.name).value -= p.val;
        u.on = (u.on || 0) + 1; u.val = (u.val || 0) + 1;
        return true;
      },
    },
    workshop: {
      upgrades: workshopUpgrades, crafts,
      get: (name) => workshopUpgrades.find((u) => u.name === name),
      getCraft: (name) => craft(name),
      getCraftPrice: (c) => (c && c.prices) || [],
      getPrices: (meta) => (meta && meta.prices) || [],
      research(name) {
        const u = workshopUpgrades.find((x) => x.name === name);
        if (!u || u.researched) return false;
        for (const p of u.prices) if ((res(p.name) || {}).value < p.val) return false;
        for (const p of u.prices) res(p.name).value -= p.val;
        u.researched = true;
        return true;
      },
    },
    village, calendar, diplomacy,
    villageTab: { updateTab() {} }, bonfireTab: { updateTab() {} },
    updateResources() {}, unlock() {}, upgrade() {}, render() {},
    tick() { spies.boosterTicks += 1; },
    getEffect: () => 0, getResCraftRatio, ticksPerSecond: 5,
    getResourcePerTick: (name) => (Number.isFinite(perTick[name]) ? perTick[name] : 0),
    craft(name, amount) {
      const c = craft(name);
      if (!c || amount <= 0) return false;
      for (const p of c.prices) if ((res(p.name) || {}).value < p.val * amount) return false;
      for (const p of c.prices) res(p.name).value -= p.val * amount;
      res(name).value += amount * (1 + getResCraftRatio(name));
      if (name === "ship") spies.shipBuilt += amount;
      if (name === "manuscript") spies.manuscriptMade += amount;
      if (name === "compedium") spies.compendiumMade += amount;
      if (name === "parchment") spies.parchmentMade += amount;
      return true;
    },
    tradeTab: { exploreBtn: { model: { prices: [{ name: "manpower", val: 1000 }] } } },
  };

  return { resources, res, crafts, buildings, techs, policies, workshopUpgrades, religionUpgrades, jobs, kittens, diplomacy, village, calendar, perTick, gamePage, spies, mutationEvents };
};

/* ------------------------------ scenario tweaks ---------------------------- */
const applyPhase = (st, phase) => {
  const { res, buildings, techs, diplomacy, gamePage } = st;
  const unlockTitanium = () => { const t = res("titanium"); t.unlocked = true; };
  const addZebras = () => diplomacy.races.push({ name: "zebras", title: "Zebras", hidden: false, unlocked: true, embassyLevel: 1, embassyPrices: [], buys: [{ name: "slab", val: 30 }], sells: [{ name: "titanium", value: 1.5, chance: 15 }] });
  const addResource = (name, value, maxValue, title = null, extra = {}) => {
    const resource = R(name, value, maxValue, title || undefined, extra);
    st.resources.push(resource);
    return resource;
  };
  const isolateLateGame = () => {
    for (const building of buildings) building.unlocked = false;
    for (const technology of techs) { technology.unlocked = true; technology.researched = true; }
    for (const upgrade of st.workshopUpgrades) upgrade.researched = true;
    for (const upgrade of st.religionUpgrades) upgrade.unlocked = false;
    for (const policy of st.policies) {
      policy.researched = policy.name !== "tradition";
      policy.blocked = policy.name === "tradition";
    }
    st.calendar.festivalDays = st.calendar.daysPerSeason + 1;
    gamePage.resPool.energyProd = 1000;
    gamePage.resPool.energyCons = 0;
    gamePage.resPool.energyWinterProd = 1000;
  };

  if (phase === "early") {
    // Few kittens, tiny science cap, only the basics open, no titanium at all.
    st.kittens.length = 2;
    res("science").value = 800; res("science").maxValue = 3000;
    res("wood").value = 300; res("wood").maxValue = 1500;
    for (const t of techs) if (!["mining", "construction"].includes(t.name)) { if (!t.researched) t.unlocked = ["engineering", "writing"].includes(t.name); }
    for (const b of buildings) if (["observatory", "calciner", "mansion"].includes(b.name)) b.unlocked = false;
    st.village.getKittens = () => 8;
  } else if (phase === "mid") {
    // The base state, racing science. No titanium need yet.
  } else if (phase === "compendium") {
    // Plan must drive the compendium chain: Chemistry is affordable on science
    // but blocked on 10 compendium (← manuscript ← culture + parchment ← furs).
    // The upper chain is front-loaded (manuscript near a compendium batch,
    // parchment/culture/furs present) so the run exercises the manuscript →
    // compendium conversion that kept stalling — not a multi-hour furs grind.
    res("science").value = 61000; res("science").maxValue = 80000;
    res("compedium").value = 0; res("manuscript").value = 49; res("parchment").value = 120;
    res("furs").value = 2500; res("culture").value = 4000; res("culture").maxValue = 9000;
    // Retire rival buildings/techs so Chemistry is the clear focus.
    for (const b of buildings) b.unlocked = false;
    for (const t of techs) if (!t.researched && t.name !== "chemistry") t.unlocked = false;
    for (const u of st.workshopUpgrades) u.researched = true;
  } else if (phase === "titaniumTrap") {
    // Titanium is unlocked and EMPTY, but NO unlocked target needs it — the bot
    // must NOT run the Zebra/ship path or show a titanium hint. (regression)
    unlockTitanium();
    res("titanium").value = 0; res("titanium").maxValue = 100;
    addZebras();
    for (const b of buildings) if (["calciner", "mansion"].includes(b.name)) b.unlocked = false; // titanium sinks stay locked
    res("crafts"); // no-op guard
    st.crafts.find((c) => c.name === "alloy").unlocked = false; // no titanium craft sink
  } else if (phase === "titaniumNeeded") {
    // A titanium-blocked upgrade is the clear focus, Zebras reachable → the
    // titanium path SHOULD fire, coherently.
    unlockTitanium();
    res("titanium").value = 0; res("titanium").maxValue = 200;
    res("slab").value = 400; // pay Zebra "buys"
    addZebras();
    for (const b of buildings) b.unlocked = false;
    for (const t of techs) if (!t.researched) t.unlocked = false;
    for (const u of st.workshopUpgrades) u.researched = true;
    st.workshopUpgrades.push({ name: "titaniumSaw", label: "Titanium Saw", unlocked: true, researched: false, prices: [{ name: "titanium", val: 50 }], effects: { woodRatio: 5 } });
  } else if (phase === "oilWell") {
    // Calciner is unlocked but needs OIL — a resource with no production and no
    // recipe, made only by building the Oil Well. The bot must build the Oil
    // Well (producer) first, then the Calciner becomes reachable. (regression for
    // "focus shows Calciner with oil missing, but never builds the Oil Well")
    st.resources.push(R("oil", 0, 1500));
    const calciner = st.buildings.find((b) => b.name === "calciner");
    calciner.prices = [{ name: "steel", val: 5 }, { name: "oil", val: 50 }];
    const oilWell = { name: "oilWell", label: "Oil Well", unlocked: true, val: 0, on: 0, prices: [{ name: "scaffold", val: 5 }, { name: "iron", val: 50 }], effects: { oilPerTickBase: 0.5, oilMax: 1500 } };
    st.buildings.forEach((b) => { b.unlocked = false; });
    calciner.unlocked = true;
    st.buildings.push(oilWell);
    for (const t of st.techs) if (!t.researched) t.unlocked = false;
    for (const u of st.workshopUpgrades) u.researched = true;
    res("scaffold").value = 80; res("iron").value = 600; res("steel").value = 200;
    // Model oil: production scales with built wells, and stock accrues from them.
    const baseGetPerTick = st.gamePage.getResourcePerTick;
    st.gamePage.getResourcePerTick = (name, conv) => (name === "oil" ? oilWell.val * 0.5 : baseGetPerTick(name, conv));
    st.onTick = () => { const oil = res("oil"); oil.value = Math.min(oil.maxValue, oil.value + oilWell.val * 3); };
  } else if (phase === "space") {
    // Late game: the reservation-backed planner must now also buy SPACE PROGRAMS
    // (and time structures) through the game's own controllers — they used to be
    // KS's job and were invisible to the planner entirely.
    res("science").value = 90000; res("science").maxValue = 130000;
    st.resources.push(R("starchart", 600, 2000));
    for (const b of st.buildings) b.unlocked = false;
    for (const t of st.techs) if (!t.researched) t.unlocked = false;
    for (const u of st.workshopUpgrades) u.researched = true;
    const programs = [
      { name: "orbitalLaunch", label: "Orbital Launch", unlocked: true, noStackable: true, val: 0, on: 0, prices: [{ name: "starchart", val: 325 }, { name: "science", val: 50000 }], unlocks: { planet: ["cath"] }, effects: {} },
    ];
    const cathBuildings = [
      { name: "sattelite", label: "Satellite", unlocked: true, val: 0, on: 0, priceRatio: 1.08, prices: [{ name: "starchart", val: 325 }, { name: "science", val: 50000 }], effects: { scienceMax: 5000, scienceRatio: 0.05 } },
      { name: "spaceElevator", label: "Space Elevator", unlocked: true, val: 0, on: 0, priceRatio: 1.15, prices: [{ name: "science", val: 75000 }, { name: "titanium", val: 50 }], effects: { prodTransferBonus: 1 } },
    ];
    const planets = [{ name: "cath", label: "Cath", unlocked: true, reached: true, routeDays: 0, buildings: cathBuildings }];
    st.gamePage.space = {
      programs,
      planets,
      getProgram: (id) => programs.find((p) => p.name === id),
      getBuilding: (id) => cathBuildings.find((p) => p.name === id),
    };
    st.onTick = () => { const sc = res("starchart"); sc.value = Math.min(sc.maxValue, sc.value + 8); };
  } else if (phase === "dragonUranium") {
    // A first Lunar Outpost is the active Space frontier, but its uranium
    // bill has no passive source. The unified route must fund one bounded
    // Dragon batch, keep the Space item as the plan, then purchase it.
    isolateLateGame();
    addResource("uranium", 0, 100, "Uranium", { unlocked: false });
    addResource("unobtainium", 0, 100, "Unobtainium");
    res("science").value = 1000; res("science").maxValue = 1000;
    res("manpower").value = 800; res("manpower").maxValue = 1000;
    res("gold").value = 500; res("gold").maxValue = 500;
    res("titanium").value = 1000; res("titanium").maxValue = 2000; res("titanium").unlocked = true;
    const dragons = {
      name: "dragons", title: "Dragons", hidden: false, unlocked: true,
      embassyLevel: 5, embassyPrices: [], standing: 0, energy: 0,
      buys: [{ name: "titanium", val: 5 }],
      sells: [{ name: "uranium", value: 2, chance: 0.95, width: 0 }],
    };
    diplomacy.races.push(dragons);
    const lunarOutpost = {
      name: "lunarOutpostE2E", label: "Lunar Outpost E2E", unlocked: true,
      val: 0, on: 0, priceRatio: 10,
      prices: [{ name: "uranium", val: 8 }],
      effects: { uraniumPerTickCon: -0.01, unobtainiumPerTickSpace: 0.01 },
    };
    const moon = { name: "moonE2E", label: "Moon E2E", unlocked: true, reached: true, routeDays: 0, buildings: [lunarOutpost] };
    gamePage.space = {
      programs: [], planets: [moon],
      getProgram: () => null,
      getBuilding: (id) => moon.buildings.find((building) => building.name === id),
    };
    st.lateGame = { dragons, lunarOutpost };
  } else if (phase === "uraniumUnobtainium") {
    isolateLateGame();
    addResource("uranium", 0, 100, "Uranium");
    addResource("unobtainium", 0, 100, "Unobtainium");
    res("science").value = 500; res("science").maxValue = 500;
    const planetCracker = {
      name: "planetCrackerE2E", label: "Planet Cracker E2E", unlocked: true,
      val: 0, on: 0, priceRatio: 100,
      prices: [{ name: "science", val: 10 }],
      effects: { uraniumPerTickSpace: 1, uraniumMax: 100 },
    };
    const lunarOutpost = {
      name: "lunarOutpostLoopE2E", label: "Lunar Outpost Loop E2E", unlocked: true,
      val: 0, on: 0, priceRatio: 100,
      prices: [{ name: "uranium", val: 20 }],
      effects: { uraniumPerTickCon: -0.1, unobtainiumPerTickSpace: 1 },
    };
    const moonBase = {
      name: "moonBaseE2E", label: "Moon Base E2E", unlocked: true,
      val: 0, on: 0, priceRatio: 100,
      prices: [{ name: "unobtainium", val: 12 }],
      effects: { unobtainiumMax: 100 },
    };
    const dune = { name: "duneE2E", label: "Dune E2E", unlocked: true, reached: true, routeDays: 0, buildings: [planetCracker] };
    const moon = { name: "moonLoopE2E", label: "Moon Loop E2E", unlocked: true, reached: true, routeDays: 0, buildings: [lunarOutpost, moonBase] };
    gamePage.space = {
      programs: [], planets: [dune, moon],
      getProgram: () => null,
      getBuilding: (id) => [planetCracker, lunarOutpost, moonBase].find((building) => building.name === id),
    };
    st.onTick = () => {
      res("uranium").value = Math.min(res("uranium").maxValue, res("uranium").value + planetCracker.on * 4);
      res("unobtainium").value = Math.min(res("unobtainium").maxValue, res("unobtainium").value + lunarOutpost.on * 3);
    };
    st.lateGame = { planetCracker, lunarOutpost, moonBase };
  } else if (phase === "antimatterContainment") {
    isolateLateGame();
    addResource("antimatter", 0, 20, "Antimatter");
    res("science").value = 500; res("science").maxValue = 500;
    const sunlifter = {
      name: "sunlifterE2E", label: "Sunlifter E2E", unlocked: true,
      val: 0, on: 0, priceRatio: 100,
      prices: [{ name: "science", val: 10 }],
      effects: { antimatterProduction: 1, energyProduction: 30 },
    };
    const heatsink = {
      name: "heatsinkE2E", label: "Heatsink E2E", unlocked: true,
      val: 0, on: 0, priceRatio: 100,
      prices: [{ name: "science", val: 10 }],
      effects: {}, upgrades: { spaceBuilding: ["containmentChamberE2E"] },
    };
    const containment = {
      name: "containmentChamberE2E", label: "Containment Chamber E2E", unlocked: false,
      val: 0, on: 0, priceRatio: 100,
      prices: [{ name: "antimatter", val: 10 }],
      effects: { antimatterMax: 50, energyConsumption: 10 },
    };
    const helios = { name: "heliosE2E", label: "Helios E2E", unlocked: true, reached: true, routeDays: 0, buildings: [sunlifter, heatsink, containment] };
    gamePage.space = {
      programs: [], planets: [helios],
      getProgram: () => null,
      getBuilding: (id) => helios.buildings.find((building) => building.name === id),
    };
    st.onTick = () => {
      res("antimatter").value = Math.min(res("antimatter").maxValue, res("antimatter").value + sunlifter.on * 2);
    };
    st.lateGame = { sunlifter, heatsink, containment };
  } else if (phase === "leviathanDeparture") {
    isolateLateGame();
    addResource("timeCrystal", 0, 100, "Time Crystal");
    addResource("unobtainium", 500, 1000, "Unobtainium");
    res("manpower").value = 1000; res("manpower").maxValue = 1000;
    res("gold").value = 500; res("gold").maxValue = 500;
    const leviathans = {
      name: "leviathans", title: "Leviathans", hidden: false, unlocked: true,
      embassyLevel: 0, embassyPrices: [], standing: 0, energy: 0,
      buys: [{ name: "unobtainium", val: 10 }],
      sells: [{ name: "timeCrystal", value: 2, chance: 1, width: 0 }],
    };
    diplomacy.races.push(leviathans);
    const temporalBattery = {
      name: "temporalBatteryE2E", label: "Temporal Battery E2E", unlocked: true,
      val: 0, on: 0, priceRatio: 10,
      prices: [{ name: "timeCrystal", val: 6 }],
      effects: { temporalFluxMax: 750 },
    };
    gamePage.time = {
      chronoforgeUpgrades: [temporalBattery], voidspaceUpgrades: [],
      getCFU: (id) => id === temporalBattery.name ? temporalBattery : null,
      getVSU: () => null,
    };
    st.lateGame = { leviathans, temporalBattery, departed: false };
    st.onTick = () => {
      if (!st.lateGame.departed && temporalBattery.val > 0) {
        leviathans.unlocked = false;
        leviathans.collapsed = true;
        st.lateGame.departed = true;
      }
    };
  } else if (phase === "transcendenceUpgrade") {
    isolateLateGame();
    addResource("relic", 50, 100, "Relic");
    const blackObelisk = {
      name: "blackObeliskE2E", label: "Black Obelisk E2E", unlocked: true,
      val: 0, on: 0, priceRatio: 10,
      prices: [{ name: "relic", val: 10 }],
      effects: { solarRevolutionLimit: 0.05 },
    };
    gamePage.religion.transcendenceUpgrades = [blackObelisk];
    gamePage.religion.getTU = (id) => id === blackObelisk.name ? blackObelisk : null;
    st.lateGame = { blackObelisk };
  } else if (phase === "armedPrestige") {
    isolateLateGame();
    gamePage.religion.faith = 0;
    gamePage.religion.faithRatio = 150;
    gamePage.religion.transcendenceTier = 0;
    gamePage.religion.transcendenceUpgrades = [];
    gamePage.religion.getTU = () => null;
    gamePage.religion._getTranscendNextPrice = () => 100;
    gamePage.religion.getApocryphaResetBonus = () => 0;
    gamePage.religion.getSolarRevolutionRatio = () => 0;
    gamePage.religion.resetFaith = () => false;
    gamePage.religionTab = {
      transcendBtn: {
        model: { enabled: true, visible: true },
        controller: { updateEnabled() {}, updateVisible() {} },
        handler() {
          st.spies.transcendCalls += 1;
          const price = gamePage.religion._getTranscendNextPrice();
          if (gamePage.religion.faithRatio <= price) return false;
          gamePage.religion.faithRatio -= price;
          gamePage.religion.transcendenceTier += 1;
          st.mutationEvents.push({ action: "prestige:transcend", controller: "Religion transcend button" });
          return true;
        },
      },
    };
    st.lateGame = { prestige: true };
  } else if (phase === "voidSpace") {
    isolateLateGame();
    addResource("void", 100, 1000, "Void");
    addResource("karma", 20, 100, "Karma");
    const cryochambers = {
      name: "cryochambersE2E", label: "Cryochambers E2E", unlocked: true,
      val: 0, on: 0, priceRatio: 10,
      prices: [{ name: "karma", val: 5 }, { name: "void", val: 20 }],
      effects: { maxKittens: 1 },
    };
    gamePage.time = {
      chronoforgeUpgrades: [], voidspaceUpgrades: [cryochambers],
      getCFU: () => null,
      getVSU: (id) => id === cryochambers.name ? cryochambers : null,
    };
    st.lateGame = { cryochambers };
  } else if (phase === "freshLifecycle") {
    // A reset-shaped save deliberately retains post-reset metadata while both
    // source buildings are at zero. The helper must rebuild those sources,
    // open their families afterward, reserve every hidden Ziggurat reveal leg,
    // wait for the game's native unlock, and only then buy the ordinary build.
    const library = buildings.find((building) => building.name === "library");
    const workshop = buildings.find((building) => building.name === "workshop");
    for (const building of buildings) building.unlocked = false;
    Object.assign(library, { unlocked: true, val: 0, on: 0, prices: [{ name: "wood", val: 25 }] });
    Object.assign(workshop, { unlocked: true, val: 0, on: 0, prices: [{ name: "wood", val: 25 }, { name: "minerals", val: 25 }] });
    for (const tech of techs) if (!tech.researched) tech.unlocked = false;
    for (const upgrade of st.workshopUpgrades) upgrade.researched = true;

    const freshResearch = {
      name: "freshResearchSim", label: "Fresh Research Sim", unlocked: true, researched: false,
      prices: [{ name: "science", val: 10 }], effects: { scienceRatio: 0.01 },
    };
    const freshUpgrade = {
      name: "freshUpgradeSim", label: "Fresh Upgrade Sim", unlocked: true, researched: false,
      prices: [{ name: "freshPartSim", val: 1 }], effects: { mineralsRatio: 0.01 },
    };
    const freshPart = R("freshPartSim", 0, 0, "Fresh Part Sim");
    const megalith = R("megalithSim", 0, 0, "Megalith Sim");
    const freshCraft = { name: "freshPartSim", label: "Fresh Part Sim", unlocked: true, prices: [{ name: "wood", val: 1 }] };
    const megalithCraft = { name: "megalithSim", label: "Megalith Sim", unlocked: true, prices: [{ name: "slab", val: 1 }, { name: "beam", val: 1 }] };
    const ziggurat = {
      name: "ziggurat", label: "Ziggurat", unlocked: false, unlockable: true,
      defaultUnlockable: false, unlockRatio: 0.5, requiredTech: "construction",
      val: 0, on: 0, prices: [{ name: "scaffold", val: 1 }, { name: "blueprint", val: 1 }, { name: "megalithSim", val: 1 }], effects: {},
    };
    techs.push(freshResearch);
    st.workshopUpgrades.push(freshUpgrade);
    st.resources.push(freshPart, megalith);
    st.crafts.push(freshCraft, megalithCraft);
    buildings.push(ziggurat);
    res("wood").value = 500;
    res("minerals").value = 500;
    res("science").value = 500;
    res("scaffold").value = 3;
    res("blueprint").value = 1;
    st.lifecycle = {
      library, workshop, freshResearch, freshUpgrade, freshCraft, ziggurat, megalith,
      nativeRevealTick: null, nativeRevealBanksSatisfied: false,
    };
    st.onTick = (tick) => {
      if (!ziggurat.unlocked && megalith.value >= 0.5 && res("scaffold").value >= 0.5 && res("blueprint").value >= 0.5) {
        ziggurat.unlocked = true;
        st.lifecycle.nativeRevealTick = tick;
        st.lifecycle.nativeRevealBanksSatisfied = true;
      }
    };
  } else if (phase === "pollutionIndustry") {
    // A live industrial state is climbing toward a harmful threshold. Native
    // manager methods remain the authority; researching sequestration changes
    // the measured slope/equilibrium while the processor can shed dirty load.
    const pollution = R("cathPollution", 900, 0, "Cath Pollution");
    st.resources.push(pollution);
    for (const building of buildings) building.unlocked = false;
    for (const tech of techs) if (!tech.researched) tech.unlocked = false;
    for (const upgrade of st.workshopUpgrades) upgrade.researched = true;
    for (const policy of st.policies) {
      policy.researched = policy.name !== "tradition";
      policy.blocked = policy.name === "tradition";
    }
    for (const upgrade of st.religionUpgrades) { upgrade.on = 1; upgrade.val = 1; }
    const cleanup = {
      name: "carbonSequestrationSim", label: "Carbon Sequestration Sim", unlocked: true, researched: false,
      prices: [{ name: "science", val: 1 }], effects: { cathPollutionPerTickProd: -4 },
    };
    const dirtyFactory = {
      name: "dirtyFactorySim", label: "Dirty Factory Sim", unlocked: true, val: 3, on: 3,
      prices: [{ name: "wood", val: 1e9 }],
      effects: { mineralsPerTickCon: -0.5, ironPerTickProd: 0.01, cathPollutionPerTickProd: 0.5 },
    };
    st.workshopUpgrades.push(cleanup);
    buildings.push(dirtyFactory);
    res("science").value = Math.max(100, res("science").value);
    gamePage.bld.cathPollution = 900;
    gamePage.bld.cathPollutionPerTick = 1.5;
    gamePage.bld.pollutionLevels = [
      { threshold: 0, effects: {} },
      { threshold: 500, effects: { catnipPollutionRatio: -0.05 } },
      { threshold: 1000, effects: { catnipPollutionRatio: -0.15, happiness: -0.05 } },
    ];
    gamePage.bld.getPollutionPerTick = () => cleanup.researched ? -2 : Math.max(0.5, dirtyFactory.on * 0.5);
    gamePage.bld.getPollutionLevel = () => ({
      level: gamePage.bld.cathPollution >= 1000 ? 2 : gamePage.bld.cathPollution >= 500 ? 1 : 0,
      effects: gamePage.bld.cathPollution >= 1000
        ? { catnipPollutionRatio: -0.15, happiness: -0.05 }
        : gamePage.bld.cathPollution >= 500 ? { catnipPollutionRatio: -0.05 } : {},
    });
    gamePage.bld.getPollutionEquilibrium = () => cleanup.researched ? 400 : 1500;
    st.pollution = { resource: pollution, cleanup, dirtyFactory, minDirtyOn: dirtyFactory.on, peak: gamePage.bld.cathPollution };
    st.onTick = () => {
      const delta = gamePage.bld.getPollutionPerTick();
      gamePage.bld.cathPollution = Math.max(0, gamePage.bld.cathPollution + delta * 4);
      pollution.value = gamePage.bld.cathPollution;
      st.pollution.minDirtyOn = Math.min(st.pollution.minDirtyOn, dirtyFactory.on);
      st.pollution.peak = Math.max(st.pollution.peak, gamePage.bld.cathPollution);
    };
  }
};

/* ------------------------------- run a scenario ---------------------------- */
const runScenario = ({ name, phase, goal, ticks = TICKS, speed = 1 }) => {
  const failures = [];
  const st = makeState();
  applyPhase(st, phase);
  const { res, gamePage, spies, buildings, techs, mutationEvents } = st;
  if (gamePage.space) {
    gamePage.space.build = () => { spies.rawSpaceManagerCalls += 1; return false; };
    gamePage.space.buy = () => { spies.rawSpaceManagerCalls += 1; return false; };
  }

  const storage = new Map();
  const holdAutopilotForInitialEvidence = phase === "freshLifecycle" || phase === "pollutionIndustry";
  storage.set("kgh.goal", goal || "balanced");
  storage.set("kgh.autopilot", holdAutopilotForInitialEvidence ? "0" : "1");
  storage.set("kgh.tickSpeed", String(speed));
  if (phase === "armedPrestige") storage.set("kgh.prestigeArmed", "1");
  const localStorageMock = { getItem: (k) => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => storage.set(k, String(v)) };
  if (phase === "armedPrestige") {
    gamePage.save = () => {
      const saveData = { checkpoint: ++spies.checkpoints };
      storage.set("com.nuclearunicorn.kittengame.savedata", JSON.stringify(saveData));
      return saveData;
    };
    gamePage._saveDataToString = (saveData) => JSON.stringify(saveData);
  }
  const documentMock = { head: makeEl(), body: makeEl(), createElement: () => makeEl(), getElementById: () => null };

  let fakeNow = Date.now();
  class FakeDate extends Date { constructor(...a) { if (a.length) super(...a); else super(fakeNow); } static now() { return fakeNow; } }

  class SpaceProgramBtnController {
    constructor(game) { this.game = game; }
    fetchModel(options) {
      const metadata = this.game.space?.getProgram(options.id);
      return metadata ? { options, metadata } : null;
    }
    getPrices(model) { return model.metadata.prices || []; }
    updateEnabled() {}
    buyItem(model) {
      if (!model || model.metadata.val) return { itemBought: false };
      const prices = this.getPrices(model);
      if (prices.some((price) => (res(price.name)?.value || 0) < price.val)) return { itemBought: false };
      for (const price of prices) res(price.name).value -= price.val;
      model.metadata.val = 1;
      model.metadata.on = 0;
      for (const planetName of model.metadata.unlocks?.planet || []) {
        const planet = this.game.space.planets.find((item) => item.name === planetName);
        if (planet) planet.unlocked = true;
      }
      return { itemBought: true };
    }
  }
  class PlanetBuildingBtnController {
    constructor(game) { this.game = game; }
    fetchModel(options) {
      const metadata = this.game.space?.getBuilding(options.id);
      return metadata ? { options, metadata } : null;
    }
    getPrices(model) {
      const meta = model.metadata;
      return (meta.prices || []).map((price) => ({ ...price, val: price.val * Math.pow(meta.priceRatio || 1.15, meta.val || 0) }));
    }
    updateEnabled() {}
    buyItem(model) {
      const prices = this.getPrices(model);
      if (prices.some((price) => (res(price.name)?.value || 0) < price.val)) return { itemBought: false };
      for (const price of prices) res(price.name).value -= price.val;
      model.metadata.val = (model.metadata.val || 0) + 1;
      model.metadata.on = (model.metadata.on || 0) + 1;
      for (const buildingName of model.metadata.upgrades?.spaceBuilding || []) {
        const unlocked = this.game.space?.getBuilding(buildingName);
        if (unlocked) unlocked.unlocked = true;
      }
      spies.planetBuildingPurchases += 1;
      spies.planetBuildingPurchaseIds.push(model.metadata.name);
      mutationEvents.push({ action: `space:${model.metadata.name}`, controller: "PlanetBuildingBtnController" });
      return { itemBought: true };
    }
  }
  class LateGameStackableController {
    constructor(game) { this.game = game; }
    fetchModel(options) {
      const metadata = this.getMetadata(options.id);
      return metadata ? { options, metadata } : null;
    }
    getPrices(model) {
      const meta = model.metadata;
      return (meta.prices || []).map((price) => ({ ...price, val: price.val * Math.pow(meta.priceRatio || 1, meta.val || 0) }));
    }
    updateEnabled() {}
    buyItem(model) {
      const prices = this.getPrices(model);
      if (prices.some((price) => (res(price.name)?.value || 0) < price.val)) return { itemBought: false };
      for (const price of prices) res(price.name).value -= price.val;
      model.metadata.val = (model.metadata.val || 0) + 1;
      model.metadata.on = (model.metadata.on || 0) + 1;
      return { itemBought: true };
    }
  }
  class TranscendenceBtnController extends LateGameStackableController {
    getMetadata(id) { return this.game.religion?.getTU(id); }
    buyItem(model) {
      const result = super.buyItem(model);
      if (result.itemBought) {
        spies.transcendencePurchases += 1;
        mutationEvents.push({ action: `transcendence:${model.metadata.name}`, controller: "TranscendenceBtnController" });
      }
      return result;
    }
  }
  class ChronoforgeBtnController extends LateGameStackableController {
    getMetadata(id) { return this.game.time?.getCFU(id); }
    buyItem(model) {
      const result = super.buyItem(model);
      if (result.itemBought) {
        spies.chronoforgePurchases += 1;
        mutationEvents.push({ action: `chronoforge:${model.metadata.name}`, controller: "ChronoforgeBtnController" });
      }
      return result;
    }
  }
  class VoidSpaceBtnController extends LateGameStackableController {
    getMetadata(id) { return this.game.time?.getVSU(id); }
    buyItem(model) {
      const result = super.buyItem(model);
      if (result.itemBought) {
        spies.voidPurchases += 1;
        mutationEvents.push({ action: `voidspace:${model.metadata.name}`, controller: "VoidSpaceBtnController" });
      }
      return result;
    }
  }

  let nextTimerId = 1;
  const timers = new Map();
  const advanceTimers = (elapsedMs) => {
    // This is an unattended state simulation, not a wall-clock benchmark. A
    // four-second macrostep lets every owned lane that became due cooperate
    // once, while collapsing redundant 100 ms polls that cannot change the
    // fake game state between invocations.
    for (const [id, timer] of [...timers.entries()]) {
      timer.elapsed += elapsedMs;
      if (timer.elapsed + 1e-9 < timer.delay) continue;
      timer.elapsed %= timer.delay;
      if (timers.has(id)) timer.fn();
    }
  };
  const context = {
    console: { log() {}, warn() {}, error() {} }, Date: FakeDate, Math, JSON, Number, isFinite,
    document: documentMock, localStorage: localStorageMock, gamePage,
    setTimeout, clearTimeout,
    setInterval: (fn, delay = 1) => {
      const id = nextTimerId++;
      timers.set(id, { fn, delay: Math.max(1, Number(delay) || 1), elapsed: 0 });
      return id;
    },
    clearInterval: (id) => timers.delete(id),
    WeakMap, Map, Set, Promise, Array, Object,
    com: { nuclearunicorn: { game: { ui: { SpaceProgramBtnController } } } },
    classes: { ui: {
      TranscendenceBtnController,
      space: { PlanetBuildingBtnController },
      time: { ChronoforgeBtnController, VoidSpaceBtnController },
    } },
  };
  context.window = context;
  const sandbox = vm.createContext(context);
  vm.runInContext(body, sandbox, { filename: "kittens-game-helper.user.js" });
  const dbg = context.window.__kghDebug;

  const panel = (sel) => {
    for (const child of documentMock.body.children) if (child.selectors && child.selectors.has(sel)) return child.selectors.get(sel).textContent;
    return "";
  };
  const purchasesOf = () => buildings.reduce((s, b) => s + (b.val || 0), 0) + techs.filter((t) => t.researched).length + st.workshopUpgrades.filter((u) => u.researched).length + st.policies.filter((p) => p.researched).length;

  return new Promise((resolve) => {
    setTimeout(() => {
      const startPurchases = purchasesOf();
      let coherenceViolations = 0;
      let maxNoPurchaseGap = 0;
      let lastPurchaseTick = 0;
      let prevPurchases = startPurchases;
      const focusNames = new Set();
      const lifecycleEvents = [];
      const lifecycleSeen = new Set();
      let lifecycleViolations = 0;
      const lifecycleViolationReasons = [];
      let recoveryLayerSeen = false;
      let initialPollutionEvidence = null;
      let maxMutationOverlaps = 0;
      let mutationEventCursor = 0;
      const scopedMutationEvidence = [];
      st.scopedMutationEvidence = scopedMutationEvidence;
      const recordLifecycle = (event) => {
        if (!lifecycleSeen.has(event)) { lifecycleSeen.add(event); lifecycleEvents.push(event); }
      };
      const violateLifecycle = (tick, reason) => {
        lifecycleViolations += 1;
        lifecycleViolationReasons.push(`tick ${tick}: ${reason}`);
      };

      if (st.pollution) {
        const status = dbg.pollutionStatus?.();
        const cleanupCandidate = dbg.candidateById?.("upgrade:carbonSequestrationSim");
        const recoveryTarget = dbg.bestPollutionRecoveryTarget?.(cleanupCandidate ? [cleanupCandidate] : []);
        const initialRecovery = dbg.selectStrategicTarget?.("balanced");
        recoveryLayerSeen = /Pollution recovery/.test(initialRecovery?.layer || "");
        initialPollutionEvidence = {
          status: status && { current: status.current, perTick: status.perTick, level: status.level, equilibrium: status.equilibrium },
          cleanupGate: dbg.candidateGate?.("upgrade", st.pollution.cleanup)?.state,
          cleanupMarginal: dbg.pollutionMarginalFor?.(st.pollution.cleanup),
          recoveryTarget: recoveryTarget?.meta?.name || null,
          selectedLayer: initialRecovery?.layer || null,
          selectedTarget: initialRecovery?.target?.meta?.name || null,
        };
      }
      if (holdAutopilotForInitialEvidence) storage.set("kgh.autopilot", "1");

      for (let tick = 1; tick <= ticks; tick++) {
        fakeNow += 4000;
        // live production
        for (const [n, rate] of Object.entries(st.perTick)) {
          const r = res(n);
          if (!r || !r.maxValue) { if (r) r.value += rate * 4; continue; }
          r.value = Math.min(r.maxValue, Math.max(0, r.value + rate * 4));
        }
        if (st.lifecycle) {
          const { library, workshop, freshResearch, freshUpgrade, freshCraft, ziggurat } = st.lifecycle;
          if ((library.val || 0) <= 0 && (dbg.candidateGate?.("research", freshResearch)?.state !== "closed" || dbg.candidateById?.("research:freshResearchSim"))) violateLifecycle(tick, "research visible before Library");
          if ((workshop.val || 0) <= 0 && (
            dbg.candidateGate?.("upgrade", freshUpgrade)?.state !== "closed" ||
            dbg.candidateGate?.("craft", freshCraft)?.state !== "closed" ||
            dbg.candidateById?.("upgrade:freshUpgradeSim")
          )) violateLifecycle(tick, "upgrade/craft visible before Workshop");
          const lockedId = dbg.activeTargetId?.() || "";
          if (((library.val || 0) <= 0 && lockedId === "research:freshResearchSim") ||
              ((workshop.val || 0) <= 0 && /freshUpgradeSim|freshPartSim|ziggurat/.test(lockedId))) violateLifecycle(tick, `premature lock ${lockedId}`);
          if (!ziggurat.unlocked && dbg.candidateById?.("build:ziggurat")) violateLifecycle(tick, "ordinary Ziggurat candidate before native reveal");
        }
        if (st.onTick) st.onTick(tick);
        try { advanceTimers(4000); } catch (e) { failures.push(`${name}: timer lane threw ${e.message}`); }

        while (mutationEventCursor < mutationEvents.length) {
          const event = mutationEvents[mutationEventCursor++];
          let recentActions = "";
          try {
            const parsed = JSON.parse(localStorageMock.getItem("kgh.log") || "[]");
            recentActions = Array.isArray(parsed) ? parsed.slice(0, 4).join("\n") : "";
          } catch (error) {
            recentActions = "";
          }
          scopedMutationEvidence.push({
            ...event,
            tick,
            visible: [
              panel(".kgh-plan"), panel(".kgh-now"), panel(".kgh-buy"),
              panel(".kgh-diplomacy"), panel(".kgh-prestige-status"), recentActions,
            ].filter(Boolean).join("\n"),
          });
        }

        const scheduler = dbg.automationSchedulerSnapshot?.();
        maxMutationOverlaps = Math.max(maxMutationOverlaps, scheduler?.overlappingMutations || 0);
        if (st.lifecycle) {
          const { library, workshop, freshResearch, freshUpgrade, ziggurat, megalith } = st.lifecycle;
          if ((library.val || 0) > 0) recordLifecycle("Library");
          if ((workshop.val || 0) > 0) recordLifecycle("Workshop");
          if (freshResearch.researched) recordLifecycle("research");
          if (freshUpgrade.researched) recordLifecycle("upgrade");
          if (megalith.value > 0) recordLifecycle("Ziggurat banks");
          if (ziggurat.unlocked) recordLifecycle("native reveal");
          if ((ziggurat.val || 0) > 0) recordLifecycle("Ziggurat build");
          if (freshResearch.researched && (library.val || 0) <= 0) violateLifecycle(tick, "research bought before Library");
          if ((freshUpgrade.researched || megalith.value > 0) && (workshop.val || 0) <= 0) violateLifecycle(tick, "upgrade/craft executed before Workshop");
          if (ziggurat.unlocked && !st.lifecycle.nativeRevealBanksSatisfied) violateLifecycle(tick, "native reveal before aggregate banks");
        }
        if (st.pollution) {
          st.pollution.minDirtyOn = Math.min(st.pollution.minDirtyOn, st.pollution.dirtyFactory.on);
          const decision = dbg.selectStrategicTarget?.("balanced");
          recoveryLayerSeen ||= /Pollution recovery/.test(decision?.layer || "");
        }

        // COHERENCE: the "Now" line must never claim the titanium path while the
        // focus is non-titanium.
        const now = panel(".kgh-now");
        const plan = panel(".kgh-plan");
        if (/titanium path/i.test(now) && !/titanium/i.test(plan)) coherenceViolations += 1;
        const m = plan.match(/—\s*([^·]+?)\s*·/);
        if (m) focusNames.add(m[1].trim());

        const nowPurchases = purchasesOf();
        if (nowPurchases > prevPurchases) { lastPurchaseTick = tick; prevPurchases = nowPurchases; }
        maxNoPurchaseGap = Math.max(maxNoPurchaseGap, tick - lastPurchaseTick);
      }

      const gained = purchasesOf() - startPurchases;
      const check = (label, ok) => { if (!ok) failures.push(`${name}: ${label}`); };
      const scopedExplanationIn = (entries, action, patterns, controller = null) => entries.some((entry) =>
        entry.action === action && (!controller || entry.controller === controller) &&
        patterns.every((pattern) => pattern.test(entry.visible)));
      const scopedExplanationFor = (action, patterns, controller = null) =>
        scopedExplanationIn(scopedMutationEvidence, action, patterns, controller);
      const lateGamePhases = new Set([
        "dragonUranium", "uraniumUnobtainium", "antimatterContainment", "leviathanDeparture",
        "transcendenceUpgrade", "armedPrestige", "voidSpace",
      ]);
      const censusOnlySabotage = [{
        action: "space:lunarOutpostE2E",
        controller: "diagnostics",
        visible: "SPACE Dragons Uranium Lunar Outpost E2E built",
      }];
      if (lateGamePhases.has(phase)) {
        check(`diagnostic-census-only sabotage cannot satisfy a controller-scoped mutation explanation`,
          !scopedExplanationIn(censusOnlySabotage, "space:lunarOutpostE2E", [/Lunar Outpost E2E/i, /uranium/i], "PlanetBuildingBtnController"));
        check(`scoped mutation evidence excludes unconditional diagnostics census sections`,
          scopedMutationEvidence.length > 0 && scopedMutationEvidence.every((entry) => !/— (?:SPACE|TIME|RELIGION|TRANSCENDENCE)/i.test(entry.visible)));
      }

      // Universal invariants
      check(`display/action coherence (no titanium-path shown for a non-titanium focus) — ${coherenceViolations} violations`, coherenceViolations === 0);
      // Exclusive policies auto-adopt exactly ONE side (v2.13.0): a researched
      // side de-facto blocks its rival, so the pair can never both be bought.
      const libertyAdopted = st.policies.some((p) => p.name === "liberty" && p.researched);
      const traditionAdopted = st.policies.some((p) => p.name === "tradition" && p.researched);
      check(`exclusive policy pair never double-adopted (liberty=${libertyAdopted}, tradition=${traditionAdopted})`, !(libertyAdopted && traditionAdopted));

      // Phase-specific invariants
      if (phase === "early" || phase === "mid") {
        check(`made progress (gained ${gained} purchases)`, gained >= 3);
        check(`no off-plan Zebra trades (was ${spies.zebraTrades})`, spies.zebraTrades === 0);
        check(`no off-plan ship crafting (was ${spies.shipBuilt})`, spies.shipBuilt === 0);
      }
      if (phase === "titaniumTrap") {
        check(`NO Zebra trades for a non-titanium plan (was ${spies.zebraTrades})`, spies.zebraTrades === 0);
        check(`NO ship crafted for a non-titanium plan (was ${spies.shipBuilt})`, spies.shipBuilt === 0);
        check(`made progress despite empty titanium (gained ${gained})`, gained >= 3);
      }
      if (phase === "titaniumNeeded") {
        const fired = spies.zebraTrades > 0 || spies.shipBuilt > 0 || res("titanium").value > 0;
        check(`titanium path fires for a titanium-blocked plan (zebra=${spies.zebraTrades}, ship=${spies.shipBuilt}, Ti=${res("titanium").value.toFixed(1)})`, fired);
      }
      if (phase === "compendium") {
        check(`craft chain DRIVEN toward the plan: parchment made (${spies.parchmentMade.toFixed(1)})`, spies.parchmentMade > 0);
        check(`craft chain DRIVEN toward the plan: manuscript made (${spies.manuscriptMade.toFixed(1)})`, spies.manuscriptMade > 0);
        check(`craft chain DRIVEN toward the plan: compendium converted (${spies.compendiumMade.toFixed(1)})`, spies.compendiumMade > 0);
      }
      if (phase === "oilWell") {
        const well = buildings.find((b) => b.name === "oilWell");
        const calciner = buildings.find((b) => b.name === "calciner");
        check(`producer prerequisite built first: Oil Well val ${well.val}`, well.val > 0);
        check(`blocked target becomes reachable once its producer exists: Calciner val ${calciner.val}`, calciner.val > 0);
      }
      if (phase === "space") {
        const sat = gamePage.space.planets.flatMap((planet) => planet.buildings).find((p) => p.name === "sattelite");
        const boughtMission = gamePage.space.programs.some((p) => (p.val || 0) > 0);
        const boughtBuilding = gamePage.space.planets.some((planet) => planet.buildings.some((p) => (p.val || 0) > 0));
        const boughtAny = boughtMission || boughtBuilding;
        check(`space mission/building bought by the native planner (sattelite val ${sat.val}, any ${boughtAny})`, boughtAny);
        check(`official Space shapes preserved (missions in programs; sattelite under Cath)`, !gamePage.space.programs.some((item) => item.name === "sattelite" || item.name === "spaceElevator") && !!sat);
      }
      if (phase === "dragonUranium") {
        check(`Dragon uranium route executed (${spies.dragonTrades} trades)`, spies.dragonTrades > 0);
        check(`Dragon bootstrap purchased the uranium-gated Space frontier (Lunar Outpost ${st.lateGame.lunarOutpost.val})`, st.lateGame.lunarOutpost.val > 0);
        check(`scoped Dragon mutation tick coherently explains target, route, and action`,
          scopedExplanationFor("trade:dragons", [/Lunar Outpost E2E/i, /Dragons/i, /uranium/i], "diplomacy"));
        check(`Dragon Space purchase used the native PlanetBuilding controller`,
          spies.planetBuildingPurchases > 0 && spies.planetBuildingPurchaseIds.includes("lunarOutpostE2E") &&
          scopedExplanationFor("space:lunarOutpostE2E", [/Lunar Outpost E2E/i], "PlanetBuildingBtnController"));
        check(`Dragon Space purchase never used a generic space.build fallback`, spies.rawSpaceManagerCalls === 0);
      }
      if (phase === "uraniumUnobtainium") {
        const { planetCracker, lunarOutpost, moonBase } = st.lateGame;
        check(`Planet Cracker created the uranium path (${planetCracker.val})`, planetCracker.val > 0);
        check(`Lunar Outpost progressed uranium → unobtainium (${lunarOutpost.val})`, lunarOutpost.val > 0 && res("unobtainium").value > 0);
        check(`Moon Base consumed the new unobtainium path (${moonBase.val})`, moonBase.val > 0);
        check(`scoped Space mutation ticks explain the uranium/unobtainium dependency`,
          scopedExplanationFor("space:planetCrackerE2E", [/Lunar Outpost Loop E2E/i, /uranium/i, /Planet Cracker E2E/i], "PlanetBuildingBtnController") &&
          scopedExplanationFor("space:lunarOutpostLoopE2E", [/Lunar Outpost Loop E2E/i, /(?:buying|completed)/i], "PlanetBuildingBtnController") &&
          scopedExplanationFor("space:moonBaseE2E", [/Moon Base E2E/i, /unobtainium/i, /(?:buying|completed)/i], "PlanetBuildingBtnController"));
        check(`uranium/unobtainium Space purchases used only native PlanetBuilding controllers`,
          ["planetCrackerE2E", "lunarOutpostLoopE2E", "moonBaseE2E"].every((id) => spies.planetBuildingPurchaseIds.includes(id)) && spies.rawSpaceManagerCalls === 0);
      }
      if (phase === "antimatterContainment") {
        const { sunlifter, heatsink, containment } = st.lateGame;
        check(`Sunlifter established antimatter production (${sunlifter.val})`, sunlifter.val > 0);
        check(`Heatsink opened the containment dependency (${heatsink.val}; unlocked ${containment.unlocked})`, heatsink.val > 0 && containment.unlocked);
        check(`Containment Chamber purchased from produced antimatter (${containment.val})`, containment.val > 0);
        check(`scoped Space mutation ticks explain antimatter production and containment gate`,
          scopedExplanationFor("space:sunlifterE2E", [/Sunlifter E2E/i, /Containment Chamber E2E/i, /antimatter/i], "PlanetBuildingBtnController") &&
          scopedExplanationFor("space:containmentChamberE2E", [/Containment Chamber E2E/i, /Heatsink E2E/i, /antimatter/i, /(?:buying|completed)/i], "PlanetBuildingBtnController"));
        check(`antimatter/containment Space purchases used only native PlanetBuilding controllers`,
          ["sunlifterE2E", "heatsinkE2E", "containmentChamberE2E"].every((id) => spies.planetBuildingPurchaseIds.includes(id)) && spies.rawSpaceManagerCalls === 0);
      }
      if (phase === "leviathanDeparture") {
        const { leviathans, temporalBattery, departed } = st.lateGame;
        const departedRoute = dbg.acquisitionPathFor?.("timeCrystal", 6, { finalPurchase: true, rootRouteKinds: ["trade"] });
        check(`active Leviathans funded the native Time purchase (${spies.leviathanTrades} trades; Temporal Battery ${temporalBattery.val}; controller calls ${spies.chronoforgePurchases})`, spies.leviathanTrades > 0 && temporalBattery.val > 0 && spies.chronoforgePurchases > 0);
        check(`Leviathan departure invalidated the trade route`, departed && leviathans.unlocked === false && departedRoute?.reachable === false);
        check(`scoped Leviathan mutation tick explains time crystals → Temporal Battery`,
          scopedExplanationFor("trade:leviathans", [/Leviathans/i, /time.?crystal/i, /Temporal Battery E2E/i], "diplomacy"));
      }
      if (phase === "transcendenceUpgrade") {
        check(`native Transcendence controller purchased Black Obelisk (${st.lateGame.blackObelisk.val}; calls ${spies.transcendencePurchases})`, st.lateGame.blackObelisk.val > 0 && spies.transcendencePurchases > 0);
        check(`scoped mutation tick explains the Black Obelisk upgrade action`,
          scopedExplanationFor("transcendence:blackObeliskE2E", [/Black Obelisk E2E/i, /Transcendence/i, /(?:Plan locked|plan)/i], "TranscendenceBtnController"));
      }
      if (phase === "armedPrestige") {
        check(`persistently armed prestige executed one checkpointed Transcend`, localStorageMock.getItem("kgh.prestigeArmed") === "1" && spies.checkpoints === 1 && spies.transcendCalls === 1 && gamePage.religion.transcendenceTier === 1);
        check(`armed prestige preserved exact tier/capital postcondition`, gamePage.religion.faithRatio === 50);
        check(`scoped prestige mutation tick explains authorization, checkpoint, measured Transcend, and cooldown`,
          scopedExplanationFor("prestige:transcend", [/ARMED/i, /Prestige transcend:/i, /checkpointed/i, /cooldown/i], "Religion transcend button"));
      }
      if (phase === "voidSpace") {
        check(`native Void Space controller purchased Cryochambers (${st.lateGame.cryochambers.val}; calls ${spies.voidPurchases})`, st.lateGame.cryochambers.val > 0 && spies.voidPurchases > 0);
        check(`Void Space purchase spent the live rare-capital bill`, res("void").value < 100 && res("karma").value < 20);
        check(`scoped mutation tick explains the Cryochambers Void Space action`,
          scopedExplanationFor("voidspace:cryochambersE2E", [/Cryochambers E2E/i, /Void Space/i, /karma/i, /void/i], "VoidSpaceBtnController"));
      }

      if (phase === "freshLifecycle") {
        const eventIndex = (event) => lifecycleEvents.indexOf(event);
        check(`persisted metadata never bypassed source lifecycle (${lifecycleViolations} violations)`, lifecycleViolations === 0);
        check(`fresh Library/Workshop rebuilt (${lifecycleEvents.join(" → ")})`, eventIndex("Library") >= 0 && eventIndex("Workshop") >= 0);
        check(`research opens only after Library (${lifecycleEvents.join(" → ")})`, eventIndex("research") > eventIndex("Library"));
        check(`upgrade opens only after Workshop (${lifecycleEvents.join(" → ")})`, eventIndex("upgrade") > eventIndex("Workshop"));
        check(`Ziggurat banks open after Workshop (${lifecycleEvents.join(" → ")})`, eventIndex("Ziggurat banks") > eventIndex("Workshop"));
        check(`native Ziggurat reveal follows its aggregate banks (${lifecycleEvents.join(" → ")})`, eventIndex("native reveal") > eventIndex("Ziggurat banks"));
        check(`ordinary Ziggurat purchase follows native reveal (${lifecycleEvents.join(" → ")})`, eventIndex("Ziggurat build") >= eventIndex("native reveal") && eventIndex("Ziggurat build") >= 0);
      }
      if (phase === "pollutionIndustry") {
        const status = dbg.pollutionStatus?.();
        check(`pollution recovery layer became visible`, recoveryLayerSeen);
        check(`sequestration was purchased`, st.pollution.cleanup.researched);
        check(`native pollution slope/equilibrium became safe (delta ${status?.perTick}, equilibrium ${status?.equilibrium})`, status?.perTick < 0 && status?.equilibrium <= 500);
        check(`pollution stayed bounded (peak ${st.pollution.peak.toFixed(1)})`, st.pollution.peak < 1000);
        check(`nonessential dirty industry was throttled (${st.pollution.dirtyFactory.val} → ${st.pollution.minDirtyOn})`, st.pollution.minDirtyOn < st.pollution.dirtyFactory.val);
        check(`pollution diagnostics remain explicit`, /Pollution:.*level.*delta.*equilibrium.*threshold ETA.*clean energy.*contributors/i.test(dbg.report?.() || ""));
      }
      if (phase === "freshLifecycle" || phase === "pollutionIndustry") {
        check(`scheduler mutation lanes never overlapped (${maxMutationOverlaps})`, maxMutationOverlaps === 0);
        check(`${speed}× scheduler persisted requested speed`, dbg.automationClockSnapshot?.().requestedMultiplier === speed);
        if (speed > 1) check(`${speed}× cooperative booster advanced native ticks (${spies.boosterTicks})`, spies.boosterTicks > 0);
      }

      resolve({ name, failures, metrics: {
        gained, coherenceViolations, maxNoPurchaseGap, focusCount: focusNames.size, spies,
        lifecycleEvents, lifecycleViolations, recoveryLayerSeen, maxMutationOverlaps,
        lifecycleViolationReasons, initialPollutionEvidence, scopedMutationEvidence,
      } });
    }, 0);
  });
};

/* -------------------------------- run all ---------------------------------- */
const allScenarios = [
  { name: "early-game (balanced)", phase: "early", goal: "balanced" },
  { name: "mid-game (reach space)", phase: "mid", goal: "space" },
  { name: "titanium TRAP (plan doesn't need titanium)", phase: "titaniumTrap", goal: "balanced" },
  { name: "titanium NEEDED (plan blocked on titanium)", phase: "titaniumNeeded", goal: "production" },
  { name: "compendium craft-chain (chemistry)", phase: "compendium", goal: "space" },
  { name: "producer prerequisite (oil well → calciner)", phase: "oilWell", goal: "production" },
  { name: "late-game space programs", phase: "space", goal: "space" },
  { name: "late-game Dragon uranium bootstrap", phase: "dragonUranium", goal: "balanced" },
  { name: "late-game uranium → unobtainium Space loop", phase: "uraniumUnobtainium", goal: "balanced" },
  { name: "late-game antimatter + containment", phase: "antimatterContainment", goal: "balanced" },
  { name: "late-game active Leviathans + departure", phase: "leviathanDeparture", goal: "balanced" },
  { name: "late-game Transcendence upgrade", phase: "transcendenceUpgrade", goal: "balanced" },
  { name: "late-game explicitly armed prestige", phase: "armedPrestige", goal: "balanced" },
  { name: "late-game Void Space", phase: "voidSpace", goal: "balanced" },
  { name: "fresh lifecycle + Workshop/Ziggurat (1x)", phase: "freshLifecycle", goal: "balanced", speed: 1 },
  { name: "fresh lifecycle + Workshop/Ziggurat (50x)", phase: "freshLifecycle", goal: "balanced", speed: 50 },
  { name: "industry + pollution mitigation (1x)", phase: "pollutionIndustry", goal: "balanced", speed: 1 },
  { name: "industry + pollution mitigation (50x)", phase: "pollutionIndustry", goal: "balanced", speed: 50 },
];
const scenarioFilter = process.env.KGH_SIM_PHASE;
const scenarios = scenarioFilter
  ? allScenarios.filter((scenario) => scenario.phase === scenarioFilter || scenario.name.includes(scenarioFilter))
  : allScenarios;

console.log(`Kittens Helper Simulation — ${scenarios.length} scenarios × ${TICKS} ticks\n`);
const allFailures = [];
for (const sc of scenarios) {
  const { failures, metrics } = await runScenario(sc);
  const mark = failures.length ? "✗" : "✓";
  console.log(`${mark} ${sc.name}`);
  console.log(`    purchases +${metrics.gained} · coherence-violations ${metrics.coherenceViolations} · max no-buy gap ${metrics.maxNoPurchaseGap} · focuses ${metrics.focusCount} · zebra ${metrics.spies.zebraTrades} ship ${metrics.spies.shipBuilt} manuscript ${metrics.spies.manuscriptMade.toFixed(0)} compendium ${metrics.spies.compendiumMade.toFixed(0)}`);
  if (metrics.lifecycleEvents.length) console.log(`    lifecycle ${metrics.lifecycleEvents.join(" -> ")} · violations ${metrics.lifecycleViolations}`);
  for (const reason of metrics.lifecycleViolationReasons) console.log(`      lifecycle evidence: ${reason}`);
  if (sc.phase === "pollutionIndustry") {
    console.log(`    pollution recovery-layer ${metrics.recoveryLayerSeen} · mutation-overlaps ${metrics.maxMutationOverlaps} · booster ${metrics.spies.boosterTicks}`);
    console.log(`    pollution initial ${JSON.stringify(metrics.initialPollutionEvidence)}`);
  }
  for (const f of failures) console.log(`      → ${f}`);
  if (failures.length && metrics.scopedMutationEvidence?.length) {
    for (const entry of metrics.scopedMutationEvidence) {
      console.log(`      scoped ${entry.action} via ${entry.controller} @ tick ${entry.tick}: ${JSON.stringify(entry.visible)}`);
    }
  }
  allFailures.push(...failures);
}

console.log(`\n${"=".repeat(64)}`);
if (allFailures.length) {
  console.error(`\n✗ ${allFailures.length} simulation check(s) failed across ${scenarios.length} scenarios.`);
  process.exit(1);
}
console.log(`\n✓ All simulation scenarios passed — progression order, pollution recovery, scheduler isolation, coherence, and craft-chain drive hold across game phases.`);
