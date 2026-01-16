// Proximity Mine - Weapon 2 Secondary (2 blood markers)
// Placeable explosive that detonates when enemies get close
class ProximityMine extends AbilityBase {
    constructor(player, placementX, placementY, progression = null) {
        // Apply size multiplier from progression
        const mineSizeMultiplier = progression?.mineSizeMultiplier || 1.0;
        const baseRadius = 15;
        const mineRadius = baseRadius * mineSizeMultiplier;
        
        super(placementX, placementY, player, {
            maxLife: null, // Lives until destroyed or triggered
            color: '#ff6b00', // Orange
            radius: mineRadius
        });
        
        // Damageable properties
        this.healthMax = 20;
        this.health = this.healthMax;
        
        // Detection properties
        this.detectionRadius = 200; // Larger radius for more warning time (Boomer uses 220)
        this.detecting = false; // True when enemy in range
        this.closestEnemyDist = Infinity; // Track closest enemy for pulse speed
        this.beepTime = 0;
        this.beepInterval = 0.5; // Beep every 0.5 seconds
        
        // Explosion properties (apply explosion multiplier from progression)
        const mineExplosionMultiplier = progression?.mineExplosionMultiplier || 1.0;
        const baseExplosionRadius = 300; // 3x weapon 2 base explosion radius
        const baseExplosionDamage = 95 * 2; // 2x weapon 2 base max damage
        
        this.explosionRadius = baseExplosionRadius * mineExplosionMultiplier;
        this.explosionDamage = baseExplosionDamage * mineExplosionMultiplier;
        this.triggered = false;
        
        // Lifetime properties - mines self-destruct after 30 seconds
        this.lifetime = 30.0; // Total lifetime in seconds
        this.warningTime = 3.0; // Start warning 3 seconds before expiry
        this.timeAlive = 0; // Track how long mine has been alive
        this.forcedWarning = false; // Flag for lifetime warning
    }
    
    takeDamage(amount) {
        if (!this.alive || this.triggered) return;
        
        this.health -= amount;
        console.log('[ProximityMine] Took', amount, 'damage, health:', this.health);
        
        if (this.health <= 0) {
            this.health = 0;
            this.explode();
        }
    }
    
    update(dt, environment, enemies, players) {
        if (!this.alive || this.triggered) return;
        
        super.update(dt, environment, enemies, players);
        
        // Track lifetime and force warning/explosion when time is up
        this.timeAlive += dt;
        
        // Check if mine should self-destruct
        if (this.timeAlive >= this.lifetime) {
            console.log('[ProximityMine] Lifetime expired, self-destructing');
            this.explode();
            return;
        }
        
        // Force warning state in last few seconds of life
        const timeRemaining = this.lifetime - this.timeAlive;
        if (timeRemaining <= this.warningTime && !this.forcedWarning) {
            console.log('[ProximityMine] Entering forced warning state - ', timeRemaining.toFixed(1), 'seconds remaining');
            this.forcedWarning = true;
            this.beepTime = 0; // Reset beep timer for clean warning sequence
        }
        
        // Check for enemies in detection radius and track closest
        this.detecting = false;
        this.closestEnemyDist = Infinity;
        
        if (enemies && enemies.queryCircle) {
            // Pad query radius to include large enemies (BigBoy radius 80). queryCircle() is center-distance based,
            // but detection/hits use (detectionRadius + enemy.radius).
            const nearbyEnemies = enemies.queryCircle(this.x, this.y, this.detectionRadius + 80);
            if (nearbyEnemies && nearbyEnemies.length > 0) {
                // At least one enemy in range, find closest
                for (let i = 0; i < nearbyEnemies.length; i++) {
                    const e = nearbyEnemies[i];
                    if (e.alive) {
                        this.detecting = true;
                        const dist = Math.hypot(e.x - this.x, e.y - this.y);
                        if (dist < this.closestEnemyDist) {
                            this.closestEnemyDist = dist;
                        }
                    }
                }
            }
        }
        
        // Check for players in detection radius (ONLY for PvP with hostile evil states)
        // Normal co-op players should NEVER trigger the mine
        if (players && Array.isArray(players)) {
            for (let i = 0; i < players.length; i++) {
                const p = players[i];
                if (!p || p === this.owner || p === window.player) continue; // Skip owner AND self
                
                // ONLY detect if player is hostile (different evil state in PvP)
                // Friendly co-op players will NOT trigger the mine
                if (this.isHostileTo(p)) {
                    const dist = Math.hypot(p.x - this.x, p.y - this.y);
                    if (dist <= this.detectionRadius + (p.radius || 0)) {
                        this.detecting = true;
                        // Track closest hostile player for pulse speed
                        if (dist < this.closestEnemyDist) {
                            this.closestEnemyDist = dist;
                        }
                    }
                }
            }
        }
        
        // Apply forced warning from lifetime expiry
        if (this.forcedWarning) {
            this.detecting = true;
            // Simulate close enemy for fast pulse during forced warning
            if (this.closestEnemyDist === Infinity) {
                this.closestEnemyDist = 50; // Close distance for urgent pulse
            }
        }
        
        // Only increment beepTime while actively detecting (enemy or lifetime warning)
        if (this.detecting) {
            this.beepTime += dt;
        } else {
            this.beepTime = 0; // Reset when not detecting
        }
        
        // Trigger explosion if enemy in range and beep completed (but NOT during forced warning - that uses lifetime)
        if (this.detecting && !this.forcedWarning && this.beepTime >= this.beepInterval * 3) {
            console.log('[ProximityMine] Enemy proximity triggered explosion');
            this.explode();
        }
    }
    
    explode() {
        if (this.triggered) return;
        this.triggered = true;
        this.alive = false;
        
        console.log('[ProximityMine] Exploding at', this.x, this.y, 'radius:', this.explosionRadius);
        
        // Create explosion VFX scaled to match actual explosion radius
        // ExplosionVfx flash is 90 units at scale 1.0
        // Mine explosion radius: 300 (loot 1-3) → 450 (loot 5+)
        if (window.projectiles && window.ExplosionVfx) {
            const baseExplosionVfxFlash = 90; // ExplosionVfx flash radius at scale 1.0
            const vfxScale = this.explosionRadius / baseExplosionVfxFlash;
            
            window.projectiles.impacts.push(new window.ExplosionVfx(
                this.x, 
                this.y, 
                this.color,
                { 
                    scale: vfxScale,
                    shockColor: '#ff8800',
                    sparkColor: '#ff4400'
                }
            ));
        }
        
        // Create damage pulse (server will handle authoritative damage)
        if (window.projectiles) {
            const finalX = this.x;
            const finalY = this.y;
            const explosionRadius = this.explosionRadius;
            const baseDamage = this.explosionDamage;
            
            window.projectiles.impacts.push({
                life: 0.3,
                totalLife: 0.3,
                radius: explosionRadius,
                hitEnemyIds: new Set(),
                hitPlayerIds: new Set(),
                owner: this.owner,
                draw: function(ctx, cam) {
                    const t = Math.max(this.life, 0) / this.totalLife;
                    const alpha = t * 0.4;
                    const sx = finalX - cam.x;
                    const sy = finalY - cam.y;
                    ctx.save();
                    ctx.globalAlpha = alpha;
                    ctx.fillStyle = '#ff6600';
                    ctx.beginPath();
                    ctx.arc(sx, sy, this.radius, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.restore();
                },
                update: function(dt, enemies) {
                    this.life -= dt;
                    
                    // Damage enemies
                    if (enemies && enemies.queryCircle) {
                        // Pad query radius to include large enemies (BigBoy radius 80) since we later test
                        // against (this.radius + e.radius). queryCircle() is center-distance based.
                        const victims = enemies.queryCircle(finalX, finalY, this.radius + 80);
                        for (let i = 0; i < victims.length; i++) {
                            const e = victims[i];
                            if (!e || !e.alive) continue;
                            if (this.hitEnemyIds.has(e.id)) continue;
                            
                            const dist = Math.hypot(e.x - finalX, e.y - finalY);
                            if (dist <= this.radius + (e.radius || 0)) {
                                // Damage falloff from center
                                const inner = 50;
                                const outer = this.radius;
                                let t = (dist - inner) / Math.max(1e-6, (outer - inner));
                                t = Math.max(0, Math.min(1, t));
                                const damage = baseDamage - (baseDamage * 0.5 * t);
                                
                                e.applyDamage(damage, { 
                                    x: finalX, 
                                    y: finalY, 
                                    dirX: (e.x - finalX) / dist, 
                                    dirY: (e.y - finalY) / dist 
                                });
                                
                                this.hitEnemyIds.add(e.id);
                            }
                        }
                    }
                    
                    // Damage players (PvP)
                    if (window.player && !this.hitPlayerIds.has(window.player.id)) {
                        const p = window.player;
                        const dist = Math.hypot(p.x - finalX, p.y - finalY);
                        if (dist <= this.radius + (p.radius || 0)) {
                            // Check if mine is hostile to this player
                            try {
                                const ownerEvil = window.networkManager?.remotePlayerEvilStates?.get(this.owner?.id) || 
                                                 (this.owner === window.player && window.__killThemAllLocked === true);
                                const playerEvil = (p === window.player && window.__killThemAllLocked === true);
                                
                                if (ownerEvil !== playerEvil) {
                                    // Damage falloff
                                    const inner = 50;
                                    const outer = this.radius;
                                    let t = (dist - inner) / Math.max(1e-6, (outer - inner));
                                    t = Math.max(0, Math.min(1, t));
                                    const damage = baseDamage - (baseDamage * 0.5 * t);
                                    
                                    p.health -= damage;
                                    if (p.health < 0) p.health = 0;
                                    
                                    this.hitPlayerIds.add(p.id);
                                    console.log('[ProximityMine] PvP damage:', damage, 'to player');
                                }
                            } catch(_) {}
                        }
                    }
                }
            });
        }
        
        // Notify server of explosion
        if (window.networkManager && this.owner === window.player && this._serverId) {
            window.networkManager.socket.emit('abilityTrigger', {
                serverId: this._serverId,
                type: 'explosion',
                x: this.x,
                y: this.y
            });
        }
    }
    
    draw(ctx, camera) {
        if (!this.alive) return;
        
        const sx = this.x - camera.x;
        const sy = this.y - camera.y;
        
        ctx.save();
        
        // Check if hostile to local player
        const isHostile = this.isHostileTo(window.player);
        
        // Calculate pulse (replicating Boomer warning ring behavior)
        let pulse = 0;
        let armed = false;
        let mineColor = '#ff9800'; // True orange color (255, 152, 0)
        let coreColor = '#ffff00'; // Bright yellow core
        let flashing = this.detecting; // Always set flashing based on detecting state
        
        if (this.detecting) {
            const beepProgress = this.beepTime / (this.beepInterval * 3);
            
            // Calculate closeness (0 = far, 1 = very close) like Boomer
            const trigger = this.detectionRadius;
            const closeness = Math.max(0, Math.min(1, (trigger - this.closestEnemyDist) / trigger));
            
            // Pulse frequency increases with closeness (like Boomer)
            const freq = (3 + 7 * closeness) * 0.25;
            pulse = Math.max(0, Math.min(1, (Math.sin(this.age * freq * Math.PI * 2) * 0.5 + 0.5)));
            
            // Turn red when about to explode (last 30% of arm time)
            if (beepProgress > 0.7) {
                armed = true;
                mineColor = '#ff3b3b'; // Bright red like Boomer
                coreColor = '#ffaa00';
                pulse = 1; // Steady bright when about to explode
            } else {
                mineColor = '#ff9800'; // True orange when detecting
                coreColor = '#ffff00'; // Bright yellow core
            }
        } else {
            // Very slow idle pulse
            const freq = 0.5;
            pulse = Math.max(0, Math.min(1, (Math.sin(this.age * freq * Math.PI * 2) * 0.5 + 0.5)));
        }
        
        // Draw warning ring when detecting (like Boomer)
        if (flashing) {
            ctx.globalAlpha = armed ? 0.6 : (0.25 + 0.45 * pulse);
            ctx.strokeStyle = armed ? '#ff3b3b' : mineColor;
            ctx.lineWidth = 3;
            ctx.beginPath();
            // Ring radius pulses like Boomer
            ctx.arc(sx, sy, armed ? (this.radius + 10) : (this.radius + 6 + pulse * 6), 0, Math.PI * 2);
            ctx.stroke();
        }
        
        // Draw mine body (orange base)
        ctx.globalAlpha = 1;
        ctx.fillStyle = mineColor;
        ctx.beginPath();
        ctx.arc(sx, sy, this.radius, 0, Math.PI * 2);
        ctx.fill();
        
        // Draw simple yellow additive glow overlay (pulses from 20% to 130%)
        ctx.shadowBlur = 0;
        ctx.globalCompositeOperation = 'lighter'; // Additive blending
        
        // Remap pulse (0-1) to glowIntensity (0.2-1.3) for overdrive effect
        const glowIntensity = 0.2 + pulse * 1.1;
        
        const glowRadius = this.radius * 0.8;
        const glowGrad = ctx.createRadialGradient(sx, sy, 0, sx, sy, glowRadius);
        glowGrad.addColorStop(0, 'rgba(255,255,0,' + (glowIntensity * 0.8) + ')'); // Yellow center (16%-104%)
        glowGrad.addColorStop(0.6, 'rgba(255,255,0,' + (glowIntensity * 0.4) + ')'); // Fade (8%-52%)
        glowGrad.addColorStop(1, 'rgba(255,255,0,0)'); // Transparent edge
        
        ctx.fillStyle = glowGrad;
        ctx.beginPath();
        ctx.arc(sx, sy, glowRadius, 0, Math.PI * 2);
        ctx.fill();
        
        ctx.globalCompositeOperation = 'source-over'; // Reset blending
        
        // Draw health bar
        ctx.globalAlpha = 1;
        if (this.health < this.healthMax) {
            const barW = 30;
            const barH = 4;
            const barX = sx - barW / 2;
            const barY = sy - this.radius - 10;
            
            ctx.shadowBlur = 0;
            ctx.fillStyle = 'rgba(0,0,0,0.5)';
            ctx.fillRect(barX, barY, barW, barH);
            
            const healthPct = this.health / this.healthMax;
            ctx.fillStyle = healthPct > 0.5 ? '#00ff00' : (healthPct > 0.25 ? '#ffff00' : '#ff0000');
            ctx.fillRect(barX, barY, barW * healthPct, barH);
            
            ctx.strokeStyle = 'rgba(0,0,0,0.7)';
            ctx.lineWidth = 1;
            ctx.strokeRect(barX, barY, barW, barH);
        }
        
        ctx.restore();
    }
    
    onExpire() {
        // Mines don't expire naturally, only by damage or trigger
    }
}

window.ProximityMine = ProximityMine;

