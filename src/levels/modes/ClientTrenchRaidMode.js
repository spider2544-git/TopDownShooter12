// Client Trench Raid Mode
// Custom UI elements and timers for trench raid gameplay

class ClientTrenchRaidMode extends ClientBaseMode {
	constructor(levelType, config) {
		super(levelType, config);
		
		// Artillery Barrage Timer
		// Counts down from 9 minutes (540 seconds) - matches server's ARTILLERY_BARRAGE_DELAY_MS
		// After hitting zero, counts up in red (overtime mode)
		this.artilleryTimer = {
			initialDuration: 9 * 60, // 9 minutes in seconds (matches server)
			timeRemaining: 9 * 60,   // Current countdown value
			overtime: 0,             // Time elapsed after zero
			isOvertime: false        // Whether we've passed zero
		};
	}
	
	// Called when level starts on client
	onLevelStart() {
		super.onLevelStart();
		console.log('[ClientTrenchRaidMode] Artillery Barrage timer started - 9:00');
		
		// Reset timer
		this.artilleryTimer.timeRemaining = this.artilleryTimer.initialDuration;
		this.artilleryTimer.overtime = 0;
		this.artilleryTimer.isOvertime = false;
	}
	
	// Per-frame update
	update(deltaTime) {
		super.update(deltaTime);
		
		// Client timer is synced from server in syncFromServer()
		// Only update locally if not in multiplayer or as fallback
		if (!window.isMultiplayer) {
			// Update artillery barrage timer locally for singleplayer
			if (!this.artilleryTimer.isOvertime) {
				// Countdown phase
				this.artilleryTimer.timeRemaining -= deltaTime;
				
				if (this.artilleryTimer.timeRemaining <= 0) {
					// Transition to overtime
					this.artilleryTimer.timeRemaining = 0;
					this.artilleryTimer.isOvertime = true;
					this.artilleryTimer.overtime = Math.abs(this.artilleryTimer.timeRemaining);
					console.log('[ClientTrenchRaidMode] Artillery Barrage - OVERTIME!');
				}
			} else {
				// Overtime phase - count up
				this.artilleryTimer.overtime += deltaTime;
			}
		}
	}
	
	// Add time bonus (called when RadioTower powered in single-player)
	// Returns the actual bonus applied in seconds
	addArtilleryBonus(seconds, resetIfOvertime = true) {
		if (this.artilleryTimer.isOvertime && resetIfOvertime) {
			// Reset to 1 minute remaining
			this.artilleryTimer.isOvertime = false;
			this.artilleryTimer.timeRemaining = 60;
			this.artilleryTimer.overtime = 0;
			console.log('[ClientTrenchRaidMode] Artillery reset to 1:00 remaining (was overtime)');
			return 60;
		} else if (!this.artilleryTimer.isOvertime) {
			// Add bonus time
			this.artilleryTimer.timeRemaining += seconds;
			console.log(`[ClientTrenchRaidMode] Artillery bonus +${seconds}s, now ${this.artilleryTimer.timeRemaining}s remaining`);
			return seconds;
		}
		return 0;
	}
	
	// Sync timer from server state (called when receiving gameState in multiplayer)
	syncFromServer(artilleryBarrageElapsedMs, artilleryBarrageActive) {
		if (artilleryBarrageElapsedMs === undefined) return;
		
		const totalDurationMs = this.artilleryTimer.initialDuration * 1000; // 9 minutes in ms
		const elapsedMs = artilleryBarrageElapsedMs;
		
		if (elapsedMs >= totalDurationMs) {
			// Overtime - artillery is firing
			if (!this.artilleryTimer.isOvertime) {
				console.log('[ClientTrenchRaidMode] Artillery Barrage - OVERTIME! (synced from server)');
			}
			this.artilleryTimer.isOvertime = true;
			this.artilleryTimer.timeRemaining = 0;
			this.artilleryTimer.overtime = (elapsedMs - totalDurationMs) / 1000; // Convert to seconds
		} else {
			// Countdown phase - can exceed initial duration if bonus time was added early
			// (elapsedMs can be negative when bonus time > actual elapsed time)
			this.artilleryTimer.isOvertime = false;
			this.artilleryTimer.timeRemaining = (totalDurationMs - elapsedMs) / 1000; // Convert to seconds
			this.artilleryTimer.overtime = 0;
		}
	}
	
	// Get timer data for UI rendering
	getArtilleryTimerData() {
		return {
			name: 'Artillery Barrage',
			isOvertime: this.artilleryTimer.isOvertime,
			// In countdown: show remaining time
			// In overtime: show elapsed overtime
			time: this.artilleryTimer.isOvertime 
				? this.artilleryTimer.overtime 
				: this.artilleryTimer.timeRemaining
		};
	}
}

window.ClientTrenchRaidMode = ClientTrenchRaidMode;
