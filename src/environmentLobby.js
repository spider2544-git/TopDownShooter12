class EnvironmentLobby {
        constructor(serverObstacles) {
                this.gridSize = 48;
                this.thickEvery = 4;
                this.bg = '#0e0e12';
                this.lineThin = '#151826';
                this.lineThick = '#202431';
                // 2000x2000 playable area → half-extent 1000
                this.boundary = 1000;
                this.wallThickness = 120;
                this.maxRange = 900; // not used for random obstacles here
                this.obstacles = [];
                // Rotated rectangles and hazard collision boxes (server-synced via hazardsState / roomSnapshot)
                this.orientedBoxes = [];
                this.spawnSafeX = 0;
                this.spawnSafeY = 0;
                this.spawnSafeRadius = 180;
                // Trench Crusade themed Merchant stall decorations near upper center
                
                // Use server obstacles if provided (multiplayer), otherwise generate locally (single player)
                if (serverObstacles && Array.isArray(serverObstacles)) {
                        console.log('[EnvironmentLobby] Using server-authoritative obstacles:', serverObstacles.length);
                        this.obstacles = serverObstacles.slice(); // Copy the array
                } else {
                        console.log('[EnvironmentLobby] Generating local obstacles (single player mode)');
                        this._addMerchantStall();
                }
        }

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

        // Check if circle intersects a ROTATED rectangle (for hazard sandbags / trench walls if ever used in lobby)
        _circleIntersectsOrientedBox(cx, cy, cr, box) {
                if (!box) return false;
                const dx = cx - box.x;
                const dy = cy - box.y;
                const cos = Math.cos(-(box.angle || 0));
                const sin = Math.sin(-(box.angle || 0));
                const localX = dx * cos - dy * sin;
                const localY = dx * sin + dy * cos;
                const halfW = (box.w || 0) / 2;
                const halfH = (box.h || 0) / 2;
                const closestX = this._clamp(localX, -halfW, halfW);
                const closestY = this._clamp(localY, -halfH, halfH);
                const distX = localX - closestX;
                const distY = localY - closestY;
                return (distX * distX + distY * distY) < (cr * cr);
        }

        // Check if line segment intersects a ROTATED rectangle (for bullets vs hazard sandbags)
        _lineIntersectsOrientedBox(x1, y1, x2, y2, box) {
                if (!box) return false;
                const ang = box.angle || 0;
                const cos = Math.cos(-ang);
                const sin = Math.sin(-ang);
                const dx1 = x1 - box.x;
                const dy1 = y1 - box.y;
                const localX1 = dx1 * cos - dy1 * sin;
                const localY1 = dx1 * sin + dy1 * cos;
                const dx2 = x2 - box.x;
                const dy2 = y2 - box.y;
                const localX2 = dx2 * cos - dy2 * sin;
                const localY2 = dx2 * sin + dy2 * cos;
                const halfW = (box.w || 0) / 2;
                const halfH = (box.h || 0) / 2;
                const left = -halfW;
                const right = halfW;
                const top = -halfH;
                const bottom = halfH;
                let t0 = 0, t1 = 1;
                const ddx = localX2 - localX1;
                const ddy = localY2 - localY1;
                const clip = (p, q) => {
                        if (p === 0) return q >= 0;
                        const r = q / p;
                        if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
                        else { if (r < t0) return false; if (r < t1) t1 = r; }
                        return true;
                };
                if (!clip(-ddx, localX1 - left)) return false;
                if (!clip(ddx, right - localX1)) return false;
                if (!clip(-ddy, localY1 - top)) return false;
                if (!clip(ddy, bottom - localY1)) return false;
                return t0 <= t1;
        }

        _addMerchantStall() {
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
                } catch(_) {}
        }

        // Returns true if circle hits any obstacle
        circleHitsAny(cx, cy, cr) {
                for (let i = 0; i < this.obstacles.length; i++) {
                        if (this._circleIntersectsRect(cx, cy, cr, this.obstacles[i])) return true;
                }
                // Also collide with oriented boxes (server-synced hazards like breakable sandbags)
                if (this.orientedBoxes && Array.isArray(this.orientedBoxes)) {
                        for (let i = 0; i < this.orientedBoxes.length; i++) {
                                if (this._circleIntersectsOrientedBox(cx, cy, cr, this.orientedBoxes[i])) return true;
                        }
                }
                return false;
        }

        // Returns true if the segment from (x1,y1) to (x2,y2) intersects any obstacle AABB
        lineHitsAny(x1, y1, x2, y2) {
                const segIntersectsAabb = (x1, y1, x2, y2, ob) => {
                        const left = ob.x - ob.w / 2;
                        const top = ob.y - ob.h / 2;
                        const right = left + ob.w;
                        const bottom = top + ob.h;
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
                for (let i = 0; i < this.obstacles.length; i++) {
                        if (segIntersectsAabb(x1, y1, x2, y2, this.obstacles[i])) return true;
                }
                // Also collide with oriented boxes (hazard sandbags)
                if (this.orientedBoxes && Array.isArray(this.orientedBoxes)) {
                        for (let i = 0; i < this.orientedBoxes.length; i++) {
                                if (this._lineIntersectsOrientedBox(x1, y1, x2, y2, this.orientedBoxes[i])) return true;
                        }
                }
                return false;
        }

        resolveCircleMove(x, y, radius, dx, dy) {
                let newX = x;
                let newY = y;
                if (dx !== 0) {
                        newX += dx;
                        for (let i = 0; i < this.obstacles.length; i++) {
                                const ob = this.obstacles[i];
                                if (!this._circleIntersectsRect(newX, newY, radius, ob)) continue;
                                const left = ob.x - ob.w / 2;
                                const right = left + ob.w;
                                if (dx > 0) newX = left - radius; else newX = right + radius;
                        }
                        // Resolve against oriented boxes (hazard sandbags) by pushing out along x
                        if (this.orientedBoxes && Array.isArray(this.orientedBoxes)) {
                                for (let i = 0; i < this.orientedBoxes.length; i++) {
                                        const box = this.orientedBoxes[i];
                                        if (!this._circleIntersectsOrientedBox(newX, newY, radius, box)) continue;
                                        // For axis-aligned hazard boxes (angle 0), approximate as AABB resolution
                                        const ang = box.angle || 0;
                                        if (!ang) {
                                                const left = box.x - (box.w || 0) / 2;
                                                const right = box.x + (box.w || 0) / 2;
                                                if (dx > 0) newX = left - radius; else newX = right + radius;
                                        }
                                }
                        }
                }
                if (dy !== 0) {
                        newY += dy;
                        for (let i = 0; i < this.obstacles.length; i++) {
                                const ob = this.obstacles[i];
                                if (!this._circleIntersectsRect(newX, newY, radius, ob)) continue;
                                const top = ob.y - ob.h / 2;
                                const bottom = top + ob.h;
                                if (dy > 0) newY = top - radius; else newY = bottom + radius;
                        }
                        // Resolve against oriented boxes (hazard sandbags) by pushing out along y
                        if (this.orientedBoxes && Array.isArray(this.orientedBoxes)) {
                                for (let i = 0; i < this.orientedBoxes.length; i++) {
                                        const box = this.orientedBoxes[i];
                                        if (!this._circleIntersectsOrientedBox(newX, newY, radius, box)) continue;
                                        const ang = box.angle || 0;
                                        if (!ang) {
                                                const top = box.y - (box.h || 0) / 2;
                                                const bottom = box.y + (box.h || 0) / 2;
                                                if (dy > 0) newY = top - radius; else newY = bottom + radius;
                                        }
                                }
                        }
                }
                const b = this.boundary;
                if (newX > b - radius) newX = b - radius;
                if (newX < -b + radius) newX = -b + radius;
                if (newY > b - radius) newY = b - radius;
                if (newY < -b + radius) newY = -b + radius;
                return { x: newX, y: newY };
        }

        isInsideBounds(x, y, radius = 0) {
                const b = this.boundary - radius;
                return x >= -b && x <= b && y >= -b && y <= b;
        }

        draw(ctx, camera, viewport) {
                const w = viewport.width;
                const h = viewport.height;
                const gridSize = this.gridSize;
                const thickEvery = this.thickEvery;

                // Background is already filled in screen space by ClientRender before transforms
                // No need to fill again here

                const mod = (a, n) => ((a % n) + n) % n;
                
                // Vertical lines - extend to cover negative space and beyond viewport for zoom
                let startX = -mod(camera.x, gridSize);
                let baseIndexX = Math.floor(camera.x / gridSize);
                for (let i = -2, x = startX - gridSize * 2; x <= w + gridSize * 2; i++, x += gridSize) {
                        const worldIndex = baseIndexX + i;
                        const isThick = worldIndex % thickEvery === 0;
                        const lineX = Math.round(x) + 0.5;
                        ctx.beginPath();
                        ctx.moveTo(lineX, -h);
                        ctx.lineTo(lineX, h * 2);
                        ctx.strokeStyle = isThick ? this.lineThick : this.lineThin;
                        ctx.lineWidth = isThick ? 2 : 1;
                        ctx.stroke();
                }
                
                // Horizontal lines - extend to cover negative space and beyond viewport for zoom
                let startY = -mod(camera.y, gridSize);
                let baseIndexY = Math.floor(camera.y / gridSize);
                for (let i = -2, y = startY - gridSize * 2; y <= h + gridSize * 2; i++, y += gridSize) {
                        const worldIndex = baseIndexY + i;
                        const isThick = worldIndex % thickEvery === 0;
                        const lineY = Math.round(y) + 0.5;
                        ctx.beginPath();
                        ctx.moveTo(-w, lineY);
                        ctx.lineTo(w * 2, lineY);
                        ctx.strokeStyle = isThick ? this.lineThick : this.lineThin;
                        ctx.lineWidth = isThick ? 2 : 1;
                        ctx.stroke();
                }

                try { if (typeof window.drawGroundDecals === 'function') window.drawGroundDecals(ctx, camera, { width: w, height: h }); } catch(e) {}

                // Use centralized cullBounds if provided, otherwise calculate (fallback for compatibility)
                const bounds = viewport.cullBounds || {
                        left: camera.x - w / 2 - 200,
                        right: camera.x + w / 2 + 200,
                        top: camera.y - h / 2 - 200,
                        bottom: camera.y + h / 2 + 200
                };
                const viewLeft = bounds.left;
                const viewTop = bounds.top;
                const viewRight = bounds.right;
                const viewBottom = bounds.bottom;

                // Helper to draw a capsule (rounded bag shape), used for sandbag obstacles
                const capsule = (cx, cy, cw, ch, fill, stroke) => {
                        const r = Math.min(ch/2, cw/4);
                        ctx.fillStyle = fill; ctx.strokeStyle = stroke; ctx.lineWidth = 2;
                        ctx.beginPath();
                        ctx.moveTo(cx - cw/2 + r, cy - ch/2);
                        ctx.lineTo(cx + cw/2 - r, cy - ch/2);
                        ctx.quadraticCurveTo(cx + cw/2, cy - ch/2, cx + cw/2, cy);
                        ctx.quadraticCurveTo(cx + cw/2, cy + ch/2, cx + cw/2 - r, cy + ch/2);
                        ctx.lineTo(cx - cw/2 + r, cy + ch/2);
                        ctx.quadraticCurveTo(cx - cw/2, cy + ch/2, cx - cw/2, cy);
                        ctx.quadraticCurveTo(cx - cw/2, cy - ch/2, cx - cw/2 + r, cy - ch/2);
                        ctx.closePath(); ctx.fill(); ctx.stroke();
                };
                for (let i = 0; i < this.obstacles.length; i++) {
                        const ob = this.obstacles[i];
                        const left = ob.x - ob.w / 2;
                        const top = ob.y - ob.h / 2;
                        const right = left + ob.w;
                        const bottom = top + ob.h;
                        if (right < viewLeft || left > viewRight || bottom < viewTop || top > viewBottom) continue;
                        const x = ob.x - camera.x;
                        const y = ob.y - camera.y;

                        // Sandbag obstacle rendering (prettier than a raw rectangle)
                        if (ob.kind === 'sandbag') {
                                // Use a consistent sandbag palette if not provided
                                const edge = ob.stroke || '#3a3328';
                                const baseFill = ob.fill || '#b9a46c';
                                // Slight value variation per obstacle for readability
                                const base = (t) => `hsl(38deg, 25%, ${56 - 10*(1-t)}%)`;
                                const hp = 1.0; // lobby sandbags are static; render as "full"

                                const variant = ob.variant || ((ob.h > ob.w) ? 'vertical' : 'horizontal');
                                if (variant === 'vertical') {
                                        ctx.save();
                                        ctx.translate(x, y);
                                        ctx.rotate(Math.PI / 2);
                                        const w = ob.h, h = ob.w; // swap for rotated draw
                                        const rowH = h * 0.42, pad = 4, cw = (w - pad*2) / 3;
                                        // 3-layer stack (like level sandbags)
                                        capsule(-cw - pad, h*0.22, cw, rowH, base(hp), edge);
                                        capsule(0, h*0.22, cw, rowH, base(hp*0.97), edge);
                                        capsule(cw + pad, h*0.22, cw, rowH, base(hp*0.94), edge);
                                        const cw2 = (w - pad) * 0.80 / 2;
                                        capsule(-cw2/2 - pad/2, 0, cw2, rowH*1.12, base(hp*0.95), edge);
                                        capsule(cw2/2 + pad/2, 0, cw2, rowH*1.12, base(hp*0.92), edge);
                                        capsule(0, -h*0.30, w * 0.50, rowH*0.90, base(hp*0.88), edge);
                                        ctx.restore();
                                } else {
                                        const w = ob.w, h = ob.h;
                                        const rowH = h * 0.42, pad = 4, cw = (w - pad*2) / 3;
                                        capsule(x - cw - pad, y + h*0.22, cw, rowH, base(hp), edge);
                                        capsule(x, y + h*0.22, cw, rowH, base(hp*0.97), edge);
                                        capsule(x + cw + pad, y + h*0.22, cw, rowH, base(hp*0.94), edge);
                                        const cw2 = (w - pad) * 0.80 / 2;
                                        capsule(x - cw2/2 - pad/2, y - 0, cw2, rowH*1.12, base(hp*0.95), edge);
                                        capsule(x + cw2/2 + pad/2, y - 0, cw2, rowH*1.12, base(hp*0.92), edge);
                                        capsule(x, y - h*0.30, w * 0.50, rowH*0.90, base(hp*0.88), edge);
                                }
                                continue;
                        }

                        // Default obstacle rendering (AABB)
                        const sx = left - camera.x;
                        const sy = top - camera.y;
                        ctx.beginPath();
                        ctx.rect(Math.round(sx) + 0.5, Math.round(sy) + 0.5, Math.round(ob.w), Math.round(ob.h));
                        ctx.fillStyle = ob.fill || '#5b5b5b';
                        ctx.fill();
                        ctx.lineWidth = 2;
                        ctx.strokeStyle = ob.stroke || '#111111';
                        ctx.stroke();
                }

                // Enclosing walls
                const b = this.boundary;
                const t = this.wallThickness;
                ctx.fillStyle = '#1b1f2e';
                let sx = -b - t - camera.x;
                let sy = -b - t - camera.y;
                ctx.fillRect(sx, sy, (b + t) * 2 + t, t);
                sy = b - camera.y;
                ctx.fillRect(-b - t - camera.x, sy, (b + t) * 2 + t, t);
                sx = -b - t - camera.x;
                sy = -b - camera.y;
                ctx.fillRect(sx, sy, t, (b + t) * 2);
                sx = b - camera.x;
                ctx.fillRect(sx, -b - camera.y, t, (b + t) * 2);
        }
}
window.EnvironmentLobby = EnvironmentLobby;


