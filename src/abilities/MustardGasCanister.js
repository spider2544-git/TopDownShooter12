// Mustard Gas Canister - Environment hazard emitting chlorine gas
class MustardGasCanister extends AbilityBase {
    constructor(owner, x, y, angle, progressionMods = {}) {
        const baseRadius = 180; // Gas cloud radius (slightly smaller than molotov)
        const radiusMultiplier = progressionMods.gasRadiusMultiplier || 1.0;
        const effectiveRadius = baseRadius * radiusMultiplier;
        
        super(x, y, owner, {
            radius: effectiveRadius,
            color: '#3a7a7a', // Dark teal for gas
            maxLife: null // No expiration - permanent hazard
        });
        
        this.angle = angle || 0;
        this.growDuration = 0.8; // Slower spread than molotov (gas diffuses)
        this.fadeInDuration = 0.3;
        this.elapsed = 0;
        this.maxRadius = effectiveRadius;
        this.startRadius = effectiveRadius * 0.3;
        
        // Canister properties
        this.canisterWidth = 24;
        this.canisterHeight = 36;
        this.canisterColor = '#1a3a4a'; // Dark navy teal
        this.canisterHighlight = '#2d5561'; // Lighter teal for highlights
        this.rustColor = '#6b4423'; // Rust spots
        
        // Gas particle system
        this._gasTime = 0;
        this._particles = [];
        this._particleSpawnTimer = 0;
        this._particleSpawnRate = 0.12; // Slower spawn for performance (was 0.06)
        
        // Performance: Update throttling
        this._physicsAccumulator = 0;
        this._physicsRate = 1/30; // Update physics at 30 FPS
        
        // No sprite cache needed - using flat colors for maximum performance
        
        // Create rust spots on canister
        this._rustSpots = [];
        const rustCount = 3 + Math.floor(Math.random() * 4);
        for (let i = 0; i < rustCount; i++) {
            this._rustSpots.push({
                x: (Math.random() - 0.5) * this.canisterWidth * 0.6,
                y: (Math.random() - 0.5) * this.canisterHeight * 0.6,
                size: 3 + Math.random() * 4
            });
        }
        
        console.log('[MustardGasCanister] Created at', x, y, 'radius:', this.maxRadius.toFixed(1));
    }
    
    update(dt, environment, enemies, players) {
        if (!this.alive) return;
        
        super.update(dt, environment, enemies, players); // Handle lifetime
        
        this.elapsed += dt;
        this._gasTime += dt;
        this._particleSpawnTimer += dt;
        
        // Performance: Throttled physics updates (30 FPS instead of 60)
        this._physicsAccumulator += dt;
        
        // Spawn gas particles from canister (optimized)
        const currentR = this.currentRadius();
        while (this._particleSpawnTimer >= this._particleSpawnRate && this._particles.length < 30) {
            this._particleSpawnTimer -= this._particleSpawnRate;
            
            // Spawn from canister top in a V-shape (cone eruption)
            // V-angle ranges from -60° to +60° from vertical (120° total cone)
            const vAngle = (Math.random() - 0.5) * (Math.PI * 0.67); // ±60° in radians
            const verticalAngle = -Math.PI / 2; // Straight up
            const angle = verticalAngle + vAngle; // Cone angle
            
            // Start small from canister TOP (offset upward by half canister height)
            const canisterTopOffset = -(this.canisterHeight * 0.5); // Top of canister
            const startDist = Math.random() * 8; // Very small starting area
            const spawnX = this.x + Math.cos(angle) * startDist;
            const spawnY = this.y + canisterTopOffset + Math.sin(angle) * startDist;
            
            // Mustard gas colors - varied saturated yellows and yellow-greens
            const gasColors = [
                '#e6e84d',  // Bright saturated yellow
                '#d4d62d',  // Strong yellow
                '#c9c91a',  // Deep yellow
                '#d9d955',  // Yellow-green bright
                '#bfbf3a',  // Olive yellow saturated
                '#f0f060',  // Very bright yellow
                '#c4c42a',  // Rich yellow-green
                '#aaaa1d'   // Dark saturated olive
            ];
            const color = gasColors[Math.floor(Math.random() * gasColors.length)];
            
            // Initial velocity follows the V-cone outward
            const speed = 40 + Math.random() * 40; // 40-80 px/s
            const vx = Math.cos(angle) * speed;
            const vy = Math.sin(angle) * speed;
            
            // Spawn tiny spray particles FIRST (60% chance for additional spray)
            if (Math.random() < 0.6) {
                const sprayAngle = -Math.PI / 2 + (Math.random() - 0.5) * (Math.PI * 0.9); // Wide spray (±81°)
                const spraySpeed = 60 + Math.random() * 80; // Fast burst (60-140 px/s)
                const startSize = 1.5 + Math.random() * 3; // Very tiny (1.5-4.5px)
                this._particles.push({
                    type: 'smoke',
                    x: spawnX,
                    y: spawnY,
                    vx: Math.cos(sprayAngle) * spraySpeed,
                    vy: Math.sin(sprayAngle) * spraySpeed,
                    life: 3.0 + Math.random() * 1.5,   // 50% longer: 3.0-4.5s (was 2.0-3.0s)
                    maxLife: 4.5,
                    size: startSize,
                    growthRate: startSize * 0.3 / 3.75, // Minimal growth, 30% over avg lifetime
                    gravity: 20, // Add gravity for liquid-like arc
                    color: color
                });
            }
            
            // Then spawn regular particles (original distribution, separate from spray)
            const sizeRoll = Math.random();
            
            if (sizeRoll < 0.3) {
                // Small particles (30%) - stay small, minimal growth
                this._particles.push({
                    type: 'smoke',
                    x: spawnX,
                    y: spawnY,
                    vx: vx * 1.2,                      // Faster
                    vy: vy * 1.2,
                    life: 3.0 + Math.random() * 1.5,   // Increased 50%: 3.0-4.5s (was 2.0-3.0s)
                    maxLife: 4.5,
                    size: 4 + Math.random() * 6,       // Very small start (4-10px)
                    growthRate: 8 + Math.random() * 7, // Minimal growth (8-15px/s)
                    color: color
                });
            } else if (sizeRoll < 0.65) {
                // Medium particles (35%) - moderate growth
                this._particles.push({
                    type: 'smoke',
                    x: spawnX,
                    y: spawnY,
                    vx: vx,
                    vy: vy,
                    life: 3.75 + Math.random() * 1.5,  // Increased 50%: 3.75-5.25s (was 2.5-3.5s)
                    maxLife: 5.25,
                    size: 8 + Math.random() * 8,       // Medium start (8-16px)
                    growthRate: 15 + Math.random() * 10, // Moderate growth (15-25px/s)
                    color: color
                });
            } else {
                // Large particles (35%) - grow to max size
                this._particles.push({
                    type: 'smoke',
                    x: spawnX,
                    y: spawnY,
                    vx: vx * 0.9,                      // Slightly slower
                    vy: vy * 0.9,
                    life: 3.75 + Math.random() * 2.25, // Increased 50%: 3.75-6.0s (was 2.5-4.0s)
                    maxLife: 6.0,
                    size: 12 + Math.random() * 8,      // Larger start (12-20px)
                    growthRate: 25 + Math.random() * 15, // Fast growth (25-40px/s)
                    color: color
                });
            }
        }
        
        // Performance: Update particle physics at 30 FPS only
        while (this._physicsAccumulator >= this._physicsRate) {
            this._physicsAccumulator -= this._physicsRate;
            
            // Update particles
            for (let i = this._particles.length - 1; i >= 0; i--) {
                const p = this._particles[i];
                p.life -= this._physicsRate;
                p.x += p.vx * this._physicsRate;
                p.y += p.vy * this._physicsRate;
                
                // Apply gravity to spray particles (liquid-like arc)
                if (p.gravity) {
                    p.vy += p.gravity * this._physicsRate;
                }
                
                // Smoke expands at varied rates based on particle
                if (p.type === 'smoke') {
                    const growthRate = p.growthRate || 50; // Use particle's growth rate or default
                    p.size += growthRate * this._physicsRate;
                }
                
                // Remove dead particles
                if (p.life <= 0) {
                    this._particles.splice(i, 1);
                }
            }
        }
    }
    
    currentRadius() {
        const spreadT = Math.min(1, this.elapsed / this.growDuration);
        const startScale = this.startRadius / this.maxRadius;
        const curScale = startScale + (1 - startScale) * spreadT;
        return this.maxRadius * curScale;
    }
    
    draw(ctx, camera) {
        if (!this.alive) return;
        
        const sx = this.x - camera.x;
        const sy = this.y - camera.y;
        const fadeIn = Math.min(1, this.elapsed / this.fadeInDuration);
        
        ctx.save();
        
        // Only draw the canister here - smoke particles are drawn in drawTopLayer()
        this._drawCanister(ctx, sx, sy, fadeIn);
        
        ctx.restore();
    }
    
    // Draw smoke particles OVER players and enemies (flat colors for performance)
    drawTopLayer(ctx, camera) {
        if (!this.alive) return;
        
        const fadeIn = Math.min(1, this.elapsed / this.fadeInDuration);
        
        // Early exit if no particles
        if (this._particles.length === 0) return;
        
        ctx.save();
        
        // Pre-calculate camera offset
        const camX = camera.x;
        const camY = camera.y;
        
        // Draw smoke particles (rendered after players for proper layering)
        for (let i = 0; i < this._particles.length; i++) {
            const p = this._particles[i];
            
            // Skip if particle type doesn't match
            if (p.type !== 'smoke') continue;
            
            const px = p.x - camX;
            const py = p.y - camY;
            
            // Frustum culling - skip if offscreen
            if (px < -p.size || px > 1920 + p.size || py < -p.size || py > 1080 + p.size) continue;
            
            const pFade = p.life / p.maxLife;
            
            // Performance: Simple flat color circles (no gradients!)
            // Increased opacity by 30%: 0.175 -> 0.2275
            ctx.globalAlpha = pFade * 0.2275 * fadeIn;
            ctx.fillStyle = p.color || '#d4d62d'; // Use flat color from particle
            ctx.beginPath();
            ctx.arc(px, py, p.size, 0, Math.PI * 2);
            ctx.fill();
        }
        
        ctx.restore();
    }
    
    _drawCanister(ctx, sx, sy, fadeIn) {
        const w = this.canisterWidth;
        const h = this.canisterHeight;
        const t = this._gasTime;
        
        // Slight bobbing animation
        const bob = Math.sin(t * 1.5) * 1.5;
        const cy = sy + bob;
        
        ctx.save();
        
        // Shadow
        ctx.globalAlpha = 0.3 * fadeIn;
        ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
        ctx.beginPath();
        ctx.ellipse(sx, sy + h * 0.5 + 2, w * 0.5, w * 0.15, 0, 0, Math.PI * 2);
        ctx.fill();
        
        // Main canister body (oil drum shape)
        ctx.globalAlpha = fadeIn;
        
        // Dark base color
        ctx.fillStyle = this.canisterColor;
        ctx.beginPath();
        ctx.roundRect(sx - w * 0.5, cy - h * 0.5, w, h, 3);
        ctx.fill();
        
        // Barrel ridges (horizontal lines)
        ctx.strokeStyle = '#0f2530';
        ctx.lineWidth = 1.5;
        for (let i = -1; i <= 1; i++) {
            const ry = cy + i * h * 0.25;
            ctx.beginPath();
            ctx.moveTo(sx - w * 0.5, ry);
            ctx.lineTo(sx + w * 0.5, ry);
            ctx.stroke();
        }
        
        // Highlight edge
        ctx.strokeStyle = this.canisterHighlight;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(sx - w * 0.35, cy - h * 0.5);
        ctx.lineTo(sx - w * 0.35, cy + h * 0.5);
        ctx.stroke();
        
        // Rust spots
        ctx.globalAlpha = 0.6 * fadeIn;
        for (let i = 0; i < this._rustSpots.length; i++) {
            const rust = this._rustSpots[i];
            ctx.fillStyle = this.rustColor;
            ctx.beginPath();
            ctx.arc(sx + rust.x, cy + rust.y, rust.size, 0, Math.PI * 2);
            ctx.fill();
        }
        
        // Gas leak indicator (glowing vent on top)
        ctx.globalAlpha = fadeIn;
        const ventGlow = 0.5 + Math.sin(t * 4) * 0.5;
        const ventGrad = ctx.createRadialGradient(sx, cy - h * 0.5, 0, sx, cy - h * 0.5, 6);
        ventGrad.addColorStop(0, `rgba(201, 217, 158, ${ventGlow})`);
        ventGrad.addColorStop(1, 'rgba(168, 184, 120, 0)');
        ctx.fillStyle = ventGrad;
        ctx.beginPath();
        ctx.arc(sx, cy - h * 0.5, 6, 0, Math.PI * 2);
        ctx.fill();
        
        // Hazard symbol (toxic warning)
        ctx.globalAlpha = 0.8 * fadeIn;
        ctx.fillStyle = '#f0e68c'; // Pale yellow
        ctx.font = 'bold 16px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('☠', sx, cy);
        
        ctx.restore();
    }
    
    onExpire() {
        console.log('[MustardGasCanister] Gas canister expired at', this.x, this.y);
    }
}

window.MustardGasCanister = MustardGasCanister;

// Debug function to spawn a gas canister at player position (for testing)
window.spawnMustardGas = function(offsetX = 0, offsetY = 0) {
    if (!window.player || !window.abilityManager) {
        console.error('[MustardGas] Player or AbilityManager not initialized');
        return null;
    }
    
    const x = window.player.x + offsetX;
    const y = window.player.y + offsetY;
    const canister = new MustardGasCanister(window.player, x, y, 0);
    window.abilityManager.abilities.push(canister);
    console.log('[MustardGas] Spawned canister at', x.toFixed(1), y.toFixed(1));
    return canister;
};

