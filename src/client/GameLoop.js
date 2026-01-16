// Game Loop Module - Thin orchestrator (Phase 5)
// Delegates to ClientUpdate and ClientRender modules
// Multiplayer-only game - no single-player fallbacks
// Phase 1: Now populates ctx.frame and passes context to subsystems

function update(dt, ctx) {
	if (typeof window.clientUpdate?.update === 'function') {
		// Phase 1: Pass context if available, fall back to old signature for compatibility
		if (ctx) {
			window.clientUpdate.update(dt, ctx);
		} else {
			window.clientUpdate.update(dt);
		}
	}
}

function render(ctx) {
	if (typeof window.clientRender?.render === 'function') {
		// Phase 1: Pass context if available, fall back to old signature for compatibility
		if (ctx) {
			window.clientRender.render(ctx);
		} else {
			window.clientRender.render();
		}
	}
}

function frame(ts) {
	// Phase 1: Get context and populate per-frame values
	const ctx = window.ctx;
	
	// Phase 1: Get state from context or fall back to window.state
	const state = ctx?.state || window.state;
	if (!state) {
		console.error('[GameLoop] No state available');
		requestAnimationFrame(frame);
		return;
	}
	
	const dt = Math.min(0.033, (ts - state.lastTimestamp) / 1000 || 0);
	state.lastTimestamp = ts;
	state._lastDt = dt;
	
	// Phase 1: Populate ctx.frame with current frame values
	if (ctx) {
		ctx.frame.now = ts;
		ctx.frame.dt = dt;
		ctx.frame.frameId++;
		ctx.frame.lastTimestamp = state.lastTimestamp;
	}

	// Update FPS tracking
	if (window.gameDebugger) {
		window.gameDebugger.updateFps();
	}

	update(dt, ctx);
	
	// Send player input to server (Phase 1: pass context)
	if (typeof sendPlayerInput === 'function') {
		sendPlayerInput(ctx);
	}
	
	render(ctx);

	requestAnimationFrame(frame);
}

// Export for use by main.js
window.gameLoop = { update, render, frame };

console.log('[GameLoop.js] ✅ Module loaded and gameLoop exported');
