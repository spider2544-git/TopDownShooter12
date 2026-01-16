// Server-side Environment classes for collision detection
// Now using universal shared modules
const { SeededRNG } = require('../../shared/seededRNG.js');
const CollisionHelpers = require('../../shared/collisionHelpers.js');

// Main game level environment
class ServerEnvironment {
    constructor(worldSeed, levelConfig = null) {
        this.boundary = 11000;
        this.maxRange = 10000;
        this.obstacles = [];
        this.orientedBoxes = []; // Rotated rectangles (shield walls) - exact rotation collision
        this.spawnSafeX = 0;
        this.spawnSafeY = 0;
        this.spawnSafeRadius = 200;
        
        // Check if this level uses rectangular boundaries (e.g., trench raid)
        if (levelConfig && levelConfig.isRectangular) {
            this.isRectangular = true;
            this.width = levelConfig.width || 6000;
            this.height = levelConfig.height || 1500;
            this.halfWidth = this.width / 2;
            this.halfHeight = this.height / 2;
            this.boundary = levelConfig.boundary || Math.max(this.halfWidth, this.halfHeight); // Update boundary to match
            console.log(`[ServerEnvironment] Using rectangular bounds: ${this.width}×${this.height}, boundary: ${this.boundary}`);
        } else {
            this.isRectangular = false;
        }
        
        // Store exclusion zones for obstacle generation (e.g., safe zones in trench raid)
        this.obstacleExclusionZones = levelConfig?.obstacleExclusionZones || [];
        
        // Initialize RNG with world seed
        this.rng = new SeededRNG(worldSeed);
        this._generateObstacles();
    }
    
    // Collision methods now delegate to shared helpers
    circleHitsAny(cx, cy, cr) {
        return CollisionHelpers.circleHitsAny(cx, cy, cr, this.obstacles, this.orientedBoxes);
    }

    isInsideBounds(cx, cy, cr) {
        if (this.isRectangular) {
            // Rectangular boundary check
            const minX = -this.halfWidth + cr;
            const maxX = this.halfWidth - cr;
            const minY = -this.halfHeight + cr;
            const maxY = this.halfHeight - cr;
            return cx >= minX && cx <= maxX && cy >= minY && cy <= maxY;
        }
        // Square boundary check (default)
        return CollisionHelpers.isInsideBounds(cx, cy, cr, this.boundary);
    }

    resolveCircleMove(x, y, radius, dx, dy) {
        if (this.isRectangular) {
            // Custom rectangular boundary clamping
            const result = CollisionHelpers.resolveCircleMove(x, y, radius, dx, dy, this.obstacles, this.boundary, this.orientedBoxes);
            // Override boundary clamping with rectangular bounds
            const minX = -this.halfWidth + radius;
            const maxX = this.halfWidth - radius;
            const minY = -this.halfHeight + radius;
            const maxY = this.halfHeight - radius;
            if (result.x > maxX) result.x = maxX;
            if (result.x < minX) result.x = minX;
            if (result.y > maxY) result.y = maxY;
            if (result.y < minY) result.y = minY;
            return result;
        }
        // Square boundary (default)
        return CollisionHelpers.resolveCircleMove(x, y, radius, dx, dy, this.obstacles, this.boundary, this.orientedBoxes);
    }

    // Debug-friendly resolver that returns collision hit details (AABB/obox/bounds)
    resolveCircleMoveWithHits(x, y, radius, dx, dy) {
        if (this.isRectangular) {
            const result = (CollisionHelpers.resolveCircleMoveWithHits)
                ? CollisionHelpers.resolveCircleMoveWithHits(x, y, radius, dx, dy, this.obstacles, this.boundary, this.orientedBoxes)
                : CollisionHelpers.resolveCircleMove(x, y, radius, dx, dy, this.obstacles, this.boundary, this.orientedBoxes);

            // Override boundary clamping with rectangular bounds
            const minX = -this.halfWidth + radius;
            const maxX = this.halfWidth - radius;
            const minY = -this.halfHeight + radius;
            const maxY = this.halfHeight - radius;

            const preClampX = result.x, preClampY = result.y;
            if (result.x > maxX) result.x = maxX;
            if (result.x < minX) result.x = minX;
            if (result.y > maxY) result.y = maxY;
            if (result.y < minY) result.y = minY;

            if ((preClampX !== result.x || preClampY !== result.y) && Array.isArray(result.hits)) {
                result.hits.push({
                    kind: 'bounds',
                    mode: 'rect',
                    from: { x: preClampX, y: preClampY },
                    to: { x: result.x, y: result.y }
                });
            }

            return result;
        }

        if (CollisionHelpers.resolveCircleMoveWithHits) {
            return CollisionHelpers.resolveCircleMoveWithHits(x, y, radius, dx, dy, this.obstacles, this.boundary, this.orientedBoxes);
        }
        return CollisionHelpers.resolveCircleMove(x, y, radius, dx, dy, this.obstacles, this.boundary, this.orientedBoxes);
    }
    
    lineHitsAny(x1, y1, x2, y2) {
        return CollisionHelpers.lineHitsAny(x1, y1, x2, y2, this.obstacles, this.orientedBoxes);
    }
    
    _generateObstacles() {
        console.log('[ServerEnvironment] Generating obstacles with seed:', this.rng.getSeed());
        
        // Use rectangular bounds if available, otherwise use circular maxRange
        let xMax, yMax, numSmall, numLarge;
        if (this.isRectangular) {
            xMax = this.halfWidth - 200;  // Leave buffer from edges
            yMax = this.halfHeight - 200; // Leave buffer from edges
            
            // Calculate area and scale obstacle count to maintain similar density
            const rectangularArea = (xMax * 2) * (yMax * 2);
            const circularArea = Math.PI * this.maxRange * this.maxRange; // Original circular area
            const areaRatio = rectangularArea / circularArea;
            
            // Scale obstacle counts based on area ratio
            numSmall = Math.floor(1400 * areaRatio); // car-sized
            numLarge = Math.floor(320 * areaRatio);  // building-sized
            
            console.log(`[ServerEnvironment] Rectangular bounds: x=±${xMax}, y=±${yMax}`);
            console.log(`[ServerEnvironment] Area ratio: ${(areaRatio * 100).toFixed(1)}% (${rectangularArea.toLocaleString()} / ${circularArea.toLocaleString()})`);
            console.log(`[ServerEnvironment] Scaled obstacles: ${numSmall} small, ${numLarge} large (vs 1400/320 default)`);
        } else {
            xMax = this.maxRange;
            yMax = this.maxRange;
            numSmall = 1400; // car-sized (default for circular)
            numLarge = 320;  // building-sized (default for circular)
        }

        // Helper: Check if obstacle intersects any exclusion zone
        let excludedCount = 0;
        const intersectsExclusionZone = (obstacle) => {
            for (const zone of this.obstacleExclusionZones) {
                // AABB vs AABB check
                const obsLeft = obstacle.x - obstacle.w / 2;
                const obsRight = obstacle.x + obstacle.w / 2;
                const obsTop = obstacle.y - obstacle.h / 2;
                const obsBottom = obstacle.y + obstacle.h / 2;
                
                if (obsRight > zone.minX && obsLeft < zone.maxX &&
                    obsBottom > zone.minY && obsTop < zone.maxY) {
                    excludedCount++;
                    return true; // Overlaps with exclusion zone
                }
            }
            return false;
        };
        
        // Small car-sized rectangles
        for (let i = 0; i < numSmall; i++) {
            const w = this.rng.randomFloat(28, 56);
            const h = this.rng.randomFloat(18, 34);
            const candidate = {
                type: 'small',
                x: this.rng.randomFloat(-xMax, xMax),
                y: this.rng.randomFloat(-yMax, yMax),
                w,
                h,
                fill: this.rng.pick(['#242936', '#252b3a', '#293043']),
                stroke: '#000000'
            };
            // Skip if in spawn safe zone or exclusion zones
            if (CollisionHelpers.circleIntersectsRect(this.spawnSafeX, this.spawnSafeY, this.spawnSafeRadius, candidate)) {
                continue;
            }
            if (intersectsExclusionZone(candidate)) {
                continue;
            }
            this.obstacles.push(candidate);
        }

        // Large building-sized rectangles
        for (let i = 0; i < numLarge; i++) {
            const w = this.rng.randomFloat(160, 360);
            const h = this.rng.randomFloat(120, 320);
            const candidate = {
                type: 'large',
                x: this.rng.randomFloat(-xMax, xMax),
                y: this.rng.randomFloat(-yMax, yMax),
                w,
                h,
                fill: this.rng.pick(['#2c3343', '#31384a', '#353e52']),
                stroke: '#0b0d12'
            };
            // Skip if in spawn safe zone or exclusion zones
            if (CollisionHelpers.circleIntersectsRect(this.spawnSafeX, this.spawnSafeY, this.spawnSafeRadius, candidate)) {
                continue;
            }
            if (intersectsExclusionZone(candidate)) {
                continue;
            }
            this.obstacles.push(candidate);
        }
        
        console.log('[ServerEnvironment] Generated', this.obstacles.length, 'obstacles');
        if (excludedCount > 0) {
            console.log(`[ServerEnvironment] Excluded ${excludedCount} obstacles from safe zones`);
        }
    }
    
    // Remove obstacles from specified gap areas (for trench raid wall gaps, etc.)
    clearGapAreas(gapPositions) {
        if (!Array.isArray(gapPositions) || gapPositions.length === 0) return;
        
        const initialCount = this.obstacles.length;
        this.obstacles = this.obstacles.filter(obstacle => {
            // Check if obstacle intersects with any gap area
            for (const gap of gapPositions) {
                const gapLeft = gap.x - gap.width / 2 - gap.clearRadius;
                const gapRight = gap.x + gap.width / 2 + gap.clearRadius;
                const gapTop = gap.y - gap.height / 2 - gap.clearRadius;
                const gapBottom = gap.y + gap.height / 2 + gap.clearRadius;
                
                const obsLeft = obstacle.x - obstacle.w / 2;
                const obsRight = obstacle.x + obstacle.w / 2;
                const obsTop = obstacle.y - obstacle.h / 2;
                const obsBottom = obstacle.y + obstacle.h / 2;
                
                // Check for AABB intersection
                if (obsRight >= gapLeft && obsLeft <= gapRight &&
                    obsBottom >= gapTop && obsTop <= gapBottom) {
                    return false; // Remove this obstacle (it's in a gap)
                }
            }
            return true; // Keep this obstacle
        });
        
        const removed = initialCount - this.obstacles.length;
        if (removed > 0) {
            console.log(`[ServerEnvironment] Cleared ${removed} obstacles from ${gapPositions.length} gap areas`);
        }
    }
}

// Lobby environment (smaller, with merchant stall)
class ServerEnvironmentLobby {
    constructor(worldSeed) {
        this.boundary = 1000; // Match client EnvironmentLobby boundary
        this.maxRange = 900; // not used for random obstacles here
        this.obstacles = [];
        this.orientedBoxes = []; // Rotated rectangles (shield walls) - exact rotation collision
        this.spawnSafeX = 0;
        this.spawnSafeY = 0;
        this.spawnSafeRadius = 180; // Match client EnvironmentLobby
        
        // Initialize RNG with world seed (for consistency, though not used for obstacles)
        this.rng = new SeededRNG(worldSeed);
        this._addMerchantStall();
    }
    
    // Collision methods delegate to shared helpers (same as ServerEnvironment)
    circleHitsAny(cx, cy, cr) {
        return CollisionHelpers.circleHitsAny(cx, cy, cr, this.obstacles, this.orientedBoxes);
    }

    isInsideBounds(cx, cy, cr) {
        return CollisionHelpers.isInsideBounds(cx, cy, cr, this.boundary);
    }

    resolveCircleMove(x, y, radius, dx, dy) {
        return CollisionHelpers.resolveCircleMove(x, y, radius, dx, dy, this.obstacles, this.boundary, this.orientedBoxes);
    }
    
    // Add merchant stall obstacles (matches client EnvironmentLobby exactly)
    _addMerchantStall() {
        console.log('[ServerEnvironmentLobby] Adding merchant stall obstacles');
        try {
            const b = this.boundary;
            // Base anchor near upper center
            const ax = 200;
            const ay = -b + 120; // slightly below top wall
            // Counter (horizontal)
            this.obstacles.push({ x: ax, y: ay + 26, w: 240, h: 22, fill: '#4a3a24', stroke: '#000000' });
            // Sandbag rows (left and right)
            this.obstacles.push({ x: ax - 180, y: ay, w: 150, h: 20, fill: '#b29f6b', stroke: '#2b2b2b', kind: 'sandbag', variant: 'horizontal' });
            this.obstacles.push({ x: ax + 180, y: ay, w: 150, h: 20, fill: '#b29f6b', stroke: '#2b2b2b', kind: 'sandbag', variant: 'horizontal' });
            // Crates stacks (left/right, two-high)
            this.obstacles.push({ x: ax - 240, y: ay - 10, w: 40, h: 40, fill: '#6b4f2e', stroke: '#1f140b' });
            this.obstacles.push({ x: ax - 240, y: ay - 54, w: 40, h: 40, fill: '#6b4f2e', stroke: '#1f140b' });
            this.obstacles.push({ x: ax + 240, y: ay - 10, w: 40, h: 40, fill: '#6b4f2e', stroke: '#1f140b' });
            this.obstacles.push({ x: ax + 240, y: ay - 54, w: 40, h: 40, fill: '#6b4f2e', stroke: '#1f140b' });
            // Banner posts (thin verticals)
            this.obstacles.push({ x: ax - 140, y: ay - 50, w: 10, h: 120, fill: '#553c2a', stroke: '#000000' });
            this.obstacles.push({ x: ax + 140, y: ay - 50, w: 10, h: 120, fill: '#553c2a', stroke: '#000000' });
            // Ammo crates in front corners (do not block central approach)
            this.obstacles.push({ x: ax - 160, y: ay + 60, w: 36, h: 24, fill: '#5a7a3a', stroke: '#0f1a09' });
            this.obstacles.push({ x: ax + 160, y: ay + 60, w: 36, h: 24, fill: '#5a7a3a', stroke: '#0f1a09' });
            // Metal supply box behind counter (decoration behind merchant)
            this.obstacles.push({ x: ax, y: ay - 40, w: 120, h: 18, fill: '#444c56', stroke: '#0c0f13' });
            
            console.log('[ServerEnvironmentLobby] Added', this.obstacles.length, 'merchant stall obstacles');
        } catch(e) {
            console.error('[ServerEnvironmentLobby] Error adding merchant stall:', e);
        }
    }
}

module.exports = { ServerEnvironment, ServerEnvironmentLobby };
