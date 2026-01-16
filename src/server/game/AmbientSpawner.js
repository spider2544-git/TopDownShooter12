// ============================================================================
// AMBIENT SPAWNER - Server-authoritative trickle spawns that scale over time
// ============================================================================
// Spawns scattered single enemies off-screen, escalating in tiers as time passes.
// Uses existing 'hordeSpawned' event so clients instantiate without changes.

class AmbientSpawner {
	constructor(room, config = {}) {
		this.room = room;
		this.io = room && room.io ? room.io : null;
		this.config = {
		ENABLED: true,
		SPAWN_ATTEMPTS: 48,
		OBSTACLE_CHECK_RADIUS: 42,  // 26 base radius + 16 movement clearance to prevent spawning too close to obstacles
		MIN_PLAYER_DISTANCE: 700,
		MIN_CAMERA_BUFFER: 240,
			MAX_PER_TICK: 12,
			// Default tiers; can be overridden per mode
			TIERS: [
				{ at: 0,   cap: 60,  rate: 0.8, typeRatios: { basic: 0.87, boomer: 0, projectile: 0.08, licker: 0, bigboy: 0, wallguy: 0.05 } },
				{ at: 120, cap: 120, rate: 1.2, typeRatios: { basic: 0.72, boomer: 0, projectile: 0.20, licker: 0, bigboy: 0, wallguy: 0.08 } },
				{ at: 240, cap: 180, rate: 1.6, typeRatios: { basic: 0.60, boomer: 0.10, projectile: 0.18, licker: 0, bigboy: 0, wallguy: 0.12 } },
				{ at: 420, cap: 240, rate: 2.0, typeRatios: { basic: 0.45, boomer: 0.15, projectile: 0.18, licker: 0.10, bigboy: 0, wallguy: 0.12 } }
			],
			...config
		};
		this._elapsed = 0;
		this._currentTierIndex = 0;
		this._spawnAccumulator = 0;
		this._ambientIds = new Set();
		this._baselineIds = new Set();
		this._initialBaselineTotal = 0;
	}

	getDebugState() {
		const tier = this._getCurrentTier() || {};
		const dynamicAlive = this._countAmbientAlive();
		const baselineAlive = this._baselineIds ? this._baselineIds.size : 0;
		return {
			elapsed: this._elapsed,
			tierIdx: this._currentTierIndex,
			tierCapDynamic: tier.cap || 0,
			rate: tier.rate || 0,
			baselineAlive,
			dynamicAlive,
			totalAmbientAlive: baselineAlive + dynamicAlive,
			spawnedTotal: (this.room && this.room._ambientDebug ? this.room._ambientDebug.spawnedTotal : 0)
		};
	}

	onLevelStart() {
		this._elapsed = 0;
		this._currentTierIndex = 0;
		this._spawnAccumulator = 0;
		this._ambientIds.clear();
		this._baselineIds.clear();
		this._initialBaselineTotal = 0;
        if (typeof process !== 'undefined' && process && process.env && process.env.NODE_ENV !== 'production') {
            try { console.log('[AmbientSpawner] onLevelStart - config tiers:', this.config.TIERS?.length || 0); } catch(_) {}
        }
	}

	update(deltaTime) {
		if (!this.config.ENABLED) return;
		if (!this.room || this.room.scene !== 'level') return;
		if (!this.room.currentGameMode) return;

		this._elapsed += deltaTime;
		const tier = this._getCurrentTier();
		if (!tier) return;

		const alive = this._countAmbientAlive();
		const deficit = Math.max(0, tier.cap - alive);
		// Accumulate fractional spawns over time
		this._spawnAccumulator += (tier.rate || 0) * deltaTime;
		let toSpawn = Math.min(deficit, Math.floor(this._spawnAccumulator));
		this._spawnAccumulator -= toSpawn;
		if (toSpawn <= 0) return;

		toSpawn = Math.min(toSpawn, this.config.MAX_PER_TICK);
		const rng = this.room._rng(Date.now() + Math.random() * 1e9);
		const batch = [];

		for (let i = 0; i < toSpawn; i++) {
			const pos = this._findScatterSpawn(rng);
			if (!pos) continue;
			const id = `enemy_${this.room.nextEnemyId++}`;
			const type = this._pickType(tier.typeRatios, rng);
			const enemy = {
				id,
				x: pos.x,
				y: pos.y,
				type,
				radius: 26,
				health: 100,
				healthMax: 100,
				speedMul: 1.0,
				alive: true,
				_spawnedFrom: 'ambient',
				_ambientTier: this._currentTierIndex
			};
			this.room.currentGameMode.initializeEnemyStats(enemy);
			this.room.enemies.set(id, enemy);
			this._ambientIds.add(id);
			if (enemy._ambientBaseline === true) {
				this._baselineIds.add(id);
				this._initialBaselineTotal++;
			}
			batch.push(enemy);
		}

		if (batch.length > 0) {
			this.room.spawnAmbientBatch(batch);
			// Debug accounting for server-side
			if (this.room && this.room._ambientDebug) {
				this.room._ambientDebug.spawnedTotal += batch.length;
				const now = Date.now();
				if (now - (this.room._ambientDebug.lastSpawnLog || 0) > 2000) {
					this.room._ambientDebug.lastSpawnLog = now;
					try { console.log(`[AmbientSpawner] spawned batch: +${batch.length}, total: ${this.room._ambientDebug.spawnedTotal}, tier: ${this._currentTierIndex}`); } catch(_) {}
				}
			}
		}

		// Occasionally prune dead entries from tracking
		if (this._ambientIds.size > 0 && Math.random() < 0.1) {
			for (const id of Array.from(this._ambientIds)) {
				const e = this.room.enemies.get(id);
				if (!e || e.alive === false) this._ambientIds.delete(id);
			}
		}
		if (this._baselineIds.size > 0 && Math.random() < 0.1) {
			for (const id of Array.from(this._baselineIds)) {
				const e = this.room.enemies.get(id);
				if (!e || e.alive === false) this._baselineIds.delete(id);
			}
		}
	}

	_getCurrentTier() {
		const t = this._elapsed;
		const tiers = this.config.TIERS || [];
		while (this._currentTierIndex + 1 < tiers.length && t >= tiers[this._currentTierIndex + 1].at) {
			this._currentTierIndex++;
		}
		return tiers[this._currentTierIndex];
	}

	_countAmbientAlive() {
		let n = 0;
		for (const id of this._ambientIds) {
			const e = this.room.enemies.get(id);
			if (e && e.alive !== false && e._ambientBaseline !== true) n++;
		}
		return n;
	}

	_pickType(ratios, rng) {
		const r = rng();
		let acc = 0;
		const order = ['boomer','projectile','licker','bigboy','wallguy','basic'];
		for (const k of order) {
			const p = Math.max(0, (ratios && ratios[k]) || 0);
			acc += p;
			if (r < acc) return k;
		}
		return 'basic';
	}

	_findScatterSpawn(rng) {
		const env = this.room.environment;
		if (!env) return null;

		const rCheck = this.config.OBSTACLE_CHECK_RADIUS;
		const minPlayerDist = this.config.MIN_PLAYER_DISTANCE;
		const camPad = this.config.MIN_CAMERA_BUFFER;
		
		// Get spawn boundaries from game mode if available (e.g., trench raid battlefield)
		let minX = -10500, maxX = 10500, minY = -10500, maxY = 10500;
		if (this.room.currentGameMode && typeof this.room.currentGameMode.getEnemySpawnBounds === 'function') {
			const bounds = this.room.currentGameMode.getEnemySpawnBounds();
			if (bounds) {
				minX = bounds.minX !== undefined ? bounds.minX : minX;
				maxX = bounds.maxX !== undefined ? bounds.maxX : maxX;
				minY = bounds.minY !== undefined ? bounds.minY : minY;
				maxY = bounds.maxY !== undefined ? bounds.maxY : maxY;
			}
		}

		for (let a = 0; a < this.config.SPAWN_ATTEMPTS; a++) {
			const x = rng() * (maxX - minX) + minX;
			const y = rng() * (maxY - minY) + minY;

			if (!env.isInsideBounds(x, y, rCheck)) continue;
			if (env.circleHitsAny && env.circleHitsAny(x, y, rCheck)) continue;

			// Avoid on-screen spawns for any player (approximate viewport)
			let nearAnyCamera = false;
			for (const [, p] of this.room.players) {
				const dx = x - (p.x || 0);
				const dy = y - (p.y || 0);
				const halfW = (this.room.viewportWidth || 1280) / 2 + camPad;
				const halfH = (this.room.viewportHeight || 720) / 2 + camPad;
				if (Math.abs(dx) < halfW && Math.abs(dy) < halfH) { nearAnyCamera = true; break; }
			}
			if (nearAnyCamera) continue;

			// Keep distance from players
			let ok = true;
			for (const [, p] of this.room.players) {
				const dx = x - (p.x || 0);
				const dy = y - (p.y || 0);
				if (dx * dx + dy * dy < minPlayerDist * minPlayerDist) { ok = false; break; }
			}
			if (!ok) continue;

			return { x, y };
		}
		return null;
	}

    // Public helper: spawn a batch immediately (e.g., at level start)
    spawnImmediate(count = 0, options = {}) {
        const n = Math.max(0, Math.floor(Number(count) || 0));
        if (n <= 0) return 0;
        const rng = this.room._rng(Date.now() + Math.random() * 1e9);
        const batch = [];
        const useRatios = options.typeRatios && typeof options.typeRatios === 'object';
        const fixedType = options.type || null;
        const markBaseline = options.baseline === true;

        for (let i = 0; i < n; i++) {
            // Give a few extra attempts per unit for initial placement
            let pos = null;
            for (let tries = 0; tries < this.config.SPAWN_ATTEMPTS * 2 && !pos; tries++) {
                pos = this._findScatterSpawn(rng);
            }
            if (!pos) continue;

            const id = `enemy_${this.room.nextEnemyId++}`;
            const type = fixedType || (useRatios ? this._pickType(options.typeRatios, rng) : 'basic');
            const enemy = {
                id,
                x: pos.x,
                y: pos.y,
                type,
                radius: 26,
                health: 100,
                healthMax: 100,
                speedMul: 1.0,
                alive: true,
                _spawnedFrom: 'ambient',
                _ambientTier: this._currentTierIndex,
                _ambientBaseline: markBaseline
            };
            this.room.currentGameMode.initializeEnemyStats(enemy);
            this.room.enemies.set(id, enemy);

            // Track for pruning; baseline excluded from dynamic cap elsewhere
            this._ambientIds.add(id);
            if (markBaseline) {
                this._baselineIds.add(id);
                this._initialBaselineTotal++;
            }

            batch.push(enemy);
        }

        if (batch.length > 0) {
            this.room.spawnAmbientBatch(batch);
            if (this.room && this.room._ambientDebug) {
                this.room._ambientDebug.spawnedTotal += batch.length;
                try { console.log(`[AmbientSpawner] initial batch: +${batch.length}, total: ${this.room._ambientDebug.spawnedTotal}`); } catch(_) {}
            }
        }

        return batch.length;
    }
}

module.exports = { AmbientSpawner };



