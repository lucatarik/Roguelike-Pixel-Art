// game.js - Roguelike in ASCII (senza sprite)
// Richiede: Phaser 3, EasyStar (opzionale), localForage, SimplexNoise

// ==================== CONFIGURAZIONE ====================
const TILE_SIZE = 16; // usato solo per posizionamento testi
const WORLD_WIDTH = 80;
const WORLD_HEIGHT = 60;
const DUNGEON_WIDTH = 40;
const DUNGEON_HEIGHT = 30;

// Font
const FONT_STYLE = { fontSize: '16px', fontFamily: 'Courier New, monospace', fill: '#fff' };

// Perlin noise (con fallback)
let simplex;
if (typeof SimplexNoise !== 'undefined') {
    simplex = new SimplexNoise();
} else {
    console.warn("SimplexNoise non trovato, uso rumore casuale semplice.");
    simplex = { noise2D: (x, y) => Math.sin(x * 10) * Math.cos(y * 10) };
}

// ==================== UTILITY ====================
class RNG {
    constructor(seed) {
        this.seed = seed % 2147483647;
        if (this.seed <= 0) this.seed += 2147483646;
    }
    next() {
        return this.seed = this.seed * 16807 % 2147483647;
    }
    nextFloat() {
        return (this.next() - 1) / 2147483646;
    }
    range(min, max) {
        return Math.floor(this.nextFloat() * (max - min + 1)) + min;
    }
    choice(array) {
        return array[this.range(0, array.length - 1)];
    }
    shuffle(array) {
        for (let i = array.length - 1; i > 0; i--) {
            const j = Math.floor(this.nextFloat() * (i + 1));
            [array[i], array[j]] = [array[j], array[i]];
        }
        return array;
    }
}

// Pathfinding BFS sincrono
function bfsPath(grid, start, goal, maxDist = 50) {
    const queue = [{ x: start.x, y: start.y, path: [start] }];
    const visited = new Set();
    visited.add(`${start.x},${start.y}`);

    while (queue.length > 0) {
        const { x, y, path } = queue.shift();
        if (path.length > maxDist) continue;
        if (x === goal.x && y === goal.y) return path;

        const dirs = [[0, -1], [0, 1], [-1, 0], [1, 0]];
        for (let [dx, dy] of dirs) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || nx >= DUNGEON_WIDTH || ny < 0 || ny >= DUNGEON_HEIGHT) continue;
            if (grid[ny][nx] === 1) continue; // muro
            const key = `${nx},${ny}`;
            if (!visited.has(key)) {
                visited.add(key);
                queue.push({ x: nx, y: ny, path: [...path, { x: nx, y: ny }] });
            }
        }
    }
    return null;
}

// ==================== CLASSI DI GIOCO ====================
class StatusEffect {
    constructor(type, duration, damagePerTurn) {
        this.type = type; // 'poison', 'burn'
        this.duration = duration;
        this.damagePerTurn = damagePerTurn;
    }
    apply(entity) {
        entity.hp -= this.damagePerTurn;
        this.duration--;
    }
}

class Item {
    constructor(type, rarity, stats, materialDrop = false) {
        this.type = type; // 'weapon', 'armor', 'potion', 'material'
        this.rarity = rarity; // 0-3 o -1 per materiali
        this.stats = stats || {};
        this.materialDrop = materialDrop;
    }
    static random(rng, level, isMaterial = false) {
        if (isMaterial) {
            const materials = ['bone', 'leather', 'cloth', 'iron_ore'];
            return new Item(rng.choice(materials), -1, {}, true);
        }
        const rarityRoll = rng.nextFloat();
        let rarity;
        if (rarityRoll < 0.5) rarity = 0;
        else if (rarityRoll < 0.8) rarity = 1;
        else if (rarityRoll < 0.95) rarity = 2;
        else rarity = 3;

        const type = rng.choice(['weapon', 'armor', 'potion']);
        const stats = {
            hpBonus: type === 'potion' ? rng.range(5, 15) * (rarity + 1) : 0,
            attackBonus: type === 'weapon' ? rng.range(1, 5) * (rarity + 1) : 0,
            defenseBonus: type === 'armor' ? rng.range(1, 3) * (rarity + 1) : 0,
            critChance: type === 'weapon' ? (rarity + 1) * 0.05 : 0
        };
        return new Item(type, rarity, stats);
    }
}

class Recipe {
    constructor(name, resultType, resultRarity, materials, skillRequired) {
        this.name = name;
        this.resultType = resultType;
        this.resultRarity = resultRarity;
        this.materials = materials; // [{type:'bone', qty:2}]
        this.skillRequired = skillRequired || 0;
    }
    canCraft(player) {
        for (let mat of this.materials) {
            const count = player.materials.filter(m => m.type === mat.type).length;
            if (count < mat.qty) return false;
        }
        return true;
    }
    craft(player) {
        for (let mat of this.materials) {
            for (let i = 0; i < mat.qty; i++) {
                const index = player.materials.findIndex(m => m.type === mat.type);
                if (index !== -1) player.materials.splice(index, 1);
            }
        }
        const rng = new RNG(Date.now());
        const item = Item.random(rng, 1);
        item.type = this.resultType;
        item.rarity = this.resultRarity;
        player.inventory.push(item);
        return item;
    }
}

class Skill {
    constructor(name, description, maxLevel, effects) {
        this.name = name;
        this.description = description;
        this.maxLevel = maxLevel;
        this.level = 0;
        this.effects = effects;
    }
    apply(player) {
        this.effects(player, this.level);
    }
}

class Player {
    constructor() {
        this.hp = 30;
        this.maxHp = 30;
        this.attack = 5;
        this.defense = 2;
        this.critChance = 0.05;
        this.skillPoints = 0;
        this.skills = [];
        this.inventory = [];
        this.materials = [];
        this.effects = [];
        this.x = 0;
        this.y = 0;
        this.recipes = [];
        this.gold = 0;
        this.char = '@'; // carattere ASCII
        this.color = '#0f0'; // verde
    }
    equip(item) {
        if (item.type === 'weapon') {
            this.attack += item.stats.attackBonus;
            this.critChance += item.stats.critChance;
        } else if (item.type === 'armor') {
            this.defense += item.stats.defenseBonus;
        } else if (item.type === 'potion') {
            this.hp = Math.min(this.hp + item.stats.hpBonus, this.maxHp);
        }
    }
    takeDamage(dmg) {
        const mitigated = Math.max(1, dmg - this.defense);
        this.hp -= mitigated;
        return mitigated;
    }
    attackRoll() {
        const dmg = this.attack + Math.floor(Math.random() * 3);
        const isCrit = Math.random() < this.critChance;
        return isCrit ? dmg * 2 : dmg;
    }
    updateEffects() {
        this.effects = this.effects.filter(e => e.duration > 0);
        this.effects.forEach(e => e.apply(this));
    }
}

class Enemy {
    constructor(type, x, y, level, rng) {
        this.type = type; // 'normal' o 'boss'
        this.x = x;
        this.y = y;
        this.level = level;
        this.hp = 10 + level * 5;
        this.maxHp = this.hp;
        this.attack = 3 + level;
        this.defense = 1 + Math.floor(level / 2);
        this.critChance = 0.05;
        this.effects = [];
        this.pattern = null;
        if (type === 'boss') {
            this.hp *= 3;
            this.maxHp = this.hp;
            this.attack *= 2;
            this.defense *= 2;
            this.pattern = new BossPattern(this, rng);
            this.char = 'B';
            this.color = '#f0f'; // magenta
        } else {
            // Goblin o ogre casuale
            this.subtype = rng.choice(['goblin', 'ogre']);
            this.char = this.subtype === 'goblin' ? 'g' : 'O';
            this.color = '#f00'; // rosso
        }
    }
    attackRoll() {
        const dmg = this.attack + Math.floor(Math.random() * 3);
        const isCrit = Math.random() < this.critChance;
        return isCrit ? dmg * 2 : dmg;
    }
    takeDamage(dmg) {
        this.hp -= Math.max(1, dmg - this.defense);
    }
}

class BossPattern {
    constructor(boss, rng) {
        this.boss = boss;
        this.rng = rng;
        this.phase = 0;
        this.turnCounter = 0;
    }
    act(scene) {
        this.turnCounter++;
        if (this.boss.hp < this.boss.maxHp * 0.5 && this.phase === 0) {
            this.phase = 1;
            scene.showMessage("Il boss si infuria! Attacco +2");
            this.boss.attack += 2;
        }
        if (this.boss.hp < this.boss.maxHp * 0.2 && this.phase === 1) {
            this.phase = 2;
            scene.showMessage("Il boss evoca minion!");
            for (let i = 0; i < 2; i++) {
                scene.spawnEnemyNearBoss();
            }
        }
        if (this.turnCounter % 3 === 0) {
            scene.showMessage("Il boss carica un colpo potente!");
            return { type: 'charge', damage: this.boss.attack * 2 };
        } else {
            return { type: 'normal', damage: this.boss.attackRoll() };
        }
    }
}

// ==================== SCENE ====================
class BootScene extends Phaser.Scene {
    constructor() {
        super('BootScene');
    }
    preload() {
        // Nessuna immagine da caricare
    }
    create() {
        // Carica salvataggio
        localforage.getItem('save').then(save => {
            if (save) {
                this.registry.set('save', save);
                this.scene.start('OverworldScene', { loadSave: true });
            } else {
                this.scene.start('OverworldScene', { loadSave: false });
            }
        }).catch(() => {
            this.scene.start('OverworldScene', { loadSave: false });
        });
    }
}

class OverworldScene extends Phaser.Scene {
    constructor() {
        super('OverworldScene');
        this.biomeMap = [];
        this.player = null;
        this.cursors = null;
        this.seed = Math.floor(Math.random() * 1000000);
        this.rng = new RNG(this.seed);
        this.craftingSceneActive = false;
        this.dungeonEntrances = [];
        this.tileTexts = []; // matrice di testi per lo sfondo
        this.playerText = null; // testo per il player
    }
    init(data) {
        this.loadSave = data.loadSave;
    }
    create() {
        this.generateWorld();

        if (this.loadSave) {
            const save = this.registry.get('save');
            this.player = save.player;
            this.seed = save.seed;
            this.rng = new RNG(this.seed);
            this.biomeMap = save.biomeMap;
            this.player.x = save.player.x;
            this.player.y = save.player.y;
            this.dungeonEntrances = save.dungeonEntrances;
        } else {
            this.player = new Player();
            do {
                this.player.x = this.rng.range(0, WORLD_WIDTH - 1);
                this.player.y = this.rng.range(0, WORLD_HEIGHT - 1);
            } while (this.biomeMap[this.player.y][this.player.x] === 3); // 3=acqua
        }

        this.drawMap(); // crea testi dello sfondo
        this.playerText = this.add.text(this.player.x * TILE_SIZE, this.player.y * TILE_SIZE, this.player.char, { ...FONT_STYLE, fill: this.player.color }).setOrigin(0);

        this.cursors = this.input.keyboard.createCursorKeys();
        this.uiText = this.add.text(10, 10, '', { fontSize: '16px', fill: '#fff', fontFamily: 'monospace' });
        this.updateUI();

        this.time.addEvent({ delay: 10000, callback: this.saveGame, callbackScope: this, loop: true });
    }
    generateWorld() {
        this.biomeMap = [];
        for (let y = 0; y < WORLD_HEIGHT; y++) {
            let row = [];
            for (let x = 0; x < WORLD_WIDTH; x++) {
                const nx = x / WORLD_WIDTH - 0.5;
                const ny = y / WORLD_HEIGHT - 0.5;
                const e = simplex.noise2D(nx * 2, ny * 2);
                const m = simplex.noise2D(nx * 4 + 100, ny * 4 + 100);
                let biome;
                if (e < -0.2) biome = 3; // acqua
                else if (m > 0.3) biome = 2; // montagna
                else if (e > 0.2) biome = 1; // foresta
                else biome = 0; // prateria
                row.push(biome);
            }
            this.biomeMap.push(row);
        }
        this.dungeonEntrances = [];
        for (let i = 0; i < 5; i++) {
            let x, y;
            do {
                x = this.rng.range(0, WORLD_WIDTH - 1);
                y = this.rng.range(0, WORLD_HEIGHT - 1);
            } while (this.biomeMap[y][x] === 3 || this.dungeonEntrances.some(d => d.x === x && d.y === y));
            this.dungeonEntrances.push({ x, y, depth: 1 });
            this.biomeMap[y][x] = 4; // dungeon
        }
    }
    drawMap() {
        // Crea testi per ogni cella di sfondo
        for (let y = 0; y < WORLD_HEIGHT; y++) {
            this.tileTexts[y] = [];
            for (let x = 0; x < WORLD_WIDTH; x++) {
                let char, color;
                switch (this.biomeMap[y][x]) {
                    case 0: char = '.'; color = '#6b8e23'; break; // prateria verde scuro
                    case 1: char = '&'; color = '#228b22'; break; // foresta verde
                    case 2: char = '^'; color = '#8b8b8b'; break; // montagna grigio
                    case 3: char = '~'; color = '#1e90ff'; break; // acqua blu
                    case 4: char = 'D'; color = '#9400d3'; break; // dungeon viola
                }
                const text = this.add.text(x * TILE_SIZE, y * TILE_SIZE, char, { ...FONT_STYLE, fill: color }).setOrigin(0);
                this.tileTexts[y][x] = text;
            }
        }
    }
    update() {
        if (!this.cursors) return;
        let dx = 0, dy = 0;
        if (Phaser.Input.Keyboard.JustDown(this.cursors.left)) dx = -1;
        else if (Phaser.Input.Keyboard.JustDown(this.cursors.right)) dx = 1;
        else if (Phaser.Input.Keyboard.JustDown(this.cursors.up)) dy = -1;
        else if (Phaser.Input.Keyboard.JustDown(this.cursors.down)) dy = 1;
        else return;

        const nx = this.player.x + dx;
        const ny = this.player.y + dy;
        if (nx < 0 || nx >= WORLD_WIDTH || ny < 0 || ny >= WORLD_HEIGHT) return;
        if (this.biomeMap[ny][nx] === 3) return; // acqua

        // Muovi player
        this.player.x = nx;
        this.player.y = ny;
        this.playerText.setPosition(nx * TILE_SIZE, ny * TILE_SIZE);

        // Controlla dungeon
        const entrance = this.dungeonEntrances.find(d => d.x === nx && d.y === ny);
        if (entrance) {
            this.scene.start('DungeonScene', {
                seed: this.seed + entrance.depth,
                depth: entrance.depth,
                entrance: entrance,
                player: this.player
            });
        }
        this.updateUI();

        // Tasti S e C
        if (Phaser.Input.Keyboard.JustDown(this.input.keyboard.addKey('S'))) {
            this.scene.launch('SkillTreeScene', { player: this.player });
            this.scene.pause();
        }
        if (Phaser.Input.Keyboard.JustDown(this.input.keyboard.addKey('C'))) {
            if (!this.craftingSceneActive) {
                this.craftingSceneActive = true;
                this.scene.launch('CraftingScene', { player: this.player });
                this.scene.pause();
            }
        }
    }
    updateUI() {
        this.uiText.setText(`Overworld | HP: ${this.player.hp}/${this.player.maxHp} | Skill Points: ${this.player.skillPoints}`);
    }
    saveGame() {
        const save = {
            player: this.player,
            seed: this.seed,
            biomeMap: this.biomeMap,
            dungeonEntrances: this.dungeonEntrances
        };
        localforage.setItem('save', save).then(() => console.log('Salvato'));
    }
}

class DungeonScene extends Phaser.Scene {
    constructor() {
        super('DungeonScene');
        this.map = [];
        this.rooms = [];
        this.player = null;
        this.enemies = [];
        this.items = [];
        this.roomEvents = []; // <-- rinominato
        this.fov = [];
        this.turn = 'player';
        this.cursors = null;
        this.depth = 1;
        this.seed = 0;
        this.rng = null;
        this.entrance = null;
        this.tileTexts = [];
        this.entityTexts = [];
    }
    init(data) {
        this.seed = data.seed;
        this.depth = data.depth;
        this.entrance = data.entrance;
        this.player = data.player;
        this.rng = new RNG(this.seed);
    }
    create() {
        this.generateDungeon();

        this.fov = Array(DUNGEON_HEIGHT).fill().map(() => Array(DUNGEON_WIDTH).fill(0));
        this.tileTexts = Array(DUNGEON_HEIGHT).fill().map(() => Array(DUNGEON_WIDTH).fill(null));
        this.entityTexts = [];

        this.drawMap();

        const startRoom = this.rooms[0];
        this.player.x = startRoom.center.x;
        this.player.y = startRoom.center.y;
        this.playerText = this.add.text(this.player.x * TILE_SIZE, this.player.y * TILE_SIZE, this.player.char, { ...FONT_STYLE, fill: this.player.color }).setOrigin(0);

        this.spawnEntities();

        this.computeFOV();
        this.updateFog();

        this.uiText = this.add.text(10, 10, '', { fontSize: '16px', fill: '#fff', fontFamily: 'monospace' });
        this.messageText = this.add.text(10, 570, '', { fontSize: '12px', fill: '#ff0', fontFamily: 'monospace' });
        this.updateUI();

        this.cursors = this.input.keyboard.createCursorKeys();
    }
    generateDungeon() {
        this.map = Array(DUNGEON_HEIGHT).fill().map(() => Array(DUNGEON_WIDTH).fill(1));
        this.rooms = [];
        const numRooms = 5 + this.depth;
        for (let i = 0; i < numRooms; i++) {
            const w = this.rng.range(4, 8);
            const h = this.rng.range(4, 8);
            const x = this.rng.range(1, DUNGEON_WIDTH - w - 1);
            const y = this.rng.range(1, DUNGEON_HEIGHT - h - 1);
            const room = { x, y, w, h, center: { x: Math.floor(x + w / 2), y: Math.floor(y + h / 2) } };
            this.rooms.push(room);
            for (let row = y; row < y + h; row++) {
                for (let col = x; col < x + w; col++) {
                    this.map[row][col] = 0;
                }
            }
        }
        for (let i = 0; i < this.rooms.length - 1; i++) {
            const from = this.rooms[i].center;
            const to = this.rooms[i + 1].center;
            this.carveCorridor(from.x, from.y, to.x, to.y);
        }
        const lastRoom = this.rooms[this.rooms.length - 1];
        this.map[lastRoom.center.y][lastRoom.center.x] = 2; // stairs

        for (let room of this.rooms.slice(1)) {
            if (this.rng.nextFloat() < 0.3) {
                const eventType = this.rng.choice(['trap', 'merchant', 'shrine', 'ambush']);
                this.roomEvents.push({ x: room.center.x, y: room.center.y, type: eventType }); // <-- rinominato
            }
        }
    }
    carveCorridor(x1, y1, x2, y2) {
        let x = x1, y = y1;
        while (x !== x2) {
            this.map[y][x] = 0;
            x += x < x2 ? 1 : -1;
        }
        while (y !== y2) {
            this.map[y][x] = 0;
            y += y < y2 ? 1 : -1;
        }
    }
    drawMap() {
        for (let y = 0; y < DUNGEON_HEIGHT; y++) {
            for (let x = 0; x < DUNGEON_WIDTH; x++) {
                let char, color;
                if (this.map[y][x] === 1) { char = '#'; color = '#8b4513'; }
                else if (this.map[y][x] === 2) { char = '>'; color = '#00f'; }
                else { char = '.'; color = '#aaa'; }
                const text = this.add.text(x * TILE_SIZE, y * TILE_SIZE, char, { ...FONT_STYLE, fill: color }).setOrigin(0);
                this.tileTexts[y][x] = text;
            }
        }
    }
    spawnEntities() {
        // Nemici
        for (let i = 0; i < 3 + this.depth; i++) {
            const room = this.rng.choice(this.rooms.slice(1));
            let x, y;
            do {
                x = this.rng.range(room.x, room.x + room.w - 1);
                y = this.rng.range(room.y, room.y + room.h - 1);
            } while (this.map[y][x] !== 0 || (x === this.player.x && y === this.player.y) || this.enemies.some(e => e.x === x && e.y === y));
            const enemy = new Enemy('normal', x, y, this.depth, this.rng);
            enemy.text = this.add.text(x * TILE_SIZE, y * TILE_SIZE, enemy.char, { ...FONT_STYLE, fill: enemy.color }).setOrigin(0);
            this.enemies.push(enemy);
            this.entityTexts.push(enemy.text);
        }
        // Boss
        if (this.depth % 5 === 0) {
            const bossRoom = this.rooms[this.rooms.length - 1];
            const x = bossRoom.center.x, y = bossRoom.center.y;
            const boss = new Enemy('boss', x, y, this.depth, this.rng);
            boss.text = this.add.text(x * TILE_SIZE, y * TILE_SIZE, boss.char, { ...FONT_STYLE, fill: boss.color }).setOrigin(0);
            this.enemies.push(boss);
            this.entityTexts.push(boss.text);
        }
        // Oggetti e materiali
        for (let i = 0; i < 2; i++) {
            const room = this.rng.choice(this.rooms);
            let x, y;
            do {
                x = this.rng.range(room.x, room.x + room.w - 1);
                y = this.rng.range(room.y, room.y + room.h - 1);
            } while (this.map[y][x] !== 0 || this.enemies.some(e => e.x === x && e.y === y) || this.items.some(it => it.x === x && it.y === y));
            const isMaterial = this.rng.nextFloat() < 0.5;
            const item = Item.random(this.rng, this.depth, isMaterial);
            item.x = x; item.y = y;
            if (isMaterial) {
                switch (item.type) {
                    case 'bone': item.char = ';'; item.color = '#fff'; break;
                    case 'leather': item.char = ';'; item.color = '#cd853f'; break;
                    case 'cloth': item.char = ';'; item.color = '#f0e68c'; break;
                    case 'iron_ore': item.char = ';'; item.color = '#a9a9a9'; break;
                }
            } else {
                if (item.type === 'potion') { item.char = '!'; item.color = '#f0f'; }
                else if (item.type === 'weapon') { item.char = '/'; item.color = '#ff0'; }
                else { item.char = ']'; item.color = '#0ff'; }
            }
            item.text = this.add.text(x * TILE_SIZE, y * TILE_SIZE, item.char, { ...FONT_STYLE, fill: item.color }).setOrigin(0);
            this.items.push(item);
            this.entityTexts.push(item.text);
        }
    }
    computeFOV() {
        for (let y = 0; y < DUNGEON_HEIGHT; y++) {
            for (let x = 0; x < DUNGEON_WIDTH; x++) {
                if (this.fov[y][x] === 2) this.fov[y][x] = 1;
            }
        }
        const px = this.player.x, py = this.player.y;
        const range = 8;
        for (let dy = -range; dy <= range; dy++) {
            for (let dx = -range; dx <= range; dx++) {
                const x = px + dx, y = py + dy;
                if (x < 0 || x >= DUNGEON_WIDTH || y < 0 || y >= DUNGEON_HEIGHT) continue;
                if (Math.abs(dx) + Math.abs(dy) > range) continue;
                if (this.hasLineOfSight(px, py, x, y)) {
                    this.fov[y][x] = 2;
                }
            }
        }
    }
    hasLineOfSight(x0, y0, x1, y1) {
        let dx = Math.abs(x1 - x0);
        let dy = Math.abs(y1 - y0);
        let sx = x0 < x1 ? 1 : -1;
        let sy = y0 < y1 ? 1 : -1;
        let err = dx - dy;
        let x = x0, y = y0;
        while (true) {
            if (x === x1 && y === y1) return true;
            if (this.map[y][x] === 1) return false;
            let e2 = 2 * err;
            if (e2 > -dy) { err -= dy; x += sx; }
            if (e2 < dx) { err += dx; y += sy; }
        }
    }
    updateFog() {
        for (let y = 0; y < DUNGEON_HEIGHT; y++) {
            for (let x = 0; x < DUNGEON_WIDTH; x++) {
                const tile = this.tileTexts[y][x];
                if (this.fov[y][x] === 2) {
                    tile.setAlpha(1);
                    tile.setColor(tile.style.color);
                } else if (this.fov[y][x] === 1) {
                    tile.setAlpha(0.5);
                } else {
                    tile.setAlpha(0.2);
                }
            }
        }
        this.entityTexts.forEach(text => {
            const x = Math.floor(text.x / TILE_SIZE);
            const y = Math.floor(text.y / TILE_SIZE);
            if (this.fov[y][x] === 2) {
                text.setAlpha(1);
            } else {
                text.setAlpha(0);
            }
        });
        this.playerText.setAlpha(1);
    }
    playerAttack(enemy) {
        const dmg = this.player.attackRoll();
        const crit = dmg > this.player.attack * 2 ? "CRITICO! " : "";
        enemy.takeDamage(dmg);
        this.showMessage(`${crit}Inflitti ${dmg} danni a ${enemy.type}`);
        if (enemy.hp <= 0) {
            enemy.text.destroy();
            this.enemies = this.enemies.filter(e => e !== enemy);
            this.entityTexts = this.entityTexts.filter(t => t !== enemy.text);
            this.player.skillPoints += 1;
            const numMaterials = this.rng.range(1, 2);
            for (let i = 0; i < numMaterials; i++) {
                const material = Item.random(this.rng, this.depth, true);
                material.x = enemy.x; material.y = enemy.y;
                switch (material.type) {
                    case 'bone': material.char = ';'; material.color = '#fff'; break;
                    case 'leather': material.char = ';'; material.color = '#cd853f'; break;
                    case 'cloth': material.char = ';'; material.color = '#f0e68c'; break;
                    case 'iron_ore': material.char = ';'; material.color = '#a9a9a9'; break;
                }
                material.text = this.add.text(material.x * TILE_SIZE, material.y * TILE_SIZE, material.char, { ...FONT_STYLE, fill: material.color }).setOrigin(0);
                this.items.push(material);
                this.entityTexts.push(material.text);
            }
            if (this.rng.nextFloat() < 0.1) {
                const loot = Item.random(this.rng, this.depth, false);
                loot.x = enemy.x; loot.y = enemy.y;
                if (loot.type === 'potion') { loot.char = '!'; loot.color = '#f0f'; }
                else if (loot.type === 'weapon') { loot.char = '/'; loot.color = '#ff0'; }
                else { loot.char = ']'; loot.color = '#0ff'; }
                loot.text = this.add.text(loot.x * TILE_SIZE, loot.y * TILE_SIZE, loot.char, { ...FONT_STYLE, fill: loot.color }).setOrigin(0);
                this.items.push(loot);
                this.entityTexts.push(loot.text);
            }
        } else {
            const enemyDmg = enemy.attackRoll();
            const taken = this.player.takeDamage(enemyDmg);
            this.showMessage(`${enemy.type} ti colpisce per ${taken} danni`);
            if (this.player.hp <= 0) this.gameOver();
        }
    }
    processEnemyTurn() {
        this.player.updateEffects();

        for (let enemy of this.enemies) {
            if (enemy.hp <= 0) continue;

            if (enemy.type === 'boss' && enemy.pattern) {
                const action = enemy.pattern.act(this);
                const dmg = action.damage;
                const taken = this.player.takeDamage(dmg);
                this.showMessage(`Il boss ti colpisce per ${taken} danni.`);
                if (this.player.hp <= 0) this.gameOver();
                continue;
            }

            if (this.fov[enemy.y][enemy.x] === 2) {
                const path = bfsPath(this.map, { x: enemy.x, y: enemy.y }, { x: this.player.x, y: this.player.y }, 20);
                if (path && path.length > 1) {
                    const next = path[1];
                    if (next.x === this.player.x && next.y === this.player.y) {
                        const dmg = enemy.attackRoll();
                        const taken = this.player.takeDamage(dmg);
                        this.showMessage(`${enemy.type} ti attacca e infligge ${taken} danni.`);
                        if (this.player.hp <= 0) this.gameOver();
                    } else {
                        enemy.x = next.x;
                        enemy.y = next.y;
                        enemy.text.setPosition(enemy.x * TILE_SIZE, enemy.y * TILE_SIZE);
                    }
                }
            } else {
                const dirs = [[0, -1], [0, 1], [-1, 0], [1, 0]];
                this.rng.shuffle(dirs);
                for (let [dx, dy] of dirs) {
                    const nx = enemy.x + dx, ny = enemy.y + dy;
                    if (this.map[ny][nx] === 0 && !this.enemies.some(e => e.x === nx && e.y === ny) && !(this.player.x === nx && this.player.y === ny)) {
                        enemy.x = nx;
                        enemy.y = ny;
                        enemy.text.setPosition(nx * TILE_SIZE, ny * TILE_SIZE);
                        break;
                    }
                }
            }
        }
        this.turn = 'player';
        this.updateUI();
    }
    update() {
        if (this.turn !== 'player') return;
        let moved = false;
        let newX = this.player.x, newY = this.player.y;
        if (Phaser.Input.Keyboard.JustDown(this.cursors.left)) { newX--; moved = true; }
        else if (Phaser.Input.Keyboard.JustDown(this.cursors.right)) { newX++; moved = true; }
        else if (Phaser.Input.Keyboard.JustDown(this.cursors.up)) { newY--; moved = true; }
        else if (Phaser.Input.Keyboard.JustDown(this.cursors.down)) { newY++; moved = true; }
        if (!moved) return;

        if (this.map[newY][newX] === 1) return;

        const enemy = this.enemies.find(e => e.x === newX && e.y === newY);
        if (enemy) {
            this.playerAttack(enemy);
            this.turn = 'enemy';
            this.processEnemyTurn();
            this.computeFOV();
            this.updateFog();
            this.updateUI();
            return;
        }

        const item = this.items.find(it => it.x === newX && it.y === newY);
        if (item) {
            if (item.materialDrop) {
                this.player.materials.push(item);
                this.showMessage(`Hai raccolto: ${item.type}`);
            } else {
                this.player.equip(item);
                this.showMessage(`Hai equipaggiato: ${item.type} (rarità ${item.rarity})`);
            }
            this.items = this.items.filter(it => it !== item);
            item.text.destroy();
            this.entityTexts = this.entityTexts.filter(t => t !== item.text);
        }

        const evt = this.roomEvents.find(e => e.x === newX && e.y === newY); // <-- rinominato
        if (evt) {
            this.triggerEvent(evt);
            this.roomEvents = this.roomEvents.filter(e => e !== evt); // <-- rinominato
        }

        this.player.x = newX;
        this.player.y = newY;
        this.playerText.setPosition(newX * TILE_SIZE, newY * TILE_SIZE);

        if (this.map[newY][newX] === 2) {
            this.depth++;
            this.entrance.depth = this.depth;
            this.scene.restart({ seed: this.seed + this.depth, depth: this.depth, entrance: this.entrance, player: this.player });
            return;
        }

        this.turn = 'enemy';
        this.processEnemyTurn();
        this.computeFOV();
        this.updateFog();
        this.updateUI();
    }
    triggerEvent(event) {
        switch (event.type) {
            case 'trap':
                const dmg = this.rng.range(5, 10);
                this.player.takeDamage(dmg);
                this.showMessage(`Una trappola ti infligge ${dmg} danni!`);
                break;
            case 'merchant':
                this.showMessage("Incontri un mercante. (Funzionalità non implementata)");
                break;
            case 'ambush':
                for (let i = 0; i < 2; i++) this.spawnEnemyNear(event.x, event.y);
                this.showMessage("Sei caduto in un'imboscata!");
                break;
            case 'shrine':
                this.player.hp = Math.min(this.player.hp + 10, this.player.maxHp);
                this.showMessage("Un altare ti cura di 10 HP.");
                if (this.rng.nextFloat() < 0.05) {
                    this.showMessage("Platino appare e ti benedice! Ottieni 5 materiali casuali.");
                    for (let i = 0; i < 5; i++) {
                        const mat = Item.random(this.rng, this.depth, true);
                        mat.x = this.player.x; mat.y = this.player.y;
                        switch (mat.type) {
                            case 'bone': mat.char = ';'; mat.color = '#fff'; break;
                            case 'leather': mat.char = ';'; mat.color = '#cd853f'; break;
                            case 'cloth': mat.char = ';'; mat.color = '#f0e68c'; break;
                            case 'iron_ore': mat.char = ';'; mat.color = '#a9a9a9'; break;
                        }
                        mat.text = this.add.text(mat.x * TILE_SIZE, mat.y * TILE_SIZE, mat.char, { ...FONT_STYLE, fill: mat.color }).setOrigin(0);
                        this.items.push(mat);
                        this.entityTexts.push(mat.text);
                    }
                }
                break;
        }
    }
    spawnEnemyNear(x, y) {
        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                const nx = x + dx, ny = y + dy;
                if (this.map[ny][nx] === 0 && !this.enemies.some(e => e.x === nx && e.y === ny) && !(this.player.x === nx && this.player.y === ny)) {
                    const enemy = new Enemy('normal', nx, ny, this.depth, this.rng);
                    enemy.text = this.add.text(nx * TILE_SIZE, ny * TILE_SIZE, enemy.char, { ...FONT_STYLE, fill: enemy.color }).setOrigin(0);
                    this.enemies.push(enemy);
                    this.entityTexts.push(enemy.text);
                    return;
                }
            }
        }
    }
    spawnEnemyNearBoss() {
        const boss = this.enemies.find(e => e.type === 'boss');
        if (boss) this.spawnEnemyNear(boss.x, boss.y);
    }
    gameOver() {
        this.showMessage("GAME OVER - Premi R per ricominciare dall'overworld");
        this.turn = 'gameover';
        this.input.keyboard.once('keydown-R', () => {
            this.scene.start('OverworldScene', { loadSave: false });
        });
    }
    showMessage(msg) {
        this.messageText.setText(msg);
        this.time.delayedCall(2000, () => this.messageText.setText(''));
    }
    updateUI() {
        this.uiText.setText(`Piano ${this.depth} | HP: ${this.player.hp}/${this.player.maxHp} | Att: ${this.player.attack} | Dif: ${this.player.defense} | Crit: ${Math.floor(this.player.critChance * 100)}% | Skill Pts: ${this.player.skillPoints}`);
    }
}

class SkillTreeScene extends Phaser.Scene {
    constructor() {
        super('SkillTreeScene');
    }
    init(data) {
        this.player = data.player;
    }
    create() {
        this.add.text(200, 50, 'ALBERO DELLE ABILITÀ', { fontSize: '24px', fill: '#fff', fontFamily: 'monospace' });
        let y = 100;
        const skills = [
            new Skill('Forza +1', 'Aumenta attacco di 1', 5, (p, lvl) => p.attack += lvl),
            new Skill('Difesa +1', 'Aumenta difesa di 1', 5, (p, lvl) => p.defense += lvl),
            new Skill('Vitalità +5', 'Aumenta HP max di 5', 5, (p, lvl) => { p.maxHp += 5 * lvl; p.hp += 5 * lvl; }),
            new Skill('Critico +2%', 'Aumenta probabilità critica', 5, (p, lvl) => p.critChance += 0.02 * lvl)
        ];
        this.player.skills = skills;
        for (let skill of skills) {
            this.add.text(50, y, `${skill.name} (liv.${skill.level}/${skill.maxLevel}) - ${skill.description}`, { fill: '#fff', fontFamily: 'monospace' });
            const plusBtn = this.add.text(400, y, '[+]', { fill: '#0f0', fontFamily: 'monospace' }).setInteractive();
            plusBtn.on('pointerdown', () => {
                if (this.player.skillPoints > 0 && skill.level < skill.maxLevel) {
                    skill.level++;
                    this.player.skillPoints--;
                    skill.apply(this.player);
                    this.scene.restart({ player: this.player });
                }
            });
            y += 30;
        }
        this.add.text(50, y + 20, `Punti disponibili: ${this.player.skillPoints}`, { fill: '#ff0', fontFamily: 'monospace' });
        this.add.text(50, y + 50, 'Premi ESC per tornare', { fill: '#aaa', fontFamily: 'monospace' });
        this.input.keyboard.once('keydown-ESC', () => {
            this.scene.stop();
            this.scene.resume('OverworldScene');
        });
    }
}

class CraftingScene extends Phaser.Scene {
    constructor() {
        super('CraftingScene');
    }
    init(data) {
        this.player = data.player;
        this.recipes = [
            new Recipe('Spada di osso', 'weapon', 1, [{ type: 'bone', qty: 3 }], 0),
            new Recipe('Pozione curativa', 'potion', 0, [{ type: 'cloth', qty: 2 }], 0),
            new Recipe('Armatura di cuoio', 'armor', 1, [{ type: 'leather', qty: 4 }], 2)
        ];
    }
    create() {
        this.add.text(200, 20, 'CRAFTING', { fontSize: '24px', fill: '#fff', fontFamily: 'monospace' });
        this.add.text(50, 50, `Materiali: ${this.player.materials.length} pezzi`, { fill: '#ff0', fontFamily: 'monospace' });

        let y = 80;
        this.recipes.forEach((recipe, index) => {
            const color = recipe.canCraft(this.player) ? '#0f0' : '#f00';
            this.add.text(50, y, `${recipe.name} (richiede: ${recipe.materials.map(m => m.type + 'x' + m.qty).join(', ')})`, { fill: color, fontFamily: 'monospace' });
            const craftBtn = this.add.text(400, y, '[CRAFT]', { fill: '#0ff', fontFamily: 'monospace' }).setInteractive();
            craftBtn.on('pointerdown', () => {
                if (recipe.canCraft(this.player)) {
                    const item = recipe.craft(this.player);
                    this.showMessage(`Creato: ${item.type} (rarità ${item.rarity})`);
                    this.scene.restart({ player: this.player });
                } else {
                    this.showMessage("Materiali insufficienti!");
                }
            });
            y += 30;
        });

        this.add.text(50, y + 20, 'Premi ESC per tornare', { fill: '#aaa', fontFamily: 'monospace' });
        this.input.keyboard.once('keydown-ESC', () => {
            this.scene.stop();
            this.scene.resume('OverworldScene');
            const overworld = this.scene.get('OverworldScene');
            if (overworld) overworld.craftingSceneActive = false;
        });
    }
    showMessage(msg) {
        const text = this.add.text(200, 500, msg, { fill: '#ff0', fontFamily: 'monospace' });
        this.time.delayedCall(1500, () => text.destroy());
    }
}

// Configurazione di gioco
const config = {
    type: Phaser.AUTO,
    parent: 'game-container',
    width: 800,
    height: 600,
    pixelArt: true, // utile per mantenere i caratteri nitidi
    scene: [BootScene, OverworldScene, DungeonScene, SkillTreeScene, CraftingScene],
    physics: { default: false }
};

new Phaser.Game(config);
