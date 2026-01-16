/**
 * ClientBootstrap.js
 * Handles all client initialization, world setup, and multiplayer connection
 * Extracted from main.js during Phase 3 refactoring
 */

// Hard-off debug build flag (performance): keep debug code in repo, but make it unreachable by default.
// Flip to `true` temporarily when you need deep debug overlays/logging.
if (typeof window !== 'undefined' && window.DEBUG_BUILD == null) {
    window.DEBUG_BUILD = false;
}

class ClientBootstrap {
    constructor() {
        this.canvas = null;
        this.ctx = null;
        this.worldInitialized = false;
        this.worldInitWatchdog = null;
        this.bootAttempts = 0;
        this.maxBootAttempts = 5;
        
        // Game object references (set during boot)
        this.player = null;
        this.environment = null;
        this.projectiles = null;
        this.enemies = null;
        this.director = null;
        this.ui = null;
        this.modeTimer = null;
        this.npcs = null;
        this.scene = null;
        this.chests = [];
        this.extractionZone = null;
        this.hereticExtractionZone = null;
        this.otherPlayers = [];
        
        // State reference (injected during initialization)
        this.state = null;
    }
    
    /**
     * Initialize canvas and context
     */
    initializeCanvas() {
        this.canvas = document.getElementById('game');
        if (!this.canvas) {
            console.error('[Bootstrap] Canvas #game not found in DOM!');
            return false;
        }
        
        this.ctx = this.canvas.getContext('2d');
        if (window.GameConstants?.DEBUG) {
            console.log('[Bootstrap] Canvas and context initialized:', { 
                canvas: this.canvas, 
                hasCtx: !!this.ctx 
            });
        }
        return true;
    }
    
    /**
     * Start watchdog timer for world initialization
     */
    startWorldInitWatchdog() {
        if (this.worldInitWatchdog) return;
        
        this.worldInitWatchdog = setInterval(() => {
            if (!this.worldInitialized && 
                window.networkManager && 
                window.networkManager.worldSeedReceived && 
                window.sceneManager) {
                
                console.log('[Bootstrap] Watchdog triggering world initialization with seed:', 
                    window.networkManager.worldSeed);
                this.initializeWorld(window.networkManager.worldSeed);
                
                if (this.worldInitialized && this.worldInitWatchdog) {
                    clearInterval(this.worldInitWatchdog);
                    this.worldInitWatchdog = null;
                    console.log('[Bootstrap] World init watchdog cleared - initialization complete');
                }
            }
        }, 500);
        
        console.log('[Bootstrap] World initialization watchdog started');
    }
    
    /**
     * Place player in a random safe location
     */
    placePlayerRandomly() {
        if (!this.environment || !this.worldInitialized) {
            console.log('[Bootstrap] Environment not ready, deferring player placement');
            return;
        }
        
        const tries = 400;
        const clearance = Math.max(30, this.player.radius + 24);
        const b = this.environment.boundary - clearance - 10;
        
        for (let i = 0; i < tries; i++) {
            const nx = (Math.random() * 2 - 1) * b;
            const ny = (Math.random() * 2 - 1) * b;
            
            if (!this.environment.circleHitsAny(nx, ny, clearance) && 
                this.environment.isInsideBounds(nx, ny, clearance)) {
                this.player.x = nx;
                this.player.y = ny;
                this.environment.spawnSafeX = nx;
                this.environment.spawnSafeY = ny;
                this.environment.spawnSafeRadius = Math.max(this.environment.spawnSafeRadius, clearance * 2);
                console.log('[Bootstrap] Player placed at:', {x: nx, y: ny});
                break;
            }
        }
    }
    
    /**
     * Spawn Merchant NPC in lobby
     */
    spawnLobbyMerchant() {
        try {
            if (this.scene.current !== 'lobby') return;
            if (!window.Merchant) return;
            if (!this.environment || !this.worldInitialized) {
                console.log('[Bootstrap] Environment not ready, deferring merchant spawn');
                return;
            }
            
            const r = 24;
            const b = this.environment.boundary;
            const x = 200;
            const y = -b + r + 80;
            let mx = x, my = y;
            
            if (!this.environment.isInsideBounds(mx, my, r) || 
                this.environment.circleHitsAny(mx, my, r)) {
                for (let dy = 100; dy <= 600; dy += 60) {
                    const ty = -b + r + 80 + dy;
                    if (this.environment.isInsideBounds(x, ty, r) && 
                        !this.environment.circleHitsAny(x, ty, r)) {
                        my = ty;
                        break;
                    }
                }
            }
            
            this.npcs.add(new window.Merchant(mx, my));
        } catch(_) {}
    }
    
    /**
     * Spawn Commander NPC in lobby
     */
    spawnLobbyCommander() {
        try {
            if (this.scene.current !== 'lobby') return;
            if (!window.Commander) return;
            if (!this.environment || !this.worldInitialized) {
                console.log('[Bootstrap] Environment not ready, deferring commander spawn');
                return;
            }
            
            const r = 24;
            const b = this.environment.boundary;
            const x = -b + r + 140;
            const y = 0;
            let cx = x, cy = y;
            
            if (!this.environment.isInsideBounds(cx, cy, r) || 
                this.environment.circleHitsAny(cx, cy, r)) {
                for (let step = 1; step <= 20; step++) {
                    const nx = x + step * 20;
                    if (this.environment.isInsideBounds(nx, y, r) && 
                        !this.environment.circleHitsAny(nx, y, r)) {
                        cx = nx;
                        cy = y;
                        break;
                    }
                }
            }
            
            this.npcs.add(new window.Commander(cx, cy));
        } catch(_) {}
    }

    /**
     * Spawn Quartermaster NPC in lobby (near training lane sandbags)
     */
    spawnLobbyQuartermaster() {
        try {
            if (this.scene.current !== 'lobby') return;
            if (!window.Quartermaster) return;
            if (!this.environment || !this.worldInitialized) {
                console.log('[Bootstrap] Environment not ready, deferring quartermaster spawn');
                return;
            }
            
            const r = 24;
            const x = -307;
            const y = -534;
            let qx = x, qy = y;
            
            if (!this.environment.isInsideBounds(qx, qy, r) || 
                this.environment.circleHitsAny(qx, qy, r)) {
                const candidates = [];
                for (let step = 0; step <= 18; step++) {
                    const dx = step * 18;
                    const dy = step * 14;
                    candidates.push({ x: x + dx, y: y });
                    candidates.push({ x: x + dx, y: y + dy });
                    candidates.push({ x: x + dx, y: y - dy });
                    candidates.push({ x: x - dx, y: y + dy });
                }
                for (let i = 0; i < candidates.length; i++) {
                    const c = candidates[i];
                    if (this.environment.isInsideBounds(c.x, c.y, r) && 
                        !this.environment.circleHitsAny(c.x, c.y, r)) {
                        qx = c.x;
                        qy = c.y;
                        break;
                    }
                }
            }
            
            this.npcs.add(new window.Quartermaster(qx, qy));
        } catch(_) {}
    }
    
    // Target dummy removed. Lobby training dummy is spawned by server as a normal enemy (type: targetDummy).
    
    /**
     * Initialize the world once seed is received from server
     */
    initializeWorld(seed) {
        if (window.sceneManager) {
            const newEnv = window.sceneManager.initializeWorld(
                seed, 
                this.environment, 
                this.enemies, 
                this.director, 
                this.player, 
                this.npcs
            );
            
            if (newEnv) {
                this.environment = newEnv;
                window.environment = newEnv; // Keep global in sync
                this.worldInitialized = window.sceneManager.worldInitialized;
            }
        }
    }
    
    /**
     * Initialize multiplayer networking
     */
    initializeMultiplayer() {
        if (typeof window.networkManager === 'undefined') {
            console.error('[Bootstrap] Network manager not available - cannot start game');
            alert('Failed to load network manager. Please refresh the page.');
            return;
        }
        
        console.log('[Bootstrap] Initializing multiplayer networking');
        
        // Set up network event handlers
        window.networkManager.onConnected = () => {
            window.gameDebugger.networkConnect(
                window.networkManager.playerId, 
                window.networkManager.roomId
            );
        };
        
        window.networkManager.onDisconnected = (reason) => {
            window.gameDebugger.networkDisconnect(window.networkManager.playerId, reason);
            this.otherPlayers = [];
        };
        
        window.networkManager.onGameStateUpdate = (gameState) => {
            // Sync ground items for late joiners
            if (Array.isArray(gameState.groundItems) && window.GameObjects && window.GameObjects.HexStat) {
                if (!Array.isArray(window.bossDrops)) window.bossDrops = [];
                const existingIds = new Set(
                    window.bossDrops.filter(item => item._serverId).map(item => item._serverId)
                );
                
                for (const item of gameState.groundItems) {
                    if (!existingIds.has(item.id)) {
                        const HexStat = window.GameObjects.HexStat;
                        const rarity = { name: item.rarityName, color: item.color };
                        const hexStat = new HexStat(item.x, item.y, item.vx, item.vy, { 
                            label: item.label, 
                            fill: rarity.color, 
                            rarity: rarity 
                        });
                        hexStat.onGround = false;
                        hexStat._serverId = item.id;
                        window.bossDrops.push(hexStat);
                    }
                }
            }
            
            // Server reconciliation
            const serverPlayer = gameState.players ? 
                gameState.players.find(p => p.id === window.networkManager.playerId) : null;
            
            if (serverPlayer) {
                try {
                    window.networkManager.serverPosition = { x: serverPlayer.x, y: serverPlayer.y };

                    // --- DEBUG: capture server-driven position changes (so '-' overlay works even when env collision didn't run)
                    const __dbgBefore = { x: this.player.x, y: this.player.y };
                    let __dbgReason = 'reconcile';
                    
                    // If player has knockback, skip prediction and use server position directly
                    if (serverPlayer.kbTime && serverPlayer.kbTime > 0) {
                        __dbgReason = 'knockback';
                        console.log(`[Client] Knockback detected! kbTime=${serverPlayer.kbTime}, kbVel=(${serverPlayer.kbVelX}, ${serverPlayer.kbVelY})`);
                        
                        // Apply knockback state to local player
                        this.player.kbTime = serverPlayer.kbTime;
                        this.player.kbVelX = serverPlayer.kbVelX || 0;
                        this.player.kbVelY = serverPlayer.kbVelY || 0;
                        
                        // Use direct server position during knockback (no prediction)
                        const interpSpeed = 0.8; // Fast sync for responsive knockback
                        this.player.x = window.networkManager.lerp(this.player.x, serverPlayer.x, interpSpeed);
                        this.player.y = window.networkManager.lerp(this.player.y, serverPlayer.y, interpSpeed);
                        
                        console.log(`[Client] Applied knockback to local player, syncing to server pos (${serverPlayer.x.toFixed(1)}, ${serverPlayer.y.toFixed(1)})`);
                    }
                    // If player is ensnared, skip prediction and use direct smooth interpolation
                    else if (this.player._ensnaredTimer && this.player._ensnaredTimer > 0) {
                        __dbgReason = 'ensnare';
                        // Use fast, smooth interpolation directly to server position (like remote players)
                        const interpSpeed = 0.5; // Higher = faster sync, smoother pull
                        this.player.x = window.networkManager.lerp(this.player.x, serverPlayer.x, interpSpeed);
                        this.player.y = window.networkManager.lerp(this.player.y, serverPlayer.y, interpSpeed);
                    } else {
                        __dbgReason = 'reconcile';
                        // Normal prediction reconciliation
                        const reconciliation = window.networkManager.processServerReconciliation(
                            serverPlayer,
                            gameState.lastProcessedInputSeq || 0
                        );
                        
                        if (reconciliation && reconciliation.needsCorrection) {
                            const correctionSpeed = 0.2;
                            this.player.x += (reconciliation.serverPosition.x - this.player.x) * correctionSpeed;
                            this.player.y += (reconciliation.serverPosition.y - this.player.y) * correctionSpeed;
                        } else if (reconciliation) {
                            const distance = Math.sqrt(
                                Math.pow(this.player.x - reconciliation.serverPosition.x, 2) + 
                                Math.pow(this.player.y - reconciliation.serverPosition.y, 2)
                            );
                            
                            if (distance > 10) {
                                const correctionFactor = Math.min(distance / 50, 0.3);
                                this.player.x = window.networkManager.lerp(
                                    this.player.x, 
                                    reconciliation.serverPosition.x, 
                                    correctionFactor
                                );
                                this.player.y = window.networkManager.lerp(
                                    this.player.y, 
                                    reconciliation.serverPosition.y, 
                                    correctionFactor
                                );
                            }
                        }
                    }

                    // After any server-driven adjustment, record a debug "collision" so '-' overlay can show it
                    try {
                        const ax = this.player.x, ay = this.player.y;
                        const dx = ax - __dbgBefore.x;
                        const dy = ay - __dbgBefore.y;
                        const d2 = dx * dx + dy * dy;

                        // Prefer server-authoritative blocker report when available
                        const serverBlockedBy = serverPlayer && serverPlayer.blockedBy ? serverPlayer.blockedBy : null;

                        // Compute intended movement direction from live input (to filter out harmless reconciliation drift)
                        let wantsMove = false;
                        let inVX = 0, inVY = 0;
                        try {
                            const keys = window.state && window.state.keys ? window.state.keys : null;
                            if (keys) {
                                if (keys.KeyW) inVY -= 1;
                                if (keys.KeyS) inVY += 1;
                                if (keys.KeyA) inVX -= 1;
                                if (keys.KeyD) inVX += 1;
                                wantsMove = (inVX !== 0 || inVY !== 0);
                                const mag = Math.hypot(inVX, inVY) || 1;
                                inVX /= mag; inVY /= mag;
                            }
                        } catch(_) {}

                        // Track repeated opposing corrections as "blocked" (not just normal drift)
                        if (!window._serverCorrTrack) window._serverCorrTrack = { opposeTime: 0, opposeDist: 0, lastT: 0 };
                        const tr = window._serverCorrTrack;
                        const nowT = Date.now();
                        const dt = tr.lastT ? Math.min(0.05, Math.max(0.0, (nowT - tr.lastT) / 1000)) : 0.016;
                        tr.lastT = nowT;

                        const corrMag = Math.hypot(dx, dy);
                        const dot = (wantsMove && corrMag > 1e-6) ? ((dx / corrMag) * inVX + (dy / corrMag) * inVY) : 0;
                        const opposing = wantsMove && corrMag > 0.25 && (dot < -0.35);

                        if (opposing) {
                            tr.opposeTime += dt;
                            tr.opposeDist += corrMag;
                        } else {
                            // decay quickly when not opposing
                            tr.opposeTime = Math.max(0, tr.opposeTime - dt * 2.5);
                            tr.opposeDist = Math.max(0, tr.opposeDist - corrMag * 1.5);
                        }

                        const blockedHeuristic = (tr.opposeTime > 0.16 && tr.opposeDist > 1.2);

                        // Only record when: server reports a block OR our heuristic says this is a real "wall feel"
                        if (serverBlockedBy || blockedHeuristic) {
                            const hits = [];
                            if (serverBlockedBy) {
                                hits.push({ kind: 'serverBlockedBy', t: serverBlockedBy.t || nowT });
                                if (Array.isArray(serverBlockedBy.hits)) {
                                    for (let i = 0; i < serverBlockedBy.hits.length && hits.length < 16; i++) {
                                        hits.push(serverBlockedBy.hits[i]);
                                    }
                                }
                            } else {
                                hits.push({
                                    kind: 'serverCorrection',
                                    reason: __dbgReason,
                                    dx, dy,
                                    serverX: serverPlayer.x,
                                    serverY: serverPlayer.y
                                });
                            }

                            // Try to identify *candidate* colliders near the corrected position (best-effort)
                            const env = window.environment;
                            const r = this.player.radius || 26;

                            // Candidates: static obstacles
                            if (env && Array.isArray(env.obstacles) && typeof env._circleIntersectsRect === 'function') {
                                for (let i = 0; i < env.obstacles.length; i++) {
                                    const ob = env.obstacles[i];
                                    if (!ob) continue;
                                    if (env._circleIntersectsRect(ax, ay, r, ob)) {
                                        hits.push({ kind: 'aabb', phase: 'serverAfter', index: i, type: ob.type, temporary: ob.temporary === true, x: ob.x, y: ob.y, w: ob.w, h: ob.h });
                                        if (hits.length > 12) break;
                                    }
                                }
                            }

                            // Candidates: oriented boxes
                            if (env && Array.isArray(env.orientedBoxes) && typeof env._circleIntersectsOrientedBox === 'function') {
                                for (let i = 0; i < env.orientedBoxes.length; i++) {
                                    const box = env.orientedBoxes[i];
                                    if (!box) continue;
                                    if (env._circleIntersectsOrientedBox(ax, ay, r, box)) {
                                        hits.push({ kind: 'obox', phase: 'serverAfter', index: i, x: box.x, y: box.y, w: box.w, h: box.h, angle: box.angle || 0, isTrenchWall: !!box.isTrenchWall, hazardType: box._hazardType || null, hazardId: box._hazardId || null, abilityId: box._abilityId || null });
                                        if (hits.length > 20) break;
                                    }
                                }
                            }

                            // Candidates: enemies (crowd-blocking feels like walls)
                            const list = window.enemies?.items;
                            if (Array.isArray(list)) {
                                for (let i = 0; i < list.length; i++) {
                                    const e = list[i];
                                    if (!e || e.alive === false) continue;
                                    const er = e.radius || 26;
                                    const rr = r + er;
                                    const ex = e.x - ax, ey = e.y - ay;
                                    if (ex * ex + ey * ey <= rr * rr) {
                                        hits.push({ kind: 'enemy', id: e.id, type: e.type, x: e.x, y: e.y, r: er });
                                        if (hits.length > 28) break;
                                    }
                                }
                            }

                            window._lastPlayerCollision = {
                                t: Date.now(),
                                before: __dbgBefore,
                                intended: null,
                                resolved: { x: ax, y: ay },
                                hits
                            };
                        }
                    } catch (_) {}
                } catch (error) {
                    console.warn('[Bootstrap] Error in server reconciliation:', error);
                    const distance = Math.sqrt(
                        Math.pow(this.player.x - serverPlayer.x, 2) + 
                        Math.pow(this.player.y - serverPlayer.y, 2)
                    );
                    
                    if (distance > 50) {
                        const correctionFactor = Math.min(distance / 100, 0.5);
                        this.player.x = window.networkManager.lerp(
                            this.player.x, 
                            serverPlayer.x, 
                            correctionFactor
                        );
                        this.player.y = window.networkManager.lerp(
                            this.player.y, 
                            serverPlayer.y, 
                            correctionFactor
                        );
                    }
                }
            }
        };
        
        window.networkManager.onPlayerJoined = (playerData) => {
            window.gameDebugger.playerJoin(playerData.id, 
                { x: playerData.x, y: playerData.y }, 
                {
                    roomId: window.networkManager.roomId,
                    playerCount: this.otherPlayers.length + 1
                }
            );
        };
        
        window.networkManager.onPlayerLeft = (data) => {
            window.gameDebugger.playerLeave(data.id, {
                roomId: window.networkManager.roomId,
                playerCount: this.otherPlayers.length
            });
        };
        
        // Handle world seed from server
        window.networkManager.onWorldSeedReceived = (seed) => {
            console.log('[Bootstrap] Received world seed from server, initializing world:', seed);
            try {
                this.initializeWorld(seed);
                // CRITICAL: Notify main.js that environment was updated
                if (this.onEnvironmentReady) {
                    this.onEnvironmentReady(this.environment, this.worldInitialized);
                }
            } catch (error) {
                console.error('[Bootstrap] Error initializing world:', error);
            }
        };
        
        // Connect to server
        try {
            if (typeof window.io === 'undefined') {
                console.error('[Bootstrap] socket.io not available - cannot start multiplayer game');
                alert('Failed to load socket.io. Please refresh the page.');
                return;
            }
            
            console.log('[Bootstrap] Connecting to multiplayer server...');
            window.networkManager.connect();
        } catch (error) {
            console.error('[Bootstrap] Error connecting to server:', error);
            alert('Failed to connect to multiplayer server. Please check your connection and refresh.');
        }
    }
    
    /**
     * Main bootstrap function - initializes all game systems
     */
    boot() {
        console.log('[Bootstrap] Boot function starting - checking dependencies');
        
        // Check for required dependencies
        const deps = {
            Player: window.Player,
            Weapons: window.Weapons, 
            Enemies: window.Enemies,
            Environment: window.Environment,
            EnvironmentLobby: window.EnvironmentLobby,
            Director: window.Director,
            UI: window.UI,
            Mode: window.Mode || window.ModeTimer,
            NPCs: window.NPCs
        };
        
        const missing = Object.entries(deps)
            .filter(([name, cls]) => !cls)
            .map(([name]) => name);
        
        if (missing.length > 0) {
            console.error('[Bootstrap] Missing dependencies:', missing, 'retrying in 500ms...');
            return this.scheduleRetry();
        }
        
        console.log('[Bootstrap] All dependencies loaded, initializing game...');
        
        try {
            // Initialize new modules
            window.multiplayerRenderer = new MultiplayerRenderer();
            window.sceneManager = new SceneManager();
            this.scene = window.sceneManager.scene;
            this.chests = window.sceneManager.chests;
            
            // Create camera
            window.camera = new Camera(this.state);
            
            // Create input manager
            window.inputManager = new InputManager(this.state);
            
            // Initialize object pools
            if (typeof window.initializeObjectPools === 'function') {
                window.initializeObjectPools();
                console.log('[Bootstrap] Object pools initialized successfully');
            } else {
                console.warn('[Bootstrap] Object pools not available - running without pooling');
            }
            
            // Create game objects
            this.player = new Player(0, 0);
            this.projectiles = new Weapons();
            this.enemies = new Enemies();
            this.npcs = new NPCs();
            this.ui = new UI();
            this.modeTimer = new (window.Mode || window.ModeTimer)();
            
            // Expose globally
            window.projectiles = this.projectiles;
            window.enemies = this.enemies;
            window.npcs = this.npcs;
            window.player = this.player;
            window.environment = this.environment;
            window.scene = this.scene;
            window.modeTimer = this.modeTimer;
            
            // Dialogue UI
            this.dialogue = new DialogueBox();
            this.dialogueLoader = new (window.DialogueLoader || 
                function(){ return class { async load(){ return null; } } })();
            
            // Expose dialogue UI globally (used by shop + networking)
            window.dialogueBox = this.dialogue;
            
            // CRITICAL: Expose globally for NPCs to load dialogue
            window.dialogueLoader = this.dialogueLoader;
            
            // Bridge for DialogueBox to trigger NPC actions
            window.onNpcDialogueAction = (effect, ctx) => {
                try {
                    if (!effect || !effect.type || effect.type !== 'npcAction') return;
                    
                    // Get NPC ID from context or dialogue
                    const npcId = (ctx && ctx.npcId != null) ? ctx.npcId : 
                        (window.dialogueLoader && window.dialogueLoader.dialogue && window.dialogueLoader.dialogue.npcId != null 
                            ? window.dialogueLoader.dialogue.npcId : null);
                    if (npcId == null) return;
                    
                    // CRITICAL: Use window.npcs to ensure we always have the current NPC list
                    if (!window.npcs || !window.npcs.items) return;
                    
                    let npc = null;
                    for (let i = 0; i < window.npcs.items.length; i++) {
                        const n = window.npcs.items[i];
                        if (n && n.id === npcId) {
                            npc = n;
                            break;
                        }
                    }
                    
                    // Fallback: nearest NPC_A if specific NPC not found
                    if (!npc) {
                        for (let i = 0; i < window.npcs.items.length; i++) {
                            const n = window.npcs.items[i];
                            if (n && n.name === 'NPC_A') {
                                npc = n;
                                break;
                            }
                        }
                    }
                    
                    // Parse action string
                    const actRaw = String(effect.action || effect.value || effect.state || '').toLowerCase();
                    const act = (actRaw === 'default' || actRaw === 'idle') ? 'idle' : actRaw;

                    // Quartermaster: server-authoritative requisition reward
                    if (act === 'grant_supplies' || act === 'grant_blood') {
                        try {
                            if (window.networkManager?.connected && window.networkManager.socket) {
                                window.networkManager.socket.emit('quartermasterRequisition', {
                                    npcId: npcId,
                                    action: act
                                });
                            }
                        } catch(_) {}
                        return;
                    }
                    
                    if (!npc || typeof npc.switchState !== 'function') return;
                    
                    // Map and trigger state change
                    if (act === 'follow') npc.switchState('follow');
                    else if (act === 'hostile' || act === 'attack_player') npc.switchState('hostile');
                    else if (act === 'run_to_boss' || act === 'attack_boss') npc.switchState('run_to_boss');
                    else npc.switchState(act);
                    
                    console.log('[Bootstrap] NPC action triggered:', { npcId, action: act, npcName: npc.name });
                } catch(err) {
                    console.error('[Bootstrap] Error in onNpcDialogueAction:', err);
                }
            };
            
            console.log('[Bootstrap] Modules constructed');
            
            // Initialize multiplayer
            this.initializeMultiplayer();
            
            // Check if seed already received
            if (window.networkManager && 
                window.networkManager.worldSeedReceived && 
                !this.worldInitialized) {
                console.log('[Bootstrap] Found existing world seed, initializing world immediately');
                this.initializeWorld(window.networkManager.worldSeed);
            }
            
            console.log('[Bootstrap] Bootstrap completed successfully');
            
            // Start world init watchdog
            this.startWorldInitWatchdog();
            
            // Return success flag
            return true;
            
        } catch (error) {
            console.error('[Bootstrap] Fatal error during bootstrap:', error);
            this.scheduleRetry();
            return false;
        }
    }
    
    /**
     * Schedule a retry if bootstrap fails
     */
    scheduleRetry() {
        if (this.bootAttempts < this.maxBootAttempts) {
            this.bootAttempts++;
            console.log(`[Bootstrap] Retry attempt ${this.bootAttempts}/${this.maxBootAttempts} in 500ms`);
            setTimeout(() => this.boot(), 500);
        } else {
            console.error('[Bootstrap] Bootstrap failed after 5 attempts, giving up');
        }
    }
    
    /**
     * Main initialization entry point - returns true if successful, false otherwise
     */
    initialize(state, onComplete) {
        this.state = state;
        this.onComplete = onComplete; // Callback to start game loop
        console.log('[Bootstrap] DOM ready, initializing...');
        
        // First initialize canvas
        if (!this.initializeCanvas()) {
            console.error('[Bootstrap] Failed to initialize canvas, retrying in 100ms...');
            setTimeout(() => this.initialize(state, onComplete), 100);
            return false;
        }
        
        // Then start bootstrap
        try {
            const success = this.boot();
            if (success && onComplete) {
                // Call completion callback to start game loop
                onComplete(this);
            }
            return success;
        } catch (error) {
            console.error('[Bootstrap] Fatal error during initial boot:', error);
            this.scheduleRetry();
            return false;
        }
    }
}

// Export as global
window.ClientBootstrap = ClientBootstrap;

console.log('[ClientBootstrap.js] ✅ Module loaded and ClientBootstrap exported');

