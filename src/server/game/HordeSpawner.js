// ============================================================================
// HORDE SPAWNER - Server-authoritative dynamic enemy spawning
// ============================================================================
// Spawns waves of enemies off-screen around objectives/players
// Enemies move toward goal before regular Director AI takes over

/**
 * TUNING CONFIGURATION
 * Adjust these values to balance horde behavior and difficulty
 */
const HORDE_CONFIG = {
    // Spawn Ring Distance
    SPAWN_RADIUS_MIN: 1400,        // Minimum distance from target (units)
    SPAWN_RADIUS_MAX: 1800,        // Maximum distance from target (units)
    
    // Spawn Point Validation
    CAMERA_BUFFER: 320,            // Extra padding outside camera viewport (px)
    ENEMY_CLEARANCE: 300,          // Minimum distance from other enemies (units)
    OBSTACLE_CHECK_RADIUS: 42,     // Collision check radius for spawn point (units) - 26 base + 16 movement clearance
    LOCATION_COOLDOWN: 8000,       // Milliseconds before reusing spawn location
    
    // Spawn Attempts
    ATTEMPTS_PER_TEMPLATE: 20,     // Max attempts per attack direction
    
    // Attack Templates
    TEMPLATES: ['front', 'rear', 'left', 'right'],  // Available spawn directions
    ANGLE_VARIANCE: Math.PI * 0.45,  // ±45° variance from template direction
    
    // Enemy Clustering
    ENEMY_SPREAD: 160,             // Radius of enemy cluster at spawn (units)
    
    // Pre-Aggro Movement
    ESCORT_RADIUS: 600,            // Distance to goal before Director takes over (units)
    PRE_AGGRO_SPEED: 120,          // Base movement speed during pre-aggro (units/sec)
    
    // Enemy Type Distribution (fallback if game mode doesn't provide)
    DEFAULT_TYPE_RATIOS: {
        boomer: 0.15,
        projectile: 0.13,
        licker: 0.10,
        bigboy: 0.05,
        wallguy: 0.12,
        basic: 0.45
    },
    
    // Default Spawn Counts
    DEFAULT_HORDE_SIZE: 12,
    MIN_HORDE_SIZE: 1,
    MAX_HORDE_SIZE: 500,
    
    // Target Priority (checked in order)
    TARGET_PRIORITY: [
        'artifactCarrier',   // Player holding artifact
        'artifactGround',    // Artifact on ground
        'artifactChest',     // Unopened gold chest
        'players'            // Player centroid fallback
    ],
    
    // Target Priority Probabilities (for probability mode)
    TARGET_PROBABILITIES: {
        artifactCarrier: 0.30,   // 30% - players with artifact
        artifactGround: 0.50,    // 50% - dropped artifact
        artifactChest: 0.50      // 50% - unopened gold chest
        // Fallback: random player if all miss
    },
    
    // Movement Prediction
    MIN_VELOCITY_THRESHOLD: 1e-3,  // Minimum player velocity to sample
    DEFAULT_FORWARD: { x: 0, y: -1 },  // Default direction if no movement
    
    // Wave System
    WAVE_INTERVAL_MIN: 3000,          // 3 seconds minimum between waves
    WAVE_INTERVAL_MAX: 10000,         // 10 seconds maximum between waves
    AUTO_WAVE_ENABLED: false,         // Enable automatic wave spawning
    
    // Difficulty Presets (1-10)
    DIFFICULTY_PRESETS: {
        1: {  // Tutorial/Easy
            size: 5,
            typeRatios: { boomer: 0, projectile: 0, licker: 0, bigboy: 0, wallguy: 0, basic: 1.0 },
            spawnRadius: { min: 1600, max: 2000 },
            escortRadius: 800
        },
        2: {  // Light pressure
            size: 10,
            typeRatios: { boomer: 0, projectile: 0.27, licker: 0, bigboy: 0, wallguy: 0.05, basic: 0.68 },
            spawnRadius: { min: 1500, max: 1900 },
            escortRadius: 700
        },
        3: {  // Introduction to variety
            size: 12,
            typeRatios: { boomer: 0.15, projectile: 0.10, licker: 0, bigboy: 0, wallguy: 0.10, basic: 0.65 },
            spawnRadius: { min: 1400, max: 1800 },
            escortRadius: 650
        },
        4: {  // Moderate
            size: 10,
            typeRatios: { boomer: 0.15, projectile: 0.23, licker: 0, bigboy: 0, wallguy: 0.12, basic: 0.50 },
            spawnRadius: { min: 1400, max: 1800 },
            escortRadius: 600
        },
        5: {  // Default/Balanced
            size: 12,
            typeRatios: { boomer: 0.15, projectile: 0.13, licker: 0.10, bigboy: 0.05, wallguy: 0.12, basic: 0.45 },
            spawnRadius: { min: 1400, max: 1800 },
            escortRadius: 600
        },
        6: {  // Challenging
            size: 15,
            typeRatios: { boomer: 0.15, projectile: 0.13, licker: 0.15, bigboy: 0.05, wallguy: 0.12, basic: 0.40 },
            spawnRadius: { min: 1300, max: 1700 },
            escortRadius: 550
        },
        7: {  // Hard
            size: 18,
            typeRatios: { boomer: 0.15, projectile: 0.18, licker: 0.20, bigboy: 0.10, wallguy: 0.12, basic: 0.25 },
            spawnRadius: { min: 1200, max: 1600 },
            escortRadius: 500
        },
        8: {  // Very Hard
            size: 22,
            typeRatios: { boomer: 0.20, projectile: 0.18, licker: 0.20, bigboy: 0.10, wallguy: 0.12, basic: 0.20 },
            spawnRadius: { min: 1200, max: 1600 },
            escortRadius: 450
        },
        9: {  // Extreme
            size: 28,
            typeRatios: { boomer: 0.20, projectile: 0.22, licker: 0.25, bigboy: 0.15, wallguy: 0.10, basic: 0.08 },
            spawnRadius: { min: 1100, max: 1500 },
            escortRadius: 400
        },
        10: {  // Apocalypse
            size: 35,
            typeRatios: { boomer: 0.25, projectile: 0.22, licker: 0.25, bigboy: 0.20, wallguy: 0.08, basic: 0 },
            spawnRadius: { min: 1000, max: 1400 },
            escortRadius: 350
        }
    }
};

class HordeSpawner {
    constructor(room, config = {}) {
        this.room = room;
        this.config = { ...HORDE_CONFIG, ...config };  // Allow per-instance overrides
        this._cooldowns = new Map();
        this._lastTemplate = null;
        this._spawnCount = 0;  // Track total spawns for analytics
        
        // Wave system state
        this._waveTimer = null;
        this._waveQueue = [];
        this._waveActive = false;
        this._lastTargetedPlayerId = null;
        this._playerRotationIndex = 0;
        this._defaultDifficulty = 5;
        this._wavesMode = null;
        this._wavesDifficulty = null;
    }

    /**
     * Get current dynamic goal position for pre-aggro updates
     * @returns {Object|null} Target position {x, y} or null
     */
    getDynamicGoal() {
        const info = this._getTargetInfo();
        return info ? info.target : null;
    }

    /**
     * Get next player in rotation for spawn targeting
     * @returns {Object|null} Player object or null
     */
    _getNextPlayerTarget() {
        const room = this.room;
        const alivePlayers = Array.from(room.players.values())
            .filter(p => p && p.health > 0);
        
        if (alivePlayers.length === 0) return null;
        
        // Round-robin through players
        const player = alivePlayers[this._playerRotationIndex % alivePlayers.length];
        this._playerRotationIndex++;
        
        this._lastTargetedPlayerId = player.id;
        return player;
    }

    /**
     * Get target info for a specific player
     * @param {Object} player - Player to target
     * @returns {Object|null} Target info with position and forward
     */
    _getTargetInfoForPlayer(player) {
        if (!player) return null;
        
        // Calculate forward direction from player velocity if available
        let dirX = 0, dirY = 0;
        if (Number.isFinite(player._prevX) && Number.isFinite(player._prevY)) {
            const vx = (player.x || 0) - player._prevX;
            const vy = (player.y || 0) - player._prevY;
            
            if (Math.abs(vx) > this.config.MIN_VELOCITY_THRESHOLD || 
                Math.abs(vy) > this.config.MIN_VELOCITY_THRESHOLD) {
                const len = Math.hypot(vx, vy);
                dirX = vx / len;
                dirY = vy / len;
            } else {
                dirX = this.config.DEFAULT_FORWARD.x;
                dirY = this.config.DEFAULT_FORWARD.y;
            }
        } else {
            dirX = this.config.DEFAULT_FORWARD.x;
            dirY = this.config.DEFAULT_FORWARD.y;
        }
        
        return {
            target: { x: player.x || 0, y: player.y || 0 },
            source: `player_${player.id}`,
            forward: { x: dirX, y: dirY }
        };
    }

    /**
     * Determine current target and player movement direction
     * @param {Object} opts - Options including probabilityMode
     * @returns {Object|null} {target: {x, y}, source: string, forward: {x, y}}
     */
    _getTargetInfo(opts = {}) {
        const room = this.room;
        if (!room || room.scene !== 'level') return null;

        // Check if probability mode is enabled (default true)
        const useProbability = opts.probabilityMode !== false;
        
        // Target probability weights (only used if useProbability is true)
        const probabilities = opts.probabilities || this.config.TARGET_PROBABILITIES || {
            artifactCarrier: 0.30,   // 30% chance
            artifactGround: 0.50,    // 50% chance
            artifactChest: 0.50      // 50% chance
            // If none hit: random player fallback
        };

        let target = null;
        let source = null;

        // Check artifact states
        if (room.chests) {
            for (const chest of room.chests.values()) {
                if (!chest || chest.variant !== 'gold') continue;

                // Priority 1: ALWAYS target artifact carrier (highest priority, no probability!)
                if (chest.artifactCarriedBy) {
                    const carrier = room.players.get(chest.artifactCarriedBy);
                    if (carrier) {
                        target = { x: carrier.x || 0, y: carrier.y || 0 };
                        source = 'artifactCarrier';
                        break;
                    }
                }

                // Priority 2: Artifact on ground (probabilistic)
                if (!target && chest.artifactPos && Math.random() < probabilities.artifactGround) {
                    target = {
                        x: chest.artifactPos.x || chest.x,
                        y: chest.artifactPos.y || chest.y
                    };
                    source = 'artifactGround';
                    break;
                }

                // Priority 3: Unopened chest ONLY (probabilistic, skip if already opened)
                if (!target && !chest.opened && Math.random() < probabilities.artifactChest) {
                    target = { x: chest.x || 0, y: chest.y || 0 };
                    source = 'artifactChest';
                    break;
                }
                
                break;
            }
        }

        // Fallback: Pick a random alive player
        if (!target) {
            const alivePlayers = Array.from(room.players.values())
                .filter(p => p && p.health > 0);
            
            if (alivePlayers.length > 0) {
                const randomPlayer = alivePlayers[Math.floor(Math.random() * alivePlayers.length)];
                target = { x: randomPlayer.x || 0, y: randomPlayer.y || 0 };
                source = `player_${randomPlayer.id}`;
            }
        }

        if (!target) return null;

        // Calculate average player forward vector for directional spawning
        let dirX = 0, dirY = 0, samples = 0;
        for (const player of room.players.values()) {
            if (!player || player.health <= 0) continue;
            if (!Number.isFinite(player._prevX) || !Number.isFinite(player._prevY)) continue;
            
            const vx = (player.x || 0) - player._prevX;
            const vy = (player.y || 0) - player._prevY;
            
            if (Math.abs(vx) < this.config.MIN_VELOCITY_THRESHOLD && 
                Math.abs(vy) < this.config.MIN_VELOCITY_THRESHOLD) continue;
            
            dirX += vx;
            dirY += vy;
            samples++;
        }

        // Normalize or use default
        if (samples > 0) {
            const len = Math.hypot(dirX, dirY);
            if (len > this.config.MIN_VELOCITY_THRESHOLD) {
                dirX /= len;
                dirY /= len;
            } else {
                dirX = this.config.DEFAULT_FORWARD.x;
                dirY = this.config.DEFAULT_FORWARD.y;
            }
        } else {
            dirX = this.config.DEFAULT_FORWARD.x;
            dirY = this.config.DEFAULT_FORWARD.y;
        }

        return { target, source, forward: { x: dirX, y: dirY } };
    }

    /**
     * Check if position is outside all player camera viewports
     * @param {number} x - World X coordinate
     * @param {number} y - World Y coordinate
     * @param {number} buffer - Extra padding (default from config)
     * @returns {boolean} True if outside all cameras
     */
    _isOutsideAllCameras(x, y, buffer = null) {
        buffer = buffer ?? this.config.CAMERA_BUFFER;
        const room = this.room;
        
        for (const player of room.players.values()) {
            if (!player || player.health <= 0) continue;
            
            const camW = Number.isFinite(player.viewportWidth) ? player.viewportWidth : 1920;
            const camH = Number.isFinite(player.viewportHeight) ? player.viewportHeight : 1080;
            const halfW = camW / 2 + buffer;
            const halfH = camH / 2 + buffer;
            const px = player.x || 0;
            const py = player.y || 0;
            
            if (x >= px - halfW && x <= px + halfW && y >= py - halfH && y <= py + halfH) {
                return false;  // Inside this player's camera
            }
        }
        return true;
    }

    /**
     * Find valid spawn point on ring around target
     * @param {Object} target - Target position {x, y}
     * @param {Object} forwardDir - Direction vector {x, y}
     * @param {Object} opts - Override options
     * @returns {Object|null} Spawn point {x, y, template, angle} or null
     */
    _findSpawnPoint(target, forwardDir, opts = {}) {
        const room = this.room;
        const env = room.environment;
        if (!env) return null;

        // Merge config with overrides
        const attemptLimit = opts.attemptLimit ?? this.config.ATTEMPTS_PER_TEMPLATE;
        const minRadius = opts.minRadius ?? this.config.SPAWN_RADIUS_MIN;
        const maxRadius = opts.maxRadius ?? this.config.SPAWN_RADIUS_MAX;
        const angleVariance = opts.angleVariance ?? this.config.ANGLE_VARIANCE;
        const templates = opts.templates ?? this.config.TEMPLATES;

        const rng = room._rng(Date.now() + Math.random() * 1e9);

        // Shuffle template order for variety
        const order = [...templates];
        for (let i = order.length - 1; i > 0; i--) {
            const j = Math.floor(rng() * (i + 1));
            [order[i], order[j]] = [order[j], order[i]];
        }

        // Normalize forward direction
        const fLen = Math.hypot(forwardDir.x, forwardDir.y) || 1;
        const fx = forwardDir.x / fLen;
        const fy = forwardDir.y / fLen;

        // Base angle for each template
        const baseAngleForTemplate = (template) => {
            switch (template) {
                case 'front':
                    return Math.atan2(fy, fx);
                case 'rear':
                    return Math.atan2(-fy, -fx);
                case 'left':
                    return Math.atan2(fx, -fy);
                case 'right':
                    return Math.atan2(-fx, fy);
                default:
                    return rng() * Math.PI * 2;
            }
        };

        // Try each template until valid spawn found
        for (const template of order) {
            const baseAngle = baseAngleForTemplate(template);
            
            for (let attempt = 0; attempt < attemptLimit; attempt++) {
                // Random point on ring
                const radius = minRadius + rng() * (maxRadius - minRadius);
                const angle = baseAngle + (rng() - 0.5) * angleVariance * 2;
                const x = target.x + Math.cos(angle) * radius;
                const y = target.y + Math.sin(angle) * radius;

                // Validation checks
                if (!env.isInsideBounds(x, y, this.config.OBSTACLE_CHECK_RADIUS)) continue;
                if (env.circleHitsAny && env.circleHitsAny(x, y, this.config.OBSTACLE_CHECK_RADIUS)) continue;
                if (!this._isOutsideAllCameras(x, y)) continue;

                // Check enemy density
                let crowded = false;
                for (const enemy of room.enemies.values()) {
                    if (!enemy || enemy.alive === false) continue;
                    const dx = (enemy.x || 0) - x;
                    const dy = (enemy.y || 0) - y;
                    if (dx * dx + dy * dy < this.config.ENEMY_CLEARANCE * this.config.ENEMY_CLEARANCE) {
                        crowded = true;
                        break;
                    }
                }
                if (crowded) continue;

                // Check cooldown
                const key = `${Math.round(x)},${Math.round(y)}`;
                const cooldown = this._cooldowns.get(key);
                if (cooldown && Date.now() - cooldown < this.config.LOCATION_COOLDOWN) continue;

                // Valid spawn found!
                this._cooldowns.set(key, Date.now());
                this._lastTemplate = template;
                return { x, y, template, angle };
            }
        }
        
        return null;  // No valid spawn point found
    }

    /**
     * Parse horde definition into spawn parameters
     * @param {Object} hordeDef - Horde definition
     * @returns {Object} Spawn parameters { size, typeRatios, spawnRadius, escortRadius, exactEnemies }
     */
    _parseHordeDefinition(hordeDef) {
        // Option 1: Difficulty preset (with optional overrides)
        if (hordeDef.difficulty) {
            const preset = this.config.DIFFICULTY_PRESETS[hordeDef.difficulty];
            if (!preset) {
                console.warn(`[HordeSpawner] Invalid difficulty ${hordeDef.difficulty}, using default`);
                return this._parseHordeDefinition({ difficulty: this._defaultDifficulty });
            }
            
            // Apply overrides on top of preset
            return {
                size: hordeDef.size ?? preset.size,
                typeRatios: hordeDef.typeRatios ?? preset.typeRatios,
                spawnRadius: hordeDef.spawnRadius ?? preset.spawnRadius,
                escortRadius: hordeDef.escortRadius ?? preset.escortRadius,
                exactEnemies: null
            };
        }
        
        // Option 2: Exact enemy list
        if (hordeDef.enemies && Array.isArray(hordeDef.enemies)) {
            return {
                size: null,  // Will be calculated from enemies array
                typeRatios: null,
                spawnRadius: hordeDef.spawnRadius ?? { min: 1400, max: 1800 },
                escortRadius: hordeDef.escortRadius ?? 600,
                exactEnemies: hordeDef.enemies  // [{ type: 'licker', count: 3 }, ...]
            };
        }
        
        // Option 3: Custom size + type ratios
        if (hordeDef.size || hordeDef.typeRatios) {
            return {
                size: hordeDef.size ?? 12,
                typeRatios: hordeDef.typeRatios ?? this.config.DEFAULT_TYPE_RATIOS,
                spawnRadius: hordeDef.spawnRadius ?? { min: 1400, max: 1800 },
                escortRadius: hordeDef.escortRadius ?? 600,
                exactEnemies: null
            };
        }
        
        // Default: Use default difficulty
        return this._parseHordeDefinition({ difficulty: this._defaultDifficulty });
    }

    /**
     * Spawn exact enemy composition (bypasses normal spawn logic)
     * @param {Array} enemyList - Array of {type, count} objects
     * @param {Object} targetInfo - Target information
     * @param {Object} opts - Spawn options
     * @returns {Object|null} Spawn result or null on failure
     * @private
     */
    _spawnExactEnemies(enemyList, targetInfo, opts) {
        const room = this.room;
        
        // Find spawn point
        const spawnPoint = this._findSpawnPoint(targetInfo.target, targetInfo.forward, opts);
        if (!spawnPoint) {
            console.warn('[HordeSpawner] Failed to find spawn point for exact enemies');
            return null;
        }
        
        const rng = room._rng(Date.now() + Math.random() * 1e9);
        const spread = opts.spread ?? this.config.ENEMY_SPREAD;
        const escortRadius = opts.escortRadius ?? this.config.ESCORT_RADIUS;
        const goal = { x: targetInfo.target.x, y: targetInfo.target.y };
        
        const spawned = [];
        
        // Spawn each enemy type
        for (const enemySpec of enemyList) {
            const { type, count } = enemySpec;
            
            for (let i = 0; i < count; i++) {
                // Random position in cluster
                const ang = rng() * Math.PI * 2;
                const dist = Math.sqrt(rng()) * spread;
                const ex = spawnPoint.x + Math.cos(ang) * dist;
                const ey = spawnPoint.y + Math.sin(ang) * dist;
                
                // Skip if invalid (use 42 = 26 base + 16 movement clearance)
                if (!room.environment.isInsideBounds(ex, ey, 42)) continue;
                if (room.environment.circleHitsAny && room.environment.circleHitsAny(ex, ey, 42)) continue;
                
                const id = `enemy_${room.nextEnemyId++}`;
                const enemy = {
                    id,
                    x: ex,
                    y: ey,
                    type,
                    radius: 26,
                    health: 100,
                    healthMax: 100,
                    speedMul: 1.0,
                    alive: true,
                    _preAggroGoal: { 
                        x: goal.x, 
                        y: goal.y, 
                        radius: escortRadius, 
                        dynamic: true, 
                        source: targetInfo.source 
                    },
                    _spawnTemplate: spawnPoint.template,
                    _spawnedFrom: 'horde'
                };
                
                room.currentGameMode.initializeEnemyStats(enemy);
                room.enemies.set(id, enemy);
                spawned.push(enemy);
                
                if (typeof serverDebugger !== 'undefined') {
                    serverDebugger.enemySpawn(enemy.id, enemy.type, { x: enemy.x, y: enemy.y }, targetInfo.source);
                }
            }
        }
        
        this._spawnCount++;
        
        // Format composition for logging
        const compositionCount = {};
        enemyList.forEach(spec => {
            compositionCount[spec.type] = (compositionCount[spec.type] || 0) + spec.count;
        });
        const compositionStr = Object.entries(compositionCount)
            .map(([type, count]) => `${type}: ${count}`)
            .join(', ');
        
        console.log(`[HordeSpawner] Spawned exact composition: ${spawned.length} enemies - ${compositionStr}`);
        
        return { spawnPoint, enemies: spawned, targetInfo };
    }

    /**
     * Spawn a horde of enemies around the target
     * @param {number} enemyCount - Number of enemies to spawn
     * @param {Object} opts - Override options
     * @returns {Object|null} Spawn result or null on failure
     */
    spawnHorde(enemyCount = null, opts = {}) {
        const room = this.room;
        
        // Guard rails
        if (room.scene !== 'level') {
            console.warn('[HordeSpawner] Room not in level scene, skipping horde spawn');
            return null;
        }
        if (!room.currentGameMode) {
            console.warn('[HordeSpawner] No active game mode, skipping horde spawn');
            return null;
        }

        // Get target info (use pre-calculated if provided, otherwise auto-detect)
        const targetInfo = opts._targetInfo || this._getTargetInfo();
        if (!targetInfo) {
            console.warn('[HordeSpawner] No target available for horde spawn');
            return null;
        }

        // Find spawn point (with overridable radii)
        const findOpts = {
            ...opts,
            minRadius: opts.minRadius,
            maxRadius: opts.maxRadius,
            escortRadius: opts.escortRadius
        };
        const spawnPoint = this._findSpawnPoint(targetInfo.target, targetInfo.forward, findOpts);
        if (!spawnPoint) {
            console.warn('[HordeSpawner] Failed to find valid spawn point');
            return null;
        }

        // Determine enemy count
        const count = Math.max(
            this.config.MIN_HORDE_SIZE,
            Math.min(this.config.MAX_HORDE_SIZE, Math.floor(Number(enemyCount) || 0) || this.config.DEFAULT_HORDE_SIZE)
        );

        const rng = room._rng(Date.now() + Math.random() * 1e9);
        const spread = opts.spread ?? this.config.ENEMY_SPREAD;
        const escortRadius = opts.escortRadius ?? this.config.ESCORT_RADIUS;
        const goal = { x: targetInfo.target.x, y: targetInfo.target.y };

        // Get type ratios (prefer passed options, then game mode, then fallback to config)
        console.log('[HordeSpawner] DEBUG opts.typeRatios:', opts.typeRatios);
        console.log('[HordeSpawner] DEBUG gameMode typeRatios:', room.currentGameMode?.config?.enemies?.typeRatios);
        const typeRatios = opts.typeRatios || room.currentGameMode?.config?.enemies?.typeRatios || this.config.DEFAULT_TYPE_RATIOS;
        console.log('[HordeSpawner] DEBUG final typeRatios:', typeRatios);

        const spawned = [];
        const compositionCount = { basic: 0, boomer: 0, projectile: 0, licker: 0, bigboy: 0, wallguy: 0 };
        for (let i = 0; i < count; i++) {
            // Random position in cluster
            const ang = rng() * Math.PI * 2;
            const dist = Math.sqrt(rng()) * spread;
            const ex = spawnPoint.x + Math.cos(ang) * dist;
            const ey = spawnPoint.y + Math.sin(ang) * dist;

            // Skip if position invalid (use 42 = 26 base + 16 movement clearance)
            if (!room.environment.isInsideBounds(ex, ey, 42)) continue;
            if (room.environment.circleHitsAny && room.environment.circleHitsAny(ex, ey, 42)) continue;

            // Determine enemy type based on ratios
            const id = `enemy_${room.nextEnemyId++}`;
            const roll = rng();
            let type = 'basic';
            
            if (roll < typeRatios.boomer) {
                type = 'boomer';
            } else if (roll < typeRatios.boomer + typeRatios.projectile) {
                type = 'projectile';
            } else if (roll < typeRatios.boomer + typeRatios.projectile + typeRatios.licker) {
                type = 'licker';
            } else if (roll < typeRatios.boomer + typeRatios.projectile + typeRatios.licker + (typeRatios.bigboy || 0)) {
                type = 'bigboy';
            } else if (roll < typeRatios.boomer + typeRatios.projectile + typeRatios.licker + (typeRatios.bigboy || 0) + (typeRatios.wallguy || 0)) {
                type = 'wallguy';
            }
            // else remains 'basic'
            
            compositionCount[type]++;

            // Create enemy with pre-aggro goal
            const enemy = {
                id,
                x: ex,
                y: ey,
                type,
                radius: 26,
                health: 100,
                healthMax: 100,
                speedMul: 1.0,
                alive: true,
                _preAggroGoal: { 
                    x: goal.x, 
                    y: goal.y, 
                    radius: escortRadius, 
                    dynamic: true, 
                    source: targetInfo.source 
                },
                _spawnTemplate: spawnPoint.template,
                _spawnedFrom: 'horde'
            };

            // Apply game mode stats
            room.currentGameMode.initializeEnemyStats(enemy);
            room.enemies.set(id, enemy);
            spawned.push(enemy);

            // Debug logging (requires global serverDebugger)
            if (typeof serverDebugger !== 'undefined') {
                serverDebugger.enemySpawn(enemy.id, enemy.type, { x: enemy.x, y: enemy.y }, targetInfo.source || 'horde');
            }
        }

        if (spawned.length === 0) {
            console.warn('[HordeSpawner] No enemies spawned (all candidates invalid)');
            return null;
        }

        // Track spawn count
        this._spawnCount++;

        // Format composition for logging
        const compositionStr = Object.entries(compositionCount)
            .filter(([type, count]) => count > 0)
            .map(([type, count]) => `${type}: ${count}`)
            .join(', ');

        console.log(`[HordeSpawner] Spawned ${spawned.length} enemies at (${spawnPoint.x.toFixed(1)}, ${spawnPoint.y.toFixed(1)}) via ${spawnPoint.template}`, {
            targetSource: targetInfo.source,
            goal,
            composition: compositionStr,
            totalHordes: this._spawnCount
        });

        return { spawnPoint, enemies: spawned, targetInfo };
    }

    /**
     * Start wave system with queue or difficulty function
     * @param {number|Function|Array} waves - Difficulty, function, or queue of horde definitions
     * @param {Object} options - Wave options
     */
    startWaves(waves = 5, options = {}) {
        if (this._waveActive) {
            console.warn('[HordeSpawner] Waves already active');
            return;
        }
        
        this._waveActive = true;
        this._playerRotationIndex = 0;
        
        const minInterval = options.intervalMin ?? this.config.WAVE_INTERVAL_MIN;
        const maxInterval = options.intervalMax ?? this.config.WAVE_INTERVAL_MAX;
        
        // Handle different input types
        if (Array.isArray(waves)) {
            // Waves is a queue of horde definitions
            this._waveQueue = [...waves];
            this._wavesMode = 'queue';
            this._loopQueue = options.loop || false;
            this._originalQueue = [...waves];  // Store original for looping
        } else if (typeof waves === 'function') {
            // Waves is a dynamic difficulty function
            this._wavesMode = 'function';
            this._wavesDifficulty = waves;
        } else {
            // Waves is a static difficulty
            this._wavesMode = 'static';
            this._wavesDifficulty = waves;
        }
        
        const spawnWave = () => {
            if (!this._waveActive) return;
            
            // Get next horde definition
            let hordeDef;
            
            if (this._wavesMode === 'queue') {
                if (this._waveQueue.length === 0) {
                    // Queue exhausted
                    if (this._loopQueue) {
                        // Loop back if configured
                        console.log('[HordeSpawner] Queue exhausted, looping...');
                        this._waveQueue = [...this._originalQueue];  // Reset queue
                        hordeDef = this._waveQueue.shift();
                    } else {
                        console.log('[HordeSpawner] Queue exhausted, stopping waves');
                        this.stopWaves();
                        return;
                    }
                } else {
                    hordeDef = this._waveQueue.shift();
                }
            } else if (this._wavesMode === 'function') {
                const difficulty = this._wavesDifficulty(this._spawnCount);
                hordeDef = { difficulty: Math.max(1, Math.min(10, Math.floor(difficulty))) };
            } else {
                hordeDef = { difficulty: this._wavesDifficulty };
            }
            
            // Parse horde definition
            const params = this._parseHordeDefinition(hordeDef);
            
            // Get next player to target
            const targetPlayer = this._getNextPlayerTarget();
            if (!targetPlayer) {
                console.log('[HordeSpawner] No alive players, skipping wave');
                this._scheduleNextWave(minInterval, maxInterval, spawnWave);
                return;
            }
            
            const targetInfo = this._getTargetInfoForPlayer(targetPlayer);
            
            // Build spawn options
            const spawnOpts = {
                minRadius: params.spawnRadius.min,
                maxRadius: params.spawnRadius.max,
                escortRadius: params.escortRadius,
                _targetInfo: targetInfo
            };
            
            let result;
            
            if (params.exactEnemies) {
                // Spawn exact enemy composition
                result = this._spawnExactEnemies(params.exactEnemies, targetInfo, spawnOpts);
            } else {
                // Spawn with size + type ratios
                spawnOpts.typeRatios = params.typeRatios;
                result = this.spawnHorde(params.size, spawnOpts);
            }
            
            if (result) {
                const desc = params.exactEnemies 
                    ? `custom (${params.exactEnemies.map(e => `${e.count} ${e.type}`).join(', ')})`
                    : `difficulty ${hordeDef.difficulty || 'custom'}, size ${params.size}`;
                console.log(`[HordeSpawner] Wave ${this._spawnCount} spawned: ${desc}, targeting ${targetPlayer.id.substring(0, 8)}`);
            }
            
            this._scheduleNextWave(minInterval, maxInterval, spawnWave);
        };
        
        // Start first wave
        console.log(`[HordeSpawner] Starting waves (mode: ${this._wavesMode})`);
        spawnWave();
    }
    
    /**
     * Schedule next wave with random interval
     * @private
     */
    _scheduleNextWave(minInterval, maxInterval, callback) {
        const interval = minInterval + Math.random() * (maxInterval - minInterval);
        this._waveTimer = setTimeout(callback, interval);
    }
    
    /**
     * Stop automatic wave spawning
     */
    stopWaves() {
        if (!this._waveActive) return;
        
        this._waveActive = false;
        if (this._waveTimer) {
            clearTimeout(this._waveTimer);
            this._waveTimer = null;
        }
        
        console.log('[HordeSpawner] Waves stopped');
    }
    
    /**
     * Check if waves are currently active
     * @returns {boolean}
     */
    isWaveActive() {
        return this._waveActive;
    }
    
    /**
     * Add hordes to the queue (for dynamic queue manipulation)
     * @param {...Object} hordes - Horde definitions to add
     */
    queueHordes(...hordes) {
        this._waveQueue.push(...hordes);
        console.log(`[HordeSpawner] Added ${hordes.length} hordes to queue (${this._waveQueue.length} total)`);
    }
    
    /**
     * Clear the wave queue
     */
    clearQueue() {
        this._waveQueue = [];
        console.log('[HordeSpawner] Wave queue cleared');
    }

    /**
     * Get spawner statistics for monitoring
     * @returns {Object} Stats object
     */
    getStats() {
        return {
            totalSpawns: this._spawnCount,
            activeCooldowns: this._cooldowns.size,
            lastTemplate: this._lastTemplate,
            waveActive: this._waveActive,
            queueLength: this._waveQueue.length,
            config: this.config
        };
    }

    /**
     * Clear cooldown map (useful for testing or reset)
     */
    clearCooldowns() {
        this._cooldowns.clear();
        console.log('[HordeSpawner] Cooldowns cleared');
    }
}

module.exports = { HordeSpawner, HORDE_CONFIG };

