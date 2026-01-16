/**
 * GameRoom - Main game room coordinator
 * Manages room lifecycle and delegates to specialized managers
 * VERSION: 2024-10-27-v2 (414 lines, refactored with managers)
 */

const { SERVER_CONFIG } = require('../core/serverConfig.js');
const ServerNPCManager = require('../npc/ServerNPC.js');
const { HordeSpawner } = require('./HordeSpawner.js');
const { AmbientSpawner } = require('./AmbientSpawner.js');
const { EnvironmentHazards } = require('../environment/EnvironmentHazards.js');

// Import all managers
const TimerManager = require('./TimerManager.js');
const NetworkManager = require('./NetworkManager.js');
const LootManager = require('./LootManager.js');
const LevelManager = require('./LevelManager.js');
const PlayerPhysics = require('./PlayerPhysics.js');
const PlayerManager = require('./PlayerManager.js');
const CombatManager = require('./CombatManager.js');
const AbilityManager = require('./AbilityManager.js');
const EnemyManager = require('./enemy/EnemyManager.js');

class GameRoom {
    constructor(roomId, io, serverDebugger, DirectorClass, ENABLE_DEBUG_CHESTS) {
        this.id = roomId;
        this.io = io;
        this.players = new Map();
        this.lastTick = Date.now();
        this.tickCount = 0;
        this.boundary = 1000;
        this.scene = 'lobby';
        this.levelType = 'extraction';
        this.levelTypeSetBy = null;
        this.currentGameMode = null;
        
        // Generate deterministic world seed
        this.worldSeed = Math.floor(Math.random() * 1000000000);
        console.log(`[SEED] Generated world seed for room "${roomId}":`, this.worldSeed);
        
        // Initialize managers
        this.levelManager = new LevelManager(this);
        this.networkManager = new NetworkManager(this, serverDebugger);
        this.timerManager = new TimerManager(this);
        this.lootManager = new LootManager(this);
        this.lootManager.setDebugChestsEnabled(ENABLE_DEBUG_CHESTS);
        this.playerPhysics = new PlayerPhysics(this, serverDebugger);
        this.playerManager = new PlayerManager(this, serverDebugger);
        this.combatManager = new CombatManager(this);
        this.abilityManager = new AbilityManager(this);
        this.enemyManager = new EnemyManager(this, io, DirectorClass);
        
        // Create environment
        this.environment = this.levelManager._createEnvironmentForScene(this.scene);
        console.log(`[ROOM] Created server environment for scene "${this.scene}" with ${this.environment.obstacles.length} obstacles, boundary: ${this.boundary}`);
        
        // Server-side abilities
        this.abilities = new Map();
        
        // Timer states
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
        
        // Game state
        this.chests = new Map();
        this.groundItems = new Map();
        this.nextItemId = 1;
        this.targetDummy = null;
        this.ambientNpcs = [];
        this.ambientSpawned = false;
        this.playerBullets = [];
        this.levelSpawns = null;
        
        // Enemies (NOT extracted yet - keeping in GameRoom)
        this.enemies = new Map();
        this.nextEnemyId = 1;
        this.enemyNetMode = 'spawnOnly';
        this.ENEMY_BROADCAST_HZ = SERVER_CONFIG.ENEMY_BROADCAST_HZ;
        this._enemyBroadcastIntervalMs = 1000 / this.ENEMY_BROADCAST_HZ;
        this._nextEnemyBroadcastTime = 0;
        this.extractionZone = null;
        this.hereticExtractionZone = null;
        this.bossSpawn = null;
        this._enemyDirectors = new Map();
        this._enemyIdMap = new Map();
        this._enemyIdCounter = 1;
        this._ambientDebug = { spawnedTotal: 0, lastSpawnLog: 0 };
        this.boomerPools = [];
        this.enemyProjectiles = [];
        this.DirectorClass = DirectorClass;  // Store for enemy AI (added to constructor params)
        
        // NPC manager
        this.npcManager = new ServerNPCManager(this, io);
        
        // Merchant shop
        this.shopInventory = [];
        this._shopNeedsRefresh = true; // Refresh on first player join or mission return
        
        // Loop scheduling
        this._destroyed = false;
        this._tickIntervalMs = 1000 / SERVER_CONFIG.TICK_RATE;
        this._broadcastIntervalMs = 1000 / SERVER_CONFIG.BROADCAST_RATE;
        this._tickHandle = null;
        this._broadcastHandle = null;
        this._nextTickTime = null;
        this._nextBroadcastTime = null;
        this._lastBroadcastState = new Map();
        this._fullStateBroadcastCounter = 0;
        this._fullStateBroadcastInterval = 10;
        this._lowPriorityBroadcastIntervalMs = 1000 / SERVER_CONFIG.BROADCAST_RATE_LOW;
        this._lowPriorityBroadcastHandle = null;
        this._nextLowPriorityBroadcastTime = null;
        
        // Start loops
        this.tick();
        this._nextTickTime = Date.now() + this._tickIntervalMs;
        this._scheduleTickLoop();
        this._nextBroadcastTime = Date.now() + this._broadcastIntervalMs;
        this._scheduleBroadcastLoop();
        this._nextLowPriorityBroadcastTime = Date.now() + this._lowPriorityBroadcastIntervalMs;
        this._scheduleLowPriorityBroadcastLoop();
        
        // Spawners
        this.hordeSpawner = new HordeSpawner(this);
        this.ambientSpawner = new AmbientSpawner(this);
        
        // Environment hazards
        this.hazards = null; // Will be initialized when level starts
    }
    
    // ===== DELEGATION METHODS =====
    
    // Timer methods
    startReadyTimer(playerId, levelType) { return this.timerManager.startReadyTimer(playerId, levelType); }
    cancelReadyTimer() { return this.timerManager.cancelReadyTimer(); }
    updateReadyTimer(deltaTime) { return this.timerManager.updateReadyTimer(deltaTime); }
    emitReadyTimerState(socket) { return this.timerManager.emitReadyTimerState(socket); }
    startExtractionTimer(playerId, timerType) { return this.timerManager.startExtractionTimer(playerId, timerType); }
    cancelExtractionTimer() { return this.timerManager.cancelExtractionTimer(); }
    updateExtractionTimer(deltaTime) { return this.timerManager.updateExtractionTimer(deltaTime); }
    emitExtractionTimerState(socket) { return this.timerManager.emitExtractionTimerState(socket); }
    resetToLobby() { return this.timerManager.resetToLobby(); }
    
    // Network methods
    sendRoomSnapshot(socket) { return this.networkManager.sendRoomSnapshot(socket); }
    getGameState() { return this.networkManager.getGameState(); }
    getGameStateDelta() { return this.networkManager.getGameStateDelta(); }
    broadcastGameState() { return this.networkManager.broadcastGameState(); }
    broadcastLowPriorityState() { return this.networkManager.broadcastLowPriorityState(); }
    broadcastEnemiesState() { return this.networkManager.broadcastEnemiesState(); }
    _getEnemiesStatePayload() { return this.networkManager._getEnemiesStatePayload(); }
    
    // Loot methods
    startChestOpening(socketId, data) { return this.lootManager.startChestOpening(socketId, data); }
    _generateBrownDrops(chestId, dropCount) { return this.lootManager._generateBrownDrops(chestId, dropCount); }
    _generateBossLoot(enemyId) { return this.lootManager._generateBossLoot(enemyId); }
    _generateEnemyDrops(enemyId, enemyType) { return this.lootManager._generateEnemyDrops(enemyId, enemyType); }
    findClearGroundPosition(baseX, baseY, angle, itemRadius, maxAttempts) { return this.lootManager.findClearGroundPosition(baseX, baseY, angle, itemRadius, maxAttempts); }
    _spawnDebugChestsNearPlayers() { return this.lootManager._spawnDebugChestsNearPlayers(); }
    // Utility methods used by spawners and socket handlers
    _rng(seed) { return this.lootManager._rng(seed); }
    _hashChestId(id) { return this.lootManager._hashChestId(id); }
    _computeStatBonus(label, rarityName) { return this.lootManager._computeStatBonus(label, rarityName); }
    
    // Level methods
    _createEnvironmentForScene(scene) { return this.levelManager._createEnvironmentForScene(scene); }
    setLevelType(playerId, levelType) { return this.levelManager.setLevelType(playerId, levelType); }
    getModeClass(levelType) { return this.levelManager.getModeClass(levelType); }
    _legacyComputeLevelSpawns() { return this.levelManager._legacyComputeLevelSpawns(); }
    _legacyComputeEnemySpawns() { return this.levelManager._legacyComputeEnemySpawns(); }
    // Aliases for backward compatibility (SocketHandlers uses these names)
    _computeLevelSpawns() { return this.levelManager._legacyComputeLevelSpawns(); }
    _computeEnemySpawns() { return this.levelManager._legacyComputeEnemySpawns(); }
    generateRandomSpawnPosition(seed) { return this.levelManager.generateRandomSpawnPosition(seed); }
    _computeExtractionAndBossSpawns() { return this.levelManager._computeExtractionAndBossSpawns(); }
    broadcastAmbientNpcs() { return this.levelManager.broadcastAmbientNpcs(); }
    
    // Player methods
    addPlayer(socket, playerData) { return this.playerManager.addPlayer(socket, playerData); }
    removePlayer(socketId) { return this.playerManager.removePlayer(socketId); }
    recalculatePlayerStats(player) { return this.playerManager.recalculatePlayerStats(player); }
    updatePlayerInput(socketId, input) { return this.playerManager.updatePlayerInput(socketId, input); }
    
    // Physics methods
    updatePlayerStamina(player, input, deltaTime) { return this.playerPhysics.updatePlayerStamina(player, input, deltaTime); }
    updatePlayerMovement(player, input, deltaTime) { return this.playerPhysics.updatePlayerMovement(player, input, deltaTime); }
    
    // Combat methods
    updatePlayerDots(deltaTime) { return this.combatManager.updatePlayerDots(deltaTime); }
    updatePlayerBullets(deltaTime) { return this.combatManager.updatePlayerBullets(deltaTime); }
    updateBoomerPools(deltaTime) { return this.combatManager.updateBoomerPools(deltaTime); }
    
    // Ability methods
    updateAbilities(now, deltaTime) { return this.abilityManager.updateAbilities(now, deltaTime); }
    spawnLobbyAmbientNpcs() { return this.enemyManager.spawnLobbyAmbientNpcs(); }
    
    // Target dummy movement (ping-pong motion for lobby shooting gallery)
    updateTargetDummy(deltaTime) {
        // Debug: Check if method is called (console.error always prints)
        if (!this._updateDummyDebugCount) this._updateDummyDebugCount = 0;
        if (this._updateDummyDebugCount < 5) {
            this._updateDummyDebugCount++;
            console.error(`[TargetDummy] updateTargetDummy called #${this._updateDummyDebugCount}: scene='${this.scene}', enemies.size=${this.enemies.size}`);
        }
        
        if (this.scene !== 'lobby') return;
        
        // Debug: Log target dummy state
        if (!this._targetDummyDebugTimer) this._targetDummyDebugTimer = 0;
        this._targetDummyDebugTimer += deltaTime;
        const shouldDebug = this._targetDummyDebugTimer >= 2.0; // Log every 2 seconds
        if (shouldDebug) this._targetDummyDebugTimer = 0;
        
        let movingCount = 0;
        let staticCount = 0;
        
        // Update all target dummies that have movement data
        for (const enemy of this.enemies.values()) {
            if (!enemy || enemy.type !== 'targetDummy') continue;
            
            if (!enemy._move || enemy.alive === false) {
                staticCount++;
                if (shouldDebug) {
                    console.log(`[TargetDummy] ${enemy.id}: STATIC at (${enemy.x?.toFixed(1)}, ${enemy.y?.toFixed(1)}) alive=${enemy.alive} hasMove=${!!enemy._move}`);
                }
                continue;
            }
            
            movingCount++;
            const m = enemy._move;
            const oldPos = m.axis === 'x' ? enemy.x : enemy.y;
            
            // Handle pause at lane endpoints
            if (m.wait > 0) {
                m.wait -= deltaTime;
                if (m.wait <= 0) {
                    m.wait = 0;
                    // Resume movement in opposite direction
                    m.dir *= -1;
                    if (shouldDebug) {
                        console.log(`[TargetDummy] ${enemy.id}: PAUSED -> RESUMING dir=${m.dir} at (${enemy.x?.toFixed(1)}, ${enemy.y?.toFixed(1)})`);
                    }
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
                if (shouldDebug) {
                    console.log(`[TargetDummy] ${enemy.id}: HIT MAX BOUND axis=${axis} at ${newPos.toFixed(1)} (max=${m.max.toFixed(1)})`);
                }
            } else if (m.dir < 0 && newPos <= m.min) {
                // Hit min bound
                if (axis === 'x') enemy.x = m.min;
                else enemy.y = m.min;
                m.wait = m.pause; // Pause at endpoint
                if (shouldDebug) {
                    console.log(`[TargetDummy] ${enemy.id}: HIT MIN BOUND axis=${axis} at ${newPos.toFixed(1)} (min=${m.min.toFixed(1)})`);
                }
            } else {
                // Normal movement within bounds
                if (axis === 'x') enemy.x = newPos;
                else enemy.y = newPos;
                const newPosActual = axis === 'x' ? enemy.x : enemy.y;
                if (shouldDebug) {
                    console.log(`[TargetDummy] ${enemy.id}: MOVING axis=${axis} from ${oldPos.toFixed(1)} to ${newPosActual.toFixed(1)} speed=${m.speed} dir=${m.dir}`);
                }
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
                    if (shouldDebug) {
                        console.log(`[TargetDummy] ${enemy.id}: OUT OF BOUNDS - snapping back and reversing`);
                    }
                }
            } catch(_) {}
        }
        
        if (shouldDebug) {
            console.log(`[TargetDummy] Summary: ${movingCount} moving, ${staticCount} static, ${this.enemies.size} total enemies`);
        }
    }
    
    // ===== SCHEDULING LOOPS =====

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
    
    // ===== MAIN TICK METHOD =====
    
    tick() {
        const tickStart = typeof process.hrtime === 'function' ? (typeof process.hrtime.bigint === 'function' ? process.hrtime.bigint() : process.hrtime()) : null;
        const now = Date.now();
        const deltaTime = (now - this.lastTick) / 1000;
        this.lastTick = now;
        this.tickCount++;
        
        // Update timers
        this.updateReadyTimer(deltaTime);
        this.updateExtractionTimer(deltaTime);
        
        // Update game mode
        if (this.currentGameMode && this.scene === 'level') {
            this.currentGameMode.update(deltaTime);
            if (this.ambientSpawner) this.ambientSpawner.update(deltaTime);
            if (this.hazards) this.hazards.update(deltaTime);
        }
        
        // Update abilities and dummy
        this.updateTargetDummy(deltaTime);
        this.updateAbilities(now, deltaTime);
        
        // Update players
        for (const [id, player] of this.players) {
            if (player.lastInput) {
                this.updatePlayerStamina(player, player.lastInput, deltaTime);
                this.updatePlayerMovement(player, player.lastInput, deltaTime);
            }
        }
        
        // Update combat
        this.updatePlayerBullets(deltaTime);
        this.updatePlayerDots(deltaTime);

        // Update gold chest timers
        for (const chest of this.chests.values()) {
            if (chest.opening && !chest.opened && chest.variant !== 'brown') {
                chest.timeLeft -= deltaTime;
                if (chest.timeLeft < 0) chest.timeLeft = 0;
                this.io.to(this.id).emit('chestTimerUpdate', { 
                    id: chest.id, x: chest.x, y: chest.y, variant: chest.variant, 
                    started: chest.timeLeft > 0, timeLeft: chest.timeLeft, timeTotal: chest.timeTotal, 
                    startedBy: chest.startedBy, health: chest.health, healthMax: chest.healthMax 
                });
                if (chest.timeLeft <= 0) {
                    chest.opening = false;
                    chest.opened = true;
                    this.io.to(this.id).emit('chestOpened', { 
                        id: chest.id, x: chest.x, y: chest.y, variant: chest.variant, 
                        artifact: { vx: 160, vy: -220 }, health: chest.health, healthMax: chest.healthMax 
                    });
                    chest.artifactCarriedBy = null;
                    chest.artifactPos = { x: chest.x, y: chest.y };
                }
            }
        }

        // Update enemies via EnemyManager
        if (this.scene === 'level' && this.enemyNetMode === 'authoritative') {
            this.enemyManager.updateEnemies(deltaTime);
            this.updateBoomerPools(deltaTime);
            const nowMs = now;
            if (!Number.isFinite(this._nextEnemyBroadcastTime) || nowMs >= this._nextEnemyBroadcastTime) {
                this.broadcastEnemiesState();
                this._nextEnemyBroadcastTime = nowMs + this._enemyBroadcastIntervalMs;
            }
        }

        // Broadcast lobby target dummy positions (they move via updateTargetDummy)
        // Debug: Check broadcast condition (console.error always prints)
        if (!this._lobbyBroadcastDebugCount) this._lobbyBroadcastDebugCount = 0;
        if (this._lobbyBroadcastDebugCount < 5) {
            this._lobbyBroadcastDebugCount++;
            console.error(`[TargetDummy] Broadcast check #${this._lobbyBroadcastDebugCount}: scene='${this.scene}', enemies.size=${this.enemies.size}, nextBroadcast=${this._nextEnemyBroadcastTime}, now=${now}`);
        }
        
        if (this.scene === 'lobby' && this.enemies.size > 0) {
            const nowMs = now;
            if (!Number.isFinite(this._nextEnemyBroadcastTime) || nowMs >= this._nextEnemyBroadcastTime) {
                // Debug: Log first few broadcasts
                if (!this._lobbyBroadcastCount) this._lobbyBroadcastCount = 0;
                this._lobbyBroadcastCount++;
                if (this._lobbyBroadcastCount <= 3) {
                    console.log(`[TargetDummy] Broadcasting lobby enemies state (broadcast #${this._lobbyBroadcastCount}, ${this.enemies.size} enemies)`);
                }
                this.broadcastEnemiesState();
                this._nextEnemyBroadcastTime = nowMs + this._enemyBroadcastIntervalMs;
            }
        }

        // Update NPCs
        if (this.scene === 'level' && this.npcManager) {
            this.npcManager.update(deltaTime, now);
        }
        
        // Timing debug
        let tickDurationMs = 0;
        if (tickStart !== null) {
            if (typeof tickStart === 'bigint' && typeof process.hrtime.bigint === 'function') {
                tickDurationMs = Number(process.hrtime.bigint() - tickStart) / 1e6;
            } else if (Array.isArray(tickStart) && typeof process.hrtime === 'function') {
                const diff = process.hrtime(tickStart);
                tickDurationMs = diff[0] * 1e3 + diff[1] / 1e6;
            }
        }
    }
    
    // ===== SPAWN METHODS =====
    
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
            spawn: { x: spawnPoint.x, y: spawnPoint.y, template: spawnPoint.template, angle: spawnPoint.angle },
            goal: targetInfo && targetInfo.target ? { x: targetInfo.target.x, y: targetInfo.target.y } : null,
            targetSource: targetInfo ? targetInfo.source : null,
            enemies: enemies.map(e => ({ id: e.id, x: e.x, y: e.y, type: e.type }))
        };
        this.io.to(this.id).emit('hordeSpawned', payload);
        this._nextEnemyBroadcastTime = Date.now();
        console.log(`[GameRoom] Horde spawned (${payload.enemies.length} enemies) in room ${this.id}`, {
            spawn: payload.spawn, targetSource: payload.targetSource
        });
        return result;
    }
    
    spawnAmbientBatch(enemies) {
        try {
            if (!Array.isArray(enemies) || enemies.length === 0) return;
            const payload = {
                spawn: null,
                goal: null,
                targetSource: 'ambient',
                enemies: enemies.map(e => ({ id: e.id, x: e.x, y: e.y, type: e.type, radius: e.radius, health: e.health, healthMax: e.healthMax, speedMul: e.speedMul }))
            };
            this.io.to(this.id).emit('hordeSpawned', payload);
            this._nextEnemyBroadcastTime = Date.now();
        } catch (e) {
            console.warn('[AmbientSpawner] Failed to broadcast ambient batch:', e && e.message ? e.message : String(e));
        }
    }
    
    // ===== ENVIRONMENT HAZARDS =====
    
    initializeHazards() {
        try {
            // Create hazards manager with config from game mode (if available)
            const hazardConfig = this.currentGameMode && this.currentGameMode.config && this.currentGameMode.config.hazards
                ? this.currentGameMode.config.hazards
                : {};
            
            // Pass the mode type so EnvironmentHazards can load the correct HazardsConfig
            const modeType = this.levelType || 'trenchraid';
            this.hazards = new EnvironmentHazards(this, this.environment, hazardConfig, modeType);
            
            // Use new config-based spawning system
            if (this.hazards.hazardsConfig && this.hazards.hazardsConfig.enabled) {
                console.log(`[Hazards] Spawning hazards for mode: ${modeType}`);
                
                // Spawn sandbags using configured strategy
                this.hazards.spawnSandbags();
                
                // Spawn exploding barrels
                this.hazards.spawnExplodingBarrels();
                
                // Spawn other hazards (when implemented)
                // this.hazards.spawnBarbedWire();
                // this.hazards.spawnMudPools();
                // etc.
            } else {
                // Fallback to legacy left-edge test row (for backward compatibility)
                console.log('[Hazards] Using legacy left-edge test row (config disabled for this mode)');
                this.hazards.spawnLeftEdgeRow();
            }
            
            // Broadcast to all clients
            this.broadcastHazardsState();
            
            console.log('[Hazards] Initialization complete');
        } catch (e) {
            console.error('[Hazards] Failed to initialize:', e);
        }
    }
    
    broadcastHazardsState(socket = null) {
        try {
            if (!this.hazards) return;
            const payload = this.hazards.serialize();
            if (socket) {
                socket.emit('hazardsState', payload);
            } else {
                this.io.to(this.id).emit('hazardsState', payload);
            }
        } catch (e) {
            console.error('[Hazards] Failed to broadcast state:', e);
        }
    }
    
    // ===== MERCHANT SHOP =====
    
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
        
        // 4 Hat placeholders
        for (let i = 0; i < 4; i++) {
            items.push({
                label: 'Hat',
                rarityName: '',
                color: '#666',
                price: 0,
                sold: false,
                placeholder: true
            });
        }
        
        // 4 Skin placeholders
        for (let i = 0; i < 4; i++) {
            items.push({
                label: 'Skin',
                rarityName: '',
                color: '#666',
                price: 0,
                sold: false,
                placeholder: true
            });
        }
        
        this.shopInventory = items;
        this._shopNeedsRefresh = false;
        console.log('[SHOP] Generated new shop inventory with', items.filter(i => !i.placeholder).length, 'items for sale');
    }
    
    _createSeededRNG(seed) {
        let state = seed;
        return function() {
            state = (state * 9301 + 49297) % 233280;
            return state / 233280;
        };
    }
    
    refreshShopIfNeeded() {
        if (this._shopNeedsRefresh) {
            this._generateShopInventory();
        }
    }
    
    markShopForRefresh() {
        this._shopNeedsRefresh = true;
        console.log('[SHOP] Marked shop for refresh on next request');
    }
    
    getShopInventory() {
        this.refreshShopIfNeeded();
        return this.shopInventory;
    }
    
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
        
        if ((player.ducats || 0) < item.price) {
            console.warn('[SHOP] Purchase failed: insufficient ducats');
            return { success: false, reason: 'Insufficient ducats' };
        }
        
        // Deduct ducats
        player.ducats = (player.ducats || 0) - item.price;
        
        // Add item to player inventory using the same HexStat structure
        const inventoryItem = {
            type: 'HexStat',
            label: item.label,
            rarityName: item.rarityName,
            color: item.color,
            // Note: bonusValue and isPercent will be computed client-side when applying stats
        };
        
        if (!Array.isArray(player.inventory)) {
            player.inventory = [];
        }
        player.inventory.push(inventoryItem);
        
        // Mark item as sold
        item.sold = true;
        
        console.log(`[SHOP] Player ${socketId} purchased ${item.label} (${item.rarityName}) for ${item.price} ducats`);
        
        return { 
            success: true, 
            item: inventoryItem,
            newDucats: player.ducats,
            newInventory: player.inventory
        };
    }
    
    // ===== CLEANUP =====
    
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
        // Cleanup managers
        if (this.abilityManager) {
            this.abilityManager.cleanup();
        }
    }
    
    // ===== ENEMY SYSTEM =====
    // Enemy AI is now managed by EnemyManager and its subsystems:
    // - EnemyBehaviors: Boss, BigBoy, Boomer, projectile zombie behaviors
    // - EnemyMovement: Director-based pathfinding and grouping
    // - EnemyProjectiles: Ranged attacks and projectile updates
    // - EnemyCollision: Contact damage and Licker tentacle mechanics
}

module.exports = GameRoom;
