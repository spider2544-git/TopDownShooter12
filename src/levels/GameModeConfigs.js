// Game Mode Configuration System
// Defines gameplay rules and parameters for each game mode
// All three modes start with identical values (current game behavior)

class GameModeConfigs {
	static configs = {
		test: {
			name: 'Test Level',
			
			// Enemy spawn configuration (from _computeEnemySpawns)
			enemies: {
				totalCount: 800,
				enemyRadius: 26,
				triesPerEnemy: 40,
				maxRange: 10000,
				safeZoneHalfSize: 750,
				
			// Type distribution (must sum to 1.0)
			typeRatios: {
				boomer: 0,
				projectile: 0.10,  // 10% - Ranged threat (learn to dodge)
				licker: 0,
				wallguy: 0,
				basic: 0.90        // 90% - Core enemy
			},
				
				// Enemy stats by type (from enemy initialization)
				stats: {
					boomer: {
						radius: 32,
						speedMul: 1.25,
						healthMax: 220,
						preferContact: true,
						avoidObstaclesAggressively: true,
						preferOpenSpaces: true
					},
					projectile: {
						radius: 26,
						speedMul: 1.0,
						healthMax: 100,
						preferContact: false,
						tacticMode: 'kite',
						tacticDuration: { min: 5, max: 10 }
					},
				licker: {
					radius: 26,
					speedMul: 1.0,
					healthMax: 100,
					preferContact: true
				},
				bigboy: {
					radius: 80,
					speedMul: 0.7,
					healthMax: 880,
					preferContact: true,
					avoidObstaclesAggressively: true,
					dashRange: 400,
					dashDistance: 300,
					dashDuration: 0.3,
					dashWindupDuration: 0.8,
					dashCooldown: 0,
					dashWindup: 0,
					isDashing: false
				},
			wallguy: {
				radius: 28,
				speedMul: 0.8,
				healthMax: 300,
				preferContact: true,
				rotationSpeed: Math.PI / 4.3, // ~42° per second (30% slower than original 60°/s)
				shieldWidth: 80,
				shieldDepth: 20,
				attackInterval: 3.0,
				attackRange: 600
			},
				basic: {
					radius: 26,
					speedMul: 1.0,
					healthMax: 100,
					preferContact: true
				}
			}
		},
		
		// Zone-based spawning configuration (progressive difficulty by location)
		zoneSpawning: {
			enabled: true,
			preSpawnDistance: 2000,  // Spawn next zone when players are 2000 units away
			checkInterval: 1000,     // Check player positions every second
			
			zones: [
				// ZONE A - Tutorial/Entry Zone (Easy - Spawn area)
				{
					name: 'Zone A - Entry',
					minX: -3000,
					maxX: 0,
					minY: -3000,
					maxY: 3000,
					enemyCount: 40,
					enemyRadius: 26,
					triesPerEnemy: 40,
					typeRatios: {
						basic: 1.0,          // 100% basic zombies
						projectile: 0,
						boomer: 0,
						licker: 0,
						bigboy: 0,
						wallguy: 0
					}
				},
				
				// ZONE B - Mixed Zone (Medium)
				{
					name: 'Zone B - Mixed Threats',
					minX: 500,
					maxX: 3500,
					minY: -3000,
					maxY: 3000,
					enemyCount: 60,
					enemyRadius: 26,
					triesPerEnemy: 40,
					typeRatios: {
						basic: 0.70,         // 70% basic
						projectile: 0.20,    // 20% projectile (ranged threat introduced)
						boomer: 0,
						licker: 0,
						bigboy: 0,
						wallguy: 0.10        // 10% wall guys
					}
				},
				
				// ZONE C - Challenging Zone (Hard)
				{
					name: 'Zone C - Elite Forces',
					minX: 4000,
					maxX: 7000,
					minY: -3000,
					maxY: 3000,
					enemyCount: 80,
					enemyRadius: 26,
					triesPerEnemy: 40,
					typeRatios: {
						basic: 0.45,         // 45% basic
						projectile: 0.20,    // 20% projectile
						boomer: 0.15,        // 15% boomers (explosive threat)
						licker: 0.10,        // 10% lickers (fast melee)
						bigboy: 0,
						wallguy: 0.10        // 10% wall guys
					}
				},
				
				// ZONE D - Boss Zone (Very Hard)
				{
					name: 'Zone D - Final Stand',
					minX: 7500,
					maxX: 10000,
					minY: -3000,
					maxY: 3000,
					enemyCount: 100,
					enemyRadius: 26,
					triesPerEnemy: 40,
					typeRatios: {
						basic: 0.30,         // 30% basic
						projectile: 0.20,    // 20% projectile
						boomer: 0.15,        // 15% boomers
						licker: 0.15,        // 15% lickers
						bigboy: 0.10,        // 10% big boys (tanky elites)
						wallguy: 0.10        // 10% wall guys
					}
				}
			]
		},
		
	// Loot spawn configuration (from _computeLevelSpawns)
	loot: {
		clearance: 28,
			
			goldChest: {
				preferredPosition: { x: 200, y: 150 },
				fallbackSearchRadius: { min: 100, max: 400 },
				fallbackTries: 300,
				dropCount: 10  // Gold chest drop count (from server.js line 454 equivalent)
			},
			
			brownChest: {
				spawnNearGold: true,
				distanceFromGold: { min: 120, max: 180 },
				additionalDistance: 180,
				tries: 200,
				dropCount: 10  // Brown chest drop count (from server.js line 454)
			}
		},
			
			// NPC spawn configuration (from _computeLevelSpawns)
			npcs: {
			// Trench Raid: spawn Prisoner only (no Heretic Priest)
			types: ['NPC_A'],
				radius: 24,
				maxDistanceFromGold: 500,
				tries: 700,
				minDistanceFromChest: 6,
				minDistanceFromOtherNPC: 6
			},
			
		// Timer configuration (from GameRoom constructor)
		timers: {
			ready: 10.0,
			extraction: 10.0,
			extractionZone: 60.0
		}
	},
	
extraction: {
	name: 'Extraction',
	
	// Same enemies as test mode
	enemies: {
		totalCount: 800,
		enemyRadius: 26,
		triesPerEnemy: 40,
		maxRange: 10000,
		safeZoneHalfSize: 750,
		
		typeRatios: {
			boomer: 0,
			projectile: 0.10,
			licker: 0,
			wallguy: 0,
			basic: 0.90
		},
		
		stats: {
			boomer: {
				radius: 32,
				speedMul: 1.25,
				healthMax: 220,
				preferContact: true,
				avoidObstaclesAggressively: true,
				preferOpenSpaces: true
			},
			projectile: {
				radius: 26,
				speedMul: 1.0,
				healthMax: 100,
				preferContact: false,
				tacticMode: 'kite',
				tacticDuration: { min: 5, max: 10 }
			},
			licker: {
				radius: 26,
				speedMul: 1.0,
				healthMax: 100,
				preferContact: true
			},
			bigboy: {
				radius: 80,
				speedMul: 0.7,
				healthMax: 880,
				preferContact: true,
				avoidObstaclesAggressively: true,
				dashRange: 400,
				dashDistance: 300,
				dashDuration: 0.3,
				dashWindupDuration: 0.8,
				dashCooldown: 0,
				dashWindup: 0,
				isDashing: false
			},
			wallguy: {
				radius: 28,
				speedMul: 0.8,
				healthMax: 300,
				preferContact: true,
				rotationSpeed: Math.PI / 3, // 60° per second
				shieldWidth: 80,
				shieldDepth: 20,
				attackInterval: 2.5, // Melee attack every 2.5 seconds
				attackRange: 150 // Melee range (was 600 for projectiles)
			},
			basic: {
				radius: 26,
				speedMul: 1.0,
				healthMax: 100,
				preferContact: true
			}
		},
		
		// Currency drop rates per enemy type
		dropRates: {
				boomer: {
					ducats: { chance: 0.5, min: 5, max: 15 },
					bloodMarkers: { chance: 0.5, min: 1, max: 3 }
				},
				projectile: {
					ducats: { chance: 0.5, min: 3, max: 10 },
					bloodMarkers: { chance: 0.5, min: 1, max: 2 }
				},
				licker: {
					ducats: { chance: 0.5, min: 3, max: 10 },
					bloodMarkers: { chance: 0.5, min: 1, max: 2 }
				},
				bigboy: {
					ducats: { chance: 0.6, min: 8, max: 20 },
					bloodMarkers: { chance: 0.6, min: 2, max: 4 }
				},
				basic: {
					ducats: { chance: 0.5, min: 2, max: 8 },
					bloodMarkers: { chance: 0.5, min: 1, max: 1 }
				},
				boss: {
					ducats: { chance: 1.0, min: 50, max: 100 },
					bloodMarkers: { chance: 1.0, min: 10, max: 20 }
				}
			}
		},
		
		// CUSTOM: 1 gold chest (artifact) + 200 brown chests (loot) scattered across map
		loot: {
			clearance: 28,
			
			// Gold chest for artifact (required for extraction objective)
			goldChest: {
				preferredPosition: { x: 200, y: 150 },
				fallbackSearchRadius: { min: 100, max: 400 },
				fallbackTries: 300,
				dropCount: 0  // Gold chest spawns artifact, not loot drops
			},
			
		// 150 brown chests scattered across map
		brownChestCount: 150,         // Spawn 150 brown chests total
		brownChestDropCount: 2,       // 2 items per chest (instead of 10) - NOTE: actual drop count randomized per chest
			
			// Spread chests across the map
			minDistanceFromSpawn: 500,    // Don't spawn too close to spawn
			maxDistanceFromSpawn: 8000,   // Spread across map
			minDistanceBetweenChests: 150, // Avoid clustering (reduced for more chests)
			maxPlacementTries: 100        // Per chest placement attempts
		},
			
		npcs: {
			types: ['NPC_A', 'NPC_B'],
			radius: 24,
			maxDistanceFromGold: 500,
			tries: 700,
			minDistanceFromChest: 6,
			minDistanceFromOtherNPC: 6
		},
		
		// Phase timer configuration for extraction mode
		phases: {
			search: {
				name: 'Search',
				duration: 180  // 3 minutes (countdown)
			},
			guard: {
				name: 'Guard',
				duration: 60  // 1 minute (countdown)
			},
			waves: [
				{ duration: 180, label: 'Wave 1' },   // 3:00 count-up
				{ duration: 180, label: 'Wave 2' },
				{ duration: 180, label: 'Wave 3' },
				{ duration: Infinity, label: 'Wave 4' } // infinite (keep counting up)
			]
		},
		
		// Phase-based horde spawning configuration
		hordeSpawning: {
			search: {
				enabled: true,
				intervalMin: 30000,      // 30s minimum between hordes
				intervalMax: 45000,      // 45s maximum between hordes
				perPlayerHordes: true,   // Spawn separate hordes targeting each player
				difficulty: { min: 1, max: 2 },  // Difficulty 1-2: basics and projectiles only
				targetEnemyCount: { min: 15, max: 25 }  // Total on-screen enemies to maintain
			},
			guard: {
				enabled: true,
				intervalMin: 15000,      // 15s minimum
				intervalMax: 25000,      // 25s maximum
				perPlayerHordes: false,  // Target chest area instead
				difficulty: { min: 3, max: 4 },  // Difficulty 3-4: boomers introduced, but no lickers/bigboys yet
				targetEnemyCount: { min: 30, max: 40 }
			},
			onChestOpen: {
				enabled: true,
				spawnCount: 2,           // Spawn 2 hordes when chest is opened
				difficulty: 5
			},
			onExtractionStart: {
				enabled: true,
				normalOnly: true,        // Only trigger for normal extraction, not heretic
				waves: [
					{ difficulty: 5, count: 1, delay: 0 },       // Immediate: 1 horde diff 5
					{ difficulty: 5, count: 1, delay: 15000 },   // After 15s: 1 horde diff 5
					{ difficulty: 6, count: 1, delay: 15000 }    // After another 15s: 1 horde diff 6
				]
				// Total: 2x diff 5, 1x diff 6 spawned over 30 seconds during extraction
			},
			waves: [
				{ enabled: true, difficulty: { min: 2, max: 3 }, intervalMin: 20000, intervalMax: 35000, targetEnemyCount: { min: 40, max: 60 } },  // Wave 1
				{ enabled: true, difficulty: { min: 3, max: 5 }, intervalMin: 18000, intervalMax: 30000, targetEnemyCount: { min: 50, max: 70 } },  // Wave 2
				{ enabled: true, difficulty: { min: 4, max: 6 }, intervalMin: 15000, intervalMax: 25000, targetEnemyCount: { min: 60, max: 80 } },  // Wave 3
				{ enabled: true, difficulty: { min: 5, max: 7 }, intervalMin: 12000, intervalMax: 20000, targetEnemyCount: { min: 70, max: 90 } }   // Wave 4+
			]
		},
		
	timers: {
		ready: 10.0,
		extraction: 60.0,
		extractionZone: 60.0
	}
},
	
payload: {
		name: 'Payload Escort',
		
		// IDENTICAL to test for now
		enemies: {
			totalCount: 800,
			enemyRadius: 26,
			triesPerEnemy: 40,
			maxRange: 10000,
			safeZoneHalfSize: 750,
			
			typeRatios: {
				boomer: 0,
				projectile: 0.10,
				licker: 0,
				wallguy: 0,
				basic: 0.90
			},
			
		stats: {
			boomer: {
				radius: 32,
				speedMul: 1.25,
				healthMax: 220,
				preferContact: true,
				avoidObstaclesAggressively: true,
				preferOpenSpaces: true
			},
			projectile: {
				radius: 26,
				speedMul: 1.0,
				healthMax: 100,
				preferContact: false,
				tacticMode: 'kite',
				tacticDuration: { min: 5, max: 10 }
			},
			licker: {
				radius: 26,
				speedMul: 1.0,
				healthMax: 100,
				preferContact: true
			},
			bigboy: {
				radius: 80,
				speedMul: 0.7,
				healthMax: 880,
				preferContact: true,
				avoidObstaclesAggressively: true,
				dashRange: 400,
				dashDistance: 300,
				dashDuration: 0.3,
				dashWindupDuration: 0.8,
				dashCooldown: 0,
				dashWindup: 0,
				isDashing: false
			},
			wallguy: {
				radius: 28,
				speedMul: 0.8,
				healthMax: 300,
				preferContact: true,
				rotationSpeed: Math.PI / 3, // 60° per second
				shieldWidth: 80,
				shieldDepth: 20,
				attackInterval: 2.5, // Melee attack every 2.5 seconds
				attackRange: 150 // Melee range (was 600 for projectiles)
			},
			basic: {
				radius: 26,
				speedMul: 1.0,
				healthMax: 100,
				preferContact: true
			}
		},
		
		// Currency drop rates per enemy type
		dropRates: {
				boomer: {
					ducats: { chance: 0.5, min: 5, max: 15 },
					bloodMarkers: { chance: 0.5, min: 1, max: 3 }
				},
				projectile: {
					ducats: { chance: 0.5, min: 3, max: 10 },
					bloodMarkers: { chance: 0.5, min: 1, max: 2 }
				},
				licker: {
					ducats: { chance: 0.5, min: 3, max: 10 },
					bloodMarkers: { chance: 0.5, min: 1, max: 2 }
				},
				bigboy: {
					ducats: { chance: 0.6, min: 8, max: 20 },
					bloodMarkers: { chance: 0.6, min: 2, max: 4 }
				},
				basic: {
					ducats: { chance: 0.5, min: 2, max: 8 },
					bloodMarkers: { chance: 0.5, min: 1, max: 1 }
				},
				boss: {
					ducats: { chance: 1.0, min: 50, max: 100 },
					bloodMarkers: { chance: 1.0, min: 10, max: 20 }
				}
			}
		},
		
	loot: {
			clearance: 28,
			
			goldChest: {
				preferredPosition: { x: 200, y: 150 },
				fallbackSearchRadius: { min: 100, max: 400 },
				fallbackTries: 300,
				dropCount: 10  // Gold chest drop count
			},
			
			brownChest: {
				spawnNearGold: true,
				distanceFromGold: { min: 120, max: 180 },
				additionalDistance: 180,
				tries: 200,
				dropCount: 10  // Brown chest drop count
			}
		},
		
		npcs: {
			types: ['NPC_A', 'NPC_B'],
			radius: 24,
			maxDistanceFromGold: 500,
			tries: 700,
			minDistanceFromChest: 6,
			minDistanceFromOtherNPC: 6
		},
		
	timers: {
		ready: 10.0,
		extraction: 10.0,
		extractionZone: 60.0
	}
},

trenchraid: {
		name: 'Trench Raid',

		// Hazard testing configuration (left-edge row first)
		hazards: {
			enable: true,
			mode: 'leftRow',      // leftRow | full (future)
			leftInset: 260,
			rowSpacing: 280,
			extraSandbags: 3
		},
		
		// Ambient spawning configuration - disabled, ZoneSpawner handles all spawning
		ambient: {
			enabled: false  // ZoneSpawner handles initial horde, zone spawns, and periodic hordes
		},
		
		// Spawn configuration for rectangular map (doubled width)
		spawn: {
			side: 'left',  // Players spawn on New Antioch side (left)
			x: -11000,     // Behind the New Antioch wall at -10200 (safe zone)
			y: 0,          // Center vertically
			radius: 300    // Spawn area size (increased for more spread)
		},
		
		// Extraction zone configuration - win by returning to New Antioch (left side)
		extraction: {
			side: 'left',  // Win by returning to New Antioch (left side)
			x: -11000,     // Behind the New Antioch wall at -10200 (safe zone)
			y: 0,          // Center vertically
			radius: 400    // Extraction zone size (larger for easier extraction)
		},
		
		// Horde spawning during extraction - level 7 hordes breach past turrets
		hordeSpawning: {
			onExtractionStart: {
				enabled: true,
				waves: [
					{ difficulty: 7, count: 2, delay: 0 },       // Immediate: 2 level-7 hordes
					{ difficulty: 7, count: 1, delay: 8000 },    // After 8s: 1 more horde
					{ difficulty: 7, count: 1, delay: 16000 }    // After 16s: final horde
				]
			}
		},
		
		// Allied troop spawning configuration - New Antioch soldiers spawn from barracks
		troops: {
			enabled: true,
			barracks: {
				x: -11800,            // X position (near artillery)
				upperY: -700,         // Upper barracks Y (above top artillery at -500)
				lowerY: 700,          // Lower barracks Y (below bottom artillery at 500)
				spawnInterval: 3.0,   // Seconds between spawns per barracks
				maxTroops: 20,        // Max troops alive from each barracks (2 barracks => 40 total)
				targetX: -9500        // Where troops advance to (ZoneA interior)
			}
		},
		
		// Zone-based spawning configuration (6 zones across battlefield)
		zoneSpawning: {
			enabled: true,
			preSpawnDistance: 2500,  // Larger map needs longer pre-spawn distance
			checkInterval: 1000,
			
			// Zone horde spawning configuration (difficulty and intervals per zone)
			// Forward = going toward artifact (right), Return = has artifact (left)
			zoneHordeConfig: {
				A: { forwardDiff: 1, returnDiff: 7, forwardInterval: [45000, 60000], returnInterval: [10000, 18000] },
				B: { forwardDiff: 2, returnDiff: 6, forwardInterval: [35000, 50000], returnInterval: [12000, 20000] },
				C: { forwardDiff: 2, returnDiff: 6, forwardInterval: [30000, 45000], returnInterval: [12000, 20000] },
				D: { forwardDiff: 3, returnDiff: 5, forwardInterval: [25000, 40000], returnInterval: [15000, 25000] },
				E: { forwardDiff: 3, returnDiff: 5, forwardInterval: [20000, 35000], returnInterval: [15000, 25000] },
				F: { forwardDiff: 4, returnDiff: 4, forwardInterval: [18000, 30000], returnInterval: [18000, 30000] }
			},
			
			// Difficulty presets (size and type ratios) - matches HordeSpawner
			difficultyPresets: {
				1: { size: 5,  typeRatios: { boomer: 0, projectile: 0, licker: 0, bigboy: 0, wallguy: 0, basic: 1.0 } },
				2: { size: 10, typeRatios: { boomer: 0, projectile: 0.27, licker: 0, bigboy: 0, wallguy: 0.05, basic: 0.68 } },
				3: { size: 12, typeRatios: { boomer: 0.15, projectile: 0.10, licker: 0, bigboy: 0, wallguy: 0.10, basic: 0.65 } },
				4: { size: 10, typeRatios: { boomer: 0.15, projectile: 0.23, licker: 0, bigboy: 0, wallguy: 0.12, basic: 0.50 } },
				5: { size: 12, typeRatios: { boomer: 0.15, projectile: 0.13, licker: 0.10, bigboy: 0.05, wallguy: 0.12, basic: 0.45 } },
				6: { size: 15, typeRatios: { boomer: 0.15, projectile: 0.13, licker: 0.15, bigboy: 0.05, wallguy: 0.12, basic: 0.40 } },
				7: { size: 18, typeRatios: { boomer: 0.15, projectile: 0.18, licker: 0.20, bigboy: 0.10, wallguy: 0.12, basic: 0.25 } }
			},
			
			// Helper: Check if any player has artifact
			_hasArtifact: (room) => {
				for (const chest of room.chests.values()) {
					if (chest.variant === 'gold' && chest.artifactCarriedBy) {
						return true;
					}
				}
				return false;
			},
			
			// Helper: Spawn a zone horde with given parameters
			// isPeriodic: true for periodic spawns, false/undefined for entry spawns
			// Note: ZoneSpawner already has an 8-second re-entry cooldown that prevents
			// zone boundary oscillation from triggering multiple entry events.
			_spawnZoneHorde: (room, zone, zoneLetter, config, isPeriodic = false) => {
				const zoneSpawning = room.currentGameMode?.config?.zoneSpawning;
				if (!zoneSpawning) return;
				
				const hasArtifact = zoneSpawning._hasArtifact(room);
				const zoneConfig = zoneSpawning.zoneHordeConfig[zoneLetter];
				if (!zoneConfig) return;
				
				const difficulty = hasArtifact ? zoneConfig.returnDiff : zoneConfig.forwardDiff;
				const preset = zoneSpawning.difficultyPresets[difficulty];
				if (!preset) return;
				
				// Get player in zone (use exclusive upper bounds for consistency)
				const players = Array.from(room.players.values()).filter(p => p && p.health > 0);
				const playerInZone = players.find(p => 
					p.x >= zone.minX && p.x < zone.maxX && 
					p.y >= zone.minY && p.y < zone.maxY
				);
				if (!playerInZone) {
					// Fallback to any alive player
					if (players.length === 0) return;
				}
				const targetPlayer = playerInZone || players[0];
				
				// Spawn direction: forward (right/+X) or return (left/-X)
				const spawnDirection = hasArtifact ? -1 : 1;
				const viewportWidth = targetPlayer.viewportWidth || 1920;
				const offScreenBuffer = 300;
				const halfViewport = viewportWidth / 2;
				
				// Spawn off-screen relative to the TARGET PLAYER's position (not random zone position)
				// This ensures enemies always spawn outside the player's viewport
				// Clamp to prevent spawning in New Antioch safe zone (x < -10000)
				const rawSpawnX = targetPlayer.x + (spawnDirection * (halfViewport + offScreenBuffer));
				const spawnX = Math.max(-9800, rawSpawnX);  // Never spawn left of -9800
				
				// Y varies randomly
				const rngY = room._rng(Date.now() + 12345 + zoneLetter.charCodeAt(0));
				const yVariation = (rngY() - 0.5) * 1200;
				const spawnY = Math.max(-1300, Math.min(1300, targetPlayer.y + yVariation));
				
				console.log(`[Zone${zoneLetter}] ${hasArtifact ? 'RETURN' : 'FORWARD'} - Difficulty ${difficulty}, spawning ${preset.size} enemies`);
				console.log(`[Zone${zoneLetter}] Spawn at (${spawnX.toFixed(0)}, ${spawnY.toFixed(0)}), direction: ${spawnDirection > 0 ? 'RIGHT' : 'LEFT'}`);
				
				// Pick enemy types based on preset ratios
				const pickType = (rng, ratios) => {
					const r = rng();
					let acc = 0;
					const order = ['boomer', 'projectile', 'licker', 'bigboy', 'wallguy', 'basic'];
					for (const type of order) {
						acc += ratios[type] || 0;
						if (r < acc) return type;
					}
					return 'basic';
				};
				
				const spread = 150;
				const maxTriesPerEnemy = 20;
				const rng = room._rng(Date.now() + Math.random() * 1e9);
				const spawned = [];
				
				// New Antioch safe zone boundary - no enemies allowed past this point
				const newAntiochSafeX = -10000;
				
				for (let i = 0; i < preset.size; i++) {
					let placed = false;
					for (let tries = 0; tries < maxTriesPerEnemy && !placed; tries++) {
						const currentSpread = spread + (tries * 30);
						const angle = rng() * Math.PI * 2;
						const dist = Math.sqrt(rng()) * currentSpread;
						const ex = spawnX + Math.cos(angle) * dist;
						const ey = spawnY + Math.sin(angle) * dist;
						
						// Reject spawns in New Antioch safe zone
						if (ex < newAntiochSafeX) continue;
						
						if (!room.environment.isInsideBounds(ex, ey, 26)) continue;
						if (room.environment.circleHitsAny && room.environment.circleHitsAny(ex, ey, 26)) continue;
						
						// Check minimum distance from ALL players to prevent spawning on top of them
						const MIN_PLAYER_DISTANCE = 700;
						let tooCloseToPlayer = false;
						for (const [, p] of room.players) {
							if (!p || p.health <= 0) continue;
							const pdx = ex - (p.x || 0);
							const pdy = ey - (p.y || 0);
							if (pdx * pdx + pdy * pdy < MIN_PLAYER_DISTANCE * MIN_PLAYER_DISTANCE) {
								tooCloseToPlayer = true;
								break;
							}
						}
						if (tooCloseToPlayer) continue;
						
						placed = true;
						const enemyType = pickType(rng, preset.typeRatios);
						const id = `enemy_${room.nextEnemyId++}`;
						const enemy = {
							id,
							x: ex,
							y: ey,
							type: enemyType,
							radius: 26,
							health: 100,
							healthMax: 100,
							speedMul: 1.0,
							alive: true,
							_spawnedFrom: 'zoneHorde',
							_zoneName: zone.name
							// No _preAggroGoal - let Director AI handle movement immediately
						};
						
						if (room.currentGameMode) {
							room.currentGameMode.initializeEnemyStats(enemy);
						}
						
						room.enemies.set(id, enemy);
						spawned.push(enemy);
					}
				}
				
				if (spawned.length > 0) {
					room.spawnAmbientBatch(spawned);
					console.log(`[Zone${zoneLetter}] Spawned ${spawned.length} enemies (difficulty ${difficulty})`);
					
					room.io.to(room.id).emit('horde_spawned', {
						difficulty: difficulty,
						count: spawned.length,
						hordeNumber: (room._zoneHordeCount = (room._zoneHordeCount || 0) + 1),
						phase: `zone${zoneLetter}`,
						timeSinceLastHorde: 0
					});
				}
				
				return spawned.length;
			},
			
			// Helper: Start periodic spawning for a zone
			_startZonePeriodicSpawning: (room, zone, zoneLetter) => {
				const zoneSpawning = room.currentGameMode?.config?.zoneSpawning;
				if (!zoneSpawning) return;
				
				const timerKey = `_zoneTimer_${zoneLetter}`;
				if (room[timerKey]) return; // Already running
				
				const scheduleNext = () => {
					const hasArtifact = zoneSpawning._hasArtifact(room);
					const zoneConfig = zoneSpawning.zoneHordeConfig[zoneLetter];
					const [minInt, maxInt] = hasArtifact ? zoneConfig.returnInterval : zoneConfig.forwardInterval;
					const interval = minInt + Math.random() * (maxInt - minInt);
					
					room[timerKey] = setTimeout(() => {
						// Check if any player still in zone (use exclusive upper bounds for consistency)
						const players = Array.from(room.players.values()).filter(p => p && p.health > 0);
						const anyInZone = players.some(p => 
							p.x >= zone.minX && p.x < zone.maxX && 
							p.y >= zone.minY && p.y < zone.maxY
						);
						
						if (anyInZone && room.scene === 'level') {
							// isPeriodic = true to bypass duplicate protection for periodic spawns
							zoneSpawning._spawnZoneHorde(room, zone, zoneLetter, zoneConfig, true);
							scheduleNext();
						} else {
							// Stop spawning if no players in zone
							room[timerKey] = null;
							console.log(`[Zone${zoneLetter}] Periodic spawning stopped - no players in zone`);
						}
					}, interval);
					
					console.log(`[Zone${zoneLetter}] Next horde in ${(interval/1000).toFixed(1)}s`);
				};
				
				scheduleNext();
			},
			
			// Initial cinematic horde - spawns immediately in front of New Antioch turrets
			initialHorde: {
				enabled: true,  // Re-enabled - spawns basic zombies that attack turrets
				count: 28,  // Reduced by 20% (was 35)
				spawnArea: {
					minX: -9600,   // OUTSIDE the safe zone (safe zone ends at -9800)
					maxX: -7500,   // Wider spread (2100 units vs 1400 before)
					minY: -1400,   // Full map height
					maxY: 1400
				},
				typeRatios: {
					basic: 1.0,    // 100% basic zombies for dramatic horde effect
					projectile: 0,
					boomer: 0,
					licker: 0,
					bigboy: 0,
					wallguy: 0
				},
				// Cluster spawns near the gaps where turrets are positioned
				clusterNearGaps: true,
				gapPositions: [
					{ x: -10200, y: -1250, radius: 400 },  // Top gap (larger radius for spread)
					{ x: -10200, y: -400, radius: 400 },   // Middle-top gap
					{ x: -10200, y: 400, radius: 400 },    // Middle-bottom gap
					{ x: -10200, y: 1250, radius: 400 }    // Bottom gap
				]
			},
			
			zones: [
				// ZONE A - New Antioch Frontline (Easy start)
				{
					name: 'Zone A - New Antioch Frontline',
					minX: -10200,
					maxX: -6800,
					minY: -1400,
					maxY: 1400,
					enemyCount: 9,  // Reduced by 20% (was 11)
					enemyRadius: 26,
					triesPerEnemy: 40,
					typeRatios: {
						basic: 1.0,
						projectile: 0,
						boomer: 0,
						licker: 0,
						bigboy: 0,
						wallguy: 0
					},
					onEntry: (room, zone) => {
						const zoneSpawning = room.currentGameMode?.config?.zoneSpawning;
						if (!zoneSpawning) return;
						console.log('[ZoneA] Player entered - triggering horde spawn');
						zoneSpawning._spawnZoneHorde(room, zone, 'A', zoneSpawning.zoneHordeConfig.A);
						zoneSpawning._startZonePeriodicSpawning(room, zone, 'A');
					}
				},
				
				// ZONE B - No Man's Land West (Light)
				{
					name: 'Zone B - No Man\'s Land West',
					minX: -6800,
					maxX: -3400,
					minY: -1400,
					maxY: 1400,
					enemyCount: 14,  // Reduced by 20% (was 18)
					enemyRadius: 26,
					triesPerEnemy: 40,
					typeRatios: {
						basic: 0.70,
						projectile: 0.20,
						boomer: 0,
						licker: 0,
						bigboy: 0,
						wallguy: 0.10
					},
					onEntry: (room, zone) => {
						const zoneSpawning = room.currentGameMode?.config?.zoneSpawning;
						if (!zoneSpawning) return;
						console.log('[ZoneB] Player entered - triggering horde spawn');
						zoneSpawning._spawnZoneHorde(room, zone, 'B', zoneSpawning.zoneHordeConfig.B);
						zoneSpawning._startZonePeriodicSpawning(room, zone, 'B');
					}
				},
				
				// ZONE C - Center West (Medium)
				{
					name: 'Zone C - Center West',
					minX: -3400,
					maxX: 0,
					minY: -1400,
					maxY: 1400,
					enemyCount: 20,  // Reduced by 20% (was 25)
					enemyRadius: 26,
					triesPerEnemy: 40,
					typeRatios: {
						basic: 0.55,
						projectile: 0.20,
						boomer: 0.10,
						licker: 0,
						bigboy: 0,
						wallguy: 0.15
					},
					onEntry: (room, zone) => {
						const zoneSpawning = room.currentGameMode?.config?.zoneSpawning;
						if (!zoneSpawning) return;
						console.log('[ZoneC] Player entered - triggering horde spawn');
						zoneSpawning._spawnZoneHorde(room, zone, 'C', zoneSpawning.zoneHordeConfig.C);
						zoneSpawning._startZonePeriodicSpawning(room, zone, 'C');
					}
				},
				
				// ZONE D - Center East (Medium-Hard)
				{
					name: 'Zone D - Center East',
					minX: 0,
					maxX: 3400,
					minY: -1400,
					maxY: 1400,
					enemyCount: 26,  // Reduced by 20% (was 32)
					enemyRadius: 26,
					triesPerEnemy: 40,
					typeRatios: {
						basic: 0.45,
						projectile: 0.20,
						boomer: 0.15,
						licker: 0.10,
						bigboy: 0,
						wallguy: 0.10
					},
					onEntry: (room, zone) => {
						const zoneSpawning = room.currentGameMode?.config?.zoneSpawning;
						if (!zoneSpawning) return;
						console.log('[ZoneD] Player entered - triggering horde spawn');
						zoneSpawning._spawnZoneHorde(room, zone, 'D', zoneSpawning.zoneHordeConfig.D);
						zoneSpawning._startZonePeriodicSpawning(room, zone, 'D');
					}
				},
				
				// ZONE E - No Man's Land East (Hard)
				{
					name: 'Zone E - No Man\'s Land East',
					minX: 3400,
					maxX: 6800,
					minY: -1400,
					maxY: 1400,
					enemyCount: 31,  // Reduced by 20% (was 39)
					enemyRadius: 26,
					triesPerEnemy: 40,
					typeRatios: {
						basic: 0.35,
						projectile: 0.20,
						boomer: 0.15,
						licker: 0.15,
						bigboy: 0.05,
						wallguy: 0.10
					},
					onEntry: (room, zone) => {
						const zoneSpawning = room.currentGameMode?.config?.zoneSpawning;
						if (!zoneSpawning) return;
						console.log('[ZoneE] Player entered - triggering horde spawn');
						zoneSpawning._spawnZoneHorde(room, zone, 'E', zoneSpawning.zoneHordeConfig.E);
						zoneSpawning._startZonePeriodicSpawning(room, zone, 'E');
					}
				},
				
				// ZONE F - Heretic Territory (Very Hard - Objective zone)
				{
					name: 'Zone F - Heretic Stronghold',
					minX: 6800,
					maxX: 10200,
					minY: -1400,
					maxY: 1400,
					enemyCount: 37,  // Reduced by 20% (was 46)
					enemyRadius: 26,
					triesPerEnemy: 40,
					typeRatios: {
						basic: 0.25,
						projectile: 0.20,
						boomer: 0.15,
						licker: 0.20,
						bigboy: 0.10,
						wallguy: 0.10
					},
					onEntry: (room, zone) => {
						const zoneSpawning = room.currentGameMode?.config?.zoneSpawning;
						if (!zoneSpawning) return;
						console.log('[ZoneF] Player entered - triggering horde spawn');
						zoneSpawning._spawnZoneHorde(room, zone, 'F', zoneSpawning.zoneHordeConfig.F);
						zoneSpawning._startZonePeriodicSpawning(room, zone, 'F');
					}
				}
			]
		},
		
		// Minimal enemy count for testing (DISABLED when zone spawning active)
		enemies: {
			totalCount: 400,   // Battlefield enemies spread across zones
			enemyRadius: 26,
			triesPerEnemy: 40,
			maxRange: 11400,    // Expanded battlefield: from -10200 to +10200 with buffer
			safeZoneHalfSize: 1200,  // Protects entire New Antioch area behind wall (-12000 to -10200)
			avoidZone: {
				enabled: true,
				x: -11000,       // Center of New Antioch safe zone
				y: 0,
				radius: 1500,    // Enemies try to avoid this area
				strength: 0.7    // 70% chance to avoid when pathfinding
			},
			
			typeRatios: {
				boomer: 0,
				projectile: 0.10,
				licker: 0,
				wallguy: 0,
				basic: 0.90
			},
			
			stats: {
				boomer: {
					radius: 32,
					speedMul: 1.25,
					healthMax: 220,
					preferContact: true,
					avoidObstaclesAggressively: true,
					preferOpenSpaces: true
				},
				projectile: {
					radius: 26,
					speedMul: 1.0,
					healthMax: 100,
					preferContact: false,
					tacticMode: 'kite',
					tacticDuration: { min: 5, max: 10 }
				},
				licker: {
					radius: 26,
					speedMul: 1.0,
					healthMax: 100,
					preferContact: true
				},
				bigboy: {
					radius: 80,
					speedMul: 0.7,
					healthMax: 880,
					preferContact: true,
					avoidObstaclesAggressively: true,
					dashRange: 400,
					dashDistance: 300,
					dashDuration: 0.3,
					dashWindupDuration: 0.8,
					dashCooldown: 0,
					dashWindup: 0,
					isDashing: false
				},
				wallguy: {
					radius: 28,
					speedMul: 0.8,
					healthMax: 300,
					preferContact: true,
					rotationSpeed: Math.PI / 4.3,
					shieldWidth: 80,
					shieldDepth: 20,
					attackInterval: 3.0,
					attackRange: 600
				},
			basic: {
				radius: 26,
				speedMul: 1.0,
				healthMax: 100,
				preferContact: true
			}
		},
		
		// Currency drop rates per enemy type (same as extraction mode)
		dropRates: {
			boomer: {
				ducats: { chance: 0.5, min: 5, max: 15 },
				bloodMarkers: { chance: 0.5, min: 1, max: 3 }
			},
			projectile: {
				ducats: { chance: 0.5, min: 3, max: 10 },
				bloodMarkers: { chance: 0.5, min: 1, max: 2 }
			},
			licker: {
				ducats: { chance: 0.5, min: 3, max: 10 },
				bloodMarkers: { chance: 0.5, min: 1, max: 2 }
			},
			bigboy: {
				ducats: { chance: 0.6, min: 8, max: 20 },
				bloodMarkers: { chance: 0.6, min: 2, max: 4 }
			},
			basic: {
				ducats: { chance: 0.5, min: 2, max: 8 },
				bloodMarkers: { chance: 0.5, min: 1, max: 1 }
			},
			boss: {
				ducats: { chance: 1.0, min: 50, max: 100 },
				bloodMarkers: { chance: 1.0, min: 10, max: 20 }
			}
		}
	},
	
	loot: {
		clearance: 28,
		
		// Gold chest spawns on RIGHT side (Heretic Legions territory)
		goldChest: {
				preferredPosition: { x: 5000, y: 0 },  // Deep in Heretic territory (right side)
				fallbackSearchRadius: { min: 100, max: 300 },
				fallbackTries: 300,
				dropCount: 0  // Gold chest spawns artifact, not loot drops
			},
			
		// Brown chests scattered across the battlefield and inside both zones
		brownChestCount: 25,  // Regular brown chests scattered across map (reduced from 50)
		brownChestDropCount: 2,
		minDistanceFromSpawn: 300,  // Allow closer to spawn for zone coverage
			maxDistanceFromSpawn: 11000,  // Cover entire map width
			minDistanceBetweenChests: 250,  // Prevent clustering
			maxPlacementTries: 100
		},
		
		npcs: {
			types: ['NPC_A', 'NPC_B'],
			radius: 24,
			maxDistanceFromGold: 500,
			tries: 700,
			minDistanceFromChest: 6,
			minDistanceFromOtherNPC: 6
		},
		
	timers: {
		ready: 10.0,
		extraction: 60.0,  // 1 minute to open chest
		extractionZone: 20.0  // 20 seconds to complete extraction
	}
	}
};

static get(modeType) {
		return this.configs[modeType] || this.configs.test;
	}

	static exists(modeType) {
		return !!this.configs[modeType];
	}
}

// Export for both browser and Node.js
if (typeof module !== 'undefined' && module.exports) {
	module.exports = GameModeConfigs;
} else {
	window.GameModeConfigs = GameModeConfigs;
}

