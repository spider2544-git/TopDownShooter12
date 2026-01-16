class Environment {
	constructor(serverObstacles, levelConfig = null) {
		this.gridSize = 48;
		this.thickEvery = 4;
		
		// Use level config if provided, otherwise use default extraction colors
		if (levelConfig && typeof levelConfig === 'object') {
			this.bg = levelConfig.bg || '#0e0e12';
			this.lineThin = levelConfig.lineThin || '#151826';
			this.lineThick = levelConfig.lineThick || '#202431';
			this.wallColor = levelConfig.wallColor || '#1b1f2e';
			this.boundary = levelConfig.boundary || 11000;
			
			// Check if this level uses rectangular boundaries (e.g., trench raid)
			if (levelConfig.isRectangular) {
				this.isRectangular = true;
				this.width = levelConfig.width || 6000;
				this.height = levelConfig.height || 1500;
				this.halfWidth = this.width / 2;
				this.halfHeight = this.height / 2;
				this.boundary = levelConfig.boundary || Math.max(this.halfWidth, this.halfHeight); // Update boundary to match
				console.log(`[Environment] Using rectangular bounds: ${this.width}×${this.height}, boundary: ${this.boundary}`);
			} else {
				this.isRectangular = false;
			}
		} else {
			// Default extraction colors
			this.bg = '#0e0e12';
			this.lineThin = '#151826';
			this.lineThick = '#202431';
			this.wallColor = '#1b1f2e';
			this.boundary = 11000;
			this.isRectangular = false;
		}
		
		this.wallThickness = 120; // visual wall thickness
		this.maxRange = 10000;
		this.obstacles = [];
		this.orientedBoxes = []; // Rotated rectangles (shield walls) - exact rotation collision
		// Reserve a clear area around spawn so the player doesn't overlap obstacles
		this.spawnSafeX = 0;
		this.spawnSafeY = 0;
		this.spawnSafeRadius = 200;
                
                // Use server obstacles if provided (multiplayer), otherwise generate locally (single player)
                if (serverObstacles && Array.isArray(serverObstacles)) {
                        console.log('[Environment] Using server-authoritative obstacles:', serverObstacles.length);
                        this.obstacles = serverObstacles.slice(); // Copy the array
                } else {
                        console.log('[Environment] Generating local obstacles (single player mode)');
                        this._generateObstacles();
                }
        }

        // --- Collision helpers ---
        _clamp(v, min, max) { return v < min ? min : (v > max ? max : v); }

	_circleIntersectsRect(cx, cy, cr, ob) {
		const left = ob.x - ob.w / 2;
		const top = ob.y - ob.h / 2;
		const right = left + ob.w;
		const bottom = top + ob.h;
		const closestX = this._clamp(cx, left, right);
		const closestY = this._clamp(cy, top, bottom);
		const dx = cx - closestX;
		const dy = cy - closestY;
		return (dx * dx + dy * dy) < (cr * cr);
	}

	// Check if circle intersects a ROTATED rectangle (for diagonal walls like shield walls)
	_circleIntersectsOrientedBox(cx, cy, cr, box) {
		// Transform circle center to box's local coordinate space
		const dx = cx - box.x;
		const dy = cy - box.y;
		
		// Rotate by -angle to align box with axes
		const cos = Math.cos(-box.angle);
		const sin = Math.sin(-box.angle);
		const localX = dx * cos - dy * sin;
		const localY = dx * sin + dy * cos;
		
		// Now treat it as AABB collision in local space
		const halfW = box.w / 2;
		const halfH = box.h / 2;
		
		const closestX = this._clamp(localX, -halfW, halfW);
		const closestY = this._clamp(localY, -halfH, halfH);
		const distX = localX - closestX;
		const distY = localY - closestY;
		
		return (distX * distX + distY * distY) < (cr * cr);
	}

	// Check if line segment intersects a ROTATED rectangle (for fast projectiles vs shields)
	_lineIntersectsOrientedBox(x1, y1, x2, y2, box) {
		// Transform line endpoints to box's local coordinate space
		const cos = Math.cos(-box.angle);
		const sin = Math.sin(-box.angle);
		
		// Transform first endpoint
		const dx1 = x1 - box.x;
		const dy1 = y1 - box.y;
		const localX1 = dx1 * cos - dy1 * sin;
		const localY1 = dx1 * sin + dy1 * cos;
		
		// Transform second endpoint
		const dx2 = x2 - box.x;
		const dy2 = y2 - box.y;
		const localX2 = dx2 * cos - dy2 * sin;
		const localY2 = dx2 * sin + dy2 * cos;
		
		// Now use Liang-Barsky algorithm for segment vs AABB in local space
		const halfW = box.w / 2;
		const halfH = box.h / 2;
		const left = -halfW;
		const right = halfW;
		const top = -halfH;
		const bottom = halfH;
		
		let t0 = 0, t1 = 1;
		const dx = localX2 - localX1;
		const dy = localY2 - localY1;
		
		const clip = (p, q) => {
			if (p === 0) return q >= 0; // parallel and inside
			const r = q / p;
			if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
			else { if (r < t0) return false; if (r < t1) t1 = r; }
			return true;
		};
		
		if (!clip(-dx, localX1 - left)) return false;
		if (!clip(dx, right - localX1)) return false;
		if (!clip(-dy, localY1 - top)) return false;
		if (!clip(dy, bottom - localY1)) return false;
		
		return t0 <= t1;
	}

	// Resolve circle movement against static AABBs and oriented boxes by separating axes
        resolveCircleMove(x, y, radius, dx, dy) {
                let newX = x;
                let newY = y;

                // Collect collision info only when needed (cheap in the common case)
                let hits = null;
                const addHit = (h) => { (hits || (hits = [])).push(h); };
                // Move along X
                if (dx !== 0) {
                        newX += dx;
                        for (let i = 0; i < this.obstacles.length; i++) {
                                const ob = this.obstacles[i];
                                if (!this._circleIntersectsRect(newX, newY, radius, ob)) continue;
                                const left = ob.x - ob.w / 2;
                                const top = ob.y - ob.h / 2;
                                const right = left + ob.w;
                                const bottom = top + ob.h;
                                // Only resolve if vertically overlapping enough
                                if (newY + radius <= top || newY - radius >= bottom) continue;
                                addHit({
                                        kind: 'aabb',
                                        phase: 'x',
                                        index: i,
                                        type: ob.type,
                                        temporary: ob.temporary === true,
                                        x: ob.x, y: ob.y, w: ob.w, h: ob.h
                                });
                                if (dx > 0) newX = left - radius; else newX = right + radius;
                        }
                        // Check oriented boxes during X-axis movement
                        if (this.orientedBoxes) {
                                for (let i = 0; i < this.orientedBoxes.length; i++) {
                                        const box = this.orientedBoxes[i];
                                        if (!box) continue;
                                        if (!this._circleIntersectsOrientedBox(newX, newY, radius, box)) continue;
                                        addHit({
                                                kind: 'obox',
                                                phase: 'x',
                                                index: i,
                                                x: box.x, y: box.y, w: box.w, h: box.h, angle: box.angle || 0,
                                                isTrenchWall: !!box.isTrenchWall,
                                                abilityId: box._abilityId || null,
                                                hazardType: box._hazardType || null,
                                                hazardId: box._hazardId || null
                                        });
                                        
                                        const boxDx = newX - box.x;
                                        const boxDy = newY - box.y;
                                        const cos = Math.cos(-box.angle);
                                        const sin = Math.sin(-box.angle);
                                        const localX = boxDx * cos - boxDy * sin;
                                        const localY = boxDx * sin + boxDy * cos;
                                        
                                        const halfW = box.w / 2;
                                        const halfH = box.h / 2;
                                        const closestX = this._clamp(localX, -halfW, halfW);
                                        const closestY = this._clamp(localY, -halfH, halfH);
                                        
                                        const penX = localX - closestX;
                                        const penY = localY - closestY;
                                        const penDist = Math.hypot(penX, penY);
                                        
                                        if (penDist > 0.01) {
                                                const normalX = penX / penDist;
                                                const normalY = penY / penDist;
                                                const resolveLocalX = normalX * (radius - penDist);
                                                const resolveLocalY = normalY * (radius - penDist);
                                                // Only apply X component during X-axis movement
                                                const worldResolveX = resolveLocalX * cos + resolveLocalY * sin;
                                                newX += worldResolveX;
                                        }
                                }
                        }
                }
                // Move along Y
                if (dy !== 0) {
                        newY += dy;
                        for (let i = 0; i < this.obstacles.length; i++) {
                                const ob = this.obstacles[i];
                                if (!this._circleIntersectsRect(newX, newY, radius, ob)) continue;
                                const left = ob.x - ob.w / 2;
                                const top = ob.y - ob.h / 2;
                                const right = left + ob.w;
                                const bottom = top + ob.h;
                                // Only resolve if horizontally overlapping enough
                                if (newX + radius <= left || newX - radius >= right) continue;
                                addHit({
                                        kind: 'aabb',
                                        phase: 'y',
                                        index: i,
                                        type: ob.type,
                                        temporary: ob.temporary === true,
                                        x: ob.x, y: ob.y, w: ob.w, h: ob.h
                                });
                                if (dy > 0) newY = top - radius; else newY = bottom + radius;
                        }
                        // Check oriented boxes during Y-axis movement
                        if (this.orientedBoxes) {
                                for (let i = 0; i < this.orientedBoxes.length; i++) {
                                        const box = this.orientedBoxes[i];
                                        if (!box) continue;
                                        if (!this._circleIntersectsOrientedBox(newX, newY, radius, box)) continue;
                                        addHit({
                                                kind: 'obox',
                                                phase: 'y',
                                                index: i,
                                                x: box.x, y: box.y, w: box.w, h: box.h, angle: box.angle || 0,
                                                isTrenchWall: !!box.isTrenchWall,
                                                abilityId: box._abilityId || null,
                                                hazardType: box._hazardType || null,
                                                hazardId: box._hazardId || null
                                        });
                                        
                                        const boxDx = newX - box.x;
                                        const boxDy = newY - box.y;
                                        const cos = Math.cos(-box.angle);
                                        const sin = Math.sin(-box.angle);
                                        const localX = boxDx * cos - boxDy * sin;
                                        const localY = boxDx * sin + boxDy * cos;
                                        
                                        const halfW = box.w / 2;
                                        const halfH = box.h / 2;
                                        const closestX = this._clamp(localX, -halfW, halfW);
                                        const closestY = this._clamp(localY, -halfH, halfH);
                                        
                                        const penX = localX - closestX;
                                        const penY = localY - closestY;
                                        const penDist = Math.hypot(penX, penY);
                                        
                                        if (penDist > 0.01) {
                                                const normalX = penX / penDist;
                                                const normalY = penY / penDist;
                                                const resolveLocalX = normalX * (radius - penDist);
                                                const resolveLocalY = normalY * (radius - penDist);
                                                // Only apply Y component during Y-axis movement
                                                const worldResolveY = -resolveLocalX * sin + resolveLocalY * cos;
                                                newY += worldResolveY;
                                        }
                                }
                        }
                }
                
                // Boundary clamping (rectangular or square)
                const preClampX = newX, preClampY = newY;
                if (this.isRectangular) {
                        // Rectangular boundary clamping (e.g., Trench Raid)
                        const minX = -this.halfWidth + radius;
                        const maxX = this.halfWidth - radius;
                        const minY = -this.halfHeight + radius;
                        const maxY = this.halfHeight - radius;
                        if (newX > maxX) newX = maxX;
                        if (newX < minX) newX = minX;
                        if (newY > maxY) newY = maxY;
                        if (newY < minY) newY = minY;
                } else {
                        // Square boundary clamping (default)
                        const b = this.boundary;
                        if (newX > b - radius) newX = b - radius;
                        if (newX < -b + radius) newX = -b + radius;
                        if (newY > b - radius) newY = b - radius;
                        if (newY < -b + radius) newY = -b + radius;
                }
                if (preClampX !== newX || preClampY !== newY) {
                        addHit({
                                kind: 'bounds',
                                mode: this.isRectangular ? 'rect' : 'square',
                                from: { x: preClampX, y: preClampY },
                                to: { x: newX, y: newY }
                        });
                }

                const out = { x: newX, y: newY };
                if (hits) out.hits = hits;
                return out;
        }

        // Returns true if circle hits any obstacle
	circleHitsAny(cx, cy, cr) {
		// Check regular obstacles (AABB)
		for (let i = 0; i < this.obstacles.length; i++) {
			if (this._circleIntersectsRect(cx, cy, cr, this.obstacles[i])) return true;
		}
		// Check oriented boxes (rotated rectangles like shield walls)
		if (this.orientedBoxes) {
			for (let i = 0; i < this.orientedBoxes.length; i++) {
				if (this._circleIntersectsOrientedBox(cx, cy, cr, this.orientedBoxes[i])) return true;
			}
		}
		return false;
	}

	// Returns true if circle hits any obstacle, with optional filter for oriented boxes
	circleHitsAnyFiltered(cx, cy, cr, orientedBoxFilter = null) {
		// Check regular obstacles (AABB)
		for (let i = 0; i < this.obstacles.length; i++) {
			if (this._circleIntersectsRect(cx, cy, cr, this.obstacles[i])) return true;
		}
		// Check oriented boxes with optional filter
		if (this.orientedBoxes) {
			for (let i = 0; i < this.orientedBoxes.length; i++) {
				const box = this.orientedBoxes[i];
				// Apply filter if provided (return false to skip this box)
				if (orientedBoxFilter && !orientedBoxFilter(box)) continue;
				if (this._circleIntersectsOrientedBox(cx, cy, cr, box)) return true;
			}
		}
		return false;
	}

        // Returns true if the segment from (x1,y1) to (x2,y2) intersects any obstacle AABB or oriented box
        lineHitsAny(x1, y1, x2, y2) {
                const segIntersectsAabb = (x1, y1, x2, y2, ob) => {
                        const left = ob.x - ob.w / 2;
                        const top = ob.y - ob.h / 2;
                        const right = left + ob.w;
                        const bottom = top + ob.h;
                        // Liang-Barsky algorithm for segment vs AABB
                        let t0 = 0, t1 = 1;
                        const dx = x2 - x1;
                        const dy = y2 - y1;
                        const clip = (p, q) => {
                                if (p === 0) return q >= 0; // parallel and inside
                                const r = q / p;
                                if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
                                else { if (r < t0) return false; if (r < t1) t1 = r; }
                                return true;
                        };
                        if (!clip(-dx, x1 - left)) return false;
                        if (!clip(dx, right - x1)) return false;
                        if (!clip(-dy, y1 - top)) return false;
                        if (!clip(dy, bottom - y1)) return false;
                        return t0 <= t1;
                };
                
                // Check AABB obstacles
                for (let i = 0; i < this.obstacles.length; i++) {
                        if (segIntersectsAabb(x1, y1, x2, y2, this.obstacles[i])) return true;
                }
                
                // Check oriented boxes (rotated rectangles like shield walls)
                if (this.orientedBoxes) {
                        for (let i = 0; i < this.orientedBoxes.length; i++) {
                                if (this._lineIntersectsOrientedBox(x1, y1, x2, y2, this.orientedBoxes[i])) return true;
                        }
                }
                
                return false;
        }

        // Returns true if line hits any obstacle, with optional filter for oriented boxes
        lineHitsAnyFiltered(x1, y1, x2, y2, orientedBoxFilter = null) {
                const segIntersectsAabb = (x1, y1, x2, y2, ob) => {
                        const left = ob.x - ob.w / 2;
                        const top = ob.y - ob.h / 2;
                        const right = left + ob.w;
                        const bottom = top + ob.h;
                        let t0 = 0, t1 = 1;
                        const dx = x2 - x1;
                        const dy = y2 - y1;
                        const clip = (p, q) => {
                                if (p === 0) return q >= 0;
                                const r = q / p;
                                if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
                                else { if (r < t0) return false; if (r < t1) t1 = r; }
                                return true;
                        };
                        if (!clip(-dx, x1 - left)) return false;
                        if (!clip(dx, right - x1)) return false;
                        if (!clip(-dy, y1 - top)) return false;
                        if (!clip(dy, bottom - y1)) return false;
                        return t0 <= t1;
                };
                
                // Check AABB obstacles
                for (let i = 0; i < this.obstacles.length; i++) {
                        if (segIntersectsAabb(x1, y1, x2, y2, this.obstacles[i])) return true;
                }
                
                // Check oriented boxes with optional filter
                if (this.orientedBoxes) {
                        for (let i = 0; i < this.orientedBoxes.length; i++) {
                                const box = this.orientedBoxes[i];
                                // Apply filter if provided (return false to skip this box)
                                if (orientedBoxFilter && !orientedBoxFilter(box)) continue;
                                if (this._lineIntersectsOrientedBox(x1, y1, x2, y2, box)) return true;
                        }
                }
                
                return false;
        }

        // Returns true if line hits any obstacle, with optional filter for oriented boxes
        lineHitsAnyFiltered(x1, y1, x2, y2, orientedBoxFilter = null) {
                const segIntersectsAabb = (x1, y1, x2, y2, ob) => {
                        const left = ob.x - ob.w / 2;
                        const top = ob.y - ob.h / 2;
                        const right = left + ob.w;
                        const bottom = top + ob.h;
                        let t0 = 0, t1 = 1;
                        const dx = x2 - x1;
                        const dy = y2 - y1;
                        const clip = (p, q) => {
                                if (p === 0) return q >= 0;
                                const r = q / p;
                                if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
                                else { if (r < t0) return false; if (r < t1) t1 = r; }
                                return true;
                        };
                        if (!clip(-dx, x1 - left)) return false;
                        if (!clip(dx, right - x1)) return false;
                        if (!clip(-dy, y1 - top)) return false;
                        if (!clip(dy, bottom - y1)) return false;
                        return t0 <= t1;
                };
                
                // Check AABB obstacles
                for (let i = 0; i < this.obstacles.length; i++) {
                        if (segIntersectsAabb(x1, y1, x2, y2, this.obstacles[i])) return true;
                }
                
                // Check oriented boxes with optional filter
                if (this.orientedBoxes) {
                        for (let i = 0; i < this.orientedBoxes.length; i++) {
                                const box = this.orientedBoxes[i];
                                // Apply filter if provided (return false to skip this box)
                                if (orientedBoxFilter && !orientedBoxFilter(box)) continue;
                                if (this._lineIntersectsOrientedBox(x1, y1, x2, y2, box)) return true;
                        }
                }
                
                return false;
        }

        // Returns true if a circle center is inside the world boundary
        isInsideBounds(x, y, radius = 0) {
                if (this.isRectangular) {
                        // Rectangular boundary check
                        const minX = -this.halfWidth + radius;
                        const maxX = this.halfWidth - radius;
                        const minY = -this.halfHeight + radius;
                        const maxY = this.halfHeight - radius;
                        return x >= minX && x <= maxX && y >= minY && y <= maxY;
                }
                
                // Square boundary check (default)
                const b = this.boundary - radius;
                return x >= -b && x <= b && y >= -b && y <= b;
        }

        _generateObstacles() {
                // Use seeded RNG for synchronized world generation across all players
                console.log('[Environment] Generating obstacles with seeded RNG');
                
                const max = this.maxRange;
                // Counts tuned for performance; adjust as needed
                const numSmall = 1400; // car-sized
                const numLarge = 320;  // building-sized

                // Small car-sized rectangles
                for (let i = 0; i < numSmall; i++) {
                        const w = WorldRNG.randomFloat(28, 56);
                        const h = WorldRNG.randomFloat(18, 34);
                        const candidate = {
                                type: 'small',
                                x: WorldRNG.randomFloat(-max, max),
                                y: WorldRNG.randomFloat(-max, max),
                                w,
                                h,
                                fill: WorldRNG.pick(['#242936', '#252b3a', '#293043']),
                                stroke: '#000000'
                        };
                        if (this._circleIntersectsRect(this.spawnSafeX, this.spawnSafeY, this.spawnSafeRadius, candidate)) {
                                continue;
                        }
                        this.obstacles.push(candidate);
                }

                // Large building-sized rectangles
                for (let i = 0; i < numLarge; i++) {
                        const w = WorldRNG.randomFloat(160, 360);
                        const h = WorldRNG.randomFloat(120, 320);
                        const candidate = {
                                type: 'large',
                                x: WorldRNG.randomFloat(-max, max),
                                y: WorldRNG.randomFloat(-max, max),
                                w,
                                h,
                                fill: WorldRNG.pick(['#2c3343', '#31384a', '#353e52']),
                                stroke: '#0b0d12'
                        };
                        if (this._circleIntersectsRect(this.spawnSafeX, this.spawnSafeY, this.spawnSafeRadius, candidate)) {
                                continue;
                        }
                        this.obstacles.push(candidate);
                }
                
                console.log('[Environment] Generated', this.obstacles.length, 'obstacles using seed:', WorldRNG.getCurrentSeed());
        }

        draw(ctx, camera, viewport) {
                const w = viewport.width;
                const h = viewport.height;
                const gridSize = this.gridSize;
                const thickEvery = this.thickEvery;

                // Background is already filled in screen space by ClientRender before transforms
                // No need to fill again here - this prevents issues with zoom transforms

                // Draw spawn dotted box beneath all world elements (above background only)
                (function drawSpawnBox(){
                        const size = 1500;
                        const half = size / 2;
                        const sx = (this.spawnSafeX || 0) - camera.x;
                        const sy = (this.spawnSafeY || 0) - camera.y;
                        const x = Math.round(sx - half) + 0.5;
                        const y = Math.round(sy - half) + 0.5;
                        const prevDash = ctx.getLineDash ? ctx.getLineDash() : null;
                        ctx.save();
                        ctx.strokeStyle = '#ffffff';
                        ctx.lineWidth = 2;
                        if (ctx.setLineDash) ctx.setLineDash([6, 6]);
                        ctx.globalAlpha = 0.0;
                        ctx.beginPath();
                        ctx.rect(x, y, size, size);
                        ctx.stroke();
                        if (ctx.setLineDash && prevDash) ctx.setLineDash(prevDash);
                        ctx.restore();
                }).call(this);

                const mod = (a, n) => ((a % n) + n) % n;

                // Vertical lines - extend to cover negative space and beyond viewport for zoom
                let startX = -mod(camera.x, gridSize);
                let baseIndexX = Math.floor(camera.x / gridSize);
                // Start earlier and go further to cover the entire transformed canvas
                for (let i = -2, x = startX - gridSize * 2; x <= w + gridSize * 2; i++, x += gridSize) {
                        const worldIndex = baseIndexX + i;
                        const isThick = worldIndex % thickEvery === 0;
                        const lineX = Math.round(x) + 0.5;
                        ctx.beginPath();
                        ctx.moveTo(lineX, -h); // Start from negative y
                        ctx.lineTo(lineX, h * 2); // Extend beyond h
                        ctx.strokeStyle = isThick ? this.lineThick : this.lineThin;
                        ctx.lineWidth = isThick ? 2 : 1;
                        ctx.stroke();
                }

                // Horizontal lines - extend to cover negative space and beyond viewport for zoom
                let startY = -mod(camera.y, gridSize);
                let baseIndexY = Math.floor(camera.y / gridSize);
                // Start earlier and go further to cover the entire transformed canvas
                for (let i = -2, y = startY - gridSize * 2; y <= h + gridSize * 2; i++, y += gridSize) {
                        const worldIndex = baseIndexY + i;
                        const isThick = worldIndex % thickEvery === 0;
                        const lineY = Math.round(y) + 0.5;
                        ctx.beginPath();
                        ctx.moveTo(-w, lineY); // Start from negative x
                        ctx.lineTo(w * 2, lineY); // Extend beyond w
                        ctx.strokeStyle = isThick ? this.lineThick : this.lineThin;
                        ctx.lineWidth = isThick ? 2 : 1;
                        ctx.stroke();
                }

                // Ground decals (blood pools, etc.) drawn under obstacles/characters if provided
                try { if (typeof window.drawGroundDecals === 'function') window.drawGroundDecals(ctx, camera, { width: w, height: h }); } catch(e) {}

                // Ground hazards that should render ABOVE decals but BELOW obstacles/walls (e.g. fire pools).
                // Hooked from ClientRender to keep correct layering without letting hazards paint over walls.
                try { if (typeof window.drawGroundHazardsUnderObstacles === 'function') window.drawGroundHazardsUnderObstacles(ctx, camera, viewport); } catch(e) {}

                // Obstacles (view-culled)
                // Use centralized cullBounds if provided, otherwise calculate (fallback for compatibility)
                const bounds = viewport.cullBounds || {
                        left: camera.x - w/2 - 1500,
                        right: camera.x + w/2 + 1500,
                        top: camera.y - h/2 - 1500,
                        bottom: camera.y + h/2 + 1500
                };
                const viewLeft = bounds.left;
                const viewTop = bounds.top;
                const viewRight = bounds.right;
                const viewBottom = bounds.bottom;
                for (let i = 0; i < this.obstacles.length; i++) {
                        const ob = this.obstacles[i];
                        
                        // Skip temporary obstacles (shield walls, etc.) - they handle their own rendering
                        if (ob.temporary === true) continue;
                        
                        // Cull obstacles outside boundary explicitly (safety)
                        const halfW = ob.w / 2;
                        const halfH = ob.h / 2;
                        if (!this.isInsideBounds(ob.x, ob.y, Math.max(halfW, halfH))) continue;
                        const left = ob.x - ob.w / 2;
                        const top = ob.y - ob.h / 2;
                        const right = left + ob.w;
                        const bottom = top + ob.h;
                        if (right < viewLeft || left > viewRight || bottom < viewTop || top > viewBottom) continue;

                        const sx = left - camera.x;
                        const sy = top - camera.y;
                        ctx.beginPath();
                        ctx.rect(Math.round(sx) + 0.5, Math.round(sy) + 0.5, Math.round(ob.w), Math.round(ob.h));
                        ctx.fillStyle = ob.fill;
                        ctx.fill();
                        ctx.lineWidth = 2;
                        ctx.strokeStyle = ob.stroke;
                        ctx.stroke();
                }

                // Draw oriented boxes (rotated rectangles like shield walls and trench walls)
                if (this.orientedBoxes && Array.isArray(this.orientedBoxes)) {
                        let totalBoxes = 0;
                        let skippedAbility = 0;
                        let skippedNoFill = 0;
                        let skippedViewport = 0;
                        let skippedBounds = 0;
                        let rendered = 0;
                        
                        for (let i = 0; i < this.orientedBoxes.length; i++) {
                                const box = this.orientedBoxes[i];
                                totalBoxes++;
                                
                                // Only render boxes that have rendering data (skip ability walls that render themselves)
                                if (box._abilityId) { skippedAbility++; continue; }  // Skip shield walls from abilities (they handle their own rendering)
                                if (!box.fill || !box.stroke) { skippedNoFill++; continue; }  // Skip if no rendering data
                                
                                // Basic culling - skip if far outside viewport
                                // SKIP CULLING FOR TRENCH WALLS (only 30 of them, always render to prevent invisible walls)
                                if (!box.isTrenchWall) {
                                        // Use centralized cullBounds instead of manual calculation
                                        const boxRadius = Math.max(box.w, box.h) / 2;
                                        if (box.x + boxRadius < bounds.left || box.x - boxRadius > bounds.right ||
                                            box.y + boxRadius < bounds.top || box.y - boxRadius > bounds.bottom) {
                                                skippedViewport++;
                                                continue;
                                        }
                                }
                                
                                // Cull boxes outside boundary explicitly (safety)
                                // SKIP BOUNDS CULLING FOR TRENCH WALLS (rotated walls can extend outside bounds even if center is inside)
                                if (!box.isTrenchWall) {
                                        // Use thickness (smaller dimension) for bounds check, not length
                                        const thickness = Math.min(box.w, box.h);
                                        if (!this.isInsideBounds(box.x, box.y, thickness)) { skippedBounds++; continue; }
                                }
                                
                                const sx = box.x - camera.x;
                                const sy = box.y - camera.y;
                                
                                ctx.save();
                                ctx.translate(sx, sy);
                                ctx.rotate(box.angle || 0);
                                
                                // Draw rotated rectangle
                                ctx.beginPath();
                                const halfW = box.w / 2;
                                const halfH = box.h / 2;
                                ctx.rect(-halfW, -halfH, box.w, box.h);
                                ctx.fillStyle = box.fill;
                                ctx.fill();
                                ctx.lineWidth = 2;
                                ctx.strokeStyle = box.stroke;
                                ctx.stroke();
                                
                                ctx.restore();
                                rendered++;
                        }
                        
                        // Debug log (only log once per second to avoid spam)
                        // if (!this._lastOrientedBoxLog || Date.now() - this._lastOrientedBoxLog > 1000) {
                        //         this._lastOrientedBoxLog = Date.now();
                        //         console.log('[Environment] OrientedBoxes render:', {
                        //                 total: totalBoxes,
                        //                 skippedAbility,
                        //                 skippedNoFill,
                        //                 skippedViewport,
                        //                 skippedBounds,
                        //                 rendered
                        //         });
                        // }
                }

                // Draw enclosing wall around boundary
                ctx.fillStyle = this.wallColor;
                const t = this.wallThickness;
                
                if (this.isRectangular) {
                        // Rectangular boundary walls
                        const halfW = this.halfWidth;
                        const halfH = this.halfHeight;
                        
                        // Top wall
                        let sx = -halfW - t - camera.x;
                        let sy = -halfH - t - camera.y;
                        ctx.fillRect(sx, sy, this.width + t * 2, t);
                        
                        // Bottom wall
                        sy = halfH - camera.y;
                        ctx.fillRect(-halfW - t - camera.x, sy, this.width + t * 2, t);
                        
                        // Left wall
                        sx = -halfW - t - camera.x;
                        sy = -halfH - camera.y;
                        ctx.fillRect(sx, sy, t, this.height);
                        
                        // Right wall
                        sx = halfW - camera.x;
                        ctx.fillRect(sx, -halfH - camera.y, t, this.height);
                } else {
                        // Square boundary walls (default)
                        const b = this.boundary;
                        
                        // Top wall
                        let sx = -b - t - camera.x;
                        let sy = -b - t - camera.y;
                        ctx.fillRect(sx, sy, (b + t) * 2 + t, t);
                        
                        // Bottom wall
                        sy = b - camera.y;
                        ctx.fillRect(-b - t - camera.x, sy, (b + t) * 2 + t, t);
                        
                        // Left wall
                        sx = -b - t - camera.x;
                        sy = -b - camera.y;
                        ctx.fillRect(sx, sy, t, (b + t) * 2);
                        
                        // Right wall
                        sx = b - camera.x;
                        ctx.fillRect(sx, -b - camera.y, t, (b + t) * 2);
                }
        }
}
window.Environment = Environment;

