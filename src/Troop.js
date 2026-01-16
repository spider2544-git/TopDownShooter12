// Client-side Troop class for rendering allied units
// Troops are friendly units that spawn behind players in Trench Raid

class Troop {
    constructor(x, y) {
        if (typeof Troop._nextId !== 'number') Troop._nextId = 1;
        this.id = Troop._nextId++;
        this.x = x;
        this.y = y;
        this.radius = 22;
        
        // Visual (default to melee)
        this.color = '#2d7a7a';      // Dark teal for melee (New Antioch colors)
        this.outline = '#1a4a4a';    // Darker teal
        
        this.alive = true;
        this.type = 'trooper_melee';
        this.faction = 'newantioch';
        
        // Health
        this.health = 30;
        this.healthMax = 30;
        
        // Ranged troop visual indicator
        this._barrelAngle = 0;
        
        // Server state
        this.serverSpawned = false;
        this._serverId = null;
        
        // Network smoothing
        this._net = null;
        
        // Animation
        this._t = 0;
        
        // Muzzle flashes for ranged troops (like turrets)
        this.muzzleFlashes = []; // {life: 0.12, intensity: 1.0}
        
        // Fire VFX tracking (synced from server)
        this.dotStacks = [];
        this._fxTime = 0;
    }
    
    update(dt) {
        this._t += dt || 0;
        this._fxTime += dt || 0; // For fire VFX animation
        
        // Network smoothing (like enemies)
        if (this._net && Number.isFinite(this._net.tx) && Number.isFinite(this._net.ty)) {
            const blendRate = 10; // 10 blends per second
            const blend = Math.min(1, blendRate * dt);
            this.x += (this._net.tx - this.x) * blend;
            this.y += (this._net.ty - this.y) * blend;
        }
        
        // Update muzzle flashes
        for (let i = this.muzzleFlashes.length - 1; i >= 0; i--) {
            this.muzzleFlashes[i].life -= dt;
            if (this.muzzleFlashes[i].life <= 0) {
                this.muzzleFlashes.splice(i, 1);
            }
        }
    }
    
    draw(ctx, camera) {
        if (!this.alive) return;
        
        const sx = this.x - camera.x;
        const sy = this.y - camera.y;
        
        // Draw fire VFX if burning (before body so it appears around the troop)
        if (this.dotStacks && this.dotStacks.length > 0) {
            ctx.save();
            const stacks = this.dotStacks.length;
            const intensity = Math.min(1.2, stacks / 4);
            const baseR = this.radius * (1.0 + 0.8 * intensity);
            const t = this._fxTime || 0;
            const wobble = Math.sin(t * 6) * 0.12;
            const sx0 = sx + wobble * this.radius * 0.3;
            const sy0 = sy - this.radius * (0.25 + 0.1 * Math.sin(t * 4)); // bias upward, bob (removed id to prevent NaN)
            const grad = ctx.createRadialGradient(sx0, sy0, baseR * 0.1, sx0, sy0, baseR);
            grad.addColorStop(0, 'rgba(255, 250, 210, ' + (0.95 * intensity) + ')');
            grad.addColorStop(0.35, 'rgba(255, 200, 80, ' + (0.65 * intensity) + ')');
            grad.addColorStop(1, 'rgba(255, 120, 0, 0)');
            ctx.fillStyle = grad;
            ctx.beginPath();
            ctx.ellipse(sx0, sy0, baseR * (0.7 + 0.05 * Math.sin(t * 8)), baseR * (1.35 + 0.1 * Math.sin(t * 5 + 1.1)), wobble * 0.6, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
        }
        
        // Different colors for each troop type
        const isRanged = this.type === 'trooper_ranged';
        const isGrenadier = this.type === 'trooper_grenadier';
        
        let bodyColor, outlineColor;
        if (isGrenadier) {
            bodyColor = '#1a5555';    // Dark teal for grenadier (lighter than before)
            outlineColor = '#0d3333';  // Darker teal outline
        } else if (isRanged) {
            bodyColor = '#4db3b3';    // Lighter teal for ranged
            outlineColor = '#2d8585';
        } else {
            bodyColor = '#2d7a7a';    // Medium teal for melee
            outlineColor = '#1a4a4a';
        }
        
        ctx.save();
        
        // Body circle
        ctx.fillStyle = bodyColor;
        ctx.beginPath();
        ctx.arc(sx, sy, this.radius, 0, Math.PI * 2);
        ctx.fill();
        
        // Outline
        ctx.strokeStyle = outlineColor;
        ctx.lineWidth = 3;
        ctx.stroke();
        
        // Draw barrel for ranged troops and grenadiers (like turrets)
        if (isRanged || isGrenadier) {
            ctx.save();
            ctx.translate(sx, sy);
            ctx.rotate(this._barrelAngle || 0);
            
            // Barrel
            ctx.fillStyle = '#5a5a5a';
            ctx.fillRect(0, -3, this.radius + 8, 6);
            
            // Barrel tip
            ctx.fillStyle = '#3a3a3a';
            ctx.fillRect(this.radius + 4, -2, 4, 4);
            
            // Muzzle flash (when firing)
            if (this.muzzleFlashes && this.muzzleFlashes.length > 0) {
                for (const flash of this.muzzleFlashes) {
                    const flashIntensity = flash.intensity * (flash.life / 0.12); // Fade out
                    const flashX = this.radius + 8;
                    const flashY = 0;
                    
                    // Bright yellow-white flash
                    ctx.fillStyle = `rgba(255, 255, 150, ${flashIntensity * 0.9})`;
                    ctx.beginPath();
                    ctx.arc(flashX, flashY, 6, 0, Math.PI * 2);
                    ctx.fill();
                    
                    // Outer glow
                    ctx.fillStyle = `rgba(255, 200, 100, ${flashIntensity * 0.5})`;
                    ctx.beginPath();
                    ctx.arc(flashX, flashY, 10, 0, Math.PI * 2);
                    ctx.fill();
                }
            }
            
            ctx.restore();
        }
        
        ctx.restore();
        
        // Health bar (always show for troops to distinguish them from enemies)
        if (this.healthMax > 0) {
            const barWidth = 40;
            const barHeight = 4;
            const barX = sx - barWidth / 2;
            const barY = sy - this.radius - 10;
            
            const healthPercent = Math.max(0, Math.min(1, this.health / this.healthMax));
            
            // Background
            ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
            ctx.fillRect(barX, barY, barWidth, barHeight);
            
            // Health fill (green -> yellow -> red based on health %)
            ctx.fillStyle = healthPercent > 0.5 ? '#4CAF50' : healthPercent > 0.25 ? '#FF9800' : '#F44336';
            ctx.fillRect(barX, barY, barWidth * healthPercent, barHeight);
            
            // Border
            ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
            ctx.lineWidth = 1;
            ctx.strokeRect(barX, barY, barWidth, barHeight);
        }
    }
}

// Expose globally for client use
if (typeof window !== 'undefined') {
    window.Troop = Troop;
}

