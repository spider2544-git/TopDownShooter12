// Hard-off debug build flag (performance): keep debug logs in code, but don't run them unless enabled.
// NOTE: This file is loaded as a classic script (shared global scope). Don't use top-level `const DEBUG_BUILD`.
var __DEBUG_BUILD = (typeof window !== 'undefined' && window.DEBUG_BUILD === true);

class Enemy {
        constructor(x, y) {
                if (typeof Enemy._nextId !== 'number') Enemy._nextId = 1;
                this.id = Enemy._nextId++;
                this.x = x;
                this.y = y;
                this.radius = 26;
                this.color = '#7fbf7f';
                this.outline = '#000000';
                this.healthMax = 100;
                this.health = this.healthMax;
                this.alive = true;
                // Knockback state (applied over time)
                this.kbVelX = 0;
                this.kbVelY = 0;
                this.kbTime = 0;
                this.kbPushedIds = new Set(); // track secondary pushes to cap
                // Damage-over-time stacks: array of { dps, timeLeft, owner }
                this.dotStacks = [];
                // Local VFX clock for animated fire
                this._fxTime = 0;
                // DOT floating text aggregation
                this._dotAccum = 0;
                this._dotTextTimer = 0;
                this._serverDeathNotified = false;
        }

        _notifyServerDeath(cause) {
                if (!this.serverSpawned || !this._serverId || this._serverDeathNotified) return;
                const net = window.networkManager;
                if (!net || !net.connected || !net.socket || typeof net.socket.emit !== 'function') return;
                try {
                        // DEBUG:GhostEnemy - Log when client sends death notification to server
                        // console.log(`[DEBUG:GhostEnemy] Client sending enemyDied for ${this._serverId} (type:${this.type}, cause:${cause}) at ${Date.now()}`);
                        
                        // Track recently killed enemies to prevent false ghost detection during network latency // DEBUG:GhostEnemy
                        if (!net._recentlyKilledEnemies) net._recentlyKilledEnemies = new Map(); // DEBUG:GhostEnemy
                        net._recentlyKilledEnemies.set(this._serverId, Date.now()); // DEBUG:GhostEnemy
                        
                        net.socket.emit('enemyDied', { id: this._serverId, cause: cause || 'unknown' });
                        this._serverDeathNotified = true;
                } catch(_) {}
        }

        applyDamage(amount, hit) {
                if (!this.alive) return;
                this.health -= amount;
                // Enqueue blood VFX on hit (best-effort)
                try {
                        const hx = (hit && Number.isFinite(hit.x)) ? hit.x : this.x;
                        const hy = (hit && Number.isFinite(hit.y)) ? hit.y : this.y;
                        const dirX = (hit && Number.isFinite(hit.dirX)) ? hit.dirX : 0;
                        const dirY = (hit && Number.isFinite(hit.dirY)) ? hit.dirY : 0;
                        if (typeof window.enqueueEnemyVfx === 'function') {
                                window.enqueueEnemyVfx(new BloodSplatterVfx(hx, hy, dirX, dirY));
                        }
                } catch(e) {}
                if (this.health <= 0) {
                        this.health = 0;
                        this.alive = false;
                        this._notifyServerDeath('hit');
                        // Spawn a persistent blood pool decal at death location (under everything)
                        // Skip blood pool for enemies with custom death pools (e.g., boomers use puke pools)
                        try { 
                                // IMPORTANT: In multiplayer, server emits `entity_dead`/`enemy_dead` which will spawn the pool.
                                // Only spawn locally for non-server-controlled enemies (editor/test/local-only).
                                const serverControlled = !!this._serverId || this.serverSpawned || this.serverSync;
                                if (!serverControlled && typeof window.enqueueGroundDecal === 'function' && !this.hasCustomDeathPool) { 
                                        window.enqueueGroundDecal(new BloodPoolDecal(this.x, this.y, this.radius)); 
                                } 
                        } catch(e) {}
                        // Invoke optional death hook for subclasses (e.g., bosses) for all kill types
                        try { if (typeof this.onDeath === 'function') this.onDeath({ cause: 'hit', hit: hit || null }); } catch(e) {}
                }
        }

        applyKnockback(dirX, dirY, distance, durationSec = 0.2) {
                if (!this.alive) return;
                if (!Number.isFinite(distance) || distance <= 0) return;
                const spd = Math.hypot(dirX, dirY) || 1;
                const ux = dirX / spd;
                const uy = dirY / spd;
                const v = distance / Math.max(1e-6, durationSec);
                this.kbVelX += ux * v;
                this.kbVelY += uy * v;
                this.kbTime = Math.max(this.kbTime, durationSec);
        }

        // Apply a DOT stack (dps over duration seconds). Stacks accumulate additively.
        applyDot(dps, durationSec, ownerOrOptions) {
                if (!this.alive) return;
                if (!Number.isFinite(dps) || dps <= 0) return;
                if (!Number.isFinite(durationSec) || durationSec <= 0) return;
                const hadStacks = !!(this.dotStacks && this.dotStacks.length > 0);
                let owner = null;
                if (ownerOrOptions && typeof ownerOrOptions === 'object') {
                        if (ownerOrOptions.x != null && ownerOrOptions.y != null) {
                                // likely a player-like object
                                owner = ownerOrOptions;
                        } else if (ownerOrOptions.owner) {
                                owner = ownerOrOptions.owner;
                        }
                }
                this.dotStacks.push({ dps, timeLeft: durationSec, owner });
                
                // Broadcast burning state for remote flame VFX (enemies only)
                // NOTE: Use serverId so other clients can match it.
                try {
                        if (!hadStacks && owner === window.player && window.networkManager && typeof window.networkManager.sendVfxCreated === 'function' && this._serverId) {
                                window.networkManager.sendVfxCreated('burnStateChanged', this.x, this.y, {
                                        burning: true,
                                        entityType: 'enemy',
                                        entityId: this._serverId,
                                        x: this.x,
                                        y: this.y,
                                        durationMs: Math.round(durationSec * 1000)
                                });
                        }
                } catch(_) {}
        }

        // Tick all active DOT stacks and apply damage without spawning per-frame splatter VFX
        _tickDot(dt) {
                if (!this.alive) return;
                if (!this.dotStacks || this.dotStacks.length === 0) return;
                
                // For server-synchronized target dummies, skip client-side DOT processing
                // The server handles DOT damage and broadcasts updates
                if (this.serverSync && window.networkManager && window.networkManager.connected) {
                    return;
                }
                let totalDps = 0;
                let owner = null;
                for (let i = this.dotStacks.length - 1; i >= 0; i--) {
                        const s = this.dotStacks[i];
                        s.timeLeft -= dt;
                        if (s.timeLeft <= 0) {
                                this.dotStacks.splice(i, 1);
                        } else {
                                totalDps += s.dps;
                                if (!owner && s.owner) owner = s.owner;
                        }
                }
                // If stacks fully expired, broadcast burning stopped (best-effort)
                try {
                        if (this.dotStacks.length === 0 && window.networkManager && typeof window.networkManager.sendVfxCreated === 'function' && this._serverId) {
                                window.networkManager.sendVfxCreated('burnStateChanged', this.x, this.y, {
                                        burning: false,
                                        entityType: 'enemy',
                                        entityId: this._serverId
                                });
                        }
                } catch(_) {}
                if (totalDps > 0) {
                        const damage = totalDps * dt;
                        // Directly reduce health; on death, mirror applyDamage death behavior (no per-frame splatter)
                        this.health -= damage;
                        // Accumulate for floating number and emit periodically
                        this._dotAccum += damage;
                        this._dotTextTimer -= dt;
                        if (this._dotTextTimer <= 0 && this._dotAccum > 0.5) {
                                let isCrit = false;
                                let shown = this._dotAccum;
                                try {
                                        // 5% chance for DOT crits regardless of player's base crit chance
                                        isCrit = Math.random() < 0.05;
                                        if (isCrit) {
                                                const cm = Math.max(1, owner?.critDamageMultiplier ?? 1.2);
                                                const extra = this._dotAccum * (cm - 1);
                                                this.health -= extra;
                                                shown = this._dotAccum * cm;
                                        }
                                } catch(e) {}
                                try {
                                        if (typeof window.enqueueDamageText === 'function') {
                                                window.enqueueDamageText({ x: this.x, y: this.y - (this.radius || 26) - 6, text: String(Math.round(shown)), crit: isCrit, color: isCrit ? '#ffd36b' : '#ff9f2b', vy: -60, life: 0.6 });
                                        }
                                        // Send DOT damage text to other players for synchronization
                                        if (window.networkManager && owner === window.player) {
                                                window.networkManager.sendVfxCreated('damageText', this.x, this.y - (this.radius || 26) - 6, {
                                                        text: String(Math.round(shown)),
                                                        crit: isCrit,
                                                        color: isCrit ? '#ffd36b' : '#ff9f2b',
                                                        vy: -60,
                                                        life: 0.6
                                                });
                                        }
                                } catch(e) {}
                                this._dotAccum = 0;
                                this._dotTextTimer = 0.15;
                        }
                        if (this.health <= 0) {
                                this.health = 0;
                                this.alive = false;
                                this._notifyServerDeath('dot');
                                try {
                                        // IMPORTANT: In multiplayer, server emits `entity_dead`/`enemy_dead` which will spawn the pool.
                                        // Only spawn locally for non-server-controlled enemies (editor/test/local-only).
                                        const serverControlled = !!this._serverId || this.serverSpawned || this.serverSync;
                                        if (!serverControlled && typeof window.enqueueGroundDecal === 'function') {
                                                window.enqueueGroundDecal(new BloodPoolDecal(this.x, this.y, this.radius));
                                        }
                                } catch(e) {}
                                // Invoke optional death hook with DOT cause
                                try { if (typeof this.onDeath === 'function') this.onDeath({ cause: 'dot', owner }); } catch(e) {}
                        }
                }
        }

	draw(ctx, camera) {
		if (!this.alive) return;
		const sx = this.x - camera.x;
		const sy = this.y - camera.y;
		
		// Special rendering for defensive turrets (like AutoTurret but larger and orange)
		if (this.type === 'defenseTurret') {
			ctx.save();
			ctx.translate(sx, sy);
			ctx.rotate(this._barrelAngle || 0);
			
			// Body color - orange for New Antioch
			const bodyColor = '#8a5a3a'; // Dark orange/brown
			const barrelColor = '#ff9900'; // Bright orange
			
			// Draw turret body (hexagon) - larger than player turrets
			const sides = 6;
			const hexRadius = this.radius;
			ctx.globalAlpha = 1.0;
			ctx.shadowBlur = 0;
			ctx.fillStyle = bodyColor;
			ctx.strokeStyle = barrelColor;
			ctx.lineWidth = 3;
			ctx.beginPath();
			for (let i = 0; i < sides; i++) {
				const angle = (i / sides) * Math.PI * 2;
				const x = Math.cos(angle) * hexRadius;
				const y = Math.sin(angle) * hexRadius;
				if (i === 0) ctx.moveTo(x, y);
				else ctx.lineTo(x, y);
			}
			ctx.closePath();
			ctx.fill();
			ctx.stroke();
			
			// Draw twin barrels (like AutoTurret)
			const barrelLength = 32; // Longer than player turret (22)
			const barrelWidth = 7;   // Thicker than player turret (5)
			const barrelOffset = 12; // More spacing than player turret (8)
			
			ctx.shadowBlur = 0;
			ctx.fillStyle = barrelColor;
			ctx.strokeStyle = bodyColor;
			ctx.lineWidth = 2;
			
			// Left barrel
			const leftY = -barrelOffset;
			ctx.fillRect(0, leftY - barrelWidth/2, barrelLength, barrelWidth);
			ctx.strokeRect(0, leftY - barrelWidth/2, barrelLength, barrelWidth);
			
			// Right barrel
			const rightY = barrelOffset;
			ctx.fillRect(0, rightY - barrelWidth/2, barrelLength, barrelWidth);
			ctx.strokeRect(0, rightY - barrelWidth/2, barrelLength, barrelWidth);
			
			// Draw muzzle flashes (if any)
			if (this._muzzleFlashes && Array.isArray(this._muzzleFlashes)) {
				for (let i = 0; i < this._muzzleFlashes.length; i++) {
					const flash = this._muzzleFlashes[i];
					const flashY = (flash.side === 0) ? leftY : rightY;
					const t = flash.life / 0.15;
					const intensity = flash.intensity * t;
					
					ctx.shadowBlur = 0;
					
					// Main flash circle
					ctx.globalAlpha = intensity * 0.9;
					ctx.fillStyle = '#ffff00';
					ctx.beginPath();
					ctx.arc(barrelLength + 6, flashY, 10, 0, Math.PI * 2);
					ctx.fill();
					
					// Outer circle (white)
					ctx.globalAlpha = intensity * 0.6;
					ctx.fillStyle = '#ffffff';
					ctx.beginPath();
					ctx.arc(barrelLength + 6, flashY, 15, 0, Math.PI * 2);
					ctx.fill();
					
					// Flash streaks
					ctx.globalAlpha = intensity * 0.7;
					ctx.strokeStyle = '#ffff88';
					ctx.lineWidth = 3;
					const streakLen = 20 + Math.random() * 12;
					ctx.beginPath();
					ctx.moveTo(barrelLength + 6, flashY);
					ctx.lineTo(barrelLength + 6 + streakLen, flashY + (Math.random() - 0.5) * 10);
					ctx.stroke();
				}
			}
			
			ctx.restore();
			return; // Skip normal enemy rendering
		}
		
		// Special rendering for artillery guns (large cannon with golden colors)
		if (this.type === 'artilleryGun') {
			ctx.save();
			ctx.translate(sx, sy);
			ctx.rotate(this._barrelAngle || 0);
			
			// Large artillery gun - golden/brass colors for New Antioch
			const bodyColor = '#5a4a2a';  // Dark brass
			const barrelColor = '#ffcc00';  // Golden
			const accentColor = '#cc9900';  // Darker gold
			
			// Draw base platform (large octagon for artillery)
			const sides = 8;
			const hexRadius = this.radius;
			ctx.fillStyle = bodyColor;
			ctx.strokeStyle = accentColor;
			ctx.lineWidth = 4;
			ctx.beginPath();
			for (let i = 0; i < sides; i++) {
				const angle = (i / sides) * Math.PI * 2;
				const x = Math.cos(angle) * hexRadius;
				const y = Math.sin(angle) * hexRadius;
				if (i === 0) ctx.moveTo(x, y);
				else ctx.lineTo(x, y);
			}
			ctx.closePath();
			ctx.fill();
			ctx.stroke();
			
			// Inner detail circle
			ctx.fillStyle = '#4a3a1a';
			ctx.beginPath();
			ctx.arc(0, 0, hexRadius * 0.6, 0, Math.PI * 2);
			ctx.fill();
			
			// Draw large cannon barrel
			const barrelLength = 72;
			const barrelWidth = 18;
			ctx.fillStyle = barrelColor;
			ctx.strokeStyle = bodyColor;
			ctx.lineWidth = 3;
			
			// Main barrel
			ctx.fillRect(hexRadius * 0.3, -barrelWidth/2, barrelLength, barrelWidth);
			ctx.strokeRect(hexRadius * 0.3, -barrelWidth/2, barrelLength, barrelWidth);
			
			// Muzzle ring
			ctx.beginPath();
			ctx.arc(hexRadius * 0.3 + barrelLength, 0, barrelWidth/2 + 4, 0, Math.PI * 2);
			ctx.strokeStyle = accentColor;
			ctx.lineWidth = 4;
			ctx.stroke();
			
			// Rear mount
			ctx.fillStyle = accentColor;
			ctx.beginPath();
			ctx.arc(-hexRadius * 0.2, 0, 16, 0, Math.PI * 2);
			ctx.fill();
			
			ctx.restore();
			return; // Skip normal enemy rendering
		}
		
		// Body (normal enemies)
		ctx.beginPath();
		ctx.arc(sx, sy, this.radius, 0, Math.PI * 2);
		ctx.fillStyle = this.color;
		ctx.fill();
		ctx.lineWidth = 3;
		ctx.strokeStyle = this.outline;
		ctx.stroke();
                // Fire VFX for active DOT stacks (weapon 4): single cohesive, animated flame with light sparks + smoke
                // Also show remote burning for enemies when another client applied DOT.
                let dotStacksCount = (this.dotStacks && this.dotStacks.length > 0) ? this.dotStacks.length : 0;
                if (dotStacksCount <= 0) {
                        try {
                                const net = window.networkManager;
                                const id = this._serverId;
                                const entry = (net && net.remoteBurningEntities && id) ? net.remoteBurningEntities.get(id) : null;
                                if (entry && entry.entityType === 'enemy') {
                                        const now = Date.now();
                                        if (entry.endAt && now > entry.endAt) {
                                                net.remoteBurningEntities.delete(id);
                                        } else {
                                                dotStacksCount = 1;
                                        }
                                }
                        } catch(_) {}
                }
                if (dotStacksCount > 0) {
                        ctx.save();
                        const intensity = Math.min(1.2, dotStacksCount / 4); // stronger scale
                        // Base flame gradient (yellow/white core to orange outer)
                        const baseR = this.radius * (1.0 + 0.8 * intensity);
                        const t = this._fxTime || 0;
                        const wobble = Math.sin(t * 6) * 0.12;
                        const sx0 = sx + wobble * this.radius * 0.3;
                        const sy0 = sy - this.radius * (0.25 + 0.1 * Math.sin(t * 4 + this.id)); // bias upward, bob
                        const grad = ctx.createRadialGradient(sx0, sy0, baseR * 0.1, sx0, sy0, baseR);
                        grad.addColorStop(0, 'rgba(255, 250, 210, ' + (0.95 * intensity) + ')');
                        grad.addColorStop(0.35, 'rgba(255, 200, 80, ' + (0.65 * intensity) + ')');
                        grad.addColorStop(1, 'rgba(255, 120, 0, 0)');
                        ctx.fillStyle = grad;
                        ctx.beginPath();
                        ctx.ellipse(sx0, sy0, baseR * (0.7 + 0.05 * Math.sin(t * 8)), baseR * (1.35 + 0.1 * Math.sin(t * 5 + 1.1)), wobble * 0.6, 0, Math.PI * 2);
                        ctx.fill();
                        // Wavy flame tongue
                        ctx.globalAlpha = 0.85 * intensity;
                        ctx.fillStyle = 'rgba(255, 170, 40, 0.7)';
                        const tongueH = this.radius * (1.1 + 0.6 * intensity) * (1 + 0.08 * Math.sin(t * 7));
                        const tongueW = this.radius * (0.55 + 0.35 * intensity) * (1 + 0.05 * Math.sin(t * 9 + 0.7));
                        ctx.beginPath();
                        ctx.moveTo(sx0 - tongueW * 0.5, sy0);
                        ctx.quadraticCurveTo(sx0 + wobble * 10, sy0 - tongueH * 0.85, sx0 + tongueW * 0.5, sy0);
                        ctx.quadraticCurveTo(sx0 - wobble * 10, sy0 - tongueH, sx0 - tongueW * 0.5, sy0);
                        ctx.fill();
                        // Occasional small sparks
                        const sparkN = 3 + Math.floor(intensity * 3);
                        for (let i = 0; i < sparkN; i++) {
                                const a = (-Math.PI / 2) + (Math.random() - 0.5) * 0.6; // tighten around tangent
                                const r = this.radius * (0.4 + Math.random() * 0.7);
                                const px = sx0 + Math.cos(a) * r;
                                const py = sy0 + Math.sin(a) * r - (6 + Math.random() * 10);
                                ctx.globalAlpha = 0.6 * intensity;
                                ctx.fillStyle = '#ffd36b';
                                ctx.beginPath();
                                ctx.arc(px, py, 1.6, 0, Math.PI * 2);
                                ctx.fill();
                        }
                        // Light smoke puff above the flame
                        ctx.globalAlpha = 0.3 * Math.min(1, intensity + 0.2);
                        ctx.fillStyle = 'rgba(90, 90, 90, 0.9)';
                        const smokeR = this.radius * (0.5 + 0.2 * Math.sin(t * 2 + this.id));
                        ctx.beginPath();
                        ctx.ellipse(sx0, sy0 - baseR * 0.9, smokeR * 0.8, smokeR * 0.5, 0, 0, Math.PI * 2);
                        ctx.fill();
                        ctx.restore();
                }
                // Health bar
                const barWidth = Number.isFinite(this.healthBarWidth) ? this.healthBarWidth : 40;
                const barHeight = 6;
                const x = sx - barWidth / 2;
                const extraOffset = Number.isFinite(this.healthBarOffset) ? this.healthBarOffset : 0;
                const y = sy - this.radius - 12 - extraOffset;
                ctx.fillStyle = 'rgba(255,255,255,0.12)';
                ctx.fillRect(x, y, barWidth, barHeight);
                ctx.fillStyle = '#ff5a5a';
                ctx.fillRect(x, y, barWidth * (this.health / this.healthMax), barHeight);
                ctx.strokeStyle = 'rgba(0,0,0,0.6)';
                ctx.lineWidth = 2;
                ctx.strokeRect(x + 0.5, y + 0.5, barWidth, barHeight);
        }
}

class Boomer extends Enemy {
        constructor(x, y) {
                super(x, y);
                // Slightly larger than regular zombie
                this.radius = 32;
                // Puke green-yellow color
                this.color = '#a8c400';
                this.outline = '#000000';
                // Tougher than base (doubled)
                this.healthMax = 220;
                this.health = this.healthMax;
                // Move a bit faster than regular zombies
                this.speedMul = 1.25;
                // When near the player, try to make contact instead of orbiting
                this.preferContact = true;
                // Prefer open spaces and aggressively avoid obstacles while pathing
                this.avoidObstaclesAggressively = true;
                this.preferOpenSpaces = true;
                // Use puke pool instead of blood pool on death
                this.hasCustomDeathPool = true;
        }

        onDeath(info) {
                // If this instance was server-spawned, defer to server explosion broadcast
                try { if (this.serverSpawned) return; } catch(_) {}
                // Leave a puke-green-yellow puddle roughly explosion size
                try {
                        // Trigger explosion on any death if not already exploded earlier
                        if (!this._hasExploded) {
                                this._hasExploded = true;
                                if (window.projectiles && window.ExplosionVfx) {
                                        const ex = this.x, ey = this.y;
                                        window.projectiles.impacts.push(new window.ExplosionVfx(ex, ey, '#a8c400', { shockColor: '#cbe24a', sparkColor: '#cbe24a', flashColor: 'rgba(210,255,120,0.9)', smokeColor: 'rgba(90,110,60,1)' }));
                                        // Damage pulse identical to armed explosion (affects enemies + player)
                                        window.projectiles.impacts.push({
                                                life: 0.25,
                                                totalLife: 0.25,
                                                radius: 100,
                                                hitEnemyIds: new Set(),
                                                owner: null,
                                                baseOffset: (Math.random() * 10 - 5),
                                                hitPlayer: false,
                                                draw: function(ctx, cam) {
                                                        const t = Math.max(this.life, 0) / this.totalLife;
                                                        const alpha = 1.0 * t;
                                                        const sx = ex - cam.x;
                                                        const sy = ey - cam.y;
                                                        ctx.save();
                                                        ctx.globalAlpha = alpha * 0.35;
                                                        ctx.fillStyle = '#cbe24a';
                                                        ctx.beginPath();
                                                        ctx.arc(sx, sy, this.radius, 0, Math.PI * 2);
                                                        ctx.fill();
                                                        ctx.restore();
                                                },
                                                update: function(dt, enemies) {
                                                        this.life -= dt;
                                                        if (!enemies || !enemies.queryCircle) return;
                                                        // Pad query radius to include large enemies (BigBoy radius 80) since we later test
                                                        // against (this.radius + o.radius). queryCircle() is center-distance based.
                                                        const victims = enemies.queryCircle(ex, ey, this.radius + 80);
                                                        for (let i = 0; i < victims.length; i++) {
                                                                const o = victims[i];
                                                                if (!o || !o.alive) continue;
                                                                if (this.hitEnemyIds.has(o.id)) continue;
                                                                const dx = o.x - ex;
                                                                const dy = o.y - ey;
                                                                const d = Math.hypot(dx, dy);
                                                                if (d <= this.radius + (o.radius || 0)) {
                                                                        const inner = 20;
                                                                        const outer = this.radius;
                                                                        let t = (d - inner) / Math.max(1e-6, (outer - inner));
                                                                        t = Math.max(0, Math.min(1, t));
                                                                        let damage = (45 - 25 * t) + (this.baseOffset || 0);
                                                                        o.applyDamage(damage);
                                                                        this.hitEnemyIds.add(o.id);
                                                                }
                                                        }
                                                        if (!this.hitPlayer && window.player) {
                                                                const p = window.player;
                                                                const dxp = p.x - ex;
                                                                const dyp = p.y - ey;
                                                                const dp = Math.hypot(dxp, dyp);
                                                                if (dp <= this.radius + (p.radius || 0)) {
                                                                        // Damage is server-authoritative in multiplayer-only game
                                                                        this.hitPlayer = true;
                                                                }
                                                        }
                                                }
                                        });
                                }
                        }
                        const hint = (info && info.cause === 'self_destruct') ? 100 : Math.max(40, (this.radius || 26) * 2.4);
                        if (typeof window.enqueueGroundDecal === 'function') window.enqueueGroundDecal(new PukePoolDecal(this.x, this.y, hint));
                } catch(_) {}
        }

        draw(ctx, camera) {
                // Pulse bright yellow when close to player; steady red when armed
                let origColor = this.color;
                let flashing = false;
                let armed = false;
                let pulse = 0;
                
                // For server-spawned Boomers, use synced state so all players see the warning
                if (this.serverSpawned && this._warningActive) {
                        flashing = true;
                        const trigger = 220;
                        const dist = Number.isFinite(this._closestPlayerDist) ? this._closestPlayerDist : Infinity;
                        
                        if (this._armedTimerStarted) {
                                // Steady red when armed
                                armed = true;
                                this.color = '#ff3b3b';
                                pulse = 1;
                        } else {
                                // Yellow pulsing warning before armed
                                const closeness = Math.max(0, Math.min(1, (trigger - dist) / trigger));
                                const t = this._fxTime || 0;
                                const freq = (3 + 7 * closeness) * 0.25;
                                pulse = Math.max(0, Math.min(1, (Math.sin(t * freq * Math.PI * 2) * 0.5 + 0.5)));
                                this.color = (pulse > 0.55) ? '#fff36b' : '#a8c400';
                        }
                } else if (!this.serverSpawned) {
                        // For local/single-player Boomers, calculate based on local player distance
                        try {
                                const p = window.player;
                                if (p) {
                                        const dx = p.x - this.x;
                                        const dy = p.y - this.y;
                                        const dist = Math.hypot(dx, dy);
                                        const trigger = 220; // start flashing when within ~220px
                                        const armDist = Math.max(40, (p.radius || 26) + this.radius + 18); // very close => steady red
                                        if (dist < trigger) {
                                                flashing = true;
                                                const closeness = Math.max(0, Math.min(1, (trigger - dist) / trigger));
                                                const t = this._fxTime || 0;
                                                // Reduce pulse speed by 75%
                                                const freq = (3 + 7 * closeness) * 0.25; // slower pulses, still scale with closeness
                                                pulse = Math.max(0, Math.min(1, (Math.sin(t * freq * Math.PI * 2) * 0.5 + 0.5)));
                                                // When very close, switch to steady red and stop pulsing
                                                if (dist < armDist) {
                                                        armed = true;
                                                        this.color = '#ff3b3b';
                                                        pulse = 1;
                                                        // Trigger delayed explosion once when armed
                                                        if (!this._armedTimerStarted) {
                                                                this._armedTimerStarted = true;
                                                                this._armedTimer = 0.1;
                                                        }
                                                } else {
                                                        this.color = (pulse > 0.55) ? '#fff36b' : '#a8c400';
                                                }
                                        }
                                }
                        } catch(_) {}
                }
                // Base draw
                Enemy.prototype.draw.call(this, ctx, camera);
                // Overlay glow ring when flashing
                if (flashing) {
                        const sx = this.x - camera.x;
                        const sy = this.y - camera.y;
                        ctx.save();
                        ctx.globalAlpha = armed ? 0.6 : (0.25 + 0.45 * pulse);
                        ctx.strokeStyle = armed ? '#ff3b3b' : '#fff36b';
                        ctx.lineWidth = 4;
                        ctx.beginPath();
                        ctx.arc(sx, sy, armed ? (this.radius + 10) : (this.radius + 6 + pulse * 6), 0, Math.PI * 2);
                        ctx.stroke();
                        ctx.restore();
                }
                // restore original color for logic
                this.color = origColor;
        }
}

class Licker extends Enemy {
        constructor(x, y) {
                super(x, y);
                // Slightly desaturated magenta color
                this.color = '#cc66cc';
                this.outline = '#000000';
                // Tentacle attack state
                this.tentacleCooldown = 0;
                this.tentacleRange = 300;
                this.tentacleWindupBonus = 50; // start windup when within range + bonus
                this.tentacleWindup = 0;
                this.tentacleState = 'idle'; // idle | windup | extend | recover | attached
                this.tentacleTime = 0;
                this._aimAngle = 0;
                this._attached = false;
                this._attachTime = 0;
        }

        onDeath(info) {
                try {
                        this._attached = false;
                        this._attachTime = 0;
                        this.tentacleState = 'idle';
                        this.tentacleTime = 0;
                        this.tentacleCooldown = 0;
                } catch(_) {}
                // Server handles ensnare clearing on death (multiplayer-only game)
                return; // Skip local clearing - server-authoritative
                
                // REMOVED: Local ensnare clearing logic (10 lines) - server-authoritative in multiplayer-only mode
        }
        updateLicker(dt) {
                try {
                        // Tentacle attack is server-authoritative (multiplayer-only game)
                        // Server sends complete tentacle state via enemiesState snapshots
                        return; // Skip all local logic - server handles Licker AI
                        
                        // REMOVED: All local Licker AI logic (131 lines) - server-authoritative in multiplayer-only mode
                        // Original client-side logic included tentacle windup, extend, attach, and pull mechanics
                } catch(_) {}
        }
        draw(ctx, camera) {
                // Draw base enemy
                Enemy.prototype.draw.call(this, ctx, camera);
                // Draw tentacle if in windup/extend/recover
                try {
                        if ((this.tentacleState && this.tentacleState !== 'idle') || this._attached) {
                                const sx = this.x - camera.x;
                                const sy = this.y - camera.y;
                                let ang = this._aimAngle || 0;
                                
                                // Find the target player for accurate tentacle aiming (multiplayer-only)
                                let targetPlayer = null;
                                if (this._targetPlayerId) {
                                        // Check if target is local player
                                        if (window.player && window.networkManager && this._targetPlayerId === window.networkManager.playerId) {
                                                targetPlayer = window.player;
                                        } else {
                                                // Find target in remote players
                                                try {
                                                        const remotePlayers = window.networkManager.otherPlayers;
                                                        if (remotePlayers) {
                                                                for (const [pid, rp] of remotePlayers) {
                                                                        if (pid === this._targetPlayerId) {
                                                                                targetPlayer = rp;
                                                                                break;
                                                                        }
                                                                }
                                                        }
                                                } catch(_) {}
                                        }
                                } else {
                                        // Fallback: target local player if no specific target ID
                                        targetPlayer = window.player;
                                }
                                
                                // extension factor based on state
                                let k = 0;
                                if (this.tentacleState === 'windup') {
                                        k = 0.15;
                                } else if (this.tentacleState === 'extend') {
                                        const total = 0.18; const t = Math.max(this.tentacleTime, 0) / total; // 1..0
                                        k = 1 - Math.abs(t - 0.5) * 2; // rise to 1 at mid, back to 0
                                } else if (this.tentacleState === 'recover') {
                                        k = 0.2;
                                } else if (this._attached) {
                                        k = 1;
                                        // re-aim toward current target player position for taut string
                                        if (targetPlayer) ang = Math.atan2(targetPlayer.y - this.y, targetPlayer.x - this.x);
                                }
                                let reach = (this.tentacleRange || 300) * Math.max(0, Math.min(1, k));
                                // Clamp to target player's surface if present to avoid overshoot
                                try {
                                        if (targetPlayer) {
                                                const d = Math.hypot(targetPlayer.x - this.x, targetPlayer.y - this.y);
                                                const pr = targetPlayer.radius || 26;
                                                const maxToSurface = Math.max(0, d - pr - 1);
                                                reach = Math.min(reach, maxToSurface);
                                        }
                                } catch(_) {}
                                const ex = sx + Math.cos(ang) * reach;
                                const ey = sy + Math.sin(ang) * reach;
                                ctx.save();
                                // Magenta segmented tentacle with subtle gradient and tip bulb
                                const segments = 8;
                                ctx.lineCap = 'round';
                                for (let i = 0; i < segments; i++) {
                                        const t0 = i / segments;
                                        const t1 = (i + 1) / segments;
                                        const x0 = sx + Math.cos(ang) * (reach * t0);
                                        const y0 = sy + Math.sin(ang) * (reach * t0);
                                        const x1 = sx + Math.cos(ang) * (reach * t1);
                                        const y1 = sy + Math.sin(ang) * (reach * t1);
                                        const w = 8 * (1 - t0) + 2;
                                        ctx.strokeStyle = '#cc66cc';
                                        ctx.globalAlpha = 0.85 * (0.6 + 0.4 * (1 - t0));
                                        ctx.lineWidth = w;
                                        ctx.beginPath();
                                        ctx.moveTo(x0, y0);
                                        ctx.lineTo(x1, y1);
                                        ctx.stroke();
                                }
                                // tip: draw at current extension end (clamped). Flash red near end of windup.
                                let tipColor = '#cc66cc';
                                let tipAlpha = 0.9;
                                if (this.tentacleState === 'windup') {
                                        const totalWU = 0.25;
                                        const tWU = Math.max(this.tentacleTime, 0);
                                        const near = tWU < 0.1; // last 0.1s flashes red
                                        if (near) {
                                                tipColor = '#ff3b3b';
                                                // pulsate alpha for emphasis
                                                tipAlpha = 0.75 + 0.25 * (Math.sin(((0.1 - tWU) / 0.1) * Math.PI * 6) * 0.5 + 0.5);
                                        }
                                }
                                ctx.globalAlpha = tipAlpha;
                                ctx.fillStyle = tipColor;
                                ctx.beginPath();
                                ctx.arc(ex, ey, 6, 0, Math.PI * 2);
                                ctx.fill();
                                ctx.restore();
                        }
                } catch(_) {}
        }
}

class ProjectileZombie extends Enemy {
    constructor(x, y) {
        super(x, y);
        // Tinted variant of the basic zombie
        this.color = '#5f9f5f';
        this.outline = '#000000';
        // Ranged behavior
        this.fireCooldown = 0;
        this.fireIntervalMin = 1.2;
        this.fireIntervalMax = 2.0;
        this.preferOpenSpaces = true;
        this.avoidObstaclesAggressively = false;
        this.speedMul = 1.0;
        // Default to ranged kiting behavior
        this.preferContact = false;
        // Tactical behavior state: 'kite' or 'rush'
        this._tacticMode = 'kite';
        this._tacticTimer = 0;
        this._tacticDuration = 5 + Math.random() * 5; // 5-10 seconds per tactic
    }

    _computeProjectileSpeed() {
        try {
            const d = window.director;
            if (d) {
                const base = Number.isFinite(d.baseSpeed) ? d.baseSpeed : 80;
                const modeMul = (d.speedByMode && d.mode && Number.isFinite(d.speedByMode[d.mode])) ? d.speedByMode[d.mode] : 1;
                const entMul = Number.isFinite(this.speedMul) ? this.speedMul : 1;
                return 2 * base * modeMul * entMul; // 2x zombie move speed
            }
        } catch(_) {}
        return 160; // fallback: 2x default base (80)
    }

    updateProjectileZombie(dt) {
        try {
            // Update tactical decision timer
            this._tacticTimer -= dt;
            const p = window.player;
            if (p && p.health && p.health > 0) {
                const dx = p.x - this.x;
                const dy = p.y - this.y;
                const dist = Math.hypot(dx, dy) || 1;
                
                // Decide tactic when timer expires or when getting very close
                if (this._tacticTimer <= 0 || (dist < 250 && this._tacticMode === 'kite')) {
                    // 70% chance to kite (ranged), 30% chance to rush (melee)
                    const roll = Math.random();
                    if (roll < 0.7) {
                        this._tacticMode = 'kite';
                        this.preferContact = false;
                        this.speedMul = 1.0;
                    } else {
                        this._tacticMode = 'rush';
                        this.preferContact = true;
                        this.speedMul = 1.15; // Slightly faster when rushing
                    }
                    // Reset timer for next decision
                    this._tacticDuration = 5 + Math.random() * 5; // 5-10 seconds
                    this._tacticTimer = this._tacticDuration;
                }
            }
            
            // Firing is server-authoritative (multiplayer-only game)
            this.fireCooldown = Math.max(0, this.fireCooldown - dt);
            return; // Skip local firing - server handles ProjectileZombie AI
            
            // REMOVED: Local firing logic (38 lines) - server-authoritative in multiplayer-only mode
        } catch(_) {}
    }
}

class TargetDummy extends Enemy {
    constructor(x, y) {
        super(x, y);
        // Target dummy properties
        this.healthMax = 600;
        this.health = this.healthMax;
        // Brighter Trench Crusade themed palette (wood/iron/cloth) so it's easy to see in the lobby
        this.color = '#6b6256';   // Worn cloth/wood midtone (brighter)
        this.outline = '#1a1410'; // Sooty outline
        this.radius = 32;  // Slightly larger than normal enemies
        this.isTargetDummy = true;
        this.speedMul = 0;  // Cannot move
        this.originalX = x;  // Remember spawn position
        this.originalY = y;
        this.damage = 0;  // Target dummy deals no damage
        this.preferContact = false;  // Doesn't seek contact with player
        this._contactDisabled = true; // safety: never deal touch damage
        
        // Visual distinction
        this.shape = 'effigy';
        // Assigned lazily once _serverId is available (set by networking after construction)
        this._variant = null;
    }
    
    // Keep it stationary. NOTE: Enemy has no base update() in this codebase,
    // so do NOT call super.update().
    update(dt) {
        // Advance local VFX clock for burn animation, etc.
        try { this._fxTime = (this._fxTime || 0) + (dt || 0); } catch(_) {}

        // Server-spawned dummies may move (shooting-gallery lanes). Do not pin them locally.
        if (this.serverSpawned || this._serverId) return;

        // Single-player fallback: keep stationary at original spawn
        this.x = this.originalX;
        this.y = this.originalY;
    }
    
    // Prevent knockback to ensure true immobility
    applyKnockback(dirX, dirY, distance, durationSec = 0.2) {
        // Target dummy cannot be knocked back
        // Do nothing - stay stationary
    }
    // IMPORTANT: Do not override applyDamage/applyDot/onDeath.
    // This dummy must react to damage exactly like other enemies (numbers, DOT, blood pools, etc.).
    
    // Custom draw method for distinctive appearance
    draw(ctx, camera) {
        if (!this.alive) return;
        const sx = this.x - camera.x;
        const sy = this.y - camera.y;
        
        ctx.save();
        
        // Variant (1..5) derived from server id: target_dummy_1..target_dummy_5
        if (this._variant == null) {
            try {
                const sid = String(this._serverId || '');
                const m = sid.match(/target_dummy_(\d+)/);
                const n = m ? parseInt(m[1], 10) : 1;
                this._variant = (Number.isFinite(n) ? (n - 1) : 0) % 5;
            } catch(_) {
                this._variant = 0;
            }
        }
        const v = this._variant | 0;

        // Trench Crusade effigy: cross-frame stake + ragged cloth torso + headgear (varies)
        const size = this.radius * 1.55;

        // Ground shadow (subtle)
        ctx.globalAlpha = 0.22;
        ctx.fillStyle = '#000000';
        ctx.beginPath();
        ctx.ellipse(sx, sy + this.radius * 0.95, size * 0.55, size * 0.22, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;

        // Helper: rounded rectangle path (no ctx.roundRect dependency)
        const rr = (x, y, w, h, r) => {
            const rad = Math.max(0, Math.min(r, Math.min(w, h) / 2));
            ctx.beginPath();
            ctx.moveTo(x + rad, y);
            ctx.lineTo(x + w - rad, y);
            ctx.quadraticCurveTo(x + w, y, x + w, y + rad);
            ctx.lineTo(x + w, y + h - rad);
            ctx.quadraticCurveTo(x + w, y + h, x + w - rad, y + h);
            ctx.lineTo(x + rad, y + h);
            ctx.quadraticCurveTo(x, y + h, x, y + h - rad);
            ctx.lineTo(x, y + rad);
            ctx.quadraticCurveTo(x, y, x + rad, y);
            ctx.closePath();
        };

        // Variant palette (keep readable/bright)
        const palettes = [
            { cloth: '#6b6256', cloth2: '#5a5248', mark: '#8f1b1b', wood: '#6b4a2f', woodDark: '#2b1a10', metal: '#3b444c', metalDark: '#111417', wire: '#666666', rivet: '#a07a35' },
            { cloth: '#766e60', cloth2: '#5f584c', mark: '#e9e3d8', wood: '#6a472c', woodDark: '#2a190f', metal: '#414a52', metalDark: '#0e1012', wire: '#6d6d6d', rivet: '#b08a40' },
            { cloth: '#6f6a5c', cloth2: '#575244', mark: '#c9a227', wood: '#6e4d31', woodDark: '#2b1a10', metal: '#36414b', metalDark: '#0c0f12', wire: '#7a7a7a', rivet: '#b89346' },
            { cloth: '#7a7164', cloth2: '#625a4f', mark: '#e9e3d8', wood: '#6b4a2f', woodDark: '#2b1a10', metal: '#3a3f44', metalDark: '#0c0e10', wire: '#6b6b6b', rivet: '#a07a35' },
            { cloth: '#70685b', cloth2: '#5a5248', mark: '#8f1b1b', wood: '#6f4b2d', woodDark: '#2b1a10', metal: '#2f3a42', metalDark: '#0b0d10', wire: '#707070', rivet: '#b08a40' }
        ];
        const pal = palettes[Math.max(0, Math.min(4, v))];

        // Cross-frame stake (behind body)
        ctx.save();
        const tilt = -0.08;
        ctx.translate(sx, sy);
        ctx.rotate(tilt);

        // Wood colors
        ctx.fillStyle = pal.wood;
        ctx.strokeStyle = pal.woodDark;
        ctx.lineWidth = 2;

        // Vertical plank
        const plankW = size * 0.28;
        const plankH = size * 2.05;
        rr(-plankW / 2, -plankH * 0.65, plankW, plankH, 6);
        ctx.fill();
        ctx.stroke();

        // Horizontal plank (crossbar)
        const crossW = size * 1.5;
        const crossH = size * 0.22;
        rr(-crossW / 2, -size * 0.55, crossW, crossH, 6);
        ctx.fill();
        ctx.stroke();

        // Nail heads
        ctx.fillStyle = pal.woodDark;
        for (let i = 0; i < 6; i++) {
            const nx = (-crossW / 2) + (i + 1) * (crossW / 7);
            const ny = -size * 0.55 + crossH * (0.35 + (i % 2) * 0.25);
            ctx.beginPath();
            ctx.arc(nx, ny, 2.2, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.restore();

        // Cloth torso (front)
        const torsoW = size * 0.92;
        const torsoH = size * 0.98;
        const torsoX = sx - torsoW / 2;
        const torsoY = sy - torsoH / 2 + size * 0.1;
        rr(torsoX, torsoY, torsoW, torsoH, 10);
        ctx.fillStyle = pal.cloth;
        ctx.strokeStyle = pal.woodDark;
        ctx.lineWidth = 2.5;
        // Slight glow so it's visible against dark ground
        ctx.shadowColor = 'rgba(255,255,255,0.10)';
        ctx.shadowBlur = 10;
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.stroke();

        // Ragged hem / tears (simple notches)
        ctx.fillStyle = pal.cloth2;
        ctx.beginPath();
        ctx.moveTo(torsoX + torsoW * 0.12, torsoY + torsoH);
        ctx.lineTo(torsoX + torsoW * 0.18, torsoY + torsoH - 8);
        ctx.lineTo(torsoX + torsoW * 0.26, torsoY + torsoH);
        ctx.lineTo(torsoX + torsoW * 0.34, torsoY + torsoH - 10);
        ctx.lineTo(torsoX + torsoW * 0.44, torsoY + torsoH);
        ctx.lineTo(torsoX + torsoW * 0.58, torsoY + torsoH - 6);
        ctx.lineTo(torsoX + torsoW * 0.70, torsoY + torsoH);
        ctx.lineTo(torsoX + torsoW * 0.82, torsoY + torsoH - 9);
        ctx.lineTo(torsoX + torsoW * 0.90, torsoY + torsoH);
        ctx.closePath();
        ctx.globalAlpha = 0.55;
        ctx.fill();
        ctx.globalAlpha = 1;

        // Variant-specific torso mark
        ctx.save();
        ctx.globalAlpha = 0.75;
        ctx.lineCap = 'round';
        if (v === 3) {
            // target board rings (brighter, easy to read)
            ctx.globalAlpha = 0.9;
            ctx.strokeStyle = '#e9e3d8';
            ctx.lineWidth = 2.25;
            ctx.beginPath(); ctx.arc(sx, torsoY + torsoH * 0.5, torsoW * 0.26, 0, Math.PI * 2); ctx.stroke();
            ctx.beginPath(); ctx.arc(sx, torsoY + torsoH * 0.5, torsoW * 0.16, 0, Math.PI * 2); ctx.stroke();
            ctx.beginPath(); ctx.arc(sx, torsoY + torsoH * 0.5, torsoW * 0.06, 0, Math.PI * 2); ctx.stroke();
            ctx.fillStyle = '#b91c1c';
            ctx.beginPath(); ctx.arc(sx, torsoY + torsoH * 0.5, torsoW * 0.035, 0, Math.PI * 2); ctx.fill();
        } else if (v === 2) {
            // hazard chevrons
            ctx.strokeStyle = pal.mark;
            ctx.lineWidth = 4;
            const y0 = torsoY + torsoH * 0.38;
            for (let i = 0; i < 3; i++) {
                const yy = y0 + i * 14;
                ctx.beginPath();
                ctx.moveTo(sx - torsoW * 0.2, yy);
                ctx.lineTo(sx, yy + 10);
                ctx.lineTo(sx + torsoW * 0.2, yy);
                ctx.stroke();
            }
        } else {
            // classic cross (red or pale depending on variant)
            ctx.strokeStyle = pal.mark;
            ctx.lineWidth = 5;
            ctx.beginPath();
            ctx.moveTo(sx, torsoY + torsoH * 0.2);
            ctx.lineTo(sx, torsoY + torsoH * 0.78);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(sx - torsoW * 0.22, torsoY + torsoH * 0.44);
            ctx.lineTo(sx + torsoW * 0.22, torsoY + torsoH * 0.44);
            ctx.stroke();
        }
        ctx.restore();

        // Barbed wire wrap
        ctx.save();
        ctx.strokeStyle = pal.wire;
        ctx.lineWidth = 2;
        ctx.globalAlpha = 0.9;
        const wraps = (v === 4) ? 2 : (v === 2 ? 4 : 3);
        for (let w = 0; w < wraps; w++) {
            const wy = torsoY + torsoH * (0.30 + w * 0.22);
            ctx.beginPath();
            ctx.moveTo(torsoX + torsoW * 0.06, wy);
            ctx.lineTo(torsoX + torsoW * 0.94, wy + (w % 2 ? 3 : -3));
            ctx.stroke();
            // barbs
            for (let b = 0; b < 6; b++) {
                const bx = torsoX + torsoW * (0.14 + b * 0.13);
                const by = wy + (w % 2 ? 3 : -3);
                ctx.beginPath();
                ctx.moveTo(bx - 4, by - 3);
                ctx.lineTo(bx + 4, by + 3);
                ctx.stroke();
            }
        }
        ctx.restore();

        // Headgear (variant-specific)
        const helmR = size * 0.33;
        const helmY = sy - size * 0.68;
        ctx.save();
        if (v === 1) {
            // Hooded sack/hood (cloth)
            ctx.fillStyle = pal.cloth2;
            ctx.strokeStyle = pal.woodDark;
            ctx.lineWidth = 2.5;
            ctx.beginPath();
            ctx.moveTo(sx - helmR * 0.9, helmY + helmR * 0.65);
            ctx.quadraticCurveTo(sx, helmY - helmR * 0.75, sx + helmR * 0.9, helmY + helmR * 0.65);
            ctx.quadraticCurveTo(sx, helmY + helmR * 1.1, sx - helmR * 0.9, helmY + helmR * 0.65);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
            // Eye slits
            ctx.strokeStyle = '#0b0d10';
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.moveTo(sx - helmR * 0.45, helmY + helmR * 0.2);
            ctx.lineTo(sx - helmR * 0.1, helmY + helmR * 0.2);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(sx + helmR * 0.1, helmY + helmR * 0.2);
            ctx.lineTo(sx + helmR * 0.45, helmY + helmR * 0.2);
            ctx.stroke();
        } else if (v === 2) {
            // Spiked mask (more aggressive)
            ctx.fillStyle = pal.metal;
            ctx.strokeStyle = pal.metalDark;
            ctx.lineWidth = 2.5;
            rr(sx - helmR * 0.85, helmY - helmR * 0.2, helmR * 1.7, helmR * 1.35, 8);
            ctx.fill();
            ctx.stroke();
            // Spikes
            ctx.strokeStyle = pal.metalDark;
            ctx.lineWidth = 2;
            for (let i = 0; i < 6; i++) {
                const bx = sx - helmR * 0.7 + i * (helmR * 0.28);
                ctx.beginPath();
                ctx.moveTo(bx, helmY - helmR * 0.2);
                ctx.lineTo(bx + 6, helmY - helmR * 0.45);
                ctx.stroke();
            }
            // Slit
            ctx.strokeStyle = '#090a0b';
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.moveTo(sx - helmR * 0.55, helmY + helmR * 0.45);
            ctx.lineTo(sx + helmR * 0.55, helmY + helmR * 0.45);
            ctx.stroke();
        } else {
            // Iron helm (default)
            ctx.fillStyle = pal.metal;
            ctx.strokeStyle = pal.metalDark;
            ctx.lineWidth = 2.5;
            ctx.beginPath();
            ctx.arc(sx, helmY, helmR, Math.PI, 0);
            ctx.lineTo(sx + helmR, helmY + helmR * 0.72);
            ctx.arc(sx, helmY + helmR * 0.72, helmR, 0, Math.PI, true);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
            // Visor slit
            ctx.strokeStyle = '#090a0b';
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.moveTo(sx - helmR * 0.55, helmY + helmR * 0.2);
            ctx.lineTo(sx + helmR * 0.55, helmY + helmR * 0.2);
            ctx.stroke();
            // Rivets
            ctx.fillStyle = pal.rivet;
            for (let i = 0; i < 4; i++) {
                const a = (-0.9 + i * 0.6);
                ctx.beginPath();
                ctx.arc(sx + Math.cos(a) * helmR * 0.7, helmY + helmR * 0.55, 2, 0, Math.PI * 2);
                ctx.fill();
            }
        }
        ctx.restore();

        // Variant 4: small lantern glow to make it pop
        if (v === 4) {
            ctx.save();
            ctx.globalAlpha = 0.22;
            const gx = sx + torsoW * 0.33;
            const gy = torsoY + torsoH * 0.62;
            const g = ctx.createRadialGradient(gx, gy, 2, gx, gy, torsoW * 0.55);
            g.addColorStop(0, 'rgba(255,210,90,0.9)');
            g.addColorStop(0.5, 'rgba(255,140,0,0.18)');
            g.addColorStop(1, 'rgba(255,140,0,0)');
            ctx.fillStyle = g;
            ctx.beginPath();
            ctx.arc(gx, gy, torsoW * 0.55, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
        }
        
        // Health bar (always show for target dummy)
        const barWidth = size * 1.2;
        const barHeight = 6;
        const barY = sy - size/2 - 15;
        
        // Background + frame (more gothic/industrial)
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillRect(sx - barWidth/2 - 1, barY - 1, barWidth + 2, barHeight + 2);
        ctx.strokeStyle = '#3b2b1a';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(sx - barWidth/2 - 1, barY - 1, barWidth + 2, barHeight + 2);
        
        // Health
        const healthPct = this.health / this.healthMax;
        ctx.fillStyle = healthPct > 0.5 ? '#2fbf6f' : healthPct > 0.25 ? '#c9a227' : '#b91c1c';
        ctx.fillRect(sx - barWidth/2, barY, barWidth * healthPct, barHeight);
        
        // Health text
        ctx.fillStyle = '#e8e3d8';
        ctx.font = '12px monospace';
        ctx.textAlign = 'center';
        ctx.fillText(`${Math.ceil(this.health)}/${this.healthMax}`, sx, barY - 5);
        
        // Fire VFX for active DOT stacks (same system as other enemies)
        // Also show remote burning for this enemy when another client applied DOT.
        let stacks = (this.dotStacks && this.dotStacks.length > 0) ? this.dotStacks.length : 0;
        if (stacks <= 0) {
            try {
                const net = window.networkManager;
                const id = this._serverId;
                const entry = (net && net.remoteBurningEntities && id) ? net.remoteBurningEntities.get(id) : null;
                if (entry && entry.entityType === 'enemy') {
                    const now = Date.now();
                    if (entry.endAt && now > entry.endAt) {
                        net.remoteBurningEntities.delete(id);
                    } else {
                        stacks = 1;
                    }
                }
            } catch(_) {}
        }
        if (stacks > 0) {
            ctx.save();
            const intensity = Math.min(1.2, stacks / 4); // stronger scale
            // Base flame gradient (yellow/white core to orange outer)
            const baseR = this.radius * (1.0 + 0.8 * intensity);
            const t = this._fxTime || 0;
            const wobble = Math.sin(t * 6) * 0.12;
            const sx0 = sx + wobble * this.radius * 0.3;
            const sy0 = sy - this.radius * (0.25 + 0.1 * Math.sin(t * 4 + (this.id || 0))); // bias upward, bob
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
        
        ctx.restore();
    }
}

class PukePoolDecal {
        constructor(x, y, maxRadiusHint) {
                this.x = x;
                this.y = y;
                this.totalLife = 12.0;
                this.life = this.totalLife;
                this.elapsed = 0;
                this.growDuration = 1.4;
                this.maxRadius = (Number.isFinite(maxRadiusHint) ? maxRadiusHint : 90);
                this.startRadius = Math.max(20, this.maxRadius * 0.55);
                this.fadeInDuration = 0.25;
                this.isPukePool = true;
                // Blobby pool
                this.blobs = [];
                const blobCount = 8 + Math.floor(Math.random() * 8);
                for (let i = 0; i < blobCount; i++) {
                        const ang = Math.random() * Math.PI * 2;
                        const dist = (Math.random() ** 0.9) * (this.maxRadius * 0.65);
                        let endR = this.maxRadius * (0.35 + Math.random() * 0.65);
                        endR = Math.min(endR, this.maxRadius);
                        const startScale = this.startRadius / this.maxRadius;
                        const startR = endR * startScale;
                        this.blobs.push({ offx: Math.cos(ang) * dist, offy: Math.sin(ang) * dist, startR, endR, jitter: (Math.random() - 0.5) * 2 });
                }
        }
        update(dt) { this.life -= dt; this.elapsed += dt; }
        currentRadius() {
                const spreadT = Math.min(1, this.elapsed / this.growDuration);
                const startScale = this.startRadius / this.maxRadius;
                const curScale = startScale + (1 - startScale) * spreadT;
                return this.maxRadius * curScale;
        }
        draw(ctx, camera) {
                const t = 1 - Math.max(this.life, 0) / this.totalLife; // 0..1
                const fade = 1 - t;
                const spreadT = Math.min(1, this.elapsed / this.growDuration);
                const startScale = this.startRadius / this.maxRadius;
                const curScale = startScale + (1 - startScale) * spreadT;
                const fadeIn = Math.min(1, this.elapsed / this.fadeInDuration);
                const sx = this.x - camera.x;
                const sy = this.y - camera.y;
                ctx.save();
                // Outer stain (darker green)
                ctx.globalAlpha = 0.22 * fade * fadeIn;
                ctx.fillStyle = '#4a5c11';
                for (let i = 0; i < this.blobs.length; i++) {
                        const b = this.blobs[i];
                        let curR = b.endR * curScale;
                        if (curR > this.maxRadius) curR = this.maxRadius;
                        const growOff = curScale;
                        ctx.beginPath();
                        ctx.arc(sx + b.offx * growOff, sy + b.offy * growOff, curR * 1.08, 0, Math.PI * 2);
                        ctx.fill();
                }
                // Inner stain (puke yellow-green)
                ctx.globalAlpha = 0.32 * fade * fadeIn;
                ctx.fillStyle = '#a8c400';
                for (let i = 0; i < this.blobs.length; i++) {
                        const b = this.blobs[i];
                        let curR = b.endR * curScale;
                        if (curR > this.maxRadius) curR = this.maxRadius;
                        const growOff = curScale;
                        ctx.beginPath();
                        ctx.arc(sx + b.offx * growOff * 0.85, sy + b.offy * growOff * 0.85, curR * 0.88, 0, Math.PI * 2);
                        ctx.fill();
                }
                // Gloss highlight
                ctx.globalAlpha = 0.12 * fade * fadeIn;
                ctx.fillStyle = '#d9ff6b';
                ctx.beginPath();
                ctx.ellipse(sx - this.maxRadius * 0.12, sy - this.maxRadius * 0.18, this.maxRadius * 0.6 * curScale, this.maxRadius * 0.25 * curScale, -0.3, 0, Math.PI * 2);
                ctx.fill();
                ctx.restore();
        }
}

// Expose for network-instantiated pools
try { if (typeof window !== 'undefined') window.PukePoolDecal = PukePoolDecal; } catch(_) {}

class MudPoolDecal {
	constructor(x, y, maxRadiusHint) {
		this.x = x;
		this.y = y;
		// Mud pools persist for the duration of the level (environment hazard decals).
		// IMPORTANT: Do not let them slowly fade out over time.
		this.totalLife = 999.0;
		this.life = this.totalLife;
		this.elapsed = 0;
		this.growDuration = 1.6;
		this.maxRadius = (Number.isFinite(maxRadiusHint) ? maxRadiusHint : 160);
		this.startRadius = Math.max(30, this.maxRadius * 0.5);
		this.fadeInDuration = 0.35;
		this.isMudPool = true;
		
		// 3 flat brown colors for variety (no gradients for performance)
		const mudColors = [
			'#1e160f', // Dark brown
			'#2a1f16', // Medium brown
			'#32261b'  // Lighter brown
		];
		
		// Blobby mud pool with medium splats (reduced count for performance)
		this.blobs = [];
		const blobCount = 30 + Math.floor(Math.random() * 20); // Reduced from 40-70 to 30-50
		for (let i = 0; i < blobCount; i++) {
			const ang = Math.random() * Math.PI * 2;
			const dist = (Math.random() ** 0.85) * (this.maxRadius * 0.8);
			let endR = this.maxRadius * (0.1 + Math.random() * 0.25);
			endR = Math.min(endR, this.maxRadius);
			const startScale = this.startRadius / this.maxRadius;
			const startR = endR * startScale;
			// Pick one of the 3 brown colors
			const color = mudColors[Math.floor(Math.random() * mudColors.length)];
			this.blobs.push({ 
				offx: Math.cos(ang) * dist, 
				offy: Math.sin(ang) * dist, 
				startR, 
				endR, 
				color: color
			});
		}
		// Add smaller dots to break up the shape (reduced count)
		this.tinyDots = [];
		const tinyCount = 40 + Math.floor(Math.random() * 20); // Reduced from 60-100 to 40-60
		for (let i = 0; i < tinyCount; i++) {
			const ang = Math.random() * Math.PI * 2;
			const dist = (Math.random() ** 0.9) * (this.maxRadius * 0.9);
			let endR = this.maxRadius * (0.03 + Math.random() * 0.08);
			const startScale = this.startRadius / this.maxRadius;
			const startR = endR * startScale;
			// Pick one of the 3 brown colors
			const color = mudColors[Math.floor(Math.random() * mudColors.length)];
			this.tinyDots.push({ 
				offx: Math.cos(ang) * dist, 
				offy: Math.sin(ang) * dist, 
				startR, 
				endR,
				color: color
			});
		}
	}
	// Mud decals should NOT fade out as the level goes on.
	// Keep life constant (so fade stays ~1) and only advance elapsed for the initial grow/fade-in.
	update(dt) { this.elapsed += dt; }
	currentRadius() {
		const spreadT = Math.min(1, this.elapsed / this.growDuration);
		const startScale = this.startRadius / this.maxRadius;
		const curScale = startScale + (1 - startScale) * spreadT;
		return this.maxRadius * curScale;
	}
	draw(ctx, camera) {
		const t = 1 - Math.max(this.life, 0) / this.totalLife; // 0..1
		const fade = 1 - t;
		const spreadT = Math.min(1, this.elapsed / this.growDuration);
		const startScale = this.startRadius / this.maxRadius;
		const curScale = startScale + (1 - startScale) * spreadT;
		const fadeIn = Math.min(1, this.elapsed / this.fadeInDuration);
		const sx = this.x - camera.x;
		const sy = this.y - camera.y;
		
		const alpha = fade * fadeIn;
		
		// Draw medium blobs with flat colors (no gradients for performance)
		ctx.globalAlpha = 0.65 * alpha;
		for (let i = 0; i < this.blobs.length; i++) {
			const b = this.blobs[i];
			let curR = b.endR * curScale;
			if (curR > this.maxRadius) curR = this.maxRadius;
			const growOff = curScale;
			const bx = sx + b.offx * growOff;
			const by = sy + b.offy * growOff;
			
			ctx.fillStyle = b.color;
			ctx.beginPath();
			ctx.arc(bx, by, curR, 0, Math.PI * 2);
			ctx.fill();
		}
		
		// Draw tiny dots with flat colors (no gradients)
		ctx.globalAlpha = 0.5 * alpha;
		for (let i = 0; i < this.tinyDots.length; i++) {
			const d = this.tinyDots[i];
			let curR = d.endR * curScale;
			const growOff = curScale;
			const dx = sx + d.offx * growOff;
			const dy = sy + d.offy * growOff;
			
			ctx.fillStyle = d.color;
			ctx.beginPath();
			ctx.arc(dx, dy, curR, 0, Math.PI * 2);
			ctx.fill();
		}
		
		ctx.globalAlpha = 1.0;
	}
}

// Expose for client-side mud pool rendering
try { if (typeof window !== 'undefined') window.MudPoolDecal = MudPoolDecal; } catch(_) {}

class BloodSplatterVfx {
        constructor(x, y, dirX = 0, dirY = 0) {
                this.x = x;
                this.y = y;
                this.totalLife = 0.5;
                this.life = this.totalLife;
                // Generate droplets with slight bias opposite to incoming direction
                const base = Math.atan2(dirY, dirX) || 0;
                const count = 12 + Math.floor(Math.random() * 10);
                this.droplets = [];
                for (let i = 0; i < count; i++) {
                        const ang = (dirX === 0 && dirY === 0)
                                ? Math.random() * Math.PI * 2
                                : (base + Math.PI + (Math.random() - 0.5) * Math.PI * 0.8);
                        this.droplets.push({
                                angle: ang,
                                maxDist: 20 + Math.random() * 60,
                                radius: 2 + Math.random() * 3.5,
                                alpha: 0.7 + Math.random() * 0.3
                        });
                }
        }
        update(dt) { this.life -= dt; }
        draw(ctx, camera) {
                const t = 1 - Math.max(this.life, 0) / this.totalLife; // 0..1
                const ease = t * (2 - t);
                const sx = this.x - camera.x;
                const sy = this.y - camera.y;
                ctx.save();
                for (let i = 0; i < this.droplets.length; i++) {
                        const d = this.droplets[i];
                        const dist = d.maxDist * ease;
                        const px = sx + Math.cos(d.angle) * dist;
                        const py = sy + Math.sin(d.angle) * dist + ease * 8; // slight downward gravity
                        ctx.globalAlpha = (1 - t) * d.alpha;
                        ctx.fillStyle = '#8b0000';
                        ctx.beginPath();
                        ctx.arc(px, py, d.radius, 0, Math.PI * 2);
                        ctx.fill();
                }
                ctx.restore();
        }
}

class BloodPoolDecal {
        constructor(x, y, maxRadiusHint) {
                this.x = x;
                this.y = y;
                this.totalLife = 10.0;
                this.life = this.totalLife;
                this.elapsed = 0;
                this.growDuration = 1.8;
                this.maxRadius = (Number.isFinite(maxRadiusHint) ? maxRadiusHint : 30) * 1.5; // up to 1.5x enemy
                this.startRadius = Number.isFinite(maxRadiusHint) ? maxRadiusHint : (this.maxRadius / 1.5);
                this.fadeInDuration = 0.3;
                // Build a blobby pool from overlapping circles
                this.blobs = [];
                const blobCount = 8 + Math.floor(Math.random() * 8);
                for (let i = 0; i < blobCount; i++) {
                        const ang = Math.random() * Math.PI * 2;
                        // Keep blob centers within the cap so combined shape stays near the enemy size
                        const dist = (Math.random() ** 0.9) * (this.maxRadius * 0.65);
                        let endR = this.maxRadius * (0.35 + Math.random() * 0.65);
                        endR = Math.min(endR, this.maxRadius);
                        const startScale = this.startRadius / this.maxRadius; // ~0.666 when max=1.5x start
                        const startR = endR * startScale;
                        this.blobs.push({
                                offx: Math.cos(ang) * dist,
                                offy: Math.sin(ang) * dist,
                                startR: startR,
                                endR: endR,
                                jitter: (Math.random() - 0.5) * 2
                        });
                }
        }
        update(dt) { this.life -= dt; this.elapsed += dt; }
        draw(ctx, camera) {
                const t = 1 - Math.max(this.life, 0) / this.totalLife; // 0..1
                const fade = 1 - t; // fade out over time
                const spreadT = Math.min(1, this.elapsed / this.growDuration);
                const startScale = this.startRadius / this.maxRadius;
                const curScale = startScale + (1 - startScale) * spreadT;
                const fadeIn = Math.min(1, this.elapsed / this.fadeInDuration);
                const sx = this.x - camera.x;
                const sy = this.y - camera.y;
                ctx.save();
                // Dark outer stain
                ctx.globalAlpha = 0.25 * fade * fadeIn;
                ctx.fillStyle = '#3b0000';
                for (let i = 0; i < this.blobs.length; i++) {
                        const b = this.blobs[i];
                        let curR = b.endR * curScale;
                        if (curR > this.maxRadius) curR = this.maxRadius;
                        const growOff = curScale;
                        ctx.beginPath();
                        ctx.arc(sx + b.offx * growOff, sy + b.offy * growOff, curR * 1.1, 0, Math.PI * 2);
                        ctx.fill();
                }
                // Rich red inner stain
                ctx.globalAlpha = 0.35 * fade * fadeIn;
                ctx.fillStyle = '#6b0000';
                for (let i = 0; i < this.blobs.length; i++) {
                        const b = this.blobs[i];
                        let curR = b.endR * curScale;
                        if (curR > this.maxRadius) curR = this.maxRadius;
                        const growOff = curScale;
                        ctx.beginPath();
                        ctx.arc(sx + b.offx * growOff * 0.8, sy + b.offy * growOff * 0.8, curR * 0.85, 0, Math.PI * 2);
                        ctx.fill();
                }
                ctx.restore();
        }
}

class Enemies {
	constructor() {
		this.items = [];
		this.cellSize = 512; // spatial hash cell size (world units)
		
		// Use standard Map-based spatial grid (OptimizedSpatialGrid has enemy positioning bugs)
		this.grid = new Map(); // key: "cx,cy" -> Enemy[]
		this._useOptimizedGrid = false;
		console.log('[Enemies] Using standard Map-based spatial grid (stable, no desyncs)');
		
		// VFX list for enemy damage
		this._vfx = [];
                // Floating damage texts
                this._damageTexts = [];
                // Expose enqueuer for decoupled calls from Enemy.applyDamage
                window.enqueueEnemyVfx = (vfx) => { try { this._vfx.push(vfx); } catch(e) {} };
                // Expose enqueuer for floating damage numbers
                window.enqueueDamageText = (entry) => {
                        try {
                                const e = entry || {};
                                e.x = Number.isFinite(e.x) ? e.x : 0;
                                e.y = Number.isFinite(e.y) ? e.y : 0;
                                e.text = (e.text != null) ? String(e.text) : '';
                                e.crit = !!e.crit;
                                e.color = e.color || (e.crit ? '#ffd36b' : '#ffffff');
                                e.life = Number.isFinite(e.life) ? e.life : 0.9;
                                e.totalLife = Number.isFinite(e.totalLife) ? e.totalLife : e.life;
                                e.vx = Number.isFinite(e.vx) ? e.vx : 0;
                                e.vy = Number.isFinite(e.vy) ? e.vy : -60;
                                e.scale = Number.isFinite(e.scale) ? e.scale : 1; // Default scale 1x
                                // Initial spread to reduce overlap: stagger horizontally for nearby recent texts
                                const spreadEnabled = (e.spread !== false);
                                if (spreadEnabled) {
                                        let cluster = 0;
                                        for (let i = this._damageTexts.length - 1; i >= 0 && cluster < 12; i--) {
                                                const t = this._damageTexts[i];
                                                if (!t) continue;
                                                const dy = Math.abs((t.y || 0) - e.y);
                                                const dx = Math.abs((t.x || 0) - e.x);
                                                if (dy <= 28 && dx <= 28) { cluster++; }
                                        }
                                        // Map cluster index to offset pattern centered at 0: -2,-1,0,1,2,... times step
                                        const step = 10;
                                        const slot = (cluster % 5) - 2; // -2..2 repeating
                                        const ring = Math.floor(cluster / 5); // widen for later ones
                                        const offsetX = slot * step * (1 + 0.2 * ring);
                                        // Apply small random jitter so equal slots don't perfectly overlap
                                        const jitter = (Math.random() * 4 - 2);
                                        e.x += offsetX + jitter;
                                        // Give initial outward horizontal velocity that damps away
                                        e.vx += offsetX * 2;
                                }
                                this._damageTexts.push(e);
                        } catch(_) {}
                };
        }

        // Returns { x, y, r } for the gold chest no-spawn zone, or null if unavailable
        _getGoldNoSpawnZone() {
                try {
                        if (typeof window.getChests === 'function') {
                                const list = window.getChests();
                                for (let i = 0; i < list.length; i++) {
                                        const c = list[i];
                                        if (c && c.variant === 'gold') {
                                                return { x: c.x, y: c.y, r: 1500 };
                                        }
                                }
                        }
                } catch(_) {}
                return null;
        }

        _keyFromWorld(x, y) {
                const cx = Math.floor(x / this.cellSize);
                const cy = Math.floor(y / this.cellSize);
                return cx + ',' + cy;
        }

	_insert(enemy) {
		// Use optimized grid if available
		if (this._useOptimizedGrid) {
			this.grid.insert(enemy);
		} else {
			// Fallback to string-key grid
			const key = this._keyFromWorld(enemy.x, enemy.y);
			enemy._gridKey = key;
			let bucket = this.grid.get(key);
			if (!bucket) { bucket = []; this.grid.set(key, bucket); }
			bucket.push(enemy);
		}
	}

        spawnRandom(count, environment, EnemyClass = Enemy) {
                console.log('[Enemy Spawn] Spawning random enemies with seeded RNG');
                
                const max = environment?.maxRange ?? 10000;
                const goldZone = this._getGoldNoSpawnZone();
                for (let n = 0; n < count; n++) {
                        let placed = false;
                        for (let tries = 0; tries < 30 && !placed; tries++) {
                                const x = WorldRNG.randomFloat(-max, max);
                                const y = WorldRNG.randomFloat(-max, max);
                                const temp = new EnemyClass(x, y);
                                // avoid spawn-safe circle and obstacles
                                const inSpawnSafe = environment && environment._circleIntersectsRect && environment._circleIntersectsRect(
                                        environment.spawnSafeX, environment.spawnSafeY, environment.spawnSafeRadius, { x, y, w: temp.radius * 2, h: temp.radius * 2 }
                                );
                                // avoid player spawn square (half-size 750)
                                let inSpawnSquare = false;
                                try {
                                        const half = 750;
                                        const sx = environment?.spawnSafeX ?? 0;
                                        const sy = environment?.spawnSafeY ?? 0;
                                        inSpawnSquare = (Math.abs(x - sx) <= half + (temp.radius || 0)) && (Math.abs(y - sy) <= half + (temp.radius || 0));
                                } catch(_) {}
                                const hitsObstacle = environment && environment.circleHitsAny && environment.circleHitsAny(x, y, temp.radius);
                                // avoid gold chest no-spawn radius
                                const inGoldNoSpawn = goldZone ? ((x - goldZone.x) * (x - goldZone.x) + (y - goldZone.y) * (y - goldZone.y) <= Math.pow(goldZone.r + (temp.radius || 0), 2)) : false;
                                if (!inSpawnSafe && !inSpawnSquare && !hitsObstacle && !inGoldNoSpawn) {
                                        this.items.push(temp);
                                        this._insert(temp);
                                        placed = true;
                                }
                        }
                }
        }

        spawnClusters(totalCount, environment, EnemyClass = Enemy) {
                console.log('[Enemy Spawn] Spawning clustered enemies with seeded RNG');
                
                const max = environment?.maxRange ?? 10000;
                let remaining = totalCount;
                const clusterMin = 3;
                const clusterMax = 10;
                let enemyRadius = 26;
                const goldZone = this._getGoldNoSpawnZone();
                // Support options object for mixed-class clusters or custom picker
                let pickClass = null;
                let baseClass = Enemy;
                let mixSpecs = null;
                if (EnemyClass && typeof EnemyClass === 'object') {
                        // Option A: custom picker function
                        if (typeof EnemyClass.pickClass === 'function') {
                                pickClass = EnemyClass.pickClass;
                        }
                        // Option B: baseClass + mix array with per-cluster counts
                        if (EnemyClass.baseClass) baseClass = EnemyClass.baseClass;
                        if (Array.isArray(EnemyClass.mix)) mixSpecs = EnemyClass.mix;
                } else if (typeof EnemyClass === 'function') {
                        baseClass = EnemyClass;
                }
                try {
                        const probeClass = (typeof baseClass === 'function') ? baseClass : Enemy;
                        if (probeClass && probeClass !== Enemy) {
                                const probe = new probeClass(0, 0);
                                enemyRadius = Number.isFinite(probe.radius) ? probe.radius : 26;
                        }
                } catch(e) {}
                const padding = 2;
                while (remaining > 0) {
                        const size = Math.min(remaining, clusterMin + WorldRNG.randomInt(0, clusterMax - clusterMin));
                        // pick a cluster center
                        let cx = 0, cy = 0, centerFound = false;
                        for (let t = 0; t < 50 && !centerFound; t++) {
                                cx = WorldRNG.randomFloat(-max, max);
                                cy = WorldRNG.randomFloat(-max, max);
                                const inSpawnSafe = environment && environment._circleIntersectsRect && environment._circleIntersectsRect(
                                        environment.spawnSafeX, environment.spawnSafeY, environment.spawnSafeRadius, { x: cx, y: cy, w: enemyRadius * 2, h: enemyRadius * 2 }
                                );
                                // avoid player spawn square for cluster center
                                let centerInSpawnSquare = false;
                                try {
                                        const half = 750;
                                        const sx = environment?.spawnSafeX ?? 0;
                                        const sy = environment?.spawnSafeY ?? 0;
                                        centerInSpawnSquare = (Math.abs(cx - sx) <= half + (enemyRadius || 0)) && (Math.abs(cy - sy) <= half + (enemyRadius || 0));
                                } catch(_) {}
                                const hitsObstacle = environment && environment.circleHitsAny && environment.circleHitsAny(cx, cy, enemyRadius);
                                // avoid gold chest no-spawn radius for cluster center
                                const centerInGoldNoSpawn = goldZone ? ((cx - goldZone.x) * (cx - goldZone.x) + (cy - goldZone.y) * (cy - goldZone.y) <= Math.pow(goldZone.r + (enemyRadius || 0), 2)) : false;
                                if (!inSpawnSafe && !centerInSpawnSquare && !hitsObstacle && !centerInGoldNoSpawn) centerFound = true;
                        }
                        if (!centerFound) break;

                        // place members around center
                        const members = [];
                        const clusterRadius = 160 + WorldRNG.randomFloat(0, 160);
                        // Determine per-cluster composition when using mixSpecs (support multiple entries)
                        const indexToClass = new Map();
                        if (!pickClass && Array.isArray(mixSpecs) && mixSpecs.length > 0) {
                                for (let si = 0; si < mixSpecs.length; si++) {
                                        const spec = mixSpecs[si];
                                        const specialCls = spec && spec.cls ? spec.cls : null;
                                        if (!specialCls) continue;
                                        const minC = Math.max(0, Math.min(size, Number.isFinite(spec.minPerCluster) ? spec.minPerCluster : 0));
                                        const maxC = Math.max(minC, Math.min(size, Number.isFinite(spec.maxPerCluster) ? spec.maxPerCluster : minC));
                                        const count = minC + WorldRNG.randomInt(0, Math.max(0, maxC - minC));
                                        let attempts = 0;
                                        while (attempts < 200 && [...indexToClass.keys()].filter(() => true).length < size && [...indexToClass.values()].filter(v => v === specialCls).length < count) {
                                                const idx = WorldRNG.randomInt(0, size - 1);
                                                if (!indexToClass.has(idx)) {
                                                        indexToClass.set(idx, specialCls);
                                                }
                                                attempts++;
                                        }
                                }
                        }
                        for (let m = 0; m < size; m++) {
                                let placed = false;
                                for (let t = 0; t < 60 && !placed; t++) {
                                        const ang = WorldRNG.randomFloat(0, Math.PI * 2);
                                        const dist = WorldRNG.randomFloat(0, clusterRadius);
                                        const x = cx + Math.cos(ang) * dist;
                                        const y = cy + Math.sin(ang) * dist;
                                        // avoid obstacles and spawn safe
                                        const inSpawnSafe = environment && environment._circleIntersectsRect && environment._circleIntersectsRect(
                                                environment.spawnSafeX, environment.spawnSafeY, environment.spawnSafeRadius, { x, y, w: enemyRadius * 2, h: enemyRadius * 2 }
                                        );
                                        // avoid player spawn square for each member
                                        let memberInSpawnSquare = false;
                                        try {
                                                const half = 750;
                                                const sx = environment?.spawnSafeX ?? 0;
                                                const sy = environment?.spawnSafeY ?? 0;
                                                memberInSpawnSquare = (Math.abs(x - sx) <= half + (enemyRadius || 0)) && (Math.abs(y - sy) <= half + (enemyRadius || 0));
                                        } catch(_) {}
                                        const hitsObstacle = environment && environment.circleHitsAny && environment.circleHitsAny(x, y, enemyRadius);
                                        // avoid gold chest no-spawn radius per member
                                        const memberInGoldNoSpawn = goldZone ? ((x - goldZone.x) * (x - goldZone.x) + (y - goldZone.y) * (y - goldZone.y) <= Math.pow(goldZone.r + (enemyRadius || 0), 2)) : false;
                                        if (inSpawnSafe || memberInSpawnSquare || hitsObstacle || memberInGoldNoSpawn) continue;
                                        // no overlap within cluster
                                        let overlaps = false;
                                        for (let k = 0; k < members.length; k++) {
                                                const ex = members[k].x - x;
                                                const ey = members[k].y - y;
                                                const minD = (enemyRadius * 2 + padding);
                                                if (ex * ex + ey * ey < minD * minD) { overlaps = true; break; }
                                        }
                                        if (overlaps) continue;
                                        let Cls = baseClass;
                                        if (pickClass && typeof pickClass === 'function') {
                                                try { Cls = pickClass({ clusterIndex: undefined, memberIndex: m, clusterSize: size }) || baseClass; } catch(_) { Cls = baseClass; }
                                        } else if (indexToClass.has(m)) {
                                                Cls = indexToClass.get(m);
                                        }
                                        const e = new Cls(x, y);
                                        members.push(e);
                                        this.items.push(e);
                                        this._insert(e);
                                        placed = true;
                                }
                        }
                        remaining -= members.length;
                        if (members.length === 0) break;
                }
                
                console.log('[Enemy Spawn] Completed enemy clustering with seed:', WorldRNG.getCurrentSeed());
        }

        update(dt) {
                // Clean up dead enemies (optional: keep corpses?)
                for (let i = this.items.length - 1; i >= 0; i--) {
                        // advance VFX time for flame animation
                        const e = this.items[i];
                        if (e && e.alive) {
                                e._fxTime = (e._fxTime || 0) + dt;
                                
                                // Update defensive turret muzzle flashes
                                if (e.type === 'defenseTurret' && e._muzzleFlashes && Array.isArray(e._muzzleFlashes)) {
                                        for (let j = e._muzzleFlashes.length - 1; j >= 0; j--) {
                                                e._muzzleFlashes[j].life -= dt;
                                                if (e._muzzleFlashes[j].life <= 0) {
                                                        e._muzzleFlashes.splice(j, 1);
                                                }
                                        }
                                }
                        }
                }
                // Handle armed timers (e.g., Boomer explosion)
                for (let i = 0; i < this.items.length; i++) {
                        const e = this.items[i];
                        if (!e || !e.alive) continue;
                        // Licker behavior update
                        try { if (window.Licker && e instanceof window.Licker && typeof e.updateLicker === 'function') e.updateLicker(dt); } catch(_) {}
                        // Projectile Zombie ranged update
                        try { if (window.ProjectileZombie && e instanceof window.ProjectileZombie && typeof e.updateProjectileZombie === 'function') e.updateProjectileZombie(dt); } catch(_) {}
                        // BigBoy dash behavior update
                        try { if (window.BigBoy && e instanceof window.BigBoy && typeof e.updateBigBoy === 'function') e.updateBigBoy(dt); } catch(_) {}
                        // Artillery Witch firing is server-authoritative (multiplayer-only game)
                        // Server handles artillery attacks via server-side updateArtillery calls
                        // (removed 7 lines of local firing logic)
                        if (e._armedTimerStarted && Number.isFinite(e._armedTimer) && e._armedTimer > 0) {
                                e._armedTimer -= dt;
                                if (e._armedTimer <= 0) {
                                // If server-spawned, skip local detonation (server will broadcast)
                                if (e.serverSpawned) {
                                        e._armedTimer = 0;
                                        continue;
                                }
                                // Detonate at enemy location with grenade-like effect and puke colors
                                        try {
                                                if (window.ExplosionVfx && window.projectiles) {
                                                        const ex = e.x;
                                                        const ey = e.y;
                                                        window.projectiles.impacts.push(new window.ExplosionVfx(ex, ey, '#a8c400', { shockColor: '#cbe24a', sparkColor: '#cbe24a', flashColor: 'rgba(210,255,120,0.9)', smokeColor: 'rgba(90,110,60,1)' }));
                                                        // Damage pulse similar to weapon 2 grenade
                                                        window.projectiles.impacts.push({
                                                                life: 0.25,
                                                                totalLife: 0.25,
                                                                radius: 100,
                                                                hitEnemyIds: new Set(),
                                                                owner: null,
                                                                baseOffset: (Math.random() * 10 - 5),
                                                                hitPlayer: false,
                                                                draw: function(ctx, cam) {
                                                                        const t = Math.max(this.life, 0) / this.totalLife;
                                                                        const alpha = 1.0 * t;
                                                                        const sx = ex - cam.x;
                                                                        const sy = ey - cam.y;
                                                                        ctx.save();
                                                                        ctx.globalAlpha = alpha * 0.35;
                                                                        ctx.fillStyle = '#cbe24a';
                                                                        ctx.beginPath();
                                                                        ctx.arc(sx, sy, this.radius, 0, Math.PI * 2);
                                                                        ctx.fill();
                                                                        ctx.restore();
                                                                },
                                                                update: function(dt, enemies) {
                                                                        this.life -= dt;
                                                                        if (!enemies || !enemies.queryCircle) return;
                                                                        // Pad query radius to include large enemies (BigBoy radius 80) since we later test
                                                                        // against (this.radius + o.radius). queryCircle() is center-distance based.
                                                                        const victims = enemies.queryCircle(ex, ey, this.radius + 80);
                                                                        for (let i = 0; i < victims.length; i++) {
                                                                                const o = victims[i];
                                                                                if (!o || !o.alive) continue;
                                                                                if (this.hitEnemyIds.has(o.id)) continue;
                                                                                const dx = o.x - ex;
                                                                                const dy = o.y - ey;
                                                                                const d = Math.hypot(dx, dy);
                                                                                if (d <= this.radius + (o.radius || 0)) {
                                                                                        const inner = 20;
                                                                                        const outer = this.radius;
                                                                                        let t = (d - inner) / Math.max(1e-6, (outer - inner));
                                                                                        t = Math.max(0, Math.min(1, t));
                                                                                        let damage = (45 - 25 * t) + (this.baseOffset || 0);
                                                                                        o.applyDamage(damage);
                                                                                        this.hitEnemyIds.add(o.id);
                                                                                }
                                                                        }
                                                                        // Player falloff damage like weapon 2 self-damage
                                                                        if (!this.hitPlayer && window.player) {
                                                                                const p = window.player;
                                                                                const dxp = p.x - ex;
                                                                                const dyp = p.y - ey;
                                                                                const dp = Math.hypot(dxp, dyp);
                                                                                if (dp <= this.radius + (p.radius || 0)) {
                                                                                        // Damage is server-authoritative in multiplayer-only game
                                                                                        this.hitPlayer = true;
                                                                                }
                                                                        }
                                                                }
                                                        });
                                                        // Mark as exploded to avoid double-trigger on onDeath
                                                        e._hasExploded = true;
                                                }
                                        } catch(_) {}
                                        // Kill the boomer
                                        try { e.health = 0; e.alive = false; if (typeof e.onDeath === 'function') e.onDeath({ cause: 'self_destruct' }); } catch(_) {}
                                }
                        }
                }
		for (let i = this.items.length - 1; i >= 0; i--) {
			const e = this.items[i];
			if (!e.alive) {
				// Call onDeath cleanup before removing (for WallGuy shield cleanup, etc.)
				try {
					if (typeof e.onDeath === 'function') {
						e.onDeath({ cause: 'despawn' });
					}
				} catch(err) {
					console.error('[Enemies] Error calling onDeath during cleanup:', err);
				}
				
				// Remove from grid
				if (this._useOptimizedGrid) {
					this.grid.remove(e);
				} else {
					const key = e._gridKey;
					const bucket = key ? this.grid.get(key) : undefined;
					if (bucket) {
						const idx = bucket.indexOf(e);
						if (idx !== -1) bucket.splice(idx, 1);
						if (bucket.length === 0) this.grid.delete(key);
					}
				}
				this.items.splice(i, 1);
			}
		}
                // Apply knockback motion over time with collision-safe movement and grid maintenance
                for (let i = 0; i < this.items.length; i++) {
                        const e = this.items[i];
                        if (!e.alive) continue;
                        if (e.kbTime > 0) {
                                const step = Math.min(e.kbTime, dt);
                                const dx = e.kbVelX * step;
                                const dy = e.kbVelY * step;
                                let newX = e.x + dx;
                                let newY = e.y + dy;
                                if (window.environment && typeof environment.resolveCircleMove === 'function') {
                                        const res = environment.resolveCircleMove(e.x, e.y, e.radius, dx, dy);
                                        newX = res.x;
                                        newY = res.y;
                                }
                                // Update spatial hash if cell changed
                                const oldKey = e._gridKey;
                                const newKey = this._keyFromWorld(newX, newY);
				if (this._useOptimizedGrid) {
					this.grid.update(e);
				} else {
					if (newKey !== oldKey) {
						if (oldKey) {
							const bucket = this.grid.get(oldKey);
							if (bucket) {
								const idx = bucket.indexOf(e);
								if (idx !== -1) bucket.splice(idx, 1);
								if (bucket.length === 0) this.grid.delete(oldKey);
							}
						}
						e._gridKey = newKey;
						let nb = this.grid.get(newKey);
						if (!nb) { nb = []; this.grid.set(newKey, nb); }
						nb.push(e);
					}
				}
				e.x = newX;
				e.y = newY;
				// Knock-on effect: push up to 3 nearby enemies when colliding, without chaining
				if (e.kbPushedIds && e.kbPushedIds.size < 3) {
					// Query nearby enemies (use optimized grid if available)
					let nearbyEnemies = [];
					if (this._useOptimizedGrid) {
						nearbyEnemies = this.grid.queryCircle(newX, newY, e.radius * 3);
					} else {
						const cs = this.cellSize;
						const cx = Math.floor(newX / cs);
						const cy = Math.floor(newY / cs);
						for (let gy = cy - 1; gy <= cy + 1; gy++) {
							for (let gx = cx - 1; gx <= cx + 1; gx++) {
								const bucket = this.grid.get(gx + ',' + gy);
								if (!bucket) continue;
								for (let bi = 0; bi < bucket.length; bi++) {
									nearbyEnemies.push(bucket[bi]);
								}
							}
						}
					}
					
				for (let ni = 0; ni < nearbyEnemies.length; ni++) {
					if (e.kbPushedIds.size >= 3) break;
					const o = nearbyEnemies[ni];
					if (!o || o === e || !o.alive) continue;
					const dx2 = o.x - e.x;
					const dy2 = o.y - e.y;
					const sumR = (o.radius || 0) + (e.radius || 0);
					if (dx2 * dx2 + dy2 * dy2 <= sumR * sumR) {
						if (!e.kbPushedIds.has(o.id)) {
							// Push the other enemy slightly away from e
							let ux = dx2;
							let uy = dy2;
							let mag = Math.hypot(ux, uy);
							if (mag === 0) { ux = 1; uy = 0; mag = 1; }
							ux /= mag; uy /= mag;
							const pushDist = 24; // slight knock-on distance
							let newOX = o.x + ux * pushDist;
							let newOY = o.y + uy * pushDist;
							if (window.environment && typeof environment.resolveCircleMove === 'function') {
								const res2 = environment.resolveCircleMove(o.x, o.y, o.radius, ux * pushDist, uy * pushDist);
								newOX = res2.x; newOY = res2.y;
							}
							// Update spatial hash for o if changed cell
							const oldKeyO = o._gridKey;
							const newKeyO = this._keyFromWorld(newOX, newOY);
							if (this._useOptimizedGrid) {
								this.grid.update(o);
							} else {
								if (newKeyO !== oldKeyO) {
									if (oldKeyO) {
										const b2 = this.grid.get(oldKeyO);
										if (b2) {
											const ix = b2.indexOf(o);
											if (ix !== -1) b2.splice(ix, 1);
											if (b2.length === 0) this.grid.delete(oldKeyO);
										}
									}
									o._gridKey = newKeyO;
									let nb2 = this.grid.get(newKeyO);
									if (!nb2) { nb2 = []; this.grid.set(newKeyO, nb2); }
									nb2.push(o);
								}
							}
							o.x = newOX;
							o.y = newOY;
							e.kbPushedIds.add(o.id);
						}
					}
				}
			}
                                e.kbTime -= step;
                                if (e.kbTime <= 0) { e.kbTime = 0; e.kbVelX = 0; e.kbVelY = 0; if (e.kbPushedIds) e.kbPushedIds.clear(); }
                        }
                        // Apply damage-over-time stacks
                        e._tickDot(dt);
                }
                // Update blood VFX
                for (let i = this._vfx.length - 1; i >= 0; i--) {
                        const v = this._vfx[i];
                        v.update(dt);
                        if (v.life <= 0) this._vfx.splice(i, 1);
                }
                // Update floating damage texts
                for (let i = this._damageTexts.length - 1; i >= 0; i--) {
                        const t = this._damageTexts[i];
                        t.life -= dt;
                        // Apply damping to horizontal spread so it settles quickly
                        const damp = 6;
                        t.vx *= Math.max(0, 1 - damp * dt);
                        t.x += (t.vx || 0) * dt;
                        t.y += (t.vy || 0) * dt;
                        if (t.life <= 0) this._damageTexts.splice(i, 1);
                }
        }

	// Query enemies within a circle (for collisions/interest management)
	queryCircle(x, y, radius) {
		// Use optimized grid if available (5-10% faster)
		if (this._useOptimizedGrid) {
			const candidates = this.grid.queryCircle(x, y, radius);
			// Still need fine-grained circle test
			const results = [];
			for (let i = 0; i < candidates.length; i++) {
				const e = candidates[i];
				if (!e.alive) continue;
				const dx = e.x - x;
				const dy = e.y - y;
				if (dx * dx + dy * dy <= radius * radius) results.push(e);
			}
			return results;
		}
		
		// Fallback to string-key grid
		const cs = this.cellSize;
		const minCx = Math.floor((x - radius) / cs);
		const maxCx = Math.floor((x + radius) / cs);
		const minCy = Math.floor((y - radius) / cs);
		const maxCy = Math.floor((y + radius) / cs);
		const results = [];
		for (let cy = minCy; cy <= maxCy; cy++) {
			for (let cx = minCx; cx <= maxCx; cx++) {
				const bucket = this.grid.get(cx + ',' + cy);
				if (!bucket) continue;
				for (let i = 0; i < bucket.length; i++) {
					const e = bucket[i];
					if (!e.alive) continue;
					const dx = e.x - x;
					const dy = e.y - y;
					if (dx * dx + dy * dy <= radius * radius) results.push(e);
				}
			}
		}
		return results;
	}

	draw(ctx, camera, viewport) {
		// Use centralized cullBounds if provided, otherwise calculate (fallback for compatibility)
		const bounds = viewport.cullBounds || {
			left: camera.x - viewport.width / 2 - 150,
			right: camera.x + viewport.width / 2 + 150,
			top: camera.y - viewport.height / 2 - 150,
			bottom: camera.y + viewport.height / 2 + 150
		};
		const left = bounds.left;
		const right = bounds.right;
		const top = bounds.top;
		const bottom = bounds.bottom;
		
		// Use optimized grid if available
		if (this._useOptimizedGrid && typeof this.grid.queryCircle === 'function') {
			// More efficient query using smaller, more precise radius
			const w = bounds.width || viewport.width;
			const h = bounds.height || viewport.height;
			const centerX = camera.x + w / 2;
			const centerY = camera.y + h / 2;
			const margin = 150;
			const radius = Math.sqrt(w * w + h * h) / 2 + margin; // Diagonal radius
			const candidates = this.grid.queryCircle(centerX, centerY, radius);
			
			for (let i = 0; i < candidates.length; i++) {
				const e = candidates[i];
				if (!e.alive) continue;
				// Boundary culling (avoid OOB draw in case of bad spawns)
				if (window.environment && environment.isInsideBounds && !environment.isInsideBounds(e.x, e.y, e.radius)) continue;
				// Tight AABB culling
				const el = e.x - e.radius;
				const er = e.x + e.radius;
				const et = e.y - e.radius;
				const eb = e.y + e.radius;
				if (er < left || el > right || eb < top || et > bottom) continue;
				e.draw(ctx, camera);
				// Draw WallGuy shield
				if (e.type === 'wallguy') {
					if (e.shield && e.shield.alive) {
						// Update shield position before drawing
						const angle = Number.isFinite(e.shieldAngle) ? e.shieldAngle : 0;
						e.shield.update(0, angle);
						if (__DEBUG_BUILD && Math.random() < 0.01) { // 1% sample rate (debug-only)
							console.log('[SHIELD DEBUG] Drawing shield for', e.id, 'at:', e.shield.x.toFixed(0), e.shield.y.toFixed(0), 'enemy at:', e.x.toFixed(0), e.y.toFixed(0), 'angle:', (angle * 180 / Math.PI).toFixed(0), '°', 'alive:', e.shield.alive);
						}
						e.shield.draw(ctx, camera);
					} else {
						if (__DEBUG_BUILD && Math.random() < 0.001) { // 0.1% sample rate (debug-only)
							console.warn('[SHIELD DEBUG] WallGuy', e.id, 'has NO SHIELD or shield dead! shield:', e.shield, 'alive:', e.shield?.alive);
						}
					}
				}
			}
		} else if (this.grid instanceof Map) {
			// Fallback to string-key grid
			const cs = this.cellSize;
			const minCx = Math.floor(left / cs);
			const maxCx = Math.floor(right / cs);
			const minCy = Math.floor(top / cs);
			const maxCy = Math.floor(bottom / cs);
			for (let cy = minCy; cy <= maxCy; cy++) {
				for (let cx = minCx; cx <= maxCx; cx++) {
					const bucket = this.grid.get(cx + ',' + cy);
					if (!bucket) continue;
					for (let i = 0; i < bucket.length; i++) {
						const e = bucket[i];
						if (!e.alive) continue;
						// Boundary culling (avoid OOB draw in case of bad spawns)
						if (window.environment && environment.isInsideBounds && !environment.isInsideBounds(e.x, e.y, e.radius)) continue;
						// AABB reject
						const el = e.x - e.radius;
						const er = e.x + e.radius;
						const et = e.y - e.radius;
						const eb = e.y + e.radius;
						if (er < left || el > right || eb < top || et > bottom) continue;
						e.draw(ctx, camera);
						// Draw WallGuy shield
						if (e.type === 'wallguy' && e.shield) {
							e.shield.draw(ctx, camera);
						}
					}
				}
			}
		} else {
			// Final fallback: iterate all items with AABB culling
			for (let i = 0; i < this.items.length; i++) {
				const e = this.items[i];
				if (!e.alive) continue;
				if (window.environment && environment.isInsideBounds && !environment.isInsideBounds(e.x, e.y, e.radius)) continue;
				const el = e.x - e.radius;
				const er = e.x + e.radius;
				const et = e.y - e.radius;
				const eb = e.y + e.radius;
				if (er < left || el > right || eb < top || et > bottom) continue;
				e.draw(ctx, camera);
				// Draw WallGuy shield
				if (e.type === 'wallguy') {
					if (e.shield && e.shield.alive) {
						// Update shield position before drawing
						const angle = Number.isFinite(e.shieldAngle) ? e.shieldAngle : 0;
						e.shield.update(0, angle);
						if (__DEBUG_BUILD && Math.random() < 0.01) { // 1% sample rate (debug-only)
							console.log('[SHIELD DEBUG] Drawing shield for', e.id, 'at:', e.shield.x.toFixed(0), e.shield.y.toFixed(0), 'enemy at:', e.x.toFixed(0), e.y.toFixed(0), 'angle:', (angle * 180 / Math.PI).toFixed(0), '°', 'alive:', e.shield.alive);
						}
						e.shield.draw(ctx, camera);
					} else {
						if (__DEBUG_BUILD && Math.random() < 0.001) { // 0.1% sample rate (debug-only)
							console.warn('[SHIELD DEBUG] WallGuy', e.id, 'has NO SHIELD or shield dead! shield:', e.shield, 'alive:', e.shield?.alive);
						}
					}
				}
			}
		}
		
		// Draw VFX on top
		for (let i = 0; i < this._vfx.length; i++) this._vfx[i].draw(ctx, camera);
                // Draw floating damage numbers on top: non-crit first, then crit to ensure crits render above
                for (let pass = 0; pass < 2; pass++) {
                        const wantCrit = (pass === 1);
                        for (let i = 0; i < this._damageTexts.length; i++) {
                                const t = this._damageTexts[i];
                                if (!!t.crit !== wantCrit) continue;
                                const sx = t.x - camera.x;
                                const sy = t.y - camera.y;
                                const a = Math.max(0, Math.min(1, (t.totalLife > 0 ? t.life / t.totalLife : 0)));
                                
                                // Apply scale to font size
                                const baseSize = t.crit ? 20 : 16;
                                const scale = Number.isFinite(t.scale) ? t.scale : 1;
                                const numSize = Math.round(baseSize * scale);
                                const labelOffset = t.crit ? (numSize + 4) : Math.round(18 * scale);
                                
                                ctx.save();
                                ctx.globalAlpha = Math.pow(a, 0.8);
                                ctx.textAlign = 'center';
                                ctx.textBaseline = 'bottom';
                                ctx.font = 'bold ' + numSize + 'px monospace';
                                // Shadow
                                ctx.fillStyle = 'rgba(0,0,0,0.6)';
                                if (t.crit) {
                                        ctx.fillText('CRIT', sx + 1, sy - labelOffset + 1);
                                }
                                ctx.fillText(t.text, sx + 1, sy + 1);
                                // Color
                                ctx.fillStyle = t.color || (t.crit ? '#ffd36b' : '#ffffff');
                                if (t.crit) {
                                        ctx.fillText('CRIT', sx, sy - labelOffset);
                                }
                                ctx.fillText(t.text, sx, sy);
                                ctx.restore();
                        }
                }
        }
}

window.Enemies = Enemies;

window.Boomer = Boomer;

window.Licker = Licker;

window.ProjectileZombie = ProjectileZombie;

window.TargetDummy = TargetDummy;

class BigBoy extends Enemy {
        constructor(x, y) {
                super(x, y);
                // 2.5x the size of boomer (boomer radius is 32)
                this.radius = 80;
                // Light grey yellow color
                this.color = '#d4d4a8';
                this.outline = '#000000';
                // 4x the health of boomer (boomer health is 220)
                this.healthMax = 880;
                this.health = this.healthMax;
                // Slower movement speed due to size
                this.speedMul = 0.7;
                // Dash attack state
                this.dashCooldown = 0;
                this.dashRange = 400; // Range to trigger dash
                this.dashDistance = 300; // Distance of dash
                this.dashDuration = 0.3; // Duration of dash
                this.dashDamage = 35 + Math.random() * 15; // 35-50 damage
                this.dashWindup = 0; // Windup time before dash
                this.dashWindupDuration = 0.8; // Time to wind up
                this.isDashing = false;
                this.dashTarget = null;
                // Contact damage is 2x zombie damage (zombie contact damage is ~10 per second)
                this.contactDamage = 20;
                // Prefer contact for melee attacks
                this.preferContact = true;
                // Avoid obstacles aggressively
                this.avoidObstaclesAggressively = true;
                // Health bar offset for larger enemy
                this.healthBarOffset = 60;
                this.healthBarWidth = 200;
        }

        updateBigBoy(dt) {
                try {
                        // Dash attack is server-authoritative (multiplayer-only game)
                        // Server handles dash AI and broadcasts dash events
                        
                        // Client-side: decrement dashWindup timer for visual effects
                        if (this.dashWindup > 0) {
                                this.dashWindup -= dt;
                                if (this.dashWindup < 0) {
                                        this.dashWindup = 0;
                                }
                        }
                } catch(_) {}
        }

        draw(ctx, camera) {
                const sx = this.x - camera.x;
                const sy = this.y - camera.y;
                
                // Add jiggle effect only in the last 1 second before dash
                let jiggleX = 0;
                let jiggleY = 0;
                if (this.dashWindup > 0 && this.dashWindup <= 1.0) {
                        // Calculate progress through the windup (0 = just started, 1 = about to dash)
                        const windupProgress = 1 - (this.dashWindup / 1.0);
                        
                        // Start with strong jitter (6), settle down to weak (3) near the end
                        // At 0.1s remaining, jitter is minimal before the red flash
                        const maxIntensity = 6;
                        const minIntensity = 3;
                        const jiggleIntensity = maxIntensity - (maxIntensity - minIntensity) * windupProgress;
                        
                        jiggleX = (Math.random() - 0.5) * jiggleIntensity;
                        jiggleY = (Math.random() - 0.5) * jiggleIntensity;
                }
                
                // Draw base enemy with jiggle offset
                ctx.save();
                ctx.translate(jiggleX, jiggleY);
                Enemy.prototype.draw.call(this, ctx, camera);
                ctx.restore();
                
                // Draw dash windup indicator only in the last 0.1 seconds
                try {
                        if (this.dashWindup > 0 && this.dashWindup <= 0.1) {
                                const progress = 1 - (this.dashWindup / 0.1);
                                
                                ctx.save();
                                // Red warning ring that grows
                                ctx.strokeStyle = '#ff4444';
                                ctx.lineWidth = 4;
                                ctx.globalAlpha = 0.6 + 0.4 * progress;
                                ctx.beginPath();
                                ctx.arc(sx, sy, this.radius + 10 + progress * 20, 0, Math.PI * 2);
                                ctx.stroke();
                                ctx.restore();
                        }
                } catch(_) {}
        }
}

window.BigBoy = BigBoy;

class WallGuy extends Enemy {
	constructor(x, y) {
		super(x, y);
		// Maroon colored enemy
		this.radius = 28;
		this.color = '#8B2F2F'; // Maroon
		this.outline = '#000000';
		// Tankier since shielded
		this.healthMax = 300;
		this.health = this.healthMax;
		// Slower movement
		this.speedMul = 0.8;
		this.preferContact = true;
		
		// Shield state (synced from server)
		this.shieldAngle = 0; // Direction shield is facing
		this.rotationSpeed = Math.PI / 3; // 60 degrees per second (slow rotation)
		
		// Attack state (synced from server)
		this._attackCooldown = 0;
		this._attackAngle = 0;
		
		// Shield reference (will be set when shield is created)
		this.shield = null;
	}
	
	draw(ctx, camera) {
		if (!this.alive) return;
		
		const sx = this.x - camera.x;
		const sy = this.y - camera.y;
		
		ctx.save();
		
		// Draw maroon zombie body
		const baseAlpha = this.serverSpawned ? 0.85 : 1.0;
		ctx.globalAlpha = baseAlpha;
		
		// Shadow
		ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
		ctx.beginPath();
		ctx.arc(sx + 5, sy + 7, this.radius, 0, Math.PI * 2);
		ctx.fill();
		
		// Body
		ctx.fillStyle = this.color;
		ctx.strokeStyle = this.outline;
		ctx.lineWidth = 3;
		ctx.beginPath();
		ctx.arc(sx, sy, this.radius, 0, Math.PI * 2);
		ctx.fill();
		ctx.stroke();
		
		// Hit flash
		if (this.hitFlash > 0) {
			ctx.globalAlpha = this.hitFlash * 0.7 * baseAlpha;
			ctx.fillStyle = '#ffffff';
			ctx.beginPath();
			ctx.arc(sx, sy, this.radius, 0, Math.PI * 2);
			ctx.fill();
		}
		
		ctx.restore();
		
		// Fire VFX for active DOT stacks (weapon 4)
		if (this.dotStacks && this.dotStacks.length > 0) {
			ctx.save();
			const stacks = this.dotStacks.length;
			const intensity = Math.min(1.2, stacks / 4);
			const baseR = this.radius * (1.0 + 0.8 * intensity);
			const t = this._fxTime || 0;
			const wobble = Math.sin(t * 6) * 0.12;
			const sx0 = sx + wobble * this.radius * 0.3;
			const sy0 = sy - this.radius * (0.25 + 0.1 * Math.sin(t * 4 + this.id));
			const grad = ctx.createRadialGradient(sx0, sy0, baseR * 0.1, sx0, sy0, baseR);
			grad.addColorStop(0, 'rgba(255, 250, 210, ' + (0.95 * intensity) + ')');
			grad.addColorStop(0.35, 'rgba(255, 200, 80, ' + (0.65 * intensity) + ')');
			grad.addColorStop(1, 'rgba(255, 120, 0, 0)');
			ctx.fillStyle = grad;
			ctx.beginPath();
			ctx.ellipse(sx0, sy0, baseR * (0.7 + 0.05 * Math.sin(t * 8)), baseR * (1.35 + 0.1 * Math.sin(t * 5 + 1.1)), wobble * 0.6, 0, Math.PI * 2);
			ctx.fill();
			// Wavy flame tongue
			ctx.globalAlpha = 0.85 * intensity;
			ctx.fillStyle = 'rgba(255, 170, 40, 0.7)';
			const tongueH = this.radius * (1.1 + 0.6 * intensity) * (1 + 0.08 * Math.sin(t * 7));
			const tongueW = this.radius * (0.55 + 0.35 * intensity) * (1 + 0.05 * Math.sin(t * 9 + 0.7));
			ctx.beginPath();
			ctx.moveTo(sx0 - tongueW * 0.5, sy0);
			ctx.quadraticCurveTo(sx0 + wobble * 10, sy0 - tongueH * 0.85, sx0 + tongueW * 0.5, sy0);
			ctx.quadraticCurveTo(sx0 - wobble * 10, sy0 - tongueH, sx0 - tongueW * 0.5, sy0);
			ctx.fill();
			// Occasional small sparks
			const sparkN = 3 + Math.floor(intensity * 3);
			for (let i = 0; i < sparkN; i++) {
				const a = (-Math.PI / 2) + (Math.random() - 0.5) * 0.6;
				const r = this.radius * (0.4 + Math.random() * 0.7);
				const px = sx0 + Math.cos(a) * r;
				const py = sy0 + Math.sin(a) * r - (6 + Math.random() * 10);
				ctx.globalAlpha = 0.6 * intensity;
				ctx.fillStyle = '#ffd36b';
				ctx.beginPath();
				ctx.arc(px, py, 1.6, 0, Math.PI * 2);
				ctx.fill();
			}
			// Light smoke puff above the flame
			ctx.globalAlpha = 0.3 * Math.min(1, intensity + 0.2);
			ctx.fillStyle = 'rgba(90, 90, 90, 0.9)';
			const smokeR = this.radius * (0.5 + 0.2 * Math.sin(t * 2 + this.id));
			ctx.beginPath();
			ctx.ellipse(sx0, sy0 - baseR * 0.9, smokeR * 0.8, smokeR * 0.5, 0, 0, Math.PI * 2);
			ctx.fill();
			ctx.restore();
		}
		
		// Health bar
		if (this.health < this.healthMax) {
			const barW = this.radius * 2;
			const barH = 4;
			const barY = sy - this.radius - 10;
			ctx.fillStyle = 'rgba(0,0,0,0.5)';
			ctx.fillRect(sx - barW/2, barY, barW, barH);
			ctx.fillStyle = '#ff3333';
			const healthFrac = this.health / this.healthMax;
			ctx.fillRect(sx - barW/2, barY, barW * healthFrac, barH);
		}
	}
	
	onDeath(info) {
		// Clean up shield collision box immediately when WallGuy dies
		try {
			if (this.shield) {
				this.shield.alive = false;
				
				// Remove collision box from environment.orientedBoxes
				if (window.environment && window.environment.orientedBoxes) {
					let removed = false;
					
					// Try using index first (fast path)
					if (this.shield._envBoxIndex !== undefined) {
						const idx = this.shield._envBoxIndex;
						if (idx >= 0 && idx < window.environment.orientedBoxes.length) {
							const box = window.environment.orientedBoxes[idx];
							// Verify it's actually our collision box
							if (this.shield.collisionBox === box) {
								window.environment.orientedBoxes.splice(idx, 1);
								removed = true;
								
								// Update indices for all shields that came after this one
								for (let i = idx; i < window.environment.orientedBoxes.length; i++) {
									const box = window.environment.orientedBoxes[i];
									if (window.enemies && window.enemies.items) {
										for (const enemy of window.enemies.items) {
											if (enemy.shield && enemy.shield.collisionBox === box && enemy.shield._envBoxIndex !== undefined) {
												enemy.shield._envBoxIndex = i;
												break;
											}
										}
									}
								}
							}
						}
					}
					
					// Fallback: find by reference if index method didn't work (handles stale indices)
					if (!removed && this.shield.collisionBox) {
						const idx = window.environment.orientedBoxes.indexOf(this.shield.collisionBox);
						if (idx !== -1) {
							window.environment.orientedBoxes.splice(idx, 1);
							
							// Update indices for all shields that came after this one
							for (let i = idx; i < window.environment.orientedBoxes.length; i++) {
								const box = window.environment.orientedBoxes[i];
								if (window.enemies && window.enemies.items) {
									for (const enemy of window.enemies.items) {
										if (enemy.shield && enemy.shield.collisionBox === box && enemy.shield._envBoxIndex !== undefined) {
											enemy.shield._envBoxIndex = i;
											break;
										}
									}
								}
							}
							removed = true;
						}
					}
					
					this.shield._envBoxIndex = undefined;
				}
			}
		} catch(e) {
			console.error('[WallGuy] Error cleaning up shield collision:', e);
		}
	}
}

window.WallGuy = WallGuy;

// Expose base class for safer cross-file references
window.Enemy = Enemy;

// Expose decal classes for blood pools (needed by networking.js for hitscan weapons)
window.BloodPoolDecal = BloodPoolDecal;
window.PukePoolDecal = PukePoolDecal;

