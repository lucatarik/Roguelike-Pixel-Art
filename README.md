# 💃 Melissa's Wrath: Endless Descent

> *"She knows why she is fighting. She is not ready to say it out loud."*

---

## 🌌 The Story

### A Love That Was

There was a world where love was permanent.

Not eternal in the way of myths or promises — permanent in the way of something *woven in*, like a thread through fabric, impossible to pull out without unraveling everything around it. **Amara**, Goddess of Love, made it so. Under her watch, what two people built together did not erode with time or silence or fear. It held.

**Melissa** knew this. She was a Valkyrie — made of war, not tenderness — and yet she loved her **Hero** completely, and he loved her back, and she had never once doubted that it would last.

Then Amara was taken.

### The Hollowing

No army. No warning. One night, a figure of impossible power performed a ritual in the dark, and **Amara vanished** from the fabric of existence.

The world did not end. It did something quieter and more terrible: it continued. But the permanent threads began to loosen. Love did not disappear — it faded, slowly, the way warmth fades when you cannot find the source of cold. People who had been certain of each other began to feel a distance they could not name or close.

Melissa felt it too.

She does not speak about what those days were like. She descended to the mortal realm instead.

### Seven Temples. Seven Relics. One Reason.

Scattered across a world that no longer knows what it has lost are seven sacred temples — the **Shinre**. Each one holds a fragment of Amara's shattered essence in the form of a **Relic**. Each one is sealed behind five floors of corrupted guardians. Each one, when cleared, returns something to the world — and something to Melissa — that should never have been taken.

What exactly each temple represents, and why those seven things in particular, is something Melissa understands better with every step she descends.

She is not ready to explain it to anyone else yet.

### The Enemy

**Valdris the Hollow** sits at the center of the earth, in a fortress called the **Shattered Throne**, surrounded by the machinery of a grief too old and too specific to be accidental.

He is not what he appears to be.

The truth of who he is, and why he did this, will not reveal itself until Melissa is standing in front of him at the end. When it does, it will not be simple. It will not be the story she expected to find herself inside.

It never is.

---

> *The seven temples are waiting. Each one holds something Melissa needs. She is not yet certain which is the need and which is the weapon — but she is going in anyway. That is, after all, what she does.*

---


## 🎮 Game Overview

**Melissa's Wrath: Endless Descent** is a feature-rich, fully procedural **roguelike RPG** built entirely in a single HTML/JavaScript file using the **Phaser 3** game engine. It runs in any modern browser with no installation, no server, no dependencies beyond the engine CDN.

The game combines classic roguelike turn-based mechanics with a living world map, dynamic economy, companion and mount systems, a deep skill tree, an original relic/Shinre progression system, and full mobile touch support.

---

## 🗺️ World Map

### A Living, Walkable Overworld

The world map is not a menu. Melissa walks across it tile by tile, in real time, using WASD/arrow keys or by clicking anywhere on the map to trigger automatic A* pathfinding. The camera follows her smoothly as she moves.

The world is **procedurally generated** at each new game using Perlin noise to determine biomes. No two worlds are the same.

### Biomes

The overworld contains 8 distinct biomes, each with its own color palette and visual identity:

- 🌿 **Plains** — open grassland, easy traversal
- 🌲 **Forest** — dense green, mysterious
- 🏜️ **Desert** — golden sands
- ❄️ **Snow** — icy tundra
- 🌿 **Swamp** — murky and dark
- 🌋 **Volcano** — fire and ash
- 🌊 **Ocean** — impassable without a water-walking mount
- 🪄 **Dungeon zones** — corrupted terrain near entrances

### Points of Interest

The world map is populated with multiple types of interactive locations, all rendered as distinct icons with color-coded tints:

- 🏰 **Dungeons** — the main source of combat, loot, and XP. Each dungeon has a name based on its biome and a difficulty tier. Completing a dungeon removes it from the map permanently, and a new, harder dungeon spawns elsewhere.
- 🏠 **Towns** — rest points where Melissa heals to full, buys items from a shop stocked with weapons, armor, potions, and scrolls, and can hire companions or purchase mounts.
- 🛒 **Markets** (8 per world) — specialized trading posts with a dynamic economy. Prices fluctuate based on market events, boss kills, and random factors. Each item shows a trend arrow (▲ expensive, ▼ cheap, ● stable).
- 🐴 **Stables** (6 per world) — dedicated mount shops where Melissa can buy rideable creatures that grant stat bonuses and special movement abilities.
- ⚔ **Companion Guilds** (6 per world) — adventurer guilds where she can hire fighters who follow her into dungeons and fight autonomously.
- ✨ **Shinre Temples** — special dungeons that spawn after clearing regular dungeons. Each one contains a boss and a Relic fragment of Amara's essence.
- 🏰 **The Shattered Throne** — the final castle, unlocked only when all 7 Shinre are completed.

### World Map Monsters

The overworld is not safe. **24 world monsters** of 7 types (wolves, bandits, harpies, ogres, giant worms, scorpions, drakes) roam the map. They move toward Melissa when she comes within 8 tiles and attack on contact. Defeating them yields XP and gold. They respawn after ~15 seconds.

### Click-to-Move Pathfinding

Clicking anywhere on the map calculates an optimal BFS path around terrain obstacles. Melissa walks step by step with smooth tweened movement, executing the path automatically. Clicking on a point of interest from a distance will walk her there and trigger the interaction upon arrival. Keyboard input cancels the path at any time.

---

## 🏰 Dungeons

### Procedural Floor Generation

Every dungeon floor is procedurally generated using a **BSP (Binary Space Partitioning) room algorithm** that guarantees:

- All rooms are connected via corridors
- The starting room is always in one corner; stairs down are in the farthest room
- Stairs up always spawn on the exact tile where Melissa entered the floor (so backtracking works correctly)
- Chests, traps, and special events are placed in random rooms

### Floor Scaling

Dungeons scale in difficulty with floor depth using an exponential formula:

```
scale = 1 + (floor - 1) × 0.11
```

This means floor 1 is baseline, floor 5 is ×1.44, and floor 10 is ×2.0. All monster stats — HP, ATK, DEF, regen, XP, and gold drops — are multiplied by this factor, ensuring a smooth difficulty ramp.

### Special Floor Events

Certain rooms contain **procedural events** that Melissa can interact with:

- ⛩️ **Shrine** — offers a blessing, restoring some HP or MP
- 🛍️ **Merchant** — sells a random selection of items mid-dungeon
- 🗿 **Altar** — dangerous but potentially rewarding ritual
- ⛲ **Fountain** — healing water
- 📚 **Library** — reveals information about monsters or items
- 🔨 **Forge** — allows equipment enhancement

### Click-to-Move Inside Dungeons

Inside a dungeon, Melissa can click any reachable tile to automatically path there using **A* pathfinding** (up to 60 tiles of range). Each step of the path consumes one full game turn, meaning monsters react and move between steps. The path is cancelled automatically if:

- A monster appears on the next tile in the path
- A keyboard direction key is pressed
- Melissa arrives at her destination

Clicking directly on an adjacent monster attacks it. Clicking on a distant monster paths to within melee range, then attacks automatically.

Clicking on a **chest tile** walks to it and opens it. Clicking on a **stair tile** walks to it and uses it.

### Dungeon Completion & World Evolution

When Melissa clears the deepest floor (floor 10 of a standard dungeon, or the custom floor count of a Shinre):

1. The dungeon **disappears from the world map** permanently
2. A **new dungeon spawns** in a random location with `maxFloor = max_existing + 1`, up to floor 20
3. A **Shinre temple** may spawn based on the current probability (starts at 5%, increases by 8% per dungeon cleared, capped at 70%)

---

## ⚔️ Combat System

### Turn-Based Architecture

The game uses a strict **turn-based system**: Melissa acts, then every monster in the dungeon acts, then the cycle repeats. There is no animation blocking — input is processed immediately, giving the game a snappy feel while remaining fully deterministic.

### Combat Calculations

All damage is calculated via a `calcCombat()` function that accounts for:

- Base ATK vs DEF differential
- Critical hit chance (base 5%, modified by skills and relics)
- Evasion chance (base ~5%, modified by skills)
- Miss chance
- Random ±variance per hit
- Element-type bonuses (holy vs undead, fire vs frozen, etc.)
- Skill bonuses (Power Strike, Holy Strike, Backstab)
- Relic passive modifiers

### Status Effects

Both Melissa and monsters can be affected by status conditions:

- 🔥 **Burn** — damage over time each turn
- ☠️ **Poison** — damage over time, harder to cure
- ❄️ **Frozen** — skip turns
- 🌪️ **Stunned** — lose next action
- 💤 **Sleep** — vulnerable until hit
- ⚡ **Shocked** — reduced ATK
- 🩸 **Bleeding** — movement costs HP
- 🟣 **Cursed** — reduced stats overall
- ✨ **Blessed** — temporary stat boost

---

## 👾 Monsters

### 24 Monster Types

The game contains 24 distinct monster types spread across 4 difficulty tiers:

**Tier 1 (Floors 1–3):** Rat, Slime — weak, basic AI, low HP  
**Tier 2 (Floors 2–6):** Kobold, Zombie, Gnoll, Wraith — moderate challenge, varied behavior  
**Tier 3 (Floors 4–8):** Wyvern, Orc Shaman, Minotaur, Shadow Assassin — dangerous abilities  
**Tier 4 (Floors 6–10):** Demon, Dark Knight, Necromancer — elite threats  
**Bosses:** Ancient Dragon, Lich King — appear on floors 5 and 10, massive HP and multi-phase spells  
**Rare elites:** Vampire, Stone Golem, Banshee, Chimera — occasional threats at mid-high floors

Each monster has a unique:
- **AI behavior type**: basic, aggressive, swarm, erratic, ranged, guardian, boss, boss_lite
- **Stat profile**: HP, ATK, DEF, speed, luck
- **Spells** (for casters): fireball, lightning, life drain, frost bolt, etc.
- **Status on hit**: some monsters poison, burn, stun, or freeze on contact
- **Loot table**: common, rare, epic, dragon, boss — higher tables yield better items
- **Visual representation**: unique color-coded pixel sprite

### Boss AI

Bosses have multi-phase AI with special actions including targeted spells, summon mechanics, healing pulses, and charge attacks processed via a dedicated `processBossAI()` system.

---

## 🎒 Items & Equipment

### Item Types

- ⚔️ **Weapons** — daggers, swords, axes, staves, bows — each with ATK bonus and optional special effect
- 🛡️ **Armor** — light, medium, heavy sets with DEF, HP, and elemental resistances
- 🧪 **Potions** — HP Small/Medium/Large, MP, Status Cure, Strength, Speed
- 📜 **Scrolls** — Identify, Teleport, Fireball, Map Reveal, Enchant
- 💎 **Rings & Amulets** — passive stat modifiers
- 🍖 **Food** — hunger system restoration
- 💣 **Bombs** — area damage consumables
- 🔮 **Magic Crystals** — spell fuel

### Item Rarity System

Items have 5 rarity tiers:
- **Common** (gray) — basic stats
- **Uncommon** (green) — modest bonuses
- **Rare** (blue) — strong bonuses
- **Epic** (purple) — exceptional stats, often with special effects
- **Legendary** (gold) — unique items with powerful special abilities

### Crafting System

The in-game crafting menu allows Melissa to combine materials found in dungeons to create new equipment. Recipes are discoverable through Libraries and Altars.

### Identification System

Unidentified items show as "??? Scroll" or "Glowing Ring" until Melissa uses an Identify Scroll or visits a Library. Using an unidentified item may have unpredictable effects.

---

## 🧙 Skill Tree

Melissa has a 4-branch skill tree, with 3 tiers per branch and a total of **18 distinct skills**:

### ⚔️ Warrior Branch
| Skill | Effect |
|-------|--------|
| Iron Skin (×3) | +3 DEF per level |
| Power Strike (×3) | Attacks deal 150%+ damage |
| Berserker (×2) | Double ATK, −50% DEF for 3 turns |
| War Cry (×1) | All enemies flee for 2 turns |
| Blade Master (×1) | +20% critical hit chance (passive) |

### 🔮 Mage Branch
| Skill | Effect |
|-------|--------|
| Mana Well (×3) | +10 Max MP per level |
| Fireball (×3) | Area damage spell |
| Mana Shield (×2) | Convert MP to a damage-absorbing shield |
| Arcane Mastery (×2) | All spells deal +25% more damage |
| Spell Echo (×1) | 30% chance to cast any spell twice |

### 🗡️ Rogue Branch
| Skill | Effect |
|-------|--------|
| Shadow Step (×3) | Teleport 2 tiles (blink) |
| Pickpocket (×2) | +50% gold drops from enemies |
| Backstab (×3) | ×3 damage when attacking from behind |
| Evasion Roll (×2) | +15% evasion per level |
| Smoke Bomb (×1) | Blind all nearby monsters for 3 turns |

### ✝️ Paladin Branch
| Skill | Effect |
|-------|--------|
| Holy Strike (×3) | Deal ATK+MAG holy damage |
| Healing Light (×2) | Restore HP based on MAG stat |
| Divine Aura (×2) | +50% resistance to undead attacks |
| Smite (×2) | Stun + triple damage vs undead |
| Resurrection (×1) | Auto-revive once with 50% HP on death |

Skill points are earned through level-ups and from Shrines found on dungeon floors.

---

## ✨ Shinre System — The Heart of the Game

### What Are Shinre?

Shinre (神礼, *sacred rite*) are special, story-critical dungeons that appear on the world map after Melissa completes regular dungeons. They are rarer and more challenging than standard dungeons, with 5 floors of curated difficulty and a narrative theme tied to one of the **Seven Needs** of love.

Each Shinre grants a **Relic** upon completion — a crystallized fragment of Amara's imprisoned essence, which permanently changes how Melissa plays.

### Spawn Probability

Shinre spawn chance grows with each regular dungeon cleared:

```
spawn_chance = min(70%, 5% + dungeons_cleared × 8%)
```

After 1 dungeon: 13%. After 3: 29%. After 7: 61%. After 9: 77% (capped at 70%).

### The Seven Shinre

Each Shinre is named for something. The names are simple — ordinary, almost. The kind of words that should not be powerful enough to seal a goddess's essence inside a temple of stone and shadow. And yet.

Melissa does not understand, the first time she reads them, why these seven things. She understands better after the first temple. Better still after the second. By the seventh, she will not need anyone to explain it to her.

| # | Temple | Relic | Gameplay Effect |
|---|--------|-------|-----------------|
| 1️⃣ | 👑 The Temple of the Sole Crown | The Singular Diadem | +25% ATK when no companion is active |
| 2️⃣ | 🤝 The Temple of Unbroken Oaths | Seal of the Honored Name | After 5 turns unhurt: absorb the next hit entirely |
| 3️⃣ | 👂 The Whispering Sanctum | Echo of the True Voice | Reveal all secrets; first enemy strike each fight deals no damage |
| 4️⃣ | 🕯 The Temple of Steadfast Light | Lantern of Steady Flame | +2 HP regen per turn outside combat |
| 5️⃣ | ⚖ The Twin Throne Chamber | Crown of Equal Sovereignty | Dynamic balance: burst then breathe, or pay in vulnerability |
| 6️⃣ | 👁 The Hall of True Sight | Gem of Unveiled Presence | All hidden enemies revealed; +40% crit on marked targets |
| 7️⃣ | 🛡 The Bastion of Sacred Guard | Aegis of the Untouched Queen | 15 HP shield that recharges after 4 non-attack turns |

### The Final Castle

When all seven Shinre are completed and all seven Relics collected, something appears on the world map that was not there before.

**The Shattered Throne.** 🏰

Ten floors. The deepest dungeon in Vaeloria. Valdris at the bottom.

What happens there is not described here. It is not a secret worth keeping from you — it is a secret worth *earning*.

---

## 🐾 Companion System

Melissa can hire one active **companion** at a time from Companion Guilds on the world map. Companions follow her into dungeons, fight autonomously, and use special abilities on cooldown.

### Available Companions

| Companion | Cost | Role | Special Ability |
|-----------|------|------|-----------------|
| 🗡️ Squire | 80g | Melee tank | Guards Melissa, takes hits |
| 🏹 Elven Archer | 150g | Ranged DPS | Shoots enemies up to 5 tiles away |
| 🔮 Apprentice Mage | 220g | Spell support | Casts Fireball every 3 turns |
| ⚔️ Holy Paladin | 300g | Tank + healer | Heals Melissa for 15 HP every 5 turns |
| 🗡️ Rogue | 180g | Burst DPS | Deals double damage when attacking from behind |
| 🪨 Stone Familiar | 400g | Bulwark | 100 HP, 16 DEF, absorbs hits meant for Melissa |

Companions have their own HP bars, pathfind independently using A*, and die permanently if they reach 0 HP (they can be rehired).

---

## 🐴 Mount System

Mounts provide passive stat bonuses and change how Melissa moves across the world. They are purchased at Stables on the world map.

### Available Mounts

| Mount | Cost | Speed | Bonuses | Special |
|-------|------|-------|---------|---------|
| 🐴 War Horse | 200g | 2 tiles/turn | +2 DEF | — |
| 🏇 Warhorse | 400g | 2 tiles/turn | +4 ATK, +4 DEF | Immune to traps |
| 🦋 Pegasus | 800g | 3 tiles/turn | — | Flies over walls, traps, water |
| 🐉 Dragon Mount | 2000g | 2 tiles/turn | +10 ATK, +8 DEF | Immune to lava |
| 🐺 Shadow Wolf | 500g | 2 tiles/turn | +6 ATK | Immune to traps |
| 🐢 Iron Turtle | 120g | 1 tile/turn | +12 DEF | Immune to traps |

Mounts with `stepsPerTurn > 1` move that many tiles per key press, giving Melissa a burst of speed. The Pegasus's wall-walking ability allows passage through impassable terrain.

---

## 💹 Dynamic Market Economy

The game features **8 markets** across the world map, each with a different name and inventory. Prices are not fixed — they fluctuate dynamically using a random multiplier per item (range: ×0.4 to ×2.5 of base price).

### Market Goods

- ⚔️ Iron Sword, Battle Axe
- 🛡️ Chain Mail, Ring of Might
- 🧪 Health Potions (S/M), Antidote, Teleport Scroll
- 🔮 Magic Crystal, Fireball Tome
- 🍖 Food Ration
- 💣 Bomb

Each item displays a **trend arrow**: ▲ red (price rising), ▼ green (price falling), ● neutral.

Prices automatically shift after boss kills, and a manual "Fluctuate Prices" button is available inside each market.

---

## 📱 Mobile & Touch Support

The game includes a complete **virtual touch interface** for mobile/tablet play:

### Virtual D-Pad (bottom left)
- Cardinal directions: ▲▼◀▶
- Diagonal directions: ↖↗↙↘
- Center button: ⏸ (wait/skip turn)

### Action Buttons (bottom right)
- 📦 **Open/Use** — smart contextual button: uses stairs if standing on one, opens adjacent chest, otherwise picks up items
- 🧪 **Spell** — activates targeting mode for the currently selected spell
- 🎒 **Items** — opens the Inventory/Equipment/Crafting panel
- ⭐ **Skills** — opens the Skill Tree

### Toggle Button
A small 🎮 button in the corner shows/hides the entire touch interface (useful when reading messages or checking the map). Icon changes to 👁 when hidden.

---

## 🎨 Visual Design

### Pixel Art Sprite System

All game graphics are **procedurally generated pixel art** drawn at runtime using the HTML5 Canvas API. No external image files are required. The sprite generator creates:

- 24 unique monster sprites with color-coded designs
- Boss sprites with special visual effects
- Player sprite (Melissa as a golden dancer silhouette)
- World map tile sprites for all 8 biomes
- Town, dungeon, market, stable, and camp icons
- Chest, trap, water, lava, and special tile graphics
- HUD elements and UI components

### World Map Visual Language

Each point of interest uses a **color tint** on the base sprite to distinguish it:
- Dungeons: purple tint
- Towns: white/default
- Markets: orange tint
- Stables: green tint
- Companion Guilds: blue tint
- Shinre Temples: their unique relic color
- Final Castle: deep red

### HUD Layout

- **Top bar**: HP (red), MP (blue), Gold (gold), Level/XP (green)
- **Bottom bar**: Floor info, dungeon name, active relics
- **Message log**: scrollable combat/event log on the right
- **Status icons**: active effects displayed as emoji with duration countdown
- **Touch controls**: optional overlay at screen edges

---

## 💾 Save System

The game uses **IndexedDB** for persistent save data, storing:
- Player stats, HP, inventory, equipment, skills
- World map state (dungeons, towns, markets, shinres, cleared locations)
- Floor and dungeon progress
- Active companion and mount
- Relics collected and Shinre completion status
- Turn count, gold, XP

Quicksave is bound to **Q** and loadgame is available from the title screen.

---

## 🎵 UI/UX Features

- **Toast notifications** — popup messages for rare events, level-ups, relic acquisition
- **Floating damage numbers** — colored numbers that float up from entities when they take damage
- **Camera shake** — screen shake on heavy hits
- **Smooth tweens** — all movement is tweened for fluid visuals
- **Hover tooltips** — hovering over map locations shows name, description, and interaction hint
- **Tile highlight cursor** — a soft white highlight follows the mouse in the dungeon to show the click target
- **Proximity hints** — pressing E (use stairs) when not standing on stairs shows "Stairs nearby" with compass direction
- **ESC to close** — all menus close with Escape key
- **Keyboard shortcuts** — full keyboard support: WASD/arrows, I (inventory), T (skills), G (pickup), E (stairs), Q (save), F (spell targeting)

---

## ⚙️ Technical Architecture

### Engine & Stack
- **Phaser 3.70+** — game engine via CDN
- **Pure JavaScript (ES2020)** — no build tools, no TypeScript, no frameworks
- **Single HTML file** — entire game in one `game.js` + one `index.html`
- **Canvas API** — procedural sprite generation
- **IndexedDB** — persistent save system

### Entity-Component System (ECS)

The game uses a custom lightweight ECS:
- `World` — entity manager and query system
- `Entity` — container for components, supports tag-based querying
- `Components` — `pos`, `health`, `stats`, `inventory`, `equipment`, `skills`, `render`, `ai`, `fov`, `status`

### Procedural Generation Systems
- **Perlin noise** — world map terrain generation
- **BSP rooms** — dungeon floor layout
- **Weighted random** — loot tables, monster spawning, event placement
- **Seeded RNG** — every element is deterministic from a seed, allowing for reproducible worlds

### Pathfinding
- **A\*** — dungeon movement (Melissa and monsters)
- **BFS** — world map movement (handles ocean blocking)
- Both implementations are custom, with configurable `passable()` functions to support mount abilities

---

## 🕹️ Controls Reference

| Input | Action |
|-------|--------|
| WASD / Arrow Keys | Move Melissa |
| Numpad 1–9 | Move including diagonals |
| I | Open Inventory |
| T | Open Skill Tree |
| G | Pick up item |
| E / , | Use stairs / interact |
| Q | Quicksave |
| ESC | Close menu |
| F | Spell targeting mode |
| Left Click | Move to tile / interact / attack |
| Right Click | Cancel path |
| Click on map | Pathfind to location |

---

## 🚀 How to Run

1. Download `index.html` and `game.js` into the same folder
2. Open `index.html` in any modern browser (Chrome, Firefox, Edge, Safari)
3. No server required. No install. No dependencies (Phaser loads from CDN).

For offline play, download Phaser 3 locally and update the `<script>` tag in `index.html`.

---

## 📋 Credits & License

**Melissa's Wrath: Endless Descent** was built as a solo project using Phaser 3. All procedural art generated at runtime. Story and game design original.

*"She knows the answer. It lives in her chest like a heartbeat. She will not say it here — you have to earn it, the same way she did."*

---

*💃 Seven temples. Seven relics. One reason she will not stop.*
