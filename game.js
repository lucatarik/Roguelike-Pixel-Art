// =============================================================================
// MELISSA'S WRATH: ENDLESS DESCENT — game.js
// Production-grade Roguelike RPG | Phaser 3 | ECS | Turn-based
// =============================================================================
// Systems: ECS · BSP Dungeon Gen · Perlin World · FOV Shadowcast · A* AI
//          Combat + Crits · Status Effects · Loot Rarity · Crafting
//          Skill Tree · Magic System · Boss AI · IndexedDB · PWA
// =============================================================================
//
// FILE ARCHITECTURE (seven layers, top → bottom):
//
//   LAYER 1 — Utilities & Engine Primitives     (lines ~1  – ~250)
//     RNG, Perlin noise, IndexedDB wrapper (DB), ECS core (Entity/World/EventBus)
//
//   LAYER 2 — Data Definitions                  (lines ~250 – ~900)
//     Component factories (C), item DB (ITEMS), loot tables, crafting recipes,
//     spell DB (SPELLS), companion/mount databases, market system,
//     Shinre temple definitions, skill tree, status effect definitions.
//
//   LAYER 3 — Procedural Generation             (lines ~900 – ~1340)
//     BSP dungeon generator (generateFloor), Perlin world map generator
//     (generateWorldMap), FOV shadowcasting (computeFOV), A* pathfinding
//     (astar), world-map BFS pathfinding (worldBFS).
//
//   LAYER 4 — Combat & Systems                  (lines ~1340 – ~1615)
//     calcCombat, castSpell, processBossAI, applyStatus/tickStatus/getStatusMods,
//     applyRelicEffects — the core simulation pipeline called every player turn.
//
//   LAYER 5 — Sprite Generation                 (lines ~1616 – ~2291)
//     generateSprites(scene) — draws every game texture procedurally onto
//     Phaser canvas textures. Called once in BootScene at startup.
//
//   LAYER 6 — Global Game State                 (lines ~2293 – ~2377)
//     GameState singleton — floor, seed, ECS world, player entity, phase,
//     companion, mount, relics, message log, serialize/save/load helpers.
//
//   LAYER 7 — Phaser Scenes                     (lines ~2380 – end)
//     Boot → Title → WorldMap ↔ Dungeon (+ Inventory, SkillTree, HUD overlays)
//     → GameOver.
//
// DEBUGGING: open browser console and inspect window.MelissasWrath
//   { GameState, game, ITEMS, MONSTERS, SPELLS, SKILL_TREE }
//
// EXTENDING: search for "// EXTEND:" comments to find suggested hook points.
// =============================================================================

'use strict';

// =============================================================================
// ██╗      █████╗ ██╗   ██╗███████╗██████╗      ██╗
// ██║     ██╔══██╗╚██╗ ██╔╝██╔════╝██╔══██╗    ███║
// ██║     ███████║ ╚████╔╝ █████╗  ██████╔╝    ╚██║
// ██║     ██╔══██║  ╚██╔╝  ██╔══╝  ██╔══██╗     ██║
// ███████╗██║  ██║   ██║   ███████╗██║  ██║     ██║
// ╚══════╝╚═╝  ╚═╝   ╚═╝   ╚══════╝╚═╝  ╚═╝     ╚═╝
//
// UTILITIES & ENGINE PRIMITIVES
// =============================================================================
// This layer defines everything the rest of the codebase depends on:
//   • Global display/grid/world constants
//   • RNG — seeded pseudo-random number generator (Mulberry32 algorithm)
//   • Perlin — 2D Perlin noise, used for world map terrain generation
//   • DB — promise-based IndexedDB wrapper for save/load
//   • Entity, World, EventBus — lightweight custom ECS framework
// =============================================================================

// ─────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────
// Rendering
const TILE = 16;          // base sprite size in pixels (source canvas tile)
const SCALE = 3;          // pixel-art upscale factor (16 × 3 = 48 px on screen)
const TS = TILE * SCALE;  // display tile size = 48px — used everywhere for world→screen coords

// Dungeon grid dimensions (50×50 tiles per floor)
const COLS = 50;
const ROWS = 50;
// World map grid dimensions (80×60 tiles)
const WORLD_COLS = 80;
const WORLD_ROWS = 60;

// How many dungeon floors before the exit/completion
const MAX_FLOORS = 10;

// Item rarity tiers — used as indices into RARITY_NAME, RARITY_COLOR, RARITY_WEIGHT
const RARITY = { COMMON:0, UNCOMMON:1, RARE:2, EPIC:3, LEGENDARY:4 };
const RARITY_NAME = ['Common','Uncommon','Rare','Epic','Legendary'];
// Hex colours for rarity (grey → green → blue → purple → gold)
const RARITY_COLOR = [0xaaaaaa, 0x44ff88, 0x4488ff, 0xaa44ff, 0xffd700];
// Weighted probability for rolling loot rarity (higher floor bonuses tweak these)
const RARITY_WEIGHT = [60, 25, 10, 4, 1];

// Eight cardinal + diagonal movement directions, each as a {dx,dy} vector.
// DIR is a named lookup; DIRS4 = 4-way (no diagonals); DIRS8 = all 8 directions.
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
const DIRS4 = [DIR.N, DIR.S, DIR.E, DIR.W];   // cardinal only — used by A* and worldBFS
const DIRS8 = Object.values(DIR);               // all 8 — used for FOV and random movement

// World map biome identifiers and their associated tile colours/names.
// EXTEND: add new biomes here and handle them in generateWorldMap + generateSprites.
const BIOME = { PLAINS:0, FOREST:1, DESERT:2, SNOW:3, SWAMP:4, VOLCANO:5, OCEAN:6, DUNGEON:7 };
const BIOME_COLOR = {
  0: 0x7ec850, 1: 0x2d6a2d, 2: 0xe8c87a, 3: 0xddeeff,
  4: 0x4a7a4a, 5: 0xc84a10, 6: 0x1a4888, 7: 0x2a1a3a
};
const BIOME_NAME = ['Plains','Forest','Desert','Snow','Swamp','Volcano','Ocean','Dungeon'];

// ─────────────────────────────────────────────
// SEEDED PRNG — Mulberry32 algorithm
// ─────────────────────────────────────────────
// All procedural generation (dungeon layout, monster placement, loot drops,
// world map biomes) is driven through RNG instances seeded from GameState.seed
// XOR'd with the floor number so each floor is deterministic yet unique.
//
// EXTEND: expose rng.seed in a debug panel to allow replaying runs.
class RNG {
  /**
   * Create a new seeded random number generator.
   * @param {number} seed - 32-bit unsigned integer seed.
   */
  constructor(seed) {
    this.seed = seed >>> 0;   // coerce to uint32
    this._state = this.seed;
  }

  /**
   * Advance the state and return a float in [0, 1).
   * Uses the Mulberry32 hash — fast, low-quality but sufficient for games.
   * @returns {number} Float in [0, 1)
   */
  next() {
    let t = this._state += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  }

  /**
   * Return a random integer between min and max (both inclusive).
   * @param {number} min
   * @param {number} max
   * @returns {number}
   */
  int(min, max) { return Math.floor(this.next() * (max - min + 1)) + min; }

  /**
   * Return a random element from an array.
   * @param {Array} arr
   * @returns {*}
   */
  pick(arr) { return arr[this.int(0, arr.length - 1)]; }

  /**
   * Return a shuffled copy of the array (Fisher-Yates).
   * Does NOT mutate the original array.
   * @param {Array} arr
   * @returns {Array}
   */
  shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  /**
   * Pick one item from items[], using parallel weights[] for relative probability.
   * Each weight is consumed linearly; the first item whose cumulative weight
   * exceeds a random roll is returned.
   * @param {Array} items
   * @param {number[]} weights - must be same length as items
   * @returns {*}
   */
  weightedPick(items, weights) {
    const total = weights.reduce((a,b) => a+b, 0);
    let r = this.next() * total;
    for (let i = 0; i < items.length; i++) {
      r -= weights[i];
      if (r <= 0) return items[i];
    }
    return items[items.length - 1]; // fallback (floating point edge case)
  }
}

// ─────────────────────────────────────────────
// PERLIN NOISE — 2D classic Perlin implementation
// ─────────────────────────────────────────────
// Used by generateWorldMap() to drive three independent noise channels:
//   • elevation → determines ocean/swamp/volcano vs land tiles
//   • moisture  → shifts land toward forest or desert
//   • heat      → shifts land toward snow or desert
//
// The permutation table p[] is seeded from RNG so each game seed produces a
// unique world layout.
//
// EXTEND: add a third `altitude` channel to create mountain-top biomes.
class Perlin {
  /**
   * Build the permutation table from a seeded shuffle of 0-255.
   * The table is doubled (512 entries) to avoid modular wrapping in noise().
   * @param {number} seed
   */
  constructor(seed = 42) {
    this.rng = new RNG(seed);
    this.p = new Uint8Array(512);
    const base = Array.from({length:256}, (_,i) => i);
    const shuffled = this.rng.shuffle(base);
    for (let i = 0; i < 256; i++) this.p[i] = this.p[i + 256] = shuffled[i];
  }

  /** Ken Perlin's smooth-step easing curve: 6t⁵ − 15t⁴ + 10t³ */
  fade(t) { return t*t*t*(t*(t*6-15)+10); }

  /** Linear interpolation between a and b by factor t. */
  lerp(a,b,t) { return a + t*(b-a); }

  /**
   * Gradient function — maps a hash to one of four diagonal gradient vectors,
   * then computes the dot product with (x, y).
   */
  grad(hash, x, y) {
    const h = hash & 3;
    const u = h < 2 ? x : y, v = h < 2 ? y : x;
    return ((h & 1) ? -u : u) + ((h & 2) ? -v : v);
  }

  /**
   * Single-octave 2D Perlin noise. Returns a value roughly in [-1, 1].
   * @param {number} x
   * @param {number} y
   * @returns {number}
   */
  noise(x, y) {
    // Integer cell coordinates (wrapped to 0-255)
    const X = Math.floor(x) & 255, Y = Math.floor(y) & 255;
    // Fractional offsets within the cell
    x -= Math.floor(x); y -= Math.floor(y);
    // Fade curves for smooth blending
    const u = this.fade(x), v = this.fade(y);
    // Permutation table lookups for the four corner hashes
    const a = this.p[X]+Y, b = this.p[X+1]+Y;
    // Bilinear interpolation over the four corners
    return this.lerp(
      this.lerp(this.grad(this.p[a],   x,   y  ), this.grad(this.p[b],   x-1, y  ), u),
      this.lerp(this.grad(this.p[a+1], x,   y-1), this.grad(this.p[b+1], x-1, y-1), u),
      v
    );
  }

  /**
   * Fractal (octave) Perlin noise — sums multiple noise layers at increasing
   * frequency and decreasing amplitude for natural-looking terrain.
   * @param {number} x
   * @param {number} y
   * @param {number} octs      - number of octaves (more = more detail)
   * @param {number} persist   - amplitude multiplier per octave (0–1, lower = smoother)
   * @param {number} lacun     - frequency multiplier per octave (>1, higher = more detail)
   * @returns {number} normalised value in approximately [-1, 1]
   */
  octave(x, y, octs=4, persist=0.5, lacun=2) {
    let val=0, amp=1, freq=1, max=0;
    for (let i=0; i<octs; i++) {
      val += this.noise(x*freq, y*freq)*amp;
      max += amp; amp *= persist; freq *= lacun;
    }
    return val/max; // normalise so the sum stays in [-1,1]
  }
}

// ─────────────────────────────────────────────
// INDEXEDDB SAVE SYSTEM
// ─────────────────────────────────────────────
// DB is a singleton object wrapping browser IndexedDB with a Promise-based API.
// Database name: 'MelissasWrath', schema version 2.
// Two object stores:
//   • 'saves'    — keyed by slot number; stores serialised GameState snapshots
//   • 'settings' — keyed by string key; reserved for future audio/graphics prefs
//
// Usage:
//   await DB.init();                  // must be called once at boot
//   await DB.save(1, dataObj);        // persist to slot 1
//   const data = await DB.load(1);    // restore from slot 1 (null if empty)
//   const slots = await DB.listSlots(); // [{slot, ts}] for save-select UI
//   await DB.delete(1);               // erase slot 1
//
// EXTEND: add a 'settings' save/load pair for volume, keybinds, etc.
const DB = {
  _db: null,  // holds the open IDBDatabase instance after init()

  /**
   * Open (or upgrade) the IndexedDB database.
   * Creates the two object stores on first run or after a schema version bump.
   * Must resolve before any other DB method is called.
   * @returns {Promise<void>}
   */
  async init() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('MelissasWrath', 2);
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

  /**
   * Persist a plain-JS data object to a save slot.
   * Overwrites any existing record with the same slot number.
   * @param {number} slot - save slot index (1-based by convention)
   * @param {object} data - serialisable game snapshot
   * @returns {Promise<void>}
   */
  async save(slot, data) {
    return new Promise((resolve, reject) => {
      const tx = this._db.transaction('saves', 'readwrite');
      tx.objectStore('saves').put({ slot, data, ts: Date.now() });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  },
  /**
   * Retrieve a previously saved game snapshot from a slot.
   * @param {number} slot - save slot index to retrieve
   * @returns {Promise<object|null>} the saved data object, or null if the slot is empty
   */
  async load(slot) {
    return new Promise((resolve, reject) => {
      const tx = this._db.transaction('saves', 'readonly');
      const req = tx.objectStore('saves').get(slot);
      req.onsuccess = () => resolve(req.result ? req.result.data : null);
      req.onerror = () => reject(req.error);
    });
  },

  /**
   * Return a summary of all occupied save slots for the save-select UI.
   * Each entry contains { slot, ts } where ts is a Unix timestamp (ms).
   * @returns {Promise<Array<{slot:number, ts:number}>>}
   */
  async listSlots() {
    return new Promise((resolve, reject) => {
      const tx = this._db.transaction('saves', 'readonly');
      const req = tx.objectStore('saves').getAll();
      req.onsuccess = () => resolve(req.result.map(r => ({ slot: r.slot, ts: r.ts })));
      req.onerror = () => reject(req.error);
    });
  },

  /**
   * Permanently erase a save slot.
   * @param {number} slot - save slot index to delete
   * @returns {Promise<void>}
   */
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
// ECS CORE — Entity / World / EventBus
// ─────────────────────────────────────────────
// A lightweight, custom Entity-Component-System (ECS) framework.
//
// KEY CONCEPTS:
//   Entity  — a bag of components identified by a unique integer id.
//             Components are plain objects that always carry a `type` string.
//   World   — manages all live entities and optional update systems.
//             Querying is always linear-scan (the game world is small enough
//             that a spatial index is not needed).
//   EventBus — simple pub/sub used for decoupled scene communication.
//
// TYPICAL USAGE:
//   const world = new World();
//   const player = world.create()
//     .add(C.pos(10, 5))
//     .add(C.health(100, 100))
//     .tag('player');
//   const hp = player.get('health');   // → { type:'health', hp:100, maxHp:100, shield:0 }
//   player.has('health');              // → true
//   world.queryTag('monster');         // → Entity[]
//
// EXTEND: add a spatial grid (Map<string,Entity[]> keyed by "x,y") for O(1)
//         adjacency lookups — useful if monster count grows beyond ~50 per floor.

/** Monotonically increasing counter; every Entity receives a unique id. */
let _eidCounter = 0;

/**
 * A single game object — an integer id, a map of components, and a tag set.
 * Components are retrieved by their `type` string key.
 */
class Entity {
  /** @param {number} id - unique entity identifier */
  constructor(id) {
    this.id = id;
    /** @type {Object.<string, object>} component map — keyed by component type string */
    this.components = {};
    /** @type {Set<string>} tag set — e.g. 'player', 'monster', 'actor', 'boss', 'undead' */
    this.tags = new Set();
  }

  /**
   * Attach a component to this entity (replaces if the same type already exists).
   * Returns `this` for fluent chaining: entity.add(C.pos(x,y)).add(C.health(…))
   * @param {object} comp - component object with a `type` string property
   * @returns {Entity}
   */
  add(comp) { this.components[comp.type] = comp; return this; }

  /**
   * Retrieve a component by type string, or null if not present.
   * @param {string} type
   * @returns {object|null}
   */
  get(type) { return this.components[type] || null; }

  /**
   * Check whether the entity has a component of the given type.
   * @param {string} type
   * @returns {boolean}
   */
  has(type) { return type in this.components; }

  /**
   * Remove a component by type (no-op if absent).
   * @param {string} type
   */
  remove(type) { delete this.components[type]; }

  /**
   * Add a tag string (idempotent). Returns `this` for chaining.
   * @param {string} t
   * @returns {Entity}
   */
  tag(t) { this.tags.add(t); return this; }

  /**
   * @param {string} t
   * @returns {boolean}
   */
  hasTag(t) { return this.tags.has(t); }
}

/**
 * Manages all live entities and optional update systems.
 * The `eventBus` property provides decoupled event communication.
 */
class World {
  constructor() {
    /** @type {Map<number, Entity>} all live entities by id */
    this.entities = new Map();
    /** @type {Array} registered update systems (unused in current build — kept for EXTEND) */
    this.systems = [];
    /** @type {EventBus} shared pub/sub bus for cross-system events */
    this.eventBus = new EventBus();
  }

  /**
   * Allocate a new empty Entity, register it, and return it.
   * @returns {Entity}
   */
  create() {
    const e = new Entity(_eidCounter++);
    this.entities.set(e.id, e);
    return e;
  }

  /**
   * Remove an entity from the world by id. The Phaser sprite must be
   * destroyed separately in the scene's render cleanup.
   * @param {number} id
   */
  destroy(id) {
    this.entities.delete(id);
  }

  /**
   * Return all entities that possess ALL of the listed component types.
   * Linear scan — O(n) on entity count.
   * @param {...string} types - component type strings
   * @returns {Entity[]}
   */
  query(...types) {
    const result = [];
    for (const e of this.entities.values()) {
      if (types.every(t => e.has(t))) result.push(e);
    }
    return result;
  }

  /**
   * Return all entities that have a given tag string.
   * @param {string} tag
   * @returns {Entity[]}
   */
  queryTag(tag) {
    return [...this.entities.values()].filter(e => e.hasTag(tag));
  }

  /**
   * Return the FIRST entity that possesses ALL listed component types, or null.
   * Used as a fast lookup when exactly one such entity is expected (e.g. the player).
   * @param {...string} types
   * @returns {Entity|null}
   */
  first(...types) {
    for (const e of this.entities.values()) {
      if (types.every(t => e.has(t))) return e;
    }
    return null;
  }

  /** Register an update system. Systems must have an `update(world, dt)` method.
   *  Set `sys.enabled = false` to disable without removing.
   *  @param {object} sys */
  addSystem(sys) { this.systems.push(sys); }

  /**
   * Run all enabled systems (called each Phaser frame if systems are used).
   * @param {number} dt - delta time in milliseconds
   */
  tick(dt) {
    for (const sys of this.systems) {
      if (sys.enabled !== false) sys.update(this, dt);
    }
  }
}

/**
 * Minimal publish/subscribe event bus used for decoupled cross-scene messaging.
 * EXTEND: add wildcard listeners or once() helpers if event volume grows.
 */
class EventBus {
  constructor() {
    /** @type {Object.<string, Function[]>} event name → listener list */
    this._listeners = {};
  }

  /**
   * Subscribe to an event. Returns an unsubscribe function for easy cleanup.
   * @param {string} event
   * @param {Function} fn - called with (data) on each emit
   * @returns {Function} unsubscribe callback
   */
  on(event, fn) {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(fn);
    return () => this.off(event, fn); // return cleanup handle
  }

  /**
   * Remove a previously registered listener.
   * @param {string} event
   * @param {Function} fn
   */
  off(event, fn) {
    if (this._listeners[event])
      this._listeners[event] = this._listeners[event].filter(f => f !== fn);
  }

  /**
   * Fire an event, calling all registered listeners synchronously.
   * @param {string} event
   * @param {*} data - arbitrary payload passed to each listener
   */
  emit(event, data) {
    (this._listeners[event] || []).forEach(fn => fn(data));
  }
}

// ─────────────────────────────────────────────
// COMPONENT FACTORIES
// ─────────────────────────────────────────────
// `C` is a namespace of factory functions — each returns a plain component object
// with a mandatory `type` string property (used as the key in Entity.components).
//
// Components are intentionally thin data bags with no methods.
// All game logic lives in the scene methods and top-level functions (Layer 3–4).
//
// EXTEND: add new component factories here (e.g. `C.mount`, `C.dialogue`) and
//         handle them in the relevant scene update methods.
const C = {
  /** Grid position inside a dungeon floor or the world map (floor=0 on world map). */
  pos: (x, y, floor=0) => ({ type:'pos', x, y, floor }),

  /** Hit-points + optional shield-absorption pool. shield absorbs damage before hp. */
  health: (hp, maxHp) => ({ type:'health', hp, maxHp, shield:0 }),

  /**
   * Core combat stats. `xp`, `level`, `xpNext` track levelling.
   * `mp`/`maxMp` are added dynamically for the player when they learn spells.
   */
  stats: (atk, def, spd, mag, luk) => ({ type:'stats', atk, def, spd, mag, luk, xp:0, level:1, xpNext:100 }),

  /** Phaser rendering descriptor. `sprite` stores the live Phaser Image reference once created. */
  render: (key, tint=0xffffff, depth=10) => ({ type:'render', key, tint, depth, visible:true, sprite:null }),

  /** Marks an entity as a game actor (player or enemy); tracks whose turn it is. */
  actor: (faction='enemy', aiType='basic') => ({ type:'actor', faction, aiType, turn:0 }),

  /** Player inventory: item list, max capacity, and gold wallet. */
  inventory: () => ({ type:'inventory', items:[], maxSize:20, gold:0 }),

  /** Equipment slots. Each slot holds a full item-def copy when equipped. */
  equipment: () => ({ type:'equipment', weapon:null, armor:null, ring:null, amulet:null }),

  /**
   * Learned skills and skill-point pool.
   * `known` = [{id, level}], `tree` = mirror of SKILL_TREE for UI display.
   */
  skills: () => ({ type:'skills', known:[], active:null, points:0, tree:{} }),

  /** Active status effects array — each entry is a copy of a STATUS_DEFS entry plus runtime state. */
  status: () => ({ type:'status', effects:[] }),

  /** Field-of-vision: `visible` = currently lit tiles (cleared each turn); `explored` = ever-seen tiles. */
  fov: (radius=8) => ({ type:'fov', radius, visible:new Set(), explored:new Set() }),

  /**
   * Monster AI state machine.
   * `behavior` selects the AI branch in processMonsterTurns().
   * `path` holds the current A* route; `cooldowns` maps ability names to remaining cooldown turns.
   */
  ai: (type='basic') => ({ type:'ai', behavior:type, state:'idle', target:null, path:[], patrol:[], patrolIdx:0, cooldowns:{} }),

  /**
   * Boss-specific component. `phase` increments at HP thresholds.
   * `phaseThreshold` = [0.5, 0.25] by default (phase 2 at 50% HP, phase 3 at 25%).
   * `timer` counts turns since spawn (drives ability rotations).
   */
  boss: (pattern='none') => ({ type:'boss', pattern, phase:1, phaseThreshold:[0.5,0.25], abilities:[], timer:0 }),

  /** Loot descriptor attached to monsters/chests. `table` keys into LOOT_TABLES. */
  loot: (table='common') => ({ type:'loot', table, dropChance:0.8 }),
};

// =============================================================================
// ██╗      █████╗ ██╗   ██╗███████╗██████╗     ██████╗
// ██║     ██╔══██╗╚██╗ ██╔╝██╔════╝██╔══██╗    ╚════██╗
// ██║     ███████║ ╚████╔╝ █████╗  ██████╔╝     █████╔╝
// ██║     ██╔══██║  ╚██╔╝  ██╔══╝  ██╔══██╗    ██╔═══╝
// ███████╗██║  ██║   ██║   ███████╗██║  ██║    ███████╗
// ╚══════╝╚═╝  ╚═╝   ╚═╝   ╚══════╝╚═╝  ╚═╝    ╚══════╝
//
// DATA DEFINITIONS
// =============================================================================
// All static game content lives in this layer as plain `const` objects/arrays.
// Nothing in this layer has side effects or references Phaser — it is pure data.
//
// Sections (in order):
//   • ITEMS          — equipment, consumables, tomes, materials, keys
//   • LOOT_TABLES    — per-type drop lists; rollLoot() and rollRarityItem() helpers
//   • RECIPES        — crafting recipes (input items → output item)
//   • SPELLS         — spell definitions (cost, range, AOE, damage formula)
//   • COMPANIONS     — hireable party member definitions
//   • MOUNTS         — purchasable mount definitions
//   • MARKET_GOODS   — goods sold at market POIs; MarketState manages dynamic pricing
//   • SHINRE_DEFS    — 7 special temples, each granting a passive relic on completion
//   • FINAL_CASTLE   — endgame dungeon (unlocked after all 7 shinre cleared)
//   • SKILL_TREE     — 4-branch skill tree (warrior / mage / rogue / paladin)
//   • STATUS_DEFS    — status effect definitions (poison, burn, stun, etc.)
//   • MONSTERS       — 24 monster types spanning floor ranges 1–10
//
// EXTEND: add new items/spells/monsters by adding entries to the relevant objects.
//         No other code changes are required for the data to be picked up by
//         the loot roller, spawn system, and UI — they all read from these tables.
// =============================================================================

// ─────────────────────────────────────────────
// ITEM DATABASE
// ─────────────────────────────────────────────
// All item definitions as plain objects. Key fields:
//   id        — unique string key (matches the object key)
//   name      — display name
//   type      — 'weapon'|'armor'|'ring'|'amulet'|'potion'|'scroll'|'food'|'tome'|'material'|'key'
//   rarity    — RARITY constant (0–4)
//   icon      — emoji shown in inventory / message log
//   price     — base sell/buy price in gold
//   effect    — optional string flagging a special on-equip or on-use effect
// EXTEND: add new items here — they will automatically appear in loot tables and shops.
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
// LOOT_TABLES maps a table name to a list of item ids.
// Tables are keyed by rarity tier (common/uncommon/rare/epic/legendary),
// chest rarity (chest_common/chest_rare/chest_epic), and per-monster type.
//
// rollLoot(table, rng, floor) — draws 1–3 items from a table (more on deeper floors).
// rollRarityItem(rng, floor)  — picks one item with floor-weighted rarity roll.
//
// EXTEND: add per-biome or per-dungeon-type loot tables here.
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

/**
 * Roll a randomised loot drop from a named table.
 * Drops 1–3 items (count increases every 3 floors).
 * Each item is a shallow copy with `count:1, identified:false`.
 * @param {string} table - key into LOOT_TABLES (falls back to 'common')
 * @param {RNG} rng
 * @param {number} floor - current dungeon floor (affects drop count)
 * @returns {object[]} array of item copies
 */
function rollLoot(table, rng, floor=1) {
  const items = [];
  const t = LOOT_TABLES[table] || LOOT_TABLES.common;
  // Higher floors allow up to 3 items; floor 1 only drops 1
  const count = rng.int(1, Math.min(3, 1 + Math.floor(floor/3)));
  const candidates = rng.shuffle(t);
  for (let i = 0; i < Math.min(count, candidates.length); i++) {
    const item = { ...ITEMS[candidates[i]], count: 1, identified: false };
    items.push(item);
  }
  return items;
}

/**
 * Roll a single item by rarity tier, with the rarity distribution shifted
 * toward higher tiers on deeper floors.
 * The bonus is capped at +20 to COMMON weight reduction and +floor/5 to LEGENDARY.
 * @param {RNG} rng
 * @param {number} floor - current floor number
 * @returns {object|null} a shallow copy of an ITEMS entry, or null if the pool is empty
 */
function rollRarityItem(rng, floor=1) {
  const bonus = Math.min(floor * 2, 20);
  // Shift weight away from COMMON toward higher rarities as floors increase
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
// Each recipe entry:
//   id          — unique recipe id (e.g. 'r1')
//   name        — display name shown in the crafting UI
//   ingredients — {itemId: count} map; all must be present in inventory
//   result      — item id produced; a single copy is added to inventory
//   desc        — short human-readable ingredient summary for the UI
//
// The crafting system (in InventoryScene) scans this array to find
// which recipes the player can currently craft.
//
// EXTEND: add new recipes here — they will appear in the Craft tab automatically.
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
// Spell definitions read by castSpell() and the spell-targeting UI.
// Key fields:
//   id           — matches the key string (and is in the player's skills.known list)
//   mpCost       — mana deducted on cast (waived 20% of the time with archmage skill)
//   range        — max targeting range in tiles
//   aoe          — explosion radius in tiles (0 = single target)
//   damage       — damage expression string parsed by rollDice() e.g. '2d8+mag'
//   type         — damage element ('fire'|'ice'|'lightning'|'dark'|'heal'|'teleport')
//   effect       — on-hit status to apply (e.g. 'burn', 'slow', 'stun')
//   chain        — for lightning: how many targets it jumps to
//   lifesteal    — for life_drain: fraction of damage returned as HP
//   color/particleColor — Phaser tint values for visual effects
//
// Spells are learned from spell tomes (type:'tome' items in ITEMS).
// EXTEND: add new spells here and add a corresponding case in castSpell().
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
// Companion definitions for hireable party members found at Companion Camps.
// Key fields:
//   id         — unique companion id (used to look up the active companion)
//   price      — gold cost to hire at a camp
//   hp/atk/def — base stats at hire (do NOT scale with floor)
//   aiType     — 'melee'|'ranged'|'mage'; controls attack behaviour in monster turns
//   range      — attack range in tiles (1=adjacent, 4-5=ranged)
//   sprite     — texture key from generateSprites (reuses a monster sprite)
//   color      — Phaser tint applied to the sprite to distinguish it from monsters
//
// Only ONE companion can be active at a time (GameState.companion/companionEntity).
// EXTEND: add new companion types here and handle their aiType in processMonsterTurns().
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
// Mount definitions for purchasable mounts sold at Stables on the world map.
// Key fields:
//   stepsPerTurn  — world-map tiles moved per click-move step
//   bonusAtk/Def  — flat stat bonuses while mounted
//   wallWalk      — if true, the player can cross wall tiles (Pegasus)
//   trapImmune    — if true, trap tiles deal no damage
//   lavaImmune    — if true, lava tiles deal no damage
//   waterWalk     — if true, ocean/water tiles are passable
//
// Only ONE mount can be active at a time (GameState.mount).
// Mounts are only active on the world map — bonuses/immunities do NOT apply in dungeons.
// EXTEND: add new mounts here.
const MOUNTS = {
  horse:       { id:'horse',      name:'War Horse',         icon:'🐴', price:200,  stepsPerTurn:2, bonusAtk:0,  bonusDef:2,  wallWalk:false, trapImmune:false, lavaImmune:false, waterWalk:false, desc:'Move 2 tiles/turn. +2 DEF.' },
  warhorse:    { id:'warhorse',   name:'Warhorse',          icon:'🐎', price:400,  stepsPerTurn:2, bonusAtk:4,  bonusDef:4,  wallWalk:false, trapImmune:true,  lavaImmune:false, waterWalk:false, desc:'Move 2 tiles/turn. Immune to traps. +4 ATK/DEF.' },
  pegasus:     { id:'pegasus',    name:'Pegasus',           icon:'🦄', price:800,  stepsPerTurn:3, bonusAtk:0,  bonusDef:0,  wallWalk:true,  trapImmune:true,  lavaImmune:false, waterWalk:true,  desc:'Move 3 tiles/turn. Flies over walls & traps.' },
  dragon_m:    { id:'dragon_m',   name:'Dragon Mount',      icon:'🐉', price:2000, stepsPerTurn:2, bonusAtk:10, bonusDef:8,  wallWalk:false, trapImmune:true,  lavaImmune:true,  waterWalk:false, desc:'Move 2 tiles/turn. +10 ATK. Immune to traps & lava.' },
  shadow_wolf: { id:'shadow_wolf',name:'Shadow Wolf',       icon:'🐺', price:500,  stepsPerTurn:2, bonusAtk:6,  bonusDef:0,  wallWalk:false, trapImmune:true,  lavaImmune:false, waterWalk:false, desc:'Move 2 tiles/turn. +6 ATK. Immune to traps. Faster.' },
  turtle:      { id:'turtle',     name:'Iron Turtle',       icon:'🐢', price:120,  stepsPerTurn:1, bonusAtk:0,  bonusDef:12, wallWalk:false, trapImmune:true,  lavaImmune:false, waterWalk:false, desc:'Normal speed. Massive DEF bonus. Trap immune.' },
};

// ─────────────────────────────────────────────
// MARKET GOODS & DYNAMIC PRICING
// ─────────────────────────────────────────────
// MARKET_GOODS defines the fixed catalogue available at Market POIs.
// Each entry maps to an underlying ITEMS entry (itemId) with a base price range.
//
// MarketState tracks per-good price multipliers (priceFactors) that fluctuate
// after each dungeon completion via MarketState.fluctuate().
// Prices drift ±20% per fluctuation, clamped to [0.4×, 2.5×] of base.
//
// MarketState.getTrend() returns an arrow (▲/▼/●) + color for the price-trend UI.
// EXTEND: add new goods to MARKET_GOODS — they will appear in all market UIs.
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

/**
 * MarketState — singleton managing dynamic good prices across all Market POIs.
 * Prices start at 1.0× and drift up/down by ±0.2 each time fluctuate() is called.
 * Multipliers are clamped to [0.4, 2.5] to prevent extreme inflation/deflation.
 */
const MarketState = {
  /** @type {Object.<string,number>} goodId → current price multiplier */
  priceFactors: {},
  /** @type {RNG|null} separate RNG stream so market drift is seed-independent from dungeon gen */
  marketRNG: null,

  /**
   * Initialise price factors to 1.0 for all goods and seed the market RNG.
   * Must be called once before any market UI is shown.
   * @param {number} seed - game seed (XOR'd with 0xBEEF to get a distinct stream)
   */
  init(seed) {
    this.marketRNG = new RNG((seed ^ 0xBEEF) >>> 0);
    // Start every good at neutral pricing
    for (const g of MARKET_GOODS) this.priceFactors[g.id] = 1.0;
  },

  /**
   * Randomise all price factors by ±0.2 (called after each dungeon completion).
   * This simulates supply/demand shifts in the game economy.
   */
  fluctuate() {
    if (!this.marketRNG) return;
    for (const g of MARKET_GOODS) {
      const delta = (this.marketRNG.next() - 0.5) * 0.4; // ±0.2
      this.priceFactors[g.id] = Math.max(0.4, Math.min(2.5,
        (this.priceFactors[g.id] || 1.0) + delta
      ));
    }
  },

  /**
   * Compute the current gold price for a market good.
   * Uses the midpoint of the base price range, multiplied by the current factor.
   * @param {object} good - a MARKET_GOODS entry
   * @returns {number} current gold price (minimum 1)
   */
  getPrice(good) {
    const [lo, hi] = good.basePriceRange;
    const base = Math.floor((lo + hi) / 2);
    return Math.max(1, Math.round(base * (this.priceFactors[good.id] || 1.0)));
  },

  /**
   * Return a price-trend indicator for the UI (arrow + colour).
   * ▲ (red)   = price 30%+ above base
   * ▼ (green) = price 30%+ below base
   * ● (grey)  = near neutral
   * @param {object} good
   * @returns {{ arrow:string, color:string }}
   */
  getTrend(good) {
    const f = this.priceFactors[good.id] || 1.0;
    if (f > 1.3)  return { arrow:'▲', color:'#ff4444' };
    if (f < 0.7)  return { arrow:'▼', color:'#44ff88' };
    return { arrow:'●', color:'#aaaaaa' };
  }
};

// ─────────────────────────────────────────────
// SHINRE SYSTEM — Special Dungeons & Relics
// ─────────────────────────────────────────────
// "Shinre" (from "Shinrei" — spiritual) dungeons represent 7 wounds of love
// in the story's antagonist (Valdris / the Hero's alternate-universe grief).
// Clearing each temple seals one wound and grants Melissa a passive relic.
//
// SHINRE_DEFS — one entry per temple. Fields of interest:
//   id        — unique id; stored in GameState.shinreCompleted[] on clear
//   temple    — display name shown on the victory screen
//   relic     — the passive reward object (stored in GameState.relics[])
//     relic.effect — string identifying the passive behaviour in applyRelicEffects()
//   floors    — number of floors in this special dungeon (default 5)
//   desc      — story flavour text shown in the temple-enter dialog
//
// getShinreSpawnChance() — probability that a shinre temple spawns on the world map
//   (scales with dungeonCompleteCount so temples appear gradually).
//
// applyRelicEffects(player, turnsSinceHit, turnsNoAttack, inCombat)
//   — called every player turn; applies all collected relic passive effects.
//
// EXTEND: add new shinre temples here (up to any number).
//         Add the corresponding case in applyRelicEffects() to handle the new effect.
const SHINRE_DEFS = [
  {
    id: 'shinre_chosen',
    name: 'Being Chosen',
    temple: 'The Temple of the Sole Crown',
    icon: '👑',
    relic: {
      id: 'relic_diadem',
      name: 'The Singular Diadem',
      icon: '👑',
      desc: '+25% power when you have no active companions. Refuse 3 upgrades in a dungeon for a bonus turn.',
      passive: true,
      effect: 'solo_power',
    },
    color: 0xffd700,
    floors: 5,
    desc: 'She was never chosen — she waited and hoped while he looked elsewhere. Seal this need so Melissa is always his first choice.',
  },
  {
    id: 'shinre_respected',
    name: 'Being Respected',
    temple: 'The Temple of Unbroken Oaths',
    icon: '🤝',
    relic: {
      id: 'relic_seal',
      name: 'Seal of the Honored Name',
      icon: '🤝',
      desc: 'After 5 turns without taking damage, gain a shield bubble absorbing next hit.',
      passive: true,
      effect: 'honor_shield',
    },
    color: 0x44aaff,
    floors: 5,
    desc: 'She was diminished — in small moments, in front of others, in the silences he did not fill with care. Seal this need so she is always respected.',
  },
  {
    id: 'shinre_listened',
    name: 'Being Listened To',
    temple: 'The Whispering Sanctum',
    icon: '👂',
    relic: {
      id: 'relic_echo',
      name: 'Echo of the True Voice',
      icon: '👂',
      desc: 'Reveals all secret rooms. Enemies telegraph attacks — first strike of each fight deals no damage to you.',
      passive: true,
      effect: 'foresight',
    },
    color: 0xaaffee,
    floors: 5,
    desc: 'She spoke and was not heard. Her words dissolved into a silence he never noticed. Seal this need so Melissa is always truly listened to.',
  },
  {
    id: 'shinre_reassured',
    name: 'Being Reassured',
    temple: 'The Temple of Steadfast Light',
    icon: '🕯',
    relic: {
      id: 'relic_lantern',
      name: 'Lantern of Steady Flame',
      icon: '🕯',
      desc: 'Regenerate 2 HP every turn you are not in combat.',
      passive: true,
      effect: 'peaceful_regen',
    },
    color: 0xffee88,
    floors: 5,
    desc: 'She doubted and received nothing in return. The uncertainty grew inside her until it became larger than the love. Seal this need so she is always reassured.',
  },
  {
    id: 'shinre_equal',
    name: 'Being Treated as Equal',
    temple: 'The Twin Throne Chamber',
    icon: '⚖',
    relic: {
      id: 'relic_crown_equal',
      name: 'Crown of Equal Sovereignty',
      icon: '⚖',
      desc: 'Each attack raises your vulnerability by 2%. Each turn without attacking reduces it by 4%. Balance is power.',
      passive: true,
      effect: 'dynamic_balance',
    },
    color: 0xff88ff,
    floors: 5,
    desc: 'Love became something she had to earn while he had only to give or withhold it. She was never his equal. Seal this need so the bond is always balanced.',
  },
  {
    id: 'shinre_seen',
    name: 'Being Seen',
    temple: 'The Hall of True Sight',
    icon: '👁',
    relic: {
      id: 'relic_gem',
      name: 'Gem of Unveiled Presence',
      icon: '👁',
      desc: 'All invisible enemies revealed. +40% critical chance against marked targets.',
      passive: true,
      effect: 'true_sight',
    },
    color: 0x44ffaa,
    floors: 5,
    desc: 'She was present but invisible. He looked at her and saw a role, not a person — never the full truth of who she was. Seal this need so Melissa is always truly seen.',
  },
  {
    id: 'shinre_protected',
    name: 'Being Protected, Not Hurt',
    temple: 'The Bastion of Sacred Guard',
    icon: '🛡',
    relic: {
      id: 'relic_aegis',
      name: 'Aegis of the Untouched Queen',
      icon: '🛡',
      desc: 'A shield that regenerates 15 HP if you go 4 turns without attacking.',
      passive: true,
      effect: 'sacred_aegis',
    },
    color: 0x88ddff,
    floors: 5,
    desc: 'The one she trusted most with her whole self became the source of her deepest hurt. He did not mean to. It happened anyway. Seal this need so she is always safe with him.',
  },
];

// FINAL_CASTLE — endgame dungeon unlocked after all 7 shinre cleared.
// Appears as a large 🏰 marker on the world map (only after shinreCompleted.length >= 7).
const FINAL_CASTLE = {
  id: 'final_castle',
  name: "The Shattered Throne",
  icon: '🏰',
  temple: "Castle of the Broken Crown",
  color: 0xff4422,
  floors: 10,
  desc: 'The seat of all sorrow. End it.',
  isFinalBoss: true,
};

/**
 * Compute the probability that a Shinre temple spawns on the world map.
 * Starts at 5% and increases by 8% for each regular dungeon completed,
 * capped at 70% to ensure temple encounters remain optional.
 * @returns {number} spawn probability [0, 0.70]
 */
function getShinreSpawnChance() {
  const n = GameState.dungeonCompleteCount || 0;
  return Math.min(0.70, 0.05 + n * 0.08);
}

/**
 * Apply all collected relic passive effects to the player for one turn.
 * Called at the end of every player turn in DungeonScene.
 *
 * Each case matches a relic.effect string from SHINRE_DEFS:
 *   solo_power      — +25% ATK when no companion is active
 *   honor_shield    — grant a shield bubble after 5 turns without taking damage
 *   peaceful_regen  — heal 2 HP per turn while out of combat
 *   dynamic_balance — reduce attack-vulnerability counter by 4 per idle turn
 *   sacred_aegis    — restore a 15-HP aegis shield after 4 turns without attacking
 *
 * @param {Entity}  player
 * @param {number}  turnsSinceHit   - turns elapsed since the last time the player took damage
 * @param {number}  turnsNoAttack   - turns elapsed since the player last attacked
 * @param {boolean} inCombat        - true if any monster can see the player this turn
 */
function applyRelicEffects(player, turnsSinceHit, turnsNoAttack, inCombat) {
  const relics = GameState.relics || [];
  const hp  = player.get('health');
  const st  = player.get('stats');
  const inv = player.get('inventory');
  if (!hp || !st) return;

  for (const relic of relics) {
    switch (relic.effect) {
      case 'solo_power':
        if (!GameState.companionEntity) { st._relicAtk = (st._relicAtk||0) + 0; st._relicAtkBonus = Math.round((st.atk||5)*0.25); }
        else { st._relicAtkBonus = 0; }
        break;
      case 'honor_shield':
        if (turnsSinceHit >= 5 && !player._honorShield) {
          player._honorShield = true;
          GameState.addMessage(`${relic.icon} Honor Shield activated!`, '#44aaff');
        }
        break;
      case 'peaceful_regen':
        if (!inCombat && hp.hp < hp.maxHp) {
          hp.hp = Math.min(hp.maxHp, hp.hp + 2);
        }
        break;
      case 'dynamic_balance': {
        const vuln = Math.max(0, (player._dynVuln || 0) - 4);
        player._dynVuln = vuln;
        break;
      }
      case 'sacred_aegis':
        if (turnsNoAttack >= 4 && !player._aegisShield) {
          player._aegisShield = 15;
          GameState.addMessage(`${relic.icon} Aegis Shield recharged!`, '#88ddff');
        }
        break;
    }
  }
}

// ─────────────────────────────────────────────
// SKILL TREE
// ─────────────────────────────────────────────
// Four branches: warrior / mage / rogue / paladin.
// Each skill entry:
//   branch   — which tab it belongs to in SkillTreeScene
//   tier     — 1|2|3 (tier 1 = available at start; tiers 2/3 require prerequisites)
//   cost     — skill points to unlock/upgrade
//   maxLvl   — maximum level this skill can be taken to
//   req      — array of prerequisite skill ids (ALL must be unlocked before this is available)
//   passive  — true = always-on stat bonus; false = activated ability
//   effect   — string identifying the effect in the combat/action handlers
//
// Skill points are earned on level-up (one per level) and spent in SkillTreeScene.
// EXTEND: add new skills here. For passive skills, handle their effect string in
//         calcCombat(). For active skills, add a case in processPlayerTurn() input handling.
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
// STATUS_DEFS defines every possible status condition.
// At runtime each active effect on an entity is stored as a copy of this definition
// plus runtime fields: { stacks, startDur }.
//
// Key fields:
//   duration   — number of turns the effect lasts (refreshes to max if reapplied)
//   tickDamage — HP lost per turn (e.g. poison, burn)
//   tickHeal   — HP gained per turn (regen)
//   skipTurn   — if true, entity loses its turn while this effect persists (frozen, stun)
//   spdMod     — flat modifier to SPD stat (slow, haste)
//   fovMod     — flat modifier to FOV radius (blind)
//   atkMod/defMod — flat ATK/DEF bonus (bless)
//   atkMul/defMul — multiplicative ATK/DEF multiplier (berserk)
//
// applyStatus(entity, statusId, stacks) — adds/refreshes a status on an entity.
// tickStatus(entity)                    — advances all effects by one turn; returns
//                                         { damage, heal, skip, removed } summary.
// getStatusMods(entity)                 — aggregates all active modifiers into one object.
//
// EXTEND: add new status effects here and handle them in tickStatus() / getStatusMods().
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

/**
 * Apply (or refresh) a status effect on an entity.
 * If the effect is already present, its duration is refreshed to the maximum
 * of current and base, and stacks are incremented (capped at 3).
 * If new, a copy of the STATUS_DEFS entry is pushed onto the effects array.
 * @param {Entity} entity
 * @param {string} statusId - key in STATUS_DEFS
 * @param {number} stacks   - stack count to apply (default 1; stacking amplifies tickDamage)
 */
function applyStatus(entity, statusId, stacks=1) {
  const def = STATUS_DEFS[statusId];
  if (!def) return;
  const status = entity.get('status');
  if (!status) return;
  const existing = status.effects.find(e => e.id === statusId);
  if (existing) {
    // Refresh duration to the longer of current or base
    existing.duration = Math.max(existing.duration, def.duration);
    existing.stacks = Math.min((existing.stacks||1) + stacks, 3); // max 3 stacks
  } else {
    status.effects.push({ ...def, stacks, startDur: def.duration });
  }
}

/**
 * Advance all status effects by one turn on an entity.
 * Reduces each effect's remaining duration; removes expired effects.
 * Returns a summary of the net result for this turn.
 * @param {Entity} entity
 * @returns {{ damage:number, heal:number, skip:boolean, removed:string[] }}
 */
function tickStatus(entity) {
  const status = entity.get('status');
  if (!status) return { damage:0, heal:0, skip:false };
  let damage = 0, heal = 0, skip = false;
  const remove = [];
  for (const eff of status.effects) {
    if (eff.tickDamage) damage += eff.tickDamage * (eff.stacks||1); // stacks multiply damage
    if (eff.tickHeal)   heal   += eff.tickHeal;
    if (eff.skipTurn)   skip   = true;   // frozen / stun prevents action this turn
    eff.duration--;
    if (eff.duration <= 0) remove.push(eff.id); // expired — schedule removal
  }
  status.effects = status.effects.filter(e => !remove.includes(e.id));
  return { damage, heal, skip, removed:remove };
}

/**
 * Aggregate all active status-effect modifiers on an entity into a single
 * flat modifier object consumed by calcCombat() and computeFOV() calls.
 * Additive mods (+/-) are summed; multiplicative mods (×) are multiplied together.
 * @param {Entity} entity
 * @returns {{ atkMod:number, defMod:number, spdMod:number, fovMod:number, atkMul:number, defMul:number }}
 */
function getStatusMods(entity) {
  const status = entity.get('status');
  if (!status) return {};
  const mods = { atkMod:0, defMod:0, spdMod:0, fovMod:0, atkMul:1, defMul:1 };
  for (const eff of status.effects) {
    if (eff.atkMod) mods.atkMod += eff.atkMod;
    if (eff.defMod) mods.defMod += eff.defMod;
    if (eff.spdMod) mods.spdMod += eff.spdMod;
    if (eff.fovMod) mods.fovMod += eff.fovMod;
    if (eff.atkMul) mods.atkMul *= eff.atkMul; // berserk doubles ATK; multiplicative
    if (eff.defMul) mods.defMul *= eff.defMul; // berserk halves DEF; multiplicative
  }
  return mods;
}

// ─────────────────────────────────────────────
// MONSTER DATABASE
// ─────────────────────────────────────────────
// 24 monster types organised into 4 tiers by floor range.
// All numeric stats are BASE values; spawnMonster() scales them via floorDifficultyScale().
//
// Key fields per entry:
//   hp/atk/def/spd/luk — base stats
//   xp                 — XP awarded on kill (further scaled by floor in spawnMonster)
//   gold               — [min, max] gold drop range
//   lootTable          — key into LOOT_TABLES for item drops
//   floorRange         — [minFloor, maxFloor] — DungeonScene only spawns this monster
//                         when the current floor falls within this range
//   aiType             — selects the AI behaviour branch in processMonsterTurns()
//                         ('basic'|'erratic'|'swarm'|'aggressive'|'ranged'|'guardian'|
//                          'boss_lite'|'boss')
//   sprite             — texture key from generateSprites (mob_* or boss_*)
//   undead             — true → extra damage from holy_strike / divine_aura skills
//   regen              — HP regenerated per turn (troll, zombie)
//   statusOnHit        — status applied to the player when hit (e.g. 'poison', 'slow')
//   spells             — array of SPELLS keys the monster can cast
//   boss               — true → adds C.boss() component; activates processBossAI()
//   rare               — true → lower spawn weight (elite monsters)
//
// EXTEND: add new monsters here. They will be picked up automatically by the floor
//         spawner if their floorRange overlaps the current floor.
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

/**
 * Linear difficulty multiplier applied to monster HP, ATK, and DEF when spawning.
 * Formula: 1 + (floor - 1) × 0.11
 *   Floor 1 → 1.00 (no scaling)
 *   Floor 5 → 1.44
 *   Floor 10 → 2.00 (stats doubled)
 * @param {number} floor
 * @returns {number} scale factor ≥ 1.0
 */
function floorDifficultyScale(floor) {
  return 1 + (floor - 1) * 0.11;
}

/**
 * Spawn a monster entity in the ECS world at grid position (x, y).
 * Stats are scaled by floorDifficultyScale() with a small random HP variance.
 * Adds standard components: pos, health, stats, render, actor, ai, status, loot.
 * Bosses also receive the boss component and the 'boss' tag.
 * Gold drop and XP reward are pre-computed and stored directly on the entity.
 * @param {World}  world
 * @param {string} id    - key into MONSTERS
 * @param {number} x
 * @param {number} y
 * @param {number} floor
 * @param {RNG}    rng
 * @returns {Entity|null} the spawned entity, or null if id is unknown
 */
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

// =============================================================================
// ██╗      █████╗ ██╗   ██╗███████╗██████╗     ██████╗
// ██║     ██╔══██╗╚██╗ ██╔╝██╔════╝██╔══██╗    ╚════██╗
// ██║     ███████║ ╚████╔╝ █████╗  ██████╔╝        ██╔╝
// ██║     ██╔══██║  ╚██╔╝  ██╔══╝  ██╔══██╗       ██╔╝
// ███████╗██║  ██║   ██║   ███████╗██║  ██║    ██████╔╝
// ╚══════╝╚═╝  ╚═╝   ╚═╝   ╚══════╝╚═╝  ╚═╝    ╚═════╝
//
// PROCEDURAL GENERATION
// =============================================================================
// Functions that generate the game world at runtime from a seed.
//
// generateFloor(floor, seed)   — BSP dungeon generator
//   Produces a 50×50 tile grid with rooms, corridors, stairs, chests, traps,
//   water/lava pools, and room events.  Returns { tiles, rooms, chests, traps,
//   events, startX/Y, stairsDown }.
//
// generateWorldMap(seed)       — Perlin-noise overworld generator
//   Returns an 80×60 grid of biome tiles plus arrays of POIs:
//   dungeons, towns, markets, stables, camps.
//
// computeFOV(tiles, ox, oy, radius, visible, explored)
//   — Recursive shadowcasting across 8 octants; updates the `visible` and
//     `explored` Sets on the player's fov component.
//
// astar(tiles, sx, sy, ex, ey, passable, maxDist)
//   — A* pathfinder for dungeon tile movement.  Returns an ordered array of
//     {x,y} steps (not including the start).
//
// worldBFS(wm, sx, sy, ex, ey, maxDist)
//   — BFS path-finder for world map movement.  Returns an ordered {x,y} path
//     (including start and end).  Blocks on OCEAN tiles.
// =============================================================================

// ─────────────────────────────────────────────
// DUNGEON GENERATOR (BSP + Corridors)
// ─────────────────────────────────────────────
// Algorithm overview:
//   1. Build a BSP tree (bspSplit) over the COLS×ROWS tile grid.
//   2. For each leaf node, carve a randomly-sized room (bspCreateRooms).
//   3. Connect sibling nodes with L-shaped corridors (bspConnectRooms).
//   4. Place stairs, chests, traps, water/lava pools, and room events.
//
// TILE_TYPE — numeric tile enum (stored as Uint8Array for memory efficiency).
// TILE_CHAR — ASCII character for each tile type (for debug logging).
const TILE_TYPE = { WALL:0, FLOOR:1, DOOR:2, STAIRS_DOWN:3, STAIRS_UP:4, CHEST:5, TRAP:6, WATER:7, LAVA:8 };
const TILE_CHAR = { 0:'#', 1:'.', 2:'+', 3:'>', 4:'<', 5:'C', 6:'^', 7:'~', 8:'~' };

/**
 * A node in the Binary Space Partitioning tree.
 * The tree is used to subdivide the dungeon map into sections,
 * each of which eventually receives a randomly-sized room.
 *
 * `left`/`right` — child nodes (null in leaf nodes)
 * `room`         — axis-aligned room rect {x1,y1,x2,y2} (only set in leaf nodes)
 * `center`       — geometric centre used to compute corridor endpoints
 */
class BSPNode {
  constructor(x, y, w, h) {
    this.x=x; this.y=y; this.w=w; this.h=h;
    this.left=null; this.right=null;
    this.room=null;
  }
  /**
   * Recursively compute the centre of this subtree.
   * Leaf node → centre of its room.
   * Internal node → midpoint between left and right child centres.
   */
  get center() {
    if (this.room) return { x: Math.floor((this.room.x1+this.room.x2)/2), y: Math.floor((this.room.y1+this.room.y2)/2) };
    if (this.left && this.right) {
      const lc = this.left.center, rc = this.right.center;
      return { x: Math.floor((lc.x+rc.x)/2), y: Math.floor((lc.y+rc.y)/2) };
    }
    return { x: this.x + Math.floor(this.w/2), y: this.y + Math.floor(this.h/2) };
  }
}

/**
 * Recursively split a BSPNode either horizontally or vertically.
 * Stops when a node is too small to split further or the recursion depth exceeds 6.
 * Chooses horizontal vs vertical split randomly, biased toward the larger axis.
 * @param {BSPNode} node
 * @param {RNG} rng
 * @param {number} minSize - minimum side length for a child node (default 8)
 * @param {number} depth   - current recursion depth
 */
function bspSplit(node, rng, minSize=8, depth=0) {
  if (depth > 6) return; // stop to prevent over-subdivision
  const { x, y, w, h } = node;
  const canH = w > minSize*2; // can split horizontally (vertical dividing line)
  const canV = h > minSize*2; // can split vertically   (horizontal dividing line)
  if (!canH && !canV) return; // too small; this will be a leaf
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

/**
 * Traverse the BSP tree and carve a randomly-sized room into every leaf node.
 * Rooms are sized within [5 × 5] to [nodeW-4 × nodeH-4] with 2-tile padding.
 * @param {BSPNode} node
 * @param {RNG} rng
 * @returns {Array<{x1,y1,x2,y2}>} flat list of all created room rects
 */
function bspCreateRooms(node, rng) {
  if (!node.left && !node.right) {
    // Leaf node — carve a room within the node bounds with padding
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

/**
 * Recursively connect left and right subtrees with L-shaped corridors.
 * The elbow corner alternates between "horizontal then vertical" and
 * "vertical then horizontal" at random for visual variety.
 * @param {BSPNode} node
 * @param {Uint8Array[][]} tiles
 * @param {RNG} rng
 */
function bspConnectRooms(node, tiles, rng) {
  if (!node.left || !node.right) return; // leaf — nothing to connect
  bspConnectRooms(node.left,  tiles, rng); // connect children first (bottom-up)
  bspConnectRooms(node.right, tiles, rng);
  const a = node.left.center;  // centre of left subtree
  const b = node.right.center; // centre of right subtree
  // Randomly choose L-shape orientation
  if (rng.next() < 0.5) {
    carveH(tiles, a.x, b.x, a.y); // horizontal segment at a.y
    carveV(tiles, a.y, b.y, b.x); // vertical segment at b.x
  } else {
    carveV(tiles, a.y, b.y, a.x); // vertical segment at a.x first
    carveH(tiles, a.x, b.x, b.y); // horizontal segment at b.y
  }
}

/**
 * Set all tiles along a horizontal line at row y from x1 to x2 to FLOOR.
 * Clamps to grid bounds to prevent out-of-range writes.
 */
function carveH(tiles, x1, x2, y) {
  const [lo, hi] = x1<x2 ? [x1,x2] : [x2,x1];
  for (let x = lo; x <= hi; x++) {
    if (y >= 0 && y < ROWS && x >= 0 && x < COLS)
      tiles[y][x] = TILE_TYPE.FLOOR;
  }
}

/**
 * Set all tiles along a vertical line at column x from y1 to y2 to FLOOR.
 * Clamps to grid bounds.
 */
function carveV(tiles, y1, y2, x) {
  const [lo, hi] = y1<y2 ? [y1,y2] : [y2,y1];
  for (let y = lo; y <= hi; y++) {
    if (y >= 0 && y < ROWS && x >= 0 && x < COLS)
      tiles[y][x] = TILE_TYPE.FLOOR;
  }
}

/**
 * Generate a complete dungeon floor.
 * Steps:
 *   1. Build BSP tree → carve rooms → connect with corridors
 *   2. Sprinkle doors (5% chance on floor tiles with 2 adjacent walls)
 *   3. Place stairs-up (player spawn) and stairs-down (descent)
 *   4. Place 0–4 chests with weighted rarity
 *   5. Place 2–(5+floor) traps
 *   6. Place 0–3 water or lava pools (lava on floors 7+)
 *   7. Place 1–3 room events (shrine/merchant/altar/fountain/library/forge)
 *
 * @param {number} floor - dungeon floor number (1-based)
 * @param {number} seed  - game seed (XOR'd with floor number for unique layouts)
 * @returns {{
 *   tiles: Uint8Array[][],
 *   rooms: object[],
 *   floor: number,
 *   seed: number,
 *   startX: number, startY: number,
 *   stairsDown: {x,y},
 *   stairsUp: {x,y},
 *   chests: object[],
 *   traps: object[],
 *   events: object[],
 *   monsters: object[]
 * }}
 */
function generateFloor(floor, seed) {
  const rng = new RNG(seed ^ (floor * 0x9e3779b9)); // XOR with floor so each floor is unique
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

  // Procedural room events — exclude stair rooms to avoid overlap
  const events = [];
  const stairRoomSet = new Set([upRoom, downRoom]);
  const eventRooms = rng.shuffle([...rooms].filter(r => !stairRoomSet.has(r))).slice(0, rng.int(1,3));
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
/**
 * Generate the 80×60 overworld map using 3-channel Perlin noise.
 * Channel assignment:
 *   elevation — ocean/swamp/volcano vs habitable land
 *   moisture  — drives forest/desert differentiation
 *   heat      — drives snow/desert differentiation
 *
 * After biome assignment, POIs are placed by rejection sampling
 * (retry until a non-ocean, non-dungeon tile is found):
 *   8 dungeon entrances, 4 towns, 8 markets, 6 stables, 6 companion camps.
 *
 * @param {number} seed
 * @returns {{
 *   tiles: object[][],     80×60 biome grid
 *   dungeons: object[],
 *   towns: object[],
 *   markets: object[],
 *   stables: object[],
 *   camps: object[],
 *   seed: number
 * }}
 */
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
// FOV — RECURSIVE SHADOWCASTING
// ─────────────────────────────────────────────
// Uses the classic Roguelike "recursive shadowcast" algorithm across 8 octants.
// Each octant is described by a transformation matrix [xx,xy,yx,yy] that maps
// the algorithm's local (row, col) space back to world (x, y).
// See: http://www.roguebasin.com/index.php/FOV_using_recursive_shadowcasting
//
// computeFOV(tiles, ox, oy, radius, visible, explored):
//   Clears `visible`, adds the origin, then runs castLight in all 8 octants.
//   Tiles within `radius` squares whose line-of-sight is unobstructed by WALL
//   tiles are added to both `visible` (current turn) and `explored` (persistent).

/** Octant transformation matrices — each row: [xx, xy, yx, yy] */
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

/**
 * Compute the player's field of vision and update the visible/explored tile sets.
 * @param {Uint8Array[][]} tiles - dungeon tile grid
 * @param {number} ox      - observer x
 * @param {number} oy      - observer y
 * @param {number} radius  - sight radius in tiles (modifiable by blind status)
 * @param {Set<string>} visible   - cleared and repopulated each call ("x,y" strings)
 * @param {Set<string>} explored  - accumulates all ever-seen tiles (never cleared)
 */
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
// A* PATHFINDING (dungeon tile grid)
// ─────────────────────────────────────────────
// Standard A* with a Manhattan distance heuristic and a maxDist cap.
// Passability is injected as a callback so callers can define their own
// rules (player vs monster vs companion; monster positions excluded, etc.).
// Only 4-directional movement (no diagonals) to match the turn-based grid.

/**
 * Manhattan distance heuristic for A*.
 * @param {{x,y}} a
 * @param {{x,y}} b
 * @returns {number}
 */
function heuristic(a, b) {
  return Math.abs(a.x-b.x) + Math.abs(a.y-b.y);
}

/**
 * A* pathfinder for the dungeon tile grid.
 * Returns an ordered list of {x,y} steps from start to end (end is included;
 * start is NOT included in the returned path).
 * Returns an empty array if no path is found or start === end.
 *
 * @param {Uint8Array[][]} tiles     - dungeon tile grid (for bounds checking)
 * @param {number} sx, sy            - start coordinates
 * @param {number} ex, ey            - goal coordinates
 * @param {function(x:number, y:number): boolean} passable - returns true if a tile can be entered
 * @param {number} maxDist           - maximum path length (prevents expensive long searches)
 * @returns {{x:number, y:number}[]}
 */
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

/**
 * BFS pathfinder for the world map (80×60 grid).
 * Returns the complete path including start and end coordinates.
 * Blocks movement into OCEAN tiles.
 * Unlike dungeon A*, this uses BFS (not A*) because the world map is
 * large and movement costs are uniform.
 *
 * @param {object} wm       - world map object from generateWorldMap()
 * @param {number} sx, sy   - start coordinates
 * @param {number} ex, ey   - destination coordinates
 * @param {number} maxDist  - maximum BFS depth (default 120)
 * @returns {{x:number,y:number}[]} path from start to end, or [] if unreachable
 */
function worldBFS(wm, sx, sy, ex, ey, maxDist=120) {
  if (sx===ex && sy===ey) return [{x:sx,y:sy}];
  const key = (x,y) => y * WORLD_COLS + x;
  const came = new Map();
  const visited = new Set();
  const queue = [{x:sx,y:sy,dist:0}];
  visited.add(key(sx,sy));
  while (queue.length) {
    const cur = queue.shift();
    if (cur.dist > maxDist) continue;
    if (cur.x===ex && cur.y===ey) {
      // Reconstruct
      const path = [];
      let node = key(ex,ey);
      while (node !== undefined) {
        const x = node % WORLD_COLS, y = Math.floor(node / WORLD_COLS);
        path.unshift({x,y});
        node = came.get(node);
      }
      return path;
    }
    for (const d of DIRS4) {
      const nx = cur.x+d.dx, ny = cur.y+d.dy;
      if (nx<0||nx>=WORLD_COLS||ny<0||ny>=WORLD_ROWS) continue;
      const nk = key(nx,ny);
      if (visited.has(nk)) continue;
      const tile = wm.tiles[ny]?.[nx];
      if (!tile || tile.biome === BIOME.OCEAN) continue;
      visited.add(nk);
      came.set(nk, key(cur.x,cur.y));
      queue.push({x:nx,y:ny,dist:cur.dist+1});
    }
  }
  return [];
}

// =============================================================================
// ██╗      █████╗ ██╗   ██╗███████╗██████╗     ██╗  ██╗
// ██║     ██╔══██╗╚██╗ ██╔╝██╔════╝██╔══██╗    ██║  ██║
// ██║     ███████║ ╚████╔╝ █████╗  ██████╔╝    ███████║
// ██║     ██╔══██║  ╚██╔╝  ██╔══╝  ██╔══██╗    ╚════██║
// ███████╗██║  ██║   ██║   ███████╗██║  ██║         ██║
// ╚══════╝╚═╝  ╚═╝   ╚═╝   ╚══════╝╚═╝  ╚═╝         ╚═╝
//
// COMBAT & SYSTEMS
// =============================================================================
// This layer contains the unified simulation pipeline called each player turn:
//
//   rollDice(expr, rng)                        — parse "NdS+B" damage expressions
//   calcCombat(attacker, defender, rng, opts)  — full damage resolution (crits,
//       evasion, miss, skill mods, equipment effects, relic effects, status mods)
//   applyDamage(entity, damage)                — subtract HP (shield absorbs first)
//   applyHeal(entity, amount)                  — restore HP up to maxHp
//   castSpell(caster, spellId, target, ...)    — resolve each spell variant
//   processBossAI(boss, entity, player, ...)   — boss phase transitions & patterns
//
// All functions are pure (no direct Phaser calls) so they can be unit-tested
// independently of the scene.
// =============================================================================

// ─────────────────────────────────────────────
// COMBAT SYSTEM
// ─────────────────────────────────────────────

/**
 * Parse and evaluate a dice-roll expression string.
 * Supports NdS, NdS+B, NdS-B where N=count, S=sides, B=bonus.
 * The "+mag" suffix is intentionally NOT handled here — callers strip it
 * and add the MAG stat manually before/after calling rollDice.
 * Examples: "2d8+5" → 2-21, "1d6" → 1-6, "3d6+mag" → parses as 3d6 + 0 bonus.
 * @param {string} expr - dice expression
 * @param {RNG} rng
 * @returns {number}
 */
function rollDice(expr, rng) {
  const match = expr.match(/(\d+)d(\d+)([+-]\d+)?/);
  if (!match) return parseInt(expr) || 0;
  const count = parseInt(match[1]);
  const sides = parseInt(match[2]);
  const bonus = match[3] ? parseInt(match[3]) : 0;
  let total = 0;
  for (let i=0; i<count; i++) total += rng.int(1,sides);
  return total + bonus;
}

/**
 * Resolve a melee/ranged attack between two entities.
 * Damage pipeline (in order):
 *   1. Base ATK from stats + weapon + ring
 *   2. Base DEF from stats + armor
 *   3. Status multipliers / additive mods (berserk, bless, etc.)
 *   4. Skill crit bonus (blade_master, evasion_roll as crit—odd but intentional)
 *   5. Evasion check (SPD-based + shadow_cloak bonus) → miss if evaded
 *   6. Miss check (base 5% reduced by LUK) → miss if rolled
 *   7. Base damage = max(1, ATK - DEF ± 2 random)
 *   8. Skill modifiers: power_strike (×1.5–1.8), backstab (×3)
 *   9. Critical hit (×2 + 1d6 extra)
 *  10. Death touch (5% instakill with skill)
 *  11. Dragon slayer (×2.5 vs dragon/boss_lich)
 *  12. On-hit status: poison_on_hit (30%), burn_on_hit (25%), monster statusOnHit
 *
 * @param {Entity}  attacker
 * @param {Entity}  defender
 * @param {RNG}     rng
 * @param {object}  options
 * @param {boolean} [options.powerStrike]      - apply power strike multiplier
 * @param {number}  [options.powerStrikeLevel] - skill level for power strike
 * @param {boolean} [options.backstab]         - apply backstab (×3) multiplier
 * @returns {{ damage:number, crit:boolean, evaded:boolean, miss:boolean, instakill?:boolean }}
 */
function calcCombat(attacker, defender, rng, options={}) {
  const atkStats  = attacker.get('stats');
  const defStats  = defender.get('stats');
  const atkEquip  = attacker.get('equipment');
  const defEquip  = defender.get('equipment');
  const atkSkills = attacker.get('skills');

  let baseAtk = atkStats?.atk || 0;
  let baseDef = defStats?.def || 0;

  // Equipment flat bonuses applied first
  if (atkEquip?.weapon) baseAtk += atkEquip.weapon.atk || 0;
  if (defEquip?.armor)  baseDef += defEquip.armor.def  || 0;
  if (atkEquip?.ring)   baseAtk += atkEquip.ring.atk   || 0;

  // Apply active status effect modifiers
  const atkMods = getStatusMods(attacker);
  const defMods = getStatusMods(defender);
  baseAtk = Math.round(baseAtk * atkMods.atkMul) + atkMods.atkMod;
  baseDef = Math.round(baseDef * defMods.defMul) + defMods.defMod;

  // Crit chance: 5% base + 1% per LUK point + skill bonuses
  let critChance = 0.05 + (atkStats?.luk || 0) * 0.01;
  if (atkSkills) {
    const bm = atkSkills.known.find(s=>s.id==='blade_master');
    if (bm) critChance += 0.20;                       // blade_master: +20% crit
    const ev = atkSkills.known.find(s=>s.id==='evasion_roll');
    if (ev) critChance += ev.level * 0.15;            // evasion_roll repurposed as crit in old code
  }

  // Evasion — defender's SPD gives 2% dodge chance per point
  const evasion = (defStats?.spd || 0) * 0.02;
  const evadeRoll = defEquip?.armor?.effect === 'evasion' ? 0.2 : 0; // shadow_cloak: +20%
  if (rng.next() < evasion + evadeRoll) {
    return { damage:0, crit:false, evaded:true, miss:false };
  }

  // Miss chance — base 5%, reduced by LUK (cannot go below 0)
  const missChance = 0.05 - (atkStats?.luk||0)*0.005;
  if (rng.next() < Math.max(0, missChance)) {
    return { damage:0, crit:false, evaded:false, miss:true };
  }

  // Base damage: ATK vs DEF with ±2 random variance (minimum 1)
  let dmg = Math.max(1, baseAtk - baseDef + rng.int(-2, 2));

  // Power strike: scales from ×1.6 (level 1) to ×1.8 (level 3)
  if (options.powerStrike) dmg = Math.round(dmg * (1.5 + 0.1 * (options.powerStrikeLevel||1)));

  // Backstab: triple damage when attacking from behind (managed by scene logic)
  if (options.backstab) dmg = Math.round(dmg * 3);

  // Critical hit: ×2 + 1d6 bonus damage
  const crit = rng.next() < critChance;
  if (crit) dmg = Math.round(dmg * 2.0 + rng.int(1,6));

  // Death touch skill: 5% chance to deal 9999 (instant kill)
  if (atkSkills) {
    const dt = atkSkills.known.find(s=>s.id==='death_touch');
    if (dt && rng.next() < 0.05) return { damage:9999, crit:false, evaded:false, miss:false, instakill:true };
  }

  // Dragon slayer: ×2.5 against dragon and boss_lich
  if (atkEquip?.weapon?.effect === 'dragon_slayer') {
    const defDef = defender.components.monsterDef;
    if (defDef?.id === 'dragon' || defDef?.id === 'boss_lich') dmg = Math.round(dmg * 2.5);
  }

  dmg = Math.max(1, dmg); // always deal at least 1 damage

  // On-hit status effects from weapon or monster definition
  if (atkEquip?.weapon?.effect === 'poison_on_hit' || defender.components.monsterDef?.statusOnHit === 'poison') {
    if (rng.next() < 0.3) applyStatus(defender, 'poison');  // 30% poison on-hit
  }
  if (atkEquip?.weapon?.effect === 'burn_on_hit') {
    if (rng.next() < 0.25) applyStatus(defender, 'burn');   // 25% burn on-hit (Fire Wand)
  }

  return { damage:dmg, crit, evaded:false, miss:false };
}

/**
 * Subtract `damage` from an entity's HP, consuming the shield pool first.
 * Shield absorbs damage point-for-point before HP is reduced.
 * @param {Entity} entity
 * @param {number} damage - damage amount (must be ≥ 0)
 * @returns {boolean} true if the entity has been reduced to 0 HP (dead)
 */
function applyDamage(entity, damage) {
  const hp = entity.get('health');
  if (!hp) return false;
  // Absorb into shield pool before touching HP
  if (hp.shield > 0) {
    const absorbed = Math.min(hp.shield, damage);
    hp.shield -= absorbed;
    damage -= absorbed;
  }
  hp.hp = Math.max(0, hp.hp - damage);
  return hp.hp <= 0; // return true if entity just died
}

/**
 * Restore HP by `amount`, clamped to maxHp.
 * @param {Entity} entity
 * @param {number} amount - heal amount (must be ≥ 0)
 * @returns {number} actual HP gained (0 if already at max)
 */
function applyHeal(entity, amount) {
  const hp = entity.get('health');
  if (!hp) return 0;
  const before = hp.hp;
  hp.hp = Math.min(hp.maxHp, hp.hp + amount);
  return hp.hp - before; // actual amount healed
}

// ─────────────────────────────────────────────
// SPELL SYSTEM
// ─────────────────────────────────────────────
/**
 * Resolve a spell cast by `caster` and return the list of effect results.
 * Handles MP deduction (waived 20% with archmage skill), arcane surge doubling,
 * and dispatches to per-spell logic branches.
 *
 * `target` semantics vary by spell:
 *   fireball   — {x, y} tile coordinates (AOE centred there)
 *   ice_spike  — {entity, x, y} (single entity target)
 *   lightning  — {x, y} (chain starts from nearest monster to that point)
 *   mend       — ignored (heals caster)
 *   blink      — {x, y} (teleport destination)
 *   life_drain — {entity, x, y} (single entity)
 *
 * Returns an array of result objects. Each entry has at least:
 *   { entity, damage, dead }  (damage spells)
 *   { entity, heal }          (heal effects)
 *   { teleport, x, y }        (blink)
 *
 * @param {Entity}  caster
 * @param {string}  spellId   - key in SPELLS
 * @param {object}  target    - targeting info (varies by spell — see above)
 * @param {World}   world
 * @param {object}  floorData - current floor data (unused directly but passed for future use)
 * @param {RNG}     rng
 * @returns {object[]|null} array of result objects, or null if spellId is unknown
 */
function castSpell(caster, spellId, target, world, floorData, rng) {
  const spell = SPELLS[spellId];
  if (!spell) return null;
  const stats = caster.get('stats');
  const mag = stats?.mag || 0;  // MAG stat added to spell damage formulas
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
/**
 * Process special boss behaviour for one turn.
 * Called from DungeonScene.processMonsterTurns() BEFORE normal monster movement,
 * but only for entities that have the 'boss' component.
 *
 * Responsibilities:
 *   • Phase transitions — at HP thresholds (50% and 25%), apply status effects
 *     (berserk at phase 2, haste at phase 3) and optionally summon minions.
 *   • Pattern execution — each boss pattern fires abilities on a timer
 *     (boss_lich: summon every 3 turns, lightning every 5; dragon: fireball every 4,
 *      tail sweep every 8; default: fireball every 6).
 *
 * Returns an action descriptor object that the calling scene resolves, or null
 * if the boss takes no special action this turn.
 *
 * @param {object}  boss         - unused; kept for API symmetry
 * @param {Entity}  bossEntity
 * @param {Entity}  player
 * @param {World}   world
 * @param {object}  floorData
 * @param {RNG}     rng
 * @returns {{type:string, ...}|null}
 *   type 'phase_change' → {phase, msg, [summonCount]}
 *   type 'summon'       → {monster, count}
 *   type 'spell'        → {spell, target, [msg]}
 *   type 'aoe'          → {range, damage, msg}
 *   type 'self_heal'    → {amount, msg}
 */
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

// =============================================================================
// ██╗      █████╗ ██╗   ██╗███████╗██████╗     ███████╗
// ██║     ██╔══██╗╚██╗ ██╔╝██╔════╝██╔══██╗    ██╔════╝
// ██║     ███████║ ╚████╔╝ █████╗  ██████╔╝    ███████╗
// ██║     ██╔══██║  ╚██╔╝  ██╔══╝  ██╔══██╗    ╚════██║
// ███████╗██║  ██║   ██║   ███████╗██║  ██║    ███████║
// ╚══════╝╚═╝  ╚═╝   ╚═╝   ╚══════╝╚═╝  ╚═╝    ╚══════╝
//
// SPRITE GENERATION (Procedural Canvas Art)
// =============================================================================
// All game textures are drawn programmatically onto 16×16 HTML Canvas elements
// at boot time (BootScene.create calls generateSprites once).
// Phaser then manages these as named textures ("player", "tile_wall", "mob_goblin" etc.)
// and they are displayed via Phaser.GameObjects.Image with a 3× scale (TS = 48px).
//
// NO external image files are loaded — the game is fully self-contained.
//
// Sprite inventory:
//   • player       — Melissa (Valkyrie in blue armour)
//   • tile_*       — dungeon tiles (floor, wall, door, stairs_down/up, chest,
//                    chest_open, trap, water, lava)
//   • mob_*        — 20 procedurally-drawn monster sprites
//   • boss_lich    — boss-tier Lich King sprite
//   • cursor       — 1-tile highlight cursor
//   • world_*      — world map biome tiles + dungeon/town/player markers
//   • fog / fog_explored — darkness overlays
//   • particle_*   — spell effect particles (fire, ice, lightning, heal)
//   • xp_orb / gold_coin — pickup indicators
//
// EXTEND: call makeSprite(key, drawFn) to add new textures.
//         Use monsterSprite(key, body, eye, accent, extra) for new monster sprites.
// =============================================================================

// ─────────────────────────────────────────────
// SPRITE GENERATOR (Canvas-based pixel art)
// ─────────────────────────────────────────────
/**
 * Generate all game textures and register them with Phaser's texture manager.
 * Must be called exactly once before any scene that displays sprites.
 * @param {Phaser.Scene} scene - the BootScene instance (provides `scene.textures`)
 */
function generateSprites(scene) {
  const C16 = 16; // all sprites are 16×16 pixels

  /**
   * Create a named 16×16 Phaser canvas texture and render it with `drawFn`.
   * @param {string} key    - texture key used by Phaser (e.g. 'tile_wall')
   * @param {function(CanvasRenderingContext2D, number): void} drawFn
   */
  function makeSprite(key, drawFn) {
    const gfx = scene.textures.createCanvas(key, C16, C16);
    const ctx = gfx.getContext();
    drawFn(ctx, C16);
    gfx.refresh(); // flush canvas changes to the GPU texture
  }

  /**
   * Helper: paint a single pixel at (x, y) with CSS color string.
   * All sprite drawing is done at 1:1 pixel scale (scaled 3× by Phaser at display time).
   */
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

  makeSprite('tile_chest_open', (ctx) => {
    // Base (shorter, opened)
    ctx.fillStyle = '#6B3A2A';
    ctx.fillRect(2,9,12,5);
    ctx.fillStyle = '#8B5A3A';
    ctx.fillRect(3,10,10,4);
    // Open lid (leaning back)
    ctx.fillStyle = '#6B3A2A';
    ctx.fillRect(1,3,14,4);
    ctx.fillStyle = '#ffd700';
    ctx.fillRect(1,2,14,2); ctx.fillRect(0,3,2,4); ctx.fillRect(14,3,2,4);
    ctx.fillRect(2,9,1,5); ctx.fillRect(13,9,1,5);
    // Dark interior
    ctx.fillStyle = '#1a0d07';
    ctx.fillRect(3,10,10,3);
    // Hinges
    px(ctx,3,8,'#888'); px(ctx,12,8,'#888');
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
  /**
   * Generate a monster sprite using a shared base template (body, head, eyes, legs)
   * with per-monster colour and an optional `drawExtra` callback for unique features.
   * All monsters are 16×16 with a drop shadow at the bottom.
   * @param {string} key         - texture key (e.g. 'mob_goblin')
   * @param {string} bodyColor   - CSS colour for the torso and head
   * @param {string} eyeColor    - CSS colour for the two eye pixels
   * @param {string} accentColor - CSS colour for the legs / secondary surfaces
   * @param {function(CanvasRenderingContext2D): void} [drawExtra] - extra detail callback
   */
  function monsterSprite(key, bodyColor, eyeColor, accentColor, drawExtra) {
    makeSprite(key, (ctx) => {
      // Drop shadow (semi-transparent at feet)
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.fillRect(4,13,8,2);
      // Torso — two overlapping rects give a slightly rounded silhouette
      ctx.fillStyle = bodyColor;
      ctx.fillRect(5,4,6,7);
      ctx.fillRect(4,5,8,5);
      // Head
      ctx.fillRect(5,2,6,4);
      // Eyes — two single pixels
      ctx.fillStyle = eyeColor;
      px(ctx,6,3,eyeColor); px(ctx,9,3,eyeColor);
      // Legs — two pillars in accent colour
      ctx.fillStyle = accentColor;
      ctx.fillRect(5,11,2,3);ctx.fillRect(9,11,2,3);
      if (drawExtra) drawExtra(ctx); // per-monster customisation
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

  // ── MISSING MONSTER SPRITES ──
  monsterSprite('mob_rat', '#886644', '#ff2200', '#664422', ctx => {
    // pointed snout
    ctx.fillStyle = '#aa8866';
    ctx.fillRect(4,4,2,2); ctx.fillRect(3,5,2,1);
    // big ears
    px(ctx,5,2,'#cc9977'); px(ctx,10,2,'#cc9977');
    px(ctx,4,1,'#aa7755'); px(ctx,11,1,'#aa7755');
    // thin tail
    ctx.fillStyle = '#664422';
    ctx.fillRect(11,12,4,1); ctx.fillRect(14,11,1,2);
    // whiskers
    ctx.fillStyle = '#ccaa88';
    px(ctx,2,5,'#ccaa88'); px(ctx,3,5,'#ccaa88');
    px(ctx,12,5,'#ccaa88'); px(ctx,13,5,'#ccaa88');
  });

  monsterSprite('mob_slime', '#33aa33', '#ffff00', '#228822', ctx => {
    // blobby body — override with rounded shape
    ctx.fillStyle = '#33cc33';
    ctx.fillRect(3,6,10,7); ctx.fillRect(4,5,8,2); ctx.fillRect(5,4,6,1);
    ctx.fillRect(3,13,2,1); ctx.fillRect(11,13,2,1);
    // bubbles
    ctx.fillStyle = '#66ff66';
    px(ctx,6,7,'#66ff66'); px(ctx,10,8,'#66ff66'); px(ctx,8,11,'#66ff66');
    // drip
    ctx.fillStyle = '#22aa22';
    px(ctx,7,13,'#22aa22'); px(ctx,9,13,'#22aa22');
  });

  monsterSprite('mob_kobold', '#88aa22', '#ff4400', '#667711', ctx => {
    // lizard snout
    ctx.fillStyle = '#aabb33';
    ctx.fillRect(5,3,6,2); ctx.fillRect(4,4,2,1); ctx.fillRect(10,4,2,1);
    // scales on back
    ctx.fillStyle = '#667711';
    [5,7,9].forEach(x => px(ctx,x,5,'#556600'));
    // tail
    ctx.fillStyle = '#88aa22';
    ctx.fillRect(11,11,3,2); ctx.fillRect(13,10,2,1);
    // claws
    ctx.fillStyle = '#cccc88';
    px(ctx,4,12,'#cccc88'); px(ctx,5,13,'#cccc88');
    px(ctx,10,12,'#cccc88'); px(ctx,11,13,'#cccc88');
  });

  monsterSprite('mob_zombie', '#668855', '#ff0000', '#445533', ctx => {
    // tattered clothing
    ctx.fillStyle = '#334422';
    ctx.fillRect(4,7,8,5); ctx.fillRect(3,8,2,4); ctx.fillRect(11,8,2,4);
    // rot spots
    ctx.fillStyle = '#223311';
    px(ctx,6,8,'#223311'); px(ctx,9,9,'#223311'); px(ctx,7,11,'#223311');
    // outstretched arms
    ctx.fillStyle = '#668855';
    ctx.fillRect(2,5,3,2); ctx.fillRect(11,5,3,2);
    // exposed bone
    ctx.fillStyle = '#bbbbaa';
    px(ctx,3,6,'#bbbbaa'); px(ctx,12,6,'#bbbbaa');
  });

  monsterSprite('mob_gnoll', '#aa8844', '#ff4400', '#886622', ctx => {
    // hyena muzzle
    ctx.fillStyle = '#cc9955';
    ctx.fillRect(5,3,6,3); ctx.fillRect(4,4,2,2); ctx.fillRect(10,4,2,2);
    // pointed ears
    px(ctx,5,1,'#aa7733'); px(ctx,6,0,'#aa7733');
    px(ctx,9,1,'#aa7733'); px(ctx,10,0,'#aa7733');
    // spotted fur
    ctx.fillStyle = '#664422';
    px(ctx,6,6,'#664422'); px(ctx,9,7,'#664422'); px(ctx,7,9,'#664422');
    // weapon (spear)
    ctx.fillStyle = '#8B5A2A';
    ctx.fillRect(13,1,1,12);
    ctx.fillStyle = '#aaaaaa';
    ctx.fillRect(12,0,3,2);
  });

  monsterSprite('mob_wraith', '#aaccff', '#ffffff', '#6688cc', ctx => {
    // ghostly wisp body — override base with translucent-like effect
    ctx.fillStyle = '#8899cc';
    ctx.fillRect(4,3,8,9); ctx.fillRect(3,5,10,5);
    // tattered edges
    ctx.fillStyle = '#aaccff';
    [4,6,8,10].forEach(x => px(ctx,x,12,'#aaccff'));
    [3,5,7,9,11].forEach(x => px(ctx,x,11,'#8899cc'));
    // spectral glow
    ctx.fillStyle = '#ddeeff';
    px(ctx,7,5,'#ddeeff'); px(ctx,8,5,'#ddeeff');
    px(ctx,7,6,'#ddeeff'); px(ctx,8,6,'#ddeeff');
    // wispy arms
    ctx.fillStyle = '#6688cc';
    ctx.fillRect(1,5,3,2); ctx.fillRect(12,5,3,2);
    px(ctx,1,4,'#aaccff'); px(ctx,14,4,'#aaccff');
  });

  monsterSprite('mob_wyvern', '#228844', '#ff4400', '#114422', ctx => {
    // wings
    ctx.fillStyle = '#115533';
    ctx.fillRect(0,3,4,7); ctx.fillRect(12,3,4,7);
    ctx.fillStyle = '#0d3322';
    ctx.fillRect(1,4,2,5); ctx.fillRect(13,4,2,5);
    // tail with spike
    ctx.fillStyle = '#228844';
    ctx.fillRect(12,11,3,2); ctx.fillRect(14,10,2,1);
    px(ctx,15,9,'#44cc88');
    // neck frill
    ctx.fillStyle = '#44cc88';
    px(ctx,6,2,'#44cc88'); px(ctx,9,2,'#44cc88');
    px(ctx,7,1,'#44cc88'); px(ctx,8,1,'#44cc88');
  });

  monsterSprite('mob_minotaur', '#884422', '#ff2200', '#662211', ctx => {
    // wide bull head
    ctx.fillStyle = '#995533';
    ctx.fillRect(3,1,10,5);
    // horns
    ctx.fillStyle = '#ccaa55';
    ctx.fillRect(2,0,2,3); ctx.fillRect(12,0,2,3);
    px(ctx,1,0,'#ccaa55'); px(ctx,14,0,'#ccaa55');
    // nose ring
    ctx.fillStyle = '#ffd700';
    px(ctx,7,4,'#ffd700'); px(ctx,8,4,'#ffd700');
    // massive torso
    ctx.fillStyle = '#884422';
    ctx.fillRect(3,6,10,7);
    ctx.fillRect(1,7,3,5); ctx.fillRect(12,7,3,5);
    // axe
    ctx.fillStyle = '#888888';
    ctx.fillRect(13,3,2,5);
    ctx.fillRect(12,2,4,3);
  });

  monsterSprite('mob_assassin', '#334455', '#ff0088', '#223344', ctx => {
    // dark hood/cloak
    ctx.fillStyle = '#1a2233';
    ctx.fillRect(3,1,10,4); ctx.fillRect(2,4,12,9);
    // mask
    ctx.fillStyle = '#223344';
    ctx.fillRect(5,3,6,2);
    // daggers
    ctx.fillStyle = '#aaaacc';
    ctx.fillRect(2,5,1,5); ctx.fillRect(13,5,1,5);
    ctx.fillStyle = '#ccccff';
    px(ctx,2,4,'#ccccff'); px(ctx,13,4,'#ccccff');
    // glowing eyes
    ctx.fillStyle = '#ff0088';
    px(ctx,6,3,'#ff0088'); px(ctx,9,3,'#ff0088');
  });

  monsterSprite('mob_demon', '#cc2200', '#ffaa00', '#881100', ctx => {
    // horns
    ctx.fillStyle = '#660000';
    ctx.fillRect(4,0,2,3); ctx.fillRect(10,0,2,3);
    px(ctx,3,0,'#880000'); px(ctx,12,0,'#880000');
    // wings
    ctx.fillStyle = '#880000';
    ctx.fillRect(0,4,4,6); ctx.fillRect(12,4,4,6);
    ctx.fillStyle = '#550000';
    ctx.fillRect(1,5,2,4); ctx.fillRect(13,5,2,4);
    // claws
    ctx.fillStyle = '#440000';
    px(ctx,4,13,'#440000'); px(ctx,6,14,'#440000');
    px(ctx,9,13,'#440000'); px(ctx,11,14,'#440000');
    // fiery glow on chest
    ctx.fillStyle = '#ff4400';
    px(ctx,7,6,'#ff4400'); px(ctx,8,6,'#ff4400');
    px(ctx,7,7,'#ff6600'); px(ctx,8,7,'#ff6600');
  });

  monsterSprite('mob_darknight', '#222244', '#ff4444', '#111122', ctx => {
    // full plate helm
    ctx.fillStyle = '#334455';
    ctx.fillRect(4,1,8,5); ctx.fillRect(3,2,10,3);
    // visor slit
    ctx.fillStyle = '#ff4444';
    ctx.fillRect(5,3,6,1);
    // heavy shoulder pads
    ctx.fillStyle = '#334455';
    ctx.fillRect(1,5,4,4); ctx.fillRect(11,5,4,4);
    // dark armor body
    ctx.fillStyle = '#222244';
    ctx.fillRect(3,6,10,7);
    ctx.fillStyle = '#333366';
    // armor trim
    ctx.fillRect(3,6,1,7); ctx.fillRect(12,6,1,7);
    ctx.fillRect(3,10,10,1);
    // great sword
    ctx.fillStyle = '#aaaacc';
    ctx.fillRect(13,1,2,10);
    ctx.fillStyle = '#ccccff';
    px(ctx,13,0,'#ccccff'); px(ctx,14,0,'#ccccff');
    ctx.fillStyle = '#ffd700';
    ctx.fillRect(12,6,4,1); // crossguard
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
  // A 1-tile cursor used to show the player's current movement target
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

  // ── WORLD MAP TILES ──
  // One sprite per biome, painted with the BIOME_COLOR and a few dark dots for texture.
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

  // Player marker for world map — Melissa 💃
  makeSprite('world_player', (ctx) => {
    // Draw a dancer silhouette in gold
    ctx.fillStyle = '#ffd700';
    // head
    ctx.beginPath(); ctx.arc(8,3,2.5,0,Math.PI*2); ctx.fill();
    // body
    ctx.fillRect(6,6,4,5);
    // dress/skirt flare
    ctx.beginPath();
    ctx.moveTo(4,11); ctx.lineTo(12,11); ctx.lineTo(14,16); ctx.lineTo(2,16);
    ctx.closePath(); ctx.fill();
    // arms
    ctx.strokeStyle='#ffd700'; ctx.lineWidth=1.5;
    ctx.beginPath(); ctx.moveTo(6,7); ctx.lineTo(2,5); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(10,7); ctx.lineTo(14,5); ctx.stroke();
    // glow outline
    ctx.strokeStyle='#fff0aa'; ctx.lineWidth=0.5;
    ctx.strokeRect(1,1,14,14);
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

  console.log('[MelissasWrath] All sprites generated.');
}

// =============================================================================
// ██╗      █████╗ ██╗   ██╗███████╗██████╗      ██████╗
// ██║     ██╔══██╗╚██╗ ██╔╝██╔════╝██╔══██╗    ██╔════╝
// ██║     ███████║ ╚████╔╝ █████╗  ██████╔╝    ███████╗
// ██║     ██╔══██║  ╚██╔╝  ██╔══╝  ██╔══██╗    ██╔═══██╗
// ███████╗██║  ██║   ██║   ███████╗██║  ██║    ╚██████╔╝
// ╚══════╝╚═╝  ╚═╝   ╚═╝   ╚══════╝╚═╝  ╚═╝     ╚═════╝
//
// GLOBAL GAME STATE
// =============================================================================
// GameState is a plain singleton object — the single source of truth for the
// entire run. It is intentionally NOT a class so it can be mutated freely from
// any scene without ceremony.
//
// Key property groups:
//   Core       — seed, floor, turnCount, messageLog, phase
//   World      — worldMap (POIs), floorData (current dungeon layout)
//   ECS        — world (World instance), player (Entity), companionEntity
//   Equipment  — companion (def), mount (def)
//   Shinre     — shinreCompleted[], relics[], activeShinre, dungeonCompleteCount
//   Targeting  — targeting bool, selectedSpell, spellTarget
//   Relic timing — turnsSinceHit, turnsNoAttack
//
// Exposed at window.MelissasWrath for browser console debugging.
// =============================================================================

// ─────────────────────────────────────────────
// GLOBAL GAME STATE
// ─────────────────────────────────────────────
const GameState = {
  // ── Core ──
  seed: Math.floor(Math.random() * 0xFFFFFF), // randomised at new-game; deterministic thereafter
  floor: 1,          // current dungeon floor (1-based); 0 = on world map
  worldMap: null,    // result of generateWorldMap() — POI arrays + tile grid
  floorData: null,   // result of generateFloor() for the current dungeon floor
  world: null,       // ECS World instance (recreated each new-game / load)
  player: null,      // player Entity (set in WorldMapScene.create or TitleScene.loadGame)
  turnCount: 0,      // total turns elapsed (persisted to save)
  messageLog: [],    // [{text, color, turn}] — newest entries at index 0; max 50
  inDungeon: false,  // true when the Dungeon scene is active
  currentDungeon: null, // the dungeon POI object being explored (from worldMap.dungeons)
  phase: 'title',    // 'title' | 'worldmap' | 'dungeon' — drives scene logic guards
  saveSlot: 1,       // default save slot for quick-save (Q key)
  // ── Spell targeting ──
  spellTarget: null,    // {x,y} or {entity,x,y} selected by the targeting reticule
  selectedSpell: null,  // spell id string of the queued spell
  targeting: false,     // true while player is in spell-targeting mode
  // ── Companion & Mount ──
  companion: null,       // active companion definition object (from COMPANIONS), or null
  companionEntity: null, // live ECS Entity for the companion (null outside dungeon)
  mount: null,           // active mount definition object (from MOUNTS), or null
  // ── Shinre / Relic system ──
  shinreCompleted: [],      // array of shinre ids already cleared this run
  relics: [],               // array of relic definition objects collected so far
  dungeonCompleteCount: 0,  // number of regular dungeons cleared (drives shinre spawn chance)
  activeShinre: null,       // shinre definition being run right now, or null
  playerName: 'Melissa',    // display name (used in victory screens and messages)
  // ── Relic timing counters (reset on relevant events, used by applyRelicEffects) ──
  turnsSinceHit: 0,    // turns elapsed since last damage received (honor_shield relic)
  turnsNoAttack: 0,    // turns elapsed since last attack made (sacred_aegis relic)

  /**
   * Add a message to the message log and optionally display it as a toast.
   * Messages are prepended (newest first). Log is trimmed to 50 entries.
   * Non-default colours trigger a window.showToast() call for important events.
   * @param {string} text
   * @param {string} [color='#ccccee'] - hex colour for the log entry
   */
  addMessage(text, color='#ccccee') {
    this.messageLog.unshift({ text, color, turn:this.turnCount });
    if (this.messageLog.length > 50) this.messageLog.pop();
    // Show toast only for highlighted messages (not grey filler text)
    if (color !== '#ccccee' && color !== '#888888') window.showToast(text);
  },

  /**
   * Serialise the current run state to a plain JSON-safe object.
   * Only a compact subset of the ECS state is saved (components, not sprite refs).
   * @returns {object|null} serialised snapshot, or null if no player entity exists
   */
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
      },
      worldMapState: {
        dungeons: this.worldMap?.dungeons,
        shinres: this.worldMap?.shinres,
        finalCastle: this.worldMap?.finalCastle,
        towns: this.worldMap?.towns?.map(t => ({ x:t.x, y:t.y, visited:t.visited })),
      },
      shinreCompleted: this.shinreCompleted,
      relics: this.relics,
      dungeonCompleteCount: this.dungeonCompleteCount,
    };
  },

  /**
   * Serialise and write the current state to IndexedDB.
   * @param {number} [slot] - save slot; defaults to this.saveSlot
   * @returns {Promise<boolean>} true on success
   */
  async saveToDB(slot) {
    const data = this.serialize();
    if (!data) return false;
    try { await DB.save(slot || this.saveSlot, data); return true; }
    catch(e) { console.error('Save failed:', e); return false; }
  },

  /**
   * Read a save slot from IndexedDB.
   * @param {number} [slot] - save slot; defaults to this.saveSlot
   * @returns {Promise<object|null>} saved data, or null on error/empty slot
   */
  async loadFromDB(slot) {
    try {
      const data = await DB.load(slot || this.saveSlot);
      return data;
    } catch(e) { return null; }
  }
};

// =============================================================================
// ██╗      █████╗ ██╗   ██╗███████╗██████╗     ███████╗
// ██║     ██╔══██╗╚██╗ ██╔╝██╔════╝██╔══██╗    ╚════███╗
// ██║     ███████║ ╚████╔╝ █████╗  ██████╔╝        ████║
// ██║     ██╔══██║  ╚██╔╝  ██╔══╝  ██╔══██╗       ████╔╝
// ███████╗██║  ██║   ██║   ███████╗██║  ██║    ███████╔╝
// ╚══════╝╚═╝  ╚═╝   ╚═╝   ╚══════╝╚═╝  ╚═╝    ╚══════╝
//
// PHASER SCENES
// =============================================================================
// Scene lifecycle and relationships:
//
//   Boot  →  Title  →  WorldMap  ↔  Dungeon
//                         ↑            ↑
//                    (Inventory, SkillTree, HUD run as parallel overlays)
//                                        ↓
//                                    GameOver (on death)
//
// All scenes extend Phaser.Scene with key set in the constructor.
// The scene manager transitions are:
//   - scene.start('Key')   — stops current scene and starts new one
//   - scene.launch('Key')  — starts overlay without stopping current scene
//   - scene.stop('Key')    — stop a running overlay
//
// Scene inventory:
//   Boot       — sprites + DB init; launches Title immediately
//   Title      — main menu (new game / load / help); keyboard + pointer input
//   WorldMap   — overworld traversal, POI interaction, world monsters
//   Dungeon    — turn-based dungeon crawl (the core gameplay loop)
//   Inventory  — overlay: equipment, items, crafting
//   SkillTree  — overlay: 4-branch skill tree UI
//   HUD        — persistent overlay: HP/MP/gold/XP bars + spell slot display
//   GameOver   — death screen with retry / title options
//
// EXTEND: add new scenes by creating a class extending Phaser.Scene, passing
//         the key, and adding it to the Phaser.Game config scenes array at the
//         bottom of the file.
// =============================================================================

// ═══════════════════════════════════════════
// SCENE: BOOT
// Responsibilities: generate all procedural sprites, initialise IndexedDB,
// then immediately hand off to the Title scene.
// ═══════════════════════════════════════════
class BootScene extends Phaser.Scene {
  constructor() { super({ key:'Boot' }); }

  /** Called by Phaser after the scene is ready. Awaits DB.init() before transitioning. */
  async create() {
    generateSprites(this); // draw all textures onto Phaser canvas textures
    await DB.init();       // open/upgrade IndexedDB schema
    this.scene.start('Title');
  }
}

// ═══════════════════════════════════════════
// SCENE: TITLE
// Responsibilities: render the main menu, animate the title, handle
// new game / load game / help actions.
// Menu navigation: mouse/pointer click OR Arrow keys + Enter.
// Fades into WorldMap (new game) or Dungeon (resumed save).
// ═══════════════════════════════════════════
class TitleScene extends Phaser.Scene {
  constructor() { super({ key:'Title' }); }

  /** Build all title-screen visuals and register input handlers. */
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
    const titleText = this.add.text(W/2, H*0.18, "MELISSA'S WRATH", {
      fontFamily: '"Press Start 2P"',
      fontSize: Math.min(38, W/20) + 'px',
      color: '#ff6b35',
      stroke: '#000000', strokeThickness: 4,
      shadow: { offsetX:4, offsetY:4, color:'#ff6b3544', blur:8, fill:true }
    }).setOrigin(0.5);

    this.add.text(W/2, H*0.29, 'ENDLESS DESCENT', {
      fontFamily: '"Press Start 2P"',
      fontSize: Math.min(20, W/36) + 'px',
      color: '#ffaa44',
      stroke: '#000000', strokeThickness: 2,
    }).setOrigin(0.5);

    const subText = this.add.text(W/2, H*0.36, '— Melissa dances through the dark — 💃', {
      fontFamily: '"VT323"',
      fontSize: Math.min(26, W/28) + 'px',
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

  /** Move the star-field particles downward each frame to create a falling-snow effect. */
  update() {
    for (const star of this.particles) {
      star.y += star.speed;
      if (star.y > this.scale.height) star.y = 0; // wrap around to the top
    }
  }

  /**
   * Initialise a fresh GameState and transition to WorldMapScene.
   * Generates a new random seed, resets all run tracking, and creates a fresh ECS world.
   */
  startNewGame() {
    GameState.seed = Phaser.Math.Between(1, 0xFFFFFF);
    GameState.floor = 1;
    GameState.turnCount = 0;
    GameState.messageLog = [];
    GameState.inDungeon = false;
    // Init world ECS
    GameState.world = new World();
    GameState.worldMap = generateWorldMap(GameState.seed);
    GameState.playerName = 'Melissa';
    GameState.shinreCompleted = [];
    GameState.dungeonCompleteCount = 0;
    GameState.relics = [];
    this.scene.start('WorldMap');
  }

  /**
   * Load save slot 1 from IndexedDB, restore all GameState fields and the player
   * entity, then transition to WorldMap or Dungeon depending on where the player saved.
   * Shows a warning toast if no save data exists.
   */
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
    // Restore world map dynamic state (dungeons changed/completed, shinres, relics)
    if (data.worldMapState) {
      if (data.worldMapState.dungeons)    GameState.worldMap.dungeons    = data.worldMapState.dungeons;
      if (data.worldMapState.shinres)     GameState.worldMap.shinres     = data.worldMapState.shinres;
      if (data.worldMapState.finalCastle) GameState.worldMap.finalCastle = data.worldMapState.finalCastle;
      if (data.worldMapState.towns && GameState.worldMap.towns) {
        data.worldMapState.towns.forEach(saved => {
          const t = GameState.worldMap.towns.find(t2 => t2.x===saved.x && t2.y===saved.y);
          if (t) t.visited = saved.visited;
        });
      }
    }
    if (data.shinreCompleted)       GameState.shinreCompleted       = data.shinreCompleted;
    if (data.relics)                GameState.relics                = data.relics;
    if (data.dungeonCompleteCount)  GameState.dungeonCompleteCount  = data.dungeonCompleteCount;
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

  /**
   * Display an in-game help panel listing all keyboard controls and gameplay tips.
   * Panel is dismissed by clicking the CLOSE button or pressing Escape.
   */
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
// Responsibilities: render the 80×60 overworld map, manage player movement
// (keyboard + click-to-move BFS paths), spawn and fight world map monsters,
// handle all POI interactions (dungeons, towns, markets, stables, companion
// camps, Shinre temples, Final Castle).
//
// World map tile size is TILE × 2 = 32px (tileScale=2, not TS=48 like dungeon).
// Camera follows the 💃 player text marker with 0.12 smooth lag.
//
// Key private methods:
//   _worldStep(dir)          — move player one tile in a direction
//   _spawnWorldMonsters()    — place emoji-text world monsters at random tiles
//   _processWorldCombat()    — resolve player vs. world monster collision
//   _showMarket(mkt)         — open dynamic market UI panel
//   _showMountShop(W,H)      — open mount purchase UI
//   _showCompanionShop(W,H)  — open companion hire UI
//   _showShinreInfo(shinre)  — display temple lore dialog before entering
//   enterDungeon(dng)        — transition to DungeonScene for a regular dungeon
//   enterShinre(shinre)      — transition to DungeonScene for a Shinre temple
// ═══════════════════════════════════════════
class WorldMapScene extends Phaser.Scene {
  constructor() { super({ key:'WorldMap' }); }

  /** Build the entire world map display, player marker, POI sprites, and input handlers. */
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

    // Draw Shinre temples ✨
    for (const shinre of (wm.shinres || [])) {
      const sImg = this.add.image(shinre.x*tileSize, shinre.y*tileSize, 'world_dungeon')
        .setScale(this.tileScale).setOrigin(0).setTint(shinre.color || 0xffaa44)
        .setInteractive({ useHandCursor:true });
      sImg.on('pointerdown', () => this.enterShinre(shinre));
      sImg.on('pointerover', () => {
        const def = SHINRE_DEFS.find(s => s.id === shinre.shinreId);
        this.hoverText.setText(`✨ ${shinre.icon} ${shinre.name}\nShinre Temple\n${def?.relic?.name||'Relic inside'}\nClick to Enter`);
        this.hoverText.setVisible(true);
      });
      sImg.on('pointerout', () => this.hoverText.setVisible(false));
      this.mapContainer.add(sImg);
      const sLbl = this.add.text(shinre.x*tileSize + tileSize/2, shinre.y*tileSize - 4, shinre.icon||'✨', {fontSize:'14px'}).setOrigin(0.5,1).setDepth(22);
      this.mapContainer.add(sLbl);
    }

    // Draw Final Castle 🏰
    if (wm.finalCastle) {
      const fc = wm.finalCastle;
      const fcImg = this.add.image(fc.x*tileSize, fc.y*tileSize, 'world_dungeon')
        .setScale(this.tileScale * 1.3).setOrigin(0).setTint(0xff3300)
        .setInteractive({ useHandCursor:true });
      fcImg.on('pointerdown', () => this.enterShinre(fc));
      fcImg.on('pointerover', () => {
        this.hoverText.setText(`🏰 ${fc.name}\nFINAL BOSS\nAll relics collected!\nClick to Enter`);
        this.hoverText.setVisible(true);
      });
      fcImg.on('pointerout', () => this.hoverText.setVisible(false));
      this.mapContainer.add(fcImg);
      const fcLbl = this.add.text(fc.x*tileSize + tileSize/2, fc.y*tileSize - 8, '🏰', {fontSize:'18px'}).setOrigin(0.5,1).setDepth(23);
      this.mapContainer.add(fcLbl);
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

    // Player marker — Melissa 💃
    const ppos = GameState.player.get('pos');
    this.tileSize = tileSize; // store for update()
    this.playerMarker = this.add.text(
      ppos.x*tileSize + tileSize/2,
      ppos.y*tileSize + tileSize/2,
      '💃', { fontSize: '20px' }
    ).setOrigin(0.5).setDepth(20);
    this.mapContainer.add(this.playerMarker);

    // Camera follows player sprite
    const mapW = WORLD_COLS * tileSize;
    const mapH = WORLD_ROWS * tileSize;
    this.cameras.main.setBounds(0, 0, mapW, mapH);
    this.cameras.main.setZoom(1);
    this.cameras.main.startFollow(this.playerMarker, true, 0.12, 0.12);

    // World map monsters
    this.worldMonsters = [];
    this._spawnWorldMonsters();

    // World map turn cooldown (ms between steps when key held)
    this._worldStepCooldown = 0;
    this._worldMoving = false;

    // Keyboard movement
    this.input.keyboard.on('keydown', ev => {
      if (this.scene.isActive('Inventory') || this.scene.isActive('SkillTree')) return;
      const DIR_MAP = {
        ArrowUp:'U', KeyW:'U', ArrowDown:'D', KeyS:'D',
        ArrowLeft:'L', KeyA:'L', ArrowRight:'R', KeyD:'R',
        Numpad8:'U', Numpad2:'D', Numpad4:'L', Numpad6:'R',
        Numpad7:'UL', Numpad9:'UR', Numpad1:'DL', Numpad3:'DR',
      };
      const dir = DIR_MAP[ev.code];
      if (dir) { ev.stopPropagation(); this._wmClickPath = null; this._worldStep(dir); }
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

    // ── Click-to-move on world map ──────────────────────────────────
    this._wmClickPath = null;
    this._wmClickTarget = null;

    // Tile hover highlight
    const hlSize = tileSize - 2;
    this.wmHighlight = this.add.rectangle(0, 0, hlSize, hlSize, 0xffffff, 0)
      .setStrokeStyle(1, 0xffffff, 0.4).setDepth(18).setVisible(false);
    this.mapContainer.add(this.wmHighlight);

    this.input.on('pointermove', (ptr) => {
      const wx = this.cameras.main.scrollX + ptr.x;
      const wy = this.cameras.main.scrollY + ptr.y;
      const tx = Math.floor(wx / tileSize), ty = Math.floor(wy / tileSize);
      if (tx >= 0 && tx < WORLD_COLS && ty >= 0 && ty < WORLD_ROWS) {
        this.wmHighlight.setPosition(tx*tileSize + tileSize/2, ty*tileSize + tileSize/2).setVisible(true);
      } else {
        this.wmHighlight.setVisible(false);
      }
    });

    this.input.on('pointerdown', (ptr) => {
      // Ignore if a UI overlay is open (depth > 100 means a menu is visible)
      const wx = this.cameras.main.scrollX + ptr.x;
      const wy = this.cameras.main.scrollY + ptr.y;
      const tx = Math.floor(wx / tileSize), ty = Math.floor(wy / tileSize);
      if (tx < 0 || tx >= WORLD_COLS || ty < 0 || ty >= WORLD_ROWS) return;

      const tile = wm.tiles[ty]?.[tx];
      if (!tile) return;
      const ppos2 = GameState.player?.get('pos');
      if (!ppos2) return;

      // Check if clicked on a POI — if adjacent act immediately, else walk there
      const checkPOI = () => {
        const dist = Math.abs(tx - ppos2.x) + Math.abs(ty - ppos2.y);
        // Dungeons
        for (const dng of wm.dungeons) {
          if (dng.x === tx && dng.y === ty) {
            if (dist <= 1) { this.enterDungeon(dng); return true; }
            return false; // will pathfind
          }
        }
        // Towns
        for (const town of wm.towns) {
          if (town.x === tx && town.y === ty) {
            if (dist <= 1) { this.visitTown(town); return true; }
            return false;
          }
        }
        // Markets
        for (const mkt of (wm.markets||[])) {
          if (mkt.x === tx && mkt.y === ty) {
            if (dist <= 1) { this._showMarket(mkt); return true; }
            return false;
          }
        }
        // Stables
        for (const st of (wm.stables||[])) {
          if (st.x === tx && st.y === ty) {
            if (dist <= 1) { this._showMountShop(W, H); return true; }
            return false;
          }
        }
        // Camps
        for (const cp of (wm.camps||[])) {
          if (cp.x === tx && cp.y === ty) {
            if (dist <= 1) { this._showCompanionShop(W, H); return true; }
            return false;
          }
        }
        // Shinre temples
        for (const sh of (wm.shinres||[])) {
          if (sh.x === tx && sh.y === ty) {
            if (dist <= 1) { this.enterShinre(sh); return true; }
            return false;
          }
        }
        // Final Castle
        if (wm.finalCastle && wm.finalCastle.x === tx && wm.finalCastle.y === ty) {
          if (dist <= 1) { this.enterShinre(wm.finalCastle); return true; }
          return false;
        }
        return null; // not a POI
      };

      const poiResult = checkPOI();
      if (poiResult === true) return; // acted immediately

      // Path-find to clicked tile using world BFS
      if (tile.biome === BIOME.OCEAN && !GameState.mount?.waterWalk) return;
      const path = worldBFS(wm, ppos2.x, ppos2.y, tx, ty, 120);
      if (path && path.length > 1) {
        this._wmClickPath = path.slice(1);
        this._wmClickTarget = (poiResult === false) ? { x:tx, y:ty } : null;
        this._wmStepPath();
      }
    });

    GameState.addMessage("Welcome to Melissa's Wrath! Enter a dungeon to begin your adventure.", '#ffd700');
    GameState.addMessage('WASD/Arrows to move. Click on the map to walk there!', '#aaaaff');
  }

  /**
   * Build the world map HUD bar (HP/MP/gold/level text + Inventory button).
   * All elements use setScrollFactor(0) so they stay fixed to the camera.
   */
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

  /** Build the fixed-position biome/POI legend panel in the bottom-right corner. */
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
      { icon:'✨', color:'#ffee44', label:'Shinre Temple' },
      { icon:'🏰', color:'#ff4422', label:'Final Castle' },
      { icon:'💃', color:'#ffff44', label:'Melissa (you)' },
    ];
    items.forEach((it, i) => {
      this.add.text(lx+8,  ly+20+i*21, it.icon, { fontSize:'13px' }).setScrollFactor(0).setDepth(51);
      this.add.text(lx+24, ly+20+i*21, it.label, {
        fontFamily:'"VT323"', fontSize:'13px', color: it.color,
      }).setScrollFactor(0).setDepth(51);
    });
  }

  /** Refresh the world map HUD text values from the current player components. */
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

  /**
   * Transition the player into a dungeon or Shinre temple.
   * Sets up GameState (floor, floorData, currentDungeon, activeShinre) then starts DungeonScene.
   * @param {object} dng - dungeon POI object from worldMap.dungeons (or a shinre entry)
   */
  enterDungeon(dng) {
    const ppos = GameState.player.get('pos');
    ppos.x = dng.x; ppos.y = dng.y;
    GameState.inDungeon = true;
    GameState.floor = 1;
    GameState.currentDungeon = dng;
    dng.visited = true;
    // Support custom maxFloor per dungeon
    GameState.currentMaxFloor = dng.maxFloor || MAX_FLOORS;
    GameState.activeShinre = dng.isShinre ? dng : null;
    GameState.floorData = generateFloor(1, GameState.seed ^ (typeof dng.id === 'number' ? dng.id : 0));
    GameState.addMessage(`⚔ Melissa enters ${dng.name}...`, '#ff6b35');
    if (dng.isShinre) {
      const sdef = SHINRE_DEFS.find(s => s.id === dng.shinreId);
      if (sdef) GameState.addMessage(`✨ "${sdef.desc}"`, '#ffaa44');
    }
    this.scene.start('Dungeon');
  }

  /** Alias for enterDungeon — Shinre temple entries are treated as dungeons with isShinre=true. */
  enterShinre(shinre) {
    this.enterDungeon(shinre);
  }

  /**
   * Visit a town: rest (full HP/MP restore), then open the town shop.
   * Guards against re-entrancy with _visitingTown flag.
   */
  visitTown(town) {
    if (this._visitingTown) return;
    this._visitingTown = true;
    town.visited = true;
    this._showTownMenu(town);
  }

  /**
   * Display the town service panel (rest notification + item shop + companion/mount links).
   * All Phaser objects are tracked in `elements[]` and destroyed together on close.
   * A semi-transparent blocker rectangle captures pointer events behind the panel.
   */
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
    const closeAll = () => { elements.forEach(e => e.destroy()); this._visitingTown = false; };

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

  /**
   * Display the companion hire shop.
   * Lists all COMPANIONS with current/unavailable state and buy buttons.
   * Only one companion can be active at a time — hiring replaces the current one.
   */
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

  /**
   * Display the mount shop.
   * Lists all MOUNTS with buy buttons. On purchase, ATK/DEF bonuses are immediately
   * applied to the player stats.
   */
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

  /**
   * Display the dynamic market UI for a market POI.
   * Prices are read from MarketState.getPrice() and trend arrows from getTrend().
   * The Fluctuate Prices button calls MarketState.fluctuate() and reopens the panel.
   */
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

  /**
   * Execute one step along the stored world-map click path (_wmClickPath).
   * After each step, schedules itself again with a 130ms delay until the path
   * is exhausted, then fires any pending POI action at _wmClickTarget.
   * Stops immediately if a world monster blocks the next tile.
   */
  _wmStepPath() {
    if (!this._wmClickPath || this._wmClickPath.length === 0) {
      this._wmClickPath = null;
      // Execute POI action if we arrived at destination
      if (this._wmClickTarget) {
        const t = this._wmClickTarget; this._wmClickTarget = null;
        const wm = GameState.worldMap;
        const pos = GameState.player?.get('pos');
        if (!pos) return;
        const dist = Math.abs(t.x - pos.x) + Math.abs(t.y - pos.y);
        if (dist <= 1) {
          // Check what POI is here
          for (const dng of wm.dungeons) { if(dng.x===t.x&&dng.y===t.y){this.enterDungeon(dng);return;} }
          for (const town of wm.towns)   { if(town.x===t.x&&town.y===t.y){this.visitTown(town);return;} }
          for (const mkt of (wm.markets||[])) { if(mkt.x===t.x&&mkt.y===t.y){this._showMarket(mkt);return;} }
          for (const st of (wm.stables||[]))  { if(st.x===t.x&&st.y===t.y){this._showMountShop(this.scale.width,this.scale.height);return;} }
          for (const cp of (wm.camps||[]))    { if(cp.x===t.x&&cp.y===t.y){this._showCompanionShop(this.scale.width,this.scale.height);return;} }
        }
      }
      return;
    }
    const next = this._wmClickPath.shift();
    const pos  = GameState.player?.get('pos');
    if (!pos) return;
    // Check if world monster is on this tile — stop
    const blocked = this.worldMonsters?.find(m => m.alive && m.wx===next.x && m.wy===next.y);
    if (blocked) { this._wmClickPath = null; this._worldCombat(blocked); return; }
    // Determine direction and step
    const dx = Math.sign(next.x - pos.x), dy = Math.sign(next.y - pos.y);
    const dirMap = {
      '0,-1':'U','0,1':'D','-1,0':'L','1,0':'R',
      '-1,-1':'UL','1,-1':'UR','-1,1':'DL','1,1':'DR',
    };
    const dir = dirMap[`${dx},${dy}`] || 'U';
    this._worldStep(dir);
    if (this._wmClickPath && this._wmClickPath.length > 0) {
      this.time.delayedCall(130, () => this._wmStepPath());
    } else {
      this.time.delayedCall(150, () => this._wmStepPath()); // trigger target action
    }
  }

  // ─────────────────────────────────────────
  // WORLD MAP MOVEMENT
  // ─────────────────────────────────────────
  /**
   * Move the player one tile in the given compass direction.
   * Blocks on OCEAN tiles unless the mount has waterWalk.
   * After moving, tweens the player marker, checks interactions, and ticks world monsters.
   * @param {string} dir - 'U'|'D'|'L'|'R'|'UL'|'UR'|'DL'|'DR'
   */
  _worldStep(dir) {
    const DIRS = {
      U:{dx:0,dy:-1}, D:{dx:0,dy:1}, L:{dx:-1,dy:0}, R:{dx:1,dy:0},
      UL:{dx:-1,dy:-1}, UR:{dx:1,dy:-1}, DL:{dx:-1,dy:1}, DR:{dx:1,dy:1},
    };
    const d = DIRS[dir]; if (!d) return;
    const p    = GameState.player;
    const pos  = p.get('pos');
    const nx   = pos.x + d.dx, ny = pos.y + d.dy;
    const wm   = GameState.worldMap;
    if (nx < 0 || nx >= WORLD_COLS || ny < 0 || ny >= WORLD_ROWS) return;
    const tile = wm.tiles[ny][nx];
    // Block ocean tiles
    if (tile.biome === BIOME.OCEAN && !(GameState.mount?.waterWalk)) return;

    pos.x = nx; pos.y = ny;
    const ts = this.tileSize;
    this.tweens.add({
      targets: this.playerMarker,
      x: nx*ts + ts/2, y: ny*ts + ts/2,
      duration: 100, ease: 'Linear',
    });

    // Proximity interactions
    this._checkWorldInteractions(nx, ny, wm);

    // Tick world monsters every step
    this._processWorldMonsters();
    this._updateHUD();
  }

  /**
   * Check if the player's new position (x, y) coincides with any POI or world monster.
   * Called after every movement step. Acts immediately — no dialog required.
   * @param {number} x
   * @param {number} y
   * @param {object} wm - world map data
   */
  _checkWorldInteractions(x, y, wm) {
    // Auto-enter/visit only when player steps ON the tile (dist = 0)
    for (const dng of wm.dungeons) {
      if (dng.x === x && dng.y === y) { this.enterDungeon(dng); return; }
    }
    for (const town of wm.towns) {
      if (town.x === x && town.y === y) { this.visitTown(town); return; }
    }
    for (const mkt of (wm.markets||[])) {
      if (mkt.x === x && mkt.y === y) { this._showMarket(mkt); return; }
    }
    for (const st of (wm.stables||[])) {
      if (st.x === x && st.y === y) { this._showMountShop(this.scale.width, this.scale.height); return; }
    }
    for (const cp of (wm.camps||[])) {
      if (cp.x === x && cp.y === y) { this._showCompanionShop(this.scale.width, this.scale.height); return; }
    }
    // Shinre temples
    for (const sh of (wm.shinres||[])) {
      if (sh.x === x && sh.y === y) { this.enterShinre(sh); return; }
    }
    // Final Castle
    if (wm.finalCastle && wm.finalCastle.x === x && wm.finalCastle.y === y) {
      this.enterShinre(wm.finalCastle); return;
    }
    // World monster combat on same tile
    const hit = this.worldMonsters?.find(m2 => m2.alive && m2.wx === x && m2.wy === y);
    if (hit) this._worldCombat(hit);
  }

  // ─────────────────────────────────────────
  // WORLD MAP MONSTERS
  // ─────────────────────────────────────────
  /**
   * Spawn 24 world-map monsters at random non-ocean tiles.
   * Each monster is a plain object (not an ECS entity) with:
   *   {icon, hp, maxHp, atk, def, xp, gold, wx, wy, sprite, hpBg, hpBar, alive}
   * Monsters are displayed as emoji text objects; HP bars use rectangle pairs.
   * All sprite/bar objects are added to mapContainer for proper world-space rendering.
   */
  _spawnWorldMonsters() {
    const wm = GameState.worldMap;
    const ts = this.tileSize;
    const COUNT = 24;
    const WORLD_MON_TYPES = [
      { id:'monkey',  name:'Monkey Troop', icon:'🐒', hp:22,  atk:7,  def:1,  xp:18,  gold:5,  color:0xaa8844 },
      { id:'gorilla', name:'Gorilla',      icon:'🦍', hp:50,  atk:13, def:5,  xp:45,  gold:10, color:0x887766 },
      { id:'wolf',    name:'Wolf Pack',    icon:'🐺', hp:30,  atk:8,  def:2,  xp:20,  gold:5,  color:0xaaaaaa },
      { id:'cat',     name:'Wild Cat',     icon:'🐱', hp:18,  atk:9,  def:1,  xp:15,  gold:4,  color:0xddaa88 },
      { id:'horse',   name:'Wild Horse',   icon:'🐴', hp:40,  atk:10, def:3,  xp:30,  gold:8,  color:0xaa8866 },
      { id:'zebra',   name:'Zebra Herd',   icon:'🦓', hp:35,  atk:8,  def:3,  xp:25,  gold:7,  color:0xdddddd },
      { id:'deer',    name:'Stag',         icon:'🦌', hp:28,  atk:7,  def:2,  xp:20,  gold:6,  color:0xcc9966 },
      { id:'bull',    name:'Wild Bull',    icon:'🐂', hp:55,  atk:14, def:6,  xp:50,  gold:15, color:0x774422 },
      { id:'boar',    name:'Boar Pack',    icon:'🐖', hp:32,  atk:11, def:4,  xp:28,  gold:9,  color:0xaa6644 },
      { id:'ram',     name:'Ram',          icon:'🐏', hp:30,  atk:10, def:4,  xp:25,  gold:7,  color:0xbbbbaa },
      { id:'camel',   name:'Camel',        icon:'🐪', hp:45,  atk:9,  def:5,  xp:35,  gold:12, color:0xddbb66 },
      { id:'elephant',name:'Elephant',     icon:'🐘', hp:90,  atk:20, def:10, xp:90,  gold:40, color:0x888888 },
      { id:'rhino',   name:'Rhino',        icon:'🦏', hp:80,  atk:18, def:9,  xp:80,  gold:35, color:0x999977 },
      { id:'mouse',   name:'Giant Mouse',  icon:'🐭', hp:12,  atk:5,  def:1,  xp:10,  gold:3,  color:0xddaaaa },
    ];
    for (let i=0; i<COUNT; i++) {
      let wx, wy, att=0;
      do {
        wx = Math.floor(Math.random()*WORLD_COLS);
        wy = Math.floor(Math.random()*WORLD_ROWS);
        att++;
      } while (wm.tiles[wy]?.[wx]?.biome === BIOME.OCEAN && att < 80);
      const def = WORLD_MON_TYPES[i % WORLD_MON_TYPES.length];
      const sprite = this.add.text(wx*ts + ts/2, wy*ts + ts/2, def.icon, {fontSize:'18px'})
        .setOrigin(0.5).setDepth(15);
      this.mapContainer.add(sprite);
      // HP bar
      const hpBg  = this.add.rectangle(wx*ts+ts/2, wy*ts+4, ts-4, 3, 0x440000).setDepth(16);
      const hpBar = this.add.rectangle(wx*ts+2, wy*ts+4, ts-4, 3, 0xff4444).setOrigin(0,0.5).setDepth(17);
      this.mapContainer.add(hpBg); this.mapContainer.add(hpBar);
      this.worldMonsters.push({
        ...def, wx, wy, maxHp: def.hp, sprite, hpBg, hpBar, alive: true,
      });
    }
  }

  /**
   * Tick all world monsters once per player step.
   * Monsters within 8 tiles of the player chase at 1-tile/step speed.
   * Adjacent monsters (dist <= 1) initiate combat immediately.
   */
  _processWorldMonsters() {
    const p    = GameState.player;
    const pos  = p.get('pos');
    const ts   = this.tileSize;
    const wm   = GameState.worldMap;
    for (const mon of this.worldMonsters) {
      if (!mon.alive) continue;
      const dx = pos.x - mon.wx, dy = pos.y - mon.wy;
      const dist = Math.abs(dx)+Math.abs(dy);
      if (dist <= 1) { this._worldCombat(mon); continue; }
      if (dist <= 8) {
        // Move one step toward player
        const sx = Math.sign(dx), sy = Math.sign(dy);
        let nx = mon.wx + sx, ny = mon.wy + sy;
        if (wm.tiles[ny]?.[nx]?.biome === BIOME.OCEAN) { nx = mon.wx; ny = mon.wy; }
        mon.wx = nx; mon.wy = ny;
        this.tweens.add({
          targets: [mon.sprite, mon.hpBg, mon.hpBar],
          x: nx*ts + ts/2, y: ny*ts + ts/2,
          duration: 150, ease:'Linear',
        });
        mon.hpBg.x  = nx*ts + ts/2;
        mon.hpBar.x = nx*ts + 2;
      }
    }
  }

  /**
   * Resolve one round of world-map combat between the player and a world monster.
   * World combat is simplified (no crits, no status effects):
   *   player attacks monster → monster attacks back (if still alive) → check for death.
   * Kills award XP, gold, and may trigger a level-up via _checkLevelUp().
   * @param {object} mon - world monster object from worldMonsters[]
   */
  _worldCombat(mon) {
    if (!mon.alive) return;
    const p   = GameState.player;
    const st  = p.get('stats');
    const hp  = p.get('health');
    const inv = p.get('inventory');

    // Player attacks monster — simplified damage formula (no crits)
    const pAtk   = (st?.atk||5) + (p.get('equipment')?.weapon?.atk||0);
    const monDef = mon.def || 0;
    const pDmg   = Math.max(1, pAtk - monDef + Math.floor(Math.random()*4-2));
    mon.hp -= pDmg;
    GameState.addMessage(`You hit ${mon.name} for ${pDmg} damage!`, '#ffff88');

    // Update HP bar
    const ratio = Math.max(0, mon.hp / mon.maxHp);
    mon.hpBar.setScale(ratio, 1);

    if (mon.hp <= 0) {
      mon.alive = false;
      mon.sprite.destroy(); mon.hpBg.destroy(); mon.hpBar.destroy();
      this.worldMonsters = this.worldMonsters.filter(m => m !== mon);
      const xp = mon.xp || 20, gold = mon.gold || 5;
      if (st) { st.xp += xp; }
      if (inv) inv.gold += gold;
      GameState.addMessage(`${mon.name} defeated! +${xp}XP +${gold}💰`, '#44ff88');
      // Respawn after delay
      this.time.delayedCall(15000, () => {
        if (this.worldMonsters.length < 20) this._spawnWorldMonsters_one();
      });
      return;
    }

    // Monster attacks back
    const mDmg = Math.max(1, mon.atk - (st?.def||0) + Math.floor(Math.random()*3-1));
    if (hp) {
      hp.hp = Math.max(0, hp.hp - mDmg);
      GameState.addMessage(`${mon.name} hits you for ${mDmg} damage!`, '#ff6666');
      if (hp.hp <= 0) {
        GameState.addMessage('You died on the world map! Respawning...', '#ff0000');
        hp.hp = Math.floor(hp.maxHp * 0.5);
        // Move to nearest dungeon entrance
        const d0 = GameState.worldMap.dungeons[0];
        const playerPos = GameState.player?.get('pos');
        if (d0 && playerPos) { playerPos.x = d0.x + 2; playerPos.y = d0.y; }
      }
    }
    this._updateHUD();
  }

  /**
   * Spawn a single replacement world monster at a random non-ocean tile.
   * Called 15 seconds after any world monster is killed, keeping the
   * total world-monster count from dropping below the natural cap.
   */
  _spawnWorldMonsters_one() {
    const ts = this.tileSize;
    const wm = GameState.worldMap;
    const TYPES = ['🐺','🗡','👹','🦂'];
    const icon = TYPES[Math.floor(Math.random()*TYPES.length)];
    let wx, wy, att=0;
    do { wx=Math.floor(Math.random()*WORLD_COLS); wy=Math.floor(Math.random()*WORLD_ROWS); att++; }
    while (wm.tiles[wy]?.[wx]?.biome === BIOME.OCEAN && att<50);
    const sprite = this.add.text(wx*ts+ts/2, wy*ts+ts/2, icon, {fontSize:'18px'}).setOrigin(0.5).setDepth(15);
    const hpBg   = this.add.rectangle(wx*ts+ts/2, wy*ts+4, ts-4, 3, 0x440000).setDepth(16);
    const hpBar  = this.add.rectangle(wx*ts+2, wy*ts+4, ts-4, 3, 0xff4444).setOrigin(0,0.5).setDepth(17);
    this.mapContainer.add(sprite); this.mapContainer.add(hpBg); this.mapContainer.add(hpBar);
    this.worldMonsters.push({ id:'wmon', name:'Wild Beast', icon, hp:25, maxHp:25, atk:7, def:2, xp:15, gold:5, wx, wy, sprite, hpBg, hpBar, alive:true });
  }

  /**
   * Phaser per-frame update hook.
   * The world map itself is event-driven; we only refresh the HUD each frame
   * to keep HP/gold/XP values current after world-combat or shop purchases.
   */
  update() {
    this._updateHUD();
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// SCENE: DUNGEON  ─  main turn-based dungeon gameplay
// ══════════════════════════════════════════════════════════════════════════════
//
// Responsibilities
// ────────────────
//  • Generate (or reuse) floor data via generateFloor()
//  • Render the tile map, fog-of-war, and all entities
//  • Manage the turn loop: player input → _endPlayerTurn() → monster AI → redraw
//  • Handle click-to-move (A* pathing), keyboard repeat movement, and touch D-pad
//  • All dungeon combat (melee, ranged, spells, boss special actions)
//  • Stairs (descend / ascend), chests, traps, floor events
//  • Companion AI, status effect ticks, relic passive effects
//  • Level-up, death detection, and scene transitions
//
// Key private methods (roughly in call-order)
// ────────────────────────────────────────────
//  create()                — boot floor, build everything, start HUD overlay
//  _buildTileMap()         — draw all tile sprites and fog-of-war overlay
//  _initPlayer(fd)         — place player sprite, camera follow, spawn companion
//  _spawnCompanion(fd)     — create companion ECS entity with HP bar
//  _spawnMonsters(fd)      — spawn regular + optional boss monsters
//  _buildHUD(W,H)          — bottom HUD panel (HP/MP/XP bars, spell slots, buttons)
//  _buildMessageLog(W,H)   — scrolling 4-line message log at top-centre
//  _buildMinimap(W,H)      — 3px/tile minimap rendered to a canvas texture
//  _drawMinimap()          — repaint minimap from FOV data each turn
//  _dimColor(hex,f)        — darken a hex colour for explored-but-not-visible tiles
//  _setupInput()           — keyboard (arrows/WASD/numpad), pointer click-to-move, touch D-pad
//  _stepClickPath()        — advance click-to-move path one step per turn
//  _tryMove(dx,dy)         — resolve one player move: passability, tile effects, multi-step mounts
//  _checkTileInteraction() — traps, lava, water, floor events
//  _triggerEvent()         — shrine/merchant/altar/fountain/library/forge rewards
//  _attackMonster(m)       — player melee vs monster: calcCombat, damage popup, death check
//  _killMonster(m)         — loot drop, XP, market fluctuation, death animation, ECS destroy
//  _checkLevelUp(stats)    — stat increases, HP refill, +1 skill point
//  _updateMonsterHP(m)     — refresh monster HP bar colour and scale
//  _pickupItem()           — pick up ground item or open chest at player's feet
//  _openChest(chest)       — open chest, distribute loot + gold
//  _openChestAt(tx,ty)     — click-target chest open with range check
//  _monsterBlockedSet()    — return Set of all monster positions for pathfinding
//  _startKeyRepeat(dx,dy)  — start delayed key-repeat (220ms initial, 120ms per step)
//  _stopKeyRepeat()        — cancel any active key-repeat timer
//  _doKeyRepeat()          — fire one repeat movement step
//  _openDebugItemMenu()    — Shift+P overlay: give any item
//  _openDebugSpellMenu()   — Shift+I overlay: teach any spell or skill
//  _buildTouchControls()   — mobile D-pad + action button overlay
//  _onDungeonComplete()    — Shinre or regular dungeon completion, world-map transition
//  _useStairs()            — descend/ascend with floor generation, STAIRS_UP/DOWN semantics
//  _castSelectedSpell()    — enter targeting mode or cast at cursor
//  _castSpellAt(tx,ty)     — MP cost, range check, castSpell(), visual effect, endTurn
//  _spellEffect()          — projectile tween from caster to target
//  _endPlayerTurn()        — advance turn counter, relic effects, status ticks, monster AI, redraw
//  _processCompanionAI()   — companion movement, attack, mage/paladin special abilities
//  _processStatusEffects() — tickStatus(), apply damage/heal, return skip flag
//  _processMonstersAI()    — one AI step per monster: aggressive/basic/swarm/ranged/guardian
//  _moveMonsterToward()    — A* path toward player, attack if adjacent
//  _moveMonsterRandom()    — pick a random walkable direction (erratic AI)
//  _rangedAttack()         — ranged monster damage + projectile tween
//  _monsterAttackPlayer()  — monster melee: evasion, honour-shield, aegis, status on hit
//  _processBossAction()    — dispatch boss special actions (phase_change/summon/spell/aoe/self_heal)
//  _updateMonsterRender()  — sync monster sprite/HP bar positions after movement
//  _updateFOV()            — recompute FOV, update fog layer, show/hide monster sprites
//  _updateHUD()            — refresh all HUD bars, stats text, spell slots, status icons
//  _updateMessageLog()     — copy top-4 messages from GameState.messageLog to HUD text objects
//  _checkPlayerDeath()     — resurrection skill check, then game-over overlay
//  _showDamageNumber()     — float a red damage number up from a tile (capped at 6 active)
//  _showFloatingText()     — float any coloured text up from a tile (capped at 6 active)
//  _quickSave()            — async save to IndexedDB via GameState.saveToDB()
//  update(time,delta)      — Phaser frame hook (no-op: turn-based)
//
// EXTEND: Add new floor events in _triggerEvent(). Add new AI behaviours in
//         _processMonstersAI() switch. New spells need only a SPELLS entry +
//         a visual case in _spellEffect().
// ══════════════════════════════════════════════════════════════════════════════
class DungeonScene extends Phaser.Scene {
  constructor() { super({ key:'Dungeon' }); }

  /**
   * Phaser scene entry point — called every time the Dungeon scene is started or restarted.
   *
   * Execution order:
   *  1. Seed a per-floor RNG: seed XOR (floor * 0x1337)
   *  2. Generate floor data (BSP rooms, tiles, entities) if not already present
   *  3. Destroy all monster ECS entities from the previous floor
   *  4. Create rendering containers (map, entity, fog, effect, UI layers)
   *  5. Build tile sprites and fog overlay (_buildTileMap)
   *  6. Place the player at the correct stairs (_initPlayer)
   *  7. Spawn floor monsters and optional boss (_spawnMonsters)
   *  8. Build the bottom HUD panel and populate it (_buildHUD, _updateHUD)
   *  9. Build the scrolling message log (_buildMessageLog)
   * 10. Build the minimap canvas (_buildMinimap)
   * 11. Register all keyboard + pointer + touch input (_setupInput)
   * 12. Compute the first FOV pass (_updateFOV)
   * 13. Create the spell-targeting cursor and tile-hover highlight
   * 14. Launch HUD scene overlay if not already active
   * 15. Trigger auto-save and show a floor-announcement tween
   */
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

    // Spell targeting cursor (hidden by default) — exactly 1 tile
    this.spellCursor = this.add.rectangle(0, 0, TS, TS, 0xffffff, 0.15)
      .setStrokeStyle(2, 0xffff00, 1).setDepth(60).setVisible(false);
    this.entityContainer.add(this.spellCursor);

    // Click-to-move: tile hover highlight (exactly 1 tile)
    this.tileHighlight = this.add.rectangle(0, 0, TS-2, TS-2, 0xffffff, 0)
      .setStrokeStyle(1, 0xffffff, 0.35).setDepth(58).setVisible(false);
    this.entityContainer.add(this.tileHighlight);
    this.input.on('pointermove', (pointer) => {
      const wx = this.cameras.main.scrollX + pointer.x;
      const wy = this.cameras.main.scrollY + pointer.y;
      const tx = Math.floor(wx / TS), ty = Math.floor(wy / TS);
      const fd2 = GameState.floorData;
      if (!fd2) return;
      const t = fd2.tiles[ty]?.[tx];
      if (t !== undefined && t !== TILE_TYPE.WALL) {
        this.tileHighlight.setPosition(tx*TS+TS/2, ty*TS+TS/2).setVisible(true);
      } else {
        this.tileHighlight.setVisible(false);
      }
    });

    // Start HUD scene overlay
    if (!this.scene.isActive('HUD')) {
      this.scene.launch('HUD');
    }

    // Turn state
    this.playerTurn = true;
    this.animating = false;
    this._clickPath = null; // click-to-move path queue

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

  /**
   * Instantiate all Phaser image objects for the dungeon tile grid.
   *
   * For every cell in the 50×50 grid:
   *  • Select the correct texture key from TILE_TYPE (wall, floor, door,
   *    stairs, chest, water, lava).  Traps are rendered as floor tiles
   *    (hidden until triggered).
   *  • Store references in this.tileSprites[y][x] for per-turn visibility updates.
   *  • Overlay a full-opacity 'fog' sprite in this.fogSprites[y][x].
   *
   * After the grid, render floor-event emoji labels (shrine, merchant, etc.)
   * and store them on their event objects so they can be destroyed on use.
   *
   * EXTEND: To add a new tile type, add a TILE_TYPE constant and a case here,
   *         plus a matching texture key in generateSprites().
   */
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

  /**
   * Create (or recreate) the player's Phaser sprite and attach camera follow.
   *
   * Spawn position rules:
   *  • If GameState._spawnAtStairsDown is true (player ascended), place at
   *    fd.stairsDown so they emerge at the down-stairs of the floor above.
   *    The flag is cleared immediately after use.
   *  • Otherwise place at fd.startX/Y (the up-stairs / room 0 centre).
   *
   * The previous scene's Phaser sprite is always destroyed on restart, so this
   * method unconditionally creates a new text-emoji sprite each time.
   * After placing the player the companion is also recreated (_spawnCompanion).
   *
   * @param {object} fd - floor data from generateFloor()
   */
  _initPlayer(fd) {
    const p = GameState.player;
    if (!p) return;
    const pos = p.get('pos');
    // When ascending stairs, spawn at the down-stairs tile of the previous floor
    if (GameState._spawnAtStairsDown && fd.stairsDown) {
      pos.x = fd.stairsDown.x;
      pos.y = fd.stairsDown.y;
      GameState._spawnAtStairsDown = false;
    } else {
      pos.x = fd.startX;
      pos.y = fd.startY;
    }
    pos.floor = GameState.floor;

    if (!p.get('render')) {
      p.add(C.render('player', 0xffffff, 30));
    }
    const render = p.get('render');

    // ALWAYS create a fresh Phaser sprite — the previous one was destroyed
    // when the scene shut down (restart or start from WorldMap).
    render.sprite = this.add.text(
      pos.x * TS + TS / 2,
      pos.y * TS + TS / 2,
      '💃',
      { fontSize: '32px' }
    ).setOrigin(0.5).setDepth(30);
    this.entityContainer.add(render.sprite);

    // Camera follow player
    this.cameras.main.startFollow(render.sprite, true, 0.1, 0.1);

    // Spawn companion if player has one
    this._spawnCompanion(fd);
  }

  /**
   * Recreate the companion ECS entity and its Phaser visuals for the new floor.
   *
   * Any companion from the previous floor is fully destroyed first (Phaser
   * sprites + ECS entity).  The companion definition comes from
   * GameState.companion (set in WorldMapScene when hired).
   *
   * The companion is placed on the nearest walkable tile adjacent to the
   * player start position.  Stats are scaled by floorDifficultyScale().
   * A green HP bar and icon label are created and stored on the render component
   * so _processCompanionAI() can update them each turn.
   *
   * @param {object} fd - floor data, used for tile passability checks
   */
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

  /**
   * Populate the floor with monsters drawn from MONSTERS definitions.
   *
   * Algorithm:
   *  1. Filter MONSTERS to those whose floorRange includes the current floor.
   *  2. Determine count: min(totalRooms-1, 5 + floor*1.5).
   *  3. For each spawn slot, pick a random usable room (not the start room).
   *  4. 10% chance to pick a rare monster variant; otherwise random eligible.
   *  5. Call spawnMonster() to build the ECS entity, then attach a Phaser image
   *     and red HP bar (initially invisible — revealed by FOV).
   *  6. On floor 5 and MAX_FLOORS, spawn the boss in the 80th-percentile room.
   *
   * Monster IDs are stored in fd.monsters[] so _updateFOV and _killMonster
   * can iterate them efficiently.
   *
   * @param {object} fd - floor data containing rooms[] and tiles[][]
   */
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

  /**
   * Build the fixed bottom HUD panel that overlays the dungeon view.
   *
   * Layout (left → right):
   *  • HP bar + numeric label (red, with optional shield icon)
   *  • MP bar + numeric label (blue)
   *  • XP bar + label (green)
   *  • Stats block: ATK / DEF / MAG / gold / level / turn (centre-left)
   *  • Floor name + relic icons (centre)
   *  • 6 status-effect icon slots (right)
   *  • 4 quick spell slots F1–F4 (far right), each clickable to enter targeting mode
   *  • [I] Inventory, [T] Skill Tree, [M] World Map buttons (top-right)
   *
   * All objects use setScrollFactor(0) so they don't scroll with the camera.
   * _updateHUD() refreshes live values every turn without rebuilding the panel.
   *
   * @param {number} W - canvas width in pixels
   * @param {number} H - canvas height in pixels
   */
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

  /**
   * Build the semi-transparent 4-line message log at the top-centre of the screen.
   * Text lines are stored in this.msgLines[] and refreshed each turn by
   * _updateMessageLog(), which fades older lines to alpha 0.4.
   *
   * @param {number} W - canvas width
   * @param {number} H - canvas height
   */
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
  /**
   * Create the minimap overlay in the top-right corner.
   *
   * The minimap uses a Phaser canvas texture ('minimap_canvas') that is repainted
   * every turn by _drawMinimap().  Each tile is 3×3 pixels.
   *
   * Colour coding:
   *  wall=dark blue, floor=mid blue, door=brown, stairs_down=orange,
   *  stairs_up=green, chest=gold, trap=red, water=blue, lava=dark red.
   * Explored-but-not-visible tiles are rendered at 40% brightness (_dimColor).
   * Visible monsters appear as red (or orange for boss) 3×3 squares.
   * The player is a yellow dot drawn on top as a rectangle object.
   *
   * Press M to toggle visibility.  Shift+M grants 200 debug skill points.
   *
   * @param {number} W - canvas width
   * @param {number} H - canvas height
   */
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

    // Toggle: press M to show/hide minimap; Shift+M = [DEBUG] +200 skill points
    this._mmVisible = true;
    this.input.keyboard.on('keydown-M', (event) => {
      if (event.shiftKey) {
        const sk = GameState.player?.get('skills');
        if (sk) sk.points += 200;
        GameState.addMessage('[DEBUG] +200 Skill Points', '#ffaa00');
        window.showToast('+200 Skill Points', 'rare');
        return;
      }
      this._mmVisible = !this._mmVisible;
      this._mmBg.setVisible(this._mmVisible);
      this._mmImage.setVisible(this._mmVisible);
      this._mmPlayer.setVisible(this._mmVisible);
    });

    this._drawMinimap();
  }

  /**
   * Repaint the minimap canvas texture from current FOV data.
   * Called after every _updateFOV() invocation.
   * Only tiles in fov.explored (or fov.visible) are drawn — everything else
   * remains black.  After painting tiles, visible monster positions are
   * overlaid, then the canvas texture is refreshed and the player dot moved.
   */
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

  /**
   * Darken a CSS hex colour string by a multiplicative factor.
   * Used by _drawMinimap() to shade explored-but-not-visible tiles at 40%
   * brightness so they remain distinguishable from unseen black cells.
   *
   * @param {string} hex    - 6-digit hex colour string, e.g. '#3a3a5a'
   * @param {number} factor - multiplier in [0,1]; 0 = black, 1 = unchanged
   * @returns {string} CSS rgb() string, e.g. 'rgb(23,23,36)'
   */
  _dimColor(hex, factor) {
    // darken a hex color string by factor (0–1)
    const n = parseInt(hex.replace('#',''), 16);
    const r = Math.round(((n>>16)&255) * factor);
    const g = Math.round(((n>>8)&255)  * factor);
    const b = Math.round((n&255)        * factor);
    return `rgb(${r},${g},${b})`;
  }

  /**
   * Register all input handlers for the dungeon scene.
   *
   * Keyboard:
   *  • Arrow keys / WASD / Numpad 1-9 → directional movement with key-repeat
   *  • Space / Period / Numpad5 → wait (end turn without moving)
   *  • G → pick up item under player
   *  • E / Comma → use stairs
   *  • Q → quick-save
   *  • F → cast selected spell (or enter targeting mode)
   *  • I → open Inventory overlay
   *  • T → open Skill Tree overlay
   *  • ESC → cancel spell targeting
   *  • Shift+K → [DEBUG] +2000 XP
   *  • Shift+L → [DEBUG] +2000 gold
   *  • Shift+P → [DEBUG] item grant menu
   *  • Shift+I → [DEBUG] spell/skill grant menu
   *  • M / Shift+M → toggle minimap / +200 skill points
   *
   * Pointer (mouse / touch):
   *  • Left-click → spell targeting (if active) OR click-to-move via A*
   *  • Left-click on monster → attack (Chebyshev ≤1) or path-to-adjacent + attack
   *  • Left-click on stairs/chest → path-to then use automatically
   *  • Right-click → cancel click-to-move path
   *  • pointermove → update spell cursor position
   *
   * Touch D-pad and action buttons are built by _buildTouchControls().
   *
   * EXTEND: Add new hotkeys in the 'keydown' switch block.
   */
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
    this._keyRepeatDir = null;

    this.input.keyboard.on('keydown', (event) => {
      if (!this.playerTurn || this.animating) return;

      // ── Shift+key hidden debug shortcuts ──────────────────────────
      if (event.shiftKey) {
        switch(event.code) {
          case 'KeyK': { const st=GameState.player?.get('stats'); if(st){st.xp+=2000;this._checkLevelUp(st);this._updateHUD();} GameState.addMessage('[DEBUG] +2000 XP','#ffaa00'); return; }
          case 'KeyL': { const inv=GameState.player?.get('inventory'); if(inv){inv.gold+=2000;this._updateHUD();} GameState.addMessage('[DEBUG] +2000 Gold','#ffaa00'); return; }
          case 'KeyP': this._openDebugItemMenu(); return;
          case 'KeyI': this._openDebugSpellMenu(); return;
        }
      }

      switch(event.code) {
        case 'ArrowUp':   case 'KeyW': case 'Numpad8': this._clickPath=null; this._startKeyRepeat(0,-1);  this._tryMove(0,-1); break;
        case 'ArrowDown': case 'KeyS': case 'Numpad2': this._clickPath=null; this._startKeyRepeat(0, 1);  this._tryMove(0, 1); break;
        case 'ArrowLeft': case 'KeyA': case 'Numpad4': this._clickPath=null; this._startKeyRepeat(-1,0);  this._tryMove(-1,0); break;
        case 'ArrowRight':case 'KeyD': case 'Numpad6': this._clickPath=null; this._startKeyRepeat( 1,0);  this._tryMove(1, 0); break;
        // Diagonal
        case 'Numpad7': this._startKeyRepeat(-1,-1); this._tryMove(-1,-1); break;
        case 'Numpad9': this._startKeyRepeat( 1,-1); this._tryMove( 1,-1); break;
        case 'Numpad1': this._startKeyRepeat(-1, 1); this._tryMove(-1, 1); break;
        case 'Numpad3': this._startKeyRepeat( 1, 1); this._tryMove( 1, 1); break;
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
        // Open Inventory (Shift+I opens debug spell/skill menu, handled above)
        case 'KeyI': InventoryScene._page='inventory'; this._clickPath=null; this.scene.launch('Inventory'); break;
        // Skill tree — use T (S is reserved for movement)
        case 'KeyT': this._clickPath=null; this.scene.launch('SkillTree'); break;
      }
    });

    // Stop key-repeat on key release
    this.input.keyboard.on('keyup', (event) => {
      switch(event.code) {
        case 'ArrowUp': case 'KeyW': case 'Numpad8':
        case 'ArrowDown': case 'KeyS': case 'Numpad2':
        case 'ArrowLeft': case 'KeyA': case 'Numpad4':
        case 'ArrowRight': case 'KeyD': case 'Numpad6':
        case 'Numpad7': case 'Numpad9': case 'Numpad1': case 'Numpad3':
          this._stopKeyRepeat();
          break;
      }
    });

    // Mouse/touch for spell targeting
    this.input.on('pointerdown', (pointer) => {
      const wx = this.cameras.main.scrollX + pointer.x;
      const wy = this.cameras.main.scrollY + pointer.y;
      const tx = Math.floor(wx / TS);
      const ty = Math.floor(wy / TS);

      // Spell targeting mode
      if (GameState.targeting) {
        this._castSpellAt(tx, ty);
        return;
      }

      // Click-to-move: queue A* path to clicked tile
      const pos = GameState.player?.get('pos');
      if (!pos) return;
      if (tx === pos.x && ty === pos.y) return; // already there

      // Check if there's a monster on that tile
      const pos0 = GameState.player?.get('pos');
      const monsters = GameState.world.queryTag('monster');
      const clickedMon = monsters.find(m => { const mp=m.get('pos'); return mp && mp.x===tx && mp.y===ty; });
      if (clickedMon) {
        const mp = clickedMon.get('pos');
        const chebyshev = Math.max(Math.abs(mp.x - pos0.x), Math.abs(mp.y - pos0.y));
        if (chebyshev <= 1) {
          // Adjacent (including diagonal): attack immediately
          this._attackMonster(clickedMon);
          return;
        }
        // Not adjacent: path-find next to the monster then attack
        const fd0 = GameState.floorData;
        const blocked0 = this._monsterBlockedSet(clickedMon.id);
        const passable0 = (x,y) => {
          const t = fd0.tiles[y]?.[x];
          if (t === undefined) return false;
          if (t === TILE_TYPE.WALL && !GameState.mount?.wallWalk) return false;
          if (blocked0.has(`${x},${y}`)) return false;
          return true;
        };
        // Try to walk adjacent to the monster (stop one step before)
        const path0 = astar(fd0.tiles, pos0.x, pos0.y, mp.x, mp.y, passable0, 60);
        if (path0 && path0.length >= 1) {
          this._clickPath = path0.slice(0, path0.length - 1); // stop one before monster
          if (this._clickPath.length > 0) this._stepClickPath();
          else this._attackMonster(clickedMon); // already adjacent via path
        }
        return;
      }

      const fd = GameState.floorData;

      // Click on stairs tile
      const clickedTile = fd.tiles[ty]?.[tx];
      if (clickedTile === TILE_TYPE.STAIRS_DOWN || clickedTile === TILE_TYPE.STAIRS_UP) {
        const dist = Math.abs(tx - pos.x) + Math.abs(ty - pos.y);
        if (dist <= 1) { this._useStairs(); return; }
        // Walk to it then use
        const blockedS = this._monsterBlockedSet();
        const pathS = astar(fd.tiles, pos.x, pos.y, tx, ty,
          (x,y)=>fd.tiles[y]?.[x]!==undefined&&fd.tiles[y][x]!==TILE_TYPE.WALL&&!blockedS.has(`${x},${y}`), 60);
        if (pathS && pathS.length > 0) {
          this._clickPath = pathS.slice();
          this._clickTarget = { type:'stairs', x:tx, y:ty };
          this._stepClickPath();
        }
        return;
      }

      // Click on chest tile
      if (clickedTile === TILE_TYPE.CHEST) {
        const chebyshevC = Math.max(Math.abs(tx - pos.x), Math.abs(ty - pos.y));
        if (chebyshevC <= 1) { this._openChestAt(tx, ty); return; }
        // Walk adjacent to chest then open
        const blockedC = this._monsterBlockedSet();
        const pathC = astar(fd.tiles, pos.x, pos.y, tx, ty,
          (x,y)=>fd.tiles[y]?.[x]!==undefined&&fd.tiles[y][x]!==TILE_TYPE.WALL&&!blockedC.has(`${x},${y}`), 60);
        if (pathC && pathC.length > 0) {
          this._clickPath = pathC.slice(0, pathC.length - 1);
          this._clickTarget = { type:'chest', x:tx, y:ty };
          if (this._clickPath.length > 0) this._stepClickPath();
          else this._openChestAt(tx, ty);
        }
        return;
      }

      const blockedP = this._monsterBlockedSet();
      const passable = (x, y) => {
        const t = fd.tiles[y]?.[x];
        const mount = GameState.mount;
        if (t === undefined) return false;
        if (t === TILE_TYPE.WALL && !mount?.wallWalk) return false;
        if (t === TILE_TYPE.LAVA && !mount?.lavaImmune) return false;
        if (blockedP.has(`${x},${y}`)) return false;
        return true;
      };
      const path = astar(fd.tiles, pos.x, pos.y, tx, ty, passable, 60);
      if (path && path.length > 0) {
        this._clickPath = path.slice(); // astar already excludes start node
        this._clickTarget = null;
        this._stepClickPath(); // start walking
      }
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

    // Right-click or ESC cancels click-path
    this.input.on('pointerdown', (pointer) => {
      if (pointer.rightButtonDown()) this._clickPath = null;
    });

    // ── Touch / Mobile controls ────────────────────────────────────
    this._buildTouchControls();
  }

  /**
   * Advance the click-to-move path by one step.
   * Called at the start of each turn if this._clickPath is non-empty.
   *
   * Behaviour:
   *  • If the path is exhausted, execute any pending _clickTarget action
   *    (stairs or chest) and return.
   *  • If a monster is standing on the next tile, cancel the path and
   *    attack it instead.
   *  • After moving (_tryMove), if the player's HP decreased (hit by a
   *    monster during the turn) the path is cancelled for safety.
   *  • If more steps remain, schedule the next step 110ms later via
   *    this.time.delayedCall so animation has time to play.
   *  • When the last step completes and a _clickTarget exists, execute it
   *    after a 130ms delay to let the final movement tween settle.
   */
  _stepClickPath() {
    if (!this._clickPath || this._clickPath.length === 0) {
      this._clickPath = null;
      // Execute pending target action after reaching destination
      if (this._clickTarget) {
        const t = this._clickTarget;
        this._clickTarget = null;
        if (t.type === 'stairs') { this._useStairs(); }
        else if (t.type === 'chest') { this._openChestAt(t.x, t.y); }
      }
      return;
    }
    const next = this._clickPath.shift();
    const pos  = GameState.player?.get('pos');
    if (!pos) return;
    const dx = next.x - pos.x, dy = next.y - pos.y;

    // Stop if a hostile monster is directly on the next tile
    const fd = GameState.floorData;
    const monsters = GameState.world.queryTag('monster');
    const blocking = monsters.find(m => {
      const mp = m.get('pos');
      return mp && mp.x === next.x && mp.y === next.y;
    });
    if (blocking) {
      this._clickPath = null;
      this._clickTarget = null;
      this._attackMonster(blocking);
      return;
    }

    const hpComp = GameState.player?.get('health');
    const hpBefore = hpComp ? hpComp.hp : null;
    this._tryMove(dx, dy);
    const hpAfter = hpComp ? hpComp.hp : null;
    if (hpBefore !== null && hpAfter !== null && hpAfter < hpBefore) {
      this._clickPath = null;
      this._clickTarget = null;
      return;
    }
    if (this._clickPath && this._clickPath.length > 0) {
      this.time.delayedCall(110, () => this._stepClickPath());
    } else {
      // Path finished — execute pending action
      if (this._clickTarget) {
        const t = this._clickTarget; this._clickTarget = null;
        this.time.delayedCall(130, () => {
          if (t.type === 'stairs') this._useStairs();
          else if (t.type === 'chest') this._openChestAt(t.x, t.y);
        });
      }
    }
  }

  /**
   * Open a chest at the given tile coordinates, validating that the player
   * is within Manhattan distance 1.  The chest tile is converted to FLOOR,
   * its sprite swapped to 'tile_chest_open', and loot is distributed into
   * the player's inventory (up to maxSize).
   *
   * @param {number} tx - tile X of the chest
   * @param {number} ty - tile Y of the chest
   */
  _openChestAt(tx, ty) {
    const pos = GameState.player?.get('pos');
    if (!pos) return;
    const dist = Math.abs(tx - pos.x) + Math.abs(ty - pos.y);
    if (dist > 1) { GameState.addMessage('Too far away!', '#888888'); return; }
    const fd = GameState.floorData;
    const chest = fd.chests.find(c => c.x===tx && c.y===ty && !c.opened);
    if (!chest) { GameState.addMessage('Nothing here.', '#888888'); return; }
    chest.opened = true;
    fd.tiles[ty][tx] = TILE_TYPE.FLOOR;
    if (this.tileSprites[ty]?.[tx]) this.tileSprites[ty][tx].setTexture('tile_chest_open');
    const inv = GameState.player.get('inventory');
    const loot = rollLoot(chest.rarity, this.rng, fd.floor || GameState.floor);
    let found = 0;
    for (const item of loot) {
      if (inv.items.length < inv.maxSize) { inv.items.push(item); found++; }
    }
    if (found > 0) GameState.addMessage(`📦 Chest: found ${loot.slice(0,found).map(i=>i.name).join(', ')}!`, '#ffd700');
    else           GameState.addMessage('Chest was empty!', '#888888');
    window.showToast('Chest opened!', found > 0 ? 'rare' : '');
    this._updateHUD();
  }

  /**
   * Build a Set of occupied tile keys ("x,y") for all current monster positions.
   * Used as an exclusion set when computing A* paths so that pathfinding never
   * routes through a tile already occupied by another monster.
   *
   * @param {number|null} excludeId - optional ECS entity ID to skip (e.g. the
   *   monster being clicked so we can path-to-adjacent rather than into it)
   * @returns {Set<string>} set of "x,y" strings
   */
  _monsterBlockedSet(excludeId = null) {
    const blocked = new Set();
    for (const m of GameState.world.queryTag('monster')) {
      if (excludeId !== null && m.id === excludeId) continue;
      const mp = m.get('pos');
      if (mp) blocked.add(`${mp.x},${mp.y}`);
    }
    return blocked;
  }

  // ── Key-hold repeat movement ─────────────────────────────────────────────────
  // When a direction key is held, movement fires once immediately (from the keydown
  // handler) and then repeats after a 220ms initial delay at 120ms intervals.
  // The repeat stops as soon as the key is released or the player is blocked.

  /**
   * Begin a key-hold repeat sequence for direction (dx, dy).
   * Cancels any existing repeat timer before starting.
   * @param {number} dx - horizontal direction (-1, 0, +1)
   * @param {number} dy - vertical direction   (-1, 0, +1)
   */
  _startKeyRepeat(dx, dy) {
    this._stopKeyRepeat();
    this._keyRepeatDir = { dx, dy };
    this._keyRepeatTimer = this.time.delayedCall(220, () => this._doKeyRepeat());
  }

  /** Cancel any active key-repeat timer and clear the saved direction. */
  _stopKeyRepeat() {
    if (this._keyRepeatTimer) { this._keyRepeatTimer.remove(false); this._keyRepeatTimer = null; }
    this._keyRepeatDir = null;
  }

  /**
   * Fire one movement step for the held direction, then re-arm the 120ms timer.
   * If the player couldn't move (wall, edge), stops repeating automatically.
   */
  _doKeyRepeat() {
    if (!this._keyRepeatDir) return;
    const { dx, dy } = this._keyRepeatDir;
    const pos = GameState.player?.get('pos');
    if (!pos) return;
    const bx = pos.x, by = pos.y;
    this._tryMove(dx, dy);
    // Stop if movement was blocked (wall, monster, etc.)
    if (pos.x === bx && pos.y === by) { this._stopKeyRepeat(); return; }
    this._keyRepeatTimer = this.time.delayedCall(120, () => this._doKeyRepeat());
  }

  // ── Debug menus (Shift+P / Shift+I) ─────────────────────────────────────────
  //  These overlays are never shown in normal play; they are only triggered by
  //  the Shift+P / Shift+I keyboard combos and do not affect save state.

  /**
   * Overlay listing every ITEMS entry as a clickable button.
   * Clicking an entry adds one copy to the player's inventory (if space allows).
   * Press ESC or click the ✕ button to close.
   */
  _openDebugItemMenu() {
    const W = this.scale.width, H = this.scale.height;
    const overlay = this.add.rectangle(W/2, H/2, W, H, 0x000000, 0.85)
      .setScrollFactor(0).setDepth(500).setInteractive();
    const container = this.add.container(0, 0).setDepth(501).setScrollFactor(0);

    const panelW = Math.min(720, W - 40), panelH = Math.min(520, H - 40);
    const px = W/2 - panelW/2, py = H/2 - panelH/2;
    const bg = this.add.rectangle(W/2, H/2, panelW, panelH, 0x0d0d1a, 0.98)
      .setStrokeStyle(2, 0xffaa00).setScrollFactor(0);
    container.add(bg);

    const title = this.add.text(W/2, py + 12, '🎁 GIVE ITEM [DEBUG]', {
      fontFamily:'"Press Start 2P"', fontSize:'10px', color:'#ffaa00'
    }).setOrigin(0.5, 0).setScrollFactor(0);
    container.add(title);

    const close = () => { overlay.destroy(); container.destroy(); };
    const closeBtn = this.add.text(px + panelW - 10, py + 8, '✕', {
      fontFamily:'"Press Start 2P"', fontSize:'14px', color:'#ff4444'
    }).setOrigin(1, 0).setScrollFactor(0).setInteractive({useHandCursor:true});
    closeBtn.on('pointerdown', close);
    container.add(closeBtn);

    const cols = 4, colW = (panelW - 20) / cols, rowH = 32;
    let col = 0, row = 0;
    const startY = py + 42;

    for (const item of Object.values(ITEMS)) {
      const bx2 = px + 10 + col * colW + colW/2;
      const by2 = startY + row * rowH;
      if (by2 + rowH > py + panelH - 8) break;
      const btn = this.add.text(bx2, by2, `${item.icon||'•'} ${item.name}`, {
        fontFamily:'monospace', fontSize:'10px', color:'#cccccc',
        backgroundColor:'#181830', padding:{x:4,y:3}
      }).setOrigin(0.5, 0).setScrollFactor(0).setInteractive({useHandCursor:true});
      btn.on('pointerover', () => btn.setStyle({color:'#ffd700'}));
      btn.on('pointerout',  () => btn.setStyle({color:'#cccccc'}));
      btn.on('pointerdown', () => {
        const inv = GameState.player?.get('inventory');
        if (inv && inv.items.length < inv.maxSize) {
          inv.items.push({...item, count:1, identified:true});
          GameState.addMessage(`[DEBUG] Got ${item.name}!`, '#ffaa00');
          window.showToast(`+${item.name}`, 'rare');
        } else { GameState.addMessage('[DEBUG] Inventory full!', '#888888'); }
      });
      container.add(btn);
      col++; if (col >= cols) { col = 0; row++; }
    }
    this.input.keyboard.once('keydown-ESC', close);
  }

  /**
   * Overlay listing every SPELLS and SKILL_TREE entry as clickable buttons.
   * Clicking teaches the selected spell/skill to the player if not already known.
   * Press ESC or click ✕ to close.
   */
  _openDebugSpellMenu() {
    const W = this.scale.width, H = this.scale.height;
    const overlay = this.add.rectangle(W/2, H/2, W, H, 0x000000, 0.85)
      .setScrollFactor(0).setDepth(500).setInteractive();
    const container = this.add.container(0, 0).setDepth(501).setScrollFactor(0);

    const panelW = Math.min(720, W - 40), panelH = Math.min(560, H - 40);
    const px = W/2 - panelW/2, py = H/2 - panelH/2;
    const bg = this.add.rectangle(W/2, H/2, panelW, panelH, 0x0d0d1a, 0.98)
      .setStrokeStyle(2, 0xaa44ff).setScrollFactor(0);
    container.add(bg);

    const title = this.add.text(W/2, py + 12, '✨ GIVE SPELL / SKILL [DEBUG]', {
      fontFamily:'"Press Start 2P"', fontSize:'10px', color:'#aa44ff'
    }).setOrigin(0.5, 0).setScrollFactor(0);
    container.add(title);

    const close = () => { overlay.destroy(); container.destroy(); };
    const closeBtn = this.add.text(px + panelW - 10, py + 8, '✕', {
      fontFamily:'"Press Start 2P"', fontSize:'14px', color:'#ff4444'
    }).setOrigin(1, 0).setScrollFactor(0).setInteractive({useHandCursor:true});
    closeBtn.on('pointerdown', close);
    container.add(closeBtn);

    const addRow = (label, color, items, getLabel, onClick) => {
      container.add(this.add.text(px + 10, label.y, label.text, {
        fontFamily:'"Press Start 2P"', fontSize:'8px', color
      }).setScrollFactor(0));
      let cx = px + 10, cy = label.y + 18;
      for (const it of items) {
        const btn = this.add.text(cx, cy, getLabel(it), {
          fontFamily:'monospace', fontSize:'10px', color:'#cccccc',
          backgroundColor:'#181830', padding:{x:4,y:3}
        }).setScrollFactor(0).setInteractive({useHandCursor:true});
        btn.on('pointerover', () => btn.setStyle({color:'#ffd700'}));
        btn.on('pointerout',  () => btn.setStyle({color:'#cccccc'}));
        btn.on('pointerdown', () => onClick(it));
        container.add(btn);
        cx += btn.width + 6;
        if (cx > px + panelW - 80) { cx = px + 10; cy += 26; }
      }
      return cy + 26;
    };

    let y = py + 42;
    y = addRow({y, text:'— SPELLS —'}, '#4488ff', Object.values(SPELLS),
      s => `${s.icon||'•'} ${s.name}`,
      s => {
        const sk = GameState.player?.get('skills');
        if (!sk) return;
        if (!sk.known.find(e=>e.id===s.id)) {
          sk.known.push({id:s.id, level:1});
          GameState.addMessage(`[DEBUG] Learned spell: ${s.name}!`, '#aa44ff');
        } else { GameState.addMessage(`[DEBUG] Already know ${s.name}`, '#888888'); }
      });

    y += 4;
    addRow({y, text:'— SKILLS —'}, '#ff8844', Object.values(SKILL_TREE),
      s => `${s.icon||'•'} ${s.name}`,
      s => {
        const sk = GameState.player?.get('skills');
        if (!sk) return;
        if (!sk.known.find(e=>e.id===s.id)) {
          sk.known.push({id:s.id, level:1, active:false});
          GameState.addMessage(`[DEBUG] Learned skill: ${s.name}!`, '#ff8844');
        } else { GameState.addMessage(`[DEBUG] Already know ${s.name}`, '#888888'); }
      });

    this.input.keyboard.once('keydown-ESC', close);
  }

  /**
   * Build the on-screen mobile D-pad and action buttons.
   *
   * Layout:
   *  • Left side — 9-button D-pad: 4 cardinal + 4 diagonal + centre wait
   *  • Right side — 4 action buttons: Open/Use, Spell, Items, Skills
   *  • Small 🎮 toggle button (top-right) to show/hide the whole pad
   *  • Mount/companion status strip above the D-pad if applicable
   *
   * All objects are collected in allObjs[] so the toggle can show/hide them
   * atomically without tracking individual references.
   *
   * The D-pad fires the same _tryMove() calls as keyboard input; the action
   * buttons replicate the I/T/E hotkeys.
   *
   * EXTEND: Add more action buttons by calling makeBtn() with a new action
   *         closure. Adjust `ax` offset to keep buttons readable on small screens.
   */
  _buildTouchControls() {
    const W = this.scale.width, H = this.scale.height;
    const panelH = 80;
    const btnSize = 50;
    const padX = 68, padY = H - panelH - 14;
    const btnAlpha = 0.60;
    const btnColor = 0x1a1a3a;
    const DEP = 200;

    // All touch UI objects collected for show/hide
    const allObjs = [];

    const makeBtn = (x, y, icon, label, action, tint=0x4444aa) => {
      const bg = this.add.rectangle(x, y, btnSize, btnSize, btnColor, btnAlpha)
        .setScrollFactor(0).setDepth(DEP).setStrokeStyle(1, tint)
        .setInteractive({ useHandCursor:true });
      const iconTxt = this.add.text(x, y - 6, icon,
        { fontSize: icon.length > 1 ? '20px' : '24px' }).setOrigin(0.5).setScrollFactor(0).setDepth(DEP+1);
      const labelTxt = this.add.text(x, y + 14, label,
        { fontFamily:'"VT323"', fontSize:'10px', color:'#556688' }).setOrigin(0.5).setScrollFactor(0).setDepth(DEP+1);
      bg.on('pointerdown', action);
      bg.on('pointerover', () => bg.setFillStyle(0x2a2a5a, 0.9));
      bg.on('pointerout',  () => bg.setFillStyle(btnColor, btnAlpha));
      allObjs.push(bg, iconTxt, labelTxt);
      return bg;
    };

    // ── D-PAD ──────────────────────────────────────────────────────
    makeBtn(padX,              padY - btnSize,     '▲','',   () => { this._clickPath=null; this._tryMove(0,-1); });
    makeBtn(padX,              padY + 2,           '▼','',   () => { this._clickPath=null; this._tryMove(0,1);  });
    makeBtn(padX - btnSize,    padY - btnSize/2,   '◀','',   () => { this._clickPath=null; this._tryMove(-1,0); });
    makeBtn(padX + btnSize,    padY - btnSize/2,   '▶','',   () => { this._clickPath=null; this._tryMove(1,0);  });
    makeBtn(padX,              padY - btnSize/2,   '⏸','wait', () => this._endPlayerTurn());
    // Diagonals (smaller)
    makeBtn(padX - btnSize,    padY - btnSize*1.5, '↖','',   () => { this._clickPath=null; this._tryMove(-1,-1); });
    makeBtn(padX + btnSize,    padY - btnSize*1.5, '↗','',   () => { this._clickPath=null; this._tryMove(1,-1);  });
    makeBtn(padX - btnSize,    padY + 2,           '↙','',   () => { this._clickPath=null; this._tryMove(-1,1);  });
    makeBtn(padX + btnSize,    padY + 2,           '↘','',   () => { this._clickPath=null; this._tryMove(1,1);   });

    // ── ACTION BUTTONS ─────────────────────────────────────────────
    // Fix 2: single button for "interact" (open chest / use stairs / pickup)
    const ax = W - 68, ay = padY - btnSize*0.5;

    makeBtn(ax,             ay,             '📦','Open/Use', () => {
      // Try stairs first, then chest, then pickup
      const pos = GameState.player?.get('pos');
      const fd  = GameState.floorData;
      if (!pos||!fd) return;
      const tile = fd.tiles[pos.y][pos.x];
      if (tile === TILE_TYPE.STAIRS_DOWN || tile === TILE_TYPE.STAIRS_UP) { this._useStairs(); return; }
      // Check adjacent chest
      for (const [dx,dy] of [[0,0],[1,0],[-1,0],[0,1],[0,-1]]) {
        const cx=pos.x+dx, cy=pos.y+dy;
        const ch = fd.chests?.find(c=>c.x===cx&&c.y===cy&&!c.opened);
        if (ch) { this._openChestAt(cx,cy); return; }
      }
      this._pickupItem();
    }, 0x44aa44);

    makeBtn(ax - btnSize,   ay,             '🧪','Spell',   () => {
      const skills = GameState.player?.get('skills');
      const known  = (skills?.known||[]).filter(s=>SPELLS[s.id]);
      if (known.length > 0) {
        GameState.selectedSpell = known[0].id;
        GameState.targeting = true;
        this.spellCursor.setVisible(true);
        GameState.addMessage(`Targeting ${SPELLS[known[0].id]?.name}. Tap target.`, '#aaaaff');
      }
    }, 0xaa44ff);

    makeBtn(ax,             ay - btnSize,   '🎒','Items',   () => { InventoryScene._page='inventory'; this._clickPath=null; this.scene.launch('Inventory'); }, 0xaa8844);
    makeBtn(ax - btnSize,   ay - btnSize,   '⭐','Skills',  () => { this._clickPath=null; this.scene.launch('SkillTree'); }, 0x44aaff);

    // ── TOGGLE BUTTON (always visible) ─────────────────────────────
    // Fix 4: show/hide toggle for the whole pad
    let padVisible = true;
    const toggleX = W - 14, toggleY = H - panelH - btnSize*3.5;
    const toggleBg = this.add.rectangle(toggleX, toggleY, 26, 26, 0x111122, 0.85)
      .setScrollFactor(0).setDepth(DEP+5).setStrokeStyle(1, 0x4444aa)
      .setInteractive({ useHandCursor:true });
    const toggleTxt = this.add.text(toggleX, toggleY, '🎮',
      { fontSize:'14px' }).setOrigin(0.5).setScrollFactor(0).setDepth(DEP+6);

    toggleBg.on('pointerdown', () => {
      padVisible = !padVisible;
      allObjs.forEach(o => o.setVisible(padVisible));
      toggleTxt.setText(padVisible ? '🎮' : '👁');
    });

    // Mount/companion status strip
    const statusY = H - panelH - 24;
    if (GameState.mount) {
      const ms = this.add.text(padX, statusY,
        `${GameState.mount.icon} ${GameState.mount.name}`,
        {fontFamily:'"VT323"', fontSize:'12px', color:'#88ccff'}).setOrigin(0.5).setScrollFactor(0).setDepth(DEP);
      allObjs.push(ms);
    }
    if (GameState.companion) {
      const cs = this.add.text(padX, statusY - 14,
        `${GameState.companion.icon} ${GameState.companion.name}`,
        {fontFamily:'"VT323"', fontSize:'12px', color:'#88ff88'}).setOrigin(0.5).setScrollFactor(0).setDepth(DEP);
      allObjs.push(cs);
    }
  }

  /**
   * Attempt to move the player by (dx, dy) tiles.
   *
   * Decision tree:
   *  1. Bounds check — ignore moves that would leave the grid.
   *  2. Monster on target tile → _attackMonster instead of moving.
   *  3. Passability — walls block unless mount has wallWalk; lava is walkable
   *     but deals damage (handled by _checkTileInteraction).
   *  4. Update pos component, tween sprite to new position.
   *  5. Call _checkTileInteraction to resolve traps, lava, events.
   *  6. Mount multi-step: if mount.stepsPerTurn > 1, recurse with _stepN+1
   *     before calling _endPlayerTurn so all extra steps happen in one turn.
   *  7. End the player's turn via _endPlayerTurn().
   *
   * @param {number} dx     - horizontal delta (-1, 0, +1)
   * @param {number} dy     - vertical delta   (-1, 0, +1)
   * @param {number} _stepN - internal recursion counter for multi-step mounts
   */
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

  /**
   * Resolve all tile-based effects when the player steps onto (x, y).
   *
   * Effects checked in order:
   *  1. Traps — trigger once (trap.triggered = true), deal damage, reveal sprite.
   *     Skipped entirely if mount.trapImmune.
   *  2. Lava  — deal 5 HP and apply 'burn' status unless mount.lavaImmune.
   *  3. Water  — informational message (slow movement) unless mount.waterWalk.
   *  4. Floor events (shrine/merchant/altar/fountain/library/forge) — delegate
   *     to _triggerEvent().  Events are consumed (event.used = true) on first step.
   *
   * @param {number}      x     - tile column
   * @param {number}      y     - tile row
   * @param {object}      fd    - floor data
   * @param {object|null} mount - active mount definition (or null)
   */
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

  /**
   * Apply the one-time reward for stepping on a floor event tile.
   * The event is marked used and its sprite destroyed to prevent re-triggering.
   *
   * Event types and effects:
   *  shrine   → heal 30 HP
   *  merchant → add one random rarity-weighted item to inventory
   *  altar    → +1 skill point
   *  fountain → restore HP and MP to full
   *  library  → teach one random spell not already known
   *  forge    → grant (20 + floor*5) gold
   *
   * EXTEND: Add new event types here and register them in generateFloor()'s
   *         event type list for floor seeding.
   *
   * @param {object} event - floor event object from fd.events[]
   * @param {object} fd    - floor data (unused but available for future use)
   */
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

  /**
   * Resolve the player's melee attack against a monster entity.
   *
   * Steps:
   *  1. Reset the turnsNoAttack relic counter.
   *  2. Collect active skill options (power_strike, holy_strike) to pass to
   *     calcCombat() as option flags.
   *  3. Call calcCombat() for the full damage pipeline.
   *  4. On evade/miss: show floating text, no damage.
   *  5. On hit: applyDamage(), show damage popup and flash the monster sprite red.
   *  6. On death/instakill: _killMonster().
   *  7. Regardless of outcome: _endPlayerTurn().
   *
   * @param {Entity} monster - the ECS entity being attacked
   */
  _attackMonster(monster) {
    GameState.turnsNoAttack = 0; // reset no-attack relic counter
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

  /**
   * Handle monster death: drop loot, award XP + gold, play death animation,
   * remove the entity from ECS and fd.monsters[].
   *
   * The pickpocket skill multiplies gold drops by 1.5.
   * Boss kills trigger a MarketState.fluctuate() price shift.
   * Rare+ item drops emit a toast notification.
   *
   * @param {Entity} monster - dying ECS entity
   */
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

  /**
   * Check whether the player's XP total has reached the next level threshold.
   * If so: increment level, reduce XP by xpNext, scale xpNext by 1.5×, boost
   * all base stats, refill HP and MP, award +1 skill point, and show a
   * floating LEVEL UP! text over the player.
   *
   * Called after every kill and after world-combat XP awards.
   *
   * @param {object} stats - the player's stats component
   */
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

  /**
   * Refresh a monster's HP bar width and colour without moving it.
   * Called after the player hits but does not kill the monster, and after
   * the companion deals damage.  Colour transitions: >50% red → >25% orange → ≤25% bright red.
   *
   * @param {Entity} monster - the monster entity whose HP bar to update
   */
  _updateMonsterHP(monster) {
    const hp = monster.get('health');
    const render = monster.get('render');
    if (!hp || !render?.hpBar) return;
    const ratio = hp.hp / hp.maxHp;
    render.hpBar.setScale(ratio, 1);
    render.hpBar.setFillStyle(ratio > 0.5 ? 0xff4444 : ratio > 0.25 ? 0xff8800 : 0xff0000);
  }

  /**
   * Pick up a ground item at the player's current position, or open a chest
   * that is exactly at the player's feet.
   *
   * Ground items (fd.groundItems[]) take priority; if none, fall back to a
   * chest at the same tile.  Fails gracefully with a message if inventory
   * is full or nothing is present.
   */
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

  /**
   * Open a chest at the player's feet (called from _pickupItem when chest is
   * exactly at pos.x/pos.y).  Distributes loot + a random gold amount, then
   * visually grays out the chest sprite.
   *
   * @param {object} chest - chest object from fd.chests[]
   */
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

  /**
   * Null out all Phaser sprite references before calling this.scene.restart().
   *
   * When a Phaser scene restarts it destroys all display objects.  ECS entities
   * persist across the restart but their stored sprite references become stale.
   * This method replaces those references with null so _initPlayer() and
   * _spawnMonsters() always create fresh Phaser objects on the next create() call.
   *
   * Must be called immediately before this.scene.restart() when changing floors.
   */
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

  // ── Dungeon completion ────────────────────────────────────────────────────────

  /**
   * Called when the player descends past the last floor of the current dungeon.
   *
   * Two completion paths:
   *
   * A) Shinre temple (dng.isShinre):
   *    • Push shinreId to GameState.shinreCompleted and award the relic.
   *    • Remove the Shinre from wm.shinres[].
   *    • If all 7 Shinres are complete, spawn the Final Castle on the world map.
   *
   * B) Regular dungeon:
   *    • Increment GameState.dungeonCompleteCount.
   *    • Remove the cleared dungeon from wm.dungeons[].
   *    • Spawn a harder replacement dungeon (maxFloor + 1, capped at 20).
   *    • Roll for a Shinre spawn using getShinreSpawnChance().
   *
   * After either path, restore the player to the dungeon's world-map coordinates,
   * null all Phaser sprite refs, and transition to WorldMap.
   * A re-entrancy guard (_completingDungeon) prevents double-calls.
   */
  _onDungeonComplete() {
    if (this._completingDungeon) return;
    this._completingDungeon = true;
    const dng = GameState.currentDungeon;
    const wm  = GameState.worldMap;
    const rng = new RNG(GameState.seed ^ Date.now());

    // ── Shinre completion ──────────────────────────────────────────
    if (dng?.isShinre && dng.shinreId) {
      const shinreDef = SHINRE_DEFS.find(s => s.id === dng.shinreId);
      if (shinreDef && !GameState.shinreCompleted.includes(dng.shinreId)) {
        GameState.shinreCompleted.push(dng.shinreId);
        GameState.relics.push({ ...shinreDef.relic });
        const msg = `✨ ${shinreDef.relic.icon} Relic obtained: ${shinreDef.relic.name}!`;
        GameState.addMessage(msg, '#ffd700');
        window.showToast(msg, 'legendary');
        // Remove this shinre from map
        if (wm.shinres) wm.shinres = wm.shinres.filter(s => s.id !== dng.id);
        // Check if ALL shinre done → unlock final castle
        if (GameState.shinreCompleted.length >= SHINRE_DEFS.length && !wm.finalCastle) {
          const fx = rng.int(3, (wm.tiles[0]?.length||30) - 4);
          const fy = rng.int(3, (wm.tiles?.length||20) - 4);
          wm.finalCastle = { x:fx, y:fy, ...FINAL_CASTLE };
          GameState.addMessage('🏰 THE SHATTERED THRONE has appeared! Valdris awaits.', '#ff4422');
          window.showToast('🏰 Final Boss Castle unlocked!', 'legendary');
        }
      }
    } else {
      // Regular dungeon complete
      GameState.dungeonCompleteCount = (GameState.dungeonCompleteCount||0) + 1;
      GameState.addMessage(`⚔ Dungeon cleared! (${GameState.dungeonCompleteCount} total)`, '#44ff88');
      window.showToast('Dungeon Cleared!', 'legendary');

      // ── Remove cleared dungeon from map ──────────────────────────
      if (dng && wm.dungeons) {
        wm.dungeons = wm.dungeons.filter(d => d.id !== dng.id);
        GameState.addMessage(`The entrance to ${dng.name} crumbles...`, '#888888');
      }

      // ── Spawn new dungeon at higher level ────────────────────────
      const maxLevel = Math.max(...(wm.dungeons||[]).map(d => d.maxFloor||MAX_FLOORS), MAX_FLOORS);
      const newMaxFloor = Math.min(maxLevel + 1, 20); // cap at 20
      let nx2, ny2, att = 0;
      do {
        nx2 = rng.int(2, (wm.tiles[0]?.length||30) - 3);
        ny2 = rng.int(2, (wm.tiles?.length||20) - 3);
        att++;
      } while (wm.tiles[ny2]?.[nx2]?.biome === 0 /* OCEAN */ && att < 60);
      const biomeNames = ['Plains','Forest','Desert','Snow','Volcano'];
      const newName = `${biomeNames[rng.int(0, biomeNames.length-1)]} Dungeon ★${newMaxFloor}`;
      const newId = `dng_${Date.now()}`;
      wm.dungeons.push({ x:nx2, y:ny2, id:newId, name:newName, maxFloor:newMaxFloor, visited:false });
      GameState.addMessage(`A new dungeon has appeared: ${newName}!`, '#ff8844');
      window.showToast(`New dungeon: ${newName}`, 'rare');

      // ── Maybe spawn a Shinre ──────────────────────────────────────
      const chance = getShinreSpawnChance();
      const remaining = SHINRE_DEFS.filter(s => !GameState.shinreCompleted.includes(s.id));
      if (remaining.length > 0 && Math.random() < chance) {
        const shinreDef = remaining[rng.int(0, remaining.length-1)];
        let sx2, sy2, att2 = 0;
        do {
          sx2 = rng.int(2, (wm.tiles[0]?.length||30) - 3);
          sy2 = rng.int(2, (wm.tiles?.length||20) - 3);
          att2++;
        } while (wm.tiles[sy2]?.[sx2]?.biome === 0 && att2 < 60);
        if (!wm.shinres) wm.shinres = [];
        const shinreId = `shinre_${Date.now()}`;
        wm.shinres.push({
          x:sx2, y:sy2, id:shinreId,
          shinreId: shinreDef.id,
          name: shinreDef.temple,
          icon: shinreDef.icon,
          color: shinreDef.color,
          isShinre: true,
          maxFloor: 5,
          visited: false,
        });
        GameState.addMessage(`✨ A Shinre appeared: ${shinreDef.icon} ${shinreDef.temple}!`, '#ffaa44');
        window.showToast(`Shinre: ${shinreDef.temple}`, 'legendary');
      }
    }

    // Return to world map — restore player to dungeon's world coords
    GameState.inDungeon = false;
    const _dngExit = GameState.currentDungeon;
    if (_dngExit) {
      const _pp = GameState.player?.get('pos');
      if (_pp) { _pp.x = _dngExit.x; _pp.y = _dngExit.y; }
    }
    GameState.currentDungeon = null;
    GameState.floor = 1;
    const pr = GameState.player?.get('render');
    if (pr) { pr.sprite = null; pr.hpBg = null; pr.hpBar = null; }
    const monsters2 = GameState.world?.queryTag('monster') || [];
    for (const m of monsters2) {
      const r = m.get('render'); if (r) { r.sprite=null; r.hpBg=null; r.hpBar=null; }
      GameState.world.destroy(m.id);
    }
    if (GameState.floorData) GameState.floorData.monsters = [];
    if (GameState.companionEntity) {
      const cr = GameState.companionEntity.get('render');
      if (cr) { cr.sprite=null; cr.hpBg=null; cr.hpBar=null; cr.label=null; }
      GameState.world.destroy(GameState.companionEntity.id);
      GameState.companionEntity = null;
    }
    this.scene.start('WorldMap');
  }

  /**
   * Use stairs at the player's current tile (tile must be STAIRS_DOWN or STAIRS_UP).
   *
   * STAIRS_DOWN:
   *  • If already on the last floor, call _onDungeonComplete() instead.
   *  • Otherwise increment GameState.floor, generate the new floor data,
   *    _cleanupForRestart(), and this.scene.restart().
   *
   * STAIRS_UP:
   *  • If on floor 1, return to WorldMap (restore world coordinates, null sprites).
   *  • Otherwise decrement floor, generate the floor above, set
   *    GameState._spawnAtStairsDown so the player emerges at the down-stairs,
   *    _cleanupForRestart(), and restart.
   *
   * Not on stairs: check proximity and print a hint message.
   */
  _useStairs() {
    const p = GameState.player;
    const pos = p.get('pos');
    const fd = GameState.floorData;
    const tile = fd.tiles[pos.y][pos.x];

    if (tile === TILE_TYPE.STAIRS_DOWN) {
      const maxFloor = GameState.currentMaxFloor || MAX_FLOORS;
      if (GameState.floor >= maxFloor) {
        // DUNGEON COMPLETED — call handler then return to world
        this._onDungeonComplete();
        return;
      }
      GameState.floor++;
      GameState.addMessage(`Descending to floor ${GameState.floor}...`, '#ff6b35');
      GameState.floorData = generateFloor(GameState.floor, GameState.seed ^ (GameState.currentDungeon?.id||0));
      this._cleanupForRestart();
      this.scene.restart();
    } else if (tile === TILE_TYPE.STAIRS_UP) {
      if (GameState.floor <= 1) {
        GameState.addMessage('Melissa returns to the surface...', '#88ff88');
        GameState.inDungeon = false;
        // Restore player to dungeon's world map coords
        const _dngUp = GameState.currentDungeon;
        if (_dngUp) {
          const _ppUp = GameState.player?.get('pos');
          if (_ppUp) { _ppUp.x = _dngUp.x; _ppUp.y = _dngUp.y; }
        }
        GameState.currentDungeon = null;
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
      GameState._spawnAtStairsDown = true; // spawn at down-stairs (where we came from)
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

  /**
   * Activate or confirm a spell cast from the keyboard (F key).
   *
   * If no spell is currently selected, enter targeting mode for the first
   * known spell and show the targeting cursor.
   *
   * If already in targeting mode, cast at the tile currently under the
   * spell cursor (derived from cursor world position ÷ TS).
   */
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

  /**
   * Resolve the selected spell cast aimed at tile (tx, ty).
   *
   * Steps:
   *  1. Validate MP cost — cancel with message if insufficient.
   *  2. Validate range — cancel with message if target too far.
   *  3. Identify the target entity (monster at tx, ty) if any.
   *  4. Delegate to castSpell() for damage/heal/status/teleport resolution.
   *  5. Deduct MP and play a visual projectile effect (_spellEffect).
   *  6. Process castSpell() result array: apply damage numbers, handle deaths,
   *     apply heals, handle teleport, handle lifesteal.
   *  7. Clear targeting state, hide cursor, end player turn.
   *
   * @param {number} tx - target tile column
   * @param {number} ty - target tile row
   */
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

  /**
   * Play a visual spell effect: a projectile image tweened from caster to target,
   * then an expanding circle explosion at the target.
   *
   * Texture is selected by spell ID:
   *  fireball → particle_fire, ice_spike → particle_ice,
   *  lightning → particle_lightning, all others → particle_heal.
   * The explosion radius scales with spell.aoe (in tiles) if present.
   *
   * @param {string} spellId - SPELLS key
   * @param {{x,y}}  from    - caster tile coordinates
   * @param {{x,y}}  to      - target tile coordinates
   * @param {object} spell   - SPELLS[spellId] definition
   */
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

  /**
   * Advance the game by one full turn after the player has taken their action.
   *
   * Sequence:
   *  1. Increment turnCount, turnsSinceHit, turnsNoAttack.
   *  2. Determine inCombat (any monster within 5 tiles) for relic effects.
   *  3. Apply passive relic effects (applyRelicEffects).
   *  4. Tick player status effects (_processStatusEffects).
   *  5. Run companion AI (_processCompanionAI).
   *  6. Run all monster AI steps (_processMonstersAI).
   *  7. Recompute FOV (_updateFOV).
   *  8. Refresh HUD (_updateHUD) and message log (_updateMessageLog).
   *  9. Check player death (_checkPlayerDeath).
   * 10. Every 5 turns: passive MP regen (+2, +3 more with mana_well skill).
   */
  _endPlayerTurn() {
    GameState.turnCount++;
    GameState.turnsSinceHit = (GameState.turnsSinceHit||0) + 1;
    GameState.turnsNoAttack = (GameState.turnsNoAttack||0) + 1;
    // Apply relic passive effects
    const inCombat = GameState.world?.queryTag('monster')?.some(m => {
      const mp = m.get('pos'), pp = GameState.player?.get('pos');
      return mp && pp && Math.abs(mp.x-pp.x)+Math.abs(mp.y-pp.y) <= 5;
    }) || false;
    if (GameState.relics?.length) {
      applyRelicEffects(GameState.player, GameState.turnsSinceHit, GameState.turnsNoAttack, inCombat);
    }
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

  /**
   * Run one AI tick for the active companion entity.
   *
   * Death check: if HP ≤ 0, destroy sprite, ECS entity, and clear GameState.companionEntity.
   *
   * Combat AI:
   *  • Find the nearest visible monster within companion attack range.
   *  • If within range: deal melee damage via calcCombat-like formula.
   *    Mage companions also cast a fireball message every 3 turns.
   *    Paladin companions heal the player for +15 HP every 5 turns.
   *  • If not within range but monster is visible: A* path one step toward it.
   *  • If no monsters visible: follow player if distance > 3 (A* step).
   *
   * After movement, sync the companion sprite and HP bar to the new position.
   */
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

  /**
   * Apply one turn of status effect ticks to an entity.
   * Delegates to tickStatus() which decrements durations and aggregates damage/heal.
   * Applies the resulting damage/heal via applyDamage/applyHeal and shows floating text.
   *
   * @param {Entity} entity - player or monster entity
   * @returns {boolean} skip - true if 'stun' or 'freeze' prevented the entity from acting
   */
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

  /**
   * Run one AI tick for every living monster on the floor.
   *
   * Per monster:
   *  1. Skip if not fully initialised (no pos/ai/health component).
   *  2. Tick status effects; skip turn if stunned/frozen.
   *  3. Kill instantly if HP ≤ 0 after status tick.
   *  4. Apply passive regeneration.
   *  5. If boss-tagged, delegate to processBossAI() then _processBossAction().
   *  6. Attempt monster spell cast (30% chance if dist ≤ 6 and in FOV).
   *  7. Standard AI behaviour dispatch by mAI.behavior:
   *     aggressive/basic/swarm/erratic/ranged/guardian/default.
   *
   * Movement helpers: _moveMonsterToward (A*), _moveMonsterRandom (erratic).
   * Attack helpers:   _monsterAttackPlayer (melee), _rangedAttack (ranged).
   */
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

  /**
   * Move a monster one step toward the player using cached A* pathing.
   *
   * The A* path is stored on mAI.path and recomputed whenever it runs out.
   * Other monster positions are passed as obstacles so monsters don't overlap.
   * If the next step IS the player position, attack instead of moving.
   * If the path step is occupied by another monster, clear the path and wait.
   * After moving, if Manhattan dist === 1, attack.
   * Ends by calling _updateMonsterRender() to sync the sprite position.
   *
   * @param {Entity} monster - the moving monster
   * @param {{x,y}}  pPos    - player position component
   * @param {object} fd      - floor data for tile passability
   */
  _moveMonsterToward(monster, pPos, fd) {
    const mPos = monster.get('pos');
    const mAI  = monster.get('ai');

    // A* pathfinding — treat other monsters as walls
    if (!mAI.path || mAI.path.length === 0) {
      const mBlocked = new Set();
      for (const om of GameState.world.queryTag('monster')) {
        if (om.id === monster.id) continue;
        const omp = om.get('pos');
        if (omp) mBlocked.add(`${omp.x},${omp.y}`);
      }
      mAI.path = astar(
        fd.tiles, mPos.x, mPos.y, pPos.x, pPos.y,
        (x,y) => {
          const t = fd.tiles[y]?.[x];
          if (t === undefined || t === TILE_TYPE.WALL || t === TILE_TYPE.LAVA) return false;
          if (x === pPos.x && y === pPos.y) return true; // always allow target
          if (mBlocked.has(`${x},${y}`)) return false;
          return true;
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

  /**
   * Move a monster in a random walkable direction (used by 'erratic' AI).
   * Tries all 4 cardinal directions in shuffled order; takes the first that
   * is not a WALL tile.  Does nothing if all directions are blocked.
   *
   * @param {Entity} monster - the moving monster
   * @param {object} fd      - floor data for tile type lookup
   */
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

  /**
   * Resolve a ranged attack from a monster at the player.
   * Uses calcCombat() for the damage roll and shows a tiny projectile tween
   * (orange circle) flying from the monster to the player position.
   *
   * @param {Entity} monster - attacking monster
   * @param {Entity} player  - target (GameState.player)
   */
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

  /**
   * Resolve a monster's melee attack against the player.
   *
   * Order of defences checked before applying damage:
   *  1. Evasion (calcCombat result.evaded) → show EVADE text.
   *  2. Miss (calcCombat result.miss) → show MISS text.
   *  3. Honor Shield relic (p._honorShield) → absorbs the hit, shield consumed.
   *  4. Aegis shield (p._aegisShield) → absorbs partial damage, remainder applied.
   *
   * After applying damage, the turnsNoAttack relic counter resets and the camera
   * shakes.  If mDef.statusOnHit exists, 30% chance to inflict that status.
   *
   * @param {Entity} monster - attacking monster entity
   */
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
      // Check relics: honor_shield absorbs next hit
      if (p._honorShield) {
        p._honorShield = false;
        GameState.addMessage(`🤝 Honor Shield absorbs the hit!`, '#44aaff');
        this._showFloatingText(pPos.x, pPos.y, 'BLOCKED', '#44aaff');
        this.cameras.main.shake(60, 0.002);
        return;
      }
      // Aegis of untouched queen absorbs some damage
      if (p._aegisShield && p._aegisShield > 0) {
        const absorbed = Math.min(p._aegisShield, result.damage);
        p._aegisShield -= absorbed;
        const remaining = result.damage - absorbed;
        if (absorbed > 0) {
          GameState.addMessage(`🛡 Aegis absorbs ${absorbed} damage!`, '#88ddff');
          this._showFloatingText(pPos.x, pPos.y, `-${absorbed}🛡`, '#88ddff');
        }
        if (remaining <= 0) { this.cameras.main.shake(60,0.002); return; }
        result.damage = remaining;
      }
      applyDamage(p, result.damage);
      GameState.turnsSinceHit = 0; // reset honor_shield counter
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

  /**
   * Execute a boss special action returned by processBossAI().
   *
   * Action types:
   *  phase_change — announce phase, optionally summon N skeleton minions
   *  summon       — spawn N monsters of action.monster type around the boss
   *  spell        — cast action.spell for damage + visual effect
   *  aoe          — deal flat AoE damage + shake camera
   *  self_heal    — restore action.amount HP on the boss
   *
   * After the special action, if the boss is adjacent (dist ≤ 1) it also
   * makes a normal melee attack, then moves toward the player.
   *
   * @param {object} action     - action object from processBossAI()
   * @param {Entity} bossEntity - the boss ECS entity
   * @param {Entity} player     - the player ECS entity
   */
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

  /**
   * Sync a monster's Phaser sprite and HP bar positions to its current ECS pos.
   * Called after every movement step (A*, random, boss action).
   * If the render component or sprite is missing, does nothing.
   *
   * @param {Entity} monster - monster entity to update
   */
  _updateMonsterRender(monster) {
    const mPos = monster.get('pos');
    const render = monster.get('render');
    if (!render?.sprite) return;
    render.sprite.setPosition(mPos.x*TS+TS/2, mPos.y*TS+TS/2);
    if (render.hpBg)  render.hpBg.setPosition(mPos.x*TS+TS/2, mPos.y*TS+2);
    if (render.hpBar) render.hpBar.setPosition(mPos.x*TS+2, mPos.y*TS+2);
  }

  /**
   * Recompute the player's field of vision and update all fog-of-war sprites.
   *
   * Steps:
   *  1. Read fov.radius and apply any blind status effects (fovMod).
   *  2. Call computeFOV() — fills fov.visible (current) and fov.explored (cumulative).
   *  3. For every tile:
   *     • Visible: fog alpha = 0, tile alpha = 1 (full colour)
   *     • Explored: fog alpha = 0.7 (grey veil, 'fog_explored' texture), tile alpha = 0.5
   *     • Unseen: fog alpha = 1 (black), tile alpha = 0 (hidden)
   *  4. Show/hide monster sprites based on fov.visible.
   *  5. Repaint the minimap (_drawMinimap).
   */
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

  /**
   * Refresh all live values in the bottom HUD panel.
   * Called every turn (and immediately after HUD construction).
   *
   * Updates:
   *  • HP bar width + colour (red→orange→bright red as HP drops) + text label
   *  • MP bar width + text label
   *  • XP bar width + text label
   *  • Stats block: ATK/DEF/MAG (base + equipment), gold, level, turn count
   *  • Floor text: floor number, dungeon name, relic icons
   *  • Status effect icons: up to 6 active effects with icon + remaining duration
   *  • Spell slot icons: F1–F4 show the known-spell icons; the selected spell slot
   *    is highlighted yellow
   */
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
    const maxF = GameState.currentMaxFloor || MAX_FLOORS;
    const isShinre = GameState.activeShinre;
    const shinreIcon = isShinre ? (isShinre.icon||'✨') + ' ' : '';
    this.floorText.setText(
      `${shinreIcon}FLOOR ${GameState.floor} / ${maxF}\n` +
      `${GameState.currentDungeon?.name || 'Dungeon'}` +
      (GameState.relics?.length ? `\n🏅 Relics: ${GameState.relics.map(r=>r.icon).join('')}` : '')
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

  /**
   * Copy the most recent 4 messages from GameState.messageLog into the
   * visible message log text objects.  Older lines fade to alpha 0.4 so
   * the newest message is always the most prominent.
   */
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

  /**
   * Check whether the player's HP has reached zero and handle the outcome.
   *
   * Resurrection skill (one use per floor): if the player knows 'resurrection'
   * and hasn't used it this floor, restore HP to 50% and continue.
   *
   * Otherwise show an inline game-over overlay (pause scene, red YOU DIED text,
   * floor/level/turns stats, and a [TRY AGAIN] button that resets GameState
   * and returns to TitleScene).  This overlay is built within DungeonScene
   * rather than launching GameOverScene for speed.
   */
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

  /**
   * Show a floating damage number rising upward from tile (tx, ty).
   *
   * Numbers are capped at 6 simultaneous popups — if the limit is reached the
   * oldest popup is killed and destroyed before the new one is created.
   * On mobile devices the font is smaller (6px vs 8px) and semi-transparent
   * (alpha 0.7) to reduce screen clutter.
   *
   * @param {number}          tx     - tile column of the hit
   * @param {number}          ty     - tile row of the hit
   * @param {number}          damage - damage value to display
   * @param {string|number}   color  - CSS colour string or hex integer
   */
  _showDamageNumber(tx, ty, damage, color='#ff4444') {
    // Cap active popups at 6
    if (!this._activePopups) this._activePopups = [];
    if (this._activePopups.length >= 6) {
      const oldest = this._activePopups.shift();
      this.tweens.killTweensOf(oldest);
      oldest.destroy();
    }
    const isMobile = this.sys.game.device.os.android || this.sys.game.device.os.iOS;
    const colorStr = typeof color === 'number' ?
      '#' + color.toString(16).padStart(6,'0') : color;
    const txt = this.add.text(tx*TS+TS/2, ty*TS, `-${damage}`, {
      fontFamily:'"Press Start 2P"',
      fontSize: isMobile ? '6px' : '8px',
      color: colorStr,
      stroke:'#000', strokeThickness: isMobile ? 1 : 2,
      alpha: isMobile ? 0.7 : 1,
    }).setOrigin(0.5).setDepth(60).setAlpha(isMobile ? 0.7 : 1);
    this._activePopups.push(txt);
    this.tweens.add({
      targets:txt, y:ty*TS-20, alpha:0, duration:800,
      onComplete:() => {
        const idx = this._activePopups ? this._activePopups.indexOf(txt) : -1;
        if (idx !== -1) this._activePopups.splice(idx, 1);
        txt.destroy();
      }
    });
  }

  /**
   * Show an arbitrary floating text label rising from tile (tx, ty).
   * Used for LEVEL UP!, XP gains, status messages, heal numbers, etc.
   * Same 6-popup cap and mobile size reduction as _showDamageNumber.
   *
   * @param {number}        tx    - tile column
   * @param {number}        ty    - tile row
   * @param {string}        text  - string to display
   * @param {string|number} color - CSS colour string or hex integer
   */
  _showFloatingText(tx, ty, text, color='#ffffff') {
    // Cap active popups at 6
    if (!this._activePopups) this._activePopups = [];
    if (this._activePopups.length >= 6) {
      const oldest = this._activePopups.shift();
      this.tweens.killTweensOf(oldest);
      oldest.destroy();
    }
    const isMobile = this.sys.game.device.os.android || this.sys.game.device.os.iOS;
    const colorStr = typeof color === 'number' ?
      '#' + color.toString(16).padStart(6,'0') : color;
    const txt = this.add.text(tx*TS+TS/2, ty*TS, text, {
      fontFamily:'"VT323"',
      fontSize: isMobile ? '12px' : '16px',
      color: colorStr,
      stroke:'#000', strokeThickness: isMobile ? 1 : 2,
    }).setOrigin(0.5).setDepth(60).setAlpha(isMobile ? 0.65 : 1);
    this._activePopups.push(txt);
    this.tweens.add({
      targets:txt, y:ty*TS-30, alpha:0, duration:1000,
      onComplete:() => {
        const idx = this._activePopups ? this._activePopups.indexOf(txt) : -1;
        if (idx !== -1) this._activePopups.splice(idx, 1);
        txt.destroy();
      }
    });
  }

  /**
   * Quick-save the current game to the active save slot.
   * Shows a success toast or a warning if the save fails (e.g. IndexedDB error).
   * Bound to the Q key.
   */
  async _quickSave() {
    const ok = await GameState.saveToDB(GameState.saveSlot);
    if (ok) {
      GameState.addMessage('Game saved!', '#88ff88');
      window.showToast('Game saved!', 'rare');
    } else {
      window.showToast('Save failed!', 'warning');
    }
  }

  /**
   * Phaser per-frame update hook.
   * DungeonScene is fully turn-based; all logic runs inside _endPlayerTurn().
   * This method is intentionally empty (no polling loop needed).
   */
  update(time, delta) {
    // Nothing needed - turn-based, all logic in _endPlayerTurn
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// SCENE: INVENTORY  ─  three-tab overlay (Items · Equipment · Crafting)
// ══════════════════════════════════════════════════════════════════════════════
//
// Launched as an overlay on top of DungeonScene via this.scene.launch('Inventory').
// The currently visible tab is persisted in the static property InventoryScene._page
// so that switching tabs restarts the scene without losing the selected page.
//
// Tabs and their builders:
//  'inventory'  → _buildInventoryPage()  — item grid with use/equip on click
//  'equipment'  → _buildEquipmentPage()  — equipped slot display with unequip
//  'crafting'   → _buildCraftingPage()   — recipe list with craft-on-click
//
// Shared helpers:
//  _showTooltip(item, x, y)  — rich item description popup (stats, effect, price)
//  _hideTooltip()            — destroy active tooltip
//  _useItem(item,idx,...)    — dispatch by item type (weapon/armor/potion/food/scroll/tome)
//  _useScroll(item,idx,...)  — teleport / reveal_map / identify / bomb scroll effects
//  _craft(recipe, inv)       — consume ingredients and add result to inventory
//
// Close: ESC key, I key, or ✕ button — all stop the scene overlay.
//
// EXTEND: Add new item types in the switch inside _useItem().
//         New recipe entries only need to be added to RECIPES[].
// ══════════════════════════════════════════════════════════════════════════════
class InventoryScene extends Phaser.Scene {
  constructor() { super({ key:'Inventory' }); }

  /**
   * Build the full inventory overlay each time the scene starts or restarts.
   * Reads InventoryScene._page to determine which tab to build, then delegates
   * to the matching _build*Page() helper for the content area.
   */
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

  /**
   * Build the ITEMS tab: a 5-column grid of all backpack items.
   * Each cell shows the item icon, (truncated) name, type, and stack count.
   * Hover shows a tooltip; click calls _useItem() which equips or consumes.
   *
   * @param {number} px - content area left edge
   * @param {number} py - content area top edge
   * @param {number} pw - content area width
   * @param {number} ph - content area height
   */
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

  /**
   * Show a detailed item tooltip near (x, y), clamped to screen bounds.
   * Displays: icon + name, rarity, description, all stat bonuses, heal value,
   * spell taught, effect text, and gold value.  Unidentified items show a
   * placeholder message instead.
   *
   * @param {object} item - inventory item object
   * @param {number} x    - preferred left edge of the tooltip
   * @param {number} y    - preferred top edge of the tooltip
   */
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

  /** Destroy the active tooltip if one exists. */
  _hideTooltip() {
    this._tooltip?.destroy(); this._tooltip = null;
  }

  /**
   * Dispatch item use by item.type.
   *
   * Type handlers:
   *  weapon/armor/ring/amulet — equip in the matching slot, swapping out any
   *    existing item back to the inventory.  HP bonus items (item.hp) adjust
   *    the player's maxHp immediately.
   *  potion  — applyHeal, optionally cure a named status or clear all statuses.
   *  food    — applyHeal for item.heal (or 10) HP.
   *  scroll  — delegate to _useScroll() for special effects.
   *  tome    — teach item.spell if not already known.
   *  material/key — informational messages (used elsewhere).
   *  default — "Cannot use" message.
   *
   * Unidentified items are automatically identified on first click.
   * The scene restarts after every successful action to reflect changes.
   *
   * @param {object} item   - item being used
   * @param {number} index  - index in inv.items[]
   * @param {object} inv    - inventory component
   * @param {object} equip  - equipment component
   * @param {object} skills - skills component
   */
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

  /**
   * Apply a scroll's effect and remove it from inventory.
   *
   * Scroll effects (item.effect):
   *  teleport    — warp player to a random floor tile.
   *  reveal_map  — add all tiles to fov.explored (full map visible).
   *  identify    — identify the first unidentified item in the inventory.
   *
   * Bomb scrolls (item.damage + item.aoe) deal area damage to all monsters
   * within item.aoe tiles, independent of the item.effect field.
   *
   * @param {object} item  - scroll item being used
   * @param {number} index - index in inv.items[]
   * @param {object} inv   - inventory component
   */
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

  /**
   * Build the EQUIPMENT tab: four equipment slots (weapon/armor/ring/amulet)
   * laid out in a 2×2 grid plus a combined character-stats panel below.
   * Each occupied slot shows the item's icon, name, bonuses, and effect text.
   * Clicking an equipped item moves it back to the inventory (unequip).
   * Hovering shows the item tooltip.
   *
   * @param {number} px - content area left edge
   * @param {number} py - content area top edge
   * @param {number} pw - content area width
   * @param {number} ph - content area height
   */
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

  /**
   * Build the CRAFTING tab: a list of all recipes with ingredient availability
   * shown inline.  Craftable recipes have a green border and are clickable;
   * uncraftable ones are shown in red as a hint.
   *
   * Ingredient counts check the inventory for matching item IDs and sum their
   * .count properties to support stacked materials.
   *
   * @param {number} px - content area left edge
   * @param {number} py - content area top edge
   * @param {number} pw - content area width
   * @param {number} ph - content area height
   */
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

  /**
   * Execute a crafting recipe: remove all required ingredients from the
   * inventory (by item ID, honouring stacks), then add one copy of the
   * result item.  Restarts the scene so the updated inventory is displayed.
   *
   * @param {object} recipe - recipe definition from RECIPES[]
   * @param {object} inv    - inventory component
   */
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

// ══════════════════════════════════════════════════════════════════════════════
// SCENE: SKILL TREE  ─  overlay for browsing and purchasing skills
// ══════════════════════════════════════════════════════════════════════════════
//
// Launched as an overlay via this.scene.launch('SkillTree') (T key or button).
// Lays out SKILL_TREE in four vertical branches (warrior / mage / rogue / paladin),
// each sorted by tier.  Learned skills show level/maxLvl; learnable ones are
// highlighted blue; completed ones are highlighted green.
//
// Dependency connector lines are drawn with Phaser Graphics between skills
// listed in skill.req[].
//
// Key private methods:
//  create()                 — layout all branch columns and skill boxes
//  _showSkillTooltip()      — popup with name, passive/active, desc, req, cost
//  _hideSkillTooltip()      — destroy active tooltip
//  _learnSkill(skill, sk)   — deduct skill point, increment level, apply
//                             immediate passive stat bonuses, restart scene
//
// EXTEND: New skills only need entries in SKILL_TREE[]; the UI auto-discovers
//         them by branch and tier.  New passive stat effects should be handled
//         in _learnSkill()'s switch statement.
// ══════════════════════════════════════════════════════════════════════════════
class SkillTreeScene extends Phaser.Scene {
  constructor() { super({ key:'SkillTree' }); }

  /**
   * Build the full skill tree overlay.
   * Iterates all four branches, groups skills by tier, and renders a box per
   * skill with icon, name, level indicator, and cost.  Connector lines link
   * prerequisite skills to their dependents.
   */
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

  /**
   * Show a skill details popup near (x, y), clamped to screen bounds.
   * Displays: icon + name, branch, tier, passive vs active, description,
   * current level, skill point cost, and prerequisite names.
   *
   * @param {object} skill - SKILL_TREE entry
   * @param {number} x     - preferred left edge
   * @param {number} y     - preferred top edge
   */
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

  /** Destroy the active skill tooltip if one exists. */
  _hideSkillTooltip() { this._tooltip?.destroy(); this._tooltip = null; }

  /**
   * Spend one skill point to learn (or level up) a skill.
   *
   * Guards: must have sufficient points and, if upgrading, must not exceed maxLvl.
   * After adding/incrementing the entry in skills.known, deducts skill.cost points.
   * Passive stat bonuses (DEF, MAG, MaxMP) that apply immediately are switched on
   * skill.effect.  Other effects (gold%, crit, evasion, etc.) are checked at the
   * point of use in the combat system.
   * Restarts the SkillTree scene to show the updated state.
   *
   * @param {object} skill  - SKILL_TREE entry being learned
   * @param {object} skills - the player's skills component
   */
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

// ══════════════════════════════════════════════════════════════════════════════
// SCENE: HUD  ─  persistent overlay scene (registered but effectively unused)
// ══════════════════════════════════════════════════════════════════════════════
//
// HUDScene is listed in the Phaser scene config so it can be launched by
// DungeonScene via this.scene.launch('HUD'), but all actual HUD rendering is
// done directly in DungeonScene._buildHUD() / _updateHUD().
//
// The scene exists as a placeholder / extension point.  If the HUD ever needs
// to be decoupled from DungeonScene (e.g. to share it with a cutscene), the
// implementation can be migrated here.
// ══════════════════════════════════════════════════════════════════════════════
class HUDScene extends Phaser.Scene {
  constructor() { super({ key:'HUD', active:false }); }
  /** No-op: HUD display is handled by DungeonScene. */
  create() { /* HUD is managed directly in DungeonScene */ }
}

// ══════════════════════════════════════════════════════════════════════════════
// SCENE: GAME OVER / VICTORY  ─  end screen displayed after win or death
// ══════════════════════════════════════════════════════════════════════════════
//
// Launched via this.scene.start('GameOver', { won: bool, stats: {...} }).
// Displays either the victory narrative (if data.won) or the death screen.
//
// Victory content:
//  • Narrative text about Amara being freed and Valdris finding rest.
//  • Epilogue poem about Melissa and her Hero.
//
// Death content:
//  • "YOU DIED" title.
//
// Both screens show floor/level/turns/gold stats and a [PLAY AGAIN] button
// that fully resets GameState and MarketState before returning to TitleScene.
//
// Note: DungeonScene also has an inline death overlay (built inside the scene
// itself) for immediate feedback without a full scene transition.
// GameOverScene is the polished dedicated end-screen.
// ══════════════════════════════════════════════════════════════════════════════
class GameOverScene extends Phaser.Scene {
  constructor() { super({ key:'GameOver' }); }

  /**
   * Receive transition data from the launching scene.
   * @param {{won:boolean, stats:object}} data
   */
  init(data) {
    this._won   = data?.won   || false;
    this._stats = data?.stats || {};
  }

  /**
   * Build the game-over / victory screen.
   *
   * Victory: dark green background, gold title, narrative paragraphs,
   *          and final stats.
   * Death:   dark red background, red title, and final stats.
   *
   * The [PLAY AGAIN] button resets all mutable GameState fields and
   * MarketState to their initial values, then transitions to TitleScene.
   * A guard flag (_restarting) prevents the button from firing twice.
   * The button also pulses with a yoyo scale tween for visual prominence.
   * Pressing ENTER triggers the button without a click.
   */
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
      this.add.text(W/2, H*0.28, 'Amara is free.\nLove returns to Vaeloria.', {
        fontFamily:'"VT323"', fontSize:'24px', color:'#ffd700', align:'center', lineSpacing:8
      }).setOrigin(0.5);
      this.add.text(W/2, H*0.40, 'Valdris — the Hero of another world, who lost\nhis Melissa and never forgave the silence —\nhas finally been allowed to rest.', {
        fontFamily:'"VT323"', fontSize:'16px', color:'#aaaacc', align:'center', lineSpacing:6
      }).setOrigin(0.5);
      this.add.text(W/2, H*0.56, 'Somewhere above, her Hero opens his eyes.\nHe says her name.\nHe does not know why it feels like coming home.\nShe does.', {
        fontFamily:'"VT323"', fontSize:'17px', color:'#ffaacc', align:'center', lineSpacing:7
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

    let _restarting = false;
    restartBtn.on('pointerdown', () => {
      if (_restarting) return;
      _restarting = true;
      restartBtn.setInteractive(false);
      restartBtn.setText('[ LOADING... ]');
      restartBtn.setColor('#888888');

      // Full state reset
      GameState.world        = null;
      GameState.player       = null;
      GameState.companionEntity = null;
      GameState.companion    = null;
      GameState.mount        = null;
      GameState.floor        = 1;
      GameState.turnCount    = 0;
      GameState.inDungeon    = false;
      GameState.floorData    = null;
      GameState.currentDungeon = null;
      GameState.worldMap     = null;
      GameState.messageLog   = [];
      GameState.targeting    = false;
      GameState.selectedSpell = null;
      MarketState.priceFactors = {};
      MarketState.marketRNG  = null;

      this.time.delayedCall(80, () => this.scene.start('Title'));
    });

    this.tweens.add({ targets:restartBtn, scaleX:1.05, scaleY:1.05, duration:900, yoyo:true, repeat:-1 });
    this.input.keyboard.once('keydown-ENTER', () => {
      if (!_restarting) restartBtn.emit('pointerdown');
    });
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// PHASER GAME CONFIG & BOOT  ─  IIFE entry point
// ══════════════════════════════════════════════════════════════════════════════
//
// The entire file is wrapped in this single async IIFE so that all const/class
// declarations are module-scoped without polluting the global namespace (except
// for window.MelissasWrath which is intentionally exposed for debugging).
//
// Phaser config highlights:
//  • type: AUTO — prefers WebGL, falls back to Canvas
//  • scale.mode: FIT + CENTER_BOTH — fills the viewport on any screen size
//  • render.pixelArt: true — disables anti-aliasing for crisp pixel sprites
//  • backgroundColor: '#0a0a0f' — deep dark blue matches dungeon theme
//
// A window 'resize' listener keeps the canvas sized to the viewport (capped at
// 1280×720 to prevent excessive memory use on 4K displays).
//
// window.MelissasWrath exposes key singletons for browser console debugging:
//  GameState, game, ITEMS, MONSTERS, SPELLS, SKILL_TREE
//
// EXTEND: To add a new scene, instantiate it and add it to the scene[] array.
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Async IIFE — initialises Phaser and launches the game.
 * Async is used so future top-level await calls (e.g. DB init) can be added here.
 */
(async function main() {
  // Responsive canvas size — capped at 1280×720 for performance
  const gameW = Math.min(window.innerWidth, 1280);
  const gameH = Math.min(window.innerHeight, 720);

  /* ── Phaser 3 game configuration ────────────────────────────────────────── */
  const config = {
    type: Phaser.AUTO,   // WebGL preferred; Canvas fallback
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

  /* ── Viewport resize handler ─────────────────────────────────────────────
   * Keeps the Phaser canvas matched to the browser window on orientation
   * changes and manual resizes (important for mobile devices).             */
  window.addEventListener('resize', () => {
    const nw = Math.min(window.innerWidth, 1280);
    const nh = Math.min(window.innerHeight, 720);
    game.scale.resize(nw, nh);
  });

  /* ── Debug console API ───────────────────────────────────────────────────
   * Accessible via:  window.MelissasWrath.GameState  etc.
   * Useful commands in DevTools:
   *   MelissasWrath.GameState.player.get('stats').atk += 50
   *   MelissasWrath.GameState.saveToDB(0)
   *   Object.keys(MelissasWrath.ITEMS)
   */
  window.MelissasWrath = { GameState, game, ITEMS, MONSTERS, SPELLS, SKILL_TREE };
})();
