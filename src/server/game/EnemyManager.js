/**
 * EnemyManager - Manages all enemy AI, pathfinding, and behavior for GameRoom
 * 
 * Extracted from GameRoom (Phase 9 - FINAL PHASE of incremental manager extraction)
 * 
 * Handles:
 * - Enemy AI and movement (Director-based system)
 * - Navmesh pathfinding (Trench Raid mode)
 * - Boss AI (Artillery Witch)
 * - Special enemy behaviors (BigBoy dash, Licker ensnare, Boomer explosions, etc.)
 * - Enemy sandbag breaking
 * - Defensive turrets and artillery guns
 * - Enemy projectile tracking and collision
 * - Enemy death and loot drops
 */

const { SeededRNG } = require('../core/seededRNG.js');

class EnemyManager {
    /**
     * @param {GameRoom} room - Reference to the parent GameRoom for state access
     * @param {SocketIO} io - Socket.io instance for broadcasting
     * @param {Class} DirectorClass - Director AI class
     */
    constructor(room, io, DirectorClass) {
        this.room = room;
        this.io = io;
        this.DirectorClass = DirectorClass;
        
        // Initialize EnemyManager-specific state
        this._enemyTroopDirectorsMelee = new Map();
        this._enemyTroopDirectorsRanged = new Map();
        this._troopDamageNumberCooldown = new Map();
        this._troopDamageAccumulator = new Map();
    }

    // =========================================
    // NAVMESH PATHFINDING (Trench Raid Mode)
    // =========================================
    _updateNavmeshMovement(deltaTime) {
        // Smart pathfinding: Use navmesh when line-of-sight is blocked, otherwise use Director
        const now = Date.now();
        const PATH_UPDATE_INTERVAL = 2000; // Recompute paths every 2 seconds
        const WAYPOINT_REACH_DIST = 80; // Distance to consider waypoint reached
        const MAX_PATHS_PER_FRAME = 8; // Performance: Limit pathfinding operations per frame

        // --- Crowd separation for navmesh waypoint steering ---
        // Director applies separation when it owns movement, but navmesh-steered enemies bypass Director movement.
        // So we add a lightweight repulsion blend here to prevent clumping in funnels/corners while pathing.
        const NAV_SEP_RADIUS = 140;         // neighbor search radius for separation (world units)
        const NAV_SEP_PADDING = 10;         // extra desired gap beyond radii
        const NAV_SEP_WEIGHT_MAX = 0.45;    // cap on how much separation can steer away from waypoint direction
        const NAV_SEP_GRID_CELL = 160;      // spatial hash cell size (>= NAV_SEP_RADIUS)
        const NAV_SEP_EPS = 1e-3;

        // Build a tiny spatial hash for enemies this tick (avoids O(N^2) scans).
        // Keyed by integer cell coords; stores references to live, mobile enemies.
        const crowdGrid = new Map(); // key -> [enemyRef...]
        const cellKey = (x, y) => {
            const cx = Math.floor(x / NAV_SEP_GRID_CELL);
            const cy = Math.floor(y / NAV_SEP_GRID_CELL);
            return `${cx},${cy}`;
        };
        for (const [, ee] of this.room.enemies) {
            if (!ee || !ee.alive) continue;
            if (ee.type === 'defenseTurret' || ee.type === 'artilleryGun') continue;
            // Skip enemies with manual movement overrides (they shouldn't be steered by navmesh anyway)
            if (ee._preAggroGoal || ee._wanderTarget) continue;
            const k = cellKey(Number(ee.x) || 0, Number(ee.y) || 0);
            let arr = crowdGrid.get(k);
            if (!arr) { arr = []; crowdGrid.set(k, arr); }
            arr.push(ee);
        };

        const computeNavSeparation = (e) => {
            // Returns { ux, uy, w } where (ux,uy) is a unit push direction and w is blend weight [0..NAV_SEP_WEIGHT_MAX].
            const out = { ux: 0, uy: 0, w: 0 };
            if (!e) return out;
            const ex = Number(e.x) || 0;
            const ey = Number(e.y) || 0;
            const er = Number(e.radius) || 26;

            const cx = Math.floor(ex / NAV_SEP_GRID_CELL);
            const cy = Math.floor(ey / NAV_SEP_GRID_CELL);
            const r2 = NAV_SEP_RADIUS * NAV_SEP_RADIUS;

            let accX = 0, accY = 0, total = 0;
            for (let gy = cy - 1; gy <= cy + 1; gy++) {
                for (let gx = cx - 1; gx <= cx + 1; gx++) {
                    const key = `${gx},${gy}`;
                    const bucket = crowdGrid.get(key);
                    if (!bucket || bucket.length === 0) continue;
                    for (let i = 0; i < bucket.length; i++) {
                        const o = bucket[i];
                        if (!o || o === e || !o.alive) continue;
                        const ox = Number(o.x) || 0;
                        const oy = Number(o.y) || 0;
                        const dx = ex - ox;
                        const dy = ey - oy;
                        const d2 = dx * dx + dy * dy;
                        if (d2 > r2) continue;
                        let d = Math.sqrt(d2);
                        if (d < NAV_SEP_EPS) d = NAV_SEP_EPS;
                        const or = Number(o.radius) || 26;
                        const desired = er + or + NAV_SEP_PADDING;
                        if (d < desired) {
                            const overlap = (desired - d);
                            const w = Math.min(1, overlap / Math.max(NAV_SEP_EPS, desired)); // 0..1
                            accX += (dx / d) * w;
                            accY += (dy / d) * w;
                            total += w;
                        }
                    }
                }
            }

            if (total > 0) {
                const ux = accX / total;
                const uy = accY / total;
                const mag = Math.hypot(ux, uy);
                if (mag > NAV_SEP_EPS) {
                    out.ux = ux / mag;
                    out.uy = uy / mag;
                    out.w = Math.min(NAV_SEP_WEIGHT_MAX, 0.35 * total);
                }
            }
            return out;
        };
        
        // Initialize pathfinding queue and frame counter if not exists
        if (!this.room._pathfindingQueue) this.room._pathfindingQueue = [];
        if (this.room._pathfindingFrameCounter === undefined) this.room._pathfindingFrameCounter = 0;
        
        this.room._pathfindingFrameCounter++;
        let pathsComputedThisFrame = 0;
        
        for (const [, e] of this.room.enemies) {
            if (!e || !e.alive) continue;
            
            // Skip stationary enemies (turrets, artillery)
            if (e.type === 'defenseTurret' || e.type === 'artilleryGun') continue;
            
            // Skip enemies with manual movement overrides
            if (e._preAggroGoal || e._wanderTarget) continue;
            
            // Find target (closest player)
            let targetX = null, targetY = null;
            let closestDist = Infinity;
            for (const [, p] of this.room.players) {
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
            
            // IMPORTANT: don't use truthiness here; x/y can be 0.
            if (targetX == null || targetY == null) {
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
                if ((this.room._pathfindingFrameCounter + e._pathfindingOffset) % 30 !== 0) {
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
                    const path = this._findPath(this.room._navDebug, e.x, e.y, targetX, targetY);
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

                    // Base waypoint-follow direction
                    let ux = dx / dist;
                    let uy = dy / dist;

                    // Blend in a small separation steer so navmesh-driven enemies don't stack while pathing.
                    const sep = computeNavSeparation(e);
                    if (sep.w > 0) {
                        ux = ux * (1 - sep.w) + sep.ux * sep.w;
                        uy = uy * (1 - sep.w) + sep.uy * sep.w;
                        const n = Math.hypot(ux, uy) || 1;
                        ux /= n; uy /= n;
                    }

                    const moveX = ux * speed * deltaTime;
                    const moveY = uy * speed * deltaTime;

                    // Apply swept collision resolution to prevent tunneling through thick walls on dt spikes
                    let newX = e.x + moveX;
                    let newY = e.y + moveY;
                    if (this.room.environment && typeof this.room.environment.resolveCircleMove === 'function') {
                        const res = this.room.environment.resolveCircleMove(e.x, e.y, e.radius || 26, moveX, moveY);
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

    _updateEnemySandbagBreaking(deltaTime) {
        // Enemy sandbag breaking: if stuck for 2+ seconds, attack nearest sandbag
        if (!this.room.hazards || !this.room.hazards.sandbags) return;
        
        for (const [, e] of this.room.enemies) {
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
                
                for (const sb of this.room.hazards.sandbags) {
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
                        
                        this.io.to(this.room.id).emit("hazardHit", {
                            type: "sandbag",
                            id: nearestSandbag.id,
                            x: nearestSandbag.x,
                            y: nearestSandbag.y,
                            health: nearestSandbag.health
                        });
                        
                        if (nearestSandbag.health <= 0) {
                            // Remove collision box
                            if (Number.isInteger(nearestSandbag.boxIndex) && nearestSandbag.boxIndex >= 0 && this.room.environment.orientedBoxes) {
                                this.room.environment.orientedBoxes.splice(nearestSandbag.boxIndex, 1);
                                for (let j = 0; j < this.room.hazards.sandbags.length; j++) {
                                    if (this.room.hazards.sandbags[j] && this.room.hazards.sandbags[j].boxIndex > nearestSandbag.boxIndex) {
                                        this.room.hazards.sandbags[j].boxIndex -= 1;
                                    }
                                }
                            }
                            const idx = this.room.hazards.sandbags.indexOf(nearestSandbag);
                            if (idx >= 0) this.room.hazards.sandbags.splice(idx, 1);
                            
                            this.io.to(this.room.id).emit("hazardRemoved", {
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

updateEnemies(deltaTime) {
        try {
            if (!this.DirectorClass) return;
            if (!this.room.environment) return;
            if (this.room.players.size === 0) return;
            if (!this.room.enemies || this.room.enemies.size === 0) return;

            // Prevent movement tunneling on server hitches / long frames
            deltaTime = Math.max(0, Math.min(0.05, Number(deltaTime) || 0));
            if (deltaTime <= 0) return;
            
            // PHASE 0: Navmesh-based pathfinding for enemies with blocked line-of-sight (Trench Raid only)
            if (this.room.levelType === 'trenchraid' && this.room._navDebug) {
                this._updateNavmeshMovement(deltaTime);
            }

            // PHASE 0.5: Enemy sandbag breaking (after navmesh, before Director)
            this._updateEnemySandbagBreaking(deltaTime);

            // PHASE 1: Update enemy behavior state BEFORE wrapping (so Director sees current state)
            
            // Server-authoritative Artillery Witch (boss) behavior update
            for (const e of this.room.enemies.values()) {
                if (!e || e.type !== 'boss' || e.alive === false) continue;
                
                // Find nearest player for targeting (skip invisible players)
                let closestPlayer = null;
                let closestDist = Infinity;
                for (const [, p] of this.room.players) {
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
                        
                        const preset = this.room.hordeSpawner?.config?.DIFFICULTY_PRESETS?.[5];
                        if (preset) {
                            const rngHorde = this.room._rng(Date.now() + 8888);
                            const spawned = [];
                            const env = this.room.environment;
                            
                            // Find gold chest to avoid spawning near it
                            let goldChestX = null, goldChestY = null;
                            for (const chest of this.room.chests.values()) {
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
                                    
                                    const id = `enemy_${this.room.nextEnemyId++}`;
                                    const enemy = {
                                        id, x: ex, y: ey, type,
                                        radius: 26, health: 100, healthMax: 100,
                                        speedMul: 1.0, alive: true,
                                        _preAggroGoal: { x: e.x, y: e.y, radius: 400, dynamic: false, source: 'boss_enrage' },
                                        _spawnedFrom: 'bossHorde'
                                    };
                                    
                                    if (this.room.currentGameMode) {
                                        this.room.currentGameMode.initializeEnemyStats(enemy);
                                    }
                                    
                                    // Initialize navmesh pathfinding properties
                                    this.room._initNavProperties(enemy);
                                    
                                    this.room.enemies.set(id, enemy);
                                    spawned.push(enemy);
                                    placed = true;
                                }
                            }
                            
                            if (spawned.length > 0) {
                                this.room.spawnAmbientBatch(spawned);
                                console.log(`[Boss] Spawned ${spawned.length} enemies near Witch (low health, away from gold chest)`);
                                
                                this.io.to(this.room.id).emit('horde_spawned', {
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
                        this.io.to(this.room.id).emit('bossDashed', {
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
                        this._scheduleArtilleryStrike(e, tx, ty, 0.55, this.io);
                        
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
                        this.io.to(this.room.id).emit('bossFastBall', {
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
                        this.room.enemyProjectiles.push({
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
                        this._scheduleArtilleryStrike(e, closestPlayer.x, closestPlayer.y, 0.6, this.io);
                        e._artilleryTimer = (e._artilleryCooldown || 1.25) + (Math.random() * 0.4 - 0.2);
                    }
                }
            }
            
            // Server-authoritative Defensive Turret behavior update
            for (const e of this.room.enemies.values()) {
                if (!e || e.type !== 'defenseTurret' || e.alive === false) continue;
                
                // Update fire timer
                e._fireTimer = (e._fireTimer || 0) - deltaTime;
                
                // Find nearest enemy within range
                let closestEnemy = null;
                let closestDist = Infinity;
                for (const [, enemy] of this.room.enemies) {
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
                    this.io.to(this.room.id).emit('defenseTurretShot', {
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
            const effectiveElapsed = this.room.levelStartTime ? (Date.now() - this.room.levelStartTime - this.room.artilleryBonusTimeMs) : 0;
            const artilleryBarrageActive = effectiveElapsed >= ARTILLERY_BARRAGE_DELAY_MS;
            
            for (const e of this.room.enemies.values()) {
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
                for (const [, p] of this.room.players) {
                    if (!p || p.health <= 0) continue;
                    if (inLetterZone(p.x, p.y)) {
                        playersInZone.push(p);
                        playerTargets.push({ x: p.x, y: p.y, kind: 'player', id: p.id });
                    }
                }

                // Troops: can be targeted ONLY in letter zones
                if (this.room.troopManager && this.room.troopManager.troops) {
                    for (const [, t] of this.room.troopManager.troops) {
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
                for (const enemy of this.room.enemies.values()) {
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
                        this._scheduleArtilleryGunStrike(gun, tx, ty, 0.6, this.io);
                        
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
            for (const [pid] of this.room.players) groups.set(pid, []);
            const troopGroupsMelee = new Map(); // troopId -> wrapper enemy array (non-projectile)
            const troopGroupsRanged = new Map(); // troopId -> wrapper enemy array (projectile)
            if (this.room.troopManager && this.room.troopManager.troops) {
                for (const [tid, t] of this.room.troopManager.troops) {
                    if (!t || !t.alive || t.health <= 0) continue;
                    troopGroupsMelee.set(tid, []);
                    troopGroupsRanged.set(tid, []);
                }
            }

            for (const e of this.room.enemies.values()) {
                if (!e) continue;
                if (e.alive === false) continue;
                
                // Skip stationary entities from Director control (they're stationary)
                if (e.type === 'defenseTurret' || e.type === 'artilleryGun' || e.type === 'targetDummy') continue;
                
                // Handle pre-aggro goal for newly spawned horde enemies
                if (e._preAggroGoal) {
                    const goal = e._preAggroGoal;
                    
                    // Update goal position dynamically if flagged
                    if (goal.dynamic && this.room.hordeSpawner) {
                        const updatedGoal = this.room.hordeSpawner.getDynamicGoal();
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
                        if (this.room.environment && this.room.environment.resolveCircleMove) {
                            const res = this.room.environment.resolveCircleMove(e.x, e.y, e.radius || 26, moveX, moveY);
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
                    for (const [, p] of this.room.players) {
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
                        
                        for (const [, p] of this.room.players) {
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
                        if (this.room.troopManager && this.room.troopManager.troops) {
                            for (const [, troop] of this.room.troopManager.troops) {
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
                                    this.io.to(this.room.id).emit('troopDamaged', {
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
                                        this.io.to(this.room.id).emit('troopDeath', {
                                            troopId: troop.id,
                                            x: troop.x,
                                            y: troop.y
                                        });
                                        this.io.to(this.room.id).emit('entity_dead', {
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
                    for (const [, p] of this.room.players) {
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
                    if (this.room.troopManager && this.room.troopManager.troops) {
                        for (const [, troop] of this.room.troopManager.troops) {
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
                        
                        // Find or create collision box for this WallGuy's shield.
                        // IMPORTANT: Do NOT store a long-lived array index into orientedBoxes.
                        // orientedBoxes is mutated via splice() (abilities expiring, hazards removed, etc.),
                        // which shifts indices and can cause WallGuy shields to overwrite ability walls.
                        if (e._shieldCollisionIndex !== undefined) delete e._shieldCollisionIndex; // legacy cleanup
                        const boxes = this.room.environment && this.room.environment.orientedBoxes;
                        if (Array.isArray(boxes)) {
                            let box = e._shieldCollisionBox;
                            // If missing or no longer present (e.g., got spliced), recreate it.
                            if (!box || boxes.indexOf(box) === -1) {
                                box = {
                                    x: shieldX,
                                    y: shieldY,
                                    w: shieldDepth,
                                    h: shieldWidth,
                                    angle: e.shieldAngle,
                                    _wallguyId: e.id // Track which WallGuy owns this
                                };
                                boxes.push(box);
                                e._shieldCollisionBox = box;
                            } else {
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
                            const coneHalf = 0.6; // ~Ãƒâ€šÃ‚Â±34 degrees
                            const damage = 20;
                            
                            this.io.to(this.room.id).emit('enemyMeleeAttack', {
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
                            for (const [, p] of this.room.players) {
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
                            if (this.room.troopManager && this.room.troopManager.troops) {
                                for (const [, troop] of this.room.troopManager.troops) {
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
                                            this.io.to(this.room.id).emit('troopDamaged', {
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
                                                this.io.to(this.room.id).emit('troopDeath', {
                                                    troopId: troop.id,
                                                    x: troop.x,
                                                    y: troop.y
                                                });
                                                this.io.to(this.room.id).emit('entity_dead', {
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
                                if (this.room.hazards) {
                                    this.room.hazards.damageCircle(e.x, e.y, coneRange, damage);
                                    if (typeof this.room.hazards.damageBarrelInRadius === 'function') {
                                        this.room.hazards.damageBarrelInRadius(e.x, e.y, coneRange, damage);
                                    }
                                }
                            } catch(_) {}
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
                        for (const [, p] of this.room.players) {
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
                let numId = this.room._enemyIdMap.get(e.id);
                if (!numId) { numId = this.room._enemyIdCounter++; this.room._enemyIdMap.set(e.id, numId); }

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
                for (const [, ability] of this.room.abilities) {
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
                    for (const [, chest] of this.room.chests) {
                        if (chest.variant !== 'gold' || chest.opened || chest.health <= 0) continue;
                        
                        // Check if chest is vulnerable (only during waves or once activated)
                        if (this.room.currentGameMode?.isChestVulnerable && !this.room.currentGameMode.isChestVulnerable(chest)) continue;
                        
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
                    for (const [, chest] of this.room.chests) {
                        if (chest.variant !== 'gold' || !chest.opened || chest.artifactCarriedBy || chest.health <= 0) continue;
                        
                        // Check if artifact is vulnerable (only during waves or once chest opened)
                        if (this.room.currentGameMode?.isChestVulnerable && !this.room.currentGameMode.isChestVulnerable(chest)) continue;
                        
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
                    for (const [, ability] of this.room.abilities) {
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
                for (const [, p] of this.room.players) {
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
                if (this.room.troopManager && this.room.troopManager.troops) {
                    for (const [, troop] of this.room.troopManager.troops) {
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
                                this.io.to(this.room.id).emit('boomerExploded', { id: e.id, x: e.x, y: e.y });
                                try { this.room.boomerPools.push({ x: e.x, y: e.y, radius: 100, ttl: 8.0 }); } catch(_) {}
                                
                                const blastRadius = 100;
                                const inner = 20;
                                
                                // Damage players
                                for (const [, p] of this.room.players) {
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
                                        this.io.to(this.room.id).emit('playerHealthUpdate', { playerId: p.id, health: p.health });
                                        
                                        // Check for death
                                        if (p.health <= 0 && healthBefore > 0) {
                                            this.room.combatManager._handlePlayerDeath(p.id, p, this.io);
                                        }
                                    }
                                }
                                
                                // Damage turrets
                                for (const [abilityId, ability] of this.room.abilities) {
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
                                        this.io.to(this.room.id).emit('abilityHealthUpdate', {
                                            serverId: abilityId,
                                            health: ability.health,
                                            healthMax: ability.healthMax
                                        });
                                        if (ability.health <= 0) {
                                            this.io.to(this.room.id).emit('abilityTriggered', {
                                                serverId: abilityId,
                                                type: 'AutoTurret',
                                                event: 'death'
                                            });
                                            this.room.abilities.delete(abilityId);
                                        }
                                    }
                                }
                                
                                // Kill boomer
                                e.alive = false;
                                this.room.enemies.delete(e.id);
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
                        if (this.room.environment && this.room.environment.isInsideBounds && this.room.environment.circleHitsAny) {
                            if (this.room.environment.isInsideBounds(newX, newY, e.radius) && 
                                !this.room.environment.circleHitsAny(newX, newY, e.radius)) {
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
                        for (const [, p] of this.room.players) {
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
                                this.io.to(this.room.id).emit('boomerExploded', { id: e.id, x: e.x, y: e.y });
                                // Register authoritative pool (lasts ~8s, radius ~100)
                                try { this.room.boomerPools.push({ x: e.x, y: e.y, radius: 100, ttl: 8.0 }); } catch(_) {}
                                
                                // Apply explosion damage to nearby entities (server-authoritative)
                                const blastRadius = 100;
                                const inner = 20;
                                
                                // Damage sandbags and barrels with boomer explosion
                                try {
                                    if (this.room.hazards) {
                                        this.room.hazards.damageCircle(e.x, e.y, blastRadius, 35);
                                        if (typeof this.room.hazards.damageBarrelInRadius === 'function') {
                                            this.room.hazards.damageBarrelInRadius(e.x, e.y, blastRadius, 35);
                                        }
                                    }
                                } catch(_) {}
                                
                                // Damage players
                                for (const [, p] of this.room.players) {
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
                                        this.io.to(this.room.id).emit('playerHealthUpdate', { playerId: p.id, health: p.health });
                                        
                                        // Check for death
                                        if (p.health <= 0 && healthBefore > 0) {
                                            this.room.combatManager._handlePlayerDeath(p.id, p, this.io);
                                        }
                                    }
                                }
                                
                                // Damage troops
                                if (this.room.troopManager && this.room.troopManager.troops) {
                                    for (const [, troop] of this.room.troopManager.troops) {
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
                                            this.io.to(this.room.id).emit('troopDamaged', {
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
                                                this.io.to(this.room.id).emit('troopDeath', {
                                                    troopId: troop.id,
                                                    x: troop.x,
                                                    y: troop.y
                                                });
                                                this.io.to(this.room.id).emit('entity_dead', {
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
                                for (const [abilityId, ability] of this.room.abilities) {
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
                                        this.io.to(this.room.id).emit('abilityHealthUpdate', {
                                            serverId: abilityId,
                                            health: ability.health,
                                            healthMax: ability.healthMax
                                        });
                                        
                                        // Destroy turret if health depleted
                                        if (ability.health <= 0) {
                                            this.io.to(this.room.id).emit('abilityTriggered', {
                                                serverId: abilityId,
                                                type: 'AutoTurret',
                                                event: 'death'
                                            });
                                            this.room.abilities.delete(abilityId);
                                            console.log(`[Server] AutoTurret ${abilityId} destroyed by boomer explosion`);
                                        }
                                    }
                                }
                                
                                // Damage gold chests
                                for (const [chestId, chest] of this.room.chests) {
                                    if (chest.variant !== 'gold' || chest.health <= 0 || chest.opened) continue;
                                    
                                    // Check if chest is vulnerable (only during waves or once activated)
                                    if (this.room.currentGameMode?.isChestVulnerable && !this.room.currentGameMode.isChestVulnerable(chest)) continue;
                                    
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
                                        this.io.to(this.room.id).emit('chestHealthUpdate', {
                                            chestId: chest.id,
                                            health: chest.health,
                                            healthMax: chest.healthMax
                                        });
                                        this.io.to(this.room.id).emit('chestHitFlash', {
                                            chestId: chest.id
                                        });
                                        
                                        // Auto-open chest if health depleted
                                        if (chest.health <= 0 && !chest.opened) {
                                            chest.opening = false;
                                            chest.opened = true;
                                            this.io.to(this.room.id).emit('chestOpened', { 
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
                                for (const [chestId, chest] of this.room.chests) {
                                    if (chest.variant !== 'gold' || !chest.opened || chest.health <= 0) continue;
                                    if (chest.artifactCarriedBy) continue;
                                    
                                    // Check if artifact is vulnerable (only during waves or once chest opened)
                                    if (this.room.currentGameMode?.isChestVulnerable && !this.room.currentGameMode.isChestVulnerable(chest)) continue;
                                    
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
                                        this.io.to(this.room.id).emit('artifactHealthUpdate', {
                                            chestId: chest.id,
                                            health: chest.health,
                                            healthMax: chest.healthMax
                                        });
                                        this.io.to(this.room.id).emit('artifactHitFlash', {
                                            chestId: chest.id
                                        });
                                        
                                        // Destroy artifact if health depleted
                                        if (chest.health <= 0) {
                                            console.log(`[Server] Artifact ${chest.id} destroyed by boomer explosion`);
                                            this.io.to(this.room.id).emit('artifactDestroyed', { chestId: chest.id });
                                        }
                                    }
                                }
                                
                                // Now emit enemy_dead to clients for visual effects
                                this.io.to(this.room.id).emit('enemy_dead', { id: e.id, x: e.x, y: e.y, type: e.type });
                                this.io.to(this.room.id).emit('entity_dead', {
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
                            if (this.room.environment && this.room.environment.isInsideBounds && this.room.environment.circleHitsAny) {
                                if (this.room.environment.isInsideBounds(newX, newY, e.radius) && 
                                    !this.room.environment.circleHitsAny(newX, newY, e.radius)) {
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
                        for (const [, p] of this.room.players) {
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
                                this.io.to(this.room.id).emit('boomerExploded', { id: e.id, x: e.x, y: e.y });
                                // Register authoritative pool (lasts ~8s, radius ~100)
                                try { this.room.boomerPools.push({ x: e.x, y: e.y, radius: 100, ttl: 8.0 }); } catch(_) {}
                                
                                // Apply explosion damage to nearby entities (server-authoritative)
                                const blastRadius = 100;
                                const inner = 20;
                                
                                // Damage players
                                for (const [, p] of this.room.players) {
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
                                        this.io.to(this.room.id).emit('playerHealthUpdate', { playerId: p.id, health: p.health });
                                    }
                                }
                                
                                // Damage turrets
                                for (const [abilityId, ability] of this.room.abilities) {
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
                                        this.io.to(this.room.id).emit('abilityHealthUpdate', {
                                            serverId: abilityId,
                                            health: ability.health,
                                            healthMax: ability.healthMax
                                        });
                                        
                                        // Destroy turret if health depleted
                                        if (ability.health <= 0) {
                                            this.io.to(this.room.id).emit('abilityTriggered', {
                                                serverId: abilityId,
                                                type: 'AutoTurret',
                                                event: 'death'
                                            });
                                            this.room.abilities.delete(abilityId);
                                            console.log(`[Server] AutoTurret ${abilityId} destroyed by boomer explosion`);
                                        }
                                    }
                                }
                                
                                // Damage gold chests
                                for (const [chestId, chest] of this.room.chests) {
                                    if (chest.variant !== 'gold' || chest.health <= 0 || chest.opened) continue;
                                    
                                    // Check if chest is vulnerable (only during waves or once activated)
                                    if (this.room.currentGameMode?.isChestVulnerable && !this.room.currentGameMode.isChestVulnerable(chest)) continue;
                                    
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
                                        this.io.to(this.room.id).emit('chestHealthUpdate', {
                                            chestId: chest.id,
                                            health: chest.health,
                                            healthMax: chest.healthMax
                                        });
                                        this.io.to(this.room.id).emit('chestHitFlash', {
                                            chestId: chest.id
                                        });
                                        
                                        // Auto-open chest if health depleted
                                        if (chest.health <= 0 && !chest.opened) {
                                            chest.opening = false;
                                            chest.opened = true;
                                            this.io.to(this.room.id).emit('chestOpened', { 
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
                                for (const [chestId, chest] of this.room.chests) {
                                    if (chest.variant !== 'gold' || !chest.opened || chest.health <= 0) continue;
                                    if (chest.artifactCarriedBy) continue;
                                    
                                    // Check if artifact is vulnerable (only during waves or once chest opened)
                                    if (this.room.currentGameMode?.isChestVulnerable && !this.room.currentGameMode.isChestVulnerable(chest)) continue;
                                    
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
                                        this.io.to(this.room.id).emit('artifactHealthUpdate', {
                                            chestId: chest.id,
                                            health: chest.health,
                                            healthMax: chest.healthMax
                                        });
                                        this.io.to(this.room.id).emit('artifactHitFlash', {
                                            chestId: chest.id
                                        });
                                        
                                        // Destroy artifact if health depleted
                                        if (chest.health <= 0) {
                                            console.log(`[Server] Artifact ${chest.id} destroyed by boomer explosion`);
                                            this.io.to(this.room.id).emit('artifactDestroyed', { chestId: chest.id });
                                        }
                                    }
                                }
                                
                                // Now emit enemy_dead to clients for visual effects
                                this.io.to(this.room.id).emit('enemy_dead', { id: e.id, x: e.x, y: e.y, type: e.type });
                                this.io.to(this.room.id).emit('entity_dead', {
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
                            if (this.room.environment && this.room.environment.isInsideBounds && this.room.environment.circleHitsAny) {
                                if (this.room.environment.isInsideBounds(newX, newY, e.radius) && 
                                    !this.room.environment.circleHitsAny(newX, newY, e.radius)) {
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
                                this.io.to(this.room.id).emit('boomerExploded', { id: e.id, x: e.x, y: e.y });
                                try { this.room.boomerPools.push({ x: e.x, y: e.y, radius: 100, ttl: 8.0 }); } catch(_) {}
                                
                                const blastRadius = 100;
                                const inner = 20;
                                
                                // Damage players
                                for (const [, p] of this.room.players) {
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
                                        this.io.to(this.room.id).emit('playerHealthUpdate', { playerId: p.id, health: p.health });
                                    }
                                }
                                
                                // Damage troops
                                if (this.room.troopManager && this.room.troopManager.troops) {
                                    for (const [, troop] of this.room.troopManager.troops) {
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
                                            this.io.to(this.room.id).emit('troopDamaged', {
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
                                                this.io.to(this.room.id).emit('troopDeath', {
                                                    troopId: troop.id,
                                                    x: troop.x,
                                                    y: troop.y
                                                });
                                                this.io.to(this.room.id).emit('entity_dead', {
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
                                for (const [abilityId, ability] of this.room.abilities) {
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
                                        this.io.to(this.room.id).emit('abilityHealthUpdate', {
                                            serverId: abilityId,
                                            health: ability.health,
                                            healthMax: ability.healthMax
                                        });
                                        if (ability.health <= 0) {
                                            this.io.to(this.room.id).emit('abilityTriggered', {
                                                serverId: abilityId,
                                                type: ability.type,
                                                event: 'death'
                                            });
                                            this.room.abilities.delete(abilityId);
                                        }
                                    }
                                }
                                
                                // Kill boomer
                                e.alive = false;
                                this.room.enemies.delete(e.id);
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
                        if (this.room.environment && typeof this.room.environment.resolveCircleMove === 'function') {
                            const res = this.room.environment.resolveCircleMove(e.x, e.y, e.radius || 26, moveX, moveY);
                            newX = res.x;
                            newY = res.y;
                        } else if (this.room.environment && this.room.environment.isInsideBounds && this.room.environment.circleHitsAny) {
                            if (!(this.room.environment.isInsideBounds(newX, newY, e.radius) &&
                                  !this.room.environment.circleHitsAny(newX, newY, e.radius))) {
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
                        if (this.room.environment && typeof this.room.environment.resolveCircleMove === 'function') {
                            const res = this.room.environment.resolveCircleMove(e.x, e.y, e.radius || 26, moveX, moveY);
                            newX = res.x;
                            newY = res.y;
                        } else if (this.room.environment && this.room.environment.isInsideBounds && this.room.environment.circleHitsAny) {
                            if (!(this.room.environment.isInsideBounds(newX, newY, e.radius) &&
                                  !this.room.environment.circleHitsAny(newX, newY, e.radius))) {
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
            if (this.DirectorClass) {
                // 1) Melee troop-targeting (non-projectile): close ring + contact damage
                if (troopGroupsMelee && troopGroupsMelee.size > 0) {
                    for (const [tid, arr] of troopGroupsMelee) {
                        if (!arr || arr.length === 0) continue;
                        const troopRef = (this.room.troopManager && this.room.troopManager.troops) ? this.room.troopManager.troops.get(tid) : null;
                        if (!troopRef || !troopRef.alive || troopRef.health <= 0) continue;

                        let dir = this._enemyTroopDirectorsMelee.get(tid);
                        if (!dir) {
                            const listObj = { items: arr, queryCircle: (cx, cy, r) => arr.filter(o => {
                                const dx = (o.x - cx); const dy = (o.y - cy); return (dx*dx + dy*dy) <= r*r;
                            }) };
                            dir = new this.DirectorClass(listObj, this.room.environment, troopRef);
                            // Ensure dogpile prevention works even for contact enemies
                            dir.allowContactRush = false;
                            this._enemyTroopDirectorsMelee.set(tid, dir);
                        }
                        // Keep references fresh each tick
                        dir.enemies = { items: arr, queryCircle: (cx, cy, r) => arr.filter(o => {
                            const dx = (o.x - cx); const dy = (o.y - cy); return (dx*dx + dy*dy) <= r*r;
                        }) };
                        dir.environment = this.room.environment;
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
                        const troopRef = (this.room.troopManager && this.room.troopManager.troops) ? this.room.troopManager.troops.get(tid) : null;
                        if (!troopRef || !troopRef.alive || troopRef.health <= 0) continue;

                        let dir = this._enemyTroopDirectorsRanged.get(tid);
                        if (!dir) {
                            const listObj = { items: arr, queryCircle: (cx, cy, r) => arr.filter(o => {
                                const dx = (o.x - cx); const dy = (o.y - cy); return (dx*dx + dy*dy) <= r*r;
                            }) };
                            dir = new this.DirectorClass(listObj, this.room.environment, troopRef);
                            dir.allowContactRush = false;
                            this._enemyTroopDirectorsRanged.set(tid, dir);
                        }
                        // Keep references fresh each tick
                        dir.enemies = { items: arr, queryCircle: (cx, cy, r) => arr.filter(o => {
                            const dx = (o.x - cx); const dy = (o.y - cy); return (dx*dx + dy*dy) <= r*r;
                        }) };
                        dir.environment = this.room.environment;
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
                            if (wantFire && this.room.environment && typeof this.room.environment.lineHitsAny === 'function') {
                                const losBlocked = this.room.environment.lineHitsAny(e.x, e.y, targetX, targetY);
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

                            this.io.to(this.room.id).emit('enemyProjectileFired', {
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
                            this.room.enemyProjectiles.push({ x: sx, y: sy, vx, vy, radius: r, damage: damage, life, maxLife: life });

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
            for (const [abilityId, ability] of this.room.abilities) {
                if (ability.type !== 'AutoTurret' && ability.type !== 'EnemyAttractor') continue;
                if (ability._damageThisFrame && ability._damageThisFrame > 0) {
                    // Broadcast health update
                    this.io.to(this.room.id).emit('abilityHealthUpdate', {
                        serverId: abilityId,
                        health: ability.health,
                        healthMax: ability.healthMax
                    });
                    
                    // Check if ability was destroyed
                    if (ability.health <= 0) {
                        this.io.to(this.room.id).emit('abilityTriggered', {
                            serverId: abilityId,
                            type: ability.type,
                            event: 'death'
                        });
                        this.room.abilities.delete(abilityId);
                        console.log(`[Server] ${ability.type} ${abilityId} destroyed by enemy contact`);
                    }
                    
                    // Clear damage accumulator for next frame
                    delete ability._damageThisFrame;
                }
            }
            
            // Broadcast accumulated troop damage from enemies
            if (this.room.troopManager && this.room.troopManager.troops) {
                // Rate limit + accumulate troop damage numbers so we don't spam "-0" for fractional DPS ticks.
                const now = Date.now();
                const damageNumberInterval = 500; // 0.5s batching

                for (const [troopId, troop] of this.room.troopManager.troops) {
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
                                this.io.to(this.room.id).emit('troopDamaged', {
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
                        this.io.to(this.room.id).emit('troopDied', {
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
                const playerRef = this.room.players.get(pid);
                if (!playerRef || playerRef.health <= 0) continue; // Skip dead players

                let dir = this.room._enemyDirectors.get(pid);
                if (!dir) {
                    const listObj = { items: arr, queryCircle: (cx, cy, r) => arr.filter(o => {
                        const dx = (o.x - cx); const dy = (o.y - cy); return (dx*dx + dy*dy) <= r*r;
                    }) };
                    dir = new this.DirectorClass(listObj, this.room.environment, playerRef);
                    this.room._enemyDirectors.set(pid, dir);
                }
                // Keep references fresh each tick
                dir.enemies = { items: arr, queryCircle: (cx, cy, r) => arr.filter(o => {
                    const dx = (o.x - cx); const dy = (o.y - cy); return (dx*dx + dy*dy) <= r*r;
                }) };
                dir.environment = this.room.environment;
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
                        if (this.room.environment && typeof this.room.environment.resolveCircleMove === 'function') {
                            try {
                                const res = this.room.environment.resolveCircleMove(w.x, w.y, w.radius, dx, dy);
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
                        
                        for (const [, p] of this.room.players) {
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
                        for (const [, ability] of this.room.abilities) {
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
                                this.io.to(this.room.id).emit('boomerExploded', { id: e.id, x: e.x, y: e.y });
                                // Register authoritative pool (lasts ~8s, radius ~100)
                                try { this.room.boomerPools.push({ x: e.x, y: e.y, radius: 100, ttl: 8.0 }); } catch(_) {}
                                // Apply explosion damage to nearby players (server-authoritative)
                                const blastRadius = 100;
                                const inner = 20;
                                for (const [, p] of this.room.players) {
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
                                        this.io.to(this.room.id).emit('playerHealthUpdate', { playerId: p.id, health: p.health });
                                    }
                                }
                                
                                // Apply explosion damage to nearby troops (server-authoritative)
                                if (this.room.troopManager && this.room.troopManager.troops) {
                                    for (const [, troop] of this.room.troopManager.troops) {
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
                                            this.io.to(this.room.id).emit('troopDamaged', {
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
                                                this.io.to(this.room.id).emit('troopDeath', {
                                                    troopId: troop.id,
                                                    x: troop.x,
                                                    y: troop.y
                                                });
                                                this.io.to(this.room.id).emit('entity_dead', {
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
                                for (const [abilityId, ability] of this.room.abilities) {
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
                                        this.io.to(this.room.id).emit('abilityHealthUpdate', {
                                            serverId: abilityId,
                                            health: ability.health,
                                            healthMax: ability.healthMax
                                        });
                                        
                                        // Destroy turret if health depleted
                                        if (ability.health <= 0) {
                                            this.io.to(this.room.id).emit('abilityTriggered', {
                                                serverId: abilityId,
                                                type: 'AutoTurret',
                                                event: 'death'
                                            });
                                            this.room.abilities.delete(abilityId);
                                            console.log(`[Server] AutoTurret ${abilityId} destroyed by boomer explosion`);
                                        }
                                    }
                                }
                                
                                // Apply explosion damage to gold chests
                                for (const [chestId, chest] of this.room.chests) {
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
                                        this.io.to(this.room.id).emit('chestHealthUpdate', {
                                            chestId: chest.id,
                                            health: chest.health,
                                            healthMax: chest.healthMax
                                        });
                                        this.io.to(this.room.id).emit('chestHitFlash', {
                                            chestId: chest.id
                                        });
                                        
                                        // Auto-open chest if health depleted
                                        if (chest.health <= 0 && !chest.opened) {
                                            chest.opening = false;
                                            chest.opened = true;
                                            this.io.to(this.room.id).emit('chestOpened', { 
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
                                for (const [chestId, chest] of this.room.chests) {
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
                                        this.io.to(this.room.id).emit('artifactHealthUpdate', {
                                            chestId: chest.id,
                                            health: chest.health,
                                            healthMax: chest.healthMax
                                        });
                                        this.io.to(this.room.id).emit('artifactHitFlash', {
                                            chestId: chest.id
                                        });
                                        
                                        // Destroy artifact if health depleted
                                        if (chest.health <= 0) {
                                            console.log(`[Server] Artifact ${chest.id} destroyed by boomer explosion`);
                                            this.io.to(this.room.id).emit('artifactDestroyed', { chestId: chest.id });
                                        }
                                    }
                                }
                                
                                // Kill boomer server-side and remove from map
                                e.alive = false;
                                this.room.enemies.delete(e.id);
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
                    for (const [, ability] of this.room.abilities) {
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
                        for (const [, chest] of this.room.chests) {
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
                        for (const [, chest] of this.room.chests) {
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
                        for (const [, ability] of this.room.abilities) {
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
                        if (this.room.troopManager && this.room.troopManager.troops && targetPriority === 0) {
                            // Only consider troops if player is far away (> 600 units)
                            if (targetDist > 600) {
                                for (const [, troop] of this.room.troopManager.troops) {
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
                    if (wantFire && this.room.environment && typeof this.room.environment.lineHitsAny === 'function') {
                        const losBlocked = this.room.environment.lineHitsAny(e.x, e.y, targetX, targetY);
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
                    this.io.to(this.room.id).emit('enemyProjectileFired', {
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
                    this.room.enemyProjectiles.push({ x: sx, y: sy, vx, vy, radius: r, damage: damage, life, maxLife: life });
                    
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
                            this.io.to(this.room.id).emit('playerHealthUpdate', { playerId: playerRef.id, health: playerRef.health, from: 'contact', _debugEnemyIds: debugEnemyIds });
                            // DEBUG:GhostEnemy - Rate-limited contact damage log (once per 2s per player)
                            if (!this._lastContactDamageLog) this._lastContactDamageLog = {};
                            const nowLog = Date.now();
                            if (!this._lastContactDamageLog[playerRef.id] || nowLog - this._lastContactDamageLog[playerRef.id] > 2000) {
                                this._lastContactDamageLog[playerRef.id] = nowLog;
                                // console.log(`[DEBUG:GhostEnemy] Contact damage to player ${playerRef.id} at (${px.toFixed(0)},${py.toFixed(0)}) from enemies:`, JSON.stringify(_debugContactEnemies));
                            }
                            
                            // Check for death
                            if (playerRef.health <= 0 && healthBefore > 0) {
                                this.room.combatManager._handlePlayerDeath(playerRef.id, playerRef, this.io);
                            }
                        }
                    }
                    
                    // Note: Basic zombie slow is now calculated in real-time during updatePlayerMovement
                    // to avoid 1-frame delay and ensure immediate responsiveness
                }
                // Server-authoritative melee contact damage to turrets (all enemies except Lickers)
                for (const [abilityId, ability] of this.room.abilities) {
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
                        this.io.to(this.room.id).emit('abilityHealthUpdate', {
                            serverId: abilityId,
                            health: ability.health,
                            healthMax: ability.healthMax
                        });
                        
                        // Destroy turret if health depleted
                        if (ability.health <= 0) {
                            this.io.to(this.room.id).emit('abilityTriggered', {
                                serverId: abilityId,
                                type: 'AutoTurret',
                                event: 'death'
                            });
                            this.room.abilities.delete(abilityId);
                            console.log(`[Server] AutoTurret ${abilityId} destroyed by enemy contact`);
                        }
                    }
                }
                
                // Server-authoritative melee contact damage to gold chests (all enemies except Lickers)
                // NOTE: Must check ALL enemies, not just those in Director groups, since chest-targeting enemies bypass Director
                for (const [chestId, chest] of this.room.chests) {
                    // Only gold chests can be damaged, and only when not opened or has positive health
                    if (chest.variant !== 'gold' || chest.health <= 0) continue;
                    
                    // Check if chest is vulnerable (only during waves or once activated)
                    if (this.room.currentGameMode?.isChestVulnerable && !this.room.currentGameMode.isChestVulnerable(chest)) continue;
                    
                    const chestX = Number(chest.x) || 0;
                    const chestY = Number(chest.y) || 0;
                    const chestRadius = chest.radius || 20;
                    let chestDamage = 0;
                    
                    // Check ALL enemies (not just Director groups) since chest-targeting enemies don't use Director
                    for (const [, enemy] of this.room.enemies) {
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
                        this.io.to(this.room.id).emit('chestHealthUpdate', {
                            chestId: chest.id,
                            health: chest.health,
                            healthMax: chest.healthMax
                        });
                        this.io.to(this.room.id).emit('chestHitFlash', {
                            chestId: chest.id
                        });
                        
                        // Auto-open chest if health depleted (same behavior as when player shoots it to 0 HP)
                        if (chest.health <= 0 && !chest.opened) {
                            chest.opening = false;
                            chest.opened = true;
                            // Artifact drop descriptor (clients handle physics)
                            this.io.to(this.room.id).emit('chestOpened', { 
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
                for (const [chestId, chest] of this.room.chests) {
                    if (chest.variant !== 'gold' || !chest.opened || chest.health <= 0) continue;
                    if (chest.artifactCarriedBy) continue; // Skip if artifact is being carried
                    
                    // Artifact position (server tracks it or uses chest position as fallback)
                    const artX = (chest.artifactPos && Number(chest.artifactPos.x)) || Number(chest.x) || 0;
                    const artY = (chest.artifactPos && Number(chest.artifactPos.y)) || Number(chest.y) || 0;
                    const artRadius = 10; // Artifact radius
                    let artifactDamage = 0;
                    
                    // Check ALL enemies (not just Director groups) since artifact-targeting enemies don't use Director
                    for (const [, enemy] of this.room.enemies) {
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
                        this.io.to(this.room.id).emit('artifactHealthUpdate', {
                            chestId: chest.id,
                            health: chest.health,
                            healthMax: chest.healthMax
                        });
                        this.io.to(this.room.id).emit('artifactHitFlash', {
                            chestId: chest.id
                        });
                        
                        // Destroy artifact if health depleted
                        if (chest.health <= 0) {
                            console.log(`[Server] Artifact ${chest.id} destroyed by enemy contact`);
                            this.io.to(this.room.id).emit('artifactDestroyed', { chestId: chest.id });
                        }
                    }
                }
                
                // Server-authoritative melee contact damage to troops (all enemies except Lickers)
                // NOTE: Must check ALL enemies, not just those in Director groups
                if (this.room.troopManager && this.room.troopManager.troops) {
                    const now = Date.now();
                    const damageNumberInterval = 500; // Show damage numbers every 0.5 seconds
                    
                    for (const [, troop] of this.room.troopManager.troops) {
                        if (!troop || !troop.alive) continue;
                        if (troop.health <= 0) continue;
                        
                        const troopX = Number(troop.x) || 0;
                        const troopY = Number(troop.y) || 0;
                        const troopRadius = troop.radius || 22;
                        let troopDamage = 0;
                        
                        // Check ALL enemies (not just Director groups)
                        for (const [, enemy] of this.room.enemies) {
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
                                    this.io.to(this.room.id).emit('troopDamaged', {
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
                            this.io.to(this.room.id).emit('troopDeath', {
                                troopId: troop.id,
                                    x: troop.x,
                                    y: troop.y
                                });
                            this.io.to(this.room.id).emit('entity_dead', {
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
                                    if (this.room.environment && typeof this.room.environment.resolveCircleMove === 'function') {
                                        const resolved = this.room.environment.resolveCircleMove(e.x, e.y, e.radius || 26, ux * moveAmount, uy * moveAmount);
                                        e.x = resolved.x;
                                        e.y = resolved.y;
                                    } else {
                                        // Fallback: direct movement with boundary enforcement
                                        e.x = Math.max(-this.room.boundary, Math.min(this.room.boundary, newX));
                                        e.y = Math.max(-this.room.boundary, Math.min(this.room.boundary, newY));
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
                                    if (this.room.environment && typeof this.room.environment.resolveCircleMove === 'function') {
                                        const resolved = this.room.environment.resolveCircleMove(playerRef.x, playerRef.y, playerRef.radius || 26, ux * step, uy * step);
                                        playerRef.x = resolved.x;
                                        playerRef.y = resolved.y;
                                    } else {
                                        // Fallback: direct movement with boundary enforcement
                                        playerRef.x = Math.max(-this.room.boundary, Math.min(this.room.boundary, playerRef.x + ux * step));
                                        playerRef.y = Math.max(-this.room.boundary, Math.min(this.room.boundary, playerRef.y + uy * step));
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
                                this.io.to(this.room.id).emit('lickerEnsnared', {
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
                                    this.room.combatManager._handlePlayerDeath(playerRef.id, playerRef, this.io);
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
            for (let i = this.room.enemyProjectiles.length - 1; i >= 0; i--) {
                const proj = this.room.enemyProjectiles[i];
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
                    if (this.room.hazards && typeof this.room.hazards.damageFromBulletLine === 'function') {
                        this.room.hazards.damageFromBulletLine(oldX, oldY, proj.x, proj.y, proj.damage || 10);
                    }
                    if (this.room.hazards && typeof this.room.hazards.damageBarrelFromBulletLine === 'function') {
                        this.room.hazards.damageBarrelFromBulletLine(oldX, oldY, proj.x, proj.y, proj.damage || 10);
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
                    for (const [, p] of this.room.players) {
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
                            this.io.to(this.room.id).emit('playerHealthUpdate', { playerId: p.id, health: p.health });
                        }
                    }
                    
                    // Artillery Gun: Damage enemies in blast radius
                    if (isArtilleryGun) {
                        const enemiesToDelete = [];  // Collect deaths to process after iteration
                        for (const [enemyId, enemy] of this.room.enemies) {
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
                                this.io.to(this.room.id).emit('enemyHealthUpdate', {
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
                            this.room._clearLickerEnsnareOnDeath(deadEnemy.id, deadEnemy.type);
                            this.room.enemies.delete(deadEnemy.id);
                            this.io.to(this.room.id).emit('enemyDied', { id: deadEnemy.id, x: deadEnemy.x, y: deadEnemy.y, type: deadEnemy.type });
                            this.io.to(this.room.id).emit('entity_dead', {
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
                    if (this.room.troopManager && this.room.troopManager.troops) {
                        for (const [, troop] of this.room.troopManager.troops) {
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
                                this.io.to(this.room.id).emit('troopDamaged', {
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
                                    this.io.to(this.room.id).emit('troopDeath', {
                                        troopId: troop.id,
                                        x: troopX,
                                        y: troopY
                                    });
                                    this.io.to(this.room.id).emit('entity_dead', {
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
                    for (const [abilityId, ability] of this.room.abilities) {
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
                            this.io.to(this.room.id).emit('abilityHealthUpdate', {
                                serverId: abilityId,
                                health: ability.health,
                                healthMax: ability.healthMax
                            });
                            
                            // Destroy ability if health depleted
                            if (ability.health <= 0) {
                                this.io.to(this.room.id).emit('abilityTriggered', {
                                    serverId: abilityId,
                                    type: ability.type,
                                    event: 'death'
                                });
                                this.room.abilities.delete(abilityId);
                                console.log(`[Server] ${ability.type} ${abilityId} destroyed by artillery explosion`);
                            }
                        }
                    }
                    
                    // Apply hazard damage (sandbags and barrels) from explosion
                    try {
                        if (this.room.hazards) {
                            this.room.hazards.damageCircle(explosionX, explosionY, blastRadius, 45);
                            if (typeof this.room.hazards.damageBarrelInRadius === 'function') {
                                this.room.hazards.damageBarrelInRadius(explosionX, explosionY, blastRadius, 45);
                            }
                        }
                    } catch(_) {}
                    
                    // Remove explosion projectile
                    this.room.enemyProjectiles.splice(i, 1);
                    continue;
                }
                
                // Remove if expired (non-explosion projectiles)
                if (proj.life <= 0) {
                    this.room.enemyProjectiles.splice(i, 1);
                    continue;
                }
                
                // Check collision with all players (artillery/artilleryGun doesn't collide mid-flight, only on timeout explosion)
                let hit = false;
                if (proj.type !== 'artillery' && proj.type !== 'artilleryGun') {
                    // Friendly projectiles (defensive turrets) should hit enemies instead
                    if (proj.isFriendly) {
                        // Check collision with enemies
                        for (const [, enemy] of this.room.enemies) {
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
                                    this.room._clearLickerEnsnareOnDeath(enemy.id, enemy.type);
                                }
                                hit = true;
                                break;
                            }
                        }
                        if (hit) {
                            this.room.enemyProjectiles.splice(i, 1);
                            continue;
                        }
                    } else {
                        // Hostile projectiles hit players
                        for (const [, p] of this.room.players) {
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
                                for (const [, player] of this.room.players) {
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
                                        this.io.to(this.room.id).emit('playerHealthUpdate', { playerId: player.id, health: player.health });
                                        
                                        // Check for death
                                        if (player.health <= 0 && healthBefore > 0) {
                                            this.room.combatManager._handlePlayerDeath(player.id, player, this.io);
                                        }
                                    }
                                }
                                
                                // Damage troops in blast radius
                                if (this.room.troopManager && this.room.troopManager.troops) {
                                    for (const [, troop] of this.room.troopManager.troops) {
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
                                            this.io.to(this.room.id).emit('troopDamaged', {
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
                                                this.io.to(this.room.id).emit('troopDeath', {
                                                    troopId: troop.id,
                                                    x: troop.x,
                                                    y: troop.y
                                                });
                                                this.io.to(this.room.id).emit('entity_dead', {
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
                                for (const [abilityId, ability] of this.room.abilities) {
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
                                        this.io.to(this.room.id).emit('abilityHealthUpdate', {
                                            serverId: abilityId,
                                            health: ability.health,
                                            healthMax: ability.healthMax
                                        });
                                        
                                        // Destroy ability if health depleted
                                        if (ability.health <= 0) {
                                            this.io.to(this.room.id).emit('abilityTriggered', {
                                                serverId: abilityId,
                                                type: ability.type,
                                                event: 'death'
                                            });
                                            this.room.abilities.delete(abilityId);
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
                                this.io.to(this.room.id).emit('playerHealthUpdate', { playerId: p.id, health: p.health });
                                
                                // Broadcast projectile impact event for visual feedback (hit VFX)
                                this.io.to(this.room.id).emit('enemyProjectileHit', {
                                    x: proj.x,
                                    y: proj.y,
                                    targetType: 'player',
                                    targetId: p.id
                                });
                                
                                // Check for death
                                if (p.health <= 0 && healthBefore > 0) {
                                    this.room.combatManager._handlePlayerDeath(p.id, p, this.io);
                                }
                            }
                            
                            hit = true;
                            break;
                        }
                    }
                    
                    // Check collision with troops (if projectile didn't hit a player)
                    if (!hit && this.room.troopManager && this.room.troopManager.troops) {
                        for (const [, troop] of this.room.troopManager.troops) {
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
                                this.io.to(this.room.id).emit('troopDamaged', {
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
                                    this.io.to(this.room.id).emit('troopDeath', {
                                        troopId: troop.id,
                                        x: troop.x,
                                        y: troop.y
                                    });
                                    this.io.to(this.room.id).emit('entity_dead', {
                                        entityType: 'troop',
                                        id: troop.id,
                                        x: troop.x,
                                        y: troop.y,
                                        kind: troop.type || 'troop',
                                        cause: 'enemy_projectile'
                                    });
                                }
                                
                                // Broadcast projectile impact event for visual feedback (hit VFX)
                                this.io.to(this.room.id).emit('enemyProjectileHit', {
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
                    for (const [chestId, chest] of this.room.chests) {
                        if (chest.variant !== 'gold' || chest.health <= 0) continue;
                        
                        // Check if chest is vulnerable (only during waves or once activated)
                        if (this.room.currentGameMode?.isChestVulnerable && !this.room.currentGameMode.isChestVulnerable(chest)) continue;
                        
                        const dx = (chest.x || 0) - proj.x;
                        const dy = (chest.y || 0) - proj.y;
                        const dist = Math.hypot(dx, dy);
                        const collisionDist = (chest.radius || 20) + proj.radius;
                        
                        if (dist <= collisionDist) {
                            // Apply full damage to chest (no armor)
                            const dmg = proj.damage || 18;
                            chest.health = Math.max(0, chest.health - dmg);
                                
                                // Broadcast health update and hit flash
                                this.io.to(this.room.id).emit('chestHealthUpdate', {
                                    chestId: chest.id,
                                    health: chest.health,
                                    healthMax: chest.healthMax
                                });
                                this.io.to(this.room.id).emit('chestHitFlash', {
                                    chestId: chest.id
                                });
                                
                                // Auto-open chest if health depleted
                                if (chest.health <= 0 && !chest.opened) {
                                    chest.opening = false;
                                    chest.opened = true;
                                    this.io.to(this.room.id).emit('chestOpened', { 
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
                        for (const [chestId, chest] of this.room.chests) {
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
                                this.io.to(this.room.id).emit('artifactHealthUpdate', {
                                    chestId: chest.id,
                                    health: chest.health,
                                    healthMax: chest.healthMax
                                });
                                this.io.to(this.room.id).emit('artifactHitFlash', {
                                    chestId: chest.id
                                });
                                
                                // Destroy artifact if health depleted
                                if (chest.health <= 0) {
                                    console.log(`[Server] Artifact ${chest.id} destroyed by enemy projectile`);
                                    this.io.to(this.room.id).emit('artifactDestroyed', { chestId: chest.id });
                                }
                                
                                hit = true;
                                break;
                            }
                        }
                    }
                    
                    // Check collision with turrets (if projectile didn't hit anything else)
                    if (!hit) {
                        for (const [abilityId, ability] of this.room.abilities) {
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
                                this.io.to(this.room.id).emit('abilityHealthUpdate', {
                                    serverId: abilityId,
                                    health: ability.health,
                                    healthMax: ability.healthMax
                                });
                                
                                // Destroy turret if health depleted
                                if (ability.health <= 0) {
                                    this.io.to(this.room.id).emit('abilityTriggered', {
                                        serverId: abilityId,
                                        type: 'AutoTurret',
                                        event: 'death'
                                    });
                                    this.room.abilities.delete(abilityId);
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
                    this.room.enemyProjectiles.splice(i, 1);
                }
            }
            
            // FINAL CLEANUP: Remove shield collision boxes from dead WallGuys
            // This runs at the END of the update loop to catch all WallGuy deaths that happened during this frame
            // (from artillery, player bullets, abilities, etc.)
            if (this.room.environment && this.room.environment.orientedBoxes) {
                for (let i = this.room.environment.orientedBoxes.length - 1; i >= 0; i--) {
                    const box = this.room.environment.orientedBoxes[i];
                    if (box._wallguyId) {
                        const wallguy = this.room.enemies.get(box._wallguyId);
                        // Remove box if WallGuy is dead or doesn't exist
                        if (!wallguy || !wallguy.alive) {
                            this.room.environment.orientedBoxes.splice(i, 1);
                            // Also clear the reference on the enemy if it still exists
                            if (wallguy) {
                                delete wallguy._shieldCollisionIndex; // legacy
                                delete wallguy._shieldCollisionBox;
                            }
                        }
                    }
                }
            }
        } catch (e) {
            console.error('[Server] updateEnemies error:', e && e.stack ? e.stack : String(e));
        }
    }

    _findClosestPlayer(x, y) {
        let closestPlayer = null;
        let closestDist = Infinity;
        for (const [, p] of this.room.players) {
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
    
    // Broadcast methods for dash events
    _broadcastEnemyDashWindup(enemyId, targetPlayerId) {
        const roomId = this.room.id;
        if (this.io && this.io.to) {
            this.io.to(roomId).emit('enemyDashWindup', {
                enemyId: enemyId,
                targetPlayerId: targetPlayerId
            });
        }
    }
    
    _broadcastEnemyDash(enemyId, targetPlayerId, dirX, dirY) {
        const roomId = this.room.id;
        if (this.io && this.io.to) {
            this.io.to(roomId).emit('enemyDash', {
                enemyId: enemyId,
                targetPlayerId: targetPlayerId,
                dirX: dirX,
                dirY: dirY
            });
        }
    }
    
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
            this.io.to(this.room.id).emit('artilleryStrike', {
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
            this.room.enemyProjectiles.push({
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
            this.io.to(this.room.id).emit('artilleryGunStrike', {
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
            this.room.enemyProjectiles.push({
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
    
    /* COMMENTED OUT - Now using NetworkManager (Phase 3)
    _getEnemiesStatePayload() {
        const out = [];
        for (const e of this.room.enemies.values()) {
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
        for (const e of this.room.enemies.values()) {
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
            for (const e of this.room.enemies.values()) {
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
            for (const e of this.room.enemies.values()) {
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
        if (!this.room._lastEnemiesStateFullAt || (now - this.room._lastEnemiesStateFullAt) >= FULL_REFRESH_MS) {
            this.room._lastEnemiesStateFullAt = now;
            
            // Legacy event (will be removed after migration)
            this.io.to(this.room.id).emit('enemiesState', this._getEnemiesStatePayload());
            
            // Phase 3: New consolidated event (active if feature flag enabled)
            if (Protocol.FEATURES.DUAL_EMIT_ENTITIES) {
                this.io.to(this.room.id).emit('entitiesState', this._getEntitiesStatePayload());
            }
            return;
        }

        const INTEREST_RADIUS = 5500; // generous radius to prevent popping in fast-paced play
        const r2 = INTEREST_RADIUS * INTEREST_RADIUS;
        for (const [, p] of this.room.players) {
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
    
    // Ambient NPC management methods
    spawnLobbyAmbientNpcs() {
        // Only create ambient NPCs if in lobby scene
        if (this.room.scene !== 'lobby') {
            return;
        }

        // Atomic guard to prevent race condition on concurrent joins
        if (this.room.ambientSpawned) {
            return;
        }
        this.room.ambientSpawned = true;

        console.log('[AMBIENT_NPCs] Spawning ambient NPCs with seeded RNG');

        // Use seeded RNG for synchronized NPC placement across all players (same logic as client)
        const rng = new SeededRNG(this.room.worldSeed);
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
            const bWorld = Number.isFinite(this.room.boundary) ? this.room.boundary : 1000;
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
            if (!this.room.environment.isInsideBounds || !this.room.environment.circleHitsAny) return true;
            if (!this.room.environment.isInsideBounds(x, y, r)) return false;
            if (this.room.environment.circleHitsAny(x, y, r)) return false;
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
                if (this.room.enemies) {
                    for (const e of this.room.enemies.values()) {
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

        const b = this.room.boundary - 60;
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
            for (let step = 0; step < 10 && (this.room.environment.circleHitsAny && this.room.environment.circleHitsAny(cx, cy, r) || !this.room.environment.isInsideBounds(cx, cy, r)); step++) {
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
                const barkSeed = this.room.worldSeed + k; // Unique per NPC but deterministic
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
                this.room.ambientNpcs.push(npc);
                placed.push({ x, y, r });
            }
        }
        this.room.broadcastAmbientNpcs();

        console.log(`[AMBIENT_NPCs] Spawned ${placed.length} ambient NPCs in room ${this.room.id} using seed: ${this.room.worldSeed}`);
    }
    
    // =========================================
    // NAVMESH PATHFINDING HELPER METHODS
    // =========================================
    
    _hasLineOfSight(startX, startY, endX, endY) {
        // Check if there's a clear line of sight between two points (no walls blocking)
        if (!this.room.environment) return true;
        
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
            if (this.room.environment.circleHitsAny && this.room.environment.circleHitsAny(x, y, 20)) {
                return false; // Line blocked
            }
        }
        
        return true; // Clear line of sight
    }
    
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
        if (!this._navDecodedGrid) {
            // First time: decode and cache
            const grid = new Array(h);
            for (let j = 0; j < h; j++) {
                grid[j] = this._decodeNavRow(nav.rowsRLE[j], w);
            }
            this._navDecodedGrid = grid;
        }
        const grid = this._navDecodedGrid;
        
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
                
                // Diagonal movement costs sqrt(2) ≈ 1.414
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
}

// =========================================
// BINARY MIN-HEAP (for A* pathfinding)
// =========================================
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

module.exports = EnemyManager;
