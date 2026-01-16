// Auto Turret - Weapon 7 Secondary (2 blood markers)
// Automated defense turret with twin barrels
class AutoTurret extends AbilityBase {
    constructor(player, placementX, placementY, options = {}) {
        super(placementX, placementY, player, {
            maxLife: 90, // 90 second timer
            color: '#8a9aa8', // Light cool grey for barrels
            radius: 25
        });
        
        // Ammo/Health (each shot costs 1 HP)
        // Apply loot-based health from options or default to 150
        this.healthMax = options.turretHealth || 150;
        this.health = this.healthMax;
        
        // Targeting properties
        this.targetingRadius = 210; // 350 * 0.6 = 60% of weapon 7
        this.currentTarget = null;
        this.angle = 0; // Current rotation angle
        this.targetAngle = 0; // Desired angle to face target
        this.rotationSpeed = Math.PI * 2; // radians/sec (full rotation in 1 second)
        
        // Firing properties
        this.fireRate = 8.84; // 6.8 * 1.3 = 30% faster than weapon 7
        this.fireCooldown = 0;
        this.projectileSpeed = 16000; // Same as weapon 7
        this.projectileRadius = 6; // Same as weapon 7
        this.projectileLife = 3.6; // Same as weapon 7
        this.damage = 20; // Standard damage
        
        // Twin barrels
        this.barrelOffset = 8; // Distance from center to each barrel
        this.currentBarrel = 0; // 0 or 1 for alternating
        this.barrelLength = 22;
        this.barrelWidth = 5;
        
        // Visual effects
        this.pulseTime = 0;
        this.muzzleFlashes = []; // {side: 0|1, life: 0.15, intensity: 1.0}
        
        // Body color (dark cool grey)
        this.bodyColor = '#3d4654';
        this.barrelColor = '#8a9aa8'; // Light cool grey
        
        // Hit flash (like player)
        this.hitFlash = 0;
        this.hitFlashMax = 0.12; // quick fade
        this.hitFlashCooldown = 0;
        this.hitFlashGap = 0.07; // minimum gap between flashes
    }
    
    takeDamage(amount) {
        if (!this.alive) return;
        
        this.health -= amount;
        console.log('[AutoTurret] Took', amount, 'damage, health:', this.health);
        
        if (this.health <= 0) {
            this.explode();
        }
    }
    
    update(dt, environment, enemies, players) {
        if (!this.alive) return;
        
        super.update(dt, environment, enemies, players);
        
        this.pulseTime += dt * 3;
        
        // Update muzzle flashes (client-side visual only)
        for (let i = this.muzzleFlashes.length - 1; i >= 0; i--) {
            this.muzzleFlashes[i].life -= dt;
            if (this.muzzleFlashes[i].life <= 0) {
                this.muzzleFlashes.splice(i, 1);
            }
        }
        
        // Hit flash countdown
        if (this.hitFlash > 0) {
            this.hitFlash -= dt;
            if (this.hitFlash < 0) this.hitFlash = 0;
        }
        // Flash cooldown countdown
        if (this.hitFlashCooldown > 0) {
            this.hitFlashCooldown -= dt;
            if (this.hitFlashCooldown < 0) this.hitFlashCooldown = 0;
        }
        
        // CLIENT-SIDE: Only do visual updates
        // Server handles all targeting, rotation, and firing logic
        // Client receives 'turretFire' events to sync angle and show visuals
    }
    
    explode() {
        if (!this.alive) return;
        this.alive = false;
        
        console.log('[AutoTurret] Exploding at', this.x, this.y);
        
        // Small explosion VFX
        if (window.projectiles && window.ExplosionVfx) {
            window.projectiles.impacts.push(new window.ExplosionVfx(
                this.x, 
                this.y, 
                this.bodyColor,
                { 
                    scale: 0.5,
                    shockColor: '#6b7a88',
                    sparkColor: '#8a9aa8'
                }
            ));
        }
        
        // Notify server of death
        if (window.networkManager && this.owner === window.player && this._serverId) {
            window.networkManager.socket.emit('abilityDestroy', {
                serverId: this._serverId
            });
        }
    }
    
    draw(ctx, camera) {
        if (!this.alive) return;
        
        const sx = this.x - camera.x;
        const sy = this.y - camera.y;
        
        // Check if this is owned by local player
        const isOwnedByLocalPlayer = this.owner === window.player;
        
        // Draw targeting radius for owner only (faint like weapon 7)
        if (isOwnedByLocalPlayer) {
            ctx.save();
            ctx.globalAlpha = 0.15;
            ctx.strokeStyle = this.barrelColor;
            ctx.lineWidth = 2;
            ctx.setLineDash([8, 6]);
            ctx.beginPath();
            ctx.arc(sx, sy, this.targetingRadius, 0, Math.PI * 2);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.restore();
        }
        
        ctx.save();
        ctx.translate(sx, sy);
        ctx.rotate(this.angle);
        
        // Always use cool grey - NO RED EVER
        const bodyColorToUse = this.bodyColor; // #3d4654 dark cool grey
        const barrelColorToUse = this.barrelColor; // #8a9aa8 light cool grey
        
        // Draw turret body (hexagon) - dark cool grey, no glow
        const sides = 6;
        const hexRadius = this.radius;
        
        ctx.globalAlpha = 1.0;
        ctx.shadowBlur = 0;
        ctx.fillStyle = bodyColorToUse;
        ctx.strokeStyle = barrelColorToUse;
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (let i = 0; i < sides; i++) {
            const angle = (i / sides) * Math.PI * 2;
            const x = Math.cos(angle) * hexRadius;
            const y = Math.sin(angle) * hexRadius;
            if (i === 0) {
                ctx.moveTo(x, y);
            } else {
                ctx.lineTo(x, y);
            }
        }
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        
        // Quick red flash overlay when hit (hexagon matching body shape)
        if (this.hitFlash > 0) {
            const denom = (this.hitFlashMax || 0.12);
            const t = Math.max(0, Math.min(1, this.hitFlash / denom));
            ctx.save();
            ctx.globalAlpha = Math.pow(t, 0.4) * 0.9; // strong at start, very fast fade
            ctx.fillStyle = '#ff3b3b';
            ctx.beginPath();
            for (let i = 0; i < sides; i++) {
                const angle = (i / sides) * Math.PI * 2;
                const x = Math.cos(angle) * hexRadius;
                const y = Math.sin(angle) * hexRadius;
                if (i === 0) {
                    ctx.moveTo(x, y);
                } else {
                    ctx.lineTo(x, y);
                }
            }
            ctx.closePath();
            ctx.fill();
            ctx.restore();
        }
        
        // Draw twin barrels (light cool grey) - no glow
        ctx.shadowBlur = 0;
        ctx.fillStyle = barrelColorToUse;
        ctx.strokeStyle = bodyColorToUse;
        ctx.lineWidth = 1;
        
        // Left barrel
        const leftY = -this.barrelOffset;
        ctx.fillRect(0, leftY - this.barrelWidth/2, this.barrelLength, this.barrelWidth);
        ctx.strokeRect(0, leftY - this.barrelWidth/2, this.barrelLength, this.barrelWidth);
        
        // Right barrel
        const rightY = this.barrelOffset;
        ctx.fillRect(0, rightY - this.barrelWidth/2, this.barrelLength, this.barrelWidth);
        ctx.strokeRect(0, rightY - this.barrelWidth/2, this.barrelLength, this.barrelWidth);
        
        // Draw muzzle flashes (bright yellow/white like weapon 7) - NO GLOW
        for (let i = 0; i < this.muzzleFlashes.length; i++) {
            const flash = this.muzzleFlashes[i];
            const flashY = (flash.side === 0) ? leftY : rightY;
            const t = flash.life / 0.15;
            const intensity = flash.intensity * t;
            
            ctx.shadowBlur = 0; // NO GLOW
            
            // Main flash circle
            ctx.globalAlpha = intensity * 0.9;
            ctx.fillStyle = '#ffff00';
            ctx.beginPath();
            ctx.arc(this.barrelLength + 4, flashY, 8, 0, Math.PI * 2);
            ctx.fill();
            
            // Outer circle (white)
            ctx.globalAlpha = intensity * 0.6;
            ctx.fillStyle = '#ffffff';
            ctx.beginPath();
            ctx.arc(this.barrelLength + 4, flashY, 12, 0, Math.PI * 2);
            ctx.fill();
            
            // Flash streaks
            ctx.globalAlpha = intensity * 0.7;
            ctx.strokeStyle = '#ffff88';
            ctx.lineWidth = 2;
            const streakLen = 15 + Math.random() * 10;
            ctx.beginPath();
            ctx.moveTo(this.barrelLength + 4, flashY);
            ctx.lineTo(this.barrelLength + 4 + streakLen, flashY + (Math.random() - 0.5) * 8);
            ctx.stroke();
        }
        
        ctx.restore();
        
        // Draw ammo/health bar
        ctx.save();
        const barW = 40;
        const barH = 5;
        const barX = sx - barW / 2;
        const barY = sy - this.radius - 15;
        
        ctx.shadowBlur = 0;
        ctx.globalAlpha = 0.8;
        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        ctx.fillRect(barX, barY, barW, barH);
        
        const healthPct = this.health / this.healthMax;
        ctx.fillStyle = healthPct > 0.5 ? '#00ff00' : (healthPct > 0.25 ? '#ffff00' : '#ff0000');
        ctx.fillRect(barX, barY, barW * healthPct, barH);
        
        ctx.strokeStyle = 'rgba(0,0,0,0.7)';
        ctx.lineWidth = 1;
        ctx.strokeRect(barX, barY, barW, barH);
        
        // Draw ammo count (rounded up to show last shot)
        ctx.globalAlpha = 1;
        ctx.font = 'bold 10px Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = 3;
        const displayHealth = Math.ceil(this.health); // Round up to whole number
        ctx.strokeText(displayHealth, sx, barY - 2);
        ctx.fillText(displayHealth, sx, barY - 2);
        
        ctx.restore();
    }
    
    onExpire() {
        // Explode when timer expires
        this.explode();
    }
}

window.AutoTurret = AutoTurret;
