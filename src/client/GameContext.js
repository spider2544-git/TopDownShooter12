// GameContext - Central integration point for client state and services
// Phase 1 of context refactor: collapse scattered window.* globals into one place
// Still runs as a classic script (no ES modules yet), but provides explicit dependency structure

/**
 * Creates the game context object that holds references to all major game systems.
 * This becomes the primary integration point instead of scattered window.* globals.
 * 
 * @returns {object} GameContext with stable references + mutable state + per-frame values
 */
function createGameContext() {
	const ctx = {
		// ===== CONSTANTS (set once, never change) =====
		constants: null, // will be set to window.GameConstants
		
		// ===== CORE STATE (set once at boot, mutated during gameplay) =====
		state: null,      // GameState instance
		bootstrap: null,  // ClientBootstrap instance
		
		// ===== MANAGERS (set once, provide services) =====
		net: null,        // NetworkManager instance
		input: null,      // InputManager instance
		scene: null,      // SceneManager or scene object { current: 'lobby'|'level' }
		camera: null,     // Camera instance
		
		// ===== GAME ENTITIES (mutable collections) =====
		player: null,           // Local player instance
		environment: null,      // Environment or EnvironmentLobby
		enemies: null,          // Enemy collection
		npcs: null,             // NPC collection
		chests: null,           // Chest array
		projectiles: null,      // Projectile collection
		otherPlayers: null,     // Remote player array
		troops: null,           // Troop array (if present)
		
		// ===== RENDERING & UI =====
		canvas: null,
		canvasCtx: null,  // 2D rendering context
		ui: null,         // UI manager
		dialogue: null,   // DialogueBox instance
		
		// ===== GAMEPLAY SYSTEMS =====
		director: null,        // Enemy director/AI
		abilityManager: null,  // Ability system
		barrelManager: null,   // Exploding barrel system
		merchantShop: null,    // Shop UI
		
		// ===== GAME MODE =====
		currentGameMode: null, // Client-side mode instance (ClientTestMode, ClientExtractionMode, etc.)
		serverLevelType: null, // Server-authoritative level type string
		
		// ===== EXTRACTION ZONES (special refs for networking) =====
		extractionZone: null,
		hereticExtractionZone: null,
		
		// ===== CURRENCY PICKUPS (magnet attraction) =====
		ducatPickups: null,
		bloodMarkerPickups: null,
		
		// ===== DEBUG / TELEMETRY =====
		gameDebugger: null,
		
		// ===== PER-FRAME VALUES (updated by GameLoop each frame) =====
		frame: {
			now: 0,        // current timestamp (from requestAnimationFrame)
			dt: 0,         // delta time in seconds
			frameId: 0,    // monotonic frame counter
			lastTimestamp: 0  // previous frame timestamp
		}
	};
	
	return ctx;
}

/**
 * Initializes the global window.ctx and creates compatibility bridges for legacy code.
 * Call this early in main.js after core objects are created.
 */
function initializeGameContext() {
	try {
		// Create the context
		window.ctx = createGameContext();
		
		// Populate from existing globals (they're already created by the time main.js runs)
		const ctx = window.ctx;
		
		// Constants
		ctx.constants = window.GameConstants || null;
		
		// Core state (set by main.js)
		// These will be populated by main.js after bootstrap
		
		// Debug helper: dump context structure (useful during migration)
		if (typeof window !== 'undefined') {
			window.ctxDebug = function() {
				console.group('[GameContext] Current state');
				console.log('constants:', !!ctx.constants);
				console.log('state:', !!ctx.state);
				console.log('bootstrap:', !!ctx.bootstrap);
				console.log('net:', !!ctx.net);
				console.log('input:', !!ctx.input);
				console.log('player:', !!ctx.player);
				console.log('environment:', !!ctx.environment);
				console.log('enemies:', !!ctx.enemies);
				console.log('canvas:', !!ctx.canvas);
				console.log('frame:', ctx.frame);
				console.groupEnd();
			};
		}
		
		console.log('[GameContext] ✅ Successfully initialized window.ctx');
		return true;
	} catch (error) {
		console.error('[GameContext] ❌ Failed to initialize window.ctx:', error);
		return false;
	}
}

/**
 * Creates compatibility bridges for legacy code that still reads window.* directly.
 * These bridges will be REMOVED in Phase 4 after all systems are migrated to use ctx.
 * 
 * Keep this list SMALL and EXPLICIT - we want to delete these, not grow them.
 */
function createLegacyBridges() {
	const ctx = window.ctx;
	if (!ctx) {
		console.error('[GameContext] Cannot create bridges - window.ctx not initialized');
		return;
	}
	
	// Bridge the most critical globals used by legacy code
	// These are TEMPORARY and will be removed once systems are migrated
	
	// Note: We do NOT bridge everything - only what's absolutely necessary
	// for backward compatibility during the migration period.
	
	// Most systems should start reading from ctx directly.
	
	console.log('[GameContext] Created minimal legacy bridges (will be removed in Phase 4)');
}

// Export functions to global scope (classic script pattern)
window.createGameContext = createGameContext;
window.initializeGameContext = initializeGameContext;
window.createLegacyBridges = createLegacyBridges;

console.log('[GameContext.js] ✅ Module loaded and functions exported');
