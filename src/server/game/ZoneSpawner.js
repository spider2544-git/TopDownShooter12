// ============================================================================
// ZONE SPAWNER - Location-based progressive enemy spawning
// ============================================================================
// Spawns enemies in predefined zones with progressive difficulty and density.
// Pre-spawns next zone when players approach to ensure enemies are ready.
// Fully server-authoritative for multiplayer synchronization.

class ZoneSpawner {
	constructor(room, zoneConfig = {}) {
		this.room = room;
		this.config = zoneConfig;
		
		// Zone definitions (array of zone configs)
		this.zones = zoneConfig.zones || [];
		
		// Track which zones have been spawned
		this.spawnedZones = new Set();
		
		// Track which zones players have entered
		this.enteredZones = new Set();
		
		// Pre-spawn settings
		this.preSpawnDistance = zoneConfig.preSpawnDistance || 2000;  // Distance to trigger next zone spawn
		this.checkInterval = zoneConfig.checkInterval || 1000;  // Check every 1 second
		this._lastCheck = 0;
		
		console.log(`[ZoneSpawner] Initialized with ${this.zones.length} zones, pre-spawn distance: ${this.preSpawnDistance}`);
	}
	
	/**
	 * Initialize spawner - spawn Zone A enemies on level start
	 */
	onLevelStart() {
		console.log('[ZoneSpawner] Level started, scheduling delayed spawns');
		this.spawnedZones.clear();
		this.enteredZones.clear();
		this._lastCheck = Date.now();
		
		// Spawn initial horde with delay to ensure clients have completed scene transition
		// Scene transition clears enemies, so we must spawn AFTER that completes
		if (this.config.initialHorde && this.config.initialHorde.enabled) {
			setTimeout(() => {
				console.log('[ZoneSpawner] Delayed initial horde spawn (post scene transition)');
				this.spawnInitialHorde();
			}, 1000);  // 1 second delay for scene transition
		}
		
		// Spawn Zone A with delay to ensure it spawns after scene transition
		if (this.zones.length > 0) {
			setTimeout(() => {
				console.log('[ZoneSpawner] Delayed Zone A spawn (post scene transition)');
				this.spawnZone(0);
			}, 1500);  // 1.5 second delay
		}
	}
	
	/**
	 * Update loop - check player positions and spawn zones as needed
	 */
	update(deltaTime) {
		const now = Date.now();
		if (now - this._lastCheck < this.checkInterval) return;
		this._lastCheck = now;
		
		// Get all alive player positions
		const players = Array.from(this.room.players.values()).filter(p => p && p.health > 0);
		if (players.length === 0) return;
		
		// Initialize occupation tracking if needed
		if (!this._currentlyOccupied) {
			this._currentlyOccupied = new Set();
		}
		
		// Initialize re-entry cooldown tracking
		// This prevents rapid zone boundary oscillation from triggering multiple entry events
		if (!this._zoneEntryCooldowns) {
			this._zoneEntryCooldowns = new Map();
		}
		const REENTRY_COOLDOWN_MS = 30000; // 30 second cooldown before re-entry can trigger events
		
		// Check each zone
		for (let i = 0; i < this.zones.length; i++) {
			const zone = this.zones[i];
			const playersInZone = this._anyPlayerInZone(players, zone);
			const wasOccupied = this._currentlyOccupied.has(i);
			
			if (playersInZone && !wasOccupied) {
				// Players just entered this zone
				this._currentlyOccupied.add(i);
				
				// Track for first-time entry (for ambient spawns)
				if (!this.enteredZones.has(i)) {
					this.enteredZones.add(i);
				}
				
				console.log(`[ZoneSpawner] Players entered zone ${i} (${zone.name})`);
				
				// Check re-entry cooldown before triggering entry events
				const lastEntryTime = this._zoneEntryCooldowns.get(i) || 0;
				const timeSinceLastEntry = now - lastEntryTime;
				
				if (timeSinceLastEntry >= REENTRY_COOLDOWN_MS) {
					// Trigger zone entry event (starts horde spawning)
					if (zone.onEntry) {
						zone.onEntry(this.room, zone);
					}
					this._zoneEntryCooldowns.set(i, now);
				} else {
					console.log(`[ZoneSpawner] Zone ${i} re-entry cooldown active (${((REENTRY_COOLDOWN_MS - timeSinceLastEntry) / 1000).toFixed(1)}s remaining), skipping onEntry`);
				}
			} else if (!playersInZone && wasOccupied) {
				// Players just left this zone
				this._currentlyOccupied.delete(i);
				console.log(`[ZoneSpawner] Players left zone ${i} (${zone.name})`);
			}
			
			// Pre-spawn next zone when players approach current zone
			const nextZoneIndex = i + 1;
			if (nextZoneIndex < this.zones.length && !this.spawnedZones.has(nextZoneIndex)) {
				if (this._anyPlayerNearZone(players, zone, this.preSpawnDistance)) {
					console.log(`[ZoneSpawner] Players approaching zone ${i}, pre-spawning zone ${nextZoneIndex}`);
					this.spawnZone(nextZoneIndex);
				}
			}
		}
	}
	
	/**
	 * Spawn initial horde (e.g., zombies attacking defensive turrets)
	 */
	spawnInitialHorde() {
		const hordeCfg = this.config.initialHorde;
		if (!hordeCfg || !hordeCfg.enabled) {
			console.log(`[ZoneSpawner] Initial horde not configured or disabled`);
			return;
		}
		
		console.log(`[ZoneSpawner] ===== SPAWNING INITIAL HORDE =====`);
		console.log(`[ZoneSpawner] Count: ${hordeCfg.count} zombies`);
		console.log(`[ZoneSpawner] Spawn area:`, hordeCfg.spawnArea);
		
		const rng = this.room._rng(this.room.worldSeed + 9999); // Use different seed offset
		const spawned = [];
		const area = hordeCfg.spawnArea;
		
		// If clustering near gaps, prefer those positions
		const clusterNearGaps = hordeCfg.clusterNearGaps && hordeCfg.gapPositions;
		
		for (let n = 0; n < hordeCfg.count; n++) {
			let placed = false;
			
			for (let tries = 0; tries < 50 && !placed; tries++) {
				let x, y;
				
				// 70% chance to cluster near gaps if configured
				if (clusterNearGaps && rng() < 0.7) {
					const gap = hordeCfg.gapPositions[Math.floor(rng() * hordeCfg.gapPositions.length)];
					const angle = rng() * Math.PI * 2;
					const dist = rng() * gap.radius;
					x = gap.x + Math.cos(angle) * dist;
					y = gap.y + Math.sin(angle) * dist;
					
					// Ensure still within spawn area bounds
					x = Math.max(area.minX, Math.min(area.maxX, x));
					y = Math.max(area.minY, Math.min(area.maxY, y));
				} else {
					// Random position in spawn area
					x = rng() * (area.maxX - area.minX) + area.minX;
					y = rng() * (area.maxY - area.minY) + area.minY;
				}
				
				if (this._isValidSpawnPosition(x, y, 26)) {
					const id = `enemy_${this.room.nextEnemyId++}`;
					const type = this._pickEnemyType(hordeCfg.typeRatios, rng);
					
					const enemy = {
						id,
						x,
						y,
						type,
						radius: 26,
						health: 100,
						healthMax: 100,
						speedMul: 1.0,
						alive: true,
						_spawnedFrom: 'initialHorde',
						_zoneName: 'Initial Assault'
					};
					
					// Initialize stats using game mode
					if (this.room.currentGameMode) {
						this.room.currentGameMode.initializeEnemyStats(enemy);
					}
					
					this.room.enemies.set(id, enemy);
					spawned.push(enemy);
					placed = true;
				}
			}
		}
		
		// Broadcast spawn to ALL clients
		if (spawned.length > 0) {
			console.log(`[ZoneSpawner] Broadcasting ${spawned.length} initial horde enemies to all clients`);
			this.room.spawnAmbientBatch(spawned);
		}
		
		console.log(`[ZoneSpawner] ===== INITIAL HORDE COMPLETE =====`);
		console.log(`[ZoneSpawner] Successfully spawned: ${spawned.length}/${hordeCfg.count} zombies`);
	}
	
	/**
	 * Spawn all enemies for a specific zone
	 * Server-authoritative: uses room's seeded RNG for deterministic spawning
	 */
	spawnZone(zoneIndex) {
		if (zoneIndex < 0 || zoneIndex >= this.zones.length) return;
		if (this.spawnedZones.has(zoneIndex)) {
			console.log(`[ZoneSpawner] Zone ${zoneIndex} already spawned, skipping`);
			return;
		}
		
		const zone = this.zones[zoneIndex];
		console.log(`[ZoneSpawner] Spawning zone ${zoneIndex}: ${zone.name} (${zone.enemyCount} enemies)`);
		
		// Use deterministic seeded RNG for multiplayer synchronization
		const rng = this.room._rng(this.room.worldSeed + 1000 + zoneIndex);
		const spawned = [];
		
		// Spawn enemies within zone bounds
		for (let n = 0; n < zone.enemyCount; n++) {
			let placed = false;
			for (let tries = 0; tries < zone.triesPerEnemy && !placed; tries++) {
				const x = rng() * (zone.maxX - zone.minX) + zone.minX;
				const y = rng() * (zone.maxY - zone.minY) + zone.minY;
				
				if (this._isValidSpawnPosition(x, y, zone.enemyRadius)) {
					const id = `enemy_${this.room.nextEnemyId++}`;
					const type = this._pickEnemyType(zone.typeRatios, rng);
					
					const enemy = {
						id,
						x,
						y,
						type,
						radius: zone.enemyRadius || 26,
						health: 100,
						healthMax: 100,
						speedMul: 1.0,
						alive: true,
						_spawnedFrom: 'zone',
						_zoneIndex: zoneIndex,
						_zoneName: zone.name
					};
					
					// Initialize stats using game mode
					if (this.room.currentGameMode) {
						this.room.currentGameMode.initializeEnemyStats(enemy);
					}
					
					this.room.enemies.set(id, enemy);
					spawned.push(enemy);
					placed = true;
				}
			}
		}
		
		// Broadcast spawn to ALL clients using existing infrastructure
		if (spawned.length > 0) {
			this.room.spawnAmbientBatch(spawned);
		}
		
		this.spawnedZones.add(zoneIndex);
		console.log(`[ZoneSpawner] Zone ${zoneIndex} (${zone.name}) spawned: ${spawned.length}/${zone.enemyCount} enemies placed`);
		
		// Log type distribution for debugging
		const typeCounts = {};
		spawned.forEach(e => {
			typeCounts[e.type] = (typeCounts[e.type] || 0) + 1;
		});
		console.log(`[ZoneSpawner] Zone ${zoneIndex} type distribution:`, typeCounts);
	}
	
	/**
	 * Check if any player is inside a zone
	 * Uses exclusive upper bound (< instead of <=) to prevent players from being
	 * detected in two zones simultaneously at shared boundaries
	 */
	_anyPlayerInZone(players, zone) {
		for (const p of players) {
			// Use exclusive upper bounds to prevent overlap at zone boundaries
			if (p.x >= zone.minX && p.x < zone.maxX && p.y >= zone.minY && p.y < zone.maxY) {
				return true;
			}
		}
		return false;
	}
	
	/**
	 * Check if any player is within distance of a zone boundary
	 */
	_anyPlayerNearZone(players, zone, distance) {
		for (const p of players) {
			// Calculate distance to zone (using closest point on zone rectangle)
			const closestX = Math.max(zone.minX, Math.min(p.x, zone.maxX));
			const closestY = Math.max(zone.minY, Math.min(p.y, zone.maxY));
			const dx = p.x - closestX;
			const dy = p.y - closestY;
			const dist = Math.sqrt(dx * dx + dy * dy);
			
			if (dist <= distance) {
				return true;
			}
		}
		return false;
	}
	
	/**
	 * Validate spawn position (check environment bounds, obstacles, and player distance)
	 */
	_isValidSpawnPosition(x, y, radius) {
		const env = this.room.environment;
		if (!env) return false;
		
		// Add clearance padding to match Director movement collision (max is 16 for ambush mode)
		// This prevents enemies from spawning too close to obstacles and getting stuck
		const MOVEMENT_CLEARANCE = 16;
		const spawnRadius = radius + MOVEMENT_CLEARANCE;
		
		if (!env.isInsideBounds(x, y, spawnRadius)) return false;
		if (env.circleHitsAny && env.circleHitsAny(x, y, spawnRadius)) return false;
		
		// Check minimum distance from all players to prevent spawning on top of them
		const MIN_PLAYER_DISTANCE = 700;
		for (const [, p] of this.room.players) {
			if (!p || p.health <= 0) continue;
			const dx = x - (p.x || 0);
			const dy = y - (p.y || 0);
			if (dx * dx + dy * dy < MIN_PLAYER_DISTANCE * MIN_PLAYER_DISTANCE) {
				return false;
			}
		}
		
		return true;
	}
	
	/**
	 * Pick enemy type based on zone's type ratios
	 * Uses same logic as AmbientSpawner for consistency
	 */
	_pickEnemyType(ratios, rng) {
		const r = rng();
		let acc = 0;
		const order = ['boomer', 'projectile', 'licker', 'bigboy', 'wallguy', 'basic'];
		
		for (const type of order) {
			const prob = ratios[type] || 0;
			acc += prob;
			if (r < acc) return type;
		}
		
		return 'basic';
	}
	
	/**
	 * Get debug information
	 */
	getDebugState() {
		return {
			totalZones: this.zones.length,
			spawnedZones: Array.from(this.spawnedZones),
			enteredZones: Array.from(this.enteredZones),
			nextZoneToSpawn: this._getNextUnspawnedZone()
		};
	}
	
	_getNextUnspawnedZone() {
		for (let i = 0; i < this.zones.length; i++) {
			if (!this.spawnedZones.has(i)) return i;
		}
		return null;
	}
}

module.exports = { ZoneSpawner };

