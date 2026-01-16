// Debug system for multiplayer game development
// Set DEBUG_ENABLED to false to disable all debug logging for production
const DEBUG_ENABLED = true;

// Debug levels
const DEBUG_LEVELS = {
    ERROR: 0,
    WARN: 1,
    INFO: 2,
    DEBUG: 3,
    VERBOSE: 4
};

// Current debug level - set higher for more verbose logging
const CURRENT_DEBUG_LEVEL = DEBUG_LEVELS.DEBUG;

// Debug categories - can be toggled individually
const DEBUG_CATEGORIES = {
    NETWORKING: true,
    PLAYERS: true,
    ENEMIES: true,
    COMBAT: true,
    MOVEMENT: true, // Enable for teleportation debugging
    COLLISION: false, // Track collision detection events
    POSITION_SYNC: false, // Track client-server position synchronization
    SERVER: true,
    SYNC: true,
    INVENTORY: true,
    GAMEFLOW: true,
    ECONOMY: true,
    WEAPONS: true,
    BOSSES: true
};

class GameDebugger {
    constructor() {
        this.enabled = DEBUG_ENABLED;
        this.level = CURRENT_DEBUG_LEVEL;
        this.categories = DEBUG_CATEGORIES;
        this.logHistory = [];
        this.maxHistorySize = 1000;
        
        // Performance tracking
        this.frameCount = 0;
        this.lastFpsTime = Date.now();
        this.fps = 0;
        
        // Event counters
        this.counters = {
            networkMessages: 0,
            playerJoins: 0,
            playerLeaves: 0,
            damageEvents: 0,
            enemySpawns: 0,
            projectilesFired: 0,
            inventoryChanges: 0,
            equipmentChanges: 0,
            statusEffects: 0,
            sceneTransitions: 0,
            gameModeChanges: 0,
            extractionEvents: 0,
            chestOpenings: 0,
            itemGenerations: 0,
            weaponActions: 0,
            bossEvents: 0
        };
    }
    
    // Core logging function
    log(level, category, message, data = null) {
        if (!this.enabled) {
            if (category === 'COMBAT') {
                const hasDamageKeyword = typeof message === 'string' && message.toLowerCase().includes('damage');
                if (hasDamageKeyword) {
                    const style = this.getLogStyle(level);
                    if (data) {
                        console.log(`%c${message}`, style, data);
                    } else {
                        console.log(`%c${message}`, style);
                    }
                }
            }
            return;
        }
        if (level > this.level) return;
        if (!this.categories[category]) return;
        
        const timestamp = new Date().toLocaleTimeString();
        const levelName = Object.keys(DEBUG_LEVELS)[level];
        const prefix = `[${timestamp}] [${levelName}] [${category}]`;
        
        const logEntry = {
            timestamp: Date.now(),
            level: levelName,
            category,
            message,
            data
        };
        
        // Add to history
        this.logHistory.push(logEntry);
        if (this.logHistory.length > this.maxHistorySize) {
            this.logHistory.shift();
        }
        
        // Console output with appropriate styling
        const style = this.getLogStyle(level);
        if (data) {
            console.log(`%c${prefix} ${message}`, style, data);
        } else {
            console.log(`%c${prefix} ${message}`, style);
        }
    }
    
    getLogStyle(level) {
        switch (level) {
            case DEBUG_LEVELS.ERROR: return 'color: #ff4444; font-weight: bold;';
            case DEBUG_LEVELS.WARN: return 'color: #ffaa00; font-weight: bold;';
            case DEBUG_LEVELS.INFO: return 'color: #4488ff;';
            case DEBUG_LEVELS.DEBUG: return 'color: #888888;';
            case DEBUG_LEVELS.VERBOSE: return 'color: #666666; font-size: 11px;';
            default: return '';
        }
    }
    
    // Convenience methods for different levels
    error(category, message, data) { this.log(DEBUG_LEVELS.ERROR, category, message, data); }
    warn(category, message, data) { this.log(DEBUG_LEVELS.WARN, category, message, data); }
    info(category, message, data) { this.log(DEBUG_LEVELS.INFO, category, message, data); }
    debug(category, message, data) { this.log(DEBUG_LEVELS.DEBUG, category, message, data); }
    verbose(category, message, data) { this.log(DEBUG_LEVELS.VERBOSE, category, message, data); }
    
    // Specific game system loggers
    
    // Networking events
    networkConnect(playerId, roomId) {
        this.counters.networkMessages++;
        this.info('NETWORKING', `Player connected: ${playerId} to room: ${roomId}`);
    }
    
    networkDisconnect(playerId, reason) {
        this.counters.networkMessages++;
        this.info('NETWORKING', `Player disconnected: ${playerId}`, { reason });
    }
    
    networkMessage(type, playerId, data) {
        this.counters.networkMessages++;
        this.verbose('NETWORKING', `${type} from ${playerId}`, data);
    }
    
    // Player events
    playerJoin(playerId, position, roomInfo) {
        this.counters.playerJoins++;
        this.info('PLAYERS', `Player joined: ${playerId}`, { 
            position, 
            roomInfo,
            totalPlayers: roomInfo?.playerCount || 'unknown'
        });
    }
    
    playerLeave(playerId, roomInfo) {
        this.counters.playerLeaves++;
        this.info('PLAYERS', `Player left: ${playerId}`, { 
            roomInfo,
            remainingPlayers: roomInfo?.playerCount || 'unknown'
        });
    }
    
    playerMove(playerId, from, to, aimAngle) {
        this.verbose('MOVEMENT', `Player ${playerId} moved`, { 
            from: { x: from.x.toFixed(1), y: from.y.toFixed(1) },
            to: { x: to.x.toFixed(1), y: to.y.toFixed(1) },
            aimAngle: aimAngle ? aimAngle.toFixed(2) : 'none'
        });
    }
    
    playerHealth(playerId, oldHealth, newHealth, maxHealth, cause) {
        this.info('PLAYERS', `Player ${playerId} health: ${oldHealth} → ${newHealth}/${maxHealth}`, { cause });
    }
    
    // Enemy events
    enemySpawn(enemyId, type, position, targetPlayer) {
        this.counters.enemySpawns++;
        this.info('ENEMIES', `Enemy spawned: ${enemyId} (${type})`, { 
            position,
            targetPlayer: targetPlayer || 'none'
        });
    }
    
    enemyTarget(enemyId, oldTarget, newTarget, reason) {
        this.debug('ENEMIES', `Enemy ${enemyId} retargeted: ${oldTarget || 'none'} → ${newTarget || 'none'}`, { reason });
    }
    
    enemyHealth(enemyId, oldHealth, newHealth, maxHealth, damageSource) {
        this.debug('ENEMIES', `Enemy ${enemyId} health: ${oldHealth} → ${newHealth}/${maxHealth}`, { damageSource });
    }
    
    enemyDeath(enemyId, killer, cause) {
        this.info('ENEMIES', `Enemy ${enemyId} killed by ${killer || 'unknown'}`, { cause });
    }
    
    // Combat events
    projectileFired(projectileId, playerId, weapon, position, target) {
        this.counters.projectilesFired++;
        this.debug('COMBAT', `Projectile fired: ${projectileId} by ${playerId}`, { 
            weapon,
            position,
            target: target || 'none'
        });
    }
    
    projectileHit(projectileId, hitTarget, damage, position) {
        this.info('COMBAT', `Projectile ${projectileId} hit ${hitTarget}`, { 
            damage,
            position
        });
    }
    
    damageDealt(sourceId, targetId, damage, damageType, weapon) {
        this.counters.damageEvents++;
        this.info('COMBAT', `Damage: ${sourceId} → ${targetId} (${damage} ${damageType})`, { weapon });
    }
    
    // Server synchronization
    syncCorrection(playerId, clientPos, serverPos, distance) {
        if (distance > 10) { // Only log significant corrections
            this.warn('SYNC', `Position correction for ${playerId}: distance ${distance.toFixed(1)}`, {
                client: { x: clientPos.x.toFixed(1), y: clientPos.y.toFixed(1) },
                server: { x: serverPos.x.toFixed(1), y: serverPos.y.toFixed(1) }
            });
        }
    }
    
    syncLatency(playerId, ping, jitter) {
        this.verbose('SYNC', `Latency for ${playerId}: ${ping}ms (jitter: ${jitter}ms)`);
    }
    
    // Performance tracking
    updateFps() {
        this.frameCount++;
        const now = Date.now();
        if (now - this.lastFpsTime >= 1000) {
            this.fps = this.frameCount;
            this.frameCount = 0;
            this.lastFpsTime = now;
        }
    }
    
    // Utility methods
    dumpCounters() {
        this.info('DEBUG', 'Event counters:', this.counters);
    }
    
    dumpHistory(category = null, count = 10) {
        let filtered = this.logHistory;
        if (category) {
            filtered = this.logHistory.filter(entry => entry.category === category);
        }
        
        const recent = filtered.slice(-count);
        console.table(recent);
    }
    
    clearHistory() {
        this.logHistory = [];
        this.info('DEBUG', 'Debug history cleared');
    }
    
    // Toggle categories
    enableCategory(category, enabled = true) {
        this.categories[category] = enabled;
        this.info('DEBUG', `Category ${category}: ${enabled ? 'enabled' : 'disabled'}`);
    }
    
    setLevel(level) {
        this.level = level;
        const levelName = Object.keys(DEBUG_LEVELS)[level];
        this.info('DEBUG', `Debug level set to: ${levelName}`);
    }
    
    // Player State & Inventory tracking
    inventoryChange(playerId, action, item, oldCount, newCount, source) {
        this.counters.inventoryChanges++;
        this.info('INVENTORY', `${playerId} inventory ${action}: ${item.name || item}`, {
            item: typeof item === 'object' ? item : { name: item },
            oldCount,
            newCount,
            source: source || 'unknown',
            netChange: newCount - oldCount
        });
    }
    
    equipmentChange(playerId, slot, oldItem, newItem, effects) {
        this.counters.equipmentChanges++;
        this.info('INVENTORY', `${playerId} equipped: ${slot}`, {
            oldItem: oldItem?.name || 'none',
            newItem: newItem?.name || 'none',
            effects: effects || {},
            timestamp: Date.now()
        });
    }
    
    statusEffectChange(playerId, effect, action, duration, source) {
        this.counters.statusEffects++;
        this.info('INVENTORY', `${playerId} status ${action}: ${effect}`, {
            duration: duration || 'permanent',
            source: source || 'unknown',
            timestamp: Date.now()
        });
    }
    
    playerStatChange(playerId, stat, oldValue, newValue, source) {
        this.debug('INVENTORY', `${playerId} stat ${stat}: ${oldValue} → ${newValue}`, {
            source: source || 'unknown',
            change: newValue - oldValue,
            percentage: oldValue > 0 ? ((newValue - oldValue) / oldValue * 100).toFixed(1) + '%' : 'new'
        });
    }
    
    // Individual weapon tracking
    weaponAction(playerId, weaponType, action, data) {
        this.counters.weaponActions++;
        this.debug('WEAPONS', `${playerId} ${weaponType} ${action}`, {
            weaponData: data || {},
            timestamp: Date.now()
        });
    }
    
    weaponMelee(playerId, weapon, target, damage, position) {
        this.weaponAction(playerId, 'MELEE', 'attack', {
            weapon: weapon?.name || weapon,
            target,
            damage,
            position,
            range: weapon?.range || 'unknown'
        });
    }
    
    weaponDots(playerId, weapon, target, dotDamage, duration, stackCount) {
        this.weaponAction(playerId, 'DOTS', 'apply', {
            weapon: weapon?.name || weapon,
            target,
            dotDamage,
            duration,
            stackCount: stackCount || 1,
            totalDamage: dotDamage * (duration / 1000) * (stackCount || 1)
        });
    }
    
    weaponProjectile(playerId, weapon, projectileId, position, target) {
        this.weaponAction(playerId, 'PROJECTILE', 'fire', {
            weapon: weapon?.name || weapon,
            projectileId,
            position,
            target: target || 'none',
            speed: weapon?.projectileSpeed || 'unknown'
        });
    }
    
    // Boss state tracking
    bossStateChange(bossId, oldState, newState, reason) {
        this.counters.bossEvents++;
        this.info('BOSSES', `Boss ${bossId}: ${oldState || 'spawning'} → ${newState}`, {
            reason: reason || 'unknown',
            timestamp: Date.now()
        });
    }
    
    bossPhaseChange(bossId, oldPhase, newPhase, healthPercent, triggers) {
        this.counters.bossEvents++;
        this.info('BOSSES', `Boss ${bossId} phase: ${oldPhase} → ${newPhase}`, {
            healthPercent: healthPercent ? healthPercent.toFixed(1) + '%' : 'unknown',
            triggers: triggers || {},
            timestamp: Date.now()
        });
    }
    
    bossAttack(bossId, attackType, targets, damage, effects) {
        this.counters.bossEvents++;
        this.debug('BOSSES', `Boss ${bossId} used ${attackType}`, {
            targets: Array.isArray(targets) ? targets : [targets],
            damage: damage || 'unknown',
            effects: effects || {},
            timestamp: Date.now()
        });
    }
    
    // Game Flow & Authority tracking
    sceneTransition(playerId, fromScene, toScene, reason, serverAuthorized) {
        this.counters.sceneTransitions++;
        this.info('GAMEFLOW', `${playerId} scene: ${fromScene} → ${toScene}`, {
            reason: reason || 'unknown',
            serverAuthorized: serverAuthorized || false,
            timestamp: Date.now()
        });
    }
    
    gameModeChange(oldMode, newMode, triggeredBy, serverTime, playerTime) {
        this.counters.gameModeChanges++;
        this.info('GAMEFLOW', `Game mode: ${oldMode} → ${newMode}`, {
            triggeredBy: triggeredBy || 'unknown',
            serverTime,
            playerTime,
            timeDrift: serverTime && playerTime ? Math.abs(serverTime - playerTime) : 'unknown',
            timestamp: Date.now()
        });
    }
    
    extractionEvent(playerId, zone, action, success, timing) {
        this.counters.extractionEvents++;
        this.info('GAMEFLOW', `${playerId} extraction ${action} at ${zone}`, {
            success: success || false,
            timing: timing || {},
            timestamp: Date.now()
        });
    }
    
    winLoseCondition(condition, triggeredBy, gameState, serverConfirmed) {
        this.info('GAMEFLOW', `Game ${condition} triggered by ${triggeredBy}`, {
            gameState: gameState || {},
            serverConfirmed: serverConfirmed || false,
            timestamp: Date.now()
        });
    }
    
    // Economy & Loot Generation tracking
    chestOpen(chestId, playerId, position, lootGenerated, rngSeed) {
        this.counters.chestOpenings++;
        this.info('ECONOMY', `Chest ${chestId} opened by ${playerId}`, {
            position,
            lootGenerated: lootGenerated || [],
            rngSeed: rngSeed || 'unknown',
            timestamp: Date.now()
        });
    }
    
    itemGeneration(itemId, rarity, stats, generationSource, rngValues) {
        this.counters.itemGenerations++;
        this.debug('ECONOMY', `Item generated: ${itemId} (${rarity})`, {
            stats: stats || {},
            generationSource: generationSource || 'unknown',
            rngValues: rngValues || {},
            timestamp: Date.now()
        });
    }
    
    lootDrop(sourceId, lootTable, itemsDropped, playersNearby) {
        this.debug('ECONOMY', `Loot dropped from ${sourceId}`, {
            lootTable: lootTable || 'unknown',
            itemsDropped: itemsDropped || [],
            playersNearby: playersNearby || [],
            timestamp: Date.now()
        });
    }
    
    rngSync(operation, clientSeed, serverSeed, result, match) {
        this.debug('ECONOMY', `RNG sync ${operation}: ${match ? 'MATCH' : 'MISMATCH'}`, {
            clientSeed,
            serverSeed,
            result,
            timestamp: Date.now()
        });
    }
    
    // Movement & Collision Debugging - for teleportation bug tracking
    movementInput(playerId, inputKeys, timestamp, position) {
        this.verbose('MOVEMENT', `Input: ${playerId}`, {
            keys: Object.keys(inputKeys).filter(k => inputKeys[k]),
            shift: !!(inputKeys.ShiftLeft || inputKeys.ShiftRight),
            position: { x: position.x.toFixed(2), y: position.y.toFixed(2) },
            timestamp
        });
    }
    
    movementCalculation(playerId, beforePos, afterPos, deltaTime, velocity, sprinting) {
        const distance = Math.sqrt(Math.pow(afterPos.x - beforePos.x, 2) + Math.pow(afterPos.y - beforePos.y, 2));
        this.verbose('MOVEMENT', `Calc: ${playerId} moved ${distance.toFixed(2)}`, {
            before: { x: beforePos.x.toFixed(2), y: beforePos.y.toFixed(2) },
            after: { x: afterPos.x.toFixed(2), y: afterPos.y.toFixed(2) },
            velocity: { x: velocity.x.toFixed(2), y: velocity.y.toFixed(2) },
            deltaTime: deltaTime.toFixed(3),
            sprinting,
            speed: (distance / deltaTime).toFixed(1)
        });
    }
    
    collisionDetection(playerId, beforePos, afterPos, collisionResolved, obstaclesHit) {
        const preDistance = Math.sqrt(Math.pow(afterPos.x - beforePos.x, 2) + Math.pow(afterPos.y - beforePos.y, 2));
        const resolved = collisionResolved || afterPos;
        const postDistance = Math.sqrt(Math.pow(resolved.x - beforePos.x, 2) + Math.pow(resolved.y - beforePos.y, 2));
        
        this.debug('COLLISION', `${playerId} collision`, {
            intended: { x: afterPos.x.toFixed(2), y: afterPos.y.toFixed(2) },
            resolved: { x: resolved.x.toFixed(2), y: resolved.y.toFixed(2) },
            blocked: postDistance < preDistance * 0.9,
            reduction: ((preDistance - postDistance) / preDistance * 100).toFixed(1) + '%',
            obstaclesHit: obstaclesHit || 0,
            timestamp: Date.now()
        });
    }
    
    positionSync(playerId, clientPos, serverPos, action, sequence) {
        const distance = Math.sqrt(Math.pow(serverPos.x - clientPos.x, 2) + Math.pow(serverPos.y - clientPos.y, 2));
        
        if (distance > 0.5) { // Only log significant desyncs
            this.warn('POSITION_SYNC', `${playerId} desync: ${distance.toFixed(2)} units`, {
                client: { x: clientPos.x.toFixed(2), y: clientPos.y.toFixed(2) },
                server: { x: serverPos.x.toFixed(2), y: serverPos.y.toFixed(2) },
                action,
                sequence,
                severity: distance > 10 ? 'HIGH' : distance > 2 ? 'MEDIUM' : 'LOW',
                timestamp: Date.now()
            });
        }
    }
    
    wallPenetration(playerId, position, wallInfo, penetrationDepth) {
        this.error('COLLISION', `${playerId} WALL PENETRATION detected!`, {
            position: { x: position.x.toFixed(2), y: position.y.toFixed(2) },
            wall: wallInfo,
            penetrationDepth: penetrationDepth.toFixed(2),
            timestamp: Date.now()
        });
    }
    
    sprintTeleport(playerId, beforePos, afterPos, sprintDuration, wallThickness) {
        const distance = Math.sqrt(Math.pow(afterPos.x - beforePos.x, 2) + Math.pow(afterPos.y - beforePos.y, 2));
        this.error('MOVEMENT', `${playerId} SPRINT TELEPORT detected!`, {
            before: { x: beforePos.x.toFixed(2), y: beforePos.y.toFixed(2) },
            after: { x: afterPos.x.toFixed(2), y: afterPos.y.toFixed(2) },
            teleportDistance: distance.toFixed(2),
            sprintDuration: sprintDuration.toFixed(2),
            wallThickness: wallThickness.toFixed(2),
            ratio: (sprintDuration / wallThickness).toFixed(2),
            timestamp: Date.now()
        });
    }
    
    // Get debug status for UI display
    getStatus() {
        return {
            enabled: this.enabled,
            level: Object.keys(DEBUG_LEVELS)[this.level],
            fps: this.fps,
            counters: { ...this.counters },
            categories: { ...this.categories }
        };
    }
}

// Global debug instance
window.gameDebugger = new GameDebugger();

// Convenience aliases for common operations
window.dbg = {
    // Quick logging
    log: (msg, data) => window.gameDebugger.info('DEBUG', msg, data),
    warn: (msg, data) => window.gameDebugger.warn('DEBUG', msg, data),
    error: (msg, data) => window.gameDebugger.error('DEBUG', msg, data),
    
    // System specific
    net: window.gameDebugger.networkMessage.bind(window.gameDebugger),
    player: window.gameDebugger.playerMove.bind(window.gameDebugger),
    enemy: window.gameDebugger.enemyTarget.bind(window.gameDebugger),
    combat: window.gameDebugger.damageDealt.bind(window.gameDebugger),
    inventory: window.gameDebugger.inventoryChange.bind(window.gameDebugger),
    weapon: window.gameDebugger.weaponAction.bind(window.gameDebugger),
    boss: window.gameDebugger.bossStateChange.bind(window.gameDebugger),
    scene: window.gameDebugger.sceneTransition.bind(window.gameDebugger),
    loot: window.gameDebugger.chestOpen.bind(window.gameDebugger),
    
    // Utilities
    dump: () => window.gameDebugger.dumpCounters(),
    history: (cat, count) => window.gameDebugger.dumpHistory(cat, count),
    clear: () => window.gameDebugger.clearHistory(),
    status: () => window.gameDebugger.getStatus()
};

// Export for server-side use
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { GameDebugger, DEBUG_LEVELS, DEBUG_CATEGORIES };
}