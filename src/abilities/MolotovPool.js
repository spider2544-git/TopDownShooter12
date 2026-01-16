// Molotov Fire Pool - Secondary weapon ability for Weapon 4
class MolotovPool extends AbilityBase {
    constructor(owner, x, y, angle, progressionMods = {}) {
        // Apply loot-based diameter multiplier to radius (baseline: 200)
        const baseRadius = 200;
        const diameterMultiplier = progressionMods.poolDiameterMultiplier || 1.0;
        const effectiveRadius = baseRadius * diameterMultiplier;
        
        super(x, y, owner, {
            radius: effectiveRadius,
            color: '#ff6600',
            maxLife: 18.0 // 18 seconds (50% longer than original 12s)
        });
        
        this.angle = angle || 0;
        this.totalLife = 18.0; // Increased by 50% (12 * 1.5 = 18)
        this.growDuration = 0.5; // 2x faster spread (was 1.0)
        this.fadeInDuration = 0.25;
        this.elapsed = 0;
        this.maxRadius = effectiveRadius; // Apply diameter multiplier
        this.startRadius = effectiveRadius * 0.4; // Scale start radius proportionally (was 80/200 = 0.4)
        
        // DOT application - apply loot-based damage multiplier (baseline: 20 DPS)
        const baseDotDps = 20; // 4x weapon 4 base DOT (doubled twice)
        const dotDamageMultiplier = progressionMods.dotDamageMultiplier || 1.0;
        this.dotDps = baseDotDps * dotDamageMultiplier; // Apply damage multiplier
        this.dotDuration = 3; // Same as weapon 4
        this.dotTickInterval = 0.5; // Apply DOT every 0.5s for performance
        this.dotTickTimer = 0;
        this.affectedEntities = new Map(); // Track last DOT application time per entity
        
        // Log progression modifiers for debugging
        console.log('[MolotovPool] Created with mods:', progressionMods, 'radius:', this.maxRadius.toFixed(1), 'dotDps:', this.dotDps.toFixed(1));
        
        // Flame animation - using particle system like fireball trail
        this._flameTime = 0;
        this._particles = [];
        this._particleSpawnTimer = 0;
        this._particleSpawnRate = 0.08; // Spawn particles slower than trail
        
        // Create ember spots on ground (static glow positions) - much smaller and more numerous
        this._emberSpots = [];
        const emberCount = 60 + Math.floor(Math.random() * 40); // More embers (60-100)
        for (let i = 0; i < emberCount; i++) {
            const angle = Math.random() * Math.PI * 2;
            const dist = Math.random() * this.maxRadius * 0.95;
            this._emberSpots.push({
                offsetX: Math.cos(angle) * dist,
                offsetY: Math.sin(angle) * dist,
                size: 3 + Math.random() * 5, // Much smaller (3-8 instead of 8-20)
                intensity: 0.6 + Math.random() * 0.4,
                phase: Math.random() * Math.PI * 2
            });
        }
        
        // Create static flame sprites scattered across pool
        this._flameSprites = [];
        const flameCount = 8 + Math.floor(Math.random() * 6); // 8-14 flames
        for (let i = 0; i < flameCount; i++) {
            const angle = Math.random() * Math.PI * 2;
            const dist = Math.random() * this.maxRadius * 0.75;
            this._flameSprites.push({
                offsetX: Math.cos(angle) * dist,
                offsetY: Math.sin(angle) * dist,
                size: 12 + Math.random() * 8,
                intensity: 0.7 + Math.random() * 0.3,
                phase: Math.random() * Math.PI * 2,
                id: i
            });
        }
    }
    
    update(dt, environment, enemies, players) {
        if (!this.alive) return;
        
        super.update(dt, environment, enemies, players); // Handle lifetime
        
        this.elapsed += dt;
        this._flameTime += dt;
        this.dotTickTimer += dt;
        this._particleSpawnTimer += dt;
        
        // Spawn flame/smoke/spark particles across the pool
        const currentR = this.currentRadius();
        while (this._particleSpawnTimer >= this._particleSpawnRate && this._particles.length < 40) {
            this._particleSpawnTimer -= this._particleSpawnRate;
            
            // Random position within pool
            const angle = Math.random() * Math.PI * 2;
            const dist = Math.random() * currentR * 0.85;
            const spawnX = this.x + Math.cos(angle) * dist;
            const spawnY = this.y + Math.sin(angle) * dist;
            
            // 70% flame, 30% smoke
            if (Math.random() < 0.7) {
                // Flame particle
                this._particles.push({
                    type: 'flame',
                    x: spawnX,
                    y: spawnY,
                    vx: (Math.random() - 0.5) * 30,
                    vy: -40 - Math.random() * 40, // Rise upward
                    life: 0.4 + Math.random() * 0.3,
                    maxLife: 0.7,
                    size: 8 + Math.random() * 6,
                    color: Math.random() > 0.5 ? '#ff6600' : '#ffaa33'
                });
            } else {
                // Smoke particle
                this._particles.push({
                    type: 'smoke',
                    x: spawnX,
                    y: spawnY,
                    vx: (Math.random() - 0.5) * 20,
                    vy: -30 - Math.random() * 30,
                    life: 0.8 + Math.random() * 0.6,
                    maxLife: 1.4,
                    size: 10 + Math.random() * 8
                });
            }
            
            // Occasional sparks
            if (Math.random() < 0.2) {
                this._particles.push({
                    type: 'spark',
                    x: spawnX,
                    y: spawnY,
                    vx: (Math.random() - 0.5) * 60,
                    vy: -(60 + Math.random() * 100),
                    life: 0.3 + Math.random() * 0.3,
                    maxLife: 0.6,
                    size: 2 + Math.random() * 2
                });
            }
        }
        
        // Update particles
        for (let i = this._particles.length - 1; i >= 0; i--) {
            const p = this._particles[i];
            p.life -= dt;
            p.x += p.vx * dt;
            p.y += p.vy * dt;
            
            // Smoke expands
            if (p.type === 'smoke') {
                p.size += 20 * dt;
            }
            
            // Sparks affected by gravity
            if (p.type === 'spark') {
                p.vy += 200 * dt;
            }
            
            // Remove dead particles
            if (p.life <= 0) {
                this._particles.splice(i, 1);
            }
        }
        
        // Apply DOT damage (server-authoritative)
        if (this.dotTickTimer >= this.dotTickInterval && this.owner) {
            this.dotTickTimer = 0;
            this._applyDotToEntitiesInRadius(enemies, players);
        }
    }
    
    _applyDotToEntitiesInRadius(enemies, players) {
        const currentRadius = this.currentRadius();
        
        // Apply DOT to enemies
        if (enemies && enemies.queryCircle) {
            // Pad query radius to include large enemies (BigBoy radius 80) since we later test
            // against (currentRadius + e.radius). queryCircle() is center-distance based.
            const candidates = enemies.queryCircle(this.x, this.y, currentRadius + 80);
            for (let i = 0; i < candidates.length; i++) {
                const e = candidates[i];
                if (!e || !e.alive) continue;
                
                const dx = e.x - this.x;
                const dy = e.y - this.y;
                const dist = Math.hypot(dx, dy);
                
                if (dist <= currentRadius + (e.radius || 26)) {
                    // Apply DOT - server will handle actual damage
                    if (this.owner === window.player && e.applyDot && typeof e.applyDot === 'function') {
                        try {
                            let dotBonus = 0;
                            try { dotBonus = Math.max(0, this.owner?.getDotAttackPowerBonus?.() || 0); } catch(_) {}
                            
                            // NPC_B DOT is server-authoritative
                            if (e.name === 'NPC_B' && e._serverId && window.networkManager) {
                                window.networkManager.sendNPCDot(e._serverId, this.dotDps + dotBonus, this.dotDuration);
                            } else {
                                // For regular enemies, apply DOT locally
                                e.applyDot(this.dotDps + dotBonus, this.dotDuration, { owner: this.owner });
                            }
                        } catch(err) {
                            console.error('[MolotovPool] Failed to apply DOT to enemy:', err);
                        }
                    }
                }
            }
        }
        
        // Apply DOT to hostile players (PvP)
        if (this.owner && window.networkManager?.otherPlayers) {
            const myEvil = (this.owner === window.player && window.__killThemAllLocked === true) ||
                         (window.networkManager?.remotePlayerEvilStates?.get(this.ownerId) || false);
            
            for (const [otherId, otherData] of window.networkManager.otherPlayers) {
                if (!otherData || otherData.health <= 0) continue;
                
                const otherEvil = window.networkManager.remotePlayerEvilStates?.get(otherId) || false;
                if (myEvil === otherEvil) continue; // Same alignment, skip
                
                const dx = otherData.x - this.x;
                const dy = otherData.y - this.y;
                const dist = Math.hypot(dx, dy);
                
                if (dist <= currentRadius + (otherData.radius || 26)) {
                    // Send DOT to server for PvP damage
                    if (this.owner === window.player && window.networkManager) {
                        try {
                            window.networkManager.socket.emit('abilityDotDamage', {
                                abilityId: this._serverId,
                                targetPlayerId: otherId,
                                dps: this.dotDps,
                                duration: this.dotDuration
                            });
                        } catch(err) {
                            console.error('[MolotovPool] Failed to send PvP DOT:', err);
                        }
                    }
                }
            }
        }
        
        // Apply DOT to local player ONLY if it's a hostile pool (enemy/opposite-alignment)
        // Never apply DOT to the owner or same-alignment teammates
        if (window.player && window.player.health > 0) {
            // Skip if this is the player's own pool
            const isOwnPool = this.owner === window.player;
            
            if (!isOwnPool) {
                // Skip if same team (both non-evil or both evil)
                const myEvil = (this.owner === window.player && window.__killThemAllLocked === true) ||
                              (window.networkManager?.remotePlayerEvilStates?.get(this.ownerId) || false);
                const playerEvil = window.__killThemAllLocked === true;
                
                // Only apply DOT if opposite alignments (PvP)
                if (myEvil !== playerEvil) {
                    const dx = window.player.x - this.x;
                    const dy = window.player.y - this.y;
                    const dist = Math.hypot(dx, dy);
                    
                    if (dist <= currentRadius + (window.player.radius || 26)) {
                        // Apply DOT locally (client-side for feedback, server has authority)
                        try {
                            if (!window.player._playerDotStacks) window.player._playerDotStacks = [];
                            window.player._playerDotStacks.push({ dps: this.dotDps, timeLeft: this.dotDuration });
                        } catch(_) {}
                    }
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
        // Stay at full intensity until last 1 second, then fade out over that 1 second
        const fade = this.lifeLeft > 1.0 ? 1.0 : Math.max(0, this.lifeLeft / 1.0);
        const fadeIn = Math.min(1, this.elapsed / this.fadeInDuration);
        const currentR = this.currentRadius();
        const scale = currentR / this.maxRadius;
        const t = this._flameTime;
        
        ctx.save();
        
        // Draw dark charred ground base
        ctx.globalAlpha = 0.6 * fade * fadeIn;
        ctx.fillStyle = '#0a0604';
        ctx.beginPath();
        ctx.arc(sx, sy, currentR, 0, Math.PI * 2);
        ctx.fill();
        
        // Draw subtle glow fill with falloff (~20% opacity at center, fading to edges)
        const glowGrad = ctx.createRadialGradient(sx, sy, 0, sx, sy, currentR);
        glowGrad.addColorStop(0, 'rgba(255, 120, 40, 0.2)'); // ~20% opacity orange at center
        glowGrad.addColorStop(0.4, 'rgba(255, 100, 30, 0.12)'); // Fade
        glowGrad.addColorStop(0.7, 'rgba(255, 80, 20, 0.05)'); // More fade
        glowGrad.addColorStop(1, 'rgba(255, 60, 10, 0)'); // Transparent at edge
        ctx.globalAlpha = fade * fadeIn;
        ctx.fillStyle = glowGrad;
        ctx.beginPath();
        ctx.arc(sx, sy, currentR, 0, Math.PI * 2);
        ctx.fill();
        
        // Draw burning embers scattered across ground (like reference image)
        for (let i = 0; i < this._emberSpots.length; i++) {
            const ember = this._emberSpots[i];
            const ex = sx + ember.offsetX * scale;
            const ey = sy + ember.offsetY * scale;
            
            // Pulsing glow effect
            const pulse = 0.5 + Math.sin(t * 3 + ember.phase) * 0.3;
            const emberSize = ember.size * scale * (0.8 + pulse * 0.4);
            
            // Hot ember glow (orange-red-yellow)
            const emberGrad = ctx.createRadialGradient(ex, ey, 0, ex, ey, emberSize);
            emberGrad.addColorStop(0, `rgba(255, 220, 150, ${ember.intensity * pulse})`); // Hot white-yellow center
            emberGrad.addColorStop(0.3, `rgba(255, 140, 40, ${ember.intensity * 0.8})`); // Orange
            emberGrad.addColorStop(0.6, `rgba(200, 60, 10, ${ember.intensity * 0.5})`); // Dark red
            emberGrad.addColorStop(1, 'rgba(80, 20, 0, 0)'); // Fade to black
            
            ctx.globalAlpha = fade * fadeIn;
            ctx.fillStyle = emberGrad;
            ctx.beginPath();
            ctx.arc(ex, ey, emberSize, 0, Math.PI * 2);
            ctx.fill();
            
            // Extra bright core for hottest embers
            if (pulse > 0.6) {
                ctx.globalAlpha = (pulse - 0.6) * 2.5 * ember.intensity * fade * fadeIn;
                ctx.fillStyle = '#fffacd';
                ctx.beginPath();
                ctx.arc(ex, ey, emberSize * 0.3, 0, Math.PI * 2);
                ctx.fill();
            }
        }
        
        // Draw static flame sprites
        for (let i = 0; i < this._flameSprites.length; i++) {
            const flame = this._flameSprites[i];
            const fx = sx + flame.offsetX * scale;
            const fy = sy + flame.offsetY * scale;
            
            // Flickering animation
            const flicker = 0.7 + Math.sin(t * 4 + flame.phase) * 0.3;
            const wobble = Math.sin(t * 5 + flame.id) * 0.15;
            
            const flameSize = flame.size * scale * flicker;
            
            // Flame gradient (yellow-white core to orange-red)
            const flameGrad = ctx.createRadialGradient(fx, fy, 0, fx, fy, flameSize);
            flameGrad.addColorStop(0, `rgba(255, 255, 200, ${flame.intensity * flicker})`);
            flameGrad.addColorStop(0.3, `rgba(255, 180, 60, ${flame.intensity * 0.8})`);
            flameGrad.addColorStop(0.6, `rgba(255, 100, 20, ${flame.intensity * 0.5})`);
            flameGrad.addColorStop(1, 'rgba(200, 50, 0, 0)');
            
            ctx.globalAlpha = fade * fadeIn;
            ctx.fillStyle = flameGrad;
            ctx.beginPath();
            // Vertical ellipse for flame shape
            ctx.ellipse(
                fx + wobble * flameSize * 0.2, 
                fy,
                flameSize * 0.6,
                flameSize * 1.2,
                wobble * 0.3,
                0, Math.PI * 2
            );
            ctx.fill();
            
            // Bright core
            ctx.globalAlpha = flame.intensity * flicker * fade * fadeIn;
            ctx.fillStyle = '#ffffcc';
            ctx.beginPath();
            ctx.arc(fx, fy, flameSize * 0.3, 0, Math.PI * 2);
            ctx.fill();
        }
        
        // Draw flame/smoke/spark particles (like fireball trail)
        for (let i = 0; i < this._particles.length; i++) {
            const p = this._particles[i];
            const px = p.x - camera.x;
            const py = p.y - camera.y;
            const pFade = p.life / p.maxLife;
            
            if (p.type === 'flame') {
                // Flame particle with glow
                ctx.globalAlpha = pFade * 0.8 * fade * fadeIn;
                
                // Outer glow
                const flameGrad = ctx.createRadialGradient(px, py, 0, px, py, p.size);
                flameGrad.addColorStop(0, p.color);
                flameGrad.addColorStop(1, 'rgba(255, 100, 0, 0)');
                ctx.fillStyle = flameGrad;
                ctx.beginPath();
                ctx.arc(px, py, p.size, 0, Math.PI * 2);
                ctx.fill();
                
                // Bright core
                ctx.globalAlpha = pFade * fade * fadeIn;
                ctx.fillStyle = '#ffff99';
                ctx.beginPath();
                ctx.arc(px, py, p.size * 0.4, 0, Math.PI * 2);
                ctx.fill();
            } else if (p.type === 'smoke') {
                // Smoke particle (dark grey, expands and fades)
                ctx.globalAlpha = pFade * 0.35 * fade * fadeIn;
                const smokeGrad = ctx.createRadialGradient(px, py, 0, px, py, p.size);
                smokeGrad.addColorStop(0, 'rgba(60, 60, 60, 0.6)');
                smokeGrad.addColorStop(0.5, 'rgba(40, 40, 40, 0.3)');
                smokeGrad.addColorStop(1, 'rgba(20, 20, 20, 0)');
                ctx.fillStyle = smokeGrad;
                ctx.beginPath();
                ctx.arc(px, py, p.size, 0, Math.PI * 2);
                ctx.fill();
            } else if (p.type === 'spark') {
                // Spark particle
                ctx.globalAlpha = pFade * fade * fadeIn;
                
                // Spark glow
                ctx.fillStyle = '#ffaa44';
                ctx.beginPath();
                ctx.arc(px, py, p.size, 0, Math.PI * 2);
                ctx.fill();
                
                // Spark core (brighter)
                ctx.globalAlpha = pFade * 0.8 * fade * fadeIn;
                ctx.fillStyle = '#ffffcc';
                ctx.beginPath();
                ctx.arc(px, py, p.size * 0.4, 0, Math.PI * 2);
                ctx.fill();
            }
        }
        
        // Draw pool boundary ring
        ctx.globalAlpha = 0.4 * fade * fadeIn;
        ctx.strokeStyle = '#ff4400';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(sx, sy, currentR, 0, Math.PI * 2);
        ctx.stroke();
        
        // Hostile indicator (red glow if hostile to local player)
        if (window.player && this.isHostileTo(window.player)) {
            ctx.globalAlpha = 0.4 * fade * fadeIn;
            ctx.strokeStyle = '#ff0000';
            ctx.lineWidth = 3;
            ctx.setLineDash([10, 5]);
            ctx.beginPath();
            ctx.arc(sx, sy, currentR + 5, 0, Math.PI * 2);
            ctx.stroke();
            ctx.setLineDash([]);
        }
        
        ctx.restore();
    }
    
    onExpire() {
        // Optional: spawn fade-out VFX
        console.log('[MolotovPool] Fire pool expired at', this.x, this.y);
    }
}

window.MolotovPool = MolotovPool;

