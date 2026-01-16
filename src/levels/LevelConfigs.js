// Level configuration system
// Defines colors and settings for each level/mission type

class LevelConfigs {
	static configs = {
		extraction: {
			name: 'Extraction',
			bg: '#0e0e12',          // Current dark grey (keep as-is)
			lineThin: '#151826',
			lineThick: '#202431',
			wallColor: '#1b1f2e',
			boundary: 11000
		},
		test: {
			name: 'Test Level',
			bg: '#0d0f1c',          // Dark grey with more apparent blue
			lineThin: '#14182f',
			lineThick: '#1e2540',
			wallColor: '#1a1f3a',
			boundary: 11000
		},
	payload: {
		name: 'Payload Escort',
		bg: '#16110c',          // Dark color with more apparent brown
		lineThin: '#1f1910',
		lineThick: '#2a2318',
		wallColor: '#261e17',
		boundary: 11000
	},
	trenchraid: {
		name: 'Trench Raid',
		bg: '#1a1108',          // Dark brown (trench warfare mud/earth)
		lineThin: '#28210f',
		lineThick: '#342914',
		wallColor: '#3a2f1a',
		boundary: 23000,        // Match doubled width
		// Rectangular map dimensions (expanded center battlefield)
		isRectangular: true,
		width: 24000,           // Horizontal extent: -12000 to +12000 (doubled)
		height: 3000,           // Vertical extent: -1500 to +1500
		// Exclusion zones where obstacles should NOT spawn (safe zones behind faction walls)
		obstacleExclusionZones: [
			// Extend 400 units into the battlefield so random grey boxes can't block/overlap turrets
			{ minX: -12000, maxX: -9800, minY: -1500, maxY: 1500 }, // New Antioch safe zone (left) + firing lane
			{ minX: 10200, maxX: 12000, minY: -1500, maxY: 1500 }    // Heretic safe zone (right)
		]
	}
};

	static get(levelType) {
		return this.configs[levelType] || this.configs.extraction;
	}

	static exists(levelType) {
		return !!this.configs[levelType];
	}
}

// Export for both browser and Node.js
if (typeof module !== 'undefined' && module.exports) {
	module.exports = LevelConfigs;
} else {
	window.LevelConfigs = LevelConfigs;
}

