// Client Update Module - Extracted from GameLoop.js Phase 5
// Contains all game state update logic
// Multiplayer-only game - no single-player fallbacks
// Phase 1: Now accepts ctx parameter for explicit dependencies

function update(dt, ctx) {
if (DEBUG && !Number.isFinite(dt)) console.warn('[Main] Non-finite dt', dt);

        // Phase 4: Use context with safe guards
        const gameCtx = ctx || window.ctx;
        
        // Guard against uninitialized context
        if (!gameCtx) {
            console.error('[ClientUpdate] Context not initialized yet - window.ctx is undefined!');
            return;
        }
        
        const state = gameCtx.state;
        const player = gameCtx.player;
        const dialogue = gameCtx.dialogue;
        const npcs = gameCtx.npcs;
        const enemies = gameCtx.enemies;
        const environment = gameCtx.environment;

        // Inventory version counter: bump whenever inventory contents change.
        // Used by renderer/UI to avoid per-frame allocations and enable caching without missing changes.
        const bumpInv = (p) => {
                try {
                        if (!p) return;
                        p._invVersion = (typeof p._invVersion === 'number') ? (p._invVersion + 1) : 1;
                } catch(_) {}
        };

        // Initialize ability manager if not exists
        if (!window.abilityManager && typeof AbilityManager !== 'undefined') {
                window.abilityManager = new AbilityManager();
        }
        
        // Initialize barrel manager if not exists
        if (!window.barrelManager && typeof ExplodingBarrelManager !== 'undefined') {
                window.barrelManager = new ExplodingBarrelManager();
        }

        // Freeze gameplay immediately when flagged (e.g., after successful extraction)
        if (state.isFrozen) {
                state.justPressed = false;
                state.justReleased = false;
                state.justPressedKeyE = false;
                return;
        }

        // Auto-close dialogue if player walks away from engaged NPC
        (function autoCloseDialogueIfFar(){
                try {
                        if (dialogue && dialogue.open && dialogue.npcId != null) {
                                let npc = null;
                                for (let i = 0; i < npcs.items.length; i++) { if (npcs.items[i] && npcs.items[i].id === dialogue.npcId) { npc = npcs.items[i]; break; } }
                                if (!npc || !npc.alive) { dialogue.open = false; return; }
                                const dx = npc.x - player.x, dy = npc.y - player.y;
                                const talkR = (npc.radius || 24) + (player.radius || 26) + 36;
                                if (dx*dx + dy*dy > talkR * talkR) dialogue.open = false;
                        }
                } catch(_) {}
        })();

        // Update merchant shop if open
        if (window.merchantShop && window.merchantShop.open) {
                try {
                        const mouseX = (state.mouse && state.mouse.x) || 0;
                        const mouseY = (state.mouse && state.mouse.y) || 0;
                        const mouseDown = state.mouseDown || false;
                        window.merchantShop.update(dt, mouseX, mouseY, mouseDown);
                } catch(err) {
                        console.error('[Update] Error updating merchant shop:', err);
                }
        }

        // Update remote player hit flashes and ensnare timers in multiplayer
        if (window.networkManager) {
                try {
                        window.networkManager.updateRemoteHitFlashes(dt);
                        window.networkManager.updateRemoteEnsnareTimers(dt);
                } catch(_) {}
        }

        // Track health at frame start to detect any incoming damage this update
        const healthAtStart = player.health;
	let detectedContactDamage = false; // Track contact damage separately from health changes

        // Death handling: stop updating player when dead, or while awaiting respawn
        if (player.health <= 0 || state.respawnPending) {
                // Initialize timer on first frame of death (use flag to prevent re-initialization)
                if (!state.respawnPending && !state.deathTimerInitialized) {
                        state.deathTimer = 5.0;
                        state.deathTimerInitialized = true;
                        // Local fallback for revive countdown UI until server downedAt arrives
                        state.downedAtLocal = Date.now();
                        // Broadcast death debug info to server/room
                        try {
                                if (window.networkManager?.connected) {
                                        const name = (typeof player.name === 'string' ? player.name : String(window.networkManager.playerId).substring(0,6));
                                        window.networkManager.socket.emit('playerDeath', { name, x: player.x, y: player.y });
                                        console.log(`[Client] You died: ${name} at (${player.x.toFixed(1)}, ${player.y.toFixed(1)})`);
                                } else {
                                        console.log(`[Client] You died at (${player.x.toFixed(1)}, ${player.y.toFixed(1)})`);
                                }
                        } catch(_) {}
                        // Clear damage accumulator on death to prevent over-accumulation
                        state.playerDamageAccum = 0;
                        state.playerDamageTextTimer = 0;
                        // Clear loot notification on death
                        player.lootNotificationTimer = 0;
                        player.lootNotificationText = '';
                        // On death: clear ensnare status/effects immediately
                        try {
                                player._ensnaredTimer = 0;
                                player._ensnarePulseT = 0;
                                player._ensnaredById = null;
                                if (player._ensnaredBy && typeof player._ensnaredBy.clear === 'function') player._ensnaredBy.clear();
                        } catch(_) {}
                        // On death: clear burning DOT state and visuals
                        try {
                                player._playerDotStacks = [];
                                player._playerDotAccum = 0;
                                player._playerDotTextTimer = 0;
                                player._burnFxT = 0;
                                // Also clear from remoteBurningPlayers Map
                                if (window.networkManager?.playerId && window.networkManager?.remoteBurningPlayers) {
                                        window.networkManager.remoteBurningPlayers.delete(window.networkManager.playerId);
                                }
                        } catch(_) {}
                        // On death: drop carried artifact (if any) server-authoritatively like a normal drop
                        for (let i = 0; i < chests.length; i++) {
                                const art = chests[i]?.artifact;
                                if (art && art.carriedBy) {
                                        // Toss slightly outward with a small upward impulse for visibility
                                        const screenX = player.x - state.cameraX;
                                        const screenY = player.y - state.cameraY;
                                        const dxAim = state.mouse.x - screenX;
                                        const dyAim = state.mouse.y - screenY;
                                        let aimAngle = Math.atan2(dyAim, dxAim);
                                        // Add a small random spread so it isn't perfectly straight every time
                                        aimAngle += (Math.random() * 0.6 - 0.3);
                                        const horizSpeed = 140;
                                        const lift = 200; // upward impulse
                                        const artSpawnDist = (player.radius || 26) + 18 + 40; // outside the inventory drop ring
                                        const dropX = player.x + Math.cos(aimAngle) * artSpawnDist;
                                        const dropY = player.y + Math.sin(aimAngle) * artSpawnDist;
                                        const vx = Math.cos(aimAngle) * horizSpeed;
                                        const vy = Math.sin(aimAngle) * horizSpeed - lift;
                                        try {
                                                if (window.networkManager?.connected) {
                                                        const id = chests[i]._id || (chests[i]._id = `${Math.round(chests[i].x)},${Math.round(chests[i].y)}`);
                                                        window.networkManager.socket.emit('artifactDropRequest', { chestId: id, x: dropX, y: dropY, vx, vy });
                                                } else {
                                                        art.x = dropX; art.y = dropY;
                                                        art.vx = vx; art.vy = vy;
                                                        art.onGround = false;
                                                        art.carriedBy = null;
                                                        art.pickupLockout = Math.max(0.15, art.pickupLockout || 0.15);
                                                }
                                        } catch(_) {
                                                art.x = dropX; art.y = dropY;
                                                art.vx = vx; art.vy = vy;
                                                art.onGround = false;
                                                art.carriedBy = null;
                                                art.pickupLockout = Math.max(0.15, art.pickupLockout || 0.15);
                                        }
                                }
                        }
                        // Drop equipped items from inventory server-authoritatively like normal drop
                        // NOTE: Gear/loot no longer drops on death/downed. It drops when the player presses RESPAWN.
		}
		// Only count down while not already awaiting server respawn (clamp at 0 to prevent negative)
		if (!state.respawnPending && state.deathTimer > 0) {
			state.deathTimer = Math.max(0, state.deathTimer - dt);
		}
		
		// Check if respawn button was clicked (timer must be <= 0 for button to be enabled)
		const respawnButtonClicked = (window.ui && window.ui.wasRespawnButtonClicked && window.ui.wasRespawnButtonClicked()) || false;
		const reviveButtonClicked = (window.ui && window.ui.wasReviveButtonClicked && window.ui.wasReviveButtonClicked()) || false;
		const reviveReady = (state && state.reviveReady) ? state.reviveReady : null;
		const reviveAvailable = !!(reviveReady && reviveReady.expiresAt && Date.now() < reviveReady.expiresAt);

		// If revive is available, allow accepting it (revives in-place at 30% HP)
		const nowMs = Date.now();
		const reviveAcceptCooldownUntil = Number(state.reviveAcceptCooldownUntil) || 0;
		if (!state.respawnPending && reviveAvailable && reviveButtonClicked && nowMs >= reviveAcceptCooldownUntil) {
			try {
				if (window.networkManager?.connected) {
					window.networkManager.socket.emit('reviveAccept', {});
					// Prevent spam-clicks; don't clear reviveReady until server confirms via playerUpdate (health > 0)
					state.reviveAcceptCooldownUntil = nowMs + 600;
				}
			} catch(_) {}
		}
		
		if (!state.respawnPending && state.deathTimer <= 0 && respawnButtonClicked) {
			// Clear damage accumulator on respawn to start fresh
			state.playerDamageAccum = 0;
			state.playerDamageTextTimer = 0;
			// Clear loot notification on respawn
			player.lootNotificationTimer = 0;
			player.lootNotificationText = '';
			
			// Server will generate and provide the new random spawn position
			// Don't set position locally - wait for server's playerUpdate event
			player.health = player.healthMax;
			
		// Drop equipped items from inventory ONLY when pressing respawn (server-authoritative)
		try {
			if (window.networkManager && window.networkManager.connected && Array.isArray(player.inventory) && player.inventory.length > 0) {
				// Base opposite of aim to avoid forward sector where the artifact is tossed
				const base = (Math.atan2(state.mouse.y - (player.y - state.cameraY), state.mouse.x - (player.x - state.cameraX)) + Math.PI) || 0;
				const itemsPayload = [];
				for (let k = player.inventory.length - 1; k >= 0; k--) {
					const item = player.inventory[k];
					if (!item) { continue; }
					itemsPayload.push({ 
						label: item.baseLabel || item.label, 
						rarityName: (item.rarity && item.rarity.name) || 'Common', 
						color: (item.rarity && item.rarity.color) || item.fill || '#ffffff',
						statKey: item.statKey,
						bonusValue: item.bonusValue,
						isPercent: item.isPercent,
						rarity: item.rarity,
						suppressHealForPlayerId: item.suppressHealForPlayerId
					});
				}
				// Send drop request only if there are items to drop
				if (itemsPayload.length > 0) {
					window.networkManager.socket.emit('inventoryDropRequest', { items: itemsPayload, x: player.x, y: player.y, baseAngle: base, speed: 200 });
				}
			}
			// ALWAYS clear inventory and bump version on respawn, regardless of whether items were dropped
			// This fixes the bug where UI cache keeps old loot icons visible after respawn
			if (Array.isArray(player.inventory) && player.inventory.length > 0) {
				player.inventory.length = 0;
				bumpInv(player);
			}
		} catch(err) {
			console.error('[Main] Error dropping inventory on respawn:', err);
		}
			
			// Request respawn from server (server will assign random position)
			try {
				if (window.networkManager?.connected) {
					const name = (typeof player.name === 'string' ? player.name : String(window.networkManager.playerId).substring(0,6));
					window.networkManager.socket.emit('playerRespawn', { name });
					console.log(`[Client] Respawn requested for ${name} - waiting for server position`);
				}
			} catch(_) {}
			
			// Refill stamina on respawn and clear latches/cooldowns
			const refillTo = Math.max(1, player?.staminaMax ?? 100);
			if (player.stamina < refillTo) {
				player.stamina = refillTo;
				player.mustReleaseShift = false;
				player.mustReleaseFire = false;
				player.exhaustionTimer = 0;
			}
			// Clear all status effects on respawn
			try {
				// Clear DOT stacks
				if (Array.isArray(player._playerDotStacks)) player._playerDotStacks.length = 0;
				player._playerDotAccum = 0;
				player._playerDotTextTimer = 0;
				// Clear ensnare state and visuals
				player._ensnaredTimer = 0;
				player._ensnarePulseT = 0;
				player._ensnaredById = null;
				if (player._ensnaredBy && typeof player._ensnaredBy.clear === 'function') player._ensnaredBy.clear();
				// Clear slow effect and visual drips
				player._svSlowed = false;
				if (Array.isArray(player._slimeDrips)) player._slimeDrips.length = 0;
				player._slimeSpawnTimer = 0;
				player._slimePulseT = 0;
				// Clear slow state timer
				if (player._slowState) {
				    player._slowState.active = false;
				    player._slowState.timer = 0;
				    player._slowState.fade = 0;
				}
				// Clear hit flash visuals
				player.hitFlash = 0;
				player.hitFlashCooldown = 0;
			} catch(_) {}
			state.deathTimer = 0;
			state.deathTimerInitialized = false; // Reset flag for next death
			state.respawnPending = true;
			// Clear revive readiness when choosing respawn
			state.reviveReady = null;
		}
        } else {
		// Reset death timer flag when player is alive
		state.deathTimerInitialized = false;
		state.downedAtLocal = 0;
		// Clear revive readiness when alive
		if (state && state.reviveReady) state.reviveReady = null;
                // Suppress firing while interacting with the conversion slider (when converted)
                let suppressFireForSlider = false;
                try {
                        const flags = (typeof window !== 'undefined') ? (window.dialogueFlags || {}) : {};
                        if (flags.playerConverted) {
                                const margin = 16;
                                const staminaWidth = 200;
                                const staminaHeight = 10;
                                const healthHeight = Math.round(staminaHeight * 1.5);
                                const sMax2 = Math.max(1, player?.staminaMax ?? 100);
                                const staminaTotalWidth = Math.round(staminaWidth * sMax2 / 100);
                                const sx = state.viewportWidth - margin - staminaTotalWidth;
                                const hy = margin + 18;
                                const sy = hy + healthHeight + 8;
                                const trackX = sx;
                                const trackY = sy + staminaHeight + 28;
                                const trackW = staminaTotalWidth;
                                const trackH = 12;
                                const mx = state.mouse.x, my = state.mouse.y;
                                if (state.mouseDown && mx >= trackX && mx <= trackX + trackW && my >= trackY && my <= trackY + trackH) suppressFireForSlider = true;
                        }
                } catch(_) {}
                // Flag firing state for stamina logic (respect mustReleaseFire latch for stamina recharge)
                player.isFiringWeapon4 = !!(state.mouseDown && !suppressFireForSlider && projectiles.currentIndex === 3 && !player.mustReleaseFire);
                player.isFiringWeapon1 = !!(state.mouseDown && !suppressFireForSlider && projectiles.currentIndex === 0);
                
                // Update weapon 8 ADS state before player movement so it can slow the player
                if (projectiles.currentIndex === 7) {
                    const newADS = state.mouseDownRight || false;
                    projectiles.isADS = newADS;
                    player._weapon8ADS = newADS; // Set player property for movement slow (like _ensnaredTimer)
                } else {
                    player._weapon8ADS = false; // Clear when not using weapon 8
                }
                
                player.update(dt, state.keys, environment);
                // Expose for later gating
                if (suppressFireForSlider) {
                        if (typeof window !== 'undefined') window._suppressFireForSlider = true;
                } else { if (typeof window !== 'undefined') window._suppressFireForSlider = false; }
        }

        // UI inventory interaction and fire suppression when hovering inventory
        let suppressFire = false;
        {
                const margin = 16;
                const hasArtifact = chests.some(c => c && c.artifact && c.artifact.carriedBy);
                // Check for carried battery
                let hasBattery = false;
                let carriedBatteryObj = null;
                const batteriesForHover = window._batteries || [];
                for (let bi = 0; bi < batteriesForHover.length; bi++) {
                        if (batteriesForHover[bi] && batteriesForHover[bi].carriedBy === window.networkManager?.playerId) {
                                hasBattery = true;
                                carriedBatteryObj = batteriesForHover[bi];
                                break;
                        }
                }
                const hasSpecialItem = hasArtifact || hasBattery;
                const equippedCount = Math.max(0, Math.min(6, (player.inventory || []).length));
                const invCount = 6 + (hasSpecialItem ? 1 : 0);
                const slotSize = 56;
                const gap = 10;
                const totalH = invCount * slotSize + (invCount - 1) * gap;
                const startY = Math.max(margin, Math.round((state.viewportHeight - totalH) / 2));
                const x = margin;
                const mx = state.mouse.x;
                const my = state.mouse.y;
                let hoveredIndex = -1;
                for (let i = 0; i < invCount; i++) {
                        const y = startY + i * (slotSize + gap);
                        if (mx >= x && mx <= x + slotSize && my >= y && my <= y + slotSize) { hoveredIndex = i; break; }
                }
                if (hoveredIndex !== -1) suppressFire = true;
                // Helper: collect existing ground items for spacing checks
                const collectGround = () => {
                        const arr = [];
                        for (let ci = 0; ci < chests.length; ci++) {
                                const c = chests[ci];
                                if (!c) continue;
                                if (c.artifact && !c.artifact.carriedBy) arr.push({ x: c.artifact.x, y: c.artifact.y, r: c.artifact.radius || 10 });
                                if (Array.isArray(c.drops)) {
                                        for (let di = 0; di < c.drops.length; di++) {
                                                const h = c.drops[di];
                                                if (h && h.onGround && !h.equippedBy) arr.push({ x: h.x, y: h.y, r: h.radius || 12 });
                                        }
                                }
                        }
                        return arr;
                };
                const isClear = (x, y, minDist, existing) => {
                        for (let i = 0; i < existing.length; i++) {
                                const o = existing[i];
                                const dx = x - o.x, dy = y - o.y;
                                if (dx * dx + dy * dy < (minDist + (o.r || 0)) * (minDist + (o.r || 0))) return false;
                        }
                        if (environment && typeof environment.isInsideBounds === 'function') {
                                if (!environment.isInsideBounds(x, y, 12)) return false;
                        }
                        if (environment && typeof environment.circleHitsAny === 'function') {
                                if (environment.circleHitsAny(x, y, 12)) return false;
                        }
                        return true;
                };
                const findClearDrop = (prefX, prefY, minDist) => {
                        const existing = collectGround();
                        // Try preferred first
                        if (isClear(prefX, prefY, minDist, existing)) return { x: prefX, y: prefY };
                        // Spiral search
                        for (let ring = 1; ring <= 6; ring++) {
                                const rad = minDist + ring * 16;
                                const steps = 16;
                                for (let s = 0; s < steps; s++) {
                                        const ang = (s / steps) * Math.PI * 2;
                                        const nx = prefX + Math.cos(ang) * rad;
                                        const ny = prefY + Math.sin(ang) * rad;
                                        if (isClear(nx, ny, minDist, existing)) return { x: nx, y: ny };
                                }
                        }
                        // Fallback
                        return { x: prefX, y: prefY };
                };

                // If click released on inventory, process drop action and consume release
                if (state.justReleased && hoveredIndex !== -1) {
                        if (hasArtifact && hoveredIndex === invCount - 1) {
                                for (let i = 0; i < chests.length; i++) {
                                        const art = chests[i]?.artifact;
                                        if (art && art.carriedBy) {
                                                // Drop just behind the player with spacing
                                                const screenX = player.x - state.cameraX;
                                                const screenY = player.y - state.cameraY;
                                                const dxAim = state.mouse.x - screenX;
                                                const dyAim = state.mouse.y - screenY;
                                                const aimAngle = Math.atan2(dyAim, dxAim);
                                                const backAng = aimAngle + Math.PI;
                                                const dist = (player.radius || 26) + 20;
                                                const prefX = player.x + Math.cos(backAng) * dist;
                                                const prefY = player.y + Math.sin(backAng) * dist;
                                                const pos = findClearDrop(prefX, prefY, 50);
                                                try {
                                                        if (window.networkManager?.connected) {
                                                                const id = chests[i]._id || (chests[i]._id = `${Math.round(chests[i].x)},${Math.round(chests[i].y)}`);
                                                                window.networkManager.socket.emit('artifactDropRequest', { chestId: id, x: pos.x, y: pos.y, vx: 0, vy: 0 });
                                                        } else {
                                                                art.x = pos.x; art.y = pos.y;
                                                                art.vx = 0; art.vy = 0;
                                                                art.onGround = true;
                                                                art.carriedBy = null;
                                                                art.pickupLockout = Math.max(0.15, art.pickupLockout || 0.15);
                                                        }
                                                } catch(_) {
                                                        art.x = pos.x; art.y = pos.y;
                                                        art.vx = 0; art.vy = 0;
                                                        art.onGround = true;
                                                        art.carriedBy = null;
                                                        art.pickupLockout = Math.max(0.15, art.pickupLockout || 0.15);
                                                }
                                        }
                                }
                        }
                        // Drop battery if clicked on battery slot
                        if (hasBattery && carriedBatteryObj && hoveredIndex === invCount - 1) {
                                const screenX = player.x - state.cameraX;
                                const screenY = player.y - state.cameraY;
                                const dxAim = state.mouse.x - screenX;
                                const dyAim = state.mouse.y - screenY;
                                const aimAngle = Math.atan2(dyAim, dxAim);
                                const backAng = aimAngle + Math.PI;
                                const dist = (player.radius || 26) + 20;
                                const dropX = player.x + Math.cos(backAng) * dist;
                                const dropY = player.y + Math.sin(backAng) * dist;
                                try {
                                        if (window.networkManager?.connected) {
                                                window.networkManager.socket.emit('batteryDropRequest', { 
                                                        batteryId: carriedBatteryObj.id, 
                                                        x: dropX, 
                                                        y: dropY 
                                                });
                                        }
                                } catch(e) {
                                        console.error('[Battery] Drop request error:', e);
                                }
                        }
                        // Drop equipped items from inventory slots (first 6)
                        const firstEquippedIdx = 0;
                        if (hoveredIndex >= firstEquippedIdx && hoveredIndex < firstEquippedIdx + equippedCount) {
                                const idx = hoveredIndex - firstEquippedIdx;
                                const item = (player.inventory || [])[idx];
                                if (item) {
                                        // Drop at player's feet slightly forward with spacing
                                        const screenX = player.x - state.cameraX;
                                        const screenY = player.y - state.cameraY;
                                        const dxAim = state.mouse.x - screenX;
                                        const dyAim = state.mouse.y - screenY;
                                        const aimAngle = Math.atan2(dyAim, dxAim);
                                        const fwdAng = aimAngle;
                                        const dist = (player.radius || 26) + 24;
                                        const prefX = player.x + Math.cos(fwdAng) * dist;
                                        const prefY = player.y + Math.sin(fwdAng) * dist;
                                        const pos = findClearDrop(prefX, prefY, 50);
                                        // Server-authoritative drop of inventory items via hover+release
                                        try {
                                                if (window.networkManager?.connected) {
					const payload = { items: [{ 
						label: item.baseLabel || item.label, 
						rarityName: (item.rarity && item.rarity.name) || 'Common', 
						color: (item.rarity && item.rarity.color) || item.fill || '#ffffff',
						statKey: item.statKey,
						bonusValue: item.bonusValue,
						isPercent: item.isPercent,
						rarity: item.rarity,
						suppressHealForPlayerId: item.suppressHealForPlayerId
					}], x: pos.x, y: pos.y, baseAngle: fwdAng, speed: 200 };
					window.networkManager.socket.emit('inventoryDropRequest', payload);
                                                        // Remove locally from inventory immediately for responsiveness
                                                        player.inventory.splice(idx, 1);
                                                        bumpInv(player);
                                                } else {
                                                        item.x = pos.x; item.y = pos.y;
                                                        item.vx = 0; item.vy = 0;
                                                        item.onGround = true;
                                                        item.equippedBy = null;
                                                        if (item && item.statKey === 'Health' && player && typeof player.id === 'number') { item.suppressHealForPlayerId = player.id; }
                                                        item.pickupLockout = Math.max(0.25, item.pickupLockout || 0.25);
                                                        placeDroppedItemInWorld(item);
                                                        // Remove from inventory
                                                        player.inventory.splice(idx, 1);
                                                        bumpInv(player);
                                                }
                                        } catch(_) {
                                                item.x = pos.x; item.y = pos.y;
                                                item.vx = 0; item.vy = 0;
                                                item.onGround = true;
                                                item.equippedBy = null;
                                                if (item && item.statKey === 'Health' && player && typeof player.id === 'number') { item.suppressHealForPlayerId = player.id; }
                                                item.pickupLockout = Math.max(0.25, item.pickupLockout || 0.25);
                                                placeDroppedItemInWorld(item);
                                                // Remove from inventory
                                                player.inventory.splice(idx, 1);
                                                bumpInv(player);
                                        }
                                }
                        }
                        // Consume the release so gameplay doesn't also process it
                        state.justReleased = false;
                }
        }

// Also suppress while dragging/clicking the conversion slider
try { if (window._suppressFireForSlider) suppressFire = true; } catch(_) {}
// Suppress fire when merchant shop is open
try { if (window.merchantShop && window.merchantShop.open) suppressFire = true; } catch(_) {}
if (!state.isFrozen && !suppressFire && player.health > 0 && (state.mouseDown || state.justPressed || state.justReleased)) projectiles.tryFire(dt, player, state.mouse, { x: state.cameraX, y: state.cameraY }, { justPressed: state.justPressed, justReleased: state.justReleased, mouseDown: (state.mouseDown && !(window._suppressFireForSlider || false)) }, enemies, environment);

// Handle secondary fire (right-click abilities)
if (!state.isFrozen && !suppressFire && player.health > 0 && (state.mouseDownRight || state.justPressedRight || state.justReleasedRight)) {
        projectiles.trySecondaryFire(player, state.mouse, { x: state.cameraX, y: state.cameraY }, { 
                justPressed: state.justPressedRight, 
                justReleased: state.justReleasedRight, 
                mouseDown: state.mouseDownRight 
        });
}

state.justPressed = false;
state.justReleased = false;
state.justPressedRight = false;
state.justReleasedRight = false;
        if (!state.isFrozen) {
                projectiles.update(dt, environment, enemies, player);
                
                // Check bullet collisions with gold chest and artifact (server-authoritative damage)
                if (window.isMultiplayer && window.networkManager && window.networkManager.connected) {
                        const bullets = projectiles?.items || [];
                        for (let i = bullets.length - 1; i >= 0; i--) {
                                const b = bullets[i];
                                if (!b || b.noDamage || b.ignoreEnemies) continue;
                                
                                let hitSomething = false;
                                
                                // Check collision with gold chest (when not opened)
                                for (let j = 0; j < chests.length; j++) {
                                        const chest = chests[j];
                                        if (!chest || chest.variant !== 'gold' || chest.opened) continue;
                                        if (!chest._id) chest._id = `${Math.round(chest.x)},${Math.round(chest.y)}`;
                                        
                                        const dx = chest.x - b.x;
                                        const dy = chest.y - b.y;
                                        const dist = Math.hypot(dx, dy);
                                        
                                        if (dist <= chest.radius + b.radius) {
                                                // Hit the chest!
                                                const damage = b.damage || 20;
                                                window.networkManager.socket.emit('chestDamage', {
                                                        chestId: chest._id,
                                                        damage: damage
                                                });
                                                
                                                // Spawn impact VFX
                                                try {
                                                        if (window.enqueueImpactVfx && window.ImpactVfx) {
                                                                window.enqueueImpactVfx(new window.ImpactVfx(b.x, b.y, b.color || '#ffffff', 1.0));
                                                        }
                                                } catch(_) {}
                                                
                                                hitSomething = true;
                                                break;
                                        }
                                }
                                
                                // Check collision with artifact (when not carried)
                                if (!hitSomething) {
                                        for (let j = 0; j < chests.length; j++) {
                                                const chest = chests[j];
                                                if (!chest || !chest.artifact || chest.artifact.carriedBy) continue;
                                                if (!chest._id) chest._id = `${Math.round(chest.x)},${Math.round(chest.y)}`;
                                                
                                                const art = chest.artifact;
                                                const dx = art.x - b.x;
                                                const dy = art.y - b.y;
                                                const dist = Math.hypot(dx, dy);
                                                
                                                if (dist <= art.radius + b.radius) {
                                                        // Hit the artifact!
                                                        const damage = b.damage || 20;
                                                        window.networkManager.socket.emit('artifactDamage', {
                                                                chestId: chest._id,
                                                                damage: damage
                                                        });
                                                        
                                                        // Spawn impact VFX
                                                        try {
                                                                if (window.enqueueImpactVfx && window.ImpactVfx) {
                                                                        window.enqueueImpactVfx(new window.ImpactVfx(b.x, b.y, b.color || '#ffffff', 1.0));
                                                                }
                                                        } catch(_) {}
                                                        
                                                        hitSomething = true;
                                                        break;
                                                }
                                        }
                                }
                                
                                // Remove bullet if it hit something
                                if (hitSomething) {
                                        if (typeof window.releaseBullet === 'function') window.releaseBullet(b);
                                        projectiles.items.splice(i, 1);
                                }
                        }
                }
                
                // Update active abilities (shield walls, mines, turrets, etc.)
                if (window.abilityManager) {
                        // Collect all players for ability updates
                        const allPlayers = [player];
                        if (window.networkManager && window.networkManager.otherPlayers) {
                                for (const [id, p] of window.networkManager.otherPlayers) {
                                        if (p) allPlayers.push(p);
                                }
                        }
                        window.abilityManager.update(dt, environment, enemies, allPlayers);
                }
                
                // Update exploding barrels
                if (window.barrelManager) {
                        window.barrelManager.update(dt);
                }
                
                // ONLY update timer for Extraction mode (server-driven)
                // Other modes (test, payload) don't use the timer
                if (scene.current === 'level' && window.currentLevelType === 'extraction') {
                        modeTimer.update(dt);  // Will be no-op since serverDriven=true
                }
                
                // Update current game mode (for mode-specific timers like Artillery Barrage in trenchraid)
                if (scene.current === 'level' && window.currentGameMode && typeof window.currentGameMode.update === 'function') {
                        window.currentGameMode.update(dt);
                }
                
                // Update neutral NPCs
                npcs.update(dt, environment);
        }
        // Update extraction zone timer and check completion outcome
        if (dialogue && typeof dialogue.update === 'function') dialogue.update(dt);
        // Track quickbar fade timer (0..0.7) based on dialogue visibility
        if (dialogue && dialogue.open) {
                state.quickbarFade = Math.min(0.7, (state.quickbarFade || 0) + dt);
        } else {
                state.quickbarFade = 0;
        }
        if (extractionZone && extractionZone.visible && typeof extractionZone.update === 'function') {
                const wasRunning = extractionZone.started && !extractionZone.extracted;
                // Betrayed trigger: if extraction just started and NPC_A is following, set to betrayed
                try {
                        if (!wasRunning && extractionZone.started && !extractionZone.extracted && npcs && Array.isArray(npcs.items)) {
                                for (let i = 0; i < npcs.items.length; i++) {
                                        const n = npcs.items[i];
                                        if (!n || !n.alive) continue;
                                        if (n.name === 'NPC_A' && n.state === 'follow' && typeof n.switchState === 'function') {
                                                n.switchState('betrayed');
                                        }
                                }
                        }
                } catch(_) {}
                extractionZone.update(dt);
                const justCompleted = wasRunning && extractionZone.extracted;
                if (justCompleted && !state.extractionEnd) {
                        const half = (extractionZone.size || 300) / 2;
                        const inZone = (px, py) => (px >= extractionZone.x - half && px <= extractionZone.x + half && py >= extractionZone.y - half && py <= extractionZone.y + half);
                        const playerIn = inZone(player.x, player.y);
                        let artifactIn = false;
                        for (let i = 0; i < chests.length; i++) {
                                const a = chests[i]?.artifact;
                                if (!a) continue;
                                const ax = a.carriedBy ? a.carriedBy.x : a.x;
                                const ay = a.carriedBy ? a.carriedBy.y : a.y;
                                artifactIn = inZone(ax, ay);
                                break;
                        }
                        
                        // Check if local player is evil
                        let isEvil = false;
                        try { isEvil = (typeof window !== 'undefined' && window.__killThemAllLocked === true); } catch(_) {}
                        
                        if (playerIn && artifactIn) {
                                // Non-evil players win, evil players lose
                                if (isEvil) {
                                        state.extractionEnd = { type: 'lose', reason: 'The artifact was extracted by your enemies' };
                                } else {
                                        state.extractionEnd = { type: 'win' };
                                }
                                state.isFrozen = true;
                        } else {
                                state.extractionEnd = { type: 'lose', reason: 'The artifact was left behind' };
                        }
                }
                // If timer is running and the artifact gets dropped outside the zone, reset the extraction
                if (extractionZone.started && !extractionZone.extracted) {
                        // Locate the artifact
                        let art = null;
                        for (let i = 0; i < chests.length; i++) { const a = chests[i]?.artifact; if (a) { art = a; break; } }
                        if (art && !art.carriedBy && art.onGround) {
                                const half = (extractionZone.size || 300) / 2;
                                const inZone = (px, py) => (px >= extractionZone.x - half && px <= extractionZone.x + half && py >= extractionZone.y - half && py <= extractionZone.y + half);
                                if (!inZone(art.x, art.y)) {
                                        // Reset to unopened state
                                        extractionZone.started = false;
                                        extractionZone.timeLeft = 0;
                                }
                        }
                }
        }

        // Lobby: update ReadyZone countdown
        if (scene.current === 'lobby') {
                try {
                        if (!window._readyZone && window.GameObjects && window.GameObjects.ReadyZone) {
                                window._readyZone = new window.GameObjects.ReadyZone(0, 0, 300);
                        }
                        if (window._readyZone && typeof window._readyZone.update === 'function') {
                                window._readyZone.update(dt);
                        }
                } catch(_) {}
        }
    // Update boss drops
    (function updateBossDrops(){
        const arr = window.bossDrops || [];
        for (let i = 0; i < arr.length; i++) {
            const d = arr[i];
            if (d && typeof d.update === 'function') d.update(dt, environment);
        }
        // Pick up with E handled globally via currentEquipHex logic; ensure nearest selection considers bossDrops too
    })();

    // Update currency pickups (ducats and blood markers)
    (function updateCurrencyPickups(){
        // Initialize arrays if needed
        if (!Array.isArray(window.ducatPickups)) window.ducatPickups = [];
        if (!Array.isArray(window.bloodMarkerPickups)) window.bloodMarkerPickups = [];
        
        // Ensure player has currency tracking
        if (player && typeof player.ducats !== 'number') player.ducats = 0;
        if (player && typeof player.bloodMarkers !== 'number') player.bloodMarkers = 0;
        
        // Update ducats with magnet physics
        for (let i = 0; i < window.ducatPickups.length; i++) {
            const d = window.ducatPickups[i];
            if (d && typeof d.update === 'function') d.update(dt, [player]);
        }
        
        // Update blood markers with magnet physics
        for (let i = 0; i < window.bloodMarkerPickups.length; i++) {
            const m = window.bloodMarkerPickups[i];
            if (m && typeof m.update === 'function') m.update(dt, [player]);
        }
        
        // Check for pickup collisions with ducats
        for (let i = window.ducatPickups.length - 1; i >= 0; i--) {
            const d = window.ducatPickups[i];
            if (!d || d.pickupLockout > 0) continue;
            const dx = player.x - d.x;
            const dy = player.y - d.y;
            const dist = Math.hypot(dx, dy);
            if (dist < (player.radius || 26) + d.radius + 10) {
                // Request pickup from server
                if (window.networkManager && window.networkManager.connected && d._serverId) {
                    window.networkManager.socket.emit('inventoryPickupRequest', { id: d._serverId });
                    window.ducatPickups.splice(i, 1);
                }
            }
        }
        
        // Check for pickup collisions with blood markers
        for (let i = window.bloodMarkerPickups.length - 1; i >= 0; i--) {
            const m = window.bloodMarkerPickups[i];
            if (!m || m.pickupLockout > 0) continue;
            const dx = player.x - m.x;
            const dy = player.y - m.y;
            const dist = Math.hypot(dx, dy);
            if (dist < (player.radius || 26) + m.radius + 10) {
                // Request pickup from server
                if (window.networkManager && window.networkManager.connected && m._serverId) {
                    window.networkManager.socket.emit('inventoryPickupRequest', { id: m._serverId });
                    window.bloodMarkerPickups.splice(i, 1);
                }
            }
        }
    })();

    // Slow effect is now fully server-authoritative via playerSlowState events
    // The _svSlowed flag is set by the NetworkManager and used for movement prediction and VFX

	// Update Guard/Wave arrow fade based on distance to current objective
	(function updateArrowFade(){
		const fadeSeconds = 0.5;
		const rate = (fadeSeconds > 0) ? (1 / fadeSeconds) : 1;
		let desired = 0;
		if (modeTimer.currentName && (modeTimer.currentName.startsWith('Guard') || modeTimer.currentName.startsWith('Wave'))) {
                        // Determine target: unopened gold chest, else artifact on ground
                        const goldChest = chests.find(c => c && c.variant === 'gold');
                        let target = null;
                        if (goldChest) {
                                if (!goldChest.opened) target = { x: goldChest.x, y: goldChest.y };
                                else if (goldChest.artifact && !goldChest.artifact.carriedBy) target = { x: goldChest.artifact.x, y: goldChest.artifact.y };
                        }
                        if (target) {
                                const dx = target.x - player.x;
                                const dy = target.y - player.y;
                                const dist = Math.hypot(dx, dy);
                                desired = (dist > 500) ? 1 : 0;
                        }
                }
                // Lerp arrowAlpha toward desired at rate per second
                if (state.arrowAlpha < desired) {
                        state.arrowAlpha = Math.min(desired, state.arrowAlpha + rate * dt);
                } else if (state.arrowAlpha > desired) {
                        state.arrowAlpha = Math.max(desired, state.arrowAlpha - rate * dt);
                }
        })();

        // Each frame: determine the nearest equippable hex for tooltip purposes
        (function updateEquipHint() {
                // Suppress equip hint when inventory is full
                if (Array.isArray(player.inventory) && player.inventory.length >= 6) {
                        window.currentEquipHex = null;
                        return;
                }
                let best = null; let bestDist = Infinity;
                for (let i = 0; i < chests.length; i++) {
                        const c = chests[i];
                        if (!c || !Array.isArray(c.drops)) continue;
                        for (let j = 0; j < c.drops.length; j++) {
                                const h = c.drops[j];
                                if (!h || h.equippedBy || !h.onGround || typeof h.canEquip !== 'function') continue;
                                if (!h.canEquip(player)) continue;
                                const dx = h.x - player.x, dy = h.y - player.y; const d2 = dx * dx + dy * dy;
                                if (d2 < bestDist) { bestDist = d2; best = h; }
                        }
                }
                // Consider boss drops as well
                if (Array.isArray(window.bossDrops)) {
                        for (let k = 0; k < window.bossDrops.length; k++) {
                                const h = window.bossDrops[k];
                                if (!h || h.equippedBy || !h.onGround || typeof h.canEquip !== 'function') continue;
                                if (!h.canEquip(player)) continue;
                                const dx = h.x - player.x, dy = h.y - player.y; const d2 = dx * dx + dy * dy;
                                if (d2 < bestDist) { bestDist = d2; best = h; }
                        }
                }
                window.currentEquipHex = best;
        })();

        // Toggle extraction zone visibility based on artifact carried status
        (function updateExtractionVisibility(){
        if (scene.current !== 'level') { extractionZone = null; hereticExtractionZone = null; return; }
                const hasArtifact = chests.some(c => c && c.artifact && c.artifact.carriedBy);
                const artifactCarriedByAnyPlayer = hasArtifact || (window.networkManager && window.networkManager.artifactCarrierId != null);
                // Extraction zone is created by the server via artifactPickedUp event (server-authoritative)
                if (false) { // Disabled: extraction zones are server-authoritative only
                        // REMOVED: Client-side extraction zone creation (multiplayer-only)
                        try {
                                const { ExtractionZone } = window.GameObjects || {};
                                if (ExtractionZone) {
                                        const gold = chests.find(c => c && c.variant === 'gold');
                                        const refX = gold ? gold.x : player.x;
                                        const refY = gold ? gold.y : player.y;
                                        const minFar = 2800;
                                        const maxFar = 5200;
                                        const tries = 400;
                                        const clearance = 160;
                                        for (let i = 0; i < tries && !extractionZone; i++) {
                                                const ang = WorldRNG.randomFloat(0, Math.PI * 2);
                                        const dist = WorldRNG.randomFloat(minFar, maxFar);
                                        const nx = refX + Math.cos(ang) * dist;
                                        const ny = refY + Math.sin(ang) * dist;
                                        if (environment.isInsideBounds(nx, ny, clearance) && !environment.circleHitsAny(nx, ny, clearance)) {
                                                extractionZone = new ExtractionZone(nx, ny, 450);
                                                        // Expose a planned hint early so NPC spawner can avoid it pre-creation
                                                        window._plannedExtractionHint = { x: nx, y: ny };
                                                        break;
                                                }
                                }
                                if (!extractionZone) {
                                        extractionZone = new ExtractionZone(refX + 3600, refY + 3600, 450);
                                                window._plannedExtractionHint = { x: refX + 3600, y: refY + 3600 };
                                        }
                                }
                        } catch(e) {}
                }
                // Heretic zone is created by the server via artifactPickedUp event (server-authoritative)
                if (false) { // Disabled: heretic zones are server-authoritative only
                        try {
                                const converted = (typeof window !== 'undefined' && window.__killThemAllLocked === true);
                                const { HereticExtractionZone } = window.GameObjects || {};
                                if (converted && HereticExtractionZone) {
                                        const gold = chests.find(c => c && c.variant === 'gold');
                                        const refX = gold ? gold.x : player.x;
                                        const refY = gold ? gold.y : player.y;
                                        // Try to place roughly opposite the green zone for clarity
                                        let baseX = refX + 3800, baseY = refY - 3600;
                                        let placed = false;
                                        const minFarFromGreen = 2200;
                                        const minFarFromGold = 2200;
                                        const minFarFromBoss = 2200;
                                        for (let i = 0; i < 600 && !placed; i++) {
                                                const ang = WorldRNG.randomFloat(0, Math.PI * 2);
                                                const dist = WorldRNG.randomFloat(3000, 5400);
                                                const nx = baseX + Math.cos(ang) * dist;
                                                const ny = baseY + Math.sin(ang) * dist;
                                                if (!environment.isInsideBounds(nx, ny, 160)) continue;
                                                if (environment.circleHitsAny(nx, ny, 160)) continue;
                                                // keep it far from normal extraction if exists
                                                let ok = true;
                                                if (extractionZone) {
                                                        const dx = nx - extractionZone.x; const dy = ny - extractionZone.y;
                                                        ok = ok && (dx*dx + dy*dy) >= (minFarFromGreen * minFarFromGreen);
                                                }
                                                // keep it far from golden chest
                                                if (ok && gold) {
                                                        const dxg = nx - gold.x; const dyg = ny - gold.y;
                                                        ok = ok && (dxg*dxg + dyg*dyg) >= (minFarFromGold * minFarFromGold);
                                                }
                                                // keep it far from boss if already spawned
                                                if (ok) {
                                                        try {
                                                                for (let ei = 0; ei < enemies.items.length; ei++) {
                                                                        const e = enemies.items[ei];
                                                                        if (e && e.alive && window.ArtilleryWitch && (e instanceof window.ArtilleryWitch)) {
                                                                                const dxb = nx - e.x; const dyb = ny - e.y;
                                                                                if (dxb*dxb + dyb*dyb < (minFarFromBoss * minFarFromBoss)) { ok = false; break; }
                                                                        }
                                                                }
                                                        } catch(_) {}
                                                }
                                                if (ok) {
                                                        hereticExtractionZone = new HereticExtractionZone(nx, ny, 300);
                                                        placed = true;
                                                }
                                        }
                                        if (!placed) {
                                                // Fallback: offset far in another quadrant but still enforce basic spacing where possible
                                                let fx = refX - 3600, fy = refY - 3600;
                                                if (extractionZone) {
                                                        const dx = fx - extractionZone.x; const dy = fy - extractionZone.y;
                                                        if (dx*dx + dy*dy < (minFarFromGreen * minFarFromGreen)) { fx += 2600; fy -= 2600; }
                                                }
                                                if (gold) {
                                                        const dxg = fx - gold.x; const dyg = fy - gold.y;
                                                        if (dxg*dxg + dyg*dyg < (minFarFromGold * minFarFromGold)) { fx -= 2400; fy += 2000; }
                                                }
                                                hereticExtractionZone = new HereticExtractionZone(fx, fy, 300);
                                        }
                                }
                        } catch(_) {}
                }
                // Visible states
                if (extractionZone) {
                        let artifactInZone = false;
                        if (!extractionZone.extracted) {
                                for (let i = 0; i < chests.length; i++) {
                                        const a = chests[i]?.artifact;
                                        if (!a) continue;
                                        const half = (extractionZone.size || 300) / 2;
                                        const ax = a.carriedBy ? a.carriedBy.x : a.x;
                                        const ay = a.carriedBy ? a.carriedBy.y : a.y;
                                        if (ax >= extractionZone.x - half && ax <= extractionZone.x + half && ay >= extractionZone.y - half && ay <= extractionZone.y + half) {
                                                artifactInZone = true;
                                        }
                                        break;
                                }
                        }
                        extractionZone.visible = (!extractionZone.extracted) && (artifactCarriedByAnyPlayer || artifactInZone);
                        // If converted and holding the artifact, hide the normal extraction zone
                        try { if (typeof window !== 'undefined' && window.__killThemAllLocked === true && hasArtifact) extractionZone.visible = false; } catch(_) {}
                }
                if (hereticExtractionZone) {
                        let artifactInZone = false;
                        if (!hereticExtractionZone.extracted) {
                                for (let i = 0; i < chests.length; i++) {
                                        const a = chests[i]?.artifact;
                                        if (!a) continue;
                                        const half = (hereticExtractionZone.size || 300) / 2;
                                        const ax = a.carriedBy ? a.carriedBy.x : a.x;
                                        const ay = a.carriedBy ? a.carriedBy.y : a.y;
                                        if (ax >= hereticExtractionZone.x - half && ax <= hereticExtractionZone.x + half && ay >= hereticExtractionZone.y - half && ay <= hereticExtractionZone.y + half) {
                                                artifactInZone = true;
                                        }
                                        break;
                                }
                        }
                        const converted = (typeof window !== 'undefined' && window.__killThemAllLocked === true);
                        // Heretic zone visible when: evil player has artifact (for all to see), or local converted player has it
                        let evilPlayerHasArtifact = false;
                        if (window.networkManager && window.networkManager.artifactCarrierId) {
                                const carrierId = window.networkManager.artifactCarrierId;
                                if (carrierId === window.networkManager.playerId) {
                                        evilPlayerHasArtifact = converted; // Local player has it and is evil
                                } else {
                                        // Check if remote carrier is evil
                                        const otherPlayers = window.networkManager.getOtherPlayers?.() || [];
                                        const carrier = otherPlayers.find(p => p.id === carrierId);
                                        evilPlayerHasArtifact = carrier && carrier.evilLocked;
                                }
                        } else if (artifactCarriedByAnyPlayer && converted) {
                                evilPlayerHasArtifact = true; // Singleplayer: local converted player has it
                        }
                        hereticExtractionZone.visible = (!hereticExtractionZone.extracted) && evilPlayerHasArtifact;
                }
                // Now that we know the actual zone positions, relocate NPCs if necessary once
                try { if (typeof window._relocateNPCsIfNeeded === 'function') window._relocateNPCsIfNeeded(); } catch(_) {}
        })();

        // Boss is spawned by the server via artifactPickedUp event (server-authoritative)
        (function maybeSpawnBossAfterArtifact(){
                if (false) { // Disabled: boss spawning is server-authoritative only
                        // Defer until extraction zone exists so we can respect its distance
                        if (extractionZone) spawnBossFarFromPlayerAndExtraction();
                        // After spawn, ensure NPC not near boss
                        try { if (typeof window._relocateNPCsIfNeeded === 'function') window._relocateNPCsIfNeeded(); } catch(_) {}
                }
        })();

        // Capture E press for this frame
        const __pressedE = state.justPressedKeyE === true;
        // If E was pressed, pick the single closest interaction (chest, artifact or hex) and perform it
        if (state.justPressedKeyE) {
                // Revive start: prioritize downed teammate in range (start channel; must hold E for 4 seconds)
                try {
                        if (window.networkManager?.connected) {
                                const otherPlayers = window.networkManager.getOtherPlayers?.() || [];
                                const REVIVE_R = 80;
                                const r2 = REVIVE_R * REVIVE_R;
                                let best = null;
                                let bestD2 = Infinity;
                                for (let i = 0; i < otherPlayers.length; i++) {
                                        const op = otherPlayers[i];
                                        if (!op) continue;
                                        if (!(op.health <= 0)) continue; // downed
                                        const downedAt = Number(op.downedAt) || 0;
                                        if (!downedAt) continue;
                                        if ((Date.now() - downedAt) > 30000) continue; // 30s to start revive
                                        // If revive is already ready (waiting for the downed player to accept), don't restart
                                        if ((Number(op.reviveReadyUntil) || 0) > Date.now()) continue;
                                        // If already being revived, don't attempt another channel (server will enforce too)
                                        if ((op.reviveProgress || 0) > 0) continue;
                                        const dx = op.x - player.x;
                                        const dy = op.y - player.y;
                                        const d2 = dx * dx + dy * dy;
                                        if (d2 <= r2 && d2 < bestD2) { bestD2 = d2; best = op; }
                                }
                                if (best) {
                                        window.networkManager.socket.emit('reviveStartRequest', { targetId: best.id });
                                        state.justPressedKeyE = false;
                                        return;
                                }
                        }
                } catch(_) {}

                let best = null;
                let bestDist = Infinity;
                let bestArtifact = null;
                let bestArtifactDist = Infinity;
                // In lobby: consider ReadyZone interaction only
                if (scene.current === 'lobby') {
                        // Create a single ReadyZone at lobby center if not present (draw/update later in render)
                        if (!window._readyZone && window.GameObjects && window.GameObjects.ReadyZone) {
                                window._readyZone = new window.GameObjects.ReadyZone(0, 0, 300);
                        }
                        if (window._readyZone && window._readyZone._isPlayerNearCenter && window._readyZone._isPlayerNearCenter(player)) {
                                best = { type: 'ready' };
                                bestDist = 0;
                        }
                }
                // Candidate: talk to nearest NPC in range
                (function considerNpcTalk(){
                        try {
                                let nearest = null; let d2best = Infinity;
                                for (let i = 0; i < npcs.items.length; i++) {
                                        const n = npcs.items[i];
                                        if (!n || !n.alive) continue;
                                        // Disable talking if NPC has disabled talk (e.g., after following)
                                        if (n._disableTalk || n.state === 'follow') continue;
                                        const dx = n.x - player.x, dy = n.y - player.y;
                                        const d2 = dx*dx + dy*dy;
                                        let talkR = (n.radius || 24) + (player.radius || 26) + 36;
                                        // Merchant (and others) can specify a talk range boost
                                        try { if (typeof n.talkRangeBoost === 'number') talkR += Math.max(0, n.talkRangeBoost); } catch(_) {}
                                        if (d2 <= talkR * talkR && d2 < d2best) { d2best = d2; nearest = n; }
                                }
                                if (nearest && nearest.state !== 'follow') {
                                        best = { type: 'npc_talk', npc: nearest };
                                        bestDist = d2best;
                                }
                        } catch(_) {}
                })();
                for (let i = 0; i < chests.length; i++) {
                        const c = chests[i];
                        // Candidate: chest open (when in proximity and not opened)
                        if (c && !c.opened) {
                                const dxC = c.x - player.x;
                                const dyC = c.y - player.y;
                                const canOpenDist = Math.pow((player.radius || 18) + (c.radius || 20) + 30, 2);
                                const d2C = dxC * dxC + dyC * dyC;
                                if (d2C <= canOpenDist) {
                                        if (d2C < bestDist) { bestDist = d2C; best = { type: 'chest', chest: c }; }
                                }
                        }
                        // Candidate: artifact pickup (track separately to prioritize)
                        if (c && c.artifact && !c.artifact.carriedBy && typeof c.artifact.canPickUp === 'function') {
                                if (c.artifact.canPickUp(player)) {
                                        const dx = c.artifact.x - player.x;
                                        const dy = c.artifact.y - player.y;
                                        const d2 = dx * dx + dy * dy;
                                        if (d2 < bestArtifactDist) { bestArtifactDist = d2; bestArtifact = { type: 'artifact', chest: c, item: c.artifact }; }
                                        // Also consider for general best to keep behavior consistent if no higher-priority candidate appears
                                        if (d2 < bestDist) { bestDist = d2; best = { type: 'artifact', chest: c, item: c.artifact }; }
                                }
                        }
                        // Candidates: hex stats equip
                        if (c && Array.isArray(c.drops)) {
                                for (let j = 0; j < c.drops.length; j++) {
                                        const h = c.drops[j];
                                        if (h && !h.equippedBy && typeof h.canEquip === 'function' && h.canEquip(player)) {
                                                const dx = h.x - player.x;
                                                const dy = h.y - player.y;
                                                const d2 = dx * dx + dy * dy;
                                                if (d2 < bestDist) { bestDist = d2; best = { type: 'hex', chest: c, item: h, index: j }; }
                                        }
                                }
                        }
                }
                // Consider extraction zone start interaction
                if (extractionZone && extractionZone.visible && !extractionZone.started && !extractionZone.extracted) {
                        if (extractionZone._isPlayerNearCenter && extractionZone._isPlayerNearCenter(player)) {
                                const dx = extractionZone.x - player.x;
                                const dy = extractionZone.y - player.y;
                                const d2 = dx * dx + dy * dy;
                                if (d2 < bestDist) { bestDist = d2; best = { type: 'extract' }; }
                        }
                }
                // Consider heretic extraction zone start interaction
                if (hereticExtractionZone && hereticExtractionZone.visible && !hereticExtractionZone.started && !hereticExtractionZone.extracted) {
                        if (hereticExtractionZone._isPlayerNearCenter && hereticExtractionZone._isPlayerNearCenter(player)) {
                                const dx = hereticExtractionZone.x - player.x;
                                const dy = hereticExtractionZone.y - player.y;
                                const d2 = dx * dx + dy * dy;
                                if (d2 < bestDist) { bestDist = d2; best = { type: 'extract_heretic' }; }
                        }
                }
                // Candidates: boss loot hexes
                if (Array.isArray(window.bossDrops)) {
                        for (let j = 0; j < window.bossDrops.length; j++) {
                                const h = window.bossDrops[j];
                                if (h && !h.equippedBy && typeof h.canEquip === 'function' && h.canEquip(player)) {
                                        const dx = h.x - player.x;
                                        const dy = h.y - player.y;
                                        const d2 = dx * dx + dy * dy;
                                        if (d2 < bestDist) { bestDist = d2; best = { type: 'hex_boss', item: h, index: j }; }
                                }
                        }
                }
                // Candidates: battery pickup (RadioTower power system)
                let carryingBatteryId = null;
                if (Array.isArray(window._batteries)) {
                        for (let j = 0; j < window._batteries.length; j++) {
                                const bat = window._batteries[j];
                                if (!bat) continue;
                                // Check if local player is already carrying this battery
                                if (bat.carriedBy === window.networkManager?.playerId) {
                                        carryingBatteryId = bat.id;
                                }
                                // Check for pickup candidate
                                if (bat.onGround && !bat.carriedBy && bat.slotIndex === null && typeof bat.canPickUp === 'function') {
                                        if (bat.canPickUp(player)) {
                                                const dx = bat.x - player.x;
                                                const dy = bat.y - player.y;
                                                const d2 = dx * dx + dy * dy;
                                                if (d2 < bestDist) { bestDist = d2; best = { type: 'battery_pickup', battery: bat }; }
                                        }
                                }
                        }
                }
                // Candidates: battery place in station slot (when carrying a battery)
                if (carryingBatteryId && window._batteryStation) {
                        const station = window._batteryStation;
                        if (station.isPlayerNearStation && station.isPlayerNearStation(player)) {
                                const emptySlot = station.getFirstEmptySlotNearPlayer ? station.getFirstEmptySlotNearPlayer(player) : -1;
                                if (emptySlot >= 0) {
                                        const slotPos = station.getSlotPosition(emptySlot);
                                        const dx = slotPos.x - player.x;
                                        const dy = slotPos.y - player.y;
                                        const d2 = dx * dx + dy * dy;
                                        // Prioritize placing battery over other interactions when near station
                                        if (d2 < bestDist + 10000) { bestDist = d2; best = { type: 'battery_place', batteryId: carryingBatteryId, slotIndex: emptySlot }; }
                                }
                        }
                }
                // Check if player is carrying artifact (for swap logic)
                let carryingArtifact = false;
                let carriedArtifactChest = null;
                for (let i = 0; i < chests.length; i++) {
                        const c = chests[i];
                        if (c && c.artifact && c.artifact.carriedBy) {
                                carryingArtifact = true;
                                carriedArtifactChest = c;
                                break;
                        }
                }
                
                // Prioritize artifact pickup over other interactions if available
                if (bestArtifact) {
                        best = bestArtifact;
                }
                if (best) {
                        if (best.type === 'chest') {
                                best.chest.tryOpen(player, true);
                        }
                        if (best.type === 'artifact') {
                                // If carrying a battery, drop it first (swap)
                                if (carryingBatteryId && window.networkManager?.connected) {
                                        window.networkManager.socket.emit('batteryDropRequest', { 
                                                batteryId: carryingBatteryId, 
                                                x: player.x, 
                                                y: player.y 
                                        });
                                }
                                // Server-authoritative pickup when in multiplayer
                                try {
                                        if (window.networkManager?.connected) {
                                                const id = best.chest._id || (best.chest._id = `${Math.round(best.chest.x)},${Math.round(best.chest.y)}`);
                                                window.networkManager.socket.emit('artifactPickupRequest', { chestId: id });
                                        } else {
                                                best.item.carriedBy = player;
                                                state.artifactEverPicked = true;
                                        }
                                } catch(_) {
                                        best.item.carriedBy = player;
                                        state.artifactEverPicked = true;
                                }
                        } else if (best.type === 'battery_pickup') {
                                // If carrying an artifact, drop it first (swap)
                                if (carryingArtifact && carriedArtifactChest && window.networkManager?.connected) {
                                        const artifactChestId = carriedArtifactChest._id || (carriedArtifactChest._id = `${Math.round(carriedArtifactChest.x)},${Math.round(carriedArtifactChest.y)}`);
                                        window.networkManager.socket.emit('artifactDropRequest', { 
                                                chestId: artifactChestId, 
                                                x: player.x, 
                                                y: player.y 
                                        });
                                }
                                // Server-authoritative battery pickup
                                try {
                                        if (window.networkManager?.connected) {
                                                window.networkManager.socket.emit('batteryPickupRequest', { batteryId: best.battery.id });
                                        }
                                } catch(e) {
                                        console.error('[Battery] Pickup request error:', e);
                                }
                        } else if (best.type === 'battery_place') {
                                // Server-authoritative battery placement
                                try {
                                        if (window.networkManager?.connected) {
                                                window.networkManager.socket.emit('batteryPlaceRequest', { 
                                                        batteryId: best.batteryId, 
                                                        slotIndex: best.slotIndex 
                                                });
                                        }
                                } catch(e) {
                                        console.error('[Battery] Place request error:', e);
                                }
                        } else if (best.type === 'hex' || best.type === 'hex_boss') {
                                // Treat all hex items, including Health, as inventory items
                                if (!Array.isArray(player.inventory)) player.inventory = [];
                                if (player.inventory.length < 6) {
                                        // Server-authoritative pickup of ground items if they have a server id
                                        try {
                                                if (window.networkManager?.connected && best.item && best.item._serverId) {
                                                        window.networkManager.socket.emit('inventoryPickupRequest', { id: best.item._serverId });
                                                        // Locally remove from ground immediately for responsiveness
                                                        if (Array.isArray(window.bossDrops)) {
                                                                const idx = window.bossDrops.indexOf(best.item);
                                                                if (idx !== -1) window.bossDrops.splice(idx, 1);
                                                        }
                                                }
                                        } catch(_) {}
                                        best.item.equippedBy = player;
                                        player.inventory.push(best.item);
                                        bumpInv(player);
                                        // Remove from bossDrops if applicable (non-networked)
                                        if (best.type === 'hex_boss' && Array.isArray(window.bossDrops)) {
                                                const idx = window.bossDrops.indexOf(best.item);
                                                if (idx !== -1) window.bossDrops.splice(idx, 1);
                                        }
                                } else {
                                        // Inventory full: show message over item
                                        if (typeof best.item === 'object') best.item.fullMsgTimer = 1.5;
                                }
                        } else if (best.type === 'extract') {
                                if (extractionZone) {
                                        // Converted players cannot start the normal extraction; they must use the heretic zone
                                        let convertedBlock = false; try { convertedBlock = (typeof window !== 'undefined' && window.__killThemAllLocked === true); } catch(_) {}
                                        if (!convertedBlock) {
                                                // Trigger NPC betrayal immediately if following when extraction is started by E
                                                try {
                                                        if (npcs && Array.isArray(npcs.items)) {
                                                                for (let i = 0; i < npcs.items.length; i++) {
                                                                        const n = npcs.items[i];
                                                                        if (n && n.alive && n.name === 'NPC_A' && n.state === 'follow' && typeof n.switchState === 'function') {
                                                                                n.switchState('betrayed');
                                                                        }
                                                                }
                                                        }
                                                } catch(_) {}
                                                extractionZone.tryStart(player, true);
                                        }
                                }
                        } else if (best.type === 'extract_heretic') {
                                if (hereticExtractionZone) {
                                        // Only allow converted/evil players to start heretic extraction
                                        let convertedBlock = false; 
                                        try { convertedBlock = !(typeof window !== 'undefined' && window.__killThemAllLocked === true); } catch(_) {}
                                        if (!convertedBlock) {
                                                hereticExtractionZone.tryStart(player, true);
                                        }
                                        // Message is handled by HereticExtractionZone class
                                }
                        } else if (best.type === 'ready') {
                                if (window._readyZone && typeof window._readyZone.tryStart === 'function') window._readyZone.tryStart(player, true);
                        } else if (best.type === 'npc_talk') {
                                (async () => {
                                        try {
                                                const npcName = best.npc?.name || 'NPC';
                                                const key = String(npcName).replace(/\s+/g, '_');
                                                const data = await dialogueLoader.load(key, 'start');
                                                if (dialogue && typeof dialogue.openWith === 'function') {
                                                        // Quartermaster: choose start node based on whether the one-time supplies were already granted
                                                        let startKey = data?.start || 'start';
                                                        try {
                                                                if (npcName === 'Quartermaster') {
                                                                        const granted = !!(window.dialogueFlags && window.dialogueFlags.qmGrantedSupplies);
                                                                        startKey = granted ? 'start_repeat' : 'start_first';
                                                                }
                                                        } catch(_) {}
                                                        const payload = (data && data.nodes)
                                                                ? { title: data.title || npcName, nodes: data.nodes, start: startKey }
                                                                : { title: data?.title || npcName, lines: Array.isArray(data?.lines) ? data.lines : [] };
                                                        dialogue.openWith(payload);
                                                        try { 
                                                                dialogue.npcId = best.npc?.id; 
                                                                dialogue.npc = best.npc; // Store full NPC reference for multiplayer state changes
                                                        } catch(_) { 
                                                                dialogue.npcId = null; 
                                                                dialogue.npc = null;
                                                        }
                                                }
                                        } catch(e) {
                                                console.error('[Main] Failed to open NPC dialogue:', e);
                                                if (dialogue && typeof dialogue.openWith === 'function') {
                                                        const npcName = best.npc?.name || 'NPC';
                                                        dialogue.openWith({ title: npcName, lines: ["..."] });
                                                        try { 
                                                                dialogue.npcId = best.npc?.id; 
                                                                dialogue.npc = best.npc; // Store full NPC reference for multiplayer state changes
                                                        } catch(_) { 
                                                                dialogue.npcId = null;
                                                                dialogue.npc = null; 
                                                        }
                                                }
                                        }
                                })();
                        }
                }
                state.justPressedKeyE = false;
        }
        // Chest interactions and updates (use cached E press)
        // Determine player's current aim angle for carrying offset (used by chests and batteries)
        const screenX = player.x - state.cameraX;
        const screenY = player.y - state.cameraY;
        const dxAim = state.mouse.x - screenX;
        const dyAim = state.mouse.y - screenY;
        const aimAngle = Math.atan2(dyAim, dxAim);
        
        for (let i = 0; i < chests.length; i++) {
                const c = chests[i];
            if (!c.opened) c.tryOpen(player, __pressedE);
                c.update(dt, environment, player, aimAngle);
                // (E press is handled globally for closest item; nothing else to do here)
        }
        
        // Update batteries (for following player when carried)
        const batteries = window._batteries || [];
        for (let i = 0; i < batteries.length; i++) {
                const bat = batteries[i];
                if (bat && typeof bat.update === 'function') {
                        bat.update(dt, player, aimAngle);
                }
        }
        
        // Update battery station
        if (window._batteryStation && typeof window._batteryStation.update === 'function') {
                window._batteryStation.update(dt);
        }
        
        state.justPressedKeyE = false;

        // Handle inventory click interactions (drop carried items)
        if (state.justPressed) {
                const margin = 16;
                const hasArtifact = chests.some(c => c && c.artifact && c.artifact.carriedBy);
                // Check for carried battery
                let hasBattery = false;
                let carriedBatteryObj = null;
                const batteriesForClick = window._batteries || [];
                for (let bi = 0; bi < batteriesForClick.length; bi++) {
                        if (batteriesForClick[bi] && batteriesForClick[bi].carriedBy === window.networkManager?.playerId) {
                                hasBattery = true;
                                carriedBatteryObj = batteriesForClick[bi];
                                break;
                        }
                }
                const hasSpecialItem = hasArtifact || hasBattery;
                const invCount = hasSpecialItem ? 7 : 6;
                const slotSize = 56;
                const gap = 10;
                const totalH = invCount * slotSize + (invCount - 1) * gap;
                const startY = Math.max(margin, Math.round((state.viewportHeight - totalH) / 2));
                const x = margin;
                const mx = state.mouse.x;
                const my = state.mouse.y;
                let clickedIndex = -1;
                for (let i = 0; i < invCount; i++) {
                        const y = startY + i * (slotSize + gap);
                        if (mx >= x && mx <= x + slotSize && my >= y && my <= y + slotSize) { clickedIndex = i; break; }
                }
                if (clickedIndex !== -1) {
                        // If clicked the special item slot (artifact or battery), drop it
                        if (hasSpecialItem && clickedIndex === invCount - 1) {
                                // Compute drop position behind player
                                const screenX = player.x - state.cameraX;
                                const screenY = player.y - state.cameraY;
                                const dxAim = state.mouse.x - screenX;
                                const dyAim = state.mouse.y - screenY;
                                const aimAngle = Math.atan2(dyAim, dxAim);
                                const backAng = aimAngle + Math.PI;
                                const dist = (player.radius || 26) + 20;
                                const dropX = player.x + Math.cos(backAng) * dist;
                                const dropY = player.y + Math.sin(backAng) * dist;
                                
                                if (hasArtifact) {
                                        // Drop artifact
                                        for (let i = 0; i < chests.length; i++) {
                                                const art = chests[i]?.artifact;
                                                if (art && art.carriedBy) {
                                                        try {
                                                                if (window.networkManager?.connected) {
                                                                        const id = chests[i]._id || (chests[i]._id = `${Math.round(chests[i].x)},${Math.round(chests[i].y)}`);
                                                                        window.networkManager.socket.emit('artifactDropRequest', { chestId: id, x: dropX, y: dropY, vx: 0, vy: 0 });
                                                                } else {
                                                                        art.x = dropX; art.y = dropY;
                                                                        art.vx = 0; art.vy = 0;
                                                                        art.onGround = true;
                                                                        art.carriedBy = null;
                                                                        art.pickupLockout = Math.max(0.15, art.pickupLockout || 0.15);
                                                                }
                                                        } catch(_) {
                                                                art.x = dropX; art.y = dropY;
                                                                art.vx = 0; art.vy = 0;
                                                                art.onGround = true;
                                                                art.carriedBy = null;
                                                                art.pickupLockout = Math.max(0.15, art.pickupLockout || 0.15);
                                                        }
                                                        break;
                                                }
                                        }
                                } else if (hasBattery && carriedBatteryObj) {
                                        // Drop battery
                                        try {
                                                if (window.networkManager?.connected) {
                                                        window.networkManager.socket.emit('batteryDropRequest', { 
                                                                batteryId: carriedBatteryObj.id, 
                                                                x: dropX, 
                                                                y: dropY 
                                                        });
                                                }
                                        } catch(e) {
                                                console.error('[Battery] Drop request error:', e);
                                        }
                                }
                        }
                        // If clicked within first 6 slots: drop an inventory item onto the ground via server
                        const firstEquippedIdx = 0;
                        const equippedCount = Math.max(0, Math.min(6, (player.inventory || []).length));
                        if (clickedIndex >= firstEquippedIdx && clickedIndex < firstEquippedIdx + equippedCount) {
                                const idx = clickedIndex - firstEquippedIdx;
                                const item = (player.inventory || [])[idx];
                                if (item) {
                                        // Compute a clear forward drop point and radial spread
                                        const screenX = player.x - state.cameraX;
                                        const screenY = player.y - state.cameraY;
                                        const dxAim = state.mouse.x - screenX;
                                        const dyAim = state.mouse.y - screenY;
                                        const aimAngle = Math.atan2(dyAim, dxAim);
                                        const fwdAng = aimAngle;
                                        const dist = (player.radius || 26) + 24;
                                        const dropX = player.x + Math.cos(fwdAng) * dist;
                                        const dropY = player.y + Math.sin(fwdAng) * dist;
                                        // Server-authoritative drop of inventory items
                                        try {
                                                if (window.networkManager?.connected) {
						const payload = { items: [{ 
							label: item.baseLabel || item.label, 
							rarityName: (item.rarity && item.rarity.name) || 'Common', 
							color: (item.rarity && item.rarity.color) || item.fill || '#ffffff',
							statKey: item.statKey,
							bonusValue: item.bonusValue,
							isPercent: item.isPercent,
							rarity: item.rarity,
							suppressHealForPlayerId: item.suppressHealForPlayerId
						}], x: dropX, y: dropY, baseAngle: fwdAng, speed: 200 };
						window.networkManager.socket.emit('inventoryDropRequest', payload);
                                                        // Remove locally from inventory immediately for responsiveness
                                                        player.inventory.splice(idx, 1);
                                                        bumpInv(player);
                                                } else {
                                                        // Offline fallback: local drop
                                                        item.x = dropX; item.y = dropY;
                                                        item.vx = Math.cos(fwdAng) * 200; item.vy = Math.sin(fwdAng) * 200 - 160;
                                                        item.onGround = false;
                                                        item.equippedBy = null;
                                                        if (item && item.statKey === 'Health' && player && typeof player.id === 'number') { item.suppressHealForPlayerId = player.id; }
                                                        item.pickupLockout = Math.max(0.25, item.pickupLockout || 0.25);
                                                        placeDroppedItemInWorld(item);
                                                        player.inventory.splice(idx, 1);
                                                        bumpInv(player);
                                                }
                                        } catch(_) {
                                                item.x = dropX; item.y = dropY;
                                                item.vx = Math.cos(fwdAng) * 200; item.vy = Math.sin(fwdAng) * 200 - 160;
                                                item.onGround = false;
                                                item.equippedBy = null;
                                                if (item && item.statKey === 'Health' && player && typeof player.id === 'number') { item.suppressHealForPlayerId = player.id; }
                                                item.pickupLockout = Math.max(0.25, item.pickupLockout || 0.25);
                                                placeDroppedItemInWorld(item);
                                                player.inventory.splice(idx, 1);
                                                bumpInv(player);
                                        }
                                }
                        }
                }
        }

        // Player damage-over-time when overlapping enemies: 10 HP/sec per enemy contact (only when alive)
	// In multiplayer, detect damage for effects but don't modify health (server handles it)
        if (!state.isFrozen && player.health > 0) {
                // Expand search to account for special reach enemies (e.g., Licker at 75)
                const searchRadius = Math.max(player.radius + 34, player.radius + 75);
                const nearby = enemies.queryCircle ? enemies.queryCircle(player.x, player.y, searchRadius) : enemies.items || [];
		let totalDamage = 0;
		let lickerDamage = 0;
                for (let i = 0; i < nearby.length; i++) {
                        const e = nearby[i];
                        if (!e || !e.alive) continue;
                        // Training dummy and any non-contact enemies should never trigger player contact damage VFX
                        if (e._contactDisabled === true || e.type === 'targetDummy' || e.isTargetDummy) continue;
                        // Friendly structures should never trigger player "taking damage" indicators
                        if (e.type === 'defenseTurret' || e.type === 'artilleryGun' || e.isFriendly === true) continue;
                        const dx = e.x - player.x;
                        const dy = e.y - player.y;
                        let inRange = false;
                        try {
                                if (window.Licker && e instanceof window.Licker) {
                                        // Only damage if THIS Licker currently ensnares the player
                                        const tThis = (player._ensnaredBy && player._ensnaredBy.get) ? (player._ensnaredBy.get(e.id) || 0) : 0;
                                        const ensnarerOk = tThis > 0;
                                        if (ensnarerOk) {
                                                const lr = player.radius + 75;
                                                inRange = (dx * dx + dy * dy) <= (lr * lr);
                                        } else {
                                                inRange = false;
                                        }
                                } else {
                                        const sumR = (e.radius || 0) + player.radius;
                                        inRange = (dx * dx + dy * dy) <= (sumR * sumR);
                                }
                        } catch(_) {
                                const sumR = (e.radius || 0) + player.radius;
                                inRange = (dx * dx + dy * dy) <= (sumR * sumR);
                        }
		if (inRange) {
			const dmg = 10 * dt;
			totalDamage += dmg;
			if (window.Licker && e instanceof window.Licker) {
				lickerDamage += dmg;
			}
		}
                }
		if (totalDamage > 0) {
                        // Apply armor reduction (cap 75%)
			let reduced = totalDamage;
			try {
				if (player && typeof player.getArmorReductionFactor === 'function') {
					const red = Math.max(0, Math.min(0.75, player.getArmorReductionFactor()));
					reduced = totalDamage * (1 - red);
				}
			} catch(_) {}

			// Damage is server-authoritative in multiplayer (do not apply locally)
			// Local damage removed - server handles all health changes
			
			// Trigger ALL visual effects (skip during dash invulnerability)
			const isDashing = player.dashActive && player.dashDuration > 0;
			
			// Hit flash
                        try {
                                if (!isDashing && player && typeof player.hitFlashMax === 'number') {
                                        const canFlash = (!player.hitFlash || player.hitFlash <= 0) && (!player.hitFlashCooldown || player.hitFlashCooldown <= 0);
                                        if (canFlash) {
                                                player.hitFlash = player.hitFlashMax;
                                                player.hitFlashCooldown = player.hitFlashGap || 0.07;
                                        }
                                }
                        } catch(_) {}
			
			// Queue damage event for shake/vignette processing (processed in update loop)
			if (!isDashing) {
				let shakeScale = 1;
				if (totalDamage > 0) {
					const armorFactor = reduced / totalDamage;
					const reducedLicker = lickerDamage * armorFactor;
					const reducedOther = Math.max(0, reduced - reducedLicker);
					const shakeEnergy = reducedOther + reducedLicker * 2;
					if (reduced > 0 && shakeEnergy > 0) {
						shakeScale = shakeEnergy / reduced;
					}
				}
				const source = lickerDamage > 0 ? 'contact-licker' : 'contact';
				window.enqueueDamageEvent(reduced, { source, shakeScale });
			}
			
			// Mark that we detected contact damage
			detectedContactDamage = true;
			
			// Death handling is server-authoritative (client-side death removed for multiplayer-only)
			if (false) { // Disabled: death handling is server-authoritative
                                player.health = 0;
                                state.deathTimer = 5.0; // seconds until respawn
                                // On death by enemy contact, drop carried artifact with a small toss
                                for (let i = 0; i < chests.length; i++) {
                                        const art = chests[i]?.artifact;
                                        if (art && art.carriedBy) {
                                                const screenX = player.x - state.cameraX;
                                                const screenY = player.y - state.cameraY;
                                                const dxAim = state.mouse.x - screenX;
                                                const dyAim = state.mouse.y - screenY;
                                                let aimAngle = Math.atan2(dyAim, dxAim);
                                                aimAngle += (Math.random() * 0.6 - 0.3);
                                                const horizSpeed = 140;
                                                const lift = 200;
                                                const artSpawnDist = (player.radius || 26) + 18 + 40; // outside the inventory drop ring
                                                art.x = player.x + Math.cos(aimAngle) * artSpawnDist;
                                                art.y = player.y + Math.sin(aimAngle) * artSpawnDist;
                                                art.vx = Math.cos(aimAngle) * horizSpeed;
                                                art.vy = Math.sin(aimAngle) * horizSpeed - lift;
                                                art.onGround = false;
                                                art.carriedBy = null;
                                                art.pickupLockout = Math.max(0.15, art.pickupLockout || 0.15);
                                        }
                                }
                                // Also drop equipped items from inventory with a radial toss and offset ring to avoid overlap with artifact
                                if (Array.isArray(player.inventory) && player.inventory.length > 0) {
                                        const count = player.inventory.length;
                                        // Base opposite of aim to avoid forward sector where the artifact is tossed
                                        const base = (Math.atan2(state.mouse.y - (player.y - state.cameraY), state.mouse.x - (player.x - state.cameraX)) + Math.PI) || 0;
                                        const spawnRing = (player.radius || 26) + 18;
                                        for (let k = player.inventory.length - 1; k >= 0; k--) {
                                                const item = player.inventory[k];
                                                if (!item) { player.inventory.splice(k, 1); bumpInv(player); continue; }
                                                const ang = base + (k * (2 * Math.PI / Math.max(1, count)));
                                                const spd = 170 + Math.random() * 60;
                                                const lift2 = 160;
                                                item.x = player.x + Math.cos(ang) * spawnRing;
                                                item.y = player.y + Math.sin(ang) * spawnRing;
                                                item.vx = Math.cos(ang) * spd;
                                                item.vy = Math.sin(ang) * spd - lift2;
                                                item.onGround = false;
                                                if (item.equippedBy) item.equippedBy = null;
                                                if (item && item.statKey === 'Health' && player && typeof player.id === 'number') { item.suppressHealForPlayerId = player.id; }
                                                item.pickupLockout = Math.max(0.25, item.pickupLockout || 0.25);
                                                placeDroppedItemInWorld(item);
                                                player.inventory.splice(k, 1);
                                                bumpInv(player);
                                        }
                                }
                        }
                }
        }

        // Bullet vs enemy hits
        // Do a simple check: if bullet overlaps enemy, apply damage and remove bullet
        // Optimized: use spatial hash query and cap cone VFX per bullet to prevent spikes
        // Throttle non-critical bullet collision extras (observer-only hit removal, troop/turret visual hit removal)
        // to ~30Hz to reduce worst-case spikes while keeping local-player hits responsive every frame.
        if (state) {
                state._nonCriticalBulletCollAcc = (state._nonCriticalBulletCollAcc || 0) + dt;
        }
        const __nonCriticalInterval = (1 / 30);
        const __doNonCriticalBulletColl = !!(state && (state._nonCriticalBulletCollAcc || 0) >= __nonCriticalInterval);
        if (__doNonCriticalBulletColl && state) state._nonCriticalBulletCollAcc -= __nonCriticalInterval;

        if (!state.isFrozen) bulletLoop: for (let i = projectiles.items.length - 1; i >= 0; i--) {
                const b = projectiles.items[i];
                // O(1) unordered removal to reduce `splice()` churn; if we swap, reprocess the swapped bullet at this index.
                let __bulletRemoved = false;
                let __bulletSwapped = false;
                const __removeBulletAtI = () => {
                        if (__bulletRemoved) return;
                        const arr = projectiles.items;
                        const last = arr.length - 1;
                        if (i < 0 || i > last) { __bulletRemoved = true; return; }
                        __bulletSwapped = (i !== last);
                        if (__bulletSwapped) arr[i] = arr[last];
                        arr.pop();
                        __bulletRemoved = true;
                };
                // Reset behind-enemy flag each frame
                b.sortBehindThisFrame = false;
                
                // Skip all collision checks for molotov fireballs - they only explode on reaching target
                if (b.deathMolotov) continue;
                
                // Enemy-owned bullet vs player collision
                try {
                        const ownerIsEnemy = !!(b && (
                                b._serverEnemyBullet === true ||
                                (b.owner && b.owner.isEnemy === true) ||
                                (b.owner && window.Enemy && (b.owner instanceof window.Enemy))
                        ));
                        const ownerIsHostileNpcB = !!(b && b.owner && b.owner.name === 'NPC_B' && b.owner.state === 'hostile');
                        if ((ownerIsEnemy || ownerIsHostileNpcB) && !b.isCone && !b.noDamage && (!b.deathYellowCircle || b.allowMidflightPlayerHit)) {
                                if (player && player.health > 0) {
                                        const dxp = player.x - b.x;
                                        const dyp = player.y - b.y;
                                        const rr = (player.radius || 26) + (b.radius || 0);
                                        if (dxp * dxp + dyp * dyp <= rr * rr) {
                                                let damage = (typeof b.damage === 'number') ? b.damage : 18;
                                                // Apply damage only in single-player; server handles damage in multiplayer
                                                // Damage is server-authoritative (local damage removed for multiplayer-only)
                                                // Health changes handled by server
                                                
                                                // Trigger brief red hit flash and cooldown (VFX only)
                                                try {
                                                        if (player && typeof player.hitFlashMax === 'number') {
                                                                const canFlash = (!player.hitFlash || player.hitFlash <= 0) && (!player.hitFlashCooldown || player.hitFlashCooldown <= 0);
                                                                if (canFlash) {
                                                                        player.hitFlash = player.hitFlashMax;
                                                                        player.hitFlashCooldown = player.hitFlashGap || 0.07;
                                                                }
                                                        }
                                                } catch(_) {}
                                                // Impact VFX for feedback
                                                try { if (window.ImpactVfx) projectiles.impacts.push(new window.ImpactVfx(b.x, b.y, b.color, -b.vx, -b.vy)); } catch(_) {}
                                                // If this projectile is allowed to explode on player impact (Fast Ball), trigger its explosion
                                                if (b.allowMidflightPlayerHit && window.ExplosionVfx) {
                                                        try {
                                                                projectiles.impacts.push(new window.ExplosionVfx(b.x, b.y, '#ffae00'));
                                                        } catch(_) {}
                                                }
                                                __removeBulletAtI();
                                                if (__bulletSwapped) i++;
                                                continue bulletLoop;
                                        }
                                }
                                // Also resolve hits against otherPlayers for observer clients so bullets don't pass through remotely
                                if (__doNonCriticalBulletColl) {
                                        try {
                                                if (Array.isArray(otherPlayers) && otherPlayers.length > 0) {
                                                        for (let opi = 0; opi < otherPlayers.length; opi++) {
                                                                const op = otherPlayers[opi]; if (!op) continue;
                                                                const dxrp = op.x - b.x;
                                                                const dyrp = op.y - b.y;
                                                                const rrp = (op.radius || 20) + (b.radius || 0);
                                                                if (dxrp * dxrp + dyrp * dyrp <= rrp * rrp) {
                                                                        // Feedback only on observers: impact VFX and remove bullet
                                                                        try { if (window.ImpactVfx) projectiles.impacts.push(new window.ImpactVfx(b.x, b.y, b.color, -b.vx, -b.vy)); } catch(_) {}
                                                                        __removeBulletAtI();
                                                                        if (__bulletSwapped) i++;
                                                                        continue bulletLoop;
                                                                }
                                                        }
                                                }
                                        } catch(_) {}
                                }
                                
                                // Also resolve hits against troops so bullets don't pass through them visually
                                if (__doNonCriticalBulletColl) {
                                        try {
                                                if (window.troops && window.troops.items && window.troops.items.length > 0) {
                                                        for (let ti = 0; ti < window.troops.items.length; ti++) {
                                                                const troop = window.troops.items[ti];
                                                                if (!troop || !troop.alive || troop.health <= 0) continue;
                                                                
                                                                const dxt = troop.x - b.x;
                                                                const dyt = troop.y - b.y;
                                                                const rrt = (troop.radius || 22) + (b.radius || 0);
                                                                
                                                                if (dxt * dxt + dyt * dyt <= rrt * rrt) {
                                                                        // Visual feedback only - damage is server-authoritative
                                                                        try { if (window.ImpactVfx) projectiles.impacts.push(new window.ImpactVfx(b.x, b.y, b.color, -b.vx, -b.vy)); } catch(_) {}
                                                                        __removeBulletAtI();
                                                                        if (__bulletSwapped) i++;
                                                                        continue bulletLoop;
                                                                }
                                                        }
                                                }
                                        } catch(_) {}
                                }
                                
                                // Enemy bullet vs turret collision
                                if (__doNonCriticalBulletColl && !b.isCone && window.abilityManager && window.abilityManager.abilities) {
                                        const abilities = window.abilityManager.abilities;
                                        for (let ti = 0; ti < abilities.length; ti++) {
                                                const turret = abilities[ti];
                                                if (!turret || turret.constructor.name !== 'AutoTurret') continue;
                                                if (!turret.alive) continue;
                                                
                                                const dxt = turret.x - b.x;
                                                const dyt = turret.y - b.y;
                                                const rrt = (turret.radius || 25) + (b.radius || 0);
                                                if (dxt * dxt + dyt * dyt <= rrt * rrt) {
                                                        // Impact VFX on turret
                                                        try { 
                                                                if (window.ImpactVfx) {
                                                                        projectiles.impacts.push(new window.ImpactVfx(b.x, b.y, b.color, -b.vx, -b.vy));
                                                                }
                                                        } catch(_) {}
                                                        // Remove bullet (or explode if allowMidflightPlayerHit)
                                                        if (b.allowMidflightPlayerHit && window.ExplosionVfx) {
                                                                try {
                                                                        projectiles.impacts.push(new window.ExplosionVfx(b.x, b.y, '#ffae00'));
                                                                } catch(_) {}
                                                        }
                                                        __removeBulletAtI();
                                                        if (__bulletSwapped) i++;
                                                        continue bulletLoop;
                                                }
                                        }
                                }
                        }
                        
                        // Boss projectiles (artillery/fast ball) vs turret collision
                        // These have deathYellowCircle but should still hit turrets mid-flight
                        try {
                                const isBossProjectile = !!(b && (
                                        b._serverEnemyBullet === true ||
                                        (b.owner && b.owner.name === 'ArtilleryWitch') ||
                                        b.deathYellowCircle === true
                                ));
                                if (__doNonCriticalBulletColl && isBossProjectile && !b.isCone && window.abilityManager && window.abilityManager.abilities) {
                                        const abilities = window.abilityManager.abilities;
                                        for (let ti = 0; ti < abilities.length; ti++) {
                                                const turret = abilities[ti];
                                                if (!turret || turret.constructor.name !== 'AutoTurret') continue;
                                                if (!turret.alive) continue;
                                                
                                                const dxt = turret.x - b.x;
                                                const dyt = turret.y - b.y;
                                                const rrt = (turret.radius || 25) + (b.radius || 0);
                                                if (dxt * dxt + dyt * dyt <= rrt * rrt) {
                                                        // Impact VFX on turret
                                                        try { 
                                                                if (window.ImpactVfx) {
                                                                        projectiles.impacts.push(new window.ImpactVfx(b.x, b.y, b.color, -b.vx, -b.vy));
                                                                }
                                                        } catch(_) {}
                                                        // Explosion VFX for fast balls or artillery
                                                        if (window.ExplosionVfx) {
                                                                try {
                                                                        projectiles.impacts.push(new window.ExplosionVfx(b.x, b.y, b.color || '#ffae00'));
                                                                } catch(_) {}
                                                        }
                                                        // Remove bullet
                                                        __removeBulletAtI();
                                                        if (__bulletSwapped) i++;
                                                        continue bulletLoop;
                                                }
                                        }
                                }
                        } catch(_) {}
                        
                        // Enemy (or hostile NPC_B) cone vs player collision
                        if ((ownerIsEnemy || ownerIsHostileNpcB) && b.isCone) {
                                if (player && player.health > 0 && !b._playerHit) {
                                        const px = player.x - b.x;
                                        const py = player.y - b.y;
                                        const range = (b.coneRange || 0) + (player.radius || 26);
                                        if (px * px + py * py <= range * range) {
                                                let dAng = Math.atan2(py, px) - (b.angle || 0);
                                                while (dAng > Math.PI) dAng -= Math.PI * 2;
                                                while (dAng < -Math.PI) dAng += Math.PI * 2;
                                                if (Math.abs(dAng) <= (b.coneHalf || 0)) {
                                                        // Check if this is WallGuy melee (weapon1-style) or projectile zombie DOT (weapon4-style)
                                                        const isWallGuyMelee = b.owner && b.owner.type === 'wallguy';
                                                        
                                                        if (isWallGuyMelee) {
                                                                // WallGuy melee: Show slash VFX AND damage feedback (damage handled by server)
                                                                try {
                                                                        // Slash VFX at player location
                                                                        if (window.SlashVfx) {
                                                                                projectiles.impacts.push(new window.SlashVfx(player.x, player.y, b.angle, b.color || '#8B0000'));
                                                                        }
                                                                        
                                                                        // Trigger immediate damage feedback (hit flash, screen shake, vignette)
                                                                        // Hit flash
                                                                        const canFlash = (!player.hitFlash || player.hitFlash <= 0) && 
                                                                                       (!player.hitFlashCooldown || player.hitFlashCooldown <= 0);
                                                                        if (canFlash && typeof player.hitFlashMax === 'number') {
                                                                                player.hitFlash = player.hitFlashMax;
                                                                                player.hitFlashCooldown = player.hitFlashGap || 0.07;
                                                                        }
                                                                        
                                                                        // Screen shake and vignette
                                                                        if (window.enqueueDamageEvent && typeof window.enqueueDamageEvent === 'function') {
                                                                                window.enqueueDamageEvent({ amount: 20, source: 'wallguy' }); // Estimated damage for VFX intensity
                                                                        }
                                                                } catch(_) {}
                                                        } else {
                                                                // Projectile zombie DOT attack: Apply DOT and flame VFX like weapon 4
                                                                try {
                                                                        if (!player._playerDotStacks) player._playerDotStacks = [];
                                                                        const wasBurning = player._playerDotStacks.length > 0;
                                                                        // Push a DOT stack: DPS ~5 for 3.2s (halved)
                                                                        player._playerDotStacks.push({ dps: 2.5, timeLeft: 3.2 });
                                                                        // Burning state changes are now handled by player DOT processing for all sources
                                                                } catch(_) {}
                                                                // Feedback
                                                                try { if (window.ImpactVfx) projectiles.impacts.push(new window.ImpactVfx(player.x, player.y, b.color || '#ff4d4d', -b.vx, -b.vy)); } catch(_) {}
                                                        }
                                                        b._playerHit = true;
                                                }
                                        }
                                }
                        }
                } catch(_) {}
                // Limit candidate enemies using spatial grid when available
                // IMPORTANT: Must include BigBoy (radius 80) or bullets can visually overlap and still miss
                // because the initial queryCircle() filter is based on enemy CENTER distance.
                const maxEnemyR = 80;
                const searchR = b.isCone ? (b.coneRange + maxEnemyR) : (b.radius + maxEnemyR);
                const candidates = (typeof enemies.queryCircle === 'function') ? enemies.queryCircle(b.x, b.y, searchR) : enemies.items;
                // IMPORTANT: Weapon 1 melee cones are short-range and should always be reliable.
                // Use enemies.items directly to avoid any edge cases where the spatial grid misses an entity (e.g., lobby dummy).
                let enemyTargets = candidates;
                if (b.isCone && b.sourceWeaponIndex === 0 && enemies && Array.isArray(enemies.items)) {
                        enemyTargets = enemies.items;
                }
                if (!Array.isArray(enemyTargets)) enemyTargets = (enemies && Array.isArray(enemies.items)) ? enemies.items : [];

                // Include hostile NPC_B as valid targets for player bullets WITHOUT allocating new arrays
                let npcTargets = null;
                try { npcTargets = window?.npcs?.items || null; } catch(_) { npcTargets = null; }

                // Throttle cone slash VFX per bullet
                let coneVfxCount = 0;
                // Two-pass iteration: enemies first, then NPCs (filtering to hostile NPC_B).
                for (let __pass = 0; __pass < 2; __pass++) {
                        const arr = (__pass === 0) ? enemyTargets : npcTargets;
                        if (!arr || !Array.isArray(arr) || arr.length === 0) continue;
                        for (let j = 0; j < arr.length; j++) {
                                const e = arr[j];
                                if (!e || !e.alive) continue;
                                if (__pass === 1) {
                                        // NPC pass: only consider hostile NPC_B as valid bullet targets
                                        if (e.name !== 'NPC_B' || e.state !== 'hostile') continue;
                                }
                        // Skip if this is the owner of the attack (enemy shouldn't hit itself).
                        // IMPORTANT: do NOT compare numeric ids (Player.id and Enemy.id can collide on a client).
                        // Use object identity and (when available) server IDs instead.
                        if (b.owner && e === b.owner) continue;
                        if (b.owner && b.owner._serverId && e._serverId && e._serverId === b.owner._serverId) continue;
                        // Also check b.owner.id (used by enemyMeleeAttack cone bullets)
                        if (b.owner && b.owner.id && e._serverId && e._serverId === b.owner.id) continue;
                        if (b.isCone) {
                                const ex = e.x - b.x;
                                const ey = e.y - b.y;
                                const range = b.coneRange + e.radius;
                                if (ex * ex + ey * ey <= range * range) {
                                let dAng = Math.atan2(ey, ex) - b.angle;
                                while (dAng > Math.PI) dAng -= Math.PI * 2;
                                while (dAng < -Math.PI) dAng += Math.PI * 2;
                                
                                // Calculate angular tolerance based on enemy size
                                // This makes larger enemies (like BigBoy) easier to hit at their edges
                                const distToEnemy = Math.sqrt(ex * ex + ey * ey);
                                const angularTolerance = distToEnemy > 0 ? Math.atan2(e.radius, distToEnemy) : 0;
                                const effectiveConeHalf = b.coneHalf + angularTolerance;
                                
                                if (Math.abs(dAng) <= effectiveConeHalf) {
                                        // Check if a WallGuy shield is blocking the line of sight from cone to enemy
                                        let blockedByShield = false;
                                        try {
                                                const enemyList = window.enemies?.items || [];
                                                for (const wallguy of enemyList) {
                                                        if (!wallguy || !wallguy.alive || wallguy.type !== 'wallguy') continue;
                                                        if (!wallguy.shield || !wallguy.shield.alive) continue;
                                                        
                                                        // Don't block if the shield owner IS the target (shield doesn't block itself)
                                                        if (wallguy.id === e.id || wallguy._serverId === e._serverId) continue;
                                                        
                                                        const shield = wallguy.shield;
                                                        
                                                        // Check if line from cone origin to enemy intersects shield
                                                        // Transform both points to shield's local space
                                                        const startX = b.x - shield.x;
                                                        const startY = b.y - shield.y;
                                                        const endX = e.x - shield.x;
                                                        const endY = e.y - shield.y;
                                                        
                                                        const cos = Math.cos(-shield.angle);
                                                        const sin = Math.sin(-shield.angle);
                                                        
                                                        const localStartX = startX * cos - startY * sin;
                                                        const localStartY = startX * sin + startY * cos;
                                                        const localEndX = endX * cos - endY * sin;
                                                        const localEndY = endX * sin + endY * cos;
                                                        
                                                        // Proper line-segment vs AABB intersection test (Liang-Barsky algorithm)
                                                        const halfW = shield.depth / 2;   // 10 (horizontal)
                                                        const halfH = shield.width / 2;   // 40 (vertical)
                                                        
                                                        // Liang-Barsky line clipping against AABB
                                                        let t0 = 0, t1 = 1;
                                                        const dx = localEndX - localStartX;
                                                        const dy = localEndY - localStartY;
                                                        
                                                        const clipEdge = (p, q) => {
                                                                if (p === 0) return q >= 0; // Parallel to edge
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
                                                        
                                                        // Test against all four edges of the shield rectangle
                                                        if (clipEdge(-dx, localStartX - (-halfW)) &&  // Left edge
                                                            clipEdge(dx, halfW - localStartX) &&       // Right edge
                                                            clipEdge(-dy, localStartY - (-halfH)) &&   // Bottom edge
                                                            clipEdge(dy, halfH - localStartY)) {       // Top edge
                                                                // Line segment intersects shield if t0 <= t1
                                                                if (t0 <= t1) {
                                                                        blockedByShield = true;
                                                                        break;
                                                                }
                                                        }
                                                }
                                        } catch(_) {}
                                        
                                        // Skip this enemy if blocked by shield
                                        if (blockedByShield) continue;
                                        
                                        if (!b.alreadyHitEnemyIds.has(e.id)) {
                                                        // Cones are used both for real damage (Weapon 1 melee, Weapon 4 DOT)
                                                        // and for pure VFX (e.g., server-authoritative troop melee slashes).
                                                        // If a cone is marked noDamage, ONLY weapon 1 should still deal damage client-side.
                                                        const isWeapon1MeleeCone = (b.sourceWeaponIndex === 0);
                                                        const isDotCone = (b.sourceWeaponIndex === 3);
                                                        const coneShouldDealDamage = (!b.noDamage) || isWeapon1MeleeCone || isDotCone;
                                                        if (!coneShouldDealDamage) {
                                                                // Prevent VFX-only cones from spawning bogus "0" damage popups.
                                                                b.alreadyHitEnemyIds.add(e.id);
                                                                continue;
                                                        }

                                                        if ((b.sourceWeaponIndex === 3) && typeof e.applyDot === 'function') {
                                                                let dotBonus = 0;
                                                                try { dotBonus = Math.max(0, player?.getDotAttackPowerBonus?.() || 0); } catch(_) {}
                                                                
                                                                // NPC_B DOT is server-authoritative
                                                                if (e.name === 'NPC_B' && e._serverId && window.networkManager && b.owner === player) {
                                                                    if (window.GameConstants?.ENABLE_DEBUG_LOGS) {
                                                                        console.log('[NPC_B] Sending DOT to server:', { npcId: e._serverId, dps: 5 + dotBonus, duration: 3 });
                                                                    }
                                                                    window.networkManager.sendNPCDot(e._serverId, 5 + dotBonus, 3);
                                                                } else {
                                                                    // For regular enemies, apply DOT locally (ORIGINAL LOGIC)
                                                                    e.applyDot(5 + dotBonus, 3, { owner: player });
                                                                }
                                                        } else {
                                                                let dmg = (typeof b.damage === 'number') ? b.damage : 20;
                                                                
                                                                // Shotgun pellets already have attack power divided into their damage, don't add it again
                                                                if (!b.isShotgunPellet) {
                                                                    try { dmg += Math.max(0, b.owner?.getTotalAttackPowerFlat?.() || 0); } catch(_) {}
                                                                }
                                                                
                                                                // Apply damage falloff for shotgun pellets
                                                                if (b.isShotgunPellet && typeof b.spawnX === 'number' && typeof b.spawnY === 'number') {
                                                                    const distTraveled = Math.hypot(b.x - b.spawnX, b.y - b.spawnY);
                                                                    const maxRange = 412; // Approx max range (0.147s * 2800 speed)
                                                                    const falloffMultiplier = Math.max(0.3, 1.0 - (distTraveled / maxRange) * 0.7);
                                                                    dmg *= falloffMultiplier;
                                                                }
                                                                
                                                                let isCrit = false;
                                                                try {
                                                                        const owner = b.owner;
                                                                        const cc = Math.max(0, Math.min(1, owner?.critChance ?? 0));
                                                                        const cm = Math.max(1, owner?.critDamageMultiplier ?? 1);
                                                                        isCrit = Math.random() < cc;
                                                                        if (isCrit) dmg *= cm;
                                                                        // Never show client-side damage text for server-sync entities (target dummies, NPC_B)
                                                                        // They get authoritative damage text from server
                                                                        const isServerSync = e.serverSync || (e.name === 'NPC_B');
                                                                        if (window.enqueueDamageText && !isServerSync && dmg > 0) {
                                                                                window.enqueueDamageText({ x: e.x, y: e.y - (e.radius || 26) - 6, text: Math.round(dmg).toString(), crit: isCrit, color: isCrit ? '#ffd36b' : '#ffffff', vy: -80, life: 0.8 });
                                                                        }
                                                                } catch(_) {}
                                                                
                                                // For NPC_B, send damage to server; for other enemies apply locally (ORIGINAL LOGIC)
                                                if (e.name === 'NPC_B' && e._serverId && window.networkManager && b.owner === player) {
                                                    window.networkManager.sendNPCDamage(e._serverId, Math.round(dmg), b.noDamage || false);
                                                } else {
                                                    // Apply cone damage (weapon1 uses noDamage=true for VFX suppression but still must damage)
                                                    e.applyDamage(dmg);
                                                }
                                                        }
                                                        b.alreadyHitEnemyIds.add(e.id);
                                                        if (b.sourceWeaponIndex !== 3 && window.SlashVfx && coneVfxCount < 4) {
                                                                projectiles.impacts.push(new window.SlashVfx(e.x, e.y, b.angle, '#ff4d4d'));
                                                                coneVfxCount++;
                                                        }
                                                }
                                        }
                                }
                        } else {
                                const dx = e.x - b.x;
                                const dy = e.y - b.y;
                                const r = e.radius + b.radius;
                                const distSq = dx * dx + dy * dy;
                                const collides = distSq <= r * r;
                                
                                // Weapon 7 tracers: stop visually at enemy even though they have noDamage
                                if (b.sourceWeaponIndex === 6 && b.noDamage && collides && !b.ignoreEnemies) {
                                        if (!b.alreadyHitEnemyIds || !b.alreadyHitEnemyIds.has(e.id)) {
                                                b.alive = false;
                                                b.life = 0;
                                                if (b.alreadyHitEnemyIds) b.alreadyHitEnemyIds.add(e.id);
                                        }
                                }
                                
                                if (!b.noDamage && !b.ignoreEnemies && collides) {
                                        // On any enemy hit this frame, render behind enemies
                                        b.sortBehindThisFrame = true;
                                        const isPiercingWeapon5 = (b.sourceWeaponIndex === 4);
                                        const isPiercingWeapon3Charged = (b.sourceWeaponIndex === 2 && b.isChargedShot);
                                        const isPiercing = isPiercingWeapon5 || isPiercingWeapon3Charged;
                                        const alreadyHit = b.alreadyHitEnemyIds && b.alreadyHitEnemyIds.has(e.id);
                                        if (!alreadyHit) {
                                                let hitDamage = (typeof b.damage === 'number') ? b.damage : 20;
                                                
                                                // Shotgun pellets already have attack power divided into their damage, don't add it again
                                                if (!b.isShotgunPellet) {
                                                    try { hitDamage += Math.max(0, b.owner?.getTotalAttackPowerFlat?.() || 0); } catch(_) {}
                                                }
                                                
                                                // Apply damage falloff for shotgun pellets
                                                if (b.isShotgunPellet && typeof b.spawnX === 'number' && typeof b.spawnY === 'number') {
                                                    const distTraveled = Math.hypot(b.x - b.spawnX, b.y - b.spawnY);
                                                    const maxRange = 412; // Approx max range (0.147s * 2800 speed)
                                                    const falloffMultiplier = Math.max(0.3, 1.0 - (distTraveled / maxRange) * 0.7);
                                                    hitDamage *= falloffMultiplier;
                                                }
                                                
									let isCrit = false;
									try {
                                                        const owner = b.owner;
                                                        const cc = Math.max(0, Math.min(1, owner?.critChance ?? 0));
                                                        const cm = Math.max(1, owner?.critDamageMultiplier ?? 1);
											isCrit = Math.random() < cc;
                                                        if (isCrit) hitDamage *= cm;
                                                        // Only create client-side damage text for non-server-synchronized enemies
                                                        // Server-synchronized entities (like target dummies and NPC_B) get authoritative damage text from server
                                                        const isServerSync = e.serverSync || (e.name === 'NPC_B');
                                                        if (window.enqueueDamageText && !isServerSync) {
                                                                window.enqueueDamageText({ x: e.x, y: e.y - (e.radius || 26) - 6, text: Math.round(hitDamage).toString(), crit: isCrit, color: isCrit ? '#ffd36b' : '#ffffff', vy: -80, life: 0.8 });
                                                        }
									} catch(_) {}
                                                
                                                // Calculate knockback data for server/remote replication
                                                let knockbackData = null;
                                                if (b.knockback && b.knockback > 0) {
                                                        const spd = Math.hypot(b.vx, b.vy) || 1;
                                                        knockbackData = {
                                                                dirX: b.vx / spd,
                                                                dirY: b.vy / spd,
                                                                distance: b.knockback,
                                                                duration: 0.2
                                                        };
                                                        console.log('[Weapon3] Knockback data created:', {
                                                                weaponIndex: b.sourceWeaponIndex,
                                                                distance: b.knockback,
                                                                enemyServerId: e._serverId,
                                                                enemyServerSpawned: e.serverSpawned
                                                        });
                                                }
                                                
                                                // Check if this is NPC_B for server-authoritative damage
                                                const isNpcB = e.name === 'NPC_B';
                                                
                                                // For NPC_B, send damage to server; for other enemies apply locally
                                                if (isNpcB && e._serverId && window.networkManager && b.owner === window.player) {
                                                    window.networkManager.sendNPCDamage(e._serverId, Math.round(hitDamage), b.noDamage || false);
                                                } else {
                                                    e.applyDamage(hitDamage, { x: b.x, y: b.y, dirX: b.vx, dirY: b.vy });
                                                }
                                                
                                                // Relay projectile hit so remote clients apply damage and knockback
                                                // Skip for NPC_B - server handles it via npcDamage event
                                                try {
											if (window.networkManager && e._serverId && b.owner === window.player && !b.isCone && !isNpcB) {
                                                                if (window.DEBUG_WEAPON9_SYNC && b.sourceWeaponIndex === 8) {
															try { console.log('[Weapon9][Send] projectileHit to server:', { id: e._serverId, damage: Math.round(hitDamage), crit: isCrit, x: b.x, y: b.y }); } catch(_) {}
                                                                }
                                                                const payload = { id: e._serverId, damage: Math.round(hitDamage), crit: isCrit, x: b.x, y: b.y };
                                                                if (knockbackData) {
                                                                        payload.knockback = knockbackData;
                                                                        payload.weaponIndex = b.sourceWeaponIndex; // Include weapon index for knockback cooldown
                                                                }
                                                                window.networkManager.socket.emit('projectileHit', payload);
											} else if (window.DEBUG_WEAPON9_SYNC && b.sourceWeaponIndex === 8) {
													// Help diagnose why send did not occur for weapon 9
													try {
														console.log('[Weapon9][Send][Skip] not emitting projectileHit', {
															hasNetworkManager: !!window.networkManager,
															hasServerId: !!(e && e._serverId),
															isOwner: b.owner === window.player,
															isCone: !!b.isCone,
															isNpcB: isNpcB
														});
													} catch(_) {}
                                                        }
                                                } catch(_) {}
                                                
                                                // Queue knockback over 0.2s for projectiles that define it (weapon 3)
                                                // Only apply locally for non-server-spawned enemies; server will handle server enemies
                                                if (knockbackData && typeof e.applyKnockback === 'function' && !e.serverSpawned) {
                                                        // Weapon 3 knockback cooldown: prevent rapid repeated knockback
                                                        let canApplyKnockback = true;
                                                        if (b.sourceWeaponIndex === 2) {
                                                                const now = Date.now();
                                                                const cooldownMs = 800; // Match charge shot time
                                                                
                                                                // Initialize cooldown tracking if needed
                                                                if (typeof e._weapon3KnockbackCooldown !== 'number') {
                                                                        e._weapon3KnockbackCooldown = 0;
                                                                }
                                                                
                                                                // Check if cooldown has expired
                                                                const timeLeft = e._weapon3KnockbackCooldown - now;
                                                                if (timeLeft > 0) {
                                                                        canApplyKnockback = false;
                                                                        console.log('[Weapon3] Knockback on cooldown:', Math.round(timeLeft), 'ms remaining');
                                                                } else {
                                                                        // Apply knockback and set cooldown
                                                                        e._weapon3KnockbackCooldown = now + cooldownMs;
                                                                        console.log('[Weapon3] Applying knockback, setting', cooldownMs, 'ms cooldown');
                                                                }
                                                        }
                                                        
                                                        if (canApplyKnockback) {
                                                                e.applyKnockback(knockbackData.dirX, knockbackData.dirY, knockbackData.distance, knockbackData.duration);
                                                        }
                                                }
                                                if (b.alreadyHitEnemyIds) b.alreadyHitEnemyIds.add(e.id);
                                                // Spawn VFX at impact (safely)
                                                if (window.ImpactVfx) {
                                                        projectiles.impacts.push(new window.ImpactVfx(b.x, b.y, b.color, -b.vx, -b.vy, { scale: b.impactScale || 1 }));
                                                }
                                        }
                                        if (!isPiercing) {
                                                __removeBulletAtI();
                                                if (__bulletSwapped) i++;
                                                continue bulletLoop;
                                        }
                                }
                        }
                } // end two-pass (enemies + hostile NPC_B) target iteration
                }
                
                // Check barrel collision for player-owned bullets (non-cone)
                // Skip grenades and other ballistic projectiles that should fly over obstacles
                const shouldCheckBarrels = !b.isCone && b.owner === player && !b.deathYellowCircle && !b.deathMolotov;
                if (shouldCheckBarrels && window.hazards && window.hazards.explodingBarrels) {
                    for (const barrel of window.hazards.explodingBarrels) {
                        if (!barrel || barrel.exploded) continue;
                        
                        const bx = barrel.x;
                        const by = barrel.y;
                        const br = barrel.visualRadius || 24;
                        
                        // Circle collision
                        const dx = b.x - bx;
                        const dy = b.y - by;
                        const dist = Math.hypot(dx, dy);
                        
                        if (dist <= br + b.radius) {
                            // Send barrel damage to server
                            if (window.networkManager && window.networkManager.socket) {
                                let dmg = (typeof b.damage === 'number') ? b.damage : 20;
                                
                                // Apply damage falloff for shotgun pellets
                                if (b.isShotgunPellet && typeof b.spawnX === 'number' && typeof b.spawnY === 'number') {
                                    const distTraveled = Math.hypot(b.x - b.spawnX, b.y - b.spawnY);
                                    const maxRange = 412;
                                    const falloffMultiplier = Math.max(0.3, 1.0 - (distTraveled / maxRange) * 0.7);
                                    dmg *= falloffMultiplier;
                                }
                                
                                window.networkManager.socket.emit('barrelDamage', {
                                    barrelId: barrel.id,
                                    damage: Math.round(dmg),
                                    x: b.x,
                                    y: b.y
                                });
                            }
                            
                            // Spawn impact VFX
                            if (window.ImpactVfx) {
                                projectiles.impacts.push(new window.ImpactVfx(b.x, b.y, '#ff6633', -b.vx, -b.vy, { scale: 0.8 }));
                            }
                            
                            // Remove bullet
                            __removeBulletAtI();
                            if (__bulletSwapped) i++;
                            continue bulletLoop;
                        }
                    }
                }
                
                // PvP collision for cone weapons (weapon 1 and 4) - outside enemy loop so it always runs
                if (b.isCone && b.owner === player && window.networkManager) {
                        try {
                                const myEvil = (typeof window !== 'undefined' && window.__killThemAllLocked === true);
                                const otherPlayers = window.networkManager.otherPlayers;
                                if (otherPlayers && otherPlayers.size > 0) {
                                        for (const [otherId, otherData] of otherPlayers) {
                                                if (!otherData || otherData.health <= 0) continue;
                                                // Check evil status
                                                const otherEvil = window.networkManager.remotePlayerEvilStates?.get(otherId) || false;
                                                if (myEvil === otherEvil) continue; // same alignment, skip
                                                
                                                // Check if already hit this player with this bullet
                                                if (!b.pvpHitPlayerIds) b.pvpHitPlayerIds = new Set();
                                                if (b.pvpHitPlayerIds.has(otherId)) continue;
                                                
                                                // Check cone collision
                                                const ex = otherData.x - b.x;
                                                const ey = otherData.y - b.y;
                                                const range = b.coneRange + (otherData.radius || 26);
                                                if (ex * ex + ey * ey <= range * range) {
                                                        let dAng = Math.atan2(ey, ex) - b.angle;
                                                        while (dAng > Math.PI) dAng -= Math.PI * 2;
                                                        while (dAng < -Math.PI) dAng += Math.PI * 2;
                                                        if (Math.abs(dAng) <= b.coneHalf) {
                                                                b.pvpHitPlayerIds.add(otherId);
                                                                
                                                                if (b.sourceWeaponIndex === 3) {
                                                                        // Weapon 4: Apply DOT
                                                                        let dotBonus = 0;
                                                                        try { dotBonus = Math.max(0, player?.getDotAttackPowerBonus?.() || 0); } catch(_) {}
                                                                        window.networkManager.socket.emit('pvpDirectDamage', {
                                                                                targetId: otherId,
                                                                                isDot: true,
                                                                                dotDps: 5 + dotBonus,
                                                                                dotDuration: 3,
                                                                                weaponIndex: 4
                                                                        });
                                                                } else {
                                                                        // Weapon 1: Apply instant damage
                                                                        let dmg = (typeof b.damage === 'number') ? b.damage : 30;
                                                                        try { dmg += Math.max(0, player?.getTotalAttackPowerFlat?.() || 0); } catch(_) {}
                                                                        let isCrit = false;
                                                                        try {
                                                                                const cc = Math.max(0, Math.min(1, player?.critChance ?? 0));
                                                                                const cm = Math.max(1, player?.critDamageMultiplier ?? 1);
                                                                                isCrit = Math.random() < cc;
                                                                                if (isCrit) dmg *= cm;
                                                                        } catch(_) {}
                                                                        window.networkManager.socket.emit('pvpDirectDamage', {
                                                                                targetId: otherId,
                                                                                damage: dmg,
                                                                                crit: isCrit,
                                                                                weaponIndex: 1
                                                                        });
                                                                }
                                                        }
                                                }
                                        }
                                }
                        } catch(err) { console.error('[PvP] Cone collision error:', err); }
                }
        }

        if (!state.isFrozen) {
                // Spawn a blood pool under downed players once they are no longer revivable (revive window expired).
                // Uses the same ground decal system as enemy death blood pools.
                try {
                        const net = window.networkManager;
                        if (net && net.connected && typeof window.enqueueGroundDecal === 'function' && window.BloodPoolDecal) {
                                if (!window._noReviveBloodPoolDownedAtByPlayerId) window._noReviveBloodPoolDownedAtByPlayerId = new Map();
                                const spawnedMap = window._noReviveBloodPoolDownedAtByPlayerId;
                                const now = Date.now();

                                const maybeSpawn = (p, pid) => {
                                        try {
                                                if (!p || !pid) return;
                                                const hp = Number(p.health);
                                                if (Number.isFinite(hp) && hp > 0) {
                                                        // Clear spawn guard on revive/respawn
                                                        spawnedMap.delete(pid);
                                                        return;
                                                }
                                                const downedAt = Number(p.downedAt) || 0;
                                                if (!downedAt) return;
                                                // If revive is already "ready to accept", they are still revivable (by button), so no "must respawn" pool.
                                                const readyUntil = Number(p.reviveReadyUntil) || 0;
                                                if (readyUntil > now) return;

                                                let remMs = Number(p.reviveWindowRemainingMs);
                                                if (!Number.isFinite(remMs)) remMs = Math.max(0, 30000 - (now - downedAt));
                                                if (remMs > 0) return;

                                                if (spawnedMap.get(pid) === downedAt) return;
                                                window.enqueueGroundDecal(new window.BloodPoolDecal(Number(p.x) || 0, Number(p.y) || 0, Number(p.radius) || 26));
                                                spawnedMap.set(pid, downedAt);
                                        } catch(_) {}
                                };

                                // Local player (if downed + expired)
                                maybeSpawn(player, net.playerId || player?.id || 'local');

                                // Other players (if downed + expired)
                                const ops = (typeof net.getOtherPlayers === 'function') ? net.getOtherPlayers() : [];
                                if (Array.isArray(ops)) {
                                        for (let i = 0; i < ops.length; i++) {
                                                const op = ops[i];
                                                if (!op) continue;
                                                maybeSpawn(op, op.id);
                                        }
                                }
                        }
                } catch(_) {}

                enemies.update(dt);
				// AI director drives enemy movement after physics updates and before draw
				// Enemy movement is server-authoritative (director update removed for multiplayer-only)
				// Director update disabled - server handles all enemy AI
                // Apply (inactive-by-default) enemy net smoothing when server becomes authoritative
                if (window.networkManager && typeof window.networkManager.applyEnemyNetSmoothing === 'function') {
                    window.networkManager.applyEnemyNetSmoothing(dt);
                }
                // Apply NPC net smoothing (multiplayer)
                if (window.networkManager && typeof window.networkManager.applyNpcNetSmoothing === 'function') {
                    window.networkManager.applyNpcNetSmoothing(dt);
                }
                // Update ground decals (blood pools) so they can spread and fade
                for (let i = groundDecals.length - 1; i >= 0; i--) {
                        const d = groundDecals[i];
                        if (d && typeof d.update === 'function') d.update(dt);
                        if (!d || d.life <= 0) groundDecals.splice(i, 1);
                }
        }

	// Camera follow with deadzone and smoothing (uses Camera module)
	if (window.camera) {
		window.camera.update(dt, player);
	}

	// Process queued damage events (from both local contact damage and server-synced damage)
	if (window._damageEvents && window._damageEvents.length > 0) {
		// Sum all damage this frame
		let totalDamageRaw = 0;
		let totalShakeDamage = 0;
		const eventCount = window._damageEvents.length;
		for (let i = 0; i < eventCount; i++) {
			const evt = window._damageEvents[i];
			if (evt == null) continue;
			let amount = 0;
			let shakeScale = 1;
			if (typeof evt === 'number') {
				amount = evt;
			} else {
				amount = Number(evt.amount);
				if (!Number.isFinite(amount)) amount = 0;
				if (Number.isFinite(evt.shakeScale) && evt.shakeScale > 0) shakeScale = evt.shakeScale;
			}
			if (amount <= 0) continue;
			totalDamageRaw += amount;
			totalShakeDamage += amount * shakeScale;
		}
		window._damageEvents.length = 0; // Clear queue
		// Only process damage effects if player is alive
		if (totalDamageRaw > 0 && player && player.health > 0) {
			// Damage number batching strategy:
			// - If NOT in cooldown (timer <= 0): Show damage immediately (discrete hits like projectiles)
			// - If IN cooldown (timer > 0): Batch damage until cooldown expires (continuous spam like zombie contact)
			
			// Initialize damage accumulator if not exists
			if (typeof state.playerDamageAccum !== 'number') state.playerDamageAccum = 0;
			if (typeof state.playerDamageTextTimer !== 'number') state.playerDamageTextTimer = 0;
			
			// Decrement timer
			if (state.playerDamageTextTimer > 0) {
				state.playerDamageTextTimer -= dt;
			}
			
			// Determine if we should show damage number this frame
			const isInCooldown = state.playerDamageTextTimer > 0;
			const shouldShowNumber = !isInCooldown || (state.playerDamageAccum + totalDamageRaw >= 1);
			
			// Accumulate damage
			state.playerDamageAccum += totalDamageRaw;
			
			// Show damage number when:
			// 1. NOT in cooldown (show immediately for discrete hits)
			// 2. OR accumulated enough damage during cooldown (batch threshold reached)
			// Skip during dash invulnerability
			const isDashingForText = player && player.dashActive && player.dashDuration > 0;
			if (!isDashingForText && shouldShowNumber && state.playerDamageAccum >= 0.01) {
				try {
					if (window.enqueueDamageText && player) {
						const playerRadius = player.radius || 26;
						const damage = Math.max(1, Math.round(state.playerDamageAccum)); // Minimum -1
						
						// Calculate scale based on damage: 5hp = 1x, 75hp = 3x
						// Linear interpolation: scale = 1 + (damage - 5) / (75 - 5) * (3 - 1)
						const minDamage = 5;
						const maxDamage = 75;
						const minScale = 1;
						const maxScale = 3;
						let scale = minScale + Math.max(0, Math.min(1, (damage - minDamage) / (maxDamage - minDamage))) * (maxScale - minScale);
						scale = Math.max(minScale, Math.min(maxScale, scale)); // Clamp between 1x and 3x
						
						// Use existing damage text system (matches healing style)
						window.enqueueDamageText({
							x: player.x,
							y: player.y - playerRadius - 10,
							text: `-${damage}`,
							crit: false,
							color: '#ff3333', // Red for damage
							vy: -80,
							life: 1.2, // Same as healing duration
							spread: true, // Enable spread to prevent overlap
							scale: scale // Dynamic scaling based on damage
						});
						
						// Reset accumulator and set cooldown
						state.playerDamageAccum = 0;
						state.playerDamageTextTimer = 0.15; // ~150ms between numbers
					}
				} catch(e) {
					console.warn('[ClientUpdate] Error spawning damage number:', e);
				}
			}
			
	// Trigger shake and vignette (using same formula as original game)
	const frac = Math.min(1, totalDamageRaw / Math.max(1, player.healthMax || 100));
	state.damageStreakTime = Math.min(2.0, (state.damageStreakTime || 0) + dt);
	
	// Initialize burst hit cooldown timer if it doesn't exist
	if (typeof state.burstHitCooldown !== 'number') state.burstHitCooldown = 0;
	
	// Determine if this is a "fresh" burst hit (not in cooldown)
	const isBurstDamage = totalShakeDamage >= 15;
	const isFreshBurst = isBurstDamage && state.burstHitCooldown <= 0;
	
	// Instant ramp for burst damage (>15hp), slow ramp for sustained damage
	// This ensures single-hit attacks (WallGuy melee, boomers, artillery) get full shake/vignette immediately
	// while continuous damage (body contact, pools) ramps up smoothly
	if (isBurstDamage) {
		// Burst damage: jump to full shake progress immediately
		state.shakeProgress = 1.0;
		
		// Set cooldown for fresh burst hits to prevent spam (0.7 second cooldown)
		if (isFreshBurst) {
			state.burstHitCooldown = 0.7;
		}
	} else {
		// Sustained/small damage: ramp slowly as before
		state.shakeProgress = Math.min(1, (state.shakeProgress || 0) + dt / 0.6);
	}
	const ampEase = Math.max(0, Math.min(1, state.shakeProgress));
		const easedAmp = ampEase * ampEase;
		
		// Calculate shake magnitude using exponential moving average of recent damage
		const emaTau = 0.5; const alpha = 1 - Math.exp(-dt / emaTau);
		state._recentDamageEma = (1 - alpha) * (state._recentDamageEma || 0) + alpha * totalShakeDamage;
		const recentNorm = Math.max(0, Math.min(1, (state._recentDamageEma || 0) / 30));
		const impulseNorm = Math.max(0, Math.min(1, totalShakeDamage / 30));
		const impulseBoost = Math.sqrt(impulseNorm);
		const damageIntensity = Math.min(1, recentNorm * 0.6 + impulseBoost * 0.8);
		// Original game formula: builds from 5 to 17 pixels as damage intensity grows
		const baseMag = 5 + 12 * damageIntensity;
		
		// Apply 1.5x multiplier for fresh burst hits (first big hit not in cooldown)
		// This gives noticeable impact without getting crazy (~15-25 pixels for fresh burst vs ~10-17 normal)
		const burstMultiplier = isFreshBurst ? 1.5 : 1.0;
		const mag = baseMag * (0.45 + 0.55 * easedAmp) * burstMultiplier;
		triggerScreenShake(mag, 0.12);
		
		// Vignette - force burst hits to a strong minimum level (60%) with boost, cap at 80%
		let target;
		if (isFreshBurst) {
			// Fresh burst: force minimum 60% darkness, boost to 70%, cap at 80%
			const baseTarget = 0.3 + 0.7 * Math.max(frac, damageIntensity);
			const burstTarget = Math.max(0.6, baseTarget + 0.1); // At least 60%, boost by 10%
			target = Math.min(0.8, burstTarget); // Cap at 80%
			
			// INSTANT jump for burst hits (no lerp) - ensures vignette is immediately visible
			state.vignette = Math.max(state.vignette || 0, target);
		} else {
			// Normal damage: use standard formula with smooth ramp
			target = Math.min(1.0, 0.3 + 0.7 * Math.max(frac, damageIntensity));
			const rateUp = 8;
			state.vignette += (target - (state.vignette || 0)) * Math.min(1, dt * rateUp);
		}
		state.vignette = Math.max(0, Math.min(1, state.vignette));
		}
	} else {
		// No damage this frame - decay effects and cooldown
		state.damageStreakTime = Math.max(0, (state.damageStreakTime || 0) - dt * 2);
		state.shakeProgress = Math.max(0, (state.shakeProgress || 0) - dt / 0.3);
		if (state.damageStreakTime < 0.01) state.damageStreakTime = 0;
		
		// Decay burst hit cooldown
		if (typeof state.burstHitCooldown === 'number' && state.burstHitCooldown > 0) {
			state.burstHitCooldown -= dt;
			if (state.burstHitCooldown < 0) state.burstHitCooldown = 0;
		}
		
		if (state.vignette > 0) {
			const rateDown = 3.2;
			state.vignette = Math.max(0, (state.vignette || 0) - rateDown * dt);
		}
	}
	
	// Gas fog intensity is managed by server (gradual buildup/decay)
	// Handle periodic coughing throb when in gas (slow pulse, not fast flash)
	if ((state.gasFog || 0) > 0.3) {
		// Cough every 2-4 seconds when in gas
		if (!Number.isFinite(state.gasCoughTimer)) state.gasCoughTimer = 2 + Math.random() * 2;
		if (!Number.isFinite(state.gasCoughPhase)) state.gasCoughPhase = 0; // 0 = idle, 1 = rising, 2 = falling
		
		state.gasCoughTimer -= dt;
		if (state.gasCoughTimer <= 0) {
			// Trigger slow cough throb (start fade-in phase)
			state.gasCoughPhase = 1; // Start rising
			state.gasCoughTimer = 2 + Math.random() * 2; // Random interval 2-4s
		}
	}
	
	// Gradual fade-in and fade-out for cough throb
	if ((state.gasCoughFlash || 0) > 0 || state.gasCoughPhase === 1) {
		if (state.gasCoughPhase === 1) {
			// Fade in over 0.4 seconds (gradual buildup)
			state.gasCoughFlash = Math.min(1.0, (state.gasCoughFlash || 0) + dt * 2.5);
			if (state.gasCoughFlash >= 1.0) {
				state.gasCoughPhase = 2; // Switch to falling phase
			}
		} else if (state.gasCoughPhase === 2 || state.gasCoughFlash > 0) {
			// Fade out slowly over ~1.25s
			state.gasCoughFlash = Math.max(0, (state.gasCoughFlash || 0) - dt * 0.8);
			if (state.gasCoughFlash <= 0) {
				state.gasCoughPhase = 0; // Back to idle
			}
		}
	}
	
	// Show stamina drain text when in gas
	if ((state.gasFog || 0) > 0.1 && player && player.stamina < player.staminaMax) {
		// Show "-Stm" text periodically (every 0.5 seconds)
		if (!Number.isFinite(state.gasStaminaTextTimer)) state.gasStaminaTextTimer = 0;
		
		state.gasStaminaTextTimer -= dt;
		if (state.gasStaminaTextTimer <= 0) {
			if (window.enqueueDamageText) {
				window.enqueueDamageText({
					x: player.x,
					y: player.y - (player.radius || 26) - 15,
					text: '-Stm',
					crit: false,
					color: '#b366ff', // Purple
					vy: -50,
					life: 0.7,
					scale: 0.9
				});
			}
			state.gasStaminaTextTimer = 0.5; // Show every 0.5 seconds
		}
	}
	
        // NOTE: Shake timer decay moved to ClientRender.js (after render) to ensure at least one frame uses it
        // Previously this was causing double-decay (update + render) making shake last half as long
        // if (state.shakeTime > 0) {
        //         state.shakeTime -= dt;
        //         if (state.shakeTime < 0) state.shakeTime = 0;
        // }
        // Update shake frequency to ramp with progress (low -> higher)
        if (state.shakeTime > 0) {
                const ampEase = Math.max(0, Math.min(1, state.shakeProgress || 0));
                // Frequency from 0.6Hz up to ~3Hz as progress increases
                const targetHz = 0.6 + 2.4 * ampEase;
                // Smoothly lerp frequency to avoid abrupt jumps
                state.shakeFreqHz += (targetHz - (state.shakeFreqHz || 0)) * Math.min(1, dt * 8);
                // Advance phase
                state.shakePhase += (state.shakeFreqHz || 0) * dt * Math.PI * 2;
        }

        if (hereticExtractionZone && hereticExtractionZone.visible && typeof hereticExtractionZone.update === 'function') {
                const wasRunningH = hereticExtractionZone.started && !hereticExtractionZone.extracted;
                hereticExtractionZone.update(dt);
                const justCompletedH = wasRunningH && hereticExtractionZone.extracted;
                if (justCompletedH && !state.extractionEnd) {
                        const half = (hereticExtractionZone.size || 300) / 2;
                        const inZone = (px, py) => (px >= hereticExtractionZone.x - half && px <= hereticExtractionZone.x + half && py >= hereticExtractionZone.y - half && py <= hereticExtractionZone.y + half);
                        const playerIn = inZone(player.x, player.y);
                        let artifactIn = false;
                        for (let i = 0; i < chests.length; i++) {
                                const a = chests[i]?.artifact;
                                if (!a) continue;
                                const ax = a.carriedBy ? a.carriedBy.x : a.x;
                                const ay = a.carriedBy ? a.carriedBy.y : a.y;
                                artifactIn = inZone(ax, ay);
                                break;
                        }
                        
                        // Check if local player is evil
                        let isEvil = false;
                        try { isEvil = (typeof window !== 'undefined' && window.__killThemAllLocked === true); } catch(_) {}
                        
                        if (playerIn && artifactIn) {
                                // Evil players win with heretic ending, non-evil players lose
                                if (isEvil) {
                                        state.extractionEnd = { type: 'heretic', reason: 'The heretics have stolen the artifact' };
                                } else {
                                        state.extractionEnd = { type: 'lose', reason: 'The heretics have stolen the artifact' };
                                }
                                state.isFrozen = true;
                        } else {
                                state.extractionEnd = { type: 'lose', reason: 'The artifact was left behind' };
                        }
                }
                if (hereticExtractionZone.started && !hereticExtractionZone.extracted) {
                        let art = null;
                        for (let i = 0; i < chests.length; i++) { const a = chests[i]?.artifact; if (a) { art = a; break; } }
                        if (art && !art.carriedBy && art.onGround) {
                                const half = (hereticExtractionZone.size || 300) / 2;
                                const inZone = (px, py) => (px >= hereticExtractionZone.x - half && px <= hereticExtractionZone.x + half && py >= hereticExtractionZone.y - half && py <= hereticExtractionZone.y + half);
                                if (!inZone(art.x, art.y)) {
                                        hereticExtractionZone.started = false;
                                        hereticExtractionZone.timeLeft = 0;
                                }
                        }
                }
        }
}

// Export for use by GameLoop
window.clientUpdate = { update };

console.log('[ClientUpdate.js] ✅ Module loaded and clientUpdate exported');
