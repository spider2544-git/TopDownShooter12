/**
 * Mode Handlers - Phase 5
 * 
 * Handles scene changes, level type, ready/extraction timers
 * Extracted from server.js to improve modularity
 * 
 * Handlers:
 * - sceneChange: Handles lobby ↔ level transitions (~110 lines)
 * - setLevelType: Sets level/game mode type (~10 lines)
 * - readyTimerStart: Starts mission ready timer (~12 lines)
 * - readyTimerCancel: Cancels mission ready timer (~10 lines)
 * - extractionTimerStart: Starts extraction timer (~11 lines)
 * - extractionTimerCancel: Cancels extraction timer (~10 lines)
 */

module.exports = function createModeHandlers({ io, rooms, Protocol }) {
    return {
        /**
         * sceneChange - Handles scene transitions (lobby ↔ level)
         * Most complex mode handler - manages environment recreation, player repositioning,
         * enemy authority, shop refresh, evil state clearing, breadcrumb trails
         */
        sceneChange: (socket, data) => {
            console.log(`[Server] Player ${socket.id} changing scene to ${data.scene}`);
            
            // Find which room this player is in
            for (const [roomId, room] of rooms) {
                if (room.players.has(socket.id)) {
                    if (data.boundary) {
                        room.boundary = data.boundary;
                    }
                    
                    if (data.scene && data.scene !== room.scene) {
                        // If returning to lobby after extraction, use full reset
                        if (data.scene === 'lobby' && room.extractionTimer.extracted) {
                            console.log('[Server] Extraction completed, performing full room reset to lobby');
                            room.resetToLobby();
                            break; // resetToLobby handles broadcasting, no need to continue
                        }
                        
                        room.scene = data.scene;
                        // Recreate environment for the new scene
                        console.log(`[Server] Recreating environment for scene change to "${room.scene}"`);
                        room.environment = room._createEnvironmentForScene(room.scene);
                        console.log(`[Server] Environment recreated with ${room.environment.obstacles.length} obstacles`);
                        
                        // Reset or compute level spawns depending on scene
                        if (room.scene === 'level') {
                            room.levelSpawns = room._computeLevelSpawns();
                            // Clear all player breadcrumbs when starting a new level
                            for (const [id, player] of room.players) {
                                player.breadcrumbs = [];
                                player.totalDistanceMoved = 0;
                                player.lastBreadcrumbX = player.x;
                                player.lastBreadcrumbY = player.y;
                            }
                        } else {
                            room.levelSpawns = null;
                        }
                    }
                    
                    console.log(`[Server] Room ${roomId} updated: scene=${room.scene}, boundary=${room.boundary}`);
                    
                    // When returning to lobby, reposition all players near the ready zone (0, 0) with spacing
                    if (room.scene === 'lobby') {
                        console.log(`[Server] Repositioning players near ready zone in lobby`);
                        
                        // Refresh shop when first player returns to lobby from mission
                        room.markShopForRefresh();
                        console.log('[SHOP] Marked shop for refresh (returned to lobby from mission)');
                        
                        const players = Array.from(room.players.values());
                        const readyZoneX = 0;
                        const readyZoneY = 0;
                        const spawnRadius = 200; // Spawn within 200 units of ready zone
                        
                        players.forEach((p, index) => {
                            // Arrange players in a circle around the ready zone
                            const angle = (index / players.length) * Math.PI * 2;
                            const dist = 100 + Math.random() * 100; // 100-200 units from center
                            p.x = readyZoneX + Math.cos(angle) * dist;
                            p.y = readyZoneY + Math.sin(angle) * dist;
                            console.log(`[Server] Repositioned player ${p.id} to (${p.x.toFixed(1)}, ${p.y.toFixed(1)})`);
                            
                            // Clear evil state when returning to lobby
                            if (p.isEvil) {
                                p.isEvil = false;
                                console.log(`[Server] Cleared evil state for player ${p.id}`);
                                // Broadcast evil state reset to all players
                                io.to(roomId).emit('playerEvilState', { 
                                    playerId: p.id, 
                                    isEvil: false 
                                });
                            }
                            
                            // Clear breadcrumb trail when returning to lobby
                            p.breadcrumbs = [];
                            p.totalDistanceMoved = 0;
                            p.lastBreadcrumbX = p.x;
                            p.lastBreadcrumbY = p.y;
                        });
                    }
                    
                    // Filter orientedBoxes for client sync (exclude sandbag collision boxes)
                    const clientOrientedBoxes = (room.environment.orientedBoxes || []).filter(box => {
                        return box.fill || box.stroke || box._abilityId;
                    });
                    
                    // Broadcast scene change to all players in the room (including sender) with obstacle data
                    io.to(roomId).emit('sceneChange', {
                        scene: data.scene,
                        boundary: room.boundary, // Use room's boundary (server-authoritative)
                        fromPlayer: socket.id,
                        obstacles: room.environment.obstacles,  // Send server-authoritative obstacle data
                        orientedBoxes: clientOrientedBoxes,
                        levelSpawns: room.levelSpawns,
                        // Navmesh debug overlay (Trench Raid) - sent so late joiners still receive it
                        navMeshDebug: (room._navDebug && room.levelType === 'trenchraid') ? { 
                            levelType: 'trenchraid', 
                            seed: room.worldSeed, 
                            nav: room._navDebug 
                        } : null
                    });
                    
                    // If entering level via client-triggered scene change, enable enemy authority
                    if (room.scene === 'level') {
                        room.enemyNetMode = 'authoritative';
                        room._nextEnemyBroadcastTime = Date.now();
                    } else {
                        room.enemyNetMode = 'spawnOnly';
                    }
                    console.log(`[Server] Broadcasting scene change to all players in room ${roomId}: ${data.scene}`);

                    // Lobby training dummies should always exist in the lobby, including when returning from a level.
                    // IMPORTANT: Spawn AFTER sceneChange so clients have already transitioned & cleared old enemies.
                    if (room.scene === 'lobby') {
                        try { 
                            room.spawnLobbyTargetDummy(5); 
                        } catch(_) {}
                    }
                    break;
                }
            }
        },

        /**
         * setLevelType - Sets the level/game mode type for the room
         */
        setLevelType: (socket, data) => {
            const levelType = data.levelType || 'extraction';
            console.log(`[Server] Player ${socket.id} requesting to set level type: ${levelType}`);
            
            // Find which room this player is in and set level type
            for (const [roomId, room] of rooms) {
                if (room.players.has(socket.id)) {
                    room.setLevelType(socket.id, levelType);
                    break;
                }
            }
        },

        /**
         * readyTimerStart - Starts the mission ready countdown timer
         */
        readyTimerStart: (socket, data) => {
            // Use the room's server-authoritative level type, not client data
            console.log(`[Server] Player ${socket.id} requesting to start ready timer`);
            
            // Find which room this player is in
            for (const [roomId, room] of rooms) {
                if (room.players.has(socket.id)) {
                    // Use server's level type, not client's
                    room.startReadyTimer(socket.id, room.levelType);
                    console.log(`[Server] Starting ready timer with server-authoritative level: ${room.levelType}`);
                    break;
                }
            }
        },

        /**
         * readyTimerCancel - Cancels the mission ready countdown timer
         */
        readyTimerCancel: (socket, data) => {
            console.log(`[Server] Player ${socket.id} requesting to cancel ready timer`);
            
            // Find which room this player is in
            for (const [roomId, room] of rooms) {
                if (room.players.has(socket.id)) {
                    room.cancelReadyTimer();
                    break;
                }
            }
        },

        /**
         * extractionTimerStart - Starts the extraction countdown timer
         */
        extractionTimerStart: (socket, data) => {
            const timerType = data?.type || 'normal';
            console.log(`[Server] Player ${socket.id} requesting to start ${timerType} extraction timer`);
            
            // Find which room this player is in
            for (const [roomId, room] of rooms) {
                if (room.players.has(socket.id)) {
                    room.startExtractionTimer(socket.id, timerType);
                    break;
                }
            }
        },

        /**
         * extractionTimerCancel - Cancels the extraction countdown timer
         */
        extractionTimerCancel: (socket, data) => {
            console.log(`[Server] Player ${socket.id} requesting to cancel extraction timer`);
            
            // Find which room this player is in
            for (const [roomId, room] of rooms) {
                if (room.players.has(socket.id)) {
                    room.cancelExtractionTimer();
                    break;
                }
            }
        }
    };
};
