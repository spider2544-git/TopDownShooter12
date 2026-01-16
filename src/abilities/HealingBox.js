// Healing Box - Weapon 3 Secondary (2 blood markers)
// Placeable healing station that heals players over time
class HealingBox extends AbilityBase {
    constructor(player, placementX, placementY, progression = null) {
        super(placementX, placementY, player, {
            maxLife: 90, // 90 second timer
            color: '#00ff00', // Green
            radius: 20
        });
        
        // Apply progression scaling (default to loot 0 values if no progression)
        const healAmount = progression?.healAmount || 50;
        const diameterMultiplier = progression?.healDiameterMultiplier || 1.0;
        const baseHealRadius = 100;
        
        // Damageable properties (box HP matches total heal amount: 50hp, 100hp, 150hp)
        this.healthMax = healAmount;
        this.health = this.healthMax;
        
        // Healing properties
        this.healRadius = baseHealRadius * diameterMultiplier;
        this.healAmount = healAmount / 10; // Heal 10% of total per tick (50hp = 5/tick, 100hp = 10/tick, 150hp = 15/tick)
        this.healInterval = 1.0; // Heal every 1 second
        this.healthCostPerHeal = healAmount / 10; // Box loses same amount it heals per tick
        
        // Visual properties
        this.pulseTime = 0;
        this.isActivelyHealing = false;
        
        // Floating heal VFX system
        this.healVfxQueue = []; // Queue of pending heal VFX to emit
        this.healVfxTimer = 0; // Timer for emitting next VFX
        
        // Death animation
        this.dying = false;
        this.deathTime = 0;
        this.deathDuration = 0.5;
    }
    
    takeDamage(amount) {
        if (!this.alive || this.dying) return;
        
        this.health -= amount;
        console.log('[HealingBox] Took', amount, 'damage, health:', this.health);
        
        if (this.health <= 0) {
            this.health = 0;
            this.startDeath();
        }
    }
    
    startDeath() {
        if (this.dying) return;
        this.dying = true;
        this.deathTime = 0;
        console.log('[HealingBox] Starting death animation');
    }
    
    update(dt, environment, enemies, players) {
        if (!this.alive) return;
        
        // Handle death animation
        if (this.dying) {
            this.deathTime += dt;
            if (this.deathTime >= this.deathDuration) {
                this.alive = false;
                this.spawnDeathParticles();
            }
            return;
        }
        
        super.update(dt, environment, enemies, players);
        
        this.pulseTime += dt * 3;
        
        // Update floating heal VFX queue (trickle out +'s over time)
        if (this.healVfxQueue.length > 0) {
            this.healVfxTimer -= dt;
            if (this.healVfxTimer <= 0) {
                // Emit one + VFX
                this.spawnHealVfx();
                this.healVfxQueue.shift(); // Remove from queue
                
                // Set timer for next VFX (spread evenly over heal interval)
                if (this.healVfxQueue.length > 0) {
                    this.healVfxTimer = this.healInterval / (this.healVfxQueue.length + 1);
                }
            }
        }
        
        // Check if any valid players are in heal radius (for visual pulse)
        this.isActivelyHealing = false;
        if (players && Array.isArray(players)) {
            for (let i = 0; i < players.length; i++) {
                const p = players[i];
                if (!p) continue;
                
                // Skip evil players (they can't be healed)
                const isEvil = (p === window.player && window.__killThemAllLocked === true) ||
                              window.networkManager?.remotePlayerEvilStates?.get(p.id);
                if (isEvil) continue;
                
                // Check if player is in range and not at full health
                const dist = Math.hypot(p.x - this.x, p.y - this.y);
                if (dist <= this.healRadius && p.health < p.healthMax) {
                    this.isActivelyHealing = true;
                    break;
                }
            }
        }
    }
    
    // Queue up heal VFX to be emitted over time (called when healing happens)
    queueHealVfx(amount) {
        // Add one entry per HP healed (so 5 HP = 5 separate + VFX)
        for (let i = 0; i < amount; i++) {
            this.healVfxQueue.push(1);
        }
        
        // Start timer immediately if not already running
        if (this.healVfxTimer <= 0 && this.healVfxQueue.length > 0) {
            this.healVfxTimer = 0.05; // Small delay before first VFX
        }
    }
    
    // Spawn a single floating + VFX rising from the box
    spawnHealVfx() {
        if (!window.enqueueDamageText) return;
        
        // Random horizontal spread (like smoke rising)
        const spreadX = (Math.random() - 0.5) * 40; // -20 to +20 units horizontal drift
        const spreadY = Math.random() * 15; // 0-15 units upward variation
        
        window.enqueueDamageText({
            x: this.x + spreadX,
            y: this.y - this.radius - spreadY,
            text: '+',
            color: '#00ff00',
            crit: false,
            life: 1.5,
            vy: -50 - Math.random() * 30, // Rise up with variation
            vx: spreadX * 2, // Continue drifting horizontally
            spread: false // Don't apply additional spread since we're doing custom
        });
    }
    
    spawnDeathParticles() {
        // Spawn green sparkle particles on death
        if (window.projectiles) {
            for (let i = 0; i < 8; i++) {
                const angle = (Math.PI * 2 * i) / 8;
                const speed = 50 + Math.random() * 50;
                const vx = Math.cos(angle) * speed;
                const vy = Math.sin(angle) * speed;
                
                window.projectiles.impacts.push({
                    x: this.x,
                    y: this.y,
                    vx: vx,
                    vy: vy,
                    life: 0.5,
                    totalLife: 0.5,
                    radius: 3,
                    color: '#00ff00',
                    draw: function(ctx, cam) {
                        const t = this.life / this.totalLife;
                        const sx = this.x - cam.x;
                        const sy = this.y - cam.y;
                        ctx.save();
                        ctx.globalAlpha = t;
                        ctx.fillStyle = this.color;
                        ctx.shadowColor = this.color;
                        ctx.shadowBlur = 8;
                        ctx.beginPath();
                        ctx.arc(sx, sy, this.radius, 0, Math.PI * 2);
                        ctx.fill();
                        ctx.restore();
                    },
                    update: function(dt) {
                        this.life -= dt;
                        this.x += this.vx * dt;
                        this.y += this.vy * dt;
                        this.vx *= 0.95; // Friction
                        this.vy *= 0.95;
                    }
                });
            }
        }
    }
    
    draw(ctx, camera) {
        if (!this.alive) return;
        
        const sx = this.x - camera.x;
        const sy = this.y - camera.y;
        
        ctx.save();
        
        // Calculate death fade
        let deathAlpha = 1.0;
        let deathScale = 1.0;
        if (this.dying) {
            const t = this.deathTime / this.deathDuration;
            deathAlpha = 1.0 - t;
            deathScale = 1.0 - t * 0.5; // Shrink to 50%
        }
        
        // Draw healing radius circle with fill and stroke
        const pulse = this.isActivelyHealing ? (0.5 + Math.sin(this.pulseTime) * 0.3) : 0.15;
        
        // Draw filled circle (always visible, very subtle green - 75% less intense)
        ctx.globalAlpha = 0.04 * deathAlpha;
        ctx.fillStyle = '#00ff00';
        ctx.beginPath();
        ctx.arc(sx, sy, this.healRadius * deathScale, 0, Math.PI * 2);
        ctx.fill();
        
        // Draw stroke (dotted or solid depending on healing state)
        ctx.globalAlpha = (this.isActivelyHealing ? (0.6 + pulse * 0.4) : 0.4) * deathAlpha;
        ctx.strokeStyle = this.isActivelyHealing ? '#00ff00' : '#00ff00';
        ctx.lineWidth = this.isActivelyHealing ? 3 : 2;
        ctx.setLineDash(this.isActivelyHealing ? [] : [10, 10]);
        ctx.beginPath();
        ctx.arc(sx, sy, this.healRadius * deathScale, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        
        // Draw tight square glow around box edges when actively healing
        if (this.isActivelyHealing) {
            const boxSize = this.radius * 2 * deathScale;
            const glowExpand = 8 + pulse * 4; // Just a few pixels of glow expansion
            const glowAlpha = (0.15 + pulse * 0.1) * deathAlpha; // Much less opaque
            
            ctx.globalAlpha = glowAlpha;
            ctx.fillStyle = '#00ff00';
            ctx.shadowColor = '#00ff00';
            ctx.shadowBlur = 12 * pulse; // Tight glow falloff
            ctx.fillRect(
                sx - (boxSize / 2) - glowExpand / 2, 
                sy - (boxSize / 2) - glowExpand / 2, 
                boxSize + glowExpand, 
                boxSize + glowExpand
            );
            ctx.shadowBlur = 0;
        }
        
        // Draw box body (green square)
        ctx.globalAlpha = deathAlpha;
        const boxSize = this.radius * 2 * deathScale;
        
        // Shadow/glow when actively healing
        if (this.isActivelyHealing) {
            ctx.shadowColor = '#00ff00';
            ctx.shadowBlur = 15 * deathAlpha;
        }
        
        ctx.fillStyle = this.color;
        ctx.fillRect(sx - boxSize / 2, sy - boxSize / 2, boxSize, boxSize);
        
        // Draw white + sign
        ctx.shadowBlur = 0;
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 4 * deathScale;
        ctx.lineCap = 'round';
        
        const crossSize = boxSize * 0.5;
        // Vertical line
        ctx.beginPath();
        ctx.moveTo(sx, sy - crossSize / 2);
        ctx.lineTo(sx, sy + crossSize / 2);
        ctx.stroke();
        
        // Horizontal line
        ctx.beginPath();
        ctx.moveTo(sx - crossSize / 2, sy);
        ctx.lineTo(sx + crossSize / 2, sy);
        ctx.stroke();
        
        // Draw health bar (if not at full health and not dying)
        if (!this.dying && this.health < this.healthMax) {
            const barW = 40;
            const barH = 5;
            const barX = sx - barW / 2;
            const barY = sy - this.radius - 15;
            
            ctx.globalAlpha = 0.8;
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
        // Spawn particles when timer expires
        this.spawnDeathParticles();
    }
}

window.HealingBox = HealingBox;

