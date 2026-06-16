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
  const spies = { zebraTrades: 0, shipBuilt: 0, manuscriptMade: 0, compendiumMade: 0, parchmentMade: 0, festivals: 0 };

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
    tradeMultiple(race, amt) {
      if (race && race.name === "zebras") spies.zebraTrades += amt || 1;
      const n = amt || 1;
      // model the cost so trades can't run for free
      res("manpower").value = Math.max(0, res("manpower").value - 50 * n);
      res("gold").value = Math.max(0, res("gold").value - 15 * n);
      if (race && race.buys) for (const b of race.buys) if (res(b.name)) res(b.name).value = Math.max(0, res(b.name).value - b.val * n);
      if (race && race.name === "zebras") res("titanium").value = Math.min(res("titanium").maxValue || Infinity, res("titanium").value + n * 1.5 * 0.15);
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

  return { resources, res, crafts, buildings, techs, policies, workshopUpgrades, religionUpgrades, jobs, kittens, diplomacy, village, calendar, perTick, gamePage, spies };
};

/* ------------------------------ scenario tweaks ---------------------------- */
const applyPhase = (st, phase) => {
  const { res, buildings, techs, diplomacy } = st;
  const unlockTitanium = () => { const t = res("titanium"); t.unlocked = true; };
  const addZebras = () => diplomacy.races.push({ name: "zebras", title: "Zebras", hidden: false, unlocked: true, embassyLevel: 1, embassyPrices: [], buys: [{ name: "slab", val: 30 }], sells: [{ name: "titanium", value: 1.5, chance: 15 }] });

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
      { name: "satellite", label: "Satellite", unlocked: true, val: 0, on: 0, priceRatio: 1.08, prices: [{ name: "starchart", val: 325 }, { name: "science", val: 50000 }], effects: { scienceMax: 5000, scienceRatio: 0.05 } },
      { name: "spaceElevator", label: "Space Elevator", unlocked: true, val: 0, on: 0, priceRatio: 1.15, prices: [{ name: "science", val: 75000 }, { name: "titanium", val: 50 }], effects: { prodTransferBonus: 1 } },
    ];
    st.gamePage.space = {
      programs,
      getProgram: (id) => programs.find((p) => p.name === id),
      build(item) {
        const program = typeof item === "string" ? programs.find((p) => p.name === item) : item;
        if (!program) return false;
        for (const p of program.prices) if ((res(p.name) || {}).value < p.val) return false;
        for (const p of program.prices) res(p.name).value -= p.val;
        program.val = (program.val || 0) + 1;
        program.on = (program.on || 0) + 1;
        return true;
      },
    };
    st.onTick = () => { const sc = res("starchart"); sc.value = Math.min(sc.maxValue, sc.value + 8); };
  }
};

/* ------------------------------- run a scenario ---------------------------- */
const runScenario = ({ name, phase, goal, ticks = TICKS }) => {
  const failures = [];
  const st = makeState();
  applyPhase(st, phase);
  const { res, gamePage, spies, buildings, techs } = st;

  const storage = new Map();
  storage.set("kgh.goal", goal || "balanced");
  storage.set("kgh.autopilot", "1");
  const localStorageMock = { getItem: (k) => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => storage.set(k, String(v)) };
  const documentMock = { head: makeEl(), body: makeEl(), createElement: () => makeEl(), getElementById: () => null };

  let fakeNow = Date.now();
  class FakeDate extends Date { constructor(...a) { if (a.length) super(...a); else super(fakeNow); } static now() { return fakeNow; } }

  let tickFn = null;
  const context = {
    console: { log() {}, warn() {}, error() {} }, Date: FakeDate, Math, JSON, Number, isFinite,
    document: documentMock, localStorage: localStorageMock, gamePage,
    setTimeout, clearTimeout, setInterval: (fn) => { tickFn = fn; return 1; },
    WeakMap, Map, Set, Promise, Array, Object,
  };
  context.window = context;
  const sandbox = vm.createContext(context);
  vm.runInContext(body, sandbox, { filename: "kittens-game-helper.user.js" });

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

      for (let tick = 1; tick <= ticks; tick++) {
        fakeNow += 4000;
        // live production
        for (const [n, rate] of Object.entries(st.perTick)) {
          const r = res(n);
          if (!r || !r.maxValue) { if (r) r.value += rate * 4; continue; }
          r.value = Math.min(r.maxValue, Math.max(0, r.value + rate * 4));
        }
        if (st.onTick) st.onTick();
        if (tickFn) { try { tickFn(); } catch (e) { failures.push(`${name}: tick threw ${e.message}`); } }

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

      // Universal invariants
      check(`display/action coherence (no titanium-path shown for a non-titanium focus) — ${coherenceViolations} violations`, coherenceViolations === 0);

      // Phase-specific invariants
      if (phase === "early" || phase === "mid") {
        check(`made progress (gained ${gained} purchases)`, gained >= 3);
        check(`no off-plan Zebra trades (was ${spies.zebraTrades})`, spies.zebraTrades === 0);
        check(`no off-plan ship crafting (was ${spies.shipBuilt})`, spies.shipBuilt === 0);
      }
      if (phase === "titaniumTrap") {
        check(`NO Zebra trades for a non-titanium plan (was ${spies.zebraTrades})`, spies.zebraTrades === 0);
        check(`NO ship crafted for a non-titanium plan (was ${spies.shipBuilt})`, spies.shipBuilt === 0);
        check(`Zebra trade policy not force-adopted`, !st.policies.some((p) => /zebra/i.test(p.name) && p.researched));
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
        const sat = gamePage.space.programs.find((p) => p.name === "satellite");
        const boughtAny = gamePage.space.programs.some((p) => (p.val || 0) > 0);
        check(`space program bought by the native planner (satellite val ${sat.val}, any ${boughtAny})`, boughtAny);
        check(`space focus shown in the plan line`, /SPACE PROGRAM|Satellite|Space Elevator/i.test(panel(".kgh-plan")));
      }

      resolve({ name, failures, metrics: { gained, coherenceViolations, maxNoPurchaseGap, focusCount: focusNames.size, spies } });
    }, 0);
  });
};

/* -------------------------------- run all ---------------------------------- */
const scenarios = [
  { name: "early-game (balanced)", phase: "early", goal: "balanced" },
  { name: "mid-game (reach space)", phase: "mid", goal: "space" },
  { name: "titanium TRAP (plan doesn't need titanium)", phase: "titaniumTrap", goal: "balanced" },
  { name: "titanium NEEDED (plan blocked on titanium)", phase: "titaniumNeeded", goal: "production" },
  { name: "compendium craft-chain (chemistry)", phase: "compendium", goal: "space" },
  { name: "producer prerequisite (oil well → calciner)", phase: "oilWell", goal: "production" },
  { name: "late-game space programs", phase: "space", goal: "space" },
];

console.log(`Kittens Helper Simulation — ${scenarios.length} scenarios × ${TICKS} ticks\n`);
const allFailures = [];
for (const sc of scenarios) {
  const { failures, metrics } = await runScenario(sc);
  const mark = failures.length ? "✗" : "✓";
  console.log(`${mark} ${sc.name}`);
  console.log(`    purchases +${metrics.gained} · coherence-violations ${metrics.coherenceViolations} · max no-buy gap ${metrics.maxNoPurchaseGap} · focuses ${metrics.focusCount} · zebra ${metrics.spies.zebraTrades} ship ${metrics.spies.shipBuilt} manuscript ${metrics.spies.manuscriptMade.toFixed(0)} compendium ${metrics.spies.compendiumMade.toFixed(0)}`);
  for (const f of failures) console.log(`      → ${f}`);
  allFailures.push(...failures);
}

console.log(`\n${"=".repeat(64)}`);
if (allFailures.length) {
  console.error(`\n✗ ${allFailures.length} simulation check(s) failed across ${scenarios.length} scenarios.`);
  process.exit(1);
}
console.log(`\n✓ All simulation scenarios passed — progress, coherence, no off-plan titanium, and craft-chain drive hold across game phases.`);
