/**
 * Debug Handlers - Phase 8
 * 
 * Handles debug commands, VFX, horde spawning
 * Extracted from server.js to improve modularity
 * 
 * Handlers:
 * - debugSpawnHorde: Spawns debug hordes via H key (~55 lines)
 * - debugSetValue: Sets debug values for testing (~40 lines)
 * - vfxCreated: Broadcasts VFX to other players (~13 lines)
 */

module.exports = function createDebugHandlers({ io, rooms, Protocol }) {
    return {
        /**
         * debugSpawnHorde - Spawns debug hordes for testing
         * Supports difficulty presets and manual enemy counts
         */
        debugSpawnHorde: (socket, data = {}) => {
            let targetRoomId = null;
            let targetRoom = null;
            for (const [roomId, room] of rooms) {
                if (room.players.has(socket.id)) {
                    targetRoomId = roomId;
                    targetRoom = room;
                    break;
                }
            }

            if (!targetRoom) {
                console.warn('[Server Debug] Player not in any room for horde spawn');
                return;
            }

            if (targetRoom.scene !== 'level') {
                console.warn('[Server Debug] Horde spawn requested outside level scene - ignoring');
                return;
            }

            // Support both old enemyCount and new difficulty system
            let options = typeof data.options === 'object' && data.options ? data.options : {};
            
            // Manual H-key spawns target the requesting player specifically
            const requestingPlayer = targetRoom.players.get(socket.id);
            if (requestingPlayer && targetRoom.hordeSpawner) {
                const targetInfo = targetRoom.hordeSpawner._getTargetInfoForPlayer(requestingPlayer);
                options._targetInfo = targetInfo;
                console.log(`[Server Debug] Targeting requesting player ${socket.id.substring(0, 8)} at (${requestingPlayer.x?.toFixed(1)}, ${requestingPlayer.y?.toFixed(1)})`);
            }
            
            if (data.difficulty) {
                // Use difficulty preset
                const preset = targetRoom.hordeSpawner.config.DIFFICULTY_PRESETS[data.difficulty];
                if (preset) {
                    console.log('[Server Debug] Spawning difficulty', data.difficulty, 'horde for room', targetRoomId, 'requested by', socket.id.substring(0, 8));
                    options.typeRatios = preset.typeRatios;
                    options.minRadius = preset.spawnRadius.min;
                    options.maxRadius = preset.spawnRadius.max;
                    options.escortRadius = preset.escortRadius;
                    targetRoom.spawnHorde(preset.size, options);
                } else {
                    console.warn('[Server Debug] Invalid difficulty', data.difficulty);
                }
            } else {
                // Use legacy enemyCount
                const enemyCount = Number.isFinite(data.enemyCount) ? data.enemyCount : 12;
                console.log('[Server Debug] Spawning horde for room', targetRoomId, 'requested by', socket.id.substring(0, 8), {
                    enemyCount,
                    options
                });
                targetRoom.spawnHorde(enemyCount, options);
            }
        },

        /**
         * debugSetValue - Sets player values for testing
         * Only allows certain safe properties (ducats, bloodMarkers, etc.)
         */
        debugSetValue: (socket, data) => {
            console.log('[Server Debug] Received debugSetValue:', data, 'from', socket.id);
            
            if (!data || !data.key) {
                console.log('[Server Debug] Invalid data, ignoring');
                return;
            }
            
            let foundRoom = false;
            for (const [roomId, room] of rooms) {
                if (!room.players.has(socket.id)) continue;
                
                foundRoom = true;
                const player = room.players.get(socket.id);
                if (!player) {
                    console.log('[Server Debug] Player not found in room');
                    break;
                }
                
                // Only allow certain safe properties to be set
                const allowedKeys = ['ducats', 'bloodMarkers', 'victoryPoints', 'health', 'stamina'];
                if (allowedKeys.includes(data.key)) {
                    const oldValue = player[data.key];
                    player[data.key] = Number(data.value) || 0;
                    console.log(`[Server Debug] Set ${socket.id.substring(0,8)}.${data.key}: ${oldValue} → ${player[data.key]}`);
                    
                    // Broadcast the change immediately
                    console.log('[Server Debug] Broadcasting game state...');
                    room.broadcastGameState();
                    console.log('[Server Debug] Broadcast complete');
                } else {
                    console.log('[Server Debug] Key not allowed:', data.key);
                }
                break;
            }
            
            if (!foundRoom) {
                console.log('[Server Debug] Player not in any room');
            }
        },

        /**
         * vfxCreated - Broadcasts VFX to other players in room
         * Excludes sender to avoid double VFX rendering
         */
        vfxCreated: (socket, data) => {
            // Find which room this player is in and broadcast VFX to all other players
            for (const [roomId, room] of rooms) {
                if (room.players.has(socket.id)) {
                    // Broadcast to all players in room except the sender
                    socket.to(roomId).emit('vfxCreated', {
                        ...data,
                        playerId: socket.id
                    });
                    break;
                }
            }
        }
    };
};
