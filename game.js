// =============================================================================
// DUNGEON FORGE — game.js
// Production-grade Roguelike RPG | Phaser 3 | ECS | Turn-based
// =============================================================================
// Systems: ECS · BSP Dungeon Gen · Perlin World · FOV Shadowcast · A* AI
//          Combat + Crits · Status Effects · Loot Rarity · Crafting
//          Skill Tree · Magic System · Boss AI · IndexedDB · PWA
// =============================================================================

'use strict';

// ─────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────
const TILE = 16;          // base tile size in px
const SCALE = 3;          // pixel scale
const TS = TILE * SCALE;  // display tile size = 48px

const COLS = 50;
const ROWS = 50;
const WORLD_COLS = 80;
const WORLD_ROWS = 60;

const MAX_FLOORS = 10;

const RARITY = { COMMON:0, UNCOMMON:1, RARE:2, EPIC:3, LEGENDARY:4 };
const RARITY_NAME = ['Common','Uncommon','Rare','Epic','Legendary'];
const RARITY_COLOR = [0xaaaaaa, 0x44ff88, 0x4488ff, 0xaa44ff, 0xffd700];
const RARITY_WEIGHT = [60, 25, 10, 4, 1];

const DIR = {
  N:  { dx: 0, dy:-1 },
  S:  { dx: 0, dy: 1 },
  E:  { dx: 1, dy: 0 },
  W:  { dx:-1, dy: 0 },
  NE: { dx: 1, dy:-1 },
  NW: { dx:-1, dy:-1 },
  SE: { dx: 1, dy: 1 },
  SW: { dx:-1, dy: 1 },
};
const DIRS4 = [DIR.N, DIR.S, DIR.E, DIR.W];
const DIRS8 = Object.values(DIR);

const BIOME = { PLAINS:0, FOREST:1, DESERT:2, SNOW:3, SWAMP:4, VOLCANO:5, OCEAN:6, DUNGEON:7 };
const BIOME_COLOR = {
  0: 0x7ec850, 1: 0x2d6a2d, 2: 0xe8c87a, 3: 0xddeeff,
  4: 0x4a7a4a, 5: 0xc84a10, 6: 0x1a4888, 7: 0x2a1a3a
};
const BIOME_NAME = ['Plains','Forest','Desert','Snow','Swamp','Volcano','Ocean','Dungeon'];

// ─────────────────────────────────────────────
// SEEDED PRNG (Mulberry32)
// ─────────────────────────────────────────────
class RNG {
  constructor(seed) {
    this.seed = seed >>> 0;
    this._state = this.seed;
  }
  next() {
    let t = this._state += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  }
  int(min, max) { return Math.floor(this.next() * (max - min + 1)) + min; }
  pick(arr) { return arr[this.int(0, arr.length - 1)]; }
  shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  weightedPick(items, weights) {
    const total = weights.reduce((a,b) => a+b, 0);
    let r = this.next() * total;
    for (let i = 0; i < items.length; i++) {
      r -= weights[i];
      if (r <= 0) return items[i];
    }
    return items[items.length - 1];
  }
}

// ─────────────────────────────────────────────
// PERLIN NOISE (2D)
// ─────────────────────────────────────────────
class Perlin {
  constructor(seed = 42) {
    this.rng = new RNG(seed);
    this.p = new Uint8Array(512);
    const base = Array.from({length:256}, (_,i) => i);
    const shuffled = this.rng.shuffle(base);
    for (let i = 0; i < 256; i++) this.p[i] = this.p[i + 256] = shuffled[i];
  }
  fade(t) { return t*t*t*(t*(t*6-15)+10); }
  lerp(a,b,t) { return a + t*(b-a); }
  grad(hash, x, y) {
    const h = hash & 3;
    const u = h < 2 ? x : y, v = h < 2 ? y : x;
    return ((h & 1) ? -u : u) + ((h & 2) ? -v : v);
  }
  noise(x, y) {
    const X = Math.floor(x) & 255, Y = Math.floor(y) & 255;
    x -= Math.floor(x); y -= Math.floor(y);
    const u = this.fade(x), v = this.fade(y);
    const a = this.p[X]+Y, b = this.p[X+1]+Y;
    return this.lerp(
      this.lerp(this.grad(this.p[a], x, y),     this.grad(this.p[b], x-1, y),   u),
      this.lerp(this.grad(this.p[a+1], x, y-1), this.grad(this.p[b+1], x-1, y-1), u),
      v
    );
  }
  octave(x, y, octs=4, persist=0.5, lacun=2) {
    let val=0, amp=1, freq=1, max=0;
    for (let i=0; i<octs; i++) {
      val += this.noise(x*freq, y*freq)*amp;
      max += amp; amp *= persist; freq *= lacun;
    }
    return val/max;
  }
}

// ─────────────────────────────────────────────
// INDEXEDDB SAVE SYSTEM
// ─────────────────────────────────────────────
const DB = {
  _db: null,
  async init() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('DungeonForge', 2);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('saves'))
          db.createObjectStore('saves', { keyPath: 'slot' });
        if (!db.objectStoreNames.contains('settings'))
          db.createObjectStore('settings', { keyPath: 'key' });
      };
      req.onsuccess = e => { this._db = e.target.result; resolve(); };
      req.onerror = () => reject(req.error);
    });
  },
  async save(slot, data) {
    return new Promise((resolve, reject) => {
      const tx = this._db.transaction('saves', 'readwrite');
      tx.objectStore('saves').put({ slot, data, ts: Date.now() });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  },
  async load(slot) {
    return new Promise((resolve, reject) => {
      const tx = this._db.transaction('saves', 'readonly');
      const req = tx.objectStore('saves').get(slot);
      req.onsuccess = () => resolve(req.result ? req.result.data : null);
      req.onerror = () => reject(req.error);
    });
  },
  async listSlots() {
    return new Promise((resolve, reject) => {
      const tx = this._db.transaction('saves', 'readonly');
      const req = tx.objectStore('saves').getAll();
      req.onsuccess = () => resolve(req.result.map(r => ({ slot: r.slot, ts: r.ts })));
      req.onerror = () => reject(req.error);
    });
  },
  async delete(slot) {
    return new Promise((resolve, reject) => {
      const tx = this._db.transaction('saves', 'readwrite');
      tx.objectStore('saves').delete(slot);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }
};

// ─────────────────────────────────────────────
// ECS CORE
// ─────────────────────────────────────────────
let _eidCounter = 0;
class Entity {
  constructor(id) {
    this.id = id;
    this.components = {};
    this.tags = new Set();
  }
  add(comp) { this.components[comp.type] = comp; return this; }
  get(type) { return this.components[type] || null; }
  has(type) { return type in this.components; }
  remove(type) { delete this.components[type]; }
  tag(t) { this.tags.add(t); return this; }
  hasTag(t) { return this.tags.has(t); }
}

class World {
  constructor() {
    this.entities = new Map();
    this.systems = [];
    this.eventBus = new EventBus();
  }
  create() {
    const e = new Entity(_eidCounter++);
    this.entities.set(e.id, e);
    return e;
  }
  destroy(id) {
    this.entities.delete(id);
  }
  query(...types) {
    const result = [];
    for (const e of this.entities.values()) {
      if (types.every(t => e.has(t))) result.push(e);
    }
    return result;
  }
  queryTag(tag) {
    return [...this.entities.values()].filter(e => e.hasTag(tag));
  }
  first(...types) {
    for (const e of this.entities.values()) {
      if (types.every(t => e.has(t))) return e;
    }
    return null;
  }
  addSystem(sys) { this.systems.push(sys); }
  tick(dt) {
    for (const sys of this.systems) {
      if (sys.enabled !== false) sys.update(this, dt);
    }
  }
}

class EventBus {
  constructor() { this._listeners = {}; }
  on(event, fn) {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(fn);
    return () => this.off(event, fn);
  }
  off(event, fn) {
    if (this._listeners[event])
      this._listeners[event] = this._listeners[event].filter(f => f !== fn);
  }
  emit(event, data) {
    (this._listeners[event] || []).forEach(fn => fn(data));
  }
}

// ─────────────────────────────────────────────
// COMPONENTS
// ─────────────────────────────────────────────
const C = {
  pos: (x, y, floor=0) => ({ type:'pos', x, y, floor }),
  health: (hp, maxHp) => ({ type:'health', hp, maxHp, shield:0 }),
  stats: (atk, def, spd, mag, luk) => ({ type:'stats', atk, def, spd, mag, luk, xp:0, level:1, xpNext:100 }),
  render: (key, tint=0xffffff, depth=10) => ({ type:'render', key, tint, depth, visible:true, sprite:null }),
  actor: (faction='enemy', aiType='basic') => ({ type:'actor', faction, aiType, turn:0 }),
  inventory: () => ({ type:'inventory', items:[], maxSize:20, gold:0 }),
  equipment: () => ({ type:'equipment', weapon:null, armor:null, ring:null, amulet:null }),
  skills: () => ({ type:'skills', known:[], active:null, points:0, tree:{} }),
  status: () => ({ type:'status', effects:[] }),
  fov: (radius=8) => ({ type:'fov', radius, visible:new Set(), explored:new Set() }),
  ai: (type='basic') => ({ type:'ai', behavior:type, state:'idle', target:null, path:[], patrol:[], patrolIdx:0, cooldowns:{} }),
  boss: (pattern='none') => ({ type:'boss', pattern, phase:1, phaseThreshold:[0.5,0.25], abilities:[], timer:0 }),
  loot: (table='common') => ({ type:'loot', table, dropChance:0.8 }),
};

// ─────────────────────────────────────────────
// ITEM DATABASE
// ─────────────────────────────────────────────
const ITEMS = {
  // ── WEAPONS ──
  rusty_dagger:    { id:'rusty_dagger',    name:'Rusty Dagger',     type:'weapon', rarity:RARITY.COMMON,    icon:'⚔',  atk:3,  mag:0,  spd:1,  desc:'An old dagger.',    price:20 },
  short_sword:     { id:'short_sword',     name:'Short Sword',      type:'weapon', rarity:RARITY.COMMON,    icon:'⚔',  atk:6,  mag:0,  spd:0,  desc:'Reliable.',         price:50 },
  long_sword:      { id:'long_sword',      name:'Long Sword',       type:'weapon', rarity:RARITY.UNCOMMON,  icon:'⚔',  atk:10, mag:0,  spd:-1, desc:'Heavy blade.',      price:120 },
  battle_axe:      { id:'battle_axe',      name:'Battle Axe',       type:'weapon', rarity:RARITY.UNCOMMON,  icon:'🪓', atk:14, mag:0,  spd:-2, desc:'Cleaver.',          price:180 },
  elven_blade:     { id:'elven_blade',     name:'Elven Blade',      type:'weapon', rarity:RARITY.RARE,      icon:'⚔',  atk:12, mag:4,  spd:2,  desc:'Magical edge.',     price:400 },
  shadowfang:      { id:'shadowfang',      name:'Shadowfang',       type:'weapon', rarity:RARITY.EPIC,      icon:'🗡', atk:18, mag:6,  spd:3,  desc:'Poisons on hit.',   price:900,  effect:'poison_on_hit' },
  dragonbane:      { id:'dragonbane',      name:'Dragonbane',       type:'weapon', rarity:RARITY.LEGENDARY, icon:'🗡', atk:25, mag:10, spd:2,  desc:'Slays dragons.',    price:2500, effect:'dragon_slayer' },
  staff_oak:       { id:'staff_oak',       name:'Oak Staff',        type:'weapon', rarity:RARITY.COMMON,    icon:'🪄', atk:2,  mag:8,  spd:0,  desc:'Channels magic.',   price:60 },
  staff_arcane:    { id:'staff_arcane',    name:'Arcane Staff',     type:'weapon', rarity:RARITY.RARE,      icon:'🪄', atk:3,  mag:16, spd:0,  desc:'+2 spell charges.',  price:500 },
  wand_fire:       { id:'wand_fire',       name:'Fire Wand',        type:'weapon', rarity:RARITY.UNCOMMON,  icon:'🪄', atk:4,  mag:12, spd:1,  desc:'Burns targets.',    price:250, effect:'burn_on_hit' },

  // ── ARMOR ──
  leather_armor:   { id:'leather_armor',   name:'Leather Armor',    type:'armor',  rarity:RARITY.COMMON,    icon:'🛡', def:3,  hp:5,   desc:'Light protection.',  price:40 },
  chain_mail:      { id:'chain_mail',      name:'Chain Mail',       type:'armor',  rarity:RARITY.UNCOMMON,  icon:'🛡', def:6,  hp:10,  desc:'Metal rings.',       price:150 },
  plate_armor:     { id:'plate_armor',     name:'Plate Armor',      type:'armor',  rarity:RARITY.RARE,      icon:'🛡', def:12, hp:20,  desc:'Heavy steel.',       price:450 },
  shadow_cloak:    { id:'shadow_cloak',    name:'Shadow Cloak',     type:'armor',  rarity:RARITY.EPIC,      icon:'🧥', def:8,  hp:15,  desc:'Evasion+20%.',       price:800, effect:'evasion' },
  dragon_scale:    { id:'dragon_scale',    name:'Dragon Scale',     type:'armor',  rarity:RARITY.LEGENDARY, icon:'🛡', def:20, hp:40,  desc:'Fireproof.',         price:3000, effect:'fire_resist' },

  // ── RINGS & AMULETS ──
  ring_str:        { id:'ring_str',        name:'Ring of Might',    type:'ring',   rarity:RARITY.UNCOMMON,  icon:'💍', atk:4,  desc:'+4 ATK',             price:200 },
  ring_mag:        { id:'ring_mag',        name:'Ring of Sorcery',  type:'ring',   rarity:RARITY.RARE,      icon:'💍', mag:6,  desc:'+6 MAG',             price:350 },
  ring_luck:       { id:'ring_luck',       name:'Ring of Fortune',  type:'ring',   rarity:RARITY.RARE,      icon:'💍', luk:10, desc:'+10 LUK',            price:400 },
  amulet_life:     { id:'amulet_life',     name:'Amulet of Life',   type:'amulet', rarity:RARITY.EPIC,      icon:'📿', hp:30,  desc:'+30 Max HP',         price:700 },
  amulet_arcane:   { id:'amulet_arcane',   name:'Arcane Amulet',    type:'amulet', rarity:RARITY.LEGENDARY, icon:'📿', mag:12, desc:'Free spell/floor.',  price:2000, effect:'free_spell' },

  // ── CONSUMABLES ──
  potion_hp_s:     { id:'potion_hp_s',     name:'Health Potion',    type:'potion', rarity:RARITY.COMMON,    icon:'🧪', heal:20, desc:'Restores 20 HP.',    price:15 },
  potion_hp_m:     { id:'potion_hp_m',     name:'Super Potion',     type:'potion', rarity:RARITY.UNCOMMON,  icon:'🧪', heal:50, desc:'Restores 50 HP.',    price:40 },
  potion_hp_l:     { id:'potion_hp_l',     name:'Max Elixir',       type:'potion', rarity:RARITY.RARE,      icon:'🧪', heal:999,desc:'Full HP restore.',   price:120 },
  antidote:        { id:'antidote',        name:'Antidote',         type:'potion', rarity:RARITY.COMMON,    icon:'💊', cure:'poison', desc:'Cures poison.', price:20 },
  remedy:          { id:'remedy',          name:'Remedy',           type:'potion', rarity:RARITY.UNCOMMON,  icon:'💊', cureAll:true, desc:'Cures all status.', price:60 },
  scroll_tp:       { id:'scroll_tp',       name:'Teleport Scroll',  type:'scroll', rarity:RARITY.UNCOMMON,  icon:'📜', effect:'teleport', desc:'Random teleport.', price:50 },
  scroll_id:       { id:'scroll_id',       name:'ID Scroll',        type:'scroll', rarity:RARITY.COMMON,    icon:'📜', effect:'identify', desc:'Identify item.',   price:30 },
  scroll_map:      { id:'scroll_map',      name:'Map Scroll',       type:'scroll', rarity:RARITY.UNCOMMON,  icon:'📜', effect:'reveal_map', desc:'Reveal floor.',  price:40 },
  bomb:            { id:'bomb',            name:'Bomb',             type:'scroll', rarity:RARITY.UNCOMMON,  icon:'💣', damage:30, aoe:2, desc:'Explosion 3x3.',    price:35 },
  food_ration:     { id:'food_ration',     name:'Food Ration',      type:'food',   rarity:RARITY.COMMON,    icon:'🍖', heal:10, desc:'Satisfying meal.',   price:8 },

  // ── SPELL TOMES ──
  tome_fireball:   { id:'tome_fireball',   name:'Tome: Fireball',   type:'tome',   rarity:RARITY.UNCOMMON,  icon:'📗', spell:'fireball',  desc:'Learn Fireball.',  price:120 },
  tome_ice:        { id:'tome_ice',        name:'Tome: Ice Spike',  type:'tome',   rarity:RARITY.UNCOMMON,  icon:'📗', spell:'ice_spike', desc:'Learn Ice Spike.',  price:120 },
  tome_lightning:  { id:'tome_lightning',  name:'Tome: Thunder',    type:'tome',   rarity:RARITY.RARE,      icon:'📗', spell:'lightning', desc:'Learn Lightning.',  price:280 },
  tome_heal:       { id:'tome_heal',       name:'Tome: Mend',       type:'tome',   rarity:RARITY.UNCOMMON,  icon:'📗', spell:'mend',      desc:'Learn Mend.',       price:100 },
  tome_blink:      { id:'tome_blink',      name:'Tome: Blink',      type:'tome',   rarity:RARITY.RARE,      icon:'📗', spell:'blink',     desc:'Learn Blink.',      price:250 },
  tome_drain:      { id:'tome_drain',      name:'Tome: Life Drain', type:'tome',   rarity:RARITY.EPIC,      icon:'📗', spell:'life_drain',desc:'Learn Life Drain.', price:600 },

  // ── CRAFTING MATERIALS ──
  iron_ore:        { id:'iron_ore',        name:'Iron Ore',         type:'material',rarity:RARITY.COMMON,   icon:'🪨', desc:'Raw iron.',          price:5 },
  magic_crystal:   { id:'magic_crystal',   name:'Magic Crystal',    type:'material',rarity:RARITY.UNCOMMON, icon:'💎', desc:'Glows faintly.',     price:30 },
  dragon_scale_f:  { id:'dragon_scale_f',  name:'Dragon Scale Frag',type:'material',rarity:RARITY.EPIC,     icon:'🐉', desc:'Fireproof.',         price:200 },
  poison_gland:    { id:'poison_gland',    name:'Poison Gland',     type:'material',rarity:RARITY.UNCOMMON, icon:'💚', desc:'From spiders.',      price:15 },
  shadow_essence:  { id:'shadow_essence',  name:'Shadow Essence',   type:'material',rarity:RARITY.RARE,     icon:'🌑', desc:'Pure darkness.',     price:80 },

  // ── KEYS ──
  dungeon_key:     { id:'dungeon_key',     name:'Dungeon Key',      type:'key',    rarity:RARITY.UNCOMMON,  icon:'🗝', desc:'Opens locked doors.', price:25 },
  boss_key:        { id:'boss_key',        name:'Boss Key',         type:'key',    rarity:RARITY.RARE,      icon:'🗝', desc:'Opens boss chamber.', price:100 },
};

// ─────────────────────────────────────────────
// LOOT TABLES
// ─────────────────────────────────────────────
const LOOT_TABLES = {
  common:    ['rusty_dagger','short_sword','leather_armor','potion_hp_s','food_ration','scroll_id','iron_ore'],
  uncommon:  ['short_sword','long_sword','chain_mail','potion_hp_m','scroll_tp','tome_fireball','tome_ice','tome_heal','antidote','ring_str','dungeon_key','magic_crystal'],
  rare:      ['battle_axe','elven_blade','plate_armor','potion_hp_l','scroll_map','ring_mag','ring_luck','tome_lightning','tome_blink','amulet_life','boss_key','poison_gland'],
  epic:      ['shadowfang','shadow_cloak','amulet_arcane','ring_mag','tome_drain','shadow_essence'],
  legendary: ['dragonbane','dragon_scale','amulet_arcane'],
  chest_common:   ['potion_hp_s','potion_hp_m','food_ration','scroll_id','iron_ore','antidote','scroll_tp'],
  chest_rare:     ['potion_hp_l','scroll_map','tome_fireball','tome_ice','magic_crystal','ring_str','long_sword','chain_mail'],
  chest_epic:     ['tome_lightning','tome_blink','elven_blade','plate_armor','ring_luck','amulet_life','shadow_essence'],
  boss:      ['shadowfang','shadow_cloak','tome_drain','tome_lightning','amulet_arcane','elven_blade','dragon_scale_f'],
  goblin:    ['rusty_dagger','food_ration','iron_ore','potion_hp_s'],
  skeleton:  ['short_sword','scroll_id','iron_ore','leather_armor'],
  orc:       ['battle_axe','chain_mail','potion_hp_m','dungeon_key'],
  mage:      ['staff_oak','tome_fireball','tome_ice','magic_crystal','scroll_tp'],
  spider:    ['poison_gland','antidote','food_ration'],
  dragon:    ['dragon_scale','dragonbane','dragon_scale_f','potion_hp_l'],
};

function rollLoot(table, rng, floor=1) {
  const items = [];
  const t = LOOT_TABLES[table] || LOOT_TABLES.common;
  const count = rng.int(1, Math.min(3, 1 + Math.floor(floor/3)));
  const candidates = rng.shuffle(t);
  for (let i = 0; i < Math.min(count, candidates.length); i++) {
    const item = { ...ITEMS[candidates[i]], count: 1, identified: false };
    items.push(item);
  }
  return items;
}

function rollRarityItem(rng, floor=1) {
  const bonus = Math.min(floor * 2, 20);
  const weights = [
    Math.max(10, RARITY_WEIGHT[0] - bonus),
    RARITY_WEIGHT[1] + bonus/2,
    RARITY_WEIGHT[2] + bonus/3,
    RARITY_WEIGHT[3] + bonus/5,
    RARITY_WEIGHT[4] + Math.floor(floor/5),
  ];
  const rarity = rng.weightedPick([0,1,2,3,4], weights);
  const pool = Object.values(ITEMS).filter(i => i.rarity === rarity);
  return pool.length > 0 ? { ...rng.pick(pool), count:1, identified:false } : null;
}

// ─────────────────────────────────────────────
// CRAFTING RECIPES
// ─────────────────────────────────────────────
const RECIPES = [
  { id:'r1', name:'Forge Iron Sword',    ingredients:{ iron_ore:3 },                         result:'short_sword',     desc:'3× Iron Ore' },
  { id:'r2', name:'Enchant Blade',       ingredients:{ short_sword:1, magic_crystal:2 },      result:'elven_blade',     desc:'Short Sword + 2× Crystal' },
  { id:'r3', name:'Poison Dagger',       ingredients:{ rusty_dagger:1, poison_gland:2 },      result:'shadowfang',      desc:'Dagger + 2× Poison Gland' },
  { id:'r4', name:'Shadow Armor',        ingredients:{ leather_armor:1, shadow_essence:2 },   result:'shadow_cloak',    desc:'Leather + 2× Shadow Essence' },
  { id:'r5', name:'Dragon Armor',        ingredients:{ chain_mail:1, dragon_scale_f:3 },      result:'dragon_scale',    desc:'Chain Mail + 3× Dragon Scale' },
  { id:'r6', name:'Max Elixir',          ingredients:{ potion_hp_m:3 },                       result:'potion_hp_l',     desc:'3× Super Potion' },
  { id:'r7', name:'Arcane Staff',        ingredients:{ staff_oak:1, magic_crystal:3 },        result:'staff_arcane',    desc:'Oak Staff + 3× Crystal' },
  { id:'r8', name:'Ring of Sorcery',     ingredients:{ magic_crystal:4, ring_str:1 },         result:'ring_mag',        desc:'4× Crystal + Ring of Might' },
  { id:'r9', name:'Mend Tome',           ingredients:{ magic_crystal:2, iron_ore:1 },         result:'tome_heal',       desc:'2× Crystal + Iron Ore' },
  { id:'r10','name':'Thunder Tome',      ingredients:{ tome_fireball:1, tome_ice:1 },         result:'tome_lightning',  desc:'Fireball + Ice Spike tomes' },
];

// ─────────────────────────────────────────────
// SPELL DATABASE
// ─────────────────────────────────────────────
const SPELLS = {
  fireball: {
    id:'fireball', name:'Fireball', icon:'🔥', mpCost:15,
    range:5, aoe:2, damage:'2d8+mag', type:'fire', effect:'burn',
    desc:'Explodes in 2-tile radius. Burns enemies.',
    color:0xff4400, particleColor:0xff8800
  },
  ice_spike: {
    id:'ice_spike', name:'Ice Spike', icon:'❄', mpCost:12,
    range:6, aoe:0, damage:'2d6+mag', type:'ice', effect:'slow',
    desc:'Pierces single target. Slows movement.',
    color:0x88ddff, particleColor:0xaaeeff
  },
  lightning: {
    id:'lightning', name:'Chain Lightning', icon:'⚡', mpCost:20,
    range:4, aoe:0, damage:'3d6+mag', type:'lightning', effect:'stun', chain:3,
    desc:'Chains to 3 nearby enemies.',
    color:0xffff00, particleColor:0xffffaa
  },
  mend: {
    id:'mend', name:'Mend', icon:'💚', mpCost:10,
    range:0, aoe:0, heal:'1d8+mag', type:'heal',
    desc:'Restore HP equal to 1d8 + MAG.',
    color:0x00ff88, particleColor:0x88ffcc
  },
  blink: {
    id:'blink', name:'Blink', icon:'✨', mpCost:8,
    range:6, aoe:0, type:'teleport',
    desc:'Teleport to target tile.',
    color:0xaa88ff, particleColor:0xddaaff
  },
  life_drain: {
    id:'life_drain', name:'Life Drain', icon:'🩸', mpCost:18,
    range:4, aoe:0, damage:'2d10+mag', type:'dark', lifesteal:0.5,
    desc:'Drains HP from target (50% returned).',
    color:0xaa0044, particleColor:0xff4488
  },
};

// ─────────────────────────────────────────────
// COMPANION DATABASE
// ─────────────────────────────────────────────
const COMPANIONS = {
  squire:    { id:'squire',    name:'Squire',          icon:'🧑', price:80,   hp:40,  atk:6,  def:3,  aiType:'melee',  range:1, color:0x4488ff, sprite:'mob_skeleton', desc:'A young swordsman. Attacks adjacent enemies.' },
  archer:    { id:'archer',   name:'Elven Archer',     icon:'🧝', price:150,  hp:30,  atk:10, def:2,  aiType:'ranged', range:5, color:0x44ff88, sprite:'mob_mage',     desc:'Shoots enemies from range.' },
  wizard:    { id:'wizard',   name:'Apprentice Mage',  icon:'🧙', price:220,  hp:25,  atk:4,  def:2,  aiType:'mage',   range:4, color:0xaa44ff, sprite:'mob_mage',     desc:'Casts Fireball every 3 turns.' },
  paladin:   { id:'paladin',  name:'Holy Paladin',     icon:'⚔',  price:300,  hp:60,  atk:8,  def:8,  aiType:'melee',  range:1, color:0xffd700, sprite:'mob_golem',    desc:'Tanks damage and heals you every 5 turns.' },
  rogue_c:   { id:'rogue_c',  name:'Rogue',            icon:'🗡', price:180,  hp:35,  atk:14, def:3,  aiType:'melee',  range:1, color:0x334455, sprite:'mob_assassin', desc:'Deals double damage from behind.' },
  golem_c:   { id:'golem_c',  name:'Stone Familiar',   icon:'🗿', price:400,  hp:100, atk:12, def:16, aiType:'melee',  range:1, color:0x888888, sprite:'mob_golem',    desc:'Powerful tank. Slow but unbreakable.' },
};

// ─────────────────────────────────────────────
// MOUNT DATABASE
// ─────────────────────────────────────────────
const MOUNTS = {
  horse:       { id:'horse',      name:'War Horse',         icon:'🐴', price:200,  stepsPerTurn:2, bonusAtk:0,  bonusDef:2,  wallWalk:false, trapImmune:false, lavaImmune:false, waterWalk:false, desc:'Move 2 tiles/turn. +2 DEF.' },
  warhorse:    { id:'warhorse',   name:'Warhorse',          icon:'🐎', price:400,  stepsPerTurn:2, bonusAtk:4,  bonusDef:4,  wallWalk:false, trapImmune:true,  lavaImmune:false, waterWalk:false, desc:'Move 2 tiles/turn. Immune to traps. +4 ATK/DEF.' },
  pegasus:     { id:'pegasus',    name:'Pegasus',           icon:'🦄', price:800,  stepsPerTurn:3, bonusAtk:0,  bonusDef:0,  wallWalk:true,  trapImmune:true,  lavaImmune:false, waterWalk:true,  desc:'Move 3 tiles/turn. Flies over walls & traps.' },
  dragon_m:    { id:'dragon_m',   name:'Dragon Mount',      icon:'🐉', price:2000, stepsPerTurn:2, bonusAtk:10, bonusDef:8,  wallWalk:false, trapImmune:true,  lavaImmune:true,  waterWalk:false, desc:'Move 2 tiles/turn. +10 ATK. Immune to traps & lava.' },
  shadow_wolf: { id:'shadow_wolf',name:'Shadow Wolf',       icon:'🐺', price:500,  stepsPerTurn:2, bonusAtk:6,  bonusDef:0,  wallWalk:false, trapImmune:true,  lavaImmune:false, waterWalk:false, desc:'Move 2 tiles/turn. +6 ATK. Immune to traps. Faster.' },
  turtle:      { id:'turtle',     name:'Iron Turtle',       icon:'🐢', price:120,  stepsPerTurn:1, bonusAtk:0,  bonusDef:12, wallWalk:false, trapImmune:true,  lavaImmune:false, waterWalk:false, desc:'Normal speed. Massive DEF bonus. Trap immune.' },
};

// ─────────────────────────────────────────────
// MARKET GOODS (dynamic pricing)
// ─────────────────────────────────────────────
const MARKET_GOODS = [
  { id:'mg_sword',    name:'Iron Sword',       icon:'⚔',  itemId:'short_sword',   basePriceRange:[40,70] },
  { id:'mg_axe',      name:'Battle Axe',       icon:'🪓', itemId:'battle_axe',    basePriceRange:[130,200] },
  { id:'mg_armor',    name:'Chain Mail',       icon:'🛡', itemId:'chain_mail',    basePriceRange:[100,170] },
  { id:'mg_ring',     name:'Ring of Might',    icon:'💍', itemId:'ring_str',      basePriceRange:[150,250] },
  { id:'mg_hp_s',     name:'Health Potion',    icon:'🧪', itemId:'potion_hp_s',   basePriceRange:[10,25] },
  { id:'mg_hp_m',     name:'Super Potion',     icon:'🧪', itemId:'potion_hp_m',   basePriceRange:[30,60] },
  { id:'mg_antidote', name:'Antidote',         icon:'💊', itemId:'antidote',      basePriceRange:[12,30] },
  { id:'mg_scroll_tp',name:'Teleport Scroll',  icon:'📜', itemId:'scroll_tp',     basePriceRange:[30,80] },
  { id:'mg_crystal',  name:'Magic Crystal',    icon:'💎', itemId:'magic_crystal', basePriceRange:[20,50] },
  { id:'mg_tome_f',   name:'Fireball Tome',    icon:'📗', itemId:'tome_fireball', basePriceRange:[80,160] },
  { id:'mg_food',     name:'Food Ration',      icon:'🍖', itemId:'food_ration',   basePriceRange:[5,15] },
  { id:'mg_bomb',     name:'Bomb',             icon:'💣', itemId:'bomb',          basePriceRange:[20,55] },
];

// Market state — prices evolve after each dungeon completion
const MarketState = {
  priceFactors: {},   // goodId -> current multiplier (0.5 – 2.0)
  marketRNG: null,
  init(seed) {
    this.marketRNG = new RNG((seed ^ 0xBEEF) >>> 0);
    // Initialise all factors to 1.0
    for (const g of MARKET_GOODS) this.priceFactors[g.id] = 1.0;
  },
  fluctuate() {
    // Called after a dungeon floor 10 completion (or after any floor for demo)
    if (!this.marketRNG) return;
    for (const g of MARKET_GOODS) {
      const delta = (this.marketRNG.next() - 0.5) * 0.4; // ±0.2
      this.priceFactors[g.id] = Math.max(0.4, Math.min(2.5,
        (this.priceFactors[g.id] || 1.0) + delta
      ));
    }
  },
  getPrice(good) {
    const [lo, hi] = good.basePriceRange;
    const base = Math.floor((lo + hi) / 2);
    return Math.max(1, Math.round(base * (this.priceFactors[good.id] || 1.0)));
  },
  getTrend(good) {
    const f = this.priceFactors[good.id] || 1.0;
    if (f > 1.3)  return { arrow:'▲', color:'#ff4444' };
    if (f < 0.7)  return { arrow:'▼', color:'#44ff88' };
    return { arrow:'●', color:'#aaaaaa' };
  }
};

// ─────────────────────────────────────────────
// SKILL TREE
// ─────────────────────────────────────────────
const SKILL_TREE = {
  // ── WARRIOR BRANCH ──
  iron_skin:    { id:'iron_skin',    name:'Iron Skin',     branch:'warrior', tier:1, icon:'🛡', cost:1, maxLvl:3, req:[], passive:true,  effect:'def+3_per_lvl',  desc:'+3 DEF per level' },
  power_strike: { id:'power_strike', name:'Power Strike',  branch:'warrior', tier:1, icon:'⚔', cost:1, maxLvl:3, req:[], passive:false, effect:'atk_boost',      desc:'Attack deals 150%+10% per lvl damage' },
  berserker:    { id:'berserker',    name:'Berserker',      branch:'warrior', tier:2, icon:'😡', cost:2, maxLvl:2, req:['iron_skin'], passive:false, effect:'berserk', desc:'Double ATK, -50% DEF for 3 turns' },
  war_cry:      { id:'war_cry',      name:'War Cry',        branch:'warrior', tier:2, icon:'📣', cost:2, maxLvl:1, req:['power_strike'], passive:false, effect:'war_cry', desc:'All enemies flee for 2 turns' },
  blade_master: { id:'blade_master', name:'Blade Master',   branch:'warrior', tier:3, icon:'⚔', cost:3, maxLvl:1, req:['berserker','power_strike'], passive:true, effect:'crit+20', desc:'+20% critical hit chance' },

  // ── MAGE BRANCH ──
  mana_well:    { id:'mana_well',    name:'Mana Well',      branch:'mage', tier:1, icon:'🔮', cost:1, maxLvl:3, req:[], passive:true,  effect:'mp+10_per_lvl',  desc:'+10 Max MP per level' },
  spell_power:  { id:'spell_power',  name:'Spell Power',    branch:'mage', tier:1, icon:'💫', cost:1, maxLvl:3, req:[], passive:true,  effect:'mag+2_per_lvl',  desc:'+2 MAG per level' },
  arcane_surge: { id:'arcane_surge', name:'Arcane Surge',   branch:'mage', tier:2, icon:'⚡', cost:2, maxLvl:2, req:['spell_power'], passive:false, effect:'arcane_surge', desc:'Next spell deals 200% damage' },
  mana_shield:  { id:'mana_shield',  name:'Mana Shield',    branch:'mage', tier:2, icon:'🛡', cost:2, maxLvl:2, req:['mana_well'], passive:false, effect:'mana_shield', desc:'Convert MP to shield (2MP=1 shield)' },
  archmage:     { id:'archmage',     name:'Archmage',        branch:'mage', tier:3, icon:'🌟', cost:3, maxLvl:1, req:['arcane_surge','mana_shield'], passive:true, effect:'free_cast_20', desc:'20% chance to cast for free' },

  // ── ROGUE BRANCH ──
  shadow_step:  { id:'shadow_step',  name:'Shadow Step',    branch:'rogue', tier:1, icon:'👤', cost:1, maxLvl:3, req:[], passive:false, effect:'blink_short',    desc:'Teleport 2 tiles away' },
  pickpocket:   { id:'pickpocket',   name:'Pickpocket',     branch:'rogue', tier:1, icon:'🤏', cost:1, maxLvl:2, req:[], passive:true,  effect:'gold+50%',       desc:'+50% gold from enemies' },
  backstab:     { id:'backstab',     name:'Backstab',       branch:'rogue', tier:2, icon:'🗡', cost:2, maxLvl:3, req:['shadow_step'], passive:false, effect:'backstab', desc:'3x damage if behind target' },
  evasion_roll: { id:'evasion_roll', name:'Evasion Roll',   branch:'rogue', tier:2, icon:'🌪', cost:2, maxLvl:2, req:['shadow_step'], passive:true,  effect:'evade+15', desc:'+15% evasion per level' },
  death_touch:  { id:'death_touch',  name:'Death Touch',    branch:'rogue', tier:3, icon:'☠', cost:3, maxLvl:1, req:['backstab','evasion_roll'], passive:false, effect:'instant_kill_5', desc:'5% instant kill chance' },

  // ── PALADIN BRANCH ──
  holy_strike:  { id:'holy_strike',  name:'Holy Strike',    branch:'paladin', tier:1, icon:'✝', cost:1, maxLvl:3, req:[], passive:false, effect:'holy_dmg',      desc:'Deal ATK+MAG holy damage' },
  lay_on_hands: { id:'lay_on_hands', name:'Lay on Hands',   branch:'paladin', tier:1, icon:'🤲', cost:1, maxLvl:3, req:[], passive:false, effect:'heal_touch',    desc:'Heal 20+MAG*3 HP' },
  divine_aura:  { id:'divine_aura',  name:'Divine Aura',    branch:'paladin', tier:2, icon:'😇', cost:2, maxLvl:2, req:['holy_strike'], passive:true, effect:'undead_resist', desc:'+50% resistance to undead' },
  smite:        { id:'smite',        name:'Smite',           branch:'paladin', tier:2, icon:'⚡', cost:2, maxLvl:2, req:['holy_strike'], passive:false, effect:'smite', desc:'Stun+triple damage vs undead' },
  resurrection: { id:'resurrection', name:'Resurrection',    branch:'paladin', tier:3, icon:'💫', cost:3, maxLvl:1, req:['lay_on_hands','divine_aura'], passive:false, effect:'revive', desc:'Revive with 50% HP (once per floor)' },
};

// ─────────────────────────────────────────────
// STATUS EFFECTS
// ─────────────────────────────────────────────
const STATUS_DEFS = {
  poison: {
    id:'poison', name:'Poison', icon:'🤢', color:0x44ff44,
    duration:5, tickDamage:3, damageType:'nature',
    desc:'Deals 3 nature dmg/turn'
  },
  burn: {
    id:'burn', name:'Burn', icon:'🔥', color:0xff6600,
    duration:3, tickDamage:5, damageType:'fire',
    desc:'Deals 5 fire dmg/turn'
  },
  frozen: {
    id:'frozen', name:'Frozen', icon:'❄', color:0xaaeeff,
    duration:2, skipTurn:true,
    desc:'Skip 2 turns'
  },
  stun: {
    id:'stun', name:'Stun', icon:'💫', color:0xffff00,
    duration:1, skipTurn:true,
    desc:'Skip 1 turn'
  },
  slow: {
    id:'slow', name:'Slow', icon:'🐌', color:0x886666,
    duration:4, spdMod:-2,
    desc:'-2 SPD for 4 turns'
  },
  blind: {
    id:'blind', name:'Blind', icon:'👁', color:0x333333,
    duration:3, fovMod:-4,
    desc:'-4 FOV radius'
  },
  bless: {
    id:'bless', name:'Blessed', icon:'✨', color:0xffffff,
    duration:8, atkMod:4, defMod:2,
    desc:'+4 ATK, +2 DEF for 8 turns'
  },
  haste: {
    id:'haste', name:'Haste', icon:'⚡', color:0xffff88,
    duration:5, spdMod:3,
    desc:'+3 SPD for 5 turns'
  },
  regen: {
    id:'regen', name:'Regenerating', icon:'💚', color:0x00ff88,
    duration:6, tickHeal:5,
    desc:'Heals 5 HP/turn'
  },
  berserk: {
    id:'berserk', name:'Berserk', icon:'😡', color:0xff2200,
    duration:3, atkMul:2, defMul:0.5,
    desc:'ATK×2, DEF×0.5'
  },
};

function applyStatus(entity, statusId, stacks=1) {
  const def = STATUS_DEFS[statusId];
  if (!def) return;
  const status = entity.get('status');
  if (!status) return;
  const existing = status.effects.find(e => e.id === statusId);
  if (existing) {
    existing.duration = Math.max(existing.duration, def.duration);
    existing.stacks = Math.min((existing.stacks||1) + stacks, 3);
  } else {
    status.effects.push({ ...def, stacks, startDur: def.duration });
  }
}

function tickStatus(entity) {
  const status = entity.get('status');
  if (!status) return { damage:0, heal:0, skip:false };
  let damage = 0, heal = 0, skip = false;
  const remove = [];
  for (const eff of status.effects) {
    if (eff.tickDamage) damage += eff.tickDamage * (eff.stacks||1);
    if (eff.tickHeal)   heal   += eff.tickHeal;
    if (eff.skipTurn)   skip   = true;
    eff.duration--;
    if (eff.duration <= 0) remove.push(eff.id);
  }
  status.effects = status.effects.filter(e => !remove.includes(e.id));
  return { damage, heal, skip, removed:remove };
}

function getStatusMods(entity) {
  const status = entity.get('status');
  if (!status) return {};
  const mods = { atkMod:0, defMod:0, spdMod:0, fovMod:0, atkMul:1, defMul:1 };
  for (const eff of status.effects) {
    if (eff.atkMod) mods.atkMod += eff.atkMod;
    if (eff.defMod) mods.defMod += eff.defMod;
    if (eff.spdMod) mods.spdMod += eff.spdMod;
    if (eff.fovMod) mods.fovMod += eff.fovMod;
    if (eff.atkMul) mods.atkMul *= eff.atkMul;
    if (eff.defMul) mods.defMul *= eff.defMul;
  }
  return mods;
}

// ─────────────────────────────────────────────
// MONSTER DATABASE
// ─────────────────────────────────────────────
const MONSTERS = {
  // ── TIER 1: Floor 1-3 ─────────────────────────────────────────
  goblin:      { id:'goblin',      name:'Goblin',          icon:'👺', hp:15,  atk:4,  def:1,  spd:2,  luk:3, xp:15,  gold:[1,5],   lootTable:'goblin',   floorRange:[1,4],  aiType:'basic',      sprite:'mob_goblin',   color:0x44ff44, rare:false },
  bat:         { id:'bat',         name:'Giant Bat',        icon:'🦇', hp:10,  atk:4,  def:0,  spd:4,  luk:3, xp:12,  gold:[0,3],   lootTable:'common',   floorRange:[1,3],  aiType:'erratic',    sprite:'mob_bat',      color:0x884488, rare:false },
  skeleton:    { id:'skeleton',    name:'Skeleton',         icon:'💀', hp:20,  atk:6,  def:2,  spd:1,  luk:2, xp:25,  gold:[2,8],   lootTable:'skeleton', floorRange:[1,5],  aiType:'basic',      sprite:'mob_skeleton', color:0xdddddd, rare:false, undead:true },
  spider:      { id:'spider',      name:'Cave Spider',      icon:'🕷', hp:12,  atk:5,  def:1,  spd:3,  luk:2, xp:20,  gold:[1,4],   lootTable:'spider',   floorRange:[1,4],  aiType:'swarm',      sprite:'mob_spider',   color:0x664400, rare:false, statusOnHit:'poison' },
  rat:         { id:'rat',         name:'Giant Rat',        icon:'🐀', hp:8,   atk:3,  def:0,  spd:3,  luk:1, xp:8,   gold:[0,2],   lootTable:'common',   floorRange:[1,2],  aiType:'swarm',      sprite:'mob_rat',      color:0x886644, rare:false },
  slime:       { id:'slime',       name:'Green Slime',      icon:'🟢', hp:18,  atk:4,  def:3,  spd:0,  luk:0, xp:18,  gold:[0,3],   lootTable:'common',   floorRange:[1,3],  aiType:'basic',      sprite:'mob_slime',    color:0x44cc44, rare:false, statusOnHit:'slow' },
  // ── TIER 2: Floor 2-6 ─────────────────────────────────────────
  orc:         { id:'orc',         name:'Orc Warrior',      icon:'👹', hp:35,  atk:9,  def:4,  spd:0,  luk:1, xp:40,  gold:[3,10],  lootTable:'orc',      floorRange:[2,6],  aiType:'aggressive', sprite:'mob_orc',      color:0x888800, rare:false },
  kobold:      { id:'kobold',      name:'Kobold Scout',     icon:'🦎', hp:14,  atk:5,  def:2,  spd:4,  luk:4, xp:22,  gold:[2,6],   lootTable:'goblin',   floorRange:[2,5],  aiType:'erratic',    sprite:'mob_kobold',   color:0x88aa22, rare:false },
  zombie:      { id:'zombie',      name:'Zombie',           icon:'🧟', hp:28,  atk:7,  def:1,  spd:-1, luk:0, xp:30,  gold:[1,5],   lootTable:'skeleton', floorRange:[2,5],  aiType:'aggressive', sprite:'mob_zombie',   color:0x668855, rare:false, undead:true, regen:1 },
  gnoll:       { id:'gnoll',       name:'Gnoll Berserker',  icon:'🐺', hp:30,  atk:10, def:3,  spd:2,  luk:2, xp:38,  gold:[3,8],   lootTable:'orc',      floorRange:[2,6],  aiType:'aggressive', sprite:'mob_gnoll',    color:0xaa8844, rare:false },
  mage_npc:    { id:'mage_npc',    name:'Dark Mage',        icon:'🧙', hp:25,  atk:3,  def:2,  spd:1,  luk:2, xp:55,  gold:[5,15],  lootTable:'mage',     floorRange:[3,7],  aiType:'ranged',     sprite:'mob_mage',     color:0xaa00ff, rare:false, spells:['fireball','ice_spike'] },
  wraith:      { id:'wraith',      name:'Wraith',           icon:'👻', hp:22,  atk:8,  def:4,  spd:3,  luk:3, xp:50,  gold:[2,8],   lootTable:'skeleton', floorRange:[3,6],  aiType:'erratic',    sprite:'mob_wraith',   color:0xaaccff, rare:false, undead:true, statusOnHit:'slow' },
  // ── TIER 3: Floor 4-8 ─────────────────────────────────────────
  troll:       { id:'troll',       name:'Cave Troll',       icon:'👺', hp:60,  atk:14, def:6,  spd:-1, luk:1, xp:80,  gold:[5,20],  lootTable:'orc',      floorRange:[4,8],  aiType:'aggressive', sprite:'mob_troll',    color:0x228822, rare:false, regen:3 },
  wyvern:      { id:'wyvern',      name:'Wyvern',           icon:'🐲', hp:50,  atk:13, def:5,  spd:3,  luk:2, xp:90,  gold:[8,20],  lootTable:'rare',     floorRange:[4,8],  aiType:'ranged',     sprite:'mob_wyvern',   color:0x228844, rare:false, spells:['fireball'] },
  orc_shaman:  { id:'orc_shaman',  name:'Orc Shaman',       icon:'👹', hp:35,  atk:6,  def:3,  spd:1,  luk:3, xp:70,  gold:[6,18],  lootTable:'mage',     floorRange:[4,7],  aiType:'ranged',     sprite:'mob_orc',      color:0x886600, rare:false, spells:['fireball','ice_spike'] },
  minotaur:    { id:'minotaur',    name:'Minotaur',         icon:'🐂', hp:75,  atk:17, def:7,  spd:0,  luk:1, xp:100, gold:[8,22],  lootTable:'orc',      floorRange:[5,8],  aiType:'aggressive', sprite:'mob_minotaur', color:0x884422, rare:false },
  assassin:    { id:'assassin',    name:'Shadow Assassin',  icon:'🥷', hp:40,  atk:16, def:5,  spd:4,  luk:6, xp:95,  gold:[10,25], lootTable:'rare',     floorRange:[4,8],  aiType:'aggressive', sprite:'mob_assassin', color:0x334455, rare:true, statusOnHit:'poison' },
  // ── TIER 4: Floor 6-10 ────────────────────────────────────────
  vampire:     { id:'vampire',     name:'Vampire',          icon:'🧛', hp:45,  atk:12, def:5,  spd:3,  luk:4, xp:90,  gold:[10,30], lootTable:'rare',     floorRange:[5,9],  aiType:'aggressive', sprite:'mob_vampire',  color:0x880000, rare:true, statusOnHit:'drain' },
  golem:       { id:'golem',       name:'Stone Golem',      icon:'🗿', hp:80,  atk:16, def:12, spd:-2, luk:0, xp:120, gold:[8,25],  lootTable:'rare',     floorRange:[5,9],  aiType:'guardian',   sprite:'mob_golem',    color:0x888888, rare:true },
  lich:        { id:'lich',        name:'Lich',             icon:'💀', hp:70,  atk:8,  def:8,  spd:1,  luk:5, xp:150, gold:[15,40], lootTable:'epic',     floorRange:[7,10], aiType:'boss_lite',  sprite:'mob_lich',     color:0xaa44ff, rare:true, undead:true, spells:['fireball','lightning','life_drain'] },
  demon:       { id:'demon',       name:'Fire Demon',       icon:'😈', hp:65,  atk:18, def:8,  spd:2,  luk:3, xp:130, gold:[12,30], lootTable:'epic',     floorRange:[7,10], aiType:'aggressive', sprite:'mob_demon',    color:0xff2200, rare:true, spells:['fireball'], statusOnHit:'burn' },
  dark_knight: { id:'dark_knight', name:'Dark Knight',      icon:'⚔',  hp:90,  atk:20, def:15, spd:1,  luk:2, xp:160, gold:[15,40], lootTable:'epic',     floorRange:[7,10], aiType:'aggressive', sprite:'mob_darknight',color:0x222244, rare:true },
  necromancer: { id:'necromancer', name:'Necromancer',      icon:'💀', hp:55,  atk:10, def:6,  spd:1,  luk:4, xp:140, gold:[12,35], lootTable:'mage',     floorRange:[6,9],  aiType:'ranged',     sprite:'mob_mage',     color:0x442266, rare:true, undead:true, spells:['life_drain','fireball'] },
  // ── BOSSES ────────────────────────────────────────────────────
  dragon:      { id:'dragon',      name:'Ancient Dragon',   icon:'🐉', hp:200, atk:28, def:18, spd:2,  luk:5, xp:500, gold:[50,150],lootTable:'dragon',   floorRange:[9,10], aiType:'boss',       sprite:'mob_dragon',   color:0xff4400, rare:false, boss:true, spells:['fireball'] },
  boss_lich:   { id:'boss_lich',   name:'Lich King',        icon:'👑', hp:300, atk:20, def:15, spd:2,  luk:8, xp:800, gold:[100,200],lootTable:'boss',    floorRange:[10,10],aiType:'boss',       sprite:'boss_lich',    color:0xffaa00, rare:false, boss:true, undead:true, spells:['lightning','life_drain','fireball'] },
};

// Difficulty scalar per floor — applied in spawnMonster
function floorDifficultyScale(floor) {
  // Exponential scaling: floor 1=1.0, floor 5=1.4, floor 10=2.0
  return 1 + (floor - 1) * 0.11;
}

function spawnMonster(world, id, x, y, floor, rng) {
  const def = MONSTERS[id];
  if (!def) return null;
  const e = world.create();
  const scale = floorDifficultyScale(floor);
  // HP: base * scale + small random variance
  const scaledHp  = Math.round(def.hp  * scale) + rng.int(-3, 3);
  const scaledAtk = Math.round(def.atk * scale);
  const scaledDef = Math.round(def.def * scale);
  e.add(C.pos(x, y, floor))
   .add(C.health(scaledHp, scaledHp))
   .add(C.stats(scaledAtk, scaledDef, def.spd, 0, def.luk))
   .add(C.render(def.sprite || 'mob_goblin', def.color))
   .add(C.actor('enemy', def.aiType))
   .add(C.ai(def.aiType))
   .add(C.status())
   .add(C.loot(def.lootTable || 'common'))
   .tag('monster').tag('actor');
  if (def.boss) e.add(C.boss(def.id)).tag('boss');
  const mon = { ...def };
  e.components.monsterDef = mon;
  if (def.undead) e.tag('undead');
  if (def.regen) e.components.regen = Math.round(def.regen * scale);
  e.gold = Math.round(rng.int(def.gold[0], def.gold[1]) * scale);
  e.xpReward = Math.round((def.xp + floor * 2) * Math.max(1, scale * 0.8));
  return e;
}

// ─────────────────────────────────────────────
// DUNGEON GENERATOR (BSP + Corridors)
// ─────────────────────────────────────────────
const TILE_TYPE = { WALL:0, FLOOR:1, DOOR:2, STAIRS_DOWN:3, STAIRS_UP:4, CHEST:5, TRAP:6, WATER:7, LAVA:8 };
const TILE_CHAR = { 0:'#', 1:'.', 2:'+', 3:'>', 4:'<', 5:'C', 6:'^', 7:'~', 8:'~' };

class BSPNode {
  constructor(x, y, w, h) {
    this.x=x; this.y=y; this.w=w; this.h=h;
    this.left=null; this.right=null;
    this.room=null;
  }
  get center() {
    if (this.room) return { x: Math.floor((this.room.x1+this.room.x2)/2), y: Math.floor((this.room.y1+this.room.y2)/2) };
    if (this.left && this.right) {
      const lc = this.left.center, rc = this.right.center;
      return { x: Math.floor((lc.x+rc.x)/2), y: Math.floor((lc.y+rc.y)/2) };
    }
    return { x: this.x + Math.floor(this.w/2), y: this.y + Math.floor(this.h/2) };
  }
}

function bspSplit(node, rng, minSize=8, depth=0) {
  if (depth > 6) return;
  const { x, y, w, h } = node;
  const canH = w > minSize*2;
  const canV = h > minSize*2;
  if (!canH && !canV) return;
  const horizontal = canV && (!canH || rng.next() < 0.5);
  if (horizontal) {
    const splitY = rng.int(minSize, h - minSize);
    node.left  = new BSPNode(x, y, w, splitY);
    node.right = new BSPNode(x, y+splitY, w, h-splitY);
  } else {
    const splitX = rng.int(minSize, w - minSize);
    node.left  = new BSPNode(x, y, splitX, h);
    node.right = new BSPNode(x+splitX, y, w-splitX, h);
  }
  bspSplit(node.left,  rng, minSize, depth+1);
  bspSplit(node.right, rng, minSize, depth+1);
}

function bspCreateRooms(node, rng) {
  if (!node.left && !node.right) {
    const padding = 2;
    const rx = node.x + padding;
    const ry = node.y + padding;
    const rw = rng.int(5, node.w - padding*2);
    const rh = rng.int(5, node.h - padding*2);
    node.room = { x1:rx, y1:ry, x2:rx+rw-1, y2:ry+rh-1 };
    return [node.room];
  }
  const rooms = [];
  if (node.left)  rooms.push(...bspCreateRooms(node.left,  rng));
  if (node.right) rooms.push(...bspCreateRooms(node.right, rng));
  return rooms;
}

function bspConnectRooms(node, tiles, rng) {
  if (!node.left || !node.right) return;
  bspConnectRooms(node.left,  tiles, rng);
  bspConnectRooms(node.right, tiles, rng);
  const a = node.left.center;
  const b = node.right.center;
  if (rng.next() < 0.5) {
    carveH(tiles, a.x, b.x, a.y);
    carveV(tiles, a.y, b.y, b.x);
  } else {
    carveV(tiles, a.y, b.y, a.x);
    carveH(tiles, a.x, b.x, b.y);
  }
}

function carveH(tiles, x1, x2, y) {
  const [lo, hi] = x1<x2 ? [x1,x2] : [x2,x1];
  for (let x = lo; x <= hi; x++) {
    if (y >= 0 && y < ROWS && x >= 0 && x < COLS)
      tiles[y][x] = TILE_TYPE.FLOOR;
  }
}
function carveV(tiles, y1, y2, x) {
  const [lo, hi] = y1<y2 ? [y1,y2] : [y2,y1];
  for (let y = lo; y <= hi; y++) {
    if (y >= 0 && y < ROWS && x >= 0 && x < COLS)
      tiles[y][x] = TILE_TYPE.FLOOR;
  }
}

function generateFloor(floor, seed) {
  const rng = new RNG(seed ^ (floor * 0x9e3779b9));
  const tiles = Array.from({length:ROWS}, () => new Uint8Array(COLS).fill(TILE_TYPE.WALL));
  const root = new BSPNode(1, 1, COLS-2, ROWS-2);
  bspSplit(root, rng, 7, 0);
  const rooms = bspCreateRooms(root, rng);
  // Carve rooms into tiles
  for (const room of rooms) {
    for (let y = room.y1; y <= room.y2; y++) {
      for (let x = room.x1; x <= room.x2; x++) {
        if (y>=0 && y<ROWS && x>=0 && x<COLS)
          tiles[y][x] = TILE_TYPE.FLOOR;
      }
    }
  }
  bspConnectRooms(root, tiles, rng);

  // Add doors where corridors meet rooms
  for (let y=1; y<ROWS-1; y++) {
    for (let x=1; x<COLS-1; x++) {
      if (tiles[y][x] === TILE_TYPE.FLOOR && rng.next() < 0.05) {
        const walls = [DIRS4.filter(d => tiles[y+d.dy]?.[x+d.dx] === TILE_TYPE.WALL).length];
        if (walls[0] === 2) tiles[y][x] = TILE_TYPE.DOOR;
      }
    }
  }

  // Place stairs
  // RULE: stairs-up = player start point (so going up lands where you came from)
  const shuffledRooms = rng.shuffle([...rooms]);
  let upRoom   = shuffledRooms[0];                          // first room  = spawn / stairs-up
  let downRoom = shuffledRooms[shuffledRooms.length - 1];   // last room   = stairs-down

  // stairs-up on the spawn tile itself
  const startX = Math.floor((upRoom.x1 + upRoom.x2) / 2);
  const startY = Math.floor((upRoom.y1 + upRoom.y2) / 2);
  tiles[startY][startX] = TILE_TYPE.STAIRS_UP;

  // stairs-down in the farthest room
  const downX = Math.floor((downRoom.x1 + downRoom.x2) / 2);
  const downY = Math.floor((downRoom.y1 + downRoom.y2) / 2);
  tiles[downY][downX] = TILE_TYPE.STAIRS_DOWN;

  // Place chests
  const chestRooms = rng.shuffle([...rooms]).slice(0, Math.min(4, rooms.length));
  const chests = [];
  for (const cr of chestRooms) {
    const cx = cr.x1 + rng.int(0, cr.x2-cr.x1);
    const cy = cr.y1 + rng.int(0, cr.y2-cr.y1);
    if (tiles[cy][cx] === TILE_TYPE.FLOOR) {
      tiles[cy][cx] = TILE_TYPE.CHEST;
      const rarity = rng.weightedPick(['chest_common','chest_rare','chest_epic'], [70,25,5]);
      chests.push({ x:cx, y:cy, rarity, opened:false });
    }
  }

  // Place traps
  const trapCount = rng.int(2, 5 + floor);
  const traps = [];
  for (let i=0; i<trapCount; i++) {
    const tx = rng.int(1, COLS-2), ty = rng.int(1, ROWS-2);
    if (tiles[ty][tx] === TILE_TYPE.FLOOR) {
      tiles[ty][tx] = TILE_TYPE.TRAP;
      traps.push({ x:tx, y:ty, triggered:false, damage: 5+floor*2 });
    }
  }

  // Place water/lava pools (deeper floors more lava)
  const poolType = floor >= 7 ? TILE_TYPE.LAVA : TILE_TYPE.WATER;
  const poolCount = rng.int(0, 3);
  for (let p=0; p<poolCount; p++) {
    const px = rng.int(5, COLS-6), py = rng.int(5, ROWS-6);
    const radius = rng.int(1, 3);
    for (let dy=-radius; dy<=radius; dy++) {
      for (let dx=-radius; dx<=radius; dx++) {
        if (dx*dx+dy*dy <= radius*radius) {
          const wx=px+dx, wy=py+dy;
          if (tiles[wy]?.[wx] === TILE_TYPE.WALL) tiles[wy][wx] = poolType;
        }
      }
    }
  }

  // Procedural room events
  const events = [];
  const eventRooms = rng.shuffle([...rooms]).slice(0, rng.int(1,3));
  for (const er of eventRooms) {
    const ex = Math.floor((er.x1+er.x2)/2);
    const ey = Math.floor((er.y1+er.y2)/2);
    const eventType = rng.pick(['shrine','merchant','altar','fountain','library','forge']);
    events.push({ x:ex, y:ey, type:eventType, used:false });
  }

  return {
    tiles, rooms, floor, seed: rng.seed,
    startX, startY,
    stairsDown: { x:downX, y:downY },
    stairsUp:   { x:startX, y:startY },
    chests, traps, events,
    monsters: [], // filled by dungeon scene
  };
}

// ─────────────────────────────────────────────
// WORLD MAP GENERATOR
// ─────────────────────────────────────────────
function generateWorldMap(seed) {
  const rng = new RNG(seed);
  const perlin = new Perlin(seed);
  const tiles = [];
  const scale = 0.05;

  for (let y=0; y<WORLD_ROWS; y++) {
    tiles[y] = [];
    for (let x=0; x<WORLD_COLS; x++) {
      const elevation = perlin.octave(x*scale, y*scale, 6, 0.5, 2);
      const moisture  = perlin.octave(x*scale+100, y*scale+100, 4, 0.5, 2);
      const heat      = perlin.octave(x*scale+200, y*scale, 3, 0.5, 2);
      let biome;
      if (elevation < -0.3)        biome = BIOME.OCEAN;
      else if (elevation < -0.1)   biome = BIOME.SWAMP;
      else if (heat > 0.3)         biome = BIOME.DESERT;
      else if (heat < -0.3)        biome = BIOME.SNOW;
      else if (elevation > 0.4)    biome = BIOME.VOLCANO;
      else if (moisture > 0.1)     biome = BIOME.FOREST;
      else                         biome = BIOME.PLAINS;
      tiles[y][x] = { biome, elevation, moisture, heat };
    }
  }

  // Place dungeon entrances
  const dungeons = [];
  const biomeWeights = { [BIOME.FOREST]:3, [BIOME.PLAINS]:2, [BIOME.DESERT]:2, [BIOME.SNOW]:2, [BIOME.VOLCANO]:1 };
  for (let i=0; i<8; i++) {
    let dx, dy, attempts=0;
    do {
      dx = rng.int(2, WORLD_COLS-3);
      dy = rng.int(2, WORLD_ROWS-3);
      attempts++;
    } while (tiles[dy][dx].biome === BIOME.OCEAN && attempts < 50);
    tiles[dy][dx].biome = BIOME.DUNGEON;
    dungeons.push({ x:dx, y:dy, id:i, name:`${BIOME_NAME[tiles[dy][dx].biome||BIOME.PLAINS]} Dungeon ${i+1}`, visited:false });
  }

  // Towns
  const towns = [];
  for (let i=0; i<4; i++) {
    let tx, ty, attempts=0;
    do {
      tx = rng.int(2, WORLD_COLS-3);
      ty = rng.int(2, WORLD_ROWS-3);
      attempts++;
    } while ((tiles[ty][tx].biome === BIOME.OCEAN || tiles[ty][tx].biome === BIOME.DUNGEON) && attempts < 50);
    towns.push({ x:tx, y:ty, id:i, name:`Town ${String.fromCharCode(65+i)}`, visited:false });
  }

  // Markets (8 spread around the map)
  const markets = [];
  const marketNames = ['Bazaar','Trading Post','Black Market','Merchant Hub','Caravan Stop','Night Market','Alchemist Row','Gem Exchange'];
  for (let i=0; i<8; i++) {
    let mx2, my2, attempts=0;
    do {
      mx2 = rng.int(3, WORLD_COLS-4);
      my2 = rng.int(3, WORLD_ROWS-4);
      attempts++;
    } while ((tiles[my2][mx2].biome === BIOME.OCEAN || tiles[my2][mx2].biome === BIOME.DUNGEON) && attempts < 60);
    markets.push({ x:mx2, y:my2, id:i, name:marketNames[i], visited:false });
  }

  // Stables (6 places to buy mounts)
  const stables = [];
  const stableNames = ['Royal Stables','Horse Ranch','Beast Tamer','Dragon Keep','Shadow Kennel','Iron Stables'];
  for (let i=0; i<6; i++) {
    let sx2, sy2, attempts=0;
    do {
      sx2 = rng.int(3, WORLD_COLS-4);
      sy2 = rng.int(3, WORLD_ROWS-4);
      attempts++;
    } while ((tiles[sy2][sx2].biome === BIOME.OCEAN || tiles[sy2][sx2].biome === BIOME.DUNGEON) && attempts < 60);
    stables.push({ x:sx2, y:sy2, id:i, name:stableNames[i], visited:false });
  }

  // Companion camps (6 places to hire companions)
  const camps = [];
  const campNames = ['Adventurers Guild','Mercenary Camp','Knight Order','Mage Academy','Rogue Den','Holy Sanctum'];
  for (let i=0; i<6; i++) {
    let cx2, cy2, attempts=0;
    do {
      cx2 = rng.int(3, WORLD_COLS-4);
      cy2 = rng.int(3, WORLD_ROWS-4);
      attempts++;
    } while ((tiles[cy2][cx2].biome === BIOME.OCEAN || tiles[cy2][cx2].biome === BIOME.DUNGEON) && attempts < 60);
    camps.push({ x:cx2, y:cy2, id:i, name:campNames[i], visited:false });
  }

  return { tiles, dungeons, towns, markets, stables, camps, seed };
}

// ─────────────────────────────────────────────
// FOV — SHADOWCASTING
// ─────────────────────────────────────────────
const FOV_OCTANTS = [
  [1,0,0,-1,0,1,1,0],
  [0,1,-1,0,1,0,0,1],
  [0,-1,-1,0,1,0,0,-1],
  [-1,0,0,1,0,-1,-1,0],
  [-1,0,0,1,0,1,1,0],
  [0,1,1,0,-1,0,0,1],
  [0,-1,1,0,-1,0,0,-1],
  [1,0,0,-1,0,-1,-1,0],
];

function computeFOV(tiles, ox, oy, radius, visible, explored) {
  visible.clear();
  visible.add(`${ox},${oy}`);
  explored.add(`${ox},${oy}`);
  for (const [xx,xy,yx,yy] in FOV_OCTANTS) {} // dummy
  // Using simple recursive shadowcasting
  function castLight(cx, cy, row, startSlope, endSlope, radius, xx, xy, yx, yy) {
    if (startSlope < endSlope) return;
    const radiusSq = radius * radius;
    let nextStartSlope = startSlope;
    for (let i = row; i <= radius; i++) {
      let blocked = false;
      for (let dx = -i, dy = -i; dx <= 0; dx++) {
        const lSlope = (dx - 0.5) / (dy + 0.5);
        const rSlope = (dx + 0.5) / (dy - 0.5);
        if (startSlope < rSlope) continue;
        if (endSlope > lSlope)   break;
        const sax = dx*xx + dy*xy;
        const say = dx*yx + dy*yy;
        const nx = cx+sax, ny = cy+say;
        if (nx<0||nx>=COLS||ny<0||ny>=ROWS) continue;
        if ((sax*sax + say*say) < radiusSq) {
          visible.add(`${nx},${ny}`);
          explored.add(`${nx},${ny}`);
        }
        const isWall = tiles[ny][nx] === TILE_TYPE.WALL;
        if (blocked) {
          if (isWall) { nextStartSlope = rSlope; continue; }
          blocked = false; startSlope = nextStartSlope;
        } else if (isWall) {
          blocked = true;
          nextStartSlope = rSlope;
          castLight(cx, cy, i+1, startSlope, lSlope, radius, xx, xy, yx, yy);
        }
      }
      if (blocked) break;
    }
  }
  for (const [xx,xy,yx,yy] of FOV_OCTANTS) {
    castLight(ox, oy, 1, 1.0, 0.0, radius, xx, xy, yx, yy);
  }
}

// ─────────────────────────────────────────────
// A* PATHFINDING
// ─────────────────────────────────────────────
function heuristic(a, b) {
  return Math.abs(a.x-b.x) + Math.abs(a.y-b.y);
}

function astar(tiles, sx, sy, ex, ey, passable, maxDist=30) {
  if (sx===ex && sy===ey) return [];
  const key = (x,y) => y*COLS+x;
  const open = new Map();
  const closed = new Set();
  const came = new Map();
  const g = new Map();
  const f = new Map();
  const start = key(sx,sy);
  g.set(start, 0);
  f.set(start, heuristic({x:sx,y:sy},{x:ex,y:ey}));
  open.set(start, {x:sx,y:sy});

  while (open.size > 0) {
    // Get node with lowest f
    let current = null, bestF = Infinity;
    for (const [k,node] of open) {
      const fv = f.get(k) ?? Infinity;
      if (fv < bestF) { bestF = fv; current = k; }
    }
    if (current === null) break;
    const curr = open.get(current);
    open.delete(current);
    if (curr.x===ex && curr.y===ey) {
      // Reconstruct path
      const path = [];
      let node = current;
      while (came.has(node)) {
        const k = node;
        const c = k % COLS, r = Math.floor(k / COLS);
        path.unshift({x:c, y:r});
        node = came.get(node);
      }
      return path;
    }
    closed.add(current);
    if (g.get(current) > maxDist) continue;
    for (const d of DIRS4) {
      const nx = curr.x+d.dx, ny = curr.y+d.dy;
      if (nx<0||nx>=COLS||ny<0||ny>=ROWS) continue;
      const nk = key(nx,ny);
      if (closed.has(nk)) continue;
      if (!passable(nx,ny)) continue;
      const ng = (g.get(current)||0) + 1;
      if (!open.has(nk) || ng < (g.get(nk)||Infinity)) {
        came.set(nk, current);
        g.set(nk, ng);
        f.set(nk, ng + heuristic({x:nx,y:ny},{x:ex,y:ey}));
        open.set(nk, {x:nx,y:ny});
      }
    }
  }
  return [];
}

// ─────────────────────────────────────────────
// COMBAT SYSTEM
// ─────────────────────────────────────────────
function rollDice(expr, rng) {
  // e.g. "2d8+5" or "1d6" or "3d6+mag"
  const match = expr.match(/(\d+)d(\d+)([+-]\d+)?/);
  if (!match) return parseInt(expr) || 0;
  const count = parseInt(match[1]);
  const sides = parseInt(match[2]);
  const bonus = match[3] ? parseInt(match[3]) : 0;
  let total = 0;
  for (let i=0; i<count; i++) total += rng.int(1,sides);
  return total + bonus;
}

function calcCombat(attacker, defender, rng, options={}) {
  const atkStats  = attacker.get('stats');
  const defStats  = defender.get('stats');
  const atkEquip  = attacker.get('equipment');
  const defEquip  = defender.get('equipment');
  const atkSkills = attacker.get('skills');

  let baseAtk = atkStats?.atk || 0;
  let baseDef = defStats?.def || 0;

  // Equipment bonuses
  if (atkEquip?.weapon) baseAtk += atkEquip.weapon.atk || 0;
  if (defEquip?.armor)  baseDef += defEquip.armor.def  || 0;
  if (atkEquip?.ring)   baseAtk += atkEquip.ring.atk   || 0;

  // Status mods
  const atkMods = getStatusMods(attacker);
  const defMods = getStatusMods(defender);
  baseAtk = Math.round(baseAtk * atkMods.atkMul) + atkMods.atkMod;
  baseDef = Math.round(baseDef * defMods.defMul) + defMods.defMod;

  // Skill: blade_master crit bonus
  let critChance = 0.05 + (atkStats?.luk || 0) * 0.01;
  if (atkSkills) {
    const bm = atkSkills.known.find(s=>s.id==='blade_master');
    if (bm) critChance += 0.20;
    const ev = atkSkills.known.find(s=>s.id==='evasion_roll');
    if (ev) critChance += ev.level * 0.15;
  }

  // Evasion
  const evasion = (defStats?.spd || 0) * 0.02;
  const evadeRoll = defEquip?.armor?.effect === 'evasion' ? 0.2 : 0;
  if (rng.next() < evasion + evadeRoll) {
    return { damage:0, crit:false, evaded:true, miss:false };
  }

  // Miss chance
  const missChance = 0.05 - (atkStats?.luk||0)*0.005;
  if (rng.next() < Math.max(0, missChance)) {
    return { damage:0, crit:false, evaded:false, miss:true };
  }

  // Base damage
  let dmg = Math.max(1, baseAtk - baseDef + rng.int(-2, 2));

  // Power strike skill
  if (options.powerStrike) dmg = Math.round(dmg * (1.5 + 0.1 * (options.powerStrikeLevel||1)));

  // Backstab
  if (options.backstab) dmg = Math.round(dmg * 3);

  // Critical hit
  const crit = rng.next() < critChance;
  if (crit) dmg = Math.round(dmg * 2.0 + rng.int(1,6));

  // Death touch
  if (atkSkills) {
    const dt = atkSkills.known.find(s=>s.id==='death_touch');
    if (dt && rng.next() < 0.05) return { damage:9999, crit:false, evaded:false, miss:false, instakill:true };
  }

  // Dragon slayer
  if (atkEquip?.weapon?.effect === 'dragon_slayer') {
    const defDef = defender.components.monsterDef;
    if (defDef?.id === 'dragon' || defDef?.id === 'boss_lich') dmg = Math.round(dmg * 2.5);
  }

  dmg = Math.max(1, dmg);

  // Status effects on hit
  if (atkEquip?.weapon?.effect === 'poison_on_hit' || defender.components.monsterDef?.statusOnHit === 'poison') {
    if (rng.next() < 0.3) applyStatus(defender, 'poison');
  }
  if (atkEquip?.weapon?.effect === 'burn_on_hit') {
    if (rng.next() < 0.25) applyStatus(defender, 'burn');
  }

  return { damage:dmg, crit, evaded:false, miss:false };
}

function applyDamage(entity, damage) {
  const hp = entity.get('health');
  if (!hp) return false;
  // Shield absorbs first
  if (hp.shield > 0) {
    const absorbed = Math.min(hp.shield, damage);
    hp.shield -= absorbed;
    damage -= absorbed;
  }
  hp.hp = Math.max(0, hp.hp - damage);
  return hp.hp <= 0;
}

function applyHeal(entity, amount) {
  const hp = entity.get('health');
  if (!hp) return 0;
  const before = hp.hp;
  hp.hp = Math.min(hp.maxHp, hp.hp + amount);
  return hp.hp - before;
}

// ─────────────────────────────────────────────
// SPELL SYSTEM
// ─────────────────────────────────────────────
function castSpell(caster, spellId, target, world, floorData, rng) {
  const spell = SPELLS[spellId];
  if (!spell) return null;
  const stats = caster.get('stats');
  const mag = stats?.mag || 0;
  const skills = caster.get('skills');
  const results = [];

  // Arcane surge doubles damage
  let damMul = 1;
  if (skills) {
    const as = skills.known.find(s=>s.id==='arcane_surge');
    if (as && as.active) { damMul = 2; as.active = false; }
    // free cast
    const am = skills.known.find(s=>s.id==='archmage');
    if (!am || rng.next() >= 0.20) {
      // deduct MP
      if (!stats.mp) stats.mp = stats.maxMp || 0;
      stats.mp = Math.max(0, stats.mp - spell.mpCost);
    }
  }

  switch(spellId) {
    case 'fireball': {
      // AOE damage around target
      const targetX = target.x, targetY = target.y;
      const monsters = world.queryTag('monster');
      for (const m of monsters) {
        const mpos = m.get('pos');
        if (!mpos) continue;
        const dist = Math.abs(mpos.x-targetX) + Math.abs(mpos.y-targetY);
        if (dist <= spell.aoe + 1) {
          const baseDmg = rollDice('2d8', rng) + mag;
          const dmg = Math.round(baseDmg * damMul);
          const dead = applyDamage(m, dmg);
          results.push({ entity:m, damage:dmg, dead });
          if (rng.next() < 0.4) applyStatus(m, 'burn');
        }
      }
      break;
    }
    case 'ice_spike': {
      if (target.entity) {
        const dmg = Math.round((rollDice('2d6', rng) + mag) * damMul);
        const dead = applyDamage(target.entity, dmg);
        results.push({ entity:target.entity, damage:dmg, dead });
        if (rng.next() < 0.5) applyStatus(target.entity, 'slow');
      }
      break;
    }
    case 'lightning': {
      const monsters = world.queryTag('monster');
      let count = 0;
      const targetPos = target;
      const sorted = monsters
        .filter(m => { const p=m.get('pos'); return p && Math.hypot(p.x-targetPos.x, p.y-targetPos.y) <= spell.range; })
        .sort((a,b) => {
          const pa=a.get('pos'), pb=b.get('pos');
          return Math.hypot(pa.x-targetPos.x,pa.y-targetPos.y) - Math.hypot(pb.x-targetPos.x,pb.y-targetPos.y);
        });
      for (const m of sorted) {
        if (count >= spell.chain) break;
        const dmg = Math.round((rollDice('3d6', rng) + mag) * damMul * (1 - count*0.2));
        const dead = applyDamage(m, dmg);
        results.push({ entity:m, damage:dmg, dead });
        if (rng.next() < 0.3) applyStatus(m, 'stun');
        count++;
      }
      break;
    }
    case 'mend': {
      const heal = rollDice('1d8', rng) + mag;
      const healed = applyHeal(caster, heal);
      results.push({ entity:caster, heal:healed });
      applyStatus(caster, 'regen');
      break;
    }
    case 'blink': {
      results.push({ teleport:true, x:target.x, y:target.y });
      break;
    }
    case 'life_drain': {
      if (target.entity) {
        const dmg = Math.round((rollDice('2d10', rng) + mag) * damMul);
        const dead = applyDamage(target.entity, dmg);
        const steal = Math.floor(dmg * spell.lifesteal);
        applyHeal(caster, steal);
        results.push({ entity:target.entity, damage:dmg, dead, lifesteal:steal });
      }
      break;
    }
  }
  return results;
}

// ─────────────────────────────────────────────
// BOSS AI PATTERNS
// ─────────────────────────────────────────────
function processBossAI(boss, bossEntity, player, world, floorData, rng) {
  const bossComp = bossEntity.get('boss');
  const bossHealth = bossEntity.get('health');
  const bossPos = bossEntity.get('pos');
  const playerPos = player.get('pos');
  if (!bossComp || !bossHealth || !bossPos || !playerPos) return null;

  const hpRatio = bossHealth.hp / bossHealth.maxHp;
  // Phase transition
  if (hpRatio < bossComp.phaseThreshold[0] && bossComp.phase === 1) {
    bossComp.phase = 2;
    applyStatus(bossEntity, 'berserk');
    return { type:'phase_change', phase:2, msg:'PHASE 2! The boss enrages!' };
  }
  if (hpRatio < bossComp.phaseThreshold[1] && bossComp.phase === 2) {
    bossComp.phase = 3;
    applyStatus(bossEntity, 'haste');
    // Summon adds
    return { type:'phase_change', phase:3, msg:'PHASE 3! The boss summons minions!', summonCount:2 };
  }

  bossComp.timer++;
  const dist = Math.abs(bossPos.x-playerPos.x) + Math.abs(bossPos.y-playerPos.y);

  // Pattern by boss type
  switch(bossComp.pattern) {
    case 'boss_lich':
      if (bossComp.timer % 3 === 0) {
        // Summon skeleton
        return { type:'summon', monster:'skeleton', count:2 };
      }
      if (bossComp.timer % 5 === 0 && dist <= 6) {
        return { type:'spell', spell:'lightning', target:{x:playerPos.x,y:playerPos.y} };
      }
      if (hpRatio < 0.3 && bossComp.timer % 7 === 0) {
        applyStatus(bossEntity, 'regen');
        return { type:'self_heal', amount:30, msg:'The Lich regenerates!' };
      }
      break;
    case 'dragon':
      if (bossComp.timer % 4 === 0 && dist <= 5) {
        return { type:'spell', spell:'fireball', target:{x:playerPos.x,y:playerPos.y}, msg:'Dragon breathes fire!' };
      }
      if (bossComp.timer % 8 === 0) {
        // Tail sweep AOE
        return { type:'aoe', range:2, damage:15+bossComp.phase*5, msg:'Dragon tail sweep!' };
      }
      break;
    default:
      if (bossComp.timer % 6 === 0) {
        return { type:'spell', spell:'fireball', target:{x:playerPos.x,y:playerPos.y} };
      }
  }
  return null;
}

// ─────────────────────────────────────────────
// SPRITE GENERATOR (Canvas-based pixel art)
// ─────────────────────────────────────────────
function generateSprites(scene) {
  const C16 = 16; // sprite size

  function makeSprite(key, drawFn) {
    const gfx = scene.textures.createCanvas(key, C16, C16);
    const ctx = gfx.getContext();
    drawFn(ctx, C16);
    gfx.refresh();
  }

  // Palette helpers
  const px = (ctx, x, y, color) => { ctx.fillStyle = color; ctx.fillRect(x, y, 1, 1); };

  // ── PLAYER ──
  makeSprite('player', (ctx) => {
    // Body
    [
      [6,2,'#f0c080'],[7,2,'#f0c080'],[8,2,'#f0c080'],// head
      [6,3,'#f0c080'],[7,3,'#f0c080'],[8,3,'#f0c080'],
      [5,4,'#3355cc'],[6,4,'#3355cc'],[7,4,'#3355cc'],[8,4,'#3355cc'],[9,4,'#3355cc'],// torso
      [5,5,'#3355cc'],[6,5,'#3355cc'],[7,5,'#3355cc'],[8,5,'#3355cc'],[9,5,'#3355cc'],
      [5,6,'#3355cc'],[6,6,'#3355cc'],[7,6,'#3355cc'],[8,6,'#3355cc'],[9,6,'#3355cc'],
      [4,4,'#f0c080'],[10,4,'#f0c080'],// arms
      [4,5,'#f0c080'],[10,5,'#f0c080'],
      [4,6,'#aaa'],[10,6,'#aaa'],// sword
      [5,7,'#223388'],[6,7,'#223388'],[8,7,'#223388'],[9,7,'#223388'],// legs
      [5,8,'#223388'],[6,8,'#223388'],[8,8,'#223388'],[9,8,'#223388'],
      [5,9,'#554400'],[6,9,'#554400'],[8,9,'#554400'],[9,9,'#554400'],// boots
    ].forEach(([x,y,c]) => px(ctx, x, y, c));
    // eyes
    px(ctx, 7, 2, '#222'); px(ctx, 8, 2, '#222');
    // hair
    for (let x=5;x<=9;x++) px(ctx, x, 1, '#8B4513');
  });

  // ── TILES ──
  makeSprite('tile_floor', (ctx) => {
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(0,0,16,16);
    // stone texture
    for (let i=0;i<8;i++) {
      const x=Math.floor(Math.random()*14)+1, y=Math.floor(Math.random()*14)+1;
      px(ctx, x, y, '#22223a');
    }
    px(ctx,0,0,'#111');px(ctx,15,0,'#111');px(ctx,0,15,'#111');px(ctx,15,15,'#111');
  });

  makeSprite('tile_wall', (ctx) => {
    ctx.fillStyle = '#2d2d4a';
    ctx.fillRect(0,0,16,16);
    // brick pattern
    ctx.fillStyle = '#222240';
    ctx.fillRect(0,0,8,7); ctx.fillRect(8,8,8,7);
    ctx.fillStyle = '#3a3a5a';
    ctx.fillRect(0,8,8,7); ctx.fillRect(8,0,8,7);
    // mortar lines
    ctx.fillStyle = '#111130';
    ctx.fillRect(0,7,16,1); ctx.fillRect(0,14,16,1);
    ctx.fillRect(8,0,1,7); ctx.fillRect(0,8,1,7); ctx.fillRect(8,8,1,7); ctx.fillRect(0,15,1,1);
  });

  makeSprite('tile_door', (ctx) => {
    ctx.fillStyle = '#4a2800';
    ctx.fillRect(3,1,10,14);
    ctx.fillStyle = '#6a3800';
    ctx.fillRect(4,2,4,12);ctx.fillRect(9,2,3,12);
    ctx.fillStyle = '#ffd700';
    ctx.fillRect(9,7,2,2);
    ctx.fillStyle = '#222';
    ctx.fillRect(2,0,12,1);ctx.fillRect(2,15,12,1);ctx.fillRect(2,0,1,16);ctx.fillRect(13,0,1,16);
  });

  makeSprite('tile_stairs_down', (ctx) => {
    ctx.fillStyle = '#2a1a3a';
    ctx.fillRect(0,0,16,16);
    ctx.fillStyle = '#5544aa';
    for (let i=0;i<4;i++) ctx.fillRect(2+i*2, 4+i*3, 12-i*2, 2);
    // arrow
    ctx.fillStyle = '#ff6b35';
    [7,8].forEach(x => {
      for(let y=2;y<8;y++) px(ctx,x,y,'#ff6b35');
    });
    [6,9].forEach(x=>px(ctx,x,7,'#ff6b35'));
    [5,10].forEach(x=>px(ctx,x,8,'#ff6b35'));
  });

  makeSprite('tile_stairs_up', (ctx) => {
    ctx.fillStyle = '#2a1a3a';
    ctx.fillRect(0,0,16,16);
    ctx.fillStyle = '#44aa55';
    for (let i=0;i<4;i++) ctx.fillRect(2+i*2, 4+i*3, 12-i*2, 2);
    ctx.fillStyle = '#88ff88';
    [7,8].forEach(x => {
      for(let y=2;y<8;y++) px(ctx,x,y,'#88ff88');
    });
    [6,9].forEach(x=>px(ctx,x,3,'#88ff88'));
    [5,10].forEach(x=>px(ctx,x,2,'#88ff88'));
  });

  makeSprite('tile_chest', (ctx) => {
    ctx.fillStyle = '#6B3A2A';
    ctx.fillRect(2,5,12,9);
    ctx.fillStyle = '#8B5A3A';
    ctx.fillRect(3,6,10,7);
    ctx.fillStyle = '#ffd700';
    ctx.fillRect(1,4,14,2);ctx.fillRect(2,5,1,9);ctx.fillRect(13,5,1,9);
    ctx.fillStyle = '#ffaa00';
    ctx.fillRect(6,8,4,3);
    ctx.fillStyle = '#ff8800';
    ctx.fillRect(7,9,2,2);
    // hinges
    ctx.fillStyle = '#888';
    px(ctx,3,4,'#888');px(ctx,12,4,'#888');
  });

  makeSprite('tile_trap', (ctx) => {
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(0,0,16,16);
    ctx.fillStyle = '#440000';
    ctx.fillRect(3,3,10,10);
    ctx.fillStyle = '#880000';
    for (let i=1;i<4;i++) {
      ctx.fillRect(3+i*2,3,1,10);
      ctx.fillRect(3,3+i*2,10,1);
    }
    ctx.fillStyle = '#ff0000';
    ctx.fillRect(7,7,2,2);
  });

  makeSprite('tile_water', (ctx) => {
    ctx.fillStyle = '#1a3a6e';
    ctx.fillRect(0,0,16,16);
    ctx.fillStyle = '#2255aa';
    for (let y=0;y<16;y+=4) ctx.fillRect(0,y,16,2);
    ctx.fillStyle = '#4488dd';
    px(ctx,3,1,'#4488dd');px(ctx,11,5,'#4488dd');px(ctx,7,9,'#4488dd');px(ctx,2,13,'#4488dd');
  });

  makeSprite('tile_lava', (ctx) => {
    ctx.fillStyle = '#330000';
    ctx.fillRect(0,0,16,16);
    ctx.fillStyle = '#882200';
    for (let i=0;i<5;i++) ctx.fillRect(i*3+1,i*2,3,3);
    ctx.fillStyle = '#ff4400';
    px(ctx,4,4,'#ff4400');px(ctx,9,8,'#ff4400');px(ctx,2,12,'#ff4400');px(ctx,13,3,'#ff4400');
    ctx.fillStyle = '#ffaa00';
    px(ctx,5,5,'#ffaa00');px(ctx,10,9,'#ffaa00');
  });

  // ── MONSTERS ──
  function monsterSprite(key, bodyColor, eyeColor, accentColor, drawExtra) {
    makeSprite(key, (ctx) => {
      // Shadow
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.fillRect(4,13,8,2);
      // Body
      ctx.fillStyle = bodyColor;
      ctx.fillRect(5,4,6,7);
      ctx.fillRect(4,5,8,5);
      // Head
      ctx.fillRect(5,2,6,4);
      // Eyes
      ctx.fillStyle = eyeColor;
      px(ctx,6,3,eyeColor); px(ctx,9,3,eyeColor);
      // Legs
      ctx.fillStyle = accentColor;
      ctx.fillRect(5,11,2,3);ctx.fillRect(9,11,2,3);
      if (drawExtra) drawExtra(ctx);
    });
  }

  monsterSprite('mob_goblin', '#44aa44', '#ff0000', '#338833', ctx => {
    px(ctx,5,4,'#ffff00'); px(ctx,10,4,'#ffff00'); // ears
    ctx.fillStyle = '#888';
    ctx.fillRect(6,8,4,1); // belt
  });

  monsterSprite('mob_orc', '#668822', '#ff2200', '#446611', ctx => {
    ctx.fillStyle = '#888800';
    ctx.fillRect(3,4,2,5); // axe handle
    ctx.fillStyle = '#aaaaaa';
    ctx.fillRect(2,3,3,3); // axe head
    // tusks
    px(ctx,6,6,'#eeeeee'); px(ctx,9,6,'#eeeeee');
  });

  monsterSprite('mob_skeleton', '#ccccaa', '#ff0000', '#aaaaaa', ctx => {
    ctx.fillStyle = '#aaaaaa';
    for (let y=4;y<=9;y+=2) px(ctx,7,y,'#777777');
    // skull detail
    px(ctx,6,2,'#999'); px(ctx,9,2,'#999');
    ctx.fillStyle = '#888';
    ctx.fillRect(5,5,6,1);
  });

  monsterSprite('mob_spider', '#440000', '#ff4444', '#220000', ctx => {
    // 8 legs
    ctx.fillStyle = '#330000';
    [3,4,5,11,12,13].forEach(x => ctx.fillRect(x, 7, 1, 2));
    px(ctx,2,6,'#330000'); px(ctx,13,6,'#330000');
    // fangs
    px(ctx,6,9,'#ffffff'); px(ctx,9,9,'#ffffff');
  });

  monsterSprite('mob_bat', '#884488', '#ff4444', '#662266', ctx => {
    // wings
    ctx.fillStyle = '#662266';
    ctx.fillRect(0,3,5,6); ctx.fillRect(11,3,5,6);
    // wing membrane
    ctx.fillStyle = '#440044';
    ctx.fillRect(1,4,3,4); ctx.fillRect(12,4,3,4);
  });

  monsterSprite('mob_troll', '#226622', '#ff0000', '#114411', ctx => {
    // bigger body
    ctx.fillStyle = '#1a5522';
    ctx.fillRect(3,3,10,10);
    // club
    ctx.fillStyle = '#6B3A2A';
    ctx.fillRect(12,2,2,6);
    ctx.fillStyle = '#8B5A3A';
    ctx.fillRect(11,1,4,3);
  });

  monsterSprite('mob_mage', '#550088', '#aaccff', '#440066', ctx => {
    // robe
    ctx.fillStyle = '#330055';
    ctx.fillRect(4,7,8,7);
    // staff
    ctx.fillStyle = '#6B3A2A';
    ctx.fillRect(12,2,1,12);
    ctx.fillStyle = '#4488ff';
    px(ctx,12,1,'#4488ff'); px(ctx,11,2,'#4488ff'); px(ctx,13,2,'#4488ff');
    // hat
    ctx.fillStyle = '#440066';
    ctx.fillRect(5,1,6,2);
    ctx.fillRect(6,0,4,1);
  });

  monsterSprite('mob_vampire', '#660000', '#ff0000', '#440000', ctx => {
    // cape
    ctx.fillStyle = '#330000';
    ctx.fillRect(2,4,12,10);
    // fangs
    px(ctx,6,7,'#ffffff'); px(ctx,9,7,'#ffffff');
    // collar
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(5,4,6,1);
  });

  monsterSprite('mob_lich', '#2a0050', '#aaaaff', '#1a0030', ctx => {
    ctx.fillStyle = '#aaaaaa';
    // crown
    ctx.fillRect(5,1,6,1);
    [5,7,9,10].forEach(x => px(ctx,x,0,'#aaaaaa'));
    [6,8].forEach(x => px(ctx,x,0,'#ffd700'));
    ctx.fillStyle = '#6600aa';
    ctx.fillRect(3,4,10,9);
    // orb
    px(ctx,12,5,'#8888ff'); px(ctx,13,4,'#aaaaff');
  });

  monsterSprite('mob_golem', '#888888', '#ff0000', '#666666', ctx => {
    ctx.fillStyle = '#aaaaaa';
    ctx.fillRect(3,2,10,12);
    ctx.fillStyle = '#888';
    // rock texture
    for(let i=0;i<6;i++) px(ctx, 4+i*2, 4+i,'#666');
    ctx.fillStyle = '#ff4400';
    px(ctx,5,5,'#ff4400');px(ctx,10,5,'#ff4400'); // eyes
  });

  monsterSprite('mob_dragon', '#882200', '#ff4400', '#661100', ctx => {
    // wings
    ctx.fillStyle = '#550000';
    ctx.fillRect(0,2,5,8); ctx.fillRect(11,2,5,8);
    // spine
    ctx.fillStyle = '#ff6600';
    [5,7,9,11].forEach(x => px(ctx,x,1,'#ff6600'));
    // tail
    ctx.fillStyle = '#661100';
    ctx.fillRect(12,10,4,3);
    // fire breath
    ctx.fillStyle = '#ff8800';
    px(ctx,4,4,'#ff8800');px(ctx,3,5,'#ffaa00');
  });

  monsterSprite('boss_lich', '#220044', '#ffee00', '#110022', ctx => {
    // crown with gems
    ctx.fillStyle = '#888800';
    ctx.fillRect(4,0,8,2);
    [4,8,11].forEach(x => { px(ctx,x,0,'#888800'); px(ctx,x-1,0,'#ffd700'); });
    // glow effect
    ctx.fillStyle = '#4400ff';
    px(ctx,7,4,'#4400ff'); px(ctx,8,4,'#4400ff');
    // Necronomicon
    ctx.fillStyle = '#330022';
    ctx.fillRect(0,6,3,5);
    ctx.fillStyle = '#660044';
    px(ctx,1,7,'#ff0044');
    // robe
    ctx.fillStyle = '#220033';
    ctx.fillRect(3,5,10,9);
  });

  // ── UI ELEMENTS ──
  makeSprite('cursor', (ctx) => {
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1;
    ctx.strokeRect(0, 0, 15, 15);
    ctx.fillStyle = 'rgba(255,255,255,0.15)';
    ctx.fillRect(1, 1, 14, 14);
    // corners
    ctx.fillStyle = '#ffff00';
    ctx.fillRect(0,0,3,1); ctx.fillRect(0,0,1,3);
    ctx.fillRect(13,0,3,1); ctx.fillRect(15,0,1,3);
    ctx.fillRect(0,14,1,2); ctx.fillRect(0,14,3,1);
    ctx.fillRect(13,15,3,1); ctx.fillRect(15,13,1,3);
  });

  // World map tiles
  Object.entries(BIOME_COLOR).forEach(([biome, color]) => {
    makeSprite(`world_${biome}`, (ctx) => {
      const r = (color>>16)&255, g=(color>>8)&255, b=color&255;
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(0,0,16,16);
      // texture variation
      ctx.fillStyle = `rgba(0,0,0,0.2)`;
      for(let i=0;i<4;i++) ctx.fillRect(Math.floor(Math.random()*14),Math.floor(Math.random()*14),2,2);
    });
  });

  // Player marker for world map
  makeSprite('world_player', (ctx) => {
    ctx.fillStyle = '#ffff00';
    ctx.fillRect(6,2,4,12);
    ctx.fillRect(2,6,12,4);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(7,7,2,2);
  });

  // Dungeon entrance marker
  makeSprite('world_dungeon', (ctx) => {
    ctx.fillStyle = '#2a1a3a';
    ctx.fillRect(3,3,10,10);
    ctx.fillStyle = '#4a2a6a';
    ctx.fillRect(5,5,6,6);
    ctx.fillStyle = '#aa44ff';
    ctx.fillRect(7,7,2,2);
    // archway
    ctx.fillStyle = '#3a2a5a';
    ctx.fillRect(5,3,6,3);
    ctx.fillStyle = '#1a0a2a';
    ctx.fillRect(6,4,4,2);
  });

  // Town marker
  makeSprite('world_town', (ctx) => {
    ctx.fillStyle = '#8B5A2B';
    ctx.fillRect(4,6,8,8);
    ctx.fillStyle = '#cc4444';
    // roof
    const pts = [[8,2],[3,7],[13,7]];
    ctx.fillStyle = '#cc4444';
    ctx.fillRect(5,4,6,4);
    for(let x=4;x<=11;x++) px(ctx,x,3,'#cc4444');
    for(let x=5;x<=10;x++) px(ctx,x,2,'#cc4444');
    px(ctx,7,1,'#cc4444');px(ctx,8,1,'#cc4444');
    // windows
    ctx.fillStyle = '#ffff88';
    ctx.fillRect(5,8,2,2);ctx.fillRect(9,8,2,2);
    // door
    ctx.fillStyle = '#5a3a1a';
    ctx.fillRect(7,10,2,4);
  });

  // Fog tile
  makeSprite('fog', (ctx) => {
    ctx.fillStyle = '#0a0a0f';
    ctx.fillRect(0,0,16,16);
  });

  // Explored fog (dim)
  makeSprite('fog_explored', (ctx) => {
    ctx.fillStyle = 'rgba(5,5,15,0.7)';
    ctx.fillRect(0,0,16,16);
  });

  // Particle / effect sprites
  makeSprite('particle_fire', (ctx) => {
    ctx.fillStyle = '#ff4400';
    ctx.fillRect(5,5,6,6);
    ctx.fillStyle = '#ffaa00';
    ctx.fillRect(6,4,4,2);
    ctx.fillStyle = '#ffff00';
    ctx.fillRect(7,3,2,2);
  });

  makeSprite('particle_ice', (ctx) => {
    ctx.fillStyle = '#aaddff';
    ctx.fillRect(6,2,4,12);
    ctx.fillRect(2,6,12,4);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(7,7,2,2);
  });

  makeSprite('particle_lightning', (ctx) => {
    ctx.fillStyle = '#ffff00';
    px(ctx,8,0,'#ffff00');px(ctx,7,1,'#ffff00');px(ctx,7,2,'#ffff00');
    px(ctx,8,3,'#ffff00');px(ctx,9,4,'#ffff00');px(ctx,8,5,'#ffff00');
    px(ctx,7,6,'#ffff00');px(ctx,8,7,'#ffff00');px(ctx,8,8,'#ffff00');
    ctx.fillStyle = '#ffffff';
    px(ctx,8,2,'#ffffff');px(ctx,8,4,'#ffffff');
  });

  makeSprite('particle_heal', (ctx) => {
    ctx.fillStyle = '#00ff88';
    ctx.fillRect(7,3,2,10);
    ctx.fillRect(3,7,10,2);
    ctx.fillStyle = '#88ffcc';
    ctx.fillRect(7,4,2,8);
    ctx.fillRect(4,7,8,2);
  });

  // XP orb
  makeSprite('xp_orb', (ctx) => {
    ctx.fillStyle = '#88ff44';
    ctx.fillRect(6,4,4,8);
    ctx.fillRect(4,6,8,4);
    ctx.fillStyle = '#ccff88';
    ctx.fillRect(7,5,2,6);
    ctx.fillRect(5,7,6,2);
  });

  // Gold coin
  makeSprite('gold_coin', (ctx) => {
    ctx.fillStyle = '#ffd700';
    ctx.fillRect(5,3,6,10);
    ctx.fillRect(3,5,10,6);
    ctx.fillStyle = '#ffaa00';
    px(ctx,5,4,'#ffaa00');px(ctx,10,4,'#ffaa00');
    px(ctx,5,11,'#ffaa00');px(ctx,10,11,'#ffaa00');
    ctx.fillStyle = '#ffff88';
    px(ctx,7,6,'#ffff88');
  });

  console.log('[DungeonForge] All sprites generated.');
}

// ─────────────────────────────────────────────
// GLOBAL GAME STATE
// ─────────────────────────────────────────────
const GameState = {
  seed: Math.floor(Math.random() * 0xFFFFFF),
  floor: 1,
  worldMap: null,
  floorData: null,
  world: null,       // ECS world
  player: null,      // player entity
  turnCount: 0,
  messageLog: [],
  inDungeon: false,
  currentDungeon: null,
  phase: 'title',    // title | worldmap | dungeon
  saveSlot: 1,
  spellTarget: null,
  selectedSpell: null,
  targeting: false,
  companion: null,    // active companion def (from COMPANIONS)
  companionEntity: null, // ECS entity
  mount: null,        // active mount def (from MOUNTS)

  addMessage(text, color='#ccccee') {
    this.messageLog.unshift({ text, color, turn:this.turnCount });
    if (this.messageLog.length > 50) this.messageLog.pop();
    // Also show as toast for important messages
    if (color !== '#ccccee' && color !== '#888888') window.showToast(text);
  },

  serialize() {
    const p = this.player;
    if (!p) return null;
    return {
      seed: this.seed,
      floor: this.floor,
      turnCount: this.turnCount,
      messageLog: this.messageLog.slice(0,20),
      inDungeon: this.inDungeon,
      player: {
        pos: p.get('pos'),
        health: p.get('health'),
        stats: p.get('stats'),
        inventory: p.get('inventory'),
        equipment: p.get('equipment'),
        skills: {
          known: p.get('skills')?.known,
          points: p.get('skills')?.points,
        },
        status: p.get('status'),
      }
    };
  },

  async saveToDB(slot) {
    const data = this.serialize();
    if (!data) return false;
    try { await DB.save(slot || this.saveSlot, data); return true; }
    catch(e) { console.error('Save failed:', e); return false; }
  },

  async loadFromDB(slot) {
    try {
      const data = await DB.load(slot || this.saveSlot);
      return data;
    } catch(e) { return null; }
  }
};

// ─────────────────────────────────────────────
// ─────────────────────────────────────────────
// PHASER SCENES
// ─────────────────────────────────────────────
// ─────────────────────────────────────────────

// ═══════════════════════════════════════════
// SCENE: BOOT (generates all textures)
// ═══════════════════════════════════════════
class BootScene extends Phaser.Scene {
  constructor() { super({ key:'Boot' }); }

  async create() {
    generateSprites(this);
    await DB.init();
    this.scene.start('Title');
  }
}

// ═══════════════════════════════════════════
// SCENE: TITLE
// ═══════════════════════════════════════════
class TitleScene extends Phaser.Scene {
  constructor() { super({ key:'Title' }); }

  create() {
    const W = this.scale.width, H = this.scale.height;

    // Background gradient
    const bg = this.add.graphics();
    bg.fillGradientStyle(0x0a0a1a, 0x0a0a1a, 0x1a0a2e, 0x1a0a2e, 1);
    bg.fillRect(0, 0, W, H);

    // Animated background particles
    this.particles = [];
    for (let i=0; i<30; i++) {
      const star = this.add.rectangle(
        Phaser.Math.Between(0,W), Phaser.Math.Between(0,H),
        Phaser.Math.Between(1,3), Phaser.Math.Between(1,3),
        Phaser.Math.Between(0,1) ? 0xffffff : 0xff6b35,
        Phaser.Math.FloatBetween(0.3, 0.8)
      );
      star.speed = Phaser.Math.FloatBetween(0.2, 0.8);
      this.particles.push(star);
    }

    // Title
    const titleText = this.add.text(W/2, H*0.22, 'DUNGEON FORGE', {
      fontFamily: '"Press Start 2P"',
      fontSize: Math.min(48, W/18) + 'px',
      color: '#ff6b35',
      stroke: '#000000', strokeThickness: 4,
      shadow: { offsetX:4, offsetY:4, color:'#ff6b3544', blur:8, fill:true }
    }).setOrigin(0.5);

    const subText = this.add.text(W/2, H*0.32, '— A PROCEDURAL ROGUELIKE —', {
      fontFamily: '"VT323"',
      fontSize: Math.min(28, W/30) + 'px',
      color: '#8888aa',
    }).setOrigin(0.5);

    // Menu options
    const menuItems = [
      { label:'▶ NEW GAME',    action: () => this.startNewGame() },
      { label:'📂 LOAD GAME',  action: () => this.loadGame() },
      { label:'📖 HOW TO PLAY',action: () => this.showHelp() },
    ];

    this._menuIdx = 0;
    this._menuItems = [];
    menuItems.forEach((item, i) => {
      const btn = this.add.text(W/2, H*0.48 + i*65, item.label, {
        fontFamily: '"Press Start 2P"',
        fontSize: Math.min(18, W/50) + 'px',
        color: '#ccccee',
        padding: { x:20, y:10 },
        backgroundColor: '#1a1a3a',
      }).setOrigin(0.5).setInteractive({ useHandCursor:true });

      btn.on('pointerover', () => { btn.setColor('#ff6b35'); btn.setBackgroundColor('#2a2a5a'); this._menuIdx = i; });
      btn.on('pointerout',  () => { btn.setColor('#ccccee'); btn.setBackgroundColor('#1a1a3a'); });
      btn.on('pointerdown', item.action);
      this._menuItems.push({ btn, action:item.action });
    });

    // Version / credits
    this.add.text(W/2, H*0.92, 'v1.0.0 | Phaser 3 | PWA Ready | Press Enter to Play', {
      fontFamily: '"VT323"', fontSize: '14px', color:'#444466'
    }).setOrigin(0.5);

    // Dragon sprite animated
    const dragonImg = this.add.image(W/2, H*0.39, 'mob_dragon').setScale(3).setAlpha(0.4);
    this.tweens.add({ targets:dragonImg, y:H*0.39+10, duration:2000, yoyo:true, repeat:-1, ease:'Sine.easeInOut' });

    // Keyboard
    this.input.keyboard.on('keydown-ENTER', () => menuItems[this._menuIdx].action());
    this.input.keyboard.on('keydown-UP', () => {
      this._menuIdx = (this._menuIdx - 1 + menuItems.length) % menuItems.length;
    });
    this.input.keyboard.on('keydown-DOWN', () => {
      this._menuIdx = (this._menuIdx + 1) % menuItems.length;
    });

    // Pulse title
    this.tweens.add({ targets:titleText, scaleX:1.02, scaleY:1.02, duration:1500, yoyo:true, repeat:-1, ease:'Sine.easeInOut' });

    if (window.onGameReady) { window.onGameReady(); window.onGameReady = null; }
  }

  update() {
    for (const star of this.particles) {
      star.y += star.speed;
      if (star.y > this.scale.height) star.y = 0;
    }
  }

  startNewGame() {
    GameState.seed = Phaser.Math.Between(1, 0xFFFFFF);
    GameState.floor = 1;
    GameState.turnCount = 0;
    GameState.messageLog = [];
    GameState.inDungeon = false;
    // Init world ECS
    GameState.world = new World();
    GameState.worldMap = generateWorldMap(GameState.seed);
    this.scene.start('WorldMap');
  }

  async loadGame() {
    const data = await GameState.loadFromDB(1);
    if (!data) {
      window.showToast('No save data found!', 'warning');
      return;
    }
    GameState.seed = data.seed;
    GameState.floor = data.floor;
    GameState.turnCount = data.turnCount;
    GameState.messageLog = data.messageLog || [];
    GameState.world = new World();
    GameState.worldMap = generateWorldMap(GameState.seed);
    // Restore player
    const p = GameState.world.create().tag('player').tag('actor');
    p.add(C.pos(data.player.pos.x, data.player.pos.y, data.player.pos.floor));
    p.add({ ...data.player.health, type:'health' });
    p.add({ ...data.player.stats, type:'stats' });
    p.add({ ...data.player.inventory, type:'inventory' });
    p.add({ ...data.player.equipment, type:'equipment' });
    const sk = C.skills();
    if (data.player.skills) { sk.known=data.player.skills.known||[]; sk.points=data.player.skills.points||0; }
    p.add(sk);
    p.add(C.fov(8));
    p.add(C.status());
    GameState.player = p;
    if (data.inDungeon) {
      GameState.inDungeon = true;
      this.scene.start('Dungeon');
    } else {
      this.scene.start('WorldMap');
    }
    window.showToast('Game loaded!', 'rare');
  }

  showHelp() {
    const W = this.scale.width, H = this.scale.height;
    const panel = this.add.rectangle(W/2, H/2, Math.min(600, W-40), Math.min(420, H-40), 0x0a0a2a, 0.97);
    panel.setStrokeStyle(2, 0x4444aa);

    const helpText = [
      '── CONTROLS ──',
      'Arrow Keys / WASD : Move',
      'Space / . : Wait turn',
      'I : Inventory',
      'S : Skill Tree',
      'M : World Map',
      'G : Pick up item',
      'E : Use stairs',
      'F : Cast selected spell',
      'Q : Quicksave  |  Esc : Close',
      '',
      '── GAMEPLAY ──',
      'Explore dungeons, slay monsters',
      'Collect gear, learn spells',
      'Defeat bosses to advance floors',
      'Reach floor 10 to face the Lich King!',
    ].join('\n');

    const txt = this.add.text(W/2, H/2, helpText, {
      fontFamily:'"VT323"', fontSize:'16px', color:'#ccccee',
      align:'left', lineSpacing:6
    }).setOrigin(0.5);

    const close = this.add.text(W/2, H/2 + 200, '[ CLOSE ]', {
      fontFamily:'"Press Start 2P"', fontSize:'12px', color:'#ff6b35'
    }).setOrigin(0.5).setInteractive({ useHandCursor:true });
    close.on('pointerdown', () => { panel.destroy(); txt.destroy(); close.destroy(); });
    this.input.keyboard.once('keydown-ESC', () => { panel.destroy(); txt.destroy(); close.destroy(); });
  }
}

// ═══════════════════════════════════════════
// SCENE: WORLD MAP
// ═══════════════════════════════════════════
class WorldMapScene extends Phaser.Scene {
  constructor() { super({ key:'WorldMap' }); }

  create() {
    const W = this.scale.width, H = this.scale.height;
    GameState.phase = 'worldmap';

    this.mapContainer = this.add.container(0, 0);
    this.tileScale = 2;
    const tileSize = TILE * this.tileScale;
    const wm = GameState.worldMap;

    // Draw world map
    this.worldTiles = [];
    for (let y=0; y<WORLD_ROWS; y++) {
      for (let x=0; x<WORLD_COLS; x++) {
        const tile = wm.tiles[y][x];
        const img = this.add.image(x*tileSize, y*tileSize, `world_${tile.biome}`)
          .setScale(this.tileScale).setOrigin(0);
        this.mapContainer.add(img);
      }
    }

    // Draw dungeons
    for (const dng of wm.dungeons) {
      const img = this.add.image(dng.x*tileSize, dng.y*tileSize, 'world_dungeon')
        .setScale(this.tileScale).setOrigin(0).setInteractive({ useHandCursor:true });
      img.on('pointerdown', () => this.enterDungeon(dng));
      img.on('pointerover', () => {
        this.hoverText.setText(`${dng.name}\nFloor 1-${MAX_FLOORS}\nClick to Enter`);
        this.hoverText.setVisible(true);
      });
      img.on('pointerout', () => this.hoverText.setVisible(false));
      this.mapContainer.add(img);

      // Label
      const lbl = this.add.text(dng.x*tileSize, dng.y*tileSize-12, dng.visited?'✓D':'D', {
        fontFamily:'"VT323"', fontSize:'12px', color: dng.visited?'#88ff88':'#ff8800'
      }).setOrigin(0.5,1);
      this.mapContainer.add(lbl);
    }

    // Draw towns
    for (const town of wm.towns) {
      const img = this.add.image(town.x*tileSize, town.y*tileSize, 'world_town')
        .setScale(this.tileScale).setOrigin(0).setInteractive({ useHandCursor:true });
      img.on('pointerdown', () => this.visitTown(town));
      img.on('pointerover', () => {
        this.hoverText.setText(`${town.name}\nRest & Shop\nCompanions & Mounts\nClick to Visit`);
        this.hoverText.setVisible(true);
      });
      img.on('pointerout', () => this.hoverText.setVisible(false));
      this.mapContainer.add(img);
    }

    // Draw markets
    if (!MarketState.marketRNG) MarketState.init(GameState.seed);
    for (const mkt of (wm.markets || [])) {
      const mktImg = this.add.image(mkt.x*tileSize, mkt.y*tileSize, 'world_town')
        .setScale(this.tileScale).setOrigin(0).setTint(0xffaa44)
        .setInteractive({ useHandCursor:true });
      mktImg.on('pointerdown', () => this._showMarket(mkt));
      mktImg.on('pointerover', () => {
        this.hoverText.setText(`🛒 ${mkt.name}\nDynamic Market\nPrices change!\nClick to Browse`);
        this.hoverText.setVisible(true);
      });
      mktImg.on('pointerout', () => this.hoverText.setVisible(false));
      this.mapContainer.add(mktImg);
      const lbl = this.add.text(mkt.x*tileSize + tileSize/2, mkt.y*tileSize - 4, '🛒', {
        fontSize:'12px'
      }).setOrigin(0.5, 1);
      this.mapContainer.add(lbl);
    }

    // Draw stables
    for (const stable of (wm.stables || [])) {
      const stImg = this.add.image(stable.x*tileSize, stable.y*tileSize, 'world_town')
        .setScale(this.tileScale).setOrigin(0).setTint(0x88cc44)
        .setInteractive({ useHandCursor:true });
      stImg.on('pointerdown', () => this._showMountShop(W, H));
      stImg.on('pointerover', () => {
        this.hoverText.setText(`🐴 ${stable.name}\nMount Shop\nBuy mounts here!\nClick to Browse`);
        this.hoverText.setVisible(true);
      });
      stImg.on('pointerout', () => this.hoverText.setVisible(false));
      this.mapContainer.add(stImg);
      const stLbl = this.add.text(stable.x*tileSize + tileSize/2, stable.y*tileSize - 4, '🐴', {fontSize:'12px'}).setOrigin(0.5, 1);
      this.mapContainer.add(stLbl);
    }

    // Draw companion camps
    for (const camp of (wm.camps || [])) {
      const cImg = this.add.image(camp.x*tileSize, camp.y*tileSize, 'world_town')
        .setScale(this.tileScale).setOrigin(0).setTint(0x4488ff)
        .setInteractive({ useHandCursor:true });
      cImg.on('pointerdown', () => this._showCompanionShop(W, H));
      cImg.on('pointerover', () => {
        this.hoverText.setText(`⚔ ${camp.name}\nCompanion Guild\nHire companions!\nClick to Browse`);
        this.hoverText.setVisible(true);
      });
      cImg.on('pointerout', () => this.hoverText.setVisible(false));
      this.mapContainer.add(cImg);
      const cLbl = this.add.text(camp.x*tileSize + tileSize/2, camp.y*tileSize - 4, '⚔', {fontSize:'12px'}).setOrigin(0.5, 1);
      this.mapContainer.add(cLbl);
    }

    // Init player if not existing
    if (!GameState.player) {
      const startDng = wm.dungeons[0];
      const startX = startDng?.x ?? Math.floor(WORLD_COLS/2);
      const startY = startDng?.y ?? Math.floor(WORLD_ROWS/2);
      const p = GameState.world.create().tag('player').tag('actor');
      p.add(C.pos(startX, startY, 0));
      p.add(C.health(100, 100));
      const stats = C.stats(8, 4, 1, 4, 5);
      stats.mp = 30; stats.maxMp = 30;
      p.add(stats);
      p.add(C.inventory());
      p.add(C.equipment());
      p.add(C.fov(8));
      p.add(C.status());
      const skills = C.skills();
      skills.points = 3;
      p.add(skills);
      // Give starter items
      const inv = p.get('inventory');
      inv.items.push({ ...ITEMS.rusty_dagger, count:1, identified:true });
      inv.items.push({ ...ITEMS.potion_hp_s, count:3, identified:true });
      inv.items.push({ ...ITEMS.food_ration, count:2, identified:true });
      inv.items.push({ ...ITEMS.scroll_id, count:1, identified:true });
      inv.gold = 30;
      // Equip starter weapon
      const equip = p.get('equipment');
      equip.weapon = { ...ITEMS.rusty_dagger };
      GameState.player = p;
    }

    // Player marker
    const ppos = GameState.player.get('pos');
    this.playerMarker = this.add.image(ppos.x*tileSize, ppos.y*tileSize, 'world_player')
      .setScale(this.tileScale).setOrigin(0);
    this.mapContainer.add(this.playerMarker);

    // Camera follow
    const mapW = WORLD_COLS * tileSize;
    const mapH = WORLD_ROWS * tileSize;
    this.cameras.main.setBounds(0, 0, mapW, mapH);
    this.cameras.main.setZoom(1);

    // Center on player
    this.cameras.main.centerOn(ppos.x*tileSize + tileSize/2, ppos.y*tileSize + tileSize/2);
    // Drag to pan
    this.input.on('pointermove', pointer => {
      if (pointer.isDown) {
        this.cameras.main.scrollX -= pointer.velocity.x / 2;
        this.cameras.main.scrollY -= pointer.velocity.y / 2;
      }
    });

    // HUD overlay
    this._buildHUD(W, H);

    // Hover text (fixed to camera)
    this.hoverText = this.add.text(0, 0, '', {
      fontFamily:'"VT323"', fontSize:'14px', color:'#ffffff',
      backgroundColor:'rgba(10,10,20,0.9)',
      padding:{x:8,y:6},
    }).setScrollFactor(0).setDepth(100).setVisible(false);

    this.input.on('pointermove', p => {
      this.hoverText.setPosition(p.x+12, p.y-30);
    });

    // Biome legend
    this._buildLegend(W, H);

    GameState.addMessage('Welcome to DungeonForge! Enter a dungeon to begin your adventure.', '#ffd700');
    GameState.addMessage('WASD/Arrows to move. Click dungeons or towns.', '#aaaaff');
  }

  _buildHUD(W, H) {
    // Top bar
    const bar = this.add.rectangle(W/2, 22, W, 44, 0x0a0a1a, 0.95).setScrollFactor(0).setDepth(50);
    bar.setStrokeStyle(1, 0x333355);

    this.hpText = this.add.text(10, 10, '', {
      fontFamily:'"Press Start 2P"', fontSize:'8px', color:'#ff4444',
    }).setScrollFactor(0).setDepth(51);

    this.mpText = this.add.text(160, 10, '', {
      fontFamily:'"Press Start 2P"', fontSize:'8px', color:'#4488ff',
    }).setScrollFactor(0).setDepth(51);

    this.goldText = this.add.text(310, 10, '', {
      fontFamily:'"Press Start 2P"', fontSize:'8px', color:'#ffd700',
    }).setScrollFactor(0).setDepth(51);

    this.levelText = this.add.text(460, 10, '', {
      fontFamily:'"Press Start 2P"', fontSize:'8px', color:'#88ff88',
    }).setScrollFactor(0).setDepth(51);

    const dungBtn = this.add.text(W-10, 10, '[I] INVENTORY', {
      fontFamily:'"Press Start 2P"', fontSize:'7px', color:'#ccccee',
      backgroundColor:'#1a1a3a', padding:{x:6,y:4},
    }).setOrigin(1,0).setScrollFactor(0).setDepth(51).setInteractive({ useHandCursor:true });
    dungBtn.on('pointerdown', () => { InventoryScene._page='inventory'; this.scene.launch('Inventory'); });

    this._updateHUD();
  }

  _buildLegend(W, H) {
    const lx = W - 130, ly = H - 280;
    this.add.rectangle(lx+60, ly+120, 130, 240, 0x0a0a1a, 0.92).setScrollFactor(0).setDepth(50).setStrokeStyle(1,0x333355);
    this.add.text(lx+65, ly+4, 'MAP LEGEND', {
      fontFamily:'"Press Start 2P"', fontSize:'6px', color:'#ffd700',
    }).setOrigin(0.5,0).setScrollFactor(0).setDepth(51);

    const items = [
      { icon:'⬛', color:'#7ec850', label:'Plains' },
      { icon:'⬛', color:'#2d6a2d', label:'Forest' },
      { icon:'⬛', color:'#e8c87a', label:'Desert' },
      { icon:'⬛', color:'#1a4888', label:'Ocean' },
      { icon:'🏰', color:'#aa44ff', label:'Dungeon' },
      { icon:'🏠', color:'#ffffff', label:'Town (rest+shop)' },
      { icon:'🛒', color:'#ffaa44', label:'Market' },
      { icon:'🐴', color:'#88cc44', label:'Stable (mounts)' },
      { icon:'⚔',  color:'#4488ff', label:'Guild (companions)' },
      { icon:'🧑', color:'#ffff44', label:'You' },
    ];
    items.forEach((it, i) => {
      this.add.text(lx+8,  ly+20+i*21, it.icon, { fontSize:'13px' }).setScrollFactor(0).setDepth(51);
      this.add.text(lx+24, ly+20+i*21, it.label, {
        fontFamily:'"VT323"', fontSize:'13px', color: it.color,
      }).setScrollFactor(0).setDepth(51);
    });
  }

  _updateHUD() {
    const p = GameState.player;
    if (!p) return;
    const hp = p.get('health');
    const st = p.get('stats');
    const inv = p.get('inventory');
    if (hp) this.hpText.setText(`HP: ${hp.hp}/${hp.maxHp}`);
    if (st) {
      this.mpText.setText(`MP: ${st.mp||0}/${st.maxMp||0}`);
      this.levelText.setText(`LVL: ${st.level}  XP: ${st.xp}/${st.xpNext}`);
    }
    if (inv) this.goldText.setText(`GOLD: ${inv.gold}💰`);
  }

  enterDungeon(dng) {
    const ppos = GameState.player.get('pos');
    ppos.x = dng.x; ppos.y = dng.y;
    GameState.inDungeon = true;
    GameState.floor = 1;
    GameState.currentDungeon = dng;
    dng.visited = true;
    GameState.floorData = generateFloor(1, GameState.seed ^ dng.id);
    GameState.addMessage(`Entering ${dng.name}...`, '#ff6b35');
    this.scene.start('Dungeon');
    this.scene.start('HUD', null, false, this);
  }

  visitTown(town) {
    town.visited = true;
    this._showTownMenu(town);
  }

  _showTownMenu(town) {
    const W = this.scale.width, H = this.scale.height;
    const p = GameState.player;
    const hp = p.get('health');
    const st = p.get('stats');
    const inv = p.get('inventory');

    // Heal to full on rest
    if (hp) {
      const healed = hp.maxHp - hp.hp;
      hp.hp = hp.maxHp;
      if (healed > 0) GameState.addMessage(`Rested at ${town.name}. Healed ${healed} HP!`, '#00ff88');
    }
    if (st && st.mp !== undefined) st.mp = st.maxMp || 30;

    // Build flat list of display objects so we can destroy them all on close
    const elements = [];
    const add = obj => { elements.push(obj); return obj; };
    const depth = 200;
    const sf = 0; // scrollFactor

    const PW = Math.min(520, W - 40), PH = Math.min(400, H - 40);
    const ox = W/2, oy = H/2;

    // Block pointer events behind panel
    const blocker = add(this.add.rectangle(ox, oy, W, H, 0x000000, 0.6)
      .setScrollFactor(sf).setDepth(depth - 1).setInteractive());

    add(this.add.rectangle(ox, oy, PW, PH, 0x0a0a1a, 0.98)
      .setStrokeStyle(2, 0x4444aa).setScrollFactor(sf).setDepth(depth));

    add(this.add.text(ox, oy - PH/2 + 20, `🏠  ${town.name}`, {
      fontFamily:'"Press Start 2P"', fontSize:'12px', color:'#ffd700'
    }).setOrigin(0.5, 0).setScrollFactor(sf).setDepth(depth));

    add(this.add.text(ox, oy - PH/2 + 44, 'Fully rested. Shop below:', {
      fontFamily:'"VT323"', fontSize:'15px', color:'#88ff88'
    }).setOrigin(0.5, 0).setScrollFactor(sf).setDepth(depth));

    // Shop items grid (2 cols × 3 rows)
    const shopItems = [
      { ...ITEMS.potion_hp_s,   count:1, identified:true },
      { ...ITEMS.potion_hp_m,   count:1, identified:true },
      { ...ITEMS.antidote,      count:1, identified:true },
      { ...ITEMS.short_sword,   count:1, identified:true },
      { ...ITEMS.leather_armor, count:1, identified:true },
      { ...ITEMS.scroll_tp,     count:1, identified:true },
    ];

    const cellW = 220, cellH = 52;
    const gridLeft = ox - cellW - 4;
    const gridTop  = oy - PH/2 + 72;

    shopItems.forEach((item, i) => {
      const col = i % 2, row = Math.floor(i / 2);
      const cx = gridLeft + col * (cellW + 8);
      const cy = gridTop  + row * (cellH + 6);

      const btn = add(this.add.rectangle(cx + cellW/2, cy + cellH/2, cellW, cellH, 0x1a1a3a)
        .setStrokeStyle(1, 0x334466).setScrollFactor(sf).setDepth(depth)
        .setInteractive({ useHandCursor:true }));

      add(this.add.text(cx + 6, cy + 6, `${item.icon||'•'} ${item.name}`, {
        fontFamily:'"VT323"', fontSize:'15px',
        color:'#'+RARITY_COLOR[item.rarity].toString(16).padStart(6,'0'),
      }).setScrollFactor(sf).setDepth(depth + 1));

      add(this.add.text(cx + 6, cy + 26, `${item.price}💰`, {
        fontFamily:'"VT323"', fontSize:'13px', color:'#ffd700',
      }).setScrollFactor(sf).setDepth(depth + 1));

      btn.on('pointerover', () => btn.setFillStyle(0x2a2a5a));
      btn.on('pointerout',  () => btn.setFillStyle(0x1a1a3a));
      btn.on('pointerdown', () => {
        if (inv.gold < item.price) { window.showToast('Not enough gold!','warning'); return; }
        if (inv.items.length >= inv.maxSize) { window.showToast('Inventory full!','warning'); return; }
        inv.gold -= item.price;
        inv.items.push({ ...item });
        GameState.addMessage(`Bought ${item.name}!`, '#00ff88');
        goldText.setText(`💰 ${inv.gold}g`);
        this._updateHUD();
      });
    });

    const goldText = add(this.add.text(ox, oy + PH/2 - 80, `💰 ${inv.gold}g`, {
      fontFamily:'"Press Start 2P"', fontSize:'9px', color:'#ffd700',
    }).setOrigin(0.5).setScrollFactor(sf).setDepth(depth));

    // Define closeAll FIRST (fixes temporal dead zone)
    const closeAll = () => elements.forEach(e => e.destroy());

    // Companion + Mount buttons above close
    const compBtn = add(this.add.rectangle(ox - 90, oy + PH/2 - 68, 150, 30, 0x0d1a0d)
      .setStrokeStyle(1, 0x44ff88).setScrollFactor(sf).setDepth(depth).setInteractive({useHandCursor:true}));
    add(this.add.text(ox - 90, oy + PH/2 - 68, `⚔ COMPANIONS${GameState.companion?' ✓':''}`,
      {fontFamily:'"VT323"', fontSize:'15px', color:'#44ff88'}).setOrigin(0.5).setScrollFactor(sf).setDepth(depth+1).setInteractive({useHandCursor:true}));
    compBtn.on('pointerdown', () => { closeAll(); this._showCompanionShop(W, H); });
    compBtn.on('pointerover', () => compBtn.setFillStyle(0x1a3a1a));
    compBtn.on('pointerout',  () => compBtn.setFillStyle(0x0d1a0d));

    const mntBtn = add(this.add.rectangle(ox + 90, oy + PH/2 - 68, 150, 30, 0x0a0d1a)
      .setStrokeStyle(1, 0x4488ff).setScrollFactor(sf).setDepth(depth).setInteractive({useHandCursor:true}));
    add(this.add.text(ox + 90, oy + PH/2 - 68, `🐴 MOUNTS${GameState.mount?' ✓':''}`,
      {fontFamily:'"VT323"', fontSize:'15px', color:'#4488ff'}).setOrigin(0.5).setScrollFactor(sf).setDepth(depth+1).setInteractive({useHandCursor:true}));
    mntBtn.on('pointerdown', () => { closeAll(); this._showMountShop(W, H); });
    mntBtn.on('pointerover', () => mntBtn.setFillStyle(0x0a1a3a));
    mntBtn.on('pointerout',  () => mntBtn.setFillStyle(0x0a0d1a));

    // Close button (closeAll already defined above)
    const closeRect = add(this.add.rectangle(ox, oy + PH/2 - 30, 180, 38, 0x1a1a3a)
      .setStrokeStyle(1, 0xff6b35).setScrollFactor(sf).setDepth(depth)
      .setInteractive({ useHandCursor:true }));
    const closeTxt = add(this.add.text(ox, oy + PH/2 - 30, '[ LEAVE TOWN ]', {
      fontFamily:'"Press Start 2P"', fontSize:'9px', color:'#ff6b35',
    }).setOrigin(0.5).setScrollFactor(sf).setDepth(depth + 1));

    closeRect.on('pointerover', () => closeRect.setFillStyle(0x2a1a1a));
    closeRect.on('pointerout',  () => closeRect.setFillStyle(0x1a1a3a));
    closeRect.on('pointerdown', closeAll);
    closeTxt.setInteractive({ useHandCursor:true }).on('pointerdown', closeAll);
    blocker.on('pointerdown', closeAll); // click outside also closes

    // ESC key closes
    const escHandler = () => closeAll();
    this.input.keyboard.once('keydown-ESC', escHandler);
  }

  _showCompanionShop(W, H) {
    const inv = GameState.player?.get('inventory');
    const elements = [];
    const add = o => { elements.push(o); return o; };
    const depth = 210;
    const PW = Math.min(480, W-40), PH = Math.min(420, H-40);
    const closeAll = () => elements.forEach(e=>e.destroy());

    add(this.add.rectangle(W/2,H/2,W,H,0,0.5).setScrollFactor(0).setDepth(depth-1).setInteractive().on('pointerdown',closeAll));
    add(this.add.rectangle(W/2,H/2,PW,PH,0x0a0a1a,0.97).setStrokeStyle(2,0xffaa44).setScrollFactor(0).setDepth(depth));
    add(this.add.text(W/2,H/2-PH/2+16,'⚔ COMPANIONS',{fontFamily:'"Press Start 2P"',fontSize:'10px',color:'#ffaa44'}).setOrigin(0.5,0).setScrollFactor(0).setDepth(depth));

    const current = GameState.companion;
    if (current) {
      add(this.add.text(W/2,H/2-PH/2+38,`Active: ${current.icon} ${current.name}`,{fontFamily:'"VT323"',fontSize:'16px',color:'#44ff88'}).setOrigin(0.5,0).setScrollFactor(0).setDepth(depth));
    }

    Object.values(COMPANIONS).forEach((comp, i) => {
      const cy = H/2-PH/2+60 + i*52;
      const owned = current?.id === comp.id;
      const canBuy = (inv?.gold||0) >= comp.price;
      const bg = add(this.add.rectangle(W/2, cy+22, PW-20, 46, owned?0x112211:canBuy?0x111a2e:0x110a0a)
        .setStrokeStyle(1, owned?0x44ff44:canBuy?0x4488ff:0x442222).setScrollFactor(0).setDepth(depth).setInteractive({useHandCursor:!owned&&canBuy}));
      add(this.add.text(W/2-PW/2+12,cy+6,`${comp.icon} ${comp.name}`,{fontFamily:'"VT323"',fontSize:'16px',color:owned?'#44ff88':canBuy?'#aaaaff':'#664444'}).setScrollFactor(0).setDepth(depth));
      add(this.add.text(W/2-PW/2+12,cy+24,`HP:${comp.hp} ATK:${comp.atk} DEF:${comp.def} | ${comp.desc.slice(0,40)}`,{fontFamily:'"VT323"',fontSize:'12px',color:'#666688'}).setScrollFactor(0).setDepth(depth));
      add(this.add.text(W/2+PW/2-12,cy+14,owned?'ACTIVE':`${comp.price}💰`,{fontFamily:'"Press Start 2P"',fontSize:'7px',color:owned?'#44ff44':'#ffd700'}).setOrigin(1,0.5).setScrollFactor(0).setDepth(depth));
      if (!owned && canBuy) {
        bg.on('pointerdown',()=>{
          inv.gold -= comp.price;
          GameState.companion = comp;
          GameState.addMessage(`${comp.icon} ${comp.name} joins your party!`,'#44ff88');
          window.showToast(`Companion: ${comp.name} hired!`,'rare');
          closeAll();
        });
        bg.on('pointerover',()=>bg.setFillStyle(0x1a2a3a));
        bg.on('pointerout',()=>bg.setFillStyle(0x111a2e));
      }
    });

    add(this.add.rectangle(W/2,H/2+PH/2-22,120,32,0x1a1a1a).setStrokeStyle(1,0xff4444).setScrollFactor(0).setDepth(depth).setInteractive({useHandCursor:true}).on('pointerdown',closeAll));
    add(this.add.text(W/2,H/2+PH/2-22,'[ CLOSE ]',{fontFamily:'"Press Start 2P"',fontSize:'8px',color:'#ff4444'}).setOrigin(0.5).setScrollFactor(0).setDepth(depth+1).setInteractive({useHandCursor:true}).on('pointerdown',closeAll));
    this.input.keyboard.once('keydown-ESC',closeAll);
  }

  _showMountShop(W, H) {
    const inv = GameState.player?.get('inventory');
    const elements = [];
    const add = o => { elements.push(o); return o; };
    const depth = 210;
    const PW = Math.min(520, W-40), PH = Math.min(460, H-40);
    const closeAll = () => elements.forEach(e=>e.destroy());

    add(this.add.rectangle(W/2,H/2,W,H,0,0.5).setScrollFactor(0).setDepth(depth-1).setInteractive().on('pointerdown',closeAll));
    add(this.add.rectangle(W/2,H/2,PW,PH,0x0a0a1a,0.97).setStrokeStyle(2,0x4488ff).setScrollFactor(0).setDepth(depth));
    add(this.add.text(W/2,H/2-PH/2+16,'🐴 MOUNTS',{fontFamily:'"Press Start 2P"',fontSize:'10px',color:'#4488ff'}).setOrigin(0.5,0).setScrollFactor(0).setDepth(depth));

    const current = GameState.mount;
    if (current) add(this.add.text(W/2,H/2-PH/2+38,`Riding: ${current.icon} ${current.name}`,{fontFamily:'"VT323"',fontSize:'16px',color:'#44ff88'}).setOrigin(0.5,0).setScrollFactor(0).setDepth(depth));

    Object.values(MOUNTS).forEach((mount, i) => {
      const cy = H/2-PH/2+60+i*56;
      const owned = current?.id===mount.id;
      const canBuy = (inv?.gold||0)>=mount.price;
      const bg = add(this.add.rectangle(W/2,cy+24,PW-20,50,owned?0x112211:canBuy?0x111a2e:0x110a0a)
        .setStrokeStyle(1,owned?0x44ff44:canBuy?0x4488ff:0x442222).setScrollFactor(0).setDepth(depth).setInteractive({useHandCursor:!owned&&canBuy}));
      add(this.add.text(W/2-PW/2+12,cy+6,`${mount.icon} ${mount.name}`,{fontFamily:'"VT323"',fontSize:'16px',color:owned?'#44ff88':canBuy?'#aaaaff':'#664444'}).setScrollFactor(0).setDepth(depth));
      add(this.add.text(W/2-PW/2+12,cy+24,mount.desc,{fontFamily:'"VT323"',fontSize:'12px',color:'#666688'}).setScrollFactor(0).setDepth(depth));
      add(this.add.text(W/2+PW/2-12,cy+18,owned?'RIDING':`${mount.price}💰`,{fontFamily:'"Press Start 2P"',fontSize:'7px',color:owned?'#44ff44':'#ffd700'}).setOrigin(1,0.5).setScrollFactor(0).setDepth(depth));
      if (!owned&&canBuy) {
        bg.on('pointerdown',()=>{
          inv.gold -= mount.price;
          GameState.mount = mount;
          const st = GameState.player?.get('stats');
          if (st) { st.atk += mount.bonusAtk; st.def += mount.bonusDef; }
          GameState.addMessage(`${mount.icon} Now riding ${mount.name}!`,'#4488ff');
          window.showToast(`Mount: ${mount.name} acquired!`,'rare');
          closeAll();
        });
        bg.on('pointerover',()=>bg.setFillStyle(0x1a2a3a));
        bg.on('pointerout',()=>bg.setFillStyle(0x111a2e));
      }
    });

    add(this.add.rectangle(W/2,H/2+PH/2-22,120,32,0x1a1a1a).setStrokeStyle(1,0xff4444).setScrollFactor(0).setDepth(depth).setInteractive({useHandCursor:true}).on('pointerdown',closeAll));
    add(this.add.text(W/2,H/2+PH/2-22,'[ CLOSE ]',{fontFamily:'"Press Start 2P"',fontSize:'8px',color:'#ff4444'}).setOrigin(0.5).setScrollFactor(0).setDepth(depth+1).setInteractive({useHandCursor:true}).on('pointerdown',closeAll));
    this.input.keyboard.once('keydown-ESC',closeAll);
  }

  _showMarket(mkt) {
    const W = this.scale.width, H = this.scale.height;
    const inv = GameState.player?.get('inventory');
    const elements = [];
    const add = o => { elements.push(o); return o; };
    const depth = 210;
    const PW = Math.min(600, W-20), PH = Math.min(520, H-20);
    const closeAll = () => elements.forEach(e=>e.destroy());

    add(this.add.rectangle(W/2,H/2,W,H,0,0.6).setScrollFactor(0).setDepth(depth-1).setInteractive().on('pointerdown',closeAll));
    add(this.add.rectangle(W/2,H/2,PW,PH,0x0a080a,0.97).setStrokeStyle(2,0xffaa44).setScrollFactor(0).setDepth(depth));
    add(this.add.text(W/2,H/2-PH/2+12,`🛒 ${mkt.name}`,{fontFamily:'"Press Start 2P"',fontSize:'10px',color:'#ffaa44'}).setOrigin(0.5,0).setScrollFactor(0).setDepth(depth));
    add(this.add.text(W/2,H/2-PH/2+30,'Prices fluctuate after each dungeon. Buy low, sell high!',{fontFamily:'"VT323"',fontSize:'14px',color:'#888888'}).setOrigin(0.5,0).setScrollFactor(0).setDepth(depth));

    const goldTxt = add(this.add.text(W/2+PW/2-10,H/2-PH/2+12,`💰${inv?.gold||0}g`,{fontFamily:'"Press Start 2P"',fontSize:'8px',color:'#ffd700'}).setOrigin(1,0).setScrollFactor(0).setDepth(depth));

    const COLS_N=3, cellW=(PW-30)/COLS_N, cellH=68;
    MARKET_GOODS.forEach((good, i) => {
      const col=i%COLS_N, row=Math.floor(i/COLS_N);
      const cx=W/2-PW/2+15+col*cellW, cy=H/2-PH/2+52+row*cellH;
      const price = MarketState.getPrice(good);
      const trend = MarketState.getTrend(good);
      const item  = ITEMS[good.itemId];
      const canBuy = (inv?.gold||0)>=price;
      const bg = add(this.add.rectangle(cx+cellW/2,cy+cellH/2,cellW-4,cellH-4,canBuy?0x111a11:0x180808)
        .setStrokeStyle(1,canBuy?0x336633:0x442222).setScrollFactor(0).setDepth(depth).setInteractive({useHandCursor:canBuy}));
      add(this.add.text(cx+4,cy+4,`${good.icon} ${good.name}`,{fontFamily:'"VT323"',fontSize:'14px',color:canBuy?'#ccffcc':'#664444'}).setScrollFactor(0).setDepth(depth));
      add(this.add.text(cx+4,cy+22,item?RARITY_NAME[item.rarity]:'',{fontFamily:'"VT323"',fontSize:'11px',color:'#555577'}).setScrollFactor(0).setDepth(depth));
      add(this.add.text(cx+4,cy+38,`${price}💰`,{fontFamily:'"Press Start 2P"',fontSize:'7px',color:'#ffd700'}).setScrollFactor(0).setDepth(depth));
      add(this.add.text(cx+cellW-8,cy+38,`${trend.arrow}`,{fontFamily:'"Press Start 2P"',fontSize:'8px',color:trend.color}).setOrigin(1,0).setScrollFactor(0).setDepth(depth));
      if (canBuy) {
        bg.on('pointerover',()=>bg.setFillStyle(0x1a2e1a));
        bg.on('pointerout',()=>bg.setFillStyle(0x111a11));
        bg.on('pointerdown',()=>{
          if (!inv||inv.items.length>=inv.maxSize){window.showToast('Inventory full!','warning');return;}
          if (inv.gold<price){window.showToast('Not enough gold!','warning');return;}
          inv.gold-=price;
          inv.items.push({...ITEMS[good.itemId],count:1,identified:true});
          GameState.addMessage(`Bought ${good.name} for ${price}g!`,'#44ff88');
          goldTxt.setText(`💰${inv.gold}g`);
          this._updateHUD();
        });
      }
    });

    // Fluctuate button
    const fluctBtn = add(this.add.rectangle(W/2-60,H/2+PH/2-28,160,32,0x1a1a3a).setStrokeStyle(1,0xffaa44).setScrollFactor(0).setDepth(depth).setInteractive({useHandCursor:true}));
    add(this.add.text(W/2-60,H/2+PH/2-28,'📈 Fluctuate Prices',{fontFamily:'"VT323"',fontSize:'15px',color:'#ffaa44'}).setOrigin(0.5).setScrollFactor(0).setDepth(depth+1).setInteractive({useHandCursor:true}));
    fluctBtn.on('pointerdown',()=>{MarketState.fluctuate();closeAll();this._showMarket(mkt);});

    add(this.add.rectangle(W/2+80,H/2+PH/2-28,120,32,0x1a1a1a).setStrokeStyle(1,0xff4444).setScrollFactor(0).setDepth(depth).setInteractive({useHandCursor:true}).on('pointerdown',closeAll));
    add(this.add.text(W/2+80,H/2+PH/2-28,'[ CLOSE ]',{fontFamily:'"Press Start 2P"',fontSize:'8px',color:'#ff4444'}).setOrigin(0.5).setScrollFactor(0).setDepth(depth+1).setInteractive({useHandCursor:true}).on('pointerdown',closeAll));
    this.input.keyboard.once('keydown-ESC',closeAll);
  }

  update() {
    this._updateHUD();
  }
}

// ═══════════════════════════════════════════
// SCENE: DUNGEON (main gameplay)
// ═══════════════════════════════════════════
class DungeonScene extends Phaser.Scene {
  constructor() { super({ key:'Dungeon' }); }

  create() {
    const W = this.scale.width, H = this.scale.height;
    GameState.phase = 'dungeon';
    this.rng = new RNG(GameState.seed ^ (GameState.floor * 0x1337));

    // Init or use existing floor data
    if (!GameState.floorData) {
      GameState.floorData = generateFloor(GameState.floor, GameState.seed);
    }
    const fd = GameState.floorData;

    // Make sure ECS world exists
    if (!GameState.world) { GameState.world = new World(); }
    const world = GameState.world;

    // Clear monsters from previous floor
    for (const m of world.queryTag('monster')) { world.destroy(m.id); }

    // Camera & containers
    this.mapContainer = this.add.container(0, 0);
    this.entityContainer = this.add.container(0, 0);
    this.fogContainer = this.add.container(0, 0);
    this.effectContainer = this.add.container(0, 0).setDepth(50);
    this.uiContainer = this.add.container(0, 0).setScrollFactor(0).setDepth(100);

    this.cameras.main.setBackgroundColor('#0a0a0f');
    this.cameras.main.setBounds(0, 0, COLS*TS, ROWS*TS);

    // Build tile map visuals
    this._buildTileMap();

    // Spawn player
    this._initPlayer(fd);

    // Spawn monsters
    this._spawnMonsters(fd);

    // Build HUD
    this._buildHUD(W, H);
    // Populate HUD values immediately (not just after first player action)
    this._updateHUD();

    // Build message log
    this._buildMessageLog(W, H);

    // Minimap
    this._buildMinimap(W, H);

    // Input
    this._setupInput();

    // FOV
    this._updateFOV();

    // Spell targeting cursor (hidden by default)
    this.spellCursor = this.add.image(0, 0, 'cursor').setScale(SCALE).setDepth(60).setVisible(false);
    this.entityContainer.add(this.spellCursor);

    // Start HUD scene overlay
    if (!this.scene.isActive('HUD')) {
      this.scene.launch('HUD');
    }

    // Turn state
    this.playerTurn = true;
    this.animating = false;

    // Auto-save on floor entry
    GameState.saveToDB(GameState.saveSlot);

    GameState.addMessage(`Floor ${GameState.floor} — Explore the dungeon!`, '#ff6b35');

    // Floor announcement
    const floorAnn = this.add.text(W/2, H/3, `FLOOR ${GameState.floor}`, {
      fontFamily:'"Press Start 2P"', fontSize:'24px', color:'#ffd700',
      stroke:'#000',strokeThickness:4, scrollFactor:0, depth:200,
    }).setOrigin(0.5);
    this.tweens.add({ targets:floorAnn, alpha:0, y:H/3-40, duration:2000, onComplete:()=>floorAnn.destroy() });
  }

  _buildTileMap() {
    const fd = GameState.floorData;
    this.tileSprites = [];
    this.fogSprites  = [];
    this.chestSprites = {};
    this.trapSprites  = {};

    for (let y=0; y<ROWS; y++) {
      this.tileSprites[y] = [];
      this.fogSprites[y]  = [];
      for (let x=0; x<COLS; x++) {
        const tile = fd.tiles[y][x];
        let key = 'tile_wall';
        switch(tile) {
          case TILE_TYPE.FLOOR:        key='tile_floor'; break;
          case TILE_TYPE.DOOR:         key='tile_door';  break;
          case TILE_TYPE.STAIRS_DOWN:  key='tile_stairs_down'; break;
          case TILE_TYPE.STAIRS_UP:    key='tile_stairs_up'; break;
          case TILE_TYPE.CHEST:        key='tile_chest'; break;
          case TILE_TYPE.TRAP:         key='tile_floor'; break; // traps hidden
          case TILE_TYPE.WATER:        key='tile_water'; break;
          case TILE_TYPE.LAVA:         key='tile_lava';  break;
        }
        const sprite = this.add.image(x*TS + TS/2, y*TS + TS/2, key).setScale(SCALE).setDepth(0);
        this.tileSprites[y][x] = sprite;
        this.mapContainer.add(sprite);

        // Chest tracking
        if (tile === TILE_TYPE.CHEST) {
          this.chestSprites[`${x},${y}`] = sprite;
        }

        // Fog of war
        const fog = this.add.image(x*TS + TS/2, y*TS + TS/2, 'fog').setScale(SCALE).setDepth(20).setAlpha(1);
        this.fogSprites[y][x] = fog;
        this.fogContainer.add(fog);
      }
    }

    // Draw events
    for (const ev of fd.events) {
      const eventIcons = { shrine:'✨', merchant:'🛍', altar:'⚱', fountain:'⛲', library:'📚', forge:'⚒' };
      if (fd.tiles[ev.y][ev.x] >= TILE_TYPE.FLOOR) {
        const lbl = this.add.text(ev.x*TS+TS/2, ev.y*TS+TS/2, eventIcons[ev.type]||'?', {
          fontSize:`${TS/2}px`,
        }).setOrigin(0.5).setDepth(5);
        this.mapContainer.add(lbl);
        ev.sprite = lbl;
      }
    }
  }

  _initPlayer(fd) {
    const p = GameState.player;
    if (!p) return;
    const pos = p.get('pos');
    pos.x = fd.startX;
    pos.y = fd.startY;
    pos.floor = GameState.floor;

    if (!p.get('render')) {
      p.add(C.render('player', 0xffffff, 30));
    }
    const render = p.get('render');

    // ALWAYS create a fresh Phaser sprite — the previous one was destroyed
    // when the scene shut down (restart or start from WorldMap).
    render.sprite = this.add.image(
      pos.x * TS + TS / 2,
      pos.y * TS + TS / 2,
      'player'
    ).setScale(SCALE).setDepth(30);
    this.entityContainer.add(render.sprite);

    // Camera follow player
    this.cameras.main.startFollow(render.sprite, true, 0.1, 0.1);

    // Spawn companion if player has one
    this._spawnCompanion(fd);
  }

  _spawnCompanion(fd) {
    // Remove old companion entity if exists
    if (GameState.companionEntity) {
      const cr = GameState.companionEntity.get('render');
      if (cr) { cr.sprite?.destroy(); cr.hpBg?.destroy(); cr.hpBar?.destroy(); }
      GameState.world.destroy(GameState.companionEntity.id);
      GameState.companionEntity = null;
    }
    const compDef = GameState.companion;
    if (!compDef) return;

    // Place companion next to player start
    const pos = GameState.player.get('pos');
    let cx = pos.x + 1, cy = pos.y;
    if (fd.tiles[cy]?.[cx] !== TILE_TYPE.FLOOR) { cx = pos.x - 1; }
    if (fd.tiles[cy]?.[cx] !== TILE_TYPE.FLOOR) { cx = pos.x; cy = pos.y + 1; }

    const floor = GameState.floor;
    const scale = floorDifficultyScale(floor);
    const e = GameState.world.create();
    e.add(C.pos(cx, cy, floor))
     .add(C.health(Math.round(compDef.hp * scale), Math.round(compDef.hp * scale)))
     .add(C.stats(Math.round(compDef.atk * scale), compDef.def, 1, 0, 2))
     .add(C.status())
     .tag('companion').tag('actor');

    // Sprite
    const cRender = C.render(compDef.sprite || 'player', compDef.color || 0x4488ff, 29);
    e.add(cRender);
    cRender.sprite = this.add.image(cx*TS+TS/2, cy*TS+TS/2, compDef.sprite || 'player')
      .setScale(SCALE).setDepth(29).setTint(compDef.color || 0x4488ff);
    this.entityContainer.add(cRender.sprite);

    // HP bar
    const hpBg  = this.add.rectangle(cx*TS+TS/2, cy*TS+2, TS-4, 3, 0x004400).setDepth(30);
    const hpBar = this.add.rectangle(cx*TS+2, cy*TS+2, TS-4, 3, 0x44ff44).setOrigin(0,0.5).setDepth(31);
    cRender.hpBg = hpBg; cRender.hpBar = hpBar;
    this.entityContainer.add(hpBg); this.entityContainer.add(hpBar);
    cRender.maxHpBarW = TS - 4;

    // Label
    const lbl = this.add.text(cx*TS+TS/2, cy*TS-4, compDef.icon||'⚔', {fontSize:'12px'}).setOrigin(0.5,1).setDepth(32);
    this.entityContainer.add(lbl);
    cRender.label = lbl;

    e.components.compDef = compDef;
    GameState.companionEntity = e;
  }

  _spawnMonsters(fd) {
    const floor = GameState.floor;
    const eligibleMonsters = Object.values(MONSTERS).filter(m =>
      !m.boss &&
      m.floorRange[0] <= floor && m.floorRange[1] >= floor
    );
    const bossMonsters = Object.values(MONSTERS).filter(m =>
      m.boss && m.floorRange[0] <= floor && m.floorRange[1] >= floor
    );

    const totalRooms = fd.rooms.length;
    const monsterCount = Math.min(totalRooms - 1, 5 + Math.floor(floor * 1.5));
    const world = GameState.world;

    fd.monsters = [];

    // Spawn regular monsters in rooms
    const usableRooms = fd.rooms.filter(r => {
      const cx = Math.floor((r.x1+r.x2)/2);
      const cy = Math.floor((r.y1+r.y2)/2);
      return !(cx === fd.startX && cy === fd.startY);
    });

    for (let i=0; i<monsterCount && usableRooms.length>0; i++) {
      const room = this.rng.pick(usableRooms);
      const mx = this.rng.int(room.x1+1, room.x2-1);
      const my = this.rng.int(room.y1+1, room.y2-1);
      if (fd.tiles[my]?.[mx] !== TILE_TYPE.FLOOR) continue;

      // Pick monster (chance for rare)
      let mDef;
      if (this.rng.next() < 0.1) {
        const rares = eligibleMonsters.filter(m=>m.rare);
        mDef = rares.length>0 ? this.rng.pick(rares) : this.rng.pick(eligibleMonsters);
      } else {
        mDef = this.rng.pick(eligibleMonsters);
      }

      const monster = spawnMonster(world, mDef.id, mx, my, floor, this.rng);
      if (!monster) continue;
      const render = C.render(mDef.sprite || 'mob_goblin', mDef.color, 25);
      monster.add(render);
      render.sprite = this.add.image(mx*TS+TS/2, my*TS+TS/2, mDef.sprite||'mob_goblin').setScale(SCALE).setDepth(25).setVisible(false);
      this.entityContainer.add(render.sprite);

      // HP bar
      const hpBg = this.add.rectangle(mx*TS+TS/2, my*TS+2, TS-4, 3, 0x440000).setDepth(26).setVisible(false);
      const hpBar = this.add.rectangle(mx*TS+2, my*TS+2, TS-4, 3, 0xff4444).setOrigin(0,0.5).setDepth(27).setVisible(false);
      render.hpBg  = hpBg;
      render.hpBar = hpBar;
      this.entityContainer.add(hpBg);
      this.entityContainer.add(hpBar);

      fd.monsters.push(monster.id);
    }

    // Spawn boss on floor 5 and 10
    if ((floor === 5 || floor === MAX_FLOORS) && bossMonsters.length > 0) {
      const bossDef = bossMonsters[0];
      const bossRoom = fd.rooms[Math.floor(fd.rooms.length*0.8)];
      const bx = Math.floor((bossRoom.x1+bossRoom.x2)/2);
      const by = Math.floor((bossRoom.y1+bossRoom.y2)/2);
      const boss = spawnMonster(world, bossDef.id, bx, by, floor, this.rng);
      if (boss) {
        const br = C.render(bossDef.sprite||'boss_lich', bossDef.color, 28);
        boss.add(br);
        br.sprite = this.add.image(bx*TS+TS/2, by*TS+TS/2, bossDef.sprite||'boss_lich')
          .setScale(SCALE*1.5).setDepth(28).setVisible(false);
        this.entityContainer.add(br.sprite);
        const hpBg = this.add.rectangle(bx*TS+TS/2, by*TS+2, TS*2, 5, 0x440000).setDepth(29).setVisible(false);
        const hpBar = this.add.rectangle(bx*TS-TS/2, by*TS+2, TS*2, 5, 0xff8800).setOrigin(0,0.5).setDepth(30).setVisible(false);
        br.hpBg = hpBg; br.hpBar = hpBar;
        this.entityContainer.add(hpBg); this.entityContainer.add(hpBar);
        fd.monsters.push(boss.id);
        GameState.addMessage(`⚠ A powerful enemy lurks on this floor!`, '#ff4444');
      }
    }
  }

  _buildHUD(W, H) {
    // Bottom panel — NOT in uiContainer so it stays at depth 90, below bars (91-92)
    const panelH = 80;
    const panel = this.add.rectangle(W/2, H - panelH/2, W, panelH, 0x0a0a1a, 0.97)
      .setScrollFactor(0).setDepth(90);
    panel.setStrokeStyle(1, 0x333355);

    // HP/MP bars
    const p = GameState.player;
    const hp = p?.get('health');
    const st = p?.get('stats');

    // HP bar
    this.add.text(10, H-panelH+8, 'HP', { fontFamily:'"Press Start 2P"', fontSize:'7px', color:'#ff4444' }).setScrollFactor(0).setDepth(91);
    this.hpBarBg = this.add.rectangle(10, H-panelH+22, 140, 10, 0x440000).setOrigin(0,0.5).setScrollFactor(0).setDepth(91);
    this.hpBar   = this.add.rectangle(10, H-panelH+22, 140, 10, 0xff4444).setOrigin(0,0.5).setScrollFactor(0).setDepth(92);
    this.hpText  = this.add.text(155, H-panelH+17, '', { fontFamily:'"VT323"', fontSize:'14px', color:'#ff4444' }).setScrollFactor(0).setDepth(91);

    // MP bar
    this.add.text(10, H-panelH+34, 'MP', { fontFamily:'"Press Start 2P"', fontSize:'7px', color:'#4488ff' }).setScrollFactor(0).setDepth(91);
    this.mpBarBg = this.add.rectangle(10, H-panelH+48, 140, 10, 0x000044).setOrigin(0,0.5).setScrollFactor(0).setDepth(91);
    this.mpBar   = this.add.rectangle(10, H-panelH+48, 140, 10, 0x4488ff).setOrigin(0,0.5).setScrollFactor(0).setDepth(92);
    this.mpText  = this.add.text(155, H-panelH+43, '', { fontFamily:'"VT323"', fontSize:'14px', color:'#4488ff' }).setScrollFactor(0).setDepth(93);

    // XP bar — bg first so bar renders on top
    this.xpBarBg = this.add.rectangle(10, H-panelH+64, 140, 5, 0x224400).setOrigin(0,0.5).setScrollFactor(0).setDepth(91);
    this.xpBar   = this.add.rectangle(10, H-panelH+64, 140, 5, 0x88ff44).setOrigin(0,0.5).setScrollFactor(0).setDepth(92);
    this.xpText  = this.add.text(155, H-panelH+60, '', { fontFamily:'"VT323"', fontSize:'12px', color:'#88ff44' }).setScrollFactor(0).setDepth(93);

    // Stats block (ATK/DEF/MAG/LVL/Gold)
    this.statsText = this.add.text(230, H-panelH+6, '', {
      fontFamily:'"VT323"', fontSize:'14px', color:'#ccccee', lineSpacing:2,
    }).setScrollFactor(0).setDepth(93);

    // Floor number + turn counter (centre of HUD)
    this.floorText = this.add.text(W/2, H-panelH+6, '', {
      fontFamily:'"Press Start 2P"', fontSize:'7px', color:'#ffd700',
    }).setOrigin(0.5, 0).setScrollFactor(0).setDepth(93);

    // Status effects display
    this.statusIcons = [];
    for (let i=0;i<6;i++) {
      const ico = this.add.text(W-10-(i+1)*28, H-panelH+10, '', {
        fontFamily:'"VT323"', fontSize:'20px',
      }).setScrollFactor(0).setDepth(91);
      this.statusIcons.push(ico);
    }

    // Quick spells
    this.spellSlots = [];
    const skills = GameState.player?.get('skills');
    for (let i=0; i<4; i++) {
      const sx = W/2 + 120 + i*52, sy = H-panelH/2;
      const slot = this.add.rectangle(sx, sy, 44, 44, 0x1a1a3a, 0.9).setScrollFactor(0).setDepth(91);
      slot.setStrokeStyle(1, 0x334466);
      const slotTxt = this.add.text(sx, sy, '', {
        fontFamily:'"VT323"', fontSize:'20px', color:'#ccccee'
      }).setOrigin(0.5).setScrollFactor(0).setDepth(92);
      const slotKey = this.add.text(sx, sy+18, `F${i+1}`, {
        fontFamily:'"VT323"', fontSize:'10px', color:'#666688'
      }).setOrigin(0.5).setScrollFactor(0).setDepth(92);
      slot.setInteractive({ useHandCursor:true });
      const spellIds = Object.keys(SPELLS);
      slot.on('pointerdown', () => {
        if (skills && skills.known) {
          const knownSpells = skills.known.filter(s => SPELLS[s.id]);
          if (knownSpells[i]) {
            GameState.selectedSpell = knownSpells[i].id;
            GameState.targeting = true;
            this.spellCursor.setVisible(true);
            GameState.addMessage(`Targeting ${SPELLS[knownSpells[i].id].name}. Click target or press F.`, '#aaaaff');
          }
        }
      });
      this.spellSlots.push({ slot, slotTxt, slotKey });
    }

    // Inventory button
    const invBtn = this.add.text(W-10, H-panelH+10, '[I]', {
      fontFamily:'"Press Start 2P"', fontSize:'9px', color:'#ccccee',
      backgroundColor:'#1a1a3a', padding:{x:5,y:3},
    }).setOrigin(1,0).setScrollFactor(0).setDepth(91).setInteractive({useHandCursor:true});
    invBtn.on('pointerdown', () => { InventoryScene._page='inventory'; this.scene.launch('Inventory'); });

    const skillBtn = this.add.text(W-10, H-panelH+30, '[T]', {
      fontFamily:'"Press Start 2P"', fontSize:'9px', color:'#88ff88',
      backgroundColor:'#1a1a3a', padding:{x:5,y:3},
    }).setOrigin(1,0).setScrollFactor(0).setDepth(91).setInteractive({useHandCursor:true});
    skillBtn.on('pointerdown', () => this.scene.launch('SkillTree'));

    const mapBtn = this.add.text(W-10, H-panelH+50, '[M]', {
      fontFamily:'"Press Start 2P"', fontSize:'9px', color:'#ffd700',
      backgroundColor:'#1a1a3a', padding:{x:5,y:3},
    }).setOrigin(1,0).setScrollFactor(0).setDepth(91).setInteractive({useHandCursor:true});
    mapBtn.on('pointerdown', () => {
      GameState.inDungeon = false;
      this.scene.start('WorldMap');
    });

    this._updateHUD();
  }

  _buildMessageLog(W, H) {
    this.msgLogContainer = this.add.container(0, 0).setScrollFactor(0).setDepth(85);
    const logH = 80;
    // transparent bg
    const bg = this.add.rectangle(W/2, logH/2, W*0.5, logH, 0x000000, 0.5).setScrollFactor(0);
    this.msgLogContainer.add(bg);
    this.msgLines = [];
    for (let i=0;i<4;i++) {
      const line = this.add.text(W*0.25+5, 5+i*18, '', {
        fontFamily:'"VT323"', fontSize:'14px', color:'#ccccee',
      }).setScrollFactor(0);
      this.msgLines.push(line);
      this.msgLogContainer.add(line);
    }
  }

  // ─────────────────────────────────────────
  // MINIMAP
  // ─────────────────────────────────────────
  _buildMinimap(W, H) {
    const MM_COLS = COLS;
    const MM_ROWS = ROWS;
    const CELL = 3;  // px per tile on minimap
    const mmW = MM_COLS * CELL;
    const mmH = MM_ROWS * CELL;
    const padH = 84; // bottom HUD height
    const mx = W - mmW - 6;
    const my = 6;

    // Background
    this._mmBg = this.add.rectangle(mx + mmW/2, my + mmH/2, mmW + 4, mmH + 4, 0x000000, 0.85)
      .setScrollFactor(0).setDepth(95).setStrokeStyle(1, 0x333355);

    // Render target (texture updated each turn)
    if (this.textures.exists('minimap_canvas')) this.textures.remove('minimap_canvas');
    this._mmCanvas = this.textures.createCanvas('minimap_canvas', mmW, mmH);
    this._mmImage  = this.add.image(mx + mmW/2, my + mmH/2, 'minimap_canvas')
      .setScrollFactor(0).setDepth(96).setOrigin(0.5);

    // Player dot (drawn on top)
    this._mmPlayer = this.add.rectangle(0, 0, CELL + 1, CELL + 1, 0xffff00)
      .setScrollFactor(0).setDepth(97);

    // Store for later
    this._mmOrigin = { x: mx, y: my };
    this._mmCell   = CELL;

    // Label
    this.add.text(mx, my - 12, `FLOOR ${GameState.floor}/${MAX_FLOORS}`, {
      fontFamily:'"Press Start 2P"', fontSize:'6px', color:'#ffd700'
    }).setScrollFactor(0).setDepth(97);

    // Toggle: press M to show/hide minimap
    this._mmVisible = true;
    this.input.keyboard.on('keydown-M', () => {
      this._mmVisible = !this._mmVisible;
      this._mmBg.setVisible(this._mmVisible);
      this._mmImage.setVisible(this._mmVisible);
      this._mmPlayer.setVisible(this._mmVisible);
    });

    this._drawMinimap();
  }

  _drawMinimap() {
    if (!this._mmCanvas) return;
    const ctx   = this._mmCanvas.getContext();
    const fd    = GameState.floorData;
    const fov   = GameState.player?.get('fov');
    const pPos  = GameState.player?.get('pos');
    const CELL  = this._mmCell;
    const ox    = this._mmOrigin.x;
    const oy    = this._mmOrigin.y;

    ctx.clearRect(0, 0, COLS * CELL, ROWS * CELL);

    // TILE_TYPE color map for minimap
    const TILE_COLORS = {
      [TILE_TYPE.WALL]:       '#1a1a2e',
      [TILE_TYPE.FLOOR]:      '#3a3a5a',
      [TILE_TYPE.DOOR]:       '#8B5A2B',
      [TILE_TYPE.STAIRS_DOWN]:'#ff6b35',
      [TILE_TYPE.STAIRS_UP]:  '#44ff88',
      [TILE_TYPE.CHEST]:      '#ffd700',
      [TILE_TYPE.TRAP]:       '#ff4444',
      [TILE_TYPE.WATER]:      '#1a4488',
      [TILE_TYPE.LAVA]:       '#882200',
    };

    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        const key  = `${x},${y}`;
        const vis  = fov?.visible.has(key);
        const exp  = fov?.explored.has(key);
        if (!exp && !vis) continue;

        const tile  = fd.tiles[y][x];
        const col   = TILE_COLORS[tile] || '#2a2a3a';
        ctx.fillStyle = vis ? col : this._dimColor(col, 0.4);
        ctx.fillRect(x * CELL, y * CELL, CELL, CELL);
      }
    }

    // Draw visible monsters as red dots
    for (const id of fd.monsters) {
      const m = GameState.world.entities.get(id);
      if (!m) continue;
      const mp  = m.get('pos');
      const key = mp ? `${mp.x},${mp.y}` : '';
      if (!mp || !fov?.visible.has(key)) continue;
      const isBoss = m.hasTag('boss');
      ctx.fillStyle = isBoss ? '#ff8800' : '#ff3333';
      ctx.fillRect(mp.x * CELL, mp.y * CELL, CELL, CELL);
    }

    this._mmCanvas.refresh();

    // Move player dot
    if (pPos && this._mmPlayer) {
      this._mmPlayer.setPosition(
        ox + pPos.x * CELL + CELL / 2,
        oy + pPos.y * CELL + CELL / 2
      );
    }
  }

  _dimColor(hex, factor) {
    // darken a hex color string by factor (0–1)
    const n = parseInt(hex.replace('#',''), 16);
    const r = Math.round(((n>>16)&255) * factor);
    const g = Math.round(((n>>8)&255)  * factor);
    const b = Math.round((n&255)        * factor);
    return `rgb(${r},${g},${b})`;
  }

  _setupInput() {
    const cursors = this.input.keyboard.createCursorKeys();
    const wasd = this.input.keyboard.addKeys({
      w: Phaser.Input.Keyboard.KeyCodes.W,
      a: Phaser.Input.Keyboard.KeyCodes.A,
      s: Phaser.Input.Keyboard.KeyCodes.S,
      d: Phaser.Input.Keyboard.KeyCodes.D,
    });

    const moveKeys = {
      up:    { cursors: cursors.up,    wasd: wasd.w, dx:0, dy:-1 },
      down:  { cursors: cursors.down,  wasd: wasd.s, dx:0, dy:1  },
      left:  { cursors: cursors.left,  wasd: wasd.a, dx:-1,dy:0  },
      right: { cursors: cursors.right, wasd: wasd.d, dx:1, dy:0  },
    };

    this.moveKeys = moveKeys;
    this._keyRepeatTimer = null;
    this._lastMoveDir = null;

    this.input.keyboard.on('keydown', (event) => {
      if (!this.playerTurn || this.animating) return;
      switch(event.code) {
        case 'ArrowUp':   case 'KeyW': case 'Numpad8': this._tryMove(0,-1); break;
        case 'ArrowDown': case 'KeyS': case 'Numpad2': this._tryMove(0, 1); break;
        case 'ArrowLeft': case 'KeyA': case 'Numpad4': this._tryMove(-1,0); break;
        case 'ArrowRight':case 'KeyD': case 'Numpad6': this._tryMove(1, 0); break;
        // Diagonal
        case 'Numpad7': this._tryMove(-1,-1); break;
        case 'Numpad9': this._tryMove( 1,-1); break;
        case 'Numpad1': this._tryMove(-1, 1); break;
        case 'Numpad3': this._tryMove( 1, 1); break;
        // Wait
        case 'Space': case 'Period': case 'Numpad5': this._endPlayerTurn(); break;
        // Pickup
        case 'KeyG': this._pickupItem(); break;
        // Stairs
        case 'KeyE': case 'Comma': this._useStairs(); break;
        // Quicksave
        case 'KeyQ': this._quickSave(); break;
        // Cast spell
        case 'KeyF': this._castSelectedSpell(); break;
        // Escape targeting
        case 'Escape':
          if (GameState.targeting) {
            GameState.targeting = false; GameState.selectedSpell = null;
            this.spellCursor.setVisible(false);
            GameState.addMessage('Targeting cancelled.', '#888888');
          }
          break;
        // Open Inventory
        case 'KeyI': InventoryScene._page='inventory'; this.scene.launch('Inventory'); break;
        // Skill tree — use T (S is reserved for movement)
        case 'KeyT': this.scene.launch('SkillTree'); break;
      }
    });

    // Mouse/touch for spell targeting
    this.input.on('pointerdown', (pointer) => {
      if (!GameState.targeting) return;
      const wx = this.cameras.main.scrollX + pointer.x;
      const wy = this.cameras.main.scrollY + pointer.y;
      const tx = Math.floor(wx / TS);
      const ty = Math.floor(wy / TS);
      this._castSpellAt(tx, ty);
    });

    // Mouse move for targeting cursor
    this.input.on('pointermove', (pointer) => {
      if (!GameState.targeting) return;
      const wx = this.cameras.main.scrollX + pointer.x;
      const wy = this.cameras.main.scrollY + pointer.y;
      const tx = Math.floor(wx / TS);
      const ty = Math.floor(wy / TS);
      this.spellCursor.setPosition(tx*TS+TS/2, ty*TS+TS/2);
    });

    // ── Touch / Mobile controls ────────────────────────────────────
    this._buildTouchControls();
  }

  _buildTouchControls() {
    const W = this.scale.width, H = this.scale.height;
    // Always build touch controls - they work with mouse too on desktop
    // Users can hide them with the toggle button

    const panelH = 80; // HUD height
    const btnSize = 52;
    const padX = 70, padY = H - panelH - 10;

    const btnAlpha = 0.55;
    const btnColor = 0x222244;
    const arrowStyle = { fontFamily:'"VT323"', fontSize:'28px', color:'#aaaaff' };

    const makeBtn = (x, y, label, action) => {
      const btn = this.add.rectangle(x, y, btnSize, btnSize, btnColor, btnAlpha)
        .setScrollFactor(0).setDepth(200).setStrokeStyle(1, 0x4444aa)
        .setInteractive({ useHandCursor:true });
      const txt = this.add.text(x, y, label, arrowStyle).setOrigin(0.5).setScrollFactor(0).setDepth(201);
      btn.on('pointerdown', action);
      btn.on('pointerover', () => btn.setFillStyle(0x3333aa, 0.8));
      btn.on('pointerout',  () => btn.setFillStyle(btnColor, btnAlpha));
      return btn;
    };

    // D-pad left side — movement
    makeBtn(padX,        padY - btnSize,   '▲', () => this._tryMove( 0,-1));
    makeBtn(padX,        padY,             '▼', () => this._tryMove( 0, 1));
    makeBtn(padX - btnSize, padY - btnSize/2, '◀', () => this._tryMove(-1, 0));
    makeBtn(padX + btnSize, padY - btnSize/2, '▶', () => this._tryMove( 1, 0));
    makeBtn(padX,        padY - btnSize/2, '·', () => this._endPlayerTurn()); // wait

    // Diagonal buttons (small)
    makeBtn(padX - btnSize, padY - btnSize*1.5, '↖', () => this._tryMove(-1,-1));
    makeBtn(padX + btnSize, padY - btnSize*1.5, '↗', () => this._tryMove( 1,-1));
    makeBtn(padX - btnSize, padY + btnSize*0.5, '↙', () => this._tryMove(-1, 1));
    makeBtn(padX + btnSize, padY + btnSize*0.5, '↘', () => this._tryMove( 1, 1));

    // Action buttons right side
    const ax = W - 70, ay = padY - btnSize/2;
    makeBtn(ax,            ay - btnSize,   'I',  () => { InventoryScene._page='inventory'; this.scene.launch('Inventory'); });
    makeBtn(ax - btnSize,  ay - btnSize,   'T',  () => this.scene.launch('SkillTree'));
    makeBtn(ax,            ay,             'G',  () => this._pickupItem());
    makeBtn(ax - btnSize,  ay,             'E',  () => this._useStairs());
    makeBtn(ax - btnSize/2, ay - btnSize*2,'F',  () => {
      const skills = GameState.player?.get('skills');
      const known  = (skills?.known||[]).filter(s=>SPELLS[s.id]);
      if (known.length > 0) {
        GameState.selectedSpell = known[0].id;
        GameState.targeting = true;
        this.spellCursor.setVisible(true);
        GameState.addMessage(`Targeting ${SPELLS[known[0].id]?.name}. Tap target.`, '#aaaaff');
      }
    });

    // Collect all touch UI objects for toggle
    const touchObjects = [];
    // (all makeBtn calls above added to scene — capture them via a wrapper)

    // Status strip above D-pad: mount + companion
    const statusY = H - panelH - 28;
    if (GameState.mount) {
      this.add.text(padX, statusY, `${GameState.mount.icon}${GameState.mount.name}`,
        {fontFamily:'"VT323"', fontSize:'12px', color:'#88ccff'}).setOrigin(0.5).setScrollFactor(0).setDepth(200);
    }
    if (GameState.companion) {
      this.add.text(padX, statusY - 16, `${GameState.companion.icon}${GameState.companion.name}`,
        {fontFamily:'"VT323"', fontSize:'12px', color:'#88ff88'}).setOrigin(0.5).setScrollFactor(0).setDepth(200);
    }
  }

  _tryMove(dx, dy, _stepN = 0) {
    const p = GameState.player;
    if (!p) return;
    const pos = p.get('pos');
    const nx = pos.x + dx, ny = pos.y + dy;
    if (nx<0||nx>=COLS||ny<0||ny>=ROWS) return;

    const fd  = GameState.floorData;
    const tile = fd.tiles[ny][nx];
    const mount = GameState.mount;

    // Check for monsters at target
    const monsters = GameState.world.queryTag('monster');
    const target = monsters.find(m => { const mp=m.get('pos'); return mp && mp.x===nx && mp.y===ny; });
    if (target) {
      this._attackMonster(target);
      return;
    }

    // Passability — respect mount bonuses
    if (tile === TILE_TYPE.WALL && !(mount?.wallWalk)) return;
    if (tile === TILE_TYPE.LAVA && !(mount?.lavaImmune)) {
      // still allow stepping but hurt them (unless immune)
    }

    // Move player
    pos.x = nx; pos.y = ny;
    const render = p.get('render');
    if (render?.sprite) {
      this.tweens.add({
        targets: render.sprite,
        x: nx*TS+TS/2, y: ny*TS+TS/2,
        duration: 80, ease:'Linear',
      });
    }

    // Tile effects — skip traps if mount is trap-immune
    this._checkTileInteraction(nx, ny, fd, mount);

    // Mount multi-step: move extra tiles per turn
    const stepsPerTurn = mount?.stepsPerTurn || 1;
    if (_stepN + 1 < stepsPerTurn) {
      // Move one more step in the same direction (don't end turn yet)
      this._tryMove(dx, dy, _stepN + 1);
      return;
    }

    this._endPlayerTurn();
  }

  _checkTileInteraction(x, y, fd, mount = null) {
    const p = GameState.player;
    const tile = fd.tiles[y][x];

    // Traps — skip if mount is trap-immune
    if (!mount?.trapImmune) {
      const trap = fd.traps.find(t => t.x===x && t.y===y && !t.triggered);
      if (trap) {
        trap.triggered = true;
        const dmg = trap.damage;
        applyDamage(p, dmg);
        GameState.addMessage(`⚠ Triggered a trap! -${dmg} HP!`, '#ff4444');
        this._showDamageNumber(x, y, dmg, '#ff4444');
        if (this.tileSprites[y][x]) this.tileSprites[y][x].setTexture('tile_trap');
      }
    } else {
      // Silently disable trap even if immune
      const trap = fd.traps.find(t => t.x===x && t.y===y && !t.triggered);
      if (trap) trap.triggered = true;
    }

    // Lava — skip damage if mount is lava-immune
    if (tile === TILE_TYPE.LAVA && !mount?.lavaImmune) {
      applyDamage(p, 5);
      applyStatus(p, 'burn');
      GameState.addMessage('🔥 You step on lava! -5 HP!', '#ff4400');
      this._showDamageNumber(x, y, 5, '#ff4400');
    }

    // Water
    if (tile === TILE_TYPE.WATER && !mount?.waterWalk) {
      GameState.addMessage('Wading through water...', '#4488ff');
    }

    // Events
    const event = fd.events.find(e => e.x===x && e.y===y && !e.used);
    if (event) {
      this._triggerEvent(event, fd);
    }
  }

  _triggerEvent(event, fd) {
    event.used = true;
    if (event.sprite) { event.sprite.destroy(); event.sprite = null; }
    const p = GameState.player;
    const hp = p.get('health');
    const st = p.get('stats');
    const inv = p.get('inventory');
    const skills = p.get('skills');

    switch(event.type) {
      case 'shrine':
        applyHeal(p, 30);
        GameState.addMessage('✨ You pray at the shrine. +30 HP!', '#00ff88');
        break;
      case 'merchant': {
        const rItem = rollRarityItem(this.rng, GameState.floor);
        if (rItem && inv.items.length < inv.maxSize) {
          inv.items.push(rItem);
          GameState.addMessage(`🛍 Wandering merchant gifts you: ${rItem.name}!`, RARITY_COLOR[rItem.rarity]);
        }
        break;
      }
      case 'altar':
        if (skills) { skills.points++; GameState.addMessage('⚱ Blessed altar! +1 Skill Point!', '#aa44ff'); }
        break;
      case 'fountain': {
        if (hp) hp.hp = hp.maxHp;
        if (st) st.mp = st.maxMp || 30;
        GameState.addMessage('⛲ Magic fountain restores you to full!', '#4488ff');
        break;
      }
      case 'library': {
        const spellKeys = Object.keys(SPELLS);
        const sk = this.rng.pick(spellKeys);
        if (skills && !skills.known.find(s=>s.id===sk)) {
          skills.known.push({ id:sk, level:1 });
          GameState.addMessage(`📚 Library teaches you: ${SPELLS[sk].name}!`, '#aa88ff');
        }
        break;
      }
      case 'forge': {
        if (inv) {
          inv.gold += 20 + GameState.floor * 5;
          GameState.addMessage(`⚒ Forge yields ${20+GameState.floor*5} gold!`, '#ffd700');
        }
        break;
      }
    }
  }

  _attackMonster(monster) {
    const p = GameState.player;
    const skills = p.get('skills');
    let options = {};

    // Check if power strike is active
    if (skills) {
      const ps = skills.known.find(s=>s.id==='power_strike');
      if (ps) options.powerStrike = true, options.powerStrikeLevel = ps.level;
      const holy = skills.known.find(s=>s.id==='holy_strike');
      if (holy) {
        options.holy = true;
        // holy deals MAG bonus
        const mag = p.get('stats')?.mag || 0;
        options.holyBonus = mag;
      }
    }

    const result = calcCombat(p, monster, this.rng, options);
    const mPos = monster.get('pos');
    const mDef = monster.components?.monsterDef;

    if (result.evaded) {
      GameState.addMessage(`${mDef?.name||'Enemy'} evades your attack!`, '#888888');
      this._showFloatingText(mPos.x, mPos.y, 'EVADE', '#888888');
    } else if (result.miss) {
      GameState.addMessage(`You miss ${mDef?.name||'the enemy'}!`, '#888888');
      this._showFloatingText(mPos.x, mPos.y, 'MISS', '#888888');
    } else {
      const dead = applyDamage(monster, result.damage);
      const critTxt = result.crit ? ' [CRIT!]' : '';
      const instaTxt = result.instakill ? ' [INSTANT KILL!]' : '';
      GameState.addMessage(`You hit ${mDef?.name||'enemy'} for ${result.damage} damage!${critTxt}${instaTxt}`, result.crit ? '#ffff00' : '#ff8888');
      this._showDamageNumber(mPos.x, mPos.y, result.damage, result.crit ? '#ffff00' : '#ff4444');

      if (dead || result.instakill) {
        this._killMonster(monster);
      } else {
        // Flash monster red
        const render = monster.get('render');
        if (render?.sprite) {
          this.tweens.add({ targets:render.sprite, tint:0xff0000, duration:100, yoyo:true,
            onComplete:()=>render.sprite?.setTint(render.tint||0xffffff) });
        }
        this._updateMonsterHP(monster);
      }
    }
    this._endPlayerTurn();
  }

  _killMonster(monster) {
    const mDef = monster.components?.monsterDef;
    const mPos = monster.get('pos');
    const p = GameState.player;
    const st = p.get('stats');
    const inv = p.get('inventory');
    const lootComp = monster.get('loot');

    // Drop loot
    const drops = rollLoot(lootComp?.table||'common', this.rng, GameState.floor);
    for (const item of drops) {
      if (inv.items.length < inv.maxSize) {
        inv.items.push(item);
        GameState.addMessage(`Found: ${item.icon||'•'} ${item.name}!`,
          item.rarity >= RARITY.RARE ? RARITY_COLOR[item.rarity] : '#ccccee');
        // Rare+ show toast
        if (item.rarity >= RARITY.RARE) window.showToast(`${item.icon} ${item.name} dropped!`,
          ['','','rare','epic','legendary'][item.rarity]);
      }
    }

    // Gold drop
    if (monster.gold) {
      const goldMul = p.get('skills')?.known.find(s=>s.id==='pickpocket') ? 1.5 : 1;
      const gold = Math.round(monster.gold * goldMul);
      inv.gold += gold;
      GameState.addMessage(`+${gold} gold!`, '#ffd700');
    }

    // XP
    if (st && monster.xpReward) {
      st.xp += monster.xpReward;
      GameState.addMessage(`+${monster.xpReward} XP!`, '#88ff44');
      this._showFloatingText(mPos.x, mPos.y, `+${monster.xpReward}XP`, '#88ff44');
      this._checkLevelUp(st);
    }

    // Market prices fluctuate after boss kills
    if (monster.hasTag('boss')) {
      MarketState.fluctuate();
      GameState.addMessage('📈 Market prices have shifted!', '#ffaa44');
    }

    // Death effect
    const render = monster.get('render');
    if (render?.sprite) {
      this.tweens.add({
        targets:[render.sprite, render.hpBg, render.hpBar],
        alpha:0, scaleY:0, duration:300,
        onComplete:() => {
          render.sprite?.destroy();
          render.hpBg?.destroy();
          render.hpBar?.destroy();
        }
      });
    }

    GameState.addMessage(`${mDef?.name||'Enemy'} defeated!`, mDef?.boss ? '#ffd700' : '#ff6b35');
    if (mDef?.boss) window.showToast(`Boss defeated: ${mDef.name}!`, 'legendary');

    // Remove from world
    GameState.world.destroy(monster.id);
    const idx = GameState.floorData.monsters.indexOf(monster.id);
    if (idx >= 0) GameState.floorData.monsters.splice(idx, 1);
  }

  _checkLevelUp(stats) {
    if (stats.xp >= stats.xpNext) {
      stats.level++;
      stats.xp -= stats.xpNext;
      stats.xpNext = Math.floor(stats.xpNext * 1.5);
      stats.atk += 2;
      stats.def += 1;
      stats.mag += 1;
      stats.luk += 1;
      const hp = GameState.player.get('health');
      if (hp) { hp.maxHp += 10; hp.hp = hp.maxHp; }
      if (stats.mp !== undefined) { stats.maxMp = (stats.maxMp||30) + 5; stats.mp = stats.maxMp; }
      // Skill points
      const sk = GameState.player.get('skills');
      if (sk) sk.points++;
      GameState.addMessage(`🎉 LEVEL UP! Now level ${stats.level}! Stats increased!`, '#ffd700');
      window.showToast(`Level Up! Now level ${stats.level}!`, 'legendary');

      // Level up visual
      const pPos = GameState.player.get('pos');
      this._showFloatingText(pPos.x, pPos.y, 'LEVEL UP!', '#ffd700');
    }
  }

  _updateMonsterHP(monster) {
    const hp = monster.get('health');
    const render = monster.get('render');
    if (!hp || !render?.hpBar) return;
    const ratio = hp.hp / hp.maxHp;
    render.hpBar.setScale(ratio, 1);
    render.hpBar.setFillStyle(ratio > 0.5 ? 0xff4444 : ratio > 0.25 ? 0xff8800 : 0xff0000);
  }

  _pickupItem() {
    const p = GameState.player;
    const pos = p.get('pos');
    const inv = p.get('inventory');
    const fd = GameState.floorData;

    // Check for items on floor (ground items)
    const item = fd.groundItems?.find(gi => gi.x===pos.x && gi.y===pos.y);
    if (item) {
      if (inv.items.length < inv.maxSize) {
        inv.items.push({ ...item.item });
        fd.groundItems = fd.groundItems.filter(gi => gi !== item);
        item.sprite?.destroy();
        GameState.addMessage(`Picked up: ${item.item.name}!`, '#00ff88');
        this._endPlayerTurn();
      } else {
        GameState.addMessage('Inventory full!', '#ff4444');
      }
      return;
    }
    // Check chest
    const chestKey = `${pos.x},${pos.y}`;
    const chest = fd.chests.find(c => c.x===pos.x && c.y===pos.y && !c.opened);
    if (chest) {
      this._openChest(chest);
      this._endPlayerTurn();
    }
  }

  _openChest(chest) {
    chest.opened = true;
    const drops = rollLoot(chest.rarity, this.rng, GameState.floor);
    const inv = GameState.player.get('inventory');
    for (const item of drops) {
      if (inv.items.length < inv.maxSize) {
        inv.items.push(item);
        GameState.addMessage(`Chest: ${item.icon||'•'} ${item.name}!`, RARITY_COLOR[item.rarity]);
        if (item.rarity >= RARITY.RARE) window.showToast(`${item.icon} ${item.name} from chest!`,
          ['','','rare','epic','legendary'][item.rarity]);
      }
    }
    // Add gold
    const gold = this.rng.int(5, 20 + GameState.floor * 3);
    inv.gold += gold;
    GameState.addMessage(`+${gold} gold from chest!`, '#ffd700');
    // Change sprite
    const sprite = this.chestSprites[`${chest.x},${chest.y}`];
    if (sprite) { sprite.setAlpha(0.5); sprite.setTint(0x888888); }
    GameState.floorData.tiles[chest.y][chest.x] = TILE_TYPE.FLOOR;
  }

  _cleanupForRestart() {
    // Null player sprite refs
    const pr = GameState.player?.get('render');
    if (pr) { pr.sprite = null; pr.hpBg = null; pr.hpBar = null; }

    // Clean companion
    if (GameState.companionEntity) {
      const cr = GameState.companionEntity.get('render');
      if (cr) { cr.sprite = null; cr.hpBg = null; cr.hpBar = null; cr.label = null; }
      GameState.world.destroy(GameState.companionEntity.id);
      GameState.companionEntity = null;
    }

    // Remove all monster entities from ECS so _spawnMonsters starts clean
    const monsters = GameState.world.queryTag('monster');
    for (const m of monsters) {
      const r = m.get('render');
      if (r) { r.sprite = null; r.hpBg = null; r.hpBar = null; }
      GameState.world.destroy(m.id);
    }
    if (GameState.floorData) GameState.floorData.monsters = [];
  }

  _useStairs() {
    const p = GameState.player;
    const pos = p.get('pos');
    const fd = GameState.floorData;
    const tile = fd.tiles[pos.y][pos.x];

    if (tile === TILE_TYPE.STAIRS_DOWN) {
      if (GameState.floor >= MAX_FLOORS) {
        GameState.addMessage('You have reached the deepest floor! Face the final boss!', '#ffd700');
        return;
      }
      GameState.floor++;
      GameState.addMessage(`Descending to floor ${GameState.floor}...`, '#ff6b35');
      GameState.floorData = generateFloor(GameState.floor, GameState.seed ^ (GameState.currentDungeon?.id||0));
      this._cleanupForRestart();
      this.scene.restart();
    } else if (tile === TILE_TYPE.STAIRS_UP) {
      if (GameState.floor <= 1) {
        GameState.addMessage('Returning to world map...', '#88ff88');
        GameState.inDungeon = false;
        // Null all Phaser refs so DungeonScene.create() rebuilds them clean on next entry
        const pr = GameState.player?.get('render');
        if (pr) { pr.sprite = null; pr.hpBg = null; pr.hpBar = null; }
        const monsters = GameState.world?.queryTag('monster') || [];
        for (const m of monsters) {
          const r = m.get('render');
          if (r) { r.sprite = null; r.hpBg = null; r.hpBar = null; }
          GameState.world.destroy(m.id);
        }
        if (GameState.floorData) GameState.floorData.monsters = [];
        this.scene.start('WorldMap');
        return;
      }
      GameState.floor--;
      GameState.addMessage(`Ascending to floor ${GameState.floor}...`, '#88ff88');
      GameState.floorData = generateFloor(GameState.floor, GameState.seed ^ (GameState.currentDungeon?.id||0));
      this._cleanupForRestart();
      this.scene.restart();
    } else {
      // Check if there's stairs nearby (hint)
      const p2 = GameState.player;
      const pos2 = p2.get('pos');
      const fd2 = GameState.floorData;
      const hasDown = fd2.stairsDown && Math.abs(fd2.stairsDown.x-pos2.x)+Math.abs(fd2.stairsDown.y-pos2.y) < 3;
      const hasUp   = fd2.stairsUp   && Math.abs(fd2.stairsUp.x  -pos2.x)+Math.abs(fd2.stairsUp.y  -pos2.y) < 3;
      if (hasDown) GameState.addMessage('Stairs down nearby — move onto ▼ and press E.', '#ff8844');
      else if (hasUp) GameState.addMessage('Stairs up nearby — move onto ▲ and press E.', '#88ff88');
      else GameState.addMessage('No stairs here! Walk to the ▼▲ tile.', '#888888');
    }
  }

  _castSelectedSpell() {
    if (!GameState.selectedSpell || !GameState.targeting) {
      // Select first known spell
      const skills = GameState.player?.get('skills');
      if (skills?.known?.length > 0) {
        const first = skills.known.find(s => SPELLS[s.id]);
        if (first) {
          GameState.selectedSpell = first.id;
          GameState.targeting = true;
          this.spellCursor.setVisible(true);
          GameState.addMessage(`Targeting ${SPELLS[first.id].name}. Click or press F again.`, '#aaaaff');
        }
      }
      return;
    }
    // Cast at cursor position
    const p = GameState.player;
    const pos = p.get('pos');
    this._castSpellAt(Math.round(this.spellCursor.x/TS - 0.5), Math.round(this.spellCursor.y/TS - 0.5));
  }

  _castSpellAt(tx, ty) {
    const spell = SPELLS[GameState.selectedSpell];
    if (!spell) return;
    const p = GameState.player;
    const st = p.get('stats');
    const pPos = p.get('pos');

    // Check MP
    const mpCost = spell.mpCost;
    if ((st.mp||0) < mpCost) {
      GameState.addMessage('Not enough MP!', '#ff4444');
      window.showToast('Not enough MP!', 'warning');
      return;
    }

    // Check range
    const dist = Math.abs(pPos.x-tx) + Math.abs(pPos.y-ty);
    if (spell.range > 0 && dist > spell.range) {
      GameState.addMessage('Target out of range!', '#ff4444');
      return;
    }

    // Find target entity
    let targetEntity = null;
    for (const m of GameState.world.queryTag('monster')) {
      const mp = m.get('pos');
      if (mp && mp.x===tx && mp.y===ty) { targetEntity = m; break; }
    }

    const target = { x:tx, y:ty, entity:targetEntity };
    const results = castSpell(p, GameState.selectedSpell, target, GameState.world, GameState.floorData, this.rng);

    // Deduct MP
    st.mp = Math.max(0, (st.mp||0) - mpCost);

    // Visual effects
    this._spellEffect(GameState.selectedSpell, pPos, { x:tx, y:ty }, spell);

    // Process results
    if (results) {
      for (const res of results) {
        if (res.damage && res.entity) {
          const mp = res.entity.get('pos');
          if (mp) this._showDamageNumber(mp.x, mp.y, res.damage, spell.color || 0xffffff);
          if (res.dead) this._killMonster(res.entity);
          else this._updateMonsterHP(res.entity);
        }
        if (res.heal) {
          const pp = p.get('pos');
          this._showFloatingText(pp.x, pp.y, `+${res.heal}HP`, '#00ff88');
        }
        if (res.teleport) {
          pPos.x = res.x; pPos.y = res.y;
          const render = p.get('render');
          if (render?.sprite) render.sprite.setPosition(res.x*TS+TS/2, res.y*TS+TS/2);
        }
        if (res.lifesteal) {
          const pp = p.get('pos');
          this._showFloatingText(pp.x, pp.y, `+${res.lifesteal}HP`, '#ff4488');
        }
      }
    }

    GameState.addMessage(`Cast ${spell.name}!`, '#aa88ff');
    GameState.targeting = false;
    GameState.selectedSpell = null;
    this.spellCursor.setVisible(false);

    this._endPlayerTurn();
  }

  _spellEffect(spellId, from, to, spell) {
    // Particle trail from caster to target
    const fromPx = from.x*TS+TS/2, fromPy = from.y*TS+TS/2;
    const toPx   = to.x*TS+TS/2,   toPy   = to.y*TS+TS/2;

    const effectKey = spellId === 'fireball' ? 'particle_fire' :
                      spellId === 'ice_spike' ? 'particle_ice' :
                      spellId === 'lightning' ? 'particle_lightning' :
                      'particle_heal';

    const proj = this.add.image(fromPx, fromPy, effectKey).setScale(SCALE).setDepth(55);
    this.effectContainer.add(proj);

    this.tweens.add({
      targets: proj,
      x: toPx, y: toPy,
      duration: 200,
      ease:'Linear',
      onComplete: () => {
        proj.destroy();
        // Explosion at target
        const expl = this.add.circle(toPx, toPy, spell.aoe ? spell.aoe*TS : TS/2,
          spell.particleColor || 0xffffff, 0.7).setDepth(55);
        this.tweens.add({ targets:expl, alpha:0, scale:2, duration:300, onComplete:()=>expl.destroy() });
      }
    });
  }

  _endPlayerTurn() {
    GameState.turnCount++;
    this._processStatusEffects(GameState.player);
    this._processCompanionAI();
    this._processMonstersAI();
    this._updateFOV();
    this._updateHUD();
    this._updateMessageLog();
    this._checkPlayerDeath();
    // Passive regen (every 5 turns)
    if (GameState.turnCount % 5 === 0) {
      const p = GameState.player;
      const st = p.get('stats');
      if (st) st.mp = Math.min(st.maxMp||30, (st.mp||0) + 2);
      // Check regen skill
      const skills = p.get('skills');
      if (skills?.known.find(s=>s.id==='mana_well')) {
        st.mp = Math.min(st.maxMp||30, (st.mp||0) + 3);
      }
    }
  }

  _processCompanionAI() {
    const ce = GameState.companionEntity;
    if (!ce) return;
    const ch = ce.get('health');
    if (!ch || ch.hp <= 0) {
      // Companion died
      const cr = ce.get('render');
      cr?.sprite?.destroy(); cr?.hpBg?.destroy(); cr?.hpBar?.destroy(); cr?.label?.destroy();
      GameState.world.destroy(ce.id);
      GameState.companionEntity = null;
      GameState.addMessage(`Your companion has fallen! 😢`, '#ff4444');
      return;
    }

    const cPos  = ce.get('pos');
    const pPos  = GameState.player.get('pos');
    const compDef = ce.components.compDef;
    const range   = compDef?.range || 1;
    const monsters = GameState.world.queryTag('monster');

    // Find nearest visible monster within attack range
    const fov = GameState.player.get('fov');
    let nearest = null, nearestDist = Infinity;
    for (const m of monsters) {
      const mp = m.get('pos');
      if (!mp) continue;
      const dist = Math.abs(mp.x - cPos.x) + Math.abs(mp.y - cPos.y);
      const visible = fov?.visible.has(`${mp.x},${mp.y}`);
      if (visible && dist < nearestDist) { nearest = m; nearestDist = dist; }
    }

    if (nearest) {
      const mp = nearest.get('pos');
      if (nearestDist <= range) {
        // Attack!
        const cSt = ce.get('stats');
        const mSt = nearest.get('stats');
        const mHp = nearest.get('health');
        if (!mHp || !mSt) return;
        const dmg = Math.max(1, (cSt?.atk||8) - (mSt?.def||0) + Math.floor(Math.random()*4-2));
        applyDamage(nearest, dmg);
        this._showDamageNumber(mp.x, mp.y, dmg, '#aaffaa');
        if (mHp.hp <= 0) {
          const mr = nearest.get('render');
          mr?.sprite?.destroy(); mr?.hpBg?.destroy(); mr?.hpBar?.destroy();
          GameState.world.destroy(nearest.id);
          GameState.floorData.monsters = GameState.floorData.monsters.filter(id => id !== nearest.id);
          GameState.addMessage(`${compDef?.icon||'⚔'} Companion slays the ${nearest.components.monsterDef?.name||'enemy'}!`, '#aaffaa');
        }
        // Mage companion: cast fireball every 3 turns
        if (compDef?.aiType === 'mage' && GameState.turnCount % 3 === 0) {
          GameState.addMessage(`${compDef.icon} Companion casts Fireball!`, '#ff8844');
        }
        // Paladin heals every 5 turns
        if (compDef?.aiType === 'paladin' && GameState.turnCount % 5 === 0) {
          const healed = applyHeal(GameState.player, 15);
          GameState.addMessage(`${compDef.icon} Companion heals you for +${healed} HP!`, '#44ff88');
        }
      } else {
        // Move toward nearest monster
        const fd = GameState.floorData;
        const path = astar(fd.tiles, cPos.x, cPos.y, mp.x, mp.y,
          (x,y) => fd.tiles[y]?.[x] !== undefined && fd.tiles[y][x] !== TILE_TYPE.WALL, 15);
        if (path && path.length > 1) {
          cPos.x = path[1].x; cPos.y = path[1].y;
        }
      }
    } else {
      // Follow player if far
      const dist = Math.abs(cPos.x - pPos.x) + Math.abs(cPos.y - pPos.y);
      if (dist > 3) {
        const fd = GameState.floorData;
        const path = astar(fd.tiles, cPos.x, cPos.y, pPos.x, pPos.y,
          (x,y) => fd.tiles[y]?.[x] !== undefined && fd.tiles[y][x] !== TILE_TYPE.WALL, 15);
        if (path && path.length > 1) {
          cPos.x = path[1].x; cPos.y = path[1].y;
        }
      }
    }

    // Update companion sprite position
    const cr = ce.get('render');
    if (cr?.sprite) {
      this.tweens.add({ targets: cr.sprite, x: cPos.x*TS+TS/2, y: cPos.y*TS+TS/2, duration:120, ease:'Linear' });
      if (cr.hpBg)  cr.hpBg.setPosition(cPos.x*TS+TS/2, cPos.y*TS+2);
      if (cr.label) cr.label.setPosition(cPos.x*TS+TS/2, cPos.y*TS-4);
      // HP bar scale
      const ratio = ch.hp / ch.maxHp;
      if (cr.hpBar) {
        cr.hpBar.setPosition(cPos.x*TS+2, cPos.y*TS+2);
        cr.hpBar.setScale(ratio, 1);
        cr.hpBar.setFillStyle(ratio > 0.5 ? 0x44ff44 : ratio > 0.25 ? 0xffaa00 : 0xff4444);
      }
    }
  }

  _processStatusEffects(entity) {
    const { damage, heal, skip, removed } = tickStatus(entity);
    if (damage > 0) {
      applyDamage(entity, damage);
      const pos = entity.get('pos');
      if (pos) this._showDamageNumber(pos.x, pos.y, damage, '#ff8844');
    }
    if (heal > 0) {
      applyHeal(entity, heal);
      const pos = entity.get('pos');
      if (pos) this._showFloatingText(pos.x, pos.y, `+${heal}`, '#00ff88');
    }
    return skip;
  }

  _processMonstersAI() {
    const p = GameState.player;
    const pPos = p.get('pos');
    const fd = GameState.floorData;
    const world = GameState.world;

    const monsters = world.queryTag('monster');
    for (const monster of monsters) {
      const mPos = monster.get('pos');
      const mAI  = monster.get('ai');
      const mHp  = monster.get('health');
      if (!mPos || !mAI || !mHp) continue;

      // Skip if not visible (optimization)
      const fov = p.get('fov');
      const inFOV = fov?.visible.has(`${mPos.x},${mPos.y}`);

      // Process status
      const skip = this._processStatusEffects(monster);
      if (skip) continue;
      if (mHp.hp <= 0) { this._killMonster(monster); continue; }

      // Regen
      if (monster.components?.regen) {
        applyHeal(monster, monster.components.regen);
        this._updateMonsterHP(monster);
      }

      const dist = Math.abs(pPos.x-mPos.x) + Math.abs(pPos.y-mPos.y);

      // Boss AI
      if (monster.hasTag('boss')) {
        const bossAction = processBossAI(world, monster, p, world, fd, this.rng);
        if (bossAction) {
          this._processBossAction(bossAction, monster, p);
          continue;
        }
      }

      // Monster spells
      const mDef = monster.components?.monsterDef;
      if (mDef?.spells && dist <= 6 && inFOV && this.rng.next() < 0.3) {
        const spellId = this.rng.pick(mDef.spells);
        const spellDef = SPELLS[spellId];
        if (spellDef) {
          // Simple AI spell: damage player
          const baseMag = mDef.mag || 5;
          const dmg = rollDice(spellDef.damage || '1d6', this.rng) + baseMag;
          applyDamage(p, dmg);
          GameState.addMessage(`${mDef.name} casts ${spellDef.name} for ${dmg} damage!`, '#aa44ff');
          this._showDamageNumber(pPos.x, pPos.y, dmg, spellDef.color || 0xff00ff);
          this._spellEffect(spellId, mPos, pPos, spellDef);
          if (spellDef.effect) applyStatus(p, spellDef.effect.replace(/_on_hit|_dmg/,''));
          continue;
        }
      }

      // Standard AI movement/attack
      switch(mAI.behavior) {
        case 'aggressive':
          if (dist <= 15 || inFOV) this._moveMonsterToward(monster, pPos, fd);
          break;
        case 'basic':
          if (dist <= mDef?.alertRange || 6) this._moveMonsterToward(monster, pPos, fd);
          break;
        case 'swarm':
          if (dist <= 10) this._moveMonsterToward(monster, pPos, fd);
          break;
        case 'erratic':
          if (this.rng.next() < 0.5) this._moveMonsterToward(monster, pPos, fd);
          else this._moveMonsterRandom(monster, fd);
          break;
        case 'ranged':
          if (dist <= 6 && inFOV) {
            // Ranged attack
            this._rangedAttack(monster, p);
          } else if (dist <= 12) {
            this._moveMonsterToward(monster, pPos, fd);
          }
          break;
        case 'guardian':
          if (dist <= 4) this._moveMonsterToward(monster, pPos, fd);
          break;
        default:
          if (dist <= 8) this._moveMonsterToward(monster, pPos, fd);
      }
    }
  }

  _moveMonsterToward(monster, pPos, fd) {
    const mPos = monster.get('pos');
    const mAI  = monster.get('ai');

    // A* pathfinding
    if (!mAI.path || mAI.path.length === 0) {
      mAI.path = astar(
        fd.tiles, mPos.x, mPos.y, pPos.x, pPos.y,
        (x,y) => {
          const t = fd.tiles[y]?.[x];
          return t !== undefined && t !== TILE_TYPE.WALL && t !== TILE_TYPE.LAVA;
        }, 20
      );
    }

    if (mAI.path && mAI.path.length > 0) {
      const next = mAI.path[0];
      // Check if next step is occupied by another monster
      const blocked = GameState.world.queryTag('monster').some(m => {
        if (m.id === monster.id) return false;
        const mp = m.get('pos');
        return mp && mp.x===next.x && mp.y===next.y;
      });
      if (!blocked) {
        // Attack if adjacent to player
        if (next.x===pPos.x && next.y===pPos.y) {
          this._monsterAttackPlayer(monster);
          mAI.path = [];
          return;
        }
        mPos.x = next.x; mPos.y = next.y;
        mAI.path.shift();
      } else {
        mAI.path = [];
      }
    }

    // If adjacent to player, attack
    const dist = Math.abs(pPos.x-mPos.x) + Math.abs(pPos.y-mPos.y);
    if (dist === 1) this._monsterAttackPlayer(monster);

    this._updateMonsterRender(monster);
  }

  _moveMonsterRandom(monster, fd) {
    const mPos = monster.get('pos');
    const dirs = this.rng.shuffle([...DIRS4]);
    for (const d of dirs) {
      const nx=mPos.x+d.dx, ny=mPos.y+d.dy;
      const t = fd.tiles[ny]?.[nx];
      if (t !== undefined && t !== TILE_TYPE.WALL) {
        mPos.x = nx; mPos.y = ny;
        break;
      }
    }
    this._updateMonsterRender(monster);
  }

  _rangedAttack(monster, player) {
    const mDef = monster.components?.monsterDef;
    const mSt = monster.get('stats');
    const result = calcCombat(monster, player, this.rng);
    const pPos = player.get('pos');
    const mPos = monster.get('pos');
    if (result.damage > 0) {
      const dead = applyDamage(player, result.damage);
      GameState.addMessage(`${mDef?.name||'Enemy'} shoots for ${result.damage} damage!`, '#ff6666');
      this._showDamageNumber(pPos.x, pPos.y, result.damage, '#ff4444');
      // Projectile effect
      const proj = this.add.circle(mPos.x*TS+TS/2, mPos.y*TS+TS/2, 4, 0xffaa00).setDepth(55);
      this.tweens.add({ targets:proj, x:pPos.x*TS+TS/2, y:pPos.y*TS+TS/2, duration:150, onComplete:()=>proj.destroy() });
    }
  }

  _monsterAttackPlayer(monster) {
    const p = GameState.player;
    const mDef = monster.components?.monsterDef;
    const result = calcCombat(monster, p, this.rng);
    const pPos = p.get('pos');

    if (result.evaded) {
      GameState.addMessage(`You evade ${mDef?.name||'enemy'}'s attack!`, '#888888');
    } else if (result.miss) {
      GameState.addMessage(`${mDef?.name||'Enemy'} misses!`, '#888888');
    } else {
      applyDamage(p, result.damage);
      const critTxt = result.crit ? ' [CRIT!]' : '';
      GameState.addMessage(`${mDef?.name||'Enemy'} hits you for ${result.damage}!${critTxt}`, '#ff6666');
      this._showDamageNumber(pPos.x, pPos.y, result.damage, '#ff0000');

      // Status on hit
      if (mDef?.statusOnHit && this.rng.next() < 0.3) {
        applyStatus(p, mDef.statusOnHit);
        GameState.addMessage(`You are ${mDef.statusOnHit}!`, '#ff8888');
      }

      // Shake camera
      this.cameras.main.shake(100, 0.005);
    }
  }

  _processBossAction(action, bossEntity, player) {
    const pPos = player.get('pos');
    switch(action.type) {
      case 'phase_change':
        GameState.addMessage(action.msg, '#ff4444');
        window.showToast(action.msg, 'warning');
        if (action.summonCount) {
          for (let i=0;i<action.summonCount;i++) {
            const bPos = bossEntity.get('pos');
            const sx = bPos.x + this.rng.int(-3,3), sy = bPos.y + this.rng.int(-3,3);
            if (GameState.floorData.tiles[sy]?.[sx] === TILE_TYPE.FLOOR) {
              const sum = spawnMonster(GameState.world, 'skeleton', sx, sy, GameState.floor, this.rng);
              if (sum) {
                const r = C.render('mob_skeleton', MONSTERS.skeleton.color, 25);
                sum.add(r);
                r.sprite = this.add.image(sx*TS+TS/2, sy*TS+TS/2, 'mob_skeleton').setScale(SCALE).setDepth(25);
                this.entityContainer.add(r.sprite);
                GameState.floorData.monsters.push(sum.id);
              }
            }
          }
        }
        break;
      case 'summon':
        for (let i=0;i<(action.count||1);i++) {
          const bPos = bossEntity.get('pos');
          const sx = bPos.x + this.rng.int(-4,4), sy = bPos.y + this.rng.int(-4,4);
          if (GameState.floorData.tiles[sy]?.[sx] === TILE_TYPE.FLOOR) {
            const mDef = MONSTERS[action.monster] || MONSTERS.skeleton;
            const sum = spawnMonster(GameState.world, action.monster, sx, sy, GameState.floor, this.rng);
            if (sum) {
              const r = C.render(mDef.sprite||'mob_skeleton', mDef.color, 25);
              sum.add(r);
              r.sprite = this.add.image(sx*TS+TS/2, sy*TS+TS/2, mDef.sprite||'mob_skeleton').setScale(SCALE).setDepth(25);
              this.entityContainer.add(r.sprite);
              GameState.floorData.monsters.push(sum.id);
            }
          }
        }
        break;
      case 'spell':
        const spell = SPELLS[action.spell];
        if (spell) {
          const bPos = bossEntity.get('pos');
          const dmg = rollDice(spell.damage||'2d8', this.rng) + 10;
          applyDamage(player, dmg);
          GameState.addMessage(`Boss casts ${spell.name} for ${dmg}!`, '#aa44ff');
          this._showDamageNumber(pPos.x, pPos.y, dmg, spell.color||0xaa00ff);
          this._spellEffect(action.spell, bPos, pPos, spell);
        }
        break;
      case 'aoe':
        const aDmg = action.damage || 10;
        applyDamage(player, aDmg);
        GameState.addMessage(action.msg || `Boss AOE for ${aDmg}!`, '#ff4444');
        this._showDamageNumber(pPos.x, pPos.y, aDmg, '#ff8800');
        this.cameras.main.shake(200, 0.01);
        break;
      case 'self_heal':
        applyHeal(bossEntity, action.amount||30);
        GameState.addMessage(action.msg||'Boss heals!', '#ff8888');
        this._updateMonsterHP(bossEntity);
        break;
    }
    // Boss melee too
    const bPos = bossEntity.get('pos');
    const dist = Math.abs(bPos.x-pPos.x)+Math.abs(bPos.y-pPos.y);
    if (dist <= 1) this._monsterAttackPlayer(bossEntity);
    this._moveMonsterToward(bossEntity, pPos, GameState.floorData);
  }

  _updateMonsterRender(monster) {
    const mPos = monster.get('pos');
    const render = monster.get('render');
    if (!render?.sprite) return;
    render.sprite.setPosition(mPos.x*TS+TS/2, mPos.y*TS+TS/2);
    if (render.hpBg)  render.hpBg.setPosition(mPos.x*TS+TS/2, mPos.y*TS+2);
    if (render.hpBar) render.hpBar.setX(mPos.x*TS+2);
  }

  _updateFOV() {
    const p = GameState.player;
    const pos = p.get('pos');
    const fov = p.get('fov');
    const st = p.get('stats');
    const status = p.get('status');
    if (!fov) return;

    let radius = fov.radius;
    // Status: blind reduces radius
    if (status) {
      for (const eff of status.effects) {
        if (eff.fovMod) radius = Math.max(2, radius + eff.fovMod);
      }
    }

    computeFOV(GameState.floorData.tiles, pos.x, pos.y, radius, fov.visible, fov.explored);

    const fd = GameState.floorData;

    for (let y=0; y<ROWS; y++) {
      for (let x=0; x<COLS; x++) {
        const key = `${x},${y}`;
        const vis = fov.visible.has(key);
        const exp = fov.explored.has(key);
        const fogSprite = this.fogSprites[y][x];
        if (vis) {
          fogSprite.setAlpha(0);
          this.tileSprites[y][x].setAlpha(1);
        } else if (exp) {
          fogSprite.setAlpha(0.7).setTexture('fog_explored');
          this.tileSprites[y][x].setAlpha(0.5);
        } else {
          fogSprite.setAlpha(1).setTexture('fog');
          this.tileSprites[y][x].setAlpha(0);
        }
      }
    }

    // Show/hide monsters based on FOV
    for (const id of GameState.floorData.monsters) {
      const m = GameState.world.entities.get(id);
      if (!m) continue;
      const mp = m.get('pos');
      const render = m.get('render');
      if (!mp || !render) continue;
      const visible = fov.visible.has(`${mp.x},${mp.y}`);
      if (render.sprite) {
        render.sprite.setVisible(visible);
        if (render.hpBg)  render.hpBg.setVisible(visible);
        if (render.hpBar) render.hpBar.setVisible(visible);
      }
    }

    // Refresh minimap
    this._drawMinimap();
  }

  _updateHUD() {
    const p = GameState.player;
    if (!p) return;
    const hp = p.get('health');
    const st = p.get('stats');
    const status = p.get('status');
    const inv = p.get('inventory');
    const equip = p.get('equipment');
    const skills = p.get('skills');

    if (hp) {
      const ratio = hp.hp / hp.maxHp;
      this.hpBar.setScale(ratio, 1);
      this.hpBar.setFillStyle(ratio > 0.5 ? 0xff4444 : ratio > 0.25 ? 0xff8800 : 0xff0000);
      this.hpText.setText(`${hp.hp}/${hp.maxHp}${hp.shield > 0 ? ' 🛡'+hp.shield : ''}`);
    }

    if (st) {
      const mp = st.mp || 0;
      const maxMp = st.maxMp || 30;
      const mpRatio = maxMp > 0 ? mp / maxMp : 0;
      this.mpBar.setScale(Math.max(0, mpRatio), 1);
      this.mpText.setText(`${mp}/${maxMp}`);

      const wAtk = equip?.weapon?.atk || 0;
      const aDef = equip?.armor?.def  || 0;
      const rMag = equip?.ring?.mag   || 0;
      this.statsText.setText(
        `⚔${st.atk + wAtk}  🛡${st.def + aDef}  🔮${st.mag + rMag}  💰${inv?.gold||0}\n` +
        `LVL ${st.level}  T:${GameState.turnCount}  ATK+${wAtk} DEF+${aDef}`
      );

      const xpRatio = st.xpNext > 0 ? st.xp / st.xpNext : 0;
      this.xpBar.setScale(Math.max(0, Math.min(1, xpRatio)), 1);
      if (this.xpText) this.xpText.setText(`XP ${st.xp}/${st.xpNext}`);
    }

    // Floor number — prominent centre
    this.floorText.setText(
      `FLOOR ${GameState.floor} / ${MAX_FLOORS}\n` +
      `${GameState.currentDungeon?.name || 'Dungeon'}`
    );

    // Status effects
    if (status) {
      const effs = status.effects.slice(0,6);
      this.statusIcons.forEach((ico,i) => {
        const eff = effs[i];
        ico.setText(eff ? `${eff.icon}${eff.duration}` : '');
      });
    }

    // Spell slots
    if (skills) {
      const knownSpells = (skills.known || []).filter(s => SPELLS[s.id]);
      this.spellSlots.forEach((slot, i) => {
        const sp = knownSpells[i];
        slot.slotTxt.setText(sp ? (SPELLS[sp.id]?.icon||'?') : '');
        slot.slotKey.setColor(sp?.id === GameState.selectedSpell ? '#ffff00' : '#666688');
        slot.slot.setStrokeStyle(1, sp?.id === GameState.selectedSpell ? 0xffff00 : 0x334466);
      });
    }
  }

  _updateMessageLog() {
    const msgs = GameState.messageLog.slice(0, 4);
    this.msgLines.forEach((line, i) => {
      if (msgs[i]) {
        line.setText(msgs[i].text);
        line.setColor(msgs[i].color || '#ccccee');
        line.setAlpha(1 - i * 0.2);
      } else {
        line.setText('');
      }
    });
  }

  _checkPlayerDeath() {
    const p = GameState.player;
    const hp = p?.get('health');
    if (!hp || hp.hp > 0) return;

    // Check resurrection skill
    const skills = p.get('skills');
    const res = skills?.known.find(s=>s.id==='resurrection');
    if (res && !res.usedThisFloor) {
      res.usedThisFloor = true;
      hp.hp = Math.floor(hp.maxHp * 0.5);
      GameState.addMessage('🙏 Resurrection activates! You survive!', '#ffd700');
      window.showToast('Resurrection! Revived with 50% HP!', 'legendary');
      return;
    }

    // Game over
    this.scene.pause();
    const W = this.scale.width, H = this.scale.height;
    this.add.rectangle(W/2, H/2, W, H, 0x000000, 0.8).setScrollFactor(0).setDepth(200);
    this.add.text(W/2, H/3, 'YOU DIED', {
      fontFamily:'"Press Start 2P"', fontSize:'36px', color:'#ff4444',
      stroke:'#000', strokeThickness:4
    }).setOrigin(0.5).setScrollFactor(0).setDepth(201);
    const st = p.get('stats');
    this.add.text(W/2, H/2, `Floor ${GameState.floor} | Level ${st?.level||1} | Turns ${GameState.turnCount}`, {
      fontFamily:'"VT323"', fontSize:'20px', color:'#888888'
    }).setOrigin(0.5).setScrollFactor(0).setDepth(201);

    const retry = this.add.text(W/2, H*0.65, '[ TRY AGAIN ]', {
      fontFamily:'"Press Start 2P"', fontSize:'14px', color:'#ff6b35',
      backgroundColor:'#1a1a3a', padding:{x:16,y:8},
    }).setOrigin(0.5).setScrollFactor(0).setDepth(201).setInteractive({useHandCursor:true});
    retry.on('pointerdown', () => {
      GameState.world = new World();
      GameState.player = null;
      GameState.floor = 1;
      GameState.turnCount = 0;
      GameState.inDungeon = false;
      this.scene.start('Title');
    });
  }

  _showDamageNumber(tx, ty, damage, color='#ff4444') {
    const colorStr = typeof color === 'number' ?
      '#' + color.toString(16).padStart(6,'0') : color;
    const txt = this.add.text(tx*TS+TS/2, ty*TS, `-${damage}`, {
      fontFamily:'"Press Start 2P"', fontSize:'8px', color:colorStr,
      stroke:'#000', strokeThickness:2,
    }).setOrigin(0.5).setDepth(60);
    this.tweens.add({
      targets:txt, y:ty*TS-20, alpha:0, duration:800,
      onComplete:()=>txt.destroy()
    });
  }

  _showFloatingText(tx, ty, text, color='#ffffff') {
    const colorStr = typeof color === 'number' ?
      '#' + color.toString(16).padStart(6,'0') : color;
    const txt = this.add.text(tx*TS+TS/2, ty*TS, text, {
      fontFamily:'"VT323"', fontSize:'16px', color:colorStr,
      stroke:'#000', strokeThickness:2,
    }).setOrigin(0.5).setDepth(60);
    this.tweens.add({
      targets:txt, y:ty*TS-30, alpha:0, duration:1000,
      onComplete:()=>txt.destroy()
    });
  }

  async _quickSave() {
    const ok = await GameState.saveToDB(GameState.saveSlot);
    if (ok) {
      GameState.addMessage('Game saved!', '#88ff88');
      window.showToast('Game saved!', 'rare');
    } else {
      window.showToast('Save failed!', 'warning');
    }
  }

  update(time, delta) {
    // Nothing needed - turn-based, all logic in _endPlayerTurn
  }
}

// ═══════════════════════════════════════════
// SCENE: INVENTORY (Inventory + Equipment + Crafting)
// ═══════════════════════════════════════════
class InventoryScene extends Phaser.Scene {
  constructor() { super({ key:'Inventory' }); }

  create() {
    const W = this.scale.width, H = this.scale.height;
    // persisted page via static prop
    if (!InventoryScene._page) InventoryScene._page = 'inventory';
    this._page = InventoryScene._page;

    this.add.rectangle(W/2, H/2, W, H, 0x000000, 0.88);

    const panelW = Math.min(820, W - 20);
    const panelH = Math.min(600, H - 20);
    const px = W/2 - panelW/2 + 10;
    const py = H/2 - panelH/2 + 10;

    this.add.rectangle(W/2, H/2, panelW, panelH, 0x0d0d1a, 0.98)
      .setStrokeStyle(2, 0x4444aa);

    // ── Tabs ──
    const PAGES = ['inventory','equipment','crafting'];
    const TAB_LABELS = ['📦 ITEMS','⚔ EQUIP','⚒ CRAFT'];
    PAGES.forEach((pg, i) => {
      const btn = this.add.text(px + i * (panelW/3), py + 5, TAB_LABELS[i], {
        fontFamily:'"Press Start 2P"', fontSize:'8px',
        color: this._page === pg ? '#ffd700' : '#555577',
        backgroundColor: this._page === pg ? '#1a1a3a' : '#0a0a1a',
        padding:{x:10,y:6},
      }).setInteractive({ useHandCursor:true });
      btn.on('pointerdown', () => {
        InventoryScene._page = pg;
        this.scene.restart();
      });
    });

    // ── Close ──
    this.add.text(W/2 + panelW/2 - 14, py + 4, '✕', {
      fontFamily:'"Press Start 2P"', fontSize:'13px', color:'#ff4444',
    }).setOrigin(1,0).setInteractive({useHandCursor:true})
      .on('pointerdown', () => { InventoryScene._page='inventory'; this.scene.stop(); });

    this.input.keyboard.on('keydown-ESC', () => { InventoryScene._page='inventory'; this.scene.stop(); });
    this.input.keyboard.on('keydown-I',   () => { InventoryScene._page='inventory'; this.scene.stop(); });

    const contentX = px;
    const contentY = py + 34;
    const contentW = panelW - 20;
    const contentH = panelH - 50;

    switch (this._page) {
      case 'inventory': this._buildInventoryPage(contentX, contentY, contentW, contentH); break;
      case 'equipment': this._buildEquipmentPage(contentX, contentY, contentW, contentH); break;
      case 'crafting':  this._buildCraftingPage(contentX, contentY, contentW, contentH);  break;
    }
  }

  // ────────────────────────────────────────
  _buildInventoryPage(px, py, pw, ph) {
    const p   = GameState.player;
    const inv  = p.get('inventory');
    const equip = p.get('equipment');
    const skills = p.get('skills');

    this.add.text(px, py, '📦 BACKPACK', {
      fontFamily:'"Press Start 2P"', fontSize:'9px', color:'#ffd700'
    });
    this.add.text(px + pw - 5, py, `${inv.items.length}/${inv.maxSize}  💰${inv.gold}`, {
      fontFamily:'"VT323"', fontSize:'16px', color:'#ffd700',
    }).setOrigin(1,0);

    const COLS_N = 5;
    const cellW = Math.floor((pw - 10) / COLS_N);
    const cellH = 58;
    const startY = py + 24;

    inv.items.forEach((item, idx) => {
      const col = idx % COLS_N;
      const row = Math.floor(idx / COLS_N);
      const cx = px + col * cellW;
      const cy = startY + row * cellH;

      const rarCol = RARITY_COLOR[item.rarity] || 0x334466;
      const bg = this.add.rectangle(cx + cellW/2, cy + cellH/2, cellW - 3, cellH - 3, 0x151528)
        .setStrokeStyle(1, rarCol).setInteractive({useHandCursor:true});

      this.add.text(cx + 4, cy + 4, item.icon || '•', { fontFamily:'"VT323"', fontSize:'22px' });
      this.add.text(cx + 28, cy + 4,
        item.identified ? (item.name.length > 11 ? item.name.slice(0,11)+'…' : item.name) : '??? Item',
        { fontFamily:'"VT323"', fontSize:'12px', color:'#'+rarCol.toString(16).padStart(6,'0') }
      );
      this.add.text(cx + 28, cy + 20, item.type, {
        fontFamily:'"VT323"', fontSize:'11px', color:'#555577'
      });
      if ((item.count||1) > 1) {
        this.add.text(cx + cellW - 5, cy + 4, `×${item.count}`, {
          fontFamily:'"VT323"', fontSize:'12px', color:'#aaaaaa'
        }).setOrigin(1,0);
      }

      bg.on('pointerover', () => { bg.setFillStyle(0x252545); this._showTooltip(item, cx + cellW + 4, cy); });
      bg.on('pointerout',  () => { bg.setFillStyle(0x151528); this._hideTooltip(); });
      bg.on('pointerdown', () => this._useItem(item, idx, inv, equip, skills));
    });

    this.add.text(px, py + ph - 12, 'Click item to Use / Equip. ESC or I to close.', {
      fontFamily:'"VT323"', fontSize:'13px', color:'#333355'
    });
  }

  // ────────────────────────────────────────
  _showTooltip(item, x, y) {
    this._hideTooltip();
    const W = this.scale.width, H = this.scale.height;
    const lines = [`${item.icon||'•'} ${item.identified ? item.name : '??? Item'}`, RARITY_NAME[item.rarity]];
    if (item.identified) {
      if (item.desc)  lines.push(item.desc);
      if (item.atk)   lines.push(`⚔ ATK  +${item.atk}`);
      if (item.def)   lines.push(`🛡 DEF  +${item.def}`);
      if (item.mag)   lines.push(`🔮 MAG  +${item.mag}`);
      if (item.hp)    lines.push(`❤ MaxHP +${item.hp}`);
      if (item.luk)   lines.push(`🍀 LUK  +${item.luk}`);
      if (item.heal)  lines.push(`💊 Heal: ${item.heal===999?'Full':item.heal} HP`);
      if (item.spell) lines.push(`📗 Teaches: ${SPELLS[item.spell]?.name||item.spell}`);
      if (item.effect)lines.push(`✨ Effect: ${item.effect}`);
      lines.push(`💰 ${item.price||0}g`);
    } else {
      lines.push('Unidentified — Use ID scroll\nor click to attempt identification.');
    }

    const tx = Math.min(x, W - 175);
    const ty = Math.max(4, Math.min(y, H - lines.length*16 - 20));
    const rarCol = '#'+RARITY_COLOR[item.rarity].toString(16).padStart(6,'0');
    this._tooltip = this.add.text(tx, ty, lines.join('\n'), {
      fontFamily:'"VT323"', fontSize:'14px', color:rarCol,
      backgroundColor:'rgba(8,8,20,0.97)', padding:{x:9,y:7}, lineSpacing:3,
    }).setDepth(300);
  }

  _hideTooltip() {
    this._tooltip?.destroy(); this._tooltip = null;
  }

  // ────────────────────────────────────────
  _useItem(item, index, inv, equip, skills) {
    const p  = GameState.player;
    const hp = p.get('health');
    const st = p.get('stats');

    if (!item.identified) {
      item.identified = true;
      GameState.addMessage(`Identified: ${item.name}!`, '#4488ff');
      this.scene.restart(); return;
    }

    switch (item.type) {
      case 'weapon': case 'armor': case 'ring': case 'amulet': {
        const slot = item.type;
        const old  = equip[slot];
        if (old) inv.items[index] = old;
        else     inv.items.splice(index, 1);
        equip[slot] = item;
        // apply HP bonus from armor/amulet
        if (item.hp && hp) { hp.maxHp += item.hp; hp.hp = Math.min(hp.hp + item.hp, hp.maxHp); }
        GameState.addMessage(`Equipped: ${item.name}!`, '#00ff88');
        break;
      }
      case 'potion': {
        if (item.heal) {
          const amount = item.heal === 999 ? (hp.maxHp - hp.hp) : item.heal;
          const healed = applyHeal(p, amount);
          GameState.addMessage(`${item.name}: +${healed} HP`, '#00ff88');
        }
        if (item.cure)   { const s=p.get('status'); if(s) s.effects=s.effects.filter(e=>e.id!==item.cure); GameState.addMessage(`Cured ${item.cure}!`,'#88ff88'); }
        if (item.cureAll){ const s=p.get('status'); if(s) s.effects=[]; GameState.addMessage('All status effects cleared!','#88ff88'); }
        inv.items.splice(index, 1);
        break;
      }
      case 'food': {
        const healed = applyHeal(p, item.heal || 10);
        GameState.addMessage(`Ate ${item.name}. +${healed} HP`, '#88ff88');
        inv.items.splice(index, 1);
        break;
      }
      case 'scroll': {
        this._useScroll(item, index, inv);
        break;
      }
      case 'tome': {
        if (!item.spell) break;
        if (skills?.known.find(s=>s.id===item.spell)) {
          GameState.addMessage(`Already know ${SPELLS[item.spell]?.name}!`, '#888888');
        } else {
          skills.known.push({ id:item.spell, level:1 });
          GameState.addMessage(`Learned: ${SPELLS[item.spell]?.name||item.spell}! ✨`, '#aa44ff');
          window.showToast(`Spell learned: ${SPELLS[item.spell]?.name}!`, 'epic');
          inv.items.splice(index, 1);
        }
        break;
      }
      case 'material': GameState.addMessage('Crafting material — use the Crafting tab.','#555577'); break;
      case 'key':      GameState.addMessage('Keep this — used automatically on locked doors.','#aaaaff'); break;
      default:         GameState.addMessage(`Cannot use ${item.name} here.`, '#888888');
    }
    this.scene.restart();
  }

  _useScroll(item, index, inv) {
    const p   = GameState.player;
    const pos = p.get('pos');

    switch (item.effect) {
      case 'teleport':
        if (GameState.phase === 'dungeon') {
          const fd = GameState.floorData;
          let tx=0, ty=0, att=0;
          do { tx=Math.floor(Math.random()*COLS); ty=Math.floor(Math.random()*ROWS); att++; }
          while (fd.tiles[ty]?.[tx] !== TILE_TYPE.FLOOR && att < 300);
          pos.x=tx; pos.y=ty;
          const r=p.get('render'); if(r?.sprite) r.sprite.setPosition(tx*TS+TS/2, ty*TS+TS/2);
          GameState.addMessage('Teleport scroll — whoosh! ✨','#aa88ff');
        }
        break;
      case 'reveal_map':
        if (GameState.phase === 'dungeon') {
          const fov=p.get('fov');
          if(fov){ for(let y=0;y<ROWS;y++) for(let x=0;x<COLS;x++) fov.explored.add(`${x},${y}`); }
          GameState.addMessage('Map revealed!','#4488ff');
        }
        break;
      case 'identify':
        const unid = inv.items.find(i=>!i.identified && i!==item);
        if (unid) { unid.identified=true; GameState.addMessage(`Identified: ${unid.name}!`,'#4488ff'); }
        else GameState.addMessage('Nothing left to identify.','#888888');
        break;
    }
    // Bomb scroll
    if (item.damage && item.aoe && GameState.phase==='dungeon') {
      for (const m of GameState.world.queryTag('monster')) {
        const mp=m.get('pos'); if(!mp) continue;
        if (Math.abs(mp.x-pos.x)+Math.abs(mp.y-pos.y) <= item.aoe) {
          applyDamage(m, item.damage);
          const hp=m.get('health'); if(hp&&hp.hp<=0) GameState.world.destroy(m.id);
        }
      }
      GameState.addMessage(`💣 BOOM! ${item.damage} damage in ${item.aoe} tiles!`,'#ff8800');
    }
    inv.items.splice(index, 1);
  }

  // ────────────────────────────────────────
  _buildEquipmentPage(px, py, pw, ph) {
    const p     = GameState.player;
    const equip  = p.get('equipment');
    const st     = p.get('stats');
    const inv    = p.get('inventory');

    this.add.text(px, py, '⚔ EQUIPPED GEAR', {
      fontFamily:'"Press Start 2P"', fontSize:'9px', color:'#ffd700'
    });

    const SLOTS = [
      { key:'weapon', label:'⚔ WEAPON', x:px,        y:py+28 },
      { key:'armor',  label:'🛡 ARMOR',  x:px,        y:py+128 },
      { key:'ring',   label:'💍 RING',   x:px+pw/2+8, y:py+28  },
      { key:'amulet', label:'📿 AMULET', x:px+pw/2+8, y:py+128 },
    ];

    for (const slot of SLOTS) {
      const item = equip[slot.key];
      this.add.text(slot.x, slot.y, slot.label, {
        fontFamily:'"Press Start 2P"', fontSize:'7px', color:'#888888'
      });
      const bw = pw/2 - 16, bh = 80;
      const bg = this.add.rectangle(slot.x + bw/2, slot.y + 20 + bh/2, bw, bh,
        item ? 0x151a2e : 0x0a0a18)
        .setStrokeStyle(1, item ? RARITY_COLOR[item.rarity] : 0x222244)
        .setInteractive({useHandCursor:true});

      if (item) {
        this.add.text(slot.x + 5, slot.y + 22, `${item.icon||'•'} ${item.name}`, {
          fontFamily:'"VT323"', fontSize:'15px',
          color:'#'+RARITY_COLOR[item.rarity].toString(16).padStart(6,'0')
        });
        const bonuses=[];
        if(item.atk) bonuses.push(`ATK+${item.atk}`);
        if(item.def) bonuses.push(`DEF+${item.def}`);
        if(item.mag) bonuses.push(`MAG+${item.mag}`);
        if(item.hp)  bonuses.push(`HP+${item.hp}`);
        if(item.luk) bonuses.push(`LUK+${item.luk}`);
        this.add.text(slot.x + 5, slot.y + 42, bonuses.join('  '), {
          fontFamily:'"VT323"', fontSize:'13px', color:'#6688aa'
        });
        if (item.effect) this.add.text(slot.x+5, slot.y+58, `✨ ${item.effect}`, {
          fontFamily:'"VT323"', fontSize:'12px', color:'#aa88ff'
        });
        // Unequip on click
        bg.on('pointerdown', () => {
          if (inv.items.length < inv.maxSize) {
            inv.items.push(item);
            equip[slot.key] = null;
            // remove HP bonus
            if (item.hp) { const h=p.get('health'); if(h){h.maxHp-=item.hp; h.hp=Math.min(h.hp,h.maxHp);} }
            GameState.addMessage(`Unequipped: ${item.name}`,'#ff8888');
            this.scene.restart();
          } else { window.showToast('Inventory full!','warning'); }
        });
        bg.on('pointerover', () => { bg.setFillStyle(0x252545); this._showTooltip(item, slot.x+bw+6, slot.y+20); });
        bg.on('pointerout',  () => { bg.setFillStyle(0x151a2e); this._hideTooltip(); });
      } else {
        this.add.text(slot.x + bw/2, slot.y + 20 + bh/2, 'Empty', {
          fontFamily:'"VT323"', fontSize:'16px', color:'#333355'
        }).setOrigin(0.5);
      }
    }

    // Combined stats panel
    const sx = px, sy = py + 240;
    this.add.text(sx, sy, '── CHARACTER STATS ──', {
      fontFamily:'"Press Start 2P"', fontSize:'7px', color:'#ffd700'
    });
    const eSt   = equip;
    const wAtk  = eSt.weapon?.atk||0;
    const aDef  = eSt.armor?.def||0;
    const rMag  = eSt.ring?.mag||0;
    const rAtk  = eSt.ring?.atk||0;
    const amHp  = eSt.amulet?.hp||0;
    this.add.text(sx, sy+20, [
      `ATK: ${st.atk} + ${wAtk+rAtk} = ${st.atk+wAtk+rAtk}`,
      `DEF: ${st.def} + ${aDef} = ${st.def+aDef}`,
      `MAG: ${st.mag} + ${rMag} = ${st.mag+rMag}`,
      `LUK: ${st.luk}   SPD: ${st.spd}   LVL: ${st.level}`,
      `MaxHP: ${p.get('health').maxHp} (+${amHp} from amulet)`,
      `MaxMP: ${st.maxMp||30}   XP: ${st.xp}/${st.xpNext}`,
    ].join('\n'), {
      fontFamily:'"VT323"', fontSize:'15px', color:'#aaaacc', lineSpacing:4
    });

    this.add.text(px, py + ph - 12, 'Click equipped item to unequip it.', {
      fontFamily:'"VT323"', fontSize:'13px', color:'#333355'
    });
  }

  // ────────────────────────────────────────
  _buildCraftingPage(px, py, pw, ph) {
    const p   = GameState.player;
    const inv  = p.get('inventory');

    this.add.text(px, py, '⚒ CRAFTING', {
      fontFamily:'"Press Start 2P"', fontSize:'9px', color:'#ffd700'
    });
    this.add.text(px, py+18, 'Select a recipe and press CRAFT if you have ingredients.', {
      fontFamily:'"VT323"', fontSize:'14px', color:'#555577'
    });

    const rowH = 52;
    RECIPES.forEach((recipe, ri) => {
      const ry = py + 38 + ri * rowH;

      // Check if craftable
      let craftable = true;
      const ingText = [];
      for (const [id, count] of Object.entries(recipe.ingredients)) {
        const have = inv.items.filter(i=>i.id===id).reduce((a,b)=>a+(b.count||1),0);
        const ok   = have >= count;
        if (!ok) craftable = false;
        ingText.push(`${ITEMS[id]?.icon||'•'}${id.replace(/_/g,' ')}×${count}(${ok?'✓':'✗'})`);
      }

      const result = ITEMS[recipe.result];
      const bg = this.add.rectangle(px + pw/2, ry + rowH/2, pw - 4, rowH - 4,
        craftable ? 0x112211 : 0x110011)
        .setStrokeStyle(1, craftable ? 0x44ff44 : 0x553333)
        .setInteractive({useHandCursor:true});

      this.add.text(px + 8, ry + 6, `${result?.icon||'•'} ${recipe.name}`, {
        fontFamily:'"VT323"', fontSize:'15px',
        color: craftable ? '#44ff88' : '#554444'
      });
      this.add.text(px + 8, ry + 26, ingText.join('  '), {
        fontFamily:'"VT323"', fontSize:'12px',
        color: craftable ? '#aabbaa' : '#664444'
      });

      const resultCol = result ? '#'+RARITY_COLOR[result.rarity].toString(16).padStart(6,'0') : '#888888';
      this.add.text(px + pw - 12, ry + 6, `→ ${result?.name||'?'}`, {
        fontFamily:'"VT323"', fontSize:'14px', color:resultCol
      }).setOrigin(1,0);

      if (craftable) {
        bg.on('pointerover', () => bg.setFillStyle(0x1a3318));
        bg.on('pointerout',  () => bg.setFillStyle(0x112211));
        bg.on('pointerdown', () => this._craft(recipe, inv));
      }
    });

    this.add.text(px, py + ph - 12, 'Green = craftable. Click to craft!', {
      fontFamily:'"VT323"', fontSize:'13px', color:'#333355'
    });
  }

  _craft(recipe, inv) {
    // Consume ingredients
    for (const [id, count] of Object.entries(recipe.ingredients)) {
      let remaining = count;
      inv.items = inv.items.filter(item => {
        if (item.id === id && remaining > 0) {
          remaining -= (item.count||1);
          return remaining > 0 ? false : false; // always remove matching
        }
        return true;
      });
    }
    const result = { ...ITEMS[recipe.result], count:1, identified:true };
    inv.items.push(result);
    GameState.addMessage(`Crafted: ${result.icon||'•'} ${result.name}!`,
      '#'+RARITY_COLOR[result.rarity].toString(16).padStart(6,'0'));
    window.showToast(`Crafted: ${result.name}!`, ['','','rare','epic','legendary'][result.rarity]||'');
    this.scene.restart();
  }
}

// ═══════════════════════════════════════════
// SCENE: SKILL TREE
// ═══════════════════════════════════════════
class SkillTreeScene extends Phaser.Scene {
  constructor() { super({ key:'SkillTree' }); }

  create() {
    const W = this.scale.width, H = this.scale.height;
    const skills = GameState.player?.get('skills');

    this.add.rectangle(W/2, H/2, W, H, 0x000000, 0.90);

    const panelW = Math.min(860, W - 20);
    const panelH = Math.min(620, H - 20);
    const px = W/2 - panelW/2;
    const py = H/2 - panelH/2;

    this.add.rectangle(W/2, H/2, panelW, panelH, 0x080814, 0.98)
      .setStrokeStyle(2, 0x6644aa);

    this.add.text(W/2, py + 10, '🌟 SKILL TREE', {
      fontFamily:'"Press Start 2P"', fontSize:'12px', color:'#ffd700',
    }).setOrigin(0.5, 0);

    this.add.text(W/2 + panelW/2 - 14, py + 8, '✕', {
      fontFamily:'"Press Start 2P"', fontSize:'13px', color:'#ff4444',
    }).setOrigin(1,0).setInteractive({useHandCursor:true})
      .on('pointerdown', () => this.scene.stop());
    this.input.keyboard.on('keydown-ESC', () => this.scene.stop());
    this.input.keyboard.on('keydown-T',   () => this.scene.stop());

    // Available skill points
    this.add.text(px + 10, py + 10, `SKILL POINTS: ${skills?.points||0}`, {
      fontFamily:'"Press Start 2P"', fontSize:'8px', color:'#88ff44'
    });

    // Branch headers
    const BRANCHES = ['warrior','mage','rogue','paladin'];
    const BRANCH_COLS = ['#ff8844','#4488ff','#44ff88','#ffd700'];
    const BRANCH_ICONS = ['⚔','🔮','🗡','✝'];
    const branchW = (panelW - 20) / 4;

    BRANCHES.forEach((branch, bi) => {
      const bx = px + 10 + bi * branchW;
      this.add.text(bx + branchW/2, py + 32, `${BRANCH_ICONS[bi]} ${branch.toUpperCase()}`, {
        fontFamily:'"Press Start 2P"', fontSize:'7px', color:BRANCH_COLS[bi]
      }).setOrigin(0.5,0);

      // Filter skills for this branch, sorted by tier
      const branchSkills = Object.values(SKILL_TREE)
        .filter(s => s.branch === branch)
        .sort((a,b) => a.tier - b.tier);

      branchSkills.forEach((skill) => {
        const tiers = [...new Set(branchSkills.map(s=>s.tier))].sort();
        const tierIdx = tiers.indexOf(skill.tier);
        const skillsInTier = branchSkills.filter(s=>s.tier===skill.tier);
        const sIdx = skillsInTier.indexOf(skill);
        const sx = bx + 8 + sIdx * (branchW/2 - 4);
        const sy = py + 56 + tierIdx * 100;

        const known = skills?.known.find(s=>s.id===skill.id);
        const level = known?.level || 0;
        const maxed = level >= skill.maxLvl;
        const canLearn = !maxed && (skills?.points||0) >= skill.cost &&
          (skill.req.length===0 || skill.req.every(r=>skills.known.find(s=>s.id===r)));

        const boxW = branchW/2 - 8, boxH = 84;
        const boxColor = maxed ? 0x1a2a0a : canLearn ? 0x0a1a2a : 0x1a0a0a;
        const strokeColor = maxed ? 0x44ff44 : canLearn ? 0x4488ff : 0x333333;

        const box = this.add.rectangle(sx + boxW/2, sy + boxH/2, boxW, boxH, boxColor)
          .setStrokeStyle(1, strokeColor)
          .setInteractive({ useHandCursor: canLearn });

        this.add.text(sx + boxW/2, sy + 8, skill.icon, {
          fontFamily:'"VT323"', fontSize:'20px'
        }).setOrigin(0.5,0);

        this.add.text(sx + boxW/2, sy + 30,
          skill.name.length > 10 ? skill.name.slice(0,10)+'…' : skill.name, {
          fontFamily:'"Press Start 2P"', fontSize:'6px',
          color: maxed ? '#44ff88' : canLearn ? '#aaaaff' : '#444466',
          wordWrap:{ width:boxW-4 }
        }).setOrigin(0.5,0);

        this.add.text(sx + boxW/2, sy + 52,
          level > 0 ? `Lv ${level}/${skill.maxLvl}` : skill.passive ? 'Passive':'Active', {
          fontFamily:'"VT323"', fontSize:'12px',
          color: level>0 ? '#88ff44' : '#555555'
        }).setOrigin(0.5,0);

        this.add.text(sx + boxW/2, sy + 68, `Cost: ${skill.cost}pt`, {
          fontFamily:'"VT323"', fontSize:'11px', color:'#555577'
        }).setOrigin(0.5,0);

        // Tooltip
        box.on('pointerover', () => {
          box.setFillStyle(boxColor + 0x111111);
          this._showSkillTooltip(skill, sx + boxW + 4, sy);
        });
        box.on('pointerout', () => {
          box.setFillStyle(boxColor);
          this._hideSkillTooltip();
        });

        if (canLearn) {
          box.on('pointerdown', () => this._learnSkill(skill, skills));
          box.on('pointerover', () => box.setFillStyle(0x0a1a3a));
          box.on('pointerout',  () => box.setFillStyle(boxColor));
        }

        // Draw connectors to requirements
        if (skill.req.length > 0) {
          const g = this.add.graphics().setDepth(1);
          g.lineStyle(1, 0x333344, 0.6);
          skill.req.forEach(reqId => {
            const reqSkill = SKILL_TREE[reqId];
            if (!reqSkill || reqSkill.branch !== branch) return;
            const reqTierIdx = tiers.indexOf(reqSkill.tier);
            const reqInTier  = branchSkills.filter(s=>s.tier===reqSkill.tier);
            const reqSIdx    = reqInTier.indexOf(reqSkill);
            const reqSx = bx + 8 + reqSIdx * (branchW/2 - 4);
            const reqSy = py + 56 + reqTierIdx * 100;
            g.beginPath();
            g.moveTo(sx + boxW/2, sy);
            g.lineTo(reqSx + boxW/2, reqSy + boxH);
            g.strokePath();
          });
        }
      });
    });

    this.add.text(W/2, py + panelH - 14,
      'Click a skill to learn it. Requirements shown by lines. Active skills = use in combat.',
      { fontFamily:'"VT323"', fontSize:'13px', color:'#333355' }
    ).setOrigin(0.5,1);
  }

  _showSkillTooltip(skill, x, y) {
    this._hideSkillTooltip();
    const W = this.scale.width, H = this.scale.height;
    const known  = GameState.player?.get('skills')?.known.find(s=>s.id===skill.id);
    const level  = known?.level || 0;
    const lines  = [
      `${skill.icon} ${skill.name}`,
      `Branch: ${skill.branch.toUpperCase()}  Tier ${skill.tier}`,
      `${skill.passive ? '● Passive' : '◆ Active'} | Max Lv ${skill.maxLvl}`,
      skill.desc,
      `Cost: ${skill.cost} skill point(s)`,
      level > 0 ? `Current Level: ${level}/${skill.maxLvl}` : 'Not learned',
    ];
    if (skill.req.length) lines.push(`Requires: ${skill.req.map(r=>SKILL_TREE[r]?.name||r).join(', ')}`);

    this._tooltip = this.add.text(
      Math.min(x, W - 195),
      Math.max(4, Math.min(y, H - lines.length*16 - 20)),
      lines.join('\n'), {
      fontFamily:'"VT323"', fontSize:'14px', color:'#ccccee',
      backgroundColor:'rgba(6,6,18,0.97)', padding:{x:9,y:7}, lineSpacing:3
    }).setDepth(300);
  }

  _hideSkillTooltip() { this._tooltip?.destroy(); this._tooltip = null; }

  _learnSkill(skill, skills) {
    if (!skills || (skills.points||0) < skill.cost) return;
    const existing = skills.known.find(s=>s.id===skill.id);
    if (existing) {
      if (existing.level >= skill.maxLvl) return;
      existing.level++;
    } else {
      skills.known.push({ id:skill.id, level:1, active:false });
    }
    skills.points -= skill.cost;

    // Apply passive stat bonuses immediately
    const p  = GameState.player;
    const st = p.get('stats');
    const hp = p.get('health');
    switch(skill.effect) {
      case 'def+3_per_lvl':     if(st) st.def += 3; break;
      case 'mag+2_per_lvl':     if(st) st.mag += 2; break;
      case 'mp+10_per_lvl':     if(st){ st.maxMp=(st.maxMp||30)+10; st.mp=(st.mp||0)+10; } break;
      case 'gold+50%':          break; // applied at kill time
      case 'evade+15':          break; // applied in combat
      case 'crit+20':           break; // applied in combat
      case 'undead_resist':     break;
      case 'free_cast_20':      break;
    }

    GameState.addMessage(`Learned: ${skill.name}!`, '#ffd700');
    window.showToast(`Skill learned: ${skill.name}!`, 'epic');
    this.scene.restart();
  }
}

// ═══════════════════════════════════════════
// SCENE: HUD OVERLAY (persistent over dungeon)
// ═══════════════════════════════════════════
class HUDScene extends Phaser.Scene {
  constructor() { super({ key:'HUD', active:false }); }
  create() { /* HUD is managed directly in DungeonScene */ }
}

// ═══════════════════════════════════════════
// SCENE: GAME OVER / VICTORY
// ═══════════════════════════════════════════
class GameOverScene extends Phaser.Scene {
  constructor() { super({ key:'GameOver' }); }

  init(data) {
    this._won   = data?.won   || false;
    this._stats = data?.stats || {};
  }

  create() {
    const W = this.scale.width, H = this.scale.height;

    this.add.rectangle(W/2, H/2, W, H, this._won ? 0x000a00 : 0x0a0000, 0.96);

    const title = this._won ? '🏆 VICTORY!' : '☠ YOU DIED';
    const col   = this._won ? '#ffd700' : '#ff4444';

    this.add.text(W/2, H*0.22, title, {
      fontFamily:'"Press Start 2P"', fontSize:'clamp(20px,5vw,40px)',
      color:col, stroke:'#000000', strokeThickness:4
    }).setOrigin(0.5);

    if (this._won) {
      this.add.text(W/2, H*0.34, 'The Lich King has been defeated!\nDungeonForge is saved!', {
        fontFamily:'"VT323"', fontSize:'22px', color:'#ffd700', align:'center', lineSpacing:8
      }).setOrigin(0.5);
    }

    const stats = this._stats;
    this.add.text(W/2, H*0.50, [
      `Floor Reached: ${stats.floor || GameState.floor}`,
      `Level: ${stats.level || 1}`,
      `Turns Played: ${stats.turns || GameState.turnCount}`,
      `Gold Collected: ${stats.gold || 0}`,
    ].join('\n'), {
      fontFamily:'"VT323"', fontSize:'18px', color:'#888888', align:'center', lineSpacing:6
    }).setOrigin(0.5);

    const restartBtn = this.add.text(W/2, H*0.72, '[ PLAY AGAIN ]', {
      fontFamily:'"Press Start 2P"', fontSize:'13px', color:'#ff6b35',
      backgroundColor:'#1a1a3a', padding:{x:18,y:9}
    }).setOrigin(0.5).setInteractive({useHandCursor:true});
    restartBtn.on('pointerdown', () => {
      GameState.world  = null;
      GameState.player = null;
      GameState.floor  = 1;
      GameState.turnCount = 0;
      GameState.inDungeon = false;
      this.scene.start('Title');
    });

    this.tweens.add({ targets:restartBtn, scaleX:1.05, scaleY:1.05, duration:900, yoyo:true, repeat:-1 });
    this.input.keyboard.on('keydown-ENTER', () => restartBtn.emit('pointerdown'));
  }
}

// ═══════════════════════════════════════════
// PHASER GAME CONFIG & BOOT
// ═══════════════════════════════════════════
(async function main() {
  // Responsive canvas size
  const gameW = Math.min(window.innerWidth, 1280);
  const gameH = Math.min(window.innerHeight, 720);

  const config = {
    type: Phaser.AUTO,
    width:  gameW,
    height: gameH,
    backgroundColor: '#0a0a0f',
    scale: {
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_BOTH,
      width: gameW,
      height: gameH,
    },
    render: {
      pixelArt: true,
      antialias: false,
      antialiasGL: false,
    },
    parent: 'game-container',
    scene: [
      BootScene,
      TitleScene,
      WorldMapScene,
      DungeonScene,
      InventoryScene,
      SkillTreeScene,
      HUDScene,
      GameOverScene,
    ],
  };

  const game = new Phaser.Game(config);

  // Resize handler
  window.addEventListener('resize', () => {
    const nw = Math.min(window.innerWidth, 1280);
    const nh = Math.min(window.innerHeight, 720);
    game.scale.resize(nw, nh);
  });

  // Expose for debugging
  window.DungeonForge = { GameState, game, ITEMS, MONSTERS, SPELLS, SKILL_TREE };
})();
