// Client Base Mode Class
// Base class for client-side game mode logic
// Handles mode-specific rendering and client-side updates

class ClientBaseMode {
	constructor(levelType, config) {
		this.levelType = levelType;
		this.config = config;
	}

	// Called when level starts on client
	onLevelStart() {
		console.log(`[ClientGameMode] ${this.levelType} mode started`);
	}

	// Called when level ends on client
	onLevelEnd() {
		console.log(`[ClientGameMode] ${this.levelType} mode ended`);
	}

	// Per-frame update - override in subclasses for mode-specific logic
	update(deltaTime) {
		// Default: no per-frame logic
	}

	// Mode-specific rendering - override in subclasses
	render(ctx, camera) {
		// Default: no custom rendering
	}
}

// Export for browser
window.ClientBaseMode = ClientBaseMode;


