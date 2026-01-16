// Client-side exploding barrel rendering and state management
class ExplodingBarrel {
    constructor(data) {
        this.id = data.id;
        this.x = data.x;
        this.y = data.y;
        this.health = data.health;
        this.healthMax = data.healthMax;
        this.explosionRadius = data.explosionRadius;
        this.explosionDamage = data.explosionDamage;
        this.visualRadius = data.visualRadius || 24;
        this.exploded = false;
        
        // Visual properties
        this.radius = this.visualRadius;
        this.baseColor = '#8B0000';      // Dark red
        this.highlightColor = '#cc2222'; // Brighter red
        this.rimColor = '#2d0a0a';       // Very dark rim
        this.warningColor = '#FF4444';   // Warning glow when damaged
        
        // Animation
        this.pulsePhase = Math.random() * Math.PI * 2;
        this.hitFlash = 0;
        this.hitFlashMax = 0.15;
    }
    
    takeDamage(amount) {
        if (this.exploded) return;
        this.health -= amount;
        this.hitFlash = this.hitFlashMax;
        
        if (this.health <= 0) {
            this.health = 0;
            this.exploded = true;
        }
    }
    
    update(dt) {
        if (this.hitFlash > 0) {
            this.hitFlash -= dt;
            if (this.hitFlash < 0) this.hitFlash = 0;
        }
        this.pulsePhase += dt * 2;
    }
    
    draw(ctx, camera) {
        if (this.exploded) return;
        
        const sx = this.x - camera.x;
        const sy = this.y - camera.y;
        const r = this.radius;
        
        ctx.save();
        
        // Danger pulse when damaged (health < 100%)
        const healthPct = this.health / this.healthMax;
        let pulse = 0;
        if (healthPct < 1) {
            // Pulse faster as health decreases
            const urgency = 1 + (1 - healthPct) * 4;
            pulse = 0.5 + Math.sin(this.pulsePhase * urgency) * 0.5;
        }
        
        // Warning glow when damaged
        if (healthPct < 1) {
            const glowAlpha = 0.3 + pulse * 0.4;
            ctx.globalAlpha = glowAlpha;
            ctx.fillStyle = this.warningColor;
            ctx.beginPath();
            ctx.arc(sx, sy, r + 8 + pulse * 4, 0, Math.PI * 2);
            ctx.fill();
        }
        
        ctx.globalAlpha = 1;
        
        // Barrel body (cylinder from top-down)
        // Dark rim
        ctx.fillStyle = this.rimColor;
        ctx.beginPath();
        ctx.arc(sx, sy, r + 2, 0, Math.PI * 2);
        ctx.fill();
        
        // Main barrel body
        ctx.fillStyle = this.baseColor;
        ctx.beginPath();
        ctx.arc(sx, sy, r, 0, Math.PI * 2);
        ctx.fill();
        
        // Metal bands (darker stripes)
        ctx.strokeStyle = this.rimColor;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(sx, sy, r * 0.6, 0, Math.PI * 2);
        ctx.stroke();
        
        // Highlight/shine
        ctx.fillStyle = this.highlightColor;
        ctx.globalAlpha = 0.4;
        ctx.beginPath();
        ctx.ellipse(sx - r * 0.3, sy - r * 0.3, r * 0.35, r * 0.25, -Math.PI / 4, 0, Math.PI * 2);
        ctx.fill();
        
        // Hazard symbol (flame icon)
        ctx.globalAlpha = 0.9;
        ctx.fillStyle = '#ffcc00';
        ctx.font = 'bold 14px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('🔥', sx, sy);
        
        // Hit flash overlay
        if (this.hitFlash > 0) {
            const t = this.hitFlash / this.hitFlashMax;
            ctx.globalAlpha = t * 0.8;
            ctx.fillStyle = '#ffffff';
            ctx.beginPath();
            ctx.arc(sx, sy, r, 0, Math.PI * 2);
            ctx.fill();
        }
        
        ctx.restore();
    }
}

// Barrel manager for client
class ExplodingBarrelManager {
    constructor() {
        this.barrels = new Map();
    }
    
    syncFromServer(barrelData) {
        if (!barrelData || !Array.isArray(barrelData)) return;
        
        // Update/add barrels from server state
        const serverIds = new Set();
        
        for (const data of barrelData) {
            serverIds.add(data.id);
            
            if (this.barrels.has(data.id)) {
                // Update existing
                const barrel = this.barrels.get(data.id);
                const oldHealth = barrel.health;
                barrel.health = data.health;
                barrel.x = data.x;
                barrel.y = data.y;
                
                // Trigger flash if health dropped
                if (data.health < oldHealth) {
                    barrel.hitFlash = barrel.hitFlashMax;
                }
            } else {
                // Create new
                this.barrels.set(data.id, new ExplodingBarrel(data));
            }
        }
        
        // Remove barrels that no longer exist
        for (const [id, barrel] of this.barrels) {
            if (!serverIds.has(id)) {
                this.barrels.delete(id);
            }
        }
    }
    
    handleExplosion(data) {
        const barrel = this.barrels.get(data.id);
        if (barrel) {
            barrel.exploded = true;
            this.barrels.delete(data.id);
        }
        
        // Spawn explosion VFX
        if (window.projectiles && window.ExplosionVfx) {
            const vfxScale = (data.radius || 180) / 90;  // ExplosionVfx base is 90
            window.projectiles.impacts.push(new window.ExplosionVfx(
                data.x, data.y, '#ff4400',
                { 
                    scale: vfxScale,
                    shockColor: '#ff6600',
                    sparkColor: '#ff2200',
                    flashColor: 'rgba(255, 100, 0, 0.9)'
                }
            ));
        }
        
        // Screen shake if player is close
        if (window.player) {
            const dist = Math.hypot(window.player.x - data.x, window.player.y - data.y);
            if (dist < 600) {
                const intensity = Math.max(0, 1 - dist / 600);
                if (window.camera && window.camera.shake) {
                    window.camera.shake(8 * intensity, 0.3);
                }
            }
        }
        
        // Apply local damage feedback for player hits (visual only, server is authoritative)
        if (data.playerHits && window.player) {
            for (const hit of data.playerHits) {
                if (hit.playerId === window.networkManager?.playerId) {
                    // Show damage number
                    if (window.projectiles && window.DamageNumber) {
                        window.projectiles.impacts.push(new window.DamageNumber(
                            window.player.x,
                            window.player.y - 40,
                            hit.damage,
                            '#ff4400'
                        ));
                    }
                }
            }
        }
    }
    
    update(dt) {
        for (const barrel of this.barrels.values()) {
            barrel.update(dt);
        }
    }
    
    draw(ctx, camera) {
        for (const barrel of this.barrels.values()) {
            barrel.draw(ctx, camera);
        }
    }
    
    // Get barrel at position (for client-side queries if needed)
    getBarrelAt(x, y) {
        for (const barrel of this.barrels.values()) {
            if (barrel.exploded) continue;
            const dist = Math.hypot(barrel.x - x, barrel.y - y);
            if (dist <= barrel.radius) {
                return barrel;
            }
        }
        return null;
    }
}

window.ExplodingBarrel = ExplodingBarrel;
window.ExplodingBarrelManager = ExplodingBarrelManager;











