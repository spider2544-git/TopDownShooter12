class ArtilleryWitch extends Enemy {
	constructor(x, y) {
		super(x, y);
		// Boss type identifier
		this.type = 'boss';
		// Boomer-sized boss
		this.radius = 32;
		// Boss-tier health
		this.healthMax = 2000;
		this.health = this.healthMax;
		// Slightly dark grey
		this.color = '#5c5c5c';
		this.outline = '#1a1a1a';
		this._bossLootDropped = false;
		// Artillery firing state
		this._artilleryTimer = 1.0 + Math.random() * 0.8; // initial delay
		this._artilleryCooldown = 1.25; // seconds between shots
		// Stay stationary; director respects speedMul in movement
		this.speedMul = 0;
		// Evasive dash state
		this._dashCooldown = 1.5 + Math.random();
		this._dashDistance = 360;
		this._dashDuration = 0.2;
		// Raise boss health bar higher so it isn't occluded by the sprite
		this.healthBarOffset = 50;
		// Wider health bar for boss readability
		this.healthBarWidth = 160;
	}

	applyDamage(amount, hit) {
		super.applyDamage(amount, hit);
		if (!this.alive && !this._bossLootDropped) {
			this._bossLootDropped = true;
			this._dropBossLoot();
		}
	}

	// Ensure loot always drops, including when killed by DOT
	onDeath(info) {
		if (!this._bossLootDropped) {
			this._bossLootDropped = true;
			this._dropBossLoot();
		}
		// After boss death: if NPC_A is off-screen, despawn and remove for this round
		try {
			const cam = (typeof window !== 'undefined' && typeof window.getCamera === 'function') ? window.getCamera() : null;
			const pool = (typeof window !== 'undefined' && window.npcs && Array.isArray(window.npcs.items)) ? window.npcs.items : null;
			if (cam && pool) {
				for (let i = pool.length - 1; i >= 0; i--) {
					const n = pool[i];
					if (!n || !n.alive) continue;
					if (n.name === 'NPC_A') {
						const r = n.radius || 24;
						const left = cam.x, right = cam.x + cam.width;
						const top = cam.y, bottom = cam.y + cam.height;
						const l = n.x - r, t = n.y - r, rr = n.x + r, b = n.y + r;
						const onScreen = !(rr < left || l > right || b < top || t > bottom);
						if (!onScreen) {
							// Mark dead; NPCs.update will clean it up from the list
							n.alive = false;
							// Clear talk hint if pointing to this NPC
							try { if (window.state && window.state.talkHintNpcId === n.id) window.state.talkHintNpcId = null; } catch(_) {}
						}
					}
				}
			}
		} catch(_) {}
	}

	_dropBossLoot() {
		// Server handles boss loot generation (multiplayer-only game)
		if (window.networkManager?.connected) {
			console.log('[Boss] Skipping client-side loot generation in multiplayer mode - server will handle');
			return;
		}
		
		// Single-player mode: generate loot locally
		try {
			const HexStat = (window.GameObjects && window.GameObjects.HexStat) ? window.GameObjects.HexStat : null;
			if (!HexStat) return;
			if (!Array.isArray(window.bossDrops)) window.bossDrops = [];
			const drops = window.bossDrops;
			const count = 10;
			const base = (typeof WorldRNG !== 'undefined' && WorldRNG.randomFloat)
				? WorldRNG.randomFloat(0, Math.PI * 2)
				: Math.random() * Math.PI * 2;
			// Non-overlapping ring placement
			const itemRadius = 12;
			const minArcSpacing = (itemRadius * 2 + 6); // 30px
			let ringR = Math.max(this.radius + 28, (minArcSpacing * count) / (2 * Math.PI) + 2);
			const ensureClear = (px, py) => {
				if (!window.environment) return true;
				try {
					if (typeof environment.isInsideBounds === 'function') {
						if (!environment.isInsideBounds(px, py, itemRadius)) return false;
					}
					if (typeof environment.circleHitsAny === 'function') {
						if (environment.circleHitsAny(px, py, itemRadius)) return false;
					}
				} catch(e) {}
				return true;
			};
			const rarities = [
				{ name: 'Epic', color: '#b26aff' }, // purple
				{ name: 'Legendary', color: '#ffa64d' } // orange
			];
			const labels = ['+MovSpd', '+AtkSpd', '+AtkPwr', '+Armor', '+HP', '+Stm', '+CritChan', '+CritDmg'];
			for (let i = 0; i < count; i++) {
				const ang = base + (i * (2 * Math.PI / count));
				// Find a clear spawn point along angle, nudging outward if needed
				let r = ringR;
				let sx = this.x + Math.cos(ang) * r;
				let sy = this.y + Math.sin(ang) * r;
				let tries = 0;
				while (!ensureClear(sx, sy) && tries < 12) {
					r += 12;
					sx = this.x + Math.cos(ang) * r;
					sy = this.y + Math.sin(ang) * r;
					tries++;
				}
				// Outward velocity so they separate more while dropping
				const spd = 170 + ((typeof WorldRNG !== 'undefined' && WorldRNG.randomFloat) ? WorldRNG.randomFloat(0, 60) : Math.random() * 60);
				const vx = Math.cos(ang) * spd;
				const vy = Math.sin(ang) * spd;
				// Epic or Legendary only
				const pick = ((typeof WorldRNG !== 'undefined' && WorldRNG.random) ? WorldRNG.random() : Math.random());
				const rarity = rarities[pick < 0.55 ? 0 : 1];
				const label = labels[i % labels.length];
				const h = new HexStat(sx, sy, vx, vy, { label, fill: rarity.color, rarity });
				drops.push(h);
			}
		} catch(e) {}
	}

	updateArtillery(dt) {
		try {
			if (!this.alive) return;
			// Initialize burst fields if missing
			if (this._burstMode == null) this._burstMode = false;
			if (this._burstShotTimer == null) this._burstShotTimer = 0;
			// Movement gate: move only when within 2000 units
			(function setMoveGate(self){
				try {
					const p = window.player;
					if (!p) { self.speedMul = 0; return; }
					const dx = p.x - self.x, dy = p.y - self.y;
					self.speedMul = ((dx * dx + dy * dy) <= 2000 * 2000) ? 1 : 0;
				} catch(_) { self.speedMul = 0; }
			})(this);
			// Evasive dash: occasionally dash directly away from the player when near
			this._dashCooldown -= dt;
			// Reactive dash: occasionally evade an imminent incoming projectile
			try {
				if (this._dashCooldown <= 0 && window.projectiles && Array.isArray(window.projectiles.items)) {
					let threateningBullet = null;
					const items = window.projectiles.items;
					const horizon = 0.45; // seconds to look ahead
					const safety = 10; // extra safety radius
					for (let i = 0; i < items.length; i++) {
						const b = items[i];
						if (!b || b.noDamage) continue;
						if (b.isCone) continue; // ignore cone shapes
						if (b.ignoreEnemies) continue; // explosive arcs that ignore enemies
						// Ignore enemy-owned bullets
						try { if (b.owner && window.Enemy && (b.owner instanceof window.Enemy)) continue; } catch(_) {}
						const rvx = b.vx || 0; const rvy = b.vy || 0;
						const v2 = rvx * rvx + rvy * rvy;
						if (v2 < 1) continue; // not moving
						// Relative position from boss to bullet origin (bullet minus boss)
						const rx = b.x - this.x; const ry = b.y - this.y;
						// Time of closest approach assuming boss stationary
						const tStar = - (rx * rvx + ry * rvy) / v2;
						if (tStar < 0 || tStar > horizon) continue;
						// Distance at closest approach
						const cx = rx + rvx * tStar; const cy = ry + rvy * tStar;
						const rHit = (this.radius || 32) + (b.radius || 6) + safety;
						if (cx * cx + cy * cy <= rHit * rHit) { threateningBullet = b; break; }
					}
					if (threateningBullet && Math.random() < 0.4) {
						// Dash perpendicular to bullet travel; bias away from player if possible
						const spd = Math.hypot(threateningBullet.vx || 0, threateningBullet.vy || 0) || 1;
						const uxv = (threateningBullet.vx || 0) / spd;
						const uyv = (threateningBullet.vy || 0) / spd;
						// Two perpendicular options
						const p1x = -uyv, p1y = uxv;
						const p2x = uyv,  p2y = -uxv;
						let pickx = p1x, picky = p1y;
						try {
							const p = window.player;
							if (p) {
								const pd = Math.hypot(this.x - p.x, this.y - p.y) || 1;
								const awayX = (this.x - p.x) / pd, awayY = (this.y - p.y) / pd;
								const d1 = p1x * awayX + p1y * awayY;
								const d2 = p2x * awayX + p2y * awayY;
								if (d2 > d1) { pickx = p2x; picky = p2y; }
							}
						} catch(_) {}
						this.applyKnockback(pickx, picky, this._dashDistance, this._dashDuration);
						// Longer cooldown after a successful reactive dash
						this._dashCooldown = 2.8 + Math.random() * 2.4;
					}
				}
			} catch(_) {}
			try {
				const p = window.player;
				if (p && this._dashCooldown <= 0) {
					const dx = p.x - this.x, dy = p.y - this.y;
					const d2 = dx * dx + dy * dy;
					if (d2 <= 1200 * 1200) {
						const d = Math.hypot(dx, dy) || 1;
						const ux = -dx / d; // away from player
						const uy = -dy / d;
						// Trigger dash using knockback system for collision-safe movement
						this.applyKnockback(ux, uy, this._dashDistance, this._dashDuration);
						// Next dash in 3-6 seconds
						this._dashCooldown = 3 + Math.random() * 3;
					}
				}
			} catch(_) {}
			this._artilleryTimer -= dt;
			if (this._burstMode) {
				this._burstTimer -= dt;
				this._burstShotTimer -= dt;
				const p = window.player;
				if (!p || p.health <= 0) { this._burstMode = false; this._artilleryTimer = 0.6; return; }
				// Range gate: only fire when within 1500
				const ddx = p.x - this.x, ddy = p.y - this.y;
				if ((ddx * ddx + ddy * ddy) > 1500 * 1500) { return; }
				if (this._burstShotTimer <= 0) {
					// Fire a strike around the player at a random ring position
					const ang = Math.random() * Math.PI * 2;
					const rad = 120 + Math.random() * 220;
					const tx = p.x + Math.cos(ang) * rad;
					const ty = p.y + Math.sin(ang) * rad;
					this._scheduleArtilleryStrike(tx, ty, 0.55);
					// Faster rate during burst
					this._burstShotTimer = 0.22 + (Math.random() * 0.06 - 0.03);
				}
				if (this._burstTimer <= 0) {
					this._burstMode = false;
					this._artilleryTimer = this._artilleryCooldown + (Math.random() * 0.4 - 0.2);
				}
				return;
			}
			if (this._artilleryTimer > 0) return;
			const p = window.player;
			if (!p || p.health <= 0) { this._artilleryTimer = 0.6; return; }
			// Range gate: only fire when within 1500
			{
				const dx = p.x - this.x, dy = p.y - this.y;
				if ((dx * dx + dy * dy) > 1500 * 1500) { this._artilleryTimer = 0.2; return; }
			}
			// Occasionally enter burst mode to vary patterns
			if (Math.random() < 0.25) {
				this._burstMode = true;
				this._burstTimer = 2.0;
				this._burstShotTimer = 0; // fire immediately
				return;
			}
			// Close-range alternate shot: Fast Ball (straight, 1.5x speed, 2x radius, explodes on impact)
			try {
				const dx = p.x - this.x, dy = p.y - this.y;
				const dist = Math.hypot(dx, dy) || 1;
				if (dist <= 800 && Math.random() < 0.45) {
					if (window.Bullet && window.projectiles) {
						const ux = dx / dist, uy = dy / dist;
						const fireAngle = Math.atan2(uy, ux);
						const spawnX = this.x + ux * (this.radius + 8);
						const spawnY = this.y + uy * (this.radius + 8);
						const projectileSpeed = 600 * 1.5; // 1.5x
						const projectileLife = 3.6;
						const projRadius = 6 * 2; // 2x size
						const color = '#ffa64d';
						const options = { owner: this, allowMidflightPlayerHit: true, deathYellowCircle: true, ignoreEnemies: true, ignoreEnvironment: true, maxTurnRate: 0, targetX: null, targetY: null };
						window.projectiles.items.push(new window.Bullet(spawnX, spawnY, Math.cos(fireAngle) * projectileSpeed, Math.sin(fireAngle) * projectileSpeed, projRadius, color, projectileLife, fireAngle, false, options));
						this._artilleryTimer = this._artilleryCooldown + (Math.random() * 0.3 - 0.15);
						return;
					}
				}
			} catch(_) {}
			// Single aimed strike at player's current position
			this._scheduleArtilleryStrike(p.x, p.y, 0.6);
			this._artilleryTimer = this._artilleryCooldown + (Math.random() * 0.4 - 0.2);
		} catch(_) {}
	}

	_scheduleArtilleryStrike(tx, ty, delay = 1.2) {
		try {
			if (!window.projectiles) return;
			const ringRadius = 100;
			const color = '#ffa64d'; // artillery orange
			// Telegraph ring that fades out; projectile handles the explosion on arrival
			const ring = {
				life: delay,
				totalLife: delay,
				cx: tx,
				cy: ty,
				update: function(dt) {
					this.life -= dt;
					if (this.life <= 0) { this.life = -1; }
				},
				draw: function(ctx, cam) {
					const sx = this.cx - cam.x;
					const sy = this.cy - cam.y;
					const t = Math.max(this.life, 0) / this.totalLife;
					const alpha = 0.6 * t;
					ctx.save();
					ctx.translate(sx, sy);
					// Outer glow
					try {
						const hex = color;
						const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
						const rr = m ? parseInt(m[1], 16) : 255;
						const gg = m ? parseInt(m[2], 16) : 170;
						const bb = m ? parseInt(m[3], 16) : 77;
						const glowR = ringRadius * 1.6;
						const grad = ctx.createRadialGradient(0, 0, ringRadius * 0.2, 0, 0, glowR);
						grad.addColorStop(0, 'rgba(' + rr + ',' + gg + ',' + bb + ',' + (0.18 * alpha) + ')');
						grad.addColorStop(1, 'rgba(' + rr + ',' + gg + ',' + bb + ',0)');
						ctx.fillStyle = grad;
						ctx.beginPath();
						ctx.arc(0, 0, glowR, 0, Math.PI * 2);
						ctx.fill();
					} catch(e) {}
					// Solid stroke ring on top
					ctx.strokeStyle = color;
					ctx.globalAlpha = Math.max(0.5, 0.9 * t);
					ctx.lineWidth = 3;
					ctx.shadowColor = color;
					ctx.shadowBlur = 12;
					ctx.beginPath();
					ctx.arc(0, 0, ringRadius, 0, Math.PI * 2);
					ctx.stroke();
					ctx.shadowBlur = 0;
					ctx.restore();
				}
			};
			window.projectiles.impacts.push(ring);
			// Spawn an actual ballistic projectile toward the telegraphed location
			try {
				if (window.Bullet) {
					const dx = tx - this.x; const dy = ty - this.y;
					const dist = Math.hypot(dx, dy) || 1;
					const ux = dx / dist; const uy = dy / dist;
					const fireAngle = Math.atan2(uy, ux);
					const spawnX = this.x + ux * (this.radius + 8);
					const spawnY = this.y + uy * (this.radius + 8);
					const projectileSpeed = 600;
					const projectileLife = 3.6;
					const perp = (Math.random() < 0.5 ? -1 : 1);
					const options = { targetX: tx, targetY: ty, maxTurnRate: 13.5, bias: perp * 1.8, shadowEnabled: true, accelBallistic: true, ignoreEnvironment: true, ignoreEnemies: true, deathYellowCircle: true, owner: this };
					window.projectiles.items.push(new window.Bullet(spawnX, spawnY, Math.cos(fireAngle) * projectileSpeed, Math.sin(fireAngle) * projectileSpeed, 6, color, projectileLife, fireAngle, false, options));
				}
			} catch(_) {}
		} catch(_) {}
	}

	draw(ctx, camera) {
		// Draw base enemy body and healthbar
		Enemy.prototype.draw.call(this, ctx, camera);
		// Draw two long devil-like cones (horns) on either side of the head
		try {
			const sx = this.x - camera.x;
			const sy = this.y - camera.y;
			const r = this.radius;
			const ang = -Math.PI / 2;
			// Horn parameters
			const baseDist = r * 0.9; // from center to horn base along direction
			const spread = 0.55; // radians offset from forward for left/right horns
			const baseWidth = Math.max(24, r * 1.28);
			const hornLen = Math.max(40, r * 1.9); // quite long
			const fill = '#4a4a4a';
			const stroke = '#0d0d0d';
			ctx.save();
			for (let s = -1; s <= 1; s += 2) {
				const dirAng = ang + s * spread;
				const bx = sx + Math.cos(dirAng) * baseDist;
				const by = sy + Math.sin(dirAng) * baseDist;
				const tipX = bx + Math.cos(dirAng) * hornLen;
				const tipY = by + Math.sin(dirAng) * hornLen;
				// perpendicular for base width
				const px = -Math.sin(dirAng);
				const py = Math.cos(dirAng);
				const hw = baseWidth * 0.5;
				const b1x = bx + px * hw;
				const b1y = by + py * hw;
				const b2x = bx - px * hw;
				const b2y = by - py * hw;
				ctx.fillStyle = fill;
				ctx.strokeStyle = stroke;
				ctx.lineWidth = 2;
				ctx.beginPath();
				ctx.moveTo(b1x, b1y);
				ctx.lineTo(tipX, tipY);
				ctx.lineTo(b2x, b2y);
				ctx.closePath();
				ctx.fill();
				ctx.stroke();
			}
			ctx.restore();
		} catch(_) {}
	}
}

window.ArtilleryWitch = ArtilleryWitch;


