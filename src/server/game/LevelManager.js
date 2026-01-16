/**
 * LevelManager - Manages level generation, scene transitions, and world setup for GameRoom
 * 
 * Extracted from GameRoom (Phase 5 of incremental manager extraction)
 * 
 * Handles:
 * - Level type selection and switching
 * - Environment generation (lobby/level)
 * - Extraction zone and boss spawn computation
 * - Trench Raid navmesh precomputation
 * - Reset to lobby (mission end)
 * - Legacy spawn computation (fallback)
 * - Lobby target dummy spawning
 */

// Import dependencies
const { SeededRNG } = require('../core/seededRNG.js');
const { ServerEnvironment, ServerEnvironmentLobby } = require('../environment/serverEnvironment.js');
const { EnvironmentHazards } = require('../environment/EnvironmentHazards.js');
const LevelConfigs = require('../../levels/LevelConfigs.js');
const GameModeConfigs = require('../../levels/GameModeConfigs.js');

// Import game mode classes
const TestMode = require('../../levels/modes/TestMode.js');
const ExtractionMode = require('../../levels/modes/ExtractionMode.js');
const PayloadMode = require('../../levels/modes/PayloadMode.js');
const TrenchRaidMode = require('../../levels/modes/TrenchRaidMode.js');

// Helper function for trench wall keepouts (extracted from server.js module-level function)
function addTrenchFunnelKeepouts(orientedBoxes, opts = {}) {
    if (!Array.isArray(orientedBoxes) || orientedBoxes.length < 2) return 0;
    const trenchWalls = orientedBoxes.filter(b => b && b.isTrenchWall);
    if (trenchWalls.length < 2) return 0;

    const clamp = (v, a, b) => (v < a ? a : (v > b ? b : v));
    const norm = (x, y) => {
        const d = Math.hypot(x, y);
        return d > 1e-6 ? { x: x / d, y: y / d, d } : { x: 0, y: 0, d: 0 };
    };

    // Centerline segment endpoints along the wall's long axis (w)
    const centerline = (w) => {
        const ang = Number.isFinite(w.angle) ? w.angle : 0;
        const len = Math.max(1, Number.isFinite(w.w) ? w.w : 1);
        const ux = Math.cos(ang), uy = Math.sin(ang);
        const hx = ux * (len * 0.5), hy = uy * (len * 0.5);
        return { ax: w.x - hx, ay: w.y - hy, bx: w.x + hx, by: w.y + hy, ux, uy };
    };

    const closestPointOnSegment = (px, py, ax, ay, bx, by) => {
        const abx = bx - ax, aby = by - ay;
        const apx = px - ax, apy = py - ay;
        const ab2 = abx * abx + aby * aby;
        const t = ab2 > 1e-8 ? clamp((apx * abx + apy * aby) / ab2, 0, 1) : 0;
        return { x: ax + abx * t, y: ay + aby * t, t };
    };

    // Segment intersection (returns point if intersects; else null)
    const segmentIntersect = (ax, ay, bx, by, cx, cy, dx, dy) => {
        const rX = bx - ax, rY = by - ay;
        const sX = dx - cx, sY = dy - cy;
        const denom = rX * sY - rY * sX;
        if (Math.abs(denom) < 1e-8) return null; // parallel/collinear
        const qpx = cx - ax, qpy = cy - ay;
        const t = (qpx * sY - qpy * sX) / denom;
        const u = (qpx * rY - qpy * rX) / denom;
        if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
            return { x: ax + t * rX, y: ay + t * rY };
        }
        return null;
    };

    // Tunables
    const NEAR_DIST = Number.isFinite(opts.nearDist) ? opts.nearDist : 170;      // catches mid-segment overlaps
    const MIN_V_ANGLE_DEG = Number.isFinite(opts.minVAngleDeg) ? opts.minVAngleDeg : 10;
    const MAX_V_ANGLE_DEG = Number.isFinite(opts.maxVAngleDeg) ? opts.maxVAngleDeg : 105; // allow wider Vs
    const KEEPOUT_DEPTH = Number.isFinite(opts.keepoutDepth) ? opts.keepoutDepth : 420;
    const KEEPOUT_WIDTH = Number.isFinite(opts.keepoutWidth) ? opts.keepoutWidth : 280;
    const APEX_PUSH = Number.isFinite(opts.apexPush) ? opts.apexPush : 30;      // keeps keepout from sitting exactly on crossing

    const minVAngle = (MIN_V_ANGLE_DEG * Math.PI) / 180;
    const maxVAngle = (MAX_V_ANGLE_DEG * Math.PI) / 180;

    let added = 0;

    for (let i = 0; i < trenchWalls.length; i++) {
        const A = trenchWalls[i];
        const a = centerline(A);
        const uA = norm(a.ux, a.uy);

        for (let j = i + 1; j < trenchWalls.length; j++) {
            const B = trenchWalls[j];
            const b = centerline(B);
            const uB = norm(b.ux, b.uy);

            // Find closest points between centerline segments (intersection wins)
            let pA = null, pB = null, dMin = Infinity;
            const inter = segmentIntersect(a.ax, a.ay, a.bx, a.by, b.ax, b.ay, b.bx, b.by);
            if (inter) {
                pA = inter; pB = inter; dMin = 0;
            } else {
                // Endpoints of A -> B
                const c1 = closestPointOnSegment(a.ax, a.ay, b.ax, b.ay, b.bx, b.by);
                const d1 = Math.hypot(a.ax - c1.x, a.ay - c1.y);
                if (d1 < dMin) { dMin = d1; pA = { x: a.ax, y: a.ay }; pB = { x: c1.x, y: c1.y }; }
                const c2 = closestPointOnSegment(a.bx, a.by, b.ax, b.ay, b.bx, b.by);
                const d2 = Math.hypot(a.bx - c2.x, a.by - c2.y);
                if (d2 < dMin) { dMin = d2; pA = { x: a.bx, y: a.by }; pB = { x: c2.x, y: c2.y }; }

                // Endpoints of B -> A
                const c3 = closestPointOnSegment(b.ax, b.ay, a.ax, a.ay, a.bx, a.by);
                const d3 = Math.hypot(b.ax - c3.x, b.ay - c3.y);
                if (d3 < dMin) { dMin = d3; pA = { x: c3.x, y: c3.y }; pB = { x: b.ax, y: b.ay }; }
                const c4 = closestPointOnSegment(b.bx, b.by, a.ax, a.ay, a.bx, a.by);
                const d4 = Math.hypot(b.bx - c4.x, b.by - c4.y);
                if (d4 < dMin) { dMin = d4; pA = { x: c4.x, y: c4.y }; pB = { x: b.bx, y: b.by }; }
            }

            if (!pA || !pB) continue;
            if (dMin > NEAR_DIST) continue;

            // Choose directions along each wall that form the "inside" acute angle.
            // For each wall, we can go +u or -u; pick combination with max dot (smallest angle).
            const candidates = [
                { ax: uA.x, ay: uA.y, bx: uB.x, by: uB.y },
                { ax: uA.x, ay: uA.y, bx: -uB.x, by: -uB.y },
                { ax: -uA.x, ay: -uA.y, bx: uB.x, by: uB.y },
                { ax: -uA.x, ay: -uA.y, bx: -uB.x, by: -uB.y }
            ];
            let best = null;
            for (const c of candidates) {
                const dot = c.ax * c.bx + c.ay * c.by;
                if (!best || dot > best.dot) best = { ...c, dot };
            }
            if (!best) continue;

            const dot = clamp(best.dot, -1, 1);
            const ang = Math.acos(dot);
            if (ang < minVAngle || ang > maxVAngle) continue;

            const bis = norm(best.ax + best.bx, best.ay + best.by);
            if (bis.d < 1e-6) continue;

            // Apex is midpoint of closest points (works for both intersection and near-miss)
            const apexX = (pA.x + pB.x) * 0.5;
            const apexY = (pA.y + pB.y) * 0.5;

            // Place the keepout a bit inside the wedge so it blocks the pocket.
            const centerX = apexX + bis.x * (APEX_PUSH + KEEPOUT_DEPTH * 0.5);
            const centerY = apexY + bis.y * (APEX_PUSH + KEEPOUT_DEPTH * 0.5);
            const keepAngle = Math.atan2(bis.y, bis.x);

            orientedBoxes.push({
                x: centerX,
                y: centerY,
                w: KEEPOUT_DEPTH,
                h: KEEPOUT_WIDTH,
                angle: keepAngle,
                isTrenchKeepout: true
            });
            added++;
        }
    }

    return added;
}

class LevelManager {
    /**
     * @param {GameRoom} room - Reference to the parent GameRoom for state access
     * @param {SocketIO} io - Socket.io instance for broadcasts
     */
    constructor(room, io) {
        this.room = room;
        this.io = io;
    }

    // =========================================
    // LEVEL TYPE AND MODE MANAGEMENT
    // =========================================

    setLevelType(playerId, levelType) {
        // Validate level type
        const validTypes = ['extraction', 'test', 'payload', 'trenchraid'];
        if (!validTypes.includes(levelType)) {
            console.warn(`[Server] Invalid level type: ${levelType}, defaulting to extraction`);
            levelType = 'extraction';
        }
        
        this.room.levelType = levelType;
        this.room.levelTypeSetBy = playerId;
        console.log(`[Server] Level type set to "${levelType}" by player ${playerId} in room ${this.room.id}`);
        
        // Precompute navmesh for Trench Raid as soon as it's selected (not on ready timer)
        if (levelType === 'trenchraid' && this.room.scene === 'lobby' && !this.room._navDebug) {
            console.log('[NavMesh] Trench Raid selected, precomputing navmesh now...');
            try {
                this._precomputeTrenchRaidNavDebug();
            } catch (e) {
                console.warn('[NavMesh] Precompute failed:', e && e.message ? e.message : String(e));
            }
        }
        
        // Broadcast to all players in the room
        this.io.to(this.room.id).emit('levelTypeSync', {
            levelType: this.room.levelType,
            setBy: this.room.levelTypeSetBy
        });
    }

    getModeClass(levelType) {
        // Factory pattern to get mode class by level type
        const modes = {
            'test': TestMode,
            'extraction': ExtractionMode,
            'payload': PayloadMode,
            'trenchraid': TrenchRaidMode
        };
        return modes[levelType] || TestMode; // Default to TestMode if unknown
    }

    // =========================================
    // ENVIRONMENT CREATION
    // =========================================

    _createEnvironmentForScene(scene) {
        if (scene === 'lobby') {
            const env = new ServerEnvironmentLobby(this.room.worldSeed);
            this.room.boundary = env.boundary; // Sync room boundary from environment
            return env;
        } else {
            // Level environment - pass level config for rectangular boundary support
            const levelConfig = LevelConfigs.get(this.room.levelType);
            const env = new ServerEnvironment(this.room.worldSeed, levelConfig);
            this.room.boundary = env.boundary; // Sync room boundary from environment (e.g., 23000 for Trench Raid)
            console.log(`[ROOM] Environment boundary set to ${this.room.boundary} for level type "${this.room.levelType}"`);
            return env;
        }
    }

    // =========================================
    // LOBBY TARGET DUMMY SPAWNING
    // =========================================

    spawnLobbyTargetDummy(count = 5) {
        if (this.room.scene !== 'lobby') return null;
        const radius = 32;
        const healthMax = 600;
        const b = Number.isFinite(this.room.boundary) ? this.room.boundary : 1000;
        
        const env = this.room.environment;
        
        // Spawn region: upper-left corner up to this limit (near the player position in your screenshot)
        // NOTE: Coordinates are in world space; both x and y are negative in the upper-left.
        //
        // Keep a small visible gap from the top/left walls.
        // (isInsideBounds already enforces -b+radius; this adds extra breathing room.)
        const wallGapX = 14;
        const wallGapY = 14;
        const regionMinX = -b + radius + wallGapX;
        const regionMinY = -b + radius + wallGapY;
        let regionMaxX = -375;
        let regionMaxY = -575;
        // Safety: if lobby bounds ever change such that the "limit" isn't inside the corner region, expand inward a bit
        if (!(regionMaxX > regionMinX)) regionMaxX = regionMinX + 520;
        if (!(regionMaxY > regionMinY)) regionMaxY = regionMinY + 420;

        // Right boundary of the shooting-gallery area (player-side fence line)
        // Note: obstacle clearance checks below keep a safe gap from the sandbags themselves.

        // Each time we (re)spawn a dummy, we want a new position within the region.
        // Use a per-room nonce so respawns can land in different spots while still being deterministic-ish per room.
        if (!Number.isFinite(this.room._targetDummySpawnNonce)) this.room._targetDummySpawnNonce = 0;
        const spawnNonce = ++this.room._targetDummySpawnNonce;

        // Extra gap from sandbags/obstacles (and any other lobby obstacles)
        const obstacleGap = 10;

        // Shooting-gallery motion: randomly choose 2–3 dummies to move in a ping-pong lane.
        // Deterministic per spawnNonce so respawns can change which ones move.
        const moverIdx = new Set();
        let moveRnd = null;
        try {
            const seedBase = (Number.isFinite(this.room.worldSeed) ? this.room.worldSeed : 1) + 424242;
            moveRnd = this.room._rng(seedBase + spawnNonce * 9001);
            const moverCount = 2 + (moveRnd() < 0.5 ? 0 : 1); // 2 or 3
            while (moverIdx.size < Math.min(moverCount, count)) {
                moverIdx.add(Math.floor(moveRnd() * Math.max(1, count)));
            }
        } catch(_) {}

        const isClear = (cx, cy) => {
            // Enforce the requested corner region
            if (cx < regionMinX || cx > regionMaxX || cy < regionMinY || cy > regionMaxY) return false;
            try {
                if (env && env.isInsideBounds && !env.isInsideBounds(cx, cy, radius + obstacleGap)) return false;
                if (env && env.circleHitsAny && env.circleHitsAny(cx, cy, radius + obstacleGap)) return false;
            } catch(_) {}
            // Avoid overlapping other dummies
            for (const e of this.room.enemies.values()) {
                if (!e || e.alive === false) continue;
                if (e.type !== 'targetDummy') continue;
                const dx = (e.x || 0) - cx;
                const dy = (e.y || 0) - cy;
                // keep a bigger gap so they don't cluster visually
                const rr = (radius + (e.radius || radius) + 44);
                if (dx*dx + dy*dy <= rr*rr) return false;
            }
            return true;
        };
        
        const spawned = [];
        const enemiesPayload = [];
        
        for (let n = 0; n < count; n++) {
            const id = `target_dummy_${n+1}`;
            if (this.room.enemies && this.room.enemies.has(id)) {
                const existing = this.room.enemies.get(id);
                if (existing) {
                    spawned.push(existing);
                    continue;
                }
            }

            {
                // Place dummies semi-randomly in the upper-left corner area (server-authoritative)
                // Use a nonce so each respawn can land in a new spot.
                const regionW = Math.max(40, regionMaxX - regionMinX);
                const regionH = Math.max(40, regionMaxY - regionMinY);
                
                // Start from a stratified X position (spreads evenly across the region),
                // then bias LEFT a bit toward the wall (to avoid clustering near the fence).
                const bucketW = regionW / Math.max(1, count);
                let x = regionMinX + bucketW * (n + 0.5);
                x = regionMinX + (x - regionMinX) * 0.82; // 18% bias toward left wall
                let y = regionMinY + regionH * ((n + 0.35) / Math.max(1, count)); // gentle spread in Y too
                
                try {
                    const seedBase = (Number.isFinite(this.room.worldSeed) ? this.room.worldSeed : 1) + 9001;
                    const rnd = this.room._rng(seedBase + spawnNonce * 10007 + (n + 1) * 1337);
                    let found = false;
                    for (let attempt = 0; attempt < 60 && !found; attempt++) {
                        // Bias X left: rx^2 pushes values toward 0
                        const rx = rnd();
                        const ry = rnd();
                        const cx = regionMinX + (rx * rx) * regionW;
                        // Allow spawning all the way up to the top wall (bias slightly upward)
                        const cy = regionMinY + (ry * ry) * regionH;
                        if (isClear(cx, cy)) { x = cx; y = cy; found = true; break; }
                    }
                    
                    // If still blocked, spiral-search around the last candidate
                    if (!isClear(x, y)) {
                        for (let step = 0; step < 30 && !found; step++) {
                            const off = 40 + step * 18;
                            const candidates = [
                                { cx: x + off, cy: y },
                                { cx: x - off, cy: y },
                                { cx: x, cy: y + off },
                                { cx: x, cy: y - off },
                                { cx: x + off, cy: y + off },
                                { cx: x - off, cy: y + off },
                                { cx: x + off, cy: y - off },
                                { cx: x - off, cy: y - off }
                            ];
                            for (let i = 0; i < candidates.length; i++) {
                                const c = candidates[i];
                                if (isClear(c.cx, c.cy)) { x = c.cx; y = c.cy; found = true; break; }
                            }
                        }
                    }
                } catch(_) {}
                
                const enemy = {
                    id,
                    x,
                    y,
                    radius,
                    type: 'targetDummy',
                    healthMax,
                    health: healthMax,
                    alive: true,
                    speedMul: 0,
                    preferContact: false,
                    _contactDisabled: true
                };

                // Assign optional ping-pong motion lane
                try {
                    const idx0 = n; // 0-based
                    if (moveRnd && moverIdx.has(idx0)) {
                        const axis = (moveRnd() < 0.5) ? 'x' : 'y';
                        // Slower "shooting gallery" pace
                        const speed = 30 + moveRnd() * 45; // units/sec
                        const dir = (moveRnd() < 0.5) ? -1 : 1;
                        const laneMin = (axis === 'x') ? regionMinX : regionMinY;
                        const laneMax = (axis === 'x') ? regionMaxX : regionMaxY;
                        const pause = 0.55 + moveRnd() * 0.55; // seconds to pause at ends
                        enemy._move = { axis, min: laneMin, max: laneMax, speed, dir, baseX: x, baseY: y, gap: obstacleGap, pause, wait: 0 };
                        console.log(`[TargetDummy] ${id}: Created MOVER axis=${axis} min=${laneMin.toFixed(1)} max=${laneMax.toFixed(1)} speed=${speed.toFixed(1)} dir=${dir} at (${x.toFixed(1)}, ${y.toFixed(1)})`);
                    } else {
                        console.log(`[TargetDummy] ${id}: Created STATIC at (${x.toFixed(1)}, ${y.toFixed(1)})`);
                    }
                } catch(_) {}
                
                // Initialize navmesh pathfinding properties
                this._initNavProperties(enemy);
                
                this.room.enemies.set(id, enemy);
                spawned.push(enemy);
                enemiesPayload.push({ id: enemy.id, x: enemy.x, y: enemy.y, type: enemy.type, radius: enemy.radius, health: enemy.health, healthMax: enemy.healthMax, speedMul: enemy.speedMul });
            }
        }
        
        // Tell clients to spawn any newly-created dummies
        if (enemiesPayload.length > 0) {
            try {
                this.io.to(this.room.id).emit('hordeSpawned', {
                    targetSource: 'targetDummy',
                    enemies: enemiesPayload
                });
                this.room._nextEnemyBroadcastTime = Date.now();
            } catch(_) {}
        }
        
        return spawned[0] || null;
    }

    // =========================================
    // NAVMESH PRECOMPUTATION (Trench Raid)
    // =========================================

    _precomputeTrenchRaidNavDebug() {
        if (this.room.scene !== 'lobby') return;
        const key = `${this.room.worldSeed || 0}:${this.room.levelType || 'extraction'}`;
        if (this.room._navDebug && this.room._navDebugKey === key) return;

        const t0 = (typeof process.hrtime === 'function' && typeof process.hrtime.bigint === 'function')
            ? process.hrtime.bigint()
            : null;
        const startMs = Date.now();

        // Build a level environment for Trench Raid in the lobby, matching level-start setup for walls.
        const levelConfig = LevelConfigs.get('trenchraid');
        const env = new ServerEnvironment(this.room.worldSeed, levelConfig);

        // Instantiate mode for walls
        const modeConfig = GameModeConfigs.get('trenchraid');
        const ModeClass = this.getModeClass('trenchraid');
        const mode = new ModeClass(this.room, modeConfig);

        // Clear random obstacles from gap areas BEFORE adding defensive walls (matches level start)
        try {
            if (mode && typeof mode.getGapPositions === 'function' && env && typeof env.clearGapAreas === 'function') {
                const gapPositions = mode.getGapPositions();
                if (Array.isArray(gapPositions) && gapPositions.length > 0) {
                    env.clearGapAreas(gapPositions);
                }
            }
        } catch(_) {}

        // Add defensive walls (these include the side separators / chokepoints)
        // These MUST be added before the grid is built
        try {
            if (mode && typeof mode.getDefensiveWalls === 'function') {
                const walls = mode.getDefensiveWalls();
                if (Array.isArray(walls) && walls.length > 0) {
                    // Ensure defensive walls are added to obstacles array
                    for (const wall of walls) {
                        env.obstacles.push({
                            x: wall.x,
                            y: wall.y,
                            w: wall.w,
                            h: wall.h,
                            fill: wall.fill,
                            stroke: wall.stroke,
                            type: 'defensive'
                        });
                    }
                }
            }
        } catch(_) {}

        // Add trench walls (rotated, brown). Cache them so level start uses the exact same walls.
        try {
            if (mode && typeof mode.getTrenchWalls === 'function') {
                const trenchWalls = mode.getTrenchWalls();
                if (Array.isArray(trenchWalls) && trenchWalls.length > 0) {
                    this.room._precomputedTrenchWalls = trenchWalls;
                    env.orientedBoxes = env.orientedBoxes || [];
                    for (const wall of trenchWalls) {
                        env.orientedBoxes.push({
                            x: wall.x,
                            y: wall.y,
                            w: wall.w,
                            h: wall.h,
                            angle: wall.angle,
                            fill: wall.fill,
                            stroke: wall.stroke,
                            isTrenchWall: true
                        });
                    }

                    // Add invisible keepouts for sharp V-shaped overlaps so navmesh avoids dead funnels.
                    try {
                        const keepoutsAdded = addTrenchFunnelKeepouts(env.orientedBoxes);
                        if (keepoutsAdded > 0) {
                            console.log(`[TrenchWalls] Added ${keepoutsAdded} funnel keepouts (navmesh precompute)`);
                        }
                    } catch (e) {
                        console.warn('[TrenchWalls] Failed to add funnel keepouts (navmesh precompute):', e && e.message ? e.message : String(e));
                    }
                }
            }
        } catch(_) {}

        // Build coarse nav grid for debug overlay
        const nav = this._buildNavGridDebug(env);
        this.room._navDebug = nav;
        this.room._navDebugKey = key;
        this.room._navDecodedGrid = null; // Clear cached grid when navmesh changes

        const elapsedMs = t0 ? Number((process.hrtime.bigint() - t0) / 1000000n) : (Date.now() - startMs);
        console.log(`[NavMesh] ✅ Precomputed Trench Raid navmesh for room ${this.room.id} (seed=${this.room.worldSeed}) in ${elapsedMs}ms`);

        // Broadcast once so clients can render overlay (they can store until level starts)
        try {
            this.io.to(this.room.id).emit('navMeshDebug', {
                levelType: 'trenchraid',
                seed: this.room.worldSeed,
                nav
            });
        } catch(_) {}
    }

    _buildNavGridDebug(env) {
        // High resolution: 100-unit cells for detailed pathfinding
        const cellSize = 100;
        // Detection radius: with 100-unit cells, center can be 50 units from wall edge
        // Defensive walls are 60 units thick, so 60-unit radius catches them
        const radius = 60;

        let minX, maxX, minY, maxY;
        if (env && env.isRectangular) {
            minX = -env.halfWidth;
            maxX = env.halfWidth;
            minY = -env.halfHeight;
            maxY = env.halfHeight;
        } else {
            const b = Number.isFinite(env?.boundary) ? env.boundary : (Number.isFinite(this.room.boundary) ? this.room.boundary : 11000);
            minX = -b; maxX = b; minY = -b; maxY = b;
        }
        
        // Add boundary walls to environment before building grid
        const wallThickness = 100;
        if (!env.obstacles) env.obstacles = [];
        
        // Left edge wall
        env.obstacles.push({
            x: minX,
            y: (minY + maxY) / 2,
            w: wallThickness,
            h: maxY - minY,
            fill: '#1a1108',
            stroke: '#000000',
            type: 'boundary'
        });
        
        // Right edge wall
        env.obstacles.push({
            x: maxX,
            y: (minY + maxY) / 2,
            w: wallThickness,
            h: maxY - minY,
            fill: '#1a1108',
            stroke: '#000000',
            type: 'boundary'
        });
        
        // Top edge wall
        env.obstacles.push({
            x: (minX + maxX) / 2,
            y: minY,
            w: maxX - minX,
            h: wallThickness,
            fill: '#1a1108',
            stroke: '#000000',
            type: 'boundary'
        });
        
        // Bottom edge wall
        env.obstacles.push({
            x: (minX + maxX) / 2,
            y: maxY,
            w: maxX - minX,
            h: wallThickness,
            fill: '#1a1108',
            stroke: '#000000',
            type: 'boundary'
        });

        const w = Math.max(1, Math.ceil((maxX - minX) / cellSize));
        const h = Math.max(1, Math.ceil((maxY - minY) / cellSize));

        const rowsRLE = [];

        for (let j = 0; j < h; j++) {
            // Run-length encode row: [val,len,val,len,...], where val is 0/1 walkable
            const row = [];
            let runVal = null;
            let runLen = 0;

            for (let i = 0; i < w; i++) {
                const cx = minX + (i + 0.5) * cellSize;
                const cy = minY + (j + 0.5) * cellSize;

                // Inside bounds + not colliding with walls/obstacles.
                let walkable = 1;
                try {
                    if (env && typeof env.isInsideBounds === 'function') {
                        if (!env.isInsideBounds(cx, cy, radius)) walkable = 0;
                    }
                    if (walkable && env && typeof env.circleHitsAny === 'function') {
                        // IMPORTANT: env.circleHitsAny already uses obstacles + orientedBoxes (trench walls, defensive walls, etc.)
                        if (env.circleHitsAny(cx, cy, radius)) walkable = 0;
                    }
                } catch(_) { /* keep best-effort */ }

                if (runVal === null) {
                    runVal = walkable;
                    runLen = 1;
                } else if (walkable === runVal) {
                    runLen++;
                } else {
                    row.push(runVal, runLen);
                    runVal = walkable;
                    runLen = 1;
                }
            }
            if (runVal !== null) row.push(runVal, runLen);
            rowsRLE.push(row);
        }

        return { cellSize, radius, minX, minY, w, h, rowsRLE };
    }

    _initNavProperties(entity) {
        // Initialize navmesh pathfinding properties for enemies, troops, NPCs
        entity._navPath = null;           // Array of {x, y} waypoints
        entity._navWaypointIndex = 0;     // Current waypoint being followed
        entity._navLastUpdate = 0;        // Last time path was computed (ms)
        entity._navStuckTimer = 0;        // Time spent not making progress (seconds)
        entity._navLastPos = { x: entity.x, y: entity.y }; // For stuck detection
    }

    // =========================================
    // RESET TO LOBBY (Mission End)
    // =========================================

    resetToLobby() {
        console.log(`[Server] Resetting room ${this.room.id} to lobby`);
        
        // Reset scene and boundary
        this.room.scene = 'lobby';
        this.room.boundary = 1000;
        
        // Recreate lobby environment
        this.room.environment = this._createEnvironmentForScene('lobby');
        console.log(`[RESET] Recreated lobby environment with ${this.room.environment.obstacles.length} obstacles`);
        
        // Clear all level-specific state
        this.room.enemies.clear();
        this.room.chests.clear();
        this.room.groundItems.clear();
        this.room.levelSpawns = null;
        this.room.extractionZone = null;
        this.room.hereticExtractionZone = null;
        this.room.bossSpawn = null;
        this.room.boss = null;
        
        // Clear all abilities (shield walls, turrets, etc.)
        for (const [abilityId, ability] of this.room.abilities) {
            this.io.to(this.room.id).emit('abilityExpired', { serverId: abilityId });
        }
        this.room.abilities.clear();
        console.log('[RESET] Cleared all abilities');
        
        // Reset timers
        this.room.readyTimer = {
            started: false,
            completed: false,
            timeTotal: 10.0,
            timeLeft: 0,
            startedBy: null
        };
        this.room.extractionTimer = {
            started: false,
            extracted: false,
            timeTotal: 60.0,
            timeLeft: 0,
            startedBy: null,
            type: 'normal'
        };
        
        // Reset enemy network mode
        this.room.enemyNetMode = 'spawnOnly';
        
        // Reset mission accomplishments
        this.room.missionAccomplishments = {
            artilleryWitchKilled: false,
            prisonerMissionSuccess: false,
            hereticPriestKilled: false,
            radioTowerPowered: false,
            extractedBeforeArtillery: false,
            artifactFinalHealth: null,
            artifactHealthMax: null
        };
        
        // Reset frozen artillery timer
        this.room.artilleryFrozenElapsedMs = null;
        
        // Reset mission ended flag
        this.room.missionEnded = false;
        
        // Respawn lobby NPCs
        if (this.room.npcManager) {
            this.room.npcManager.npcs = [];
        }
        this.room.spawnLobbyAmbientNpcs();
        
        // Note: Target dummy is spawned by clients when they receive scene change
        
        // Clear all puke pools
        if (Array.isArray(this.room.boomerPools)) {
            this.room.boomerPools.length = 0;
        }
        
        // Clear all enemy projectiles
        if (Array.isArray(this.room.enemyProjectiles)) {
            this.room.enemyProjectiles.length = 0;
        }
        
        // Clear Trench Raid battery system state (RadioTower + batteries) so it never leaks into lobby / late-join snapshots
        try {
            if (this.room.batteries && typeof this.room.batteries.clear === 'function') {
                this.room.batteries.clear();
            }
        } catch(_) {}
        this.room.batteries = null;
        this.room.batteryStation = null;
        this.room.artilleryBonusTimeMs = 0;

        // Reset lobby shooting-gallery hazards to default (sandbags row).
        // These are intentionally server-authoritative so they reliably reappear after missions.
        try {
            this.room.hazards = new EnvironmentHazards(this.room, this.room.environment, {
                mode: 'leftRow',
                leftInset: 260,
                rowSpacing: 280,
                extraSandbags: 3
            }, 'test'); // HazardsConfig for 'test' is disabled; we explicitly spawn the lobby row below.
            this.room.hazards.spawnLeftEdgeRow(['sandbags']);
            const hzPayload = this.room.hazards.serialize();
            this.io.to(this.room.id).emit('hazardsState', hzPayload);
            console.log('[RESET] Recreated lobby hazards:', { sandbags: hzPayload?.sandbags?.length || 0 });
        } catch (e) {
            console.warn('[RESET] Failed to recreate lobby hazards:', e && e.message ? e.message : String(e));
            this.room.hazards = null;
        }
        
        // Reset all player states
        for (const [id, player] of this.room.players) {
            player.health = player.healthMax || 100;
            player.alive = true;
            player.artifactCarried = null;
            player.inventory = [];
            player.lootLevel = 0;  // Reset loot level to match empty inventory
            
            // Clear all status effects
            try {
                // Clear DOT stacks
                if (Array.isArray(player.dotStacks)) player.dotStacks.length = 0;
                player._dotAccum = 0;
                player._dotTextTimer = 0;
                
                // Clear ensnare effects
                if (player._ensnaredBy && typeof player._ensnaredBy.clear === 'function') {
                    player._ensnaredBy.clear();
                }
                player._ensnaredTimer = 0;
                player._ensnaredById = null;
                
                // Clear puke pool slow effects
                player._svSlowTimer = 0;
                player._svSlowed = false;
                
                // Broadcast cleared slow state to all clients
                this.io.to(this.room.id).emit('playerSlowState', { playerId: id, slowed: false });
                this.io.to(this.room.id).emit('playerMudSlowState', { playerId: id, slowed: false });
            } catch(e) {
                console.error(`[Server] Error clearing status effects for player ${id}:`, e);
            }
            
            // Reset position to lobby spawn (0,0)
            player.x = 0;
            player.y = 0;
        }
        console.log('[RESET] Cleared all player status effects and reset positions to lobby spawn');
        
        // Broadcast scene change to all clients
        this.io.to(this.room.id).emit('sceneChange', {
            scene: 'lobby',
            boundary: 1000,
            obstacles: this.room.environment.obstacles,
            levelSpawns: null
        });
        
        // Ensure lobby training dummies always exist on lobby return.
        // IMPORTANT: Must happen AFTER the lobby sceneChange so clients have already cleared/rebuilt their scene.
        try { this.spawnLobbyTargetDummy(5); } catch(_) {}
        
        console.log(`[RESET] Room ${this.room.id} reset to lobby complete`);
    }

    // =========================================
    // LEGACY SPAWN COMPUTATION (Fallback)
    // =========================================

    _legacyComputeLevelSpawns() {
        try {
            if (this.room.scene !== 'level' || !this.room.environment) return null;
            const env = this.room.environment;
            const rng = new SeededRNG(this.room.worldSeed);
            const clearance = 28;
            const chests = [];
            let goldX = null, goldY = null;
            // Preferred test location near center
            const testX = 200;
            const testY = 150;
            const isClear = (x, y, r) => env.isInsideBounds(x, y, r) && !env.circleHitsAny(x, y, r);
            if (isClear(testX, testY, clearance)) {
                goldX = testX; goldY = testY;
            } else {
                const tries = 300;
                for (let i = 0; i < tries; i++) {
                    const ang = rng.randomFloat(0, Math.PI * 2);
                    const dist = 100 + rng.randomFloat(0, 300);
                    const nx = Math.cos(ang) * dist;
                    const ny = Math.sin(ang) * dist;
                    if (isClear(nx, ny, clearance)) { goldX = nx; goldY = ny; break; }
                }
            }
            if (goldX == null || goldY == null) return null;
            // Push gold chest
            chests.push({ id: `${Math.round(goldX)},${Math.round(goldY)}`, x: goldX, y: goldY, variant: 'gold' });
            // Brown chest near gold using seeded RNG
            for (let j = 0; j < 200; j++) {
                const ang2 = rng.randomFloat(0, Math.PI * 2);
                const d2 = 120 + rng.randomFloat(0, 180);
                const nx2 = goldX + Math.cos(ang2) * d2;
                const ny2 = goldY + Math.sin(ang2) * d2;
                if (isClear(nx2, ny2, clearance)) {
                    chests.push({ id: `${Math.round(nx2)},${Math.round(ny2)}`, x: nx2, y: ny2, variant: 'brown' });
                    break;
                }
            }
            // Spawn two NPCs near chest (types are labels for client)
            const npcs = [];
            const maxDist = 500;
            const npcR = 24;
            const triesNpc = 700;
            let placedA = false, placedB = false;
            for (let t = 0; t < triesNpc && (!placedA || !placedB); t++) {
                const ang = rng.randomFloat(0, Math.PI * 2);
                const dist = rng.randomFloat(0, maxDist);
                const tx = goldX + Math.cos(ang) * dist;
                const ty = goldY + Math.sin(ang) * dist;
                if (!isClear(tx, ty, npcR)) continue;
                // avoid overlapping any chest
                let okChest = true;
                for (let k = 0; k < chests.length; k++) {
                    const c = chests[k];
                    const cr = 20;
                    const dx = tx - c.x, dy = ty - c.y;
                    if (dx*dx + dy*dy <= (cr + npcR + 6) * (cr + npcR + 6)) { okChest = false; break; }
                }
                if (!okChest) continue;
                // avoid overlapping prior npc
                let okNpc = true;
                for (let k = 0; k < npcs.length; k++) {
                    const n = npcs[k];
                    const dx = tx - n.x, dy = ty - n.y;
                    if (dx*dx + dy*dy <= (npcR + (n.radius||24) + 6) * (npcR + (n.radius||24) + 6)) { okNpc = false; break; }
                }
                if (!okNpc) continue;
                if (!placedA) { npcs.push({ type: 'NPC_A', x: tx, y: ty, radius: npcR }); placedA = true; continue; }
                if (!placedB) { npcs.push({ type: 'NPC_B', x: tx, y: ty, radius: npcR }); placedB = true; continue; }
            }
            return { chests, npcs };
        } catch (e) {
            console.error('[Server] Failed to compute level spawns:', e);
            return null;
        }
    }
    
    _legacyComputeEnemySpawns() {
        try {
            if (this.room.scene !== 'level' || !this.room.environment) return [];
            const env = this.room.environment;
            const rng = new SeededRNG(this.room.worldSeed + 777); // separate stream for enemies
            const max = env.maxRange || 10000;
            const enemyRadius = 26;
            const MOVEMENT_CLEARANCE = 16; // Add clearance to prevent spawning too close to obstacles
            const spawnCheckRadius = enemyRadius + MOVEMENT_CLEARANCE;
            const triesPerEnemy = 40;
            const totalCount = 800; // tune as needed

            const list = [];
            const sx = env.spawnSafeX || 0, sy = env.spawnSafeY || 0;
            const halfSafe = 750;

            const isClear = (x, y) => {
                if (!env.isInsideBounds(x, y, spawnCheckRadius)) return false;
                if (env.circleHitsAny && env.circleHitsAny(x, y, spawnCheckRadius)) return false;
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
                        // Mix enemy types: 35% basic, 25% licker, 25% projectile, 15% boomer
                        const roll = rng.random();
                        let type = 'basic';
                        if (roll < 0.15) {
                            type = 'boomer';
                        } else if (roll < 0.40) {
                            type = 'projectile';
                        } else if (roll < 0.65) {
                            type = 'licker';
                        }
                        // else remains 'basic' (65% to 100% = 35%)
                        list.push({ id, x, y, type });
                        placed = true;
                    }
                }
            }
            return list;
        } catch (e) {
            console.error('[Server] Failed to compute enemy spawns:', e);
            return [];
        }
    }

    // =========================================
    // EXTRACTION ZONE AND BOSS SPAWN COMPUTATION
    // =========================================

    _computeExtractionAndBossSpawns() {
        try {
            if (this.room.scene !== 'level' || !this.room.environment) return null;
            if (this.room.extractionZone) return { extractionZone: this.room.extractionZone, bossSpawn: this.room.bossSpawn, hereticExtractionZone: this.room.hereticExtractionZone }; // Already computed
            
            const env = this.room.environment;
            const rng = new SeededRNG(this.room.worldSeed + 1234); // Separate seed stream for extraction zones
            
            // Find gold chest position as reference
            let goldX = null, goldY = null;
            for (const [id, chest] of this.room.chests) {
                if (chest.variant === 'gold') {
                    goldX = chest.x;
                    goldY = chest.y;
                    break;
                }
            }
            if (goldX === null || goldY === null) return null;
            
            // Find first player position as fallback reference
            let refPlayerX = 0, refPlayerY = 0;
            for (const [pid, p] of this.room.players) {
                refPlayerX = p.x || 0;
                refPlayerY = p.y || 0;
                break;
            }
            
            // Check if game mode has custom extraction zone logic (e.g., trench raid left-side zone)
            let extractionX = null, extractionY = null;
            if (this.room.currentGameMode && typeof this.room.currentGameMode.computeExtractionZone === 'function') {
                // Use existing rng from extraction spawns computation
                const zone = this.room.currentGameMode.computeExtractionZone(env, rng);
                if (zone && zone.x !== undefined && zone.y !== undefined) {
                    extractionX = zone.x;
                    extractionY = zone.y;
                    this.room.extractionZone = { x: extractionX, y: extractionY, size: zone.radius || 450 };
                    console.log(`[Server] Using mode-specific extraction zone at (${extractionX.toFixed(1)}, ${extractionY.toFixed(1)})`);
                }
            }
            
            // Fallback: use default random placement if mode doesn't provide custom logic
            if (extractionX === null || extractionY === null) {
                const refX = goldX;
                const refY = goldY;
                const minFar = 2800;
                const maxFar = 5200;
                const tries = 400;
                const clearance = 160;
                
                // Compute extraction zone position
                for (let i = 0; i < tries; i++) {
                    const ang = rng.randomFloat(0, Math.PI * 2);
                    const dist = rng.randomFloat(minFar, maxFar);
                    const nx = refX + Math.cos(ang) * dist;
                    const ny = refY + Math.sin(ang) * dist;
                    if (env.isInsideBounds(nx, ny, clearance) && !env.circleHitsAny(nx, ny, clearance)) {
                        extractionX = nx;
                        extractionY = ny;
                        break;
                    }
                }
                if (extractionX === null || extractionY === null) {
                    extractionX = refX + 3600;
                    extractionY = refY + 3600;
                }
                
                this.room.extractionZone = { x: extractionX, y: extractionY, size: 450 };
                console.log(`[Server] Computed default extraction zone at (${extractionX.toFixed(1)}, ${extractionY.toFixed(1)})`);
            }
            
            // Compute boss spawn position
            const bossRadius = 78;
            let bossX = null, bossY = null;
            
            // Check if game mode has custom boss spawn logic (e.g., TrenchRaid spawns boss near artifact)
            if (this.room.currentGameMode && typeof this.room.currentGameMode.computeBossSpawn === 'function') {
                const bossPos = this.room.currentGameMode.computeBossSpawn(env, rng, goldX, goldY, extractionX, extractionY, refPlayerX, refPlayerY);
                if (bossPos && bossPos.x !== undefined && bossPos.y !== undefined) {
                    bossX = bossPos.x;
                    bossY = bossPos.y;
                    console.log(`[Server] Using mode-specific boss spawn at (${bossX.toFixed(1)}, ${bossY.toFixed(1)})`);
                }
            }
            
            // Default boss spawn logic if mode doesn't provide custom logic
            if (bossX === null || bossY === null) {
                const minDistPlayer = 2600;
                const minDistZone = 2600;
                const triesBoss = 700;
                const b = env.boundary - bossRadius - 10;
                
                for (let i = 0; i < triesBoss; i++) {
                    const nx = (rng.randomFloat(0, 1) * 2 - 1) * b;
                    const ny = (rng.randomFloat(0, 1) * 2 - 1) * b;
                    
                    // Distance from first player
                    const dpx = nx - refPlayerX;
                    const dpy = ny - refPlayerY;
                    if (dpx * dpx + dpy * dpy < minDistPlayer * minDistPlayer) continue;
                    
                    // Distance from extraction zone
                    const dzx = nx - extractionX;
                    const dzy = ny - extractionY;
                    if (dzx * dzx + dzy * dzy < minDistZone * minDistZone) continue;
                    
                    // Environment checks
                    if (!env.isInsideBounds(nx, ny, bossRadius)) continue;
                    if (env.circleHitsAny(nx, ny, bossRadius)) continue;
                    
                    bossX = nx;
                    bossY = ny;
                    break;
                }
                
                // Fallback boss position
                if (bossX === null || bossY === null) {
                    bossX = refPlayerX + 3200;
                    bossY = refPlayerY + 3200;
                    if (!env.isInsideBounds(bossX, bossY, bossRadius) || env.circleHitsAny(bossX, bossY, bossRadius)) {
                        bossX = Math.max(-b, Math.min(b, bossX));
                        bossY = Math.max(-b, Math.min(b, bossY));
                    }
                }
                console.log(`[Server] Using default boss spawn at (${bossX.toFixed(1)}, ${bossY.toFixed(1)})`);
            }
            
            this.room.bossSpawn = { x: bossX, y: bossY };
            console.log(`[Server] Computed boss spawn at (${bossX.toFixed(1)}, ${bossY.toFixed(1)})`);
            
            // Create boss enemy on server for tracking and replication
            const bossId = `boss_${bossX.toFixed(0)}_${bossY.toFixed(0)}`;
            if (!this.room.enemies.has(bossId)) {
                const boss = {
                    id: bossId,
                    x: bossX,
                    y: bossY,
                    type: 'boss',
                    alive: true,
                    health: 2000,        // Artillery Witch boss-tier health
                    healthMax: 2000,
                    radius: 32,          // Artillery Witch radius (Boomer-sized)
                    // Artillery Witch specific state
                    speedMul: 0,
                    preferContact: false,
                    kbTime: 0,
                    kbVelX: 0,
                    kbVelY: 0,
                    _artilleryTimer: 1.0 + Math.random() * 0.8,
                    _artilleryCooldown: 1.25,
                    _dashCooldown: 1.5 + Math.random(),
                    _dashDistance: 360,
                    _dashDuration: 0.2,
                    _burstMode: false,
                    _burstTimer: 0,
                    _burstShotTimer: 0,
                    _targetPlayerId: null,  // Track which player is being targeted
                    _lastStrikeX: 0,        // For client telegraph sync
                    _lastStrikeY: 0,
                    _lastStrikeTime: 0
                };
                
                // Initialize navmesh pathfinding properties
                this._initNavProperties(boss);
                
                this.room.enemies.set(bossId, boss);
                console.log(`[Server] Created boss enemy entity with id: ${bossId}`);
            }
            
            // Spawn difficulty 3 horde near the Witch when she appears (direct spawn, no camera check)
            if (this.room.hordeSpawner) {
                console.log('[Boss] Artillery Witch spawned - summoning difficulty 3 horde near her position!');
                const preset = this.room.hordeSpawner.config.DIFFICULTY_PRESETS[3];
                const rngHorde = this.room._rng(this.room.worldSeed + 7777);
                const spawned = [];
                
                // Minimum distance from gold chest to avoid spawning horde on top of it
                const minDistFromGold = 600;
                
                for (let i = 0; i < preset.size; i++) {
                    let placed = false;
                    for (let tries = 0; tries < 50 && !placed; tries++) {
                        // Random position 400-800 units from boss (closer to witch, away from chest)
                        const angle = rngHorde() * Math.PI * 2;
                        const dist = 400 + rngHorde() * 400;
                        const ex = bossX + Math.cos(angle) * dist;
                        const ey = bossY + Math.sin(angle) * dist;
                        
                        // Check bounds and obstacles only (no camera check)
                        // Use 42 = 26 base radius + 16 movement clearance to prevent spawning too close to obstacles
                        if (!env.isInsideBounds(ex, ey, 42)) continue;
                        if (env.circleHitsAny && env.circleHitsAny(ex, ey, 42)) continue;
                        
                        // Avoid spawning too close to gold chest
                        const dxGold = ex - goldX;
                        const dyGold = ey - goldY;
                        const distToGold = Math.sqrt(dxGold * dxGold + dyGold * dyGold);
                        if (distToGold < minDistFromGold) continue;
                        
                        // Pick enemy type
                        const roll = rngHorde();
                        let type = 'basic';
                        let acc = 0;
                        for (const t of ['boomer', 'projectile', 'licker', 'bigboy', 'wallguy']) {
                            acc += preset.typeRatios[t] || 0;
                            if (roll < acc) { type = t; break; }
                        }
                        
                        const id = `enemy_${this.room.nextEnemyId++}`;
                        const enemy = {
                            id, x: ex, y: ey, type,
                            radius: 26, health: 100, healthMax: 100,
                            speedMul: 1.0, alive: true,
                            _preAggroGoal: { x: bossX, y: bossY, radius: 400, dynamic: false, source: 'boss_spawn' },
                            _spawnedFrom: 'bossHorde'
                        };
                        
                        if (this.room.currentGameMode) {
                            this.room.currentGameMode.initializeEnemyStats(enemy);
                        }
                        
                        // Initialize navmesh pathfinding properties
                        this._initNavProperties(enemy);
                        
                        this.room.enemies.set(id, enemy);
                        spawned.push(enemy);
                        placed = true;
                    }
                }
                
                if (spawned.length > 0) {
                    this.room.spawnAmbientBatch(spawned);
                    console.log(`[Boss] Spawned ${spawned.length} enemies near Witch at spawn (away from gold chest)`);
                    
                    this.io.to(this.room.id).emit('horde_spawned', {
                        difficulty: 3,
                        count: spawned.length,
                        phase: 'boss_spawn',
                        message: 'The Witch calls her servants!'
                    });
                }
            }
            
            // Compute heretic extraction zone if needed (optional for now, can be computed on demand)
            // For now, we'll compute it with a similar logic
            const minFarFromGreen = 2200;
            const minFarFromGold = 2200;
            const minFarFromBoss = 2200;
            let hereticX = null, hereticY = null;
            const baseX = goldX + 3800, baseY = goldY - 3600;
            
            for (let i = 0; i < 600; i++) {
                const ang = rng.randomFloat(0, Math.PI * 2);
                const dist = rng.randomFloat(3000, 5400);
                const nx = baseX + Math.cos(ang) * dist;
                const ny = baseY + Math.sin(ang) * dist;
                
                if (!env.isInsideBounds(nx, ny, 160)) continue;
                if (env.circleHitsAny(nx, ny, 160)) continue;
                
                // Far from normal extraction
                const dxe = nx - extractionX;
                const dye = ny - extractionY;
                if (dxe * dxe + dye * dye < minFarFromGreen * minFarFromGreen) continue;
                
                // Far from gold chest
                const dxg = nx - goldX;
                const dyg = ny - goldY;
                if (dxg * dxg + dyg * dyg < minFarFromGold * minFarFromGold) continue;
                
                // Far from boss
                const dxb = nx - bossX;
                const dyb = ny - bossY;
                if (dxb * dxb + dyb * dyb < minFarFromBoss * minFarFromBoss) continue;
                
                hereticX = nx;
                hereticY = ny;
                break;
            }
            
            if (hereticX === null || hereticY === null) {
                // Fallback
            hereticX = goldX - 3600;
            hereticY = goldY - 3600;
        }
        
        this.room.hereticExtractionZone = { x: hereticX, y: hereticY, size: 450 };
            console.log(`[Server] Computed heretic extraction zone at (${hereticX.toFixed(1)}, ${hereticY.toFixed(1)})`);
            
            return {
                extractionZone: this.room.extractionZone,
                bossSpawn: this.room.bossSpawn,
                hereticExtractionZone: this.room.hereticExtractionZone
            };
        } catch (e) {
            console.error('[Server] Failed to compute extraction zones and boss spawn:', e);
            return null;
        }
    }
}

module.exports = LevelManager;
