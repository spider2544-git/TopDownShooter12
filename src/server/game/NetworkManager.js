/**
 * NetworkManager - Manages all network broadcasts and state synchronization for GameRoom
 * 
 * Extracted from GameRoom (Phase 3 of incremental manager extraction)
 * 
 * Handles:
 * - Game state broadcasts (player positions, health, etc.)
 * - Enemy state broadcasts (position, type-specific state)
 * - Low-priority broadcasts (timers, ambient state)
 * - Delta compression state tracking
 * - Interest-based replication for performance
 */

// Import dependencies (global modules that will be available in server.js context)
// Note: serverDebugger, Protocol, and io are accessed via global scope or passed in

class NetworkManager {
    /**
     * @param {GameRoom} room - Reference to the parent GameRoom for state access
     * @param {SocketIO} io - Socket.io server instance for broadcasts
     */
    constructor(room, io) {
        this.room = room;
        this.io = io;
        
        // Get references to global modules that will be available at runtime
        // These are injected from server.js context
        this.serverDebugger = global.serverDebugger || { 
            gameStateUpdate: () => {}, 
            roomBroadcast: () => {}, 
            warn: () => {} 
        };
        this.Protocol = global.Protocol || { 
            FEATURES: { 
                DUAL_EMIT_ENTITIES: false, 
                ENTITIES_INCLUDE_ENEMIES: false 
            }, 
            EntityType: { ENEMY: 'enemy' } 
        };
        this.DEBUG_BUILD = global.DEBUG_BUILD || false;
    }

    // =========================================
    // STATE GETTER METHODS (Create snapshots)
    // =========================================

    getGameState() {
        const players = [];
        let maxInputSeq = 0;

        for (const [id, player] of this.room.players) {
            players.push({
                id: player.id,
                x: player.x,
                y: player.y,
                radius: player.radius,
                health: player.health,
                healthMax: player.healthMax,
                aimAngle: player.aimAngle,
                stamina: player.stamina,
                staminaMax: player.staminaMax,
                exhaustionTimer: player.exhaustionTimer,
                mustReleaseShift: player.mustReleaseShift,
                mustReleaseFire: player.mustReleaseFire,
                serverSprintActive: player.serverSprintActive || false,
                _ensnaredTimer: player._ensnaredTimer || 0,
                _ensnaredById: player._ensnaredById || null,
                _weapon8ADS: player._weapon8ADS || false,
                // Send _ensnaredBy Map as object for client contact damage detection
                _ensnaredByMap: player._ensnaredBy ? Object.fromEntries(player._ensnaredBy) : {},
                // Basic zombie melee slow (for client visual effects)
                _basicZombieSlowCount: (player._basicZombieSlow && player._basicZombieSlow.timer > 0) ? player._basicZombieSlow.count : 0,
                // Derived stats from inventory (server-authoritative)
                speed: player.speed,
                armor: player.armor,
                attackSpeed: player.attackSpeed,
                attackPower: player.attackPower,
                critChance: player.critChance,
                critDamageMultiplier: player.critDamageMultiplier,
                // Evil/heretic conversion state for visual replication and PvP
                evilProgress: player.evilProgress || 0,
                evilLocked: player.evilLocked || false,
                isEvil: player.isEvil || false,
                // Invisibility state (weapon 5 secondary ability)
                invisible: player.invisible || false,
                // Currency wallet
                ducats: player.ducats || 0,
                bloodMarkers: player.bloodMarkers || 0,
                victoryPoints: player.victoryPoints || 0,
                // Loot progression
                lootLevel: player.lootLevel || 0,
                // Quartermaster: whether this player already received the one-time supply bundle
                qmGrantedSupplies: !!player._qmGrantedSupplies,
                // Knockback state (for BigBoy dash and other knockback effects)
                kbTime: player.kbTime || 0,
                kbVelX: player.kbVelX || 0,
                kbVelY: player.kbVelY || 0,
                // Dash state
                dashActive: player.dashActive || false,
                dashDuration: player.dashDuration || 0,
                dashCooldown: player.dashCooldown || 0,
                // Cosmetics
                equippedHat: player.equippedHat || null,
                equippedSkin: player.equippedSkin || null,
                // Revive system
                downedAt: player.downedAt || 0,
                reviveWindowRemainingMs: Number.isFinite(player.reviveWindowRemainingMs) ? player.reviveWindowRemainingMs : 0,
                reviveProgress: (() => {
                    try {
                        const st = this.room._activeRevivesByTarget ? this.room._activeRevivesByTarget.get(player.id) : null;
                        if (!st) return 0;
                        return Math.max(0, Math.min(1, (Date.now() - st.startedAt) / 4000));
                    } catch(_) { return 0; }
                })(),
                reviveReviverId: (() => {
                    try {
                        const st = this.room._activeRevivesByTarget ? this.room._activeRevivesByTarget.get(player.id) : null;
                        return st ? st.reviverId : null;
                    } catch(_) { return null; }
                })(),
                // Revive ready state (broadcast so other clients can suppress re-revive prompts)
                reviveReadyUntil: player.reviveReadyUntil || 0,
                reviveReadyFromId: player.reviveReadyFromId || null,
                // Breadcrumb trail for pathfinding visualization
                breadcrumbs: player.breadcrumbs || []
                ,
                // Collision debug (server-authoritative): what blocked this player's movement most recently
                blockedBy: player._blockedBy || null
            });
            if (player.lastInput && player.lastInput.sequence > maxInputSeq) {
                maxInputSeq = player.lastInput.sequence;
            }
        }

        // Calculate artillery barrage state for Trench Raid mode
        let artilleryBarrageElapsedMs = 0;
        let artilleryBarrageActive = false;
        if (this.room.levelStartTime && this.room.levelType === 'trenchraid') {
            // Use frozen elapsed time if extraction completed, otherwise calculate live
            if (this.room.artilleryFrozenElapsedMs !== null) {
                artilleryBarrageElapsedMs = this.room.artilleryFrozenElapsedMs;
            } else {
                // Subtract bonus time from elapsed (bonus time effectively pushes the deadline forward)
                // Allow negative values so timer can exceed initial 9 minutes when bonus is added early
                artilleryBarrageElapsedMs = Date.now() - this.room.levelStartTime - this.room.artilleryBonusTimeMs;
            }
            artilleryBarrageActive = artilleryBarrageElapsedMs >= 9 * 60 * 1000; // 9 minutes
        }
        
        return {
            tick: this.room.tickCount,
            timestamp: Date.now(),
            players,
            lastProcessedInputSeq: maxInputSeq,
            // Artillery barrage timer sync for Trench Raid mode
            artilleryBarrageElapsedMs: this.room.levelType === 'trenchraid' ? artilleryBarrageElapsedMs : undefined,
            artilleryBarrageActive: this.room.levelType === 'trenchraid' ? artilleryBarrageActive : undefined
        };
    }
    
    // Delta state updates - sends only changed properties (60-70% bandwidth reduction)
    getGameStateDelta() {
        const delta = { 
            tick: this.room.tickCount,
            timestamp: Date.now(), 
            players: {},
            isFull: false
        };
        
        // Send full state every N frames for reliability (handles new players, dropped packets)
        this.room._fullStateBroadcastCounter++;
        if (this.room._fullStateBroadcastCounter >= this.room._fullStateBroadcastInterval) {
            this.room._fullStateBroadcastCounter = 0;
            delta.isFull = true;
            return this.getGameState(); // Send full state
        }
        
        // Otherwise send only changes
        let maxInputSeq = 0;
        for (const [id, player] of this.room.players) {
            const last = this.room._lastBroadcastState.get(id);
            const changes = { id };
            
            // Only include changed properties (threshold 0.1 for position to avoid micro-updates)
            if (!last || Math.abs(player.x - last.x) > 0.1) changes.x = player.x;
            if (!last || Math.abs(player.y - last.y) > 0.1) changes.y = player.y;
            if (!last || player.health !== last.health) changes.health = player.health;
            if (!last || player.healthMax !== last.healthMax) changes.healthMax = player.healthMax;
            if (!last || player.stamina !== last.stamina) changes.stamina = player.stamina;
            if (!last || player.staminaMax !== last.staminaMax) changes.staminaMax = player.staminaMax;
            if (!last || Math.abs(player.aimAngle - last.aimAngle) > 0.01) changes.aimAngle = player.aimAngle;
            if (!last || player._ensnaredTimer !== last._ensnaredTimer) changes._ensnaredTimer = player._ensnaredTimer;
            if (!last || player._ensnaredById !== last._ensnaredById) changes._ensnaredById = player._ensnaredById;
            if (!last || player._weapon8ADS !== last._weapon8ADS) changes._weapon8ADS = player._weapon8ADS;
            const basicZombieSlowCount = (player._basicZombieSlow && player._basicZombieSlow.timer > 0) ? player._basicZombieSlow.count : 0;
            const lastBasicZombieSlowCount = (last && last._basicZombieSlowCount) || 0;
            if (!last || basicZombieSlowCount !== lastBasicZombieSlowCount) changes._basicZombieSlowCount = basicZombieSlowCount;
            if (!last || player.evilProgress !== last.evilProgress) changes.evilProgress = player.evilProgress;
            if (!last || player.evilLocked !== last.evilLocked) changes.evilLocked = player.evilLocked;
            if (!last || player.isEvil !== last.isEvil) changes.isEvil = player.isEvil;
            if (!last || player.invisible !== last.invisible) changes.invisible = player.invisible;
            if (!last || player.lootLevel !== last.lootLevel) changes.lootLevel = player.lootLevel;
            if (!last || player.serverSprintActive !== last.serverSprintActive) changes.serverSprintActive = player.serverSprintActive;
            if (!last || player.mustReleaseFire !== last.mustReleaseFire) changes.mustReleaseFire = player.mustReleaseFire;
            if (!last || player.dashActive !== last.dashActive) changes.dashActive = player.dashActive;
            if (!last || player.dashDuration !== last.dashDuration) changes.dashDuration = player.dashDuration;
            if (!last || player.dashCooldown !== last.dashCooldown) changes.dashCooldown = player.dashCooldown;
            if (!last || JSON.stringify(player.equippedHat) !== JSON.stringify(last.equippedHat)) changes.equippedHat = player.equippedHat;
            
            // Only send if there are actual changes (beyond just the id)
            if (Object.keys(changes).length > 1) {
                delta.players[id] = changes;
            }
            
            // Store current state for next comparison
            this.room._lastBroadcastState.set(id, {
                x: player.x,
                y: player.y,
                health: player.health,
                healthMax: player.healthMax,
                stamina: player.stamina,
                staminaMax: player.staminaMax,
                aimAngle: player.aimAngle,
                _ensnaredTimer: player._ensnaredTimer,
                _ensnaredById: player._ensnaredById,
                _weapon8ADS: player._weapon8ADS,
                _basicZombieSlowCount: (player._basicZombieSlow && player._basicZombieSlow.timer > 0) ? player._basicZombieSlow.count : 0,
                evilProgress: player.evilProgress,
                evilLocked: player.evilLocked,
                isEvil: player.isEvil,
                invisible: player.invisible,
                lootLevel: player.lootLevel,
                serverSprintActive: player.serverSprintActive,
                mustReleaseFire: player.mustReleaseFire,
                dashActive: player.dashActive,
                dashDuration: player.dashDuration,
                dashCooldown: player.dashCooldown,
                equippedHat: player.equippedHat,
                equippedSkin: player.equippedSkin
            });
            
            if (player.lastInput && player.lastInput.sequence > maxInputSeq) {
                maxInputSeq = player.lastInput.sequence;
            }
        }
        
        delta.lastProcessedInputSeq = maxInputSeq;
        return delta;
    }

    _getEnemiesStatePayload() {
        const out = [];
        for (const e of this.room.enemies.values()) {
            // Skip dead enemies to prevent re-spawning on clients
            if (e.alive === false) continue;
            const data = { id: e.id, x: e.x, y: e.y, type: e.type };
            // Include defensive turret barrel angle for visual synchronization
            if (e.type === 'defenseTurret') {
                data._barrelAngle = e._barrelAngle || 0;
            }
            // Include artillery gun barrel angle for visual synchronization
            if (e.type === 'artilleryGun') {
                data._barrelAngle = e._barrelAngle || 0;
            }
            // Include Licker tentacle state for visual synchronization
            if (e.type === 'licker') {
                data.tentacleState = e._tentacleState || 'idle';
                data.tentacleTime = e._tentacleTime || 0;
                data._aimAngle = e._aimAngle || 0;
                data._attached = e._attached || false;
                data._targetPlayerId = e._targetPlayerId || null; // Track which player is being targeted
            }
            // Include Boomer armed state for warning ring synchronization
            if (e.type === 'boomer') {
                data._armedTimerStarted = e._armedTimerStarted || false;
                data._armedTimer = Number.isFinite(e._armedTimer) ? e._armedTimer : 0;
                data._warningActive = e._warningActive || false;
                data._closestPlayerDist = Number.isFinite(e._closestPlayerDist) ? e._closestPlayerDist : Infinity;
            }
            // Include WallGuy shield state for synchronization
            if (e.type === 'wallguy') {
                data.shieldAngle = Number.isFinite(e.shieldAngle) ? e.shieldAngle : 0;
                data._attackCooldown = Number.isFinite(e._attackCooldown) ? e._attackCooldown : 0;
            }
            // Include Artillery Witch (boss) state for visual synchronization
            if (e.type === 'boss') {
                data.health = e.health || 0;
                data.healthMax = e.healthMax || 2000;
                data.speedMul = Number.isFinite(e.speedMul) ? e.speedMul : 0;
                data._targetPlayerId = e._targetPlayerId || null;
                data._burstMode = e._burstMode || false;
                data.kbTime = Number.isFinite(e.kbTime) ? e.kbTime : 0;
            }
            out.push(data);
        }
        return out;
    }

    _getEnemiesStatePayloadForInterest(px, py, r2) {
        const out = [];
        const x0 = Number(px) || 0;
        const y0 = Number(py) || 0;
        const rad2 = Number.isFinite(r2) ? r2 : (5500 * 5500);
        for (const e of this.room.enemies.values()) {
            if (!e || e.alive === false) continue;

            // Always include bosses and static defenses so all clients stay consistent.
            const alwaysInclude = (e.type === 'boss' || e.type === 'defenseTurret' || e.type === 'artilleryGun');
            if (!alwaysInclude) {
                const dx = (Number(e.x) || 0) - x0;
                const dy = (Number(e.y) || 0) - y0;
                if (dx * dx + dy * dy > rad2) continue;
            }

            const data = { id: e.id, x: e.x, y: e.y, type: e.type };
            if (e.type === 'defenseTurret') data._barrelAngle = e._barrelAngle || 0;
            if (e.type === 'artilleryGun') data._barrelAngle = e._barrelAngle || 0;
            if (e.type === 'licker') {
                data.tentacleState = e._tentacleState || 'idle';
                data.tentacleTime = e._tentacleTime || 0;
                data._aimAngle = e._aimAngle || 0;
                data._attached = e._attached || false;
                data._targetPlayerId = e._targetPlayerId || null;
            }
            if (e.type === 'boomer') {
                data._armedTimerStarted = e._armedTimerStarted || false;
                data._armedTimer = Number.isFinite(e._armedTimer) ? e._armedTimer : 0;
                data._warningActive = e._warningActive || false;
                data._closestPlayerDist = Number.isFinite(e._closestPlayerDist) ? e._closestPlayerDist : Infinity;
            }
            if (e.type === 'wallguy') {
                data.shieldAngle = Number.isFinite(e.shieldAngle) ? e.shieldAngle : 0;
                data._attackCooldown = Number.isFinite(e._attackCooldown) ? e._attackCooldown : 0;
            }
            if (e.type === 'boss') {
                data.health = e.health || 0;
                data.healthMax = e.healthMax || 2000;
                data.speedMul = Number.isFinite(e.speedMul) ? e.speedMul : 0;
                data._targetPlayerId = e._targetPlayerId || null;
                data._burstMode = e._burstMode || false;
                data.kbTime = Number.isFinite(e.kbTime) ? e.kbTime : 0;
            }

            out.push(data);
        }
        return out;
    }

    // Phase 3: New consolidated entity replication format
    // Returns { entities: [...], timestamp: number }
    _getEntitiesStatePayload() {
        if (!this.Protocol.FEATURES.DUAL_EMIT_ENTITIES) {
            // Feature flag disabled, return empty
            return { entities: [], timestamp: Date.now() };
        }
        
        const entities = [];
        
        // Include enemies if feature flag enabled
        if (this.Protocol.FEATURES.ENTITIES_INCLUDE_ENEMIES) {
            for (const e of this.room.enemies.values()) {
                if (e.alive === false) continue;
                
                // Wrap enemy data in entity envelope
                const data = { id: e.id, x: e.x, y: e.y, type: e.type };
                
                // Include type-specific state (same as legacy enemiesState)
                if (e.type === 'defenseTurret') data._barrelAngle = e._barrelAngle || 0;
                if (e.type === 'artilleryGun') data._barrelAngle = e._barrelAngle || 0;
                if (e.type === 'licker') {
                    data.tentacleState = e._tentacleState || 'idle';
                    data.tentacleTime = e._tentacleTime || 0;
                    data._aimAngle = e._aimAngle || 0;
                    data._attached = e._attached || false;
                    data._targetPlayerId = e._targetPlayerId || null;
                }
                if (e.type === 'boomer') {
                    data._armedTimerStarted = e._armedTimerStarted || false;
                    data._armedTimer = Number.isFinite(e._armedTimer) ? e._armedTimer : 0;
                    data._warningActive = e._warningActive || false;
                    data._closestPlayerDist = Number.isFinite(e._closestPlayerDist) ? e._closestPlayerDist : Infinity;
                }
                if (e.type === 'wallguy') {
                    data.shieldAngle = Number.isFinite(e.shieldAngle) ? e.shieldAngle : 0;
                    data._attackCooldown = Number.isFinite(e._attackCooldown) ? e._attackCooldown : 0;
                }
                if (e.type === 'boss') {
                    data.health = e.health || 0;
                    data.healthMax = e.healthMax || 2000;
                    data.speedMul = Number.isFinite(e.speedMul) ? e.speedMul : 0;
                    data._targetPlayerId = e._targetPlayerId || null;
                    data._burstMode = e._burstMode || false;
                    data.kbTime = Number.isFinite(e.kbTime) ? e.kbTime : 0;
                }
                
                entities.push({
                    entityType: this.Protocol.EntityType.ENEMY,
                    entityId: e.id,
                    data: data
                });
            }
        }
        
        // Future: include NPCs, troops, hazards when their feature flags are enabled
        
        return {
            entities: entities,
            timestamp: Date.now()
        };
    }
    
    _getEntitiesStatePayloadForInterest(px, py, r2) {
        if (!this.Protocol.FEATURES.DUAL_EMIT_ENTITIES) {
            return { entities: [], timestamp: Date.now() };
        }
        
        const entities = [];
        const x0 = Number(px) || 0;
        const y0 = Number(py) || 0;
        const rad2 = Number.isFinite(r2) ? r2 : (5500 * 5500);
        
        // Include enemies if feature flag enabled
        if (this.Protocol.FEATURES.ENTITIES_INCLUDE_ENEMIES) {
            for (const e of this.room.enemies.values()) {
                if (!e || e.alive === false) continue;
                
                // Same interest-based filtering as legacy enemiesState
                const alwaysInclude = (e.type === 'boss' || e.type === 'defenseTurret' || e.type === 'artilleryGun');
                if (!alwaysInclude) {
                    const dx = (Number(e.x) || 0) - x0;
                    const dy = (Number(e.y) || 0) - y0;
                    if (dx * dx + dy * dy > rad2) continue;
                }
                
                const data = { id: e.id, x: e.x, y: e.y, type: e.type };
                if (e.type === 'defenseTurret') data._barrelAngle = e._barrelAngle || 0;
                if (e.type === 'artilleryGun') data._barrelAngle = e._barrelAngle || 0;
                if (e.type === 'licker') {
                    data.tentacleState = e._tentacleState || 'idle';
                    data.tentacleTime = e._tentacleTime || 0;
                    data._aimAngle = e._aimAngle || 0;
                    data._attached = e._attached || false;
                    data._targetPlayerId = e._targetPlayerId || null;
                }
                if (e.type === 'boomer') {
                    data._armedTimerStarted = e._armedTimerStarted || false;
                    data._armedTimer = Number.isFinite(e._armedTimer) ? e._armedTimer : 0;
                    data._warningActive = e._warningActive || false;
                    data._closestPlayerDist = Number.isFinite(e._closestPlayerDist) ? e._closestPlayerDist : Infinity;
                }
                if (e.type === 'wallguy') {
                    data.shieldAngle = Number.isFinite(e.shieldAngle) ? e.shieldAngle : 0;
                    data._attackCooldown = Number.isFinite(e._attackCooldown) ? e._attackCooldown : 0;
                }
                if (e.type === 'boss') {
                    data.health = e.health || 0;
                    data.healthMax = e.healthMax || 2000;
                    data.speedMul = Number.isFinite(e.speedMul) ? e.speedMul : 0;
                    data._targetPlayerId = e._targetPlayerId || null;
                    data._burstMode = e._burstMode || false;
                    data.kbTime = Number.isFinite(e.kbTime) ? e.kbTime : 0;
                }
                
                entities.push({
                    entityType: this.Protocol.EntityType.ENEMY,
                    entityId: e.id,
                    data: data
                });
            }
        }
        
        return {
            entities: entities,
            timestamp: Date.now()
        };
    }

    // =========================================
    // BROADCAST METHODS (Send state to clients)
    // =========================================

    broadcastGameState() {
        if (this.room.players.size > 0) {
            // Back to full state updates (delta system had player removal bugs)
            const gameState = this.getGameState();
            this.serverDebugger.gameStateUpdate(this.room.id, this.room.players.size, this.room.tickCount);

            let payloadBytes = 0;
            if (this.DEBUG_BUILD && typeof Buffer !== 'undefined' && typeof Buffer.byteLength === 'function') {
                try {
                    payloadBytes = Buffer.byteLength(JSON.stringify(gameState), 'utf8');
                } catch (err) {
                    this.serverDebugger.warn('NETWORKING', `[NET] Failed to measure payload for room ${this.room.id}`, {
                        error: err && err.message ? err.message : String(err)
                    });
                }
            }

            this.io.to(this.room.id).emit('gameState', gameState);
            this.serverDebugger.roomBroadcast(this.room.id, this.room.players.size, payloadBytes);
        }
    }
    
    // Broadcast low-priority state (10Hz) for non-critical data like timers, chests, UI
    broadcastLowPriorityState() {
        // Only broadcast if there are players in the room
        if (this.room.players.size === 0) return;
        
        // Ready timer updates (lobby countdown)
        if (this.room.readyTimer && this.room.readyTimer.started && !this.room.readyTimer.completed) {
            this.room.emitReadyTimerState();
        }
        
        // Chest timer updates (gold chest opening progress)
        for (const chest of this.room.chests.values()) {
            if (chest.opening && !chest.opened && chest.variant !== 'brown') {
                // Chest timers are already broadcast in tick() - we could move them here
                // but for now, just ensure we're not duplicating
            }
        }
        
        // Ambient spawner state (for debug HUD)
        try {
            if (this.room.ambientSpawner) {
                const st = this.room.ambientSpawner.getDebugState();
                this.io.to(this.room.id).emit('ambientState', st);
            }
        } catch(_) {}

        // Could add other low-priority updates here:
        // - Target dummy regen status
        // - NPC ambient animations/states
        // - Environmental effects that aren't time-critical
    }

    broadcastEnemiesState() {
        // Phase 3: Dual-emit mode - send both legacy (enemiesState) and new (entitiesState)
        // Interest-based enemies replication:
        // - Most ticks: send each client only nearby enemies (full per-enemy state, no deltas).
        // - Periodically: send a full refresh to the whole room for robustness.
        const now = Date.now();
        const FULL_REFRESH_MS = 2000;
        if (!this.room._lastEnemiesStateFullAt || (now - this.room._lastEnemiesStateFullAt) >= FULL_REFRESH_MS) {
            this.room._lastEnemiesStateFullAt = now;
            
            // Legacy event (will be removed after migration)
            this.io.to(this.room.id).emit('enemiesState', this._getEnemiesStatePayload());
            
            // Phase 3: New consolidated event (active if feature flag enabled)
            if (this.Protocol.FEATURES.DUAL_EMIT_ENTITIES) {
                this.io.to(this.room.id).emit('entitiesState', this._getEntitiesStatePayload());
            }
            return;
        }

        const INTEREST_RADIUS = 5500; // generous radius to prevent popping in fast-paced play
        const r2 = INTEREST_RADIUS * INTEREST_RADIUS;
        for (const [, p] of this.room.players) {
            if (!p || !p.socket) continue;
            try {
                // Legacy event (will be removed after migration)
                p.socket.emit('enemiesState', this._getEnemiesStatePayloadForInterest(p.x, p.y, r2));
                
                // Phase 3: New consolidated event (active if feature flag enabled)
                if (this.Protocol.FEATURES.DUAL_EMIT_ENTITIES) {
                    p.socket.emit('entitiesState', this._getEntitiesStatePayloadForInterest(p.x, p.y, r2));
                }
            } catch (_) {}
        }
    }

    broadcastAmbientNpcs() {
        this.io.to(this.room.id).emit('ambientNpcsSync', this.room.ambientNpcs);
    }
}

module.exports = NetworkManager;
