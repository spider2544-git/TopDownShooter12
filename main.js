/*
	Main orchestrator: sets up canvas, input, camera, and plugs modules.
	Refactored to use modular architecture.
*/

// Using globals Player and Environment defined by separate scripts
// DEBUG constants now loaded from src/core/constants.js

// Get constants from the module (loaded before this script)
const DEBUG = window.GameConstants?.DEBUG || false;
const ENABLE_DEBUG_LOGS = window.GameConstants?.ENABLE_DEBUG_LOGS || false;
const ENABLE_DAMAGE_LOGS = window.GameConstants?.ENABLE_DAMAGE_LOGS || true;

if (typeof window !== 'undefined' && window.console) {
    // Allow a small set of "health/status" warnings even when logs are disabled.
    // IMPORTANT: Console spam can tank FPS, especially with DevTools open.
    const __logAllowList = [
        // NFC / unlock flow
        '[NFC]',
        '[NFCTag]',
        // Global error handlers
        '[Main] Global error:',
        '[Main] Unhandled rejection:',
        // Networking lifecycle
        '[Network] Connected',
        '[Network] Disconnected',
        '[Network] Connection error',
        // Resource / telemetry failures
        'Failed to load resource',
        'ERR_CONNECTION_REFUSED',
        // Phase 1: Context initialization warnings
        '[ClientRender] Context',
        '[ClientUpdate] Context',
        '[Main] Render deferred',
        '[Main] Update deferred',
        '[GameContext]',
        '[Main] DOM ready',
        '[Main] main.js',
        '[Main] ✅',
        '[Main] window.ctx',
        '[ClientBootstrap',
        '[ClientUpdate',
        '[ClientRender',
        '[GameLoop',
        '[Bootstrap]',
        '✅',
        'Module loaded'
    ];
    const __shouldAllowImportant = (args) => {
        try {
            if (!Array.isArray(args) || args.length === 0) return false;
            const first = args[0];
            const msg = (typeof first === 'string') ? first : (first && typeof first.message === 'string' ? first.message : '');
            if (!msg) return false;
            for (let i = 0; i < __logAllowList.length; i++) {
                if (msg.includes(__logAllowList[i])) return true;
            }
        } catch(_) {}
        return false;
    };
    const __rateLimitOk = (key, intervalMs) => {
        try {
            if (!window.__logRateLimiter) window.__logRateLimiter = new Map();
            const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
            const last = window.__logRateLimiter.get(key) || 0;
            if ((now - last) < intervalMs) return false;
            window.__logRateLimiter.set(key, now);
            return true;
        } catch(_) {
            return true; // if rate limiter fails, don't block
        }
    };
    const allowDamageLog = (args) => {
        if (!Array.isArray(args) || args.length === 0) return false;
        for (let i = 0; i < args.length; i++) {
            const value = args[i];
            if (typeof value === 'string' && (
                value.includes('DAMAGE') ||
                value.includes('Damage') ||
                value.includes('hit flash') ||
                value.includes('Hit flash')
            )) {
                return true;
            }
        }
        return false;
    };

    // NOTE: console spam can tank FPS hard when DevTools is open.
    // Keep the in-game HUD via GameConstants.DEBUG, but gate console output via ENABLE_DEBUG_LOGS / ENABLE_DAMAGE_LOGS.
    ['log', 'debug', 'info', 'warn'].forEach(level => {
        const original = window.console[level];
        if (typeof original !== 'function') return;

        if (!window.console[`__original_${level}`]) {
            window.console[`__original_${level}`] = original.bind(window.console);
        }

        if (ENABLE_DEBUG_LOGS) {
            window.console[level] = window.console[`__original_${level}`];
            return;
        }

        window.console[level] = (...args) => {
            // When debug logs are off, only allow selected "damage-ish" logs if explicitly enabled.
            if (ENABLE_DAMAGE_LOGS && allowDamageLog(args)) {
                window.console[`__original_${level}`](...args);
                return;
            }
            // Allow important health/status warnings at a low rate even when logs are off.
            if (__shouldAllowImportant(args)) {
                const key = `${level}:${String(args[0]).slice(0, 120)}`;
                if (__rateLimitOk(key, 2000)) {
                    window.console[`__original_${level}`](...args);
                }
            }
        };
    });
}

// Debug: reduce Artillery Witch explosion damage to 1.
// To disable this debug damage, comment out the next line.
// window.DEBUG_ARTILLERY_LOW_DAMAGE = true;

// Global error handlers
window.addEventListener('error', (e) => {
        console.error('[Main] Global error:', e.message, e.error);
});
window.addEventListener('unhandledrejection', (e) => {
        console.error('[Main] Unhandled rejection:', e.reason);
});

// Use new GameState class
const state = new GameState();
// Expose state globally for GameLoop and other modules
window.state = state;

// CRITICAL: Initialize ClientBootstrap for game initialization
const bootstrap = new ClientBootstrap();
bootstrap.state = state;
// Expose bootstrap globally for diagnostics and other modules
window.bootstrap = bootstrap;

// Initialize default dialogue flags for level selection
window.dialogueFlags = window.dialogueFlags || {};
if (!window.dialogueFlags.selectedLevel) {
	window.dialogueFlags.selectedLevel = 'extraction'; // Default to Extraction mission (client-side only for UI)
}

// SERVER-AUTHORITATIVE level selection (synced from server)
window.serverLevelType = 'extraction'; // This is the SOURCE OF TRUTH - all players see the same value

// Client-side game mode instance for mode-specific rendering/logic
window.currentGameMode = null;

// Client mode factory function
function getClientModeClass(levelType) {
	const modes = {
		'test': ClientTestMode,
		'extraction': ClientExtractionMode,
		'payload': ClientPayloadMode,
		'trenchraid': ClientTrenchRaidMode
	};
	return modes[levelType] || ClientTestMode; // Default to ClientTestMode if unknown
}

// Get references to canvas and game objects (will be set by bootstrap)
let canvas = null;
let ctx = null;
let player = null;
let environment = null;
let worldInitialized = false;
let projectiles = null;
let enemies = null;
let director = null;
let ui = null;

// Currency pickups (magnet attraction)
let ducatPickups = [];
let bloodMarkerPickups = [];

// Expose globally for network handlers
window.ducatPickups = ducatPickups;
window.bloodMarkerPickups = bloodMarkerPickups;
let modeTimer = null;
let npcs = null;
let scene = { current: 'lobby' };
let chests = [];
let extractionZone = null;
let hereticExtractionZone = null;
let otherPlayers = [];
let dialogue = null; // DialogueBox instance (initialized by bootstrap)

// Expose extraction zones to networking code
Object.defineProperty(window, 'extractionZone', {
    get: () => extractionZone,
    set: (val) => { extractionZone = val; }
});
Object.defineProperty(window, 'hereticExtractionZone', {
    get: () => hereticExtractionZone,
    set: (val) => { hereticExtractionZone = val; }
});

// DEPRECATED: Target dummy is now server-authoritative only
function createLocalTargetDummy() {
    try {
        console.warn('[Main] createLocalTargetDummy is deprecated - target dummy is server-authoritative');
        
        // Remove existing target dummy if present
        for (let i = enemies.items.length - 1; i >= 0; i--) {
            if (enemies.items[i].isTargetDummy) {
                enemies.items.splice(i, 1);
            }
        }
        
        const r = 32; // TargetDummy radius
        const b = environment.boundary;
        // Upper left corner: x near left wall + margin; y near top wall + margin
        const x = -b + r + 100;  // Left side with margin
        const y = -b + r + 100;  // Top side with margin
        let tx = x, ty = y;
        
        // If blocked, find a clear spot nearby
        if (environment.isObstacle(tx, ty)) {
            console.log('[Main] Original target dummy position blocked, finding alternative');
            let found = false;
            const searchRadius = 200;
            for (let attempt = 0; attempt < 20 && !found; attempt++) {
                const angle = Math.random() * 2 * Math.PI;
                const dist = 50 + Math.random() * searchRadius;
                tx = x + Math.cos(angle) * dist;
                ty = y + Math.sin(angle) * dist;
                if (!environment.isObstacle(tx, ty)) {
                    found = true;
                }
            }
            if (!found) {
                console.log('[Main] Could not find clear spot for target dummy, using original position');
                tx = x; ty = y;
            }
        }
        
        console.log('[Main] Target dummy spawned at:', {x: tx, y: ty});
        const targetDummy = new window.TargetDummy(tx, ty);
        enemies.items.push(targetDummy);
        if (typeof enemies._insert === 'function') {
            enemies._insert(targetDummy);
        }
    } catch(e) {
        console.error('[Main] Error spawning target dummy:', e);
    }
}

// Expose initializeWorld wrapper for networking.js to call
window.initializeWorld = (seed) => {
	if (bootstrap && typeof bootstrap.initializeWorld === 'function') {
		bootstrap.initializeWorld(seed);
		// Sync references after initialization
		environment = bootstrap.environment;
		worldInitialized = bootstrap.worldInitialized;
		director = bootstrap.director; // CRITICAL: Sync director reference
		
		// Phase 1: Update GameContext after world initialization
		if (window.ctx) {
			window.ctx.environment = bootstrap.environment;
			window.ctx.director = bootstrap.director;
			console.log('[Main] GameContext updated after world initialization');
		}
	}
};

// REMOVED: boot() function now in ClientBootstrap
// REMOVED: initializeMultiplayer() function now in ClientBootstrap
// REMOVED: startWorldInitWatchdog() function now in ClientBootstrap
// REMOVED: placePlayerRandomly() function now in ClientBootstrap
// REMOVED: spawnLobbyMerchant() function now in ClientBootstrap
// REMOVED: spawnLobbyCommander() function now in ClientBootstrap
// REMOVED: spawnTargetDummy() function now in ClientBootstrap

// ============================================================================
// GAME LOOP AND RENDERING - Core gameplay functions
// ============================================================================

// Function to render other players with per-frame interpolation (uses MultiplayerRenderer)
function renderOtherPlayers(ctx) {
	if (!window.networkManager) return;
	
	// Use the new MultiplayerRenderer
	if (window.multiplayerRenderer) {
		window.multiplayerRenderer.renderOtherPlayers(ctx, state, window.networkManager);
		return;
	}
	
	// Fallback to inline implementation if multiplayerRenderer not initialized
	if (!window.networkManager) return;
    
    // Get interpolated other players per frame (not cached)
    try {
        otherPlayers = window.networkManager.getOtherPlayers();
        if (otherPlayers.length === 0) return;
    } catch (error) {
        console.warn('[Main] Error getting other players:', error);
        return;
    }
    
    for (const otherPlayer of otherPlayers) {
        // Calculate screen position
        const screenX = otherPlayer.x - state.cameraX;
        const screenY = otherPlayer.y - state.cameraY;
        
        // Only render if on screen
        if (screenX < -50 || screenX > state.viewportWidth + 50 || 
            screenY < -50 || screenY > state.viewportHeight + 50) {
            continue;
        }
        
        // Speed trail (draw behind player body)
        if (otherPlayer._trailPoints && otherPlayer._trailPoints.length > 0) {
            for (let i = otherPlayer._trailPoints.length - 1; i >= 0; i--) {
                const p = otherPlayer._trailPoints[i];
                const k = Math.max(0, Math.min(1, p.life / (p.max || 0.001)));
                // Direction from player to this trail point (behind direction)
                const bx = p.x - otherPlayer.x;
                const by = p.y - otherPlayer.y;
                const bdist = Math.hypot(bx, by) || 0.0001;
                const bux = bx / bdist;
                const buy = by / bdist;
                // Length scales with current speed, but do not exceed distance to this point
                const baseSpeed = 220;
                const speedFactor = Math.max(0.75, Math.min(3, (otherPlayer._instantSpeed || 0) / baseSpeed));
                const maxLen = Math.min(70, 26 * speedFactor);
                const len = Math.min(maxLen, bdist) * k;
                // Start slightly behind the player's center so it never pokes out in front
                const inset = Math.max(0, (otherPlayer.radius || 20) * 0.55);
                const sx = (otherPlayer.x + bux * inset) - state.cameraX;
                const sy = (otherPlayer.y + buy * inset) - state.cameraY;
                const ex = sx + bux * len;
                const ey = sy + buy * len;
                ctx.save();
                // Softer overall opacity with stronger fade away from body (near sx -> ex)
                const nearA = 0.2 * k;
                const farA = 0.0;
                const grad = ctx.createLinearGradient(sx, sy, ex, ey);
                // Use different color for other players (darker blue trail)
                grad.addColorStop(0, `rgba(25, 118, 210, ${nearA})`); // #1976D2 with alpha
                grad.addColorStop(1, `rgba(25, 118, 210, ${farA})`);
                ctx.fillStyle = grad;
                // Build a tapered quad: wide at the near end, narrow at the far end
                const baseWidth = Math.max(2, (otherPlayer.radius || 20) * 1.2);
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

        // Aim direction indicator (draw UNDER player); hide while dead
        if (typeof otherPlayer.aimAngle === 'number' && (otherPlayer.health == null || otherPlayer.health > 0)) {
            const aimLength = 50; // Increased from 35 for better visibility
            const aimEndX = screenX + Math.cos(otherPlayer.aimAngle) * aimLength;
            const aimEndY = screenY + Math.sin(otherPlayer.aimAngle) * aimLength;
            
            // Aim line only (no arrow tip)
            ctx.strokeStyle = '#FFF';
            ctx.lineWidth = 3;
            ctx.lineCap = 'round';
            ctx.beginPath();
            ctx.moveTo(screenX, screenY);
            ctx.lineTo(aimEndX, aimEndY);
            ctx.stroke();
        }
        
        // Draw player body as a different colored circle
        ctx.save();
        
        // Player body - darker blue color; ghosted if dead
        const isGhostOther = (typeof otherPlayer.health === 'number' && otherPlayer.health <= 0);
        ctx.globalAlpha = isGhostOther ? 0.5 : 1.0;
        ctx.fillStyle = '#1976D2'; // Darker blue color for other players
        ctx.beginPath();
        ctx.arc(screenX, screenY, otherPlayer.radius || 20, 0, Math.PI * 2);
        ctx.fill();
        
        // Player outline
        ctx.strokeStyle = '#0D47A1'; // Darker blue outline
        ctx.lineWidth = 2;
        ctx.stroke();
        
        ctx.restore();
        
        // Magenta ensnare ring while captured by Licker (same as local player)
        try {
            if (otherPlayer._ensnaredTimer && otherPlayer._ensnaredTimer > 0) {
                const t = otherPlayer._ensnarePulseT || 0;
                const pulse = 0.5 + 0.5 * (Math.sin(t * Math.PI * 2 * 1.2) * 0.5 + 0.5); // gentle pulse
                const ringR = (otherPlayer.radius || 20) + 10 + 3 * pulse;
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
        
        // Hit flash effect (red overlay when damaged)
        try {
            const mgr = window.networkManager;
            if (mgr && mgr.remoteHitFlashPlayers && mgr.remoteHitFlashPlayers.has(otherPlayer.id)) {
                const flashData = mgr.remoteHitFlashPlayers.get(otherPlayer.id);
                if (flashData && flashData.hitFlash > 0) {
                    const hitFlashMax = 0.12; // Same as local player
                    const t = Math.max(0, Math.min(1, flashData.hitFlash / hitFlashMax));
                    ctx.save();
                    ctx.globalAlpha = Math.pow(t, 0.4) * 0.9; // Strong at start, fast fade
                    ctx.fillStyle = '#ff3b3b';
                    ctx.beginPath();
                    ctx.arc(screenX, screenY, otherPlayer.radius || 20, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.restore();
                }
            }
        } catch(_) {}
        
        // Slime slow VFX for remote players (with falling drips)
        try {
            const mgr = window.networkManager;
            if (mgr && mgr.remoteSlowedPlayers && mgr.remoteSlowedPlayers.has(otherPlayer.id) && 
                (otherPlayer.health == null || otherPlayer.health > 0)) {
                // Pulse aura
                const t = (Date.now() % 200000) / 1000;
                const pulse = Math.sin(t * Math.PI * 2 * 0.8) * 0.5 + 0.5; // 0..1
                const a = 0.3 + 0.3 * pulse;
                ctx.save();
                ctx.globalAlpha = a;
                ctx.fillStyle = '#a8c400';
                ctx.beginPath();
                ctx.arc(screenX, screenY, (otherPlayer.radius || 20) + 2, 0, Math.PI * 2);
                ctx.fill();
                ctx.restore();

                // Drip integrator per remote player (world-space)
                const entry = mgr.remoteSlowedPlayers.get(otherPlayer.id) || {};
                if (!entry.drips) entry.drips = [];
                if (typeof entry.spawnTimer !== 'number') entry.spawnTimer = 0;
                const dt = (typeof window !== 'undefined' && window.state && Number.isFinite(window.state._lastDt)) ? window.state._lastDt : 0.016;
                entry.spawnTimer -= dt;
                const spawnEvery = 0.08;
                while (entry.spawnTimer <= 0) {
                    entry.spawnTimer += spawnEvery;
                    const count = 1 + Math.floor(Math.random() * 2);
                    for (let i = 0; i < count; i++) {
                        const ang = (Math.random() * Math.PI) + Math.PI * 0.5; // downward-ish
                        const offR = (otherPlayer.radius || 20) * (0.2 + Math.random() * 0.6);
                        const spawnX = otherPlayer.x + Math.cos(ang) * offR * 0.4;
                        const spawnY = otherPlayer.y + (otherPlayer.radius || 20) * 0.6 + Math.sin(ang) * 2;
                        const vy = 60 + Math.random() * 80;
                        const vx = (Math.random() * 2 - 1) * 25;
                        const life = 0.5 + Math.random() * 0.6;
                        const rad = 1.5 + Math.random() * 2.5;
                        entry.drips.push({ x: spawnX, y: spawnY, vx, vy, life, total: life, r: rad });
                    }
                }
                // Integrate and cull
                for (let i = entry.drips.length - 1; i >= 0; i--) {
                    const d = entry.drips[i];
                    d.vy += 220 * dt;
                    d.x += d.vx * dt;
                    d.y += d.vy * dt;
                    d.life -= dt;
                    if (d.life <= 0) entry.drips.splice(i, 1);
                }
                // Cap
                if (entry.drips.length > 120) entry.drips.splice(0, entry.drips.length - 120);
                // Draw
                for (let i = 0; i < entry.drips.length; i++) {
                    const d = entry.drips[i];
                    const k = Math.max(0, Math.min(1, d.life / (d.total || 0.001)));
                    const sx0 = d.x - state.cameraX;
                    const sy0 = d.y - state.cameraY;
                    ctx.save();
                    ctx.globalAlpha = 0.18 * k;
                    ctx.fillStyle = '#a8c400';
                    ctx.beginPath();
                    ctx.arc(sx0, sy0, d.r * 2.2, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.globalAlpha = 0.9 * k;
                    ctx.beginPath();
                    ctx.arc(sx0, sy0, d.r, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.globalAlpha = 0.5 * k;
                    ctx.strokeStyle = '#4a5c11';
                    ctx.lineWidth = 1;
                    ctx.beginPath();
                    ctx.arc(sx0, sy0, d.r, 0, Math.PI * 2);
                    ctx.stroke();
                    ctx.restore();
                }
                // Write back entry in map
                mgr.remoteSlowedPlayers.set(otherPlayer.id, entry);
            }
        } catch(_) {}
        
        // Health bar (still visible for clarity)
        const healthPercent = (otherPlayer.health || 100) / (otherPlayer.healthMax || 100);
        const barWidth = 30;
        const barHeight = 4;
        const barX = screenX - barWidth / 2;
        const barY = screenY - (otherPlayer.radius || 20) - 10;
        
        // Health bar background
        ctx.fillStyle = '#333';
        ctx.fillRect(barX, barY, barWidth, barHeight);
        
        // Health bar fill
        ctx.fillStyle = healthPercent > 0.5 ? '#4CAF50' : healthPercent > 0.25 ? '#FF9800' : '#F44336';
        ctx.fillRect(barX, barY, barWidth * healthPercent, barHeight);
        
        // Player ID indicator (first 6 chars)
        ctx.fillStyle = '#FFF';
        ctx.font = '10px Arial';
        ctx.textAlign = 'center';
        const playerId = otherPlayer.id ? otherPlayer.id.substring(0, 6) : 'Unknown';
        ctx.fillText(playerId, screenX, screenY + (otherPlayer.radius || 20) + 15);

        // If this other player is carrying the artifact, render it on their back
        try {
            if (window.networkManager && window.networkManager.artifactCarrierId === otherPlayer.id) {
                // Draw the artifact diamond behind the player center, offset by their aimAngle
                const rPlayer = otherPlayer.radius || 20;
                const aim = (typeof otherPlayer.aimAngle === 'number') ? otherPlayer.aimAngle : 0;
                const backAng = aim + Math.PI;
                const dist = rPlayer + 18;
                const ax = screenX + Math.cos(backAng) * dist;
                const ay = screenY + Math.sin(backAng) * dist;
                const r = 12;
                ctx.save();
                ctx.shadowColor = '#4df2ff';
                ctx.shadowBlur = 16;
                ctx.fillStyle = '#8af7ff';
                ctx.strokeStyle = '#2bc7d6';
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.moveTo(ax, ay - r);
                ctx.lineTo(ax + r, ay);
                ctx.lineTo(ax, ay + r);
                ctx.lineTo(ax - r, ay);
                ctx.closePath();
                ctx.fill();
                ctx.stroke();
                ctx.restore();
            }
        } catch(_) {}
        
        // Burning flame VFX for remote players - drawn LAST so it's on top of everything
        try {
            if (window.networkManager && window.networkManager.remoteBurningPlayers && 
                window.networkManager.remoteBurningPlayers.has(otherPlayer.id) && 
                (otherPlayer.health == null || otherPlayer.health > 0)) {
                ctx.save();
                ctx.globalCompositeOperation = 'source-over'; // Ensure fire draws on top
                // Render flame effect similar to local player burning VFX
                const burnData = window.networkManager.remoteBurningPlayers.get(otherPlayer.id);
                const burnDuration = Date.now() - burnData.startTime;
                const intensity = Math.min(1.2, 1.0); // Use fixed intensity for remote players
                const baseR = (otherPlayer.radius || 20) * (0.9 + 0.6 * intensity);
                const t = burnDuration / 1000; // Convert to seconds for animation timing
                const wobble = Math.sin(t * 6) * 0.12;
                const sx0 = screenX + wobble * (otherPlayer.radius || 20) * 0.25;
                const sy0 = screenY - (otherPlayer.radius || 20) * (0.25 + 0.06 * Math.sin(t * 4 + (otherPlayer.id?.charCodeAt?.(0) || 1)));
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
                    const r = (otherPlayer.radius || 20) * (0.3 + Math.random() * 0.6);
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
        } catch(_) {}
    }
}

// Send input to server (uses InputManager)
function sendPlayerInput(ctx) {
	// Phase 1: Accept optional ctx parameter, fall back to legacy globals for compatibility
	const gameCtx = ctx || window.ctx;
	const inputMgr = gameCtx?.input || window.inputManager;
	const netMgr = gameCtx?.net || window.networkManager;
	const localPlayer = gameCtx?.player || player;
	
	if (inputMgr && localPlayer && netMgr) {
		inputMgr.sendPlayerInput(localPlayer, true, netMgr);
	}
}

// Apply input to player for rollback re-simulation (uses InputManager)
function applyInputToPlayer(player, input) {
	if (window.inputManager) {
		window.inputManager.applyInputToPlayer(player, input, environment);
	}
}
// Scene switchers
window.startLevelFromLobby = function(serverObstacles, serverLevelSpawns, serverEnemies, levelType) {
    try {
        if (scene.current === 'level') return;
        
        // Get level config based on type
        const levelConfig = window.LevelConfigs ? window.LevelConfigs.get(levelType || 'extraction') : null;
        console.log('[Level] Starting level:', levelType, 'with config:', levelConfig);
        
        // Switch to main game environment with level-specific colors
        scene.current = 'level';
        environment = new Environment(serverObstacles, levelConfig);
        window.environment = environment;
        
        // CRITICAL: Sync to GameContext
        if (window.ctx) {
            window.ctx.environment = environment;
            console.log('[Level] ✅ Environment synced to GameContext');
        }
        
        // Clear all abilities from lobby (walls, etc.)
        if (window.abilityManager) {
                console.log('[Level] Clearing', window.abilityManager.abilities.length, 'abilities from lobby');
                // Properly expire each ability to clean up environment obstacles
                for (let i = window.abilityManager.abilities.length - 1; i >= 0; i--) {
                        const ability = window.abilityManager.abilities[i];
                        if (ability && typeof ability.onExpire === 'function') {
                                ability.onExpire();
                        }
                }
                window.abilityManager.abilities = [];
        }
        
        // Store current level type globally
        window.currentLevelType = levelType || 'extraction';
        
        // Initialize client-side game mode
        const gameModeConfig = window.GameModeConfigs ? window.GameModeConfigs.get(levelType || 'extraction') : null;
        const ClientModeClass = getClientModeClass(levelType || 'extraction');
        window.currentGameMode = new ClientModeClass(levelType || 'extraction', gameModeConfig);
        window.currentGameMode.onLevelStart();
        console.log('[ClientGameMode] Initialized client mode for', levelType);
        
        // Enable server-driven timer for Extraction mode
        if ((levelType || 'extraction') === 'extraction' && modeTimer) {
            modeTimer.serverDriven = true;
            modeTimer.currentName = 'Search';
            modeTimer.timeLeft = 15;  // Initial value, will be updated by server
            console.log('[ModeTimer] Enabled server-driven mode for Extraction');
        }
        // Keep director in sync
        try { director.environment = environment; } catch(_) {}
        // Notify multiplayer server of scene change
        try {
            if (window.networkManager?.connected) {
                window.networkManager.notifySceneChange('level', environment.boundary);
            }
        } catch(_) {}
        // Reset/clear state specific to level start
        // Clear enemies and npcs, chests, drops, extraction
        enemies.items.length = 0;
        if (typeof enemies.grid?.clear === 'function') enemies.grid.clear();
        npcs.items.length = 0;
        if (!window._npcByServerId) window._npcByServerId = new Map();
        window._npcByServerId.clear();
        try { if (window.bossDrops && Array.isArray(window.bossDrops)) window.bossDrops.length = 0; } catch(_) {}
        // Reset gameplay flags
        state.extractionEnd = null;
        state.isFrozen = false;
        state.bossSpawned = false;
        state.artifactEverPicked = false;
        // Reset player status
        player.health = player.healthMax;
        // Reset containers dependent on environment
        chests.length = 0;
        extractionZone = null;
        // Spawn initial level content (prefer server-authoritative spawns if provided)
        let goldX = null, goldY = null;
        (function placeChestLevel(){
            if (!window.GameObjects || !window.GameObjects.Chest) return;
            const { Chest } = window.GameObjects;
            const spawns = serverLevelSpawns || (typeof window !== 'undefined' && window.__serverLevelSpawns) || null;
            console.log('[DEBUG_CHEST] [Client] placeChestLevel called');
            console.log('[DEBUG_CHEST] [Client] spawns:', spawns);
            if (spawns && Array.isArray(spawns.chests)) {
                console.log(`[DEBUG_CHEST] [Client] Found ${spawns.chests.length} chests to spawn`);
                for (let i = 0; i < spawns.chests.length; i++) {
                    const c = spawns.chests[i];
                    const chest = new Chest(c.x, c.y, { variant: c.variant });
                    chests.push(chest);
                    console.log(`[DEBUG_CHEST] [Client] Spawned chest ${i}: id=${c.id}, variant=${c.variant}, pos=(${c.x.toFixed(0)}, ${c.y.toFixed(0)})`);
                }
                console.log(`[DEBUG_CHEST] [Client] Total chests in game: ${chests.length}`);
                const gold = spawns.chests.find(c => c.variant === 'gold');
                if (gold) { goldX = gold.x; goldY = gold.y; }
                // NPCs are spawned by ServerNPCManager and replicated via npcsState (server-authoritative)
                console.log('[Scene] Skipping client-side NPC spawns - using server-authoritative NPCs');
                console.log('[Scene] Applied server-provided level spawns');
                return;
            }
            // No server spawns available - this should not happen in multiplayer
            console.error('[Scene] No server spawns available - cannot start level without server data');
        })();
        // Enemies (server authoritative only; no client fallback)
        console.log('[CLIENT] serverEnemies:', serverEnemies);
        if (Array.isArray(serverEnemies) && serverEnemies.length > 0) {
            console.log(`[CLIENT] Spawning ${serverEnemies.length} enemies from server data`);
            console.log('[CLIENT] Enemy types:', serverEnemies.map(e => e.type).join(', '));
            const Cls = (typeof window.Enemy === 'function') ? window.Enemy : (typeof Enemy === 'function' ? Enemy : null);
            if (Cls) {
                if (!window._enemyByServerId) window._enemyByServerId = new Map();
                window._enemyByServerId.clear();
                for (let i = 0; i < serverEnemies.length; i++) {
                    const e = serverEnemies[i]; if (!e) continue;
                    let inst = null;
                    if (e.type === 'defenseTurret') {
                        // Create defensive turret (large, stationary, like AutoTurret)
                        console.log(`[CLIENT] Creating defensive turret at (${e.x}, ${e.y})`);
                        inst = new Cls(e.x, e.y);
                        inst.type = 'defenseTurret';
                        inst.radius = 48;
                        inst.color = '#ff9900'; // Orange for New Antioch
                        inst.outline = '#cc7700';
                        inst.health = 999999;
                        inst.healthMax = 999999;
                        inst.speedMul = 0; // Stationary
                        inst._barrelAngle = 0; // Rotation angle
                        inst._muzzleFlashes = []; // Muzzle flash effects
                        inst._currentBarrel = 0; // Alternate between barrels
                        console.log(`[CLIENT] Created defensive turret:`, inst);
                    } else if (e.type === 'artilleryGun') {
                        // Create artillery gun (large, stationary, shoots into Zone A)
                        console.log(`[CLIENT] Creating artillery gun at (${e.x}, ${e.y})`);
                        inst = new Cls(e.x, e.y);
                        inst.type = 'artilleryGun';
                        inst.radius = 64;
                        inst.color = '#ffcc00'; // Golden for New Antioch artillery
                        inst.outline = '#cc9900';
                        inst.health = 999999;
                        inst.healthMax = 999999;
                        inst.speedMul = 0; // Stationary
                        inst._barrelAngle = 0; // Rotation angle toward target
                        console.log(`[CLIENT] Created artillery gun:`, inst);
                    } else if (e.type === 'projectile' && window.ProjectileZombie) {
                        inst = new window.ProjectileZombie(e.x, e.y);
                    } else if (e.type === 'boomer' && window.Boomer) {
                        inst = new window.Boomer(e.x, e.y);
                    } else if (e.type === 'licker' && window.Licker) {
                        inst = new window.Licker(e.x, e.y);
                    } else if (e.type === 'bigboy' && window.BigBoy) {
                        inst = new window.BigBoy(e.x, e.y);
                    } else {
                        inst = new Cls(e.x, e.y);
                    }
                    inst._serverId = e.id;
                    inst.serverSpawned = true;
                    enemies.items.push(inst);
                    if (typeof enemies._insert === 'function') enemies._insert(inst);
                    window._enemyByServerId.set(e.id, inst);
                }
            }
            console.log('[Scene] Spawned enemies from server:', serverEnemies.length);
        }
        // Place NPCs using existing helper if present
        try { if (typeof window._relocateNPCsIfNeeded === 'function') window._relocateNPCsIfNeeded(); } catch(_) {}
        // Center camera on player in new scene
        state.cameraX = player.x - state.viewportWidth / 2;
        state.cameraY = player.y - state.viewportHeight / 2;
    } catch(e) { console.error('[Scene] Failed to start level from lobby:', e); }
};
window.returnToLobby = function(serverObstacles) {
    try {
        const serverDriven = Array.isArray(serverObstacles);
        // If we're already in lobby but the server is providing authoritative obstacles,
        // we MUST rebuild the environment to restore default lobby geometry (shooting gallery sandbags, etc.).
        if (scene.current === 'lobby' && !serverDriven) return;
        scene.current = 'lobby';
        environment = new (window.EnvironmentLobby || Environment)(serverObstacles);
        window.environment = environment;
        
        // CRITICAL: Sync to GameContext
        if (window.ctx) {
            window.ctx.environment = environment;
            console.log('[Lobby] ✅ Environment synced to GameContext');
        }
        
        // Keep director in sync
        try { 
            director.environment = environment;
            if (window.ctx) {
                window.ctx.director = director;
            }
        } catch(_) {}
        // Notify multiplayer server of scene change
        // Avoid echoing a server-driven sceneChange back to the server.
        try {
            if (!serverDriven && window.networkManager?.connected) {
                window.networkManager.notifySceneChange('lobby', environment.boundary);
            }
        } catch(_) {}
        // Reset world containers
        enemies.items.length = 0;
        if (typeof enemies.grid?.clear === 'function') enemies.grid.clear();
        npcs.items.length = 0;
        if (!window._npcByServerId) window._npcByServerId = new Map();
        window._npcByServerId.clear();
        
        // Reset mode timer to client-driven (for lobby)
        if (modeTimer) {
            modeTimer.serverDriven = false;
            modeTimer.currentName = 'Search';
            modeTimer.timeLeft = 10;
            console.log('[ModeTimer] Reset to client-driven mode for lobby');
        }
        
        // Remove artifact from player if they're carrying it
        try {
            for (let i = 0; i < chests.length; i++) {
                const chest = chests[i];
                if (chest && chest.artifact && chest.artifact.carriedBy) {
                    chest.artifact.carriedBy = null;
                    chest.artifact = null;
                }
            }
        } catch(_) {}
        
        // Clear artifact carrier tracking in multiplayer
        try {
            if (window.networkManager) {
                window.networkManager.artifactCarrierId = null;
            }
        } catch(_) {}
        
        chests.length = 0;
        extractionZone = null;
        hereticExtractionZone = null;
        // NOTE: Do NOT clear bossDrops when returning to lobby.
        // Players should be able to drop/trade loot in the lobby, and we only clear drops when starting a new level.
        // Reset player and state
        state.extractionEnd = null;
        state.missionAccomplishments = null;
        state.isFrozen = false; // Unfreeze gameplay when returning to lobby
        state.bossSpawned = false;
        state.artifactEverPicked = false;
        // If converted heretic success occurred, clear conversion state and UI progress
        try {
            if (typeof window !== 'undefined') {
                window.__killThemAllLocked = false;
                window.__killThemAllProgress = 0;
                if (window.dialogueFlags) {
                    window.dialogueFlags.playerConverted = false;
                }
            }
        } catch(_) {}
        player.health = player.healthMax;
        
        // Clear all status effects
        try {
            // Clear DOT stacks
            if (Array.isArray(player._playerDotStacks)) player._playerDotStacks.length = 0;
            player._playerDotAccum = 0;
            player._playerDotTextTimer = 0;
            
            // Clear ensnare effects
            if (player._ensnaredBy && typeof player._ensnaredBy.clear === 'function') player._ensnaredBy.clear();
            player._ensnaredTimer = 0;
            player._ensnarePulseT = 0;
            
            // Clear puke pool slow/slime VFX
            if (Array.isArray(player._slimeDrips)) player._slimeDrips.length = 0;
            player._slimeSpawnTimer = 0;
            player._slimePulseT = 0;
            if (player._slowState) {
                player._slowState.active = false;
                player._slowState.timer = 0;
                player._slowState.fade = 0;
            }
            
            console.log('[Lobby] Cleared all player status effects');
        } catch(e) {
            console.error('[Lobby] Error clearing status effects:', e);
        }
        
        // Clear all abilities (shield walls, turrets, mines, etc.)
        try {
            if (window.abilityManager) {
                console.log('[Lobby] Clearing', window.abilityManager.abilities.length, 'abilities when returning to lobby');
                // Properly expire each ability to clean up environment obstacles
                for (let i = window.abilityManager.abilities.length - 1; i >= 0; i--) {
                    const ability = window.abilityManager.abilities[i];
                    if (ability && typeof ability.onExpire === 'function') {
                        ability.onExpire();
                    }
                }
                window.abilityManager.abilities = [];
                console.log('[Lobby] Cleared all abilities');
            }
        } catch(e) {
            console.error('[Lobby] Error clearing abilities:', e);
        }
        
        // Clear all projectiles and VFX
        try {
            if (projectiles) {
                // Return bullets to pool if pooling is enabled
                if (typeof window.releaseBullet === 'function' && Array.isArray(projectiles.items)) {
                    for (let i = 0; i < projectiles.items.length; i++) {
                        window.releaseBullet(projectiles.items[i]);
                    }
                }
                // Clear all projectile arrays
                if (Array.isArray(projectiles.items)) projectiles.items.length = 0;
                if (Array.isArray(projectiles.impacts)) projectiles.impacts.length = 0;
                console.log('[Lobby] Cleared all projectiles and VFX');
            }
        } catch(e) {
            console.error('[Lobby] Error clearing projectiles:', e);
        }
        
        // Clear currency pickups
        try {
            if (Array.isArray(ducatPickups)) ducatPickups.length = 0;
            if (Array.isArray(bloodMarkerPickups)) bloodMarkerPickups.length = 0;
            if (Array.isArray(window.ducatPickups)) window.ducatPickups.length = 0;
            if (Array.isArray(window.bloodMarkerPickups)) window.bloodMarkerPickups.length = 0;
            console.log('[Lobby] Cleared all currency pickups');
        } catch(e) {
            console.error('[Lobby] Error clearing currency pickups:', e);
        }
        
        // Clear all environment hazards (gas, mud, fire pools, sandbags, etc.)
        try {
            // Clear hazards data object
            window.hazards = null;
            
            // Clear fire pool instances
            if (window._envFirePools) {
                window._envFirePools.clear();
            }
            
            // Clear gas canister instances
            if (window._envGasCanisters) {
                window._envGasCanisters.clear();
            }
            
            // Clear exploding barrels manager
            if (window.barrelManager) {
                window.barrelManager.barrels.clear();
            }
            
            // Clear ground decals (mud pools, blood pools, puke pools)
            if (typeof window.clearGroundDecals === 'function') {
                window.clearGroundDecals();
            }
            
            console.log('[Lobby] Cleared all environment hazards');
        } catch(e) {
            console.error('[Lobby] Error clearing hazards:', e);
        }
        
        // Clear mission-specific decorations (RadioTower, BatteryStation)
        try {
            // Clear BatteryStation
            if (window._batteryStation) {
                window._batteryStation = null;
                console.log('[Lobby] Cleared BatteryStation');
            }

            // Clear any spawned batteries (RadioTower power system)
            if (Array.isArray(window._batteries) && window._batteries.length) {
                window._batteries.length = 0;
                console.log('[Lobby] Cleared Batteries');
            } else {
                // Ensure it's always an array so networking handlers don't append to stale refs
                window._batteries = [];
            }
            
            // Clear RadioTower from decorations array
            if (window._decorations && Array.isArray(window._decorations)) {
                const beforeCount = window._decorations.length;
                window._decorations = window._decorations.filter(dec => 
                    !dec || !dec.constructor || dec.constructor.name !== 'RadioTower'
                );
                const afterCount = window._decorations.length;
                if (beforeCount !== afterCount) {
                    console.log(`[Lobby] Removed ${beforeCount - afterCount} RadioTower(s) from decorations`);
                }
            }

            // Trench-raid decorations are never used in lobby; fully reset the decoration system
            window._decorations = [];
            window._decorationsInitialized = false;
            
            console.log('[Lobby] Cleared mission-specific decorations');
        } catch(e) {
            console.error('[Lobby] Error clearing mission decorations:', e);
        }
        
        // Place player at lobby center area
        player.x = 0; player.y = 0;
        environment.spawnSafeX = 0; environment.spawnSafeY = 0; environment.spawnSafeRadius = 200;
        // Clear stored level-entry spawn when returning to lobby
        try { player._spawnX = null; player._spawnY = null; } catch(_) {}
        state.cameraX = player.x - state.viewportWidth / 2;
        state.cameraY = player.y - state.viewportHeight / 2;
        // Respawn Merchant at upper center
        try {
            if (window.Merchant) {
                const r = 24;
                const b = environment.boundary;
                const x = 200;
                const y = -b + r + 80;
                let mx = x, my = y;
                if (!environment.isInsideBounds(mx, my, r) || environment.circleHitsAny(mx, my, r)) {
                    for (let dy = 100; dy <= 600; dy += 60) {
                        const ty = -b + r + 80 + dy;
                        if (environment.isInsideBounds(x, ty, r) && !environment.circleHitsAny(x, ty, r)) { my = ty; break; }
                    }
                }
                npcs.add(new window.Merchant(mx, my));
            }
        } catch(_) {}
        // Respawn Commander at left-center
        try {
            if (window.Commander) {
                const r = 24;
                const b = environment.boundary;
                const x = -b + r + 140;
                const y = 0;
                let cx = x, cy = y;
                if (!environment.isInsideBounds(cx, cy, r) || environment.circleHitsAny(cx, cy, r)) {
                    for (let step = 1; step <= 20; step++) {
                        const nx = x + step * 20;
                        if (environment.isInsideBounds(nx, y, r) && !environment.circleHitsAny(nx, y, r)) { cx = nx; cy = y; break; }
                    }
                }
                npcs.add(new window.Commander(cx, cy));
            }
        } catch(_) {}
        // Target dummy removed. Lobby training dummy is spawned by server as a normal enemy (type: targetDummy).
        // Respawn ambient NPCs (~10) with edge bias and clusters
        try {
            if (window.NPC_Lobby) {
                const count = 4;
                const tries = 1000;
                const r = 22;
                const placed = [];
                const isClear = (x, y) => {
                    if (!environment.isInsideBounds(x, y, r)) return false;
                    if (environment.circleHitsAny(x, y, r)) return false;
                    for (let i = 0; i < placed.length; i++) {
                        const p = placed[i];
                        const dx = x - p.x, dy = y - p.y;
                        if (dx*dx + dy*dy <= (r + p.r + 12) * (r + p.r + 12)) return false;
                    }
                    for (let i = 0; i < npcs.items.length; i++) {
                        const n = npcs.items[i]; if (!n) continue;
                        const dx = x - n.x, dy = y - n.y;
                        const rr = (r + (n.radius||24) + 12);
                        if (dx*dx + dy*dy <= rr * rr) return false;
                    }
                    return true;
                };
                const b = environment.boundary - 60;
                const inner = b - 220;
                const clusterCenters = [];
                const numClusters = 2 + Math.floor(Math.random() * 2);
                for (let c = 0; c < numClusters; c++) {
                    const edgeSide = Math.floor(Math.random() * 4);
                    let cx = 0, cy = 0;
                    if (edgeSide === 0) { cx = (Math.random()*2-1) * inner; cy = -inner; }
                    else if (edgeSide === 1) { cx = inner; cy = (Math.random()*2-1) * inner; }
                    else if (edgeSide === 2) { cx = (Math.random()*2-1) * inner; cy = inner; }
                    else { cx = -inner; cy = (Math.random()*2-1) * inner; }
                    for (let step = 0; step < 10 && (environment.circleHitsAny(cx, cy, r) || !environment.isInsideBounds(cx, cy, r)); step++) { cx *= 0.95; cy *= 0.95; }
                    clusterCenters.push({ x: cx, y: cy });
                }
                for (let k = 0; k < count; k++) {
                    let x = 0, y = 0, ok = false;
                    const useCluster = Math.random() < 0.5 && clusterCenters.length > 0;
                    if (useCluster) {
                        const cc = clusterCenters[Math.floor(Math.random() * clusterCenters.length)];
                        for (let t = 0; t < tries; t++) {
                            const ang = Math.random() * Math.PI * 2;
                            const dist = 40 + Math.random() * 160;
                            x = cc.x + Math.cos(ang) * dist;
                            y = cc.y + Math.sin(ang) * dist;
                            if (isClear(x, y)) { ok = true; break; }
                        }
                    }
                    if (!ok) {
                        const edgeSide = Math.floor(Math.random() * 4);
                        for (let t = 0; t < tries; t++) {
                            if (edgeSide === 0) { x = (Math.random()*2-1) * inner; y = -inner - Math.random()*80; }
                            else if (edgeSide === 1) { x = inner + Math.random()*80; y = (Math.random()*2-1) * inner; }
                            else if (edgeSide === 2) { x = (Math.random()*2-1) * inner; y = inner + Math.random()*80; }
                            else { x = -inner - Math.random()*80; y = (Math.random()*2-1) * inner; }
                            x = Math.max(-b+20, Math.min(b-20, x));
                            y = Math.max(-b+20, Math.min(b-20, y));
                            if (isClear(x, y)) { ok = true; break; }
                        }
                    }
                    if (ok) {
                        const n = new window.NPC_Lobby(x, y);
                        n._bark.interval *= (0.8 + Math.random()*0.7);
                        n._bark.gap *= (0.8 + Math.random()*0.7);
                        n._bark.timer = Math.random() * (n._bark.interval + n._bark.gap);
                        npcs.add(n);
                        placed.push({ x, y, r });
                    }
                }
            }
        } catch(_) {}
    } catch(e) { console.error('[Scene] Failed to return to lobby:', e); }
};
// Expose npcs for debugging or other modules
window.npcs = npcs;
// Track which NPC is currently showing the talk hint, for bark suppression
state.talkHintNpcId = null;
// NOTE: window.onNpcDialogueAction is set up by ClientBootstrap during initialization
// Ground decal manager drawn by Environment before obstacles
const groundDecals = [];
window.drawGroundDecals = (ctx, camera, viewport) => {
        // Viewport culling for ground decals (performance optimization)
        const cullBuffer = 1500; // Match environment cullBuffer for off-screen loading
        const viewLeft = camera.x - viewport.width/2 - cullBuffer;
        const viewTop = camera.y - viewport.height/2 - cullBuffer;
        const viewRight = camera.x + viewport.width/2 + cullBuffer;
        const viewBottom = camera.y + viewport.height/2 + cullBuffer;
        
        for (let i = 0; i < groundDecals.length; i++) {
                const d = groundDecals[i];
                
                // Skip if outside viewport (use decal radius for bounds)
                const radius = d.currentRadius ? d.currentRadius() : (d.maxRadius || 200);
                if (d.x + radius < viewLeft || d.x - radius > viewRight ||
                    d.y + radius < viewTop || d.y - radius > viewBottom) {
                        continue;
                }
                
                d.draw(ctx, camera);
        }
        // Cleanup expired
        for (let i = groundDecals.length - 1; i >= 0; i--) if (groundDecals[i].life <= 0) groundDecals.splice(i, 1);
};
// Bridge for enemies to place death pools underneath everything
window.enqueueGroundDecal = (vfx) => { try { groundDecals.push(vfx); } catch(e) {} };
// Clear all ground decals (used when returning to lobby)
window.clearGroundDecals = () => { groundDecals.length = 0; };
if (DEBUG) console.log('[Main] Modules constructed');


// Global damage event queue for screen shake (works with async multiplayer damage)
window._damageEvents = [];
window.enqueueDamageEvent = function enqueueDamageEvent(damageAmount, opts = {}) {
    try {
        const amount = Number(damageAmount);
        if (!Number.isFinite(amount) || amount <= 0) return;
        if (!Array.isArray(window._damageEvents)) window._damageEvents = [];
        const evt = { amount, shakeScale: 1, source: null };
        if (opts && typeof opts === 'object') {
            if (Number.isFinite(opts.shakeScale) && opts.shakeScale > 0) evt.shakeScale = opts.shakeScale;
            if (typeof opts.source === 'string') evt.source = opts.source;
        }
        window._damageEvents.push(evt);
    } catch(_) {}
};

// Simple screen shake trigger: uses GameState method
function triggerScreenShake(magnitude = 6, duration = 0.15) {
	if (state && typeof state.triggerScreenShake === 'function') {
		state.triggerScreenShake(magnitude, duration);
	}
}
// Expose for other modules
window.triggerScreenShake = triggerScreenShake;
// Expose state for networking damage effects (vignette, shake progress)
window.state = state;

function resizeCanvas() {
        state.viewportWidth = window.innerWidth;
        state.viewportHeight = window.innerHeight;
        canvas.width = state.viewportWidth;
        canvas.height = state.viewportHeight;
if (DEBUG) console.log('[Main] Resized canvas', { w: canvas.width, h: canvas.height });
}

window.addEventListener('resize', resizeCanvas);
// NOTE: resizeCanvas() will be called after bootstrap initializes the canvas

// Expose camera/viewport getter for modules (e.g., NPC off-screen sprint checks)
window.getCamera = function() {
        try {
                return { x: state.cameraX, y: state.cameraY, width: state.viewportWidth, height: state.viewportHeight };
        } catch(_) { return null; }
};

// Debug helper: Set server-side player values (for testing)
window.setBloodMarkers = function(value) {
        if (!window.networkManager || !window.networkManager.socket) {
                console.error('[Debug] Not connected to server');
                return;
        }
        console.log('[Debug] Sending debugSetValue request:', { key: 'bloodMarkers', value: value });
        window.networkManager.socket.emit('debugSetValue', { key: 'bloodMarkers', value: value });
        console.log(`[Debug] Current bloodMarkers before update: ${window.player?.bloodMarkers}`);
        
        // Add a listener to confirm the update came back from server
        setTimeout(() => {
                console.log(`[Debug] bloodMarkers after 100ms: ${window.player?.bloodMarkers}`);
        }, 100);
        
        return value;
};

window.setDucats = function(value) {
        if (!window.networkManager || !window.networkManager.socket) {
                console.error('[Debug] Not connected to server');
                return;
        }
        console.log('[Debug] Sending debugSetValue request:', { key: 'ducats', value: value });
        window.networkManager.socket.emit('debugSetValue', { key: 'ducats', value: value });
        console.log(`[Debug] Current ducats before update: ${window.player?.ducats}`);
        
        setTimeout(() => {
                console.log(`[Debug] ducats after 100ms: ${window.player?.ducats}`);
        }, 100);
        
        return value;
};

// Quick status check for currency
window.checkCurrency = function() {
        console.log('=== Currency Status ===');
        console.log('Blood Markers:', window.player?.bloodMarkers);
        console.log('Ducats:', window.player?.ducats);
        console.log('Connected:', window.networkManager?.connected);
        console.log('Player ID:', window.networkManager?.playerId);
        console.log('====================');
};

// Spawn player at a random safe location within bounds, avoiding obstacles
// Duplicate spawn functions removed - using SceneManager versions

// Populate lobby with ambient NPCs (~10) spaced safely, with edge bias and some clusters
;(function spawnLobbyAmbientNpcs(){
    try {
        if (scene.current !== 'lobby') return;
        if (!window.NPC_Lobby) return;
        
        // Skip client-side spawning in multiplayer mode - use server-spawned NPCs instead
        if (window.networkManager && window.networkManager.connected) {
            console.log('[Lobby NPCs] Skipping client-side spawning - using server-spawned NPCs');
            return;
        }
        
        // Use seeded RNG for synchronized NPC placement across all players
        console.log('[Lobby NPCs] Spawning ambient NPCs with seeded RNG');
        
        const count = 4;
        const tries = 1000;
        const r = 22;
        const placed = [];
        const isClear = (x, y) => {
            if (!environment.isInsideBounds(x, y, r)) return false;
            if (environment.circleHitsAny(x, y, r)) return false;
            for (let i = 0; i < placed.length; i++) {
                const p = placed[i];
                const dx = x - p.x, dy = y - p.y;
                if (dx*dx + dy*dy <= (r + p.r + 12) * (r + p.r + 12)) return false;
            }
            for (let i = 0; i < npcs.items.length; i++) {
                const n = npcs.items[i]; if (!n) continue;
                const dx = x - n.x, dy = y - n.y;
                const rr = (r + (n.radius||24) + 12);
                if (dx*dx + dy*dy <= rr * rr) return false;
            }
            return true;
        };
        const b = environment.boundary - 60;
        const inner = b - 220; // bias ring near edges
        const clusterCenters = [];
        // Seed 2-3 cluster centers on edge-biased ring
        const numClusters = 2 + WorldRNG.randomInt(0, 1);
        for (let c = 0; c < numClusters; c++) {
            const edgeSide = WorldRNG.randomInt(0, 3); // 0:top,1:right,2:bottom,3:left
            let cx = 0, cy = 0;
            if (edgeSide === 0) { cx = WorldRNG.randomFloat(-1, 1) * inner; cy = -inner; }
            else if (edgeSide === 1) { cx = inner; cy = WorldRNG.randomFloat(-1, 1) * inner; }
            else if (edgeSide === 2) { cx = WorldRNG.randomFloat(-1, 1) * inner; cy = inner; }
            else { cx = -inner; cy = WorldRNG.randomFloat(-1, 1) * inner; }
            // Nudge inward if obstructed
            for (let step = 0; step < 10 && (environment.circleHitsAny(cx, cy, r) || !environment.isInsideBounds(cx, cy, r)); step++) {
                cx *= 0.95; cy *= 0.95;
            }
            clusterCenters.push({ x: cx, y: cy });
        }
        for (let k = 0; k < count; k++) {
            let x = 0, y = 0, ok = false;
            const useCluster = WorldRNG.random() < 0.5 && clusterCenters.length > 0;
            if (useCluster) {
                // Pick a cluster, sample within a small radius
                const cc = clusterCenters[Math.floor(WorldRNG.random() * clusterCenters.length)];
                for (let t = 0; t < tries; t++) {
                    const ang = WorldRNG.randomFloat(0, Math.PI * 2);
                    const dist = 40 + WorldRNG.randomFloat(0, 160); // compact cluster
                    x = cc.x + Math.cos(ang) * dist;
                    y = cc.y + Math.sin(ang) * dist;
                    if (isClear(x, y)) { ok = true; break; }
                }
            }
            if (!ok) {
                // Edge-biased random placement: choose a side then sample inward
                const edgeSide = WorldRNG.randomInt(0, 3);
                for (let t = 0; t < tries; t++) {
                    if (edgeSide === 0) { x = WorldRNG.randomFloat(-1, 1) * inner; y = -inner - WorldRNG.randomFloat(0, 80); }
                    else if (edgeSide === 1) { x = inner + WorldRNG.randomFloat(0, 80); y = WorldRNG.randomFloat(-1, 1) * inner; }
                    else if (edgeSide === 2) { x = WorldRNG.randomFloat(-1, 1) * inner; y = inner + WorldRNG.randomFloat(0, 80); }
                    else { x = -inner - WorldRNG.randomFloat(0, 80); y = WorldRNG.randomFloat(-1, 1) * inner; }
                    // Clamp to bounds margin
                    x = Math.max(-b+20, Math.min(b-20, x));
                    y = Math.max(-b+20, Math.min(b-20, y));
                    if (isClear(x, y)) { ok = true; break; }
                }
            }
            if (ok) {
                const n = new window.NPC_Lobby(x, y);
                // Per-NPC bark timing variance using seeded RNG too
                n._bark.interval *= (0.8 + WorldRNG.randomFloat(0, 0.7));
                n._bark.gap *= (0.8 + WorldRNG.randomFloat(0, 0.7));
                n._bark.timer = WorldRNG.random() * (n._bark.interval + n._bark.gap);
                npcs.add(n);
                placed.push({ x, y, r });
            }
        }
        
        console.log('[Lobby NPCs] Spawned', placed.length, 'ambient NPCs using seed:', WorldRNG.getCurrentSeed());
    } catch(_) {}
})();

// (Removed) Client enemy spawning â€“ server authoritative only

// Spawn a neutral NPC_A away from future boss and extraction locations
;(function placeNPCs(){
    try {
        // Skip normal spawn if debug near-chest spawn is enabled (default true)
        const debugNearChest = (typeof window.DEBUG_NPC_NEAR_CHEST === 'boolean') ? window.DEBUG_NPC_NEAR_CHEST : true;
        if (debugNearChest) return;
        const minFarFromPlayer = 900; // don't spawn on top of player
        const minFarFromBoss = 2600;
        const minFarFromZone = 2600;
        const tries = 600;
        const probeR = 22;
        let nx = player.x, ny = player.y;
        for (let i = 0; i < tries; i++) {
            const b = environment.boundary - probeR - 10;
            const ang = WorldRNG.randomFloat(0, Math.PI * 2);
            const dist = minFarFromPlayer + WorldRNG.randomFloat(0, 2200);
            const tx = player.x + Math.cos(ang) * dist;
            const ty = player.y + Math.sin(ang) * dist;
            if (!environment.isInsideBounds(tx, ty, probeR)) continue;
            if (environment.circleHitsAny(tx, ty, probeR)) continue;
            // Far from extraction zone center placeholder (if exists later we will also recheck)
            let okZone = true;
            if (typeof window._plannedExtractionHint === 'object' && window._plannedExtractionHint) {
                const dxz = tx - window._plannedExtractionHint.x;
                const dyz = ty - window._plannedExtractionHint.y;
                okZone = (dxz*dxz + dyz*dyz) >= (minFarFromZone * minFarFromZone);
            }
            if (!okZone) continue;
            nx = tx; ny = ty; break;
        }
        const n = new NPC_A(nx, ny);
        npcs.add(n);
        // Reposition later if too close to actual zone/boss once they exist
        window._relocateNPCsIfNeeded = function() {
            try {
                for (let i = 0; i < npcs.items.length; i++) {
                    const npc = npcs.items[i];
                    if (!npc) continue;
                    let need = false;
                    if (window.ArtilleryWitch) {
                        for (let j = 0; j < enemies.items.length; j++) {
                            const e = enemies.items[j];
                            if (e && e.alive && (window.ArtilleryWitch && e instanceof window.ArtilleryWitch)) {
                                const dx = npc.x - e.x, dy = npc.y - e.y;
                                if (dx*dx + dy*dy < minFarFromBoss*minFarFromBoss) { need = true; break; }
                            }
                        }
                    }
                    if (!need && extractionZone) {
                        const dxz = npc.x - extractionZone.x, dyz = npc.y - extractionZone.y;
                        if (dxz*dxz + dyz*dyz < minFarFromZone*minFarFromZone) need = true;
                    }
                    if (need) {
                        // Find a new safe spot using same rules
                        for (let t = 0; t < tries; t++) {
                            const b = environment.boundary - probeR - 10;
                            const ang = Math.random() * Math.PI * 2;
                            const dist = minFarFromPlayer + Math.random() * 2200;
                            const tx = player.x + Math.cos(ang) * dist;
                            const ty = player.y + Math.sin(ang) * dist;
                            if (!environment.isInsideBounds(tx, ty, probeR)) continue;
                            if (environment.circleHitsAny(tx, ty, probeR)) continue;
                            let okB = true;
                            if (window.ArtilleryWitch) {
                                for (let j = 0; j < enemies.items.length; j++) {
                                    const e = enemies.items[j];
                                    if (e && e.alive && (window.ArtilleryWitch && e instanceof window.ArtilleryWitch)) {
                                        const dx = tx - e.x, dy = ty - e.y;
                                        if (dx*dx + dy*dy < minFarFromBoss*minFarFromBoss) { okB = false; break; }
                                    }
                                }
                            }
                            if (!okB) continue;
                            if (extractionZone) {
                                const dxz2 = tx - extractionZone.x, dyz2 = ty - extractionZone.y;
                                if (dxz2*dxz2 + dyz2*dyz2 < minFarFromZone*minFarFromZone) continue;
                            }
                            npc.x = tx; npc.y = ty; break;
                        }
                    }
                }
            } catch(_) {}
        };
    } catch(_) {}
})();

// Defer Extraction Zone creation until artifact is picked up at least once

// Spawn a chest near the player at a safe offset
// Note: chests array is managed by SceneManager and exposed as window.chests
// chests, extractionZone, hereticExtractionZone are declared at top of file
// Global boss drops container
window.bossDrops = window.bossDrops || [];
// Helper: ensure a dropped item is tracked by a world container for update/draw
function placeDroppedItemInWorld(item) {
    try {
        // If the item already exists in any chest's drops, no need to add
        for (let i = 0; i < chests.length; i++) {
            const c = chests[i];
            if (c && Array.isArray(c.drops) && c.drops.indexOf(item) !== -1) return;
        }
        // If it's already in the global drops list, skip
        if (Array.isArray(window.bossDrops) && window.bossDrops.indexOf(item) !== -1) return;
    } catch(_) {}
    try {
        // In multiplayer, route ground item creation through the server for replication
        if (window.networkManager?.connected) {
            // If this item already has a server id, just ensure it is tracked locally once
            if (item && item._serverId) {
                if (!Array.isArray(window.bossDrops)) window.bossDrops = [];
                if (window.bossDrops.indexOf(item) === -1) window.bossDrops.push(item);
                return;
            }
            // Send a server request to create this item on the ground for all players
            try {
                const label = item && (item.baseLabel || item.label) ? (item.baseLabel || item.label) : '+Stat';
                const rarityName = item && item.rarity && item.rarity.name ? item.rarity.name : 'Common';
                const color = item && item.rarity && item.rarity.color ? item.rarity.color : '#ffffff';
                const baseAngle = (item && Number.isFinite(item.vx) && Number.isFinite(item.vy)) ? Math.atan2(item.vy, item.vx) : 0;
                window.networkManager.socket.emit('inventoryDropRequest', {
                    items: [{ 
                        label, 
                        rarityName, 
                        color,
                        statKey: item.statKey,
                        bonusValue: item.bonusValue,
                        isPercent: item.isPercent,
                        rarity: item.rarity,
                        suppressHealForPlayerId: item.suppressHealForPlayerId
                    }],
                    x: Number(item && item.x) || 0,
                    y: Number(item && item.y) || 0,
                    baseAngle: baseAngle
                });
            } catch(_) {}
            // Do not add the local-only item; wait for server 'inventoryDropped' to add replicated items
            return;
        }
        // Single-player fallback: track locally
        if (!Array.isArray(window.bossDrops)) window.bossDrops = [];
        window.bossDrops.push(item);
    } catch(_) {}
}
// Expose getter for modules that need to inspect artifact state
window.getChests = () => chests;
// Helper: spawn boss far from player and extraction zone after artifact pickup
function spawnBossFarFromPlayerAndExtraction() {
        if (state.bossSpawned) return;
        if (!window.ArtilleryWitch) return;
        // Ensure extraction zone exists so we can respect its distance
        if (!extractionZone) return;
        try {
                // Probe radius from boss class
                const probe = new window.ArtilleryWitch(0, 0);
                const bossRadius = Math.max(78, Number.isFinite(probe.radius) ? probe.radius : 78);
                const minDistPlayer = 2600;
                const minDistZone = 2600;
                const minDistHeretic = 2600;
                const tries = 700;
                const b = environment.boundary - bossRadius - 10;
                let sx = null, sy = null;
                for (let i = 0; i < tries; i++) {
                        const nx = (Math.random() * 2 - 1) * b;
                        const ny = (Math.random() * 2 - 1) * b;
                        // Distance checks
                        const dpx = nx - player.x; const dpy = ny - player.y;
                        const dzx = nx - extractionZone.x; const dzy = ny - extractionZone.y;
                        if (dpx * dpx + dpy * dpy < minDistPlayer * minDistPlayer) continue;
                        if (dzx * dzx + dzy * dzy < minDistZone * minDistZone) continue;
                        if (hereticExtractionZone) {
                                const dhx = nx - hereticExtractionZone.x; const dhy = ny - hereticExtractionZone.y;
                                if (dhx * dhx + dhy * dhy < minDistHeretic * minDistHeretic) continue;
                        }
                        // Environment checks
                        if (!environment.isInsideBounds(nx, ny, bossRadius)) continue;
                        if (environment.circleHitsAny(nx, ny, bossRadius)) continue;
                        // Passed all checks
                        sx = nx; sy = ny; break;
                }
                // Fallback: place relative far away along a diagonal if random search failed
                if (sx == null || sy == null) {
                        sx = player.x + 3200;
                        sy = player.y + 3200;
                        if (!environment.isInsideBounds(sx, sy, bossRadius) || environment.circleHitsAny(sx, sy, bossRadius)) {
                                sx = Math.max(-b, Math.min(b, sx));
                                sy = Math.max(-b, Math.min(b, sy));
                        }
                }
                const boss = new window.ArtilleryWitch(sx, sy);
                enemies.items.push(boss);
                if (typeof enemies._insert === 'function') enemies._insert(boss);
                state.bossSpawned = true;
                if (DEBUG) console.log('[Main] Boss spawned after artifact pickup at', { x: sx, y: sy });
        } catch(e) {
                console.error('[Main] Failed to spawn boss:', e);
        }
}
;(function placeChest() {
    if (scene.current === 'lobby') return; // no level chest in lobby
        if (!window.GameObjects || !window.GameObjects.Chest) return;
        const { Chest } = window.GameObjects;
        const tries = 300;
        const minDist = 180;
        const maxDist = 420;
        const clearance = 28;
        for (let i = 0; i < tries; i++) {
                const ang = Math.random() * Math.PI * 2;
                const dist = minDist + Math.random() * (maxDist - minDist);
                const nx = player.x + Math.cos(ang) * dist;
                const ny = player.y + Math.sin(ang) * dist;
                if (environment.isInsideBounds(nx, ny, clearance) && !environment.circleHitsAny(nx, ny, clearance)) {
                        chests.push(new Chest(nx, ny, { variant: 'gold' }));
                        // Try place a brown chest nearby the golden chest
                        for (let j = 0; j < 200; j++) {
                                const ang2 = Math.random() * Math.PI * 2;
                                const d2 = 120 + Math.random() * 180;
                                const nx2 = nx + Math.cos(ang2) * d2;
                                const ny2 = ny + Math.sin(ang2) * d2;
                                if (environment.isInsideBounds(nx2, ny2, clearance) && !environment.circleHitsAny(nx2, ny2, clearance)) {
                                        chests.push(new Chest(nx2, ny2, { variant: 'brown' }));
                                        break;
                                }
                        }
                        // Debug: spawn NPCs within 500 units of the gold chest (after nearby chest placement)
                        (function debugSpawnNpcNearChest(cx, cy){
                                const enable = (typeof window.DEBUG_NPC_NEAR_CHEST === 'boolean') ? window.DEBUG_NPC_NEAR_CHEST : true;
                                if (!enable) return;
                                const maxDist = 500;
                                const npcR = 24;
                                const triesNpc = 700;
                                let placedA = false;
                                let placedB = false;
                                for (let t = 0; t < triesNpc && (!placedA || !placedB); t++) {
                                        const ang = Math.random() * Math.PI * 2;
                                        const dist = Math.random() * maxDist;
                                        const tx = cx + Math.cos(ang) * dist;
                                        const ty = cy + Math.sin(ang) * dist;
                                        if (!environment.isInsideBounds(tx, ty, npcR)) continue;
                                        if (environment.circleHitsAny(tx, ty, npcR)) continue;
                                        // Avoid overlapping any chest (gold or brown)
                                        let okChest = true;
                                        for (let k = 0; k < chests.length; k++) {
                                                const c = chests[k];
                                                if (!c) continue;
                                                const cr = c.radius || 20;
                                                const dx = tx - c.x, dy = ty - c.y;
                                                if (dx*dx + dy*dy <= (cr + npcR + 6) * (cr + npcR + 6)) { okChest = false; break; }
                                        }
                                        if (!okChest) continue;
                                        // Avoid overlapping any existing NPC
                                        let okNpc = true;
                                        for (let u = 0; u < npcs.items.length; u++) {
                                                const n = npcs.items[u];
                                                if (!n) continue;
                                                const dxn = tx - n.x, dyn = ty - n.y;
                                                if (dxn*dxn + dyn*dyn <= (npcR + (n.radius||24) + 6) * (npcR + (n.radius||24) + 6)) { okNpc = false; break; }
                                        }
                                        if (!okNpc) continue;
                                        try {
                                                if (!placedA) { npcs.add(new NPC_A(tx, ty)); placedA = true; continue; }
                                                if (!placedB && window.NPC_B) { npcs.add(new window.NPC_B(tx, ty)); placedB = true; continue; }
                                        } catch(_) {}
                                }
                        })(nx, ny);
                        break;
                }
        }
})();

// Initialize camera to center on player
state.cameraX = 0;
state.cameraY = 0;

// NFC unlock double-tap detection
// Tracks last "." press time for double-tap detection
let _lastPeriodPress = 0;
const DOUBLE_TAP_THRESHOLD = 300; // ms

function handleNfcDoubleTap() {
    const now = Date.now();
    if (now - _lastPeriodPress < DOUBLE_TAP_THRESHOLD) {
        // Double-tap detected! Send unlock request to server
        console.log('[NFC] Double-tap "." detected - sending unlock request');
        if (window.networkManager && window.networkManager.connected) {
            window.networkManager.socket.emit('requestNfcUnlock', { source: 'keyboard' });
        }
        _lastPeriodPress = 0; // Reset to prevent triple-tap
    } else {
        _lastPeriodPress = now;
    }
}

// Input handlers
window.addEventListener('keydown', (e) => {
        if (e.code in state.keys) state.keys[e.code] = true;
        
        // NFC unlock: double-tap "." key
        if (e.code === 'Period' || e.code === 'NumpadDecimal') {
            handleNfcDoubleTap();
        }
        
        // Weapon hotkeys: 1-9 switch weapons; F uses a Health Potion (disabled while dialogue open)
        const digitMap = { Digit1:0, Digit2:1, Digit3:2, Digit4:3, Digit5:4, Digit6:5, Digit7:6, Digit8:7, Digit9:8 };
        if (e.code === 'KeyF') {
                if (dialogue && dialogue.open) {
                        // Route to dialogue: keydown highlights (press state)
                        if (typeof dialogue.onDigitDown === 'function') dialogue.onDigitDown(9);
                        return;
                }
                useHealthPotion();
                return;
        }
	if (e.code in digitMap) {
		if (dialogue && dialogue.open) {
			// Route to dialogue: keydown highlights (press state)
			if (typeof dialogue.onDigitDown === 'function') dialogue.onDigitDown(digitMap[e.code]);
			return;
		}
		// Allow switching in lobby, when dead, or always in Trench Raid mode (for testing)
		// Use serverLevelType (synced from server) as source of truth
		const isTrenchRaid = (window.serverLevelType === 'trenchraid');
		const canSwitchWeapon = (scene.current === 'lobby') || (player.health <= 0) || isTrenchRaid;
		if (canSwitchWeapon) {
			const targetSlot = digitMap[e.code];
			// Block weapon 8 (slot 7) if locked via NFC
			if (targetSlot === 7 && !window.weapon8Unlocked) {
				// Show "Locked" feedback above player
				if (player) {
					player.dashFeedbackText = 'Locked';
					player.dashFeedbackTimer = 1.0;
				}
				return; // Don't switch weapon
			}
			projectiles.setIndex(targetSlot);
		}
	}
        // Manual reload (R) for weapon 7
        if (e.code === 'KeyR') {
                try { if (projectiles && typeof projectiles.requestReload === 'function') projectiles.requestReload(); } catch(_) {}
        }
	if (e.code === 'KeyE') {
		state.justPressedKeyE = true;
	}
	// Currency cheat ([ key) - gives 100 ducats, 100 blood markers, and 10 VP
	if (e.code === 'BracketLeft') {
		if (window.player) {
			window.player.ducats = (window.player.ducats || 0) + 100;
			window.player.bloodMarkers = (window.player.bloodMarkers || 0) + 100;
			window.player.victoryPoints = (window.player.victoryPoints || 0) + 10;
			console.log('[Cheat] Added currency - Ducats:', window.player.ducats, 'Blood Markers:', window.player.bloodMarkers, 'VP:', window.player.victoryPoints);
			
			// In multiplayer, sync to server
			try {
				if (window.networkManager?.connected) {
					window.networkManager.socket.emit('debugSetValue', { 
						key: 'ducats', 
						value: window.player.ducats 
					});
					window.networkManager.socket.emit('debugSetValue', { 
						key: 'bloodMarkers', 
						value: window.player.bloodMarkers 
					});
					window.networkManager.socket.emit('debugSetValue', { 
						key: 'victoryPoints', 
						value: window.player.victoryPoints 
					});
					console.log('[Cheat] Synced currency to server');
				}
			} catch(e) {
				console.error('[Cheat] Error syncing currency:', e);
			}
		}
	}
	// Force horde debug (H key) - Spawn difficulty 1 preset
	if (e.code === 'KeyH') {
		if (window.networkManager?.connected) {
			console.log('[Debug] Requesting difficulty 1 horde spawn from server');
			window.networkManager.socket.emit('debugSpawnHorde', {
				difficulty: 5  // Use difficulty preset 1 (tutorial/easy - basic zombies only)
			});
		} else {
			console.warn('[Debug] Cannot spawn horde - not connected to server');
		}
	}
	// Invincibility toggle cheat (] key)
	if (e.code === 'BracketRight') {
		state.invincible = !state.invincible;
		console.log('[Cheat] Invincibility toggled:', state.invincible ? 'ON' : 'OFF');
                
                // In multiplayer, broadcast invincibility state to all players in the room
                try {
                        if (window.networkManager?.connected) {
                                window.networkManager.socket.emit('invincibilityToggle', {
                                        roomId: window.networkManager.roomId,
                                        invincible: state.invincible,
                                        fromPlayer: window.networkManager.playerId
                                });
                                console.log('[Network] Broadcasted invincibility state:', state.invincible);
                        }
                } catch(e) {
                        console.error('[Cheat] Error syncing invincibility:', e);
                }
        }
});
window.addEventListener('keyup', (e) => {
        if (e.code in state.keys) state.keys[e.code] = false;
        const digitMap = { Digit1:0, Digit2:1, Digit3:2, Digit4:3, Digit5:4, Digit6:5, Digit7:6, Digit8:7, Digit9:8, Digit0:9 };
        if (e.code in digitMap) {
                if (dialogue && dialogue.open) {
                        // Complete selection on keyup
                        if (typeof dialogue.onDigitUp === 'function') dialogue.onDigitUp(digitMap[e.code]);
                        return;
                }
        }
});

// Setup canvas event listeners (called after canvas is initialized)
function setupCanvasEventListeners(dialogue) {
canvas.addEventListener('mousemove', (e) => {
        const rect = canvas.getBoundingClientRect();
        state.mouse.x = e.clientX - rect.left;
        state.mouse.y = e.clientY - rect.top;
        // Maintain world-space mouse for cross-module hover checks
        try { window._mouseWorldX = state.cameraX + state.mouse.x; window._mouseWorldY = state.cameraY + state.mouse.y; } catch(_) {}
        // Forward hover to dialogue
        if (dialogue && dialogue.open && typeof dialogue.onMouseMove === 'function') {
                dialogue.onMouseMove(state.mouse.x, state.mouse.y);
        }
});
canvas.addEventListener('mousedown', (e) => {
    if (e.button === 0) {
        // Handle NFC unlock popup OK button click
        if (state.nfcUnlockPopup && state.nfcUnlockButtonRect) {
            const rect = canvas.getBoundingClientRect();
            const mx = e.clientX - rect.left;
            const my = e.clientY - rect.top;
            const b = state.nfcUnlockButtonRect;
            if (mx >= b.x && mx <= b.x + b.w && my >= b.y && my <= b.y + b.h) {
                e.preventDefault();
                // Dismiss the popup
                state.nfcUnlockPopup = null;
                state.nfcUnlockButtonRect = null;
                console.log('[NFC] Unlock popup dismissed');
                return;
            }
        }
        
        // Handle restart click when extraction overlay is visible
        if (state.extractionEnd && state.extractionButtonRect) {
            const rect = canvas.getBoundingClientRect();
            const mx = e.clientX - rect.left;
            const my = e.clientY - rect.top;
            const b = state.extractionButtonRect;
            if (mx >= b.x && mx <= b.x + b.w && my >= b.y && my <= b.y + b.h) {
                e.preventDefault();
                try {
                    if (state.extractionEnd.type === 'win') {
                        // Return to lobby on success
                        if (typeof window.returnToLobby === 'function') window.returnToLobby();
                    } else {
                        // On lose, also return to lobby for consistency
                        if (typeof window.returnToLobby === 'function') window.returnToLobby();
                    }
                } catch(_) {}
                return;
            }
        }
        // Handle DialogueBox close button
        {
            const rect = canvas.getBoundingClientRect();
            const mx = e.clientX - rect.left;
            const my = e.clientY - rect.top;
            // First: handle choice clicks if any
            if (dialogue && dialogue.open && typeof dialogue.onMouseDown === 'function') {
                const handled = dialogue.onMouseDown(mx, my);
                if (handled) {
                    e.preventDefault();
                    return;
                }
            }
            if (dialogue && dialogue.open && typeof dialogue.tryCloseAtMouse === 'function') {
                const closed = dialogue.tryCloseAtMouse(canvas, mx, my);
                if (closed) {
                    e.preventDefault();
                    return;
                }
            }
        }
        state.mouseDown = true;
        state.justPressed = true;
        // If weapon 7 is reloading, show a persistent 'Reloading' label over player while mouse is held
        try {
            if (projectiles && projectiles.currentIndex === 6 && (projectiles.ammo7ReloadTimer || 0) > 0 && window.player) {
                const pr = window.player.radius || 26;
                window._weapon7ReloadingLabel = {
                    draw: function(ctx, cam) {
                        const sx = window.player.x - cam.x;
                        const sy = window.player.y - cam.y - (pr + 18);
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
                    }
                };
            }
        } catch(_) {}
    }
});
canvas.addEventListener('mouseup', (e) => {
        if (e.button === 0) {
                // Forward mouse up to dialogue to finalize choice selection
                {
                        const rect = canvas.getBoundingClientRect();
                        const mx = e.clientX - rect.left;
                        const my = e.clientY - rect.top;
                        if (dialogue && dialogue.open && typeof dialogue.onMouseUp === 'function') {
                                const handled = dialogue.onMouseUp(mx, my);
                                if (handled) {
                                        e.preventDefault();
                                        state.mouseDown = false;
                                        state.justReleased = true;
                                        // Hide persistent reloading label when mouse released
                                        try { window._weapon7ReloadingLabel = null; } catch(_) {}
                                        return;
                                }
                        }
                }
                state.mouseDown = false;
                state.justReleased = true;
        }
});
canvas.addEventListener('mouseleave', () => { state.mouseDown = false; });
}


// ============================================================================
// GAME LOOP - Delegated to ClientGameLoop module
// ============================================================================

// Use a Health Potion (server-authoritative when connected)
function useHealthPotion() {
    try {
        const p = window.player;
        if (!p || p.health <= 0) { window.abilityManager?.showFeedback?.('Cannot use while dead', '#ff4444'); return; }
        if (p.health >= p.healthMax) { window.abilityManager?.showFeedback?.('Already at full HP', '#ffcc00'); return; }
        if ((p.ducats || 0) < 30) { window.abilityManager?.showFeedback?.('Need 30 ducats', '#ff4444'); return; }
        if (window.networkManager?.connected) {
            window.networkManager.socket.emit('useHealthPotion', { heal: 25, cost: 30 });
        } else {
            // Offline fallback
            const maxHeal = Math.max(0, (p.healthMax || 0) - (p.health || 0));
            const heal = Math.min(25, maxHeal);
            p.health = Math.min(p.healthMax || 0, (p.health || 0) + heal);
            p.ducats = Math.max(0, (p.ducats || 0) - 30);
            if (window.enqueueDamageText && heal > 0) {
                window.enqueueDamageText({ x: p.x, y: p.y - (p.radius || 26), text: '+' + heal, color: '#00ff00', crit: false, life: 1.0, vy: -60 });
            }
        }
    } catch(e) { console.error('[Potion] Error:', e); }
}

function update(dt) {
	if (typeof window.gameLoop?.update === 'function') {
		window.gameLoop.update(dt);
	}
}

function render() {
	if (typeof window.gameLoop?.render === 'function') {
		window.gameLoop.render();
	}
}

function frame(ts) {
	if (typeof window.gameLoop?.frame === 'function') {
		window.gameLoop.frame(ts);
	}
}


// ============================================================================
// INITIALIZATION - Entry point
// ============================================================================

console.log('[Main] main.js loaded, waiting for DOMContentLoaded...');

// Start the initialization process when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    console.log('[Main] ✅ DOMContentLoaded fired! Starting initialization...');
    
    // Phase 1: Initialize GameContext (before bootstrap completes)
    if (typeof initializeGameContext === 'function') {
        const success = initializeGameContext();
        if (!success || !window.ctx) {
            console.error('[Main] ❌ CRITICAL: GameContext initialization failed!');
            console.error('[Main] Attempting to create basic fallback context...');
            window.ctx = {
                frame: { now: 0, dt: 0, frameId: 0, lastTimestamp: 0 }
            };
        }
    } else {
        console.error('[Main] ❌ CRITICAL: initializeGameContext function not found!');
        console.error('[Main] Creating basic fallback context...');
        window.ctx = {
            frame: { now: 0, dt: 0, frameId: 0, lastTimestamp: 0 }
        };
    }
    
    console.log('[Main] window.ctx status:', window.ctx ? '✅ Available' : '❌ Missing');
    
    // Initialize using ClientBootstrap with completion callback
    bootstrap.initialize(state, (bootInstance) => {
        // CRITICAL: Sync all references from bootstrap SYNCHRONOUSLY
        canvas = bootInstance.canvas;
        ctx = bootInstance.ctx;
        player = bootInstance.player;
        environment = bootInstance.environment;
        worldInitialized = bootInstance.worldInitialized;
        projectiles = bootInstance.projectiles;
        enemies = bootInstance.enemies;
        director = bootInstance.director;
        ui = bootInstance.ui;
        window.ui = ui; // Expose globally for notification system
        modeTimer = bootInstance.modeTimer;
        npcs = bootInstance.npcs;
        scene = bootInstance.scene;
        chests = bootInstance.chests;
        otherPlayers = bootInstance.otherPlayers;
        dialogue = bootInstance.dialogue; // CRITICAL: DialogueBox needed by update/render
        
        // Phase 1: Populate GameContext with all initialized objects
        const gameCtx = window.ctx;
        gameCtx.state = state;
        gameCtx.bootstrap = bootstrap;
        gameCtx.canvas = canvas;
        gameCtx.canvasCtx = ctx;  // Note: ctx = 2D rendering context, gameCtx = game context
        gameCtx.player = player;
        gameCtx.environment = environment;
        gameCtx.enemies = enemies;
        gameCtx.director = director;
        gameCtx.ui = ui;
        gameCtx.npcs = npcs;
        gameCtx.scene = scene;
        gameCtx.chests = chests;
        gameCtx.projectiles = projectiles;
        gameCtx.otherPlayers = otherPlayers;
        gameCtx.dialogue = dialogue;
        gameCtx.net = window.networkManager || null;
        gameCtx.input = window.inputManager || null;
        gameCtx.camera = window.camera || null;
        gameCtx.abilityManager = window.abilityManager || null;
        gameCtx.barrelManager = window.barrelManager || null;
        gameCtx.merchantShop = null; // Will be set below
        gameCtx.currentGameMode = window.currentGameMode || null;
        gameCtx.serverLevelType = window.serverLevelType || 'extraction';
        gameCtx.ducatPickups = ducatPickups;
        gameCtx.bloodMarkerPickups = bloodMarkerPickups;
        gameCtx.extractionZone = extractionZone;
        gameCtx.hereticExtractionZone = hereticExtractionZone;
        gameCtx.gameDebugger = window.gameDebugger || null;
        
        console.log('[GameContext] Populated with initialized objects');
        
        // Initialize merchant shop
        if (typeof MerchantShop !== 'undefined') {
                window.merchantShop = new MerchantShop();
                window.ctx.merchantShop = window.merchantShop; // Sync to context
                console.log('[Main] Merchant shop initialized');
        } else {
                console.warn('[Main] MerchantShop class not found');
        }
        
        // CRITICAL: Setup callback for when world/environment is initialized
        bootInstance.onEnvironmentReady = (env, initialized) => {
            console.log('[Main] Environment ready callback - syncing references');
            environment = env;
            worldInitialized = initialized;
            director = bootInstance.director; // CRITICAL: Sync director which is initialized with environment
        };
        
        console.log('[Main] References synced, starting game loop');
        
        // CRITICAL: Resize canvas after it's initialized
        resizeCanvas();
        
        // CRITICAL: Setup canvas event listeners after canvas is initialized
        setupCanvasEventListeners(bootInstance.dialogue);
        
        // Start the game loop immediately after bootstrap completes (matches original timing)
        requestAnimationFrame(frame);
    });
});
