class UI {
	constructor() {
		// Conversion slider state (shown after NPC_B converts the player)
		this._convSliderValue = 0.05; // 0..1, left to right (start slightly filled)
		this._convSliderDragging = false;
		this._convSliderRect = null; // { x, y, w, h }
		this._convKnobRect = null; // { x, y, w, h }
		this._convLocked = false; // once at end, stays locked forever
		this._prevMouseDown = false;
		// Phase transition notifications
		this.notification = null; // { message: string, startTime: number, duration: number }
		// Respawn button state
		this._respawnButtonRect = null; // { x, y, w, h }
		this._respawnButtonHovered = false;
		this._respawnButtonPressed = false;
		this._respawnButtonClicked = false;
		this._prevMouseDownForRespawn = false;

		// Revive button state (shown on death overlay; enabled when reviveReady)
		this._reviveButtonRect = null; // { x, y, w, h }
		this._reviveButtonHovered = false;
		this._reviveButtonPressed = false;
		this._reviveButtonClicked = false;
		this._prevMouseDownForRevive = false;
		
		// Weapon 8 lock state - initialized by server nfcStatus event
		// Starts undefined - server will set via nfcStatus (locked if reader present, unlocked if not)
		// If never set (e.g., no server), default to true (unlocked) in the UI draw check
	}

	// Show a temporary notification
	showNotification(message, duration = 3000) {
		this.notification = {
			message: message,
			startTime: Date.now(),
			duration: duration
		};
	}

	// Check if notification should still be shown
	_isNotificationActive() {
		if (!this.notification) return false;
		const elapsed = Date.now() - this.notification.startTime;
		if (elapsed >= this.notification.duration) {
			this.notification = null;
			return false;
		}
		return true;
	}

	// Check if respawn button was clicked this frame
	wasRespawnButtonClicked() {
		return this._respawnButtonClicked;
	}

	// Check if revive button was clicked this frame
	wasReviveButtonClicked() {
		return this._reviveButtonClicked;
	}

	// Cached UI draw: renders the full UI to an offscreen canvas at ~15–20Hz and blits it.
	// This cuts down expensive per-frame text/shapes without losing correctness.
	drawCached(ctx, viewportWidth, viewportHeight, player, options = {}) {
		try {
			if (!ctx) return;
			const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
			const cache = (this._uiCache || (this._uiCache = { canvas: null, ctx: null, w: 0, h: 0, lastKey: '', lastMs: 0 }));

			// Rebuild every ~66ms (≈15Hz). UI is informational; slight delay is fine.
			const intervalMs = 66;

			const w = Math.max(1, viewportWidth | 0);
			const h = Math.max(1, viewportHeight | 0);

			const invVer = (player && typeof player._invVersion === 'number') ? player._invVersion : 0;
			const key = [
				w, h,
				// core state
				options.dead ? 1 : 0,
				Math.round((options.respawnTimer || 0) * 10),
				options.reviveAvailable ? 1 : 0,
				options.reviveWindowLeftSec | 0,
				options.selectedSlotIndex | 0,
				options.inLobby ? 1 : 0,
				options.hideQuickbar ? 1 : 0,
				Math.round((options.quickbarFade || 0) * 100),
				options.invincible ? 1 : 0,
				// key player stats that affect displayed numbers/bars
				Math.round((player?.health || 0) * 10),
				Math.round((player?.healthMax || 0) * 10),
				Math.round((player?.stamina || 0) * 10),
				Math.round((player?.staminaMax || 0) * 10),
				player?.ducats | 0,
				player?.bloodMarkers | 0,
				player?.victoryPoints | 0,
				invVer,
				// mode timers
				options.modeName || '',
				Math.round((options.modeTimeLeft || 0) * 10),
				// artillery timer (stringify minimal)
				(options.artilleryTimer && typeof options.artilleryTimer.timeLeft === 'number') ? Math.round(options.artilleryTimer.timeLeft) : ''
			].join('|');

			const needsResize = (!cache.canvas || cache.w !== w || cache.h !== h);
			const needsRefresh = needsResize || key !== cache.lastKey || (now - (cache.lastMs || 0)) >= intervalMs;

			if (needsResize) {
				cache.canvas = document.createElement('canvas');
				cache.canvas.width = w;
				cache.canvas.height = h;
				cache.ctx = cache.canvas.getContext('2d');
				cache.w = w;
				cache.h = h;
				cache.lastMs = 0;
			}

			if (needsRefresh && cache.ctx) {
				cache.ctx.clearRect(0, 0, w, h);
				this._drawRaw(cache.ctx, viewportWidth, viewportHeight, player, options);
				cache.lastKey = key;
				cache.lastMs = now;
			}

			if (cache.canvas) {
				ctx.save();
				try { ctx.imageSmoothingEnabled = true; } catch(_) {}
				ctx.drawImage(cache.canvas, 0, 0);
				ctx.restore();
				return;
			}
		} catch(_) {}

		// Fallback to direct rendering if caching fails
		return this._drawRaw(ctx, viewportWidth, viewportHeight, player, options);
	}

	// Default draw remains available (uncached).
	draw(ctx, viewportWidth, viewportHeight, player, options = {}) {
		return this._drawRaw(ctx, viewportWidth, viewportHeight, player, options);
	}

                _drawRaw(ctx, viewportWidth, viewportHeight, player, options = {}) {
                const margin = 16;
                const staminaWidth = 200;
                const staminaHeight = 10;
                const healthWidth = Math.round(staminaWidth * 1.5);
                const healthHeight = Math.round(staminaHeight * 1.5);

                // Pickup type labels (upper right, above bars)
                let topOffset = margin;
                {
                        // Live stats readout: MovSpd, AtkSpd, AtkPwr, Armor, HP, Stm
                        const weapon = options.weapon || null;
                        const weaponIndex = (options.weaponIndex != null) ? options.weaponIndex : null;
                        const fmt = (n, d = 0) => (typeof n === 'number' && Number.isFinite(n)) ? (d > 0 ? n.toFixed(d) : String(Math.round(n))) : '—';
                        const movSpd = fmt(player?.speed, 0);
                        // Show effective attack speed (fire rate scaled by player's AtkSpd%)
                        let atkSpd = '—';
                        try {
                                if (weapon && typeof weapon.fireRate === 'number') {
                                        const pct = Math.max(0, Math.min(500, player?.getTotalAttackSpeedPercent?.() || 0));
                                        const eff = weapon.fireRate * (1 + pct / 100);
                                        atkSpd = eff.toFixed(2);
                                }
                        } catch(_) {}
                        const atkPwr = (function() {
                                const ap = Math.max(0, player?.getTotalAttackPowerFlat?.() || 0);
                                if (weaponIndex === 0) return `30+${ap}`; // cone hit base + AP
                                if (weaponIndex === 1) return `20–100+${ap} AoE`; // explosion ring base + AP
                                if (weaponIndex === 2) return `30–45+${ap}`; // rect projectile base + AP
                                if (weaponIndex === 3) {
                                        const dot = (5 + ap * 0.1);
                                        return `DOT ${dot.toFixed(1)}/s×3s`; // DOT per second including AP×0.1
                                }
                                if (weaponIndex === 4) return `20+${ap}`; // default projectile base + AP
                                if (weaponIndex === 6) {
                                        // Weapon 7 (hitscan) base damage scales with PRIMARY loot tiers:
                                        // loot 0-1 => 10
                                        // loot 2-3 => 10-15
                                        // loot 4-6 => 15-20
                                        const lootLevel = player?.getEffectiveLootLevel?.() || 0;
                                        const base = (lootLevel >= 4) ? '15–20' : (lootLevel >= 2) ? '10–15' : '10';
                                        const apBonus = Math.ceil(ap / 3);
                                        return `${base}+${apBonus}`;
                                }
                                return (weapon ? `20+${ap}` : '—');
                        })();
                        const armor = (function(){
                                try {
                                        if (player && typeof player.getArmorReductionFactor === 'function') {
                                                const frac = Math.max(0, Math.min(0.75, player.getArmorReductionFactor()));
                                                return `${Math.round(frac * 100)}%`;
                                        }
                                } catch(_) {}
                                return '0%';
                        })();
                        const hp = (player && typeof player.health === 'number' && typeof player.healthMax === 'number') ? `${Math.max(0, Math.round(player.health))}/${Math.max(1, Math.round(player.healthMax))}` : '—';
                        const sMax = Math.max(1, Math.round(player?.staminaMax ?? 100));
                        const sCur = Math.max(0, Math.round(Math.min(sMax, player?.stamina ?? 0)));
                        const stm = `${sCur}/${sMax}`;
                        const critChan = (player && typeof player.critChance === 'number') ? `${Math.round(Math.max(0, Math.min(1, player.critChance)) * 100)}%` : '—';
                        const critDmg = (player && typeof player.critDamageMultiplier === 'number') ? `${Math.round(Math.max(1, player.critDamageMultiplier) * 100)}%` : '—';
                        const partsRow1 = [
                                `MovSpd: ${movSpd}`,
                                `AtkSpd: ${atkSpd}`,
                                `AtkPwr: ${atkPwr}`,
                                `CritChan: ${critChan}`,
                                `CritDmg: ${critDmg}`
                        ];
                        const partsRow2 = [
                                `Armor: ${armor}`,
                                `HP: ${hp}`,
                                `Stm: ${stm}`
                        ];
                        const label1 = partsRow1.join('  ');
                        const label2 = partsRow2.join('  ');
                        ctx.save();
                        ctx.textAlign = 'left';
                        ctx.textBaseline = 'top';
                        ctx.font = '14px monospace';
                        // Shadow for readability
                        ctx.fillStyle = 'rgba(0,0,0,0.5)';
                        ctx.fillText(label1, margin + 1, topOffset + 1);
                        ctx.fillText(label2, margin + 1, topOffset + 18 + 1);
                        ctx.fillStyle = '#ffffff';
                        ctx.fillText(label1, margin, topOffset);
                        ctx.fillText(label2, margin, topOffset + 18);
                        ctx.restore();
                        // Keep bar offset at one row to avoid extra displacement
                        topOffset += 18; // approx font height for first row
                }

                // Currency wallet (ducats and blood markers) above health bar
                const currencyY = topOffset - 22;
                ctx.save();
                ctx.font = 'bold 14px monospace';
                ctx.textAlign = 'left'; // Changed from 'right' to 'left' so numbers expand rightward
                ctx.textBaseline = 'middle';
                
                // Get currency counts
                const ducatCount = (player && typeof player.ducats === 'number') ? player.ducats : 0;
                const markerCount = (player && typeof player.bloodMarkers === 'number') ? player.bloodMarkers : 0;
                const vpCount = (player && typeof player.victoryPoints === 'number') ? player.victoryPoints : 0;
                
                // Calculate spacing: reserve more space per currency item (icon + text + gap)
                const itemWidth = 85; // Increased spacing for longer text (blood markers show X/Y format)
                
                // Victory Points display (4-sided star icon + count) - LEFTMOST
                const vpIconX = viewportWidth - margin - (itemWidth * 3); // Fixed icon position
                const vpX = vpIconX + 18; // Text starts after icon (icon + gap)
                // Draw 4-sided star with curved edges
                ctx.save();
                const starSize = 8; // Star radius (reduced from 12 to match other icons)
                const starCX = vpIconX; // Fixed icon position
                const starCY = currencyY;
                ctx.translate(starCX, starCY);
                
                // 4-pointed star with curved edges (diamond orientation, bezier curves)
                ctx.fillStyle = '#ffd700'; // Gold color
                ctx.beginPath();
                // Top point
                ctx.moveTo(0, -starSize);
                // Top to right (curved)
                ctx.bezierCurveTo(starSize * 0.3, -starSize * 0.4, starSize * 0.4, -starSize * 0.3, starSize, 0);
                // Right to bottom (curved)
                ctx.bezierCurveTo(starSize * 0.4, starSize * 0.3, starSize * 0.3, starSize * 0.4, 0, starSize);
                // Bottom to left (curved)
                ctx.bezierCurveTo(-starSize * 0.3, starSize * 0.4, -starSize * 0.4, starSize * 0.3, -starSize, 0);
                // Left to top (curved)
                ctx.bezierCurveTo(-starSize * 0.4, -starSize * 0.3, -starSize * 0.3, -starSize * 0.4, 0, -starSize);
                ctx.fill();
                
                // Outline
                ctx.strokeStyle = '#b8860b'; // Dark goldenrod
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.moveTo(0, -starSize);
                ctx.bezierCurveTo(starSize * 0.3, -starSize * 0.4, starSize * 0.4, -starSize * 0.3, starSize, 0);
                ctx.bezierCurveTo(starSize * 0.4, starSize * 0.3, starSize * 0.3, starSize * 0.4, 0, starSize);
                ctx.bezierCurveTo(-starSize * 0.3, starSize * 0.4, -starSize * 0.4, starSize * 0.3, -starSize, 0);
                ctx.bezierCurveTo(-starSize * 0.4, -starSize * 0.3, -starSize * 0.3, -starSize * 0.4, 0, -starSize);
                ctx.stroke();
                
                // Inner highlight
                ctx.fillStyle = '#ffec8b';
                ctx.beginPath();
                ctx.moveTo(0, -starSize * 0.5);
                ctx.bezierCurveTo(starSize * 0.15, -starSize * 0.2, starSize * 0.2, -starSize * 0.15, starSize * 0.5, 0);
                ctx.bezierCurveTo(starSize * 0.2, starSize * 0.15, starSize * 0.15, starSize * 0.2, 0, starSize * 0.5);
                ctx.bezierCurveTo(-starSize * 0.15, starSize * 0.2, -starSize * 0.2, starSize * 0.15, -starSize * 0.5, 0);
                ctx.bezierCurveTo(-starSize * 0.2, -starSize * 0.15, -starSize * 0.15, -starSize * 0.2, 0, -starSize * 0.5);
                ctx.fill();
                
                ctx.restore();
                // Draw VP count
                ctx.fillStyle = 'rgba(0,0,0,0.5)';
                ctx.fillText(`${vpCount}`, vpX + 1, currencyY + 1);
                ctx.fillStyle = '#ffec8b';
                ctx.fillText(`${vpCount}`, vpX, currencyY);
                
                // Blood Marker display (blood drop icon + count) - MIDDLE
                const markerIconX = viewportWidth - margin - (itemWidth * 2); // Fixed icon position
                const markerX = markerIconX + 18; // Text starts after icon (icon + gap)
                // Draw larger blood drop icon with proper teardrop shape
                ctx.save();
                const dropH = 16; // Increased from 10
                const dropW = 11; // Increased from 7
                const dropCX = markerIconX; // Fixed icon position
                const dropCY = currencyY;
                ctx.translate(dropCX, dropCY);
                
                // Improved teardrop shape - thin top, fat rounded bottom
                ctx.fillStyle = '#8b0000';
                ctx.beginPath();
                // Start at very top (thin point)
                ctx.moveTo(0, -dropH/2);
                // Right side curves - gentle curve at top, wider at bottom
                ctx.bezierCurveTo(dropW/3, -dropH/3, dropW/2, -dropH/8, dropW/2, dropH/6);
                // Bottom right curve (fat rounded part)
                ctx.bezierCurveTo(dropW/2, dropH/3, dropW/3, dropH/2.2, 0, dropH/2);
                // Bottom left curve (fat rounded part)
                ctx.bezierCurveTo(-dropW/3, dropH/2.2, -dropW/2, dropH/3, -dropW/2, dropH/6);
                // Left side curves back to top
                ctx.bezierCurveTo(-dropW/2, -dropH/8, -dropW/3, -dropH/3, 0, -dropH/2);
                ctx.fill();
                
                // Outline
                ctx.strokeStyle = '#3b0000';
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.moveTo(0, -dropH/2);
                ctx.bezierCurveTo(dropW/3, -dropH/3, dropW/2, -dropH/8, dropW/2, dropH/6);
                ctx.bezierCurveTo(dropW/2, dropH/3, dropW/3, dropH/2.2, 0, dropH/2);
                ctx.bezierCurveTo(-dropW/3, dropH/2.2, -dropW/2, dropH/3, -dropW/2, dropH/6);
                ctx.bezierCurveTo(-dropW/2, -dropH/8, -dropW/3, -dropH/3, 0, -dropH/2);
                ctx.stroke();
                
                // Highlight (inner lighter spot)
                ctx.fillStyle = '#c41e1e';
                ctx.beginPath();
                ctx.arc(-1, -dropH/5, 2, 0, Math.PI * 2);
                ctx.fill();
                
		ctx.restore();
		// Get current weapon index to determine blood marker cap
		const currentWeaponIndex = (window.projectiles && typeof window.projectiles.currentIndex === 'number') 
			? window.projectiles.currentIndex 
			: 0;
		const markerCap = (player && typeof player.getBloodMarkerCap === 'function')
			? player.getBloodMarkerCap(currentWeaponIndex)
			: 20;
		// Draw count with cap (X/20 format by default)
		const markerText = `${markerCount}/${markerCap}`;
		ctx.fillStyle = 'rgba(0,0,0,0.5)';
		ctx.fillText(markerText, markerX + 1, currencyY + 1);
		ctx.fillStyle = '#ff5a5a';
		ctx.fillText(markerText, markerX, currencyY);
                
                // Ducat display (gold coin icon + count) - RIGHTMOST
                const ducatIconX = viewportWidth - margin - itemWidth; // Fixed icon position
                const ducatX = ducatIconX + 18; // Text starts after icon (icon + gap)
                // Draw gold coin icon
                ctx.save();
                const coinR = 6;
                const coinCX = ducatIconX; // Fixed icon position
                const coinCY = currencyY;
                ctx.fillStyle = '#d4af37';
                ctx.beginPath();
                ctx.arc(coinCX, coinCY, coinR, 0, Math.PI * 2);
                ctx.fill();
                ctx.strokeStyle = '#8a6d1f';
                ctx.lineWidth = 1.5;
                ctx.stroke();
                ctx.fillStyle = '#f4cf47';
                ctx.beginPath();
                ctx.arc(coinCX, coinCY, coinR - 2, 0, Math.PI * 2);
                ctx.fill();
                ctx.restore();
                // Draw count
                ctx.fillStyle = 'rgba(0,0,0,0.5)';
                ctx.fillText(`${ducatCount}`, ducatX + 1, currencyY + 1);
                ctx.fillStyle = '#ffd36b';
                ctx.fillText(`${ducatCount}`, ducatX, currencyY);
                
                ctx.restore();
                
                // Health bar (upper right)
                const hx = viewportWidth - margin - healthWidth;
                const hy = topOffset;
                ctx.save();
                ctx.fillStyle = 'rgba(255,255,255,0.12)';
                ctx.fillRect(hx, hy, healthWidth, healthHeight);
                // Base (red) up to baseline (baseHealthMax). Overcharge uses layered colors above baseline.
                ctx.fillStyle = '#ff5a5a';
                const totalHealth = Math.max(0, player.health ?? 0);
                const baseline = Math.max(1, (player.baseHealthMax || 100));
                const baseFrac = Math.min(1, totalHealth / baseline);
                const baseWidth = Math.round(healthWidth * baseFrac);
                ctx.fillRect(hx + (healthWidth - baseWidth), hy, baseWidth, healthHeight);
                // Overflow 1 (baseline..2×baseline) drawn over red in dark orange
                const overflow1 = Math.max(0, Math.min(baseline, totalHealth - baseline));
                if (overflow1 > 0) {
                        ctx.fillStyle = '#ff8c00';
                        const o1w = Math.round(healthWidth * (overflow1 / baseline));
                        ctx.fillRect(hx + (healthWidth - o1w), hy, o1w, healthHeight);
                }
                // Overflow 2 (2×baseline..3×baseline) drawn over orange in purple
                const overflow2 = Math.max(0, totalHealth - baseline * 2);
                if (overflow2 > 0) {
                        const capped2 = Math.min(baseline, overflow2);
                        ctx.fillStyle = '#a64dff';
                        const o2w = Math.round(healthWidth * (capped2 / baseline));
                        ctx.fillRect(hx + (healthWidth - o2w), hy, o2w, healthHeight);
                }
                ctx.strokeStyle = 'rgba(0,0,0,0.6)';
                ctx.lineWidth = 2;
                ctx.strokeRect(hx + 0.5, hy + 0.5, healthWidth, healthHeight);

                // Stamina bar just underneath (width scales with staminaMax; right-aligned; drains left→right)
                const sy = hy + healthHeight + 8;
                const sMax2 = Math.max(1, player?.staminaMax ?? 100);
                const staminaTotalWidth = Math.round(staminaWidth * sMax2 / 100);
                const sx = viewportWidth - margin - staminaTotalWidth;
                ctx.fillStyle = 'rgba(255,255,255,0.12)';
                ctx.fillRect(sx, sy, staminaTotalWidth, staminaHeight);
                ctx.fillStyle = '#76ffb0';
                const sFrac = Math.max(0, Math.min(1, (player?.stamina ?? 0) / sMax2));
                const sFillW = Math.round(staminaTotalWidth * sFrac);
                ctx.fillRect(sx + (staminaTotalWidth - sFillW), sy, sFillW, staminaHeight);
                ctx.strokeStyle = 'rgba(0,0,0,0.6)';
                ctx.lineWidth = 2;
                ctx.strokeRect(sx + 0.5, sy + 0.5, staminaTotalWidth, staminaHeight);
                
                // Invincibility indicator above health bar (when cheat is active)
                try {
                        if (options.invincible) {
                                const invTextY = hy - 25; // Above health bar
                                const invTextX = hx - 20; // Moved left to avoid currency wallet overlap
                                
                                ctx.save();
                                ctx.font = 'bold 14px sans-serif';
                                ctx.textAlign = 'center';
                                ctx.textBaseline = 'middle';
                                
                                // Drop shadow for visibility
                                ctx.fillStyle = 'rgba(0,0,0,0.7)';
                                ctx.fillText('INVINCIBLE', invTextX + 1, invTextY + 1);
                                
                                // Yellow text
                                ctx.fillStyle = '#ffff00';
                                ctx.fillText('INVINCIBLE', invTextX, invTextY);
                                ctx.restore();
                                
                                // Gear/Settings icon to the right of INVINCIBLE text
                                const gearSize = 16;
                                const gearX = invTextX + 60; // To the right of INVINCIBLE text
                                const gearY = invTextY;
                                
                                ctx.save();
                                ctx.strokeStyle = '#cccccc';
                                ctx.lineWidth = 2;
                                ctx.lineCap = 'round';
                                
                                // Simple gear icon - circle with spokes
                                ctx.beginPath();
                                ctx.arc(gearX, gearY, gearSize/2 - 2, 0, Math.PI * 2);
                                ctx.stroke();
                                
                                // Inner circle
                                ctx.beginPath();
                                ctx.arc(gearX, gearY, gearSize/4, 0, Math.PI * 2);
                                ctx.stroke();
                                
                                // Gear teeth (8 spokes)
                                for (let i = 0; i < 8; i++) {
                                        const angle = (i * Math.PI * 2) / 8;
                                        const innerR = gearSize/2 - 2;
                                        const outerR = gearSize/2 + 2;
                                        const x1 = gearX + Math.cos(angle) * innerR;
                                        const y1 = gearY + Math.sin(angle) * innerR;
                                        const x2 = gearX + Math.cos(angle) * outerR;
                                        const y2 = gearY + Math.sin(angle) * outerR;
                                        
                                        ctx.beginPath();
                                        ctx.moveTo(x1, y1);
                                        ctx.lineTo(x2, y2);
                                        ctx.stroke();
                                }
                                ctx.restore();
                        }
                } catch(e) {
                        // Fail silently if invincible state is not available
                }
                
                ctx.restore();

        // (moved ammo overlay below to draw after quickbar)

                // Conversion slider (upper right, under stamina bar) when player has been converted via dialogue
                try {
                        const flags = (typeof window !== 'undefined') ? (window.dialogueFlags || {}) : {};
                        const isConverted = !!flags.playerConverted;
                        if (isConverted) {
                                const mx = options.mouseX ?? -1;
                                const my = options.mouseY ?? -1;
                                const isMouseDown = !!options.mouseDown;
                                // Geometry under stamina bar: push slider further down to avoid overlap, label just above slider
                                const trackY = sy + staminaHeight + 28;
                                const trackW = staminaTotalWidth;
                                const trackH = 12;
                                const trackX = sx;
                                const baseline = 0.05;

                                // Start/stop dragging on mouse transitions (disabled once locked)
                                // Restore locked state from global (persists across UI instances/frames)
                                try {
                                        if (typeof window !== 'undefined' && window.__killThemAllLocked === true) {
                                                this._convLocked = true;
                                                this._convSliderValue = 1;
                                        }
                                } catch(_) {}
                                if (!this._convLocked) {
                                        if (!this._prevMouseDown && isMouseDown) {
                                                // On press, if inside track, start dragging and set value from mouse
                                                const insideTrack = (mx >= trackX && mx <= trackX + trackW && my >= trackY && my <= trackY + trackH);
                                                if (insideTrack) {
                                                        this._convSliderDragging = true;
                                                        // do not snap immediately; physics update below will move toward target
                                                }
                                        }
                                        if (this._prevMouseDown && !isMouseDown) {
                                                this._convSliderDragging = false;
                                        }
                                        // Physics-based movement with friction and fall-back toward baseline when released
                                        {
                                                const dt = (typeof window !== 'undefined' && window.state && typeof window.state._lastDt === 'number')
                                                        ? Math.max(0.001, Math.min(0.05, window.state._lastDt))
                                                        : (typeof window !== 'undefined' && typeof window._lastDt === 'number' ? Math.max(0.001, Math.min(0.05, window._lastDt)) : 0.016);
                                                const rel = (mx - trackX) / Math.max(1, trackW);
                                                let target = this._convSliderDragging ? Math.max(0, Math.min(1, rel)) : baseline; // fall toward baseline when not dragging
                                                // Slight snap assist very near the end while dragging
                                                if (this._convSliderDragging && rel > 0.98) target = 1;
                                                // Stiffness/damping; allow more drive while dragging, mild resistance near end
                                                const baseStiff = this._convSliderDragging ? 24 : 12;
                                                const baseDamp = 8;
                                                const nearEnd = this._convSliderValue > 0.9 || target > 0.9;
                                                const stiffness = nearEnd ? baseStiff * 0.85 : baseStiff;
                                                const damping = baseDamp;
                                                if (typeof this._convSliderV !== 'number') this._convSliderV = 0;
                                                const accel = (target - this._convSliderValue) * stiffness - this._convSliderV * damping;
                                                this._convSliderV += accel * dt;
                                                // clamp max speed (fraction per second)
                                                const maxSpeed = this._convSliderDragging ? 4.0 : 2.2; // allow faster catch-up while dragging
                                                if (this._convSliderV > maxSpeed) this._convSliderV = maxSpeed;
                                                if (this._convSliderV < -maxSpeed) this._convSliderV = -maxSpeed;
                                                this._convSliderValue += this._convSliderV * dt;
                                                if (this._convSliderValue < 0) this._convSliderValue = 0;
                                                if (this._convSliderValue > 1) this._convSliderValue = 1;
                                        }
                                        // Lock permanently if fully to the right
                                        if (this._convSliderValue >= 0.995) {
                                                this._convSliderValue = 1;
                                                this._convLocked = true;
                                                this._convSliderDragging = false;
                                                this._convSliderV = 0;
                                                try { if (typeof window !== 'undefined') window.__killThemAllLocked = true; } catch(_) {}
                                                // Notify server of evil state change for PvP friendly fire
                                                try {
                                                        if (window.networkManager?.connected) {
                                                                window.networkManager.socket.emit('setEvilState', { isEvil: true });
                                                                console.log('[UI] Sent evil state to server: true');
                                                        }
                                                } catch(_) {}
                                        }
                                }

                                // Draw label (just above slider)
                                const showKill = (this._convLocked || this._convSliderValue >= 0.95);
                                const label = showKill ? 'Kill all Companions or Steal the Artifact' : 'that which is done cannot be undone';
                                ctx.save();
                                ctx.font = '14px sans-serif';
                                ctx.textAlign = 'center';
                                ctx.textBaseline = 'bottom';
                                // shadow
                                ctx.fillStyle = 'rgba(0,0,0,0.6)';
                                ctx.fillText(label, trackX + trackW / 2 + 1, trackY - 4 + 1);
                                ctx.fillStyle = '#ffffff';
                                ctx.fillText(label, trackX + trackW / 2, trackY - 4);

                                // Draw slider track
                                ctx.fillStyle = 'rgba(255,255,255,0.12)';
                                ctx.fillRect(trackX, trackY, trackW, trackH);
                                ctx.lineWidth = 2;
                                ctx.strokeStyle = 'rgba(0,0,0,0.6)';
                                ctx.strokeRect(trackX + 0.5, trackY + 0.5, trackW, trackH);

                                // Draw fill from left to value with color interpolating to red as it increases
                                const fillW = Math.round(trackW * this._convSliderValue);
                                const t = Math.max(0, Math.min(1, this._convSliderValue));
                                const lerp = (a, b, p) => Math.round(a + (b - a) * p);
                                // from grey (154,160,174) to red (255,90,90)
                                const r = lerp(154, 255, t);
                                const g = lerp(160, 90, t);
                                const b = lerp(174, 90, t);
                                ctx.fillStyle = `rgb(${r},${g},${b})`;
                                if (this._convLocked) {
                                        // Stronger glow: double pass (outer + inner)
                                        ctx.save();
                                        ctx.shadowColor = 'rgba(255,40,40,0.85)';
                                        ctx.shadowBlur = 40;
                                        ctx.fillRect(trackX, trackY, fillW, trackH);
                                        ctx.restore();
                                        ctx.save();
                                        ctx.shadowColor = 'rgba(255,80,80,1)';
                                        ctx.shadowBlur = 22;
                                        ctx.fillRect(trackX, trackY, fillW, trackH);
                                        ctx.restore();
                                }
                                ctx.fillRect(trackX, trackY, fillW, trackH);

                                // Draw knob
                                const knobW = 12;
                                const knobH = 18;
                                const knobX = Math.round(trackX + Math.max(0, Math.min(trackW, fillW)) - knobW / 2);
                                const knobY = Math.round(trackY + trackH / 2 - knobH / 2);
                                // knob color matches fill interpolation, slightly brighter; locked -> red
                                const nr = this._convLocked ? 255 : Math.min(255, r + 20);
                                const ng = this._convLocked ? 90 : Math.min(255, g + 10);
                                const nb = this._convLocked ? 90 : Math.min(255, b + 10);
                                ctx.fillStyle = `rgb(${nr},${ng},${nb})`;
                                ctx.strokeStyle = '#000000';
                                ctx.lineWidth = 2;
                                ctx.beginPath();
                                if (this._convLocked) {
                                        // Stronger glow around knob: double pass
                                        ctx.save();
                                        ctx.shadowColor = 'rgba(255,40,40,0.85)';
                                        ctx.shadowBlur = 36;
                                        ctx.rect(knobX + 0.5, knobY + 0.5, knobW, knobH);
                                        ctx.fill();
                                        ctx.restore();
                                        ctx.save();
                                        ctx.shadowColor = 'rgba(255,80,80,1)';
                                        ctx.shadowBlur = 22;
                                        ctx.rect(knobX + 0.5, knobY + 0.5, knobW, knobH);
                                        ctx.fill();
                                        ctx.restore();
                                }
                                ctx.rect(knobX + 0.5, knobY + 0.5, knobW, knobH);
                                ctx.fill();
                                ctx.stroke();
                                ctx.restore();

                                // Update hit rects for potential future use
                                this._convSliderRect = { x: trackX, y: trackY, w: trackW, h: trackH };
                                this._convKnobRect = { x: knobX, y: knobY, w: knobW, h: knobH };

                                // Publish current progress globally for other systems (e.g., player glow)
                                try { if (typeof window !== 'undefined') window.__killThemAllProgress = this._convSliderValue; } catch(_) {}

                                // Remember mouse for next frame
                                this._prevMouseDown = isMouseDown;
                        }
                } catch(_) {
                        // no-op if flags/ui not available
                }

		// Death overlay with respawn button
		if (options.dead) {
			const timeLeft = Math.max(0, options.respawnTimer || 0);
			const canRespawn = timeLeft <= 0;
			const reviveAvailable = !!options.reviveAvailable;
			const mouseX = options.mouseX || 0;
			const mouseY = options.mouseY || 0;
			const isMouseDown = options.mouseDown || false;
			
			ctx.save();
			ctx.fillStyle = 'rgba(0,0,0,0.5)';
			ctx.fillRect(0, 0, viewportWidth, viewportHeight);
			
			// "You Died" text
			ctx.fillStyle = '#ffffff';
			ctx.textAlign = 'center';
			ctx.textBaseline = 'middle';
			ctx.font = 'bold 48px sans-serif';
			ctx.fillText('You Died', viewportWidth / 2, viewportHeight / 2 - 60);
			
			// Timer text (only while waiting)
			if (!canRespawn) {
				ctx.font = '20px sans-serif';
				ctx.fillText(`Please wait ${timeLeft.toFixed(1)}s`, viewportWidth / 2, viewportHeight / 2 - 10);
			}
			
			// Buttons: REVIVE (left) + RESPAWN (right), placed below "You Died"
			const buttonW = 220;
			const buttonH = 60;
			const gap = 18;
			const totalW = buttonW * 2 + gap;
			const startX = viewportWidth / 2 - totalW / 2;
			const buttonsY = viewportHeight / 2 + 10;
			const reviveX = startX;
			const respawnX = startX + buttonW + gap;
			const buttonY = buttonsY;

			// Revive button (left)
			this._reviveButtonRect = { x: reviveX, y: buttonY, w: buttonW, h: buttonH };
			const reviveHovered = mouseX >= reviveX && mouseX <= reviveX + buttonW &&
			                      mouseY >= buttonY && mouseY <= buttonY + buttonH;
			this._reviveButtonHovered = reviveHovered && reviveAvailable;
			this._reviveButtonPressed = reviveHovered && isMouseDown && reviveAvailable;
			this._reviveButtonClicked = false;
			if (this._prevMouseDownForRevive && !isMouseDown && reviveHovered && reviveAvailable) {
				this._reviveButtonClicked = true;
			}
			this._prevMouseDownForRevive = isMouseDown;

			let reviveColor = '#555555'; // Disabled grey
			if (reviveAvailable) {
				if (this._reviveButtonPressed) reviveColor = '#228822';
				else if (this._reviveButtonHovered) reviveColor = '#33cc33';
				else reviveColor = '#22aa22';
			}
			ctx.fillStyle = reviveColor;
			ctx.fillRect(reviveX, buttonY, buttonW, buttonH);
			// Revive countdown (30s to start). Turns red in last 5s.
			const reviveLeft = Math.max(0, Number(options.reviveWindowLeftSec) || 0);
			const reviveUrgent = (!reviveAvailable && reviveLeft > 0 && reviveLeft <= 5);
			ctx.strokeStyle = reviveAvailable ? '#ffffff' : (reviveUrgent ? '#ff4d4d' : '#777777');
			ctx.lineWidth = 3;
			ctx.strokeRect(reviveX, buttonY, buttonW, buttonH);
			ctx.fillStyle = reviveAvailable ? '#ffffff' : '#999999';
			ctx.font = 'bold 24px sans-serif';
			ctx.textAlign = 'center';
			ctx.textBaseline = 'middle';
			ctx.fillText('REVIVE', reviveX + buttonW / 2, buttonY + buttonH / 2);
			// Countdown label below revive button (so it doesn't overlap the "REVIVE" label)
			if (!reviveAvailable && reviveLeft > 0) {
				// Heartbeat pulse when urgent
				let scale = 1;
				if (reviveUrgent) {
					const t = (Date.now() % 900) / 900;
					const beat = Math.pow(Math.max(0, Math.sin(t * Math.PI * 2)), 1.7);
					scale = 1 + 0.22 * beat;
				}
				ctx.save();
				ctx.translate(reviveX + buttonW / 2, buttonY + buttonH + 18);
				ctx.scale(scale, scale);
				ctx.font = 'bold 14px sans-serif';
				ctx.textAlign = 'center';
				ctx.textBaseline = 'top';
				const label = `${reviveLeft} REV`;
				const col = reviveUrgent ? '#ff4d4d' : '#21f07a';
				ctx.fillStyle = 'rgba(0,0,0,0.65)';
				ctx.fillText(label, 1, 1);
				ctx.strokeStyle = 'rgba(0,0,0,0.9)';
				ctx.lineWidth = 3;
				ctx.strokeText(label, 0, 0);
				ctx.fillStyle = col;
				ctx.fillText(label, 0, 0);
				ctx.restore();
			}
			
			// Store button rect for hit detection
			this._respawnButtonRect = { x: respawnX, y: buttonY, w: buttonW, h: buttonH };
			
			// Check if mouse is over button
			const isHovered = mouseX >= respawnX && mouseX <= respawnX + buttonW &&
			                  mouseY >= buttonY && mouseY <= buttonY + buttonH;
			this._respawnButtonHovered = isHovered && canRespawn;
			
			// Check if button is being pressed
			const wasPressed = this._respawnButtonPressed;
			this._respawnButtonPressed = isHovered && isMouseDown && canRespawn;
			
			// Detect click (mouse was down and is now up while hovering)
			this._respawnButtonClicked = false;
			if (this._prevMouseDownForRespawn && !isMouseDown && isHovered && canRespawn) {
				this._respawnButtonClicked = true;
			}
			this._prevMouseDownForRespawn = isMouseDown;
			
			// Button background color based on state
			let buttonColor = '#555555'; // Disabled (grey)
			if (canRespawn) {
				if (this._respawnButtonPressed) {
					buttonColor = '#228822'; // Darker green when pressed
				} else if (this._respawnButtonHovered) {
					buttonColor = '#33cc33'; // Lighter green when hovered
				} else {
					buttonColor = '#22aa22'; // Normal green
				}
			}
			
			// Draw button background
			ctx.fillStyle = buttonColor;
			ctx.fillRect(respawnX, buttonY, buttonW, buttonH);
			
			// Draw button border
			ctx.strokeStyle = canRespawn ? '#ffffff' : '#777777';
			ctx.lineWidth = 3;
			ctx.strokeRect(respawnX, buttonY, buttonW, buttonH);
			
		// Draw button text
		ctx.fillStyle = canRespawn ? '#ffffff' : '#999999';
		ctx.font = 'bold 24px sans-serif';
		ctx.textAlign = 'center';
		ctx.textBaseline = 'middle';
		ctx.fillText('RESPAWN', respawnX + buttonW / 2, buttonY + buttonH / 2);
		
		// Character selection text (positioned above quickbar at bottom)
		if (canRespawn) {
			const qbMargin = 16; // Match quickbar margin
			const boxSize = 56; // Match quickbar box size
			const gap = 6; // Match quickbar gap
			// Calculate center of first 9 weapon boxes (exclude health potion)
			const nineBoxesWidth = 9 * boxSize + 8 * gap;
			const textX = qbMargin + nineBoxesWidth / 2;
			const textY = viewportHeight - 100; // Position above the quickbar
			ctx.font = 'bold 24px sans-serif';
			ctx.textAlign = 'center';
			ctx.textBaseline = 'middle';
			// Shadow for better visibility
			ctx.fillStyle = 'rgba(0,0,0,0.7)';
			ctx.fillText('Press 1-9 to select Character before respawning', textX + 2, textY + 2);
			ctx.fillStyle = '#ffffff';
			ctx.fillText('Press 1-9 to select Character before respawning', textX, textY);
		}
		
		ctx.restore();
		} else {
			// Reset button state when not dead
			this._respawnButtonRect = null;
			this._respawnButtonHovered = false;
			this._respawnButtonPressed = false;
			this._respawnButtonClicked = false;
			this._prevMouseDownForRespawn = false;

			this._reviveButtonRect = null;
			this._reviveButtonHovered = false;
			this._reviveButtonPressed = false;
			this._reviveButtonClicked = false;
			this._prevMouseDownForRevive = false;
		}

                // Inventory slots (left side, centered vertically)
                {
                        const hasArtifact = !!options.artifactCarried;
                        const hasBattery = !!options.batteryCarried;
                        const hasSpecialItem = hasArtifact || hasBattery;
                        const equippedCount = Math.max(0, Math.min(6, options.inventoryCount || 0));
                        // Always render 6 base slots, plus special item slot if carrying artifact or battery
                        const invCount = 6 + (hasSpecialItem ? 1 : 0);
                        const slotSize = 56;
                        const gap = 10;
                        const totalH = invCount * slotSize + (invCount - 1) * gap;
                        const startY = Math.max(margin, Math.round((viewportHeight - totalH) / 2));
                        const x = margin;
                        const radius = 10;
                        const mx = options.mouseX ?? -1;
                        const my = options.mouseY ?? -1;
                        const isMouseDown = !!options.mouseDown;
                        for (let i = 0; i < invCount; i++) {
                                const y = startY + i * (slotSize + gap);
                                ctx.save();
                                ctx.beginPath();
                                const r = Math.min(radius, slotSize / 2);
                                const x0 = x, y0 = y, w = slotSize, h = slotSize;
                                ctx.moveTo(x0 + r, y0);
                                ctx.lineTo(x0 + w - r, y0);
                                ctx.quadraticCurveTo(x0 + w, y0, x0 + w, y0 + r);
                                ctx.lineTo(x0 + w, y0 + h - r);
                                ctx.quadraticCurveTo(x0 + w, y0 + h, x0 + w - r, y0 + h);
                                ctx.lineTo(x0 + r, y0 + h);
                                ctx.quadraticCurveTo(x0, y0 + h, x0, y0 + h - r);
                                ctx.lineTo(x0, y0 + r);
                                ctx.quadraticCurveTo(x0, y0, x0 + r, y0);
                                ctx.closePath();
                                ctx.fillStyle = 'rgba(0,0,0,0.28)';
                                ctx.fill();
                                // Base outline
                                ctx.lineWidth = 2;
                                ctx.strokeStyle = '#000000';
                                ctx.stroke();
                                // Hover/click rim
                                if (mx >= x0 && mx <= x0 + w && my >= y0 && my <= y0 + h) {
                                        if (isMouseDown) {
                                                ctx.lineWidth = 2;
                                                ctx.strokeStyle = '#5aa6ff'; // slightly dimmer when clicked
                                                ctx.stroke();
                                        } else {
                                                ctx.lineWidth = 3;
                                                ctx.strokeStyle = '#8ecaff';
                                                ctx.stroke();
                                        }
                                }
                                ctx.restore();

                                // Draw special item icon in the last slot (artifact or battery)
                                if (hasSpecialItem && i === invCount - 1) {
                                        const iconCx = x + slotSize / 2;
                                        const iconCy = y + slotSize / 2;
                                        
                                        if (hasArtifact) {
                                                // Draw artifact diamond icon
                                                const rIcon = 16;
                                                ctx.save();
                                                ctx.shadowColor = '#4df2ff';
                                                ctx.shadowBlur = 12;
                                                ctx.fillStyle = '#8af7ff';
                                                ctx.strokeStyle = '#2bc7d6';
                                                ctx.lineWidth = 2;
                                                ctx.beginPath();
                                                ctx.moveTo(iconCx, iconCy - rIcon);
                                                ctx.lineTo(iconCx + rIcon, iconCy);
                                                ctx.lineTo(iconCx, iconCy + rIcon);
                                                ctx.lineTo(iconCx - rIcon, iconCy);
                                                ctx.closePath();
                                                ctx.fill();
                                                ctx.stroke();
                                                ctx.restore();
                                        } else if (hasBattery) {
                                                // Draw WW2 military battery icon
                                                const bw = 20, bh = 28;
                                                ctx.save();
                                                
                                                // Olive drab battery body
                                                ctx.fillStyle = '#4a4a32';
                                                ctx.fillRect(iconCx - bw/2, iconCy - bh/2, bw, bh);
                                                
                                                // Side shading
                                                ctx.fillStyle = '#3a3a28';
                                                ctx.fillRect(iconCx - bw/2, iconCy - bh/2, 3, bh);
                                                
                                                // Top plate
                                                ctx.fillStyle = '#5a5a42';
                                                ctx.fillRect(iconCx - bw/2, iconCy - bh/2, bw, 5);
                                                
                                                // Terminals
                                                ctx.fillStyle = '#8b0000';
                                                ctx.fillRect(iconCx - 5, iconCy - bh/2 - 4, 3, 5);
                                                ctx.fillStyle = '#1a1a1a';
                                                ctx.fillRect(iconCx + 2, iconCy - bh/2 - 4, 3, 5);
                                                
                                                // Reinforcement bands
                                                ctx.fillStyle = '#2a2a1c';
                                                ctx.fillRect(iconCx - bw/2, iconCy - 3, bw, 2);
                                                ctx.fillRect(iconCx - bw/2, iconCy + 6, bw, 2);
                                                
                                                // Outline
                                                ctx.strokeStyle = '#1a1a12';
                                                ctx.lineWidth = 1.5;
                                                ctx.strokeRect(iconCx - bw/2, iconCy - bh/2, bw, bh);
                                                
                                                // Subtle glow
                                                ctx.shadowColor = 'rgba(255, 180, 50, 0.5)';
                                                ctx.shadowBlur = 8;
                                                ctx.strokeStyle = 'rgba(255, 180, 50, 0.4)';
                                                ctx.lineWidth = 2;
                                                ctx.strokeRect(iconCx - bw/2 - 1, iconCy - bh/2 - 1, bw + 2, bh + 2);
                                                
                                                ctx.restore();
                                        }
                                }
                                // Draw hex stat icon for equipped items in the first 6 slots
                                const firstEquippedIdx = 0;
                                if (i >= firstEquippedIdx && i < firstEquippedIdx + equippedCount) {
                                        const iconCx = x + slotSize / 2;
                                        // Nudge icon up a bit to make room for label text beneath
                                        const iconCy = y + slotSize / 2 - 6;
                                        const r = 14;
                                        const color = options.getEquippedColor ? options.getEquippedColor(i - firstEquippedIdx) : '#ffffff';
                                        ctx.save();
                                        ctx.shadowColor = color;
                                        ctx.shadowBlur = 12;
                                        ctx.fillStyle = color;
                                        ctx.strokeStyle = '#000000';
                                        ctx.lineWidth = 2;
                                        ctx.beginPath();
                                        for (let k = 0; k < 6; k++) {
                                                const a = Math.PI / 3 * k + Math.PI / 6;
                                                const px = iconCx + Math.cos(a) * r;
                                                const py = iconCy + Math.sin(a) * r;
                                                if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
                                        }
                                        ctx.closePath();
                                        ctx.fill();
                                        ctx.stroke();
                                        ctx.restore();

                                        // Draw label text under icon, centered; use rarity color for text
                                        const label = options.getEquippedLabel ? (options.getEquippedLabel(i - firstEquippedIdx) || '') : '';
                                        if (label) {
                                                ctx.save();
                                                ctx.font = '12px monospace';
                                                ctx.textAlign = 'center';
                                                ctx.textBaseline = 'top';
                                                // shadow for readability
                                                ctx.fillStyle = 'rgba(0,0,0,0.6)';
                                                ctx.fillText(label, x + slotSize / 2 + 1, y + slotSize - 14 + 1);
                                                ctx.fillStyle = color;
                                                ctx.fillText(label, x + slotSize / 2, y + slotSize - 14);
                                                ctx.restore();
                                        }
                                }
                        }
                }

		// Mode timer at top center
		if (options.modeName) {
			let label;
			const isWave = options.modeName.startsWith('Wave');
			const isGuard = options.modeName.startsWith('Guard');
			if (isWave) {
				// Waves: count up in MM:SS
				const minutes = Math.floor((options.modeTimeLeft || 0) / 60);
				const seconds = Math.floor((options.modeTimeLeft || 0) % 60);
				label = `${options.modeName} ${minutes}:${seconds.toString().padStart(2, '0')}`;
			} else if (isGuard) {
				// Guard: countdown in MM:SS
				const t = Math.max(0, options.modeTimeLeft || 0);
				const minutes = Math.floor(t / 60);
				const seconds = Math.floor(t % 60);
				label = `${options.modeName} ${minutes}:${seconds.toString().padStart(2, '0')}`;
			} else {
				// Default (Search): countdown in MM:SS
				const t = Math.max(0, options.modeTimeLeft || 0);
				const minutes = Math.floor(t / 60);
				const seconds = Math.floor(t % 60);
				label = `${options.modeName} ${minutes}:${seconds.toString().padStart(2, '0')}`;
			}
			
			ctx.save();
			ctx.textAlign = 'center';
			ctx.textBaseline = 'top';
			ctx.font = 'bold 18px sans-serif';
			// Shadow for readability
                        ctx.fillStyle = 'rgba(0,0,0,0.5)';
                        ctx.fillText(label, viewportWidth / 2 + 1, margin + 1);
                        ctx.fillStyle = '#ffffff';
                        ctx.fillText(label, viewportWidth / 2, margin);
                        ctx.restore();
		}
		
		// Artillery Barrage timer for Trench Raid mode
		if (options.artilleryTimer) {
			const timer = options.artilleryTimer;
			const time = timer.time || 0;
			const minutes = Math.floor(time / 60);
			const seconds = Math.floor(time % 60);
			const timeStr = `${minutes}:${seconds.toString().padStart(2, '0')}`;
			
			ctx.save();
			ctx.textAlign = 'center';
			ctx.textBaseline = 'top';
			
			// Position at top center
			const timerY = margin;
			
			if (timer.isOvertime) {
				// INCOMING! with heartbeat rhythm flash
				// Heartbeat pattern: two quick beats then rest (lub-dub... lub-dub...)
				const t = Date.now() % 1200; // 1.2 second cycle
				let intensity = 0.4; // Base dim state
				
				// First beat (lub) at 0-100ms
				if (t < 100) {
					intensity = 0.7 + 0.3 * Math.sin((t / 100) * Math.PI);
				}
				// Second beat (dub) at 150-250ms
				else if (t >= 150 && t < 250) {
					intensity = 0.6 + 0.4 * Math.sin(((t - 150) / 100) * Math.PI);
				}
				// Rest period - stay dim
				
				// Scale text slightly with heartbeat
				const scale = 1 + (intensity - 0.4) * 0.08;
				
				ctx.font = `bold ${Math.floor(22 * scale)}px sans-serif`;
				
				const label = `⚠ INCOMING +${timeStr} ⚠`;
				
				// Shadow for readability
				ctx.fillStyle = 'rgba(0,0,0,0.7)';
				ctx.fillText(label, viewportWidth / 2 + 2, timerY + 2);
				
				// Pulsing red with heartbeat intensity
				const r = 255;
				const g = Math.floor(30 * (1 - intensity));
				const b = Math.floor(30 * (1 - intensity));
				ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${0.6 + intensity * 0.4})`;
				ctx.fillText(label, viewportWidth / 2, timerY);
			} else {
				// Countdown phase - calm white "Artillery Barrage"
				ctx.font = 'bold 20px sans-serif';
				const label = `Artillery Barrage ${timeStr}`;
				
				// Shadow for readability
				ctx.fillStyle = 'rgba(0,0,0,0.6)';
				ctx.fillText(label, viewportWidth / 2 + 2, timerY + 2);
				
				// White text
				ctx.fillStyle = '#ffffff';
				ctx.fillText(label, viewportWidth / 2, timerY);
			}
			ctx.restore();
                        
                        // Notification below timer (if active)
                        if (this._isNotificationActive()) {
                        	ctx.save();
                        	ctx.textAlign = 'center';
                        	ctx.textBaseline = 'top';
                        	ctx.font = 'bold 16px sans-serif';
                        	
                        	const notificationY = margin + 24; // Below timer
                        	
                        	// Calculate fade-out effect in last 500ms
                        	const elapsed = Date.now() - this.notification.startTime;
                        	const fadeStart = this.notification.duration - 500;
                        	let alpha = 1.0;
                        	if (elapsed > fadeStart) {
                        		alpha = 1.0 - ((elapsed - fadeStart) / 500);
                        	}
                        	
                        	// Background box for readability
                        	ctx.fillStyle = `rgba(0, 0, 0, ${0.7 * alpha})`;
                        	const textMetrics = ctx.measureText(this.notification.message);
                        	const boxPadding = 12;
                        	const boxWidth = textMetrics.width + boxPadding * 2;
                        	const boxHeight = 28;
                        	ctx.fillRect(
                        		viewportWidth / 2 - boxWidth / 2, 
                        		notificationY - 4, 
                        		boxWidth, 
                        		boxHeight
                        	);
                        	
                        	// Text with shadow and gold color
                        	ctx.fillStyle = `rgba(0, 0, 0, ${0.6 * alpha})`;
                        	ctx.fillText(this.notification.message, viewportWidth / 2 + 1, notificationY + 1);
                        	ctx.fillStyle = `rgba(255, 215, 0, ${alpha})`; // Gold color
                        	ctx.fillText(this.notification.message, viewportWidth / 2, notificationY);
                        	ctx.restore();
                        }
                }

		// Quickbar: 10 boxes labeled 1-10 in lower-left (hidden when requested)
		if (!options.hideQuickbar) {
			const qbMargin = 16;
			const boxSize = 56;
			const gap = 6;
			const by = viewportHeight - qbMargin - boxSize;
			ctx.save();
			ctx.font = '12px monospace';
			ctx.textAlign = 'center';
			ctx.textBaseline = 'middle';
			// Fade when hideQuickbarRecently is provided (0..0.7s age)
			let alpha = 1;
			if (typeof options.quickbarFade === 'number') {
				const t = Math.max(0, Math.min(0.7, options.quickbarFade));
				alpha = 1 - (t / 0.7);
			}
			ctx.globalAlpha = alpha;
			
		// Character-select style: show all 10 slots in lobby, when dead, or in Trench Raid mode
		const inLobby = options.inLobby || false;
		const isDead = options.dead || false;
		const isTrenchRaid = (typeof window !== 'undefined' && window.serverLevelType === 'trenchraid');
		const showAllWeapons = inLobby || isDead || isTrenchRaid;
		const selectedSlot = options.selectedSlotIndex || 0;
		
		// Determine which slots to render
		// Always show health potion (slot 9) even during gameplay
		const slotsToRender = showAllWeapons ? 
			Array.from({length: 10}, (_, i) => i) : 
			(selectedSlot === 9 ? [9] : [selectedSlot, 9]);
			
			for (let loopIdx = 0; loopIdx < slotsToRender.length; loopIdx++) {
				const i = slotsToRender[loopIdx]; // Actual slot index (0-9)
				const bx = qbMargin + loopIdx * (boxSize + gap); // Visual position
				const isSelected = (options.selectedSlotIndex === i);
                                ctx.fillStyle = isSelected ? '#9aa0ae' : '#6e7380'; // lighter grey when selected
                                ctx.fillRect(bx, by, boxSize, boxSize);
                                ctx.strokeStyle = 'rgba(0,0,0,0.6)';
                                ctx.lineWidth = 2;
                                ctx.strokeRect(bx + 0.5, by + 0.5, boxSize, boxSize);
                                ctx.fillStyle = '#ffffff';
                                ctx.fillText(String(i + 1), bx + boxSize / 2, by + boxSize / 2);

                                // Weapon 8 (slot 7): Lock icon if not unlocked via NFC
                                if (i === 7 && !window.weapon8Unlocked) {
                                        ctx.save();
                                        
                                        // Semi-transparent dark overlay on the slot
                                        ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
                                        ctx.fillRect(bx, by, boxSize, boxSize);
                                        
                                        // Draw lock icon in center
                                        const lockX = bx + boxSize / 2;
                                        const lockY = by + boxSize / 2;
                                        const lockSize = 16;
                                        
                                        // Lock body (rounded rectangle)
                                        ctx.fillStyle = '#888888';
                                        const bodyW = lockSize;
                                        const bodyH = lockSize * 0.7;
                                        const bodyX = lockX - bodyW / 2;
                                        const bodyY = lockY - bodyH / 2 + 4;
                                        ctx.beginPath();
                                        ctx.roundRect(bodyX, bodyY, bodyW, bodyH, 2);
                                        ctx.fill();
                                        
                                        // Lock shackle (arc)
                                        ctx.strokeStyle = '#888888';
                                        ctx.lineWidth = 3;
                                        ctx.lineCap = 'round';
                                        ctx.beginPath();
                                        ctx.arc(lockX, lockY - 2, lockSize * 0.35, Math.PI, 0, false);
                                        ctx.stroke();
                                        
                                        // Keyhole
                                        ctx.fillStyle = '#333333';
                                        ctx.beginPath();
                                        ctx.arc(lockX, bodyY + bodyH * 0.35, 2.5, 0, Math.PI * 2);
                                        ctx.fill();
                                        ctx.fillRect(lockX - 1.5, bodyY + bodyH * 0.35, 3, bodyH * 0.4);
                                        
                                        ctx.restore();
                                }

                                // Weapon 1 (slot 0): Shield Wall timer bars
                                if (i === 0 && typeof window !== 'undefined' && window.player) {
                                        // Get max walls from progression
                                        const lootLevel = window.player.lootLevel || 0;
                                        const progression = window.getWeaponProgression ? window.getWeaponProgression(0, lootLevel) : {};
                                        const maxWalls = progression.secondary?.maxWalls;
                                        
                                        if (maxWalls && maxWalls > 0 && window.abilityManager) {
                                                const walls = window.abilityManager.abilities.filter(a => 
                                                        a.constructor.name === 'ShieldWall' && 
                                                        a.owner?.id === player?.id && 
                                                        a.alive
                                                );
                                                
                                                const barHeight = 4;
                                                const barGap = 2; // Gap between bars
                                                const totalBarWidth = boxSize - 4; // Total width available
                                                // Always calculate width as if there are 2 bars maximum
                                                const maxBarsForLayout = 2;
                                                const barWidth = (totalBarWidth - (barGap * (maxBarsForLayout - 1))) / maxBarsForLayout;
                                                const barColor = '#4da3ff'; // Match wall color
                                                const barY = by - 8; // Single row above slot
                                                
                                                ctx.save();
                                                ctx.globalAlpha = alpha; // Respect quickbar fade
                                                
                                                // Draw all bar slots (filled or empty)
                                                for (let w = 0; w < maxWalls; w++) {
                                                        const barX = bx + 2 + (w * (barWidth + barGap));
                                                        const wall = walls[w]; // Get wall for this slot (may be undefined)
                                                        const fraction = (wall && wall.lifeLeft && wall.maxLife) ? Math.max(0, Math.min(1, wall.lifeLeft / wall.maxLife)) : 0;
                                                        
                                                        // Background (lighter gray) - always shown, more visible
                                                        ctx.fillStyle = '#6e7380'; // Match the non-selected quickbar slot color
                                                        ctx.fillRect(barX, barY, barWidth, barHeight);
                                                        
                                                        // Filled portion (blue) - only if wall exists
                                                        if (wall && fraction > 0) {
                                                                ctx.fillStyle = barColor;
                                                                ctx.fillRect(barX, barY, barWidth * fraction, barHeight);
                                                        }
                                                        
                                                        // Border
                                                        ctx.strokeStyle = 'rgba(0,0,0,0.6)';
                                                        ctx.lineWidth = 1;
                                                        ctx.strokeRect(barX + 0.5, barY + 0.5, barWidth, barHeight);
                                                }
                                                
                                                ctx.restore();
                                        }
                                }
                                
                                // Weapon 2 (slot 1): Proximity Mine counter
                                if (i === 1 && typeof window !== 'undefined' && window.player) {
                                        // Get max mines from progression
                                        const lootLevel = window.player.lootLevel || 0;
                                        const progression = window.getWeaponProgression ? window.getWeaponProgression(1, lootLevel) : {};
                                        const maxMines = progression.secondary?.maxMines;
                                        
                                        if (maxMines && maxMines > 0 && window.abilityManager) {
                                                const mines = window.abilityManager.abilities.filter(a => 
                                                        a.constructor.name === 'ProximityMine' && 
                                                        a.owner?.id === player?.id && 
                                                        a.alive
                                                );
                                                const currentMines = mines.length;
                                                const overCap = currentMines > maxMines;
                                                
                                                ctx.save();
                                                ctx.globalAlpha = alpha; // Respect quickbar fade
                                                
                                                // Position above the slot
                                                const labelY = by - 10;
                                                const labelX = bx + boxSize / 2;
                                                
                                                // Draw mine icon (small orange circle with yellow center)
                                                const iconRadius = 4;
                                                const iconX = labelX - 18;
                                                const iconY = labelY;
                                                
                                                // Mine body (orange)
                                                ctx.fillStyle = '#ff9800';
                                                ctx.beginPath();
                                                ctx.arc(iconX, iconY, iconRadius, 0, Math.PI * 2);
                                                ctx.fill();
                                                
                                                // Mine core (yellow)
                                                ctx.fillStyle = '#ffff00';
                                                ctx.beginPath();
                                                ctx.arc(iconX, iconY, iconRadius * 0.6, 0, Math.PI * 2);
                                                ctx.fill();
                                                
                                                // Border
                                                ctx.strokeStyle = 'rgba(0,0,0,0.6)';
                                                ctx.lineWidth = 1;
                                                ctx.beginPath();
                                                ctx.arc(iconX, iconY, iconRadius, 0, Math.PI * 2);
                                                ctx.stroke();
                                                
                                                // Mine counter text
                                                ctx.font = 'bold 11px monospace';
                                                ctx.textAlign = 'left';
                                                ctx.textBaseline = 'middle';
                                                
                                                // Red if over cap, light grey otherwise
                                                ctx.fillStyle = overCap ? '#ff4444' : '#c8d0d8';
                                                
                                                // Draw shadow for readability
                                                ctx.strokeStyle = 'rgba(0,0,0,0.8)';
                                                ctx.lineWidth = 3;
                                                const counterText = `${currentMines}/${maxMines}`;
                                                ctx.strokeText(counterText, iconX + iconRadius + 4, iconY);
                                                ctx.fillText(counterText, iconX + iconRadius + 4, iconY);
                                                
                                                ctx.restore();
                                        }
                                }
                                
                                // Weapon 3 (slot 2): Healing Box status indicators
                                if (i === 2 && typeof window !== 'undefined' && window.player) {
                                        // Get max heal stations from progression
                                        const lootLevel = window.player.lootLevel || 0;
                                        const progression = window.getWeaponProgression ? window.getWeaponProgression(2, lootLevel) : {};
                                        const maxHealStations = progression.secondary?.maxHealStations;
                                        
                                        if (maxHealStations && maxHealStations > 0 && window.abilityManager) {
                                                const healBoxes = window.abilityManager.abilities.filter(a => 
                                                        a.constructor.name === 'HealingBox' && 
                                                        a.owner?.id === player?.id && 
                                                        a.alive
                                                );
                                                
                                                const indicatorSize = 8; // Fixed square size (8x8 pixels)
                                                const indicatorGap = 4; // Gap between indicators
                                                const indicatorY = by - 10; // Position above slot
                                                
                                                // Calculate total width of all indicators
                                                const totalWidth = (indicatorSize * maxHealStations) + (indicatorGap * (maxHealStations - 1));
                                                // Center the indicators horizontally within the slot
                                                const startX = bx + (boxSize - totalWidth) / 2;
                                                
                                                ctx.save();
                                                ctx.globalAlpha = alpha; // Respect quickbar fade
                                                
                                                // Draw all indicator squares (filled or empty)
                                                for (let h = 0; h < maxHealStations; h++) {
                                                        const indicatorX = startX + (h * (indicatorSize + indicatorGap));
                                                        const hasStation = h < healBoxes.length; // Is there a station in this slot?
                                                        
                                                        // Background (grey) when empty, green when filled
                                                        ctx.fillStyle = hasStation ? '#00ff00' : '#6e7380'; // Green or grey
                                                        ctx.fillRect(indicatorX, indicatorY, indicatorSize, indicatorSize);
                                                        
                                                        // Border
                                                        ctx.strokeStyle = 'rgba(0,0,0,0.6)';
                                                        ctx.lineWidth = 1;
                                                        ctx.strokeRect(indicatorX + 0.5, indicatorY + 0.5, indicatorSize, indicatorSize);
                                                }
                                                
                                                ctx.restore();
                                        }
                                }
                                
                                // Weapon 4 (slot 3): Molotov Pool status indicators
                                if (i === 3 && typeof window !== 'undefined' && window.player) {
                                        // Get max pools from progression
                                        const lootLevel = window.player.lootLevel || 0;
                                        const progression = window.getWeaponProgression ? window.getWeaponProgression(3, lootLevel) : {};
                                        const maxPools = progression.secondary?.maxPools;
                                        
                                        if (maxPools && maxPools > 0 && window.abilityManager) {
                                                const molotovPools = window.abilityManager.abilities.filter(a => 
                                                        a.constructor.name === 'MolotovPool' && 
                                                        a.owner?.id === player?.id && 
                                                        a.alive
                                                );
                                                
                                                const indicatorSize = 8; // Circle diameter (8x8 pixels)
                                                const indicatorGap = 4; // Gap between indicators
                                                const indicatorY = by - 10; // Position above slot
                                                
                                                // Calculate total width of all indicators
                                                const totalWidth = (indicatorSize * maxPools) + (indicatorGap * (maxPools - 1));
                                                // Center the indicators horizontally within the slot
                                                const startX = bx + (boxSize - totalWidth) / 2;
                                                
                                                ctx.save();
                                                ctx.globalAlpha = alpha; // Respect quickbar fade
                                                
                                                // Draw all indicator circles (filled or empty)
                                                for (let p = 0; p < maxPools; p++) {
                                                        const indicatorCenterX = startX + (p * (indicatorSize + indicatorGap)) + indicatorSize / 2;
                                                        const indicatorCenterY = indicatorY + indicatorSize / 2;
                                                        const hasPool = p < molotovPools.length; // Is there a pool in this slot?
                                                        const radius = indicatorSize / 2;
                                                        
                                                        // Background (grey) when empty, orange when filled
                                                        ctx.fillStyle = hasPool ? '#ff6600' : '#6e7380'; // Orange or grey
                                                        ctx.beginPath();
                                                        ctx.arc(indicatorCenterX, indicatorCenterY, radius, 0, Math.PI * 2);
                                                        ctx.fill();
                                                        
                                                        // Border
                                                        ctx.strokeStyle = 'rgba(0,0,0,0.6)';
                                                        ctx.lineWidth = 1;
                                                        ctx.beginPath();
                                                        ctx.arc(indicatorCenterX, indicatorCenterY, radius, 0, Math.PI * 2);
                                                        ctx.stroke();
                                                }
                                                
                                                ctx.restore();
                                        }
                                }
                                
                                // Weapon 6 (slot 5): Enemy Attractor status indicators (crosses)
                                if (i === 5 && typeof window !== 'undefined' && window.player) {
                                        // Get max attractors from progression
                                        const lootLevel = window.player.lootLevel || 0;
                                        const progression = window.getWeaponProgression ? window.getWeaponProgression(5, lootLevel) : {};
                                        const maxAttractors = progression.secondary?.maxAttractors;
                                        
                                        if (maxAttractors && maxAttractors > 0 && window.abilityManager) {
                                                const attractors = window.abilityManager.abilities.filter(a => 
                                                        a.constructor.name === 'EnemyAttractor' && 
                                                        a.owner?.id === player?.id && 
                                                        a.alive
                                                );
                                                
                                                const indicatorSize = 10; // Cross size (10x10 pixels)
                                                const indicatorGap = 6; // Gap between indicators
                                                const indicatorY = by - 12; // Position above slot
                                                
                                                // Calculate total width of all indicators
                                                const totalWidth = (indicatorSize * maxAttractors) + (indicatorGap * (maxAttractors - 1));
                                                // Center the indicators horizontally within the slot
                                                const startX = bx + (boxSize - totalWidth) / 2;
                                                
                                                ctx.save();
                                                ctx.globalAlpha = alpha; // Respect quickbar fade
                                                
                                                // Draw all indicator crosses (filled or empty)
                                                for (let a = 0; a < maxAttractors; a++) {
                                                        const indicatorCenterX = startX + (a * (indicatorSize + indicatorGap)) + indicatorSize / 2;
                                                        const indicatorCenterY = indicatorY + indicatorSize / 2;
                                                        const hasAttractor = a < attractors.length; // Is there an attractor in this slot?
                                                        
                                                        // Draw cross shape
                                                        const crossSize = indicatorSize / 2;
                                                        const lineWidth = 2;
                                                        
                                                        // Background (grey) when empty, gold when filled
                                                        ctx.strokeStyle = hasAttractor ? '#d4af37' : '#6e7380'; // Gold or grey
                                                        ctx.lineWidth = lineWidth;
                                                        ctx.lineCap = 'round';
                                                        
                                                        // Vertical line of cross
                                                        ctx.beginPath();
                                                        ctx.moveTo(indicatorCenterX, indicatorCenterY - crossSize);
                                                        ctx.lineTo(indicatorCenterX, indicatorCenterY + crossSize);
                                                        ctx.stroke();
                                                        
                                                        // Horizontal line of cross
                                                        ctx.beginPath();
                                                        ctx.moveTo(indicatorCenterX - crossSize, indicatorCenterY);
                                                        ctx.lineTo(indicatorCenterX + crossSize, indicatorCenterY);
                                                        ctx.stroke();
                                                }
                                                
                                                ctx.restore();
                                        }
                                }
                                
                                // Weapon 7 (slot 6): Auto Turret status indicators (hexagons)
                                if (i === 6 && typeof window !== 'undefined' && window.player) {
                                        // Get max turrets from progression
                                        const lootLevel = window.player.lootLevel || 0;
                                        const progression = window.getWeaponProgression ? window.getWeaponProgression(6, lootLevel) : {};
                                        const maxTurrets = progression.secondary?.maxTurrets;
                                        
                                        if (maxTurrets && maxTurrets > 0 && window.abilityManager) {
                                                const turrets = window.abilityManager.abilities.filter(a => 
                                                        a.constructor.name === 'AutoTurret' && 
                                                        a.owner?.id === player?.id && 
                                                        a.alive
                                                );
                                                
                                                const hexRadius = 6; // Hexagon size
                                                const indicatorGap = 5; // Gap between hexagons
                                                const indicatorY = by - 14; // Position above slot
                                                
                                                // Calculate total width of all indicators
                                                const hexWidth = hexRadius * 2; // Approximate width for spacing
                                                const totalWidth = (hexWidth * maxTurrets) + (indicatorGap * (maxTurrets - 1));
                                                // Center the indicators horizontally within the slot
                                                const startX = bx + (boxSize - totalWidth) / 2;
                                                
                                                ctx.save();
                                                ctx.globalAlpha = alpha; // Respect quickbar fade
                                                
                                                // Draw all indicator hexagons (filled or empty)
                                                for (let t = 0; t < maxTurrets; t++) {
                                                        const centerX = startX + (t * (hexWidth + indicatorGap)) + hexRadius;
                                                        const centerY = indicatorY + hexRadius;
                                                        const hasTurret = t < turrets.length; // Is there a turret in this slot?
                                                        
                                                        // Draw hexagon
                                                        const sides = 6;
                                                        
                                                        ctx.beginPath();
                                                        for (let s = 0; s < sides; s++) {
                                                                const angle = (s / sides) * Math.PI * 2;
                                                                const x = centerX + Math.cos(angle) * hexRadius;
                                                                const y = centerY + Math.sin(angle) * hexRadius;
                                                                if (s === 0) {
                                                                        ctx.moveTo(x, y);
                                                                } else {
                                                                        ctx.lineTo(x, y);
                                                                }
                                                        }
                                                        ctx.closePath();
                                                        
                                                        // Fill: bright green when filled, grey when empty
                                                        ctx.fillStyle = hasTurret ? '#00ff88' : '#6e7380'; // Bright green or grey
                                                        ctx.fill();
                                                        
                                                        // Border
                                                        ctx.strokeStyle = 'rgba(0,0,0,0.6)';
                                                        ctx.lineWidth = 1;
                                                        ctx.stroke();
                                                }
                                                
                                                ctx.restore();
                                        }
                                }

                                // Slot 10 (key F): Health Potion icon + cost badge (red bottle with white +)
                                if (i === 9) {
                                        const has = (typeof window !== 'undefined' && window.player && (window.player.ducats || 0) >= 30);
                                        const cx = bx + boxSize / 2;
                                        const cy = by + boxSize / 2;
                                        ctx.save();
                                        // Bottle body
                                        ctx.lineWidth = 2;
                                        ctx.strokeStyle = '#000000';
                                        ctx.fillStyle = has ? '#cc2b2b' : '#7a5555';
                                        const w = 20, h = 26;
                                        ctx.beginPath();
                                        ctx.moveTo(cx - w/2, cy - h/2 + 6);
                                        ctx.lineTo(cx - w/2, cy + h/2);
                                        ctx.lineTo(cx + w/2, cy + h/2);
                                        ctx.lineTo(cx + w/2, cy - h/2 + 6);
                                        ctx.quadraticCurveTo(cx + w/2, cy - h/2, cx + w/4, cy - h/2);
                                        ctx.lineTo(cx - w/4, cy - h/2);
                                        ctx.quadraticCurveTo(cx - w/2, cy - h/2, cx - w/2, cy - h/2 + 6);
                                        ctx.closePath();
                                        ctx.fill();
                                        ctx.stroke();
                                        // Cork
                                        ctx.fillStyle = '#b5835a';
                                        ctx.fillRect(cx - 6, cy - h/2 - 4, 12, 6);
                                        // White plus on bottle
                                        ctx.strokeStyle = '#ffffff';
                                        ctx.lineWidth = 3;
                                        const cross = 10;
                                        ctx.beginPath();
                                        ctx.moveTo(cx, cy - cross/2);
                                        ctx.lineTo(cx, cy + cross/2);
                                        ctx.stroke();
                                        ctx.beginPath();
                                        ctx.moveTo(cx - cross/2, cy);
                                        ctx.lineTo(cx + cross/2, cy);
                                        ctx.stroke();
                                        // "F" key indicator in upper left corner
                                        const keyX = bx + 6;
                                        const keyY = by + 6;
                                        ctx.font = 'bold 12px monospace';
                                        ctx.textAlign = 'left';
                                        ctx.textBaseline = 'top';
                                        // Shadow for readability
                                        ctx.fillStyle = 'rgba(0,0,0,0.7)';
                                        ctx.fillText('F', keyX + 1, keyY + 1);
                                        ctx.fillStyle = '#ffffff';
                                        ctx.fillText('F', keyX, keyY);
                                        // Cost badge (coin + "30")
                                        const badgeX = bx + boxSize - 6, badgeY = by + 6;
                                        ctx.font = 'bold 10px monospace';
                                        ctx.textAlign = 'right';
                                        ctx.textBaseline = 'top';
                                        ctx.fillStyle = '#d4af37';
                                        ctx.beginPath();
                                        ctx.arc(badgeX - 14, badgeY + 2, 4, 0, Math.PI * 2);
                                        ctx.fill();
                                        ctx.strokeStyle = '#8a6d1f';
                                        ctx.lineWidth = 1;
                                        ctx.stroke();
                                        ctx.fillStyle = has ? '#ffd36b' : '#999999';
                                        ctx.fillText('30', badgeX, badgeY);
                                        // Cooldown/active overlay and progress bar while potion is healing
                                        const active = (typeof window !== 'undefined' && window._potionActive === true);
                                        if (active) {
                                                // Grey overlay while healing
                                                ctx.fillStyle = 'rgba(0,0,0,0.4)';
                                                ctx.fillRect(bx, by, boxSize, boxSize);
                                                // Progress bar from full to empty over remaining time
                                                const now = Date.now();
                                                const endAt = Number(window._potionEndAt) || now;
                                                const dur = Math.max(1, Number(window._potionDuration) || 1);
                                                const remaining = Math.max(0, endAt - now);
                                                const frac = Math.max(0, Math.min(1, remaining / dur));
                                                const pad = 6;
                                                const bw = boxSize - pad * 2;
                                                const bh = 6;
                                                const rx = bx + pad;
                                                const ry2 = by + boxSize - pad - bh;
                                                ctx.fillStyle = 'rgba(0,0,0,0.35)';
                                                ctx.fillRect(rx, ry2, bw, bh);
                                                ctx.fillStyle = '#ff5a5a';
                                                ctx.fillRect(rx, ry2, Math.round(bw * frac), bh);
                                                ctx.strokeStyle = 'rgba(0,0,0,0.6)';
                                                ctx.lineWidth = 1.5;
                                                ctx.strokeRect(rx + 0.5, ry2 + 0.5, bw, bh);
                                        } else if (!has) {
                                                // Grey overlay if cannot afford and not active
                                                ctx.fillStyle = 'rgba(0,0,0,0.35)';
                                                ctx.fillRect(bx, by, boxSize, boxSize);
                                        }
                                        ctx.restore();
                                }
                        }
                        ctx.restore();

		// Weapon 7 ammo/reload UI over the quickbar 7 icon (only when selected)
		try {
			const wIdx = options.weaponIndex;
			if (wIdx === 6 && typeof window !== 'undefined' && window.projectiles) {
				const ammo = Math.max(0, window.projectiles.ammo7 || 0);
				// Get effective max based on player's loot level
				const ammoMax = Math.max(1, window.projectiles.getWeapon7MaxAmmo?.(player) || window.projectiles.ammo7Max || 60);
				const reloading = (window.projectiles.ammo7ReloadTimer || 0) > 0;
				// Find where weapon 7 (slot index 6) appears in the rendered slots
				const weapon7LoopIdx = slotsToRender.indexOf(6);
				if (weapon7LoopIdx === -1) return; // Weapon 7 not visible, skip
				const bx7 = qbMargin + weapon7LoopIdx * (boxSize + gap);
				const cx = bx7 + boxSize / 2;
				const cy = by + boxSize / 2;
                                        ctx.save();
                                        ctx.globalAlpha = alpha;
                                        ctx.textAlign = 'center';
                                        ctx.textBaseline = 'middle';
                                        ctx.font = 'bold 11px monospace';
                                        const label = `${ammo}/${ammoMax}`;
                                        // Place label near bottom of slot to avoid overlapping the center numeral
                                        let yLabel = by + boxSize - 10;
                                        if (reloading) {
                                                const padTmp = 6;
                                                const bhTmp = 6;
                                                const ryTmp = by + boxSize - padTmp - bhTmp;
                                                yLabel = ryTmp - 4;
                                        }
                                        ctx.fillStyle = 'rgba(0,0,0,0.65)';
                                        ctx.fillText(label, cx + 1, yLabel + 1);
                                        ctx.fillStyle = '#ffffff';
                                        ctx.fillText(label, cx, yLabel);
                                        if (reloading) {
                                                const total = Math.max(0.001, window.projectiles.ammo7ReloadSeconds || 3);
                                                const rem = Math.max(0, Math.min(total, window.projectiles.ammo7ReloadTimer || 0));
                                                const frac = 1 - (rem / total);
                                                const pad = 6;
                                                const bw = boxSize - pad * 2;
                                                const bh = 6;
                                                const rx = bx7 + pad;
                                                const ry2 = by + boxSize - pad - bh;
                                                ctx.fillStyle = 'rgba(0,0,0,0.35)';
                                                ctx.fillRect(rx, ry2, bw, bh);
                                                ctx.fillStyle = '#ffd36b';
                                                ctx.fillRect(rx, ry2, Math.round(bw * frac), bh);
                                                ctx.strokeStyle = 'rgba(0,0,0,0.6)';
                                                ctx.lineWidth = 1.5;
                                                ctx.strokeRect(rx + 0.5, ry2 + 0.5, bw, bh);
                                        }
                                        ctx.restore();
                                }
                        } catch(_) {}
                        
                        // Weapon 8 blood marker cost UI over the quickbar 8 icon (always shown when weapon 8 selected and unlocked)
                        try {
                                const wIdx = options.weaponIndex;
                                if (wIdx === 7 && typeof window !== 'undefined' && window.projectiles) {
                                        const lootLevel = player?.getEffectiveLootLevel?.() || 0;
                                        
                                        // Only show if ADS ability is unlocked (loot level 1+)
                                        if (lootLevel < 1) return;
                                        
                                        const progression = window.getWeaponProgression ? window.getWeaponProgression(7, lootLevel) : {};
                                        const bloodCost = progression?.primary?.adsBloodCost || 3;
                                        // Use player's blood markers (server is authoritative)
                                        const playerMarkers = player.bloodMarkers || 0;
                                        
                                        // Find where weapon 8 (slot index 7) appears in the rendered slots
                                        const weapon8LoopIdx = slotsToRender.indexOf(7);
                                        if (weapon8LoopIdx === -1) return; // Weapon 8 not visible, skip
                                        const bx8 = qbMargin + weapon8LoopIdx * (boxSize + gap);
                                        const cx = bx8 + boxSize / 2;
                                        const cy = by + boxSize / 2;
                                        
                                        ctx.save();
                                        ctx.globalAlpha = alpha;
                                        ctx.textAlign = 'center';
                                        ctx.textBaseline = 'middle';
                                        
                                        // Show blood marker cost and current markers
                                        const label = `${playerMarkers}/${bloodCost}`;
                                        // Position above the slot number (consistent with weapon 7 ammo display)
                                        let yLabel = by - 8;
                                        
                                        // Text shadow
                                        ctx.fillStyle = 'rgba(0,0,0,0.65)';
                                        ctx.fillText(label, cx + 1, yLabel + 1);
                                        // Main text - red if insufficient, white if sufficient
                                        ctx.fillStyle = playerMarkers >= bloodCost ? '#ffffff' : '#ff4444';
                                        ctx.fillText(label, cx, yLabel);
                                        
                                        ctx.restore();
                                }
                        } catch(_) {}
                }
        }
}

window.UI = UI;


