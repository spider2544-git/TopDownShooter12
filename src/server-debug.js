// Server-side debug system for Node.js
// Default OFF to prevent log spam impacting perf/diagnosis.
// Enable with env: SERVER_DEBUG=1
const DEBUG_ENABLED = process.env.SERVER_DEBUG === '1';

const DEBUG_LEVELS = {
    ERROR: 0,
    WARN: 1,
    INFO: 2,
    DEBUG: 3,
    VERBOSE: 4
};

const CURRENT_DEBUG_LEVEL = DEBUG_LEVELS.DEBUG;

const DEBUG_CATEGORIES = {
    NETWORKING: true,
    PLAYERS: true,
    ENEMIES: true,
    COMBAT: true,
    MOVEMENT: true, // Enable for teleportation debugging
    COLLISION: true, // Track collision detection events  
    POSITION_SYNC: false, // Track client-server position synchronization
    SERVER: true,
    SYNC: true,
    SERVER_TICK: false,
    NETWORK_STATS: false,
    ROOMS: true,
    INVENTORY: true,
    GAMEFLOW: true,
    ECONOMY: true,
    WEAPONS: true,
    BOSSES: true
};

class ServerDebugger {
    constructor() {
        this.enabled = DEBUG_ENABLED;
        this.level = CURRENT_DEBUG_LEVEL;
        this.categories = DEBUG_CATEGORIES;
        this.counters = {
            connections: 0,
            disconnections: 0,
            roomsCreated: 0,
            inputMessages: 0,
            stateUpdates: 0,
            errors: 0,
            inventoryChanges: 0,
            equipmentChanges: 0,
            statusEffects: 0,
            sceneTransitions: 0,
            gameModeChanges: 0,
            extractionEvents: 0,
            chestOpenings: 0,
            itemGenerations: 0,
            weaponActions: 0,
            bossEvents: 0,
            enemySpawns: 0
        };
        
        this.startTime = Date.now();

        this._tickStats = new Map();
        this._bandwidthStats = new Map();
    }
    
    log(level, category, message, data = null) {
        if (!this.enabled) return;
        if (level > this.level) return;
        if (!this.categories[category]) return;
        
        const timestamp = new Date().toLocaleTimeString();
        const levelName = Object.keys(DEBUG_LEVELS)[level];
        const prefix = `[${timestamp}] [SERVER] [${levelName}] [${category}]`;
        
        if (data) {
            console.log(`${prefix} ${message}`, data);
        } else {
            console.log(`${prefix} ${message}`);
        }
    }
    
    error(category, message, data) { this.log(DEBUG_LEVELS.ERROR, category, message, data); }
    warn(category, message, data) { this.log(DEBUG_LEVELS.WARN, category, message, data); }
    info(category, message, data) { this.log(DEBUG_LEVELS.INFO, category, message, data); }
    debug(category, message, data) { this.log(DEBUG_LEVELS.DEBUG, category, message, data); }
    verbose(category, message, data) { this.log(DEBUG_LEVELS.VERBOSE, category, message, data); }
    
    // Server-specific logging methods
    playerConnect(socketId, roomId, playerData) {
        this.counters.connections++;
        this.info('NETWORKING', `Player connected: ${socketId} → ${roomId}`, {
            playerData,
            totalConnections: this.counters.connections
        });
    }
    
    playerDisconnect(socketId, roomId, reason) {
        this.counters.disconnections++;
        this.info('NETWORKING', `Player disconnected: ${socketId} from ${roomId}`, {
            reason,
            totalDisconnections: this.counters.disconnections
        });
    }
    
    roomCreated(roomId, playerId) {
        this.counters.roomsCreated++;
        this.info('ROOMS', `Room created: ${roomId} by ${playerId}`, {
            totalRooms: this.counters.roomsCreated
        });
    }
    
    roomDestroyed(roomId, reason) {
        this.info('ROOMS', `Room destroyed: ${roomId}`, { reason });
    }
    
    playerInput(socketId, inputData) {
        this.counters.inputMessages++;
        this.verbose('MOVEMENT', `Input from ${socketId}`, {
            keys: inputData.keys,
            aimAngle: inputData.aimAngle ? inputData.aimAngle.toFixed(2) : 'none',
            sequence: inputData.sequence
        });
    }
    
    playerPositionUpdate(socketId, oldPos, newPos, deltaTime) {
        const distance = Math.sqrt(Math.pow(newPos.x - oldPos.x, 2) + Math.pow(newPos.y - oldPos.y, 2));
        if (distance > 1) { // Only log significant movement
            this.verbose('MOVEMENT', `Player ${socketId} moved ${distance.toFixed(1)} units`, {
                from: { x: oldPos.x.toFixed(1), y: oldPos.y.toFixed(1) },
                to: { x: newPos.x.toFixed(1), y: newPos.y.toFixed(1) },
                deltaTime: deltaTime.toFixed(3)
            });
        }
    }
    
    gameStateUpdate(roomId, playerCount, tickCount) {
        this.counters.stateUpdates++;
        if (this.counters.stateUpdates % 100 === 0) { // Log every 100 updates (avoid spam)
            this.debug('SERVER_TICK', `Game state update #${this.counters.stateUpdates} for ${roomId}`, {
                playerCount,
                tickCount,
                uptime: ((Date.now() - this.startTime) / 1000).toFixed(1) + 's'
            });
        }
    }
    
    errorOccurred(category, error, context) {
        this.counters.errors++;
        this.error(category, `Error occurred: ${error.message}`, {
            error: error.stack || error.toString(),
            context,
            totalErrors: this.counters.errors
        });
    }
    
    // Enemy spawn tracking
    enemySpawn(enemyId, type, position, targetSource) {
        this.counters.enemySpawns++;
        this.info('ENEMIES', `Enemy spawned: ${enemyId} (${type})`, {
            position: position ? { x: position.x.toFixed(1), y: position.y.toFixed(1) } : 'unknown',
            targetSource: targetSource || 'none',
            totalSpawns: this.counters.enemySpawns
        });
    }
    
    getServerStats() {
        return {
            uptime: Date.now() - this.startTime,
            counters: { ...this.counters },
            enabled: this.enabled,
            level: Object.keys(DEBUG_LEVELS)[this.level]
        };
    }
    
    dumpStats() {
        this.info('SERVER', 'Server statistics:', this.getServerStats());
    }
    
    // Player State & Inventory tracking (Server Authority)
    serverInventoryChange(playerId, action, item, oldCount, newCount, source) {
        this.counters.inventoryChanges++;
        this.info('INVENTORY', `[SERVER] ${playerId} inventory ${action}: ${item.name || item}`, {
            item: typeof item === 'object' ? item : { name: item },
            oldCount,
            newCount,
            source: source || 'server',
            netChange: newCount - oldCount,
            authoritative: true
        });
    }
    
    serverEquipmentChange(playerId, slot, oldItem, newItem, effects) {
        this.counters.equipmentChanges++;
        this.info('INVENTORY', `[SERVER] ${playerId} equipped: ${slot}`, {
            oldItem: oldItem?.name || 'none',
            newItem: newItem?.name || 'none',
            effects: effects || {},
            authoritative: true,
            timestamp: Date.now()
        });
    }
    
    serverStatusEffectChange(playerId, effect, action, duration, source) {
        this.counters.statusEffects++;
        this.info('INVENTORY', `[SERVER] ${playerId} status ${action}: ${effect}`, {
            duration: duration || 'permanent',
            source: source || 'server',
            authoritative: true,
            timestamp: Date.now()
        });
    }
    
    serverPlayerStatChange(playerId, stat, oldValue, newValue, source) {
        this.debug('INVENTORY', `[SERVER] ${playerId} stat ${stat}: ${oldValue} → ${newValue}`, {
            source: source || 'server',
            change: newValue - oldValue,
            percentage: oldValue > 0 ? ((newValue - oldValue) / oldValue * 100).toFixed(1) + '%' : 'new',
            authoritative: true
        });
    }
    
    // Server-side weapon tracking
    serverWeaponAction(playerId, weaponType, action, data) {
        this.counters.weaponActions++;
        this.debug('WEAPONS', `[SERVER] ${playerId} ${weaponType} ${action}`, {
            weaponData: data || {},
            authoritative: true,
            timestamp: Date.now()
        });
    }
    
    serverWeaponValidation(playerId, weaponType, clientData, serverData, valid) {
        this.debug('WEAPONS', `[SERVER] ${playerId} ${weaponType} validation: ${valid ? 'VALID' : 'INVALID'}`, {
            clientData: clientData || {},
            serverData: serverData || {},
            discrepancies: valid ? [] : this.findDiscrepancies(clientData, serverData)
        });
    }
    
    // Boss state tracking (Server Authority)
    serverBossStateChange(bossId, oldState, newState, reason) {
        this.counters.bossEvents++;
        this.info('BOSSES', `[SERVER] Boss ${bossId}: ${oldState || 'spawning'} → ${newState}`, {
            reason: reason || 'server decision',
            authoritative: true,
            timestamp: Date.now()
        });
    }
    
    serverBossPhaseChange(bossId, oldPhase, newPhase, healthPercent, triggers) {
        this.counters.bossEvents++;
        this.info('BOSSES', `[SERVER] Boss ${bossId} phase: ${oldPhase} → ${newPhase}`, {
            healthPercent: healthPercent ? healthPercent.toFixed(1) + '%' : 'unknown',
            triggers: triggers || {},
            authoritative: true,
            timestamp: Date.now()
        });
    }
    
    serverBossAttack(bossId, attackType, targets, damage, effects) {
        this.counters.bossEvents++;
        this.debug('BOSSES', `[SERVER] Boss ${bossId} used ${attackType}`, {
            targets: Array.isArray(targets) ? targets : [targets],
            damage: damage || 'calculated',
            effects: effects || {},
            authoritative: true,
            timestamp: Date.now()
        });
    }
    
    // Game Flow & Authority tracking (Server Decisions)
    serverSceneTransition(playerId, fromScene, toScene, reason) {
        this.counters.sceneTransitions++;
        this.info('GAMEFLOW', `[SERVER] ${playerId} scene: ${fromScene} → ${toScene}`, {
            reason: reason || 'server decision',
            authoritative: true,
            timestamp: Date.now()
        });
    }
    
    serverGameModeChange(oldMode, newMode, triggeredBy, serverTime) {
        this.counters.gameModeChanges++;
        this.info('GAMEFLOW', `[SERVER] Game mode: ${oldMode} → ${newMode}`, {
            triggeredBy: triggeredBy || 'server',
            serverTime,
            authoritative: true,
            timestamp: Date.now()
        });
    }
    
    serverExtractionEvent(playerId, zone, action, success, timing) {
        this.counters.extractionEvents++;
        this.info('GAMEFLOW', `[SERVER] ${playerId} extraction ${action} at ${zone}`, {
            success: success || false,
            timing: timing || {},
            authoritative: true,
            timestamp: Date.now()
        });
    }
    
    serverWinLoseCondition(condition, triggeredBy, gameState) {
        this.info('GAMEFLOW', `[SERVER] Game ${condition} triggered by ${triggeredBy}`, {
            gameState: gameState || {},
            authoritative: true,
            timestamp: Date.now()
        });
    }
    
    // Economy & Loot Generation tracking (Server Authority)
    serverChestOpen(chestId, playerId, position, lootGenerated, rngSeed) {
        this.counters.chestOpenings++;
        this.info('ECONOMY', `[SERVER] Chest ${chestId} opened by ${playerId}`, {
            position,
            lootGenerated: lootGenerated || [],
            rngSeed: rngSeed || 'generated',
            authoritative: true,
            timestamp: Date.now()
        });
    }
    
    serverItemGeneration(itemId, rarity, stats, generationSource, rngValues) {
        this.counters.itemGenerations++;
        this.debug('ECONOMY', `[SERVER] Item generated: ${itemId} (${rarity})`, {
            stats: stats || {},
            generationSource: generationSource || 'server',
            rngValues: rngValues || {},
            authoritative: true,
            timestamp: Date.now()
        });
    }
    
    serverLootDrop(sourceId, lootTable, itemsDropped, playersNearby) {
        this.debug('ECONOMY', `[SERVER] Loot dropped from ${sourceId}`, {
            lootTable: lootTable || 'server table',
            itemsDropped: itemsDropped || [],
            playersNearby: playersNearby || [],
            authoritative: true,
            timestamp: Date.now()
        });
    }
    
    serverRngGeneration(operation, seed, result, distributedToPlayers) {
        this.debug('ECONOMY', `[SERVER] RNG ${operation}: seed(${seed}) = result(${result})`, {
            seed,
            result,
            distributedToPlayers: distributedToPlayers || [],
            authoritative: true,
            timestamp: Date.now()
        });
    }
    
    // Helper method to find discrepancies between client and server data
    findDiscrepancies(clientData, serverData) {
        const discrepancies = [];
        for (const key in serverData) {
            if (clientData[key] !== serverData[key]) {
                discrepancies.push({
                    field: key,
                    client: clientData[key],
                    server: serverData[key]
                });
            }
        }
        return discrepancies;
    }
    
    // Server Movement & Collision Debugging - for teleportation bug tracking
    serverMovementInput(socketId, inputData, serverTimestamp) {
        this.verbose('MOVEMENT', `[SERVER] Input from ${socketId}`, {
            keys: Object.keys(inputData.keys || {}).filter(k => inputData.keys[k]),
            shift: !!(inputData.keys?.ShiftLeft || inputData.keys?.ShiftRight),
            sequence: inputData.sequence,
            clientTimestamp: inputData.timestamp,
            serverTimestamp,
            latency: serverTimestamp - (inputData.timestamp || 0)
        });
    }
    
    serverMovementCalculation(socketId, beforePos, afterPos, deltaTime, inputData, sprinting) {
        const distance = Math.sqrt(Math.pow(afterPos.x - beforePos.x, 2) + Math.pow(afterPos.y - beforePos.y, 2));
        this.verbose('MOVEMENT', `[SERVER] Calc: ${socketId} moved ${distance.toFixed(2)}`, {
            before: { x: beforePos.x.toFixed(2), y: beforePos.y.toFixed(2) },
            after: { x: afterPos.x.toFixed(2), y: afterPos.y.toFixed(2) },
            deltaTime: deltaTime.toFixed(3),
            sprinting,
            speed: (distance / deltaTime).toFixed(1),
            sequence: inputData.sequence
        });
    }

    serverCollisionDetection(socketId, beforePos, intendedPos, resolvedPos, environmentType, obstacleCount) {
        // Disabled to reduce log spam
        // const intendedDistance = Math.sqrt(Math.pow(intendedPos.x - beforePos.x, 2) + Math.pow(intendedPos.y - beforePos.y, 2));
        // const actualDistance = Math.sqrt(Math.pow(resolvedPos.x - beforePos.x, 2) + Math.pow(resolvedPos.y - beforePos.y, 2));
        // const reductionPct = intendedDistance > 0 ? ((intendedDistance - actualDistance) / intendedDistance) : 0;
        // if (reductionPct < 0.35) return;
        // this.debug('COLLISION', `[SERVER] ${socketId} collision`, {
        //     intended: { x: intendedPos.x.toFixed(2), y: intendedPos.y.toFixed(2) },
        //     resolved: { x: resolvedPos.x.toFixed(2), y: resolvedPos.y.toFixed(2) },
        //     blocked: true,
        //     reduction: (reductionPct * 100).toFixed(1) + '%',
        //     environmentType,
        //     obstacleCount,
        //     timestamp: Date.now()
        // });
    }
    
    serverPositionCorrection(socketId, serverPos, sentToClient, reason, sequence) {
        this.debug('POSITION_SYNC', `[SERVER] Position correction sent to ${socketId}`, {
            serverPos: { x: serverPos.x.toFixed(2), y: serverPos.y.toFixed(2) },
            sentPos: { x: sentToClient.x.toFixed(2), y: sentToClient.y.toFixed(2) },
            reason,
            sequence,
            timestamp: Date.now()
        });
    }
    
    serverEnvironmentMismatch(socketId, serverScene, serverObstacles, clientInfo, sequence) {
        this.warn('COLLISION', `[SERVER] Environment mismatch for ${socketId}`, {
            serverScene,
            serverObstacles,
            clientInfo: clientInfo || 'unknown',
            sequence,
            timestamp: Date.now()
        });
    }
    
    serverWallPenetrationDetected(socketId, position, wallInfo, penetrationDepth) {
        this.error('COLLISION', `[SERVER] WALL PENETRATION detected for ${socketId}!`, {
            position: { x: position.x.toFixed(2), y: position.y.toFixed(2) },
            wall: wallInfo,
            penetrationDepth: penetrationDepth.toFixed(2),
            timestamp: Date.now()
        });
    }
    roomTickTiming(roomId, deltaTimeSec, tickDurationMs, targetHz) {
        if (!this.enabled || !this.categories.SERVER_TICK) return;
        const stats = this._ensureTickStats(roomId);
        stats.count++;
        stats.totalDurationMs += tickDurationMs;
        stats.totalDeltaMs += deltaTimeSec * 1000;
        stats.minDurationMs = Math.min(stats.minDurationMs, tickDurationMs);
        stats.maxDurationMs = Math.max(stats.maxDurationMs, tickDurationMs);
        stats.minDeltaMs = Math.min(stats.minDeltaMs, deltaTimeSec * 1000);
        stats.maxDeltaMs = Math.max(stats.maxDeltaMs, deltaTimeSec * 1000);

        const expectedMs = targetHz > 0 ? 1000 / targetHz : null;
        const deltaMs = deltaTimeSec * 1000;

        if (expectedMs !== null) {
            const budget = expectedMs * 1.5;
            if (tickDurationMs > budget || deltaMs > budget) {
                stats.overBudget++;
                this.warn('SERVER_TICK', `[TICK] Room ${roomId} over budget`, {
                    tickDurationMs: tickDurationMs.toFixed(2),
                    deltaMs: deltaMs.toFixed(2),
                    expectedMs: expectedMs.toFixed(2),
                    timestamp: Date.now()
                });
            }
        }

        if (stats.count >= 120) {
            const avgDuration = stats.totalDurationMs / Math.max(1, stats.count);
            const avgDelta = stats.totalDeltaMs / Math.max(1, stats.count);
            this.debug('SERVER_TICK', `[TICK] Room ${roomId} sample`, {
                avgDurationMs: avgDuration.toFixed(2),
                avgDeltaMs: avgDelta.toFixed(2),
                minDurationMs: stats.minDurationMs === Infinity ? 0 : stats.minDurationMs.toFixed(2),
                maxDurationMs: stats.maxDurationMs === -Infinity ? 0 : stats.maxDurationMs.toFixed(2),
                minDeltaMs: stats.minDeltaMs === Infinity ? 0 : stats.minDeltaMs.toFixed(2),
                maxDeltaMs: stats.maxDeltaMs === -Infinity ? 0 : stats.maxDeltaMs.toFixed(2),
                overBudget: stats.overBudget
            });
            stats.count = 0;
            stats.totalDurationMs = 0;
            stats.totalDeltaMs = 0;
            stats.minDurationMs = Infinity;
            stats.maxDurationMs = -Infinity;
            stats.minDeltaMs = Infinity;
            stats.maxDeltaMs = -Infinity;
            stats.overBudget = 0;
        }
    }

    roomBroadcast(roomId, playerCount, payloadBytes) {
        if (!this.enabled || !this.categories.NETWORKING) return;
        const stats = this._ensureBandwidthStats(roomId);
        stats.count++;
        stats.totalBytes += payloadBytes;
        stats.minBytes = Math.min(stats.minBytes, payloadBytes);
        stats.maxBytes = Math.max(stats.maxBytes, payloadBytes);
        stats.lastPlayerCount = playerCount;

        if (payloadBytes > stats.maxAlertBytes) {
            this.warn('NETWORKING', `[NET] Large payload for room ${roomId}`, {
                payloadBytes,
                playerCount,
                timestamp: Date.now()
            });
            stats.maxAlertBytes = payloadBytes;
        }

        if (stats.count >= 120) {
            const avgBytes = stats.totalBytes / Math.max(1, stats.count);
            this.debug('NETWORK_STATS', `[NET] Room ${roomId} snapshot`, {
                avgBytes: Math.round(avgBytes),
                minBytes: stats.minBytes === Infinity ? 0 : Math.round(stats.minBytes),
                maxBytes: stats.maxBytes === -Infinity ? 0 : Math.round(stats.maxBytes),
                totalBytes: Math.round(stats.totalBytes),
                playerCount: stats.lastPlayerCount
            });
            stats.count = 0;
            stats.totalBytes = 0;
            stats.minBytes = Infinity;
            stats.maxBytes = -Infinity;
        }
    }

    _ensureTickStats(roomId) {
        if (!this._tickStats.has(roomId)) {
            this._tickStats.set(roomId, {
                count: 0,
                totalDurationMs: 0,
                totalDeltaMs: 0,
                minDurationMs: Infinity,
                maxDurationMs: -Infinity,
                minDeltaMs: Infinity,
                maxDeltaMs: -Infinity,
                overBudget: 0
            });
        }
        return this._tickStats.get(roomId);
    }

    _ensureBandwidthStats(roomId) {
        if (!this._bandwidthStats.has(roomId)) {
            this._bandwidthStats.set(roomId, {
                count: 0,
                totalBytes: 0,
                minBytes: Infinity,
                maxBytes: -Infinity,
                maxAlertBytes: 0,
                lastPlayerCount: 0
            });
        }
        return this._bandwidthStats.get(roomId);
    }

}
module.exports = { ServerDebugger, DEBUG_LEVELS, DEBUG_CATEGORIES };



