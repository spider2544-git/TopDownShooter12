// EnvironmentHazards.js
// Server-authoritative hazard manager for Trench Raid (and future modes)
// Provides data structures, deterministic placement helpers, update tick, and serialization

const CollisionHelpers = require('../../shared/collisionHelpers');
const HazardsConfig = require('../../levels/HazardsConfig.js');

class EnvironmentHazards {
	constructor(room, environment, config = {}, modeType = 'trenchraid') {
		this.room = room;
		this.env = environment;
		this.modeType = modeType;
		
		// Load hazards config for this mode
		this.hazardsConfig = HazardsConfig.get(modeType);
		
		// Keep legacy config support for backward compatibility
		this.config = Object.assign({
			mode: 'leftRow',
			leftInset: 260,
			rowSpacing: 280
		}, config || {});

		// Hazard collections (server-authoritative)
		this.sandbags = [];
		this.barbedWire = [];
		this.mudPools = [];
		this.trenches = [];
		this.firePools = [];
		this.gasCanisters = [];
		this.artilleryGuns = []; // stub only for now
		this.explodingBarrels = []; // Red explosive barrels

		this._nextId = 1;
	}

	_resetAll() {
		this.sandbags.length = 0;
		this.barbedWire.length = 0;
		this.mudPools.length = 0;
		this.trenches.length = 0;
		this.firePools.length = 0;
		this.gasCanisters.length = 0;
		this.artilleryGuns.length = 0;
		this.explodingBarrels.length = 0;
	}

	_newId(prefix) {
		return `${prefix}_${this._nextId++}`;
	}

	/**
	 * Spawn a deterministic vertical row of hazards along the left boundary center line
	 * Order default: Sandbags, BarbedWire, Mud, Trench, Fire, ArtilleryStub
	 */
	spawnLeftEdgeRow(order, opts = {}) {
		this._resetAll();
		const env = this.env;
		const leftInset = Number.isFinite(opts.leftInset) ? opts.leftInset : this.config.leftInset;
		const rowSpacing = Number.isFinite(opts.rowSpacing) ? opts.rowSpacing : this.config.rowSpacing;

		// Compute x along left edge (supports rectangular or square bounds)
		const leftEdge = env.isRectangular ? (-env.halfWidth) : (-this.room.boundary);
		const x = leftEdge + leftInset;
		let y = 0; // start at mid-height, go downward

		const finalOrder = Array.isArray(order) && order.length > 0
			? order
			: ['sandbags', 'barbedwire', 'mud', 'trench', 'fire', 'artillery'];

		for (let i = 0; i < finalOrder.length; i++) {
			const kind = String(finalOrder[i]).toLowerCase();
			if (kind === 'sandbags') {
				const sb = {
					id: this._newId('sandbag'),
					x,
					y,
					w: 220,
					h: 36,
					health: 300,
					healthMax: 300,
					boxIndex: -1
				};
				// Add oriented box for collision/pathing (not drawn by environment)
				const oBox = { x: sb.x, y: sb.y, w: sb.w, h: sb.h, angle: 0 };
				sb.boxIndex = (this.env.orientedBoxes = this.env.orientedBoxes || []).push(oBox) - 1;
				this.sandbags.push(sb);

				// Place extra sandbags to the RIGHT of the first one for testing convenience
				const extra = Number.isFinite(this.config.extraSandbags) ? Math.max(0, Math.floor(this.config.extraSandbags)) : 3;
				const dx = 260; // horizontal spacing between sandbags
				for (let k = 0; k < extra; k++) {
					const nx = x + (k + 1) * dx;
					const sb2 = { id: this._newId('sandbag'), x: nx, y, w: 220, h: 36, health: 300, healthMax: 300, boxIndex: -1 };
					const o2 = { x: sb2.x, y: sb2.y, w: sb2.w, h: sb2.h, angle: 0 };
					sb2.boxIndex = this.env.orientedBoxes.push(o2) - 1;
					this.sandbags.push(sb2);
				}

			// === 2. VERTICAL SANDBAGS (above horizontal row) ===
			const verticalY = y - 280; // Place 280px above horizontal sandbags
			const numVariants = extra + 1; // Same count as horizontal
			
			for (let k = 0; k < numVariants; k++) {
				const vx = x + k * dx;
				const vy = verticalY;
				const sbVert = { 
					id: this._newId('sandbag'), 
					x: vx, 
					y: vy, 
					w: 48,  // Same thickness as diagonal sandbags
					h: 220, // Tall height
					health: 300, 
					healthMax: 300, 
					boxIndex: -1,
					variant: 'vertical' // Tag for client rendering
				};
				const oVert = { x: sbVert.x, y: sbVert.y, w: sbVert.w, h: sbVert.h, angle: 0 };
				sbVert.boxIndex = this.env.orientedBoxes.push(oVert) - 1;
				this.sandbags.push(sbVert);
			}

			// === 3. DIAGONAL LEFT SANDBAGS (\) - above vertical ===
			const diagLeftY = y - 560; // Place 280px above vertical
			const diagLength = 220; // Length of diagonal sandbag
			const diagThickness = 48; // Thickness perpendicular to diagonal
				
				for (let k = 0; k < numVariants; k++) {
					const dlx = x + k * dx;
					const dly = diagLeftY;
					const sbDiagL = { 
						id: this._newId('sandbag'), 
						x: dlx, 
						y: dly, 
						w: diagLength, 
						h: diagThickness, 
						health: 300, 
						healthMax: 300, 
						boxIndex: -1,
						variant: 'diagonalLeft', // Tag for client rendering
						angle: Math.PI / 4 // Store angle on sandbag for client collision
					};
					// Angled at +45 degrees (Math.PI / 4)
					const oDiagL = { x: sbDiagL.x, y: sbDiagL.y, w: sbDiagL.w, h: sbDiagL.h, angle: Math.PI / 4 };
					sbDiagL.boxIndex = this.env.orientedBoxes.push(oDiagL) - 1;
					this.sandbags.push(sbDiagL);
				}

				// === 4. DIAGONAL RIGHT SANDBAGS (/) - above diagonal left ===
				const diagRightY = y - 840; // Place 280px above diagonal left
				
				for (let k = 0; k < numVariants; k++) {
					const drx = x + k * dx;
					const dry = diagRightY;
					const sbDiagR = { 
						id: this._newId('sandbag'), 
						x: drx, 
						y: dry, 
						w: diagLength, 
						h: diagThickness, 
						health: 300, 
						healthMax: 300, 
						boxIndex: -1,
						variant: 'diagonalRight', // Tag for client rendering
						angle: -Math.PI / 4 // Store angle on sandbag for client collision
					};
					// Angled at -45 degrees (-Math.PI / 4)
					const oDiagR = { x: sbDiagR.x, y: sbDiagR.y, w: sbDiagR.w, h: sbDiagR.h, angle: -Math.PI / 4 };
					sbDiagR.boxIndex = this.env.orientedBoxes.push(oDiagR) - 1;
					this.sandbags.push(sbDiagR);
				}
				
				// Do NOT change y; other hazards must remain in their original row
		} else if (kind === 'barbedwire' || kind === 'wire') {
			// Spawn 4 barbed wire variants going to the right (inspired by WW1 military fortifications)
			const wireSpacing = 340; // horizontal spacing between variants
			const wireConfigs = [
				{ variant: 'tangled', label: 'Jumbled/Tangled Wire' },
				{ variant: 'spiral', label: 'Spiral Coil' },
				{ variant: 'tripleConcertina', label: 'Triple Concertina Fence' },
				{ variant: 'doubleApron', label: 'Double Apron Fence' }
			];

			for (let k = 0; k < wireConfigs.length; k++) {
				const wx = x + k * wireSpacing;
				const wy = y;
				const cfg = wireConfigs[k];
				
				// Generate pattern data based on variant
				const wireData = {
					id: this._newId('wire'),
					variant: cfg.variant,
					centerX: wx,
					centerY: wy,
					width: 24,
					slowMul: 0.3,
					dotHp: 1,
					tick: 0.5
				};

				// Generate geometry for each variant
				if (cfg.variant === 'tangled') {
					// Jumbled string: irregular, overlapping segments
					wireData.segments = this._generateTangledWire(wx, wy, 240, 8);
				} else if (cfg.variant === 'spiral') {
					// Spiral coil: circular helix pattern
					wireData.spiral = this._generateSpiralWire(wx, wy, 80, 3, 24);
				} else if (cfg.variant === 'tripleConcertina') {
					// Triple concertina: 3 rows of circular coils with support posts
					wireData.concertina = this._generateTripleConcertina(wx, wy, 280, 3);
				} else if (cfg.variant === 'doubleApron') {
					// Double apron: angled wire from center posts (like reference image)
					wireData.apron = this._generateDoubleApron(wx, wy, 260, 5);
				}

				this.barbedWire.push(wireData);
			}
		} else if (kind === 'mud') {
				this.mudPools.push({
					id: this._newId('mud'),
					x,
					y,
					radius: 160,
					color: '#6b4e2e'
				});
			} else if (kind === 'trench' || kind === 'crater' || kind === 'trenches') {
				this.trenches.push({
					id: this._newId('trench'),
					x: x,
					y: y,
					w: 320,
					h: 80,
					conceal: true,
					revealTimer: 0
				});
			} else if (kind === 'fire') {
				this.firePools.push({
					id: this._newId('fire'),
					x,
					y,
					radius: 200, // Match Molotov default radius
					dotDps: 20, // Match Molotov baseline DPS
					dotDuration: 3.0, // Match Molotov DOT duration
					dotTickInterval: 0.5, // Apply DOT every 0.5s
					smoke: true
				});
				
				// Spawn 7 mustard gas canisters in a randomly scattered pattern to the right
				const gasStartX = x + 450;
				const gasBaseY = y;
				const avgSpacing = 320; // Average spacing between canisters
				
				// Create base grid positions then add random offsets for natural look
				const canisterPositions = [
					// Loosely scattered across area with random offsets
					{ x: gasStartX + (Math.random() - 0.5) * 80, y: gasBaseY - 160 + (Math.random() - 0.5) * 100 },
					{ x: gasStartX + avgSpacing * 0.8 + (Math.random() - 0.5) * 120, y: gasBaseY - 200 + (Math.random() - 0.5) * 90 },
					{ x: gasStartX + avgSpacing * 1.7 + (Math.random() - 0.5) * 100, y: gasBaseY - 140 + (Math.random() - 0.5) * 110 },
					{ x: gasStartX - 80 + (Math.random() - 0.5) * 90, y: gasBaseY + 120 + (Math.random() - 0.5) * 100 },
					{ x: gasStartX + avgSpacing * 0.5 + (Math.random() - 0.5) * 110, y: gasBaseY + 180 + (Math.random() - 0.5) * 95 },
					{ x: gasStartX + avgSpacing * 1.3 + (Math.random() - 0.5) * 130, y: gasBaseY + 150 + (Math.random() - 0.5) * 105 },
					{ x: gasStartX + avgSpacing * 2.2 + (Math.random() - 0.5) * 115, y: gasBaseY + 60 + (Math.random() - 0.5) * 120 }
				];
				
				for (let i = 0; i < canisterPositions.length; i++) {
					this.gasCanisters.push({
						id: this._newId('gas'),
						x: canisterPositions[i].x,
						y: canisterPositions[i].y,
						radius: 180, // Gas cloud radius
						dotDps: 0, // No damage - visual impairment only
						dotDuration: 0,
						dotTickInterval: 0.5
					});
				}
			} else if (kind === 'artillery') {
				// Stub only; do not activate behavior in this phase
				this.artilleryGuns.push({
					id: this._newId('arty'),
					x,
					y,
					enabled: false
				});
			}
			y += rowSpacing; // next item goes further down
		}
	}

	/**
	 * Spawn sandbags using the scattered strategy from HazardsConfig
	 * Places groups of sandbags (1-4 per group) randomly across the battlefield
	 */
	spawnScatteredSandbags() {
		if (!this.hazardsConfig.enabled || !this.hazardsConfig.sandbags || !this.hazardsConfig.sandbags.enabled) {
			console.log('[Hazards] Sandbags disabled in config');
			return;
		}
		
		const cfg = this.hazardsConfig.sandbags;
		const scattered = cfg.scattered;
		const props = cfg.properties;
		const overlapRules = cfg.overlap;
		
		console.log(`[Hazards] Spawning ${scattered.groupCount} sandbag groups using scattered strategy`);
		
		// Track placed groups for distance checks
		const placedGroups = [];
		
		// Helper: Check if position is valid (clear of obstacles and safe zones)
		const isPositionValid = (x, y, clearance = scattered.obstacleClearance) => {
			// Check bounds
			if (x < scattered.bounds.minX || x > scattered.bounds.maxX) return false;
			if (y < scattered.bounds.minY || y > scattered.bounds.maxY) return false;
			
			// Check safe zones
			for (const zone of scattered.safeZones) {
				const dx = x - zone.x;
				const dy = y - zone.y;
				const distSq = dx * dx + dy * dy;
				const minDistSq = (zone.radius + scattered.safeZoneClearance) ** 2;
				if (distSq < minDistSq) return false;
			}
			
			// Check global clear zones (open areas with no hazards)
			if (this.hazardsConfig.clearZones) {
				for (const zone of this.hazardsConfig.clearZones) {
					const dx = x - zone.x;
					const dy = y - zone.y;
					const distSq = dx * dx + dy * dy;
					const minDistSq = zone.radius ** 2;
					if (distSq < minDistSq) return false;
				}
			}
			
			// Check environment obstacles
			if (this.env.circleHitsAny && this.env.circleHitsAny(x, y, clearance)) {
				return false;
			}
			
			// Check distance from other groups
			for (const group of placedGroups) {
				const dx = x - group.x;
				const dy = y - group.y;
				const distSq = dx * dx + dy * dy;
				const minDistSq = scattered.minGroupDistance ** 2;
				if (distSq < minDistSq) return false;
			}
			
			return true;
		};
		
		// Helper: Spawn a single sandbag
		const spawnSandbag = (x, y, variant) => {
			const variantProps = props[variant];
			if (!variantProps) {
				console.warn(`[Hazards] Unknown sandbag variant: ${variant}`);
				return null;
			}
			
			const sb = {
				id: this._newId('sandbag'),
				x: x,
				y: y,
				w: variantProps.w,
				h: variantProps.h,
				health: variantProps.health || 300,
				healthMax: variantProps.healthMax || 300,
				variant: variant,
				angle: variantProps.angle || 0,
				boxIndex: -1
			};
			
			// Add oriented box for collision
			const oBox = {
				x: sb.x,
				y: sb.y,
				w: sb.w,
				h: sb.h,
				angle: sb.angle
			};
			
			if (!this.env.orientedBoxes) this.env.orientedBoxes = [];
			sb.boxIndex = this.env.orientedBoxes.push(oBox) - 1;
			
			this.sandbags.push(sb);
			return sb;
		};
		
		// Attempt to place groups
		const maxAttemptsPerGroup = 50;
		let successfulGroups = 0;
		
		for (let g = 0; g < scattered.groupCount; g++) {
			let placed = false;
			
			for (let attempt = 0; attempt < maxAttemptsPerGroup && !placed; attempt++) {
				// Random position in bounds
				const groupX = scattered.bounds.minX + Math.random() * (scattered.bounds.maxX - scattered.bounds.minX);
				const groupY = scattered.bounds.minY + Math.random() * (scattered.bounds.maxY - scattered.bounds.minY);
				
				// Check if position is valid
				if (!isPositionValid(groupX, groupY, 150)) continue;
				
				// Determine which variants to spawn in this group (based on probabilities)
				const variants = [];
				if (Math.random() < scattered.groupComposition.horizontal) variants.push('horizontal');
				if (Math.random() < scattered.groupComposition.vertical) variants.push('vertical');
				if (Math.random() < scattered.groupComposition.diagonalLeft) variants.push('diagonalLeft');
				if (Math.random() < scattered.groupComposition.diagonalRight) variants.push('diagonalRight');
				
				// Ensure at least one variant
				if (variants.length === 0) {
					variants.push(['horizontal', 'vertical', 'diagonalLeft', 'diagonalRight'][Math.floor(Math.random() * 4)]);
				}
				
				// Spawn sandbags for each variant in the group
				const groupSandbags = [];
				let groupValid = true;
				
				for (let v = 0; v < variants.length; v++) {
					const variant = variants[v];
					
					// Calculate offset from group center based on variant and index
					let offsetX = 0;
					let offsetY = 0;
					
					// Arrange variants in a loose formation
					if (variant === 'horizontal') {
						offsetX = 0;
						offsetY = 0;
					} else if (variant === 'vertical') {
						offsetX = scattered.groupSpacing.horizontal * 0.6;
						offsetY = -scattered.groupSpacing.vertical * 0.4;
					} else if (variant === 'diagonalLeft') {
						offsetX = -scattered.groupSpacing.horizontal * 0.3;
						offsetY = scattered.groupSpacing.vertical * 0.5;
					} else if (variant === 'diagonalRight') {
						offsetX = scattered.groupSpacing.horizontal * 0.3;
						offsetY = scattered.groupSpacing.vertical * 0.5;
					}
					
					const sbX = groupX + offsetX;
					const sbY = groupY + offsetY;
					
					// Validate position (looser check within group)
					if (!isPositionValid(sbX, sbY, 50)) {
						groupValid = false;
						break;
					}
					
					// Spawn the sandbag
					const sb = spawnSandbag(sbX, sbY, variant);
					if (sb) groupSandbags.push(sb);
				}
				
				// If all sandbags in group were placed successfully
				if (groupValid && groupSandbags.length > 0) {
					placedGroups.push({ x: groupX, y: groupY, sandbags: groupSandbags });
					successfulGroups++;
					placed = true;
				} else {
					// Remove any sandbags we added for this failed group
					for (const sb of groupSandbags) {
						const idx = this.sandbags.indexOf(sb);
						if (idx >= 0) this.sandbags.splice(idx, 1);
						if (sb.boxIndex >= 0 && this.env.orientedBoxes) {
							this.env.orientedBoxes.splice(sb.boxIndex, 1);
							// Fix indices
							for (let i = 0; i < this.sandbags.length; i++) {
								if (this.sandbags[i].boxIndex > sb.boxIndex) {
									this.sandbags[i].boxIndex--;
								}
							}
						}
					}
				}
			}
		}
		
		console.log(`[Hazards] Successfully placed ${successfulGroups}/${scattered.groupCount} sandbag groups (${this.sandbags.length} total sandbags)`);
	}

	/**
	 * Main spawn method - routes to appropriate strategy based on config
	 */
	spawnSandbags() {
		if (!this.hazardsConfig.enabled || !this.hazardsConfig.sandbags || !this.hazardsConfig.sandbags.enabled) {
			console.log('[Hazards] Sandbags disabled');
			return;
		}
		
		const strategy = this.hazardsConfig.sandbags.strategy;
		console.log(`[Hazards] Using sandbag placement strategy: ${strategy}`);
		
		switch (strategy) {
			case 'scattered':
				this.spawnScatteredSandbags();
				break;
			case 'grid':
				// TODO: Implement grid strategy
				console.warn('[Hazards] Grid strategy not yet implemented');
				break;
			case 'defensiveLines':
				// TODO: Implement defensive lines strategy
				console.warn('[Hazards] Defensive lines strategy not yet implemented');
				break;
			case 'clusters':
				// TODO: Implement clusters strategy
				console.warn('[Hazards] Clusters strategy not yet implemented');
				break;
			default:
				console.warn(`[Hazards] Unknown sandbag strategy: ${strategy}`);
		}
	}

	/**
	 * Spawn barbed wire using the scattered strategy from HazardsConfig
	 * Places clusters of 2-3 triple concertina fences randomly across the battlefield
	 */
	spawnScatteredBarbedWire() {
		if (!this.hazardsConfig.enabled || !this.hazardsConfig.barbedWire || !this.hazardsConfig.barbedWire.enabled) {
			console.log('[Hazards] Barbed wire disabled in config');
			return;
		}
		
		const cfg = this.hazardsConfig.barbedWire;
		const scattered = cfg.scattered;
		
		console.log(`[Hazards] Spawning ${scattered.clusterCount} barbed wire clusters using scattered strategy`);
		
		// Track placed clusters for distance checks
		const placedClusters = [];
		
		// Helper: Check if position is valid (clear of obstacles, safe zones, and sandbags)
		const isPositionValid = (x, y, clearance = scattered.obstacleClearance) => {
			// Check bounds
			if (x < scattered.bounds.minX || x > scattered.bounds.maxX) return false;
			if (y < scattered.bounds.minY || y > scattered.bounds.maxY) return false;
			
			// Check safe zones
			for (const zone of scattered.safeZones) {
				const dx = x - zone.x;
				const dy = y - zone.y;
				const distSq = dx * dx + dy * dy;
				const minDistSq = (zone.radius + scattered.safeZoneClearance) ** 2;
				if (distSq < minDistSq) return false;
			}
			
			// Check global clear zones (open areas with no hazards)
			if (this.hazardsConfig.clearZones) {
				for (const zone of this.hazardsConfig.clearZones) {
					const dx = x - zone.x;
					const dy = y - zone.y;
					const distSq = dx * dx + dy * dy;
					const minDistSq = zone.radius ** 2;
					if (distSq < minDistSq) return false;
				}
			}
			
			// Check environment obstacles
			if (this.env.circleHitsAny && this.env.circleHitsAny(x, y, clearance)) {
				return false;
			}
			
			// Check distance from existing sandbags
			const sandbagClearance = scattered.sandbagClearance || 200;
			for (const sb of this.sandbags) {
				const dx = x - sb.x;
				const dy = y - sb.y;
				const distSq = dx * dx + dy * dy;
				const minDistSq = sandbagClearance ** 2;
				if (distSq < minDistSq) return false;
			}
			
			// Check distance from other wire clusters
			for (const cluster of placedClusters) {
				const dx = x - cluster.x;
				const dy = y - cluster.y;
				const distSq = dx * dx + dy * dy;
				const minDistSq = scattered.minClusterDistance ** 2;
				if (distSq < minDistSq) return false;
			}
			
			return true;
		};
		
		// Helper: Spawn a single barbed wire obstacle
		const spawnWire = (centerX, centerY, variant) => {
			const wireData = {
				id: this._newId('wire'),
				variant: variant,
				centerX: centerX,
				centerY: centerY,
				width: 24,
				slowMul: 0.3,
				dotHp: 1,
				tick: 0.5
			};
			
			// Generate geometry based on variant
			if (variant === 'tripleConcertina') {
				wireData.concertina = this._generateTripleConcertina(centerX, centerY, 280, 3);
			}
			
			this.barbedWire.push(wireData);
			return wireData;
		};
		
		// Attempt to place clusters
		const maxAttemptsPerCluster = 50;
		let successfulClusters = 0;
		
		for (let c = 0; c < scattered.clusterCount; c++) {
			let placed = false;
			
			for (let attempt = 0; attempt < maxAttemptsPerCluster && !placed; attempt++) {
				// Random position in bounds
				const clusterX = scattered.bounds.minX + Math.random() * (scattered.bounds.maxX - scattered.bounds.minX);
				const clusterY = scattered.bounds.minY + Math.random() * (scattered.bounds.maxY - scattered.bounds.minY);
				
				// Check if position is valid
				if (!isPositionValid(clusterX, clusterY, 150)) continue;
				
				// Determine how many wires in this cluster (2-3)
				const wiresInCluster = scattered.wiresPerCluster.min + 
					Math.floor(Math.random() * (scattered.wiresPerCluster.max - scattered.wiresPerCluster.min + 1));
				
				// Try to place all wires in the cluster
				const clusterWires = [];
				let clusterValid = true;
				
				for (let w = 0; w < wiresInCluster; w++) {
					// Calculate offset from cluster center
					let offsetX = 0;
					let offsetY = 0;
					
					if (wiresInCluster === 2) {
						// Two wires: place side by side horizontally
						offsetX = (w === 0 ? -scattered.clusterSpacing / 2 : scattered.clusterSpacing / 2);
					} else if (wiresInCluster === 3) {
						// Three wires: triangle formation
						if (w === 0) {
							offsetY = -scattered.clusterSpacing * 0.4; // Top
						} else if (w === 1) {
							offsetX = -scattered.clusterSpacing * 0.4;
							offsetY = scattered.clusterSpacing * 0.3; // Bottom left
						} else {
							offsetX = scattered.clusterSpacing * 0.4;
							offsetY = scattered.clusterSpacing * 0.3; // Bottom right
						}
					}
					
					const wireX = clusterX + offsetX;
					const wireY = clusterY + offsetY;
					
					// Validate position (looser check within cluster)
					if (!isPositionValid(wireX, wireY, 100)) {
						clusterValid = false;
						break;
					}
					
					// Spawn the wire
					const wire = spawnWire(wireX, wireY, scattered.variant);
					if (wire) clusterWires.push(wire);
				}
				
				// If all wires in cluster were placed successfully
				if (clusterValid && clusterWires.length > 0) {
					placedClusters.push({ x: clusterX, y: clusterY, wires: clusterWires });
					successfulClusters++;
					placed = true;
				} else {
					// Remove any wires we added for this failed cluster
					for (const wire of clusterWires) {
						const idx = this.barbedWire.indexOf(wire);
						if (idx >= 0) this.barbedWire.splice(idx, 1);
					}
				}
			}
		}
		
		console.log(`[Hazards] Successfully placed ${successfulClusters}/${scattered.clusterCount} barbed wire clusters (${this.barbedWire.length} total wire obstacles)`);
	}

	/**
	 * Main spawn method for barbed wire - routes to appropriate strategy
	 */
	spawnBarbedWire() {
		if (!this.hazardsConfig.enabled || !this.hazardsConfig.barbedWire || !this.hazardsConfig.barbedWire.enabled) {
			console.log('[Hazards] Barbed wire disabled');
			return;
		}
		
		const strategy = this.hazardsConfig.barbedWire.strategy;
		console.log(`[Hazards] Using barbed wire placement strategy: ${strategy}`);
		
		switch (strategy) {
			case 'scattered':
				this.spawnScatteredBarbedWire();
				break;
			default:
				console.warn(`[Hazards] Unknown barbed wire strategy: ${strategy}`);
		}
	}

	/**
	 * Spawn mud pools using the scattered strategy from HazardsConfig
	 * Places clusters of 1-4 mud pools randomly across the battlefield
	 * Mud pools can overlap with sandbags and barbed wire (drawn underneath as ground decals)
	 */
	spawnScatteredMudPools() {
		if (!this.hazardsConfig.enabled || !this.hazardsConfig.mudPools || !this.hazardsConfig.mudPools.enabled) {
			console.log('[Hazards] Mud pools disabled in config');
			return;
		}
		
		const cfg = this.hazardsConfig.mudPools;
		const scattered = cfg.scattered;
		
		console.log(`[Hazards] Spawning ${scattered.clusterCount} mud pool clusters using scattered strategy`);
		
		// Track placed clusters for distance checks
		const placedClusters = [];
		
		// Helper: Check if position is valid (clear of obstacles and safe zones)
		// NOTE: We do NOT check for sandbags or barbed wire - mud can go under them
		const isPositionValid = (x, y, clearance = scattered.obstacleClearance) => {
			// Check bounds
			if (x < scattered.bounds.minX || x > scattered.bounds.maxX) return false;
			if (y < scattered.bounds.minY || y > scattered.bounds.maxY) return false;
			
			// Check safe zones
			for (const zone of scattered.safeZones) {
				const dx = x - zone.x;
				const dy = y - zone.y;
				const distSq = dx * dx + dy * dy;
				const minDistSq = (zone.radius + scattered.safeZoneClearance) ** 2;
				if (distSq < minDistSq) return false;
			}
			
			// Check global clear zones (open areas with no hazards)
			if (this.hazardsConfig.clearZones) {
				for (const zone of this.hazardsConfig.clearZones) {
					const dx = x - zone.x;
					const dy = y - zone.y;
					const distSq = dx * dx + dy * dy;
					const minDistSq = zone.radius ** 2;
					if (distSq < minDistSq) return false;
				}
			}
			
			// Check environment obstacles
			if (this.env.circleHitsAny && this.env.circleHitsAny(x, y, clearance)) {
				return false;
			}
			
			// Check distance from other mud pool clusters
			for (const cluster of placedClusters) {
				const dx = x - cluster.x;
				const dy = y - cluster.y;
				const distSq = dx * dx + dy * dy;
				const minDistSq = scattered.minClusterDistance ** 2;
				if (distSq < minDistSq) return false;
			}
			
			return true;
		};
		
		// Helper: Spawn a single mud pool
		const spawnPool = (x, y, radius) => {
			const pool = {
				id: this._newId('mud'),
				x: x,
				y: y,
				radius: radius,
				color: '#6b4e2e'
			};
			
			this.mudPools.push(pool);
			return pool;
		};
		
		// Attempt to place clusters
		const maxAttemptsPerCluster = 50;
		let successfulClusters = 0;
		
		for (let c = 0; c < scattered.clusterCount; c++) {
			let placed = false;
			
			for (let attempt = 0; attempt < maxAttemptsPerCluster && !placed; attempt++) {
				// Random position in bounds
				const clusterX = scattered.bounds.minX + Math.random() * (scattered.bounds.maxX - scattered.bounds.minX);
				const clusterY = scattered.bounds.minY + Math.random() * (scattered.bounds.maxY - scattered.bounds.minY);
				
				// Check if position is valid
				if (!isPositionValid(clusterX, clusterY, scattered.obstacleClearance)) continue;
				
				// Determine how many pools in this cluster (1-4)
				const poolsInCluster = scattered.poolsPerCluster.min + 
					Math.floor(Math.random() * (scattered.poolsPerCluster.max - scattered.poolsPerCluster.min + 1));
				
				// Try to place all pools in the cluster
				const clusterPools = [];
				let clusterValid = true;
				
				for (let p = 0; p < poolsInCluster; p++) {
					// Calculate offset from cluster center
					let offsetX = 0;
					let offsetY = 0;
					
					if (poolsInCluster === 1) {
						// Single pool: no offset
						offsetX = 0;
						offsetY = 0;
					} else if (poolsInCluster === 2) {
						// Two pools: side by side
						offsetX = (p === 0 ? -scattered.clusterSpacing / 2 : scattered.clusterSpacing / 2);
					} else if (poolsInCluster === 3) {
						// Three pools: triangle formation
						if (p === 0) {
							offsetY = -scattered.clusterSpacing * 0.4; // Top
						} else if (p === 1) {
							offsetX = -scattered.clusterSpacing * 0.4;
							offsetY = scattered.clusterSpacing * 0.3; // Bottom left
						} else {
							offsetX = scattered.clusterSpacing * 0.4;
							offsetY = scattered.clusterSpacing * 0.3; // Bottom right
						}
					} else if (poolsInCluster === 4) {
						// Four pools: square formation
						offsetX = (p % 2 === 0 ? -scattered.clusterSpacing / 2 : scattered.clusterSpacing / 2);
						offsetY = (p < 2 ? -scattered.clusterSpacing / 2 : scattered.clusterSpacing / 2);
					}
					
					const poolX = clusterX + offsetX;
					const poolY = clusterY + offsetY;
					
					// Randomize pool radius
					const poolRadius = scattered.radius.min + Math.random() * (scattered.radius.max - scattered.radius.min);
					
					// Validate position (looser check within cluster)
					if (!isPositionValid(poolX, poolY, 50)) {
						clusterValid = false;
						break;
					}
					
					// Spawn the pool
					const pool = spawnPool(poolX, poolY, poolRadius);
					if (pool) clusterPools.push(pool);
				}
				
				// If all pools in cluster were placed successfully
				if (clusterValid && clusterPools.length > 0) {
					placedClusters.push({ x: clusterX, y: clusterY, pools: clusterPools });
					successfulClusters++;
					placed = true;
				} else {
					// Remove any pools we added for this failed cluster
					for (const pool of clusterPools) {
						const idx = this.mudPools.indexOf(pool);
						if (idx >= 0) this.mudPools.splice(idx, 1);
					}
				}
			}
		}
		
		console.log(`[Hazards] Successfully placed ${successfulClusters}/${scattered.clusterCount} mud pool clusters (${this.mudPools.length} total pools)`);
	}

	/**
	 * Main spawn method for mud pools - routes to appropriate strategy
	 */
	spawnMudPools() {
		if (!this.hazardsConfig.enabled || !this.hazardsConfig.mudPools || !this.hazardsConfig.mudPools.enabled) {
			console.log('[Hazards] Mud pools disabled');
			return;
		}
		
		const strategy = this.hazardsConfig.mudPools.strategy;
		console.log(`[Hazards] Using mud pool placement strategy: ${strategy}`);
		
		switch (strategy) {
			case 'scattered':
				this.spawnScatteredMudPools();
				break;
			default:
				console.warn(`[Hazards] Unknown mud pool strategy: ${strategy}`);
		}
	}

	/**
	 * Spawn fire pools using the scattered strategy from HazardsConfig
	 * Places individual fire pools (no clusters) - rare hazard
	 */
	spawnScatteredFirePools() {
		if (!this.hazardsConfig.enabled || !this.hazardsConfig.firePools || !this.hazardsConfig.firePools.enabled) {
			console.log('[Hazards] Fire pools disabled in config');
			return;
		}
		
		const cfg = this.hazardsConfig.firePools;
		const scattered = cfg.scattered;
		
		console.log(`[Hazards] Spawning ${scattered.poolCount} fire pools using scattered strategy`);
		
		// Track placed pools for distance checks
		const placedPools = [];
		
		// Helper: Check if position is valid (clear of obstacles, safe zones, and other hazards)
		const isPositionValid = (x, y, clearance = scattered.obstacleClearance) => {
			// Check bounds
			if (x < scattered.bounds.minX || x > scattered.bounds.maxX) return false;
			if (y < scattered.bounds.minY || y > scattered.bounds.maxY) return false;
			
			// Check safe zones
			for (const zone of scattered.safeZones) {
				const dx = x - zone.x;
				const dy = y - zone.y;
				const distSq = dx * dx + dy * dy;
				const minDistSq = (zone.radius + scattered.safeZoneClearance) ** 2;
				if (distSq < minDistSq) return false;
			}
			
			// Check global clear zones (open areas with no hazards)
			if (this.hazardsConfig.clearZones) {
				for (const zone of this.hazardsConfig.clearZones) {
					const dx = x - zone.x;
					const dy = y - zone.y;
					const distSq = dx * dx + dy * dy;
					const minDistSq = zone.radius ** 2;
					if (distSq < minDistSq) return false;
				}
			}
			
			// Check environment obstacles
			if (this.env.circleHitsAny && this.env.circleHitsAny(x, y, clearance)) {
				return false;
			}
			
			// Check distance from existing sandbags
			const sandbagClearance = scattered.sandbagClearance || 300;
			for (const sb of this.sandbags) {
				const dx = x - sb.x;
				const dy = y - sb.y;
				const distSq = dx * dx + dy * dy;
				const minDistSq = sandbagClearance ** 2;
				if (distSq < minDistSq) return false;
			}
			
			// Check distance from barbed wire
			const wireClearance = scattered.wireClearance || 300;
			for (const w of this.barbedWire) {
				const wx = w.centerX || 0;
				const wy = w.centerY || 0;
				const dx = x - wx;
				const dy = y - wy;
				const distSq = dx * dx + dy * dy;
				const minDistSq = wireClearance ** 2;
				if (distSq < minDistSq) return false;
			}
			
			// Check distance from mud pools
			const mudClearance = scattered.mudClearance || 200;
			for (const m of this.mudPools) {
				const dx = x - m.x;
				const dy = y - m.y;
				const distSq = dx * dx + dy * dy;
				const minDistSq = mudClearance ** 2;
				if (distSq < minDistSq) return false;
			}
			
			// Check distance from other fire pools
			for (const pool of placedPools) {
				const dx = x - pool.x;
				const dy = y - pool.y;
				const distSq = dx * dx + dy * dy;
				const minDistSq = scattered.minPoolDistance ** 2;
				if (distSq < minDistSq) return false;
			}
			
			return true;
		};
		
		// Attempt to place individual fire pools
		const maxAttemptsPerPool = 100;
		let successfulPools = 0;
		
		for (let p = 0; p < scattered.poolCount; p++) {
			let placed = false;
			
			for (let attempt = 0; attempt < maxAttemptsPerPool && !placed; attempt++) {
				// Random position in bounds
				const poolX = scattered.bounds.minX + Math.random() * (scattered.bounds.maxX - scattered.bounds.minX);
				const poolY = scattered.bounds.minY + Math.random() * (scattered.bounds.maxY - scattered.bounds.minY);
				
				// Check if position is valid
				if (!isPositionValid(poolX, poolY, scattered.obstacleClearance)) continue;
				
				// Spawn the fire pool
				const firePool = {
					id: this._newId('fire'),
					x: poolX,
					y: poolY,
					radius: scattered.radius || 200,
					dotDps: scattered.dotDps || 20,
					dotDuration: scattered.dotDuration || 3.0,
					dotTickInterval: scattered.dotTickInterval || 0.5,
					smoke: scattered.smoke !== false
				};
				
				this.firePools.push(firePool);
				placedPools.push(firePool);
				successfulPools++;
				placed = true;
			}
			
			if (!placed) {
				console.warn(`[Hazards] Could not place fire pool ${p + 1}/${scattered.poolCount} after ${maxAttemptsPerPool} attempts`);
			}
		}
		
		console.log(`[Hazards] Successfully placed ${successfulPools}/${scattered.poolCount} fire pools`);
	}

	/**
	 * Main spawn method for fire pools - routes to appropriate strategy
	 */
	spawnFirePools() {
		if (!this.hazardsConfig.enabled || !this.hazardsConfig.firePools || !this.hazardsConfig.firePools.enabled) {
			console.log('[Hazards] Fire pools disabled');
			return;
		}
		
		const strategy = this.hazardsConfig.firePools.strategy;
		console.log(`[Hazards] Using fire pool placement strategy: ${strategy}`);
		
		switch (strategy) {
			case 'scattered':
				this.spawnScatteredFirePools();
				break;
			default:
				console.warn(`[Hazards] Unknown fire pool strategy: ${strategy}`);
		}
	}

	/**
	 * Spawn gas canister clusters using scattered placement strategy
	 * Places clusters of 3-8 canisters with spacing matching test row (~320px apart)
	 */
	spawnScatteredGasCanisters() {
		if (!this.hazardsConfig.enabled || !this.hazardsConfig.gasCanisters || !this.hazardsConfig.gasCanisters.enabled) {
			console.log('[Hazards] Gas canisters disabled in config');
			return;
		}
		
		const cfg = this.hazardsConfig.gasCanisters;
		const scattered = cfg.scattered;
		
		console.log(`[Hazards] Spawning ${scattered.clusterCount} gas canister clusters using scattered strategy`);
		
		// Track placed clusters for distance checks
		const placedClusters = [];
		
		// Helper: Check if position is valid (clear of obstacles, safe zones, and other hazards)
		const isPositionValid = (x, y, clearance = scattered.obstacleClearance) => {
			// Check bounds
			if (x < scattered.bounds.minX || x > scattered.bounds.maxX) return false;
			if (y < scattered.bounds.minY || y > scattered.bounds.maxY) return false;
			
			// Check safe zones
			for (const zone of scattered.safeZones) {
				const dx = x - zone.x;
				const dy = y - zone.y;
				const distSq = dx * dx + dy * dy;
				const minDistSq = (zone.radius + scattered.safeZoneClearance) ** 2;
				if (distSq < minDistSq) return false;
			}
			
			// Check global clear zones (open areas with no hazards)
			if (this.hazardsConfig.clearZones) {
				for (const zone of this.hazardsConfig.clearZones) {
					const dx = x - zone.x;
					const dy = y - zone.y;
					const distSq = dx * dx + dy * dy;
					const minDistSq = zone.radius ** 2;
					if (distSq < minDistSq) return false;
				}
			}
			
			// Check environment obstacles
			if (this.env.circleHitsAny && this.env.circleHitsAny(x, y, clearance)) {
				return false;
			}
			
			// Check distance from existing sandbags
			const sandbagClearance = scattered.sandbagClearance || 300;
			for (const sb of this.sandbags) {
				const dx = x - sb.x;
				const dy = y - sb.y;
				const distSq = dx * dx + dy * dy;
				const minDistSq = sandbagClearance ** 2;
				if (distSq < minDistSq) return false;
			}
			
			// Check distance from barbed wire
			const wireClearance = scattered.wireClearance || 300;
			for (const w of this.barbedWire) {
				const wx = w.centerX || 0;
				const wy = w.centerY || 0;
				const dx = x - wx;
				const dy = y - wy;
				const distSq = dx * dx + dy * dy;
				const minDistSq = wireClearance ** 2;
				if (distSq < minDistSq) return false;
			}
			
			// Check distance from mud pools
			const mudClearance = scattered.mudClearance || 200;
			for (const m of this.mudPools) {
				const dx = x - m.x;
				const dy = y - m.y;
				const distSq = dx * dx + dy * dy;
				const minDistSq = mudClearance ** 2;
				if (distSq < minDistSq) return false;
			}
			
			// Check distance from fire pools
			const fireClearance = scattered.fireClearance || 400;
			for (const f of this.firePools) {
				const dx = x - f.x;
				const dy = y - f.y;
				const distSq = dx * dx + dy * dy;
				const minDistSq = fireClearance ** 2;
				if (distSq < minDistSq) return false;
			}
			
			// Check distance from other gas canister clusters
			for (const cluster of placedClusters) {
				const dx = x - cluster.x;
				const dy = y - cluster.y;
				const distSq = dx * dx + dy * dy;
				const minDistSq = scattered.minClusterDistance ** 2;
				if (distSq < minDistSq) return false;
			}
			
			return true;
		};
		
		// Attempt to place clusters
		const maxAttemptsPerCluster = 100;
		let successfulClusters = 0;
		
		for (let c = 0; c < scattered.clusterCount; c++) {
			let placed = false;
			
			for (let attempt = 0; attempt < maxAttemptsPerCluster && !placed; attempt++) {
				// Random position in bounds for cluster center
				const clusterX = scattered.bounds.minX + Math.random() * (scattered.bounds.maxX - scattered.bounds.minX);
				const clusterY = scattered.bounds.minY + Math.random() * (scattered.bounds.maxY - scattered.bounds.minY);
				
				// Check if cluster center position is valid
				if (!isPositionValid(clusterX, clusterY, scattered.obstacleClearance)) continue;
				
				// Determine number of canisters in this cluster
				const canisterCount = Math.floor(
					scattered.canistersPerCluster.min + 
					Math.random() * (scattered.canistersPerCluster.max - scattered.canistersPerCluster.min + 1)
				);
				
				// Generate canister positions in a loose scattered pattern (match test row spacing)
				const canisterPositions = [];
				const avgSpacing = scattered.canisterSpacing;
				const randomOffset = scattered.randomOffset;
				
				// Create a semi-circular or irregular cluster pattern
				for (let i = 0; i < canisterCount; i++) {
					const angle = (i / canisterCount) * Math.PI * 2 + Math.random() * 0.5;
					const distance = avgSpacing * (0.3 + Math.random() * 0.7); // Vary distance from center
					const offsetX = Math.cos(angle) * distance + (Math.random() - 0.5) * randomOffset;
					const offsetY = Math.sin(angle) * distance + (Math.random() - 0.5) * randomOffset;
					
					canisterPositions.push({
						x: clusterX + offsetX,
						y: clusterY + offsetY
					});
				}
				
				// Spawn all canisters in the cluster
				let allCanistersValid = true;
				for (const pos of canisterPositions) {
					// Basic bounds check for each canister
					if (pos.x < scattered.bounds.minX || pos.x > scattered.bounds.maxX) {
						allCanistersValid = false;
						break;
					}
					if (pos.y < scattered.bounds.minY || pos.y > scattered.bounds.maxY) {
						allCanistersValid = false;
						break;
					}
				}
				
				if (!allCanistersValid) continue;
				
				// Spawn the canisters
				for (const pos of canisterPositions) {
					this.gasCanisters.push({
						id: this._newId('gas'),
						x: pos.x,
						y: pos.y,
						radius: scattered.radius || 180,
						dotDps: scattered.dotDps || 0, // No damage - vision impairment only
						dotDuration: scattered.dotDuration || 0,
						dotTickInterval: scattered.dotTickInterval || 0.5
					});
				}
				
				// Mark cluster as placed
				placedClusters.push({ x: clusterX, y: clusterY });
				successfulClusters++;
				placed = true;
				
				console.log(`[Hazards] Placed gas cluster ${successfulClusters}/${scattered.clusterCount} at (${Math.round(clusterX)}, ${Math.round(clusterY)}) with ${canisterCount} canisters`);
			}
		}
		
		console.log(`[Hazards] Successfully placed ${successfulClusters}/${scattered.clusterCount} gas canister clusters (${this.gasCanisters.length} total canisters)`);
	}

	/**
	 * Router method for gas canister spawning strategies
	 */
	spawnGasCanisters() {
		if (!this.hazardsConfig.enabled || !this.hazardsConfig.gasCanisters || !this.hazardsConfig.gasCanisters.enabled) {
			console.log('[Hazards] Gas canisters disabled');
			return;
		}
		
		const strategy = this.hazardsConfig.gasCanisters.strategy;
		console.log(`[Hazards] Using gas canister placement strategy: ${strategy}`);
		
		switch (strategy) {
			case 'scattered':
				this.spawnScatteredGasCanisters();
				break;
			default:
				console.warn(`[Hazards] Unknown gas canister strategy: ${strategy}`);
		}
	}

	update(deltaTime) {
		const now = Date.now();
		// Apply hazard effects to players
		for (const [pid, player] of this.room.players) {
			if (!player) continue;
			// Skip dead players - don't apply hazard effects to corpses
			if (player.health <= 0) continue;
			// Reset per-frame speed multiplier
			player._hazardSpeedMul = 1;
			// Reset boomer-style slow flag; hazards will set as needed
			// Note: keep existing _svSlowed usage for other systems; we won't toggle it here

		// Helper: ensure/refresh DOT stack (returns true if new stack was created)
		const upsertDot = (key, dps, duration = 0.6) => {
			if (!Array.isArray(player.dotStacks)) player.dotStacks = [];
			let stack = null;
			for (let i = 0; i < player.dotStacks.length; i++) {
				if (player.dotStacks[i] && player.dotStacks[i].key === key) { stack = player.dotStacks[i]; break; }
			}
			if (!stack) {
				stack = { key, dps, timeLeft: duration, from: 'HAZARD' };
				player.dotStacks.push(stack);
				return true; // New stack created
			} else {
				stack.dps = dps; // allow dynamic tuning
				stack.timeLeft = duration; // refresh while inside
				return false; // Existing stack refreshed
			}
		};

		const px = Number(player.x) || 0;
		const py = Number(player.y) || 0;

		// Distance-based culling: only check hazards within this radius
		const checkRadius = 800; // Check hazards within 800 units (matches client culling buffer)
		
		// Helper: quick distance check (returns true if within radius + buffer)
		const isNearPlayer = (hx, hy, buffer = 0) => {
			const dx = px - hx;
			const dy = py - hy;
			const maxDist = checkRadius + buffer;
			return (dx*dx + dy*dy) <= (maxDist * maxDist);
		};

		// Barbed wire: check proximity based on variant pattern
		for (let i = 0; i < this.barbedWire.length; i++) {
			const w = this.barbedWire[i];
			if (!w) continue;
			
			// DISTANCE CULLING: skip if far from player (with buffer for wire size)
			const wx = w.centerX || 0;
			const wy = w.centerY || 0;
			if (!isNearPlayer(wx, wy, 200)) continue;
			
			let inWire = false;
			const checkWidth = w.width || 24;
				
				// Check collision based on wire variant
				if (w.variant === 'tangled' && w.segments) {
					// Check all segments in tangled wire
					for (const seg of w.segments) {
						const dist = EnvironmentHazards._pointToSegmentDist(px, py, seg.x1, seg.y1, seg.x2, seg.y2);
						if (dist <= checkWidth) {
							inWire = true;
							break;
						}
					}
				} else if (w.variant === 'spiral' && w.spiral) {
					// Check proximity to spiral points (polyline)
					const pts = w.spiral.points;
					for (let j = 0; j < pts.length - 1; j++) {
						const dist = EnvironmentHazards._pointToSegmentDist(px, py, pts[j].x, pts[j].y, pts[j+1].x, pts[j+1].y);
						if (dist <= checkWidth) {
							inWire = true;
							break;
						}
					}
				} else if (w.variant === 'tripleConcertina' && w.concertina) {
					// Check proximity to any coil in any row
					for (const row of w.concertina.rows) {
						for (const coil of row.coils) {
							const dx = px - coil.x;
							const dy = py - coil.y;
							const distToCoilCenter = Math.sqrt(dx*dx + dy*dy);
							// Player is in wire if near the coil ring (within radius ± width)
							if (Math.abs(distToCoilCenter - coil.radius) <= checkWidth) {
								inWire = true;
								break;
							}
						}
						if (inWire) break;
					}
				} else if (w.variant === 'doubleApron' && w.apron) {
					// Check all wire segments from all stakes
					for (const stake of w.apron.stakes) {
						for (const wire of stake.wires) {
							const dist = EnvironmentHazards._pointToSegmentDist(px, py, wire.x1, wire.y1, wire.x2, wire.y2);
							if (dist <= checkWidth) {
								inWire = true;
								break;
							}
						}
						if (inWire) break;
					}
				} else if (w.x1 != null && w.y1 != null && w.x2 != null && w.y2 != null) {
					// Legacy simple line segment (backwards compatibility)
					const dist = EnvironmentHazards._pointToSegmentDist(px, py, w.x1, w.y1, w.x2, w.y2);
					if (dist <= checkWidth) {
						inWire = true;
					}
				}
				
				if (inWire) {
					player._hazardSpeedMul = Math.min(player._hazardSpeedMul, 0.3);
					upsertDot('hazard_barbed', (w.dotHp ? (w.dotHp * 2) : 2), 0.55);
					break; // one wire at a time
				}
			}

	// Mud pools: circle slow
	let inMud = false;
	for (let i = 0; i < this.mudPools.length; i++) {
		const m = this.mudPools[i];
		if (!m) continue;
		
		// DISTANCE CULLING: skip if far from player (with buffer for pool radius)
		if (!isNearPlayer(m.x, m.y, m.radius)) continue;
		
		const dx = px - m.x; const dy = py - m.y;
		if ((dx*dx + dy*dy) <= (m.radius * m.radius)) {
				player._hazardSpeedMul = Math.min(player._hazardSpeedMul, 0.3);
				inMud = true;
				break;
			}
		}
		
		// Track and broadcast mud slow state changes
		if (!player._mudSlowed) player._mudSlowed = false;
		if (inMud !== player._mudSlowed) {
			player._mudSlowed = inMud;
			try {
				const io = this.room && this.room.io;
				if (io) io.to(this.room.id).emit('playerMudSlowState', { playerId: pid, slowed: inMud });
			} catch(_) {}
		}

// Fire pools: circle DoT (player damage)
for (let i = 0; i < this.firePools.length; i++) {
	const f = this.firePools[i];
	if (!f) continue;
	
	// DISTANCE CULLING: skip if far from player (with buffer for pool radius)
	if (!isNearPlayer(f.x, f.y, f.radius)) continue;
	
	const dx = px - f.x; const dy = py - f.y;
	if ((dx*dx + dy*dy) <= (f.radius * f.radius)) {
			const dps = Number.isFinite(f.dotDps) ? f.dotDps : 20; // Default 20 DPS
			
			// Track if player was already burning before applying DOT
			const wasAlreadyBurning = Array.isArray(player.dotStacks) && 
				player.dotStacks.some(d => d && d.key === 'hazard_fire');
			
			const isNewBurn = upsertDot('hazard_fire', dps, 0.6);
			
			// Broadcast burn state for fire VFX when player starts burning (first time only)
			if (isNewBurn && !wasAlreadyBurning) {
				try {
					const io = this.room && this.room.io;
					if (io) {
						io.to(this.room.id).emit('vfxEvent', {
							type: 'burnStateChanged',
							playerId: pid,
							burning: true,
							x: px,
							y: py
						});
						console.log('[EnvironmentHazards] 🔥 Player', pid.substring(0, 8), 'started burning from fire pool');
					}
				} catch(err) {
					console.error('[EnvironmentHazards] Failed to broadcast burn state:', err);
				}
			}
			break;
		}
	}

// Gas canisters: vision impairment only (NO damage)
// Center effect on gas cloud - raised so bottom of red circle touches barrel
// This makes gas spew upward: players underneath (below barrel) less affected, players in cloud heavily affected
let inGas = false;
const gasCloudOffsetY = -126; // Red circle radius = 70% of 180px = 126px
for (let i = 0; i < this.gasCanisters.length; i++) {
	const g = this.gasCanisters[i];
	if (!g) continue;
	
	// DISTANCE CULLING: skip if far from player (with buffer for gas radius)
	if (!isNearPlayer(g.x, g.y, g.radius + Math.abs(gasCloudOffsetY))) continue;
	
	// Check against gas cloud center, not canister position
	const gasCloudY = g.y + gasCloudOffsetY;
		const dx = px - g.x;
		const dy = py - gasCloudY;
		if ((dx*dx + dy*dy) <= (g.radius * g.radius)) {
			inGas = true;
			break;
		}
	}
	
	// Track time spent in gas and broadcast state changes for fog of war effect
	if (!Number.isFinite(player._gasTime)) player._gasTime = 0;
	
	if (inGas) {
		// Accumulate time in gas (caps at 3 seconds for max intensity)
		player._gasTime = Math.min(3.0, player._gasTime + deltaTime);
		
		// Drain stamina while in gas (constant drain prevents sprinting/dashing)
		if (player.invincible !== true && Number.isFinite(player.stamina) && Number.isFinite(player.staminaMax)) {
			const staminaDrainRate = 30; // 30 stamina per second
			player.stamina = Math.max(0, player.stamina - staminaDrainRate * deltaTime);
		}
	} else if (player._gasTime > 0) {
		// Decay time out of gas (faster decay than buildup)
		player._gasTime = Math.max(0, player._gasTime - deltaTime * 1.5);
	}
	
	// Broadcast gas intensity to clients (continuous updates while intensity changes)
	try {
		const io = this.room && this.room.io;
		if (io && player._gasTime > 0) {
			// Send intensity (0-1) based on time in gas
			const intensity = Math.min(1.0, player._gasTime / 3.0);
			io.to(this.room.id).emit('playerGasIntensity', { playerId: pid, intensity: intensity });
		} else if (io && player._gasTime === 0 && player._lastGasIntensity > 0) {
			// Send clear signal when fully faded
			io.to(this.room.id).emit('playerGasIntensity', { playerId: pid, intensity: 0 });
		}
		player._lastGasIntensity = player._gasTime > 0 ? 1 : 0;
	} catch(_) {}

		// Trenches: concealment unless revealed by recent firing
		let inTrench = false;
		for (let i = 0; i < this.trenches.length; i++) {
			const t = this.trenches[i];
			if (!t) continue;
			
			// DISTANCE CULLING: skip if far from player (with buffer for trench size)
			const trenchMaxDim = Math.max(t.w, t.h) / 2;
			if (!isNearPlayer(t.x, t.y, trenchMaxDim)) continue;
			
			const left = t.x - t.w/2, right = t.x + t.w/2, top = t.y - t.h/2, bottom = t.y + t.h/2;
			if (px >= left && px <= right && py >= top && py <= bottom) { inTrench = true; break; }
			}
			if (!Number.isFinite(player._trenchRevealTimer)) player._trenchRevealTimer = 0;
			if (player._trenchRevealTimer > 0) player._trenchRevealTimer = Math.max(0, player._trenchRevealTimer - deltaTime);

			if (inTrench) {
				const firing = !!(player.isFiringWeapon1 || player.isFiringWeapon4);
				if (firing) {
					player._trenchRevealTimer = Math.max(player._trenchRevealTimer, 2.0);
				}
				if (player._trenchRevealTimer <= 0) {
					if (!player._trenchConcealActive) {
						player._trenchConcealActive = true;
						// Activate invisibility (no drain since we don't set invisibilityActiveTime)
						player.invisible = true;
					}
				} else {
					// Revealed: ensure invisibility is not forced by trench system
					if (player._trenchConcealActive) {
						player._trenchConcealActive = false;
						// Only clear our invisibility if it was not toggled by ability
						if (!player.invisibilityActiveTime) player.invisible = false;
					}
				}
			} else {
				// Left trench: remove concealment if we applied it
				if (player._trenchConcealActive) {
					player._trenchConcealActive = false;
					if (!player.invisibilityActiveTime) player.invisible = false;
				}
		}
	}
	
	// Apply fire pool DOT to enemies (server-authoritative)
	if (this.room && this.room.enemies) {
		for (const [enemyId, enemy] of this.room.enemies) {
			if (!enemy || enemy.health <= 0) continue;
			
			const ex = Number(enemy.x) || 0;
			const ey = Number(enemy.y) || 0;
			
			// Check each fire pool
			for (let i = 0; i < this.firePools.length; i++) {
				const f = this.firePools[i];
				if (!f) continue;
				
				const dx = ex - f.x;
				const dy = ey - f.y;
				const distSq = dx*dx + dy*dy;
				const enemyRadius = Number(enemy.radius) || 26;
				const checkRadius = f.radius + enemyRadius;
				
				if (distSq <= (checkRadius * checkRadius)) {
					// Enemy is in fire pool - apply DOT
					const dotDps = Number.isFinite(f.dotDps) ? f.dotDps : 20;
					const dotDuration = Number.isFinite(f.dotDuration) ? f.dotDuration : 3.0;
					
					// Ensure enemy has dotStacks array
					if (!Array.isArray(enemy.dotStacks)) enemy.dotStacks = [];
					
					// Find or create fire pool DOT stack
					let stack = null;
					for (let j = 0; j < enemy.dotStacks.length; j++) {
						if (enemy.dotStacks[j] && enemy.dotStacks[j].key === 'envFire') {
							stack = enemy.dotStacks[j];
							break;
						}
					}
					
					const wasNewStack = !stack;
					
					if (!stack) {
						// Create new DOT stack
						stack = { key: 'envFire', dps: dotDps, timeLeft: dotDuration, from: 'HAZARD' };
						enemy.dotStacks.push(stack);
					} else {
						// Refresh existing DOT
						stack.dps = dotDps;
						stack.timeLeft = dotDuration;
					}
					
					break; // Only one fire pool at a time
				}
			}
		}
	}
	
	// Apply fire pool damage to exploding barrels (same rate as enemy DOT)
	if (this.firePools && this.explodingBarrels) {
		// Initialize fire damage tick tracker
		if (!this._fireBarrelDamageTick) this._fireBarrelDamageTick = 0;
		this._fireBarrelDamageTick += deltaTime;
		
		// Only tick damage every 0.5 seconds for performance
		if (this._fireBarrelDamageTick >= 0.5) {
			this._fireBarrelDamageTick = 0;
			
			for (const barrel of this.explodingBarrels) {
				if (!barrel || barrel.exploded) continue;
				
				const bx = barrel.x;
				const by = barrel.y;
				const bRadius = barrel.visualRadius || 24;
				
				// Check each fire pool
				for (const f of this.firePools) {
					if (!f) continue;
					
					const dx = bx - f.x;
					const dy = by - f.y;
					const distSq = dx*dx + dy*dy;
					const checkRadius = f.radius + bRadius;
					
					if (distSq <= (checkRadius * checkRadius)) {
						// Barrel is in fire pool - apply damage (0.5s of DOT DPS)
						const dotDps = Number.isFinite(f.dotDps) ? f.dotDps : 20;
						const damagePerTick = dotDps * 0.5;
						this.damageBarrel(barrel.id, damagePerTick, bx, by);
						break; // Only one fire pool at a time per barrel
					}
				}
			}
		}
	}
	
	// Apply fire pool DOT to troops (server-authoritative)
	if (this.room.troopManager && this.room.troopManager.troops && this.firePools) {
		// Initialize fire damage tick tracker for troops
		if (!this._fireTroopDamageTick) this._fireTroopDamageTick = 0;
		this._fireTroopDamageTick += deltaTime;
		
		// Only tick damage every 0.5 seconds for performance
		if (this._fireTroopDamageTick >= 0.5) {
			this._fireTroopDamageTick = 0;
			
			const aliveTroops = Array.from(this.room.troopManager.troops.values()).filter(t => t && t.alive && t.health > 0);
			// console.log(`[Hazards] Fire pool damage tick - checking ${aliveTroops.length} alive troops against ${this.firePools.length} fire pools`);
			
			for (const [, troop] of this.room.troopManager.troops) {
				if (!troop || !troop.alive || troop.health <= 0) continue;
				
				const tx = Number(troop.x) || 0;
				const ty = Number(troop.y) || 0;
				const tRadius = troop.radius || 22;
				
				// Check each fire pool
				for (const f of this.firePools) {
					if (!f) continue;
					
					const dx = tx - f.x;
					const dy = ty - f.y;
					const distSq = dx*dx + dy*dy;
					const checkRadius = f.radius + tRadius;
					
					if (distSq <= (checkRadius * checkRadius)) {
						// Troop is in fire pool - apply damage (0.5s of DOT DPS)
						const dotDps = Number.isFinite(f.dotDps) ? f.dotDps : 20;
						const damagePerTick = dotDps * 0.5;
						
					troop.health = Math.max(0, troop.health - damagePerTick);
					
					// console.log(`[Hazards] Troop ${troop.id} taking ${damagePerTick} fire damage (health: ${troop.health}/${troop.healthMax})`);
					
					// Broadcast troop damage
					if (this.room.io) {
						// console.log(`[Hazards] Broadcasting troopDamaged for ${troop.id}`);
						this.room.io.to(this.room.id).emit('troopDamaged', {
							troopId: troop.id,
							// Send already-rounded integer damage for UI text (avoid "-0")
							damage: Math.max(1, Math.round(damagePerTick)),
							health: troop.health,
							healthMax: troop.healthMax,
							x: tx,
							y: ty
						});
					} else {
						// console.log(`[Hazards] ERROR: room.io is not available for troopDamaged broadcast!`);
					}
					
					// Check if troop died
					if (troop.health <= 0) {
						troop.alive = false;
						// console.log(`[Hazards] Troop ${troop.id} killed by fire pool`);
							
							// Broadcast troop death
							if (this.room.io) {
								this.room.io.to(this.room.id).emit('troopDeath', {
									troopId: troop.id,
									x: tx,
									y: ty
								});
								this.room.io.to(this.room.id).emit('entity_dead', {
									entityType: 'troop',
									id: troop.id,
									x: tx,
									y: ty,
									kind: troop.type || 'troop',
									cause: 'fire'
								});
							}
						}
						
						break; // Only one fire pool at a time per troop
					}
				}
			}
		}
	}
}

	/**
	 * Spawn exploding barrels using mixed strategy (clusters + scattered)
	 */
	spawnExplodingBarrels() {
		if (!this.hazardsConfig || !this.hazardsConfig.enabled || !this.hazardsConfig.explodingBarrels || !this.hazardsConfig.explodingBarrels.enabled) {
			console.log('[Hazards] Exploding barrels disabled');
			return;
		}
		
		const cfg = this.hazardsConfig.explodingBarrels;
		const props = cfg.properties;
		const mixed = cfg.mixed;
		const bounds = mixed.bounds;
		const clearZones = this.hazardsConfig.clearZones || [];
		
		const placedBarrels = [];
		
		// Helper: check if position is valid
		const isValidPosition = (x, y, minDistFromOthers) => {
			// Check safe zones
			for (const zone of mixed.safeZones) {
				const dist = Math.hypot(x - zone.x, y - zone.y);
				if (dist < mixed.safeZoneClearance + zone.radius) {
					return false;
				}
			}
			
			// Check clear zones
			for (const zone of clearZones) {
				const dist = Math.hypot(x - zone.x, y - zone.y);
				if (dist < zone.radius) {
					return false;
				}
			}
			
			// Check distance from other barrels
			for (const b of placedBarrels) {
				if (Math.hypot(x - b.x, y - b.y) < minDistFromOthers) {
					return false;
				}
			}
			
			// Check distance from obstacles
			if (this.env && this.env.circleHitsAny && this.env.circleHitsAny(x, y, mixed.obstacleClearance)) {
				return false;
			}
			
			// Check distance from fire pools
			for (const fire of this.firePools) {
				if (Math.hypot(x - fire.x, y - fire.y) < mixed.fireClearance + fire.radius) {
					return false;
				}
			}
			
			return true;
		};
		
		// Spawn CLUSTERS first
		const clusterCfg = mixed.clusters;
		const clusterCenters = [];
		let clusterAttempts = 0;
		const maxClusterAttempts = clusterCfg.count * 100;
		
		while (clusterCenters.length < clusterCfg.count && clusterAttempts < maxClusterAttempts) {
			clusterAttempts++;
			
			// Random cluster center
			const cx = bounds.minX + Math.random() * (bounds.maxX - bounds.minX);
			const cy = bounds.minY + Math.random() * (bounds.maxY - bounds.minY);
			
			// Check distance from other cluster centers
			let tooClose = false;
			for (const c of clusterCenters) {
				if (Math.hypot(cx - c.x, cy - c.y) < clusterCfg.minClusterDistance) {
					tooClose = true;
					break;
				}
			}
			if (tooClose) continue;
			
			// Check safe zones
			let inSafe = false;
			for (const zone of mixed.safeZones) {
				if (Math.hypot(cx - zone.x, cy - zone.y) < mixed.safeZoneClearance + zone.radius) {
					inSafe = true;
					break;
				}
			}
			if (inSafe) continue;
			
			clusterCenters.push({ x: cx, y: cy });
			
			// Spawn barrels in this cluster
			const numBarrels = clusterCfg.barrelsPerCluster.min + 
				Math.floor(Math.random() * (clusterCfg.barrelsPerCluster.max - clusterCfg.barrelsPerCluster.min + 1));
			
			let barrelsInCluster = 0;
			let barrelAttempts = 0;
			
			while (barrelsInCluster < numBarrels && barrelAttempts < 50) {
				barrelAttempts++;
				
				// Random position within cluster radius
				const angle = Math.random() * Math.PI * 2;
				const dist = Math.random() * clusterCfg.clusterRadius;
				const bx = cx + Math.cos(angle) * dist;
				const by = cy + Math.sin(angle) * dist;
				
				// Check bounds
				if (bx < bounds.minX || bx > bounds.maxX || by < bounds.minY || by > bounds.maxY) continue;
				
				// Check position is valid (but allow closer spacing within cluster)
				if (!isValidPosition(bx, by, 60)) continue;
				
				const barrel = {
					id: this._newId('barrel'),
					x: bx,
					y: by,
					health: props.health,
					healthMax: props.healthMax,
					explosionRadius: props.explosionRadius,
					explosionDamage: props.explosionDamage,
					visualRadius: props.visualRadius,
					exploded: false
				};
				
				placedBarrels.push(barrel);
				this.explodingBarrels.push(barrel);
				barrelsInCluster++;
			}
		}
		
		console.log(`[Hazards] Spawned ${clusterCenters.length} barrel clusters`);
		
		// Spawn SCATTERED barrels
		const scatteredCfg = mixed.scattered;
		let scatteredCount = 0;
		let scatteredAttempts = 0;
		const maxScatteredAttempts = scatteredCfg.count * 100;
		
		while (scatteredCount < scatteredCfg.count && scatteredAttempts < maxScatteredAttempts) {
			scatteredAttempts++;
			
			const x = bounds.minX + Math.random() * (bounds.maxX - bounds.minX);
			const y = bounds.minY + Math.random() * (bounds.maxY - bounds.minY);
			
			if (!isValidPosition(x, y, scatteredCfg.minBarrelDistance)) continue;
			
			const barrel = {
				id: this._newId('barrel'),
				x: x,
				y: y,
				health: props.health,
				healthMax: props.healthMax,
				explosionRadius: props.explosionRadius,
				explosionDamage: props.explosionDamage,
				visualRadius: props.visualRadius,
				exploded: false
			};
			
			placedBarrels.push(barrel);
			this.explodingBarrels.push(barrel);
			scatteredCount++;
		}
		
		console.log(`[Hazards] Spawned ${scatteredCount} scattered barrels`);
		console.log(`[Hazards] Total exploding barrels: ${this.explodingBarrels.length}`);
	}
	
	/**
	 * Apply damage to a barrel by ID
	 * @param {string} barrelId - The barrel's ID
	 * @param {number} damage - Damage to apply
	 * @param {number} hitX - X position of the hit (for VFX)
	 * @param {number} hitY - Y position of the hit (for VFX)
	 * @returns {boolean} True if barrel exploded
	 */
	damageBarrel(barrelId, damage, hitX, hitY) {
		const barrel = this.explodingBarrels.find(b => b.id === barrelId);
		if (!barrel || barrel.exploded) return false;
		
		barrel.health -= damage;
		console.log(`[Hazards] Barrel ${barrelId} took ${damage} damage, health: ${barrel.health}/${barrel.healthMax}`);
		
		// Emit hit event for VFX (before checking if destroyed)
		if (this.room && this.room.io) {
			this.room.io.to(this.room.id).emit('barrelHit', {
				id: barrel.id,
				x: hitX != null ? hitX : barrel.x,
				y: hitY != null ? hitY : barrel.y,
				health: barrel.health,
				healthMax: barrel.healthMax,
				fusing: barrel.health <= barrel.healthMax * 0.5 && barrel.health > 0
			});
		}
		
		if (barrel.health <= 0) {
			barrel.health = 0;
			barrel.exploded = true;
			this.explodeBarrel(barrel);
			return true;
		}
		
		// Start fuse countdown when below 50% health
		if (barrel.health <= barrel.healthMax * 0.5 && !barrel._fuseStarted) {
			barrel._fuseStarted = true;
			barrel._fuseStartHealth = barrel.health;
			console.log(`[Hazards] Barrel ${barrelId} fuse started! Will explode in 2 seconds.`);
			
			// Notify clients that barrel is fusing
			if (this.room && this.room.io) {
				this.room.io.to(this.room.id).emit('barrelFuseStart', {
					id: barrel.id,
					x: barrel.x,
					y: barrel.y,
					fuseDuration: 2.0
				});
			}
			
			// Auto-destruct over 2 seconds
			const fuseDuration = 2000; // 2 seconds
			const tickInterval = 100; // Update every 100ms
			const totalTicks = fuseDuration / tickInterval;
			const damagePerTick = barrel.health / totalTicks;
			let tickCount = 0;
			
			const fuseInterval = setInterval(() => {
				tickCount++;
				
				// Check if barrel still exists and hasn't exploded
				const currentBarrel = this.explodingBarrels.find(b => b.id === barrelId);
				if (!currentBarrel || currentBarrel.exploded) {
					clearInterval(fuseInterval);
					return;
				}
				
				// Reduce health
				currentBarrel.health -= damagePerTick;
				
				// Broadcast health update for visual sync
				if (this.room && this.room.io) {
					this.room.io.to(this.room.id).emit('barrelHit', {
						id: currentBarrel.id,
						x: currentBarrel.x,
						y: currentBarrel.y,
						health: currentBarrel.health,
						healthMax: currentBarrel.healthMax,
						fusing: true
					});
				}
				
				// Explode when health depleted or time's up
				if (currentBarrel.health <= 0 || tickCount >= totalTicks) {
					clearInterval(fuseInterval);
					currentBarrel.health = 0;
					currentBarrel.exploded = true;
					this.explodeBarrel(currentBarrel);
				}
			}, tickInterval);
		}
		
		return false;
	}
	
	/**
	 * Damage all barrels within a circular radius (for melee, explosions)
	 * @returns {boolean} True if any barrel was hit
	 */
	damageBarrelInRadius(cx, cy, radius, damage = 10) {
		let anyHit = false;
		for (const barrel of this.explodingBarrels) {
			if (barrel.exploded) continue;
			
			const dist = Math.hypot(barrel.x - cx, barrel.y - cy);
			const barrelRadius = barrel.visualRadius || 24;
			
			if (dist <= radius + barrelRadius) {
				this.damageBarrel(barrel.id, damage, barrel.x, barrel.y);
				anyHit = true;
			}
		}
		return anyHit;
	}
	
	/**
	 * Check if a bullet line hits any barrel and apply damage
	 * @returns {object|null} Hit barrel info or null
	 */
	damageBarrelFromBulletLine(x1, y1, x2, y2, damage = 10) {
		for (const barrel of this.explodingBarrels) {
			if (barrel.exploded) continue;
			
			const r = barrel.visualRadius || 24;
			
			// Line-circle intersection test
			const dx = x2 - x1;
			const dy = y2 - y1;
			const fx = x1 - barrel.x;
			const fy = y1 - barrel.y;
			
			const a = dx * dx + dy * dy;
			const b = 2 * (fx * dx + fy * dy);
			const c = fx * fx + fy * fy - r * r;
			
			const discriminant = b * b - 4 * a * c;
			
			if (discriminant >= 0) {
				const sqrtD = Math.sqrt(discriminant);
				const t1 = (-b - sqrtD) / (2 * a);
				const t2 = (-b + sqrtD) / (2 * a);
				
				// Check if intersection is on the line segment
				if ((t1 >= 0 && t1 <= 1) || (t2 >= 0 && t2 <= 1)) {
					// Calculate hit point
					const t = Math.max(0, Math.min(1, t1 >= 0 ? t1 : t2));
					const hitX = x1 + t * dx;
					const hitY = y1 + t * dy;
					
					this.damageBarrel(barrel.id, damage, hitX, hitY);
					return { barrel: barrel, x: hitX, y: hitY };
				}
			}
		}
		return null;
	}
	
	/**
	 * Explode a barrel - damages players and enemies in radius
	 */
	explodeBarrel(barrel) {
		if (!barrel) return;
		
		const x = barrel.x;
		const y = barrel.y;
		const radius = barrel.explosionRadius;
		const baseDamage = barrel.explosionDamage;
		// Tuning: make barrels more dangerous to enemies and have environmental impact
		const enemyDamageMultiplier = 3;
		const sandbagDestroyDamage = 9999;
		
		console.log(`[Hazards] Barrel ${barrel.id} exploding at (${x.toFixed(0)}, ${y.toFixed(0)})`);
		
		// Damage enemies (collect dead enemies to process after iteration, like artillery)
	const enemyHits = [];
	const enemiesToDelete = [];
	if (this.room.enemies) {
		for (const [id, enemy] of this.room.enemies) {
			if (!enemy || !enemy.alive) continue;
			// Skip friendly structures
			if (enemy.type === 'defenseTurret' || enemy.type === 'artilleryGun') continue;
			
			const dx = enemy.x - x;
			const dy = enemy.y - y;
			const dist = Math.hypot(dx, dy);
			
			if (dist <= radius + (enemy.radius || 26)) {
				// Falloff damage (100% at center, 40% at edge)
				const t = Math.max(0, Math.min(1, dist / radius));
				// 3x damage to enemies so barrels are a meaningful threat to them too
				const damage = Math.round(baseDamage * enemyDamageMultiplier * (1 - t * 0.6));
				
				enemy.health -= damage;
				if (enemy.health <= 0) {
					enemy.health = 0;
					enemy.alive = false;
					// Mark for death (don't delete during iteration)
					enemiesToDelete.push({ id: id, x: enemy.x, y: enemy.y, type: enemy.type });
				}
				
				enemyHits.push({ id: id, damage: damage });
			}
		}
	}

	// Environmental impact: barrel explosions can destroy sandbags in range
	try { this.damageCircle(x, y, radius, sandbagDestroyDamage); } catch(_) {}
	
	// Now safely delete dead enemies after iteration and broadcast deaths
	for (const deadEnemy of enemiesToDelete) {
		// If a Licker died to the barrel, clear its ensnare from all players
		try {
			if (this.room && typeof this.room._clearLickerEnsnareOnDeath === 'function') {
				this.room._clearLickerEnsnareOnDeath(deadEnemy.id, deadEnemy.type);
			}
		} catch (e) {
			console.error('[Hazards] Failed to clear licker ensnare on barrel kill:', e);
		}

		this.room.enemies.delete(deadEnemy.id);
		if (this.room.io) {
			this.room.io.to(this.room.id).emit('enemy_dead', {
				id: deadEnemy.id,
				x: deadEnemy.x,
				y: deadEnemy.y,
				type: deadEnemy.type || 'basic'
			});
			this.room.io.to(this.room.id).emit('entity_dead', {
				entityType: 'enemy',
				id: deadEnemy.id,
				x: deadEnemy.x,
				y: deadEnemy.y,
				kind: deadEnemy.type || 'basic'
			});
		}
	}
	
	// Damage players (server-authoritative, matching boomer explosion pattern)
	const playerHits = [];
	if (this.room.players) {
		for (const [playerId, p] of this.room.players) {
			if (!p || p.health <= 0) continue;
			// Skip invincible players
			if (p.invincible === true) continue;
			
			const dx = (p.x || 0) - x;
			const dy = (p.y || 0) - y;
			const dist = Math.hypot(dx, dy);
			
			if (dist <= radius + (p.radius || 26)) {
				const healthBefore = p.health;
				
				// Falloff damage (100% at center, 40% at edge)
				const t = Math.max(0, Math.min(1, dist / radius));
				const rawDamage = baseDamage * (1 - t * 0.6);
				
				// Apply armor reduction (cap at 75%)
				const armorPercent = Number.isFinite(p.armor) ? p.armor : 0;
				const reduction = Math.min(0.75, armorPercent / 100);
				const damage = Math.round(rawDamage * (1 - reduction));
				
				p.health = Math.max(0, (p.health || 0) - damage);
				
				// Broadcast health to player and room
				try { 
					if (p.socket) p.socket.emit('playerHealth', { health: p.health, from: 'barrel' }); 
				} catch(_) {}
				if (this.room.io) {
					this.room.io.to(this.room.id).emit('playerHealthUpdate', { playerId: p.id, health: p.health });
				}
				
				// Check for death
				if (p.health <= 0 && healthBefore > 0) {
					if (typeof this.room._handlePlayerDeath === 'function') {
						this.room._handlePlayerDeath(p.id, p, this.room.io);
					}
				}
				
				playerHits.push({ playerId: playerId, damage: damage });
			}
		}
	}
	
	// Damage troops (server-authoritative)
	const troopHits = [];
	if (this.room.troopManager && this.room.troopManager.troops) {
		for (const [, troop] of this.room.troopManager.troops) {
			if (!troop || !troop.alive || troop.health <= 0) continue;
			
			const troopX = Number(troop.x) || 0;
			const troopY = Number(troop.y) || 0;
			const troopRadius = troop.radius || 22;
			
			const dx = troopX - x;
			const dy = troopY - y;
			const dist = Math.hypot(dx, dy);
			
			if (dist <= radius + troopRadius) {
				// Falloff damage (100% at center, 40% at edge)
				const t = Math.max(0, Math.min(1, dist / radius));
				const damage = Math.round(baseDamage * (1 - t * 0.6));
				
				troop.health = Math.max(0, troop.health - damage);
				
				// Broadcast troop damage
				if (this.room.io) {
					this.room.io.to(this.room.id).emit('troopDamaged', {
						troopId: troop.id,
						damage: damage,
						health: troop.health,
						healthMax: troop.healthMax,
						x: troopX,
						y: troopY
					});
				}
				
				// Check if troop died
				if (troop.health <= 0) {
					troop.alive = false;
					console.log(`[Hazards] Troop ${troop.id} killed by barrel explosion`);
					
					// Broadcast troop death
					if (this.room.io) {
						this.room.io.to(this.room.id).emit('troopDeath', {
							troopId: troop.id,
							x: troopX,
							y: troopY
						});
						this.room.io.to(this.room.id).emit('entity_dead', {
							entityType: 'troop',
							id: troop.id,
							x: troopX,
							y: troopY,
							kind: troop.type || 'troop',
							cause: 'barrel_explosion'
						});
					}
				}
				
				troopHits.push({ troopId: troop.id, damage: damage });
			}
		}
	}
		
		// Chain reaction - check if explosion hits other barrels
		const chainBarrels = [];
		for (const otherBarrel of this.explodingBarrels) {
			if (otherBarrel.id === barrel.id || otherBarrel.exploded) continue;
			
			const dist = Math.hypot(otherBarrel.x - x, otherBarrel.y - y);
			if (dist <= radius + (otherBarrel.visualRadius || 24)) {
				// Queue for chain explosion (don't damage immediately to avoid recursion issues)
				const t = Math.max(0, Math.min(1, dist / radius));
				const damage = Math.round(baseDamage * (1 - t * 0.6));
				chainBarrels.push({ barrel: otherBarrel, damage: damage });
			}
		}
		
		// Broadcast explosion event
		if (this.room.io) {
			this.room.io.to(this.room.id).emit('barrelExploded', {
				id: barrel.id,
				x: x,
				y: y,
				radius: radius,
				enemyHits: enemyHits,
				playerHits: playerHits,
				troopHits: troopHits
			});
		}
		
		// Remove from collection
		const idx = this.explodingBarrels.indexOf(barrel);
		if (idx >= 0) {
			this.explodingBarrels.splice(idx, 1);
		}
		
		// Process chain explosions after a small delay (stagger for visual effect)
		for (const chain of chainBarrels) {
			setTimeout(() => {
				this.damageBarrel(chain.barrel.id, chain.damage);
			}, 50 + Math.random() * 100);
		}
	}
	
	/**
	 * Check if a point hits any barrel, apply damage if so
	 * @returns {object|null} Hit barrel info or null
	 */
	damageBarrelAtPoint(x, y, damage) {
		for (const barrel of this.explodingBarrels) {
			if (barrel.exploded) continue;
			
			const dist = Math.hypot(barrel.x - x, barrel.y - y);
			if (dist <= (barrel.visualRadius || 24)) {
				this.damageBarrel(barrel.id, damage);
				return barrel;
			}
		}
		return null;
	}

	serialize() {
		return {
			sandbags: this.sandbags,
			barbedWire: this.barbedWire,
			mudPools: this.mudPools,
			trenches: this.trenches,
			firePools: this.firePools,
			gasCanisters: this.gasCanisters,
			artilleryGuns: this.artilleryGuns,
			explodingBarrels: this.explodingBarrels.map(b => ({
				id: b.id,
				x: b.x,
				y: b.y,
				health: b.health,
				healthMax: b.healthMax,
				explosionRadius: b.explosionRadius,
				explosionDamage: b.explosionDamage,
				visualRadius: b.visualRadius
			}))
		};
	}

	static _pointToSegmentDist(px, py, x1, y1, x2, y2) {
		const vx = x2 - x1; const vy = y2 - y1;
		const wx = px - x1; const wy = py - y1;
		const c1 = vx * wx + vy * wy;
		if (c1 <= 0) return Math.hypot(px - x1, py - y1);
		const c2 = vx * vx + vy * vy;
		if (c2 <= c1) return Math.hypot(px - x2, py - y2);
		const b = c1 / c2;
		const bx = x1 + b * vx; const by = y1 + b * vy;
		return Math.hypot(px - bx, py - by);
	}

	// Damage sandbags if bullet segment intersects any sandbag rectangle; returns true if a sandbag was hit
	damageFromBulletLine(x1, y1, x2, y2, damage = 10) {
		let hit = false;
		for (let i = 0; i < this.sandbags.length; i++) {
			const sb = this.sandbags[i];
			if (!sb) continue;
			
			// Check collision based on whether sandbag is rotated
			let intersects = false;
			if (sb.angle && sb.angle !== 0) {
				// Use oriented box collision for rotated sandbags (diagonals)
				intersects = CollisionHelpers.lineIntersectsOrientedBox(x1, y1, x2, y2, {
					x: sb.x,
					y: sb.y,
					w: sb.w,
					h: sb.h,
					angle: sb.angle
				});
			} else {
				// Use AABB for axis-aligned sandbags (horizontal/vertical)
				intersects = EnvironmentHazards._segmentIntersectsRect(x1, y1, x2, y2, sb.x, sb.y, sb.w, sb.h);
			}
			
			if (intersects) {
				// Apply damage
				sb.health = Math.max(0, (Number(sb.health) || 0) - damage);
				hit = true;

				// Approximate hit point for VFX feedback
				const hp = EnvironmentHazards._segmentRectHitPoint(x1, y1, x2, y2, sb.x, sb.y, sb.w, sb.h) || { x: sb.x, y: sb.y };
				try {
					this.room && this.room.io && this.room.io.to(this.room.id).emit('hazardHit', {
						type: 'sandbag', id: sb.id, x: hp.x, y: hp.y, health: sb.health
					});
				} catch(_) {}

				if (sb.health <= 0) {
					// Remove collision oriented box and hazard entry
					if (Number.isInteger(sb.boxIndex) && sb.boxIndex >= 0 && this.env.orientedBoxes && sb.boxIndex < this.env.orientedBoxes.length) {
						this.env.orientedBoxes.splice(sb.boxIndex, 1);
						// Fix indices of subsequent sandbags
						for (let j = 0; j < this.sandbags.length; j++) {
							if (this.sandbags[j] && this.sandbags[j].boxIndex > sb.boxIndex) {
								this.sandbags[j].boxIndex -= 1;
							}
						}
					}
					// Capture location for client ground sand pile visual
					const rmPayload = { type: 'sandbag', id: sb.id, x: sb.x, y: sb.y, w: sb.w, h: sb.h, variant: sb.variant, angle: sb.angle };
					this.sandbags.splice(i, 1);
					i--;
					try { this.room && this.room.io && this.room.io.to(this.room.id).emit('hazardRemoved', rmPayload); } catch(_) {}
				}
				break; // one sandbag per bullet
			}
		}
		return hit;
	}

	// Internal helper: apply direct damage to single sandbag and handle removal/emits
	_damageSandbag(sb, damage, hitX, hitY) {
		if (!sb) return false;
		sb.health = Math.max(0, (Number(sb.health) || 0) - Math.max(0, damage || 0));
		try {
			this.room && this.room.io && this.room.io.to(this.room.id).emit('hazardHit', {
				type: 'sandbag', id: sb.id,
				x: hitX != null ? hitX : sb.x,
				y: hitY != null ? hitY : sb.y,
				health: sb.health
			});
		} catch(_) {}
		if (sb.health <= 0) {
			if (Number.isInteger(sb.boxIndex) && sb.boxIndex >= 0 && this.env.orientedBoxes && sb.boxIndex < this.env.orientedBoxes.length) {
				this.env.orientedBoxes.splice(sb.boxIndex, 1);
				for (let j = 0; j < this.sandbags.length; j++) {
					if (this.sandbags[j] && this.sandbags[j].boxIndex > sb.boxIndex) this.sandbags[j].boxIndex -= 1;
				}
			}
			const rmPayload = { type: 'sandbag', id: sb.id, x: sb.x, y: sb.y, w: sb.w, h: sb.h, variant: sb.variant, angle: sb.angle };
			const idx = this.sandbags.indexOf(sb);
			if (idx >= 0) this.sandbags.splice(idx, 1);
			try { this.room && this.room.io && this.room.io.to(this.room.id).emit('hazardRemoved', rmPayload); } catch(_) {}
			return true;
		}
		return false;
	}

	/** Apply circular damage to sandbags (explosions, melee, flames) */
	damageCircle(cx, cy, radius, damage) {
		if (!Array.isArray(this.sandbags) || this.sandbags.length === 0) return false;
		let any = false;
		for (let i = this.sandbags.length - 1; i >= 0; i--) {
			const sb = this.sandbags[i]; if (!sb) continue;
			
			// Check collision based on whether sandbag is rotated
			let intersects = false;
			let closestX = sb.x, closestY = sb.y;
			
			if (sb.angle && sb.angle !== 0) {
				// Use oriented box collision for rotated sandbags (diagonals)
				intersects = CollisionHelpers.circleIntersectsOrientedBox(cx, cy, radius, {
					x: sb.x,
					y: sb.y,
					w: sb.w,
					h: sb.h,
					angle: sb.angle
				});
			} else {
				// Use AABB for axis-aligned sandbags (horizontal/vertical)
				const hw = sb.w / 2, hh = sb.h / 2;
				closestX = Math.max(sb.x - hw, Math.min(cx, sb.x + hw));
				closestY = Math.max(sb.y - hh, Math.min(cy, sb.y + hh));
				const dx = cx - closestX; const dy = cy - closestY;
				const r2 = radius * radius;
				intersects = (dx*dx + dy*dy <= r2);
			}
			
			if (intersects) {
				any = true;
				this._damageSandbag(sb, damage, closestX, closestY);
			}
		}
		return any;
	}

	// --- Cone helpers (Weapon 1 style) ---
	static _angleDiff(a, b) {
		let d = a - b;
		while (d > Math.PI) d -= Math.PI * 2;
		while (d < -Math.PI) d += Math.PI * 2;
		return d;
	}

	static _pointInCone(px, py, ox, oy, ang, coneRange, coneHalf, extraR = 0) {
		const dx = px - ox;
		const dy = py - oy;
		const r = (Number(coneRange) || 0) + (Number(extraR) || 0);
		if (dx * dx + dy * dy > r * r) return false;
		const a = Math.atan2(dy, dx);
		return Math.abs(EnvironmentHazards._angleDiff(a, ang)) <= (Number(coneHalf) || 0);
	}

	static _closestPointOnOrientedBox(px, py, box) {
		// box: {x,y,w,h,angle}
		const hw = (Number(box.w) || 0) * 0.5;
		const hh = (Number(box.h) || 0) * 0.5;
		const ang = Number(box.angle) || 0;

		// translate into box space
		const tx = px - (Number(box.x) || 0);
		const ty = py - (Number(box.y) || 0);

		// rotate by -ang
		const ca = Math.cos(-ang);
		const sa = Math.sin(-ang);
		const lx = tx * ca - ty * sa;
		const ly = tx * sa + ty * ca;

		// clamp to box extents
		const clx = Math.max(-hw, Math.min(hw, lx));
		const cly = Math.max(-hh, Math.min(hh, ly));

		// rotate back by +ang and translate back
		const cb = Math.cos(ang);
		const sb = Math.sin(ang);
		return {
			x: clx * cb - cly * sb + (Number(box.x) || 0),
			y: clx * sb + cly * cb + (Number(box.y) || 0)
		};
	}

	/** Damage barrels that lie within a cone (weapon1-style melee arc) */
	damageBarrelsInCone(ox, oy, ang, coneRange, coneHalf, damage = 10) {
		if (!Array.isArray(this.explodingBarrels) || this.explodingBarrels.length === 0) return false;
		let any = false;
		for (const barrel of this.explodingBarrels) {
			if (!barrel || barrel.exploded) continue;
			const br = Number(barrel.visualRadius) || 24;
			if (EnvironmentHazards._pointInCone(barrel.x, barrel.y, ox, oy, ang, coneRange, coneHalf, br)) {
				this.damageBarrel(barrel.id, damage, barrel.x, barrel.y);
				any = true;
			}
		}
		return any;
	}

	/** Damage sandbags that intersect a cone (approx via closest-point + corners sampling) */
	damageSandbagsInCone(ox, oy, ang, coneRange, coneHalf, damage = 10) {
		if (!Array.isArray(this.sandbags) || this.sandbags.length === 0) return false;
		let any = false;

		for (let i = this.sandbags.length - 1; i >= 0; i--) {
			const sb = this.sandbags[i];
			if (!sb || (sb.health != null && sb.health <= 0)) continue;

			const box = { x: sb.x, y: sb.y, w: sb.w, h: sb.h, angle: sb.angle || 0 };
			const hw = (Number(sb.w) || 0) * 0.5;
			const hh = (Number(sb.h) || 0) * 0.5;
			const boxAng = Number(sb.angle) || 0;

			// Sample points: closest point from player -> box, center, and 4 corners.
			const pts = [];
			pts.push(EnvironmentHazards._closestPointOnOrientedBox(ox, oy, box));
			pts.push({ x: Number(sb.x) || 0, y: Number(sb.y) || 0 });

			const ca = Math.cos(boxAng);
			const sa = Math.sin(boxAng);
			const cornersLocal = [
				{ x: -hw, y: -hh },
				{ x: hw, y: -hh },
				{ x: hw, y: hh },
				{ x: -hw, y: hh }
			];
			for (let c = 0; c < cornersLocal.length; c++) {
				const p = cornersLocal[c];
				pts.push({
					x: (Number(sb.x) || 0) + p.x * ca - p.y * sa,
					y: (Number(sb.y) || 0) + p.x * sa + p.y * ca
				});
			}

			let hit = false;
			let hitPt = pts[0];
			for (let p = 0; p < pts.length; p++) {
				const q = pts[p];
				if (EnvironmentHazards._pointInCone(q.x, q.y, ox, oy, ang, coneRange, coneHalf, 0)) {
					hit = true;
					hitPt = q;
					break;
				}
			}

			if (hit) {
				any = true;
				this._damageSandbag(sb, damage, hitPt.x, hitPt.y);
			}
		}

		return any;
	}

	static _segmentIntersectsRect(x1, y1, x2, y2, cx, cy, w, h) {
		const left = cx - w / 2, right = cx + w / 2, top = cy - h / 2, bottom = cy + h / 2;
		// Liang-Barsky or simple Cohen–Sutherland style clipping
		let t0 = 0, t1 = 1;
		const dx = x2 - x1, dy = y2 - y1;
		const p = [-dx, dx, -dy, dy];
		const q = [x1 - left, right - x1, y1 - top, bottom - y1];
		for (let i = 0; i < 4; i++) {
			if (p[i] === 0) {
				if (q[i] < 0) return false; // Parallel and outside
			} else {
				const r = q[i] / p[i];
				if (p[i] < 0) {
					if (r > t1) return false;
					if (r > t0) t0 = r;
				} else {
					if (r < t0) return false;
					if (r < t1) t1 = r;
				}
			}
		}
		return t0 <= t1;
	}

	static _segmentRectHitPoint(x1,y1,x2,y2, cx,cy,w,h) {
		const left = cx - w/2, right = cx + w/2, top = cy - h/2, bottom = cy + h/2;
		const pts = [
			EnvironmentHazards._segmentLineIntersection(x1,y1,x2,y2, left,top, right,top),
			EnvironmentHazards._segmentLineIntersection(x1,y1,x2,y2, right,top, right,bottom),
			EnvironmentHazards._segmentLineIntersection(x1,y1,x2,y2, left,bottom, right,bottom),
			EnvironmentHazards._segmentLineIntersection(x1,y1,x2,y2, left,top, left,bottom)
		].filter(Boolean);
		if (pts.length > 0) return pts[0];
		// Fallback: closest point on segment to rect center
		const denom = (x2 - x1)*(x2 - x1) + (y2 - y1)*(y2 - y1);
		const t = denom > 0 ? Math.max(0, Math.min(1, ((cx - x1)*(x2 - x1) + (cy - y1)*(y2 - y1)) / denom)) : 0;
		return { x: x1 + t*(x2 - x1), y: y1 + t*(y2 - y1) };
	}

	static _segmentLineIntersection(x1,y1,x2,y2, x3,y3,x4,y4) {
		const den = (x1-x2)*(y3-y4) - (y1-y2)*(x3-x4);
		if (Math.abs(den) < 1e-6) return null;
		const px = ((x1*y2 - y1*x2)*(x3 - x4) - (x1 - x2)*(x3*y4 - y3*x4)) / den;
		const py = ((x1*y2 - y1*x2)*(y3 - y4) - (y1 - y2)*(x3*y4 - y3*x4)) / den;
		const onSeg = (a,b,c) => Math.min(a,c)-1e-3 <= b && b <= Math.max(a,c)+1e-3;
		if (onSeg(x1,px,x2) && onSeg(y1,py,y2) && onSeg(x3,px,x4) && onSeg(y3,py,y4)) return { x: px, y: py };
		return null;
	}

	// ========== BARBED WIRE PATTERN GENERATORS ==========

	/**
	 * Generate tangled/jumbled wire - random overlapping segments
	 * Returns array of line segments: [{x1, y1, x2, y2}, ...]
	 */
	_generateTangledWire(cx, cy, length, numSegments) {
		const segments = [];
		const halfLen = length / 2;
		let px = cx - halfLen;
		let py = cy;

		// Create a chaotic, overlapping path
		for (let i = 0; i < numSegments; i++) {
			const x1 = px;
			const y1 = py;
			
			// Random next point with constraints
			const stepX = (length / numSegments) * (0.7 + Math.random() * 0.6);
			const stepY = (Math.random() - 0.5) * 80; // vertical chaos
			
			px = x1 + stepX;
			py = y1 + stepY;
			
			// Add some backtracking for tangled effect
			if (Math.random() < 0.3) {
				px -= stepX * 0.4;
			}
			
			segments.push({ x1, y1, x2: px, y2: py });
		}
		
		return segments;
	}

	/**
	 * Generate spiral/coil wire - circular helix pattern
	 * Returns {radius, coils, spacing, points: [{x, y}, ...]}
	 */
	_generateSpiralWire(cx, cy, radius, numCoils, coilSpacing) {
		const points = [];
		const segmentsPerCoil = 16;
		const totalSegments = numCoils * segmentsPerCoil;
		
		for (let i = 0; i <= totalSegments; i++) {
			const t = i / segmentsPerCoil; // coil progress
			const angle = t * Math.PI * 2;
			const offsetX = t * coilSpacing - (numCoils * coilSpacing / 2);
			
			points.push({
				x: cx + offsetX + Math.cos(angle) * radius,
				y: cy + Math.sin(angle) * radius
			});
		}
		
		return {
			radius,
			coils: numCoils,
			spacing: coilSpacing,
			points
		};
	}

	/**
	 * Generate triple concertina fence - 3 layers of coiled wire with posts
	 * Like Fig. 3 in the reference image
	 * Returns {rows: [{y, coils: [{x, radius}]}, ...], posts: [{x, y}]}
	 */
	_generateTripleConcertina(cx, cy, length, rowsDeep) {
		const halfLen = length / 2;
		const coilRadius = 40;
		const coilSpacing = coilRadius * 2.2;
		const numCoils = Math.floor(length / coilSpacing);
		
		const rows = [];
		const posts = [];
		const rowSpacing = coilRadius * 2.4;
		
		// Generate 3 rows offset vertically
		for (let row = 0; row < 3; row++) {
			const rowY = cy + (row - 1) * rowSpacing; // -1, 0, +1 for vertical spread
			const coils = [];
			
			// Offset alternate rows slightly for stagger effect
			const offsetX = (row % 2) * (coilSpacing / 2);
			
			for (let i = 0; i < numCoils; i++) {
				const coilX = cx - halfLen + i * coilSpacing + offsetX;
				coils.push({ x: coilX, y: rowY, radius: coilRadius });
			}
			
			rows.push({ y: rowY, coils });
		}
		
		// Add support posts at intervals
		const postSpacing = length / 4;
		for (let i = 0; i <= 4; i++) {
			posts.push({
				x: cx - halfLen + i * postSpacing,
				y: cy,
				height: rowSpacing * 3
			});
		}
		
		return { rows, posts };
	}

	/**
	 * Generate double apron fence - angled wire from center stakes
	 * Like Fig. 4 in the reference image
	 * Returns {centerLine: [{x, y}], stakes: [{x, y, wires: [{x1,y1,x2,y2}]}]}
	 */
	_generateDoubleApron(cx, cy, length, numStakes) {
		const halfLen = length / 2;
		const stakeSpacing = length / (numStakes - 1);
		const apronWidth = 100; // how far wires extend perpendicular to center
		const stakes = [];
		const centerLine = [];
		
		// Center line stakes
		for (let i = 0; i < numStakes; i++) {
			const sx = cx - halfLen + i * stakeSpacing;
			const sy = cy;
			centerLine.push({ x: sx, y: sy });
			
			const wires = [];
			
			// Wires extending upward and downward at angles (apron effect)
			const numWiresPerSide = 5;
			for (let w = 0; w < numWiresPerSide; w++) {
				const progress = (w + 1) / numWiresPerSide;
				const wireLen = apronWidth * progress;
				const angle = Math.PI / 6; // 30 degrees
				
				// Upper apron wire
				wires.push({
					x1: sx,
					y1: sy,
					x2: sx + Math.sin(angle) * wireLen,
					y2: sy - Math.cos(angle) * wireLen
				});
				
				// Lower apron wire
				wires.push({
					x1: sx,
					y1: sy,
					x2: sx - Math.sin(angle) * wireLen,
					y2: sy + Math.cos(angle) * wireLen
				});
			}
			
			// Connect to next stake with horizontal wires at different heights
			if (i < numStakes - 1) {
				const nextX = sx + stakeSpacing;
				for (let h = -1; h <= 1; h++) {
					wires.push({
						x1: sx,
						y1: sy + h * 30,
						x2: nextX,
						y2: sy + h * 30
					});
				}
			}
			
			stakes.push({ x: sx, y: sy, wires });
		}
		
		return { centerLine, stakes };
	}
}

module.exports = { EnvironmentHazards };


