/**
 * PlayerPhysicsManager - Manages player movement, stamina, collision, and physics for GameRoom
 * 
 * Extracted from GameRoom (Phase 7 of incremental manager extraction)
 * 
 * Handles:
 * - Stamina system (sprint, dash, weapon costs)
 * - Player movement (WASD, knockback, speed modifiers)
 * - Collision detection (walls, obstacles, environment)
 * - Breadcrumb trail tracking (Trench Raid mode)
 * - Line-of-sight pathfinding helpers
 */

class PlayerPhysicsManager {
    /**
     * @param {GameRoom} room - Reference to the parent GameRoom for state access
     * @param {SocketIO} io - Socket.io instance for broadcasting
     * @param {Function} getWeaponProgression - Weapon progression config lookup
     * @param {Object} serverDebugger - Server debug logging utility
     */
    constructor(room, io, getWeaponProgression, serverDebugger) {
        this.room = room;
        this.io = io;
        this.getWeaponProgression = getWeaponProgression;
        this.serverDebugger = serverDebugger;
    }

    // =========================================
    // STAMINA SYSTEM (Sprint, Dash, Weapon Costs)
    // =========================================

    updatePlayerStamina(player, input, deltaTime) {
        // Invincibility: stamina can only go up (no costs/drains/locks)
        let isInvincible = (player.invincible === true);
        // Countdown exhaustion timer regardless of input
        if (player.exhaustionTimer > 0) {
            player.exhaustionTimer -= deltaTime;
            if (player.exhaustionTimer < 0) player.exhaustionTimer = 0;
        }
        
        // Update dash cooldown
        if (player.dashCooldown > 0) {
            player.dashCooldown -= deltaTime;
            if (player.dashCooldown < 0) player.dashCooldown = 0;
        }
        
        // Update dash duration
        if (player.dashDuration > 0) {
            player.dashDuration -= deltaTime;
            if (player.dashDuration <= 0) {
                player.dashDuration = 0;
                player.dashActive = false;
                
                // End dash-tied invulnerability safely
                if (player._dashInvuln) {
                    player._dashInvuln = false;
                    player._invulnSources = Math.max(0, (player._invulnSources || 1) - 1);
                    player.invincible = !!player._manualInvincible || (player._invulnSources > 0);
                }
                
                // Log dash end with position delta
                if (player._dashStartPos) {
                    const endTime = Date.now();
                    const duration = endTime - player._dashStartPos.timestamp;
                    const dx = player.x - player._dashStartPos.x;
                    const dy = player.y - player._dashStartPos.y;
                    const distance = Math.hypot(dx, dy);
                    console.log(`[Server] [${endTime}] Ã°Å¸ÂÂ DASH ENDED for player ${player.id} | Start: (${player._dashStartPos.x.toFixed(1)}, ${player._dashStartPos.y.toFixed(1)}) | End: (${player.x.toFixed(1)}, ${player.y.toFixed(1)}) | Distance moved: ${distance.toFixed(1)} units | Duration: ${duration}ms`);
                    player._dashStartPos = null;
                }
            }
        }
        
        // Handle dash request (one-time event that needs to be cleared after processing)
        if (input.wantsDash) {
            const timestamp = Date.now();
            console.log(`[Server] [${timestamp}] Dash requested by player ${player.id} | Position: (${player.x.toFixed(1)}, ${player.y.toFixed(1)}) | Cooldown: ${player.dashCooldown.toFixed(2)}s | Active: ${player.dashActive} | Stamina: ${player.stamina.toFixed(1)}`);
            
            if (player.dashCooldown <= 0 && !player.dashActive && !player._weapon8ADS) { // Disable dash while ADS
                const dashCost = player.dashStaminaCost || 25;
                
                if (isInvincible || player.stamina >= dashCost) {
                    // Store position before dash for logging
                    const preX = player.x;
                    const preY = player.y;
                    
                    // Activate dash
                    if (!isInvincible) player.stamina -= dashCost;
                    player.dashActive = true;
                    player.dashDuration = player.dashMaxDuration || 0.2;
                    player.dashCooldown = player.dashCooldownMax || 1.5;
                    
                    // Begin dash-tied invulnerability
                    player._dashInvuln = true;
                    player._invulnSources = (player._invulnSources || 0) + 1;
                    player.invincible = true;
                    
                    // Store initial position for tracking
                    player._dashStartPos = { x: preX, y: preY, timestamp };
                    
                    console.log(`[Server] [${timestamp}] Ã¢Å"â€¦ DASH ACTIVATED for player ${player.id} | Position: (${preX.toFixed(1)}, ${preY.toFixed(1)}) | DashSpeed: ${(player.speed * player.dashSpeedMultiplier).toFixed(0)} (${player.dashSpeedMultiplier}x base) | Duration: ${player.dashDuration}s | Cooldown: ${player.dashCooldown}s | Stamina: ${player.stamina.toFixed(1)}`);
                    
                    // Broadcast dash activation to all clients in room
                    this.io.to(this.room.id).emit('playerDashed', {
                        playerId: player.id
                    });
                } else {
                    console.log(`[Server] [${timestamp}] Ã¢ÂÅ' DASH DENIED - Not enough stamina for player ${player.id} | Need: 50 | Have: ${player.stamina.toFixed(1)}`);
                    // Not enough stamina - send feedback to requesting player only
                    if (player.socket) {
                        player.socket.emit('dashFeedback', {
                            message: 'OUT OF STAMINA',
                            color: '#ff4444'
                        });
                    }
                }
            } else {
                console.log(`[Server] [${timestamp}] Ã¢ÂÅ' DASH DENIED - On cooldown or already active for player ${player.id}`);
            }
            
            // Clear the wantsDash flag after processing to prevent continuous triggering
            input.wantsDash = false;
        }

        // Dash can change invincibility state; re-sample before stamina drains
        isInvincible = (player.invincible === true);
        
        // Clear weapon 4 firing flag if no recent shots (100ms timeout) or mouse released
        if (player.isFiringWeapon4 && player._weapon4LastFired) {
            const timeSinceLastShot = Date.now() - player._weapon4LastFired;
            const mouseReleased = !input.mouseDown;
            if (timeSinceLastShot > 100 || mouseReleased) {
                player.isFiringWeapon4 = false;
            }
        }
        
        // Clear mustReleaseFire latch when mouse is released AND stamina has recharged slightly
        if (player.mustReleaseFire && !input.mouseDown && player.stamina > 0) {
            player.mustReleaseFire = false;
        }
        
        // Calculate movement and sprint state
        const isMoving = input.keys.KeyW || input.keys.KeyS || input.keys.KeyA || input.keys.KeyD;
        const wantsSprint = input.keys.ShiftLeft || input.keys.ShiftRight;
        const staminaDrainThisFrame = player.staminaDrainPerSecond * deltaTime;
        const tryingToSprint = wantsSprint && isMoving && !player.mustReleaseShift && !player._weapon8ADS; // Disable sprint while ADS
        const canSprint = tryingToSprint && (isInvincible || ((player.stamina > staminaDrainThisFrame) && (player.exhaustionTimer === 0)));
        
        // Store server sprint state for movement calculations
        player.serverSprintActive = canSprint;
        
        if (canSprint && !isInvincible) {
            // Drain stamina while sprinting
            player.stamina -= staminaDrainThisFrame;
            if (player.stamina <= 0) {
                player.stamina = 0;
                player.mustReleaseShift = true; // lock sprint until Shift is released
                player.exhaustionTimer = player.exhaustionCooldownSeconds; // start exhaustion delay
            }
        }
        
        // Additional drain when firing weapon 4: multiplier based on loot level
        if (player.isFiringWeapon4 && !player.mustReleaseFire && !isInvincible) {
            // Get loot-based stamina drain multiplier for weapon 4
            const lootLevel = player.lootLevel || 0;
            const progression = this.getWeaponProgression(3, lootLevel);
            const staminaDrainMultiplier = progression.primary?.staminaDrainMultiplier || 1.0;
            
            // Track firing start time
            if (!player._weapon4FiringStartTime) {
                player._weapon4FiringStartTime = Date.now();
                player._weapon4InitialStamina = player.stamina;
            }
            
            // Base drain is 0.5x sprint rate, then multiplied by loot progression
            player.stamina -= staminaDrainThisFrame * 0.5 * staminaDrainMultiplier;
            if (player.stamina <= 0) {
                player.stamina = 0;
                player.mustReleaseFire = true; // lock firing until mouse released and some recharge
                player.exhaustionTimer = player.exhaustionCooldownSeconds; // start exhaustion delay
                player._weapon4FiringStartTime = null;
            }

            // Weapon 4 sandbag damage now handled by individual cone projectile collisions (see updatePlayerBullets)
        } else if (player._weapon4FiringStartTime) {
            // Firing stopped
            player._weapon4FiringStartTime = null;
        }

        // Weapon 1 melee: apply hazard damage using the SAME cone system as enemy collision
        // (loot-scaled coneRange/coneHalf), instead of a fixed small circle.
        try {
            if (player.isFiringWeapon1) {
                const now = Date.now();
                if (!Number.isFinite(player._w1HazardNext) || now >= player._w1HazardNext) {
                    const ang = Number.isFinite(player.aimAngle) ? player.aimAngle : 0;
                    const ox = (player.x || 0);
                    const oy = (player.y || 0);

                    // Match client weapon1 base values:
                    // weapon1 projectileRadius=40 -> baseConeRange=40*3=120, baseConeHalf=0.6
                    const lootLevel = player.lootLevel || 0;
                    const prog = (typeof this.getWeaponProgression === 'function') ? (this.getWeaponProgression(0, lootLevel) || {}) : {};
                    const primaryMods = (prog && prog.primary) ? prog.primary : {};
                    const coneRange = 120 * (primaryMods.coneRangeMultiplier || 1.0);
                    const coneHalf = 0.6 * (primaryMods.coneHalfMultiplier || 1.0);

                    const dmg = 40; // single swing damage to hazards

                    if (this.room.hazards) {
                        // Prefer true cone checks (weapon1 behavior)
                        if (typeof this.room.hazards.damageSandbagsInCone === 'function') {
                            this.room.hazards.damageSandbagsInCone(ox, oy, ang, coneRange, coneHalf, dmg);
                        } else if (typeof this.room.hazards.damageCircle === 'function') {
                            // Fallback to previous behavior (should be unreachable after update)
                            const cx = ox + Math.cos(ang) * 70;
                            const cy = oy + Math.sin(ang) * 70;
                            this.room.hazards.damageCircle(cx, cy, 60, dmg);
                        }

                        if (typeof this.room.hazards.damageBarrelsInCone === 'function') {
                            this.room.hazards.damageBarrelsInCone(ox, oy, ang, coneRange, coneHalf, dmg);
                        } else if (typeof this.room.hazards.damageBarrelInRadius === 'function') {
                            // Fallback to previous behavior
                            const cx = ox + Math.cos(ang) * 70;
                            const cy = oy + Math.sin(ang) * 70;
                            this.room.hazards.damageBarrelInRadius(cx, cy, 60, dmg);
                        }
                    }

                    player._w1HazardNext = now + 150; // 150ms gate
                }
            }
        } catch(_) {}
        
        // Attempting to sprint with too little stamina: trigger exhaustion
        if (!isInvincible && tryingToSprint && player.stamina > 0 && player.stamina <= staminaDrainThisFrame) {
            player.stamina = 0;
            player.mustReleaseShift = true;
            player.exhaustionTimer = player.exhaustionCooldownSeconds;
        } else {
            if (isInvincible) {
                player.exhaustionTimer = 0;
                player.mustReleaseShift = false;
                player.mustReleaseFire = false;
                player.stamina += player.staminaRechargePerSecond * deltaTime;
                if (player.stamina > player.staminaMax) player.stamina = player.staminaMax;
            } else {
                // Only recharge when Shift is NOT held and not firing weapons that use stamina
                if (!wantsSprint && !player.isFiringWeapon4 && !player.isFiringWeapon1) {
                    // Wait for exhaustion to end before recharging
                    if (player.exhaustionTimer === 0) {
                        player.stamina += player.staminaRechargePerSecond * deltaTime;
                        if (player.stamina > player.staminaMax) player.stamina = player.staminaMax;
                        // Clear latch once Shift is released and stamina is > 0
                        if (player.mustReleaseShift && player.stamina > 0) player.mustReleaseShift = false;
                        if (player.mustReleaseFire && player.stamina > 0) player.mustReleaseFire = false;
                    }
                }
            }
        }
    }

    // =========================================
    // PLAYER MOVEMENT & COLLISION
    // =========================================

    updatePlayerMovement(player, input, deltaTime) {
        const speed = player.speed;
        let vx = 0, vy = 0;
        
        // Store position before movement for debugging
        const beforePos = { x: player.x, y: player.y };
        
        // Handle knockback first (takes priority over input movement)
        if (player.kbTime && player.kbTime > 0) {
            const step = Math.min(player.kbTime, deltaTime);
            const kbVelX = Number.isFinite(player.kbVelX) ? player.kbVelX : 0;
            const kbVelY = Number.isFinite(player.kbVelY) ? player.kbVelY : 0;
            const dx = kbVelX * step;
            const dy = kbVelY * step;
            
            // Apply knockback movement with collision
            // Use substeps for large knockback to prevent phasing through rotated walls
            if (this.room.environment && this.room.environment.resolveCircleMove) {
                const radius = player.radius || 26;
                
                // Break large knockback into smaller steps for better collision with rotated walls
                const knockbackDist = Math.hypot(dx, dy);
                const maxStepSize = 10; // Max step size per iteration
                const steps = Math.max(1, Math.ceil(knockbackDist / maxStepSize));
                const stepX = dx / steps;
                const stepY = dy / steps;
                
                let currentX = player.x;
                let currentY = player.y;
                
                for (let i = 0; i < steps; i++) {
                    const resolved = this.room.environment.resolveCircleMove(currentX, currentY, radius, stepX, stepY);
                    currentX = resolved.x;
                    currentY = resolved.y;
                }
                
                player.x = currentX;
                player.y = currentY;
            } else {
                player.x += dx;
                player.y += dy;
            }
            
            // Decay knockback time
            player.kbTime -= deltaTime;
            if (player.kbTime < 0) {
                player.kbTime = 0;
                player.kbVelX = 0;
                player.kbVelY = 0;
            }
            
            // Update aim angle even during knockback
            if (typeof input.aimAngle === 'number') {
                player.aimAngle = input.aimAngle;
            }
            return; // Skip normal movement during knockback
        }
        
        // Handle WASD movement
        if (input.keys.KeyW) vy -= 1;
        if (input.keys.KeyS) vy += 1;
        if (input.keys.KeyA) vx -= 1;
        if (input.keys.KeyD) vx += 1;
        
        // Normalize diagonal movement
        if (vx !== 0 && vy !== 0) {
            const mag = Math.sqrt(vx * vx + vy * vy);
            vx /= mag;
            vy /= mag;
        }
        
        // Use server-authoritative sprint state from stamina system
        const sprinting = player.serverSprintActive || false;
        let actualSpeed = sprinting ? speed * 2 : speed;
        
        // Apply dash speed boost (overrides sprint, highest priority)
        if (player.dashActive && player.dashDuration > 0) {
            actualSpeed = speed * (player.dashSpeedMultiplier || 4.0);
            // Log every 3rd frame to avoid spam
            if (!player._dashLogCounter) player._dashLogCounter = 0;
            player._dashLogCounter++;
            if (player._dashLogCounter % 3 === 0) {
                console.log(`[Server] Ã°Å¸â€™Â¨ DASH MOVEMENT: Player ${player.id} | BaseSpeed: ${speed} | DashSpeed: ${actualSpeed} | Multiplier: ${player.dashSpeedMultiplier}x | Duration left: ${player.dashDuration.toFixed(3)}s | Position: (${player.x.toFixed(1)}, ${player.y.toFixed(1)})`);
            }
        } else {
            player._dashLogCounter = 0;
        }
        
        // Apply boomer puke pool slow (50% speed reduction)
        if (player._svSlowed) {
            actualSpeed *= 0.5;
        }
        
        // Apply ensnare slow (40% speed reduction when ensnared by Licker)
        if (player._ensnaredTimer && player._ensnaredTimer > 0) {
            actualSpeed *= 0.6;
        }
        
        // Apply basic zombie melee slow (15% per zombie, stacks up to 5 zombies for 75% max slow, 0.5s linger)
        // Check in real-time during movement, not from previous frame's contact damage
        let basicZombieSlowCount = 0;
        if (this.room.enemies && this.room.enemies.size > 0) {
            const pr = player.radius || 26;
            const px = Number(player.x) || 0;
            const py = Number(player.y) || 0;
            
            for (const [, enemy] of this.room.enemies) {
                if (!enemy || enemy.alive === false) continue;
                if (enemy.type !== 'basic') continue;
                
                const er = Number.isFinite(enemy.radius) ? enemy.radius : 26;
                const sumR = er + pr;
                const dx = px - (Number(enemy.x) || 0);
                const dy = py - (Number(enemy.y) || 0);
                const distSq = dx * dx + dy * dy;
                
                // Check if zombie is in melee range
                if (distSq <= sumR * sumR) {
                    basicZombieSlowCount++;
                }
            }
        }

        // Initialize slow state if needed
        if (!player._basicZombieSlow) player._basicZombieSlow = { timer: 0, count: 0 };
        
        if (basicZombieSlowCount > 0) {
            const slowPerZombie = 0.15; // 15% slow per zombie
            const maxZombies = 5; // Cap at 5 zombies for max effect
            const zombieCount = Math.min(basicZombieSlowCount, maxZombies);
            
            // Refresh timer and count when zombies are hitting
            player._basicZombieSlow.count = zombieCount;
            player._basicZombieSlow.timer = 0.5; // 0.5 second linger duration
            
            const slowMultiplier = 1 - (slowPerZombie * zombieCount); // 0.85 for 1 zombie, 0.25 for 5 zombies
            actualSpeed *= slowMultiplier;
        } else {
            // Decay timer when no zombies in range, but keep applying slow until timer expires
            if (player._basicZombieSlow.timer > 0) {
                player._basicZombieSlow.timer -= deltaTime;
                if (player._basicZombieSlow.timer <= 0) {
                    player._basicZombieSlow.timer = 0;
                    player._basicZombieSlow.count = 0;
                } else {
                    // Still apply slow from previous zombie hits
                    const slowPerZombie = 0.15;
                    const maxZombies = 5;
                    const zombieCount = Math.min(player._basicZombieSlow.count, maxZombies);
                    const slowMultiplier = 1 - (slowPerZombie * zombieCount);
                    actualSpeed *= slowMultiplier;
                }
            }
        }
        
        // Apply weapon 8 ADS slow (40% speed when aiming down sights)
        // Set player property for consistent pattern with other slows
        player._weapon8ADS = (input && input.isWeapon8ADS === true);
        if (player._weapon8ADS) {
            actualSpeed *= 0.4;
        }
        
        // Apply environment hazard speed multiplier (set each frame by hazards.update)
        if (Number.isFinite(player._hazardSpeedMul) && player._hazardSpeedMul > 0 && player._hazardSpeedMul !== 1) {
            actualSpeed *= player._hazardSpeedMul;
        }

        // Calculate movement delta
        const dx = vx * actualSpeed * deltaTime;
        const dy = vy * actualSpeed * deltaTime;
        const intendedPos = { x: player.x + dx, y: player.y + dy };
        
        // Apply collision detection using server environment (must match client exactly)
        if (this.room.environment && this.room.environment.resolveCircleMove && (dx !== 0 || dy !== 0)) {
            const radius = player.radius || 26; // Default player radius
            
            // Substep large movements (dash/sprint/low-FPS spikes) to prevent tunneling through thin/rotated walls
            const moveDist = Math.hypot(dx, dy);
            const maxStepSize = 10; // pixels per substep (smaller = safer, more CPU)
            const steps = Math.max(1, Math.ceil(moveDist / maxStepSize));
            const stepX = dx / steps;
            const stepY = dy / steps;
            
            let currentX = player.x;
            let currentY = player.y;
            let mergedHits = null;
            const addHits = (hits) => {
                if (!Array.isArray(hits) || hits.length === 0) return;
                if (!mergedHits) mergedHits = [];
                for (let i = 0; i < hits.length && mergedHits.length < 6; i++) mergedHits.push(hits[i]);
            };
            
            for (let i = 0; i < steps; i++) {
                const stepRes = (typeof this.room.environment.resolveCircleMoveWithHits === 'function')
                    ? this.room.environment.resolveCircleMoveWithHits(currentX, currentY, radius, stepX, stepY)
                    : this.room.environment.resolveCircleMove(currentX, currentY, radius, stepX, stepY);
                
                currentX = stepRes.x;
                currentY = stepRes.y;
                addHits(stepRes.hits);
            }
            
            const resolved = { x: currentX, y: currentY };
            if (mergedHits) resolved.hits = mergedHits;
            
            // Debug: Track collision detection
            this.serverDebugger.serverCollisionDetection(
                player.id, 
                beforePos, 
                intendedPos, 
                resolved, 
                this.room.scene,
                this.room.environment.obstacles?.length || 0
            );

            // Record "blocked by" details for client-side debugging when collision reduces movement
            try {
                const intendedDist = Math.hypot(dx, dy);
                const actualDx = resolved.x - beforePos.x;
                const actualDy = resolved.y - beforePos.y;
                const actualDist = Math.hypot(actualDx, actualDy);
                const blocked = (
                    (Math.abs((resolved.x || 0) - (intendedPos.x || 0)) > 0.25) ||
                    (Math.abs((resolved.y || 0) - (intendedPos.y || 0)) > 0.25) ||
                    (intendedDist > 0.001 && actualDist < intendedDist * 0.85)
                );
                if (blocked) {
                    const hits = Array.isArray(resolved.hits) ? resolved.hits.slice(0, 6) : [];
                    player._blockedBy = {
                        t: Date.now(),
                        intended: { x: intendedPos.x, y: intendedPos.y },
                        resolved: { x: resolved.x, y: resolved.y },
                        hits
                    };
                } else {
                    // Decay stale blockedBy info quickly to avoid false positives
                    if (player._blockedBy && (Date.now() - (player._blockedBy.t || 0)) > 200) {
                        player._blockedBy = null;
                    }
                }
            } catch(_) {}
            
            player.x = resolved.x;
            player.y = resolved.y;
        } else {
            // Fallback: direct movement without collision (shouldn't happen in normal gameplay)
            player.x += dx;
            player.y += dy;
            
            // Basic boundary enforcement as fallback
            const boundary = this.room.boundary;
            player.x = Math.max(-boundary, Math.min(boundary, player.x));
            player.y = Math.max(-boundary, Math.min(boundary, player.y));
        }
        
        // Debug: Track final movement calculation
        const afterPos = { x: player.x, y: player.y };
        this.serverDebugger.serverMovementCalculation(player.id, beforePos, afterPos, deltaTime, input, sprinting);
        
        // Update breadcrumb trail
        this.updateBreadcrumbs(player, beforePos, afterPos);
        
        // Update aim angle
        if (typeof input.aimAngle === 'number') {
            player.aimAngle = input.aimAngle;
        }
    }

    // =========================================
    // BREADCRUMB TRAIL (Trench Raid Mode)
    // =========================================

    updateBreadcrumbs(player, beforePos, afterPos) {
        // Only track breadcrumbs in Trench Raid mode
        if (this.room.scene !== 'level' || this.room.levelType !== 'trenchraid') {
            return;
        }
        
        // Calculate distance moved this frame
        const distMoved = Math.hypot(afterPos.x - beforePos.x, afterPos.y - beforePos.y);
        
        // Update total distance moved
        player.totalDistanceMoved += distMoved;
        
        // Only start tracking breadcrumbs after 100 units of movement
        if (player.totalDistanceMoved < 100) {
            return;
        }
        
        // Initialize breadcrumbs array if needed
        if (!player.breadcrumbs) {
            player.breadcrumbs = [];
            player.lastBreadcrumbX = beforePos.x;
            player.lastBreadcrumbY = beforePos.y;
        }
        
        // Add breadcrumb if player has moved at least 300 units from last breadcrumb (1/10th rate)
        const distFromLastCrumb = Math.hypot(afterPos.x - player.lastBreadcrumbX, afterPos.y - player.lastBreadcrumbY);
        
        if (distFromLastCrumb >= 300) {
            // Add new breadcrumb point
            player.breadcrumbs.push({ x: afterPos.x, y: afterPos.y });
            player.lastBreadcrumbX = afterPos.x;
            player.lastBreadcrumbY = afterPos.y;
            
            // Simplify the path every 10 breadcrumbs to remove redundant waypoints
            if (player.breadcrumbs.length >= 10 && player.breadcrumbs.length % 10 === 0) {
                player.breadcrumbs = this._simplifyBreadcrumbPath(player.breadcrumbs);
            }
            
            // Limit breadcrumbs to last 200 points to prevent memory issues
            if (player.breadcrumbs.length > 200) {
                player.breadcrumbs.shift();
            }
        }
    }

    // Helper method: Simplify breadcrumb path using line-of-sight checks
    // Removes waypoints that can be skipped without hitting obstacles
    _simplifyBreadcrumbPath(breadcrumbs) {
        if (breadcrumbs.length <= 2) return breadcrumbs;
        
        const simplified = [breadcrumbs[0]]; // Always keep first point
        
        for (let i = 1; i < breadcrumbs.length - 1; i++) {
            const prev = simplified[simplified.length - 1];
            const current = breadcrumbs[i];
            const next = breadcrumbs[i + 1];
            
            // Check if we can skip current waypoint (direct line from prev to next)
            const canSkip = this._hasLineOfSight(prev, next);
            
            if (!canSkip) {
                // This waypoint is necessary (blocks line of sight)
                simplified.push(current);
            }
            // If canSkip is true, we omit current waypoint (path goes directly from prev to next)
        }
        
        // Always keep last point
        simplified.push(breadcrumbs[breadcrumbs.length - 1]);
        
        return simplified;
    }

    // Check if there's a clear line of sight between two points (no obstacles blocking)
    _hasLineOfSight(pointA, pointB) {
        if (!this.room.environment || !this.room.environment.obstacles) {
            return true; // No obstacles, always clear
        }
        
        // Sample points along the line and check for collisions
        const dx = pointB.x - pointA.x;
        const dy = pointB.y - pointA.y;
        const dist = Math.hypot(dx, dy);
        const steps = Math.ceil(dist / 50); // Check every 50 units
        
        for (let i = 1; i < steps; i++) {
            const t = i / steps;
            const checkX = pointA.x + dx * t;
            const checkY = pointA.y + dy * t;
            
            // Check if this point collides with any obstacle
            // Using a small radius to represent player size
            const testRadius = 30;
            
            // Check circular obstacles
            for (const obs of this.room.environment.obstacles) {
                const obstacleDistSq = (checkX - obs.x) ** 2 + (checkY - obs.y) ** 2;
                const minDist = obs.radius + testRadius;
                if (obstacleDistSq < minDist * minDist) {
                    return false; // Collision detected
                }
            }
            
            // Check oriented boxes (walls, barriers)
            if (this.room.environment.orientedBoxes) {
                for (const box of this.room.environment.orientedBoxes) {
                    // Skip shield walls (they're temporary player abilities)
                    if (box._abilityId) continue;
                    
                    // Simple AABB check for axis-aligned boxes
                    if (box.angle === 0 || box.angle === undefined) {
                        const halfW = box.w / 2;
                        const halfH = box.h / 2;
                        
                        if (checkX >= box.x - halfW - testRadius &&
                            checkX <= box.x + halfW + testRadius &&
                            checkY >= box.y - halfH - testRadius &&
                            checkY <= box.y + halfH + testRadius) {
                            return false; // Collision detected
                        }
                    }
                    // For rotated boxes, use more complex check
                    else {
                        // Simplified rotated rectangle check
                        const cos = Math.cos(-box.angle);
                        const sin = Math.sin(-box.angle);
                        const relX = checkX - box.x;
                        const relY = checkY - box.y;
                        const rotX = relX * cos - relY * sin;
                        const rotY = relX * sin + relY * cos;
                        
                        const halfW = box.w / 2;
                        const halfH = box.h / 2;
                        
                        if (Math.abs(rotX) <= halfW + testRadius &&
                            Math.abs(rotY) <= halfH + testRadius) {
                            return false; // Collision detected
                        }
                    }
                }
            }
        }
        
        return true; // No collisions, line of sight is clear
    }
}

module.exports = PlayerPhysicsManager;
