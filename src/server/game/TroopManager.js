// Server-side Troops Manager (allied units on player team)
// Mirrors enemiesState pattern: server-authoritative positions broadcast at 10Hz.
// Troops are friendly units that spawn behind players in Trench Raid and follow/charge.

const CollisionHelpers = require('../../shared/collisionHelpers.js');

class TroopManager {
    constructor(room, io, opts = {}) {
        this.room = room;
        this.io = io;

        this.troops = new Map(); // id -> troop

        // Pending troop grenades (server-authoritative damage; client renders VFX only)
        this._pendingTroopGrenades = [];

        // --- "stuck avoid zones" (soft repulsion, TTL-based) ---
        // Zones are dropped on wall contact (yellow), and promote to "stuck" (red) after being occupied for >2s.
        this._stuckZones = [];      // [{ kind, x, y, r, ttl, occupied }]
        this._stuckZoneMax = 48;    // higher cap; wall-touch zones are frequent (merged)

        this.BROADCAST_HZ = opts.broadcastHz || 10;
        this._broadcastIntervalMs = 1000 / this.BROADCAST_HZ;
        this._nextBroadcastTime = 0;
        
        // Barracks spawn state
        this.barracks = [];
        this._nextTroopId = 0;
        this._spawnCooldowns = new Map(); // barracksId -> cooldown timer

        // Troop spawning phases (2-wave behavior):
        // 1) Spawn up to cap once at level start, then stop spawning entirely
        // 2) When artifact carrier reaches Zone C, spawn up to cap again, then stop permanently
        // 0 = wait for initial fill (handled onLevelStart via burst fill)
        // 1 = locked, waiting for artifact carrier in Zone C
        // 2 = unlocked, refilling up to cap
        // 3 = locked forever (done)
        this._troopSpawnPhase = 0;
        this._troopSpawnLocked = false;
        this._troopRefillTriggered = false;
    }

    clear() {
        this.troops.clear();
        this.barracks = [];
        this._spawnCooldowns.clear();
        this._troopSpawnPhase = 0;
        this._troopSpawnLocked = false;
        this._troopRefillTriggered = false;
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
        
        // Spawn mix: keep fairly even 1/3 per troop type (per-barracks round-robin),
        // with randomized initial offsets so both barracks don't stay in perfect sync.
        for (const b of this.barracks) {
            b._spawnCycleIndex = Math.floor(Math.random() * 3); // 0..2
        }

        // Initialize spawn cooldowns with random offsets (desync barracks)
        for (const barracks of this.barracks) {
            this._spawnCooldowns.set(barracks.id, Math.random() * 1.5); // Random initial delay 0-1.5s
        }

        console.log(`[TroopManager] Initialized ${this.barracks.length} barracks for continuous troop spawning`);
        
        // === Two-wave behavior (keep original spawn rate) ===
        // Wave 1: allow normal barracks spawning until cap is reached, then lock.
        // Wave 2: when artifact carrier reaches Zone C, unlock and allow spawning until cap, then lock forever.
        this._troopSpawnPhase = 0; // initial fill
        this._troopRefillTriggered = false;
        this._troopSpawnLocked = false;
        
        this.broadcast(true);
    }

    _countAliveTroops() {
        let n = 0;
        for (const t of this.troops.values()) {
            if (t && t.alive) n++;
        }
        return n;
    }

    _getTotalTroopCap() {
        let cap = 0;
        if (!Array.isArray(this.barracks)) return 0;
        for (const b of this.barracks) {
            cap += Math.max(0, Number(b && b.maxTroops) || 0);
        }
        return cap;
    }

    _getArtifactCarrierPlayer() {
        try {
            const room = this.room;
            if (!room || !room.chests || !room.players) return null;
            for (const chest of room.chests.values()) {
                if (!chest || chest.variant !== 'gold') continue;
                if (!chest.artifactCarriedBy) continue;
                return room.players.get(chest.artifactCarriedBy) || null;
            }
            return null;
        } catch (_) {
            return null;
        }
    }

    _getZoneCConfig() {
        // Prefer config-driven bounds (Trench Raid zone system); fall back to known defaults.
        const zs = this.room && this.room.currentGameMode && this.room.currentGameMode.config
            ? this.room.currentGameMode.config.zoneSpawning
            : null;
        const zones = zs && Array.isArray(zs.zones) ? zs.zones : null;
        let zoneC = null;
        if (zones && zones.length) {
            zoneC = zones.find(z => z && typeof z.name === 'string' && z.name.trim().toLowerCase().startsWith('zone c')) || null;
        }
        return zoneC || { minX: -3400, maxX: 0, minY: -1400, maxY: 1400 };
    }

    _isPlayerInZoneC(player) {
        if (!player) return false;
        const z = this._getZoneCConfig();
        const x = Number(player.x) || 0;
        const y = Number(player.y) || 0;
        // Match zone checks elsewhere: inclusive min, exclusive max.
        return (x >= z.minX && x < z.maxX && y >= z.minY && y < z.maxY);
    }

    _resetAllBarracksCooldowns(valueSeconds = 0) {
        try {
            for (const b of this.barracks) {
                if (!b || !b.id) continue;
                this._spawnCooldowns.set(b.id, valueSeconds);
            }
        } catch (_) {}
    }

    _spawnWaveFillToCap() {
        // Spawn in round-robin across barracks until total alive reaches total cap.
        const cap = this._getTotalTroopCap();
        if (cap <= 0) return 0;

        let alive = this._countAliveTroops();
        if (alive >= cap) return 0;

        const barracksList = Array.isArray(this.barracks) ? this.barracks : [];
        if (barracksList.length === 0) return 0;

        let spawned = 0;
        // Safety bound: prevent infinite loops if something goes weird.
        let safety = cap * 5;

        while (alive < cap && safety-- > 0) {
            let didAny = false;
            for (const barracks of barracksList) {
                if (alive >= cap) break;
                if (!barracks || !barracks.id) continue;
                const max = Math.max(0, Number(barracks.maxTroops) || 0);
                if (max <= 0) continue;

                // Count alive troops from this barracks
                let fromThis = 0;
                for (const troop of this.troops.values()) {
                    if (troop && troop.alive && troop.barracksId === barracks.id) fromThis++;
                }
                if (fromThis >= max) continue;

                this._spawnTroopFromBarracks(barracks);
                spawned++;
                alive++;
                didAny = true;
            }
            if (!didAny) break;
        }

        return spawned;
    }

    update(dt, nowMs) {
        if (!this.room || this.room.scene !== 'level') return;
        if (!Number.isFinite(dt) || dt <= 0) return;

        const env = this.room.environment;

        // === Collision queries that IGNORE sandbag boxes ===
        // Sandbags are breakable hazards and should not count as "wall contact" for zone drops,
        // and should not block LOS probes for escape targeting / zone arrows.
        const obstacles = (env && Array.isArray(env.obstacles)) ? env.obstacles : [];
        const orientedBoxes = (env && Array.isArray(env.orientedBoxes)) ? env.orientedBoxes : [];
        let orientedBoxesNoSandbags = orientedBoxes;
        try {
            const sbs = this.room && this.room.hazards && Array.isArray(this.room.hazards.sandbags)
                ? this.room.hazards.sandbags
                : null;
            if (sbs && sbs.length && orientedBoxes.length) {
                const ignore = new Set();
                for (let i = 0; i < sbs.length; i++) {
                    const sb = sbs[i];
                    const bi = sb && Number.isInteger(sb.boxIndex) ? sb.boxIndex : -1;
                    if (bi >= 0) ignore.add(bi);
                }
                if (ignore.size > 0) {
                    orientedBoxesNoSandbags = orientedBoxes.filter((_, idx) => !ignore.has(idx));
                }
            }
        } catch (_) {}

        const circleHitsWorldNoSandbags = (cx, cy, cr) =>
            CollisionHelpers.circleHitsAny(cx, cy, cr, obstacles, orientedBoxesNoSandbags);

        const lineHitsWorldNoSandbags = (x1, y1, x2, y2) =>
            CollisionHelpers.lineHitsAny(x1, y1, x2, y2, obstacles, orientedBoxesNoSandbags);

        // Process scheduled troop grenade explosions (server-authoritative damage)
        this._updatePendingTroopGrenades(nowMs);

        // Decay and remove expired stuck zones
        if (this._stuckZones && this._stuckZones.length) {
            for (let i = this._stuckZones.length - 1; i >= 0; i--) {
                const z = this._stuckZones[i];
                z.ttl -= dt;
                if (z.ttl <= 0) this._stuckZones.splice(i, 1);
            }
        }
        
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

        // === Two-wave spawn gating (do NOT change spawn cadence) ===
        // Phase 0: initial fill (spawn normally until cap, then lock)
        // Phase 1: locked until artifact carrier reaches Zone C
        // Phase 2: unlocked (spawn normally until cap, then lock forever)
        if (!Number.isInteger(this._troopSpawnPhase)) this._troopSpawnPhase = 0;
        if (this._troopSpawnPhase === 0) {
            const cap = this._getTotalTroopCap();
            const alive = this._countAliveTroops();
            if (cap > 0 && alive >= cap) {
                this._troopSpawnPhase = 1;
                this._troopSpawnLocked = true;
            } else {
                this._troopSpawnLocked = false;
            }
        } else if (this._troopSpawnPhase === 1) {
            this._troopSpawnLocked = true;
            const carrier = this._getArtifactCarrierPlayer();
            if (carrier && this._isPlayerInZoneC(carrier)) {
                // Trigger refill wave once
                this._troopSpawnPhase = 2;
                this._troopSpawnLocked = false;
                this._troopRefillTriggered = true;
                // Make refill start immediately (don’t wait for old cooldown offsets)
                this._resetAllBarracksCooldowns(0);
            }
        } else if (this._troopSpawnPhase === 2) {
            // Allow spawning up to cap; when filled, lock permanently.
            const cap = this._getTotalTroopCap();
            const alive = this._countAliveTroops();
            if (cap > 0 && alive >= cap) {
                this._troopSpawnPhase = 3;
                this._troopSpawnLocked = true;
            } else {
                this._troopSpawnLocked = false;
            }
        } else if (this._troopSpawnPhase === 3) {
            this._troopSpawnLocked = true;
        }

        // Update spawn cooldowns and spawn new troops from barracks
        if (!this._troopSpawnLocked) {
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
            // For melee, require clear LOS so we don't attempt to attack through walls.
            const nearestEnemy = this._findNearestEnemy(troop, troop.attackRange || 80, {
                requireLineOfSight: troop.type === 'trooper_melee',
                env
            });
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
                        this._attackMelee(troop, nearestEnemy, env);
                        // Randomized cooldown (0.3-0.5s) to desync attacks
                        troop.attackCooldown = 0.3 + Math.random() * 0.2;
                    }
                }
            } else {
                troop.targetEnemyId = null;
            }

            // OBSTACLE BREAKING: If stuck against sandbag (and no enemy to fight), attack it to break through
            if (!nearestEnemy && this.room.hazards && this.room.hazards.sandbags) {
                if (!troop._obstacleStuckTimer) troop._obstacleStuckTimer = 0;
                if (!troop._lastObstaclePos) troop._lastObstaclePos = { x: troop.x, y: troop.y };
                const distMoved = Math.hypot(troop.x - troop._lastObstaclePos.x, troop.y - troop._lastObstaclePos.y);
                if (distMoved < 5) { 
                    troop._obstacleStuckTimer += dt; 
                } else { 
                    troop._obstacleStuckTimer = 0;
                    troop._lastObstaclePos = { x: troop.x, y: troop.y };
                }
                if (troop._obstacleStuckTimer > 2.0) {
                    let nearestSandbag = null; let nearestDist = 120;
                    for (const sb of this.room.hazards.sandbags) {
                        if (!sb || sb.health <= 0) continue;
                        const dist = Math.hypot(sb.x - troop.x, sb.y - troop.y);
                        if (dist < nearestDist) { nearestSandbag = sb; nearestDist = dist; }
                    }
                    if (nearestSandbag && troop.attackCooldown <= 0) {
                        nearestSandbag.health = Math.max(0, nearestSandbag.health - 120);
                        this.io.to(this.room.id).emit("hazardHit", { type: "sandbag", id: nearestSandbag.id, x: nearestSandbag.x, y: nearestSandbag.y, health: nearestSandbag.health });
                        const angle = Math.atan2(nearestSandbag.y - troop.y, nearestSandbag.x - troop.x);
                        this.io.to(this.room.id).emit("troopAttack", { troopId: troop.id, x: troop.x, y: troop.y, angle: angle, attackType: "melee", targetId: nearestSandbag.id, targetX: nearestSandbag.x, targetY: nearestSandbag.y, damage: 120 });
                        if (nearestSandbag.health <= 0) {
                            if (Number.isInteger(nearestSandbag.boxIndex) && nearestSandbag.boxIndex >= 0 && this.room.environment.orientedBoxes) {
                                this.room.environment.orientedBoxes.splice(nearestSandbag.boxIndex, 1);
                                for (let j = 0; j < this.room.hazards.sandbags.length; j++) {
                                    if (this.room.hazards.sandbags[j] && this.room.hazards.sandbags[j].boxIndex > nearestSandbag.boxIndex) { this.room.hazards.sandbags[j].boxIndex -= 1; }
                                }
                            }
                            const idx = this.room.hazards.sandbags.indexOf(nearestSandbag);
                            if (idx >= 0) this.room.hazards.sandbags.splice(idx, 1);
                            this.io.to(this.room.id).emit("hazardRemoved", { type: "sandbag", id: nearestSandbag.id, x: nearestSandbag.x, y: nearestSandbag.y, w: nearestSandbag.w, h: nearestSandbag.h, variant: nearestSandbag.variant, angle: nearestSandbag.angle });
                            troop._obstacleStuckTimer = 0;
                        }
                        troop.attackCooldown = 0.5;
                    }
                }
            }

            // Initialize stuck tracking / avoidance state if needed
            // Stuck definition (NEW): not leaving a small radius for 3 seconds, only counts while touching a wall.
            if (!Number.isFinite(troop._stuckTimer)) troop._stuckTimer = 0; // legacy counter kept for other heuristics
            if (!troop._stuckAnchor) troop._stuckAnchor = { x: troop.x, y: troop.y };
            if (!Number.isFinite(troop._stuckHold)) troop._stuckHold = 0;
            if (!troop._lastPos) troop._lastPos = { x: troop.x, y: troop.y };
            if (!troop._movementTargetId) troop._movementTargetId = null;
            // Avoidance state: reverse/sidestep + escape (periodically re-evaluated while stuck)
            if (!troop._avoid) troop._avoid = { active: false, phase: null, timer: 0, side: 1, escapeAngle: 0, escapeRecalc: 0 };
            if (!Number.isFinite(troop._contactTimer)) troop._contactTimer = 0;
            troop._contactTimer = Math.max(0, troop._contactTimer - dt);
            
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
                const enemyDist2 = Math.hypot(movementTarget.x - troop.x, movementTarget.y - troop.y);
                const isBlocking = (enemyDx > 0 && enemyToGoalDx > 0);
                const isVeryClose = enemyDist2 < 800;
                
                if (isBlocking || isVeryClose) {
                    if (troop.type === 'trooper_melee' && env) {
                        const wp = this._computeBypassWaypoint(troop, movementTarget, env);
                        tx = wp.x;
                        ty = wp.y;
                    } else {
                    tx = movementTarget.x;
                    ty = movementTarget.y;
                    }
                }
            }
            
            const dx = tx - troop.x;
            const dy = ty - troop.y;
            const dist = Math.hypot(dx, dy);
            if (!Number.isFinite(dist) || dist <= 0.0001) continue;

            // Robust wall-touch detection (covers sliding along walls where movement isn't clipped every frame)
            const tr = troop.radius || 22;
            const touchingWall =
                (troop._contactTimer > 0) ||
                (env && circleHitsWorldNoSandbags(troop.x, troop.y, tr + 2));

            // Quick pre-scan: are we already inside any zone / a red zone?
            // Used to bypass "combat stop" and immediately get units to walk OUT of traps.
            let preInAnyZone = false;
            let preInRedZone = false;
            if (this._stuckZones && this._stuckZones.length) {
                for (let zi = 0; zi < this._stuckZones.length; zi++) {
                    const z = this._stuckZones[zi];
                    if (!z) continue;
                    const zr = Math.max(0, z.r || 0);
                    if (zr <= 0) continue;
                    const zx = troop.x - z.x;
                    const zy = troop.y - z.y;
                    if (zx * zx + zy * zy <= zr * zr) {
                        preInAnyZone = true;
                        if ((z.kind || 'stuck') === 'stuck') { preInRedZone = true; break; }
                    }
                }
            }
            const alreadyZoneEscaping = !!(troop._avoid && troop._avoid.active && troop._avoid.phase === 'zoneEscape');
            
            // Don't move if already in attack range of ANY enemy (fight first)
            // Add randomness and tighter range so not all troops stop simultaneously
            const combatStopChance = 0.7; // 70% chance to stop when enemy in range
            const enemyDist = nearestEnemy ? Math.hypot(nearestEnemy.x - troop.x, nearestEnemy.y - troop.y) : Infinity;
            const hasCombatLOS = (troop.type === 'trooper_melee' && nearestEnemy)
                ? this._hasLineOfSight(troop.x, troop.y, nearestEnemy.x, nearestEnemy.y, env)
                : true;
            const shouldStopForCombat = nearestEnemy && 
                enemyDist < troop.attackRange * 0.8 && // Stop at 80% of attack range
                hasCombatLOS && // Melee should not stop for combat if a wall blocks the hit
                Math.random() < combatStopChance; // Randomized decision (70% stop, 30% keep moving)
                
            // If we're escaping a trap / inside a red zone, never "stop to fight" (that's how they stay wedged).
            if (shouldStopForCombat && !alreadyZoneEscaping && !preInRedZone) continue;

            let ux = dx / dist;
            let uy = dy / dist;

            // On wall-hit rising edge, drop a short-lived marker/avoid zone so you can SEE it and so troops avoid re-funneling.
            if (troop._wallTouching == null) troop._wallTouching = false;
            if (!Number.isFinite(troop._wallHitCd)) troop._wallHitCd = 0;
            troop._wallHitCd = Math.max(0, troop._wallHitCd - dt);
            const wallHitThisFrame = touchingWall && !troop._wallTouching;
            troop._wallTouching = touchingWall;
            // NEW: Yellow zone on wall contact (refreshed while still touching). Promotes to red after occupancy >2s.
            // Merge nearby zones so we don't spam.
            const Z_YELLOW_TTL = 2.5;
            const Z_YELLOW_R = 70;
            const Z_MERGE_DIST = 50;
            if (touchingWall && troop._wallHitCd <= 0 && this._stuckZones) {
                const uxg = dx / dist;
                const uyg = dy / dist;
                const forward = 18;
                const zx = troop.x + uxg * forward;
                const zy = troop.y + uyg * forward;

                let merged = false;
                for (let i = 0; i < this._stuckZones.length; i++) {
                    const z = this._stuckZones[i];
                    const ddx = z.x - zx;
                    const ddy = z.y - zy;
                    if (ddx * ddx + ddy * ddy <= Z_MERGE_DIST * Z_MERGE_DIST) {
                        // Refresh + gently pull center toward latest contact point.
                        z.x = z.x * 0.7 + zx * 0.3;
                        z.y = z.y * 0.7 + zy * 0.3;
                        z.r = Math.max(z.r || 0, Z_YELLOW_R);
                        z.ttl = Math.max(z.ttl || 0, Z_YELLOW_TTL);
                        // Never downgrade red->yellow.
                        if (!z.kind) z.kind = 'wallHit';
                        merged = true;
                        break;
                    }
                }

                if (!merged) {
                    this._stuckZones.push({
                        kind: 'wallHit',
                        x: zx,
                        y: zy,
                        r: Z_YELLOW_R,
                        ttl: Z_YELLOW_TTL,
                        occupied: 0
                    });
                    if (this._stuckZones.length > this._stuckZoneMax) this._stuckZones.shift();
                }

                // Small cooldown prevents huge merge loops from micro jitter while still feeling "immediate".
                troop._wallHitCd = wallHitThisFrame ? 0.15 : 0.25;
            }

            // Stuck tracking (NEW): "not leaving a radius within 3 seconds" around an anchor point.
            // NOTE: this is the definition used for escape and for dropping avoid-zone indicators.
            const STUCK_RADIUS = 18;   // px; tune as needed
            const STUCK_TIME_SEC = 3.0;
            if (!touchingWall) {
                // Requirement: stuck only counts while touching a wall.
                troop._stuckAnchor.x = troop.x;
                troop._stuckAnchor.y = troop.y;
                troop._stuckHold = 0;
                if (troop._avoid) troop._avoid.escapeRecalc = 0;
            } else {
                const da = Math.hypot(troop.x - troop._stuckAnchor.x, troop.y - troop._stuckAnchor.y);
                if (da <= STUCK_RADIUS) {
                    troop._stuckHold += dt;
                } else {
                    troop._stuckAnchor.x = troop.x;
                    troop._stuckAnchor.y = troop.y;
                    troop._stuckHold = 0;
                    // Reset escape recalculation cadence when clearly unstuck again
                    if (troop._avoid) troop._avoid.escapeRecalc = 0;
                }
            }
            // Keep legacy stuckTimer in sync (used by other heuristics like separation boost)
            troop._stuckTimer = troop._stuckHold;
            troop._lastPos = { x: troop.x, y: troop.y };

            // NOTE: We no longer drop separate "stuck" zones here; zones promote to red based on occupancy time.

            // Anti-clumping: steer away from nearby troops (STRONGER when stuck or clustered)
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
                const isStuck = troop._stuckTimer > 0.5 || troop._contactTimer > 0;
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

            // Zone avoidance as WALK TARGET selection (no repulsion steering).
            // This prevents oscillation/bouncing when multiple red zones are near each other:
            // we pick a target point in open space and keep walking toward it until we're clear.
            const zones = this._stuckZones || [];

            const isInsideZoneKind = (x, y, kindFilter) => {
                for (let zi = 0; zi < zones.length; zi++) {
                    const z = zones[zi];
                    if (!z) continue;
                    const kind = z.kind || 'stuck';
                    if (kindFilter && kind !== kindFilter) continue;
                    const zr = Math.max(0, z.r || 0);
                    if (zr <= 0) continue;
                    const zx = x - z.x;
                    const zy = y - z.y;
                    if (zx * zx + zy * zy <= zr * zr) return true;
                }
                return false;
            };

            // Ensure avoid state exists.
            if (!troop._avoid) troop._avoid = { active: false };
            if (!Number.isFinite(troop._avoid.redDwellT)) troop._avoid.redDwellT = 0;
            if (!Number.isFinite(troop._avoid.pickCd)) troop._avoid.pickCd = 0;

            const inRedNow = isInsideZoneKind(troop.x, troop.y, 'stuck');
            troop._avoid.redDwellT = inRedNow ? (troop._avoid.redDwellT + dt) : 0;

            const DWELL_TO_ESCAPE = 0.25;
            if (troop._avoid.redDwellT >= DWELL_TO_ESCAPE &&
                (!troop._avoid.active || troop._avoid.phase !== 'zoneEscape')) {
                troop._avoid.active = true;
                troop._avoid.phase = 'zoneEscape';
                troop._avoid.escapeMoved = 0;
                troop._avoid.escapeNeed = 110 + Math.random() * 160; // random distance into open space
                troop._avoid.clearT = 0;
                troop._avoid.escapeTx = null;
                troop._avoid.escapeTy = null;
                troop._avoid.pickCd = 0; // force immediate pick
            }

            // Fire death detour: if we enter a blue fireDeath zone, sidestep for a bit (left/right) to avoid lemmings.
            if (troop._avoid) {
                // Run active detour timer first (stable heading; not a "force")
                if (troop._avoid.active && troop._avoid.phase === 'fireDetour') {
                    troop._avoid.timer = (Number.isFinite(troop._avoid.timer) ? troop._avoid.timer : 0) - dt;
                    if (troop._avoid.timer > 0 && Number.isFinite(troop._avoid.dirX) && Number.isFinite(troop._avoid.dirY)) {
                        const dl = Math.hypot(troop._avoid.dirX, troop._avoid.dirY) || 1;
                        ux = troop._avoid.dirX / dl;
                        uy = troop._avoid.dirY / dl;
                    } else {
                        troop._avoid.active = false;
                        troop._avoid.phase = null;
                        troop._avoid.timer = 0;
                        troop._avoid.dirX = 0;
                        troop._avoid.dirY = 0;
                    }
                } else {
                    // Trigger detour if currently inside any fireDeath zone
                    let detourZ = null;
                    let bestD2 = Infinity;
                    for (let zi = 0; zi < zones.length; zi++) {
                        const z = zones[zi];
                        if (!z || z.kind !== 'fireDeath') continue;
                        const zr = Math.max(0, z.r || 0);
                        if (zr <= 0) continue;
                        const zx = troop.x - z.x;
                        const zy = troop.y - z.y;
                        const d2 = zx * zx + zy * zy;
                        if (d2 <= zr * zr && d2 < bestD2) { bestD2 = d2; detourZ = z; }
                    }
                    if (detourZ && Number.isFinite(detourZ.dirX) && Number.isFinite(detourZ.dirY)) {
                        troop._avoid.active = true;
                        troop._avoid.phase = 'fireDetour';
                        troop._avoid.timer = 0.75;
                        troop._avoid.dirX = detourZ.dirX;
                        troop._avoid.dirY = detourZ.dirY;
                        const dl = Math.hypot(detourZ.dirX, detourZ.dirY) || 1;
                        ux = detourZ.dirX / dl;
                        uy = detourZ.dirY / dl;
                    }
                }
            }

            // When escaping: choose/keep an escape target outside red zones, and walk toward it.
            if (troop._avoid && troop._avoid.active && troop._avoid.phase === 'zoneEscape') {
                troop._avoid.pickCd = Math.max(0, (troop._avoid.pickCd || 0) - dt);

                const needPick =
                    (troop._avoid.escapeTx == null) ||
                    (troop._avoid.escapeTy == null) ||
                    (troop._avoid.pickCd <= 0) ||
                    isInsideZoneKind(troop._avoid.escapeTx, troop._avoid.escapeTy, 'stuck');

                if (needPick) {
                    // First choice: follow the nearest RED zone's suggested arrow target (tx/ty or dirX/dirY).
                    // This makes units actually walk the arrow direction instead of wobbling at the boundary.
                    let arrowPicked = false;
                    let nearestRed = null;
                    let nearestScore = Infinity;
                    for (let zi = 0; zi < zones.length; zi++) {
                        const z = zones[zi];
                        if (!z) continue;
                        if ((z.kind || 'stuck') !== 'stuck') continue;
                        const zr = Math.max(0, z.r || 0);
                        if (zr <= 0) continue;
                        const dxz = troop.x - z.x;
                        const dyz = troop.y - z.y;
                        const d2 = dxz * dxz + dyz * dyz;
                        const inside = d2 <= zr * zr;
                        const score = inside ? (d2 * 0.25) : d2; // bias toward zones we're inside
                        if (score < nearestScore) { nearestScore = score; nearestRed = z; }
                    }

                    if (nearestRed) {
                        let tx0 = null, ty0 = null;
                        if (Number.isFinite(nearestRed.tx) && Number.isFinite(nearestRed.ty)) {
                            tx0 = nearestRed.tx;
                            ty0 = nearestRed.ty;
                        } else if (Number.isFinite(nearestRed.dirX) && Number.isFinite(nearestRed.dirY)) {
                            const probeArrow = 220;
                            tx0 = (nearestRed.x || 0) + nearestRed.dirX * probeArrow;
                            ty0 = (nearestRed.y || 0) + nearestRed.dirY * probeArrow;
                        }

                        if (tx0 != null) {
                            const bad =
                                isInsideZoneKind(tx0, ty0, 'stuck') ||
                                (env && lineHitsWorldNoSandbags(troop.x, troop.y, tx0, ty0));
                            if (!bad) {
                                troop._avoid.escapeTx = tx0;
                                troop._avoid.escapeTy = ty0;
                                troop._avoid.pickCd = 1.0; // keep stable longer to prevent wobble
                                arrowPicked = true;
                            }
                        }
                    }

                    if (arrowPicked) {
                        // Skip random sampling this tick; we want to commit to the zone arrow direction.
                    } else {
                    const N = 16;
                    const probe = 180;
                    let best = null;
                    let bestScore = -Infinity;

                    for (let i = 0; i < N; i++) {
                        const a = (i / N) * Math.PI * 2;
                        const px = troop.x + Math.cos(a) * probe;
                        const py = troop.y + Math.sin(a) * probe;

                        // Must not end inside a red zone.
                        if (isInsideZoneKind(px, py, 'stuck')) continue;

                        // Prefer clear segment if possible.
                        if (env && lineHitsWorldNoSandbags(troop.x, troop.y, px, py)) continue;

                        // Score by clearance to red zones.
                        let minClear = Infinity;
                        for (let zi = 0; zi < zones.length; zi++) {
                            const z = zones[zi];
                            if (!z) continue;
                            const kind = z.kind || 'stuck';
                            if (kind !== 'stuck') continue;
                            const dxz = px - z.x;
                            const dyz = py - z.y;
                            const clear = Math.hypot(dxz, dyz) - (z.r || 0);
                            if (clear < minClear) minClear = clear;
                        }
                        if (!Number.isFinite(minClear)) minClear = 0;

                        // Small bias toward actual goal direction so they don't flee backwards forever.
                        const toGoal = (px - troop.x) * (dx / dist) + (py - troop.y) * (dy / dist);
                        const score = (minClear * 2.0) + (toGoal * 0.25);

                        if (score > bestScore) { bestScore = score; best = { x: px, y: py }; }
                    }

                    if (best) {
                        troop._avoid.escapeTx = best.x;
                        troop._avoid.escapeTy = best.y;
                        troop._avoid.pickCd = 0.6; // don't repick constantly -> prevents oscillation
                    } else {
                        // Fallback: walk opposite goal briefly.
                        troop._avoid.escapeTx = troop.x - (dx / dist) * probe;
                        troop._avoid.escapeTy = troop.y - (dy / dist) * probe;
                        troop._avoid.pickCd = 0.4;
                    }
                    }
                }

                const ex = (troop._avoid.escapeTx - troop.x);
                const ey = (troop._avoid.escapeTy - troop.y);
                const el = Math.hypot(ex, ey) || 1;
                ux = ex / el;
                uy = ey / el;
            }

            const spd = Number.isFinite(troop.speed) ? troop.speed : 120;
            const step = spd * dt;

            if (step > 0 && env && typeof env.resolveCircleMove === 'function') {
                const prevX = troop.x;
                const prevY = troop.y;
                const desiredUx = ux;
                const desiredUy = uy;
                const radius = troop.radius || 22;

                const resolveFrom = (baseX, baseY, ddx, ddy) => {
                    const intendedX = baseX + ddx;
                    const intendedY = baseY + ddy;
                    if (typeof env.resolveCircleMoveWithHits === 'function') {
                        const r = env.resolveCircleMoveWithHits(baseX, baseY, radius, ddx, ddy);
                        const contacted = Array.isArray(r.hits)
                            ? (r.hits.length > 0)
                            : (Math.abs(r.x - intendedX) > 0.001 || Math.abs(r.y - intendedY) > 0.001);
                        return { r, contacted };
                    }
                    const r = env.resolveCircleMove(baseX, baseY, radius, ddx, ddy);
                    const contacted = (Math.abs(r.x - intendedX) > 0.001 || Math.abs(r.y - intendedY) > 0.001);
                    return { r, contacted };
                };

                // If we're stuck, enter "escape" and RE-PICK escape direction periodically until we actually escape.
                // This prevents the "constant loop" where a single bad escape angle is chosen once and then reused forever.
                // "Stuck" for escape: either the old contact+hold OR we are lingering inside a red zone.
                const stuckNow = ((troop._contactTimer > 0) && (troop._stuckHold >= 3.0)) ||
                    (troop._avoid && troop._avoid.redDwellT >= 0.35);
                // Never let the old ring-sample escape logic override zoneEscape (it will fight the chosen target).
                if (stuckNow && troop._avoid && troop._avoid.phase !== 'zoneEscape') {
                    troop._avoid.escapeRecalc = (troop._avoid.escapeRecalc || 0) - dt;

                    if (!troop._avoid.active) {
                        troop._avoid.active = true;
                        troop._avoid.phase = 'escape';
                        troop._avoid.timer = 1.0; // allow escape to run for a bit
                        troop._avoid.escapeRecalc = 0; // force immediate compute
                    }

                    if (troop._avoid.phase === 'escape' && troop._avoid.escapeRecalc <= 0) {
                        troop._avoid.escapeRecalc = 0.20; // re-pick ~5x/sec while stuck

                        const baseAng = Math.atan2(desiredUy, desiredUx);
                        const baseX = troop.x, baseY = troop.y;
                        const k = 12; // more directions helps in wedge corners
                        const probe = 96; // meaningful probe distance
                        const minProbeMove = 10;

                        let bestAng = baseAng;
                        let bestScore = -Infinity;
                        for (let i = 0; i < k; i++) {
                            const ang = baseAng + (i * Math.PI * 2) / k;
                            const { r, contacted } = resolveFrom(baseX, baseY, Math.cos(ang) * probe, Math.sin(ang) * probe);
                            const moveDist = Math.hypot(r.x - baseX, r.y - baseY);
                            if (moveDist < minProbeMove) continue;

                            const prog = (r.x - baseX) * desiredUx + (r.y - baseY) * desiredUy;
                            // Option 5: Prefer "no-contact" over forward progress. If we can find any clean move, take it.
                            // This allows escape to pick "back out" directions (including 180°) rather than looping forward.
                            const score = (contacted ? -10000 : 0) + moveDist + prog * 0.05;
                            if (score > bestScore) {
                                bestScore = score;
                                bestAng = ang;
                            }
                        }

                        troop._avoid.escapeAngle = bestAng;
                    }
                }

                // Avoid state: reverse -> sidestep -> (optional escape)
                if (troop._avoid && troop._avoid.active) {
                    troop._avoid.timer -= dt;
                    const rightX = -desiredUy, rightY = desiredUx;

                    if (troop._avoid.phase === 'reverse') {
                        ux = -desiredUx; uy = -desiredUy;
                        if (troop._avoid.timer <= 0) {
                            troop._avoid.phase = 'sidestep';
                            troop._avoid.timer = 0.45 + Math.random() * 0.6; // 0.45..1.05s
                        }
                    } else if (troop._avoid.phase === 'sidestep') {
                        ux = rightX * (troop._avoid.side || 1);
                        uy = rightY * (troop._avoid.side || 1);
                        ux = ux * 0.9 + desiredUx * 0.1;
                        uy = uy * 0.9 + desiredUy * 0.1;
                        const n = Math.hypot(ux, uy) || 1;
                        ux /= n; uy /= n;
                        if (troop._avoid.timer <= 0) {
                            troop._avoid.active = false;
                            troop._avoid.phase = null;
                            troop._stuckHold = 0;
                            troop._stuckTimer = 0;
                        }
                    } else if (troop._avoid.phase === 'escape') {
                        const ang = Number.isFinite(troop._avoid.escapeAngle) ? troop._avoid.escapeAngle : Math.atan2(desiredUy, desiredUx);
                        ux = Math.cos(ang);
                        uy = Math.sin(ang);
                        // IMPORTANT: do NOT blend back toward the goal while stuck,
                        // otherwise we keep re-charging into the wedge and never escape.
                        const n = Math.hypot(ux, uy) || 1;
                        ux /= n; uy /= n;
                        // Exit escape when timer ends OR we've actually escaped contact/stuck state.
                        if (troop._avoid.timer <= 0 || ((troop._contactTimer <= 0.05) && (troop._stuckHold <= 0.2))) {
                            troop._avoid.active = false;
                            troop._avoid.phase = null;
                            troop._avoid.escapeRecalc = 0;
                        }
                    } else {
                        troop._avoid.active = false;
                        troop._avoid.phase = null;
                    }
                }

                let contactedThisMove = false;
                const baseMove = resolveFrom(troop.x, troop.y, ux * step, uy * step);
                let res = baseMove.r;
                contactedThisMove = baseMove.contacted;

                const moved = Math.hypot(res.x - troop.x, res.y - troop.y);
                const minProgress = step * 0.2;

                if (moved < minProgress) {
                    // Slide choice: choose the option that makes the most FORWARD PROGRESS toward desired direction.
                    const baseAngle = Math.atan2(desiredUy, desiredUx);
                    const perpAngles = [Math.PI / 2, -Math.PI / 2];

                    let bestRes = res;
                    let bestProg = -Infinity;
                    let bestMoveDist = moved;
                    let bestSide = 1;
                    let bestContact = baseMove.contacted;

                    for (let i = 0; i < perpAngles.length; i++) {
                        const angle = baseAngle + perpAngles[i];
                        const { r: tangentRes, contacted: tangentContact } = resolveFrom(troop.x, troop.y, Math.cos(angle) * step, Math.sin(angle) * step);
                        const tangentMoved = Math.hypot(tangentRes.x - troop.x, tangentRes.y - troop.y);
                        const prog = (tangentRes.x - troop.x) * desiredUx + (tangentRes.y - troop.y) * desiredUy;
                        if (prog > bestProg || (prog === bestProg && tangentMoved > bestMoveDist)) {
                            bestRes = tangentRes;
                            bestProg = prog;
                            bestMoveDist = tangentMoved;
                            bestSide = (i === 0) ? 1 : -1;
                            bestContact = tangentContact;
                        }
                    }

                    if (bestMoveDist < minProgress) {
                        if (troop._avoid && !troop._avoid.active) {
                            troop._avoid.active = true;
                            troop._avoid.phase = 'reverse';
                            troop._avoid.timer = 0.15 + Math.random() * 0.2;
                            troop._avoid.side = bestSide;
                        }
                        const backup = resolveFrom(troop.x, troop.y, -desiredUx * step * 0.5, -desiredUy * step * 0.5);
                        const backupMoved = Math.hypot(backup.r.x - troop.x, backup.r.y - troop.y);
                        if (backupMoved > bestMoveDist) {
                            bestRes = backup.r;
                            bestMoveDist = backupMoved;
                            bestContact = backup.contacted;
                        }
                    }
                    
                    troop.x = bestRes.x;
                    troop.y = bestRes.y;
                    contactedThisMove = bestContact;
                } else {
                    troop.x = res.x;
                    troop.y = res.y;
                }

                if (contactedThisMove) troop._contactTimer = 2.0;

                // Record actual movement direction (used for fireDeath detour direction when a troop dies in fire).
                // We store the last meaningful movement vector so we can infer "entry direction" into hazards.
                const mvx = troop.x - prevX;
                const mvy = troop.y - prevY;
                const mvd = Math.hypot(mvx, mvy);
                if (mvd > 0.001) {
                    troop._lastMoveUx = mvx / mvd;
                    troop._lastMoveUy = mvy / mvd;
                }

                // zoneEscape latch bookkeeping:
                // Keep walking until we've been clear of walls + zones for a bit AND moved a random distance into open space.
                if (troop._avoid && troop._avoid.active && troop._avoid.phase === 'zoneEscape') {
                    const moved = Math.hypot(troop.x - prevX, troop.y - prevY);
                    troop._avoid.escapeMoved = (Number.isFinite(troop._avoid.escapeMoved) ? troop._avoid.escapeMoved : 0) + moved;

                    // Re-check zone containment AFTER movement (position changed).
                    let postInAny = false;
                    if (this._stuckZones && this._stuckZones.length) {
                        for (let zi = 0; zi < this._stuckZones.length; zi++) {
                            const z = this._stuckZones[zi];
                            if (!z) continue;
                            const zr = Math.max(0, z.r || 0);
                            if (zr <= 0) continue;
                            const zx = troop.x - z.x;
                            const zy = troop.y - z.y;
                            if (zx * zx + zy * zy <= zr * zr) { postInAny = true; break; }
                        }
                    }

                    // Re-check wall contact AFTER movement (touchingWall above was computed pre-move).
                    const trPost = troop.radius || 22;
                    const touchingWallPost =
                        (troop._contactTimer > 0) ||
                        (env && circleHitsWorldNoSandbags(troop.x, troop.y, trPost + 2));

                    const clearNow = (!touchingWallPost) && (!postInAny) && (troop._contactTimer <= 0);
                    troop._avoid.clearT = clearNow ? ((troop._avoid.clearT || 0) + dt) : 0;

                    const need = Number.isFinite(troop._avoid.escapeNeed) ? troop._avoid.escapeNeed : 120;
                    if (troop._avoid.escapeMoved >= need && troop._avoid.clearT >= 0.35) {
                        // Done: we're out in the open; return to normal steering.
                        troop._avoid.active = false;
                        troop._avoid.phase = null;
                        troop._avoid.dirX = 0;
                        troop._avoid.dirY = 0;
                        troop._avoid.escapeMoved = 0;
                        troop._avoid.escapeNeed = 0;
                        troop._avoid.clearT = 0;
                    }
                }
            } else if (step > 0) {
                troop.x += ux * step;
                troop.y += uy * step;
            }
        }

        // --- Post-pass: resolve troop-on-troop overlaps (prevents crowd deadlocks in funnels/corners) ---
        // We keep this simple and bounded: 2 iterations, pairwise push-apart, collision-safe via env resolver.
        if (env && typeof env.resolveCircleMove === 'function') {
            const troopsArr = Array.from(this.troops.values()).filter(t => t && t.alive);
            for (let iter = 0; iter < 2; iter++) {
                for (let i = 0; i < troopsArr.length; i++) {
                    const a = troopsArr[i];
                    const ar = a.radius || 22;
                    for (let j = i + 1; j < troopsArr.length; j++) {
                        const b = troopsArr[j];
                        const br = b.radius || 22;

                        let dx = b.x - a.x;
                        let dy = b.y - a.y;
                        let d = Math.hypot(dx, dy);
                        const minD = ar + br;
                        if (d >= minD) continue;
                        if (d < 0.001) { dx = 1; dy = 0; d = 1; }
                        const ux = dx / d;
                        const uy = dy / d;

                        const overlap = (minD - d);
                        const push = overlap * 0.5 + 0.25; // bias so it actually separates

                        const ra = env.resolveCircleMove(a.x, a.y, ar, -ux * push, -uy * push);
                        const rb = env.resolveCircleMove(b.x, b.y, br, ux * push, uy * push);
                        a.x = ra.x; a.y = ra.y;
                        b.x = rb.x; b.y = rb.y;
                    }
                }
            }
        }

        // --- Zone occupancy + promotion ---
        // Rule: zones start yellow on wall contact; if ANY troop stays inside ANY zone for >2s, that zone turns red.
        // Continuous occupancy is required (timer resets when empty).
        if (this._stuckZones && this._stuckZones.length) {
            const RED_AFTER = 2.0;
            const RED_TTL = 5.0;
            const KEEP_ALIVE_WHILE_OCCUPIED = 0.75;
            // When a zone is red ("stuck"), we keep a stable base direction but resample
            // a small cone around it periodically to avoid "one bad angle forever".
            const EXIT_CONE_DEG = 15;
            const EXIT_HALF_RAD = (EXIT_CONE_DEG * Math.PI / 180) * 0.5;
            const EXIT_RESAMPLE_MS = 1000;
            const troopsArr = Array.from(this.troops.values()).filter(t => t && t.alive);

            for (let zi = 0; zi < this._stuckZones.length; zi++) {
                const z = this._stuckZones[zi];
                const zr = Math.max(0, z.r || 0);
                if (zr <= 0) continue;

                let anyInside = false;
                for (let ti = 0; ti < troopsArr.length; ti++) {
                    const t = troopsArr[ti];
                    const dx = t.x - z.x;
                    const dy = t.y - z.y;
                    if (dx * dx + dy * dy <= zr * zr) { anyInside = true; break; }
                }

                if (anyInside) {
                    z.occupied = (Number.isFinite(z.occupied) ? z.occupied : 0) + dt;
                    z.ttl = Math.max(Number.isFinite(z.ttl) ? z.ttl : 0, KEEP_ALIVE_WHILE_OCCUPIED);
                    const kind = z.kind || 'wallHit';
                    if (kind !== 'stuck' && z.occupied >= RED_AFTER) {
                        z.kind = 'stuck';
                        z.ttl = Math.max(z.ttl, RED_TTL);

                        // Compute a suggested "exit direction" for this red zone for debug visualization.
                        // This is NOT a physics push; it's just a hint arrow showing a plausible walk-out direction.
                        if (env) {
                            const N = 16;
                            const probe = 220;
                            const rTests = [22, 30, 38, 46];
                            let best = null; // { score, dirX, dirY, tx, ty }

                            for (let i = 0; i < N; i++) {
                                const ang = (i / N) * Math.PI * 2;
                                const dirX = Math.cos(ang);
                                const dirY = Math.sin(ang);
                                const tx = z.x + dirX * probe;
                                const ty = z.y + dirY * probe;

                                if (typeof env.isInsideBounds === 'function' && !env.isInsideBounds(tx, ty, 22)) continue;
                                if (lineHitsWorldNoSandbags(z.x, z.y, tx, ty)) continue;

                                // Approximate "open-ness" by finding the largest radius that can stand there.
                                let clearance = 0;
                                if (env) {
                                    for (let ri = 0; ri < rTests.length; ri++) {
                                        const rr = rTests[ri];
                                        if (!circleHitsWorldNoSandbags(tx, ty, rr)) clearance = rr;
                                        else break;
                                    }
                                } else {
                                    clearance = 22;
                                }

                                const score = clearance;
                                if (!best || score > best.score) best = { score, dirX, dirY, tx, ty };
                            }

                            if (best) {
                                z.dirX = best.dirX;
                                z.dirY = best.dirY;
                                z.tx = best.tx;
                                z.ty = best.ty;
                                // Seed base angle for future cone resampling (stable "intended" direction).
                                z._exitBaseAngle = Math.atan2(best.dirY, best.dirX);
                                z._exitNextResampleMs = (Number.isFinite(nowMs) ? nowMs : Date.now()) + EXIT_RESAMPLE_MS;
                                z._exitSampleAngle = z._exitBaseAngle;
                            } else {
                                z.dirX = 0;
                                z.dirY = 0;
                                z.tx = null;
                                z.ty = null;
                                z._exitBaseAngle = 0;
                                z._exitNextResampleMs = (Number.isFinite(nowMs) ? nowMs : Date.now()) + EXIT_RESAMPLE_MS;
                                z._exitSampleAngle = 0;
                            }
                        }
                    }

                    // While red: periodically resample within a small cone around the base direction.
                    // This helps if the original best direction becomes blocked or leads into another wedge.
                    if ((z.kind || 'wallHit') === 'stuck' && env) {
                        // Initialize base angle from whatever direction exists, if not already present.
                        if (!Number.isFinite(z._exitBaseAngle)) {
                            let ax = null, ay = null;
                            if (Number.isFinite(z.dirX) && Number.isFinite(z.dirY) && (Math.hypot(z.dirX, z.dirY) > 0.001)) {
                                ax = z.dirX; ay = z.dirY;
                            } else if (Number.isFinite(z.tx) && Number.isFinite(z.ty)) {
                                ax = (z.tx - (z.x || 0));
                                ay = (z.ty - (z.y || 0));
                            }
                            if (ax != null) {
                                z._exitBaseAngle = Math.atan2(ay, ax);
                            } else {
                                z._exitBaseAngle = 0;
                            }
                        }
                        if (!Number.isFinite(z._exitNextResampleMs)) {
                            z._exitNextResampleMs = (Number.isFinite(nowMs) ? nowMs : Date.now()) + EXIT_RESAMPLE_MS;
                        }
                        const curNowMs = (Number.isFinite(nowMs) ? nowMs : Date.now());
                        if (curNowMs >= z._exitNextResampleMs) {
                            z._exitNextResampleMs = curNowMs + EXIT_RESAMPLE_MS;
                            const baseAng = Number.isFinite(z._exitBaseAngle) ? z._exitBaseAngle : 0;
                            const probe = 220;
                            const maxAttempts = 10;
                            let picked = false;

                            for (let ai = 0; ai < maxAttempts; ai++) {
                                const ang = baseAng + (Math.random() * 2 - 1) * EXIT_HALF_RAD;
                                const dirX = Math.cos(ang);
                                const dirY = Math.sin(ang);
                                const tx = (z.x || 0) + dirX * probe;
                                const ty = (z.y || 0) + dirY * probe;

                                if (typeof env.isInsideBounds === 'function' && !env.isInsideBounds(tx, ty, 22)) continue;
                                if (lineHitsWorldNoSandbags((z.x || 0), (z.y || 0), tx, ty)) continue;

                                z._exitSampleAngle = ang;
                                z.dirX = dirX;
                                z.dirY = dirY;
                                z.tx = tx;
                                z.ty = ty;
                                picked = true;
                                break;
                            }

                            // If nothing in the cone is valid, keep the existing direction.
                            if (!picked) {
                                z._exitSampleAngle = baseAng;
                            }
                        }
                    }
                } else {
                    z.occupied = 0;
                }
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
        
        // Troop type distribution: keep fairly even 1/3 per type (round-robin per barracks).
        // Index mapping: 0=grenadier, 1=ranged, 2=melee
        const idx = Number.isInteger(barracks._spawnCycleIndex) ? barracks._spawnCycleIndex : 0;
        barracks._spawnCycleIndex = (idx + 1) % 3;
        
        let troopType, attackRange, speed;
        if (idx === 0) {
            troopType = 'trooper_grenadier';
            attackRange = 500; // Medium range for grenade throws
            speed = 100;
        } else if (idx === 1) {
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
    
    _hasLineOfSight(x1, y1, x2, y2, env) {
        try {
            if (!env || typeof env.lineHitsAny !== 'function') return true;
            return !env.lineHitsAny(x1, y1, x2, y2);
        } catch (_) {
            return true;
        }
    }
    
    _computeBypassWaypoint(troop, target, env) {
        // Default: move toward the target directly.
        const direct = { x: target.x, y: target.y };
        
        if (!env || typeof env.lineHitsAny !== 'function') return direct;
        
        const dx = target.x - troop.x;
        const dy = target.y - troop.y;
        const dist = Math.hypot(dx, dy) || 1;
        
        // If no obstruction, don't overthink it.
        if (this._hasLineOfSight(troop.x, troop.y, target.x, target.y, env)) return direct;
        
        const desiredUx = dx / dist;
        const desiredUy = dy / dist;
        const baseAng = Math.atan2(desiredUy, desiredUx);
        
        // Sample a ring of candidate waypoints; prefer ones that are locally reachable and help
        // regain LOS to the target.
        const radius = Math.max(120, Math.min(260, dist * 0.45));
        const troopRadius = troop.radius || 22;
        const samples = 16;
        
        let best = null;
        let bestScore = -Infinity;
        
        for (let i = 0; i < samples; i++) {
            const ang = baseAng + (i * Math.PI * 2) / samples;
            const wx = troop.x + Math.cos(ang) * radius;
            const wy = troop.y + Math.sin(ang) * radius;
            
            // Skip if waypoint is inside an obstacle or outside bounds.
            try {
                if (typeof env.isInsideBounds === 'function' && !env.isInsideBounds(wx, wy, troopRadius)) continue;
                if (typeof env.circleHitsAny === 'function' && env.circleHitsAny(wx, wy, troopRadius)) continue;
            } catch (_) {}
            
            // Must be able to move there without a direct wall hit, otherwise it just slams the wall again.
            if (env.lineHitsAny(troop.x, troop.y, wx, wy)) continue;
            
            const clearToTarget = !env.lineHitsAny(wx, wy, target.x, target.y);
            const progress = (wx - troop.x) * desiredUx + (wy - troop.y) * desiredUy;
            const anglePenalty = Math.abs(((ang - baseAng + Math.PI) % (Math.PI * 2)) - Math.PI); // 0..pi
            
            // Strongly prefer regaining LOS, but still allow a move that makes forward progress even if LOS isn't
            // immediately restored (multi-corner cases).
            const score = progress + (clearToTarget ? 320 : 0) - anglePenalty * 35;
            
            if (score > bestScore) {
                bestScore = score;
                best = { x: wx, y: wy };
            }
        }
        
        return best || direct;
    }
    
    _findNearestEnemy(troop, range, opts = {}) {
        let nearest = null;
        let nearestDist = range;
        const requireLineOfSight = opts && opts.requireLineOfSight === true;
        const env = opts ? opts.env : null;
        
        for (const [, enemy] of this.room.enemies) {
            if (!enemy || !enemy.alive) continue;
            if (enemy.type === 'defenseTurret' || enemy.type === 'artilleryGun') continue; // Don't attack friendly units
            
            const dx = enemy.x - troop.x;
            const dy = enemy.y - troop.y;
            const dist = Math.hypot(dx, dy);
            
            if (dist < nearestDist) {
                if (requireLineOfSight && !this._hasLineOfSight(troop.x, troop.y, enemy.x, enemy.y, env)) continue;
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
                            // Send already-rounded integer damage for UI text (avoid "-0")
                            damage: Math.max(1, Math.round(rawDmg)),
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
        
        // Add other special death handlers here as needed (e.g., Fastballs, etc.)
    }
    
    _attackMelee(troop, enemy, env) {
        if (!enemy || !enemy.alive) return;
        
        // Prevent melee attacks through walls/obstacles.
        if (!this._hasLineOfSight(troop.x, troop.y, enemy.x, enemy.y, env)) return;
        
        const damage = 5 + Math.floor(Math.random() * 3); // 5-7 damage
        enemy.health -= damage;
        
        // Broadcast enemy health update so all clients see the damage + damage numbers
        this.io.to(this.room.id).emit('enemyHealthUpdate', {
            id: enemy.id,
            health: enemy.health,
            healthMax: enemy.healthMax,
            damage: damage,
            x: enemy.x,
            y: enemy.y,
            source: 'troop_melee'
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
            this.io.to(this.room.id).emit('entity_dead', {
                entityType: 'enemy',
                id: enemy.id,
                x: enemy.x,
                y: enemy.y,
                kind: enemy.type
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
            
            // Broadcast enemy health update so all clients see the damage + damage numbers
            this.io.to(this.room.id).emit('enemyHealthUpdate', {
                id: enemy.id,
                health: enemy.health,
                healthMax: enemy.healthMax,
                damage: damage,
                x: enemy.x,
                y: enemy.y,
                source: 'troop_ranged'
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
                this.io.to(this.room.id).emit('entity_dead', {
                    entityType: 'enemy',
                    id: enemy.id,
                    x: enemy.x,
                    y: enemy.y,
                    kind: enemy.type
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
        const nowMs = Date.now();
        
        // Schedule authoritative explosion damage (client renders VFX only in multiplayer)
        this._scheduleTroopGrenadeExplosion({
            troopId: troop.id,
            x: enemy.x,
            y: enemy.y,
            radius: 50,
            explodeAtMs: nowMs + 3600
        });
        
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
    
    _scheduleTroopGrenadeExplosion(g) {
        try {
            if (!g) return;
            if (!Number.isFinite(g.x) || !Number.isFinite(g.y)) return;
            if (!Number.isFinite(g.radius) || g.radius <= 0) return;
            if (!Number.isFinite(g.explodeAtMs)) return;
            this._pendingTroopGrenades.push({
                troopId: g.troopId || null,
                x: g.x,
                y: g.y,
                radius: g.radius,
                explodeAtMs: g.explodeAtMs
            });
        } catch (_) {}
    }
    
    _updatePendingTroopGrenades(nowMs) {
        if (!Array.isArray(this._pendingTroopGrenades) || this._pendingTroopGrenades.length === 0) return;
        for (let i = this._pendingTroopGrenades.length - 1; i >= 0; i--) {
            const g = this._pendingTroopGrenades[i];
            if (!g) {
                this._pendingTroopGrenades.splice(i, 1);
                continue;
            }
            if (Number.isFinite(g.explodeAtMs) && nowMs < g.explodeAtMs) continue;
            this._pendingTroopGrenades.splice(i, 1);
            this._explodeTroopGrenade(g);
        }
    }
    
    _explodeTroopGrenade(g) {
        try {
        if (!this.room || !this.room.enemies) return;
            const ex = Number(g.x) || 0;
            const ey = Number(g.y) || 0;
            const radius = Number(g.radius) || 50;
            const inner = 20;
            const outer = Math.max(inner + 1e-6, radius);
            
            for (const [id, enemy] of this.room.enemies) {
                if (!enemy || !enemy.alive) continue;
                if (enemy.type === 'defenseTurret' || enemy.type === 'artilleryGun') continue; // Don't damage friendly units
                
                const dx = enemy.x - ex;
                const dy = enemy.y - ey;
                const dist = Math.hypot(dx, dy);
                const er = enemy.radius || 26;
            if (dist > radius + er) continue;

                let t = (dist - inner) / (outer - inner);
            t = Math.max(0, Math.min(1, t));

                // Match client troop grenade damage curve (fixed, no crit/loot scaling)
                const damage = 15 - 10 * t; // 15 at inner, 5 at edge
                const dmgInt = Math.max(1, Math.round(damage));

                enemy.health -= dmgInt;
                
                // Broadcast enemy health update so all clients see the damage + popup color
            this.io.to(this.room.id).emit('enemyHealthUpdate', {
                id: enemy.id,
                health: enemy.health,
                healthMax: enemy.healthMax,
                    damage: dmgInt,
                    x: ex,
                    y: ey,
                source: 'troop_grenade'
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
                this.io.to(this.room.id).emit('entity_dead', {
                    entityType: 'enemy',
                    id: enemy.id,
                    x: enemy.x,
                    y: enemy.y,
                    kind: enemy.type
                });
            }
            }
        } catch (e) {
            try { console.error('[TroopManager] Troop grenade explode failed:', e); } catch(_) {}
        }
    }

    _checkTroopFirePoolCollision(troop, dt) {
        if (!troop || !troop.alive) return;
        const firePools = this.room.hazards.firePools || [];
        
        // Initialize DOT stacks if needed
        if (!troop.dotStacks) troop.dotStacks = [];
        
        let inFirePool = false;
        
        let hitFire = null;

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
                hitFire = f;
                
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

            // Drop a light-blue "fireDeath" zone to prevent lemming behavior into fire.
            // The zone stores a left/right detour direction (perp to entry direction) so the NEXT troops sidestep around it.
            try {
                if (this._stuckZones) {
                    // Entry direction: prefer last actual movement dir; fallback to radial from fire center.
                    let uxIn = Number.isFinite(troop._lastMoveUx) ? troop._lastMoveUx : null;
                    let uyIn = Number.isFinite(troop._lastMoveUy) ? troop._lastMoveUy : null;

                    if ((uxIn == null || uyIn == null) && hitFire) {
                        const rx = troop.x - hitFire.x;
                        const ry = troop.y - hitFire.y;
                        const rd = Math.hypot(rx, ry) || 1;
                        // If we're inside the pool, "into the pool" is opposite of outward.
                        uxIn = -(rx / rd);
                        uyIn = -(ry / rd);
                    }

                    if (uxIn == null || uyIn == null) { uxIn = 1; uyIn = 0; }

                    const side = (Math.random() < 0.5) ? -1 : 1;
                    const px = -uyIn * side;
                    const py = uxIn * side;

                    // Place the marker slightly before the death point (where they entered from).
                    const back = 40;
                    const zx = troop.x - uxIn * back;
                    const zy = troop.y - uyIn * back;

                    this._stuckZones.push({
                        kind: 'fireDeath',
                        x: zx,
                        y: zy,
                        r: 95,
                        ttl: 8.0,
                        dirX: px,
                        dirY: py
                    });
                    if (this._stuckZones.length > this._stuckZoneMax) this._stuckZones.shift();
                }
            } catch (_) {}

            this.io.to(this.room.id).emit('troopDeath', {
                troopId: troop.id,
                x: troop.x,
                y: troop.y,
                cause: 'fire'
            });
            this.io.to(this.room.id).emit('entity_dead', {
                entityType: 'troop',
                id: troop.id,
                x: troop.x,
                y: troop.y,
                kind: troop.type || 'troop',
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

            // Debug: expose current zone-escape walk target so the client can draw an arrow.
            // (This is what red zones are effectively "directing" units to walk toward.)
            if (t._avoid && t._avoid.active && t._avoid.phase === 'zoneEscape') {
                if (Number.isFinite(t._avoid.escapeTx) && Number.isFinite(t._avoid.escapeTy)) {
                    data.avoidPhase = 'zoneEscape';
                    data.escapeTx = t._avoid.escapeTx;
                    data.escapeTy = t._avoid.escapeTy;
                }
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
            })),
            // Debug-only-ish payload: small list (capped) of current stuck-avoid zones for client overlay.
            stuckZones: (this._stuckZones && this._stuckZones.length)
                ? this._stuckZones.map(z => ({
                    kind: z.kind || 'stuck',
                    x: z.x, y: z.y, r: z.r, ttl: z.ttl,
                    dirX: (Number.isFinite(z.dirX) ? z.dirX : 0),
                    dirY: (Number.isFinite(z.dirY) ? z.dirY : 0),
                    tx: (Number.isFinite(z.tx) ? z.tx : null),
                    ty: (Number.isFinite(z.ty) ? z.ty : null)
                }))
                : []
        });
    }
}

module.exports = { TroopManager };


