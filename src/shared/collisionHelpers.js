/**
 * Universal Collision Detection Helpers
 * Shared between client and server for consistent physics
 * Works in both browser and Node.js environments
 */

(function(root, factory) {
    // Universal Module Definition (UMD) pattern
    if (typeof module === 'object' && module.exports) {
        // Node.js / CommonJS
        module.exports = factory();
    } else {
        // Browser globals
        root.CollisionHelpers = factory();
    }
}(typeof self !== 'undefined' ? self : this, function() {
    'use strict';

    /**
     * Shared collision detection and resolution methods
     */
    const CollisionHelpers = {
        /**
         * Clamp value between min and max
         */
        clamp(v, min, max) {
            return v < min ? min : (v > max ? max : v);
        },

        /**
         * Check if circle intersects with axis-aligned bounding box (AABB)
         * @param {number} cx - Circle center X
         * @param {number} cy - Circle center Y
         * @param {number} cr - Circle radius
         * @param {object} rect - Rectangle with {x, y, w, h} (center + size)
         * @returns {boolean} True if circle intersects rectangle
         */
        circleIntersectsRect(cx, cy, cr, rect) {
            const left = rect.x - rect.w / 2;
            const top = rect.y - rect.h / 2;
            const right = left + rect.w;
            const bottom = top + rect.h;
            
            // Find closest point on rectangle to circle center
            const closestX = this.clamp(cx, left, right);
            const closestY = this.clamp(cy, top, bottom);
            
            // Calculate distance from circle center to closest point
            const dx = cx - closestX;
            const dy = cy - closestY;
            
            // Check if distance is less than circle radius
            return (dx * dx + dy * dy) < (cr * cr);
        },

        /**
         * Check if circle intersects with oriented (rotated) bounding box
         * @param {number} cx - Circle center X
         * @param {number} cy - Circle center Y
         * @param {number} cr - Circle radius
         * @param {object} box - Oriented box with {x, y, w, h, angle}
         * @returns {boolean} True if circle intersects oriented box
         */
        circleIntersectsOrientedBox(cx, cy, cr, box) {
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
            
            const closestX = this.clamp(localX, -halfW, halfW);
            const closestY = this.clamp(localY, -halfH, halfH);
            const distX = localX - closestX;
            const distY = localY - closestY;
            
            return (distX * distX + distY * distY) < (cr * cr);
        },

        /**
         * Check if circle hits any obstacles in array
         * @param {number} cx - Circle center X
         * @param {number} cy - Circle center Y
         * @param {number} cr - Circle radius
         * @param {array} obstacles - Array of rectangles with {x, y, w, h}
         * @param {array} orientedBoxes - Optional array of oriented boxes with {x, y, w, h, angle}
         * @returns {boolean} True if circle hits any obstacle
         */
        circleHitsAny(cx, cy, cr, obstacles, orientedBoxes) {
            // Check regular AABB obstacles
            for (let i = 0; i < obstacles.length; i++) {
                if (this.circleIntersectsRect(cx, cy, cr, obstacles[i])) {
                    return true;
                }
            }
            // Check oriented boxes (rotated rectangles)
            if (orientedBoxes) {
                for (let i = 0; i < orientedBoxes.length; i++) {
                    if (this.circleIntersectsOrientedBox(cx, cy, cr, orientedBoxes[i])) {
                        return true;
                    }
                }
            }
            return false;
        },

        /**
         * Check if circle is inside world bounds
         * @param {number} cx - Circle center X
         * @param {number} cy - Circle center Y
         * @param {number} cr - Circle radius
         * @param {number} boundary - World boundary half-extent
         * @returns {boolean} True if circle is fully inside bounds
         */
        isInsideBounds(cx, cy, cr, boundary) {
            return (cx - cr >= -boundary && cx + cr <= boundary && 
                    cy - cr >= -boundary && cy + cr <= boundary);
        },

        /**
         * Resolve circle movement with collision detection
         * Uses swept circle vs AABB collision with axis separation
         * @param {number} x - Circle current X
         * @param {number} y - Circle current Y
         * @param {number} radius - Circle radius
         * @param {number} dx - Movement delta X
         * @param {number} dy - Movement delta Y
         * @param {array} obstacles - Array of rectangles to collide with
         * @param {number} boundary - World boundary half-extent
         * @param {array} orientedBoxes - Optional array of oriented boxes
         * @returns {object} {x, y} - Resolved position after collision
         */
        resolveCircleMove(x, y, radius, dx, dy, obstacles, boundary, orientedBoxes) {
            let newX = x;
            let newY = y;
            
            // Move along X axis first
            if (dx !== 0) {
                newX += dx;
                for (let i = 0; i < obstacles.length; i++) {
                    const ob = obstacles[i];
                    if (!this.circleIntersectsRect(newX, newY, radius, ob)) continue;
                    
                    const left = ob.x - ob.w / 2;
                    const top = ob.y - ob.h / 2;
                    const right = left + ob.w;
                    const bottom = top + ob.h;
                    
                    // Only resolve if vertically overlapping enough
                    if (newY + radius <= top || newY - radius >= bottom) continue;
                    
                    // Push circle out of rectangle
                    if (dx > 0) newX = left - radius;
                    else newX = right + radius;
                }
                // Check oriented boxes during X-axis movement
                if (orientedBoxes) {
                    for (let i = 0; i < orientedBoxes.length; i++) {
                        const box = orientedBoxes[i];
                        if (!this.circleIntersectsOrientedBox(newX, newY, radius, box)) continue;
                        
                        // Transform circle to box local space for proper edge collision
                        const boxDx = newX - box.x;
                        const boxDy = newY - box.y;
                        const cos = Math.cos(-box.angle);
                        const sin = Math.sin(-box.angle);
                        const localX = boxDx * cos - boxDy * sin;
                        const localY = boxDx * sin + boxDy * cos;
                        
                        // Find closest point on box surface in local space
                        const halfW = box.w / 2;
                        const halfH = box.h / 2;
                        const closestX = this.clamp(localX, -halfW, halfW);
                        const closestY = this.clamp(localY, -halfH, halfH);
                        
                        // Calculate penetration depth
                        const penX = localX - closestX;
                        const penY = localY - closestY;
                        const penDist = Math.hypot(penX, penY);
                        
                        if (penDist > 0.01) {
                            // Calculate FULL resolution vector in local space
                            const normalX = penX / penDist;
                            const normalY = penY / penDist;
                            const resolveLocalX = normalX * (radius - penDist);
                            const resolveLocalY = normalY * (radius - penDist);
                            
                            // Transform FULL vector back to world space using 2D rotation matrix
                            // Only apply X component during X-axis movement
                            const worldResolveX = resolveLocalX * cos + resolveLocalY * sin;
                            newX += worldResolveX;
                        }
                    }
                }
            }
            
            // Move along Y axis second
            if (dy !== 0) {
                newY += dy;
                for (let i = 0; i < obstacles.length; i++) {
                    const ob = obstacles[i];
                    if (!this.circleIntersectsRect(newX, newY, radius, ob)) continue;
                    
                    const left = ob.x - ob.w / 2;
                    const top = ob.y - ob.h / 2;
                    const right = left + ob.w;
                    const bottom = top + ob.h;
                    
                    // Only resolve if horizontally overlapping enough
                    if (newX + radius <= left || newX - radius >= right) continue;
                    
                    // Push circle out of rectangle
                    if (dy > 0) newY = top - radius;
                    else newY = bottom + radius;
                }
                // Check oriented boxes during Y-axis movement
                if (orientedBoxes) {
                    for (let i = 0; i < orientedBoxes.length; i++) {
                        const box = orientedBoxes[i];
                        if (!this.circleIntersectsOrientedBox(newX, newY, radius, box)) continue;
                        
                        // Transform circle to box local space for proper edge collision
                        const boxDx = newX - box.x;
                        const boxDy = newY - box.y;
                        const cos = Math.cos(-box.angle);
                        const sin = Math.sin(-box.angle);
                        const localX = boxDx * cos - boxDy * sin;
                        const localY = boxDx * sin + boxDy * cos;
                        
                        // Find closest point on box surface in local space
                        const halfW = box.w / 2;
                        const halfH = box.h / 2;
                        const closestX = this.clamp(localX, -halfW, halfW);
                        const closestY = this.clamp(localY, -halfH, halfH);
                        
                        // Calculate penetration depth
                        const penX = localX - closestX;
                        const penY = localY - closestY;
                        const penDist = Math.hypot(penX, penY);
                        
                        if (penDist > 0.01) {
                            // Calculate FULL resolution vector in local space
                            const normalX = penX / penDist;
                            const normalY = penY / penDist;
                            const resolveLocalX = normalX * (radius - penDist);
                            const resolveLocalY = normalY * (radius - penDist);
                            
                            // Transform FULL vector back to world space using 2D rotation matrix
                            // Only apply Y component during Y-axis movement
                            const worldResolveY = -resolveLocalX * sin + resolveLocalY * cos;
                            newY += worldResolveY;
                        }
                    }
                }
            }
            
            // Clamp to world boundary
            if (boundary) {
                if (newX > boundary - radius) newX = boundary - radius;
                if (newX < -boundary + radius) newX = -boundary + radius;
                if (newY > boundary - radius) newY = boundary - radius;
                if (newY < -boundary + radius) newY = -boundary + radius;
            }
            
            return { x: newX, y: newY };
        },

        /**
         * Resolve circle movement with collision detection, returning hit details.
         * This is a debug-friendly variant used by the server to report what blocked movement.
         * @returns {object} { x, y, hits?: Array }
         */
        resolveCircleMoveWithHits(x, y, radius, dx, dy, obstacles, boundary, orientedBoxes) {
            let newX = x;
            let newY = y;
            let hits = null;
            const addHit = (h) => { (hits || (hits = [])).push(h); };

            // Move along X axis first
            if (dx !== 0) {
                newX += dx;
                for (let i = 0; i < obstacles.length; i++) {
                    const ob = obstacles[i];
                    if (!this.circleIntersectsRect(newX, newY, radius, ob)) continue;

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

                    // Push circle out of rectangle
                    if (dx > 0) newX = left - radius;
                    else newX = right + radius;
                }
                // Check oriented boxes during X-axis movement
                if (orientedBoxes) {
                    for (let i = 0; i < orientedBoxes.length; i++) {
                        const box = orientedBoxes[i];
                        if (!box) continue;
                        if (!this.circleIntersectsOrientedBox(newX, newY, radius, box)) continue;

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

                        // Transform circle to box local space for proper edge collision
                        const boxDx = newX - box.x;
                        const boxDy = newY - box.y;
                        const cos = Math.cos(-box.angle);
                        const sin = Math.sin(-box.angle);
                        const localX = boxDx * cos - boxDy * sin;
                        const localY = boxDx * sin + boxDy * cos;

                        // Find closest point on box surface in local space
                        const halfW = box.w / 2;
                        const halfH = box.h / 2;
                        const closestX = this.clamp(localX, -halfW, halfW);
                        const closestY = this.clamp(localY, -halfH, halfH);

                        // Calculate penetration depth
                        const penX = localX - closestX;
                        const penY = localY - closestY;
                        const penDist = Math.hypot(penX, penY);

                        if (penDist > 0.01) {
                            // Calculate FULL resolution vector in local space
                            const normalX = penX / penDist;
                            const normalY = penY / penDist;
                            const resolveLocalX = normalX * (radius - penDist);
                            const resolveLocalY = normalY * (radius - penDist);

                            // Transform FULL vector back to world space
                            // Only apply X component during X-axis movement
                            const worldResolveX = resolveLocalX * cos + resolveLocalY * sin;
                            newX += worldResolveX;
                        }
                    }
                }
            }

            // Move along Y axis second
            if (dy !== 0) {
                newY += dy;
                for (let i = 0; i < obstacles.length; i++) {
                    const ob = obstacles[i];
                    if (!this.circleIntersectsRect(newX, newY, radius, ob)) continue;

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

                    // Push circle out of rectangle
                    if (dy > 0) newY = top - radius;
                    else newY = bottom + radius;
                }
                // Check oriented boxes during Y-axis movement
                if (orientedBoxes) {
                    for (let i = 0; i < orientedBoxes.length; i++) {
                        const box = orientedBoxes[i];
                        if (!box) continue;
                        if (!this.circleIntersectsOrientedBox(newX, newY, radius, box)) continue;

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

                        // Transform circle to box local space for proper edge collision
                        const boxDx = newX - box.x;
                        const boxDy = newY - box.y;
                        const cos = Math.cos(-box.angle);
                        const sin = Math.sin(-box.angle);
                        const localX = boxDx * cos - boxDy * sin;
                        const localY = boxDx * sin + boxDy * cos;

                        // Find closest point on box surface in local space
                        const halfW = box.w / 2;
                        const halfH = box.h / 2;
                        const closestX = this.clamp(localX, -halfW, halfW);
                        const closestY = this.clamp(localY, -halfH, halfH);

                        // Calculate penetration depth
                        const penX = localX - closestX;
                        const penY = localY - closestY;
                        const penDist = Math.hypot(penX, penY);

                        if (penDist > 0.01) {
                            // Calculate FULL resolution vector in local space
                            const normalX = penX / penDist;
                            const normalY = penY / penDist;
                            const resolveLocalX = normalX * (radius - penDist);
                            const resolveLocalY = normalY * (radius - penDist);

                            // Transform FULL vector back to world space
                            // Only apply Y component during Y-axis movement
                            const worldResolveY = -resolveLocalX * sin + resolveLocalY * cos;
                            newY += worldResolveY;
                        }
                    }
                }
            }

            // Clamp to world boundary
            const preClampX = newX, preClampY = newY;
            if (boundary) {
                if (newX > boundary - radius) newX = boundary - radius;
                if (newX < -boundary + radius) newX = -boundary + radius;
                if (newY > boundary - radius) newY = boundary - radius;
                if (newY < -boundary + radius) newY = -boundary + radius;
            }
            if (preClampX !== newX || preClampY !== newY) {
                addHit({
                    kind: 'bounds',
                    mode: 'square',
                    from: { x: preClampX, y: preClampY },
                    to: { x: newX, y: newY }
                });
            }

            const out = { x: newX, y: newY };
            if (hits) out.hits = hits;
            return out;
        },

        /**
         * Line segment vs AABB intersection test (Cohen-Sutherland algorithm)
         * @param {number} x1 - Line start X
         * @param {number} y1 - Line start Y
         * @param {number} x2 - Line end X
         * @param {number} y2 - Line end Y
         * @param {object} rect - Rectangle with {x, y, w, h}
         * @returns {boolean} True if line segment intersects rectangle
         */
        segmentIntersectsRect(x1, y1, x2, y2, rect) {
            const left = rect.x - rect.w / 2;
            const right = rect.x + rect.w / 2;
            const top = rect.y - rect.h / 2;
            const bottom = rect.y + rect.h / 2;
            
            // Cohen-Sutherland outcodes
            const INSIDE = 0, LEFT = 1, RIGHT = 2, BOTTOM = 4, TOP = 8;
            
            const outCode = (px, py) => {
                let code = INSIDE;
                if (px < left) code |= LEFT;
                else if (px > right) code |= RIGHT;
                if (py < top) code |= TOP;
                else if (py > bottom) code |= BOTTOM;
                return code;
            };
            
            let code1 = outCode(x1, y1);
            let code2 = outCode(x2, y2);
            
            while (true) {
                // Both endpoints inside => trivially accept
                if (!(code1 | code2)) return true;
                
                // Both endpoints on same side outside => trivially reject
                if (code1 & code2) return false;
                
                // Pick endpoint outside rectangle
                let codeOut = code1 ? code1 : code2;
                let ix = 0, iy = 0;
                
                // Find intersection point with rectangle edge
                if (codeOut & TOP) {
                    ix = x1 + (x2 - x1) * (top - y1) / (y2 - y1);
                    iy = top;
                } else if (codeOut & BOTTOM) {
                    ix = x1 + (x2 - x1) * (bottom - y1) / (y2 - y1);
                    iy = bottom;
                } else if (codeOut & RIGHT) {
                    iy = y1 + (y2 - y1) * (right - x1) / (x2 - x1);
                    ix = right;
                } else { // LEFT
                    iy = y1 + (y2 - y1) * (left - x1) / (x2 - x1);
                    ix = left;
                }
                
                // Move clipped endpoint to intersection point
                if (codeOut === code1) {
                    x1 = ix;
                    y1 = iy;
                    code1 = outCode(x1, y1);
                } else {
                    x2 = ix;
                    y2 = iy;
                    code2 = outCode(x2, y2);
                }
            }
        },

        /**
         * Check if line segment hits any obstacles
         * @param {number} x1 - Line start X
         * @param {number} y1 - Line start Y
         * @param {number} x2 - Line end X
         * @param {number} y2 - Line end Y
         * @param {array} obstacles - Array of rectangles to check
         * @param {array} orientedBoxes - Optional array of oriented boxes with {x, y, w, h, angle}
         * @returns {boolean} True if line hits any obstacle
         */
        lineHitsAny(x1, y1, x2, y2, obstacles, orientedBoxes) {
            // Check regular AABB obstacles
            for (let i = 0; i < obstacles.length; i++) {
                if (this.segmentIntersectsRect(x1, y1, x2, y2, obstacles[i])) {
                    return true;
                }
            }
            // Check oriented boxes (rotated rectangles)
            if (orientedBoxes) {
                for (let i = 0; i < orientedBoxes.length; i++) {
                    if (this.lineIntersectsOrientedBox(x1, y1, x2, y2, orientedBoxes[i])) {
                        return true;
                    }
                }
            }
            return false;
        },
        
        /**
         * Check if line segment intersects oriented box (rotated rectangle)
         * @param {number} x1 - Line start X
         * @param {number} y1 - Line start Y
         * @param {number} x2 - Line end X
         * @param {number} y2 - Line end Y
         * @param {object} box - Oriented box with {x, y, w, h, angle}
         * @returns {boolean} True if line intersects box
         */
        lineIntersectsOrientedBox(x1, y1, x2, y2, box) {
            // Transform line endpoints to box's local coordinate space
            const cos = Math.cos(-(box.angle || 0));
            const sin = Math.sin(-(box.angle || 0));
            
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
            
            // Now check segment vs AABB in local space
            // Create a temporary AABB centered at origin with box dimensions
            const halfW = box.w / 2;
            const halfH = box.h / 2;
            
            // Use Liang-Barsky algorithm for segment vs AABB
            let t0 = 0, t1 = 1;
            const dx = localX2 - localX1;
            const dy = localY2 - localY1;
            
            const clip = (p, q) => {
                if (p === 0) return q >= 0; // parallel and inside
                const r = q / p;
                if (p < 0) { 
                    if (r > t1) return false; 
                    if (r > t0) t0 = r; 
                } else { 
                    if (r < t0) return false; 
                    if (r < t1) t1 = r; 
                }
                return true;
            };
            
            if (!clip(-dx, localX1 + halfW)) return false;  // left edge
            if (!clip(dx, halfW - localX1)) return false;   // right edge
            if (!clip(-dy, localY1 + halfH)) return false;  // top edge
            if (!clip(dy, halfH - localY1)) return false;   // bottom edge
            
            return t0 <= t1;
        }
    };

    return CollisionHelpers;
}));
