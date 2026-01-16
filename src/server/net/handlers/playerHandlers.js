/**
 * Player Handlers - Phase 2
 * 
 * Handles player state, input, health, revive, potions, etc.
 */

module.exports = function createPlayerHandlers({ io, rooms, Protocol }) {
    return {
        playerInput: (socket, input) => {
            // Find which room this player is in
            for (const [roomId, room] of rooms) {
                if (room.players.has(socket.id)) {
                    room.updatePlayerInput(socket.id, input);
                    break;
                }
            }
        },
        playerDeath: (socket, data) => {
            // Helper function defined earlier in server.js for finding clear positions
            const _findClearArtifactDropPosition = (room, dropX, dropY, fallbackX, fallbackY, radius) => {
                if (!room || !room.environment) return { x: dropX, y: dropY };
                const env = room.environment;
                if (typeof env.isColliding === 'function' && !env.isColliding(dropX, dropY, radius || 10)) {
                    return { x: dropX, y: dropY };
                }
                return { x: fallbackX, y: fallbackY };
            };

            const px = Number(data?.x) || 0;
            const py = Number(data?.y) || 0;
            const name = (data && data.name) ? String(data.name) : String(socket.id).substring(0, 6);
            console.log(`[Server] Player ${name} (${socket.id}) died at (${px.toFixed(1)}, ${py.toFixed(1)})`);
            for (const [roomId, room] of rooms) {
                if (!room.players.has(socket.id)) continue;
                // Set authoritative health to 0 so all clients reflect dead state
                try {
                    const p = room.players.get(socket.id);
                    if (p) {
                        p.health = 0;
                        p.downedAt = Date.now();
                        p.reviveWindowRemainingMs = 30000;
                        p.reviveReadyUntil = 0;
                        p.reviveReadyFromId = null;
                        p._respawnRequested = false;
                    }
                    // Cancel any active revive on this target
                    try {
                        if (room._activeRevivesByTarget && room._activeRevivesByTarget.has(socket.id)) {
                            const st = room._activeRevivesByTarget.get(socket.id);
                            room._activeRevivesByTarget.delete(socket.id);
                            io.to(roomId).emit('reviveState', { type: 'canceled', ...st });
                        }
                    } catch(_) {}
                } catch(_) {}

                // If dead player was carrying artifact, drop it
                for (const chest of room.chests.values()) {
                    if (chest.variant !== 'brown' && chest.artifactCarriedBy === socket.id) {
                        // Drop artifact at player's death position with slight random offset
                        const angle = Math.random() * Math.PI * 2;
                        const dropDist = 40 + Math.random() * 20;
                        const dropX = px + Math.cos(angle) * dropDist;
                        const dropY = py + Math.sin(angle) * dropDist;
                        chest.artifactCarriedBy = null;
                        const safe = _findClearArtifactDropPosition(room, dropX, dropY, px, py, 16);
                        chest.artifactPos = { x: safe.x, y: safe.y };

                        // Reset extraction timer when artifact is dropped
                        if (room.extractionTimer.started && !room.extractionTimer.extracted) {
                            console.log(`[Server] Artifact dropped on death - resetting extraction timer in room ${roomId}`);
                            room.extractionTimer.started = false;
                            room.extractionTimer.extracted = false;
                            room.extractionTimer.timeLeft = 0;
                            room.extractionTimer.startedBy = null;
                            room.emitExtractionTimerState();
                        }

                        // Broadcast artifact drop to all clients
                        io.to(roomId).emit('artifactDropped', {
                            chestId: chest.id,
                            x: chest.artifactPos.x,
                            y: chest.artifactPos.y,
                            vx: Math.cos(angle) * 100,
                            vy: Math.sin(angle) * 100 - 150,
                            health: chest.health,
                            healthMax: chest.healthMax
                        });
                        console.log(`[Server] Player ${name} dropped artifact on death`);
                        break;
                    }
                }

                io.to(roomId).emit('playerDeath', { id: socket.id, name, x: px, y: py });
                break;
            }
        },
        playerRespawn: (socket, data) => {
            // Helper function defined earlier in server.js for finding clear positions
            const _findClearArtifactDropPosition = (room, dropX, dropY, fallbackX, fallbackY, radius) => {
                if (!room || !room.environment) return { x: dropX, y: dropY };
                const env = room.environment;
                if (typeof env.isColliding === 'function' && !env.isColliding(dropX, dropY, radius || 10)) {
                    return { x: dropX, y: dropY };
                }
                return { x: fallbackX, y: fallbackY };
            };

            const name = (data && data.name) ? String(data.name) : String(socket.id).substring(0, 6);
            
            // Find room and generate spawn position (lobby: origin, level: random)
            let roomIdFound = null;
            let px = 0, py = 0;
            
            for (const [roomId, room] of rooms) {
                if (!room.players.has(socket.id)) continue;
                roomIdFound = roomId;

                // Mark respawn requested to block revive acceptance, and cancel any active revive on this target
                try {
                    const p0 = room.players.get(socket.id);
                    if (p0) p0._respawnRequested = true;
                    if (room._activeRevivesByTarget && room._activeRevivesByTarget.has(socket.id)) {
                        const st = room._activeRevivesByTarget.get(socket.id);
                        room._activeRevivesByTarget.delete(socket.id);
                        io.to(roomId).emit('reviveState', { type: 'canceled', ...st });
                    }
                    if (p0) { p0.reviveReadyUntil = 0; p0.reviveReadyFromId = null; }
                } catch(_) {}
                
                // In lobby, spawn at origin; in level, use random position
                if (room.scene === 'level') {
                    const respawnSeed = room.worldSeed + socket.id.charCodeAt(0) + Date.now();
                    const respawnPos = room.generateRandomSpawnPosition(respawnSeed);
                    px = respawnPos.x;
                    py = respawnPos.y;
                } else {
                    // Lobby: spawn at origin
                    px = 0;
                    py = 0;
                }
                
                // Set authoritative server position and health
                try {
                    const p = room.players.get(socket.id);
                    if (p) {
                        // If player is carrying a battery, drop it on RESPawn (not on revive).
                        // This prevents respawning with mission-critical carry items.
                        try {
                            if (room.batteries && typeof room.batteries.values === 'function') {
                                const dropFromX = Number.isFinite(p.x) ? Number(p.x) : 0;
                                const dropFromY = Number.isFinite(p.y) ? Number(p.y) : 0;
                                for (const [batteryId, battery] of room.batteries) {
                                    if (!battery) continue;
                                    if (battery.carriedBy !== socket.id) continue;
                                    const safe = _findClearArtifactDropPosition(room, dropFromX, dropFromY, dropFromX, dropFromY, 18);
                                    battery.carriedBy = null;
                                    battery.slotIndex = null;
                                    battery.x = safe.x;
                                    battery.y = safe.y;
                                    battery.onGround = true;
                                    io.to(roomId).emit('batteryDropped', { batteryId: batteryId, x: battery.x, y: battery.y });
                                    console.log(`[Server] Battery ${batteryId} dropped due to respawn at (${battery.x.toFixed(1)}, ${battery.y.toFixed(1)})`);
                                }
                            }
                        } catch(_) {}

                        p.x = px;
                        p.y = py;
                        p.health = Math.max(1, p.healthMax || 100);
                        p.downedAt = 0;
                        p.reviveWindowRemainingMs = 0;
                        p.reviveReadyUntil = 0;
                        p.reviveReadyFromId = null;
                        p._respawnRequested = false;
                        
                        // Clear all status effects on respawn
                        if (Array.isArray(p.dotStacks)) p.dotStacks.length = 0;
                        p._dotAccum = 0;
                        p._dotTextTimer = 0;
                        if (p._ensnaredBy && typeof p._ensnaredBy.clear === 'function') p._ensnaredBy.clear();
                        p._ensnaredTimer = 0;
                        p._ensnaredById = null;
                        p._svSlowTimer = 0;
                        p._svSlowed = false;
                        
                        // Clear burn state
                        p.burning = false;
                        if (p.burnStacks) p.burnStacks.length = 0;
                        io.to(roomId).emit('burnStateChanged', { playerId: socket.id, burning: false, x: p.x, y: p.y });
                        
                        // Clear inventory on respawn (items already dropped on death)
                        if (Array.isArray(p.inventory)) p.inventory.length = 0;
                        
                        // CRITICAL: Reset loot level to match empty inventory
                        // This fixes weapon scaling, ability unlocks, and stamina drain bugs
                        p.lootLevel = 0;
                        
                        // Clear breadcrumb trail on respawn
                        if (Array.isArray(p.breadcrumbs)) p.breadcrumbs.length = 0;
                        p.totalDistanceMoved = 0;
                        p.lastBreadcrumbX = p.x;
                        p.lastBreadcrumbY = p.y;
                        
                        // Clear weapon firing states
                        p.isFiringWeapon1 = false;
                        p.isFiringWeapon4 = false;
                        p._weapon4FiringStartTime = null;
                        p._weapon4LastFired = null;
                        p._weapon8ADS = false;
                        
                        // Clear dash state
                        p.dashActive = false;
                        p.dashDuration = 0;
                        p._dashInvuln = false;
                        
                        // Clear invisibility state (prevents respawning invisible)
                        p.invisible = false;
                        delete p.invisibilityActiveTime;
                        delete p._invisibilityDrainTimer;
                        io.to(roomId).emit('invisibilityState', { playerId: socket.id, invisible: false });
                        
                        // Broadcast cleared slow state
                        io.to(roomId).emit('playerSlowState', { playerId: socket.id, slowed: false });
                        io.to(roomId).emit('playerMudSlowState', { playerId: socket.id, slowed: false });
                    }
                } catch(_) {}
                break;
            }
            
            console.log(`[Server] Player ${name} (${socket.id}) respawned at (${px.toFixed(1)}, ${py.toFixed(1)})`);
            if (roomIdFound) {
                // Broadcast the new position to all clients
                io.to(roomIdFound).emit('playerUpdate', {
                    id: socket.id,
                    x: px,
                    y: py,
                    health: (() => { try { const r = rooms.get(roomIdFound); const p = r && r.players ? r.players.get(socket.id) : null; return p ? p.health : undefined; } catch(_) { return undefined; } })(),
                    healthMax: (() => { try { const r = rooms.get(roomIdFound); const p = r && r.players ? r.players.get(socket.id) : null; return p ? p.healthMax : undefined; } catch(_) { return undefined; } })()
                });
            }
        },
        playerHealthChange: (socket, data) => {
            // Receive health update from client and broadcast to all players in room
            for (const [roomId, room] of rooms) {
                if (room.players.has(socket.id)) {
                    const player = room.players.get(socket.id);
                    if (player && typeof data.health === 'number') {
                        player.health = data.health;
                        if (typeof data.healthMax === 'number') {
                            player.healthMax = data.healthMax;
                        }
                        // Broadcast to all clients in room (including sender for consistency)
                        io.to(roomId).emit('playerHealthUpdate', {
                            playerId: socket.id,
                            health: player.health,
                            healthMax: player.healthMax
                        });
                    }
                    break;
                }
            }
        },
        reviveStartRequest: (socket, data) => {
            const targetId = data && data.targetId;
            if (!targetId) return;
            for (const [roomId, room] of rooms) {
                if (!room.players.has(socket.id)) continue;
                const reviver = room.players.get(socket.id);
                const target = room.players.get(targetId);
                if (!reviver || !target) break;

                if (!(reviver.health > 0)) break;
                if (!(target.health <= 0)) break;
                if (target._respawnRequested === true) break;

                // If the revive channel already completed and target can accept, don't allow re-starting.
                if ((target.reviveReadyFromId != null) && (Number(target.reviveReadyUntil) || 0) > Date.now()) break;

                // Must start within remaining revive window (pauses while being revived, freezes once ready)
                if (!Number.isFinite(target.reviveWindowRemainingMs) || target.reviveWindowRemainingMs <= 0) break;

                // Range check
                const dx = (reviver.x || 0) - (target.x || 0);
                const dy = (reviver.y || 0) - (target.y || 0);
                const REVIVE_R = 80;
                if (dx * dx + dy * dy > REVIVE_R * REVIVE_R) break;

                if (!room._activeRevivesByTarget) room._activeRevivesByTarget = new Map();
                if (room._activeRevivesByTarget.has(targetId)) break; // target already being revived

                const now = Date.now();
                const st = { targetId, reviverId: socket.id, startedAt: now, endsAt: now + 4000, lastEmitAt: 0 };
                room._activeRevivesByTarget.set(targetId, st);
                try { io.to(roomId).emit('reviveState', { type: 'started', ...st, progress: 0 }); } catch(_) {}
                break;
            }
        },
        reviveAccept: (socket) => {
            for (const [roomId, room] of rooms) {
                if (!room.players.has(socket.id)) continue;
                const target = room.players.get(socket.id);
                if (!target) break;

                const until = Number(target.reviveReadyUntil) || 0;
                const fromId = target.reviveReadyFromId || null;
                if (!fromId || !until || Date.now() > until) break;

                if (!(target.health <= 0)) break;
                if (target._respawnRequested === true) break;

                // Revive in place at 30% health
                const hm = Math.max(1, target.healthMax || 100);
                target.health = Math.max(1, Math.round(hm * 0.30));
                target.downedAt = 0;
                target.reviveWindowRemainingMs = 0;
                target.reviveReadyUntil = 0;
                target.reviveReadyFromId = null;

                // Clear status effects (same philosophy as respawn; do not move)
                try {
                    if (Array.isArray(target.dotStacks)) target.dotStacks.length = 0;
                    target._dotAccum = 0;
                    target._dotTextTimer = 0;
                    if (target._ensnaredBy && typeof target._ensnaredBy.clear === 'function') target._ensnaredBy.clear();
                    target._ensnaredTimer = 0;
                    target._ensnaredById = null;
                    target._svSlowTimer = 0;
                    target._svSlowed = false;
                    target.burning = false;
                    if (target.burnStacks) target.burnStacks.length = 0;
                    io.to(roomId).emit('burnStateChanged', { playerId: socket.id, burning: false, x: target.x, y: target.y });
                    io.to(roomId).emit('playerSlowState', { playerId: socket.id, slowed: false });
                    io.to(roomId).emit('playerMudSlowState', { playerId: socket.id, slowed: false });
                } catch(_) {}

                // Push immediate update to clients so target exits death overlay quickly
                io.to(roomId).emit('playerUpdate', {
                    id: socket.id,
                    x: target.x,
                    y: target.y,
                    health: target.health,
                    healthMax: target.healthMax
                });
                try { io.to(roomId).emit('reviveState', { type: 'accepted', targetId: socket.id, reviverId: fromId }); } catch(_) {}
                break;
            }
        },
        setEvilState: (socket, data) => {
            const isEvil = !!data?.isEvil;
            for (const [roomId, room] of rooms) {
                if (!room.players.has(socket.id)) continue;
                const player = room.players.get(socket.id);
                if (player) {
                    player.isEvil = isEvil;
                    console.log(`[Server] Player ${socket.id} evil state set to: ${isEvil}`);
                    // Broadcast evil state change to all players in room
                    io.to(roomId).emit('playerEvilState', {
                        playerId: socket.id,
                        isEvil: isEvil
                    });
                }
                break;
            }
        },
        pvpDirectDamage: (socket, data) => {
            // data: { targetId, damage, isDot, dotDps, dotDuration, weaponIndex }
            for (const [roomId, room] of rooms) {
                if (!room.players.has(socket.id)) continue;
                
                const shooter = room.players.get(socket.id);
                const target = room.players.get(data.targetId);
                if (!shooter || !target) break;
                
                // Verify PvP is allowed
                const shooterIsEvil = shooter.isEvil || false;
                const targetIsEvil = target.isEvil || false;
                if (shooterIsEvil === targetIsEvil) break;
                
                // Skip dead or invincible
                if (target.health <= 0 || target.invincible === true) break;
                
                if (data.isDot) {
                    // Apply DOT to target
                    if (!Array.isArray(target.dotStacks)) target.dotStacks = [];
                    const wasNotBurning = target.dotStacks.length === 0;
                    const dotDps = Number(data.dotDps) || 5;
                    const dotDuration = Number(data.dotDuration) || 3;
                    
                    target.dotStacks.push({
                        dps: dotDps,
                        timeLeft: dotDuration,
                        from: socket.id
                    });
                    console.log(`[PvP] Player ${socket.id} applied DOT (${dotDps} DPS for ${dotDuration}s) to player ${data.targetId}`);
                    
                    // Broadcast DOT application to clients for fire VFX (like heretic priest)
                    io.to(roomId).emit('playerDotApplied', {
                        playerId: data.targetId,
                        dps: dotDps,
                        duration: dotDuration,
                        sourcePlayerId: socket.id
                    });
                    
                    // Broadcast burn VFX (only if player just started burning)
                    if (wasNotBurning) {
                        io.to(roomId).emit('vfxEvent', {
                            type: 'burnStateChanged',
                            playerId: data.targetId,
                            burning: true,
                            x: target.x,
                            y: target.y
                        });
                    }
                    // Damage numbers are shown by the accumulator in updatePlayerDots (every 0.15s)
                } else {
                    // Apply instant damage
                    let damage = Number(data.damage) || 10;
                    
                    // Apply armor reduction
                    const armorPercent = Number.isFinite(target.armor) ? target.armor : 0;
                    const reduction = Math.min(0.75, armorPercent / 100);
                    damage *= (1 - reduction);
                    
                    const healthBefore = target.health;
                    target.health = Math.max(0, target.health - damage);
                    
                    console.log(`[PvP] Player ${socket.id} hit player ${data.targetId} with weapon ${data.weaponIndex} for ${damage.toFixed(1)} damage`);
                    
                    // Broadcast health update
                    try { 
                        target.socket.emit('playerHealth', { health: target.health, from: 'pvp_direct' });
                    } catch(_) {}
                    io.to(roomId).emit('playerHealthUpdate', { 
                        playerId: data.targetId, 
                        health: target.health,
                        from: 'pvp_direct',
                        attackerId: socket.id
                    });
                    
                    // Broadcast PvP hit event
                    io.to(roomId).emit('pvpHit', {
                        victimId: data.targetId,
                        attackerId: socket.id,
                        damage: Math.round(damage),
                        crit: !!data.crit,
                        x: target.x,
                        y: target.y
                    });
                    
                    // Check for death
                    if (target.health <= 0 && healthBefore > 0) {
                        console.log(`[PvP] Player ${data.targetId} killed by player ${socket.id}'s weapon ${data.weaponIndex}`);
                        io.to(roomId).emit('pvpKill', {
                            victimId: data.targetId,
                            killerId: socket.id,
                            x: target.x,
                            y: target.y
                        });
                    }
                }
                break;
            }
        },
        invincibilityToggle: (socket, data) => {
            console.log(`[Server] Player ${socket.id} toggling invincibility:`, data.invincible);
            // Find which room this player is in and broadcast to all players in that room
            for (const [roomId, room] of rooms) {
                if (room.players.has(socket.id)) {
                    // Store invincibility state on the player object so server damage checks work
                    const player = room.players.get(socket.id);
                    if (player) {
                        player._manualInvincible = !!data.invincible;
                        player.invincible = !!data.invincible || (player._invulnSources > 0);
                        console.log(`[Server] Set player ${socket.id} invincibility to ${player.invincible} (manual=${player._manualInvincible}, sources=${player._invulnSources})`);
                    }

                    io.to(roomId).emit('invincibilitySync', {
                        invincible: data.invincible,
                        fromPlayer: socket.id
                    });
                    console.log(`[Server] Broadcasted invincibility state (${data.invincible}) to all players in room ${roomId}`);
                    break;
                }
            }
        },
        invisibilityToggle: (socket, data) => {
            try {
                for (const [roomId, room] of rooms) {
                    if (!room.players.has(socket.id)) continue;
                    
                    const player = room.players.get(socket.id);
                    if (!player) break;
                    
                    const activate = data?.activate;
                    
                    if (activate) {
                        // Check if player has at least loot level 1 (ability unlocks at loot 1)
                        const lootLevel = player.lootLevel || 0;
                        if (lootLevel < 1) {
                            console.log(`[Invisibility] Player ${socket.id.substring(0,8)} has insufficient loot level: ${lootLevel}, needs 1+`);
                            socket.emit('invisibilityRejected', { 
                                reason: 'insufficient_loot',
                                playerId: socket.id 
                            });
                            socket.emit('invisibilityState', { playerId: socket.id, invisible: false });
                            break;
                        }
                        
                        // Check if player is ensnared by a Licker
                        const isEnsnared = (player._ensnaredTimer && player._ensnaredTimer > 0) || 
                                           (player._ensnaredBy && player._ensnaredBy.size > 0);
                        
                        if (isEnsnared) {
                            console.log(`[Invisibility] Player ${socket.id.substring(0,8)} is ensnared, cannot activate`);
                            // Send rejection with ensnare feedback
                            socket.emit('invisibilityRejected', { 
                                reason: 'ensnared',
                                playerId: socket.id 
                            });
                            break;
                        }
                        
                    // Activate invisibility - check blood cost (1 marker per activation)
                    if ((player.bloodMarkers || 0) < 1) {
                        console.log(`[Invisibility] Insufficient blood markers: has ${player.bloodMarkers}, needs 1`);
                        socket.emit('invisibilityRejected', { 
                            reason: 'insufficient_blood',
                            playerId: socket.id 
                        });
                        socket.emit('invisibilityState', { playerId: socket.id, invisible: false });
                        break;
                    }
                        
                        // Deduct 1 blood marker for activation
                        const oldMarkers = player.bloodMarkers || 0;
                        player.bloodMarkers = Math.max(0, oldMarkers - 1);
                        player.invisible = true;
                        player.invisibilityActiveTime = Date.now();
                        
                        console.log(`[Invisibility] Activated for player ${socket.id.substring(0,8)}, blood: ${oldMarkers} -> ${player.bloodMarkers}`);
                    } else {
                        // Deactivate invisibility
                        player.invisible = false;
                        delete player.invisibilityActiveTime;
                        
                        console.log(`[Invisibility] Deactivated for player ${socket.id.substring(0,8)}`);
                    }
                    
                    // Broadcast invisibility state to all clients in room
                    io.to(roomId).emit('invisibilityState', {
                        playerId: socket.id,
                        invisible: player.invisible || false
                    });
                    
                    break;
                }
            } catch (err) {
                console.error('[Server] invisibilityToggle error:', err);
            }
        },
        useHealthPotion: (socket, data) => {
            try {
                data = data || {};
                const totalHeal = Number(data.heal) || 25;
                const cost = Number(data.cost) || 30;
                const tickHeal = 5; // Match HealingBox healAmount
                const tickMs = 1000; // Match HealingBox healInterval (1s)
                // Find which room this player is in
                for (const [roomId, room] of rooms) {
                    if (!room.players.has(socket.id)) continue;
                    const player = room.players.get(socket.id);
                    if (!player) return;
                    if (!(player.health > 0)) {
                        console.log(`[Potion] Dead player cannot use potion: ${socket.id.substring(0,8)}`);
                        return;
                    }
                    // Block if a potion heal is already active
                    if (player._potionHealingActive) {
                        console.log(`[Potion] Potion already active for ${socket.id.substring(0,8)}`);
                        return;
                    }
                    if ((player.ducats || 0) < cost) {
                        console.log(`[Potion] Insufficient ducats for ${socket.id.substring(0,8)}: has ${player.ducats}, needs ${cost}`);
                        return;
                    }
                    const missingNow = Math.max(0, (player.healthMax || 0) - (player.health || 0));
                    if (missingNow <= 0) {
                        console.log(`[Potion] Player at full health: ${socket.id.substring(0,8)}`);
                        return;
                    }
                    // Deduct cost up front
                    const oldDucats = player.ducats || 0;
                    player.ducats = Math.max(0, oldDucats - cost);
                    socket.emit('currencyUpdated', {
                        playerId: socket.id,
                        ducats: player.ducats,
                        bloodMarkers: player.bloodMarkers || 0
                    });
                    // Schedule over-time healing in 5 HP ticks
                    let remaining = Math.max(0, Math.min(totalHeal, missingNow));
                    const tickCount = Math.max(1, Math.ceil(remaining / tickHeal));
                    const durationMs = tickCount * tickMs;
                    player._potionHealingActive = true;
                    player._potionHealEndAt = Date.now() + durationMs;
                    try { socket.emit('potionStarted', { durationMs, endAt: player._potionHealEndAt }); } catch(_) {}
                    if (player._potionTimer) { try { clearInterval(player._potionTimer); } catch(_) {} }
                    const timer = setInterval(() => {
                        try {
                            // Validate room and player still present
                            const r = rooms.get(roomId);
                            if (!r || !r.players || !r.players.has(socket.id)) { clearInterval(timer); return; }
                            const pl = r.players.get(socket.id);
                            if (!pl || !(pl.health > 0)) { clearInterval(timer); return; }
                            const cap = Math.max(0, (pl.healthMax || 0) - (pl.health || 0));
                            if (remaining <= 0 || cap <= 0) { clearInterval(timer); return; }
                            const amt = Math.max(0, Math.min(tickHeal, remaining, cap));
                            if (amt <= 0) { clearInterval(timer); return; }
                            pl.health = (pl.health || 0) + amt;
                            remaining -= amt;
                            io.to(roomId).emit('playerHealed', {
                                playerId: socket.id,
                                amount: amt,
                                newHealth: pl.health
                            });
                            if (remaining <= 0) { clearInterval(timer); }
                        } catch (err) {
                            clearInterval(timer);
                        }
                    }, tickMs);
                    player._potionTimer = timer;
                    // Cleanup when interval ends
                    setTimeout(() => {
                        try {
                            if (player) {
                                player._potionHealingActive = false;
                                player._potionHealEndAt = null;
                                player._potionTimer = null;
                                try { socket.emit('potionEnded', {}); } catch(_) {}
                            }
                        } catch(_) {}
                    }, durationMs + 50);
                    console.log(`[Potion] Player ${socket.id.substring(0,8)} started potion heal ${remaining}/${totalHeal}, ducats now ${player.ducats}`);
                    break;
                }
            } catch (e) {
                console.error('[Potion] Error handling useHealthPotion:', e);
            }
        }
    };
};
