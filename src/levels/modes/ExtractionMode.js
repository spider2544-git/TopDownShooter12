// Extraction Mode
// CUSTOM: 1 gold chest (artifact) + 200 brown chests (loot) scattered across map

const BaseGameMode = require('./BaseGameMode.js');

class ExtractionMode extends BaseGameMode {
	constructor(room, config) {
		super(room, config);
		
		// Initialize phase timer state
		this.phaseTimer = {
			currentPhase: 'search',  // 'search', 'guard', or 'wave'
			timeElapsed: 0,
			searchDuration: config.phases?.search?.duration || 120,
			guardDuration: config.phases?.guard?.duration || 60,
			currentWave: 0,  // Which wave we're on (0 = no wave yet, 1-4 for waves)
			lastWaveAnnounced: 0
		};
		
		// Horde spawning state
		this.hordeState = {
			lastSpawnTime: 0,
			nextSpawnTime: 0,
			spawnedThisPhase: 0,
			lastDifficulty: null,
			lastSpawnCount: 0,
			hordeCountAtDifficulty: 0,  // Number of hordes spawned at current difficulty
			totalHordeCount: 0,  // Total hordes spawned this level (never resets)
			suppressSpawning: false  // Set to true when players are near boss
		};
		
		// Track players near boss for spawn suppression
		this.playersNearBoss = new Set();
	}
	
	// Called when level starts
	onLevelStart() {
		console.log(`[ExtractionMode] Level started - Search phase begins (${this.phaseTimer.searchDuration}s)`);
		this.phaseTimer.currentPhase = 'search';
		this.phaseTimer.timeElapsed = 0;
		this.phaseTimer.currentWave = 0;
		this.phaseTimer.lastWaveAnnounced = 0;
		
		// Reset horde state for new level
		this.hordeState.lastSpawnTime = Date.now();  // Start timer immediately
		this.hordeState.nextSpawnTime = 0;
		this.hordeState.spawnedThisPhase = 0;
		this.hordeState.lastDifficulty = null;
		this.hordeState.lastSpawnCount = 0;
		this.hordeState.hordeCountAtDifficulty = 0;
		this.hordeState.totalHordeCount = 0;
		this.hordeState.suppressSpawning = false;
		this.playersNearBoss.clear();
		
		// Broadcast initial phase state to all clients
		this._broadcastPhaseState(true);  // Force initial broadcast
	}
	
	// Per-frame update
	update(deltaTime) {
		super.update(deltaTime);
		
		this.phaseTimer.timeElapsed += deltaTime;
		
		// Check for phase transition from Search to Guard
		if (this.phaseTimer.currentPhase === 'search') {
			if (this.phaseTimer.timeElapsed >= this.phaseTimer.searchDuration) {
				this._transitionToGuard();
			}
		}
		// Check for phase transition from Guard to Wave 1
		else if (this.phaseTimer.currentPhase === 'guard') {
			if (this.phaseTimer.timeElapsed >= this.phaseTimer.guardDuration) {
				this._transitionToWave(1);
			}
		}
		// In Wave phase, check for next wave transitions
		else if (this.phaseTimer.currentPhase === 'wave') {
			this._checkWaveTransitions();
		}
		
		// Update boss proximity state
		this._updateBossProximity();
		
		// Phase-based horde spawning
		if (!this.hordeState.suppressSpawning) {
			this._updateHordeSpawning(deltaTime);
		}
		
		// Broadcast phase state periodically (throttled in method)
		this._broadcastPhaseState();
	}
	
	_transitionToGuard() {
		console.log(`[ExtractionMode] Transitioning from Search to Guard phase (${this.phaseTimer.guardDuration}s)`);
		this.phaseTimer.currentPhase = 'guard';
		this.phaseTimer.timeElapsed = 0;  // Reset timer for Guard phase
		this.phaseTimer.currentWave = 0;
		
		// Reset horde spawn timer for new phase
		this.hordeState.nextSpawnTime = 0;
		this.hordeState.spawnedThisPhase = 0;
		
		// Broadcast phase transition
		this._broadcastPhaseState(true);  // Force immediate broadcast
		
		// Emit server event for phase change
		if (this.room && this.room.io) {
			this.room.io.to(this.room.id).emit('phase_change', {
				phase: 'guard'
			});
		}
	}
	
	_transitionToWave(waveNum) {
		console.log(`[ExtractionMode] Transitioning to Wave ${waveNum}`);
		this.phaseTimer.currentPhase = 'wave';
		this.phaseTimer.timeElapsed = 0;  // Reset timer for wave duration
		this.phaseTimer.currentWave = waveNum;
		
		// Reset horde spawn timer for new wave
		this.hordeState.nextSpawnTime = 0;
		this.hordeState.spawnedThisPhase = 0;
		
		// Broadcast phase transition
		this._broadcastPhaseState(true);
		
		// Emit server event for wave start
		if (this.room && this.room.io) {
			this.room.io.to(this.room.id).emit('wave_start', {
				wave: waveNum
			});
		}
	}
	
	_checkWaveTransitions() {
		const waves = this.config.phases?.waves || [];
		const currentWaveIndex = this.phaseTimer.currentWave - 1;  // 0-based index
		
		if (currentWaveIndex < 0 || currentWaveIndex >= waves.length) return;
		
		const currentWaveDuration = waves[currentWaveIndex].duration;
		
		// Check if current wave duration has elapsed (Infinity means never auto-advance)
		if (Number.isFinite(currentWaveDuration) && this.phaseTimer.timeElapsed >= currentWaveDuration) {
			const nextWave = this.phaseTimer.currentWave + 1;
			
			// Check if there's a next wave
			if (nextWave <= waves.length) {
				this._transitionToWave(nextWave);
			} else {
				// All waves completed
				console.log('[ExtractionMode] All waves completed!');
				// Could transition to another phase or end state here
			}
		}
	}
	
	_broadcastPhaseState(force = false) {
		if (!this.room || !this.room.io) return;
		
		// Store last broadcast time to throttle updates (but allow more frequent for smooth countdown)
		const now = Date.now();
		if (!force && this._lastPhaseBroadcast && (now - this._lastPhaseBroadcast) < 50) {
			return;  // Don't broadcast more than once per 50ms unless forced (20Hz update rate)
		}
		this._lastPhaseBroadcast = now;
		
		// Calculate time since last horde spawn (or level start if no hordes yet)
		const timeSinceLastHorde = (now - this.hordeState.lastSpawnTime) / 1000;
		
		const state = {
			phase: this.phaseTimer.currentPhase,
			timeElapsed: this.phaseTimer.timeElapsed,
			currentWave: this.phaseTimer.currentWave,
			searchDuration: this.phaseTimer.searchDuration,
			guardDuration: this.phaseTimer.guardDuration,
			waves: (this.config.phases?.waves || []).map(w => ({ duration: w.duration, label: w.label })),
			timeSinceLastHorde: timeSinceLastHorde
		};
		
		this.room.io.to(this.room.id).emit('phase_timer_update', state);
	}
	
	// Check if golden chest can be damaged/targeted by enemies
	// Chest is invulnerable until a player starts opening it
	// Chest becomes vulnerable once opening starts, and remains vulnerable after opened
	isChestVulnerable(chest) {
		if (!chest || chest.variant !== 'gold') return false;
		// Only vulnerable while being opened, or after it has been opened
		if (chest.opening || chest.opened) return true;
		return false;
	}

	// Override chest spawning: spawn 1 gold chest (for artifact) + 200 brown chests (for loot)
	computeLootSpawns(environment, rng) {
		try {
			if (!environment) return { chests: [] };
			
			const cfg = this.config.loot;
			const chests = [];
			const clearance = cfg.clearance;
			const isClear = (x, y, r) => environment.isInsideBounds(x, y, r) && !environment.circleHitsAny(x, y, r);
			
			let goldX = null, goldY = null;
			
			// 1. Spawn GOLD CHEST first (required for artifact/extraction objective)
			const testX = cfg.goldChest.preferredPosition.x;
			const testY = cfg.goldChest.preferredPosition.y;
			
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
			
			if (goldX == null || goldY == null) {
				console.error('[ExtractionMode] Failed to place gold chest!');
				return { chests: [] };
			}
			
			// Push gold chest (artifact container)
			chests.push({
				id: `${Math.round(goldX)},${Math.round(goldY)}`,
				x: goldX,
				y: goldY,
				variant: 'gold',
				dropCount: 0  // Gold chest spawns artifact, not loot
			});
			
			console.log(`[ExtractionMode] Placed gold chest at (${goldX.toFixed(0)}, ${goldY.toFixed(0)})`);
			
		// 2. Spawn 200 BROWN CHESTS scattered across map (loot)
		const brownCount = cfg.brownChestCount || 200;
		const minDistFromSpawn = cfg.minDistanceFromSpawn || 500;
		const minBetween = cfg.minDistanceBetweenChests || 150;
		const triesPerChest = cfg.maxPlacementTries || 100;
		
		// Use rectangular bounds across entire map instead of polar coordinates
		// Map boundary is 11000, stay 500 units away from walls
		const mapMin = -10500;
		const mapMax = 10500;
		
		console.log(`[ExtractionMode] Spawning ${brownCount} brown chests across full map (${mapMin} to ${mapMax})`);
		
		for (let i = 0; i < brownCount; i++) {
			let placed = false;
			
			for (let t = 0; t < triesPerChest && !placed; t++) {
				// Random position using uniform rectangular distribution across entire map
				const x = rng.randomFloat(mapMin, mapMax);
				const y = rng.randomFloat(mapMin, mapMax);
				
				// Check minimum distance from spawn point (center)
				const distFromSpawn = Math.sqrt(x * x + y * y);
				if (distFromSpawn < minDistFromSpawn) continue;
				
				// Check if clear
				if (!isClear(x, y, clearance)) continue;
				
				// Check minimum distance from other chests (including gold)
				let tooClose = false;
				for (let j = 0; j < chests.length; j++) {
					const dx = x - chests[j].x;
					const dy = y - chests[j].y;
					const dist = Math.sqrt(dx * dx + dy * dy);
					if (dist < minBetween) {
						tooClose = true;
						break;
					}
				}
				
				if (tooClose) continue;
				
			// Randomize drop count: 1/7 chance for 2 drops, otherwise 1 drop
			const dropCount = rng.randomFloat(0, 1) < (1 / 7) ? 2 : 1;
			
			// Place brown chest with custom drop count
			// IMPORTANT: ID format must match what client generates: `${Math.round(x)},${Math.round(y)}`
			chests.push({
				id: `${Math.round(x)},${Math.round(y)}`,
				x: x,
				y: y,
				variant: 'brown',
				dropCount: dropCount  // Server will use this for drop generation (1 or 2)
			});
			placed = true;
			}
		}
			
			console.log(`[ExtractionMode] Successfully placed 1 gold + ${chests.length - 1}/${brownCount} brown chests`);
			
			// Return chests with gold chest position as reference (for NPC spawning)
			return {
				chests: chests,
				goldX: goldX,
				goldY: goldY
			};
			
		} catch (e) {
			console.error('[ExtractionMode] Failed to compute loot spawns:', e);
			return { chests: [] };
		}
	}

	// Override NPC spawning: spawn NPCs away from key zones
	computeNPCSpawns(environment, rng, lootSpawns) {
		try {
			if (!environment || !lootSpawns) {
				return [];
			}
			
			const cfg = this.config.npcs;
			const goldX = lootSpawns.goldX || 0;
			const goldY = lootSpawns.goldY || 0;
			const chests = lootSpawns.chests || [];
			
			const npcs = [];
			const npcR = cfg.radius;
			const types = cfg.types;
			
			// Define zones to avoid (approximate, since extraction zones spawn after artifact pickup)
			// We'll avoid spawn area (0,0 +/- 750) and gold chest area
			const avoidZones = [
				{ x: 0, y: 0, radius: 750 },           // Player spawn area
				{ x: goldX, y: goldY, radius: 600 },   // Gold chest area (wider berth)
			];
			
			// Estimate extraction zone positions (they spawn 2800-5200 from gold)
			// Add 4 quadrants around gold chest where extraction zones might spawn
			const extractionDist = 4000; // Average of 2800-5200
			for (let i = 0; i < 4; i++) {
				const angle = (i * Math.PI / 2); // 0, 90, 180, 270 degrees
				avoidZones.push({
					x: goldX + Math.cos(angle) * extractionDist,
					y: goldY + Math.sin(angle) * extractionDist,
					radius: 800  // Wide berth around potential extraction zones
				});
			}
			
			// isClear checks both environment bounds AND obstacles (circleHitsAny)
			const isClear = (x, y, r) => environment.isInsideBounds(x, y, r) && !environment.circleHitsAny(x, y, r);
			
			const isAwayFromZones = (x, y, minDist = 0) => {
				for (const zone of avoidZones) {
					const dx = x - zone.x;
					const dy = y - zone.y;
					const dist = Math.sqrt(dx * dx + dy * dy);
					if (dist < zone.radius + minDist) {
						return false;
					}
				}
				return true;
			};
			
			let placedCount = 0;
			const maxTries = 1000; // More tries since we have many constraints
			
			// Try to place NPCs in safe areas of the map
			for (let t = 0; t < maxTries && placedCount < types.length; t++) {
				// Spawn NPCs in a ring between 1000-3000 units from map center
				// This keeps them accessible but away from key areas
				const angle = rng.randomFloat(0, Math.PI * 2);
				const distance = rng.randomFloat(1000, 3000);
				const tx = Math.cos(angle) * distance;
				const ty = Math.sin(angle) * distance;
				
				// Check environment clearance (bounds + obstacles)
				if (!isClear(tx, ty, npcR)) continue;
				
				// Check if away from avoid zones
				if (!isAwayFromZones(tx, ty, 200)) continue;
				
				// Avoid overlapping any chest
				let okChest = true;
				for (const c of chests) {
					const dx = tx - c.x;
					const dy = ty - c.y;
					const dist = Math.sqrt(dx * dx + dy * dy);
					if (dist < 150) { // 150 unit clearance from chests
						okChest = false;
						break;
					}
				}
				if (!okChest) continue;
				
				// Avoid overlapping other NPCs
				let okNpc = true;
				for (const n of npcs) {
					const dx = tx - n.x;
					const dy = ty - n.y;
					const dist = Math.sqrt(dx * dx + dy * dy);
					if (dist < 100) { // 100 unit spacing between NPCs
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
				console.log(`[ExtractionMode] Placed NPC ${types[placedCount-1]} at (${tx.toFixed(0)}, ${ty.toFixed(0)})`);
			}
			
			if (placedCount < types.length) {
				console.warn(`[ExtractionMode] Only placed ${placedCount}/${types.length} NPCs`);
			}
			
			return npcs;
		} catch (e) {
			console.error('[ExtractionMode] Failed to compute NPC spawns:', e);
			return [];
		}
	}
	
	// ============================================================================
	// HORDE SPAWNING SYSTEM
	// ============================================================================
	
	// Check if players are near boss and suppress spawning
	_updateBossProximity() {
		const boss = this._findBoss();
		if (!boss || !boss.alive) {
			this.hordeState.suppressSpawning = false;
			this.playersNearBoss.clear();
			return;
		}
		
		const bossAggroRange = 1200;  // Range at which boss aggros
		let anyPlayerNearBoss = false;
		
		for (const [pid, player] of this.room.players) {
			if (!player || player.health <= 0) continue;
			
			const dx = player.x - boss.x;
			const dy = player.y - boss.y;
			const dist = Math.sqrt(dx * dx + dy * dy);
			
			if (dist <= bossAggroRange) {
				anyPlayerNearBoss = true;
				this.playersNearBoss.add(pid);
			} else {
				this.playersNearBoss.delete(pid);
			}
		}
		
		// Suppress spawning if any player is near boss
		const wasSuppressed = this.hordeState.suppressSpawning;
		this.hordeState.suppressSpawning = anyPlayerNearBoss;
		
		if (!wasSuppressed && anyPlayerNearBoss) {
			console.log('[ExtractionMode] Suppressing horde spawns - boss combat active');
		} else if (wasSuppressed && !anyPlayerNearBoss) {
			console.log('[ExtractionMode] Resuming horde spawns - boss combat ended');
		}
	}
	
	_findBoss() {
		if (!this.room.enemies) return null;
		for (const [id, enemy] of this.room.enemies) {
			if (enemy && enemy.alive && enemy.type === 'boss') {
				return enemy;
			}
		}
		return null;
	}
	
	_updateHordeSpawning(deltaTime) {
		if (!this.room.hordeSpawner) return;
		
		const now = Date.now();
		const cfg = this.config.hordeSpawning;
		if (!cfg) return;
		
		let phaseCfg = null;
		
		// Determine current phase config
		if (this.phaseTimer.currentPhase === 'search') {
			phaseCfg = cfg.search;
		} else if (this.phaseTimer.currentPhase === 'guard') {
			phaseCfg = cfg.guard;
		} else if (this.phaseTimer.currentPhase === 'wave') {
			const waveIndex = Math.min(this.phaseTimer.currentWave - 1, cfg.waves.length - 1);
			if (waveIndex >= 0) {
				phaseCfg = cfg.waves[waveIndex];
			}
		}
		
		if (!phaseCfg || !phaseCfg.enabled) return;
		
		// Initialize next spawn time if needed
		if (this.hordeState.nextSpawnTime === 0) {
			const interval = phaseCfg.intervalMin + Math.random() * (phaseCfg.intervalMax - phaseCfg.intervalMin);
			this.hordeState.nextSpawnTime = now + interval;
			console.log(`[ExtractionMode] Next horde spawn in ${(interval / 1000).toFixed(1)}s`);
			return;
		}
		
		// Check if it's time to spawn
		if (now < this.hordeState.nextSpawnTime) return;
		
		// Count current alive HORDE enemies only (not initial level spawns)
		let aliveEnemyCount = 0;
		for (const [id, enemy] of this.room.enemies) {
			if (enemy && enemy.alive && enemy.type !== 'boss' && enemy._spawnedFrom === 'horde') {
				aliveEnemyCount++;
			}
		}
		
		// Check if we're at enemy cap
		const targetMax = phaseCfg.targetEnemyCount?.max || 100;
		if (aliveEnemyCount >= targetMax) {
			console.log(`[ExtractionMode] Skipping horde spawn - at enemy cap (${aliveEnemyCount}/${targetMax})`);
			// Try again in 5 seconds
			this.hordeState.nextSpawnTime = now + 5000;
			return;
		}
		
		// Spawn horde(s)
		if (phaseCfg.perPlayerHordes) {
			// Spawn hordes targeting individual players
			this._spawnPlayerTargetedHordes(phaseCfg);
		} else {
			// Spawn horde targeting objective
			this._spawnObjectiveHorde(phaseCfg);
		}
		
		// Schedule next spawn
		const interval = phaseCfg.intervalMin + Math.random() * (phaseCfg.intervalMax - phaseCfg.intervalMin);
		this.hordeState.nextSpawnTime = now + interval;
		this.hordeState.lastSpawnTime = now;
	}
	
	_spawnPlayerTargetedHordes(phaseCfg) {
		const alivePlayers = Array.from(this.room.players.values()).filter(p => p && p.health > 0);
		if (alivePlayers.length === 0) return;
		
		// Spawn 1 horde per player
		for (const player of alivePlayers) {
			const difficulty = this._getDifficultyForPhase(phaseCfg);
			
			if (this.room.hordeSpawner) {
				const targetInfo = this.room.hordeSpawner._getTargetInfoForPlayer(player);
				const preset = this.room.hordeSpawner.config.DIFFICULTY_PRESETS[difficulty];
				
				if (targetInfo && preset) {
					// Scale horde size by player count (more players = bigger hordes)
					const playerScale = Math.sqrt(alivePlayers.length);
					const scaledSize = Math.round(preset.size * playerScale);
					
					// Use room.spawnHorde() instead of hordeSpawner.spawnHorde() 
					// This ensures proper broadcast to clients
					const result = this.room.spawnHorde(scaledSize, {
						typeRatios: preset.typeRatios,
						minRadius: preset.spawnRadius.min,
						maxRadius: preset.spawnRadius.max,
						escortRadius: preset.escortRadius,
						_targetInfo: targetInfo
					});
					
				if (result) {
					// Track difficulty changes and reset counter
					if (this.hordeState.lastDifficulty !== difficulty) {
						this.hordeState.hordeCountAtDifficulty = 1;
						this.hordeState.lastDifficulty = difficulty;
					} else {
						this.hordeState.hordeCountAtDifficulty++;
					}
					this.hordeState.totalHordeCount++;  // Increment total counter
					this.hordeState.lastSpawnCount = result.enemies.length;
					this.hordeState.lastSpawnTime = Date.now();  // Update spawn time
					this._broadcastHordeSpawn(difficulty, result.enemies.length, this.hordeState.totalHordeCount);
					console.log(`[ExtractionMode] Spawned player-targeted horde #${this.hordeState.totalHordeCount} (difficulty ${difficulty}, ${result.enemies.length} enemies) near player ${player.id.substring(0, 8)}`);
				}
				}
			}
		}
	}
	
	_spawnObjectiveHorde(phaseCfg) {
		const difficulty = this._getDifficultyForPhase(phaseCfg);
		
		if (this.room.hordeSpawner) {
			const preset = this.room.hordeSpawner.config.DIFFICULTY_PRESETS[difficulty];
			
			if (preset) {
				const alivePlayers = Array.from(this.room.players.values()).filter(p => p && p.health > 0);
				const playerScale = Math.sqrt(alivePlayers.length || 1);
				const scaledSize = Math.round(preset.size * playerScale);
				
				// Use room.spawnHorde() instead of hordeSpawner.spawnHorde()
				// This ensures proper broadcast to clients
				const result = this.room.spawnHorde(scaledSize, {
					typeRatios: preset.typeRatios,
					minRadius: preset.spawnRadius.min,
					maxRadius: preset.spawnRadius.max,
					escortRadius: preset.escortRadius
				});
				
			if (result) {
				// Track difficulty changes and reset counter
				if (this.hordeState.lastDifficulty !== difficulty) {
					this.hordeState.hordeCountAtDifficulty = 1;
					this.hordeState.lastDifficulty = difficulty;
				} else {
					this.hordeState.hordeCountAtDifficulty++;
				}
				this.hordeState.totalHordeCount++;  // Increment total counter
				this.hordeState.lastSpawnCount = result.enemies.length;
				this.hordeState.lastSpawnTime = Date.now();  // Update spawn time
				this._broadcastHordeSpawn(difficulty, result.enemies.length, this.hordeState.totalHordeCount);
				console.log(`[ExtractionMode] Spawned objective horde #${this.hordeState.totalHordeCount} (difficulty ${difficulty}, ${result.enemies.length} enemies)`);
			}
			}
		}
	}
	
	_getDifficultyForPhase(phaseCfg) {
		if (typeof phaseCfg.difficulty === 'number') {
			return phaseCfg.difficulty;
		} else if (phaseCfg.difficulty && phaseCfg.difficulty.min !== undefined) {
			const min = phaseCfg.difficulty.min;
			const max = phaseCfg.difficulty.max;
			return min + Math.floor(Math.random() * (max - min + 1));
		}
		return 5; // Default
	}
	
	_broadcastHordeSpawn(difficulty, count, hordeNumber) {
		if (this.room && this.room.io) {
			this.room.io.to(this.room.id).emit('horde_spawned', {
				difficulty: difficulty,
				count: count,
				hordeNumber: hordeNumber,
				phase: this.phaseTimer.currentPhase,
				timeSinceLastHorde: 0  // Reset timer on new spawn
			});
		}
	}
	
	// Handler for chest opening
	onChestOpening(chest) {
		if (chest.variant !== 'gold') return;
		
		const cfg = this.config.hordeSpawning?.onChestOpen;
		if (!cfg || !cfg.enabled) return;
		
		console.log('[ExtractionMode] Golden chest opened, spawning bonus hordes');
		
		if (!this.room.hordeSpawner) return;
		
		// Spawn multiple hordes around the chest
		for (let i = 0; i < cfg.spawnCount; i++) {
			const difficulty = cfg.difficulty || 5;
			const preset = this.room.hordeSpawner.config.DIFFICULTY_PRESETS[difficulty];
			
			if (preset) {
				// Use room.spawnHorde() instead of hordeSpawner.spawnHorde()
				// This ensures proper broadcast to clients
				const result = this.room.spawnHorde(preset.size, {
					typeRatios: preset.typeRatios,
					minRadius: preset.spawnRadius.min,
					maxRadius: preset.spawnRadius.max,
					escortRadius: preset.escortRadius
				});
				
			if (result) {
				// Track difficulty changes and reset counter
				if (this.hordeState.lastDifficulty !== difficulty) {
					this.hordeState.hordeCountAtDifficulty = 1;
					this.hordeState.lastDifficulty = difficulty;
				} else {
					this.hordeState.hordeCountAtDifficulty++;
				}
				this.hordeState.totalHordeCount++;  // Increment total counter
				this.hordeState.lastSpawnTime = Date.now();  // Update spawn time
				this._broadcastHordeSpawn(difficulty, result.enemies.length, this.hordeState.totalHordeCount);
				console.log(`[ExtractionMode] Spawned chest-opening horde #${this.hordeState.totalHordeCount} ${i + 1}/${cfg.spawnCount} (difficulty ${difficulty}, ${result.enemies.length} enemies)`);
			}
			}
		}
	}
	
	// Handler for extraction zone activation - progressive wave spawning
	onExtractionStart(timerType) {
		const cfg = this.config.hordeSpawning?.onExtractionStart;
		if (!cfg || !cfg.enabled) return;
		
		// Only spawn for normal extraction, skip heretic
		if (cfg.normalOnly && timerType === 'heretic') {
			console.log('[ExtractionMode] Heretic extraction - skipping horde spawn');
			return;
		}
		
		console.log(`[ExtractionMode] ${timerType} extraction started, spawning progressive hordes`);
		
		if (!this.room.hordeSpawner) return;
		if (!cfg.waves || !Array.isArray(cfg.waves)) return;
		
		// Spawn waves in sequence with delays
		let cumulativeDelay = 0;
		cfg.waves.forEach((wave, index) => {
			cumulativeDelay += wave.delay || 0;
			
			setTimeout(() => {
				// Check if extraction is still active
				if (!this.room.extractionTimer.started) {
					console.log(`[ExtractionMode] Extraction cancelled, skipping wave ${index + 1}`);
					return;
				}
				
				const preset = this.room.hordeSpawner.config.DIFFICULTY_PRESETS[wave.difficulty];
				if (!preset) return;
				
				// Get extraction zone position for targeting
				const timerType = this.room.extractionTimer.type || 'normal';
				const zone = timerType === 'heretic' ? this.room.hereticExtractionZone : this.room.extractionZone;
				if (!zone) {
					console.warn(`[ExtractionMode] No extraction zone found, skipping wave ${index + 1}`);
					return;
				}
				
				// Create target info pointing at extraction zone
				const targetInfo = {
					target: { x: zone.x, y: zone.y },
					source: 'extractionZone',
					forward: { x: 0, y: -1 }  // Default forward direction
				};
				
				// Spawn the specified number of hordes for this wave
				for (let i = 0; i < wave.count; i++) {
					const result = this.room.spawnHorde(preset.size, {
						typeRatios: preset.typeRatios,
						minRadius: 800,      // Closer for extraction pressure (normal: 1400)
						maxRadius: 1200,     // Closer for extraction pressure (normal: 1800)
						escortRadius: 400,   // Shorter distance before full aggro
						_targetInfo: targetInfo  // Target the extraction zone!
					});
					
					if (result) {
						if (this.hordeState.lastDifficulty !== wave.difficulty) {
							this.hordeState.hordeCountAtDifficulty = 1;
							this.hordeState.lastDifficulty = wave.difficulty;
						} else {
							this.hordeState.hordeCountAtDifficulty++;
						}
						this.hordeState.totalHordeCount++;
						this.hordeState.lastSpawnTime = Date.now();
						this._broadcastHordeSpawn(wave.difficulty, result.enemies.length, this.hordeState.totalHordeCount);
						console.log(`[ExtractionMode] Spawned extraction wave ${index + 1} horde #${this.hordeState.totalHordeCount} (difficulty ${wave.difficulty}, ${result.enemies.length} enemies)`);
					}
				}
			}, cumulativeDelay);
		});
	}
}

module.exports = ExtractionMode;

