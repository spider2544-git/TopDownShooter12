/**
 * Item Handlers - Phase 4
 * 
 * Handles chests, inventory, artifacts, batteries
 */

module.exports = function createItemHandlers({ io, rooms, Protocol }) {
    
    // Helper: ensure artifact drop position is not inside walls/obstacles.
    // This fixes cases where dropping near a wall makes the artifact impossible to pick up.
    function _findClearArtifactDropPosition(room, desiredX, desiredY, fallbackX, fallbackY, radius = 16) {
        const env = room && room.environment;
        const hasBounds = !!(env && typeof env.isInsideBounds === 'function');
        const hasHits = !!(env && typeof env.circleHitsAny === 'function');
        const isFiniteXY = (x, y) => Number.isFinite(x) && Number.isFinite(y);
        const isClear = (x, y) => {
            if (!isFiniteXY(x, y)) return false;
            if (hasBounds && !env.isInsideBounds(x, y, radius)) return false;
            if (hasHits && env.circleHitsAny(x, y, radius)) return false;
            return true;
        };
        // Prefer desired position if valid
        if (isClear(desiredX, desiredY)) return { x: desiredX, y: desiredY };

        const centers = [];
        if (isFiniteXY(desiredX, desiredY)) centers.push({ x: desiredX, y: desiredY });
        if (isFiniteXY(fallbackX, fallbackY)) centers.push({ x: fallbackX, y: fallbackY });

        // Spiral-ish ring search around desired, then fallback (player) position
        const maxDist = 240;
        const step = 12;
        for (const center of centers) {
            for (let dist = step; dist <= maxDist; dist += step) {
                const circum = 2 * Math.PI * dist;
                const numPoints = Math.max(8, Math.floor(circum / step));
                for (let i = 0; i < numPoints; i++) {
                    const ang = (i / numPoints) * 2 * Math.PI;
                    const cx = center.x + dist * Math.cos(ang);
                    const cy = center.y + dist * Math.sin(ang);
                    if (isClear(cx, cy)) return { x: cx, y: cy };
                }
            }
        }
        // If all else fails, return player position or origin
        return { x: isFiniteXY(fallbackX, fallbackY) ? fallbackX : 0, y: isFiniteXY(fallbackX, fallbackY) ? fallbackY : 0 };
    }
    
    return {
        chestOpenRequest: (socket, data) => {
            // Find which room this player is in
            for (const [roomId, room] of rooms) {
                if (room.players.has(socket.id)) {
                    room.startChestOpening(socket.id, data || {});
                    break;
                }
            }
        },
        
        inventoryDropRequest: (socket, data) => {
            // data: { items: [{ label, rarityName, color }], x, y, baseAngle, speed }
            for (const [roomId, room] of rooms) {
                if (!room.players.has(socket.id)) continue;
                const items = Array.isArray(data?.items) ? data.items : [];
                const count = Math.min(10, Math.max(1, items.length));
                const created = [];
                const baseX = Number(data.x) || 0;
                const baseY = Number(data.y) || 0;
                
                for (let i = 0; i < count; i++) {
                    const d = items[i]; if (!d) continue;
                    const id = `itm_${room.nextItemId++}`;
                    const ang = (data.baseAngle || 0) + (i * (2 * Math.PI / Math.max(1, count)));
                    
                    // Find a clear position for this item
                    const pos = room.findClearGroundPosition(baseX, baseY, ang);
                    
                    // Create item with resolved position and minimal velocity (just for visual effect)
                    const item = { 
                        id, 
                        x: pos.x, 
                        y: pos.y, 
                        vx: 0, 
                        vy: 0, 
                        label: d.label, 
                        rarityName: d.rarityName, 
                        color: d.color,
                        // Preserve stat data for re-pickup
                        statKey: d.statKey,
                        bonusValue: d.bonusValue,
                        isPercent: d.isPercent,
                        rarity: d.rarity,
                        // Preserve heal tracking so each player only gets healed once per item
                        suppressHealForPlayerId: d.suppressHealForPlayerId
                    };
                    room.groundItems.set(id, item);
                    created.push(item);
                }
                // Remove dropped items from server-side inventory and recalculate stats
                const player = room.players.get(socket.id);
                if (player && created.length > 0 && Array.isArray(player.inventory)) {
                    const beforeHP = player.health;
                    const beforeMaxHP = player.healthMax;
                    const beforeSpeed = player.speed;
                    const beforeInventorySize = player.inventory.length;
                    
                    console.log(`[Server] Player ${socket.id} dropping ${created.length} items from inventory of ${beforeInventorySize}`);
                    
                    // Remove only the dropped items from inventory (match by statKey + bonusValue)
                    for (let i = 0; i < items.length; i++) {
                        const droppedItem = items[i];
                        if (!droppedItem) continue;
                        
                        // Find and remove the first matching item in server inventory
                        const matchIdx = player.inventory.findIndex(invItem => 
                            invItem && 
                            invItem.statKey === droppedItem.statKey && 
                            invItem.bonusValue === droppedItem.bonusValue &&
                            invItem.isPercent === droppedItem.isPercent
                        );
                        
                        if (matchIdx !== -1) {
                            player.inventory.splice(matchIdx, 1);
                            console.log(`[Server]   Removed ${droppedItem.label} from inventory (was at index ${matchIdx})`);
                        }
                    }
                    
                    // Reset last eligible health bonus before recalculating
                    player._lastEligibleHealthBonus = 0;
                    
                    // Update loot level to match inventory size
                    player.lootLevel = player.inventory.length;
                    
                    // Recalculate stats with remaining inventory items
                    room.recalculatePlayerStats(player);
                    
                    console.log(`[Server] After drop: Inventory ${beforeInventorySize}→${player.inventory.length}, lootLevel=${player.lootLevel}, HP ${beforeHP}/${beforeMaxHP}→${player.health}/${player.healthMax}, Speed ${beforeSpeed.toFixed(0)}→${player.speed.toFixed(0)}`);
                }
                
                if (created.length > 0) io.to(roomId).emit('inventoryDropped', { items: created });
                break;
            }
        },
        
        inventoryPickupRequest: (socket, data) => {
            // data: { id }
            const id = data && data.id;
            if (!id) return;
            for (const [roomId, room] of rooms) {
                if (!room.players.has(socket.id)) continue;
                const item = room.groundItems.get(id);
                if (!item) break;
                
                const player = room.players.get(socket.id);
                if (!player) break;
                
                // Handle currency pickups (ducats and blood markers)
                if (item.type === 'ducat') {
                    // Add ducats to player wallet
                    player.ducats = (player.ducats || 0) + (item.amount || 1);
                    
                    // Remove from ground and broadcast
                    room.groundItems.delete(id);
                    io.to(roomId).emit('currencyPickedUp', { 
                        id, 
                        playerId: socket.id, 
                        type: 'ducat', 
                        amount: item.amount,
                        newTotal: player.ducats
                    });
                    break;
                }
                
                if (item.type === 'bloodMarker') {
                    // Add blood markers to player wallet (capped at bloodMarkerCap, default 20)
                    const cap = player.bloodMarkerCap || 20;
                    const beforePickup = player.bloodMarkers || 0;
                    player.bloodMarkers = Math.min(beforePickup + (item.amount || 1), cap);
                    
                    // Remove from ground and broadcast
                    room.groundItems.delete(id);
                    io.to(roomId).emit('currencyPickedUp', { 
                        id, 
                        playerId: socket.id, 
                        type: 'bloodMarker', 
                        amount: item.amount,
                        newTotal: player.bloodMarkers
                    });
                    break;
                }
                
                // Handle inventory items (HexStat pickups)
                // Check inventory space (max 6 items)
                if (!Array.isArray(player.inventory)) player.inventory = [];
                if (player.inventory.length >= 6) {
                    console.log(`[Server] Player ${socket.id} inventory full, cannot pick up item ${id}`);
                    break;
                }
                
                // Add item to server-side inventory
                const inventoryItem = {
                    statKey: item.statKey,
                    bonusValue: item.bonusValue,
                    isPercent: item.isPercent,
                    label: item.label,
                    rarity: item.rarity,
                    rarityName: item.rarityName
                };
                player.inventory.push(inventoryItem);
                
                // Update loot level to match inventory size
                player.lootLevel = player.inventory.length;
                
                console.log(`[Server] Player ${socket.id} picked up ${item.label} (${item.statKey}: ${item.bonusValue}${item.isPercent ? '%' : ''})`);
                console.log(`[Server] Player ${socket.id} inventory before recalc: HP=${player.health}/${player.healthMax}, items=${player.inventory.length}, lootLevel=${player.lootLevel}`);
                
                // Recalculate player stats based on new inventory
                room.recalculatePlayerStats(player);
                
                console.log(`[Server] Player ${socket.id} inventory after recalc: HP=${player.health}/${player.healthMax}`);
                
                // Remove from ground and broadcast to all clients
                room.groundItems.delete(id);
                io.to(roomId).emit('inventoryPickedUp', { id, playerId: socket.id });
                
                console.log(`[Server] Player ${socket.id} inventory: ${player.inventory.length}/6 items`);
                break;
            }
        },
        
        artifactPickupRequest: (socket, data) => {
            const chestId = data && data.chestId;
            if (!chestId) return;
            for (const [roomId, room] of rooms) {
                if (!room.players.has(socket.id)) continue;
                const chest = room.chests.get(chestId);
                if (!chest || !chest.opened || chest.variant === 'brown' || chest.variant === 'startGear') break;
                if (chest.artifactCarriedBy) break; // already taken
                // Accept pickup request
                chest.artifactCarriedBy = socket.id;
                
                // Clear zone entry tracking for return trip horde spawning
                if (room.zoneSpawner) {
                    if (room.zoneSpawner.enteredZones) {
                        room.zoneSpawner.enteredZones.clear();
                    }
                    if (room.zoneSpawner._currentlyOccupied) {
                        room.zoneSpawner._currentlyOccupied.clear();
                    }
                    console.log('[Server] Artifact picked up - cleared zone entries for return trip horde spawns');
                }
                
                // Compute extraction zone and boss spawn positions server-authoritatively
                const spawns = room._computeExtractionAndBossSpawns();
                
                // Broadcast pickup and spawn data to everyone in room
                io.to(roomId).emit('artifactPickedUp', { 
                    chestId: chest.id, 
                    playerId: socket.id,
                    extractionZone: spawns ? spawns.extractionZone : null,
                    bossSpawn: spawns ? spawns.bossSpawn : null,
                    hereticExtractionZone: spawns ? spawns.hereticExtractionZone : null
                });
                console.log('[Server] Artifact picked up, sent extraction and boss spawn data to room', roomId);
                break;
            }
        },
        
        artifactDropRequest: (socket, data) => {
            const chestId = data && data.chestId;
            if (!chestId) return;
            const x = Number(data.x), y = Number(data.y);
            const vx = Number.isFinite(data.vx) ? data.vx : 0;
            const vy = Number.isFinite(data.vy) ? data.vy : 0;
            for (const [roomId, room] of rooms) {
                if (!room.players.has(socket.id)) continue;
                const p = room.players.get(socket.id);
                const fallbackX = p ? Number(p.x) : 0;
                const fallbackY = p ? Number(p.y) : 0;
                const chest = room.chests.get(chestId);
                if (!chest || !chest.opened || chest.variant === 'brown' || chest.variant === 'startGear') break;
                if (chest.artifactCarriedBy !== socket.id) break; // only carrier can drop
                chest.artifactCarriedBy = null;
                const safe = _findClearArtifactDropPosition(room, x, y, fallbackX, fallbackY, 16);
                chest.artifactPos = { x: safe.x, y: safe.y };
                
                // Reset extraction timer when artifact is dropped
                if (room.extractionTimer.started && !room.extractionTimer.extracted) {
                    console.log(`[Server] Artifact dropped - resetting extraction timer in room ${roomId}`);
                    room.extractionTimer.started = false;
                    room.extractionTimer.extracted = false;
                    room.extractionTimer.timeLeft = 0;
                    room.extractionTimer.startedBy = null;
                    room.emitExtractionTimerState();
                }
                
                io.to(roomId).emit('artifactDropped', { chestId: chest.id, x: chest.artifactPos.x, y: chest.artifactPos.y, vx, vy, health: chest.health, healthMax: chest.healthMax });
                break;
            }
        },
        
        batteryPickupRequest: (socket, data) => {
            const batteryId = data && data.batteryId;
            if (!batteryId) return;
            for (const [roomId, room] of rooms) {
                if (!room.players.has(socket.id)) continue;
                if (!room.batteries) continue;
                const battery = room.batteries.get(batteryId);
                if (!battery) break;
                if (battery.carriedBy) break; // already carried
                if (battery.slotIndex !== null) break; // already placed
                
                // Accept pickup
                battery.carriedBy = socket.id;
                battery.onGround = false;
                
                io.to(roomId).emit('batteryPickedUp', {
                    batteryId: batteryId,
                    playerId: socket.id
                });
                console.log(`[Server] Battery ${batteryId} picked up by player ${socket.id}`);
                break;
            }
        },
        
        batteryDropRequest: (socket, data) => {
            const batteryId = data && data.batteryId;
            if (!batteryId) return;
            const x = Number(data.x), y = Number(data.y);
            for (const [roomId, room] of rooms) {
                if (!room.players.has(socket.id)) continue;
                if (!room.batteries) continue;
                const battery = room.batteries.get(batteryId);
                if (!battery) break;
                if (battery.carriedBy !== socket.id) break; // only carrier can drop
                
                battery.carriedBy = null;
                battery.x = x;
                battery.y = y;
                battery.onGround = true;
                
                io.to(roomId).emit('batteryDropped', {
                    batteryId: batteryId,
                    x: x,
                    y: y
                });
                console.log(`[Server] Battery ${batteryId} dropped at (${x}, ${y})`);
                break;
            }
        },
        
        batteryPlaceRequest: (socket, data) => {
            const batteryId = data && data.batteryId;
            const slotIndex = Number(data.slotIndex);
            if (!batteryId || !Number.isFinite(slotIndex) || slotIndex < 0 || slotIndex > 2) return;
            
            for (const [roomId, room] of rooms) {
                if (!room.players.has(socket.id)) continue;
                if (!room.batteries || !room.batteryStation) continue;
                const battery = room.batteries.get(batteryId);
                if (!battery) break;
                if (battery.carriedBy !== socket.id) break; // must be carrying it
                if (room.batteryStation.slots[slotIndex]) break; // slot already filled
                
                // Place battery in slot
                battery.carriedBy = null;
                battery.slotIndex = slotIndex;
                battery.onGround = false;
                room.batteryStation.slots[slotIndex] = true;
                
                // Check if all slots are now filled
                const isPowered = room.batteryStation.slots[0] && 
                                  room.batteryStation.slots[1] && 
                                  room.batteryStation.slots[2];
                room.batteryStation.isPowered = isPowered;
                
                io.to(roomId).emit('batteryPlaced', {
                    batteryId: batteryId,
                    slotIndex: slotIndex,
                    isPowered: isPowered
                });
                console.log(`[Server] Battery ${batteryId} placed in slot ${slotIndex}, powered: ${isPowered}`);
                
                if (isPowered) {
                    // Mark Radio Tower accomplishment for VP rewards
                    room.missionAccomplishments.radioTowerPowered = true;
                    console.log('[Server] Radio Tower powered - accomplishment marked');
                    
                    // Calculate bonus time for artillery timer
                    const ARTILLERY_DURATION_MS = 9 * 60 * 1000; // 9 minutes
                    const currentElapsed = Date.now() - room.levelStartTime - room.artilleryBonusTimeMs;
                    const wasOvertime = currentElapsed >= ARTILLERY_DURATION_MS;
                    
                    let bonusAdded = 0;
                    if (wasOvertime) {
                        // Already in overtime (red) - reset to 1 minute remaining on client display
                        // Client displays 9 minutes countdown, so for 1 minute remaining, elapsed must be 8 minutes
                        const CLIENT_DISPLAY_DURATION_MS = 9 * 60 * 1000; // 9 minutes - matches client's initialDuration
                        const newElapsed = CLIENT_DISPLAY_DURATION_MS - (1 * 60 * 1000); // 8 minutes elapsed = 1 minute shown
                        room.artilleryBonusTimeMs = (Date.now() - room.levelStartTime) - newElapsed;
                        bonusAdded = 60; // Show "+1:00" to indicate 1 minute reprieve
                        console.log(`[Server] Artillery was in overtime - reset to 1:00 remaining`);
                    } else {
                        // Normal countdown - add 2.5 minutes
                        room.artilleryBonusTimeMs += 2.5 * 60 * 1000; // 150000ms
                        bonusAdded = 150; // 2.5 minutes in seconds
                        console.log(`[Server] Artillery bonus +2:30 added, total bonus: ${room.artilleryBonusTimeMs}ms`);
                    }
                    
                    io.to(roomId).emit('batteryStationPowered', {
                        bonusSeconds: bonusAdded,
                        wasOvertime: wasOvertime
                    });
                    console.log(`[Server] Battery station is now POWERED in room ${roomId}`);
                }
                break;
            }
        }
    };
};
