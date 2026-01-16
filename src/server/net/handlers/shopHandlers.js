/**
 * Shop Handlers - Phase 7
 * 
 * Handles shop inventory requests, purchases, and quartermaster requisitions
 * Extracted from server.js to improve modularity
 * 
 * Handlers:
 * - requestShopInventory: Fetches shop inventory for player (~16 lines)
 * - purchaseShopItem: Handles shop item purchases (~42 lines)
 * - quartermasterRequisition: Handles quartermaster supply grants (~122 lines)
 */

module.exports = function createShopHandlers({ io, rooms, Protocol }) {
    return {
        /**
         * requestShopInventory - Fetches shop inventory for requesting player
         * Refreshes shop if needed (first join or after mission)
         */
        requestShopInventory: (socket) => {
            try {
                // Find the room this player is in
                for (const [roomId, room] of rooms) {
                    if (room.players.has(socket.id)) {
                        // Refresh shop if needed (first player join or after mission)
                        const inventory = room.getShopInventory();
                        socket.emit('shopInventory', { items: inventory });
                        console.log(`[SHOP] Sent inventory to player ${socket.id.substring(0, 8)}`);
                        break;
                    }
                }
            } catch (err) {
                console.error('[SHOP] Error sending inventory:', err);
            }
        },

        /**
         * purchaseShopItem - Handles shop item purchase requests
         * Server-authoritative purchase validation (ducats, inventory space, etc.)
         */
        purchaseShopItem: (socket, data) => {
            try {
                const { index } = data;
                
                // Find the room this player is in
                for (const [roomId, room] of rooms) {
                    if (room.players.has(socket.id)) {
                        const result = room.purchaseShopItem(socket.id, index);
                        
                        if (result.success) {
                            // Send success result to buyer
                            socket.emit('purchaseResult', {
                                success: true,
                                item: result.item,
                                newDucats: result.newDucats,
                                newInventory: result.newInventory
                            });
                            
                            // Broadcast updated shop inventory to all players in room
                            io.to(roomId).emit('shopInventory', { items: room.shopInventory });
                            
                            console.log(`[SHOP] Purchase successful for player ${socket.id.substring(0, 8)}`);
                        } else {
                            // Send failure result
                            socket.emit('purchaseResult', {
                                success: false,
                                reason: result.reason
                            });
                            
                            console.log(`[SHOP] Purchase failed for player ${socket.id.substring(0, 8)}: ${result.reason}`);
                        }
                        break;
                    }
                }
            } catch (err) {
                console.error('[SHOP] Error processing purchase:', err);
                socket.emit('purchaseResult', {
                    success: false,
                    reason: 'Server error'
                });
            }
        },

        /**
         * quartermasterRequisition - Handles quartermaster supply grants
         * Grants 10 blood markers + (one-time) 1 Common loot + 30 ducats
         * Server-authoritative with cooldown, proximity, and anti-spam checks
         */
        quartermasterRequisition: (socket, data = {}) => {
            try {
                for (const [roomId, room] of rooms) {
                    if (!room.players.has(socket.id)) continue;
                    if (!room || room.scene !== 'lobby') break;

                    const player = room.players.get(socket.id);
                    if (!player) break;

                    // Simple anti-spam cooldown per player
                    const now = Date.now();
                    if (!room._qmLastGrant) room._qmLastGrant = new Map();
                    const last = room._qmLastGrant.get(socket.id) || 0;
                    if (now - last < 1200) {
                        socket.emit('quartermasterReward', { success: false, reason: 'cooldown' });
                        break;
                    }
                    room._qmLastGrant.set(socket.id, now);

                    // Validate proximity to Quartermaster spawn (near bottom of training lane sandbags)
                    const qmX = -307;
                    const qmY = -534;
                    const dx = (player.x || 0) - qmX;
                    const dy = (player.y || 0) - qmY;
                    const maxDist = 220;
                    if (dx * dx + dy * dy > maxDist * maxDist) {
                        socket.emit('quartermasterReward', { success: false, reason: 'too_far' });
                        break;
                    }

                    const cap = player.bloodMarkerCap || 20;
                    const bloodBefore = player.bloodMarkers || 0;
                    // Always allow blood markers from Quartermaster (capped)
                    player.bloodMarkers = Math.min(bloodBefore + 10, cap);

                    const action = String(data.action || '').toLowerCase();
                    const alreadyGranted = !!player._qmGrantedSupplies;
                    const wantsLoot = (action === 'grant_supplies');
                    const canGrantLoot = wantsLoot && !alreadyGranted;

                    // Only allow loot + ducats ONCE per player.
                    if (canGrantLoot) {
                        // Currency grant (ducats only on first requisition)
                        const ducatsBefore = player.ducats || 0;
                        player.ducats = ducatsBefore + 30;
                    }

                    // Loot grant (Common / white)
                    const labels = ['+MovSpd', '+AtkSpd', '+AtkPwr', '+Armor', '+HP', '+Stm', '+CritChan', '+CritDmg'];
                    const lab = labels[Math.floor(Math.random() * labels.length)];
                    const rarity = { name: 'Common', color: '#ffffff' };
                    const statData = (typeof room._computeStatBonus === 'function')
                        ? room._computeStatBonus(lab, rarity.name)
                        : { statKey: null, value: 0, isPercent: false };

                    if (!Array.isArray(player.inventory)) player.inventory = [];

                    let dropped = null;
                    if (canGrantLoot) {
                        // Mark as granted before returning (prevents re-entrancy granting twice)
                        player._qmGrantedSupplies = true;

                        if (player.inventory.length >= 6) {
                            // Inventory full: spawn as server-tracked ground item (pickup with E)
                            const itemId = `qm_${roomId}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
                            const ang = Math.random() * Math.PI * 2;
                            const pos = (typeof room.findClearGroundPosition === 'function')
                                ? room.findClearGroundPosition(qmX, qmY, ang, 12, 40)
                                : { x: qmX, y: qmY };
                            const spd = 140 + Math.random() * 70;
                            const groundItem = {
                                id: itemId,
                                x: pos.x,
                                y: pos.y,
                                vx: Math.cos(ang) * spd,
                                vy: Math.sin(ang) * spd,
                                label: lab,
                                rarityName: rarity.name,
                                color: rarity.color,
                                rarity,
                                statKey: statData.statKey,
                                bonusValue: statData.value,
                                isPercent: statData.isPercent
                            };
                            try { room.groundItems.set(itemId, groundItem); } catch(_) {}
                            io.to(roomId).emit('inventoryDropped', { items: [groundItem] });
                            dropped = groundItem;
                        } else {
                            const inventoryItem = {
                                type: 'HexStat',
                                label: lab,
                                rarityName: rarity.name,
                                color: rarity.color,
                                rarity,
                                statKey: statData.statKey,
                                bonusValue: statData.value,
                                isPercent: statData.isPercent
                            };
                            player.inventory.push(inventoryItem);
                            // Keep lootLevel in sync with inventory size
                            player.lootLevel = player.inventory.length;
                            // Recalculate derived stats server-authoritatively
                            try { if (typeof room.recalculatePlayerStats === 'function') room.recalculatePlayerStats(player); } catch(_) {}
                        }
                    }

                    socket.emit('quartermasterReward', {
                        success: true,
                        newDucats: player.ducats,
                        newBloodMarkers: player.bloodMarkers,
                        newLootLevel: player.lootLevel || (player.inventory ? player.inventory.length : 0),
                        newInventory: player.inventory,
                        dropped,
                        mode: canGrantLoot ? 'first' : 'repeat'
                    });
                    break;
                }
            } catch (e) {
                console.error('[Quartermaster] Error granting requisition:', e);
                try { socket.emit('quartermasterReward', { success: false, reason: 'server_error' }); } catch(_) {}
            }
        }
    };
};
