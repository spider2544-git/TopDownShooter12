/**
 * AbilityManager - Manages player-deployed abilities for GameRoom
 * 
 * Extracted from GameRoom (Phase 8 of incremental manager extraction)
 * 
 * Handles:
 * - Shield walls (collision + expiration)
 * - Proximity mines (explosion on expiration)
 * - Healing boxes (healing + health depletion)
 * - Auto turrets (AI targeting, firing, line-of-sight checks)
 * - Enemy attractors (health drain over time)
 * - Molotov pools (barrel damage over time)
 */

class AbilityManager {
    /**
     * @param {GameRoom} room - Reference to the parent GameRoom for state access
     * @param {SocketIO} io - Socket.io instance for broadcasting
     */
    constructor(room, io) {
        this.room = room;
        this.io = io;
    }

    // =========================================
    // ABILITY UPDATE SYSTEM
    // =========================================

    updateAbilities(now, deltaTime) {
        if (this.room.abilities.size === 0) return;
        
        // Check for expired abilities
        const expired = [];
        for (const [abilityId, ability] of this.room.abilities) {
            if (ability.expiresAt !== null && now >= ability.expiresAt) {
                expired.push(abilityId);
            }
        }
        
        // Remove expired abilities from environment and tracking
        for (const abilityId of expired) {
            const ability = this.room.abilities.get(abilityId);
            if (!ability) continue;
            
            // Handle different ability types
            if (ability.type === 'ShieldWall') {
                // Remove oriented box from environment
                if (this.room.environment && this.room.environment.orientedBoxes) {
                    const boxIdx = this.room.environment.orientedBoxes.findIndex(box => box._abilityId === abilityId);
                    if (boxIdx >= 0) {
                        this.room.environment.orientedBoxes.splice(boxIdx, 1);
                        console.log('[Server] Removed expired ShieldWall OBB collision at index:', boxIdx);
                        
                        // Broadcast ability expiration to all clients
                        this.io.to(this.room.id).emit('abilityExpired', { serverId: abilityId });
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
                    if (this.room.hazards && typeof this.room.hazards.damageCircle === 'function') {
                        this.room.hazards.damageCircle(ex, ey, r, dmg);
                    }
                    // Damage barrels
                    if (this.room.hazards && typeof this.room.hazards.damageBarrelInRadius === 'function') {
                        this.room.hazards.damageBarrelInRadius(ex, ey, r, dmg);
                    }
                } catch(_) {}
                // Broadcast mine expiration (clients will show explosion animation)
                this.io.to(this.room.id).emit('abilityExpired', { serverId: abilityId, explode: true });
            } else if (ability.type === 'HealingBox') {
                // HealingBox expired - show death particles on client side
                console.log('[Server] HealingBox', abilityId, 'lifetime expired (90 seconds)');
                
                // Broadcast ability expiration to all clients
                this.io.to(this.room.id).emit('abilityExpired', { serverId: abilityId });
            } else if (ability.type === 'AutoTurret') {
                // AutoTurret expired - trigger explosion on client side
                console.log('[Server] AutoTurret', abilityId, 'lifetime expired (90 seconds)');
                
                // Broadcast ability triggered death event (clients will show explosion)
                this.io.to(this.room.id).emit('abilityTriggered', {
                    serverId: abilityId,
                    type: 'AutoTurret',
                    event: 'death'
                });
            } else {
                // Legacy: Remove obstacle from environment (for future abilities)
                if (typeof ability.obstacleIndex === 'number' && ability.obstacleIndex >= 0) {
                    const obstacleIdx = this.room.environment.obstacles.findIndex(obs => obs.wallId === abilityId);
                    if (obstacleIdx >= 0) {
                        this.room.environment.obstacles.splice(obstacleIdx, 1);
                        console.log('[Server] Removed expired', ability.type, 'from environment at index:', obstacleIdx);
                        
                        // Broadcast ability expiration to all clients
                        this.io.to(this.room.id).emit('abilityExpired', { serverId: abilityId });
                    }
                }
            }
            
            // Remove from tracking
            this.room.abilities.delete(abilityId);
        }
        
        // Update healing boxes - check for players in range and heal them
        for (const [abilityId, ability] of this.room.abilities) {
            if (ability.type !== 'HealingBox') continue;
            
            // Check if enough time has passed since last heal tick
            const timeSinceLastHeal = now - ability.lastHealTick;
            if (timeSinceLastHeal < ability.healInterval * 1000) continue;
            
            // Update last heal tick time
            ability.lastHealTick = now;
            
            let healedAnyPlayer = false;
            
            // Check all players in room
            for (const [playerId, player] of this.room.players) {
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
                    this.io.to(this.room.id).emit('playerHealed', {
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
                this.io.to(this.room.id).emit('abilityHealthUpdate', {
                    serverId: abilityId,
                    health: ability.health,
                    healthMax: ability.healthMax
                });
                
                // Destroy box if health depleted
                if (ability.health <= 0) {
                    ability.health = 0;
                    this.room.abilities.delete(abilityId);
                    
                    // Broadcast box death
                    this.io.to(this.room.id).emit('abilityTriggered', {
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
        for (const [abilityId, ability] of this.room.abilities) {
            if (ability.type !== 'AutoTurret') continue;
            if (ability.health <= 0) continue;
            
            // Update fire cooldown
            if (ability.fireCooldown > 0) {
                ability.fireCooldown -= deltaTime;
            }
            
            // Find closest enemy within range
            let closestEnemy = null;
            let closestDist = Infinity;
            
            for (const enemy of this.room.enemies.values()) {
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
                if (this.room.environment && typeof this.room.environment.lineHitsAny === 'function') {
                    blockedByWall = this.room.environment.lineHitsAny(ability.x, ability.y, closestEnemy.x, closestEnemy.y);
                }
                
                if (!blockedByWall) {
                    // Check if WallGuy shield blocks line of sight
                    let blockedByShield = false;
                    for (const [, enemy] of this.room.enemies) {
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
                            this.room._clearLickerEnsnareOnDeath(closestEnemy.id, closestEnemy.type);
                            
                            // Remove from authoritative enemy list and broadcast death
                            const enemyId = closestEnemy.id;
                            if (this.room.enemies.has(enemyId)) {
                                this.room.enemies.delete(enemyId);
                                // Emit enemy_dead (with underscore) for blood pools and VFX
                                this.io.to(this.room.id).emit('enemy_dead', { 
                                    id: enemyId, 
                                    x: closestEnemy.x, 
                                    y: closestEnemy.y, 
                                    type: closestEnemy.type 
                                });
                                // Unified entity death event (preferred by clients)
                                this.io.to(this.room.id).emit('entity_dead', {
                                    entityType: 'enemy',
                                    id: enemyId,
                                    x: closestEnemy.x,
                                    y: closestEnemy.y,
                                    kind: closestEnemy.type
                                });
                                
                                // If turret killed a lobby training dummy, respawn it server-side after 2s
                                if (closestEnemy && closestEnemy.type === 'targetDummy' && typeof enemyId === 'string' && enemyId.startsWith('target_dummy_')) {
                                    try {
                                        if (!this.room._targetDummyRespawnTimers) this.room._targetDummyRespawnTimers = new Map();
                                        const timers = this.room._targetDummyRespawnTimers;
                                        const prev = timers.get(enemyId);
                                        if (prev) clearTimeout(prev);
                                        const t = setTimeout(() => {
                                            try {
                                                if (this.room.scene !== 'lobby') return;
                                                if (this.room.enemies && this.room.enemies.has(enemyId)) return;
                                                const idx = Math.max(1, parseInt(enemyId.split('_').pop(), 10) || 1);
                                                const count = 5;
                                                // Recreate missing dummy by ensuring full set exists
                                                this.room.spawnLobbyTargetDummy(count);
                                            } catch(_) {}
                                        }, 2000);
                                        timers.set(enemyId, t);
                                    } catch(_) {}
                                }
                            }
                        }
                    }
                    
                    // Broadcast turret hitscan fire event (clients will show visuals and sync damage)
                    this.io.to(this.room.id).emit('turretFire', {
                        serverId: abilityId,
                        angle: ability.angle,
                        targetX: closestEnemy.x,
                        targetY: closestEnemy.y,
                        targetId: closestEnemy.id,
                        damage: turretDamage,
                        hitscan: true
                    });
                    // Damage sandbags and barrels along hitscan line (ability Ã¢â€ â€™ target)
                    try {
                        if (this.room.hazards && closestEnemy) {
                            this.room.hazards.damageFromBulletLine(ability.x, ability.y, closestEnemy.x, closestEnemy.y, turretDamage);
                            if (typeof this.room.hazards.damageBarrelFromBulletLine === 'function') {
                                this.room.hazards.damageBarrelFromBulletLine(ability.x, ability.y, closestEnemy.x, closestEnemy.y, turretDamage);
                            }
                        }
                    } catch(_) {}
                    
                    // Broadcast health update
                    this.io.to(this.room.id).emit('abilityHealthUpdate', {
                        serverId: abilityId,
                        health: ability.health,
                        healthMax: ability.healthMax
                    });
                    
                    // Destroy turret if ammo depleted
                    if (ability.health <= 0) {
                        ability.health = 0;
                        this.room.abilities.delete(abilityId);
                        
                        // Broadcast turret death
                        this.io.to(this.room.id).emit('abilityTriggered', {
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
        for (const [abilityId, ability] of this.room.abilities) {
            if (ability.type !== 'EnemyAttractor') continue;
            if (ability.health <= 0) continue;
            
            // Drain health over time (60 HP/second)
            ability.health -= ability.healthDrainRate * deltaTime;
            
            // Broadcast health update periodically (every ~0.5 seconds)
            if (!ability._lastHealthBroadcast || (now - ability._lastHealthBroadcast) >= 500) {
                ability._lastHealthBroadcast = now;
                this.io.to(this.room.id).emit('abilityHealthUpdate', {
                    serverId: abilityId,
                    health: Math.max(0, ability.health),
                    healthMax: ability.healthMax
                });
            }
            
            // Destroy attractor if health depleted
            if (ability.health <= 0) {
                ability.health = 0;
                this.room.abilities.delete(abilityId);
                
                // Broadcast attractor death
                this.io.to(this.room.id).emit('abilityTriggered', {
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
        for (const [abilityId, ability] of this.room.abilities) {
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
                if (this.room.hazards && typeof this.room.hazards.damageBarrelInRadius === 'function') {
                    this.room.hazards.damageBarrelInRadius(ability.x, ability.y, poolRadius, damagePerTick);
                }
            }
        }
    }
}

module.exports = AbilityManager;
