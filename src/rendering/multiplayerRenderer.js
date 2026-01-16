// Multiplayer player rendering with interpolation
class MultiplayerRenderer {
    renderOtherPlayers(ctx, state, networkManager) {
        if (!networkManager) return;

        // Simple dynamic perf throttling for heavy remote-player VFX.
        // When the frame time spikes, skip/cheapify the most expensive effects first (trails, drips, gradients).
        try {
            const dtNow = Number.isFinite(state?._lastDt) ? state._lastDt : 0.016;
            this._perfLow = dtNow > 0.022;      // ~45fps threshold
            this._perfVeryLow = dtNow > 0.03;   // ~33fps threshold
        } catch(_) {
            this._perfLow = false;
            this._perfVeryLow = false;
        }
        
        let otherPlayers = [];
        // Get interpolated other players per frame (not cached)
        try {
            otherPlayers = networkManager.getOtherPlayers();
            if (otherPlayers.length === 0) return;
        } catch (error) {
            console.warn('[Main] Error getting other players:', error);
            return;
        }
        
        for (const otherPlayer of otherPlayers) {
            // Calculate screen position
            const screenX = otherPlayer.x - state.cameraX;
            const screenY = otherPlayer.y - state.cameraY;
            
            // Only render if on screen (use effective viewport for zoom support)
            const effectiveWidth = state.viewportWidth / (state.zoomLevel || 1.0);
            const effectiveHeight = state.viewportHeight / (state.zoomLevel || 1.0);
            if (screenX < -50 || screenX > effectiveWidth + 50 || 
                screenY < -50 || screenY > effectiveHeight + 50) {
                continue;
            }
            
            // Expensive effects first: disable under perf pressure
            this._renderPlayerTrail(ctx, otherPlayer, state);
            this._renderAimIndicator(ctx, otherPlayer, screenX, screenY);
            this._renderPlayerBody(ctx, otherPlayer, screenX, screenY);
            this._renderRevivePromptAndProgress(ctx, otherPlayer, screenX, screenY, state);
            this._renderEvilGlow(ctx, otherPlayer, screenX, screenY);
            this._renderEnsnareRing(ctx, otherPlayer, screenX, screenY);
            this._renderHitFlash(ctx, otherPlayer, screenX, screenY, networkManager);
            this._renderBurningVFX(ctx, otherPlayer, screenX, screenY, networkManager);
            this._renderSlimeVFX(ctx, otherPlayer, screenX, screenY, state, networkManager);
            this._renderMudVFX(ctx, otherPlayer, screenX, screenY, state, networkManager);
            // Charge VFX can be heavy; drop it only under very low perf.
            if (!this._perfVeryLow) {
                this._renderChargeVFX(ctx, otherPlayer, screenX, screenY, state, networkManager);
            }
            this._renderHealthBar(ctx, otherPlayer, screenX, screenY);
            this._renderPlayerId(ctx, otherPlayer, screenX, screenY);
            this._renderArtifact(ctx, otherPlayer, screenX, screenY, networkManager);
            this._renderBattery(ctx, otherPlayer, screenX, screenY);
            this._renderSkin(ctx, otherPlayer, screenX, screenY);
            this._renderHat(ctx, otherPlayer, screenX, screenY);
        }
    }

    _renderRevivePromptAndProgress(ctx, otherPlayer, screenX, screenY, state) {
        try {
            const isDowned = (typeof otherPlayer.health === 'number' && otherPlayer.health <= 0);
            if (!isDowned) return;

            const radius = otherPlayer.radius || 20;
            const topY = screenY - radius - 34;

            // Progress bar (visible to all)
            const p = Math.max(0, Math.min(1, Number(otherPlayer.reviveProgress) || 0));
            if (p > 0) {
                const w = 70, h = 8;
                const x = Math.round(screenX - w / 2);
                const y = Math.round(topY);

                ctx.save();
                ctx.fillStyle = 'rgba(0,0,0,0.65)';
                ctx.fillRect(x, y, w, h);
                ctx.fillStyle = '#76ffb0';
                ctx.fillRect(x, y, Math.round(w * p), h);
                ctx.strokeStyle = 'rgba(255,255,255,0.35)';
                ctx.lineWidth = 2;
                ctx.strokeRect(x + 0.5, y + 0.5, w, h);

                ctx.font = 'bold 12px sans-serif';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'bottom';
                ctx.fillStyle = 'rgba(0,0,0,0.6)';
                ctx.fillText('REVIVING...', Math.round(screenX) + 1, y - 4 + 1);
                ctx.fillStyle = '#ffffff';
                ctx.fillText('REVIVING...', Math.round(screenX), y - 4);
                ctx.restore();
                return; // Don't show prompt while a revive is already in progress
            }

            // Prompt for local player (Hold E to Revive) if in range and within 30s window
            const me = (typeof window !== 'undefined') ? window.player : null;
            if (!me || !(me.health > 0)) return;

            const downedAt = Number(otherPlayer.downedAt) || 0;
            if (!downedAt) return;
            if ((Date.now() - downedAt) > 30000) return;
            // If revive is already ready to accept, don't show the prompt anymore
            if ((Number(otherPlayer.reviveReadyUntil) || 0) > Date.now()) return;

            const dx = (otherPlayer.x || 0) - (me.x || 0);
            const dy = (otherPlayer.y || 0) - (me.y || 0);
            const REVIVE_R = 80;
            if ((dx * dx + dy * dy) > (REVIVE_R * REVIVE_R)) return;

            const label = 'Hold E to Revive';
            ctx.save();
            ctx.font = 'bold 14px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'bottom';
            ctx.fillStyle = 'rgba(0,0,0,0.6)';
            ctx.fillText(label, Math.round(screenX) + 1, Math.round(topY) - 12 + 1);
            ctx.fillStyle = '#ffffff';
            ctx.fillText(label, Math.round(screenX), Math.round(topY) - 12);
            ctx.restore();
        } catch(_) {}
    }
    
    _renderPlayerTrail(ctx, otherPlayer, state) {
        // PERF: trails are surprisingly expensive (gradients + many save/restore). Skip when frame time is high.
        if (this._perfLow) return;
        // Speed trail (draw behind player body)
        if (otherPlayer._trailPoints && otherPlayer._trailPoints.length > 0) {
            for (let i = otherPlayer._trailPoints.length - 1; i >= 0; i--) {
                const p = otherPlayer._trailPoints[i];
                const k = Math.max(0, Math.min(1, p.life / (p.max || 0.001)));
                const bx = p.x - otherPlayer.x;
                const by = p.y - otherPlayer.y;
                const bdist = Math.hypot(bx, by) || 0.0001;
                const bux = bx / bdist;
                const buy = by / bdist;
                const baseSpeed = 220;
                const speedFactor = Math.max(0.75, Math.min(3, (otherPlayer._instantSpeed || 0) / baseSpeed));
                const maxLen = Math.min(70, 26 * speedFactor);
                const len = Math.min(maxLen, bdist) * k;
                const inset = Math.max(0, (otherPlayer.radius || 20) * 0.55);
                const sx = (otherPlayer.x + bux * inset) - state.cameraX;
                const sy = (otherPlayer.y + buy * inset) - state.cameraY;
                const ex = sx + bux * len;
                const ey = sy + buy * len;
                ctx.save();
                const nearA = 0.2 * k;
                const farA = 0.0;
                const grad = ctx.createLinearGradient(sx, sy, ex, ey);
                grad.addColorStop(0, `rgba(25, 118, 210, ${nearA})`);
                grad.addColorStop(1, `rgba(25, 118, 210, ${farA})`);
                ctx.fillStyle = grad;
                const baseWidth = Math.max(2, (otherPlayer.radius || 20) * 1.2);
                const widthNear = baseWidth * k;
                const widthFar = baseWidth * k * 0.08;
                const px = -buy;
                const py = bux;
                const nxLx = sx + px * (widthNear * 0.5);
                const nxLy = sy + py * (widthNear * 0.5);
                const nxRx = sx - px * (widthNear * 0.5);
                const nxRy = sy - py * (widthNear * 0.5);
                const fxLx = ex + px * (widthFar * 0.5);
                const fxLy = ey + py * (widthFar * 0.5);
                const fxRx = ex - px * (widthFar * 0.5);
                const fxRy = ey - py * (widthFar * 0.5);
                ctx.beginPath();
                ctx.moveTo(nxLx, nxLy);
                ctx.lineTo(fxLx, fxLy);
                ctx.lineTo(fxRx, fxRy);
                ctx.lineTo(nxRx, nxRy);
                ctx.closePath();
                ctx.fill();
                ctx.restore();
            }
        }
    }
    
    _renderAimIndicator(ctx, otherPlayer, screenX, screenY) {
        // Aim direction indicator (draw UNDER player); hide while dead
        if (typeof otherPlayer.aimAngle === 'number' && (otherPlayer.health == null || otherPlayer.health > 0)) {
            // Check if viewing player is evil (converted PvP)
            const viewerIsEvil = (typeof window !== 'undefined' && window.__killThemAllLocked === true);
            
            // Check if target player is evil
            const targetIsEvil = (otherPlayer.evilLocked === true || otherPlayer.isEvil === true);
            
            // Hide pointer when invisible AND different alignment (enemy)
            const shouldHidePointer = otherPlayer.invisible && (viewerIsEvil !== targetIsEvil);
            
            if (!shouldHidePointer) {
                const aimLength = 50;
                const aimEndX = screenX + Math.cos(otherPlayer.aimAngle) * aimLength;
                const aimEndY = screenY + Math.sin(otherPlayer.aimAngle) * aimLength;
                
                // Use the same alpha as the body for smooth fading
                const alpha = otherPlayer._renderAlpha || 1.0;
                
                ctx.save();
                ctx.globalAlpha = alpha;
                ctx.strokeStyle = '#FFF';
                ctx.lineWidth = 3;
                ctx.lineCap = 'round';
                ctx.beginPath();
                ctx.moveTo(screenX, screenY);
                ctx.lineTo(aimEndX, aimEndY);
                ctx.stroke();
                ctx.restore();
            }
        }
    }
    
    _renderEvilGlow(ctx, otherPlayer, screenX, screenY) {
        // Red aura that scales with slider progress; adds bright white core only when locked
        // This matches EXACTLY the local player rendering in player.js
        // Hide glow when invisible
        try {
            const locked = (otherPlayer.evilLocked === true);
            const progress = Math.max(0, Math.min(1, (typeof otherPlayer.evilProgress === 'number') ? otherPlayer.evilProgress : 0));
            // Use full progress when locked; otherwise, suppress glow below 10% and remap 10%..100% -> 0..1
            const rawP = locked ? 1 : progress;
            let p = 0;
            if (rawP >= 0.1) p = Math.max(0, Math.min(1, (rawP - 0.1) / 0.9));
            // Global intensity scale (40% of previous)
            const alphaScale = 0.4;
            // Hide evil glow when invisible
            if (p > 0.001 && !otherPlayer.invisible) {
                ctx.save();
                ctx.globalCompositeOperation = 'lighter';
                const radius = otherPlayer.radius || 20;
                // Scale radii with progress (unchanged shape), alphas scaled to ~40% of prior maximum
                const outerR = radius + (6 + 16 * p);
                const midR = radius + (4 + 10 * p);
                const innerR = radius + (2 + 4 * p);
                // Previous maxima ~0.70, 0.45, 0.30; make them proportional to p and scale to 40%
                const outerA = 0.70 * p * alphaScale;
                const midA = 0.45 * p * alphaScale;
                const innerA = 0.30 * p * alphaScale;
                // Outer halo
                ctx.globalAlpha = outerA;
                ctx.fillStyle = '#ff3a3a';
                ctx.beginPath();
                ctx.arc(screenX, screenY, outerR, 0, Math.PI * 2);
                ctx.fill();
                // Middle halo
                ctx.globalAlpha = midA;
                ctx.fillStyle = '#ff2020';
                ctx.beginPath();
                ctx.arc(screenX, screenY, midR, 0, Math.PI * 2);
                ctx.fill();
                // Inner hot red core (always present but much stronger when p=1)
                ctx.globalAlpha = innerA;
                ctx.fillStyle = '#ff0000';
                ctx.beginPath();
                ctx.arc(screenX, screenY, innerR, 0, Math.PI * 2);
                ctx.fill();
                // Bright white core only at full lock (also reduced to ~40%)
                if (locked) {
                    ctx.globalAlpha = 0.35 * alphaScale;
                    ctx.fillStyle = '#ffffff';
                    ctx.beginPath();
                    ctx.arc(screenX, screenY, radius * 0.7, 0, Math.PI * 2);
                    ctx.fill();
                }
                ctx.restore();
            }
        } catch(_) {}
    }
    
    _renderPlayerBody(ctx, otherPlayer, screenX, screenY) {
        ctx.save();
        const isGhostOther = (typeof otherPlayer.health === 'number' && otherPlayer.health <= 0);
        
        // Check if viewing player is evil (converted PvP)
        const viewerIsEvil = (typeof window !== 'undefined' && window.__killThemAllLocked === true);
        
        // Determine alpha based on invisibility and evil status
        let targetAlpha = 1.0;
        if (isGhostOther) {
            targetAlpha = 0.5;
        } else if (otherPlayer.invisible) {
            // Check if target player is evil
            const targetIsEvil = (otherPlayer.evilLocked === true || otherPlayer.isEvil === true);
            
            // Same alignment = 50% opacity (allies visible)
            // Different alignment = 0% opacity (enemies completely hidden)
            if (viewerIsEvil === targetIsEvil) {
                targetAlpha = 0.5; // Same team
            } else {
                targetAlpha = 0; // Different teams (enemy)
            }
        }
        
        // Smooth fade transition for invisibility (0.5 second transition)
        if (!Number.isFinite(otherPlayer._renderAlpha)) {
            otherPlayer._renderAlpha = targetAlpha;
        }
        
        // Lerp toward target alpha over time
        const fadeSpeed = 2.0; // Full fade in 0.5 seconds (1 / 0.5 = 2)
        const deltaTime = 1/60; // Approximate frame time
        otherPlayer._renderAlpha += (targetAlpha - otherPlayer._renderAlpha) * fadeSpeed * deltaTime;
        
        ctx.globalAlpha = otherPlayer._renderAlpha;
        ctx.fillStyle = '#1976D2';
        ctx.beginPath();
        ctx.arc(screenX, screenY, otherPlayer.radius || 20, 0, Math.PI * 2);
        ctx.fill();
        // Outline also fades with the same alpha
        ctx.strokeStyle = '#0D47A1';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.restore();
    }
    
    _renderEnsnareRing(ctx, otherPlayer, screenX, screenY) {
        try {
            if (otherPlayer._ensnaredTimer && otherPlayer._ensnaredTimer > 0) {
                const t = otherPlayer._ensnarePulseT || 0;
                const pulse = 0.5 + 0.5 * (Math.sin(t * Math.PI * 2 * 1.2) * 0.5 + 0.5);
                const ringR = (otherPlayer.radius || 20) + 10 + 3 * pulse;
                ctx.save();
                ctx.globalAlpha = 0.9;
                ctx.strokeStyle = '#cc66cc';
                ctx.lineWidth = 3 + 2 * pulse;
                ctx.beginPath();
                ctx.arc(screenX, screenY, ringR, 0, Math.PI * 2);
                ctx.stroke();
                ctx.restore();
            }
        } catch(_) {}
    }
    
    _renderHitFlash(ctx, otherPlayer, screenX, screenY, networkManager) {
        try {
            const mgr = networkManager;
            if (mgr && mgr.remoteHitFlashPlayers && mgr.remoteHitFlashPlayers.has(otherPlayer.id)) {
                const flashData = mgr.remoteHitFlashPlayers.get(otherPlayer.id);
                if (flashData && flashData.hitFlash > 0) {
                    const hitFlashMax = 0.12;
                    const t = Math.max(0, Math.min(1, flashData.hitFlash / hitFlashMax));
                    ctx.save();
                    ctx.globalAlpha = Math.pow(t, 0.4) * 0.9;
                    ctx.fillStyle = '#ff3b3b';
                    ctx.beginPath();
                    ctx.arc(screenX, screenY, otherPlayer.radius || 20, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.restore();
                }
            }
        } catch(_) {}
    }
    
    _renderBurningVFX(ctx, otherPlayer, screenX, screenY, networkManager) {
        try {
            if (networkManager && networkManager.remoteBurningPlayers && 
                networkManager.remoteBurningPlayers.has(otherPlayer.id) && 
                (otherPlayer.health == null || otherPlayer.health > 0)) {
                // PERF: replace gradient+sparks with a cheap glow on slow frames
                if (this._perfLow) {
                    const r = (otherPlayer.radius || 20);
                    ctx.save();
                    ctx.globalAlpha = 0.25;
                    ctx.fillStyle = '#ff7a18';
                    ctx.beginPath();
                    ctx.arc(screenX, screenY - r * 0.15, r * 1.25, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.restore();
                    return;
                }

                const burnData = networkManager.remoteBurningPlayers.get(otherPlayer.id);
                const burnDuration = Date.now() - burnData.startTime;
                const intensity = Math.min(1.2, 1.0);
                const baseR = (otherPlayer.radius || 20) * (0.9 + 0.6 * intensity);
                const t = burnDuration / 1000;
                const wobble = Math.sin(t * 6) * 0.12;
                const sx0 = screenX + wobble * (otherPlayer.radius || 20) * 0.25;
                const sy0 = screenY - (otherPlayer.radius || 20) * (0.25 + 0.06 * Math.sin(t * 4 + (otherPlayer.id?.charCodeAt?.(0) || 1)));
                const grad = ctx.createRadialGradient(sx0, sy0, baseR * 0.1, sx0, sy0, baseR);
                grad.addColorStop(0, 'rgba(255, 250, 210, ' + (0.9 * intensity) + ')');
                grad.addColorStop(0.35, 'rgba(255, 200, 80, ' + (0.6 * intensity) + ')');
                grad.addColorStop(1, 'rgba(255, 120, 0, 0)');
                ctx.save();
                ctx.fillStyle = grad;
                ctx.beginPath();
                ctx.ellipse(sx0, sy0, baseR * (0.65 + 0.05 * Math.sin(t * 8)), baseR * (1.25 + 0.1 * Math.sin(t * 5 + 1.1)), wobble * 0.5, 0, Math.PI * 2);
                ctx.fill();
                const sparkN = 2 + Math.floor(intensity * 3);
                for (let i = 0; i < sparkN; i++) {
                    const a = (-Math.PI / 2) + (Math.random() - 0.5) * 0.6;
                    const r = (otherPlayer.radius || 20) * (0.3 + Math.random() * 0.6);
                    const px = sx0 + Math.cos(a) * r;
                    const py = sy0 + Math.sin(a) * r - (4 + Math.random() * 9);
                    ctx.globalAlpha = 0.5 * intensity;
                    ctx.fillStyle = '#ffd36b';
                    ctx.beginPath();
                    ctx.arc(px, py, 1.3, 0, Math.PI * 2);
                    ctx.fill();
                }
                ctx.restore();
            }
        } catch(_) {}
    }
    
    _renderSlimeVFX(ctx, otherPlayer, screenX, screenY, state, networkManager) {
        try {
            const mgr = networkManager;
            if (mgr && mgr.remoteSlowedPlayers && mgr.remoteSlowedPlayers.has(otherPlayer.id) && 
                (otherPlayer.health == null || otherPlayer.health > 0)) {
                const t = (Date.now() % 200000) / 1000;
                const pulse = Math.sin(t * Math.PI * 2 * 0.8) * 0.5 + 0.5;
                const a = 0.3 + 0.3 * pulse;
                ctx.save();
                ctx.globalAlpha = a;
                ctx.fillStyle = '#a8c400';
                ctx.beginPath();
                ctx.arc(screenX, screenY, (otherPlayer.radius || 20) + 2, 0, Math.PI * 2);
                ctx.fill();
                ctx.restore();

                // PERF: drips are very expensive (spawn/integrate + many arcs). Keep aura only on slow frames.
                if (this._perfLow) return;

                const entry = mgr.remoteSlowedPlayers.get(otherPlayer.id) || {};
                if (!entry.drips) entry.drips = [];
                if (typeof entry.spawnTimer !== 'number') entry.spawnTimer = 0;
                const dt = (typeof window !== 'undefined' && window.state && Number.isFinite(window.state._lastDt)) ? window.state._lastDt : 0.016;
                entry.spawnTimer -= dt;
                const spawnEvery = 0.08;
                while (entry.spawnTimer <= 0) {
                    entry.spawnTimer += spawnEvery;
                    const count = 1 + Math.floor(Math.random() * 2);
                    for (let i = 0; i < count; i++) {
                        const ang = (Math.random() * Math.PI) + Math.PI * 0.5;
                        const offR = (otherPlayer.radius || 20) * (0.2 + Math.random() * 0.6);
                        const spawnX = otherPlayer.x + Math.cos(ang) * offR * 0.4;
                        const spawnY = otherPlayer.y + (otherPlayer.radius || 20) * 0.6 + Math.sin(ang) * 2;
                        const vy = 60 + Math.random() * 80;
                        const vx = (Math.random() * 2 - 1) * 25;
                        const life = 0.5 + Math.random() * 0.6;
                        const rad = 1.5 + Math.random() * 2.5;
                        entry.drips.push({ x: spawnX, y: spawnY, vx, vy, life, total: life, r: rad });
                    }
                }
                for (let i = entry.drips.length - 1; i >= 0; i--) {
                    const d = entry.drips[i];
                    d.vy += 220 * dt;
                    d.x += d.vx * dt;
                    d.y += d.vy * dt;
                    d.life -= dt;
                    if (d.life <= 0) entry.drips.splice(i, 1);
                }
                if (entry.drips.length > 120) entry.drips.splice(0, entry.drips.length - 120);
                for (let i = 0; i < entry.drips.length; i++) {
                    const d = entry.drips[i];
                    const k = Math.max(0, Math.min(1, d.life / (d.total || 0.001)));
                    const sx0 = d.x - state.cameraX;
                    const sy0 = d.y - state.cameraY;
                    ctx.save();
                    ctx.globalAlpha = 0.18 * k;
                    ctx.fillStyle = '#a8c400';
                    ctx.beginPath();
                    ctx.arc(sx0, sy0, d.r * 2.2, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.globalAlpha = 0.9 * k;
                    ctx.beginPath();
                    ctx.arc(sx0, sy0, d.r, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.globalAlpha = 0.5 * k;
                    ctx.strokeStyle = '#4a5c11';
                    ctx.lineWidth = 1;
                    ctx.beginPath();
                    ctx.arc(sx0, sy0, d.r, 0, Math.PI * 2);
                    ctx.stroke();
                    ctx.restore();
                }
                mgr.remoteSlowedPlayers.set(otherPlayer.id, entry);
            }
        } catch(_) {}
    }
    
    _renderMudVFX(ctx, otherPlayer, screenX, screenY, state, networkManager) {
        try {
            const mgr = networkManager;
            if (mgr && mgr.remoteMudSlowedPlayers && mgr.remoteMudSlowedPlayers.has(otherPlayer.id) && 
                (otherPlayer.health == null || otherPlayer.health > 0)) {
                const t = (Date.now() % 200000) / 1000;
                const pulse = Math.sin(t * Math.PI * 2 * 0.7) * 0.5 + 0.5;
                const a = 0.45 + 0.35 * pulse; // More intense (45%..80%)
                ctx.save();
                ctx.globalAlpha = a;
                ctx.fillStyle = '#4a3a28'; // Darker brown
                ctx.beginPath();
                ctx.arc(screenX, screenY, (otherPlayer.radius || 20) + 2, 0, Math.PI * 2);
                ctx.fill();
                ctx.restore();

                // PERF: skip mud drips on slow frames (keep aura only).
                if (this._perfLow) return;

                const entry = mgr.remoteMudSlowedPlayers.get(otherPlayer.id) || {};
                if (!entry.drips) entry.drips = [];
                if (typeof entry.spawnTimer !== 'number') entry.spawnTimer = 0;
                const dt = (typeof window !== 'undefined' && window.state && Number.isFinite(window.state._lastDt)) ? window.state._lastDt : 0.016;
                entry.spawnTimer -= dt;
                const spawnEvery = 0.09;
                while (entry.spawnTimer <= 0) {
                    entry.spawnTimer += spawnEvery;
                    const count = 1 + Math.floor(Math.random() * 2);
                    for (let i = 0; i < count; i++) {
                        const ang = (Math.random() * Math.PI) + Math.PI * 0.5;
                        const offR = (otherPlayer.radius || 20) * (0.2 + Math.random() * 0.6);
                        const spawnX = otherPlayer.x + Math.cos(ang) * offR * 0.4;
                        const spawnY = otherPlayer.y + (otherPlayer.radius || 20) * 0.6 + Math.sin(ang) * 2;
                        const vy = 70 + Math.random() * 70;
                        const vx = (Math.random() * 2 - 1) * 20;
                        const life = 0.6 + Math.random() * 0.5;
                        const rad = 1.8 + Math.random() * 2.8;
                        entry.drips.push({ x: spawnX, y: spawnY, vx, vy, life, total: life, r: rad });
                    }
                }
                for (let i = entry.drips.length - 1; i >= 0; i--) {
                    const d = entry.drips[i];
                    d.vy += 240 * dt;
                    d.x += d.vx * dt;
                    d.y += d.vy * dt;
                    d.life -= dt;
                    if (d.life <= 0) entry.drips.splice(i, 1);
                }
                if (entry.drips.length > 120) entry.drips.splice(0, entry.drips.length - 120);
                for (let i = 0; i < entry.drips.length; i++) {
                    const d = entry.drips[i];
                    const k = Math.max(0, Math.min(1, d.life / (d.total || 0.001)));
                    const sx0 = d.x - state.cameraX;
                    const sy0 = d.y - state.cameraY;
                    ctx.save();
                    ctx.globalAlpha = 0.25 * k;
                    ctx.fillStyle = '#4a3a28'; // Darker brown
                    ctx.beginPath();
                    ctx.arc(sx0, sy0, d.r * 2.2, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.globalAlpha = 0.9 * k;
                    ctx.fillStyle = '#5c4a34'; // Darker brown
                    ctx.beginPath();
                    ctx.arc(sx0, sy0, d.r, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.globalAlpha = 0.7 * k;
                    ctx.strokeStyle = '#2b1f14'; // Darker brown
                    ctx.lineWidth = 1;
                    ctx.beginPath();
                    ctx.arc(sx0, sy0, d.r, 0, Math.PI * 2);
                    ctx.stroke();
                    ctx.restore();
                }
                mgr.remoteMudSlowedPlayers.set(otherPlayer.id, entry);
            }
        } catch(_) {}
    }
    
    _renderChargeVFX(ctx, otherPlayer, screenX, screenY, state, networkManager) {
        try {
            const mgr = networkManager;
            
            // Auto-cleanup stale charge VFX (not updated in 1.5 seconds)
            if (mgr && mgr.remoteChargingPlayers) {
                const now = Date.now();
                const STALE_TIMEOUT = 1500; // 1.5 seconds
                for (const [playerId, chargeData] of mgr.remoteChargingPlayers.entries()) {
                    if (chargeData.lastUpdate && (now - chargeData.lastUpdate) > STALE_TIMEOUT) {
                        console.log('[MultiplayerRenderer] Auto-cleaning stale charge VFX for player:', playerId);
                        mgr.remoteChargingPlayers.delete(playerId);
                    }
                }
            }
            
            if (mgr && mgr.remoteChargingPlayers && mgr.remoteChargingPlayers.has(otherPlayer.id) &&
                (otherPlayer.health == null || otherPlayer.health > 0)) {
                const chargeData = mgr.remoteChargingPlayers.get(otherPlayer.id);
                if (!chargeData) return;
                
                // Calculate tip position from player's current position and aim angle (same as artifact)
                const aimAngle = (typeof otherPlayer.aimAngle === 'number') ? otherPlayer.aimAngle : 0;
                const tipOffset = 50;
                // Use otherPlayer world position (updated by network smoothing)
                const tipX = otherPlayer.x + Math.cos(aimAngle) * tipOffset;
                const tipY = otherPlayer.y + Math.sin(aimAngle) * tipOffset;
                
                // Create ChargeVfx instance if it doesn't exist (retry every frame until successful)
                if (!chargeData.vfx) {
                    if (window.ChargeVfx) {
                        try {
                            chargeData.vfx = new window.ChargeVfx(tipX, tipY, chargeData.color || '#76b0ff', false);
                            console.log('[MultiplayerRenderer] Created charge VFX for remote player:', otherPlayer.id);
                        } catch (err) {
                            console.error('[MultiplayerRenderer] Failed to create ChargeVfx:', err);
                        }
                    } else {
                        // Log once per player if ChargeVfx class isn't available
                        if (!chargeData._warnedMissingClass) {
                            console.warn('[MultiplayerRenderer] ChargeVfx class not available yet for player:', otherPlayer.id);
                            chargeData._warnedMissingClass = true;
                        }
                        return; // Can't render without the class
                    }
                }
                
                // Update VFX position every frame to follow weapon tip
                if (chargeData.vfx) {
                    chargeData.vfx.updatePosition(tipX, tipY);
                    chargeData.vfx.setChargeProgress(chargeData.progress || 0);
                    
                    // Update animation (spawns/updates ripples and streaks)
                    const dt = (typeof window !== 'undefined' && window.state && Number.isFinite(window.state._lastDt)) 
                        ? window.state._lastDt : 0.016;
                    chargeData.vfx.update(dt);
                    
                    // Draw the VFX with all its animated particles
                    chargeData.vfx.draw(ctx, { x: state.cameraX, y: state.cameraY });
                }
            }
        } catch(e) {
            console.warn('[MultiplayerRenderer] Error rendering charge VFX:', e);
        }
    }
    
    _renderHealthBar(ctx, otherPlayer, screenX, screenY) {
        // Check if viewing player is evil and if target is invisible
        const viewerIsEvil = (typeof window !== 'undefined' && window.__killThemAllLocked === true);
        const targetIsEvil = (otherPlayer.evilLocked === true || otherPlayer.isEvil === true);
        
        // Hide health bar when invisible AND different alignment (enemy)
        const shouldHide = otherPlayer.invisible && (viewerIsEvil !== targetIsEvil);
        
        // Don't render at all if should be hidden (0% opacity for enemies)
        if (shouldHide) {
            return;
        }
        
        // Use the same render alpha as the body for allies
        const alpha = otherPlayer._renderAlpha || 1.0;
        
        ctx.save();
        ctx.globalAlpha = alpha;
            
            const h = Number.isFinite(otherPlayer.health) ? otherPlayer.health : 0;
            const hm = Number.isFinite(otherPlayer.healthMax) ? otherPlayer.healthMax : 100;
            const healthPercent = Math.max(0, Math.min(1, h / Math.max(1, hm)));
            const barWidth = 30;
            const barHeight = 4;
            const barX = screenX - barWidth / 2;
            const barY = screenY - (otherPlayer.radius || 20) - 10;
            
            ctx.fillStyle = '#333';
            ctx.fillRect(barX, barY, barWidth, barHeight);
            ctx.fillStyle = healthPercent > 0.5 ? '#4CAF50' : healthPercent > 0.25 ? '#FF9800' : '#F44336';
            ctx.fillRect(barX, barY, barWidth * healthPercent, barHeight);
            
        ctx.restore();
    }
    
    _renderPlayerId(ctx, otherPlayer, screenX, screenY) {
        // Check if viewing player is evil and if target is invisible
        const viewerIsEvil = (typeof window !== 'undefined' && window.__killThemAllLocked === true);
        const targetIsEvil = (otherPlayer.evilLocked === true || otherPlayer.isEvil === true);
        
        // Hide player ID when invisible AND different alignment (enemy)
        const shouldHide = otherPlayer.invisible && (viewerIsEvil !== targetIsEvil);
        
        // Don't render at all if should be hidden (0% opacity for enemies)
        if (shouldHide) {
            return;
        }
        
        // Use the same render alpha as the body for allies
        const alpha = otherPlayer._renderAlpha || 1.0;
        
        ctx.save();
        ctx.globalAlpha = alpha;
            ctx.fillStyle = '#FFF';
            ctx.font = '10px Arial';
            ctx.textAlign = 'center';
            const playerId = otherPlayer.id ? otherPlayer.id.substring(0, 6) : 'Unknown';
            ctx.fillText(playerId, screenX, screenY + (otherPlayer.radius || 20) + 15);
        ctx.restore();
    }
    
    _renderArtifact(ctx, otherPlayer, screenX, screenY, networkManager) {
        try {
            if (networkManager && networkManager.artifactCarrierId === otherPlayer.id) {
                const rPlayer = otherPlayer.radius || 20;
                const aim = (typeof otherPlayer.aimAngle === 'number') ? otherPlayer.aimAngle : 0;
                const backAng = aim + Math.PI;
                const dist = rPlayer + 18;
                const ax = screenX + Math.cos(backAng) * dist;
                const ay = screenY + Math.sin(backAng) * dist;
                const r = 12;
                ctx.save();
                ctx.shadowColor = '#4df2ff';
                ctx.shadowBlur = 16;
                ctx.fillStyle = '#8af7ff';
                ctx.strokeStyle = '#2bc7d6';
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.moveTo(ax, ay - r);
                ctx.lineTo(ax + r, ay);
                ctx.lineTo(ax, ay + r);
                ctx.lineTo(ax - r, ay);
                ctx.closePath();
                ctx.fill();
                ctx.stroke();
                ctx.restore();
            }
        } catch(_) {}
    }
    
    _renderBattery(ctx, otherPlayer, screenX, screenY) {
        try {
            // Find if this player is carrying a battery
            const batteries = window._batteries || [];
            const carriedBattery = batteries.find(b => b.carriedBy === otherPlayer.id);
            if (!carriedBattery) return;
            
            // Position on back (same calculation as artifact)
            const rPlayer = otherPlayer.radius || 20;
            const aim = (typeof otherPlayer.aimAngle === 'number') ? otherPlayer.aimAngle : 0;
            const backAng = aim + Math.PI;
            const dist = rPlayer + 18;
            const bx = screenX + Math.cos(backAng) * dist;
            const by = screenY + Math.sin(backAng) * dist;
            
            // WW2 Military battery dimensions (same as Battery.draw())
            const w = 28;
            const h = 38;
            
            ctx.save();
            ctx.translate(bx, by);
            
            // Colors - olive drab military style
            const oliveDrab = '#4a4a32';
            const oliveDark = '#3a3a28';
            const oliveDarker = '#2a2a1c';
            const rust = '#6b4423';
            const metalGray = '#5a5a5a';
            const metalDark = '#3a3a3a';
            
            // Shadow underneath
            ctx.fillStyle = 'rgba(0,0,0,0.3)';
            ctx.fillRect(-w/2 + 2, h/2 - 2, w, 4);
            
            // Main battery body
            ctx.fillStyle = oliveDrab;
            ctx.fillRect(-w/2, -h/2, w, h);
            
            // Darker side panel
            ctx.fillStyle = oliveDark;
            ctx.fillRect(-w/2, -h/2, 4, h);
            
            // Top plate
            ctx.fillStyle = '#5a5a42';
            ctx.fillRect(-w/2, -h/2, w, 8);
            
            // Metal terminals on top
            ctx.fillStyle = metalGray;
            ctx.fillRect(-8, -h/2 - 6, 6, 8);
            ctx.fillRect(2, -h/2 - 6, 6, 8);
            
            // Red terminal with glow
            const pulseTime = Date.now() / 1000;
            const redPulse = 0.4 + Math.sin(pulseTime * 2) * 0.3;
            ctx.shadowColor = `rgba(255, 60, 60, ${redPulse})`;
            ctx.shadowBlur = 6 + Math.sin(pulseTime * 2) * 3;
            ctx.fillStyle = '#8b0000';
            ctx.fillRect(-7, -h/2 - 8, 4, 4);
            ctx.fillStyle = `rgba(255, 100, 100, ${0.5 + Math.sin(pulseTime * 2) * 0.3})`;
            ctx.fillRect(-6, -h/2 - 7, 2, 2);
            ctx.shadowBlur = 0;
            
            // Black terminal
            ctx.fillStyle = '#1a1a1a';
            ctx.fillRect(3, -h/2 - 8, 4, 4);
            
            // Horizontal ridges
            ctx.fillStyle = oliveDarker;
            ctx.fillRect(-w/2, -h/4 - 2, w, 4);
            ctx.fillRect(-w/2, h/4 - 2, w, 4);
            
            // Rust patches
            ctx.fillStyle = rust;
            ctx.globalAlpha = 0.5;
            ctx.fillRect(-w/2, h/2 - 8, 8, 6);
            ctx.fillRect(w/2 - 10, -h/4, 8, 10);
            ctx.globalAlpha = 1.0;
            
            // Stenciled marking
            ctx.fillStyle = '#2a2a1c';
            ctx.globalAlpha = 0.6;
            ctx.font = 'bold 8px monospace';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('PWR', 0, 0);
            ctx.globalAlpha = 1.0;
            
            // Handle on top
            ctx.strokeStyle = metalDark;
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.moveTo(-6, -h/2);
            ctx.lineTo(-6, -h/2 - 3);
            ctx.lineTo(6, -h/2 - 3);
            ctx.lineTo(6, -h/2);
            ctx.stroke();
            
            // Outline
            ctx.strokeStyle = '#1a1a12';
            ctx.lineWidth = 2;
            ctx.strokeRect(-w/2, -h/2, w, h);
            
            // Corner rivets
            ctx.fillStyle = metalGray;
            const rivetR = 2;
            ctx.beginPath();
            ctx.arc(-w/2 + 4, -h/2 + 4, rivetR, 0, Math.PI * 2);
            ctx.arc(w/2 - 4, -h/2 + 4, rivetR, 0, Math.PI * 2);
            ctx.arc(-w/2 + 4, h/2 - 4, rivetR, 0, Math.PI * 2);
            ctx.arc(w/2 - 4, h/2 - 4, rivetR, 0, Math.PI * 2);
            ctx.fill();
            
            ctx.restore();
        } catch(_) {}
    }
    
    _renderSkin(ctx, otherPlayer, screenX, screenY) {
        // Draw equipped skin (stays upright regardless of player rotation)
        if (otherPlayer.equippedSkin && typeof window.SkinRenderer !== 'undefined') {
            try {
                window.SkinRenderer.render(
                    ctx,
                    screenX,
                    screenY,
                    otherPlayer.radius || 20,
                    otherPlayer.equippedSkin.name,
                    otherPlayer.equippedSkin.color
                );
            } catch(e) {
                console.warn('[MultiplayerRenderer] Skin rendering error:', e);
            }
        }
    }
    
    _renderHat(ctx, otherPlayer, screenX, screenY) {
        // Draw equipped hat (stays upright regardless of player rotation)
        if (otherPlayer.equippedHat && typeof window.HatRenderer !== 'undefined') {
            try {
                window.HatRenderer.render(
                    ctx,
                    screenX,
                    screenY,
                    otherPlayer.radius || 20,
                    otherPlayer.equippedHat.name,
                    otherPlayer.equippedHat.color
                );
            } catch(e) {
                console.warn('[MultiplayerRenderer] Hat rendering error:', e);
            }
        }
    }
}

// Export
if (typeof window !== 'undefined') {
    window.MultiplayerRenderer = MultiplayerRenderer;
}
