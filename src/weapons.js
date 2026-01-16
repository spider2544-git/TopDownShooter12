

class Bullet {
	constructor(x, y, vx, vy, radius, color, lifeSeconds, angle, noDamage = false, options = {}) {
		this.init(x, y, vx, vy, radius, color, lifeSeconds, angle, noDamage, options);
	}
	
	// Initialize/reset bullet state (for object pooling)
	init(x, y, vx, vy, radius, color, lifeSeconds, angle, noDamage = false, options = {}) {
		this.x = x;
		this.y = y;
		this.vx = vx;
		this.vy = vy;
		this.radius = radius;
		this.life = lifeSeconds;
		this.color = color;
		this.angle = angle != null ? angle : Math.atan2(vy, vx);
		this.noDamage = noDamage;
		this.isCone = !!options.isCone;
		this.coneRange = options.coneRange ?? 0;
		this.coneHalf = options.coneHalf ?? 0;
		this.damage = options.damage ?? 20;
		// Reuse Set if it exists, otherwise create new
		if (this.alreadyHitEnemyIds) {
			this.alreadyHitEnemyIds.clear();
		} else {
			this.alreadyHitEnemyIds = new Set();
		}
		// Clear PvP hit tracking for pooled bullets
		if (this.pvpHitPlayerIds) {
			this.pvpHitPlayerIds.clear();
		} else {
			this.pvpHitPlayerIds = new Set();
		}
		this.ignoreEnvironment = !!options.ignoreEnvironment;
		this.ignoreEnemies = !!options.ignoreEnemies;
		this.drawBehind = !!options.drawBehind;
                // Curved flight for non-cone projectiles
                this.speed = Math.hypot(vx, vy);
                this.baseSpeed = this.speed;
                // Homing-to-click target to end arc at mouse position
                this.targetX = options.targetX ?? null;
                this.targetY = options.targetY ?? null;
                this.maxTurnRate = options.maxTurnRate ?? 3.0; // rad/sec, limits curvature
                // Slight bias for arc randomness (overridable)
                this.bias = (options.bias != null) ? options.bias : ((WorldRNG.random() * 2 - 1) * 0.35);
                this.accelBallistic = !!options.accelBallistic;
                
                // Force arc to target: uses bezier interpolation to guarantee arrival at target
                // This overrides normal steering - projectile follows a curved path that ends exactly at target
                this.forceArcToTarget = !!options.forceArcToTarget;
                if (this.forceArcToTarget && this.targetX != null && this.targetY != null) {
                        this._arcStartX = x;
                        this._arcStartY = y;
                        this._arcMaxLife = lifeSeconds;
                        // Control point: perpendicular offset for arc curvature
                        const dx = this.targetX - x;
                        const dy = this.targetY - y;
                        const dist = Math.hypot(dx, dy) || 1;
                        const perpX = -dy / dist;
                        const perpY = dx / dist;
                        // Arc height is ~20% of distance, biased by options.arcBias or random
                        const arcBias = (options.arcBias != null) ? options.arcBias : ((Math.random() * 2 - 1) * 0.5);
                        const arcHeight = dist * 0.2 * (1 + arcBias);
                        // Midpoint + perpendicular offset = control point
                        this._arcCtrlX = (x + this.targetX) / 2 + perpX * arcHeight;
                        this._arcCtrlY = (y + this.targetY) / 2 + perpY * arcHeight;
                }
                
                // VFX flags
                this.deathYellowCircle = !!options.deathYellowCircle;
                this.deathMolotov = !!options.deathMolotov;
                this.bloodCost = options.bloodCost || 0;
                // Mark troop-fired projectiles (e.g., allied grenade troopers)
                // IMPORTANT: without persisting this flag, explosions fall back to player weapon logic.
                this.troopFired = !!options.troopFired;
                
                // Molotov trail particles
                if (this.deathMolotov) {
                        this._trailParticles = [];
                        this._trailSpawnTimer = 0;
                        this._trailSpawnRate = 0.02; // Spawn every 0.02s (50 per second)
                }
                
                // Crucifix sparkle trail (weapon 6 SECONDARY fire only)
                this.crucifixSparkle = (options.sourceWeaponIndex === 5 && this.deathYellowCircle);
                if (this.crucifixSparkle) {
                        this._trailParticles = [];
                        this._trailSpawnTimer = 0;
                        this._trailSpawnRate = 0.03; // Spawn every 0.03s (33 per second)
                }
                // Allow mid-flight collision with player (used by Artillery Witch Fast Ball)
                this.allowMidflightPlayerHit = !!options.allowMidflightPlayerHit;
                // Server-spawned projectiles (artillery gun, etc.) - server handles damage authoritatively
                this.serverSpawned = !!options.serverSpawned;
                // Owner reference for self-damage logic
                this.owner = options.owner || null;
                // Origin info to specialize hit behavior (e.g., DOT for weapon 4)
                this.sourceWeaponIndex = (options.sourceWeaponIndex != null) ? options.sourceWeaponIndex : null;
                // Optional precise travel distance cap (die after moving this far)
                this.travelDistLeft = (Number.isFinite(options.travelDistance) ? options.travelDistance : null);

                // Shape customization (e.g., weapon 3 rectangle)
                this.shape = options.shape || 'circle'; // 'circle' | 'rect'
                this.rectWidth = (options.rectWidth != null) ? options.rectWidth : (this.radius * 2.2);
                this.rectHeight = (options.rectHeight != null) ? options.rectHeight : (this.radius * 1.2);
                this.isChargedShot = !!options.isChargedShot; // Weapon 3 charged shot flag for enhanced glow
                // Override bullet color if tracerColor is specified (for weapon 8 ADS)
                if (options.tracerColor) {
                        this.color = options.tracerColor;
                }
                // Oval (pointy) customization (weapon 5)
                this.ovalLength = (options.ovalLength != null) ? options.ovalLength : (this.radius * 5.4);
                this.ovalWidth = (options.ovalWidth != null) ? options.ovalWidth : (this.radius * 2.4);
                this.ovalPoint = (options.ovalPoint != null) ? options.ovalPoint : 0.55; // 0..1 controls how narrow the waist is
                // Impact VFX scale (weapon 3 uses 2x)
                this.impactScale = options.impactScale || 1;
                // Knockback strength applied to enemies on hit (world units of displacement)
                this.knockback = options.knockback || 0;

                // Shadow settings (weapon 2): straight-line shadow toward target at same speed
                this.shadowEnabled = !!options.shadowEnabled && this.targetX != null && this.targetY != null && !this.isCone;
                if (this.shadowEnabled) {
                        this.shadowStartX = x;
                        this.shadowStartY = y;
                        this.shadowTotalDist = Math.hypot(this.targetX - x, this.targetY - y) || 1;
                        this.shadowTravel = 0;
                        this.shadowRadius = Math.max(3, radius * 0.9);
                }
                // Track overall distance to target for speed profiling
                this.totalDist = (this.targetX != null && this.targetY != null) ? Math.hypot(this.targetX - x, this.targetY - y) : null;
                
                // Store explosion multipliers for weapon 2 progression
                this.explosionRadiusMultiplier = options.explosionRadiusMultiplier || 1.0;
                this.explosionDamageMultiplier = options.explosionDamageMultiplier || 1.0;
                
                // Clear ray hit tracking for pooled bullets (prevents old wall hit positions from persisting)
                this._rayHitX = undefined;
                this._rayHitY = undefined;
        }

        update(dt) {
                if (!this.isCone) {
                        if (this.targetX != null && this.targetY != null) {
                                // Force arc to target: use bezier interpolation (overrides steering)
                                if (this.forceArcToTarget && this._arcMaxLife > 0) {
                                        const progress = Math.min(1, 1 - (this.life / this._arcMaxLife));
                                        const invP = 1 - progress;
                                        // Quadratic bezier: B(t) = (1-t)²P0 + 2(1-t)tP1 + t²P2
                                        const oldX = this.x;
                                        const oldY = this.y;
                                        this.x = invP * invP * this._arcStartX + 2 * invP * progress * this._arcCtrlX + progress * progress * this.targetX;
                                        this.y = invP * invP * this._arcStartY + 2 * invP * progress * this._arcCtrlY + progress * progress * this.targetY;
                                        // Update velocity/angle for trail rendering
                                        const moveX = this.x - oldX;
                                        const moveY = this.y - oldY;
                                        if (moveX !== 0 || moveY !== 0) {
                                                this.angle = Math.atan2(moveY, moveX);
                                                this.vx = moveX / dt;
                                                this.vy = moveY / dt;
                                        }
                                        // Decrement life and snap to target on arrival
                                        this.life -= dt;
                                        if (this.life <= 0) {
                                                this.x = this.targetX;
                                                this.y = this.targetY;
                                                this.life = 0;
                                        }
                                        // Update shadow position (linear interpolation)
                                        if (this.shadowEnabled) {
                                                this.shadowX = this.shadowStartX + (this.targetX - this.shadowStartX) * progress;
                                                this.shadowY = this.shadowStartY + (this.targetY - this.shadowStartY) * progress;
                                        }
                                        return; // Skip normal steering/movement
                                }
                                
                                // Steer toward target with limited turn rate to form an arc
                                const dx = this.targetX - this.x;
                                const dy = this.targetY - this.y;
                                const dist = Math.hypot(dx, dy);
                                // Compute ballistic speed shaping (fast early, slow late)
                                let curSpeed = this.baseSpeed;
                                if (this.accelBallistic && this.totalDist) {
                                        const f = Math.max(0, Math.min(1, 1 - (dist / this.totalDist)));
                                        const speedMul = 0.4 + 1.2 * (1 - f) * (1 - f); // fast at start, slows near end
                                        curSpeed = this.baseSpeed * speedMul;
                                }
                                if (dist <= Math.max(this.radius, curSpeed * dt)) {
                                        this.x = this.targetX;
                                        this.y = this.targetY;
                                        this.life = 0;
                                } else {
                                        let desired = Math.atan2(dy, dx);
                                        // add slight bias for more organic arc
                                        desired += this.bias * 0.2;
                                        let delta = desired - this.angle;
                                        while (delta > Math.PI) delta -= Math.PI * 2;
                                        while (delta < -Math.PI) delta += Math.PI * 2;
                                        const maxTurn = this.maxTurnRate * dt;
                                        if (Math.abs(delta) <= maxTurn) this.angle = desired; else this.angle += Math.sign(delta) * maxTurn;
                                        this.vx = Math.cos(this.angle) * curSpeed;
                                        this.vy = Math.sin(this.angle) * curSpeed;
                                }
                        }
                }
                // Movement with optional precise travel distance cap
                if (Number.isFinite(this.travelDistLeft)) {
                        const curSpeed = Math.hypot(this.vx, this.vy) || 0;
                        const step = curSpeed * dt;
                        if (curSpeed > 0 && this.travelDistLeft <= step) {
                                const ux = this.vx / curSpeed;
                                const uy = this.vy / curSpeed;
                                this.x += ux * this.travelDistLeft;
                                this.y += uy * this.travelDistLeft;
                                this.travelDistLeft = 0;
                                this.life = 0;
                        } else {
                                this.x += this.vx * dt;
                                this.y += this.vy * dt;
                                if (curSpeed > 0) this.travelDistLeft -= step;
                                this.life -= dt;
                        }
                } else {
                        this.x += this.vx * dt;
                        this.y += this.vy * dt;
                        this.life -= dt;
                }

                // Update shadow straight-line position
                if (this.shadowEnabled) {
                        // Use same instantaneous speed as projectile for consistent arrival timing
                        const curSpeedForShadow = Math.hypot(this.vx, this.vy) || this.baseSpeed;
                        this.shadowTravel += curSpeedForShadow * dt;
                        const f = Math.min(1, this.shadowTravel / this.shadowTotalDist);
                        this.shadowX = this.shadowStartX + (this.targetX - this.shadowStartX) * f;
                        this.shadowY = this.shadowStartY + (this.targetY - this.shadowStartY) * f;
                }
                
                // Update molotov trail particles
                if (this.deathMolotov && this._trailParticles) {
                        this._trailSpawnTimer += dt;
                        
                        // Spawn new trail particles
                        while (this._trailSpawnTimer >= this._trailSpawnRate) {
                                this._trailSpawnTimer -= this._trailSpawnRate;
                                
                                // Spawn flame particle
                                this._trailParticles.push({
                                        type: 'flame',
                                        x: this.x + (Math.random() - 0.5) * this.radius,
                                        y: this.y + (Math.random() - 0.5) * this.radius,
                                        vx: (Math.random() - 0.5) * 40,
                                        vy: (Math.random() - 0.5) * 40,
                                        life: 0.3 + Math.random() * 0.2,
                                        maxLife: 0.5,
                                        size: 6 + Math.random() * 4,
                                        color: Math.random() > 0.5 ? '#ff6600' : '#ffaa33'
                                });
                                
                                // Spawn smoke particle (less frequent)
                                if (Math.random() < 0.3) {
                                        this._trailParticles.push({
                                                type: 'smoke',
                                                x: this.x + (Math.random() - 0.5) * this.radius * 1.5,
                                                y: this.y + (Math.random() - 0.5) * this.radius * 1.5,
                                                vx: (Math.random() - 0.5) * 20,
                                                vy: -20 - Math.random() * 20, // Rise upward
                                                life: 0.6 + Math.random() * 0.4,
                                                maxLife: 1.0,
                                                size: 8 + Math.random() * 6
                                        });
                                }
                        }
                        
                        // Update existing particles
                        for (let i = this._trailParticles.length - 1; i >= 0; i--) {
                                const p = this._trailParticles[i];
                                p.life -= dt;
                                p.x += p.vx * dt;
                                p.y += p.vy * dt;
                                
                                // Expand smoke over time
                                if (p.type === 'smoke') {
                                        p.size += 15 * dt;
                                }
                                
                                // Remove dead particles
                                if (p.life <= 0) {
                                        this._trailParticles.splice(i, 1);
                                }
                        }
                }
                
                // Crucifix sparkle trail
                if (this.crucifixSparkle && this._trailParticles) {
                        this._trailSpawnTimer += dt;
                        
                        // Spawn sparkle particles
                        while (this._trailSpawnTimer >= this._trailSpawnRate) {
                                this._trailSpawnTimer -= this._trailSpawnRate;
                                
                                // Spawn golden sparkle
                                this._trailParticles.push({
                                        type: 'sparkle',
                                        x: this.x + (Math.random() - 0.5) * this.radius * 2,
                                        y: this.y + (Math.random() - 0.5) * this.radius * 2,
                                        vx: (Math.random() - 0.5) * 30,
                                        vy: (Math.random() - 0.5) * 30,
                                        life: 0.4 + Math.random() * 0.3,
                                        maxLife: 0.7,
                                        size: 3 + Math.random() * 3,
                                        rotation: Math.random() * Math.PI * 2,
                                        rotationSpeed: (Math.random() - 0.5) * 10,
                                        color: Math.random() > 0.5 ? '#d4af37' : '#ffeb3b' // Gold or bright yellow
                                });
                        }
                        
                        // Update existing sparkles
                        for (let i = this._trailParticles.length - 1; i >= 0; i--) {
                                const p = this._trailParticles[i];
                                p.life -= dt;
                                p.x += p.vx * dt;
                                p.y += p.vy * dt;
                                p.rotation += p.rotationSpeed * dt;
                                p.vx *= 0.95; // Slow down
                                p.vy *= 0.95;
                                
                                // Remove dead particles
                                if (p.life <= 0) {
                                        this._trailParticles.splice(i, 1);
                                }
                        }
                }
        }

        draw(ctx, camera) {
                const sx = this.x - camera.x;
                const sy = this.y - camera.y;
                
                // Draw molotov trail particles (behind the fireball)
                if (this.deathMolotov && this._trailParticles) {
                        ctx.save();
                        for (let i = 0; i < this._trailParticles.length; i++) {
                                const p = this._trailParticles[i];
                                const px = p.x - camera.x;
                                const py = p.y - camera.y;
                                const fade = p.life / p.maxLife;
                                
                                if (p.type === 'flame') {
                                        // Draw flame particle with glow
                                        ctx.globalAlpha = fade * 0.8;
                                        
                                        // Outer glow
                                        const grad = ctx.createRadialGradient(px, py, 0, px, py, p.size);
                                        grad.addColorStop(0, p.color);
                                        grad.addColorStop(1, 'rgba(255, 100, 0, 0)');
                                        ctx.fillStyle = grad;
                                        ctx.beginPath();
                                        ctx.arc(px, py, p.size, 0, Math.PI * 2);
                                        ctx.fill();
                                        
                                        // Bright core
                                        ctx.globalAlpha = fade;
                                        ctx.fillStyle = '#ffff99';
                                        ctx.beginPath();
                                        ctx.arc(px, py, p.size * 0.4, 0, Math.PI * 2);
                                        ctx.fill();
                                } else if (p.type === 'smoke') {
                                        // Draw smoke particle (dark grey, expands and fades)
                                        ctx.globalAlpha = fade * 0.4;
                                        const smokeGrad = ctx.createRadialGradient(px, py, 0, px, py, p.size);
                                        smokeGrad.addColorStop(0, 'rgba(60, 60, 60, 0.6)');
                                        smokeGrad.addColorStop(0.5, 'rgba(40, 40, 40, 0.3)');
                                        smokeGrad.addColorStop(1, 'rgba(20, 20, 20, 0)');
                                        ctx.fillStyle = smokeGrad;
                                        ctx.beginPath();
                                        ctx.arc(px, py, p.size, 0, Math.PI * 2);
                                        ctx.fill();
                                }
                        }
                        ctx.restore();
                }
                
                // Draw crucifix sparkle trail particles (behind the crucifix)
                if (this.crucifixSparkle && this._trailParticles) {
                        ctx.save();
                        for (let i = 0; i < this._trailParticles.length; i++) {
                                const p = this._trailParticles[i];
                                const px = p.x - camera.x;
                                const py = p.y - camera.y;
                                const fade = p.life / p.maxLife;
                                
                                // Draw sparkle as rotated star/cross
                                ctx.save();
                                ctx.translate(px, py);
                                ctx.rotate(p.rotation);
                                ctx.globalAlpha = fade * 0.9;
                                
                                // Outer glow
                                ctx.shadowColor = p.color;
                                ctx.shadowBlur = 8;
                                ctx.fillStyle = p.color;
                                
                                // Draw 4-pointed star (sparkle)
                                ctx.beginPath();
                                const ssize = p.size;
                                ctx.moveTo(0, -ssize);
                                ctx.lineTo(ssize * 0.3, -ssize * 0.3);
                                ctx.lineTo(ssize, 0);
                                ctx.lineTo(ssize * 0.3, ssize * 0.3);
                                ctx.lineTo(0, ssize);
                                ctx.lineTo(-ssize * 0.3, ssize * 0.3);
                                ctx.lineTo(-ssize, 0);
                                ctx.lineTo(-ssize * 0.3, -ssize * 0.3);
                                ctx.closePath();
                                ctx.fill();
                                
                                // Bright center dot
                                ctx.globalAlpha = fade;
                                ctx.shadowBlur = 4;
                                ctx.fillStyle = '#ffffff';
                                ctx.beginPath();
                                ctx.arc(0, 0, ssize * 0.4, 0, Math.PI * 2);
                                ctx.fill();
                                
                                ctx.restore();
                        }
                        ctx.restore();
                }
                
                if (this.isCone) {
                        ctx.save();
                        ctx.translate(sx, sy);
                        ctx.rotate(this.angle || 0);
                        const range = (this.coneRange && this.coneRange > 0) ? this.coneRange : (this.radius * 3);
                        const half = this.coneHalf || 0.6;
                        
                        // Enhanced visuals for WallGuy melee attack (brighter, more opaque red)
                        const isWallGuyAttack = this.owner && this.owner.type === 'wallguy';
                        const fillAlpha = isWallGuyAttack ? 0.6 : 0.25;  // More opaque for WallGuy
                        const outlineAlpha = isWallGuyAttack ? 1.0 : 0.9;
                        const glowColor = isWallGuyAttack ? '#ff0000' : this.color; // Bright red for WallGuy
                        
                        // Soft cone fill
                        ctx.beginPath();
                        ctx.moveTo(0, 0);
                        ctx.arc(0, 0, range, -half, half);
                        ctx.closePath();
                        ctx.fillStyle = isWallGuyAttack ? glowColor : this.color;
                        ctx.globalAlpha = fillAlpha;
                        ctx.fill();
                        
                        // Cone outline with glow for WallGuy
                        if (isWallGuyAttack) {
                                ctx.shadowColor = glowColor;
                                ctx.shadowBlur = 12;
                        }
                        ctx.globalAlpha = outlineAlpha;
                        ctx.strokeStyle = isWallGuyAttack ? glowColor : this.color;
                        ctx.lineWidth = isWallGuyAttack ? 3 : 2;
                        ctx.stroke();
                        ctx.restore();
                        return;
                }

                // Shadow drawing (below core) for straight-line path
                if (this.shadowEnabled) {
                        const ssx = this.shadowX - camera.x;
                        const ssy = this.shadowY - camera.y;
                        ctx.save();
                        ctx.fillStyle = 'rgba(0,0,0,0.35)';
                        ctx.beginPath();
                        ctx.arc(ssx, ssy, this.shadowRadius, 0, Math.PI * 2);
                        ctx.fill();
                        ctx.restore();
                }

                // Glowing projectile visuals
                if (this.shape === 'rect') {
                        // Oriented glowing rectangle (weapon 3)
                        ctx.save();
                        ctx.translate(sx, sy);
                        ctx.rotate(this.angle || 0);
                        
                        // Enhanced glow for charged shots
                        if (this.isChargedShot) {
                                // Extra-wide outer glow for charged shots
                                ctx.globalAlpha = 0.25;
                                ctx.fillStyle = this.color;
                                ctx.shadowColor = this.color;
                                ctx.shadowBlur = 40;
                                const superGlowW = this.rectWidth * 2.8;
                                const superGlowH = this.rectHeight * 2.8;
                                ctx.fillRect(-superGlowW / 2, -superGlowH / 2, superGlowW, superGlowH);
                                
                                // White energy core for charged shots
                                ctx.globalAlpha = 0.6;
                                ctx.fillStyle = '#ffffff';
                                ctx.shadowBlur = 25;
                                ctx.shadowColor = '#ffffff';
                                const energyW = this.rectWidth * 1.4;
                                const energyH = this.rectHeight * 1.4;
                                ctx.fillRect(-energyW / 2, -energyH / 2, energyW, energyH);
                        }
                        
                        // Outer glow rectangle
                        ctx.globalAlpha = this.isChargedShot ? 0.5 : 0.35;
                        ctx.fillStyle = this.color;
                        ctx.shadowColor = this.color;
                        ctx.shadowBlur = this.isChargedShot ? 30 : 20;
                        const glowW = this.rectWidth * 2;
                        const glowH = this.rectHeight * 2;
                        ctx.fillRect(-glowW / 2, -glowH / 2, glowW, glowH);
                        
                        // Core rectangle
                        ctx.globalAlpha = 1;
                        ctx.shadowBlur = this.isChargedShot ? 15 : 8;
                        ctx.fillStyle = this.color;
                        ctx.fillRect(-this.rectWidth / 2, -this.rectHeight / 2, this.rectWidth, this.rectHeight);
                        ctx.restore();
                } else if (this.shape === 'oval') {
                        // Pointy oval (lens) projectile (weapon 5)
                        ctx.save();
                        ctx.translate(sx, sy);
                        ctx.rotate(this.angle || 0);
                        // Soft outer glow using a wide ellipse (reduced)
                        ctx.globalAlpha = 0.2;
                        ctx.fillStyle = this.color;
                        ctx.shadowColor = this.color;
                        ctx.shadowBlur = 12;
                        ctx.beginPath();
                        const glowLen = this.ovalLength * 1.2;
                        const glowWid = this.ovalWidth * 1.3;
                        ctx.ellipse(0, 0, glowLen * 0.5, glowWid * 0.5, 0, 0, Math.PI * 2);
                        ctx.fill();
                        // Core pointy oval using two quadratic curves (lens shape)
                        ctx.globalAlpha = 1;
                        ctx.shadowBlur = 8;
                        const L = this.ovalLength;
                        const W = this.ovalWidth;
                        const halfL = L * 0.5;
                        const waistMul = Math.max(0.1, Math.min(1, 1 - this.ovalPoint * 0.5));
                        ctx.fillStyle = this.color;
                        ctx.beginPath();
                        ctx.moveTo(-halfL, 0);
                        ctx.quadraticCurveTo(0, -W * 0.5 * waistMul, halfL, 0);
                        ctx.quadraticCurveTo(0, W * 0.5 * waistMul, -halfL, 0);
                        ctx.closePath();
                        ctx.fill();
                        ctx.restore();
                } else if (this.crucifixSparkle) {
                        // Crucifix projectile (weapon 6) - static orientation (vertical)
                        ctx.save();
                        ctx.translate(sx, sy);
                        
                        // Golden glow
                        ctx.shadowColor = '#d4af37';
                        ctx.shadowBlur = 15;
                        
                        // Crucifix dimensions
                        const scale = this.radius * 0.5;
                        const crossWidth = scale * 0.8;
                        const crossHeight = scale * 2.8;
                        const horizontalBarY = -crossHeight * 0.15; // Move horizontal bar down (was -0.3)
                        const horizontalBarWidth = scale * 2.4;
                        
                        // Draw background/base first (full size, darker)
                        ctx.fillStyle = '#b8930b'; // Darker gold for depth
                        
                        // Vertical bar (base layer) - extend top more, bottom much more
                        const verticalTop = -crossHeight * 0.65; // Start higher (was -0.5)
                        const verticalBottom = crossHeight * 0.65; // End much lower for crucifix shape (was 0.35)
                        ctx.fillRect(-crossWidth / 2, verticalTop, crossWidth, verticalBottom - verticalTop);
                        
                        // Horizontal bar (base layer)
                        ctx.fillRect(-horizontalBarWidth / 2, horizontalBarY - crossWidth / 2, horizontalBarWidth, crossWidth);
                        
                        // Draw main crucifix on top
                        ctx.fillStyle = '#d4af37'; // Gold color
                        const mainScale = 0.85;
                        
                        // Vertical bar (main) - extend top more
                        ctx.fillRect(-crossWidth * mainScale / 2, verticalTop * mainScale, crossWidth * mainScale, (verticalBottom - verticalTop) * mainScale);
                        
                        // Horizontal bar (main)
                        ctx.fillRect(-horizontalBarWidth * mainScale / 2, horizontalBarY - crossWidth * mainScale / 2, horizontalBarWidth * mainScale, crossWidth * mainScale);
                        
                        // Brighter center core
                        ctx.fillStyle = '#ffeb3b'; // Bright yellow
                        const coreScale = 0.6;
                        ctx.fillRect(-crossWidth * coreScale / 2, verticalTop * coreScale, crossWidth * coreScale, (verticalBottom - verticalTop) * coreScale);
                        ctx.fillRect(-horizontalBarWidth * coreScale / 2, horizontalBarY - crossWidth * coreScale / 2, horizontalBarWidth * coreScale, crossWidth * coreScale);
                        
                        ctx.restore();
                } else {
                        // Default: glowing circle projectile
                        ctx.save();
                        // Safety check: ensure radius is positive to prevent createRadialGradient errors
                        const safeRadius = Math.max(0.1, this.radius);
                        const glowRadius = safeRadius * 2.2;
                        const gradient = ctx.createRadialGradient(sx, sy, 0, sx, sy, glowRadius);
                        gradient.addColorStop(0, 'rgba(118,255,176,0.9)');
                        gradient.addColorStop(1, 'rgba(118,255,176,0)');
                        ctx.fillStyle = gradient;
                        ctx.beginPath();
                        ctx.arc(sx, sy, glowRadius, 0, Math.PI * 2);
                        ctx.fill();
                        ctx.beginPath();
                        ctx.arc(sx, sy, safeRadius, 0, Math.PI * 2);
                        ctx.fillStyle = this.color;
                        ctx.shadowColor = this.color;
                        ctx.shadowBlur = 8;
                        ctx.fill();
                        ctx.restore();
                }
        }
}


class ImpactVfx {
        constructor(x, y, color, dirX = 0, dirY = 1, options = {}) {
                this.x = x;
                this.y = y;
                this.totalLife = 0.22;
                this.life = this.totalLife;
                this.color = color;
                this.scale = options.scale || 1;
                const baseAngle = Math.atan2(dirY, dirX) || 0;
                const num = 12 + Math.floor(WorldRNG.random() * 6);
                this.sparks = [];
                for (let i = 0; i < num; i++) {
                        const angle = baseAngle + (WorldRNG.random() - 0.5) * (Math.PI * 2 / 3);
                        this.sparks.push({
                                angle,
                                maxDist: (10 + WorldRNG.random() * 20) * this.scale,
                                length: (3 + WorldRNG.random() * 6) * this.scale,
                                width: (1 + WorldRNG.random() * 1.2) * this.scale,
                                alpha: 0.85 + WorldRNG.random() * 0.15
                        });
                }
        }
        update(dt) { this.life -= dt; }
        draw(ctx, camera) {
                const progress = 1 - Math.max(this.life, 0) / this.totalLife;
                const ease = progress * (2 - progress);
                const sx = this.x - camera.x;
                const sy = this.y - camera.y;
                ctx.save();
                ctx.lineCap = 'round';
                for (let i = 0; i < this.sparks.length; i++) {
                        const s = this.sparks[i];
                        const dist = s.maxDist * ease;
                        const ex = sx + Math.cos(s.angle) * dist;
                        const ey = sy + Math.sin(s.angle) * dist;
                        const bx = ex - Math.cos(s.angle) * s.length;
                        const by = ey - Math.sin(s.angle) * s.length;
                        ctx.globalAlpha = (1 - progress) * s.alpha;
                        ctx.strokeStyle = this.color;
                        ctx.lineWidth = s.width;
                        ctx.beginPath();
                        ctx.moveTo(bx, by);
                        ctx.lineTo(ex, ey);
                        ctx.stroke();
                }
                ctx.restore();
        }
}

        class ExplosionVfx {
        constructor(x, y, color, options = {}) {
                // Use init() so instances can be reused by object pooling.
                this.sparks = [];
                this.smokes = [];
                this.init(x, y, color, options);
        }

        // Reset/reinitialize without allocations (pool-friendly)
        init(x, y, color, options = {}) {
                this.x = x;
                this.y = y;
                this.totalLife = 0.6;
                this.life = this.totalLife;
                this.color = color || '#ffae00';
                this.scale = options.scale || 1;
                if (window.DEBUG_EXPLOSION_VFX === true) {
                        // Debug-only: logging here can severely impact FPS during combat.
                        console.log('[ExplosionVfx] init scale:', this.scale.toFixed(2));
                }
                // Optional palette overrides for shock ring, sparks, flash and smoke
                this.shockColor = options.shockColor || '#ffd36b';
                this.sparkColor = options.sparkColor || '#ff9f2b';
                this.flashColor = options.flashColor || 'rgba(255,255,180,0.9)';
                this.smokeColor = options.smokeColor || 'rgba(80,80,80,1)';

                // Pre-generate particles (reuse arrays)
                const sparkCount = 18 + Math.floor(WorldRNG.random() * 10);
                this.sparks.length = 0;
                for (let i = 0; i < sparkCount; i++) {
                        const angle = WorldRNG.random() * Math.PI * 2;
                        this.sparks.push({
                                angle,
                                maxDist: (60 + WorldRNG.random() * 120) * this.scale,
                                length: (6 + WorldRNG.random() * 10) * this.scale,
                                width: (1 + WorldRNG.random() * 1.5) * Math.sqrt(this.scale),
                                alpha: 0.8 + WorldRNG.random() * 0.2
                        });
                }
                const smokeCount = 8 + Math.floor(WorldRNG.random() * 5);
                this.smokes.length = 0;
                for (let i = 0; i < smokeCount; i++) {
                        const angle = WorldRNG.random() * Math.PI * 2;
                        const dist = (10 + WorldRNG.random() * 30) * this.scale;
                        this.smokes.push({ angle, dist, baseR: (8 + WorldRNG.random() * 10) * this.scale, grow: (40 + WorldRNG.random() * 40) * this.scale, alpha: 0.35 + WorldRNG.random() * 0.15 });
                }
        }
        update(dt) { this.life -= dt; }
        draw(ctx, camera) {
                const t = 1 - Math.max(this.life, 0) / this.totalLife; // 0..1
                const ease = t * (2 - t);
                const sx = this.x - camera.x;
                const sy = this.y - camera.y;
                ctx.save();
                // Initial flash
                if (t < 0.2) {
                        const flashR = 90 * this.scale * (1 - t / 0.2);
                        if (window.DEBUG_EXPLOSION_VFX === true && t < 0.05 && this.scale !== 1) {
                                console.log('[ExplosionVfx] Drawing flash - scale:', this.scale.toFixed(2), 'flashR:', flashR.toFixed(1));
                        }
                        const grad = ctx.createRadialGradient(sx, sy, 0, sx, sy, flashR);
                        grad.addColorStop(0, this.flashColor);
                        grad.addColorStop(1, 'rgba(255,255,180,0)');
                        ctx.fillStyle = grad;
                        ctx.beginPath();
                        ctx.arc(sx, sy, flashR, 0, Math.PI * 2);
                        ctx.fill();
                }
                // Shockwave ring
                const shockR = (20 + ease * 140) * this.scale;
                ctx.globalAlpha = 1 - t;
                ctx.strokeStyle = this.shockColor;
                ctx.lineWidth = 3 * Math.sqrt(this.scale);
                ctx.beginPath();
                ctx.arc(sx, sy, shockR, 0, Math.PI * 2);
                ctx.stroke();
                ctx.globalAlpha = 1;
                // Sparks
                ctx.lineCap = 'round';
                for (let i = 0; i < this.sparks.length; i++) {
                        const s = this.sparks[i];
                        const dist = s.maxDist * ease;
                        const ex = sx + Math.cos(s.angle) * dist;
                        const ey = sy + Math.sin(s.angle) * dist;
                        const bx = ex - Math.cos(s.angle) * s.length;
                        const by = ey - Math.sin(s.angle) * s.length;
                        ctx.globalAlpha = (1 - t) * s.alpha;
                        ctx.strokeStyle = this.sparkColor;
                        ctx.lineWidth = s.width;
                        ctx.beginPath();
                        ctx.moveTo(bx, by);
                        ctx.lineTo(ex, ey);
                        ctx.stroke();
                }
                ctx.globalAlpha = 1;
                // Smoke puffs
                for (let i = 0; i < this.smokes.length; i++) {
                        const s = this.smokes[i];
                        const px = sx + Math.cos(s.angle) * (s.dist * (0.5 + 0.5 * ease));
                        const py = sy + Math.sin(s.angle) * (s.dist * (0.5 + 0.5 * ease));
                        const r = s.baseR + s.grow * ease;
                        ctx.globalAlpha = s.alpha * (1 - t);
                        ctx.fillStyle = this.smokeColor;
                        ctx.beginPath();
                        ctx.arc(px, py, r, 0, Math.PI * 2);
                        ctx.fill();
                }
                ctx.restore();
        }
}

class SlashVfx {
        constructor(x, y, angle, color) {
                this.x = x;
                this.y = y;
                this.angle = angle;
                this.color = color || '#ff4d4d';
                this.totalLife = 0.25;
                this.life = this.totalLife;
                this.slashes = [];
                const count = 6 + Math.floor(WorldRNG.random() * 4);
                for (let i = 0; i < count; i++) {
                        // Tangent orientation: base at ±90° relative to attack, with small jitter
                        const base = WorldRNG.random() < 0.5 ? (Math.PI / 2) : (-Math.PI / 2);
                        const jitter = base + (WorldRNG.random() - 0.5) * 0.6; // tighten around tangent
                        const len = 24 + WorldRNG.random() * 32; // ~2x longer
                        const width = 2 + WorldRNG.random() * 3; // thicker
                        const offsetR = WorldRNG.random() * 12;
                        const offsetAng = (WorldRNG.random() - 0.5) * 0.6; // keep near attack axis
                        this.slashes.push({ jitter, len, width, offsetR, offsetAng });
                }
        }
        update(dt) { this.life -= dt; }
        draw(ctx, camera) {
                const t = Math.max(this.life, 0) / this.totalLife;
                const alpha = t;
                const sx = this.x - camera.x;
                const sy = this.y - camera.y;
                ctx.save();
                ctx.translate(sx, sy);
                ctx.rotate(this.angle);
                ctx.strokeStyle = this.color;
                for (let i = 0; i < this.slashes.length; i++) {
                        const s = this.slashes[i];
                        const ang = s.jitter;
                        const ox = Math.cos(s.offsetAng) * s.offsetR;
                        const oy = Math.sin(s.offsetAng) * s.offsetR;
                        const dx = Math.cos(ang) * (s.len / 2);
                        const dy = Math.sin(ang) * (s.len / 2);
                        ctx.globalAlpha = alpha * 0.9;
                        ctx.lineWidth = s.width;
                        ctx.beginPath();
                        ctx.moveTo(ox - dx, oy - dy);
                        ctx.lineTo(ox + dx, oy + dy);
                        ctx.stroke();
                }
                ctx.restore();
        }
}

// Charge shot VFX for weapon 3: reverse ripple converging effect while charging, sparkles when fully charged
class ChargeVfx {
	constructor(x, y, color, isAttachedToPlayer = true) {
		// Safety check: ensure position values are finite
		this.x = Number.isFinite(x) ? x : 0;
		this.y = Number.isFinite(y) ? y : 0;
		this.color = color || '#76b0ff';
		this.chargeProgress = 0; // 0..1
		this.totalLife = null; // Infinite until charge is released or cancelled
		this.life = null;
		this.isAttachedToPlayer = isAttachedToPlayer; // If true, VFX follows player position
		this.fullyCharged = false;
		
		// Reverse ripple config (converging inward while charging)
		this.ripples = [];
		this.rippleSpawnTimer = 0;
		this.rippleSpawnRate = 0.12; // Spawn a new ripple every 0.12s
		
		// Sparkle particles (shown when fully charged)
		this.sparkles = [];
		this.sparkleSpawnTimer = 0;
		this.sparkleSpawnRate = 0.05; // Spawn sparkles more frequently when charged
	}
	
	setChargeProgress(progress) {
		this.chargeProgress = Math.max(0, Math.min(1, progress));
		this.fullyCharged = this.chargeProgress >= 1;
	}
	
	updatePosition(x, y) {
		// Always update position (not gated by isAttachedToPlayer anymore)
		// Safety check: ensure position values are finite
		if (Number.isFinite(x) && Number.isFinite(y)) {
			this.x = x;
			this.y = y;
		}
	}
	
	update(dt) {
		// Charging phase: spawn converging ripples
		if (!this.fullyCharged && this.chargeProgress > 0) {
			this.rippleSpawnTimer += dt;
			
			// Spawn rate increases with charge progress
			const adjustedRate = this.rippleSpawnRate * (1.5 - this.chargeProgress * 0.5);
			
			while (this.rippleSpawnTimer >= adjustedRate) {
				this.rippleSpawnTimer -= adjustedRate;
				
				// Spawn ripple at outer radius, will converge inward (30% scale)
				const angle = WorldRNG.random() * Math.PI * 2;
				const startRadius = (80 + WorldRNG.random() * 40) * 0.3; // 30% scale
				
				this.ripples.push({
					angle: angle,
					radius: startRadius,
					targetRadius: 0, // Converge to center
					speed: (120 + this.chargeProgress * 180) * 0.3, // Faster as charge increases, 30% scale
					alpha: 0.4 + this.chargeProgress * 0.4,
					thickness: (2 + this.chargeProgress * 2) * 0.3, // 30% scale
					life: 0.6,
					maxLife: 0.6
				});
			}
			
			// Update ripples (move inward)
			for (let i = this.ripples.length - 1; i >= 0; i--) {
				const r = this.ripples[i];
				r.radius -= r.speed * dt;
				r.life -= dt;
				
				// Remove ripples that reached center or expired
				if (r.radius <= 5 || r.life <= 0) {
					this.ripples.splice(i, 1);
				}
			}
		}
		
		// Fully charged phase: spawn inward streaks and pulse effect
		if (this.fullyCharged) {
			this.sparkleSpawnTimer += dt;
			
			while (this.sparkleSpawnTimer >= this.sparkleSpawnRate) {
				this.sparkleSpawnTimer -= this.sparkleSpawnRate;
				
				// Spawn inward-pointing streak (30% scale)
				const angle = WorldRNG.random() * Math.PI * 2;
				const dist = (15 + WorldRNG.random() * 25) * 0.3; // 30% scale - spawn at outer radius
				
				this.sparkles.push({
					angle: angle, // Direction from center
					startDist: dist, // Starting distance from center
					currentDist: dist,
					length: (6 + WorldRNG.random() * 10) * 0.3, // 30% scale - streak length
					width: (1.5 + WorldRNG.random() * 2) * 0.3, // 30% scale - streak width
					speed: (40 + WorldRNG.random() * 20) * 0.3, // 30% scale - speed moving inward
					life: 0.4 + WorldRNG.random() * 0.3,
					maxLife: 0.7,
					alpha: 0.8 + WorldRNG.random() * 0.2,
					color: WorldRNG.random() > 0.5 ? this.color : '#ffffff'
				});
			}
			
			// Update inward streaks
			for (let i = this.sparkles.length - 1; i >= 0; i--) {
				const s = this.sparkles[i];
				s.life -= dt;
				// Move inward toward center
				s.currentDist -= s.speed * dt;
				
				// Remove streaks that reached center or expired
				if (s.currentDist <= 0 || s.life <= 0) {
					this.sparkles.splice(i, 1);
				}
			}
		}
	}
	
	draw(ctx, camera) {
		const sx = this.x - camera.x;
		const sy = this.y - camera.y;
		
		// Safety check: ensure all values are finite
		if (!Number.isFinite(sx) || !Number.isFinite(sy) || !Number.isFinite(this.chargeProgress)) {
			console.warn('[ChargeVfx] Non-finite values detected, skipping draw', { sx, sy, chargeProgress: this.chargeProgress });
			return;
		}
		
		// Helper to convert hex color to rgba
		const hexToRgba = (hex, alpha) => {
			const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
			if (result) {
				const r = parseInt(result[1], 16);
				const g = parseInt(result[2], 16);
				const b = parseInt(result[3], 16);
				return `rgba(${r}, ${g}, ${b}, ${alpha})`;
			}
			return `rgba(118, 176, 255, ${alpha})`; // fallback
		};
		
		ctx.save();
		
		// Draw converging ripples (charging phase)
		if (!this.fullyCharged && this.chargeProgress > 0) {
			for (let i = 0; i < this.ripples.length; i++) {
				const r = this.ripples[i];
				const fade = r.life / r.maxLife;
				
				// Draw converging ring
				ctx.globalAlpha = fade * r.alpha;
				ctx.strokeStyle = this.color;
				ctx.lineWidth = r.thickness;
				ctx.beginPath();
				ctx.arc(sx, sy, r.radius, 0, Math.PI * 2);
				ctx.stroke();
				
				// Inner glow for intensity
				if (r.radius < 30) {
					ctx.globalAlpha = fade * r.alpha * 0.5;
					const innerGrad = ctx.createRadialGradient(sx, sy, 0, sx, sy, r.radius);
					innerGrad.addColorStop(0, hexToRgba(this.color, 0.3));
					innerGrad.addColorStop(1, hexToRgba(this.color, 0));
					ctx.fillStyle = innerGrad;
					ctx.beginPath();
					ctx.arc(sx, sy, r.radius, 0, Math.PI * 2);
					ctx.fill();
				}
			}
			
			// Draw intensity buildup at center (30% scale)
			const centerPulse = Math.sin(Date.now() * 0.01) * 0.3 + 0.7;
			const centerRadius = 15 * this.chargeProgress * centerPulse * 0.3; // 30% scale
			ctx.globalAlpha = this.chargeProgress * 0.6;
			const centerGrad = ctx.createRadialGradient(sx, sy, 0, sx, sy, centerRadius);
			centerGrad.addColorStop(0, '#ffffff');
			centerGrad.addColorStop(0.5, this.color);
			centerGrad.addColorStop(1, hexToRgba(this.color, 0));
			ctx.fillStyle = centerGrad;
			ctx.beginPath();
			ctx.arc(sx, sy, centerRadius, 0, Math.PI * 2);
			ctx.fill();
		}
		
		// Draw fully charged effect (pulsing ring + sparkles)
		if (this.fullyCharged) {
			// Pulsing charged ring (30% scale)
			const pulse = Math.sin(Date.now() * 0.012) * 0.4 + 0.6;
			const chargedRadius = 35 * pulse * 0.3; // 30% scale
			
			// Outer ring glow
			ctx.globalAlpha = 0.8 * pulse;
			ctx.strokeStyle = '#ffffff';
			ctx.lineWidth = 4 * 0.3; // 30% scale
			ctx.shadowColor = this.color;
			ctx.shadowBlur = 15 * 0.3; // 30% scale
			ctx.beginPath();
			ctx.arc(sx, sy, chargedRadius, 0, Math.PI * 2);
			ctx.stroke();
			
			// Inner filled glow
			ctx.globalAlpha = 0.4 * pulse;
			ctx.shadowBlur = 25 * 0.3; // 30% scale
			const chargedGrad = ctx.createRadialGradient(sx, sy, 0, sx, sy, chargedRadius);
			chargedGrad.addColorStop(0, '#ffffff');
			chargedGrad.addColorStop(0.4, this.color);
			chargedGrad.addColorStop(1, hexToRgba(this.color, 0));
			ctx.fillStyle = chargedGrad;
			ctx.beginPath();
			ctx.arc(sx, sy, chargedRadius, 0, Math.PI * 2);
			ctx.fill();
			
			// Draw inward-pointing streaks
			ctx.shadowBlur = 0;
			ctx.lineCap = 'round';
			for (let i = 0; i < this.sparkles.length; i++) {
				const s = this.sparkles[i];
				const fade = s.life / s.maxLife;
				
				// Calculate current position (moving inward from outer radius)
				const currentX = Math.cos(s.angle) * s.currentDist;
				const currentY = Math.sin(s.angle) * s.currentDist;
				
				// Calculate streak endpoints (pointing inward toward center)
				const tailX = sx + currentX;
				const tailY = sy + currentY;
				const headX = tailX - Math.cos(s.angle) * s.length;
				const headY = tailY - Math.sin(s.angle) * s.length;
				
				// Draw streak line
				ctx.globalAlpha = fade * s.alpha;
				ctx.strokeStyle = s.color;
				ctx.lineWidth = s.width;
				ctx.beginPath();
				ctx.moveTo(tailX, tailY);
				ctx.lineTo(headX, headY);
				ctx.stroke();
			}
		}
		
		ctx.restore();
	}
}

// Removed melee helpers and cone VFX for reset

class Weapon {
        constructor(opts) {
                this.name = opts.name;
                this.fireRate = opts.fireRate; // shots per second
                this.projectileSpeed = opts.projectileSpeed;
                this.projectileRadius = opts.projectileRadius;
                this.projectileLife = opts.projectileLife;
                this.color = opts.color;
                this.type = 'projectile';
                this.trigger = opts.trigger || 'auto'; // 'auto' | 'semi'
        }
}

class Weapons {
        constructor() {
                this.fireCooldown = 0;
                this.items = [];
                this.impacts = [];
        this.targetRing = null;
                // Weapon 5 (index 4) burst state
                this.burst5 = { active: false, shotsRemaining: 0, timer: 0, interval: 0.08, ux: 0, uy: 0, angle: 0 };
                // Weapon 7 (index 6) ammo/reload state
                this.ammo7Max = 60; // Base max ammo (modified by loot level)
                this.ammo7 = this.ammo7Max; // Will be adjusted on first update based on player loot level
                this.ammo7ReloadSecondsBase = 3.0;
                this.ammo7ReloadSeconds = this.ammo7ReloadSecondsBase; // Effective (loot-scaled)
                this.ammo7ReloadTimer = 0; // seconds remaining; >0 means reloading
                this._reloadHintCooldown = 0; // seconds; throttle overhead 'Reloading' hint
                this._lastLootLevel = null; // Track loot level changes for weapon 7 ammo cap
                
                // Weapon 8 (index 7) state
                this.recoil8 = 0;
                this.recoil8Visual = 0; // Visual recoil for crosshair (snaps out, settles quickly)
                this.recoil8PeakTracker = 0; // Track peak recoil for consistent slow decay
                this.isADS = false;
                this.currentZoom = 1.0; // Current zoom level (smoothly interpolates)
                this.targetZoom = 1.0;  // Target zoom level
                
                const colors = ['#76ffb0','#ff7676','#76b0ff','#ffb076','#b076ff','#76ffd8','#ffd876','#76ff76','#ff76e8','#ffffff'];
                this.weapons = colors.map((c, i) => new Weapon({
                        name: 'Blaster ' + (i + 1),
                        fireRate: i === 7 ? 14.0 : ((i === 0 ? 24 : i === 2 ? 10 : 6.8) * (i === 3 ? 4 : 1) * (i === 4 ? 0.75 : 1)),
                        projectileSpeed: i === 0 ? 0 : ((i === 6 || i === 7) ? 16000 : 600),
                        projectileRadius: i === 0 ? 40 : 6,
                        projectileLife: (i === 0) ? 0.1 : (i === 3 ? 0.36 : 3.6),
                        color: c,
                        trigger: (i === 0 || i === 1 || i === 2 || i === 4 || i === 7) ? 'semi' : 'auto'
                }));
                this.currentIndex = 0;
                
		// Secondary fire state
		this.secondaryHeld = false;
		this.secondaryJustPressed = false;
		this.secondaryJustReleased = false;
		this.secondaryIndicator = null;
		
		// Weapon 3 charge shot state
		this.charge3 = {
			active: false,          // Whether currently charging
			chargeTime: 0,          // Time held (seconds)
			maxChargeTime: 0.8,     // Time to reach full charge (from config)
			vfx: null               // ChargeVfx instance
		};
	}
        // Get effective max ammo for weapon 7 based on loot level
        getWeapon7MaxAmmo(player) {
                try {
                        const lootLevel = player?.getEffectiveLootLevel?.() || 0;
                        const progression = window.getWeaponProgression?.(6, lootLevel) || {};
                        const ammoMaxMultiplier = progression.primary?.ammoMaxMultiplier || 1.0;
                        return Math.floor(this.ammo7Max * ammoMaxMultiplier);
                } catch(_) {
                        return this.ammo7Max;
                }
        }

        // Get effective reload seconds for weapon 7 based on PRIMARY loot tiers
        // loot 0-1 => 3.0s, loot 2-3 => 2.5s, loot 4-6 => 2.0s
        getWeapon7ReloadSeconds(player) {
                const base = (typeof this.ammo7ReloadSecondsBase === 'number' && Number.isFinite(this.ammo7ReloadSecondsBase))
                        ? this.ammo7ReloadSecondsBase
                        : 3.0;
                try {
                        const lootLevel = player?.getEffectiveLootLevel?.() || 0;
                        if (lootLevel >= 4) return 2.0;
                        if (lootLevel >= 2) return 2.5;
                        return base;
                } catch(_) {
                        return base;
                }
        }
        
        requestReload() {
                try {
                        if (this.currentIndex !== 6) return;
                        if (this.ammo7ReloadTimer > 0) return;
                        const effectiveMax = this.getWeapon7MaxAmmo(window.player);
                        if (this.ammo7 >= effectiveMax) return;
                        this.ammo7ReloadTimer = this.getWeapon7ReloadSeconds(window.player);
                } catch(_) {}
        }


        get current() { return this.weapons[this.currentIndex]; }
        next() { 
            this._cancelCharge3();
            this.currentIndex = (this.currentIndex + 1) % this.weapons.length; 
        }
        setByName(name) { 
            const idx = this.weapons.findIndex(w => w.name === name); 
            if (idx >= 0) {
                this._cancelCharge3();
                this.currentIndex = idx;
            }
        }
        setIndex(index) { 
            if (Number.isFinite(index)) { 
                const n = this.weapons.length; 
                const newIndex = Math.max(0, Math.min(n - 1, index));
                if (newIndex !== this.currentIndex) {
                    this._cancelCharge3();
                }
                this.currentIndex = newIndex;
            } 
        }
        
        // Helper to cancel weapon 3 charge when switching weapons
        _cancelCharge3() {
            if (this.charge3.active) {
                // Send charge cancel event to other players
                if (window.networkManager && window.player) {
                    window.networkManager.sendVfxCreated('chargeEnd', window.player.x, window.player.y, {
                        playerId: window.networkManager.playerId
                    });
                }
                
                this.charge3.active = false;
                this.charge3.chargeTime = 0;
                this.charge3.vfx = null;
            }
        }

        tryFire(dt, player, mouseScreen, camera, opts = {}, enemies, environment) {
                this.fireCooldown -= dt;
                const w = this.current;
                
                // Compute effective fire rate with player's attack speed bonuses (percent)
                let effectiveFireRate = w.fireRate;
                try {
                        const atkPct = Math.max(0, Math.min(500, player?.getTotalAttackSpeedPercent?.() || 0));
                        // fireRate scales multiplicatively: base * (1 + atkPct/100)
                        effectiveFireRate = w.fireRate * (1 + atkPct / 100);
                } catch(_) {}
                
                // Weapon 4: apply loot-based fire rate multiplier
                if (this.currentIndex === 3) {
                        const lootLevel = player?.getEffectiveLootLevel?.() || 0;
                        const progression = window.getWeaponProgression?.(3, lootLevel) || {};
                        const fireRateMultiplier = progression.primary?.fireRateMultiplier || 1.0;
                        effectiveFireRate *= fireRateMultiplier;
                }
                
                // Weapon 7: apply loot-based fire rate multiplier
                if (this.currentIndex === 6) {
                        const lootLevel = player?.getEffectiveLootLevel?.() || 0;
                        const progression = window.getWeaponProgression?.(6, lootLevel) || {};
                        const fireRateMultiplier = progression.primary?.fireRateMultiplier || 1.0;
                        effectiveFireRate *= fireRateMultiplier;
                }
                
                // Weapon 8: apply loot-based fire rate multiplier
                if (this.currentIndex === 7) {
                        const lootLevel = player?.getEffectiveLootLevel?.() || 0;
                        const progression = window.getWeaponProgression?.(7, lootLevel) || {};
                        const fireRateMultiplier = progression.primary?.fireRateMultiplier || 1.0;
                        effectiveFireRate *= fireRateMultiplier;
                }

        // Weapon 2 ring management: create once on press, update while held, finalize on release
        if (this.currentIndex === 1) {
            if (opts?.justPressed && !this.targetRing) {
                // Get explosion radius multiplier for proper ring sizing
                const lootLevel = player?.getEffectiveLootLevel?.() || 0;
                const progression = window.getWeaponProgression?.(1, lootLevel) || {};
                const explosionRadiusMultiplier = progression.primary?.explosionRadiusMultiplier || 1.0;
                if (window.DEBUG_WEAPON2_EXPLOSIONS === true) {
                    console.log('[Weapon2] Creating targeting ring - loot:', lootLevel, 'mult:', explosionRadiusMultiplier, 'ringRadius:', (100 * explosionRadiusMultiplier).toFixed(1));
                }
                
                // Account for zoom when calculating world mouse position
                const _ringCx = (window.state?.viewportWidth || 1920) / 2;
                const _ringCy = (window.state?.viewportHeight || 1080) / 2;
                const _ringZoom = (window.clientRender?.zoomLevel) || 1.0;
                this.targetRing = {
                    cx: camera.x + _ringCx + (mouseScreen.x - _ringCx) / _ringZoom,
                    cy: camera.y + _ringCy + (mouseScreen.y - _ringCy) / _ringZoom,
                    color: w.color,
                    fadeIn: 1.0,
                    elapsed: 0,
                    alpha: 0,
                    fadeOut: 0.35,
                    fadingOut: false,
                    autoTimer: 0,
                    autoDelay: 0.6,
                    explosionRadiusMultiplier: explosionRadiusMultiplier // Store for drawing
                };
            }
            if (opts?.mouseDown && this.targetRing) {
                // Account for zoom when calculating world mouse position
                const _ringCx2 = (window.state?.viewportWidth || 1920) / 2;
                const _ringCy2 = (window.state?.viewportHeight || 1080) / 2;
                const _ringZoom2 = (window.clientRender?.zoomLevel) || 1.0;
                this.targetRing.cx = camera.x + _ringCx2 + (mouseScreen.x - _ringCx2) / _ringZoom2;
                this.targetRing.cy = camera.y + _ringCy2 + (mouseScreen.y - _ringCy2) / _ringZoom2;
                this.targetRing.autoTimer = 0;
            }
        }
        // Weapon 3: Charge shot mechanic (hold to charge, release to fire)
        if (this.currentIndex === 2) {
            if (opts?.justPressed) {
                // Start charging
                this.charge3.active = true;
                this.charge3.chargeTime = 0;
                
                // Create charge VFX
                const lootLevel = player?.getEffectiveLootLevel?.() || 0;
                const progression = window.getWeaponProgression?.(2, lootLevel) || {};
                this.charge3.maxChargeTime = (progression.primary?.chargeTimeMs || 800) / 1000;
                
                // Calculate weapon tip position for initial VFX spawn
                const dx = mouseScreen.x - (player.x - camera.x);
                const dy = mouseScreen.y - (player.y - camera.y);
                const len = Math.hypot(dx, dy) || 1;
                const ux = dx / len;
                const uy = dy / len;
                const tipOffset = 50; // Match the aim indicator length for exact tip position
                const tipX = player.x + ux * tipOffset;
                const tipY = player.y + uy * tipOffset;
                
                // Always create new VFX on press at weapon tip
                this.charge3.vfx = new ChargeVfx(tipX, tipY, w.color, false);
                this.charge3.vfx.setChargeProgress(0);
                
                // Send charge start event to other players
                if (window.networkManager && player === window.player) {
                    window.networkManager.sendVfxCreated('chargeStart', tipX, tipY, {
                        color: w.color,
                        playerId: window.networkManager.playerId,
                        weaponIndex: this.currentIndex
                    });
                }
            }
            
            if (opts?.mouseDown && this.charge3.active) {
                // Continue charging (handled in update)
                return;
            }
            
            if (opts?.justReleased && this.charge3.active) {
                // Release charge shot (will fire below)
                // Don't return, let it fire
            } else {
                // Not releasing, don't fire
                return;
            }
        }
        
        // Gate semi-auto weapons (1 and 2) on click edge
        if (this.currentIndex === 1) {
            // Weapon 2: fire on mouse release
            if (!opts?.justReleased) {
                return;
            }
        } else if (w.trigger === 'semi' && this.currentIndex !== 2) {
            if (!opts?.justPressed) {
                return;
            }
        }

        // Weapon 7: block firing while reloading or out of ammo
        if (this.currentIndex === 6) {
            if (this.ammo7ReloadTimer > 0) {
                return; // cannot fire while reloading
            }
            if ((this.ammo7 || 0) <= 0) return; // empty mag (auto-reload will start)
        }

                const uncapped = false;
                if (!uncapped && this.fireCooldown > 0) {
                        if (this.currentIndex === 1 && this.targetRing) {
                                this.targetRing.fadingOut = true;
                        }
                        return;
                }
                
                // Set firing cooldown immediately to prevent multiple fire events
                this.fireCooldown = uncapped ? 0 : (1 / effectiveFireRate);
                
                const px = player.x;
                const py = player.y;
                const screenX = px - camera.x;
                const screenY = py - camera.y;
                let aimScreenX = mouseScreen.x;
                let aimScreenY = mouseScreen.y;
                
                // Weapon 7: lock aim to active target while firing (left mouse held)
                if (this.currentIndex === 6 && opts && opts.mouseDown && typeof window !== 'undefined') {
                        try {
                                const radius = 350;
                                let active = null;
                                const myEvil = (typeof window !== 'undefined' && window.__killThemAllLocked === true);
                                
                                // Build list of valid targets (enemies + hostile NPCs + opposite-alignment players)
                                const targets = [];
                                
                                // Add enemies
                                if (window.enemies && typeof window.enemies.queryCircle === 'function') {
                                        const enemyList = window.enemies.queryCircle(px, py, radius) || [];
                                        for (let i = 0; i < enemyList.length; i++) {
                                                const e = enemyList[i];
                                                if (e && e.alive) targets.push(e);
                                        }
                                }
                                
                                // Add hostile NPCs (like Heretic Priest when hostile)
                                if (window.npcs && window.npcs.items) {
                                        for (let i = 0; i < window.npcs.items.length; i++) {
                                                const npc = window.npcs.items[i];
                                                if (!npc || !npc.alive) continue;
                                                if (npc.name === 'NPC_B' && npc.state === 'hostile') {
                                                        const dxn = npc.x - px;
                                                        const dyn = npc.y - py;
                                                        if (dxn * dxn + dyn * dyn <= radius * radius) {
                                                                targets.push(npc);
                                                        }
                                                }
                                        }
                                }
                                
                                // Add opposite-alignment players in PvP (multiplayer-only game)
                                if (window.networkManager?.otherPlayers) {
                                        for (const [otherId, otherData] of window.networkManager.otherPlayers) {
                                                if (!otherData || otherData.health <= 0) continue;
                                                const otherEvil = window.networkManager.remotePlayerEvilStates?.get(otherId) || false;
                                                if (myEvil !== otherEvil) { // opposite alignment
                                                        const dxp = otherData.x - px;
                                                        const dyp = otherData.y - py;
                                                        if (dxp * dxp + dyp * dyp <= radius * radius) {
                                                                targets.push({ x: otherData.x, y: otherData.y, radius: otherData.radius || 26, alive: true, isPvpTarget: true, id: otherId });
                                                        }
                                                }
                                        }
                                }
                                
                                // Mouse-over wins
                                try {
                                        const mwx = (window._mouseWorldX != null) ? window._mouseWorldX : (camera.x + (window.state?.mouse?.x || 0));
                                        const mwy = (window._mouseWorldY != null) ? window._mouseWorldY : (camera.y + (window.state?.mouse?.y || 0));
                                        let bestHoverD2 = Infinity;
                                        for (let i = 0; i < targets.length; i++) {
                                                const e = targets[i];
                                                if (!e || !e.alive) continue;
                                                const dxm = mwx - e.x;
                                                const dym = mwy - e.y;
                                                const rad = (e.radius || 24);
                                                const d2m = dxm * dxm + dym * dym;
                                                if (d2m <= rad * rad && d2m < bestHoverD2) { bestHoverD2 = d2m; active = e; }
                                        }
                                } catch(_) {}
                                // Fallback: closest to player within radius
                                if (!active) {
                                        let bestD2 = Infinity;
                                        for (let i = 0; i < targets.length; i++) {
                                                const e = targets[i];
                                                if (!e || !e.alive) continue;
                                                const dxp = e.x - px;
                                                const dyp = e.y - py;
                                                const d2 = dxp * dxp + dyp * dyp;
                                                if (d2 < bestD2) { bestD2 = d2; active = e; }
                                        }
                                }
                                if (active) { 
                                        // Check if environment walls or WallGuy shields block line of sight to active target
                                        let blockedByWall = false;
                                        
                                        // Check environment walls first (cheaper check)
                                        if (window.environment && typeof window.environment.lineHitsAny === 'function') {
                                                blockedByWall = window.environment.lineHitsAny(px, py, active.x, active.y);
                                        }
                                        
                                        if (!blockedByWall) {
                                                // Check WallGuy shields (only if not already blocked by walls)
                                                let blockedByShield = false;
                                                try {
                                                        const enemyList = window.enemies?.items || [];
                                                        for (const wallguy of enemyList) {
                                                                if (!wallguy || !wallguy.alive || wallguy.type !== 'wallguy') continue;
                                                                if (!wallguy.shield || !wallguy.shield.alive) continue;
                                                                
                                                                // Don't block if shield owner IS the target
                                                                if (wallguy.id === active.id || wallguy._serverId === active.id) continue;
                                                                
                                                                const shield = wallguy.shield;
                                                                
                                                                // Check line-of-sight from player to target
                                                                const startX = px - shield.x;
                                                                const startY = py - shield.y;
                                                                const endX = active.x - shield.x;
                                                                const endY = active.y - shield.y;
                                                                
                                                                const cos = Math.cos(-shield.angle);
                                                                const sin = Math.sin(-shield.angle);
                                                                
                                                                const localStartX = startX * cos - startY * sin;
                                                                const localStartY = startX * sin + startY * cos;
                                                                const localEndX = endX * cos - endY * sin;
                                                                const localEndY = endX * sin + endY * cos;
                                                                
                                                                const halfW = shield.depth / 2;
                                                                const halfH = shield.width / 2;
                                                                
                                                                let t0 = 0, t1 = 1;
                                                                const ldx = localEndX - localStartX;
                                                                const ldy = localEndY - localStartY;
                                                                
                                                                const clipEdge = (p, q) => {
                                                                        if (p === 0) return q >= 0;
                                                                        const r = q / p;
                                                                        if (p < 0) {
                                                                                if (r > t1) return false;
                                                                                if (r > t0) t0 = r;
                                                                        } else {
                                                                                if (r < t0) return false;
                                                                                if (r < t1) t1 = r;
                                                                        }
                                                                        return true;
                                                                };
                                                                
                                                                if (clipEdge(-ldx, localStartX - (-halfW)) &&
                                                                    clipEdge(ldx, halfW - localStartX) &&
                                                                    clipEdge(-ldy, localStartY - (-halfH)) &&
                                                                    clipEdge(ldy, halfH - localStartY)) {
                                                                        if (t0 <= t1) {
                                                                                blockedByShield = true;
                                                                                break;
                                                                        }
                                                                }
                                                        }
                                                } catch(_) {}
                                                
                                                if (!blockedByShield) {
                                                        aimScreenX = active.x - camera.x; 
                                                        aimScreenY = active.y - camera.y; 
                                                        
                                                        // Store target ID for hitscan damage
                                                        this._weapon7ActiveTarget = {
                                                                id: active.id,
                                                                type: active.isPvpTarget ? 'player' : (active.name ? 'npc' : 'enemy'),
                                                                x: active.x, // For client-side visuals only
                                                                y: active.y
                                                        };
                                                } else {
                                                        this._weapon7ActiveTarget = null;
                                                }
                                        } else {
                                                this._weapon7ActiveTarget = null;
                                        }
                                } else {
                                        this._weapon7ActiveTarget = null;
                                }
                        } catch(err) { console.error('[Weapon7] Targeting error:', err); }
                }
                // Calculate fire angle in WORLD space (zoom-aware, matches player pointer)
                // Account for zoom when calculating world mouse position
                const _weaponCx = (window.state?.viewportWidth || 1920) / 2;
                const _weaponCy = (window.state?.viewportHeight || 1080) / 2;
                const _weaponZoom = (window.clientRender?.zoomLevel) || 1.0;
                const worldMouseX = camera.x + _weaponCx + (aimScreenX - _weaponCx) / _weaponZoom;
                const worldMouseY = camera.y + _weaponCy + (aimScreenY - _weaponCy) / _weaponZoom;
                const dx = worldMouseX - px;
                const dy = worldMouseY - py;
                const baseAngle = Math.atan2(dy, dx);
                
                // Weapon 4: apply random inaccuracy to initial firing angle (± up to 10 degrees)
                let fireAngle = baseAngle;
                if (this.currentIndex === 3) {
                        const offset = WorldRNG.random() * (10 * Math.PI / 180);
                        const sign = (WorldRNG.random() < 0.5 ? -1 : 1);
                        fireAngle += sign * offset;
                }
                
                // Weapon 8: Shotgun primary / Hitscan ADS
                if (this.currentIndex === 7) {
                        const lootLevel = player?.getEffectiveLootLevel?.() || 0;
                        const progression = window.getWeaponProgression ? window.getWeaponProgression(7, lootLevel) : {};
                        const adsUnlocked = lootLevel >= 1;
                        
                        // Update visual crosshair recoil
                        const kick = this.isADS ? 2.0 : 4.0;
                        const cap = this.isADS ? 8.0 : 30.0;
                        this.recoil8 = Math.min(cap, this.recoil8 + kick);
                        this.recoil8PeakTracker = Math.max(this.recoil8PeakTracker, this.recoil8);
                        const snapMultiplier = this.isADS ? 2.0 : 3.5;
                        this.recoil8Visual = this.recoil8 + kick * snapMultiplier;
                        
                        if (this.isADS) {
                                // ===== ADS MODE: Hitscan (blood markers, high damage, precise) =====
                                if (!adsUnlocked) {
                                        if (window.abilityManager) {
                                                window.abilityManager.showFeedback('ADS Unlocks at Loot 1', '#ff4444');
                                        }
                                        return;
                                }
                                
                                const bloodCost = progression?.primary?.adsBloodCost || 3;
                                const currentMarkers = player.bloodMarkers || 0;
                                
                                if (currentMarkers < bloodCost) {
                                        if (window.abilityManager) {
                                                window.abilityManager.showFeedback(`Need ${bloodCost} Blood Markers`, '#ff4444');
                                        }
                                        
                                        const now = Date.now();
                                        if (!this._lastBloodMarkerWarning || (now - this._lastBloodMarkerWarning) > 500) {
                                                this._lastBloodMarkerWarning = now;
                                                try {
                                                        const pr = player.radius || 26;
                                                        this.impacts.push({
                                                                life: 0.9,
                                                                totalLife: 0.9,
                                                                px: player.x,
                                                                py: player.y,
                                                                radius: pr,
                                                                update: function(dt) { this.life -= dt; },
                                                                draw: function(ctx, cam) {
                                                                        const t = Math.max(this.life, 0) / this.totalLife;
                                                                        const sx = this.px - cam.x;
                                                                        const sy = this.py - cam.y - (this.radius + 18);
                                                                        ctx.save();
                                                                        ctx.globalAlpha = t;
                                                                        ctx.font = 'bold 18px sans-serif';
                                                                        ctx.textAlign = 'center';
                                                                        ctx.textBaseline = 'bottom';
                                                                        ctx.lineWidth = 4;
                                                                        ctx.strokeStyle = 'rgba(0,0,0,0.7)';
                                                                        ctx.strokeText('Out of Blood Markers', sx, sy);
                                                                        ctx.fillStyle = '#ff4444';
                                                                        ctx.fillText('Out of Blood Markers', sx, sy);
                                                                        ctx.restore();
                                                                }
                                                        });
                                                } catch(e) {}
                                        }
                                        return;
                                }
                                
                                // Perform hitscan
                                const maxDist = 2000;
                                let bestT = maxDist;
                                let hitTarget = null;
                                let hitType = null;
                                
                                const dirX = Math.cos(fireAngle);
                                const dirY = Math.sin(fireAngle);
                                // Spawn from pointer tip (matches visual indicator)
                                const pointerLength = (player.radius + 14) * 1.5;
                                const p1x = px + dirX * pointerLength; 
                                const p1y = py + dirY * pointerLength;
                                
                                // Check for wall collision along the ray (ADS ignores shield walls)
                                let wallHitDist = maxDist;
                                if (environment) {
                                    // Step along the ray to find wall collision
                                    for (let checkDist = 20; checkDist < maxDist; checkDist += 20) {
                                        const checkX = p1x + dirX * checkDist;
                                        const checkY = p1y + dirY * checkDist;
                                        
                                        // ADS: Use filtered version to ignore both player shields and enemy shields
                                        let hitWall = false;
                                        if (environment.lineHitsAnyFiltered) {
                                            hitWall = environment.lineHitsAnyFiltered(p1x, p1y, checkX, checkY, (box) => {
                                                // Skip player shield walls (_abilityId) and enemy shields (_isEnemyShield)
                                                return !box._abilityId && !box._isEnemyShield;
                                            });
                                        } else if (environment.lineHitsAny) {
                                            hitWall = environment.lineHitsAny(p1x, p1y, checkX, checkY);
                                        }
                                        
                                        if (hitWall) {
                                            wallHitDist = checkDist;
                                            break;
                                        }
                                    }
                                }
                                
                                const checkCircle = (cx, cy, r, id, type) => {
                                    const fx = cx - p1x;
                                    const fy = cy - p1y;
                                    const tProj = fx * dirX + fy * dirY;
                                    const cpx = p1x + tProj * dirX;
                                    const cpy = p1y + tProj * dirY;
                                    const dx = cpx - cx;
                                    const dy = cpy - cy;
                                    const d2 = dx * dx + dy * dy;
                                    
                                    if (d2 <= r * r) {
                                        const dt = Math.sqrt(r * r - d2);
                                        const t = tProj - dt;
                                        // Only hit if closer than wall and closer than previous best
                                        if (t > 0 && t < bestT && t < wallHitDist) {
                                            bestT = t;
                                            hitTarget = id;
                                            hitType = type;
                                        }
                                    }
                                };
                                
                                if (window.enemies && window.enemies.items) {
                                    for (const e of window.enemies.items) {
                                        if (e.alive) checkCircle(e.x, e.y, e.radius || 30, e.id || e._serverId, 'enemy');
                                    }
                                }
                                
                                if (window.npcs && window.npcs.items) {
                                    for (const n of window.npcs.items) {
                                        if (n.alive && n.name === 'NPC_B' && n.state === 'hostile') {
                                             checkCircle(n.x, n.y, n.radius || 30, n.id, 'npc');
                                        }
                                    }
                                }
                                
                                if (window.networkManager && window.networkManager.otherPlayers) {
                                     const myEvil = (typeof window !== 'undefined' && window.__killThemAllLocked === true);
                                     for (const [otherId, otherData] of window.networkManager.otherPlayers) {
                                          if (!otherData || otherData.health <= 0) continue;
                                          const otherEvil = window.networkManager.remotePlayerEvilStates?.get(otherId) || false;
                                          if (myEvil !== otherEvil) {
                                               checkCircle(otherData.x, otherData.y, otherData.radius || 26, otherId, 'player');
                                          }
                                     }
                                }
                                 
                                // Spawn impact VFX at hit location (enemy or wall)
                                if (hitTarget && hitType === 'enemy' && window.enemies) {
                                    // Hit an enemy - spawn impact at enemy location
                                    const enemy = window.enemies.items.find(e => (e.id || e._serverId) === hitTarget);
                                    if (enemy && window.ImpactVfx) {
                                        const impactX = enemy.x;
                                        const impactY = enemy.y;
                                        this.impacts.push(new window.ImpactVfx(impactX, impactY, '#ff8844', dirX, dirY, { scale: 3.0 }));
                                    }
                                } else if (wallHitDist < maxDist) {
                                    // Hit a wall - spawn impact at wall hit location
                                    const impactX = p1x + dirX * wallHitDist;
                                    const impactY = p1y + dirY * wallHitDist;
                                    if (window.ImpactVfx) {
                                        this.impacts.push(new window.ImpactVfx(impactX, impactY, '#ff8844', dirX, dirY, { scale: 3.0 }));
                                    }
                                }
                                
                                // Always emit event (even on miss) to consume blood markers
                                if (window.networkManager && window.networkManager.socket) {
                                     window.networkManager.socket.emit('weapon8Hitscan', {
                                         targetId: hitTarget || null,  // null if miss
                                         targetType: hitType || null,
                                         sourceX: p1x,
                                         sourceY: p1y,
                                         didHit: !!hitTarget  // Flag to indicate hit/miss
                                     });
                                }
                                 
                                if (window.state && typeof window.state.triggerScreenShake === 'function') {
                                     window.state.triggerScreenShake(60, 0.5);
                                } else if (typeof window.triggerScreenShake === 'function') {
                                     window.triggerScreenShake(60, 0.5);
                                }
                                
                                // Muzzle flash VFX at spawn point (3x larger than weapon 7, orange)
                                try {
                                        const flashColor = '#ff8844'; // Orange flash
                                        const flashAngle = fireAngle;
                                        const fxX = p1x + dirX * 18;
                                        const fxY = p1y + dirY * 18;
                                        const baseScale = 3.0; // 3x larger than weapon 7
                                        const flashScale = baseScale * Math.max(1.0, lootLevel / 3); // Scales with loot
                                        this.impacts.push({
                                                life: 0.12,
                                                totalLife: 0.12,
                                                x: fxX,
                                                y: fxY,
                                                angle: flashAngle,
                                                color: flashColor,
                                                scale: flashScale,
                                                sparks: (function(){
                                                        const arr = [];
                                                        const n = 12 + Math.floor(lootLevel * 2); // More sparks at higher loot
                                                        for (let i = 0; i < n; i++) {
                                                                const a = (-0.4 + Math.random() * 0.8); // ±~23° spread
                                                                const len = 15 + Math.random() * 15; // 15..30 px (longer)
                                                                const w = 2.0 + Math.random() * 2.0; // 2..4 px (thicker)
                                                                arr.push({ a, len, w });
                                                        }
                                                        return arr;
                                                })(),
                                                draw: function(ctx, cam) {
                                                        const t = Math.max(this.life, 0) / this.totalLife;
                                                        const sx = this.x - cam.x;
                                                        const sy = this.y - cam.y;
                                                        ctx.save();
                                                        
                                                        // Orange muzzle flash glow
                                                        const flashR = 30 * this.scale * t;
                                                        const grad = ctx.createRadialGradient(sx, sy, 0, sx, sy, flashR);
                                                        grad.addColorStop(0, 'rgba(255,136,68,0.9)');
                                                        grad.addColorStop(0.5, 'rgba(255,136,68,0.3)');
                                                        grad.addColorStop(1, 'rgba(255,136,68,0)');
                                                        ctx.globalAlpha = t * 0.8;
                                                        ctx.fillStyle = grad;
                                                        ctx.beginPath();
                                                        ctx.arc(sx, sy, flashR, 0, Math.PI * 2);
                                                        ctx.fill();
                                                        
                                                        // Orange sparks
                                                        ctx.globalAlpha = t;
                                                        ctx.strokeStyle = '#ff8844';
                                                        ctx.lineCap = 'round';
                                                        for (let i = 0; i < this.sparks.length; i++) {
                                                                const sp = this.sparks[i];
                                                                const ang = this.angle + sp.a;
                                                                const cx = Math.cos(ang);
                                                                const cy = Math.sin(ang);
                                                                const dist = sp.len * (1 - t);
                                                                const x1 = sx + cx * dist;
                                                                const y1 = sy + cy * dist;
                                                                const x2 = sx + cx * (dist + sp.len * 0.5);
                                                                const y2 = sy + cy * (dist + sp.len * 0.5);
                                                                ctx.lineWidth = sp.w;
                                                                ctx.beginPath();
                                                                ctx.moveTo(x1, y1);
                                                                ctx.lineTo(x2, y2);
                                                                ctx.stroke();
                                                        }
                                                        ctx.restore();
                                                },
                                                update: function(dt) { this.life -= dt; }
                                        });
                                } catch(e) {}
                                
                                // Spawn visual tracer (scales with loot level)
                                const tracerSpeed = 16000;
                                const tracerLife = 0.4;
                                const tracerVx = dirX * tracerSpeed;
                                const tracerVy = dirY * tracerSpeed;
                                
                                // Get loot-based tracer dimensions (matches weapon 7 progression)
                                let tracerWidth, tracerHeight;
                                if (lootLevel <= 1) {
                                        // Loot 0-1: Shorter than weapon 7
                                        tracerWidth = Math.max(28, w.projectileRadius * 10);
                                        tracerHeight = Math.max(2, w.projectileRadius * 0.7);
                                } else if (lootLevel <= 3) {
                                        // Loot 2-3: Same as weapon 7, bit thicker
                                        tracerWidth = Math.max(36, w.projectileRadius * 12);
                                        tracerHeight = Math.max(3, w.projectileRadius * 1.0);
                                } else {
                                        // Loot 4-6: Slightly longer, 2x thicker
                                        tracerWidth = Math.max(40, w.projectileRadius * 13);
                                        tracerHeight = Math.max(4, w.projectileRadius * 1.4);
                                }
                                
                                const tracer = new Bullet(
                                        p1x, p1y, tracerVx, tracerVy,
                                        2, w.color, tracerLife, fireAngle, true,
                                        {
                                                sourceWeaponIndex: this.currentIndex,
                                                owner: player,
                                                bias: 0,
                                                shape: 'rect',
                                                rectWidth: tracerWidth,
                                                rectHeight: tracerHeight,
                                                tracerColor: '#ff8844'
                                        }
                                );
                                this.items.push(tracer);
                                
                                if (window.networkManager) {
                                        window.networkManager.sendBulletFired({
                                                x: p1x, y: p1y, vx: tracerVx, vy: tracerVy,
                                                radius: 2, color: w.color, life: tracerLife,
                                                angle: fireAngle, noDamage: true,
                                                options: {
                                                        sourceWeaponIndex: this.currentIndex,
                                                        bias: 0,
                                                        shape: 'rect',
                                                        rectWidth: tracerWidth,
                                                        rectHeight: tracerHeight,
                                                        tracerColor: '#ff8844'
                                                }
                                        });
                                }
                                
                                return; // Done with ADS, don't spawn regular projectile
                        } else {
                                // ===== HIP FIRE MODE: Shotgun pellets (no blood markers, spread) =====
                                const pelletCount = progression?.primary?.pelletCount || 4;
                                const basePelletDamage = progression?.primary?.pelletDamage || 5;
                                
                                // Distribute attack power evenly across all pellets (rounded down)
                                let attackPower = 0;
                                try { attackPower = Math.max(0, player.getTotalAttackPowerFlat?.() || 0); } catch(_) {}
                                const attackPowerPerPellet = Math.floor(attackPower / pelletCount);
                                const pelletDamage = basePelletDamage + attackPowerPerPellet;
                                
                                // Dynamic spread based on recoil (crosshair size)
                                // recoil8 ranges from 0 (tight) to 30 (cap for hip fire)
                                // At recoil 0: 3 degrees (very tight)
                                // At recoil 30: 12 degrees (wide spread)
                                const minSpreadDegrees = 4.5; // Increased by 50% (was 3)
                                const maxSpreadDegrees = 18; // Increased by 50% (was 12)
                                const recoilFactor = Math.min(this.recoil8, 30) / 30; // Normalize 0-1
                                const spreadDegrees = minSpreadDegrees + (maxSpreadDegrees - minSpreadDegrees) * recoilFactor;
                                const spreadAngle = spreadDegrees * (Math.PI / 180);
                                
                                // Spawn multiple pellets with random spread and subtle variations
                                for (let i = 0; i < pelletCount; i++) {
                                        const randomSpread = (Math.random() - 0.5) * 2 * spreadAngle;
                                        const pelletAngle = fireAngle + randomSpread;
                                        
                                        const dirX = Math.cos(pelletAngle);
                                        const dirY = Math.sin(pelletAngle);
                                        
                                        // Slight spawn offset variation (±2 units perpendicular to shot direction)
                                        const perpX = -dirY; // Perpendicular vector
                                        const perpY = dirX;
                                        const spawnOffset = (Math.random() - 0.5) * 4; // ±2 units
                                        // Spawn from pointer tip (matches visual indicator)
                                        const pointerLength = (player.radius + 14) * 1.5;
                                        const spawnX = px + dirX * pointerLength + perpX * spawnOffset;
                                        const spawnY = py + dirY * pointerLength + perpY * spawnOffset;
                                        
                                        // Slight speed variation (±10%)
                                        const baseSpeed = 2800;
                                        const speedVariation = 0.9 + Math.random() * 0.2; // 0.9 to 1.1
                                        const pelletSpeed = baseSpeed * speedVariation;
                                        const vx = dirX * pelletSpeed;
                                        const vy = dirY * pelletSpeed;
                                        
                                        // Slight lifetime variation (±15%)
                                        const baseLife = 0.147; // Reduced by 30% (was 0.21)
                                        const lifeVariation = 0.85 + Math.random() * 0.3; // 0.85 to 1.15
                                        const pelletLife = baseLife * lifeVariation;
                                        
                                        const pellet = new Bullet(
                                                spawnX, spawnY, vx, vy,
                                                2, // Small radius
                                                w.color,
                                                pelletLife, // Varied lifetime
                                                pelletAngle,
                                                false, // Does damage
                                                {
                                                        damage: pelletDamage,
                                                        sourceWeaponIndex: this.currentIndex,
                                                        owner: player,
                                                        bias: 0,
                                                        isShotgunPellet: true // Flag for damage falloff
                                                }
                                        );
                                        
                                        // Store spawn position for damage falloff calculation
                                        pellet.spawnX = spawnX;
                                        pellet.spawnY = spawnY;
                                        pellet.isShotgunPellet = true;
                                        
                                        this.items.push(pellet);
                                        
                                        if (window.networkManager) {
                                                window.networkManager.sendBulletFired({
                                                        x: spawnX, y: spawnY, vx: vx, vy: vy,
                                                        radius: 2, color: w.color, life: pelletLife,
                                                        angle: pelletAngle, noDamage: false,
                                                        options: {
                                                                damage: pelletDamage,
                                                                sourceWeaponIndex: this.currentIndex,
                                                                owner: player,
                                                                bias: 0,
                                                                isShotgunPellet: true
                                                        }
                                                });
                                        }
                                }
                                
                                return; // Done with hip fire, don't spawn regular projectile
                        }
                }
                const dirX = Math.cos(fireAngle);
                const dirY = Math.sin(fireAngle);
                const spawnX = px + dirX * (player.radius + 8);
                const spawnY = py + dirY * (player.radius + 8);
                const vx = dirX * w.projectileSpeed;
                const vy = dirY * w.projectileSpeed;
                const angle = fireAngle;
		const isWeapon1 = this.currentIndex === 0;
		let options;
		if (isWeapon1) {
			// Weapon 1 uses stamina per swing (player only)
			const staminaCost = 2;
			if (player === window.player) {
				const isInvincible = !!(typeof window !== 'undefined' && window.state && window.state.invincible);
				// Check if player has enough stamina
				if (!isInvincible && (player.stamina || 0) < staminaCost) {
					// Show a short-lived overhead message above the player's head (throttled)
					const now = Date.now();
					if (!this._lastStaminaWarning || (now - this._lastStaminaWarning) > 500) {
						this._lastStaminaWarning = now;
						try {
							const pr = player.radius || 26;
							this.impacts.push({
								life: 0.9,
								totalLife: 0.9,
								px: player.x,
								py: player.y,
								radius: pr,
								update: function(dt) { this.life -= dt; },
								draw: function(ctx, cam) {
									const t = Math.max(this.life, 0) / this.totalLife;
									const alpha = t;
									const sx = this.px - cam.x;
									const sy = this.py - cam.y - (this.radius + 18);
									ctx.save();
									ctx.globalAlpha = alpha;
									ctx.font = 'bold 18px sans-serif';
									ctx.textAlign = 'center';
									ctx.textBaseline = 'bottom';
									ctx.lineWidth = 4;
									ctx.strokeStyle = 'rgba(0,0,0,0.7)';
									ctx.strokeText('Out of Stamina', sx, sy);
									ctx.fillStyle = '#ffffff';
									ctx.fillText('Out of Stamina', sx, sy);
									ctx.restore();
								}
							});
						} catch(e) {}
					}
					return;
				}
				// Consume stamina for the swing (single-player only; server handles in multiplayer)
				if (!isInvincible && !window.isMultiplayer) {
					player.stamina = Math.max(0, player.stamina - staminaCost);
				}
			}
			
			// Get loot-based progression modifiers for Weapon 1
			const lootLevel = player?.getEffectiveLootLevel?.() || 0;
			const progression = window.getWeaponProgression?.(0, lootLevel) || {};
			const primaryMods = progression.primary || {};
			
			// Apply loot-based multipliers to cone dimensions
			const baseConeRange = w.projectileRadius * 3;
			const baseConeHalf = 0.6;
			const coneRange = baseConeRange * (primaryMods.coneRangeMultiplier || 1.0);
			const coneHalf = baseConeHalf * (primaryMods.coneHalfMultiplier || 1.0);
			
			const base = 30 + (WorldRNG.random() * 10 - 5);
			options = { isCone: true, coneRange: coneRange, coneHalf: coneHalf, damage: base, owner: player };
	} else if (this.currentIndex === 1) {
			// Weapon 2: Get loot-based progression modifiers
			const lootLevel = player?.getEffectiveLootLevel?.() || 0;
			const progression = window.getWeaponProgression?.(1, lootLevel) || {};
			const primaryMods = progression.primary || {};
			
			// Store explosion multipliers for later use in explosion code
			const explosionRadiusMultiplier = primaryMods.explosionRadiusMultiplier || 1.0;
			const explosionDamageMultiplier = primaryMods.explosionDamageMultiplier || 1.0;
			
			// Weapon 2: stronger curvature and slight perpendicular bias
			const perp = (WorldRNG.random() < 0.5 ? -1 : 1);
			const clickWorldX = this.targetRing ? this.targetRing.cx : (camera.x + mouseScreen.x);
			const clickWorldY = this.targetRing ? this.targetRing.cy : (camera.y + mouseScreen.y);
			options = { 
				targetX: clickWorldX, 
				targetY: clickWorldY, 
				maxTurnRate: 13.5, 
				bias: perp * 1.8, 
				shadowEnabled: true, 
				accelBallistic: true, 
				ignoreEnvironment: true, 
				ignoreEnemies: true, 
				deathYellowCircle: true, 
				owner: player,
				explosionRadiusMultiplier: explosionRadiusMultiplier,
				explosionDamageMultiplier: explosionDamageMultiplier,
				projectileSizeMultiplier: primaryMods.projectileSizeMultiplier || 1.0
			};
		} else {
			options = { targetX: player.x + dirX * 10000, targetY: player.y + dirY * 10000, maxTurnRate: 2.5, owner: player };
			// Weapon 7: precompute an exact end point just beyond the 350 ring and fly straight to it
                        if (this.currentIndex === 6) {
                                const minDistFromCenter = 350;
                                const maxDistFromCenter = 450;
                                const spawnOffset = Math.hypot(spawnX - px, spawnY - py);
                                const desiredFromCenter = minDistFromCenter + WorldRNG.random() * (maxDistFromCenter - minDistFromCenter);
                                const travelDist = Math.max(8, desiredFromCenter - spawnOffset);
                                options.targetX = spawnX + dirX * travelDist;
                                options.targetY = spawnY + dirY * travelDist;
                                options.maxTurnRate = 0;
                                options.travelDistance = travelDist;
                        }
                        // Weapon 6: apply loot-based progression for damage, recoil, and projectile scale
                        if (this.currentIndex === 5) {
                                const lootLevel = player?.getEffectiveLootLevel?.() || 0;
                                const progression = window.getWeaponProgression?.(5, lootLevel) || {};
                                const primaryMods = progression.primary || {};
                                
                                // Apply damage multiplier
                                const damageMultiplier = primaryMods.damageMultiplier || 1.0;
                                const baseDamage = 25 + WorldRNG.random() * 10; // 25-35 base damage
                                options.damage = baseDamage * damageMultiplier;
                                
                                // Apply projectile scale multiplier (uses same key as weapon 2 for consistency)
                                const scaleMultiplier = primaryMods.projectileScaleMultiplier || 1.0;
                                options.projectileSizeMultiplier = scaleMultiplier;
                                
                                // Store recoil multiplier for player pushback (applied after bullet creation)
                                this._pendingRecoil = {
                                        dirX: -dirX, // Push opposite to fire direction
                                        dirY: -dirY,
                                        multiplier: primaryMods.recoilMultiplier || 1.0,
                                        baseDistance: 36 // Base pushback distance in world units (scaled by multiplier)
                                };
                        }
                        // Weapon 7: stretch projectile to look like a tracer
                        if (this.currentIndex === 6) {
                                options.shape = 'rect';
                                options.rectWidth = Math.max(36, w.projectileRadius * 12);
                                options.rectHeight = Math.max(2, w.projectileRadius * 0.7);
                                options.impactScale = 1.4;
                        }
                        // Weapon 8: ADS tracer scales with loot level (based on weapon 7 baseline)
                        if (this.currentIndex === 7 && this.isADS) {
                                const lootLevel = player?.getEffectiveLootLevel?.() || 0;
                                options.shape = 'rect';
                                
                                // Weapon 7 baseline: rectWidth = radius * 12, rectHeight = radius * 0.7
                                // Visual progression relative to weapon 7
                                if (lootLevel <= 1) {
                                        // Loot 0-1: Shorter than weapon 7
                                        options.rectWidth = Math.max(28, w.projectileRadius * 10); // ~83% of weapon 7 length
                                        options.rectHeight = Math.max(2, w.projectileRadius * 0.7); // Same thickness as weapon 7
                                } else if (lootLevel <= 3) {
                                        // Loot 2-3: Same length as weapon 7, bit thicker
                                        options.rectWidth = Math.max(36, w.projectileRadius * 12); // Same as weapon 7
                                        options.rectHeight = Math.max(3, w.projectileRadius * 1.0); // ~43% thicker than weapon 7
                                } else {
                                        // Loot 4-6: Slightly longer, 2x thicker
                                        options.rectWidth = Math.max(40, w.projectileRadius * 13); // ~8% longer than weapon 7
                                        options.rectHeight = Math.max(4, w.projectileRadius * 1.4); // 2x thicker than weapon 7
                                }
                                
                                options.impactScale = 3.0; // 3x larger impact VFX
                                options.tracerColor = '#ff8844'; // Orange color for ADS tracers
                        }
                        // Weapon 3: rectangular glowing projectile with charge shot mechanics
                        if (this.currentIndex === 2) {
                                // Get loot-based progression modifiers
                                const lootLevel = player?.getEffectiveLootLevel?.() || 0;
                                const progression = window.getWeaponProgression?.(2, lootLevel) || {};
                                const primaryMods = progression.primary || {};
                                
                                // Calculate charge progress (0..1)
                                const chargeProgress = Math.min(1, this.charge3.chargeTime / this.charge3.maxChargeTime);
                                const isCharged = chargeProgress >= 1.0;
                                
                                // Base projectile length (affected by loot progression)
                                const baseLengthMultiplier = primaryMods.projectileLengthMultiplier || 1.0;
                                let lengthMultiplier = baseLengthMultiplier;
                                let widthMultiplier = 1.0;
                                
                                // If charged, apply charge size multiplier to length
                                if (isCharged) {
                                    lengthMultiplier *= (primaryMods.chargeSizeMultiplier || 1.0);
                                    
                                    // Width scaling only at loot 4+ when charged (chargeGainsWidth flag)
                                    if (primaryMods.chargeGainsWidth) {
                                        // At loot 4+: charged shots gain 50% width
                                        widthMultiplier = 1.5;
                                    }
                                }
                                
                                options.shape = 'rect';
                                options.rectWidth = Math.max(12, w.projectileRadius * 4.8 * lengthMultiplier);
                                options.rectHeight = Math.max(4, w.projectileRadius * 1.2 * widthMultiplier);
                                options.impactScale = 2 * lengthMultiplier;
                                
                                // Mark as charged shot for enhanced glow rendering
                                options.isChargedShot = isCharged;
                                
                                // Base damage with randomization
                                let baseDmg = 30 + WorldRNG.random() * 15;
                                
                                // Apply charge damage multiplier
                                if (isCharged) {
                                    baseDmg *= (primaryMods.chargeDamageMultiplier || 1.0);
                                }
                                options.damage = baseDmg;
                                
                                // Knockback calculation based on loot progression and charge
                                const baseKb = 96;
                                let knockbackMultiplier = 1.0;
                                
                                // Normal shots: use normalKnockback from progression
                                if (!isCharged) {
                                    knockbackMultiplier = primaryMods.normalKnockback || 0;
                                } else {
                                    // Charged shots: use chargeKnockbackMultiplier
                                    knockbackMultiplier = primaryMods.chargeKnockbackMultiplier || 1.0;
                                }
                                
                                options.knockback = baseKb * knockbackMultiplier;
                                
                                // Send charge end event to other players
                                if (window.networkManager && player === window.player) {
                                    window.networkManager.sendVfxCreated('chargeEnd', player.x, player.y, {
                                        playerId: window.networkManager.playerId
                                    });
                                }
                                
                                // Reset charge state after firing
                                this.charge3.active = false;
                                this.charge3.chargeTime = 0;
                                if (this.charge3.vfx) {
                                    this.charge3.vfx = null; // Will be recreated on next charge
                                }
                                
                                // Weapon 3 muzzle flash (scales with loot level and charge state)
                                try {
                                    const flashColor = w.color || '#76b0ff';
                                    const flashAngle = angle || 0;
                                    const fxX = spawnX + dirX * 18;
                                    const fxY = spawnY + dirY * 18;
                                    
                                    // Calculate flash scale based on loot and charge
                                    // Base scale: 1.0, Loot progression: 0.5 → 1.5, Charge multiplier: 1.0 → 2.0
                                    // Top level charged: 1.5 * 2.0 = 3.0x scale
                                    let flashScale = baseLengthMultiplier; // Loot-based: 0.5, 1.0, 1.5
                                    if (isCharged) {
                                        flashScale *= (primaryMods.chargeSizeMultiplier || 1.0); // Charge: 1.0 → 2.0
                                    }
                                    
                                    // Number of sparks scales with flash size
                                    const sparkCount = Math.floor(8 + flashScale * 8); // 12 to 24 sparks
                                    
                                    this.impacts.push({
                                        life: 0.12, // Slightly longer than weapon 7
                                        totalLife: 0.12,
                                        x: fxX,
                                        y: fxY,
                                        angle: flashAngle,
                                        color: flashColor,
                                        scale: flashScale,
                                        isCharged: isCharged,
                                        sparks: (function(){
                                            const arr = [];
                                            for (let i = 0; i < sparkCount; i++) {
                                                const a = (-0.5 + Math.random() * 1.0); // ±~29° spread
                                                const len = (15 + Math.random() * 20) * flashScale; // Scales with flash
                                                const w = (2 + Math.random() * 2) * Math.sqrt(flashScale); // Thicker for larger flash
                                                arr.push({ a, len, w });
                                            }
                                            return arr;
                                        })(),
                                        update: function(dt){ this.life -= dt; },
                                        draw: function(ctx, cam){
                                            const t = 1 - Math.max(this.life, 0) / this.totalLife; // 0..1
                                            const alpha = 1 - t;
                                            const sx = this.x - cam.x;
                                            const sy = this.y - cam.y;
                                            ctx.save();
                                            ctx.translate(sx, sy);
                                            ctx.rotate(this.angle || 0);
                                            
                                            // Charged shots get an extra bright white core
                                            if (this.isCharged) {
                                                const coreR = (8 + 4 * (1 - t)) * this.scale;
                                                ctx.globalAlpha = alpha * 0.9;
                                                const coreGrad = ctx.createRadialGradient(0, 0, 0, 0, 0, coreR);
                                                coreGrad.addColorStop(0, 'rgba(255, 255, 255, ' + (alpha * 0.9) + ')');
                                                coreGrad.addColorStop(0.5, 'rgba(255, 255, 255, ' + (alpha * 0.5) + ')');
                                                coreGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');
                                                ctx.fillStyle = coreGrad;
                                                ctx.beginPath();
                                                ctx.arc(0, 0, coreR, 0, Math.PI * 2);
                                                ctx.fill();
                                            }
                                            
                                            // Main radial glow (scales with flash scale)
                                            const glowR = (14 + 6 * (1 - t)) * this.scale;
                                            try {
                                                const hex = this.color;
                                                const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
                                                const r = m ? parseInt(m[1], 16) : 118;
                                                const g = m ? parseInt(m[2], 16) : 176;
                                                const b = m ? parseInt(m[3], 16) : 255;
                                                const a0 = (this.isCharged ? 0.85 : 0.7) * alpha;
                                                ctx.globalAlpha = 1;
                                                const g2 = ctx.createRadialGradient(0, 0, 0, 0, 0, glowR);
                                                g2.addColorStop(0, 'rgba(' + r + ',' + g + ',' + b + ',' + a0 + ')');
                                                g2.addColorStop(1, 'rgba(' + r + ',' + g + ',' + b + ',0)');
                                                ctx.fillStyle = g2;
                                                ctx.beginPath();
                                                ctx.arc(0, 0, glowR, 0, Math.PI * 2);
                                                ctx.fill();
                                            } catch(_) {}
                                            
                                            // Sparks (short streaks radiating forward)
                                            ctx.globalAlpha = (this.isCharged ? 1.0 : 0.9) * alpha;
                                            ctx.strokeStyle = this.isCharged ? '#ffffff' : this.color;
                                            ctx.lineCap = 'round';
                                            const sp = Array.isArray(this.sparks) ? this.sparks : [];
                                            for (let i = 0; i < sp.length; i++) {
                                                const s = sp[i];
                                                const L = s.len * (1 - t);
                                                const ex = Math.cos(s.a) * L;
                                                const ey = Math.sin(s.a) * L;
                                                ctx.lineWidth = s.w;
                                                ctx.beginPath();
                                                ctx.moveTo(0, 0);
                                                ctx.lineTo(ex, ey);
                                                ctx.stroke();
                                            }
                                            
                                            // Outer ring pulse for charged shots
                                            if (this.isCharged) {
                                                ctx.globalAlpha = alpha * 0.6 * (1 - t);
                                                ctx.strokeStyle = '#ffffff';
                                                ctx.lineWidth = 3 * this.scale;
                                                const ringR = glowR * 1.5;
                                                ctx.beginPath();
                                                ctx.arc(0, 0, ringR, 0, Math.PI * 2);
                                                ctx.stroke();
                                            }
                                            
                                            ctx.restore();
                                        }
                                    });
                                } catch(e) {
                                    console.error('[Weapon3] Muzzle flash error:', e);
                                }
                        }
                        // Weapon 4: convert projectile to a cone shape
                        if (this.currentIndex === 3) {
                                options.isCone = true;
                                // Base cone values
                                let baseRange = (w.projectileRadius * 3) * 5; // 5x stretch
                                let baseHalf = 0.2; // narrower cone width
                                // Randomize length and width independently: length ±20%, width ±20%
                                const lengthVariation = 0.20;
                                const widthVariation = 0.20;
                                const rangeMul = (1 - lengthVariation) + WorldRNG.random() * (2 * lengthVariation);
                                const halfMul = (1 - widthVariation) + WorldRNG.random() * (2 * widthVariation);
                                options.coneRange = baseRange * rangeMul;
                                options.coneHalf = baseHalf * halfMul;
                                // Convey DOT owner so enemy can apply DOT crit visuals/damage
                                options.owner = player;
                        }
                        // Weapon 5: pointy oval projectile
                        if (this.currentIndex === 4) {
                                options.shape = 'oval';
                                options.ovalLength = Math.max(24, w.projectileRadius * 5.6);
                                options.ovalWidth = Math.max(8, w.projectileRadius * 2.2);
                                options.ovalPoint = 0.6; // slightly pointier
                        }
                        // Default base damage for non-special projectiles (e.g., weapon 5): 20 ± 5
                        if (this.currentIndex !== 3 && options.damage == null) {
                                options.damage = 20 + (WorldRNG.random() * 10 - 5);
                        }
                        // Weapon 9 (hotkey 9) should have a base damage of 300
                        if (this.currentIndex === 8) {
                                options.damage = 300;
                        }
                }
                // Tag projectile with source weapon index for downstream logic (e.g., DOT on weapon 4)
                if (!options) options = {};
                options.sourceWeaponIndex = this.currentIndex;
                // Attach owner for crit calculation downstream
                options.owner = player;
                // Weapon 8: no bias (tracer follows hitscan path exactly)
                if (this.currentIndex === 7) {
                        options.bias = 0;
                }
                // Randomize bullet lifespan for weapon 4 (index 3)
                let bulletLife = w.projectileLife;
                if (this.currentIndex === 3) {
                        // Increase by 25%: previously 0.3..0.6 -> now 0.375..0.75 seconds
                        bulletLife = (0.3 + WorldRNG.random() * 0.3) * 1.25;
                }
                // Weapon 4 uses stamina as ammo with exhaustion latch (player only)
                if (this.currentIndex === 3 && player === window.player) {
                        const isInvincible = !!(typeof window !== 'undefined' && window.state && window.state.invincible);
                        // Show warning if out of stamina or blocked by latch
                        if (!isInvincible && (player.mustReleaseFire || player.exhaustionTimer > 0 || (player.stamina || 0) <= 0)) {
                                // Show a short-lived overhead message above the player's head (throttled)
                                const now = Date.now();
                                if (!this._lastStaminaWarning || (now - this._lastStaminaWarning) > 500) {
                                        this._lastStaminaWarning = now;
                                        try {
                                                const pr = player.radius || 26;
                                                this.impacts.push({
                                                        life: 0.9,
                                                        totalLife: 0.9,
                                                        px: player.x,
                                                        py: player.y,
                                                        radius: pr,
                                                        update: function(dt) { this.life -= dt; },
                                                        draw: function(ctx, cam) {
                                                                const t = Math.max(this.life, 0) / this.totalLife;
                                                                const alpha = t;
                                                                const sx = this.px - cam.x;
                                                                const sy = this.py - cam.y - (this.radius + 18);
                                                                ctx.save();
                                                                ctx.globalAlpha = alpha;
                                                                ctx.font = 'bold 18px sans-serif';
                                                                ctx.textAlign = 'center';
                                                                ctx.textBaseline = 'bottom';
                                                                ctx.lineWidth = 4;
                                                                ctx.strokeStyle = 'rgba(0,0,0,0.7)';
                                                                ctx.strokeText('Out of Stamina', sx, sy);
                                                                ctx.fillStyle = '#ffffff';
                                                                ctx.fillText('Out of Stamina', sx, sy);
                                                                ctx.restore();
                                                        }
                                                });
                                        } catch(e) {}
                                }
                                return;
                        }
                }
                
                // Apply projectile size multiplier (for weapon 2 progression)
                const projectileSizeMultiplier = options?.projectileSizeMultiplier || 1.0;
                const effectiveRadius = w.projectileRadius * projectileSizeMultiplier;
                
                // Weapon 5: start burst per click (1-3 shots based on loot progression)
                if (this.currentIndex === 4) {
                        // Get burst count from progression config
                        const lootLevel = player?.lootLevel || 0;
                        const progressionData = (typeof window.getWeaponProgression === 'function') 
                                ? window.getWeaponProgression(4, lootLevel) 
                                : {};
                        const burstCount = progressionData?.primary?.burstCount || 3; // Default to 3 if not configured
                        
                        // First shot immediately
                        // Weapon 7: set life so tracer dies just outside the 350 ring from player center
                        let lifeOverride = bulletLife;
                        if (this.currentIndex === 6) {
                                const spd = Math.max(1, w.projectileSpeed || 1);
                                const td = Number.isFinite(options.travelDistance) ? options.travelDistance : 380; // fallback
                                lifeOverride = Math.min(lifeOverride, td / spd);
                        }
			// Use pooled bullet for better performance (10-20% FPS boost)
			const bullet = (typeof window.createBullet === 'function') 
				? window.createBullet(spawnX, spawnY, vx, vy, effectiveRadius, w.color, lifeOverride, angle, false, options)
				: new Bullet(spawnX, spawnY, vx, vy, effectiveRadius, w.color, lifeOverride, angle, false, options);
			this.items.push(bullet);
                        
                        // Send bullet data to other players for synchronization
                        if (window.networkManager && player === window.player) {
                                window.networkManager.sendBulletFired({
                                        x: spawnX, y: spawnY, vx: vx, vy: vy,
                                        radius: effectiveRadius, color: w.color, life: lifeOverride,
                                        angle: angle, noDamage: false, options: options,
                                        bias: bullet.bias, targetX: bullet.targetX, targetY: bullet.targetY,
                                        sourceWeaponIndex: this.currentIndex
                                });
                        }
                        // Capture state for subsequent shots (ONLY for weapon 5, not shotgun)
                        // If burstCount is 1, don't activate burst (single shot only)
                        if (burstCount > 1) {
                                this.burst5.active = true;
                                this.burst5.shotsRemaining = burstCount - 1; // Subtract 1 because we just fired the first shot
                                // Shorten burst interval by attack speed as well
                                this.burst5.timer = Math.max(0.01, this.burst5.interval / (1 + (player?.getTotalAttackSpeedPercent?.() || 0) / 100));
                                this.burst5.ux = dirX;
                                this.burst5.uy = dirY;
                                this.burst5.angle = fireAngle;
                        }
                } else {
				// Use pooled bullet for better performance (10-20% FPS boost)
			// Weapon1 cones pass isWeapon1 (true) as noDamage to suppress impact sparks
			// Weapon7 uses noDamage=true since damage is handled server-side via hitscan
				const noDamage = isWeapon1 || (this.currentIndex === 6);
				const bullet = (typeof window.createBullet === 'function')
					? window.createBullet(spawnX, spawnY, vx, vy, effectiveRadius, w.color, bulletLife, angle, noDamage, options)
					: new Bullet(spawnX, spawnY, vx, vy, effectiveRadius, w.color, bulletLife, angle, noDamage, options);
				this.items.push(bullet);
                        
                        // Send bullet data to other players for synchronization
                        if (window.networkManager && player === window.player) {
                                window.networkManager.sendBulletFired({
                                        x: spawnX, y: spawnY, vx: vx, vy: vy,
                                        radius: effectiveRadius, color: w.color, life: bulletLife,
                                        angle: angle, noDamage: noDamage, options: options,
                                        bias: bullet.bias, targetX: bullet.targetX, targetY: bullet.targetY,
                                        sourceWeaponIndex: this.currentIndex
                                });
                        }
                        // Decrement ammo for weapon 7 on actual shot
                        if (this.currentIndex === 6) {
                                this.ammo7 = Math.max(0, (this.ammo7 || 0) - 1);
                                if (this.ammo7 === 0) this.ammo7ReloadTimer = this.getWeapon7ReloadSeconds(player);
                                
                                // Tag bullet with unique ID for tracking (Option 2: terminate at enemy)
                                const bulletId = 'w7_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
                                bullet.weapon7HitscanId = bulletId;
                                
                                // Send hitscan event to server for instant damage (lag-compensated)
                                if (window.networkManager && player === window.player) {
                                        let targetToHit = this._weapon7ActiveTarget;
                                        
                                // Fallback: if no stored target, search along firing direction
                                if (!targetToHit && typeof window !== 'undefined') {
                                        const radius = 350;
                                        const myEvil = window.__killThemAllLocked === true;
                                        const targets = [];
                                        
                                        // Add enemies
                                        if (window.enemies && typeof window.enemies.queryCircle === 'function') {
                                                const enemyList = window.enemies.queryCircle(px, py, radius) || [];
                                                for (let i = 0; i < enemyList.length; i++) {
                                                        const e = enemyList[i];
                                                        if (e && e.alive) targets.push(e);
                                                }
                                        }
                                        
                                        // Add hostile NPCs
                                        if (window.npcs && window.npcs.items) {
                                                for (let i = 0; i < window.npcs.items.length; i++) {
                                                        const npc = window.npcs.items[i];
                                                        if (!npc || !npc.alive) continue;
                                                        if (npc.name === 'NPC_B' && npc.state === 'hostile') {
                                                                const dxn = npc.x - px;
                                                                const dyn = npc.y - py;
                                                                if (dxn * dxn + dyn * dyn <= radius * radius) {
                                                                        targets.push(npc);
                                                                }
                                                        }
                                                }
                                        }
                                        
                                        // Add opposite-alignment players
                                        if (window.networkManager?.otherPlayers) {
                                                for (const [otherId, otherData] of window.networkManager.otherPlayers) {
                                                        if (!otherData || otherData.health <= 0) continue;
                                                        const otherEvil = window.networkManager.remotePlayerEvilStates?.get(otherId) || false;
                                                        if (myEvil !== otherEvil) {
                                                                const dxp = otherData.x - px;
                                                                const dyp = otherData.y - py;
                                                                if (dxp * dxp + dyp * dyp <= radius * radius) {
                                                                        targets.push({ x: otherData.x, y: otherData.y, radius: otherData.radius || 26, alive: true, isPvpTarget: true, id: otherId });
                                                                }
                                                        }
                                                }
                                        }
                                        
                                        // Find closest target along firing direction (within cone)
                                        let bestTarget = null;
                                        let bestDist = Infinity;
                                        const coneHalfAngle = 0.15; // ~8.6 degrees cone
                                        const fireAngleDeg = (fireAngle * 180 / Math.PI).toFixed(1);
                                        
                                        for (let i = 0; i < targets.length; i++) {
                                                const t = targets[i];
                                                if (!t || !t.alive) continue;
                                                
                                                const dx = t.x - px;
                                                const dy = t.y - py;
                                                const dist = Math.hypot(dx, dy);
                                                
                                                // Check if target is along firing direction
                                                const angleToTarget = Math.atan2(dy, dx);
                                                let angleDiff = Math.abs(angleToTarget - fireAngle);
                                                if (angleDiff > Math.PI) angleDiff = Math.PI * 2 - angleDiff;
                                                const angleDiffDeg = (angleDiff * 180 / Math.PI).toFixed(1);
                                                
                                                const inCone = angleDiff <= coneHalfAngle;
                                                
                                                if (inCone && dist < bestDist) {
                                                        // Check if environment walls block line of sight
                                                        let blockedByWall = false;
                                                        if (window.environment && typeof window.environment.lineHitsAny === 'function') {
                                                                blockedByWall = window.environment.lineHitsAny(px, py, t.x, t.y);
                                                        }
                                                        
                                                        if (!blockedByWall) {
                                                                // Check if WallGuy shield blocks line of sight
                                                                let blockedByShield = false;
                                                                try {
                                                                        const enemyList = window.enemies?.items || [];
                                                                        for (const wallguy of enemyList) {
                                                                                if (!wallguy || !wallguy.alive || wallguy.type !== 'wallguy') continue;
                                                                                if (!wallguy.shield || !wallguy.shield.alive) continue;
                                                                                
                                                                                // Don't block if shield owner IS the target
                                                                                if (wallguy.id === t.id || wallguy._serverId === t.id) continue;
                                                                                
                                                                                const shield = wallguy.shield;
                                                                                
                                                                                // Check line-of-sight from player to target
                                                                                const startX = px - shield.x;
                                                                                const startY = py - shield.y;
                                                                                const endX = t.x - shield.x;
                                                                                const endY = t.y - shield.y;
                                                                                
                                                                                const cos = Math.cos(-shield.angle);
                                                                                const sin = Math.sin(-shield.angle);
                                                                                
                                                                                const localStartX = startX * cos - startY * sin;
                                                                                const localStartY = startX * sin + startY * cos;
                                                                                const localEndX = endX * cos - endY * sin;
                                                                                const localEndY = endX * sin + endY * cos;
                                                                                
                                                                                const halfW = shield.depth / 2;
                                                                                const halfH = shield.width / 2;
                                                                                
                                                                                let t0 = 0, t1 = 1;
                                                                                const ldx = localEndX - localStartX;
                                                                                const ldy = localEndY - localStartY;
                                                                                
                                                                                const clipEdge = (p, q) => {
                                                                                        if (p === 0) return q >= 0;
                                                                                        const r = q / p;
                                                                                        if (p < 0) {
                                                                                                if (r > t1) return false;
                                                                                                if (r > t0) t0 = r;
                                                                                        } else {
                                                                                                if (r < t0) return false;
                                                                                                if (r < t1) t1 = r;
                                                                                        }
                                                                                        return true;
                                                                                };
                                                                                
                                                                                if (clipEdge(-ldx, localStartX - (-halfW)) &&
                                                                                    clipEdge(ldx, halfW - localStartX) &&
                                                                                    clipEdge(-ldy, localStartY - (-halfH)) &&
                                                                                    clipEdge(ldy, halfH - localStartY)) {
                                                                                        if (t0 <= t1) {
                                                                                                blockedByShield = true;
                                                                                                break;
                                                                                        }
                                                                                }
                                                                        }
                                                                } catch(_) {}
                                                                
                                                                if (!blockedByShield) {
                                                                        bestDist = dist;
                                                                        bestTarget = t;
                                                                }
                                                        }
                                                }
                                        }
                                        
                                        if (bestTarget) {
                                                targetToHit = {
                                                        id: bestTarget.id,
                                                        type: bestTarget.isPvpTarget ? 'player' : (bestTarget.name ? 'npc' : 'enemy'),
                                                        x: bestTarget.x,
                                                        y: bestTarget.y
                                                };
                                        }
                                }
                                        
                                        // Send hitscan if we have a target
                                        if (targetToHit) {
                                                window.networkManager.sendWeapon7Hitscan({
                                                        targetId: targetToHit.id,
                                                        targetType: targetToHit.type,
                                                        sourceX: spawnX,
                                                        sourceY: spawnY,
                                                        bulletId: bulletId,
                                                        timestamp: Date.now()
                                                });
                                        }
                                }
                                
                                // Muzzle flash VFX at spawn point
                                try {
                                        const flashColor = w.color || '#ffd36b';
                                        const flashAngle = angle || 0;
                                        const fxX = spawnX + dirX * 18;
                                        const fxY = spawnY + dirY * 18;
                                        this.impacts.push({
                                                life: 0.08,
                                                totalLife: 0.08,
                                                x: fxX,
                                                y: fxY,
                                                angle: flashAngle,
                                                color: flashColor,
                                                sparks: (function(){
                                                        const arr = [];
                                                        const n = 8;
                                                        for (let i = 0; i < n; i++) {
                                                                const a = (-0.4 + Math.random() * 0.8); // ±~23° spread around forward
                                                                const len = 10 + Math.random() * 10; // 10..20 px
                                                                const w = 1.5 + Math.random() * 1.5; // 1.5..3 px
                                                                arr.push({ a, len, w });
                                                        }
                                                        return arr;
                                                })(),
                                                update: function(dt){ this.life -= dt; },
                                                draw: function(ctx, cam){
                                                        const t = 1 - Math.max(this.life, 0) / this.totalLife; // 0..1
                                                        const alpha = 1 - t;
                                                        const sx = this.x - cam.x;
                                                        const sy = this.y - cam.y;
                                                        ctx.save();
                                                        ctx.translate(sx, sy);
                                                        ctx.rotate(this.angle || 0);
                                                        // Soft radial glow
                                                        const glowR = 14 + 6 * (1 - t);
                                                        try {
                                                                const hex = this.color;
                                                                const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
                                                                const r = m ? parseInt(m[1], 16) : 255;
                                                                const g = m ? parseInt(m[2], 16) : 211;
                                                                const b = m ? parseInt(m[3], 16) : 107;
                                                                const a0 = 0.7 * alpha;
                                                                ctx.globalAlpha = 1;
                                                                const g2 = ctx.createRadialGradient(0, 0, 0, 0, 0, glowR);
                                                                g2.addColorStop(0, 'rgba(' + r + ',' + g + ',' + b + ',' + a0 + ')');
                                                                g2.addColorStop(1, 'rgba(' + r + ',' + g + ',' + b + ',0)');
                                                                ctx.fillStyle = g2;
                                                                ctx.beginPath();
                                                                ctx.arc(0, 0, glowR, 0, Math.PI * 2);
                                                                ctx.fill();
                                                        } catch(_) {}
                                                        // Sparks (short streaks) instead of a filled cone
                                                        ctx.globalAlpha = 0.9 * alpha;
                                                        ctx.strokeStyle = this.color;
                                                        ctx.lineCap = 'round';
                                                        const sp = Array.isArray(this.sparks) ? this.sparks : [];
                                                        for (let i = 0; i < sp.length; i++) {
                                                                const s = sp[i];
                                                                const L = s.len * (1 - t);
                                                                const ex = Math.cos(s.a) * L;
                                                                const ey = Math.sin(s.a) * L;
                                                                ctx.lineWidth = s.w;
                                                                ctx.beginPath();
                                                                ctx.moveTo(0, 0);
                                                                ctx.lineTo(ex, ey);
                                                                ctx.stroke();
                                                        }
                                                        ctx.restore();
                                                }
                                        });
                                } catch(_) {}
                        }
                }
                
        // On release, persist a fading ring at final position, then clear the targeting ring
        if (this.currentIndex === 1 && opts?.justReleased) {
            const ring = this.targetRing;
            if (ring) {
                const baseRadius = 100;
                const ringRadius = baseRadius * (ring.explosionRadiusMultiplier || 1.0);
                this.impacts.push({
                    life: 0.6,
                    totalLife: 0.6,
                    draw: function(ctx, cam) {
                        const t = Math.max(this.life, 0) / this.totalLife;
                        const alpha = 0.75 * t;
                        const sx = ring.cx - cam.x;
                        const sy = ring.cy - cam.y;
                        ctx.save();
                        ctx.translate(sx, sy);
                        try {
                            const hex = ring.color;
                            const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
                            const r = m ? parseInt(m[1], 16) : 255;
                            const g = m ? parseInt(m[2], 16) : 255;
                            const b = m ? parseInt(m[3], 16) : 255;
                            const glowR = ringRadius * 1.6;
                            const grad = ctx.createRadialGradient(0, 0, ringRadius * 0.2, 0, 0, glowR);
                            grad.addColorStop(0, 'rgba(' + r + ',' + g + ',' + b + ',' + (0.18 * alpha) + ')');
                            grad.addColorStop(1, 'rgba(' + r + ',' + g + ',' + b + ',0)');
                            ctx.fillStyle = grad;
                            ctx.beginPath();
                            ctx.arc(0, 0, glowR, 0, Math.PI * 2);
                            ctx.fill();
                        } catch(e) {}
                        ctx.strokeStyle = ring.color;
                        ctx.globalAlpha = alpha;
                        ctx.lineWidth = 3;
                        ctx.shadowColor = ring.color;
                        ctx.shadowBlur = 12;
                        ctx.beginPath();
                        ctx.arc(0, 0, ringRadius, 0, Math.PI * 2);
                        ctx.stroke();
                        ctx.shadowBlur = 0;
                        ctx.restore();
                    },
                    update: function(dt) { this.life -= dt; }
                });
            }
            this.targetRing = null;
        }
        
        // Apply weapon 6 recoil pushback to player after firing
        if (this._pendingRecoil && player === window.player) {
                const recoilData = this._pendingRecoil;
                const pushDistance = recoilData.baseDistance * recoilData.multiplier;
                
                // Apply pushback directly to player position
                player.x += recoilData.dirX * pushDistance;
                player.y += recoilData.dirY * pushDistance;
                
                // Clear pending recoil
                this._pendingRecoil = null;
        }

        }

        trySecondaryFire(player, mouseScreen, camera, opts = {}) {
                if (!player || !window.abilityManager) return;
                
                const w = this.current;
                const weaponIndex = this.currentIndex;
                
                // Update secondary fire input state
                this.secondaryJustPressed = opts.justPressed || false;
                this.secondaryJustReleased = opts.justReleased || false;
                this.secondaryHeld = opts.mouseDown || false;
                
                // Update weapon 8 ADS state immediately for movement slowdown
                if (this.currentIndex === 7) {
                    this.isADS = this.secondaryHeld;
                }
                
                // Weapon 1: Shield Wall (hold to preview, release to place)
                if (weaponIndex === 0) {
                        // Check if ability is unlocked at current loot level
                        const lootLevel = player.lootLevel || 0;
                        const progression = window.getWeaponProgression ? window.getWeaponProgression(0, lootLevel) : {};
                        const hasSecondary = progression.secondary !== undefined;
                        
                        if (!hasSecondary) {
                                // Clear any existing indicator if ability becomes locked
                                this.secondaryIndicator = null;
                                return; // Ability not unlocked yet
                        }
                        
                        // Check maxWalls limit on mouse down (before showing indicator)
                        const maxWalls = progression.secondary.maxWalls;
                        if (this.secondaryJustPressed && maxWalls !== undefined && window.abilityManager) {
                                // Count existing ShieldWalls owned by this player
                                let existingWalls = 0;
                                for (const ability of window.abilityManager.abilities) {
                                        if (ability.constructor.name === 'ShieldWall' && ability.owner?.id === player.id) {
                                                existingWalls++;
                                        }
                                }
                                
                                if (existingWalls >= maxWalls) {
                                        window.abilityManager.showFeedback('Max Walls Reached', '#ff4444');
                                        return; // Don't create indicator
                                }
                        }
                        
                        if (this.secondaryHeld && !this.secondaryIndicator) {
                                // Create placement indicator
                                const aimAngle = Math.atan2(
                                        mouseScreen.y - (player.y - camera.y), 
                                        mouseScreen.x - (player.x - camera.x)
                                );
                                const distance = 60; // Place 60 units in front of player
                                const placementX = player.x + Math.cos(aimAngle) * distance;
                                const placementY = player.y + Math.sin(aimAngle) * distance;
                                
                                // Get progression data for wall length
                                const wallLengthMultiplier = progression.secondary?.wallLengthMultiplier || 1.0;
                                const baseWidth = 100;
                                const wallWidth = baseWidth * wallLengthMultiplier;
                                
                                this.secondaryIndicator = {
                                        type: 'shieldWall',
                                        x: placementX,
                                        y: placementY,
                                        angle: aimAngle,
                                        width: wallWidth,
                                        depth: 20
                                };
                        }
                        
                        if (this.secondaryHeld && this.secondaryIndicator) {
                                // Update indicator position while held
                                const aimAngle = Math.atan2(
                                        mouseScreen.y - (player.y - camera.y), 
                                        mouseScreen.x - (player.x - camera.x)
                                );
                                const distance = 60;
                                this.secondaryIndicator.x = player.x + Math.cos(aimAngle) * distance;
                                this.secondaryIndicator.y = player.y + Math.sin(aimAngle) * distance;
                                this.secondaryIndicator.angle = aimAngle;
                                
                                // Update wall width in case lootLevel changed during hold (uses already-fetched progression)
                                const wallLengthMultiplier = progression.secondary?.wallLengthMultiplier || 1.0;
                                this.secondaryIndicator.width = 100 * wallLengthMultiplier;
                        }
                        
                        if (this.secondaryJustReleased && this.secondaryIndicator) {
                                // Place the wall at indicator position with progression-based width
                                const success = window.abilityManager.tryCreateAbility(
                                        window.ShieldWall,
                                        2, // blood cost
                                        player,
                                        this.secondaryIndicator.angle,
                                        this.secondaryIndicator.x,
                                        this.secondaryIndicator.y,
                                        this.secondaryIndicator.width // Pass wall width from progression
                                );
                                
                                // Clear indicator AFTER sending request
                                this.secondaryIndicator = null;
                        }
                }
                
                // Weapon 2: Proximity Mine (hold to preview behind player, release to place)
                if (weaponIndex === 1) {
                        // Check if ability is unlocked at current loot level
                        const lootLevel = player.lootLevel || 0;
                        const progression = window.getWeaponProgression ? window.getWeaponProgression(1, lootLevel) : {};
                        const hasSecondary = progression.secondary !== undefined;
                        
                        if (!hasSecondary) {
                                // Clear any existing indicator if ability becomes locked
                                this.secondaryIndicator = null;
                                return; // Ability not unlocked yet
                        }
                        
                        // Check maxMines limit on mouse down (before showing indicator)
                        const maxMines = progression.secondary.maxMines;
                        if (this.secondaryJustPressed && maxMines !== undefined && window.abilityManager) {
                                // Count existing ProximityMines owned by this player
                                let existingMines = 0;
                                for (const ability of window.abilityManager.abilities) {
                                        if (ability.constructor.name === 'ProximityMine' && ability.owner?.id === player.id) {
                                                existingMines++;
                                        }
                                }
                                
                                if (existingMines >= maxMines) {
                                        window.abilityManager.showFeedback('Max Mines Reached', '#ff4444');
                                        return; // Don't create indicator
                                }
                        }
                        
                        if (this.secondaryHeld && !this.secondaryIndicator) {
                                // Create placement indicator behind player (opposite of aim direction)
                                const aimAngle = Math.atan2(
                                        mouseScreen.y - (player.y - camera.y), 
                                        mouseScreen.x - (player.x - camera.x)
                                );
                                const distance = 40; // Place 40 units behind player
                                const placementX = player.x - Math.cos(aimAngle) * distance;
                                const placementY = player.y - Math.sin(aimAngle) * distance;
                                
                                // Get progression data for mine size
                                const mineSizeMultiplier = progression.secondary?.mineSizeMultiplier || 1.0;
                                const baseRadius = 15;
                                const mineRadius = baseRadius * mineSizeMultiplier;
                                console.log('[Weapon2] Creating mine indicator - loot:', player.lootLevel, 'mult:', mineSizeMultiplier, 'radius:', mineRadius);
                                
                                this.secondaryIndicator = {
                                        type: 'proximityMine',
                                        x: placementX,
                                        y: placementY,
                                        radius: mineRadius
                                };
                        }
                        
                        if (this.secondaryHeld && this.secondaryIndicator) {
                                // Update indicator position while held
                                const aimAngle = Math.atan2(
                                        mouseScreen.y - (player.y - camera.y), 
                                        mouseScreen.x - (player.x - camera.x)
                                );
                                const distance = 40;
                                this.secondaryIndicator.x = player.x - Math.cos(aimAngle) * distance;
                                this.secondaryIndicator.y = player.y - Math.sin(aimAngle) * distance;
                                
                                // Update mine radius in case lootLevel changed during hold
                                const mineSizeMultiplier = progression.secondary?.mineSizeMultiplier || 1.0;
                                this.secondaryIndicator.radius = 15 * mineSizeMultiplier;
                        }
                        
                        if (this.secondaryJustReleased && this.secondaryIndicator) {
                                // Double-check maxMines limit before placing (in case limit was reached while holding)
                                const maxMines = progression.secondary.maxMines;
                                let existingMines = 0;
                                if (window.abilityManager) {
                                        for (const ability of window.abilityManager.abilities) {
                                                if (ability.constructor.name === 'ProximityMine' && ability.owner?.id === player.id) {
                                                        existingMines++;
                                                }
                                        }
                                }
                                
                                console.log('[Weapon2] Mine release check - existing:', existingMines, 'max:', maxMines);
                                
                                if (existingMines >= maxMines) {
                                        console.warn('[Weapon2] Cannot place mine - already at max:', maxMines);
                                        window.abilityManager.showFeedback('Max Mines Reached', '#ff4444');
                                        this.secondaryIndicator = null;
                                        return; // Don't place mine
                                }
                                
                                // Drop mine at indicator position with progression data
                                const success = window.abilityManager.tryCreateAbility(
                                        window.ProximityMine,
                                        2, // blood cost
                                        player,
                                        this.secondaryIndicator.x,
                                        this.secondaryIndicator.y,
                                        progression.secondary // Pass progression data to mine
                                );
                                
                                // Clear indicator AFTER sending request
                                this.secondaryIndicator = null;
                        }
                }
                
                // Weapon 3: Healing Box (hold to preview behind player, release to place)
                if (weaponIndex === 2) {
                        // Check if ability is unlocked at current loot level
                        const lootLevel = player.lootLevel || 0;
                        const progression = window.getWeaponProgression ? window.getWeaponProgression(2, lootLevel) : {};
                        const hasSecondary = progression.secondary !== undefined;
                        
                        if (!hasSecondary) {
                                // Clear any existing indicator if ability becomes locked
                                this.secondaryIndicator = null;
                                return; // Ability not unlocked yet
                        }
                        
                        // Check maxHealStations limit on mouse down (before showing indicator)
                        const maxHealStations = progression.secondary.maxHealStations;
                        if (this.secondaryJustPressed && maxHealStations !== undefined && window.abilityManager) {
                                // Count existing HealingBoxes owned by this player
                                let existingBoxes = 0;
                                for (const ability of window.abilityManager.abilities) {
                                        if (ability.constructor.name === 'HealingBox' && ability.owner?.id === player.id) {
                                                existingBoxes++;
                                        }
                                }
                                
                                if (existingBoxes >= maxHealStations) {
                                        window.abilityManager.showFeedback('Max Heal Stations Reached', '#ff4444');
                                        return; // Don't create indicator
                                }
                        }
                        
                        if (this.secondaryHeld && !this.secondaryIndicator) {
                                // Create placement indicator behind player (opposite of aim direction)
                                const aimAngle = Math.atan2(
                                        mouseScreen.y - (player.y - camera.y), 
                                        mouseScreen.x - (player.x - camera.x)
                                );
                                const distance = 50; // Place 50 units behind player
                                const placementX = player.x - Math.cos(aimAngle) * distance;
                                const placementY = player.y - Math.sin(aimAngle) * distance;
                                
                                // Get scaled heal radius from progression (50hp = 100 radius, 100hp = 150 radius, 150hp = 200 radius)
                                const healAmount = progression.secondary.healAmount || 50;
                                const diameterMultiplier = progression.secondary.healDiameterMultiplier || 1.0;
                                const baseHealRadius = 100;
                                const healRadius = baseHealRadius * diameterMultiplier;
                                
                                this.secondaryIndicator = {
                                        type: 'healingBox',
                                        x: placementX,
                                        y: placementY,
                                        radius: 20,
                                        healRadius: healRadius
                                };
                        }
                        
                        if (this.secondaryHeld && this.secondaryIndicator) {
                                // Update indicator position while held
                                const aimAngle = Math.atan2(
                                        mouseScreen.y - (player.y - camera.y), 
                                        mouseScreen.x - (player.x - camera.x)
                                );
                                const distance = 50;
                                this.secondaryIndicator.x = player.x - Math.cos(aimAngle) * distance;
                                this.secondaryIndicator.y = player.y - Math.sin(aimAngle) * distance;
                        }
                        
                        if (this.secondaryJustReleased && this.secondaryIndicator) {
                                // Re-check cap before placing
                                let existingBoxes = 0;
                                for (const ability of window.abilityManager.abilities) {
                                        if (ability.constructor.name === 'HealingBox' && ability.owner?.id === player.id) {
                                                existingBoxes++;
                                        }
                                }
                                
                                if (existingBoxes >= maxHealStations) {
                                        console.warn('[Weapon3] Cannot place heal station - already at max:', maxHealStations);
                                        window.abilityManager.showFeedback('Max Heal Stations Reached', '#ff4444');
                                        this.secondaryIndicator = null;
                                        return; // Don't place box
                                }
                                
                                // Place healing box at indicator position with progression data
                                const success = window.abilityManager.tryCreateAbility(
                                        window.HealingBox,
                                        2, // blood cost
                                        player,
                                        this.secondaryIndicator.x,
                                        this.secondaryIndicator.y,
                                        progression.secondary // Pass progression data to heal station
                                );
                                
                                // Clear indicator AFTER sending request
                                this.secondaryIndicator = null;
                        }
                }
                
                // Weapon 4: Molotov Fire Pool (hold targeting ring, release to throw)
                if (weaponIndex === 3) {
                        // Check if ability is unlocked at current loot level
                        const lootLevel = player.lootLevel || 0;
                        const progression = window.getWeaponProgression ? window.getWeaponProgression(3, lootLevel) : {};
                        const hasSecondary = progression.secondary !== undefined;
                        
                        if (!hasSecondary) {
                                // Clear any existing indicator if ability becomes locked
                                this.secondaryIndicator = null;
                                return; // Ability not unlocked yet (requires loot level 1+)
                        }
                        
                        // Check maxPools limit on mouse down (before showing indicator)
                        const maxPools = progression.secondary.maxPools;
                        if (this.secondaryJustPressed && maxPools !== undefined && window.abilityManager) {
                                // Count existing MolotovPools owned by this player
                                let existingPools = 0;
                                for (const ability of window.abilityManager.abilities) {
                                        if (ability.constructor.name === 'MolotovPool' && ability.owner?.id === player.id) {
                                                existingPools++;
                                        }
                                }
                                
                                if (existingPools >= maxPools) {
                                        window.abilityManager.showFeedback('Max Pools Reached', '#ff4444');
                                        return; // Don't create indicator
                                }
                        }
                        
                        if (this.secondaryJustPressed && !this.secondaryIndicator) {
                                // Create targeting ring indicator (2x weapon 2 explosion radius = 200)
                                const worldX = camera.x + mouseScreen.x;
                                const worldY = camera.y + mouseScreen.y;
                                const aimAngle = Math.atan2(
                                        worldY - player.y,
                                        worldX - player.x
                                );
                                
                                // Get pool diameter from progression
                                const poolDiameterMultiplier = progression.secondary?.poolDiameterMultiplier || 1.0;
                                const basePoolRadius = 200;
                                const poolRadius = basePoolRadius * poolDiameterMultiplier;
                                
                                this.secondaryIndicator = {
                                        type: 'molotovPool',
                                        x: worldX,
                                        y: worldY,
                                        angle: aimAngle,
                                        targetRadius: 200, // 2x weapon 2 radius
                                        poolRadius: poolRadius, // Scale pool size by progression
                                        fadeIn: 0,
                                        elapsed: 0
                                };
                        }
                        
                        if (this.secondaryHeld && this.secondaryIndicator) {
                                // Update targeting ring position while held
                                const worldX = camera.x + mouseScreen.x;
                                const worldY = camera.y + mouseScreen.y;
                                this.secondaryIndicator.x = worldX;
                                this.secondaryIndicator.y = worldY;
                                this.secondaryIndicator.angle = Math.atan2(
                                        worldY - player.y,
                                        worldX - player.x
                                );
                                
                                // Update pool radius in case lootLevel changed during hold (uses already-fetched progression)
                                const poolDiameterMultiplier = progression.secondary?.poolDiameterMultiplier || 1.0;
                                this.secondaryIndicator.poolRadius = 200 * poolDiameterMultiplier;
                        }
                        
                if (this.secondaryJustReleased && this.secondaryIndicator) {
                        // Re-check cap before placing (in case limit was reached while holding)
                        const maxPools = progression.secondary.maxPools;
                        let existingPools = 0;
                        if (window.abilityManager) {
                                for (const ability of window.abilityManager.abilities) {
                                        if (ability.constructor.name === 'MolotovPool' && ability.owner?.id === player.id) {
                                                existingPools++;
                                        }
                                }
                        }
                        
                        if (existingPools >= maxPools) {
                                console.warn('[Weapon4] Cannot place pool - already at max:', maxPools);
                                window.abilityManager.showFeedback('Max Pools Reached', '#ff4444');
                                this.secondaryIndicator = null;
                                return; // Don't throw molotov
                        }
                        
                        // Optional soft check - server is final authority
                        if (player.bloodMarkers !== undefined && player.bloodMarkers < 4) {
                                console.log('[Molotov] Client-side check: insufficient blood markers:', player.bloodMarkers);
                                if (window.abilityManager) {
                                        window.abilityManager.showFeedback('Out of Blood Markers', '#ff4444');
                                }
                                this.secondaryIndicator = null;
                                return;
                        }
                        
                        console.log('[Molotov] Firing - bloodMarkers:', player.bloodMarkers);
                        
                        // Launch fireball projectile that will create pool on impact
                                const targetX = this.secondaryIndicator.x;
                                const targetY = this.secondaryIndicator.y;
                                const w = this.current;
                                
                                // Create arc projectile similar to weapon 2
                                const spawnX = player.x;
                                const spawnY = player.y;
                                const dx = targetX - spawnX;
                                const dy = targetY - spawnY;
                                const dist = Math.hypot(dx, dy) || 1;
                                const dirX = dx / dist; // Normalized direction
                                const dirY = dy / dist;
                                const angle = Math.atan2(dy, dx);
                                
                                // Calculate initial velocity (use 600 speed like weapon 2)
                                const projectileSpeed = 600;
                                const vx = dirX * projectileSpeed;
                                const vy = dirY * projectileSpeed;
                                
                                // Random perpendicular bias for arc variety
                                const perp = (WorldRNG.random() < 0.5 ? -1 : 1);
                                
                                const options = {
                                        targetX: targetX,
                                        targetY: targetY,
                                        maxTurnRate: 10.0, // Slightly less curved than weapon 2
                                        bias: perp * 1.5,
                                        shadowEnabled: true,
                                        accelBallistic: true,
                                        ignoreEnvironment: true,
                                        ignoreEnemies: true,
                                        deathMolotov: true, // Special flag for molotov
                                        owner: player,
                                        bloodCost: 4 // Store blood cost for server validation
                                };
                                
                                // Create fireball projectile (orange/red color) with initial velocity
                                const fireball = (typeof window.createBullet === 'function')
                                        ? window.createBullet(spawnX, spawnY, vx, vy, 12, '#ff6600', 2.5, angle, false, options)
                                        : new Bullet(spawnX, spawnY, vx, vy, 12, '#ff6600', 2.5, angle, false, options);
                                
                                this.items.push(fireball);
                                
                                // Send fireball to other players
                                if (window.networkManager && player === window.player) {
                                        window.networkManager.sendBulletFired({
                                                x: spawnX,
                                                y: spawnY,
                                                vx: vx,
                                                vy: vy,
                                                radius: 12,
                                                color: '#ff6600',
                                                life: 2.5,
                                                angle: angle,
                                                noDamage: false,
                                                options: options,
                                                bias: fireball.bias,
                                                targetX: fireball.targetX,
                                                targetY: fireball.targetY,
                                                sourceWeaponIndex: this.currentIndex
                                        });
                                }
                                
                                // Clear indicator
                                this.secondaryIndicator = null;
                        }
		}
		
	// Weapon 5: Invisibility (hold to stay invisible, drains blood)
	if (weaponIndex === 4) {
		// Press right-click to activate invisibility
		if (this.secondaryJustPressed) {
			// Client-side check for loot level requirement (ability unlocks at loot 1)
			const lootLevel = player.lootLevel || 0;
			if (lootLevel < 1) {
				console.log('[Invisibility] Client-side check: insufficient loot level:', lootLevel);
				// TODO: Add custom warning later
				return;
			}
			
			// Client-side check for blood markers (server is final authority)
			if (player.bloodMarkers !== undefined && player.bloodMarkers < 1) {
				console.log('[Invisibility] Client-side check: insufficient blood markers:', player.bloodMarkers);
				// TODO: Add custom warning later
				return;
			}
			
			// Request invisibility activation from server
			if (window.networkManager && player === window.player) {
				window.networkManager.sendInvisibilityToggle(true);
			}
		}
			
			// Release right-click to deactivate invisibility
			if (this.secondaryJustReleased) {
				// Request invisibility deactivation from server
				if (window.networkManager && player === window.player) {
					window.networkManager.sendInvisibilityToggle(false);
				}
			}
		}
		
		// Weapon 6: Enemy Attractor (hold targeting ring, release to throw crucifix)
		if (weaponIndex === 5) {
                        // Check if ability is unlocked at current loot level
                        const lootLevel = player.lootLevel || 0;
                        const progression = window.getWeaponProgression ? window.getWeaponProgression(5, lootLevel) : {};
                        const hasSecondary = progression.secondary !== undefined;
                        
                        if (!hasSecondary) {
                                // Clear any existing indicator if ability becomes locked
                                this.secondaryIndicator = null;
                                return; // Ability not unlocked yet (need loot 1+)
                        }
                        
                        // Check maxAttractors limit on mouse down (before showing indicator)
                        const maxAttractors = progression.secondary.maxAttractors || 1;
                        if (this.secondaryJustPressed && window.abilityManager) {
                                // Count existing EnemyAttractors owned by this player
                                let existingAttractors = 0;
                                for (const ability of window.abilityManager.abilities) {
                                        if (ability.constructor.name === 'EnemyAttractor' && ability.owner?.id === player.id) {
                                                existingAttractors++;
                                        }
                                }
                                
                                if (existingAttractors >= maxAttractors) {
                                        window.abilityManager.showFeedback('Max Attractors Reached', '#ff4444');
                                        return; // Don't create indicator
                                }
                        }
                        
                        if (this.secondaryJustPressed && !this.secondaryIndicator) {
                                // Get radius multipliers from progression
                                const targetRadiusMultiplier = progression.secondary.targetRadiusMultiplier || 1.0;
                                const attractionRadiusMultiplier = progression.secondary.attractionRadiusMultiplier || 1.0;
                                
                                // Create targeting ring indicator with scaled radii
                                const worldX = camera.x + mouseScreen.x;
                                const worldY = camera.y + mouseScreen.y;
                                const aimAngle = Math.atan2(
                                        worldY - player.y,
                                        worldX - player.x
                                );
                                
                                // Base radii: target 150, attraction 200
                                const baseTargetRadius = 150;
                                const baseAttractionRadius = 200;
                                
                                this.secondaryIndicator = {
                                        type: 'enemyAttractor',
                                        x: worldX,
                                        y: worldY,
                                        angle: aimAngle,
                                        targetRadius: baseTargetRadius * targetRadiusMultiplier,
                                        attractionRadius: baseAttractionRadius * attractionRadiusMultiplier,
                                        fadeIn: 0,
                                        elapsed: 0
                                };
                        }
                        
                        if (this.secondaryHeld && this.secondaryIndicator) {
                                // Update targeting ring position while held
                                const worldX = camera.x + mouseScreen.x;
                                const worldY = camera.y + mouseScreen.y;
                                this.secondaryIndicator.x = worldX;
                                this.secondaryIndicator.y = worldY;
                                this.secondaryIndicator.angle = Math.atan2(
                                        worldY - player.y,
                                        worldX - player.x
                                );
                        }
                        
                        if (this.secondaryJustReleased && this.secondaryIndicator) {
                                // Optional soft check - server is final authority (now requires 6 blood markers)
                                if (player.bloodMarkers !== undefined && player.bloodMarkers < 6) {
                                        console.log('[EnemyAttractor] Client-side check: insufficient blood markers:', player.bloodMarkers);
                                        if (window.abilityManager) {
                                                window.abilityManager.showFeedback('Out of Blood Markers', '#ff4444');
                                        }
                                        this.secondaryIndicator = null;
                                        return;
                                }
                                
                                console.log('[EnemyAttractor] Firing - bloodMarkers:', player.bloodMarkers);
                                
                                // Launch crucifix projectile that will create attractor on impact
                                const targetX = this.secondaryIndicator.x;
                                const targetY = this.secondaryIndicator.y;
                                const w = this.current;
                                
                                // Create arc projectile similar to weapon 2
                                const spawnX = player.x;
                                const spawnY = player.y;
                                const dx = targetX - spawnX;
                                const dy = targetY - spawnY;
                                const dist = Math.hypot(dx, dy) || 1;
                                const dirX = dx / dist; // Normalized direction
                                const dirY = dy / dist;
                                const angle = Math.atan2(dy, dx);
                                
                                // Calculate initial velocity (use 550 speed for medium arc)
                                const projectileSpeed = 550;
                                const vx = dirX * projectileSpeed;
                                const vy = dirY * projectileSpeed;
                                
                                // Random perpendicular bias for arc variety
                                const perp = (WorldRNG.random() < 0.5 ? -1 : 1);
                                
                                const options = {
                                        targetX: targetX,
                                        targetY: targetY,
                                        maxTurnRate: 8.0,
                                        bias: perp * 1.2,
                                        shadowEnabled: true,
                                        accelBallistic: true,
                                        ignoreEnvironment: true,
                                        ignoreEnemies: true,
                                        deathYellowCircle: true, // Use yellow circle for landing VFX
                                        owner: player,
                                        bloodCost: 6, // Store blood cost for server validation (increased from 2 to 6)
                                        sourceWeaponIndex: 5 // Weapon 6 index for special handling
                                };
                                
                                // Create crucifix projectile (golden color) with initial velocity
                                const crucifix = (typeof window.createBullet === 'function')
                                        ? window.createBullet(spawnX, spawnY, vx, vy, 10, '#d4af37', 2.5, angle, false, options)
                                        : new Bullet(spawnX, spawnY, vx, vy, 10, '#d4af37', 2.5, angle, false, options);
                                
                                this.items.push(crucifix);
                                
                                // Send crucifix to other players
                                if (window.networkManager && player === window.player) {
                                        window.networkManager.sendBulletFired({
                                                x: spawnX,
                                                y: spawnY,
                                                vx: vx,
                                                vy: vy,
                                                radius: 10,
                                                color: '#d4af37',
                                                life: 2.5,
                                                angle: angle,
                                                noDamage: true,
                                                options: options,
                                                bias: crucifix.bias,
                                                targetX: crucifix.targetX,
                                                targetY: crucifix.targetY,
                                                sourceWeaponIndex: 5
                                        });
                                }
                                
                                // Clear indicator
                                this.secondaryIndicator = null;
                        }
                }
                
                // Weapon 7: Auto Turret (hold to preview behind player, release to place)
                if (weaponIndex === 6) {
                        // Check if secondary is unlocked (loot level 1+)
                        const lootLevel = player?.getEffectiveLootLevel?.() || 0;
                        const progression = window.getWeaponProgression?.(6, lootLevel) || {};
                        const hasSecondary = progression.secondary && progression.secondary.maxTurrets > 0;
                        
                        if (!hasSecondary) {
                                // Clear any existing indicator if ability becomes locked
                                if (this.secondaryIndicator?.type === 'autoTurret') {
                                        this.secondaryIndicator = null;
                                }
                                // Ability not unlocked yet
                        } else {
                                // Secondary is unlocked - handle placement
                                if (this.secondaryHeld && !this.secondaryIndicator) {
                                        // Create placement indicator behind player (opposite of aim direction)
                                        const aimAngle = Math.atan2(
                                                mouseScreen.y - (player.y - camera.y), 
                                                mouseScreen.x - (player.x - camera.x)
                                        );
                                        const distance = 50; // Place 50 units behind player
                                        const placementX = player.x - Math.cos(aimAngle) * distance;
                                        const placementY = player.y - Math.sin(aimAngle) * distance;
                                        
                                        this.secondaryIndicator = {
                                                type: 'autoTurret',
                                                x: placementX,
                                                y: placementY,
                                                radius: 25,
                                                targetingRadius: 210 // 60% of weapon 7
                                        };
                                }
                                
                                if (this.secondaryHeld && this.secondaryIndicator) {
                                        // Update indicator position while held
                                        const aimAngle = Math.atan2(
                                                mouseScreen.y - (player.y - camera.y), 
                                                mouseScreen.x - (player.x - camera.x)
                                        );
                                        const distance = 50;
                                        this.secondaryIndicator.x = player.x - Math.cos(aimAngle) * distance;
                                        this.secondaryIndicator.y = player.y - Math.sin(aimAngle) * distance;
                                }
                                
                                if (this.secondaryJustReleased && this.secondaryIndicator) {
                                        // Get loot-based progression for turret stats
                                        const secondaryMods = progression.secondary || {};
                                        
                                        // Place turret at indicator position with progression data
                                        const success = window.abilityManager.tryCreateAbility(
                                                window.AutoTurret,
                                                2, // blood cost
                                                player,
                                                this.secondaryIndicator.x,
                                                this.secondaryIndicator.y,
                                                {
                                                        turretHealth: secondaryMods.turretHealth,
                                                        maxCount: secondaryMods.maxTurrets
                                                }
                                        );
                                        
                                        // Clear indicator AFTER sending request
                                        this.secondaryIndicator = null;
                                }
                        }
                }
                
                // Clear indicator if weapon switched
                if (this.secondaryIndicator) {
                        if ((this.secondaryIndicator.type === 'shieldWall' && weaponIndex !== 0) ||
                            (this.secondaryIndicator.type === 'proximityMine' && weaponIndex !== 1) ||
                            (this.secondaryIndicator.type === 'healingBox' && weaponIndex !== 2) ||
                            (this.secondaryIndicator.type === 'molotovPool' && weaponIndex !== 3) ||
                            (this.secondaryIndicator.type === 'enemyAttractor' && weaponIndex !== 5) ||
                            (this.secondaryIndicator.type === 'autoTurret' && weaponIndex !== 6)) {
                                this.secondaryIndicator = null;
                        }
                }
        }
        
        drawSecondaryIndicator(ctx, camera) {
                if (!this.secondaryIndicator) return;
                
                const ind = this.secondaryIndicator;
                
                if (ind.type === 'shieldWall') {
                        // Draw dotted outline of where wall will be placed
                        const perpAngle = ind.angle + Math.PI / 2;
                        const halfW = ind.width / 2;
                        const halfD = ind.depth / 2;
                        
                        const fwdX = Math.cos(ind.angle);
                        const fwdY = Math.sin(ind.angle);
                        const perpX = Math.cos(perpAngle);
                        const perpY = Math.sin(perpAngle);
                        
                        const corners = [
                                { x: ind.x - perpX * halfW - fwdX * halfD, y: ind.y - perpY * halfW - fwdY * halfD },
                                { x: ind.x + perpX * halfW - fwdX * halfD, y: ind.y + perpY * halfW - fwdY * halfD },
                                { x: ind.x + perpX * halfW + fwdX * halfD, y: ind.y + perpY * halfW + fwdY * halfD },
                                { x: ind.x - perpX * halfW + fwdX * halfD, y: ind.y - perpY * halfW + fwdY * halfD }
                        ];
                        
                        ctx.save();
                        ctx.setLineDash([8, 6]);
                        ctx.strokeStyle = '#4da3ff';
                        ctx.globalAlpha = 0.7;
                        ctx.lineWidth = 3;
                        ctx.beginPath();
                        ctx.moveTo(corners[0].x - camera.x, corners[0].y - camera.y);
                        for (let i = 1; i < corners.length; i++) {
                                ctx.lineTo(corners[i].x - camera.x, corners[i].y - camera.y);
                        }
                        ctx.closePath();
                        ctx.stroke();
                        ctx.setLineDash([]);
                        ctx.restore();
                } else if (ind.type === 'proximityMine') {
                        // Draw dotted circle preview of mine placement
                        const sx = ind.x - camera.x;
                        const sy = ind.y - camera.y;
                        
                        ctx.save();
                        ctx.setLineDash([6, 4]);
                        ctx.strokeStyle = '#ff8800';
                        ctx.globalAlpha = 0.7;
                        ctx.lineWidth = 2;
                        ctx.beginPath();
                        ctx.arc(sx, sy, ind.radius, 0, Math.PI * 2);
                        ctx.stroke();
                        ctx.setLineDash([]);
                        ctx.restore();
                } else if (ind.type === 'healingBox') {
                        // Draw healing box placement preview
                        const sx = ind.x - camera.x;
                        const sy = ind.y - camera.y;
                        
                        ctx.save();
                        
                        // Draw healing radius circle (dashed)
                        ctx.globalAlpha = 0.3;
                        ctx.strokeStyle = '#00ff00';
                        ctx.lineWidth = 2;
                        ctx.setLineDash([10, 10]);
                        ctx.beginPath();
                        ctx.arc(sx, sy, ind.healRadius, 0, Math.PI * 2);
                        ctx.stroke();
                        ctx.setLineDash([]);
                        
                        // Draw dotted box outline
                        ctx.globalAlpha = 0.6;
                        ctx.strokeStyle = '#00ff00';
                        ctx.lineWidth = 2;
                        ctx.setLineDash([5, 5]);
                        const boxSize = ind.radius * 2;
                        ctx.strokeRect(sx - boxSize / 2, sy - boxSize / 2, boxSize, boxSize);
                        ctx.setLineDash([]);
                        
                        // Draw + sign
                        ctx.globalAlpha = 0.8;
                        ctx.strokeStyle = '#00ff00';
                        ctx.lineWidth = 3;
                        ctx.lineCap = 'round';
                        const crossSize = boxSize * 0.5;
                        ctx.beginPath();
                        ctx.moveTo(sx, sy - crossSize / 2);
                        ctx.lineTo(sx, sy + crossSize / 2);
                        ctx.stroke();
                        ctx.beginPath();
                        ctx.moveTo(sx - crossSize / 2, sy);
                        ctx.lineTo(sx + crossSize / 2, sy);
                        ctx.stroke();
                        
                        ctx.restore();
                } else if (ind.type === 'molotovPool') {
                        // Draw molotov targeting ring (scales with loot level)
                        const sx = ind.x - camera.x;
                        const sy = ind.y - camera.y;
                        
                        ctx.save();
                        
                        // Draw targeting circle outline (dashed) - matches pool size
                        ctx.globalAlpha = 0.5;
                        ctx.strokeStyle = '#ff6600';
                        ctx.lineWidth = 2;
                        ctx.setLineDash([10, 8]);
                        ctx.beginPath();
                        ctx.arc(sx, sy, ind.poolRadius, 0, Math.PI * 2);
                        ctx.stroke();
                        ctx.setLineDash([]);
                        
                        // Draw impact pool preview (solid inner circle)
                        ctx.globalAlpha = 0.3;
                        ctx.fillStyle = '#ff6600';
                        ctx.beginPath();
                        ctx.arc(sx, sy, ind.poolRadius, 0, Math.PI * 2);
                        ctx.fill();
                        
                        // Draw crosshair at center
                        ctx.globalAlpha = 0.7;
                        ctx.strokeStyle = '#ffaa33';
                        ctx.lineWidth = 2;
                        ctx.lineCap = 'round';
                        const crossSize = 15;
                        ctx.beginPath();
                        ctx.moveTo(sx - crossSize, sy);
                        ctx.lineTo(sx + crossSize, sy);
                        ctx.moveTo(sx, sy - crossSize);
                        ctx.lineTo(sx, sy + crossSize);
                        ctx.stroke();
                        
                        ctx.restore();
                } else if (ind.type === 'enemyAttractor') {
                        // Draw enemy attractor targeting ring (1.5x weapon 2 radius = 150)
                        const sx = ind.x - camera.x;
                        const sy = ind.y - camera.y;
                        
                        ctx.save();
                        
                        // Draw targeting circle outline (dashed, golden)
                        ctx.globalAlpha = 0.5;
                        ctx.strokeStyle = '#d4af37';
                        ctx.lineWidth = 2;
                        ctx.setLineDash([12, 8]);
                        ctx.beginPath();
                        ctx.arc(sx, sy, ind.targetRadius, 0, Math.PI * 2);
                        ctx.stroke();
                        ctx.setLineDash([]);
                        
                        // Draw attraction radius preview (inner circle)
                        ctx.globalAlpha = 0.2;
                        ctx.fillStyle = '#d4af37';
                        ctx.beginPath();
                        ctx.arc(sx, sy, ind.attractionRadius, 0, Math.PI * 2);
                        ctx.fill();
                        
                        // Draw simplified crucifix at center
                        ctx.globalAlpha = 0.7;
                        ctx.strokeStyle = '#c9b037';
                        ctx.lineWidth = 3;
                        ctx.lineCap = 'round';
                        const crossSize = 20;
                        const horizontalY = -crossSize * 0.3;
                        ctx.beginPath();
                        // Vertical bar
                        ctx.moveTo(sx, sy - crossSize);
                        ctx.lineTo(sx, sy + crossSize);
                        ctx.stroke();
                        // Horizontal bar
                        ctx.beginPath();
                        ctx.moveTo(sx - crossSize * 0.8, sy + horizontalY);
                        ctx.lineTo(sx + crossSize * 0.8, sy + horizontalY);
                        ctx.stroke();
                        
                        ctx.restore();
                } else if (ind.type === 'autoTurret') {
                        // Draw turret placement preview
                        const sx = ind.x - camera.x;
                        const sy = ind.y - camera.y;
                        
                        ctx.save();
                        
                        // Draw targeting radius circle (dashed, faint like weapon 7)
                        ctx.globalAlpha = 0.15;
                        ctx.strokeStyle = '#8a9aa8';
                        ctx.lineWidth = 2;
                        ctx.setLineDash([8, 6]);
                        ctx.beginPath();
                        ctx.arc(sx, sy, ind.targetingRadius, 0, Math.PI * 2);
                        ctx.stroke();
                        ctx.setLineDash([]);
                        
                        // Draw hexagon turret body outline (dark cool grey)
                        ctx.globalAlpha = 0.7;
                        ctx.strokeStyle = '#8a9aa8';
                        ctx.fillStyle = 'rgba(61, 70, 84, 0.5)'; // Dark cool grey with transparency
                        ctx.lineWidth = 2;
                        ctx.setLineDash([6, 4]);
                        ctx.beginPath();
                        const sides = 6;
                        for (let i = 0; i < sides; i++) {
                                const angle = (i / sides) * Math.PI * 2;
                                const px = sx + Math.cos(angle) * ind.radius;
                                const py = sy + Math.sin(angle) * ind.radius;
                                if (i === 0) {
                                        ctx.moveTo(px, py);
                                } else {
                                        ctx.lineTo(px, py);
                                }
                        }
                        ctx.closePath();
                        ctx.fill();
                        ctx.stroke();
                        ctx.setLineDash([]);
                        
                        // Draw twin barrel indicators (light cool grey)
                        ctx.globalAlpha = 0.8;
                        ctx.fillStyle = '#8a9aa8';
                        const barrelLength = 22;
                        const barrelOffset = 8;
                        const barrelWidth = 5;
                        ctx.fillRect(sx, sy - barrelOffset - barrelWidth/2, barrelLength, barrelWidth);
                        ctx.fillRect(sx, sy + barrelOffset - barrelWidth/2, barrelLength, barrelWidth);
                        
                        ctx.restore();
                }
        }

        update(dt, environment, enemies, player) {
                // Weapon 7: Track loot level changes and adjust ammo cap dynamically
                if (player) {
                    const currentLootLevel = player.getEffectiveLootLevel?.() || 0;
                    // Keep effective reload time in sync with loot (primary tiers)
                    this.ammo7ReloadSeconds = this.getWeapon7ReloadSeconds(player);
                    if (this._lastLootLevel === null) {
                        // First update: initialize ammo to current loot level's max
                        this._lastLootLevel = currentLootLevel;
                        const effectiveMax = this.getWeapon7MaxAmmo(player);
                        this.ammo7 = effectiveMax;
                    } else if (this._lastLootLevel !== currentLootLevel) {
                        // Loot level changed: clamp current ammo to new max if it exceeds
                        this._lastLootLevel = currentLootLevel;
                        const effectiveMax = this.getWeapon7MaxAmmo(player);
                        if (this.ammo7 > effectiveMax) {
                            this.ammo7 = effectiveMax;
                            console.log('[Weapon7] Loot level changed, clamping ammo to new max:', effectiveMax);
                        }
                    }
                }
                
                // Weapon 8: No local tracking needed - server is authoritative for blood markers
                
                // Update weapon 3 charge shot state
                if (this.currentIndex === 2 && this.charge3.active) {
                    // Increment charge time
                    this.charge3.chargeTime += dt;
                    
                    // Calculate charge progress (0..1)
                    const chargeProgress = Math.min(1, this.charge3.chargeTime / this.charge3.maxChargeTime);
                    
                    // Update VFX position at weapon tip (must update every frame to follow player)
                    if (this.charge3.vfx && player) {
                        // Calculate aim direction from player to mouse
                        const camera = window.camera || { x: 0, y: 0 };
                        const mouse = window.state?.mouse || { x: 0, y: 0 };
                        const mouseWorldX = camera.x + mouse.x;
                        const mouseWorldY = camera.y + mouse.y;
                        const dx = mouseWorldX - player.x;
                        const dy = mouseWorldY - player.y;
                        const len = Math.hypot(dx, dy) || 1;
                        const ux = dx / len;
                        const uy = dy / len;
                        
                        // Position at exact weapon tip (matches aim indicator length)
                        const tipOffset = 50;
                        const tipX = player.x + ux * tipOffset;
                        const tipY = player.y + uy * tipOffset;
                        
                        this.charge3.vfx.updatePosition(tipX, tipY);
                        this.charge3.vfx.setChargeProgress(chargeProgress);
                        this.charge3.vfx.update(dt);
                        
                        // Send charge update to other players (throttled to every 4 frames ~15Hz)
                        if (window.networkManager && player === window.player) {
                            this._chargeUpdateCounter = (this._chargeUpdateCounter || 0) + 1;
                            if (this._chargeUpdateCounter >= 4) {
                                this._chargeUpdateCounter = 0;
                                window.networkManager.sendVfxCreated('chargeUpdate', tipX, tipY, {
                                    progress: chargeProgress,
                                    playerId: window.networkManager.playerId,
                                    aimAngle: Math.atan2(dy, dx),
                                    color: this.current.color // Include color for missed chargeStart events
                                });
                            }
                        }
                    }
                }
                
                for (let i = this.items.length - 1; i >= 0; i--) {
                        const b = this.items[i];
                        
                        // Store previous position for ray-based collision (fast bullets)
                        const prevX = b.x;
                        const prevY = b.y;
                        
                        b.update(dt);
                        
                        // Cull OOB bullets (but not molotov fireballs - they need arc flight freedom)
			if (!b.deathMolotov && environment && environment.isInsideBounds && !environment.isInsideBounds(b.x, b.y, b.radius)) {
				// Return bullet to pool before removing (reduces GC pressure)
				if (typeof window.releaseBullet === 'function') window.releaseBullet(b);
				this.items.splice(i, 1);
				continue;
                        }
                        
                        // Weapon4 DOT cones check collision at TIP (front) to stop at shields
                        // Weapon1 melee cones check at origin (entire cone hits, no environment collision)
                        let checkX = b.x;
                        let checkY = b.y;
                        let checkRadius = b.radius;
                        
                        if (b.isCone && b.coneRange && b.sourceWeaponIndex === 3) {
                                // Weapon4 ONLY: Check at tip (90% of range) so DOT cones stop at shields
                                const checkDistance = b.coneRange * 0.9;
                                checkX = b.x + Math.cos(b.angle) * checkDistance;
                                checkY = b.y + Math.sin(b.angle) * checkDistance;
                                checkRadius = Math.max(b.radius, checkDistance * Math.tan(b.coneHalf || 0.2));
                        }
                        // Weapon1 cones (sourceWeaponIndex === 0) check at origin and have ignoreEnvironment = true
                        
                        // Ray-based collision for fast bullets (prevents tunneling through thin shields)
                        // Check if bullet moved more than 2x its radius (likely to tunnel through thin obstacles)
                        const moveDistSq = (b.x - prevX) * (b.x - prevX) + (b.y - prevY) * (b.y - prevY);
                        const rayThreshold = (checkRadius * 2) * (checkRadius * 2);
                        let hitsEnv = false;
                        
                        if (!b.ignoreEnvironment && moveDistSq > rayThreshold && environment && environment.lineHitsAny) {
                                // Fast bullet: use ray-based collision from previous position to current position
                                // Weapon 8 (sourceWeaponIndex === 7) ignores player shield walls
                                if (b.sourceWeaponIndex === 7 && environment.lineHitsAnyFiltered) {
                                        hitsEnv = environment.lineHitsAnyFiltered(prevX, prevY, checkX, checkY, (box) => {
                                                // Filter: return true to check this box, false to skip
                                                // Skip shield walls (player abilities)
                                                return !box._abilityId;
                                        });
                                } else {
                                        hitsEnv = environment.lineHitsAny(prevX, prevY, checkX, checkY);
                                }
                                
                                // Zombie projectiles ignore enemy shields but not environment walls
                                if (hitsEnv && b.isZombieProjectile && environment.orientedBoxes && environment.obstacles) {
                                        // Check if we hit an enemy shield
                                        let hitEnemyShield = false;
                                        for (let j = 0; j < environment.orientedBoxes.length; j++) {
                                                const box = environment.orientedBoxes[j];
                                                if (box._isEnemyShield && environment._lineIntersectsOrientedBox(prevX, prevY, checkX, checkY, box)) {
                                                        hitEnemyShield = true;
                                                        break;
                                                }
                                        }
                                        
                                        // Only pass through if we hit a shield AND didn't hit a wall
                                        if (hitEnemyShield) {
                                                // Check if we also hit any environment walls
                                                let hitWall = false;
                                                for (let j = 0; j < environment.obstacles.length; j++) {
                                                        const ob = environment.obstacles[j];
                                                        const left = ob.x - ob.w / 2;
                                                        const top = ob.y - ob.h / 2;
                                                        const right = left + ob.w;
                                                        const bottom = top + ob.h;
                                                        
                                                        // Liang-Barsky line-AABB intersection
                                                        let t0 = 0, t1 = 1;
                                                        const dx = checkX - prevX;
                                                        const dy = checkY - prevY;
                                                        
                                                        const clip = (p, q) => {
                                                                if (p === 0) return q >= 0;
                                                                const r = q / p;
                                                                if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
                                                                else { if (r < t0) return false; if (r < t1) t1 = r; }
                                                                return true;
                                                        };
                                                        
                                                        if (clip(-dx, prevX - left) && clip(dx, right - prevX) && 
                                                            clip(-dy, prevY - top) && clip(dy, bottom - prevY) && t0 <= t1) {
                                                                hitWall = true;
                                                                break;
                                                        }
                                                }
                                                
                                                // Only pass through shields if we didn't hit a wall
                                                if (!hitWall) {
                                                        hitsEnv = false;
                                                }
                                        }
                                }
                                
                                // Calculate approximate impact point (midpoint between prev and current for fast bullets)
                                // This gives a better visual result than using current position which is past the shield
                                if (hitsEnv) {
                                        b._rayHitX = (prevX + checkX) * 0.5;
                                        b._rayHitY = (prevY + checkY) * 0.5;
                                }
                        } else if (environment && environment.circleHitsAny) {
                                // Slow bullet or no lineHitsAny: use regular circle collision
                                // Weapon 8 (sourceWeaponIndex === 7) ignores player shield walls
                                if (b.sourceWeaponIndex === 7 && environment.circleHitsAnyFiltered) {
                                        hitsEnv = environment.circleHitsAnyFiltered(checkX, checkY, checkRadius, (box) => {
                                                // Filter: return true to check this box, false to skip
                                                // Skip shield walls (player abilities)
                                                return !box._abilityId;
                                        });
                                } else {
                                        hitsEnv = environment.circleHitsAny(checkX, checkY, checkRadius);
                                }
                                
                                // Zombie projectiles ignore enemy shields but not environment walls
                                if (hitsEnv && b.isZombieProjectile && environment.orientedBoxes && environment.obstacles) {
                                        // Check if we hit an enemy shield
                                        let hitEnemyShield = false;
                                        for (let j = 0; j < environment.orientedBoxes.length; j++) {
                                                const box = environment.orientedBoxes[j];
                                                if (box._isEnemyShield && environment._circleIntersectsOrientedBox(checkX, checkY, checkRadius, box)) {
                                                        hitEnemyShield = true;
                                                        break;
                                                }
                                        }
                                        
                                        // Only pass through if we hit a shield AND didn't hit a wall
                                        if (hitEnemyShield) {
                                                // Check if we also hit any environment walls
                                                let hitWall = false;
                                                for (let j = 0; j < environment.obstacles.length; j++) {
                                                        const ob = environment.obstacles[j];
                                                        const left = ob.x - ob.w / 2;
                                                        const top = ob.y - ob.h / 2;
                                                        const right = left + ob.w;
                                                        const bottom = top + ob.h;
                                                        const closestX = Math.max(left, Math.min(checkX, right));
                                                        const closestY = Math.max(top, Math.min(checkY, bottom));
                                                        const dx = checkX - closestX;
                                                        const dy = checkY - closestY;
                                                        
                                                        if ((dx * dx + dy * dy) < (checkRadius * checkRadius)) {
                                                                hitWall = true;
                                                                break;
                                                        }
                                                }
                                                
                                                // Only pass through shields if we didn't hit a wall
                                                if (!hitWall) {
                                                        hitsEnv = false;
                                                }
                                        }
                                }
                        }
                        
                        if (b.life <= 0 || (hitsEnv && !b.ignoreEnvironment)) {
                                // Debug: on receiver, flag remote weapon 9 bullets that expired without a hit relay
                                try {
						if (window.DEBUG_WEAPON9_SYNC && b._fromRemotePlayer && b.sourceWeaponIndex === 8) {
								console.log('[Weapon9][NoHit] remote bullet expired without enemy hit', { x: b.x, y: b.y });
						}
					} catch(_) {}
					// Return bullet to pool before removing (reduces GC pressure)
					if (typeof window.releaseBullet === 'function') window.releaseBullet(b);
					this.items.splice(i, 1);
                                // Skip VFX for weapon 1/no-damage cones, EXCEPT weapon 7 (which needs wall impacts)
                                if (!b.noDamage || b.sourceWeaponIndex === 6) {
                                        // Check for weapon 6 crucifix FIRST (before generic deathYellowCircle)
                                        if (b.sourceWeaponIndex === 5 && b.deathYellowCircle) {
                                                // Enemy attractor crucifix landed - just spawn attractor (no explosion)
                                                const finalX = b.x;
                                                const finalY = b.y;
                                                
                                                // Request server to create enemy attractor
                                                if (window.abilityManager && b.owner === window.player) {
                                                        window.abilityManager.tryCreateAbility(
                                                                window.EnemyAttractor,
                                                                b.bloodCost || 2,
                                                                b.owner,
                                                                finalX,
                                                                finalY
                                                        );
                                                }
                                        } else if (b.deathYellowCircle) {
                                                const finalX = b.x;
                                                const finalY = b.y;
                                                
                                                // Get explosion multipliers from bullet options (for weapon 2 progression)
                                                const explosionRadiusMultiplier = b.explosionRadiusMultiplier || 1.0;
                                                const explosionDamageMultiplier = b.explosionDamageMultiplier || 1.0;
                                                const baseRadius = 100;
                                                const effectiveExplosionRadius = baseRadius * explosionRadiusMultiplier;
                                                
                                                // Screen shake for nearby explosions (enemy artillery, enemy grenades, etc.)
                                                // Friendly support fire (artillery guns / base defenses) must NOT look like player damage.
                                                if (b.serverSpawned && !b.isFriendly && window.player) {
                                                        const distToPlayer = Math.hypot(finalX - window.player.x, finalY - window.player.y);
                                                        const maxShakeRange = 700; // Max range for any screen shake
                                                        const directHitRange = 180; // Within blast radius = max intensity
                                                        
                                                        if (distToPlayer < maxShakeRange) {
                                                                // Calculate intensity: 1.0 at directHitRange, 0.0 at maxShakeRange
                                                                let intensity;
                                                                if (distToPlayer <= directHitRange) {
                                                                        intensity = 1.0; // Direct hit = max intensity
                                                                } else {
                                                                        // Linear falloff from 1.0 to 0.0 between directHitRange and maxShakeRange
                                                                        intensity = 1.0 - (distToPlayer - directHitRange) / (maxShakeRange - directHitRange);
                                                                }
                                                                intensity = Math.max(0, Math.min(1, intensity));
                                                                
                                                                // Screen shake based on artillery type
                                                                const scaledIntensity = intensity * intensity;  // Quadratic - ramps up sharply at close range
                                                                let shakeMag, shakeDur;
                                                                if (b.artilleryType === 'artilleryGun') {
                                                                        // Artillery Gun (friendly) - boosted shake: 90-240 magnitude
                                                                        shakeMag = 90 + 150 * scaledIntensity;
                                                                        shakeDur = 0.35 + 0.25 * scaledIntensity;
                                                                } else {
                                                                        // Witch and other explosions - original shake: 45-120 magnitude
                                                                        shakeMag = 45 + 75 * scaledIntensity;
                                                                        shakeDur = 0.35 + 0.25 * scaledIntensity;
                                                                }
                                                                if (window.state && typeof window.state.triggerScreenShake === 'function') {
                                                                        window.state.triggerScreenShake(shakeMag, shakeDur);
                                                                } else if (typeof window.triggerScreenShake === 'function') {
                                                                        window.triggerScreenShake(shakeMag, shakeDur);
                                                                }
                                                                // Vignette only triggers if player takes damage (handled by damage system)
                                                        }
                                                }
                                                
                                                // Spawn grenade-like explosion VFX scaled to match targeting ring
                                                // Targeting ring is 100 * mult, so we want flash to also be 100 * mult
                                                // ExplosionVfx flash is 90 at scale 1.0, so we need to scale it to match 100
                                                // vfxScale = (targetRingRadius / flashBaseSize) = (100 * mult) / 90
                                                const targetRingRadius = baseRadius * explosionRadiusMultiplier; // 100 * mult
                                                const flashBaseSize = 90;
                                                const vfxScale = targetRingRadius / flashBaseSize;
                                                const logTag = b.troopFired ? '[TroopGrenade]' : '[Weapon2]';
                                                if (window.DEBUG_WEAPON2_EXPLOSIONS === true) {
                                                        console.log(logTag + ' Explosion - targetRing:', targetRingRadius.toFixed(1), 'flashBase:', flashBaseSize, 'vfxScale:', vfxScale.toFixed(3), 'mult:', explosionRadiusMultiplier.toFixed(2));
                                                }
                                                // Use pooled ExplosionVfx when available to reduce allocations/GC during heavy grenade spam.
                                                const explosionVfx = (typeof window.createExplosionVfx === 'function')
                                                        ? window.createExplosionVfx(finalX, finalY, '#ffae00', { scale: vfxScale })
                                                        : new ExplosionVfx(finalX, finalY, '#ffae00', { scale: vfxScale });
                                                this.impacts.push(explosionVfx);
                                                // Send VFX to other players for synchronization
                                                if (window.networkManager && b.owner === window.player) {
                                                        window.networkManager.sendVfxCreated('explosion', finalX, finalY, { color: '#ffae00', scale: vfxScale });
                                                }
                                                const baseOffset = (WorldRNG.random() * 10 - 5); // ±5 base damage offset
                                                const isTroopGrenade = b.troopFired || false;
                                                this.impacts.push({
                                                        life: 0.25,
                                                        totalLife: 0.25,
                                                        radius: effectiveExplosionRadius,
                                                        hitEnemyIds: new Set(),
                                                        didDamage: false, // IMPORTANT: explosion damage should apply once (not every frame)
                                                        owner: b.owner || null,
                                                        baseOffset: baseOffset,
                                                        hitSelf: false,
                                                        pvpDataSent: false, // Flag to ensure PvP explosion data is sent only once
                                                        explosionDamageMultiplier: explosionDamageMultiplier,
                                                        serverSpawned: b.serverSpawned || b._serverEnemyBullet, // Server-spawned projectiles = server-authoritative damage
                                                        troopFired: isTroopGrenade, // Track if this is a troop grenade for logging
                                                        draw: function(ctx, cam) {
                                                                const t = Math.max(this.life, 0) / this.totalLife;
                                                                const alpha = 1.0 * t;
                                                                const sx = finalX - cam.x;
                                                                const sy = finalY - cam.y;
                                                                ctx.save();
                                                                ctx.globalAlpha = alpha;
                                                                ctx.fillStyle = '#ffff00';
                                                                ctx.beginPath();
                                                                ctx.arc(sx, sy, this.radius, 0, Math.PI * 2);
                                                                ctx.fill();
                                                                ctx.restore();
                                                        },
                                                        update: function(dt, enemies) {
                                                                this.life -= dt;
                                                                if (this.didDamage) return;
                                                                
                                                                // Troop grenades: server-authoritative damage.
                                                                // Client should render the explosion VFX but must NOT apply damage or relay explosionDamage,
                                                                // otherwise damage can scale with player stats and/or be applied multiple times in MP.
                                                                const isConnected = !!(window.networkManager && window.networkManager.connected);
                                                                if (this.troopFired && isConnected) {
                                                                        this.didDamage = true;
                                                                        return;
                                                                }

                                                                // Troop-fired grenades should NEVER damage the player (friendly fire prevention)
                                                                if (this.troopFired) {
                                                                        // Skip player damage completely for troop grenades
                                                                        // Fall through to enemy damage code below
                                                                }
                                                                // If owner is an enemy, damage the player; otherwise damage enemies
                                                                else if (this.owner && window.Enemy && (this.owner instanceof window.Enemy)) {
                                                                        // Skip damage if server-spawned (server handles it authoritatively)
                                                                        // Client only renders VFX; server applies damage and broadcasts health update
                                                                        if (this.serverSpawned) {
                                                                                this.didDamage = true;
                                                                                return; // VFX only - server will apply damage
                                                                        }
                                                                        
                                                                        if (!this.hitPlayer && window.player) {
                                                                                const p = window.player;
                                                                                const dxp = p.x - finalX;
                                                                                const dyp = p.y - finalY;
                                                                                const dp = Math.hypot(dxp, dyp);
                                                                                if (dp <= this.radius + (p.radius || 0)) {
                                                                                        const inner = 20;
                                                                                        const outer = this.radius; // 100
                                                                                        let tp = (dp - inner) / Math.max(1e-6, (outer - inner));
                                                                                        tp = Math.max(0, Math.min(1, tp));
                                                                                        const damage = (window.DEBUG_ARTILLERY_LOW_DAMAGE ? 1 : (95 - 75 * tp));
                                                                                        p.health -= damage;
                                                                                        if (p.health < 0) p.health = 0;
                                                                                        this.hitPlayer = true;
                                                                                }
                                                                        }
                                                                        // Explosions apply at detonation time; do not re-check every frame.
                                                                        this.didDamage = true;
                                                        return;
                                                }
                                                
                                                // Enemy explosions damage enemies - continue to enemy damage code
                                                if (!enemies || !enemies.queryCircle) {
                                                        this.didDamage = true;
                                                        return;
                                                }
                                                // Pad query radius to include large enemies (BigBoy radius 80) since we later test
                                                // against (this.radius + e.radius). queryCircle() is center-distance based.
                                                const candidates = enemies.queryCircle(finalX, finalY, this.radius + 80);
                                                // Include hostile NPC_B as valid targets (same pattern as regular projectiles)
                                                let victims = Array.isArray(candidates) ? candidates.slice() : (enemies.items || []);
                                                try {
                                                        const list = window?.npcs?.items || [];
                                                        for (let ni = 0; ni < list.length; ni++) {
                                                                const n = list[ni];
                                                                if (!n || !n.alive) continue;
                                                                if (n.name === 'NPC_B' && n.state === 'hostile') {
                                                                        // Check if NPC is within explosion radius
                                                                        const dxn = n.x - finalX;
                                                                        const dyn = n.y - finalY;
                                                                        if (Math.hypot(dxn, dyn) <= this.radius + (n.radius || 26)) {
                                                                                victims.push(n);
                                                                        }
                                                                }
                                                        }
                                                } catch(_) {}
                                                const relayHits = [];
                                                for (let i = 0; i < victims.length; i++) {
                                                        const e = victims[i];
                                                        if (!e || !e.alive) continue;
                                                        if (this.hitEnemyIds.has(e.id)) continue;
                                                        const dx = e.x - finalX;
                                                        const dy = e.y - finalY;
                                                        const d = Math.hypot(dx, dy);
                                                                        if (d <= this.radius + e.radius) {
                                                                                const inner = 20;
                                                                                const outer = this.radius;
                                                                                let t = (d - inner) / Math.max(1e-6, (outer - inner));
                                                                                t = Math.max(0, Math.min(1, t));
                                                                                let damage = 0;
                                                                                let isCrit = false;

                                                                                if (this.troopFired) {
                                                                                        // Fixed troop grenade damage: 15 at inner, 5 at edge (no crit, no loot scaling)
                                                                                        damage = 15 - 10 * t;
                                                                                        isCrit = false;
                                                                                } else {
                                                                                        // Apply explosion damage multiplier (for weapon 2 progression)
                                                                                        const damageMultiplier = this.explosionDamageMultiplier || 1.0;
                                                                                        damage = ((100 - 80 * t) + (this.baseOffset || 0)) * damageMultiplier; // add ±5 base offset, then multiply
                                                                                        try { damage += Math.max(0, this.owner?.getTotalAttackPowerFlat?.() || 0); } catch(_) {}
                                                                                        try {
                                                                                                const owner = this.owner;
                                                                                                const cc = Math.max(0, Math.min(1, owner?.critChance ?? 0));
                                                                                                const cm = Math.max(1, owner?.critDamageMultiplier ?? 1);
                                                                                                isCrit = Math.random() < cc;
                                                                                                if (isCrit) damage *= cm;
                                                                                        } catch(e) {}
                                                                                }
                                                                                
                                                                                // Check if this is NPC_B for server-authoritative damage
                                                                                const isNpcB = e.name === 'NPC_B';
                                                                                
                                                                                // For NPC_B, send damage to server; for other enemies apply locally
                                                                                if (isNpcB && e._serverId && window.networkManager && this.owner === window.player) {
                                                                                    window.networkManager.sendNPCDamage(e._serverId, Math.round(damage), false);
                                                                                } else {
                                                                                    e.applyDamage(damage, { x: finalX, y: finalY, dirX: Math.cos(b.angle) * b.speed, dirY: Math.sin(b.angle) * b.speed });
                                                                                }
                                                                                
                                                                                // Log troop grenade hits for debugging
                                                                                if (this.troopFired) {
                                                                                    if (window.DEBUG_TROOP_GRENADE === true) {
                                                                                        console.log('[TroopGrenade] Hit enemy', e.type, 'for', Math.round(damage), 'damage (dist:', d.toFixed(1), 'radius:', this.radius, ')');
                                                                                    }
                                                                                }
                                                                                
                                                                                // Relay explosion damage hits to other clients (skip NPC_B - server handles it)
                                                                                try {
                                                                                        if (!this.troopFired && window.networkManager && e._serverId && !isNpcB) {
                                                                                                relayHits.push({ id: e._serverId, damage: Math.round(damage), crit: !!isCrit });
                                                                                        }
                                                                                } catch(_) {}
                                                                                try {
                                                                                        // Only create client-side damage text for non-server-synchronized enemies
                                                                                        // Server-synchronized entities (like target dummies and NPC_B) get authoritative damage text from server
                                                                                        const isServerSync = e.serverSync || (e.name === 'NPC_B');
                                                                                        if (window.enqueueDamageText && !isServerSync) {
                                                                                                window.enqueueDamageText({ x: e.x, y: e.y - (e.radius || 26) - 6, text: Math.round(damage).toString(), crit: isCrit, color: isCrit ? '#ffd36b' : '#ffffff', vy: -80, life: 0.8 });
                                                                                        }
                                                                                } catch(_) {}
                                                                this.hitEnemyIds.add(e.id);
                                                        }
                                                }
                                                // Send explosion data to server ONCE for PvP collision detection
                                                if (!this.troopFired && !this.pvpDataSent && window.networkManager) {
                                                        this.pvpDataSent = true;
                                                        try { 
                                                                // Send explosion data including position and radius for PvP
                                                                // Use baseOffset and owner stats for server to calculate damage
                                                                window.networkManager.socket.emit('explosionDamage', { 
                                                                        hits: relayHits,
                                                                        x: finalX,
                                                                        y: finalY,
                                                                        radius: this.radius || 100,
                                                                        baseOffset: this.baseOffset || 0,
                                                                        attackPower: this.owner?.getTotalAttackPowerFlat?.() || 0,
                                                                        critChance: this.owner?.critChance || 0,
                                                                        critMultiplier: this.owner?.critDamageMultiplier || 1.2
                                                                }); 
                                                        } catch(_) {}
                                                }
                                                // Explosion damage is instant; do not re-run this loop every frame.
                                                this.didDamage = true;
                                                                // Remove self-damage for enemy-owner explosions
                                                        }
                                                });
                                        } else if (b.deathMolotov) {
                                                // Molotov fireball landed - create fire pool
                                                const finalX = b.x;
                                                const finalY = b.y;
                                                const angle = b.angle || 0;
                                                
                                                console.log('[Weapon4][Molotov] 🎯 Fireball LANDED at', finalX.toFixed(1), finalY.toFixed(1), 
                                                            'angle:', angle.toFixed(2), 'timestamp:', Date.now(), 
                                                            'isOwner:', (b.owner === window.player), 
                                                            'hasAbilityManager:', !!window.abilityManager);
                                                
                                                // Spawn explosion VFX at impact
                                                // Use pooled ExplosionVfx when available (reduces allocations).
                                                this.impacts.push(
                                                        (typeof window.createExplosionVfx === 'function')
                                                                ? window.createExplosionVfx(finalX, finalY, '#ff6600')
                                                                : new ExplosionVfx(finalX, finalY, '#ff6600')
                                                );
                                                console.log('[Weapon4][Molotov] 🔥 Explosion VFX spawned');
                                                
                                                // Send VFX to other players
                                                if (window.networkManager && b.owner === window.player) {
                                                        window.networkManager.sendVfxCreated('explosion', finalX, finalY, { color: '#ff6600' });
                                                        console.log('[Weapon4][Molotov] 📡 VFX sent to other players');
                                                }
                                                
                                                // Request server to create fire pool
                                                if (window.abilityManager && b.owner === window.player) {
                                                        // Get loot-based progression modifiers for weapon 4
                                                        const lootLevel = b.owner?.getEffectiveLootLevel?.() || 0;
                                                        const progression = window.getWeaponProgression?.(3, lootLevel) || {};
                                                        const secondaryMods = progression.secondary || {};
                                                        
                                                        console.log('[Weapon4][Molotov] 🌐 REQUESTING MolotovPool from server at', 
                                                                    finalX.toFixed(1), finalY.toFixed(1), 
                                                                    'bloodCost:', (b.bloodCost || 4), 
                                                                    'loot:', lootLevel,
                                                                    'dotMult:', secondaryMods.dotDamageMultiplier || 1.0,
                                                                    'diamMult:', secondaryMods.poolDiameterMultiplier || 1.0,
                                                                    'timestamp:', Date.now());
                                                        
                                                        const success = window.abilityManager.tryCreateAbility(
                                                                window.MolotovPool,
                                                                b.bloodCost || 4,
                                                                b.owner,
                                                                finalX,
                                                                finalY,
                                                                angle,
                                                                secondaryMods // Pass progression modifiers
                                                        );
                                                        
                                                        console.log('[Weapon4][Molotov]', success ? '✅ Request sent successfully' : '❌ Request FAILED');
                                                } else {
                                                        console.warn('[Weapon4][Molotov] ⚠️ SKIPPED pool creation - abilityManager:', !!window.abilityManager, 'isOwner:', (b.owner === window.player));
                                                }
                                        } else {
                                                // Impact should scatter away from surface; bias opposite bullet velocity
                                                // Scale impacts by projectile's configured scale
                                                // For weapon4 DOT cones, spawn impact at tip (front) where collision occurs
                                                // For fast bullets with ray collision, use the calculated hit point
                                                let impactX = b.x;
                                                let impactY = b.y;
                                                
                                                if (b._rayHitX !== undefined && b._rayHitY !== undefined) {
                                                        // Fast bullet with ray-based collision - use calculated hit point
                                                        impactX = b._rayHitX;
                                                        impactY = b._rayHitY;
                                                } else if (b.isCone && b.coneRange && b.sourceWeaponIndex === 3) {
                                                        // Weapon4 DOT cone - spawn at tip
                                                        impactX = b.x + Math.cos(b.angle) * b.coneRange;
                                                        impactY = b.y + Math.sin(b.angle) * b.coneRange;
                                                }
                                                
                                                this.impacts.push(new ImpactVfx(impactX, impactY, b.color, -b.vx, -b.vy, { scale: b.impactScale || 1 }));
                                                // Send VFX to other players for synchronization
                                                if (window.networkManager && b.owner === window.player) {
                                                        window.networkManager.sendVfxCreated('impact', impactX, impactY, {
                                                                color: b.color,
                                                                dirX: -b.vx,
                                                                dirY: -b.vy,
                                                                options: { scale: b.impactScale || 1 }
                                                        });
                                                }
                                        }
                                }
                        }
                }

                // Weapon 5 burst scheduler (continues even if weapon switched after first shot)
                if (this.burst5 && this.burst5.active && player) {
                        this.burst5.timer -= dt;
                        while (this.burst5.shotsRemaining > 0 && this.burst5.timer <= 0) {
                                const w5 = this.weapons[4];
                                const dirX = Math.cos(this.burst5.angle);
                                const dirY = Math.sin(this.burst5.angle);
                                const spawnX = player.x + dirX * (player.radius + 8);
                                const spawnY = player.y + dirY * (player.radius + 8);
                                const vx = dirX * w5.projectileSpeed;
                                const vy = dirY * w5.projectileSpeed;
                                const options = { targetX: player.x + this.burst5.ux * 10000, targetY: player.y + this.burst5.uy * 10000, maxTurnRate: 2.5, shape: 'oval', ovalLength: Math.max(24, w5.projectileRadius * 5.6), ovalWidth: Math.max(8, w5.projectileRadius * 2.2), ovalPoint: 0.6, sourceWeaponIndex: 4, owner: player };
                                // Weapon 5 burst bullets should always be damaging projectiles
					// Use pooled bullet for better performance (10-20% FPS boost)
					const burstBullet = (typeof window.createBullet === 'function')
						? window.createBullet(spawnX, spawnY, vx, vy, w5.projectileRadius, w5.color, w5.projectileLife, this.burst5.angle, false, options)
						: new Bullet(spawnX, spawnY, vx, vy, w5.projectileRadius, w5.color, w5.projectileLife, this.burst5.angle, false, options);
		this.items.push(burstBullet);
                
                // Send burst bullet data to other players for synchronization
                if (window.networkManager && player === window.player) {
                    window.networkManager.sendBulletFired({
                        x: spawnX, y: spawnY, vx: vx, vy: vy,
                        radius: w5.projectileRadius, color: w5.color, life: w5.projectileLife,
                        angle: this.burst5.angle, noDamage: false, options: options,
                        bias: burstBullet.bias, targetX: burstBullet.targetX, targetY: burstBullet.targetY,
                        sourceWeaponIndex: 4
                    });
                }
                                this.burst5.shotsRemaining -= 1;
                                this.burst5.timer += this.burst5.interval;
                        }
                        if (this.burst5.shotsRemaining <= 0) this.burst5.active = false;
                }
                
                // Weapon 8 (index 7) ADS and Recoil Update
                if (this.currentIndex === 7) {
                    // ADS Logic
                    this.isADS = this.secondaryHeld; // Right click holds ADS
                    
                    // Set target zoom based on ADS state (< 1.0 = zoom out, > 1.0 = zoom in)
                    this.targetZoom = this.isADS ? 0.7 : 1.0;
                    
                    // Smoothly interpolate current zoom to target (takes ~0.4s to transition)
                    const zoomSpeed = 2.5; // Higher = faster transition
                    if (Math.abs(this.currentZoom - this.targetZoom) > 0.001) {
                        this.currentZoom += (this.targetZoom - this.currentZoom) * Math.min(1.0, zoomSpeed * dt);
                    } else {
                        this.currentZoom = this.targetZoom;
                    }
                    
                    // Update global zoom level
                    if (typeof window !== 'undefined') {
                        if (window.player) window.player.isADS = this.isADS;
                        if (window.clientRender) {
                            window.clientRender.zoomLevel = this.currentZoom;
                        }
                    }
                    
                    // Visual recoil snaps out instantly on fire, then smoothly tracks actual recoil
                    // No spring physics - just fast decay back to actual recoil position
                    if (this.recoil8Visual > this.recoil8) {
                        // Visual catches up to actual quickly (0.15 second snap back after overshoot)
                        const visualDecayRate = (this.recoil8Visual - this.recoil8) / 0.15;
                        this.recoil8Visual = Math.max(this.recoil8, this.recoil8Visual - dt * visualDecayRate);
                    } else {
                        // Keep visual synced with actual
                        this.recoil8Visual = this.recoil8;
                    }
                    
                    // Recoil decay - constant recovery time regardless of peak
                    if (this.recoil8 > 0) {
                        // Decay rate scales with peak so recovery time is constant (~1.5 seconds)
                        // Higher peak = faster decay, maintaining consistent 1.5-second recovery
                        const targetRecoveryTime = 1.5; // seconds
                        const decayRate = Math.max(5.0, this.recoil8PeakTracker / targetRecoveryTime);
                        this.recoil8 = Math.max(0, this.recoil8 - dt * decayRate);
                        
                        // Reset peak tracker when recoil reaches 0
                        if (this.recoil8 <= 0) {
                            this.recoil8PeakTracker = 0;
                        }
                    }
                }
 
                for (let i = this.impacts.length - 1; i >= 0; i--) {
                        const imp = this.impacts[i];
                        imp.update(dt, enemies);
                        if (imp.life <= 0) {
                                // Return pooled ExplosionVfx objects back to the pool (if pooling is enabled).
                                try {
                                        if (typeof window.releaseExplosionVfx === 'function' && window.ExplosionVfx && imp instanceof window.ExplosionVfx) {
                                                window.releaseExplosionVfx(imp);
                                        }
                                } catch(_) {}
                                this.impacts.splice(i, 1);
                        }
                }
                // Update weapon 7 reload timer
                if (this.ammo7ReloadTimer && this.ammo7ReloadTimer > 0) {
                        this.ammo7ReloadTimer -= dt;
                        if (this.ammo7ReloadTimer <= 0) {
                                this.ammo7ReloadTimer = 0;
                                // Refill to effective max based on loot level
                                try {
                                        this.ammo7 = this.getWeapon7MaxAmmo(window.player);
                                } catch(_) {
                                        this.ammo7 = this.ammo7Max;
                                }
                        }
                }
                // Cooldown for reload hint label
                if (this._reloadHintCooldown && this._reloadHintCooldown > 0) {
                        this._reloadHintCooldown -= dt;
                        if (this._reloadHintCooldown < 0) this._reloadHintCooldown = 0;
                }
                // Update targeting ring visibility (weapon 2)
                if (this.targetRing) {
                        const r = this.targetRing;
                        r.elapsed = (r.elapsed || 0) + dt;
                        r.autoTimer = (r.autoTimer || 0) + dt;
                        // If weapon switched away from 2, immediately start fading out
                        if (this.currentIndex !== 1) r.fadingOut = true;
                        // Auto-fade if idle too long without firing
                        if (!r.fadingOut && r.autoDelay != null && r.autoTimer > r.autoDelay) r.fadingOut = true;
                        if (r.fadingOut) {
                                const out = (r.fadeOut != null && r.fadeOut > 0) ? r.fadeOut : 0.35;
                                r.alpha = Math.max(0, (r.alpha != null ? r.alpha : 1) - dt / out);
                                if (r.alpha <= 0) this.targetRing = null;
                        } else {
                                // Fade-in toward full while active
                                const dur = (r.fadeIn != null) ? r.fadeIn : 1.0;
                                const t = dur > 0 ? Math.min(1, r.elapsed / dur) : 1;
                                r.alpha = t;
                        }
                }
        }

        draw(ctx, camera) {
                for (let i = 0; i < this.items.length; i++) this.items[i].draw(ctx, camera);
                for (let i = 0; i < this.impacts.length; i++) this.impacts[i].draw(ctx, camera);
        // Draw persistent targeting ring for weapon 2 if present
        if (this.targetRing) {
            const baseRadius = 100;
            const ringRadius = baseRadius * (this.targetRing.explosionRadiusMultiplier || 1.0);
            if (window.DEBUG_WEAPON2_EXPLOSIONS === true && Math.random() < 0.02) {
                console.log('[Weapon2] Drawing ring - mult:', this.targetRing.explosionRadiusMultiplier, 'radius:', ringRadius.toFixed(1));
            }
            const sx = this.targetRing.cx - camera.x;
            const sy = this.targetRing.cy - camera.y;
            ctx.save();
            ctx.translate(sx, sy);
            const a = (this.targetRing.alpha != null ? this.targetRing.alpha : 1);
            try {
                const hex = this.targetRing.color;
                const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
                const r = m ? parseInt(m[1], 16) : 255;
                const g = m ? parseInt(m[2], 16) : 255;
                const b = m ? parseInt(m[3], 16) : 255;
                const glowR = ringRadius * 1.6;
                const grad = ctx.createRadialGradient(0, 0, ringRadius * 0.2, 0, 0, glowR);
                grad.addColorStop(0, 'rgba(' + r + ',' + g + ',' + b + ',' + (0.18 * a) + ')');
                grad.addColorStop(1, 'rgba(' + r + ',' + g + ',' + b + ',0)');
                ctx.fillStyle = grad;
                ctx.beginPath();
                ctx.arc(0, 0, glowR, 0, Math.PI * 2);
                ctx.fill();
            } catch(e) {}
            ctx.strokeStyle = this.targetRing.color;
            ctx.globalAlpha = 0.6 * a;
            ctx.lineWidth = 3;
            ctx.shadowColor = this.targetRing.color;
            ctx.shadowBlur = 12;
            ctx.beginPath();
            ctx.arc(0, 0, ringRadius, 0, Math.PI * 2);
            ctx.stroke();
            ctx.shadowBlur = 0;
            ctx.restore();
        }
                // Weapon 7: draw a 350-unit radius ring around the player while selected
                if (this.currentIndex === 6 && typeof window !== 'undefined' && window.player) {
                        const px = window.player.x;
                        const py = window.player.y;
                        const sx = px - camera.x;
                        const sy = py - camera.y;
                        const ringRadius = 350;
                        const color = (this.current && this.current.color) ? this.current.color : '#ffffff';
                        ctx.save();
                        ctx.globalAlpha = 0.05;
                        ctx.strokeStyle = color;
                        ctx.lineWidth = 2.5;
                        ctx.beginPath();
                        ctx.arc(sx, sy, ringRadius, 0, Math.PI * 2);
                        ctx.stroke();
                        ctx.restore();
                }
        }

        // Two-pass draw to allow some bullets to render behind enemies
        drawLayer(ctx, camera, behind) {
                for (let i = 0; i < this.items.length; i++) {
                        const b = this.items[i];
                        const isBehind = !!(b.drawBehind || b.sortBehindThisFrame);
                        const shouldDraw = behind ? isBehind : !isBehind;
                        if (shouldDraw) b.draw(ctx, camera);
                }
                // Split impacts across layers: behind for flagged ones, front for the rest
                if (!behind) {
                        for (let i = 0; i < this.impacts.length; i++) {
                                const imp = this.impacts[i];
                                if (!imp || imp.drawBehind) continue;
                                imp.draw(ctx, camera);
                        }
                        if (this.targetRing) {
                                const baseRadius = 100;
                                const ringRadius = baseRadius * (this.targetRing.explosionRadiusMultiplier || 1.0);
                                const sx = this.targetRing.cx - camera.x;
                                const sy = this.targetRing.cy - camera.y;
                                ctx.save();
                                ctx.translate(sx, sy);
                                const a = (this.targetRing.alpha != null ? this.targetRing.alpha : 1);
                                try {
                                        const hex = this.targetRing.color;
                                        const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
                                        const r = m ? parseInt(m[1], 16) : 255;
                                        const g = m ? parseInt(m[2], 16) : 255;
                                        const b = m ? parseInt(m[3], 16) : 255;
                                        const glowR = ringRadius * 1.6;
                                        const grad = ctx.createRadialGradient(0, 0, ringRadius * 0.2, 0, 0, glowR);
                                        grad.addColorStop(0, 'rgba(' + r + ',' + g + ',' + b + ',' + (0.18 * a) + ')');
                                        grad.addColorStop(1, 'rgba(' + r + ',' + g + ',' + b + ',0)');
                                        ctx.fillStyle = grad;
                                        ctx.beginPath();
                                        ctx.arc(0, 0, glowR, 0, Math.PI * 2);
                                        ctx.fill();
                                } catch(e) {}
                                ctx.strokeStyle = this.targetRing.color;
                                ctx.globalAlpha = 0.6 * a;
                                ctx.lineWidth = 3;
                                ctx.shadowColor = this.targetRing.color;
                                ctx.shadowBlur = 12;
                                ctx.beginPath();
                                ctx.arc(0, 0, ringRadius, 0, Math.PI * 2);
                                ctx.stroke();
                                ctx.shadowBlur = 0;
                                ctx.restore();
                        }
                        
                        // Weapon 3: draw charge VFX if charging
                        if (this.charge3.active && this.charge3.vfx) {
                                // Update VFX position right before drawing to ensure smooth rotation tracking
                                if (window.player && window.state?.mouse) {
                                        const player = window.player;
                                        const mouse = window.state.mouse;
                                        const mouseWorldX = camera.x + mouse.x;
                                        const mouseWorldY = camera.y + mouse.y;
                                        const dx = mouseWorldX - player.x;
                                        const dy = mouseWorldY - player.y;
                                        const len = Math.hypot(dx, dy) || 1;
                                        const ux = dx / len;
                                        const uy = dy / len;
                                        const tipOffset = 50;
                                        const tipX = player.x + ux * tipOffset;
                                        const tipY = player.y + uy * tipOffset;
                                        this.charge3.vfx.updatePosition(tipX, tipY);
                                }
                                this.charge3.vfx.draw(ctx, camera);
                        }
                        
                        // Weapon 7: draw a 350-unit radius ring around the player while selected
                        if (this.currentIndex === 6 && typeof window !== 'undefined' && window.player) {
                                const px = window.player.x;
                                const py = window.player.y;
                                const sx = px - camera.x;
                                const sy = py - camera.y;
                                const ringRadius = 350;
                                const color = (this.current && this.current.color) ? this.current.color : '#ffffff';
                                ctx.save();
                                ctx.globalAlpha = this._weapon7HasActive ? 0.15 : 0.05;
                                ctx.strokeStyle = color;
                                ctx.lineWidth = 2.5;
                                ctx.beginPath();
                                ctx.arc(sx, sy, ringRadius, 0, Math.PI * 2);
                                ctx.stroke();
                                ctx.restore();
                        }

                        // Weapon 8 crosshair is now drawn in ClientRender.js after transforms
                } else {
                        // behind pass
                        // Default: no active target until computed
                        if (this.currentIndex === 6) this._weapon7HasActive = false;
                        for (let i = 0; i < this.impacts.length; i++) {
                                const imp = this.impacts[i];
                                if (imp && imp.drawBehind) imp.draw(ctx, camera);
                        }
                        // Weapon 7: draw highlight rings under enemies within 350 units (behind enemies)
                        if (this.currentIndex === 6 && typeof window !== 'undefined' && window.player) {
                                const px = window.player.x;
                                const py = window.player.y;
                                const radius = 350;
                                const myEvil = (typeof window !== 'undefined' && window.__killThemAllLocked === true);
                                
                                // Build list of valid targets (enemies + hostile NPCs + opposite-alignment players)
                                const targets = [];
                                
                                // Add enemies
                                if (window.enemies && typeof window.enemies.queryCircle === 'function') {
                                        const enemyList = window.enemies.queryCircle(px, py, radius) || [];
                                        for (let i = 0; i < enemyList.length; i++) {
                                                const e = enemyList[i];
                                                if (e && e.alive) targets.push(e);
                                        }
                                }
                                
                                // Add hostile NPCs (like Heretic Priest when hostile)
                                if (window.npcs && window.npcs.items) {
                                        for (let i = 0; i < window.npcs.items.length; i++) {
                                                const npc = window.npcs.items[i];
                                                if (!npc || !npc.alive) continue;
                                                if (npc.name === 'NPC_B' && npc.state === 'hostile') {
                                                        const dxn = npc.x - px;
                                                        const dyn = npc.y - py;
                                                        if (dxn * dxn + dyn * dyn <= radius * radius) {
                                                                targets.push(npc);
                                                        }
                                                }
                                        }
                                }
                                
                                // Add opposite-alignment players in PvP (multiplayer-only game)
                                if (window.networkManager?.otherPlayers) {
                                        for (const [otherId, otherData] of window.networkManager.otherPlayers) {
                                                if (!otherData || otherData.health <= 0) continue;
                                                const otherEvil = window.networkManager.remotePlayerEvilStates?.get(otherId) || false;
                                                if (myEvil !== otherEvil) {
                                                        const dx = otherData.x - px;
                                                        const dy = otherData.y - py;
                                                        if (dx * dx + dy * dy <= radius * radius) {
                                                                targets.push({ x: otherData.x, y: otherData.y, radius: otherData.radius || 26, alive: true, isPvpTarget: true, id: otherId });
                                                        }
                                                }
                                        }
                                }
                                
                                // Determine hovered target first (mouse-over wins)
                                let active = null;
                                try {
                                        const mwx = (window._mouseWorldX != null) ? window._mouseWorldX : (camera.x + (window.state?.mouse?.x || 0));
                                        const mwy = (window._mouseWorldY != null) ? window._mouseWorldY : (camera.y + (window.state?.mouse?.y || 0));
                                        let bestHoverD2 = Infinity;
                                        for (let i = 0; i < targets.length; i++) {
                                                const e = targets[i];
                                                if (!e || !e.alive) continue;
                                                const dxm = mwx - e.x;
                                                const dym = mwy - e.y;
                                                const rad = (e.radius || 24);
                                                const d2m = dxm * dxm + dym * dym;
                                                if (d2m <= rad * rad && d2m < bestHoverD2) { bestHoverD2 = d2m; active = e; }
                                        }
                                } catch(_) {}
                                // If none hovered, fallback to closest-to-player among those
                                if (!active) {
                                        let bestD2 = Infinity;
                                        for (let i = 0; i < targets.length; i++) {
                                                const e = targets[i];
                                                if (!e || !e.alive) continue;
                                                const dx = e.x - px;
                                                const dy = e.y - py;
                                                const d2 = dx * dx + dy * dy;
                                                if (d2 < bestD2) { bestD2 = d2; active = e; }
                                        }
                                }
                                // Publish active state for front-pass ring opacity
                                this._weapon7HasActive = !!active;
                                for (let i = 0; i < targets.length; i++) {
                                        const e = targets[i];
                                        if (!e || !e.alive) continue;
                                        const sx = e.x - camera.x;
                                        const sy = e.y - camera.y;
                                        const rr = (e.radius || 24) + 6;
                                        const isActive = (active && e.id === active.id);
                                        // Use green ring for PvP targets to distinguish from enemies
                                        const isPvp = !!e.isPvpTarget;
                                        ctx.save();
                                        ctx.globalAlpha = isActive ? 0.9 : 0.65;
                                        ctx.strokeStyle = isPvp ? (isActive ? '#00ff00' : '#88ff88') : (isActive ? '#ff3b3b' : '#ffd36b');
                                        ctx.lineWidth = isActive ? 4 : 3;
                                        ctx.beginPath();
                                        ctx.arc(sx, sy, rr, 0, Math.PI * 2);
                                        ctx.stroke();
                                        ctx.restore();
                                }
                        }
                }
        }
}

window.Weapons = Weapons;
window.ImpactVfx = ImpactVfx;
window.ExplosionVfx = ExplosionVfx;
// ConeVfx removed
window.SlashVfx = SlashVfx;
window.ChargeVfx = ChargeVfx;
window.Bullet = Bullet;

