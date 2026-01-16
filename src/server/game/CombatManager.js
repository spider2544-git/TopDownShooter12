/**
 * CombatManager - Manages player combat, damage, and death for GameRoom
 * 
 * Extracted from GameRoom (Phase 6 of incremental manager extraction)
 * 
 * Handles:
 * - Player bullet collision and PvP damage
 * - DOT (Damage Over Time) and burn effects
 * - Boomer puke pool hazards and slow effects
 * - Player death handling
 * - Enemy death cleanup (licker ensnare)
 * 
 * Architecture: Update-loop pattern (industry standard for multiplayer games)
 * - Combat damage calculated during collision detection
 * - Server-authoritative (prevents cheating)
 * - Each system has dedicated update method
 */

class CombatManager {
    /**
     * @param {GameRoom} room - Reference to the parent GameRoom for state access
     * @param {SocketIO} io - Socket.io instance for broadcasting
     * @param {Function} getWeaponProgression - Weapon progression config lookup
     */
    constructor(room, io, getWeaponProgression) {
        this.room = room;
        this.io = io;
        this.getWeaponProgression = getWeaponProgression;
    }

    // =========================================
    // PLAYER DEATH HANDLING
    // =========================================

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
                io.to(this.room.id).emit('vfxEvent', {
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

    // =========================================
    // DOT (DAMAGE OVER TIME) SYSTEM
    // =========================================

    updatePlayerDots(deltaTime) {
        // Tick DOT stacks on all players and apply damage
        for (const [pid, player] of this.room.players) {
            if (!player || player.health <= 0) continue;
            if (!Array.isArray(player.dotStacks)) player.dotStacks = [];
            
            // Invisibility blood drain (weapon 5 secondary ability)
            if (player.invisible === true && player.invisibilityActiveTime) {
                // Get drain rate from weapon progression config based on player's loot level
                const lootLevel = player.lootLevel || 0;
                const progression = this.getWeaponProgression(4, lootLevel); // Weapon 5 is index 4
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
                        this.io.to(this.room.id).emit('invisibilityState', {
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
                this.io.to(this.room.id).emit('vfxEvent', {
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
                        this.io.to(this.room.id).emit('playerHealthUpdate', { playerId: pid, health: player.health, from: 'dot' });
                    } catch(_) {}
                    
                    // Show DOT damage numbers periodically (every 0.15s) to avoid spam
                    player._dotTextTimer -= deltaTime;
                    if (player._dotTextTimer <= 0 && player._dotAccum > 0.5 && player.dotStacks.length > 0 && player.dotStacks[0].from) {
                        this.io.to(this.room.id).emit('pvpHit', {
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
                    this._handlePlayerDeath(pid, player, this.io);
                }
            }
        }
    }

    // =========================================
    // PLAYER BULLET COLLISION & PVP DAMAGE
    // =========================================

    updatePlayerBullets(deltaTime) {
        // Update bullet positions and check for PvP collisions
        for (let i = this.room.playerBullets.length - 1; i >= 0; i--) {
            const bullet = this.room.playerBullets[i];
            
            // Store previous position for swept collision detection
            const oldX = bullet.x;
            const oldY = bullet.y;
            
            // Update bullet position
            bullet.x += bullet.vx * deltaTime;
            bullet.y += bullet.vy * deltaTime;
            bullet.life -= deltaTime;
            
            // Remove expired bullets
            if (bullet.life <= 0) {
                this.room.playerBullets.splice(i, 1);
                continue;
            }
            
            // Check collision with sandbags first (blocks bullets)
            if (this.room.hazards && typeof this.room.hazards.damageFromBulletLine === 'function') {
                // Weapon 4 cones: only spawn VFX 1/5 hits to reduce visual spam
                const vfxProb = (bullet.isCone && bullet.sourceWeaponIndex === 3) ? 0.2 : 1.0;
                const sbHit = this.room.hazards.damageFromBulletLine(oldX, oldY, bullet.x, bullet.y, bullet.damage || 10, vfxProb);
                if (sbHit) {
                    this.room.playerBullets.splice(i, 1);
                    continue;
                }
            }
            
            // Check collision with exploding barrels
            if (this.room.hazards && typeof this.room.hazards.damageBarrelFromBulletLine === 'function') {
                const barrelHit = this.room.hazards.damageBarrelFromBulletLine(oldX, oldY, bullet.x, bullet.y, bullet.damage || 10);
                if (barrelHit) {
                    this.room.playerBullets.splice(i, 1);
                    continue;
                }
            }

            // Check collision with all players (PvP friendly fire)
            let hit = false;
            for (const [targetId, target] of this.room.players) {
                // Skip dead players
                if (!target || target.health <= 0) continue;
                
                // Skip invincible players
                if (target.invincible === true) continue;
                
                // Skip the shooter (no self-damage)
                if (targetId === bullet.ownerId) continue;
                
                // Check if friendly fire is allowed (evil vs non-evil)
                const shooter = this.room.players.get(bullet.ownerId);
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
                    this.io.to(this.room.id).emit('playerHealthUpdate', { 
                        playerId: targetId, 
                        health: target.health,
                        from: 'pvp',
                        attackerId: bullet.ownerId
                    });
                    
                    // Broadcast PvP hit event for visual feedback
                    this.io.to(this.room.id).emit('pvpHit', {
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
                        this._handlePlayerDeath(targetId, target, this.io);
                        this.io.to(this.room.id).emit('pvpKill', {
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
                this.room.playerBullets.splice(i, 1);
            }
        }
    }

    // =========================================
    // BOOMER PUKE POOL HAZARDS
    // =========================================

    updateBoomerPools(deltaTime) {
        try {
            if (!Array.isArray(this.room.boomerPools) || this.room.boomerPools.length === 0) {
                // Even if no pools, ensure slowed state decays to zero and clears when dead
                for (const [, p] of this.room.players) {
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
                        this.io.to(this.room.id).emit('playerSlowState', { playerId: p.id, slowed: now });
                    }
                }
                return;
            }
            // Decay pools
            for (let i = this.room.boomerPools.length - 1; i >= 0; i--) {
                const pool = this.room.boomerPools[i];
                pool.ttl -= deltaTime;
                if (pool.ttl <= 0) this.room.boomerPools.splice(i, 1);
            }
            // Apply slow when inside any pool; persist for 4s after leaving
            for (const [, p] of this.room.players) {
                if (!p) continue;
                // Death clears immediately
                if (p.health != null && p.health <= 0) {
                    if (p._svSlowTimer && p._svSlowTimer > 0) p._svSlowTimer = 0;
                } else {
                    let inAny = false;
                    const pr = p.radius || 20;
                    for (let i = 0; i < this.room.boomerPools.length; i++) {
                        const pool = this.room.boomerPools[i];
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
                    this.io.to(this.room.id).emit('playerSlowState', { playerId: p.id, slowed: now });
                }
            }
        } catch (e) {
            console.error('[Server] updateBoomerPools error:', e && e.stack ? e.stack : String(e));
        }
    }

    // =========================================
    // ENEMY DEATH CLEANUP
    // =========================================

    _clearLickerEnsnareOnDeath(enemyId, enemyType) {
        if (enemyType !== 'licker') return;
        
        // Clear ensnare state for all players
        for (const [, p] of this.room.players) {
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
}

module.exports = CombatManager;
