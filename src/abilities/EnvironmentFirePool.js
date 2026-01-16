// Environment Fire Pool - Permanent hazard (duplicated from MolotovPool)
// Never expires, used only as server-spawned environment hazard
class EnvironmentFirePool extends AbilityBase {
    // ---- Sprite caches (shared across all pools) ----
    static _ensureCaches() {
        if (EnvironmentFirePool._cachesReady) return;
        EnvironmentFirePool._cachesReady = true;

        // Fire particle sprites live in _spriteCache (built lazily; sentinel used below).
        if (!EnvironmentFirePool._spriteCache) EnvironmentFirePool._spriteCache = { __fireSpritesBuilt: false };

        // Ember glow sprites (soft radial blobs) keyed by size
        EnvironmentFirePool._emberGlowCache = {};
        const glowSizes = [8, 12, 16, 20, 24, 32, 40, 52];
        for (const s of glowSizes) {
            const c = document.createElement('canvas');
            c.width = c.height = s * 2;
            const g = c.getContext('2d');
            const grad = g.createRadialGradient(s, s, 0, s, s, s);
            grad.addColorStop(0, 'rgba(255, 230, 170, 1)');
            grad.addColorStop(0.35, 'rgba(255, 150, 60, 0.75)');
            grad.addColorStop(0.65, 'rgba(200, 60, 10, 0.35)');
            grad.addColorStop(1, 'rgba(80, 20, 0, 0)');
            g.fillStyle = grad;
            g.beginPath();
            g.arc(s, s, s, 0, Math.PI * 2);
            g.fill();
            EnvironmentFirePool._emberGlowCache[String(s)] = c;
        }

        // Ember chunk sprites (small “burning wood” blocks) keyed by style
        EnvironmentFirePool._emberChunkCache = {};
        const chunkStyles = [
            { base: '#1a0a00', hot1: 'rgba(255, 120, 30, 0.75)', hot2: 'rgba(255, 200, 70, 1)', core: '#fff2c6' },
            { base: '#120700', hot1: 'rgba(255, 90, 20, 0.7)', hot2: 'rgba(255, 170, 50, 1)', core: '#fff6d2' },
            { base: '#1b0b02', hot1: 'rgba(255, 110, 25, 0.75)', hot2: 'rgba(255, 190, 60, 1)', core: '#fff0bf' }
        ];
        for (let si = 0; si < chunkStyles.length; si++) {
            const style = chunkStyles[si];
            const size = 32;
            const c = document.createElement('canvas');
            c.width = c.height = size;
            const g = c.getContext('2d');

            // Dark charred base
            g.fillStyle = style.base;
            g.fillRect(0, 0, size, size);

            // Hot edges: precomputed linear gradient once per sprite
            const edge = g.createLinearGradient(0, 0, size, 0);
            edge.addColorStop(0, style.hot1);
            edge.addColorStop(0.5, style.hot2);
            edge.addColorStop(1, style.hot1);
            g.fillStyle = edge;
            g.globalAlpha = 0.85;
            g.fillRect(0, 0, size, size);
            g.globalAlpha = 1;

            // Bright core
            g.fillStyle = style.core;
            g.globalAlpha = 0.85;
            g.fillRect(size * 0.28, size * 0.28, size * 0.44, size * 0.44);
            g.globalAlpha = 1;

            // Subtle outline
            g.strokeStyle = 'rgba(0,0,0,0.55)';
            g.lineWidth = 2;
            g.strokeRect(1, 1, size - 2, size - 2);

            EnvironmentFirePool._emberChunkCache[String(si)] = c;
        }

        // Static flame sprites (soft vertical “tongue”) keyed by size+color
        EnvironmentFirePool._flameSpriteCache = {};
        const flameSizes = [16, 22, 28, 36];
        const flameColors = [
            { hot: 'rgba(255, 255, 205, 0.95)', mid: 'rgba(255, 180, 60, 0.85)', outer: 'rgba(255, 90, 20, 0.0)' },
            { hot: 'rgba(255, 245, 190, 0.95)', mid: 'rgba(255, 165, 50, 0.85)', outer: 'rgba(220, 70, 10, 0.0)' }
        ];
        for (const s of flameSizes) {
            for (let ci = 0; ci < flameColors.length; ci++) {
                const col = flameColors[ci];
                const c = document.createElement('canvas');
                c.width = c.height = s * 2;
                const g = c.getContext('2d');

                // Slightly stretched radial gradient to approximate an ellipse flame
                g.save();
                g.translate(s, s);
                g.scale(0.8, 1.35);
                const grad = g.createRadialGradient(0, 0, 0, 0, 0, s);
                grad.addColorStop(0, col.hot);
                grad.addColorStop(0.55, col.mid);
                grad.addColorStop(1, col.outer);
                g.fillStyle = grad;
                g.beginPath();
                g.arc(0, 0, s, 0, Math.PI * 2);
                g.fill();
                g.restore();

                // Core dot
                g.fillStyle = 'rgba(255, 255, 230, 0.9)';
                g.beginPath();
                g.arc(s, s, s * 0.22, 0, Math.PI * 2);
                g.fill();

                EnvironmentFirePool._flameSpriteCache[`${s}_${ci}`] = c;
            }
        }
    }

    static _closestSize(target, sizes) {
        let best = sizes[0];
        let bestD = Math.abs(best - target);
        for (let i = 1; i < sizes.length; i++) {
            const d = Math.abs(sizes[i] - target);
            if (d < bestD) { bestD = d; best = sizes[i]; }
        }
        return best;
    }

    _ensureInstanceCaches() {
        // Base layer cache (static) and dynamic low-res layer cache (embers/flames)
        if (!this._baseCache) this._buildBaseCache();
        if (!this._layerCache) {
            this._layerCache = { canvas: null, ctx: null, rw: 0, rh: 0, scale: 0, key: '', lastMs: 0 };
        }
    }

    _buildBaseCache() {
        // Pre-render the expensive static base (char + irregular glow) into an offscreen canvas.
        const r = this.maxRadius;
        const pad = 70; // margin for glow falloff
        const size = Math.max(2, Math.ceil(r * 2 + pad * 2));
        const c = document.createElement('canvas');
        c.width = c.height = size;
        const g = c.getContext('2d');
        const cx = size * 0.5;
        const cy = size * 0.5;

        // Helper to trace irregular pool path in local coords
        const tracePath = (ctx) => {
            ctx.beginPath();
            for (let i = 0; i < this._irregularShape.length; i++) {
                const pt = this._irregularShape[i];
                const px = cx + Math.cos(pt.angle) * r * pt.radiusMult;
                const py = cy + Math.sin(pt.angle) * r * pt.radiusMult;
                if (i === 0) ctx.moveTo(px, py);
                else ctx.lineTo(px, py);
            }
            ctx.closePath();
        };

        // Charred base fill
        g.globalAlpha = 0.6;
        g.fillStyle = '#0a0604';
        tracePath(g);
        g.fill();

        // Subtle glow fill (radial gradient) - expensive, but now done once
        g.globalAlpha = 1.0;
        const glowGrad = g.createRadialGradient(cx, cy, 0, cx, cy, r + pad * 0.65);
        glowGrad.addColorStop(0, 'rgba(255, 120, 40, 0.2)');
        glowGrad.addColorStop(0.4, 'rgba(255, 100, 30, 0.12)');
        glowGrad.addColorStop(0.7, 'rgba(255, 80, 20, 0.05)');
        glowGrad.addColorStop(1, 'rgba(255, 60, 10, 0)');
        g.fillStyle = glowGrad;
        tracePath(g);
        g.fill();

        // NOTE: Removed the large circular soot vignette overlay.
        // It could read as a big semi-opaque black circle and draw over nearby walls/geometry.

        this._baseCache = { canvas: c, half: size * 0.5, size };
    }

    _refreshDynamicLayer(scale, key) {
        // Rebuild a low-res dynamic layer for mid/far or low-perf: embers + flames (sprites only).
        const r = this.maxRadius;
        const pad = 70;
        const size = Math.max(2, Math.ceil((r * 2 + pad * 2) * scale));
        if (!this._layerCache.canvas || this._layerCache.rw !== size || this._layerCache.rh !== size || this._layerCache.scale !== scale) {
            this._layerCache.canvas = document.createElement('canvas');
            this._layerCache.canvas.width = size;
            this._layerCache.canvas.height = size;
            this._layerCache.ctx = this._layerCache.canvas.getContext('2d');
            this._layerCache.rw = size;
            this._layerCache.rh = size;
            this._layerCache.scale = scale;
        }
        const g = this._layerCache.ctx;
        const cx = size * 0.5;
        const cy = size * 0.5;

        g.clearRect(0, 0, size, size);

        // Embers: draw glow then chunk (scaled)
        const glowSizes = [8, 12, 16, 20, 24, 32, 40, 52];
        const pulse = this._emberPulse || 0.5;
        for (let i = 0; i < this._emberSpots.length; i++) {
            const e = this._emberSpots[i];
            const ex = cx + e.offsetX * scale;
            const ey = cy + e.offsetY * scale;
            const p = e._pulse != null ? e._pulse : pulse;
            const a = (e.intensity || 0.8) * (0.65 + p * 0.55);

            const glowSize = Math.max(e.width, e.height) * (1.2 + p * 0.6);
            const gs = EnvironmentFirePool._closestSize(glowSize, glowSizes);
            const glow = EnvironmentFirePool._emberGlowCache[String(gs)];
            if (glow) {
                g.globalAlpha = a * 0.9;
                g.drawImage(glow, ex - gs, ey - gs, gs * 2, gs * 2);
            }

            // Chunk sprite (style-fixed per ember)
            const chunk = EnvironmentFirePool._emberChunkCache[String(e.style || 0)];
            if (chunk) {
                g.save();
                g.translate(ex, ey);
                g.rotate(e.rotation || 0);
                const w = Math.max(2, (e.width || 8) * scale);
                const h = Math.max(2, (e.height || 8) * scale);
                g.globalAlpha = 0.85 + 0.15 * p;
                g.drawImage(chunk, -w * 0.5, -h * 0.5, w, h);
                // Occasional bright core “pop”
                if (p > 0.62) {
                    g.globalAlpha = (p - 0.62) * 1.8 * (e.intensity || 0.9);
                    g.fillStyle = 'rgba(255, 250, 210, 0.95)';
                    g.fillRect(-w * 0.22, -h * 0.22, w * 0.44, h * 0.44);
                }
                g.restore();
            }
        }

        // Static flame sprites: sprite-based (no per-frame gradients here)
        for (let i = 0; i < this._flameSprites.length; i++) {
            const f = this._flameSprites[i];
            const fx = cx + f.offsetX * scale;
            const fy = cy + f.offsetY * scale;
            const flicker = 0.7 + Math.sin((this._flameTime || 0) * 4 + f.phase) * 0.3;
            const wobble = Math.sin((this._flameTime || 0) * 5 + f.id) * 0.15;
            const sizePx = (f.size || 16) * flicker;
            const flameSizes = [16, 22, 28, 36];
            const fs = EnvironmentFirePool._closestSize(sizePx, flameSizes);
            const ci = (f._colorIdx != null) ? f._colorIdx : 0;
            const spr = EnvironmentFirePool._flameSpriteCache[`${fs}_${ci}`];
            if (spr) {
                g.save();
                g.translate(fx, fy);
                g.rotate(wobble * 0.25);
                g.globalAlpha = (0.9 + 0.1 * flicker) * (f.intensity || 0.9);
                g.drawImage(spr, -fs, -fs, fs * 2, fs * 2);
                g.restore();
            }
        }

        g.globalAlpha = 1.0;
        this._layerCache.key = key;
        this._layerCache.lastMs = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    }

    constructor(x, y, radius = 200, dotDps = 20, dotDuration = 3.0) {
        super(x, y, null, {
            radius: radius,
            color: '#ff6600',
            maxLife: null, // Infinite duration
            serverSync: true
        });
        
        this.maxRadius = radius;
        this.elapsed = 0;
        
        // DOT application (baseline: 20 DPS like Molotov)
        this.dotDps = dotDps;
        this.dotDuration = dotDuration;
        this.dotTickInterval = 0.5; // Apply DOT every 0.5s for performance
        this.dotTickTimer = 0;
        
        console.log('[EnvironmentFirePool] Created at', x.toFixed(1), y.toFixed(1), 'radius:', radius.toFixed(1), 'dotDps:', dotDps.toFixed(1));

        // Ensure shared caches exist
        EnvironmentFirePool._ensureCaches();
        
        // Flame animation - using particle system like fireball trail
        this._flameTime = 0;
        this._flameParticles = []; // Only flames/sparks stored locally
        this._particleSpawnTimer = 0;
        this._particleSpawnRate = 0.06; // Slower spawn rate for consistent emission (was 0.02)
        
        // Initialize global smoke particle array if needed
        if (!window._globalSmokeParticles) {
            window._globalSmokeParticles = [];
        }
        
        // Create burning wood chunks on ground (static glow positions)
        this._emberSpots = [];
        const emberCount = 52 + Math.floor(Math.random() * 28); // 52-80 embers (fewer, but sprites keep density)
        for (let i = 0; i < emberCount; i++) {
            const angle = Math.random() * Math.PI * 2;
            const dist = Math.random() * this.maxRadius * 0.95;
            this._emberSpots.push({
                offsetX: Math.cos(angle) * dist,
                offsetY: Math.sin(angle) * dist,
                width: 3 + Math.random() * 18, // Much more variation: 3-21 pixels
                height: 3 + Math.random() * 18, // Much more variation: 3-21 pixels
                rotation: Math.random() * Math.PI * 2, // Random rotation
                intensity: 0.6 + Math.random() * 0.4,
                phase: Math.random() * Math.PI * 2,
                style: Math.floor(Math.random() * 3), // sprite style id
                _pulse: 0.5
            });
        }
        
        // Create irregular pool shape (like mud puddle)
        this._irregularShape = [];
        const shapePoints = 24; // Points around perimeter
        for (let i = 0; i < shapePoints; i++) {
            const angle = (i / shapePoints) * Math.PI * 2;
            const radiusVariation = 0.85 + Math.random() * 0.3; // 85-115% of radius
            const jitter = (Math.random() - 0.5) * 0.15; // Small random offset
            this._irregularShape.push({
                angle: angle + jitter,
                radiusMult: radiusVariation
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
                id: i,
                _colorIdx: Math.random() < 0.55 ? 0 : 1
            });
        }
        
        // Performance: Update throttling
        this._physicsAccumulator = 0;
        this._physicsRate = 1/30; // Update physics at 30 FPS
        
        // Performance: Pre-rendered sprite cache for fire/smoke particles
        if (!EnvironmentFirePool._spriteCache || !EnvironmentFirePool._spriteCache.__fireSpritesBuilt) {
            console.log('[EnvironmentFirePool] Creating sprite cache...');
            EnvironmentFirePool._spriteCache = EnvironmentFirePool._spriteCache || {};
            const sizes = [10, 15, 20, 30, 40]; // Pre-render 5 sizes
            
            // Fire particle sprites (orange/red)
            const fireColors = ['#ff6600', '#ffaa33', '#ff8800'];
            for (const size of sizes) {
                for (const color of fireColors) {
                    const canvas = document.createElement('canvas');
                    canvas.width = canvas.height = size * 2;
                    const ctx = canvas.getContext('2d');
                    
                    // Outer glow
                    const grad = ctx.createRadialGradient(size, size, 0, size, size, size);
                    grad.addColorStop(0, color);
                    grad.addColorStop(1, 'rgba(255, 100, 0, 0)');
                    ctx.fillStyle = grad;
                    ctx.beginPath();
                    ctx.arc(size, size, size, 0, Math.PI * 2);
                    ctx.fill();
                    
                    // Bright core
                    ctx.fillStyle = '#ffff99';
                    ctx.beginPath();
                    ctx.arc(size, size, size * 0.4, 0, Math.PI * 2);
                    ctx.fill();
                    
                    EnvironmentFirePool._spriteCache[`fire_${size}_${color}`] = canvas;
                }
            }
            
            EnvironmentFirePool._spriteCache.__fireSpritesBuilt = true;
            console.log('[EnvironmentFirePool] Sprite cache created:', Object.keys(EnvironmentFirePool._spriteCache).length, 'sprites');
        }

        // Instance caches (static base + dynamic layer)
        this._baseCache = null;
        this._layerCache = null;
        this._pulseT = 0;
        this._lastPulseKey = '';
        this._emberPulse = 0.5;
    }
    
    update(dt, environment, enemies, players) {
        if (!this.alive) return;
        
        // Don't call super.update() to skip lifetime countdown
        this.age += dt;
        
        this.elapsed += dt;
        this._flameTime += dt;
        this.dotTickTimer += dt;
        this._particleSpawnTimer += dt;
        
        // Performance: Throttled physics updates (30 FPS instead of 60)
        this._physicsAccumulator += dt;

        // Update throttled ember pulses (~15Hz) so draw() can be cheap.
        // Quantize time so we avoid recalculating per-frame when FPS is high.
        const t = this._flameTime;
        const pulseKey = String(Math.floor(t * 15)); // 15Hz steps
        if (pulseKey !== this._lastPulseKey) {
            this._lastPulseKey = pulseKey;
            const tQ = (Math.floor(t * 15) / 15);
            this._pulseT = tQ;
            // Shared “ambient” pulse used by LOD layers
            this._emberPulse = 0.5 + Math.sin(tQ * 3) * 0.22;
            for (let i = 0; i < this._emberSpots.length; i++) {
                const e = this._emberSpots[i];
                e._pulse = 0.5 + Math.sin(tQ * 3 + (e.phase || 0)) * 0.3;
            }
        }
        
        // Spawn flame/smoke/spark particles constantly (not throttled for smooth emission)
        const currentR = this.maxRadius;
        const totalParticles = this._flameParticles.length + (window._globalSmokeParticles ? window._globalSmokeParticles.length : 0);
        
        // 50% reduction again: 105 -> 52 particles
        while (this._particleSpawnTimer >= this._particleSpawnRate && totalParticles < 52) {
            this._particleSpawnTimer -= this._particleSpawnRate;
            
            // Random position within pool
            const angle = Math.random() * Math.PI * 2;
            const dist = Math.random() * currentR * 0.85;
            const spawnX = this.x + Math.cos(angle) * dist;
            const spawnY = this.y + Math.sin(angle) * dist;
            
            // 25% flame, 75% smoke
            if (Math.random() < 0.25) {
                // Flame particle (local)
                this._flameParticles.push({
                    type: 'flame',
                    x: spawnX,
                    y: spawnY,
                    vx: (Math.random() - 0.5) * 30,
                    vy: -40 - Math.random() * 40, // Rise upward
                    life: 0.5 + Math.random() * 0.4, // Increased: 0.5-0.9s (was 0.4-0.7s)
                    maxLife: 0.9,
                    size: 8 + Math.random() * 6,
                    color: Math.random() > 0.5 ? '#ff6600' : '#ffaa33'
                });
            } else {
                // Smoke particle (global - renders on top!) - flat grey colors for performance
                if (window._globalSmokeParticles) {
                    // Simple flat grey colors (no gradients needed!)
                    const greyColors = ['#3a3a3a', '#454545', '#505050']; // 3 shades of grey
                    window._globalSmokeParticles.push({
                        type: 'smoke',
                        x: spawnX,
                        y: spawnY,
                        vx: (Math.random() - 0.5) * 25,
                        vy: -50 - Math.random() * 60, // Billow upwards faster!
                        life: 3.0 + Math.random() * 2.5, // Increased: 3.0-5.5s (was 2.5-4.5s)
                        maxLife: 5.5,
                        size: 14 + Math.random() * 16, // Start bigger
                        opacity: 0.075 + Math.random() * 0.075, // Half again: 0.075-0.15 (was 0.15-0.30)
                        color: greyColors[Math.floor(Math.random() * greyColors.length)] // Flat color
                    });
                }
            }
            
            // Occasional sparks (local)
            if (Math.random() < 0.2) {
                this._flameParticles.push({
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
        
        // Performance: Update particle physics at 30 FPS only
        while (this._physicsAccumulator >= this._physicsRate) {
            this._physicsAccumulator -= this._physicsRate;
            
            // Update local flame/spark particles
            for (let i = this._flameParticles.length - 1; i >= 0; i--) {
                const p = this._flameParticles[i];
                p.life -= this._physicsRate;
                p.x += p.vx * this._physicsRate;
                p.y += p.vy * this._physicsRate;
                
                // Sparks affected by gravity
                if (p.type === 'spark') {
                    p.vy += 200 * this._physicsRate;
                }
                
                // Remove dead particles
                if (p.life <= 0) {
                    this._flameParticles.splice(i, 1);
                }
            }
            
            // Update global smoke particles (shared across all fire pools)
            if (window._globalSmokeParticles) {
                for (let i = window._globalSmokeParticles.length - 1; i >= 0; i--) {
                    const p = window._globalSmokeParticles[i];
                    if (!p) {
                        window._globalSmokeParticles.splice(i, 1);
                        continue;
                    }
                    
                    p.life -= this._physicsRate;
                    p.x += p.vx * this._physicsRate;
                    p.y += p.vy * this._physicsRate;
                    
                    // Smoke expands as it rises
                    p.size += 25 * this._physicsRate;
                    
                    // Remove dead particles
                    if (p.life <= 0) {
                        window._globalSmokeParticles.splice(i, 1);
                    }
                }
            }
        }
        
        // Apply DOT damage to players and enemies
        if (this.dotTickTimer >= this.dotTickInterval) {
            this.dotTickTimer = 0;
            this._applyDotToEntitiesInRadius(enemies, players);
        }
    }
    
    _applyDotToEntitiesInRadius(enemies, players) {
        const currentRadius = this.maxRadius;
        
        // Apply DOT to enemies (client-side for environment hazard)
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
                    // Apply DOT locally for regular enemies
                    if (e.applyDot && typeof e.applyDot === 'function') {
                        try {
                            // NPC_B DOT is server-authoritative
                            if (e.name === 'NPC_B' && e._serverId && window.networkManager) {
                                window.networkManager.sendNPCDot(e._serverId, this.dotDps, this.dotDuration);
                            } else {
                                // For regular enemies, apply DOT locally
                                e.applyDot(this.dotDps, this.dotDuration, { owner: null });
                            }
                        } catch(err) {
                            console.error('[EnvironmentFirePool] Failed to apply DOT to enemy:', err);
                        }
                    }
                }
            }
        }
        
    // DOT damage is server-authoritative (multiplayer-only game)
    // Client only renders VFX, server handles all damage
    // No need to apply DOT to players on client side
    }
    
    draw(ctx, camera) {
        if (!this.alive) return;
        
        const sx = this.x - camera.x;
        const sy = this.y - camera.y;
        const currentR = this.maxRadius;
        const t = this._flameTime;

        // Build caches on first draw (requires DOM canvas)
        this._ensureInstanceCaches();

        // Cull entire pool if off-screen (big win when many hazards exist)
        const vw = (ctx && ctx.canvas && ctx.canvas.width) ? ctx.canvas.width : 1920;
        const vh = (ctx && ctx.canvas && ctx.canvas.height) ? ctx.canvas.height : 1080;
        const padCull = 90;
        if (sx + currentR < -padCull || sx - currentR > vw + padCull || sy + currentR < -padCull || sy - currentR > vh + padCull) {
            return;
        }

        // LOD POLICY:
        // The low-res cached layer should NEVER be used while the pool could be visible.
        // This prevents any noticeable "swap" when walking away or during dt spikes (e.g. getting hurt/shake).
        // We keep the low-res codepath only for potential future use (e.g. offscreen pre-warm), but it must not render on-screen.
        const useLowResLayer = false;
        
        ctx.save();

        // --- Base layer (cached) ---
        if (this._baseCache && this._baseCache.canvas) {
            ctx.globalAlpha = 1.0;
            const half = this._baseCache.half || (this._baseCache.size * 0.5);
            ctx.drawImage(this._baseCache.canvas, sx - half, sy - half);
        }

        // --- Dynamic layer ---
        if (useLowResLayer) {
            // Low-res cached layer for embers + flames (reduces draw calls dramatically)
            const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
            const pulseKey = `${Math.floor((this._pulseT || 0) * 15)}|d${Math.floor(dist / 120)}|p${perfLow ? 1 : 0}|s${layerScale}`;
            const needsRefresh = (!this._layerCache || this._layerCache.key !== pulseKey || !this._layerCache.lastMs || (now - this._layerCache.lastMs) >= layerIntervalMs);
            if (needsRefresh) {
                this._refreshDynamicLayer(layerScale, pulseKey);
            }
            if (this._layerCache && this._layerCache.canvas) {
                const r = this.maxRadius;
                const pad = 70;
                const size = (r * 2 + pad * 2);
                ctx.globalAlpha = 1.0;
                ctx.drawImage(
                    this._layerCache.canvas,
                    sx - (size * 0.5),
                    sy - (size * 0.5),
                    size,
                    size
                );
            }
        } else {
            // High detail path (still optimized: sprite-based, no per-ember gradients)
            const glowSizes = [8, 12, 16, 20, 24, 32, 40, 52];
            const pulseT = this._pulseT || t;

            // Embers
            for (let i = 0; i < this._emberSpots.length; i++) {
                const ember = this._emberSpots[i];
                const ex = sx + ember.offsetX;
                const ey = sy + ember.offsetY;

                const p = (ember._pulse != null) ? ember._pulse : (0.5 + Math.sin(pulseT * 3 + (ember.phase || 0)) * 0.3);
                const intensity = ember.intensity || 0.8;
                const glowSize = Math.max(ember.width, ember.height) * (1.2 + p * 0.6);
                const gs = EnvironmentFirePool._closestSize(glowSize, glowSizes);
                const glow = EnvironmentFirePool._emberGlowCache[String(gs)];
                if (glow) {
                    ctx.globalAlpha = intensity * (0.65 + p * 0.55);
                    ctx.drawImage(glow, ex - gs, ey - gs, gs * 2, gs * 2);
                }

                // Burning chunk
                const chunk = EnvironmentFirePool._emberChunkCache[String(ember.style || 0)];
                if (chunk) {
                    ctx.save();
                    ctx.translate(ex, ey);
                    ctx.rotate(ember.rotation || 0);
                    ctx.globalAlpha = 0.85 + 0.15 * p;
                    ctx.drawImage(chunk, -ember.width / 2, -ember.height / 2, ember.width, ember.height);
                    // Extra bright core for hottest moments
                    if (p > 0.62) {
                        ctx.globalAlpha = (p - 0.62) * 1.8 * intensity;
                        ctx.fillStyle = 'rgba(255, 250, 210, 0.95)';
                        ctx.fillRect(-ember.width / 4, -ember.height / 4, ember.width / 2, ember.height / 2);
                    }
                    ctx.restore();
                }
            }

            // Static flame sprites (sprite-based)
            const flameSizes = [16, 22, 28, 36];
            for (let i = 0; i < this._flameSprites.length; i++) {
                const flame = this._flameSprites[i];
                const fx = sx + flame.offsetX;
                const fy = sy + flame.offsetY;
                const flicker = 0.7 + Math.sin(t * 4 + flame.phase) * 0.3;
                const wobble = Math.sin(t * 5 + flame.id) * 0.15;
                const flameSize = (flame.size || 16) * flicker;
                const fs = EnvironmentFirePool._closestSize(flameSize, flameSizes);
                const ci = (flame._colorIdx != null) ? flame._colorIdx : 0;
                const spr = EnvironmentFirePool._flameSpriteCache[`${fs}_${ci}`];
                if (spr) {
                    ctx.save();
                    ctx.translate(fx, fy);
                    ctx.rotate(wobble * 0.25);
                    ctx.globalAlpha = (flame.intensity || 0.9) * (0.9 + 0.1 * flicker);
                    ctx.drawImage(spr, -fs, -fs, fs * 2, fs * 2);
                    ctx.restore();
                }
            }
        }
        
        // Draw only local flame/spark particles (smoke is drawn globally in ClientRender.js)
        // Pre-rendered sprite sizes
        const cachedSizes = [10, 15, 20, 30, 40];
        
        for (let i = 0; i < this._flameParticles.length; i++) {
            const p = this._flameParticles[i];
            const px = p.x - camera.x;
            const py = p.y - camera.y;
            
            // Frustum culling - skip if offscreen
            if (px < -p.size || px > vw + p.size || py < -p.size || py > vh + p.size) continue;
            
            const pFade = p.life / p.maxLife;
            
            if (p.type === 'flame') {
                // Performance: Use pre-rendered sprite instead of gradient
                // Find closest cached sprite size
                const closestSize = cachedSizes.reduce((prev, curr) => 
                    Math.abs(curr - p.size) < Math.abs(prev - p.size) ? curr : prev
                );
                
                const spriteKey = `fire_${closestSize}_${p.color}`;
                const sprite = EnvironmentFirePool._spriteCache[spriteKey];
                
                if (sprite) {
                    // Draw cached sprite (much faster than gradient)
                    ctx.globalAlpha = pFade * 0.8;
                    ctx.drawImage(sprite, 
                        px - p.size, py - p.size,  // Position
                        p.size * 2, p.size * 2      // Size (scaled)
                    );
                } else {
                    // Fallback: draw with gradient if sprite missing (shouldn't happen)
                    ctx.globalAlpha = pFade * 0.8;
                    
                    // Outer glow
                    const flameGrad = ctx.createRadialGradient(px, py, 0, px, py, p.size);
                    flameGrad.addColorStop(0, p.color);
                    flameGrad.addColorStop(1, 'rgba(255, 100, 0, 0)');
                    ctx.fillStyle = flameGrad;
                    ctx.beginPath();
                    ctx.arc(px, py, p.size, 0, Math.PI * 2);
                    ctx.fill();
                    
                    // Bright core
                    ctx.globalAlpha = pFade;
                    ctx.fillStyle = '#ffff99';
                    ctx.beginPath();
                    ctx.arc(px, py, p.size * 0.4, 0, Math.PI * 2);
                    ctx.fill();
                }
            } else if (p.type === 'spark') {
                // Spark particle
                ctx.globalAlpha = pFade;
                
                // Spark glow
                ctx.fillStyle = '#ffaa44';
                ctx.beginPath();
                ctx.arc(px, py, p.size, 0, Math.PI * 2);
                ctx.fill();
                
                // Spark core (brighter)
                ctx.globalAlpha = pFade * 0.8;
                ctx.fillStyle = '#ffffcc';
                ctx.beginPath();
                ctx.arc(px, py, p.size * 0.4, 0, Math.PI * 2);
                ctx.fill();
            }
        }
        
        // No boundary ring - irregular shape speaks for itself
        
        ctx.restore();
    }
    
    onExpire() {
        // Environment fire pools don't expire
        console.log('[EnvironmentFirePool] Fire pool removed at', this.x, this.y);
    }
}

window.EnvironmentFirePool = EnvironmentFirePool;

