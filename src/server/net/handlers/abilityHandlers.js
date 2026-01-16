/**
 * Ability Handlers - Phase 2
 * 
 * Handles ability-related socket events (turrets, shields, mines, etc.)
 */

module.exports = function createAbilityHandlers({ io, rooms, Protocol, getWeaponProgression }) {
    return {
        abilityCreate: (socket, data) => {
            if (!data || !data.type) return;
            
            const requestTime = Date.now();
            // Note: server.js suppresses most logs for perf; use DEBUG_SHIELDWALL=1 for targeted wall diagnostics.
            const DEBUG_SHIELDWALL = process.env.DEBUG_SHIELDWALL === '1';
            console.log('[Server][AbilityCreate] 🔥 RECEIVED', data.type, 'request from', socket.id.substring(0,8), 
                        'at timestamp:', requestTime, 'args:', JSON.stringify(data.args || []).substring(0, 100));
            
            for (const [roomId, room] of rooms) {
                if (!room.players.has(socket.id)) continue;
                
                const player = room.players.get(socket.id);
                if (!player) break;
                
                // Validate blood cost
                const bloodCost = Number(data.bloodCost) || 0;
                if (bloodCost > 0) {
                    if ((player.bloodMarkers || 0) < bloodCost) {
                        console.log('[Server] Ability creation rejected - insufficient blood markers:', player.bloodMarkers, '<', bloodCost);
                        // Send rejection to client
                        socket.emit('abilityRejected', { type: data.type, reason: 'insufficient_blood' });
                        break;
                    }
                    // Deduct blood markers
                    const oldMarkers = player.bloodMarkers;
                    player.bloodMarkers = Math.max(0, (player.bloodMarkers || 0) - bloodCost);
                    console.log('[Server] Deducted', bloodCost, 'blood markers:', oldMarkers, '→', player.bloodMarkers);
                }
                
                // Create ability ID
                const abilityId = `ability_${roomId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
                
                // Handle ability-specific server-side logic
                if (data.type === 'ShieldWall') {
                    // Check if ability is unlocked at player's loot level
                    const lootLevel = player.lootLevel || 0;
                    const progression = getWeaponProgression(0, lootLevel); // Weapon 0 = weapon1
                    
                    if (!progression.secondary) {
                        console.log('[Server] ShieldWall rejected - ability not unlocked at loot level:', lootLevel);
                        socket.emit('abilityRejected', { type: data.type, reason: 'ability_locked' });
                        // Refund blood markers since we deducted them above
                        player.bloodMarkers = Math.min((player.bloodMarkers || 0) + bloodCost, player.bloodMarkerCap || 20);
                        break;
                    }
                    
                    // Check maxWalls limit
                    const maxWalls = progression.secondary.maxWalls;
                    
                    if (maxWalls !== undefined) {
                        // Count existing ShieldWalls owned by this player
                        let existingWalls = 0;
                        for (const [abilId, abil] of room.abilities) {
                            if (abil.type === 'ShieldWall' && abil.ownerId === socket.id) {
                                existingWalls++;
                            }
                        }
                        
                        if (existingWalls >= maxWalls) {
                            console.log('[Server] ShieldWall rejected - maxWalls reached:', existingWalls, '/', maxWalls);
                            socket.emit('abilityRejected', { type: data.type, reason: 'max_walls_reached' });
                            // Refund blood markers since we deducted them above
                            player.bloodMarkers = Math.min((player.bloodMarkers || 0) + bloodCost, player.bloodMarkerCap || 20);
                            break;
                        }
                    }
                    
                    // Add oriented box collision to server environment
                    const [aimAngle, placementX, placementY, wallWidth = 100] = data.args || [0, 0, 0, 100];
                    // Visual: width runs along perpendicular to aim, depth runs along aim
                    // So collision angle must be perpendicular to aim angle
                    const perpAngle = aimAngle + Math.PI / 2;
                    
                    const collisionBox = {
                        x: placementX,
                        y: placementY,
                        w: wallWidth,  // width from progression (along perpAngle)
                        h: 20,   // depth (along aimAngle)
                        angle: perpAngle,  // Rotate 90° from aim to match visual orientation
                        _abilityId: abilityId
                    };
                    
                    if (room.environment && room.environment.orientedBoxes) {
                        room.environment.orientedBoxes.push(collisionBox);
                        if (DEBUG_SHIELDWALL) {
                            // IMPORTANT: This line is allow-listed by server.js even when SERVER_LOGS=0.
                            console.log('[ShieldWall][Server] OBB registered', {
                                roomId,
                                ownerId: socket.id,
                                abilityId,
                                scene: room.scene,
                                x: placementX,
                                y: placementY,
                                w: wallWidth,
                                h: 20,
                                perpAngle,
                                orientedBoxesLen: room.environment.orientedBoxes.length
                            });
                        }
                        
                        // Store ability with collision box index for cleanup
                        room.abilities.set(abilityId, {
                            type: 'ShieldWall',
                            data: collisionBox,
                            ownerId: socket.id, // Track owner for maxWalls enforcement
                            createdAt: Date.now(),
                            expiresAt: Date.now() + 60000 // 60 second lifetime
                        });

                        // Debug trace: verify the registered wall collider stays put over time.
                        // This helps detect index corruption (e.g., other systems updating the wrong orientedBoxes entry).
                        if (DEBUG_SHIELDWALL) {
                            const trace = (delayMs) => {
                                setTimeout(() => {
                                    try {
                                        const env = room.environment;
                                        const boxes = env && env.orientedBoxes;
                                        const byIdIdx = Array.isArray(boxes) ? boxes.findIndex(b => b && b._abilityId === abilityId) : -1;
                                        const byRefIdx = Array.isArray(boxes) ? boxes.findIndex(b => b === collisionBox) : -1;
                                        const box = (Array.isArray(boxes) && byIdIdx >= 0) ? boxes[byIdIdx] : null;
                                        const bx = box ? box.x : null;
                                        const by = box ? box.y : null;
                                        const ba = box ? (box.angle || 0) : null;
                                        const dist = (box && Number.isFinite(bx) && Number.isFinite(by))
                                            ? Math.hypot(bx - placementX, by - placementY)
                                            : null;
                                        const moved = (dist != null) ? (dist > 1.0) : null;

                                        // IMPORTANT: include unique prefix so server.js rate-limit doesn't suppress successive trace lines
                                        console.log(`[ShieldWall][Trace] ${abilityId} +${delayMs}ms`, {
                                            roomId,
                                            scene: room.scene,
                                            byIdIdx,
                                            byRefIdx,
                                            present: !!box,
                                            x: bx,
                                            y: by,
                                            angle: ba,
                                            distFromSpawn: dist,
                                            moved
                                        });
                                    } catch (e) {
                                        // Still allow-listed
                                        console.log(`[ShieldWall][Trace] ${abilityId} +${delayMs}ms error`, {
                                            roomId,
                                            scene: room.scene,
                                            message: e && e.message ? e.message : String(e)
                                        });
                                    }
                                }, delayMs);
                            };

                            trace(500);
                            trace(2500);
                            trace(6000);
                        }
                    } else {
                        if (DEBUG_SHIELDWALL) {
                            // IMPORTANT: This line is allow-listed by server.js even when SERVER_LOGS=0.
                            console.log('[ShieldWall][Server] OBB NOT registered (missing env/orientedBoxes)', {
                                roomId,
                                ownerId: socket.id,
                                abilityId,
                                scene: room.scene,
                                hasEnv: !!room.environment,
                                hasOrientedBoxes: !!room.environment?.orientedBoxes,
                                x: placementX,
                                y: placementY,
                                w: wallWidth,
                                h: 20,
                                perpAngle
                            });
                        }
                    }
                } else if (data.type === 'ProximityMine') {
                    // ProximityMine: instant drop at location (placementX, placementY, progression)
                    const [placementX, placementY, progression] = data.args || [0, 0, null];
                    
                    // Apply progression multipliers
                    const mineSizeMultiplier = progression?.mineSizeMultiplier || 1.0;
                    const mineExplosionMultiplier = progression?.mineExplosionMultiplier || 1.0;
                    const baseRadius = 15;
                    const baseExplosionRadius = 300;
                    const baseExplosionDamage = 95 * 2;
                    
                    const mineRadius = baseRadius * mineSizeMultiplier;
                    const explosionRadius = baseExplosionRadius * mineExplosionMultiplier;
                    const explosionDamage = baseExplosionDamage * mineExplosionMultiplier;
                    
                    // Store mine in abilities map for damage tracking
                    room.abilities.set(abilityId, {
                        type: 'ProximityMine',
                        health: 20,
                        healthMax: 20,
                        x: placementX,
                        y: placementY,
                        radius: mineRadius,
                        explosionRadius: explosionRadius,
                        explosionDamage: explosionDamage,
                        ownerId: socket.id,
                        createdAt: Date.now(),
                        expiresAt: Date.now() + 30000, // 30 second lifetime
                        progression: progression // Store for client sync
                    });
                    
                    console.log('[Server] ProximityMine placed at', placementX, placementY, 
                               'size:', mineRadius.toFixed(1), 'explosion:', explosionRadius.toFixed(1));
                } else if (data.type === 'HealingBox') {
                    // HealingBox: placeable healing station
                    const [placementX, placementY, progression] = data.args || [0, 0, null];
                    
                    // Get player's weapon progression
                    const lootLevel = player.lootLevel || 0;
                    const prog = progression || getWeaponProgression(2, lootLevel)?.secondary || {};
                    
                    // Check max heal stations cap
                    const maxHealStations = prog.maxHealStations || 1;
                    let existingBoxes = 0;
                    for (const [id, ability] of room.abilities) {
                        if (ability.type === 'HealingBox' && ability.ownerId === socket.id) {
                            existingBoxes++;
                        }
                    }
                    
                    if (existingBoxes >= maxHealStations) {
                        console.log('[Server] HealingBox rejected - at max:', maxHealStations);
                        socket.emit('abilityRejected', { type: data.type, reason: 'max_heal_stations_reached' });
                        // Refund blood markers since we deducted them above
                        player.bloodMarkers = Math.min((player.bloodMarkers || 0) + bloodCost, player.bloodMarkerCap || 20);
                        break;
                    }
                    
                    // Apply progression scaling
                    const healAmount = prog.healAmount || 50;
                    const diameterMultiplier = prog.healDiameterMultiplier || 1.0;
                    const baseHealRadius = 100;
                    const healRadius = baseHealRadius * diameterMultiplier;
                    const boxHealthMax = healAmount; // Box HP matches total heal amount (50, 100, 150)
                    const healPerTick = healAmount / 10; // 10% of total per tick (5, 10, 15 HP/tick)
                    
                    // Store healing box in abilities map
                    room.abilities.set(abilityId, {
                        type: 'HealingBox',
                        health: boxHealthMax,
                        healthMax: boxHealthMax,
                        x: placementX,
                        y: placementY,
                        healRadius: healRadius,
                        healAmount: healPerTick,
                        healInterval: 1.0, // Heal every 1 second
                        healthCostPerHeal: healPerTick, // Box loses same amount it heals per tick
                        ownerId: socket.id,
                        createdAt: Date.now(),
                        lastHealTick: Date.now(),
                        expiresAt: Date.now() + 90000, // 90 second lifetime
                        progression: prog // Store for client sync
                    });
                    
                    console.log('[Server] HealingBox placed at', placementX, placementY, 
                               'healRadius:', healRadius.toFixed(1), 'healAmount:', healPerTick.toFixed(1));
                } else if (data.type === 'AutoTurret') {
                    // AutoTurret: automated defense turret
                    const [placementX, placementY, options] = data.args || [0, 0, {}];
                    
                    // Get weapon 7 progression for turret limits and health
                    const progression = getWeaponProgression(6, player.lootLevel || 0);
                    if (!progression || !progression.secondary) {
                        console.log('[Server] AutoTurret rejected - no secondary progression at loot level', player.lootLevel);
                        // Refund blood markers since we deducted them above
                        player.bloodMarkers = Math.min((player.bloodMarkers || 0) + bloodCost, player.bloodMarkerCap || 20);
                        break;
                    }
                    
                    // Check maxTurrets limit
                    const maxTurrets = progression.secondary.maxTurrets;
                    
                    if (maxTurrets !== undefined) {
                        // Count existing AutoTurrets owned by this player
                        let existingTurrets = 0;
                        for (const [abilId, abil] of room.abilities) {
                            if (abil.type === 'AutoTurret' && abil.ownerId === socket.id) {
                                existingTurrets++;
                            }
                        }
                        
                        if (existingTurrets >= maxTurrets) {
                            console.log('[Server] AutoTurret rejected - maxTurrets reached:', existingTurrets, '/', maxTurrets);
                            socket.emit('abilityRejected', { type: data.type, reason: 'max_turrets_reached' });
                            // Refund blood markers since we deducted them above
                            player.bloodMarkers = Math.min((player.bloodMarkers || 0) + bloodCost, player.bloodMarkerCap || 20);
                            break;
                        }
                    }
                    
                    // Apply turret health from progression config
                    const turretHealth = options.turretHealth || progression.secondary.turretHealth || 150;
                    
                    // Store turret in abilities map
                    room.abilities.set(abilityId, {
                        type: 'AutoTurret',
                        health: turretHealth,
                        healthMax: turretHealth,
                        x: placementX,
                        y: placementY,
                        radius: 25, // Collision radius for enemy damage
                        targetingRadius: 210, // 60% of weapon 7 (350 * 0.6)
                        fireRate: 8.84, // 30% faster than weapon 7 (6.8 * 1.3)
                        fireCooldown: 0,
                        angle: 0,
                        currentTarget: null,
                        ownerId: socket.id,
                        createdAt: Date.now(),
                        expiresAt: Date.now() + 90000 // 90 second lifetime
                    });
                    
                    console.log('[Server] AutoTurret placed at', placementX, placementY, 'with health:', turretHealth, 'max turrets:', maxTurrets);
                } else if (data.type === 'MolotovPool') {
                    // MolotovPool: fire pool DOT area
                    const [targetX, targetY, aimAngle] = data.args || [0, 0, 0];
                    
                    const creationTime = Date.now();
                    console.log('[Server][MolotovPool] 🔥 CREATING pool at', targetX.toFixed(1), targetY.toFixed(1), 
                                'angle:', aimAngle.toFixed(2), 'timestamp:', creationTime, 
                                'request→creation delay:', (creationTime - (requestTime || creationTime)), 'ms');
                    
                    // Store fire pool in abilities map
                    room.abilities.set(abilityId, {
                        type: 'MolotovPool',
                        x: targetX,
                        y: targetY,
                        angle: aimAngle,
                        radius: 200, // 2x bigger than original 100
                        dotDps: 20, // 4x weapon 4 base DOT (doubled twice)
                        dotDuration: 3, // Same as weapon 4
                        ownerId: socket.id,
                        createdAt: creationTime,
                        expiresAt: creationTime + 18000, // 18 second lifetime (50% longer: 12 * 1.5)
                        lastDotTick: creationTime
                    });
                    
                    console.log('[Server][MolotovPool] ✓ Pool stored in abilities map with ID:', abilityId);
                } else if (data.type === 'EnemyAttractor') {
                    // Check if ability is unlocked at player's loot level (requires loot 1+)
                    const lootLevel = player.lootLevel || 0;
                    const progression = getWeaponProgression(5, lootLevel); // Weapon 5 = weapon 6
                    
                    if (!progression.secondary) {
                        console.log('[Server] EnemyAttractor rejected - ability not unlocked at loot level:', lootLevel);
                        socket.emit('abilityRejected', { type: data.type, reason: 'ability_locked' });
                        // Refund blood markers since we deducted them above
                        player.bloodMarkers = Math.min((player.bloodMarkers || 0) + bloodCost, player.bloodMarkerCap || 20);
                        break;
                    }
                    
                    // Check maxAttractors limit
                    const maxAttractors = progression.secondary.maxAttractors;
                    
                    if (maxAttractors !== undefined) {
                        // Count existing EnemyAttractors owned by this player
                        let existingAttractors = 0;
                        for (const [abilId, abil] of room.abilities) {
                            if (abil.type === 'EnemyAttractor' && abil.ownerId === socket.id) {
                                existingAttractors++;
                            }
                        }
                        
                        if (existingAttractors >= maxAttractors) {
                            console.log('[Server] EnemyAttractor rejected - maxAttractors reached:', existingAttractors, '/', maxAttractors);
                            socket.emit('abilityRejected', { type: data.type, reason: 'max_attractors_reached' });
                            // Refund blood markers since we deducted them above
                            player.bloodMarkers = Math.min((player.bloodMarkers || 0) + bloodCost, player.bloodMarkerCap || 20);
                            break;
                        }
                    }
                    
                    // EnemyAttractor: enemy distraction device
                    const [placementX, placementY] = data.args || [0, 0];
                    
                    // Get radius multipliers from progression
                    const targetRadiusMultiplier = progression.secondary.targetRadiusMultiplier || 1.0;
                    const attractionRadiusMultiplier = progression.secondary.attractionRadiusMultiplier || 1.0;
                    
                    // Base attraction radius: 200
                    const baseAttractionRadius = 200;
                    const scaledAttractionRadius = baseAttractionRadius * attractionRadiusMultiplier;
                    
                    // Store attractor in abilities map with scaled radius
                    room.abilities.set(abilityId, {
                        type: 'EnemyAttractor',
                        health: 450, // 50% increase from 300
                        healthMax: 450,
                        x: placementX,
                        y: placementY,
                        radius: 20,
                        attractionRadius: scaledAttractionRadius, // Scale based on loot progression
                        healthDrainRate: 60, // Loses 60 HP/second (450 HP / 7.5 seconds)
                        ownerId: socket.id,
                        createdAt: Date.now(),
                        expiresAt: Date.now() + 7500 // 7.5 second lifetime (50% increase from 5)
                    });
                    
                    console.log('[Server] EnemyAttractor placed at', placementX, placementY, 'with attraction radius:', scaledAttractionRadius);
                }
                
                // Prepare ability data for broadcast
                const abilityData = {
                    serverId: abilityId,
                    type: data.type,
                    ownerId: socket.id,
                    ownerLootLevel: player.lootLevel || 0, // Include owner's loot level for client-side scaling
                    args: data.args || [] // Pass through constructor args (aimAngle, x, y, etc.)
                };
                
                const broadcastTime = Date.now();
                console.log('[Server][AbilityCreate] 📡 BROADCASTING', abilityData.type, 'to room', roomId, 
                            'at timestamp:', broadcastTime, 'args:', abilityData.args, 
                            'total processing time:', (broadcastTime - (requestTime || broadcastTime)), 'ms');
                
                // Broadcast ability creation to ALL players in room (including creator)
                io.to(roomId).emit('abilityCreated', abilityData);
                
                console.log('[Server][AbilityCreate] ✓ Broadcast complete for', abilityData.type);
                
                // Immediately broadcast updated game state so blood markers sync
                room.broadcastGameState();
                
                break;
            }
        },
        
        abilityDamage: (socket, data) => {
            if (!data || !data.abilityId) return;
            
            for (const [roomId, room] of rooms) {
                if (!room.players.has(socket.id)) continue;
                
                // Broadcast damage to ability
                io.to(roomId).emit('abilityDamaged', {
                    abilityId: data.abilityId,
                    damage: Number(data.damage) || 0,
                    attackerId: socket.id
                });
                
                break;
            }
        },
        
        abilityTrigger: (socket, data) => {
            if (!data || !data.serverId) return;
            
            console.log('[Server] Ability trigger:', data.type, 'ID:', data.serverId);
            
            for (const [roomId, room] of rooms) {
                if (!room.players.has(socket.id)) continue;
                
                // Fetch ability before removal so we can use its data (e.g., explosion radius)
                const ability = room.abilities.get(data.serverId);
                // Apply hazard damage for explosive abilities
                try {
                    if (room.hazards && ability) {
                        const isExplosive = (data.type === 'ProximityMine') || (ability.explosionRadius != null);
                        if (isExplosive) {
                            const ex = Number.isFinite(data.x) ? data.x : (ability.x || 0);
                            const ey = Number.isFinite(data.y) ? data.y : (ability.y || 0);
                            const r = Number.isFinite(ability.explosionRadius) ? ability.explosionRadius : 300;
                            const dmg = Number.isFinite(ability.explosionDamage) ? ability.explosionDamage : 150;
                            
                            // Damage sandbags
                            if (typeof room.hazards.damageCircle === 'function') {
                                room.hazards.damageCircle(ex, ey, r, dmg);
                            }
                            // Damage barrels
                            if (typeof room.hazards.damageBarrelInRadius === 'function') {
                                room.hazards.damageBarrelInRadius(ex, ey, r, dmg);
                            }
                        }
                    }
                } catch(_) {}

                // Remove ability from server tracking
                if (room.abilities.has(data.serverId)) {
                    room.abilities.delete(data.serverId);
                    console.log('[Server] Removed ability:', data.serverId, 'Remaining:', room.abilities.size);
                }
                
                // Broadcast trigger to all clients so they can remove it and show VFX
                io.to(roomId).emit('abilityTriggered', {
                    serverId: data.serverId,
                    type: data.type,
                    x: data.x,
                    y: data.y
                });
                
                break;
            }
        },
        
        abilityDotDamage: (socket, data) => {
            if (!data || !data.abilityId || !data.targetPlayerId) return;
            
            console.log('[Server] Ability DOT damage:', data.abilityId, '→', data.targetPlayerId);
            
            for (const [roomId, room] of rooms) {
                if (!room.players.has(socket.id)) continue;
                
                const targetPlayer = room.players.get(data.targetPlayerId);
                if (!targetPlayer) {
                    console.log('[Server] Target player not found:', data.targetPlayerId);
                    break;
                }
                
                // Verify ability exists and belongs to attacker
                const ability = room.abilities.get(data.abilityId);
                if (!ability || ability.ownerId !== socket.id) {
                    console.log('[Server] Invalid ability or ownership:', data.abilityId);
                    break;
                }
                
                // Apply DOT to target player (server-authoritative)
                const dps = Number(data.dps) || 5;
                const duration = Number(data.duration) || 3;
                
                // Add DOT stack to target player
                if (!targetPlayer._dotStacks) targetPlayer._dotStacks = [];
                targetPlayer._dotStacks.push({ 
                    dps: dps, 
                    timeLeft: duration,
                    source: 'ability',
                    abilityId: data.abilityId,
                    attackerId: socket.id
                });
                
                console.log('[Server] Applied DOT:', dps, 'DPS for', duration, 's to', data.targetPlayerId);
                
                break;
            }
        }
    };
};
