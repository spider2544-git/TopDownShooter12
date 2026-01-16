// Server-authoritative NPC management system
// Handles NPC behavior, state machines, and replication for multiplayer

class ServerNPCManager {
    constructor(room, io) {
        this.room = room;
        this.io = io;
        this.npcs = [];
        
        // NPC broadcast rate
        this.NPC_BROADCAST_HZ = 10;
        this._npcBroadcastIntervalMs = 1000 / this.NPC_BROADCAST_HZ;
        this._nextNpcBroadcastTime = 0;
    }
    
    // Initialize server-authoritative NPC instances from level spawns
    initializeFromLevelSpawns(levelSpawns) {
        this.npcs = [];
        if (!levelSpawns || !Array.isArray(levelSpawns.npcs)) return;
        
        for (let i = 0; i < levelSpawns.npcs.length; i++) {
            const spawn = levelSpawns.npcs[i];
            if (spawn.type === 'NPC_A') {
                // Ecclesiastic Prisoner
                this.npcs.push({
                    id: `npc_a_${i}`,
                    type: 'NPC_A',
                    x: spawn.x,
                    y: spawn.y,
                    radius: 24,
                    state: 'idle', // idle | follow | hostile | run_to_boss | betrayed
                    followingPlayerId: null,
                    targetEnemyId: null,
                    barkIndex: 0,
                    barkTimer: 2.8,
                    barkLines: ['Shame!!', 'Ive Failed', 'Lost all is lost', 'I must find her'],
                    barkInterval: 2.8,
                    alive: true,
                    speed: 110,
                    attackRange: 200,
                    attackCooldown: 0,
                    hostileTimer: 0,
                    betrayedTimer: 0,
                    // Warning ring state (like Boomer)
                    warningActive: false,
                    warningPulse: 0,
                    // Talk interaction flag
                    canTalk: true,
                    // Hostile target (player who triggered hostile state)
                    hostileTargetPlayerId: null,
                    // Navmesh pathfinding properties
                    _navPath: null,
                    _navWaypointIndex: 0,
                    _navLastUpdate: 0,
                    _navStuckTimer: 0,
                    _navLastPos: { x: spawn.x, y: spawn.y }
                });
            } else if (spawn.type === 'NPC_B') {
                // Heretic Priest with complex hostile combat AI
                this.npcs.push({
                    id: `npc_b_${i}`,
                    type: 'NPC_B',
                    x: spawn.x,
                    y: spawn.y,
                    _spawnX: spawn.x,
                    _spawnY: spawn.y,
                    radius: 24,
                    state: 'idle',
                    barkIndex: 0,
                    barkTimer: 3.0,
                    barkLines: ['Greetings.', 'A fair day for a walk.', 'Stay vigilant.'],
                    barkInterval: 3.0,
                    alive: true,
                    canTalk: true,
                    // Hostile combat stats
                    healthMax: 0,
                    health: 0,
                    showHealthBar: false,
                    chargeSpeed: 210,
                    evadeSpeed: 150,
                    hostilePhase: 'charge', // 'charge' | 'evade'
                    hostilePhaseTimer: 0,
                    attackWindowTimer: 0,
                    attackRestTimer: 0,
                    burstState: 'rest', // 'burst' | 'rest'
                    w4Cooldown: 0,
                    evadeDir: 1,
                    preHostileTimer: 0,
                    didHostileAnnounce: false,
                    hostileTargetPlayerId: null,
                    // DOT (Damage Over Time) tracking for Weapon 4 support
                    dotStacks: [],
                    dotAccum: 0,
                    dotTextTimer: 0,
                    // Navmesh pathfinding properties
                    _navPath: null,
                    _navWaypointIndex: 0,
                    _navLastUpdate: 0,
                    _navStuckTimer: 0,
                    _navLastPos: { x: spawn.x, y: spawn.y }
                });
            }
        }
        
        console.log(`[ServerNPC] Initialized ${this.npcs.length} server-authoritative NPCs`);
    }
    
    // Main update loop for NPC behavior
    update(deltaTime, now) {
        if (!Array.isArray(this.npcs) || this.npcs.length === 0) return;
        
        for (let i = this.npcs.length - 1; i >= 0; i--) {
            const npc = this.npcs[i];
            if (!npc || !npc.alive) {
                this.npcs.splice(i, 1);
                continue;
            }
            
            // Update bark timer
            this._updateBarkTimer(npc, deltaTime);
            
            // Update NPC behavior based on type
            if (npc.type === 'NPC_A') {
                this._updatePrisonerNPC(npc, deltaTime);
            } else if (npc.type === 'NPC_B') {
                this._updateHereticPriestNPC(npc, deltaTime);
            }
        }
        
        // Broadcast NPC state if interval elapsed
        if (!Number.isFinite(this._nextNpcBroadcastTime) || now >= this._nextNpcBroadcastTime) {
            this.broadcastState();
            this._nextNpcBroadcastTime = now + this._npcBroadcastIntervalMs;
        }
    }
    
    // Update bark timer for an NPC
    _updateBarkTimer(npc, deltaTime) {
        if (npc.barkTimer > 0) {
            npc.barkTimer -= deltaTime;
            if (npc.barkTimer <= 0 && Array.isArray(npc.barkLines) && npc.barkLines.length > 0) {
                npc.barkIndex = (npc.barkIndex + 1) % npc.barkLines.length;
                npc.barkTimer = npc.barkInterval || 2.8;
            }
        }
    }
    
    // Update Prisoner NPC (NPC_A) behavior with state machine
    _updatePrisonerNPC(npc, deltaTime) {
        // Decrement timers
        if (npc.attackCooldown > 0) npc.attackCooldown -= deltaTime;
        if (npc.hostileTimer > 0) npc.hostileTimer -= deltaTime;
        if (npc.betrayedTimer > 0) npc.betrayedTimer -= deltaTime;
        
        // State-based AI
        switch (npc.state) {
            case 'idle':
                this._updateIdleState(npc);
                break;
            case 'follow':
                this._updateFollowState(npc, deltaTime);
                break;
            case 'betrayed':
                this._updateBetrayedState(npc);
                break;
            case 'hostile':
                this._updateHostileState(npc, deltaTime);
                break;
            case 'run_to_boss':
                this._updateRunToBossState(npc, deltaTime);
                break;
        }
    }
    
    // Idle state: attack nearby enemies
    _updateIdleState(npc) {
        const nearestEnemy = this._findNearestEnemyToNpc(npc, npc.attackRange);
        if (nearestEnemy) {
            npc.targetEnemyId = nearestEnemy.id;
            if (npc.attackCooldown <= 0) {
                this.attackEnemy(npc, nearestEnemy);
                npc.attackCooldown = 0.35;
            }
        } else {
            npc.targetEnemyId = null;
        }
    }
    
    // Follow state: follow player and attack enemies
    _updateFollowState(npc, deltaTime) {
        const player = npc.followingPlayerId ? this.room.players.get(npc.followingPlayerId) : null;
        
        if (player && player.health > 0) {
            // Move toward player
            const dx = player.x - npc.x;
            const dy = player.y - npc.y;
            const dist = Math.hypot(dx, dy);
            const followGap = 40;
            const minDist = npc.radius + (player.radius || 20) + followGap;
            
            if (dist > minDist) {
                const ux = dx / dist;
                const uy = dy / dist;
                const step = Math.min(npc.speed * deltaTime, dist - minDist);
                const res = this.room.environment.resolveCircleMove(npc.x, npc.y, npc.radius, ux * step, uy * step);
                npc.x = res.x;
                npc.y = res.y;
            }
            
            // Attack nearby enemies while following
            const nearestEnemy = this._findNearestEnemyToNpc(npc, npc.attackRange);
            if (nearestEnemy) {
                npc.targetEnemyId = nearestEnemy.id;
                if (npc.attackCooldown <= 0) {
                    this.attackEnemy(npc, nearestEnemy);
                    npc.attackCooldown = 0.35;
                }
            } else {
                npc.targetEnemyId = null;
            }
            
            // Check for boss proximity to switch to run_to_boss state
            const boss = this._findBoss();
            if (boss) {
                const bossDistToPlayer = Math.hypot(boss.x - player.x, boss.y - player.y);
                if (bossDistToPlayer <= 800) {
                    this.switchState(npc, 'run_to_boss');
                }
            }
        } else {
            // Player died or disconnected, go back to idle
            npc.followingPlayerId = null;
            this.switchState(npc, 'idle');
        }
    }
    
    // Betrayed state: wait then go hostile
    _updateBetrayedState(npc) {
        if (npc.betrayedTimer <= 0) {
            this.switchState(npc, 'hostile');
        }
    }
    
    // Hostile state: chase player and explode
    _updateHostileState(npc, deltaTime) {
        // Enable warning ring during hostile state
        npc.warningActive = true;
        
        // Update warning pulse (for visual effect)
        npc.warningPulse = (npc.warningPulse || 0) + deltaTime * 3; // Pulse at 3 Hz
        if (npc.warningPulse > 1) npc.warningPulse -= 1;
        
        // Check for enemy attractors first (priority over players)
        let target = null;
        let targetType = 'player';
        
        // Look for nearby attractors
        for (const [, ability] of this.room.abilities) {
            if (ability.type !== 'EnemyAttractor') continue;
            if (ability.health <= 0) continue;
            
            const dx = ability.x - npc.x;
            const dy = ability.y - npc.y;
            const dist = Math.hypot(dx, dy);
            
            // Check if within attraction radius
            if (dist <= (ability.attractionRadius || 200)) {
                target = ability;
                targetType = 'attractor';
                break; // Use first attractor found in range
            }
        }
        
        // If no attractor, target the specific player who made the dialogue choice, fallback to nearest if unavailable
        if (!target) {
            if (npc.hostileTargetPlayerId) {
                target = this.room.players.get(npc.hostileTargetPlayerId);
                // If target is dead or disconnected, fallback to nearest
                if (!target || target.health <= 0) {
                    target = this._findNearestPlayerToNpc(npc);
                }
            } else {
                // No specific target, use nearest
                target = this._findNearestPlayerToNpc(npc);
            }
        }
        
        if (target) {
            const dx = target.x - npc.x;
            const dy = target.y - npc.y;
            const dist = Math.hypot(dx, dy);
            
            // Add breathing room: stop movement if within collision distance
            const breathingRoom = 30;
            const minDist = npc.radius + (target.radius || 20) + breathingRoom;
            
            // Apply damage to attractor if touching it
            if (targetType === 'attractor' && dist <= npc.radius + (target.radius || 20)) {
                const contactDamage = 20 * deltaTime; // Same rate as enemies do
                target.health = Math.max(0, target.health - contactDamage);
                
                // Mark for health update broadcast (will be handled in main update loop)
                if (!target._damageThisFrame) {
                    target._damageThisFrame = contactDamage;
                } else {
                    target._damageThisFrame += contactDamage;
                }
            }
            
            if (dist > minDist) {
                const ux = dx / dist;
                const uy = dy / dist;
                const step = Math.min((npc.speed + 60) * deltaTime, dist - minDist); // Catch-up speed, but stop at breathing room
                const res = this.room.environment.resolveCircleMove(npc.x, npc.y, npc.radius, ux * step, uy * step);
                npc.x = res.x;
                npc.y = res.y;
            }
        }
        
        if (npc.hostileTimer <= 0) {
            this.explode(npc);
        }
    }
    
    // Run to boss state: charge boss and explode on impact
    _updateRunToBossState(npc, deltaTime) {
        const boss = this._findBoss();
        if (boss) {
            const dx = boss.x - npc.x;
            const dy = boss.y - npc.y;
            const dist = Math.hypot(dx, dy);
            const ux = dx / dist;
            const uy = dy / dist;
            const step = (npc.speed + 40) * deltaTime;
            const res = this.room.environment.resolveCircleMove(npc.x, npc.y, npc.radius, ux * step, uy * step);
            npc.x = res.x;
            npc.y = res.y;
            
            // Attack nearby enemies while running to boss
            const nearestEnemy = this._findNearestEnemyToNpc(npc, npc.attackRange);
            if (nearestEnemy) {
                npc.targetEnemyId = nearestEnemy.id;
                if (npc.attackCooldown <= 0) {
                    this.attackEnemy(npc, nearestEnemy);
                    npc.attackCooldown = 0.35;
                }
            }
            
            // Check for impact with boss
            if (dist <= npc.radius + (boss.radius || 30) + 2) {
                // Damage boss
                const bossWasAlive = boss.alive && boss.health > 0;
                this._damageEnemy(boss.id, 250);
                // Mark prisoner mission accomplishment if boss took damage
                if (bossWasAlive && boss.health < (boss.healthMax || 2000)) {
                    this.room.missionAccomplishments.prisonerMissionSuccess = true;
                    console.log('[ServerNPC] Prisoner exploded and damaged witch - accomplishment marked');
                }
                // Explode
                this.explode(npc);
            }
        }
    }
    
    // Update Heretic Priest NPC (NPC_B) behavior with hostile combat AI
    _updateHereticPriestNPC(npc, deltaTime) {
        // Tick DOT stacks (Weapon 4 burn damage)
        this._tickNpcDot(npc, deltaTime);
        
        // Only run hostile AI when in hostile state
        if (npc.state !== 'hostile') {
            // Give-up logic: if too far from spawn and off-screen, return to spawn
            if (npc.state !== 'idle') {
                const dx = npc.x - npc._spawnX;
                const dy = npc.y - npc._spawnY;
                if (dx*dx + dy*dy > 3000*3000) {
                    this._returnHereticToSpawn(npc);
                }
            }
            return;
        }
        
        // Hostile state combat AI
        const targetPlayer = this._findTargetPlayerForNPC(npc);
        if (!targetPlayer) return;
        
        // Pre-attack announce delay
        if (npc.preHostileTimer > 0) {
            npc.preHostileTimer -= deltaTime;
            if (npc.preHostileTimer <= 0) {
                // Begin first burst after announce
                npc.burstState = 'burst';
                npc.attackWindowTimer = 2.0 + Math.random() * 5.0; // 2..7s
                npc.w4Cooldown = 0.02;
                npc.didHostileAnnounce = true;
            }
        }
        
        // Decrement phase timers
        if (npc.hostilePhaseTimer > 0) npc.hostilePhaseTimer -= deltaTime;
        if (npc.attackWindowTimer > 0) npc.attackWindowTimer -= deltaTime;
        if (npc.attackRestTimer > 0) npc.attackRestTimer -= deltaTime;
        
        // Movement AI: charge/evade phases
        const dx = targetPlayer.x - npc.x;
        const dy = targetPlayer.y - npc.y;
        const dist = Math.hypot(dx, dy) || 1;
        const ux = dx / dist;
        const uy = dy / dist;
        
        let vx = 0, vy = 0;
        
        if (npc.hostilePhase === 'charge') {
            // Aggressive charge straight at player
            const spd = npc.chargeSpeed;
            vx = ux * spd * deltaTime;
            vy = uy * spd * deltaTime;
            // When close enough or timer expires, switch to evade
            if (dist < 140 || npc.hostilePhaseTimer <= 0) {
                npc.hostilePhase = 'evade';
                npc.hostilePhaseTimer = 1.0 + Math.random() * 1.2; // 1..2.2s
                npc.evadeDir = (Math.random() < 0.5 ? -1 : 1);
                npc.w4Cooldown = 0.01;
            }
        } else {
            // Evasive strafe around player with slight outward bias
            const perpX = -uy * npc.evadeDir;
            const perpY = ux * npc.evadeDir;
            // Maintain comfortable distance: push outward if too close
            let outX = 0, outY = 0;
            if (dist < 220) {
                outX = -ux;
                outY = -uy;
            }
            const spd = npc.evadeSpeed;
            const mixX = perpX * 0.8 + outX * 0.6;
            const mixY = perpY * 0.8 + outY * 0.6;
            const norm = Math.hypot(mixX, mixY) || 1;
            vx = (mixX / norm) * spd * deltaTime;
            vy = (mixY / norm) * spd * deltaTime;
            // Swap back to charge after timer
            if (npc.hostilePhaseTimer <= 0) {
                npc.hostilePhase = 'charge';
                npc.hostilePhaseTimer = 1.1 + Math.random() * 1.5;
                npc.w4Cooldown = 0.01;
            }
        }
        
        // Apply movement with collision
        const res = this.room.environment.resolveCircleMove(npc.x, npc.y, npc.radius, vx, vy);
        npc.x = res.x;
        npc.y = res.y;
        
        // Firing bursts with explicit rest gaps
        if (npc.preHostileTimer <= 0 && npc.burstState === 'burst') {
            npc.attackWindowTimer -= deltaTime;
            if (npc.w4Cooldown > 0) npc.w4Cooldown -= deltaTime;
            if (npc.w4Cooldown <= 0) {
                this._fireHereticWeapon4Cone(npc, targetPlayer);
                // Faster rate during bursts
                npc.w4Cooldown = 0.09 + Math.random() * 0.05;
            }
            if (npc.attackWindowTimer <= 0) {
                // Transition to rest gap
                npc.burstState = 'rest';
                npc.attackRestTimer = 1.0 + Math.random() * 2.0; // 1..3s rest
            }
        } else if (npc.burstState === 'rest') {
            // Resting: no fire
            if (npc.attackRestTimer <= 0) {
                // Start a new burst
                npc.burstState = 'burst';
                npc.attackWindowTimer = 2.0 + Math.random() * 5.0; // 2..7s
                npc.w4Cooldown = 0.02;
            }
        }
    }
    
    // Fire weapon-4 cone projectile at target player (server-authoritative)
    _fireHereticWeapon4Cone(npc, targetPlayer) {
        // Aim at target player
        const angBase = Math.atan2(targetPlayer.y - npc.y, targetPlayer.x - npc.x);
        // Apply small random inaccuracy
        const offset = Math.random() * (10 * Math.PI / 180);
        const sign = (Math.random() < 0.5 ? -1 : 1);
        const ang = angBase + sign * offset;
        const dirX = Math.cos(ang);
        const dirY = Math.sin(ang);
        
        // Broadcast attack to all clients for VFX
        this.io.to(this.room.id).emit('npc_fire', {
            npcId: npc.id,
            x: npc.x,
            y: npc.y,
            angle: ang,
            dirX: dirX,
            dirY: dirY,
            targetPlayerId: targetPlayer.id
        });
        
        // Server-side DOT application (cone AOE attack) - reduced damage
        const coneRange = 90 * 5; // Based on weapon-4 cone range
        const coneHalf = 0.2;
        const baseDPS = 1; // 1 DPS for 3 seconds = 3 damage per hit
        const dotDuration = 3; // 3 seconds duration
        
        // Check all players in cone and apply DOT
        for (const [pid, player] of this.room.players) {
            if (!player || player.health <= 0) continue;
            
            const dx = player.x - npc.x;
            const dy = player.y - npc.y;
            const dist = Math.hypot(dx, dy);
            
            if (dist > coneRange) continue;
            
            // Check if player is within cone angle
            const angleToPlayer = Math.atan2(dy, dx);
            let angleDiff = angleToPlayer - ang;
            while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
            while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
            
            if (Math.abs(angleDiff) <= coneHalf) {
                // Apply DOT stack to player (same as weapon 4)
                this._applyPlayerDot(player, baseDPS, dotDuration, npc.id);
                
                // Broadcast DOT application to clients for fire VFX
                this.io.to(this.room.id).emit('playerDotApplied', {
                    playerId: pid,
                    dps: baseDPS,
                    duration: dotDuration,
                    sourceNpcId: npc.id
                });
            }
        }
    }
    
    // Apply DOT stack to a player (server-authoritative)
    _applyPlayerDot(player, dps, duration, sourceId) {
        if (!player || player.health <= 0) return;
        if (!Number.isFinite(dps) || dps <= 0) return;
        if (!Number.isFinite(duration) || duration <= 0) return;
        
        // Initialize DOT stacks array if it doesn't exist
        if (!Array.isArray(player.dotStacks)) {
            player.dotStacks = [];
        }
        
        const wasNotBurning = player.dotStacks.length === 0;
        
        // Add new DOT stack
        player.dotStacks.push({
            dps: dps,
            timeLeft: duration,
            sourceId: sourceId
        });
        
        // If player just started burning, broadcast burn state for fire VFX
        if (wasNotBurning) {
            this.io.to(this.room.id).emit('vfxEvent', {
                type: 'burnStateChanged',
                playerId: player.id,
                burning: true,
                x: player.x,
                y: player.y
            });
        }
        
        console.log(`[ServerNPC] Applied DOT to player ${player.id}: ${dps} DPS for ${duration}s (total stacks: ${player.dotStacks.length})`);
    }
    
    // Return heretic priest to spawn and reset state
    _returnHereticToSpawn(npc) {
        npc.x = npc._spawnX;
        npc.y = npc._spawnY;
        npc.state = 'idle';
        npc.healthMax = 0;
        npc.health = 0;
        npc.showHealthBar = false;
        npc.w4Cooldown = 0;
        npc.hostilePhase = 'charge';
        npc.hostilePhaseTimer = 0;
        npc.burstState = 'rest';
        npc.attackWindowTimer = 0;
        npc.attackRestTimer = 0;
        npc.preHostileTimer = 0;
        npc.didHostileAnnounce = false;
        npc.barkLines = ['Greetings.', 'A fair day for a walk.', 'Stay vigilant.'];
        npc.barkInterval = 3.0;
        npc.canTalk = true;
        npc.hostileTargetPlayerId = null;
    }
    
    // Find target for NPC (prioritize attractors, then specific target, fallback to nearest)
    _findTargetPlayerForNPC(npc) {
        // Check for enemy attractors first (priority over players)
        for (const [, ability] of this.room.abilities) {
            if (ability.type !== 'EnemyAttractor') continue;
            if (ability.health <= 0) continue;
            
            const dx = ability.x - npc.x;
            const dy = ability.y - npc.y;
            const dist = Math.hypot(dx, dy);
            
            // Check if within attraction radius
            if (dist <= (ability.attractionRadius || 200)) {
                return ability; // Return attractor as target
            }
        }
        
        // No attractor, target the specific player who made the dialogue choice, fallback to nearest if unavailable
        let targetPlayer = null;
        if (npc.hostileTargetPlayerId) {
            targetPlayer = this.room.players.get(npc.hostileTargetPlayerId);
            // If target is dead or disconnected, fallback to nearest
            if (!targetPlayer || targetPlayer.health <= 0) {
                targetPlayer = this._findNearestPlayerToNpc(npc);
            }
        } else {
            // No specific target, use nearest
            targetPlayer = this._findNearestPlayerToNpc(npc);
        }
        return targetPlayer;
    }
    
    // Helper: find nearest enemy to NPC within range
    _findNearestEnemyToNpc(npc, maxRange) {
        if (!npc || !this.room.enemies || this.room.enemies.size === 0) return null;
        
        let nearest = null;
        let nearestDist = maxRange;
        
        for (const [id, enemy] of this.room.enemies) {
            if (!enemy || !enemy.alive) continue;
            const dx = enemy.x - npc.x;
            const dy = enemy.y - npc.y;
            const dist = Math.hypot(dx, dy);
            if (dist < nearestDist) {
                nearestDist = dist;
                nearest = enemy;
            }
        }
        
        return nearest;
    }
    
    // Helper: find nearest player to NPC (skip invisible players + players reading dialogue)
    _findNearestPlayerToNpc(npc) {
        if (!npc || this.room.players.size === 0) return null;
        
        let nearest = null;
        let nearestDist = Infinity;
        
        for (const [id, player] of this.room.players) {
            if (!player || player.health <= 0) continue;
            // Skip invisible players
            if (player.invisible === true || player.dialogueOpen === true) continue;
            const dx = player.x - npc.x;
            const dy = player.y - npc.y;
            const dist = Math.hypot(dx, dy);
            if (dist < nearestDist) {
                nearestDist = dist;
                nearest = player;
            }
        }
        
        return nearest;
    }
    
    // Helper: find boss enemy
    _findBoss() {
        if (!this.room.enemies) return null;
        for (const [id, enemy] of this.room.enemies) {
            if (enemy && enemy.alive && enemy.type === 'boss') {
                return enemy;
            }
        }
        return null;
    }
    
    // NPC attacks enemy (server-authoritative damage, broadcast VFX)
    attackEnemy(npc, enemy) {
        if (!npc || !enemy) return;
        
        // Calculate damage
        const baseDmg = 30 + (Math.random() * 10 - 5);
        this._damageEnemy(enemy.id, baseDmg);
        
        // Broadcast attack event for client VFX
        const angle = Math.atan2(enemy.y - npc.y, enemy.x - npc.x);
        this.io.to(this.room.id).emit('npcAttack', {
            npcId: npc.id,
            x: npc.x,
            y: npc.y,
            angle: angle,
            targetId: enemy.id
        });
        
        // Broadcast damage to clients (for health updates and floating damage numbers)
        this.io.to(this.room.id).emit('explosionDamage', {
            hits: [{ id: enemy.id, damage: baseDmg, crit: false }]
        });
    }
    
    // NPC explodes (server-authoritative)
    explode(npc) {
        if (!npc) return;
        
        npc.alive = false;
        
        // Broadcast explosion event
        this.io.to(this.room.id).emit('npcExplode', {
            npcId: npc.id,
            x: npc.x,
            y: npc.y
        });
        
        // Apply damage to nearby enemies and players
        const BLAST_RADIUS = 300;
        const hits = []; // Track all enemy hits for broadcast
        
        // Damage enemies
        for (const [id, enemy] of this.room.enemies) {
            if (!enemy || !enemy.alive) continue;
            const dx = enemy.x - npc.x;
            const dy = enemy.y - npc.y;
            const dist = Math.hypot(dx, dy);
            if (dist <= BLAST_RADIUS) {
                let damage = 0;
                if (enemy.type === 'boss') {
                    // Boss: 50-70% of max health
                    const mh = Math.max(1, enemy.healthMax || 0);
                    const pct = 0.5 + Math.random() * 0.2;
                    damage = mh * pct;
                } else {
                    // Others: falloff 300 center -> 150 edge
                    const t = dist / BLAST_RADIUS;
                    damage = 300 - (150 * t);
                }
                this._damageEnemy(id, damage);
                hits.push({ id: id, damage: damage, crit: false });
            }
        }
        
        // Broadcast explosion damage to all clients (for health bars and damage numbers)
        if (hits.length > 0) {
            this.io.to(this.room.id).emit('explosionDamage', { hits: hits });
        }
        
        // Damage players ONLY if not attacking the boss (run_to_boss state is friendly)
        if (npc.state !== 'run_to_boss') {
            for (const [id, player] of this.room.players) {
                if (!player || player.health <= 0) continue;
                const dx = player.x - npc.x;
                const dy = player.y - npc.y;
                const dist = Math.hypot(dx, dy);
                if (dist <= BLAST_RADIUS + (player.radius || 20)) {
                    const t = dist / BLAST_RADIUS;
                    const damage = 300 - (150 * t);
                    player.health -= damage;
                    if (player.health < 0) player.health = 0;
                    
                    // Broadcast health update for damage numbers and VFX
                    try {
                        if (player.socket) {
                            player.socket.emit('playerHealth', { health: player.health, from: 'npc_explosion' });
                        }
                        this.io.to(this.room.id).emit('playerHealthUpdate', { 
                            playerId: id, 
                            health: player.health,
                            from: 'npc_explosion'
                        });
                    } catch(e) {
                        console.error('[ServerNPC] Error broadcasting player health after NPC explosion:', e);
                    }
                }
            }
        }
        
        // Damage troops with 95% (19/20) instakill chance when attacking the boss
        if (npc.state === 'run_to_boss' && this.room.troopManager && this.room.troopManager.troops) {
            for (const [, troop] of this.room.troopManager.troops) {
                if (!troop || !troop.alive || troop.health <= 0) continue;
                
                const dx = troop.x - npc.x;
                const dy = troop.y - npc.y;
                const dist = Math.hypot(dx, dy);
                
                if (dist <= BLAST_RADIUS + (troop.radius || 22)) {
                    // 95% (19/20) chance to instakill, 5% chance for normal damage
                    const instakillRoll = Math.random();
                    let damage = 0;
                    let instakilled = false;
                    
                    if (instakillRoll < 0.95) {
                        // Instakill (95% chance - vast majority die)
                        damage = troop.health;
                        instakilled = true;
                        console.log(`[ServerNPC] Prisoner explosion INSTAKILLED troop ${troop.id} (95% chance rolled: ${(instakillRoll * 100).toFixed(2)}%)`);
                    } else {
                        // Normal falloff damage (5% chance - lucky survivors)
                        const t = dist / BLAST_RADIUS;
                        damage = 300 - (150 * t);
                        console.log(`[ServerNPC] Troop ${troop.id} SURVIVED instakill (5% luck: ${(instakillRoll * 100).toFixed(2)}%)`);
                    }
                    
                    troop.health = Math.max(0, troop.health - damage);
                    
                    // Broadcast troop damage
                    this.io.to(this.room.id).emit('troopDamaged', {
                        troopId: troop.id,
                        // Send already-rounded integer damage for UI text (avoid "-0")
                        damage: Math.max(1, Math.round(damage)),
                        health: troop.health,
                        healthMax: troop.healthMax,
                        x: troop.x,
                        y: troop.y
                    });
                    
                    // Check if troop died
                    if (troop.health <= 0) {
                        troop.alive = false;
                        const deathReason = instakilled ? 'Prisoner explosion (instakill)' : 'Prisoner explosion';
                        console.log(`[ServerNPC] Troop ${troop.id} killed by ${deathReason}`);
                        
                        this.io.to(this.room.id).emit('troopDeath', {
                            troopId: troop.id,
                            x: troop.x,
                            y: troop.y
                        });
                        this.io.to(this.room.id).emit('entity_dead', {
                            entityType: 'troop',
                            id: troop.id,
                            x: troop.x,
                            y: troop.y,
                            kind: troop.type || 'troop',
                            cause: 'npc_explosion'
                        });
                    }
                }
            }
        }
    }
    
    // Switch NPC state and update barks
    switchState(npc, newState) {
        if (!npc || npc.state === newState) return;
        
        const oldState = npc.state;
        npc.state = newState;
        
        console.log(`[ServerNPC] NPC ${npc.id} state change: ${oldState} -> ${newState}`);
        
        // NPC_A (Prisoner) state updates
        if (npc.type === 'NPC_A') {
            if (newState === 'idle') {
                npc.barkLines = ['Shame!!', 'Ive Failed', 'Lost all is lost', 'I must find her'];
                npc.barkInterval = 2.8;
                npc.warningActive = false;
                npc.canTalk = true;
                npc.hostileTargetPlayerId = null;
            } else if (newState === 'follow') {
                npc.barkLines = ['Lead on!', 'The Witch shall fall!', 'I follow!'];
                npc.barkInterval = 3.0;
                npc.warningActive = false;
                npc.canTalk = false;
            } else if (newState === 'betrayed') {
                npc.barkLines = ['Betrayed!', 'You shall pay!'];
                npc.barkInterval = 1.5;
                npc.betrayedTimer = 3.0;
                npc.warningActive = false;
                npc.canTalk = false;
            } else if (newState === 'hostile') {
                npc.barkLines = ['Die heretic!', 'Feel my wrath!'];
                npc.barkInterval = 2.0;
                npc.hostileTimer = 4.0;
                npc.warningActive = true;
                npc.warningPulse = 0;
                npc.canTalk = false;
            } else if (newState === 'run_to_boss') {
                npc.barkLines = ['The Witch!', 'Face me!'];
                npc.barkInterval = 2.5;
                npc.warningActive = true;
                npc.warningPulse = 0;
                npc.canTalk = false;
            }
        }
        // NPC_B (Heretic Priest) state updates
        else if (npc.type === 'NPC_B') {
            if (newState === 'idle') {
                npc.barkLines = ['Greetings.', 'A fair day for a walk.', 'Stay vigilant.'];
                npc.barkInterval = 3.0;
                npc.canTalk = true;
                npc.hostileTargetPlayerId = null;
            } else if (newState === 'hostile') {
                // Initialize combat stats
                npc.healthMax = 1000;
                npc.health = npc.healthMax;
                npc.showHealthBar = true;
                // Phase machine init
                npc.hostilePhase = 'charge';
                npc.hostilePhaseTimer = 1.2 + Math.random() * 0.8; // 1.2..2.0s
                // Start with a pre-attack announce delay
                npc.preHostileTimer = 1.5;
                npc.didHostileAnnounce = false;
                npc.burstState = 'rest';
                npc.attackWindowTimer = 0;
                npc.attackRestTimer = 0;
                npc.w4Cooldown = 0.02;
                npc.evadeDir = (Math.random() < 0.5 ? -1 : 1);
                // Show bark: "Cleansing Flames!" for the announce duration
                npc.barkLines = ['Cleansing Flames!'];
                npc.barkInterval = 1.5;
                npc.canTalk = false;
            }
        }
        
        // Reset bark timer
        npc.barkIndex = 0;
        npc.barkTimer = npc.barkInterval;
    }
    
    // Broadcast NPC state to all clients
    broadcastState() {
        if (!Array.isArray(this.npcs) || this.npcs.length === 0) return;
        
        const payload = this.npcs.map(npc => {
            const data = {
                id: npc.id,
                type: npc.type,
                x: npc.x,
                y: npc.y,
                state: npc.state,
                followingPlayerId: npc.followingPlayerId,
                targetEnemyId: npc.targetEnemyId,
                barkIndex: npc.barkIndex,
                barkLines: npc.barkLines,
                alive: npc.alive,
                // Warning ring state for visual effects (NPC_A)
                warningActive: npc.warningActive || false,
                warningPulse: npc.warningPulse || 0,
                hostileTimer: npc.hostileTimer || 0,
                // Talk interaction flag
                canTalk: npc.canTalk !== false // Default to true if undefined
            };
            
            // NPC_B (Heretic Priest) additional data when hostile
            if (npc.type === 'NPC_B' && npc.state === 'hostile') {
                data.health = npc.health;
                data.healthMax = npc.healthMax;
                data.showHealthBar = npc.showHealthBar;
                data.hostilePhase = npc.hostilePhase;
                data.burstState = npc.burstState;
                data.preHostileTimer = npc.preHostileTimer;
            }
            
            return data;
        });
        
        this.io.to(this.room.id).emit('npcsState', payload);
    }
    
    // Helper to damage an enemy by ID
    _damageEnemy(enemyId, damage) {
        const enemy = this.room.enemies.get(enemyId);
        if (!enemy || !enemy.alive) return;
        
        enemy.health -= damage;
        if (enemy.health <= 0) {
            enemy.health = 0;
            enemy.alive = false;
            
            // Broadcast enemy death
            this.io.to(this.room.id).emit('enemy_dead', {
                id: enemyId,
                x: enemy.x,
                y: enemy.y,
                type: enemy.type
            });
            this.io.to(this.room.id).emit('entity_dead', {
                entityType: 'enemy',
                id: enemyId,
                x: enemy.x,
                y: enemy.y,
                kind: enemy.type
            });
        }
    }
    
    // Handle player setting NPC state (from dialogue, etc.)
    handleSetState(npcId, state, playerId) {
        const npc = this.npcs.find(n => n.id === npcId);
        if (!npc) {
            console.log(`[ServerNPC] handleSetState failed: npc=${npcId} not found`);
            return;
        }
        
        console.log(`[ServerNPC] handleSetState: npc=${npcId}, type=${npc.type}, state=${state}, playerId=${playerId}`);
        
        // NPC_A (Prisoner) states
        if (npc.type === 'NPC_A') {
            if (state === 'follow' && playerId) {
                npc.followingPlayerId = playerId;
                this.switchState(npc, 'follow');
                console.log(`[ServerNPC] NPC ${npc.id} now following player ${playerId}`);
            } else if (state === 'betrayed') {
                npc.hostileTargetPlayerId = playerId;
                this.switchState(npc, 'betrayed');
                console.log(`[ServerNPC] NPC ${npc.id} betrayed by player ${playerId}`);
            } else if (state === 'hostile') {
                npc.hostileTargetPlayerId = playerId;
                this.switchState(npc, 'hostile');
                console.log(`[ServerNPC] NPC ${npc.id} set to hostile directly by player ${playerId}`);
            } else if (state === 'idle' || state === 'default') {
                this.switchState(npc, 'idle');
                console.log(`[ServerNPC] NPC ${npc.id} set to idle`);
            } else if (state === 'run_to_boss') {
                this.switchState(npc, 'run_to_boss');
                console.log(`[ServerNPC] NPC ${npc.id} set to run_to_boss`);
            }
        }
        // NPC_B (Heretic Priest) states
        else if (npc.type === 'NPC_B') {
            if (state === 'hostile') {
                npc.hostileTargetPlayerId = playerId;
                this.switchState(npc, 'hostile');
                console.log(`[ServerNPC] NPC ${npc.id} (Heretic Priest) set to hostile by player ${playerId}`);
            } else if (state === 'idle' || state === 'default') {
                this.switchState(npc, 'idle');
                console.log(`[ServerNPC] NPC ${npc.id} (Heretic Priest) set to idle`);
            }
        } else {
            console.log(`[ServerNPC] Unknown NPC type: ${npc.type}`);
        }
    }
    
    // Find NPC by ID
    getNpcById(npcId) {
        return this.npcs.find(n => n.id === npcId);
    }
    
    // Get all NPCs
    getAllNpcs() {
        return this.npcs;
    }
    
    // Handle damage to NPC from player (server-authoritative)
    damageNPC(npcId, damage, playerId) {
        const npc = this.npcs.find(n => n.id === npcId);
        if (!npc || !npc.alive) return;
        
        // Only NPC_B (Heretic Priest) takes damage when hostile
        if (npc.type !== 'NPC_B' || npc.state !== 'hostile') {
            console.log(`[ServerNPC] Damage rejected: NPC ${npcId} is not hostile or wrong type`);
            return;
        }
        
        const dmg = Math.max(0, Number(damage) || 0);
        if (dmg <= 0) return;
        
        npc.health = Math.max(0, npc.health - dmg);
        console.log(`[ServerNPC] NPC ${npcId} took ${dmg} damage, health now ${npc.health}/${npc.healthMax}`);
        
        // Broadcast damage to all clients for visual feedback
        this.io.to(this.room.id).emit('npcDamaged', {
            npcId: npc.id,
            health: npc.health,
            healthMax: npc.healthMax,
            damage: dmg
        });
        
        if (npc.health <= 0) {
            this._killNPC(npc, playerId);
        }
    }
    
    // Apply a DOT stack to an NPC (server-authoritative)
    applyNpcDot(npcId, dps, duration, playerId) {
        const npc = this.npcs.find(n => n.id === npcId);
        if (!npc || !npc.alive) return;
        
        // Only NPC_B (Heretic Priest) can receive DOTs when hostile
        if (npc.type !== 'NPC_B' || npc.state !== 'hostile') {
            return;
        }
        
        if (!Number.isFinite(dps) || dps <= 0) return;
        if (!Number.isFinite(duration) || duration <= 0) return;
        
        // Add DOT stack
        npc.dotStacks.push({ dps, timeLeft: duration, playerId });
        
        console.log(`[ServerNPC] Applied DOT to NPC ${npcId}: ${dps} DPS for ${duration}s`);
    }
    
    // Tick DOT stacks on an NPC and apply damage (server-authoritative)
    _tickNpcDot(npc, dt) {
        if (!npc || !npc.alive) return;
        if (npc.state !== 'hostile' || npc.healthMax <= 0) return;
        if (!Array.isArray(npc.dotStacks) || npc.dotStacks.length === 0) return;
        
        let totalDps = 0;
        let sourcePlayerId = null;
        
        // Update all stacks and remove expired ones
        for (let i = npc.dotStacks.length - 1; i >= 0; i--) {
            const s = npc.dotStacks[i];
            s.timeLeft -= dt;
            if (s.timeLeft <= 0) {
                npc.dotStacks.splice(i, 1);
            } else {
                totalDps += s.dps;
                if (!sourcePlayerId && s.playerId) sourcePlayerId = s.playerId;
            }
        }
        
        if (totalDps > 0) {
            const damage = totalDps * dt;
            npc.health -= damage;
            npc.dotAccum += damage;
            npc.dotTextTimer -= dt;
            
            // Emit DOT damage text periodically
            if (npc.dotTextTimer <= 0 && npc.dotAccum > 0.5) {
                // Broadcast DOT damage to clients
                this.io.to(this.room.id).emit('npcDotDamage', {
                    npcId: npc.id,
                    damage: npc.dotAccum,
                    x: npc.x,
                    y: npc.y
                });
                
                npc.dotAccum = 0;
                npc.dotTextTimer = 0.15;
            }
            
            // Check for death from DOT
            if (npc.health <= 0) {
                this._killNPC(npc, sourcePlayerId);
            }
        }
    }
    
    // Kill NPC and handle death effects (server-authoritative)
    _killNPC(npc, killedBy) {
        if (!npc) return;
        
        npc.alive = false;
        npc.health = 0;
        
        console.log(`[ServerNPC] NPC ${npc.id} (${npc.type}) killed by player ${killedBy}`);
        
        // Broadcast death event
        this.io.to(this.room.id).emit('npc_dead', {
            npcId: npc.id,
            type: npc.type,
            x: npc.x,
            y: npc.y
        });
        
        // Drop loot for NPC_B (Heretic Priest): 4 random Epic/Legendary hex stats
        // Using same server-authoritative pattern as boss loot drops
        if (npc.type === 'NPC_B') {
            // Mark Heretic Priest accomplishment for VP rewards
            this.room.missionAccomplishments.hereticPriestKilled = true;
            console.log('[ServerNPC] Heretic Priest killed - accomplishment marked');
            
            const labels = ['+MovSpd', '+AtkSpd', '+AtkPwr', '+Armor', '+HP', '+Stm', '+CritChan', '+CritDmg'];
            const groundItems = [];
            
            // Generate 4 items with deterministic positioning like boss loot
            for (let i = 0; i < 4; i++) {
                const idx = Math.floor(Math.random() * labels.length);
                const label = labels[idx];
                const isLegendary = Math.random() < 0.5;
                const rarityName = isLegendary ? 'Legendary' : 'Epic';
                const rarity = isLegendary 
                    ? { name: 'Legendary', color: '#ffa64d' }
                    : { name: 'Epic', color: '#b26aff' };
                
                // Compute stat bonus data (server-authoritative)
                const statData = this.room._computeStatBonus(label, rarityName);
                
                // Deterministic angle for item placement (even distribution around NPC)
                const ang = (i * (2 * Math.PI / 4)); // 4 items evenly distributed
                
                // Find clear ground position (same as boss loot)
                const pos = this.room.findClearGroundPosition(npc.x, npc.y, ang);
                
                const itemId = `npc_${npc.id}_${i}`;
                const groundItem = {
                    id: itemId,
                    x: pos.x,
                    y: pos.y,
                    vx: 0, // Stationary drops (same as boss)
                    vy: 0,
                    label: label,
                    rarityName: rarityName,
                    color: rarity.color,
                    // Include stat data for server-side inventory calculations
                    statKey: statData.statKey,
                    bonusValue: statData.value,
                    isPercent: statData.isPercent,
                    rarity: rarity
                };
                
                // Add to room ground items (server-authoritative)
                this.room.groundItems.set(itemId, groundItem);
                groundItems.push(groundItem);
            }
            
            // Broadcast loot using same event as boss (for consistent handling)
            if (groundItems.length > 0) {
                this.io.to(this.room.id).emit('bossLootDropped', {
                    enemyId: npc.id,
                    x: npc.x,
                    y: npc.y,
                    groundItems: groundItems
                });
                console.log(`[ServerNPC] Generated ${groundItems.length} loot items for Heretic Priest at (${npc.x.toFixed(1)}, ${npc.y.toFixed(1)})`);
            }
        }
    }
}

module.exports = ServerNPCManager;

