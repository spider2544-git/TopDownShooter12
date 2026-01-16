/*
	Director: orchestrates enemy AI movement and behavior modes.
	Integrates with existing `Enemies`, `Environment`, and `Player` modules.
*/

class Director {
	constructor(enemies, environment, player) {
		this.enemies = enemies;
		this.environment = environment;
		this.player = player;
		this.mode = 'hunt'; // 'hunt' | 'scatter' | 'panic' | 'ambush'
		this.modeParams = {};
		this.modeTime = 0;
		// When false, even "contact" enemies use ring/slot steering instead of direct rush.
		// Useful for non-player targets (e.g. troops) to prevent dogpiles.
		this.allowContactRush = true;
		// Only update enemies near the player for performance
		this.activeRadius = 1400;
		// Base walk speed for enemies (units/sec)
		this.baseSpeed = 80;
		this.speedByMode = { hunt: 1.0, scatter: 0.85, panic: 1.35, ambush: 1.1 };
		// Extra obstacle clearance (in world units) added to enemy radius during navigation
		this.baseClearance = 12;
		this.clearanceByMode = { hunt: 14, scatter: 10, panic: 8, ambush: 16 };
		// Separation settings to reduce bunching
		this.separationPadding = 10; // desired extra space beyond radii
		this.separationRadius = 100; // neighbor search radius
		this.separationWeightMax = 1.2; // blend strength cap
		// Track player velocity for prediction in ambush mode
		this._prevPlayerX = player ? player.x : 0;
		this._prevPlayerY = player ? player.y : 0;
		// Ring reservation (attack slotting) around the player to prevent dogpiles
		this.ringEnabled = true;
		this.ringRadius = 130; // desired engagement radius around player center
		this.ringArcSpacing = 60; // minimal arc length between neighbors along the ring
		this.ringConsiderDistance = 600; // only consider enemies within this distance for the ring
		this.ringReassignPeriod = 0.25; // seconds between global reassigns to reduce jitter
		this._ringAssignments = new Map(); // enemyId -> { angle, radius, ts }
		this._ringLastAssignTime = 0;
		// Steering weights (Craig Reynolds style)
		this.steering = {
			arriveWeight: 0.95,
			orbitWeight: 0.8,
			maxLeadTime: 0.6, // seconds ahead for pursuit prediction
			minLeadDist: 100,
			maxLeadDist: 800
		};
		// Approach arcs (wave-level variety to produce flanks)
		this.approachArcsEnabled = true;
		this.approachArcChangePeriod = 9; // seconds between reshuffles
		this.approachArcMinCount = 2;
		this.approachArcMaxCount = 3;
		this.approachArcWidth = 0.9; // radians (~52°) arc capture width
		this.approachArcBias = 0.65; // how strongly to steer toward arc center when far
		this.approachArcDistMin = 380; // start applying arcs when farther than this
		this.approachArcDistMax = 1200; // fully apply by this distance
		this._currentArcs = []; // [{ center, width }]
		this._lastArcAssignTime = -999;
		this._arcAssignments = new Map(); // enemyId -> { idx, ts }
	}

	setMode(mode, params = {}) {
		this.mode = mode;
		this.modeParams = params || {};
		this.modeTime = 0;
	}

	update(dt) {
		if (!this.enemies || !this.environment || !this.player) return;
		if (!Number.isFinite(dt) || dt <= 0) return;
		this.modeTime += dt;

		// Compute player velocity (best-effort)
		const pvx = (this.player.x - this._prevPlayerX) / Math.max(dt, 1e-6);
		const pvy = (this.player.y - this._prevPlayerY) / Math.max(dt, 1e-6);
		this._prevPlayerX = this.player.x;
		this._prevPlayerY = this.player.y;

		// Get active enemies near the player
		const active = (typeof this.enemies.queryCircle === 'function')
			? this.enemies.queryCircle(this.player.x, this.player.y, this.activeRadius)
			: (this.enemies.items || []);

		const speedMul = this.speedByMode[this.mode] != null ? this.speedByMode[this.mode] : 1;
		// Allow per-enemy speed multipliers (e.g., faster variants)
		const entMulDefault = 1;
		// We'll use per-enemy multipliers inside the loop in case enemies differ
		let moveSpeed = this.baseSpeed * speedMul;

		for (let i = 0; i < active.length; i++) {
			const e = active[i];
			if (!e || !e.alive) continue;
			// Let knockback resolve exclusively while active
			if (e.kbTime && e.kbTime > 0) continue;

			// Compute per-enemy move speed (supports e.speedMul)
			const entMul = (e && Number.isFinite(e.speedMul)) ? e.speedMul : entMulDefault;
			moveSpeed = this.baseSpeed * speedMul * entMul;

			const dx = this.player.x - e.x;
			const dy = this.player.y - e.y;
			const dist = Math.hypot(dx, dy) || 1;

			let dirX = 0, dirY = 0;
			switch (this.mode) {
				case 'panic': {
					// Flee directly away from player
					dirX = -(dx / dist);
					dirY = -(dy / dist);
					break;
				}
				case 'scatter': {
					// Move tangentially around the player; alternate handedness by id
					const ux = dx / dist;
					const uy = dy / dist;
					const rightX = -uy, rightY = ux; // 90° clockwise
					const sign = (e.id % 2 === 0) ? 1 : -1;
					dirX = rightX * sign;
					dirY = rightY * sign;
					// If too close, bias slightly outward to prevent clumping
					if (dist < (e.radius || 26) * 3.5) {
						dirX += -ux * 0.6;
						dirY += -uy * 0.6;
					}
					break;
				}
			case 'ambush':
			case 'hunt':
			default: {
				// For contact-preferring enemies, drive straight to the player but stop at contact distance
				if (e && e.preferContact && this.allowContactRush !== false) {
					const stoppingDistance = 30; // Allow some overlap but keep them visible
					
					if (dist > stoppingDistance) {
						// Move toward player
						dirX = dx / dist;
						dirY = dy / dist;
					} else {
						// Close enough - stop moving (or move very slowly to maintain contact)
						const slowdown = Math.max(0, (dist - (stoppingDistance - 5)) / 10); // Gentle approach as they get close
						dirX = (dx / dist) * slowdown;
						dirY = (dy / dist) * slowdown;
					}
					break;
				}
				// Strafing/orbit override for ranged enemies (projectile zombies)
				const aiOverride = e && e._ai ? e._ai : null;
				if (aiOverride && aiOverride.forceOrbit && dist > 180 && dist < 920) {
					// Predict player and orbit around predicted position
					const pred = this._predictPlayerPosition(pvx, pvy, dist);
					const rx = e.x - pred.x, ry = e.y - pred.y;
					const d = Math.hypot(rx, ry) || 1;
					const radialUx = rx / d, radialUy = ry / d;
					// Tangent (right-handed), pick side from AI
					let tangX = -radialUy, tangY = radialUx;
					const side = (aiOverride.strafeSide === -1) ? -1 : 1;
					tangX *= side; tangY *= side;
					// Maintain a comfortable radius while strafing (very gentle radial correction)
					const desiredR = Math.max(100, aiOverride.strafeRadius || this.ringRadius);
					const rErr = d - desiredR;
					const orbitInward = Math.max(-1, Math.min(1, -rErr / Math.max(1, desiredR)));
					// Strong tangential (sideways) bias; minimal radial correction for parallel strafing
					let mx = tangX * 1.0 + radialUx * (0.15 * orbitInward);
					let my = tangY * 1.0 + radialUy * (0.15 * orbitInward);
					const ml = Math.hypot(mx, my) || 1; mx /= ml; my /= ml;
					dirX = mx; dirY = my;
					break;
				}

				// Flanking-aware targeting with ring reservation to spread angles
				const forward = this._getPlayerForward(pvx, pvy, dx, dy);
				this._ensureAiState(e, dist);
				// Update wave-level approach arcs and ring assignments periodically (only once per frame)
				if (i === 0) {
					this._maybeRefreshApproachArcs(forward);
					this._maybeReassignRing(active, forward);
				}
				let tgt = this._getRingTarget(e, this.player, dist);
				if (!tgt) tgt = this._computeApproachArcTarget(e, this.player, forward, dist) || this._computeFlankTarget(e, this.player, forward, dist);
				const pred = this._predictPlayerPosition(pvx, pvy, dist);
				const steer = this._computeSteeringDirection(e, tgt, pred, dist);
				dirX = steer.x; dirY = steer.y;
				break;
			}
			}

			// Back-up and sidestep avoidance behavior when stuck
			if (!e._ai) e._ai = {};
			const ai = e._ai;
			// Desired direction before smoothing/avoidance
			let desiredUx = dirX, desiredUy = dirY;
			// Activate avoid when stuck for a short time
			if ((ai.stuckTimer || 0) > 0.28 && !ai.avoidActive) {
				ai.avoidActive = true;
				ai.avoidPhase = 'reverse';
				ai.avoidTimer = 0.15 + Math.random() * 0.2; // 0.15..0.35s
				// Pick sidestep side based on small probe or random
				const rightX = -desiredUy, rightY = desiredUx;
				const probeDist = moveSpeed * 0.2 * dt;
				const r = this._tryResolveMove(e, rightX * probeDist, rightY * probeDist, this._getClearanceRadius(e));
				const l = this._tryResolveMove(e, -rightX * probeDist, -rightY * probeDist, this._getClearanceRadius(e));
				const progR = (r.x - e.x) * desiredUx + (r.y - e.y) * desiredUy;
				const progL = (l.x - e.x) * desiredUx + (l.y - e.y) * desiredUy;
				ai.avoidSide = (progR > progL) ? 1 : -1; // 1 = right, -1 = left
			}
			// Drive avoid phases
			if (ai.avoidActive) {
				ai.avoidTimer -= dt;
				const rightX = -desiredUy, rightY = desiredUx;
				if (ai.avoidPhase === 'reverse') {
					// back up from obstacle
					desiredUx = -desiredUx; desiredUy = -desiredUy;
					if (ai.avoidTimer <= 0) {
						ai.avoidPhase = 'sidestep';
						ai.avoidTimer = 0.45 + Math.random() * 0.6; // 0.45..1.05s
					}
				} else if (ai.avoidPhase === 'sidestep') {
					// move laterally to go around the obstacle
					desiredUx = rightX * (ai.avoidSide || 1);
					desiredUy = rightY * (ai.avoidSide || 1);
					// blend a bit of forward to keep progress
					desiredUx = desiredUx * 0.9 + dirX * 0.1;
					desiredUy = desiredUy * 0.9 + dirY * 0.1;
					const n = Math.hypot(desiredUx, desiredUy) || 1; desiredUx /= n; desiredUy /= n;
					if (ai.avoidTimer <= 0) {
						ai.avoidActive = false; ai.avoidPhase = null; ai.stuckTimer = 0;
					}
				}
			}

			// Small per-enemy directional jitter for more organic motion (reduced)
			const jitter = this._seededJitter(e.id) * 0.12; // radians
			const cosJ = Math.cos(jitter), sinJ = Math.sin(jitter);
			let jx = desiredUx * cosJ - desiredUy * sinJ;
			let jy = desiredUx * sinJ + desiredUy * cosJ;
			let norm = Math.hypot(jx, jy) || 1; jx /= norm; jy /= norm;

			// Separation force from nearby enemies to reduce bunching
			const sep = this._computeSeparation(e);
			if (sep.mag > 0) {
				// Blend separation into desired heading before smoothing
				const mix = Math.min(this.separationWeightMax, sep.weight);
				const sx = sep.ux * mix;
				const sy = sep.uy * mix;
				jx = jx * (1 - mix) + sx;
				jy = jy * (1 - mix) + sy;
				const n2 = Math.hypot(jx, jy) || 1; jx /= n2; jy /= n2;
			}

			// Feeler-based pre-steering to anticipate obstacles (±25°, 50 px)
			{
				const pre = this._applyFeelerPresteer(e, jx, jy);
				jx = pre.x; jy = pre.y;
			}

			// Heading smoothing: limit turn rate to avoid snap changes
			if (ai.headingAngle == null) ai.headingAngle = Math.atan2(jy, jx);
			const targetAngle = Math.atan2(jy, jx);
			ai.headingAngle = this._steerAngle(ai.headingAngle, targetAngle, 4.0 * dt); // 4 rad/s max
			dirX = Math.cos(ai.headingAngle);
			dirY = Math.sin(ai.headingAngle);

			// Normalize just in case
			const len = Math.hypot(dirX, dirY) || 1;
			dirX /= len; dirY /= len;

			// Move with grid, with adaptive fallback tuned for small angular changes
			const stepX = dirX * moveSpeed * dt;
			const stepY = dirY * moveSpeed * dt;
			const moved = this._moveEnemyWithGrid(e, stepX, stepY, { desiredUx: dirX, desiredUy: dirY, dt, avoiding: !!ai.avoidActive });
			// Track stuck time and allow adaptive clearance/nudges
			if (!e._ai) e._ai = {};
			const ai2 = e._ai;
			const minProgress = moveSpeed * dt * 0.2;
			const dxm = (ai2._lastX != null) ? (e.x - ai2._lastX) : stepX;
			const dym = (ai2._lastY != null) ? (e.y - ai2._lastY) : stepY;
			const movedDist = Math.hypot(dxm, dym);
			if (movedDist < minProgress) {
				ai2.stuckTimer = (ai2.stuckTimer || 0) + dt;
			} else {
				ai2.stuckTimer = 0;
			}
			ai2._lastX = e.x;
			ai2._lastY = e.y;
		}
	}

	_steerAngle(cur, target, maxDelta) {
		let d = target - cur;
		while (d > Math.PI) d -= Math.PI * 2;
		while (d < -Math.PI) d += Math.PI * 2;
		const clamped = Math.max(-maxDelta, Math.min(maxDelta, d));
		return cur + clamped;
	}

	_getPlayerForward(pvx, pvy, dx, dy) {
		const vmag = Math.hypot(pvx, pvy);
		if (vmag > 10) return { x: pvx / vmag, y: pvy / vmag };
		// Fallback: use approach direction (from player to enemy -> forward is opposite)
		const len = Math.hypot(dx, dy) || 1;
		return { x: -(dx / len), y: -(dy / len) };
	}

	_ensureAiState(enemy, dist) {
		const now = this.modeTime;
		if (!enemy._ai) enemy._ai = {};
		const ai = enemy._ai;
		if (!ai.style || !Number.isFinite(ai.nextReeval) || now >= ai.nextReeval) {
			const style = this._pickStyle(enemy.id, dist);
			const flankRadius = 80 + Math.random() * 120; // 80..200
			const duration = 4 + Math.random() * 5; // 4..9s
			const side = (Math.random() < 0.5) ? -1 : 1; // -1 left, 1 right
			ai.style = style;
			ai.side = side;
			ai.flankRadius = flankRadius;
			ai.nextReeval = now + duration;
		}
	}

	_pickStyle(id, dist) {
		// Distance-influenced probabilities
		let pDirect = 0.5, pSide = 0.35, pRear = 0.15;
		if (dist > 900) { pDirect = 0.45; pSide = 0.4; pRear = 0.15; }
		else if (dist < 300) { pDirect = 0.25; pSide = 0.55; pRear = 0.20; }
		// Stable per-id bias
		const bias = (id % 5) * 0.02; // up to ±0.08
		pSide = Math.min(0.8, Math.max(0.1, pSide + (id % 2 === 0 ? bias : -bias)));
		const r = Math.random();
		if (r < pDirect) return 'direct';
		if (r < pDirect + pSide) return (Math.random() < 0.5 ? 'flank_left' : 'flank_right');
		return 'rear';
	}

	_computeFlankTarget(enemy, player, forward, dist) {
		const ai = enemy._ai || {};
		const f = forward;
		// Build an orthonormal basis around player
		const right = { x: -f.y, y: f.x };
		let offsetX = 0, offsetY = 0;
		const radius = Math.max(40, ai.flankRadius || 120);
		switch (ai.style) {
			case 'flank_left': {
				offsetX = right.x * -radius; offsetY = right.y * -radius; break;
			}
			case 'flank_right': {
				offsetX = right.x * radius; offsetY = right.y * radius; break;
			}
			case 'rear': {
				offsetX = -f.x * radius; offsetY = -f.y * radius; break;
			}
			case 'direct':
			default: {
				// Slight angle jitter while heading to the player
				const jitter = (Math.random() - 0.5) * 0.4; // ±0.2 rad
				const c = Math.cos(jitter), s = Math.sin(jitter);
				const jx = f.x * c - f.y * s;
				const jy = f.x * s + f.y * c;
				offsetX = jx * Math.min(radius * 0.5, dist * 0.25);
				offsetY = jy * Math.min(radius * 0.5, dist * 0.25);
				break;
			}
		}
		// Encourage closing distance if far away, by blending toward player center
		const far = dist > 700 ? 0.35 : (dist > 350 ? 0.2 : 0.1);
		return { x: player.x + offsetX * (1 - far), y: player.y + offsetY * (1 - far) };
	}

	_seededJitter(id) {
		// Deterministic pseudo-random based on id and modeTime
		const a = 1103515245;
		const c = 12345;
		const t = Math.floor(this.modeTime * 10);
		let x = (id * 97 + t) >>> 0;
		x = (a * x + c) >>> 0;
		// Map to [-1, 1]
		return ((x & 1023) / 1023) * 2 - 1;
	}

	// ---------------------------
	// Ring reservation system
	// ---------------------------
	_maybeReassignRing(nearbyEnemies, forward) {
		if (!this.ringEnabled) return;
		const now = this.modeTime;
		if (now - this._ringLastAssignTime < this.ringReassignPeriod) return;
		this._ringLastAssignTime = now;
		if (!Array.isArray(nearbyEnemies) || nearbyEnemies.length === 0) return;
		// Filter candidates close enough to matter
		const px = this.player.x, py = this.player.y;
		const candidates = [];
		for (let i = 0; i < nearbyEnemies.length; i++) {
			const e = nearbyEnemies[i];
			if (!e || !e.alive) continue;
			const dx = e.x - px, dy = e.y - py;
			const d = Math.hypot(dx, dy);
			if (d <= this.ringConsiderDistance) {
				const ang = Math.atan2(dy, dx);
				candidates.push({ e, d, ang });
			}
		}
		if (candidates.length === 0) return;
		// Sort by distance so closer enemies claim first
		candidates.sort((a, b) => a.d - b.d);
		// Determine number of slots from circumference and desired spacing
		const circumference = 2 * Math.PI * this.ringRadius;
		const slotCount = Math.max(4, Math.min(24, Math.floor(circumference / this.ringArcSpacing)));
		// Anchor the first slot roughly opposite player's forward to prefer flank/rear
		const anchorAngle = Math.atan2(-forward.y, -forward.x);
		const slotAngles = [];
		for (let s = 0; s < slotCount; s++) {
			const ang = anchorAngle + (s * 2 * Math.PI) / slotCount;
			slotAngles.push(this._normAngle(ang));
		}
		// Keep track of taken slots
		const taken = new Array(slotCount).fill(false);
		// Build quick helper to angle-diff
		const angleDelta = (a, b) => {
			let d = a - b;
			while (d > Math.PI) d -= 2 * Math.PI;
			while (d < -Math.PI) d += 2 * Math.PI;
			return Math.abs(d);
		};
		// Assign closest angular slot for each candidate
		for (let i = 0; i < candidates.length; i++) {
			const { e, ang } = candidates[i];
			let bestIdx = -1, bestDiff = Infinity;
			for (let s = 0; s < slotAngles.length; s++) {
				if (taken[s]) continue;
				const diff = angleDelta(ang, slotAngles[s]);
				if (diff < bestDiff) { bestDiff = diff; bestIdx = s; }
			}
			if (bestIdx !== -1) {
				taken[bestIdx] = true;
				this._ringAssignments.set(e.id, { angle: slotAngles[bestIdx], radius: this.ringRadius, ts: now });
			}
		}
		// Cleanup stale assignments for enemies no longer present
		const validIds = new Set(candidates.map(c => c.e.id));
		for (const key of this._ringAssignments.keys()) {
			if (!validIds.has(key)) this._ringAssignments.delete(key);
		}
	}

	_getRingTarget(enemy, player, distToPlayer) {
		if (!this.ringEnabled) return null;
		const a = this._ringAssignments.get(enemy.id);
		if (!a) return null;
		// If far, allow approach radius to be slightly larger; if close, use assigned radius
		const radius = (distToPlayer > a.radius * 1.6) ? Math.min(a.radius * 1.3, a.radius + (distToPlayer - a.radius) * 0.3) : a.radius;
		return { x: player.x + Math.cos(a.angle) * radius, y: player.y + Math.sin(a.angle) * radius };
	}

	_predictPlayerPosition(pvx, pvy, distToEnemy) {
		const s = this.steering || {};
		const leadByDist = Math.max(0, Math.min(1, (distToEnemy - (s.minLeadDist || 100)) / Math.max(1, (s.maxLeadDist || 800) - (s.minLeadDist || 100))));
		const leadTime = (s.maxLeadTime || 0.6) * leadByDist;
		return { x: this.player.x + pvx * leadTime, y: this.player.y + pvy * leadTime };
	}

	_computeSteeringDirection(enemy, target, predictedPlayer, distToPlayer) {
		// Arrive toward target (slot or flank point)
		let ax = (target.x ?? 0) - enemy.x;
		let ay = (target.y ?? 0) - enemy.y;
		let al = Math.hypot(ax, ay) || 1; ax /= al; ay /= al;
		// If target carries an approach bias (from approach arcs), blend toward its direction more strongly when far
		const bias = Math.max(0, Math.min(1, target.bias || 0));
		ax = ax * (1 + bias);
		ay = ay * (1 + bias);
		// Orbit around predicted player position at ring radius
		const px = predictedPlayer.x, py = predictedPlayer.y;
		const dx = enemy.x - px, dy = enemy.y - py;
		const d = Math.hypot(dx, dy) || 1;
		let tangX = -dy / d, tangY = dx / d; // right-handed tangent
		// Blend approach/outward to stabilize radius near ring
		const desiredR = this.ringRadius;
		const radialUx = dx / d, radialUy = dy / d;
		const rErr = d - desiredR;
		const radialFix = Math.max(-1, Math.min(1, rErr / Math.max(1, desiredR)));
		const orbitInward = -radialFix * 0.6; // pull toward desired radius
		let ox = tangX * 1.0 + radialUx * orbitInward;
		let oy = tangY * 1.0 + radialUy * orbitInward;
		let ol = Math.hypot(ox, oy) || 1; ox /= ol; oy /= ol;
		// Weighted blend
		const wArrive = (this.steering?.arriveWeight) ?? 1.0;
		const wOrbit = (this.steering?.orbitWeight) ?? 0.8;
		let mx = ax * wArrive + ox * wOrbit;
		let my = ay * wArrive + oy * wOrbit;
		const ml = Math.hypot(mx, my) || 1; mx /= ml; my /= ml;
		return { x: mx, y: my };
	}

	_normAngle(ang) {
		let a = ang;
		while (a <= -Math.PI) a += 2 * Math.PI;
		while (a > Math.PI) a -= 2 * Math.PI;
		return a;
	}

	_moveEnemyWithGrid(enemy, dx, dy, options = {}) {
		if (!enemy || !enemy.alive) return;
		const oldX = enemy.x;
		const oldY = enemy.y;
		let newX = oldX + dx;
		let newY = oldY + dy;
		const desiredUx = options.desiredUx || (dx === 0 && dy === 0 ? 1 : dx / (Math.hypot(dx, dy) || 1));
		const desiredUy = options.desiredUy || (dx === 0 && dy === 0 ? 0 : dy / (Math.hypot(dx, dy) || 1));
		const dt = options.dt || 0;
		const navRadiusBase = this._getClearanceRadius(enemy);
		let navRadius = navRadiusBase;
		const ai = enemy._ai || {};
		if (ai.stuckTimer && ai.stuckTimer > 0.35) navRadius = Math.max((enemy.radius || 26) + 6, navRadiusBase * 0.8);
		// Sub-step movement with sliding: break movement into small increments and attempt lateral slide when blocked
		let curX = enemy.x;
		let curY = enemy.y;
		const totalLen = Math.hypot(dx, dy);
		const maxSub = 12;
		const steps = Math.min(8, Math.max(1, Math.ceil(totalLen / maxSub)));
		for (let s = 0; s < steps; s++) {
			const sdx = dx / steps;
			const sdy = dy / steps;
			let rx = curX, ry = curY;
			if (this.environment && typeof this.environment.resolveCircleMove === 'function') {
				const r = this.environment.resolveCircleMove(curX, curY, navRadius, sdx, sdy);
				rx = r.x; ry = r.y;
			} else { rx = curX + sdx; ry = curY + sdy; }
			// Cap per-substep displacement to suppress visible pops from large corrections
			const capLen = Math.hypot(sdx, sdy) * 1.05;
			let corrX = rx - curX;
			let corrY = ry - curY;
			let corrLen = Math.hypot(corrX, corrY);
			if (corrLen > capLen && corrLen > 1e-6) {
				const scale = capLen / corrLen;
				rx = curX + corrX * scale;
				ry = curY + corrY * scale;
				corrX = rx - curX; corrY = ry - curY; corrLen = Math.hypot(corrX, corrY);
			}
			const stepProg = (rx - curX) * desiredUx + (ry - curY) * desiredUy;
			const stepLen = Math.hypot(sdx, sdy) || 1e-6;
			// If not progressing, try lateral slide this sub-step
			if (stepProg < stepLen * 0.2) {
				const rightX = -desiredUy, rightY = desiredUx;
				const slideMag = stepLen;
				let rxR = rx, ryR = ry, progR = -Infinity;
				let rxL = rx, ryL = ry, progL = -Infinity;
				if (this.environment && typeof this.environment.resolveCircleMove === 'function') {
					// Slightly shrink clearance when attempting slide to hug corner
					const slideRadius = Math.max((enemy.radius || 26) + 6, navRadius * 0.9);
					const rr = this.environment.resolveCircleMove(curX, curY, slideRadius, rightX * slideMag, rightY * slideMag);
					rxR = rr.x; ryR = rr.y; progR = (rxR - curX) * desiredUx + (ryR - curY) * desiredUy;
					const rl = this.environment.resolveCircleMove(curX, curY, slideRadius, -rightX * slideMag, -rightY * slideMag);
					rxL = rl.x; ryL = rl.y; progL = (rxL - curX) * desiredUx + (ryL - curY) * desiredUy;
				} else {
					rxR = curX + rightX * slideMag; ryR = curY + rightY * slideMag; progR = (rxR - curX) * desiredUx + (ryR - curY) * desiredUy;
					rxL = curX - rightX * slideMag; ryL = curY - rightY * slideMag; progL = (rxL - curX) * desiredUx + (ryL - curY) * desiredUy;
				}
				if (progR > stepProg || progL > stepProg) {
					if (progR >= progL) { rx = rxR; ry = ryR; } else { rx = rxL; ry = ryL; }
					// Cap slide correction too
					let sx = rx - curX; let sy = ry - curY; const sl = Math.hypot(sx, sy);
					if (sl > capLen && sl > 1e-6) { const sc = capLen / sl; rx = curX + sx * sc; ry = curY + sy * sc; }
				}
			}
			curX = rx; curY = ry;
		}
		newX = curX; newY = curY;
		// Maintain spatial hash consistency
		try {
			const oldKey = enemy._gridKey;
			const newKey = (typeof this.enemies._keyFromWorld === 'function')
				? this.enemies._keyFromWorld(newX, newY)
				: null;
			if (newKey && newKey !== oldKey) {
				if (oldKey) {
					const bucket = this.enemies.grid.get(oldKey);
					if (bucket) {
						const idx = bucket.indexOf(enemy);
						if (idx !== -1) bucket.splice(idx, 1);
						if (bucket.length === 0) this.enemies.grid.delete(oldKey);
					}
				}
				enemy._gridKey = newKey;
				let nb = this.enemies.grid.get(newKey);
				if (!nb) { nb = []; this.enemies.grid.set(newKey, nb); }
				nb.push(enemy);
			}
			enemy.x = newX;
			enemy.y = newY;
		} catch(e) {
			// Best-effort: if grid maintenance fails, still move the enemy
			enemy.x = newX;
			enemy.y = newY;
		}
		return Math.hypot(newX - oldX, newY - oldY) > 0.001;
	}

	_tryResolveMove(enemy, dx, dy, radius) {
		if (this.environment && typeof this.environment.resolveCircleMove === 'function') {
			const res = this.environment.resolveCircleMove(enemy.x, enemy.y, radius, dx, dy);
			return { x: res.x, y: res.y };
		}
		return { x: enemy.x + dx, y: enemy.y + dy };
	}

	_rotate(x, y, ang) {
		const c = Math.cos(ang), s = Math.sin(ang);
		return { x: x * c - y * s, y: x * s + y * c };
	}

	_computeSeparation(enemy) {
		const result = { ux: 0, uy: 0, mag: 0, weight: 0 };
		if (!this.enemies || !this.enemies.queryCircle) return result;
		const baseR = (enemy.radius || 26);
		const desired = baseR + this.separationPadding + 14; // +14 to be generous
		const neighbors = this.enemies.queryCircle(enemy.x, enemy.y, this.separationRadius);
		let accX = 0, accY = 0, total = 0;
		for (let i = 0; i < neighbors.length; i++) {
			const o = neighbors[i];
			if (!o || o === enemy || !o.alive) continue;
			const dx = enemy.x - o.x;
			const dy = enemy.y - o.y;
			let d = Math.hypot(dx, dy);
			const minD = (o.radius || 26) + desired;
			if (d < 1e-3) { d = 1e-3; }
			if (d < minD) {
				// Push away inversely proportional to penetration
				const overlap = (minD - d);
				const w = Math.min(1, overlap / minD); // 0..1
				accX += (dx / d) * w;
				accY += (dy / d) * w;
				total += w;
			}
		}
		if (total > 0) {
			const ux = accX / total;
			const uy = accY / total;
			const mag = Math.hypot(ux, uy);
			if (mag > 1e-6) { result.ux = ux / mag; result.uy = uy / mag; result.mag = mag; }
			result.weight = Math.min(this.separationWeightMax, 0.8 * total);
		}
		return result;
	}

	// ---------------------------
	// Feeler pre-steer (obstacle anticipation)
	// ---------------------------
	_applyFeelerPresteer(enemy, headingUx, headingUy) {
		// Require environment collision helper
		if (!this.environment) {
			const n0 = Math.hypot(headingUx, headingUy) || 1;
			return { x: headingUx / n0, y: headingUy / n0 };
		}
		// Normalize heading
		let hx = headingUx, hy = headingUy;
		const hl = Math.hypot(hx, hy) || 1; hx /= hl; hy /= hl;
		// Whisker spec
		let feelerLen = 50;
		let feelerAng = Math.PI * (25 / 180);
		if (enemy && enemy.avoidObstaclesAggressively) {
			feelerLen = 90; // look farther ahead
			feelerAng = Math.PI * (35 / 180); // wider whiskers
		}
		const navR = Math.max((enemy && Number.isFinite(enemy.radius) ? enemy.radius : 26) + 6, this._getClearanceRadius(enemy));
		// Local rotate
		const rot = (x, y, a) => { const c = Math.cos(a), s = Math.sin(a); return { x: x * c - y * s, y: x * s + y * c }; };
		const dirs = {
			fwd: { x: hx, y: hy },
			left: rot(hx, hy, feelerAng),
			right: rot(hx, hy, -feelerAng)
		};
		// Measure clearance along a direction using a single resolve (fast path)
		const measureClearance = (dx, dy) => {
			if (typeof this.environment.resolveCircleMove === 'function') {
				const res = this.environment.resolveCircleMove(enemy.x, enemy.y, navR, dx * feelerLen, dy * feelerLen);
				const prog = (res.x - enemy.x) * dx + (res.y - enemy.y) * dy;
				// If progressed fully, no hit; otherwise, obstruction at approx distance
				return (prog >= feelerLen - 1e-3) ? Infinity : Math.max(0, prog);
			}
			// Fallback: discrete sampling using circleHitsAny
			if (typeof this.environment.circleHitsAny === 'function') {
				const step = 10;
				for (let s = step; s <= feelerLen; s += step) {
					const px = enemy.x + dx * s;
					const py = enemy.y + dy * s;
					if (this.environment.circleHitsAny(px, py, navR)) return s;
				}
			}
			return Infinity;
		};
		const df = measureClearance(dirs.fwd.x, dirs.fwd.y);
		const dl = measureClearance(dirs.left.x, dirs.left.y);
		const dr = measureClearance(dirs.right.x, dirs.right.y);
		// Start with current heading
		let rx = hx, ry = hy;
		// Right-hand perpendicular
		const rightX = -hy, rightY = hx;
		const pickSide = () => {
			if (dr === dl) return (enemy.id % 2 === 0) ? 1 : -1; // stable tie-break
			return (dr > dl) ? 1 : -1; // steer toward greater clearance
		};
		if (df < Infinity) {
			// Imminent obstruction ahead: bias laterally toward the clearer side
			const side = pickSide();
			const severity = Math.max(0, Math.min(1, 1 - (df / feelerLen)));
			let w = 0.75 * severity + 0.15; // 0.15..0.9
			if (enemy && enemy.avoidObstaclesAggressively) {
				w = Math.min(1, w * 1.2 + 0.15); // steer harder away from obstacles
			}
			const sx = rightX * side;
			const sy = rightY * side;
			rx = rx * (1 - w) + sx * w;
			ry = ry * (1 - w) + sy * w;
		} else {
			// Side graze: gently bias away from the blocked side
			let side = 0;
			if (dl < Infinity && !(dr < Infinity)) side = 1; // left blocked -> steer right
			else if (dr < Infinity && !(dl < Infinity)) side = -1; // right blocked -> steer left
			else if (dl < Infinity && dr < Infinity) side = (dr > dl) ? 1 : -1;
			if (side !== 0) {
				const near = Math.min(dl, dr);
				const severity = Math.max(0, Math.min(1, 1 - (near / feelerLen)));
				let w = 0.4 * severity; // gentle nudge
				if (enemy && enemy.avoidObstaclesAggressively) w = 0.65 * severity;
				const sx = rightX * side;
				const sy = rightY * side;
				rx = rx * (1 - w) + sx * w;
				ry = ry * (1 - w) + sy * w;
			}
		}
		const nl = Math.hypot(rx, ry) || 1;
		let outX = rx / nl, outY = ry / nl;
		// Prefer open spaces: if right vs left clearances differ, add a small bias toward the more open side
		if (enemy && enemy.preferOpenSpaces) {
			const biasSide = (dr > dl) ? 1 : (dl > dr ? -1 : 0);
			if (biasSide !== 0) {
				const bx = rightX * biasSide;
				const by = rightY * biasSide;
				const bw = 0.12; // small bias
				outX = outX * (1 - bw) + bx * bw;
				outY = outY * (1 - bw) + by * bw;
				const nn = Math.hypot(outX, outY) || 1; outX /= nn; outY /= nn;
			}
		}
		return { x: outX, y: outY };
	}

	// ---------------------------
	// Approach arcs (wave-level)
	// ---------------------------
	_maybeRefreshApproachArcs(forward) {
		if (!this.approachArcsEnabled) return;
		const now = this.modeTime;
		if (now - this._lastArcAssignTime < this.approachArcChangePeriod && this._currentArcs.length > 0) return;
		this._lastArcAssignTime = now;
		this._currentArcs = [];
		this._arcAssignments.clear();
		const count = Math.max(this.approachArcMinCount, Math.min(this.approachArcMaxCount, 2 + Math.floor(Math.random() * 2)));
		// Build orthonormal basis from forward
		const f = forward || { x: 1, y: 0 };
		const right = { x: -f.y, y: f.x };
		// Prefer lateral and rear arcs
		const baseAngles = [
			Math.atan2(right.y, right.x),
			Math.atan2(-right.y, -right.x),
			Math.atan2(-f.y, -f.x)
		];
		for (let i = 0; i < count; i++) {
			const base = baseAngles[i % baseAngles.length] + (Math.random() - 0.5) * 0.6; // jitter arc centers
			this._currentArcs.push({ center: this._normAngle(base), width: this.approachArcWidth });
		}
	}

	_computeApproachArcTarget(enemy, player, forward, dist) {
		if (!this.approachArcsEnabled || this._currentArcs.length === 0) return null;
		const dx = enemy.x - player.x;
		const dy = enemy.y - player.y;
		const ang = Math.atan2(dy, dx);
		// Pick the arc whose center is closest in angle
		let bestIdx = -1, bestDiff = Infinity;
		for (let i = 0; i < this._currentArcs.length; i++) {
			const a = this._currentArcs[i];
			let d = Math.abs(this._angleDelta(ang, a.center));
			if (d < bestDiff) { bestDiff = d; bestIdx = i; }
		}
		if (bestIdx === -1) return null;
		this._arcAssignments.set(enemy.id, { idx: bestIdx, ts: this.modeTime });
		const arc = this._currentArcs[bestIdx];
		// If far away, steer toward the arc center angle to approach from that side
		const minD = this.approachArcDistMin;
		const maxD = this.approachArcDistMax;
		if (dist > minD) {
			const t = Math.max(0, Math.min(1, (dist - minD) / Math.max(1, maxD - minD)));
			const bias = (this.approachArcBias || 0.5) * t;
			const targetAng = arc.center;
			const tx = player.x + Math.cos(targetAng) * Math.min(this.ringRadius * 1.6, Math.max(this.ringRadius, dist * 0.66));
			const ty = player.y + Math.sin(targetAng) * Math.min(this.ringRadius * 1.6, Math.max(this.ringRadius, dist * 0.66));
			return { x: tx, y: ty, bias };
		}
		return null;
	}

	_angleDelta(a, b) {
		let d = a - b;
		while (d > Math.PI) d -= 2 * Math.PI;
		while (d < -Math.PI) d += 2 * Math.PI;
		return d;
	}

	_getClearanceRadius(enemy) {
		const r = (enemy && Number.isFinite(enemy.radius)) ? enemy.radius : 26;
		const extra = (this.clearanceByMode && (this.mode in this.clearanceByMode)) ? this.clearanceByMode[this.mode] : this.baseClearance;
		return r + (Number.isFinite(extra) ? extra : 0);
	}
}

window.Director = Director;


