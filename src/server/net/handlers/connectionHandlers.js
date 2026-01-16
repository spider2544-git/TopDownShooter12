/**
 * Connection Handlers - Phase 8
 * 
 * Handles player connections, room joining, disconnections, NFC unlocks
 * Extracted from server.js to improve modularity
 * 
 * Handlers:
 * - joinRoom: Massive handler for player joining rooms (~104 lines)
 * - disconnect: Player disconnection cleanup (~12 lines)
 * - requestNfcUnlock: NFC weapon unlock requests (~3 lines)
 * 
 * Note: joinRoom handler must be imported from GameRoom class
 */

module.exports = function createConnectionHandlers({ io, rooms, Protocol, serverDebugger, nfcTagManager, GameRoom }) {
    return {
        /**
         * requestNfcUnlock - Handles NFC weapon unlock requests
         * Delegates to nfcTagManager
         */
        requestNfcUnlock: (socket, data) => {
            nfcTagManager.handleUnlockRequest(socket, data);
        },

        /**
         * joinRoom - Massive handler for player joining rooms
         * Handles room creation, player addition, late joiner state sync
         */
        joinRoom: (socket, data) => {
            const roomId = data.roomId || 'default';
            const playerData = data.playerData || {};
            
            console.log(`[Server] Player ${socket.id} attempting to join room ${roomId}`);
            
            // Leave any existing rooms
            socket.rooms.forEach(room => {
                if (room !== socket.id) {
                    socket.leave(room);
                }
            });
            
            // Join the new room
            socket.join(roomId);
            
            // Get or create room
            if (!rooms.has(roomId)) {
                const newRoom = new GameRoom(roomId);
                newRoom.io = io;  // Store io reference for game modes to use
                rooms.set(roomId, newRoom);
            }
            
            const room = rooms.get(roomId);
            // Ensure io is set (for rooms created before this fix)
            if (!room.io) room.io = io;
            
            // Refresh shop if this is the first player joining lobby
            const wasEmpty = room.players.size === 0;
            room.addPlayer(socket, playerData);
            
            if (wasEmpty && room.scene === 'lobby') {
                room.markShopForRefresh();
                console.log('[SHOP] Marked shop for refresh (first player joined lobby)');
            }
            
            console.log(`[Server] Player ${socket.id} successfully joined room ${roomId}`);
            // DEBUG: Check chest data for late joiners (console.error always visible)
            console.error(`[DEBUG] Room has ${room.chests.size} chests, levelSpawns: ${room.levelSpawns ? `${room.levelSpawns.chests?.length || 0} spawns` : 'null'}`);

            // Send existing chest states to late joiner
            for (const chest of room.chests.values()) {
                if (chest.opening && !chest.opened) {
                    socket.emit('chestTimerUpdate', { id: chest.id, x: chest.x, y: chest.y, variant: chest.variant, started: true, timeLeft: chest.timeLeft, timeTotal: chest.timeTotal, startedBy: chest.startedBy, health: chest.health, healthMax: chest.healthMax });
                } else if (chest.opened) {
                    if (chest.variant === 'brown' || chest.variant === 'startGear') {
                        // For late joiners, reconstruct groundItems array from persisted ground items
                        // Only include items that still exist (not yet picked up)
                        const groundItems = [];
                        for (const [itemId, item] of room.groundItems) {
                            if (itemId.startsWith(`chest_${chest.id}_`)) {
                                groundItems.push(item);
                            }
                        }
                        socket.emit('chestOpened', { id: chest.id, x: chest.x, y: chest.y, variant: chest.variant, drops: chest.drops, groundItems: groundItems });
                    } else {
                        // If artifact is currently being carried, don't spawn it for late joiner; instead inform pickup state
                        if (chest.artifactCarriedBy) {
                            socket.emit('chestOpened', { id: chest.id, x: chest.x, y: chest.y, variant: chest.variant, health: chest.health, healthMax: chest.healthMax });
                            socket.emit('artifactPickedUp', { 
                                chestId: chest.id, 
                                playerId: chest.artifactCarriedBy,
                                extractionZone: room.extractionZone,
                                bossSpawn: room.bossSpawn,
                                hereticExtractionZone: room.hereticExtractionZone
                            });
                        } else {
                            socket.emit('chestOpened', { id: chest.id, x: chest.x, y: chest.y, variant: chest.variant, artifact: { vx: 160, vy: -220 }, health: chest.health, healthMax: chest.healthMax });
                        }
                    }
                } else if (chest.variant === 'gold' && chest.health !== undefined) {
                    // Send health update for unopened gold chests (so late joiners see correct health)
                    socket.emit('chestHealthUpdate', {
                        chestId: chest.id,
                        health: chest.health,
                        healthMax: chest.healthMax
                    });
                }
                // Note: Unopened chests are sent via levelSpawns in roomSnapshot (called by addPlayer above)
            }
            
            // Send battery system state to late joiners (trench raid mode)
            if (room.batteries && room.batteryStation) {
                // Send battery station state
                socket.emit('batteryStationState', {
                    x: room.batteryStation.x,
                    y: room.batteryStation.y,
                    radioTowerX: room.batteryStation.radioTowerX,
                    radioTowerY: room.batteryStation.radioTowerY,
                    slots: room.batteryStation.slots,
                    isPowered: room.batteryStation.isPowered
                });
                
                // Send individual battery states
                for (const [batteryId, battery] of room.batteries) {
                    socket.emit('batteryState', {
                        id: battery.id,
                        x: battery.x,
                        y: battery.y,
                        carriedBy: battery.carriedBy,
                        slotIndex: battery.slotIndex,
                        onGround: battery.onGround
                    });
                }
                console.log(`[BatterySystem] Sent battery state to late joiner ${socket.id}`);
            }
        },

        /**
         * disconnect - Handles player disconnection
         * Removes player from rooms and notifies debugger
         */
        disconnect: (socket) => {
            console.log(`Client disconnected: ${socket.id}`);
            serverDebugger.playerDisconnect(socket.id, 'unknown', 'client disconnect');
            
            // Remove player from all rooms
            for (const [roomId, room] of rooms) {
                if (room.players.has(socket.id)) {
                    room.removePlayer(socket.id);
                    break;
                }
            }
        }
    };
};
