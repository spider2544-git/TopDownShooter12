/**
 * TimerManager - Manages ready timer and extraction timer for GameRoom
 * 
 * Extracted from GameRoom (Phase 1 of incremental manager extraction)
 * 
 * Handles:
 * - Ready timer (lobby countdown before level start)
 * - Extraction timer (extraction zone countdown)
 */

// Import required modules
const GameModeConfigs = require('../../levels/GameModeConfigs.js');
const { SeededRNG } = require('../core/seededRNG.js');
const { EnvironmentHazards } = require('../environment/EnvironmentHazards.js');

class TimerManager {
    /**
     * @param {GameRoom} room - Reference to the parent GameRoom for state access
     */
    constructor(room) {
        this.room = room;
    }

    // =========================================
    // READY TIMER METHODS
    // =========================================

    emitReadyTimerState(targetSocket) {
        const payload = {
            started: this.room.readyTimer.started,
            completed: this.room.readyTimer.completed,
            timeLeft: this.room.readyTimer.timeLeft,
            timeTotal: this.room.readyTimer.timeTotal,
            startedBy: this.room.readyTimer.startedBy
        };
        if (targetSocket) targetSocket.emit('readyTimerUpdate', payload);
        else this.room.io.to(this.room.id).emit('readyTimerUpdate', payload);
    }

    startReadyTimer(startedByPlayerId, levelType = 'extraction') {
        // Only start in lobby; ignore if already running or completed
        if (this.room.scene !== 'lobby') return;
        if (this.room.readyTimer.started || this.room.readyTimer.completed) return;
        
        // #region agent log
        console.log('[DEBUG H2] Ready timer starting:', {levelType, hasCachedNav:!!this.room._navDebug, hasCachedWalls:!!this.room._precomputedTrenchWalls});
        fetch('http://127.0.0.1:7242/ingest/10317113-f3de-4c2b-9a23-83892ed269d3',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'server.js:startReadyTimer:entry',message:'Ready timer starting',data:{levelType,hasCachedNav:!!this.room._navDebug,hasCachedWalls:!!this.room._precomputedTrenchWalls},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H2'})}).catch(()=>{});
        // #endregion
        
        // Store the selected level type
        this.room.levelType = levelType || 'extraction';
        console.log(`[Server] Ready timer started in room ${this.room.id} by ${startedByPlayerId} for level: ${this.room.levelType}`);

        // Navmesh is now precomputed when levelType is set (in setLevelType), not here
        
        this.room.readyTimer.started = true;
        this.room.readyTimer.completed = false;
        this.room.readyTimer.timeLeft = Number.isFinite(this.room.readyTimer.timeTotal) ? this.room.readyTimer.timeTotal : 10.0;
        this.room.readyTimer.startedBy = startedByPlayerId || null;
        this.emitReadyTimerState();
    }

    cancelReadyTimer() {
        if (!this.room.readyTimer.started || this.room.readyTimer.completed) return;
        this.room.readyTimer.started = false;
        this.room.readyTimer.timeLeft = 0;
        this.room.readyTimer.startedBy = null;
        console.log(`[Server] Ready timer cancelled in room ${this.room.id}`);
        this.emitReadyTimerState();
    }

    updateReadyTimer(deltaTime) {
        if (!this.room.readyTimer.started || this.room.readyTimer.completed) return;

        this.room.readyTimer.timeLeft -= deltaTime;
        if (this.room.readyTimer.timeLeft < 0) this.room.readyTimer.timeLeft = 0;

        this.emitReadyTimerState();

        if (this.room.readyTimer.timeLeft <= 0) {
            this.room.readyTimer.timeLeft = 0;
            this.room.readyTimer.started = false;
            this.room.readyTimer.completed = true;
            console.log(`[Server] Ready timer completed in room ${this.room.id} - Starting level: ${this.room.levelType}`);

            this.room.scene = 'level';
            this.room.boundary = 11000;
            
            // Track level start time for artillery barrage delay (7 minutes)
            this.room.levelStartTime = Date.now();

            this.room.environment = this.room._createEnvironmentForScene(this.room.scene);
            console.log(`[READY_TIMER] Recreated server environment for level: ${this.room.environment.obstacles.length} obstacles, boundary: ${this.room.boundary}`);

            // Enable server-authoritative enemy movement when level starts
            this.room.enemyNetMode = 'authoritative';
            this.room._nextEnemyBroadcastTime = Date.now();

            // Initialize game mode system
            const modeConfig = GameModeConfigs.get(this.room.levelType);
            this.room.gameModeConfig = modeConfig; // Store config for respawn logic
            const ModeClass = this.room.getModeClass(this.room.levelType);
            this.room.currentGameMode = new ModeClass(this.room, modeConfig);
            this.room.currentGameMode.onLevelStart();
            console.log(`[GameMode] Initialized ${modeConfig.name} mode`);
            
            // Update extraction zone timer from mode config
            if (modeConfig.timers && typeof modeConfig.timers.extractionZone === 'number') {
                this.room.extractionTimer.timeTotal = modeConfig.timers.extractionZone;
                console.log(`[GameMode] Set extraction zone timer to ${this.room.extractionTimer.timeTotal}s`);
            }
            
            // Update environment spawn safe position based on game mode (e.g., trench raid left-side spawn)
            if (modeConfig.spawn && typeof modeConfig.spawn.x === 'number' && typeof modeConfig.spawn.y === 'number') {
                this.room.environment.spawnSafeX = modeConfig.spawn.x;
                this.room.environment.spawnSafeY = modeConfig.spawn.y;
                this.room.environment.spawnSafeRadius = modeConfig.spawn.radius || 200;
                console.log(`[GameMode] Updated spawn safe zone to (${modeConfig.spawn.x}, ${modeConfig.spawn.y}) radius ${this.room.environment.spawnSafeRadius}`);
            }
            
            // Clear random obstacles from gap areas FIRST (before adding defensive walls)
            if (this.room.currentGameMode && typeof this.room.currentGameMode.getGapPositions === 'function') {
                const gapPositions = this.room.currentGameMode.getGapPositions();
                if (Array.isArray(gapPositions) && gapPositions.length > 0) {
                    this.room.environment.clearGapAreas(gapPositions);
                }
            }

            // Trench Raid specific: clear NEW ANTIOCH back area (far left behind turrets)
            try {
                if (this.room.levelType === 'trenchraid' && this.room.environment && this.room.environment.clearGapAreas) {
                    // Map edges: -6000..+6000, New Antioch wall at -4200
                    const leftEdge = -6000;
                    const wallX = -4200;
                    const width = (wallX - leftEdge); // 1800
                    const height = (this.room.environment.height || 3000); // full vertical extent
                    const area = [{
                        x: leftEdge + width / 2,
                        y: 0,
                        width: Math.max(0, width - 60), // small buffer to not touch wall visuals
                        height: height,
                        clearRadius: 0
                    }];
                    this.room.environment.clearGapAreas(area);
                    console.log('[GameMode][TrenchRaid] Cleared obstacles in New Antioch back area');
                }
            } catch (e) {
                console.warn('[GameMode][TrenchRaid] Failed clearing New Antioch area:', e && e.message ? e.message : String(e));
            }

            // Trench Raid specific: clear HERETIC back area (far right behind red walls)
            try {
                if (this.room.levelType === 'trenchraid' && this.room.environment && this.room.environment.clearGapAreas) {
                    // Map edges: -6000..+6000, Heretic wall at +4200
                    const rightEdge = 6000;
                    const hereticWallX = 4200;
                    const width = (rightEdge - hereticWallX); // 1800
                    const height = (this.room.environment.height || 3000); // full vertical extent
                    const hereticArea = [{
                        x: hereticWallX + width / 2,
                        y: 0,
                        width: Math.max(0, width - 60), // small buffer to not touch wall visuals
                        height: height,
                        clearRadius: 0
                    }];
                    this.room.environment.clearGapAreas(hereticArea);
                    console.log('[GameMode][TrenchRaid] Cleared obstacles in Heretic back area');
                }
            } catch (e) {
                console.warn('[GameMode][TrenchRaid] Failed clearing Heretic area:', e && e.message ? e.message : String(e));
            }
            
            // Add mode-specific obstacles AFTER clearing gaps (e.g., trench raid defensive walls)
            if (this.room.currentGameMode && typeof this.room.currentGameMode.getDefensiveWalls === 'function') {
                const walls = this.room.currentGameMode.getDefensiveWalls();
                if (Array.isArray(walls) && walls.length > 0) {
                    this.room.environment.obstacles.push(...walls);
                    console.log(`[GameMode] Added ${walls.length} defensive wall obstacles to environment`);
                }
            }

            // Add trench walls (rotatable long walls) for Trench Raid mode
            if (this.room.levelType === 'trenchraid' && this.room.currentGameMode && typeof this.room.currentGameMode.getTrenchWalls === 'function') {
                // #region agent log
                console.log('[DEBUG H1] Before wall selection:', {hasCachedWalls:!!(this.room._precomputedTrenchWalls&&this.room._precomputedTrenchWalls.length>0), cacheLength:this.room._precomputedTrenchWalls?.length||0});
                fetch('http://127.0.0.1:7242/ingest/10317113-f3de-4c2b-9a23-83892ed269d3',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'server.js:updateReadyTimer:beforeWalls',message:'Before wall selection',data:{hasCachedWalls:!!(this.room._precomputedTrenchWalls&&this.room._precomputedTrenchWalls.length>0),cacheLength:this.room._precomputedTrenchWalls?.length||0},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H1'})}).catch(()=>{});
                // #endregion
                const trenchWalls = (Array.isArray(this.room._precomputedTrenchWalls) && this.room._precomputedTrenchWalls.length > 0)
                    ? this.room._precomputedTrenchWalls
                    : this.room.currentGameMode.getTrenchWalls();
                if (Array.isArray(trenchWalls) && trenchWalls.length > 0) {
                    // Add to orientedBoxes for collision (supports rotation)
                    if (!this.room.environment.orientedBoxes) {
                        this.room.environment.orientedBoxes = [];
                    }
                    
                    for (const wall of trenchWalls) {
                        this.room.environment.orientedBoxes.push({
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
                    fetch('http://127.0.0.1:7242/ingest/10317113-f3de-4c2b-9a23-83892ed269d3',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'server.js:updateReadyTimer:wallsAdded',message:'Trench walls added',data:{actualWallCount:trenchWalls.length,usedCache:!!(this.room._precomputedTrenchWalls&&trenchWalls===this.room._precomputedTrenchWalls)},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H1'})}).catch(()=>{});
                    // #endregion
                }
            }

            // Initialize hazards using new config-based system
            try {
                // Create hazards manager with config from game mode (if available)
                const hazardConfig = modeConfig && modeConfig.hazards ? modeConfig.hazards : {};
                
                // Pass the mode type so EnvironmentHazards can load the correct HazardsConfig
                const modeType = this.room.levelType || 'trenchraid';
                this.room.hazards = new EnvironmentHazards(this.room, this.room.environment, hazardConfig, modeType);
                
                // Use new config-based spawning system
                if (this.room.hazards.hazardsConfig && this.room.hazards.hazardsConfig.enabled) {
                    console.log(`[Hazards] Spawning hazards for mode: ${modeType}`);
                    
                    // Initialize hazard arrays (previously done by spawnLeftEdgeRow's _resetAll())
                    this.room.hazards._resetAll();
                    
                    // Spawn sandbags using configured strategy
                    this.room.hazards.spawnSandbags();
                    
                    // Spawn barbed wire (triple concertina fences in clusters of 2-3)
                    this.room.hazards.spawnBarbedWire();
                    
                    // Spawn mud pools (clusters of 1-4, drawn underneath as ground decals)
                    this.room.hazards.spawnMudPools();
                    
                    // Spawn fire pools (5 individual pools, rare hazard with fire damage and smoke)
                    this.room.hazards.spawnFirePools();
                    
                    // Spawn gas canisters (clusters of 3-8, vision impairment only)
                    this.room.hazards.spawnGasCanisters();
                    
                    // Spawn exploding barrels (clusters + scattered on New Antioch side)
                    this.room.hazards.spawnExplodingBarrels();
                    
                    // Spawn other hazards (when implemented)
                    // etc.
                } else {
                    // Hazards disabled or not configured for this mode
                    console.log('[Hazards] Hazards disabled or not configured for this mode');
                }
                
                // Broadcast hazards to all clients
                const hazardsPayload = this.room.hazards.serialize();
                this.room.io.to(this.room.id).emit('hazardsState', hazardsPayload);
                console.log('[Hazards] Broadcast hazardsState to clients:', {
                    sandbags: hazardsPayload.sandbags?.length || 0,
                    wire: hazardsPayload.barbedWire?.length || 0,
                    mud: hazardsPayload.mudPools?.length || 0,
                    barrels: hazardsPayload.explodingBarrels?.length || 0
                });
            } catch (e) {
                console.warn('[Hazards] Failed to initialize hazards:', e && e.message ? e.message : String(e));
                this.room.hazards = null;
            }

            // Configure AmbientSpawner from mode config (if provided)
            try {
                const ambientCfg = modeConfig.ambient || {};
                if (this.room.ambientSpawner) {
                    const cfg = {};
                    if (typeof ambientCfg.enabled === 'boolean') cfg.ENABLED = ambientCfg.enabled;
                    if (Array.isArray(ambientCfg.tiers)) cfg.TIERS = ambientCfg.tiers;
                    if (Object.keys(cfg).length > 0) {
                        this.room.ambientSpawner.config = { ...this.room.ambientSpawner.config, ...cfg };
                    }
                    this.room.ambientSpawner.onLevelStart();
                }
            } catch (e) {
                console.warn('[AmbientSpawner] Failed to apply mode config:', e && e.message ? e.message : String(e));
            }

            // Use game mode to compute level loot/NPC spawns (no initial enemy flood)
            const rng = new SeededRNG(this.room.worldSeed);
            const lootSpawns = this.room.currentGameMode.computeLootSpawns(this.room.environment, rng);
            const npcSpawns = this.room.currentGameMode.computeNPCSpawns(this.room.environment, rng, lootSpawns);
            this.room.levelSpawns = { chests: lootSpawns.chests, npcs: npcSpawns };
            
            // Pre-register all chests from level spawns so enemies can damage them immediately
            if (this.room.levelSpawns && this.room.levelSpawns.chests) {
                for (const chestConfig of this.room.levelSpawns.chests) {
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
                    this.room.chests.set(chest.id, chest);
                }
            }
            
            // Initialize server-authoritative NPCs from level spawns
            if (this.room.npcManager && this.room.levelSpawns) {
                this.room.npcManager.initializeFromLevelSpawns(this.room.levelSpawns);
                // Immediately broadcast initial NPC state to all clients (don't wait for 10Hz interval)
                // This ensures clients receive NPC data ASAP after scene change, reducing race condition risk
                this.room.npcManager.broadcastState();
                console.log('[ServerNPC] Sent immediate initial NPC broadcast after level start');
            }

            // Initialize battery system for trench raid mode (RadioTower power system)
            if (this.room.levelType === 'trenchraid') {
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
                        const towerBlocked = this.room.environment && this.room.environment.circleHitsAny && 
                                             this.room.environment.circleHitsAny(radioTowerX, radioTowerY, towerRadius);
                        const stationBlocked = this.room.environment && this.room.environment.circleHitsAny && 
                                               this.room.environment.circleHitsAny(stationX, stationY, stationRadius);
                        
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
                    this.room.batteryStation = {
                        x: stationX,
                        y: stationY,
                        radioTowerX: radioTowerX,
                        radioTowerY: radioTowerY,
                        slots: [false, false, false],
                        isPowered: false
                    };
                    
                    // Initialize batteries map and spawn 3 batteries randomly within 750 units of RadioTower
                    this.room.batteries = new Map();
                    
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
                        if (this.room.environment && this.room.environment.circleHitsAny && 
                            this.room.environment.circleHitsAny(x, y, batteryRadius)) {
                            return false;
                        }
                        
                        // Check distance from other batteries
                        for (const battery of existingBatteries) {
                            const dist = Math.hypot(x - battery.x, y - battery.y);
                            if (dist < minBatteryDistance) return false;
                        }
                        
                        // Check hazards - AVOID fire pools, gas canisters, and exploding barrels
                        // Note: Mud and barbed wire are OK (batteries can be there)
                        if (this.room.hazards) {
                            // Check fire pools
                            if (this.room.hazards.firePools) {
                                for (const fire of this.room.hazards.firePools) {
                                    const dist = Math.hypot(x - fire.x, y - fire.y);
                                    if (dist < (fire.radius || 200) + batteryRadius + 50) return false;
                                }
                            }
                            
                            // Check gas canisters
                            if (this.room.hazards.gasCanisters) {
                                for (const gas of this.room.hazards.gasCanisters) {
                                    const dist = Math.hypot(x - gas.x, y - gas.y);
                                    if (dist < (gas.radius || 180) + batteryRadius + 30) return false;
                                }
                            }
                            
                            // Check exploding barrels
                            if (this.room.hazards.explodingBarrels) {
                                for (const barrel of this.room.hazards.explodingBarrels) {
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
                        this.room.batteries.set(spawn.id, {
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
                    this.room.io.to(this.room.id).emit('batteryStationState', {
                        x: this.room.batteryStation.x,
                        y: this.room.batteryStation.y,
                        radioTowerX: this.room.batteryStation.radioTowerX,
                        radioTowerY: this.room.batteryStation.radioTowerY,
                        slots: this.room.batteryStation.slots,
                        isPowered: this.room.batteryStation.isPowered
                    });
                    
                    for (const [batteryId, battery] of this.room.batteries) {
                        this.room.io.to(this.room.id).emit('batteryState', {
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
            this.room.enemies.clear();
            
            // Spawn mode-specific defensive turrets AFTER clearing enemies (e.g., trench raid gap turrets)
            if (this.room.currentGameMode && typeof this.room.currentGameMode.getDefensiveTurrets === 'function') {
                const turretConfigs = this.room.currentGameMode.getDefensiveTurrets();
                console.log(`[GameMode] getDefensiveTurrets returned:`, turretConfigs);
                if (Array.isArray(turretConfigs) && turretConfigs.length > 0) {
                    for (const config of turretConfigs) {
                        const turretId = `defenseTurret_${this.room.nextEnemyId++}`;
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
                        this.room._initNavProperties(turret);
                        
                        this.room.enemies.set(turretId, turret);
                        console.log(`[GameMode] Ã¢Å"â€¦ Spawned defensive turret ${turretId} at (${config.x}, ${config.y}) AFTER clear`);
                    }
                    console.log(`[GameMode] Added ${turretConfigs.length} defensive turrets AFTER clear, total enemies: ${this.room.enemies.size}`);
                } else {
                    console.log(`[GameMode] No defensive turrets to spawn (configs empty or not array)`);
                }
            } else {
                console.log(`[GameMode] No getDefensiveTurrets method available on currentGameMode:`, this.room.currentGameMode?.constructor?.name);
            }
            
            // Spawn mode-specific artillery guns (e.g., trench raid New Antioch artillery)
            // Add to enemies map like defensive turrets so they get broadcasted to clients
            if (this.room.currentGameMode && typeof this.room.currentGameMode.getArtilleryGuns === 'function') {
                const artilleryConfigs = this.room.currentGameMode.getArtilleryGuns();
                if (Array.isArray(artilleryConfigs) && artilleryConfigs.length > 0) {
                    for (const config of artilleryConfigs) {
                        const artilleryId = `artilleryGun_${this.room.nextEnemyId++}`;
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
                        this.room._initNavProperties(artilleryGun);
                        
                        this.room.enemies.set(artilleryId, artilleryGun);
                        console.log(`[GameMode] Ã¢Å"â€¦ Spawned artillery gun ${artilleryId} at (${config.x}, ${config.y})`);
                    }
                    console.log(`[GameMode] Added ${artilleryConfigs.length} artillery guns to enemies map`);
                }
            }

            // Reposition all existing players to spawn locations (mode-specific or random)
            for (const [playerId, player] of this.room.players) {
                let spawnPos = { x: 0, y: 0 };
                
                // Use mode-specific spawn if available (e.g., trench raid left-side spawn)
                if (this.room.currentGameMode && typeof this.room.currentGameMode.getPlayerSpawnPosition === 'function') {
                    const spawnSeed = this.room.worldSeed + playerId.charCodeAt(0);
                    const rng = new SeededRNG(spawnSeed);
                    spawnPos = this.room.currentGameMode.getPlayerSpawnPosition(this.room.environment, rng);
                    console.log(`[Server] Repositioned player ${playerId} to mode-specific spawn: (${spawnPos.x.toFixed(1)}, ${spawnPos.y.toFixed(1)})`);
                } else {
                    // Fallback: random position in bounds
                    const spawnSeed = this.room.worldSeed + playerId.charCodeAt(0) + Date.now() + Math.random() * 1000;
                    spawnPos = this.room.generateRandomSpawnPosition(spawnSeed);
                    console.log(`[Server] Repositioned player ${playerId} to random spawn: (${spawnPos.x.toFixed(1)}, ${spawnPos.y.toFixed(1)})`);
                }
                
                player.x = spawnPos.x;
                player.y = spawnPos.y;
            }
            
            // Initialize allied troops for Trench Raid (spawn behind players)
            if (this.room.troopManager && modeConfig) {
                this.room.troopManager.clear();
                this.room.troopManager.onLevelStart(modeConfig);
            }
            
            // DEBUG FEATURE: Spawn debug chests near each player (if enabled)
            // MUST happen AFTER players are repositioned to their spawn locations!
            console.log('[Server] About to call _spawnDebugChestsNearPlayers()...');
            this.room._spawnDebugChestsNearPlayers();
            console.log('[Server] Finished calling _spawnDebugChestsNearPlayers()');
            
            // Prepare enemy spawn data for clients (include type for proper instantiation)
            const enemySpawnData = [];
            for (const [id, enemy] of this.room.enemies) {
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
            const clientOrientedBoxes = (this.room.environment.orientedBoxes || []).filter(box => {
                return box.fill || box.stroke || box._abilityId;
            });

            // Clear lobby ground drops when entering a new level.
            // Lobby drops should persist while in the lobby, and be wiped only on level transition.
            try {
                if (this.room.groundItems && typeof this.room.groundItems.clear === 'function') {
                    const n = this.room.groundItems.size || 0;
                    this.room.groundItems.clear();
                    if (n > 0) console.log(`[READY_TIMER] Cleared ${n} groundItems on level start`);
                }
            } catch (e) {
                console.warn('[READY_TIMER] Failed to clear groundItems on level start:', e && e.message ? e.message : String(e));
            }
            
            this.room.io.to(this.room.id).emit('sceneChange', {
                scene: 'level',
                boundary: this.room.boundary, // Use room boundary (e.g., 23000 for Trench Raid)
                fromPlayer: 'SERVER_TIMER',
                obstacles: this.room.environment.obstacles,
                orientedBoxes: clientOrientedBoxes,
                levelType: this.room.levelType,
                levelSpawns: this.room.levelSpawns,
                enemies: enemySpawnData
            });
            console.log(`[READY_TIMER] Sent ${this.room.environment.obstacles.length} obstacles and ${enemySpawnData.length} enemies to all clients (boundary: ${this.room.boundary})`);

            // Send initial hazards state to clients (renderer can be added later)
            try {
                if (this.room.hazards) {
                    this.room.io.to(this.room.id).emit('hazardsState', this.room.hazards.serialize());
                    console.log('[Hazards] Broadcast initial hazardsState');
                }
            } catch (e) {
                console.warn('[Hazards] Failed to broadcast initial state:', e && e.message ? e.message : String(e));
            }

            setTimeout(() => {
                this.room.readyTimer.completed = false;
                this.room.readyTimer.startedBy = null;
                this.emitReadyTimerState();
            }, 1000);

            // After scene is set up, spawn an initial ambient batch of basics
            // (only if ambient spawning is enabled for this mode)
            try {
                if (this.room.ambientSpawner && this.room.ambientSpawner.config.ENABLED) {
                    const initialCount = 200; // base population
                    const spawned = this.room.ambientSpawner.spawnImmediate(initialCount, { 
                        typeRatios: this.room.currentGameMode.config.enemies.typeRatios, 
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

    // =========================================
    // EXTRACTION TIMER METHODS
    // =========================================

    startExtractionTimer(startedByPlayerId, timerType = 'normal') {
        // Only start in level; ignore if already running or completed
        if (this.room.scene !== 'level') return;
        if (this.room.extractionTimer.started || this.room.extractionTimer.extracted) return;
        
        // Determine which zone is being used
        const zone = timerType === 'heretic' ? this.room.hereticExtractionZone : this.room.extractionZone;
        if (!zone) {
            console.warn(`[Server] Cannot start ${timerType} extraction timer - zone not yet spawned`);
            return;
        }
        
        // Validate all requirements server-side
        if (!this._validateExtractionStart(startedByPlayerId, timerType)) {
            console.log(`[Server] Extraction start validation failed for player ${startedByPlayerId}`);
            return;
        }
        
        this.room.extractionTimer.started = true;
        this.room.extractionTimer.extracted = false;
        this.room.extractionTimer.timeLeft = Number.isFinite(this.room.extractionTimer.timeTotal) ? this.room.extractionTimer.timeTotal : 60.0;
        this.room.extractionTimer.startedBy = startedByPlayerId || null;
        this.room.extractionTimer.type = timerType;
        console.log(`[Server] Extraction timer (${timerType}) started in room ${this.room.id} by ${startedByPlayerId}`);
        
        // Trigger game mode extraction spawn hook
        if (this.room.currentGameMode && typeof this.room.currentGameMode.onExtractionStart === 'function') {
            this.room.currentGameMode.onExtractionStart(timerType);
        }
        
        this.emitExtractionTimerState();
    }

    _validateExtractionStart(playerId, timerType) {
        // Check player is near zone center
        const player = this.room.players.get(playerId);
        if (!player) return false;
        
        const zone = timerType === 'heretic' ? this.room.hereticExtractionZone : this.room.extractionZone;
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
        for (const chest of this.room.chests.values()) {
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

    cancelExtractionTimer() {
        if (!this.room.extractionTimer.started || this.room.extractionTimer.extracted) return;
        this.room.extractionTimer.started = false;
        this.room.extractionTimer.timeLeft = 0;
        this.room.extractionTimer.startedBy = null;
        console.log(`[Server] Extraction timer cancelled in room ${this.room.id}`);
        this.emitExtractionTimerState();
    }

    updateExtractionTimer(deltaTime) {
        if (!this.room.extractionTimer.started || this.room.extractionTimer.extracted) return;
        
        // Check if artifact was dropped outside zone - cancel timer
        const zone = this.room.extractionTimer.type === 'heretic' ? this.room.hereticExtractionZone : this.room.extractionZone;
        if (zone) {
            let artifactInZone = false;
            let artifactOnGround = false;
            
            for (const chest of this.room.chests.values()) {
                if (chest.variant === 'brown' || chest.variant === 'startGear') continue;
                
                // Check if artifact is being carried or on ground
                if (chest.artifactCarriedBy) {
                    const carrier = this.room.players.get(chest.artifactCarriedBy);
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

        this.room.extractionTimer.timeLeft -= deltaTime;
        if (this.room.extractionTimer.timeLeft < 0) this.room.extractionTimer.timeLeft = 0;

        this.emitExtractionTimerState();

        if (this.room.extractionTimer.timeLeft <= 0) {
            this.room.extractionTimer.timeLeft = 0;
            this.room.extractionTimer.started = false;
            this.room.extractionTimer.extracted = true;
            console.log(`[Server] Extraction timer completed in room ${this.room.id}`);
            
            // Calculate Victory Points and award to successful extracting players
            this.room._calculateAndAwardVictoryPoints();
            
            // Mark mission as ended to stop enemy AI/targeting
            this.room.missionEnded = true;
            console.log('[Server] Mission ended - freezing enemy AI and damage');
            
            // Notify all clients extraction is complete
            this.emitExtractionTimerState();
            
            // Don't auto-return to lobby - let players read the accomplishment screen
            // Room will reset when players manually click "Return to Lobby"
        }
    }
    
    emitExtractionTimerState(targetSocket) {
        const payload = {
            started: this.room.extractionTimer.started,
            extracted: this.room.extractionTimer.extracted,
            timeLeft: this.room.extractionTimer.timeLeft,
            timeTotal: this.room.extractionTimer.timeTotal,
            startedBy: this.room.extractionTimer.startedBy,
            type: this.room.extractionTimer.type
        };
        if (targetSocket) targetSocket.emit('extractionTimerUpdate', payload);
        else this.room.io.to(this.room.id).emit('extractionTimerUpdate', payload);
    }
}

module.exports = TimerManager;
