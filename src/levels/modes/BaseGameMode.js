// Base Game Mode Class
// All game modes inherit from this class
// Contains default implementations for spawn computation and game logic

// Import ZoneSpawner if in Node.js environment
let ZoneSpawner = null;
if (typeof require !== 'undefined') {
	try {
		const zoneSpawnerModule = require('../../server/game/ZoneSpawner');
		ZoneSpawner = zoneSpawnerModule.ZoneSpawner;
	} catch (e) {
		console.log('[BaseGameMode] ZoneSpawner not available (client-side or missing module)');
	}
}

class BaseGameMode {
	constructor(room, config) {
		this.room = room;
		this.config = config;
		
		// Initialize zone spawner if configured
		if (ZoneSpawner && config.zoneSpawning && config.zoneSpawning.enabled) {
			this.zoneSpawner = new ZoneSpawner(room, config.zoneSpawning);
			console.log(`[BaseGameMode] ===== ZONE SPAWNER ENABLED =====`);
			console.log(`[BaseGameMode] Mode: ${config.name}`);
			console.log(`[BaseGameMode] Initial horde enabled: ${config.zoneSpawning.initialHorde?.enabled || false}`);
			console.log(`[BaseGameMode] Zones defined: ${config.zoneSpawning.zones?.length || 0}`);
		} else {
			this.zoneSpawner = null;
			console.log(`[BaseGameMode] Zone spawning NOT enabled for ${config.name}`);
			if (!ZoneSpawner) console.log(`[BaseGameMode] ZoneSpawner class not available`);
			if (!config.zoneSpawning) console.log(`[BaseGameMode] No zoneSpawning config found`);
			if (config.zoneSpawning && !config.zoneSpawning.enabled) console.log(`[BaseGameMode] zoneSpawning.enabled is false`);
		}
	}

	// Called when level starts
	onLevelStart() {
		console.log(`[GameMode] ${this.config.name} started`);
		
		// Initialize zone spawner if present
		if (this.zoneSpawner) {
			this.zoneSpawner.onLevelStart();
		}
	}

	// Called when level ends
	onLevelEnd(result) {
		console.log(`[GameMode] ${this.config.name} ended:`, result);
	}

	// Compute enemy spawn positions and types
	// Extracted from server.js _computeEnemySpawns() (line 1962-2011)
	computeEnemySpawns(environment, rng) {
		try {
			if (!environment) return [];
			
			// Skip initial enemy spawning if using zone-based spawning
			if (this.zoneSpawner) {
				console.log('[BaseGameMode] Zone spawning enabled, skipping initial enemy spawn');
				return [];
			}
			
			const cfg = this.config.enemies;
			const max = cfg.maxRange;
			const enemyRadius = cfg.enemyRadius;
			const triesPerEnemy = cfg.triesPerEnemy;
			const totalCount = cfg.totalCount;
			const halfSafe = cfg.safeZoneHalfSize;
			
			const list = [];
			const sx = environment.spawnSafeX || 0;
			const sy = environment.spawnSafeY || 0;

			const isClear = (x, y) => {
				if (!environment.isInsideBounds(x, y, enemyRadius)) return false;
				if (environment.circleHitsAny && environment.circleHitsAny(x, y, enemyRadius)) return false;
				if (Math.abs(x - sx) <= halfSafe + enemyRadius && Math.abs(y - sy) <= halfSafe + enemyRadius) return false;
				return true;
			};

			for (let n = 0; n < totalCount; n++) {
				let placed = false;
				for (let t = 0; t < triesPerEnemy && !placed; t++) {
					const x = rng.randomFloat(-max, max);
					const y = rng.randomFloat(-max, max);
					if (isClear(x, y)) {
				const id = `enemy_${this.room.nextEnemyId++}`;
				
				// Determine enemy type based on config ratios
				const roll = rng.random();
				let type = 'basic';
				const ratios = cfg.typeRatios;
				
				if (roll < ratios.boomer) {
					type = 'boomer';
				} else if (roll < ratios.boomer + ratios.projectile) {
					type = 'projectile';
				} else if (roll < ratios.boomer + ratios.projectile + ratios.licker) {
					type = 'licker';
				} else if (roll < ratios.boomer + ratios.projectile + ratios.licker + (ratios.bigboy || 0)) {
					type = 'bigboy';
				} else if (roll < ratios.boomer + ratios.projectile + ratios.licker + (ratios.bigboy || 0) + (ratios.wallguy || 0)) {
					type = 'wallguy';
				}
				// else remains 'basic'
				
				list.push({ id, x, y, type });
						placed = true;
					}
				}
			}
			return list;
		} catch (e) {
			console.error('[BaseGameMode] Failed to compute enemy spawns:', e);
			return [];
		}
	}

	// Initialize enemy stats based on type
	// Extracted from server.js enemy initialization (line 1612-1640)
	initializeEnemyStats(enemy) {
		const cfg = this.config.enemies.stats;
		const stats = cfg[enemy.type] || cfg.basic;
		
		// Apply stats from config
		enemy.radius = stats.radius;
		enemy.speedMul = stats.speedMul;
		enemy.healthMax = stats.healthMax;
		enemy.health = stats.healthMax;
		enemy.alive = true;
		
		// Type-specific attributes
		if (enemy.type === 'boomer') {
			enemy.preferContact = stats.preferContact;
			enemy.avoidObstaclesAggressively = stats.avoidObstaclesAggressively;
			enemy.preferOpenSpaces = stats.preferOpenSpaces;
		} else if (enemy.type === 'projectile') {
			enemy.preferContact = stats.preferContact;
			// Initialize tactical behavior state
			enemy._tacticMode = stats.tacticMode;
			const duration = stats.tacticDuration;
			enemy._tacticTimer = duration.min + Math.random() * (duration.max - duration.min);
			enemy._tacticDuration = enemy._tacticTimer;
		} else if (enemy.type === 'licker') {
			enemy.preferContact = stats.preferContact;
		} else if (enemy.type === 'bigboy') {
			enemy.preferContact = stats.preferContact;
			enemy.avoidObstaclesAggressively = stats.avoidObstaclesAggressively;
			// Initialize dash attack state
			enemy.dashRange = stats.dashRange;
			enemy.dashDistance = stats.dashDistance;
			enemy.dashDuration = stats.dashDuration;
			enemy.dashWindupDuration = stats.dashWindupDuration;
			enemy.dashCooldown = stats.dashCooldown || 0;
			enemy.dashWindup = stats.dashWindup || 0;
			enemy.isDashing = stats.isDashing || false;
			enemy.dashTarget = null;
		} else if (enemy.type === 'wallguy') {
			enemy.preferContact = stats.preferContact;
			enemy.rotationSpeed = stats.rotationSpeed || (Math.PI / 3);
			enemy.shieldAngle = 0;
			enemy._attackCooldown = 0;
			enemy._attackInterval = stats.attackInterval || 3.0;
			enemy._attackRange = stats.attackRange || 600;
			enemy._rotationTarget = 0;
		} else {
			// basic
			enemy.preferContact = stats.preferContact;
		}
		
		// Initialize knockback state for all enemies
		enemy.kbTime = 0;
		enemy.kbVelX = 0;
		enemy.kbVelY = 0;
	}

	// Compute loot (chest) spawn positions
	// Extracted from server.js _computeLevelSpawns() (line 1884-1959)
	computeLootSpawns(environment, rng) {
		try {
			if (!environment) return { chests: [] };
			
			const cfg = this.config.loot;
			const clearance = cfg.clearance;
			const chests = [];
			
			let goldX = null, goldY = null;
			
			// Try preferred test location
			const testX = cfg.goldChest.preferredPosition.x;
			const testY = cfg.goldChest.preferredPosition.y;
			const isClear = (x, y, r) => environment.isInsideBounds(x, y, r) && !environment.circleHitsAny(x, y, r);
			
			if (isClear(testX, testY, clearance)) {
				goldX = testX;
				goldY = testY;
			} else {
				// Fallback: search around origin
				const tries = cfg.goldChest.fallbackTries;
				const minDist = cfg.goldChest.fallbackSearchRadius.min;
				const maxDist = cfg.goldChest.fallbackSearchRadius.max;
				
				for (let i = 0; i < tries; i++) {
					const ang = rng.randomFloat(0, Math.PI * 2);
					const dist = minDist + rng.randomFloat(0, maxDist);
					const nx = Math.cos(ang) * dist;
					const ny = Math.sin(ang) * dist;
					if (isClear(nx, ny, clearance)) {
						goldX = nx;
						goldY = ny;
						break;
					}
				}
			}
			
			if (goldX == null || goldY == null) return { chests: [] };
			
			// Push gold chest
			chests.push({
				id: `${Math.round(goldX)},${Math.round(goldY)}`,
				x: goldX,
				y: goldY,
				variant: 'gold'
			});
			
			// Brown chest near gold
			const brownCfg = cfg.brownChest;
			for (let j = 0; j < brownCfg.tries; j++) {
				const ang2 = rng.randomFloat(0, Math.PI * 2);
				const d2 = brownCfg.distanceFromGold.min + rng.randomFloat(0, brownCfg.additionalDistance);
				const nx2 = goldX + Math.cos(ang2) * d2;
				const ny2 = goldY + Math.sin(ang2) * d2;
				if (isClear(nx2, ny2, clearance)) {
					chests.push({
						id: `${Math.round(nx2)},${Math.round(ny2)}`,
						x: nx2,
						y: ny2,
						variant: 'brown'
					});
					break;
				}
			}
			
			return { chests, goldX, goldY };
		} catch (e) {
			console.error('[BaseGameMode] Failed to compute loot spawns:', e);
			return { chests: [] };
		}
	}

	// Compute NPC spawn positions
	// Extracted from server.js _computeLevelSpawns() (line 1923-1954)
	computeNPCSpawns(environment, rng, lootSpawns) {
		try {
			if (!environment || !lootSpawns || !lootSpawns.goldX || !lootSpawns.goldY) {
				return [];
			}
			
			const cfg = this.config.npcs;
			const goldX = lootSpawns.goldX;
			const goldY = lootSpawns.goldY;
			const chests = lootSpawns.chests;
			
			const npcs = [];
			const maxDist = cfg.maxDistanceFromGold;
			const npcR = cfg.radius;
			const triesNpc = cfg.tries;
			const types = cfg.types;
			
			const isClear = (x, y, r) => environment.isInsideBounds(x, y, r) && !environment.circleHitsAny(x, y, r);
			
			let placedCount = 0;
			
			for (let t = 0; t < triesNpc && placedCount < types.length; t++) {
				const ang = rng.randomFloat(0, Math.PI * 2);
				const dist = rng.randomFloat(0, maxDist);
				const tx = goldX + Math.cos(ang) * dist;
				const ty = goldY + Math.sin(ang) * dist;
				
				if (!isClear(tx, ty, npcR)) continue;
				
				// Avoid overlapping any chest
				let okChest = true;
				for (let k = 0; k < chests.length; k++) {
					const c = chests[k];
					const cr = 20;
					const dx = tx - c.x;
					const dy = ty - c.y;
					if (dx * dx + dy * dy <= (cr + npcR + cfg.minDistanceFromChest) * (cr + npcR + cfg.minDistanceFromChest)) {
						okChest = false;
						break;
					}
				}
				if (!okChest) continue;
				
				// Avoid overlapping prior NPC
				let okNpc = true;
				for (let k = 0; k < npcs.length; k++) {
					const n = npcs[k];
					const dx = tx - n.x;
					const dy = ty - n.y;
					if (dx * dx + dy * dy <= (npcR + (n.radius || 24) + cfg.minDistanceFromOtherNPC) * (npcR + (n.radius || 24) + cfg.minDistanceFromOtherNPC)) {
						okNpc = false;
						break;
					}
				}
				if (!okNpc) continue;
				
				// Place NPC
				npcs.push({
					type: types[placedCount],
					x: tx,
					y: ty,
					radius: npcR
				});
				placedCount++;
			}
			
			return npcs;
		} catch (e) {
			console.error('[BaseGameMode] Failed to compute NPC spawns:', e);
			return [];
		}
	}

	// Per-frame update - override in subclasses for mode-specific logic
	update(deltaTime) {
		// Update zone spawner if present
		if (this.zoneSpawner) {
			this.zoneSpawner.update(deltaTime);
		}
	}

	// Check win condition - override in subclasses
	checkWinCondition() {
		return null;
	}

	// Check lose condition - override in subclasses
	checkLoseCondition() {
		return null;
	}
}

// Export for Node.js
if (typeof module !== 'undefined' && module.exports) {
	module.exports = BaseGameMode;
}


