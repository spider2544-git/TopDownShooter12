// Client Render Module - Extracted from GameLoop.js Phase 5
// Contains all rendering/drawing logic
// Multiplayer-only game - no single-player fallbacks
// Phase 1: Now accepts ctx parameter for explicit dependencies

// Hard-off debug build flag (performance): keep debug overlays/logging in code, but make them unreachable by default.
// NOTE: This file is loaded as a classic script (shared global scope). Don't use top-level `const DEBUG_BUILD`.
var __DEBUG_BUILD = (typeof window !== 'undefined' && window.DEBUG_BUILD === true);

// ===== NAVMESH DEBUG OVERLAY (Trench Raid) =====
function _decodeNavRowRange(rowRLE, rowWidth, iStart, iEnd) {
	// Returns Uint8Array of walkable(0/1) for [iStart..iEnd] inclusive
	const outLen = Math.max(0, (iEnd - iStart + 1) | 0);
	const out = new Uint8Array(outLen);
	if (!rowRLE || outLen <= 0) return out;
	let idx = 0; // column index in full row
	let outIdx = 0;
	for (let k = 0; k < rowRLE.length; k += 2) {
		const val = rowRLE[k] ? 1 : 0;
		const len = rowRLE[k + 1] | 0;
		const runStart = idx;
		const runEnd = Math.min(rowWidth, idx + len) - 1;
		// Overlaps requested range?
		const a = Math.max(runStart, iStart);
		const b = Math.min(runEnd, iEnd);
		if (b >= a) {
			const count = (b - a + 1) | 0;
			out.fill(val, outIdx, outIdx + count);
			outIdx += count;
		}
		idx += len;
		if (idx >= rowWidth) break;
		if (outIdx >= outLen) break;
	}
	return out;
}

function drawNavMeshDebugOverlay(ctx, nav, cullBounds, cameraX, cameraY) {
	if (!nav || !nav.rowsRLE || !Number.isFinite(nav.cellSize)) return;
	const cs = nav.cellSize;
	const minX = nav.minX || 0;
	const minY = nav.minY || 0;
	const w = nav.w | 0;
	const h = nav.h | 0;
	if (w <= 0 || h <= 0) return;
	
	// #region agent log
	let renderedCells = 0;
	// #endregion

	// Only render when in Trench Raid LEVEL (not lobby)
	if (!window.scene || window.scene.current !== 'level') return;
	if (window.serverLevelType && window.serverLevelType !== 'trenchraid') return;

	// Visible grid range (world coords)
	const left = cullBounds?.left ?? (cameraX - 2000);
	const right = cullBounds?.right ?? (cameraX + 2000);
	const top = cullBounds?.top ?? (cameraY - 2000);
	const bottom = cullBounds?.bottom ?? (cameraY + 2000);

	let i0 = Math.floor((left - minX) / cs) - 1;
	let i1 = Math.floor((right - minX) / cs) + 1;
	let j0 = Math.floor((top - minY) / cs) - 1;
	let j1 = Math.floor((bottom - minY) / cs) + 1;
	if (i0 < 0) i0 = 0;
	if (j0 < 0) j0 = 0;
	if (i1 > w - 1) i1 = w - 1;
	if (j1 > h - 1) j1 = h - 1;
	if (i1 < i0 || j1 < j0) return;

	ctx.save();
	// Dark orange interior
	ctx.fillStyle = 'rgba(255, 140, 0, 0.16)';
	// Bright orange edges
	ctx.strokeStyle = 'rgba(255, 165, 0, 0.95)';
	ctx.lineWidth = 2;

	let prevRow = null;
	let currRow = null;
	let nextRow = null;

	ctx.beginPath();
	for (let j = j0; j <= j1; j++) {
		prevRow = (j > 0) ? _decodeNavRowRange(nav.rowsRLE[j - 1], w, i0, i1) : null;
		currRow = _decodeNavRowRange(nav.rowsRLE[j], w, i0, i1);
		nextRow = (j + 1 < h) ? _decodeNavRowRange(nav.rowsRLE[j + 1], w, i0, i1) : null;

		for (let ii = 0; ii < currRow.length; ii++) {
			const i = i0 + ii;
			if (currRow[ii] !== 1) continue;

			const x0w = minX + i * cs;
			const y0w = minY + j * cs;
			const x1w = x0w + cs;
			const y1w = y0w + cs;

			const x0 = x0w - cameraX;
			const y0 = y0w - cameraY;
			const x1 = x1w - cameraX;
			const y1 = y1w - cameraY;

			// Fill cell
			ctx.fillRect(x0, y0, cs, cs);
			
			// #region agent log
			renderedCells++;
			// #endregion

			// Edge checks (draw only boundary edges)
			const up = (j === 0) ? 0 : (prevRow ? prevRow[ii] : 0);
			const down = (j === h - 1) ? 0 : (nextRow ? nextRow[ii] : 0);
			const leftN = (i === 0) ? 0 : (ii > 0 ? currRow[ii - 1] : 0);
			const rightN = (i === w - 1) ? 0 : (ii + 1 < currRow.length ? currRow[ii + 1] : 0);

			if (up === 0) { ctx.moveTo(x0, y0); ctx.lineTo(x1, y0); }
			if (down === 0) { ctx.moveTo(x0, y1); ctx.lineTo(x1, y1); }
			if (leftN === 0) { ctx.moveTo(x0, y0); ctx.lineTo(x0, y1); }
			if (rightN === 0) { ctx.moveTo(x1, y0); ctx.lineTo(x1, y1); }
		}
	}
	ctx.stroke();
	
	// #region agent log
	if (__DEBUG_BUILD && Math.random() < 0.02) { // Log 2% of frames (debug-only)
		console.log('[DEBUG H5,H6] NavMesh render:', {renderedCells, totalRows:h, totalCols:w, visibleRange:{i0,i1,j0,j1}});
		fetch('http://127.0.0.1:7242/ingest/10317113-f3de-4c2b-9a23-83892ed269d3',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'ClientRender.js:drawNavMesh',message:'NavMesh render stats',data:{renderedCells,totalRows:h,totalCols:w,visibleRange:{i0,i1,j0,j1},bounds:{minX,minY,cs},cameraPos:{x:cameraX,y:cameraY}},timestamp:Date.now(),sessionId:'debug-session',hypothesisId:'H5,H6'})}).catch(()=>{});
	}
	// #endregion
	
	ctx.restore();
}
// ============================================

// Debug helper for gas zones - hard-disabled in normal play (DEBUG_BUILD=false).
if (__DEBUG_BUILD) {
	window.showGasZones = function() {
		window.DEBUG_GAS_ZONES = true;
		const hz = window.hazards;
		if (!hz || !hz.gasCanisters) {
			console.log('❌ No hazards or gas canisters found. Are you in the Trench Raid level?');
			return;
		}
		console.log('✅ Gas zones debug enabled! Found', hz.gasCanisters.length, 'gas canisters:');
		hz.gasCanisters.forEach((g, i) => {
			console.log(`  ${i+1}. ID: ${g.id}, Position: (${g.x.toFixed(1)}, ${g.y.toFixed(1)}), Radius: ${g.radius}`);
		});
	};
	window.hideGasZones = function() {
		window.DEBUG_GAS_ZONES = false;
		console.log('❌ Gas zones debug disabled');
	};
} else {
	// Keep the symbols defined for compatibility, but make them no-ops.
	window.showGasZones = window.showGasZones || function() {};
	window.hideGasZones = window.hideGasZones || function() {};
}

// Debug helper for troop stuck-avoid zones (server-side repulsion map)
// Use: `showTroopStuckZones()` / `hideTroopStuckZones()` in console.
// NOTE: intentionally NOT gated on __DEBUG_BUILD so it works in normal builds.
window.showTroopStuckZones = function() {
	window.DEBUG_TROOP_STUCK_ZONES = true;
	const z = window._debugTroopStuckZones;
	console.log('✅ Troop stuck zones debug enabled!', Array.isArray(z) ? `zones:${z.length}` : 'zones:n/a');
};
window.hideTroopStuckZones = function() {
	window.DEBUG_TROOP_STUCK_ZONES = false;
	console.log('❌ Troop stuck zones debug disabled');
};

// Helper function to determine Trench Raid zone based on player position
function getTrenchRaidZone(player) {
	// Check if we're in Trench Raid mode
	if (window.serverLevelType !== 'trenchraid') {
		return 'Not In TrenchRaid';
	}
	
	const x = player.x;
	
	// Define zone boundaries
	// New Antioch wall at -10200, Heretic wall at +10200
	if (x < -10200) return 'NewAntiochZone';  // Behind New Antioch wall (safe zone)
	if (x < -6800) return 'ZoneA';            // -10200 to -6800 (New Antioch front)
	if (x < -3400) return 'ZoneB';            // -6800 to -3400
	if (x < 0) return 'ZoneC';                // -3400 to 0
	if (x < 3400) return 'ZoneD';             // 0 to 3400
	if (x < 6800) return 'ZoneE';             // 3400 to 6800
	if (x < 10200) return 'ZoneF';            // 6800 to 10200 (Heretic front)
	return 'HereticZone';                     // Behind Heretic wall (safe zone)
}

// Draw loot notification as UI overlay
function drawLootNotification(ctx, player, camera) {
	if (!player || player.lootNotificationTimer <= 0 || !player.lootNotificationText) return;
	
	const screenX = player.x - camera.x;
	const screenY = player.y - camera.y;
	const textY = screenY - (player.radius || 26) - 70;
	
	ctx.save();
	
	// Animation timing
	const elapsed = player.lootNotificationStartTime ? (Date.now() - player.lootNotificationStartTime) / 1000 : 0;
	
	// Fade out in last 0.3 seconds
	let alpha = 1.0;
	if (player.lootNotificationTimer < 0.3) {
		alpha = player.lootNotificationTimer / 0.3;
	}
	
	// Arrow animation - faster, snappier bounce
	let arrowScale = 1.0;
	if (elapsed < 0.12) {
		const t = elapsed / 0.12;
		arrowScale = 0.3 + (1.2 - 0.3) * Player.easeOutElastic(t);
	} else if (elapsed < 0.22) {
		const t = (elapsed - 0.12) / 0.1;
		arrowScale = 1.2 - 0.2 * t;
	}
	
	// Text animation - slightly delayed, smoother bounce
	let textScale = 1.0;
	const textDelay = 0.05; // 50ms delay
	const textElapsed = Math.max(0, elapsed - textDelay);
	if (textElapsed < 0.18) {
		const t = textElapsed / 0.18;
		textScale = 0.5 + (1.15 - 0.5) * Player.easeOutElastic(t);
	} else if (textElapsed < 0.28) {
		const t = (textElapsed - 0.18) / 0.1;
		textScale = 1.15 - 0.15 * t;
	}
	
	// Colors based on up/down
	const isUp = player.lootNotificationType === 'up';
	const mainColor = isUp ? '#00ff66' : '#ff4444';
	const glowColor = isUp ? 'rgba(0, 255, 102, ' : 'rgba(255, 68, 68, ';
	const arrowDirection = isUp ? -1 : 1; // -1 for up, 1 for down
	
	ctx.textAlign = 'center';
	ctx.textBaseline = 'middle';
	
	// Subtle background glow (much reduced opacity) - uses text scale
	const gradient = ctx.createRadialGradient(screenX, textY, 0, screenX, textY, 60);
	gradient.addColorStop(0, glowColor + (0.15 * alpha) + ')');
	gradient.addColorStop(0.5, glowColor + (0.08 * alpha) + ')');
	gradient.addColorStop(1, glowColor + '0)');
	ctx.fillStyle = gradient;
	ctx.beginPath();
	ctx.arc(screenX, textY, 60 * textScale, 0, Math.PI * 2);
	ctx.fill();
	
	// Measure text to position arrow to the left
	const prefix = isUp ? '+' : '-';
	const displayText = `${prefix}${player.lootNotificationText}`;
	ctx.font = `bold ${Math.floor(18 * textScale)}px Arial`;
	const textWidth = ctx.measureText(displayText).width;
	
	// Arrow positioned to the left of text (uses arrow scale)
	const arrowSize = 27 * arrowScale; // Independent scale for arrow
	const arrowX = screenX - textWidth / 2 - 27 * 0.75; // Use base size for positioning
	const arrowY = textY - arrowSize * 0.1 - 9; // Shifted up to align with text center
	
	// Arrow shadow
	ctx.globalAlpha = alpha * 0.5;
	ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
	ctx.beginPath();
	// Arrow pointing up/down with better proportions
	if (arrowDirection === -1) { // Up arrow
		// Triangle tip (more stout)
		ctx.moveTo(arrowX + 2, arrowY + 2 - arrowSize * 0.6); // tip
		ctx.lineTo(arrowX - arrowSize * 0.5 + 2, arrowY + 2); // left of triangle
		ctx.lineTo(arrowX - arrowSize * 0.25 + 2, arrowY + 2); // inner left
		// Shaft (longer)
		ctx.lineTo(arrowX - arrowSize * 0.25 + 2, arrowY + 2 + arrowSize * 0.8);
		ctx.lineTo(arrowX + arrowSize * 0.25 + 2, arrowY + 2 + arrowSize * 0.8);
		// Right side
		ctx.lineTo(arrowX + arrowSize * 0.25 + 2, arrowY + 2);
		ctx.lineTo(arrowX + arrowSize * 0.5 + 2, arrowY + 2);
	} else { // Down arrow
		ctx.moveTo(arrowX + 2, arrowY + 2 + arrowSize * 0.6); // tip
		ctx.lineTo(arrowX - arrowSize * 0.5 + 2, arrowY + 2);
		ctx.lineTo(arrowX - arrowSize * 0.25 + 2, arrowY + 2);
		ctx.lineTo(arrowX - arrowSize * 0.25 + 2, arrowY + 2 - arrowSize * 0.8);
		ctx.lineTo(arrowX + arrowSize * 0.25 + 2, arrowY + 2 - arrowSize * 0.8);
		ctx.lineTo(arrowX + arrowSize * 0.25 + 2, arrowY + 2);
		ctx.lineTo(arrowX + arrowSize * 0.5 + 2, arrowY + 2);
	}
	ctx.closePath();
	ctx.fill();
	
	// Arrow main
	ctx.globalAlpha = alpha;
	ctx.fillStyle = mainColor;
	ctx.strokeStyle = '#ffffff';
	ctx.lineWidth = 2;
	ctx.beginPath();
	if (arrowDirection === -1) { // Up arrow
		ctx.moveTo(arrowX, arrowY - arrowSize * 0.6);
		ctx.lineTo(arrowX - arrowSize * 0.5, arrowY);
		ctx.lineTo(arrowX - arrowSize * 0.25, arrowY);
		ctx.lineTo(arrowX - arrowSize * 0.25, arrowY + arrowSize * 0.8);
		ctx.lineTo(arrowX + arrowSize * 0.25, arrowY + arrowSize * 0.8);
		ctx.lineTo(arrowX + arrowSize * 0.25, arrowY);
		ctx.lineTo(arrowX + arrowSize * 0.5, arrowY);
	} else { // Down arrow
		ctx.moveTo(arrowX, arrowY + arrowSize * 0.6);
		ctx.lineTo(arrowX - arrowSize * 0.5, arrowY);
		ctx.lineTo(arrowX - arrowSize * 0.25, arrowY);
		ctx.lineTo(arrowX - arrowSize * 0.25, arrowY - arrowSize * 0.8);
		ctx.lineTo(arrowX + arrowSize * 0.25, arrowY - arrowSize * 0.8);
		ctx.lineTo(arrowX + arrowSize * 0.25, arrowY);
		ctx.lineTo(arrowX + arrowSize * 0.5, arrowY);
	}
	ctx.closePath();
	ctx.fill();
	ctx.stroke();
	
	// Text shadow
	ctx.globalAlpha = alpha * 0.8;
	ctx.fillStyle = 'rgba(0, 0, 0, 0.9)';
	ctx.fillText(displayText, screenX + 2, textY + 2);
	
	// Main text with stroke
	ctx.globalAlpha = alpha;
	ctx.fillStyle = mainColor;
	ctx.strokeStyle = '#000000';
	ctx.lineWidth = 3;
	ctx.strokeText(displayText, screenX, textY);
	ctx.fillText(displayText, screenX, textY);
	
	ctx.restore();
}

function render(gameCtxParam) {
        // Phase 4: Use context with safe guards
        const gameCtx = gameCtxParam || window.ctx;
        
        // CRITICAL: Guard against uninitialized context
        if (!gameCtx) {
            console.error('[ClientRender] Context not initialized yet - window.ctx is undefined!');
            return;
        }
        
        const state = gameCtx.state;
        const player = gameCtx.player;
        const environment = gameCtx.environment;
        const enemies = gameCtx.enemies;
        const npcs = gameCtx.npcs;
        const ui = gameCtx.ui;
        const canvas = gameCtx.canvas;
        const ctx = gameCtx.canvasCtx; // 2D rendering context
        
        // CRITICAL: Guard against null objects during initialization
        if (!environment || !player || !enemies || !npcs || !ui || !ctx || !canvas) {
                // Rate-limited logging to avoid console spam during world load
                if (!window.__renderDeferredLastLog || (Date.now() - window.__renderDeferredLastLog) > 2000) {
                        console.log('[ClientRender] Waiting for world initialization...', {
                                environment: !!environment,
                                player: !!player,
                                enemies: !!enemies,
                                npcs: !!npcs,
                                ui: !!ui,
                                ctx: !!ctx,
                                canvas: !!canvas
                        });
                        window.__renderDeferredLastLog = Date.now();
                }
                return;
        }

	// Fill background in screen space BEFORE transforms (prevents dark areas when zooming)
	// This ensures the entire canvas is covered regardless of zoom level
	ctx.fillStyle = '#0e0e12'; // Match environment background color
	ctx.fillRect(0, 0, state.viewportWidth, state.viewportHeight);

        // Apply screen shake only to world layers (not UI)
        // Optimized: Calculate offsets once, apply transform once for all world elements
        let __shakeApplied = false;
        let shakeOffsetX = 0;
        let shakeOffsetY = 0;
        
        // Get zoom level for Weapon 8 ADS
        const zoomLevel = (window.clientRender && window.clientRender.zoomLevel) ? window.clientRender.zoomLevel : 1.0;
        
        // Calculate effective viewport size for culling (accounts for zoom)
        // When zoom < 1.0 (zoomed out), we see MORE area, so effective viewport is larger
        const effectiveViewportWidth = state.viewportWidth / zoomLevel;
        const effectiveViewportHeight = state.viewportHeight / zoomLevel;
        
        // Centralized culling bounds - used by ALL rendering systems for consistency
        const CULL_BUFFER = 1500; // Generous buffer to prevent pop-in
        const cullBounds = {
            left: state.cameraX - effectiveViewportWidth / 2 - CULL_BUFFER,
            right: state.cameraX + effectiveViewportWidth / 2 + CULL_BUFFER,
            top: state.cameraY - effectiveViewportHeight / 2 - CULL_BUFFER,
            bottom: state.cameraY + effectiveViewportHeight / 2 + CULL_BUFFER,
            width: effectiveViewportWidth,
            height: effectiveViewportHeight
        };
        
        // Always save context for transforms
        ctx.save();
        
        // Apply zoom transform FIRST (scale around screen center)
        if (zoomLevel !== 1.0) {
            const cx = state.viewportWidth / 2;
            const cy = state.viewportHeight / 2;
            ctx.translate(cx, cy);
            ctx.scale(zoomLevel, zoomLevel);
            ctx.translate(-cx, -cy);
        }
        
        // Apply shake transform if shaking
        if (state.shakeTime > 0 && state.shakeDur > 0) {
                const k = Math.max(0, Math.min(1, state.shakeTime / state.shakeDur));
                // Combine time-based ease and amplitude progress so shake starts soft and grows
                const timeEase = k * k; // ease-out for shake life
                const ampEase = Math.max(0, Math.min(1, state.shakeProgress || 0));
                const intensity = state.shakeMag * timeEase * (0.45 + 0.55 * ampEase);
                
                // Use original game's shake offset formula with rotating base axes
                const s = Math.sin(state.shakePhase || 0);
                const c = Math.cos((state.shakePhase || 0) * 0.8 + 1.1);
                const ax = state.shakeBaseAX || 1;
                const ay = state.shakeBaseAY || 0;
                shakeOffsetX = (ax * s + ay * c * 0.6) * intensity;
                shakeOffsetY = (ay * s + ax * c * 0.6) * intensity;
                
                ctx.translate(shakeOffsetX, shakeOffsetY);
                __shakeApplied = true;
        }

        // Fire pools should render ABOVE mud decals but BELOW walls/obstacles.
        // Mud decals are rendered inside environment.draw() via window.drawGroundDecals().
        // We hook fire pool rendering into environment.draw() right after decals but before obstacles.
        try {
            if (typeof window.drawGroundHazardsUnderObstacles !== 'function') {
                window.drawGroundHazardsUnderObstacles = function drawGroundHazardsUnderObstacles(ctx2, cam2, viewport2) {
                    try {
                        const hz = window.hazards;
                        if (!hz || (window.scene && window.scene.current !== 'level' && window.scene.current !== 'lobby')) return;

                        const serverPools = hz.firePools || [];
                        if (!window._envFirePools) window._envFirePools = new Map();

                        const poolIds = new Set();
                        for (let i = 0; i < serverPools.length; i++) {
                            const f = serverPools[i];
                            if (!f || !f.id) continue;
                            poolIds.add(f.id);
                            if (!window._envFirePools.has(f.id)) {
                                const pool = new window.EnvironmentFirePool(
                                    f.x,
                                    f.y,
                                    f.radius || 200,
                                    f.dotDps || 20,
                                    f.dotDuration || 3.0
                                );
                                pool._serverId = f.id;
                                pool.serverSync = true;
                                window._envFirePools.set(f.id, pool);
                                console.log('[ClientRender] Created EnvironmentFirePool instance:', f.id);
                            }
                        }

                        // Remove pools that no longer exist on server
                        for (const [id, pool] of window._envFirePools) {
                            if (!poolIds.has(id)) {
                                window._envFirePools.delete(id);
                                console.log('[ClientRender] Removed EnvironmentFirePool instance:', id);
                            }
                        }

                        const dt2 = (window.state && Number.isFinite(window.state._lastDt)) ? window.state._lastDt : 0.016;

                        // Optional viewport cull: if viewport2 includes cullBounds, skip far-off pools quickly
                        const bounds = viewport2 && viewport2.cullBounds ? viewport2.cullBounds : null;
                        const left = bounds ? bounds.left : null;
                        const right = bounds ? bounds.right : null;
                        const top = bounds ? bounds.top : null;
                        const bottom = bounds ? bounds.bottom : null;

                        for (const [id, pool] of window._envFirePools) {
                            if (!pool || !pool.alive) continue;
                            if (bounds) {
                                const r = pool.maxRadius || 200;
                                if (pool.x + r < left || pool.x - r > right || pool.y + r < top || pool.y - r > bottom) continue;
                            }
                            pool.update(dt2, window.environment, window.enemies, null);
                            pool.draw(ctx2, cam2);
                        }
                    } catch (err) {
                        console.error('[ClientRender] Fire pool under-obstacles rendering error:', err);
                    }
                };
            }
        } catch (_) {}

        environment.draw(ctx, { x: state.cameraX, y: state.cameraY }, { width: effectiveViewportWidth, height: effectiveViewportHeight, cullBounds: cullBounds });

        // Draw environment hazards (server-synced)
        (function drawHazards(){
                const hz = window.hazards;
                if (!hz || (scene.current !== 'level' && scene.current !== 'lobby')) return;
                const cam = { x: state.cameraX, y: state.cameraY };
                
                // Use centralized culling bounds
                const viewLeft = cullBounds.left;
                const viewRight = cullBounds.right;
                const viewTop = cullBounds.top;
                const viewBottom = cullBounds.bottom;
                
                ctx.save();
                // Sandbags: draw stacked rounded-bag silhouette over obstacle with states
                try {
                        const sbs = hz.sandbags || [];
                        for (let i = 0; i < sbs.length; i++) {
                                const sb = sbs[i]; if (!sb) continue;
                                
                                // VIEWPORT CULLING: skip if outside view
                                if (sb.x < viewLeft || sb.x > viewRight || sb.y < viewTop || sb.y > viewBottom) continue;
                                
                                // Normalize by healthMax if provided (server sends 300 max), else assume 300
                                const hMax = Number.isFinite(sb.healthMax) ? sb.healthMax : 300;
                                const hp = Math.max(0, Math.min(1, (sb.health ?? hMax) / hMax));
                                
                                // Helper to draw a capsule (rounded bag shape)
                                const capsule = (cx, cy, cw, ch, fill, stroke) => {
                                        const r = Math.min(ch/2, cw/4);
                                        ctx.fillStyle = fill; ctx.strokeStyle = stroke; ctx.lineWidth = 2;
                                        ctx.beginPath();
                                        ctx.moveTo(cx - cw/2 + r, cy - ch/2);
                                        ctx.lineTo(cx + cw/2 - r, cy - ch/2);
                                        ctx.quadraticCurveTo(cx + cw/2, cy - ch/2, cx + cw/2, cy);
                                        ctx.quadraticCurveTo(cx + cw/2, cy + ch/2, cx + cw/2 - r, cy + ch/2);
                                        ctx.lineTo(cx - cw/2 + r, cy + ch/2);
                                        ctx.quadraticCurveTo(cx - cw/2, cy + ch/2, cx - cw/2, cy);
                                        ctx.quadraticCurveTo(cx - cw/2, cy - ch/2, cx - cw/2 + r, cy - ch/2);
                                        ctx.closePath(); ctx.fill(); ctx.stroke();
                                };
                                
                                // Color grading by health (full → lighter, damaged → darker)
                                const base = (t) => `hsl(38deg, 25%, ${56 - 26*(1-t)}%)`;
                                const edge = '#3a3328';
                                
                                // Handle different variants
                                if (sb.variant === 'vertical') {
                                        // VERTICAL: Rotate the standard horizontal sandbag 90 degrees
                                        const x = sb.x - cam.x, y = sb.y - cam.y;
                                        
                                        ctx.save();
                                        ctx.translate(x, y);
                                        ctx.rotate(Math.PI / 2); // Rotate 90 degrees clockwise
                                        
                                        // Draw standard horizontal sandbag at origin (will be vertical after rotation)
                                        const w = sb.h, h = sb.w; // Swap dimensions for vertical orientation
                                        const rowH = h * 0.42, pad = 4, cw = (w - pad*2) / 3;
                                        
                                        if (hp > 0.66) {
                                                // Bottom row
                                                capsule(-cw - pad, h*0.22, cw, rowH, base(hp), edge);
                                                capsule(0, h*0.22, cw, rowH, base(hp*0.97), edge);
                                                capsule(cw + pad, h*0.22, cw, rowH, base(hp*0.94), edge);
                                                // Middle row
                                                const cw2 = (w - pad) * 0.80 / 2;
                                                capsule(-cw2/2 - pad/2, 0, cw2, rowH*1.12, base(hp*0.95), edge);
                                                capsule(cw2/2 + pad/2, 0, cw2, rowH*1.12, base(hp*0.92), edge);
                                                // Top
                                                capsule(0, -h*0.30, w * 0.50, rowH*0.90, base(hp*0.88), edge);
                                        } else if (hp > 0.33) {
                                                capsule(-cw - pad, h*0.22, cw, rowH, base(hp*0.95), edge);
                                                capsule(0, h*0.22, cw, rowH, base(hp*0.9), edge);
                                                capsule(cw + pad, h*0.22, cw, rowH, base(hp*0.85), edge);
                                                const cw2 = (w - pad) / 2;
                                                capsule(-cw2/2 - pad/2, 0, cw2*0.92, rowH*0.9, base(hp*0.85), edge);
                                                ctx.save();
                                                ctx.globalAlpha = 0.8;
                                                capsule(cw2/2 + pad/2 + 6, 0, cw2*0.78, rowH*0.85, base(hp*0.8), edge);
                                                ctx.restore();
                                        } else {
                                                capsule(-cw - pad, h*0.22, cw, rowH*0.95, base(hp*0.8), edge);
                                                capsule(cw + pad, h*0.22, cw, rowH*0.95, base(hp*0.78), edge);
                                                const midW = w * 0.46;
                                                capsule(0, -h*0.02, midW, rowH*0.80, base(hp*0.75), edge);
                                        }
                                        
                                        ctx.restore();
                                        
                                } else if (sb.variant === 'diagonalLeft' || sb.variant === 'diagonalRight') {
                                        // DIAGONAL: Rotate the standard horizontal sandbag
                                        const x = sb.x - cam.x, y = sb.y - cam.y;
                                        const angle = sb.variant === 'diagonalLeft' ? Math.PI / 4 : -Math.PI / 4;
                                        
                                        ctx.save();
                                        ctx.translate(x, y);
                                        ctx.rotate(angle);
                                        
                                        // Draw standard horizontal sandbag at origin
                                        const w = sb.w, h = sb.h;
                                        const rowH = h * 0.42, pad = 4, cw = (w - pad*2) / 3;
                                        
                                        if (hp > 0.66) {
                                                // Bottom row
                                                capsule(-cw - pad, h*0.22, cw, rowH, base(hp), edge);
                                                capsule(0, h*0.22, cw, rowH, base(hp*0.97), edge);
                                                capsule(cw + pad, h*0.22, cw, rowH, base(hp*0.94), edge);
                                                // Middle row
                                                const cw2 = (w - pad) * 0.80 / 2;
                                                capsule(-cw2/2 - pad/2, 0, cw2, rowH*1.12, base(hp*0.95), edge);
                                                capsule(cw2/2 + pad/2, 0, cw2, rowH*1.12, base(hp*0.92), edge);
                                                // Top
                                                capsule(0, -h*0.30, w * 0.50, rowH*0.90, base(hp*0.88), edge);
                                        } else if (hp > 0.33) {
                                                capsule(-cw - pad, h*0.22, cw, rowH, base(hp*0.95), edge);
                                                capsule(0, h*0.22, cw, rowH, base(hp*0.9), edge);
                                                capsule(cw + pad, h*0.22, cw, rowH, base(hp*0.85), edge);
                                                const cw2 = (w - pad) / 2;
                                                capsule(-cw2/2 - pad/2, 0, cw2*0.92, rowH*0.9, base(hp*0.85), edge);
                                                ctx.save();
                                                ctx.globalAlpha = 0.8;
                                                capsule(cw2/2 + pad/2 + 6, 0, cw2*0.78, rowH*0.85, base(hp*0.8), edge);
                                                ctx.restore();
                                        } else {
                                                capsule(-cw - pad, h*0.22, cw, rowH*0.95, base(hp*0.8), edge);
                                                capsule(cw + pad, h*0.22, cw, rowH*0.95, base(hp*0.78), edge);
                                                const midW = w * 0.46;
                                                capsule(0, -h*0.02, midW, rowH*0.80, base(hp*0.75), edge);
                                        }
                                        
                                        ctx.restore();
                                        
                                } else {
                                        // HORIZONTAL (default): Standard rendering
                                        const x = sb.x - cam.x, y = sb.y - cam.y, w = sb.w, h = sb.h;
                                        const rowH = h * 0.42, pad = 4, cw = (w - pad*2) / 3;
                                        
                                        if (hp > 0.66) {
                                                // Undamaged: 3 layers high
                                                capsule(x - cw - pad, y + h*0.22, cw, rowH, base(hp), edge);
                                                capsule(x, y + h*0.22, cw, rowH, base(hp*0.97), edge);
                                                capsule(x + cw + pad, y + h*0.22, cw, rowH, base(hp*0.94), edge);
                                                const cw2 = (w - pad) * 0.80 / 2;
                                                capsule(x - cw2/2 - pad/2, y - 0, cw2, rowH*1.12, base(hp*0.95), edge);
                                                capsule(x + cw2/2 + pad/2, y - 0, cw2, rowH*1.12, base(hp*0.92), edge);
                                                capsule(x, y - h*0.30, w * 0.50, rowH*0.90, base(hp*0.88), edge);
                                        } else if (hp > 0.33) {
                                                // Damaged state
                                                capsule(x - cw - pad, y + h*0.22, cw, rowH, base(hp*0.95), edge);
                                                capsule(x, y + h*0.22, cw, rowH, base(hp*0.9), edge);
                                                capsule(x + cw + pad, y + h*0.22, cw, rowH, base(hp*0.85), edge);
                                                const cw2 = (w - pad) / 2;
                                                capsule(x - cw2/2 - pad/2, y - 0, cw2*0.92, rowH*0.9, base(hp*0.85), edge);
                                                ctx.save();
                                                ctx.globalAlpha = 0.8;
                                                capsule(x + cw2/2 + pad/2 + 6, y - 0, cw2*0.78, rowH*0.85, base(hp*0.8), edge);
                                                ctx.restore();
                                                // Crack lines
                                                ctx.strokeStyle = 'rgba(30,25,20,0.45)'; ctx.lineWidth = 1;
                                                ctx.beginPath();
                                                ctx.moveTo(x - w*0.22, y - h*0.06); ctx.lineTo(x - w*0.10, y + h*0.12);
                                                ctx.moveTo(x + w*0.12, y - h*0.02); ctx.lineTo(x + w*0.24, y + h*0.14);
                                                ctx.stroke();
                                        } else {
                                                // Heavily damaged
                                                capsule(x - cw - pad, y + h*0.22, cw, rowH*0.95, base(hp*0.8), edge);
                                                capsule(x + cw + pad, y + h*0.22, cw, rowH*0.95, base(hp*0.78), edge);
                                                const midW = w * 0.46;
                                                capsule(x, y - h*0.02, midW, rowH*0.80, base(hp*0.75), edge);
                                                ctx.fillStyle = base(hp*0.7);
                                                ctx.beginPath();
                                                ctx.arc(x - w*0.22, y + h*0.16, 3, 0, Math.PI*2);
                                                ctx.arc(x + w*0.20, y + h*0.18, 2.5, 0, Math.PI*2);
                                                ctx.fill();
                                        }
                                        // Seams
                                        ctx.strokeStyle = 'rgba(30,25,20,' + (hp > 0.66 ? 0.35 : 0.55) + ')'; ctx.lineWidth = 1;
                                        ctx.beginPath();
                                        ctx.moveTo(x - w*0.28, y + h*0.1); ctx.lineTo(x - w*0.28, y - h*0.15);
                                        ctx.moveTo(x + w*0.28, y + h*0.1); ctx.lineTo(x + w*0.28, y - h*0.15);
                                        ctx.stroke();
                                }
                        }
                } catch(_) {}
                // Draw barbed wire, mud, trenches, fire
                // Barbed wire (4 WW1-inspired variants) with realistic sharp barbs + CANVAS CACHING
                try {
                        const wires = hz.barbedWire || [];
                        
                        // Initialize canvas cache for static wire rendering (render once, reuse forever)
                        if (!window._wireCanvasCache) {
                                window._wireCanvasCache = new Map();
                        }
                        
                        // Helper to draw an optimized barb to an offscreen context
                        const drawBarbToOffscreen = (offCtx, cx, cy, angle, size = 8) => {
                                offCtx.strokeStyle = '#888888';
                                offCtx.lineWidth = 1.5;
                                offCtx.beginPath();
                                for (let i = 0; i < 4; i++) {
                                        const barbAngle = angle + (i * Math.PI / 2);
                                        offCtx.moveTo(cx, cy);
                                        offCtx.lineTo(
                                                cx + Math.cos(barbAngle) * size,
                                                cy + Math.sin(barbAngle) * size
                                        );
                                }
                                offCtx.stroke();
                                
                                if (size > 4) {
                                        offCtx.fillStyle = '#666666';
                                        offCtx.beginPath();
                                        offCtx.arc(cx, cy, size * 0.2, 0, Math.PI * 2);
                                        offCtx.fill();
                                }
                        };
                        
                        for (let i = 0; i < wires.length; i++) {
                                const w = wires[i]; if (!w) continue;
                                
                                // VIEWPORT CULLING: skip if outside view
                                const wx = w.centerX || w.x || 0;
                                const wy = w.centerY || w.y || 0;
                                if (wx < viewLeft - 400 || wx > viewRight + 400 || wy < viewTop - 400 || wy > viewBottom + 400) continue;
                                
                                // Check if we have a cached canvas for this wire
                                const wireId = w.id || `wire_${i}`;
                                let cachedCanvas = window._wireCanvasCache.get(wireId);
                                
                                // If not cached, render to offscreen canvas once
                                if (!cachedCanvas) {
                                        const cacheSize = 500;
                                        const offCanvas = document.createElement('canvas');
                                        offCanvas.width = cacheSize;
                                        offCanvas.height = cacheSize;
                                        const offCtx = offCanvas.getContext('2d');
                                        const centerOffset = cacheSize / 2;
                                        const wireColor = '#4a4a4a';
                                
                                        // Render wire variants to offscreen canvas (centered, without camera offset)
                                        if (w.variant === 'tangled' && w.segments) {
                                                offCtx.strokeStyle = wireColor;
                                                offCtx.lineWidth = 2;
                                                for (const seg of w.segments) {
                                                        offCtx.beginPath();
                                                        offCtx.moveTo(seg.x1 - wx + centerOffset, seg.y1 - wy + centerOffset);
                                                        offCtx.lineTo(seg.x2 - wx + centerOffset, seg.y2 - wy + centerOffset);
                                                        offCtx.stroke();
                                                        const dx = seg.x2 - seg.x1;
                                                        const dy = seg.y2 - seg.y1;
                                                        const segAngle = Math.atan2(dy, dx);
                                                        for (let b = 0; b < 3; b++) {
                                                                const t = (b + 1) / 4;
                                                                const bx = seg.x1 + dx * t - wx + centerOffset;
                                                                const by = seg.y1 + dy * t - wy + centerOffset;
                                                                drawBarbToOffscreen(offCtx, bx, by, segAngle + (b * 0.3), 6);
                                                        }
                                                }
                                        } else if (w.variant === 'spiral' && w.spiral) {
                                                const pts = w.spiral.points;
                                                if (pts.length > 1) {
                                                        offCtx.strokeStyle = wireColor;
                                                        offCtx.lineWidth = 2.5;
                                                        offCtx.beginPath();
                                                        offCtx.moveTo(pts[0].x - wx + centerOffset, pts[0].y - wy + centerOffset);
                                                        for (let j = 1; j < pts.length; j++) {
                                                                offCtx.lineTo(pts[j].x - wx + centerOffset, pts[j].y - wy + centerOffset);
                                                        }
                                                        offCtx.stroke();
                                                        for (let j = 2; j < pts.length - 2; j += 4) {
                                                                const dx = pts[j+1].x - pts[j-1].x;
                                                                const dy = pts[j+1].y - pts[j-1].y;
                                                                const angle = Math.atan2(dy, dx);
                                                                drawBarbToOffscreen(offCtx, pts[j].x - wx + centerOffset, pts[j].y - wy + centerOffset, angle, 7);
                                                        }
                                                }
                                        } else if (w.variant === 'tripleConcertina' && w.concertina) {
                                                offCtx.strokeStyle = '#3a3a3a';
                                                offCtx.lineWidth = 5;
                                                if (w.concertina.posts) {
                                                        for (const post of w.concertina.posts) {
                                                                const px = post.x - wx + centerOffset;
                                                                const py = post.y - wy + centerOffset;
                                                                offCtx.beginPath();
                                                                offCtx.moveTo(px, py - post.height / 2);
                                                                offCtx.lineTo(px, py + post.height / 2);
                                                                offCtx.stroke();
                                                        }
                                                }
                                                offCtx.strokeStyle = wireColor;
                                                offCtx.lineWidth = 2.5;
                                                for (const row of w.concertina.rows) {
                                                        for (const coil of row.coils) {
                                                                const cx = coil.x - wx + centerOffset;
                                                                const cy = coil.y - wy + centerOffset;
                                                                offCtx.beginPath();
                                                                offCtx.arc(cx, cy, coil.radius, 0, Math.PI * 2);
                                                                offCtx.stroke();
                                                                for (let a = 0; a < 8; a++) {
                                                                        const angle = (a / 8) * Math.PI * 2;
                                                                        const bx = cx + Math.cos(angle) * coil.radius;
                                                                        const by = cy + Math.sin(angle) * coil.radius;
                                                                        drawBarbToOffscreen(offCtx, bx, by, angle + Math.PI/4, 6);
                                                                }
                                                        }
                                                }
                                        } else if (w.variant === 'doubleApron' && w.apron) {
                                                for (const stake of w.apron.stakes) {
                                                        offCtx.fillStyle = '#3a3a3a';
                                                        offCtx.strokeStyle = '#3a3a3a';
                                                        offCtx.lineWidth = 5;
                                                        offCtx.beginPath();
                                                        offCtx.arc(stake.x - wx + centerOffset, stake.y - wy + centerOffset, 5, 0, Math.PI * 2);
                                                        offCtx.fill();
                                                        
                                                        offCtx.strokeStyle = wireColor;
                                                        offCtx.lineWidth = 2;
                                                        for (const wire of stake.wires) {
                                                                offCtx.beginPath();
                                                                offCtx.moveTo(wire.x1 - wx + centerOffset, wire.y1 - wy + centerOffset);
                                                                offCtx.lineTo(wire.x2 - wx + centerOffset, wire.y2 - wy + centerOffset);
                                                                offCtx.stroke();
                                                                const mx = (wire.x1 + wire.x2) / 2 - wx + centerOffset;
                                                                const my = (wire.y1 + wire.y2) / 2 - wy + centerOffset;
                                                                const wireAngle = Math.atan2(wire.y2 - wire.y1, wire.x2 - wire.x1);
                                                                drawBarbToOffscreen(offCtx, mx, my, wireAngle, 5);
                                                        }
                                                }
                                        } else if (w.x1 != null && w.y1 != null && w.x2 != null && w.y2 != null) {
                                                offCtx.strokeStyle = wireColor;
                                                offCtx.lineWidth = 2.5;
                                                offCtx.beginPath();
                                                offCtx.moveTo(w.x1 - wx + centerOffset, w.y1 - wy + centerOffset);
                                                offCtx.lineTo(w.x2 - wx + centerOffset, w.y2 - wy + centerOffset);
                                                offCtx.stroke();
                                                const dx = w.x2 - w.x1;
                                                const dy = w.y2 - w.y1;
                                                const len = Math.sqrt(dx*dx + dy*dy);
                                                const angle = Math.atan2(dy, dx);
                                                const barbCount = Math.floor(len / 40);
                                                for (let b = 0; b < barbCount; b++) {
                                                        const t = (b + 1) / (barbCount + 1);
                                                        const bx = w.x1 + dx * t - wx + centerOffset;
                                                        const by = w.y1 + dy * t - wy + centerOffset;
                                                        drawBarbToOffscreen(offCtx, bx, by, angle + (b * 0.5), 7);
                                                }
                                        }
                                        
                                        // Cache the rendered canvas
                                        cachedCanvas = offCanvas;
                                        window._wireCanvasCache.set(wireId, cachedCanvas);
                                }
                                
                                // Draw the cached canvas to the main canvas (with camera offset)
                                if (cachedCanvas) {
                                        ctx.drawImage(cachedCanvas, wx - cam.x - 250, wy - cam.y - 250);
                                }
                        }
                } catch(_) {}
		// Mud pools are now rendered as ground decals (handled by drawGroundDecals)
		// This section kept for backwards compatibility but does nothing
		try {
			// Mud pool decals are spawned in main.js when hazards are received
		} catch(_) {}
		// Trenches
		try {
			const trenches = hz.trenches || [];
			for (let i = 0; i < trenches.length; i++) {
				const t = trenches[i]; if (!t) continue;
				ctx.fillStyle = '#2a2216';
				ctx.strokeStyle = '#0f0c08';
				ctx.globalAlpha = 0.9;
				ctx.beginPath();
				ctx.rect(t.x - t.w / 2 - cam.x + 0.5, t.y - t.h / 2 - cam.y + 0.5, t.w, t.h);
				ctx.fill();
				ctx.stroke();
				ctx.globalAlpha = 1.0;
			}
		} catch(_) {}
		// Fire pools are rendered inside environment.draw() via window.drawGroundHazardsUnderObstacles,
		// so they appear ABOVE mud decals but BELOW walls/obstacles.
		
		// Gas canisters - use MustardGasCanister instances for chlorine gas visuals
		try {
			// Initialize gas canister instance cache if needed
			if (!window._envGasCanisters) window._envGasCanisters = new Map();
			
			const serverCanisters = hz.gasCanisters || [];
			const canisterIds = new Set();
			
			// Create or update gas canister instances
			for (let i = 0; i < serverCanisters.length; i++) {
				const g = serverCanisters[i];
				if (!g || !g.id) continue;
				
				canisterIds.add(g.id);
				
				if (!window._envGasCanisters.has(g.id)) {
					// Create new MustardGasCanister instance
					const canister = new window.MustardGasCanister(
						null, // owner
						g.x, 
						g.y, 
						0, // angle
						{} // progression mods
					);
					canister._serverId = g.id;
					canister.serverSync = true;
					window._envGasCanisters.set(g.id, canister);
					if (__DEBUG_BUILD) console.log('[ClientRender] Created MustardGasCanister instance:', g.id);
				}
			}
			
			// Remove canisters that no longer exist on server
			for (const [id, canister] of window._envGasCanisters) {
				if (!canisterIds.has(id)) {
					window._envGasCanisters.delete(id);
					if (__DEBUG_BUILD) console.log('[ClientRender] Removed MustardGasCanister instance:', id);
				}
			}
			
		// Update and draw all gas canister instances
		const dt = Number.isFinite(state._lastDt) ? state._lastDt : 0.016;
		for (const [id, canister] of window._envGasCanisters) {
			if (canister && canister.alive) {
				canister.update(dt, window.environment, window.enemies, null);
				canister.draw(ctx, cam);
			}
		}
		
	// DEBUG: Show gas effect zones (outer = light, middle = medium, inner = full)
	// Enable by typing in console: window.DEBUG_GAS_ZONES = true
	if (__DEBUG_BUILD && window.DEBUG_GAS_ZONES) {
		console.log('[DEBUG] Drawing gas zones for', serverCanisters.length, 'canisters');
		ctx.save();
		for (let i = 0; i < serverCanisters.length; i++) {
			const g = serverCanisters[i];
			if (!g) continue;
			
		// Center effect on gas cloud - raised so bottom of red circle touches barrel
		// Red circle radius = 70% of 180px = 126px, so offset by -126px to have bottom at barrel
		const gasCloudOffsetY = -126;
		const sx = g.x - cam.x;
		const sy = g.y - cam.y + gasCloudOffsetY;
		const radius = g.radius || 180;
			
			console.log('[DEBUG] Gas canister', g.id, 'at screen pos:', sx, sy, 'radius:', radius);
			
			// Outer circle - light effect zone (full radius)
			ctx.strokeStyle = 'rgba(255, 255, 0, 0.4)'; // Yellow - light effect
			ctx.lineWidth = 3;
			ctx.beginPath();
			ctx.arc(sx, sy, radius, 0, Math.PI * 2);
			ctx.stroke();
			
			// Middle circle - medium effect zone (85% radius - just inside edge)
			ctx.strokeStyle = 'rgba(255, 165, 0, 0.6)'; // Orange - medium effect
			ctx.lineWidth = 3;
			ctx.beginPath();
			ctx.arc(sx, sy, radius * 0.85, 0, Math.PI * 2);
			ctx.stroke();
			
			// Inner circle - full effect zone (70% radius - much larger)
			ctx.strokeStyle = 'rgba(255, 0, 0, 0.8)'; // Red - full effect
			ctx.lineWidth = 3;
			ctx.beginPath();
			ctx.arc(sx, sy, radius * 0.70, 0, Math.PI * 2);
			ctx.stroke();
			
			// Draw center point (where effect is centered)
			ctx.fillStyle = 'rgba(255, 0, 0, 0.9)';
			ctx.beginPath();
			ctx.arc(sx, sy, 5, 0, Math.PI * 2);
			ctx.fill();
			
			// Draw canister position for reference
			ctx.fillStyle = 'rgba(0, 255, 255, 0.6)';
			ctx.beginPath();
			ctx.arc(g.x - cam.x, g.y - cam.y, 3, 0, Math.PI * 2);
			ctx.fill();
			
			// Label with ID
			ctx.fillStyle = '#ffffff';
			ctx.strokeStyle = '#000000';
			ctx.lineWidth = 2;
			ctx.font = 'bold 14px monospace';
			ctx.textAlign = 'center';
			ctx.textBaseline = 'middle';
			ctx.strokeText(g.id, sx, sy - radius - 15);
			ctx.fillText(g.id, sx, sy - radius - 15);
		}
		ctx.restore();
	}
	} catch(err) {
		console.error('[ClientRender] Gas canister rendering error:', err);
	}

                // Exploding barrels - drawn after drawHazards() but before weapon 8 clip (so they stay visible through fog)

                // Sandbag hit VFX (dust cloud + falling grains)
                try {
                        window._hazardVfx = window._hazardVfx || { sand: [], sandGrains: [], sandDust: [] };
                        const dtV = Number.isFinite(state._lastDt) ? state._lastDt : 0.016;
                        const dust = window._hazardVfx.sandDust;
                        for (let i = dust.length - 1; i >= 0; i--) {
                                const d = dust[i]; if (!d) { dust.splice(i,1); continue; }
                                d.life -= dtV; if (d.life <= 0) { dust.splice(i,1); continue; }
                                d.r += (d.vr || 80) * dtV;
                                const a = Math.max(0, d.life / d.total);
                                ctx.globalAlpha = 0.25 * a;
                                ctx.fillStyle = d.color || '#d9c99a';
                                ctx.beginPath();
                                ctx.arc(d.x - cam.x, d.y - cam.y, d.r, 0, Math.PI * 2);
                                ctx.fill();
                                ctx.globalAlpha = 1;
                        }
                        const grains = window._hazardVfx.sandGrains;
                        for (let i = grains.length - 1; i >= 0; i--) {
                                const g = grains[i]; if (!g) { grains.splice(i,1); continue; }
                                g.life -= dtV; if (g.life <= 0) { grains.splice(i,1); continue; }
                                g.x += g.vx * dtV; g.y += g.vy * dtV; g.vy += 520 * dtV;
                                const a = Math.max(0, g.life / g.total);
                                ctx.globalAlpha = 0.85 * a;
                                ctx.fillStyle = g.color || '#cbb98a';
                                ctx.beginPath();
                                ctx.arc(g.x - cam.x, g.y - cam.y, g.r, 0, Math.PI * 2);
                                ctx.fill();
                                ctx.globalAlpha = 1;
                        }
                } catch(_) {}

                // Ground sand piles (walkable visuals after destruction)
                try {
                        const piles = hz.sandPiles || [];
                        for (let i = 0; i < piles.length; i++) {
                                const p = piles[i]; if (!p) continue;
                                const px = p.x - cam.x, py = p.y - cam.y;
                                // For vertical piles, swap w and h before rotation to maintain correct visual dimensions
                                const baseW = p.variant === 'vertical' ? (p.h || 220) : (p.w || 220);
                                const baseH = p.variant === 'vertical' ? (p.w || 36) : (p.h || 36);
                                const w = baseW * 0.9, h = baseH * 2.2;
                                // Irregular soft blob (shape cached per pile)
                                if (!p._shape) {
                                        p._shape = {
                                                a1x: -0.35 + (Math.random() * 0.14 - 0.07),
                                                a1y: -0.25 + (Math.random() * 0.08 - 0.04),
                                                a2x: 0.35 + (Math.random() * 0.14 - 0.07),
                                                a2y: -0.25 + (Math.random() * 0.08 - 0.04),
                                                b1x: 0.35 + (Math.random() * 0.14 - 0.07),
                                                b1y: 0.25 + (Math.random() * 0.08 - 0.04),
                                                b2x: -0.35 + (Math.random() * 0.14 - 0.07),
                                                b2y: 0.25 + (Math.random() * 0.08 - 0.04)
                                        };
                                }
                                // Apply rotation for diagonal and vertical piles
                                const isDiagonal = (p.variant === 'diagonalLeft' || p.variant === 'diagonalRight') && p.angle != null;
                                const isVertical = p.variant === 'vertical';
                                if (isDiagonal || isVertical) {
                                        ctx.save();
                                        ctx.translate(px, py);
                                        if (isDiagonal) {
                                                ctx.rotate(p.angle);
                                        } else if (isVertical) {
                                                ctx.rotate(Math.PI / 2); // Rotate vertical sand 90 degrees
                                        }
                                }
                                
                                const drawX = (isDiagonal || isVertical) ? 0 : px;
                                const drawY = (isDiagonal || isVertical) ? 0 : py;
                                
                                ctx.beginPath();
                                ctx.moveTo(drawX - w*0.5, drawY);
                                ctx.bezierCurveTo(drawX + w*p._shape.a1x, drawY + h*p._shape.a1y, drawX + w*p._shape.a2x, drawY + h*p._shape.a2y, drawX + w*0.5, drawY);
                                ctx.bezierCurveTo(drawX + w*p._shape.b1x, drawY + h*p._shape.b1y, drawX + w*p._shape.b2x, drawY + h*p._shape.b2y, drawX - w*0.5, drawY);
                                const grd = ctx.createRadialGradient(drawX, drawY, 4, drawX, drawY, Math.max(w, h));
                                grd.addColorStop(0, 'rgba(210, 190, 140, 0.95)');
                                grd.addColorStop(0.85, 'rgba(170, 150, 110, 0.55)');
                                grd.addColorStop(1, 'rgba(170, 150, 110, 0.0)');
                                ctx.fillStyle = grd;
                                ctx.fill();
                                ctx.strokeStyle = 'rgba(70,60,45,0.35)';
                                ctx.lineWidth = 1;
                                ctx.stroke();
                                // Speckle pass (cached pattern)
                                if (!p._specks) {
                                        p._specks = [];
                                        const n = 60;
                                        for (let s = 0; s < n; s++) {
                                                const rx = (Math.random() * 0.9 - 0.45) * w;
                                                const ry = (Math.random() * 0.4 - 0.2) * h;
                                                const rr = 1 + Math.random() * 2;
                                                const a = 0.25 + Math.random() * 0.35;
                                                p._specks.push({ rx, ry, rr, a, c: Math.random() < 0.5 ? '#cbb98a' : '#b09a6a' });
                                        }
                                }
                                for (let s = 0; s < (p._specks?.length || 0); s++) {
                                        const sp = p._specks[s];
                                        ctx.globalAlpha = sp.a;
                                        ctx.fillStyle = sp.c;
                                        ctx.beginPath();
                                        ctx.arc(drawX + sp.rx, drawY + sp.ry, sp.rr, 0, Math.PI * 2);
                                        ctx.fill();
                                }
                                ctx.globalAlpha = 1;
                                
                                if (isDiagonal || isVertical) {
                                        ctx.restore();
                                }
                        }
                } catch(_) {}
                ctx.restore();
        })();

        // Exploding barrels - draw BEFORE weapon 8 clip so they're always visible (like other hazards)
        try {
            const hz = window.hazards;
            const cam = { x: state.cameraX, y: state.cameraY };
            if (hz && hz.explodingBarrels) {
                const serverBarrels = hz.explodingBarrels || [];
                const barrelTime = Date.now() * 0.001;
                
                // Initialize smoke particle system for barrels if needed
                if (!window._barrelSmoke) window._barrelSmoke = new Map();
                
                for (let i = 0; i < serverBarrels.length; i++) {
                    const b = serverBarrels[i];
                    if (!b || b.exploded) continue;
                    
                    const sx = b.x - cam.x;
                    const sy = b.y - cam.y;
                    
                    // Barrel dimensions (same as gas canister)
                    const w = 28;  // width
                    const h = 36;  // height
                    
                    // Cull if off-screen
                    if (sx < -w - 50 || sx > ctx.canvas.width + w + 50 ||
                        sy < -h - 50 || sy > ctx.canvas.height + h + 50) continue;
                    
                    // Slight bobbing animation
                    const bob = Math.sin(barrelTime * 1.5 + i) * 1.5;
                    const cy = sy + bob;
                    
                    ctx.save();
                    
                    // Warning glow when damaged
                    const healthPct = b.health / b.healthMax;
                    if (healthPct < 1) {
                        const urgency = 1 + (1 - healthPct) * 4;
                        const pulse = 0.5 + Math.sin(barrelTime * urgency) * 0.5;
                        ctx.globalAlpha = 0.3 + pulse * 0.5;
                        const glowGrad = ctx.createRadialGradient(sx, cy, 0, sx, cy, w + 15 + pulse * 8);
                        glowGrad.addColorStop(0, 'rgba(255, 100, 0, 0.8)');
                        glowGrad.addColorStop(0.5, 'rgba(255, 50, 0, 0.4)');
                        glowGrad.addColorStop(1, 'rgba(255, 0, 0, 0)');
                        ctx.fillStyle = glowGrad;
                        ctx.beginPath();
                        ctx.arc(sx, cy, w + 15 + pulse * 8, 0, Math.PI * 2);
                        ctx.fill();
                    }
                    
                    // Shadow
                    ctx.globalAlpha = 0.3;
                    ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
                    ctx.beginPath();
                    ctx.ellipse(sx, sy + h * 0.5 + 2, w * 0.5, w * 0.15, 0, 0, Math.PI * 2);
                    ctx.fill();
                    
                    ctx.globalAlpha = 1;
                    
                    // Main canister body (oil drum shape) - RED
                    ctx.fillStyle = '#8B1A1A';  // Dark red
                    ctx.beginPath();
                    ctx.roundRect(sx - w * 0.5, cy - h * 0.5, w, h, 3);
                    ctx.fill();
                    
                    // Barrel ridges (horizontal lines)
                    ctx.strokeStyle = '#4a0d0d';
                    ctx.lineWidth = 1.5;
                    for (let ri = -1; ri <= 1; ri++) {
                        const ry = cy + ri * h * 0.25;
                        ctx.beginPath();
                        ctx.moveTo(sx - w * 0.5, ry);
                        ctx.lineTo(sx + w * 0.5, ry);
                        ctx.stroke();
                    }
                    
                    // Highlight edge (left side)
                    ctx.strokeStyle = '#cc3333';
                    ctx.lineWidth = 2;
                    ctx.beginPath();
                    ctx.moveTo(sx - w * 0.35, cy - h * 0.5);
                    ctx.lineTo(sx - w * 0.35, cy + h * 0.5);
                    ctx.stroke();
                    
                    // Rust/damage spots
                    ctx.globalAlpha = 0.5;
                    ctx.fillStyle = '#5a2020';
                    const rustSeeds = [0.2, -0.3, 0.35, -0.15, -0.4];
                    for (let rs = 0; rs < 3; rs++) {
                        const rx = sx + rustSeeds[rs] * w * 0.8;
                        const ry = cy + rustSeeds[(rs + 2) % 5] * h * 0.7;
                        ctx.beginPath();
                        ctx.arc(rx, ry, 2 + rs, 0, Math.PI * 2);
                        ctx.fill();
                    }
                    
                    // Flame vent on top (pulsing)
                    ctx.globalAlpha = 1;
                    const ventGlow = 0.5 + Math.sin(barrelTime * 4 + i) * 0.5;
                    const ventGrad = ctx.createRadialGradient(sx, cy - h * 0.5, 0, sx, cy - h * 0.5, 8);
                    ventGrad.addColorStop(0, `rgba(255, 150, 0, ${ventGlow})`);
                    ventGrad.addColorStop(0.5, `rgba(255, 80, 0, ${ventGlow * 0.5})`);
                    ventGrad.addColorStop(1, 'rgba(255, 0, 0, 0)');
                    ctx.fillStyle = ventGrad;
                    ctx.beginPath();
                    ctx.arc(sx, cy - h * 0.5, 8, 0, Math.PI * 2);
                    ctx.fill();
                    
                    // Hazard symbol (simple fire icon) - yellow/orange
                    ctx.globalAlpha = 0.9;
                    ctx.fillStyle = '#ffaa00';
                    ctx.beginPath();
                    // Simple flame shape - teardrop/fire silhouette
                    const fx = sx;
                    const fy = cy;
                    const fs = 8; // flame scale
                    ctx.moveTo(fx, fy - fs * 1.2);           // top point
                    ctx.quadraticCurveTo(fx + fs, fy - fs * 0.3, fx + fs * 0.6, fy + fs * 0.8);  // right curve
                    ctx.quadraticCurveTo(fx + fs * 0.2, fy + fs * 0.4, fx, fy + fs * 0.2);       // right inner
                    ctx.quadraticCurveTo(fx - fs * 0.2, fy + fs * 0.4, fx - fs * 0.6, fy + fs * 0.8); // left inner
                    ctx.quadraticCurveTo(fx - fs, fy - fs * 0.3, fx, fy - fs * 1.2);             // left curve back to top
                    ctx.fill();
                    
                    // Inner flame highlight
                    ctx.fillStyle = '#ffdd44';
                    ctx.globalAlpha = 0.7;
                    ctx.beginPath();
                    const ifs = fs * 0.5; // inner flame scale
                    ctx.moveTo(fx, fy - ifs * 0.8);
                    ctx.quadraticCurveTo(fx + ifs * 0.7, fy, fx + ifs * 0.4, fy + ifs * 0.6);
                    ctx.quadraticCurveTo(fx, fy + ifs * 0.3, fx - ifs * 0.4, fy + ifs * 0.6);
                    ctx.quadraticCurveTo(fx - ifs * 0.7, fy, fx, fy - ifs * 0.8);
                    ctx.fill();
                    
                    ctx.restore();
                    
                    // Smoke when below 50% health (fusing)
                    if (healthPct <= 0.5) {
                        // Get or create smoke particles for this barrel
                        if (!window._barrelSmoke.has(b.id)) {
                            window._barrelSmoke.set(b.id, []);
                        }
                        const smoke = window._barrelSmoke.get(b.id);
                        
                        // Spawn new smoke particles
                        const spawnRate = 3 + (1 - healthPct) * 5; // More smoke as health decreases
                        if (Math.random() < spawnRate * 0.016) { // ~60fps adjusted
                            smoke.push({
                                x: b.x + (Math.random() - 0.5) * 10,
                                y: b.y - h * 0.4,
                                vx: (Math.random() - 0.5) * 20,
                                vy: -40 - Math.random() * 30,
                                size: 8 + Math.random() * 8,
                                life: 0.8 + Math.random() * 0.4,
                                maxLife: 1.2
                            });
                        }
                        
                        // Update and draw smoke
                        const dt = 0.016;
                        for (let si = smoke.length - 1; si >= 0; si--) {
                            const s = smoke[si];
                            s.x += s.vx * dt;
                            s.y += s.vy * dt;
                            s.vy -= 20 * dt; // float up faster
                            s.size += 15 * dt; // expand
                            s.life -= dt;
                            
                            if (s.life <= 0) {
                                smoke.splice(si, 1);
                                continue;
                            }
                            
                            const alpha = (s.life / s.maxLife) * 0.5;
                            const smokeX = s.x - cam.x;
                            const smokeY = s.y - cam.y;
                            
                            ctx.save();
                            ctx.globalAlpha = alpha;
                            ctx.fillStyle = '#444444';
                            ctx.beginPath();
                            ctx.arc(smokeX, smokeY, s.size, 0, Math.PI * 2);
                            ctx.fill();
                            ctx.restore();
                        }
                    } else {
                        // Clear smoke if health recovered above 50%
                        window._barrelSmoke.delete(b.id);
                    }
                }
                
                // Clean up smoke for removed barrels
                for (const [barrelId] of window._barrelSmoke) {
                    if (!serverBarrels.find(b => b.id === barrelId)) {
                        window._barrelSmoke.delete(barrelId);
                    }
                }
            }
        } catch(err) {
            console.error('[ClientRender] Barrel rendering error:', err);
        }

        // Draw level decorations (static background objects like RadioTower)
        (function drawDecorations() {
            try {
                // Initialize decorations for trench raid mode if not already done
                if (window.serverLevelType === 'trenchraid' && !window._decorationsInitialized) {
                    window._decorations = [];
                    // Radio Tower position comes from server (random in Zone C or D)
                    // RadioTower is created in networking.js when batteryStationState is received
                    // This ensures all clients see the tower at the same server-determined position
                    window._decorationsInitialized = true;
                }
                
                // Clear decorations when leaving trench raid
                if (window.serverLevelType !== 'trenchraid' && window._decorationsInitialized) {
                    window._decorations = [];
                    window._decorationsInitialized = false;
                    // Also clear battery system
                    window._batteryStation = null;
                    window._batteries = [];
                }
                
                const cam = { x: state.cameraX, y: state.cameraY };
                const dt = 1/60; // Approximate dt for animations
                
                // Update and draw all decorations (including RadioTower)
                const decorations = window._decorations || [];
                for (let i = 0; i < decorations.length; i++) {
                    const dec = decorations[i];
                    if (dec) {
                        // Update for animations (blinking lights, etc)
                        if (typeof dec.update === 'function') {
                            dec.update(dt);
                        }
                        if (typeof dec.draw === 'function') {
                            dec.draw(ctx, cam);
                        }
                    }
                }
                
                // Draw battery station (cable and slots)
                if (window._batteryStation) {
                    const station = window._batteryStation;
                    if (typeof station.update === 'function') {
                        station.update(dt);
                    }
                    if (typeof station.draw === 'function') {
                        station.draw(ctx, cam, player);
                    }
                }
                
                // Draw batteries (on ground or carried)
                const batteries = window._batteries || [];
                for (let i = 0; i < batteries.length; i++) {
                    const bat = batteries[i];
                    if (bat) {
                        // Update battery position if carried by local player
                        if (typeof bat.update === 'function') {
                            const screenX = player.x - state.cameraX;
                            const screenY = player.y - state.cameraY;
                            const dxAim = state.mouse.x - screenX;
                            const dyAim = state.mouse.y - screenY;
                            const aimAngle = Math.atan2(dyAim, dxAim);
                            bat.update(dt, player, aimAngle);
                        }
                        if (typeof bat.draw === 'function') {
                            bat.draw(ctx, cam, player);
                        }
                    }
                }
            } catch(err) {
                console.error('[ClientRender] Decoration rendering error:', err);
            }
        })();

        // Weapon 8 Vision Cone - Apply clipping mask before drawing abilities/enemies/NPCs
        let weapon8ClipApplied = false;
        if (projectiles && projectiles.currentIndex === 7 && player && environment) {
                ctx.save();
                // Account for zoom when calculating world mouse position
                const screenCenterX = state.viewportWidth / 2;
                const screenCenterY = state.viewportHeight / 2;
                const aimX = state.cameraX + screenCenterX + (state.mouse.x - screenCenterX) / zoomLevel;
                const aimY = state.cameraY + screenCenterY + (state.mouse.y - screenCenterY) / zoomLevel;
                weapon8ClipApplied = applyWeapon8VisionClip(ctx, player, aimX, aimY, environment, state.cameraX, state.cameraY);
        }

        // Draw abilities (behind enemies for proper z-sorting) - clipped by weapon 8 vision
        if (window.abilityManager) {
                window.abilityManager.draw(ctx, { x: state.cameraX, y: state.cameraY }, player);
        }

        // Behind-enemy bullet layer
        if (typeof projectiles.drawLayer === 'function') projectiles.drawLayer(ctx, { x: state.cameraX, y: state.cameraY }, true);
        enemies.draw(ctx, { x: state.cameraX, y: state.cameraY }, { width: effectiveViewportWidth, height: effectiveViewportHeight, cullBounds: cullBounds });
        // Draw neutral NPCs between enemies and player so player renders on top
        // Instead of drawing barks here, collect NPCs and draw barks at the very end over overlays
        window._npcBarkList = [];
        npcs.draw(ctx, { x: state.cameraX, y: state.cameraY }, { width: effectiveViewportWidth, height: effectiveViewportHeight, cullBounds: cullBounds });
        
        // Draw barracks (spawn buildings for troops)
        if (window._barracks && Array.isArray(window._barracks)) {
            for (let i = 0; i < window._barracks.length; i++) {
                const barracks = window._barracks[i];
                if (!barracks) continue;
                
                const sx = barracks.x - state.cameraX;
                const sy = barracks.y - state.cameraY;
                
                ctx.save();
                
                // Bunker base (octagon shape)
                const size = 50;
                ctx.fillStyle = '#3a5a4a'; // Dark military green
                ctx.strokeStyle = '#2a3a2a'; // Darker outline
                ctx.lineWidth = 4;
                ctx.beginPath();
                for (let a = 0; a < 8; a++) {
                    const angle = (a / 8) * Math.PI * 2;
                    const x = sx + Math.cos(angle) * size;
                    const y = sy + Math.sin(angle) * size;
                    if (a === 0) ctx.moveTo(x, y);
                    else ctx.lineTo(x, y);
                }
                ctx.closePath();
                ctx.fill();
                ctx.stroke();
                
                // Door/opening (dark rectangle)
                ctx.fillStyle = '#1a1a1a';
                ctx.fillRect(sx - 20, sy - 8, 40, 16);
                
                // Roof detail (lighter top)
                ctx.fillStyle = '#4a6a5a';
                ctx.beginPath();
                for (let a = 0; a < 8; a++) {
                    const angle = (a / 8) * Math.PI * 2 - Math.PI / 16;
                    const r = a % 2 === 0 ? size * 0.8 : size * 0.6;
                    const x = sx + Math.cos(angle) * r;
                    const y = sy + Math.sin(angle) * r;
                    if (a === 0) ctx.moveTo(x, y);
                    else ctx.lineTo(x, y);
                }
                ctx.closePath();
                ctx.fill();
                
                // New Antioch flag emblem (small teal diamond)
                ctx.fillStyle = '#4db3b3';
                ctx.strokeStyle = '#2d7a7a';
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.moveTo(sx, sy - size * 0.7);
                ctx.lineTo(sx + 8, sy - size * 0.5);
                ctx.lineTo(sx, sy - size * 0.3);
                ctx.lineTo(sx - 8, sy - size * 0.5);
                ctx.closePath();
                ctx.fill();
                ctx.stroke();
                
                ctx.restore();
            }
        }
        
        // Draw allied troops (New Antioch soldiers)
        if (window.troops && Array.isArray(window.troops.items)) {
            for (let i = 0; i < window.troops.items.length; i++) {
                const troop = window.troops.items[i];
                if (troop && typeof troop.update === 'function') troop.update(state._lastDt || 0.016);
                if (troop && typeof troop.draw === 'function') troop.draw(ctx, { x: state.cameraX, y: state.cameraY });
            }
        }

        // Debug: draw server-side troop "stuck avoid zones" overlay in world space
        if (window.DEBUG_TROOP_STUCK_ZONES === true) {
            const zones = window._debugTroopStuckZones;
            if (Array.isArray(zones) && zones.length) {
                ctx.save();
                for (let i = 0; i < zones.length; i++) {
                    const z = zones[i];
                    if (!z) continue;
                    const sx = (z.x || 0) - state.cameraX;
                    const sy = (z.y || 0) - state.cameraY;
                    const r = Math.max(0, z.r || 0);
                    if (r <= 0) continue;

                    const kind = z.kind || 'stuck';
                    const stroke =
                        (kind === 'wallHit') ? 'rgba(255, 220, 80, 0.95)' :
                        (kind === 'fireDeath') ? 'rgba(120, 220, 255, 0.95)' :
                        'rgba(255, 80, 80, 0.9)';
                    const fill =
                        (kind === 'wallHit') ? 'rgba(255, 220, 80, 0.35)' :
                        (kind === 'fireDeath') ? 'rgba(120, 220, 255, 0.35)' :
                        'rgba(255, 80, 80, 0.6)';

                    // Outer ring
                    ctx.globalAlpha = 0.35;
                    ctx.strokeStyle = stroke;
                    ctx.lineWidth = 2;
                    ctx.beginPath();
                    ctx.arc(sx, sy, r, 0, Math.PI * 2);
                    ctx.stroke();

                    // Inner fill (very light)
                    ctx.globalAlpha = 0.10;
                    ctx.fillStyle = fill;
                    ctx.beginPath();
                    ctx.arc(sx, sy, r, 0, Math.PI * 2);
                    ctx.fill();

                    // TTL label (optional)
                    if (typeof z.ttl === 'number') {
                        ctx.globalAlpha = 0.9;
                        ctx.fillStyle =
                            (kind === 'wallHit') ? 'rgba(255, 220, 80, 0.95)' :
                            (kind === 'fireDeath') ? 'rgba(120, 220, 255, 0.95)' :
                            'rgba(255, 80, 80, 0.95)';
                        ctx.font = '10px monospace';
                        ctx.fillText(`${kind} ttl:${z.ttl.toFixed(1)}`, sx + 6, sy - 6);
                    }

                    // Direction arrow (suggested "walk out" direction for stuck, detour direction for fireDeath)
                    if (kind === 'stuck' || kind === 'fireDeath') {
                        let ax = 0, ay = 0;
                        if (Number.isFinite(z.tx) && Number.isFinite(z.ty)) {
                            ax = (z.tx - (z.x || 0));
                            ay = (z.ty - (z.y || 0));
                        } else if (Number.isFinite(z.dirX) && Number.isFinite(z.dirY)) {
                            ax = z.dirX;
                            ay = z.dirY;
                        }
                        const ad = Math.hypot(ax, ay);
                        if (ad > 0.001) {
                            const ux = ax / ad;
                            const uy = ay / ad;
                            const len = Math.min(90, Math.max(35, r * 0.65));
                            const ang = Math.atan2(uy, ux);

                            ctx.globalAlpha = 0.95;
                            const arrowCol = (kind === 'fireDeath')
                                ? 'rgba(120, 220, 255, 0.95)'
                                : 'rgba(255, 120, 120, 0.95)';
                            ctx.strokeStyle = arrowCol;
                            ctx.fillStyle = arrowCol;
                            ctx.lineWidth = 2;

                            // Draw a 15° cone (±7.5°) instead of a single arrow.
                            const half = (15 * Math.PI / 180) * 0.5;
                            const a0 = ang - half;
                            const a1 = ang + half;

                            // Fill (light)
                            ctx.save();
                            ctx.globalAlpha = 0.18;
                            ctx.beginPath();
                            ctx.moveTo(sx, sy);
                            ctx.arc(sx, sy, len, a0, a1);
                            ctx.closePath();
                            ctx.fill();
                            ctx.restore();

                            // Outline (strong)
                            ctx.globalAlpha = 0.95;
                            ctx.beginPath();
                            ctx.moveTo(sx, sy);
                            ctx.arc(sx, sy, len, a0, a1);
                            ctx.closePath();
                            ctx.stroke();
                        }
                    }
                }
                ctx.restore();
            }

            // Debug: draw per-troop zoneEscape arrow (direction red zones are making troops walk)
            if (window.troops && Array.isArray(window.troops.items)) {
                ctx.save();
                ctx.lineWidth = 2;
                ctx.globalAlpha = 0.9;
                ctx.strokeStyle = 'rgba(80, 220, 255, 0.95)';
                ctx.fillStyle = 'rgba(80, 220, 255, 0.95)';
                ctx.font = '10px monospace';

                for (let i = 0; i < window.troops.items.length; i++) {
                    const t = window.troops.items[i];
                    if (!t || t.alive === false) continue;
                    if (t._debugAvoidPhase !== 'zoneEscape') continue;
                    if (!Number.isFinite(t._debugEscapeTx) || !Number.isFinite(t._debugEscapeTy)) continue;

                    const x0 = (t.x || 0) - state.cameraX;
                    const y0 = (t.y || 0) - state.cameraY;
                    const x1 = (t._debugEscapeTx || 0) - state.cameraX;
                    const y1 = (t._debugEscapeTy || 0) - state.cameraY;

                    const dx = x1 - x0;
                    const dy = y1 - y0;
                    const d = Math.hypot(dx, dy);
                    if (!Number.isFinite(d) || d < 4) continue;
                    const ux = dx / d;
                    const uy = dy / d;

                    // Shaft
                    ctx.beginPath();
                    ctx.moveTo(x0, y0);
                    ctx.lineTo(x1, y1);
                    ctx.stroke();

                    // Arrow head
                    const head = 10;
                    const leftX = x1 - ux * head - uy * (head * 0.55);
                    const leftY = y1 - uy * head + ux * (head * 0.55);
                    const rightX = x1 - ux * head + uy * (head * 0.55);
                    const rightY = y1 - uy * head - ux * (head * 0.55);

                    ctx.beginPath();
                    ctx.moveTo(x1, y1);
                    ctx.lineTo(leftX, leftY);
                    ctx.lineTo(rightX, rightY);
                    ctx.closePath();
                    ctx.fill();

                    // Label near troop
                    ctx.fillText('escape', x0 + 10, y0 - 10);
                }

                ctx.restore();
            }
        }
        
        // Restore context if weapon 8 clipping was applied
        if (weapon8ClipApplied) {
                ctx.restore();
        }
        // Refresh world mouse (in case camera moved this frame) - account for zoom
        try { 
            const _cx = state.viewportWidth / 2;
            const _cy = state.viewportHeight / 2;
            window._mouseWorldX = state.cameraX + _cx + (state.mouse.x - _cx) / zoomLevel; 
            window._mouseWorldY = state.cameraY + _cy + (state.mouse.y - _cy) / zoomLevel; 
        } catch(_) {}
        // Aim override for weapon 7: snap facing to hovered target if present, else red priority
        let __aimX = state.mouse.x, __aimY = state.mouse.y;
        
        try {
                if (projectiles && projectiles.currentIndex === 6 && state.mouseDown && enemies && typeof enemies.queryCircle === 'function') {
                        const radius = 350;
                        let active = null;
                        // Mouse-over wins
                        try {
                                // Account for zoom when calculating world mouse position
                                const _mcx = state.viewportWidth / 2;
                                const _mcy = state.viewportHeight / 2;
                                const mwx = state.cameraX + _mcx + (state.mouse.x - _mcx) / zoomLevel;
                                const mwy = state.cameraY + _mcy + (state.mouse.y - _mcy) / zoomLevel;
                                const hover = enemies.queryCircle(mwx, mwy, 80) || [];
                                let bestHoverD2 = Infinity;
                                for (let i = 0; i < hover.length; i++) {
                                        const e = hover[i];
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
                                const list = enemies.queryCircle(player.x, player.y, radius) || [];
                                let bestD2 = Infinity;
                                for (let i = 0; i < list.length; i++) {
                                        const e = list[i];
                                        if (!e || !e.alive) continue;
                                        const dx = e.x - player.x;
                                        const dy = e.y - player.y;
                                        const d2 = dx * dx + dy * dy;
                                        if (d2 < bestD2) { bestD2 = d2; active = e; }
                                }
                        }
                        if (active) { __aimX = active.x - state.cameraX; __aimY = active.y - state.cameraY; }
                }
        } catch(_) {}
        player.draw(ctx, { x: state.cameraX, y: state.cameraY }, { x: __aimX, y: __aimY });
        
        // Render other players in world-space (inside zoom transform)
        // This ensures they scale correctly with ADS zoom
        renderOtherPlayers(ctx);

        // Hold '-' (Minus) to show what the local player last collided with
        if (state.keys && state.keys.Minus) {
                drawPlayerCollisionDebug(ctx, state, window.environment || environment, player);
        }

        // Navmesh debug overlay (drawn OVER world so you can verify coverage)
        // DISABLED: Causes significant FPS drop (~29fps). Server-side pathfinding still works.
        // To re-enable: uncomment the lines below
        // try {
        //         const dbg = window.navMeshDebug;
        //         const nav = dbg && dbg.nav ? dbg.nav : null;
        //         if (nav) drawNavMeshDebugOverlay(ctx, nav, cullBounds, state.cameraX, state.cameraY);
        // } catch(_) {}
        
        // Draw persistent weapon 7 reloading label if present
        try {
                if (projectiles && projectiles.currentIndex === 6 && state.mouseDown && (projectiles.ammo7ReloadTimer || 0) > 0 && window.player) {
                        const pr = window.player.radius || 26;
                        const sx = window.player.x - state.cameraX;
                        const sy = window.player.y - state.cameraY - (pr + 18);
                        ctx.save();
                        ctx.globalAlpha = 1;
                        ctx.font = 'bold 18px sans-serif';
                        ctx.textAlign = 'center';
                        ctx.textBaseline = 'bottom';
                        ctx.lineWidth = 4;
                        ctx.strokeStyle = 'rgba(0,0,0,0.7)';
                        ctx.strokeText('Reloading', sx, sy);
                        ctx.fillStyle = '#ffffff';
                        ctx.fillText('Reloading', sx, sy);
                        ctx.restore();
                } else {
                        try { window._weapon7ReloadingLabel = null; } catch(_) {}
                }
        } catch(_) {}
        // NPC talk tooltip when near
        (function drawNpcTalkHint(){
                if (dialogue && dialogue.open) return;
                let nearest = null; let bestD2 = Infinity; let talkR = 0;
                for (let i = 0; i < npcs.items.length; i++) {
                        const n = npcs.items[i];
                        if (!n || !n.alive) continue;
                        // Suppress talk hint for NPCs that disabled talk (or currently following)
                        if (n._disableTalk || n.state === 'follow') continue;
                        const dx = n.x - player.x, dy = n.y - player.y;
                        const d2 = dx*dx + dy*dy;
                        let r = (n.radius || 24) + (player.radius || 26) + 36;
                        try { if (typeof n.talkRangeBoost === 'number') r += Math.max(0, n.talkRangeBoost); } catch(_) {}
                        if (d2 <= r * r && d2 < bestD2) { bestD2 = d2; nearest = n; talkR = r; }
                }
                if (nearest) {
                        // Suppress NPC bark bubble while talk hint is showing
                        try { if (nearest._bark) { nearest._bark.visible = false; nearest._bark.phase = 'gap'; nearest._bark.timer = Math.max(nearest._bark.timer, 0.25); } } catch(_) {}
                        state.talkHintNpcId = nearest.id;
                        const sx = nearest.x - state.cameraX;
                        const sy = nearest.y - state.cameraY;
                        const label = 'Press E to Talk';
                        ctx.save();
                        ctx.font = 'bold 16px sans-serif';
                        ctx.textAlign = 'center';
                        ctx.textBaseline = 'middle';
                        const metrics = ctx.measureText(label);
                        const tw = Math.ceil(metrics.width);
                        const th = 22;
                        const padX = 10, padY = 6;
                        const bx = Math.round(sx - tw / 2 - padX);
                        const by = Math.round(sy - (nearest.radius || 24) - 36 - th / 2 - padY);
                        const bw = Math.round(tw + padX * 2);
                        const bh = Math.round(th + padY * 2);
                        // Box
                        ctx.fillStyle = 'rgba(0,0,0,0.65)';
                        ctx.strokeStyle = 'rgba(255,255,255,0.25)';
                        ctx.lineWidth = 2;
                        ctx.beginPath();
                        ctx.rect(bx + 0.5, by + 0.5, bw, bh);
                        ctx.fill();
                        ctx.stroke();
                        // Text
                        ctx.fillStyle = '#ffffff';
                        ctx.fillText(label, Math.round(sx), Math.round(by + bh / 2));
                        ctx.restore();
                } else {
                        state.talkHintNpcId = null;
                }
        })();
        // Draw chests and artifacts on top of ground, below bullets front layer
        for (let i = 0; i < chests.length; i++) chests[i].draw(ctx, { x: state.cameraX, y: state.cameraY }, player);
        // Draw currency pickups (ducats and blood markers)
        if (Array.isArray(window.ducatPickups)) {
                for (let i = 0; i < window.ducatPickups.length; i++) {
                        const d = window.ducatPickups[i];
                        if (d && typeof d.draw === 'function') d.draw(ctx, { x: state.cameraX, y: state.cameraY });
                }
        }
        if (Array.isArray(window.bloodMarkerPickups)) {
                for (let i = 0; i < window.bloodMarkerPickups.length; i++) {
                        const m = window.bloodMarkerPickups[i];
                        if (m && typeof m.draw === 'function') m.draw(ctx, { x: state.cameraX, y: state.cameraY });
                }
        }
        // Draw extraction zone overlay and UI
        if (scene.current === 'level' && extractionZone && typeof extractionZone.draw === 'function') extractionZone.draw(ctx, { x: state.cameraX, y: state.cameraY }, player);
        if (scene.current === 'level' && hereticExtractionZone && typeof hereticExtractionZone.draw === 'function') hereticExtractionZone.draw(ctx, { x: state.cameraX, y: state.cameraY }, player);
        // Draw Ready to Deploy zone in lobby
        if (scene.current === 'lobby') {
                if (!window._readyZone && window.GameObjects && window.GameObjects.ReadyZone) {
                        window._readyZone = new window.GameObjects.ReadyZone(0, 0, 300);
                }
                if (window._readyZone && typeof window._readyZone.draw === 'function') {
                        window._readyZone.draw(ctx, { x: state.cameraX, y: state.cameraY }, player);
                }
        }
    // Draw boss drops
    (function drawBossDrops(){
        // Boss drops are also used for server-authoritative inventory drops.
        // Allow them in the lobby so players can drop/trade gear there.
        if (scene.current !== 'level' && scene.current !== 'lobby') return;
        const arr = window.bossDrops || [];
        for (let i = 0; i < arr.length; i++) {
            const d = arr[i];
            if (d && typeof d.draw === 'function') d.draw(ctx, { x: state.cameraX, y: state.cameraY });
        }
    })();
        // Front bullet layer (and VFX)
        if (typeof projectiles.drawLayer === 'function') projectiles.drawLayer(ctx, { x: state.cameraX, y: state.cameraY }, false);
        else projectiles.draw(ctx, { x: state.cameraX, y: state.cameraY });
        
        // Draw gas canister smoke particles OVER players (like fire smoke)
        try {
            if (window._envGasCanisters) {
                const cam = { x: state.cameraX, y: state.cameraY };
                for (const [id, canister] of window._envGasCanisters) {
                    if (canister && canister.alive && typeof canister.drawTopLayer === 'function') {
                        canister.drawTopLayer(ctx, cam);
                    }
                }
            }
        } catch(err) {
            console.error('[ClientRender] Gas canister top layer rendering error:', err);
        }

        // Draw secondary fire placement indicators
        if (projectiles && typeof projectiles.drawSecondaryIndicator === 'function') {
                projectiles.drawSecondaryIndicator(ctx, { x: state.cameraX, y: state.cameraY });
        }

        // Draw world-space overlays (affected by zoom/shake) BEFORE restoring context
        // These are visual effects that exist in world space and should scale with zoom
        
	// Draw global smoke particles (renders ABOVE everything including players!)
	(function drawGlobalSmoke() {
		if (!window._globalSmokeParticles || !Array.isArray(window._globalSmokeParticles)) return;
		if (window._globalSmokeParticles.length === 0) return;
		
		// No sprite cache needed - using flat colors for maximum performance
		
		ctx.save();
		
		// Use centralized culling bounds
		const viewLeft = cullBounds.left;
		const viewRight = cullBounds.right;
		const viewTop = cullBounds.top;
		const viewBottom = cullBounds.bottom;
                
		for (let i = 0; i < window._globalSmokeParticles.length; i++) {
			const p = window._globalSmokeParticles[i];
			if (!p || p.type !== 'smoke') continue;
			
			// Viewport culling - skip particles completely off-screen
			if (p.x < viewLeft || p.x > viewRight || p.y < viewTop || p.y > viewBottom) continue;
			
			const px = p.x - state.cameraX;
			const py = p.y - state.cameraY;
			const pFade = p.life / p.maxLife;
			
			// Lower opacity with variation per particle (very transparent)
			const baseOpacity = p.opacity || 0.125; // Half again: 0.125 (was 0.25)
			const fadeMultiplier = pFade > 0.7 ? 1.0 : (pFade > 0.3 ? 0.85 : pFade * 1.2);
			ctx.globalAlpha = baseOpacity * fadeMultiplier;
			
			// Performance: Simple flat grey circles (no gradients!)
			ctx.fillStyle = p.color || '#454545'; // Use flat color from particle
			ctx.beginPath();
			ctx.arc(px, py, p.size, 0, Math.PI * 2);
			ctx.fill();
		}
                
                ctx.restore();
        })();

        // Gas fog of war overlay (mustard gas reduces visibility severely) - SCREEN SPACE (centered on player)
        // PERF: Render the gradients to a low-res offscreen canvas and only refresh at ~15-30Hz.
        // This avoids heavy per-frame gradient allocation + full-screen fill spikes during bullet-heavy scenes.
        (function renderGasFogOptimized(){
                try {
                        if (!player) return;
                        const gas = (state.gasFog || 0);
                        if (gas <= 0.001) return;

                        const f = Math.max(0, Math.min(1, gas));
                        const coughActive = ((state.gasCoughFlash || 0) > 0.01 && gas > 0.3);
                        const throbIntensity = coughActive ? Math.max(0, Math.min(1, state.gasCoughFlash || 0)) : 0;

                        const w = state.viewportWidth;
                        const h = state.viewportHeight;
                        if (!(w > 0 && h > 0)) return;

                        const dtNow = Number.isFinite(state._lastDt) ? state._lastDt : 0.016;
                        const perfLow = dtNow > 0.022; // ~45fps threshold
                        const perfVeryLow = dtNow > 0.03; // ~33fps threshold

                        // Center vignette on player's screen position, not viewport center
                        const playerScreenX = player.x - state.cameraX;
                        const playerScreenY = player.y - state.cameraY;

                        // Cache stored on window (classic script)
                        const cache = (typeof window !== 'undefined')
                                ? (window.__gasFogOverlayCache || (window.__gasFogOverlayCache = {}))
                                : {};

                        const scale = perfVeryLow ? 0.22 : (perfLow ? 0.28 : 0.36);
                        const rw = Math.max(2, Math.floor(w * scale));
                        const rh = Math.max(2, Math.floor(h * scale));

                        const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
                        const intervalMs = perfLow ? 66 : 33; // ~15Hz low perf, ~30Hz normal

                        // Quantize params so tiny changes don't trigger rebuilds
                        const fQ = Math.round(f * 24);
                        const tQ = Math.round(throbIntensity * 24);
                        const xQ = Math.round(playerScreenX * scale);
                        const yQ = Math.round(playerScreenY * scale);
                        const key = `${rw}x${rh}|f${fQ}|t${tQ}|x${xQ}|y${yQ}`;

                        const needsResize = (!cache.canvas || cache.rw !== rw || cache.rh !== rh);
                        const needsRefresh = needsResize || cache.key !== key || !cache.lastMs || (now - cache.lastMs) >= intervalMs;

                        if (needsResize) {
                                cache.canvas = document.createElement('canvas');
                                cache.canvas.width = rw;
                                cache.canvas.height = rh;
                                cache.ctx = cache.canvas.getContext('2d');
                                cache.rw = rw;
                                cache.rh = rh;
                                cache.lastMs = 0;
                        }

                        if (needsRefresh && cache.ctx) {
                                const gctx = cache.ctx;
                                gctx.clearRect(0, 0, rw, rh);

                                const psx = playerScreenX * scale;
                                const psy = playerScreenY * scale;

                                const maxR = Math.hypot(w / 2, h / 2) * 1.5;
                                const innerR = Math.max(60, maxR * 0.05);
                                const outerR = maxR;
                                const innerRS = innerR * scale;
                                const outerRS = outerR * scale;

                                // Baseline gas fog - VERY DARK
                                const grad = gctx.createRadialGradient(psx, psy, innerRS, psx, psy, outerRS);
                                const a = Math.pow(f, 0.8) * 0.99;
                                grad.addColorStop(0, 'rgba(0, 0, 0, 0)');
                                grad.addColorStop(0.12, `rgba(50, 45, 12, ${a * 0.85})`);
                                grad.addColorStop(0.4, `rgba(30, 25, 8, ${a * 0.95})`);
                                grad.addColorStop(1, `rgba(15, 10, 3, ${a * 0.99})`);
                                gctx.fillStyle = grad;
                                gctx.fillRect(0, 0, rw, rh);

                                // Cough throb overlay (extra darkness)
                                if (coughActive && throbIntensity > 0.01) {
                                        const grad2 = gctx.createRadialGradient(psx, psy, (maxR * 0.1) * scale, psx, psy, outerRS);
                                        const alpha = throbIntensity * 0.7;
                                        grad2.addColorStop(0, 'rgba(0, 0, 0, 0)');
                                        grad2.addColorStop(0.3, `rgba(0, 0, 0, ${alpha * 0.5})`);
                                        grad2.addColorStop(0.7, `rgba(0, 0, 0, ${alpha * 0.8})`);
                                        grad2.addColorStop(1, `rgba(0, 0, 0, ${alpha})`);
                                        gctx.fillStyle = grad2;
                                        gctx.fillRect(0, 0, rw, rh);
                                }

                                cache.key = key;
                                cache.lastMs = now;
                        }

                        if (cache.canvas) {
                                ctx.save();
                                ctx.globalAlpha = 1.0;
                                // Smoothing helps the upscaled overlay look less pixelated
                                try { ctx.imageSmoothingEnabled = true; } catch(_) {}
                                ctx.drawImage(cache.canvas, 0, 0, w, h);
                                ctx.restore();
                        }
                } catch(_) {}
        })();

        // Draw NPC barks (world-space, attached to NPCs)
        (function drawNpcBarks(){
                try {
                        const list = window._npcBarkList || [];
                        for (let i = 0; i < list.length; i++) {
                                const n = list[i];
                                if (!n || !n.alive) continue;
                                const sx = n.x - state.cameraX;
                                const sy = n.y - state.cameraY;
                                const b = n._bark;
                                if (!b || !b.visible || !Array.isArray(b.lines) || b.lines.length === 0) continue;
                                const text = String(b.lines[Math.max(0, Math.min(b.lines.length - 1, b.idx))] || '');
                                if (!text) continue;
                                const bob = Math.sin((n._t || 0) * 2.6) * 4;
                                const bx = sx;
                                const by = sy - n.radius - 48 + bob;
                                ctx.save();
                                ctx.font = '14px sans-serif';
                                ctx.textAlign = 'center';
                                ctx.textBaseline = 'middle';
                                const metrics = ctx.measureText(text);
                                const tw = Math.ceil(metrics.width);
                                const padX = 10, padY = 6;
                                const bw = tw + padX * 2;
                                const bh = 24 + padY * 2;
                                const fade = Math.max(0, Math.min(1, b.fade || 0));
                                const scale = 0.85 + 0.15 * fade;
                                ctx.globalAlpha = 0.65 * fade;
                                ctx.translate(Math.round(bx), Math.round(by));
                                ctx.scale(scale, scale);
                                ctx.translate(-Math.round(bx), -Math.round(by));
                                ctx.fillStyle = 'rgba(0,0,0,1)';
                                ctx.strokeStyle = '#000000';
                                ctx.lineWidth = 2;
                                ctx.beginPath();
                                ctx.rect(Math.round(bx - bw / 2) + 0.5, Math.round(by - bh / 2) + 0.5, bw, bh);
                                ctx.fill();
                                ctx.stroke();
                                ctx.strokeStyle = 'rgba(255,255,255,' + (0.2 * fade) + ')';
                                ctx.beginPath();
                                ctx.moveTo(bx, by + bh / 2);
                                ctx.lineTo(sx, sy - n.radius);
                                ctx.stroke();
                                ctx.globalAlpha = fade;
                                ctx.fillStyle = b.color || '#ffb15a';
                                ctx.fillText(text, Math.round(bx), Math.round(by));
                                ctx.restore();
                        }
                } catch(_) {}
                window._npcBarkList = null;
        })();

        // Weapon 8 Custom Crosshair (drawn in WORLD space so zoom affects it correctly)
        if (typeof window !== 'undefined' && window.projectiles && window.projectiles.currentIndex === 7) {
            // Convert mouse screen position to world position (account for zoom)
            const _crossCx = state.viewportWidth / 2;
            const _crossCy = state.viewportHeight / 2;
            const worldMouseX = state.cameraX + _crossCx + (state.mouse.x - _crossCx) / zoomLevel;
            const worldMouseY = state.cameraY + _crossCy + (state.mouse.y - _crossCy) / zoomLevel;
            // Convert back to screen for drawing (affected by zoom transform)
            const mx = worldMouseX - state.cameraX;
            const my = worldMouseY - state.cameraY;
            const weapons = window.projectiles;
            
            ctx.save();
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 2;
            
            const hipFireGap = 15;
            const adsGap = 12;
            const zoomNormalized = (weapons.currentZoom - 0.7) / (1.0 - 0.7);
            const baseGap = adsGap + (hipFireGap - adsGap) * zoomNormalized;
            const recoilMultiplier = adsGap + (hipFireGap - adsGap) * zoomNormalized <= 20 ? 4.5 : 1.0;
            const recoilExpansion = weapons.recoil8Visual * recoilMultiplier;
            const gap = baseGap + recoilExpansion;
            const hairLength = 8;
            
            // Crosshair
            ctx.beginPath();
            ctx.moveTo(mx - (gap + hairLength), my);
            ctx.lineTo(mx - gap, my);
            ctx.moveTo(mx + gap, my);
            ctx.lineTo(mx + (gap + hairLength), my);
            ctx.moveTo(mx, my - (gap + hairLength));
            ctx.lineTo(mx, my - gap);
            ctx.moveTo(mx, my + gap);
            ctx.lineTo(mx, my + (gap + hairLength));
            ctx.stroke();
            
            // ADS Circle
            if (weapons.isADS) {
                 ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
                 ctx.lineWidth = 1;
                 const circleRadius = gap + hairLength + 8;
                 ctx.beginPath();
                 ctx.arc(mx, my, circleRadius, 0, Math.PI * 2);
                 ctx.stroke();
                 
                 // ADS Red Dot
                 ctx.fillStyle = '#ff0000';
                 ctx.beginPath();
                 ctx.arc(mx, my, 1.5, 0, Math.PI * 2);
                 ctx.fill();
            }
            
            ctx.restore();
        }

        // ===== END OF WORLD-SPACE RENDERING =====
        // Remove shake and zoom transforms before UI
        ctx.restore();
        
        // Weapon 8 Vision Cone (Fog of War) - Update separate darkness canvas
        if (projectiles && projectiles.currentIndex === 7 && player && environment) {
                // Account for zoom when calculating world mouse position
                const _darkCx = state.viewportWidth / 2;
                const _darkCy = state.viewportHeight / 2;
                const currentZoom = (window.clientRender && window.clientRender.zoomLevel) ? window.clientRender.zoomLevel : 1.0;
                const aimX = state.cameraX + _darkCx + (state.mouse.x - _darkCx) / currentZoom;
                const aimY = state.cameraY + _darkCy + (state.mouse.y - _darkCy) / currentZoom;
                updateWeapon8DarknessCanvas(player, aimX, aimY, environment, state.cameraX, state.cameraY, state.viewportWidth, state.viewportHeight, currentZoom);
        } else {
                // Hide darkness canvas when not using weapon 8
                if (window._weapon8DarknessCanvas) {
                        window._weapon8DarknessCanvas.style.display = 'none';
                }
        }

        // ===== START OF SCREEN-SPACE UI RENDERING =====
        
        // Hide system cursor when Weapon 8 is active, but show it when over UI
        if (typeof window !== 'undefined' && window.projectiles && window.projectiles.currentIndex === 7) {
            // Hide system cursor when Weapon 8 is active, but show it when over UI
            if (canvas && canvas.style) {
                // Check if mouse is over any UI elements
                let isOverUI = false;
                
                try {
                    // Check if mission complete/failure overlay is showing
                    if (state.extractionEnd) {
                        isOverUI = true;
                    }
                    
                    // Check if dialogue is open
                    if (dialogue && dialogue.open) {
                        isOverUI = true;
                    }
                    
                    // Check if merchant shop is open
                    if (window.merchantShop && window.merchantShop.open) {
                        isOverUI = true;
                    }
                    
                    // Check if mouse is over inventory UI (left side)
                    const margin = 16;
                    const hasArtifact = chests && chests.some(c => c && c.artifact && c.artifact.carriedBy);
                    const equippedCount = Math.max(0, Math.min(6, (player.inventory || []).length));
                    const invCount = 6 + (hasArtifact ? 1 : 0);
                    const slotSize = 56;
                    const gap = 10;
                    const totalH = invCount * slotSize + (invCount - 1) * gap;
                    const startY = Math.max(margin, Math.round((state.viewportHeight - totalH) / 2));
                    const x = margin;
                    const mx = state.mouse.x;
                    const my = state.mouse.y;
                    
                    for (let i = 0; i < invCount; i++) {
                        const y = startY + i * (slotSize + gap);
                        if (mx >= x && mx <= x + slotSize && my >= y && my <= y + slotSize) {
                            isOverUI = true;
                            break;
                        }
                    }
                    
                    // Check if mouse is over quickbar UI (bottom)
                    const qbMargin = 16;
                    const qbBoxSize = 56;
                    const qbGap = 10;
                    const qbSlotsToRender = [0, 1, 2, 3, 4, 5, 6, 7, 8];
                    const qbTotalW = qbSlotsToRender.length * qbBoxSize + (qbSlotsToRender.length - 1) * qbGap;
                    const qbBx = Math.round((state.viewportWidth - qbTotalW) / 2);
                    const qbBy = state.viewportHeight - qbMargin - qbBoxSize;
                    
                    for (let i = 0; i < qbSlotsToRender.length; i++) {
                        const slotX = qbBx + i * (qbBoxSize + qbGap);
                        if (mx >= slotX && mx <= slotX + qbBoxSize && my >= qbBy && my <= qbBy + qbBoxSize) {
                            isOverUI = true;
                            break;
                        }
                    }
                } catch(_) {}
                
                // Show cursor if over UI, hide otherwise
                canvas.style.cursor = isOverUI ? 'default' : 'none';
            }
        } else {
            // Show system cursor for other weapons
            if (canvas && canvas.style && canvas.style.cursor === 'none') {
                canvas.style.cursor = 'default';
            }
        }

        // Damage vignette overlay (dark red edges), drawn beneath UI
        if ((state.vignette || 0) > 0.001) {
                const v = Math.max(0, Math.min(1, state.vignette || 0));
                const w = state.viewportWidth;
                const h = state.viewportHeight;
                const cx = w / 2;
                const cy = h / 2;
                // Inner radius covers center safe zone, outer radius reaches corners
                const maxR = Math.hypot(cx, cy);
                const innerR = Math.max(0, maxR * 0.5);
                const outerR = Math.max(innerR + 1, maxR * 0.98);
                const g = ctx.createRadialGradient(cx, cy, innerR, cx, cy, outerR);
                // Alpha scales nonlinearly for punchy start but soft tail
                const a = Math.pow(v, 0.6) * 0.95;
                g.addColorStop(0, 'rgba(120, 0, 0, 0)');
                g.addColorStop(0.5, `rgba(100, 0, 0, ${a * 0.35})`);
                g.addColorStop(0.82, `rgba(70, 0, 0, ${a * 0.7})`);
                g.addColorStop(1, `rgba(50, 0, 0, ${a})`);
                ctx.save();
                ctx.fillStyle = g;
                ctx.fillRect(0, 0, w, h);
                // Deepen darkness using multiply black gradient for clearer vignette
                ctx.globalCompositeOperation = 'multiply';
                const gb = ctx.createRadialGradient(cx, cy, innerR, cx, cy, outerR);
                gb.addColorStop(0, 'rgba(0,0,0,0)');
                gb.addColorStop(1, `rgba(0,0,0, ${a * 0.65})`);
                ctx.fillStyle = gb;
                ctx.fillRect(0, 0, w, h);
                ctx.globalCompositeOperation = 'source-over';
                ctx.restore();
        }

        // Dialogue overlay (modal)
        if (dialogue && dialogue.open && typeof dialogue.draw === 'function') {
                dialogue.draw(ctx, state.viewportWidth, state.viewportHeight);
        }



        // Scene label for clarity
        ctx.save();
        ctx.font = 'bold 18px sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillStyle = 'rgba(255,255,255,0.6)';
        ctx.fillText(scene.current === 'lobby' ? 'Lobby' : 'Level', 10, 10);
        ctx.restore();

        // Extraction end overlay
        if (state.extractionEnd) {
                ctx.save();
                ctx.fillStyle = 'rgba(0,0,0,0.6)';
                ctx.fillRect(0, 0, state.viewportWidth, state.viewportHeight);
                
                // Draw framed background box for better readability
                const hasAccomplishments = (state.extractionEnd.type === 'win' && state.missionAccomplishments);
                const frameWidth = 600;
                const frameHeight = hasAccomplishments ? 455 : 200;
                const frameX = (state.viewportWidth - frameWidth) / 2;
                const frameY = (state.viewportHeight - frameHeight) / 2 - 20;
                
                // Frame background with high opacity
                ctx.fillStyle = 'rgba(20, 20, 30, 0.95)';
                ctx.fillRect(frameX, frameY, frameWidth, frameHeight);
                
                // Frame border
                ctx.strokeStyle = '#d4af37'; // Gold border
                ctx.lineWidth = 3;
                ctx.strokeRect(frameX, frameY, frameWidth, frameHeight);
                
                // Inner glow effect
                ctx.strokeStyle = 'rgba(212, 175, 55, 0.3)';
                ctx.lineWidth = 8;
                ctx.strokeRect(frameX + 4, frameY + 4, frameWidth - 8, frameHeight - 8);
                
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.font = 'bold 48px sans-serif';
                
                // Check if player is evil for heretic ending display
                let isEvil = false;
                try { isEvil = (typeof window !== 'undefined' && window.__killThemAllLocked === true); } catch(_) {}
                
                let title = 'You Lose';
                if (state.extractionEnd.type === 'win') {
                        title = 'Mission Complete';
                } else if (state.extractionEnd.type === 'heretic') {
                        // Evil players win with heretic ending, non-evil players lose
                        title = isEvil ? 'You Win' : 'You Lose';
                }
                
                ctx.fillStyle = '#ffffff';
                ctx.fillText(title, state.viewportWidth / 2, frameY + 60);
                
                // Show mission accomplishments for successful extraction (win type)
                if (state.extractionEnd.type === 'win' && state.missionAccomplishments) {
                        const acc = state.missionAccomplishments;
                        ctx.font = 'bold 18px sans-serif';
                        ctx.fillStyle = '#ffd700'; // Gold color
                        ctx.fillText('Mission Accomplishments:', state.viewportWidth / 2, frameY + 100);
                        
                        // Accomplishment list
                        const lineHeight = 24;
                        let yOffset = frameY + 130;
                        ctx.font = '16px sans-serif';
                        ctx.textAlign = 'left';
                        
                        // Helper to draw accomplishment line
                        const drawAccomplishment = (completed, text, vp, y) => {
                                const checkX = state.viewportWidth / 2 - 180;
                                const textX = checkX + 25;
                                
                                // Draw checkmark or cross
                                ctx.font = 'bold 18px sans-serif';
                                ctx.fillStyle = completed ? '#00ff00' : '#666666';
                                ctx.textAlign = 'center';
                                ctx.fillText(completed ? '✓' : '✗', checkX, y);
                                
                                // Draw text
                                ctx.font = '16px sans-serif';
                                ctx.fillStyle = completed ? '#ffffff' : '#888888';
                                ctx.textAlign = 'left';
                                ctx.fillText(text, textX, y);
                                
                                // Draw VP value
                                ctx.font = 'bold 16px monospace';
                                ctx.fillStyle = completed ? '#ffd700' : '#666666';
                                ctx.textAlign = 'right';
                                ctx.fillText(`+${vp} VP`, state.viewportWidth / 2 + 180, y);
                        };
                        
                        // List accomplishments
                        drawAccomplishment(acc.artilleryWitchKilled, 'Kill Artillery Witch', 3, yOffset);
                        yOffset += lineHeight;
                        
                        drawAccomplishment(acc.prisonerMissionSuccess, 'Help Ecclesiastic Prisoner Complete Mission', 1, yOffset);
                        yOffset += lineHeight;
                        
                        // Not used in Trench Raid (and some other modes may omit it entirely)
                        if (acc.hasHereticPriestObjective) {
                                drawAccomplishment(!!acc.hereticPriestKilled, 'Kill Heretic Priest', 2, yOffset);
                                yOffset += lineHeight;
                        }
                        
                        drawAccomplishment(acc.radioTowerPowered, 'Restore Power to the Holy Radio Tower', 3, yOffset);
                        yOffset += lineHeight;
                        
                        drawAccomplishment(acc.extractedBeforeArtillery, 'Extract Before Artillery Barrage', 5, yOffset);
                        yOffset += lineHeight;
                        
                        // Artifact health with condition label
                        const artifactCondition = acc.artifactHealthPercent >= 100 ? 'Pristine' :
                                                 acc.artifactHealthPercent >= 75 ? 'Good' :
                                                 acc.artifactHealthPercent >= 50 ? 'Damaged' :
                                                 acc.artifactHealthPercent >= 25 ? 'Critical' : 
                                                 acc.artifactHealthPercent > 0 ? 'Nearly Destroyed' : 'Broken Fragments';
                        const artifactHealthDisplay = Math.round(acc.artifactHealthPercent);
                        drawAccomplishment(true, `Extract Artifact (${artifactCondition} - ${artifactHealthDisplay}%)`, acc.artifactVP, yOffset);
                        yOffset += lineHeight + 8;
                        
                        // Total VP line
                        ctx.font = 'bold 18px sans-serif';
                        ctx.fillStyle = '#ffd700';
                        ctx.textAlign = 'center';
                        ctx.fillText(`Total Victory Points Earned: ${acc.totalVP} VP`, state.viewportWidth / 2, yOffset);
                } else if (state.extractionEnd.reason) {
                        // Show reason text for failures
                        ctx.font = '20px sans-serif';
                        ctx.fillStyle = '#ffffff';
                        ctx.textAlign = 'center';
                        ctx.fillText(state.extractionEnd.reason, state.viewportWidth / 2, frameY + 100);
                }
                
                // Button: Return to Lobby (positioned at bottom of frame)
                const bw = 220, bh = 56;
                const bx = Math.round(state.viewportWidth / 2 - bw / 2);
                const by = Math.round(frameY + frameHeight - bh - 30);
                
                // Check hover state
                const mx = state.mouse?.x || 0;
                const my = state.mouse?.y || 0;
                const isHovered = mx >= bx && mx <= bx + bw && my >= by && my <= by + bh;
                const isPressed = isHovered && state.mouseDown;
                
                // Button background with hover effect
                if (isPressed) {
                        ctx.fillStyle = 'rgba(30, 40, 50, 0.95)';
                } else if (isHovered) {
                        ctx.fillStyle = 'rgba(60, 75, 90, 0.9)';
                } else {
                        ctx.fillStyle = '#2c3343';
                }
                ctx.fillRect(bx, by, bw, bh);
                
                // Button border
                ctx.strokeStyle = '#000000';
                ctx.lineWidth = 2;
                ctx.strokeRect(bx, by, bw, bh);
                
                // Hover highlight border
                if (isHovered && !isPressed) {
                        ctx.strokeStyle = '#8ecaff';
                        ctx.lineWidth = 2;
                        ctx.strokeRect(bx - 1, by - 1, bw + 2, bh + 2);
                }
                
                ctx.font = 'bold 18px serif';
                ctx.fillStyle = '#ffffff';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText('Return to Lobby', state.viewportWidth / 2, by + bh / 2);
                ctx.restore();
                state.extractionButtonRect = { x: bx, y: by, w: bw, h: bh };
        }

        // NFC Unlock Popup overlay
        if (state.nfcUnlockPopup) {
                ctx.save();
                
                // Dark overlay
                ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
                ctx.fillRect(0, 0, state.viewportWidth, state.viewportHeight);
                
                // Popup frame dimensions
                const frameWidth = 450;
                const frameHeight = 200;
                const frameX = Math.round(state.viewportWidth / 2 - frameWidth / 2);
                const frameY = Math.round(state.viewportHeight / 2 - frameHeight / 2);
                
                // Frame background (solid, consistent with other UI)
                ctx.fillStyle = '#2c3343';
                ctx.fillRect(frameX, frameY, frameWidth, frameHeight);
                
                // Gold border (like mission complete)
                ctx.strokeStyle = '#d4af37';
                ctx.lineWidth = 3;
                ctx.strokeRect(frameX, frameY, frameWidth, frameHeight);
                
                // Inner border (subtle)
                ctx.strokeStyle = 'rgba(212, 175, 55, 0.25)';
                ctx.lineWidth = 1;
                ctx.strokeRect(frameX + 6, frameY + 6, frameWidth - 12, frameHeight - 12);
                
                // Lock icon (unlocked)
                ctx.font = '48px sans-serif';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillStyle = '#ffd700';
                ctx.fillText('🔓', state.viewportWidth / 2, frameY + 55);
                
                // Title text
                ctx.font = 'bold 28px sans-serif';
                ctx.fillStyle = '#ffffff';
                ctx.fillText(state.nfcUnlockPopup.title, state.viewportWidth / 2, frameY + 105);
                
                // OK Button
                const btnW = 120;
                const btnH = 44;
                const btnX = Math.round(state.viewportWidth / 2 - btnW / 2);
                const btnY = Math.round(frameY + frameHeight - btnH - 20);
                
                // Check hover state
                const mx = state.mouse?.x || 0;
                const my = state.mouse?.y || 0;
                const isHovered = mx >= btnX && mx <= btnX + btnW && my >= btnY && my <= btnY + btnH;
                const isPressed = isHovered && state.mouseDown;
                
                // Button background (matches shop style)
                if (isPressed) {
                        ctx.fillStyle = 'rgba(50, 100, 50, 0.95)'; // Darker when pressed
                } else if (isHovered) {
                        ctx.fillStyle = 'rgba(70, 140, 70, 0.9)'; // Lighter when hovered
                } else {
                        ctx.fillStyle = 'rgba(50, 120, 50, 0.8)'; // Normal green
                }
                ctx.fillRect(btnX, btnY, btnW, btnH);
                
                // Button border
                ctx.strokeStyle = '#000';
                ctx.lineWidth = 2;
                ctx.strokeRect(btnX, btnY, btnW, btnH);
                
                // Hover highlight border (like inventory slots)
                if (isHovered && !isPressed) {
                        ctx.strokeStyle = '#8ecaff';
                        ctx.lineWidth = 2;
                        ctx.strokeRect(btnX - 1, btnY - 1, btnW + 2, btnH + 2);
                }
                
                // Button text
                ctx.font = 'bold 18px serif';
                ctx.fillStyle = '#ffffff';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText('OK', state.viewportWidth / 2, btnY + btnH / 2);
                
                ctx.restore();
                
                // Store button rect for click detection
                state.nfcUnlockButtonRect = { x: btnX, y: btnY, w: btnW, h: btnH };
        } else {
                state.nfcUnlockButtonRect = null;
        }

	// Guard/Wave guidance arrow: points to gold chest, then artifact if on the ground
	if (modeTimer.currentName && (modeTimer.currentName.startsWith('Guard') || modeTimer.currentName.startsWith('Wave'))) {
                let target = null;
                const goldChest = chests.find(c => c && c.variant === 'gold');
                if (goldChest) {
                        if (!goldChest.opened) {
                                target = { x: goldChest.x, y: goldChest.y, style: 'chest' };
			} else if (goldChest.artifact && !goldChest.artifact.carriedBy) {
                                target = { x: goldChest.artifact.x, y: goldChest.artifact.y, style: 'artifact' };
                        }
                }
                if (target && state.arrowAlpha > 0.001) {
                        const px = player.x - state.cameraX;
                        const py = player.y - state.cameraY;
                        const dx = target.x - player.x;
                        const dy = target.y - player.y;
                        const ang = Math.atan2(dy, dx);
                        // Position the arrow a bit away from the player along the direction
                        const radius = 250;
                        const ax = px + Math.cos(ang) * radius;
                        const ay = py + Math.sin(ang) * radius;
                        ctx.save();
                        ctx.translate(ax, ay);
                        ctx.rotate(ang);
                        // Transparent arrow with color based on phase (gold chest vs blue artifact)
                        const len = 36;
                        const halfW = 10;
                        ctx.globalAlpha = 0.75 * state.arrowAlpha;
                        if (target.style === 'artifact') {
                                ctx.fillStyle = '#8af7ff';
                                ctx.strokeStyle = '#2bc7d6';
                        } else {
                                ctx.fillStyle = '#d4af37';
                                ctx.strokeStyle = '#8a6d1f';
                        }
                        ctx.lineWidth = 2;
                        ctx.beginPath();
                        ctx.moveTo(len, 0);
                        ctx.lineTo(-8, halfW);
                        ctx.lineTo(-8, -halfW);
                        ctx.closePath();
                        ctx.fill();
                        ctx.stroke();
                        ctx.restore();
                        ctx.globalAlpha = 1.0;
                }
        }

        // While Backquote (`) or tilde (~) is held: show arrow to nearest NPC
        if (state.keys.Backquote || state.keys['~'] || state.keys['`']) {
                let nearestA = null, bestA = Infinity;
                let nearestB = null, bestB = Infinity;
                for (let i = 0; i < npcs.items.length; i++) {
                        const n = npcs.items[i];
                        if (!n || !n.alive) continue;
                        const dx = n.x - player.x;
                        const dy = n.y - player.y;
                        const d2 = dx * dx + dy * dy;
                        if (n.name === 'NPC_A') { if (d2 < bestA) { bestA = d2; nearestA = n; } }
                        if (n.name === 'NPC_B') { if (d2 < bestB) { bestB = d2; nearestB = n; } }
                }
                const px = player.x - state.cameraX;
                const py = player.y - state.cameraY;
                const drawNpcArrow = (target, fill, stroke) => {
                        if (!target) return;
                        const dx = target.x - player.x;
                        const dy = target.y - player.y;
                        const ang = Math.atan2(dy, dx);
                        const dist = Math.hypot(dx, dy);
                        // Fade arrow when close
                        const near = 500, far = 2000;
                        let fade = 1;
                        if (dist <= near) fade = 0; else if (dist >= far) fade = 1; else fade = (dist - near) / (far - near);
                        const radius = 250;
                        const ax = px + Math.cos(ang) * radius;
                        const ay = py + Math.sin(ang) * radius;
                        ctx.save();
                        ctx.translate(ax, ay);
                        ctx.rotate(ang);
                        const len = 36;
                        const halfW = 10;
                        ctx.globalAlpha = 0.75 * fade;
                        ctx.fillStyle = fill;
                        ctx.strokeStyle = stroke;
                        ctx.lineWidth = 2;
                        ctx.beginPath();
                        ctx.moveTo(len, 0);
                        ctx.lineTo(-8, halfW);
                        ctx.lineTo(-8, -halfW);
                        ctx.closePath();
                        ctx.fill();
                        ctx.stroke();
                        ctx.restore();
                        ctx.globalAlpha = 1.0;
                };
                // NPC_A arrow (forest green)
                drawNpcArrow(nearestA, '#228b22', '#0d4f0d');
                // NPC_B arrow (maroon)
                drawNpcArrow(nearestB, '#800000', '#4d0000');
        }
        
        // Show light blue arrow pointing to artifact carrier (for other players)
        if (window.networkManager && window.networkManager.artifactCarrierId) {
                // Check if someone else (not local player) has the artifact
                if (window.networkManager.artifactCarrierId !== window.networkManager.playerId) {
                        const otherPlayers = window.networkManager.getOtherPlayers?.() || [];
                        const carrier = otherPlayers.find(p => p.id === window.networkManager.artifactCarrierId);
                        if (carrier) {
                                const px = player.x - state.cameraX;
                                const py = player.y - state.cameraY;
                                const dx = carrier.x - player.x;
                                const dy = carrier.y - player.y;
                                const ang = Math.atan2(dy, dx);
                                const dist = Math.hypot(dx, dy);
                                // Fade arrow when close
                                const near = 500, far = 2000;
                                let fade = 1;
                                if (dist <= near) fade = 0; else if (dist >= far) fade = 1; else fade = (dist - near) / (far - near);
                                const radius = 250;
                                const ax = px + Math.cos(ang) * radius;
                                const ay = py + Math.sin(ang) * radius;
                                ctx.save();
                                ctx.translate(ax, ay);
                                ctx.rotate(ang);
                                const len = 36;
                                const halfW = 10;
                                ctx.globalAlpha = 0.75 * fade;
                                ctx.fillStyle = '#4FC3F7'; // Light blue
                                ctx.strokeStyle = '#1976D2'; // Darker blue for contrast
                                ctx.lineWidth = 2;
                                ctx.beginPath();
                                ctx.moveTo(len, 0);
                                ctx.lineTo(-8, halfW);
                                ctx.lineTo(-8, -halfW);
                                ctx.closePath();
                                ctx.fill();
                                ctx.stroke();
                                ctx.restore();
                                ctx.globalAlpha = 1.0;
                        }
                }
        }
        
        // Show blue arrow pointing to artifact on ground (when no one is carrying it)
        // Works for extraction and trenchraid modes
        if (window.networkManager && !window.networkManager.artifactCarrierId) {
                // No one is carrying the artifact - check if it's on the ground
                const levelType = window.serverLevelType || 'extraction';
                if (levelType === 'extraction' || levelType === 'trenchraid') {
                        // Find gold chest with artifact on ground
                        const goldChest = chests.find(c => c && c.variant === 'gold');
                        if (goldChest && goldChest.artifact && !goldChest.artifact.carriedBy) {
                                const artifactX = goldChest.artifact.x;
                                const artifactY = goldChest.artifact.y;
                                const px = player.x - state.cameraX;
                                const py = player.y - state.cameraY;
                                const dx = artifactX - player.x;
                                const dy = artifactY - player.y;
                                const ang = Math.atan2(dy, dx);
                                const dist = Math.hypot(dx, dy);
                                // Fade arrow when close
                                const near = 300, far = 1500;
                                let fade = 1;
                                if (dist <= near) fade = 0; else if (dist >= far) fade = 1; else fade = (dist - near) / (far - near);
                                const radius = 250;
                                const ax = px + Math.cos(ang) * radius;
                                const ay = py + Math.sin(ang) * radius;
                                ctx.save();
                                ctx.translate(ax, ay);
                                ctx.rotate(ang);
                                const len = 36;
                                const halfW = 10;
                                ctx.globalAlpha = 0.75 * fade;
                                ctx.fillStyle = '#8af7ff'; // Cyan/light blue for artifact
                                ctx.strokeStyle = '#2bc7d6';
                                ctx.lineWidth = 2;
                                ctx.beginPath();
                                ctx.moveTo(len, 0);
                                ctx.lineTo(-8, halfW);
                                ctx.lineTo(-8, -halfW);
                                ctx.closePath();
                                ctx.fill();
                                ctx.stroke();
                                ctx.restore();
                                ctx.globalAlpha = 1.0;
                        }
                }
        }
        
	// Check if local player is carrying the artifact (for inventory UI display)
	const artifactCarriedLocally = chests.some(c => c && c.artifact && c.artifact.carriedBy);
	// artifactIsOut should only be true when LOCAL PLAYER is carrying it
	const artifactIsOut = (window.networkManager?.artifactCarrierId === window.networkManager?.playerId) || artifactCarriedLocally;
	const artifactCarriedForGuidance = artifactCarriedLocally || (window.networkManager && window.networkManager.artifactCarrierId != null);
	
	// Check if local player is carrying a battery
	let batteryCarried = false;
	const batteries = window._batteries || [];
	for (let i = 0; i < batteries.length; i++) {
		if (batteries[i] && batteries[i].carriedBy === window.networkManager?.playerId) {
			batteryCarried = true;
			break;
		}
	}
        
        // Check if local player is converted to evil
        let __conv = false; try { __conv = (typeof window !== 'undefined' && window.__killThemAllLocked === true); } catch(_) {}
        
        // Check if artifact carrier is an evil player (for non-evil players to track them)
        let artifactCarrierIsEvil = false;
        let artifactCarrierPosition = null;
        let localPlayerHasArtifact = false;
        
        if (window.networkManager) {
                if (window.networkManager.artifactCarrierId === window.networkManager.playerId) {
                        // Local player has the artifact
                        localPlayerHasArtifact = true;
                } else if (window.networkManager.artifactCarrierId) {
                        // Remote player has the artifact - check if they're evil
                        const otherPlayers = window.networkManager.getOtherPlayers?.() || [];
                        const carrier = otherPlayers.find(p => p.id === window.networkManager.artifactCarrierId);
                        if (carrier && carrier.evilLocked) {
                                artifactCarrierIsEvil = true;
                                artifactCarrierPosition = { x: carrier.x, y: carrier.y };
                        }
                }
        } else if (artifactCarriedLocally) {
                localPlayerHasArtifact = true;
        }
        
        // When carrying artifact: show arrows to Boss (red) and Extraction zone (green)
        // UNLESS an evil player is holding it (then non-evil players only see tracking arrows)
        const showNormalArrows = artifactCarriedForGuidance && !artifactCarrierIsEvil;
        if (showNormalArrows) {
                // Boss arrow (red) - shown to non-evil players when non-evil has artifact, or to evil player when non-evil has artifact
                if (!__conv || (__conv && !localPlayerHasArtifact)) {
                        let boss = null;
                        try {
                                for (let i = 0; i < enemies.items.length; i++) {
                                        const e = enemies.items[i];
                                        if (!e || !e.alive) continue;
                                        if (window.ArtilleryWitch && e instanceof window.ArtilleryWitch) { boss = e; break; }
                                }
                        } catch(e) {}
                        if (boss) {
                                const px = player.x - state.cameraX;
                                const py = player.y - state.cameraY;
                                const dx = boss.x - player.x;
                                const dy = boss.y - player.y;
                                const ang = Math.atan2(dy, dx);
                                const distToBoss = Math.hypot(dx, dy);
                                // Fade arrow when close to boss
                                const near = 500, far = 2000;
                                let fade = 1;
                                if (distToBoss <= near) fade = 0; else if (distToBoss >= far) fade = 1; else fade = (distToBoss - near) / (far - near);
                                const radius = 250;
                                const ax = px + Math.cos(ang) * radius;
                                const ay = py + Math.sin(ang) * radius;
                                ctx.save();
                                ctx.translate(ax, ay);
                                ctx.rotate(ang);
                                const len = 36;
                                const halfW = 10;
                                ctx.globalAlpha = 0.75 * fade;
                                ctx.fillStyle = '#ff4d4d';
                                ctx.strokeStyle = '#8a1f1f';
                                ctx.lineWidth = 2;
                                ctx.beginPath();
                                ctx.moveTo(len, 0);
                                ctx.lineTo(-8, halfW);
                                ctx.lineTo(-8, -halfW);
                                ctx.closePath();
                                ctx.fill();
                                ctx.stroke();
                                ctx.restore();
                                ctx.globalAlpha = 1.0;
                        }
                }

                // Extraction zone arrow (green) - shown to non-evil players when non-evil has artifact, or to evil player when non-evil has artifact
                if ((!__conv || (__conv && !localPlayerHasArtifact)) && extractionZone) {
                        const px = player.x - state.cameraX;
                        const py = player.y - state.cameraY;
                        const dx = extractionZone.x - player.x;
                        const dy = extractionZone.y - player.y;
                        const ang = Math.atan2(dy, dx);
                        const distToZone = Math.hypot(dx, dy);
                        // Fade arrow when close to extraction zone
                        const nearZ = 500, farZ = 2000;
                        let fadeZ = 1;
                        if (distToZone <= nearZ) fadeZ = 0; else if (distToZone >= farZ) fadeZ = 1; else fadeZ = (distToZone - nearZ) / (farZ - nearZ);
                        const radius = 250;
                        const ax = px + Math.cos(ang) * radius;
                        const ay = py + Math.sin(ang) * radius;
                        ctx.save();
                        ctx.translate(ax, ay);
                        ctx.rotate(ang);
                        const len = 36;
                        const halfW = 10;
                        ctx.globalAlpha = 0.75 * fadeZ;
                        ctx.fillStyle = '#21f07a';
                        ctx.strokeStyle = '#0c5b34';
                        ctx.lineWidth = 2;
                        ctx.beginPath();
                        ctx.moveTo(len, 0);
                        ctx.lineTo(-8, halfW);
                        ctx.lineTo(-8, -halfW);
                        ctx.closePath();
                        ctx.fill();
                        ctx.stroke();
                        ctx.restore();
                        ctx.globalAlpha = 1.0;
                }
                // Heretic extraction zone arrow (red) - only show to evil player when they have artifact
                if (__conv && localPlayerHasArtifact && hereticExtractionZone) {
                        const px = player.x - state.cameraX;
                        const py = player.y - state.cameraY;
                        const dx = hereticExtractionZone.x - player.x;
                        const dy = hereticExtractionZone.y - player.y;
                        const ang = Math.atan2(dy, dx);
                        const distToZone = Math.hypot(dx, dy);
                        const nearZ = 500, farZ = 2000;
                        let fadeZ = 1;
                        if (distToZone <= nearZ) fadeZ = 0; else if (distToZone >= farZ) fadeZ = 1; else fadeZ = (distToZone - nearZ) / (farZ - nearZ);
                        const radius = 250;
                        const ax = px + Math.cos(ang) * radius;
                        const ay = py + Math.sin(ang) * radius;
                        ctx.save();
                        ctx.translate(ax, ay);
                        ctx.rotate(ang);
                        const len = 36;
                        const halfW = 10;
                        ctx.globalAlpha = 0.75 * fadeZ;
                        ctx.fillStyle = '#ff4d4d';
                        ctx.strokeStyle = '#8a1f1f';
                        ctx.lineWidth = 2;
                        ctx.beginPath();
                        ctx.moveTo(len, 0);
                        ctx.lineTo(-8, halfW);
                        ctx.lineTo(-8, -halfW);
                        ctx.closePath();
                        ctx.fill();
                        ctx.stroke();
                        ctx.restore();
                        ctx.globalAlpha = 1.0;
                }
        }
        
        // For non-evil players: show arrows to track evil artifact carrier
        if (!__conv && artifactCarrierIsEvil && artifactCarrierPosition) {
                // Arrow pointing to the evil artifact carrier (bright cyan to indicate it's the artifact)
                const px = player.x - state.cameraX;
                const py = player.y - state.cameraY;
                const dx = artifactCarrierPosition.x - player.x;
                const dy = artifactCarrierPosition.y - player.y;
                const ang = Math.atan2(dy, dx);
                const distToCarrier = Math.hypot(dx, dy);
                const nearC = 500, farC = 2000;
                let fadeC = 1;
                if (distToCarrier <= nearC) fadeC = 0; else if (distToCarrier >= farC) fadeC = 1; else fadeC = (distToCarrier - nearC) / (farC - nearC);
                const radius = 250;
                const ax = px + Math.cos(ang) * radius;
                const ay = py + Math.sin(ang) * radius;
                ctx.save();
                ctx.translate(ax, ay);
                ctx.rotate(ang);
                const len = 36;
                const halfW = 10;
                ctx.globalAlpha = 0.75 * fadeC;
                ctx.fillStyle = '#8af7ff'; // Artifact cyan color
                ctx.strokeStyle = '#2bc7d6';
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.moveTo(len, 0);
                ctx.lineTo(-8, halfW);
                ctx.lineTo(-8, -halfW);
                ctx.closePath();
                ctx.fill();
                ctx.stroke();
                ctx.restore();
                ctx.globalAlpha = 1.0;
                
                // Also show arrow to heretic extraction zone so they know where the evil player is trying to go
                if (hereticExtractionZone) {
                        const dx2 = hereticExtractionZone.x - player.x;
                        const dy2 = hereticExtractionZone.y - player.y;
                        const ang2 = Math.atan2(dy2, dx2);
                        const distToZone = Math.hypot(dx2, dy2);
                        const nearZ = 500, farZ = 2000;
                        let fadeZ = 1;
                        if (distToZone <= nearZ) fadeZ = 0; else if (distToZone >= farZ) fadeZ = 1; else fadeZ = (distToZone - nearZ) / (farZ - nearZ);
                        const ax2 = px + Math.cos(ang2) * radius;
                        const ay2 = py + Math.sin(ang2) * radius;
                        ctx.save();
                        ctx.translate(ax2, ay2);
                        ctx.rotate(ang2);
                        ctx.globalAlpha = 0.75 * fadeZ;
                        ctx.fillStyle = '#ff4d4d'; // Red for heretic zone
                        ctx.strokeStyle = '#8a1f1f';
                        ctx.lineWidth = 2;
                        ctx.beginPath();
                        ctx.moveTo(len, 0);
                        ctx.lineTo(-8, halfW);
                        ctx.lineTo(-8, -halfW);
                        ctx.closePath();
                        ctx.fill();
                        ctx.stroke();
                        ctx.restore();
                        ctx.globalAlpha = 1.0;
                }
        }

        // Downed teammate revive pointers (green arrow + pulsing "+REV")
        ;(function drawDownedReviveArrows(){
                try {
                        if (!window.networkManager || !player || !(player.health > 0)) return;
                        const ops = window.networkManager.getOtherPlayers?.() || [];
                        if (!Array.isArray(ops) || ops.length === 0) return;

                        const downed = [];
                        const now = Date.now();
                        for (let i = 0; i < ops.length; i++) {
                                const op = ops[i];
                                if (!op) continue;
                                if (!(typeof op.health === 'number' && op.health <= 0)) continue;
                                const da = Number(op.downedAt) || 0;
                                if (!da) continue;
                                // If revive channel already completed ("ready to accept"), teammates no longer need a revive pointer.
                                // Also hide if the revive window has fully expired (must respawn).
                                const readyUntil = Number(op.reviveReadyUntil) || 0;
                                if (readyUntil > now) continue;
                                let remMs = Number(op.reviveWindowRemainingMs);
                                if (!Number.isFinite(remMs)) remMs = Math.max(0, 30000 - (now - da));
                                if (remMs <= 0) continue;
                                downed.push(op);
                        }
                        if (downed.length === 0) return;

                        // Sort by distance to local player and draw up to 3 pointers
                        downed.sort((a, b) => {
                                const dax = (a.x || 0) - player.x, day = (a.y || 0) - player.y;
                                const dbx = (b.x || 0) - player.x, dby = (b.y || 0) - player.y;
                                return (dax*dax + day*day) - (dbx*dbx + dby*dby);
                        });

                        const px = player.x - state.cameraX;
                        const py = player.y - state.cameraY;
                        const radius = 250;

                        // Heartbeat pulse: two quick peaks per ~1.1s
                        const t = (Date.now() % 1100) / 1100;
                        const beat1 = Math.pow(Math.max(0, Math.sin(t * Math.PI * 2)), 1.8);
                        const beat2 = Math.pow(Math.max(0, Math.sin((t + 0.18) * Math.PI * 2)), 2.2) * 0.6;
                        const pulse = Math.min(1, beat1 + beat2);
                        const textScale = 1 + 0.18 * pulse;

                        for (let i = 0; i < Math.min(3, downed.length); i++) {
                                const op = downed[i];
                                const dx = (op.x || 0) - player.x;
                                const dy = (op.y || 0) - player.y;
                                const ang = Math.atan2(dy, dx);
                                const dist = Math.hypot(dx, dy);
                                // Fade when close
                                const near = 350, far = 2000;
                                let fade = 1;
                                if (dist <= near) fade = 0;
                                else if (dist >= far) fade = 1;
                                else fade = (dist - near) / (far - near);
                                if (fade <= 0.001) continue;

                                const ax = px + Math.cos(ang) * radius;
                                const ay = py + Math.sin(ang) * radius;

                                // Arrow (matches extraction arrow style)
                                ctx.save();
                                ctx.translate(ax, ay);
                                ctx.rotate(ang);
                                const len = 36;
                                const halfW = 10;
                                ctx.globalAlpha = 0.85 * fade;
                                // Revive pointer arrow is neutral grey (text stays green)
                                ctx.fillStyle = '#b8b8b8';
                                ctx.strokeStyle = '#4a4a4a';
                                ctx.lineWidth = 2;
                                ctx.beginPath();
                                ctx.moveTo(len, 0);
                                ctx.lineTo(-8, halfW);
                                ctx.lineTo(-8, -halfW);
                                ctx.closePath();
                                ctx.fill();
                                ctx.stroke();
                                ctx.restore();
                                ctx.globalAlpha = 1.0;

                                // Countdown rendered on the revive arrow (tail side): "XX +Rev"
                                try {
                                        const remMs = Number(op.reviveWindowRemainingMs) || 0;
                                        if (remMs > 0) {
                                                const leftSec = Math.ceil(remMs / 1000);
                                                const urgent = leftSec <= 5;

                                                // Heartbeat pulse (stronger when urgent)
                                                const mod = urgent ? 850 : 1100;
                                                const tt = (Date.now() % mod) / mod;
                                                const beat1 = Math.pow(Math.max(0, Math.sin(tt * Math.PI * 2)), urgent ? 1.4 : 1.8);
                                                const beat2 = Math.pow(Math.max(0, Math.sin((tt + 0.18) * Math.PI * 2)), urgent ? 1.8 : 2.2) * 0.6;
                                                const pulse2 = Math.min(1, beat1 + beat2);
                                                const scale2 = 1 + (urgent ? 0.26 : 0.18) * pulse2;

                                                // Subtle shake when urgent
                                                let sx = 0, sy = 0;
                                                if (urgent) {
                                                        const msFrac = remMs / 1000 - Math.floor(remMs / 1000);
                                                        const k = Math.max(0, Math.min(1, (5 - leftSec + (1 - msFrac)) / 5));
                                                        sx = Math.sin(Date.now() * 0.045) * 2.2 * k;
                                                        sy = Math.cos(Date.now() * 0.06) * 1.6 * k;
                                                }

                                                const label = `${leftSec} +Rev`;
                                                const col = urgent ? '#ff4d4d' : '#21f07a';

                                                // Tail-side placement (behind the arrow tip)
                                                const back = 26;
                                                const lx = ax - Math.cos(ang) * back + sx;
                                                const ly = ay - Math.sin(ang) * back - 2 + sy;
                                                ctx.save();
                                                ctx.translate(lx, ly);
                                                ctx.globalAlpha = 0.95 * fade;
                                                ctx.scale(scale2, scale2);
                                                ctx.font = 'bold 16px sans-serif';
                                                ctx.textAlign = 'center';
                                                ctx.textBaseline = 'middle';
                                                ctx.fillStyle = 'rgba(0,0,0,0.75)';
                                                ctx.fillText(label, 2, 2);
                                                ctx.strokeStyle = 'rgba(0,0,0,0.95)';
                                                ctx.lineWidth = 4;
                                                ctx.strokeText(label, 0, 0);
                                                ctx.fillStyle = col;
                                                ctx.fillText(label, 0, 0);
                                                ctx.restore();
                                        }
                                } catch(_) {}
                        }
                } catch(_) {}
        })();
	// Cache equipped list; rebuild only when inventory version changes.
	// Inventory mutations should bump `player._invVersion` (see ClientUpdate + networking handlers).
	const __invCache = (typeof window !== 'undefined')
		? (window.__equippedInvCache || (window.__equippedInvCache = { ver: null, equipped: [] }))
		: { ver: null, equipped: [] };
	const invVer = (player && typeof player._invVersion === 'number') ? player._invVersion : 0;
	if (__invCache.ver !== invVer) {
		__invCache.equipped = (player && Array.isArray(player.inventory)) ? player.inventory.filter(Boolean) : [];
		__invCache.ver = invVer;
	}
	const equipped = __invCache.equipped;
	const inventoryCount = Math.min(6, equipped.length);
	const getEquippedColor = (idx) => (equipped[idx]?.rarity?.color || '#ffffff');
	const getEquippedLabel = (idx) => (equipped[idx]?.label || '');

	// Only show timer in Extraction mode
	const showTimer = (scene.current === 'level' && window.currentLevelType === 'extraction');
	
	// Get Artillery Barrage timer for Trench Raid mode
	let artilleryTimer = null;
	if (scene.current === 'level' && window.currentLevelType === 'trenchraid' && window.currentGameMode) {
		if (typeof window.currentGameMode.getArtilleryTimerData === 'function') {
			artilleryTimer = window.currentGameMode.getArtilleryTimerData();
		}
	}
	
	const reviveReady = (state && state.reviveReady) ? state.reviveReady : null;
	const reviveAvailable = !!(reviveReady && reviveReady.expiresAt && Date.now() < reviveReady.expiresAt);
	// Revive start window countdown (30s) for local death overlay
	let reviveWindowLeftSec = 0;
	try {
		if (player && player.health <= 0) {
			// Prefer server-authoritative remaining time (pauses during revive, freezes once ready)
			if (typeof player.reviveWindowRemainingMs === 'number' && player.reviveWindowRemainingMs > 0) {
				reviveWindowLeftSec = Math.ceil(player.reviveWindowRemainingMs / 1000);
			} else {
				// Fallback for first frame before server state arrives
				const downedAt = (typeof player.downedAt === 'number' && player.downedAt > 0) ? player.downedAt : (state.downedAtLocal || 0);
				if (downedAt > 0) {
					const leftMs = Math.max(0, 30000 - (Date.now() - downedAt));
					reviveWindowLeftSec = Math.ceil(leftMs / 1000);
				}
			}
		}
	} catch(_) {}
	// UI can be expensive (text + many shapes). Use cached UI rendering when available.
	if (ui && typeof ui.drawCached === 'function') {
		ui.drawCached(ctx, state.viewportWidth, state.viewportHeight, player, { dead: player.health <= 0, respawnTimer: state.deathTimer, reviveAvailable: reviveAvailable, reviveWindowLeftSec: reviveWindowLeftSec, selectedSlotIndex: projectiles.currentIndex, inLobby: scene.current === 'lobby', modeName: showTimer ? modeTimer.currentName : null, modeTimeLeft: showTimer ? modeTimer.timeLeft : null, artilleryTimer: artilleryTimer, artifactCarried: artifactIsOut, batteryCarried: batteryCarried, inventoryCount, getEquippedColor, getEquippedLabel, mouseX: state.mouse.x, mouseY: state.mouse.y, mouseDown: state.mouseDown, weapon: projectiles.current, weaponIndex: projectiles.currentIndex, hideQuickbar: !!(dialogue && dialogue.open), quickbarFade: state.quickbarFade, invincible: state.invincible });
	} else {
		ui.draw(ctx, state.viewportWidth, state.viewportHeight, player, { dead: player.health <= 0, respawnTimer: state.deathTimer, reviveAvailable: reviveAvailable, reviveWindowLeftSec: reviveWindowLeftSec, selectedSlotIndex: projectiles.currentIndex, inLobby: scene.current === 'lobby', modeName: showTimer ? modeTimer.currentName : null, modeTimeLeft: showTimer ? modeTimer.timeLeft : null, artilleryTimer: artilleryTimer, artifactCarried: artifactIsOut, batteryCarried: batteryCarried, inventoryCount, getEquippedColor, getEquippedLabel, mouseX: state.mouse.x, mouseY: state.mouse.y, mouseDown: state.mouseDown, weapon: projectiles.current, weaponIndex: projectiles.currentIndex, hideQuickbar: !!(dialogue && dialogue.open), quickbarFade: state.quickbarFade, invincible: state.invincible });
	}

	// Draw loot pickup notification as UI overlay (above all game objects)
	drawLootNotification(ctx, player, { x: state.cameraX, y: state.cameraY });

        // Debug overlay (HUD stays on, but compute values at low rate to reduce cost).
        if (DEBUG) {
                const cache = (typeof window !== 'undefined')
                        ? (window.__debugOverlayCache || (window.__debugOverlayCache = { nextMs: 0, lines: [] }))
                        : { nextMs: 0, lines: [] };
                const now = Date.now();
                if (!cache.nextMs || now >= cache.nextMs) {
                        cache.nextMs = now + 500; // ~2Hz update
                        try {
                                const debugStatus = window.gameDebugger?.getStatus();
                                const lines = [
                                        `dt: ${state._lastDt?.toFixed?.(3) ?? 'n/a'}`,
                                        `fps: ${debugStatus?.fps || 0}`,
                                        `cam: (${state.cameraX.toFixed(1)}, ${state.cameraY.toFixed(1)})`,
                                        `player: (${player.x.toFixed(1)}, ${player.y.toFixed(1)})`,
                                        `mouse: (${state.mouse.x.toFixed(1)}, ${state.mouse.y.toFixed(1)})`,
                                        `zone: ${getTrenchRaidZone(player)}`,
                                        `players: ${(otherPlayers?.length || 0) + 1}`,
                                        `events: net:${debugStatus?.counters?.networkMessages || 0} dmg:${debugStatus?.counters?.damageEvents || 0} enemy:${debugStatus?.counters?.enemySpawns || 0}`,
                                        `bosses: events:${debugStatus?.counters?.bossEvents || 0}`,
                                        `horde: ${window._lastHordeNumber || 0} difficulty:${window._lastHordeDifficulty || 'N/A'} spawned:${window._lastHordeSpawnCount || 0}`,
                                        `hordeTimer: ${(window._hordeTimer || 0).toFixed(1)}s`,
                                        `ambient: spawned:${window._ambientSpawnedTotal || 0}`
                                ];
                                const s = window._ambientState || {};
                                lines.push(`ambientState: dyn:${s.dynamicAlive||0}/${s.tierCapDynamic||0} base:${s.baselineAlive||0} rate:${(s.rate||0).toFixed?.(2) || s.rate || 0} t${s.tierIdx||0}`);
                                const lootLvl = (player && typeof player.lootLevel === 'number') ? player.lootLevel : 0;
                                lines.push(`lootLevel: ${lootLvl}`);

                                if (window.serverLevelType === 'trenchraid') {
                                        const counts = { New: 0, A: 0, B: 0, C: 0, D: 0, E: 0, F: 0, H: 0 };
                                        const items = (window.troops && Array.isArray(window.troops.items)) ? window.troops.items : [];
                                        for (let i = 0; i < items.length; i++) {
                                                const t = items[i];
                                                if (!t) continue;
                                                if (t.alive === false) continue;
                                                if (typeof t.health === 'number' && t.health <= 0) continue;
                                                const z = getTrenchRaidZone(t);
                                                if (z === 'NewAntiochZone') counts.New++;
                                                else if (z === 'ZoneA') counts.A++;
                                                else if (z === 'ZoneB') counts.B++;
                                                else if (z === 'ZoneC') counts.C++;
                                                else if (z === 'ZoneD') counts.D++;
                                                else if (z === 'ZoneE') counts.E++;
                                                else if (z === 'ZoneF') counts.F++;
                                                else if (z === 'HereticZone') counts.H++;
                                        }
                                        lines.push(`troops: New:${counts.New} A:${counts.A} B:${counts.B} C:${counts.C} D:${counts.D} E:${counts.E} F:${counts.F} H:${counts.H}`);
                                }
                                cache.lines = lines;
                        } catch(_) {}
                }

                ctx.save();
                ctx.fillStyle = 'white';
                ctx.font = '12px monospace';
                const debugTop = 16 + 18 * 2 + 8;
                const lines = cache.lines || [];
                for (let i = 0; i < lines.length; i++) {
                        ctx.fillText(lines[i], 10, debugTop + i * 14);
                }
                ctx.restore();
        }
        
        // Merchant shop overlay - MUST BE LAST to draw on top of everything (debug, players, UI, etc.)
        if (window.merchantShop && window.merchantShop.open && typeof window.merchantShop.draw === 'function') {
                try {
                        window.merchantShop.draw(ctx, state.viewportWidth, state.viewportHeight, player);
                } catch(err) {
                        console.error('[Render] Error drawing merchant shop:', err);
                }
        }
        
        // Decay shake timer AFTER rendering so at least one frame uses it
        // This prevents shake from being zeroed before render on slow frames (e.g., dt ≈ 0.12)
        if (state.shakeTime > 0) {
                const dt = Number.isFinite(state._lastDt) ? state._lastDt : 0.016;
                state.shakeTime = Math.max(0, state.shakeTime - dt);
        }
}

// --- Weapon 8 Vision Cone Helper Functions (NEW IMPLEMENTATION) ---

// Apply clipping mask for vision cone (enemies/NPCs only render inside this region)
function applyWeapon8VisionClip(ctx, player, aimX, aimY, environment, cameraX, cameraY) {
    // Build the vision cone path
    const dx = aimX - player.x;
    const dy = aimY - player.y;
    const angle = Math.atan2(dy, dx);
    
    // Cone settings
    const coneHalfAngle = 30 * (Math.PI / 180);
    const viewRadius = 3000; // Increased so cone extends beyond visible screen
    
    const startAngle = angle - coneHalfAngle;
    const endAngle = angle + coneHalfAngle;
    
    // Get nearby obstacles for raycasting
    const nearbyObstacles = [];
    const checkDistSq = (viewRadius + 200) ** 2;
    
    if (environment && environment.obstacles) {
        for (let i = 0; i < environment.obstacles.length; i++) {
            const ob = environment.obstacles[i];
            if (ob.temporary === true) continue;
            const d2 = (ob.x - player.x)**2 + (ob.y - player.y)**2;
            if (d2 < checkDistSq) {
                nearbyObstacles.push(ob);
            }
        }
    }
    
    if (environment && environment.orientedBoxes) {
        for (let i = 0; i < environment.orientedBoxes.length; i++) {
            const box = environment.orientedBoxes[i];
            // Skip shield walls - they shouldn't block vision
            // Shield walls have _abilityId OR are small thin walls (w~100, h~20)
            if (box._abilityId) continue;
            const isShieldWall = (box.w < 150 && box.h < 50) || (box.h < 150 && box.w < 50);
            if (isShieldWall) continue;
            const d2 = (box.x - player.x)**2 + (box.y - player.y)**2;
            if (d2 < checkDistSq) {
                nearbyObstacles.push(box);
            }
        }
    }
    
    // Cast rays to form the cone polygon
    const playerScreenX = player.x - cameraX;
    const playerScreenY = player.y - cameraY;
    const points = [];
    points.push({x: playerScreenX, y: playerScreenY});
    
    const numRays = 50;
    for (let i = 0; i <= numRays; i++) {
        const theta = startAngle + (endAngle - startAngle) * (i / numRays);
        const hit = castVisionRay(player.x, player.y, theta, viewRadius, nearbyObstacles);
        points.push({x: hit.x - cameraX, y: hit.y - cameraY});
    }
    
    // Create clipping path: player circle + vision cone
    ctx.beginPath();
    
    // Player circle (increased radius)
    ctx.arc(playerScreenX, playerScreenY, 250, 0, Math.PI * 2);
    
    // Vision cone
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.closePath();
    
    // Apply the clip
    ctx.clip();
    
    return true;
}

// Update separate darkness canvas (Method 5: Separate Canvas Layer)
function updateWeapon8DarknessCanvas(player, aimX, aimY, environment, cameraX, cameraY, viewportWidth, viewportHeight, zoomLevel) {
    // Create darkness canvas if it doesn't exist
    if (!window._weapon8DarknessCanvas) {
        const canvas = document.createElement('canvas');
        canvas.style.position = 'absolute';
        canvas.style.top = '0';
        canvas.style.left = '0';
        canvas.style.width = '100%'; // Scale to full viewport
        canvas.style.height = '100%';
        canvas.style.pointerEvents = 'none';
        canvas.style.zIndex = '100'; // Above game canvas
        canvas.style.imageRendering = 'auto'; // Allow smooth scaling/blurring
        document.body.appendChild(canvas);
        window._weapon8DarknessCanvas = canvas;
    }
    
    const darkCanvas = window._weapon8DarknessCanvas;
    const darkCtx = darkCanvas.getContext('2d');
    
    // Render at 20% resolution for performance (5% was too low, 20% is a good balance)
    const renderScale = 0.2;
    const renderWidth = Math.floor(viewportWidth * renderScale);
    const renderHeight = Math.floor(viewportHeight * renderScale);
    
    // Update canvas size if needed (internal resolution is lower)
    if (darkCanvas.width !== renderWidth || darkCanvas.height !== renderHeight) {
        darkCanvas.width = renderWidth;
        darkCanvas.height = renderHeight;
    }
    
    // Show canvas
    darkCanvas.style.display = 'block';
    
    // Clear canvas
    darkCtx.clearRect(0, 0, renderWidth, renderHeight);
    
    // Calculate player's screen position BEFORE any transforms
    const playerScreenX = player.x - cameraX;
    const playerScreenY = player.y - cameraY;
    
    // Apply render scale and zoom transform
    darkCtx.save();
    darkCtx.scale(renderScale, renderScale);
    
    // Apply zoom transform around PLAYER position (not screen center)
    // This keeps the vision circle centered on the player when zooming
    if (zoomLevel !== 1.0) {
        darkCtx.translate(playerScreenX, playerScreenY);
        darkCtx.scale(zoomLevel, zoomLevel);
        darkCtx.translate(-playerScreenX, -playerScreenY);
    }
    
    // Build vision cone
    const dx = aimX - player.x;
    const dy = aimY - player.y;
    const angle = Math.atan2(dy, dx);
    
    const coneHalfAngle = 30 * (Math.PI / 180);
    const viewRadius = 3000; // Increased so cone extends beyond visible screen
    
    const startAngle = angle - coneHalfAngle;
    const endAngle = angle + coneHalfAngle;
    
    // Get nearby obstacles for raycasting
    const nearbyObstacles = [];
    const checkDistSq = (viewRadius + 200) ** 2;
    
    if (environment && environment.obstacles) {
        for (let i = 0; i < environment.obstacles.length; i++) {
            const ob = environment.obstacles[i];
            if (ob.temporary === true) continue;
            const d2 = (ob.x - player.x)**2 + (ob.y - player.y)**2;
            if (d2 < checkDistSq) {
                nearbyObstacles.push(ob);
            }
        }
    }
    
    if (environment && environment.orientedBoxes) {
        for (let i = 0; i < environment.orientedBoxes.length; i++) {
            const box = environment.orientedBoxes[i];
            // Skip shield walls - they shouldn't block vision
            // Shield walls have _abilityId OR are small thin walls (w~100, h~20)
            if (box._abilityId) continue;
            const isShieldWall = (box.w < 150 && box.h < 50) || (box.h < 150 && box.w < 50);
            if (isShieldWall) continue;
            const d2 = (box.x - player.x)**2 + (box.y - player.y)**2;
            if (d2 < checkDistSq) {
                nearbyObstacles.push(box);
            }
        }
    }
    
    // Cast rays for cone (use the playerScreenX/Y calculated earlier)
    const conePoints = [];
    conePoints.push({x: playerScreenX, y: playerScreenY});
    
    const numRays = 50;
    for (let i = 0; i <= numRays; i++) {
        const theta = startAngle + (endAngle - startAngle) * (i / numRays);
        const hit = castVisionRay(player.x, player.y, theta, viewRadius, nearbyObstacles);
        conePoints.push({x: hit.x - cameraX, y: hit.y - cameraY});
    }
    
    // SEPARATE CANVAS APPROACH: Draw darkness, then cut holes with destination-out
    // This works because we're on a fresh canvas with no prior content
    
    // Step 1: Fill entire viewport with darkness (scaled around player, so covers everything)
    // Draw a large area to ensure coverage even when zoomed
    const coverageSize = Math.max(viewportWidth, viewportHeight) * 2;
    darkCtx.fillStyle = 'rgba(0, 0, 0, 0.15)';
    darkCtx.fillRect(-coverageSize/2, -coverageSize/2, coverageSize * 2, coverageSize * 2);
    
    // Step 2: Use destination-out to cut holes (works on separate canvas!)
    darkCtx.globalCompositeOperation = 'destination-out';
    darkCtx.fillStyle = 'rgba(255, 255, 255, 1.0)';
    
    // Cut out player circle (increased radius)
    darkCtx.beginPath();
    darkCtx.arc(playerScreenX, playerScreenY, 250, 0, Math.PI * 2);
    darkCtx.fill();
    
    // Cut out vision cone
    darkCtx.beginPath();
    darkCtx.moveTo(conePoints[0].x, conePoints[0].y);
    for (let i = 1; i < conePoints.length; i++) {
        darkCtx.lineTo(conePoints[i].x, conePoints[i].y);
    }
    darkCtx.closePath();
    darkCtx.fill();
    
    // Reset composite operation
    darkCtx.globalCompositeOperation = 'source-over';
    
    // Restore context (removes zoom transform)
    darkCtx.restore();
}

function castVisionRay(x, y, angle, maxDist, obstacles) {
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    
    let closestDist = maxDist;
    
    // Check intersection with all nearby obstacles
    for (let i = 0; i < obstacles.length; i++) {
        const ob = obstacles[i];
        let dist = null;
        
        // Check if this is an oriented box (has angle property)
        if (ob.angle !== undefined) {
            dist = rayOrientedBoxIntersect(x, y, dx, dy, ob);
        } else {
            dist = rayRectIntersect(x, y, dx, dy, ob);
        }
        
        if (dist !== null && dist < closestDist) {
            closestDist = dist;
        }
    }
    
    return {
        x: x + dx * closestDist,
        y: y + dy * closestDist
    };
}

function rayRectIntersect(px, py, dx, dy, rect) {
    // rect: {x, y, w, h} (center pos, full width/height)
    const halfW = rect.w / 2;
    const halfH = rect.h / 2;
    const minX = rect.x - halfW;
    const maxX = rect.x + halfW;
    const minY = rect.y - halfH;
    const maxY = rect.y + halfH;

    // Slab method for Ray-AABB intersection
    let tmin = 0;
    let tmax = Infinity;

    // X slab
    if (Math.abs(dx) < 1e-9) {
        // Ray parallel to Y axis
        if (px < minX || px > maxX) return null;
    } else {
        const t1 = (minX - px) / dx;
        const t2 = (maxX - px) / dx;
        tmin = Math.max(tmin, Math.min(t1, t2));
        tmax = Math.min(tmax, Math.max(t1, t2));
    }

    // Y slab
    if (Math.abs(dy) < 1e-9) {
        // Ray parallel to X axis
        if (py < minY || py > maxY) return null;
    } else {
        const t1 = (minY - py) / dy;
        const t2 = (maxY - py) / dy;
        tmin = Math.max(tmin, Math.min(t1, t2));
        tmax = Math.min(tmax, Math.max(t1, t2));
    }

    if (tmax < tmin) return null; // No intersection
    if (tmin < 0) return null; // Intersection behind ray start
    
    return tmin;
}

function rayOrientedBoxIntersect(px, py, dx, dy, box) {
    // Transform ray to box's local coordinate space
    const cos = Math.cos(-box.angle);
    const sin = Math.sin(-box.angle);
    
    // Transform ray origin
    const localPx = (px - box.x) * cos - (py - box.y) * sin;
    const localPy = (px - box.x) * sin + (py - box.y) * cos;
    
    // Transform ray direction
    const localDx = dx * cos - dy * sin;
    const localDy = dx * sin + dy * cos;
    
    // Now do AABB intersection in local space
    const halfW = box.w / 2;
    const halfH = box.h / 2;
    const minX = -halfW;
    const maxX = halfW;
    const minY = -halfH;
    const maxY = halfH;

    let tmin = 0;
    let tmax = Infinity;

    // X slab
    if (Math.abs(localDx) < 1e-9) {
        if (localPx < minX || localPx > maxX) return null;
    } else {
        const t1 = (minX - localPx) / localDx;
        const t2 = (maxX - localPx) / localDx;
        tmin = Math.max(tmin, Math.min(t1, t2));
        tmax = Math.min(tmax, Math.max(t1, t2));
    }

    // Y slab
    if (Math.abs(localDy) < 1e-9) {
        if (localPy < minY || localPy > maxY) return null;
    } else {
        const t1 = (minY - localPy) / localDy;
        const t2 = (maxY - localPy) / localDy;
        tmin = Math.max(tmin, Math.min(t1, t2));
        tmax = Math.min(tmax, Math.max(t1, t2));
    }

    if (tmax < tmin) return null;
    if (tmin < 0) return null;
    
    return tmin;
}

// Export for use by GameLoop
window.clientRender = { render, zoomLevel: 1.0 };

console.log('[ClientRender.js] ✅ Module loaded and clientRender exported');

// --- Collision debug overlay (hold '-' to show) ---
function drawPlayerCollisionDebug(ctx, state, environment, player) {
        const info = window._lastPlayerCollision;
        if (!info || !player) return;
        // Only show recent collisions
        if (Date.now() - (info.t || 0) > 2000) return;

        const camX = state.cameraX || 0;
        const camY = state.cameraY || 0;

        ctx.save();

        // Draw intended vs resolved player positions
        const ix = (info.intended?.x ?? player.x) - camX;
        const iy = (info.intended?.y ?? player.y) - camY;
        const rx = (info.resolved?.x ?? player.x) - camX;
        const ry = (info.resolved?.y ?? player.y) - camY;

        ctx.globalAlpha = 0.95;
        ctx.lineWidth = 2;

        // intended (yellow)
        ctx.strokeStyle = 'rgba(255, 230, 80, 0.95)';
        ctx.beginPath();
        ctx.arc(ix, iy, (player.radius || 26), 0, Math.PI * 2);
        ctx.stroke();

        // resolved (cyan)
        ctx.strokeStyle = 'rgba(80, 220, 255, 0.95)';
        ctx.beginPath();
        ctx.arc(rx, ry, (player.radius || 26), 0, Math.PI * 2);
        ctx.stroke();

        // collider outlines
        const hits = info.hits || [];
        for (let k = 0; k < hits.length; k++) {
                const h = hits[k];
                if (!h) continue;

                if (h.kind === 'enemy') {
                        ctx.strokeStyle = 'rgba(255, 180, 0, 0.95)';
                        ctx.beginPath();
                        ctx.arc((h.x - camX), (h.y - camY), (h.r || 26), 0, Math.PI * 2);
                        ctx.stroke();
                        continue;
                }
                
                if (h.kind === 'serverBlockedBy') {
                        // Marker-only entry; actual colliders should follow as aabb/obox/bounds
                        continue;
                }

                if (h.kind === 'aabb') {
                        const left = (h.x - h.w / 2) - camX;
                        const top = (h.y - h.h / 2) - camY;
                        ctx.strokeStyle = 'rgba(255, 120, 120, 0.95)';
                        ctx.strokeRect(left, top, h.w, h.h);
                        continue;
                }

                if (h.kind === 'obox') {
                        ctx.save();
                        ctx.translate((h.x - camX), (h.y - camY));
                        ctx.rotate(h.angle || 0);
                        ctx.strokeStyle = h.isTrenchWall
                                ? 'rgba(255, 0, 255, 0.95)'   // trench walls pop
                                : 'rgba(120, 255, 120, 0.95)';
                        ctx.strokeRect(-(h.w / 2), -(h.h / 2), h.w, h.h);
                        ctx.restore();
                        continue;
                }

                if (h.kind === 'bounds' && environment) {
                        ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
                        if (ctx.setLineDash) ctx.setLineDash([8, 6]);
                        if (environment.isRectangular) {
                                const left = (-environment.halfWidth) - camX;
                                const top = (-environment.halfHeight) - camY;
                                ctx.strokeRect(left, top, environment.width, environment.height);
                        } else {
                                const b = environment.boundary;
                                const left = (-b) - camX;
                                const top = (-b) - camY;
                                ctx.strokeRect(left, top, b * 2, b * 2);
                        }
                        if (ctx.setLineDash) ctx.setLineDash([]);
                }
        }

        // label near player
        ctx.font = '12px monospace';
        ctx.fillStyle = 'rgba(255,255,255,0.95)';
        const label = hits.length
                ? `COLLISION: ${hits.map(h => {
                        if (h.kind === 'serverBlockedBy') return 'server:BLOCKED';
                        if (h.kind === 'serverCorrection') return `server:${h.reason} Δ(${(h.dx||0).toFixed(1)},${(h.dy||0).toFixed(1)})`;
                        if (h.kind === 'enemy') return `enemy#${h.id}`;
                        if (h.kind === 'aabb') return `aabb#${h.index}${h.type ? ':' + h.type : ''}`;
                        if (h.kind === 'obox') return `obox#${h.index}${h.hazardType ? ':' + h.hazardType : ''}${h.isTrenchWall ? ':trench' : ''}`;
                        if (h.kind === 'bounds') return 'bounds';
                        return 'unknown';
                }).join(' , ')}`
                : 'COLLISION: (none)';
        ctx.fillText(label, rx, ry - (player.radius || 26) - 16);

        ctx.restore();
}
