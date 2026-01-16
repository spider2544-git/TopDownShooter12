// Client-side networking layer for multiplayer
// Hard-off debug build flag (performance): keep debug code, but don't run it unless explicitly enabled in code.
// NOTE: This file is loaded as a classic script (shared global scope). Don't use top-level `const DEBUG_BUILD`.
var __DEBUG_BUILD = (typeof window !== 'undefined' && window.DEBUG_BUILD === true);

class NetworkManager {
    constructor() {
        this.socket = null;
        this.connected = false;
        this.roomId = null;
        this.playerId = null;
        this.otherPlayers = new Map();
        this.gameState = null;
        this.inputSequence = 0;
        this.lastInputTime = 0;
        
        // Network message batching for 30-40% bandwidth reduction
        this.batcher = null;
        
        // Artifact carrier tracking (server-authoritative)
        this.artifactCarrierId = null;
        
        // Input throttling - increased to 60Hz for better responsiveness
        this.INPUT_RATE = 60; // 60 Hz input rate to match server
        this.inputInterval = 1000 / this.INPUT_RATE;
        
        // Client-side prediction
        this.inputBuffer = new Map(); // Store sent inputs for rollback
        this.serverPosition = { x: 0, y: 0 }; // Last confirmed server position
        this.lastServerUpdate = 0;
        this.reconciliationThreshold = 10; // Distance threshold for corrections
        this.smoothCorrectionFactor = 0.1; // How aggressively to correct (0.1 = gentle)
        
        // Connection callbacks
        this.onConnected = null;
        this.onDisconnected = null;
        this.onGameStateUpdate = null;
        this.onPlayerJoined = null;
        this.onPlayerLeft = null;
        this.onWorldSeedReceived = null;
        
        // World seed state
        this.worldSeed = null;
        this.worldSeedReceived = false;

        // Networking telemetry diagnostics
        this.netMetrics = {
            lastTick: null,
            lastSnapshotAt: null,
            lastLogTime: 0,
            logIntervalMs: 2000,
            drift: { min: Infinity, max: -Infinity, total: 0, count: 0 },
            arrival: { min: Infinity, max: -Infinity, total: 0, count: 0 },
            tickGap: { min: Infinity, max: -Infinity, total: 0, count: 0 },
            missedTicks: 0,
            tickGapOutOfOrder: 0
        };

        this._lastAmbientSyncSignature = null;
        // Weapon 9 sync debug flag (enable to trace hit relay end-to-end)
        if (typeof window !== 'undefined' && window.DEBUG_WEAPON9_SYNC == null) {
            window.DEBUG_WEAPON9_SYNC = __DEBUG_BUILD;
        }
        
        // Remote player hit flash tracking
        this.remoteHitFlashPlayers = new Map(); // Map<playerId, { hitFlash: number, previousHealth: number }>
        
        // Phase 3: Tracking for dual-listen mode (entitiesState vs enemiesState)
        this._receivedEntitiesState = false;
        this._lastEntitiesStateAt = null;
    }
    
    // Phase 3: Helper to process enemy updates (used by both enemiesState and entitiesState handlers)
    _processEnemyUpdate(s) {
        if (!s || !s.id) return;
        if (!window._enemyByServerId) return;
        const now = Date.now();
        
        // Get or create enemy instance
        let ent = window._enemyByServerId.get(s.id);
        if (!ent) {
            ent = this._ensureEnemyInstance(s);
            if (!ent) return;
        }
        
        // Update network smoothing state
        if (!ent._net) ent._net = {};
        ent._net.tx = s.x;
        ent._net.ty = s.y;
        ent._net.ts = now;
        
        // Apply type-specific state synchronization
        if (window.Licker && ent instanceof window.Licker) {
            if (s.tentacleState !== undefined) ent.tentacleState = s.tentacleState;
            if (s.tentacleTime !== undefined) ent.tentacleTime = s.tentacleTime;
            if (s._aimAngle !== undefined) ent._aimAngle = s._aimAngle;
            if (s._attached !== undefined) ent._attached = s._attached;
            if (s._targetPlayerId !== undefined) ent._targetPlayerId = s._targetPlayerId;
        }
        
        if (window.Boomer && ent instanceof window.Boomer) {
            if (s._armedTimerStarted !== undefined) ent._armedTimerStarted = s._armedTimerStarted;
            if (s._armedTimer !== undefined) ent._armedTimer = s._armedTimer;
            if (s._warningActive !== undefined) ent._warningActive = s._warningActive;
            if (s._closestPlayerDist !== undefined) ent._closestPlayerDist = s._closestPlayerDist;
        }
        
        if (ent.type === 'defenseTurret' && s._barrelAngle !== undefined) {
            ent._barrelAngle = s._barrelAngle;
        }
        
        if (ent.type === 'artilleryGun' && s._barrelAngle !== undefined) {
            ent._barrelAngle = s._barrelAngle;
        }
        
        if (window.WallGuy && ent instanceof window.WallGuy) {
            if (s.shieldAngle !== undefined) {
                if (!ent._net) ent._net = {};
                ent._net.targetShieldAngle = s.shieldAngle;
                if (ent.shieldAngle === undefined) ent.shieldAngle = s.shieldAngle;
            }
            if (s._attackCooldown !== undefined) ent._attackCooldown = s._attackCooldown;
        }
        
        if (window.ArtilleryWitch && ent instanceof window.ArtilleryWitch) {
            if (s.speedMul !== undefined) ent.speedMul = s.speedMul;
            if (s._targetPlayerId !== undefined) ent._targetPlayerId = s._targetPlayerId;
            if (s._burstMode !== undefined) ent._burstMode = s._burstMode;
            if (s.kbTime !== undefined) ent.kbTime = s.kbTime;
        }
    }
    
    // Phase 3: Helper to ensure enemy instance exists (create if missing)
    _ensureEnemyInstance(s) {
        try {
            if (!s || !s.id) return null;
            if (!window._enemyByServerId || !window.enemies || !window.enemies.items) return null;
            const existing = window._enemyByServerId.get(s.id);
            if (existing) return existing;

            const Cls = (typeof window.Enemy === 'function') ? window.Enemy : (typeof Enemy === 'function' ? Enemy : null);
            if (!Cls) return null;

            let inst = null;
            if (s.type === 'targetDummy' && window.TargetDummy) inst = new window.TargetDummy(s.x, s.y);
            else if (s.type === 'boss' && window.ArtilleryWitch) inst = new window.ArtilleryWitch(s.x, s.y);
            else if (s.type === 'projectile' && window.ProjectileZombie) inst = new window.ProjectileZombie(s.x, s.y);
            else if (s.type === 'boomer' && window.Boomer) inst = new window.Boomer(s.x, s.y);
            else if (s.type === 'licker' && window.Licker) inst = new window.Licker(s.x, s.y);
            else if (s.type === 'bigboy' && window.BigBoy) inst = new window.BigBoy(s.x, s.y);
            else inst = new Cls(s.x, s.y);

            inst._serverId = s.id;
            inst.serverSpawned = true;
            try { if (s.type !== undefined) inst.type = s.type; } catch(_) {}
            try { if (s.radius !== undefined) inst.radius = s.radius; } catch(_) {}

            window.enemies.items.push(inst);
            if (typeof window.enemies._insert === 'function') window.enemies._insert(inst);
            window._enemyByServerId.set(s.id, inst);
            return inst;
        } catch (_) {
            return null;
        }
    }
    
    // Phase 2.4: Smooth client prediction errors instead of snapping (eliminates jitter)
    reconcileServerPosition(localPlayer, serverX, serverY) {
        if (!localPlayer || typeof serverX !== 'number' || typeof serverY !== 'number') return;
        
        const errorX = serverX - localPlayer.x;
        const errorY = serverY - localPlayer.y;
        const errorDist = Math.sqrt(errorX * errorX + errorY * errorY);
        
        // During dash, use much more aggressive smoothing to reduce jitter from high-speed movement
        const isDashing = !!(localPlayer.dashActive && localPlayer.dashDuration > 0);
        
        // Threshold for correction
        const SNAP_THRESHOLD = isDashing ? 10 : 5;    // Higher tolerance during dash
        const TELEPORT_THRESHOLD = isDashing ? 300 : 150; // Higher threshold during dash (moving very fast)
        const SMOOTH_RATE = isDashing ? 0.6 : 0.25;    // Much more aggressive smoothing during dash
        
        if (errorDist < SNAP_THRESHOLD) {
            // Error is negligible, client prediction is accurate - do nothing
            return;
        } else if (errorDist > TELEPORT_THRESHOLD) {
            // Error is huge (desync or teleport), snap immediately
            localPlayer.x = serverX;
            localPlayer.y = serverY;
            // Only log significant teleports to avoid spam
            if (errorDist > 300) {
                console.log(`[Prediction] Large error detected (${errorDist.toFixed(0)}px), snapping to server position`);
            }
        } else {
            // Smooth correction over multiple frames to eliminate visible jitter
            // During dash, apply velocity-based smoothing for even smoother movement
            if (isDashing) {
                // Store velocity for smooth interpolation
                localPlayer._dashSmoothVelX = errorX * SMOOTH_RATE;
                localPlayer._dashSmoothVelY = errorY * SMOOTH_RATE;
                localPlayer.x += localPlayer._dashSmoothVelX;
                localPlayer.y += localPlayer._dashSmoothVelY;
            } else {
                localPlayer.x += errorX * SMOOTH_RATE;
                localPlayer.y += errorY * SMOOTH_RATE;
            }
        }
    }
    
    // Smooth rotation/aimAngle to prevent choppy rotation at 30Hz updates
    reconcileServerRotation(localPlayer, serverAimAngle) {
        if (!localPlayer || typeof serverAimAngle !== 'number') return;
        if (typeof localPlayer.aimAngle !== 'number') {
            localPlayer.aimAngle = serverAimAngle;
            return;
        }
        
        // Calculate shortest angular distance (handle wrap-around)
        let angleDiff = serverAimAngle - localPlayer.aimAngle;
        
        // Normalize to [-PI, PI]
        while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
        while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
        
        const ROTATION_SNAP_THRESHOLD = 0.05; // ~3 degrees
        const ROTATION_SMOOTH_RATE = 0.35;    // 35% per frame (more responsive for rotation)
        
        if (Math.abs(angleDiff) < ROTATION_SNAP_THRESHOLD) {
            // Very small difference, no correction needed
            return;
        } else {
            // Smooth rotation correction
            localPlayer.aimAngle += angleDiff * ROTATION_SMOOTH_RATE;
            
            // Normalize to [0, 2*PI] or [-PI, PI] depending on your system
            localPlayer.aimAngle = (localPlayer.aimAngle + Math.PI * 2) % (Math.PI * 2);
        }
    }
    
    connect(roomId = null) {
        // Debug: persistent page identifier for this browser tab/window.
        // Helps diagnose "extra players" caused by multiple client instances connecting.
        try {
            if (!window.__mpPageId) {
                window.__mpPageId = Math.random().toString(16).slice(2);
            }
        } catch (_) {}

        // Guard: prevent duplicate socket connections from the same page instance.
        // (This can happen if connect() gets called twice during bootstrap/retry flows.)
        try {
            if (this.socket && (this.socket.connected || this.socket.connecting)) {
                console.warn('[Network] connect() ignored (already connected/connecting)', {
                    pageId: (typeof window !== 'undefined' ? window.__mpPageId : undefined),
                    href: (typeof window !== 'undefined' && window.location ? window.location.href : undefined)
                });
                return;
            }
        } catch (_) {}

        // Get room from URL parameter or use provided roomId
        const urlParams = new URLSearchParams(window.location.search);
        this.roomId = roomId || urlParams.get('room') || 'default';
        
        const __href = (typeof window !== 'undefined' && window.location ? window.location.href : undefined);
        console.log('[Network] Connecting to room:', this.roomId, '| pageId:', (typeof window !== 'undefined' ? window.__mpPageId : undefined), '| href:', __href);
        
        // Include pageId/href in Socket.IO handshake auth so the server can attribute connections.
        // This is purely for debugging "mystery local clients".
        this.socket = io({
            auth: {
                pageId: (typeof window !== 'undefined' ? window.__mpPageId : undefined),
                href: __href
            }
        });
        
        // NFC Status event - weapon8 is always locked by default
        // Unlock via NFC tag (bridge) or double-tap "." keyboard
        this.socket.on('nfcStatus', (status) => {
            console.log('[Network] NFC Status received:', status);
            // Weapon8 always starts locked - only unlocks via nfcUnlock event
            if (window.weapon8Unlocked !== true) {
                window.weapon8Unlocked = false;
                console.log('[NFC] Weapon8 locked - unlock via NFC tag or double-tap "."');
            }
        });
        
        this.socket.on('connect', () => {
            console.log('[Network] Connected to server');
            this.connected = true;
            this.playerId = this.socket.id;
            
            // Initialize network message batching (30-40% bandwidth reduction)
            if (typeof window.NetworkBatcher !== 'undefined') {
                this.batcher = new window.NetworkBatcher(16, this.socket); // 60Hz batching
                console.log('[Network] Message batching initialized');
            } else {
                console.warn('[Network] NetworkBatcher not available - running without batching');
            }
            
            if (window.gameDebugger) {
                window.gameDebugger.networkMessage('CONNECT', this.playerId, { roomId: this.roomId });
            }
            
            // Join the room with player data including environment info
            const environment = window.environment;
            const scene = window.scene;
            
            this.socket.emit('joinRoom', {
                roomId: this.roomId,
                playerData: {
                    x: window.player ? window.player.x : 0,
                    y: window.player ? window.player.y : 0,
                    radius: window.player ? window.player.radius : 20,
                    speed: window.player ? window.player.speed : 220,
                    health: window.player ? window.player.health : 100,
                    healthMax: window.player ? window.player.healthMax : 100,
                    boundary: environment ? environment.boundary : 1000,
                    scene: scene ? scene.current : 'lobby'
                }
            });
            
            console.log('[Network] Joining room with boundary:', environment ? environment.boundary : 1000);
            
            if (this.onConnected) {
                this.onConnected();
            }
        });
        
        this.socket.on('disconnect', (reason) => {
            console.log('[Network] Disconnected from server:', reason);
            this.connected = false;
            this.otherPlayers.clear();
            
            // Cleanup message batcher
            if (this.batcher) {
                this.batcher.destroy();
                this.batcher = null;
                console.log('[Network] Message batching cleaned up');
            }
            
            if (window.gameDebugger) {
                window.gameDebugger.networkMessage('DISCONNECT', this.playerId, { reason });
            }
            
            if (this.onDisconnected) {
                this.onDisconnected(reason);
            }
        });
        
        this.socket.on('connect_error', (error) => {
            console.error('[Network] Connection error:', error);
        });
        
        this.socket.on('error', (error) => {
            console.error('[Network] Socket error:', error);
        });
        
        // Listen for dash feedback (out of stamina message)
        this.socket.on('dashFeedback', (data) => {
            if (window.player && data.message) {
                const timestamp = Date.now();
                window.player.dashFeedbackText = data.message;
                window.player.dashFeedbackTimer = 1.5; // Show for 1.5 seconds
                
                const latency = window._dashTracking && window._dashTracking.requestTime ? 
                    (timestamp - window._dashTracking.requestTime) : 'unknown';
                console.log(`[Client] [${timestamp}] ❌ DASH FEEDBACK from server: "${data.message}" | Latency: ${latency}ms | Current stamina: ${window.player.stamina.toFixed(1)}`);
                
                // Clear tracking on failure
                window._dashTracking = {};
            }
        });
        
        this.socket.on('gameState', (state) => {
            const receivedAt = Date.now();
            this.gameState = state;
            this.lastServerUpdate = receivedAt;
            this.recordNetworkDiagnostics(state, receivedAt);
            
            // Update other players with new snapshot system
            if (state.players) {
                this.updateOtherPlayers(state.players);
            }
            
            // gameState trimmed: static data handled by roomSnapshot and discrete events
            
            // Sync local player's server-authoritative state
            if (state.players && window.player) {
                const localPlayerData = state.players.find(p => p.id === this.playerId);
                if (localPlayerData) {
                    // Sync health (server-authoritative damage) with respawnPending guard
                    if (localPlayerData.health !== undefined) {
                        const pending = !!(window.state && window.state.respawnPending);
                        if (!pending || (localPlayerData.health > 0)) {
                        const healthBefore = window.player.health;
                        const healthMaxBefore = window.player.healthMax;
                        window.player.health = localPlayerData.health;
                        window.player.healthMax = localPlayerData.healthMax;
                        // Sync downed timestamp (used for revive countdown UI)
                        try {
                            if (typeof localPlayerData.downedAt === 'number') {
                                window.player.downedAt = localPlayerData.downedAt;
                            } else if (window.player.health > 0) {
                                window.player.downedAt = 0;
                            }
                        } catch(_) {}
                        // Sync remaining revive start window (pauses while being revived; freezes once ready)
                        try {
                            if (typeof localPlayerData.reviveWindowRemainingMs === 'number') {
                                window.player.reviveWindowRemainingMs = localPlayerData.reviveWindowRemainingMs;
                            } else if (window.player.health > 0) {
                                window.player.reviveWindowRemainingMs = 0;
                            }
                        } catch(_) {}
                        
                        // Log health changes (including healthMax increases from loot)
                        if (healthMaxBefore !== localPlayerData.healthMax) {
                            console.log(`[Network] HealthMax changed: ${healthMaxBefore} → ${localPlayerData.healthMax} | Current HP: ${localPlayerData.health}`);
                        }
                        
                        // If health decreased from server, trigger ALL damage effects (hit flash, screen shake, vignette)
                        // BUT: Exclude cases where healthMax changed (loot pickup or stale server data)
                        if (typeof healthBefore === 'number' && localPlayerData.health < healthBefore && localPlayerData.health > 0 && localPlayerData.healthMax === healthMaxBefore) {
                            const delta = healthBefore - localPlayerData.health;
                            const frac = Math.min(1, delta / Math.max(1, localPlayerData.healthMax || 100));
                            
                            // Trigger hit flash
                            try {
                                const canFlash = (!window.player.hitFlash || window.player.hitFlash <= 0) && 
                                               (!window.player.hitFlashCooldown || window.player.hitFlashCooldown <= 0);
                                if (canFlash && typeof window.player.hitFlashMax === 'number') {
                                    window.player.hitFlash = window.player.hitFlashMax;
                                    window.player.hitFlashCooldown = window.player.hitFlashGap || 0.07;
                                }
                            } catch(e) { 
                                console.error('❌ [Network] Hit flash error:', e); 
                            }
                            
                            // Queue damage event for shake/vignette (processed in main update loop)
                            try {
                                if (window.enqueueDamageEvent && typeof window.enqueueDamageEvent === 'function') {
                                    let shakeScale = 1;
                                    if (window.player) {
                                        const ensnared = !!(
                                            (window.player._ensnaredById != null) ||
                                            (window.player._ensnaredBy && typeof window.player._ensnaredBy.size === 'number' && window.player._ensnaredBy.size > 0)
                                        );
                                        if (ensnared) shakeScale = 2;
                                    }
                                    window.enqueueDamageEvent(delta, { source: 'network', shakeScale });
                                } else {
                                    console.error('❌ [Network] enqueueDamageEvent NOT FOUND!');
                                }
                            } catch(e) {
                                console.error('❌ [Network] Damage event queue error:', e);
                            }
                        }
                        }
                    }
                    // Sync stamina state
                    if (localPlayerData.stamina !== undefined) {
                        window.player.stamina = localPlayerData.stamina;
                        window.player.staminaMax = localPlayerData.staminaMax;
                        window.player.exhaustionTimer = localPlayerData.exhaustionTimer;
                        window.player.mustReleaseShift = localPlayerData.mustReleaseShift;
                        window.player.mustReleaseFire = localPlayerData.mustReleaseFire;
                        // Use server sprint state to override client calculation
                        window.player._serverSprintActive = localPlayerData.serverSprintActive;
                    }
                    // Sync dash state
                    if (localPlayerData.dashActive !== undefined) {
                        const wasActive = window.player.dashActive;
                        window.player.dashActive = localPlayerData.dashActive;
                        window.player.dashDuration = localPlayerData.dashDuration;
                        window.player.dashCooldown = localPlayerData.dashCooldown;
                        
                        // Track dash activation from server
                        if (!wasActive && localPlayerData.dashActive) {
                            const timestamp = Date.now();
                            const latency = window._dashTracking && window._dashTracking.requestTime ? 
                                (timestamp - window._dashTracking.requestTime) : 'unknown';
                            console.log(`[Client] [${timestamp}] ✅ DASH ACTIVATED (from server) | Position: (${window.player.x.toFixed(1)}, ${window.player.y.toFixed(1)}) | Duration: ${localPlayerData.dashDuration}s | Latency: ${latency}ms`);
                            
                            if (window._dashTracking && window._dashTracking.requestPos) {
                                const dx = window.player.x - window._dashTracking.requestPos.x;
                                const dy = window.player.y - window._dashTracking.requestPos.y;
                                const drift = Math.hypot(dx, dy);
                                console.log(`[Client] Position drift since request: ${drift.toFixed(1)} units | Request: (${window._dashTracking.requestPos.x.toFixed(1)}, ${window._dashTracking.requestPos.y.toFixed(1)}) | Now: (${window.player.x.toFixed(1)}, ${window.player.y.toFixed(1)})`);
                            }
                            
                            // Store start position for end tracking
                            if (!window._dashTracking) window._dashTracking = {};
                            window._dashTracking.startTime = timestamp;
                            window._dashTracking.startPos = { x: window.player.x, y: window.player.y };
                        }
                        
                        // Track dash deactivation from server
                        if (wasActive && !localPlayerData.dashActive) {
                            const timestamp = Date.now();
                            console.log(`[Client] [${timestamp}] 🏁 DASH ENDED (from server) | Position: (${window.player.x.toFixed(1)}, ${window.player.y.toFixed(1)})`);
                            
                            if (window._dashTracking && window._dashTracking.startPos) {
                                const dx = window.player.x - window._dashTracking.startPos.x;
                                const dy = window.player.y - window._dashTracking.startPos.y;
                                const distance = Math.hypot(dx, dy);
                                const duration = window._dashTracking.startTime ? (timestamp - window._dashTracking.startTime) : 'unknown';
                                console.log(`[Client] Total dash movement: ${distance.toFixed(1)} units in ${duration}ms | Start: (${window._dashTracking.startPos.x.toFixed(1)}, ${window._dashTracking.startPos.y.toFixed(1)}) | End: (${window.player.x.toFixed(1)}, ${window.player.y.toFixed(1)})`);
                            }
                            
                            // Clear tracking
                            window._dashTracking = {};
                        }
                    }
                    // Sync weapon 8 ADS slow state from server
                    if (localPlayerData._weapon8ADS !== undefined) {
                        window.player._weapon8ADS = localPlayerData._weapon8ADS;
                    }
                    // Sync ensnare state from server (overrides any client-side events)
                    if (localPlayerData._ensnaredTimer !== undefined) {
                        window.player._ensnaredTimer = localPlayerData._ensnaredTimer;
                        window.player._ensnaredById = localPlayerData._ensnaredById;
                        
                        // Sync the full _ensnaredBy Map for client-side contact damage detection
                        if (localPlayerData._ensnaredByMap) {
                            const mapSize = Object.keys(localPlayerData._ensnaredByMap).length;
                            // console.log('🗺️ [Snapshot] Received _ensnaredByMap:', localPlayerData._ensnaredByMap, 'entries:', mapSize);
                            if (!window.player._ensnaredBy) window.player._ensnaredBy = new Map();
                            window.player._ensnaredBy.clear();
                            for (const [id, timer] of Object.entries(localPlayerData._ensnaredByMap)) {
                                window.player._ensnaredBy.set(parseInt(id), timer);
                            }
                            // console.log('🗺️ [Snapshot] Final Map size after sync:', window.player._ensnaredBy.size);
                        }
                    }
                    // Sync derived stats from server inventory calculations
                    // Note: Skip speed sync for local player - it's calculated from inventory client-side
                    // and we don't want to overwrite local movement slow calculations (ADS, ensnare, etc.)
                    // if (localPlayerData.speed !== undefined) {
                    //     window.player.speed = localPlayerData.speed;
                    // }
                    if (localPlayerData.armor !== undefined) {
                        window.player.armor = localPlayerData.armor;
                    }
                    if (localPlayerData.attackSpeed !== undefined) {
                        window.player.attackSpeed = localPlayerData.attackSpeed;
                    }
                    if (localPlayerData.attackPower !== undefined) {
                        window.player.attackPower = localPlayerData.attackPower;
                    }
                    if (localPlayerData.critChance !== undefined) {
                        window.player.critChance = localPlayerData.critChance;
                    }
                    if (localPlayerData.critDamageMultiplier !== undefined) {
                        window.player.critDamageMultiplier = localPlayerData.critDamageMultiplier;
                    }
                    
                    // Sync currency (ducats, blood markers, and victory points)
                    if (localPlayerData.ducats !== undefined) {
                        if (window.player.ducats !== localPlayerData.ducats) {
                            console.log('[Network] Ducats updated:', window.player.ducats, '→', localPlayerData.ducats);
                        }
                        window.player.ducats = localPlayerData.ducats;
                    }
                    if (localPlayerData.bloodMarkers !== undefined) {
                        if (window.player.bloodMarkers !== localPlayerData.bloodMarkers) {
                            console.log('[Network] Blood Markers updated:', window.player.bloodMarkers, '→', localPlayerData.bloodMarkers);
                        }
                        window.player.bloodMarkers = localPlayerData.bloodMarkers;
                    }
                    if (localPlayerData.victoryPoints !== undefined) {
                        if (window.player.victoryPoints !== localPlayerData.victoryPoints) {
                            console.log('[Network] Victory Points updated:', window.player.victoryPoints, '→', localPlayerData.victoryPoints);
                        }
                        window.player.victoryPoints = localPlayerData.victoryPoints;
                    }
                    
                    // Sync equipped hat (cosmetic)
                    if (localPlayerData.equippedHat !== undefined) {
                        window.player.equippedHat = localPlayerData.equippedHat;
                    }
                    
                    // Sync equipped skin (cosmetic)
                    if (localPlayerData.equippedSkin !== undefined) {
                        window.player.equippedSkin = localPlayerData.equippedSkin;
                    }
                    
                    // Sync breadcrumb trail
                    if (localPlayerData.breadcrumbs !== undefined) {
                        window.player.breadcrumbs = localPlayerData.breadcrumbs;
                    }
                    
                    // Sync loot level (inventory count)
                    if (localPlayerData.lootLevel !== undefined) {
                        const prevLootLevel = window.player.lootLevel || 0;
                        window.player.lootLevel = localPlayerData.lootLevel;
                        
                        // Show notification when loot level changes (LOCAL PLAYER ONLY)
                        // Suppress notification when dead or when dropping to 0 (death drop)
                        const isDead = window.player.health <= 0;
                        const isDeathDrop = localPlayerData.lootLevel === 0 && prevLootLevel > 0;
                        
                        if (localPlayerData.lootLevel !== prevLootLevel && !isDead && !isDeathDrop) {
                            // Determine if this is an upgrade (pickup) or downgrade (drop)
                            const isUpgrade = localPlayerData.lootLevel > prevLootLevel;
                            
                            // For upgrades: show what you gained (new level)
                            // For downgrades: show what you lost (previous level)
                            const levelToCheck = isUpgrade ? localPlayerData.lootLevel : prevLootLevel;
                            const upgradeInfo = window.player.getLootUpgradeInfo(levelToCheck);
                            
                            if (upgradeInfo) {
                                // Build notification text (shortened for cleaner look)
                                const notificationText = `${upgradeInfo.type} Lvl ${upgradeInfo.level}`;
                                
                                // Update notification with animation state
                                window.player.lootNotificationText = notificationText;
                                window.player.lootNotificationTimer = 1.5; // Show for 1.5 seconds
                                window.player.lootNotificationType = isUpgrade ? 'up' : 'down';
                                window.player.lootNotificationStartTime = Date.now();
                                
                                console.log(`[Loot] ${isUpgrade ? 'Picked up' : 'Dropped'}: ${notificationText}`);
                            }
                        }
                    }

                    // Sync Quartermaster one-time requisition flag (server-authoritative)
                    try {
                        if (localPlayerData.qmGrantedSupplies !== undefined) {
                            window.dialogueFlags = window.dialogueFlags || {};
                            window.dialogueFlags.qmGrantedSupplies = !!localPlayerData.qmGrantedSupplies;
                        }
                    } catch(_) {}
                    
                    // Phase 2.4: Smooth position reconciliation to prevent drift and jitter
                    if (localPlayerData.x !== undefined && localPlayerData.y !== undefined) {
                        this.reconcileServerPosition(window.player, localPlayerData.x, localPlayerData.y);
                    }
                    
                    // Smooth rotation to prevent choppy turning at 30Hz
                    if (localPlayerData.aimAngle !== undefined) {
                        this.reconcileServerRotation(window.player, localPlayerData.aimAngle);
                    }
                    
                    // Debug log for stat changes (throttled)
                    // if (!this._lastStatLogTime || (Date.now() - this._lastStatLogTime) >= 1000) {
                    //     this._lastStatLogTime = Date.now();
                    //     console.log(`[Network] Server stats: HP=${localPlayerData.healthMax}, Speed=${localPlayerData.speed?.toFixed(0)}, Armor=${localPlayerData.armor}%, AtkSpd=${localPlayerData.attackSpeed?.toFixed(2)}x, CC=${((localPlayerData.critChance||0)*100).toFixed(0)}%, CD=${((localPlayerData.critDamageMultiplier||1)*100).toFixed(0)}%`);
                    // }
                }
            }
            
            // Sync artillery barrage timer for Trench Raid mode (server-authoritative)
            if (state.artilleryBarrageElapsedMs !== undefined && window.currentGameMode && 
                typeof window.currentGameMode.syncFromServer === 'function') {
                window.currentGameMode.syncFromServer(state.artilleryBarrageElapsedMs, state.artilleryBarrageActive);
            }
            
            if (this.onGameStateUpdate) {
                this.onGameStateUpdate(state);
            }
        });
        
        // NFC Unlock event - weapon8 unlock via physical NFC tag
        this.socket.on('nfcUnlock', (data) => {
            console.log('[Network] NFC Unlock received:', data);
            if (data.weapon === 'weapon8') {
                window.weapon8Unlocked = true;
                
                // Show the unlock popup overlay for all players
                if (window.state) {
                    window.state.nfcUnlockPopup = {
                        weapon: 'weapon8',
                        title: 'Sniper Priest has been unlocked!'
                    };
                }
                
                // Debug: Show which method triggered the unlock
                const source = data.source || 'unknown';
                const triggeredBy = data.triggeredBy ? data.triggeredBy.substring(0, 8) : 'server';
                console.log(`[NFC] ✓ Weapon 8 unlocked! (source: ${source}, triggered by: ${triggeredBy})`);
            }
        });
        
        // Handle delta state updates (Phase 2 optimization - 60-70% bandwidth reduction)
        this.socket.on('gameStateDelta', (delta) => {
            const receivedAt = Date.now();
            this.lastServerUpdate = receivedAt;
            
            // If it's a full state update, handle normally
            if (delta.isFull) {
                this.gameState = delta;
                this.recordNetworkDiagnostics(delta, receivedAt);
                if (delta.players) {
                    this.updateOtherPlayers(delta.players);
                }
                
                // Sync local player (same as gameState handler)
                if (delta.players && window.player) {
                    const localPlayerData = delta.players.find(p => p.id === this.playerId);
                    if (localPlayerData) {
                        this._syncLocalPlayerFromServer(localPlayerData);
                    }
                }
                
                if (this.onGameStateUpdate) {
                    this.onGameStateUpdate(delta);
                }
                return;
            }
            
            // Otherwise, apply delta changes to existing state
            if (delta.players && this.gameState && this.gameState.players) {
                for (const playerId in delta.players) {
                    const changes = delta.players[playerId];
                    let existingPlayer = this.gameState.players.find(p => p.id === playerId);
                    
                    if (!existingPlayer) {
                        // New player, add them with all properties from changes
                        this.gameState.players.push(changes);
                        existingPlayer = changes;
                    } else {
                        // Existing player, apply only changed properties
                        for (const prop in changes) {
                            if (prop !== 'id') {
                                existingPlayer[prop] = changes[prop];
                            }
                        }
                    }
                }
                
                // Update other players with merged state
                this.updateOtherPlayers(this.gameState.players);
            }
            
            // Sync local player's server-authoritative state from delta
            if (delta.players && window.player) {
                const localChanges = delta.players[this.playerId];
                if (localChanges) {
                    // Health sync
                    if (localChanges.health !== undefined) {
                        const healthBefore = window.player.health;
                        window.player.health = localChanges.health;
                        
                        // Trigger damage effects if health decreased
                        if (typeof healthBefore === 'number' && localChanges.health < healthBefore && localChanges.health > 0) {
                            const delta = healthBefore - localChanges.health;
                            
                            // Trigger hit flash
                            try {
                                const canFlash = (!window.player.hitFlash || window.player.hitFlash <= 0) && 
                                               (!window.player.hitFlashCooldown || window.player.hitFlashCooldown <= 0);
                                if (canFlash && typeof window.player.hitFlashMax === 'number') {
                                    window.player.hitFlash = window.player.hitFlashMax;
                                    window.player.hitFlashCooldown = window.player.hitFlashGap || 0.07;
                                }
                            } catch(e) {}
                            
                            // Queue damage event for shake/vignette
                            try {
                                if (window.enqueueDamageEvent && typeof window.enqueueDamageEvent === 'function') {
                                    let shakeScale = 1;
                                    if (window.player._ensnaredById != null || (window.player._ensnaredBy && window.player._ensnaredBy.size > 0)) {
                                        shakeScale = 2;
                                    }
                                    window.enqueueDamageEvent(delta, { source: 'network-delta', shakeScale });
                                }
                            } catch(e) {}
                        }
                    }
                    if (localChanges.healthMax !== undefined) window.player.healthMax = localChanges.healthMax;
                    if (localChanges.stamina !== undefined) window.player.stamina = localChanges.stamina;
                    if (localChanges.staminaMax !== undefined) window.player.staminaMax = localChanges.staminaMax;
                    if (localChanges._ensnaredTimer !== undefined) {
                        window.player._ensnaredTimer = localChanges._ensnaredTimer;
                        window.player._ensnaredById = localChanges._ensnaredById;
                    }
                    if (localChanges._weapon8ADS !== undefined) {
                        window.player._weapon8ADS = localChanges._weapon8ADS;
                    }
                    if (localChanges._basicZombieSlowCount !== undefined) {
                        window.player._basicZombieSlowCount = localChanges._basicZombieSlowCount;
                    }
                    if (localChanges.evilProgress !== undefined) window.player.evilProgress = localChanges.evilProgress;
                    if (localChanges.evilLocked !== undefined) window.player.evilLocked = localChanges.evilLocked;
                    if (localChanges.isEvil !== undefined) window.player.isEvil = localChanges.isEvil;
                    if (localChanges.serverSprintActive !== undefined) window.player._serverSprintActive = localChanges.serverSprintActive;
                    if (localChanges.mustReleaseFire !== undefined) window.player.mustReleaseFire = localChanges.mustReleaseFire;
                    // Sync breadcrumb trail
                    if (localChanges.breadcrumbs !== undefined) window.player.breadcrumbs = localChanges.breadcrumbs;
                }
            }
            
            // Update tick and timestamp
            if (delta.tick !== undefined) this.gameState.tick = delta.tick;
            if (delta.timestamp !== undefined) this.gameState.timestamp = delta.timestamp;
            if (delta.lastProcessedInputSeq !== undefined) this.gameState.lastProcessedInputSeq = delta.lastProcessedInputSeq;
            
            if (this.onGameStateUpdate) {
                this.onGameStateUpdate(this.gameState);
            }
        });
        
        // Handle immediate player position updates (e.g., respawn with random position)
        this.socket.on('playerUpdate', (data) => {
            if (!data || !data.id) return;
            
            // If it's our local player, update immediately
            if (data.id === this.playerId && window.player) {
                if (typeof data.x === 'number') window.player.x = data.x;
                if (typeof data.y === 'number') window.player.y = data.y;
                if (typeof data.health === 'number') window.player.health = data.health;
                if (typeof data.healthMax === 'number') window.player.healthMax = data.healthMax;
                console.log(`[Network] Received position update: (${data.x?.toFixed(1)}, ${data.y?.toFixed(1)})`);
                // Clear respawn pending if we were awaiting server confirmation
                if (window.state && window.state.respawnPending) {
                    window.state.respawnPending = false;
                    window.state.deathTimer = 0;
                    window.state.deathTimerInitialized = false;
                    if (window.player && (window.player.health == null || window.player.health <= 0) && typeof window.player.healthMax === 'number') {
                        window.player.health = Math.max(1, window.player.healthMax);
                    }
                }
                // Clear revive readiness when we become alive (revive accept or respawn)
                try {
                    if (window.state && typeof data.health === 'number' && data.health > 0) {
                        window.state.reviveReady = null;
                        window.state.reviveAcceptCooldownUntil = 0;
                    }
                } catch(_) {}
            }
            
            // Update other players in the map
            const otherPlayer = this.otherPlayers.get(data.id);
            if (otherPlayer) {
                if (typeof data.x === 'number') otherPlayer.x = data.x;
                if (typeof data.y === 'number') otherPlayer.y = data.y;
                if (typeof data.health === 'number') otherPlayer.health = data.health;
                if (typeof data.healthMax === 'number') otherPlayer.healthMax = data.healthMax;
            }
        });

        // Revive system: server notifies downed player that revive is ready to accept (button turns green)
        this.socket.on('reviveReady', (data) => {
            try {
                if (!window.state) return;
                window.state.reviveReady = {
                    fromId: data?.fromId || null,
                    expiresAt: Number(data?.expiresAt) || 0
                };
            } catch(e) {
                console.error('[Network] reviveReady error:', e);
            }
        });

        // Damage relays
        this.socket.on('explosionDamage', (data) => {
            try {
                if (!Array.isArray(data?.hits) || !window._enemyByServerId) return;
                for (let i = 0; i < data.hits.length; i++) {
                    const h = data.hits[i];
                    const ent = window._enemyByServerId.get(h.id);
                    if (!ent || !ent.alive) continue;
                    const dmg = Number(h.damage) || 0;
                    // Mirror crit popup for remote client
                    if (dmg > 0 && window.enqueueDamageText) {
                        window.enqueueDamageText({ x: ent.x, y: ent.y - (ent.radius || 26) - 6, text: Math.round(dmg).toString(), crit: !!h.crit, color: h.crit ? '#ffd36b' : '#ffffff', vy: -80, life: 0.8 });
                    }
                    ent.applyDamage(dmg);
                    // If a server-spawned enemy died from this damage, notify server to stop its AI immediately
                    try {
                        if (ent.serverSpawned && ent._serverId && !ent.alive && this.socket) {
                            this.socket.emit('enemyDied', { id: ent._serverId });
                        }
                    } catch(_) {}
                }
            } catch(e) { console.error('[Network] explosionDamage error:', e); }
        });
        this.socket.on('projectileHit', (data) => {
            try {
                if (window.DEBUG_WEAPON9_SYNC) {
                    try {
                        const id = data && data.id;
                        console.log('[Weapon9][Recv] projectileHit from server:', {
                            id,
                            damage: data && data.damage,
                            crit: !!(data && data.crit),
                            x: data && data.x,
                            y: data && data.y
                        });
                    } catch(_) {}
                }
                let didDamage = false;
                let didVisuals = false;

                const tryApplyDamage = () => {
                    if (!window._enemyByServerId) return false;
                    const ent = window._enemyByServerId.get(data?.id);
                    if (!ent || !ent.alive) return false;
                    const dmg = Number(data?.damage) || 0;
                    if (dmg > 0 && window.enqueueDamageText) {
                        window.enqueueDamageText({ x: ent.x, y: ent.y - (ent.radius || 26) - 6, text: Math.round(dmg).toString(), crit: !!data?.crit, color: data?.crit ? '#ffd36b' : '#ffffff', vy: -80, life: 0.8 });
                    }
                    ent.applyDamage(dmg);
                    
                    // Apply knockback from remote player's projectile hit (server will handle its own enemies)
                    if (data?.knockback && typeof ent.applyKnockback === 'function' && !ent.serverSpawned) {
                        const kb = data.knockback;
                        if (Number.isFinite(kb.dirX) && Number.isFinite(kb.dirY) && Number.isFinite(kb.distance) && Number.isFinite(kb.duration)) {
                            // Weapon 3 knockback cooldown: prevent rapid repeated knockback
                            let canApplyKnockback = true;
                            if (data.weaponIndex === 2) {
                                const now = Date.now();
                                const cooldownMs = 800; // Match charge shot time
                                
                                // Initialize cooldown tracking if needed
                                if (!ent._weapon3KnockbackCooldown) {
                                    ent._weapon3KnockbackCooldown = 0;
                                }
                                
                                // Check if cooldown has expired
                                if (now < ent._weapon3KnockbackCooldown) {
                                    canApplyKnockback = false;
                                } else {
                                    // Apply knockback and set cooldown
                                    ent._weapon3KnockbackCooldown = now + cooldownMs;
                                }
                            }
                            
                            if (canApplyKnockback) {
                                ent.applyKnockback(kb.dirX, kb.dirY, kb.distance, kb.duration);
                            }
                        }
                    }
                    
                    // If a server-spawned enemy died from this hit, notify server so it removes it immediately
                    try {
                        if (ent.serverSpawned && ent._serverId && !ent.alive && this.socket) {
                            this.socket.emit('enemyDied', { id: ent._serverId });
                        }
                    } catch(_) {}
                    if (window.DEBUG_WEAPON9_SYNC) {
                        try {
                            console.log('[Weapon9][Apply] projectileHit to enemy:', {
                                id: data && data.id,
                                dmg,
                                crit: !!(data && data.crit),
                                entPos: { x: ent.x, y: ent.y }
                            });
                        } catch(_) {}
                    }
                    return true;
                };

                const tryVisuals = () => {
                    if (!window.projectiles) return false;
                    let ix = Number.isFinite(data?.x) ? data.x : undefined;
                    let iy = Number.isFinite(data?.y) ? data.y : undefined;
                    if ((!Number.isFinite(ix) || !Number.isFinite(iy)) && window._enemyByServerId) {
                        const ent = window._enemyByServerId.get(data?.id);
                        if (ent && ent.alive) { ix = ent.x; iy = ent.y; }
                    }
                    if (!Number.isFinite(ix) || !Number.isFinite(iy)) return false;

                    // Remove nearest remote bullet (visual) within ~40px
                    try {
                        const items = window.projectiles.items || [];
                        let bestIdx = -1, bestD2 = 1600; // 40^2
                        for (let i = 0; i < items.length; i++) {
                            const b = items[i];
                            if (!b) continue;
                            if (b._fromRemotePlayer || b.noDamage === true) {
                                const dx = (b.x - ix);
                                const dy = (b.y - iy);
                                const d2 = dx * dx + dy * dy;
                                if (d2 < bestD2) { bestD2 = d2; bestIdx = i; }
                            }
                        }
                        if (bestIdx >= 0) {
                            if (window.DEBUG_WEAPON9_SYNC) {
                                try { console.log('[Weapon9][Visual] removed nearest remote bullet at d2=', bestD2); } catch(_) {}
                            }
                            items.splice(bestIdx, 1);
                        }
                    } catch (_) {}
                    // Spawn impact VFX
                    try {
                        if (window.ImpactVfx) {
                            const color = data?.color || '#ffffff';
                            const dirX = Number.isFinite(data?.dirX) ? data.dirX : 0;
                            const dirY = Number.isFinite(data?.dirY) ? data.dirY : 1;
                            const scale = Number.isFinite(data?.impactScale) ? data.impactScale : 1;
                            window.projectiles.impacts.push(new window.ImpactVfx(ix, iy, color, dirX, dirY, { scale }));
                            if (window.DEBUG_WEAPON9_SYNC) {
                                try { console.log('[Weapon9][Visual] spawned impact VFX at', { x: ix, y: iy }); } catch(_) {}
                            }
                        }
                    } catch (_) {}
                    return true;
                };

                didDamage = tryApplyDamage();
                didVisuals = tryVisuals();
                if (didDamage && didVisuals) return;

                let attempts = 0;
                const maxAttempts = 25; // ~500ms
                const interval = setInterval(() => {
                    attempts++;
                    if (!didDamage) {
                        if (window.DEBUG_WEAPON9_SYNC && attempts === 1) {
                            try { console.log('[Weapon9][Retry] enemy not yet mapped; retrying up to 500ms'); } catch(_) {}
                        }
                        didDamage = tryApplyDamage();
                    }
                    if (!didVisuals) didVisuals = tryVisuals();
                    if ((didDamage && didVisuals) || attempts >= maxAttempts) clearInterval(interval);
                }, 20);
            } catch(e) { console.error('[Network] projectileHit error:', e); }
        });
        // Invisibility state sync (weapon 5 secondary ability)
        this.socket.on('invisibilityState', (data) => {
            try {
                const { playerId, invisible } = data;
                
                // Update local player invisibility state
                if (playerId === this.playerId && window.player) {
                    const oldState = window.player.invisible;
                    window.player.invisible = invisible;
                    // Only log state changes
                    if (oldState !== invisible) {
                        console.log('[Network] Local player invisibility:', invisible);
                    }
                }
                
                // Update remote player invisibility state
                const otherPlayer = this.otherPlayers.get(playerId);
                if (otherPlayer) {
                    const oldState = otherPlayer.invisible;
                    otherPlayer.invisible = invisible;
                    // Only log state changes
                    if (oldState !== invisible) {
                        console.log('[Network] Remote player invisibility:', playerId, invisible);
                    }
                }
            } catch (err) {
                console.error('[Network] Error handling invisibilityState:', err);
            }
        });
        
        // Invisibility rejection feedback (when ensnared or other reasons)
        this.socket.on('invisibilityRejected', (data) => {
            try {
                if (data.reason === 'ensnared') {
                    // Show "Ensnared" feedback above player
                    if (window.player && window.enqueueDamageText) {
                        window.enqueueDamageText({
                            x: window.player.x,
                            y: window.player.y - (window.player.radius || 26) - 20,
                            text: 'Ensnared',
                            crit: false,
                            color: '#ff4444',
                            vy: -40,
                            life: 1.2
                        });
                    }
                    console.log('[Invisibility] Rejected - player is ensnared');
                } else if (data.reason === 'insufficient_blood') {
                    // TODO: Add custom warning later
                    console.log('[Invisibility] Rejected - insufficient blood markers');
                } else if (data.reason === 'insufficient_loot') {
                    // TODO: Add custom warning later
                    console.log('[Invisibility] Rejected - insufficient loot level');
                }
            } catch (err) {
                console.error('[Network] Error handling invisibilityRejected:', err);
            }
        });
        
        // Enemy projectile hit event (show impact VFX)
        this.socket.on('enemyProjectileHit', (data) => {
            try {
                if (!window.projectiles || !window.ImpactVfx) return;
                
                const x = Number(data?.x) || 0;
                const y = Number(data?.y) || 0;
                const color = '#7adf7a'; // Green projectile color
                
                // Spawn impact VFX at hit location
                const impact = new window.ImpactVfx(x, y, color);
                window.projectiles.impacts.push(impact);
                
                // Find and remove the nearest enemy projectile visual
                if (window.projectiles.items) {
                    const searchRadius = 40;
                    let closestIdx = -1;
                    let closestDist = searchRadius;
                    
                    for (let i = 0; i < window.projectiles.items.length; i++) {
                        const b = window.projectiles.items[i];
                        if (!b || !b._serverEnemyBullet) continue; // Only remove server enemy projectiles
                        
                        const dx = b.x - x;
                        const dy = b.y - y;
                        const dist = Math.hypot(dx, dy);
                        
                        if (dist < closestDist) {
                            closestDist = dist;
                            closestIdx = i;
                        }
                    }
                    
                    if (closestIdx !== -1) {
                        window.projectiles.items.splice(closestIdx, 1);
                    }
                }
            } catch(e) {
                console.error('[Network] Error handling enemyProjectileHit:', e);
            }
        });
        
        // Enemy projectile firing (server-authoritative)
        this.socket.on('enemyProjectileFired', (data) => {
            try {
                if (!window.projectiles || !window.Bullet) return;
                let x = Number(data?.x), y = Number(data?.y);
                const vx = Number(data?.vx), vy = Number(data?.vy);
                const r = Number.isFinite(data?.radius) ? data.radius : 6;
                const life = Number.isFinite(data?.life) ? data.life : 6.0;
                const color = data?.color || '#7adf7a';
                const ang = Number.isFinite(data?.angle) ? data.angle : Math.atan2(vy, vx);
                const dmg = Number.isFinite(data?.damage) ? data.damage : 18;
                // Rebase spawn to current enemy position to avoid smoothing offset
                try {
                    if (window._enemyByServerId && data && data.enemyId) {
                        const ent = window._enemyByServerId.get(data.enemyId);
                        if (ent && ent.alive) {
                            const muzzle = (ent.radius || 26) + r + 2;
                            x = ent.x + Math.cos(ang) * muzzle;
                            y = ent.y + Math.sin(ang) * muzzle;
                        }
                    }
                } catch(_) {}
                const bullet = new window.Bullet(x, y, vx, vy, r, color, life, ang, false, { 
                    owner: { name: 'Enemy', isEnemy: true }, 
                    ignoreEnemies: true, 
                    damage: dmg,
                    isZombieProjectile: true  // Flag to ignore enemy shields (but not environment walls)
                });
                bullet._serverEnemyBullet = true;
                window.projectiles.items.push(bullet);
            } catch(e) { console.error('[Network] enemyProjectileFired error:', e); }
        });
        
        this.socket.on('enemyMeleeAttack', (data) => {
            try {
                if (!window.projectiles || !window.Bullet || !data) return;
                // Create visual cone attack as a proper Bullet instance
                const cone = new window.Bullet(
                    data.x, 
                    data.y, 
                    0, // vx
                    0, // vy
                    0, // radius
                    data.color || '#8B0000',
                    0.3, // life
                    data.angle,
                    false, // player bullet
                    {
                        owner: { type: 'wallguy', id: data.enemyId, isEnemy: true },
                        ignoreEnemies: true,
                        ignoreEnvironment: true,
                        noDamage: true,
                        drawBehind: true // Draw under WallGuy and shield, but over player
                    }
                );
                // Set cone-specific properties
                cone.isCone = true;
                cone.coneRange = data.coneRange || 120;
                cone.coneHalf = data.coneHalf || 0.6;
                cone._serverEnemyBullet = true;
                cone.noDamage = true; // Explicitly set to prevent any local damage (server handles it)
                
                window.projectiles.items.push(cone);
                
                // Don't spawn slash VFX at attack origin - it will spawn on the player when they get hit
                // (see ClientUpdate.js enemy cone vs player collision for slash VFX on hit)
            } catch(e) { console.error('[Network] enemyMeleeAttack error:', e); }
        });
        
        this.socket.on('dotTick', (data) => {
            try {
                if (!window._enemyByServerId) return;
                const ent = window._enemyByServerId.get(data?.id);
                if (!ent || !ent.alive) return;
                const amt = Number(data?.amount) || 0;
                if (amt > 0 && window.enqueueDamageText) {
                    window.enqueueDamageText({ x: ent.x, y: ent.y - (ent.radius || 26) - 6, text: Math.round(amt).toString(), crit: !!data?.crit, color: data?.crit ? '#ffd36b' : '#ff9f2b', vy: -60, life: 0.6 });
                }
                ent.applyDamage(amt);
            } catch(e) { console.error('[Network] dotTick error:', e); }
        });
        
        this.socket.on('playerJoined', (playerData) => {
            console.log('[Network] Player joined:', playerData.id);
            this.otherPlayers.set(playerData.id, playerData);
            
            // Track evil state for PvP
            if (!this.remotePlayerEvilStates) {
                this.remotePlayerEvilStates = new Map();
            }
            this.remotePlayerEvilStates.set(playerData.id, playerData.isEvil || false);
            
            if (this.onPlayerJoined) {
                this.onPlayerJoined(playerData);
            }
        });
        
        this.socket.on('playerLeft', (data) => {
            console.log('[Network] Player left:', data.id);
            this.otherPlayers.delete(data.id);
            
            // Clean up burning state for disconnected players
            if (this.remoteBurningPlayers) {
                this.remoteBurningPlayers.delete(data.id);
            }
            
            if (this.onPlayerLeft) {
                this.onPlayerLeft(data);
            }
        });
        
        this.socket.on('worldSeed', (data) => {
            console.log('[Network] Received world seed from server:', data.seed);
            this.worldSeed = data.seed;
            this.worldSeedReceived = true;
            
            // Initialize WorldRNG with the server seed
            if (typeof WorldRNG !== 'undefined' && WorldRNG.setSeed) {
                WorldRNG.setSeed(data.seed);
                console.log('[Network] Initialized WorldRNG with server seed:', data.seed);
            } else {
                console.error('[Network] WorldRNG not available! Check if seededRNG.js loaded correctly.');
            }
            
            // CRITICAL: Robust world initialization - try callback first, then direct fallback
            if (this.onWorldSeedReceived) {
                console.log('[Network] Calling world initialization callback');
                this.onWorldSeedReceived(data.seed);
            } else if (typeof window.initializeWorld === 'function') {
                console.log('[Network] Using fallback - calling window.initializeWorld directly');
                window.initializeWorld(data.seed);
            } else {
                console.error('[Network] No world seed consumer registered!');
            }
        });
        
        this.socket.on('sceneChange', (data) => {
            console.log('[Network] Received scene change from server:', data.scene);
            
            // Don't process if this is from our own client (avoid double transition)
            if (data.fromPlayer === this.playerId) {
                console.log('[Network] Ignoring own scene change broadcast');
                return;
            }
            
            // Trigger appropriate scene transition based on the received scene
            try {
                // Store navmesh debug payload if provided (used for client overlay rendering)
                try {
                    if (data && data.navMeshDebug && data.navMeshDebug.nav) {
                        // #region agent log
                        fetch('http://127.0.0.1:7242/ingest/10317113-f3de-4c2b-9a23-83892ed269d3',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'networking.js:sceneChange:navMeshInPayload',message:'NavMesh in sceneChange payload',data:{isLateJoiner:!window.navMeshDebug,hasNav:true,rowCount:data.navMeshDebug.nav.rowsRLE?.length||0},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H3'})}).catch(()=>{});
                        // #endregion
                        window.navMeshDebug = data.navMeshDebug;
                    }
                } catch(_) {}

                if (data.scene === 'level' && typeof window.startLevelFromLobby === 'function') {
                    console.log('[Network] Triggering transition to level with server obstacles');
                    // Filter obstacles to only those within map bounds (fixes invisible collision outside playable area)
                    const levelType = data.levelType || 'extraction';
                    const levelConfig = window.LevelConfigs ? window.LevelConfigs.get(levelType) : null;
                    
                    let filteredObstacles = data.obstacles || [];
                    if (Array.isArray(data.obstacles) && levelConfig && levelConfig.isRectangular) {
                        // Use actual map dimensions for rectangular maps
                        const halfWidth = levelConfig.width / 2;  // e.g., 24000 / 2 = 12000
                        const halfHeight = levelConfig.height / 2; // e.g., 3000 / 2 = 1500
                        filteredObstacles = data.obstacles.filter(ob => {
                            const isWithinX = Math.abs(ob.x) <= halfWidth;
                            const isWithinY = Math.abs(ob.y) <= halfHeight;
                            return isWithinX && isWithinY;
                        });
                        if (data.obstacles.length !== filteredObstacles.length) {
                            console.log(`[Network] Filtered obstacles for ${levelType}: ${data.obstacles.length} → ${filteredObstacles.length} (removed ${data.obstacles.length - filteredObstacles.length} out-of-bounds, bounds: ±${halfWidth}x±${halfHeight})`);
                        }
                    }
                    // Pass server obstacle, enemy spawn data, and level type to ensure synchronization
                    window.startLevelFromLobby(filteredObstacles, data.levelSpawns, data.enemies, levelType);
                    // Sync boundary if provided
                    if (data.boundary && window.environment) {
                        window.environment.boundary = data.boundary;
                    }
                    // Sync orientedBoxes (trench walls, etc.)
                    if (Array.isArray(data.orientedBoxes) && window.environment) {
                        console.log('[Network] Applying server orientedBoxes to environment:', data.orientedBoxes.length);
                        window.environment.orientedBoxes = data.orientedBoxes.slice();
                    }
                } else if (data.scene === 'lobby' && typeof window.returnToLobby === 'function') {
                    console.log('[Network] Triggering transition to lobby with server obstacles');
                    // Pass server obstacle data to ensure synchronization
                    window.returnToLobby(data.obstacles);
                    // Sync boundary if provided
                    if (data.boundary && window.environment) {
                        window.environment.boundary = data.boundary;
                    }
                    // Sync orientedBoxes (should be empty in lobby, but handle for consistency)
                    if (Array.isArray(data.orientedBoxes) && window.environment) {
                        console.log('[Network] Applying server orientedBoxes to environment:', data.orientedBoxes.length);
                        window.environment.orientedBoxes = data.orientedBoxes.slice();
                    }
                }
            } catch (e) {
                console.error('[Network] Error handling scene change:', e);
            }
        });

        // Navmesh debug overlay payload (sent during lobby ready timer precompute)
        this.socket.on('navMeshDebug', (data) => {
            try {
                // #region agent log
                console.log('[DEBUG H3,H4] Client received navMesh:', {hadPrevious:!!window.navMeshDebug, hasNav:!!(data&&data.nav), rowCount:data?.nav?.rowsRLE?.length||0});
                fetch('http://127.0.0.1:7242/ingest/10317113-f3de-4c2b-9a23-83892ed269d3',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'networking.js:navMeshDebug',message:'Client received navMesh',data:{hadPrevious:!!window.navMeshDebug,hasNav:!!(data&&data.nav),rowCount:data?.nav?.rowsRLE?.length||0},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H3,H4'})}).catch(()=>{});
                // #endregion
                if (data && data.nav) {
                    window.navMeshDebug = data;
                }
            } catch(_) {}
        });

        // Environment hazards initial state
        this.socket.on('hazardsState', (data) => {
            try {
                // Clear existing fire pool instances when receiving new hazard state
                if (window._envFirePools) {
                    window._envFirePools.clear();
                    console.log('[Network] Cleared fire pool instances for new hazards state');
                }
                
                // Clear existing gas canister instances
                if (window._envGasCanisters) {
                    window._envGasCanisters.clear();
                    console.log('[Network] Cleared gas canister instances for new hazards state');
                }
                
                window.hazards = data || {};
                if (!window.hazards.sandPiles) window.hazards.sandPiles = [];
                // Rebuild client-side collision boxes for sandbags so environment.lineHitsAny blocks projectiles
                try {
                    if (window.environment) {
                        // Remove prior hazard boxes
                        window.environment.orientedBoxes = (window.environment.orientedBoxes || []).filter(b => !b || !b._hazardType);
                        const sbs = window.hazards.sandbags || [];
                        for (let i = 0; i < sbs.length; i++) {
                            const sb = sbs[i]; if (!sb) continue;
                            // Use angle from server (diagonal sandbags have rotation)
                            const box = { x: sb.x, y: sb.y, w: sb.w, h: sb.h, angle: sb.angle || 0, _hazardType: 'sandbag', _hazardId: sb.id };
                            window.environment.orientedBoxes.push(box);
                        }
                    }
                } catch(_) {}
                // Spawn MudPoolDecal instances for mud pools (rendered as ground decals)
                try {
                    if (window.MudPoolDecal && window.enqueueGroundDecal && Array.isArray(window.hazards.mudPools)) {
                        // Track spawned mud pool IDs to avoid duplicates
                        if (!window._spawnedMudPoolIds) window._spawnedMudPoolIds = new Set();
                        for (const m of window.hazards.mudPools) {
                            if (!m || !m.id) continue;
                            if (window._spawnedMudPoolIds.has(m.id)) continue;
                            window._spawnedMudPoolIds.add(m.id);
                            const decal = new window.MudPoolDecal(m.x, m.y, m.radius);
                            window.enqueueGroundDecal(decal);
                        }
                    }
                } catch(_) {}
                // Sync exploding barrels - just log, data is already in window.hazards
                if (data?.explodingBarrels) {
                    console.log('[BARRELS] Received', data.explodingBarrels.length, 'barrels from server');
                }
                
                console.log('[Network] hazardsState received:', {
                    sandbags: data?.sandbags?.length || 0,
                    wire: data?.barbedWire?.length || 0,
                    mud: data?.mudPools?.length || 0,
                    trenches: data?.trenches?.length || 0,
                    fire: data?.firePools?.length || 0,
                    gas: data?.gasCanisters?.length || 0,
                    barrels: data?.explodingBarrels?.length || 0
                });
            } catch(e) {
                console.error('[Network] hazardsState error:', e);
            }
        });

        // Sandbag hit VFX and removal
        this.socket.on('hazardHit', (data) => {
            try {
                if (!data || data.type !== 'sandbag') return;
                window._hazardVfx = window._hazardVfx || { sand: [], sandGrains: [], sandDust: [] };
                // Dusty poof (soft cloud) - expanding circles
                const dustCount = 3 + Math.floor(Math.random() * 3);
                for (let i = 0; i < dustCount; i++) {
                    const life = 0.5 + Math.random() * 0.4;
                    window._hazardVfx.sandDust.push({
                        x: data.x + (Math.random() - 0.5) * 8,
                        y: data.y + (Math.random() - 0.5) * 8,
                        r: 6 + Math.random() * 9,        // half-size poofs
                        vr: 30 + Math.random() * 40,     // slower expansion
                        life, total: life,
                        color: '#d9c99a'
                    });
                }
                // Falling grains (heavier specks)
                const grainCount = 18 + Math.floor(Math.random() * 16);
                for (let i = 0; i < grainCount; i++) {
                    const ang = (Math.random() * Math.PI) - Math.PI / 2; // bias upward
                    const sp = 140 + Math.random() * 240;
                    const life = 0.7 + Math.random() * 0.6;
                    window._hazardVfx.sandGrains.push({
                        x: data.x, y: data.y,
                        vx: Math.cos(ang) * sp,
                        vy: Math.sin(ang) * sp - 60, // initial upward burst
                        life, total: life,
                        r: 2 + Math.random() * 2,
                        color: (Math.random() < 0.5 ? '#cbb98a' : '#b09a6a')
                    });
                }
                // Update local sandbag health for damaged state rendering
                if (window.hazards && Array.isArray(window.hazards.sandbags)) {
                    const sb = window.hazards.sandbags.find(s => s && s.id === data.id);
                    if (sb && typeof data.health === 'number') sb.health = data.health;
                }
                // Remove nearest visual bullet so it stops at the sandbag
                try {
                    const items = window.projectiles?.items || [];
                    let bestIdx = -1, bestD2 = 1024; // 32px radius
                    for (let i = 0; i < items.length; i++) {
                        const b = items[i]; if (!b) continue;
                        const dx = (b.x || 0) - data.x;
                        const dy = (b.y || 0) - data.y;
                        const d2 = dx*dx + dy*dy;
                        if (d2 < bestD2) { bestD2 = d2; bestIdx = i; }
                    }
                    if (bestIdx >= 0) {
                        const b = items[bestIdx];
                        // Impact VFX at hit point
                        try { if (window.ImpactVfx) window.projectiles.impacts.push(new window.ImpactVfx(data.x, data.y, b?.color || '#d2c08a', -(b?.vx||0), -(b?.vy||0))); } catch(_) {}
                        items.splice(bestIdx, 1);
                    }
                } catch(_) {}
            } catch(e) { console.error('[Network] hazardHit error:', e); }
        });
        this.socket.on('hazardRemoved', (data) => {
            try {
                if (!data || data.type !== 'sandbag' || !window.hazards) return;
                const arr = window.hazards.sandbags || [];
                const idx = arr.findIndex(s => s && s.id === data.id);
                if (idx >= 0) arr.splice(idx, 1);
                // Leave a ground sand pile decal (walkable visual) with variant/angle for diagonal piles
                window.hazards.sandPiles = window.hazards.sandPiles || [];
                window.hazards.sandPiles.push({ x: data.x, y: data.y, w: data.w || 220, h: data.h || 36, variant: data.variant, angle: data.angle, life: Infinity });
                // Remove client collision box
                try {
                    if (window.environment && window.environment.orientedBoxes) {
                        window.environment.orientedBoxes = window.environment.orientedBoxes.filter(b => !(b && b._hazardType === 'sandbag' && b._hazardId === data.id));
                    }
                } catch(_) {}
            } catch(e) { console.error('[Network] hazardRemoved error:', e); }
        });
        
        // ===== MERCHANT SHOP =====
        
        this.socket.on('shopInventory', (data) => {
            console.log('[Network] Received shop inventory:', data.items?.length, 'items');
            if (window.merchantShop) {
                window.merchantShop.setInventory(data.items || []);
            }
        });
        
        this.socket.on('purchaseResult', (data) => {
            console.log('[Network] Purchase result:', data);
            if (data.success) {
                // Update player ducats, victory points, and inventory
                if (window.player) {
                    if (typeof data.newDucats === 'number') {
                        window.player.ducats = data.newDucats;
                    }
                    if (typeof data.newVictoryPoints === 'number') {
                        window.player.victoryPoints = data.newVictoryPoints;
                    }
                    if (Array.isArray(data.newInventory)) {
                        // Server sends full inventory items; reconstruct proper HexStat instances for client inventory
                        window.player.inventory = data.newInventory.map(item => {
                            if (item.type === 'HexStat' && window.GameObjects && window.GameObjects.HexStat) {
                                const HexStat = window.GameObjects.HexStat;
                                const hex = new HexStat(0, 0, 0, 0, {
                                    label: item.label,
                                    rarity: { name: item.rarityName, color: item.color },
                                    fill: item.color
                                });
                                hex.onGround = false;
                                hex.equippedBy = window.player;
                                hex.pickupLockout = 0;
                                if (item.suppressHealForPlayerId != null) hex.suppressHealForPlayerId = item.suppressHealForPlayerId;
                                return hex;
                            }
                            return item;
                        });
                        try { window.player._invVersion = (typeof window.player._invVersion === 'number') ? (window.player._invVersion + 1) : 1; } catch(_) {}
                    }
                    // Update equipped hat if present in purchase result
                    if (data.equippedHat) {
                        window.player.equippedHat = data.equippedHat;
                        console.log('[Network] Equipped hat:', data.equippedHat.name);
                    }
                    // Update equipped skin if present in purchase result
                    if (data.equippedSkin) {
                        window.player.equippedSkin = data.equippedSkin;
                        console.log('[Network] Equipped skin:', data.equippedSkin.name);
                    }
                    console.log('[Network] Updated player currency and inventory after purchase');
                }
                
                // Clear selection in shop
                if (window.merchantShop) {
                    window.merchantShop.selectedItems = [];
                }
            } else {
                console.warn('[Network] Purchase failed:', data.reason);
                // TODO: Show error message to player
            }
        });

        // Quartermaster requisition reward (server-authoritative)
        this.socket.on('quartermasterReward', (data) => {
            try {
                if (!data || !window.player) return;
                if (!data.success) {
                    console.warn('[Quartermaster] Reward failed:', data.reason);
                    return;
                }
                // If the server says this was the one-time bundle, flip the dialogue into rationing mode next time.
                try {
                    if (data.mode === 'first') {
                        window.dialogueFlags = window.dialogueFlags || {};
                        window.dialogueFlags.qmGrantedSupplies = true;
                    }
                } catch(_) {}
                if (typeof data.newDucats === 'number') window.player.ducats = data.newDucats;
                if (typeof data.newBloodMarkers === 'number') window.player.bloodMarkers = data.newBloodMarkers;
                if (typeof data.newLootLevel === 'number') window.player.lootLevel = data.newLootLevel;

                if (Array.isArray(data.newInventory)) {
                    // Reconstruct proper HexStat instances for client inventory (same as purchaseResult)
                    window.player.inventory = data.newInventory.map(item => {
                        if (item && item.type === 'HexStat' && window.GameObjects && window.GameObjects.HexStat) {
                            const HexStat = window.GameObjects.HexStat;
                            const hex = new HexStat(0, 0, 0, 0, {
                                label: item.label,
                                rarity: { name: item.rarityName, color: item.color },
                                fill: item.color
                            });
                            hex.onGround = false;
                            hex.equippedBy = window.player;
                            hex.pickupLockout = 0;
                            if (item.suppressHealForPlayerId != null) hex.suppressHealForPlayerId = item.suppressHealForPlayerId;
                            return hex;
                        }
                        return item;
                    });
                    try { window.player._invVersion = (typeof window.player._invVersion === 'number') ? (window.player._invVersion + 1) : 1; } catch(_) {}
                }
                console.log('[Quartermaster] Granted requisition:', {
                    ducats: data.newDucats,
                    blood: data.newBloodMarkers,
                    lootLevel: data.newLootLevel,
                    dropped: !!data.dropped,
                    mode: data.mode
                });
            } catch (e) {
                console.error('[Quartermaster] Error handling reward:', e);
            }
        });
        
        // SERVER-AUTHORITATIVE level type sync (real-time updates when any player changes selection)
        this.socket.on('levelTypeSync', (data) => {
            try {
                window.serverLevelType = data.levelType || 'extraction';
                console.log(`[Network] Level type changed to: ${data.levelType} (set by player: ${data.setBy})`);
            } catch (e) {
                console.error('[Network] Error handling levelTypeSync:', e);
            }
        });
        
        // Initialize static/rarely-changing state on join and for late-joiners
        this.socket.on('roomSnapshot', (snap) => {
            try {
                // SERVER-AUTHORITATIVE level type sync
                if (snap.levelType) {
                    window.serverLevelType = snap.levelType;
                    console.log('[Network] Synced server-authoritative level type:', snap.levelType);
                }
                
                // CRITICAL: Apply server obstacles to environment first
                if (Array.isArray(snap.obstacles) && window.environment) {
                    console.log('[Network] Applying server obstacles to environment:', snap.obstacles.length);
                    // Filter obstacles to only those within map bounds (fixes invisible collision outside playable area)
                    const levelType = snap.levelType || window.serverLevelType || 'extraction';
                    const levelConfig = window.LevelConfigs ? window.LevelConfigs.get(levelType) : null;
                    
                    let filteredObstacles = snap.obstacles;
                    if (levelConfig && levelConfig.isRectangular) {
                        // Use actual map dimensions for rectangular maps
                        const halfWidth = levelConfig.width / 2;  // e.g., 24000 / 2 = 12000
                        const halfHeight = levelConfig.height / 2; // e.g., 3000 / 2 = 1500
                        filteredObstacles = snap.obstacles.filter(ob => {
                            const isWithinX = Math.abs(ob.x) <= halfWidth;
                            const isWithinY = Math.abs(ob.y) <= halfHeight;
                            return isWithinX && isWithinY;
                        });
                        console.log(`[Network] Filtered obstacles for ${levelType}: ${snap.obstacles.length} → ${filteredObstacles.length} (removed ${snap.obstacles.length - filteredObstacles.length} out-of-bounds, bounds: ±${halfWidth}x±${halfHeight})`);
                    }
                    window.environment.obstacles = filteredObstacles;
                }
                
                // Apply server orientedBoxes (trench walls, etc.)
                if (Array.isArray(snap.orientedBoxes) && window.environment) {
                    console.log('[Network] Applying server orientedBoxes to environment:', snap.orientedBoxes.length);
                    window.environment.orientedBoxes = snap.orientedBoxes.slice(); // Copy orientedBoxes
                }
                
                if (snap.boundary && window.environment) {
                    window.environment.boundary = snap.boundary;
                }
                // If level spawns were already computed (late joiner), cache them globally
                if (snap.levelSpawns) {
                    window.__serverLevelSpawns = snap.levelSpawns;
                }
                if (snap.readyTimer && window._readyZone) {
                    window._readyZone.syncFromServer({
                        started: snap.readyTimer.started,
                        completed: snap.readyTimer.completed,
                        timeLeft: snap.readyTimer.timeLeft,
                        timeTotal: snap.readyTimer.timeTotal,
                        startedBy: snap.readyTimer.startedBy
                    });
                }
                if (Array.isArray(snap.ambientNpcs)) {
                    if (typeof this.applyAmbientNpcSync === 'function') {
                        this.applyAmbientNpcSync(snap.ambientNpcs);
                    }
                }
                // NOTE: Target dummy system removed. Lobby training dummy is now a normal enemy (type: targetDummy)
                // and is spawned via the standard enemy spawn pipelines (roomSnapshot enemies, hordeSpawned, etc.).
                if (Array.isArray(snap.groundItems) && window.GameObjects && window.GameObjects.HexStat) {
                    const HexStat = window.GameObjects.HexStat;
                    if (!Array.isArray(window.bossDrops)) window.bossDrops = [];
                    for (const gi of snap.groundItems) {
                        const rarity = { name: gi.rarityName, color: gi.color };
                        const hex = new HexStat(gi.x, gi.y, gi.vx, gi.vy, { label: gi.label, fill: rarity.color, rarity });
                        hex._serverId = gi.id;
                        hex.onGround = false;
                        window.bossDrops.push(hex);
                    }
                }
                // Build enemies strictly from server list (no client fallback)
                if (Array.isArray(snap.enemies) && window.enemies) {
                    // Call onDeath cleanup on all existing enemies before clearing (for WallGuy shield cleanup, etc.)
                    if (window.enemies.items) {
                        for (let i = 0; i < window.enemies.items.length; i++) {
                            const e = window.enemies.items[i];
                            if (e) {
                                try {
                                    if (typeof e.onDeath === 'function') {
                                        e.onDeath({ cause: 'snapshot_rebuild' });
                                    }
                                } catch(err) {
                                    console.error('[Network] Error calling onDeath during snapshot rebuild:', err);
                                }
                            }
                        }
                    }
                    
                    window.enemies.items.length = 0;
                    if (typeof window.enemies.grid?.clear === 'function') window.enemies.grid.clear();
                    if (!window._enemyByServerId) window._enemyByServerId = new Map();
                    window._enemyByServerId.clear();
                    const Cls = (typeof window.Enemy === 'function') ? window.Enemy : (typeof Enemy === 'function' ? Enemy : null);
                    if (Cls) {
                        for (let i = 0; i < snap.enemies.length; i++) {
                            const e = snap.enemies[i]; if (!e) continue;
                            // Create appropriate enemy class based on type
                            let inst;
                            if (e.type === 'targetDummy' && window.TargetDummy) {
                                inst = new window.TargetDummy(e.x, e.y);
                            } else if (e.type === 'boss' && window.ArtilleryWitch) {
                                inst = new window.ArtilleryWitch(e.x, e.y);
                            } else if (e.type === 'projectile' && window.ProjectileZombie) {
                                inst = new window.ProjectileZombie(e.x, e.y);
                            } else if (e.type === 'boomer' && window.Boomer) {
                                inst = new window.Boomer(e.x, e.y);
                            } else if (e.type === 'licker' && window.Licker) {
                                inst = new window.Licker(e.x, e.y);
                            } else if (e.type === 'bigboy' && window.BigBoy) {
                                inst = new window.BigBoy(e.x, e.y);
                            } else {
                                inst = new Cls(e.x, e.y);
                            }
                            inst._serverId = e.id;
                            inst.serverSpawned = true;
                            // Apply server-provided fields if present (especially important for target dummy)
                            try {
                                if (e.type !== undefined) inst.type = e.type;
                                if (e.radius !== undefined) inst.radius = e.radius;
                                if (e.health !== undefined) inst.health = e.health;
                                if (e.healthMax !== undefined) inst.healthMax = e.healthMax;
                                if (e.speedMul !== undefined) inst.speedMul = e.speedMul;
                            } catch(_) {}
                            window.enemies.items.push(inst);
                            if (typeof window.enemies._insert === 'function') window.enemies._insert(inst);
                            window._enemyByServerId.set(e.id, inst);
                        }
                    }
                }
            } catch (e) {
                console.error('[Network] Error handling roomSnapshot:', e);
            }
        });

        // --- Inactive hooks for future server-authoritative enemy movement ---
        window.__netEnemyPosAuth = window.__netEnemyPosAuth || false;
        if (!window._enemyByServerId) window._enemyByServerId = new Map();
        // Phase 4: Consolidated entity state handler (primary format)
        this.socket.on('entitiesState', (payload) => {
            if (!payload || !Array.isArray(payload.entities)) return;

            // Mark that we've received the new format (prevents fallback processing)
            if (!this._receivedEntitiesState) this._receivedEntitiesState = true;
            this._lastEntitiesStateAt = Date.now();
            
            // Process each entity by type
            for (const entity of payload.entities) {
                if (!entity || !entity.entityType || !entity.data) continue;
                
                // Route to appropriate handler based on entity type
                if (entity.entityType === Protocol.EntityType.ENEMY) {
                    // Process enemy exactly like legacy enemiesState (reuse same logic)
                    // We'll call a helper function to avoid duplication
                    this._processEnemyUpdate(entity.data);
                }
                // Future: handle Protocol.EntityType.NPC, TROOP, HAZARD when feature flags enable them
            }
        });
        
        this.socket.on('enemiesState', (list) => {
            // Phase 4: Dual-listen - skip if we're receiving entitiesState
            if (this._receivedEntitiesState && this._lastEntitiesStateAt) {
                const timeSinceNewFormat = Date.now() - this._lastEntitiesStateAt;
                if (timeSinceNewFormat < 1000) {
                    return;
                }
            }
            
            // Auto-enable server authority on first enemiesState reception
            if (!window.__netEnemyPosAuth) window.__netEnemyPosAuth = true;
            if (!Array.isArray(list) || !window._enemyByServerId) return;

            // Process each enemy
            for (let i = 0; i < list.length; i++) {
                this._processEnemyUpdate(list[i]);
            }
        });
        
        // Horde spawn event (server-authoritative dynamic spawning)
        this.socket.on('hordeSpawned', (data) => {
            try {
                if (!data || !Array.isArray(data.enemies)) return;
                if (!window.enemies || !window._enemyByServerId) return;
                
                console.log('[Horde] Received horde spawn:', data.enemies.length, 'enemies from', data.targetSource);

                // Track ambient spawner total for debug HUD
                if (data.targetSource === 'ambient') {
                    if (!window._ambientSpawnedTotal) window._ambientSpawnedTotal = 0;
                    window._ambientSpawnedTotal += data.enemies.length;
                }
                
                const now = Date.now();
                for (const e of data.enemies) {
                    if (!e || !e.id) continue;
                    
                    // Skip if enemy already exists
                    if (window._enemyByServerId.has(e.id)) continue;
                    
                // Create enemy instance based on type
                let inst = null;
                if (e.type === 'targetDummy' && window.TargetDummy) {
                    inst = new window.TargetDummy(e.x, e.y);
                } else if (e.type === 'projectile' && window.ProjectileZombie) {
                    inst = new window.ProjectileZombie(e.x, e.y);
                } else if (e.type === 'boomer' && window.Boomer) {
                    inst = new window.Boomer(e.x, e.y);
                } else if (e.type === 'licker' && window.Licker) {
                    inst = new window.Licker(e.x, e.y);
                } else if (e.type === 'bigboy' && window.BigBoy) {
                    inst = new window.BigBoy(e.x, e.y);
                } else if (e.type === 'wallguy' && window.WallGuy) {
                    inst = new window.WallGuy(e.x, e.y);
                    // Create shield for WallGuy
                    if (window.EnemyShield && window.environment && window.environment.orientedBoxes) {
                        inst.shield = new window.EnemyShield(inst);
                        inst.shieldAngle = e.shieldAngle || 0;
                        
                        // Register shield as oriented box for collision (like ShieldWall ability)
                        // Note: w/h are swapped to match visual rendering (depth=local X, width=local Y)
                        inst.shield.collisionBox = {
                            x: inst.shield.x,
                            y: inst.shield.y,
                            w: inst.shield.depth,   // 20 units (local X - horizontal in rotated space)
                            h: inst.shield.width,   // 80 units (local Y - vertical in rotated space)
                            angle: inst.shieldAngle,
                            _enemyId: e.id,  // Track which enemy owns this
                            _isEnemyShield: true  // Mark as enemy shield (zombie projectiles pass through)
                        };
                        window.environment.orientedBoxes.push(inst.shield.collisionBox);
                        inst.shield._envBoxIndex = window.environment.orientedBoxes.length - 1;
                    }
                } else if (window.Enemy) {
                    inst = new window.Enemy(e.x, e.y);
                }
                    
                if (!inst) continue;
                
                // Setup instance properties
                inst._serverId = e.id;
                inst.serverSpawned = true;
                inst.type = e.type; // Preserve type from server for rendering (e.g., shield rendering checks)
                inst.x = e.x;
                inst.y = e.y;
                
                // Only apply server values if explicitly provided, otherwise keep constructor defaults
                if (e.radius !== undefined) inst.radius = e.radius;
                if (e.health !== undefined) inst.health = e.health;
                if (e.healthMax !== undefined) inst.healthMax = e.healthMax;
                if (e.speedMul !== undefined) inst.speedMul = e.speedMul;
                
                // Initialize network smoothing state
                    inst._net = {
                        tx: e.x,
                        ty: e.y,
                        ts: now
                    };
                    
                    // Add to enemies list and spatial grid
                    window.enemies.items.push(inst);
                    if (typeof window.enemies._insert === 'function') {
                        window.enemies._insert(inst);
                    }
                    
                    // Map to server ID for future updates
                    window._enemyByServerId.set(e.id, inst);
                }
                
                console.log('[Horde] Spawned', data.enemies.length, 'new enemies, total:', window.enemies.items.length);
            } catch (err) {
                console.error('[Horde] Error handling horde spawn:', err);
            }
        });

        // (Removed) ambientSpawned: now only count from hordeSpawned('ambient') to avoid double increments

        // Ambient spawner state for debug HUD
        this.socket.on('ambientState', (st) => {
            try { window._ambientState = st; } catch(_) {}
        });
        
        this.applyEnemyNetSmoothing = (dt) => {
            if (!window.__netEnemyPosAuth || !window.enemies) return;
            const k = 10; // blend per second
            const a = Math.min(1, dt * k);
            const items = window.enemies.items || [];
            for (let i = 0; i < items.length; i++) {
                const e = items[i];
                if (!e || !e._net) continue;
                if (Number.isFinite(e._net.tx) && Number.isFinite(e._net.ty)) {
                    // Blend toward server position
                    e.x = e.x + (e._net.tx - e.x) * a;
                    e.y = e.y + (e._net.ty - e.y) * a;
                    // Maintain spatial grid so collision/culling stay accurate
                    try {
                        const enemies = window.enemies;
                        if (enemies && typeof enemies._keyFromWorld === 'function' && enemies.grid) {
                            const oldKey = e._gridKey;
                            const newKey = enemies._keyFromWorld(e.x, e.y);
                            if (newKey && newKey !== oldKey) {
                                if (oldKey) {
                                    const bucket = enemies.grid.get(oldKey);
                                    if (bucket) {
                                        const idx = bucket.indexOf(e);
                                        if (idx !== -1) bucket.splice(idx, 1);
                                        if (bucket.length === 0) enemies.grid.delete(oldKey);
                                    }
                                }
                                e._gridKey = newKey;
                                let nb = enemies.grid.get(newKey);
                                if (!nb) { nb = []; enemies.grid.set(newKey, nb); }
                                nb.push(e);
                            }
                        }
                    } catch (_) {}
                }
                
                // Smooth shield angle for WallGuy (use shortest angular path)
                if (window.WallGuy && e instanceof window.WallGuy && Number.isFinite(e._net.targetShieldAngle)) {
                    if (Number.isFinite(e.shieldAngle)) {
                        // Calculate shortest angle difference (handle wrapping)
                        let angleDiff = e._net.targetShieldAngle - e.shieldAngle;
                        while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
                        while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
                        
                        // Interpolate angle smoothly
                        e.shieldAngle = e.shieldAngle + angleDiff * a;
                        
                        // Normalize angle to -π to π
                        while (e.shieldAngle > Math.PI) e.shieldAngle -= Math.PI * 2;
                        while (e.shieldAngle < -Math.PI) e.shieldAngle += Math.PI * 2;
                        
                        // Update shield position and collision box
                        if (e.shield) {
                            e.shield.update(0, e.shieldAngle);
                        }
                    }
                }
            }
        };

        // Ambient NPC updates
        this.applyAmbientNpcSync = (ambientList) => {
            if (!Array.isArray(ambientList) || !window.NPC_Lobby || !window.npcs) return;
            const expectedIds = new Set();
            for (const npcData of ambientList) {
                expectedIds.add(npcData.id);
                let existing = window.npcs.items.find(n => n && n.id === npcData.id && n.constructor && n.constructor.name === 'NPC_Lobby');
                if (!existing) {
                    existing = new window.NPC_Lobby(npcData.x, npcData.y);
                    existing.id = npcData.id;
                    existing.serverSpawned = true;
                    existing.radius = npcData.radius || 22;
                    if (npcData.color) existing.color = npcData.color;
                    if (npcData.barkInterval) existing._bark.interval = npcData.barkInterval;
                    if (npcData.barkGap) existing._bark.gap = npcData.barkGap;
                    if (npcData.barkTimer) existing._bark.timer = npcData.barkTimer;
                    window.npcs.add(existing);
                } else {
                    existing.x = npcData.x;
                    existing.y = npcData.y;
                }
            }
            // prune
            for (let i = window.npcs.items.length - 1; i >= 0; i--) {
                const npc = window.npcs.items[i];
                if (npc && npc.constructor && npc.constructor.name === 'NPC_Lobby' && npc.serverSpawned) {
                    if (!expectedIds.has(npc.id)) {
                        window.npcs.items.splice(i, 1);
                    }
                }
            }
        };

        this.socket.on('ambientNpcsSync', (data) => {
            try { this.applyAmbientNpcSync(data); }
            catch(e){ console.error('[Network] Error syncing ambientNpcsSync:', e); }
        });
        
        // ===== Level NPC state sync (server-authoritative) =====
        if (!window._npcByServerId) window._npcByServerId = new Map();
        
        this.socket.on('npcsState', (list) => {
            if (!Array.isArray(list) || !window.npcs) return;
            
            for (let i = 0; i < list.length; i++) {
                const s = list[i];
                let npc = window._npcByServerId.get(s.id);
                
                if (!npc) {
                    // Create NPC if it doesn't exist
                    if (s.type === 'NPC_A' && window.NPC_A) {
                        npc = new window.NPC_A(s.x, s.y);
                        npc.id = s.id;
                        npc.serverSpawned = true;
                        npc._serverControlled = true; // Mark as server-controlled
                        window.npcs.add(npc);
                        window._npcByServerId.set(s.id, npc);
                        console.log('[Network] Created server-controlled NPC_A:', s.id);
                    } else if (s.type === 'NPC_B' && window.NPC_B) {
                        npc = new window.NPC_B(s.x, s.y);
                        npc.id = s.id;
                        npc.serverSpawned = true;
                        npc._serverControlled = true;
                        window.npcs.add(npc);
                        window._npcByServerId.set(s.id, npc);
                        console.log('[Network] Created server-controlled NPC_B:', s.id);
                    } else if (s.type === 'NPC_A' && !window.NPC_A) {
                        console.warn('[Network] Cannot create NPC_A (id:', s.id, ') - class not loaded yet. Will retry on next sync.');
                    } else if (s.type === 'NPC_B' && !window.NPC_B) {
                        console.warn('[Network] Cannot create NPC_B (id:', s.id, ') - class not loaded yet. Will retry on next sync.');
                    } else {
                        console.warn('[Network] Unknown NPC type or missing class:', s.type);
                    }
                }
                
                if (npc) {
                    // Store server ID for damage relay
                    npc._serverId = s.id;
                    
                    // Store target position for interpolation (like enemies)
                    if (!npc._net) npc._net = {};
                    npc._net.tx = s.x;
                    npc._net.ty = s.y;
                    npc._net.ts = Date.now();
                    
                    // Apply server state (non-positional)
                    npc.state = s.state;
                    npc.alive = s.alive;
                    
                    // Update bark if changed
                    if (Array.isArray(s.barkLines) && npc._bark) {
                        npc._bark.lines = s.barkLines;
                        npc._bark.idx = s.barkIndex || 0;
                    }
                    
                    // Store target/following data for visual reference
                    if (s.followingPlayerId) {
                        npc._followingPlayerId = s.followingPlayerId;
                    }
                    if (s.targetEnemyId) {
                        npc._targetEnemyId = s.targetEnemyId;
                    }
                    
                    // Warning ring state (for explosive NPCs like Prisoner)
                    npc._warningActive = s.warningActive || false;
                    npc._warningPulse = s.warningPulse || 0;
                    npc._hostileTimer = s.hostileTimer || 0;
                    
                    // Talk interaction flag (server-authoritative)
                    npc._disableTalk = !(s.canTalk !== false); // Invert: canTalk=true means _disableTalk=false
                    
                    // NPC_B (Heretic Priest) hostile combat stats
                    if (s.type === 'NPC_B' && s.state === 'hostile') {
                        if (Number.isFinite(s.health)) npc.health = s.health;
                        if (Number.isFinite(s.healthMax)) npc.healthMax = s.healthMax;
                        if (typeof s.showHealthBar === 'boolean') npc._showHealthBar = s.showHealthBar;
                        if (s.hostilePhase) npc._hostilePhase = s.hostilePhase;
                        if (s.burstState) npc._burstState = s.burstState;
                        if (Number.isFinite(s.preHostileTimer)) npc._preHostileTimer = s.preHostileTimer;
                    }
                }
            }
            
            // Remove NPCs that are no longer in server state
            const serverIds = new Set(list.map(s => s.id));
            for (let i = window.npcs.items.length - 1; i >= 0; i--) {
                const npc = window.npcs.items[i];
                if (npc && npc._serverControlled && !serverIds.has(npc.id)) {
                    window._npcByServerId.delete(npc.id);
                    window.npcs.items.splice(i, 1);
                }
            }
        });
        
        // ===== Troop state sync (server-authoritative allied units) =====
        if (!window._troopByServerId) window._troopByServerId = new Map();
        if (!window.troops) window.troops = { items: [] };
        
        this.socket.on('troopsState', (data) => {
            if (!data || !window.Troop) return;
            
            // Handle new format with troops and barracks
            const list = Array.isArray(data) ? data : (data.troops || []);
            const barracks = data.barracks || [];
            
            // Update barracks
            if (!window._barracks) window._barracks = [];
            window._barracks = barracks;

            // Debug: store stuck-avoid zones for optional client overlay
            // (Server sends a small capped list in troopsState payload)
            if (data && Array.isArray(data.stuckZones)) {
                window._debugTroopStuckZones = data.stuckZones;
            }
            
            // Update troops
            for (let i = 0; i < list.length; i++) {
                const s = list[i];
                let troop = window._troopByServerId.get(s.id);
                
                if (!troop) {
                    // Create troop if it doesn't exist
                    troop = new window.Troop(s.x, s.y);
                    troop.id = s.id;
                    troop._serverId = s.id;
                    troop.serverSpawned = true;
                    troop.type = s.type || 'trooper_melee';
                    troop.faction = s.faction || 'newantioch';
                    window.troops.items.push(troop);
                    window._troopByServerId.set(s.id, troop);
                }
                
                if (troop) {
                    // Store target position for interpolation
                    if (!troop._net) troop._net = {};
                    troop._net.tx = s.x;
                    troop._net.ty = s.y;
                    troop._net.ts = Date.now();
                    
                    // Apply server state
                    troop.alive = s.alive !== false;
                    troop.state = s.state;
                    troop.type = s.type || 'trooper_melee';
                    
                    // Sync health from server
                    if (Number.isFinite(s.health)) troop.health = s.health;
                    if (Number.isFinite(s.healthMax)) troop.healthMax = s.healthMax;
                    
                    // Sync fire VFX state from server (dotStacks count)
                    if (Number.isFinite(s.dotStacksCount)) {
                        if (!troop.dotStacks) troop.dotStacks = [];
                        // Adjust client dotStacks array to match server count (for visual fire VFX only)
                        while (troop.dotStacks.length < s.dotStacksCount) {
                            troop.dotStacks.push({ visualOnly: true });
                        }
                        while (troop.dotStacks.length > s.dotStacksCount) {
                            troop.dotStacks.pop();
                        }
                    }
                    
                    // Update barrel angle for ranged troops and grenadiers
                    if ((s.type === 'trooper_ranged' || s.type === 'trooper_grenadier') && Number.isFinite(s._barrelAngle)) {
                        troop._barrelAngle = s._barrelAngle;
                    }

                    // Debug: zone escape arrow (server-selected walk target while escaping red zones)
                    troop._debugAvoidPhase = s.avoidPhase || null;
                    if (Number.isFinite(s.escapeTx) && Number.isFinite(s.escapeTy)) {
                        troop._debugEscapeTx = s.escapeTx;
                        troop._debugEscapeTy = s.escapeTy;
                    } else {
                        troop._debugEscapeTx = null;
                        troop._debugEscapeTy = null;
                    }
                }
            }
            
            // Remove troops that are no longer in server state
            const serverIds = new Set(list.map(s => s.id));
            for (let i = window.troops.items.length - 1; i >= 0; i--) {
                const troop = window.troops.items[i];
                if (troop && troop.serverSpawned && !serverIds.has(troop._serverId)) {
                    // Troops can disappear from `troopsState` due to death. Some server kill paths emit
                    // `troopDeath`/`entity_dead`, but others may only remove the troop from state.
                    // Route this removal through the unified entity death handler so blood pools spawn consistently.
                    try { if (window._troopByServerId) window._troopByServerId.delete(troop._serverId); } catch (_) {}

                    if (typeof this._handleEntityDead === 'function') {
                        this._handleEntityDead({
                            entityType: 'troop',
                            id: troop._serverId,
                            x: troop.x,
                            y: troop.y,
                            kind: troop.type || 'troop',
                            cause: 'missing_from_troopsState'
                        }, 'troopsState_cleanup');
                        // `_handleEntityDead` will remove from `window.troops.items`.
                    } else {
                        window.troops.items.splice(i, 1);
                    }
                }
            }
        });
        
        // Troop melee attack VFX and damage
        this.socket.on('troopAttack', (data) => {
            try {
                if (!window.projectiles || !window.Bullet || !window.SlashVfx) return;
                
                const color = '#2a9d8f'; // Dark teal
                const angle = data.angle;
                const projRadius = 40;
                const life = 0.1;
                const speed = 0;
                const dirX = Math.cos(angle);
                const dirY = Math.sin(angle);
                
                // Spawn slash VFX at troop position (like NPC attack)
                const slash = new window.SlashVfx(data.x, data.y, angle, color);
                slash.drawBehind = true;
                window.projectiles.impacts.push(slash);
                
                // Spawn cone bullet for damage visual (like NPC attack)
                const opts = { 
                    isCone: true, 
                    coneRange: projRadius * 3, 
                    coneHalf: 0.6, 
                    damage: 0, // Damage is server-authoritative
                    drawBehind: true,
                    serverFired: true // Mark as server-fired to prevent client damage
                };
                window.projectiles.items.push(new window.Bullet(
                    data.x, data.y, 
                    dirX * speed, dirY * speed, 
                    projRadius, color, life, angle, true, opts
                ));
                
                // Damage numbers are driven by server `enemyHealthUpdate` (includes damage + position).
                // This avoids coord truthy bugs (x/y can be 0) and keeps grenade/melee/ranged consistent.
            } catch(e) {
                console.error('[Network] Error handling troopAttack:', e);
            }
        });
        
        // Troop hitscan fire VFX (ranged troops using turret-style hitscan)
        this.socket.on('troopHitscan', (data) => {
            try {
                if (!window.projectiles || !window.Bullet) return;
                
                const color = '#5dd9d9'; // Light teal tracer (troop color)
                
                // Find the troop for muzzle flash and barrel position
                let troop = null;
                if (window.troops && window.troops.items) {
                    troop = window.troops.items.find(t => t && t.id === data.troopId);
                    if (troop) {
                        // Add muzzle flash to troop (like turrets)
                        if (!troop.muzzleFlashes) troop.muzzleFlashes = [];
                        troop.muzzleFlashes.push({
                            life: 0.15,
                            intensity: 1.0
                        });
                    }
                }
                
                // Calculate barrel tip position (like turrets do)
                const barrelLength = 22; // Match troop barrel length
                const tipX = data.x + Math.cos(data.angle) * (barrelLength + 8);
                const tipY = data.y + Math.sin(data.angle) * (barrelLength + 8);
                
                const dirX = Math.cos(data.angle);
                const dirY = Math.sin(data.angle);
                const bulletSpeed = 16000; // Same as turrets
                const vx = dirX * bulletSpeed;
                const vy = dirY * bulletSpeed;
                
                // Calculate travel distance to ACTUAL hit position (from server)
                // Use targetX/targetY from server (where the shot actually hit the enemy)
                let travelDist;
                let endX, endY;
                
                if (data.targetX !== undefined && data.targetY !== undefined && !data.blocked && !data.hitHazard) {
                    // Shot hit an enemy - stop projectile VFX at enemy position
                    endX = data.targetX;
                    endY = data.targetY;
                    travelDist = Math.hypot(endX - tipX, endY - tipY);
                } else {
                    // Shot was blocked or missed - fly to max range
                    const maxRange = 650; // Slightly beyond troop range (600)
                    endX = tipX + dirX * maxRange;
                    endY = tipY + dirY * maxRange;
                    travelDist = maxRange;
                }
                
                // MATCH TURRET BULLET OPTIONS EXACTLY
                const options = {
                    damage: 0, // No damage (hitscan damage already applied by server)
                    shape: 'rect', // Rectangular bullet like turrets
                    rectWidth: 36,
                    rectHeight: 2,
                    impactScale: 1.4,
                    targetX: endX, // Fly straight to hit point
                    targetY: endY,
                    maxTurnRate: 0, // No turning - straight line
                    travelDistance: travelDist,
                    owner: null, // No specific owner (server-spawned troops)
                    sourceWeaponIndex: 6 // Weapon 7 (turret acts like weapon 7)
                };
                
                // Damage numbers are driven by server `enemyHealthUpdate` (includes damage + position).
                // This avoids duplicates when other systems also display damage locally.
                
                // Calculate bullet life (travelDist / speed)
                const bulletLife = Math.min(3.6, travelDist / bulletSpeed);
                
                // Create visual tracer bullet (for impact effects on walls/obstacles)
                const bullet = window.bulletPool 
                    ? window.bulletPool.get(tipX, tipY, vx, vy, 6, color, bulletLife, data.angle, true, options)
                    : new window.Bullet(tipX, tipY, vx, vy, 6, color, bulletLife, data.angle, true, options);
                
                window.projectiles.items.push(bullet);
            } catch(e) {
                console.error('[Network] Error handling troopHitscan:', e);
            }
        });
        
        // Troop grenade attack event (grenadier throws explosion projectile)
        this.socket.on('troopGrenade', (data) => {
            try {
                if (!window.projectiles || !window.Bullet) return;
                
                // Find the troop for muzzle flash and barrel position
                let troop = null;
                if (window.troops && window.troops.items) {
                    troop = window.troops.items.find(t => t && t.id === data.troopId);
                    if (troop) {
                        // Add muzzle flash to troop (like turrets)
                        if (!troop.muzzleFlashes) troop.muzzleFlashes = [];
                        troop.muzzleFlashes.push({
                            life: 0.15,
                            intensity: 1.0
                        });
                    }
                }
                
                // Calculate barrel tip position for grenade launch
                const barrelLength = 22; // Match troop barrel length
                const tipX = data.x + Math.cos(data.angle) * (barrelLength + 8);
                const tipY = data.y + Math.sin(data.angle) * (barrelLength + 8);
                
                // Calculate velocity components (like artillery witch)
                const grenadeSpeed = 600; // Match weapon 2 speed
                const dirX = Math.cos(data.angle);
                const dirY = Math.sin(data.angle);
                const vx = dirX * grenadeSpeed;
                const vy = dirY * grenadeSpeed;
                
                // Create grenade projectile (like weapon 2 but with reduced radius/damage)
                // Bullet constructor: (x, y, vx, vy, radius, color, lifeSeconds, angle, noDamage, options)
                const grenade = new window.Bullet(
                    tipX,
                    tipY,
                    vx,
                    vy,
                    7,              // radius
                    '#ff8800',      // orange color
                    3.6,            // life in seconds
                    data.angle,     // angle
                    false,          // noDamage
                    {
                        targetX: data.targetX,
                        targetY: data.targetY,
                        maxTurnRate: 13.5,
                        bias: (Math.random() < 0.5 ? -1 : 1) * 1.8,
                        shadowEnabled: true,
                        accelBallistic: true,
                        ignoreEnvironment: true,
                        ignoreEnemies: true,
                        deathYellowCircle: true,
                        // IMPORTANT: troop grenades must NOT inherit player stats (crit/loot).
                        // Server applies troop grenade damage authoritatively; client renders VFX only.
                        owner: null,
                        troopFired: true,
                        explosionRadiusMultiplier: data.explosionRadius / 100,
                        explosionDamageMultiplier: data.explosionDamage || 0.3,
                        projectileSizeMultiplier: 1.0
                    }
                );
                
                grenade.sourceWeaponIndex = 1; // Mark as weapon 2-like for proper logging
                window.projectiles.items.push(grenade);
                
                // Debug-only: logging here can severely impact FPS when many grenades are fired.
                if (window.DEBUG_TROOP_GRENADE === true) {
                    console.log('[TroopGrenade] Created grenade at', tipX.toFixed(1), tipY.toFixed(1), 
                               'velocity:', vx.toFixed(1), vy.toFixed(1),
                               'target:', data.targetX.toFixed(1), data.targetY.toFixed(1),
                               'radius:', data.explosionRadius, 'dmgMult:', data.explosionDamage);
                }
                           
            } catch(e) {
                console.error('[Network] Error handling troopGrenade:', e);
            }
        });
        
        // Troop damaged event (show damage numbers and update health)
        this.socket.on('troopDamaged', (data) => {
            try {
                if (!window.troops || !window.troops.items) return;
                
                // Debug: Log received event
                // console.log('[Troop] Received troopDamaged:', data.troopId, 'damage:', data.damage, 'newHealth:', data.health);
                
                // Find the troop and update health
                const troop = window.troops.items.find(t => t && t.id === data.troopId);
                if (troop) {
                    // console.log('[Troop] Found troop, updating health from', troop.health, 'to', data.health);
                    troop.health = data.health;
                    troop.healthMax = data.healthMax;
                    
                    // Show damage number
                    if (window.enqueueDamageText && data.damage) {
                        window.enqueueDamageText({
                            x: data.x,
                            y: data.y,
                            text: `-${Math.round(data.damage)}`,
                            color: '#ff3333', // Red for damage
                            vy: -60,
                            life: 0.8
                        });
                    }
                } else {
                    console.warn('[Troop] Could not find troop with id:', data.troopId, 'Available troops:', window.troops.items.map(t => t?.id));
                }
            } catch(e) {
                console.error('[Network] Error handling troopDamaged:', e);
            }
        });
        
        // Troop death event
        this.socket.on('troopDeath', (data) => {
            try {
                // Legacy event: route to unified entity_dead handler.
                if (typeof this._handleEntityDead === 'function') {
                    this._handleEntityDead({
                        entityType: 'troop',
                        id: data?.troopId,
                        x: data?.x,
                        y: data?.y,
                        kind: data?.kind || data?.type || 'troop',
                        cause: data?.cause
                    }, 'troopDeath');
                }
            } catch(e) {
                console.error('[Network] Error handling troopDeath:', e);
            }
        });
        
        // NPC attack VFX
        this.socket.on('npcAttack', (data) => {
            try {
                if (!window.projectiles || !window.Bullet || !window.SlashVfx) return;
                
                const color = '#76ffb0';
                const angle = data.angle;
                const projRadius = 40;
                const life = 0.1;
                const speed = 0;
                const dirX = Math.cos(angle);
                const dirY = Math.sin(angle);
                
                // Spawn slash VFX
                const slash = new window.SlashVfx(data.x, data.y, angle, color);
                slash.drawBehind = true;
                window.projectiles.impacts.push(slash);
                
                // Spawn cone bullet for damage visual
                const opts = { 
                    isCone: true, 
                    coneRange: projRadius * 3, 
                    coneHalf: 0.6, 
                    damage: 0, // Damage is server-authoritative
                    drawBehind: true,
                    serverFired: true // Mark as server-fired to prevent client damage
                };
                window.projectiles.items.push(new window.Bullet(
                    data.x, data.y, 
                    dirX * speed, dirY * speed, 
                    projRadius, color, life, angle, true, opts
                ));
            } catch(e) {
                console.error('[Network] Error handling npcAttack:', e);
            }
        });
        
        // NPC explosion VFX
        this.socket.on('npcExplode', (data) => {
            try {
                if (!window.ExplosionVfx || !window.projectiles) return;
                
                // Spawn 3x explosion VFX
                window.projectiles.impacts.push(new window.ExplosionVfx(
                    data.x, data.y, '#ffa64d', { scale: 3 }
                ));
                
                // Spawn blast ring visual
                const BLAST_RADIUS = 300;
                window.projectiles.impacts.push({
                    life: 0.25,
                    totalLife: 0.25,
                    radius: BLAST_RADIUS,
                    x: data.x,
                    y: data.y,
                    drawBehind: true,
                    draw: function(ctx, cam) {
                        const t = Math.max(this.life, 0) / this.totalLife;
                        const alpha = 0.22 * t;
                        const sx = this.x - cam.x;
                        const sy = this.y - cam.y;
                        ctx.save();
                        ctx.globalAlpha = alpha;
                        ctx.strokeStyle = '#ffd36b';
                        ctx.lineWidth = 3;
                        ctx.beginPath();
                        ctx.arc(sx, sy, this.radius, 0, Math.PI * 2);
                        ctx.stroke();
                        ctx.restore();
                    },
                    update: function(dt) {
                        this.life -= dt;
                    }
                });
                
                console.log('[Network] NPC explosion VFX spawned at', data.x, data.y);
            } catch(e) {
                console.error('[Network] Error handling npcExplode:', e);
            }
        });
        
        // NPC_B (Heretic Priest) fire attack VFX
        this.socket.on('npc_fire', (data) => {
            try {
                if (!window.projectiles || !window.Bullet) return;
                
                // Get weapon-4 config for visual consistency
                const weapons = window.projectiles.weapons || [];
                const w4 = weapons[3];
                if (!w4) return;
                
                const angle = data.angle;
                const dirX = data.dirX;
                const dirY = data.dirY;
                const spawnX = data.x + dirX * 32; // Spawn slightly away from NPC
                const spawnY = data.y + dirY * 32;
                const vx = dirX * (w4.projectileSpeed || 600);
                const vy = dirY * (w4.projectileSpeed || 600);
                
                // Build cone options similar to weapon 4
                const options = { 
                    isCone: true, 
                    sourceWeaponIndex: 3,
                    damage: 0, // Damage is server-authoritative
                    serverFired: true // Mark as server-fired to prevent client damage
                };
                
                let baseRange = ((w4.projectileRadius != null ? w4.projectileRadius : 6) * 3) * 5;
                let baseHalf = 0.2;
                const lengthVariation = 0.20;
                const widthVariation = 0.20;
                const rangeMul = (1 - lengthVariation) + Math.random() * (2 * lengthVariation);
                const halfMul = (1 - widthVariation) + Math.random() * (2 * widthVariation);
                options.coneRange = baseRange * rangeMul;
                options.coneHalf = baseHalf * halfMul;
                
                // Randomized life like weapon 4
                const life = (0.3 + Math.random() * 0.3) * 1.25;
                const radius = w4.projectileRadius || 6;
                const color = w4.color || '#ffb076';
                
                window.projectiles.items.push(new window.Bullet(
                    spawnX, spawnY, vx, vy, radius, color, life, angle, false, options
                ));
                
                console.log('[Network] NPC_B fire VFX spawned at', data.x, data.y, 'angle', angle);
            } catch(e) {
                console.error('[Network] Error handling npc_fire:', e);
            }
        });
        
        // NPC damage feedback
        this.socket.on('npcDamaged', (data) => {
            try {
                const npc = window._npcByServerId && window._npcByServerId.get(data.npcId);
                if (!npc) return;
                
                // Update health
                if (Number.isFinite(data.health)) npc.health = data.health;
                if (Number.isFinite(data.healthMax)) npc.healthMax = data.healthMax;
                
                // Show floating damage number
                if (window.enqueueDamageText && Number.isFinite(data.damage)) {
                    window.enqueueDamageText({
                        x: npc.x,
                        y: npc.y - (npc.radius || 24) - 6,
                        text: Math.round(data.damage).toString(),
                        crit: false,
                        color: '#ffffff',
                        vy: -80,
                        life: 0.8
                    });
                }
                
                console.log('[Network] NPC damaged:', data.npcId, 'health now', data.health);
            } catch(e) {
                console.error('[Network] Error handling npcDamaged:', e);
            }
        });
        
        // NPC DOT damage feedback
        this.socket.on('npcDotDamage', (data) => {
            try {
                // Show floating DOT damage number (orange for burn)
                if (window.enqueueDamageText && Number.isFinite(data.damage)) {
                    window.enqueueDamageText({
                        x: data.x,
                        y: data.y - 30,
                        text: Math.round(data.damage).toString(),
                        crit: false,
                        color: '#ff9f2b', // Orange for DOT
                        vy: -60,
                        life: 0.6
                    });
                }
                
                console.log('[Network] NPC DOT damage:', data.npcId, 'damage', data.damage);
            } catch(e) {
                console.error('[Network] Error handling npcDotDamage:', e);
            }
        });
        
        // NPC death event
        this.socket.on('npc_dead', (data) => {
            try {
                const npc = window._npcByServerId && window._npcByServerId.get(data.npcId);
                if (!npc) return;
                
                npc.alive = false;
                npc.health = 0;
                
                // Spawn death VFX
                if (window.projectiles && window.ExplosionVfx) {
                    window.projectiles.impacts.push(new window.ExplosionVfx(
                        data.x, data.y, '#ff7a3b', { scale: 1.2 }
                    ));
                }
                
                console.log('[Network] NPC died:', data.npcId, 'at', data.x, data.y);
            } catch(e) {
                console.error('[Network] Error handling npc_dead:', e);
            }
        });
        
        // Player DOT applied (for fire VFX)
        this.socket.on('playerDotApplied', (data) => {
            try {
                // Find the target player
                let targetPlayer = null;
                if (data.playerId === this.playerId || data.playerId === window.socket?.id) {
                    targetPlayer = window.player;
                } else {
                    // Remote player - find in other players Map
                    if (this.otherPlayers && this.otherPlayers.has(data.playerId)) {
                        targetPlayer = this.otherPlayers.get(data.playerId);
                    } else if (window._remotePlayers) {
                        targetPlayer = window._remotePlayers.get(data.playerId);
                    }
                }
                
                if (!targetPlayer) {
                    console.warn('[Network] playerDotApplied: Could not find player', data.playerId);
                    return;
                }
                
                // Initialize DOT stacks on client for visual fire effect (use _playerDotStacks to match Player.draw())
                if (!Array.isArray(targetPlayer._playerDotStacks)) {
                    targetPlayer._playerDotStacks = [];
                }
                
                // Add DOT stack for visual fire effect (damage is server-authoritative)
                targetPlayer._playerDotStacks.push({
                    dps: data.dps || 5,
                    timeLeft: data.duration || 3,
                    sourceId: data.sourceNpcId || data.sourcePlayerId
                });
                
                try {
                    if (window.GameConstants?.ENABLE_DEBUG_LOGS) {
                        console.log('🔥 [Network] Player DOT applied:', data.playerId, 'DPS:', data.dps, 'Duration:', data.duration, 'Total stacks:', targetPlayer._playerDotStacks.length, 'isMe:', data.playerId === this.playerId);
                    }
                } catch(_) {}
            } catch(e) {
                console.error('[Network] Error handling playerDotApplied:', e);
            }
        });
        
        // NPC position smoothing (like enemies)
        this.applyNpcNetSmoothing = (dt) => {
            if (!window.npcs || !window._npcByServerId) return;
            const k = 10; // blend per second (same as enemies)
            const a = Math.min(1, dt * k);
            
            for (const [id, npc] of window._npcByServerId) {
                if (!npc || !npc._net) continue;
                if (Number.isFinite(npc._net.tx) && Number.isFinite(npc._net.ty)) {
                    // Blend toward server position
                    npc.x = npc.x + (npc._net.tx - npc.x) * a;
                    npc.y = npc.y + (npc._net.ty - npc.y) * a;
                }
            }
        };
        
        this.socket.on('readyTimerUpdate', (data) => {
            if (window.gameDebugger && typeof window.gameDebugger.verbose === 'function') {
                window.gameDebugger.verbose('GAMEFLOW', 'Ready timer update', data);
            }
            
            // Synchronize all ReadyZone instances
            try {
                if (window._readyZone) {
                    window._readyZone.syncFromServer(data);
                }
            } catch (e) {
                console.error('[Network] Error synchronizing ready timer:', e);
            }
        });

        this.socket.on('extractionTimerUpdate', (data) => {
            if (window.gameDebugger && typeof window.gameDebugger.verbose === 'function') {
                window.gameDebugger.verbose('GAMEFLOW', 'Extraction timer update', data);
            }
            
            // Synchronize extraction zone instances
            try {
                const zone = data.type === 'heretic' ? window.hereticExtractionZone : window.extractionZone;
                if (zone && typeof zone.syncFromServer === 'function') {
                    zone.syncFromServer(data);
                }
            } catch (e) {
                console.error('[Network] Error synchronizing extraction timer:', e);
            }
        });

        // Server-driven phase timer for Extraction mode (Search/Guard count down, Waves count up)
        this.socket.on('phase_timer_update', (state) => {
            try {
                if (!window.modeTimer) return;
                
                // Update horde timer
                if (typeof state.timeSinceLastHorde === 'number') {
                    window._hordeTimer = state.timeSinceLastHorde;
                }
                
                // Update the mode timer based on server state
                if (state.phase === 'search') {
                    window.modeTimer.currentName = 'Search';
                    // Server sends timeElapsed, we need searchDuration to count down properly
                    const searchDuration = state.searchDuration || 120;
                    window.modeTimer.timeLeft = Math.max(0, searchDuration - state.timeElapsed);
                } else if (state.phase === 'guard') {
                    // Guard phase counts DOWN
                    window.modeTimer.currentName = 'Guard';
                    const guardDuration = state.guardDuration || 60;
                    window.modeTimer.timeLeft = Math.max(0, guardDuration - state.timeElapsed);
                } else if (state.phase === 'wave') {
                    // Waves count UP, include wave label if available
                    const waves = Array.isArray(state.waves) ? state.waves : [];
                    const label = state.currentWave && waves[state.currentWave - 1] ? waves[state.currentWave - 1].label : `Wave ${state.currentWave}`;
                    window.modeTimer.currentName = label || 'Wave';
                    window.modeTimer.timeLeft = state.timeElapsed; // count up
                }
            } catch (e) {
                console.error('[Network] Error handling phase_timer_update:', e);
            }
        });

        // Optional: Phase change events for visual/audio feedback
        this.socket.on('phase_change', (data) => {
            console.log('[Network] Phase changed to:', data.phase);
            
            // Show notification when transitioning to guard phase (artifact revealed)
            if (data.phase === 'guard' && window.ui) {
                window.ui.showNotification('The artifact has been revealed!', 3000);
            }
        });

        // Optional: Wave start events for visual/audio feedback
        this.socket.on('wave_start', (data) => {
            console.log(`[Network] Wave ${data.wave} started!`);
            // TODO: Add visual/audio feedback for wave start
        });
        
        // Horde spawned event (for debug display)
        this.socket.on('horde_spawned', (data) => {
            window._lastHordeDifficulty = data.difficulty;
            window._lastHordeSpawnCount = data.count;
            window._lastHordeNumber = data.hordeNumber;
            window._hordeTimer = data.timeSinceLastHorde || 0;  // Reset timer on spawn
            console.log(`[Horde] Spawned horde #${data.hordeNumber}: difficulty ${data.difficulty}, count ${data.count}, phase ${data.phase}`);
        });

        // Chest timer and open replication
        this.socket.on('chestTimerUpdate', (data) => {
            try {
                if (!window._chestsNet) window._chestsNet = new Map();
                let c = window._chestsNet.get(data.id);
                if (!c) { c = { id: data.id, x: data.x, y: data.y, variant: data.variant }; window._chestsNet.set(data.id, c); }
                c.started = !!data.started;
                c.timeLeft = data.timeLeft;
                c.timeTotal = data.timeTotal;
                c.startedBy = data.startedBy;
                // If this is a gold chest that exists locally, keep its UI timer in sync
                try {
                    const list = (typeof window.getChests === 'function') ? window.getChests() : [];
                    for (let i = 0; i < list.length; i++) {
                        const chest = list[i];
                        const id = chest._id || (chest._id = `${Math.round(chest.x)},${Math.round(chest.y)}`);
                        if (id === data.id && chest.variant !== 'brown') {
                            chest.opening = c.started;
                            chest.openTimeTotal = c.timeTotal;
                            chest.openTimeLeft = c.timeLeft;
                            // Update health from server
                            if (data.health !== undefined) chest.health = data.health;
                            if (data.healthMax !== undefined) chest.healthMax = data.healthMax;
                            break;
                        }
                    }
                } catch(_) {}
            } catch(e) { console.error('[Network] Error handling chestTimerUpdate:', e); }
        });

        this.socket.on('chestOpened', (data) => {
            try {
                // Update local chest state
                const list = (typeof window.getChests === 'function') ? window.getChests() : [];
                for (let i = 0; i < list.length; i++) {
                    const chest = list[i];
                    const id = chest._id || (chest._id = `${Math.round(chest.x)},${Math.round(chest.y)}`);
                    if (id !== data.id) continue;
                    chest.opening = false; chest.opened = true;
                    if ((data.variant === 'brown' || data.variant === 'startGear') && Array.isArray(data.groundItems) && window.GameObjects && window.GameObjects.HexStat) {
                        // Use server-tracked ground items instead of local chest.drops for multiplayer synchronization
                        const HexStat = window.GameObjects.HexStat;
                        if (!Array.isArray(window.bossDrops)) window.bossDrops = [];
                        
                        for (let j = 0; j < data.groundItems.length; j++) {
                            const item = data.groundItems[j];
                            const rarity = { name: item.rarityName, color: item.color };
                            const hexStat = new HexStat(item.x, item.y, item.vx, item.vy, { 
                                label: item.label, 
                                fill: rarity.color, 
                                rarity: rarity 
                            });
                            hexStat.onGround = false;
                            // Attach server ID for synchronized pickup
                            hexStat._serverId = item.id;
                            window.bossDrops.push(hexStat);
                        }
                        console.log('[Network] Added', data.groundItems.length, 'chest loot items to bossDrops with server IDs');
                    }
                    if (data.variant === 'gold' && data.artifact && window.GameObjects && window.GameObjects.Artifact) {
                        const { Artifact } = window.GameObjects;
                        const vx = Number.isFinite(data.artifact.vx) ? data.artifact.vx : 160;
                        const vy = Number.isFinite(data.artifact.vy) ? data.artifact.vy : -220;
                        // Pass health from server (shared health pool between chest and artifact)
                        const health = data.health !== undefined ? data.health : chest.health;
                        const healthMax = data.healthMax !== undefined ? data.healthMax : chest.healthMax;
                        chest.artifact = new Artifact(chest.x, chest.y, vx, vy, health, healthMax);
                    }
                    break;
                }
            } catch(e) { console.error('[Network] Error handling chestOpened:', e); }
        });
        
        // Artifact state replication
        // Handle boss spawn data (triggered when chest starts opening)
        this.socket.on('bossSpawnData', (data) => {
            try {
                console.log('[Network] bossSpawnData received:', data);
                
                // Apply server-authoritative extraction zone
                if (data.extractionZone && !window.extractionZone && window.GameObjects && window.GameObjects.ExtractionZone) {
                    window.extractionZone = new window.GameObjects.ExtractionZone(
                        data.extractionZone.x, 
                        data.extractionZone.y, 
                        data.extractionZone.size || 300
                    );
                    window._plannedExtractionHint = { x: data.extractionZone.x, y: data.extractionZone.y };
                    console.log('[Network] Created extraction zone from server at', data.extractionZone.x.toFixed(1), data.extractionZone.y.toFixed(1));
                }
                
                // Apply server-authoritative heretic extraction zone if provided
                if (data.hereticExtractionZone && !window.hereticExtractionZone && window.GameObjects && window.GameObjects.HereticExtractionZone) {
                    window.hereticExtractionZone = new window.GameObjects.HereticExtractionZone(
                        data.hereticExtractionZone.x,
                        data.hereticExtractionZone.y,
                        data.hereticExtractionZone.size || 300
                    );
                    console.log('[Network] Created heretic extraction zone from server at', data.hereticExtractionZone.x.toFixed(1), data.hereticExtractionZone.y.toFixed(1));
                }
                
                // Spawn boss at server-authoritative position
                if (data.bossSpawn && !window.state.bossSpawned && window.ArtilleryWitch && window.enemies) {
                    console.log('[Network] bossSpawnData: Creating Artillery Witch at', data.bossSpawn.x.toFixed(1), data.bossSpawn.y.toFixed(1));
                    const boss = new window.ArtilleryWitch(data.bossSpawn.x, data.bossSpawn.y);
                    
                    console.log('[Network] Boss created:', {
                        x: boss.x,
                        y: boss.y,
                        radius: boss.radius,
                        type: boss.type,
                        color: boss.color,
                        alive: boss.alive,
                        health: boss.health,
                        healthMax: boss.healthMax
                    });
                    
                    // Mark as server-spawned so it's treated as authoritative
                    boss._serverSpawned = true;
                    boss.serverSpawned = true;
                    boss._serverId = `boss_${data.bossSpawn.x.toFixed(0)}_${data.bossSpawn.y.toFixed(0)}`;
                    // Initialize network smoothing target
                    boss._net = { tx: data.bossSpawn.x, ty: data.bossSpawn.y, ts: Date.now() };
                    
                    console.log('[Network] Adding boss to enemies.items (current length:', window.enemies.items.length, ')');
                    window.enemies.items.push(boss);
                    console.log('[Network] Boss added, new length:', window.enemies.items.length);
                    
                    if (typeof window.enemies._insert === 'function') {
                        console.log('[Network] Inserting boss into spatial grid');
                        window.enemies._insert(boss);
                        console.log('[Network] Boss inserted into grid');
                    } else {
                        console.warn('[Network] enemies._insert not available!');
                    }
                    
                    // CRITICAL: Register boss in server ID map so it receives position updates
                    if (!window._enemyByServerId) window._enemyByServerId = new Map();
                    window._enemyByServerId.set(boss._serverId, boss);
                    window.state.bossSpawned = true;
                    console.log('[Network] ✓ Boss fully spawned from bossSpawnData at', data.bossSpawn.x.toFixed(1), data.bossSpawn.y.toFixed(1), 'with server ID:', boss._serverId);
                }
            } catch(e) { console.error('[Network] Error handling bossSpawnData:', e); }
        });

        this.socket.on('artifactPickedUp', (data) => {
            try {
                const list = (typeof window.getChests === 'function') ? window.getChests() : [];
                for (let i = 0; i < list.length; i++) {
                    const chest = list[i];
                    const id = chest._id || (chest._id = `${Math.round(chest.x)},${Math.round(chest.y)}`);
                    if (id !== data.chestId) continue;
                    if (!chest.opened || chest.variant === 'brown') break;
                    if (!chest.artifact) break;
                    if (data.playerId === this.playerId) {
                        // Local pickup: attach to our player
                        if (window.player) chest.artifact.carriedBy = window.player;
                    } else {
                        // Remote pickup: remove from our world so it disappears
                        chest.artifact = null;
                    }
                    try { if (window.state) window.state.artifactEverPicked = true; } catch(_) {}
                    // Track carrier globally for rendering on other clients
                    this.artifactCarrierId = data.playerId;
                    break;
                }
                
                // Apply server-authoritative extraction zone and boss spawn positions
                console.log('[Network] artifactPickedUp received, extractionZone data:', data.extractionZone);
                if (data.extractionZone && !window.extractionZone && window.GameObjects && window.GameObjects.ExtractionZone) {
                    window.extractionZone = new window.GameObjects.ExtractionZone(
                        data.extractionZone.x, 
                        data.extractionZone.y, 
                        data.extractionZone.size || 300
                    );
                    window._plannedExtractionHint = { x: data.extractionZone.x, y: data.extractionZone.y };
                    console.log('[Network] Created extraction zone from server at', data.extractionZone.x.toFixed(1), data.extractionZone.y.toFixed(1));
                } else {
                    console.log('[Network] Skipped extraction zone creation:', {
                        hasData: !!data.extractionZone,
                        alreadyExists: !!window.extractionZone,
                        hasGameObjects: !!window.GameObjects,
                        hasExtractionZone: !!(window.GameObjects && window.GameObjects.ExtractionZone)
                    });
                }
                
                // Apply server-authoritative heretic extraction zone if provided
                // Make it visible to ALL players (not just converted ones) so non-evil players can see where the evil player needs to go
                if (data.hereticExtractionZone && !window.hereticExtractionZone && window.GameObjects && window.GameObjects.HereticExtractionZone) {
                    window.hereticExtractionZone = new window.GameObjects.HereticExtractionZone(
                        data.hereticExtractionZone.x,
                        data.hereticExtractionZone.y,
                        data.hereticExtractionZone.size || 300
                    );
                    console.log('[Network] Created heretic extraction zone from server at', data.hereticExtractionZone.x.toFixed(1), data.hereticExtractionZone.y.toFixed(1));
                }
                
                // Spawn boss at server-authoritative position
                if (data.bossSpawn && !window.state.bossSpawned && window.ArtilleryWitch && window.enemies) {
                    const boss = new window.ArtilleryWitch(data.bossSpawn.x, data.bossSpawn.y);
                    // Mark as server-spawned so it's treated as authoritative
                    boss._serverSpawned = true;
                    boss.serverSpawned = true; // Add both for consistency
                    boss._serverId = `boss_${data.bossSpawn.x.toFixed(0)}_${data.bossSpawn.y.toFixed(0)}`;
                    window.enemies.items.push(boss);
                    if (typeof window.enemies._insert === 'function') window.enemies._insert(boss);
                    // CRITICAL: Register boss in server ID map so it receives position updates
                    if (!window._enemyByServerId) window._enemyByServerId = new Map();
                    window._enemyByServerId.set(boss._serverId, boss);
                    window.state.bossSpawned = true;
                    console.log('[Network] Spawned boss from server at', data.bossSpawn.x.toFixed(1), data.bossSpawn.y.toFixed(1), 'with server ID:', boss._serverId);
                }
            } catch(e) { console.error('[Network] Error handling artifactPickedUp:', e); }
        });

        this.socket.on('artifactDropped', (data) => {
            try {
                const list = (typeof window.getChests === 'function') ? window.getChests() : [];
                for (let i = 0; i < list.length; i++) {
                    const chest = list[i];
                    const id = chest._id || (chest._id = `${Math.round(chest.x)},${Math.round(chest.y)}`);
                    if (id !== data.chestId) continue;
                    if (!chest.opened || chest.variant === 'brown') break;
                    if (window.GameObjects && window.GameObjects.Artifact) {
                        const { Artifact } = window.GameObjects;
                        const vx = Number.isFinite(data.vx) ? data.vx : 0;
                        const vy = Number.isFinite(data.vy) ? data.vy : 0;
                        const art = new Artifact(
                            data.x,
                            data.y,
                            vx,
                            vy,
                            data.health,
                            data.healthMax
                        );
                        art.onGround = false;
                        chest.artifact = art;
                    }
                    // Clear carrier tracking
                    this.artifactCarrierId = null;
                    break;
                }
            } catch(e) { console.error('[Network] Error handling artifactDropped:', e); }
        });
        
        // Battery system events (RadioTower power system)
        this.socket.on('batteryStationState', (data) => {
            try {
                // Initialize battery station on client using server-provided position
                if (!window._batteryStation && window.BatteryStation) {
                    window._batteryStation = new window.BatteryStation(
                        data.x, data.y,
                        data.radioTowerX, data.radioTowerY
                    );
                    console.log('[Network] Created BatteryStation at', data.x, data.y);
                }
                
                // Create RadioTower at server-provided position (random in Zone C or D)
                if (typeof RadioTower !== 'undefined' && data.radioTowerX != null && data.radioTowerY != null) {
                    // Remove any existing RadioTower from decorations
                    if (window._decorations) {
                        window._decorations = window._decorations.filter(dec => 
                            !dec || !dec.constructor || dec.constructor.name !== 'RadioTower'
                        );
                    } else {
                        window._decorations = [];
                    }
                    
                    // Create new RadioTower at server position
                    const tower = new RadioTower(data.radioTowerX, data.radioTowerY, { scale: 1.2 });
                    tower.isPowered = data.isPowered || false;
                    window._decorations.push(tower);
                    console.log('[Network] Created RadioTower at server position:', data.radioTowerX, data.radioTowerY);
                }
                
                if (window._batteryStation) {
                    window._batteryStation.slots = data.slots || [false, false, false];
                    window._batteryStation.isPowered = data.isPowered || false;
                    
                    // Update RadioTower power state if it exists
                    if (window._decorations) {
                        for (const dec of window._decorations) {
                            if (dec && dec.constructor && dec.constructor.name === 'RadioTower') {
                                dec.isPowered = data.isPowered;
                            }
                        }
                    }
                }
            } catch(e) { console.error('[Network] Error handling batteryStationState:', e); }
        });
        
        this.socket.on('batteryState', (data) => {
            try {
                // Initialize batteries array if needed
                if (!window._batteries) window._batteries = [];
                
                // Find or create battery
                let battery = window._batteries.find(b => b.id === data.id);
                if (!battery && window.Battery) {
                    battery = new window.Battery(data.x, data.y, data.id);
                    window._batteries.push(battery);
                    console.log('[Network] Created Battery', data.id, 'at', data.x, data.y);
                }
                
                if (battery) {
                    battery.x = data.x;
                    battery.y = data.y;
                    battery.carriedBy = data.carriedBy;
                    battery.slotIndex = data.slotIndex;
                    battery.onGround = data.onGround;
                }
            } catch(e) { console.error('[Network] Error handling batteryState:', e); }
        });
        
        this.socket.on('batteryPickedUp', (data) => {
            try {
                if (!window._batteries) return;
                const battery = window._batteries.find(b => b.id === data.batteryId);
                if (battery) {
                    battery.carriedBy = data.playerId;
                    battery.onGround = false;
                    console.log('[Network] Battery', data.batteryId, 'picked up by', data.playerId);
                }
            } catch(e) { console.error('[Network] Error handling batteryPickedUp:', e); }
        });
        
        this.socket.on('batteryDropped', (data) => {
            try {
                if (!window._batteries) return;
                const battery = window._batteries.find(b => b.id === data.batteryId);
                if (battery) {
                    battery.carriedBy = null;
                    battery.x = data.x;
                    battery.y = data.y;
                    battery.onGround = true;
                    console.log('[Network] Battery', data.batteryId, 'dropped at', data.x, data.y);
                }
            } catch(e) { console.error('[Network] Error handling batteryDropped:', e); }
        });
        
        this.socket.on('batteryPlaced', (data) => {
            try {
                if (!window._batteries) return;
                const battery = window._batteries.find(b => b.id === data.batteryId);
                if (battery) {
                    battery.carriedBy = null;
                    battery.slotIndex = data.slotIndex;
                    battery.onGround = false;
                    console.log('[Network] Battery', data.batteryId, 'placed in slot', data.slotIndex);
                }
                
                // Update station slot state
                if (window._batteryStation) {
                    window._batteryStation.slots[data.slotIndex] = true;
                    window._batteryStation.isPowered = data.isPowered;
                }
                
                // Update RadioTower power state
                if (data.isPowered && window._decorations) {
                    for (const dec of window._decorations) {
                        if (dec && dec.constructor && dec.constructor.name === 'RadioTower') {
                            dec.isPowered = true;
                        }
                    }
                }
            } catch(e) { console.error('[Network] Error handling batteryPlaced:', e); }
        });
        
        this.socket.on('batteryStationPowered', (data) => {
            try {
                console.log('[Network] Battery station is now POWERED!');
                if (window._batteryStation) {
                    window._batteryStation.isPowered = true;
                }
                // Update RadioTower
                if (window._decorations) {
                    for (const dec of window._decorations) {
                        if (dec && dec.constructor && dec.constructor.name === 'RadioTower') {
                            dec.isPowered = true;
                        }
                    }
                }
                
                // Show notification using existing UI system
                if (window.ui && data && data.bonusSeconds) {
                    const mins = Math.floor(data.bonusSeconds / 60);
                    const secs = Math.floor(data.bonusSeconds % 60);
                    const timeStr = secs > 0 ? `${mins}:${secs.toString().padStart(2, '0')}` : `${mins}:00`;
                    const message = data.wasOvertime 
                        ? `Radio Tower Online! +${timeStr} Reprieve`
                        : `Radio Tower Online! +${timeStr} Artillery Delay`;
                    window.ui.showNotification(message, 4000);
                }
            } catch(e) { console.error('[Network] Error handling batteryStationPowered:', e); }
        });
        
        // Chest health update
        this.socket.on('chestHealthUpdate', (data) => {
            try {
                const list = (typeof window.getChests === 'function') ? window.getChests() : [];
                for (let i = 0; i < list.length; i++) {
                    const chest = list[i];
                    const id = chest._id || (chest._id = `${Math.round(chest.x)},${Math.round(chest.y)}`);
                    if (id === data.chestId) {
                        chest.health = data.health;
                        chest.healthMax = data.healthMax;
                        // console.log(`[Network] Chest health updated: ${data.health}/${data.healthMax}`);
                        break;
                    }
                }
            } catch(e) {
                console.error('[Network] chestHealthUpdate error:', e);
            }
        });
        
        // Artifact health update
        this.socket.on('artifactHealthUpdate', (data) => {
            try {
                const list = (typeof window.getChests === 'function') ? window.getChests() : [];
                for (let i = 0; i < list.length; i++) {
                    const chest = list[i];
                    const id = chest._id || (chest._id = `${Math.round(chest.x)},${Math.round(chest.y)}`);
                    if (id === data.chestId && chest.artifact) {
                        chest.artifact.health = data.health;
                        chest.artifact.healthMax = data.healthMax;
                        console.log(`[Network] Artifact health updated: ${data.health}/${data.healthMax}`);
                        break;
                    }
                }
            } catch(e) {
                console.error('[Network] artifactHealthUpdate error:', e);
            }
        });
        
        // Artifact destruction (no longer removes artifact - just a notification for reduced VP)
        this.socket.on('artifactDestroyed', (data) => {
            try {
                const list = (typeof window.getChests === 'function') ? window.getChests() : [];
                for (let i = 0; i < list.length; i++) {
                    const chest = list[i];
                    const id = chest._id || (chest._id = `${Math.round(chest.x)},${Math.round(chest.y)}`);
                    if (id === data.chestId) {
                        // Don't remove artifact - just leave it at 0 health so it can still be extracted for reduced VP
                        if (chest.artifact) {
                            chest.artifact.health = 0;
                        }
                        console.log('[Network] Artifact destroyed (0 health) - can still be extracted for reduced VP');
                        break;
                    }
                }
            } catch(e) {
                console.error('[Network] artifactDestroyed error:', e);
            }
        });
        
        // Mission failed (gold chest or artifact destroyed)
        this.socket.on('missionFailed', (data) => {
            try {
                console.log('[Network] Mission failed:', data.reason);
                if (window.state && !window.state.extractionEnd) {
                    window.state.extractionEnd = {
                        type: 'lose',
                        reason: data.reason || 'The Artifact was Destroyed'
                    };
                    // Freeze gameplay so no further damage/targeting occurs
                    window.state.isFrozen = true;
                }
            } catch(e) {
                console.error('[Network] missionFailed error:', e);
            }
        });
        
        // Mission success with accomplishment breakdown and Victory Points
        this.socket.on('missionSuccess', (data) => {
            try {
                console.log('[Network] Mission success:', data);
                if (window.state) {
                    const hasHereticPriestObjective = Object.prototype.hasOwnProperty.call(data, 'hereticPriestKilled');
                    // Store accomplishment data for rendering
                    window.state.missionAccomplishments = {
                        artilleryWitchKilled: data.artilleryWitchKilled || false,
                        prisonerMissionSuccess: data.prisonerMissionSuccess || false,
                        // Some modes (e.g. Trench Raid) do not include this objective.
                        hasHereticPriestObjective: hasHereticPriestObjective,
                        ...(hasHereticPriestObjective ? { hereticPriestKilled: !!data.hereticPriestKilled } : {}),
                        radioTowerPowered: data.radioTowerPowered || false,
                        extractedBeforeArtillery: data.extractedBeforeArtillery || false,
                        artifactHealthPercent: data.artifactHealthPercent || 100,
                        artifactVP: data.artifactVP || 0,
                        totalVP: data.totalVP || 0
                    };
                    
                    // Check if local player successfully extracted
                    const localPlayerId = this.socket?.id;
                    const didExtract = data.extractingPlayers && data.extractingPlayers.includes(localPlayerId);
                    
                    if (didExtract) {
                        // Local player extracted successfully - show win screen
                        window.state.extractionEnd = {
                            type: 'win',
                            reason: null
                        };
                    } else {
                        // Local player failed to extract
                        window.state.extractionEnd = {
                            type: 'lose',
                            reason: 'You were left behind'
                        };
                    }
                    
                    // Freeze gameplay so no further damage/targeting occurs
                    window.state.isFrozen = true;
                }
            } catch(e) {
                console.error('[Network] missionSuccess error:', e);
            }
        });
        
        // Chest hit flash (server-authoritative damage feedback)
        this.socket.on('chestHitFlash', (data) => {
            try {
                const list = (typeof window.getChests === 'function') ? window.getChests() : [];
                for (let i = 0; i < list.length; i++) {
                    const chest = list[i];
                    const id = chest._id || (chest._id = `${Math.round(chest.x)},${Math.round(chest.y)}`);
                    if (id === data.chestId) {
                        // Trigger hit flash (same as player)
                        const canFlash = (!chest.hitFlash || chest.hitFlash <= 0) && 
                                       (!chest.hitFlashCooldown || chest.hitFlashCooldown <= 0);
                        if (canFlash) {
                            chest.hitFlash = chest.hitFlashMax || 0.12;
                            chest.hitFlashCooldown = chest.hitFlashGap || 0.07;
                        }
                        break;
                    }
                }
            } catch(e) {
                console.error('[Network] chestHitFlash error:', e);
            }
        });
        
        // Artifact hit flash (server-authoritative damage feedback)
        this.socket.on('artifactHitFlash', (data) => {
            try {
                const list = (typeof window.getChests === 'function') ? window.getChests() : [];
                for (let i = 0; i < list.length; i++) {
                    const chest = list[i];
                    const id = chest._id || (chest._id = `${Math.round(chest.x)},${Math.round(chest.y)}`);
                    if (id === data.chestId && chest.artifact) {
                        // Trigger hit flash (same as player)
                        const canFlash = (!chest.artifact.hitFlash || chest.artifact.hitFlash <= 0) && 
                                       (!chest.artifact.hitFlashCooldown || chest.artifact.hitFlashCooldown <= 0);
                        if (canFlash) {
                            chest.artifact.hitFlash = chest.artifact.hitFlashMax || 0.12;
                            chest.artifact.hitFlashCooldown = chest.artifact.hitFlashGap || 0.07;
                        }
                        break;
                    }
                }
            } catch(e) {
                console.error('[Network] artifactHitFlash error:', e);
            }
        });

        // Ground inventory item replication
        this.socket.on('inventoryDropped', (data) => {
            try {
                if (!Array.isArray(data?.items)) return;
                // Ensure bossDrops array exists
                if (!Array.isArray(window.bossDrops)) window.bossDrops = [];
                const HexStat = window.GameObjects && window.GameObjects.HexStat;
                if (!HexStat) return;
                const items = data.items;
                for (let i = 0; i < items.length; i++) {
                    const d = items[i]; if (!d) continue;
                    const rarity = { name: d.rarityName, color: d.color };
                    const h = new HexStat(d.x, d.y, d.vx, d.vy, { label: d.label, fill: rarity.color, rarity });
                    h.onGround = false;
                    // Attach server id for pickup requests
                    h._serverId = d.id;
                    window.bossDrops.push(h);
                }
            } catch(e) { console.error('[Network] Error handling inventoryDropped:', e); }
        });

        this.socket.on('inventoryPickedUp', (data) => {
            try {
                const id = data && data.id;
                if (!id || !Array.isArray(window.bossDrops)) return;
                for (let i = window.bossDrops.length - 1; i >= 0; i--) {
                    const h = window.bossDrops[i];
                    if (h && h._serverId === id) { window.bossDrops.splice(i, 1); break; }
                }
                // Safety: ensure UI caches refresh on pickups that affect inventory.
                // ClientUpdate adds the item to inventory immediately; bump version here too in case of other paths.
                try {
                    if (window.player) {
                        window.player._invVersion = (typeof window.player._invVersion === 'number') ? (window.player._invVersion + 1) : 1;
                    }
                } catch(_) {}
            } catch(e) { console.error('[Network] Error handling inventoryPickedUp:', e); }
        });

        // Boss loot drop replication (server-authoritative)
        this.socket.on('bossLootDropped', (data) => {
            try {
                if (!Array.isArray(data?.groundItems)) return;
                const HexStat = window.GameObjects && window.GameObjects.HexStat;
                if (!HexStat) return;
                if (!Array.isArray(window.bossDrops)) window.bossDrops = [];
                
                for (let i = 0; i < data.groundItems.length; i++) {
                    const item = data.groundItems[i];
                    const rarity = { name: item.rarityName, color: item.color };
                    const hexStat = new HexStat(item.x, item.y, item.vx, item.vy, { 
                        label: item.label, 
                        fill: rarity.color, 
                        rarity: rarity 
                    });
                    hexStat.onGround = false;
                    // Attach server ID for synchronized pickup
                    hexStat._serverId = item.id;
                    window.bossDrops.push(hexStat);
                }
                console.log(`[Network] Added ${data.groundItems.length} boss loot items with server IDs from enemy ${data.enemyId}`);
            } catch(e) { 
                console.error('[Network] Error handling bossLootDropped:', e); 
            }
        });

        // Enemy currency drops (server-authoritative)
        this.socket.on('enemyDrops', (data) => {
            try {
                if (!Array.isArray(data?.groundItems)) return;
                const Ducat = window.Ducat;
                const BloodMarker = window.BloodMarker;
                if (!Ducat || !BloodMarker) return;
                if (!Array.isArray(window.ducatPickups)) window.ducatPickups = [];
                if (!Array.isArray(window.bloodMarkerPickups)) window.bloodMarkerPickups = [];
                
                for (let i = 0; i < data.groundItems.length; i++) {
                    const item = data.groundItems[i];
                    
                    if (item.type === 'ducat') {
                        const ducat = new Ducat(item.x, item.y, item.amount || 1);
                        ducat._serverId = item.id;
                        window.ducatPickups.push(ducat);
                    } else if (item.type === 'bloodMarker') {
                        const marker = new BloodMarker(item.x, item.y, item.amount || 1);
                        marker._serverId = item.id;
                        window.bloodMarkerPickups.push(marker);
                    }
                }
                // console.log(`[Network] Added ${data.groundItems.length} currency items from enemy ${data.enemyId}`);
            } catch(e) { console.error('[Network] Error handling enemyDrops:', e); }
        });

        // Currency pickup replication (server-authoritative)
        this.socket.on('currencyPickedUp', (data) => {
            try {
                if (!data) return;
                const id = data.id;
                
                // Remove from local pickups array
                if (data.type === 'ducat' && Array.isArray(window.ducatPickups)) {
                    for (let i = window.ducatPickups.length - 1; i >= 0; i--) {
                        const d = window.ducatPickups[i];
                        if (d && d._serverId === id) {
                            window.ducatPickups.splice(i, 1);
                            break;
                        }
                    }
                    
                    // Update count for the player who picked it up
                    if (data.playerId === this.playerId && window.player) {
                        window.player.ducats = data.newTotal || 0;
                    }
                } else if (data.type === 'bloodMarker' && Array.isArray(window.bloodMarkerPickups)) {
                    for (let i = window.bloodMarkerPickups.length - 1; i >= 0; i--) {
                        const m = window.bloodMarkerPickups[i];
                        if (m && m._serverId === id) {
                            window.bloodMarkerPickups.splice(i, 1);
                            break;
                        }
                    }
                    
                    // Update count for the player who picked it up
                    if (data.playerId === this.playerId && window.player) {
                        window.player.bloodMarkers = data.newTotal || 0;
                    }
                }
            } catch(e) { console.error('[Network] Error handling currencyPickedUp:', e); }
        });

        // Wallet updates (e.g., spending ducats)
        this.socket.on('currencyUpdated', (data) => {
            try {
                if (!data) return;
                if (data.playerId === this.playerId && window.player) {
                    if (typeof data.ducats === 'number') window.player.ducats = data.ducats;
                    if (typeof data.bloodMarkers === 'number') window.player.bloodMarkers = data.bloodMarkers;
                }
            } catch(e) { console.error('[Network] currencyUpdated error:', e); }
        });

        // Potion lifecycle events for client UI cooldown/progress
        this.socket.on('potionStarted', (data) => {
            try {
                if (!window.state) return;
                const now = Date.now();
                const dur = Math.max(0, Number(data?.durationMs) || 0);
                const endAt = Number(data?.endAt) || (now + dur);
                window._potionActive = true;
                window._potionEndAt = endAt;
                window._potionDuration = dur;
            } catch(e) { console.error('[Network] potionStarted error:', e); }
        });
        this.socket.on('potionEnded', () => {
            try {
                window._potionActive = false;
                window._potionEndAt = null;
                window._potionDuration = 0;
            } catch(e) { console.error('[Network] potionEnded error:', e); }
        });

        // Death/respawn notifications
        this.socket.on('playerDeath', (data) => {
            try {
                console.log(`[Network] Player death broadcast: ${data?.name || data?.id} at (${Number(data?.x).toFixed(1)}, ${Number(data?.y).toFixed(1)})`);
            } catch(e) { console.error('[Network] Error handling playerDeath:', e); }
        });
        this.socket.on('playerRespawn', (data) => {
            try {
                console.log(`[Network] Player respawn broadcast: ${data?.name || data?.id} at (${Number(data?.x).toFixed(1)}, ${Number(data?.y).toFixed(1)})`);
            } catch(e) { console.error('[Network] Error handling playerRespawn:', e); }
        });
        
        this.socket.on('invincibilitySync', (data) => {
            console.log('[Network] Received invincibility sync:', data);
            
            // Invincibility is per-player, so we don't need to sync other players' states
            // The server handles invincibility checks authoritatively for each player
            // This event is kept for potential future use (e.g., visual indicators)
            console.log('[Network] Player', data.fromPlayer, 'invincibility:', data.invincible ? 'ON' : 'OFF');
        });
        
        // Bullet synchronization events
        this.socket.on('bulletFired', (data) => {
            try {
                console.log('[Network] Received bullet from player:', data.playerId, data);
                try {
                    if (window.DEBUG_WEAPON9_SYNC && data && data.bulletData && data.bulletData.sourceWeaponIndex === 8) {
                        console.log('[Weapon9][Recv] bulletFired:', {
                            from: data.playerId,
                            x: data.bulletData.x,
                            y: data.bulletData.y,
                            vx: data.bulletData.vx,
                            vy: data.bulletData.vy,
                            life: data.bulletData.life
                        });
                    }
                } catch(_) {}
                
                // Ignore self-broadcasts to prevent duplicate local bullets
                if (data.playerId === this.playerId) {
                    return;
                }
                
                // Create bullet on client from networked data
                if (window.projectiles && data.bulletData) {
                    const bd = data.bulletData;
                    const bullet = new window.Bullet(
                        bd.x, bd.y, bd.vx, bd.vy, bd.radius, bd.color, 
                        bd.life, bd.angle, true, bd.options // Force noDamage=true for networked bullets
                    );
                    // Apply deterministic properties
                    bullet.bias = bd.bias;
                    bullet.targetX = bd.targetX;
                    bullet.targetY = bd.targetY;
                    bullet.sourceWeaponIndex = bd.sourceWeaponIndex;
                    bullet.ownerPlayerId = data.playerId || null;
                    
                    // Shotgun pellet damage falloff support
                    if (bd.options && bd.options.isShotgunPellet) {
                        bullet.isShotgunPellet = true;
                        bullet.spawnX = bd.x;
                        bullet.spawnY = bd.y;
                    }
                    const netMgr = window.networkManager || null;
                    const localPlayerId = netMgr ? netMgr.playerId : null;
                    bullet._fromRemotePlayer = !!(bullet.ownerPlayerId && (!localPlayerId || bullet.ownerPlayerId !== localPlayerId));
                    if (bullet._fromRemotePlayer) {
                        const opts = bd.options || {};
                        const coneFlag = !!opts.isCone;
                        const canDamagePlayers = (typeof bd.noDamage === 'boolean') ? !bd.noDamage : true;
                        bullet._canDamagePlayers = coneFlag || canDamagePlayers;
                        bullet._originalNoDamage = (typeof bd.noDamage === 'boolean') ? bd.noDamage : undefined;
                        bullet.owner = null;
                    } else if (typeof bd.noDamage === 'boolean') {
                        bullet._originalNoDamage = bd.noDamage;
                    }

                    window.projectiles.items.push(bullet);
                }
            } catch (e) {
                console.error('[Network] Error handling bulletFired:', e);
            }
        });
        
        // Weapon 7 hitscan hit event (instant damage from server)
        this.socket.on('weapon7HitscanHit', (data) => {
            try {
                // Apply instant damage to enemy/NPC
                if (data.targetType === 'enemy') {
                    if (window.enemies && window.enemies.items) {
                        // Check both client ID and server ID to handle both client and server-spawned enemies
                        const enemy = window.enemies.items.find(e => 
                            (e.id === data.targetId || e._serverId === data.targetId) && e.alive
                        );
                        if (enemy) {
                            const oldHealth = enemy.health;
                            const newHealth = Math.max(0, enemy.health - data.damage);
                            enemy.health = newHealth;
                            if (enemy.health <= 0) {
                                enemy.alive = false;
                                // Trigger death handler if exists
                                if (typeof enemy.onDeath === 'function') {
                                    enemy.onDeath({ source: 'weapon7_hitscan', shooterId: data.shooterId });
                                }
                                // IMPORTANT: In multiplayer, server will emit `entity_dead`/`enemy_dead` for decals.
                                // Only spawn locally for non-server-controlled enemies.
                                const serverControlled = !!enemy._serverId || enemy.serverSpawned || enemy.serverSync;
                                if (!serverControlled && enemy.type !== 'boomer' && typeof window.enqueueGroundDecal === 'function' && window.BloodPoolDecal) {
                                    window.enqueueGroundDecal(new window.BloodPoolDecal(enemy.x, enemy.y, enemy.radius || 26));
                                }
                                
                                // Notify server that enemy died (so it stops its AI immediately)
                                if (enemy.serverSpawned && enemy._serverId && this.socket) {
                                    this.socket.emit('enemyDied', { id: enemy._serverId });
                                }
                            }
                            
                            // Spawn impact VFX at enemy hit location
                            if (window.projectiles && window.ImpactVfx && window.player) {
                                // Use source position from hitscan data, not current player position
                                // This ensures VFX direction is correct even if player moved/rotated after shooting
                                const dx = enemy.x - (data.sourceX || window.player.x);
                                const dy = enemy.y - (data.sourceY || window.player.y);
                                const angle = Math.atan2(dy, dx);
                                const dirX = Math.cos(angle);
                                const dirY = Math.sin(angle);
                                
                                const impact = new window.ImpactVfx(
                                    enemy.x,
                                    enemy.y,
                                    '#ffd36b', // weapon 7 color (golden)
                                    dirX,
                                    dirY,
                                    { size: 1.2 }
                                );
                                window.projectiles.impacts.push(impact);
                            }
                            
                            // Terminate tracer bullet at enemy position (Option 2)
                            if (window.projectiles && window.projectiles.items && data.bulletId) {
                                const tracer = window.projectiles.items.find(b => b.weapon7HitscanId === data.bulletId);
                                if (tracer && tracer.alive) {
                                    // Terminate immediately - the server already confirmed the hit
                                    tracer.life = 0;
                                    tracer.alive = false;
                                    // Position at enemy for impact VFX
                                    tracer.x = enemy.x;
                                    tracer.y = enemy.y;
                                }
                            }
                            
                            // Show damage number
                            if (typeof window.enqueueDamageText === 'function') {
                                window.enqueueDamageText({
                                    x: enemy.x,
                                    y: enemy.y,
                                    text: Math.round(data.damage).toString(),
                                    crit: data.crit || false,
                                    color: data.crit ? '#ffff00' : '#ff6b6b',
                                    vy: -60,
                                    life: 0.6
                                });
                            }
                        }
                    }
                } else if (data.targetType === 'npc') {
                    if (window.npcs && window.npcs.items) {
                        const npc = window.npcs.items.find(n => n.id === data.targetId && n.alive);
                        if (npc) {
                            npc.health = Math.max(0, npc.health - data.damage);
                            if (npc.health <= 0) {
                                npc.alive = false;
                            }
                            
                            // Spawn impact VFX at NPC hit location
                            if (window.projectiles && window.ImpactVfx && window.player) {
                                // Use source position from hitscan data, not current player position
                                // This ensures VFX direction is correct even if player moved/rotated after shooting
                                const dx = npc.x - (data.sourceX || window.player.x);
                                const dy = npc.y - (data.sourceY || window.player.y);
                                const angle = Math.atan2(dy, dx);
                                const dirX = Math.cos(angle);
                                const dirY = Math.sin(angle);
                                
                                const impact = new window.ImpactVfx(
                                    npc.x,
                                    npc.y,
                                    '#ffd36b', // weapon 7 color (golden)
                                    dirX,
                                    dirY,
                                    { size: 1.2 }
                                );
                                window.projectiles.impacts.push(impact);
                            }
                            
                            // Terminate tracer bullet at NPC position
                            if (window.projectiles && window.projectiles.items && data.bulletId) {
                                const tracer = window.projectiles.items.find(b => b.weapon7HitscanId === data.bulletId);
                                if (tracer && tracer.alive) {
                                    // Terminate immediately - the server already confirmed the hit
                                    tracer.life = 0;
                                    tracer.alive = false;
                                    // Position at NPC for impact VFX
                                    tracer.x = npc.x;
                                    tracer.y = npc.y;
                                }
                            }
                            
                            // Show damage number
                            if (typeof window.enqueueDamageText === 'function') {
                                window.enqueueDamageText({
                                    x: npc.x,
                                    y: npc.y,
                                    text: Math.round(data.damage).toString(),
                                    crit: data.crit || false,
                                    color: data.crit ? '#ffff00' : '#ff6b6b',
                                    vy: -60,
                                    life: 0.6
                                });
                            }
                        }
                    }
                }
            } catch (e) {
                console.error('[Network] Error handling weapon7HitscanHit:', e);
            }
        });

        // Weapon 8 hitscan hit event (ADS/Recoil weapon)
        this.socket.on('weapon8HitscanHit', (data) => {
            try {
                // Apply instant damage to enemy/NPC
                if (data.targetType === 'enemy') {
                    if (window.enemies && window.enemies.items) {
                        const enemy = window.enemies.items.find(e => 
                            (e.id === data.targetId || e._serverId === data.targetId) && e.alive
                        );
                        if (enemy) {
                            enemy.health = Math.max(0, enemy.health - data.damage);
                            if (enemy.health <= 0) {
                                enemy.alive = false;
                                if (typeof enemy.onDeath === 'function') {
                                    enemy.onDeath({ source: 'weapon8_hitscan', shooterId: data.shooterId });
                                }
                                // IMPORTANT: In multiplayer, server will emit `entity_dead`/`enemy_dead` for decals.
                                // Only spawn locally for non-server-controlled enemies.
                                const serverControlled = !!enemy._serverId || enemy.serverSpawned || enemy.serverSync;
                                if (!serverControlled && enemy.type !== 'boomer' && typeof window.enqueueGroundDecal === 'function' && window.BloodPoolDecal) {
                                    window.enqueueGroundDecal(new window.BloodPoolDecal(enemy.x, enemy.y, enemy.radius || 26));
                                }
                                if (enemy.serverSpawned && enemy._serverId && this.socket) {
                                    this.socket.emit('enemyDied', { id: enemy._serverId });
                                }
                            }
                            
                            // Impact VFX (orange, scales with loot level)
                            if (window.projectiles && window.ImpactVfx && window.player) {
                                const dx = enemy.x - (data.sourceX || window.player.x);
                                const dy = enemy.y - (data.sourceY || window.player.y);
                                const angle = Math.atan2(dy, dx);
                                const dirX = Math.cos(angle);
                                const dirY = Math.sin(angle);
                                
                                // Scale impact size with loot level: 0.8 (thin) -> 1.2 (medium) -> 1.8 (thick)
                                const lootLevel = window.player?.getEffectiveLootLevel?.() || 0;
                                let impactSize = 0.8; // Loot 0-1: small
                                if (lootLevel >= 4) {
                                    impactSize = 1.8; // Loot 4-6: large
                                } else if (lootLevel >= 2) {
                                    impactSize = 1.2; // Loot 2-3: medium
                                }
                                
                                const impact = new window.ImpactVfx(
                                    enemy.x,
                                    enemy.y,
                                    '#ff8844', // Orange color (weapon 8 ADS)
                                    dirX,
                                    dirY,
                                    { size: impactSize }
                                );
                                window.projectiles.impacts.push(impact);
                            }
                            
                            // Damage Text
                            if (typeof window.enqueueDamageText === 'function') {
                                window.enqueueDamageText({
                                    x: enemy.x,
                                    y: enemy.y,
                                    text: Math.round(data.damage).toString(),
                                    crit: data.crit || false,
                                    color: data.crit ? '#ffff00' : '#ff6b6b',
                                    vy: -60,
                                    life: 0.6
                                });
                            }
                        }
                    }
                } else if (data.targetType === 'npc') {
                    if (window.npcs && window.npcs.items) {
                        const npc = window.npcs.items.find(n => n.id === data.targetId && n.alive);
                        if (npc) {
                            npc.health = Math.max(0, npc.health - data.damage);
                            if (npc.health <= 0) npc.alive = false;
                            
                            // Impact VFX (orange, scales with loot level)
                            if (window.projectiles && window.ImpactVfx && window.player) {
                                const dx = npc.x - (data.sourceX || window.player.x);
                                const dy = npc.y - (data.sourceY || window.player.y);
                                const angle = Math.atan2(dy, dx);
                                const dirX = Math.cos(angle);
                                const dirY = Math.sin(angle);
                                
                                // Scale impact size with loot level: 0.8 (thin) -> 1.2 (medium) -> 1.8 (thick)
                                const lootLevel = window.player?.getEffectiveLootLevel?.() || 0;
                                let impactSize = 0.8; // Loot 0-1: small
                                if (lootLevel >= 4) {
                                    impactSize = 1.8; // Loot 4-6: large
                                } else if (lootLevel >= 2) {
                                    impactSize = 1.2; // Loot 2-3: medium
                                }
                                
                                const impact = new window.ImpactVfx(
                                    npc.x,
                                    npc.y,
                                    '#ff8844', // Orange color (weapon 8 ADS)
                                    dirX,
                                    dirY,
                                    { size: impactSize }
                                );
                                window.projectiles.impacts.push(impact);
                            }
                            
                            if (typeof window.enqueueDamageText === 'function') {
                                window.enqueueDamageText({
                                    x: npc.x,
                                    y: npc.y,
                                    text: Math.round(data.damage).toString(),
                                    crit: data.crit || false,
                                    color: data.crit ? '#ffff00' : '#ff6b6b',
                                    vy: -60,
                                    life: 0.6
                                });
                            }
                        }
                    }
                }
            } catch (e) {
                console.error('[Network] Error handling weapon8HitscanHit:', e);
            }
        });
        
        // VFX synchronization events (server emits both 'vfxEvent' and 'vfxCreated')
        const handleVfxEvent = (data) => {
            try {
                console.log('[Network] Received VFX event:', data.type, 'playerId:', data.playerId);
                
                // Create VFX on client from networked data
                if (data.type === 'impact' && window.ImpactVfx && window.projectiles) {
                    const vfx = new window.ImpactVfx(data.x, data.y, data.color, data.dirX, data.dirY, data.options);
                    window.projectiles.impacts.push(vfx);
                } else if (data.type === 'explosion' && window.ExplosionVfx && window.projectiles) {
                    const vfx = new window.ExplosionVfx(data.x, data.y, data.color, data.options);
                    window.projectiles.impacts.push(vfx);
                } else if (data.type === 'damageText' && typeof window.enqueueDamageText === 'function') {
                    // Create DOT damage text from network data
                    window.enqueueDamageText({
                        x: data.x,
                        y: data.y,
                        text: data.text,
                        crit: data.crit || false,
                        color: data.color || '#ff9f2b',
                        vy: data.vy || -60,
                        life: data.life || 0.6
                    });
                } else if (data.type === 'burnStateChanged') {
                    // Track burning state of remote players and entities for flame VFX
                    if (!this.remoteBurningPlayers) this.remoteBurningPlayers = new Map();
                    if (!this.remoteBurningEntities) this.remoteBurningEntities = new Map();
                    
                    if (data.entityType === 'enemy') {
                        // Handle enemy burning state (for remote DOT flame VFX)
                        if (data.burning) {
                            const now = Date.now();
                            const durMs = Number(data.durationMs) || 0;
                            this.remoteBurningEntities.set(data.entityId, {
                                startTime: now,
                                endAt: durMs > 0 ? (now + durMs) : null,
                                x: data.x,
                                y: data.y,
                                entityType: data.entityType
                            });
                        } else {
                            this.remoteBurningEntities.delete(data.entityId);
                        }
                    } else if (data.entityType === 'troop') {
                        // Handle troop burning state (for fire VFX on troops)
                        const troop = window._troopByServerId ? window._troopByServerId.get(data.troopId) : null;
                        if (troop) {
                            if (data.burning) {
                                // Ensure dotStacks array exists and add a visual stack
                                if (!troop.dotStacks) troop.dotStacks = [];
                                if (troop.dotStacks.length === 0) {
                                    troop.dotStacks.push({ visualOnly: true });
                                }
                                try { if (window.GameConstants?.ENABLE_DEBUG_LOGS) console.log('🔥 [Network] Troop burning:', data.troopId); } catch(_) {}
                            } else {
                                // Clear dotStacks when no longer burning
                                if (troop.dotStacks) troop.dotStacks = [];
                                try { if (window.GameConstants?.ENABLE_DEBUG_LOGS) console.log('🔥 [Network] Troop stopped burning:', data.troopId); } catch(_) {}
                            }
                        }
                    } else {
                        // Handle player burning state (same system for local and remote players)
                        if (data.burning) {
                            // Add to remoteBurningPlayers for BOTH local and remote players
                            // Local player now uses same system as remote players
                            this.remoteBurningPlayers.set(data.playerId, {
                                startTime: Date.now(),
                                x: data.x,
                                y: data.y
                            });
                            try { if (window.GameConstants?.ENABLE_DEBUG_LOGS) console.log('🔥 [Network] Player burning:', data.playerId.substring(0,8), 'Total burning:', this.remoteBurningPlayers.size); } catch(_) {}
                        } else {
                            // Remove from remoteBurningPlayers for BOTH local and remote players
                            this.remoteBurningPlayers.delete(data.playerId);
                            try { if (window.GameConstants?.ENABLE_DEBUG_LOGS) console.log('🔥 [Network] Player stopped burning:', data.playerId.substring(0,8), 'Total burning:', this.remoteBurningPlayers.size); } catch(_) {}
                        }
                    }
                } else if (data.type === 'slowStateChanged') {
                    // Track slowed state of remote players for slime VFX
                    if (!this.remoteSlowedPlayers) this.remoteSlowedPlayers = new Map();
                    const pid = data.playerId;
                    if (pid) {
                        if (data.slowed) {
                            this.remoteSlowedPlayers.set(pid, { startTime: Date.now() });
                        } else {
                            this.remoteSlowedPlayers.delete(pid);
                        }
                    }
                } else if (data.type === 'chargeStart') {
                    // Track charge state of remote players for weapon 3 charge VFX
                    if (!this.remoteChargingPlayers) this.remoteChargingPlayers = new Map();
                    const pid = data.playerId;
                    if (pid && pid !== this.playerId) {
                        console.log('[Network] Charge started for player:', pid);
                        this.remoteChargingPlayers.set(pid, {
                            startTime: Date.now(),
                            lastUpdate: Date.now(),
                            x: data.x,
                            y: data.y,
                            color: data.color || '#76b0ff',
                            progress: 0,
                            aimAngle: 0
                        });
                    }
                } else if (data.type === 'chargeUpdate') {
                    // Update charge progress for remote players (create entry if missing)
                    if (!this.remoteChargingPlayers) this.remoteChargingPlayers = new Map();
                    const pid = data.playerId;
                    if (pid && pid !== this.playerId) {
                        let chargeData = this.remoteChargingPlayers.get(pid);
                        if (!chargeData) {
                            // Create entry if chargeStart was missed
                            console.log('[Network] Creating charge entry from update for player:', pid);
                            chargeData = {
                                startTime: Date.now(),
                                lastUpdate: Date.now(),
                                x: data.x,
                                y: data.y,
                                color: data.color || '#76b0ff',
                                progress: 0,
                                aimAngle: 0
                            };
                            this.remoteChargingPlayers.set(pid, chargeData);
                        }
                        // Update data
                        chargeData.x = data.x;
                        chargeData.y = data.y;
                        chargeData.progress = data.progress || 0;
                        chargeData.aimAngle = data.aimAngle || 0;
                        chargeData.lastUpdate = Date.now();
                        // Update color if provided (in case weapon switched)
                        if (data.color) chargeData.color = data.color;
                    }
                } else if (data.type === 'chargeEnd') {
                    // Remove charge state when charging ends
                    if (!this.remoteChargingPlayers) this.remoteChargingPlayers = new Map();
                    const pid = data.playerId;
                    if (pid) {
                        console.log('[Network] Charge ended for player:', pid);
                        this.remoteChargingPlayers.delete(pid);
                    }
                } else if (data.type === 'slash' && window.SlashVfx && window.projectiles) {
                    const vfx = new window.SlashVfx(data.x, data.y, data.angle, data.color);
                    window.projectiles.impacts.push(vfx);
                } else if (data.type === 'damageText' && window.enemies) {
                    // Create damage text VFX
                    const damageText = {
                        x: data.x,
                        y: data.y,
                        damage: data.damage,
                        color: data.color || '#ff4444',
                        life: 1.0,
                        vx: data.vx || 0,
                        vy: data.vy || -60
                    };
                    window.enemies._damageTexts.push(damageText);
                }
            } catch (e) {
                console.error('[Network] Error handling VFX event:', e);
            }
        };
        
        // Listen to both event names (server may emit either)
        this.socket.on('vfxEvent', handleVfxEvent);
        this.socket.on('vfxCreated', handleVfxEvent);

        // Ability synchronization
        this.socket.on('abilityRejected', (data) => {
            try {
                if (!data) return;
                console.log('[Network] Ability rejected by server:', data.type, 'reason:', data.reason);
                
                // Show feedback to player
                if (window.abilityManager) {
                    if (data.reason === 'insufficient_blood') {
                        window.abilityManager.showFeedback('Out of Blood Markers', '#ff4444');
                    } else if (data.reason === 'max_walls_reached') {
                        window.abilityManager.showFeedback('Max Walls Reached', '#ff4444');
                    } else if (data.reason === 'max_turrets_reached') {
                        window.abilityManager.showFeedback('Max Turrets Reached', '#ff4444');
                    } else if (data.reason === 'max_heal_stations_reached') {
                        window.abilityManager.showFeedback('Max Heal Stations Reached', '#ff4444');
                    } else if (data.reason === 'max_attractors_reached') {
                        window.abilityManager.showFeedback('Max Attractors Reached', '#ff4444');
                    } else if (data.reason === 'ability_locked') {
                        window.abilityManager.showFeedback('Ability Not Unlocked', '#ff4444');
                    } else {
                        window.abilityManager.showFeedback('Ability Failed', '#ff4444');
                    }
                }
            } catch(e) {
                console.error('[Network] Error handling abilityRejected:', e);
            }
        });
        
        this.socket.on('abilityExpired', (data) => {
            try {
                if (!data || !data.serverId) return;
                if (!window.abilityManager) return;
                
                console.log('[Network] Ability expired on server:', data.serverId, 'explode:', data.explode);
                
                // Find and remove ability from client
                const ability = window.abilityManager.findByServerId(data.serverId);
                if (ability) {
                    // If this is a ProximityMine with explode flag, trigger explosion
                    if (data.explode && ability.constructor.name === 'ProximityMine' && typeof ability.explode === 'function') {
                        console.log('[Network] Triggering ProximityMine explosion due to lifetime expiry');
                        ability.explode();
                    } else {
                        // Call onExpire to clean up environment
                        if (typeof ability.onExpire === 'function') {
                            ability.onExpire();
                        }
                        ability.alive = false;
                        console.log('[Network] Removed expired ability from client');
                    }
                }
            } catch(e) {
                console.error('[Network] Error handling abilityExpired:', e);
            }
        });
        
        this.socket.on('abilityTriggered', (data) => {
            try {
                if (!data || !data.serverId) return;
                if (!window.abilityManager) return;
                
                console.log('[Network] Ability triggered on server:', data.type, data.serverId);
                
                // Find and remove ability from client
                const ability = window.abilityManager.findByServerId(data.serverId);
                if (ability) {
                    // For mines: explosion VFX already shown by the triggering client
                    // Just remove the mine entity for all other clients
                    if (data.type === 'explosion' && ability.constructor.name === 'ProximityMine') {
                        // If this is not the owner, show explosion VFX too
                        if (ability.owner !== window.player) {
                            console.log('[Network] Showing remote mine explosion at', data.x, data.y);
                            if (window.projectiles && window.ExplosionVfx) {
                                window.projectiles.impacts.push(new window.ExplosionVfx(
                                    data.x,
                                    data.y,
                                    '#ff6b00',
                                    { 
                                        scale: 3,
                                        shockColor: '#ff8800',
                                        sparkColor: '#ff4400'
                                    }
                                ));
                            }
                        }
                    }
                    
                    // For turrets: show explosion death VFX
                    if (data.type === 'death' && ability.constructor.name === 'AutoTurret') {
                        console.log('[Network] Showing turret explosion at', data.x, data.y);
                        if (window.projectiles && window.ExplosionVfx) {
                            window.projectiles.impacts.push(new window.ExplosionVfx(
                                data.x,
                                data.y,
                                '#4da3ff',
                                { 
                                    scale: 0.5,
                                    shockColor: '#6ba3ff',
                                    sparkColor: '#4d8fff'
                                }
                            ));
                        }
                    }
                    
                    // Mark as dead so update loop stops processing
                    ability.triggered = true;
                    ability.alive = false;
                    console.log('[Network] Removed triggered ability from client');
                }
            } catch(e) {
                console.error('[Network] Error handling abilityTriggered:', e);
            }
        });
        
        // Server-authoritative turret fire events
        this.socket.on('turretFire', (data) => {
            try {
                if (!data || !data.serverId) return;
                if (!window.abilityManager) return;
                
                // Find turret ability
                const turret = window.abilityManager.findByServerId(data.serverId);
                if (!turret || turret.constructor.name !== 'AutoTurret') return;
                
                console.log('[Network] Turret fire from', data.serverId.substring(0, 12));
                
                // Update turret angle for visual sync
                if (Number.isFinite(data.angle)) {
                    turret.angle = data.angle;
                }
                
                // Show muzzle flash on client
                if (turret.muzzleFlashes && turret.currentBarrel !== undefined) {
                    turret.muzzleFlashes.push({
                        side: turret.currentBarrel,
                        life: 0.15,
                        intensity: 1.0
                    });
                    turret.currentBarrel = 1 - turret.currentBarrel; // Alternate barrel
                }
                
                // HITSCAN MODE: All clients receive damage from server, only spawn visual tracers
                // Apply instant hitscan damage to enemy (all clients sync)
                if (data.hitscan && data.targetId) {
                    // Use _enemyByServerId map to find enemy by server ID (faster and more reliable)
                    const enemy = window._enemyByServerId?.get(data.targetId);
                    if (enemy && enemy.alive) {
                        enemy.health = Math.max(0, enemy.health - data.damage);
                        if (enemy.health <= 0) {
                            enemy.alive = false;
                            // Trigger death handler if exists
                            if (typeof enemy.onDeath === 'function') {
                                enemy.onDeath({ source: 'turret_hitscan', turretId: data.serverId });
                            }
                            // IMPORTANT: In multiplayer, server will emit `entity_dead`/`enemy_dead` for decals.
                            // Only spawn locally for non-server-controlled enemies.
                            const serverControlled = !!enemy._serverId || enemy.serverSpawned || enemy.serverSync;
                            if (!serverControlled && enemy.type !== 'boomer' && typeof window.enqueueGroundDecal === 'function' && window.BloodPoolDecal) {
                                window.enqueueGroundDecal(new window.BloodPoolDecal(enemy.x, enemy.y, enemy.radius || 26));
                            }
                            
                            // Notify server that enemy died (so it stops its AI immediately)
                            if (enemy.serverSpawned && enemy._serverId && this.socket) {
                                this.socket.emit('enemyDied', { id: enemy._serverId });
                            }
                        }
                        
                        // Show damage number
                        if (typeof window.enqueueDamageText === 'function') {
                            window.enqueueDamageText({
                                x: enemy.x,
                                y: enemy.y,
                                text: Math.round(data.damage).toString(),
                                crit: false,
                                color: '#ff6b6b',
                                vy: -60,
                                life: 0.6
                            });
                        }
                    }
                }
                
                // Create visual tracer bullet (no damage, just visuals) for all clients
                if (window.projectiles && window.projectiles.items && data.targetX && data.targetY) {
                    const barrelLength = 22; // Match turret barrel length
                    const barrelOffset = 8;
                    const perpAngle = turret.angle + Math.PI / 2;
                    const barrelSide = (turret.currentBarrel === 0) ? 1 : -1; // Match visual barrel sides
                    const offsetX = Math.cos(perpAngle) * barrelOffset * barrelSide;
                    const offsetY = Math.sin(perpAngle) * barrelOffset * barrelSide;
                    const tipX = turret.x + Math.cos(turret.angle) * barrelLength + offsetX;
                    const tipY = turret.y + Math.sin(turret.angle) * barrelLength + offsetY;
                    
                    const dirX = Math.cos(turret.angle);
                    const dirY = Math.sin(turret.angle);
                    const vx = dirX * 16000;
                    const vy = dirY * 16000;
                    
                    // Calculate travel distance like weapon 7 does
                    const minDistFromCenter = turret.targetingRadius || 210;
                    const maxDistFromCenter = minDistFromCenter + 100;
                    const spawnOffset = Math.hypot(tipX - turret.x, tipY - turret.y);
                    const desiredFromCenter = minDistFromCenter + (Math.random() * (maxDistFromCenter - minDistFromCenter));
                    const travelDist = Math.max(8, desiredFromCenter - spawnOffset);
                    
                    // CRITICAL: Set targetX/targetY and maxTurnRate like weapon 7 does
                    const options = {
                        damage: 0, // No damage (hitscan handles damage)
                        shape: 'rect',
                        rectWidth: 36,
                        rectHeight: 2,
                        impactScale: 1.4,
                        targetX: tipX + dirX * travelDist, // Fly straight to this point
                        targetY: tipY + dirY * travelDist, // Fly straight to this point
                        maxTurnRate: 0, // No turning - straight line
                        travelDistance: travelDist,
                        owner: turret.owner, // Track owner for friendly fire
                        sourceWeaponIndex: 6 // Weapon 7 (turret acts like weapon 7)
                    };
                    
                    // Calculate bullet life like weapon 7 does (travelDist / speed)
                    const bulletSpeed = 16000;
                    const bulletLife = Math.min(3.6, travelDist / bulletSpeed);
                    
                    // IMPORTANT: tracer must be noDamage, otherwise client-side collision can show "0" damage popups
                    const bullet = window.bulletPool 
                        ? window.bulletPool.get(tipX, tipY, vx, vy, 6, turret.color, bulletLife, turret.angle, true, options)
                        : new Bullet(tipX, tipY, vx, vy, 6, turret.color, bulletLife, turret.angle, true, options);
                    
                    window.projectiles.items.push(bullet);
                    
                    // Hitscan damage is already applied above - no need for close-range damage checks
                }
            } catch(e) {
                console.error('[Network] Error handling turretFire:', e);
            }
        });
        
        this.socket.on('abilityCreated', (data) => {
            try {
                if (!data || !data.type) return;
                if (!window.abilityManager) return;
                
                const ownerStr = typeof data.ownerId === 'string' ? data.ownerId.substring(0,8) : data.ownerId;
                console.log('[Network] Ability created by server:', data.type, 'owner:', ownerStr, 'args:', data.args);
                
                // Find owner player
                let owner = null;
                if (data.ownerId === this.playerId) {
                    owner = window.player;
                } else if (this.otherPlayers) {
                    const ownerData = this.otherPlayers.get(data.ownerId);
                    if (ownerData) {
                        owner = ownerData;
                    }
                }
                
                // Create ability based on type using server-provided args
                if (data.type === 'ShieldWall' && window.ShieldWall) {
                    // ShieldWall constructor: (player, aimAngle, placementX, placementY, wallWidth)
                    const [aimAngle, placementX, placementY, wallWidth] = data.args || [0, 0, 0, 100];
                    
                    console.log('[ShieldWall] Creating at:', placementX, placementY, 'angle:', aimAngle, 'width:', wallWidth);
                    
                    const wall = new window.ShieldWall(
                        owner || { id: data.ownerId, x: placementX, y: placementY }, 
                        aimAngle,
                        placementX,
                        placementY,
                        wallWidth
                    );
                    wall._serverId = data.serverId;
                    window.abilityManager.abilities.push(wall);
                    
                    console.log('[ShieldWall] Network created, OBB index:', wall._envBoxIndex, 'orientedBoxes.length:', window.environment?.orientedBoxes?.length);
                } else if (data.type === 'ProximityMine' && window.ProximityMine) {
                    // ProximityMine constructor: (player, placementX, placementY, progression)
                    const [placementX, placementY, progression] = data.args || [0, 0, null];
                    
                    console.log('[ProximityMine] Creating at:', placementX, placementY, 'progression:', progression);
                    
                    const mine = new window.ProximityMine(
                        owner || { id: data.ownerId, x: placementX, y: placementY },
                        placementX,
                        placementY,
                        progression
                    );
                    mine._serverId = data.serverId;
                    window.abilityManager.abilities.push(mine);
                    
                    console.log('[ProximityMine] Network created with radius:', mine.radius, 'explosion:', mine.explosionRadius);
                } else if (data.type === 'HealingBox' && window.HealingBox) {
                    // HealingBox constructor: (player, placementX, placementY, progression)
                    const [placementX, placementY, progression] = data.args || [0, 0, null];
                    
                    console.log('[HealingBox] Creating at:', placementX, placementY, 'progression:', progression);
                    
                    const box = new window.HealingBox(
                        owner || { id: data.ownerId, x: placementX, y: placementY },
                        placementX,
                        placementY,
                        progression
                    );
                    box._serverId = data.serverId;
                    window.abilityManager.abilities.push(box);
                    
                    console.log('[HealingBox] Network created with healRadius:', box.healRadius, 'healAmount:', box.healAmount);
                } else if (data.type === 'AutoTurret' && window.AutoTurret) {
                    // AutoTurret constructor: (player, placementX, placementY, options)
                    const [placementX, placementY, options] = data.args || [0, 0, {}];
                    
                    console.log('[AutoTurret] Creating at:', placementX, placementY, 'with options:', options);
                    
                    const turret = new window.AutoTurret(
                        owner || { id: data.ownerId, x: placementX, y: placementY },
                        placementX,
                        placementY,
                        options
                    );
                    turret._serverId = data.serverId;
                    window.abilityManager.abilities.push(turret);
                    
                    console.log('[AutoTurret] Network created with health:', turret.healthMax);
                } else if (data.type === 'MolotovPool' && window.MolotovPool) {
                    // MolotovPool constructor: (owner, x, y, angle, progressionMods)
                    const [targetX, targetY, aimAngle, progressionMods] = data.args || [0, 0, 0, {}];
                    
                    const receiveTime = Date.now();
                    console.log('[Network][MolotovPool] 📨 RECEIVED creation event at timestamp:', receiveTime, 
                                'position:', targetX.toFixed(1), targetY.toFixed(1), 'angle:', aimAngle.toFixed(2),
                                'progression:', progressionMods,
                                'serverId:', data.serverId, 'ownerId:', data.ownerId, 
                                'isLocalPlayer:', (data.ownerId === this.playerId));
                    
                    console.log('[Network][MolotovPool] 🏗️ INSTANTIATING local pool object...');
                    const pool = new window.MolotovPool(
                        owner || { id: data.ownerId, x: targetX, y: targetY },
                        targetX,
                        targetY,
                        aimAngle,
                        progressionMods  // Pass progression modifiers
                    );
                    pool._serverId = data.serverId;
                    window.abilityManager.abilities.push(pool);
                    
                    const completeTime = Date.now();
                    console.log('[Network][MolotovPool] ✅ Pool CREATED and added to abilityManager', 
                                'instantiation took:', (completeTime - receiveTime), 'ms',
                                'radius:', pool.maxRadius.toFixed(1), 'dotDps:', pool.dotDps.toFixed(1),
                                'total abilities:', window.abilityManager.abilities.length);
                } else if (data.type === 'EnemyAttractor' && window.EnemyAttractor) {
                    // EnemyAttractor constructor: (player, placementX, placementY)
                    const [placementX, placementY] = data.args || [0, 0];
                    
                    // Create owner with lootLevel for proper scaling
                    const ownerWithLoot = owner || { 
                        id: data.ownerId, 
                        x: placementX, 
                        y: placementY,
                        lootLevel: data.ownerLootLevel || 0 // Use server-provided loot level
                    };
                    
                    console.log('[EnemyAttractor] Creating at:', placementX, placementY, 'lootLevel:', ownerWithLoot.lootLevel);
                    
                    const attractor = new window.EnemyAttractor(
                        ownerWithLoot,
                        placementX,
                        placementY
                    );
                    attractor._serverId = data.serverId;
                    window.abilityManager.abilities.push(attractor);
                    
                    console.log('[EnemyAttractor] Network created with attractionRadius:', attractor.attractionRadius);
                }
                
                // Additional ability types will be handled here in future phases
                
            } catch(e) {
                console.error('[Network] Error handling abilityCreated:', e);
            }
        });
        
        this.socket.on('abilityDamaged', (data) => {
            try {
                if (!data || !data.abilityId) return;
                if (!window.abilityManager) return;
                
                // Find ability and apply damage
                const abilities = window.abilityManager.abilities;
                for (let i = 0; i < abilities.length; i++) {
                    const ability = abilities[i];
                    if (ability._serverId === data.abilityId && typeof ability.takeDamage === 'function') {
                        ability.takeDamage(data.damage || 0);
                        break;
                    }
                }
            } catch(e) {
                console.error('[Network] Error handling abilityDamaged:', e);
            }
        });
        
        // Server-authoritative ability health updates (for healing boxes, etc.)
        this.socket.on('abilityHealthUpdate', (data) => {
            try {
                if (!data || !data.serverId) return;
                if (!window.abilityManager) return;
                
                // Find ability and update health
                const ability = window.abilityManager.findByServerId(data.serverId);
                if (ability) {
                    const oldHealth = ability.health;
                    if (Number.isFinite(data.health)) ability.health = data.health;
                    if (Number.isFinite(data.healthMax)) ability.healthMax = data.healthMax;
                    
                    // Trigger hit flash if health decreased (damage taken)
                    // Skip exactly 1.0 HP decreases (ammo consumption from shooting)
                    if (Number.isFinite(oldHealth) && Number.isFinite(data.health) && data.health < oldHealth) {
                        const healthLoss = oldHealth - data.health;
                        const isShootingAmmo = Math.abs(healthLoss - 1.0) < 0.01; // Shooting is exactly 1 HP
                        
                        if (!isShootingAmmo) {
                            const canFlash = (!ability.hitFlash || ability.hitFlash <= 0) && 
                                           (!ability.hitFlashCooldown || ability.hitFlashCooldown <= 0);
                            if (canFlash && typeof ability.hitFlashMax === 'number') {
                                ability.hitFlash = ability.hitFlashMax;
                                ability.hitFlashCooldown = ability.hitFlashGap || 0.07;
                            }
                        }
                    }
                }
            } catch(e) {
                console.error('[Network] Error handling abilityHealthUpdate:', e);
            }
        });
        
        // Server-authoritative player healing events (from healing boxes)
        this.socket.on('playerHealed', (data) => {
            try {
                if (!data || !data.playerId) return;
                
                console.log('[Network] Player healed:', data.playerId.substring(0, 8), 'amount:', data.amount);
                
                // Find the player who was healed
                let healedPlayer = null;
                if (data.playerId === this.playerId && window.player) {
                    healedPlayer = window.player;
                } else if (this.otherPlayers) {
                    healedPlayer = this.otherPlayers.get(data.playerId);
                }
                
                if (!healedPlayer) return;
                
                // Update player health
                if (Number.isFinite(data.newHealth)) {
                    healedPlayer.health = data.newHealth;
                }
                
                // Spawn green floating heal number above player
                if (window.enqueueDamageText && Number.isFinite(data.amount) && data.amount > 0) {
                    window.enqueueDamageText({
                        x: healedPlayer.x,
                        y: healedPlayer.y - (healedPlayer.radius || 26),
                        text: '+' + Math.round(data.amount),
                        color: '#00ff00', // Green color for healing
                        crit: false,
                        life: 1.0,
                        vy: -60
                    });
                }
                
                // Notify the healing box to queue smoke-like + VFX
                if (data.boxId && window.abilityManager) {
                    const healingBox = window.abilityManager.findByServerId(data.boxId);
                    if (healingBox && healingBox.queueHealVfx) {
                        healingBox.queueHealVfx(data.amount);
                    }
                }
            } catch(e) {
                console.error('[Network] Error handling playerHealed:', e);
            }
        });

        // Server-authoritative Boomer explosion events
        this.socket.on('boomerExploded', (data) => {
            try {
                const x = Number(data?.x) || 0;
                const y = Number(data?.y) || 0;
                // Spawn explosion VFX
                if (window.projectiles && window.ExplosionVfx) {
                    const options = { shockColor: '#cbe24a', sparkColor: '#cbe24a', flashColor: 'rgba(210,255,120,0.9)', smokeColor: 'rgba(90,110,60,1)' };
                    window.projectiles.impacts.push(new window.ExplosionVfx(x, y, '#a8c400', options));
                }
                // Spawn puke pool decal at location
                if (typeof window.enqueueGroundDecal === 'function' && window.PukePoolDecal) {
                    window.enqueueGroundDecal(new window.PukePoolDecal(x, y, 100));
                }
                // Remove any local enemy instance if tracked by server id map
                try {
                    if (window._enemyByServerId && data?.id) {
                        const inst = window._enemyByServerId.get(data.id);
                        if (inst) {
                            inst.alive = false;
                        }
                    }
                } catch(_) {}
            } catch (e) {
                console.error('[Network] Error handling boomerExploded:', e);
            }
        });

        // Server-authoritative barrel fuse start (below 50% health)
        this.socket.on('barrelFuseStart', (data) => {
            try {
                console.log('[Network] Barrel fuse started:', data?.id);
                
                // Mark barrel as fusing in local data
                if (window.hazards && window.hazards.explodingBarrels) {
                    const barrel = window.hazards.explodingBarrels.find(b => b.id === data.id);
                    if (barrel) {
                        barrel._fusing = true;
                        barrel._fuseStartTime = Date.now();
                        barrel._fuseDuration = (data.fuseDuration || 2) * 1000;
                    }
                }
            } catch (e) {
                console.error('[Network] Error handling barrelFuseStart:', e);
            }
        });

        // Server-authoritative barrel hit events (non-lethal damage VFX)
        this.socket.on('barrelHit', (data) => {
            try {
                // Update local barrel health
                if (window.hazards && window.hazards.explodingBarrels) {
                    const barrel = window.hazards.explodingBarrels.find(b => b.id === data.id);
                    if (barrel) {
                        barrel.health = data.health;
                    }
                }
                
                // Spawn hit VFX (sparks and metal impact)
                if (window.projectiles && data.x != null && data.y != null) {
                    // Metal sparks
                    for (let i = 0; i < 5; i++) {
                        const angle = Math.random() * Math.PI * 2;
                        const speed = 80 + Math.random() * 120;
                        window.projectiles.impacts.push({
                            x: data.x,
                            y: data.y,
                            vx: Math.cos(angle) * speed,
                            vy: Math.sin(angle) * speed,
                            life: 0.3 + Math.random() * 0.2,
                            total: 0.5,
                            size: 2 + Math.random() * 2,
                            color: '#ffaa44',
                            type: 'spark',
                            update(dt) {
                                this.x += this.vx * dt;
                                this.y += this.vy * dt;
                                this.vy += 400 * dt; // gravity
                                this.life -= dt;
                            },
                            draw(ctx, cam) {
                                const alpha = Math.max(0, this.life / this.total);
                                ctx.globalAlpha = alpha;
                                ctx.fillStyle = this.color;
                                ctx.beginPath();
                                ctx.arc(this.x - cam.x, this.y - cam.y, this.size, 0, Math.PI * 2);
                                ctx.fill();
                                ctx.globalAlpha = 1;
                            }
                        });
                    }
                    
                    // Metal clang impact flash
                    window.projectiles.impacts.push({
                        x: data.x,
                        y: data.y,
                        life: 0.1,
                        total: 0.1,
                        size: 15,
                        type: 'flash',
                        update(dt) { this.life -= dt; },
                        draw(ctx, cam) {
                            const alpha = Math.max(0, this.life / this.total);
                            ctx.globalAlpha = alpha * 0.7;
                            ctx.fillStyle = '#ff6633';
                            ctx.beginPath();
                            ctx.arc(this.x - cam.x, this.y - cam.y, this.size * (1 - alpha * 0.5), 0, Math.PI * 2);
                            ctx.fill();
                            ctx.globalAlpha = 1;
                        }
                    });
                }
            } catch (e) {
                console.error('[Network] Error handling barrelHit:', e);
            }
        });

        // Server-authoritative barrel explosion events
        this.socket.on('barrelExploded', (data) => {
            try {
                console.log('[Network] Barrel exploded:', data?.id, 'at', data?.x?.toFixed?.(0), data?.y?.toFixed?.(0));
                
                // Remove barrel from local hazards data
                if (window.hazards && window.hazards.explodingBarrels) {
                    const idx = window.hazards.explodingBarrels.findIndex(b => b.id === data.id);
                    if (idx >= 0) {
                        window.hazards.explodingBarrels.splice(idx, 1);
                    }
                }
                
                // Spawn explosion VFX
                if (window.projectiles && window.ExplosionVfx) {
                    const explosionRadius = data.radius || 300;
                    const vfxScale = explosionRadius / 90;
                    window.projectiles.impacts.push(new window.ExplosionVfx(
                        data.x, data.y, '#ff4400',
                        { 
                            scale: vfxScale,
                            shockColor: '#ff6600',
                            sparkColor: '#ff2200',
                            flashColor: 'rgba(255, 100, 0, 0.9)'
                        }
                    ));
                    
                    // Add blast ring visual to show damage radius
                    window.projectiles.impacts.push({
                        life: 0.3,
                        totalLife: 0.3,
                        radius: explosionRadius,
                        x: data.x,
                        y: data.y,
                        type: 'blastRing',
                        update(dt) { this.life -= dt; },
                        draw(ctx, cam) {
                            const progress = 1 - (this.life / this.totalLife);
                            const alpha = 1 - progress;
                            const currentRadius = this.radius * (0.3 + progress * 0.7);
                            
                            ctx.save();
                            ctx.globalAlpha = alpha * 0.6;
                            ctx.strokeStyle = '#ff6600';
                            ctx.lineWidth = 4 * (1 - progress);
                            ctx.beginPath();
                            ctx.arc(this.x - cam.x, this.y - cam.y, currentRadius, 0, Math.PI * 2);
                            ctx.stroke();
                            
                            // Inner glow
                            ctx.globalAlpha = alpha * 0.3;
                            ctx.fillStyle = '#ff4400';
                            ctx.beginPath();
                            ctx.arc(this.x - cam.x, this.y - cam.y, currentRadius * 0.5, 0, Math.PI * 2);
                            ctx.fill();
                            ctx.restore();
                        }
                    });
                }
                
                // Screen shake if player is close (scaled to explosion radius)
                if (window.player && data.x != null && data.y != null) {
                    const shakeRange = (data.radius || 300) * 2.5; // Shake extends beyond damage radius
                    const dist = Math.hypot(window.player.x - data.x, window.player.y - data.y);
                    if (dist < shakeRange && window.camera && window.camera.shake) {
                        const intensity = Math.max(0, 1 - dist / shakeRange);
                        window.camera.shake(15 * intensity, 0.5);
                    }
                }
                
                // Update local enemy health for hits (visual sync)
                if (data.enemyHits && window._enemyByServerId) {
                    for (const hit of data.enemyHits) {
                        const enemy = window._enemyByServerId.get(hit.id);
                        if (enemy && enemy.alive) {
                            enemy.health = Math.max(0, enemy.health - hit.damage);
                            if (enemy.health <= 0) {
                                enemy.alive = false;
                                // Remove from tracking (same pattern as enemy_dead handler)
                                try {
                                    if (window.enemies && window.enemies.items) {
                                        const idx = window.enemies.items.indexOf(enemy);
                                        if (idx >= 0) {
                                            window.enemies.items.splice(idx, 1);
                                        }
                                    }
                                    window._enemyByServerId.delete(hit.id);
                                } catch(_) {}
                            }
                        }
                    }
                }
            } catch (e) {
                console.error('[Network] Error handling barrelExploded:', e);
            }
        });

        // Unified entity death (enemies + troops). This becomes the single place to spawn death decals/VFX.
        // Server will emit `entity_dead`; legacy `enemy_dead` and `troopDeath` are routed here for compatibility.
        if (!this._entityDeathSeen) this._entityDeathSeen = new Map(); // key -> lastSeenMs
        this._handleEntityDead = (data, sourceEvent) => {
            try {
                const entityType = data?.entityType;
                const id = data?.id;
                if (!entityType || !id) return;

                const now = Date.now();
                const key = `${entityType}:${id}`;
                const prev = this._entityDeathSeen.get(key);
                // Dedupe rapid repeats (common when multiple server subsystems emit on the same death).
                if (prev && (now - prev) < 800) return;
                this._entityDeathSeen.set(key, now);
                // Cleanup old keys occasionally (keep map small)
                if (this._entityDeathSeen.size > 500) {
                    for (const [k, t] of this._entityDeathSeen) {
                        if ((now - t) > 30_000) this._entityDeathSeen.delete(k);
                    }
                }

                const x = Number(data?.x);
                const y = Number(data?.y);
                const hasPos = Number.isFinite(x) && Number.isFinite(y);
                const kind = data?.kind || data?.type || null;

                if (entityType === 'enemy') {
                    // Remove from enemy list (spatial grid)
                    let foundInst = null;
                    if (window.enemies && window.enemies.items) {
                        for (let i = window.enemies.items.length - 1; i >= 0; i--) {
                            const e = window.enemies.items[i];
                            if (e && e._serverId === id) {
                                foundInst = e;
                                e.alive = false;
                                // Call onDeath cleanup before removing (for WallGuy shield cleanup, etc.)
                                try {
                                    if (typeof e.onDeath === 'function') {
                                        e.onDeath({ cause: 'server_death', id: id, source: sourceEvent || 'entity_dead' });
                                    }
                                } catch (err) {
                                    console.error('[Network] Error calling onDeath in entity_dead handler:', err);
                                }
                                window.enemies.items.splice(i, 1);
                                break;
                            }
                        }
                    }

                    // Remove from server ID tracking map
                    if (window._enemyByServerId && window._enemyByServerId.has(id)) {
                        const inst = window._enemyByServerId.get(id);
                        if (inst) inst.alive = false;
                        if (!foundInst) foundInst = inst;
                        window._enemyByServerId.delete(id);
                    }

                    // Clean up recently-killed tracking now that server confirmed death // DEBUG:GhostEnemy
                    if (this._recentlyKilledEnemies && this._recentlyKilledEnemies.has(id)) {
                        this._recentlyKilledEnemies.delete(id);
                    }

                    // If it's a licker, clear ensnare state from local player
                    if (kind === 'licker' && window.player && window.player._ensnaredBy) {
                        if (window.player._ensnaredBy.has(id)) {
                            window.player._ensnaredBy.delete(id);
                            console.log('🦎 [Network] Cleared licker ensnare from local player:', id);

                            // Recalculate aggregate ensnare timer
                            let maxTimer = 0;
                            let primaryId = null;
                            if (window.player._ensnaredBy.size > 0) {
                                window.player._ensnaredBy.forEach((timer, eid) => {
                                    if (timer > maxTimer) {
                                        maxTimer = timer;
                                        primaryId = eid;
                                    }
                                });
                            }
                            window.player._ensnaredTimer = maxTimer;
                            window.player._ensnaredById = primaryId;
                        }
                    }

                    // Spawn blood pool (non-boomers only; boomers use puke pool elsewhere)
                    if (hasPos && kind !== 'boomer' && typeof window.enqueueGroundDecal === 'function' && window.BloodPoolDecal) {
                        const radiusHint = Number.isFinite(foundInst?.radius) ? foundInst.radius : 60;
                        window.enqueueGroundDecal(new window.BloodPoolDecal(x, y, radiusHint));
                    }
                } else if (entityType === 'troop') {
                    // Spawn death VFX (optional)
                    if (hasPos && window.projectiles && window.ImpactVfx) {
                        const deathVfx = new window.ImpactVfx(x, y, '#2a9d8f');
                        window.projectiles.impacts.push(deathVfx);
                    }

                    // Spawn blood pool decal at death location
                    if (hasPos && typeof window.enqueueGroundDecal === 'function' && window.BloodPoolDecal) {
                        let radiusHint = 45;
                        try {
                            const troopList = window.troops && Array.isArray(window.troops.items) ? window.troops.items : null;
                            if (troopList) {
                                const t = troopList.find(tt => tt && tt.id === id);
                                if (t && Number.isFinite(t.radius)) radiusHint = t.radius;
                            }
                        } catch (_) {}
                        window.enqueueGroundDecal(new window.BloodPoolDecal(x, y, radiusHint));
                    }

                    // Best-effort removal from local troop list (if present)
                    if (window.troops && Array.isArray(window.troops.items)) {
                        const idx = window.troops.items.findIndex(t => t && t.id === id);
                        if (idx !== -1) {
                            const troop = window.troops.items[idx];
                            if (troop) troop.alive = false;
                            window.troops.items.splice(idx, 1);
                        }
                    }
                }
            } catch (e) {
                console.error('[Network] Error in entity_dead handler:', e);
            }
        };

        // New unified server event
        this.socket.on('entity_dead', (data) => {
            this._handleEntityDead(data, 'entity_dead');
        });

        // Legacy server-authoritative enemy death cleanup (prevent desyncs) → route to unified handler
        this.socket.on('enemy_dead', (data) => {
            try {
                if (!data || !data.id) return;
                this._handleEntityDead({
                    entityType: 'enemy',
                    id: data.id,
                    x: data.x,
                    y: data.y,
                    kind: data.type,
                    wasGhost: data.wasGhost
                }, 'enemy_dead');
            } catch (e) {
                console.error('[Network] Error handling enemy_dead:', e);
            }
        });

        // Server-authoritative enemy health updates (artillery damage, etc.)
        this.socket.on('enemyHealthUpdate', (data) => {
            try {
                if (!data || !data.id) return;
                
                // Find enemy by server ID
                const enemy = window._enemyByServerId?.get(data.id);
                if (enemy) {
                    const prevHealth = Number(enemy.health) || 0;
                    // Only accept health updates that are lower than current local value
                    // This prevents server updates (from troop damage) from overwriting
                    // client's optimistic damage application, which would make health appear to go UP
                    if (data.health < enemy.health) {
                        enemy.health = data.health;
                    }
                    // Always sync healthMax in case it changed
                    enemy.healthMax = data.healthMax || enemy.healthMax;

                    // Optional: show server-authoritative damage popups (troop attacks, etc.)
                    const dmg = Number(data.damage);
                    if (window.enqueueDamageText && Number.isFinite(dmg) && dmg > 0) {
                        // Prefer server-provided hit coordinates; fallback to enemy position.
                        const hx = Number.isFinite(Number(data.x)) ? Number(data.x) : (Number(enemy.x) || 0);
                        const hy = Number.isFinite(Number(data.y)) ? Number(data.y) : (Number(enemy.y) || 0);
                        const src = data.source || '';
                        const color =
                            src === 'troop_grenade' ? '#ff8800' :
                            src === 'troop_ranged' ? '#5dd9d9' :
                            src === 'troop_melee' ? '#2a9d8f' :
                            '#ffffff';
                        window.enqueueDamageText({
                            x: hx,
                            y: hy - (enemy.radius || 26) - 6,
                            text: Math.round(dmg).toString(),
                            crit: false,
                            color: color,
                            vy: -60,
                            life: 0.6
                        });
                    } else {
                        // Fallback (no explicit dmg provided): if server health went down, we could infer,
                        // but we intentionally skip to avoid duplicates from other local hit paths.
                        void prevHealth;
                    }
                }
            } catch (e) {
                console.error('[Network] Error handling enemyHealthUpdate:', e);
            }
        });
        
        // Server-authoritative enemy death (for artillery kills, etc.)
        this.socket.on('enemyDied', (data) => {
            try {
                // Legacy event name used by some server paths (e.g., artillery explosion). Route to unified handler.
                if (!data || !data.id) return;
                this._handleEntityDead({
                    entityType: 'enemy',
                    id: data.id,
                    x: data.x,
                    y: data.y,
                    kind: data.type || 'basic'
                }, 'enemyDied');
            } catch (e) {
                console.error('[Network] Error handling enemyDied:', e);
            }
        });

        // Server-authoritative Licker ensnare events
        this.socket.on('lickerEnsnared', (data) => {
            try {
                const enemyId = data?.enemyId;
                const playerId = data?.playerId;
                const duration = Number.isFinite(data?.duration) ? data.duration : 3.0;
                
                // Find the licker enemy instance
                let lickerInst = null;
                if (window._enemyByServerId && enemyId) {
                    lickerInst = window._enemyByServerId.get(enemyId);
                }
                
                // If this is us being ensnared, apply the effect
                if (window.networkManager && playerId === this.playerId && window.player) {
                    const p = window.player;
                    if (!p._ensnaredBy || typeof p._ensnaredBy.set !== 'function') {
                        p._ensnaredBy = new Map();
                    }
                    p._ensnaredBy.set(enemyId, Math.max(duration, p._ensnaredBy.get(enemyId) || 0));
                    console.log('🎯 [LickerEvent] Set ensnare - EnemyID:', enemyId, 'Duration:', duration, 'Map size:', p._ensnaredBy.size);
                    p._ensnaredTimer = Math.max(p._ensnaredTimer || 0, duration);
                    p._ensnaredById = enemyId;
                    
                    // Update licker state if found
                    if (lickerInst) {
                        lickerInst._attachTime = duration;
                        lickerInst._attached = true;
                        lickerInst.tentacleState = 'attached';
                    }
                }
                
                // Update licker visual state for all clients
                if (lickerInst && window.Licker && lickerInst instanceof window.Licker) {
                    lickerInst._attachTime = duration;
                    lickerInst._attached = true;
                    lickerInst.tentacleState = 'attached';
                    // Aim angle toward target (use licker position from data)
                    if (window.player && playerId === this.playerId) {
                        const dx = window.player.x - (data.x || lickerInst.x);
                        const dy = window.player.y - (data.y || lickerInst.y);
                        lickerInst._aimAngle = Math.atan2(dy, dx);
                    }
                }
            } catch (e) {
                console.error('[Network] Error handling lickerEnsnared:', e);
            }
        });

        // Artillery Witch (boss) ability events
        this.socket.on('artilleryStrike', (data) => {
            try {
                if (!window.projectiles || !window.Bullet) return;
                
                const tx = Number(data?.targetX) || 0;
                const ty = Number(data?.targetY) || 0;
                const delay = Number(data?.delay) || 1.2;
                const spawnX = Number(data?.spawnX) || 0;
                const spawnY = Number(data?.spawnY) || 0;
                const vx = Number(data?.vx) || 0;
                const vy = Number(data?.vy) || 0;
                const radius = Number(data?.radius) || 6;
                const color = data?.color || '#ffa64d';
                const life = Number(data?.life) || 3.6;
                const angle = Number(data?.angle) || 0;
                const perp = Number(data?.perp) || 1;
                
                // Draw telegraph ring
                const ringRadius = 100;
                const ring = {
                    life: delay,
                    totalLife: delay,
                    cx: tx,
                    cy: ty,
                    update: function(dt) {
                        this.life -= dt;
                        if (this.life <= 0) { this.life = -1; }
                    },
                    draw: function(ctx, cam) {
                        const sx = this.cx - cam.x;
                        const sy = this.cy - cam.y;
                        const t = Math.max(this.life, 0) / this.totalLife;
                        const alpha = 0.6 * t;
                        ctx.save();
                        ctx.translate(sx, sy);
                        // Outer glow
                        try {
                            const hex = color;
                            const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
                            const rr = m ? parseInt(m[1], 16) : 255;
                            const gg = m ? parseInt(m[2], 16) : 170;
                            const bb = m ? parseInt(m[3], 16) : 77;
                            const glowR = ringRadius * 1.6;
                            const grad = ctx.createRadialGradient(0, 0, ringRadius * 0.2, 0, 0, glowR);
                            grad.addColorStop(0, 'rgba(' + rr + ',' + gg + ',' + bb + ',' + (0.18 * alpha) + ')');
                            grad.addColorStop(1, 'rgba(' + rr + ',' + gg + ',' + bb + ',0)');
                            ctx.fillStyle = grad;
                            ctx.beginPath();
                            ctx.arc(0, 0, glowR, 0, Math.PI * 2);
                            ctx.fill();
                        } catch(e) {}
                        // Solid stroke ring on top
                        ctx.strokeStyle = color;
                        ctx.globalAlpha = Math.max(0.5, 0.9 * t);
                        ctx.lineWidth = 3;
                        ctx.shadowColor = color;
                        ctx.shadowBlur = 12;
                        ctx.beginPath();
                        ctx.arc(0, 0, ringRadius, 0, Math.PI * 2);
                        ctx.stroke();
                        ctx.shadowBlur = 0;
                        ctx.restore();
                    }
                };
                window.projectiles.impacts.push(ring);
                
                // Spawn homing projectile
                const options = {
                    targetX: tx,
                    targetY: ty,
                    maxTurnRate: 13.5,
                    bias: perp * 1.8,
                    shadowEnabled: true,
                    accelBallistic: true,
                    ignoreEnvironment: true,
                    ignoreEnemies: true,
                    deathYellowCircle: true,
                    serverSpawned: true, // Mark as server-spawned so no client-side collision
                    artilleryType: 'witch' // Witch artillery - uses normal screen shake
                };
                window.projectiles.items.push(new window.Bullet(spawnX, spawnY, vx, vy, radius, color, life, angle, false, options));
            } catch (e) {
                console.error('[Network] Error handling artilleryStrike:', e);
            }
        });
        
        // Artillery Gun (New Antioch) strike events
        this.socket.on('artilleryGunStrike', (data) => {
            try {
                if (!window.projectiles || !window.Bullet) return;
                
                const tx = Number(data?.targetX) || 0;
                const ty = Number(data?.targetY) || 0;
                const delay = Number(data?.delay) || 1.2;
                const spawnX = Number(data?.spawnX) || 0;
                const spawnY = Number(data?.spawnY) || 0;
                const vx = Number(data?.vx) || 0;
                const vy = Number(data?.vy) || 0;
                const radius = Number(data?.radius) || 8;
                const color = data?.color || '#ffcc00';
                const life = Number(data?.life) || 4.0;
                const angle = Number(data?.angle) || 0;
                const perp = Number(data?.perp) || 1;
                
                // DEBUG: Log client-side ring position (disabled)
                // const dist = Math.hypot(tx - spawnX, ty - spawnY);
                // const speed = Math.hypot(vx, vy);
                // console.log(`[ArtilleryGun CLIENT] Ring center: (${tx.toFixed(1)}, ${ty.toFixed(1)}) | Spawn: (${spawnX.toFixed(1)}, ${spawnY.toFixed(1)}) | Speed: ${speed.toFixed(1)} | Life: ${life.toFixed(2)}s | Dist: ${dist.toFixed(1)}`);
                
                // Draw telegraph ring (golden instead of orange)
                const ringRadius = 180;  // 50% bigger than before (was 120)
                const ring = {
                    life: delay,
                    totalLife: delay,
                    cx: tx,
                    cy: ty,
                    _targetX: tx,  // Store for debug
                    _targetY: ty,
                    update: function(dt) {
                        this.life -= dt;
                        if (this.life <= 0) { this.life = -1; }
                    },
                    draw: function(ctx, cam) {
                        const sx = this.cx - cam.x;
                        const sy = this.cy - cam.y;
                        // Stay visible until 0.7s before impact, then fade out
                        const fadeTime = 0.7;
                        const baseAlpha = 0.455; // 0.7 reduced by 35%
                        const alpha = this.life > fadeTime ? baseAlpha : baseAlpha * (this.life / fadeTime);
                        ctx.save();
                        ctx.translate(sx, sy);
                        // Golden outer glow
                        try {
                            const glowR = ringRadius * 1.6;
                            const grad = ctx.createRadialGradient(0, 0, ringRadius * 0.2, 0, 0, glowR);
                            grad.addColorStop(0, `rgba(255, 204, 0, ${0.14 * (alpha / baseAlpha)})`);
                            grad.addColorStop(1, 'rgba(255, 204, 0, 0)');
                            ctx.fillStyle = grad;
                            ctx.beginPath();
                            ctx.arc(0, 0, glowR, 0, Math.PI * 2);
                            ctx.fill();
                        } catch(e) {}
                        // Solid stroke ring
                        ctx.strokeStyle = color;
                        ctx.globalAlpha = this.life > fadeTime ? 0.6 : Math.max(0.1, 0.6 * (this.life / fadeTime));
                        ctx.lineWidth = 4;
                        ctx.shadowColor = color;
                        ctx.shadowBlur = 16;
                        ctx.beginPath();
                        ctx.arc(0, 0, ringRadius, 0, Math.PI * 2);
                        ctx.stroke();
                        ctx.shadowBlur = 0;
                        ctx.restore();
                    }
                };
                window.projectiles.impacts.push(ring);
                
                // Spawn ballistic projectile
                const options = {
                    targetX: tx,
                    targetY: ty,
                    forceArcToTarget: true,  // Use bezier arc that guarantees arrival at target
                    arcBias: perp * 0.8,     // Use server-provided perp for consistent arc direction
                    shadowEnabled: true,
                    ignoreEnvironment: true,
                    ignoreEnemies: true,
                    deathYellowCircle: true,
                    serverSpawned: true,  // Mark as server-spawned so no client-side collision
                    isFriendly: true,  // Visual indicator that it's friendly
                    artilleryType: 'artilleryGun',  // Artillery Gun - uses boosted screen shake
                    // DEBUG: Track for explosion position logging
                    _debugArtilleryGun: true,
                    _debugTargetX: tx,
                    _debugTargetY: ty
                };
                const bullet = new window.Bullet(spawnX, spawnY, vx, vy, radius, color, life, angle, false, options);
                bullet._debugArtilleryGun = true;
                bullet._debugTargetX = tx;
                bullet._debugTargetY = ty;
                window.projectiles.items.push(bullet);
                
                // DEBUG: Track this bullet to log when it dies
                if (!window._artilleryDebugBullets) window._artilleryDebugBullets = [];
                window._artilleryDebugBullets.push({
                    bullet: bullet,
                    targetX: tx,
                    targetY: ty,
                    logged: false
                });
                
                // DEBUG: Check all tracked bullets for death and log positions
                for (let i = window._artilleryDebugBullets.length - 1; i >= 0; i--) {
                    const tracked = window._artilleryDebugBullets[i];
                    if (tracked.logged) continue;
                    const b = tracked.bullet;
                    // Check if bullet is dead (life <= 0 or not in projectiles array)
                    if (!b || b.life <= 0 || !window.projectiles.items.includes(b)) {
                        // const finalX = b ? b.x : 0;
                        // const finalY = b ? b.y : 0;
                        // const divergence = Math.hypot(finalX - tracked.targetX, finalY - tracked.targetY);
                        // console.log(`[ArtilleryGun CLIENT] EXPLOSION at (${finalX.toFixed(1)}, ${finalY.toFixed(1)}) | Target was (${tracked.targetX.toFixed(1)}, ${tracked.targetY.toFixed(1)}) | DIVERGENCE: ${divergence.toFixed(1)} units`);
                        tracked.logged = true;
                        window._artilleryDebugBullets.splice(i, 1);
                    }
                }
            } catch(e) {
                console.error('[Network] artilleryGunStrike error:', e);
            }
        });

        this.socket.on('defenseTurretShot', (data) => {
            try {
                if (!window.projectiles || !window.Bullet) return;
                
                const turretId = data?.turretId;
                const angle = Number(data?.angle) || 0;
                
                // Find turret and update its angle
                let turret = null;
                if (turretId && window._enemyByServerId) {
                    turret = window._enemyByServerId.get(turretId);
                }
                
                if (!turret || turret.type !== 'defenseTurret') {
                    console.warn('[Network] defenseTurretShot: turret not found or wrong type');
                    return;
                }
                
                // Update turret barrel angle for rendering
                turret._barrelAngle = angle;
                
                // Add muzzle flash (like AutoTurret)
                if (!turret._muzzleFlashes) turret._muzzleFlashes = [];
                if (turret._currentBarrel === undefined) turret._currentBarrel = 0;
                
                turret._muzzleFlashes.push({
                    side: turret._currentBarrel,
                    life: 0.15,
                    intensity: 1.0
                });
                turret._currentBarrel = 1 - turret._currentBarrel; // Alternate barrels
                
                // Spawn fast tracer bullet (like weapon 7 / AutoTurret)
                const barrelLength = 32; // Match defensive turret barrel length
                const barrelOffset = 12; // Match defensive turret barrel offset
                const perpAngle = angle + Math.PI / 2;
                const barrelSide = (turret._currentBarrel === 0) ? 1 : -1; // Match current barrel
                const offsetX = Math.cos(perpAngle) * barrelOffset * barrelSide;
                const offsetY = Math.sin(perpAngle) * barrelOffset * barrelSide;
                const tipX = turret.x + Math.cos(angle) * barrelLength + offsetX;
                const tipY = turret.y + Math.sin(angle) * barrelLength + offsetY;
                
                const dirX = Math.cos(angle);
                const dirY = Math.sin(angle);
                const bulletSpeed = 16000; // Same as weapon 7
                const vx = dirX * bulletSpeed;
                const vy = dirY * bulletSpeed;
                
                // Calculate travel distance (like weapon 7)
                const targetingRadius = 800; // Defensive turret range
                const minDistFromCenter = targetingRadius;
                const maxDistFromCenter = minDistFromCenter + 100;
                const spawnOffset = Math.hypot(tipX - turret.x, tipY - turret.y);
                const desiredFromCenter = minDistFromCenter + (Math.random() * (maxDistFromCenter - minDistFromCenter));
                const travelDist = Math.max(8, desiredFromCenter - spawnOffset);
                
                // Create bullet with weapon 7 style (fast tracer)
                const options = {
                    damage: 15, // Defensive turret damage
                    shape: 'rect',
                    rectWidth: 36,
                    rectHeight: 2,
                    impactScale: 1.4,
                    targetX: tipX + dirX * travelDist,
                    targetY: tipY + dirY * travelDist,
                    maxTurnRate: 0, // Straight line
                    travelDistance: travelDist,
                    serverSpawned: true, // Server-authoritative
                    isFriendly: true, // Don't hurt players
                    sourceWeaponIndex: 6 // Acts like weapon 7
                };
                
                const bulletLife = Math.min(3.6, travelDist / bulletSpeed);
                const bullet = window.bulletPool 
                    ? window.bulletPool.get(tipX, tipY, vx, vy, 6, turret.color, bulletLife, angle, false, options)
                    : new window.Bullet(tipX, tipY, vx, vy, 6, turret.color, bulletLife, angle, false, options);
                
                window.projectiles.items.push(bullet);
            } catch (e) {
                console.error('[Network] Error handling defenseTurretShot:', e);
            }
        });
        
        this.socket.on('bossFastBall', (data) => {
            try {
                if (!window.projectiles || !window.Bullet) return;
                
                const spawnX = Number(data?.x) || 0;
                const spawnY = Number(data?.y) || 0;
                const vx = Number(data?.vx) || 0;
                const vy = Number(data?.vy) || 0;
                const radius = Number(data?.radius) || 12;
                const color = data?.color || '#ffa64d';
                const life = Number(data?.life) || 3.6;
                const angle = Number(data?.angle) || 0;
                const damage = Number(data?.damage) || 35;
                
                // Spawn Fast Ball projectile (straight shot, no homing)
                const options = {
                    owner: { name: 'ArtilleryWitch', isEnemy: true },
                    allowMidflightPlayerHit: true,
                    deathYellowCircle: true,
                    ignoreEnemies: true,
                    ignoreEnvironment: true,
                    maxTurnRate: 0,
                    targetX: null,
                    targetY: null,
                    damage: damage
                };
                const bullet = new window.Bullet(spawnX, spawnY, vx, vy, radius, color, life, angle, false, options);
                bullet._serverEnemyBullet = true; // Mark as enemy bullet for collision detection
                window.projectiles.items.push(bullet);
            } catch (e) {
                console.error('[Network] Error handling bossFastBall:', e);
            }
        });

        this.socket.on('bossDashed', (data) => {
            try {
                // Visual feedback for boss dash (optional)
                // Could add dash trail VFX or sound effect here
                console.log('[Network] Boss dashed:', data);
            } catch (e) {
                console.error('[Network] Error handling bossDashed:', e);
            }
        });

        // Player health updates from server (authoritative)
        this.socket.on('playerHealthUpdate', (data) => {
            try {
                if (!data) return;
                // If this is us, update our health and trigger hit flash
                if (window.networkManager && data.playerId === this.playerId && window.player) {
                    const healthBefore = window.player.health;
                    const healthMaxBefore = window.player.healthMax;
                    const newHealth = Number.isFinite(data.health) ? data.health : window.player.health;
                    const newHealthMax = Number.isFinite(data.healthMax) ? data.healthMax : window.player.healthMax;
                    window.player.health = newHealth;
                    window.player.healthMax = newHealthMax;
                    
                    // If health decreased, trigger hit flash AND damage event (for boomers, boss attacks, etc.)
                    // BUT: Exclude cases where healthMax changed (loot pickup or stale server data)
                    // ALSO: Skip DOT damage - it's handled by pvpHit event with proper orange color
                    if (typeof healthBefore === 'number' && newHealth < healthBefore && newHealth > 0 && newHealthMax === healthMaxBefore && data.from !== 'dot') {
                        const damageTaken = healthBefore - newHealth;
                        
                        // DEBUG:GhostEnemy - Check for invisible enemies when taking contact damage
                        if (data.from === 'contact' && data._debugEnemyIds) {
                            const px = window.player.x || 0;
                            const py = window.player.y || 0;
                            const visibleEnemies = [];
                            const ghostEnemies = [];
                            
                            for (const serverId of data._debugEnemyIds) {
                                const enemy = window._enemyByServerId?.get(serverId);
                                
                                // Skip enemies we just killed (within last 500ms) - not ghosts, just network latency // DEBUG:GhostEnemy
                                const recentlyKilled = this._recentlyKilledEnemies?.get(serverId); // DEBUG:GhostEnemy
                                if (recentlyKilled && (Date.now() - recentlyKilled) < 500) { // DEBUG:GhostEnemy
                                    continue; // Not a ghost, just server hasn't processed death yet // DEBUG:GhostEnemy
                                } // DEBUG:GhostEnemy
                                
                                if (enemy && enemy.alive) {
                                    visibleEnemies.push({ id: serverId, type: enemy.type, x: enemy.x?.toFixed(0), y: enemy.y?.toFixed(0) });
                                } else {
                                    ghostEnemies.push(serverId);
                                }
                            }
                            
                            if (ghostEnemies.length > 0) {
                                // Rate-limit ghost detection logs (once per 2s)
                                if (!this._lastGhostLog || Date.now() - this._lastGhostLog > 2000) {
                                    this._lastGhostLog = Date.now();
                                    // console.error(`🚨 [DEBUG:GhostEnemy] INVISIBLE ENEMY HIT! Ghost IDs: [${ghostEnemies.join(', ')}] at player pos (${px.toFixed(0)}, ${py.toFixed(0)})`);
                                    // console.error(`🚨 [DEBUG:GhostEnemy] Visible enemies nearby:`, visibleEnemies);
                                }
                                
                                // REACTIVE FALLBACK: Kill ghosts that slipped through proactive detection // DEBUG:GhostEnemy
                                for (const ghostId of ghostEnemies) { // DEBUG:GhostEnemy
                                    // Skip defensive structures - they should never be ghost-killed
                                    if (ghostId.startsWith('defenseTurret_') || ghostId.startsWith('artilleryGun_')) {
                                        continue;
                                    }
                                    this.socket.emit('killGhostEnemy', { id: ghostId }); // DEBUG:GhostEnemy
                                } // DEBUG:GhostEnemy
                            }
                            // Removed: noisy "Contact damage from visible enemies" log - this is normal gameplay
                        }
                        
                        // Trigger hit flash (skip during dash invulnerability)
                        try {
                            const isDashing = window.player.dashActive && window.player.dashDuration > 0;
                            if (!isDashing) {
                                const canFlash = (!window.player.hitFlash || window.player.hitFlash <= 0) && 
                                               (!window.player.hitFlashCooldown || window.player.hitFlashCooldown <= 0);
                                if (canFlash && typeof window.player.hitFlashMax === 'number') {
                                    window.player.hitFlash = window.player.hitFlashMax;
                                    window.player.hitFlashCooldown = window.player.hitFlashGap || 0.07;
                                }
                            }
                        } catch(e) { 
                            console.error('❌ [Network] Hit flash error in playerHealthUpdate:', e); 
                        }
                        
                        // Queue damage event for shake/vignette AND floating damage numbers (skip during dash invulnerability)
                        try {
                            const isDashing = window.player.dashActive && window.player.dashDuration > 0;
                            if (!isDashing && window.enqueueDamageEvent && typeof window.enqueueDamageEvent === 'function') {
                                let shakeScale = 1;
                                // Boomer explosions get stronger shake
                                if (data.from === 'boomer') {
                                    shakeScale = 1.5;
                                }
                                // Ensnared gets stronger shake
                                if (window.player._ensnaredById != null || (window.player._ensnaredBy && window.player._ensnaredBy.size > 0)) {
                                    shakeScale = 2;
                                }
                                window.enqueueDamageEvent(damageTaken, { 
                                    source: data.from || 'playerHealthUpdate', 
                                    shakeScale 
                                });
                            }
                        } catch(e) {
                            console.error('❌ [Network] Error queueing damage event in playerHealthUpdate:', e);
                        }
                    }
                }
                // Optionally update remote players if tracked
            } catch (e) {
                console.error('[Network] Error handling playerHealthUpdate:', e);
            }
        });

        // Player slow state updates from server (authoritative)
        this.socket.on('playerSlowState', (data) => {
            try {
                if (!data || !data.playerId) return;
                if (!this.remoteSlowedPlayers) this.remoteSlowedPlayers = new Map();
                if (data.slowed) {
                    const entry = this.remoteSlowedPlayers.get(data.playerId) || {};
                    entry.startTime = Date.now();
                    // keep existing drips if any
                    this.remoteSlowedPlayers.set(data.playerId, entry);
                } else {
                    this.remoteSlowedPlayers.delete(data.playerId);
                }
                // If it's us, also gate local movement speed using a flag
                if (data.playerId === this.playerId && window.player) {
                    window.player._svSlowed = !!data.slowed;
                    // Also set _slowState for VFX (drip particles) and movement slow
                    if (!window.player._slowState) window.player._slowState = { active: false, timer: 0, fade: 0 };
                    window.player._slowState.active = !!data.slowed;
                    if (data.slowed) {
                        window.player._slowState.timer = 4.0; // Server maintains 4s decay timer
                    }
                    if (!data.slowed) {
                        // Clear local drips quickly to avoid remnants
                        try { window.player._slimeDrips = []; } catch(_) {}
                    }
                }
            } catch (e) {
                console.error('[Network] Error handling playerSlowState:', e);
            }
        });
        
        // Mud pool slow state (separate from puke pool slow)
        this.socket.on('playerMudSlowState', (data) => {
            try {
                if (!data || !data.playerId) return;
                // Track remote mud-slowed players for VFX
                if (!this.remoteMudSlowedPlayers) this.remoteMudSlowedPlayers = new Map();
                if (data.slowed) {
                    const entry = this.remoteMudSlowedPlayers.get(data.playerId) || {};
                    entry.startTime = Date.now();
                    this.remoteMudSlowedPlayers.set(data.playerId, entry);
                } else {
                    this.remoteMudSlowedPlayers.delete(data.playerId);
                }
                
                const isLocal = (data.playerId === this.playerId);
                if (isLocal && window.player) {
                    // Set mud slow state for VFX
                    if (!window.player._mudSlowState) window.player._mudSlowState = { active: false };
                    window.player._mudSlowState.active = !!data.slowed;
                    if (!data.slowed) {
                        // Clear mud drips when exiting mud
                        try { window.player._mudDrips = []; } catch(_) {}
                    }
                }
            } catch (e) {
                console.error('[Network] Error handling playerMudSlowState:', e);
            }
        });
        
        // Gas canister fog of war intensity (gradual buildup)
        this.socket.on('playerGasIntensity', (data) => {
            try {
                if (!data || !data.playerId) return;
                
                const isLocal = (data.playerId === this.playerId);
                if (isLocal && window.state) {
                    // Set gas fog intensity from server (0-1, fades in over 3 seconds)
                    window.state.gasFog = Math.max(0, Math.min(1, data.intensity || 0));
                }
                
                // Track remote players in gas for potential VFX
                if (!this.remoteGasPlayers) this.remoteGasPlayers = new Map();
                if (data.intensity > 0) {
                    const entry = this.remoteGasPlayers.get(data.playerId) || {};
                    entry.intensity = data.intensity;
                    entry.updateTime = Date.now();
                    this.remoteGasPlayers.set(data.playerId, entry);
                } else {
                    this.remoteGasPlayers.delete(data.playerId);
                }
            } catch (e) {
                console.error('[Network] Error handling playerGasIntensity:', e);
            }
        });
        
        // PvP evil state synchronization
        this.socket.on('playerEvilState', (data) => {
            try {
                if (!data || !data.playerId) return;
                if (!this.remotePlayerEvilStates) {
                    this.remotePlayerEvilStates = new Map();
                }
                this.remotePlayerEvilStates.set(data.playerId, !!data.isEvil);
                console.log(`[PvP] Player ${data.playerId} evil state: ${data.isEvil}`);
            } catch (e) {
                console.error('[Network] Error handling playerEvilState:', e);
            }
        });
        
        // PvP hit notification (for visual feedback)
        this.socket.on('pvpHit', (data) => {
            try {
                if (!data) return;
                console.log(`[PvP] Player ${data.attackerId} hit player ${data.victimId} for ${data.damage} damage`);
                
                // Show damage number at victim position
                if (window.enqueueDamageText && data.x && data.y) {
                    // Use fire color for DOT damage
                    let damageColor = '#ff4444';
                    if (data.isDot) {
                        damageColor = '#ff8800'; // Orange fire color for DOT
                    } else if (data.crit) {
                        damageColor = '#ffd36b'; // Yellow for crits
                    }
                    
                    window.enqueueDamageText({
                        x: data.x,
                        y: data.y - 26,
                        text: Math.round(data.damage).toString(),
                        crit: !!data.crit,
                        color: damageColor,
                        vy: -80,
                        life: 0.8
                    });
                }
                
                // Trigger hit flash for victim if it's us
                if (data.victimId === this.playerId && window.player) {
                    try {
                        const canFlash = !window.player.hitFlashCooldown || window.player.hitFlashCooldown <= 0;
                        if (canFlash && typeof window.player.hitFlashMax === 'number') {
                            window.player.hitFlash = window.player.hitFlashMax;
                            window.player.hitFlashCooldown = window.player.hitFlashGap || 0.07;
                        }
                    } catch(e) { 
                        console.error('❌ [PvP] Hit flash error:', e); 
                    }
                }
            } catch (e) {
                console.error('[Network] Error handling pvpHit:', e);
            }
        });
        
        // PvP kill notification
        this.socket.on('pvpKill', (data) => {
            try {
                if (!data) return;
                console.log(`[PvP] Player ${data.killerId} killed player ${data.victimId}`);
            } catch (e) {
                console.error('[Network] Error handling pvpKill:', e);
            }
        });
        
        // BigBoy dash windup handler
        this.socket.on('enemyDashWindup', (data) => {
            try {
                const enemy = window._enemyByServerId?.get(data?.enemyId);
                if (enemy && enemy.dashWindupDuration) {
                    enemy.dashTarget = this._findPlayerById(data?.targetPlayerId);
                    enemy.dashWindup = enemy.dashWindupDuration;
                }
            } catch(e) {}
        });
        
        // BigBoy dash execution handler
        this.socket.on('enemyDash', (data) => {
            try {
                const enemy = window._enemyByServerId?.get(data?.enemyId);
                if (enemy) {
                    // Clear windup state (dash is now executing)
                    enemy.dashWindup = 0;
                    enemy.dashTarget = null;
                    
                    // Apply knockback to players in dash path
                    this._applyBigBoyDashKnockback(enemy, data.dirX, data.dirY);
                }
            } catch(e) {}
        });
    }
    
    // Helper method to find player by ID
    _findPlayerById(playerId) {
        if (!playerId) return null;
        
        // Check if it's the local player
        if (this.playerId === playerId && window.player) {
            return window.player;
        }
        
        // Check remote players
        if (this.otherPlayers) {
            return this.otherPlayers.get(playerId);
        }
        
        return null;
    }
    
    // Helper method for BigBoy dash knockback
    _applyBigBoyDashKnockback(enemy, dirX, dirY) {
        if (!window.player) return;
        
        const p = window.player;
        const dx = p.x - enemy.x;
        const dy = p.y - enemy.y;
        const dist = Math.hypot(dx, dy);
        
        // Check if player is in dash path (within 120 units of dash line)
        if (dist <= 120) {
            // Calculate how directly the player is hit
            const dot = (dx * dirX + dy * dirY) / Math.max(dist, 1);
            const alignment = Math.max(0, dot); // 0 = perpendicular, 1 = direct hit
            
            // Apply knockback with fan-out effect
            const baseKnockback = 150; // Base knockback distance
            const maxKnockback = 250; // Maximum knockback for direct hits
            const knockbackDistance = baseKnockback + (maxKnockback - baseKnockback) * alignment;
            
            // Apply knockback to player
            if (typeof p.applyKnockback === 'function') {
                p.applyKnockback(dirX, dirY, knockbackDistance, 0.4);
            }
            
            // Apply damage (35-50)
            const damage = 35 + Math.random() * 15;
            if (typeof p.applyDamage === 'function') {
                p.applyDamage(damage);
            }
        }
    }
    
    // Send bullet firing event to other players (batched for 30-40% bandwidth reduction)
    sendBulletFired(bulletData) {
        if (!this.connected || !this.socket) return;
        
        // Sanitize bulletData to avoid circular references (e.g., options.owner = player with inventory)
        const sanitizedData = { ...bulletData };
        if (sanitizedData.options) {
            const { owner, ...cleanOptions } = sanitizedData.options;
            sanitizedData.options = cleanOptions;
        }
        
        const data = {
            bulletData: sanitizedData,
            timestamp: Date.now()
        };
        
        // Use batching if available, otherwise send immediately
        if (this.batcher) {
            this.batcher.queueEvent('projectiles', 'bulletFired', data);
        } else {
            this.socket.emit('bulletFired', data);
        }
    }
    
    // Send weapon 7 hitscan event to server for instant damage (lag-compensated)
    sendWeapon7Hitscan(hitscanData) {
        if (!this.connected || !this.socket) return;
        
        // Send immediately (not batched) for instant hit registration
        this.socket.emit('weapon7Hitscan', hitscanData);
    }
    
    // Send VFX creation event to other players (batched for 30-40% bandwidth reduction)
    sendVfxCreated(type, x, y, options = {}) {
        if (!this.connected || !this.socket) return;
        
        const data = {
            type: type,
            x: x,
            y: y,
            timestamp: Date.now(),
            ...options
        };
        
        // Use batching if available, otherwise send immediately
        if (this.batcher) {
            this.batcher.queueEvent('vfx', 'vfxCreated', data);
        } else {
            this.socket.emit('vfxCreated', data);
        }
    }
    
    // Send invisibility toggle request to server (weapon 5 secondary ability)
    sendInvisibilityToggle(activate) {
        if (!this.connected || !this.socket) return;
        
        this.socket.emit('invisibilityToggle', {
            activate: activate,
            timestamp: Date.now()
        });
    }
    
    disconnect() {
        if (this.socket) {
            this.socket.disconnect();
            this.socket = null;
        }
        this.connected = false;
        this.otherPlayers.clear();
    }
    
    sendInput(inputState, playerPosition) {
        if (!this.connected || !this.socket) return;
        
        // Block input when merchant shop is open
        if (window.merchantShop && window.merchantShop.open) return;
        
        const now = Date.now();
        // Don't throttle if dash is requested (critical one-time input)
        const hasDashRequest = inputState.wantsDash;
        if (!hasDashRequest && now - this.lastInputTime < this.inputInterval) {
            return; // Throttle input rate (except dash)
        }
        
        this.lastInputTime = now;
        this.inputSequence++;
        
        const input = {
            sequence: this.inputSequence,
            timestamp: now,
            keys: { ...inputState.keys },
            mouse: { ...inputState.mouse },
            mouseDown: inputState.mouseDown,
            aimAngle: inputState.aimAngle,
            wantsDash: inputState.wantsDash || false, // Dash request flag
            isWeapon8ADS: inputState.isWeapon8ADS || false, // Weapon 8 ADS slow
            // Used server-side to make player untargetable while reading NPC dialogue
            dialogueOpen: !!(typeof window !== 'undefined' && window.dialogueBox && window.dialogueBox.open),
            // Include predicted position for server validation
            predictedX: playerPosition.x,
            predictedY: playerPosition.y,
            // Evil/heretic conversion state for visual replication
            evilProgress: (typeof window !== 'undefined' && typeof window.__killThemAllProgress === 'number') ? window.__killThemAllProgress : 0,
            evilLocked: (typeof window !== 'undefined' && window.__killThemAllLocked === true),
            // Weapon firing state for stamina tracking
            isFiringWeapon1: (typeof window !== 'undefined' && window.player && window.player.isFiringWeapon1) || false,
            isFiringWeapon4: (typeof window !== 'undefined' && window.player && window.player.isFiringWeapon4) || false
        };
        
        // Debug log when sending dash
        if (input.wantsDash) {
            console.log(`[Client] 📤 SENDING INPUT PACKET with wantsDash=true | Sequence: ${input.sequence}`);
        }
        
        // Store input for potential rollback and track local position
        this.inputBuffer.set(this.inputSequence, {
            ...input,
            playerPosition: { x: playerPosition.x, y: playerPosition.y }
        });
        
        // Track local position for correction threshold
        this.lastLocalPosition = { x: playerPosition.x, y: playerPosition.y };
        
        // Clean old inputs (keep last 1 second worth)
        const cutoffTime = now - 1000;
        for (const [seq, storedInput] of this.inputBuffer) {
            if (storedInput.timestamp < cutoffTime) {
                this.inputBuffer.delete(seq);
            }
        }
        
        this.socket.emit('playerInput', input);
        
        // Debug logging for prediction
        if (window.gameDebugger) {
            window.gameDebugger.verbose('NETWORKING', `Sent input seq:${this.inputSequence}`, {
                position: { x: playerPosition.x.toFixed(1), y: playerPosition.y.toFixed(1) },
                keys: Object.keys(inputState.keys).filter(k => inputState.keys[k])
            });
        }
    }
    
    updateOtherPlayers(players) {
        const now = Date.now();
        
        // Update existing players with snapshot history for better interpolation
        for (const serverPlayer of players) {
            if (serverPlayer.id !== this.playerId) {
                const existingPlayer = this.otherPlayers.get(serverPlayer.id);
                
                // Initialize snapshot history if needed
                if (!existingPlayer || !existingPlayer.snapshots) {
                    this.otherPlayers.set(serverPlayer.id, {
                        ...serverPlayer,
                        snapshots: [{
                            x: serverPlayer.x,
                            y: serverPlayer.y,
                            timestamp: now
                        }],
                        _ensnarePulseT: 0
                    });
                    // Initialize hit flash tracking
                    if (!this.remoteHitFlashPlayers.has(serverPlayer.id)) {
                        this.remoteHitFlashPlayers.set(serverPlayer.id, {
                            hitFlash: 0,
                            hitFlashCooldown: 0,
                            previousHealth: serverPlayer.health
                        });
                    }
                } else {
                    // Preserve ensnare pulse timer for smooth animation
                    const prevPulseT = existingPlayer._ensnarePulseT || 0;
                    
                    // Check for health decrease to trigger hit flash
                    const hitFlashData = this.remoteHitFlashPlayers.get(serverPlayer.id);
                    if (hitFlashData) {
                        const healthBefore = hitFlashData.previousHealth;
                        const healthAfter = serverPlayer.health;
                        
                        // Trigger hit flash if health decreased and cooldown has elapsed
                        if (typeof healthBefore === 'number' && typeof healthAfter === 'number' && 
                            healthAfter < healthBefore && healthAfter > 0) {
                            // Only trigger if previous flash completed and cooldown elapsed
                            const canFlash = (!hitFlashData.hitFlash || hitFlashData.hitFlash <= 0) && 
                                           (!hitFlashData.hitFlashCooldown || hitFlashData.hitFlashCooldown <= 0);
                            if (canFlash) {
                                hitFlashData.hitFlash = 0.12; // 120ms flash
                                hitFlashData.hitFlashCooldown = 0.07; // 70ms cooldown after flash
                            }
                        }
                        
                        // Update previous health
                        hitFlashData.previousHealth = healthAfter;
                    } else {
                        // Initialize if not present
                        this.remoteHitFlashPlayers.set(serverPlayer.id, {
                            hitFlash: 0,
                            hitFlashCooldown: 0,
                            previousHealth: serverPlayer.health
                        });
                    }
                    
                    // Phase 2.4: Apply smooth position interpolation for remote players
                    // Calculate target position (smooth to reduce jitter)
                    const currentX = existingPlayer.x || serverPlayer.x;
                    const currentY = existingPlayer.y || serverPlayer.y;
                    const targetX = serverPlayer.x;
                    const targetY = serverPlayer.y;
                    
                    const errorDist = Math.sqrt((targetX - currentX) ** 2 + (targetY - currentY) ** 2);
                    const REMOTE_SNAP_THRESHOLD = 150; // Snap if very far (teleport/respawn)
                    const REMOTE_SMOOTH_RATE = 0.4; // Faster smoothing for remote players (40% per frame)
                    
                    let smoothedX = targetX;
                    let smoothedY = targetY;
                    
                    if (errorDist < REMOTE_SNAP_THRESHOLD) {
                        // Smooth interpolation for normal movement
                        smoothedX = currentX + (targetX - currentX) * REMOTE_SMOOTH_RATE;
                        smoothedY = currentY + (targetY - currentY) * REMOTE_SMOOTH_RATE;
                    }
                    // else: snap immediately for large distances
                    
                    // Smooth rotation for remote players to prevent choppy turning
                    let smoothedAimAngle = serverPlayer.aimAngle;
                    if (typeof existingPlayer.aimAngle === 'number' && typeof serverPlayer.aimAngle === 'number') {
                        let angleDiff = serverPlayer.aimAngle - existingPlayer.aimAngle;
                        // Normalize to [-PI, PI] for shortest path
                        while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
                        while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
                        
                        const REMOTE_ROTATION_SMOOTH_RATE = 0.45; // Even faster for remote players (more responsive)
                        smoothedAimAngle = existingPlayer.aimAngle + angleDiff * REMOTE_ROTATION_SMOOTH_RATE;
                        smoothedAimAngle = (smoothedAimAngle + Math.PI * 2) % (Math.PI * 2); // Normalize
                    }
                    
                    // Add new snapshot with smoothed position
                    existingPlayer.snapshots.push({
                        x: smoothedX,
                        y: smoothedY,
                        timestamp: now
                    });
                    
                    // Keep only last 500ms of snapshots for interpolation
                    const cutoffTime = now - 500;
                    existingPlayer.snapshots = existingPlayer.snapshots.filter(s => s.timestamp > cutoffTime);
                    
                    // Update other properties, preserving pulse timer and updating ensnare state
                    Object.assign(existingPlayer, {
                        ...serverPlayer,
                        x: smoothedX,       // Use smoothed position
                        y: smoothedY,       // Use smoothed position
                        aimAngle: smoothedAimAngle,  // Use smoothed rotation
                        snapshots: existingPlayer.snapshots,
                        _ensnarePulseT: prevPulseT
                    });
                }
            }
        }
        
        // Remove players that are no longer on the server
        const serverPlayerIds = new Set(players.map(p => p.id));
        for (const [playerId] of this.otherPlayers) {
            if (!serverPlayerIds.has(playerId)) {
                this.otherPlayers.delete(playerId);
                // Also clean up hit flash tracking
                this.remoteHitFlashPlayers.delete(playerId);
            }
        }
    }
    
    recordNetworkDiagnostics(state, receivedAt) {
        if (!this.netMetrics || !state) return;
        const metrics = this.netMetrics;
        const now = Number.isFinite(receivedAt) ? receivedAt : Date.now();
        const fallbackTickRate = 60;
        const numericTickRate = state && Number.isFinite(Number(state.tickRate)) && Number(state.tickRate) > 0 ? Number(state.tickRate) : fallbackTickRate;
        const msPerTick = numericTickRate > 0 ? 1000 / numericTickRate : 0;

        const timestamp = Number(state.timestamp);
        if (Number.isFinite(timestamp)) {
            const driftMs = now - timestamp;
            metrics.drift.min = Math.min(metrics.drift.min, driftMs);
            metrics.drift.max = Math.max(metrics.drift.max, driftMs);
            metrics.drift.total += driftMs;
            metrics.drift.count++;
        }

        if (typeof metrics.lastSnapshotAt === 'number') {
            const intervalMs = now - metrics.lastSnapshotAt;
            if (intervalMs >= 0) {
                metrics.arrival.min = Math.min(metrics.arrival.min, intervalMs);
                metrics.arrival.max = Math.max(metrics.arrival.max, intervalMs);
                metrics.arrival.total += intervalMs;
                metrics.arrival.count++;
            }
        }
        metrics.lastSnapshotAt = now;

        const serverTick = Number(state.tick);
        if (Number.isFinite(serverTick)) {
            if (typeof metrics.lastTick === 'number') {
                const tickDelta = serverTick - metrics.lastTick;
                if (tickDelta >= 0) {
                    if (tickDelta > 0 && msPerTick > 0) {
                        const tickMs = tickDelta * msPerTick;
                        metrics.tickGap.min = Math.min(metrics.tickGap.min, tickMs);
                        metrics.tickGap.max = Math.max(metrics.tickGap.max, tickMs);
                        metrics.tickGap.total += tickMs;
                        metrics.tickGap.count++;
                    }
                    if (tickDelta > 1) {
                        metrics.missedTicks += (tickDelta - 1);
                    }
                } else {
                    metrics.tickGapOutOfOrder += 1;
                }
            }
            metrics.lastTick = serverTick;
        } else {
            metrics.lastTick = null;
        }

        if (!metrics.lastLogTime) {
            metrics.lastLogTime = now;
        }

        const elapsed = now - metrics.lastLogTime;
        if (elapsed >= metrics.logIntervalMs) {
            const hasSamples = (metrics.drift.count + metrics.arrival.count + metrics.tickGap.count) > 0 || metrics.missedTicks > 0 || metrics.tickGapOutOfOrder > 0;
            if (hasSamples) {
                const summary = {
                    driftAvgMs: metrics.drift.count ? Number((metrics.drift.total / metrics.drift.count).toFixed(1)) : null,
                    driftMinMs: metrics.drift.min === Infinity ? null : Math.round(metrics.drift.min),
                    driftMaxMs: metrics.drift.max === -Infinity ? null : Math.round(metrics.drift.max),
                    arrivalAvgMs: metrics.arrival.count ? Number((metrics.arrival.total / metrics.arrival.count).toFixed(1)) : null,
                    arrivalMinMs: metrics.arrival.min === Infinity ? null : Math.round(metrics.arrival.min),
                    arrivalMaxMs: metrics.arrival.max === -Infinity ? null : Math.round(metrics.arrival.max),
                    tickGapAvgMs: metrics.tickGap.count ? Number((metrics.tickGap.total / metrics.tickGap.count).toFixed(1)) : null,
                    tickGapMinMs: metrics.tickGap.min === Infinity ? null : Math.round(metrics.tickGap.min),
                    tickGapMaxMs: metrics.tickGap.max === -Infinity ? null : Math.round(metrics.tickGap.max),
                    missedTicks: metrics.missedTicks,
                    samples: {
                        drift: metrics.drift.count,
                        arrival: metrics.arrival.count,
                        tickGap: metrics.tickGap.count
                    }
                };
                if (metrics.tickGapOutOfOrder > 0) {
                    summary.outOfOrder = metrics.tickGapOutOfOrder;
                }

                if (window.gameDebugger && typeof window.gameDebugger.verbose === 'function') {
                    window.gameDebugger.verbose('NETWORKING', 'Snapshot telemetry', summary);
                } else if (typeof console !== 'undefined' && typeof console.debug === 'function') {
                    console.debug('[Network] Snapshot telemetry', summary);
                } else if (typeof console !== 'undefined' && typeof console.log === 'function') {
                    console.log('[Network] Snapshot telemetry', summary);
                }
            }

            metrics.lastLogTime = now;
            const reset = (bucket) => {
                bucket.min = Infinity;
                bucket.max = -Infinity;
                bucket.total = 0;
                bucket.count = 0;
            };
            reset(metrics.drift);
            reset(metrics.arrival);
            reset(metrics.tickGap);
            metrics.missedTicks = 0;
            metrics.tickGapOutOfOrder = 0;
        }
    }

    updateRemoteHitFlashes(dt) {
        // Decrease hit flash timers and cooldowns for all remote players
        for (const [playerId, data] of this.remoteHitFlashPlayers.entries()) {
            if (data.hitFlash > 0) {
                data.hitFlash = Math.max(0, data.hitFlash - dt);
            }
            if (data.hitFlashCooldown > 0) {
                data.hitFlashCooldown = Math.max(0, data.hitFlashCooldown - dt);
            }
        }
    }
    
    updateRemoteEnsnareTimers(dt) {
        // Update ensnare pulse timers for visual animation on remote players
        for (const [playerId, player] of this.otherPlayers.entries()) {
            if (player._ensnaredTimer && player._ensnaredTimer > 0) {
                player._ensnarePulseT = (player._ensnarePulseT || 0) + dt;
            } else {
                player._ensnarePulseT = 0;
            }
        }
    }
    
    getOtherPlayers() {
        const now = Date.now();
        const interpolatedPlayers = [];
        
        // Use time-shifted interpolation: render 100ms in the past for smoother interpolation
        const renderTime = now - 100;
        
        for (const player of this.otherPlayers.values()) {
            if (!player.snapshots || player.snapshots.length === 0) {
                interpolatedPlayers.push(player);
                continue;
            }
            
            // Initialize trail points array and tracking variables if not exists
            if (!player._trailPoints) {
                player._trailPoints = [];
                player._trailAcc = 0;
                player._lastTrailT = now;
                player._lastTrailEmitPos = { x: player.x, y: player.y };
                player._smoothedSpeed = 0;
            }
            
            // Find the two snapshots to interpolate between
            let snapshot1 = null;
            let snapshot2 = null;
            
            for (let i = 0; i < player.snapshots.length - 1; i++) {
                if (player.snapshots[i].timestamp <= renderTime && 
                    player.snapshots[i + 1].timestamp >= renderTime) {
                    snapshot1 = player.snapshots[i];
                    snapshot2 = player.snapshots[i + 1];
                    break;
                }
            }
            
            let interpolatedX = player.x;
            let interpolatedY = player.y;
            let instantSpeed = 0;
            
            if (snapshot1 && snapshot2) {
                // Interpolate between two snapshots based on timestamps
                const totalTime = snapshot2.timestamp - snapshot1.timestamp;
                const elapsedTime = renderTime - snapshot1.timestamp;
                const lerpFactor = totalTime > 0 ? elapsedTime / totalTime : 0;
                
                interpolatedX = this.lerp(snapshot1.x, snapshot2.x, lerpFactor);
                interpolatedY = this.lerp(snapshot1.y, snapshot2.y, lerpFactor);
                
                // Calculate speed from snapshots (in pixels per second)
                const deltaX = snapshot2.x - snapshot1.x;
                const deltaY = snapshot2.y - snapshot1.y;
                const deltaTime = (snapshot2.timestamp - snapshot1.timestamp) / 1000; // Convert to seconds
                if (deltaTime > 0) {
                    instantSpeed = Math.hypot(deltaX, deltaY) / deltaTime;
                }
            } else if (player.snapshots.length > 0) {
                // Use most recent snapshot if no interpolation possible
                const latestSnapshot = player.snapshots[player.snapshots.length - 1];
                interpolatedX = latestSnapshot.x;
                interpolatedY = latestSnapshot.y;
                
                // Calculate speed from last two snapshots if available
                if (player.snapshots.length >= 2) {
                    const prevSnapshot = player.snapshots[player.snapshots.length - 2];
                    const deltaX = latestSnapshot.x - prevSnapshot.x;
                    const deltaY = latestSnapshot.y - prevSnapshot.y;
                    const deltaTime = (latestSnapshot.timestamp - prevSnapshot.timestamp) / 1000;
                    if (deltaTime > 0) {
                        instantSpeed = Math.hypot(deltaX, deltaY) / deltaTime;
                    }
                }
            }
            
            // Smooth the speed and update timing
            const baseSpeed = 220; // Normal movement speed
            const sprintThreshold = baseSpeed * 1.3; // Show trails when moving faster than normal
            const dtSec = Math.min(0.1, (now - player._lastTrailT) / 1000); // Real elapsed time, capped at 100ms
            player._lastTrailT = now;
            
            // Smooth the speed to reduce jitter
            player._smoothedSpeed = player._smoothedSpeed * 0.7 + instantSpeed * 0.3;
            
            // Fade existing trail points using real elapsed time
            for (let i = player._trailPoints.length - 1; i >= 0; i--) {
                const p = player._trailPoints[i];
                p.life -= dtSec;
                if (p.life <= 0) {
                    player._trailPoints.splice(i, 1);
                }
            }
            
            // Add new trail points based on distance traveled, not time
            if (player._smoothedSpeed > sprintThreshold) {
                const maxPoints = 26;
                const baseSpacing = 12;
                
                // Calculate distance traveled since last emission
                const distTraveled = Math.hypot(
                    interpolatedX - player._lastTrailEmitPos.x,
                    interpolatedY - player._lastTrailEmitPos.y
                );
                
                const speedFactor = Math.max(0.5, Math.min(2.5, player._smoothedSpeed / baseSpeed));
                const spacing = baseSpacing * (1 / speedFactor);
                
                // Emit trail points based on distance spacing
                if (distTraveled >= spacing) {
                    const numPoints = Math.floor(distTraveled / spacing);
                    for (let i = 0; i < numPoints; i++) {
                        const progress = (i + 1) / numPoints;
                        const emitX = player._lastTrailEmitPos.x + (interpolatedX - player._lastTrailEmitPos.x) * progress;
                        const emitY = player._lastTrailEmitPos.y + (interpolatedY - player._lastTrailEmitPos.y) * progress;
                        
                        player._trailPoints.push({ 
                            x: emitX, 
                            y: emitY, 
                            life: 1.2, 
                            max: 1.2 
                        });
                        if (player._trailPoints.length > maxPoints) {
                            player._trailPoints.shift();
                        }
                    }
                    player._lastTrailEmitPos = { x: interpolatedX, y: interpolatedY };
                }
            } else {
                // Update last position even when not emitting to avoid jumps
                player._lastTrailEmitPos = { x: interpolatedX, y: interpolatedY };
            }
            
            interpolatedPlayers.push({
                ...player,
                x: interpolatedX,
                y: interpolatedY,
                _instantSpeed: player._smoothedSpeed, // Use smoothed speed for consistent rendering
                _trailPoints: player._trailPoints
            });
        }
        
        return interpolatedPlayers;
    }
    
    lerp(a, b, t) {
        return a + (b - a) * t;
    }
    
    // Process proper server reconciliation with rollback
    processServerReconciliation(serverPlayer, lastProcessedInputSeq) {
        this.serverPosition = { x: serverPlayer.x, y: serverPlayer.y };
        
        // If no sequence acknowledgment, use simple reconciliation
        if (!lastProcessedInputSeq) {
            return this.applySimpleReconciliation();
        }
        
        // Find all unacknowledged inputs that need re-simulation
        const unackedInputs = [];
        for (const [seq, input] of this.inputBuffer) {
            if (seq > lastProcessedInputSeq) {
                unackedInputs.push(input);
            }
        }
        
        // Clear acknowledged inputs from buffer
        for (const [seq] of this.inputBuffer) {
            if (seq <= lastProcessedInputSeq) {
                this.inputBuffer.delete(seq);
            }
        }
        
        // Store rollback data for debugging
        if (window.gameDebugger && unackedInputs.length > 0) {
            window.gameDebugger.verbose('SYNC', `Rollback: ${unackedInputs.length} unacked inputs`, {
                lastProcessedSeq: lastProcessedInputSeq,
                currentSeq: this.inputSequence
            });
        }
        
        // Debug: Track server reconciliation
        if (window.gameDebugger) {
            window.gameDebugger.positionSync(
                window.player?.id || 'unknown',
                window.player ? { x: window.player.x, y: window.player.y } : { x: 0, y: 0 },
                serverPlayer,
                'server_reconciliation',
                lastProcessedInputSeq
            );
        }
        
        // Return smooth correction data instead of rollback to prevent stuttering
        // Use only distance threshold to avoid unnecessary micro-corrections
        return {
            serverPosition: this.serverPosition,
            unackedInputs: unackedInputs.sort((a, b) => a.sequence - b.sequence),
            needsCorrection: this.needsPositionCorrection()
        };
    }
    
    // Check if position correction is needed based on distance threshold
    needsPositionCorrection() {
        if (!this.lastLocalPosition || !this.serverPosition) return false;
        
        const dx = this.serverPosition.x - this.lastLocalPosition.x;
        const dy = this.serverPosition.y - this.lastLocalPosition.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        
        // Debug: Track position synchronization
        if (window.gameDebugger) {
            window.gameDebugger.positionSync(
                window.player?.id || 'unknown',
                this.lastLocalPosition,
                this.serverPosition,
                'correction_check',
                this.lastProcessedInputSeq
            );
        }
        
        // Only apply corrections if the distance is significant (> 5 pixels)
        return distance > 5;
    }
    
    // Fallback to simple reconciliation when server doesn't send sequence acks
    applySimpleReconciliation() {
        return {
            serverPosition: this.serverPosition,
            unackedInputs: [],
            needsCorrection: this.needsPositionCorrection()
        };
    }
    
    // Get interpolation factor for smoother other player movement
    getInterpolationFactor() {
        const now = Date.now();
        const timeSinceUpdate = now - this.lastServerUpdate;
        // Use 40ms as base interpolation window (25Hz feel)
        return Math.min(timeSinceUpdate / 40, 1.0);
    }
    
    // Notify server when scene changes
    notifySceneChange(scene, boundary) {
        if (!this.connected || !this.socket) {
            console.warn('[Network] Cannot notify scene change - not connected');
            return;
        }
        
        // Clear remote player/entity DOT effects when returning to lobby
        if (scene === 'lobby') {
            try {
                if (this.remoteBurningPlayers) this.remoteBurningPlayers.clear();
                if (this.remoteBurningEntities) this.remoteBurningEntities.clear();
                console.log('[Network] Cleared remote DOT effects for lobby transition');
            } catch(e) {
                console.error('[Network] Error clearing remote DOT effects:', e);
            }
        }
        
        console.log(`[Network] Notifying server of scene change: ${scene}, boundary: ${boundary}`);
        this.socket.emit('sceneChange', {
            scene: scene,
            boundary: boundary
        });
    }
    
    startReadyTimer() {
        if (!this.connected || !this.socket) {
            console.warn('[Network] Cannot start ready timer - not connected');
            return;
        }
        
        // Server uses its own authoritative level type - no need to send it
        console.log('[Network] Requesting server to start ready timer (server will use its authoritative level type)');
        this.socket.emit('readyTimerStart', {});
    }
    
    cancelReadyTimer() {
        if (!this.connected || !this.socket) {
            console.warn('[Network] Cannot cancel ready timer - not connected');
            return;
        }
        
        console.log('[Network] Requesting server to cancel ready timer');
        this.socket.emit('readyTimerCancel', {});
    }
    
    startExtractionTimer(timerType = 'normal') {
        if (!this.connected || !this.socket) {
            console.warn('[Network] Cannot start extraction timer - not connected');
            return;
        }
        
        console.log(`[Network] Requesting server to start ${timerType} extraction timer`);
        this.socket.emit('extractionTimerStart', { type: timerType });
    }
    
    cancelExtractionTimer() {
        if (!this.connected || !this.socket) {
            console.warn('[Network] Cannot cancel extraction timer - not connected');
            return;
        }
        
        console.log('[Network] Requesting server to cancel extraction timer');
        this.socket.emit('extractionTimerCancel', {});
    }
    
    getPlayerCount() {
        return this.otherPlayers.size + (this.connected ? 1 : 0);
    }
    
    getRoomInfo() {
        return {
            roomId: this.roomId,
            playerId: this.playerId,
            connected: this.connected,
            playerCount: this.getPlayerCount()
        };
    }
    
    // Send NPC damage to server (for hostile NPCs like Heretic Priest)
    sendNPCDamage(npcId, damage, noDamage = false) {
        if (!this.connected || !this.socket) {
            console.warn('[Network] Cannot send NPC damage - not connected');
            return;
        }
        
        if (!damage || damage <= 0) {
            console.warn('[Network] Invalid NPC damage amount:', damage);
            return;
        }
        
        console.log('[Network] Sending NPC damage to server:', npcId, damage);
        this.socket.emit('npcDamage', {
            npcId: npcId,
            damage: damage,
            noDamage: noDamage
        });
    }
    
    // Send NPC DOT to server (for Weapon 4 DOT application)
    sendNPCDot(npcId, dps, duration) {
        if (!this.connected || !this.socket) {
            console.warn('[Network] Cannot send NPC DOT - not connected');
            return;
        }
        
        if (!dps || dps <= 0) {
            console.warn('[Network] Invalid NPC DOT DPS amount:', dps);
            return;
        }
        
        if (!duration || duration <= 0) {
            console.warn('[Network] Invalid NPC DOT duration:', duration);
            return;
        }
        
        console.log('[Network] Sending NPC DOT to server:', npcId, { dps, duration });
        this.socket.emit('npcDot', {
            npcId: npcId,
            dps: dps,
            duration: duration
        });
    }
}

// Global network manager instance
window.networkManager = new NetworkManager();







