class Player {
	// Easing function for elastic pop animation
	static easeOutElastic(t) {
		const c4 = (2 * Math.PI) / 3;
		return t === 0 ? 0 : t === 1 ? 1 : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
	}

	constructor(x = 0, y = 0) {
                if (typeof Player._nextId !== 'number') Player._nextId = 1;
                this.id = Player._nextId++;
                this.x = x;
                this.y = y;
                this.radius = 26;
                this.speed = 220;
                this.baseSpeed = this.speed;
                this.color = '#7ecbff';
                this.outline = '#000000';
                // Health
                this.healthMax = 100;
                this.health = this.healthMax;
                // Track base (unequipped) health for additive bonuses from inventory
                this.baseHealthMax = this.healthMax;
                // Stamina capacity baseline and current stamina
                this.baseStaminaMax = 100; // baseline (unequipped)
                this.staminaMax = this.baseStaminaMax; // effective max with pickups (capped additions)
                // Stamina: 0..staminaMax points (100 == 10s sprint capacity at baseline)
                this.stamina = this.staminaMax;
                this.staminaDrainPerSecond = 100 / 10; // 10 pts/s, drains fully in 10s at baseline
                this.staminaRechargePerSecond = 100 / 5; // 20 pts/s, recharges fully in 5s at baseline
                this.mustReleaseShift = false; // latch: require releasing Shift after depletion
                this.mustReleaseFire = false; // latch: require releasing fire after depletion (weapon 4)
        // Crit stats
        this.critChance = 0.05; // 5%
        this.critDamageMultiplier = 1.2; // +20% damage
        this.baseCritChance = this.critChance;
        this.baseCritDamageMultiplier = this.critDamageMultiplier;
                // Exhaustion: delay before stamina begins to recharge after hitting zero
                this.exhaustionCooldownSeconds = 4;
                this.exhaustionTimer = 0;
                // Simple inventory for carryable/equippable items
                this.inventory = [];
                // Track last eligible HP bonus sum for heal-on-equip calculation (suppressed drops excluded)
                this._lastEligibleHealthBonus = 0;
                // On-hit flash effect timers (seconds)
                this.hitFlash = 0;
                this.hitFlashMax = 0.12; // very quick fade
                this.hitFlashCooldown = 0; // cooldown timer before next flash can start
                this.hitFlashGap = 0.07; // minimum gap between flashes
                // Sprint trail state
                this._trailPoints = [];
                this._sprinting = false;
                this._instantSpeed = 0;
                this._prevX = x;
                this._prevY = y;
                this._trailFadeTimer = 0; // when Shift released, fade all existing trail opacity to 0 over duration
                this._trailFadeDuration = 0.5;
                this._prevWantsSprint = false;
                // Dash state
                this.dashCooldown = 0; // Cooldown timer (seconds)
                this.dashCooldownMax = 0.3; // Cooldown duration
                this.dashActive = false; // Is dash currently active?
                this.dashDuration = 0; // How long dash lasts (set by server)
                this.dashFeedbackText = ''; // Feedback text to show above player
                this.dashFeedbackTimer = 0; // Timer for feedback display
                // Dash smoothing (for client-side interpolation during server-controlled dash)
                this._dashSmoothVelX = 0;
                this._dashSmoothVelY = 0;
                // Slime drip VFX when slowed by boomer puddle
		this._slimeDrips = [];
		this._slimeSpawnTimer = 0;
		this._slimePulseT = 0;
		// Mud drip VFX when slowed by mud pools
		this._mudDrips = [];
		this._mudSpawnTimer = 0;
                // Ensnare state (applied by Licker tentacle)
                this._ensnaredTimer = 0;
                this._ensnarePulseT = 0;
                // Per-licker ensnare timers: Map<lickerId, timeLeft>
                this._ensnaredBy = new Map();
                // DOT stacks applied to player (e.g., hostile NPC cones)
                this._playerDotStacks = [];
                // DOT floating text aggregation
                this._playerDotAccum = 0;
                this._playerDotTextTimer = 0;
                // Local VFX clock for burn flame animation
                this._burnFxT = 0;
                
                // Breadcrumb trail system (synced from server in multiplayer)
                this.breadcrumbs = [];
                this.totalDistanceMoved = 0;
                this.lastBreadcrumbX = x;
                this.lastBreadcrumbY = y;
                
	// Currency (ducats, blood markers, and victory points)
	this.ducats = 0;
	this.bloodMarkers = 0;
	this.bloodMarkerCap = 20; // Default cap, varies by weapon
	this.victoryPoints = 0; // Session-persistent VP earned from mission accomplishments
	
	// Loot progression system
	this.lootLevel = 0; // 0-6 progression
	
	// Loot pickup notification (shown above player's head)
	this.lootNotificationText = ''; // Text to show (e.g., "Primary Lvl 2")
	this.lootNotificationTimer = 0; // Timer for notification display
	this.lootNotificationType = 'up'; // 'up' for pickup, 'down' for drop
	this.lootNotificationStartTime = 0; // For animation timing
	
	// Invisibility state (weapon 5 secondary ability)
	this.invisible = false;
	this.invisibilityTimer = 0;
	this._renderAlpha = 1.0; // Smooth fade alpha for invisibility transitions
	}

        /**
         * Returns the sum of equipped Armor bonuses as a raw percent value (e.g., 25 means 25%).
         */
        getTotalArmorPercent() {
                let total = 0;
                try {
                        if (Array.isArray(this.inventory)) {
                                for (let i = 0; i < this.inventory.length; i++) {
                                        const item = this.inventory[i];
                                        if (!item) continue;
                                        // Items are HexStat instances with statKey and bonusValue
                                        if (item.statKey === 'Armor') {
                                                const val = Number(item.bonusValue) || 0;
                                                total += val;
                                        }
                                }
                        }
                } catch(_) {}
                return total;
        }

        /**
         * Returns the effective armor reduction factor (0..0.75), where 0.25 means 25% damage reduction.
         */
        getArmorReductionFactor() {
                const totalPercent = Math.max(0, Math.min(150, this.getTotalArmorPercent()));
                const frac = totalPercent / 100;
                // Cap at 75%
                return Math.min(0.75, frac);
        }

        /**
         * Returns the sum of equipped AtkSpd bonuses as a raw percent value (e.g., 25 means +25%).
         */
        getTotalAttackSpeedPercent() {
                let total = 0;
                try {
                        if (Array.isArray(this.inventory)) {
                                for (let i = 0; i < this.inventory.length; i++) {
                                        const item = this.inventory[i];
                                        if (!item) continue;
                                        if (item.statKey === 'AtkSpd') {
                                                const val = Number(item.bonusValue) || 0;
                                                total += val;
                                        }
                                }
                        }
                } catch(_) {}
                return Math.max(0, total);
        }

        /**
         * Returns the sum of equipped AtkPwr bonuses as a flat value (e.g., 2, 5, 10, 20, 30 per rarity).
         */
        getTotalAttackPowerFlat() {
                let total = 0;
                try {
                        if (Array.isArray(this.inventory)) {
                                for (let i = 0; i < this.inventory.length; i++) {
                                        const item = this.inventory[i];
                                        if (!item) continue;
                                        if (item.statKey === 'AtkPwr') {
                                                const val = Number(item.bonusValue) || 0;
                                                total += val;
                                        }
                                }
                        }
                } catch(_) {}
                return Math.max(0, total);
        }

        /**
         * Returns the DOT DPS bonus derived from Attack Power. Rule: DOT bonus = AtkPwr × 0.1
         */
        getDotAttackPowerBonus() {
                const flat = this.getTotalAttackPowerFlat?.() || 0;
                return Math.max(0, flat * 0.1);
        }

        /**
         * Returns the effective loot level (clamped 0-6)
         */
        getEffectiveLootLevel() {
                return Math.max(0, Math.min(6, this.lootLevel || 0));
        }

        /**
         * Returns the blood marker cap for the current weapon
         * @param {number} weaponIndex - Current weapon index (0-6)
         */
        getBloodMarkerCap(weaponIndex) {
                // All weapons have a cap of 20 blood markers
                return 20;
        }

        /**
         * Determine what type of upgrade this loot level represents
         * @param {number} lootLevel - The loot level (0-6)
         * @returns {object} Object with { type: 'Primary'|'Ability', level: 1-3 } or null
         */
        getLootUpgradeInfo(lootLevel) {
                // Primary upgrades at loot 0, 2, 4
                if (lootLevel === 0 || lootLevel === 2 || lootLevel === 4) {
                        const primaryLevel = (lootLevel / 2) + 1; // 0->1, 2->2, 4->3
                        return { type: 'Primary', level: primaryLevel };
                }
                
                // Ability upgrades at loot 1, 3, 5
                if (lootLevel === 1 || lootLevel === 3 || lootLevel === 5) {
                        const abilityLevel = Math.floor(lootLevel / 2) + 1; // 1->1, 3->2, 5->3
                        return { type: 'Ability', level: abilityLevel };
                }
                
                // Loot level 6 (ultimate) - not implemented yet, no notification
                return null;
        }

        /**
         * Recompute derived stats (e.g., max health) from equipped inventory items.
         * Applies flat and percent bonuses where applicable and adjusts current HP when max increases.
         */
        recalculateStatsFromInventory() {
                const prevMax = this.healthMax;
                const prevStaminaMax = this.staminaMax || this.baseStaminaMax || 100;
                let healthFlatBonus = 0;
                let eligibleHealthFlatBonus = 0;
                let staminaFlatBonus = 0;
                let movSpdPercent = 0;
                let critChancePercent = 0;
                let critDmgPercent = 0;
                try {
                        if (Array.isArray(this.inventory)) {
                                for (let i = 0; i < this.inventory.length; i++) {
                                        const item = this.inventory[i];
                                        if (!item) continue;
                                        if (item.statKey === 'Health') {
                                                let add = Number(item.bonusValue) || 0;
                                                if (item.isPercent) {
                                                        add = Math.round((this.baseHealthMax || 1) * (add / 100));
                                                }
                                                healthFlatBonus += add;
                                                if (!item.suppressHealForPlayerId || item.suppressHealForPlayerId !== this.id) {
                                                        eligibleHealthFlatBonus += add;
                                                }
                                        }
                                        if (item.statKey === 'Stamina') {
                                                let addS = Number(item.bonusValue) || 0;
                                                if (item.isPercent) {
                                                        addS = Math.round((this.baseStaminaMax || 1) * (addS / 100));
                                                }
                                                staminaFlatBonus += addS;
                                        }
                                        if (item.statKey === 'MovSpd') {
                                                let addMS = Number(item.bonusValue) || 0;
                                                if (item.isPercent) {
                                                        movSpdPercent += addMS;
                                                } else {
                                                        const base = this.baseSpeed || 220;
                                                        if (base > 0) movSpdPercent += (addMS / base) * 100;
                                                }
                                        }
                                        if (item.statKey === 'CritChance') {
                                                const addCC = Number(item.bonusValue) || 0; // percentage points
                                                critChancePercent += addCC;
                                        }
                                        if (item.statKey === 'CritDmg') {
                                                const addCM = Number(item.bonusValue) || 0; // percent
                                                critDmgPercent += addCM;
                                        }
                                }
                        }
                } catch (_) {}
                this.healthMax = Math.max(1, (this.baseHealthMax || 100) + healthFlatBonus);
                // Grant immediate HP only for eligible increases (not from suppressed-by-owner re-equips)
                const eligibleDelta = Math.max(0, (eligibleHealthFlatBonus - (this._lastEligibleHealthBonus || 0)));
                if (eligibleDelta > 0) this.health += eligibleDelta;
                this._lastEligibleHealthBonus = eligibleHealthFlatBonus;
                if (this.health > this.healthMax) this.health = this.healthMax;
                // Stamina max: cap total capacity to 300 (including baseline and pickups)
                const rawStaminaMax = Math.max(1, (this.baseStaminaMax || 100) + staminaFlatBonus);
                this.staminaMax = Math.min(300, rawStaminaMax);
                if (this.staminaMax > prevStaminaMax) {
                        // Grant the additional capacity as immediate stamina so pickups feel impactful
                        this.stamina += (this.staminaMax - prevStaminaMax);
                }
                if (this.stamina > this.staminaMax) this.stamina = this.staminaMax;
                // Apply movement speed bonuses multiplicatively based on base speed
                const baseSpd = this.baseSpeed || this.speed || 220;
                const totalMovPct = Math.max(0, movSpdPercent);
                this.speed = Math.min(375, baseSpd * (1 + totalMovPct / 100));
                // Apply critical bonuses from inventory
                const baseCc = (this.baseCritChance != null) ? this.baseCritChance : 0;
                const baseCm = (this.baseCritDamageMultiplier != null) ? this.baseCritDamageMultiplier : 1.2;
                const ccAdd = Math.max(0, critChancePercent) / 100;
                this.critChance = Math.max(0, Math.min(1, baseCc + ccAdd));
                const cmMul = 1 + Math.max(0, critDmgPercent) / 100;
                this.critDamageMultiplier = Math.max(1, baseCm * cmMul);
                // Tick DOT stacks applied to player (weapon 4-like burns) with invincibility protection and floating text
                try {
                        if (Array.isArray(this._playerDotStacks) && this._playerDotStacks.length > 0 && this.health > 0) {
                                const hadDotStacks = this._playerDotStacks.length > 0;
                                let total = 0;
                                for (let i = this._playerDotStacks.length - 1; i >= 0; i--) {
                                        const s = this._playerDotStacks[i];
                                        if (!s) { this._playerDotStacks.splice(i, 1); continue; }
                                        const dt = (typeof window !== 'undefined' && window.state && Number.isFinite(window.state._lastDt)) ? window.state._lastDt : 0.016;
                                        s.timeLeft -= dt;
                                        if (s.timeLeft <= 0) { this._playerDotStacks.splice(i, 1); continue; }
                                        total += Math.max(0, s.dps || 0);
                                }
                                // Send burning state changes for DOT transitions if this is the local player
                                const hasDotStacks = this._playerDotStacks.length > 0;
                                if (window.networkManager && this === window.player) {
                                        // Send "start burning" if player just started burning
                                        if (!hadDotStacks && hasDotStacks) {
                                                window.networkManager.sendVfxCreated('burnStateChanged', this.x, this.y, {
                                                        burning: true,
                                                        playerId: window.networkManager.playerId
                                                });
                                        }
                                        // Send "stop burning" if player stopped burning
                                        else if (hadDotStacks && !hasDotStacks) {
                                                window.networkManager.sendVfxCreated('burnStateChanged', this.x, this.y, {
                                                        burning: false,
                                                        playerId: window.networkManager.playerId
                                                });
                                        }
                                }
                                if (total > 0) {
                                        const dt = (typeof window !== 'undefined' && window.state && Number.isFinite(window.state._lastDt)) ? window.state._lastDt : 0.016;
                                        
                                        // DOT damage is server-authoritative (multiplayer-only game)
                                        // Client only shows VFX
                                        
                                        if (false) {
                                                // Disabled: server handles all DOT damage
                                                const isInvincible = (typeof window !== 'undefined' && window.state && window.state.invincible);
                                                if (!isInvincible) {
                                                        const dmg = total * dt;
                                                        this.health -= dmg;
                                                        this._playerDotAccum += dmg;
                                                        if (this.health < 0) this.health = 0;
                                                }
                                                
                                                // Show floating damage text (single-player only - multiplayer gets from server)
                                                this._playerDotTextTimer -= dt;
                                                if (this._playerDotTextTimer <= 0 && this._playerDotAccum > 0.5) {
                                                try {
                                                        if (typeof window.enqueueDamageText === 'function') {
                                                                window.enqueueDamageText({
                                                                        x: this.x,
                                                                        y: this.y - (this.radius || 26) - 6,
                                                                        text: String(Math.round(this._playerDotAccum)),
                                                                        crit: false,
                                                                        color: isInvincible ? '#88ff88' : '#ff4d4d', // Green text when invincible
                                                                        vy: -80,
                                                                        life: 0.8
                                                                });
                                                        }
                                                        // Send DOT damage text to other players for synchronization
                                                        if (window.networkManager && this === window.player) {
                                                                window.networkManager.sendVfxCreated('damageText', this.x, this.y - (this.radius || 26) - 6, {
                                                                        text: String(Math.round(this._playerDotAccum)),
                                                                        crit: false,
                                                                        color: isInvincible ? '#88ff88' : '#ff4d4d',
                                                                        vy: -80,
                                                                        life: 0.8
                                                                });
                                                        }
                                                } catch(_) {}
                                                this._playerDotAccum = 0;
                                                this._playerDotTextTimer = 0.15;
                                                }
                                        }
                                }
                        }
                } catch(_) {}
        }

        update(dt, input, environment) {
                // Keep derived stats in sync with equipment
                this.recalculateStatsFromInventory();
                // Advance burn VFX timer
                this._burnFxT = (this._burnFxT || 0) + dt;
                // Update ensnare timers (per-licker) and compute aggregate
                {
                        let any = false;
                        let maxT = 0;
                        try {
                                if (this._ensnaredBy && typeof this._ensnaredBy.forEach === 'function') {
                                        const removals = [];
                                        this._ensnaredBy.forEach((t, id) => {
                                                let nt = (t || 0) - dt;
                                                if (nt <= 0) {
                                                        removals.push(id);
                                                } else {
                                                        this._ensnaredBy.set(id, nt);
                                                        any = true;
                                                        if (nt > maxT) maxT = nt;
                                                }
                                        });
                                        for (let i = 0; i < removals.length; i++) this._ensnaredBy.delete(removals[i]);
                                }
                        } catch(_) {}
                        this._ensnaredTimer = maxT;
                        if (any) {
                                this._ensnarePulseT = (this._ensnarePulseT || 0) + dt;
                                // Track a primary ensnarer id for legacy consumers (pick the one with max time)
                                try {
                                        let bestId = null, bestT = -1;
                                        if (this._ensnaredBy && typeof this._ensnaredBy.forEach === 'function') {
                                                this._ensnaredBy.forEach((t, id) => { if (t > bestT) { bestT = t; bestId = id; } });
                                        }
                                        this._ensnaredById = bestId;
                                } catch(_) {}
                        } else {
                                this._ensnarePulseT = 0;
                                this._ensnaredById = null;
                        }
                }
                let moveX = 0;
                let moveY = 0;
                if (input.KeyW) moveY -= 1;
                if (input.KeyS) moveY += 1;
                if (input.KeyA) moveX -= 1;
                if (input.KeyD) moveX += 1;

                const isMoving = (moveX !== 0 || moveY !== 0);
                const wantsSprint = !!(input.ShiftLeft || input.ShiftRight);
                const isInvincible = !!(typeof window !== 'undefined' && window.state && window.state.invincible);
                const staminaDrainThisFrame = this.staminaDrainPerSecond * dt;
                const tryingToSprint = wantsSprint && isMoving && !this.mustReleaseShift && !this._weapon8ADS; // Disable sprint while ADS
                // Use server-authoritative sprint state when available, fallback to client calculation
                const sprintActive = (this._serverSprintActive !== undefined) ? this._serverSprintActive : 
                    (tryingToSprint && (isInvincible || ((this.stamina > staminaDrainThisFrame) && (this.exhaustionTimer === 0))));

                // On Shift release, start a global trail opacity fade-out over duration
                if (this._prevWantsSprint && !wantsSprint) {
                        this._trailFadeTimer = this._trailFadeDuration || 0.5;
                }
                // While holding Shift again, cancel any fade and restore full opacity
                if (wantsSprint) this._trailFadeTimer = 0;
                this._prevWantsSprint = !!wantsSprint;

                if (isMoving) {
                        // Debug: Track input for movement debugging
                        if (window.gameDebugger) {
                            window.gameDebugger.movementInput(this.id, input, Date.now(), { x: this.x, y: this.y });
                        }
                        
                        // Store position before movement for debugging
                        const beforePos = { x: this.x, y: this.y };
                        
                        const length = Math.hypot(moveX, moveY) || 1;
                        moveX /= length;
                        moveY /= length;
                        const speedMultiplier = sprintActive ? 2 : 1;
                        let slowMul = 1;
                        try { if (this._slowState && this._slowState.active) slowMul = 0.5; } catch(_) {}
                        // Ensnare slows movement by 40%
                        const ensnareMul = (this._ensnaredTimer > 0) ? 0.6 : 1;
                        // Weapon 8 ADS slows movement to 40%
                        const adsMul = (this._weapon8ADS === true) ? 0.4 : 1;
                        // Basic zombie melee slow (15% per zombie, stacks up to 5 for 75% max slow, synced from server with 0.5s linger)
                        let zombieSlowMul = 1;
                        if (this._basicZombieSlowCount && this._basicZombieSlowCount > 0) {
                            const slowPerZombie = 0.15;
                            const maxZombies = 5;
                            const zombieCount = Math.min(this._basicZombieSlowCount, maxZombies);
                            zombieSlowMul = 1 - (slowPerZombie * zombieCount); // 0.85 for 1, 0.25 for 5
                        }
                        
                        const dx = moveX * this.speed * slowMul * dt * speedMultiplier * ensnareMul * adsMul * zombieSlowMul;
                        const dy = moveY * this.speed * slowMul * dt * speedMultiplier * ensnareMul * adsMul * zombieSlowMul;
                        const velocity = { x: dx / dt, y: dy / dt };
                        const intendedPos = { x: this.x + dx, y: this.y + dy };
                        
                        if (environment && environment.resolveCircleMove) {
                                const res = environment.resolveCircleMove(this.x, this.y, this.radius, dx, dy);
                                
                                // Store last collision info for debug overlay (only when collisions occurred)
                                try {
                                    if (res && res.hits && res.hits.length) {
                                        window._lastPlayerCollision = {
                                            t: Date.now(),
                                            before: beforePos,
                                            intended: intendedPos,
                                            resolved: { x: res.x, y: res.y },
                                            hits: res.hits
                                        };
                                    }
                                } catch(_) {}
                                
                                // Debug: Track collision detection
                                if (window.gameDebugger) {
                                    window.gameDebugger.collisionDetection(this.id, beforePos, intendedPos, res, environment.obstacles?.length || 0);
                                }
                                
                                this.x = res.x;
                                this.y = res.y;
                        } else {
                                this.x += dx;
                                this.y += dy;
                        }
                        
                        // Debug: Track movement calculation
                        if (window.gameDebugger) {
                            const afterPos = { x: this.x, y: this.y };
                            window.gameDebugger.movementCalculation(this.id, beforePos, afterPos, dt, velocity, sprintActive);
                        }
                }

                // Compute instantaneous speed from position delta (after movement)
                {
                        const vx = (this.x - this._prevX) / Math.max(1e-6, dt);
                        const vy = (this.y - this._prevY) / Math.max(1e-6, dt);
                        this._instantSpeed = Math.hypot(vx, vy);
                        this._prevX = this.x;
                        this._prevY = this.y;
                }

                // Determine sprinting state strictly by Shift usage and stamina drain logic
                this._sprinting = !!sprintActive;
                // Append trail points while sprinting OR dashing
                const isTrailing = this._sprinting || (this.dashActive && this.dashDuration > 0);
                if (isTrailing) {
                        // Trail config
                        const maxPoints = 26; // lightweight
                        const baseSpacing = 12; // pixels between samples at baseline
                        if (!this._trailAcc) this._trailAcc = 0;
                        // Accumulate distance moved since last sample
                        this._trailAcc += this._instantSpeed * dt;
                        const speedFactor = Math.max(0.5, Math.min(2.5, this._instantSpeed / (this.baseSpeed || 220))); // considers loot speed and sprint
                        const spacing = baseSpacing * (1 / speedFactor);
                        while (this._trailAcc >= spacing) {
                                this._trailAcc -= spacing;
                                this._trailPoints.push({ x: this.x, y: this.y, life: 1.2, max: 1.2 });
                                if (this._trailPoints.length > maxPoints) this._trailPoints.shift();
                        }
                } else {
                        // Decay accumulator when not sprinting
                        if (this._trailAcc) this._trailAcc = Math.max(0, this._trailAcc - this._instantSpeed * dt);
                }
                // Fade existing trail points regardless
                for (let i = this._trailPoints.length - 1; i >= 0; i--) {
                        const p = this._trailPoints[i];
                        p.life -= dt;
                        if (p.life <= 0) this._trailPoints.splice(i, 1);
                }
                // Advance trail fade timer (controls global opacity after Shift release)
                if (this._trailFadeTimer > 0) {
                        this._trailFadeTimer -= dt;
                        if (this._trailFadeTimer < 0) this._trailFadeTimer = 0;
                }

                // Countdown exhaustion timer regardless of input
                if (this.exhaustionTimer > 0) {
                        this.exhaustionTimer -= dt;
                        if (this.exhaustionTimer < 0) this.exhaustionTimer = 0;
                }
                
                // Update dash timers
                if (this.dashCooldown > 0) {
                        this.dashCooldown -= dt;
                        if (this.dashCooldown < 0) this.dashCooldown = 0;
                }
                if (this.dashDuration > 0) {
                        this.dashDuration -= dt;
                        if (this.dashDuration < 0) {
                                this.dashDuration = 0;
                                this.dashActive = false;
                        }
                }
                if (this.dashFeedbackTimer > 0) {
                        this.dashFeedbackTimer -= dt;
                        if (this.dashFeedbackTimer < 0) this.dashFeedbackTimer = 0;
                }
                // Update loot notification timer
                if (this.lootNotificationTimer > 0) {
                        this.lootNotificationTimer -= dt;
                        if (this.lootNotificationTimer < 0) this.lootNotificationTimer = 0;
                }

                // Only update stamina client-side when server is not providing authoritative state
                if (this._serverSprintActive === undefined) {
                        // Stamina update (client-side calculation)
                        if (sprintActive && !isInvincible) {
                                this.stamina -= staminaDrainThisFrame;
                                if (this.stamina <= 0) {
                                        this.stamina = 0;
                                        this.mustReleaseShift = true; // lock sprint until Shift is released
                                        this.exhaustionTimer = this.exhaustionCooldownSeconds; // start exhaustion delay
                                }
                        }
                        // Additional drain when firing weapon 4: stacks with sprint (multiplier based on loot level)
                        if (this.isFiringWeapon4 && !this.mustReleaseFire && !isInvincible) {
                                // Get loot-based stamina drain multiplier for weapon 4
                                const lootLevel = this.getEffectiveLootLevel?.() || 0;
                                const progression = (typeof window !== 'undefined' && window.getWeaponProgression) 
                                        ? window.getWeaponProgression(3, lootLevel) 
                                        : {};
                                const staminaDrainMultiplier = progression.primary?.staminaDrainMultiplier || 1.0;
                                
                                // Track firing start time
                                if (!this._weapon4FiringStartTime) {
                                        this._weapon4FiringStartTime = Date.now();
                                        this._weapon4InitialStamina = this.stamina;
                                        console.log('[Weapon4] 🔥 FIRING STARTED - Time:', new Date().toLocaleTimeString(), 'Stamina:', this.stamina.toFixed(1), 'Loot:', lootLevel, 'Multiplier:', staminaDrainMultiplier);
                                }
                                
                                // Debug logging every 200ms
                                const now = Date.now();
                                if (!this._lastStaminaDrainLog || now - this._lastStaminaDrainLog > 200) {
                                        this._lastStaminaDrainLog = now;
                                        const elapsed = ((now - this._weapon4FiringStartTime) / 1000).toFixed(2);
                                        const drained = (this._weapon4InitialStamina - this.stamina).toFixed(1);
                                        const drainPerSec = elapsed > 0 ? (drained / parseFloat(elapsed)).toFixed(2) : '0.00';
                                        console.log('[Weapon4] ⏱️  Elapsed:', elapsed + 's', '| Stamina:', this.stamina.toFixed(1), '| Drained:', drained, '| Rate:', drainPerSec + '/s', '| Expected:', (this.staminaDrainPerSecond * 0.5 * staminaDrainMultiplier).toFixed(2) + '/s');
                                }
                                
                                // Base drain is 0.5x sprint rate, then multiplied by loot progression
                                this.stamina -= staminaDrainThisFrame * 0.5 * staminaDrainMultiplier;
                                if (this.stamina <= 0) {
                                        this.stamina = 0;
                                        this.mustReleaseFire = true; // lock firing until mouse released and some recharge
                                        this.exhaustionTimer = this.exhaustionCooldownSeconds; // start exhaustion delay
                                        const totalTime = ((Date.now() - this._weapon4FiringStartTime) / 1000).toFixed(2);
                                        console.log('[Weapon4] 💥 STAMINA DEPLETED - Total time:', totalTime + 's');
                                        this._weapon4FiringStartTime = null;
                                }
                        } else if (this._weapon4FiringStartTime) {
                                // Firing stopped
                                const totalTime = ((Date.now() - this._weapon4FiringStartTime) / 1000).toFixed(2);
                                const drained = (this._weapon4InitialStamina - this.stamina).toFixed(1);
                                console.log('[Weapon4] 🛑 FIRING STOPPED - Total time:', totalTime + 's', 'Stamina remaining:', this.stamina.toFixed(1), 'Total drained:', drained);
                                this._weapon4FiringStartTime = null;
                        }
                        else if (!isInvincible && tryingToSprint && this.stamina > 0 && this.stamina <= staminaDrainThisFrame) {
                                // Attempting to sprint with too little stamina: trigger exhaustion
                                this.stamina = 0;
                                this.mustReleaseShift = true;
                                this.exhaustionTimer = this.exhaustionCooldownSeconds;
                        } else {
                                if (isInvincible) {
                                        // Invincibility: stamina can only go up
                                        this.exhaustionTimer = 0;
                                        this.mustReleaseShift = false;
                                        this.mustReleaseFire = false;
                                        const maxStm = this.staminaMax || this.baseStaminaMax || 100;
                                        this.stamina += this.staminaRechargePerSecond * dt;
                                        if (this.stamina > maxStm) this.stamina = maxStm;
                                } else {
                                        // Only recharge when Shift is NOT held
                                        if (!wantsSprint && !this.isFiringWeapon4) {
                                                // Wait for exhaustion to end before recharging
                                                if (this.exhaustionTimer === 0) {
                                                        this.stamina += this.staminaRechargePerSecond * dt;
                                                        const maxStm = this.staminaMax || this.baseStaminaMax || 100;
                                                        if (this.stamina > maxStm) this.stamina = maxStm;
                                                        // Clear latch once Shift is released and stamina is > 0
                                                        if (this.mustReleaseShift && this.stamina > 0) this.mustReleaseShift = false;
                                                        if (this.mustReleaseFire && this.stamina > 0) this.mustReleaseFire = false;
                                                }
                                        }
                                }
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
		// Advance slow pulse timer
		this._slimePulseT = (this._slimePulseT || 0) + dt;
		// Update slime drip VFX when slowed by puke puddle
		try {
			const slowed = !!(this._slowState && this._slowState.active);
			if (slowed) {
				this._slimeSpawnTimer -= dt;
				const spawnEvery = 0.08; // spawn rate
				while (this._slimeSpawnTimer <= 0) {
					this._slimeSpawnTimer += spawnEvery;
					// Spawn 1-2 small drips near the bottom of the player
					const count = 1 + Math.floor(Math.random() * 2);
					for (let i = 0; i < count; i++) {
						const ang = (Math.random() * Math.PI) + Math.PI * 0.5; // downward-ish hemisphere
						const offR = (this.radius || 26) * (0.2 + Math.random() * 0.6);
						const spawnX = this.x + Math.cos(ang) * offR * 0.4;
						const spawnY = this.y + (this.radius || 26) * 0.6 + Math.sin(ang) * 2;
						const vy = 60 + Math.random() * 80;
						const vx = (Math.random() * 2 - 1) * 25;
						const life = 0.5 + Math.random() * 0.6;
						const rad = 1.5 + Math.random() * 2.5;
						this._slimeDrips.push({ x: spawnX, y: spawnY, vx, vy, life, total: life, r: rad });
					}
				}
			} else {
				// keep small positive to avoid long while loops on re-enter
				this._slimeSpawnTimer = Math.min(this._slimeSpawnTimer, 0.08);
			}
			// Integrate and cull drips
			for (let i = this._slimeDrips.length - 1; i >= 0; i--) {
				const d = this._slimeDrips[i];
				d.vy += 220 * dt; // gravity
				d.x += d.vx * dt;
				d.y += d.vy * dt;
				d.life -= dt;
				if (d.life <= 0) this._slimeDrips.splice(i, 1);
			}
			// Cap drip count
			if (this._slimeDrips.length > 120) this._slimeDrips.splice(0, this._slimeDrips.length - 120);
		} catch(_) {}
		
		// Update mud drip VFX when slowed by mud pools
		try {
			const mudSlowed = !!(this._mudSlowState && this._mudSlowState.active);
			if (mudSlowed) {
				this._mudSpawnTimer -= dt;
				const spawnEvery = 0.09; // slightly slower spawn rate than slime
				while (this._mudSpawnTimer <= 0) {
					this._mudSpawnTimer += spawnEvery;
					// Spawn 1-2 small mud drips near the bottom of the player
					const count = 1 + Math.floor(Math.random() * 2);
					for (let i = 0; i < count; i++) {
						const ang = (Math.random() * Math.PI) + Math.PI * 0.5; // downward-ish hemisphere
						const offR = (this.radius || 26) * (0.2 + Math.random() * 0.6);
						const spawnX = this.x + Math.cos(ang) * offR * 0.4;
						const spawnY = this.y + (this.radius || 26) * 0.6 + Math.sin(ang) * 2;
						const vy = 70 + Math.random() * 70; // heavier drips fall a bit faster
						const vx = (Math.random() * 2 - 1) * 20;
						const life = 0.6 + Math.random() * 0.5;
						const rad = 1.8 + Math.random() * 2.8; // slightly larger than slime
						this._mudDrips.push({ x: spawnX, y: spawnY, vx, vy, life, total: life, r: rad });
					}
				}
			} else {
				// keep small positive to avoid long while loops on re-enter
				this._mudSpawnTimer = Math.min(this._mudSpawnTimer, 0.09);
			}
			// Integrate and cull drips
			for (let i = this._mudDrips.length - 1; i >= 0; i--) {
				const d = this._mudDrips[i];
				d.vy += 240 * dt; // gravity (slightly heavier)
				d.x += d.vx * dt;
				d.y += d.vy * dt;
				d.life -= dt;
				if (d.life <= 0) this._mudDrips.splice(i, 1);
			}
			// Cap drip count
			if (this._mudDrips.length > 120) this._mudDrips.splice(0, this._mudDrips.length - 120);
		} catch(_) {}
        }

        draw(ctx, camera, mouseScreen) {
                const screenX = this.x - camera.x;
                const screenY = this.y - camera.y;


                // Sprint/Dash trail (draw behind player body)
                if (this._trailPoints && this._trailPoints.length > 0) {
                        // Compute global alpha multiplier: 1 while sprinting/dashing, fades to 0 over duration after release
                        let globalTrailAlpha = 1;
                        if ((this._trailFadeTimer || 0) > 0) {
                                const d = Math.max(0.0001, this._trailFadeDuration || 0.5);
                                globalTrailAlpha = Math.max(0, Math.min(1, (this._trailFadeTimer) / d));
                        }
                        // Check if currently dashing for enhanced trail
                        const isDashing = !!(this.dashActive && this.dashDuration > 0);
                        
                        for (let i = this._trailPoints.length - 1; i >= 0; i--) {
                                const p = this._trailPoints[i];
                                const k = Math.max(0, Math.min(1, p.life / (p.max || 0.001)));
                                // Direction from player to this trail point (behind direction)
                                const bx = p.x - this.x;
                                const by = p.y - this.y;
                                const bdist = Math.hypot(bx, by) || 0.0001;
                                const bux = bx / bdist;
                                const buy = by / bdist;
                                // Length scales with current speed, but do not exceed distance to this point
                                const speedFactor = Math.max(0.75, Math.min(3, this._instantSpeed / (this.baseSpeed || 220)));
                                const maxLen = Math.min(70, 26 * speedFactor);
                                const len = Math.min(maxLen, bdist) * k;
                                // Start slightly behind the player's center so it never pokes out in front
                                const inset = Math.max(0, (this.radius || 26) * 0.55);
                                const sx = (this.x + bux * inset) - camera.x;
                                const sy = (this.y + buy * inset) - camera.y;
                                const ex = sx + bux * len;
                                const ey = sy + buy * len;
                                ctx.save();
                                // Enhanced opacity and color for dash
                                const baseOpacity = isDashing ? 0.35 : 0.2; // Brighter trail during dash
                                const nearA = baseOpacity * k * globalTrailAlpha;
                                const farA = 0.0;
                                const grad = ctx.createLinearGradient(sx, sy, ex, ey);
                                // Brighter cyan-white during dash, normal blue-cyan during sprint
                                const trailColor = isDashing ? '200, 240, 255' : '126, 203, 255';
                                grad.addColorStop(0, `rgba(${trailColor}, ${nearA})`);
                                grad.addColorStop(1, `rgba(${trailColor}, ${farA})`);
                                ctx.fillStyle = grad;
                                // Build a tapered quad: wide at the near end, narrow at the far end
                                const widthMultiplier = isDashing ? 1.5 : 1.2; // Wider trail during dash
                                const baseWidth = Math.max(2, (this.radius || 26) * widthMultiplier);
                                const widthNear = baseWidth * k;
                                const widthFar = baseWidth * k * 0.08; // very thin tail to avoid aliasing
                                const px = -buy; // perpendicular
                                const py = bux;
                                const nxLx = sx + px * (widthNear * 0.5);
                                const nxLy = sy + py * (widthNear * 0.5);
                                const nxRx = sx - px * (widthNear * 0.5);
                                const nxRy = sy - py * (widthNear * 0.5);
                                const fxLx = ex + px * (widthFar * 0.5);
                                const fxLy = ey + py * (widthFar * 0.5);
                                const fxRx = ex - px * (widthFar * 0.5);
                                const fxRy = ey - py * (widthFar * 0.5);
                                ctx.beginPath();
                                ctx.moveTo(nxLx, nxLy);
                                ctx.lineTo(fxLx, fxLy);
                                ctx.lineTo(fxRx, fxRy);
                                ctx.lineTo(nxRx, nxRy);
                                ctx.closePath();
                                ctx.fill();
                                ctx.restore();
                        }
                }

	// Aim indicator (hidden when dead/ghost, always visible when alive)
		// Calculate angle in WORLD space (zoom-aware)
		// Account for zoom when calculating world mouse position
		const _aimCx = (window.state?.viewportWidth || 1920) / 2;
		const _aimCy = (window.state?.viewportHeight || 1080) / 2;
		const _aimZoom = (window.clientRender?.zoomLevel) || 1.0;
		const worldMouseX = camera.x + _aimCx + (mouseScreen.x - _aimCx) / _aimZoom;
		const worldMouseY = camera.y + _aimCy + (mouseScreen.y - _aimCy) / _aimZoom;
		const dx = worldMouseX - this.x;
		const dy = worldMouseY - this.y;
		const angle = Math.atan2(dy, dx);
		const indicatorLength = (this.radius + 14) * 1.5;
		const ix = screenX + Math.cos(angle) * indicatorLength;
		const iy = screenY + Math.sin(angle) * indicatorLength;

	// Check if player is evil (converted PvP)
	const isEvil = (typeof window !== 'undefined' && window.__killThemAllLocked === true);

	if (this.health > 0) {
		ctx.save();
		ctx.globalAlpha = this._renderAlpha; // Fade with body alpha
		ctx.beginPath();
		ctx.moveTo(screenX, screenY);
		ctx.lineTo(ix, iy);
		ctx.strokeStyle = '#ffffff';
		ctx.lineWidth = 3;
		ctx.stroke();
		ctx.restore();
	}

	// Body (ghosted when dead, invisible alpha for invisibility) - preserve existing color
	ctx.save();
	
	// Determine target alpha
	let targetAlpha = 1.0;
	if (this.health <= 0) {
		targetAlpha = 0.5;
	} else if (this.invisible) {
		// Local player always sees themselves at 50% when invisible
		targetAlpha = 0.5;
	}
	
	// Smooth fade transition (0.5 second transition)
	const fadeSpeed = 2.0; // Full fade in 0.5 seconds
	const deltaTime = 1/60; // Approximate frame time
	this._renderAlpha += (targetAlpha - this._renderAlpha) * fadeSpeed * deltaTime;
	
	ctx.globalAlpha = this._renderAlpha;
	ctx.beginPath();
	ctx.arc(screenX, screenY, this.radius, 0, Math.PI * 2);
	ctx.fillStyle = this.color;
	ctx.fill();
	ctx.restore();

	// White dash glow effect (subtle fade-in during dash)
	try {
		const isDashing = this.dashActive && this.dashDuration > 0;
		if (isDashing) {
			const dashMaxDuration = 0.2; // Match server dashMaxDuration
			const dashProgress = Math.min(1, (dashMaxDuration - this.dashDuration) / (dashMaxDuration * 0.3)); // Fade in over first 30% of dash
			const glowIntensity = Math.pow(dashProgress, 0.5); // Ease in
			
			ctx.save();
			ctx.globalCompositeOperation = 'lighter';
			
			// Outer soft white glow
			ctx.globalAlpha = 0.075 * glowIntensity * this._renderAlpha;
			ctx.fillStyle = '#ffffff';
			ctx.beginPath();
			ctx.arc(screenX, screenY, this.radius + 8, 0, Math.PI * 2);
			ctx.fill();
			
			// Mid glow
			ctx.globalAlpha = 0.125 * glowIntensity * this._renderAlpha;
			ctx.beginPath();
			ctx.arc(screenX, screenY, this.radius + 4, 0, Math.PI * 2);
			ctx.fill();
			
			// Inner bright white tint on body
			ctx.globalAlpha = 0.175 * glowIntensity * this._renderAlpha;
			ctx.beginPath();
			ctx.arc(screenX, screenY, this.radius, 0, Math.PI * 2);
			ctx.fill();
			
			ctx.restore();
		}
	} catch(_) {}

				// Red aura that scales with slider progress; adds bright white core only when locked
				// Hide glow when invisible
				try {
					const locked = (typeof window !== 'undefined' && window.__killThemAllLocked === true);
					const progress = Math.max(0, Math.min(1, (typeof window !== 'undefined' && typeof window.__killThemAllProgress === 'number') ? window.__killThemAllProgress : 0));
					// Use full progress when locked; otherwise, suppress glow below 10% and remap 10%..100% -> 0..1
					const rawP = locked ? 1 : progress;
					let p = 0;
					if (rawP >= 0.1) p = Math.max(0, Math.min(1, (rawP - 0.1) / 0.9));
					// Global intensity scale (40% of previous)
					const alphaScale = 0.4;
					// Hide evil glow when invisible
					if (p > 0.001 && !this.invisible) {
                                ctx.save();
                                ctx.globalCompositeOperation = 'lighter';
                                // Scale radii with progress (unchanged shape), alphas scaled to ~40% of prior maximum
                                const outerR = this.radius + (6 + 16 * p);
                                const midR = this.radius + (4 + 10 * p);
                                const innerR = this.radius + (2 + 4 * p);
                                // Previous maxima ~0.70, 0.45, 0.30; make them proportional to p and scale to 40%
                                const outerA = 0.70 * p * alphaScale;
                                const midA = 0.45 * p * alphaScale;
                                const innerA = 0.30 * p * alphaScale;
                                // Outer halo
                                ctx.globalAlpha = outerA;
                                ctx.fillStyle = '#ff3a3a';
                                ctx.beginPath();
                                ctx.arc(screenX, screenY, outerR, 0, Math.PI * 2);
                                ctx.fill();
                                // Middle halo
                                ctx.globalAlpha = midA;
                                ctx.fillStyle = '#ff2020';
                                ctx.beginPath();
                                ctx.arc(screenX, screenY, midR, 0, Math.PI * 2);
                                ctx.fill();
                                // Inner hot red core (always present but much stronger when p=1)
                                ctx.globalAlpha = innerA;
                                ctx.fillStyle = '#ff0000';
                                ctx.beginPath();
                                ctx.arc(screenX, screenY, innerR, 0, Math.PI * 2);
                                ctx.fill();
                                // Bright white core only at full lock (also reduced to ~40%)
                                if (locked) {
                                        ctx.globalAlpha = 0.35 * alphaScale;
                                        ctx.fillStyle = '#ffffff';
                                        ctx.beginPath();
                                        ctx.arc(screenX, screenY, this.radius * 0.7, 0, Math.PI * 2);
                                        ctx.fill();
                                }
                                ctx.restore();
                        }
                } catch(_) {}

                // Quick red flash overlay when hit
                if (this.hitFlash > 0) {
                        const denom = (this.hitFlashMax || 0.12);
                        const t = Math.max(0, Math.min(1, this.hitFlash / denom));
                        ctx.save();
                        ctx.globalAlpha = Math.pow(t, 0.4) * 0.9; // strong at start, very fast fade
                        ctx.fillStyle = '#ff3b3b';
                        ctx.beginPath();
                        ctx.arc(screenX, screenY, this.radius, 0, Math.PI * 2);
                        ctx.fill();
                        ctx.restore();
                }
                ctx.lineWidth = 3;
                ctx.strokeStyle = this.outline;
                ctx.stroke();
		// Slow green pulse overlay while slowed by puke (and fade-out for 0.7s after slow ends)
		try {
			const st = this._slowState || {};
			const fading = !!(st.fade && st.fade > 0);
			if ((st && st.active) || fading) {
				const t = (this._slimePulseT || 0);
				// Base pulse ~0.8Hz
				let a = 0.3 + 0.3 * (Math.sin(t * Math.PI * 2 * 0.8) * 0.5 + 0.5); // ~30%..60%
				if (!st.active && fading) {
					// Scale alpha by remaining fade time (0..0.7)
					const k = Math.max(0, Math.min(1, st.fade / 0.7));
					a *= k;
				}
				ctx.save();
				ctx.globalAlpha = a;
				ctx.fillStyle = '#a8c400';
				ctx.beginPath();
				ctx.arc(screenX, screenY, this.radius + 2, 0, Math.PI * 2);
				ctx.fill();
				ctx.restore();
			}
		} catch(_) {}
	// Brown mud pulse overlay while slowed by mud (more intense)
	try {
		const mst = this._mudSlowState || {};
		const t = (this._slimePulseT || 0); // Reuse same timer for visual consistency
		if (mst && mst.active) {
			// Base pulse ~0.7Hz (slightly slower than slime)
			const a = 0.45 + 0.35 * (Math.sin(t * Math.PI * 2 * 0.7) * 0.5 + 0.5); // ~45%..80% (much more intense)
			ctx.save();
			ctx.globalAlpha = a;
			ctx.fillStyle = '#4a3a28'; // Darker brown
			ctx.beginPath();
			ctx.arc(screenX, screenY, this.radius + 2, 0, Math.PI * 2);
			ctx.fill();
			ctx.restore();
		}
	} catch(_) {}
                // Magenta ensnare ring while captured by Licker
                try {
                        if (this._ensnaredTimer > 0) {
                                const t = (this._ensnarePulseT || 0);
                                const pulse = 0.5 + 0.5 * (Math.sin(t * Math.PI * 2 * 1.2) * 0.5 + 0.5); // gentle pulse
                                const ringR = this.radius + 10 + 3 * pulse;
                                ctx.save();
                                ctx.globalAlpha = 0.9;
                                ctx.strokeStyle = '#cc66cc';
                                ctx.lineWidth = 3 + 2 * pulse;
                                ctx.beginPath();
                                ctx.arc(screenX, screenY, ringR, 0, Math.PI * 2);
                                ctx.stroke();
                                ctx.restore();
                        }
                } catch(_) {}
                // Slime drip VFX while slowed
                try {
			if (this._slimeDrips && this._slimeDrips.length > 0) {
				for (let i = 0; i < this._slimeDrips.length; i++) {
					const d = this._slimeDrips[i];
					const t = Math.max(d.life, 0) / (d.total || 0.001);
					const sx = d.x - camera.x;
					const sy = d.y - camera.y;
					// Soft outer glow
					ctx.save();
					ctx.globalAlpha = 0.18 * t;
					ctx.fillStyle = '#a8c400';
					ctx.beginPath();
					ctx.arc(sx, sy, d.r * 2.2, 0, Math.PI * 2);
					ctx.fill();
					// Core droplet
					ctx.globalAlpha = 0.9 * t;
					ctx.fillStyle = '#a8c400';
					ctx.beginPath();
					ctx.arc(sx, sy, d.r, 0, Math.PI * 2);
					ctx.fill();
					// Dark edge for definition
					ctx.globalAlpha = 0.5 * t;
					ctx.strokeStyle = '#4a5c11';
					ctx.lineWidth = 1;
					ctx.beginPath();
					ctx.arc(sx, sy, d.r, 0, Math.PI * 2);
					ctx.stroke();
					ctx.restore();
				}
			}
			
		// Draw mud drips (brown, similar to slime but different colors)
		if (this._mudDrips && this._mudDrips.length > 0) {
			for (let i = 0; i < this._mudDrips.length; i++) {
				const d = this._mudDrips[i];
				const t = Math.max(d.life, 0) / (d.total || 0.001);
				const sx = d.x - camera.x;
				const sy = d.y - camera.y;
				// Soft outer glow (darker brown)
				ctx.save();
				ctx.globalAlpha = 0.25 * t;
				ctx.fillStyle = '#4a3a28';
				ctx.beginPath();
				ctx.arc(sx, sy, d.r * 2.2, 0, Math.PI * 2);
				ctx.fill();
				// Core droplet (dark brown)
				ctx.globalAlpha = 0.9 * t;
				ctx.fillStyle = '#5c4a34';
				ctx.beginPath();
				ctx.arc(sx, sy, d.r, 0, Math.PI * 2);
				ctx.fill();
				// Dark edge for definition
				ctx.globalAlpha = 0.7 * t;
				ctx.strokeStyle = '#2b1f14';
				ctx.lineWidth = 1;
				ctx.beginPath();
				ctx.arc(sx, sy, d.r, 0, Math.PI * 2);
				ctx.stroke();
				ctx.restore();
			}
		}
		} catch(_) {}
                
                // Flame VFX when burning from DOT stacks - drawn LAST so it's on top of everything
                // Use the SAME system as remote players: check remoteBurningPlayers Map
                try {
                        const myId = window.networkManager?.playerId;
                        const isBurning = myId && window.networkManager?.remoteBurningPlayers?.has(myId);
                        
                        // Don't render fire if player is dead
                        if (isBurning && this.health > 0) {
                                ctx.save();
                                ctx.globalCompositeOperation = 'source-over'; // Ensure fire draws on top
                                // Use remoteBurningPlayers data like remote players do
                                const burnData = window.networkManager.remoteBurningPlayers.get(myId);
                                const burnDuration = Date.now() - burnData.startTime;
                                const intensity = Math.min(1.2, 1.0); // Same as remote players
                                const baseR = (this.radius || 26) * (0.9 + 0.6 * intensity);
                                const t = burnDuration / 1000; // Convert to seconds for animation timing
                                const wobble = Math.sin(t * 6) * 0.12;
                                const sx0 = screenX + wobble * (this.radius || 26) * 0.25;
                                const sy0 = screenY - (this.radius || 26) * (0.25 + 0.06 * Math.sin(t * 4 + (this.id || 1)));
                                const grad = ctx.createRadialGradient(sx0, sy0, baseR * 0.1, sx0, sy0, baseR);
                                grad.addColorStop(0, 'rgba(255, 250, 210, ' + (0.9 * intensity) + ')');
                                grad.addColorStop(0.35, 'rgba(255, 200, 80, ' + (0.6 * intensity) + ')');
                                grad.addColorStop(1, 'rgba(255, 120, 0, 0)');
                                ctx.fillStyle = grad;
                                ctx.beginPath();
                                ctx.ellipse(sx0, sy0, baseR * (0.65 + 0.05 * Math.sin(t * 8)), baseR * (1.25 + 0.1 * Math.sin(t * 5 + 1.1)), wobble * 0.5, 0, Math.PI * 2);
                                ctx.fill();
                                // Small sparks
                                const sparkN = 2 + Math.floor(intensity * 3);
                                for (let i = 0; i < sparkN; i++) {
                                        const a = (-Math.PI / 2) + (Math.random() - 0.5) * 0.6;
                                        const r = (this.radius || 26) * (0.3 + Math.random() * 0.6);
                                        const px = sx0 + Math.cos(a) * r;
                                        const py = sy0 + Math.sin(a) * r - (4 + Math.random() * 9);
                                        ctx.globalAlpha = 0.5 * intensity;
                                        ctx.fillStyle = '#ffd36b';
                                        ctx.beginPath();
                                        ctx.arc(px, py, 1.3, 0, Math.PI * 2);
                                        ctx.fill();
                                }
                                ctx.restore();
                        }
                } catch(err) {
                        console.error('🔥 [Player.draw] Fire VFX error:', err);
                }
                
                // Health bar above player's head
                ctx.save();
                const h = Number.isFinite(this.health) ? this.health : 0;
                const hm = Number.isFinite(this.healthMax) ? this.healthMax : 100;
                const healthPercent = Math.max(0, Math.min(1, h / Math.max(1, hm)));
                const barWidth = 30;
                const barHeight = 4;
                const barX = screenX - barWidth / 2;
                const barY = screenY - this.radius - 10;
                
                // Health bar background
                ctx.fillStyle = '#333';
                ctx.fillRect(barX, barY, barWidth, barHeight);
                
                // Health bar fill (color based on health percentage)
                ctx.fillStyle = healthPercent > 0.5 ? '#4CAF50' : healthPercent > 0.25 ? '#FF9800' : '#F44336';
                ctx.fillRect(barX, barY, barWidth * healthPercent, barHeight);
                ctx.restore();
                
                // Draw dash feedback text above player (e.g., "OUT OF STAMINA")
                if (this.dashFeedbackTimer > 0 && this.dashFeedbackText) {
                        const textY = screenY - (this.radius || 26) - 45;
                        ctx.save();
                        ctx.font = 'bold 16px Arial';
                        ctx.textAlign = 'center';
                        ctx.textBaseline = 'middle';
                        
                        // Fade out in last 0.5 seconds
                        let alpha = 1.0;
                        if (this.dashFeedbackTimer < 0.5) {
                                alpha = this.dashFeedbackTimer / 0.5;
                        }
                        
                        // Shadow
                        ctx.globalAlpha = alpha * 0.6;
                        ctx.fillStyle = 'rgba(0,0,0,0.8)';
                        ctx.fillText(this.dashFeedbackText, screenX + 2, textY + 2);
                        
                        // Main text (red for error)
                        ctx.globalAlpha = alpha;
                        ctx.fillStyle = '#ff4444';
                        ctx.fillText(this.dashFeedbackText, screenX, textY);
                        
                        ctx.restore();
                }
                
                // Draw equipped skin (stays upright regardless of player rotation)
                if (this.equippedSkin && typeof window.SkinRenderer !== 'undefined') {
                        try {
                                window.SkinRenderer.render(
                                        ctx, 
                                        screenX, 
                                        screenY, 
                                        this.radius,
                                        this.equippedSkin.name,
                                        this.equippedSkin.color
                                );
                        } catch(e) {
                                console.warn('[Player] Skin rendering error:', e);
                        }
                }
                
                // Draw equipped hat (stays upright regardless of player rotation)
                if (this.equippedHat && typeof window.HatRenderer !== 'undefined') {
                        try {
                                window.HatRenderer.render(
                                        ctx, 
                                        screenX, 
                                        screenY, 
                                        this.radius,
                                        this.equippedHat.name,
                                        this.equippedHat.color
                                );
                        } catch(e) {
                                console.warn('[Player] Hat rendering error:', e);
                        }
                }
		
        }
}
window.Player = Player;

