// src/levels/HazardsConfig.js
// Hazard configuration system for environment obstacles
// Defines placement strategies, densities, and properties for each game mode

class HazardsConfig {
	static configs = {
		// Test mode - no hazards
		test: {
			enabled: false
		},
		
		// Extraction mode - minimal hazards
		extraction: {
			enabled: false
		},
		
		// Payload mode - no hazards yet
		payload: {
			enabled: false
		},
		
		// Trench Raid mode - full hazard system
		trenchraid: {
			enabled: true,
			
			// Clear zones - open areas where NO hazards spawn (for tactical breathing room)
			// These zones are checked by all hazard types in addition to their individual safeZones
			clearZones: [
				// Two open areas in the center region of the battlefield
				{ x: -4000, y: 0, radius: 800 },   // Open area left-center
				{ x: 4000, y: 0, radius: 800 },    // Open area right-center
				// A third clearing in the middle-bottom area
				{ x: 0, y: 600, radius: 600 },     // Small clearing bottom-center
				// Note: RadioTower spawns randomly in Zone C or D, so no fixed clear zone
				// Sandbags and hazards nearby are fine per user request
			],
			
			// Sandbag configuration
			sandbags: {
				enabled: true,
				
				// Placement strategy: 'scattered' | 'grid' | 'defensiveLines' | 'clusters'
				strategy: 'scattered',
				
				// Density settings for 'scattered' strategy
				scattered: {
					// Total number of sandbag groups to place across the battlefield
					groupCount: 40,  // TUNEABLE: increase for more sandbags
					
					// Placement bounds (battlefield between defensive walls)
					bounds: {
						minX: -10000,  // Just inside left defensive wall
						maxX: 10000,   // Just inside right defensive wall
						minY: -1400,   // Top of map
						maxY: 1400     // Bottom of map
					},
					
					// Each group contains 1-4 sandbags in different orientations
					groupComposition: {
						// Probability of each direction appearing in a group (0-1)
						horizontal: 0.8,    // 80% chance for horizontal sandbags
						vertical: 0.6,      // 60% chance for vertical sandbags
						diagonalLeft: 0.4,  // 40% chance for diagonal-left (\) sandbags
						diagonalRight: 0.4  // 40% chance for diagonal-right (/) sandbags
					},
					
					// Spacing between sandbags within a group
					groupSpacing: {
						horizontal: 260,   // Space between horizontal sandbags
						vertical: 280,     // Space between vertical rows
						diagonal: 300      // Space for diagonal arrangements
					},
					
					// Minimum distance between groups (prevents clustering)
					minGroupDistance: 400,
					
					// Clearance from other obstacles
					obstacleClearance: 100,
					
					// Safe zone clearance (avoid spawning near player spawn/extraction)
					safeZoneClearance: 800,
					safeZones: [
						{ x: -11000, y: 0, radius: 1000 },  // Player spawn area
						{ x: 11000, y: 0, radius: 1000 }    // Enemy spawn area
					]
				},
				
				// Grid placement strategy (alternative)
				grid: {
					enabled: false,  // Not used by default
					rows: 5,
					columns: 20,
					cellWidth: 1000,
					cellHeight: 500,
					offsetX: -10000,
					offsetY: -1200,
					randomOffsetRange: 150  // Random offset within each cell
				},
				
				// Defensive lines strategy (alternative)
				defensiveLines: {
					enabled: false,  // Not used by default
					lineCount: 3,
					linesSpacing: 3000,
					sandbagsPacing: 400,
					startX: -8000
				},
				
				// Cluster strategy (alternative)
				clusters: {
					enabled: false,  // Not used by default
					clusterCount: 15,
					sandsbagsPerCluster: { min: 3, max: 8 },
					clusterRadius: 300
				},
				
				// Sandbag physical properties (all strategies)
				properties: {
					horizontal: {
						w: 220,
						h: 36,
						health: 300,
						healthMax: 300
					},
					vertical: {
						w: 48,
						h: 220,
						health: 300,
						healthMax: 300
					},
					diagonalLeft: {
						w: 220,
						h: 48,
						angle: Math.PI / 4,  // 45 degrees
						health: 300,
						healthMax: 300
					},
					diagonalRight: {
						w: 220,
						h: 48,
						angle: -Math.PI / 4,  // -45 degrees
						health: 300,
						healthMax: 300
					}
				},
				
				// Overlap rules
				overlap: {
					allowEndOverlap: true,      // Sandbags can touch at ends
					allowMiddleOverlap: false,  // Sandbags cannot overlap in middle
					endOverlapDistance: 50,     // Max overlap at ends (pixels)
					middleOverlapDistance: 10   // Min distance for middle sections
				}
			},
			
			// Barbed wire configuration
			barbedWire: {
				enabled: true,
				
				// Placement strategy: 'scattered' only for now
				strategy: 'scattered',
				
				// Scattered triple concertina fence configuration
				scattered: {
					// Number of barbed wire clusters to place
					clusterCount: 25,  // TUNEABLE: increase for more wire
					
					// Cluster composition (how many wire obstacles per cluster)
					wiresPerCluster: { min: 2, max: 3 },  // 2-3 wires per cluster
					
					// Only spawn triple concertina variant (3rd from left in test row)
					variant: 'tripleConcertina',
					
					// Placement bounds (same as sandbags)
					bounds: {
						minX: -10000,
						maxX: 10000,
						minY: -1400,
						maxY: 1400
					},
					
					// Spacing within cluster
					clusterSpacing: 350,  // Distance between wires in same cluster
					
					// Minimum distance between clusters
					minClusterDistance: 500,
					
					// Clearance from obstacles and sandbags
					obstacleClearance: 150,
					sandbagClearance: 200,  // Extra clearance from sandbags
					
					// Safe zone clearance
					safeZoneClearance: 800,
					safeZones: [
						{ x: -11000, y: 0, radius: 1000 },
						{ x: 11000, y: 0, radius: 1000 }
					]
				}
			},
			
			// Mud pools configuration
			mudPools: {
				enabled: true,
				
				// Placement strategy: 'scattered' only for now
				strategy: 'scattered',
				
				// Scattered mud pool configuration
				scattered: {
					// Number of mud pool clusters to place
					clusterCount: 30,  // TUNEABLE: increase for more mud
					
					// Cluster composition (how many pools per cluster)
					poolsPerCluster: { min: 1, max: 4 },  // 1-4 pools per cluster
					
					// Pool size range
					radius: { min: 100, max: 180 },
					
					// Placement bounds (same as sandbags)
					bounds: {
						minX: -10000,
						maxX: 10000,
						minY: -1400,
						maxY: 1400
					},
					
					// Spacing within cluster
					clusterSpacing: 200,  // Distance between pools in same cluster
					
					// Minimum distance between clusters
					minClusterDistance: 400,
					
					// Clearance from obstacles (but NOT from sandbags/wire - can overlap)
					obstacleClearance: 80,
					
					// Safe zone clearance
					safeZoneClearance: 800,
					safeZones: [
						{ x: -11000, y: 0, radius: 1000 },
						{ x: 11000, y: 0, radius: 1000 }
					]
				}
			},
			
			// Trenches configuration
			trenches: {
				enabled: false,  // Disabled for now
				count: 10,
				minWidth: 280,
				maxWidth: 360,
				minHeight: 60,
				maxHeight: 100
			},
			
			// Fire pools configuration
			firePools: {
				enabled: true,
				
				// Placement strategy: 'scattered' only for now
				strategy: 'scattered',
				
				// Scattered fire pool configuration
				scattered: {
					// Number of fire pools to place (individual pools, not clusters)
					poolCount: 5,  // TUNEABLE: only 5 total pools (rare hazard)
					
					// Fire pool properties
					radius: 200,
					dotDps: 20,          // 20 damage per second
					dotDuration: 3.0,     // Burn for 3 seconds after leaving
					dotTickInterval: 0.5, // Apply damage every 0.5s
					smoke: true,          // Show smoke effect
					
					// Placement bounds (same as other hazards)
					bounds: {
						minX: -10000,
						maxX: 10000,
						minY: -1400,
						maxY: 1400
					},
					
					// Minimum distance between fire pools
					minPoolDistance: 2000,  // Very spread out (2000 units apart)
					
					// Clearance from other hazards
					obstacleClearance: 150,
					sandbagClearance: 300,   // Don't spawn too close to sandbags
					wireClearance: 300,      // Don't spawn too close to wire
					mudClearance: 200,       // Can be near mud but not on top
					
					// Safe zone clearance
					safeZoneClearance: 1200,  // Extra clearance from spawn zones
					safeZones: [
						{ x: -11000, y: 0, radius: 1000 },
						{ x: 11000, y: 0, radius: 1000 }
					]
				}
			},
			
			// Gas canisters configuration (vision impairment hazard)
			gasCanisters: {
				enabled: true,
				
				// Placement strategy
				strategy: 'scattered',
				
				// Scattered cluster configuration
				scattered: {
					// Number of clusters to place
					clusterCount: 8,  // TUNEABLE: 8 clusters across the battlefield
					
					// Canisters per cluster
					canistersPerCluster: { min: 3, max: 8 },
					
					// Canister properties (match test row)
					radius: 180,      // Gas cloud radius
					dotDps: 0,        // No damage - vision impairment only
					dotDuration: 0,
					dotTickInterval: 0.5,
					
					// Spacing between canisters within cluster (match test row)
					canisterSpacing: 320,  // Average spacing (gas radius is 180, so slight overlap is fine)
					randomOffset: 120,     // Random offset per canister for natural look
					
					// Placement bounds (same as other hazards)
					bounds: {
						minX: -10000,
						maxX: 10000,
						minY: -1400,
						maxY: 1400
					},
					
					// Minimum distance between clusters
					minClusterDistance: 2000,  // Keep clusters well separated
					
					// Clearance from other hazards
					obstacleClearance: 150,
					sandbagClearance: 300,
					wireClearance: 300,
					mudClearance: 200,
					fireClearance: 400,  // Keep away from fire pools
					
					// Safe zone clearance
					safeZoneClearance: 1000,
					safeZones: [
						{ x: -11000, y: 0, radius: 1000 },
						{ x: 11000, y: 0, radius: 1000 }
					]
				}
			},
			
			// Exploding barrels configuration
			explodingBarrels: {
				enabled: true,
				
				// Mixed strategy: some clustered, some scattered
				strategy: 'mixed',
				
				// Barrel properties
				properties: {
					health: 75,
					healthMax: 75,
					explosionRadius: 300,  // Increased from 180 for bigger blast
					explosionDamage: 80,   // Damage at center, falls off to 40% at edge
					visualRadius: 24       // Visual/collision radius of barrel
				},
				
				// Mixed placement configuration
				mixed: {
					// Clusters of barrels (grouped together)
					clusters: {
						count: 18,  // 3 clusters per zone × 6 zones
						barrelsPerCluster: { min: 2, max: 4 },  // 2-4 barrels per cluster
						clusterRadius: 120,  // Tighter clusters
						minClusterDistance: 800  // Moderate spacing
					},
					
					// Scattered individual barrels
					scattered: {
						count: 30,  // 5 scattered per zone × 6 zones
						minBarrelDistance: 400  // Moderate spacing
					},
					
					// Placement bounds - ALL ZONES (A-F)
					bounds: {
						minX: -10000,  // Zone A start (past defensive wall)
						maxX: 10000,   // Zone F end (before Heretic wall)
						minY: -1200,   // Top of playable area
						maxY: 1200     // Bottom of playable area
					},
					
					// Clearance from other hazards
					obstacleClearance: 80,
					sandbagClearance: 100,
					wireClearance: 100,
					fireClearance: 250,  // Keep away from fire pools
					
					// Safe zone clearance
					safeZoneClearance: 600,
					safeZones: [
						{ x: -11000, y: 0, radius: 800 },  // New Antioch spawn area
						{ x: 11000, y: 0, radius: 800 }   // Heretic spawn area
					]
				},
				
				// Visual properties (used by client)
				visual: {
					radius: 24,
					baseColor: '#8B0000',      // Dark red
					highlightColor: '#cc2222', // Brighter red
					rimColor: '#2d0a0a',       // Very dark rim
					warningColor: '#FF4444'    // Warning glow when damaged
				}
			}
		}
	};
	
	static get(modeType) {
		return this.configs[modeType] || this.configs.test;
	}
	
	static exists(modeType) {
		return !!this.configs[modeType];
	}
	
	// Helper: Get sandbag count for a given mode
	static getSandbagCount(modeType) {
		const config = this.get(modeType);
		if (!config || !config.enabled || !config.sandbags || !config.sandbags.enabled) {
			return 0;
		}
		
		const strategy = config.sandbags.strategy;
		switch (strategy) {
			case 'scattered':
				return config.sandbags.scattered.groupCount;
			case 'grid':
				return config.sandbags.grid.rows * config.sandbags.grid.columns;
			case 'defensiveLines':
				return config.sandbags.defensiveLines.lineCount * 20; // Approximate
			case 'clusters':
				return config.sandbags.clusters.clusterCount;
			default:
				return 0;
		}
	}
	
	// Helper: Adjust sandbag density (multiplier: 0.5 = half, 2.0 = double)
	static adjustDensity(modeType, multiplier) {
		const config = this.get(modeType);
		if (!config || !config.sandbags || !config.sandbags.enabled) {
			return;
		}
		
		const strategy = config.sandbags.strategy;
		switch (strategy) {
			case 'scattered':
				config.sandbags.scattered.groupCount = Math.round(
					config.sandbags.scattered.groupCount * multiplier
				);
				break;
			case 'grid':
				config.sandbags.grid.rows = Math.round(
					config.sandbags.grid.rows * Math.sqrt(multiplier)
				);
				config.sandbags.grid.columns = Math.round(
					config.sandbags.grid.columns * Math.sqrt(multiplier)
				);
				break;
			case 'clusters':
				config.sandbags.clusters.clusterCount = Math.round(
					config.sandbags.clusters.clusterCount * multiplier
				);
				break;
		}
	}
}

// Export for both browser and Node.js
if (typeof module !== 'undefined' && module.exports) {
	module.exports = HazardsConfig;
} else {
	window.HazardsConfig = HazardsConfig;
}

