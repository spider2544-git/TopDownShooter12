const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const { ServerDebugger } = require('./src/server-debug.js');
const { nfcTagManager } = require('./src/NFCTag.js');

// ============================================================================
// SERVER LOGGING CONTROL (performance)
// ============================================================================
// Console spam (especially with lots of entities/events) can be very noisy.
// Default: quiet (no console.log/info/debug/warn). Always keep console.error.
// Enable full logs by starting server with: `SERVER_LOGS=1 npm start`
const SERVER_LOGS = process.env.SERVER_LOGS === '1';
if (!SERVER_LOGS) {
    try {
        const __origLog = console.log.bind(console);
        const __origInfo = console.info.bind(console);
        const __origDebug = console.debug.bind(console);
        const __origWarn = console.warn.bind(console);
        const noop = () => {};

        // Allow a tiny set of important warnings/status messages, rate-limited.
        const allowList = [
            '[NFCTag]',
            '[NFC]',
            '[ShieldWall]', // DEBUG_SHIELDWALL=1 targeted collision diagnostics
            'Game server running on port',
            '[TargetDummy]'
        ];
        const rl = new Map();
        const ok = (key, ms) => {
            const now = Date.now();
            const last = rl.get(key) || 0;
            if (now - last < ms) return false;
            rl.set(key, now);
            return true;
        };
        const allowImportant = (args) => {
            try {
                const msg = (typeof args[0] === 'string') ? args[0] : '';
                if (!msg) return false;
                for (let i = 0; i < allowList.length; i++) {
                    if (msg.includes(allowList[i])) return true;
                }
            } catch (_) {}
            return false;
        };

        console.log = (...args) => {
            if (allowImportant(args) && ok(`log:${String(args[0]).slice(0, 120)}`, 2000)) __origLog(...args);
        };
        console.info = (...args) => {
            if (allowImportant(args) && ok(`info:${String(args[0]).slice(0, 120)}`, 2000)) __origInfo(...args);
        };
        console.debug = noop;
        console.warn = (...args) => {
            if (allowImportant(args) && ok(`warn:${String(args[0]).slice(0, 120)}`, 2000)) __origWarn(...args);
        };
        // Keep console.error for real problems.
    } catch (_) {}
}

// Hard-off debug build flag (performance): keep debug logging/telemetry code in repo, but disable by default.
// Flip to `true` temporarily when diagnosing server issues.
const DEBUG_BUILD = false;

// Import refactored server modules
const { SeededRNG } = require('./src/server/core/seededRNG.js');
const { SERVER_CONFIG } = require('./src/server/core/serverConfig.js');
const { ServerEnvironment, ServerEnvironmentLobby } = require('./src/server/environment/serverEnvironment.js');
const ServerNPCManager = require('./src/server/npc/ServerNPC.js');
const { HordeSpawner, HORDE_CONFIG } = require('./src/server/game/HordeSpawner.js');
const { AmbientSpawner } = require('./src/server/game/AmbientSpawner.js');
const { TroopManager } = require('./src/server/game/TroopManager.js');
const TimerManager = require('./src/server/game/TimerManager.js');
const LootManager = require('./src/server/game/LootManager.js');
const NetworkManager = require('./src/server/game/NetworkManager.js');
const PlayerManager = require('./src/server/game/PlayerManager.js');
const LevelManager = require('./src/server/game/LevelManager.js');
const CombatManager = require('./src/server/game/CombatManager.js');
const PlayerPhysicsManager = require('./src/server/game/PlayerPhysicsManager.js');
const AbilityManager = require('./src/server/game/AbilityManager.js');
const EnemyManager = require('./src/server/game/EnemyManager.js');

// Import game mode system
const GameModeConfigs = require('./src/levels/GameModeConfigs.js');
const LevelConfigs = require('./src/levels/LevelConfigs.js');
const BaseGameMode = require('./src/levels/modes/BaseGameMode.js');
const TestMode = require('./src/levels/modes/TestMode.js');
const ExtractionMode = require('./src/levels/modes/ExtractionMode.js');
const PayloadMode = require('./src/levels/modes/PayloadMode.js');
const TrenchRaidMode = require('./src/levels/modes/TrenchRaidMode.js');
const { EnvironmentHazards } = require('./src/server/environment/EnvironmentHazards.js');

// Import weapon progression config
const { getWeaponProgression, WEAPON_PROGRESSION } = require('./src/weaponProgressionConfig.js');

// Phase 3: Import network protocol for versioned event names and feature flags
const Protocol = require('./src/shared/protocol.js');

// Phase 2: Import RoomContext for passing state to GameRoom methods
const { createRoomContext, validateRoomContext } = require('./src/server/core/RoomContext.js');

// Phase 2: Import handler modules for organized socket event handling
const { createAllHandlers } = require('./src/server/net/handlers/index.js');

// Load client Director logic for server-side enemy movement (window shim)
let DirectorClass = null;
try {
    global.window = {};
    require('./src/director.js');
    DirectorClass = global.window && global.window.Director ? global.window.Director : null;
} catch (e) {
    console.error('[Server] Failed to load Director for server-side enemies:', e && e.message ? e.message : String(e));
} finally {
    try { delete global.window; } catch(_) {}
}

// ========== Imported Classes ==========
// SeededRNG, ServerEnvironment, ServerEnvironmentLobby are now imported from modules


const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Initialize NFC reader for weapon unlocks
nfcTagManager.init(io);

// Serve static files
app.use(express.static(path.join(__dirname)));

// Debug system
const serverDebugger = new ServerDebugger();

// ===== DEBUG FEATURE: TEMPORARY DEBUG CHEST =====
// Set to true to spawn a brown chest with 6 random loot items near each player when level starts
// Set to false to disable debug chest spawning
const ENABLE_DEBUG_CHESTS = false;
// ================================================

// ===== DEBUG FEATURE: HITSCAN LOG SPAM =====
// Set env DEBUG_HITSCAN_LOGS=1 to enable verbose hitscan logs (default: off)
const DEBUG_HITSCAN_LOGS = process.env.DEBUG_HITSCAN_LOGS === '1';
// ==========================================

// Game state management
const rooms = new Map();
const TICK_RATE = SERVER_CONFIG.TICK_RATE;
const BROADCAST_RATE = SERVER_CONFIG.BROADCAST_RATE;
const BROADCAST_RATE_LOW = SERVER_CONFIG.BROADCAST_RATE_LOW;

// ============================================================================
// BINARY MIN-HEAP for A* Pathfinding Optimization
// ============================================================================
// Provides O(log n) insert/extract instead of O(n log n) array.sort()
class BinaryMinHeap {
    constructor(compareFn) {
        this.heap = [];
        this.compare = compareFn || ((a, b) => a - b);
    }
    
    get length() {
        return this.heap.length;
    }
    
    push(item) {
        this.heap.push(item);
        this._bubbleUp(this.heap.length - 1);
    }
    
    pop() {
        if (this.heap.length === 0) return undefined;
        if (this.heap.length === 1) return this.heap.pop();
        
        const min = this.heap[0];
        this.heap[0] = this.heap.pop();
        this._bubbleDown(0);
        return min;
    }
    
    _bubbleUp(index) {
        while (index > 0) {
            const parentIndex = Math.floor((index - 1) / 2);
            if (this.compare(this.heap[index], this.heap[parentIndex]) >= 0) break;
            
            // Swap
            const temp = this.heap[index];
            this.heap[index] = this.heap[parentIndex];
            this.heap[parentIndex] = temp;
            index = parentIndex;
        }
    }
    
    _bubbleDown(index) {
        while (true) {
            const leftChild = 2 * index + 1;
            const rightChild = 2 * index + 2;
            let smallest = index;
            
            if (leftChild < this.heap.length && 
                this.compare(this.heap[leftChild], this.heap[smallest]) < 0) {
                smallest = leftChild;
            }
            
            if (rightChild < this.heap.length && 
                this.compare(this.heap[rightChild], this.heap[smallest]) < 0) {
                smallest = rightChild;
            }
            
            if (smallest === index) break;
            
            // Swap
            const temp = this.heap[index];
            this.heap[index] = this.heap[smallest];
            this.heap[smallest] = temp;
            index = smallest;
        }
    }
}

// ============================================================================
// Trench Raid: Funnel ("V") keepout generation (V2: segment-based)
// ============================================================================
// Replaces the old endpoint-only heuristic with a robust detector:
// - Finds walls whose long-axis centerline segments are close OR intersect
// - Builds a keepout "wedge blocker" inside the acute angle between them
//
// This stops units from entering dead funnel pockets, and it also affects the
// Trench Raid navmesh because nav grid uses env.circleHitsAny (includes OBBs).
function addTrenchFunnelKeepouts(orientedBoxes, opts = {}) {
    if (!Array.isArray(orientedBoxes) || orientedBoxes.length < 2) return 0;
    const trenchWalls = orientedBoxes.filter(b => b && b.isTrenchWall);
    if (trenchWalls.length < 2) return 0;

    const clamp = (v, a, b) => (v < a ? a : (v > b ? b : v));
    const norm = (x, y) => {
        const d = Math.hypot(x, y);
        return d > 1e-6 ? { x: x / d, y: y / d, d } : { x: 0, y: 0, d: 0 };
    };

    // Centerline segment endpoints along the wall's long axis (w)
    const centerline = (w) => {
        const ang = Number.isFinite(w.angle) ? w.angle : 0;
        const len = Math.max(1, Number.isFinite(w.w) ? w.w : 1);
        const ux = Math.cos(ang), uy = Math.sin(ang);
        const hx = ux * (len * 0.5), hy = uy * (len * 0.5);
        return { ax: w.x - hx, ay: w.y - hy, bx: w.x + hx, by: w.y + hy, ux, uy };
    };

    const closestPointOnSegment = (px, py, ax, ay, bx, by) => {
        const abx = bx - ax, aby = by - ay;
        const apx = px - ax, apy = py - ay;
        const ab2 = abx * abx + aby * aby;
        const t = ab2 > 1e-8 ? clamp((apx * abx + apy * aby) / ab2, 0, 1) : 0;
        return { x: ax + abx * t, y: ay + aby * t, t };
    };

    // Segment intersection (returns point if intersects; else null)
    const segmentIntersect = (ax, ay, bx, by, cx, cy, dx, dy) => {
        const rX = bx - ax, rY = by - ay;
        const sX = dx - cx, sY = dy - cy;
        const denom = rX * sY - rY * sX;
        if (Math.abs(denom) < 1e-8) return null; // parallel/collinear
        const qpx = cx - ax, qpy = cy - ay;
        const t = (qpx * sY - qpy * sX) / denom;
        const u = (qpx * rY - qpy * rX) / denom;
        if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
            return { x: ax + t * rX, y: ay + t * rY };
        }
        return null;
    };

    // Tunables
    const NEAR_DIST = Number.isFinite(opts.nearDist) ? opts.nearDist : 170;      // catches mid-segment overlaps
    const MIN_V_ANGLE_DEG = Number.isFinite(opts.minVAngleDeg) ? opts.minVAngleDeg : 10;
    const MAX_V_ANGLE_DEG = Number.isFinite(opts.maxVAngleDeg) ? opts.maxVAngleDeg : 105; // allow wider Vs
    const KEEPOUT_DEPTH = Number.isFinite(opts.keepoutDepth) ? opts.keepoutDepth : 420;
    const KEEPOUT_WIDTH = Number.isFinite(opts.keepoutWidth) ? opts.keepoutWidth : 280;
    const APEX_PUSH = Number.isFinite(opts.apexPush) ? opts.apexPush : 30;      // keeps keepout from sitting exactly on crossing

    const minVAngle = (MIN_V_ANGLE_DEG * Math.PI) / 180;
    const maxVAngle = (MAX_V_ANGLE_DEG * Math.PI) / 180;

    let added = 0;

    for (let i = 0; i < trenchWalls.length; i++) {
        const A = trenchWalls[i];
        const a = centerline(A);
        const uA = norm(a.ux, a.uy);

        for (let j = i + 1; j < trenchWalls.length; j++) {
            const B = trenchWalls[j];
            const b = centerline(B);
            const uB = norm(b.ux, b.uy);

            // Find closest points between centerline segments (intersection wins)
            let pA = null, pB = null, dMin = Infinity;
            const inter = segmentIntersect(a.ax, a.ay, a.bx, a.by, b.ax, b.ay, b.bx, b.by);
            if (inter) {
                pA = inter; pB = inter; dMin = 0;
            } else {
                // Endpoints of A -> B
                const c1 = closestPointOnSegment(a.ax, a.ay, b.ax, b.ay, b.bx, b.by);
                const d1 = Math.hypot(a.ax - c1.x, a.ay - c1.y);
                if (d1 < dMin) { dMin = d1; pA = { x: a.ax, y: a.ay }; pB = { x: c1.x, y: c1.y }; }
                const c2 = closestPointOnSegment(a.bx, a.by, b.ax, b.ay, b.bx, b.by);
                const d2 = Math.hypot(a.bx - c2.x, a.by - c2.y);
                if (d2 < dMin) { dMin = d2; pA = { x: a.bx, y: a.by }; pB = { x: c2.x, y: c2.y }; }

                // Endpoints of B -> A
                const c3 = closestPointOnSegment(b.ax, b.ay, a.ax, a.ay, a.bx, a.by);
                const d3 = Math.hypot(b.ax - c3.x, b.ay - c3.y);
                if (d3 < dMin) { dMin = d3; pA = { x: c3.x, y: c3.y }; pB = { x: b.ax, y: b.ay }; }
                const c4 = closestPointOnSegment(b.bx, b.by, a.ax, a.ay, a.bx, a.by);
                const d4 = Math.hypot(b.bx - c4.x, b.by - c4.y);
                if (d4 < dMin) { dMin = d4; pA = { x: c4.x, y: c4.y }; pB = { x: b.bx, y: b.by }; }
            }

            if (!pA || !pB) continue;
            if (dMin > NEAR_DIST) continue;

            // Choose directions along each wall that form the "inside" acute angle.
            // For each wall, we can go +u or -u; pick combination with max dot (smallest angle).
            const candidates = [
                { ax: uA.x, ay: uA.y, bx: uB.x, by: uB.y },
                { ax: uA.x, ay: uA.y, bx: -uB.x, by: -uB.y },
                { ax: -uA.x, ay: -uA.y, bx: uB.x, by: uB.y },
                { ax: -uA.x, ay: -uA.y, bx: -uB.x, by: -uB.y }
            ];
            let best = null;
            for (const c of candidates) {
                const dot = c.ax * c.bx + c.ay * c.by;
                if (!best || dot > best.dot) best = { ...c, dot };
            }
            if (!best) continue;

            const dot = clamp(best.dot, -1, 1);
            const ang = Math.acos(dot);
            if (ang < minVAngle || ang > maxVAngle) continue;

            const bis = norm(best.ax + best.bx, best.ay + best.by);
            if (bis.d < 1e-6) continue;

            // Apex is midpoint of closest points (works for both intersection and near-miss)
            const apexX = (pA.x + pB.x) * 0.5;
            const apexY = (pA.y + pB.y) * 0.5;

            // Place the keepout a bit inside the wedge so it blocks the pocket.
            const centerX = apexX + bis.x * (APEX_PUSH + KEEPOUT_DEPTH * 0.5);
            const centerY = apexY + bis.y * (APEX_PUSH + KEEPOUT_DEPTH * 0.5);
            const keepAngle = Math.atan2(bis.y, bis.x);

            orientedBoxes.push({
                x: centerX,
                y: centerY,
                w: KEEPOUT_DEPTH,
                h: KEEPOUT_WIDTH,
                angle: keepAngle,
                isTrenchKeepout: true
            });
            added++;
        }
    }

    return added;
}

// Room class to manage game state
class GameRoom {
    constructor(roomId) {
        this.id = roomId;
        // Reference to the global rooms registry (used by extracted managers)
        this.rooms = rooms;
        this.players = new Map();
        this.lastTick = Date.now();
        this.tickCount = 0;
        this.boundary = 1000; // default to lobby boundary, updated when players join
        this.scene = 'lobby'; // default scene type
        this.levelType = 'extraction'; // SERVER-AUTHORITATIVE level type - all players must use this
        this.levelTypeSetBy = null; // Track who set the level
        this.currentGameMode = null; // Active game mode instance
        
        // Generate deterministic world seed for synchronized world generation
        this.worldSeed = Math.floor(Math.random() * 1000000000);
        console.log(`[SEED] Generated world seed for room "${roomId}":`, this.worldSeed);

        // ===== NAVMESH DEBUG (Trench Raid) =====
        // Precomputed once per (worldSeed, levelType) during lobby ready timer.
        this._navDebug = null;              // { cellSize, minX, minY, w, h, rowsRLE }
        this._navDebugKey = null;           // `${worldSeed}:${levelType}`
        this._precomputedTrenchWalls = null; // Stored to keep trench wall generation consistent between precompute and level start
        this._navDecodedGrid = null;        // OPTIMIZATION: Cached decoded grid to avoid repeated RLE decoding
        // ======================================
        
        // IMPORTANT: Instantiate managers BEFORE using them in constructor
        // Level manager must be created before _createEnvironmentForScene is called
        this.levelManager = new LevelManager(this, io);
        
        // Combat manager (bullets, DOTs, pools, death) - Phase 6 extraction
        this.combatManager = new CombatManager(this, io, getWeaponProgression);
        
        // Player physics manager (stamina, movement, collision, breadcrumbs) - Phase 7 extraction
        this.playerPhysicsManager = new PlayerPhysicsManager(this, io, getWeaponProgression, serverDebugger);
        
        // Ability manager (shield walls, turrets, mines, healing boxes, attractors) - Phase 8 extraction
        this.abilityManager = new AbilityManager(this, io);
        
        // Enemy manager (AI, pathfinding, boss behavior, combat) - Phase 9 extraction (FINAL!)
        this.enemyManager = new EnemyManager(this, io, DirectorClass);
        
        // Create server-side environment for collision detection based on scene
        this.environment = this._createEnvironmentForScene(this.scene);
        console.log(`[ROOM] Created server environment for scene "${this.scene}" with ${this.environment.obstacles.length} obstacles, boundary: ${this.boundary}`);
        
        // Server-side abilities (shield walls, turrets, etc.) for collision/pathfinding
        this.abilities = new Map(); // serverId -> { type, data, obstacleIndex, createdAt, expiresAt }
        
        // Ready timer state synchronization
        this.readyTimer = {
            started: false,
            completed: false,
            timeTotal: 10.0,
            timeLeft: 0,
            startedBy: null
        };

        // Extraction zone timer state synchronization
        this.extractionTimer = {
            started: false,
            extracted: false,
            timeTotal: 60.0,
            timeLeft: 0,
            startedBy: null,
            type: 'normal' // 'normal' or 'heretic'
        };

        // Chest state per room: id -> { id, x, y, variant, opening, opened, timeTotal, timeLeft, startedBy, drops }
        this.chests = new Map();
        
        // Server-authoritative ground items (inventory drops) per room
        this.groundItems = new Map(); // id -> { id, x, y, vx, vy, label, rarityName, color }
        this.nextItemId = 1;
        
        // Environment Hazards (initialized per level when enabled)
        this.hazards = null;
        // Lobby: initialize a tiny hazards manager so the training-range fence sandbags
        // are real breakable hazard sandbags (same damage/break behavior as Trench Raid).
        if (this.scene === 'lobby') {
            try {
                this.hazards = new EnvironmentHazards(this, this.environment, {}, 'test'); // config disabled; we add hazards manually
                // Add 2 vertical hazard sandbags as the shooting-lane fence
                const fenceX = -375;
                const fenceTopY = -974;
                const sbW = 48;
                const sbH = 220;
                const hpMax = 300;
                const addFenceSandbag = (x, y, idx) => {
                    const sb = {
                        id: `lobby_fence_sandbag_${idx}`,
                        x,
                        y,
                        w: sbW,
                        h: sbH,
                        angle: 0,
                        variant: 'vertical',
                        health: hpMax,
                        healthMax: hpMax,
                        boxIndex: -1
                    };
                    const oBox = { x: sb.x, y: sb.y, w: sb.w, h: sb.h, angle: 0 };
                    sb.boxIndex = (this.environment.orientedBoxes = this.environment.orientedBoxes || []).push(oBox) - 1;
                    this.hazards.sandbags.push(sb);
                };
                addFenceSandbag(fenceX, fenceTopY + sbH / 2, 1);
                addFenceSandbag(fenceX, fenceTopY + sbH + sbH / 2, 2);
                console.log('[LobbyHazards] Initialized breakable fence sandbags:', this.hazards.sandbags.length);
            } catch (e) {
                console.warn('[LobbyHazards] Failed to initialize lobby hazard sandbags:', e && e.message ? e.message : String(e));
                this.hazards = null;
            }
        }
        
        // Server-authoritative ambient NPCs for lobby
        this.ambientNpcs = [];
        this.ambientSpawned = false; // Prevent race condition on concurrent joins
        
        // Server-authoritative player bullets for PvP friendly fire
        this.playerBullets = [];
        
        // Server-authoritative level spawns (chests, npc placements)
        this.levelSpawns = null;
        
        // Server-authoritative enemies (spawn locations only for now)
        this.enemies = new Map(); // id -> { id, x, y, type }
        this.nextEnemyId = 1;

        // Enemy networking/movement mode (authoritative once in level)
        this.enemyNetMode = 'spawnOnly'; // 'spawnOnly' | 'authoritative'
        this.ENEMY_BROADCAST_HZ = SERVER_CONFIG.ENEMY_BROADCAST_HZ;
        this._enemyBroadcastIntervalMs = 1000 / this.ENEMY_BROADCAST_HZ;
        this._nextEnemyBroadcastTime = 0;
        
        // Server-authoritative extraction zones and boss spawn (computed on artifact pickup)
        this.extractionZone = null; // { x, y, size }
        this.hereticExtractionZone = null; // { x, y, size }
        this.bossSpawn = null; // { x, y }
        this._enemyDirectors = new Map(); // playerId -> Director instance
        this._enemyTroopDirectorsMelee = new Map(); // troopId -> Director instance (troop-target melee slotting)
        this._enemyTroopDirectorsRanged = new Map(); // troopId -> Director instance (troop-target ranged slotting)
        this._enemyIdMap = new Map(); // serverId (string) -> numeric id for Director
        this._enemyIdCounter = 1;
        // Ambient debug tracking
        this._ambientDebug = { spawnedTotal: 0, lastSpawnLog: 0 };
        
        // Active boomer puke pools in the room (server-authoritative)
        // Each: { x, y, radius, ttl }
        this.boomerPools = [];
        
        // Active enemy projectiles in the room (server-authoritative)
        // Each: { x, y, vx, vy, radius, damage, life, maxLife }
        this.enemyProjectiles = [];
        
        // Store io reference for managers that need it
        this.io = io;
        
        // Server-authoritative NPC manager
        this.npcManager = new ServerNPCManager(this, io);
        
        // Server-authoritative Troop manager (allied units)
        this.troopManager = new TroopManager(this, io);
        
        // Timer manager (ready timer and extraction timer) - Phase 1 extraction
        this.timerManager = new TimerManager(this);
        
        // Loot manager (chests, ground items, shop) - Phase 2 extraction
        this.lootManager = new LootManager(this);
        
        // Network manager (broadcasts, state synchronization) - Phase 3 extraction
        this.networkManager = new NetworkManager(this, io);
        
        // Player manager (join/leave, stats, spawning) - Phase 4 extraction
        this.playerManager = new PlayerManager(this, io);
        
        // Merchant shop
        this.shopInventory = [];
        this._shopNeedsRefresh = true; // Refresh on first player join or mission return
        
        // Mission accomplishment tracking for Victory Points
        this.missionAccomplishments = {
            artilleryWitchKilled: false,
            prisonerMissionSuccess: false,
            hereticPriestKilled: false,
            radioTowerPowered: false,
            extractedBeforeArtillery: false,
            artifactFinalHealth: null,
            artifactHealthMax: null
        };
        
        // Frozen artillery elapsed time (set on extraction complete to stop timer ticking)
        this.artilleryFrozenElapsedMs = null;
        
        // Flag to stop enemy AI/targeting when mission ends (win or lose)
        this.missionEnded = false;
        
        // Track when level started for artillery barrage timer (9 minute delay)
        this.levelStartTime = null;
        this.artilleryBonusTimeMs = 0; // Bonus time added when RadioTower powered
        
        // Start room simulation loop with drift-aware scheduling
        this._destroyed = false;
        this._tickIntervalMs = 1000 / TICK_RATE;
        this._broadcastIntervalMs = 1000 / BROADCAST_RATE;
        this._tickHandle = null;
        this._broadcastHandle = null;
        this._nextTickTime = null;
        this._nextBroadcastTime = null;
        
        // Delta state tracking for bandwidth optimization (Phase 2)
        this._lastBroadcastState = new Map(); // playerId -> last sent state
        this._fullStateBroadcastCounter = 0;
        this._fullStateBroadcastInterval = 10; // Send full state every 10 frames for reliability
        
        // Low-priority broadcast loop for non-critical data (Phase 2.3)
        this._lowPriorityBroadcastIntervalMs = 1000 / BROADCAST_RATE_LOW;
        this._lowPriorityBroadcastHandle = null;
        this._nextLowPriorityBroadcastTime = null;
        
        // Revive system (per-target channel; multiple targets can be revived concurrently)
        // Map<targetPlayerId, { targetId, reviverId, startedAt, endsAt, lastEmitAt }>
        this._activeRevivesByTarget = new Map();

        this.tick();
        this._nextTickTime = Date.now() + this._tickIntervalMs;
        this._scheduleTickLoop();

        this._nextBroadcastTime = Date.now() + this._broadcastIntervalMs;
        this._scheduleBroadcastLoop();
        
        this._nextLowPriorityBroadcastTime = Date.now() + this._lowPriorityBroadcastIntervalMs;
        this._scheduleLowPriorityBroadcastLoop();

        this.hordeSpawner = new HordeSpawner(this);
        this.ambientSpawner = new AmbientSpawner(this);
    }

    _scheduleTickLoop() {
        if (this._destroyed) return;
        const run = () => {
            this._tickHandle = null;
            if (this._destroyed) return;
            this.tick();
            const now = Date.now();
            if (!Number.isFinite(this._nextTickTime)) {
                this._nextTickTime = now + this._tickIntervalMs;
            }
            while (this._nextTickTime <= now) {
                this._nextTickTime += this._tickIntervalMs;
            }
            const delay = Math.max(0, this._nextTickTime - now);
            this._tickHandle = setTimeout(run, delay);
        };
        const delay = Math.max(0, this._nextTickTime - Date.now());
        this._tickHandle = setTimeout(run, delay);
    }

    _scheduleBroadcastLoop() {
        if (this._destroyed) return;
        const run = () => {
            this._broadcastHandle = null;
            if (this._destroyed) return;
            this.broadcastGameState();
            const now = Date.now();
            if (!Number.isFinite(this._nextBroadcastTime)) {
                this._nextBroadcastTime = now + this._broadcastIntervalMs;
            }
            while (this._nextBroadcastTime <= now) {
                this._nextBroadcastTime += this._broadcastIntervalMs;
            }
            const delay = Math.max(0, this._nextBroadcastTime - now);
            this._broadcastHandle = setTimeout(run, delay);
        };
        const delay = Math.max(0, this._nextBroadcastTime - Date.now());
        this._broadcastHandle = setTimeout(run, delay);
    }
    
    _scheduleLowPriorityBroadcastLoop() {
        if (this._destroyed) return;
        const run = () => {
            this._lowPriorityBroadcastHandle = null;
            if (this._destroyed) return;
            this.broadcastLowPriorityState();
            const now = Date.now();
            if (!Number.isFinite(this._nextLowPriorityBroadcastTime)) {
                this._nextLowPriorityBroadcastTime = now + this._lowPriorityBroadcastIntervalMs;
            }
            while (this._nextLowPriorityBroadcastTime <= now) {
                this._nextLowPriorityBroadcastTime += this._lowPriorityBroadcastIntervalMs;
            }
            const delay = Math.max(0, this._nextLowPriorityBroadcastTime - now);
            this._lowPriorityBroadcastHandle = setTimeout(run, delay);
        };
        const delay = Math.max(0, this._nextLowPriorityBroadcastTime - Date.now());
        this._lowPriorityBroadcastHandle = setTimeout(run, delay);
    }

    /* COMMENTED OUT - Now using PlayerManager (Phase 4)
    sendRoomSnapshot(socket) {
        if (!socket) return;
        // Filter orientedBoxes: exclude sandbag collision boxes (they'll be re-created client-side from hazardsState)
        // Only send trench walls, shield walls, and other boxes that need visual rendering
        const clientOrientedBoxes = (this.environment?.orientedBoxes || []).filter(box => {
            // Keep boxes that have rendering data (trench walls with fill/stroke) or ability markers (shield walls)
            return box.fill || box.stroke || box._abilityId;
        });
        
        socket.emit('roomSnapshot', {
            boundary: this.boundary,
            scene: this.scene,
            levelType: this.levelType, // SERVER-AUTHORITATIVE level selection
            obstacles: this.environment?.obstacles || [],
            orientedBoxes: clientOrientedBoxes,
            readyTimer: {
                started: this.readyTimer.started,
                completed: this.readyTimer.completed,
                timeLeft: this.readyTimer.timeLeft,
                timeTotal: this.readyTimer.timeTotal,
                startedBy: this.readyTimer.startedBy
            },
            groundItems: Array.from(this.groundItems.values()),
            ambientNpcs: this.ambientNpcs,
            levelSpawns: this.levelSpawns,
            enemies: Array.from(this.enemies.values())
        });
        // Ensure late joiners receive current hazards (including lobby fence sandbags)
        try {
            if (this.hazards) socket.emit('hazardsState', this.hazards.serialize());
        } catch (_) {}
    }
    */ // END sendRoomSnapshot

    // =========================================
    // TIMER MANAGER DELEGATION (Phase 1)
    // =========================================
    emitReadyTimerState(targetSocket) {
        return this.timerManager.emitReadyTimerState(targetSocket);
    }
    
    startReadyTimer(startedByPlayerId, levelType) {
        return this.timerManager.startReadyTimer(startedByPlayerId, levelType);
    }
    
    cancelReadyTimer() {
        return this.timerManager.cancelReadyTimer();
    }
    
    updateReadyTimer(deltaTime) {
        return this.timerManager.updateReadyTimer(deltaTime);
    }
    
    startExtractionTimer(startedByPlayerId, timerType) {
        return this.timerManager.startExtractionTimer(startedByPlayerId, timerType);
    }
    
    cancelExtractionTimer() {
        return this.timerManager.cancelExtractionTimer();
    }
    
    updateExtractionTimer(deltaTime) {
        return this.timerManager.updateExtractionTimer(deltaTime);
    }
    
    emitExtractionTimerState(targetSocket) {
        return this.timerManager.emitExtractionTimerState(targetSocket);
    }
    
    // =========================================
    // LOOT MANAGER DELEGATION (Phase 2)
    // =========================================
    
    // Utility helpers
    _rng(seed) {
        return this.lootManager._rng(seed);
    }
    
    _hashChestId(id) {
        return this.lootManager._hashChestId(id);
    }
    
    // Chest loot generation
    _generateBrownDrops(chestId, dropCount) {
        return this.lootManager._generateBrownDrops(chestId, dropCount);
    }
    
    _generateStartingGearDrops(chestId, dropCount) {
        return this.lootManager._generateStartingGearDrops(chestId, dropCount);
    }
    
    _spawnDebugChestsNearPlayers() {
        return this.lootManager._spawnDebugChestsNearPlayers();
    }
    
    _computeStatBonus(label, rarityName) {
        return this.lootManager._computeStatBonus(label, rarityName);
    }
    
    _generateBossLoot(enemyId) {
        return this.lootManager._generateBossLoot(enemyId);
    }
    
    _generateEnemyDrops(enemyId, enemyType) {
        return this.lootManager._generateEnemyDrops(enemyId, enemyType);
    }
    
    // Ground item positioning
    findClearGroundPosition(baseX, baseY, angle, itemRadius, maxAttempts) {
        return this.lootManager.findClearGroundPosition(baseX, baseY, angle, itemRadius, maxAttempts);
    }
    
    // Shop methods
    _generateShopInventory() {
        return this.lootManager._generateShopInventory();
    }
    
    _createSeededRNG(seed) {
        return this.lootManager._createSeededRNG(seed);
    }
    
    refreshShopIfNeeded() {
        return this.lootManager.refreshShopIfNeeded();
    }
    
    markShopForRefresh() {
        return this.lootManager.markShopForRefresh();
    }
    
    getShopInventory() {
        return this.lootManager.getShopInventory();
    }
    
    purchaseShopItem(socketId, itemIndex) {
        return this.lootManager.purchaseShopItem(socketId, itemIndex);
    }
    
    // =========================================
    // NETWORK MANAGER DELEGATION (Phase 3)
    // =========================================
    
    // State getter methods
    getGameState() {
        return this.networkManager.getGameState();
    }
    
    getGameStateDelta() {
        return this.networkManager.getGameStateDelta();
    }
    
    _getEnemiesStatePayload() {
        return this.networkManager._getEnemiesStatePayload();
    }
    
    _getEnemiesStatePayloadForInterest(px, py, r2) {
        return this.networkManager._getEnemiesStatePayloadForInterest(px, py, r2);
    }
    
    _getEntitiesStatePayload() {
        return this.networkManager._getEntitiesStatePayload();
    }
    
    _getEntitiesStatePayloadForInterest(px, py, r2) {
        return this.networkManager._getEntitiesStatePayloadForInterest(px, py, r2);
    }
    
    // Broadcast methods
    broadcastGameState() {
        return this.networkManager.broadcastGameState();
    }
    
    broadcastLowPriorityState() {
        return this.networkManager.broadcastLowPriorityState();
    }
    
    broadcastEnemiesState() {
        return this.networkManager.broadcastEnemiesState();
    }
    
    broadcastAmbientNpcs() {
        return this.networkManager.broadcastAmbientNpcs();
    }
    
    // =========================================
    // PLAYER MANAGER DELEGATION (Phase 4)
    // =========================================
    
    addPlayer(socket, playerData) {
        return this.playerManager.addPlayer(socket, playerData);
    }
    
    recalculatePlayerStats(player) {
        return this.playerManager.recalculatePlayerStats(player);
    }
    
    removePlayer(socketId) {
        return this.playerManager.removePlayer(socketId);
    }
    
    generateRandomSpawnPosition(seed) {
        return this.playerManager.generateRandomSpawnPosition(seed);
    }
    
    sendRoomSnapshot(socket) {
        return this.playerManager.sendRoomSnapshot(socket);
    }
    
    // =========================================
    // LEVEL MANAGER DELEGATION (Phase 5)
    // =========================================
    
    setLevelType(playerId, levelType) {
        return this.levelManager.setLevelType(playerId, levelType);
    }
    
    getModeClass(levelType) {
        return this.levelManager.getModeClass(levelType);
    }
    
    _createEnvironmentForScene(scene) {
        return this.levelManager._createEnvironmentForScene(scene);
    }
    
    spawnLobbyTargetDummy(count) {
        return this.levelManager.spawnLobbyTargetDummy(count);
    }
    
    _precomputeTrenchRaidNavDebug() {
        return this.levelManager._precomputeTrenchRaidNavDebug();
    }
    
    _buildNavGridDebug(env) {
        return this.levelManager._buildNavGridDebug(env);
    }
    
    _initNavProperties(entity) {
        return this.levelManager._initNavProperties(entity);
    }
    
    resetToLobby() {
        return this.levelManager.resetToLobby();
    }
    
    _legacyComputeLevelSpawns() {
        return this.levelManager._legacyComputeLevelSpawns();
    }
    
    _legacyComputeEnemySpawns() {
        return this.levelManager._legacyComputeEnemySpawns();
    }
    
    _computeExtractionAndBossSpawns() {
        return this.levelManager._computeExtractionAndBossSpawns();
    }
    
    // =========================================
    // COMBAT MANAGER DELEGATION (Phase 6)
    // =========================================
    
    _handlePlayerDeath(pid, player, io) {
        return this.combatManager._handlePlayerDeath(pid, player, io);
    }
    
    updatePlayerDots(deltaTime) {
        return this.combatManager.updatePlayerDots(deltaTime);
    }
    
    updatePlayerBullets(deltaTime) {
        return this.combatManager.updatePlayerBullets(deltaTime);
    }
    
    updateBoomerPools(deltaTime) {
        return this.combatManager.updateBoomerPools(deltaTime);
    }
    
    _clearLickerEnsnareOnDeath(enemyId, enemyType) {
        return this.combatManager._clearLickerEnsnareOnDeath(enemyId, enemyType);
    }
    
    // =========================================
    // PLAYER PHYSICS MANAGER DELEGATION (Phase 7)
    // =========================================
    
    updatePlayerStamina(player, input, deltaTime) {
        return this.playerPhysicsManager.updatePlayerStamina(player, input, deltaTime);
    }
    
    updatePlayerMovement(player, input, deltaTime) {
        return this.playerPhysicsManager.updatePlayerMovement(player, input, deltaTime);
    }
    
    updateBreadcrumbs(player, beforePos, afterPos) {
        return this.playerPhysicsManager.updateBreadcrumbs(player, beforePos, afterPos);
    }
    
    _simplifyBreadcrumbPath(breadcrumbs) {
        return this.playerPhysicsManager._simplifyBreadcrumbPath(breadcrumbs);
    }
    
    _hasLineOfSight(pointA, pointB) {
        return this.playerPhysicsManager._hasLineOfSight(pointA, pointB);
    }
    
    // =========================================
    // ABILITY MANAGER DELEGATION (Phase 8)
    // =========================================
    
    updateAbilities(now, deltaTime) {
        return this.abilityManager.updateAbilities(now, deltaTime);
    }
    
    // =========================================
    // ENEMY MANAGER DELEGATION (Phase 9 - FINAL PHASE!)
    // =========================================
    
    updateEnemies(deltaTime) {
        return this.enemyManager.updateEnemies(deltaTime);
    }
    
    _updateNavmeshMovement(deltaTime) {
        return this.enemyManager._updateNavmeshMovement(deltaTime);
    }
    
    _updateEnemySandbagBreaking(deltaTime) {
        return this.enemyManager._updateEnemySandbagBreaking(deltaTime);
    }
    
    _findClosestPlayer(x, y) {
        return this.enemyManager._findClosestPlayer(x, y);
    }
    
    _executeBigBoyDash(enemy) {
        return this.enemyManager._executeBigBoyDash(enemy);
    }
    
    _broadcastEnemyDashWindup(enemyId, targetPlayerId) {
        return this.enemyManager._broadcastEnemyDashWindup(enemyId, targetPlayerId);
    }
    
    _broadcastEnemyDash(enemyId, targetPlayerId, dirX, dirY) {
        return this.enemyManager._broadcastEnemyDash(enemyId, targetPlayerId, dirX, dirY);
    }
    
    _scheduleArtilleryStrike(boss, tx, ty, delay, io) {
        return this.enemyManager._scheduleArtilleryStrike(boss, tx, ty, delay, io);
    }
    
    _scheduleArtilleryGunStrike(gun, tx, ty, delay, io) {
        return this.enemyManager._scheduleArtilleryGunStrike(gun, tx, ty, delay, io);
    }
    
    _findPath(nav, startX, startY, goalX, goalY) {
        return this.enemyManager._findPath(nav, startX, startY, goalX, goalY);
    }
    
    _decodeNavRow(rle, width) {
        return this.enemyManager._decodeNavRow(rle, width);
    }
    
    spawnLobbyAmbientNpcs() {
        return this.enemyManager.spawnLobbyAmbientNpcs();
    }
    
    // =========================================
    // OLD TIMER METHODS (commented out for Phase 1 rollback safety)
    // =========================================
    /* emitReadyTimerState(targetSocket) {
        const payload = {
            started: this.readyTimer.started,
            completed: this.readyTimer.completed,
            timeLeft: this.readyTimer.timeLeft,
            timeTotal: this.readyTimer.timeTotal,
            startedBy: this.readyTimer.startedBy
        };
        if (targetSocket) targetSocket.emit('readyTimerUpdate', payload);
        else io.to(this.id).emit('readyTimerUpdate', payload);
    } */

    /* COMMENTED OUT - Now using LevelManager (Phase 5)
    setLevelType(playerId, levelType) {
        // Validate level type
        const validTypes = ['extraction', 'test', 'payload', 'trenchraid'];
        if (!validTypes.includes(levelType)) {
            console.warn(`[Server] Invalid level type: ${levelType}, defaulting to extraction`);
            levelType = 'extraction';
        }
        
        this.levelType = levelType;
        this.levelTypeSetBy = playerId;
        console.log(`[Server] Level type set to "${levelType}" by player ${playerId} in room ${this.id}`);
        
        // Precompute navmesh for Trench Raid as soon as it's selected (not on ready timer)
        if (levelType === 'trenchraid' && this.scene === 'lobby' && !this._navDebug) {
            console.log('[NavMesh] Trench Raid selected, precomputing navmesh now...');
            try {
                this._precomputeTrenchRaidNavDebug();
            } catch (e) {
                console.warn('[NavMesh] Precompute failed:', e && e.message ? e.message : String(e));
            }
        }
        
        // Broadcast to all players in the room
        io.to(this.id).emit('levelTypeSync', {
            levelType: this.levelType,
            setBy: this.levelTypeSetBy
        });
    }
    */ // END setLevelType

    /* COMMENTED OUT - Now using LevelManager (Phase 5)
    getModeClass(levelType) {
        // Factory pattern to get mode class by level type
        const modes = {
            'test': TestMode,
            'extraction': ExtractionMode,
            'payload': PayloadMode,
            'trenchraid': TrenchRaidMode
        };
        return modes[levelType] || TestMode; // Default to TestMode if unknown
    }
    */ // END getModeClass

    /* COMMENTED OUT - Now using NetworkManager (Phase 3)
    broadcastAmbientNpcs() {
        io.to(this.id).emit('ambientNpcsSync', this.ambientNpcs);
    }
    */

    // Target dummy movement (ping-pong motion for lobby shooting gallery)
    updateTargetDummy(deltaTime) {
        if (this.scene !== 'lobby') return;
        
        // Update all target dummies that have movement data
        for (const enemy of this.enemies.values()) {
            if (!enemy || enemy.type !== 'targetDummy' || !enemy._move || enemy.alive === false) continue;
            
            const m = enemy._move;
            
            // Handle pause at lane endpoints
            if (m.wait > 0) {
                m.wait -= deltaTime;
                if (m.wait <= 0) {
                    m.wait = 0;
                    m.dir *= -1; // Resume movement in opposite direction
                }
                continue;
            }
            
            // Move along the specified axis
            const distance = m.speed * deltaTime;
            const axis = m.axis;
            const pos = axis === 'x' ? enemy.x : enemy.y;
            const newPos = pos + (m.dir * distance);
            
            // Check bounds and reverse if needed
            if (m.dir > 0 && newPos >= m.max) {
                // Hit max bound
                if (axis === 'x') enemy.x = m.max;
                else enemy.y = m.max;
                m.wait = m.pause; // Pause at endpoint
            } else if (m.dir < 0 && newPos <= m.min) {
                // Hit min bound
                if (axis === 'x') enemy.x = m.min;
                else enemy.y = m.min;
                m.wait = m.pause; // Pause at endpoint
            } else {
                // Normal movement within bounds
                if (axis === 'x') enemy.x = newPos;
                else enemy.y = newPos;
            }
            
            // Ensure within environment bounds and not colliding with obstacles
            try {
                const env = this.environment;
                if (env && env.isInsideBounds && !env.isInsideBounds(enemy.x, enemy.y, enemy.radius + (m.gap || 0))) {
                    // Snap back to valid position
                    if (axis === 'x') enemy.x = pos;
                    else enemy.y = pos;
                    m.wait = m.pause;
                    m.dir *= -1;
                }
            } catch(_) {}
        }
    }

    /* COMMENTED OUT - Now using AbilityManager (Phase 8)
    updateAbilities(now, deltaTime) {
        if (this.abilities.size === 0) return;
        
        // Check for expired abilities
        const expired = [];
        for (const [abilityId, ability] of this.abilities) {
            if (ability.expiresAt !== null && now >= ability.expiresAt) {
                expired.push(abilityId);
            }
        }
        
        // Remove expired abilities from environment and tracking
        for (const abilityId of expired) {
            const ability = this.abilities.get(abilityId);
            if (!ability) continue;
            
            // Handle different ability types
            if (ability.type === 'ShieldWall') {
                // Remove oriented box from environment
                if (this.environment && this.environment.orientedBoxes) {
                    const boxIdx = this.environment.orientedBoxes.findIndex(box => box._abilityId === abilityId);
                    if (boxIdx >= 0) {
                        this.environment.orientedBoxes.splice(boxIdx, 1);
                        console.log('[Server] Removed expired ShieldWall OBB collision at index:', boxIdx);
                        
                        // Broadcast ability expiration to all clients
                        io.to(this.id).emit('abilityExpired', { serverId: abilityId });
                    }
                }
            } else if (ability.type === 'ProximityMine') {
                // ProximityMine expired - trigger explosion on server and clients
                console.log('[Server] ProximityMine', abilityId, 'lifetime expired, triggering explosion');
                try {
                    const ex = ability.x || 0;
                    const ey = ability.y || 0;
                    const r = Number.isFinite(ability.explosionRadius) ? ability.explosionRadius : 300;
                    const dmg = Number.isFinite(ability.explosionDamage) ? ability.explosionDamage : 190;
                    
                    // Damage sandbags
                    if (this.hazards && typeof this.hazards.damageCircle === 'function') {
                        this.hazards.damageCircle(ex, ey, r, dmg);
                    }
                    // Damage barrels
                    if (this.hazards && typeof this.hazards.damageBarrelInRadius === 'function') {
                        this.hazards.damageBarrelInRadius(ex, ey, r, dmg);
                    }
                } catch(_) {}
                // Broadcast mine expiration (clients will show explosion animation)
                io.to(this.id).emit('abilityExpired', { serverId: abilityId, explode: true });
            } else if (ability.type === 'HealingBox') {
                // HealingBox expired - show death particles on client side
                console.log('[Server] HealingBox', abilityId, 'lifetime expired (90 seconds)');
                
                // Broadcast ability expiration to all clients
                io.to(this.id).emit('abilityExpired', { serverId: abilityId });
            } else if (ability.type === 'AutoTurret') {
                // AutoTurret expired - trigger explosion on client side
                console.log('[Server] AutoTurret', abilityId, 'lifetime expired (90 seconds)');
                
                // Broadcast ability triggered death event (clients will show explosion)
                io.to(this.id).emit('abilityTriggered', {
                    serverId: abilityId,
                    type: 'AutoTurret',
                    event: 'death'
                });
            } else {
                // Legacy: Remove obstacle from environment (for future abilities)
                if (typeof ability.obstacleIndex === 'number' && ability.obstacleIndex >= 0) {
                    const obstacleIdx = this.environment.obstacles.findIndex(obs => obs.wallId === abilityId);
                    if (obstacleIdx >= 0) {
                        this.environment.obstacles.splice(obstacleIdx, 1);
                        console.log('[Server] Removed expired', ability.type, 'from environment at index:', obstacleIdx);
                        
                        // Broadcast ability expiration to all clients
                        io.to(this.id).emit('abilityExpired', { serverId: abilityId });
                    }
                }
            }
            
            // Remove from tracking
            this.abilities.delete(abilityId);
        }
        
        // Update healing boxes - check for players in range and heal them
        for (const [abilityId, ability] of this.abilities) {
            if (ability.type !== 'HealingBox') continue;
            
            // Check if enough time has passed since last heal tick
            const timeSinceLastHeal = now - ability.lastHealTick;
            if (timeSinceLastHeal < ability.healInterval * 1000) continue;
            
            // Update last heal tick time
            ability.lastHealTick = now;
            
            let healedAnyPlayer = false;
            
            // Check all players in room
            for (const [playerId, player] of this.players) {
                // Skip dead or dying players
                if (!player || player.health <= 0 || player.isDead) continue;
                
                // Validate health values exist (server uses healthMax, not maxHealth)
                if (!Number.isFinite(player.health) || !Number.isFinite(player.healthMax)) {
                    console.warn('[HealingBox] Player has invalid health values:', playerId.substring(0, 8), 'health:', player.health, 'healthMax:', player.healthMax);
                    continue;
                }
                
                // Skip if player is at full health
                if (player.health >= player.healthMax) continue;
                
                // Skip evil players (they can't be healed)
                const isEvil = player.evilLocked === true;
                if (isEvil) continue;
                
                // Check distance
                const dx = player.x - ability.x;
                const dy = player.y - ability.y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                
                if (dist <= ability.healRadius) {
                    // Calculate heal amount, capping to not overheal
                    const healthMissing = player.healthMax - player.health;
                    const healAmount = Math.min(ability.healAmount, healthMissing);
                    
                    // Skip if no healing needed or invalid amount
                    if (!Number.isFinite(healAmount) || healAmount <= 0) continue;
                    
                    // Apply heal
                    player.health += healAmount;
                    
                    // Clamp to healthMax just in case
                    if (player.health > player.healthMax) {
                        player.health = player.healthMax;
                    }
                    
                    // Broadcast heal event
                    io.to(this.id).emit('playerHealed', {
                        playerId: playerId,
                        amount: healAmount,
                        newHealth: player.health,
                        boxId: abilityId,
                        boxX: ability.x,
                        boxY: ability.y
                    });
                    
                    healedAnyPlayer = true;
                    console.log('[HealingBox] Healed player', playerId.substring(0, 8), 'for', healAmount, 'HP (', player.health, '/', player.maxHealth, ')');
                }
            }
            
            // Deplete box health if it healed anyone
            if (healedAnyPlayer) {
                ability.health -= ability.healthCostPerHeal;
                
                // Broadcast box health update to clients so they can show the health bar
                io.to(this.id).emit('abilityHealthUpdate', {
                    serverId: abilityId,
                    health: ability.health,
                    healthMax: ability.healthMax
                });
                
                // Destroy box if health depleted
                if (ability.health <= 0) {
                    ability.health = 0;
                    this.abilities.delete(abilityId);
                    
                    // Broadcast box death
                    io.to(this.id).emit('abilityTriggered', {
                        serverId: abilityId,
                        type: 'death',
                        x: ability.x,
                        y: ability.y
                    });
                    
                    console.log('[HealingBox] Destroyed (health depleted):', abilityId);
                }
            }
        }
        
        // Update auto turrets - AI targeting and firing
        for (const [abilityId, ability] of this.abilities) {
            if (ability.type !== 'AutoTurret') continue;
            if (ability.health <= 0) continue;
            
            // Update fire cooldown
            if (ability.fireCooldown > 0) {
                ability.fireCooldown -= deltaTime;
            }
            
            // Find closest enemy within range
            let closestEnemy = null;
            let closestDist = Infinity;
            
            for (const enemy of this.enemies.values()) {
                if (!enemy || !enemy.alive) continue;
                if (enemy.isBoss) continue; // Skip bosses
                if (enemy.type === 'defenseTurret' || enemy.type === 'artilleryGun') continue; // Skip friendly structures
                
                const dx = enemy.x - ability.x;
                const dy = enemy.y - ability.y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                
                if (dist <= ability.targetingRadius && dist < closestDist) {
                    closestDist = dist;
                    closestEnemy = enemy;
                }
            }
            
            // Update target and angle
            if (closestEnemy) {
                // Check if environment walls block line of sight
                let blockedByWall = false;
                if (this.environment && typeof this.environment.lineHitsAny === 'function') {
                    blockedByWall = this.environment.lineHitsAny(ability.x, ability.y, closestEnemy.x, closestEnemy.y);
                }
                
                if (!blockedByWall) {
                    // Check if WallGuy shield blocks line of sight
                    let blockedByShield = false;
                    for (const [, enemy] of this.enemies) {
                        if (!enemy || !enemy.alive || enemy.type !== 'wallguy') continue;
                        if (enemy.id === closestEnemy.id) continue; // Don't block self
                        
                        const shieldAngle = enemy.shieldAngle;
                        if (shieldAngle === undefined) continue;
                        
                        // Calculate shield position and dimensions
                        const enemyRadius = enemy.radius || 28;
                        const shieldDepth = 20;
                        const shieldWidth = 80;
                        const shieldDist = enemyRadius + shieldDepth/2 + 5;
                        const shieldX = enemy.x + Math.cos(shieldAngle) * shieldDist;
                        const shieldY = enemy.y + Math.sin(shieldAngle) * shieldDist;
                        
                        // Check line-of-sight from turret to target enemy
                        const startX = ability.x - shieldX;
                        const startY = ability.y - shieldY;
                        const endX = closestEnemy.x - shieldX;
                        const endY = closestEnemy.y - shieldY;
                        
                        const cos = Math.cos(-shieldAngle);
                        const sin = Math.sin(-shieldAngle);
                        
                        const localStartX = startX * cos - startY * sin;
                        const localStartY = startX * sin + startY * cos;
                        const localEndX = endX * cos - endY * sin;
                        const localEndY = endX * sin + endY * cos;
                        
                        const halfW = shieldDepth / 2;
                        const halfH = shieldWidth / 2;
                        
                        let t0 = 0, t1 = 1;
                        const ldx = localEndX - localStartX;
                        const ldy = localEndY - localStartY;
                        
                        const clipEdge = (p, q) => {
                            if (p === 0) return q >= 0;
                            const r = q / p;
                            if (p < 0) {
                                if (r > t1) return false;
                                if (r > t0) t0 = r;
                            } else {
                                if (r < t0) return false;
                                if (r < t1) t1 = r;
                            }
                            return true;
                        };
                        
                        if (clipEdge(-ldx, localStartX - (-halfW)) &&
                            clipEdge(ldx, halfW - localStartX) &&
                            clipEdge(-ldy, localStartY - (-halfH)) &&
                            clipEdge(ldy, halfH - localStartY)) {
                            if (t0 <= t1) {
                                blockedByShield = true;
                                break;
                            }
                        }
                    }
                    
                    // Skip this target if blocked by shield
                    if (blockedByShield) {
                        closestEnemy = null;
                    }
                } else {
                    // Blocked by environment wall
                    closestEnemy = null;
                }
            }
            
            // Update target and angle
            if (closestEnemy) {
                const dx = closestEnemy.x - ability.x;
                const dy = closestEnemy.y - ability.y;
                const targetAngle = Math.atan2(dy, dx);
                
                // Smooth rotation
                let angleDiff = targetAngle - ability.angle;
                // Normalize to [-PI, PI]
                while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
                while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
                
                const rotationSpeed = Math.PI * 2; // radians per second
                const maxRotation = rotationSpeed * deltaTime;
                if (Math.abs(angleDiff) < maxRotation) {
                    ability.angle = targetAngle;
                } else {
                    ability.angle += Math.sign(angleDiff) * maxRotation;
                }
                
                // Fire if cooldown ready and roughly aimed
                // Allow wider angle tolerance for close enemies (they're harder to track precisely)
                const aimTolerance = (closestDist < 80) ? 0.4 : 0.2;
                if (ability.fireCooldown <= 0 && Math.abs(angleDiff) < aimTolerance) {
                    // Consume 1 HP per shot
                    ability.health--;
                    ability.fireCooldown = 1.0 / ability.fireRate;
                    
                    // Apply hitscan damage directly to enemy (lag-free instant hit)
                    const turretDamage = ability.damage || 20;
                    if (closestEnemy && closestEnemy.alive) {
                        closestEnemy.health -= turretDamage;
                        if (closestEnemy.health <= 0) {
                            closestEnemy.alive = false;
                            console.log(`[AutoTurret] Killed enemy ${closestEnemy.id} with hitscan`);
                            
                            // Clear licker ensnare if applicable
                            this._clearLickerEnsnareOnDeath(closestEnemy.id, closestEnemy.type);
                            
                            // Remove from authoritative enemy list and broadcast death
                            const enemyId = closestEnemy.id;
                            if (this.enemies.has(enemyId)) {
                                this.enemies.delete(enemyId);
                                // Emit enemy_dead (with underscore) for blood pools and VFX
                                io.to(this.id).emit('enemy_dead', { 
                                    id: enemyId, 
                                    x: closestEnemy.x, 
                                    y: closestEnemy.y, 
                                    type: closestEnemy.type 
                                });
                                // Unified entity death event (preferred by clients)
                                io.to(this.id).emit('entity_dead', {
                                    entityType: 'enemy',
                                    id: enemyId,
                                    x: closestEnemy.x,
                                    y: closestEnemy.y,
                                    kind: closestEnemy.type
                                });
                                
                                // If turret killed a lobby training dummy, respawn it server-side after 2s
                                if (closestEnemy && closestEnemy.type === 'targetDummy' && typeof enemyId === 'string' && enemyId.startsWith('target_dummy_')) {
                                    try {
                                        if (!this._targetDummyRespawnTimers) this._targetDummyRespawnTimers = new Map();
                                        const timers = this._targetDummyRespawnTimers;
                                        const prev = timers.get(enemyId);
                                        if (prev) clearTimeout(prev);
                                        const t = setTimeout(() => {
                                            try {
                                                if (this.scene !== 'lobby') return;
                                                if (this.enemies && this.enemies.has(enemyId)) return;
                                                const idx = Math.max(1, parseInt(enemyId.split('_').pop(), 10) || 1);
                                                const count = 5;
                                                // Recreate missing dummy by ensuring full set exists
                                                this.spawnLobbyTargetDummy(count);
                                            } catch(_) {}
                                        }, 2000);
                                        timers.set(enemyId, t);
                                    } catch(_) {}
                                }
                            }
                        }
                    }
                    
                    // Broadcast turret hitscan fire event (clients will show visuals and sync damage)
                    io.to(this.id).emit('turretFire', {
                        serverId: abilityId,
                        angle: ability.angle,
                        targetX: closestEnemy.x,
                        targetY: closestEnemy.y,
                        targetId: closestEnemy.id,
                        damage: turretDamage,
                        hitscan: true
                    });
                    // Damage sandbags and barrels along hitscan line (ability Ã¢â€ â€™ target)
                    try {
                        if (this.hazards && closestEnemy) {
                            this.hazards.damageFromBulletLine(ability.x, ability.y, closestEnemy.x, closestEnemy.y, turretDamage);
                            if (typeof this.hazards.damageBarrelFromBulletLine === 'function') {
                                this.hazards.damageBarrelFromBulletLine(ability.x, ability.y, closestEnemy.x, closestEnemy.y, turretDamage);
                            }
                        }
                    } catch(_) {}
                    
                    // Broadcast health update
                    io.to(this.id).emit('abilityHealthUpdate', {
                        serverId: abilityId,
                        health: ability.health,
                        healthMax: ability.healthMax
                    });
                    
                    // Destroy turret if ammo depleted
                    if (ability.health <= 0) {
                        ability.health = 0;
                        this.abilities.delete(abilityId);
                        
                        // Broadcast turret death
                        io.to(this.id).emit('abilityTriggered', {
                            serverId: abilityId,
                            type: 'death',
                            x: ability.x,
                            y: ability.y
                        });
                        
                        console.log('[AutoTurret] Destroyed (ammo depleted):', abilityId);
                    }
                }
            }
        }
        
        // Update enemy attractors - health drain over time
        for (const [abilityId, ability] of this.abilities) {
            if (ability.type !== 'EnemyAttractor') continue;
            if (ability.health <= 0) continue;
            
            // Drain health over time (60 HP/second)
            ability.health -= ability.healthDrainRate * deltaTime;
            
            // Broadcast health update periodically (every ~0.5 seconds)
            if (!ability._lastHealthBroadcast || (now - ability._lastHealthBroadcast) >= 500) {
                ability._lastHealthBroadcast = now;
                io.to(this.id).emit('abilityHealthUpdate', {
                    serverId: abilityId,
                    health: Math.max(0, ability.health),
                    healthMax: ability.healthMax
                });
            }
            
            // Destroy attractor if health depleted
            if (ability.health <= 0) {
                ability.health = 0;
                this.abilities.delete(abilityId);
                
                // Broadcast attractor death
                io.to(this.id).emit('abilityTriggered', {
                    serverId: abilityId,
                    type: 'EnemyAttractor',
                    event: 'death',
                    x: ability.x,
                    y: ability.y
                });
                
                console.log('[EnemyAttractor] Destroyed (health depleted):', abilityId);
            }
        }
        
        // Update MolotovPools - apply damage to barrels in radius
        for (const [abilityId, ability] of this.abilities) {
            if (ability.type !== 'MolotovPool') continue;
            
            // Initialize damage tick timer
            if (!ability._barrelDamageTick) ability._barrelDamageTick = 0;
            ability._barrelDamageTick += deltaTime;
            
            // Damage barrels every 0.5 seconds (same rate as DOT to enemies)
            if (ability._barrelDamageTick >= 0.5) {
                ability._barrelDamageTick = 0;
                
                const dotDps = ability.dotDps || 20;
                const damagePerTick = dotDps * 0.5; // 0.5 second tick
                const poolRadius = ability.radius || 200;
                
                // Damage all barrels in pool radius
                if (this.hazards && typeof this.hazards.damageBarrelInRadius === 'function') {
                    this.hazards.damageBarrelInRadius(ability.x, ability.y, poolRadius, damagePerTick);
                }
            }
        }
    }
    */ // END updateAbilities

    // Lobby training dummy implemented as a NORMAL enemy (no special damage pipeline).
    // This makes it react to damage exactly like other enemies (numbers, DOT, blood pools, etc.)
    /* COMMENTED OUT - Now using LevelManager (Phase 5)
    spawnLobbyTargetDummy(count = 5) {
        if (this.scene !== 'lobby') return null;
        const radius = 32;
        const healthMax = 600;
        const b = Number.isFinite(this.boundary) ? this.boundary : 1000;
        
        const env = this.environment;
        
        // Spawn region: upper-left corner up to this limit (near the player position in your screenshot)
        // NOTE: Coordinates are in world space; both x and y are negative in the upper-left.
        //
        // Keep a small visible gap from the top/left walls.
        // (isInsideBounds already enforces -b+radius; this adds extra breathing room.)
        const wallGapX = 14;
        const wallGapY = 14;
        const regionMinX = -b + radius + wallGapX;
        const regionMinY = -b + radius + wallGapY;
        let regionMaxX = -375;
        let regionMaxY = -575;
        // Safety: if lobby bounds ever change such that the "limit" isn't inside the corner region, expand inward a bit
        if (!(regionMaxX > regionMinX)) regionMaxX = regionMinX + 520;
        if (!(regionMaxY > regionMinY)) regionMaxY = regionMinY + 420;

        // Right boundary of the shooting-gallery area (player-side fence line)
        // Note: obstacle clearance checks below keep a safe gap from the sandbags themselves.

        // Each time we (re)spawn a dummy, we want a new position within the region.
        // Use a per-room nonce so respawns can land in different spots while still being deterministic-ish per room.
        if (!Number.isFinite(this._targetDummySpawnNonce)) this._targetDummySpawnNonce = 0;
        const spawnNonce = ++this._targetDummySpawnNonce;

        // Extra gap from sandbags/obstacles (and any other lobby obstacles)
        const obstacleGap = 10;

        // Shooting-gallery motion: randomly choose 2Ã¢â‚¬â€œ3 dummies to move in a ping-pong lane.
        // Deterministic per spawnNonce so respawns can change which ones move.
        const moverIdx = new Set();
        let moveRnd = null;
        try {
            const seedBase = (Number.isFinite(this.worldSeed) ? this.worldSeed : 1) + 424242;
            moveRnd = this._rng(seedBase + spawnNonce * 9001);
            const moverCount = 2 + (moveRnd() < 0.5 ? 0 : 1); // 2 or 3
            while (moverIdx.size < Math.min(moverCount, count)) {
                moverIdx.add(Math.floor(moveRnd() * Math.max(1, count)));
            }
        } catch(_) {}

        const isClear = (cx, cy) => {
            // Enforce the requested corner region
            if (cx < regionMinX || cx > regionMaxX || cy < regionMinY || cy > regionMaxY) return false;
            try {
                if (env && env.isInsideBounds && !env.isInsideBounds(cx, cy, radius + obstacleGap)) return false;
                if (env && env.circleHitsAny && env.circleHitsAny(cx, cy, radius + obstacleGap)) return false;
            } catch(_) {}
            // Avoid overlapping other dummies
            for (const e of this.enemies.values()) {
                if (!e || e.alive === false) continue;
                if (e.type !== 'targetDummy') continue;
                const dx = (e.x || 0) - cx;
                const dy = (e.y || 0) - cy;
                // keep a bigger gap so they don't cluster visually
                const rr = (radius + (e.radius || radius) + 44);
                if (dx*dx + dy*dy <= rr*rr) return false;
            }
            return true;
        };
        
        const spawned = [];
        const enemiesPayload = [];
        
        for (let n = 0; n < count; n++) {
            const id = `target_dummy_${n+1}`;
            if (this.enemies && this.enemies.has(id)) {
                const existing = this.enemies.get(id);
                if (existing) {
                    spawned.push(existing);
                    continue;
                }
            }

            {
                // Place dummies semi-randomly in the upper-left corner area (server-authoritative)
                // Use a nonce so each respawn can land in a new spot.
                const regionW = Math.max(40, regionMaxX - regionMinX);
                const regionH = Math.max(40, regionMaxY - regionMinY);
                
                // Start from a stratified X position (spreads evenly across the region),
                // then bias LEFT a bit toward the wall (to avoid clustering near the fence).
                const bucketW = regionW / Math.max(1, count);
                let x = regionMinX + bucketW * (n + 0.5);
                x = regionMinX + (x - regionMinX) * 0.82; // 18% bias toward left wall
                let y = regionMinY + regionH * ((n + 0.35) / Math.max(1, count)); // gentle spread in Y too
                
                try {
                    const seedBase = (Number.isFinite(this.worldSeed) ? this.worldSeed : 1) + 9001;
                    const rnd = this._rng(seedBase + spawnNonce * 10007 + (n + 1) * 1337);
                    let found = false;
                    for (let attempt = 0; attempt < 60 && !found; attempt++) {
                        // Bias X left: rx^2 pushes values toward 0
                        const rx = rnd();
                        const ry = rnd();
                        const cx = regionMinX + (rx * rx) * regionW;
                        // Allow spawning all the way up to the top wall (bias slightly upward)
                        const cy = regionMinY + (ry * ry) * regionH;
                        if (isClear(cx, cy)) { x = cx; y = cy; found = true; break; }
                    }
                    
                    // If still blocked, spiral-search around the last candidate
                    if (!isClear(x, y)) {
                        for (let step = 0; step < 30 && !found; step++) {
                            const off = 40 + step * 18;
                            const candidates = [
                                { cx: x + off, cy: y },
                                { cx: x - off, cy: y },
                                { cx: x, cy: y + off },
                                { cx: x, cy: y - off },
                                { cx: x + off, cy: y + off },
                                { cx: x - off, cy: y + off },
                                { cx: x + off, cy: y - off },
                                { cx: x - off, cy: y - off }
                            ];
                            for (let i = 0; i < candidates.length; i++) {
                                const c = candidates[i];
                                if (isClear(c.cx, c.cy)) { x = c.cx; y = c.cy; found = true; break; }
                            }
                        }
                    }
                } catch(_) {}
                
                const enemy = {
                    id,
                    x,
                    y,
                    radius,
                    type: 'targetDummy',
                    healthMax,
                    health: healthMax,
                    alive: true,
                    speedMul: 0,
                    preferContact: false,
                    _contactDisabled: true
                };

                // Assign optional ping-pong motion lane
                try {
                    const idx0 = n; // 0-based
                    if (moveRnd && moverIdx.has(idx0)) {
                        const axis = (moveRnd() < 0.5) ? 'x' : 'y';
                        // Slower "shooting gallery" pace
                        const speed = 30 + moveRnd() * 45; // units/sec
                        const dir = (moveRnd() < 0.5) ? -1 : 1;
                        const laneMin = (axis === 'x') ? regionMinX : regionMinY;
                        const laneMax = (axis === 'x') ? regionMaxX : regionMaxY;
                        const pause = 0.55 + moveRnd() * 0.55; // seconds to pause at ends
                        enemy._move = { axis, min: laneMin, max: laneMax, speed, dir, baseX: x, baseY: y, gap: obstacleGap, pause, wait: 0 };
                    }
                } catch(_) {}
                
                // Initialize navmesh pathfinding properties
                this._initNavProperties(enemy);
                
                this.enemies.set(id, enemy);
                spawned.push(enemy);
                enemiesPayload.push({ id: enemy.id, x: enemy.x, y: enemy.y, type: enemy.type, radius: enemy.radius, health: enemy.health, healthMax: enemy.healthMax, speedMul: enemy.speedMul });
            }
        }
        
        // Tell clients to spawn any newly-created dummies
        if (enemiesPayload.length > 0) {
            try {
                io.to(this.id).emit('hordeSpawned', {
                    targetSource: 'targetDummy',
                    enemies: enemiesPayload
                });
                this._nextEnemyBroadcastTime = Date.now();
            } catch(_) {}
        }
        
        return spawned[0] || null;
    }

    // Lobby-only: move some target dummies like a shooting gallery (ping-pong lanes)
    _updateLobbyTargetDummyMotion(deltaTime, nowMs) {
        try {
            if (this.scene !== 'lobby') return;
            if (!this.enemies || this.enemies.size === 0) return;
            const env = this.environment;
            const dt = Math.max(0, Math.min(0.05, Number(deltaTime) || 0)); // clamp to avoid huge jumps
            if (dt <= 0) return;

            let anyMoved = false;
            for (const e of this.enemies.values()) {
                if (!e || e.alive === false) continue;
                if (e.type !== 'targetDummy') continue;
                if (!e._move) continue;

                const m = e._move;
                const axis = (m.axis === 'y') ? 'y' : 'x';
                const r = Number.isFinite(e.radius) ? e.radius : 32;
                const gap = Number.isFinite(m.gap) ? m.gap : 10;
                const min = Number.isFinite(m.min) ? m.min : (axis === 'x' ? -1000 : -1000);
                const max = Number.isFinite(m.max) ? m.max : (axis === 'x' ? 1000 : 1000);
                const speed = Number.isFinite(m.speed) ? m.speed : 100;
                const pause = Number.isFinite(m.pause) ? m.pause : 0.6;
                if (m.dir !== 1 && m.dir !== -1) m.dir = 1;
                if (!Number.isFinite(m.baseX)) m.baseX = e.x;
                if (!Number.isFinite(m.baseY)) m.baseY = e.y;

                // Dwell at endpoints instead of bouncing
                if (Number.isFinite(m.wait) && m.wait > 0) {
                    m.wait -= dt;
                    anyMoved = true; // still "active" so we keep broadcasting while in motion mode
                    continue;
                }

                const step = speed * dt * m.dir;
                let nx = (axis === 'x') ? (e.x + step) : m.baseX;
                let ny = (axis === 'y') ? (e.y + step) : m.baseY;
                if (axis === 'x') ny = m.baseY; else nx = m.baseX;

                // Clamp at bounds, then pause and reverse (ping-pong without bounce reflection)
                let hitEnd = false;
                if (axis === 'x') {
                    if (nx <= min) { nx = min; m.dir = 1; hitEnd = true; }
                    else if (nx >= max) { nx = max; m.dir = -1; hitEnd = true; }
                } else {
                    if (ny <= min) { ny = min; m.dir = 1; hitEnd = true; }
                    else if (ny >= max) { ny = max; m.dir = -1; hitEnd = true; }
                }

                // Collision check against environment
                let clear = true;
                try {
                    if (env && env.isInsideBounds && !env.isInsideBounds(nx, ny, r + gap)) clear = false;
                    if (clear && env && env.circleHitsAny && env.circleHitsAny(nx, ny, r + gap)) clear = false;
                } catch(_) {}

                // Avoid bumping into other target dummies
                if (clear) {
                    for (const o of this.enemies.values()) {
                        if (!o || o === e || o.alive === false) continue;
                        if (o.type !== 'targetDummy') continue;
                        const rr = (r + (o.radius || 32) + 14);
                        const dx = (o.x || 0) - nx;
                        const dy = (o.y || 0) - ny;
                        if (dx * dx + dy * dy <= rr * rr) { clear = false; break; }
                    }
                }

                if (!clear) {
                    // Bounce direction on collision and skip move this tick
                    m.dir *= -1;
                    m.wait = Math.max(m.wait || 0, 0.25);
                    continue;
                }

                e.x = nx;
                e.y = ny;
                anyMoved = true;

                // If we arrived at an endpoint, pause briefly before moving back
                if (hitEnd) {
                    m.wait = Math.max(0.05, pause);
                }
            }

            // Broadcast enemy positions while they are moving (throttled by ENEMY_BROADCAST_HZ)
            if (anyMoved) {
                const t = Number.isFinite(nowMs) ? nowMs : Date.now();
                if (!Number.isFinite(this._nextEnemyBroadcastTime) || t >= this._nextEnemyBroadcastTime) {
                    this.broadcastEnemiesState();
                    this._nextEnemyBroadcastTime = t + this._nextEnemyBroadcastIntervalMs;
                }
            }
        } catch(_) {}
    }

    // Helper method to create appropriate environment based on scene
    _createEnvironmentForScene(scene) {
        if (scene === 'lobby') {
            const env = new ServerEnvironmentLobby(this.worldSeed);
            this.boundary = env.boundary; // Sync room boundary from environment
            return env;
        } else {
            // Level environment - pass level config for rectangular boundary support
            const levelConfig = LevelConfigs.get(this.levelType);
            const env = new ServerEnvironment(this.worldSeed, levelConfig);
            this.boundary = env.boundary; // Sync room boundary from environment (e.g., 23000 for Trench Raid)
            console.log(`[ROOM] Environment boundary set to ${this.boundary} for level type "${this.levelType}"`);
            return env;
        }
    }
    */ // END _createEnvironmentForScene

    // Utility: simple deterministic RNG seeded by room seed and chest id
    /* COMMENTED OUT - Now using LootManager (Phase 2)
    _rng(seed) {
        let s = Math.max(1, Math.floor(seed) % 2147483647);
        return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
    }

    _hashChestId(id) {
        let h = 0; for (let i = 0; i < String(id).length; i++) { h = ((h << 5) - h) + String(id).charCodeAt(i); h |= 0; }
        return Math.abs(h);
    }
    */

    /* COMMENTED OUT - Now using LootManager (Phase 2)
    _generateBrownDrops(chestId, dropCount = 10) {
        const labels = ['+MovSpd','+AtkSpd','+AtkPwr','+Armor','+HP','+Stm','+CritChan','+CritDmg'];
        const rarities = [
            { name: 'Common', color: '#ffffff' },
            { name: 'Uncommon', color: '#2ecc71' },
            { name: 'Rare', color: '#4da3ff' },
            { name: 'Epic', color: '#b26aff' },
            { name: 'Legendary', color: '#ffa64d' }
        ];
        // Seed RNG with room seed + chest hash
        const seed = (this.worldSeed || 1) + this._hashChestId(chestId);
        const rnd = this._rng(seed);
        const picks = [];
        const count = dropCount; // Use dropCount parameter from game mode config
        for (let i = 0; i < count; i++) {
            const lab = labels[Math.floor(rnd() * labels.length)];
            const rPick = rnd();
            let rarityIdx = 0; // weighted
            if (rPick < 0.50) rarityIdx = 0; else if (rPick < 0.75) rarityIdx = 1; else if (rPick < 0.90) rarityIdx = 2; else if (rPick < 0.98) rarityIdx = 3; else rarityIdx = 4;
            const rar = rarities[rarityIdx];
            const statData = this._computeStatBonus(lab, rar.name);
            picks.push({ 
                label: lab, 
                rarityName: rar.name, 
                color: rar.color,
                rarity: rar,
                statKey: statData.statKey,
                bonusValue: statData.value,
                isPercent: statData.isPercent
            });
        }
        return picks;
    }
    */ // END _generateBrownDrops
    
    /* COMMENTED OUT - Now using LootManager (Phase 2)
    _generateStartingGearDrops(chestId, dropCount = 1) {
        // Starting gear chests always drop Legendary (orange) items
        const labels = ['+MovSpd','+AtkSpd','+AtkPwr','+Armor','+HP','+Stm','+CritChan','+CritDmg'];
        const legendaryRarity = { name: 'Legendary', color: '#ffa64d' };
        
        // Seed RNG with room seed + chest hash for deterministic selection
        const seed = (this.worldSeed || 1) + this._hashChestId(chestId);
        const rnd = this._rng(seed);
        const picks = [];
        
        for (let i = 0; i < dropCount; i++) {
            // Pick random stat label
            const lab = labels[Math.floor(rnd() * labels.length)];
            const statData = this._computeStatBonus(lab, legendaryRarity.name);
            picks.push({ 
                label: lab, 
                rarityName: legendaryRarity.name, 
                color: legendaryRarity.color,
                rarity: legendaryRarity,
                statKey: statData.statKey,
                bonusValue: statData.value,
                isPercent: statData.isPercent
            });
        }
        return picks;
    }
    */ // END _generateStartingGearDrops
    
    /* COMMENTED OUT - Now using LootManager (Phase 2)
    // DEBUG FEATURE: Spawn debug chests near each player with 6 random loot items
    // Can be toggled on/off via ENABLE_DEBUG_CHESTS flag
    _spawnDebugChestsNearPlayers() {
        console.log(`[DEBUG_CHEST] === DEBUG CHEST SPAWNER CALLED ===`);
        console.log(`[DEBUG_CHEST] ENABLE_DEBUG_CHESTS flag: ${ENABLE_DEBUG_CHESTS}`);
        console.log(`[DEBUG_CHEST] Current scene: ${this.scene}`);
        console.log(`[DEBUG_CHEST] Environment exists: ${!!this.environment}`);
        console.log(`[DEBUG_CHEST] Player count: ${this.players.size}`);
        
        if (!ENABLE_DEBUG_CHESTS) {
            console.log('[DEBUG_CHEST] Ã¢ÂÅ’ Aborted: ENABLE_DEBUG_CHESTS is false');
            return;
        }
        if (this.scene !== 'level') {
            console.log(`[DEBUG_CHEST] Ã¢ÂÅ’ Aborted: Scene is "${this.scene}", not "level"`);
            return;
        }
        if (!this.environment) {
            console.log('[DEBUG_CHEST] Ã¢ÂÅ’ Aborted: No environment exists');
            return;
        }
        
        console.log('[DEBUG_CHEST] Ã¢Å“â€¦ All checks passed, spawning debug chests near players...');
        
        let chestCount = 0;
        this.players.forEach((player, playerId) => {
            console.log(`[DEBUG_CHEST] Processing player ${playerId} at position (${player.x.toFixed(1)}, ${player.y.toFixed(1)})`);

            // Try to find a clear spot near the player
            const clearance = 28;
            const minDist = 80;
            const maxDist = 150;
            const tries = 50;
            
            let chestX = null;
            let chestY = null;
            
            for (let i = 0; i < tries; i++) {
                const angle = Math.random() * Math.PI * 2;
                const dist = minDist + Math.random() * (maxDist - minDist);
                const testX = player.x + Math.cos(angle) * dist;
                const testY = player.y + Math.sin(angle) * dist;
                
                // Check if position is valid
                if (this.environment.isInsideBounds(testX, testY, clearance) && 
                    !this.environment.circleHitsAny(testX, testY, clearance)) {
                    chestX = testX;
                    chestY = testY;
                    break;
                }
            }
            
            // If no clear spot found, just place it near player anyway
            if (chestX === null || chestY === null) {
                chestX = player.x + 100;
                chestY = player.y + 100;
                console.warn(`[DEBUG_CHEST] Ã¢Å¡Â Ã¯Â¸Â  Could not find clear spot for player ${playerId}, placing at offset position (${chestX.toFixed(0)}, ${chestY.toFixed(0)})`);
            } else {
                console.log(`[DEBUG_CHEST] Ã¢Å“â€¦ Found clear spot for player ${playerId} at (${chestX.toFixed(0)}, ${chestY.toFixed(0)})`);
            }
            
            // Create debug chest with unique ID
            const debugChestId = `debug_${playerId}_${Date.now()}`;
            const debugChest = {
                id: debugChestId,
                x: chestX,
                y: chestY,
                variant: 'brown',
                opening: false,
                opened: false,
                timeTotal: 10.0,
                timeLeft: 0,
                startedBy: null,
                drops: [],
                dropCount: 6, // 6 items instead of default 10
                radius: 20,
                isDebugChest: true // Mark this as a debug chest for identification
            };
            
            this.chests.set(debugChestId, debugChest);
            
            // CRITICAL: Also add to levelSpawns.chests so clients receive it in roomSnapshot
            if (!this.levelSpawns) {
                this.levelSpawns = { chests: [], npcs: [] };
            }
            if (!this.levelSpawns.chests) {
                this.levelSpawns.chests = [];
            }
            this.levelSpawns.chests.push({
                id: debugChestId,
                x: chestX,
                y: chestY,
                variant: 'brown',
                dropCount: 6
            });
            
            chestCount++;
            
            console.log(`[DEBUG_CHEST] Ã¢Å“â€¦ Created and registered debug chest:`);
            console.log(`[DEBUG_CHEST]    - ID: ${debugChestId}`);
            console.log(`[DEBUG_CHEST]    - Position: (${chestX.toFixed(0)}, ${chestY.toFixed(0)})`);
            console.log(`[DEBUG_CHEST]    - Variant: ${debugChest.variant}`);
            console.log(`[DEBUG_CHEST]    - DropCount: ${debugChest.dropCount}`);
            console.log(`[DEBUG_CHEST]    - Total chests in Map: ${this.chests.size}`);
            console.log(`[DEBUG_CHEST]    - Total chests in levelSpawns: ${this.levelSpawns.chests.length}`);
        });
        
        console.log(`[DEBUG_CHEST] === SPAWNING COMPLETE ===`);
        console.log(`[DEBUG_CHEST] Successfully spawned ${chestCount} debug chest(s)`);
        console.log(`[DEBUG_CHEST] Total chests in Map: ${this.chests.size}`);
        console.log(`[DEBUG_CHEST] Total chests in levelSpawns.chests: ${this.levelSpawns.chests.length}`);
    }
    */ // END _spawnDebugChestsNearPlayers
    
    /* COMMENTED OUT - Now using LootManager (Phase 2)
    _computeStatBonus(label, rarityName) {
        // Map label to stat key
        const raw = label.trim().replace(/^\+/, '');
        let statKey = null;
        switch (raw) {
            case 'HP': statKey = 'Health'; break;
            case 'Health': statKey = 'Health'; break;
            case 'Armor': statKey = 'Armor'; break;
            case 'Stm': statKey = 'Stamina'; break;
            case 'Stamina': statKey = 'Stamina'; break;
            case 'MovSpd': statKey = 'MovSpd'; break;
            case 'AtkSpd': statKey = 'AtkSpd'; break;
            case 'AtkPwr': statKey = 'AtkPwr'; break;
            case 'CritChan': statKey = 'CritChance'; break;
            case 'CritChance': statKey = 'CritChance'; break;
            case 'CritDmg': statKey = 'CritDmg'; break;
        }
        
        // Stat configurations by rarity
        const configs = {
            Health: { values: [10, 20, 50, 100, 150], percent: false },
            Armor: { values: [5, 10, 15, 25, 35], percent: true },
            Stamina: { values: [10, 20, 50, 100, 150], percent: false },
            MovSpd: { values: [5, 10, 15, 25, 30], percent: true },
            AtkSpd: { values: [5, 10, 15, 20, 40], percent: true },
            AtkPwr: { values: [2, 5, 10, 20, 30], percent: false },
            CritChance: { values: [2, 5, 10, 20, 30], percent: true },
            CritDmg: { values: [10, 20, 30, 50, 60], percent: true }
        };
        
        if (!statKey || !configs[statKey]) return { statKey: null, value: 0, isPercent: false };
        
        const rarityOrder = ['Common', 'Uncommon', 'Rare', 'Epic', 'Legendary'];
        const rIdx = rarityOrder.indexOf(rarityName);
        const cfg = configs[statKey];
        const value = cfg.values[Math.max(0, Math.min(rIdx, cfg.values.length - 1))] || 0;
        
        return { statKey, value, isPercent: cfg.percent };
    }
    */ // END _computeStatBonus
    
    /* COMMENTED OUT - Now using LootManager (Phase 2)
    _generateBossLoot(enemyId) {
        const labels = ['+MovSpd', '+AtkSpd', '+AtkPwr', '+Armor', '+HP', '+Stm', '+CritChan', '+CritDmg'];
        const rarities = [
            { name: 'Epic', color: '#b26aff' },      // purple
            { name: 'Legendary', color: '#ffa64d' }  // orange
        ];
        // Seed RNG with room seed + enemy id for deterministic loot
        const seed = (this.worldSeed || 1) + this._hashChestId(String(enemyId));
        const rnd = this._rng(seed);
        const picks = [];
        const count = 10;
        for (let i = 0; i < count; i++) {
            const lab = labels[Math.floor(rnd() * labels.length)];
            const rPick = rnd();
            // Epic (55%) or Legendary (45%)
            const rarityIdx = rPick < 0.55 ? 0 : 1;
            const rar = rarities[rarityIdx];
            const statData = this._computeStatBonus(lab, rar.name);
            picks.push({ 
                label: lab, 
                rarityName: rar.name, 
                color: rar.color,
                rarity: rar,
                statKey: statData.statKey,
                bonusValue: statData.value,
                isPercent: statData.isPercent
            });
        }
          return picks;
      }
      */ // END _generateBossLoot
  
      /* COMMENTED OUT - Now using LootManager (Phase 2)
      _generateEnemyDrops(enemyId, enemyType) {
          // Get drop rates from game mode config
          const config = GameModeConfigs.get(this.levelType);
          if (!config || !config.enemies || !config.enemies.dropRates) {
              return { ducats: [], bloodMarkers: [] };
          }
          
          const dropRates = config.enemies.dropRates[enemyType];
          if (!dropRates) return { ducats: [], bloodMarkers: [] };
          
          const drops = { ducats: [], bloodMarkers: [] };
          
          // Roll for ducats with independent RNG seed
          if (dropRates.ducats) {
              const ducatSeed = (this.worldSeed || 1) + this._hashChestId(String(enemyId) + '_ducat');
              const ducatRnd = this._rng(ducatSeed);
              const ducatRoll = ducatRnd();
              if (ducatRoll < dropRates.ducats.chance) {
                  const amount = Math.floor(
                      dropRates.ducats.min + ducatRnd() * (dropRates.ducats.max - dropRates.ducats.min + 1)
                  );
                  drops.ducats.push({ amount });
              }
          }
          
          // Roll for blood markers with independent RNG seed
          if (dropRates.bloodMarkers) {
              const markerSeed = (this.worldSeed || 1) + this._hashChestId(String(enemyId) + '_marker');
              const markerRnd = this._rng(markerSeed);
              const markerRoll = markerRnd();
              if (markerRoll < dropRates.bloodMarkers.chance) {
                  const amount = Math.floor(
                      dropRates.bloodMarkers.min + markerRnd() * (dropRates.bloodMarkers.max - dropRates.bloodMarkers.min + 1)
                  );
                  drops.bloodMarkers.push({ amount });
              }
          }
          
          return drops;
      }
      */ // END _generateEnemyDrops
  
      startChestOpening(socketId, data) {
        const id = data.chestId || `${Math.round(data.x)},${Math.round(data.y)}`;
        let chest = this.chests.get(id);
        if (!chest) {
            // Fallback: create chest if somehow not pre-registered (shouldn't happen)
            let dropCount = 10; // Default
            if (this.levelSpawns && this.levelSpawns.chests) {
                const levelChest = this.levelSpawns.chests.find(c => c.id === id);
                if (levelChest && levelChest.dropCount !== undefined) {
                    dropCount = levelChest.dropCount;
                }
            }
            chest = { 
                id, 
                x: data.x || 0, 
                y: data.y || 0, 
                variant: data.variant || 'brown', 
                opening: false, 
                opened: false, 
                timeTotal: 10.0, 
                timeLeft: 0, 
                startedBy: null, 
                drops: [], 
                dropCount: dropCount,
                radius: 20,
                // Health tracking for gold chests (shared with artifact)
                health: data.variant === 'gold' ? 2000 : undefined,
                healthMax: data.variant === 'gold' ? 2000 : undefined
            };
            this.chests.set(id, chest);
        }
        if (chest.opened || chest.opening) {
            return;
        }
        if (chest.variant === 'brown' || chest.variant === 'startGear') {
            // Immediate open, server-authoritative drops
            chest.opened = true;
            chest.opening = false;
            
            // Generate drops based on chest variant
            if (chest.variant === 'startGear') {
                chest.drops = this._generateStartingGearDrops(id, chest.dropCount || 1);
            } else {
                chest.drops = this._generateBrownDrops(id, chest.dropCount || 10);
            }
            
            // Create server-tracked ground items for chest loot (same as inventory drops)
            const groundItems = [];
            const base = this._rng((this.worldSeed || 1) + this._hashChestId(id))(); // Use seeded RNG for physics
            for (let i = 0; i < chest.drops.length; i++) {
                const drop = chest.drops[i];
                const itemId = `chest_${id}_${i}`;
                const ang = base * 2 * Math.PI + (i * (2 * Math.PI / Math.max(1, chest.drops.length)));
                
                // Find a clear position for this chest loot item
                const pos = this.findClearGroundPosition(chest.x, chest.y, ang);
                
                const groundItem = {
                    id: itemId,
                    x: pos.x,
                    y: pos.y,
                    vx: 0,
                    vy: 0,
                    label: drop.label,
                    rarityName: drop.rarityName,
                    color: drop.color,
                    // Include stat data for server-side inventory calculations
                    statKey: drop.statKey,
                    bonusValue: drop.bonusValue,
                    isPercent: drop.isPercent,
                    rarity: drop.rarity
                };
                
                this.groundItems.set(itemId, groundItem);
                groundItems.push(groundItem);
            }
            
            io.to(this.id).emit('chestOpened', { 
                id: chest.id, 
                x: chest.x, 
                y: chest.y, 
                variant: chest.variant, 
                drops: chest.drops,
                groundItems: groundItems 
            });
        } else {
            // Gold chest: start timer and broadcast updates
            chest.opening = true;
            chest.opened = false;
            chest.timeTotal = Number.isFinite(data.timeTotal) ? data.timeTotal : 60.0;
            chest.timeLeft = chest.timeTotal;
            chest.startedBy = socketId;
            io.to(this.id).emit('chestTimerUpdate', { id: chest.id, x: chest.x, y: chest.y, variant: chest.variant, started: true, timeLeft: chest.timeLeft, timeTotal: chest.timeTotal, startedBy: socketId, health: chest.health, healthMax: chest.healthMax });
            
            // Spawn boss and extraction zones when chest starts opening (server-authoritative)
            if (!this.bossSpawn && !this.extractionZone) {
                console.log('[Server] Gold chest opening started, computing boss spawn and extraction zones...');
                const spawns = this._computeExtractionAndBossSpawns();
                if (spawns) {
                    // Broadcast boss spawn data to all clients
                    io.to(this.id).emit('bossSpawnData', {
                        bossSpawn: spawns.bossSpawn,
                        extractionZone: spawns.extractionZone,
                        hereticExtractionZone: spawns.hereticExtractionZone
                    });
                    console.log('[Server] Boss spawn and extraction zones broadcast to all clients');
                }
            }
            
            // Trigger horde spawning for chest opening (if game mode supports it)
            if (this.currentGameMode?.onChestOpening) {
                this.currentGameMode.onChestOpening(chest);
            }
        }
    }
    
    /* COMMENTED OUT - Now using PlayerManager (Phase 4)
    addPlayer(socket, playerData) {
        // Get spawn position based on scene and game mode
        let spawnPos = { x: 0, y: 0 };
        if (this.scene === 'level') {
            // Check if game mode has custom spawn logic (e.g., trench raid left-side spawn)
            if (this.currentGameMode && typeof this.currentGameMode.getPlayerSpawnPosition === 'function') {
                // Create RNG instance for spawn position
                const spawnSeed = this.worldSeed + socket.id.charCodeAt(0);
                const rng = new SeededRNG(spawnSeed);
                spawnPos = this.currentGameMode.getPlayerSpawnPosition(this.environment, rng);
                console.log(`[Server] Using mode-specific spawn for ${socket.id}: (${spawnPos.x.toFixed(0)}, ${spawnPos.y.toFixed(0)})`);
            } else {
                // Fallback: random position in bounds
                const spawnSeed = this.worldSeed + socket.id.charCodeAt(0) + Date.now();
                spawnPos = this.generateRandomSpawnPosition(spawnSeed);
                console.log(`[Server] Using random spawn for ${socket.id}: (${spawnPos.x.toFixed(0)}, ${spawnPos.y.toFixed(0)})`);
            }
        }
        
        const player = {
            id: socket.id,
            x: spawnPos.x,
            y: spawnPos.y,
            radius: playerData.radius || 20,
            // Base stats (modified by inventory)
            baseSpeed: 220,
            baseHealthMax: 100,
            baseStaminaMax: 100,
            speed: 220,
            health: 100,
            healthMax: 100,
            aimAngle: 0,
            lastInput: null,
            socket: socket,
            // Server-authoritative stamina system
            stamina: 100,
            staminaMax: 100,
            staminaDrainPerSecond: 10,
            staminaRechargePerSecond: 20,
            exhaustionTimer: 0,
            exhaustionCooldownSeconds: 4,
            mustReleaseShift: false,
            mustReleaseFire: false,
            isFiringWeapon4: false,
            // Dash system
            dashCooldown: 0,
            dashCooldownMax: 0.3,
            dashActive: false,
            dashDuration: 0,
            dashMaxDuration: 0.2,
            dashStaminaCost: 45,
            dashSpeedMultiplier: 6.4,
            // Ensnare state (Licker tentacle)
            _ensnaredTimer: 0,
            _ensnaredById: null,
            _ensnaredBy: new Map(),
            // Debug/cheat state
            invincible: false,
            // Temporary invulnerability bookkeeping
            _invulnSources: 0,
            _manualInvincible: false,
            _dashInvuln: false,
            // Evil/conversion state (for PvP friendly fire)
            isEvil: false,
            // Inventory and derived stats
            inventory: [],
            // Base armor is also applied in recalculatePlayerStats; keep this non-zero for first-frame behavior.
            armor: 30,
            attackSpeed: 1.0,
            attackPower: 0,
            // Base crit chance is 5% (matches client baseline)
            critChance: 0.05,
            critDamageMultiplier: 1.2,
            baseCritChance: 0.05,
            baseCritDamageMultiplier: 1.2,
            _lastEligibleHealthBonus: 0,
            // Currency wallet
            ducats: 0,
            bloodMarkers: 0,
            victoryPoints: 0,
            // Loot progression
            lootLevel: 0,
            // Cosmetics
            equippedHat: null,
            equippedSkin: null,
            // Revive system
            downedAt: 0,              // ms timestamp when player went down (health hit 0)
            reviveWindowRemainingMs: 0, // remaining ms to START a revive (pauses while being revived, freezes once ready)
            reviveReadyUntil: 0,       // ms timestamp until which the Revive button is enabled
            reviveReadyFromId: null,   // reviver who completed the 4s channel
            _respawnRequested: false,   // once true, block revive accept/offers
            // Breadcrumb trail system
            breadcrumbs: [],           // Array of {x, y} positions forming the trail
            totalDistanceMoved: 0,     // Total distance moved (must reach 100 before breadcrumbs start)
            lastBreadcrumbX: spawnPos.x, // Last position where breadcrumb was added
            lastBreadcrumbY: spawnPos.y
        };
        // FIXED: Players should join the room's current scene, not override it
        // Room scene is controlled by ready timer and explicit scene changes only
        // No individual player can override the room's scene during join
        
        // Note: Player joins the room's current scene and boundary
        console.log(`Player ${socket.id} joining room ${this.id} (scene: ${this.scene}, boundary: ${this.boundary})`);
        
        this.players.set(socket.id, player);
        console.log(`Player ${socket.id} joined room ${this.id} (scene: ${this.scene}, boundary: ${this.boundary})`);
        
        // Send world seed immediately to new player for synchronized world generation
        socket.emit('worldSeed', { seed: this.worldSeed });
        console.log(`[SEED] Sent world seed ${this.worldSeed} to player ${socket.id} in room ${this.id}`);
        
        // Ensure lobby training dummy exists (implemented as a normal enemy)
        if (this.scene === 'lobby') {
            try { this.spawnLobbyTargetDummy(); } catch(_) {}
        }
        
        // Auto-spawn ambient NPCs if in lobby scene and none exist
        if (this.scene === 'lobby' && this.ambientNpcs.length === 0) {
            console.log(`[AMBIENT_NPCs] Auto-spawning ambient NPCs for lobby`);
            this.spawnLobbyAmbientNpcs();
        }
        
        // Send full room snapshot and initial game state to new player
        this.sendRoomSnapshot(socket);
        socket.emit('gameState', this.getGameState());
        
        // Notify other players of new player
        socket.to(this.id).emit('playerJoined', {
            id: socket.id,
            x: player.x,
            y: player.y,
            radius: player.radius,
            health: player.health,
            healthMax: player.healthMax,
            isEvil: player.isEvil || false
        });
    }
    */ // END addPlayer
    
    /* COMMENTED OUT - Now using PlayerManager (Phase 4)
    // Server-side stat recalculation from inventory (mirrors client logic)
    recalculatePlayerStats(player) {
        if (!player) return;
        
        const prevMax = player.healthMax;
        const prevStaminaMax = player.staminaMax || player.baseStaminaMax || 100;
        let healthFlatBonus = 0;
        let eligibleHealthFlatBonus = 0;
        let staminaFlatBonus = 0;
        let movSpdPercent = 0;
        // Base armor is 30%. Inventory adds on top.
        let armorPercent = 30;
        let atkSpdPercent = 0;
        let atkPwrFlat = 0;
        let critChancePercent = 0;
        let critDmgPercent = 0;
        
        try {
            if (Array.isArray(player.inventory)) {
                if (DEBUG_BUILD) console.log(`[Server] recalculatePlayerStats: Processing ${player.inventory.length} items for ${player.id}`);
                for (let i = 0; i < player.inventory.length; i++) {
                    const item = player.inventory[i];
                    if (!item) continue;
                    
                    if (DEBUG_BUILD) console.log(`[Server]   Item ${i}: ${item.label} | statKey=${item.statKey}, bonusValue=${item.bonusValue}, isPercent=${item.isPercent}`);
                    
                    if (item.statKey === 'Health') {
                        let add = Number(item.bonusValue) || 0;
                        if (item.isPercent) {
                            add = Math.round((player.baseHealthMax || 100) * (add / 100));
                        }
                        if (DEBUG_BUILD) console.log(`[Server]   -> Health item adds ${add} (flat bonus now: ${healthFlatBonus + add})`);
                        healthFlatBonus += add;
                        if (!item.suppressHealForPlayerId || item.suppressHealForPlayerId !== player.id) {
                            eligibleHealthFlatBonus += add;
                        }
                    }
                    if (item.statKey === 'Stamina') {
                        let addS = Number(item.bonusValue) || 0;
                        if (item.isPercent) {
                            addS = Math.round((player.baseStaminaMax || 100) * (addS / 100));
                        }
                        staminaFlatBonus += addS;
                    }
                    if (item.statKey === 'MovSpd') {
                        let addMS = Number(item.bonusValue) || 0;
                        if (item.isPercent) {
                            movSpdPercent += addMS;
                        } else {
                            const base = player.baseSpeed || 220;
                            if (base > 0) movSpdPercent += (addMS / base) * 100;
                        }
                    }
                    if (item.statKey === 'Armor') {
                        const addA = Number(item.bonusValue) || 0;
                        armorPercent += addA;
                    }
                    if (item.statKey === 'AtkSpd') {
                        const addAS = Number(item.bonusValue) || 0;
                        atkSpdPercent += addAS;
                    }
                    if (item.statKey === 'AtkPwr') {
                        const addAP = Number(item.bonusValue) || 0;
                        atkPwrFlat += addAP;
                    }
                    if (item.statKey === 'CritChance') {
                        const addCC = Number(item.bonusValue) || 0;
                        critChancePercent += addCC;
                    }
                    if (item.statKey === 'CritDmg') {
                        const addCM = Number(item.bonusValue) || 0;
                        critDmgPercent += addCM;
                    }
                }
            }
        } catch (_) {}
        
        // Apply calculated values
        if (DEBUG_BUILD) console.log(`[Server] Applying stats: baseHealthMax=${player.baseHealthMax}, healthFlatBonus=${healthFlatBonus}`);
        // Cap healthMax at 300 (same as stamina)
        const rawHealthMax = Math.max(1, (player.baseHealthMax || 100) + healthFlatBonus);
        player.healthMax = Math.min(300, rawHealthMax);
        if (DEBUG_BUILD) console.log(`[Server] New healthMax = ${player.healthMax} (raw: ${rawHealthMax}, capped at 300)`);
        
        // Grant immediate health for all eligible items (suppressHealForPlayerId already prevents duplicate healing)
        if (eligibleHealthFlatBonus > 0) {
            if (DEBUG_BUILD) console.log(`[Server] Granting ${eligibleHealthFlatBonus} immediate health (new total: ${player.health + eligibleHealthFlatBonus})`);
            player.health += eligibleHealthFlatBonus;
            // Mark all HP items in inventory as having healed this player (case-insensitive check)
            for (let i = 0; i < player.inventory.length; i++) {
                const item = player.inventory[i];
                if (item && item.statKey && item.statKey.toLowerCase() === 'health' && !item.isPercent) {
                    if (!item.suppressHealForPlayerId || item.suppressHealForPlayerId !== player.id) {
                        item.suppressHealForPlayerId = player.id;
                        if (DEBUG_BUILD) console.log(`[Server] Marked ${item.label} as healed for player ${player.id}`);
                    }
                }
            }
        }
        
        // Clamp current health to healthMax
        if (player.health > player.healthMax) player.health = player.healthMax;
        
        const rawStaminaMax = Math.max(1, (player.baseStaminaMax || 100) + staminaFlatBonus);
        player.staminaMax = Math.min(300, rawStaminaMax);
        if (player.staminaMax > prevStaminaMax) {
            player.stamina += (player.staminaMax - prevStaminaMax);
        }
        if (player.stamina > player.staminaMax) player.stamina = player.staminaMax;
        
        const baseSpd = player.baseSpeed || 220;
        const totalMovPct = Math.max(0, movSpdPercent);
        player.speed = Math.min(375, baseSpd * (1 + totalMovPct / 100));
        
        // Cap armor at 150% (damage reduction is separately capped at 75% in combat code)
        player.armor = Math.max(0, Math.min(150, armorPercent));
        
        // Cap attack speed at 3x (200% bonus)
        const rawAtkSpd = 1 + atkSpdPercent / 100;
        player.attackSpeed = Math.max(0.1, Math.min(3.0, rawAtkSpd));
        
        // Cap attack power at 150 flat bonus
        player.attackPower = Math.max(0, Math.min(150, atkPwrFlat));
        
        const baseCc = (player.baseCritChance != null) ? player.baseCritChance : 0;
        const baseCm = (player.baseCritDamageMultiplier != null) ? player.baseCritDamageMultiplier : 1.2;
        const ccAdd = Math.max(0, critChancePercent) / 100;
        player.critChance = Math.max(0, Math.min(1, baseCc + ccAdd));
        
        // Cap crit damage multiplier at 5x (400% bonus on top of base 120%)
        const rawCritDmgMul = baseCm * (1 + Math.max(0, critDmgPercent) / 100);
        player.critDamageMultiplier = Math.max(1, Math.min(5.0, rawCritDmgMul));
        
        if (DEBUG_BUILD) console.log(`[Server] Recalculated stats for ${player.id}: HP=${player.healthMax}, Spd=${player.speed.toFixed(0)}, Armor=${player.armor}%, AtkSpd=${player.attackSpeed.toFixed(2)}x, CC=${(player.critChance*100).toFixed(0)}%, CD=${(player.critDamageMultiplier*100).toFixed(0)}%`);
    }
    */ // END recalculatePlayerStats
    
    /* COMMENTED OUT - Now using PlayerManager (Phase 4)
    removePlayer(socketId) {
        if (this.players.has(socketId)) {
            const player = this.players.get(socketId);
            
            // Drop any battery the player was carrying
            if (this.batteries) {
                for (const [batteryId, battery] of this.batteries) {
                    if (battery.carriedBy === socketId) {
                        battery.carriedBy = null;
                        battery.x = player ? player.x : battery.x;
                        battery.y = player ? player.y : battery.y;
                        battery.onGround = true;
                        
                        io.to(this.id).emit('batteryDropped', {
                            batteryId: batteryId,
                            x: battery.x,
                            y: battery.y
                        });
                        console.log(`[BatterySystem] Battery ${batteryId} dropped by disconnecting player ${socketId}`);
                    }
                }
            }
            
            this.players.delete(socketId);
            console.log(`Player ${socketId} left room ${this.id}`);

            // Notify other players
            io.to(this.id).emit('playerLeft', { id: socketId });

            // Clean up room if empty
            if (this.players.size === 0) {
                this.cleanup();
                rooms.delete(this.id);
            }
        }
    }
    */ // END removePlayer

    // ===== MERCHANT SHOP =====
    
    /* COMMENTED OUT - Now using LootManager (Phase 2)
    _generateShopInventory() {
        const labels = ['+MovSpd', '+AtkSpd', '+AtkPwr', '+Armor', '+HP', '+Stm', '+CritChan', '+CritDmg'];
        const items = [];
        
        // Seed RNG with world seed + timestamp for variety
        const seed = this.worldSeed + Date.now();
        const rng = this._createSeededRNG(seed);
        
        // 4 Epic items (purple)
        for (let i = 0; i < 4; i++) {
            const label = labels[Math.floor(rng() * labels.length)];
            const priceMin = 200;
            const priceMax = 400;
            const price = Math.floor((priceMin + rng() * (priceMax - priceMin)) / 25) * 25;
            
            items.push({
                label: label,
                rarityName: 'Epic',
                color: '#b26aff',
                price: price,
                sold: false,
                placeholder: false
            });
        }
        
        // 4 Legendary items (orange)
        for (let i = 0; i < 4; i++) {
            const label = labels[Math.floor(rng() * labels.length)];
            const priceMin = 400;
            const priceMax = 700;
            const price = Math.floor((priceMin + rng() * (priceMax - priceMin)) / 25) * 25;
            
            items.push({
                label: label,
                rarityName: 'Legendary',
                color: '#ffa64d',
                price: price,
                sold: false,
                placeholder: false
            });
        }
        
        // 4 Hats (cosmetic items) - priced in VP
        const hats = [
            { name: 'Capirote', price: 1, currency: 'vp', color: '#8b7355', description: 'Rusted metal conical hat' },
            { name: 'Pope Hat', price: 3, currency: 'vp', color: '#6b2424', description: 'Ornate red papal mitre' },
            { name: 'Prussian Helmet', price: 2, currency: 'vp', color: '#2f4f4f', description: 'WWI Pickelhaube' },
            { name: 'Knight Helmet', price: 2, currency: 'vp', color: '#c0c0c0', description: 'Medieval great helm' }
        ];
        
        for (const hat of hats) {
            items.push({
                type: 'hat',
                label: hat.name,
                rarityName: 'Cosmetic',
                color: hat.color,
                price: hat.price,
                currency: hat.currency,
                sold: false,
                placeholder: false
            });
        }
        
        // 4 Skins (cosmetic body accessories) - ALL COMPLETE - priced in VP
        const skins = [
            { name: 'Crusader Armor', price: 1, currency: 'vp', color: '#8b8b8b', description: 'Shield shoulder pads with crosses and leather belt with pouches' },
            { name: 'Iconoclast', price: 2, currency: 'vp', color: '#6b4423', description: 'Rusted cross shoulder shields, leather straps, rope bindings, and religious icons' },
            { name: 'Officer', price: 2, currency: 'vp', color: '#5c6b4a', description: 'Drab green lapels over metal cuirass with golden cross badges and belt' },
            { name: 'Inquisitor', price: 3, currency: 'vp', color: '#6b2424', description: 'Large red shoulder pauldrons with spikes and heraldic shield badges' }
        ];
        
        for (const skin of skins) {
            items.push({
                type: 'skin',
                label: skin.name,
                rarityName: 'Cosmetic',
                color: skin.color,
                price: skin.price,
                currency: skin.currency,
                sold: false,
                placeholder: false
            });
        }
        
        // No more skin placeholders - all 4 complete!
        
        this.shopInventory = items;
        this._shopNeedsRefresh = false;
        console.log('[SHOP] Generated new shop inventory with', items.filter(i => !i.placeholder).length, 'items for sale');
    }
    */ // END _generateShopInventory
    
    /* COMMENTED OUT - Now using LootManager (Phase 2)
    _createSeededRNG(seed) {
        let state = seed;
        return function() {
            state = (state * 9301 + 49297) % 233280;
            return state / 233280;
        };
    }
    */ // END _createSeededRNG
    
    /* COMMENTED OUT - Now using LootManager (Phase 2)
    refreshShopIfNeeded() {
        if (this._shopNeedsRefresh) {
            this._generateShopInventory();
        }
    }
    */ // END refreshShopIfNeeded
    
    /* COMMENTED OUT - Now using LootManager (Phase 2)
    markShopForRefresh() {
        this._shopNeedsRefresh = true;
        console.log('[SHOP] Marked shop for refresh on next request');
    }
    */ // END markShopForRefresh
    
    /* COMMENTED OUT - Now using LootManager (Phase 2)
    getShopInventory() {
        this.refreshShopIfNeeded();
        return this.shopInventory;
    }
    */ // END getShopInventory
    
    /* COMMENTED OUT - Now using LootManager (Phase 2)
    purchaseShopItem(socketId, itemIndex) {
        const player = this.players.get(socketId);
        if (!player) {
            console.warn('[SHOP] Purchase failed: player not found');
            return { success: false, reason: 'Player not found' };
        }
        
        if (itemIndex < 0 || itemIndex >= this.shopInventory.length) {
            console.warn('[SHOP] Purchase failed: invalid item index', itemIndex);
            return { success: false, reason: 'Invalid item' };
        }
        
        const item = this.shopInventory[itemIndex];
        if (!item || item.sold || item.placeholder) {
            console.warn('[SHOP] Purchase failed: item unavailable');
            return { success: false, reason: 'Item unavailable' };
        }
        
        // Check currency type (default to ducats for backwards compatibility)
        const currency = item.currency || 'ducats';
        
        // Check if player has enough currency
        if (currency === 'vp') {
            if ((player.victoryPoints || 0) < item.price) {
                console.warn('[SHOP] Purchase failed: insufficient VP');
                return { success: false, reason: 'Insufficient Victory Points' };
            }
            // Deduct VP
            player.victoryPoints = (player.victoryPoints || 0) - item.price;
        } else {
            if ((player.ducats || 0) < item.price) {
                console.warn('[SHOP] Purchase failed: insufficient ducats');
                return { success: false, reason: 'Insufficient ducats' };
            }
            // Deduct ducats
            player.ducats = (player.ducats || 0) - item.price;
        }
        
        // Check if item is a hat (cosmetic item)
        if (item.type === 'hat') {
            // Equip the hat directly
            player.equippedHat = {
                name: item.label,
                color: item.color
            };
            
            // Mark item as sold
            item.sold = true;
            
            const currencyName = currency === 'vp' ? 'VP' : 'ducats';
            console.log(`[SHOP] Player ${socketId} equipped hat: ${item.label} for ${item.price} ${currencyName}`);
            
            return { 
                success: true, 
                item: { type: 'hat', label: item.label, color: item.color },
                newDucats: player.ducats,
                newVictoryPoints: player.victoryPoints,
                newInventory: player.inventory,
                equippedHat: player.equippedHat
            };
        }
        
        // Check if item is a skin (cosmetic body accessory)
        if (item.type === 'skin') {
            // Equip the skin directly
            player.equippedSkin = {
                name: item.label,
                color: item.color
            };
            
            // Mark item as sold
            item.sold = true;
            
            const currencyName = currency === 'vp' ? 'VP' : 'ducats';
            console.log(`[SHOP] Player ${socketId} equipped skin: ${item.label} for ${item.price} ${currencyName}`);
            
            return { 
                success: true, 
                item: { type: 'skin', label: item.label, color: item.color },
                newDucats: player.ducats,
                newVictoryPoints: player.victoryPoints,
                newInventory: player.inventory,
                equippedSkin: player.equippedSkin
            };
        }
        
        // Add stat item to player inventory using HexStat-equivalent fields
        const normalizeLabelToKey = (label) => {
            if (!label || typeof label !== 'string') return null;
            const raw = label.trim().replace(/^\+/, '');
            switch (raw) {
                case 'HP': return 'Health';
                case 'Health': return 'Health';
                case 'Armor': return 'Armor';
                case 'Stm': return 'Stamina';
                case 'Stamina': return 'Stamina';
                case 'MovSpd': return 'MovSpd';
                case 'AtkSpd': return 'AtkSpd';
                case 'AtkPwr': return 'AtkPwr';
                case 'CritChan': return 'CritChance';
                case 'CritChance': return 'CritChance';
                case 'CritDmg': return 'CritDmg';
                default: return null;
            }
        };
        const rarityIndex = (name) => {
            const order = ['Common', 'Uncommon', 'Rare', 'Epic', 'Legendary'];
            const idx = order.indexOf(name);
            return idx >= 0 ? idx : 0;
        };
        const STAT_CONFIG = {
            Health: { values: [10, 20, 50, 100, 150], percent: false },
            Armor: { values: [5, 10, 15, 25, 35], percent: true },
            Stamina: { values: [10, 20, 50, 100, 150], percent: false },
            MovSpd: { values: [5, 10, 15, 25, 30], percent: true },
            AtkSpd: { values: [5, 10, 15, 20, 40], percent: true },
            AtkPwr: { values: [2, 5, 10, 20, 30], percent: false },
            CritChance: { values: [2, 5, 10, 20, 30], percent: true },
            CritDmg: { values: [10, 20, 30, 50, 60], percent: true }
        };
        const statKey = normalizeLabelToKey(item.label);
        const cfg = STAT_CONFIG[statKey] || null;
        const rIdx = rarityIndex(item.rarityName);
        const values = cfg ? cfg.values : [0];
        const bonusValue = values[Math.min(Math.max(rIdx, 0), values.length - 1)] || 0;
        const isPercent = cfg ? !!cfg.percent : false;

        const inventoryItem = {
            type: 'HexStat',
            label: item.label,
            rarityName: item.rarityName,
            color: item.color,
            statKey,
            bonusValue,
            isPercent
        };
        
        if (!Array.isArray(player.inventory)) {
            player.inventory = [];
        }
        player.inventory.push(inventoryItem);
        
        // Update loot level and recalc stats immediately
        player.lootLevel = player.inventory.length;
        this.recalculatePlayerStats(player);
        
        // Mark item as sold
        item.sold = true;
        
        const currencyName = currency === 'vp' ? 'VP' : 'ducats';
        console.log(`[SHOP] Player ${socketId} purchased ${item.label} (${item.rarityName}) for ${item.price} ${currencyName}`);
        
        return { 
            success: true, 
            item: inventoryItem,
            newDucats: player.ducats,
            newVictoryPoints: player.victoryPoints,
            newInventory: player.inventory
        };
    }
    */ // END purchaseShopItem

    updatePlayerInput(socketId, input) {
        const player = this.players.get(socketId);
        if (player) {
            // Debug dash input
            if (input.wantsDash) {
                console.log(`[Server] Ã°Å¸Å½Â¯ INPUT RECEIVED: wantsDash=true for player ${player.id}`);
            }
            
            serverDebugger.playerInput(socketId, input);
            // Debug: Track input with enhanced movement debugging
            serverDebugger.serverMovementInput(socketId, input, Date.now());
            player.lastInput = {
                ...input,
                timestamp: Date.now()
            };
            
            // Dialogue-open state: treat like invisibility for enemy targeting (no visual change)
            // Also clear existing enemy aggro immediately when dialogue opens.
            const prevDialogueOpen = (player.dialogueOpen === true);
            const nextDialogueOpen = (input && input.dialogueOpen === true);
            player.dialogueOpen = nextDialogueOpen;
            if (!prevDialogueOpen && nextDialogueOpen) {
                try {
                    for (const e of this.enemies.values()) {
                        if (!e || e.alive === false) continue;
                        if (e._targetPlayerId === socketId) e._targetPlayerId = null;
                    }
                } catch(_) {}
            }
            // Update evil/heretic conversion state for visual replication
            if (typeof input.evilProgress === 'number') {
                player.evilProgress = input.evilProgress;
            }
            if (typeof input.evilLocked === 'boolean') {
                player.evilLocked = input.evilLocked;
            }
            // Update weapon firing states for stamina tracking
            if (typeof input.isFiringWeapon1 === 'boolean') {
                player.isFiringWeapon1 = input.isFiringWeapon1;
            }
            if (typeof input.isFiringWeapon4 === 'boolean') {
                player.isFiringWeapon4 = input.isFiringWeapon4;
            }
        }
    }
    tick() {
        const tickStart = typeof process.hrtime === 'function' ? (typeof process.hrtime.bigint === 'function' ? process.hrtime.bigint() : process.hrtime()) : null;
        const now = Date.now();
        const deltaTime = (now - this.lastTick) / 1000;
        this.lastTick = now;
        this.tickCount++;
        
        // Phase 2: Create RoomContext for this tick
        // This encapsulates everything systems need without scattered parameter passing
        const ctx = createRoomContext({
            io,
            config: SERVER_CONFIG,
            room: this,
            now,
            dt: deltaTime,
            rng: this.rng,
            logger: console
        });
        
        // Update ready timer if active
        this.updateReadyTimer(deltaTime);
        
        // Update extraction timer if active
        this.updateExtractionTimer(deltaTime);
        
        // Update current game mode if active
        if (this.currentGameMode && this.scene === 'level') {
            this.currentGameMode.update(deltaTime);
            if (this.ambientSpawner) this.ambientSpawner.update(deltaTime);
            if (this.hazards && typeof this.hazards.update === 'function') {
                this.hazards.update(deltaTime);
            }
        }
        
        // Update target dummy movement (lobby shooting gallery)
        this.updateTargetDummy(deltaTime);
        
        // Update and cleanup expired abilities
        this.updateAbilities(now, deltaTime);
        
        // Update player stamina and positions based on input
        for (const [id, player] of this.players) {
            if (player.lastInput) {
                this.updatePlayerStamina(player, player.lastInput, deltaTime);
                this.updatePlayerMovement(player, player.lastInput, deltaTime);
            }
        }
        
        // Update revive channels (server-authoritative)
        this._updateRevives(now);
        // Update revive start window countdowns (pauses during channel, freezes once ready)
        this._updateReviveWindows(deltaTime, now);
        
        // Update player bullets and check PvP collisions
        // Lobby shooting-gallery: move some target dummies (server-authoritative)
        if (this.scene === 'lobby') {
            try { this._updateLobbyTargetDummyMotion(deltaTime, now); } catch(_) {}
        }
        this.updatePlayerBullets(deltaTime);
        
        // Update player DOT stacks (server-authoritative damage over time)
        this.updatePlayerDots(deltaTime);

        // Update gold chest timers
        for (const chest of this.chests.values()) {
            if (chest.opening && !chest.opened && chest.variant !== 'brown') {
                chest.timeLeft -= deltaTime;
                if (chest.timeLeft < 0) chest.timeLeft = 0;
                io.to(this.id).emit('chestTimerUpdate', { id: chest.id, x: chest.x, y: chest.y, variant: chest.variant, started: chest.timeLeft > 0, timeLeft: chest.timeLeft, timeTotal: chest.timeTotal, startedBy: chest.startedBy, health: chest.health, healthMax: chest.healthMax });
                if (chest.timeLeft <= 0) {
                    chest.opening = false;
                    chest.opened = true;
                    // Artifact drop descriptor (clients handle physics)
                    io.to(this.id).emit('chestOpened', { id: chest.id, x: chest.x, y: chest.y, variant: chest.variant, artifact: { vx: 160, vy: -220 }, health: chest.health, healthMax: chest.healthMax });
                    // Track artifact state on server for deterministic pickup/drop
                    chest.artifactCarriedBy = null;
                    chest.artifactPos = { x: chest.x, y: chest.y };
                }
            }
        }
        
        // Sanity fix: if the artifact is on the ground, keep it out of walls.
        // Prevents "dropped near wall => can't pick it up" and also self-heals already-stuck artifacts.
        try {
            const env = this.environment;
            if (env && typeof env.circleHitsAny === 'function') {
                const radius = 16;
                const hasBounds = (typeof env.isInsideBounds === 'function');
                const isClear = (x, y) => {
                    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
                    if (hasBounds && !env.isInsideBounds(x, y, radius)) return false;
                    if (env.circleHitsAny(x, y, radius)) return false;
                    return true;
                };
                for (const chest of this.chests.values()) {
                    if (!chest || chest.variant === 'brown' || chest.variant === 'startGear') continue;
                    if (chest.artifactCarriedBy) continue;
                    if (!chest.artifactPos) continue;
                    const ax = Number(chest.artifactPos.x);
                    const ay = Number(chest.artifactPos.y);
                    if (isClear(ax, ay)) continue;
                    
                    const cx = Number.isFinite(chest.x) ? Number(chest.x) : 0;
                    const cy = Number.isFinite(chest.y) ? Number(chest.y) : 0;
                    let fixed = null;
                    const maxDist = 240;
                    const step = 12;
                    for (let dist = 0; dist <= maxDist && !fixed; dist += step) {
                        const samples = Math.min(48, Math.max(10, Math.round((2 * Math.PI * Math.max(1, dist)) / 32)));
                        for (let i = 0; i < samples; i++) {
                            const ang = (i / samples) * Math.PI * 2;
                            const x = ax + Math.cos(ang) * dist;
                            const y = ay + Math.sin(ang) * dist;
                            if (isClear(x, y)) { fixed = { x, y }; break; }
                        }
                    }
                    if (!fixed && isClear(cx, cy)) fixed = { x: cx, y: cy };
                    if (fixed) {
                        chest.artifactPos = fixed;
                    }
                }
            }
        } catch(_) {}

        // Server-authoritative enemy movement (level only, unless mission ended)
        if (this.scene === 'level' && this.enemyNetMode === 'authoritative' && !this.missionEnded) {
            this.updateEnemies(deltaTime);
            // Update boomer pools and apply slow to players
            this.updateBoomerPools(deltaTime);
            const nowMs = now; // reuse timestamp from above
            if (!Number.isFinite(this._nextEnemyBroadcastTime) || nowMs >= this._nextEnemyBroadcastTime) {
                this.broadcastEnemiesState();
                this._nextEnemyBroadcastTime = nowMs + this._nextEnemyBroadcastIntervalMs;
            }
        }
        
        // Broadcast lobby target dummy positions (they move via updateTargetDummy)
        if (this.scene === 'lobby' && this.enemies.size > 0) {
            const nowMs = now;
            if (!Number.isFinite(this._nextEnemyBroadcastTime) || nowMs >= this._nextEnemyBroadcastTime) {
                this.broadcastEnemiesState();
                this._nextEnemyBroadcastTime = nowMs + this._enemyBroadcastIntervalMs;
            }
        }
        
        // Update and broadcast server-authoritative NPCs (level only, unless mission ended)
        if (this.scene === 'level' && this.npcManager && !this.missionEnded) {
            this.npcManager.update(deltaTime, now);
        }
        
        // Update and broadcast server-authoritative troops (level only, unless mission ended)
        if (this.scene === 'level' && this.troopManager && !this.missionEnded) {
            this.troopManager.update(deltaTime, now);
        }

        let tickDurationMs = 0;
        if (tickStart !== null) {
            if (typeof tickStart === 'bigint' && typeof process.hrtime.bigint === 'function') {
                tickDurationMs = Number(process.hrtime.bigint() - tickStart) / 1e6;
            } else if (Array.isArray(tickStart) && typeof process.hrtime === 'function') {
                const diff = process.hrtime(tickStart);
                tickDurationMs = diff[0] * 1e3 + diff[1] / 1e6;
            }
        }
        serverDebugger.roomTickTiming(this.id, deltaTime, tickDurationMs, TICK_RATE);
    }

    _updateRevives(nowMs) {
        const map = this._activeRevivesByTarget;
        if (!map || map.size === 0) return;

        const toCancel = [];
        const toFinish = [];

        for (const [targetId, st] of map) {
            const reviver = this.players.get(st.reviverId);
            const target = this.players.get(targetId);

            const cancel = () => toCancel.push(targetId);

            if (!reviver || !target) { cancel(); continue; }
            if (!(reviver.health > 0)) { cancel(); continue; }
            if (!(target.health <= 0)) { cancel(); continue; }
            if (target._respawnRequested === true) { cancel(); continue; }

            // Must keep holding E for channel duration
            const holdingE = !!(reviver.lastInput && reviver.lastInput.keys && reviver.lastInput.keys.KeyE);
            if (!holdingE) { cancel(); continue; }

            // Must stay in range
            const dx = (reviver.x || 0) - (target.x || 0);
            const dy = (reviver.y || 0) - (target.y || 0);
            const REVIVE_R = 80;
            if (dx * dx + dy * dy > REVIVE_R * REVIVE_R) { cancel(); continue; }

            // Broadcast progress at ~10Hz (clients can also derive from gameState)
            const progress = Math.max(0, Math.min(1, (nowMs - st.startedAt) / 4000));
            if (!st.lastEmitAt || (nowMs - st.lastEmitAt) > 100) {
                st.lastEmitAt = nowMs;
                try { io.to(this.id).emit('reviveState', { type: 'progress', ...st, progress }); } catch(_) {}
            }

            if (nowMs >= st.endsAt) toFinish.push(targetId);
        }

        for (let i = 0; i < toCancel.length; i++) {
            const targetId = toCancel[i];
            const st = map.get(targetId);
            if (!st) continue;
            map.delete(targetId);
            try { io.to(this.id).emit('reviveState', { type: 'canceled', ...st }); } catch(_) {}
        }

        for (let i = 0; i < toFinish.length; i++) {
            const targetId = toFinish[i];
            const st = map.get(targetId);
            if (!st) continue;
            map.delete(targetId);

            const target = this.players.get(targetId);
            if (!target) continue;
            if (!(target.health <= 0)) continue;
            if (target._respawnRequested === true) continue;

            // Make revive available for the target to accept (keep generous window)
            target.reviveReadyFromId = st.reviverId;
            target.reviveReadyUntil = Date.now() + 10 * 60 * 1000; // 10 minutes
            try { target.socket && target.socket.emit && target.socket.emit('reviveReady', { fromId: st.reviverId, expiresAt: target.reviveReadyUntil }); } catch(_) {}
            try { io.to(this.id).emit('reviveState', { type: 'ready', ...st, progress: 1 }); } catch(_) {}
        }
    }

    _updateReviveWindows(deltaTime, nowMs) {
        try {
            const dtMs = Math.max(0, deltaTime * 1000);
            for (const [pid, p] of this.players) {
                if (!p) continue;
                // Only applies while downed
                if (!(p.health <= 0)) continue;
                // Freeze once revive is ready to accept
                if ((p.reviveReadyFromId != null) && (Number(p.reviveReadyUntil) || 0) > nowMs) continue;
                // Pause while actively being revived (channel in progress)
                if (this._activeRevivesByTarget && this._activeRevivesByTarget.has(pid)) continue;
                // Decrement remaining time
                if (Number.isFinite(p.reviveWindowRemainingMs) && p.reviveWindowRemainingMs > 0) {
                    p.reviveWindowRemainingMs = Math.max(0, p.reviveWindowRemainingMs - dtMs);
                }
            }
        } catch(_) {}
    }
    // Helper: Clear DOTs and broadcast burn stopped when player dies
    /* COMMENTED OUT - Now using CombatManager (Phase 6)
    _handlePlayerDeath(pid, player, io) {
        if (!player || !pid) return;
        
        // Check if player had any DOTs active
        const hadDots = Array.isArray(player.dotStacks) && player.dotStacks.length > 0;
        
        // Clear DOT stacks on death
        if (hadDots) {
            player.dotStacks = [];
        }
        
        // Broadcast burn stopped if player was burning
        if (hadDots) {
            try {
                io.to(this.id).emit('vfxEvent', {
                    type: 'burnStateChanged',
                    playerId: pid,
                    burning: false,
                    x: player.x,
                    y: player.y
                });
                console.log(`[Server] Player ${pid.substring(0,8)} died - broadcasting burn stopped`);
            } catch(err) {
                console.error('[Server] Failed to broadcast burn stopped on death:', err);
            }
        }
    }
    */ // END _handlePlayerDeath
    
    /* COMMENTED OUT - Now using CombatManager (Phase 6)
    updatePlayerDots(deltaTime) {
        // Tick DOT stacks on all players and apply damage
        for (const [pid, player] of this.players) {
            if (!player || player.health <= 0) continue;
            if (!Array.isArray(player.dotStacks)) player.dotStacks = [];
            
            // Invisibility blood drain (weapon 5 secondary ability)
            if (player.invisible === true && player.invisibilityActiveTime) {
                // Get drain rate from weapon progression config based on player's loot level
                const lootLevel = player.lootLevel || 0;
                const progression = getWeaponProgression(4, lootLevel); // Weapon 5 is index 4
                const drainPerSecond = progression?.secondary?.bloodDrainPerSecond || 1; // Default to 1/s if not configured
                
                // Initialize invisibility drain timer if not exists
                if (!Number.isFinite(player._invisibilityDrainTimer)) {
                    player._invisibilityDrainTimer = 0;
                }
                
                // Accumulate time
                player._invisibilityDrainTimer += deltaTime;
                
                // Drain blood markers based on progression config
                // drainPerSecond determines how many markers to drain per second
                const drainInterval = 1.0 / drainPerSecond; // Time interval per marker drain
                
                if (player._invisibilityDrainTimer >= drainInterval) {
                    const markersToDeduct = Math.floor(player._invisibilityDrainTimer / drainInterval);
                    player._invisibilityDrainTimer -= markersToDeduct * drainInterval;
                    
                    const oldMarkers = player.bloodMarkers || 0;
                    player.bloodMarkers = Math.max(0, oldMarkers - markersToDeduct);
                    
                    // Log drain (throttled to avoid spam on high drain rates)
                    console.log(`[Invisibility] Drained ${markersToDeduct} blood from player ${player.id.substring(0,8)} (${drainPerSecond}/s rate), remaining: ${player.bloodMarkers}`);
                    
                    // Auto-deactivate when out of blood
                    if (player.bloodMarkers <= 0) {
                        player.invisible = false;
                        delete player.invisibilityActiveTime;
                        delete player._invisibilityDrainTimer;
                        
                        // Broadcast invisibility deactivation
                        io.to(this.id).emit('invisibilityState', {
                            playerId: player.id,
                            invisible: false
                        });
                        
                        console.log(`[Invisibility] Auto-deactivated for player ${player.id.substring(0,8)} (out of blood)`);
                    }
                }
            } else {
                // Reset timer when not invisible
                delete player._invisibilityDrainTimer;
            }
            
            // Initialize DOT accumulator and timer if needed
            if (!Number.isFinite(player._dotAccum)) player._dotAccum = 0;
            if (!Number.isFinite(player._dotTextTimer)) player._dotTextTimer = 0.15;
            
            const hadDots = player.dotStacks.length > 0;
            
            let totalDps = 0;
            // Tick all DOT stacks
            for (let i = player.dotStacks.length - 1; i >= 0; i--) {
                const dot = player.dotStacks[i];
                if (!dot) continue;
                
                dot.timeLeft -= deltaTime;
                if (dot.timeLeft <= 0) {
                    // DOT expired, remove it
                    player.dotStacks.splice(i, 1);
                } else {
                    // Accumulate DPS
                    totalDps += dot.dps || 0;
                }
            }
            
            const hasDots = player.dotStacks.length > 0;
            
            // Broadcast burn state changes for fire VFX
            if (hadDots && !hasDots) {
                // Player stopped burning
                io.to(this.id).emit('vfxEvent', {
                    type: 'burnStateChanged',
                    playerId: pid,
                    burning: false,
                    x: player.x,
                    y: player.y
                });
            }
            
            if (totalDps > 0) {
                // Check invincibility before applying DOT damage
                if (player.invincible !== true) {
                    const damage = totalDps * deltaTime;
                    player.health = Math.max(0, player.health - damage);
                    
                    // Accumulate damage for periodic damage text (like enemies)
                    player._dotAccum += damage;
                    
                    // Broadcast health update to all clients
                    try {
                        player.socket.emit('playerHealth', { health: player.health, from: 'dot' });
                        io.to(this.id).emit('playerHealthUpdate', { playerId: pid, health: player.health, from: 'dot' });
                    } catch(_) {}
                    
                    // Show DOT damage numbers periodically (every 0.15s) to avoid spam
                    player._dotTextTimer -= deltaTime;
                    if (player._dotTextTimer <= 0 && player._dotAccum > 0.5 && player.dotStacks.length > 0 && player.dotStacks[0].from) {
                        io.to(this.id).emit('pvpHit', {
                            victimId: pid,
                            attackerId: player.dotStacks[0].from,
                            damage: Math.round(player._dotAccum),
                            crit: false,
                            isDot: true,
                            x: player.x,
                            y: player.y
                        });
                        player._dotAccum = 0;
                        player._dotTextTimer = 0.15;
                    }
                }
                
                // Check for death
                if (player.health <= 0) {
                    console.log(`[Server] Player ${pid} killed by DOT`);
                    this._handlePlayerDeath(pid, player, io);
                }
            }
        }
    }
    */ // END updatePlayerDots
    
    /* COMMENTED OUT - Now using CombatManager (Phase 6)
    updatePlayerBullets(deltaTime) {
        // Update bullet positions and check for PvP collisions
        for (let i = this.playerBullets.length - 1; i >= 0; i--) {
            const bullet = this.playerBullets[i];
            
            // Store previous position for swept collision detection
            const oldX = bullet.x;
            const oldY = bullet.y;
            
            // Update bullet position
            bullet.x += bullet.vx * deltaTime;
            bullet.y += bullet.vy * deltaTime;
            bullet.life -= deltaTime;
            
            // Remove expired bullets
            if (bullet.life <= 0) {
                this.playerBullets.splice(i, 1);
                continue;
            }
            
            // Check collision with sandbags first (blocks bullets)
            if (this.hazards && typeof this.hazards.damageFromBulletLine === 'function') {
                // Weapon 4 cones: only spawn VFX 1/5 hits to reduce visual spam
                const vfxProb = (bullet.isCone && bullet.sourceWeaponIndex === 3) ? 0.2 : 1.0;
                const sbHit = this.hazards.damageFromBulletLine(oldX, oldY, bullet.x, bullet.y, bullet.damage || 10, vfxProb);
                if (sbHit) {
                    this.playerBullets.splice(i, 1);
                    continue;
                }
            }
            
            // Check collision with exploding barrels
            if (this.hazards && typeof this.hazards.damageBarrelFromBulletLine === 'function') {
                const barrelHit = this.hazards.damageBarrelFromBulletLine(oldX, oldY, bullet.x, bullet.y, bullet.damage || 10);
                if (barrelHit) {
                    this.playerBullets.splice(i, 1);
                    continue;
                }
            }

            // Check collision with all players (PvP friendly fire)
            let hit = false;
            for (const [targetId, target] of this.players) {
                // Skip dead players
                if (!target || target.health <= 0) continue;
                
                // Skip invincible players
                if (target.invincible === true) continue;
                
                // Skip the shooter (no self-damage)
                if (targetId === bullet.ownerId) continue;
                
                // Check if friendly fire is allowed (evil vs non-evil)
                const shooter = this.players.get(bullet.ownerId);
                if (!shooter) continue;
                
                const shooterIsEvil = bullet.ownerIsEvil;
                const targetIsEvil = target.isEvil || false;
                
                // Only allow damage if one is evil and the other is not
                if (shooterIsEvil === targetIsEvil) continue;
                
                // Use swept collision detection for fast bullets (weapon 7 @ 16000 speed)
                // Check if the line segment from old position to new position intersects the player circle
                const collisionDist = (target.radius || 26) + bullet.radius;
                
                // Vector from old to new position
                const dx = bullet.x - oldX;
                const dy = bullet.y - oldY;
                const segmentLength = Math.hypot(dx, dy);
                
                // Vector from old position to target
                const fx = target.x - oldX;
                const fy = target.y - oldY;
                
                let closestDist;
                if (segmentLength < 0.001) {
                    // Bullet barely moved, just check end position
                    closestDist = Math.hypot(target.x - bullet.x, target.y - bullet.y);
                } else {
                    // Project target onto bullet path to find closest point
                    const t = Math.max(0, Math.min(1, (fx * dx + fy * dy) / (segmentLength * segmentLength)));
                    const closestX = oldX + t * dx;
                    const closestY = oldY + t * dy;
                    closestDist = Math.hypot(target.x - closestX, target.y - closestY);
                }
                
                if (closestDist <= collisionDist) {
                    // Calculate damage with attack power and crit
                    let rawDmg = bullet.damage || 10;
                    rawDmg += bullet.attackPower || 0;
                    
                    // Roll for crit
                    let isCrit = false;
                    const critChance = Math.max(0, Math.min(1, bullet.critChance || 0));
                    if (Math.random() < critChance) {
                        isCrit = true;
                        rawDmg *= (bullet.critDamageMultiplier || 1.2);
                    }
                    
                    // Apply armor reduction
                    const armorPercent = Number.isFinite(target.armor) ? target.armor : 0;
                    const reduction = Math.min(0.75, armorPercent / 100);
                    const dmg = rawDmg * (1 - reduction);
                    
                    const healthBefore = target.health;
                    target.health = Math.max(0, target.health - dmg);
                    
                    // Extra logging for weapon 7 (fast bullets) to verify swept collision
                    const weaponInfo = bullet.sourceWeaponIndex === 6 ? ` [WEAPON7:swept=${segmentLength.toFixed(1)}u]` : '';
                    console.log(`[PvP] Player ${bullet.ownerId} (evil:${shooterIsEvil}) hit player ${targetId} (evil:${targetIsEvil}) for ${dmg.toFixed(1)} damage${isCrit ? ' [CRIT]' : ''}${weaponInfo}`);
                    
                    // Broadcast health update
                    try { 
                        target.socket.emit('playerHealth', { health: target.health, from: 'pvp' });
                    } catch(_) {}
                    io.to(this.id).emit('playerHealthUpdate', { 
                        playerId: targetId, 
                        health: target.health,
                        from: 'pvp',
                        attackerId: bullet.ownerId
                    });
                    
                    // Broadcast PvP hit event for visual feedback
                    io.to(this.id).emit('pvpHit', {
                        victimId: targetId,
                        attackerId: bullet.ownerId,
                        damage: Math.round(dmg),
                        crit: isCrit,
                        x: target.x,
                        y: target.y
                    });
                    
                    // Check for death
                    if (target.health <= 0 && healthBefore > 0) {
                        console.log(`[PvP] Player ${targetId} killed by player ${bullet.ownerId}`);
                        this._handlePlayerDeath(targetId, target, io);
                        io.to(this.id).emit('pvpKill', {
                            victimId: targetId,
                            killerId: bullet.ownerId,
                            x: target.x,
                            y: target.y
                        });
                    }
                    
                    hit = true;
                    break;
                }
            }
            
            // Remove bullet if it hit a player
            if (hit) {
                this.playerBullets.splice(i, 1);
            }
        }
    }
    */ // END updatePlayerBullets
    
    /* COMMENTED OUT - Now using CombatManager (Phase 6)
    updateBoomerPools(deltaTime) {
        try {
            if (!Array.isArray(this.boomerPools) || this.boomerPools.length === 0) {
                // Even if no pools, ensure slowed state decays to zero and clears when dead
                for (const [, p] of this.players) {
                    if (!p) continue;
                    if (p.health != null && p.health <= 0) {
                        if (p._svSlowTimer && p._svSlowTimer > 0) p._svSlowTimer = 0;
                    } else if (p._svSlowTimer && p._svSlowTimer > 0) {
                        p._svSlowTimer = Math.max(0, p._svSlowTimer - deltaTime);
                    }
                    const prev = !!p._svSlowed;
                    const now = (p._svSlowTimer || 0) > 0;
                    if (prev !== now) {
                        p._svSlowed = now;
                        io.to(this.id).emit('playerSlowState', { playerId: p.id, slowed: now });
                    }
                }
                return;
            }
            // Decay pools
            for (let i = this.boomerPools.length - 1; i >= 0; i--) {
                const pool = this.boomerPools[i];
                pool.ttl -= deltaTime;
                if (pool.ttl <= 0) this.boomerPools.splice(i, 1);
            }
            // Apply slow when inside any pool; persist for 4s after leaving
            for (const [, p] of this.players) {
                if (!p) continue;
                // Death clears immediately
                if (p.health != null && p.health <= 0) {
                    if (p._svSlowTimer && p._svSlowTimer > 0) p._svSlowTimer = 0;
                } else {
                    let inAny = false;
                    const pr = p.radius || 20;
                    for (let i = 0; i < this.boomerPools.length; i++) {
                        const pool = this.boomerPools[i];
                        const dx = (p.x || 0) - pool.x;
                        const dy = (p.y || 0) - pool.y;
                        const r = (pool.radius || 100) + pr;
                        if (dx*dx + dy*dy <= r*r) { inAny = true; break; }
                    }
                    if (inAny) p._svSlowTimer = 4.0; else if (p._svSlowTimer && p._svSlowTimer > 0) p._svSlowTimer = Math.max(0, p._svSlowTimer - deltaTime);
                }
                const prev = !!p._svSlowed;
                const now = (p._svSlowTimer || 0) > 0;
                if (prev !== now) {
                    p._svSlowed = now;
                    io.to(this.id).emit('playerSlowState', { playerId: p.id, slowed: now });
                }
            }
        } catch (e) {
            console.error('[Server] updateBoomerPools error:', e && e.stack ? e.stack : String(e));
        }
    }
    */ // END updateBoomerPools
    
    /* COMMENTED OUT - Now using PlayerPhysicsManager (Phase 7)
    updatePlayerStamina(player, input, deltaTime) {
        // Invincibility: stamina can only go up (no costs/drains/locks)
        let isInvincible = (player.invincible === true);
        // Countdown exhaustion timer regardless of input
        if (player.exhaustionTimer > 0) {
            player.exhaustionTimer -= deltaTime;
            if (player.exhaustionTimer < 0) player.exhaustionTimer = 0;
        }
        
        // Update dash cooldown
        if (player.dashCooldown > 0) {
            player.dashCooldown -= deltaTime;
            if (player.dashCooldown < 0) player.dashCooldown = 0;
        }
        
        // Update dash duration
        if (player.dashDuration > 0) {
            player.dashDuration -= deltaTime;
            if (player.dashDuration <= 0) {
                player.dashDuration = 0;
                player.dashActive = false;
                
                // End dash-tied invulnerability safely
                if (player._dashInvuln) {
                    player._dashInvuln = false;
                    player._invulnSources = Math.max(0, (player._invulnSources || 1) - 1);
                    player.invincible = !!player._manualInvincible || (player._invulnSources > 0);
                }
                
                // Log dash end with position delta
                if (player._dashStartPos) {
                    const endTime = Date.now();
                    const duration = endTime - player._dashStartPos.timestamp;
                    const dx = player.x - player._dashStartPos.x;
                    const dy = player.y - player._dashStartPos.y;
                    const distance = Math.hypot(dx, dy);
                    console.log(`[Server] [${endTime}] Ã°Å¸ÂÂ DASH ENDED for player ${player.id} | Start: (${player._dashStartPos.x.toFixed(1)}, ${player._dashStartPos.y.toFixed(1)}) | End: (${player.x.toFixed(1)}, ${player.y.toFixed(1)}) | Distance moved: ${distance.toFixed(1)} units | Duration: ${duration}ms`);
                    player._dashStartPos = null;
                }
            }
        }
        
        // Handle dash request (one-time event that needs to be cleared after processing)
        if (input.wantsDash) {
            const timestamp = Date.now();
            console.log(`[Server] [${timestamp}] Dash requested by player ${player.id} | Position: (${player.x.toFixed(1)}, ${player.y.toFixed(1)}) | Cooldown: ${player.dashCooldown.toFixed(2)}s | Active: ${player.dashActive} | Stamina: ${player.stamina.toFixed(1)}`);
            
            if (player.dashCooldown <= 0 && !player.dashActive && !player._weapon8ADS) { // Disable dash while ADS
                const dashCost = player.dashStaminaCost || 25;
                
                if (isInvincible || player.stamina >= dashCost) {
                    // Store position before dash for logging
                    const preX = player.x;
                    const preY = player.y;
                    
                    // Activate dash
                    if (!isInvincible) player.stamina -= dashCost;
                    player.dashActive = true;
                    player.dashDuration = player.dashMaxDuration || 0.2;
                    player.dashCooldown = player.dashCooldownMax || 1.5;
                    
                    // Begin dash-tied invulnerability
                    player._dashInvuln = true;
                    player._invulnSources = (player._invulnSources || 0) + 1;
                    player.invincible = true;
                    
                    // Store initial position for tracking
                    player._dashStartPos = { x: preX, y: preY, timestamp };
                    
                    console.log(`[Server] [${timestamp}] Ã¢Å“â€¦ DASH ACTIVATED for player ${player.id} | Position: (${preX.toFixed(1)}, ${preY.toFixed(1)}) | DashSpeed: ${(player.speed * player.dashSpeedMultiplier).toFixed(0)} (${player.dashSpeedMultiplier}x base) | Duration: ${player.dashDuration}s | Cooldown: ${player.dashCooldown}s | Stamina: ${player.stamina.toFixed(1)}`);
                    
                    // Broadcast dash activation to all clients in room
                    this.io.to(this.id).emit('playerDashed', {
                        playerId: player.id
                    });
                } else {
                    console.log(`[Server] [${timestamp}] Ã¢ÂÅ’ DASH DENIED - Not enough stamina for player ${player.id} | Need: 50 | Have: ${player.stamina.toFixed(1)}`);
                    // Not enough stamina - send feedback to requesting player only
                    if (player.socket) {
                        player.socket.emit('dashFeedback', {
                            message: 'OUT OF STAMINA',
                            color: '#ff4444'
                        });
                    }
                }
            } else {
                console.log(`[Server] [${timestamp}] Ã¢ÂÅ’ DASH DENIED - On cooldown or already active for player ${player.id}`);
            }
            
            // Clear the wantsDash flag after processing to prevent continuous triggering
            input.wantsDash = false;
        }

        // Dash can change invincibility state; re-sample before stamina drains
        isInvincible = (player.invincible === true);
        
        // Clear weapon 4 firing flag if no recent shots (100ms timeout) or mouse released
        if (player.isFiringWeapon4 && player._weapon4LastFired) {
            const timeSinceLastShot = Date.now() - player._weapon4LastFired;
            const mouseReleased = !input.mouseDown;
            if (timeSinceLastShot > 100 || mouseReleased) {
                player.isFiringWeapon4 = false;
            }
        }
        
        // Clear mustReleaseFire latch when mouse is released AND stamina has recharged slightly
        if (player.mustReleaseFire && !input.mouseDown && player.stamina > 0) {
            player.mustReleaseFire = false;
        }
        
        // Calculate movement and sprint state
        const isMoving = input.keys.KeyW || input.keys.KeyS || input.keys.KeyA || input.keys.KeyD;
        const wantsSprint = input.keys.ShiftLeft || input.keys.ShiftRight;
        const staminaDrainThisFrame = player.staminaDrainPerSecond * deltaTime;
        const tryingToSprint = wantsSprint && isMoving && !player.mustReleaseShift && !player._weapon8ADS; // Disable sprint while ADS
        const canSprint = tryingToSprint && (isInvincible || ((player.stamina > staminaDrainThisFrame) && (player.exhaustionTimer === 0)));
        
        // Store server sprint state for movement calculations
        player.serverSprintActive = canSprint;
        
        if (canSprint && !isInvincible) {
            // Drain stamina while sprinting
            player.stamina -= staminaDrainThisFrame;
            if (player.stamina <= 0) {
                player.stamina = 0;
                player.mustReleaseShift = true; // lock sprint until Shift is released
                player.exhaustionTimer = player.exhaustionCooldownSeconds; // start exhaustion delay
            }
        }
        
        // Additional drain when firing weapon 4: multiplier based on loot level
        if (player.isFiringWeapon4 && !player.mustReleaseFire && !isInvincible) {
            // Get loot-based stamina drain multiplier for weapon 4
            const lootLevel = player.lootLevel || 0;
            const progression = getWeaponProgression(3, lootLevel);
            const staminaDrainMultiplier = progression.primary?.staminaDrainMultiplier || 1.0;
            
            // Track firing start time
            if (!player._weapon4FiringStartTime) {
                player._weapon4FiringStartTime = Date.now();
                player._weapon4InitialStamina = player.stamina;
            }
            
            // Base drain is 0.5x sprint rate, then multiplied by loot progression
            player.stamina -= staminaDrainThisFrame * 0.5 * staminaDrainMultiplier;
            if (player.stamina <= 0) {
                player.stamina = 0;
                player.mustReleaseFire = true; // lock firing until mouse released and some recharge
                player.exhaustionTimer = player.exhaustionCooldownSeconds; // start exhaustion delay
                player._weapon4FiringStartTime = null;
            }

            // Weapon 4 sandbag damage now handled by individual cone projectile collisions (see updatePlayerBullets)
        } else if (player._weapon4FiringStartTime) {
            // Firing stopped
            player._weapon4FiringStartTime = null;
        }

        // Weapon 1 melee: apply hazard damage using the SAME cone system as enemy collision
        // (loot-scaled coneRange/coneHalf), instead of a fixed small circle.
        try {
            if (player.isFiringWeapon1) {
                const now = Date.now();
                if (!Number.isFinite(player._w1HazardNext) || now >= player._w1HazardNext) {
                    const ang = Number.isFinite(player.aimAngle) ? player.aimAngle : 0;
                    const ox = (player.x || 0);
                    const oy = (player.y || 0);

                    // Match client weapon1 base values:
                    // weapon1 projectileRadius=40 -> baseConeRange=40*3=120, baseConeHalf=0.6
                    const lootLevel = player.lootLevel || 0;
                    const prog = (typeof getWeaponProgression === 'function') ? (getWeaponProgression(0, lootLevel) || {}) : {};
                    const primaryMods = (prog && prog.primary) ? prog.primary : {};
                    const coneRange = 120 * (primaryMods.coneRangeMultiplier || 1.0);
                    const coneHalf = 0.6 * (primaryMods.coneHalfMultiplier || 1.0);

                    const dmg = 40; // single swing damage to hazards

                    if (this.hazards) {
                        // Prefer true cone checks (weapon1 behavior)
                        if (typeof this.hazards.damageSandbagsInCone === 'function') {
                            this.hazards.damageSandbagsInCone(ox, oy, ang, coneRange, coneHalf, dmg);
                        } else if (typeof this.hazards.damageCircle === 'function') {
                            // Fallback to previous behavior (should be unreachable after update)
                            const cx = ox + Math.cos(ang) * 70;
                            const cy = oy + Math.sin(ang) * 70;
                            this.hazards.damageCircle(cx, cy, 60, dmg);
                        }

                        if (typeof this.hazards.damageBarrelsInCone === 'function') {
                            this.hazards.damageBarrelsInCone(ox, oy, ang, coneRange, coneHalf, dmg);
                        } else if (typeof this.hazards.damageBarrelInRadius === 'function') {
                            // Fallback to previous behavior
                            const cx = ox + Math.cos(ang) * 70;
                            const cy = oy + Math.sin(ang) * 70;
                            this.hazards.damageBarrelInRadius(cx, cy, 60, dmg);
                        }
                    }

                    player._w1HazardNext = now + 150; // 150ms gate
                }
            }
        } catch(_) {}
        
        // Attempting to sprint with too little stamina: trigger exhaustion
        if (!isInvincible && tryingToSprint && player.stamina > 0 && player.stamina <= staminaDrainThisFrame) {
            player.stamina = 0;
            player.mustReleaseShift = true;
            player.exhaustionTimer = player.exhaustionCooldownSeconds;
        } else {
            if (isInvincible) {
                player.exhaustionTimer = 0;
                player.mustReleaseShift = false;
                player.mustReleaseFire = false;
                player.stamina += player.staminaRechargePerSecond * deltaTime;
                if (player.stamina > player.staminaMax) player.stamina = player.staminaMax;
            } else {
                // Only recharge when Shift is NOT held and not firing weapons that use stamina
                if (!wantsSprint && !player.isFiringWeapon4 && !player.isFiringWeapon1) {
                    // Wait for exhaustion to end before recharging
                    if (player.exhaustionTimer === 0) {
                        player.stamina += player.staminaRechargePerSecond * deltaTime;
                        if (player.stamina > player.staminaMax) player.stamina = player.staminaMax;
                        // Clear latch once Shift is released and stamina is > 0
                        if (player.mustReleaseShift && player.stamina > 0) player.mustReleaseShift = false;
                        if (player.mustReleaseFire && player.stamina > 0) player.mustReleaseFire = false;
                    }
                }
            }
        }
    }
    updatePlayerMovement(player, input, deltaTime) {
        const speed = player.speed;
        let vx = 0, vy = 0;
        
        // Store position before movement for debugging
        const beforePos = { x: player.x, y: player.y };
        
        // Handle knockback first (takes priority over input movement)
        if (player.kbTime && player.kbTime > 0) {
            const step = Math.min(player.kbTime, deltaTime);
            const kbVelX = Number.isFinite(player.kbVelX) ? player.kbVelX : 0;
            const kbVelY = Number.isFinite(player.kbVelY) ? player.kbVelY : 0;
            const dx = kbVelX * step;
            const dy = kbVelY * step;
            
            // Apply knockback movement with collision
            // Use substeps for large knockback to prevent phasing through rotated walls
            if (this.environment && this.environment.resolveCircleMove) {
                const radius = player.radius || 26;
                
                // Break large knockback into smaller steps for better collision with rotated walls
                const knockbackDist = Math.hypot(dx, dy);
                const maxStepSize = 10; // Max step size per iteration
                const steps = Math.max(1, Math.ceil(knockbackDist / maxStepSize));
                const stepX = dx / steps;
                const stepY = dy / steps;
                
                let currentX = player.x;
                let currentY = player.y;
                
                for (let i = 0; i < steps; i++) {
                    const resolved = this.environment.resolveCircleMove(currentX, currentY, radius, stepX, stepY);
                    currentX = resolved.x;
                    currentY = resolved.y;
                }
                
                player.x = currentX;
                player.y = currentY;
            } else {
                player.x += dx;
                player.y += dy;
            }
            
            // Decay knockback time
            player.kbTime -= deltaTime;
            if (player.kbTime < 0) {
                player.kbTime = 0;
                player.kbVelX = 0;
                player.kbVelY = 0;
            }
            
            // Update aim angle even during knockback
            if (typeof input.aimAngle === 'number') {
                player.aimAngle = input.aimAngle;
            }
            return; // Skip normal movement during knockback
        }
        
        // Handle WASD movement
        if (input.keys.KeyW) vy -= 1;
        if (input.keys.KeyS) vy += 1;
        if (input.keys.KeyA) vx -= 1;
        if (input.keys.KeyD) vx += 1;
        
        // Normalize diagonal movement
        if (vx !== 0 && vy !== 0) {
            const mag = Math.sqrt(vx * vx + vy * vy);
            vx /= mag;
            vy /= mag;
        }
        
        // Use server-authoritative sprint state from stamina system
        const sprinting = player.serverSprintActive || false;
        let actualSpeed = sprinting ? speed * 2 : speed;
        
        // Apply dash speed boost (overrides sprint, highest priority)
        if (player.dashActive && player.dashDuration > 0) {
            actualSpeed = speed * (player.dashSpeedMultiplier || 4.0);
            // Log every 3rd frame to avoid spam
            if (!player._dashLogCounter) player._dashLogCounter = 0;
            player._dashLogCounter++;
            if (player._dashLogCounter % 3 === 0) {
                console.log(`[Server] Ã°Å¸â€™Â¨ DASH MOVEMENT: Player ${player.id} | BaseSpeed: ${speed} | DashSpeed: ${actualSpeed} | Multiplier: ${player.dashSpeedMultiplier}x | Duration left: ${player.dashDuration.toFixed(3)}s | Position: (${player.x.toFixed(1)}, ${player.y.toFixed(1)})`);
            }
        } else {
            player._dashLogCounter = 0;
        }
        
        // Apply boomer puke pool slow (50% speed reduction)
        if (player._svSlowed) {
            actualSpeed *= 0.5;
        }
        
        // Apply ensnare slow (40% speed reduction when ensnared by Licker)
        if (player._ensnaredTimer && player._ensnaredTimer > 0) {
            actualSpeed *= 0.6;
        }
        
        // Apply basic zombie melee slow (15% per zombie, stacks up to 5 zombies for 75% max slow, 0.5s linger)
        // Check in real-time during movement, not from previous frame's contact damage
        let basicZombieSlowCount = 0;
        if (this.enemies && this.enemies.size > 0) {
            const pr = player.radius || 26;
            const px = Number(player.x) || 0;
            const py = Number(player.y) || 0;
            
            for (const [, enemy] of this.enemies) {
                if (!enemy || enemy.alive === false) continue;
                if (enemy.type !== 'basic') continue;
                
                const er = Number.isFinite(enemy.radius) ? enemy.radius : 26;
                const sumR = er + pr;
                const dx = px - (Number(enemy.x) || 0);
                const dy = py - (Number(enemy.y) || 0);
                const distSq = dx * dx + dy * dy;
                
                // Check if zombie is in melee range
                if (distSq <= sumR * sumR) {
                    basicZombieSlowCount++;
                }
            }
        }

        // Initialize slow state if needed
        if (!player._basicZombieSlow) player._basicZombieSlow = { timer: 0, count: 0 };
        
        if (basicZombieSlowCount > 0) {
            const slowPerZombie = 0.15; // 15% slow per zombie
            const maxZombies = 5; // Cap at 5 zombies for max effect
            const zombieCount = Math.min(basicZombieSlowCount, maxZombies);
            
            // Refresh timer and count when zombies are hitting
            player._basicZombieSlow.count = zombieCount;
            player._basicZombieSlow.timer = 0.5; // 0.5 second linger duration
            
            const slowMultiplier = 1 - (slowPerZombie * zombieCount); // 0.85 for 1 zombie, 0.25 for 5 zombies
            actualSpeed *= slowMultiplier;
        } else {
            // Decay timer when no zombies in range, but keep applying slow until timer expires
            if (player._basicZombieSlow.timer > 0) {
                player._basicZombieSlow.timer -= deltaTime;
                if (player._basicZombieSlow.timer <= 0) {
                    player._basicZombieSlow.timer = 0;
                    player._basicZombieSlow.count = 0;
                } else {
                    // Still apply slow from previous zombie hits
                    const slowPerZombie = 0.15;
                    const maxZombies = 5;
                    const zombieCount = Math.min(player._basicZombieSlow.count, maxZombies);
                    const slowMultiplier = 1 - (slowPerZombie * zombieCount);
                    actualSpeed *= slowMultiplier;
                }
            }
        }
        
        // Apply weapon 8 ADS slow (40% speed when aiming down sights)
        // Set player property for consistent pattern with other slows
        player._weapon8ADS = (input && input.isWeapon8ADS === true);
        if (player._weapon8ADS) {
            actualSpeed *= 0.4;
        }
        
        // Apply environment hazard speed multiplier (set each frame by hazards.update)
        if (Number.isFinite(player._hazardSpeedMul) && player._hazardSpeedMul > 0 && player._hazardSpeedMul !== 1) {
            actualSpeed *= player._hazardSpeedMul;
        }

        // Calculate movement delta
        const dx = vx * actualSpeed * deltaTime;
        const dy = vy * actualSpeed * deltaTime;
        const intendedPos = { x: player.x + dx, y: player.y + dy };
        
        // Apply collision detection using server environment (must match client exactly)
        if (this.environment && this.environment.resolveCircleMove && (dx !== 0 || dy !== 0)) {
            const radius = player.radius || 26; // Default player radius
            
            // Substep large movements (dash/sprint/low-FPS spikes) to prevent tunneling through thin/rotated walls
            const moveDist = Math.hypot(dx, dy);
            const maxStepSize = 10; // pixels per substep (smaller = safer, more CPU)
            const steps = Math.max(1, Math.ceil(moveDist / maxStepSize));
            const stepX = dx / steps;
            const stepY = dy / steps;
            
            let currentX = player.x;
            let currentY = player.y;
            let mergedHits = null;
            const addHits = (hits) => {
                if (!Array.isArray(hits) || hits.length === 0) return;
                if (!mergedHits) mergedHits = [];
                for (let i = 0; i < hits.length && mergedHits.length < 6; i++) mergedHits.push(hits[i]);
            };
            
            for (let i = 0; i < steps; i++) {
                const stepRes = (typeof this.environment.resolveCircleMoveWithHits === 'function')
                    ? this.environment.resolveCircleMoveWithHits(currentX, currentY, radius, stepX, stepY)
                    : this.environment.resolveCircleMove(currentX, currentY, radius, stepX, stepY);
                
                currentX = stepRes.x;
                currentY = stepRes.y;
                addHits(stepRes.hits);
            }
            
            const resolved = { x: currentX, y: currentY };
            if (mergedHits) resolved.hits = mergedHits;
            
            // Debug: Track collision detection
            serverDebugger.serverCollisionDetection(
                player.id, 
                beforePos, 
                intendedPos, 
                resolved, 
                this.scene,
                this.environment.obstacles?.length || 0
            );

            // Record "blocked by" details for client-side debugging when collision reduces movement
            try {
                const intendedDist = Math.hypot(dx, dy);
                const actualDx = resolved.x - beforePos.x;
                const actualDy = resolved.y - beforePos.y;
                const actualDist = Math.hypot(actualDx, actualDy);
                const blocked = (
                    (Math.abs((resolved.x || 0) - (intendedPos.x || 0)) > 0.25) ||
                    (Math.abs((resolved.y || 0) - (intendedPos.y || 0)) > 0.25) ||
                    (intendedDist > 0.001 && actualDist < intendedDist * 0.85)
                );
                if (blocked) {
                    const hits = Array.isArray(resolved.hits) ? resolved.hits.slice(0, 6) : [];
                    player._blockedBy = {
                        t: Date.now(),
                        intended: { x: intendedPos.x, y: intendedPos.y },
                        resolved: { x: resolved.x, y: resolved.y },
                        hits
                    };
                } else {
                    // Decay stale blockedBy info quickly to avoid false positives
                    if (player._blockedBy && (Date.now() - (player._blockedBy.t || 0)) > 200) {
                        player._blockedBy = null;
                    }
                }
            } catch(_) {}
            
            player.x = resolved.x;
            player.y = resolved.y;
        } else {
            // Fallback: direct movement without collision (shouldn't happen in normal gameplay)
            player.x += dx;
            player.y += dy;
            
            // Basic boundary enforcement as fallback
            const boundary = this.boundary;
            player.x = Math.max(-boundary, Math.min(boundary, player.x));
            player.y = Math.max(-boundary, Math.min(boundary, player.y));
        }
        
        // Debug: Track final movement calculation
        const afterPos = { x: player.x, y: player.y };
        serverDebugger.serverMovementCalculation(player.id, beforePos, afterPos, deltaTime, input, sprinting);
        
        // Update breadcrumb trail
        this.updateBreadcrumbs(player, beforePos, afterPos);
        
        // Update aim angle
        if (typeof input.aimAngle === 'number') {
            player.aimAngle = input.aimAngle;
        }
    }
    */ // END updatePlayerMovement
    
    /* COMMENTED OUT - Now using PlayerPhysicsManager (Phase 7)
    updateBreadcrumbs(player, beforePos, afterPos) {
        // Only track breadcrumbs in Trench Raid mode
        if (this.scene !== 'level' || this.levelType !== 'trenchraid') {
            return;
        }
        
        // Calculate distance moved this frame
        const distMoved = Math.hypot(afterPos.x - beforePos.x, afterPos.y - beforePos.y);
        
        // Update total distance moved
        player.totalDistanceMoved += distMoved;
        
        // Only start tracking breadcrumbs after 100 units of movement
        if (player.totalDistanceMoved < 100) {
            return;
        }
        
        // Initialize breadcrumbs array if needed
        if (!player.breadcrumbs) {
            player.breadcrumbs = [];
            player.lastBreadcrumbX = beforePos.x;
            player.lastBreadcrumbY = beforePos.y;
        }
        
        // Add breadcrumb if player has moved at least 300 units from last breadcrumb (1/10th rate)
        const distFromLastCrumb = Math.hypot(afterPos.x - player.lastBreadcrumbX, afterPos.y - player.lastBreadcrumbY);
        
        if (distFromLastCrumb >= 300) {
            // Add new breadcrumb point
            player.breadcrumbs.push({ x: afterPos.x, y: afterPos.y });
            player.lastBreadcrumbX = afterPos.x;
            player.lastBreadcrumbY = afterPos.y;
            
            // Simplify the path every 10 breadcrumbs to remove redundant waypoints
            if (player.breadcrumbs.length >= 10 && player.breadcrumbs.length % 10 === 0) {
                player.breadcrumbs = this._simplifyBreadcrumbPath(player.breadcrumbs);
            }
            
            // Limit breadcrumbs to last 200 points to prevent memory issues
            if (player.breadcrumbs.length > 200) {
                player.breadcrumbs.shift();
            }
        }
    }
    
    // Helper method: Simplify breadcrumb path using line-of-sight checks
    // Removes waypoints that can be skipped without hitting obstacles
    _simplifyBreadcrumbPath(breadcrumbs) {
        if (breadcrumbs.length <= 2) return breadcrumbs;
        
        const simplified = [breadcrumbs[0]]; // Always keep first point
        
        for (let i = 1; i < breadcrumbs.length - 1; i++) {
            const prev = simplified[simplified.length - 1];
            const current = breadcrumbs[i];
            const next = breadcrumbs[i + 1];
            
            // Check if we can skip current waypoint (direct line from prev to next)
            const canSkip = this._hasLineOfSight(prev, next);
            
            if (!canSkip) {
                // This waypoint is necessary (blocks line of sight)
                simplified.push(current);
            }
            // If canSkip is true, we omit current waypoint (path goes directly from prev to next)
        }
        
        // Always keep last point
        simplified.push(breadcrumbs[breadcrumbs.length - 1]);
        
        return simplified;
    }
    */ // END _simplifyBreadcrumbPath
    
    /* COMMENTED OUT - Now using PlayerPhysicsManager (Phase 7)
    // Check if there's a clear line of sight between two points (no obstacles blocking)
    _hasLineOfSight(pointA, pointB) {
        if (!this.environment || !this.environment.obstacles) {
            return true; // No obstacles, always clear
        }
        
        // Sample points along the line and check for collisions
        const dx = pointB.x - pointA.x;
        const dy = pointB.y - pointA.y;
        const dist = Math.hypot(dx, dy);
        const steps = Math.ceil(dist / 50); // Check every 50 units
        
        for (let i = 1; i < steps; i++) {
            const t = i / steps;
            const checkX = pointA.x + dx * t;
            const checkY = pointA.y + dy * t;
            
            // Check if this point collides with any obstacle
            // Using a small radius to represent player size
            const testRadius = 30;
            
            // Check circular obstacles
            for (const obs of this.environment.obstacles) {
                const obstacleDistSq = (checkX - obs.x) ** 2 + (checkY - obs.y) ** 2;
                const minDist = obs.radius + testRadius;
                if (obstacleDistSq < minDist * minDist) {
                    return false; // Collision detected
                }
            }
            
            // Check oriented boxes (walls, barriers)
            if (this.environment.orientedBoxes) {
                for (const box of this.environment.orientedBoxes) {
                    // Skip shield walls (they're temporary player abilities)
                    if (box._abilityId) continue;
                    
                    // Simple AABB check for axis-aligned boxes
                    if (box.angle === 0 || box.angle === undefined) {
                        const halfW = box.w / 2;
                        const halfH = box.h / 2;
                        
                        if (checkX >= box.x - halfW - testRadius &&
                            checkX <= box.x + halfW + testRadius &&
                            checkY >= box.y - halfH - testRadius &&
                            checkY <= box.y + halfH + testRadius) {
                            return false; // Collision detected
                        }
                    }
                    // For rotated boxes, use more complex check
                    else {
                        // Simplified rotated rectangle check
                        const cos = Math.cos(-box.angle);
                        const sin = Math.sin(-box.angle);
                        const relX = checkX - box.x;
                        const relY = checkY - box.y;
                        const rotX = relX * cos - relY * sin;
                        const rotY = relX * sin + relY * cos;
                        
                        const halfW = box.w / 2;
                        const halfH = box.h / 2;
                        
                        if (Math.abs(rotX) <= halfW + testRadius &&
                            Math.abs(rotY) <= halfH + testRadius) {
                            return false; // Collision detected
                        }
                    }
                }
            }
        }
        
        return true; // No collisions, line of sight is clear
    }
    */ // END _hasLineOfSight
    
    /* COMMENTED OUT - Now using NetworkManager (Phase 3)
    getGameState() {
        const players = [];
        let maxInputSeq = 0;

        for (const [id, player] of this.players) {
            players.push({
                id: player.id,
                x: player.x,
                y: player.y,
                radius: player.radius,
                health: player.health,
                healthMax: player.healthMax,
                aimAngle: player.aimAngle,
                stamina: player.stamina,
                staminaMax: player.staminaMax,
                exhaustionTimer: player.exhaustionTimer,
                mustReleaseShift: player.mustReleaseShift,
                mustReleaseFire: player.mustReleaseFire,
                serverSprintActive: player.serverSprintActive || false,
                _ensnaredTimer: player._ensnaredTimer || 0,
                _ensnaredById: player._ensnaredById || null,
                _weapon8ADS: player._weapon8ADS || false,
                // Send _ensnaredBy Map as object for client contact damage detection
                _ensnaredByMap: player._ensnaredBy ? Object.fromEntries(player._ensnaredBy) : {},
                // Basic zombie melee slow (for client visual effects)
                _basicZombieSlowCount: (player._basicZombieSlow && player._basicZombieSlow.timer > 0) ? player._basicZombieSlow.count : 0,
                // Derived stats from inventory (server-authoritative)
                speed: player.speed,
                armor: player.armor,
                attackSpeed: player.attackSpeed,
                attackPower: player.attackPower,
                critChance: player.critChance,
                critDamageMultiplier: player.critDamageMultiplier,
                // Evil/heretic conversion state for visual replication and PvP
                evilProgress: player.evilProgress || 0,
                evilLocked: player.evilLocked || false,
                isEvil: player.isEvil || false,
                // Invisibility state (weapon 5 secondary ability)
                invisible: player.invisible || false,
                // Currency wallet
                ducats: player.ducats || 0,
                bloodMarkers: player.bloodMarkers || 0,
                victoryPoints: player.victoryPoints || 0,
                // Loot progression
                lootLevel: player.lootLevel || 0,
                // Quartermaster: whether this player already received the one-time supply bundle
                qmGrantedSupplies: !!player._qmGrantedSupplies,
                // Knockback state (for BigBoy dash and other knockback effects)
                kbTime: player.kbTime || 0,
                kbVelX: player.kbVelX || 0,
                kbVelY: player.kbVelY || 0,
                // Dash state
                dashActive: player.dashActive || false,
                dashDuration: player.dashDuration || 0,
                dashCooldown: player.dashCooldown || 0,
                // Cosmetics
                equippedHat: player.equippedHat || null,
                equippedSkin: player.equippedSkin || null,
                // Revive system
                downedAt: player.downedAt || 0,
                reviveWindowRemainingMs: Number.isFinite(player.reviveWindowRemainingMs) ? player.reviveWindowRemainingMs : 0,
                reviveProgress: (() => {
                    try {
                        const st = this._activeRevivesByTarget ? this._activeRevivesByTarget.get(player.id) : null;
                        if (!st) return 0;
                        return Math.max(0, Math.min(1, (Date.now() - st.startedAt) / 4000));
                    } catch(_) { return 0; }
                })(),
                reviveReviverId: (() => {
                    try {
                        const st = this._activeRevivesByTarget ? this._activeRevivesByTarget.get(player.id) : null;
                        return st ? st.reviverId : null;
                    } catch(_) { return null; }
                })(),
                // Revive ready state (broadcast so other clients can suppress re-revive prompts)
                reviveReadyUntil: player.reviveReadyUntil || 0,
                reviveReadyFromId: player.reviveReadyFromId || null,
                // Breadcrumb trail for pathfinding visualization
                breadcrumbs: player.breadcrumbs || []
                ,
                // Collision debug (server-authoritative): what blocked this player's movement most recently
                blockedBy: player._blockedBy || null
            });
            if (player.lastInput && player.lastInput.sequence > maxInputSeq) {
                maxInputSeq = player.lastInput.sequence;
            }
        }

        // Calculate artillery barrage state for Trench Raid mode
        let artilleryBarrageElapsedMs = 0;
        let artilleryBarrageActive = false;
        if (this.levelStartTime && this.levelType === 'trenchraid') {
            // Use frozen elapsed time if extraction completed, otherwise calculate live
            if (this.artilleryFrozenElapsedMs !== null) {
                artilleryBarrageElapsedMs = this.artilleryFrozenElapsedMs;
            } else {
                // Subtract bonus time from elapsed (bonus time effectively pushes the deadline forward)
                // Allow negative values so timer can exceed initial 9 minutes when bonus is added early
                artilleryBarrageElapsedMs = Date.now() - this.levelStartTime - this.artilleryBonusTimeMs;
            }
            artilleryBarrageActive = artilleryBarrageElapsedMs >= 9 * 60 * 1000; // 9 minutes
        }
        
        return {
            tick: this.tickCount,
            timestamp: Date.now(),
            players,
            lastProcessedInputSeq: maxInputSeq,
            // Artillery barrage timer sync for Trench Raid mode
            artilleryBarrageElapsedMs: this.levelType === 'trenchraid' ? artilleryBarrageElapsedMs : undefined,
            artilleryBarrageActive: this.levelType === 'trenchraid' ? artilleryBarrageActive : undefined
        };
    }
    */ // END getGameState
    
    /* COMMENTED OUT - Now using NetworkManager (Phase 3)
    // Delta state updates - sends only changed properties (60-70% bandwidth reduction)
    getGameStateDelta() {
        const delta = { 
            tick: this.tickCount,
            timestamp: Date.now(), 
            players: {},
            isFull: false
        };
        
        // Send full state every N frames for reliability (handles new players, dropped packets)
        this._fullStateBroadcastCounter++;
        if (this._fullStateBroadcastCounter >= this._fullStateBroadcastInterval) {
            this._fullStateBroadcastCounter = 0;
            delta.isFull = true;
            return this.getGameState(); // Send full state
        }
        
        // Otherwise send only changes
        let maxInputSeq = 0;
        for (const [id, player] of this.players) {
            const last = this._lastBroadcastState.get(id);
            const changes = { id };
            
            // Only include changed properties (threshold 0.1 for position to avoid micro-updates)
            if (!last || Math.abs(player.x - last.x) > 0.1) changes.x = player.x;
            if (!last || Math.abs(player.y - last.y) > 0.1) changes.y = player.y;
            if (!last || player.health !== last.health) changes.health = player.health;
            if (!last || player.healthMax !== last.healthMax) changes.healthMax = player.healthMax;
            if (!last || player.stamina !== last.stamina) changes.stamina = player.stamina;
            if (!last || player.staminaMax !== last.staminaMax) changes.staminaMax = player.staminaMax;
            if (!last || Math.abs(player.aimAngle - last.aimAngle) > 0.01) changes.aimAngle = player.aimAngle;
            if (!last || player._ensnaredTimer !== last._ensnaredTimer) changes._ensnaredTimer = player._ensnaredTimer;
            if (!last || player._ensnaredById !== last._ensnaredById) changes._ensnaredById = player._ensnaredById;
            if (!last || player._weapon8ADS !== last._weapon8ADS) changes._weapon8ADS = player._weapon8ADS;
            const basicZombieSlowCount = (player._basicZombieSlow && player._basicZombieSlow.timer > 0) ? player._basicZombieSlow.count : 0;
            const lastBasicZombieSlowCount = (last && last._basicZombieSlowCount) || 0;
            if (!last || basicZombieSlowCount !== lastBasicZombieSlowCount) changes._basicZombieSlowCount = basicZombieSlowCount;
            if (!last || player.evilProgress !== last.evilProgress) changes.evilProgress = player.evilProgress;
            if (!last || player.evilLocked !== last.evilLocked) changes.evilLocked = player.evilLocked;
            if (!last || player.isEvil !== last.isEvil) changes.isEvil = player.isEvil;
            if (!last || player.invisible !== last.invisible) changes.invisible = player.invisible;
            if (!last || player.lootLevel !== last.lootLevel) changes.lootLevel = player.lootLevel;
            if (!last || player.serverSprintActive !== last.serverSprintActive) changes.serverSprintActive = player.serverSprintActive;
            if (!last || player.mustReleaseFire !== last.mustReleaseFire) changes.mustReleaseFire = player.mustReleaseFire;
            if (!last || player.dashActive !== last.dashActive) changes.dashActive = player.dashActive;
            if (!last || player.dashDuration !== last.dashDuration) changes.dashDuration = player.dashDuration;
            if (!last || player.dashCooldown !== last.dashCooldown) changes.dashCooldown = player.dashCooldown;
            if (!last || JSON.stringify(player.equippedHat) !== JSON.stringify(last.equippedHat)) changes.equippedHat = player.equippedHat;
            
            // Only send if there are actual changes (beyond just the id)
            if (Object.keys(changes).length > 1) {
                delta.players[id] = changes;
            }
            
            // Store current state for next comparison
            this._lastBroadcastState.set(id, {
                x: player.x,
                y: player.y,
                health: player.health,
                healthMax: player.healthMax,
                stamina: player.stamina,
                staminaMax: player.staminaMax,
                aimAngle: player.aimAngle,
                _ensnaredTimer: player._ensnaredTimer,
                _ensnaredById: player._ensnaredById,
                _weapon8ADS: player._weapon8ADS,
                _basicZombieSlowCount: (player._basicZombieSlow && player._basicZombieSlow.timer > 0) ? player._basicZombieSlow.count : 0,
                evilProgress: player.evilProgress,
                evilLocked: player.evilLocked,
                isEvil: player.isEvil,
                invisible: player.invisible,
                lootLevel: player.lootLevel,
                serverSprintActive: player.serverSprintActive,
                mustReleaseFire: player.mustReleaseFire,
                dashActive: player.dashActive,
                dashDuration: player.dashDuration,
                dashCooldown: player.dashCooldown,
                equippedHat: player.equippedHat,
                equippedSkin: player.equippedSkin
            });
            
            if (player.lastInput && player.lastInput.sequence > maxInputSeq) {
                maxInputSeq = player.lastInput.sequence;
            }
        }
        
        delta.lastProcessedInputSeq = maxInputSeq;
        return delta;
    }
    */ // END getGameStateDelta
    
    /* COMMENTED OUT - Now using NetworkManager (Phase 3)
    broadcastGameState() {
        if (this.players.size > 0) {
            // Back to full state updates (delta system had player removal bugs)
            const gameState = this.getGameState();
            serverDebugger.gameStateUpdate(this.id, this.players.size, this.tickCount);

            let payloadBytes = 0;
            if (DEBUG_BUILD && typeof Buffer !== 'undefined' && typeof Buffer.byteLength === 'function') {
                try {
                    payloadBytes = Buffer.byteLength(JSON.stringify(gameState), 'utf8');
                } catch (err) {
                    serverDebugger.warn('NETWORKING', `[NET] Failed to measure payload for room ${this.id}`, {
                        error: err && err.message ? err.message : String(err)
                    });
                }
            }

            io.to(this.id).emit('gameState', gameState);
            serverDebugger.roomBroadcast(this.id, this.players.size, payloadBytes);
        }
    }
    */ // END broadcastGameState
    
    /* COMMENTED OUT - Now using NetworkManager (Phase 3)
    // Broadcast low-priority state (10Hz) for non-critical data like timers, chests, UI
    broadcastLowPriorityState() {
        // Only broadcast if there are players in the room
        if (this.players.size === 0) return;
        
        // Ready timer updates (lobby countdown)
        if (this.readyTimer && this.readyTimer.started && !this.readyTimer.completed) {
            this.emitReadyTimerState();
        }
        
        // Chest timer updates (gold chest opening progress)
        for (const chest of this.chests.values()) {
            if (chest.opening && !chest.opened && chest.variant !== 'brown') {
                // Chest timers are already broadcast in tick() - we could move them here
                // but for now, just ensure we're not duplicating
            }
        }
        
        // Ambient spawner state (for debug HUD)
        try {
            if (this.ambientSpawner) {
                const st = this.ambientSpawner.getDebugState();
                io.to(this.id).emit('ambientState', st);
            }
        } catch(_) {}

        // Could add other low-priority updates here:
        // - Target dummy regen status
        // - NPC ambient animations/states
        // - Environmental effects that aren't time-critical
    }
    */ // END broadcastLowPriorityState

    spawnHorde(enemyCount = 12, options = {}) {
        if (!this.hordeSpawner) {
            console.warn('[GameRoom] Horde spawn requested but HordeSpawner missing');
            return null;
        }

        const count = Math.max(1, Math.min(500, Math.floor(Number(enemyCount) || 0) || 0)) || 12;
        const result = this.hordeSpawner.spawnHorde(count, options || {});
        if (!result) {
            console.warn('[GameRoom] Horde spawn failed (no result)');
            return null;
        }

        const { spawnPoint, enemies, targetInfo } = result;
        const payload = {
            spawn: {
                x: spawnPoint.x,
                y: spawnPoint.y,
                template: spawnPoint.template,
                angle: spawnPoint.angle
            },
            goal: targetInfo && targetInfo.target ? { x: targetInfo.target.x, y: targetInfo.target.y } : null,
            targetSource: targetInfo ? targetInfo.source : null,
            enemies: enemies.map(e => ({ id: e.id, x: e.x, y: e.y, type: e.type }))
        };

        io.to(this.id).emit('hordeSpawned', payload);

        // Force near-term enemy state broadcast so late joiners pick them up quickly
        this._nextEnemyBroadcastTime = Date.now();

        console.log(`[GameRoom] Horde spawned (${payload.enemies.length} enemies) in room ${this.id}`, {
            spawn: payload.spawn,
            targetSource: payload.targetSource
        });

        return result;
    }

    // Spawn a batch of ambient enemies using existing client hook
    spawnAmbientBatch(enemies) {
        try {
            if (!Array.isArray(enemies) || enemies.length === 0) return;
            const payload = {
                spawn: null,
                goal: null,
                targetSource: 'ambient',
                enemies: enemies.map(e => ({ id: e.id, x: e.x, y: e.y, type: e.type, radius: e.radius, health: e.health, healthMax: e.healthMax, speedMul: e.speedMul }))
            };
            io.to(this.id).emit('hordeSpawned', payload);
            // Force near-term enemy state broadcast so late joiners pick them up quickly
            this._nextEnemyBroadcastTime = Date.now();
        } catch (e) {
            console.warn('[AmbientSpawner] Failed to broadcast ambient batch:', e && e.message ? e.message : String(e));
        }
    }
    // Find a clear position for a ground item, avoiding overlap with existing items
    /* COMMENTED OUT - Now using LootManager (Phase 2)
    findClearGroundPosition(baseX, baseY, angle, itemRadius = 12, maxAttempts = 20) {
        const minSpacing = itemRadius * 2 + 6; // 30px for 12px radius items
        let radius = 60; // Start with reasonable distance from drop point
        let currentAngle = angle;
        
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            const x = baseX + Math.cos(currentAngle) * radius;
            const y = baseY + Math.sin(currentAngle) * radius;
            
            // Check boundaries
            if (x < -this.boundary || x > this.boundary || y < -this.boundary || y > this.boundary) {
                radius += 20;
                continue;
            }
            
            // Check overlap with existing ground items
            let overlaps = false;
            for (const existingItem of this.groundItems.values()) {
                const dx = x - existingItem.x;
                const dy = y - existingItem.y;
                const distance = Math.sqrt(dx * dx + dy * dy);
                if (distance < minSpacing) {
                    overlaps = true;
                    break;
                }
            }
            
            if (!overlaps) {
                return { x, y };
            }
            
            // Try next position: increment angle slightly and increase radius if needed
            currentAngle += 0.3; // ~17 degrees
            if (attempt % 6 === 5) radius += 20; // Expand search radius every 6 attempts
        }
        
        // Fallback: return position even if overlapping (better than infinite loop)
        return { x: baseX + Math.cos(angle) * radius, y: baseY + Math.sin(angle) * radius };
    }
    */ // END findClearGroundPosition
    
    /* COMMENTED OUT - Now using TimerManager (Phase 1)
    startReadyTimer(startedByPlayerId, levelType = 'extraction') {
        // Only start in lobby; ignore if already running or completed
        if (this.scene !== 'lobby') return;
        if (this.readyTimer.started || this.readyTimer.completed) return;
        
        // #region agent log
        console.log('[DEBUG H2] Ready timer starting:', {levelType, hasCachedNav:!!this._navDebug, hasCachedWalls:!!this._precomputedTrenchWalls});
        fetch('http://127.0.0.1:7242/ingest/10317113-f3de-4c2b-9a23-83892ed269d3',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'server.js:startReadyTimer:entry',message:'Ready timer starting',data:{levelType,hasCachedNav:!!this._navDebug,hasCachedWalls:!!this._precomputedTrenchWalls},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H2'})}).catch(()=>{});
        // #endregion
        
        // Store the selected level type
        this.levelType = levelType || 'extraction';
        console.log(`[Server] Ready timer started in room ${this.id} by ${startedByPlayerId} for level: ${this.levelType}`);

        // Navmesh is now precomputed when levelType is set (in setLevelType), not here
        
        this.readyTimer.started = true;
        this.readyTimer.completed = false;
        this.readyTimer.timeLeft = Number.isFinite(this.readyTimer.timeTotal) ? this.readyTimer.timeTotal : 10.0;
        this.readyTimer.startedBy = startedByPlayerId || null;
        this.emitReadyTimerState();
    }
    */ 

    // ===== NAVMESH DEBUG (Trench Raid) =====
    /* COMMENTED OUT - Now using LevelManager (Phase 5)
    _precomputeTrenchRaidNavDebug() {
        if (this.scene !== 'lobby') return;
        const key = `${this.worldSeed || 0}:${this.levelType || 'extraction'}`;
        if (this._navDebug && this._navDebugKey === key) return;

        const t0 = (typeof process.hrtime === 'function' && typeof process.hrtime.bigint === 'function')
            ? process.hrtime.bigint()
            : null;
        const startMs = Date.now();

        // Build a level environment for Trench Raid in the lobby, matching level-start setup for walls.
        const levelConfig = LevelConfigs.get('trenchraid');
        const env = new ServerEnvironment(this.worldSeed, levelConfig);

        // Instantiate mode for walls
        const modeConfig = GameModeConfigs.get('trenchraid');
        const ModeClass = this.getModeClass('trenchraid');
        const mode = new ModeClass(this, modeConfig);

        // Clear random obstacles from gap areas BEFORE adding defensive walls (matches level start)
        try {
            if (mode && typeof mode.getGapPositions === 'function' && env && typeof env.clearGapAreas === 'function') {
                const gapPositions = mode.getGapPositions();
                if (Array.isArray(gapPositions) && gapPositions.length > 0) {
                    env.clearGapAreas(gapPositions);
                }
            }
        } catch(_) {}

        // Add defensive walls (these include the side separators / chokepoints)
        // These MUST be added before the grid is built
        try {
            if (mode && typeof mode.getDefensiveWalls === 'function') {
                const walls = mode.getDefensiveWalls();
                if (Array.isArray(walls) && walls.length > 0) {
                    // Ensure defensive walls are added to obstacles array
                    for (const wall of walls) {
                        env.obstacles.push({
                            x: wall.x,
                            y: wall.y,
                            w: wall.w,
                            h: wall.h,
                            fill: wall.fill,
                            stroke: wall.stroke,
                            type: 'defensive'
                        });
                    }
                }
            }
        } catch(_) {}

        // Add trench walls (rotated, brown). Cache them so level start uses the exact same walls.
        try {
            if (mode && typeof mode.getTrenchWalls === 'function') {
                const trenchWalls = mode.getTrenchWalls();
                if (Array.isArray(trenchWalls) && trenchWalls.length > 0) {
                    this._precomputedTrenchWalls = trenchWalls;
                    env.orientedBoxes = env.orientedBoxes || [];
                    for (const wall of trenchWalls) {
                        env.orientedBoxes.push({
                            x: wall.x,
                            y: wall.y,
                            w: wall.w,
                            h: wall.h,
                            angle: wall.angle,
                            fill: wall.fill,
                            stroke: wall.stroke,
                            isTrenchWall: true
                        });
                    }

                    // Add invisible keepouts for sharp V-shaped overlaps so navmesh avoids dead funnels.
                    try {
                        const keepoutsAdded = addTrenchFunnelKeepouts(env.orientedBoxes);
                        if (keepoutsAdded > 0) {
                            console.log(`[TrenchWalls] Added ${keepoutsAdded} funnel keepouts (navmesh precompute)`);
                        }
                    } catch (e) {
                        console.warn('[TrenchWalls] Failed to add funnel keepouts (navmesh precompute):', e && e.message ? e.message : String(e));
                    }
                }
            }
        } catch(_) {}

        // Build coarse nav grid for debug overlay
        const nav = this._buildNavGridDebug(env);
        this._navDebug = nav;
        this._navDebugKey = key;
        this._navDecodedGrid = null; // Clear cached grid when navmesh changes

        const elapsedMs = t0 ? Number((process.hrtime.bigint() - t0) / 1000000n) : (Date.now() - startMs);
        console.log(`[NavMesh] Ã¢Å“â€¦ Precomputed Trench Raid navmesh for room ${this.id} (seed=${this.worldSeed}) in ${elapsedMs}ms`);

        // Broadcast once so clients can render overlay (they can store until level starts)
        try {
            io.to(this.id).emit('navMeshDebug', {
                levelType: 'trenchraid',
                seed: this.worldSeed,
                nav
            });
        } catch(_) {}
    }
    */ // END _precomputeTrenchRaidNavDebug

    /* COMMENTED OUT - Now using LevelManager (Phase 5)
    _buildNavGridDebug(env) {
        // High resolution: 100-unit cells for detailed pathfinding
        const cellSize = 100;
        // Detection radius: with 100-unit cells, center can be 50 units from wall edge
        // Defensive walls are 60 units thick, so 60-unit radius catches them
        const radius = 60;

        let minX, maxX, minY, maxY;
        if (env && env.isRectangular) {
            minX = -env.halfWidth;
            maxX = env.halfWidth;
            minY = -env.halfHeight;
            maxY = env.halfHeight;
        } else {
            const b = Number.isFinite(env?.boundary) ? env.boundary : (Number.isFinite(this.boundary) ? this.boundary : 11000);
            minX = -b; maxX = b; minY = -b; maxY = b;
        }
        
        // Add boundary walls to environment before building grid
        const wallThickness = 100;
        if (!env.obstacles) env.obstacles = [];
        
        // Left edge wall
        env.obstacles.push({
            x: minX,
            y: (minY + maxY) / 2,
            w: wallThickness,
            h: maxY - minY,
            fill: '#1a1108',
            stroke: '#000000',
            type: 'boundary'
        });
        
        // Right edge wall
        env.obstacles.push({
            x: maxX,
            y: (minY + maxY) / 2,
            w: wallThickness,
            h: maxY - minY,
            fill: '#1a1108',
            stroke: '#000000',
            type: 'boundary'
        });
        
        // Top edge wall
        env.obstacles.push({
            x: (minX + maxX) / 2,
            y: minY,
            w: maxX - minX,
            h: wallThickness,
            fill: '#1a1108',
            stroke: '#000000',
            type: 'boundary'
        });
        
        // Bottom edge wall
        env.obstacles.push({
            x: (minX + maxX) / 2,
            y: maxY,
            w: maxX - minX,
            h: wallThickness,
            fill: '#1a1108',
            stroke: '#000000',
            type: 'boundary'
        });

        const w = Math.max(1, Math.ceil((maxX - minX) / cellSize));
        const h = Math.max(1, Math.ceil((maxY - minY) / cellSize));

        const rowsRLE = [];

        for (let j = 0; j < h; j++) {
            // Run-length encode row: [val,len,val,len,...], where val is 0/1 walkable
            const row = [];
            let runVal = null;
            let runLen = 0;

            for (let i = 0; i < w; i++) {
                const cx = minX + (i + 0.5) * cellSize;
                const cy = minY + (j + 0.5) * cellSize;

                // Inside bounds + not colliding with walls/obstacles.
                let walkable = 1;
                try {
                    if (env && typeof env.isInsideBounds === 'function') {
                        if (!env.isInsideBounds(cx, cy, radius)) walkable = 0;
                    }
                    if (walkable && env && typeof env.circleHitsAny === 'function') {
                        // IMPORTANT: env.circleHitsAny already uses obstacles + orientedBoxes (trench walls, defensive walls, etc.)
                        if (env.circleHitsAny(cx, cy, radius)) walkable = 0;
                    }
                } catch(_) { // keep best-effort }

                if (runVal === null) {
                    runVal = walkable;
                    runLen = 1;
                } else if (walkable === runVal) {
                    runLen++;
                } else {
                    row.push(runVal, runLen);
                    runVal = walkable;
                    runLen = 1;
                }
            }
            if (runVal !== null) row.push(runVal, runLen);
            rowsRLE.push(row);
        }

        return { cellSize, radius, minX, minY, w, h, rowsRLE };
    }
    */ // END _buildNavGridDebug
    
    // ===== A* PATHFINDING FOR NAVMESH =====
    _decodeNavRow(rowRLE, width) {
        // Decode run-length encoded row into array of 0/1 walkable values
        const row = new Uint8Array(width);
        let idx = 0;
        for (let k = 0; k < rowRLE.length; k += 2) {
            const val = rowRLE[k] ? 1 : 0;
            const len = rowRLE[k + 1];
            row.fill(val, idx, idx + len);
            idx += len;
        }
        return row;
    }
    
    /* COMMENTED OUT - Now using LevelManager (Phase 5)
    _initNavProperties(entity) {
        // Initialize navmesh pathfinding properties for enemies, troops, NPCs
        entity._navPath = null;           // Array of {x, y} waypoints
        entity._navWaypointIndex = 0;     // Current waypoint being followed
        entity._navLastUpdate = 0;        // Last time path was computed (ms)
        entity._navStuckTimer = 0;        // Time spent not making progress (seconds)
        entity._navLastPos = { x: entity.x, y: entity.y }; // For stuck detection
    }
    */ // END _initNavProperties
    
    _hasLineOfSight(startX, startY, endX, endY) {
        // Check if there's a clear line of sight between two points (no walls blocking)
        if (!this.environment) return true;
        
        const dx = endX - startX;
        const dy = endY - startY;
        const dist = Math.hypot(dx, dy);
        if (dist < 10) return true; // Too close to matter
        
        // Sample points along the line
        const steps = Math.ceil(dist / 50); // Check every 50 units
        for (let i = 1; i <= steps; i++) {
            const t = i / steps;
            const x = startX + dx * t;
            const y = startY + dy * t;
            
            // Check if this point hits any obstacles
            if (this.environment.circleHitsAny && this.environment.circleHitsAny(x, y, 20)) {
                return false; // Line blocked
            }
        }
        
        return true; // Clear line of sight
    }
    
    /* COMMENTED OUT - Now using EnemyManager (Phase 9 - FINAL!)
    _updateNavmeshMovement(deltaTime) {
        // Smart pathfinding: Use navmesh when line-of-sight is blocked, otherwise use Director
        const now = Date.now();
        const PATH_UPDATE_INTERVAL = 2000; // Recompute paths every 2 seconds
        const WAYPOINT_REACH_DIST = 80; // Distance to consider waypoint reached
        const MAX_PATHS_PER_FRAME = 8; // Performance: Limit pathfinding operations per frame
        
        // Initialize pathfinding queue and frame counter if not exists
        if (!this._pathfindingQueue) this._pathfindingQueue = [];
        if (!this._pathfindingFrameCounter === undefined) this._pathfindingFrameCounter = 0;
        
        this._pathfindingFrameCounter++;
        let pathsComputedThisFrame = 0;
        
        for (const [, e] of this.enemies) {
            if (!e || !e.alive) continue;
            
            // Skip stationary enemies (turrets, artillery)
            if (e.type === 'defenseTurret' || e.type === 'artilleryGun') continue;
            
            // Skip enemies with manual movement overrides
            if (e._preAggroGoal || e._wanderTarget) continue;
            
            // Find target (closest player)
            let targetX = null, targetY = null;
            let closestDist = Infinity;
            for (const [, p] of this.players) {
                if (!p || p.health <= 0 || p.invisible === true) continue;
                const dx = p.x - e.x;
                const dy = p.y - e.y;
                const dist = Math.hypot(dx, dy);
                if (dist < closestDist) {
                    closestDist = dist;
                    targetX = p.x;
                    targetY = p.y;
                }
            }
            
            if (!targetX || !targetY) {
                e._navPath = null; // No target, clear path
                continue;
            }
            
            // Check if path needs update (every 2 seconds or no path exists)
            if (!e._navLastUpdate || (now - e._navLastUpdate) >= PATH_UPDATE_INTERVAL) {
                // OPTIMIZATION: Stagger pathfinding across frames using modulo check
                // This spreads the load evenly instead of all paths updating at once
                if (!e._pathfindingOffset) {
                    e._pathfindingOffset = Math.floor(Math.random() * 30); // Random offset 0-30 frames
                }
                
                // Only update if this enemy's turn based on frame counter
                if ((this._pathfindingFrameCounter + e._pathfindingOffset) % 30 !== 0) {
                    continue; // Skip this enemy this frame
                }
                
                // OPTIMIZATION: Enforce per-frame pathfinding budget
                if (pathsComputedThisFrame >= MAX_PATHS_PER_FRAME) {
                    continue; // Hit budget, skip remaining enemies this frame
                }
                
                e._navLastUpdate = now;
                pathsComputedThisFrame++;
                
                // Check line-of-sight
                const hasLOS = this._hasLineOfSight(e.x, e.y, targetX, targetY);
                
                if (!hasLOS) {
                    // Blocked! Compute navmesh path
                    const path = this._findPath(this._navDebug, e.x, e.y, targetX, targetY);
                    if (path && path.length > 0) {
                        e._navPath = path;
                        e._navWaypointIndex = 0;
                        e._navUsingPath = true;
                    }
                } else {
                    // Clear line-of-sight - let Director handle it
                    e._navPath = null;
                    e._navUsingPath = false;
                }
            }
            
            // Follow navmesh path if we have one
            if (e._navPath && e._navPath.length > 0 && e._navWaypointIndex < e._navPath.length) {
                const waypoint = e._navPath[e._navWaypointIndex];
                const dx = waypoint.x - e.x;
                const dy = waypoint.y - e.y;
                const dist = Math.hypot(dx, dy);
                
                // Reached waypoint? Move to next
                if (dist < WAYPOINT_REACH_DIST) {
                    e._navWaypointIndex++;
                    if (e._navWaypointIndex >= e._navPath.length) {
                        // Reached end of path
                        e._navPath = null;
                        e._navUsingPath = false;
                    }
                } else {
                    // Move toward waypoint
                    const baseSpeed = 110; // Match Director speed
                    const speed = baseSpeed * (e.speedMul || 1);
                    const moveX = (dx / dist) * speed * deltaTime;
                    const moveY = (dy / dist) * speed * deltaTime;

                    // Apply swept collision resolution to prevent tunneling through thick walls on dt spikes
                    let newX = e.x + moveX;
                    let newY = e.y + moveY;
                    if (this.environment && typeof this.environment.resolveCircleMove === 'function') {
                        const res = this.environment.resolveCircleMove(e.x, e.y, e.radius || 26, moveX, moveY);
                        newX = res.x;
                        newY = res.y;
                    }
                    // Mark that we're using navmesh (Director should not move this enemy this tick)
                    if (newX !== e.x || newY !== e.y) {
                        e.x = newX;
                        e.y = newY;
                        e._navMovedThisFrame = true;
                    }
                }
            }
        }
    }
    */ // END _updateNavmeshMovement
    
    /* COMMENTED OUT - Now using EnemyManager (Phase 9 - FINAL!)
    _findPath(nav, startX, startY, goalX, goalY) {
        if (!nav || !nav.rowsRLE) return null;
        
        const cs = nav.cellSize;
        const minX = nav.minX;
        const minY = nav.minY;
        const w = nav.w;
        const h = nav.h;
        
        // Convert world coords to grid coords
        const startI = Math.floor((startX - minX) / cs);
        const startJ = Math.floor((startY - minY) / cs);
        const goalI = Math.floor((goalX - minX) / cs);
        const goalJ = Math.floor((goalY - minY) / cs);
        
        // Bounds check
        if (startI < 0 || startI >= w || startJ < 0 || startJ >= h) return null;
        if (goalI < 0 || goalI >= w || goalJ < 0 || goalJ >= h) return null;
        
        // OPTIMIZATION: Use cached decoded grid instead of decoding every time
        let grid = this._navDecodedGrid;
        if (!grid) {
            // First time: decode and cache
            grid = new Array(h);
            for (let j = 0; j < h; j++) {
                grid[j] = this._decodeNavRow(nav.rowsRLE[j], w);
            }
            this._navDecodedGrid = grid;
        }
        
        // Check if start/goal are walkable
        if (grid[startJ][startI] === 0) return null; // start blocked
        if (grid[goalJ][goalI] === 0) return null; // goal blocked
        
        // OPTIMIZATION: A* search with binary min-heap instead of array.sort()
        const openSet = new BinaryMinHeap((a, b) => (a.g + a.h) - (b.g + b.h));
        openSet.push({i: startI, j: startJ, g: 0, h: 0, parent: null});
        
        const closedSet = new Set();
        const costs = {}; // "i,j" -> g cost
        const inOpen = new Set(); // Track which nodes are in openSet
        costs[`${startI},${startJ}`] = 0;
        inOpen.add(`${startI},${startJ}`);
        
        let iterations = 0;
        const maxIterations = 1000; // Prevent infinite loops
        
        while (openSet.length > 0 && iterations < maxIterations) {
            iterations++;
            
            // OPTIMIZED: Get node with lowest f = g + h in O(log n) instead of O(n log n)
            const current = openSet.pop();
            const currentKey = `${current.i},${current.j}`;
            inOpen.delete(currentKey);
            
            // Reached goal?
            if (current.i === goalI && current.j === goalJ) {
                // Reconstruct path
                const path = [];
                let node = current;
                while (node) {
                    path.unshift({
                        x: minX + (node.i + 0.5) * cs,
                        y: minY + (node.j + 0.5) * cs
                    });
                    node = node.parent;
                }
                return path;
            }
            
            closedSet.add(currentKey);
            
            // Check 8 neighbors (diagonal movement enabled)
            const neighbors = [
                [current.i-1, current.j], [current.i+1, current.j],
                [current.i, current.j-1], [current.i, current.j+1],
                [current.i-1, current.j-1], [current.i-1, current.j+1],
                [current.i+1, current.j-1], [current.i+1, current.j+1]
            ];
            
            for (const [ni, nj] of neighbors) {
                if (ni < 0 || ni >= w || nj < 0 || nj >= h) continue;
                if (grid[nj][ni] === 0) continue; // blocked
                
                // For diagonal moves, check if we can "squeeze through"
                const isDiag = (ni !== current.i && nj !== current.j);
                if (isDiag) {
                    // Both adjacent orthogonal cells must be walkable
                    const sideA = grid[current.j][ni];
                    const sideB = grid[nj][current.i];
                    if (sideA === 0 || sideB === 0) continue; // Can't cut corner
                }
                
                const nKey = `${ni},${nj}`;
                if (closedSet.has(nKey)) continue;
                
                // Diagonal movement costs sqrt(2) Ã¢â€°Ë† 1.414
                const moveCost = isDiag ? 1.414 : 1.0;
                const newG = current.g + moveCost;
                
                if (costs[nKey] === undefined || newG < costs[nKey]) {
                    costs[nKey] = newG;
                    const h = Math.hypot(goalI - ni, goalJ - nj); // Euclidean heuristic
                    
                    // OPTIMIZED: No need to search and remove - just add new node
                    // The heap will naturally prefer the better path
                    if (!inOpen.has(nKey)) {
                        openSet.push({
                            i: ni, j: nj, g: newG, h: h,
                            parent: current
                        });
                        inOpen.add(nKey);
                    }
                }
            }
        }
        
        return null; // No path found
    }
    // =========================================

    /* COMMENTED OUT - Now using TimerManager (Phase 1)
    cancelReadyTimer() {
        if (!this.readyTimer.started || this.readyTimer.completed) return;
        this.readyTimer.started = false;
        this.readyTimer.timeLeft = 0;
        this.readyTimer.startedBy = null;
        console.log(`[Server] Ready timer cancelled in room ${this.id}`);
        this.emitReadyTimerState();
    }
    */
    
    /* COMMENTED OUT - Now using TimerManager (Phase 1) - 683 lines
    updateReadyTimer(deltaTime) {
        if (!this.readyTimer.started || this.readyTimer.completed) return;

        this.readyTimer.timeLeft -= deltaTime;
        if (this.readyTimer.timeLeft < 0) this.readyTimer.timeLeft = 0;

        this.emitReadyTimerState();

        if (this.readyTimer.timeLeft <= 0) {
            this.readyTimer.timeLeft = 0;
            this.readyTimer.started = false;
            this.readyTimer.completed = true;
            console.log(`[Server] Ready timer completed in room ${this.id} - Starting level: ${this.levelType}`);

            this.scene = 'level';
            this.boundary = 11000;
            
            // Track level start time for artillery barrage delay (7 minutes)
            this.levelStartTime = Date.now();

            this.environment = this._createEnvironmentForScene(this.scene);
            console.log(`[READY_TIMER] Recreated server environment for level: ${this.environment.obstacles.length} obstacles, boundary: ${this.boundary}`);

            // Enable server-authoritative enemy movement when level starts
            this.enemyNetMode = 'authoritative';
            this._nextEnemyBroadcastTime = Date.now();

            // Initialize game mode system
            const modeConfig = GameModeConfigs.get(this.levelType);
            this.gameModeConfig = modeConfig; // Store config for respawn logic
            const ModeClass = this.getModeClass(this.levelType);
            this.currentGameMode = new ModeClass(this, modeConfig);
            this.currentGameMode.onLevelStart();
            console.log(`[GameMode] Initialized ${modeConfig.name} mode`);
            
            // Update extraction zone timer from mode config
            if (modeConfig.timers && typeof modeConfig.timers.extractionZone === 'number') {
                this.extractionTimer.timeTotal = modeConfig.timers.extractionZone;
                console.log(`[GameMode] Set extraction zone timer to ${this.extractionTimer.timeTotal}s`);
            }
            
            // Update environment spawn safe position based on game mode (e.g., trench raid left-side spawn)
            if (modeConfig.spawn && typeof modeConfig.spawn.x === 'number' && typeof modeConfig.spawn.y === 'number') {
                this.environment.spawnSafeX = modeConfig.spawn.x;
                this.environment.spawnSafeY = modeConfig.spawn.y;
                this.environment.spawnSafeRadius = modeConfig.spawn.radius || 200;
                console.log(`[GameMode] Updated spawn safe zone to (${modeConfig.spawn.x}, ${modeConfig.spawn.y}) radius ${this.environment.spawnSafeRadius}`);
            }
            
            // Clear random obstacles from gap areas FIRST (before adding defensive walls)
            if (this.currentGameMode && typeof this.currentGameMode.getGapPositions === 'function') {
                const gapPositions = this.currentGameMode.getGapPositions();
                if (Array.isArray(gapPositions) && gapPositions.length > 0) {
                    this.environment.clearGapAreas(gapPositions);
                }
            }

            // Trench Raid specific: clear NEW ANTIOCH back area (far left behind turrets)
            try {
                if (this.levelType === 'trenchraid' && this.environment && this.environment.clearGapAreas) {
                    // Map edges: -6000..+6000, New Antioch wall at -4200
                    const leftEdge = -6000;
                    const wallX = -4200;
                    const width = (wallX - leftEdge); // 1800
                    const height = (this.environment.height || 3000); // full vertical extent
                    const area = [{
                        x: leftEdge + width / 2,
                        y: 0,
                        width: Math.max(0, width - 60), // small buffer to not touch wall visuals
                        height: height,
                        clearRadius: 0
                    }];
                    this.environment.clearGapAreas(area);
                    console.log('[GameMode][TrenchRaid] Cleared obstacles in New Antioch back area');
                }
            } catch (e) {
                console.warn('[GameMode][TrenchRaid] Failed clearing New Antioch area:', e && e.message ? e.message : String(e));
            }

            // Trench Raid specific: clear HERETIC back area (far right behind red walls)
            try {
                if (this.levelType === 'trenchraid' && this.environment && this.environment.clearGapAreas) {
                    // Map edges: -6000..+6000, Heretic wall at +4200
                    const rightEdge = 6000;
                    const hereticWallX = 4200;
                    const width = (rightEdge - hereticWallX); // 1800
                    const height = (this.environment.height || 3000); // full vertical extent
                    const hereticArea = [{
                        x: hereticWallX + width / 2,
                        y: 0,
                        width: Math.max(0, width - 60), // small buffer to not touch wall visuals
                        height: height,
                        clearRadius: 0
                    }];
                    this.environment.clearGapAreas(hereticArea);
                    console.log('[GameMode][TrenchRaid] Cleared obstacles in Heretic back area');
                }
            } catch (e) {
                console.warn('[GameMode][TrenchRaid] Failed clearing Heretic area:', e && e.message ? e.message : String(e));
            }
            
            // Add mode-specific obstacles AFTER clearing gaps (e.g., trench raid defensive walls)
            if (this.currentGameMode && typeof this.currentGameMode.getDefensiveWalls === 'function') {
                const walls = this.currentGameMode.getDefensiveWalls();
                if (Array.isArray(walls) && walls.length > 0) {
                    this.environment.obstacles.push(...walls);
                    console.log(`[GameMode] Added ${walls.length} defensive wall obstacles to environment`);
                }
            }

            // Add trench walls (rotatable long walls) for Trench Raid mode
            if (this.levelType === 'trenchraid' && this.currentGameMode && typeof this.currentGameMode.getTrenchWalls === 'function') {
                // #region agent log
                console.log('[DEBUG H1] Before wall selection:', {hasCachedWalls:!!(this._precomputedTrenchWalls&&this._precomputedTrenchWalls.length>0), cacheLength:this._precomputedTrenchWalls?.length||0});
                fetch('http://127.0.0.1:7242/ingest/10317113-f3de-4c2b-9a23-83892ed269d3',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'server.js:updateReadyTimer:beforeWalls',message:'Before wall selection',data:{hasCachedWalls:!!(this._precomputedTrenchWalls&&this._precomputedTrenchWalls.length>0),cacheLength:this._precomputedTrenchWalls?.length||0},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H1'})}).catch(()=>{});
                // #endregion
                const trenchWalls = (Array.isArray(this._precomputedTrenchWalls) && this._precomputedTrenchWalls.length > 0)
                    ? this._precomputedTrenchWalls
                    : this.currentGameMode.getTrenchWalls();
                if (Array.isArray(trenchWalls) && trenchWalls.length > 0) {
                    // Add to orientedBoxes for collision (supports rotation)
                    if (!this.environment.orientedBoxes) {
                        this.environment.orientedBoxes = [];
                    }
                    
                    for (const wall of trenchWalls) {
                        this.environment.orientedBoxes.push({
                            x: wall.x,
                            y: wall.y,
                            w: wall.w,
                            h: wall.h,
                            angle: wall.angle,
                            fill: wall.fill,
                            stroke: wall.stroke,
                            isTrenchWall: true  // Mark for rendering
                        });
                    }
                    console.log(`[GameMode] Added ${trenchWalls.length} trench walls to environment.orientedBoxes`);

                    // IMPORTANT: Funnel keepouts are NAVMESH-ONLY.
                    // Do NOT add keepouts to the live collision environment, otherwise players hit invisible walls
                    // (keepouts have no fill/stroke and are intentionally filtered out of roomSnapshot).
                    
                    // #region agent log
                    fetch('http://127.0.0.1:7242/ingest/10317113-f3de-4c2b-9a23-83892ed269d3',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'server.js:updateReadyTimer:wallsAdded',message:'Trench walls added',data:{actualWallCount:trenchWalls.length,usedCache:!!(this._precomputedTrenchWalls&&trenchWalls===this._precomputedTrenchWalls)},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H1'})}).catch(()=>{});
                    // #endregion
                }
            }

            // Initialize hazards using new config-based system
            try {
                // Create hazards manager with config from game mode (if available)
                const hazardConfig = modeConfig && modeConfig.hazards ? modeConfig.hazards : {};
                
                // Pass the mode type so EnvironmentHazards can load the correct HazardsConfig
                const modeType = this.levelType || 'trenchraid';
                this.hazards = new EnvironmentHazards(this, this.environment, hazardConfig, modeType);
                
                // Use new config-based spawning system
                if (this.hazards.hazardsConfig && this.hazards.hazardsConfig.enabled) {
                    console.log(`[Hazards] Spawning hazards for mode: ${modeType}`);
                    
                    // Initialize hazard arrays (previously done by spawnLeftEdgeRow's _resetAll())
                    this.hazards._resetAll();
                    
                    // Spawn sandbags using configured strategy
                    this.hazards.spawnSandbags();
                    
                    // Spawn barbed wire (triple concertina fences in clusters of 2-3)
                    this.hazards.spawnBarbedWire();
                    
                    // Spawn mud pools (clusters of 1-4, drawn underneath as ground decals)
                    this.hazards.spawnMudPools();
                    
                    // Spawn fire pools (5 individual pools, rare hazard with fire damage and smoke)
                    this.hazards.spawnFirePools();
                    
                    // Spawn gas canisters (clusters of 3-8, vision impairment only)
                    this.hazards.spawnGasCanisters();
                    
                    // Spawn exploding barrels (clusters + scattered on New Antioch side)
                    this.hazards.spawnExplodingBarrels();
                    
                    // Spawn other hazards (when implemented)
                    // etc.
                } else {
                    // Hazards disabled or not configured for this mode
                    console.log('[Hazards] Hazards disabled or not configured for this mode');
                }
                
                // Broadcast hazards to all clients
                const hazardsPayload = this.hazards.serialize();
                this.io.to(this.id).emit('hazardsState', hazardsPayload);
                console.log('[Hazards] Broadcast hazardsState to clients:', {
                    sandbags: hazardsPayload.sandbags?.length || 0,
                    wire: hazardsPayload.barbedWire?.length || 0,
                    mud: hazardsPayload.mudPools?.length || 0,
                    barrels: hazardsPayload.explodingBarrels?.length || 0
                });
            } catch (e) {
                console.warn('[Hazards] Failed to initialize hazards:', e && e.message ? e.message : String(e));
                this.hazards = null;
            }

            // Configure AmbientSpawner from mode config (if provided)
            try {
                const ambientCfg = modeConfig.ambient || {};
                if (this.ambientSpawner) {
                    const cfg = {};
                    if (typeof ambientCfg.enabled === 'boolean') cfg.ENABLED = ambientCfg.enabled;
                    if (Array.isArray(ambientCfg.tiers)) cfg.TIERS = ambientCfg.tiers;
                    if (Object.keys(cfg).length > 0) {
                        this.ambientSpawner.config = { ...this.ambientSpawner.config, ...cfg };
                    }
                    this.ambientSpawner.onLevelStart();
                }
            } catch (e) {
                console.warn('[AmbientSpawner] Failed to apply mode config:', e && e.message ? e.message : String(e));
            }

            // Use game mode to compute level loot/NPC spawns (no initial enemy flood)
            const rng = new SeededRNG(this.worldSeed);
            const lootSpawns = this.currentGameMode.computeLootSpawns(this.environment, rng);
            const npcSpawns = this.currentGameMode.computeNPCSpawns(this.environment, rng, lootSpawns);
            this.levelSpawns = { chests: lootSpawns.chests, npcs: npcSpawns };
            
            // Pre-register all chests from level spawns so enemies can damage them immediately
            if (this.levelSpawns && this.levelSpawns.chests) {
                for (const chestConfig of this.levelSpawns.chests) {
                    const chest = {
                        id: chestConfig.id,
                        x: chestConfig.x,
                        y: chestConfig.y,
                        variant: chestConfig.variant || 'brown',
                        opening: false,
                        opened: false,
                        timeTotal: 60.0,  // Gold chest opening time (1 minute)
                        timeLeft: 0,
                        startedBy: null,
                        drops: [],
                        dropCount: chestConfig.dropCount !== undefined ? chestConfig.dropCount : 10,
                        radius: 20, // Add explicit radius for collision detection
                        // Health tracking for gold chests (shared with artifact)
                        health: chestConfig.variant === 'gold' ? 2000 : undefined,
                        healthMax: chestConfig.variant === 'gold' ? 2000 : undefined
                    };
                    this.chests.set(chest.id, chest);
                }
            }
            
            // Initialize server-authoritative NPCs from level spawns
            if (this.npcManager && this.levelSpawns) {
                this.npcManager.initializeFromLevelSpawns(this.levelSpawns);
                // Immediately broadcast initial NPC state to all clients (don't wait for 10Hz interval)
                // This ensures clients receive NPC data ASAP after scene change, reducing race condition risk
                this.npcManager.broadcastState();
                console.log('[ServerNPC] Sent immediate initial NPC broadcast after level start');
            }

            // Initialize battery system for trench raid mode (RadioTower power system)
            if (this.levelType === 'trenchraid') {
                try {
                    // RadioTower spawns randomly in Zone C or Zone D with collision validation
                    // Zone C: x = -3400 to 0, Zone D: x = 0 to 3400
                    // Y axis: -1200 to 1200 (within playable area)
                    // CRITICAL: Must validate BOTH tower AND battery station to ensure accessibility
                    
                    let radioTowerX, radioTowerY;
                    let stationX, stationY;
                    let validPosition = false;
                    let selectedZone = '';
                    const maxTowerAttempts = 50; // Try up to 50 positions to find valid spawn
                    
                    // Radio tower dimensions for collision checking
                    const towerRadius = 90;    // Width of tower base (60) + clearance
                    const stationRadius = 100; // Battery station needs clear space (CRITICAL - this is the interactable part!)
                    
                    for (let attempt = 0; attempt < maxTowerAttempts && !validPosition; attempt++) {
                        const zoneChoice = Math.random() < 0.5 ? 'C' : 'D';
                        
                        if (zoneChoice === 'C') {
                            radioTowerX = -3000 + Math.random() * 2600;  // -3000 to -400
                            radioTowerY = -800 + Math.random() * 1600;   // -800 to 800
                        } else {
                            radioTowerX = 400 + Math.random() * 2600;    // 400 to 3000
                            radioTowerY = -800 + Math.random() * 1600;   // -800 to 800
                        }
                        
                        // Round to nice values
                        radioTowerX = Math.round(radioTowerX / 100) * 100;
                        radioTowerY = Math.round(radioTowerY / 100) * 100;
                        
                        // Battery station position (left of RadioTower)
                        stationX = radioTowerX - 200;
                        stationY = radioTowerY + 135;
                        
                        // VALIDATE BOTH TOWER AND STATION POSITIONS AGAINST OBSTACLES
                        // Battery station validation is CRITICAL - it's the only interactable part!
                        const towerBlocked = this.environment && this.environment.circleHitsAny && 
                                             this.environment.circleHitsAny(radioTowerX, radioTowerY, towerRadius);
                        const stationBlocked = this.environment && this.environment.circleHitsAny && 
                                               this.environment.circleHitsAny(stationX, stationY, stationRadius);
                        
                        if (!towerBlocked && !stationBlocked) {
                            validPosition = true;
                            selectedZone = zoneChoice;
                            console.log(`[BatterySystem] RadioTower validated in Zone ${zoneChoice} at (${radioTowerX}, ${radioTowerY}) after ${attempt + 1} attempts`);
                        }
                    }
                    
                    // Fallback if no valid position found after all attempts
                    if (!validPosition) {
                        console.warn('[BatterySystem] Failed to find valid RadioTower position after max attempts! Using fallback.');
                        // Use fallback position in open area (center of Zone D, should always be accessible)
                        radioTowerX = 1700;
                        radioTowerY = 0;
                        stationX = radioTowerX - 200;
                        stationY = radioTowerY + 135;
                        selectedZone = 'D';
                        console.log(`[BatterySystem] RadioTower fallback at (${radioTowerX}, ${radioTowerY})`);
                    }
                    
                    // Initialize battery station state
                    this.batteryStation = {
                        x: stationX,
                        y: stationY,
                        radioTowerX: radioTowerX,
                        radioTowerY: radioTowerY,
                        slots: [false, false, false],
                        isPowered: false
                    };
                    
                    // Initialize batteries map and spawn 3 batteries randomly within 750 units of RadioTower
                    this.batteries = new Map();
                    
                    // Battery spawn configuration
                    const batteryCount = 3;
                    const maxSpawnRadius = 750;   // Up to 750 units from radio tower
                    const minSpawnRadius = 300;   // Minimum distance from radio tower (can't be on top of it)
                    const minBatteryDistance = 150; // Minimum distance between batteries
                    const batteryRadius = 20;     // Battery collision radius
                    
                    // Map bounds (battlefield area where batteries can spawn)
                    const mapBounds = {
                        minX: -10000,  // Inside left defensive wall
                        maxX: 10000,   // Inside right defensive wall  
                        minY: -1300,   // Top of playable area
                        maxY: 1300     // Bottom of playable area
                    };
                    
                    // Helper: Check if position is valid for battery spawn
                    const isValidBatteryPosition = (x, y, existingBatteries) => {
                        // Check map bounds
                        if (x < mapBounds.minX || x > mapBounds.maxX) return false;
                        if (y < mapBounds.minY || y > mapBounds.maxY) return false;
                        
                        // Check distance from radio tower (must be within spawn radius)
                        const distFromTower = Math.hypot(x - radioTowerX, y - radioTowerY);
                        if (distFromTower > maxSpawnRadius || distFromTower < minSpawnRadius) return false;
                        
                        // Check distance from battery station
                        const distFromStation = Math.hypot(x - stationX, y - stationY);
                        if (distFromStation < 100) return false;
                        
                        // Check environment obstacles
                        if (this.environment && this.environment.circleHitsAny && 
                            this.environment.circleHitsAny(x, y, batteryRadius)) {
                            return false;
                        }
                        
                        // Check distance from other batteries
                        for (const battery of existingBatteries) {
                            const dist = Math.hypot(x - battery.x, y - battery.y);
                            if (dist < minBatteryDistance) return false;
                        }
                        
                        // Check hazards - AVOID fire pools, gas canisters, and exploding barrels
                        // Note: Mud and barbed wire are OK (batteries can be there)
                        if (this.hazards) {
                            // Check fire pools
                            if (this.hazards.firePools) {
                                for (const fire of this.hazards.firePools) {
                                    const dist = Math.hypot(x - fire.x, y - fire.y);
                                    if (dist < (fire.radius || 200) + batteryRadius + 50) return false;
                                }
                            }
                            
                            // Check gas canisters
                            if (this.hazards.gasCanisters) {
                                for (const gas of this.hazards.gasCanisters) {
                                    const dist = Math.hypot(x - gas.x, y - gas.y);
                                    if (dist < (gas.radius || 180) + batteryRadius + 30) return false;
                                }
                            }
                            
                            // Check exploding barrels
                            if (this.hazards.explodingBarrels) {
                                for (const barrel of this.hazards.explodingBarrels) {
                                    if (barrel.exploded) continue;
                                    const dist = Math.hypot(x - barrel.x, y - barrel.y);
                                    if (dist < (barrel.visualRadius || 24) + batteryRadius + 50) return false;
                                }
                            }
                        }
                        
                        return true;
                    };
                    
                    // Generate random battery positions
                    const batterySpawns = [];
                    const maxAttempts = 100;
                    
                    for (let i = 0; i < batteryCount; i++) {
                        let placed = false;
                        
                        for (let attempt = 0; attempt < maxAttempts && !placed; attempt++) {
                            // Generate random position within spawn radius of radio tower
                            const angle = Math.random() * Math.PI * 2;
                            const distance = minSpawnRadius + Math.random() * (maxSpawnRadius - minSpawnRadius);
                            const testX = radioTowerX + Math.cos(angle) * distance;
                            const testY = radioTowerY + Math.sin(angle) * distance;
                            
                            if (isValidBatteryPosition(testX, testY, batterySpawns)) {
                                batterySpawns.push({
                                    id: `battery_${i}`,
                                    x: Math.round(testX),
                                    y: Math.round(testY)
                                });
                                placed = true;
                            }
                        }
                        
                        // Fallback if random placement failed
                        if (!placed) {
                            console.warn(`[BatterySystem] Could not find valid position for battery_${i}, using fallback`);
                            // Use deterministic fallback positions at different angles
                            const fallbackAngle = (i / batteryCount) * Math.PI * 2 + Math.PI / 4;
                            const fallbackDist = 400;
                            batterySpawns.push({
                                id: `battery_${i}`,
                                x: Math.round(radioTowerX + Math.cos(fallbackAngle) * fallbackDist),
                                y: Math.round(radioTowerY + Math.sin(fallbackAngle) * fallbackDist)
                            });
                        }
                    }
                    
                    for (const spawn of batterySpawns) {
                        this.batteries.set(spawn.id, {
                            id: spawn.id,
                            x: spawn.x,
                            y: spawn.y,
                            carriedBy: null,
                            slotIndex: null,
                            onGround: true
                        });
                        console.log(`[BatterySystem] Spawned ${spawn.id} at (${spawn.x}, ${spawn.y}) - ${Math.round(Math.hypot(spawn.x - radioTowerX, spawn.y - radioTowerY))} units from tower`);
                    }
                    
                    console.log(`[BatterySystem] Initialized battery station at (${stationX}, ${stationY}) with ${batterySpawns.length} batteries spread ${minSpawnRadius}-${maxSpawnRadius} units from tower`);
                    
                    // Broadcast initial battery state to all players
                    this.io.to(this.id).emit('batteryStationState', {
                        x: this.batteryStation.x,
                        y: this.batteryStation.y,
                        radioTowerX: this.batteryStation.radioTowerX,
                        radioTowerY: this.batteryStation.radioTowerY,
                        slots: this.batteryStation.slots,
                        isPowered: this.batteryStation.isPowered
                    });
                    
                    for (const [batteryId, battery] of this.batteries) {
                        this.io.to(this.id).emit('batteryState', {
                            id: battery.id,
                            x: battery.x,
                            y: battery.y,
                            carriedBy: battery.carriedBy,
                            slotIndex: battery.slotIndex,
                            onGround: battery.onGround
                        });
                    }
                    console.log(`[BatterySystem] Broadcast initial battery state to all players`);
                } catch (e) {
                    console.warn('[BatterySystem] Failed to initialize:', e && e.message ? e.message : String(e));
                }
            }

            // IMPORTANT: Do NOT pre-spawn the entire enemy population here.
            // AmbientSpawner will trickle-spawn enemies over time, but we also want
            // an initial base population so the map isn't empty.
            this.enemies.clear();
            
            // Spawn mode-specific defensive turrets AFTER clearing enemies (e.g., trench raid gap turrets)
            if (this.currentGameMode && typeof this.currentGameMode.getDefensiveTurrets === 'function') {
                const turretConfigs = this.currentGameMode.getDefensiveTurrets();
                console.log(`[GameMode] getDefensiveTurrets returned:`, turretConfigs);
                if (Array.isArray(turretConfigs) && turretConfigs.length > 0) {
                    for (const config of turretConfigs) {
                        const turretId = `defenseTurret_${this.nextEnemyId++}`;
                        const turret = {
                            id: turretId,
                            x: config.x,
                            y: config.y,
                            type: 'defenseTurret',
                            faction: config.faction || 'newantioch',
                            size: config.size || 'large',
                            radius: 48,  // Larger than player turrets (32)
                            health: 999999,  // Effectively infinite
                            healthMax: 999999,
                            alive: true,
                            isDefenseTurret: true,
                            // Turret stats
                            range: 800,  // Longer range than player turrets
                            damage: 15,  // Higher damage
                            fireRate: 6,  // Faster fire rate (6 shots/sec)
                            _fireTimer: 0,
                            _targetId: null,
                            _barrelAngle: 0
                        };
                        
                        // Initialize navmesh pathfinding properties (turrets don't move but need properties for consistency)
                        this._initNavProperties(turret);
                        
                        this.enemies.set(turretId, turret);
                        console.log(`[GameMode] Ã¢Å“â€¦ Spawned defensive turret ${turretId} at (${config.x}, ${config.y}) AFTER clear`);
                    }
                    console.log(`[GameMode] Added ${turretConfigs.length} defensive turrets AFTER clear, total enemies: ${this.enemies.size}`);
                } else {
                    console.log(`[GameMode] No defensive turrets to spawn (configs empty or not array)`);
                }
            } else {
                console.log(`[GameMode] No getDefensiveTurrets method available on currentGameMode:`, this.currentGameMode?.constructor?.name);
            }
            
            // Spawn mode-specific artillery guns (e.g., trench raid New Antioch artillery)
            // Add to enemies map like defensive turrets so they get broadcasted to clients
            if (this.currentGameMode && typeof this.currentGameMode.getArtilleryGuns === 'function') {
                const artilleryConfigs = this.currentGameMode.getArtilleryGuns();
                if (Array.isArray(artilleryConfigs) && artilleryConfigs.length > 0) {
                    for (const config of artilleryConfigs) {
                        const artilleryId = `artilleryGun_${this.nextEnemyId++}`;
                        const artilleryGun = {
                            id: artilleryId,
                            x: config.x,
                            y: config.y,
                            type: 'artilleryGun',
                            faction: config.faction || 'newantioch',
                            radius: 64,
                            health: 999999,  // Effectively infinite (like defensive turrets)
                            healthMax: 999999,
                            alive: true,
                            isArtilleryGun: true,
                            // Artillery stats - fast bombardment like Artillery Witch
                            targetZone: config.targetZone,
                            _fireTimer: 1 + Math.random() * 1,  // Initial delay (1-2 seconds)
                            _shotTimer: 0,  // Time between individual shots in burst
                            _burstCount: 0,  // Shots remaining in current burst
                            _burstSize: 4 + Math.floor(Math.random() * 3),  // 4-6 shots per burst
                            // +20% fire rate (reduced intervals) because it fires into a wider area now
                            _burstCooldown: (4 + Math.random() * 2) / 1.2,  // ~3.33-5.00 seconds between bursts
                            _shotInterval: (0.5 + Math.random() * 0.2) / 1.2,  // ~0.42-0.58 seconds between shots
                            _barrelAngle: 0  // Will update toward target
                        };
                        
                        // Initialize navmesh pathfinding properties (artillery doesn't move but needs properties for consistency)
                        this._initNavProperties(artilleryGun);
                        
                        this.enemies.set(artilleryId, artilleryGun);
                        console.log(`[GameMode] Ã¢Å“â€¦ Spawned artillery gun ${artilleryId} at (${config.x}, ${config.y})`);
                    }
                    console.log(`[GameMode] Added ${artilleryConfigs.length} artillery guns to enemies map`);
                }
            }

            // Reposition all existing players to spawn locations (mode-specific or random)
            for (const [playerId, player] of this.players) {
                let spawnPos = { x: 0, y: 0 };
                
                // Use mode-specific spawn if available (e.g., trench raid left-side spawn)
                if (this.currentGameMode && typeof this.currentGameMode.getPlayerSpawnPosition === 'function') {
                    const spawnSeed = this.worldSeed + playerId.charCodeAt(0);
                    const rng = new SeededRNG(spawnSeed);
                    spawnPos = this.currentGameMode.getPlayerSpawnPosition(this.environment, rng);
                    console.log(`[Server] Repositioned player ${playerId} to mode-specific spawn: (${spawnPos.x.toFixed(1)}, ${spawnPos.y.toFixed(1)})`);
                } else {
                    // Fallback: random position in bounds
                    const spawnSeed = this.worldSeed + playerId.charCodeAt(0) + Date.now() + Math.random() * 1000;
                    spawnPos = this.generateRandomSpawnPosition(spawnSeed);
                    console.log(`[Server] Repositioned player ${playerId} to random spawn: (${spawnPos.x.toFixed(1)}, ${spawnPos.y.toFixed(1)})`);
                }
                
                player.x = spawnPos.x;
                player.y = spawnPos.y;
            }
            
            // Initialize allied troops for Trench Raid (spawn behind players)
            if (this.troopManager && modeConfig) {
                this.troopManager.clear();
                this.troopManager.onLevelStart(modeConfig);
            }
            
            // DEBUG FEATURE: Spawn debug chests near each player (if enabled)
            // MUST happen AFTER players are repositioned to their spawn locations!
            console.log('[Server] About to call _spawnDebugChestsNearPlayers()...');
            this._spawnDebugChestsNearPlayers();
            console.log('[Server] Finished calling _spawnDebugChestsNearPlayers()');
            
            // Prepare enemy spawn data for clients (include type for proper instantiation)
            const enemySpawnData = [];
            for (const [id, enemy] of this.enemies) {
                enemySpawnData.push({
                    id: enemy.id,
                    x: enemy.x,
                    y: enemy.y,
                    type: enemy.type || 'basic'
                });
            }
            console.log(`[READY_TIMER] Prepared ${enemySpawnData.length} enemies for client spawn`);
            const turretCount = enemySpawnData.filter(e => e.type === 'defenseTurret').length;
            console.log(`[READY_TIMER] Enemy types: ${enemySpawnData.map(e => e.type).join(', ')}`);
            console.log(`[READY_TIMER] Including ${turretCount} defensive turrets`);
            
            // Filter orientedBoxes for client sync (exclude sandbag collision boxes)
            const clientOrientedBoxes = (this.environment.orientedBoxes || []).filter(box => {
                return box.fill || box.stroke || box._abilityId;
            });

            // Clear lobby ground drops when entering a new level.
            // Lobby drops should persist while in the lobby, and be wiped only on level transition.
            try {
                if (this.groundItems && typeof this.groundItems.clear === 'function') {
                    const n = this.groundItems.size || 0;
                    this.groundItems.clear();
                    if (n > 0) console.log(`[READY_TIMER] Cleared ${n} groundItems on level start`);
                }
            } catch (e) {
                console.warn('[READY_TIMER] Failed to clear groundItems on level start:', e && e.message ? e.message : String(e));
            }
            
            io.to(this.id).emit('sceneChange', {
                scene: 'level',
                boundary: this.boundary, // Use room boundary (e.g., 23000 for Trench Raid)
                fromPlayer: 'SERVER_TIMER',
                obstacles: this.environment.obstacles,
                orientedBoxes: clientOrientedBoxes,
                levelType: this.levelType,
                levelSpawns: this.levelSpawns,
                enemies: enemySpawnData
            });
            console.log(`[READY_TIMER] Sent ${this.environment.obstacles.length} obstacles and ${enemySpawnData.length} enemies to all clients (boundary: ${this.boundary})`);

            // Send initial hazards state to clients (renderer can be added later)
            try {
                if (this.hazards) {
                    io.to(this.id).emit('hazardsState', this.hazards.serialize());
                    console.log('[Hazards] Broadcast initial hazardsState');
                }
            } catch (e) {
                console.warn('[Hazards] Failed to broadcast initial state:', e && e.message ? e.message : String(e));
            }

            setTimeout(() => {
                this.readyTimer.completed = false;
                this.readyTimer.startedBy = null;
                this.emitReadyTimerState();
            }, 1000);

            // After scene is set up, spawn an initial ambient batch of basics
            // (only if ambient spawning is enabled for this mode)
            try {
                if (this.ambientSpawner && this.ambientSpawner.config.ENABLED) {
                    const initialCount = 200; // base population
                    const spawned = this.ambientSpawner.spawnImmediate(initialCount, { 
                        typeRatios: this.currentGameMode.config.enemies.typeRatios, 
                        baseline: true 
                    });
                    console.log(`[AmbientSpawner] Initial population spawned: ${spawned}/${initialCount}`);
                } else {
                    console.log(`[AmbientSpawner] Initial population spawn SKIPPED (ambient spawning disabled for this mode)`);
                }
            } catch (e) {
                console.warn('[AmbientSpawner] Initial population spawn failed:', e && e.message ? e.message : String(e));
            }
        }
    }
    */ // END updateReadyTimer - Now using TimerManager
    
    /* COMMENTED OUT - Now using TimerManager (Phase 1)
    startExtractionTimer(startedByPlayerId, timerType = 'normal') {
        // Only start in level; ignore if already running or completed
        if (this.scene !== 'level') return;
        if (this.extractionTimer.started || this.extractionTimer.extracted) return;
        
        // Determine which zone is being used
        const zone = timerType === 'heretic' ? this.hereticExtractionZone : this.extractionZone;
        if (!zone) {
            console.warn(`[Server] Cannot start ${timerType} extraction timer - zone not yet spawned`);
            return;
        }
        
        // Validate all requirements server-side
        if (!this._validateExtractionStart(startedByPlayerId, timerType)) {
            console.log(`[Server] Extraction start validation failed for player ${startedByPlayerId}`);
            return;
        }
        
        this.extractionTimer.started = true;
        this.extractionTimer.extracted = false;
        this.extractionTimer.timeLeft = Number.isFinite(this.extractionTimer.timeTotal) ? this.extractionTimer.timeTotal : 60.0;
        this.extractionTimer.startedBy = startedByPlayerId || null;
        this.extractionTimer.type = timerType;
        console.log(`[Server] Extraction timer (${timerType}) started in room ${this.id} by ${startedByPlayerId}`);
        
        // Trigger game mode extraction spawn hook
        if (this.currentGameMode && typeof this.currentGameMode.onExtractionStart === 'function') {
            this.currentGameMode.onExtractionStart(timerType);
        }
        
        this.emitExtractionTimerState();
    }
    */ // END startExtractionTimer
    
    /* COMMENTED OUT - Now using TimerManager (Phase 1)
    _validateExtractionStart(playerId, timerType) {
        // Check player is near zone center
        const player = this.players.get(playerId);
        if (!player) return false;
        
        const zone = timerType === 'heretic' ? this.hereticExtractionZone : this.extractionZone;
        if (!zone) return false;
        
        const dx = player.x - zone.x;
        const dy = player.y - zone.y;
        const playerRadius = 26; // typical player radius
        const requiredProximity = playerRadius + 40;
        if (dx * dx + dy * dy > requiredProximity * requiredProximity) {
            return false;
        }
        
        // Check artifact has been picked up by someone
        let artifactPicked = false;
        for (const chest of this.chests.values()) {
            if (chest.variant !== 'brown' && chest.artifactCarriedBy) {
                artifactPicked = true;
                break;
            }
        }
        if (!artifactPicked) return false;
        
        // For heretic extraction, require conversion (check player state if tracked)
        if (timerType === 'heretic') {
            // Server doesn't currently track conversion state, so we trust client for now
            // In future, track conversion state on server
        }
        
        // For normal extraction, check if NPC_A is following and in zone
        if (timerType === 'normal') {
            // Server doesn't currently track NPC states, so we trust client for now
            // In future, add server-side NPC tracking
        }
        
        return true;
    }
    */ // END _validateExtractionStart
    
    /* COMMENTED OUT - Now using TimerManager (Phase 1)
    cancelExtractionTimer() {
        if (!this.extractionTimer.started || this.extractionTimer.extracted) return;
        this.extractionTimer.started = false;
        this.extractionTimer.timeLeft = 0;
        this.extractionTimer.startedBy = null;
        console.log(`[Server] Extraction timer cancelled in room ${this.id}`);
        this.emitExtractionTimerState();
    }
    */ // END cancelExtractionTimer
    
    /* COMMENTED OUT - Now using TimerManager (Phase 1)
    updateExtractionTimer(deltaTime) {
        if (!this.extractionTimer.started || this.extractionTimer.extracted) return;
        
        // Check if artifact was dropped outside zone - cancel timer
        const zone = this.extractionTimer.type === 'heretic' ? this.hereticExtractionZone : this.extractionZone;
        if (zone) {
            let artifactInZone = false;
            let artifactOnGround = false;
            
            for (const chest of this.chests.values()) {
                if (chest.variant === 'brown' || chest.variant === 'startGear') continue;
                
                // Check if artifact is being carried or on ground
                if (chest.artifactCarriedBy) {
                    const carrier = this.players.get(chest.artifactCarriedBy);
                    if (carrier) {
                        const half = (zone.size || 300) / 2;
                        const inZone = (carrier.x >= zone.x - half && carrier.x <= zone.x + half && 
                                       carrier.y >= zone.y - half && carrier.y <= zone.y + half);
                        if (inZone) artifactInZone = true;
                    }
                } else if (chest.artifactPos) {
                    // Artifact is on ground
                    artifactOnGround = true;
                    const half = (zone.size || 300) / 2;
                    const inZone = (chest.artifactPos.x >= zone.x - half && chest.artifactPos.x <= zone.x + half && 
                                   chest.artifactPos.y >= zone.y - half && chest.artifactPos.y <= zone.y + half);
                    if (inZone) artifactInZone = true;
                }
                break;
            }
            
            // If artifact is on ground and outside zone, cancel timer
            if (artifactOnGround && !artifactInZone) {
                this.cancelExtractionTimer();
                return;
            }
        }

        this.extractionTimer.timeLeft -= deltaTime;
        if (this.extractionTimer.timeLeft < 0) this.extractionTimer.timeLeft = 0;

        this.emitExtractionTimerState();

        if (this.extractionTimer.timeLeft <= 0) {
            this.extractionTimer.timeLeft = 0;
            this.extractionTimer.started = false;
            this.extractionTimer.extracted = true;
            console.log(`[Server] Extraction timer completed in room ${this.id}`);
            
            // Calculate Victory Points and award to successful extracting players
            this._calculateAndAwardVictoryPoints();
            
            // Mark mission as ended to stop enemy AI/targeting
            this.missionEnded = true;
            console.log('[Server] Mission ended - freezing enemy AI and damage');
            
            // Notify all clients extraction is complete
            this.emitExtractionTimerState();
            
            // Don't auto-return to lobby - let players read the accomplishment screen
            // Room will reset when players manually click "Return to Lobby"
        }
    }
    */ // END updateExtractionTimer
    
    /* COMMENTED OUT - Now using TimerManager (Phase 1)
    emitExtractionTimerState(targetSocket) {
        const payload = {
            started: this.extractionTimer.started,
            extracted: this.extractionTimer.extracted,
            timeLeft: this.extractionTimer.timeLeft,
            timeTotal: this.extractionTimer.timeTotal,
            startedBy: this.extractionTimer.startedBy,
            type: this.extractionTimer.type
        };
        if (targetSocket) targetSocket.emit('extractionTimerUpdate', payload);
        else io.to(this.id).emit('extractionTimerUpdate', payload);
    }
    */ // END emitExtractionTimerState
    
    // Helper to emit mission failed and freeze enemy AI
    emitMissionFailed(reason) {
        this.missionEnded = true;
        console.log(`[Server] Mission failed: ${reason} - freezing enemy AI and damage`);
        io.to(this.id).emit('missionFailed', { reason });
    }
    
    // Calculate and award Victory Points to successful extracting players
    _calculateAndAwardVictoryPoints() {
        try {
            // Only award VP for normal (non-heretic) extractions
            if (this.extractionTimer.type !== 'normal') {
                console.log('[Server] Heretic extraction - no VP awarded');
                return;
            }

            // Trench Raid does not use the Heretic Priest objective/VP.
            const includeHereticPriestObjective = (this.levelType !== 'trenchraid');
            
            // Freeze artillery timer at moment of extraction (for trench raid mode)
            if (this.levelType === 'trenchraid' && this.levelStartTime && this.artilleryFrozenElapsedMs === null) {
                this.artilleryFrozenElapsedMs = Date.now() - this.levelStartTime - this.artilleryBonusTimeMs;
                console.log(`[Server] Froze artillery timer at ${this.artilleryFrozenElapsedMs}ms elapsed`);
                
                // Check if extracted before artillery barrage started (9 minutes)
                const ARTILLERY_BARRAGE_START_MS = 9 * 60 * 1000;
                if (this.artilleryFrozenElapsedMs < ARTILLERY_BARRAGE_START_MS) {
                    this.missionAccomplishments.extractedBeforeArtillery = true;
                    console.log('[Server] Extracted before artillery barrage - accomplishment marked');
                }
            }
            
            // Find artifact and determine health percentage
            let artifactHealthPercent = 0; // Default to 0 (destroyed) if not found
            let artifactHealth = 0;
            let artifactHealthMax = 0;
            
            for (const chest of this.chests.values()) {
                if (chest.variant === 'gold') {
                    artifactHealth = Math.max(0, chest.health || 0);
                    artifactHealthMax = Math.max(1, chest.healthMax || 2000);
                    artifactHealthPercent = (artifactHealth / artifactHealthMax) * 100;
                    console.log(`[Server] Artifact health: ${artifactHealth}/${artifactHealthMax} = ${artifactHealthPercent.toFixed(1)}%`);
                    break;
                }
            }
            
            // Calculate artifact health VP bonus
            let artifactVP = 1; // Minimum 1 VP even if artifact is destroyed but extracted
            if (artifactHealthPercent >= 100) {
                artifactVP = 8; // Pristine
            } else if (artifactHealthPercent >= 75) {
                artifactVP = 4; // Good
            } else if (artifactHealthPercent >= 50) {
                artifactVP = 3; // Damaged
            } else if (artifactHealthPercent >= 25) {
                artifactVP = 2; // Critical
            } else {
                artifactVP = 1; // Destroyed but extracted
            }
            
            // Calculate total VP from accomplishments
            let totalVP = artifactVP;
            if (this.missionAccomplishments.artilleryWitchKilled) totalVP += 3;
            if (this.missionAccomplishments.prisonerMissionSuccess) totalVP += 1;
            if (includeHereticPriestObjective && this.missionAccomplishments.hereticPriestKilled) totalVP += 2;
            if (this.missionAccomplishments.radioTowerPowered) totalVP += 3;
            if (this.missionAccomplishments.extractedBeforeArtillery) totalVP += 5;
            
            console.log(`[Server] Mission success - awarding ${totalVP} VP (Artifact: ${artifactVP}, Witch: ${this.missionAccomplishments.artilleryWitchKilled ? 3 : 0}, Prisoner: ${this.missionAccomplishments.prisonerMissionSuccess ? 1 : 0}, Priest: ${(includeHereticPriestObjective && this.missionAccomplishments.hereticPriestKilled) ? 2 : 0}, RadioTower: ${this.missionAccomplishments.radioTowerPowered ? 3 : 0}, BeforeArtillery: ${this.missionAccomplishments.extractedBeforeArtillery ? 5 : 0})`);
            
            // Determine which players are in the extraction zone
            const zone = this.extractionZone;
            const extractingPlayers = [];
            
            if (zone) {
                const half = (zone.size || 300) / 2;
                for (const [playerId, player] of this.players) {
                    const inZone = (player.x >= zone.x - half && player.x <= zone.x + half && 
                                   player.y >= zone.y - half && player.y <= zone.y + half);
                    if (inZone) {
                        extractingPlayers.push(playerId);
                    }
                }
            }
            
            // Award VP to all players in extraction zone
            for (const playerId of extractingPlayers) {
                const player = this.players.get(playerId);
                if (player) {
                    player.victoryPoints = (player.victoryPoints || 0) + totalVP;
                    console.log(`[Server] Awarded ${totalVP} VP to player ${playerId} (total: ${player.victoryPoints})`);
                }
            }
            
            // Broadcast mission success with accomplishment breakdown
            const accomplishmentData = {
                artilleryWitchKilled: this.missionAccomplishments.artilleryWitchKilled,
                prisonerMissionSuccess: this.missionAccomplishments.prisonerMissionSuccess,
                ...(includeHereticPriestObjective ? { hereticPriestKilled: this.missionAccomplishments.hereticPriestKilled } : {}),
                radioTowerPowered: this.missionAccomplishments.radioTowerPowered,
                extractedBeforeArtillery: this.missionAccomplishments.extractedBeforeArtillery,
                artifactHealthPercent: Math.round(artifactHealthPercent),
                artifactVP: artifactVP,
                totalVP: totalVP,
                extractingPlayers: extractingPlayers
            };
            
            io.to(this.id).emit('missionSuccess', accomplishmentData);
            console.log('[Server] Broadcasted mission success with accomplishments:', accomplishmentData);
            
        } catch (error) {
            console.error('[Server] Error calculating Victory Points:', error);
        }
    }
    
    // Reset room back to lobby scene after extraction completes
    /* COMMENTED OUT - Now using LevelManager (Phase 5)
    resetToLobby() {
        console.log(`[Server] Resetting room ${this.id} to lobby`);
        
        // Reset scene and boundary
        this.scene = 'lobby';
        this.boundary = 1000;
        
        // Recreate lobby environment
        this.environment = this._createEnvironmentForScene('lobby');
        console.log(`[RESET] Recreated lobby environment with ${this.environment.obstacles.length} obstacles`);
        
        // Clear all level-specific state
        this.enemies.clear();
        this.chests.clear();
        this.groundItems.clear();
        this.levelSpawns = null;
        this.extractionZone = null;
        this.hereticExtractionZone = null;
        this.bossSpawn = null;
        this.boss = null;
        
        // Clear all abilities (shield walls, turrets, etc.)
        for (const [abilityId, ability] of this.abilities) {
            io.to(this.id).emit('abilityExpired', { serverId: abilityId });
        }
        this.abilities.clear();
        console.log('[RESET] Cleared all abilities');
        
        // Reset timers
        this.readyTimer = {
            started: false,
            completed: false,
            timeTotal: 10.0,
            timeLeft: 0,
            startedBy: null
        };
        this.extractionTimer = {
            started: false,
            extracted: false,
            timeTotal: 60.0,
            timeLeft: 0,
            startedBy: null,
            type: 'normal'
        };
        
        // Reset enemy network mode
        this.enemyNetMode = 'spawnOnly';
        
        // Reset mission accomplishments
        this.missionAccomplishments = {
            artilleryWitchKilled: false,
            prisonerMissionSuccess: false,
            hereticPriestKilled: false,
            radioTowerPowered: false,
            extractedBeforeArtillery: false,
            artifactFinalHealth: null,
            artifactHealthMax: null
        };
        
        // Reset frozen artillery timer
        this.artilleryFrozenElapsedMs = null;
        
        // Reset mission ended flag
        this.missionEnded = false;
        
        // Respawn lobby NPCs
        if (this.npcManager) {
            this.npcManager.npcs = [];
        }
        this.spawnLobbyAmbientNpcs();
        
        // Note: Target dummy is spawned by clients when they receive scene change
        
        // Clear all puke pools
        if (Array.isArray(this.boomerPools)) {
            this.boomerPools.length = 0;
        }
        
        // Clear all enemy projectiles
        if (Array.isArray(this.enemyProjectiles)) {
            this.enemyProjectiles.length = 0;
        }
        
        // Clear Trench Raid battery system state (RadioTower + batteries) so it never leaks into lobby / late-join snapshots
        try {
            if (this.batteries && typeof this.batteries.clear === 'function') {
                this.batteries.clear();
            }
        } catch(_) {}
        this.batteries = null;
        this.batteryStation = null;
        this.artilleryBonusTimeMs = 0;

        // Clear all environment hazards (gas, mud, fire pools, sandbags, etc.)
        if (this.hazards) {
            this.hazards = null;
            console.log('[RESET] Cleared all environment hazards');
        }
        
        // Reset all player states
        for (const [id, player] of this.players) {
            player.health = player.healthMax || 100;
            player.alive = true;
            player.artifactCarried = null;
            player.inventory = [];
            player.lootLevel = 0;  // Reset loot level to match empty inventory
            
            // Clear all status effects
            try {
                // Clear DOT stacks
                if (Array.isArray(player.dotStacks)) player.dotStacks.length = 0;
                player._dotAccum = 0;
                player._dotTextTimer = 0;
                
                // Clear ensnare effects
                if (player._ensnaredBy && typeof player._ensnaredBy.clear === 'function') {
                    player._ensnaredBy.clear();
                }
                player._ensnaredTimer = 0;
                player._ensnaredById = null;
                
                // Clear puke pool slow effects
                player._svSlowTimer = 0;
                player._svSlowed = false;
                
                // Broadcast cleared slow state to all clients
                io.to(this.id).emit('playerSlowState', { playerId: id, slowed: false });
                io.to(this.id).emit('playerMudSlowState', { playerId: id, slowed: false });
            } catch(e) {
                console.error(`[Server] Error clearing status effects for player ${id}:`, e);
            }
            
            // Reset position to lobby spawn (0,0)
            player.x = 0;
            player.y = 0;
        }
        console.log('[RESET] Cleared all player status effects and reset positions to lobby spawn');
        
        // Broadcast scene change to all clients
        io.to(this.id).emit('sceneChange', {
            scene: 'lobby',
            boundary: 1000,
            obstacles: this.environment.obstacles,
            levelSpawns: null
        });
        
        // Ensure lobby training dummies always exist on lobby return.
        // IMPORTANT: Must happen AFTER the lobby sceneChange so clients have already cleared/rebuilt their scene.
        try { this.spawnLobbyTargetDummy(5); } catch(_) {}
        
        console.log(`[RESET] Room ${this.id} reset to lobby complete`);
    }
    */ // END resetToLobby
    
    /* COMMENTED OUT - Now using LevelManager (Phase 5)
    // LEGACY: Compute server-authoritative chest and NPC placements for level scene
    // Kept for emergency rollback - now handled by game mode system
    _legacyComputeLevelSpawns() {
        try {
            if (this.scene !== 'level' || !this.environment) return null;
            const env = this.environment;
            const rng = new SeededRNG(this.worldSeed);
            const clearance = 28;
            const chests = [];
            let goldX = null, goldY = null;
            // Preferred test location near center
            const testX = 200;
            const testY = 150;
            const isClear = (x, y, r) => env.isInsideBounds(x, y, r) && !env.circleHitsAny(x, y, r);
            if (isClear(testX, testY, clearance)) {
                goldX = testX; goldY = testY;
            } else {
                const tries = 300;
                for (let i = 0; i < tries; i++) {
                    const ang = rng.randomFloat(0, Math.PI * 2);
                    const dist = 100 + rng.randomFloat(0, 300);
                    const nx = Math.cos(ang) * dist;
                    const ny = Math.sin(ang) * dist;
                    if (isClear(nx, ny, clearance)) { goldX = nx; goldY = ny; break; }
                }
            }
            if (goldX == null || goldY == null) return null;
            // Push gold chest
            chests.push({ id: `${Math.round(goldX)},${Math.round(goldY)}`, x: goldX, y: goldY, variant: 'gold' });
            // Brown chest near gold using seeded RNG
            for (let j = 0; j < 200; j++) {
                const ang2 = rng.randomFloat(0, Math.PI * 2);
                const d2 = 120 + rng.randomFloat(0, 180);
                const nx2 = goldX + Math.cos(ang2) * d2;
                const ny2 = goldY + Math.sin(ang2) * d2;
                if (isClear(nx2, ny2, clearance)) {
                    chests.push({ id: `${Math.round(nx2)},${Math.round(ny2)}`, x: nx2, y: ny2, variant: 'brown' });
                    break;
                }
            }
            // Spawn two NPCs near chest (types are labels for client)
            const npcs = [];
            const maxDist = 500;
            const npcR = 24;
            const triesNpc = 700;
            let placedA = false, placedB = false;
            for (let t = 0; t < triesNpc && (!placedA || !placedB); t++) {
                const ang = rng.randomFloat(0, Math.PI * 2);
                const dist = rng.randomFloat(0, maxDist);
                const tx = goldX + Math.cos(ang) * dist;
                const ty = goldY + Math.sin(ang) * dist;
                if (!isClear(tx, ty, npcR)) continue;
                // avoid overlapping any chest
                let okChest = true;
                for (let k = 0; k < chests.length; k++) {
                    const c = chests[k];
                    const cr = 20;
                    const dx = tx - c.x, dy = ty - c.y;
                    if (dx*dx + dy*dy <= (cr + npcR + 6) * (cr + npcR + 6)) { okChest = false; break; }
                }
                if (!okChest) continue;
                // avoid overlapping prior npc
                let okNpc = true;
                for (let k = 0; k < npcs.length; k++) {
                    const n = npcs[k];
                    const dx = tx - n.x, dy = ty - n.y;
                    if (dx*dx + dy*dy <= (npcR + (n.radius||24) + 6) * (npcR + (n.radius||24) + 6)) { okNpc = false; break; }
                }
                if (!okNpc) continue;
                if (!placedA) { npcs.push({ type: 'NPC_A', x: tx, y: ty, radius: npcR }); placedA = true; continue; }
                if (!placedB) { npcs.push({ type: 'NPC_B', x: tx, y: ty, radius: npcR }); placedB = true; continue; }
            }
            return { chests, npcs };
        } catch (e) {
            console.error('[Server] Failed to compute level spawns:', e);
            return null;
        }
    }
    */ // END _legacyComputeLevelSpawns
    
    /* COMMENTED OUT - Now using LevelManager (Phase 5)
    // LEGACY: Server-side enemy spawn computation (positions only)
    // Kept for emergency rollback - now handled by game mode system
    _legacyComputeEnemySpawns() {
        try {
            if (this.scene !== 'level' || !this.environment) return [];
            const env = this.environment;
            const rng = new SeededRNG(this.worldSeed + 777); // separate stream for enemies
            const max = env.maxRange || 10000;
            const enemyRadius = 26;
            const MOVEMENT_CLEARANCE = 16; // Add clearance to prevent spawning too close to obstacles
            const spawnCheckRadius = enemyRadius + MOVEMENT_CLEARANCE;
            const triesPerEnemy = 40;
            const totalCount = 800; // tune as needed

            const list = [];
            const sx = env.spawnSafeX || 0, sy = env.spawnSafeY || 0;
            const halfSafe = 750;

            const isClear = (x, y) => {
                if (!env.isInsideBounds(x, y, spawnCheckRadius)) return false;
                if (env.circleHitsAny && env.circleHitsAny(x, y, spawnCheckRadius)) return false;
                if (Math.abs(x - sx) <= halfSafe + enemyRadius && Math.abs(y - sy) <= halfSafe + enemyRadius) return false;
                return true;
            };

            for (let n = 0; n < totalCount; n++) {
                let placed = false;
                for (let t = 0; t < triesPerEnemy && !placed; t++) {
                    const x = rng.randomFloat(-max, max);
                    const y = rng.randomFloat(-max, max);
                    if (isClear(x, y)) {
                        const id = `enemy_${this.nextEnemyId++}`;
                        // Mix enemy types: 35% basic, 25% licker, 25% projectile, 15% boomer
                        const roll = rng.random();
                        let type = 'basic';
                        if (roll < 0.15) {
                            type = 'boomer';
                        } else if (roll < 0.40) {
                            type = 'projectile';
                        } else if (roll < 0.65) {
                            type = 'licker';
                        }
                        // else remains 'basic' (65% to 100% = 35%)
                        list.push({ id, x, y, type });
                        placed = true;
                    }
                }
            }
            return list;
        } catch (e) {
            console.error('[Server] Failed to compute enemy spawns:', e);
            return [];
        }
    }
    */ // END _legacyComputeEnemySpawns
    
    /**
     * Generate a random spawn position that avoids key map locations
     * @param {number} seed - Random seed for deterministic placement
     * @returns {{x: number, y: number}} Spawn position
     */
    /* COMMENTED OUT - Now using PlayerManager (Phase 4)
    generateRandomSpawnPosition(seed = Math.random() * 1000000) {
        if (!this.environment) {
            console.warn('[Spawn] No environment available, spawning at origin');
            return { x: 0, y: 0 };
        }
        
        const env = this.environment;
        const rng = new SeededRNG(seed);
        const playerRadius = 26;
        const clearance = playerRadius + 30; // Extra space for safety
        
        // Check if current game mode has a specific spawn configuration
        let spawnCenterX = 0;
        let spawnCenterY = 0;
        let spawnRadius = env.boundary - clearance - 10;
        let useFixedSpawnArea = false;
        
        if (this.gameModeConfig && this.gameModeConfig.spawn) {
            const spawnConfig = this.gameModeConfig.spawn;
            if (typeof spawnConfig.x === 'number' && typeof spawnConfig.y === 'number') {
                spawnCenterX = spawnConfig.x;
                spawnCenterY = spawnConfig.y;
                spawnRadius = spawnConfig.radius || 300;
                useFixedSpawnArea = true;
                console.log(`[Spawn] Using game mode spawn area: center (${spawnCenterX}, ${spawnCenterY}), radius ${spawnRadius}`);
            }
        }
        
        // Build list of exclusion zones (areas to avoid)
        const exclusionZones = [];
        
        // 1. Avoid extraction zones
        if (this.extractionZone) {
            exclusionZones.push({
                x: this.extractionZone.x,
                y: this.extractionZone.y,
                radius: 2200 // Large buffer to keep players far from extraction
            });
        }
        if (this.hereticExtractionZone) {
            exclusionZones.push({
                x: this.hereticExtractionZone.x,
                y: this.hereticExtractionZone.y,
                radius: 2200 // Large buffer to keep players far from extraction
            });
        }
        
        // 2. Avoid golden chest (search through this.chests)
        for (const [id, chest] of this.chests) {
            if (chest.variant === 'gold') {
                exclusionZones.push({
                    x: chest.x,
                    y: chest.y,
                    radius: 1600 // Stay far away from chest
                });
                break;
            }
        }
        
        // 3. Avoid boss spawn location
        if (this.bossSpawn) {
            exclusionZones.push({
                x: this.bossSpawn.x,
                y: this.bossSpawn.y,
                radius: 2500 // Very wide berth around boss spawn
            });
        }
        
        // 4. Avoid actual boss if spawned
        if (this.boss) {
            exclusionZones.push({
                x: this.boss.x,
                y: this.boss.y,
                radius: 2600 // Very wide berth around active boss
            });
        }
        
        // Try to find a valid spawn position
        const maxTries = 500;
        for (let i = 0; i < maxTries; i++) {
            let nx, ny;
            
            if (useFixedSpawnArea) {
                // Spawn within the game mode's designated spawn area (e.g., New Antioch side)
                const angle = rng.randomFloat(0, Math.PI * 2);
                const dist = rng.randomFloat(0, spawnRadius);
                nx = spawnCenterX + Math.cos(angle) * dist;
                ny = spawnCenterY + Math.sin(angle) * dist;
            } else {
                // Default: spawn anywhere on the map
                const boundary = env.boundary - clearance - 10;
                nx = (rng.randomFloat(0, 1) * 2 - 1) * boundary;
                ny = (rng.randomFloat(0, 1) * 2 - 1) * boundary;
            }
            
            // Check if position is inside bounds and doesn't hit obstacles
            if (!env.isInsideBounds(nx, ny, clearance)) continue;
            if (env.circleHitsAny(nx, ny, clearance)) continue;
            
            // Check if position is far enough from all exclusion zones
            let tooClose = false;
            for (const zone of exclusionZones) {
                const dx = nx - zone.x;
                const dy = ny - zone.y;
                const distSq = dx * dx + dy * dy;
                if (distSq < zone.radius * zone.radius) {
                    tooClose = true;
                    break;
                }
            }
            
            if (!tooClose) {
                console.log(`[Spawn] Generated spawn at (${nx.toFixed(1)}, ${ny.toFixed(1)}) after ${i + 1} tries`);
                return { x: nx, y: ny };
            }
        }
        
        // Fallback: spawn at the designated spawn center (or origin if no spawn config)
        console.warn('[Spawn] Could not find ideal spawn after max tries, using fallback position');
        if (useFixedSpawnArea) {
            console.log(`[Spawn] Fallback to spawn center: (${spawnCenterX}, ${spawnCenterY})`);
            return { x: spawnCenterX, y: spawnCenterY };
        } else {
            const boundary = env.boundary - clearance - 10;
            const fallbackAngle = rng.randomFloat(0, Math.PI * 2);
            const fallbackDist = boundary * 0.5;
            return {
                x: Math.cos(fallbackAngle) * fallbackDist,
                y: Math.sin(fallbackAngle) * fallbackDist
            };
        }
    }
    */ // END generateRandomSpawnPosition
    
    /* COMMENTED OUT - Now using LevelManager (Phase 5)
    // Compute server-authoritative extraction zone and boss spawn positions after artifact pickup
    _computeExtractionAndBossSpawns() {
        try {
            if (this.scene !== 'level' || !this.environment) return null;
            if (this.extractionZone) return { extractionZone: this.extractionZone, bossSpawn: this.bossSpawn, hereticExtractionZone: this.hereticExtractionZone }; // Already computed
            
            const env = this.environment;
            const rng = new SeededRNG(this.worldSeed + 1234); // Separate seed stream for extraction zones
            
            // Find gold chest position as reference
            let goldX = null, goldY = null;
            for (const [id, chest] of this.chests) {
                if (chest.variant === 'gold') {
                    goldX = chest.x;
                    goldY = chest.y;
                    break;
                }
            }
            if (goldX === null || goldY === null) return null;
            
            // Find first player position as fallback reference
            let refPlayerX = 0, refPlayerY = 0;
            for (const [pid, p] of this.players) {
                refPlayerX = p.x || 0;
                refPlayerY = p.y || 0;
                break;
            }
            
            // Check if game mode has custom extraction zone logic (e.g., trench raid left-side zone)
            let extractionX = null, extractionY = null;
            if (this.currentGameMode && typeof this.currentGameMode.computeExtractionZone === 'function') {
                // Use existing rng from extraction spawns computation
                const zone = this.currentGameMode.computeExtractionZone(env, rng);
                if (zone && zone.x !== undefined && zone.y !== undefined) {
                    extractionX = zone.x;
                    extractionY = zone.y;
                    this.extractionZone = { x: extractionX, y: extractionY, size: zone.radius || 450 };
                    console.log(`[Server] Using mode-specific extraction zone at (${extractionX.toFixed(1)}, ${extractionY.toFixed(1)})`);
                }
            }
            
            // Fallback: use default random placement if mode doesn't provide custom logic
            if (extractionX === null || extractionY === null) {
                const refX = goldX;
                const refY = goldY;
                const minFar = 2800;
                const maxFar = 5200;
                const tries = 400;
                const clearance = 160;
                
                // Compute extraction zone position
                for (let i = 0; i < tries; i++) {
                    const ang = rng.randomFloat(0, Math.PI * 2);
                    const dist = rng.randomFloat(minFar, maxFar);
                    const nx = refX + Math.cos(ang) * dist;
                    const ny = refY + Math.sin(ang) * dist;
                    if (env.isInsideBounds(nx, ny, clearance) && !env.circleHitsAny(nx, ny, clearance)) {
                        extractionX = nx;
                        extractionY = ny;
                        break;
                    }
                }
                if (extractionX === null || extractionY === null) {
                    extractionX = refX + 3600;
                    extractionY = refY + 3600;
                }
                
                this.extractionZone = { x: extractionX, y: extractionY, size: 450 };
                console.log(`[Server] Computed default extraction zone at (${extractionX.toFixed(1)}, ${extractionY.toFixed(1)})`);
            }
            
            // Compute boss spawn position
            const bossRadius = 78;
            let bossX = null, bossY = null;
            
            // Check if game mode has custom boss spawn logic (e.g., TrenchRaid spawns boss near artifact)
            if (this.currentGameMode && typeof this.currentGameMode.computeBossSpawn === 'function') {
                const bossPos = this.currentGameMode.computeBossSpawn(env, rng, goldX, goldY, extractionX, extractionY, refPlayerX, refPlayerY);
                if (bossPos && bossPos.x !== undefined && bossPos.y !== undefined) {
                    bossX = bossPos.x;
                    bossY = bossPos.y;
                    console.log(`[Server] Using mode-specific boss spawn at (${bossX.toFixed(1)}, ${bossY.toFixed(1)})`);
                }
            }
            
            // Default boss spawn logic if mode doesn't provide custom logic
            if (bossX === null || bossY === null) {
                const minDistPlayer = 2600;
                const minDistZone = 2600;
                const triesBoss = 700;
                const b = env.boundary - bossRadius - 10;
                
                for (let i = 0; i < triesBoss; i++) {
                    const nx = (rng.randomFloat(0, 1) * 2 - 1) * b;
                    const ny = (rng.randomFloat(0, 1) * 2 - 1) * b;
                    
                    // Distance from first player
                    const dpx = nx - refPlayerX;
                    const dpy = ny - refPlayerY;
                    if (dpx * dpx + dpy * dpy < minDistPlayer * minDistPlayer) continue;
                    
                    // Distance from extraction zone
                    const dzx = nx - extractionX;
                    const dzy = ny - extractionY;
                    if (dzx * dzx + dzy * dzy < minDistZone * minDistZone) continue;
                    
                    // Environment checks
                    if (!env.isInsideBounds(nx, ny, bossRadius)) continue;
                    if (env.circleHitsAny(nx, ny, bossRadius)) continue;
                    
                    bossX = nx;
                    bossY = ny;
                    break;
                }
                
                // Fallback boss position
                if (bossX === null || bossY === null) {
                    bossX = refPlayerX + 3200;
                    bossY = refPlayerY + 3200;
                    if (!env.isInsideBounds(bossX, bossY, bossRadius) || env.circleHitsAny(bossX, bossY, bossRadius)) {
                        bossX = Math.max(-b, Math.min(b, bossX));
                        bossY = Math.max(-b, Math.min(b, bossY));
                    }
                }
                console.log(`[Server] Using default boss spawn at (${bossX.toFixed(1)}, ${bossY.toFixed(1)})`);
            }
            
            this.bossSpawn = { x: bossX, y: bossY };
            console.log(`[Server] Computed boss spawn at (${bossX.toFixed(1)}, ${bossY.toFixed(1)})`);
            
            // Create boss enemy on server for tracking and replication
            const bossId = `boss_${bossX.toFixed(0)}_${bossY.toFixed(0)}`;
            if (!this.enemies.has(bossId)) {
                const boss = {
                    id: bossId,
                    x: bossX,
                    y: bossY,
                    type: 'boss',
                    alive: true,
                    health: 2000,        // Artillery Witch boss-tier health
                    healthMax: 2000,
                    radius: 32,          // Artillery Witch radius (Boomer-sized)
                    // Artillery Witch specific state
                    speedMul: 0,
                    preferContact: false,
                    kbTime: 0,
                    kbVelX: 0,
                    kbVelY: 0,
                    _artilleryTimer: 1.0 + Math.random() * 0.8,
                    _artilleryCooldown: 1.25,
                    _dashCooldown: 1.5 + Math.random(),
                    _dashDistance: 360,
                    _dashDuration: 0.2,
                    _burstMode: false,
                    _burstTimer: 0,
                    _burstShotTimer: 0,
                    _targetPlayerId: null,  // Track which player is being targeted
                    _lastStrikeX: 0,        // For client telegraph sync
                    _lastStrikeY: 0,
                    _lastStrikeTime: 0
                };
                
                // Initialize navmesh pathfinding properties
                this._initNavProperties(boss);
                
                this.enemies.set(bossId, boss);
                console.log(`[Server] Created boss enemy entity with id: ${bossId}`);
            }
            
            // Spawn difficulty 3 horde near the Witch when she appears (direct spawn, no camera check)
            if (this.hordeSpawner) {
                console.log('[Boss] Artillery Witch spawned - summoning difficulty 3 horde near her position!');
                const preset = this.hordeSpawner.config.DIFFICULTY_PRESETS[3];
                const rngHorde = this._rng(this.worldSeed + 7777);
                const spawned = [];
                
                // Minimum distance from gold chest to avoid spawning horde on top of it
                const minDistFromGold = 600;
                
                for (let i = 0; i < preset.size; i++) {
                    let placed = false;
                    for (let tries = 0; tries < 50 && !placed; tries++) {
                        // Random position 400-800 units from boss (closer to witch, away from chest)
                        const angle = rngHorde() * Math.PI * 2;
                        const dist = 400 + rngHorde() * 400;
                        const ex = bossX + Math.cos(angle) * dist;
                        const ey = bossY + Math.sin(angle) * dist;
                        
                        // Check bounds and obstacles only (no camera check)
                        // Use 42 = 26 base radius + 16 movement clearance to prevent spawning too close to obstacles
                        if (!env.isInsideBounds(ex, ey, 42)) continue;
                        if (env.circleHitsAny && env.circleHitsAny(ex, ey, 42)) continue;
                        
                        // Avoid spawning too close to gold chest
                        const dxGold = ex - goldX;
                        const dyGold = ey - goldY;
                        const distToGold = Math.sqrt(dxGold * dxGold + dyGold * dyGold);
                        if (distToGold < minDistFromGold) continue;
                        
                        // Pick enemy type
                        const roll = rngHorde();
                        let type = 'basic';
                        let acc = 0;
                        for (const t of ['boomer', 'projectile', 'licker', 'bigboy', 'wallguy']) {
                            acc += preset.typeRatios[t] || 0;
                            if (roll < acc) { type = t; break; }
                        }
                        
                        const id = `enemy_${this.nextEnemyId++}`;
                        const enemy = {
                            id, x: ex, y: ey, type,
                            radius: 26, health: 100, healthMax: 100,
                            speedMul: 1.0, alive: true,
                            _preAggroGoal: { x: bossX, y: bossY, radius: 400, dynamic: false, source: 'boss_spawn' },
                            _spawnedFrom: 'bossHorde'
                        };
                        
                        if (this.currentGameMode) {
                            this.currentGameMode.initializeEnemyStats(enemy);
                        }
                        
                        // Initialize navmesh pathfinding properties
                        this._initNavProperties(enemy);
                        
                        this.enemies.set(id, enemy);
                        spawned.push(enemy);
                        placed = true;
                    }
                }
                
                if (spawned.length > 0) {
                    this.spawnAmbientBatch(spawned);
                    console.log(`[Boss] Spawned ${spawned.length} enemies near Witch at spawn (away from gold chest)`);
                    
                    io.to(this.id).emit('horde_spawned', {
                        difficulty: 3,
                        count: spawned.length,
                        phase: 'boss_spawn',
                        message: 'The Witch calls her servants!'
                    });
                }
            }
            
            // Compute heretic extraction zone if needed (optional for now, can be computed on demand)
            // For now, we'll compute it with a similar logic
            const minFarFromGreen = 2200;
            const minFarFromGold = 2200;
            const minFarFromBoss = 2200;
            let hereticX = null, hereticY = null;
            const baseX = goldX + 3800, baseY = goldY - 3600;
            
            for (let i = 0; i < 600; i++) {
                const ang = rng.randomFloat(0, Math.PI * 2);
                const dist = rng.randomFloat(3000, 5400);
                const nx = baseX + Math.cos(ang) * dist;
                const ny = baseY + Math.sin(ang) * dist;
                
                if (!env.isInsideBounds(nx, ny, 160)) continue;
                if (env.circleHitsAny(nx, ny, 160)) continue;
                
                // Far from normal extraction
                const dxe = nx - extractionX;
                const dye = ny - extractionY;
                if (dxe * dxe + dye * dye < minFarFromGreen * minFarFromGreen) continue;
                
                // Far from gold chest
                const dxg = nx - goldX;
                const dyg = ny - goldY;
                if (dxg * dxg + dyg * dyg < minFarFromGold * minFarFromGold) continue;
                
                // Far from boss
                const dxb = nx - bossX;
                const dyb = ny - bossY;
                if (dxb * dxb + dyb * dyb < minFarFromBoss * minFarFromBoss) continue;
                
                hereticX = nx;
                hereticY = ny;
                break;
            }
            
            if (hereticX === null || hereticY === null) {
                // Fallback
            hereticX = goldX - 3600;
            hereticY = goldY - 3600;
        }
        
        this.hereticExtractionZone = { x: hereticX, y: hereticY, size: 450 };
            console.log(`[Server] Computed heretic extraction zone at (${hereticX.toFixed(1)}, ${hereticY.toFixed(1)})`);
            
            return {
                extractionZone: this.extractionZone,
                bossSpawn: this.bossSpawn,
                hereticExtractionZone: this.hereticExtractionZone
            };
        } catch (e) {
            console.error('[Server] Failed to compute extraction zones and boss spawn:', e);
            return null;
        }
    }
    */ // END _computeExtractionAndBossSpawns
    
    // Helper to clear licker ensnare when a licker dies (call from ALL death paths)
    /* COMMENTED OUT - Now using CombatManager (Phase 6)
    _clearLickerEnsnareOnDeath(enemyId, enemyType) {
        if (enemyType !== 'licker') return;
        
        // Clear ensnare state for all players
        for (const [, p] of this.players) {
            if (!p) continue;
            if (p._ensnaredBy && p._ensnaredBy.has(enemyId)) {
                p._ensnaredBy.delete(enemyId);
                // Recalculate aggregate ensnare timer
                let maxTimer = 0;
                let primaryId = null;
                if (p._ensnaredBy.size > 0) {
                    for (const [eid, timer] of p._ensnaredBy) {
                        if (timer > maxTimer) {
                            maxTimer = timer;
                            primaryId = eid;
                        }
                    }
                }
                p._ensnaredTimer = maxTimer;
                p._ensnaredById = primaryId;
                console.log(`[Server] Cleared licker ${enemyId} ensnare from player ${p.id}`);
            }
        }
    }
    */ // END _clearLickerEnsnareOnDeath
    
    // Server-driven enemy movement using per-player Directors (nearest-player grouping)
        
    /* COMMENTED OUT - Now using EnemyManager (Phase 9 - FINAL!)
    _updateEnemySandbagBreaking(deltaTime) {
        // Enemy sandbag breaking: if stuck for 2+ seconds, attack nearest sandbag
        if (!this.hazards || !this.hazards.sandbags) return;
        
        for (const [, e] of this.enemies) {
            if (!e || !e.alive) continue;
            // Skip stationary enemies and special types
            if (e.type === 'defenseTurret' || e.type === 'artilleryGun' || e.type === 'boss' || e.type === 'targetDummy') continue;
            
            // Initialize stuck tracking
            if (!e._obstacleStuckTimer) e._obstacleStuckTimer = 0;
            if (!e._lastObstaclePos) e._lastObstaclePos = { x: e.x, y: e.y };
            
            const distMoved = Math.hypot(e.x - e._lastObstaclePos.x, e.y - e._lastObstaclePos.y);
            
            if (distMoved < 5) { 
                e._obstacleStuckTimer += deltaTime; 
            } else { 
                e._obstacleStuckTimer = 0;
                e._lastObstaclePos = { x: e.x, y: e.y };
            }
            
            // If stuck for 2+ seconds, find and attack nearest sandbag
            if (e._obstacleStuckTimer > 2.0) {
                let nearestSandbag = null;
                let nearestDist = 150; // Slightly larger range for enemies
                
                for (const sb of this.hazards.sandbags) {
                    if (!sb || sb.health <= 0) continue;
                    const dist = Math.hypot(sb.x - e.x, sb.y - e.y);
                    if (dist < nearestDist) {
                        nearestSandbag = sb;
                        nearestDist = dist;
                    }
                }
                
                // Attack the sandbag if found (cooldown per enemy to prevent spam)
                if (nearestSandbag) {
                    if (!e._sandbagAttackCooldown) e._sandbagAttackCooldown = 0;
                    e._sandbagAttackCooldown -= deltaTime;
                    
                    if (e._sandbagAttackCooldown <= 0) {
                        const ENEMY_OBSTACLE_DAMAGE = 80; // 4 hits to destroy (weaker than troops)
                        
                        nearestSandbag.health = Math.max(0, nearestSandbag.health - ENEMY_OBSTACLE_DAMAGE);
                        
                        io.to(this.id).emit("hazardHit", {
                            type: "sandbag",
                            id: nearestSandbag.id,
                            x: nearestSandbag.x,
                            y: nearestSandbag.y,
                            health: nearestSandbag.health
                        });
                        
                        if (nearestSandbag.health <= 0) {
                            // Remove collision box
                            if (Number.isInteger(nearestSandbag.boxIndex) && nearestSandbag.boxIndex >= 0 && this.environment.orientedBoxes) {
                                this.environment.orientedBoxes.splice(nearestSandbag.boxIndex, 1);
                                for (let j = 0; j < this.hazards.sandbags.length; j++) {
                                    if (this.hazards.sandbags[j] && this.hazards.sandbags[j].boxIndex > nearestSandbag.boxIndex) {
                                        this.hazards.sandbags[j].boxIndex -= 1;
                                    }
                                }
                            }
                            const idx = this.hazards.sandbags.indexOf(nearestSandbag);
                            if (idx >= 0) this.hazards.sandbags.splice(idx, 1);
                            
                            io.to(this.id).emit("hazardRemoved", {
                                type: "sandbag",
                                id: nearestSandbag.id,
                                x: nearestSandbag.x,
                                y: nearestSandbag.y,
                                w: nearestSandbag.w,
                                h: nearestSandbag.h,
                                variant: nearestSandbag.variant,
                                angle: nearestSandbag.angle
                            });
                            
                            e._obstacleStuckTimer = 0;
                        }
                        
                        e._sandbagAttackCooldown = 0.8; // Slower attack rate for enemies
                    }
                }
            }
        }
    }
    */ // END _updateEnemySandbagBreaking

    /* COMMENTED OUT - Now using EnemyManager (Phase 9 - FINAL!)
updateEnemies(deltaTime) {
        try {
            if (!DirectorClass) return;
            if (!this.environment) return;
            if (this.players.size === 0) return;
            if (!this.enemies || this.enemies.size === 0) return;

            // Prevent movement tunneling on server hitches / long frames
            deltaTime = Math.max(0, Math.min(0.05, Number(deltaTime) || 0));
            if (deltaTime <= 0) return;
            
            // PHASE 0: Navmesh-based pathfinding for enemies with blocked line-of-sight (Trench Raid only)
            if (this.levelType === 'trenchraid' && this._navDebug) {
                this._updateNavmeshMovement(deltaTime);
            }

            // PHASE 0.5: Enemy sandbag breaking (after navmesh, before Director)
            this._updateEnemySandbagBreaking(deltaTime);

            // PHASE 1: Update enemy behavior state BEFORE wrapping (so Director sees current state)
            
            // Server-authoritative Artillery Witch (boss) behavior update
            for (const e of this.enemies.values()) {
                if (!e || e.type !== 'boss' || e.alive === false) continue;
                
                // Find nearest player for targeting (skip invisible players)
                let closestPlayer = null;
                let closestDist = Infinity;
                for (const [, p] of this.players) {
                    if (!p || p.health <= 0) continue;
                    // Skip invisible players or players reading dialogue
                    if (p.invisible === true || p.dialogueOpen === true) continue;
                    const dx = (p.x || 0) - (e.x || 0);
                    const dy = (p.y || 0) - (e.y || 0);
                    const dist = Math.hypot(dx, dy);
                    if (dist < closestDist) {
                        closestDist = dist;
                        closestPlayer = p;
                    }
                }
                
                if (!closestPlayer) {
                    // No valid target - enter wandering/patrol mode
                    
                    // Initialize wander state if not exists
                    if (!e._wanderTarget || !e._wanderReachedTarget) {
                        e._wanderTarget = null;
                        e._wanderReachedTarget = true;
                        e._wanderPauseTimer = 0;
                    }
                    
                    // Pick new wander target when pause ended or not set
                    if ((e._wanderReachedTarget && e._wanderPauseTimer <= 0) || !e._wanderTarget) {
                        const wanderDist = 400 + Math.random() * 600; // 400-1000 units away
                        const wanderAngle = Math.random() * Math.PI * 2;
                        e._wanderTarget = {
                            x: e.x + Math.cos(wanderAngle) * wanderDist,
                            y: e.y + Math.sin(wanderAngle) * wanderDist
                        };
                        e._wanderReachedTarget = false;
                        e._wanderPauseTimer = 0;
                    }
                    
                    // Move toward wander target
                    const dx = e._wanderTarget.x - e.x;
                    const dy = e._wanderTarget.y - e.y;
                    const distToWander = Math.hypot(dx, dy);
                    
                    // Check if reached wander target (larger threshold for big movements)
                    if (distToWander < 80) {
                        // Initialize pause when first reaching target
                        if (!e._wanderReachedTarget) {
                            e._wanderReachedTarget = true;
                            e._wanderPauseTimer = 1.5 + Math.random() * 2.5; // 1.5-4 second pause for boss
                        }
                        
                        // Decrement pause timer
                        e._wanderPauseTimer -= deltaTime;
                        
                        if (e._wanderPauseTimer > 0) {
                            e.speedMul = 0; // Stop at waypoint during pause
                        } else {
                            // Pause ended, will pick new target next frame
                            e.speedMul = 0;
                        }
                    } else {
                        e.speedMul = 1.0; // Normal speed wandering
                        e._targetPlayerId = null;
                        e._wanderPauseTimer = 0;
                    }
                    
                    // Skip attack behaviors while wandering
                    continue;
                }
                
                // Clear wander state when target found
                e._wanderTarget = null;
                e._wanderReachedTarget = true;
                
                // Update target
                e._targetPlayerId = closestPlayer.id;
                
                // Movement gate: move only when within 2000 units
                e.speedMul = (closestDist <= 2000) ? 1 : 0;
                
                // Debug log for boss movement (remove after testing)
                if (Math.random() < 0.01) { // Log 1% of frames to avoid spam
                    console.log(`[Boss] Distance: ${closestDist.toFixed(1)}, speedMul: ${e.speedMul}, pos: (${e.x.toFixed(1)}, ${e.y.toFixed(1)})`);
                }
                
                // Spawn difficulty 5 horde when boss drops below 40% health (direct spawn, no camera check)
                if (e.health > 0 && e.healthMax > 0) {
                    const healthPercent = e.health / e.healthMax;
                    
                    if (e._bossLowHealthHordeSpawned === undefined) {
                        e._bossLowHealthHordeSpawned = false;
                    }
                    
                    if (!e._bossLowHealthHordeSpawned && healthPercent < 0.40) {
                        e._bossLowHealthHordeSpawned = true;
                        console.log('[Boss] Health below 40% - spawning difficulty 5 horde near Witch!');
                        
                        const preset = this.hordeSpawner?.config?.DIFFICULTY_PRESETS?.[5];
                        if (preset) {
                            const rngHorde = this._rng(Date.now() + 8888);
                            const spawned = [];
                            const env = this.environment;
                            
                            // Find gold chest to avoid spawning near it
                            let goldChestX = null, goldChestY = null;
                            for (const chest of this.chests.values()) {
                                if (chest.variant === 'gold') {
                                    goldChestX = chest.x;
                                    goldChestY = chest.y;
                                    break;
                                }
                            }
                            const minDistFromGold = 600;
                            
                            for (let i = 0; i < preset.size; i++) {
                                let placed = false;
                                for (let tries = 0; tries < 50 && !placed; tries++) {
                                    // Random position 400-800 units from boss (closer to witch)
                                    const angle = rngHorde() * Math.PI * 2;
                                    const dist = 400 + rngHorde() * 400;
                                    const ex = e.x + Math.cos(angle) * dist;
                                    const ey = e.y + Math.sin(angle) * dist;
                                    
                                    // Check bounds and obstacles only (no camera check)
                                    // Use 42 = 26 base radius + 16 movement clearance to prevent spawning too close to obstacles
                                    if (!env.isInsideBounds(ex, ey, 42)) continue;
                                    if (env.circleHitsAny && env.circleHitsAny(ex, ey, 42)) continue;
                                    
                                    // Avoid spawning too close to gold chest
                                    if (goldChestX !== null && goldChestY !== null) {
                                        const dxGold = ex - goldChestX;
                                        const dyGold = ey - goldChestY;
                                        const distToGold = Math.sqrt(dxGold * dxGold + dyGold * dyGold);
                                        if (distToGold < minDistFromGold) continue;
                                    }
                                    
                                    // Pick enemy type
                                    const roll = rngHorde();
                                    let type = 'basic';
                                    let acc = 0;
                                    for (const t of ['boomer', 'projectile', 'licker', 'bigboy', 'wallguy']) {
                                        acc += preset.typeRatios[t] || 0;
                                        if (roll < acc) { type = t; break; }
                                    }
                                    
                                    const id = `enemy_${this.nextEnemyId++}`;
                                    const enemy = {
                                        id, x: ex, y: ey, type,
                                        radius: 26, health: 100, healthMax: 100,
                                        speedMul: 1.0, alive: true,
                                        _preAggroGoal: { x: e.x, y: e.y, radius: 400, dynamic: false, source: 'boss_enrage' },
                                        _spawnedFrom: 'bossHorde'
                                    };
                                    
                                    if (this.currentGameMode) {
                                        this.currentGameMode.initializeEnemyStats(enemy);
                                    }
                                    
                                    // Initialize navmesh pathfinding properties
                                    this._initNavProperties(enemy);
                                    
                                    this.enemies.set(id, enemy);
                                    spawned.push(enemy);
                                    placed = true;
                                }
                            }
                            
                            if (spawned.length > 0) {
                                this.spawnAmbientBatch(spawned);
                                console.log(`[Boss] Spawned ${spawned.length} enemies near Witch (low health, away from gold chest)`);
                                
                                io.to(this.id).emit('horde_spawned', {
                                    difficulty: 5,
                                    count: spawned.length,
                                    phase: 'boss_enrage',
                                    message: 'The Witch shrieks in rage!'
                                });
                            }
                        }
                    }
                }
                
                // Update timers
                e._dashCooldown = (e._dashCooldown || 0) - deltaTime;
                e._artilleryTimer = (e._artilleryTimer || 0) - deltaTime;
                
                // Reactive dash: evade imminent projectile
                if (e._dashCooldown <= 0) {
                    // Check for threatening projectiles (simulated - would need actual tracking)
                    // For now, occasionally dash away from player when close
                    const dx = (closestPlayer.x || 0) - e.x;
                    const dy = (closestPlayer.y || 0) - e.y;
                    if (closestDist <= 1200 && Math.random() < 0.015) { // Low chance per frame
                        // Dash away from player
                        const inv = closestDist > 0 ? (1 / closestDist) : 0;
                        const ux = -dx * inv; // away from player
                        const uy = -dy * inv;
                        // Apply knockback for dash
                        e.kbVelX = ux * (e._dashDistance || 360) / (e._dashDuration || 0.2);
                        e.kbVelY = uy * (e._dashDistance || 360) / (e._dashDuration || 0.2);
                        e.kbTime = e._dashDuration || 0.2;
                        // Next dash in 3-6 seconds
                        e._dashCooldown = 3 + Math.random() * 3;
                        
                        // Broadcast dash event
                        io.to(this.id).emit('bossDashed', {
                            bossId: e.id,
                            x: e.x,
                            y: e.y,
                            dirX: ux,
                            dirY: uy,
                            distance: e._dashDistance
                        });
                    }
                }
                
                // Burst mode management
                if (e._burstMode) {
                    e._burstTimer = (e._burstTimer || 0) - deltaTime;
                    e._burstShotTimer = (e._burstShotTimer || 0) - deltaTime;
                    
                    // Range gate for burst
                    const dx = (closestPlayer.x || 0) - e.x;
                    const dy = (closestPlayer.y || 0) - e.y;
                    if (closestDist > 1500) {
                        // Out of range, don't fire
                    } else if (e._burstShotTimer <= 0) {
                        // Fire a strike around the player at a random ring position
                        const ang = Math.random() * Math.PI * 2;
                        const rad = 120 + Math.random() * 220;
                        const tx = closestPlayer.x + Math.cos(ang) * rad;
                        const ty = closestPlayer.y + Math.sin(ang) * rad;
                        
                        // Schedule artillery strike
                        this._scheduleArtilleryStrike(e, tx, ty, 0.55, io);
                        
                        // Faster rate during burst
                        e._burstShotTimer = 0.22 + (Math.random() * 0.06 - 0.03);
                    }
                    
                    if (e._burstTimer <= 0) {
                        e._burstMode = false;
                        e._artilleryTimer = (e._artilleryCooldown || 1.25) + (Math.random() * 0.4 - 0.2);
                    }
                    // Don't skip to abilities - continue to let Director move the boss
                }
                
                // Single-shot artillery logic (only when not in burst mode)
                if (!e._burstMode && e._artilleryTimer <= 0) {
                    const dx = (closestPlayer.x || 0) - e.x;
                    const dy = (closestPlayer.y || 0) - e.y;
                    
                    // Range gate: only fire when within 1500
                    if (closestDist > 1500) {
                        e._artilleryTimer = 0.2;
                    } else if (Math.random() < 0.25) {
                        // Occasionally enter burst mode
                        e._burstMode = true;
                        e._burstTimer = 2.0;
                        e._burstShotTimer = 0; // fire immediately
                    } else if (closestDist <= 800 && Math.random() < 0.45) {
                        // Close-range Fast Ball (straight, 1.5x speed, 2x radius)
                        const inv = closestDist > 0 ? (1 / closestDist) : 0;
                        const ux = dx * inv;
                        const uy = dy * inv;
                        const ang = Math.atan2(uy, ux);
                        const spawnX = e.x + ux * ((e.radius || 32) + 8);
                        const spawnY = e.y + uy * ((e.radius || 32) + 8);
                        const projectileSpeed = 600 * 1.5; // 1.5x
                        const vx = Math.cos(ang) * projectileSpeed;
                        const vy = Math.sin(ang) * projectileSpeed;
                        const r = 6 * 2; // 2x size
                        const life = 3.6;
                        const color = '#ffa64d';
                        
                        // Broadcast Fast Ball
                        io.to(this.id).emit('bossFastBall', {
                            bossId: e.id,
                            x: spawnX,
                            y: spawnY,
                            vx,
                            vy,
                            radius: r,
                            color,
                            life,
                            angle: ang,
                            damage: 35
                        });
                        
                        // Track projectile for collision
                        this.enemyProjectiles.push({
                            x: spawnX,
                            y: spawnY,
                            vx,
                            vy,
                            radius: r,
                            damage: 35, // Higher damage for Fast Ball
                            life,
                            maxLife: life,
                            type: 'fastball',
                            ownerId: e.id
                        });
                        
                        e._artilleryTimer = (e._artilleryCooldown || 1.25) + (Math.random() * 0.3 - 0.15);
                    } else {
                        // Single aimed strike at player's current position
                        this._scheduleArtilleryStrike(e, closestPlayer.x, closestPlayer.y, 0.6, io);
                        e._artilleryTimer = (e._artilleryCooldown || 1.25) + (Math.random() * 0.4 - 0.2);
                    }
                }
            }
            
            // Server-authoritative Defensive Turret behavior update
            for (const e of this.enemies.values()) {
                if (!e || e.type !== 'defenseTurret' || e.alive === false) continue;
                
                // Update fire timer
                e._fireTimer = (e._fireTimer || 0) - deltaTime;
                
                // Find nearest enemy within range
                let closestEnemy = null;
                let closestDist = Infinity;
                for (const [, enemy] of this.enemies) {
                    // Don't target other defensive turrets, artillery guns, or ourselves
                    if (!enemy || enemy.id === e.id || enemy.type === 'defenseTurret' || enemy.type === 'artilleryGun' || enemy.alive === false) continue;
                    
                    const dx = (enemy.x || 0) - (e.x || 0);
                    const dy = (enemy.y || 0) - (e.y || 0);
                    const dist = Math.hypot(dx, dy);
                    
                    if (dist < closestDist && dist <= e.range) {
                        closestDist = dist;
                        closestEnemy = enemy;
                    }
                }
                
                // Fire at closest enemy if fire timer ready
                if (closestEnemy && e._fireTimer <= 0) {
                    const dx = closestEnemy.x - e.x;
                    const dy = closestEnemy.y - e.y;
                    const dist = Math.hypot(dx, dy);
                    const inv = dist > 0 ? (1 / dist) : 0;
                    const ux = dx * inv;
                    const uy = dy * inv;
                    const ang = Math.atan2(uy, ux);
                    
                    // Update barrel angle for rendering synchronization
                    e._barrelAngle = ang;
                    
                    // Spawn projectile from turret
                    const spawnX = e.x + ux * (e.radius + 8);
                    const spawnY = e.y + uy * (e.radius + 8);
                    const projectileSpeed = 450;
                    const vx = Math.cos(ang) * projectileSpeed;
                    const vy = Math.sin(ang) * projectileSpeed;
                    const r = 5;
                    const life = 2.0;
                    const color = '#ff9900'; // Orange for New Antioch
                    
                    // Broadcast turret shot (clients will handle bullet spawning and damage)
                    io.to(this.id).emit('defenseTurretShot', {
                        turretId: e.id,
                        angle: ang
                    });
                    
                    // Reset fire timer (fireRate shots per second)
                    e._fireTimer = 1.0 / (e.fireRate || 6);
                }
                
                // Turrets don't move, skip Director processing
                e.speedMul = 0;
            }
            
            // Server-authoritative Artillery Gun behavior update (burst firing like Artillery Witch)
            // Artillery doesn't fire until 9 minutes have elapsed in Trench Raid mode (minus bonus time from RadioTower)
            const ARTILLERY_BARRAGE_DELAY_MS = 9 * 60 * 1000; // 9 minutes in milliseconds
            const effectiveElapsed = this.levelStartTime ? (Date.now() - this.levelStartTime - this.artilleryBonusTimeMs) : 0;
            const artilleryBarrageActive = effectiveElapsed >= ARTILLERY_BARRAGE_DELAY_MS;
            
            for (const e of this.enemies.values()) {
                if (!e || e.type !== 'artilleryGun' || e.alive === false) continue;
                
                // Skip firing if artillery barrage hasn't started yet
                if (!artilleryBarrageActive) continue;
                
                const gun = e;
                const zone = gun.targetZone;
                if (!zone) continue;
                
                // Collect all valid targets (letter zones only: A-F). Never target safe zones.
                // Enemy targets are preferred (support fire), but players/troops can be shelled in letter zones.
                const inLetterZone = (x, y) =>
                    x >= zone.minX && x < zone.maxX && y >= zone.minY && y <= zone.maxY;

                const enemyTargets = [];
                const troopTargets = [];
                const playerTargets = [];

                // Players: can be targeted ONLY in letter zones
                const playersInZone = [];
                for (const [, p] of this.players) {
                    if (!p || p.health <= 0) continue;
                    if (inLetterZone(p.x, p.y)) {
                        playersInZone.push(p);
                        playerTargets.push({ x: p.x, y: p.y, kind: 'player', id: p.id });
                    }
                }

                // Troops: can be targeted ONLY in letter zones
                if (this.troopManager && this.troopManager.troops) {
                    for (const [, t] of this.troopManager.troops) {
                        if (!t || t.alive === false || t.health <= 0) continue;
                        const tx = Number(t.x) || 0;
                        const ty = Number(t.y) || 0;
                        if (inLetterZone(tx, ty)) {
                            troopTargets.push({ x: tx, y: ty, kind: 'troop', id: t.id });
                        }
                    }
                }

                // Enemies: keep current "near players" filter to avoid wasting shells far away
                const enemyProximity = 1500;
                for (const enemy of this.enemies.values()) {
                    if (!enemy || enemy.alive === false) continue;
                    // Skip friendly structures
                    if (enemy.type === 'artilleryGun' || enemy.type === 'defenseTurret') continue;
                    if (!inLetterZone(enemy.x, enemy.y)) continue;

                    // If there are no players in zone, don't bother with proximity logic
                    if (playersInZone.length === 0) continue;

                    let nearPlayer = false;
                    for (const p of playersInZone) {
                        const dist = Math.hypot(enemy.x - p.x, enemy.y - p.y);
                        if (dist <= enemyProximity) { nearPlayer = true; break; }
                    }
                    if (nearPlayer) {
                        enemyTargets.push({ x: enemy.x, y: enemy.y, kind: 'enemy', id: enemy.id });
                    }
                }

                const totalTargets = enemyTargets.length + troopTargets.length + playerTargets.length;
                const pickTarget = () => {
                    // Weighted preference: mostly enemies, sometimes troops, rarely players.
                    const wEnemy = enemyTargets.length > 0 ? 0.70 : 0;
                    const wTroop = troopTargets.length > 0 ? 0.25 : 0;
                    const wPlayer = playerTargets.length > 0 ? 0.05 : 0;
                    const sum = wEnemy + wTroop + wPlayer;
                    if (sum <= 0) return null;

                    let r = Math.random() * sum;
                    let arr;
                    if (r < wEnemy) arr = enemyTargets;
                    else {
                        r -= wEnemy;
                        if (r < wTroop) arr = troopTargets;
                        else arr = playerTargets;
                    }
                    return arr[Math.floor(Math.random() * arr.length)];
                };
                
                // If in a burst, continue firing
                if (gun._burstCount > 0) {
                    gun._shotTimer = (gun._shotTimer || 0) - deltaTime;
                    
                    // Cancel burst if no targets available (prevents getting stuck)
                    if (totalTargets === 0) {
                        gun._burstCount = 0;
                        gun._fireTimer = 0.5;  // Check again soon
                        continue;
                    }
                    
                    if (gun._shotTimer <= 0) {
                        const target = pickTarget();
                        if (!target) {
                            gun._burstCount = 0;
                            gun._fireTimer = 0.5;
                            continue;
                        }
                        
                        // Add randomness around target (like Artillery Witch)
                        const ang = Math.random() * Math.PI * 2;
                        const rad = 100 + Math.random() * 200;  // 100-300 units from target
                        const tx = target.x + Math.cos(ang) * rad;
                        const ty = target.y + Math.sin(ang) * rad;
                        
                        // Schedule the strike
                        this._scheduleArtilleryGunStrike(gun, tx, ty, 0.6, io);
                        
                        // Update barrel angle toward target
                        gun._barrelAngle = Math.atan2(ty - gun.y, tx - gun.x);
                        
                        gun._burstCount--;
                        gun._shotTimer = gun._shotInterval || 0.3;
                    }
                    continue;
                }
                
                // Update burst cooldown timer
                gun._fireTimer = (gun._fireTimer || 0) - deltaTime;
                if (gun._fireTimer > 0) continue;
                
                // No targets? Check again soon
                if (totalTargets === 0) {
                    gun._fireTimer = 0.5;
                    continue;
                }
                
                // Start a new burst!
                gun._burstCount = gun._burstSize || 5;
                gun._shotTimer = 0;  // Fire immediately
                gun._fireTimer = gun._burstCooldown || 2.5;
                
                // console.log(`[ArtilleryGun] ${gun.id} starting burst of ${gun._burstCount} shots`);
            }

            // PHASE 2: Build groups of enemies by nearest player
            const groups = new Map(); // playerId -> wrapper enemy array
            for (const [pid] of this.players) groups.set(pid, []);
            const troopGroupsMelee = new Map(); // troopId -> wrapper enemy array (non-projectile)
            const troopGroupsRanged = new Map(); // troopId -> wrapper enemy array (projectile)
            if (this.troopManager && this.troopManager.troops) {
                for (const [tid, t] of this.troopManager.troops) {
                    if (!t || !t.alive || t.health <= 0) continue;
                    troopGroupsMelee.set(tid, []);
                    troopGroupsRanged.set(tid, []);
                }
            }

            for (const e of this.enemies.values()) {
                if (!e) continue;
                if (e.alive === false) continue;
                
                // Skip stationary entities from Director control (they're stationary)
                if (e.type === 'defenseTurret' || e.type === 'artilleryGun' || e.type === 'targetDummy') continue;
                
                // Handle pre-aggro goal for newly spawned horde enemies
                if (e._preAggroGoal) {
                    const goal = e._preAggroGoal;
                    
                    // Update goal position dynamically if flagged
                    if (goal.dynamic && this.hordeSpawner) {
                        const updatedGoal = this.hordeSpawner.getDynamicGoal();
                        if (updatedGoal) {
                            goal.x = updatedGoal.x;
                            goal.y = updatedGoal.y;
                        }
                    }
                    
                    const dx = goal.x - e.x;
                    const dy = goal.y - e.y;
                    const dist = Math.hypot(dx, dy);
                    
                    if (dist <= (goal.radius || 600)) {
                        // Reached pre-aggro radius, clear goal and let Director take over
                        delete e._preAggroGoal;
                        serverDebugger.debug('ENEMIES', `Enemy ${e.id} reached pre-aggro goal, Director taking over.`);
                    } else {
                        // Move towards pre-aggro goal
                        const speed = (e.speedMul || 1) * 120; // Base speed for pre-aggro
                        const moveX = (dx / dist) * speed * deltaTime;
                        const moveY = (dy / dist) * speed * deltaTime;
                        
                        // Use environment collision resolution
                        if (this.environment && this.environment.resolveCircleMove) {
                            const res = this.environment.resolveCircleMove(e.x, e.y, e.radius || 26, moveX, moveY);
                            e.x = res.x;
                            e.y = res.y;
                        } else {
                            e.x += moveX;
                            e.y += moveY;
                        }
                        
                        // Skip Director update for this enemy in this tick
                        continue;
                    }
                }
                
                // Update projectile zombie tactical behavior
                if (e.type === 'projectile') {
                    e._tacticTimer = (e._tacticTimer || 0) - deltaTime;
                    // Find nearest player for distance check (skip invisible players)
                    let closestP = null, closestD2 = Infinity;
                    for (const [, p] of this.players) {
                        if (!p || p.health <= 0) continue; // Skip dead players
                        if (p.invisible === true || p.dialogueOpen === true) continue; // Skip invisible / dialogue players
                        const dx = (p.x || 0) - (e.x || 0);
                        const dy = (p.y || 0) - (e.y || 0);
                        const d2 = dx*dx + dy*dy;
                        if (d2 < closestD2) { closestD2 = d2; closestP = p; }
                    }
                    if (closestP) {
                        const dist = Math.sqrt(closestD2);
                        // Decide tactic when timer expires or when getting very close
                        if (e._tacticTimer <= 0 || (dist < 250 && e._tacticMode === 'kite')) {
                            // 70% chance to kite (ranged), 30% chance to rush (melee)
                            const roll = Math.random();
                            if (roll < 0.7) {
                                e._tacticMode = 'kite';
                                e.preferContact = false;
                                e.speedMul = 1.0;
                            } else {
                                e._tacticMode = 'rush';
                                e.preferContact = true;
                                e.speedMul = 1.15; // Slightly faster when rushing
                            }
                            // Reset timer for next decision
                            e._tacticDuration = 5 + Math.random() * 5; // 5-10 seconds
                            e._tacticTimer = e._tacticDuration;
                        }

                        // Projectile zombie strafing mode (40% while at shooting distance)
                        if (!e._ai) e._ai = {};
                        const ai = e._ai;
                        ai.strafeTimer = (ai.strafeTimer || 0) - deltaTime;
                        const inRange = dist >= 220 && dist <= 900;
                        if (inRange && ai.strafeTimer <= 0) {
                            ai.strafeActive = Math.random() < 0.4;        // 40% of the time
                            ai.strafeSide = (Math.random() < 0.5) ? 1 : -1; // 1=right, -1=left
                            ai.strafeRadius = 120 + Math.random() * 80;    // 120..200
                            ai.strafeTimer = 1.2 + Math.random() * 3.8;    // 1.2..5.0s (upper bound increased)
                        }
                        if (!inRange) ai.strafeActive = false;
                        ai.forceOrbit = !!ai.strafeActive; // Hint for Director
                        if (ai.forceOrbit) e.preferContact = false; // ensure ranged behavior while strafing
                    }
                }
                
                // BigBoy dash attack logic
                if (e.type === 'bigboy' && e.alive) {
                    // Ensure dash properties are initialized
                    if (!e.dashRange) {
                        console.log(`[BigBoy] WARNING: ${e.id} missing dashRange, reinitializing...`);
                        e.dashRange = 400;
                        e.dashDistance = 300;
                        e.dashDuration = 0.3;
                        e.dashWindupDuration = 0.8;
                        e.dashCooldown = 0;
                        e.dashWindup = 0;
                        e.isDashing = false;
                        e._dashHitPlayers = null; // Clear hit tracking
                    }
                    
                    // Update dash cooldown
                    if (e.dashCooldown > 0) {
                        e.dashCooldown -= deltaTime;
                    }
                    
                    // Update dash windup
                    if (e.dashWindup > 0) {
                        e.dashWindup -= deltaTime;
                        if (e.dashWindup <= 0) {
                            // Execute dash
                            console.log(`[BigBoy] ${e.id} executing dash!`);
                            this._executeBigBoyDash(e);
                        }
                    }
                    
                    // Check for dash opportunity
                    if (e.dashCooldown <= 0 && e.dashWindup <= 0 && !e.isDashing) {
                        const closestPlayer = this._findClosestPlayer(e.x, e.y);
                        if (closestPlayer) {
                            const dx = closestPlayer.x - e.x;
                            const dy = closestPlayer.y - e.y;
                            const dist = Math.hypot(dx, dy);
                            
                            // Start dash if within range
                            if (dist <= e.dashRange && dist > 100) { // Don't dash if too close
                                console.log(`[BigBoy] ${e.id} starting dash windup! Distance: ${dist.toFixed(1)}`);
                                e.dashTarget = closestPlayer;
                                e.dashWindup = e.dashWindupDuration;
                                e.dashCooldown = 4 + Math.random() * 3; // 4-7 second cooldown
                                
                                // Broadcast dash windup to clients
                                this._broadcastEnemyDashWindup(e.id, closestPlayer.id);
                            }
                        }
                    }
                    
                    // Check for collisions DURING dash (apply knockback when BigBoy touches players)
                    if (e.isDashing && e.kbTime > 0) {
                        const hitRadius = e.radius + 50; // BigBoy radius (80) + buffer (50) = 130
                        
                        for (const [, p] of this.players) {
                            if (!p || p.health <= 0) continue;
                            if (p.invisible === true || p.dialogueOpen === true) continue;
                            
                            // Skip if already hit by this dash
                            if (e._dashHitPlayers && e._dashHitPlayers.has(p.id)) continue;
                            
                            const pdx = p.x - e.x;
                            const pdy = p.y - e.y;
                            const pdist = Math.hypot(pdx, pdy);
                            
                            // Check if BigBoy is touching the player
                            if (pdist <= hitRadius) {
                                // Mark player as hit by this dash
                                if (!e._dashHitPlayers) e._dashHitPlayers = new Set();
                                e._dashHitPlayers.add(p.id);
                                
                                // Calculate knockback direction (away from BigBoy)
                                const pux = pdx / Math.max(pdist, 1);
                                const puy = pdy / Math.max(pdist, 1);
                                
                                // Apply knockback
                                const knockbackVel = 500; // Strong knockback
                                p.kbVelX = pux * knockbackVel;
                                p.kbVelY = puy * knockbackVel;
                                p.kbTime = 0.4;
                                
                                // Apply damage (reduced by half) - respect invincibility
                                if (p.invincible !== true) {
                                    const dashDamage = 17.5 + Math.random() * 7.5; // 17.5-25 damage (was 35-50)
                                    p.health = Math.max(0, p.health - dashDamage);
                                    console.log(`[BigBoy] ${e.id} COLLISION with player ${p.id}! Damage: ${dashDamage.toFixed(1)}, Knockback: ${knockbackVel}, Distance: ${pdist.toFixed(1)}`);
                                } else {
                                    console.log(`[BigBoy] ${e.id} COLLISION with player ${p.id} (INVINCIBLE)! Knockback: ${knockbackVel}, Distance: ${pdist.toFixed(1)}`);
                                }
                            }
                        }
                        
                        // Also check collisions with troopers during dash
                        if (this.troopManager && this.troopManager.troops) {
                            for (const [, troop] of this.troopManager.troops) {
                                if (!troop || !troop.alive || troop.health <= 0) continue;
                                
                                // Skip if already hit by this dash
                                if (!e._dashHitTroops) e._dashHitTroops = new Set();
                                if (e._dashHitTroops.has(troop.id)) continue;
                                
                                const tdx = troop.x - e.x;
                                const tdy = troop.y - e.y;
                                const tdist = Math.hypot(tdx, tdy);
                                
                                // Check if BigBoy is touching the troop
                                if (tdist <= hitRadius) {
                                    // Mark troop as hit by this dash
                                    e._dashHitTroops.add(troop.id);
                                    
                                    // Apply damage (same as player damage: 17.5-25)
                                    const dashDamage = 17.5 + Math.random() * 7.5;
                                    troop.health = Math.max(0, troop.health - dashDamage);
                                    
                                    console.log(`[BigBoy] ${e.id} COLLISION with troop ${troop.id}! Damage: ${dashDamage.toFixed(1)}, Distance: ${tdist.toFixed(1)}`);
                                    
                                    // Broadcast troop damage for visual feedback
                                    io.to(this.id).emit('troopDamaged', {
                                        troopId: troop.id,
                                        // Send already-rounded integer damage for UI text (avoid "-0")
                                        damage: Math.max(1, Math.round(dashDamage)),
                                        health: troop.health,
                                        healthMax: troop.healthMax,
                                        x: troop.x,
                                        y: troop.y
                                    });
                                    
                                    // Check if troop died
                                    if (troop.health <= 0) {
                                        troop.alive = false;
                                        console.log(`[BigBoy] Troop ${troop.id} killed by BigBoy dash attack`);
                                        io.to(this.id).emit('troopDeath', {
                                            troopId: troop.id,
                                            x: troop.x,
                                            y: troop.y
                                        });
                                        io.to(this.id).emit('entity_dead', {
                                            entityType: 'troop',
                                            id: troop.id,
                                            x: troop.x,
                                            y: troop.y,
                                            kind: troop.type || 'troop'
                                        });
                                    }
                                }
                            }
                        }
                    }
                }
                
                // WallGuy: slow rotation and melee cone attack (like Weapon1 primary level 2)
                if (e.type === 'wallguy' && e.alive) {
                    // Find target (closest player or troop)
                    let targetEntity = null;
                    let closestDist = Infinity;
                    
                    // Check players
                    for (const [, p] of this.players) {
                        if (!p || p.health <= 0) continue;
                        if (p.invisible === true || p.dialogueOpen === true) continue;
                        const dx = (p.x || 0) - (e.x || 0);
                        const dy = (p.y || 0) - (e.y || 0);
                        const dist = Math.hypot(dx, dy);
                        if (dist < closestDist) {
                            closestDist = dist;
                            targetEntity = p;
                        }
                    }
                    
                    // Also check troops (if no player is very close, consider troops)
                    if (this.troopManager && this.troopManager.troops) {
                        for (const [, troop] of this.troopManager.troops) {
                            if (!troop || !troop.alive || troop.health <= 0) continue;
                            const dx = (troop.x || 0) - (e.x || 0);
                            const dy = (troop.y || 0) - (e.y || 0);
                            const dist = Math.hypot(dx, dy);
                            // Troops have lower priority - only target if closer than player
                            if (dist < closestDist) {
                                closestDist = dist;
                                targetEntity = troop;
                            }
                        }
                    }
                    
                    if (targetEntity) {
                        // Calculate desired facing angle (towards target)
                        const dx = targetEntity.x - e.x;
                        const dy = targetEntity.y - e.y;
                        const targetAngle = Math.atan2(dy, dx);
                        
                        // Slowly rotate towards target
                        if (e.shieldAngle === undefined) e.shieldAngle = 0;
                        let angleDiff = targetAngle - e.shieldAngle;
                        // Normalize to [-PI, PI]
                        while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
                        while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
                        
                        const maxRotation = (e.rotationSpeed || Math.PI / 3) * deltaTime;
                        if (Math.abs(angleDiff) <= maxRotation) {
                            e.shieldAngle = targetAngle;
                        } else {
                            e.shieldAngle += Math.sign(angleDiff) * maxRotation;
                        }
                        
                        // Update shield collision box in environment (blocks troops and players)
                        const shieldDepth = 20;
                        const shieldWidth = 80;
                        const shieldDist = (e.radius || 28) + shieldDepth/2 + 5;
                        const shieldX = e.x + Math.cos(e.shieldAngle) * shieldDist;
                        const shieldY = e.y + Math.sin(e.shieldAngle) * shieldDist;
                        
                        // Find or create collision box for this WallGuy's shield
                        if (!e._shieldCollisionIndex && e._shieldCollisionIndex !== 0) {
                            // First time - add new oriented box to environment
                            if (this.environment && this.environment.orientedBoxes) {
                                e._shieldCollisionIndex = this.environment.orientedBoxes.length;
                                this.environment.orientedBoxes.push({
                                    x: shieldX,
                                    y: shieldY,
                                    w: shieldDepth,
                                    h: shieldWidth,
                                    angle: e.shieldAngle,
                                    _wallguyId: e.id // Track which WallGuy owns this
                                });
                            }
                        } else {
                            // Update existing collision box
                            if (this.environment && this.environment.orientedBoxes && this.environment.orientedBoxes[e._shieldCollisionIndex]) {
                                const box = this.environment.orientedBoxes[e._shieldCollisionIndex];
                                box.x = shieldX;
                                box.y = shieldY;
                                box.angle = e.shieldAngle;
                            }
                        }
                        
                        // Attack cooldown
                        e._attackCooldown = (e._attackCooldown || 0) - deltaTime;
                        
                        // Melee cone attack (like Weapon1 level 2)
                        if (e._attackCooldown <= 0 && closestDist <= (e._attackRange || 150)) {
                            e._attackCooldown = e._attackInterval || 2.5;
                            
                            // Broadcast cone attack to all clients (visual + damage)
                            const attackAngle = e.shieldAngle;
                            const coneRange = 120; // Melee range
                            const coneHalf = 0.6; // ~Ã‚Â±34 degrees
                            const damage = 20;
                            
                            io.to(this.id).emit('enemyMeleeAttack', {
                                enemyId: e.id,
                                x: e.x,
                                y: e.y,
                                angle: attackAngle,
                                coneRange,
                                coneHalf,
                                damage,
                                color: '#8B0000' // Dark red
                            });
                            
                            // Server-side damage application to players in cone
                            for (const [, p] of this.players) {
                                if (!p || p.health <= 0) continue;
                                const dx = p.x - e.x;
                                const dy = p.y - e.y;
                                const distSq = dx * dx + dy * dy;
                                const playerRadius = p.radius || 26;
                                const effectiveRange = coneRange + playerRadius; // Add player radius to match client VFX
                                const rangeSq = effectiveRange * effectiveRange;
                                
                                if (distSq <= rangeSq) {
                                    let dAng = Math.atan2(dy, dx) - attackAngle;
                                    while (dAng > Math.PI) dAng -= Math.PI * 2;
                                    while (dAng < -Math.PI) dAng += Math.PI * 2;
                                    
                                    if (Math.abs(dAng) <= coneHalf) {
                                        // Player is in cone - apply damage (respect invincibility)
                                        if (p.invincible !== true) {
                                            p.health = Math.max(0, p.health - damage);
                                            console.log(`[WallGuy] ${e.id} hit player ${p.id} for ${damage} damage`);
                                        }
                                    }
                                }
                            }
                            
                            // Server-side damage application to troops in cone
                            if (this.troopManager && this.troopManager.troops) {
                                for (const [, troop] of this.troopManager.troops) {
                                    if (!troop || !troop.alive || troop.health <= 0) continue;
                                    
                                    // CRITICAL FIX: Don't let WallGuy damage itself
                                    // Check if this "troop" is actually the attacking enemy
                                    if (troop.id === e.id) {
                                        console.warn(`[WallGuy] Skipping self-damage: troop.id ${troop.id} === enemy.id ${e.id}`);
                                        continue;
                                    }
                                    
                                    // Also skip if this looks like an enemy ID (shouldn't happen, but defensive check)
                                    if (typeof troop.id === 'string' && (troop.id.startsWith('enemy_') || troop.id.includes('defenseTurret') || troop.id.includes('artillery'))) {
                                        console.warn(`[WallGuy] Skipping enemy in troop loop: ${troop.id}`);
                                        continue;
                                    }
                                    
                                    const dx = troop.x - e.x;
                                    const dy = troop.y - e.y;
                                    const distSq = dx * dx + dy * dy;
                                    const troopRadius = troop.radius || 22;
                                    const effectiveRange = coneRange + troopRadius;
                                    const rangeSq = effectiveRange * effectiveRange;
                                    
                                    if (distSq <= rangeSq) {
                                        let dAng = Math.atan2(dy, dx) - attackAngle;
                                        while (dAng > Math.PI) dAng -= Math.PI * 2;
                                        while (dAng < -Math.PI) dAng += Math.PI * 2;
                                        
                                        if (Math.abs(dAng) <= coneHalf) {
                                            // Troop is in cone - apply damage
                                            troop.health = Math.max(0, troop.health - damage);
                                            console.log(`[WallGuy] ${e.id} hit troop ${troop.id} for ${damage} damage`);
                                            
                                            // Broadcast troop damage for visual feedback (damage numbers, health bars)
                                            io.to(this.id).emit('troopDamaged', {
                                                troopId: troop.id,
                                                // Send already-rounded integer damage for UI text (avoid "-0")
                                                damage: Math.max(1, Math.round(damage)),
                                                health: troop.health,
                                                healthMax: troop.healthMax,
                                                x: troop.x,
                                                y: troop.y
                                            });
                                            
                                            // Check if troop died
                                            if (troop.health <= 0) {
                                                troop.alive = false;
                                                io.to(this.id).emit('troopDeath', {
                                                    troopId: troop.id,
                                                    x: troop.x,
                                                    y: troop.y
                                                });
                                                io.to(this.id).emit('entity_dead', {
                                                    entityType: 'troop',
                                                    id: troop.id,
                                                    x: troop.x,
                                                    y: troop.y,
                                                    kind: troop.type || 'troop'
                                                });
                                            }
                                        }
                                    }
                                }
                            }
                            // Also damage sandbags and barrels in the cone area (approximate with circle)
                            try {
                                if (this.hazards) {
                                    this.hazards.damageCircle(e.x, e.y, coneRange, damage);
                                    if (typeof this.hazards.damageBarrelInRadius === 'function') {
                                        this.hazards.damageBarrelInRadius(e.x, e.y, coneRange, damage);
                                    }
                                }
                            } catch(_) {}
                        }
                    }
                }
                
                // Cleanup: Remove shield collision boxes from dead WallGuys
                if (this.environment && this.environment.orientedBoxes) {
                    for (let i = this.environment.orientedBoxes.length - 1; i >= 0; i--) {
                        const box = this.environment.orientedBoxes[i];
                        if (box._wallguyId) {
                            const wallguy = this.enemies.get(box._wallguyId);
                            // Remove box if WallGuy is dead or doesn't exist
                            if (!wallguy || !wallguy.alive) {
                                this.environment.orientedBoxes.splice(i, 1);
                                // Also clear the index reference if the enemy still exists
                                if (wallguy) delete wallguy._shieldCollisionIndex;
                            }
                        }
                    }
                }
                
                // Basic zombie dash logic for player targeting
                if (e.type === 'basic') {
                    // Initialize dash state for basic zombies
                    if (e._dashDecisionTimerPlayer === undefined) {
                        e._dashDecisionTimerPlayer = 0;
                        e._isDashingAtPlayer = false;
                        e._dashDuration = 0;
                    }
                    
                    // Decrement timers
                    e._dashDecisionTimerPlayer -= deltaTime;
                    if (e._dashDuration > 0) {
                        e._dashDuration -= deltaTime;
                        if (e._dashDuration <= 0) {
                            e._isDashingAtPlayer = false;
                        }
                    }
                    
                    // Make dash decision every 3-5 seconds
                    if (e._dashDecisionTimerPlayer <= 0) {
                        // Find nearest player to check distance
                        let nearestPlayer = null;
                        let nearestDist = Infinity;
                        for (const [, p] of this.players) {
                            if (!p || p.health <= 0) continue;
                            if (p.invisible === true || p.dialogueOpen === true) continue;
                            const dx = (p.x || 0) - (e.x || 0);
                            const dy = (p.y || 0) - (e.y || 0);
                            const dist = Math.hypot(dx, dy);
                            if (dist < nearestDist) {
                                nearestDist = dist;
                                nearestPlayer = p;
                            }
                        }
                        
                        // Only allow dash if player is within effective range (260-780 units)
                        // Too close (<260): already in melee range, no need to dash
                        // Too far (>780): dash will expire before reaching player
                        // Dash speed: 275 units/sec, duration: 2.25-3.75s = 618-1031 units covered
                        const minDashRange = 260;
                        const maxDashRange = 780;
                        const inDashRange = nearestPlayer && nearestDist >= minDashRange && nearestDist <= maxDashRange;
                        
                        // 40% chance to dash at player (only if in range)
                        if (inDashRange && Math.random() < 0.40) {
                            e._isDashingAtPlayer = true;
                            e._dashDuration = 2.25 + Math.random() * 1.5; // Dash lasts 2.25-3.75 seconds (50% longer)
                        }
                        e._dashDecisionTimerPlayer = 3 + Math.random() * 2; // Reset to 3-5 seconds
                    }
                    
                    // Apply dash speed multiplier (2.5x for dramatic dash, similar to player sprint relative to their base)
                    // Normal zombie with Director baseSpeed 110 * speedMul 1.0 = 110 units/sec
                    // Dashing zombie: 110 * 2.5 = 275 units/sec (faster than walking player, slower than sprinting player)
                    if (e._isDashingAtPlayer && e._dashDuration > 0) {
                        e.speedMul = 2.5;
                    } else {
                        // Reset to normal speed when not dashing
                        if (!Number.isFinite(e.speedMul) || e.speedMul === 2.5) {
                            e.speedMul = 1.0;
                        }
                    }
                }
                
                // Stable numeric id for Director logic (ring/jitter depend on numeric id semantics)
                let numId = this._enemyIdMap.get(e.id);
                if (!numId) { numId = this._enemyIdCounter++; this._enemyIdMap.set(e.id, numId); }

                // Wrap enemy into a lightweight object used by Director
                const wrapped = {
                    id: numId,
                    x: Number.isFinite(e.x) ? e.x : 0,
                    y: Number.isFinite(e.y) ? e.y : 0,
                    radius: Number.isFinite(e.radius) ? e.radius : 26,
                    alive: e.alive !== false,
                    // If enemy is navmesh-driven this tick, prevent Director from applying additional movement.
                    speedMul: (e._navUsingPath || (e._navPath && e._navPath.length > 0))
                        ? 0
                        : (Number.isFinite(e.speedMul) ? e.speedMul : 1),
                    preferContact: e.preferContact !== false,
                    kbTime: Number.isFinite(e.kbTime) ? e.kbTime : 0,
                    kbVelX: Number.isFinite(e.kbVelX) ? e.kbVelX : 0,
                    kbVelY: Number.isFinite(e.kbVelY) ? e.kbVelY : 0,
                    _ref: e,
                    _ai: e._ai  // Pass AI state to Director for strafing behavior
                };
                // Find nearest target (player, turret, or attractor)
                // Priority: Attractors > Turrets > Players (for non-boss enemies)
                let closestTarget = null;
                let closestTargetType = 'player';
                let bestD2 = Infinity;
                
                // Check attractors first (ALL enemies including Lickers and Bosses)
                for (const [, ability] of this.abilities) {
                    if (ability.type !== 'EnemyAttractor') continue;
                    if (ability.health <= 0) continue;
                    
                    const dx = (ability.x || 0) - (wrapped.x || 0);
                    const dy = (ability.y || 0) - (wrapped.y || 0);
                    const d2 = dx*dx + dy*dy;
                    const dist = Math.sqrt(d2);
                    
                    // Only consider attractors within their attraction radius
                    if (dist <= (ability.attractionRadius || 200)) {
                        if (d2 < bestD2) {
                            bestD2 = d2;
                            closestTarget = ability;
                            closestTargetType = 'attractor';
                        }
                    }
                }
                
                // Check gold chests (all enemies except Lickers)
                // 30% chance to target chest if available (70% chance they'll prefer player/turret)
                let chestCandidate = null;
                let chestCandidateDist2 = Infinity;
                if (e.type !== 'licker') {
                    for (const [, chest] of this.chests) {
                        if (chest.variant !== 'gold' || chest.opened || chest.health <= 0) continue;
                        
                        // Check if chest is vulnerable (only during waves or once activated)
                        if (this.currentGameMode?.isChestVulnerable && !this.currentGameMode.isChestVulnerable(chest)) continue;
                        
                        const dx = (chest.x || 0) - (wrapped.x || 0);
                        const dy = (chest.y || 0) - (wrapped.y || 0);
                        const d2 = dx*dx + dy*dy;
                        
                        // Only consider chests within 600 units
                        if (d2 < chestCandidateDist2 && d2 < 600*600) {
                            chestCandidateDist2 = d2;
                            chestCandidate = chest;
                        }
                    }
                    
                    // Initialize decision timer if not set (prevents wobbling between targets)
                    if (e._targetDecisionTimer === undefined) {
                        e._targetDecisionTimer = 0;
                        e._lastTargetDecision = Math.random() < 0.075 ? 'objective' : 'player';
                    }
                    
                    // Decrement timer
                    e._targetDecisionTimer -= deltaTime;
                    
                    // Only make new decision if timer expired (every 3-7 seconds)
                    if (e._targetDecisionTimer <= 0) {
                        e._lastTargetDecision = Math.random() < 0.075 ? 'objective' : 'player';
                        e._targetDecisionTimer = 3 + Math.random() * 4; // Reset to 3-7 seconds
                    }
                    
                    // Apply stored decision for chest
                    if (chestCandidate && e._lastTargetDecision === 'objective') {
                        if (chestCandidateDist2 < bestD2) {
                            bestD2 = chestCandidateDist2;
                            closestTarget = chestCandidate;
                            closestTargetType = 'chest';
                        }
                    }
                }
                
                // Check artifacts on ground (all enemies except Lickers)
                // Uses same decision timer as chest (objective vs player choice)
                let artifactCandidate = null;
                let artifactCandidateDist2 = Infinity;
                let artifactCandidatePos = null;
                if (e.type !== 'licker') {
                    for (const [, chest] of this.chests) {
                        if (chest.variant !== 'gold' || !chest.opened || chest.artifactCarriedBy || chest.health <= 0) continue;
                        
                        // Check if artifact is vulnerable (only during waves or once chest opened)
                        if (this.currentGameMode?.isChestVulnerable && !this.currentGameMode.isChestVulnerable(chest)) continue;
                        
                        const artX = (chest.artifactPos && Number(chest.artifactPos.x)) || Number(chest.x) || 0;
                        const artY = (chest.artifactPos && Number(chest.artifactPos.y)) || Number(chest.y) || 0;
                        const dx = artX - (wrapped.x || 0);
                        const dy = artY - (wrapped.y || 0);
                        const d2 = dx*dx + dy*dy;
                        
                        // Only consider artifacts within 600 units
                        if (d2 < artifactCandidateDist2 && d2 < 600*600) {
                            artifactCandidateDist2 = d2;
                            artifactCandidate = chest;
                            artifactCandidatePos = { x: artX, y: artY };
                        }
                    }
                    
                    // Apply stored decision for artifact (uses same timer as chest)
                    if (artifactCandidate && artifactCandidatePos && e._lastTargetDecision === 'objective') {
                        if (artifactCandidateDist2 < bestD2) {
                            bestD2 = artifactCandidateDist2;
                            closestTarget = { x: artifactCandidatePos.x, y: artifactCandidatePos.y, radius: 10, _chestRef: artifactCandidate };
                            closestTargetType = 'artifact';
                        }
                    }
                }
                
                // Check turrets next (all enemies except Lickers)
                // Uses same decision timer as chests/artifacts (7.5% chance to target objectives, reduced from 30%)
                let turretCandidate = null;
                let turretCandidateDist2 = Infinity;
                if (e.type !== 'licker') {
                    // Find nearest turret (simplified - all enemies use same targeting logic now)
                    for (const [, ability] of this.abilities) {
                        if (ability.type !== 'AutoTurret') continue;
                        if (ability.health <= 0) continue;
                        
                        const dx = (ability.x || 0) - (wrapped.x || 0);
                        const dy = (ability.y || 0) - (wrapped.y || 0);
                        const d2 = dx*dx + dy*dy;
                        
                        // Only consider turrets within 400 units
                        if (d2 < turretCandidateDist2 && d2 < 400*400) {
                            turretCandidateDist2 = d2;
                            turretCandidate = ability;
                        }
                    }
                    
                    // Apply stored decision for turret (uses same timer as chest/artifact)
                    // Only target turret if we're in 'objective' mode (7.5% chance, reduced from 30%)
                    if (turretCandidate && e._lastTargetDecision === 'objective') {
                        if (turretCandidateDist2 < bestD2) {
                            bestD2 = turretCandidateDist2;
                            closestTarget = turretCandidate;
                            closestTargetType = 'turret';
                        }
                    }
                }
                
                // Check players (only target living, non-invisible players)
                for (const [, p] of this.players) {
                    if (!p || p.health <= 0) continue; // Skip dead players
                    if (p.invisible === true || p.dialogueOpen === true) continue; // Skip invisible / dialogue players
                    const dx = (p.x || 0) - (wrapped.x || 0);
                    const dy = (p.y || 0) - (wrapped.y || 0);
                    const d2 = dx*dx + dy*dy;
                    if (d2 < bestD2) { 
                        bestD2 = d2; 
                        closestTarget = p; 
                        closestTargetType = 'player';
                    }
                }
                
                // Check troops (allied units) as fallback targets
                // Troops are lower priority than players (enemies prefer players)
                // But troops can be targeted if no players nearby or if troop is much closer
                if (this.troopManager && this.troopManager.troops) {
                    for (const [, troop] of this.troopManager.troops) {
                        if (!troop || !troop.alive) continue;
                        if (troop.health <= 0) continue;
                        
                        const dx = (troop.x || 0) - (wrapped.x || 0);
                        const dy = (troop.y || 0) - (wrapped.y || 0);
                        const d2 = dx*dx + dy*dy;
                        
                        // Troops are secondary targets:
                        // - If no player target yet, use troop
                        // - If troop is MUCH closer than player (3x closer), switch to troop
                        const troopPriority = (closestTargetType !== 'player') ? 1.0 : 3.0;
                        if (d2 * troopPriority < bestD2) {
                            bestD2 = d2;
                            closestTarget = troop;
                            closestTargetType = 'troop';
                        }
                    }
                }
                
                if (!closestTarget) {
                    // No valid target - enter wandering/patrol mode
                    
                    // Initialize wander state if not exists
                    if (!e._wanderTarget || !e._wanderReachedTarget) {
                        e._wanderTarget = null;
                        e._wanderReachedTarget = true;
                    }
                    
                    // Pick new wander target when reached (and pause ended) or not set
                    if ((e._wanderReachedTarget && e._wanderPauseTimer <= 0) || !e._wanderTarget) {
                        const wanderDist = 300 + Math.random() * 500; // 300-800 units away
                        const wanderAngle = Math.random() * Math.PI * 2;
                        e._wanderTarget = {
                            x: e.x + Math.cos(wanderAngle) * wanderDist,
                            y: e.y + Math.sin(wanderAngle) * wanderDist
                        };
                        e._wanderReachedTarget = false;
                        e._wanderPauseTimer = 0;
                    }
                    
                    // Calculate director-compatible target for wandering
                    const dx = e._wanderTarget.x - e.x;
                    const dy = e._wanderTarget.y - e.y;
                    const distToWander = Math.hypot(dx, dy);
                    
                    // Check if reached wander target (larger threshold)
                    if (distToWander < 60) {
                        // Pause briefly before picking next waypoint
                        if (!e._wanderReachedTarget) {
                            // Just reached target, initialize pause
                            e._wanderReachedTarget = true;
                            e._wanderPauseTimer = 1.0 + Math.random() * 2.0; // 1-3 second pause
                        }
                        
                        // Decrement pause timer
                        e._wanderPauseTimer -= deltaTime;
                        
                        if (e._wanderPauseTimer > 0) {
                            continue; // Stay paused
                        } else {
                            // Pause ended, ready to pick new target next iteration
                            // Don't reset _wanderReachedTarget here - let the pick logic handle it
                        }
                    } else {
                        // Moving toward target
                        e._wanderPauseTimer = 0;
                    }
                    
                    // Create fake target for Director to process
                    closestTarget = {
                        x: e._wanderTarget.x,
                        y: e._wanderTarget.y,
                        radius: 0
                    };
                    closestTargetType = 'wander';
                    
                    // Normal speed wandering - no speed reduction
                    if (!Number.isFinite(e.speedMul)) e.speedMul = 1.0;
                    
                    // Keep their tactical modes if applicable
                    if (e.type === 'projectile') {
                        e.preferContact = false; // Don't rush while wandering
                    }
                    
                    // Don't do special behaviors while wandering - fall through to movement
                } else {
                    // Clear wander state when target found
                    e._wanderTarget = null;
                    e._wanderReachedTarget = true;
                    e._wanderPauseTimer = 0;
                }
                
                // If targeting a turret, override enemy movement to go directly to turret
                if (closestTargetType === 'turret') {
                    // Special handling for Boomers targeting turrets
                    if (e.type === 'boomer' && e.alive !== false) {
                        const dx = closestTarget.x - e.x;
                        const dy = closestTarget.y - e.y;
                        const dist = Math.sqrt(dx*dx + dy*dy);
                        
                        // Check if within arm distance
                        const armDist = Math.max(40, (closestTarget.radius || 25) + (e.radius || 26) + 18);
                        if (dist < armDist && !e._armedTimerStarted) {
                            e._armedTimerStarted = true;
                            e._armedTimer = 0.8; // slightly longer fuse for turrets
                        }
                        
                        // Set warning state
                        const trigger = 220;
                        e._warningActive = dist < trigger;
                        e._closestPlayerDist = dist;
                        
                        // Countdown and explode
                        if (e._armedTimerStarted && typeof e._armedTimer === 'number' && e._armedTimer > 0) {
                            e._armedTimer -= deltaTime;
                            if (e._armedTimer <= 0) {
                                // Detonate
                                e._armedTimer = 0;
                                io.to(this.id).emit('boomerExploded', { id: e.id, x: e.x, y: e.y });
                                try { this.boomerPools.push({ x: e.x, y: e.y, radius: 100, ttl: 8.0 }); } catch(_) {}
                                
                                const blastRadius = 100;
                                const inner = 20;
                                
                                // Damage players
                                for (const [, p] of this.players) {
                                    if (!p) continue;
                                    const dxp = (p.x || 0) - e.x;
                                    const dyp = (p.y || 0) - e.y;
                                    const dp = Math.hypot(dxp, dyp);
                                    if (dp <= blastRadius + (p.radius || 0)) {
                                        if (p.invincible === true) continue;
                                        const healthBefore = p.health;
                                        const outer = blastRadius;
                                        let tp = (dp - inner) / Math.max(1e-6, (outer - inner));
                                        tp = Math.max(0, Math.min(1, tp));
                                        const rawDmg = 45 - 25 * tp;
                                        const armorPercent = Number.isFinite(p.armor) ? p.armor : 0;
                                        const reduction = Math.min(0.75, armorPercent / 100);
                                        const dmg = rawDmg * (1 - reduction);
                                        p.health = Math.max(0, (p.health || 0) - dmg);
                                        try { p.socket.emit('playerHealth', { health: p.health, from: 'boomer' }); } catch(_) {}
                                        io.to(this.id).emit('playerHealthUpdate', { playerId: p.id, health: p.health });
                                        
                                        // Check for death
                                        if (p.health <= 0 && healthBefore > 0) {
                                            this._handlePlayerDeath(p.id, p, io);
                                        }
                                    }
                                }
                                
                                // Damage turrets
                                for (const [abilityId, ability] of this.abilities) {
                                    if (ability.type !== 'AutoTurret') continue;
                                    if (ability.health <= 0) continue;
                                    const dxt = (ability.x || 0) - e.x;
                                    const dyt = (ability.y || 0) - e.y;
                                    const dt = Math.hypot(dxt, dyt);
                                    if (dt <= blastRadius + (ability.radius || 25)) {
                                        const outer = blastRadius;
                                        let tt = (dt - inner) / Math.max(1e-6, (outer - inner));
                                        tt = Math.max(0, Math.min(1, tt));
                                        const dmg = 45 - 25 * tt;
                                        ability.health = Math.max(0, ability.health - dmg);
                                        io.to(this.id).emit('abilityHealthUpdate', {
                                            serverId: abilityId,
                                            health: ability.health,
                                            healthMax: ability.healthMax
                                        });
                                        if (ability.health <= 0) {
                                            io.to(this.id).emit('abilityTriggered', {
                                                serverId: abilityId,
                                                type: 'AutoTurret',
                                                event: 'death'
                                            });
                                            this.abilities.delete(abilityId);
                                        }
                                    }
                                }
                                
                                // Kill boomer
                                e.alive = false;
                                this.enemies.delete(e.id);
                                continue;
                            }
                        }
                    }
                    
                    // Move directly toward turret (bypass Director)
                    const dx = closestTarget.x - e.x;
                    const dy = closestTarget.y - e.y;
                    const dist = Math.sqrt(dx*dx + dy*dy);
                    
                    // Calculate desired distance (breathing room like Director does for players)
                    const turretRadius = closestTarget.radius || 25;
                    const enemyRadius = e.radius || 26;
                    const desiredDist = 35; // Fixed 35 units spacing
                    
                    // Apply contact damage to turret if enemy is close enough
                    const sumR = enemyRadius + turretRadius;
                    if (dist <= sumR) {
                        const contactDamage = 10 * deltaTime; // Same rate as to players
                        closestTarget.health = Math.max(0, closestTarget.health - contactDamage);
                        
                        // Track if we need to broadcast health update
                        if (!closestTarget._damageThisFrame) {
                            closestTarget._damageThisFrame = contactDamage;
                        } else {
                            closestTarget._damageThisFrame += contactDamage;
                        }
                    }
                    // Only move if we're farther than desired distance
                    if (dist > desiredDist + 1) {
                        const baseSpeed = 110; // Match Director speed
                        const speed = baseSpeed * (e.speedMul || 1) * deltaTime;
                        const moveX = (dx / dist) * speed;
                        const moveY = (dy / dist) * speed;
                        
                        // Simple collision avoidance with environment
                        const newX = e.x + moveX;
                        const newY = e.y + moveY;
                        if (this.environment && this.environment.isInsideBounds && this.environment.circleHitsAny) {
                            if (this.environment.isInsideBounds(newX, newY, e.radius) && 
                                !this.environment.circleHitsAny(newX, newY, e.radius)) {
                                e.x = newX;
                                e.y = newY;
                            }
                        } else {
                            e.x = newX;
                            e.y = newY;
                        }
                    }
                    // Don't add to Director groups - we're handling movement manually
                    continue;
                } else if (closestTargetType === 'chest' || (e.type === 'boomer' && e._armedTimerStarted && e._armedTimer > 0 && e._armedTargetType === 'chest')) {
                    // Validate chest target is still alive (but keep target if boomer is armed and exploding)
                    const boomerIsArmed = e.type === 'boomer' && e._armedTimerStarted && e._armedTimer > 0;
                    if (!boomerIsArmed && (!closestTarget || closestTarget.health <= 0 || closestTarget.opened)) {
                        // Target destroyed/opened, switch to nearest player
                        closestTarget = null;
                        for (const [, p] of this.players) {
                            if (!p || p.health <= 0) continue;
                            const dx = (p.x || 0) - e.x;
                            const dy = (p.y || 0) - e.y;
                            const d2 = dx*dx + dy*dy;
                            if (!closestTarget || d2 < bestD2) {
                                bestD2 = d2;
                                closestTarget = p;
                                closestTargetType = 'player';
                            }
                        }
                        if (!closestTarget) continue; // No valid target, skip this enemy
                    }
                    
                    // Special handling for Boomers targeting chests (process armed boomers first)
                    if (e.type === 'boomer' && e.alive !== false) {
                        // Debug: Log boomer state
                        if (!e._lastStateLog || Date.now() - e._lastStateLog >= 500) {
                            console.log(`[Server] Boomer ${e.id} state: targetType=${closestTargetType}, armed=${e._armedTimerStarted}, armedType=${e._armedTargetType}`);
                            e._lastStateLog = Date.now();
                        }
                    }
                    if (e.type === 'boomer' && e.alive !== false && (closestTargetType === 'chest' || (e._armedTimerStarted && e._armedTargetType === 'chest'))) {
                        const dx = closestTarget ? closestTarget.x - e.x : (e._armedTargetX || 0) - e.x;
                        const dy = closestTarget ? closestTarget.y - e.y : (e._armedTargetY || 0) - e.y;
                        const dist = Math.sqrt(dx*dx + dy*dy);
                        
                        // Check if within arm distance (only arm if not already armed)
                        if (!e._armedTimerStarted && closestTarget) {
                            const armDist = Math.max(40, (closestTarget.radius || 20) + (e.radius || 26) + 18);
                            console.log(`[Server] Boomer ${e.id} checking arm distance: dist=${dist.toFixed(1)}, armDist=${armDist.toFixed(1)}`);
                            if (dist < armDist) {
                                e._armedTimerStarted = true;
                                e._armedTimer = 0.8;
                                e._armedTargetType = 'chest';
                                // Store target position in case chest is destroyed before explosion
                                e._armedTargetX = closestTarget.x;
                                e._armedTargetY = closestTarget.y;
                                console.log(`[Server] Boomer ${e.id} ARMED at chest, will explode in 0.8s`);
                            }
                        }
                        
                        // Set warning state
                        const trigger = 220;
                        e._warningActive = dist < trigger;
                        e._closestPlayerDist = dist;
                        
                        // Countdown and explode (ALWAYS process if armed)
                        if (e._armedTimerStarted && typeof e._armedTimer === 'number' && e._armedTimer > 0) {
                            e._armedTimer -= deltaTime;
                            // Log countdown every 0.2 seconds
                            if (!e._lastCountdownLog || Date.now() - e._lastCountdownLog >= 200) {
                                console.log(`[Server] Boomer ${e.id} countdown: ${e._armedTimer.toFixed(2)}s remaining`);
                                e._lastCountdownLog = Date.now();
                            }
                            if (e._armedTimer <= 0) {
                                // Boomer explodes
                                console.log(`[Server] Boomer ${e.id} EXPLODING at chest!`);
                                e.alive = false;
                                
                                // Apply explosion damage inline (don't rely on socket handler)
                                // Broadcast explosion VFX and pooled puddle creation
                                io.to(this.id).emit('boomerExploded', { id: e.id, x: e.x, y: e.y });
                                // Register authoritative pool (lasts ~8s, radius ~100)
                                try { this.boomerPools.push({ x: e.x, y: e.y, radius: 100, ttl: 8.0 }); } catch(_) {}
                                
                                // Apply explosion damage to nearby entities (server-authoritative)
                                const blastRadius = 100;
                                const inner = 20;
                                
                                // Damage sandbags and barrels with boomer explosion
                                try {
                                    if (this.hazards) {
                                        this.hazards.damageCircle(e.x, e.y, blastRadius, 35);
                                        if (typeof this.hazards.damageBarrelInRadius === 'function') {
                                            this.hazards.damageBarrelInRadius(e.x, e.y, blastRadius, 35);
                                        }
                                    }
                                } catch(_) {}
                                
                                // Damage players
                                for (const [, p] of this.players) {
                                    if (!p) continue;
                                    const dxp = (p.x || 0) - e.x;
                                    const dyp = (p.y || 0) - e.y;
                                    const dp = Math.hypot(dxp, dyp);
                                    if (dp <= blastRadius + (p.radius || 0)) {
                                        // Respect invincibility if synced
                                        if (p.invincible === true) continue;
                                        const healthBefore = p.health;
                                        const outer = blastRadius;
                                        let tp = (dp - inner) / Math.max(1e-6, (outer - inner));
                                        tp = Math.max(0, Math.min(1, tp));
                                        const rawDmg = 45 - 25 * tp;
                                        // Apply armor reduction (cap at 75%)
                                        const armorPercent = Number.isFinite(p.armor) ? p.armor : 0;
                                        const reduction = Math.min(0.75, armorPercent / 100);
                                        const dmg = rawDmg * (1 - reduction);
                                        p.health = Math.max(0, (p.health || 0) - dmg);
                                        // Broadcast health to player and room
                                        try { p.socket.emit('playerHealth', { health: p.health, from: 'boomer' }); } catch(_) {}
                                        io.to(this.id).emit('playerHealthUpdate', { playerId: p.id, health: p.health });
                                        
                                        // Check for death
                                        if (p.health <= 0 && healthBefore > 0) {
                                            this._handlePlayerDeath(p.id, p, io);
                                        }
                                    }
                                }
                                
                                // Damage troops
                                if (this.troopManager && this.troopManager.troops) {
                                    for (const [, troop] of this.troopManager.troops) {
                                        if (!troop || !troop.alive || troop.health <= 0) continue;
                                        const dxt = (troop.x || 0) - e.x;
                                        const dyt = (troop.y || 0) - e.y;
                                        const dt = Math.hypot(dxt, dyt);
                                        if (dt <= blastRadius + (troop.radius || 22)) {
                                            const outer = blastRadius;
                                            let tt = (dt - inner) / Math.max(1e-6, (outer - inner));
                                            tt = Math.max(0, Math.min(1, tt));
                                            const rawDmg = 45 - 25 * tt;
                                            troop.health = Math.max(0, troop.health - rawDmg);
                                            
                                            // Broadcast troop damage for health bars and damage numbers
                                            io.to(this.id).emit('troopDamaged', {
                                                troopId: troop.id,
                                                // Send already-rounded integer damage for UI text (avoid "-0")
                                                damage: Math.max(1, Math.round(rawDmg)),
                                                health: troop.health,
                                                healthMax: troop.healthMax,
                                                x: troop.x,
                                                y: troop.y
                                            });
                                            
                                            if (troop.health <= 0) {
                                                troop.alive = false;
                                                console.log(`[Server] Troop ${troop.id} killed by Boomer explosion (updateEnemies)`);
                                                io.to(this.id).emit('troopDeath', {
                                                    troopId: troop.id,
                                                    x: troop.x,
                                                    y: troop.y
                                                });
                                                io.to(this.id).emit('entity_dead', {
                                                    entityType: 'troop',
                                                    id: troop.id,
                                                    x: troop.x,
                                                    y: troop.y,
                                                    kind: troop.type || 'troop',
                                                    cause: 'boomer_explosion'
                                                });
                                            }
                                        }
                                    }
                                }
                                
                                // Damage turrets
                                for (const [abilityId, ability] of this.abilities) {
                                    if (ability.type !== 'AutoTurret') continue;
                                    if (ability.health <= 0) continue;
                                    
                                    const dxt = (ability.x || 0) - e.x;
                                    const dyt = (ability.y || 0) - e.y;
                                    const dt = Math.hypot(dxt, dyt);
                                    if (dt <= blastRadius + (ability.radius || 25)) {
                                        const outer = blastRadius;
                                        let tt = (dt - inner) / Math.max(1e-6, (outer - inner));
                                        tt = Math.max(0, Math.min(1, tt));
                                        const dmg = 45 - 25 * tt; // Full damage (no armor)
                                        ability.health = Math.max(0, ability.health - dmg);
                                        
                                        // Broadcast health update
                                        io.to(this.id).emit('abilityHealthUpdate', {
                                            serverId: abilityId,
                                            health: ability.health,
                                            healthMax: ability.healthMax
                                        });
                                        
                                        // Destroy turret if health depleted
                                        if (ability.health <= 0) {
                                            io.to(this.id).emit('abilityTriggered', {
                                                serverId: abilityId,
                                                type: 'AutoTurret',
                                                event: 'death'
                                            });
                                            this.abilities.delete(abilityId);
                                            console.log(`[Server] AutoTurret ${abilityId} destroyed by boomer explosion`);
                                        }
                                    }
                                }
                                
                                // Damage gold chests
                                for (const [chestId, chest] of this.chests) {
                                    if (chest.variant !== 'gold' || chest.health <= 0 || chest.opened) continue;
                                    
                                    // Check if chest is vulnerable (only during waves or once activated)
                                    if (this.currentGameMode?.isChestVulnerable && !this.currentGameMode.isChestVulnerable(chest)) continue;
                                    
                                    const dxc = (chest.x || 0) - e.x;
                                    const dyc = (chest.y || 0) - e.y;
                                    const dc = Math.hypot(dxc, dyc);
                                    if (dc <= blastRadius + (chest.radius || 20)) {
                                        const outer = blastRadius;
                                        let tc = (dc - inner) / Math.max(1e-6, (outer - inner));
                                        tc = Math.max(0, Math.min(1, tc));
                                        const dmg = 95 - 75 * tc; // Full damage (no armor)
                                        chest.health = Math.max(0, chest.health - dmg);
                                        
                                        console.log(`[Server] Boomer explosion hit gold chest ${chest.id} for ${dmg.toFixed(1)} damage, health: ${chest.health.toFixed(1)}/${chest.healthMax}`);
                                        
                                        // Broadcast health update and hit flash
                                        io.to(this.id).emit('chestHealthUpdate', {
                                            chestId: chest.id,
                                            health: chest.health,
                                            healthMax: chest.healthMax
                                        });
                                        io.to(this.id).emit('chestHitFlash', {
                                            chestId: chest.id
                                        });
                                        
                                        // Auto-open chest if health depleted
                                        if (chest.health <= 0 && !chest.opened) {
                                            chest.opening = false;
                                            chest.opened = true;
                                            io.to(this.id).emit('chestOpened', { 
                                                id: chest.id, 
                                                x: chest.x, 
                                                y: chest.y, 
                                                variant: chest.variant, 
                                                artifact: { vx: 160, vy: -220 },
                                                health: chest.health,
                                                healthMax: chest.healthMax
                                            });
                                            chest.artifactCarriedBy = null;
                                            chest.artifactPos = { x: chest.x, y: chest.y };
                                        }
                                    }
                                }
                                
                                // Damage artifacts (on ground, not carried)
                                for (const [chestId, chest] of this.chests) {
                                    if (chest.variant !== 'gold' || !chest.opened || chest.health <= 0) continue;
                                    if (chest.artifactCarriedBy) continue;
                                    
                                    // Check if artifact is vulnerable (only during waves or once chest opened)
                                    if (this.currentGameMode?.isChestVulnerable && !this.currentGameMode.isChestVulnerable(chest)) continue;
                                    
                                    const artX = (chest.artifactPos && Number(chest.artifactPos.x)) || Number(chest.x) || 0;
                                    const artY = (chest.artifactPos && Number(chest.artifactPos.y)) || Number(chest.y) || 0;
                                    const dxa = artX - e.x;
                                    const dya = artY - e.y;
                                    const da = Math.hypot(dxa, dya);
                                    if (da <= blastRadius + 10) { // Artifact radius is 10
                                        const outer = blastRadius;
                                        let ta = (da - inner) / Math.max(1e-6, (outer - inner));
                                        ta = Math.max(0, Math.min(1, ta));
                                        const dmg = 95 - 75 * ta; // Full damage (no armor)
                                        chest.health = Math.max(0, chest.health - dmg);
                                        
                                        console.log(`[Server] Boomer explosion hit artifact ${chest.id} for ${dmg.toFixed(1)} damage, health: ${chest.health.toFixed(1)}/${chest.healthMax}`);
                                        
                                        // Broadcast health update and hit flash
                                        io.to(this.id).emit('artifactHealthUpdate', {
                                            chestId: chest.id,
                                            health: chest.health,
                                            healthMax: chest.healthMax
                                        });
                                        io.to(this.id).emit('artifactHitFlash', {
                                            chestId: chest.id
                                        });
                                        
                                        // Destroy artifact if health depleted
                                        if (chest.health <= 0) {
                                            console.log(`[Server] Artifact ${chest.id} destroyed by boomer explosion`);
                                            io.to(this.id).emit('artifactDestroyed', { chestId: chest.id });
                                        }
                                    }
                                }
                                
                                // Now emit enemy_dead to clients for visual effects
                                io.to(this.id).emit('enemy_dead', { id: e.id, x: e.x, y: e.y, type: e.type });
                                io.to(this.id).emit('entity_dead', {
                                    entityType: 'enemy',
                                    id: e.id,
                                    x: e.x,
                                    y: e.y,
                                    kind: e.type
                                });
                            }
                        } else if (e._armedTimerStarted) {
                            console.log(`[Server] Boomer ${e.id} armed but timer invalid: ${e._armedTimer}`);
                        }
                    }
                    
                    // If still targeting chest after validation, override enemy movement to go directly to chest
                    if (closestTargetType === 'chest') {
                        
                        // Manual simple steering toward chest (no Director pathfinding)
                        const dx = closestTarget.x - e.x;
                        const dy = closestTarget.y - e.y;
                        const dist = Math.sqrt(dx*dx + dy*dy);
                        if (dist > 0.1) {
                            const spd = (Number.isFinite(e.speed) ? e.speed : 150) * (Number.isFinite(e.speedMul) ? e.speedMul : 1);
                            const moveX = (dx / dist) * spd * deltaTime;
                            const moveY = (dy / dist) * spd * deltaTime;
                            const newX = e.x + moveX;
                            const newY = e.y + moveY;
                            if (this.environment && this.environment.isInsideBounds && this.environment.circleHitsAny) {
                                if (this.environment.isInsideBounds(newX, newY, e.radius) && 
                                    !this.environment.circleHitsAny(newX, newY, e.radius)) {
                                    e.x = newX;
                                    e.y = newY;
                                }
                            } else {
                                e.x = newX;
                                e.y = newY;
                            }
                        }
                        // Don't add to Director groups - we're handling movement manually
                        continue;
                    }
                } else if (closestTargetType === 'artifact' || (e.type === 'boomer' && e._armedTimerStarted && e._armedTimer > 0 && e._armedTargetType === 'artifact')) {
                    // Validate artifact target is still alive (but keep target if boomer is armed and exploding)
                    const boomerIsArmed = e.type === 'boomer' && e._armedTimerStarted && e._armedTimer > 0;
                    const chestRef = closestTarget && closestTarget._chestRef;
                    if (!boomerIsArmed && (!chestRef || chestRef.health <= 0 || !chestRef.opened || chestRef.artifactCarriedBy)) {
                        // Target destroyed/picked up, switch to nearest player
                        closestTarget = null;
                        for (const [, p] of this.players) {
                            if (!p || p.health <= 0) continue;
                            const dx = (p.x || 0) - e.x;
                            const dy = (p.y || 0) - e.y;
                            const d2 = dx*dx + dy*dy;
                            if (!closestTarget || d2 < bestD2) {
                                bestD2 = d2;
                                closestTarget = p;
                                closestTargetType = 'player';
                            }
                        }
                        if (!closestTarget) continue; // No valid target, skip this enemy
                    }
                    // Special handling for Boomers targeting artifacts (process armed boomers first)
                    if (e.type === 'boomer' && e.alive !== false && (closestTargetType === 'artifact' || (e._armedTimerStarted && e._armedTargetType === 'artifact'))) {
                        const dx = closestTarget ? closestTarget.x - e.x : (e._armedTargetX || 0) - e.x;
                        const dy = closestTarget ? closestTarget.y - e.y : (e._armedTargetY || 0) - e.y;
                        const dist = Math.sqrt(dx*dx + dy*dy);
                        
                        // Check if within arm distance (only arm if not already armed)
                        if (!e._armedTimerStarted && closestTarget) {
                            const armDist = Math.max(40, (closestTarget.radius || 10) + (e.radius || 26) + 18);
                            if (dist < armDist) {
                                e._armedTimerStarted = true;
                                e._armedTimer = 0.8;
                                e._armedTargetType = 'artifact';
                                // Store target position in case artifact is destroyed before explosion
                                e._armedTargetX = closestTarget.x;
                                e._armedTargetY = closestTarget.y;
                                console.log(`[Server] Boomer ${e.id} armed at artifact, will explode in 0.8s`);
                            }
                        }
                        
                        // Set warning state
                        const trigger = 220;
                        e._warningActive = dist < trigger;
                        e._closestPlayerDist = dist;
                        
                        // Countdown and explode (ALWAYS process if armed)
                        if (e._armedTimerStarted && typeof e._armedTimer === 'number' && e._armedTimer > 0) {
                            e._armedTimer -= deltaTime;
                            if (e._armedTimer <= 0) {
                                // Boomer explodes
                                console.log(`[Server] Boomer ${e.id} exploding at artifact!`);
                                e.alive = false;
                                
                                // Apply explosion damage inline (don't rely on socket handler)
                                // Broadcast explosion VFX and pooled puddle creation
                                io.to(this.id).emit('boomerExploded', { id: e.id, x: e.x, y: e.y });
                                // Register authoritative pool (lasts ~8s, radius ~100)
                                try { this.boomerPools.push({ x: e.x, y: e.y, radius: 100, ttl: 8.0 }); } catch(_) {}
                                
                                // Apply explosion damage to nearby entities (server-authoritative)
                                const blastRadius = 100;
                                const inner = 20;
                                
                                // Damage players
                                for (const [, p] of this.players) {
                                    if (!p) continue;
                                    const dxp = (p.x || 0) - e.x;
                                    const dyp = (p.y || 0) - e.y;
                                    const dp = Math.hypot(dxp, dyp);
                                    if (dp <= blastRadius + (p.radius || 0)) {
                                        // Respect invincibility if synced
                                        if (p.invincible === true) continue;
                                        const outer = blastRadius;
                                        let tp = (dp - inner) / Math.max(1e-6, (outer - inner));
                                        tp = Math.max(0, Math.min(1, tp));
                                        const rawDmg = 45 - 25 * tp;
                                        // Apply armor reduction (cap at 75%)
                                        const armorPercent = Number.isFinite(p.armor) ? p.armor : 0;
                                        const reduction = Math.min(0.75, armorPercent / 100);
                                        const dmg = rawDmg * (1 - reduction);
                                        p.health = Math.max(0, (p.health || 0) - dmg);
                                        // Broadcast health to player and room
                                        try { p.socket.emit('playerHealth', { health: p.health, from: 'boomer' }); } catch(_) {}
                                        io.to(this.id).emit('playerHealthUpdate', { playerId: p.id, health: p.health });
                                    }
                                }
                                
                                // Damage turrets
                                for (const [abilityId, ability] of this.abilities) {
                                    if (ability.type !== 'AutoTurret') continue;
                                    if (ability.health <= 0) continue;
                                    
                                    const dxt = (ability.x || 0) - e.x;
                                    const dyt = (ability.y || 0) - e.y;
                                    const dt = Math.hypot(dxt, dyt);
                                    if (dt <= blastRadius + (ability.radius || 25)) {
                                        const outer = blastRadius;
                                        let tt = (dt - inner) / Math.max(1e-6, (outer - inner));
                                        tt = Math.max(0, Math.min(1, tt));
                                        const dmg = 45 - 25 * tt; // Full damage (no armor)
                                        ability.health = Math.max(0, ability.health - dmg);
                                        
                                        // Broadcast health update
                                        io.to(this.id).emit('abilityHealthUpdate', {
                                            serverId: abilityId,
                                            health: ability.health,
                                            healthMax: ability.healthMax
                                        });
                                        
                                        // Destroy turret if health depleted
                                        if (ability.health <= 0) {
                                            io.to(this.id).emit('abilityTriggered', {
                                                serverId: abilityId,
                                                type: 'AutoTurret',
                                                event: 'death'
                                            });
                                            this.abilities.delete(abilityId);
                                            console.log(`[Server] AutoTurret ${abilityId} destroyed by boomer explosion`);
                                        }
                                    }
                                }
                                
                                // Damage gold chests
                                for (const [chestId, chest] of this.chests) {
                                    if (chest.variant !== 'gold' || chest.health <= 0 || chest.opened) continue;
                                    
                                    // Check if chest is vulnerable (only during waves or once activated)
                                    if (this.currentGameMode?.isChestVulnerable && !this.currentGameMode.isChestVulnerable(chest)) continue;
                                    
                                    const dxc = (chest.x || 0) - e.x;
                                    const dyc = (chest.y || 0) - e.y;
                                    const dc = Math.hypot(dxc, dyc);
                                    if (dc <= blastRadius + (chest.radius || 20)) {
                                        const outer = blastRadius;
                                        let tc = (dc - inner) / Math.max(1e-6, (outer - inner));
                                        tc = Math.max(0, Math.min(1, tc));
                                        const dmg = 95 - 75 * tc; // Full damage (no armor)
                                        chest.health = Math.max(0, chest.health - dmg);
                                        
                                        console.log(`[Server] Boomer explosion hit gold chest ${chest.id} for ${dmg.toFixed(1)} damage, health: ${chest.health.toFixed(1)}/${chest.healthMax}`);
                                        
                                        // Broadcast health update and hit flash
                                        io.to(this.id).emit('chestHealthUpdate', {
                                            chestId: chest.id,
                                            health: chest.health,
                                            healthMax: chest.healthMax
                                        });
                                        io.to(this.id).emit('chestHitFlash', {
                                            chestId: chest.id
                                        });
                                        
                                        // Auto-open chest if health depleted
                                        if (chest.health <= 0 && !chest.opened) {
                                            chest.opening = false;
                                            chest.opened = true;
                                            io.to(this.id).emit('chestOpened', { 
                                                id: chest.id, 
                                                x: chest.x, 
                                                y: chest.y, 
                                                variant: chest.variant, 
                                                artifact: { vx: 160, vy: -220 },
                                                health: chest.health,
                                                healthMax: chest.healthMax
                                            });
                                            chest.artifactCarriedBy = null;
                                            chest.artifactPos = { x: chest.x, y: chest.y };
                                        }
                                    }
                                }
                                
                                // Damage artifacts (on ground, not carried)
                                for (const [chestId, chest] of this.chests) {
                                    if (chest.variant !== 'gold' || !chest.opened || chest.health <= 0) continue;
                                    if (chest.artifactCarriedBy) continue;
                                    
                                    // Check if artifact is vulnerable (only during waves or once chest opened)
                                    if (this.currentGameMode?.isChestVulnerable && !this.currentGameMode.isChestVulnerable(chest)) continue;
                                    
                                    const artX = (chest.artifactPos && Number(chest.artifactPos.x)) || Number(chest.x) || 0;
                                    const artY = (chest.artifactPos && Number(chest.artifactPos.y)) || Number(chest.y) || 0;
                                    const dxa = artX - e.x;
                                    const dya = artY - e.y;
                                    const da = Math.hypot(dxa, dya);
                                    if (da <= blastRadius + 10) { // Artifact radius is 10
                                        const outer = blastRadius;
                                        let ta = (da - inner) / Math.max(1e-6, (outer - inner));
                                        ta = Math.max(0, Math.min(1, ta));
                                        const dmg = 95 - 75 * ta; // Full damage (no armor)
                                        chest.health = Math.max(0, chest.health - dmg);
                                        
                                        console.log(`[Server] Boomer explosion hit artifact ${chest.id} for ${dmg.toFixed(1)} damage, health: ${chest.health.toFixed(1)}/${chest.healthMax}`);
                                        
                                        // Broadcast health update and hit flash
                                        io.to(this.id).emit('artifactHealthUpdate', {
                                            chestId: chest.id,
                                            health: chest.health,
                                            healthMax: chest.healthMax
                                        });
                                        io.to(this.id).emit('artifactHitFlash', {
                                            chestId: chest.id
                                        });
                                        
                                        // Destroy artifact if health depleted
                                        if (chest.health <= 0) {
                                            console.log(`[Server] Artifact ${chest.id} destroyed by boomer explosion`);
                                            io.to(this.id).emit('artifactDestroyed', { chestId: chest.id });
                                        }
                                    }
                                }
                                
                                // Now emit enemy_dead to clients for visual effects
                                io.to(this.id).emit('enemy_dead', { id: e.id, x: e.x, y: e.y, type: e.type });
                                io.to(this.id).emit('entity_dead', {
                                    entityType: 'enemy',
                                    id: e.id,
                                    x: e.x,
                                    y: e.y,
                                    kind: e.type
                                });
                            }
                        }
                    }
                    
                    // If still targeting artifact after validation, override enemy movement to go directly to artifact
                    if (closestTargetType === 'artifact') {
                        
                        // Manual simple steering toward artifact (no Director pathfinding)
                        const dx = closestTarget.x - e.x;
                        const dy = closestTarget.y - e.y;
                        const dist = Math.sqrt(dx*dx + dy*dy);
                        if (dist > 0.1) {
                            const spd = (Number.isFinite(e.speed) ? e.speed : 150) * (Number.isFinite(e.speedMul) ? e.speedMul : 1);
                            const moveX = (dx / dist) * spd * deltaTime;
                            const moveY = (dy / dist) * spd * deltaTime;
                            const newX = e.x + moveX;
                            const newY = e.y + moveY;
                            if (this.environment && this.environment.isInsideBounds && this.environment.circleHitsAny) {
                                if (this.environment.isInsideBounds(newX, newY, e.radius) && 
                                    !this.environment.circleHitsAny(newX, newY, e.radius)) {
                                    e.x = newX;
                                    e.y = newY;
                                }
                            } else {
                                e.x = newX;
                                e.y = newY;
                            }
                        }
                        // Don't add to Director groups - we're handling movement manually
                        continue;
                    }
                } else if (closestTargetType === 'attractor') {
                    // If targeting an attractor, override enemy movement to go directly to attractor
                    // Attractors are passive and don't fight back, just take damage
                    
                    // Special handling for Boomers targeting attractors
                    if (e.type === 'boomer' && e.alive !== false) {
                        const dx = closestTarget.x - e.x;
                        const dy = closestTarget.y - e.y;
                        const dist = Math.sqrt(dx*dx + dy*dy);
                        
                        // Check if within arm distance
                        const armDist = Math.max(40, (closestTarget.radius || 20) + (e.radius || 26) + 18);
                        if (dist < armDist && !e._armedTimerStarted) {
                            e._armedTimerStarted = true;
                            e._armedTimer = 0.8;
                        }
                        
                        // Set warning state
                        const trigger = 220;
                        e._warningActive = dist < trigger;
                        e._closestPlayerDist = dist;
                        
                        // Countdown and explode
                        if (e._armedTimerStarted && typeof e._armedTimer === 'number' && e._armedTimer > 0) {
                            e._armedTimer -= deltaTime;
                            if (e._armedTimer <= 0) {
                                // Detonate
                                e._armedTimer = 0;
                                io.to(this.id).emit('boomerExploded', { id: e.id, x: e.x, y: e.y });
                                try { this.boomerPools.push({ x: e.x, y: e.y, radius: 100, ttl: 8.0 }); } catch(_) {}
                                
                                const blastRadius = 100;
                                const inner = 20;
                                
                                // Damage players
                                for (const [, p] of this.players) {
                                    if (!p) continue;
                                    const dxp = (p.x || 0) - e.x;
                                    const dyp = (p.y || 0) - e.y;
                                    const dp = Math.hypot(dxp, dyp);
                                    if (dp <= blastRadius + (p.radius || 0)) {
                                        if (p.invincible === true) continue;
                                        const outer = blastRadius;
                                        let tp = (dp - inner) / Math.max(1e-6, (outer - inner));
                                        tp = Math.max(0, Math.min(1, tp));
                                        const rawDmg = 45 - 25 * tp;
                                        const armorPercent = Number.isFinite(p.armor) ? p.armor : 0;
                                        const reduction = Math.min(0.75, armorPercent / 100);
                                        const dmg = rawDmg * (1 - reduction);
                                        p.health = Math.max(0, (p.health || 0) - dmg);
                                        try { p.socket.emit('playerHealth', { health: p.health, from: 'boomer' }); } catch(_) {}
                                        io.to(this.id).emit('playerHealthUpdate', { playerId: p.id, health: p.health });
                                    }
                                }
                                
                                // Damage troops
                                if (this.troopManager && this.troopManager.troops) {
                                    for (const [, troop] of this.troopManager.troops) {
                                        if (!troop || !troop.alive || troop.health <= 0) continue;
                                        const dxt = (troop.x || 0) - e.x;
                                        const dyt = (troop.y || 0) - e.y;
                                        const dt = Math.hypot(dxt, dyt);
                                        if (dt <= blastRadius + (troop.radius || 22)) {
                                            const outer = blastRadius;
                                            let tt = (dt - inner) / Math.max(1e-6, (outer - inner));
                                            tt = Math.max(0, Math.min(1, tt));
                                            const rawDmg = 45 - 25 * tt;
                                            troop.health = Math.max(0, troop.health - rawDmg);
                                            
                                            // Broadcast troop damage for health bars and damage numbers
                                            io.to(this.id).emit('troopDamaged', {
                                                troopId: troop.id,
                                                // Send already-rounded integer damage for UI text (avoid "-0")
                                                damage: Math.max(1, Math.round(rawDmg)),
                                                health: troop.health,
                                                healthMax: troop.healthMax,
                                                x: troop.x,
                                                y: troop.y
                                            });
                                            
                                            if (troop.health <= 0) {
                                                troop.alive = false;
                                                console.log(`[Server] Troop ${troop.id} killed by Boomer explosion (enemyDied event)`);
                                                io.to(this.id).emit('troopDeath', {
                                                    troopId: troop.id,
                                                    x: troop.x,
                                                    y: troop.y
                                                });
                                                io.to(this.id).emit('entity_dead', {
                                                    entityType: 'troop',
                                                    id: troop.id,
                                                    x: troop.x,
                                                    y: troop.y,
                                                    kind: troop.type || 'troop',
                                                    cause: 'boomer_explosion'
                                                });
                                            }
                                        }
                                    }
                                }
                                
                                // Damage attractors and other abilities
                                for (const [abilityId, ability] of this.abilities) {
                                    if (ability.health <= 0) continue;
                                    const dxt = (ability.x || 0) - e.x;
                                    const dyt = (ability.y || 0) - e.y;
                                    const dt = Math.hypot(dxt, dyt);
                                    if (dt <= blastRadius + (ability.radius || 20)) {
                                        const outer = blastRadius;
                                        let tt = (dt - inner) / Math.max(1e-6, (outer - inner));
                                        tt = Math.max(0, Math.min(1, tt));
                                        const dmg = 45 - 25 * tt;
                                        ability.health = Math.max(0, ability.health - dmg);
                                        io.to(this.id).emit('abilityHealthUpdate', {
                                            serverId: abilityId,
                                            health: ability.health,
                                            healthMax: ability.healthMax
                                        });
                                        if (ability.health <= 0) {
                                            io.to(this.id).emit('abilityTriggered', {
                                                serverId: abilityId,
                                                type: ability.type,
                                                event: 'death'
                                            });
                                            this.abilities.delete(abilityId);
                                        }
                                    }
                                }
                                
                                // Kill boomer
                                e.alive = false;
                                this.enemies.delete(e.id);
                                continue;
                            }
                        }
                    }
                    
                    // Move directly toward attractor (bypass Director)
                    const dx = closestTarget.x - e.x;
                    const dy = closestTarget.y - e.y;
                    const dist = Math.sqrt(dx*dx + dy*dy);
                    
                    // Calculate desired distance
                    const attractorRadius = closestTarget.radius || 20;
                    const enemyRadius = e.radius || 26;
                    const desiredDist = 35; // Fixed 35 units spacing
                    
                    // Apply contact damage to attractor if enemy is close enough
                    const sumR = enemyRadius + attractorRadius;
                    if (dist <= sumR) {
                        const contactDamage = 10 * deltaTime; // Same rate as to turrets
                        closestTarget.health = Math.max(0, closestTarget.health - contactDamage);
                        
                        // Track if we need to broadcast health update
                        if (!closestTarget._damageThisFrame) {
                            closestTarget._damageThisFrame = contactDamage;
                        } else {
                            closestTarget._damageThisFrame += contactDamage;
                        }
                    }
                    // Only move if we're farther than desired distance
                    if (dist > desiredDist + 1) {
                        const baseSpeed = 110; // Match Director speed
                        const speed = baseSpeed * (e.speedMul || 1) * deltaTime;
                        const moveX = (dx / dist) * speed;
                        const moveY = (dy / dist) * speed;

                        // Swept collision resolution to prevent tunneling on dt spikes
                        let newX = e.x + moveX;
                        let newY = e.y + moveY;
                        if (this.environment && typeof this.environment.resolveCircleMove === 'function') {
                            const res = this.environment.resolveCircleMove(e.x, e.y, e.radius || 26, moveX, moveY);
                            newX = res.x;
                            newY = res.y;
                        } else if (this.environment && this.environment.isInsideBounds && this.environment.circleHitsAny) {
                            if (!(this.environment.isInsideBounds(newX, newY, e.radius) &&
                                  !this.environment.circleHitsAny(newX, newY, e.radius))) {
                                newX = e.x;
                                newY = e.y;
                            }
                        }
                        e.x = newX;
                        e.y = newY;
                    }
                    // Don't add to Director groups - we're handling movement manually
                    continue;
                } else if (closestTargetType === 'wander') {
                    // Handle wander movement manually (similar to turret/attractor)
                    const dx = closestTarget.x - e.x;
                    const dy = closestTarget.y - e.y;
                    const dist = Math.sqrt(dx*dx + dy*dy);
                    
                    // Only move if we haven't reached the wander target
                    if (dist > 10) {
                        const baseSpeed = 110; // Match Director speed
                        const speed = baseSpeed * (e.speedMul || 1) * deltaTime;
                        const moveX = (dx / dist) * speed;
                        const moveY = (dy / dist) * speed;

                        // Swept collision resolution to prevent tunneling on dt spikes
                        let newX = e.x + moveX;
                        let newY = e.y + moveY;
                        if (this.environment && typeof this.environment.resolveCircleMove === 'function') {
                            const res = this.environment.resolveCircleMove(e.x, e.y, e.radius || 26, moveX, moveY);
                            newX = res.x;
                            newY = res.y;
                        } else if (this.environment && this.environment.isInsideBounds && this.environment.circleHitsAny) {
                            if (!(this.environment.isInsideBounds(newX, newY, e.radius) &&
                                  !this.environment.circleHitsAny(newX, newY, e.radius))) {
                                newX = e.x;
                                newY = e.y;
                            }
                        }
                        e.x = newX;
                        e.y = newY;
                    }
                    // Don't add to Director groups - we're handling movement manually
                    continue;
                } else if (closestTargetType === 'troop') {
                    // Troop targeting is handled via troop-specific Director (slotting + separation)
                    const troopId = closestTarget && closestTarget.id;
                    if (troopId != null) {
                        // Split troop-targeted enemies by ranged vs melee so projectile zombies can keep distance and shoot
                        if (e.type === 'projectile') {
                            let arrT = troopGroupsRanged.get(troopId);
                            if (!arrT) { arrT = []; troopGroupsRanged.set(troopId, arrT); }
                            arrT.push(wrapped);
                        } else {
                            let arrT = troopGroupsMelee.get(troopId);
                            if (!arrT) { arrT = []; troopGroupsMelee.set(troopId, arrT); }
                            arrT.push(wrapped);
                        }
                    }
                    continue;
                }
                
                // Normal player targeting - add to Director groups
                const arr = groups.get(closestTarget.id);
                if (arr) arr.push(wrapped);
            }

            // Run troop-specific Directors so enemies keep spacing around troopers without dogpiling.
            // We split melee vs ranged (projectile) so ranged units keep distance and can actually shoot.
            if (DirectorClass) {
                // 1) Melee troop-targeting (non-projectile): close ring + contact damage
                if (troopGroupsMelee && troopGroupsMelee.size > 0) {
                    for (const [tid, arr] of troopGroupsMelee) {
                        if (!arr || arr.length === 0) continue;
                        const troopRef = (this.troopManager && this.troopManager.troops) ? this.troopManager.troops.get(tid) : null;
                        if (!troopRef || !troopRef.alive || troopRef.health <= 0) continue;

                        let dir = this._enemyTroopDirectorsMelee.get(tid);
                        if (!dir) {
                            const listObj = { items: arr, queryCircle: (cx, cy, r) => arr.filter(o => {
                                const dx = (o.x - cx); const dy = (o.y - cy); return (dx*dx + dy*dy) <= r*r;
                            }) };
                            dir = new DirectorClass(listObj, this.environment, troopRef);
                            // Ensure dogpile prevention works even for contact enemies
                            dir.allowContactRush = false;
                            this._enemyTroopDirectorsMelee.set(tid, dir);
                        }
                        // Keep references fresh each tick
                        dir.enemies = { items: arr, queryCircle: (cx, cy, r) => arr.filter(o => {
                            const dx = (o.x - cx); const dy = (o.y - cy); return (dx*dx + dy*dy) <= r*r;
                        }) };
                        dir.environment = this.environment;
                        dir.player = troopRef;

                        // Slotting configuration around the troop (matches previous melee "breathing room")
                        const troopRadius = Number.isFinite(troopRef.radius) ? troopRef.radius : 22;
                        const typicalEnemyRadius = 26;
                        const breathingRoom = 30;
                        dir.ringEnabled = true;
                        dir.ringRadius = troopRadius + typicalEnemyRadius + breathingRoom;
                        dir.ringArcSpacing = 60;
                        dir.separationPadding = Math.max(dir.separationPadding || 0, 14);
                        dir.separationRadius = Math.max(dir.separationRadius || 0, 120);

                        dir.update(deltaTime);

                        // Write back positions + apply troop melee contact damage at the ring distance
                        for (let i = 0; i < arr.length; i++) {
                            const w = arr[i];
                            if (!w || !w._ref) continue;
                            w._ref.x = w.x;
                            w._ref.y = w.y;

                            const enemyRadius = Number.isFinite(w.radius) ? w.radius : 26;
                            const desiredDist = enemyRadius + troopRadius + breathingRoom;
                            const dx = (troopRef.x || 0) - w.x;
                            const dy = (troopRef.y || 0) - w.y;
                            const dist = Math.hypot(dx, dy);
                            if (dist <= desiredDist) {
                                const contactDamage = 10 * deltaTime;
                                troopRef.health = Math.max(0, (troopRef.health || 0) - contactDamage);
                                if (!troopRef._damageThisFrame) troopRef._damageThisFrame = contactDamage;
                                else troopRef._damageThisFrame += contactDamage;
                            }
                        }
                    }
                }

                // 2) Ranged troop-targeting (projectile): wider ring + ranged firing at trooper
                if (troopGroupsRanged && troopGroupsRanged.size > 0) {
                    for (const [tid, arr] of troopGroupsRanged) {
                        if (!arr || arr.length === 0) continue;
                        const troopRef = (this.troopManager && this.troopManager.troops) ? this.troopManager.troops.get(tid) : null;
                        if (!troopRef || !troopRef.alive || troopRef.health <= 0) continue;

                        let dir = this._enemyTroopDirectorsRanged.get(tid);
                        if (!dir) {
                            const listObj = { items: arr, queryCircle: (cx, cy, r) => arr.filter(o => {
                                const dx = (o.x - cx); const dy = (o.y - cy); return (dx*dx + dy*dy) <= r*r;
                            }) };
                            dir = new DirectorClass(listObj, this.environment, troopRef);
                            dir.allowContactRush = false;
                            this._enemyTroopDirectorsRanged.set(tid, dir);
                        }
                        // Keep references fresh each tick
                        dir.enemies = { items: arr, queryCircle: (cx, cy, r) => arr.filter(o => {
                            const dx = (o.x - cx); const dy = (o.y - cy); return (dx*dx + dy*dy) <= r*r;
                        }) };
                        dir.environment = this.environment;
                        dir.player = troopRef;

                        // Keep ranged units in their valid firing band (>=200)
                        dir.ringEnabled = true;
                        dir.ringRadius = 320;
                        dir.ringArcSpacing = 90;
                        dir.separationPadding = Math.max(dir.separationPadding || 0, 10);
                        dir.separationRadius = Math.max(dir.separationRadius || 0, 160);

                        dir.update(deltaTime);

                        // Write back positions + server-authoritative ranged firing at this troop
                        for (let i = 0; i < arr.length; i++) {
                            const w = arr[i];
                            const e = w && w._ref;
                            if (!w || !e) continue;
                            e.x = w.x;
                            e.y = w.y;

                            if (e.type !== 'projectile') continue;
                            if (typeof e._svFireCooldown !== 'number') e._svFireCooldown = 0;
                            if (typeof e._burstShotsRemaining !== 'number') e._burstShotsRemaining = 0;
                            e._svFireCooldown -= deltaTime;

                            const targetX = Number(troopRef.x) || 0;
                            const targetY = Number(troopRef.y) || 0;
                            const dx = targetX - e.x;
                            const dy = targetY - e.y;
                            const dist = Math.hypot(dx, dy) || 1;

                            let wantFire = dist >= 200 && dist <= 900;
                            if (wantFire && this.environment && typeof this.environment.lineHitsAny === 'function') {
                                const losBlocked = this.environment.lineHitsAny(e.x, e.y, targetX, targetY);
                                if (losBlocked) wantFire = false;
                            }
                            if (!wantFire || e._svFireCooldown > 0) continue;

                            const ang = Math.atan2(dy, dx);
                            const base = 80; // matches client base 80
                            const spd = 2 * base * (dir.speedByMode?.[dir.mode] ?? 1) * (Number.isFinite(e.speedMul) ? e.speedMul : 1);
                            const vx = Math.cos(ang) * spd;
                            const vy = Math.sin(ang) * spd;
                            const r = 6;
                            const life = 6.0;
                            const color = '#7adf7a';
                            const sx = e.x + Math.cos(ang) * ((e.radius || 26) + r + 2);
                            const sy = e.y + Math.sin(ang) * ((e.radius || 26) + r + 2);
                            const damage = 7 + Math.random() * 7; // 7-14 damage

                            io.to(this.id).emit('enemyProjectileFired', {
                                enemyId: e.id,
                                x: sx,
                                y: sy,
                                vx,
                                vy,
                                radius: r,
                                color,
                                life,
                                angle: ang,
                                damage: damage
                            });
                            this.enemyProjectiles.push({ x: sx, y: sy, vx, vy, radius: r, damage: damage, life, maxLife: life });

                            // Match existing firing patterns/cooldowns
                            if (e._burstShotsRemaining > 0) {
                                e._burstShotsRemaining--;
                                e._svFireCooldown = 0.45 + Math.random() * 0.25;
                            } else {
                                const patternRoll = Math.random();
                                if (patternRoll < 0.2) {
                                    e._burstShotsRemaining = 1 + Math.floor(Math.random() * 2);
                                    e._svFireCooldown = 0.45 + Math.random() * 0.25;
                                } else if (patternRoll < 0.5) {
                                    e._svFireCooldown = 2.5 + Math.random() * 2.5;
                                } else {
                                    e._svFireCooldown = 1.7 + Math.random() * 1.1;
                                }
                            }
                        }
                    }
                }
            }
            
            // Broadcast accumulated turret and attractor damage from enemies
            for (const [abilityId, ability] of this.abilities) {
                if (ability.type !== 'AutoTurret' && ability.type !== 'EnemyAttractor') continue;
                if (ability._damageThisFrame && ability._damageThisFrame > 0) {
                    // Broadcast health update
                    io.to(this.id).emit('abilityHealthUpdate', {
                        serverId: abilityId,
                        health: ability.health,
                        healthMax: ability.healthMax
                    });
                    
                    // Check if ability was destroyed
                    if (ability.health <= 0) {
                        io.to(this.id).emit('abilityTriggered', {
                            serverId: abilityId,
                            type: ability.type,
                            event: 'death'
                        });
                        this.abilities.delete(abilityId);
                        console.log(`[Server] ${ability.type} ${abilityId} destroyed by enemy contact`);
                    }
                    
                    // Clear damage accumulator for next frame
                    delete ability._damageThisFrame;
                }
            }
            
            // Broadcast accumulated troop damage from enemies
            if (this.troopManager && this.troopManager.troops) {
                // Rate limit + accumulate troop damage numbers so we don't spam "-0" for fractional DPS ticks.
                if (!this._troopDamageNumberCooldown) this._troopDamageNumberCooldown = new Map();
                if (!this._troopDamageAccumulator) this._troopDamageAccumulator = new Map();
                const now = Date.now();
                const damageNumberInterval = 500; // 0.5s batching

                for (const [troopId, troop] of this.troopManager.troops) {
                    if (!troop || !troop.alive) continue;
                    if (troop._damageThisFrame && troop._damageThisFrame > 0) {
                        const add = troop._damageThisFrame;
                        const prev = this._troopDamageAccumulator.get(troopId) || 0;
                        this._troopDamageAccumulator.set(troopId, prev + add);

                        const lastBroadcast = this._troopDamageNumberCooldown.get(troopId) || 0;
                        const shouldBroadcast = (now - lastBroadcast) >= damageNumberInterval;
                        if (shouldBroadcast) {
                            const accumulatedDamage = this._troopDamageAccumulator.get(troopId) || add;
                            const damageInt = Math.round(accumulatedDamage);
                            // Only emit once rounding would show at least 1 (prevents "-0")
                            if (damageInt >= 1) {
                                io.to(this.id).emit('troopDamaged', {
                                    troopId: troopId,
                                    x: troop.x,
                                    y: troop.y,
                                    damage: damageInt,
                                    health: troop.health,
                                    healthMax: troop.healthMax
                                });
                                // Reset accumulator and update cooldown timer (only when we actually emit)
                                this._troopDamageAccumulator.set(troopId, 0);
                                this._troopDamageNumberCooldown.set(troopId, now);
                            }
                        }
                        
                        // Check if troop was killed
                        if (troop.health <= 0) {
                            troop.alive = false;
                        io.to(this.id).emit('troopDied', {
                            troopId: troopId,
                            x: troop.x,
                            y: troop.y
                        });
                        // console.log(`[Server] Troop ${troopId} killed by enemy contact`);
                        // Cleanup tracking maps for dead troop
                        try { this._troopDamageNumberCooldown.delete(troopId); } catch(_) {}
                        try { this._troopDamageAccumulator.delete(troopId); } catch(_) {}
                        }
                        
                        // Clear damage accumulator for next frame
                        delete troop._damageThisFrame;
                    }
                }
            }
            // Run a Director per player on that player's group of enemies
            for (const [pid, arr] of groups) {
                if (!arr || arr.length === 0) continue;
                const playerRef = this.players.get(pid);
                if (!playerRef || playerRef.health <= 0) continue; // Skip dead players

                let dir = this._enemyDirectors.get(pid);
                if (!dir) {
                    const listObj = { items: arr, queryCircle: (cx, cy, r) => arr.filter(o => {
                        const dx = (o.x - cx); const dy = (o.y - cy); return (dx*dx + dy*dy) <= r*r;
                    }) };
                    dir = new DirectorClass(listObj, this.environment, playerRef);
                    this._enemyDirectors.set(pid, dir);
                }
                // Keep references fresh each tick
                dir.enemies = { items: arr, queryCircle: (cx, cy, r) => arr.filter(o => {
                    const dx = (o.x - cx); const dy = (o.y - cy); return (dx*dx + dy*dy) <= r*r;
                }) };
                dir.environment = this.environment;
                dir.player = playerRef;
                
                // Process knockback for enemies before Director movement
                for (let i = 0; i < arr.length; i++) {
                    const w = arr[i];
                    if (!w || !w.alive) continue;
                    if (Number.isFinite(w.kbTime) && w.kbTime > 0) {
                        const step = Math.min(w.kbTime, deltaTime);
                        const kbVelX = Number.isFinite(w.kbVelX) ? w.kbVelX : 0;
                        const kbVelY = Number.isFinite(w.kbVelY) ? w.kbVelY : 0;
                        const dx = kbVelX * step;
                        const dy = kbVelY * step;
                        let newX = w.x + dx;
                        let newY = w.y + dy;
                        
                        // Collision resolution if environment has the method
                        if (this.environment && typeof this.environment.resolveCircleMove === 'function') {
                            try {
                                const res = this.environment.resolveCircleMove(w.x, w.y, w.radius, dx, dy);
                                newX = res.x;
                                newY = res.y;
                            } catch(err) {
                                console.error('[Server] resolveCircleMove error:', err);
                            }
                        }
                        
                        // Update wrapped position
                        w.x = newX;
                        w.y = newY;
                        
                        // Decay knockback time
                        w.kbTime -= deltaTime;
                        if (w.kbTime < 0) {
                            w.kbTime = 0;
                            w.kbVelX = 0;
                            w.kbVelY = 0;
                        }
                        
                        // Write knockback state back to authoritative enemy
                        if (w._ref) {
                            w._ref.kbTime = w.kbTime;
                            w._ref.kbVelX = w.kbVelX;
                            w._ref.kbVelY = w.kbVelY;
                        }
                    }
                }
                
                // Update movement for this group (Director will skip enemies with kbTime > 0)
                dir.update(deltaTime);

                // Write back updated positions to authoritative enemy objects
                for (let i = 0; i < arr.length; i++) {
                    const w = arr[i];
                    if (!w || !w._ref) continue;
                    w._ref.x = w.x;
                    w._ref.y = w.y;
                }

                // Server-authoritative ranged firing for projectile-type enemies in this group
                const now = Date.now();
                for (let i = 0; i < arr.length; i++) {
                    const w = arr[i];
                    const e = w && w._ref; if (!e) continue;
                    // Boomer arming/detonation near target (server-authoritative)
                    if (e.type === 'boomer' && e.alive !== false) {
                        // Check distance to ALL players for warning ring visibility
                        let closestDist = Infinity;
                        let anyPlayerInTrigger = false;
                        const trigger = 220;
                        
                        for (const [, p] of this.players) {
                            if (!p || p.health <= 0) continue;
                            const px = Number(p.x) || 0;
                            const py = Number(p.y) || 0;
                            const dx = px - e.x;
                            const dy = py - e.y;
                            const dist = Math.hypot(dx, dy) || 1;
                            
                            if (dist < closestDist) closestDist = dist;
                            if (dist < trigger) anyPlayerInTrigger = true;
                            
                            // Check if close enough to arm
                            const armDist = Math.max(40, (p.radius || 26) + (e.radius || 26) + 18);
                            if (dist < armDist && !e._armedTimerStarted) {
                                e._armedTimerStarted = true;
                                e._armedTimer = 0.1; // short fuse once inside arm distance
                            }
                        }
                        
                        // Also check distance to turrets
                        for (const [, ability] of this.abilities) {
                            if (ability.type !== 'AutoTurret') continue;
                            if (ability.health <= 0) continue;
                            
                            const tx = Number(ability.x) || 0;
                            const ty = Number(ability.y) || 0;
                            const dx = tx - e.x;
                            const dy = ty - e.y;
                            const dist = Math.hypot(dx, dy) || 1;
                            
                            if (dist < closestDist) closestDist = dist;
                            if (dist < trigger) anyPlayerInTrigger = true;
                            
                            // Check if close enough to arm
                            const armDist = Math.max(40, (ability.radius || 25) + (e.radius || 26) + 18);
                            if (dist < armDist && !e._armedTimerStarted) {
                                e._armedTimerStarted = true;
                                e._armedTimer = 0.1; // short fuse once inside arm distance
                            }
                        }
                        
                        // Store for syncing to clients
                        e._warningActive = anyPlayerInTrigger;
                        e._closestPlayerDist = closestDist;
                        if (e._armedTimerStarted && typeof e._armedTimer === 'number' && e._armedTimer > 0) {
                            e._armedTimer -= deltaTime;
                            if (e._armedTimer <= 0) {
                                // Detonate once
                                e._armedTimer = 0;
                                // Broadcast explosion VFX and pooled puddle creation
                                io.to(this.id).emit('boomerExploded', { id: e.id, x: e.x, y: e.y });
                                // Register authoritative pool (lasts ~8s, radius ~100)
                                try { this.boomerPools.push({ x: e.x, y: e.y, radius: 100, ttl: 8.0 }); } catch(_) {}
                                // Apply explosion damage to nearby players (server-authoritative)
                                const blastRadius = 100;
                                const inner = 20;
                                for (const [, p] of this.players) {
                                    if (!p) continue;
                                    const dxp = (p.x || 0) - e.x;
                                    const dyp = (p.y || 0) - e.y;
                                    const dp = Math.hypot(dxp, dyp);
                                    if (dp <= blastRadius + (p.radius || 0)) {
                                        // Respect invincibility if synced
                                        if (p.invincible === true) continue;
                                        const outer = blastRadius;
                                        let tp = (dp - inner) / Math.max(1e-6, (outer - inner));
                                        tp = Math.max(0, Math.min(1, tp));
                                        const rawDmg = 45 - 25 * tp;
                                        // Apply armor reduction (cap at 75%)
                                        const armorPercent = Number.isFinite(p.armor) ? p.armor : 0;
                                        const reduction = Math.min(0.75, armorPercent / 100);
                                        const dmg = rawDmg * (1 - reduction);
                                        p.health = Math.max(0, (p.health || 0) - dmg);
                                        // Broadcast health to player and room
                                        try { p.socket.emit('playerHealth', { health: p.health, from: 'boomer' }); } catch(_) {}
                                        io.to(this.id).emit('playerHealthUpdate', { playerId: p.id, health: p.health });
                                    }
                                }
                                
                                // Apply explosion damage to nearby troops (server-authoritative)
                                if (this.troopManager && this.troopManager.troops) {
                                    for (const [, troop] of this.troopManager.troops) {
                                        if (!troop || !troop.alive || troop.health <= 0) continue;
                                        const dxt = (troop.x || 0) - e.x;
                                        const dyt = (troop.y || 0) - e.y;
                                        const dt = Math.hypot(dxt, dyt);
                                        if (dt <= blastRadius + (troop.radius || 22)) {
                                            const outer = blastRadius;
                                            let tt = (dt - inner) / Math.max(1e-6, (outer - inner));
                                            tt = Math.max(0, Math.min(1, tt));
                                            const rawDmg = 45 - 25 * tt;
                                            troop.health = Math.max(0, troop.health - rawDmg);
                                            
                                            // Broadcast troop damage for visual feedback (damage numbers, health bars)
                                            io.to(this.id).emit('troopDamaged', {
                                                troopId: troop.id,
                                                damage: rawDmg,
                                                health: troop.health,
                                                healthMax: troop.healthMax,
                                                x: troop.x,
                                                y: troop.y
                                            });
                                            
                                            // Check if troop died
                                            if (troop.health <= 0) {
                                                troop.alive = false;
                                                io.to(this.id).emit('troopDeath', {
                                                    troopId: troop.id,
                                                    x: troop.x,
                                                    y: troop.y
                                                });
                                                io.to(this.id).emit('entity_dead', {
                                                    entityType: 'troop',
                                                    id: troop.id,
                                                    x: troop.x,
                                                    y: troop.y,
                                                    kind: troop.type || 'troop',
                                                    cause: 'boomer_explosion'
                                                });
                                                console.log(`[Server] Troop ${troop.id} killed by boomer explosion`);
                                            }
                                        }
                                    }
                                }
                                
                                // Apply explosion damage to nearby turrets (server-authoritative)
                                for (const [abilityId, ability] of this.abilities) {
                                    if (ability.type !== 'AutoTurret') continue;
                                    if (ability.health <= 0) continue;
                                    
                                    const dxt = (ability.x || 0) - e.x;
                                    const dyt = (ability.y || 0) - e.y;
                                    const dt = Math.hypot(dxt, dyt);
                                    if (dt <= blastRadius + (ability.radius || 25)) {
                                        const outer = blastRadius;
                                        let tt = (dt - inner) / Math.max(1e-6, (outer - inner));
                                        tt = Math.max(0, Math.min(1, tt));
                                        const dmg = 45 - 25 * tt; // Full damage (no armor)
                                        ability.health = Math.max(0, ability.health - dmg);
                                        
                                        // Broadcast health update
                                        io.to(this.id).emit('abilityHealthUpdate', {
                                            serverId: abilityId,
                                            health: ability.health,
                                            healthMax: ability.healthMax
                                        });
                                        
                                        // Destroy turret if health depleted
                                        if (ability.health <= 0) {
                                            io.to(this.id).emit('abilityTriggered', {
                                                serverId: abilityId,
                                                type: 'AutoTurret',
                                                event: 'death'
                                            });
                                            this.abilities.delete(abilityId);
                                            console.log(`[Server] AutoTurret ${abilityId} destroyed by boomer explosion`);
                                        }
                                    }
                                }
                                
                                // Apply explosion damage to gold chests
                                for (const [chestId, chest] of this.chests) {
                                    if (chest.variant !== 'gold' || chest.health <= 0) continue;
                                    
                                    const dxc = (chest.x || 0) - e.x;
                                    const dyc = (chest.y || 0) - e.y;
                                    const dc = Math.hypot(dxc, dyc);
                                    if (dc <= blastRadius + (chest.radius || 20)) {
                                        const outer = blastRadius;
                                        let tc = (dc - inner) / Math.max(1e-6, (outer - inner));
                                        tc = Math.max(0, Math.min(1, tc));
                                        const dmg = 95 - 75 * tc; // Full damage (no armor)
                                        chest.health = Math.max(0, chest.health - dmg);
                                        
                                        // Broadcast health update and hit flash
                                        io.to(this.id).emit('chestHealthUpdate', {
                                            chestId: chest.id,
                                            health: chest.health,
                                            healthMax: chest.healthMax
                                        });
                                        io.to(this.id).emit('chestHitFlash', {
                                            chestId: chest.id
                                        });
                                        
                                        // Auto-open chest if health depleted
                                        if (chest.health <= 0 && !chest.opened) {
                                            chest.opening = false;
                                            chest.opened = true;
                                            io.to(this.id).emit('chestOpened', { 
                                                id: chest.id, 
                                                x: chest.x, 
                                                y: chest.y, 
                                                variant: chest.variant, 
                                                artifact: { vx: 160, vy: -220 },
                                                health: chest.health,
                                                healthMax: chest.healthMax
                                            });
                                            chest.artifactCarriedBy = null;
                                            chest.artifactPos = { x: chest.x, y: chest.y };
                                        }
                                    }
                                }
                                // Apply explosion damage to artifacts (on ground, not carried)
                                for (const [chestId, chest] of this.chests) {
                                    if (chest.variant !== 'gold' || !chest.opened || chest.health <= 0) continue;
                                    if (chest.artifactCarriedBy) continue;
                                    
                                    const artX = (chest.artifactPos && Number(chest.artifactPos.x)) || Number(chest.x) || 0;
                                    const artY = (chest.artifactPos && Number(chest.artifactPos.y)) || Number(chest.y) || 0;
                                    const dxa = artX - e.x;
                                    const dya = artY - e.y;
                                    const da = Math.hypot(dxa, dya);
                                    if (da <= blastRadius + 10) { // Artifact radius is 10
                                        const outer = blastRadius;
                                        let ta = (da - inner) / Math.max(1e-6, (outer - inner));
                                        ta = Math.max(0, Math.min(1, ta));
                                        const dmg = 95 - 75 * ta; // Full damage (no armor)
                                        chest.health = Math.max(0, chest.health - dmg);
                                        
                                        // Broadcast health update and hit flash
                                        io.to(this.id).emit('artifactHealthUpdate', {
                                            chestId: chest.id,
                                            health: chest.health,
                                            healthMax: chest.healthMax
                                        });
                                        io.to(this.id).emit('artifactHitFlash', {
                                            chestId: chest.id
                                        });
                                        
                                        // Destroy artifact if health depleted
                                        if (chest.health <= 0) {
                                            console.log(`[Server] Artifact ${chest.id} destroyed by boomer explosion`);
                                            io.to(this.id).emit('artifactDestroyed', { chestId: chest.id });
                                        }
                                    }
                                }
                                
                                // Kill boomer server-side and remove from map
                                e.alive = false;
                                this.enemies.delete(e.id);
                                // Continue to next enemy
                                continue;
                            }
                        }
                    }
                    if (e.type !== 'projectile') continue; // only ranged variant
                    // Initialize server-side fire timers and burst state
                    if (typeof e._svFireCooldown !== 'number') e._svFireCooldown = 0;
                    if (typeof e._burstShotsRemaining !== 'number') e._burstShotsRemaining = 0;
                    e._svFireCooldown -= deltaTime;
                    
                    // Check if being targeted by any turret
                    let beingTargetedByTurret = false;
                    for (const [, ability] of this.abilities) {
                        if (ability.type !== 'AutoTurret') continue;
                        if (ability.health <= 0) continue;
                        
                        const turretDist = Math.hypot((ability.x || 0) - e.x, (ability.y || 0) - e.y);
                        // If within turret's targeting radius, we're being shot at
                        if (turretDist <= (ability.targetingRadius || 210)) {
                            beingTargetedByTurret = true;
                            break;
                        }
                    }
                    
                    // Find best target with randomization (30% chance to target chest/artifact)
                    let targetX = Number(playerRef.x) || 0;
                    let targetY = Number(playerRef.y) || 0;
                    let targetDist = Math.hypot(targetX - e.x, targetY - e.y) || 1;
                    let targetPriority = 0; // 0=player, 1=turret, 2=artifact, 3=gold chest
                    
                    // If NOT being shot by a turret, check for priority targets
                    if (!beingTargetedByTurret) {
                        // Find closest gold chest candidate (30% chance to actually target it)
                        let chestCandidate = null;
                        let chestCandidateDist = Infinity;
                        for (const [, chest] of this.chests) {
                            if (chest.variant !== 'gold' || chest.opened || chest.health <= 0) continue;
                            
                            const chestDist = Math.hypot((chest.x || 0) - e.x, (chest.y || 0) - e.y);
                            if (chestDist >= 200 && chestDist <= 900 && chestDist < chestCandidateDist) {
                                chestCandidateDist = chestDist;
                                chestCandidate = chest;
                            }
                        }
                        
                        // Initialize decision timer for projectile enemies (prevents wobbling)
                        if (e._targetDecisionTimer === undefined) {
                            e._targetDecisionTimer = 0;
                            e._lastTargetDecision = Math.random() < 0.3 ? 'objective' : 'player';
                        }
                        
                        // Decrement timer
                        e._targetDecisionTimer -= deltaTime;
                        
                        // Only make new decision if timer expired (every 3-7 seconds)
                        if (e._targetDecisionTimer <= 0) {
                            e._lastTargetDecision = Math.random() < 0.3 ? 'objective' : 'player';
                            e._targetDecisionTimer = 3 + Math.random() * 4; // Reset to 3-7 seconds
                        }
                        
                        // Apply stored decision for chest
                        if (chestCandidate && e._lastTargetDecision === 'objective') {
                            targetX = chestCandidate.x;
                            targetY = chestCandidate.y;
                            targetDist = chestCandidateDist;
                            targetPriority = 3;
                        }
                        
                        // Find closest artifact candidate (uses same decision as chest)
                        let artifactCandidate = null;
                        let artifactCandidateDist = Infinity;
                        let artifactCandidatePos = null;
                        for (const [, chest] of this.chests) {
                            if (chest.variant !== 'gold' || !chest.opened || chest.artifactCarriedBy || chest.health <= 0) continue;
                            
                            const artX = (chest.artifactPos && Number(chest.artifactPos.x)) || Number(chest.x) || 0;
                            const artY = (chest.artifactPos && Number(chest.artifactPos.y)) || Number(chest.y) || 0;
                            const artifactDist = Math.hypot(artX - e.x, artY - e.y);
                            if (artifactDist >= 200 && artifactDist <= 900 && artifactDist < artifactCandidateDist) {
                                artifactCandidateDist = artifactDist;
                                artifactCandidate = chest;
                                artifactCandidatePos = { x: artX, y: artY };
                            }
                        }
                        
                        // Apply stored decision for artifact (if no chest selected)
                        if (artifactCandidate && artifactCandidatePos && targetPriority < 2 && e._lastTargetDecision === 'objective') {
                            targetX = artifactCandidatePos.x;
                            targetY = artifactCandidatePos.y;
                            targetDist = artifactCandidateDist;
                            targetPriority = 2;
                        }
                        
                        // Check for turrets (always consider if closer)
                        for (const [, ability] of this.abilities) {
                            if (ability.type !== 'AutoTurret') continue;
                            if (ability.health <= 0) continue;
                            
                            const turretDist = Math.hypot((ability.x || 0) - e.x, (ability.y || 0) - e.y);
                            // Target turret if in range and closer than current target
                            if (turretDist >= 200 && turretDist <= 900) {
                                if (targetPriority < 1 || (targetPriority === 1 && turretDist < targetDist)) {
                                    targetX = ability.x;
                                    targetY = ability.y;
                                    targetDist = turretDist;
                                    targetPriority = 1;
                                }
                            }
                        }
                        
                        // Check troops as fallback targets (very low priority, only if no better target)
                        // Troops are priority -1 (lower than players at 0)
                        if (this.troopManager && this.troopManager.troops && targetPriority === 0) {
                            // Only consider troops if player is far away (> 600 units)
                            if (targetDist > 600) {
                                for (const [, troop] of this.troopManager.troops) {
                                    if (!troop || !troop.alive) continue;
                                    if (troop.health <= 0) continue;
                                    
                                    const troopDist = Math.hypot((troop.x || 0) - e.x, (troop.y || 0) - e.y);
                                    // Target troop if in firing range and closer than current player target
                                    if (troopDist >= 200 && troopDist <= 900 && troopDist < targetDist) {
                                        targetX = troop.x;
                                        targetY = troop.y;
                                        targetDist = troopDist;
                                        targetPriority = -1; // Lower priority than players
                                    }
                                }
                            }
                        }
                    }
                    // If being shot by turret, stick with player target (already set above, priority = 0)
                    
                    const dx = targetX - e.x;
                    const dy = targetY - e.y;
                    const dist = targetDist;
                    let wantFire = dist >= 200 && dist <= 900;
                    if (wantFire && this.environment && typeof this.environment.lineHitsAny === 'function') {
                        const losBlocked = this.environment.lineHitsAny(e.x, e.y, targetX, targetY);
                        if (losBlocked) wantFire = false;
                    }
                    if (!wantFire || e._svFireCooldown > 0) continue;
                    // Compute projectile
                    const ang = Math.atan2(dy, dx);
                    const base = 80; // matches client base 80
                    const spd = 2 * base * (dir.speedByMode?.[dir.mode] ?? 1) * (Number.isFinite(e.speedMul) ? e.speedMul : 1);
                    const vx = Math.cos(ang) * spd;
                    const vy = Math.sin(ang) * spd;
                    const r = 6;
                    const life = 6.0;
                    const color = '#7adf7a';
                    const sx = e.x + Math.cos(ang) * ((e.radius || 26) + r + 2);
                    const sy = e.y + Math.sin(ang) * ((e.radius || 26) + r + 2);
                    const damage = 7 + Math.random() * 7; // 7-14 damage
                    // Broadcast to all players in room
                    io.to(this.id).emit('enemyProjectileFired', {
                        enemyId: e.id,
                        x: sx,
                        y: sy,
                        vx,
                        vy,
                        radius: r,
                        color,
                        life,
                        angle: ang,
                        damage: damage
                    });
                    // Track projectile server-side for collision detection
                    this.enemyProjectiles.push({ x: sx, y: sy, vx, vy, radius: r, damage: damage, life, maxLife: life });
                    
                    // Varied firing patterns: bursts, gaps, or steady fire (~30% reduced fire rate)
                    if (e._burstShotsRemaining > 0) {
                        // In a burst: fire with moderate delay
                        e._burstShotsRemaining--;
                        e._svFireCooldown = 0.45 + Math.random() * 0.25; // 0.45-0.70s between burst shots
                    } else {
                        // Choose next firing pattern
                        const patternRoll = Math.random();
                        if (patternRoll < 0.2) {
                            // 20% chance: Start a burst (2-3 shots, capped at 3)
                            e._burstShotsRemaining = 1 + Math.floor(Math.random() * 2); // 1-2 more shots (2-3 total)
                            e._svFireCooldown = 0.45 + Math.random() * 0.25; // Next shot delay
                        } else if (patternRoll < 0.5) {
                            // 30% chance: Long gap (2.5-5 seconds)
                            e._svFireCooldown = 2.5 + Math.random() * 2.5;
                        } else {
                            // 50% chance: Steady fire (1.7-2.8s)
                            e._svFireCooldown = 1.7 + Math.random() * 1.1;
                        }
                    }
                }
                
                // Server-authoritative melee contact damage for non-licker enemies
                if (playerRef && playerRef.health > 0) {
                    const pr = playerRef.radius || 26;
                    const px = Number(playerRef.x) || 0;
                    const py = Number(playerRef.y) || 0;
                    let contactDamage = 0;
                    
                    // DEBUG:GhostEnemy - Track which enemies deal contact damage (remove after fixing)
                    const _debugContactEnemies = [];
                    for (let i = 0; i < arr.length; i++) {
                        const wrapped = arr[i];
                        const enemy = wrapped && wrapped._ref;
                        if (!enemy || enemy.alive === false) continue;
                        if (enemy.type === 'licker' || enemy._contactDisabled === true) continue;
                        const er = Number.isFinite(enemy.radius) ? enemy.radius : 26;
                        const sumR = er + pr;
                        const dx = px - (Number(enemy.x) || 0);
                        const dy = py - (Number(enemy.y) || 0);
                        if (dx * dx + dy * dy <= sumR * sumR) {
                            contactDamage += 10 * deltaTime;
                            // DEBUG:GhostEnemy - Log enemy causing contact damage
                            _debugContactEnemies.push({ id: enemy.id, type: enemy.type, x: enemy.x, y: enemy.y, hp: enemy.health });
                        }
                    }

                    if (contactDamage > 0 && playerRef.invincible !== true) {
                        // Apply armor reduction (cap at 75%)
                        const armorPercent = Number.isFinite(playerRef.armor) ? playerRef.armor : 0;
                        const reduction = Math.min(0.75, armorPercent / 100);
                        const appliedDamage = contactDamage * (1 - reduction);

                        if (appliedDamage > 0.0001) {
                            const healthBefore = playerRef.health;
                            playerRef.health = Math.max(0, (playerRef.health || 0) - appliedDamage);
                            // DEBUG:GhostEnemy - Include enemy IDs in the health update for client-side tracking
                            const debugEnemyIds = _debugContactEnemies.map(e => e.id);
                            try { playerRef.socket.emit('playerHealth', { health: playerRef.health, from: 'contact', _debugEnemyIds: debugEnemyIds }); } catch (_) {}
                            io.to(this.id).emit('playerHealthUpdate', { playerId: playerRef.id, health: playerRef.health, from: 'contact', _debugEnemyIds: debugEnemyIds });
                            // DEBUG:GhostEnemy - Rate-limited contact damage log (once per 2s per player)
                            if (!this._lastContactDamageLog) this._lastContactDamageLog = {};
                            const nowLog = Date.now();
                            if (!this._lastContactDamageLog[playerRef.id] || nowLog - this._lastContactDamageLog[playerRef.id] > 2000) {
                                this._lastContactDamageLog[playerRef.id] = nowLog;
                                // console.log(`[DEBUG:GhostEnemy] Contact damage to player ${playerRef.id} at (${px.toFixed(0)},${py.toFixed(0)}) from enemies:`, JSON.stringify(_debugContactEnemies));
                            }
                            
                            // Check for death
                            if (playerRef.health <= 0 && healthBefore > 0) {
                                this._handlePlayerDeath(playerRef.id, playerRef, io);
                            }
                        }
                    }
                    
                    // Note: Basic zombie slow is now calculated in real-time during updatePlayerMovement
                    // to avoid 1-frame delay and ensure immediate responsiveness
                }
                // Server-authoritative melee contact damage to turrets (all enemies except Lickers)
                for (const [abilityId, ability] of this.abilities) {
                    if (ability.type !== 'AutoTurret') continue;
                    if (ability.health <= 0) continue;
                    
                    const turretX = Number(ability.x) || 0;
                    const turretY = Number(ability.y) || 0;
                    const turretRadius = ability.radius || 25;
                    let turretDamage = 0;
                    
                    for (let i = 0; i < arr.length; i++) {
                        const wrapped = arr[i];
                        const enemy = wrapped && wrapped._ref;
                        if (!enemy || enemy.alive === false) continue;
                        // Lickers ignore turrets, all other enemies attack them
                        if (enemy.type === 'licker' || enemy._contactDisabled === true) continue;
                        
                        const er = Number.isFinite(enemy.radius) ? enemy.radius : 26;
                        const sumR = er + turretRadius;
                        const dx = turretX - (Number(enemy.x) || 0);
                        const dy = turretY - (Number(enemy.y) || 0);
                        if (dx * dx + dy * dy <= sumR * sumR) {
                            turretDamage += 10 * deltaTime; // Same damage rate as to players
                        }
                    }
                    
                    if (turretDamage > 0) {
                        ability.health = Math.max(0, ability.health - turretDamage);
                        
                        // Broadcast health update
                        io.to(this.id).emit('abilityHealthUpdate', {
                            serverId: abilityId,
                            health: ability.health,
                            healthMax: ability.healthMax
                        });
                        
                        // Destroy turret if health depleted
                        if (ability.health <= 0) {
                            io.to(this.id).emit('abilityTriggered', {
                                serverId: abilityId,
                                type: 'AutoTurret',
                                event: 'death'
                            });
                            this.abilities.delete(abilityId);
                            console.log(`[Server] AutoTurret ${abilityId} destroyed by enemy contact`);
                        }
                    }
                }
                
                // Server-authoritative melee contact damage to gold chests (all enemies except Lickers)
                // NOTE: Must check ALL enemies, not just those in Director groups, since chest-targeting enemies bypass Director
                for (const [chestId, chest] of this.chests) {
                    // Only gold chests can be damaged, and only when not opened or has positive health
                    if (chest.variant !== 'gold' || chest.health <= 0) continue;
                    
                    // Check if chest is vulnerable (only during waves or once activated)
                    if (this.currentGameMode?.isChestVulnerable && !this.currentGameMode.isChestVulnerable(chest)) continue;
                    
                    const chestX = Number(chest.x) || 0;
                    const chestY = Number(chest.y) || 0;
                    const chestRadius = chest.radius || 20;
                    let chestDamage = 0;
                    
                    // Check ALL enemies (not just Director groups) since chest-targeting enemies don't use Director
                    for (const [, enemy] of this.enemies) {
                        if (!enemy || enemy.alive === false) continue;
                        // Lickers ignore chests, all other enemies attack them
                        if (enemy.type === 'licker' || enemy._contactDisabled === true) continue;
                        
                        const er = Number.isFinite(enemy.radius) ? enemy.radius : 26;
                        const sumR = er + chestRadius;
                        const dx = chestX - (Number(enemy.x) || 0);
                        const dy = chestY - (Number(enemy.y) || 0);
                        if (dx * dx + dy * dy <= sumR * sumR) {
                            chestDamage += 10 * deltaTime; // Same damage rate as to turrets/players
                        }
                    }
                    
                    if (chestDamage > 0) {
                        chest.health = Math.max(0, chest.health - chestDamage);
                        
                        // Broadcast health update and hit flash
                        io.to(this.id).emit('chestHealthUpdate', {
                            chestId: chest.id,
                            health: chest.health,
                            healthMax: chest.healthMax
                        });
                        io.to(this.id).emit('chestHitFlash', {
                            chestId: chest.id
                        });
                        
                        // Auto-open chest if health depleted (same behavior as when player shoots it to 0 HP)
                        if (chest.health <= 0 && !chest.opened) {
                            chest.opening = false;
                            chest.opened = true;
                            // Artifact drop descriptor (clients handle physics)
                            io.to(this.id).emit('chestOpened', { 
                                id: chest.id, 
                                x: chest.x, 
                                y: chest.y, 
                                variant: chest.variant, 
                                artifact: { vx: 160, vy: -220 },
                                health: chest.health,
                                healthMax: chest.healthMax
                            });
                            // Track artifact state on server
                            chest.artifactCarriedBy = null;
                            chest.artifactPos = { x: chest.x, y: chest.y };
                        }
                    }
                }
                // Server-authoritative melee contact damage to artifacts (all enemies except Lickers)
                // NOTE: Must check ALL enemies, not just those in Director groups, since artifact-targeting enemies bypass Director
                // Only damage artifacts when they're on the ground (not carried)
                for (const [chestId, chest] of this.chests) {
                    if (chest.variant !== 'gold' || !chest.opened || chest.health <= 0) continue;
                    if (chest.artifactCarriedBy) continue; // Skip if artifact is being carried
                    
                    // Artifact position (server tracks it or uses chest position as fallback)
                    const artX = (chest.artifactPos && Number(chest.artifactPos.x)) || Number(chest.x) || 0;
                    const artY = (chest.artifactPos && Number(chest.artifactPos.y)) || Number(chest.y) || 0;
                    const artRadius = 10; // Artifact radius
                    let artifactDamage = 0;
                    
                    // Check ALL enemies (not just Director groups) since artifact-targeting enemies don't use Director
                    for (const [, enemy] of this.enemies) {
                        if (!enemy || enemy.alive === false) continue;
                        // Lickers ignore artifacts, all other enemies attack them
                        if (enemy.type === 'licker' || enemy._contactDisabled === true) continue;
                        
                        const er = Number.isFinite(enemy.radius) ? enemy.radius : 26;
                        const sumR = er + artRadius;
                        const dx = artX - (Number(enemy.x) || 0);
                        const dy = artY - (Number(enemy.y) || 0);
                        if (dx * dx + dy * dy <= sumR * sumR) {
                            artifactDamage += 10 * deltaTime; // Same damage rate
                        }
                    }
                    
                    if (artifactDamage > 0) {
                        chest.health = Math.max(0, chest.health - artifactDamage);
                        
                        // Broadcast health update and hit flash
                        io.to(this.id).emit('artifactHealthUpdate', {
                            chestId: chest.id,
                            health: chest.health,
                            healthMax: chest.healthMax
                        });
                        io.to(this.id).emit('artifactHitFlash', {
                            chestId: chest.id
                        });
                        
                        // Destroy artifact if health depleted
                        if (chest.health <= 0) {
                            console.log(`[Server] Artifact ${chest.id} destroyed by enemy contact`);
                            io.to(this.id).emit('artifactDestroyed', { chestId: chest.id });
                        }
                    }
                }
                
                // Server-authoritative melee contact damage to troops (all enemies except Lickers)
                // NOTE: Must check ALL enemies, not just those in Director groups
                if (this.troopManager && this.troopManager.troops) {
                    // Initialize rate limiter and accumulator for troop damage broadcasts
                    if (!this._troopDamageNumberCooldown) this._troopDamageNumberCooldown = new Map();
                    if (!this._troopDamageAccumulator) this._troopDamageAccumulator = new Map();
                    
                    const now = Date.now();
                    const damageNumberInterval = 500; // Show damage numbers every 0.5 seconds
                    
                    for (const [, troop] of this.troopManager.troops) {
                        if (!troop || !troop.alive) continue;
                        if (troop.health <= 0) continue;
                        
                        const troopX = Number(troop.x) || 0;
                        const troopY = Number(troop.y) || 0;
                        const troopRadius = troop.radius || 22;
                        let troopDamage = 0;
                        
                        // Check ALL enemies (not just Director groups)
                        for (const [, enemy] of this.enemies) {
                            if (!enemy || enemy.alive === false) continue;
                            // Lickers ignore troops, all other enemies attack them
                            if (enemy.type === 'licker' || enemy._contactDisabled === true) continue;
                            
                            const er = Number.isFinite(enemy.radius) ? enemy.radius : 26;
                            const sumR = er + troopRadius;
                            const dx = troopX - (Number(enemy.x) || 0);
                            const dy = troopY - (Number(enemy.y) || 0);
                            if (dx * dx + dy * dy <= sumR * sumR) {
                                troopDamage += 10 * deltaTime; // Same damage rate as to players/turrets
                            }
                        }
                        
                        if (troopDamage > 0) {
                            const oldHealth = troop.health;
                            troop.health = Math.max(0, troop.health - troopDamage);
                            
                            // Accumulate damage for visual feedback
                            const currentAccumulated = this._troopDamageAccumulator.get(troop.id) || 0;
                            this._troopDamageAccumulator.set(troop.id, currentAccumulated + troopDamage);
                            
                            // Rate-limit damage number broadcasts (every 0.5s) to match player damage feedback
                            const lastBroadcast = this._troopDamageNumberCooldown.get(troop.id) || 0;
                            const shouldBroadcast = (now - lastBroadcast) >= damageNumberInterval;
                            
                            if (shouldBroadcast) {
                                const accumulatedDamage = this._troopDamageAccumulator.get(troop.id) || troopDamage;
                                const damageInt = Math.round(accumulatedDamage);
                                // Only broadcast once rounding would show at least 1 (prevents "-0" on first tiny contact)
                                if (damageInt >= 1) {
                                    // Broadcast integer damage for visual feedback (damage numbers, health bars)
                                    io.to(this.id).emit('troopDamaged', {
                                        troopId: troop.id,
                                        damage: damageInt,
                                        health: troop.health,
                                        healthMax: troop.healthMax,
                                        x: troop.x,
                                        y: troop.y
                                    });
                                    
                                    // Reset accumulator and update cooldown timer (only when we actually emit)
                                    this._troopDamageAccumulator.set(troop.id, 0);
                                    this._troopDamageNumberCooldown.set(troop.id, now);
                                }
                            }
                            
                        // Check if troop died
                        if (troop.health <= 0) {
                            troop.alive = false;
                            // console.log(`[Server] Troop ${troop.id} killed by enemy contact`);
                            
                            // Broadcast troop death (always, regardless of rate limit)
                            io.to(this.id).emit('troopDeath', {
                                troopId: troop.id,
                                    x: troop.x,
                                    y: troop.y
                                });
                            io.to(this.id).emit('entity_dead', {
                                entityType: 'troop',
                                id: troop.id,
                                x: troop.x,
                                y: troop.y,
                                kind: troop.type || 'troop',
                                cause: 'enemy_contact'
                            });
                                
                                // Clean up cooldown and accumulator entries for dead troop
                                this._troopDamageNumberCooldown.delete(troop.id);
                                this._troopDamageAccumulator.delete(troop.id);
                            }
                        }
                    }
                }
                
                // Licker tentacle attack logic (server-authoritative)
                for (let i = 0; i < arr.length; i++) {
                    const w = arr[i];
                    const e = w && w._ref; if (!e) continue;
                    if (e.type !== 'licker' || e.alive === false) continue;
                    
                    // Initialize tentacle state
                    if (!e._tentacleState) {
                        e._tentacleState = 'idle';
                        e._tentacleCooldown = 0;
                        e._tentacleTime = 0;
                        e._tentacleRange = 300;
                        e._tentacleWindupBonus = 50;
                        e._aimAngle = 0;
                        e._attached = false;
                        e._attachTime = 0;
                        e._ensnareDuration = 3.0;
                    }
                    
                    e._tentacleCooldown = Math.max(0, e._tentacleCooldown - deltaTime);
                    
                    const px = Number(playerRef.x) || 0;
                    const py = Number(playerRef.y) || 0;
                    const dx = px - e.x;
                    const dy = py - e.y;
                    const dist = Math.hypot(dx, dy) || 1;
                    const pr = playerRef.radius || 26;
                    
                    // Don't target/attack dead or invisible players
                    const playerIsDead = playerRef.health != null && playerRef.health <= 0;
                    const playerIsInvisible = playerRef.invisible === true;
                    const playerInDialogue = playerRef.dialogueOpen === true;
                    const wantAttack = !playerIsDead && !playerIsInvisible && !playerInDialogue && dist <= (e._tentacleRange + e._tentacleWindupBonus + pr + (e.radius || 26));
                    
                    // State machine for tentacle attack
                    if (e._tentacleState === 'attached') {
                        // Check if player still has ensnare timer AND is alive
                        let attachedNow = false;
                        try {
                            const tThis = (playerRef._ensnaredBy && playerRef._ensnaredBy.get) ? (playerRef._ensnaredBy.get(e.id) || 0) : 0;
                            attachedNow = tThis > 0 && e._attached && !playerIsDead;
                        } catch(_) {}
                        e._attached = attachedNow;
                        
                        if (attachedNow) {
                            e._aimAngle = Math.atan2(dy, dx);
                            
                            // Tug-of-war mechanics: rope constraint and player pull
                            try {
                                // 1. Rope constraint: if player moved beyond tentacle length, pull Licker toward player
                                const pr = playerRef.radius || 26;
                                const maxCenterDist = pr + (e._tentacleRange || 300) - 1;
                                if (dist > maxCenterDist) {
                                    const excess = dist - maxCenterDist;
                                    const inv = dist > 0 ? (1 / dist) : 0;
                                    const ux = dx * inv; // toward player
                                    const uy = dy * inv; // toward player
                                    
                                    // Move Licker toward player (rope drag)
                                    const moveAmount = excess * 0.12; // damping factor
                                    const newX = e.x + ux * moveAmount;
                                    const newY = e.y + uy * moveAmount;
                                    
                                    // Use environment collision resolution if available
                                    if (this.environment && typeof this.environment.resolveCircleMove === 'function') {
                                        const resolved = this.environment.resolveCircleMove(e.x, e.y, e.radius || 26, ux * moveAmount, uy * moveAmount);
                                        e.x = resolved.x;
                                        e.y = resolved.y;
                                    } else {
                                        // Fallback: direct movement with boundary enforcement
                                        e.x = Math.max(-this.boundary, Math.min(this.boundary, newX));
                                        e.y = Math.max(-this.boundary, Math.min(this.boundary, newY));
                                    }
                                }
                                
                                // 2. Pull player toward Licker while attached
                                const targetDist = Math.max(10, (e.radius || 26) + (playerRef.radius || 26) + 2);
                                if (dist > targetDist) {
                                    const inv = dist > 0 ? (1 / dist) : 0;
                                    const ux = -dx * inv; // toward Licker
                                    const uy = -dy * inv; // toward Licker
                                    const pullPerSec = 180; // pull speed toward Licker (units/sec)
                                    let step = Math.min(dist - targetDist, pullPerSec * deltaTime);
                                    
                                    // Use environment collision resolution if available
                                    if (this.environment && typeof this.environment.resolveCircleMove === 'function') {
                                        const resolved = this.environment.resolveCircleMove(playerRef.x, playerRef.y, playerRef.radius || 26, ux * step, uy * step);
                                        playerRef.x = resolved.x;
                                        playerRef.y = resolved.y;
                                    } else {
                                        // Fallback: direct movement with boundary enforcement
                                        playerRef.x = Math.max(-this.boundary, Math.min(this.boundary, playerRef.x + ux * step));
                                        playerRef.y = Math.max(-this.boundary, Math.min(this.boundary, playerRef.y + uy * step));
                                    }
                                }
                            } catch(err) {
                                console.error('[Server] Licker tug-of-war error:', err);
                            }
                            
                            // Continue holding - timer managed below
                        } else {
                            e._tentacleState = 'idle';
                            e._tentacleCooldown = Math.max(e._tentacleCooldown, 1.5);
                            e._targetPlayerId = null; // Clear target when detaching
                        }
                    } else if (e._tentacleState === 'idle') {
                        if (wantAttack && e._tentacleCooldown <= 0) {
                            e._tentacleState = 'windup';
                            e._tentacleTime = 0.25;
                            e._aimAngle = Math.atan2(dy, dx);
                            e._targetPlayerId = playerRef.id; // Track which player is being targeted
                        }
                    } else if (e._tentacleState === 'windup') {
                        e._tentacleTime -= deltaTime;
                        if (e._tentacleTime <= 0) {
                            e._tentacleState = 'extend';
                            e._tentacleTime = 0.18;
                            e._aimAngle = Math.atan2(dy, dx);
                            e._targetPlayerId = playerRef.id; // Update target on extend
                        }
                    } else if (e._tentacleState === 'extend') {
                        const total = 0.18;
                        const prev = e._tentacleTime;
                        e._tentacleTime -= deltaTime;
                        const now = e._tentacleTime;
                        const wasPeak = (prev > total * 0.5) && (now <= total * 0.5);
                        
                        if (wasPeak) {
                            // Hit test: segment-circle intersection
                            const ang = e._aimAngle;
                            const reach = e._tentacleRange;
                            const sx = e.x, sy = e.y;
                            const ex = sx + Math.cos(ang) * reach;
                            const ey = sy + Math.sin(ang) * reach;
                            
                            const vx = ex - sx, vy = ey - sy;
                            const wx = px - sx, wy = py - sy;
                            const vlen2 = vx * vx + vy * vy || 1;
                            let t = (wx * vx + wy * vy) / vlen2;
                            if (t < 0) t = 0; else if (t > 1) t = 1;
                            const cx = sx + vx * t, cy = sy + vy * t;
                            const dxp = px - cx, dyp = py - cy;
                            const hit = (dxp * dxp + dyp * dyp) <= pr * pr;
                            
                            // Only ensnare if player is alive
                            if (hit && !playerIsDead) {
                                // Ensnare player for 3 seconds
                                if (!playerRef._ensnaredBy) playerRef._ensnaredBy = new Map();
                                const currentTimer = playerRef._ensnaredBy.get(e.id) || 0;
                                playerRef._ensnaredBy.set(e.id, Math.max(e._ensnareDuration, currentTimer));
                                playerRef._ensnaredTimer = Math.max(playerRef._ensnaredTimer || 0, e._ensnareDuration);
                                playerRef._ensnaredById = e.id;
                                e._attachTime = e._ensnareDuration;
                                e._attached = true;
                                e._tentacleState = 'attached';
                                
                                // Broadcast ensnare event to all clients
                                io.to(this.id).emit('lickerEnsnared', {
                                    enemyId: e.id,
                                    playerId: playerRef.id,
                                    duration: e._ensnareDuration,
                                    x: e.x,
                                    y: e.y
                                });
                            }
                        }
                        
                        if (e._tentacleTime <= 0 && !e._attached) {
                            e._tentacleState = 'recover';
                            e._tentacleTime = 0.35;
                            e._tentacleCooldown = 2.0;
                        }
                    } else if (e._tentacleState === 'recover') {
                        e._tentacleTime -= deltaTime;
                        if (e._tentacleTime <= 0) e._tentacleState = 'idle';
                    }
                    
                    // Update player ensnare timers and apply damage
                    if (playerRef._ensnaredBy && playerRef._ensnaredBy.has(e.id)) {
                        const timer = playerRef._ensnaredBy.get(e.id);
                        const newTimer = timer - deltaTime;
                        if (newTimer <= 0) {
                            playerRef._ensnaredBy.delete(e.id);
                            if (e._attached) {
                                e._attached = false;
                                e._tentacleState = 'idle';
                                e._tentacleCooldown = Math.max(e._tentacleCooldown, 1.5);
                            }
                        } else {
                            playerRef._ensnaredBy.set(e.id, newTimer);
                            // Apply ensnare damage: 10 HP/sec while ensnared AND within damage range
                            // Original game uses player.radius + 75 for Licker damage range
                            const damageRange = pr + 75;
                            if (dist <= damageRange && playerRef.invincible !== true) {
                                const healthBefore = playerRef.health;
                                const rawDmg = 10 * deltaTime;
                                // Apply armor reduction (cap at 75%)
                                const armorPercent = Number.isFinite(playerRef.armor) ? playerRef.armor : 0;
                                const reduction = Math.min(0.75, armorPercent / 100);
                                const dmg = rawDmg * (1 - reduction);
                                playerRef.health = Math.max(0, (playerRef.health || 0) - dmg);
                                
                                // Check for death
                                if (playerRef.health <= 0 && healthBefore > 0) {
                                    this._handlePlayerDeath(playerRef.id, playerRef, io);
                                }
                            }
                        }
                    }
                }
                
                // After processing all Lickers for this player, recalculate aggregate ensnare timer
                let maxEnsnareTimer = 0;
                let primaryEnsnarerId = null;
                if (playerRef._ensnaredBy && playerRef._ensnaredBy.size > 0) {
                    for (const [eid, timer] of playerRef._ensnaredBy) {
                        if (timer > maxEnsnareTimer) {
                            maxEnsnareTimer = timer;
                            primaryEnsnarerId = eid;
                        }
                    }
                }
                playerRef._ensnaredTimer = maxEnsnareTimer;
                playerRef._ensnaredById = primaryEnsnarerId;
            }
            // Update enemy projectiles and check collisions with players
            for (let i = this.enemyProjectiles.length - 1; i >= 0; i--) {
                const proj = this.enemyProjectiles[i];
                if (!proj) continue;
                
                // Apply homing behavior for artillery projectiles
                if (proj.type === 'artillery' && proj.targetX != null && proj.targetY != null && proj.maxTurnRate) {
                    const dx = proj.targetX - proj.x;
                    const dy = proj.targetY - proj.y;
                    const dist = Math.hypot(dx, dy);
                    if (dist > 1) {
                        const ux = dx / dist;
                        const uy = dy / dist;
                        const currentAngle = Math.atan2(proj.vy, proj.vx);
                        const targetAngle = Math.atan2(uy, ux);
                        let angleDiff = targetAngle - currentAngle;
                        // Normalize angle difference to [-PI, PI]
                        while (angleDiff > Math.PI) angleDiff -= 2 * Math.PI;
                        while (angleDiff < -Math.PI) angleDiff += 2 * Math.PI;
                        // Apply perpendicular bias
                        const biasAngle = (proj.bias || 0) * deltaTime;
                        angleDiff += biasAngle;
                        // Clamp turn rate
                        const maxTurn = (proj.maxTurnRate || 0) * deltaTime;
                        if (angleDiff > maxTurn) angleDiff = maxTurn;
                        else if (angleDiff < -maxTurn) angleDiff = -maxTurn;
                        // Apply turn
                        const newAngle = currentAngle + angleDiff;
                        const speed = Math.hypot(proj.vx, proj.vy);
                        proj.vx = Math.cos(newAngle) * speed;
                        proj.vy = Math.sin(newAngle) * speed;
                    }
                }
                // Update position (track previous for hazard line hits)
                const oldX = proj.x;
                const oldY = proj.y;
                proj.x += proj.vx * deltaTime;
                proj.y += proj.vy * deltaTime;
                proj.life -= deltaTime;
                // Sandbag and barrel collision by projectile line segment
                try {
                    if (this.hazards && typeof this.hazards.damageFromBulletLine === 'function') {
                        this.hazards.damageFromBulletLine(oldX, oldY, proj.x, proj.y, proj.damage || 10);
                    }
                    if (this.hazards && typeof this.hazards.damageBarrelFromBulletLine === 'function') {
                        this.hazards.damageBarrelFromBulletLine(oldX, oldY, proj.x, proj.y, proj.damage || 10);
                    }
                } catch(_) {}
                
                // Handle explosion projectiles (artillery strikes, fast balls, and artillery guns)
                if (proj.life <= 0 && (proj.type === 'artillery' || proj.type === 'fastball' || proj.type === 'artilleryGun')) {
                    // Explosion damage with falloff
                    const explosionX = proj.x;
                    const explosionY = proj.y;
                    const blastRadius = proj.type === 'artilleryGun' ? 180 : 100;  // 50% bigger blast for artillery gun (was 120)
                    const innerRadius = 20;
                    const isArtilleryGun = proj.type === 'artilleryGun';
                    const letterMinX = (isArtilleryGun && Number.isFinite(proj.zoneMinX)) ? proj.zoneMinX : -10200;
                    const letterMaxX = (isArtilleryGun && Number.isFinite(proj.zoneMaxX)) ? proj.zoneMaxX : 10200;
                    const letterMinY = (isArtilleryGun && Number.isFinite(proj.zoneMinY)) ? proj.zoneMinY : -Infinity;
                    const letterMaxY = (isArtilleryGun && Number.isFinite(proj.zoneMaxY)) ? proj.zoneMaxY : Infinity;
                    
                    // DEBUG: Log explosion position vs target for artillery gun
                    if (isArtilleryGun && proj.targetX != null && proj.targetY != null) {
                        // const targetDx = explosionX - proj.targetX;
                        // const targetDy = explosionY - proj.targetY;
                        // const divergence = Math.hypot(targetDx, targetDy);
                        // console.log(`[ArtilleryGun DEBUG] EXPLOSION at (${explosionX.toFixed(1)}, ${explosionY.toFixed(1)}) | Target was (${proj.targetX.toFixed(1)}, ${proj.targetY.toFixed(1)}) | DIVERGENCE: ${divergence.toFixed(1)} units`);
                    }
                    
                    // Damage all players in blast radius
                    // Rule: New Antioch artillery (artilleryGun) CAN hurt players, but only in letter zones (A-F),
                    // and only for 10% damage. Never hurt players in safe zones (New Antioch / Heretic).
                    for (const [, p] of this.players) {
                        if (!p || p.health <= 0) continue;
                        if (p.invincible === true) continue;

                        const px = (p.x || 0);
                        const py = (p.y || 0);

                        // Safe zones are excluded for artilleryGun friendly fire
                        if (isArtilleryGun) {
                            if (px < letterMinX || px >= letterMaxX || py < letterMinY || py > letterMaxY) continue;
                        }
                        
                        const dx = px - explosionX;
                        const dy = py - explosionY;
                        const dist = Math.hypot(dx, dy);
                        const effectiveRadius = blastRadius + (p.radius || 26);
                        
                        if (dist <= effectiveRadius) {
                            let t = (dist - innerRadius) / Math.max(1e-6, blastRadius - innerRadius);
                            t = Math.max(0, Math.min(1, t));

                            // Default enemy artillery: 65 at center, 15 at edge
                            // New Antioch artillery gun: use 70->20 curve, but only 10% of it to players
                            const rawDmg = isArtilleryGun ? ((70 - 50 * t) * 0.10) : (65 - 50 * t);
                            
                            // Apply armor reduction (cap at 75%)
                            const armorPercent = Number.isFinite(p.armor) ? p.armor : 0;
                            const reduction = Math.min(0.75, armorPercent / 100);
                            const dmg = rawDmg * (1 - reduction);
                            p.health = Math.max(0, (p.health || 0) - dmg);
                            
                            // Broadcast health update
                            const source = isArtilleryGun ? 'artilleryGunExplosion' : 'artilleryExplosion';
                            try { p.socket.emit('playerHealth', { health: p.health, from: source }); } catch(_) {}
                            io.to(this.id).emit('playerHealthUpdate', { playerId: p.id, health: p.health });
                        }
                    }
                    
                    // Artillery Gun: Damage enemies in blast radius
                    if (isArtilleryGun) {
                        const enemiesToDelete = [];  // Collect deaths to process after iteration
                        for (const [enemyId, enemy] of this.enemies) {
                            if (!enemy || enemy.alive === false) continue;
                            if (enemy.type === 'defenseTurret') continue;  // Don't hit friendly turrets
                            if (enemy.type === 'artilleryGun') continue;  // Don't hit friendly artillery
                            
                            const dx = (enemy.x || 0) - explosionX;
                            const dy = (enemy.y || 0) - explosionY;
                            const dist = Math.hypot(dx, dy);
                            const effectiveRadius = blastRadius + (enemy.radius || 26);
                            
                            if (dist <= effectiveRadius) {
                                // Calculate falloff damage (70 at center, 20 at edge)
                                let t = (dist - innerRadius) / Math.max(1e-6, blastRadius - innerRadius);
                                t = Math.max(0, Math.min(1, t));
                                const dmg = 70 - 50 * t;
                                
                                enemy.health = Math.max(0, (enemy.health || 0) - dmg);
                                
                                // Broadcast damage
                                io.to(this.id).emit('enemyHealthUpdate', {
                                    id: enemyId,
                                    health: enemy.health,
                                    healthMax: enemy.healthMax
                                });
                                
                                // Mark for death (don't delete during iteration)
                                if (enemy.health <= 0) {
                                    enemy.alive = false;
                                    enemiesToDelete.push({ id: enemyId, x: enemy.x, y: enemy.y, type: enemy.type });
                                }
                            }
                        }
                        // Now safely delete dead enemies after iteration
                        for (const deadEnemy of enemiesToDelete) {
                            // Clear licker ensnare if applicable
                            this._clearLickerEnsnareOnDeath(deadEnemy.id, deadEnemy.type);
                            this.enemies.delete(deadEnemy.id);
                            io.to(this.id).emit('enemyDied', { id: deadEnemy.id, x: deadEnemy.x, y: deadEnemy.y, type: deadEnemy.type });
                            io.to(this.id).emit('entity_dead', {
                                entityType: 'enemy',
                                id: deadEnemy.id,
                                x: deadEnemy.x,
                                y: deadEnemy.y,
                                kind: deadEnemy.type
                            });
                        }
                    }
                    
                    // Damage troops in blast radius (both enemy projectiles and artillery)
                    // Artillery guns are friendly, enemy projectiles are hostile
                    if (this.troopManager && this.troopManager.troops) {
                        for (const [, troop] of this.troopManager.troops) {
                            if (!troop || !troop.alive || troop.health <= 0) continue;
                            
                            const troopX = Number(troop.x) || 0;
                            const troopY = Number(troop.y) || 0;
                            const troopRadius = troop.radius || 22;
                            
                            // Safe zones are excluded for artilleryGun friendly fire
                            if (isArtilleryGun) {
                                if (troopX < letterMinX || troopX >= letterMaxX || troopY < letterMinY || troopY > letterMaxY) continue;
                            }
                            
                            const dx = troopX - explosionX;
                            const dy = troopY - explosionY;
                            const dist = Math.hypot(dx, dy);
                            const effectiveRadius = blastRadius + troopRadius;
                            
                            if (dist <= effectiveRadius) {
                                // Calculate falloff damage (artillery: 70-20, enemy: 65-15)
                                let t = (dist - innerRadius) / Math.max(1e-6, blastRadius - innerRadius);
                                t = Math.max(0, Math.min(1, t));
                                const dmg = isArtilleryGun ? (70 - 50 * t) : (65 - 50 * t);
                                
                                troop.health = Math.max(0, troop.health - dmg);
                                
                                // Broadcast troop damage
                                io.to(this.id).emit('troopDamaged', {
                                    troopId: troop.id,
                                    // Send already-rounded integer damage for UI text (avoid "-0")
                                    damage: Math.max(1, Math.round(dmg)),
                                    health: troop.health,
                                    healthMax: troop.healthMax,
                                    x: troopX,
                                    y: troopY
                                });
                                
                                // Check if troop died
                                if (troop.health <= 0) {
                                    troop.alive = false;
                                    const source = isArtilleryGun ? 'artillery' : 'enemy_projectile';
                                    console.log(`[Server] Troop ${troop.id} killed by ${source} explosion`);
                                    
                                    // Broadcast troop death
                                    io.to(this.id).emit('troopDeath', {
                                        troopId: troop.id,
                                        x: troopX,
                                        y: troopY
                                    });
                                    io.to(this.id).emit('entity_dead', {
                                        entityType: 'troop',
                                        id: troop.id,
                                        x: troopX,
                                        y: troopY,
                                        kind: troop.type || 'troop'
                                    });
                                }
                            }
                        }
                    }
                    
                    // Damage all abilities (turrets, etc.) in blast radius
                    for (const [abilityId, ability] of this.abilities) {
                        if (ability.health <= 0) continue;
                        
                        const dx = (ability.x || 0) - explosionX;
                        const dy = (ability.y || 0) - explosionY;
                        const dist = Math.hypot(dx, dy);
                        const effectiveRadius = blastRadius + (ability.radius || 25);
                        
                        if (dist <= effectiveRadius) {
                            // Calculate falloff damage (65 at center, 15 at edge)
                            let t = (dist - innerRadius) / Math.max(1e-6, blastRadius - innerRadius);
                            t = Math.max(0, Math.min(1, t));
                            const dmg = 65 - 50 * t;
                            ability.health = Math.max(0, ability.health - dmg);
                            
                            // Broadcast health update
                            io.to(this.id).emit('abilityHealthUpdate', {
                                serverId: abilityId,
                                health: ability.health,
                                healthMax: ability.healthMax
                            });
                            
                            // Destroy ability if health depleted
                            if (ability.health <= 0) {
                                io.to(this.id).emit('abilityTriggered', {
                                    serverId: abilityId,
                                    type: ability.type,
                                    event: 'death'
                                });
                                this.abilities.delete(abilityId);
                                console.log(`[Server] ${ability.type} ${abilityId} destroyed by artillery explosion`);
                            }
                        }
                    }
                    
                    // Apply hazard damage (sandbags and barrels) from explosion
                    try {
                        if (this.hazards) {
                            this.hazards.damageCircle(explosionX, explosionY, blastRadius, 45);
                            if (typeof this.hazards.damageBarrelInRadius === 'function') {
                                this.hazards.damageBarrelInRadius(explosionX, explosionY, blastRadius, 45);
                            }
                        }
                    } catch(_) {}
                    
                    // Remove explosion projectile
                    this.enemyProjectiles.splice(i, 1);
                    continue;
                }
                
                // Remove if expired (non-explosion projectiles)
                if (proj.life <= 0) {
                    this.enemyProjectiles.splice(i, 1);
                    continue;
                }
                
                // Check collision with all players (artillery/artilleryGun doesn't collide mid-flight, only on timeout explosion)
                let hit = false;
                if (proj.type !== 'artillery' && proj.type !== 'artilleryGun') {
                    // Friendly projectiles (defensive turrets) should hit enemies instead
                    if (proj.isFriendly) {
                        // Check collision with enemies
                        for (const [, enemy] of this.enemies) {
                            if (!enemy || enemy.alive === false) continue;
                            // Don't hit defensive turrets
                            if (enemy.type === 'defenseTurret') continue;
                            
                            const dx = (enemy.x || 0) - proj.x;
                            const dy = (enemy.y || 0) - proj.y;
                            const dist = Math.hypot(dx, dy);
                            const collisionDist = (enemy.radius || 26) + proj.radius;
                            
                            if (dist <= collisionDist) {
                                // Damage enemy
                                enemy.health = Math.max(0, (enemy.health || 0) - (proj.damage || 15));
                                if (enemy.health <= 0) {
                                    enemy.alive = false;
                                    // Clear licker ensnare if applicable
                                    this._clearLickerEnsnareOnDeath(enemy.id, enemy.type);
                                }
                                hit = true;
                                break;
                            }
                        }
                        if (hit) {
                            this.enemyProjectiles.splice(i, 1);
                            continue;
                        }
                    } else {
                        // Hostile projectiles hit players
                        for (const [, p] of this.players) {
                            if (!p || p.health <= 0) continue;
                            if (p.invincible === true) continue; // Respect invincibility
                            
                            const dx = (p.x || 0) - proj.x;
                            const dy = (p.y || 0) - proj.y;
                            const dist = Math.hypot(dx, dy);
                            const collisionDist = (p.radius || 26) + proj.radius;
                            
                            if (dist <= collisionDist) {
                            // Fast Ball: trigger explosion on impact
                            if (proj.type === 'fastball') {
                                const explosionX = proj.x;
                                const explosionY = proj.y;
                                const blastRadius = 100;
                                const innerRadius = 20;
                                
                                // Damage all players in blast radius
                                for (const [, player] of this.players) {
                                    if (!player || player.health <= 0) continue;
                                    if (player.invincible === true) continue;
                                    
                                    const pdx = (player.x || 0) - explosionX;
                                    const pdy = (player.y || 0) - explosionY;
                                    const pdist = Math.hypot(pdx, pdy);
                                    const effectiveRadius = blastRadius + (player.radius || 26);
                                    
                                    if (pdist <= effectiveRadius) {
                                        // Calculate falloff damage (65 at center, 15 at edge)
                                        const healthBefore = player.health;
                                        let t = (pdist - innerRadius) / Math.max(1e-6, blastRadius - innerRadius);
                                        t = Math.max(0, Math.min(1, t));
                                        const rawDmg = 65 - 50 * t;
                                        
                                        // Apply armor reduction (cap at 75%)
                                        const armorPercent = Number.isFinite(player.armor) ? player.armor : 0;
                                        const reduction = Math.min(0.75, armorPercent / 100);
                                        const dmg = rawDmg * (1 - reduction);
                                        player.health = Math.max(0, (player.health || 0) - dmg);
                                        
                                        // Broadcast health update
                                        try { player.socket.emit('playerHealth', { health: player.health, from: 'fastballExplosion' }); } catch(_) {}
                                        io.to(this.id).emit('playerHealthUpdate', { playerId: player.id, health: player.health });
                                        
                                        // Check for death
                                        if (player.health <= 0 && healthBefore > 0) {
                                            this._handlePlayerDeath(player.id, player, io);
                                        }
                                    }
                                }
                                
                                // Damage troops in blast radius
                                if (this.troopManager && this.troopManager.troops) {
                                    for (const [, troop] of this.troopManager.troops) {
                                        if (!troop || !troop.alive || troop.health <= 0) continue;
                                        
                                        const tdx = (troop.x || 0) - explosionX;
                                        const tdy = (troop.y || 0) - explosionY;
                                        const tdist = Math.hypot(tdx, tdy);
                                        const effectiveRadius = blastRadius + (troop.radius || 22);
                                        
                                        if (tdist <= effectiveRadius) {
                                            // Calculate falloff damage (65 at center, 15 at edge)
                                            let t = (tdist - innerRadius) / Math.max(1e-6, blastRadius - innerRadius);
                                            t = Math.max(0, Math.min(1, t));
                                            const dmg = 65 - 50 * t;
                                            
                                            troop.health = Math.max(0, troop.health - dmg);
                                            
                                            // Broadcast troop damage
                                            io.to(this.id).emit('troopDamaged', {
                                                troopId: troop.id,
                                                // Send already-rounded integer damage for UI text (avoid "-0")
                                                damage: Math.max(1, Math.round(dmg)),
                                                health: troop.health,
                                                healthMax: troop.healthMax,
                                                x: troop.x,
                                                y: troop.y
                                            });
                                            
                                            // Check if troop died
                                            if (troop.health <= 0) {
                                                troop.alive = false;
                                                console.log(`[Server] Troop ${troop.id} killed by Fastball explosion`);
                                                io.to(this.id).emit('troopDeath', {
                                                    troopId: troop.id,
                                                    x: troop.x,
                                                    y: troop.y
                                                });
                                                io.to(this.id).emit('entity_dead', {
                                                    entityType: 'troop',
                                                    id: troop.id,
                                                    x: troop.x,
                                                    y: troop.y,
                                                    kind: troop.type || 'troop',
                                                    cause: 'fastball_explosion'
                                                });
                                            }
                                        }
                                    }
                                }
                                
                                // Damage abilities in blast radius
                                for (const [abilityId, ability] of this.abilities) {
                                    if (ability.health <= 0) continue;
                                    
                                    const adx = (ability.x || 0) - explosionX;
                                    const ady = (ability.y || 0) - explosionY;
                                    const adist = Math.hypot(adx, ady);
                                    const effectiveRadius = blastRadius + (ability.radius || 25);
                                    
                                    if (adist <= effectiveRadius) {
                                        let t = (adist - innerRadius) / Math.max(1e-6, blastRadius - innerRadius);
                                        t = Math.max(0, Math.min(1, t));
                                        const dmg = 65 - 50 * t;
                                        ability.health = Math.max(0, ability.health - dmg);
                                        
                                        // Broadcast health update
                                        io.to(this.id).emit('abilityHealthUpdate', {
                                            serverId: abilityId,
                                            health: ability.health,
                                            healthMax: ability.healthMax
                                        });
                                        
                                        // Destroy ability if health depleted
                                        if (ability.health <= 0) {
                                            io.to(this.id).emit('abilityTriggered', {
                                                serverId: abilityId,
                                                type: ability.type,
                                                event: 'death'
                                            });
                                            this.abilities.delete(abilityId);
                                            console.log(`[Server] ${ability.type} ${abilityId} destroyed by Fast Ball explosion`);
                                        }
                                    }
                                }
                            } else {
                                // Regular enemy projectile: apply direct damage with armor reduction
                                const healthBefore = p.health;
                                const rawDmg = proj.damage || 18;
                                const armorPercent = Number.isFinite(p.armor) ? p.armor : 0;
                                const reduction = Math.min(0.75, armorPercent / 100);
                                const dmg = rawDmg * (1 - reduction);
                                p.health = Math.max(0, (p.health || 0) - dmg);
                                
                                // Broadcast health update
                                try { p.socket.emit('playerHealth', { health: p.health, from: 'enemyProjectile' }); } catch(_) {}
                                io.to(this.id).emit('playerHealthUpdate', { playerId: p.id, health: p.health });
                                
                                // Broadcast projectile impact event for visual feedback (hit VFX)
                                io.to(this.id).emit('enemyProjectileHit', {
                                    x: proj.x,
                                    y: proj.y,
                                    targetType: 'player',
                                    targetId: p.id
                                });
                                
                                // Check for death
                                if (p.health <= 0 && healthBefore > 0) {
                                    this._handlePlayerDeath(p.id, p, io);
                                }
                            }
                            
                            hit = true;
                            break;
                        }
                    }
                    
                    // Check collision with troops (if projectile didn't hit a player)
                    if (!hit && this.troopManager && this.troopManager.troops) {
                        for (const [, troop] of this.troopManager.troops) {
                            if (!troop || !troop.alive || troop.health <= 0) continue;
                            
                            const dx = (troop.x || 0) - proj.x;
                            const dy = (troop.y || 0) - proj.y;
                            const dist = Math.hypot(dx, dy);
                            const collisionDist = (troop.radius || 22) + proj.radius;
                            
                            if (dist <= collisionDist) {
                                // Regular enemy projectile: apply direct damage (no armor for troops)
                                const dmg = proj.damage || 18;
                                troop.health = Math.max(0, troop.health - dmg);
                                
                                // Broadcast troop damage for visual feedback
                                io.to(this.id).emit('troopDamaged', {
                                    troopId: troop.id,
                                    // Send already-rounded integer damage for UI text (avoid "-0")
                                    damage: Math.max(1, Math.round(dmg)),
                                    health: troop.health,
                                    healthMax: troop.healthMax,
                                    x: troop.x,
                                    y: troop.y
                                });
                                
                                // Check if troop died
                                if (troop.health <= 0) {
                                    troop.alive = false;
                                    console.log(`[Server] Troop ${troop.id} killed by enemy projectile`);
                                    io.to(this.id).emit('troopDeath', {
                                        troopId: troop.id,
                                        x: troop.x,
                                        y: troop.y
                                    });
                                    io.to(this.id).emit('entity_dead', {
                                        entityType: 'troop',
                                        id: troop.id,
                                        x: troop.x,
                                        y: troop.y,
                                        kind: troop.type || 'troop',
                                        cause: 'enemy_projectile'
                                    });
                                }
                                
                                // Broadcast projectile impact event for visual feedback (hit VFX)
                                io.to(this.id).emit('enemyProjectileHit', {
                                    x: proj.x,
                                    y: proj.y,
                                    targetType: 'troop',
                                    targetId: troop.id
                                });
                                
                                hit = true;
                                break;
                            }
                        }
                    }
                }
                    
                // Check collision with gold chests (if projectile didn't hit a player)
                if (!hit) {
                    for (const [chestId, chest] of this.chests) {
                        if (chest.variant !== 'gold' || chest.health <= 0) continue;
                        
                        // Check if chest is vulnerable (only during waves or once activated)
                        if (this.currentGameMode?.isChestVulnerable && !this.currentGameMode.isChestVulnerable(chest)) continue;
                        
                        const dx = (chest.x || 0) - proj.x;
                        const dy = (chest.y || 0) - proj.y;
                        const dist = Math.hypot(dx, dy);
                        const collisionDist = (chest.radius || 20) + proj.radius;
                        
                        if (dist <= collisionDist) {
                            // Apply full damage to chest (no armor)
                            const dmg = proj.damage || 18;
                            chest.health = Math.max(0, chest.health - dmg);
                                
                                // Broadcast health update and hit flash
                                io.to(this.id).emit('chestHealthUpdate', {
                                    chestId: chest.id,
                                    health: chest.health,
                                    healthMax: chest.healthMax
                                });
                                io.to(this.id).emit('chestHitFlash', {
                                    chestId: chest.id
                                });
                                
                                // Auto-open chest if health depleted
                                if (chest.health <= 0 && !chest.opened) {
                                    chest.opening = false;
                                    chest.opened = true;
                                    io.to(this.id).emit('chestOpened', { 
                                        id: chest.id, 
                                        x: chest.x, 
                                        y: chest.y, 
                                        variant: chest.variant, 
                                        artifact: { vx: 160, vy: -220 },
                                        health: chest.health,
                                        healthMax: chest.healthMax
                                    });
                                    chest.artifactCarriedBy = null;
                                    chest.artifactPos = { x: chest.x, y: chest.y };
                                }
                                
                                hit = true;
                                break;
                            }
                        }
                    }
                    
                    // Check collision with artifacts (if projectile didn't hit anything else)
                    if (!hit) {
                        for (const [chestId, chest] of this.chests) {
                            if (chest.variant !== 'gold' || !chest.opened || chest.health <= 0) continue;
                            if (chest.artifactCarriedBy) continue; // Skip if carried
                            
                            const artX = (chest.artifactPos && Number(chest.artifactPos.x)) || Number(chest.x) || 0;
                            const artY = (chest.artifactPos && Number(chest.artifactPos.y)) || Number(chest.y) || 0;
                            const dx = artX - proj.x;
                            const dy = artY - proj.y;
                            const dist = Math.hypot(dx, dy);
                            const collisionDist = 10 + proj.radius; // Artifact radius is 10
                            
                            if (dist <= collisionDist) {
                                // Apply full damage to artifact (no armor)
                                const dmg = proj.damage || 18;
                                chest.health = Math.max(0, chest.health - dmg);
                                
                                // Broadcast health update and hit flash
                                io.to(this.id).emit('artifactHealthUpdate', {
                                    chestId: chest.id,
                                    health: chest.health,
                                    healthMax: chest.healthMax
                                });
                                io.to(this.id).emit('artifactHitFlash', {
                                    chestId: chest.id
                                });
                                
                                // Destroy artifact if health depleted
                                if (chest.health <= 0) {
                                    console.log(`[Server] Artifact ${chest.id} destroyed by enemy projectile`);
                                    io.to(this.id).emit('artifactDestroyed', { chestId: chest.id });
                                }
                                
                                hit = true;
                                break;
                            }
                        }
                    }
                    
                    // Check collision with turrets (if projectile didn't hit anything else)
                    if (!hit) {
                        for (const [abilityId, ability] of this.abilities) {
                            if (ability.type !== 'AutoTurret') continue;
                            if (ability.health <= 0) continue;
                            
                            const dx = (ability.x || 0) - proj.x;
                            const dy = (ability.y || 0) - proj.y;
                            const dist = Math.hypot(dx, dy);
                            const collisionDist = (ability.radius || 25) + proj.radius;
                            
                            if (dist <= collisionDist) {
                                // Apply full damage to turret (no armor)
                                const dmg = proj.damage || 18;
                                ability.health = Math.max(0, ability.health - dmg);
                                
                                // Broadcast health update
                                io.to(this.id).emit('abilityHealthUpdate', {
                                    serverId: abilityId,
                                    health: ability.health,
                                    healthMax: ability.healthMax
                                });
                                
                                // Destroy turret if health depleted
                                if (ability.health <= 0) {
                                    io.to(this.id).emit('abilityTriggered', {
                                        serverId: abilityId,
                                        type: 'AutoTurret',
                                        event: 'death'
                                    });
                                    this.abilities.delete(abilityId);
                                    console.log(`[Server] AutoTurret ${abilityId} destroyed by enemy projectile`);
                                }
                                
                                hit = true;
                                break;
                            }
                        }
                    }
                }
                
                // Remove projectile if it hit a player, chest, artifact, or turret
                if (hit) {
                    this.enemyProjectiles.splice(i, 1);
                }
            }
        } catch (e) {
            console.error('[Server] updateEnemies error:', e && e.stack ? e.stack : String(e));
        }
    }
    */ // END updateEnemies
    
    /* COMMENTED OUT - Now using EnemyManager (Phase 9 - FINAL!)
    // Helper method to find closest player to a position
    _findClosestPlayer(x, y) {
        let closestPlayer = null;
        let closestDist = Infinity;
        for (const [, p] of this.players) {
            if (!p || p.health <= 0) continue;
            if (p.invisible === true || p.dialogueOpen === true) continue;
            const dx = (p.x || 0) - (x || 0);
            const dy = (p.y || 0) - (y || 0);
            const dist = Math.hypot(dx, dy);
            if (dist < closestDist) {
                closestDist = dist;
                closestPlayer = p;
            }
        }
        return closestPlayer;
    }
    
    // Helper method for BigBoy dash execution
    _executeBigBoyDash(enemy) {
        console.log(`[BigBoy] _executeBigBoyDash called for ${enemy.id}`);
        
        if (!enemy.dashTarget) {
            console.log(`[BigBoy] ${enemy.id} has no dashTarget, aborting`);
            return;
        }
        
        console.log(`[BigBoy] ${enemy.id} dashing toward target at (${enemy.dashTarget.x}, ${enemy.dashTarget.y})`);
        
        const dx = enemy.dashTarget.x - enemy.x;
        const dy = enemy.dashTarget.y - enemy.y;
        const dist = Math.hypot(dx, dy) || 1;
        const ux = dx / dist;
        const uy = dy / dist;
        
        // Apply dash movement using knockback system
        enemy.kbVelX = ux * (enemy.dashDistance / enemy.dashDuration);
        enemy.kbVelY = uy * (enemy.dashDistance / enemy.dashDuration);
        enemy.kbTime = enemy.dashDuration;
        enemy.isDashing = true;
        
        console.log(`[BigBoy] ${enemy.id} dash movement applied: kbVel=(${enemy.kbVelX.toFixed(1)}, ${enemy.kbVelY.toFixed(1)}), kbTime=${enemy.kbTime}`);
        
        // Clear the hit tracking set for this new dash
        enemy._dashHitPlayers = new Set();
        
        console.log(`[BigBoy] Dash started - will check for collisions during movement`);
        
        // Broadcast dash execution
        this._broadcastEnemyDash(enemy.id, enemy.dashTarget.id, ux, uy);
        
        // Reset dash state
        enemy.dashTarget = null;
        enemy.dashWindup = 0;
        
        // Set dash completion timer
        setTimeout(() => {
            enemy.isDashing = false;
            enemy._dashHitPlayers = null; // Clear hit tracking when dash ends
        }, enemy.dashDuration * 1000);
    }
    */ // END _executeBigBoyDash
    
    /* COMMENTED OUT - Now using EnemyManager (Phase 9 - FINAL!)
    // Broadcast methods for dash events
    _broadcastEnemyDashWindup(enemyId, targetPlayerId) {
        const roomId = this.id;
        if (io && io.to) {
            io.to(roomId).emit('enemyDashWindup', {
                enemyId: enemyId,
                targetPlayerId: targetPlayerId
            });
        }
    }
    
    _broadcastEnemyDash(enemyId, targetPlayerId, dirX, dirY) {
        const roomId = this.id;
        if (io && io.to) {
            io.to(roomId).emit('enemyDash', {
                enemyId: enemyId,
                targetPlayerId: targetPlayerId,
                dirX: dirX,
                dirY: dirY
            });
        }
    }
    */ // END _broadcastEnemyDash
    
    /* COMMENTED OUT - Now using EnemyManager (Phase 9 - FINAL!)
    _scheduleArtilleryStrike(boss, tx, ty, delay, io) {
        try {
            const dx = tx - boss.x;
            const dy = ty - boss.y;
            const dist = Math.hypot(dx, dy) || 1;
            const ux = dx / dist;
            const uy = dy / dist;
            const fireAngle = Math.atan2(uy, ux);
            const spawnX = boss.x + ux * ((boss.radius || 32) + 8);
            const spawnY = boss.y + uy * ((boss.radius || 32) + 8);
            const projectileSpeed = 600;
            const projectileLife = 3.6;
            const color = '#ffa64d';
            const perp = (Math.random() < 0.5 ? -1 : 1);
            
            // Broadcast artillery strike telegraph and projectile spawn
            io.to(this.id).emit('artilleryStrike', {
                bossId: boss.id,
                targetX: tx,
                targetY: ty,
                delay: delay,
                spawnX: spawnX,
                spawnY: spawnY,
                vx: Math.cos(fireAngle) * projectileSpeed,
                vy: Math.sin(fireAngle) * projectileSpeed,
                radius: 6,
                color: color,
                life: projectileLife,
                angle: fireAngle,
                perp: perp
            });
            
            // Track the homing projectile server-side
            // These projectiles home toward target and explode on arrival
            this.enemyProjectiles.push({
                x: spawnX,
                y: spawnY,
                vx: Math.cos(fireAngle) * projectileSpeed,
                vy: Math.sin(fireAngle) * projectileSpeed,
                radius: 6,
                damage: 45, // Artillery strike damage
                life: projectileLife,
                maxLife: projectileLife,
                type: 'artillery',
                targetX: tx,
                targetY: ty,
                maxTurnRate: 13.5,
                bias: perp * 1.8,
                ownerId: boss.id
            });
        } catch(err) {
            console.error('[Server] _scheduleArtilleryStrike error:', err);
        }
    }
    */ // END _scheduleArtilleryStrike
    
    /* COMMENTED OUT - Now using EnemyManager (Phase 9 - FINAL!)
    // Artillery Gun strike - similar to Artillery Witch but damages enemies and sandbags
    _scheduleArtilleryGunStrike(gun, tx, ty, delay, io) {
        try {
            const dx = tx - gun.x;
            const dy = ty - gun.y;
            const gunDist = Math.hypot(dx, dy) || 1;
            const ux = dx / gunDist;
            const uy = dy / gunDist;
            const fireAngle = Math.atan2(uy, ux);
            const spawnOffset = (gun.radius || 64) + 16;
            const spawnX = gun.x + ux * spawnOffset;
            const spawnY = gun.y + uy * spawnOffset;
            // Calculate distance from SPAWN position to target (not gun position)
            const dist = Math.max(100, gunDist - spawnOffset);  // Actual travel distance
            // Calculate speed dynamically so projectile arrives in ~2.5 seconds (like Artillery Witch at max range)
            const desiredTravelTime = 2.5;  // seconds - matches Artillery Witch timing
            const projectileSpeed = Math.max(400, dist / desiredTravelTime);  // Min 400 speed
            const projectileLife = desiredTravelTime;  // Exact travel time - explodes on arrival
            const color = '#ffcc00';  // Golden yellow for New Antioch
            const perp = (Math.random() < 0.5 ? -1 : 1);
            
            // DEBUG: Log target ring position (disabled)
            // console.log(`[ArtilleryGun DEBUG] Ring center: (${tx.toFixed(1)}, ${ty.toFixed(1)}) | TravelDist: ${dist.toFixed(1)} | Speed: ${projectileSpeed.toFixed(1)} | Life: ${projectileLife.toFixed(2)}s`);
            
            // Broadcast artillery gun strike telegraph
            io.to(this.id).emit('artilleryGunStrike', {
                gunId: gun.id,
                targetX: tx,
                targetY: ty,
                delay: delay,
                spawnX: spawnX,
                spawnY: spawnY,
                vx: Math.cos(fireAngle) * projectileSpeed,
                vy: Math.sin(fireAngle) * projectileSpeed,
                radius: 8,
                color: color,
                life: projectileLife,
                angle: fireAngle,
                perp: perp
            });
            
            // Track the projectile server-side (NEW TYPE: artilleryGun)
            this.enemyProjectiles.push({
                x: spawnX,
                y: spawnY,
                vx: Math.cos(fireAngle) * projectileSpeed,
                vy: Math.sin(fireAngle) * projectileSpeed,
                radius: 8,
                damage: 55,  // Higher damage than witch (45)
                life: projectileLife,
                maxLife: projectileLife,
                type: 'artilleryGun',  // NEW TYPE - damages enemies too
                targetX: tx,
                targetY: ty,
                // Used for safe-zone protection rules (A-F letter zones only)
                zoneMinX: gun && gun.targetZone ? gun.targetZone.minX : undefined,
                zoneMaxX: gun && gun.targetZone ? gun.targetZone.maxX : undefined,
                zoneMinY: gun && gun.targetZone ? gun.targetZone.minY : undefined,
                zoneMaxY: gun && gun.targetZone ? gun.targetZone.maxY : undefined,
                maxTurnRate: 8,  // Gentle curve toward target
                // No bias - removes random perpendicular curve that throws off aim
                ownerId: gun.id,
                isFriendly: true  // Friendly to players (damages enemies)
            });
        } catch(err) {
            console.error('[Server] _scheduleArtilleryGunStrike error:', err);
        }
    }
    */ // END _scheduleArtilleryGunStrike
    
    /* COMMENTED OUT - Now using NetworkManager (Phase 3)
    _getEnemiesStatePayload() {
        const out = [];
        for (const e of this.enemies.values()) {
            // Skip dead enemies to prevent re-spawning on clients
            if (e.alive === false) continue;
            const data = { id: e.id, x: e.x, y: e.y, type: e.type };
            // Include defensive turret barrel angle for visual synchronization
            if (e.type === 'defenseTurret') {
                data._barrelAngle = e._barrelAngle || 0;
            }
            // Include artillery gun barrel angle for visual synchronization
            if (e.type === 'artilleryGun') {
                data._barrelAngle = e._barrelAngle || 0;
            }
            // Include Licker tentacle state for visual synchronization
            if (e.type === 'licker') {
                data.tentacleState = e._tentacleState || 'idle';
                data.tentacleTime = e._tentacleTime || 0;
                data._aimAngle = e._aimAngle || 0;
                data._attached = e._attached || false;
                data._targetPlayerId = e._targetPlayerId || null; // Track which player is being targeted
            }
            // Include Boomer armed state for warning ring synchronization
            if (e.type === 'boomer') {
                data._armedTimerStarted = e._armedTimerStarted || false;
                data._armedTimer = Number.isFinite(e._armedTimer) ? e._armedTimer : 0;
                data._warningActive = e._warningActive || false;
                data._closestPlayerDist = Number.isFinite(e._closestPlayerDist) ? e._closestPlayerDist : Infinity;
            }
            // Include WallGuy shield state for synchronization
            if (e.type === 'wallguy') {
                data.shieldAngle = Number.isFinite(e.shieldAngle) ? e.shieldAngle : 0;
                data._attackCooldown = Number.isFinite(e._attackCooldown) ? e._attackCooldown : 0;
            }
            // Include Artillery Witch (boss) state for visual synchronization
            if (e.type === 'boss') {
                data.health = e.health || 0;
                data.healthMax = e.healthMax || 2000;
                data.speedMul = Number.isFinite(e.speedMul) ? e.speedMul : 0;
                data._targetPlayerId = e._targetPlayerId || null;
                data._burstMode = e._burstMode || false;
                data.kbTime = Number.isFinite(e.kbTime) ? e.kbTime : 0;
            }
            out.push(data);
        }
        return out;
    }
    */ // END _getEnemiesStatePayload

    /* COMMENTED OUT - Now using NetworkManager (Phase 3)
    _getEnemiesStatePayloadForInterest(px, py, r2) {
        const out = [];
        const x0 = Number(px) || 0;
        const y0 = Number(py) || 0;
        const rad2 = Number.isFinite(r2) ? r2 : (5500 * 5500);
        for (const e of this.enemies.values()) {
            if (!e || e.alive === false) continue;

            // Always include bosses and static defenses so all clients stay consistent.
            const alwaysInclude = (e.type === 'boss' || e.type === 'defenseTurret' || e.type === 'artilleryGun');
            if (!alwaysInclude) {
                const dx = (Number(e.x) || 0) - x0;
                const dy = (Number(e.y) || 0) - y0;
                if (dx * dx + dy * dy > rad2) continue;
            }

            const data = { id: e.id, x: e.x, y: e.y, type: e.type };
            if (e.type === 'defenseTurret') data._barrelAngle = e._barrelAngle || 0;
            if (e.type === 'artilleryGun') data._barrelAngle = e._barrelAngle || 0;
            if (e.type === 'licker') {
                data.tentacleState = e._tentacleState || 'idle';
                data.tentacleTime = e._tentacleTime || 0;
                data._aimAngle = e._aimAngle || 0;
                data._attached = e._attached || false;
                data._targetPlayerId = e._targetPlayerId || null;
            }
            if (e.type === 'boomer') {
                data._armedTimerStarted = e._armedTimerStarted || false;
                data._armedTimer = Number.isFinite(e._armedTimer) ? e._armedTimer : 0;
                data._warningActive = e._warningActive || false;
                data._closestPlayerDist = Number.isFinite(e._closestPlayerDist) ? e._closestPlayerDist : Infinity;
            }
            if (e.type === 'wallguy') {
                data.shieldAngle = Number.isFinite(e.shieldAngle) ? e.shieldAngle : 0;
                data._attackCooldown = Number.isFinite(e._attackCooldown) ? e._attackCooldown : 0;
            }
            if (e.type === 'boss') {
                data.health = e.health || 0;
                data.healthMax = e.healthMax || 2000;
                data.speedMul = Number.isFinite(e.speedMul) ? e.speedMul : 0;
                data._targetPlayerId = e._targetPlayerId || null;
                data._burstMode = e._burstMode || false;
                data.kbTime = Number.isFinite(e.kbTime) ? e.kbTime : 0;
            }

            out.push(data);
        }
        return out;
    }

    /* COMMENTED OUT - Now using NetworkManager (Phase 3)
    // Phase 3: New consolidated entity replication format
    // Returns { entities: [...], timestamp: number }
    // Each entity has { entityType, entityId, data: {...} }
    _getEntitiesStatePayload() {
        if (!Protocol.FEATURES.DUAL_EMIT_ENTITIES) {
            // Feature flag disabled, return empty
            return { entities: [], timestamp: Date.now() };
        }
        
        const entities = [];
        
        // Include enemies if feature flag enabled
        if (Protocol.FEATURES.ENTITIES_INCLUDE_ENEMIES) {
            for (const e of this.enemies.values()) {
                if (e.alive === false) continue;
                
                // Wrap enemy data in entity envelope
                const data = { id: e.id, x: e.x, y: e.y, type: e.type };
                
                // Include type-specific state (same as legacy enemiesState)
                if (e.type === 'defenseTurret') data._barrelAngle = e._barrelAngle || 0;
                if (e.type === 'artilleryGun') data._barrelAngle = e._barrelAngle || 0;
                if (e.type === 'licker') {
                    data.tentacleState = e._tentacleState || 'idle';
                    data.tentacleTime = e._tentacleTime || 0;
                    data._aimAngle = e._aimAngle || 0;
                    data._attached = e._attached || false;
                    data._targetPlayerId = e._targetPlayerId || null;
                }
                if (e.type === 'boomer') {
                    data._armedTimerStarted = e._armedTimerStarted || false;
                    data._armedTimer = Number.isFinite(e._armedTimer) ? e._armedTimer : 0;
                    data._warningActive = e._warningActive || false;
                    data._closestPlayerDist = Number.isFinite(e._closestPlayerDist) ? e._closestPlayerDist : Infinity;
                }
                if (e.type === 'wallguy') {
                    data.shieldAngle = Number.isFinite(e.shieldAngle) ? e.shieldAngle : 0;
                    data._attackCooldown = Number.isFinite(e._attackCooldown) ? e._attackCooldown : 0;
                }
                if (e.type === 'boss') {
                    data.health = e.health || 0;
                    data.healthMax = e.healthMax || 2000;
                    data.speedMul = Number.isFinite(e.speedMul) ? e.speedMul : 0;
                    data._targetPlayerId = e._targetPlayerId || null;
                    data._burstMode = e._burstMode || false;
                    data.kbTime = Number.isFinite(e.kbTime) ? e.kbTime : 0;
                }
                
                entities.push({
                    entityType: Protocol.EntityType.ENEMY,
                    entityId: e.id,
                    data: data
                });
            }
        }
        
        // Future: include NPCs, troops, hazards when their feature flags are enabled
        
        return {
            entities: entities,
            timestamp: Date.now()
        };
    }
    */ // END _getEntitiesStatePayload
    
    /* COMMENTED OUT - Now using NetworkManager (Phase 3)
    _getEntitiesStatePayloadForInterest(px, py, r2) {
        if (!Protocol.FEATURES.DUAL_EMIT_ENTITIES) {
            return { entities: [], timestamp: Date.now() };
        }
        
        const entities = [];
        const x0 = Number(px) || 0;
        const y0 = Number(py) || 0;
        const rad2 = Number.isFinite(r2) ? r2 : (5500 * 5500);
        
        // Include enemies if feature flag enabled
        if (Protocol.FEATURES.ENTITIES_INCLUDE_ENEMIES) {
            for (const e of this.enemies.values()) {
                if (!e || e.alive === false) continue;
                
                // Same interest-based filtering as legacy enemiesState
                const alwaysInclude = (e.type === 'boss' || e.type === 'defenseTurret' || e.type === 'artilleryGun');
                if (!alwaysInclude) {
                    const dx = (Number(e.x) || 0) - x0;
                    const dy = (Number(e.y) || 0) - y0;
                    if (dx * dx + dy * dy > rad2) continue;
                }
                
                const data = { id: e.id, x: e.x, y: e.y, type: e.type };
                if (e.type === 'defenseTurret') data._barrelAngle = e._barrelAngle || 0;
                if (e.type === 'artilleryGun') data._barrelAngle = e._barrelAngle || 0;
                if (e.type === 'licker') {
                    data.tentacleState = e._tentacleState || 'idle';
                    data.tentacleTime = e._tentacleTime || 0;
                    data._aimAngle = e._aimAngle || 0;
                    data._attached = e._attached || false;
                    data._targetPlayerId = e._targetPlayerId || null;
                }
                if (e.type === 'boomer') {
                    data._armedTimerStarted = e._armedTimerStarted || false;
                    data._armedTimer = Number.isFinite(e._armedTimer) ? e._armedTimer : 0;
                    data._warningActive = e._warningActive || false;
                    data._closestPlayerDist = Number.isFinite(e._closestPlayerDist) ? e._closestPlayerDist : Infinity;
                }
                if (e.type === 'wallguy') {
                    data.shieldAngle = Number.isFinite(e.shieldAngle) ? e.shieldAngle : 0;
                    data._attackCooldown = Number.isFinite(e._attackCooldown) ? e._attackCooldown : 0;
                }
                if (e.type === 'boss') {
                    data.health = e.health || 0;
                    data.healthMax = e.healthMax || 2000;
                    data.speedMul = Number.isFinite(e.speedMul) ? e.speedMul : 0;
                    data._targetPlayerId = e._targetPlayerId || null;
                    data._burstMode = e._burstMode || false;
                    data.kbTime = Number.isFinite(e.kbTime) ? e.kbTime : 0;
                }
                
                entities.push({
                    entityType: Protocol.EntityType.ENEMY,
                    entityId: e.id,
                    data: data
                });
            }
        }
        
        return {
            entities: entities,
            timestamp: Date.now()
        };
    }
    */ // END _getEntitiesStatePayloadForInterest
    
    /* COMMENTED OUT - Now using NetworkManager (Phase 3)
    broadcastEnemiesState() {
        // Phase 3: Dual-emit mode - send both legacy (enemiesState) and new (entitiesState)
        // Interest-based enemies replication:
        // - Most ticks: send each client only nearby enemies (full per-enemy state, no deltas).
        // - Periodically: send a full refresh to the whole room for robustness.
        const now = Date.now();
        const FULL_REFRESH_MS = 2000;
        if (!this._lastEnemiesStateFullAt || (now - this._lastEnemiesStateFullAt) >= FULL_REFRESH_MS) {
            this._lastEnemiesStateFullAt = now;
            
            // Legacy event (will be removed after migration)
            io.to(this.id).emit('enemiesState', this._getEnemiesStatePayload());
            
            // Phase 3: New consolidated event (active if feature flag enabled)
            if (Protocol.FEATURES.DUAL_EMIT_ENTITIES) {
                io.to(this.id).emit('entitiesState', this._getEntitiesStatePayload());
            }
            return;
        }

        const INTEREST_RADIUS = 5500; // generous radius to prevent popping in fast-paced play
        const r2 = INTEREST_RADIUS * INTEREST_RADIUS;
        for (const [, p] of this.players) {
            if (!p || !p.socket) continue;
            try {
                // Legacy event (will be removed after migration)
                p.socket.emit('enemiesState', this._getEnemiesStatePayloadForInterest(p.x, p.y, r2));
                
                // Phase 3: New consolidated event (active if feature flag enabled)
                if (Protocol.FEATURES.DUAL_EMIT_ENTITIES) {
                    p.socket.emit('entitiesState', this._getEntitiesStatePayloadForInterest(p.x, p.y, r2));
                }
            } catch (_) {}
        }
    }
    */ // END broadcastEnemiesState
    
    /* COMMENTED OUT - Now using EnemyManager (Phase 9 - FINAL!)
    // Ambient NPC management methods
    spawnLobbyAmbientNpcs() {
        // Only create ambient NPCs if in lobby scene
        if (this.scene !== 'lobby') {
            return;
        }

        // Atomic guard to prevent race condition on concurrent joins
        if (this.ambientSpawned) {
            return;
        }
        this.ambientSpawned = true;

        console.log('[AMBIENT_NPCs] Spawning ambient NPCs with seeded RNG');

        // Use seeded RNG for synchronized NPC placement across all players (same logic as client)
        const rng = new SeededRNG(this.worldSeed);
        const count = 4;
        const tries = 1000;
        const r = 22;
        const placed = [];
        
        // Reserve small "no-spawn" bubbles around talkable lobby NPCs so ambient crowd NPCs
        // never spawn on top of them.
        const reserved = [];
        // Also reserve the ENTIRE shooting-range area (target dummy bay) so bark-only crowd NPCs
        // never spawn inside it (even if target dummies haven't spawned yet).
        // Keep this in sync with `spawnLobbyTargetDummy()`'s region bounds.
        const noSpawnAabbs = [];
        try {
            const bWorld = Number.isFinite(this.boundary) ? this.boundary : 1000;
            const talkR = 24;
            const gap = 34; // extra clearance beyond radii
            // Merchant (approximate anchor; spawn logic may nudge slightly if blocked)
            reserved.push({ x: 200, y: -bWorld + talkR + 80, r: talkR + r + gap });
            // Commander (approximate anchor)
            reserved.push({ x: -bWorld + talkR + 140, y: 0, r: talkR + r + gap });
            // Quartermaster (training lane, near bottom edge sandbag)
            reserved.push({ x: -307, y: -534, r: talkR + r + gap });

            // Shooting range / target dummy bay (upper-left). This is where dummies spawn & move.
            // Dummies region is roughly (-b..-375) x (-b..-575) in world coords.
            const dummyR = 32;
            const wallGapX = 14;
            const wallGapY = 14;
            const regionMinX = -bWorld + dummyR + wallGapX;
            const regionMinY = -bWorld + dummyR + wallGapY;
            const regionMaxX = -375;
            const regionMaxY = -575;
            const pad = 90; // expand keep-out so NPCs don't spawn on the boundary line
            noSpawnAabbs.push({
                minX: regionMinX - pad,
                maxX: regionMaxX + pad,
                minY: regionMinY - pad,
                maxY: regionMaxY + pad
            });
        } catch(_) {}
        
        const isClear = (x, y) => {
            if (!this.environment.isInsideBounds || !this.environment.circleHitsAny) return true;
            if (!this.environment.isInsideBounds(x, y, r)) return false;
            if (this.environment.circleHitsAny(x, y, r)) return false;
            // Avoid reserved no-spawn rectangles (e.g. shooting range)
            try {
                for (let i = 0; i < noSpawnAabbs.length; i++) {
                    const a = noSpawnAabbs[i];
                    if (x >= a.minX && x <= a.maxX && y >= a.minY && y <= a.maxY) return false;
                }
            } catch(_) {}
            // Avoid reserved talk-NPC bubbles
            try {
                for (let i = 0; i < reserved.length; i++) {
                    const z = reserved[i];
                    const dx = x - z.x, dy = y - z.y;
                    if (dx*dx + dy*dy <= z.r * z.r) return false;
                }
            } catch(_) {}
            for (let i = 0; i < placed.length; i++) {
                const p = placed[i];
                const dx = x - p.x, dy = y - p.y;
                if (dx*dx + dy*dy <= (r + p.r + 12) * (r + p.r + 12)) return false;
            }
            // Check against lobby training dummy positions
            try {
                if (this.enemies) {
                    for (const e of this.enemies.values()) {
                        if (!e || e.alive === false) continue;
                        if (e.type !== 'targetDummy') continue;
                        const dx = x - e.x, dy = y - e.y;
                        const rr = (r + (e.radius || 32) + 12);
                        if (dx*dx + dy*dy <= rr * rr) return false;
                    }
                }
            } catch(_) {}
            return true;
        };

        const b = this.boundary - 60;
        const inner = b - 220; // bias ring near edges
        const clusterCenters = [];
        
        // Seed 2-3 cluster centers on edge-biased ring
        const numClusters = 2 + rng.randomInt(0, 1);
        for (let c = 0; c < numClusters; c++) {
            const edgeSide = rng.randomInt(0, 3); // 0:top,1:right,2:bottom,3:left
            let cx = 0, cy = 0;
            if (edgeSide === 0) { cx = rng.randomFloat(-1, 1) * inner; cy = -inner; }
            else if (edgeSide === 1) { cx = inner; cy = rng.randomFloat(-1, 1) * inner; }
            else if (edgeSide === 2) { cx = rng.randomFloat(-1, 1) * inner; cy = inner; }
            else { cx = -inner; cy = rng.randomFloat(-1, 1) * inner; }
            // Nudge inward if obstructed
            for (let step = 0; step < 10 && (this.environment.circleHitsAny && this.environment.circleHitsAny(cx, cy, r) || !this.environment.isInsideBounds(cx, cy, r)); step++) {
                cx *= 0.95; cy *= 0.95;
            }
            clusterCenters.push({ x: cx, y: cy });
        }

        for (let k = 0; k < count; k++) {
            let x = 0, y = 0, ok = false;
            const useCluster = rng.random() < 0.5 && clusterCenters.length > 0;
            if (useCluster) {
                // Pick a cluster, sample within a small radius
                const cc = clusterCenters[Math.floor(rng.random() * clusterCenters.length)];
                for (let t = 0; t < tries; t++) {
                    const ang = rng.randomFloat(0, Math.PI * 2);
                    const dist = 40 + rng.randomFloat(0, 160); // compact cluster
                    x = cc.x + Math.cos(ang) * dist;
                    y = cc.y + Math.sin(ang) * dist;
                    if (isClear(x, y)) { ok = true; break; }
                }
            }
            if (!ok) {
                // Edge-biased random placement: choose a side then sample inward
                const edgeSide = rng.randomInt(0, 3);
                for (let t = 0; t < tries; t++) {
                    if (edgeSide === 0) { x = rng.randomFloat(-1, 1) * inner; y = -inner - rng.randomFloat(0, 80); }
                    else if (edgeSide === 1) { x = inner + rng.randomFloat(0, 80); y = rng.randomFloat(-1, 1) * inner; }
                    else if (edgeSide === 2) { x = rng.randomFloat(-1, 1) * inner; y = inner + rng.randomFloat(0, 80); }
                    else { x = -inner - rng.randomFloat(0, 80); y = rng.randomFloat(-1, 1) * inner; }
                    // Clamp to bounds margin
                    x = Math.max(-b+20, Math.min(b-20, x));
                    y = Math.max(-b+20, Math.min(b-20, y));
                    if (isClear(x, y)) { ok = true; break; }
                }
            }
            if (ok) {
                // Calculate deterministic bark timing using seeded RNG
                const barkSeed = this.worldSeed + k; // Unique per NPC but deterministic
                const barkRng = new SeededRNG(barkSeed);
                
                // Deterministic color selection using seeded RNG (same palette as NPC_Lobby)
                const colorPalette = ['#6e7380', '#7a6f64', '#4d5968', '#5c6b52', '#7a5f5f'];
                const colorIndex = Math.floor(barkRng.random() * colorPalette.length);
                const color = colorPalette[colorIndex];
                
                const npc = {
                    id: `ambient_npc_${k}`,
                    x: x,
                    y: y,
                    radius: 22,
                    type: 'ambient_lobby',
                    color: color, // Add deterministic color
                    // Add bark synchronization data
                    barkSeed: barkSeed,
                    barkInterval: 2.5 * (0.8 + barkRng.randomFloat(0, 0.7)), // Same variance as client
                    barkGap: 1.5 * (0.8 + barkRng.randomFloat(0, 0.7)),
                    barkTimer: barkRng.random() * (2.5 + 1.5) // Initial timer offset
                };
                this.ambientNpcs.push(npc);
                placed.push({ x, y, r });
            }
        }
        this.broadcastAmbientNpcs();

        console.log(`[AMBIENT_NPCs] Spawned ${placed.length} ambient NPCs in room ${this.id} using seed: ${this.worldSeed}`);
    }
    */ // END spawnLobbyAmbientNpcs

    cleanup() {
        this._destroyed = true;
        if (this._tickHandle) {
            clearTimeout(this._tickHandle);
            this._tickHandle = null;
        }
        if (this._broadcastHandle) {
            clearTimeout(this._broadcastHandle);
            this._broadcastHandle = null;
        }
        if (this._lowPriorityBroadcastHandle) {
            clearTimeout(this._lowPriorityBroadcastHandle);
            this._lowPriorityBroadcastHandle = null;
        }
    }
}

// Phase 2: Initialize handler modules with shared dependencies
const handlers = createAllHandlers({
    io,
    rooms,
    Protocol,
    serverDebugger,
    nfcTagManager,
    getWeaponProgression,
    GameRoom
});

// Socket.IO connection handling
io.on('connection', (socket) => {
    // Debug: Identify where "extra" local clients are coming from by logging handshake metadata.
    // Client sets these in `io({ auth: { pageId, href } })`.
    let pageId = undefined;
    let href = undefined;
    let ua = undefined;
    let ip = undefined;
    try {
        pageId = socket.handshake && socket.handshake.auth ? socket.handshake.auth.pageId : undefined;
        href = socket.handshake && socket.handshake.auth ? socket.handshake.auth.href : undefined;
        ua = socket.handshake && socket.handshake.headers ? socket.handshake.headers['user-agent'] : undefined;
        // Prefer x-forwarded-for if present; otherwise use socket.io's address field
        const xff = socket.handshake && socket.handshake.headers ? socket.handshake.headers['x-forwarded-for'] : undefined;
        ip = (xff && String(xff).split(',')[0].trim()) || (socket.handshake ? socket.handshake.address : undefined);
    } catch (_) {}

    console.log(`Client connected: ${socket.id} pageId=${pageId || 'n/a'} ip=${ip || 'n/a'} href=${href || 'n/a'} ua="${ua || 'n/a'}"`);
    serverDebugger.info('NETWORKING', `Client connected: ${socket.id}`);
    
    // Send NFC reader status to newly connected client
    nfcTagManager.sendStatusToSocket(socket);
    
    // Handle NFC unlock requests (from double-tap "." or NFC bridge)
    socket.on('requestNfcUnlock', (data) => handlers.connection.requestNfcUnlock(socket, data));
    
    socket.on('joinRoom', (data) => handlers.connection.joinRoom(socket, data));
    
    // Phase 2: Player handlers extracted
    socket.on('playerInput', (input) => handlers.player.playerInput(socket, input));
    socket.on('reviveStartRequest', (data) => handlers.player.reviveStartRequest(socket, data));
    socket.on('reviveAccept', () => handlers.player.reviveAccept(socket));
    socket.on('playerHealthChange', (data) => handlers.player.playerHealthChange(socket, data));

    socket.on('chestOpenRequest', (data) => handlers.item.chestOpenRequest(socket, data));
    
    socket.on('sceneChange', (data) => handlers.mode.sceneChange(socket, data));
    
    socket.on('setLevelType', (data) => handlers.mode.setLevelType(socket, data));

    socket.on('readyTimerStart', (data) => handlers.mode.readyTimerStart(socket, data));
    socket.on('readyTimerCancel', (data) => handlers.mode.readyTimerCancel(socket, data));
    
    socket.on('extractionTimerStart', (data) => handlers.mode.extractionTimerStart(socket, data));
    
    socket.on('extractionTimerCancel', (data) => handlers.mode.extractionTimerCancel(socket, data));
    
    // Player death/respawn debug notifications
    socket.on('playerDeath', (data) => handlers.player.playerDeath(socket, data));
    socket.on('playerRespawn', (data) => handlers.player.playerRespawn(socket, data));
    
    // Evil state synchronization for PvP friendly fire
    socket.on('setEvilState', (data) => handlers.player.setEvilState(socket, data));
    socket.on('pvpDirectDamage', (data) => handlers.player.pvpDirectDamage(socket, data));
    
    // Phase 4: Item handlers extracted

    // Artifact pickup/drop server authority
    socket.on('artifactPickupRequest', (data) => handlers.item.artifactPickupRequest(socket, data));

    socket.on('artifactDropRequest', (data) => handlers.item.artifactDropRequest(socket, data));

    // Battery pickup/place server authority (for RadioTower power system)
    socket.on('batteryPickupRequest', (data) => handlers.item.batteryPickupRequest(socket, data));

    socket.on('batteryDropRequest', (data) => handlers.item.batteryDropRequest(socket, data));

    socket.on('batteryPlaceRequest', (data) => handlers.item.batteryPlaceRequest(socket, data));

    // Inventory item drop/pickup (server-authoritative, for HexStat-style items)
    socket.on('inventoryDropRequest', (data) => {
        // data: { items: [{ label, rarityName, color }], x, y, baseAngle, speed }
        for (const [roomId, room] of rooms) {
            if (!room.players.has(socket.id)) continue;
            const items = Array.isArray(data?.items) ? data.items : [];
            const count = Math.min(10, Math.max(1, items.length));
            const created = [];
            const baseX = Number(data.x) || 0;
            const baseY = Number(data.y) || 0;
            
            for (let i = 0; i < count; i++) {
                const d = items[i]; if (!d) continue;
                const id = `itm_${room.nextItemId++}`;
                const ang = (data.baseAngle || 0) + (i * (2 * Math.PI / Math.max(1, count)));
                
                // Find a clear position for this item
                const pos = room.findClearGroundPosition(baseX, baseY, ang);
                
                // Create item with resolved position and minimal velocity (just for visual effect)
                const item = { 
                    id, 
                    x: pos.x, 
                    y: pos.y, 
                    vx: 0, 
                    vy: 0, 
                    label: d.label, 
                    rarityName: d.rarityName, 
                    color: d.color,
                    // Preserve stat data for re-pickup
                    statKey: d.statKey,
                    bonusValue: d.bonusValue,
                    isPercent: d.isPercent,
                    rarity: d.rarity,
                    // Preserve heal tracking so each player only gets healed once per item
                    suppressHealForPlayerId: d.suppressHealForPlayerId
                };
                room.groundItems.set(id, item);
                created.push(item);
            }
            // Remove dropped items from server-side inventory and recalculate stats
            const player = room.players.get(socket.id);
            if (player && created.length > 0 && Array.isArray(player.inventory)) {
                const beforeHP = player.health;
                const beforeMaxHP = player.healthMax;
                const beforeSpeed = player.speed;
                const beforeInventorySize = player.inventory.length;
                
                console.log(`[Server] Player ${socket.id} dropping ${created.length} items from inventory of ${beforeInventorySize}`);
                
                // Remove only the dropped items from inventory (match by statKey + bonusValue)
                for (let i = 0; i < items.length; i++) {
                    const droppedItem = items[i];
                    if (!droppedItem) continue;
                    
                    // Find and remove the first matching item in server inventory
                    const matchIdx = player.inventory.findIndex(invItem => 
                        invItem && 
                        invItem.statKey === droppedItem.statKey && 
                        invItem.bonusValue === droppedItem.bonusValue &&
                        invItem.isPercent === droppedItem.isPercent
                    );
                    
                    if (matchIdx !== -1) {
                        player.inventory.splice(matchIdx, 1);
                        console.log(`[Server]   Removed ${droppedItem.label} from inventory (was at index ${matchIdx})`);
                    }
                }
                
                // Reset last eligible health bonus before recalculating
                player._lastEligibleHealthBonus = 0;
                
                // Update loot level to match inventory size
                player.lootLevel = player.inventory.length;
                
                // Recalculate stats with remaining inventory items
                room.recalculatePlayerStats(player);
                
                console.log(`[Server] After drop: Inventory ${beforeInventorySize}Ã¢â€ â€™${player.inventory.length}, lootLevel=${player.lootLevel}, HP ${beforeHP}/${beforeMaxHP}Ã¢â€ â€™${player.health}/${player.healthMax}, Speed ${beforeSpeed.toFixed(0)}Ã¢â€ â€™${player.speed.toFixed(0)}`);
            }
            
            if (created.length > 0) io.to(roomId).emit('inventoryDropped', { items: created });
            break;
        }
    });

    socket.on('inventoryPickupRequest', (data) => handlers.item.inventoryPickupRequest(socket, data));
    
    socket.on('invincibilityToggle', (data) => handlers.player.invincibilityToggle(socket, data));
    socket.on('useHealthPotion', (data) => handlers.player.useHealthPotion(socket, data));
    
    socket.on('npcDamage', (data) => handlers.npc.npcDamage(socket, data));
    
    socket.on('npcDot', (data) => handlers.npc.npcDot(socket, data));
    
    // Bullet firing synchronization
    // Phase 2: Use extracted combat handlers
    socket.on('bulletFired', (data) => handlers.combat.bulletFired(socket, data));
    socket.on('weapon7Hitscan', (data) => handlers.combat.weapon7Hitscan(socket, data));
    socket.on('weapon8Hitscan', (data) => handlers.combat.weapon8Hitscan(socket, data));
    socket.on('explosionDamage', (data) => handlers.combat.explosionDamage(socket, data));
    socket.on('projectileHit', (data) => handlers.combat.projectileHit(socket, data));
    socket.on('dotTick', (data) => handlers.combat.dotTick(socket, data));
    socket.on('enemyDied', (data) => handlers.combat.enemyDied(socket, data));
    socket.on('chestDamage', (data) => handlers.combat.chestDamage(socket, data));
    socket.on('barrelDamage', (data) => handlers.combat.barrelDamage(socket, data));
    socket.on('artifactDamage', (data) => handlers.combat.artifactDamage(socket, data));
    socket.on('killGhostEnemy', (data) => handlers.combat.killGhostEnemy(socket, data));
    socket.on('vfxCreated', (data) => handlers.debug.vfxCreated(socket, data));
    
    // Phase 3: Ability handlers
    socket.on('abilityCreate', (data) => handlers.ability.abilityCreate(socket, data));
    socket.on('abilityDamage', (data) => handlers.ability.abilityDamage(socket, data));
    socket.on('abilityTrigger', (data) => handlers.ability.abilityTrigger(socket, data));
    socket.on('abilityDotDamage', (data) => handlers.ability.abilityDotDamage(socket, data));
    
    // Phase 2: weapon7Hitscan extracted to handlers.combat.weapon7Hitscan
    
    // Phase 2: weapon8Hitscan extracted to handlers.combat.weapon8Hitscan

    // VFX synchronization
    // Phase 2: explosionDamage extracted to handlers.combat.explosionDamage
    // Phase 2: projectileHit extracted to handlers.combat.projectileHit
    
    // Phase 2: chestDamage extracted to handlers.combat.chestDamage
    
    // Barrel damage handler (exploding barrels)
    socket.on('barrelDamage', (data) => {
        // data: { barrelId, damage, x, y }
        for (const [roomId, room] of rooms) {
            if (!room.players.has(socket.id)) continue;
            
            if (room.hazards && typeof room.hazards.damageBarrel === 'function') {
                const damage = Number(data.damage) || 10;
                room.hazards.damageBarrel(data.barrelId, damage, data.x, data.y);
            }
            
            break;
        }
    });
    
    // Artifact damage handler (artifact inherits chest health)
    socket.on('artifactDamage', (data) => {
        // data: { chestId, damage }
        for (const [roomId, room] of rooms) {
            if (!room.players.has(socket.id)) continue;
            
            const chest = room.chests.get(data.chestId);
            if (!chest || chest.variant !== 'gold' || !chest.opened) break;
            
            // Apply damage to artifact (uses same health pool as chest)
            const damage = Number(data.damage) || 0;
            if (damage > 0 && chest.health > 0) {
                chest.health = Math.max(0, chest.health - damage);
                
                // Broadcast health update and hit flash to all clients
                io.to(roomId).emit('artifactHealthUpdate', {
                    chestId: chest.id,
                    health: chest.health,
                    healthMax: chest.healthMax
                });
                io.to(roomId).emit('artifactHitFlash', {
                    chestId: chest.id
                });
                
                // Debug logging (throttled)
                if (!chest._lastDamageLog || Date.now() - chest._lastDamageLog >= 1000) {
                    console.log(`[Server] Artifact ${chest.id} took ${damage} damage, health: ${chest.health}/${chest.healthMax}`);
                    chest._lastDamageLog = Date.now();
                }
                
                // Artifact can be destroyed - handle however needed
                if (chest.health <= 0) {
                    console.log(`[Server] Artifact ${chest.id} destroyed!`);
                    // Broadcast artifact destruction
                    io.to(roomId).emit('artifactDestroyed', { chestId: chest.id });
                }
            }
            
            break;
        }
    });
    
    // Phase 2: killGhostEnemy extracted to handlers.combat.killGhostEnemy
    
    // Phase 2: enemyDied extracted to handlers.combat.enemyDied
    // Phase 2: dotTick extracted to handlers.combat.dotTick

    socket.on('debugSpawnHorde', (data = {}) => handlers.debug.debugSpawnHorde(socket, data));

    socket.on('npcSetState', (data) => handlers.npc.npcSetState(socket, data));

    // Quartermaster requisition: grant 1 Common loot + 10 blood markers + 30 ducats (server-authoritative)
    socket.on('quartermasterRequisition', (data = {}) => handlers.shop.quartermasterRequisition(socket, data));
    
    // Debug command for setting player values (useful for testing)
    socket.on('debugSetValue', (data) => {
        console.log('[Server Debug] Received debugSetValue:', data, 'from', socket.id);
        
        if (!data || !data.key) {
            console.log('[Server Debug] Invalid data, ignoring');
            return;
        }
        
        let foundRoom = false;
        for (const [roomId, room] of rooms) {
            if (!room.players.has(socket.id)) continue;
            
            foundRoom = true;
            const player = room.players.get(socket.id);
            if (!player) {
                console.log('[Server Debug] Player not found in room');
                break;
            }
            
            // Only allow certain safe properties to be set
            const allowedKeys = ['ducats', 'bloodMarkers', 'victoryPoints', 'health', 'stamina'];
            if (allowedKeys.includes(data.key)) {
                const oldValue = player[data.key];
                player[data.key] = Number(data.value) || 0;
                console.log(`[Server Debug] Set ${socket.id.substring(0,8)}.${data.key}: ${oldValue} Ã¢â€ â€™ ${player[data.key]}`);
                
                // Broadcast the change immediately
                console.log('[Server Debug] Broadcasting game state...');
                room.broadcastGameState();
                console.log('[Server Debug] Broadcast complete');
            } else {
                console.log('[Server Debug] Key not allowed:', data.key);
            }
            break;
        }
        
        if (!foundRoom) {
            console.log('[Server Debug] Player not in any room');
        }
    });
    // Phase 3: All ability handlers extracted to abilityHandlers.js

    socket.on('invisibilityToggle', (data) => handlers.player.invisibilityToggle(socket, data));
    
    // ===== MERCHANT SHOP =====
    
    socket.on('requestShopInventory', () => handlers.shop.requestShopInventory(socket));
    
    socket.on('purchaseShopItem', (data) => handlers.shop.purchaseShopItem(socket, data));
    
    socket.on('disconnect', () => {
        console.log(`Client disconnected: ${socket.id}`);
        serverDebugger.playerDisconnect(socket.id, 'unknown', 'client disconnect');
        
        // Remove player from all rooms
        for (const [roomId, room] of rooms) {
            if (room.players.has(socket.id)) {
                room.removePlayer(socket.id);
                break;
            }
        }
    });
});

const PORT = SERVER_CONFIG.PORT;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Game server running on port ${PORT}`);
});
