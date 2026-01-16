// Trench Raid Mode
// Football field-style map: New Antioch (left) vs Heretic Legions (right)
// Objective: Retrieve artifact from right side and extract on left side

const BaseGameMode = require('./BaseGameMode.js');

class TrenchRaidMode extends BaseGameMode {
	
	// Define battlefield boundaries for enemy spawning
	getEnemySpawnBounds() {
		// Full battlefield boundaries matching zone system (A-F zones)
		// Zones span from -10200 to +10200 on X axis
		// Y axis is -1400 to +1400 (full map height)
		const leftWallX = -10200;
		const rightWallX = 10200;
		return {
			minX: leftWallX + 300,  // 300 units right of left wall = -9900
			maxX: rightWallX - 300,  // 300 units left of right wall = +9900
			minY: -1400,             // Within map height
			maxY: 1400
		};
	}
	
	// Override enemy spawning - disabled when using ZoneSpawner
	computeEnemySpawns(environment, rng) {
		// ZoneSpawner handles all enemy spawning for trench raid:
		// - Initial horde (35 basic zombies attacking turrets)
		// - Zone static spawns (A-F with progressive difficulty)
		// - Periodic zone hordes (triggered on zone entry)
		if (this.zoneSpawner) {
			console.log('[TrenchRaid] Zone spawning enabled, skipping computeEnemySpawns');
			return [];
		}
		return [];
	}
	
	// Generate defensive turrets for New Antioch wall gaps (2 per gap, 8 total)
	// Place one turret at TOP of each gap and one at BOTTOM of each gap
	getDefensiveTurrets() {
		const turrets = [];
		const newAntiochX = -10200;  // Wall position
		const turretOffset = 80;     // Distance behind wall
		const gapMargin = 50;        // Distance from gap edges
		
		// Wall segments are at y = -800, 0, +800 (each 400 units tall)
		// Wall at -800: covers -1000 to -600
		// Wall at 0: covers -200 to +200
		// Wall at 800: covers +600 to +1000
		
		// Gap 1: Top gap (from -1500 map edge to -1000 top of first wall)
		turrets.push({
			x: newAntiochX + turretOffset,
			y: -1500 + gapMargin,  // Near top edge of map
			faction: 'newantioch',
			size: 'large'
		});
		turrets.push({
			x: newAntiochX + turretOffset,
			y: -1000 - gapMargin,  // Near top of first wall
			faction: 'newantioch',
			size: 'large'
		});
		
		// Gap 2: Middle-top gap (from -600 bottom of first wall to -200 top of center wall)
		turrets.push({
			x: newAntiochX + turretOffset,
			y: -600 + gapMargin,  // Just below first wall
			faction: 'newantioch',
			size: 'large'
		});
		turrets.push({
			x: newAntiochX + turretOffset,
			y: -200 - gapMargin,  // Just above center wall
			faction: 'newantioch',
			size: 'large'
		});
		
		// Gap 3: Middle-bottom gap (from +200 bottom of center wall to +600 top of bottom wall)
		turrets.push({
			x: newAntiochX + turretOffset,
			y: 200 + gapMargin,   // Just below center wall
			faction: 'newantioch',
			size: 'large'
		});
		turrets.push({
			x: newAntiochX + turretOffset,
			y: 600 - gapMargin,   // Just above bottom wall
			faction: 'newantioch',
			size: 'large'
		});
		
		// Gap 4: Bottom gap (from +1000 bottom of last wall to +1500 map edge)
		turrets.push({
			x: newAntiochX + turretOffset,
			y: 1000 + gapMargin,  // Just below bottom wall
			faction: 'newantioch',
			size: 'large'
		});
		turrets.push({
			x: newAntiochX + turretOffset,
			y: 1500 - gapMargin,  // Near bottom edge of map
			faction: 'newantioch',
			size: 'large'
		});
		
		console.log(`[TrenchRaid] Generated ${turrets.length} defensive turrets for New Antioch gaps`);
		return turrets;
	}
	
	// Generate decorative objects for the level
	// Note: RadioTower and BatteryStation positions are now determined at runtime
	// by the server's battery system initialization (random in Zone C or D)
	getDecorations() {
		const decorations = [];
		
		// RadioTower and BatteryStation are spawned by server.js battery system
		// with random positions in Zone C or Zone D each game
		// See: server.js battery system initialization
		
		console.log(`[TrenchRaid] Decorations (RadioTower/BatteryStation) handled by server battery system`);
		return decorations;
	}
	
	// Get battery spawn configuration for the RadioTower power system
	// Note: RadioTower spawns randomly in Zone C or Zone D each game
	// Batteries spawn randomly within 750 units of the tower
	// The server validates positions against:
	// - Map bounds (battlefield area)
	// - Environment obstacles
	// - Hazards (fire, gas, barrels) - batteries AVOID these
	// - Mud and barbed wire are allowed (batteries can spawn there)
	getBatterySpawns() {
		return {
			count: 3,
			// RadioTower position is random in Zone C (-3000 to -400) or Zone D (400 to 3000)
			// Actual position determined at runtime by server.js
			maxRadius: 750,   // Max distance from radio tower
			minRadius: 300,   // Min distance from radio tower (can't be on top of it)
			minBatteryDistance: 150  // Min distance between batteries
		};
	}
	
	// Generate artillery guns for New Antioch that fire into Zone A
	// These target players in Zone A and damage enemies, players, and sandbags
	getArtilleryGuns() {
		const artilleryGuns = [];
		// Place artillery at the far left wall of New Antioch safe zone
		const artilleryX = -11800;  // Near left map edge (-12000)
		
		// Place 2 artillery guns - one upper, one lower
		// Target zone covers entire battlefield (Zone A through Zone F)
		artilleryGuns.push({
			x: artilleryX,
			y: -500,  // Upper position
			faction: 'newantioch',
			targetZone: {
				minX: -10200,  // Zone A starts at New Antioch wall
				maxX: 10200,   // Zone F ends at Heretic wall
				minY: -1400,
				maxY: 1400
			}
		});
		
		artilleryGuns.push({
			x: artilleryX,
			y: 500,   // Lower position
			faction: 'newantioch',
			targetZone: {
				minX: -10200,
				maxX: 10200,   // Zone F ends at Heretic wall
				minY: -1400,
				maxY: 1400
			}
		});
		
		console.log(`[TrenchRaid] Generated ${artilleryGuns.length} artillery guns for New Antioch at x=${artilleryX}`);
		return artilleryGuns;
	}
	
	// Get gap positions to prevent environment obstacles from spawning there
	getGapPositions() {
		const newAntiochX = -10200;
		const gapHalfWidth = 250;  // Half width of gap (500 total)
		const gapHalfHeight = 200; // Half height of gap opening
		
		return [
			// Top gap
			{
				x: newAntiochX,
				y: -300,
				width: gapHalfWidth * 2,
				height: gapHalfHeight * 2,
				clearRadius: 150  // Extra clearance around gap
			},
			// Bottom gap
			{
				x: newAntiochX,
				y: 300,
				width: gapHalfWidth * 2,
				height: gapHalfHeight * 2,
				clearRadius: 150  // Extra clearance around gap
			}
		];
	}
	
	// Generate defensive walls for both sides with gaps for passage
	getDefensiveWalls() {
		const walls = [];
		
		// New Antioch defensive line (1800 units from left edge: -12000 + 1800 = -10200)
		const newAntiochX = -10200;
		const gapSize = 500;  // Size of gaps to pass through
		const wallThickness = 60;  // Wall thickness
		const wallSegmentHeight = 400;  // Wall segment height
		
		// Top wall segment (New Antioch)
		walls.push({
			x: newAntiochX,
			y: -800,
			w: wallThickness,
			h: wallSegmentHeight,
			fill: '#3a2f1a',
			stroke: '#1a1108'
		});
		
		// Middle-top gap at y = -500 to -100 (400 unit gap) - TURRET AT y = -300
		
		// Center wall segment (New Antioch)
		walls.push({
			x: newAntiochX,
			y: 0,
			w: wallThickness,
			h: wallSegmentHeight,
			fill: '#3a2f1a',
			stroke: '#1a1108'
		});
		
		// Middle-bottom gap at y = 100 to 500 (400 unit gap) - TURRET AT y = +300
		
		// Bottom wall segment (New Antioch)
		walls.push({
			x: newAntiochX,
			y: 800,
			w: wallThickness,
			h: wallSegmentHeight,
			fill: '#3a2f1a',
			stroke: '#1a1108'
		});
		
		// Heretic Legions defensive line (1800 units from right edge: +12000 - 1800 = +10200)
		const hereticX = 10200;
		
		// Top wall segment (Heretic)
		walls.push({
			x: hereticX,
			y: -800,
			w: wallThickness,
			h: wallSegmentHeight,
			fill: '#4a1a1a',
			stroke: '#2a0a0a'
		});
		
		// Middle-top gap at y = -500 to -100 (400 unit gap)
		
		// Center wall segment (Heretic)
		walls.push({
			x: hereticX,
			y: 0,
			w: wallThickness,
			h: wallSegmentHeight,
			fill: '#4a1a1a',
			stroke: '#2a0a0a'
		});
		
		// Middle-bottom gap at y = 100 to 500 (400 unit gap)
		
		// Bottom wall segment (Heretic)
		walls.push({
			x: hereticX,
			y: 800,
			w: wallThickness,
			h: wallSegmentHeight,
			fill: '#4a1a1a',
			stroke: '#2a0a0a'
		});
		
	console.log(`[TrenchRaid] Generated ${walls.length} defensive wall segments`);
	return walls;
}

// Generate randomly placed and rotated trench walls in the battlefield
getTrenchWalls() {
	const walls = [];
	
	// Battlefield boundaries (between defensive walls)
	const leftWallX = -10200;
	const rightWallX = 10200;
	const battlefieldWidth = rightWallX - leftWallX;  // 20400
	
	// Map height boundaries
	const topY = -1400;
	const bottomY = 1400;
	const battlefieldHeight = bottomY - topY;  // 2800
	
	// NOTE: Keep these fairly low to avoid choking paths; spacing rules below further reduce density.
	const wallCount = 20;
	const wallLength = 700;
	const wallThickness = 60;  // Match defensive walls
	
	// Keep Zone A and Zone B walls from ever "touching" by reserving a clear corridor
	// around the Zone A/B boundary. This ensures troops always have a gap to path through.
	// Zone A: -10200..-6800, Zone B: -6800..-3400
	const ZONE_AB_BOUNDARY_X = -6800;
	const ZONE_AB_MIN_GAP = 220; // corridor half-width in world units
	
	// Minimum separation between ANY two trench walls (prevents brown walls from touching)
	const WALL_MIN_GAP = 140; // desired empty space between wall edges
	const WALL_MIN_GAP_INFLATE = WALL_MIN_GAP / 2;
	
	// Deterministic per-seed generation (server authoritative; also stabilizes navmesh caching)
	const rng = (this.room && typeof this.room._rng === 'function')
		? this.room._rng((this.room.worldSeed || 0) + 424242)
		: Math.random;
	
	console.log(`[TrenchWalls] Generating ${wallCount} walls with length ${wallLength} in battlefield (${leftWallX} to ${rightWallX})`);
	
	// Helper: Check if walls block path from left to right using flood fill
	// (Currently disabled via pathExists=true below; kept for future re-enable)
	const checkPathExists = (testWalls) => {
		// Test if we can get from left side to right side
		const startX = leftWallX + 500;  // Start point on left
		const endX = rightWallX - 500;    // End point on right
		const testY = 0;                  // Center height
		const stepSize = 100;             // Grid resolution
		const maxSteps = 300;             // Prevent infinite loops
		
		// Simple flood fill BFS
		const visited = new Set();
		const queue = [{x: startX, y: testY}];
		const snapToGrid = (x, y) => `${Math.floor(x/stepSize)},${Math.floor(y/stepSize)}`;
		
		visited.add(snapToGrid(startX, testY));
		let steps = 0;
		
		while (queue.length > 0 && steps < maxSteps) {
			steps++;
			const pos = queue.shift();
			
			// Check if we reached the right side
			if (pos.x >= endX) {
				return true; // Path exists!
			}
			
			// Try 8 directions
			const dirs = [
				{x: stepSize, y: 0}, {x: -stepSize, y: 0},
				{x: 0, y: stepSize}, {x: 0, y: -stepSize},
				{x: stepSize, y: stepSize}, {x: stepSize, y: -stepSize},
				{x: -stepSize, y: stepSize}, {x: -stepSize, y: -stepSize}
			];
			
			for (const dir of dirs) {
				const nx = pos.x + dir.x;
				const ny = pos.y + dir.y;
				const key = snapToGrid(nx, ny);
				
				// Skip if visited or out of bounds
				if (visited.has(key)) continue;
				if (nx < leftWallX + 300 || nx > rightWallX - 300) continue;
				if (ny < topY + 100 || ny > bottomY - 100) continue;
				
				// Check if position collides with any wall (simple circle check)
				let blocked = false;
				const checkRadius = 50; // Player-sized radius
				
				for (const wall of testWalls) {
					// Transform point to wall's local space
					const dx = nx - wall.x;
					const dy = ny - wall.y;
					const cos = Math.cos(-wall.angle);
					const sin = Math.sin(-wall.angle);
					const localX = dx * cos - dy * sin;
					const localY = dx * sin + dy * cos;
					
					// Check against AABB in local space
					const halfW = wall.w / 2;
					const halfH = wall.h / 2;
					
					// Closest point on rectangle to circle
					const closestX = Math.max(-halfW, Math.min(localX, halfW));
					const closestY = Math.max(-halfH, Math.min(localY, halfH));
					const distX = localX - closestX;
					const distY = localY - closestY;
					
					if (distX * distX + distY * distY < checkRadius * checkRadius) {
						blocked = true;
						break;
					}
				}
				
				if (!blocked) {
					visited.add(key);
					queue.push({x: nx, y: ny});
				}
			}
		}
		
		return false; // No path found
	};
	
	// Oriented-box overlap test (Separating Axis Theorem) with optional inflation.
	// If inflated boxes overlap, then original boxes are closer than ~WALL_MIN_GAP.
	const _obbOverlaps = (a, b, inflate = 0) => {
		const aHalfW = (a.w / 2) + inflate;
		const aHalfH = (a.h / 2) + inflate;
		const bHalfW = (b.w / 2) + inflate;
		const bHalfH = (b.h / 2) + inflate;
		
		const aCos = Math.cos(a.angle), aSin = Math.sin(a.angle);
		const bCos = Math.cos(b.angle), bSin = Math.sin(b.angle);
		
		// Local axes
		const aUx = aCos, aUy = aSin;
		const aVx = -aSin, aVy = aCos;
		const bUx = bCos, bUy = bSin;
		const bVx = -bSin, bVy = bCos;
		
		// Center delta
		const dx = b.x - a.x;
		const dy = b.y - a.y;
		
		// Test axis helper
		const testAxis = (ax, ay) => {
			// Project delta onto axis
			const dist = Math.abs(dx * ax + dy * ay);
			
			// Project each OBB radius onto axis
			const ra = aHalfW * Math.abs(aUx * ax + aUy * ay) + aHalfH * Math.abs(aVx * ax + aVy * ay);
			const rb = bHalfW * Math.abs(bUx * ax + bUy * ay) + bHalfH * Math.abs(bVx * ax + bVy * ay);
			
			return dist <= (ra + rb);
		};
		
		// Separating axis theorem: if ANY axis separates, they do NOT overlap
		if (!testAxis(aUx, aUy)) return false;
		if (!testAxis(aVx, aVy)) return false;
		if (!testAxis(bUx, bUy)) return false;
		if (!testAxis(bVx, bVy)) return false;
		return true;
	};
	
	// Helper: does this wall intersect the reserved A/B corridor on X?
	const _intersectsZoneABCorridor = (wall) => {
		const halfW = wall.w / 2;
		const halfH = wall.h / 2;
		const c = Math.cos(wall.angle);
		const s = Math.sin(wall.angle);
		// Projection of half-extents onto world X axis
		const xExtent = Math.abs(c) * halfW + Math.abs(s) * halfH;
		const minX = wall.x - xExtent;
		const maxX = wall.x + xExtent;
		const corridorMinX = ZONE_AB_BOUNDARY_X - ZONE_AB_MIN_GAP;
		const corridorMaxX = ZONE_AB_BOUNDARY_X + ZONE_AB_MIN_GAP;
		return maxX > corridorMinX && minX < corridorMaxX;
	};
	
	// Generate walls with validation to ensure spacing exists
	const maxAttempts = wallCount * 60; // More attempts because spacing/corridor rejections are common
	let attempts = 0;
	let corridorRejects = 0;
	let spacingRejects = 0;
	
	// Buffer zone: 1500 units from defensive walls to prevent walls from spawning too close to safe zones
	const wallBuffer = 1500;
	const spawnWidth = battlefieldWidth - (wallBuffer * 2); // Usable width for spawning
	const spawnMinX = leftWallX + wallBuffer;   // -10200 + 1500 = -8700
	const spawnMaxX = rightWallX - wallBuffer;  // +10200 - 1500 = +8700
	
	console.log(`[TrenchWalls] Spawn area: x from ${spawnMinX} to ${spawnMaxX} (width: ${spawnWidth})`);
	console.log(`[TrenchWalls] Reserving Zone A/B corridor at x=${ZONE_AB_BOUNDARY_X} with halfWidth=${ZONE_AB_MIN_GAP}`);
	console.log(`[TrenchWalls] Enforcing wall-to-wall min gap ~= ${WALL_MIN_GAP}`);
	
	for (let i = 0; i < wallCount && attempts < maxAttempts; attempts++) {
		// Random position in battlefield (leave buffer from defensive walls)
		const x = spawnMinX + rng() * (spawnMaxX - spawnMinX);
		const y = topY + 200 + rng() * (battlefieldHeight - 400);
		
		// Random angle snapped to 15 degree increments (0°, 15°, 30°, ..., 345°)
		const angleSteps = 24; // 360 / 15 = 24
		const angleStep = (Math.PI * 2) / angleSteps; // 15 degrees in radians
		const angle = Math.floor(rng() * angleSteps) * angleStep;
		
		// Vary length (1x to 2x the base length)
		const lengthMultiplier = 1 + rng(); // 1.0 to 2.0
		const finalLength = wallLength * lengthMultiplier;
		
		// Vary thickness (1x to 4x the base thickness)
		const thicknessMultiplier = 1 + rng() * 3; // 1.0 to 4.0
		const finalThickness = wallThickness * thicknessMultiplier;
		
		const candidateWall = {
			x: x,
			y: y,
			w: finalLength,      // Length of wall (varied)
			h: finalThickness,   // Thickness (varied)
			angle: angle,        // Rotation
			fill: '#3a2f1a',     // Same as New Antioch walls
			stroke: '#1a1108'    // Same as New Antioch walls
		};
		
		// Reserve a guaranteed navigable gap between Zone A and Zone B.
		if (_intersectsZoneABCorridor(candidateWall)) {
			corridorRejects++;
			continue;
		}
		
		// Enforce separation so trench walls don't touch each other anywhere.
		let tooClose = false;
		for (const w of walls) {
			if (_obbOverlaps(candidateWall, w, WALL_MIN_GAP_INFLATE)) {
				tooClose = true;
				break;
			}
		}
		if (tooClose) {
			spacingRejects++;
			continue;
		}
		
		// Test if adding this wall would block the path
		// TEMP: Disable pathfinding check for debugging
		const testWalls = [...walls, candidateWall];
		const pathExists = true; // checkPathExists(testWalls);  // TODO: Fix pathfinding
		if (pathExists) {
			walls.push(candidateWall);
			i++; // Successfully added a wall
		} else {
			// This wall would block the path, reject it and try again
			console.log(`[TrenchWalls] Rejected wall ${i} (attempt ${attempts}) - would block path`);
		}
	}
	
	console.log(`[TrenchWalls] Generated ${walls.length} trench walls (${attempts} attempts; corridorRejects=${corridorRejects}, spacingRejects=${spacingRejects})`);
	return walls;
}

// Custom NPC spawning for trench raid: spawn Prisoner in middle zone (C)
	// Instead of near the gold chest, place them in the center of the battlefield
	computeNPCSpawns(environment, rng, lootSpawns) {
		try {
			if (!environment) return [];
			
			const cfg = this.config.npcs;
			if (!cfg || !cfg.types || cfg.types.length === 0) return [];
			
			// Trench Raid: do NOT spawn the Heretic Priest (NPC_B)
			const types = (cfg.types || []).filter(t => t !== 'NPC_B'); // NPC_A = Prisoner
			const npcR = cfg.radius || 24;
			const npcs = [];
			
			// Zone C: x = -3400 to 0 (Center West)
			// Zone D: x = 0 to 3400 (Center East)
			// Y axis: -1400 to +1400
			const zoneC = { minX: -3400, maxX: -400, minY: -1200, maxY: 1200 };
			const zoneD = { minX: 400, maxX: 3400, minY: -1200, maxY: 1200 };
			
			// Minimum distance between NPCs (make them further apart)
			const minNpcDistance = 2000;
			
			const isClear = (x, y, r) => {
				if (!environment.isInsideBounds(x, y, r)) return false;
				if (environment.circleHitsAny && environment.circleHitsAny(x, y, r)) return false;
				return true;
			};
			
			// Assign zone to NPC - Prisoner (NPC_A) in Zone C
			const npcZones = [zoneC];
			
			for (let i = 0; i < types.length && i < 2; i++) {
				const zone = npcZones[i];
				const maxTries = cfg.tries || 500;
				let placed = false;
				
				for (let t = 0; t < maxTries && !placed; t++) {
					const tx = rng.randomFloat(zone.minX, zone.maxX);
					const ty = rng.randomFloat(zone.minY, zone.maxY);
					
					if (!isClear(tx, ty, npcR)) continue;
					
					// Check distance from other NPCs
					let tooClose = false;
					for (const other of npcs) {
						const dx = tx - other.x;
						const dy = ty - other.y;
						const dist = Math.sqrt(dx * dx + dy * dy);
						if (dist < minNpcDistance) {
							tooClose = true;
							break;
						}
					}
					if (tooClose) continue;
					
					// Place NPC
					npcs.push({
						type: types[i],
						x: tx,
						y: ty,
						radius: npcR
					});
					placed = true;
					console.log(`[TrenchRaid] Placed ${types[i]} at (${tx.toFixed(0)}, ${ty.toFixed(0)}) in Zone C`);
				}
				
				if (!placed) {
					// Fallback: place at zone center
					const fallbackX = (zone.minX + zone.maxX) / 2;
					const fallbackY = 0;
					npcs.push({
						type: types[i],
						x: fallbackX,
						y: fallbackY,
						radius: npcR
					});
					console.warn(`[TrenchRaid] Used fallback position for ${types[i]} at (${fallbackX}, ${fallbackY})`);
				}
			}
			
			console.log(`[TrenchRaid] Spawned ${npcs.length} NPCs in middle zones (C and D)`);
			return npcs;
			
		} catch (e) {
			console.error('[TrenchRaid] Failed to compute NPC spawns:', e);
			return [];
		}
	}
	
	// Custom loot spawning for trench raid: gold chest on right side (Heretic Legions territory) + brown chests scattered
	computeLootSpawns(environment, rng) {
		try {
			if (!environment) return { chests: [] };
			
			const cfg = this.config.loot;
			const clearance = cfg.clearance;
			const chests = [];
			
			// Define heretic region behind their walls (right side)
			const hereticWallX = 10200;  // Heretic defensive wall
			const mapEdgeX = 12000;      // Right map edge
			const mapMinY = -1500;       // Top map edge
			const mapMaxY = 1500;        // Bottom map edge
			
			// Gold chest spawns centrally in heretic back area (away from walls)
			const zoneCenter = (hereticWallX + mapEdgeX) / 2;
			const zoneWidth = 800; // Constrain to center strip
			
			const goldSpawnMinX = zoneCenter - (zoneWidth / 2);
			const goldSpawnMaxX = zoneCenter + (zoneWidth / 2);
			// Narrow vertical range to keep chest central (approx -500 to +500)
			// This ensures the Witch spawning at edges (+/- 1400) is off-screen but in range
			const goldSpawnMinY = -500;
			const goldSpawnMaxY = 500;
			
			const isClear = (x, y, r) => {
				if (!environment.isInsideBounds(x, y, r)) return false;
				if (environment.circleHitsAny && environment.circleHitsAny(x, y, r)) return false;
				return true;
			};
			
			// Try to spawn gold chest in random location in heretic back area
			let finalGoldX = 0;
			let finalGoldY = 0;
			let placed = false;
			const maxTries = cfg.goldChest.fallbackTries || 300;
			
			for (let i = 0; i < maxTries && !placed; i++) {
				const testX = rng.randomFloat(goldSpawnMinX, goldSpawnMaxX);
				const testY = rng.randomFloat(goldSpawnMinY, goldSpawnMaxY);
				
				if (isClear(testX, testY, clearance)) {
					finalGoldX = testX;
					finalGoldY = testY;
					placed = true;
					break;
				}
			}
			
			// Fallback to center of heretic region if no clear spot found
			if (!placed) {
				console.warn('[TrenchRaid] Could not find clear spot for gold chest after', maxTries, 'tries, using fallback position');
				finalGoldX = (goldSpawnMinX + goldSpawnMaxX) / 2;
				finalGoldY = 0;
			}
			
			chests.push({
				id: `${Math.round(finalGoldX)},${Math.round(finalGoldY)}`,
				x: finalGoldX,
				y: finalGoldY,
				variant: 'gold'
			});
			
			console.log(`[TrenchRaid] Gold chest spawned randomly at (${finalGoldX.toFixed(0)}, ${finalGoldY.toFixed(0)}) in heretic back area`);
			
			// 1.5. Spawn STARTING GEAR CHESTS (one per player) in New Antioch safe zone
			// These chests contain exactly one orange item for players to trade at start
			const playerCount = this.room?.players?.size || 1;
			const startingGearX = -11000;  // New Antioch spawn area
			const startingGearY = -600;    // Above spawn point
			const chestSpacing = 200;      // Space between chests
			
			// Calculate starting X to center the line of chests
			const totalWidth = (playerCount - 1) * chestSpacing;
			const lineStartX = startingGearX - (totalWidth / 2);
			
			for (let i = 0; i < playerCount; i++) {
				const chestX = lineStartX + (i * chestSpacing);
				const chestY = startingGearY;
				
				// Use position-based ID format to match client expectations
				const chestId = `${Math.round(chestX)},${Math.round(chestY)}`;
				
				chests.push({
					id: chestId,
					x: chestX,
					y: chestY,
					variant: 'startGear',  // Special variant for guaranteed orange
					dropCount: 1  // Only 1 item per chest
				});
			}
			
			console.log(`[TrenchRaid] Spawned ${playerCount} starting gear chests in line at (${startingGearX.toFixed(0)}, ${startingGearY.toFixed(0)})`);
			
			// 2. Spawn BROWN CHESTS scattered across the entire map including zones
			const brownCount = cfg.brownChestCount || 50;
			const minDistFromSpawn = cfg.minDistanceFromSpawn || 300;
			const minBetween = cfg.minDistanceBetweenChests || 250;
			const triesPerChest = cfg.maxPlacementTries || 100;
			
			// Define spawn boundaries for entire map including zones
			const mapLeftEdge = -12000;
			const mapRightEdge = 12000;
			const newAntiochWallX = -10200;
			
			// Get player spawn position for distance check
			const spawnX = this.config.spawn?.x || -11000;
			const spawnY = this.config.spawn?.y || 0;
			
			const brownChestList = [];
			
			for (let c = 0; c < brownCount; c++) {
				let chestPlaced = false;
				
				for (let t = 0; t < triesPerChest && !chestPlaced; t++) {
					// Spawn anywhere across the entire map width
					const testX = rng.randomFloat(mapLeftEdge + 200, mapRightEdge - 200);
					const testY = rng.randomFloat(mapMinY + 100, mapMaxY - 100);
					
					// Check distance from spawn point
					const dxSpawn = testX - spawnX;
					const dySpawn = testY - spawnY;
					const distFromSpawn = Math.sqrt(dxSpawn * dxSpawn + dySpawn * dySpawn);
					if (distFromSpawn < minDistFromSpawn) continue;
					
					// Check distance from gold chest
					const dxGold = testX - finalGoldX;
					const dyGold = testY - finalGoldY;
					const distFromGold = Math.sqrt(dxGold * dxGold + dyGold * dyGold);
					if (distFromGold < 200) continue;  // Don't spawn too close to gold chest
					
					// Check clearance with environment
					if (!isClear(testX, testY, clearance)) continue;
					
					// Check distance from other brown chests
					let tooClose = false;
					for (let i = 0; i < brownChestList.length; i++) {
						const other = brownChestList[i];
						const dx = testX - other.x;
						const dy = testY - other.y;
						const dist = Math.sqrt(dx * dx + dy * dy);
						if (dist < minBetween) {
							tooClose = true;
							break;
						}
					}
				if (tooClose) continue;
				
				// Randomize drop count: 1/7 chance for 2 drops, otherwise 1 drop (like extraction mode)
				const dropCount = rng.randomFloat(0, 1) < (1 / 7) ? 2 : 1;
				
				// Valid position found - use position-based ID to match client expectations
				const brownChest = {
					id: `${Math.round(testX)},${Math.round(testY)}`,
					x: testX,
					y: testY,
					variant: 'brown',
					dropCount: dropCount  // Server will use this for drop generation (1 or 2)
				};
				
				brownChestList.push(brownChest);
				chests.push(brownChest);
				chestPlaced = true;
				}
			}
			
			console.log(`[TrenchRaid] Placed ${brownChestList.length}/${brownCount} brown chests across map`);
			
			return {
				chests: chests,
				goldX: finalGoldX,
				goldY: finalGoldY
			};
			
		} catch (e) {
			console.error('[TrenchRaid] Failed to compute loot spawns:', e);
			return { chests: [] };
		}
	}
	
	// Spawn extraction zone on LEFT side (New Antioch) - appears after artifact pickup
	computeExtractionZone(environment, rng) {
		if (!this.config.extraction) {
			console.warn('[TrenchRaid] No extraction config found');
			return null;
		}
		
		const ex = this.config.extraction;
		console.log(`[TrenchRaid] Creating extraction zone at (${ex.x}, ${ex.y}) with radius ${ex.radius}`);
		
		return {
			x: ex.x,       // -2500 (left side)
			y: ex.y,       // 0 (center)
			radius: ex.radius  // 300
		};
	}
	
	// Spawn Artillery Witch near the top or bottom edge so she's within artillery range
	computeBossSpawn(environment, rng, goldX, goldY, extractionX, extractionY, refPlayerX, refPlayerY) {
		try {
			const bossRadius = 78;
			
			// Map vertical bounds are roughly -1500 to 1500
			// We want to spawn near the edge, but within range (~1500) of the chest/players
			const mapTopY = -1400;
			const mapBottomY = 1400;
			
			// Determine which edge is closer to the chest to ensure she's in range
			// If chest is central (near 0), either edge works.
			// If chest is high (negative Y), top edge is closer.
			let targetBaseY;
			if (Math.abs(goldY) < 300) {
				// Chest is central, pick random edge
				targetBaseY = (rng.random() < 0.5) ? mapTopY : mapBottomY;
			} else {
				// Pick the closer edge
				targetBaseY = (goldY < 0) ? mapTopY : mapBottomY;
			}
			
			const maxTries = 50;
			
			// Try to spawn along the chosen edge, aligned with chest X
			for (let i = 0; i < maxTries; i++) {
				const testX = goldX + rng.randomFloat(-400, 400); // Vary X around chest
				const testY = targetBaseY + rng.randomFloat(-100, 100); // Vary Y near edge
				
				// Check if position is valid
				if (!environment.isInsideBounds(testX, testY, bossRadius)) continue;
				if (environment.circleHitsAny && environment.circleHitsAny(testX, testY, bossRadius)) continue;
				
				// Valid position found
				console.log(`[TrenchRaid] Artillery Witch spawn: (${testX.toFixed(0)}, ${testY.toFixed(0)}) - near ${targetBaseY < 0 ? 'TOP' : 'BOTTOM'} edge`);
				return { x: testX, y: testY };
			}
			
			// Fallback: spawn directly at calculated target
			console.warn('[TrenchRaid] Could not find clear boss spawn near edge, using fallback position');
			return {
				x: goldX,
				y: targetBaseY
			};
		} catch (e) {
			console.error('[TrenchRaid] Failed to compute boss spawn:', e);
			return null;
		}
	}
	
	// Override player spawn to place on LEFT side (New Antioch spawn)
	getPlayerSpawnPosition(environment, rng) {
		if (!this.config.spawn) {
			console.warn('[TrenchRaid] No spawn config found, using default');
			return { x: 0, y: 0 };
		}
		
		const spawn = this.config.spawn;
		// Add some randomness within spawn area
		const offsetX = rng.randomFloat(-spawn.radius, spawn.radius);
		const offsetY = rng.randomFloat(-spawn.radius, spawn.radius);
		
		const spawnX = spawn.x + offsetX;  // Around -2500
		const spawnY = spawn.y + offsetY;  // Around 0
		
		console.log(`[TrenchRaid] Player spawn: (${spawnX.toFixed(0)}, ${spawnY.toFixed(0)})`);
		
		return {
			x: spawnX,
			y: spawnY
		};
	}
	
	// Handler for extraction zone activation - spawn level 7 hordes attacking past turrets
	onExtractionStart(timerType) {
		const cfg = this.config.hordeSpawning?.onExtractionStart;
		if (!cfg || !cfg.enabled) return;
		
		console.log(`[TrenchRaid] Extraction started, spawning breach hordes!`);
		
		if (!cfg.waves || !Array.isArray(cfg.waves)) return;
		
		// Spawn area - same as initial horde (in front of turrets, NOT inside New Antioch)
		const spawnArea = {
			minX: -9600,   // Outside the safe zone
			maxX: -7500,   // Spread across battlefield
			minY: -1400,   // Full map height
			maxY: 1400
		};
		
		// Get extraction zone as the goal
		const extractionZone = this.room.extractionZone;
		const goalX = extractionZone ? extractionZone.x : -11000;
		const goalY = extractionZone ? extractionZone.y : 0;
		
		// Spawn waves in sequence with delays
		let cumulativeDelay = 0;
		cfg.waves.forEach((wave, index) => {
			cumulativeDelay += wave.delay || 0;
			
			setTimeout(() => {
				// Check if extraction is still active
				if (!this.room.extractionTimer.started) {
					console.log(`[TrenchRaid] Extraction cancelled, skipping wave ${index + 1}`);
					return;
				}
				
				// Get difficulty preset for type ratios
				const zoneSpawning = this.config.zoneSpawning;
				const preset = zoneSpawning?.difficultyPresets?.[wave.difficulty] || 
					{ size: 18, typeRatios: { basic: 0.25, boomer: 0.15, projectile: 0.18, licker: 0.20, bigboy: 0.10, wallguy: 0.12 } };
				
				const hordeSize = preset.size || 18;
				const typeRatios = preset.typeRatios;
				
				// Spawn the specified number of hordes for this wave
				for (let h = 0; h < wave.count; h++) {
					const spawned = this._spawnBreachHorde(spawnArea, hordeSize, typeRatios, goalX, goalY);
					
					if (spawned.length > 0) {
						// Broadcast to clients
						this.room.spawnAmbientBatch(spawned);
						
						console.log(`[TrenchRaid] Spawned extraction breach wave ${index + 1}, horde ${h + 1}/${wave.count} (difficulty ${wave.difficulty}, ${spawned.length} enemies)`);
						
						// Broadcast horde spawn event
						this.room.io.to(this.room.id).emit('horde_spawned', {
							difficulty: wave.difficulty,
							count: spawned.length,
							hordeNumber: index + 1,
							phase: 'extraction_breach',
							timeSinceLastHorde: 0
						});
					}
				}
			}, cumulativeDelay);
		});
	}
	
	// Spawn a breach horde in the specified area, moving toward the goal
	_spawnBreachHorde(spawnArea, count, typeRatios, goalX, goalY) {
		const spawned = [];
		const rng = this.room._rng ? this.room._rng(Date.now() + Math.random() * 1e9) : Math.random;
		
		// Helper to pick enemy type based on ratios
		const pickType = (ratios) => {
			const r = typeof rng === 'function' ? rng() : Math.random();
			let acc = 0;
			const order = ['boomer', 'projectile', 'licker', 'bigboy', 'wallguy', 'basic'];
			for (const type of order) {
				acc += ratios[type] || 0;
				if (r < acc) return type;
			}
			return 'basic';
		};
		
		for (let i = 0; i < count; i++) {
			let placed = false;
			
			for (let tries = 0; tries < 50 && !placed; tries++) {
				// Random position in spawn area
				const r1 = typeof rng === 'function' ? rng() : Math.random();
				const r2 = typeof rng === 'function' ? rng() : Math.random();
				const x = spawnArea.minX + r1 * (spawnArea.maxX - spawnArea.minX);
				const y = spawnArea.minY + r2 * (spawnArea.maxY - spawnArea.minY);
				
				// Validate position
				if (!this.room.environment.isInsideBounds(x, y, 26)) continue;
				if (this.room.environment.circleHitsAny && this.room.environment.circleHitsAny(x, y, 26)) continue;
				
				const id = `enemy_${this.room.nextEnemyId++}`;
				const type = pickType(typeRatios);
				
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
					_spawnedFrom: 'extractionBreach',
					_zoneName: 'Extraction Breach',
					// Pre-aggro goal: move toward extraction zone
					_preAggroGoal: { x: goalX, y: goalY },
					_preAggroSpeed: 120
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
		
		return spawned;
	}
}

module.exports = TrenchRaidMode;

