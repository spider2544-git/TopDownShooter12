// Enemy Attractor - Weapon 6 Secondary (6 blood markers)
// Arc-thrown crucifix that attracts enemies to attack it instead of players
class EnemyAttractor extends AbilityBase {
    constructor(player, placementX, placementY) {
        super(placementX, placementY, player, {
            maxLife: 7.5, // 7.5 seconds duration (50% increase from 5)
            color: '#c9b037', // Gold color for crucifix
            radius: 20
        });
        
        // Damageable properties (50% increase)
        this.healthMax = 450; // Was 300
        this.health = this.healthMax;
        
        // Health drains over time (450 HP / 7.5 seconds = 60 HP/s)
        this.healthDrainRate = 60;
        
        // Get radius multipliers from player's loot progression
        const lootLevel = player?.lootLevel || 0;
        const progression = (typeof window !== 'undefined' && window.getWeaponProgression) 
            ? window.getWeaponProgression(5, lootLevel) 
            : {};
        const attractionRadiusMultiplier = progression.secondary?.attractionRadiusMultiplier || 1.0;
        
        // Attraction properties (scaled by loot progression)
        const baseAttractionRadius = 200;
        this.attractionRadius = baseAttractionRadius * attractionRadiusMultiplier;
        
        // Visual properties
        this.rotation = 0; // Rotating crucifix
        this.pulseTime = 0;
    }
    
    takeDamage(amount) {
        if (!this.alive) return;
        
        this.health -= amount;
        console.log('[EnemyAttractor] Took', amount, 'damage, health:', this.health);
        
        if (this.health <= 0) {
            this.health = 0;
            this.alive = false;
            this.onExpire();
        }
    }
    
    update(dt, environment, enemies, players) {
        if (!this.alive) return;
        
        super.update(dt, environment, enemies, players);
        
        // Drain health over time
        this.health -= this.healthDrainRate * dt;
        if (this.health <= 0) {
            this.health = 0;
            this.alive = false;
            this.onExpire();
            return;
        }
        
        // Update visual animations
        this.pulseTime += dt;
    }
    
    draw(ctx, camera) {
        if (!this.alive) return;
        
        const sx = this.x - camera.x;
        const sy = this.y - camera.y;
        
        ctx.save();
        
        // Check if hostile to local player
        const isHostile = this.isHostileTo(window.player);
        
        // Draw inward-flowing attraction ripples (3 waves at different phases)
        const rippleCount = 3;
        const maxRippleRadius = this.attractionRadius * 0.75; // Don't go to full radius (150 units at 75%)
        const minRippleRadius = 25; // Start ripples from here
        
        for (let i = 0; i < rippleCount; i++) {
            // Phase offset for each ripple
            const phaseOffset = (i / rippleCount) * Math.PI * 2;
            const rippleProgress = ((this.pulseTime * 0.8 + phaseOffset / (Math.PI * 2)) % 1);
            
            // Ripples move INWARD (from large to small)
            const currentRadius = maxRippleRadius - (rippleProgress * (maxRippleRadius - minRippleRadius));
            
            // Fade in at start, fade out at end
            let alpha;
            if (rippleProgress < 0.1) {
                alpha = rippleProgress / 0.1; // Fade in
            } else if (rippleProgress > 0.9) {
                alpha = (1 - rippleProgress) / 0.1; // Fade out
            } else {
                alpha = 1;
            }
            alpha *= 0.2; // Overall transparency (50% of original 0.4)
            
            // Draw ripple ring (always gold, not red)
            ctx.globalAlpha = alpha;
            ctx.strokeStyle = '#d4af37'; // Always gold
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.arc(sx, sy, currentRadius, 0, Math.PI * 2);
            ctx.stroke();
            
            // Inner glow ring (slightly smaller, brighter)
            ctx.globalAlpha = alpha * 0.3; // 50% of original 0.6
            ctx.strokeStyle = isHostile ? '#ff8888' : '#ffeb3b';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.arc(sx, sy, currentRadius - 2, 0, Math.PI * 2);
            ctx.stroke();
        }
        
        // Draw attraction radius (pulsing circle)
        const pulse = Math.sin(this.pulseTime * 3) * 0.5 + 0.5; // 0-1
        ctx.globalAlpha = 0.15 + pulse * 0.15;
        ctx.strokeStyle = '#c9b037'; // Always gold
        ctx.lineWidth = 2;
        ctx.setLineDash([10, 10]);
        ctx.beginPath();
        ctx.arc(sx, sy, this.attractionRadius, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        
        // Draw crucifix (static, no rotation) - always gold/yellow (not red)
        ctx.globalAlpha = 1;
        ctx.translate(sx, sy);
        
        // Crucifix dimensions
        const crossWidth = this.radius * 0.4;
        const crossHeight = this.radius * 1.4;
        const horizontalBarY = -crossHeight * 0.15; // Move horizontal bar down (was -0.3)
        const horizontalBarWidth = this.radius * 1.2;
        
        // Draw crucifix glow (additive)
        ctx.shadowBlur = 15;
        ctx.shadowColor = '#d4af37'; // Always gold
        
        // Vertical bar - bright gold, extend top more, bottom much more
        ctx.fillStyle = '#d4af37'; // Gold color
        const verticalTop = -crossHeight * 0.65; // Start higher (was -0.5)
        const verticalBottom = crossHeight * 0.65; // End much lower for crucifix shape (was 0.35)
        ctx.fillRect(-crossWidth / 2, verticalTop, crossWidth, verticalBottom - verticalTop);
        
        // Horizontal bar - bright gold
        ctx.fillRect(-horizontalBarWidth / 2, horizontalBarY - crossWidth / 2, horizontalBarWidth, crossWidth);
        
        // Draw brighter inner cross for contrast (yellow core)
        ctx.shadowBlur = 0;
        ctx.fillStyle = '#ffeb3b'; // Bright yellow
        const innerScale = 0.6;
        ctx.fillRect(-crossWidth * innerScale / 2, verticalTop * innerScale, crossWidth * innerScale, (verticalBottom - verticalTop) * innerScale);
        ctx.fillRect(-horizontalBarWidth * innerScale / 2, horizontalBarY - crossWidth * innerScale / 2, horizontalBarWidth * innerScale, crossWidth * innerScale);
        
        ctx.translate(-sx, -sy);
        
        // Draw health bar
        if (this.health < this.healthMax) {
            const barW = 50;
            const barH = 5;
            const barX = sx - barW / 2;
            const barY = sy - this.radius - 15;
            
            ctx.shadowBlur = 0;
            ctx.fillStyle = 'rgba(0,0,0,0.6)';
            ctx.fillRect(barX, barY, barW, barH);
            
            const healthPct = this.health / this.healthMax;
            ctx.fillStyle = healthPct > 0.5 ? '#00ff00' : (healthPct > 0.25 ? '#ffff00' : '#ff0000');
            ctx.fillRect(barX, barY, barW * healthPct, barH);
            
            ctx.strokeStyle = 'rgba(0,0,0,0.8)';
            ctx.lineWidth = 1;
            ctx.strokeRect(barX, barY, barW, barH);
        }
        
        ctx.restore();
    }
    
    onExpire() {
        console.log('[EnemyAttractor] Expired at', this.x, this.y);
        
        // Create fade-out VFX with golden particles
        if (window.projectiles) {
            const finalX = this.x;
            const finalY = this.y;
            const finalRadius = this.radius;
            
            // Create golden particle burst
            for (let i = 0; i < 12; i++) {
                const angle = (i / 12) * Math.PI * 2;
                const speed = 50 + Math.random() * 50;
                const vx = Math.cos(angle) * speed;
                const vy = Math.sin(angle) * speed;
                
                window.projectiles.impacts.push({
                    x: finalX,
                    y: finalY,
                    vx: vx,
                    vy: vy,
                    life: 0.5 + Math.random() * 0.3,
                    totalLife: 0.8,
                    radius: 3,
                    color: '#d4af37',
                    draw: function(ctx, cam) {
                        const t = Math.max(this.life, 0) / this.totalLife;
                        const sx = this.x - cam.x;
                        const sy = this.y - cam.y;
                        ctx.save();
                        ctx.globalAlpha = t * 0.8;
                        ctx.fillStyle = this.color;
                        ctx.beginPath();
                        ctx.arc(sx, sy, this.radius * (1 + (1 - t) * 0.5), 0, Math.PI * 2);
                        ctx.fill();
                        ctx.restore();
                    },
                    update: function(dt) {
                        this.life -= dt;
                        this.x += this.vx * dt;
                        this.y += this.vy * dt;
                        this.vy += 150 * dt; // Gravity
                        this.vx *= 0.95; // Air resistance
                        this.vy *= 0.95;
                    }
                });
            }
        }
        
        // Notify server of destruction
        if (window.networkManager && this.owner === window.player && this._serverId) {
            window.networkManager.socket.emit('abilityDestroy', {
                serverId: this._serverId
            });
        }
    }
    
    // Check if this attractor is in range of a given position
    isInAttractionRange(x, y) {
        const dx = x - this.x;
        const dy = y - this.y;
        const dist = Math.hypot(dx, dy);
        return dist <= this.attractionRadius;
    }
}

window.EnemyAttractor = EnemyAttractor;

