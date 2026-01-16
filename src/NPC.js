class NPC {
	constructor(x, y) {
		if (typeof NPC._nextId !== 'number') NPC._nextId = 1;
		this.id = NPC._nextId++;
		this.x = x;
		this.y = y;
		this.radius = 24;
		this.color = '#6b8e23';
		this.outline = '#000000';
		this.alive = true;
		this._t = 0;
		// Toggle for drawing the yellow mission exclamation icon above head
		this.showExclamation = true;
		// Bark (tooltip bubble) system with gaps and fade/scale animation
		this._bark = {
			lines: [], idx: -1,
			timer: 0, // time left in current phase (show or gap)
			interval: 2.5, // seconds to show each line (fallback)
			gap: 1.5, // seconds between lines when bubble hidden (fallback)
			// Optional per-NPC randomized ranges; when present, next timers are drawn from these
			intervalMin: null,
			intervalMax: null,
			gapMin: null,
			gapMax: null,
			randomOrder: false,
			visible: false,
			phase: 'gap', // 'show' | 'gap'
			fade: 0, // 0..1 alpha scale factor for in/out animation
			fadeDur: 0.7, // seconds for fade-in/out
			color: '#ffb15a'
		};
	}

	update(dt, environment) {
		this._t += dt || 0;
		// Cycle bark lines
		try {
			const b = this._bark;
			if (!b) return;
			// Update fade based on phase
			const fRate = (b.fadeDur > 0 ? (dt / b.fadeDur) : 1);
			if (b.phase === 'show') { b.fade = Math.min(1, b.fade + fRate); b.visible = true; }
			else { b.fade = Math.max(0, b.fade - fRate); if (b.fade === 0) b.visible = false; }
			// Drive show/gap timing only if there are lines
			if (Array.isArray(b.lines) && b.lines.length > 0) {
				b.timer -= dt;
				if (b.timer <= 0) {
					if (b.phase === 'gap') {
						// Advance to next line, then start showing it
						b.idx = (b.idx + 1) % b.lines.length;
						b.phase = 'show';
						// Draw next show time from randomized range if available
						if (Number.isFinite(b.intervalMin) && Number.isFinite(b.intervalMax) && b.intervalMax > b.intervalMin) {
							const min = Math.max(0.5, b.intervalMin);
							const max = Math.max(min + 0.01, b.intervalMax);
							b.timer = min + Math.random() * (max - min);
						} else {
							b.timer = Math.max(0.5, b.interval || 2.5);
						}
					} else {
						// Switch to gap; keep current line while fading out
						b.phase = 'gap';
						// Draw next gap time from randomized range if available
						if (Number.isFinite(b.gapMin) && Number.isFinite(b.gapMax) && b.gapMax > b.gapMin) {
							const min = Math.max(0.2, b.gapMin);
							const max = Math.max(min + 0.01, b.gapMax);
							b.timer = min + Math.random() * (max - min);
						} else {
							b.timer = Math.max(0.4, b.gap || 1.5);
						}
					}
				}
			}
		} catch(_) {}
	}

	draw(ctx, camera) {
		if (!this.alive) return;
		const sx = this.x - camera.x;
		const sy = this.y - camera.y;
		ctx.beginPath();
		ctx.arc(sx, sy, this.radius, 0, Math.PI * 2);
		ctx.fillStyle = this.color;
		ctx.fill();
		ctx.lineWidth = 3;
		ctx.strokeStyle = this.outline;
		ctx.stroke();
		// Debug label: show current mode/state under the NPC
		try {
			if (this.state) {
				ctx.save();
				ctx.font = '12px monospace';
				ctx.textAlign = 'center';
				ctx.textBaseline = 'top';
				ctx.fillStyle = '#ffffff';
				ctx.strokeStyle = 'rgba(0,0,0,0.6)';
				ctx.lineWidth = 3;
				const label = `Mode: ${this.state}`;
				const baseY = Math.round(sy + (this.radius || 24) + 8);
				ctx.strokeText(label, Math.round(sx), baseY);
				ctx.fillText(label, Math.round(sx), baseY);
				// Optional "Attack" debug line when NPC wants to attack
				try {
					if (this._attackDebugVisible) {
						const ay = baseY + 14;
						ctx.strokeText('Attack', Math.round(sx), ay);
						ctx.fillText('Attack', Math.round(sx), ay);
					}
				} catch(_) {}
				ctx.restore();
			}
		} catch(_) {}
		// Exclamation icon above head (yellow glow !) — hidden while following
		try {
			if (this.showExclamation === false || this.state === 'follow' || this.state === 'run_to_boss') {
				// Suppress exclamation while disabled or in follow/run state
			} else {
			const t = this._t || 0;
			const bob = Math.sin(t * 2.6) * 4;
			const iconY = sy - this.radius - 18 + bob;
			ctx.save();
			const glowR = 16 + Math.sin(t * 4) * 1.5;
			const g = ctx.createRadialGradient(sx, iconY, 2, sx, iconY, glowR);
			g.addColorStop(0, 'rgba(255, 240, 120, 0.9)');
			g.addColorStop(1, 'rgba(255, 240, 120, 0)');
			ctx.fillStyle = g;
			ctx.beginPath();
			ctx.arc(sx, iconY, 16, 0, Math.PI * 2);
			ctx.fill();
			// ! mark (rect + dot)
			ctx.fillStyle = '#ffd84a';
			ctx.strokeStyle = '#000000';
			ctx.lineWidth = 2;
			// vertical bar
			ctx.beginPath();
			ctx.rect(sx - 3, iconY - 10, 6, 12);
			ctx.fill();
			ctx.stroke();
			// dot
			ctx.beginPath();
			ctx.arc(sx, iconY + 8, 3, 0, Math.PI * 2);
			ctx.fill();
			ctx.stroke();
			ctx.restore();
			}
		} catch(_) {}
		// Bark bubble above head
		try { if (window._npcBarkList && Array.isArray(window._npcBarkList)) window._npcBarkList.push(this); } catch(_) {}
	}
}

class NPC_A extends NPC {
	constructor(x, y) {
		super(x, y);
		// Forest green
		this.color = '#228b22';
		this.name = 'NPC_A';
		this.carryingBomb = true;
		// Behavior state machine
		this.state = 'idle'; // idle | follow | hostile | run_to_boss | betrayed
		this.speed = 110;
		this._hostileTimer = 0; // fuse for explode when hostile
		// Bark configuration loaded from JSON
		this._barkConfig = null; // { idle:{lines,interval,gap}, follow:{...}, hostile:{...}, run_to_boss:{...} }
		// Preserve previous default lines until JSON loads
		this._bark.lines = ['Shame!!','Ive Failed','Lost all is lost','I must find her'];
		this._bark.interval = 2.8;
		this._loadBarksOnce();
		// Sprint tuning for keeping up with player when off-screen/near edge
		this.sprintMaxMultiplier = 1.8;
		this.sprintEdgeMargin = 40;
		this.sprintRampUpPerSec = 4.0;
		this.sprintRampDownPerSec = 3.0;
		this._sprintFactor = 1;
		// Debug: show "Attack" under mode label when near enemies
		this._attackDebugVisible = false;
		// Close-range attack using weapon 1 (index 0)
		this.attackRange = 200;
		this._attackCooldown = 0;
		// Maintain a small following gap from the player (world units)
		this.followGap = 40;
		// Betrayed state timer
		this._betrayedTimer = 0;
		// Tunable delay before turning hostile after betrayal (seconds)
		this.betrayedDelaySeconds = 3.0;
		// Tunable delay before exploding when entering hostile
		this.hostileDelaySeconds = 4.0;
		// Hostile catch-up tuning: exceed player speed to close distance
		this.hostileCatchupMultiplier = 1.2;
		this.hostileMinSpeedBonus = 60;
		// Once following starts, permanently disable talk interactions
		this._disableTalk = false;
		// Stuck detection while pursuing boss: accumulate time with negligible movement
		this._stuckTime = 0;
		this._lastPosX = x;
		this._lastPosY = y;
	}

	async _loadBarksOnce() {
		try {
			if (!window.DialogueLoader) return;
			// Reuse dialogue loader used by main; if not available, create a temporary one
			const loader = (window.dialogueLoader instanceof window.DialogueLoader)
				? window.dialogueLoader
				: new window.DialogueLoader('dialogue');
			const data = await loader.load(this.name, 'barks');
			if (data && data.barks) {
				this._barkConfig = data.barks;
				// Apply current state's barks if available
				this._applyBarksForState(this.state);
			}
		} catch(_) {}
	}

	_applyBarksForState(stateKey) {
		try {
			if (!this._bark || !this._barkConfig) return;
			const cfg = this._barkConfig[stateKey] || this._barkConfig['default'];
			if (!cfg) return;
			this._bark.lines = Array.isArray(cfg.lines) ? cfg.lines.slice() : [];
			if (typeof cfg.interval === 'number' && cfg.interval > 0) this._bark.interval = cfg.interval;
			if (typeof cfg.gap === 'number' && cfg.gap >= 0) this._bark.gap = cfg.gap;
			// Reset bark timer to start showing new lines
			this._bark.idx = 0; this._bark.timer = Math.max(0.5, this._bark.interval || 2.5); this._bark.phase = 'show'; this._bark.fade = 0; this._bark.visible = true;
		} catch(_) {}
	}

	update(dt, environment) {
		super.update(dt, environment);
		
		// Skip local AI if server-controlled in multiplayer
		if (this._serverControlled && window.networkManager && window.networkManager.connected) {
			// Only update local bark visuals, movement is handled by server
			return;
		}
		
		try {
			const p = window.player;
			if (!p) return;
			// Attack cooldown timer
			if (this._attackCooldown > 0) this._attackCooldown -= dt;
			// Update debug proximity flag: show "Attack" when any enemy within 200 units
			try {
				this._attackDebugVisible = false;
				const pool = window.enemies;
				if (pool && (Array.isArray(pool.items) || typeof pool.queryCircle === 'function')) {
					const range = this.attackRange || 200;
					const candidates = (typeof pool.queryCircle === 'function') ? pool.queryCircle(this.x, this.y, range + 20) : pool.items;
					for (let i = 0; i < candidates.length; i++) {
						const e = candidates[i];
						if (!e || !e.alive) continue;
						const dx = e.x - this.x, dy = e.y - this.y;
						if (dx * dx + dy * dy <= range * range) { this._attackDebugVisible = true; break; }
					}
				}
			} catch(_) {}
			if (this.state === 'follow') {
				// Move toward player with off-screen sprint assist
				const dx = p.x - this.x, dy = p.y - this.y; const d = Math.hypot(dx, dy) || 1;
				const ux = dx / d, uy = dy / d;
				let spd = this.speed;
				// Detect off-screen or near-edge and ramp sprint smoothly
				try {
					const cam = window.getCamera && window.getCamera();
					if (cam) {
						const margin = Math.max(0, this.sprintEdgeMargin || 0);
						const viewLeft = cam.x, viewRight = cam.x + cam.width;
						const viewTop = cam.y, viewBottom = cam.y + cam.height;
						const offscreen = (this.x < viewLeft || this.x > viewRight || this.y < viewTop || this.y > viewBottom);
						const nearEdge = (!offscreen) && (this.x < viewLeft + margin || this.x > viewRight - margin || this.y < viewTop + margin || this.y > viewBottom - margin);
						const wantSprint = offscreen || nearEdge;
						const sprintMax = (this.sprintMaxMultiplier != null) ? this.sprintMaxMultiplier : 1.8;
						const up = (this.sprintRampUpPerSec != null) ? this.sprintRampUpPerSec : 4.0;
						const down = (this.sprintRampDownPerSec != null) ? this.sprintRampDownPerSec : 3.0;
						const target = wantSprint ? sprintMax : 1;
						const rate = (target > (this._sprintFactor || 1)) ? up : down;
						if (this._sprintFactor == null) this._sprintFactor = 1;
						this._sprintFactor += (target - this._sprintFactor) * Math.min(1, Math.max(0, rate * dt));
						if (this._sprintFactor < 1) this._sprintFactor = 1;
						if (this._sprintFactor > sprintMax) this._sprintFactor = sprintMax;
						spd *= this._sprintFactor;
					}
				} catch(_) {}
				let step = spd * dt;
				// Keep breathing room from the player by not entering the minimum distance
				try {
					const desiredGap = (this.followGap != null) ? this.followGap : 36;
					const minDist = (this.radius || 24) + (p.radius || 26) + desiredGap;
					if (d <= minDist) step = 0; else step = Math.min(step, d - minDist);
				} catch(_) {}
				if (step > 0) {
					if (environment && typeof environment.resolveCircleMove === 'function') {
						const res = environment.resolveCircleMove(this.x, this.y, this.radius, ux * step, uy * step);
						this.x = res.x; this.y = res.y;
					} else { this.x += ux * step; this.y += uy * step; }
				}
				// Check proximity to boss for green behavior (attack boss)
				let boss = null;
				try { if (window.enemies && Array.isArray(window.enemies.items)) { for (let i = 0; i < enemies.items.length; i++) { const e = enemies.items[i]; if (e && e.alive && window.ArtilleryWitch && (e instanceof window.ArtilleryWitch)) { boss = e; break; } } } } catch(_) {}
				if (boss) {
					const dbx = boss.x - p.x, dby = boss.y - p.y; const dist = Math.hypot(dbx, dby);
					if (dist <= 800) {
						this.switchState('run_to_boss');
					}
				}
				// Opportunistic close-range attack while following; do not chase
				this._tryAttackNearby();
			} else if (this.state === 'betrayed') {
				// Brief pause to show barks, then turn hostile and explode path
				this._betrayedTimer -= dt;
				if ((this._betrayedTimer || 0) <= 0) {
					this.switchState('hostile');
				}
		} else if (this.state === 'hostile') {
			// Move toward player and explode on contact or fuse end
			this._hostileTimer -= dt;
			const dx = p.x - this.x, dy = p.y - this.y; const d = Math.hypot(dx, dy) || 1;
			
			// Add breathing room: stop movement if within collision distance
			const breathingRoom = 30;
			const minDist = this.radius + (p.radius || 20) + breathingRoom;
			
			if (d > minDist) {
				const ux = dx / d, uy = dy / d;
				// Catch-up speed: exceed player speed while hostile
				let base = this.speed + 0; // default baseline
				try {
					const playerSpeed = Math.max(0, p?.speed || 0);
					const mul = (typeof this.hostileCatchupMultiplier === 'number' && this.hostileCatchupMultiplier > 0) ? this.hostileCatchupMultiplier : 1.2;
					const minBonus = (typeof this.hostileMinSpeedBonus === 'number') ? this.hostileMinSpeedBonus : 60;
					base = Math.max(base, playerSpeed * mul, playerSpeed + minBonus);
				} catch(_) {}
				const step = Math.min(base * dt, d - minDist);
				if (environment && typeof environment.resolveCircleMove === 'function') { const r = environment.resolveCircleMove(this.x, this.y, this.radius, ux * step, uy * step); this.x = r.x; this.y = r.y; } else { this.x += ux * step; this.y += uy * step; }
			}
			// Always enforce a fuse delay before exploding, even on contact
			if (this._hostileTimer <= 0) {
				this.explode('#ff7a3b');
			}
		} else if (this.state === 'run_to_boss') {
				// Find boss and run to it; explode on impact
				let boss = null;
				try { if (window.enemies && Array.isArray(window.enemies.items)) { for (let i = 0; i < enemies.items.length; i++) { const e = enemies.items[i]; if (e && e.alive && window.ArtilleryWitch && (e instanceof window.ArtilleryWitch)) { boss = e; break; } } } } catch(_) {}
				if (!boss) return;
				const dx = boss.x - this.x, dy = boss.y - this.y; const d = Math.hypot(dx, dy) || 1;
				const ux = dx / d, uy = dy / d; const step = (this.speed + 40) * dt;
				const prevX = this.x, prevY = this.y;
				if (environment && typeof environment.resolveCircleMove === 'function') { const r = environment.resolveCircleMove(this.x, this.y, this.radius, ux * step, uy * step); this.x = r.x; this.y = r.y; } else { this.x += ux * step; this.y += uy * step; }
				// Stuck detection: if hardly moved while attempting to advance, accumulate time
				try {
					const moved = Math.hypot(this.x - prevX, this.y - prevY);
					if (moved < 1) this._stuckTime += dt; else this._stuckTime = 0;
					if (this._stuckTime > 3.0) {
						// Been stuck for 3s => teleport near boss but not on top
						const tpDist = 100 + Math.random() * 50;
						const ang = Math.random() * Math.PI * 2;
						this.x = boss.x + Math.cos(ang) * tpDist;
						this.y = boss.y + Math.sin(ang) * tpDist;
						this._stuckTime = 0;
					}
				} catch(_) {}
				// Detect contact range: allow breathing room before explode
				const bossR = boss.radius || 50;
				const overlapDist = this.radius + bossR + 8;
				if (d <= overlapDist) {
					this.explode('#ffb076', boss);
				}
					}
				} catch(_) {}
	}

	_tryAttackNearby() {
		try {
			if (this._attackCooldown > 0) return;
			const pool = window.enemies;
			if (!pool || (!Array.isArray(pool.items) && typeof pool.queryCircle !== 'function')) return;
			const range = this.attackRange || 200;
			const candidates = (typeof pool.queryCircle === 'function') ? pool.queryCircle(this.x, this.y, range + 20) : pool.items;
			let closest = null, minD = Infinity;
			for (let i = 0; i < candidates.length; i++) {
				const e = candidates[i];
				if (!e || !e.alive) continue;
				const dx = e.x - this.x, dy = e.y - this.y; const dist = Math.hypot(dx, dy);
				if (dist <= range && dist < minD) { minD = dist; closest = e; }
			}
			if (!closest) return;
			const p = window.player;
			if (!p) return;
			const weapons = (window.projectiles && window.projectiles.weapons) ? window.projectiles.weapons : [];
			if (!weapons[0]) return;
			const w = weapons[0];
			const dx = closest.x - this.x, dy = closest.y - this.y; const ang = Math.atan2(dy, dx);
			const count = w.projectileCount || 1;
			const spread = (w.spread != null) ? w.spread : 0;
			const spd = w.projectileSpeed || 600;
			const color = w.color || '#ffb076';
			const life = w.projectileLifeTime || 3.0;
			const r = w.projectileRadius || 6;
			const maxRange = w.range || 9999;
			const dmg = (typeof w.damage === 'function') ? w.damage(p, 0) : (w.damage || 20);
			for (let i = 0; i < count; i++) {
				let bulletAng = ang;
				if (count > 1) {
					const spreadAng = spread * ((i / (count - 1)) - 0.5);
					bulletAng += spreadAng;
				}
				const vx = Math.cos(bulletAng) * spd;
				const vy = Math.sin(bulletAng) * spd;
				const spawnDist = (this.radius || 24) + r + 2;
				const bx = this.x + Math.cos(bulletAng) * spawnDist;
				const by = this.y + Math.sin(bulletAng) * spawnDist;
				if (window.Bullet && window.projectiles) {
					const options = { damage: dmg, owner: this, maxRange: maxRange };
					const bullet = new window.Bullet(bx, by, vx, vy, r, color, life, bulletAng, false, options);
					window.projectiles.items.push(bullet);
				}
			}
			this._attackCooldown = w.cooldown || 0.5;
		} catch(_) {}
	}

	switchState(next) {
		this.state = next;
		this._applyBarksForState(next);
		if (next === 'betrayed') {
			this._betrayedTimer = this.betrayedDelaySeconds || 3.0;
		} else if (next === 'hostile') {
			this._hostileTimer = this.hostileDelaySeconds || 4.0;
		}
	}

	explode(color, target) {
		if (!this.alive) return;
		try {
			if (window.projectiles && window.ExplosionVfx) {
				const opts = { scale: 1.5, shockColor: color, sparkColor: color, flashColor: color };
				window.projectiles.impacts.push(new window.ExplosionVfx(this.x, this.y, color, opts));
			}
			// Optional damage to target if provided (e.g., boss damage on contact)
			try {
				if (target && typeof target.applyDamage === 'function') {
					const dmg = 50;
					target.applyDamage(dmg, { x: this.x, y: this.y, dirX: 0, dirY: 0 });
								}
							} catch(_) {}
				} catch(_) {}
			this.alive = false;
	}

	draw(ctx, camera) {
		super.draw(ctx, camera);
		if (!this.carryingBomb) return;
		// Draw an airplane-style bomb on the NPC's back
		try {
			const sx = this.x - camera.x;
			const sy = this.y - camera.y;
			const bob = Math.sin((this._t || 0) * 2.2) * 1.2;
			// Anchor to the right side of the NPC (held off to the side), not rotating with facing
			const sideOffset = (this.radius || 24) + 8;
			const ax = sx + sideOffset;
			const ay = sy + bob;
			ctx.save();
			ctx.translate(ax, ay);
			// Fixed orientation: vertical (tail up, tip down)
			ctx.rotate(Math.PI / 2);
			// Atomic-bomb-like body: football (prolate) + square tail cage
			const bodyLen = 36;
			const bodyWid = 18;
			const rx = bodyLen * 0.5;
			const ry = bodyWid * 0.5;
			// Solid body color
			ctx.fillStyle = '#6f7682';
			ctx.strokeStyle = '#000000';
			ctx.lineWidth = 2;
			ctx.beginPath();
			ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
			ctx.fill();
			ctx.stroke();
			// Square tail cage (iconic nuke tail)
			const cageSize = 14;
			const cageX = -rx - 6;
			ctx.fillStyle = '#3b4049';
			ctx.strokeStyle = '#000000';
			ctx.lineWidth = 2;
			// Outer square frame
			ctx.beginPath();
			ctx.rect(cageX - cageSize * 0.5, -cageSize * 0.5, cageSize, cageSize);
			ctx.fill();
			ctx.stroke();
			// Inner grid (square shapes)
			ctx.strokeStyle = '#22252b';
			ctx.lineWidth = 2;
			ctx.beginPath();
			// vertical bar
			ctx.moveTo(cageX, -cageSize * 0.5);
			ctx.lineTo(cageX, cageSize * 0.5);
			// horizontal bar
			ctx.moveTo(cageX - cageSize * 0.5, 0);
			ctx.lineTo(cageX + cageSize * 0.5, 0);
			ctx.stroke();
			// Rear-most square plate
			ctx.fillStyle = '#2e333a';
			ctx.strokeStyle = '#000000';
			ctx.lineWidth = 2;
			ctx.beginPath();
			ctx.rect(cageX - cageSize * 0.5 - 5, -cageSize * 0.5 - 2, cageSize - 2, cageSize + 4);
			ctx.fill();
			ctx.stroke();
			ctx.restore();
		} catch(_) {}
	}
}

// Add NPC_B: a simple maroon-colored NPC with idle state and barks support
class NPC_B extends NPC {
    constructor(x, y) {
        super(x, y);
        this.color = '#800000'; // maroon
        this.name = 'NPC_B';
        this.state = 'idle';
        // Remember spawn to allow reset when player flees too far
        this._spawnX = x;
        this._spawnY = y;
        // Hostile combat stats (activated on state change)
        this.healthMax = 0;
        this.health = 0;
        this._showHealthBar = false;
        this._w4Cooldown = 0; // seconds between weapon-4 cone bursts
        // Hostile movement/behavior
        this.chargeSpeed = 210;
        this.evadeSpeed = 150;
        this._hostilePhase = 'charge'; // 'charge' | 'evade'
        this._hostilePhaseTimer = 0;
        this._attackWindowTimer = 0; // burst timer: fire while > 0
        this._attackRestTimer = 0;   // gap timer between bursts
        this._burstState = 'rest';   // 'burst' | 'rest'
        this._evadeDir = (Math.random() < 0.5 ? -1 : 1); // strafe direction during evade
        // Hostile pre-attack announce (bark + delay)
        this._preHostileTimer = 0;
        this._didHostileAnnounce = false;
        // Basic movement/behavior similar to base NPC (idle only)
        // Bark configuration loaded from JSON (optional)
        this._barkConfig = null;
        // Default barks until JSON loads
        this._bark.lines = ['Greetings.', 'A fair day for a walk.', 'Stay vigilant.'];
        this._bark.interval = 3.0;
        // DOT (Damage Over Time) tracking for visual indicator
        this.dotStacks = [];
        // Fire VFX animation time (matches Enemy behavior)
        this._fxTime = 0;
        this._loadBarksOnce();
    }

    async _loadBarksOnce() {
        try {
            if (!window.DialogueLoader) return;
            const loader = (window.dialogueLoader instanceof window.DialogueLoader)
                ? window.dialogueLoader
                : new window.DialogueLoader('dialogue');
            const data = await loader.load(this.name, 'barks');
            if (data && data.barks) {
                this._barkConfig = data.barks;
                this._applyBarksForState(this.state);
            }
        } catch(_) {}
    }

    _applyBarksForState(stateKey) {
        try {
            if (!this._bark || !this._barkConfig) return;
            const cfg = this._barkConfig[stateKey] || this._barkConfig['default'];
            if (!cfg) return;
            this._bark.lines = Array.isArray(cfg.lines) ? cfg.lines.slice() : [];
            if (typeof cfg.interval === 'number' && cfg.interval > 0) this._bark.interval = cfg.interval;
            if (typeof cfg.gap === 'number' && cfg.gap >= 0) this._bark.gap = cfg.gap;
            this._bark.idx = 0; this._bark.timer = Math.max(0.5, this._bark.interval || 2.5); this._bark.phase = 'show'; this._bark.fade = 0; this._bark.visible = true;
        } catch(_) {}
    }

    switchState(next) {
        // Allow debug label to reflect any arbitrary state
        this.state = next;
        // On hostile: initialize combat stats and visuals
        if (next === 'hostile') {
            this.healthMax = 1000;
            this.health = this.healthMax;
            this._showHealthBar = true;
            // Phase machine init
            this._hostilePhase = 'charge';
            this._hostilePhaseTimer = 1.2 + Math.random() * 0.8; // 1.2..2.0s
            // Start with a pre-attack announce delay; no firing during this window
            this._preHostileTimer = 1.5;
            this._didHostileAnnounce = false;
            // Burst/rest state: start in rest for first delay
            this._burstState = 'rest';
            this._attackRestTimer = this._preHostileTimer;
            // Weapon cooldown reset
            this._w4Cooldown = 0;
            // Apply barks specific to hostile state
            this._applyBarksForState('hostile');
        } else {
            // Apply barks for other states
            this._applyBarksForState(next);
        }
    }

    _fireWeapon4ConeAtPlayer() {
        try {
            const p = window.player; if (!p) return;
            if (!window.projectiles || !window.Bullet) return;
            const weapons = window.projectiles.weapons || [];
            const w4 = weapons[3];
            if (!w4) return;
            const dx = p.x - this.x, dy = p.y - this.y; const ang = Math.atan2(dy, dx);
            const dirX = Math.cos(ang), dirY = Math.sin(ang);
            const spawnX = this.x + dirX * 32;
            const spawnY = this.y + dirY * 32;
            const vx = dirX * (w4.projectileSpeed || 600);
            const vy = dirY * (w4.projectileSpeed || 600);
            // Build cone options similar to weapon 4
            const options = { isCone: true, owner: this, sourceWeaponIndex: 3 };
            let baseRange = ((w4.projectileRadius != null ? w4.projectileRadius : 6) * 3) * 5;
            let baseHalf = 0.2;
            const lengthVariation = 0.20; const widthVariation = 0.20;
            const rangeMul = (1 - lengthVariation) + Math.random() * (2 * lengthVariation);
            const halfMul = (1 - widthVariation) + Math.random() * (2 * widthVariation);
            options.coneRange = baseRange * rangeMul;
            options.coneHalf = baseHalf * halfMul;
            // Randomized life like weapon 4
            const life = (0.3 + Math.random() * 0.3) * 1.25;
            window.projectiles.items.push(new window.Bullet(spawnX, spawnY, vx, vy, (w4.projectileRadius || 6), (w4.color || '#ffb076'), life, ang, false, options));
        } catch(_) {}
    }

    update(dt, environment) {
        super.update(dt, environment);
        // Advance VFX time for flame animation (matches Enemy behavior)
        if (this.alive) this._fxTime = (this._fxTime || 0) + dt;
        // Tick DOT stacks (visual-only countdown)
        this._tickDot(dt);
        try {
            // Give-up logic: if NPC_B is more than 3000 units from its spawn, return and reset
            try {
                if (this.state !== 'idle') {
                    const dxs = this.x - this._spawnX;
                    const dys = this.y - this._spawnY;
                    if (dxs*dxs + dys*dys > 3000*3000) {
                        // Only teleport back if NPC_B is off-screen; otherwise keep chasing
                        let onScreen = true;
                        try {
                            const cam = window.getCamera && window.getCamera();
                            if (cam) {
                                const left = cam.x, right = cam.x + cam.width;
                                const top = cam.y, bottom = cam.y + cam.height;
                                const r = this.radius || 24;
                                const l = this.x - r, t = this.y - r, rr = this.x + r, b = this.y + r;
                                onScreen = !(rr < left || l > right || b < top || t > bottom);
                            }
                        } catch(_) {}
                        if (!onScreen) { this._returnToSpawn(); return; }
                    }
                }
            } catch(_) {}
            if (this.state === 'hostile') {
                const p = window.player; if (!p) return;
                // Pre-attack delay: do not fire until this elapses
                if (this._preHostileTimer > 0) {
                    this._preHostileTimer -= dt;
                    if (this._preHostileTimer <= 0) {
                        // Begin first burst after announce
                        this._burstState = 'burst';
                        this._attackWindowTimer = 2.0 + Math.random() * 5.0; // 2..7s
                        this._w4Cooldown = 0.02;
                        this._didHostileAnnounce = true;
                    }
                }
                // Phase timers
                if (this._hostilePhaseTimer > 0) this._hostilePhaseTimer -= dt;
                if (this._attackWindowTimer > 0) this._attackWindowTimer -= dt;
                // Movement toward/around player
                const dx = p.x - this.x, dy = p.y - this.y; const d = Math.hypot(dx, dy) || 1;
                const ux = dx / d, uy = dy / d;
                let vx = 0, vy = 0;
                if (this._hostilePhase === 'charge') {
                    // Aggressive charge straight at player
                    const spd = this.chargeSpeed;
                    vx = ux * spd * dt; vy = uy * spd * dt;
                    // When close enough or timer expires, switch to evade
                    if (d < 140 || this._hostilePhaseTimer <= 0) {
                        this._hostilePhase = 'evade';
                        this._hostilePhaseTimer = 1.0 + Math.random() * 1.2; // 1..2.2s
                        this._evadeDir = (Math.random() < 0.5 ? -1 : 1);
                        this._w4Cooldown = 0.01;
                    }
                } else {
                    // Evasive strafe around player with slight outward bias
                    const perpX = -uy * this._evadeDir;
                    const perpY = ux * this._evadeDir;
                    // Maintain comfortable distance: push outward if too close
                    let outX = 0, outY = 0;
                    if (d < 220) { outX = -ux; outY = -uy; }
                    const spd = this.evadeSpeed;
                    const mixX = perpX * 0.8 + outX * 0.6;
                    const mixY = perpY * 0.8 + outY * 0.6;
                    const norm = Math.hypot(mixX, mixY) || 1;
                    vx = (mixX / norm) * spd * dt; vy = (mixY / norm) * spd * dt;
                    // Swap back to charge after timer
                    if (this._hostilePhaseTimer <= 0) {
                        this._hostilePhase = 'charge';
                        this._hostilePhaseTimer = 1.1 + Math.random() * 1.5;
                        this._w4Cooldown = 0.01;
                    }
                }
                if (environment && typeof environment.resolveCircleMove === 'function') {
                    const res = environment.resolveCircleMove(this.x, this.y, this.radius, vx, vy);
                    this.x = res.x; this.y = res.y;
                } else { this.x += vx; this.y += vy; }

                // Firing bursts with explicit rest gaps
                if (this._preHostileTimer <= 0 && this._burstState === 'burst') {
                    this._attackWindowTimer -= dt;
                    if (this._w4Cooldown > 0) this._w4Cooldown -= dt;
                    if (this._w4Cooldown <= 0) {
                        this._fireWeapon4ConeAtPlayer();
                        // Faster rate during bursts
                        this._w4Cooldown = 0.09 + Math.random() * 0.05;
                    }
                    if (this._attackWindowTimer <= 0) {
                        // Transition to rest gap
                        this._burstState = 'rest';
                        this._attackRestTimer = 1.0 + Math.random() * 2.0; // 1..3s rest
                    }
                } else {
                    // Resting: no fire
                    if (this._attackRestTimer > 0) this._attackRestTimer -= dt;
                    if (this._attackRestTimer <= 0) {
                        // Start a new burst
                        this._burstState = 'burst';
                        this._attackWindowTimer = 2.0 + Math.random() * 5.0; // 2..7s
                        this._w4Cooldown = 0.02;
                    }
                }
            }
        } catch(_) {}
    }

    _returnToSpawn() {
        try {
            this.x = this._spawnX;
            this.y = this._spawnY;
            // Reset combat/visual state
            this.state = 'idle';
            this.healthMax = 0;
            this.health = 0;
            this._showHealthBar = false;
            this._w4Cooldown = 0;
            this._hostilePhase = 'charge';
            this._hostilePhaseTimer = 0;
            this._burstState = 'rest';
            this._attackWindowTimer = 0;
            this._attackRestTimer = 0;
            this._preHostileTimer = 0;
            // Restore idle barks if available
            this._applyBarksForState('idle');
        } catch(_) {}
    }

    draw(ctx, camera) {
        // Call parent draw to render body, exclamation point, debug label, and barks
        super.draw(ctx, camera);
        
        if (!this.alive) return;
        
        // Safety checks for position and radius
        if (!Number.isFinite(this.x) || !Number.isFinite(this.y) || !Number.isFinite(this.radius) || this.radius <= 0) {
            console.warn('[NPC_B] Invalid position or radius', this.x, this.y, this.radius);
            return;
        }
        
        if (!Number.isFinite(camera.x) || !Number.isFinite(camera.y)) {
            console.warn('[NPC_B] Invalid camera position', camera.x, camera.y);
            return;
        }
        
        const sx = this.x - camera.x;
        const sy = this.y - camera.y;
        
        // Final safety check on screen coordinates
        if (!Number.isFinite(sx) || !Number.isFinite(sy)) {
            console.warn('[NPC_B] Invalid screen coordinates', sx, sy);
            return;
        }
        
        // Fire VFX for active DOT stacks (weapon 4): single cohesive, animated flame with light sparks + smoke
        if (this.dotStacks && this.dotStacks.length > 0) {
            try {
                ctx.save();
                const stacks = this.dotStacks.length;
                const intensity = Math.min(1.2, stacks / 4); // stronger scale
                // Base flame gradient (yellow/white core to orange outer)
                const baseR = this.radius * (1.0 + 0.8 * intensity);
                const t = this._fxTime || 0;
                const wobble = Math.sin(t * 6) * 0.12;
                const sx0 = sx + wobble * this.radius * 0.3;
                
                // Calculate sy0 with safety checks
                const idVal = Number.isFinite(this.id) ? this.id : 0;
                const sinVal = Math.sin(t * 4 + idVal);
                const sy0 = sy - this.radius * (0.25 + 0.1 * sinVal);
                
                // Safety check before creating gradient
                if (!Number.isFinite(sx0) || !Number.isFinite(sy0) || !Number.isFinite(baseR) || baseR <= 0) {
                    console.warn('[NPC_B] Invalid gradient values', { sx0, sy0, baseR, t, wobble, id: this.id, sx, sy, radius: this.radius, sinVal });
                    ctx.restore();
                    return;
                }
                
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
                const smokeR = this.radius * (0.5 + 0.2 * Math.sin(t * 2 + idVal));
                ctx.beginPath();
                ctx.ellipse(sx0, sy0 - baseR * 0.9, smokeR * 0.8, smokeR * 0.5, 0, 0, Math.PI * 2);
                ctx.fill();
                ctx.restore();
            } catch(e) {
                console.error('[NPC_B] Fire VFX error:', e);
                try { ctx.restore(); } catch(_) {}
            }
        }
        
        // Health bar (when hostile) - matching Enemy structure
        if (this._showHealthBar && this.healthMax > 0) {
            const barWidth = 60;
            const barHeight = 6;
            const x = sx - barWidth / 2;
            const y = sy - this.radius - 12;
            ctx.fillStyle = 'rgba(255,255,255,0.12)';
            ctx.fillRect(x, y, barWidth, barHeight);
            ctx.fillStyle = '#ff5a5a';
            ctx.fillRect(x, y, barWidth * (this.health / this.healthMax), barHeight);
            ctx.strokeStyle = 'rgba(0,0,0,0.6)';
            ctx.lineWidth = 2;
            ctx.strokeRect(x + 0.5, y + 0.5, barWidth, barHeight);
        }
    }

    applyDamage(amount) {
        try {
            if (!this.alive) return;
            if (!Number.isFinite(amount) || amount <= 0) return;
            // Only meaningful when hostile and health pool is active
            if (this.state !== 'hostile' || this.healthMax <= 0) return;
            this.health -= amount;
            if (this.health <= 0) {
                this.health = 0;
                this.alive = false;
                // Small death feedback
                try { if (window.projectiles && window.ExplosionVfx) window.projectiles.impacts.push(new window.ExplosionVfx(this.x, this.y, '#ff7a3b', { scale: 1.2 })); } catch(_) {}
                // Drop 4 random Epic/Legendary (purple/orange) hex stats on death
                try {
                    const HexStat = (window.GameObjects && window.GameObjects.HexStat) ? window.GameObjects.HexStat : null;
                    if (HexStat) {
                        const labels = ['+MovSpd', '+AtkSpd', '+AtkPwr', '+Armor', '+HP', '+Stm', '+CritChan', '+CritDmg'];
                        const pickRarity = () => {
                            const r = (typeof WorldRNG !== 'undefined' && WorldRNG.random) ? WorldRNG.random() : Math.random();
                            return (r < 0.5)
                                ? { name: 'Epic', color: '#b26aff' }
                                : { name: 'Legendary', color: '#ffa64d' };
                        };
                        const count = 4;
                        for (let i = 0; i < count; i++) {
                            const idx = (typeof WorldRNG !== 'undefined' && WorldRNG.randomInt)
                                ? WorldRNG.randomInt(0, labels.length - 1)
                                : Math.floor(Math.random() * labels.length);
                            const lab = labels[idx];
                            const rarity = pickRarity();
                            const color = rarity.color;
                            const ang = (typeof WorldRNG !== 'undefined' && WorldRNG.randomFloat)
                                ? WorldRNG.randomFloat(0, Math.PI * 2)
                                : Math.random() * Math.PI * 2;
                            const spd = 180 + ((typeof WorldRNG !== 'undefined' && WorldRNG.randomFloat) ? WorldRNG.randomFloat(0, 80) : Math.random() * 80);
                            const vx = Math.cos(ang) * spd;
                            const vy = Math.sin(ang) * spd;
                            const drop = new HexStat(this.x, this.y, vx, vy, { label: lab, fill: color, rarity });
                            try { if (typeof window.placeDroppedItemInWorld === 'function') window.placeDroppedItemInWorld(drop); else { if (!Array.isArray(window.bossDrops)) window.bossDrops = []; window.bossDrops.push(drop); } } catch(_) {}
                        }
                    }
                } catch(_) {}
            }
        } catch(_) {}
    }

    // Apply a DOT stack (visual-only in multiplayer for fire VFX)
    applyDot(dps, durationSec, ownerOrOptions) {
        if (!this.alive) return;
        if (this.state !== 'hostile' || this.healthMax <= 0) return;
        if (!Number.isFinite(dps) || dps <= 0) return;
        if (!Number.isFinite(durationSec) || durationSec <= 0) return;
        
        // Send DOT to server for authoritative damage (multiplayer-only game)
        if (window.networkManager?.connected && this._serverId) {
            window.networkManager.sendNPCDot(this._serverId, dps, durationSec);
            // Add a visual-only stack locally for fire VFX
            this.dotStacks.push({ dps, timeLeft: durationSec, visualOnly: true });
            return;
        }
        
        // Single-player: not implemented (server handles all NPC combat in multiplayer)
    }

    // Tick DOT stacks (visual-only in multiplayer, just counts down timers)
    _tickDot(dt) {
        if (!this.alive) return;
        if (!this.dotStacks || this.dotStacks.length === 0) return;
        
        // Just tick down timers and remove expired stacks (visual only, no damage)
        for (let i = this.dotStacks.length - 1; i >= 0; i--) {
            const s = this.dotStacks[i];
            s.timeLeft -= dt;
            if (s.timeLeft <= 0) {
                this.dotStacks.splice(i, 1);
            }
        }
    }
}

window.NPC_B = NPC_B;



// Commander NPC: dark red officer who provides guidance and opens a dialogue tree
class Commander extends NPC {
    constructor(x, y) {
        super(x, y);
        this.color = '#8b0000'; // dark red
        this.name = 'Commander';
        this.state = 'idle';
        this.showExclamation = true;
        // Talkable in lobby
        this._disableTalk = false;
        // Default barks until JSON loads
        this._bark.lines = [
            'Find the Artillery Witch and end her barrage.',
            'Eyes open: a heretic priest was sighted nearby.',
            'An ecclesiastic prisoner is missing—failed his charge.'
        ];
        this._bark.interval = 3.0;
        this._loadBarksOnce();
    }

    async _loadBarksOnce() {
        try {
            if (!window.DialogueLoader) return;
            const loader = (window.dialogueLoader instanceof window.DialogueLoader)
                ? window.dialogueLoader
                : new window.DialogueLoader('dialogue');
            const data = await loader.load(this.name, 'barks');
            if (data && data.barks) {
                this._barkConfig = data.barks;
                this._applyBarksForState(this.state);
            }
        } catch(_) {}
    }

    _applyBarksForState(stateKey) {
        try {
            if (!this._bark || !this._barkConfig) return;
            const cfg = this._barkConfig[stateKey] || this._barkConfig['default'];
            if (!cfg) return;
            this._bark.lines = Array.isArray(cfg.lines) ? cfg.lines.slice() : [];
            if (typeof cfg.interval === 'number' && cfg.interval > 0) this._bark.interval = cfg.interval;
            if (typeof cfg.gap === 'number' && cfg.gap >= 0) this._bark.gap = cfg.gap;
            this._bark.idx = 0; this._bark.timer = Math.max(0.5, this._bark.interval || 2.5); this._bark.phase = 'show'; this._bark.fade = 0; this._bark.visible = true;
        } catch(_) {}
    }
}

window.Commander = Commander;

// Quartermaster NPC: supplies and requisitions (dialogue grants loot + currency via server)
class Quartermaster extends NPC {
	constructor(x, y) {
		super(x, y);
		this.color = '#6b5b3a'; // khaki/brown
		this.outline = '#000000';
		this.name = 'Quartermaster';
		this.state = 'idle';
		this.showExclamation = true;
		// Talkable in lobby
		this._disableTalk = false;
		// Slightly larger talk range so it's easy to interact near sandbags
		this.talkRangeBoost = 20;
		// Default barks until JSON loads
		this._bark.lines = [
			'Requisitions are rationed. Don’t waste them.',
			'White-grade stock. Better than nothing.',
			'Bring blood markers if you want favors.'
		];
		this._bark.interval = 3.2;
		this._loadBarksOnce();
	}

	async _loadBarksOnce() {
		try {
			if (!window.DialogueLoader) return;
			const loader = (window.dialogueLoader instanceof window.DialogueLoader)
				? window.dialogueLoader
				: new window.DialogueLoader('dialogue');
			const data = await loader.load(this.name, 'barks');
			if (data && data.barks) {
				this._barkConfig = data.barks;
				this._applyBarksForState(this.state);
			}
		} catch(_) {}
	}

	_applyBarksForState(stateKey) {
		try {
			if (!this._bark || !this._barkConfig) return;
			const cfg = this._barkConfig[stateKey] || this._barkConfig['default'];
			if (!cfg) return;
			this._bark.lines = Array.isArray(cfg.lines) ? cfg.lines.slice() : [];
			if (typeof cfg.interval === 'number' && cfg.interval > 0) this._bark.interval = cfg.interval;
			if (typeof cfg.gap === 'number' && cfg.gap >= 0) this._bark.gap = cfg.gap;
			this._bark.idx = 0; this._bark.timer = Math.max(0.5, this._bark.interval || 2.5); this._bark.phase = 'show'; this._bark.fade = 0; this._bark.visible = true;
		} catch(_) {}
	}
}

window.Quartermaster = Quartermaster;

class Merchant extends NPC {
	constructor(x, y) {
		super(x, y);
		this.color = '#2e8b57'; // sea green
		this.name = 'Merchant';
		this.state = 'idle';
		this.showExclamation = true;
		// Talkable in lobby
		this._disableTalk = false;
		// Default barks until JSON loads
		this._bark.lines = [
			'Got somethin\' you might like. Come and see.',
			'Best prices in town—I promise.',
			'Always restocking. Check back later!'
		];
		this._bark.interval = 3.5;
		this._loadBarksOnce();
	}

	async _loadBarksOnce() {
		try {
			if (!window.DialogueLoader) return;
			const loader = (window.dialogueLoader instanceof window.DialogueLoader)
				? window.dialogueLoader
				: new window.DialogueLoader('dialogue');
			const data = await loader.load(this.name, 'barks');
			if (data && data.barks) {
				this._barkConfig = data.barks;
				this._applyBarksForState(this.state);
			}
		} catch(_) {}
	}

	_applyBarksForState(stateKey) {
		try {
			if (!this._bark || !this._barkConfig) return;
			const cfg = this._barkConfig[stateKey] || this._barkConfig['default'];
			if (!cfg) return;
			this._bark.lines = Array.isArray(cfg.lines) ? cfg.lines.slice() : [];
			if (typeof cfg.interval === 'number' && cfg.interval > 0) this._bark.interval = cfg.interval;
			if (typeof cfg.gap === 'number' && cfg.gap >= 0) this._bark.gap = cfg.gap;
			this._bark.idx = 0; this._bark.timer = Math.max(0.5, this._bark.interval || 2.5); this._bark.phase = 'show'; this._bark.fade = 0; this._bark.visible = true;
		} catch(_) {}
	}
}

window.Merchant = Merchant;

class NPCs {
	constructor() {
		this.items = [];
	}

	add(npc) {
		if (npc) this.items.push(npc);
	}

	update(dt, environment) {
		for (let i = this.items.length - 1; i >= 0; i--) {
			const n = this.items[i];
			if (!n || !n.alive) { this.items.splice(i, 1); continue; }
			if (typeof n.update === 'function') n.update(dt, environment);
		}
	}

	draw(ctx, camera, viewport) {
		// Use centralized cullBounds if provided, otherwise calculate (fallback for compatibility)
		const bounds = viewport.cullBounds || {
			left: camera.x - viewport.width / 2 - 200,
			right: camera.x + viewport.width / 2 + 200,
			top: camera.y - viewport.height / 2 - 200,
			bottom: camera.y + viewport.height / 2 + 200
		};
		
		for (let i = 0; i < this.items.length; i++) {
			const n = this.items[i];
			if (!n || !n.alive) continue;
			const l = n.x - n.radius, r = n.x + n.radius, t = n.y - n.radius, b = n.y + n.radius;
			if (r < bounds.left || l > bounds.right || b < bounds.top || t > bounds.bottom) continue;
			n.draw(ctx, camera);
		}
	}
}

// Ambient lobby NPCs: bark occasionally; not interactable
class NPC_Lobby extends NPC {
	constructor(x, y) {
		super(x, y);
		this.name = 'NPC_Lobby';
		this.state = 'idle';
		this.showExclamation = false;
		this._disableTalk = true;
		// Muted color variations for crowd variety
		const palette = ['#6e7380', '#7a6f64', '#4d5968', '#5c6b52', '#7a5f5f'];
		this.color = palette[Math.floor(Math.random() * palette.length)];
		// Default barks until JSON loads
		this._bark.lines = ['Keep your head low.', 'Supplies run thin.', 'God watch over us.'];
		// Randomized timing ranges per NPC for natural desync
		this._bark.intervalMin = 3 + Math.random() * 6; // 3..9
		this._bark.intervalMax = this._bark.intervalMin + 3 + Math.random() * 6; // +3..+9 => up to 15
		this._bark.gapMin = 1 + Math.random() * 4; // 1..5
		this._bark.gapMax = this._bark.gapMin + 1 + Math.random() * 5; // +1..+6
		// Seed an initial timer from the ranges
		this._bark.timer = this._bark.intervalMin + Math.random() * (this._bark.intervalMax - this._bark.intervalMin);
		this._loadBarksOnce();
	}

	async _loadBarksOnce() {
		try {
			if (!window.DialogueLoader) return;
			const loader = new window.DialogueLoader();
			const data = await loader.load('npc_Lobby', 'barks');
			if (data && data.barks) {
				const cfg = data.barks['default'] || data.barks['idle'];
				if (cfg && Array.isArray(cfg.lines) && cfg.lines.length > 0) {
					this._bark.lines = cfg.lines.slice();
					if (typeof cfg.interval === 'number' && cfg.interval > 0) this._bark.intervalMin = cfg.interval;
					if (typeof cfg.gap === 'number' && cfg.gap >= 0) this._bark.gapMin = cfg.gap;
					this._bark.intervalMax = this._bark.intervalMin + 3 + Math.random() * 6;
					this._bark.gapMax = this._bark.gapMin + 1 + Math.random() * 5;
					this._bark.timer = this._bark.intervalMin + Math.random() * (this._bark.intervalMax - this._bark.intervalMin);
				}
			}
		} catch(_) {}
	}
}

window.NPCs = NPCs;
window.NPC = NPC;
window.NPC_A = NPC_A;
window.NPC_Lobby = NPC_Lobby;
