/**
 * Combat Handlers - Phase 2
 * 
 * Handles all combat-related socket events:
 * - Weapon firing (bulletFired, weapon7/8Hitscan)
 * - Damage events (explosionDamage, projectileHit, dotTick)
 * - Entity death (enemyDied)
 * - Object damage (chestDamage, barrelDamage, artifactDamage)
 */

const { createRoomContext } = require('../../core/RoomContext.js');

module.exports = function createCombatHandlers({ io, rooms, Protocol, serverDebugger }) {
    return {
        /**
         * Handler for bullet fired events (weapons 1-6, 9)
         */
        bulletFired: (socket, data) => {
            // Find which room this player is in and broadcast bullet to all other players
            for (const [roomId, room] of rooms) {
                if (room.players.has(socket.id)) {
                    const shooter = room.players.get(socket.id);
                    if (!shooter) break;
                    
                    // Extract bullet data (may be nested in bulletData)
                    const bulletInfo = data.bulletData || data;
                    const options = bulletInfo.options || {};
                    
                    // Weapon 1: server-authoritative stamina cost per swing (per bulletFired event)
                    if (bulletInfo.sourceWeaponIndex === 0) {
                        const staminaCostWeapon1 = 2;
                        // Reject the swing if the shooter has insufficient stamina (prevents client cheating)
                        if ((shooter.stamina || 0) < staminaCostWeapon1) break;
                        shooter.stamina = Math.max(0, (shooter.stamina || 0) - staminaCostWeapon1);
                    }
                    
                    // Track weapon 4 firing for stamina drain
                    if (bulletInfo.sourceWeaponIndex === 3) {
                        shooter.isFiringWeapon4 = true;
                        shooter._weapon4LastFired = Date.now();
                    }
                    
                    // Get damage (from options or bulletInfo)
                    let damage = Number(options.damage) || Number(bulletInfo.damage) || 20;
                    
                    // Store bullet for server-side PvP collision detection
                    const bullet = {
                        id: `${socket.id}_${Date.now()}_${Math.random()}`,
                        x: Number(bulletInfo.x) || 0,
                        y: Number(bulletInfo.y) || 0,
                        vx: Number(bulletInfo.vx) || 0,
                        vy: Number(bulletInfo.vy) || 0,
                        damage: damage,
                        radius: Number(bulletInfo.radius) || 4,
                        life: Number(bulletInfo.life) || 2.0,
                        ownerId: socket.id,
                        ownerIsEvil: shooter.isEvil || false,
                        isCone: !!options.isCone || !!bulletInfo.isCone,
                        noDamage: !!bulletInfo.noDamage,
                        ignoreEnemies: !!options.ignoreEnemies, // Weapon 2 bullets don't damage on contact
                        sourceWeaponIndex: bulletInfo.sourceWeaponIndex,
                        // Apply shooter's stats for damage calculation
                        attackPower: shooter.attackPower || 0,
                        critChance: shooter.critChance || 0,
                        critDamageMultiplier: shooter.critDamageMultiplier || 1.2
                    };
                    
                    // Track bullets for collision (excludes cones except weapon4, and weapon 2 which ignores enemies)
                    // Include weapon 7 (noDamage) for sandbag collision even though it doesn't do player damage
                    // Include weapon 4 cones for sandbag collision
                    if ((!bullet.isCone || bullet.sourceWeaponIndex === 3) && !bullet.ignoreEnemies) {
                        room.playerBullets.push(bullet);
                    }
                    
                    // Weapon 6 recoil: server-authoritative position impulse (like enemy knockback)
                    if (bulletInfo.sourceWeaponIndex === 5 && !bulletInfo.noDamage) {
                        const recoilDistance = 35; // Distance to push player back
                        
                        // Calculate recoil direction (opposite of bullet velocity)
                        const bulletSpeed = Math.hypot(bullet.vx, bullet.vy);
                        if (bulletSpeed > 0.01) {
                            const recoilDirX = -bullet.vx / bulletSpeed;
                            const recoilDirY = -bullet.vy / bulletSpeed;
                            
                            // Calculate recoil position offset
                            const recoilX = recoilDirX * recoilDistance;
                            const recoilY = recoilDirY * recoilDistance;
                            
                            // Apply recoil with collision detection (like player movement)
                            // Use substeps for large movements to prevent phasing through rotated walls
                            if (room.environment && room.environment.resolveCircleMove) {
                                const playerRadius = shooter.radius || 26;
                                
                                // Break large recoil into smaller steps for better collision with rotated walls
                                const maxStepSize = 10; // Max step size per iteration
                                const steps = Math.max(1, Math.ceil(recoilDistance / maxStepSize));
                                const stepX = recoilX / steps;
                                const stepY = recoilY / steps;
                                
                                let currentX = shooter.x;
                                let currentY = shooter.y;
                                
                                for (let i = 0; i < steps; i++) {
                                    const resolved = room.environment.resolveCircleMove(
                                        currentX, 
                                        currentY, 
                                        playerRadius, 
                                        stepX, 
                                        stepY
                                    );
                                    currentX = resolved.x;
                                    currentY = resolved.y;
                                }
                                
                                shooter.x = currentX;
                                shooter.y = currentY;
                                
                                console.log('[Server] Weapon 6 recoil applied to', socket.id.substring(0, 8), 
                                           'in', steps, 'steps from', shooter.x.toFixed(1), shooter.y.toFixed(1), 
                                           'to', currentX.toFixed(1), currentY.toFixed(1));
                            } else {
                                // Fallback: direct recoil without collision
                                shooter.x += recoilX;
                                shooter.y += recoilY;
                            }
                            
                            // Position will automatically sync through next broadcastGameState()
                        }
                    }
                    
                    // Broadcast to all players in room except the sender
                    socket.to(roomId).emit('bulletFired', {
                        ...data,
                        playerId: socket.id
                    });
                    break;
                }
            }
        },
        
        /**
         * Handler for weapon 7 hitscan
         */
        weapon7Hitscan: (socket, data) => {
            for (const [roomId, room] of rooms) {
                if (!room.players.has(socket.id)) continue;
                
                const shooter = room.players.get(socket.id);
                if (!shooter) break;
                
                // Validate hitscan data
                if (!data || !data.targetId || !data.targetType) break;
                
                // Weapon 7 base damage scales with PRIMARY loot tiers:
                // loot 0-1 => 10
                // loot 2-3 => 10-15
                // loot 4-6 => 15-20
                const lootLevel = Math.max(0, Math.min(6, shooter.lootLevel || 0));
                const baseDamage = (lootLevel >= 4)
                    ? (15 + Math.random() * 5)
                    : (lootLevel >= 2)
                        ? (10 + Math.random() * 5)
                        : 10;
                // Weapon 7 gets 1/3 of Attack Power as a flat bonus (rounded up)
                const ap = Math.max(0, shooter.attackPower || 0);
                const apBonus = Math.ceil(ap / 3);
                let rawDmg = baseDamage + apBonus;
                
                // Roll for crit
                let isCrit = false;
                // Weapon 7 has an additional weapon-specific base crit chance of 5%,
                // on top of the player's crit chance (which already includes the 5% baseline).
                const weapon7BaseCrit = 0.05;
                const critChance = Math.max(0, Math.min(1, weapon7BaseCrit + (shooter.critChance || 0)));
                if (Math.random() < critChance) {
                    isCrit = true;
                    rawDmg *= (shooter.critDamageMultiplier || 1.2);
                }
                
                // Find target based on type
                if (data.targetType === 'player') {
                    // PvP hitscan
                    const target = room.players.get(data.targetId);
                    if (target && target.health > 0 && !target.invincible) {
                        const shooterIsEvil = shooter.isEvil || false;
                        const targetIsEvil = target.isEvil || false;
                        
                        // Only allow damage if opposite alignments
                        if (shooterIsEvil !== targetIsEvil) {
                            // Apply armor reduction
                            const armorPercent = Number.isFinite(target.armor) ? target.armor : 0;
                            const reduction = Math.min(0.75, armorPercent / 100);
                            const dmg = rawDmg * (1 - reduction);
                            
                            target.health = Math.max(0, target.health - dmg);
                            
                            console.log(`[PvP] Player ${socket.id} hitscan hit player ${data.targetId} for ${dmg.toFixed(1)} damage${isCrit ? ' [CRIT]' : ''} [WEAPON7:HITSCAN]`);
                            
                            // Broadcast health update
                            try { 
                                target.socket.emit('playerHealth', { health: target.health, from: 'pvp_hitscan' });
                            } catch(_) {}
                            io.to(roomId).emit('playerHealthUpdate', { 
                                playerId: data.targetId, 
                                health: target.health,
                                from: 'pvp_hitscan',
                                crit: isCrit
                            });
                            
                            // Broadcast damage number
                            io.to(roomId).emit('damageNumber', {
                                targetId: data.targetId,
                                attackerId: socket.id,
                                damage: Math.round(dmg),
                                crit: isCrit,
                                x: target.x,
                                y: target.y
                            });
                            
                            // Check for death
                            if (target.health <= 0) {
                                console.log(`[PvP] Player ${data.targetId} killed by ${socket.id} (weapon 7 hitscan)`);
                            }
                        }
                    }
                } else if (data.targetType === 'enemy' || data.targetType === 'npc') {
                    // Enemy/NPC hitscan - broadcast to clients to apply damage locally
                    // (Server doesn't track enemy health in current architecture)
                    const DEBUG_HITSCAN_LOGS = false; // Local debug flag
                    if (DEBUG_HITSCAN_LOGS) {
                        console.log(`[Weapon7] Server broadcasting hitscan: ${data.targetType} ID:${data.targetId} damage:${rawDmg.toFixed(1)}${isCrit ? ' [CRIT]' : ''} to room:${roomId}`);
                    }
                    
                    // Also damage sandbags along the hitscan path
                    try {
                        if (room.hazards && typeof room.hazards.damageFromBulletLine === 'function') {
                            const ang = Number.isFinite(shooter.aimAngle) ? shooter.aimAngle : 0;
                            const startX = shooter.x || 0;
                            const startY = shooter.y || 0;
                            const endX = startX + Math.cos(ang) * 1600;
                            const endY = startY + Math.sin(ang) * 1600;
                            const dmg = rawDmg; // apply same base damage to sandbags
                            room.hazards.damageFromBulletLine(startX, startY, endX, endY, dmg);
                            // Also damage barrels
                            if (typeof room.hazards.damageBarrelFromBulletLine === 'function') {
                                room.hazards.damageBarrelFromBulletLine(startX, startY, endX, endY, dmg);
                            }
                        }
                    } catch(_) {}

                    io.to(roomId).emit('weapon7HitscanHit', {
                        shooterId: socket.id,
                        targetId: data.targetId,
                        targetType: data.targetType,
                        damage: rawDmg,
                        crit: isCrit,
                        bulletId: data.bulletId, // Pass bullet ID for tracer termination
                        sourceX: data.sourceX, // Pass source position for correct VFX direction
                        sourceY: data.sourceY
                    });
                }
                
                break;
            }
        },
        
        /**
         * Handler for weapon 8 hitscan
         */
        weapon8Hitscan: (socket, data) => {
            // Import needed for weapon progression
            const { getWeaponProgression } = require('../../../weaponProgressionConfig.js');
            
            for (const [roomId, room] of rooms) {
                if (!room.players.has(socket.id)) continue;

                const shooter = room.players.get(socket.id);
                if (!shooter) break;

                // Validate hitscan data (targetId/targetType can be null for misses)
                if (!data) break;

                // Check blood marker cost for ADS (weapon 8 index 7)
                const lootLevel = shooter.lootLevel || 0;
                const progression = getWeaponProgression(7, lootLevel);
                const bloodCost = progression?.primary?.adsBloodCost || 3;

                console.log(`[Weapon8] ADS hitscan received - Player: ${socket.id}, Markers: ${shooter.bloodMarkers || 0}, Cost: ${bloodCost}, Loot: ${lootLevel}`);

                // Validate blood markers
                if ((shooter.bloodMarkers || 0) < bloodCost) {
                    console.log(`[Weapon8] ADS REJECTED - insufficient blood markers: ${shooter.bloodMarkers || 0}/${bloodCost}`);
                    break; // Don't process shot
                }

                // Consume blood markers
                const oldMarkers = shooter.bloodMarkers || 0;
                shooter.bloodMarkers = Math.max(0, oldMarkers - bloodCost);
                console.log(`[Weapon8] ADS consumed markers - Before: ${oldMarkers}, After: ${shooter.bloodMarkers}, Cost: ${bloodCost}`);

                // Notify player of updated blood markers
                io.to(socket.id).emit('currencyUpdated', {
                    playerId: socket.id,
                    bloodMarkers: shooter.bloodMarkers
                });

                // Calculate base damage (from loot progression: 75/100/125 damage)
                const baseDamage = progression?.primary?.adsDamage || 75;
                let rawDmg = baseDamage + (shooter.attackPower || 0);

                // Roll for crit (ADS has weapon-specific base crit chance + player bonuses)
                let isCrit = false;
                const adsCritBase = progression?.primary?.adsCritChance || 0.15;
                const playerCritBonus = shooter.critChance || 0;
                const critChance = Math.max(0, Math.min(1, adsCritBase + playerCritBonus));
                if (Math.random() < critChance) {
                    isCrit = true;
                    rawDmg *= (shooter.critDamageMultiplier || 1.2);
                }

                // Find target based on type (only if there was a hit)
                if (data.didHit && data.targetId && data.targetType === 'player') {
                    // PvP hitscan
                    const target = room.players.get(data.targetId);
                    if (target && target.health > 0 && !target.invincible) {
                        const shooterIsEvil = shooter.isEvil || false;
                        const targetIsEvil = target.isEvil || false;

                        // Only allow damage if opposite alignments
                        if (shooterIsEvil !== targetIsEvil) {
                            // Apply armor reduction
                            const armorPercent = Number.isFinite(target.armor) ? target.armor : 0;
                            const reduction = Math.min(0.75, armorPercent / 100);
                            const dmg = rawDmg * (1 - reduction);

                            target.health = Math.max(0, target.health - dmg);

                            console.log(`[PvP] Player ${socket.id} hitscan hit player ${data.targetId} for ${dmg.toFixed(1)} damage${isCrit ? ' [CRIT]' : ''} [WEAPON8:HITSCAN]`);

                            // Broadcast health update
                            try {
                                target.socket.emit('playerHealth', { health: target.health, from: 'pvp_hitscan' });
                            } catch(_) {}
                            io.to(roomId).emit('playerHealthUpdate', {
                                playerId: data.targetId,
                                health: target.health,
                                from: 'pvp_hitscan',
                                crit: isCrit
                            });

                            // Broadcast damage number
                            io.to(roomId).emit('damageNumber', {
                                targetId: data.targetId,
                                attackerId: socket.id,
                                damage: Math.round(dmg),
                                crit: isCrit,
                                x: target.x,
                                y: target.y
                            });

                            // Check for death
                            if (target.health <= 0) {
                                console.log(`[PvP] Player ${data.targetId} killed by ${socket.id} (weapon 8 hitscan)`);
                            }
                        }
                    }
                } else if (data.didHit && data.targetId && (data.targetType === 'enemy' || data.targetType === 'npc')) {
                    // Enemy/NPC hitscan - broadcast to clients to apply damage locally

                    // Also damage sandbags along the hitscan path (approximate)
                    try {
                        if (room.hazards && typeof room.hazards.damageFromBulletLine === 'function') {
                            const ang = Number.isFinite(data.angle) ? data.angle : (shooter.aimAngle || 0);
                            const startX = shooter.x || 0;
                            const startY = shooter.y || 0;
                            const endX = startX + Math.cos(ang) * 2000;
                            const endY = startY + Math.sin(ang) * 2000;
                            const dmg = rawDmg;
                            room.hazards.damageFromBulletLine(startX, startY, endX, endY, dmg);
                            // Also damage barrels
                            if (typeof room.hazards.damageBarrelFromBulletLine === 'function') {
                                room.hazards.damageBarrelFromBulletLine(startX, startY, endX, endY, dmg);
                            }
                        }
                    } catch(_) {}

                    io.to(roomId).emit('weapon8HitscanHit', {
                        shooterId: socket.id,
                        targetId: data.targetId,
                        targetType: data.targetType,
                        damage: rawDmg,
                        crit: isCrit,
                        bulletId: data.bulletId,
                        sourceX: data.sourceX,
                        sourceY: data.sourceY
                    });
                }

                break;
            }
        },
        
        /**
         * Handler for explosion damage
         */
        explosionDamage: (socket, data) => {
            // data: { hits: [{ id, damage, crit }], x, y, radius }
            for (const [roomId, room] of rooms) {
                if (!room.players.has(socket.id)) continue;
                
                // Check explosion damage against all players for PvP
                const shooter = room.players.get(socket.id);
                if (shooter && data.x != null && data.y != null && data.radius != null) {
                    const shooterIsEvil = shooter.isEvil || false;
                    const explosionX = Number(data.x);
                    const explosionY = Number(data.y);
                    const explosionRadius = Number(data.radius) || 0;
                    // Also apply explosion to sandbags (server-authoritative)
                    try {
                        if (room.hazards && typeof room.hazards.damageCircle === 'function') {
                            const baseDmg = Math.max(30, (Number(data.attackPower) || 0) + 80);
                            room.hazards.damageCircle(explosionX, explosionY, explosionRadius, baseDmg);
                        }
                    } catch(_) {}
                    
                    // Check explosion damage against exploding barrels
                    try {
                        if (room.hazards && room.hazards.explodingBarrels) {
                            const baseDmg = Math.max(30, (Number(data.attackPower) || 0) + 80);
                            for (const barrel of room.hazards.explodingBarrels) {
                                if (barrel.exploded) continue;
                                const dist = Math.hypot(barrel.x - explosionX, barrel.y - explosionY);
                                if (dist <= explosionRadius + (barrel.visualRadius || 24)) {
                                    // Falloff damage
                                    const t = Math.max(0, Math.min(1, dist / explosionRadius));
                                    const dmg = Math.round(baseDmg * (1 - t * 0.5));
                                    room.hazards.damageBarrel(barrel.id, dmg);
                                }
                            }
                        }
                    } catch(e) {
                        console.error('[Server] Error checking barrel explosion damage:', e);
                    }
                    
                    for (const [targetId, target] of room.players) {
                        // Skip dead, invincible, or self
                        if (!target || target.health <= 0 || target.invincible === true || targetId === socket.id) continue;
                        
                        // Check if friendly fire is allowed
                        const targetIsEvil = target.isEvil || false;
                        if (shooterIsEvil === targetIsEvil) continue;
                        
                        // Check if player is in explosion radius
                        const dx = target.x - explosionX;
                        const dy = target.y - explosionY;
                        const dist = Math.hypot(dx, dy);
                        const playerRadius = target.radius || 26;
                        
                        if (dist <= explosionRadius + playerRadius) {
                            // Calculate distance-based damage like client does (100-80*t + baseOffset)
                            const inner = 20;
                            const outer = explosionRadius; // typically 100
                            let t = (dist - inner) / Math.max(1e-6, (outer - inner));
                            t = Math.max(0, Math.min(1, t));
                            let damage = (100 - 80 * t) + (Number(data.baseOffset) || 0);
                            damage += Number(data.attackPower) || 0;
                            
                            // Roll for crit
                            const critChance = Math.max(0, Math.min(1, Number(data.critChance) || 0));
                            const isCrit = Math.random() < critChance;
                            if (isCrit) {
                                damage *= Number(data.critMultiplier) || 1.2;
                            }
                            
                            // Apply armor reduction
                            const armorPercent = Number.isFinite(target.armor) ? target.armor : 0;
                            const reduction = Math.min(0.75, armorPercent / 100);
                            damage *= (1 - reduction);
                            
                            const healthBefore = target.health;
                            target.health = Math.max(0, target.health - damage);
                            
                            console.log(`[PvP] Explosion from player ${socket.id} hit player ${targetId} for ${damage.toFixed(1)} damage`);
                            
                            // Broadcast health update
                            try { 
                                target.socket.emit('playerHealth', { health: target.health, from: 'pvp_explosion' });
                            } catch(_) {}
                            io.to(roomId).emit('playerHealthUpdate', { 
                                playerId: targetId, 
                                health: target.health,
                                from: 'pvp_explosion',
                                attackerId: socket.id
                            });
                            
                            // Broadcast PvP hit event
                            io.to(roomId).emit('pvpHit', {
                                victimId: targetId,
                                attackerId: socket.id,
                                damage: Math.round(damage),
                                crit: isCrit,
                                x: target.x,
                                y: target.y
                            });
                            
                            // Check for death
                            if (target.health <= 0 && healthBefore > 0) {
                                console.log(`[PvP] Player ${targetId} killed by player ${socket.id}'s explosion`);
                                room._handlePlayerDeath(targetId, target, io);
                                io.to(roomId).emit('pvpKill', {
                                    victimId: targetId,
                                    killerId: socket.id,
                                    x: target.x,
                                    y: target.y
                                });
                            }
                        }
                    }
                }
                
                // Relay to all others in the room
                socket.to(roomId).emit('explosionDamage', {
                    hits: Array.isArray(data?.hits) ? data.hits : []
                });
                break;
            }
        },
        
        /**
         * Handler for projectile hits
         */
        projectileHit: (socket, data) => {
            // data: { id, damage, crit, x, y, color, dirX, dirY, impactScale, knockback, weaponIndex }
            for (const [roomId, room] of rooms) {
                if (!room.players.has(socket.id)) continue;

                // Check if projectile was blocked by WallGuy shield
                if (data?.id && data?.x && data?.y && room.enemies) {
                    const enemy = room.enemies.get(data.id);
                    if (enemy && enemy.alive && enemy.type === 'wallguy' && enemy.shieldAngle != null) {
                        // Calculate shield position
                        const shieldDepth = 20;
                        const shieldDist = (enemy.radius || 28) + shieldDepth/2 + 5;
                        const shieldX = enemy.x + Math.cos(enemy.shieldAngle) * shieldDist;
                        const shieldY = enemy.y + Math.sin(enemy.shieldAngle) * shieldDist;

                        // Check if projectile hits shield (oriented box collision)
                        const shieldWidth = 80;

                        // Transform bullet position to shield's local space
                        const dx = data.x - shieldX;
                        const dy = data.y - shieldY;
                        const cos = Math.cos(-enemy.shieldAngle);
                        const sin = Math.sin(-enemy.shieldAngle);
                        const localX = dx * cos - dy * sin;
                        const localY = dx * sin + dy * cos;

                        const halfW = shieldWidth / 2;
                        const halfD = shieldDepth / 2;
                        const bulletRadius = 6; // Approximate bullet radius

                        if (Math.abs(localX) <= halfD + bulletRadius &&
                            Math.abs(localY) <= halfW + bulletRadius) {
                            // Blocked by shield!
                            io.to(roomId).emit('shieldBlocked', {
                                enemyId: enemy.id,
                                x: shieldX,
                                y: shieldY,
                                angle: enemy.shieldAngle
                            });
                            // Don't apply damage or knockback
                            break;
                        }
                    }
                }

                // Apply knockback to server enemy if provided
                if (data?.knockback && data?.id && room.enemies) {
                    const enemy = room.enemies.get(data.id);
                    if (enemy && enemy.alive) {
                        // Weapon 3 knockback cooldown: prevent rapid repeated knockback
                        let canApplyKnockback = true;
                        if (data.weaponIndex === 2) { // Check if it's weapon 3
                            const now = Date.now();
                            const cooldownMs = 800; // Match charge shot time

                            // Initialize cooldown tracking if needed
                            if (typeof enemy._weapon3KnockbackCooldown !== 'number') {
                                enemy._weapon3KnockbackCooldown = 0;
                            }

                            // Check if cooldown has expired
                            const timeLeft = enemy._weapon3KnockbackCooldown - now;
                            if (timeLeft > 0) {
                                canApplyKnockback = false;
                                console.log('[Server][Weapon3] Knockback on cooldown:', Math.round(timeLeft), 'ms remaining for enemy', data.id);
                            } else {
                                enemy._weapon3KnockbackCooldown = now + cooldownMs;
                                console.log('[Server][Weapon3] Applying knockback, setting', cooldownMs, 'ms cooldown for enemy', data.id);
                            }
                        }

                        if (canApplyKnockback) {
                            const kb = data.knockback;
                            if (Number.isFinite(kb.dirX) && Number.isFinite(kb.dirY) && Number.isFinite(kb.distance) && Number.isFinite(kb.duration)) {
                                const spd = Math.hypot(kb.dirX, kb.dirY) || 1;
                                const ux = kb.dirX / spd;
                                const uy = kb.dirY / spd;
                                const v = kb.distance / Math.max(1e-6, kb.duration);
                                // Apply knockback to enemy
                                enemy.kbVelX = (enemy.kbVelX || 0) + ux * v;
                                enemy.kbVelY = (enemy.kbVelY || 0) + uy * v;
                                enemy.kbTime = Math.max(enemy.kbTime || 0, kb.duration);
                            }
                        }
                    }
                }

                // Check if projectile hit any exploding barrel
                if (data?.x && data?.y && room.hazards && room.hazards.explodingBarrels) {
                    const hitX = Number(data.x);
                    const hitY = Number(data.y);
                    const damage = Number(data?.damage) || 10;

                    if (Number.isFinite(hitX) && Number.isFinite(hitY)) {
                        const hitBarrel = room.hazards.damageBarrelAtPoint(hitX, hitY, damage);
                        if (hitBarrel) {
                            console.log('[Server] Projectile hit barrel:', hitBarrel.id, 'damage:', damage);
                        }
                    }
                }

                // Relay to all others in the room
                const relayPayload = {
                    id: data?.id,
                    damage: Number(data?.damage) || 0,
                    crit: !!data?.crit,
                    x: Number.isFinite(data?.x) ? Number(data.x) : undefined,
                    y: Number.isFinite(data?.y) ? Number(data.y) : undefined,
                    color: data?.color,
                    dirX: Number.isFinite(data?.dirX) ? Number(data.dirX) : undefined,
                    dirY: Number.isFinite(data?.dirY) ? Number(data.dirY) : undefined,
                    impactScale: Number.isFinite(data?.impactScale) ? Number(data.impactScale) : undefined
                };
                if (data?.knockback) {
                    relayPayload.knockback = data.knockback;
                    relayPayload.weaponIndex = data.weaponIndex; // Pass weapon index for cooldown logic
                }
                socket.to(roomId).emit('projectileHit', relayPayload);
                break;
            }
        },
        
        /**
         * Handler for DOT (damage over time) ticks
         */
        dotTick: (socket, data) => {
            // data: { id, amount, crit }
            for (const [roomId, room] of rooms) {
                if (!room.players.has(socket.id)) continue;
                socket.to(roomId).emit('dotTick', {
                    id: data?.id,
                    amount: Number(data?.amount) || 0,
                    crit: !!data?.crit
                });
                break;
            }
        },
        
        /**
         * Handler for enemy death
         */
        enemyDied: (socket, data) => {
            try {
                const id = data && data.id;
                if (!id) return;
                
                for (const [roomId, room] of rooms) {
                    if (!room.players.has(socket.id)) continue;
                    if (room.enemies && room.enemies.has(id)) {
                        const e = room.enemies.get(id);

                        // Lobby training dummy: respawn after 2s
                        if (e && e.type === 'targetDummy' && typeof id === 'string' && id.startsWith('target_dummy_')) {
                            try {
                                if (!room._targetDummyRespawnTimers) room._targetDummyRespawnTimers = new Map();
                                const timers = room._targetDummyRespawnTimers;
                                const prev = timers.get(id);
                                if (prev) clearTimeout(prev);
                                const t = setTimeout(() => {
                                    try {
                                        if (!room || room.scene !== 'lobby') return;
                                        if (room.enemies && room.enemies.has(id)) return;
                                        room.spawnLobbyTargetDummy(5);
                                    } catch(_) {}
                                }, 2000);
                                timers.set(id, t);
                            } catch(_) {}
                        }

                        // If it's a boomer, trigger explosion and create puke pool
                        if (e && e.type === 'boomer') {
                            // Broadcast explosion VFX and pooled puddle creation
                            io.to(roomId).emit('boomerExploded', { id: e.id, x: e.x, y: e.y });
                            // Register authoritative pool (lasts ~12s to match client visual, radius ~100)
                            try {
                                if (!room.boomerPools) room.boomerPools = [];
                                room.boomerPools.push({ x: e.x, y: e.y, radius: 100, ttl: 12.0 });
                            } catch(_) {}
                            // Apply explosion damage to nearby players (server-authoritative)
                            const blastRadius = 100;
                            const inner = 20;
                            for (const [, p] of room.players) {
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
                                    const rawDmg = 95 - 75 * tp;
                                    // Apply armor reduction (cap at 75%)
                                    const armorPercent = Number.isFinite(p.armor) ? p.armor : 0;
                                    const reduction = Math.min(0.75, armorPercent / 100);
                                    const dmg = rawDmg * (1 - reduction);
                                    p.health = Math.max(0, (p.health || 0) - dmg);
                                    // Broadcast health to player and room
                                    try { p.socket.emit('playerHealth', { health: p.health, from: 'boomer' }); } catch(_) {}
                                    io.to(roomId).emit('playerHealthUpdate', { playerId: p.id, health: p.health });
                                }
                            }

                            // Apply explosion damage to gold chests
                            for (const [chestId, chest] of room.chests) {
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
                                    io.to(roomId).emit('chestHealthUpdate', {
                                        chestId: chest.id,
                                        health: chest.health,
                                        healthMax: chest.healthMax
                                    });
                                    io.to(roomId).emit('chestHitFlash', {
                                        chestId: chest.id
                                    });

                                    // Auto-open chest if health depleted
                                    if (chest.health <= 0 && !chest.opened) {
                                        chest.opening = false;
                                        chest.opened = true;
                                        io.to(roomId).emit('chestOpened', {
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
                            for (const [chestId, chest] of room.chests) {
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
                                    io.to(roomId).emit('artifactHealthUpdate', {
                                        chestId: chest.id,
                                        health: chest.health,
                                        healthMax: chest.healthMax
                                    });
                                    io.to(roomId).emit('artifactHitFlash', {
                                        chestId: chest.id
                                    });

                                    // Destroy artifact if health depleted
                                    if (chest.health <= 0) {
                                        console.log(`[Server] Artifact ${chest.id} destroyed by boomer explosion`);
                                        io.to(roomId).emit('artifactDestroyed', { chestId: chest.id });
                                    }
                                }
                            }
                        }

                        // If it's a licker, clear ensnare state for all players (use helper)
                        room._clearLickerEnsnareOnDeath(id, e?.type);

                        // If it's a boss, generate server-authoritative loot drops and mark accomplishment
                        if (e && e.type === 'boss') {
                            // Mark Artillery Witch accomplishment for VP rewards
                            room.missionAccomplishments.artilleryWitchKilled = true;
                            console.log('[Server] Artillery Witch killed - accomplishment marked');

                            const drops = room._generateBossLoot(id);
                            const groundItems = [];
                            const base = room._rng((room.worldSeed || 1) + room._hashChestId(String(id)))(); // Use seeded RNG for physics

                            for (let i = 0; i < drops.length; i++) {
                                const drop = drops[i];
                                const itemId = `boss_${id}_${i}`;
                                const ang = base * 2 * Math.PI + (i * (2 * Math.PI / Math.max(1, drops.length)));

                                // Find a clear position for this boss loot item
                                const pos = room.findClearGroundPosition(e.x, e.y, ang);

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

                                room.groundItems.set(itemId, groundItem);
                                groundItems.push(groundItem);
                            }

                            // Broadcast boss loot to all clients
                            io.to(roomId).emit('bossLootDropped', {
                                enemyId: id,
                                x: e.x,
                                y: e.y,
                                groundItems: groundItems
                            });
                            console.log(`[Server] Generated ${groundItems.length} boss loot items for witch at (${e.x.toFixed(1)}, ${e.y.toFixed(1)})`);
                        }

                        // Generate currency drops for all enemies
                        const currencyDrops = room._generateEnemyDrops(id, e.type || 'basic');
                        const currencyItems = [];

                        if (currencyDrops.ducats.length > 0 || currencyDrops.bloodMarkers.length > 0) {
                            const base = room._rng((room.worldSeed || 1) + room._hashChestId(String(id)) + 999)();
                            let itemIndex = 0;

                            // Spawn ducats
                            for (let i = 0; i < currencyDrops.ducats.length; i++) {
                                const drop = currencyDrops.ducats[i];
                                const itemId = `enemy_${id}_ducat_${i}`;
                                const ang = base * 2 * Math.PI + (itemIndex * (2 * Math.PI / 4));
                                const pos = room.findClearGroundPosition(e.x, e.y, ang);

                                const groundItem = {
                                    id: itemId,
                                    x: pos.x,
                                    y: pos.y,
                                    vx: 0,
                                    vy: 0,
                                    type: 'ducat',
                                    amount: drop.amount
                                };

                                room.groundItems.set(itemId, groundItem);
                                currencyItems.push(groundItem);
                                itemIndex++;
                            }

                            // Spawn blood markers
                            for (let i = 0; i < currencyDrops.bloodMarkers.length; i++) {
                                const drop = currencyDrops.bloodMarkers[i];
                                const itemId = `enemy_${id}_blood_${i}`;
                                const ang = base * 2 * Math.PI + (itemIndex * (2 * Math.PI / 4));
                                const pos = room.findClearGroundPosition(e.x, e.y, ang);

                                const groundItem = {
                                    id: itemId,
                                    x: pos.x,
                                    y: pos.y,
                                    vx: 0,
                                    vy: 0,
                                    type: 'bloodMarker',
                                    amount: drop.amount
                                };

                                room.groundItems.set(itemId, groundItem);
                                currencyItems.push(groundItem);
                                itemIndex++;
                            }

                            // Broadcast enemy currency drops to all clients
                            if (currencyItems.length > 0) {
                                io.to(roomId).emit('enemyDrops', {
                                    enemyId: id,
                                    x: e.x,
                                    y: e.y,
                                    groundItems: currencyItems
                                });
                            }
                        }

                        // WallGuy: Clean up shield collision box immediately when killed
                        if (e && e.type === 'wallguy') {
                            try {
                                const boxes = room.environment && room.environment.orientedBoxes;
                                if (Array.isArray(boxes)) {
                                    // Preferred: remove by reference (stable even if array indices shift)
                                    if (e._shieldCollisionBox) {
                                        const idx = boxes.indexOf(e._shieldCollisionBox);
                                        if (idx >= 0) boxes.splice(idx, 1);
                                    } else {
                                        // Fallback: remove by owner id
                                        const idx = boxes.findIndex(b => b && b._wallguyId === e.id);
                                        if (idx >= 0) boxes.splice(idx, 1);
                                    }
                                }
                            } catch (_) {}
                            // Clear tracking fields (including legacy)
                            delete e._shieldCollisionBox;
                            delete e._shieldCollisionIndex;
                        }

                        // Broadcast enemy death to ALL clients so they clean up the enemy
                        io.to(roomId).emit('enemy_dead', {
                            id: id,
                            x: e.x,
                            y: e.y,
                            type: e.type || 'basic'
                        });
                        io.to(roomId).emit('entity_dead', {
                            entityType: 'enemy',
                            id: id,
                            x: e.x,
                            y: e.y,
                            kind: e.type || 'basic'
                        });

                        room.enemies.delete(id);
                        if (e) e.alive = false;
                    }
                    break;
                }
            } catch (e) {
                console.error('[Server] enemyDied handler error:', e && e.stack ? e.stack : String(e));
            }
        },
        
        /**
         * Handler for chest damage
         */
        chestDamage: (socket, data) => {
            // data: { chestId, damage }
            for (const [roomId, room] of rooms) {
                if (!room.players.has(socket.id)) continue;

                const chest = room.chests.get(data.chestId);
                if (!chest || chest.variant !== 'gold') break;

                // Apply damage
                const damage = Number(data.damage) || 0;
                if (damage > 0 && chest.health > 0) {
                    chest.health = Math.max(0, chest.health - damage);

                    // Broadcast health update and hit flash to all clients
                    io.to(roomId).emit('chestHealthUpdate', {
                        chestId: chest.id,
                        health: chest.health,
                        healthMax: chest.healthMax
                    });
                    io.to(roomId).emit('chestHitFlash', {
                        chestId: chest.id
                    });

                    // Debug logging (throttled)
                    if (!chest._lastDamageLog || Date.now() - chest._lastDamageLog >= 1000) {
                        console.log(`[Server] Chest ${chest.id} took ${damage} damage, health: ${chest.health}/${chest.healthMax}`);
                        chest._lastDamageLog = Date.now();
                    }

                    // Check if chest is destroyed by damage (auto-open)
                    if (chest.health <= 0 && !chest.opened) {
                        console.log(`[Server] Chest ${chest.id} destroyed by damage, opening now`);
                        chest.opening = false;
                        chest.opened = true;
                        // Artifact drop descriptor (clients handle physics)
                        io.to(roomId).emit('chestOpened', {
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

                break;
            }
        },
        
        /**
         * Handler for barrel damage
         */
        barrelDamage: (socket, data) => {
            // data: { barrelId, damage, x, y }
            for (const [roomId, room] of rooms) {
                if (!room.players.has(socket.id)) continue;
                
                if (room.hazards && typeof room.hazards.damageBarrel === 'function') {
                    const damage = Number(data.damage) || 10;
                    room.hazards.damageBarrel(data.barrelId, damage, data.x, data.y);
                }
                break;
            }
        },
        
        /**
         * Handler for artifact damage
         */
        artifactDamage: (socket, data) => {
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
        },
        
        /**
         * DEBUG: Kill ghost enemy
         */
        killGhostEnemy: (socket, data) => {
            const id = data && data.id;
            if (!id) return;

            // EARLY EXIT: Silently skip defensive structures by ID pattern (no processing, no logging)
            // This is the most efficient check - avoids room lookup entirely
            if (id.startsWith('defenseTurret_') || id.startsWith('artilleryGun_')) {
                return; // Silent return - no overhead
            }

            // EARLY EXIT: Silently skip bosses - they're spawned via special bossSpawnData event
            // and may have race conditions with regular enemy state updates
            if (id.startsWith('boss_')) {
                return; // Silent return - boss spawns are handled specially
            }

            for (const [roomId, room] of rooms) {
                if (!room.players.has(socket.id)) continue;
                if (room.enemies && room.enemies.has(id)) {
                    const enemy = room.enemies.get(id);

                    // Secondary check by type (in case ID pattern doesn't match)
                    if (enemy && (enemy.type === 'defenseTurret' || enemy.type === 'artilleryGun')) {
                        return; // Silent return
                    }

                    // Clear licker ensnare if applicable
                    room._clearLickerEnsnareOnDeath(id, enemy?.type);

                    // WallGuy: Clean up shield collision box immediately when killed
                    if (enemy && enemy.type === 'wallguy') {
                        try {
                            const boxes = room.environment && room.environment.orientedBoxes;
                            if (Array.isArray(boxes)) {
                                if (enemy._shieldCollisionBox) {
                                    const idx = boxes.indexOf(enemy._shieldCollisionBox);
                                    if (idx >= 0) boxes.splice(idx, 1);
                                } else {
                                    const idx = boxes.findIndex(b => b && b._wallguyId === enemy.id);
                                    if (idx >= 0) boxes.splice(idx, 1);
                                }
                            }
                        } catch (_) {}
                        delete enemy._shieldCollisionBox;
                        delete enemy._shieldCollisionIndex; // legacy
                    }

                    // Mark as dead and remove
                    if (enemy) enemy.alive = false;
                    room.enemies.delete(id);

                    // Broadcast death to all clients
                    io.to(roomId).emit('enemy_dead', {
                        id: id,
                        x: enemy?.x,
                        y: enemy?.y,
                        type: enemy?.type,
                        wasGhost: true  // Debug flag
                    });
                    io.to(roomId).emit('entity_dead', {
                        entityType: 'enemy',
                        id: id,
                        x: enemy?.x,
                        y: enemy?.y,
                        kind: enemy?.type,
                        wasGhost: true  // Debug flag
                    });
                }
                break;
            }
        }
    };
};
