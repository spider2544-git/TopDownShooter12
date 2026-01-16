/**
 * PlayerManager - Manages player lifecycle, stats, and spawning for GameRoom
 * 
 * Extracted from GameRoom (Phase 4 of incremental manager extraction)
 * 
 * Handles:
 * - Player join/leave (addPlayer, removePlayer)
 * - Stats recalculation from inventory items
 * - Spawn position generation with exclusion zones
 * - Room snapshot generation for new players
 */

// Import dependencies
const { SeededRNG } = require('../core/seededRNG.js');

class PlayerManager {
    /**
     * @param {GameRoom} room - Reference to the parent GameRoom for state access
     * @param {SocketIO} io - Socket.io instance for broadcasts
     */
    constructor(room, io) {
        this.room = room;
        this.io = io;
        
        // Get DEBUG_BUILD from global
        this.DEBUG_BUILD = global.DEBUG_BUILD || false;
    }

    // =========================================
    // PLAYER LIFECYCLE METHODS
    // =========================================

    addPlayer(socket, playerData) {
        // Get spawn position based on scene and game mode
        let spawnPos = { x: 0, y: 0 };
        if (this.room.scene === 'level') {
            // Check if game mode has custom spawn logic (e.g., trench raid left-side spawn)
            if (this.room.currentGameMode && typeof this.room.currentGameMode.getPlayerSpawnPosition === 'function') {
                // Create RNG instance for spawn position
                const spawnSeed = this.room.worldSeed + socket.id.charCodeAt(0);
                const rng = new SeededRNG(spawnSeed);
                spawnPos = this.room.currentGameMode.getPlayerSpawnPosition(this.room.environment, rng);
                console.log(`[Server] Using mode-specific spawn for ${socket.id}: (${spawnPos.x.toFixed(0)}, ${spawnPos.y.toFixed(0)})`);
            } else {
                // Fallback: random position in bounds
                const spawnSeed = this.room.worldSeed + socket.id.charCodeAt(0) + Date.now();
                spawnPos = this.generateRandomSpawnPosition(spawnSeed);
                console.log(`[Server] Using random spawn for ${socket.id}: (${spawnPos.x.toFixed(0)}, ${spawnPos.y.toFixed(0)})`);
            }
        }
        
        const player = {
            id: socket.id,
            x: spawnPos.x,
            y: spawnPos.y,
            radius: playerData.radius || 20,
            // Base stats (modified by inventory)
            baseSpeed: 220,
            baseHealthMax: 100,
            baseStaminaMax: 100,
            speed: 220,
            health: 100,
            healthMax: 100,
            aimAngle: 0,
            lastInput: null,
            socket: socket,
            // Server-authoritative stamina system
            stamina: 100,
            staminaMax: 100,
            staminaDrainPerSecond: 10,
            staminaRechargePerSecond: 20,
            exhaustionTimer: 0,
            exhaustionCooldownSeconds: 4,
            mustReleaseShift: false,
            mustReleaseFire: false,
            isFiringWeapon4: false,
            // Dash system
            dashCooldown: 0,
            dashCooldownMax: 0.3,
            dashActive: false,
            dashDuration: 0,
            dashMaxDuration: 0.2,
            dashStaminaCost: 45,
            dashSpeedMultiplier: 6.4,
            // Ensnare state (Licker tentacle)
            _ensnaredTimer: 0,
            _ensnaredById: null,
            _ensnaredBy: new Map(),
            // Debug/cheat state
            invincible: false,
            // Temporary invulnerability bookkeeping
            _invulnSources: 0,
            _manualInvincible: false,
            _dashInvuln: false,
            // Evil/conversion state (for PvP friendly fire)
            isEvil: false,
            // Inventory and derived stats
            inventory: [],
            // Base armor is also applied in recalculatePlayerStats; keep this non-zero for first-frame behavior.
            armor: 30,
            attackSpeed: 1.0,
            attackPower: 0,
            // Base crit chance is 5% (matches client baseline)
            critChance: 0.05,
            critDamageMultiplier: 1.2,
            baseCritChance: 0.05,
            baseCritDamageMultiplier: 1.2,
            _lastEligibleHealthBonus: 0,
            // Currency wallet
            ducats: 0,
            bloodMarkers: 0,
            victoryPoints: 0,
            // Loot progression
            lootLevel: 0,
            // Cosmetics
            equippedHat: null,
            equippedSkin: null,
            // Revive system
            downedAt: 0,              // ms timestamp when player went down (health hit 0)
            reviveWindowRemainingMs: 0, // remaining ms to START a revive (pauses while being revived, freezes once ready)
            reviveReadyUntil: 0,       // ms timestamp until which the Revive button is enabled
            reviveReadyFromId: null,   // reviver who completed the 4s channel
            _respawnRequested: false,   // once true, block revive accept/offers
            // Breadcrumb trail system
            breadcrumbs: [],           // Array of {x, y} positions forming the trail
            totalDistanceMoved: 0,     // Total distance moved (must reach 100 before breadcrumbs start)
            lastBreadcrumbX: spawnPos.x, // Last position where breadcrumb was added
            lastBreadcrumbY: spawnPos.y
        };
        // FIXED: Players should join the room's current scene, not override it
        // Room scene is controlled by ready timer and explicit scene changes only
        // No individual player can override the room's scene during join
        
        // Note: Player joins the room's current scene and boundary
        console.log(`Player ${socket.id} joining room ${this.room.id} (scene: ${this.room.scene}, boundary: ${this.room.boundary})`);
        
        this.room.players.set(socket.id, player);
        console.log(`Player ${socket.id} joined room ${this.room.id} (scene: ${this.room.scene}, boundary: ${this.room.boundary})`);
        
        // Send world seed immediately to new player for synchronized world generation
        socket.emit('worldSeed', { seed: this.room.worldSeed });
        console.log(`[SEED] Sent world seed ${this.room.worldSeed} to player ${socket.id} in room ${this.room.id}`);
        
        // Ensure lobby training dummy exists (implemented as a normal enemy)
        if (this.room.scene === 'lobby') {
            try { this.room.spawnLobbyTargetDummy(); } catch(_) {}
        }
        
        // Auto-spawn ambient NPCs if in lobby scene and none exist
        if (this.room.scene === 'lobby' && this.room.ambientNpcs.length === 0) {
            console.log(`[AMBIENT_NPCs] Auto-spawning ambient NPCs for lobby`);
            this.room.spawnLobbyAmbientNpcs();
        }
        
        // Send full room snapshot and initial game state to new player
        this.sendRoomSnapshot(socket);
        socket.emit('gameState', this.room.getGameState());
        
        // Notify other players of new player
        socket.to(this.room.id).emit('playerJoined', {
            id: socket.id,
            x: player.x,
            y: player.y,
            radius: player.radius,
            health: player.health,
            healthMax: player.healthMax,
            isEvil: player.isEvil || false
        });
    }
    
    // Server-side stat recalculation from inventory (mirrors client logic)
    recalculatePlayerStats(player) {
        if (!player) return;
        
        const prevMax = player.healthMax;
        const prevStaminaMax = player.staminaMax || player.baseStaminaMax || 100;
        let healthFlatBonus = 0;
        let eligibleHealthFlatBonus = 0;
        let staminaFlatBonus = 0;
        let movSpdPercent = 0;
        // Base armor is 30%. Inventory adds on top.
        let armorPercent = 30;
        let atkSpdPercent = 0;
        let atkPwrFlat = 0;
        let critChancePercent = 0;
        let critDmgPercent = 0;
        
        try {
            if (Array.isArray(player.inventory)) {
                if (this.DEBUG_BUILD) console.log(`[Server] recalculatePlayerStats: Processing ${player.inventory.length} items for ${player.id}`);
                for (let i = 0; i < player.inventory.length; i++) {
                    const item = player.inventory[i];
                    if (!item) continue;
                    
                    if (this.DEBUG_BUILD) console.log(`[Server]   Item ${i}: ${item.label} | statKey=${item.statKey}, bonusValue=${item.bonusValue}, isPercent=${item.isPercent}`);
                    
                    if (item.statKey === 'Health') {
                        let add = Number(item.bonusValue) || 0;
                        if (item.isPercent) {
                            add = Math.round((player.baseHealthMax || 100) * (add / 100));
                        }
                        if (this.DEBUG_BUILD) console.log(`[Server]   -> Health item adds ${add} (flat bonus now: ${healthFlatBonus + add})`);
                        healthFlatBonus += add;
                        if (!item.suppressHealForPlayerId || item.suppressHealForPlayerId !== player.id) {
                            eligibleHealthFlatBonus += add;
                        }
                    }
                    if (item.statKey === 'Stamina') {
                        let addS = Number(item.bonusValue) || 0;
                        if (item.isPercent) {
                            addS = Math.round((player.baseStaminaMax || 100) * (addS / 100));
                        }
                        staminaFlatBonus += addS;
                    }
                    if (item.statKey === 'MovSpd') {
                        let addMS = Number(item.bonusValue) || 0;
                        if (item.isPercent) {
                            movSpdPercent += addMS;
                        } else {
                            const base = player.baseSpeed || 220;
                            if (base > 0) movSpdPercent += (addMS / base) * 100;
                        }
                    }
                    if (item.statKey === 'Armor') {
                        const addA = Number(item.bonusValue) || 0;
                        armorPercent += addA;
                    }
                    if (item.statKey === 'AtkSpd') {
                        const addAS = Number(item.bonusValue) || 0;
                        atkSpdPercent += addAS;
                    }
                    if (item.statKey === 'AtkPwr') {
                        const addAP = Number(item.bonusValue) || 0;
                        atkPwrFlat += addAP;
                    }
                    if (item.statKey === 'CritChance') {
                        const addCC = Number(item.bonusValue) || 0;
                        critChancePercent += addCC;
                    }
                    if (item.statKey === 'CritDmg') {
                        const addCM = Number(item.bonusValue) || 0;
                        critDmgPercent += addCM;
                    }
                }
            }
        } catch (_) {}
        
        // Apply calculated values
        if (this.DEBUG_BUILD) console.log(`[Server] Applying stats: baseHealthMax=${player.baseHealthMax}, healthFlatBonus=${healthFlatBonus}`);
        // Cap healthMax at 300 (same as stamina)
        const rawHealthMax = Math.max(1, (player.baseHealthMax || 100) + healthFlatBonus);
        player.healthMax = Math.min(300, rawHealthMax);
        if (this.DEBUG_BUILD) console.log(`[Server] New healthMax = ${player.healthMax} (raw: ${rawHealthMax}, capped at 300)`);
        
        // Grant immediate health for all eligible items (suppressHealForPlayerId already prevents duplicate healing)
        if (eligibleHealthFlatBonus > 0) {
            if (this.DEBUG_BUILD) console.log(`[Server] Granting ${eligibleHealthFlatBonus} immediate health (new total: ${player.health + eligibleHealthFlatBonus})`);
            player.health += eligibleHealthFlatBonus;
            // Mark all HP items in inventory as having healed this player (case-insensitive check)
            for (let i = 0; i < player.inventory.length; i++) {
                const item = player.inventory[i];
                if (item && item.statKey && item.statKey.toLowerCase() === 'health' && !item.isPercent) {
                    if (!item.suppressHealForPlayerId || item.suppressHealForPlayerId !== player.id) {
                        item.suppressHealForPlayerId = player.id;
                        if (this.DEBUG_BUILD) console.log(`[Server] Marked ${item.label} as healed for player ${player.id}`);
                    }
                }
            }
        }
        
        // Clamp current health to healthMax
        if (player.health > player.healthMax) player.health = player.healthMax;
        
        const rawStaminaMax = Math.max(1, (player.baseStaminaMax || 100) + staminaFlatBonus);
        player.staminaMax = Math.min(300, rawStaminaMax);
        if (player.staminaMax > prevStaminaMax) {
            player.stamina += (player.staminaMax - prevStaminaMax);
        }
        if (player.stamina > player.staminaMax) player.stamina = player.staminaMax;
        
        const baseSpd = player.baseSpeed || 220;
        const totalMovPct = Math.max(0, movSpdPercent);
        player.speed = Math.min(375, baseSpd * (1 + totalMovPct / 100));
        
        // Cap armor at 150% (damage reduction is separately capped at 75% in combat code)
        player.armor = Math.max(0, Math.min(150, armorPercent));
        
        // Cap attack speed at 3x (200% bonus)
        const rawAtkSpd = 1 + atkSpdPercent / 100;
        player.attackSpeed = Math.max(0.1, Math.min(3.0, rawAtkSpd));
        
        // Cap attack power at 150 flat bonus
        player.attackPower = Math.max(0, Math.min(150, atkPwrFlat));
        
        const baseCc = (player.baseCritChance != null) ? player.baseCritChance : 0;
        const baseCm = (player.baseCritDamageMultiplier != null) ? player.baseCritDamageMultiplier : 1.2;
        const ccAdd = Math.max(0, critChancePercent) / 100;
        player.critChance = Math.max(0, Math.min(1, baseCc + ccAdd));
        
        // Cap crit damage multiplier at 5x (400% bonus on top of base 120%)
        const rawCritDmgMul = baseCm * (1 + Math.max(0, critDmgPercent) / 100);
        player.critDamageMultiplier = Math.max(1, Math.min(5.0, rawCritDmgMul));
        
        if (this.DEBUG_BUILD) console.log(`[Server] Recalculated stats for ${player.id}: HP=${player.healthMax}, Spd=${player.speed.toFixed(0)}, Armor=${player.armor}%, AtkSpd=${player.attackSpeed.toFixed(2)}x, CC=${(player.critChance*100).toFixed(0)}%, CD=${(player.critDamageMultiplier*100).toFixed(0)}%`);
    }
    
    removePlayer(socketId) {
        if (this.room.players.has(socketId)) {
            const player = this.room.players.get(socketId);
            
            // Drop any battery the player was carrying
            if (this.room.batteries) {
                for (const [batteryId, battery] of this.room.batteries) {
                    if (battery.carriedBy === socketId) {
                        battery.carriedBy = null;
                        battery.x = player ? player.x : battery.x;
                        battery.y = player ? player.y : battery.y;
                        battery.onGround = true;
                        
                        this.io.to(this.room.id).emit('batteryDropped', {
                            batteryId: batteryId,
                            x: battery.x,
                            y: battery.y
                        });
                        console.log(`[BatterySystem] Battery ${batteryId} dropped by disconnecting player ${socketId}`);
                    }
                }
            }
            
            this.room.players.delete(socketId);
            console.log(`Player ${socketId} left room ${this.room.id}`);

            // Notify other players
            this.io.to(this.room.id).emit('playerLeft', { id: socketId });

            // Clean up room if empty
            if (this.room.players.size === 0) {
                this.room.cleanup();
                this.room.rooms.delete(this.room.id);
            }
        }
    }

    // =========================================
    // SPAWN POSITION GENERATION
    // =========================================

    generateRandomSpawnPosition(seed = Math.random() * 1000000) {
        if (!this.room.environment) {
            console.warn('[Spawn] No environment available, spawning at origin');
            return { x: 0, y: 0 };
        }
        
        const env = this.room.environment;
        const rng = new SeededRNG(seed);
        const playerRadius = 26;
        const clearance = playerRadius + 30; // Extra space for safety
        
        // Check if current game mode has a specific spawn configuration
        let spawnCenterX = 0;
        let spawnCenterY = 0;
        let spawnRadius = env.boundary - clearance - 10;
        let useFixedSpawnArea = false;
        
        if (this.room.gameModeConfig && this.room.gameModeConfig.spawn) {
            const spawnConfig = this.room.gameModeConfig.spawn;
            if (typeof spawnConfig.x === 'number' && typeof spawnConfig.y === 'number') {
                spawnCenterX = spawnConfig.x;
                spawnCenterY = spawnConfig.y;
                spawnRadius = spawnConfig.radius || 300;
                useFixedSpawnArea = true;
                console.log(`[Spawn] Using game mode spawn area: center (${spawnCenterX}, ${spawnCenterY}), radius ${spawnRadius}`);
            }
        }
        
        // Build list of exclusion zones (areas to avoid)
        const exclusionZones = [];
        
        // 1. Avoid extraction zones
        if (this.room.extractionZone) {
            exclusionZones.push({
                x: this.room.extractionZone.x,
                y: this.room.extractionZone.y,
                radius: 2200 // Large buffer to keep players far from extraction
            });
        }
        if (this.room.hereticExtractionZone) {
            exclusionZones.push({
                x: this.room.hereticExtractionZone.x,
                y: this.room.hereticExtractionZone.y,
                radius: 2200 // Large buffer to keep players far from extraction
            });
        }
        
        // 2. Avoid golden chest (search through this.chests)
        for (const [id, chest] of this.room.chests) {
            if (chest.variant === 'gold') {
                exclusionZones.push({
                    x: chest.x,
                    y: chest.y,
                    radius: 1600 // Stay far away from chest
                });
                break;
            }
        }
        
        // 3. Avoid boss spawn location
        if (this.room.bossSpawn) {
            exclusionZones.push({
                x: this.room.bossSpawn.x,
                y: this.room.bossSpawn.y,
                radius: 2500 // Very wide berth around boss spawn
            });
        }
        
        // 4. Avoid actual boss if spawned
        if (this.room.boss) {
            exclusionZones.push({
                x: this.room.boss.x,
                y: this.room.boss.y,
                radius: 2600 // Very wide berth around active boss
            });
        }
        
        // Try to find a valid spawn position
        const maxTries = 500;
        for (let i = 0; i < maxTries; i++) {
            let nx, ny;
            
            if (useFixedSpawnArea) {
                // Spawn within the game mode's designated spawn area (e.g., New Antioch side)
                const angle = rng.randomFloat(0, Math.PI * 2);
                const dist = rng.randomFloat(0, spawnRadius);
                nx = spawnCenterX + Math.cos(angle) * dist;
                ny = spawnCenterY + Math.sin(angle) * dist;
            } else {
                // Default: spawn anywhere on the map
                const boundary = env.boundary - clearance - 10;
                nx = (rng.randomFloat(0, 1) * 2 - 1) * boundary;
                ny = (rng.randomFloat(0, 1) * 2 - 1) * boundary;
            }
            
            // Check if position is inside bounds and doesn't hit obstacles
            if (!env.isInsideBounds(nx, ny, clearance)) continue;
            if (env.circleHitsAny(nx, ny, clearance)) continue;
            
            // Check if position is far enough from all exclusion zones
            let tooClose = false;
            for (const zone of exclusionZones) {
                const dx = nx - zone.x;
                const dy = ny - zone.y;
                const distSq = dx * dx + dy * dy;
                if (distSq < zone.radius * zone.radius) {
                    tooClose = true;
                    break;
                }
            }
            
            if (!tooClose) {
                console.log(`[Spawn] Generated spawn at (${nx.toFixed(1)}, ${ny.toFixed(1)}) after ${i + 1} tries`);
                return { x: nx, y: ny };
            }
        }
        
        // Fallback: spawn at the designated spawn center (or origin if no spawn config)
        console.warn('[Spawn] Could not find ideal spawn after max tries, using fallback position');
        if (useFixedSpawnArea) {
            console.log(`[Spawn] Fallback to spawn center: (${spawnCenterX}, ${spawnCenterY})`);
            return { x: spawnCenterX, y: spawnCenterY };
        } else {
            const boundary = env.boundary - clearance - 10;
            const fallbackAngle = rng.randomFloat(0, Math.PI * 2);
            const fallbackDist = boundary * 0.5;
            return {
                x: Math.cos(fallbackAngle) * fallbackDist,
                y: Math.sin(fallbackAngle) * fallbackDist
            };
        }
    }

    // =========================================
    // ROOM SNAPSHOT (Initial sync for new players)
    // =========================================

    sendRoomSnapshot(socket) {
        if (!socket) return;
        // Filter orientedBoxes: exclude sandbag collision boxes (they'll be re-created client-side from hazardsState)
        // Only send trench walls, shield walls, and other boxes that need visual rendering
        const clientOrientedBoxes = (this.room.environment?.orientedBoxes || []).filter(box => {
            // Keep boxes that have rendering data (trench walls with fill/stroke) or ability markers (shield walls)
            return box.fill || box.stroke || box._abilityId;
        });
        
        socket.emit('roomSnapshot', {
            boundary: this.room.boundary,
            scene: this.room.scene,
            levelType: this.room.levelType, // SERVER-AUTHORITATIVE level selection
            obstacles: this.room.environment?.obstacles || [],
            orientedBoxes: clientOrientedBoxes,
            readyTimer: {
                started: this.room.readyTimer.started,
                completed: this.room.readyTimer.completed,
                timeLeft: this.room.readyTimer.timeLeft,
                timeTotal: this.room.readyTimer.timeTotal,
                startedBy: this.room.readyTimer.startedBy
            },
            groundItems: Array.from(this.room.groundItems.values()),
            ambientNpcs: this.room.ambientNpcs,
            levelSpawns: this.room.levelSpawns,
            enemies: Array.from(this.room.enemies.values())
        });
        // Ensure late joiners receive current hazards (including lobby fence sandbags)
        try {
            if (this.room.hazards) socket.emit('hazardsState', this.room.hazards.serialize());
        } catch (_) {}
    }
}

module.exports = PlayerManager;
