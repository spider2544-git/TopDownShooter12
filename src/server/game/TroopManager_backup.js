// Server-side Troops Manager (allied units on player team)
// Mirrors enemiesState pattern: server-authoritative positions broadcast at 10Hz.
// Troops are friendly units that spawn behind players in Trench Raid and follow/charge.

class TroopManager {
    constructor(room, io, opts = {}) {
        this.room = room;
        this.io = io;

        this.troops = new Map(); // id -> troop

        this.BROADCAST_HZ = opts.broadcastHz || 10;
        this._broadcastIntervalMs = 1000 / this.BROADCAST_HZ;
        this._nextBroadcastTime = 0;
        
        // Barracks spawn state
        this.barracks = [];
        this._nextTroopId = 0;
        this._spawnCooldowns = new Map(); // barracksId -> cooldown timer
    }

    clear() {
        this.troops.clear();
        this.barracks = [];
        this._spawnCooldowns.clear();
    }

    onLevelStart(modeConfig) {
        // Initialize barracks for continuous troop spawning
        if (!this.room || this.room.scene !== 'level') return;
        if (!modeConfig || !modeConfig.troops || modeConfig.troops.enabled !== true) return;

        const cfg = modeConfig.troops.barracks || {};
        
        // Artillery is at x: -11800, y: -500 (upper) and y: 500 (lower)
        // Place barracks 200 units above/below artillery
        this.barracks = [
            {
                id: 'barracks_upper',
                x: cfg.x || -11800,
                y: cfg.upperY || -700,
                spawnInterval: cfg.spawnInterval || 3.0,  // seconds between spawns
                maxTroops: cfg.maxTroops || 24,           // max troops alive from this barracks
                targetX: cfg.targetX || -9500              // where troops should move to (ZoneA)
            },
            {
                id: 'barracks_lower',
                x: cfg.x || -11800,
                y: cfg.lowerY || 700,
                spawnInterval: cfg.spawnInterval || 3.0,
                maxTroops: cfg.maxTroops || 24,
                targetX: cfg.targetX || -9500
            }
        ];

        // Initialize spawn cooldowns with random offsets (desync barracks)
        for (const barracks of this.barracks) {
            this._spawnCooldowns.set(barracks.id, Math.random() * 1.5); // Random initial delay 0-1.5s
        }

        console.log(`[TroopManager] Initialized ${this.barracks.length} barracks for continuous troop spawning`);
        
        // Spawn initial troops immediately
        for (const barracks of this.barracks) {
            this._spawnTroopFromBarracks(barracks);
        }
        
        this.broadcast(true);
    }

    update(dt, nowMs) {
        if (!this.room || this.room.scene !== 'level') return;
        if (!Number.isFinite(dt) || dt <= 0) return;

        const env = this.room.environment;
        
        // Debug: Log troop count every 5 seconds
        if (!this._debugLogTimer) this._debugLogTimer = 0;
        this._debugLogTimer += dt;
        if (this._debugLogTimer >= 5) {
            const aliveTroops = Array.from(this.troops.values()).filter(t => t && t.alive);
            // console.log(`[TroopManager] Update: ${aliveTroops.length} alive troops (${this.troops.size} total)`);
            if (aliveTroops.length > 0) {
                const sample = aliveTroops[0];
                // console.log(`[TroopManager] Sample troop: ${sample.id} - health: ${sample.health}/${sample.healthMax}, pos: (${sample.x.toFixed(0)}, ${sample.y.toFixed(0)})`);
            }
            this._debugLogTimer = 0;
        }

        // Update spawn cooldowns and spawn new troops from barracks
        for (const barracks of this.barracks) {
            let cooldown = this._spawnCooldowns.get(barracks.id) || 0;
            cooldown -= dt;
            
            if (cooldown <= 0) {
                // Count how many troops are alive from this barracks
                let troopsFromBarracks = 0;
                for (const troop of this.troops.values()) {
                    if (troop.barracksId === barracks.id && troop.alive) troopsFromBarracks++;
                }
                
                // Spawn if under limit
                if (troopsFromBarracks < barracks.maxTroops) {
                    this._spawnTroopFromBarracks(barracks);
                    // Add ±20% randomness to spawn interval (prevents perfect sync)
                    const variance = barracks.spawnInterval * 0.2 * (Math.random() - 0.5) * 2;
                    cooldown = barracks.spawnInterval + variance;
                }
            }
            
            this._spawnCooldowns.set(barracks.id, cooldown);
        }

        // Update all troops
        for (const troop of this.troops.values()) {
            if (!troop || troop.alive === false) continue;

            // Check for fire pool hazards (apply DOT and VFX)
            if (this.room.hazards && Array.isArray(this.room.hazards.firePools)) {
                this._checkTroopFirePoolCollision(troop, dt);
            }

            // Update attack cooldown
            if (troop.attackCooldown > 0) troop.attackCooldown -= dt;

            // Find nearest enemy to attack
            const nearestEnemy = this._findNearestEnemy(troop, troop.attackRange || 80);
            if (nearestEnemy) {
                troop.targetEnemyId = nearestEnemy.id;
                
                // Update barrel angle for ranged troops (visual only)
                if (troop.type === 'trooper_ranged' || troop.type === 'trooper_grenadier') {
                    troop._barrelAngle = Math.atan2(nearestEnemy.y - troop.y, nearestEnemy.x - troop.x);
                }
                
                // Attack if cooldown ready
                if (troop.attackCooldown <= 0) {
                    if (troop.type === 'trooper_ranged') {
                        this._attackRanged(troop, nearestEnemy);
                        // Randomized cooldown (0.45-0.65s) to desync attacks
                        troop.attackCooldown = 0.45 + Math.random() * 0.2;
                    } else if (troop.type === 'trooper_grenadier') {
                        this._attackGrenadier(troop, nearestEnemy);
                        // Grenadiers fire slower (1.0-1.3s cooldown)
                        troop.attackCooldown = 1.0 + Math.random() * 0.3;
                    } else {
                        this._attackMelee(troop, nearestEnemy);
                        // Randomized cooldown (0.3-0.5s) to desync attacks
                        troop.attackCooldown = 0.3 + Math.random() * 0.2;
                    }
                }
            } else {
                troop.targetEnemyId = null;
            }

            // Initialize stuck tracking if needed
            if (!troop._stuckTimer) troop._stuckTimer = 0;
            if (!troop._lastPos) troop._lastPos = { x: troop.x, y: troop.y };
            if (!troop._unstickAngle) troop._unstickAngle = null;
            if (!troop._movementTargetId) troop._movementTargetId = null;
            
            // Initialize retargeting timer (stagger decision-making between troops)
            if (troop._retargetTimer === undefined) {
                troop._retargetTimer = Math.random() * 2.0; // Random initial delay 0-2 seconds
            }
            
            // Decrement retarget timer
            troop._retargetTimer -= dt;

            // Find a target enemy to move toward (longer range than attack range)
            const movementRange = troop.type === 'trooper_ranged' ? 1200 : 800;
            let movementTarget = null;

            // Check if current movement target is still valid
            if (troop._movementTargetId) {
                const currentTarget = this.room.enemies.get(troop._movementTargetId);
                if (currentTarget && currentTarget.alive) {
                    const targetDist = Math.hypot(currentTarget.x - troop.x, currentTarget.y - troop.y);
                    // Keep target if still in range
                    if (targetDist < movementRange * 1.5) { // 1.5x to avoid constant retargeting
                        movementTarget = currentTarget;
                    }
                }
            }

            // If no valid target, find a new one (only when retarget timer expires)
            if (!movementTarget && troop._retargetTimer <= 0) {
                movementTarget = this._findNearestEnemy(troop, movementRange);
                troop._movementTargetId = movementTarget ? movementTarget.id : null;
                
                // Reset timer with some randomness (1.5-3.5 seconds)
                troop._retargetTimer = 1.5 + Math.random() * 2.0;
            }

            // PRIMARY GOAL: Zone progression (push through battlefield)
            const zoneGoal = this._getZoneGoalForTroop(troop);
            let tx = zoneGoal.x;
            let ty = zoneGoal.y;

            // SECONDARY: If enemy is nearby AND blocking our path, target them instead
            if (movementTarget) {
                const enemyDx = movementTarget.x - troop.x;
                const enemyToGoalDx = zoneGoal.x - movementTarget.x;
                
                // Only divert to enemy if they're BETWEEN us and our zone goal
                // OR very close (within 800 units)
                const enemyDist = Math.hypot(movementTarget.x - troop.x, movementTarget.y - troop.y);
                const isBlocking = (enemyDx > 0 && enemyToGoalDx > 0);
                const isVeryClose = enemyDist < 800;
                
                if (isBlocking || isVeryClose) {
                    tx = movementTarget.x;
                    ty = movementTarget.y;
                }
            }
            
            const dx = tx - troop.x;
            const dy = ty - troop.y;
            const dist = Math.hypot(dx, dy);
            
            // Don't move if already in attack range of ANY enemy (fight first)
            // Add randomness and tighter range so not all troops stop simultaneously
            const combatStopChance = 0.7; // 70% chance to stop when enemy in range
            const enemyDist = nearestEnemy ? Math.hypot(nearestEnemy.x - troop.x, nearestEnemy.y - troop.y) : Infinity;
            const shouldStopForCombat = nearestEnemy && 
                enemyDist < troop.attackRange * 0.8 && // Stop at 80% of attack range
                Math.random() < combatStopChance; // Randomized decision (70% stop, 30% keep moving)
                
            if (shouldStopForCombat) continue;

            let ux = dx / dist;
            let uy = dy / dist;

            // Check if stuck (moved less than 10 units in last second)
            const distMovedRecently = Math.hypot(troop.x - troop._lastPos.x, troop.y - troop._lastPos.y);
            if (distMovedRecently < 10) {
                troop._stuckTimer += dt;
            } else {
                troop._stuckTimer = 0;
                troop._unstickAngle = null;
            }
            troop._lastPos = { x: troop.x, y: troop.y };

            // Anti-clumping: steer away from nearby troops (STRONGER when stuck)
            const separationRadius = 70; // Increased from 50
            const separationForce = { x: 0, y: 0 };
            let nearbyCount = 0;
            
            for (const other of this.troops.values()) {
                if (!other || !other.alive || other.id === troop.id) continue;
                const odx = troop.x - other.x;
                const ody = troop.y - other.y;
                const odist = Math.hypot(odx, ody);
                
                if (odist < separationRadius && odist > 0.1) {
                    // Steer away from nearby troop (stronger when closer)
                    const force = (separationRadius - odist) / separationRadius;
                    separationForce.x += (odx / odist) * force;
                    separationForce.y += (ody / odist) * force;
                    nearbyCount++;
                }
            }
            
            // Apply separation force (MUCH STRONGER when stuck or clustered)
            if (nearbyCount > 0) {
                separationForce.x /= nearbyCount;
                separationForce.y /= nearbyCount;
                
                // Increase separation weight when stuck or clustered
                const isStuck = troop._stuckTimer > 0.5;
                const isClustered = nearbyCount > 3;
                const separationWeight = (isStuck || isClustered) ? 0.7 : 0.3;
                
                ux = ux * (1 - separationWeight) + separationForce.x * separationWeight;
                uy = uy * (1 - separationWeight) + separationForce.y * separationWeight;
                
                // Normalize
                const len = Math.hypot(ux, uy);
                if (len > 0.01) {
                    ux /= len;
                    uy /= len;
                }
            }

            // If stuck for a while, use aggressive unsticking
            if (troop._stuckTimer > 1.0) {
                // Generate a persistent random angle for this stuck episode
                if (troop._unstickAngle === null) {
                    troop._unstickAngle = (Math.random() - 0.5) * Math.PI; // Random ±90°
                }
                
                // Move in the unstick direction (perpendicular to forward + random)
                const baseAngle = Math.atan2(uy, ux);
                const unstickAngle = baseAngle + troop._unstickAngle;
                ux = Math.cos(unstickAngle);
                uy = Math.sin(unstickAngle);
                
                // Reset stuck timer occasionally to try forward again
                if (troop._stuckTimer > 3.0) {
                    troop._stuckTimer = 0;
                    troop._unstickAngle = null;
                }
            }

            const spd = Number.isFinite(troop.speed) ? troop.speed : 120;
            let step = spd * dt;

            // Try moving in desired direction
            if (step > 0 && env && typeof env.resolveCircleMove === 'function') {
                const res = env.resolveCircleMove(troop.x, troop.y, troop.radius || 22, ux * step, uy * step);
                
                // Check if we actually moved (not stuck on wall)
                const moved = Math.hypot(res.x - troop.x, res.y - troop.y);
                
                if (moved < step * 0.1) {
                    // Stuck RIGHT NOW! Try tangential movement (slide along wall)
                    const perpAngles = [Math.PI / 2, -Math.PI / 2]; // Try left, then right
                    let bestRes = res;
                    let bestDist = moved;
                    
                    for (const perpOffset of perpAngles) {
                        const angle = Math.atan2(uy, ux) + perpOffset;
                        const tangentUx = Math.cos(angle);
                        const tangentUy = Math.sin(angle);
                        const tangentRes = env.resolveCircleMove(troop.x, troop.y, troop.radius || 22, tangentUx * step, tangentUy * step);
                        const tangentMoved = Math.hypot(tangentRes.x - troop.x, tangentRes.y - troop.y);
                        
                        if (tangentMoved > bestDist) {
                            bestRes = tangentRes;
                            bestDist = tangentMoved;
                        }
                    }
                    
                    // If tangential didn't work, try backing up slightly
                    if (bestDist < step * 0.1) {
                        const backupRes = env.resolveCircleMove(troop.x, troop.y, troop.radius || 22, -ux * step * 0.5, -uy * step * 0.5);
                        const backupMoved = Math.hypot(backupRes.x - troop.x, backupRes.y - troop.y);
                        if (backupMoved > 0) {
                            bestRes = backupRes;
                        }
                    }
                    
                    troop.x = bestRes.x;
                    troop.y = bestRes.y;
                } else {
                    troop.x = res.x;
                    troop.y = res.y;
                }
            } else if (step > 0) {
                troop.x += ux * step;
                troop.y += uy * step;
            }
        }

        // 10Hz replication, like enemies/NPCs
        this.broadcast(false, nowMs);
    }

    _spawnTroopFromBarracks(barracks) {
        const id = `troop_${barracks.id}_${this._nextTroopId++}`;
        
        // Find a clear spawn position near barracks (avoid clumping)
        let spawnX = barracks.x;
        let spawnY = barracks.y;
        
        const env = this.room.environment;
        const radius = 22;
        const minSeparation = 60; // Minimum distance between troops
        
        // Try to find a clear spot (spiral outward from barracks)
        let placed = false;
        for (let attempt = 0; attempt < 20 && !placed; attempt++) {
            const angle = (attempt / 20) * Math.PI * 2;
            const dist = 40 + attempt * 12;
            const testX = barracks.x + Math.cos(angle) * dist;
            const testY = barracks.y + Math.sin(angle) * dist;
            
            // Check environment collision
            if (env && env.circleHitsAny && env.circleHitsAny(testX, testY, radius)) continue;
            if (env && env.isInsideBounds && !env.isInsideBounds(testX, testY, radius)) continue;
            
            // Check distance to other troops (anti-clumping)
            let tooClose = false;
            for (const other of this.troops.values()) {
                if (!other || !other.alive) continue;
                const dx = testX - other.x;
                const dy = testY - other.y;
                if (dx * dx + dy * dy < minSeparation * minSeparation) {
                    tooClose = true;
                    break;
                }
            }
            
            if (!tooClose) {
                spawnX = testX;
                spawnY = testY;
                placed = true;
            }
        }
        
        // Troop type distribution: 10% grenadier, 30% ranged, 60% melee
        const roll = Math.random();
        let troopType, attackRange, speed;
        
        if (roll < 0.1) {
            troopType = 'trooper_grenadier';
            attackRange = 500; // Medium range for grenade throws
            speed = 100;
        } else if (roll < 0.4) {
            troopType = 'trooper_ranged';
            attackRange = 600;
            speed = 100;
        } else {
            troopType = 'trooper_melee';
            attackRange = 80;
            speed = 120;
        }
        
                this.troops.set(id, {
                    id,
                    type: troopType,
                    faction: 'newantioch',
                    alive: true,
                    
                    x: spawnX,
                    y: spawnY,
                    radius: 22,
                    
                    // Health
                    health: 30,
                    healthMax: 30,
                    
                    barracksId: barracks.id,
                    targetX: barracks.targetX,
                    targetY: barracks.y,
                    
                    state: 'advance',
                    // Add ±10% speed variation for more natural movement
                    speed: speed * (0.9 + Math.random() * 0.2),
                    
                    // Combat
                    attackRange: attackRange,
                    attackCooldown: Math.random() * 0.5, // Random initial delay 0-0.5s (desync attacks)
                    targetEnemyId: null,
                    _barrelAngle: 0,
                    _movementTargetId: null  // For long-range enemy tracking
                });
    }
    
    _getZoneGoalForTroop(troop) {
        const x = troop.x;
        
        // Zone boundaries - push troops progressively through battlefield
        // Return waypoint DEEPER into the next zone
        if (x < -10200) {
            return { x: -8500, y: 0, zone: 'A' };
        } else if (x < -6800) {
            return { x: -5100, y: 0, zone: 'B' };
        } else if (x < -3400) {
            return { x: -1700, y: 0, zone: 'C' };
        } else if (x < 0) {
            return { x: 1700, y: 0, zone: 'D' };
        } else if (x < 3400) {
            return { x: 5100, y: 0, zone: 'E' };
        } else if (x < 6800) {
            return { x: 8500, y: 0, zone: 'F' };
        } else if (x < 10200) {
            return { x: 10200, y: 0, zone: 'Heretic' };
        } else {
            return { x: 10200, y: 0, zone: 'Heretic' };
        }
    }
    
    _findNearestEnemy(troop, range) {
        let nearest = null;
        let nearestDist = range;
        
        for (const [, enemy] of this.room.enemies) {
            if (!enemy || !enemy.alive) continue;
            if (enemy.type === 'defenseTurret' || enemy.type === 'artilleryGun') continue; // Don't attack friendly units
            
            const dx = enemy.x - troop.x;
            const dy = enemy.y - troop.y;
            const dist = Math.hypot(dx, dy);
            
            if (dist < nearestDist) {
                nearest = enemy;
                nearestDist = dist;
            }
        }
        
        return nearest;
    }
    
    _handleEnemyDeath(enemy) {
        // Handle special death effects for different enemy types
        // This matches the logic in server.js enemyDied handler
        
        if (enemy.type === 'boomer') {
            // Broadcast explosion VFX and create puke pool
            this.io.to(this.room.id).emit('boomerExploded', { 
                id: enemy.id, 
                x: enemy.x, 
                y: enemy.y 
            });
            
            // Register authoritative puke pool (lasts ~12s, radius ~100)
            try { 
                if (!this.room.boomerPools) this.room.boomerPools = [];
                this.room.boomerPools.push({ 
                    x: enemy.x, 
                    y: enemy.y, 
                    radius: 100, 
                    ttl: 12.0 
                }); 
            } catch(_) {}
            
            // Apply explosion damage to nearby players (server-authoritative)
            const blastRadius = 100;
            const inner = 20;
            for (const [, p] of this.room.players) {
                if (!p || p.health <= 0) continue;
                const dx = (p.x || 0) - enemy.x;
                const dy = (p.y || 0) - enemy.y;
                const dist = Math.hypot(dx, dy);
                const pr = p.radius || 20;
                if (dist <= blastRadius + pr) {
                    const outer = blastRadius;
                    let t = (dist - inner) / Math.max(1e-6, (outer - inner));
                    t = Math.max(0, Math.min(1, t));
                    const rawDmg = 45 - 25 * t;
                    p.health = Math.max(0, p.health - rawDmg);
                }
            }
            
            // Apply explosion damage to nearby troops (server-authoritative)
            if (this.troops) {
                for (const [, troop] of this.troops) {
                    if (!troop || !troop.alive || troop.health <= 0) continue;
                    const dx = (troop.x || 0) - enemy.x;
                    const dy = (troop.y || 0) - enemy.y;
                    const dist = Math.hypot(dx, dy);
                    const tr = troop.radius || 22;
                    if (dist <= blastRadius + tr) {
                        const outer = blastRadius;
                        let t = (dist - inner) / Math.max(1e-6, (outer - inner));
                        t = Math.max(0, Math.min(1, t));
                        const rawDmg = 45 - 25 * t;
                        troop.health = Math.max(0, troop.health - rawDmg);
                        
                        this.io.to(this.room.id).emit('troopDamaged', {
                            troopId: troop.id,
                            damage: rawDmg,
                            health: troop.health,
                            healthMax: troop.healthMax,
                            x: troop.x,
                            y: troop.y
                        });
                        
                        if (troop.health <= 0) {
                            troop.alive = false;
                            this.io.to(this.room.id).emit('troopDeath', {
                                troopId: troop.id,
                                x: troop.x,
                                y: troop.y
                            });
                        }
                    }
                }
            }
        }
        
        // Add other special death handlers here as needed (e.g., Fastballs, etc.)
    }
    
    _attackMelee(troop, enemy) {
        if (!enemy || !enemy.alive) return;
        
        const damage = 5 + Math.floor(Math.random() * 3); // 5-7 damage
        enemy.health -= damage;
        
        // Broadcast enemy health update so all clients see the damage
        this.io.to(this.room.id).emit('enemyHealthUpdate', {
            id: enemy.id,
            health: enemy.health,
            healthMax: enemy.healthMax
        });
        
        if (enemy.health <= 0) {
            enemy.health = 0;
            enemy.alive = false;
            
            // Handle special death effects (Boomers, etc.)
            this._handleEnemyDeath(enemy);
            
            // Broadcast enemy death
            this.io.to(this.room.id).emit('enemy_dead', {
                id: enemy.id,
                x: enemy.x,
                y: enemy.y,
                type: enemy.type
            });
        }
        
        // Broadcast attack VFX (teal slash) and damage
        const angle = Math.atan2(enemy.y - troop.y, enemy.x - troop.x);
        this.io.to(this.room.id).emit('troopAttack', {
            troopId: troop.id,
            x: troop.x,
            y: troop.y,
            angle: angle,
            attackType: 'melee',
            targetId: enemy.id,
            targetX: enemy.x,
            targetY: enemy.y,
            damage: damage
        });
    }
    
    _attackRanged(troop, enemy) {
        if (!enemy || !enemy.alive) return;
        
        const damage = 3 + Math.floor(Math.random() * 3); // 3-5 damage
        const angle = Math.atan2(enemy.y - troop.y, enemy.x - troop.x);
        
        // Calculate bullet trajectory from troop to enemy (for hazard damage)
        const troopX = troop.x;
        const troopY = troop.y;
        const enemyX = enemy.x;
        const enemyY = enemy.y;
        
        // Check if shot is blocked by environment walls or wall guy shields
        let blocked = false;
        if (this.room.environment && typeof this.room.environment.lineHitsAny === 'function') {
            blocked = this.room.environment.lineHitsAny(troopX, troopY, enemyX, enemyY);
        }
        
        // Damage environmental hazards along the shot path (like other hitscan weapons)
        let hitHazard = false;
        if (!blocked && this.room.hazards) {
            // Check sandbag collision
            if (typeof this.room.hazards.damageFromBulletLine === 'function') {
                hitHazard = this.room.hazards.damageFromBulletLine(troopX, troopY, enemyX, enemyY, damage);
            }
            
            // Check barrel collision (if didn't hit sandbag)
            if (!hitHazard && typeof this.room.hazards.damageBarrelFromBulletLine === 'function') {
                hitHazard = this.room.hazards.damageBarrelFromBulletLine(troopX, troopY, enemyX, enemyY, damage);
            }
        }
        
        // Only damage enemy if shot wasn't blocked and didn't hit a hazard first
        if (!blocked && !hitHazard) {
            // Apply damage instantly (hitscan)
            enemy.health -= damage;
            
            // Broadcast enemy health update so all clients see the damage
            this.io.to(this.room.id).emit('enemyHealthUpdate', {
                id: enemy.id,
                health: enemy.health,
                healthMax: enemy.healthMax
            });
            
            if (enemy.health <= 0) {
                enemy.health = 0;
                enemy.alive = false;
                
                // Handle special death effects (Boomers, etc.)
                this._handleEnemyDeath(enemy);
                
                // Broadcast enemy death
                this.io.to(this.room.id).emit('enemy_dead', {
                    id: enemy.id,
                    x: enemy.x,
                    y: enemy.y,
                    type: enemy.type
                });
            }
        }
        
        // Broadcast hitscan fire event (like turrets/weapon 7)
        // Always broadcast for visual feedback, even if blocked or hit hazard
        this.io.to(this.room.id).emit('troopHitscan', {
            troopId: troop.id,
            x: troop.x,
            y: troop.y,
            angle: angle,
            targetX: enemy.x,
            targetY: enemy.y,
            targetId: enemy.id,
            damage: damage,
            hitHazard: hitHazard, // Flag if shot was blocked by hazard
            blocked: blocked // Flag if shot was blocked by wall/shield
        });
    }
    
    _attackGrenadier(troop, enemy) {
        if (!enemy || !enemy.alive) return;
        
        const angle = Math.atan2(enemy.y - troop.y, enemy.x - troop.x);
        
        // Broadcast grenade fire event (clients will create projectile and handle explosion)
        // Grenade properties: 50% radius (50 instead of 100), 30% damage
        this.io.to(this.room.id).emit('troopGrenade', {
            troopId: troop.id,
            x: troop.x,
            y: troop.y,
            angle: angle,
            targetX: enemy.x,
            targetY: enemy.y,
            targetId: enemy.id,
            explosionRadius: 50,  // 50% of weapon 2's 100 radius
            explosionDamage: 0.3  // 30% damage multiplier (base 100 -> 30 at center, 20 -> 6 at edge)
        });
    }

    _checkTroopFirePoolCollision(troop, dt) {
        if (!troop || !troop.alive) return;
        const firePools = this.room.hazards.firePools || [];
        
        // Initialize DOT stacks if needed
        if (!troop.dotStacks) troop.dotStacks = [];
        
        let inFirePool = false;
        
        // Check all fire pools
        for (let i = 0; i < firePools.length; i++) {
            const f = firePools[i];
            if (!f) continue;
            
            const dx = troop.x - f.x;
            const dy = troop.y - f.y;
            const distSq = dx * dx + dy * dy;
            const radiusSq = (f.radius || 200) * (f.radius || 200);
            
            if (distSq <= radiusSq) {
                inFirePool = true;
                
                // Track if troop was already burning before applying DOT
                const wasAlreadyBurning = troop.dotStacks.some(d => d && d.key === 'hazard_fire');
                
                // Apply/refresh DOT stack
                const dps = Number.isFinite(f.dotDps) ? f.dotDps : 20;
                const duration = 0.6; // Refresh every 0.6s (same as players)
                
                // Find existing fire DOT or add new one
                let existingDot = troop.dotStacks.find(d => d && d.key === 'hazard_fire');
                if (existingDot) {
                    existingDot.timeLeft = duration;
                    existingDot.dps = dps;
                } else {
                    troop.dotStacks.push({
                        key: 'hazard_fire',
                        dps: dps,
                        timeLeft: duration
                    });
                }
                
                // Broadcast burn state for fire VFX when troop starts burning (first time only)
                if (!wasAlreadyBurning) {
                    try {
                        this.io.to(this.room.id).emit('vfxEvent', {
                            type: 'burnStateChanged',
                            troopId: troop.id,
                            entityType: 'troop',
                            burning: true,
                            x: troop.x,
                            y: troop.y
                        });
                        console.log('[TroopManager] 🔥 Troop', troop.id, 'started burning from fire pool');
                    } catch(err) {
                        console.error('[TroopManager] Failed to broadcast troop burn state:', err);
                    }
                }
                
                break; // Only need one fire pool to burn
            }
        }
        
        // Update all DOT stacks and apply damage
        for (let i = troop.dotStacks.length - 1; i >= 0; i--) {
            const dot = troop.dotStacks[i];
            if (!dot) {
                troop.dotStacks.splice(i, 1);
                continue;
            }
            
            dot.timeLeft -= dt;
            
            if (dot.timeLeft <= 0) {
                troop.dotStacks.splice(i, 1);
            } else {
                // Apply DOT damage
                const damage = dot.dps * dt;
                troop.health = Math.max(0, troop.health - damage);
            }
        }
        
        // Broadcast burn stopped when no longer burning
        if (!inFirePool && troop.dotStacks.length === 0 && troop._wasBurning) {
            try {
                this.io.to(this.room.id).emit('vfxEvent', {
                    type: 'burnStateChanged',
                    troopId: troop.id,
                    entityType: 'troop',
                    burning: false
                });
                console.log('[TroopManager] Troop', troop.id, 'stopped burning');
            } catch(err) {
                console.error('[TroopManager] Failed to broadcast troop burn stopped:', err);
            }
            troop._wasBurning = false;
        } else if (troop.dotStacks.length > 0) {
            troop._wasBurning = true;
        }
        
        // Handle death from fire
        if (troop.health <= 0 && troop.alive) {
            troop.alive = false;
            this.io.to(this.room.id).emit('troopDeath', {
                troopId: troop.id,
                x: troop.x,
                y: troop.y,
                cause: 'fire'
            });
            console.log('[TroopManager] Troop', troop.id, 'died from fire');
        }
    }

    getStatePayload() {
        const out = [];
        for (const t of this.troops.values()) {
            if (!t || t.alive === false) continue;
            const data = {
                id: t.id,
                type: t.type,
                faction: t.faction,
                x: t.x,
                y: t.y,
                state: t.state,
                targetEnemyId: t.targetEnemyId,
                health: t.health,
                healthMax: t.healthMax,
                dotStacksCount: (t.dotStacks && t.dotStacks.length) || 0
            };
            
            // Include barrel angle for ranged troops and grenadiers
            if (t.type === 'trooper_ranged' || t.type === 'trooper_grenadier') {
                data._barrelAngle = t._barrelAngle || 0;
            }
            
            out.push(data);
        }
        return out;
    }

    broadcast(force = false, nowMs = Date.now()) {
        if (!this.io) return;
        if (!force) {
            if (Number.isFinite(this._nextBroadcastTime) && nowMs < this._nextBroadcastTime) return;
        }
        this._nextBroadcastTime = nowMs + this._broadcastIntervalMs;
        this.io.to(this.room.id).emit('troopsState', {
            troops: this.getStatePayload(),
            barracks: this.barracks.map(b => ({
                id: b.id,
                x: b.x,
                y: b.y
            }))
        });
    }
}

module.exports = { TroopManager };

