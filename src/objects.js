
class Chest {
        constructor(x, y, options = {}) {
                this.x = x;
                this.y = y;
                this.radius = 20;
                this.opened = false;
                this.artifact = null;
                this.drops = [];
                this.opening = false;
                this.openTimeTotal = 60; // 1:00 for gold chest opening
                this.openTimeLeft = 0;
                this.variant = options.variant || 'gold'; // 'gold' | 'brown'
                
		// Health tracking for gold chests (shared with artifact)
		if (this.variant === 'gold') {
			this.health = options.health !== undefined ? options.health : 9000;
			this.healthMax = options.healthMax !== undefined ? options.healthMax : 9000;
		}
                
                // Hit flash properties (for damage feedback)
                this.hitFlash = 0;
                this.hitFlashMax = 0.12;
                this.hitFlashCooldown = 0;
                this.hitFlashGap = 0.07;
        }

        tryOpen(player, requestOpen) {
                if (this.opened) return;
                const dx = (player?.x || 0) - this.x;
                const dy = (player?.y || 0) - this.y;
                // Use the same comfortable proximity as the tooltip (+30) so E works when the prompt shows
                const canOpen = dx * dx + dy * dy <= Math.pow((player?.radius || 18) + this.radius + 30, 2);
                if (canOpen && requestOpen && !this.opening) {
                        if (this.variant === 'brown' || this.variant === 'startGear') {
                                // Server-authoritative open (instant open for brown/startGear chests)
                                try {
                                        if (window.networkManager && window.networkManager.connected) {
                                                const id = this._id || (this._id = `${Math.round(this.x)},${Math.round(this.y)}`);
                                                window.networkManager.socket.emit('chestOpenRequest', { chestId: id, x: this.x, y: this.y, variant: this.variant });
                                        } else {
                                                // Single-player fallback
                                                this.opening = false; this.opened = true; this._spawnLoot();
                                        }
                                } catch(_) { this.opening = false; this.opened = true; this._spawnLoot(); }
                        } else {
                                // Gold chest uses server timer
                                try {
                                        if (window.networkManager && window.networkManager.connected) {
                                                const id = this._id || (this._id = `${Math.round(this.x)},${Math.round(this.y)}`);
                                                window.networkManager.socket.emit('chestOpenRequest', { chestId: id, x: this.x, y: this.y, variant: 'gold', timeTotal: this.openTimeTotal || 60 });
                                                // Optimistic UI start; server will keep time in sync
                                                this.opening = true; this.openTimeLeft = this.openTimeTotal;
                                        } else {
                                                this.opening = true; this.openTimeLeft = this.openTimeTotal;
                                        }
                                } catch(_) { this.opening = true; this.openTimeLeft = this.openTimeTotal; }
                        }
                }
        }

        update(dt, environment, player, aimAngle) {
                if (!this.opened && this.opening) {
                        this.openTimeLeft -= dt;
                        if (this.openTimeLeft <= 0) {
                                this.opening = false;
                                this.opened = true;
                                this._spawnLoot();
                        }
                }
                
                // Hit flash countdown (same as player)
                if (this.hitFlash > 0) {
                        this.hitFlash -= dt;
                        if (this.hitFlash < 0) this.hitFlash = 0;
                }
                if (this.hitFlashCooldown > 0) {
                        this.hitFlashCooldown -= dt;
                        if (this.hitFlashCooldown < 0) this.hitFlashCooldown = 0;
                }
                
                if (this.artifact) this.artifact.update(dt, environment, player, aimAngle);
                for (let i = 0; i < this.drops.length; i++) this.drops[i].update(dt, environment);
        }

        _spawnLoot() {
                if (this.variant === 'gold') {
                        const angle = (typeof WorldRNG !== 'undefined' && WorldRNG.randomFloat)
                                ? WorldRNG.randomFloat(0, Math.PI * 2)
                                : Math.random() * Math.PI * 2;
                        const speed = 160;
                        const vx = Math.cos(angle) * speed;
                        const vy = Math.sin(angle) * speed - 220;
                        // Pass health to artifact (shared health pool)
                        this.artifact = new Artifact(this.x, this.y, vx, vy, this.health, this.healthMax);
                        return;
                }
                
                // Brown/startGear chest: in multiplayer mode, server handles loot generation via chestOpened event
                // Only generate client-side loot in single-player mode
                if (this.variant === 'brown' || this.variant === 'startGear') {
                        if (window.networkManager && window.networkManager.connected) {
                                // Multiplayer mode: server authority handles loot generation
                                console.log('[Chest] Skipping client-side loot generation for brown/startGear chest in multiplayer mode');
                                return;
                        }
                        // Single-player mode: generate loot locally
                        console.log('[Chest] Generating client-side loot for brown/startGear chest in single-player mode');
                }
                
                // Brown chest: spawn 10 glowing hex stats with random rarities (color derived from rarity)
                const labels = ['+MovSpd', '+AtkSpd', '+AtkPwr', '+Armor', '+HP', '+Stm', '+CritChan', '+CritDmg'];
                const count = 10;
                const base = (typeof WorldRNG !== 'undefined' && WorldRNG.randomFloat)
                        ? WorldRNG.randomFloat(0, Math.PI * 2)
                        : Math.random() * Math.PI * 2;
                for (let i = 0; i < count; i++) {
                        const lab = labels[i % labels.length];
                        const rarity = HexStat.pickRandomRarity();
                        const color = rarity.color;
                        // Even ring distribution centered around the chest; moderate speed and no global upward bias
                        const ang = base + (i * (2 * Math.PI / count));
                        const spd = 170 + ((typeof WorldRNG !== 'undefined' && WorldRNG.randomFloat) ? WorldRNG.randomFloat(0, 50) : Math.random() * 50);
                        const hvx = Math.cos(ang) * spd;
                        const hvy = Math.sin(ang) * spd; // no extra lift so spread is uniform in all directions
                        this.drops.push(new HexStat(this.x, this.y, hvx, hvy, { label: lab, fill: color, rarity }));
                }
        }

        draw(ctx, camera, player) {
                const sx = Math.round(this.x - camera.x);
                const sy = Math.round(this.y - camera.y);
                ctx.save();
                ctx.translate(sx, sy);
                // Chest body (variant styles)
                if (this.variant === 'gold') {
                        ctx.fillStyle = this.opened ? '#b5912f' : '#d4af37';
                        ctx.strokeStyle = '#3a2d10';
                } else {
                        ctx.fillStyle = this.opened ? '#6b4a2e' : '#8a623e';
                        ctx.strokeStyle = '#000000';
                }
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.rect(-18.5, -14.5, 37, 29);
                ctx.fill();
                ctx.stroke();
                // Decorative center band and lock for gold chest only
                if (this.variant === 'gold') {
                        ctx.fillStyle = '#c49a2e';
                        ctx.fillRect(-4, -14.5, 8, 29);
                        ctx.fillStyle = '#8a6d1f';
                ctx.fillRect(-3, -2, 6, 8);
                ctx.fillStyle = '#3a2d10';
                ctx.beginPath();
                ctx.arc(0, 2, 1.5, 0, Math.PI * 2);
                ctx.fill();
        }
        // Lid hint when closed and not opening
        if (!this.opened && !this.opening) {
                ctx.beginPath();
                ctx.moveTo(-18, -3);
                ctx.lineTo(18, -3);
                ctx.strokeStyle = (this.variant === 'gold') ? '#957a2c' : '#3b2a1a';
                ctx.stroke();
        }
        
        // Hit flash overlay when damaged (rectangular shape matching chest body)
        if (this.hitFlash > 0) {
                const denom = this.hitFlashMax || 0.12;
                const t = Math.max(0, Math.min(1, this.hitFlash / denom));
                ctx.globalAlpha = Math.pow(t, 0.4) * 0.9; // Strong at start, fast fade
                ctx.fillStyle = '#ff3b3b';
                ctx.fillRect(-18.5, -14.5, 37, 29); // Same size as chest body
                ctx.globalAlpha = 1.0; // Reset alpha
        }
        
        ctx.restore();
        
        // Health bar for gold chest (when not opened)
        if (this.variant === 'gold' && this.health !== undefined && !this.opened) {
                const barWidth = 50;
                const barHeight = 6;
                const bx = sx - barWidth / 2;
                const by = sy - this.radius - 22;
                
                ctx.save();
                // Background
                ctx.fillStyle = 'rgba(255,255,255,0.12)';
                ctx.fillRect(bx, by, barWidth, barHeight);
                // Health fill
                const healthPercent = Math.max(0, Math.min(1, this.health / this.healthMax));
                ctx.fillStyle = healthPercent > 0.5 ? '#4CAF50' : healthPercent > 0.25 ? '#FF9800' : '#F44336';
                ctx.fillRect(bx, by, barWidth * healthPercent, barHeight);
                // Border
                ctx.strokeStyle = 'rgba(0,0,0,0.6)';
                ctx.lineWidth = 2;
                ctx.strokeRect(bx + 0.5, by + 0.5, barWidth, barHeight);
                ctx.restore();
        }
        
        // Opening UI when in progress
                if (!this.opened && this.opening) {
                        const label = 'Artifact Opening';
                        const timeLeft = Math.max(0, this.openTimeLeft || 0);
                        const frac = Math.max(0, Math.min(1, 1 - (timeLeft / Math.max(0.0001, this.openTimeTotal || 1))));
                        const barW = 140, barH = 12;
                        const bx = sx;
                        const by = sy - 34;
                        ctx.save();
                        ctx.textAlign = 'center';
                        ctx.textBaseline = 'bottom';
                        ctx.font = '14px sans-serif';
                        ctx.fillStyle = 'rgba(0,0,0,0.6)';
                        ctx.fillText(label, bx + 1, by - 18 + 1);
                        ctx.fillStyle = '#ffffff';
                        ctx.fillText(label, bx, by - 18);
                        // Bar background
                        ctx.fillStyle = 'rgba(255,255,255,0.12)';
                        ctx.fillRect(bx - barW / 2, by - barH / 2, barW, barH);
                        // Fill
                        ctx.fillStyle = '#76ffb0';
                        ctx.fillRect(bx - barW / 2, by - barH / 2, Math.round(barW * frac), barH);
                        // Stroke
                        ctx.lineWidth = 2;
                        ctx.strokeStyle = 'rgba(0,0,0,0.6)';
                        ctx.strokeRect(Math.round(bx - barW / 2) + 0.5, Math.round(by - barH / 2) + 0.5, barW, barH);
                        // Countdown text
                        const tlabel = `${timeLeft.toFixed(1)}s`;
                        ctx.fillStyle = 'rgba(0,0,0,0.6)';
                        ctx.fillText(tlabel, bx + 1, by + barH + 4 + 1);
                        ctx.fillStyle = '#ffffff';
                        ctx.fillText(tlabel, bx, by + barH + 4);
                        ctx.restore();
                }
                // Tooltip when close and not opened and not opening
                if (!this.opened && !this.opening && player) {
                        const dx = (player.x || 0) - this.x;
                        const dy = (player.y || 0) - this.y;
                        const near = dx * dx + dy * dy <= Math.pow((player.radius || 18) + this.radius + 30, 2);
                        if (near) {
                                ctx.save();
                                ctx.textAlign = 'center';
                                ctx.textBaseline = 'bottom';
                                ctx.font = '14px sans-serif';
                                ctx.fillStyle = 'rgba(0,0,0,0.6)';
                                ctx.fillText('Press E to open', sx + 1, sy - 26 + 1);
                                ctx.fillStyle = '#ffffff';
                                ctx.fillText('Press E to open', sx, sy - 26);
                                ctx.restore();
                        }
                }
                if (this.artifact) this.artifact.draw(ctx, camera, player);
                for (let i = 0; i < this.drops.length; i++) this.drops[i].draw(ctx, camera);
        }
}

class Artifact {
        constructor(x, y, vx = 0, vy = 0, health = undefined, healthMax = undefined) {
                this.x = x; this.y = y;
                this.vx = vx; this.vy = vy;
                this.radius = 10;
                this.onGround = false;
                this.carriedBy = null;
                this.pickupLockout = 0.15; // seconds after spawn before it can be picked up (reduced for responsiveness)
                
                // Health tracking (inherited from chest)
                this.health = health !== undefined ? health : 300;
                this.healthMax = healthMax !== undefined ? healthMax : 300;
                
                // Hit flash properties (for damage feedback)
                this.hitFlash = 0;
                this.hitFlashMax = 0.12;
                this.hitFlashCooldown = 0;
                this.hitFlashGap = 0.07;
        }

        canPickUp(player) {
                if (!player || this.carriedBy) return false;
                if (!this.onGround) return false;
                if (this.pickupLockout > 0) return false;
                const dx = player.x - this.x;
                const dy = player.y - this.y;
                // Match tooltip proximity (artifact draw uses +40) so the prompt implies a valid pickup range
                const r = (player.radius || 26) + this.radius + 40;
                return (dx * dx + dy * dy) <= r * r;
        }

        update(dt, environment, player, aimAngle) {
                if (this.pickupLockout > 0) { this.pickupLockout -= dt; if (this.pickupLockout < 0) this.pickupLockout = 0; }
                
                // Hit flash countdown (same as player)
                if (this.hitFlash > 0) {
                        this.hitFlash -= dt;
                        if (this.hitFlash < 0) this.hitFlash = 0;
                }
                if (this.hitFlashCooldown > 0) {
                        this.hitFlashCooldown -= dt;
                        if (this.hitFlashCooldown < 0) this.hitFlashCooldown = 0;
                }
                
                if (this.carriedBy && player) {
                        // Follow just behind the player based on aim angle
                        const backAng = (typeof aimAngle === 'number') ? (aimAngle + Math.PI) : Math.PI;
                        const dist = (player.radius || 26) + 18;
                        this.x = player.x + Math.cos(backAng) * dist;
                        this.y = player.y + Math.sin(backAng) * dist;
                        this.vx = 0; this.vy = 0;
                        this.onGround = true;
                        return;
                }
                if (this.onGround) return;
                // Gravity-like drop then slide on ground
                this.vy += 600 * dt;
                let nx = this.x + this.vx * dt;
                let ny = this.y + this.vy * dt;
                // Resolve against environment
                if (environment && typeof environment.resolveCircleMove === 'function') {
                        const res = environment.resolveCircleMove(this.x, this.y, this.radius, nx - this.x, ny - this.y);
                        nx = res.x; ny = res.y;
                }
                // Ground contact heuristic: if vertical velocity flips or very small progress, consider landed
                if (Math.abs(this.vy) < 10) {
                        this.onGround = true;
                        this.vx = 0; this.vy = 0;
                }
                this.x = nx; this.y = ny;
        }

        draw(ctx, camera, player) {
                const sx = Math.round(this.x - camera.x);
                const sy = Math.round(this.y - camera.y);
                ctx.save();
                ctx.translate(sx, sy);
                // Glowing diamond
                const r = 12;
                ctx.shadowColor = '#4df2ff';
                ctx.shadowBlur = 16;
                ctx.fillStyle = '#8af7ff';
                ctx.strokeStyle = '#2bc7d6';
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.moveTo(0, -r);
                ctx.lineTo(r, 0);
                ctx.lineTo(0, r);
                ctx.lineTo(-r, 0);
                ctx.closePath();
                ctx.fill();
                ctx.stroke();
                
                // Hit flash overlay when damaged (diamond shape matching artifact)
                if (this.hitFlash > 0) {
                        const denom = this.hitFlashMax || 0.12;
                        const t = Math.max(0, Math.min(1, this.hitFlash / denom));
                        ctx.globalAlpha = Math.pow(t, 0.4) * 0.9; // Strong at start, fast fade
                        ctx.fillStyle = '#ff3b3b';
                        ctx.beginPath();
                        ctx.moveTo(0, -r);
                        ctx.lineTo(r, 0);
                        ctx.lineTo(0, r);
                        ctx.lineTo(-r, 0);
                        ctx.closePath();
                        ctx.fill();
                        ctx.globalAlpha = 1.0; // Reset alpha
                }
                
                ctx.restore();
                
                // Health bar for artifact (when not carried)
                if (this.health !== undefined && !this.carriedBy) {
                        const barWidth = 40;
                        const barHeight = 5;
                        const bx = sx - barWidth / 2;
                        const by = sy - this.radius - 24;
                        
                        ctx.save();
                        // Background
                        ctx.fillStyle = 'rgba(255,255,255,0.12)';
                        ctx.fillRect(bx, by, barWidth, barHeight);
                        // Health fill
                        const healthPercent = Math.max(0, Math.min(1, this.health / this.healthMax));
                        ctx.fillStyle = healthPercent > 0.5 ? '#4CAF50' : healthPercent > 0.25 ? '#FF9800' : '#F44336';
                        ctx.fillRect(bx, by, barWidth * healthPercent, barHeight);
                        // Border
                        ctx.strokeStyle = 'rgba(0,0,0,0.6)';
                        ctx.lineWidth = 2;
                        ctx.strokeRect(bx + 0.5, by + 0.5, barWidth, barHeight);
                        ctx.restore();
                }
                
                // Tooltip to carry when on ground and near
                if (!this.carriedBy && this.onGround && player) {
                        const dx = player.x - this.x;
                        const dy = player.y - this.y;
                        const r2 = Math.pow((player.radius || 26) + this.radius + 40, 2);
                        if (dx * dx + dy * dy <= r2) {
                                ctx.save();
                                ctx.textAlign = 'center';
                                ctx.textBaseline = 'bottom';
                                ctx.font = '14px sans-serif';
                                ctx.fillStyle = 'rgba(0,0,0,0.6)';
                                ctx.fillText('Press E to Carry', sx + 1, sy - 22 + 1);
                                ctx.fillStyle = '#ffffff';
                                ctx.fillText('Press E to Carry', sx, sy - 22);
                                ctx.restore();
                        }
                }
        }
}

class HexStat {
        constructor(x, y, vx, vy, options = {}) {
                this.x = x; this.y = y;
                this.vx = vx; this.vy = vy;
                this.radius = 12;
                this.onGround = false;
                this.baseLabel = options.label || '+Stat';
                this.label = this.baseLabel; // inventory label may be augmented with values
                this.rarity = options.rarity || { name: 'Common', color: '#ffffff' };
                this.fill = options.fill || this.rarity.color;
                this.equippedBy = null;
                this.pickupLockout = 0.5;
                this.fullMsgTimer = 0; // seconds remaining for "Inventory Full" message
                this.flightTimer = 0;
                this.maxFlight = 0.42; // seconds to travel before settling

                // Compute per-rarity bonus values from label and rarity
                const bonus = HexStat._computeBonusFromLabelAndRarity(this.label, this.rarity?.name);
                this.statKey = bonus.statKey;        // canonical key, e.g. 'Health', 'MovSpd'
                this.bonusValue = bonus.value;       // numeric value (percent numbers are without % sign)
                this.isPercent = bonus.isPercent;    // whether to apply as percentage of base later
                // Build inventory label including values; on-ground will use baseLabel only
                if (this.statKey && Number.isFinite(this.bonusValue) && this.bonusValue > 0) {
                        const suffix = this.isPercent ? `${this.bonusValue}%` : `${this.bonusValue}`;
                        this.label = `${this.baseLabel} ${suffix}`;
                }
        }

        static pickRandomRarity() {
                const rarities = [
                        { name: 'Common', color: '#ffffff' },
                        { name: 'Uncommon', color: '#2ecc71' },
                        { name: 'Rare', color: '#4da3ff' },
                        { name: 'Epic', color: '#b26aff' },
                        { name: 'Legendary', color: '#ffa64d' }
                ];
                try {
                        if (typeof WorldRNG !== 'undefined' && WorldRNG.randomInt) {
                                const idx = WorldRNG.randomInt(0, rarities.length - 1);
                                return rarities[idx];
                        }
                } catch(_) {}
                return rarities[Math.floor(Math.random() * rarities.length)];
        }

        // Map labels to canonical stat keys
        static _normalizeLabelToKey(label) {
                if (!label || typeof label !== 'string') return null;
                const raw = label.trim().replace(/^\+/, ''); // remove leading + if present
                switch (raw) {
                        case 'HP': return 'Health';
                        case 'Health': return 'Health';
                        case 'Armor': return 'Armor';
                        case 'Stm': return 'Stamina';
                        case 'Stamina': return 'Stamina';
                        case 'MovSpd': return 'MovSpd';
                        case 'AtkSpd': return 'AtkSpd';
                        case 'AtkPwr': return 'AtkPwr';
                        case 'CritChan': return 'CritChance';
                        case 'CritChance': return 'CritChance';
                        case 'CritDmg': return 'CritDmg';
                        default: return null;
                }
        }

        static _rarityIndex(name) {
                const order = ['Common', 'Uncommon', 'Rare', 'Epic', 'Legendary'];
                const idx = order.indexOf(name);
                return idx >= 0 ? idx : 0;
        }

        static _getStatConfig() {
                // Values are ordered by rarity: Common, Uncommon, Rare, Epic, Legendary
                return {
                        Health: { values: [10, 20, 50, 100, 150], percent: false },
                        Armor: { values: [5, 10, 15, 25, 35], percent: true },
                        Stamina: { values: [10, 20, 50, 100, 150], percent: false },
                        MovSpd: { values: [5, 10, 15, 25, 30], percent: true },
                        AtkSpd: { values: [5, 10, 15, 20, 40], percent: true },
                        AtkPwr: { values: [2, 5, 10, 20, 30], percent: false },
                        CritChance: { values: [2, 5, 10, 20, 30], percent: true },
                        CritDmg: { values: [10, 20, 30, 50, 60], percent: true }
                };
        }

        static _computeBonusFromLabelAndRarity(label, rarityName) {
                const statKey = HexStat._normalizeLabelToKey(label);
                const cfg = HexStat._getStatConfig();
                if (!statKey || !cfg[statKey]) return { statKey: null, value: 0, isPercent: false };
                const rIdx = HexStat._rarityIndex(rarityName);
                const values = cfg[statKey].values;
                const value = values[Math.min(Math.max(rIdx, 0), values.length - 1)] || 0;
                const isPercent = !!cfg[statKey].percent;
                return { statKey, value, isPercent };
        }

        update(dt, environment) {
                if (this.pickupLockout > 0) { this.pickupLockout -= dt; if (this.pickupLockout < 0) this.pickupLockout = 0; }
                if (this.fullMsgTimer > 0) { this.fullMsgTimer -= dt; if (this.fullMsgTimer < 0) this.fullMsgTimer = 0; }
                if (this.equippedBy) return;
                if (this.onGround) return;
                // Simple ballistic: constant outward velocity, settle after a short time
                this.flightTimer += dt;
                let nx = this.x + this.vx * dt;
                let ny = this.y + this.vy * dt;
                if (environment && typeof environment.resolveCircleMove === 'function') {
                        const res = environment.resolveCircleMove(this.x, this.y, this.radius, nx - this.x, ny - this.y);
                        nx = res.x; ny = res.y;
                }
                if (this.flightTimer >= this.maxFlight) { this.onGround = true; this.vx = 0; this.vy = 0; }
                this.x = nx; this.y = ny;
        }

        canEquip(player) {
                if (!player) return false;
                if (this.equippedBy) return false;
                if (!this.onGround) return false;
                if (this.pickupLockout > 0) return false;
                const dx = player.x - this.x;
                const dy = player.y - this.y;
                const r = (player.radius || 26) + this.radius + 12;
                return (dx * dx + dy * dy) <= r * r;
        }

        draw(ctx, camera) {
                if (this.equippedBy) return;
                const sx = Math.round(this.x - camera.x);
                const sy = Math.round(this.y - camera.y);
                ctx.save();
                ctx.translate(sx, sy);
                // Glow
                ctx.shadowColor = this.fill;
                ctx.shadowBlur = 16;
                // Hexagon
                const r = 14;
                ctx.beginPath();
                for (let i = 0; i < 6; i++) {
                        const a = Math.PI / 3 * i + Math.PI / 6; // flat-top hex
                        const px = Math.cos(a) * r;
                        const py = Math.sin(a) * r;
                        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
                }
                ctx.closePath();
                ctx.fillStyle = this.fill;
                ctx.fill();
                ctx.lineWidth = 2;
                ctx.strokeStyle = '#000000';
                ctx.stroke();
                ctx.restore();
                // Label below with rarity color
                ctx.save();
                ctx.textAlign = 'center';
                ctx.textBaseline = 'top';
                ctx.font = '14px monospace';
                ctx.fillStyle = 'rgba(0,0,0,0.6)';
                ctx.fillText(this.baseLabel, sx + 1, sy + 18 + 1);
                ctx.fillStyle = this.rarity.color;
                ctx.fillText(this.baseLabel, sx, sy + 18);
                ctx.restore();
                // Equip tooltip only for the current nearest candidate
                try {
                        if (window && window.currentEquipHex === this) {
                                ctx.save();
                                ctx.textAlign = 'center';
                                ctx.textBaseline = 'bottom';
                                ctx.font = '14px sans-serif';
                                ctx.fillStyle = 'rgba(0,0,0,0.6)';
                                ctx.fillText('Press E to equip', sx + 1, sy - 24 + 1);
                                ctx.fillStyle = '#ffffff';
                                ctx.fillText('Press E to equip', sx, sy - 24);
                                ctx.restore();
                        }
                } catch(e) {}
                // Inventory full message (rendered over the player instead of the item)
                if (this.fullMsgTimer > 0) {
                        try {
                                const pl = window?.director?.player || window?.player;
                                if (pl) {
                                        const psx = Math.round(pl.x - camera.x);
                                        const psy = Math.round(pl.y - camera.y);
                                        ctx.save();
                                        ctx.textAlign = 'center';
                                        ctx.textBaseline = 'bottom';
                                        ctx.font = 'bold 14px sans-serif';
                                        ctx.fillStyle = 'rgba(0,0,0,0.6)';
                                        ctx.fillText('Inventory Full', psx + 1, psy - (pl.radius || 26) - 44 + 1);
                                        ctx.fillStyle = '#ffffff';
                                        ctx.fillText('Inventory Full', psx, psy - (pl.radius || 26) - 44);
                                        ctx.restore();
                                }
                        } catch(e) {}
                }
        }
}

class ExtractionZone {
        constructor(x, y, size = 450) {
                this.x = x;
                this.y = y;
                this.size = size;
                this.visible = false; // controlled externally (artifact carried)
                this.started = false;
                this.extracted = false;
                this.timeTotal = 60.0;
                this.timeLeft = 0;
        }

        _isPlayerNearCenter(player) {
                if (!player) return false;
                const dx = (player.x || 0) - this.x;
                const dy = (player.y || 0) - this.y;
                // Comfortable proximity to the center box
                const r = (player.radius || 26) + 40;
                return (dx * dx + dy * dy) <= r * r;
        }

        tryStart(player, requestStart) {
                if (!this.visible || this.started || this.extracted) return;
                if (!requestStart) return;
                if (!this._isPlayerNearCenter(player)) return;
                
                // In multiplayer, request server to start timer
                if (window.networkManager && window.networkManager.connected) {
                        try {
                                window.networkManager.startExtractionTimer('normal');
                        } catch(e) {
                                console.error('[ExtractionZone] Error requesting timer start:', e);
                        }
                        return;
                }
                
                // Single-player: local validation and start
                // Require companion arrival when being followed by NPC_A
                try {
                        const npcs = window?.npcs?.items || [];
                        let companionFollowing = false;
                        let companionInZone = false;
                        for (let i = 0; i < npcs.length; i++) {
                                const n = npcs[i];
                                if (!n || !n.alive) continue;
                                if (n.name === 'NPC_A' && n.state === 'follow') {
                                        companionFollowing = true;
                                        const half = this.size / 2;
                                        const inZone = (n.x >= this.x - half && n.x <= this.x + half && n.y >= this.y - half && n.y <= this.y + half);
                                        if (inZone) companionInZone = true;
                                        break;
                                }
                        }
                        if (companionFollowing && !companionInZone) return;
                } catch(_) {}
                // Require that artifact has been picked up by at least one player before starting
                try {
                        let artifactPicked = false;
                        if (Array.isArray(window?.director ? [window.director.player] : [window.player])) {
                                for (let i = 0; i < (window.chests?.length || 0); i++) {
                                        const a = window.chests[i]?.artifact;
                                        if (a && a.carriedBy) { artifactPicked = true; break; }
                                }
                        }
                        // Fallback: scan known chests from main.js scope if available
                        if (!artifactPicked && Array.isArray(window?.getChests?.())) {
                                const list = window.getChests();
                                for (let i = 0; i < list.length; i++) { const a = list[i]?.artifact; if (a && a.carriedBy) { artifactPicked = true; break; } }
                        }
                        if (!artifactPicked) return;
                } catch(e) {}
                this.started = true;
                this.timeLeft = this.timeTotal;
        }

        update(dt) {
                // In multiplayer, timer state comes from server via syncFromServer()
                // Only handle local countdown for single-player
                if (window.networkManager && window.networkManager.connected) {
                        return;
                }
                
                // Single-player: local timer logic
                if (!this.started || this.extracted) return;
                this.timeLeft -= dt;
                if (this.timeLeft <= 0) {
                        this.timeLeft = 0;
                        this.started = false;
                        this.extracted = true;
                }
        }
        
        syncFromServer(serverData) {
                // Synchronize timer state from server
                const wasExtracted = this.extracted;
                this.started = serverData.started;
                this.extracted = serverData.extracted;
                this.timeLeft = serverData.timeLeft;
                this.timeTotal = serverData.timeTotal;
                
                // Check win condition when extraction just completed
                if (!wasExtracted && this.extracted && window.state && !window.state.extractionEnd) {
                        this._checkWinCondition();
                }
                // Quiet: avoid per-frame console spam
        }
        
        _checkWinCondition() {
                // Check if players and artifact are in zone
                try {
                        const player = window.player || (window.director && window.director.player);
                        if (!player) return;
                        
                        const half = (this.size || 300) / 2;
                        const inZone = (px, py) => (px >= this.x - half && px <= this.x + half && py >= this.y - half && py <= this.y + half);
                        const playerIn = inZone(player.x, player.y);
                        
                        let artifactIn = false;
                        const chests = (typeof window.getChests === 'function') ? window.getChests() : (window.chests || []);
                        
                        // Check local artifact
                        for (let i = 0; i < chests.length; i++) {
                                const a = chests[i]?.artifact;
                                if (!a) continue;
                                const ax = a.carriedBy ? a.carriedBy.x : a.x;
                                const ay = a.carriedBy ? a.carriedBy.y : a.y;
                                artifactIn = inZone(ax, ay);
                                break;
                        }
                        
                        // In multiplayer, if artifact not found locally, check if remote player has it
                        if (!artifactIn && window.networkManager && window.networkManager.artifactCarrierId) {
                                const carrierId = window.networkManager.artifactCarrierId;
                                // Check if local player is the carrier
                                if (carrierId === window.networkManager.playerId) {
                                        artifactIn = playerIn; // Local player has it, so artifact is wherever they are
                                } else {
                                        // Remote player has it - check their position
                                        const otherPlayer = window.networkManager.otherPlayers.get(carrierId);
                                        if (otherPlayer) {
                                                artifactIn = inZone(otherPlayer.x, otherPlayer.y);
                                        }
                                }
                        }
                        
                        // Check if local player is evil
                        let isEvil = false;
                        try { isEvil = (typeof window !== 'undefined' && window.__killThemAllLocked === true); } catch(_) {}
                        
                        if (playerIn && artifactIn) {
                                // Non-evil players win, evil players lose
                                if (isEvil) {
                                        window.state.extractionEnd = { type: 'lose', reason: 'The artifact was extracted by your enemies' };
                                        console.log('[ExtractionZone] Lose condition - artifact extracted by non-evil players');
                                } else {
                                        window.state.extractionEnd = { type: 'win' };
                                        console.log('[ExtractionZone] Win condition met - mission complete!');
                                }
                                window.state.isFrozen = true;
                        } else {
                                window.state.extractionEnd = { type: 'lose', reason: 'The artifact was left behind' };
                                console.log('[ExtractionZone] Lose condition - artifact or player not in zone');
                        }
                } catch(e) {
                        console.error('[ExtractionZone] Error checking win condition:', e);
                }
        }

        draw(ctx, camera, player) {
                if (!this.visible) return;
                const half = this.size / 2;
                const sx = Math.round(this.x - half - camera.x) + 0.5;
                const sy = Math.round(this.y - half - camera.y) + 0.5;
                // Dotted green outline square
                ctx.save();
                ctx.setLineDash([10, 8]);
                ctx.lineWidth = 4;
                ctx.strokeStyle = '#21f07a';
                ctx.beginPath();
                ctx.rect(sx, sy, Math.round(this.size), Math.round(this.size));
                ctx.stroke();
                ctx.setLineDash([]);
                // Label at top center
                const labelX = sx + Math.round(this.size / 2);
                const labelY = sy - 14;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'bottom';
                ctx.font = 'bold 16px sans-serif';
                ctx.fillStyle = 'rgba(0,0,0,0.6)';
                ctx.fillText('Extraction Zone', labelX + 1, labelY + 1);
                ctx.fillStyle = '#76ffb0';
                ctx.fillText('Extraction Zone', labelX, labelY);
                ctx.restore();

                // Center green box
                const cx = Math.round(this.x - camera.x);
                const cy = Math.round(this.y - camera.y);
                const boxW = 42, boxH = 42;
                ctx.save();
                ctx.fillStyle = '#21f07a';
                ctx.strokeStyle = '#0c5b34';
                ctx.lineWidth = 3;
                ctx.beginPath();
                ctx.rect(cx - Math.floor(boxW / 2), cy - Math.floor(boxH / 2), boxW, boxH);
                ctx.fill();
                ctx.stroke();
                ctx.restore();

                // Tooltip when close and not started/extracted
                if (!this.started && !this.extracted && this._isPlayerNearCenter(player)) {
                        ctx.save();
                        ctx.textAlign = 'center';
                        ctx.textBaseline = 'bottom';
                        ctx.font = '14px sans-serif';
                        // Determine if a companion (NPC_A in follow) exists and is inside the zone
                        let companionFollowing = false;
                        let companionInZone = false;
                        try {
                                const npcs = window?.npcs?.items || [];
                                for (let i = 0; i < npcs.length; i++) {
                                        const n = npcs[i];
                                        if (!n || !n.alive) continue;
                                        if (n.name === 'NPC_A' && n.state === 'follow') {
                                                companionFollowing = true;
                                                const half = this.size / 2;
                                                const inZone = (n.x >= this.x - half && n.x <= this.x + half && n.y >= this.y - half && n.y <= this.y + half);
                                                if (inZone) companionInZone = true;
                                                break;
                                        }
                                }
                        } catch(_) {}
                        const needCompanion = companionFollowing && !companionInZone;
                        const tip = needCompanion ? 'Your companion must arrive' : 'Press E to extract';
                        ctx.fillStyle = 'rgba(0,0,0,0.6)';
                        ctx.fillText(tip, cx + 1, cy - Math.floor(boxH / 2) - 12 + 1);
                        ctx.fillStyle = '#ffffff';
                        ctx.fillText(tip, cx, cy - Math.floor(boxH / 2) - 12);
                        ctx.restore();
                }

                // Progress bar when extracting
                if (this.started) {
                        const total = Math.max(1, this.timeTotal || 60);
                        const label = `Extraction in ${Math.round(total)} seconds`;
                        const timeLeft = Math.max(0, this.timeLeft || 0);
                        const frac = Math.max(0, Math.min(1, 1 - (timeLeft / Math.max(0.0001, this.timeTotal || 1))));
                        const barW = 160, barH = 14;
                        const bx = cx;
                        const by = cy - Math.floor(boxH / 2) - 24;
                        ctx.save();
                        ctx.textAlign = 'center';
                        ctx.textBaseline = 'bottom';
                        ctx.font = '14px sans-serif';
                        ctx.fillStyle = 'rgba(0,0,0,0.6)';
                        ctx.fillText(label, bx + 1, by - 18 + 1);
                        ctx.fillStyle = '#ffffff';
                        ctx.fillText(label, bx, by - 18);
                        // Bar background
                        ctx.fillStyle = 'rgba(255,255,255,0.12)';
                        ctx.fillRect(bx - barW / 2, by - barH / 2, barW, barH);
                        // Fill
                        ctx.fillStyle = '#76ffb0';
                        ctx.fillRect(bx - barW / 2, by - barH / 2, Math.round(barW * frac), barH);
                        // Stroke
                        ctx.lineWidth = 2;
                        ctx.strokeStyle = 'rgba(0,0,0,0.6)';
                        ctx.strokeRect(Math.round(bx - barW / 2) + 0.5, Math.round(by - barH / 2) + 0.5, barW, barH);
                        // Countdown text
                        const tlabel = `${timeLeft.toFixed(1)}s`;
                        ctx.fillStyle = 'rgba(0,0,0,0.6)';
                        ctx.fillText(tlabel, bx + 1, by + barH + 4 + 1);
                        ctx.fillStyle = '#ffffff';
                        ctx.fillText(tlabel, bx, by + barH + 4);
                        ctx.restore();
                }
        }
}

// Heretic Extraction Zone (red) - only usable by converted player
class HereticExtractionZone {
        constructor(x, y, size = 300) {
                this.x = x;
                this.y = y;
                this.size = size;
                this.visible = false;
                this.started = false;
                this.extracted = false;
                this.timeTotal = 60.0;
                this.timeLeft = 0;
        }

        _isPlayerNearCenter(player) {
                if (!player) return false;
                const dx = (player.x || 0) - this.x;
                const dy = (player.y || 0) - this.y;
                const r = (player.radius || 26) + 40;
                return (dx * dx + dy * dy) <= r * r;
        }

        tryStart(player, requestStart) {
                if (!this.visible || this.started || this.extracted) return;
                if (!requestStart) return;
                if (!this._isPlayerNearCenter(player)) return;
                
                // In multiplayer, request server to start timer
                if (window.networkManager && window.networkManager.connected) {
                        try {
                                window.networkManager.startExtractionTimer('heretic');
                        } catch(e) {
                                console.error('[HereticExtractionZone] Error requesting timer start:', e);
                        }
                        return;
                }
                
                // Single-player: local validation and start
                // Require conversion lock
                try { if (!(typeof window !== 'undefined' && window.__killThemAllLocked === true)) return; } catch(_) { return; }
                // Require artifact to have been picked up by someone
                try {
                        let artifactPicked = false;
                        if (Array.isArray(window?.getChests?.())) {
                                const list = window.getChests();
                                for (let i = 0; i < list.length; i++) { const a = list[i]?.artifact; if (a && a.carriedBy) { artifactPicked = true; break; } }
                        }
                        if (!artifactPicked) return;
                } catch(_) { return; }
                this.started = true;
                this.timeLeft = this.timeTotal;
        }

        update(dt) {
                // In multiplayer, timer state comes from server via syncFromServer()
                // Only handle local countdown for single-player
                if (window.networkManager && window.networkManager.connected) {
                        return;
                }
                
                // Single-player: local timer logic
                if (!this.started || this.extracted) return;
                this.timeLeft -= dt;
                if (this.timeLeft <= 0) {
                        this.timeLeft = 0;
                        this.started = false;
                        this.extracted = true;
                }
        }
        
        syncFromServer(serverData) {
                // Synchronize timer state from server
                const wasExtracted = this.extracted;
                this.started = serverData.started;
                this.extracted = serverData.extracted;
                this.timeLeft = serverData.timeLeft;
                this.timeTotal = serverData.timeTotal;
                
                // Check win condition when extraction just completed
                if (!wasExtracted && this.extracted && window.state && !window.state.extractionEnd) {
                        this._checkWinCondition();
                }
                // Quiet: avoid per-frame console spam
        }
        
        _checkWinCondition() {
                // Check if players and artifact are in zone (heretic ending)
                try {
                        const player = window.player || (window.director && window.director.player);
                        if (!player) return;
                        
                        const half = (this.size || 300) / 2;
                        const inZone = (px, py) => (px >= this.x - half && px <= this.x + half && py >= this.y - half && py <= this.y + half);
                        const playerIn = inZone(player.x, player.y);
                        
                        let artifactIn = false;
                        const chests = (typeof window.getChests === 'function') ? window.getChests() : (window.chests || []);
                        
                        // Check local artifact
                        for (let i = 0; i < chests.length; i++) {
                                const a = chests[i]?.artifact;
                                if (!a) continue;
                                const ax = a.carriedBy ? a.carriedBy.x : a.x;
                                const ay = a.carriedBy ? a.carriedBy.y : a.y;
                                artifactIn = inZone(ax, ay);
                                break;
                        }
                        
                        // In multiplayer, if artifact not found locally, check if remote player has it
                        if (!artifactIn && window.networkManager && window.networkManager.artifactCarrierId) {
                                const carrierId = window.networkManager.artifactCarrierId;
                                // Check if local player is the carrier
                                if (carrierId === window.networkManager.playerId) {
                                        artifactIn = playerIn; // Local player has it, so artifact is wherever they are
                                } else {
                                        // Remote player has it - check their position
                                        const otherPlayer = window.networkManager.otherPlayers.get(carrierId);
                                        if (otherPlayer) {
                                                artifactIn = inZone(otherPlayer.x, otherPlayer.y);
                                        }
                                }
                        }
                        
                        // Check if local player is evil
                        let isEvil = false;
                        try { isEvil = (typeof window !== 'undefined' && window.__killThemAllLocked === true); } catch(_) {}
                        
                        if (playerIn && artifactIn) {
                                // Evil players win with heretic ending, non-evil players lose
                                if (isEvil) {
                                        window.state.extractionEnd = { type: 'heretic', reason: 'The heretics have stolen the artifact' };
                                        console.log('[HereticExtractionZone] Heretic ending triggered!');
                                } else {
                                        window.state.extractionEnd = { type: 'lose', reason: 'The heretics have stolen the artifact' };
                                        console.log('[HereticExtractionZone] Lose condition - heretic extraction successful');
                                }
                                window.state.isFrozen = true;
                        } else {
                                window.state.extractionEnd = { type: 'lose', reason: 'The artifact was left behind' };
                                console.log('[HereticExtractionZone] Lose condition - artifact or player not in zone');
                        }
                } catch(e) {
                        console.error('[HereticExtractionZone] Error checking win condition:', e);
                }
        }

        draw(ctx, camera, player) {
                if (!this.visible) return;
                const half = this.size / 2;
                const sx = Math.round(this.x - half - camera.x) + 0.5;
                const sy = Math.round(this.y - half - camera.y) + 0.5;
                // Dotted red outline square
                ctx.save();
                ctx.setLineDash([10, 8]);
                ctx.lineWidth = 4;
                ctx.strokeStyle = '#ff4d4d';
                ctx.beginPath();
                ctx.rect(sx, sy, Math.round(this.size), Math.round(this.size));
                ctx.stroke();
                ctx.setLineDash([]);
                // Label at top center
                const labelX = sx + Math.round(this.size / 2);
                const labelY = sy - 14;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'bottom';
                ctx.font = 'bold 16px sans-serif';
                ctx.fillStyle = 'rgba(0,0,0,0.6)';
                ctx.fillText('Heretic Extraction Zone', labelX + 1, labelY + 1);
                ctx.fillStyle = '#ff9a9a';
                ctx.fillText('Heretic Extraction Zone', labelX, labelY);
                ctx.restore();

                // Center red box
                const cx = Math.round(this.x - camera.x);
                const cy = Math.round(this.y - camera.y);
                const boxW = 42, boxH = 42;
                ctx.save();
                ctx.fillStyle = '#ff4d4d';
                ctx.strokeStyle = '#8a1f1f';
                ctx.lineWidth = 3;
                ctx.beginPath();
                ctx.rect(cx - Math.floor(boxW / 2), cy - Math.floor(boxH / 2), boxW, boxH);
                ctx.fill();
                ctx.stroke();
                ctx.restore();

                // Tooltip
                if (!this.started && !this.extracted && this._isPlayerNearCenter(player)) {
                        const converted = (typeof window !== 'undefined' && window.__killThemAllLocked === true);
                        const tip = converted ? 'Press E to betray and extract' : 'Only the converted can use this';
                        ctx.save();
                        ctx.textAlign = 'center';
                        ctx.textBaseline = 'bottom';
                        ctx.font = '14px sans-serif';
                        ctx.fillStyle = 'rgba(0,0,0,0.6)';
                        ctx.fillText(tip, cx + 1, cy - Math.floor(boxH / 2) - 12 + 1);
                        ctx.fillStyle = '#ffffff';
                        ctx.fillText(tip, cx, cy - Math.floor(boxH / 2) - 12);
                        ctx.restore();
                }

                // Progress bar
                if (this.started) {
                        const total = Math.max(1, this.timeTotal || 60);
                        const label = `Stealing in ${Math.round(total)} seconds`;
                        const timeLeft = Math.max(0, this.timeLeft || 0);
                        const frac = Math.max(0, Math.min(1, 1 - (timeLeft / Math.max(0.0001, this.timeTotal || 1))));
                        const barW = 160, barH = 14;
                        const bx = cx;
                        const by = cy - Math.floor(boxH / 2) - 24;
                        ctx.save();
                        ctx.textAlign = 'center';
                        ctx.textBaseline = 'bottom';
                        ctx.font = '14px sans-serif';
                        ctx.fillStyle = 'rgba(0,0,0,0.6)';
                        ctx.fillText(label, bx + 1, by - 18 + 1);
                        ctx.fillStyle = '#ffffff';
                        ctx.fillText(label, bx, by - 18);
                        ctx.fillStyle = 'rgba(255,255,255,0.12)';
                        ctx.fillRect(bx - barW / 2, by - barH / 2, barW, barH);
                        ctx.fillStyle = '#ff9a9a';
                        ctx.fillRect(bx - barW / 2, by - barH / 2, Math.round(barW * frac), barH);
                        ctx.lineWidth = 2;
                        ctx.strokeStyle = 'rgba(0,0,0,0.6)';
                        ctx.strokeRect(Math.round(bx - barW / 2) + 0.5, Math.round(by - barH / 2) + 0.5, barW, barH);
                        const tlabel = `${timeLeft.toFixed(1)}s`;
                        ctx.fillStyle = 'rgba(0,0,0,0.6)';
                        ctx.fillText(tlabel, bx + 1, by + barH + 4 + 1);
                        ctx.fillStyle = '#ffffff';
                        ctx.fillText(tlabel, bx, by + barH + 4);
                        ctx.restore();
                }
        }
}

class ReadyZone {
        constructor(x, y, size = 300) {
                this.x = x;
                this.y = y;
                this.size = size;
                this.visible = true;
                this.started = false;
                this.completed = false;
                this.timeTotal = 10.0;
                this.timeLeft = 0;
        }

        _isPlayerNearCenter(player) {
                if (!player) return false;
                const dx = (player.x || 0) - this.x;
                const dy = (player.y || 0) - this.y;
                const r = (player.radius || 26) + 40;
                return (dx * dx + dy * dy) <= r * r;
        }

	_getPlayersList() {
		// In multiplayer, get all players (local + remote)
		try {
			if (window.networkManager && window.networkManager.connected) {
				const allPlayers = [];
				// Add local player
				if (window.player) allPlayers.push(window.player);
				// Add remote players
				if (window.networkManager.otherPlayers) {
					for (const [id, otherPlayer] of window.networkManager.otherPlayers) {
						if (otherPlayer && typeof otherPlayer.x === 'number' && typeof otherPlayer.y === 'number') {
							allPlayers.push(otherPlayer);
						}
					}
				}
				return allPlayers;
			}
		} catch(e) {
			console.error('[ReadyZone] Error getting players list:', e);
		}
		// Fallback to single player
		try { if (window.player) return [window.player]; } catch(_) {}
		return [];
	}

        _areAllPlayersInZone() {
                const players = this._getPlayersList();
                if (!players || players.length === 0) return false;
                const half = this.size / 2;
                for (let i = 0; i < players.length; i++) {
                        const p = players[i];
                        if (!p) return false;
                        if (!(p.x >= this.x - half && p.x <= this.x + half && p.y >= this.y - half && p.y <= this.y + half)) return false;
                }
                return true;
        }

        tryStart(player, requestStart) {
                if (this.started || this.completed) return;
                if (!requestStart) return;
                if (!this._isPlayerNearCenter(player)) return;
                if (!this._areAllPlayersInZone()) return;
                
                // Request server to start the timer instead of starting locally
                try {
                        if (window.networkManager && window.networkManager.connected) {
                                window.networkManager.startReadyTimer();
                        } else {
                                // Fallback for single player mode
                                this.started = true;
                                this.timeLeft = this.timeTotal;
                        }
                } catch(e) {
                        console.error('[ReadyZone] Error requesting timer start:', e);
                        // Fallback to local timer
                        this.started = true;
                        this.timeLeft = this.timeTotal;
                }
        }

        update(dt) {
                // In multiplayer, timer state comes from server via syncFromServer()
                // Only handle local countdown for single-player fallback
                if (window.networkManager && window.networkManager.connected) {
                        // Server handles timer logic; just check if all players left zone to cancel
                        if (this.started && !this._areAllPlayersInZone()) {
                                try {
                                        window.networkManager.cancelReadyTimer();
                                } catch(e) {
                                        console.error('[ReadyZone] Error cancelling timer:', e);
                                }
                        }
                        return;
                }
                
                // Single-player fallback: local timer logic
                if (!this.started || this.completed) return;
                if (!this._areAllPlayersInZone()) {
                        this.started = false;
                        this.timeLeft = 0;
                        return;
                }
                this.timeLeft -= dt;
                if (this.timeLeft <= 0) {
                        this.timeLeft = 0;
                        this.started = false;
                        this.completed = true;
                        try { if (typeof window.startLevelFromLobby === 'function') window.startLevelFromLobby(); } catch(_) {}
                }
        }
        
        syncFromServer(serverData) {
                // Synchronize timer state from server
                this.started = serverData.started;
                this.timeLeft = serverData.timeLeft;
                this.timeTotal = serverData.timeTotal;
                // Quiet: avoid per-frame console spam
        }

        draw(ctx, camera, player) {
                if (!this.visible) return;
                const half = this.size / 2;
                const sx = Math.round(this.x - half - camera.x) + 0.5;
                const sy = Math.round(this.y - half - camera.y) + 0.5;
                ctx.save();
                ctx.setLineDash([10, 8]);
                ctx.lineWidth = 4;
                ctx.strokeStyle = '#4da3ff';
                ctx.beginPath();
                ctx.rect(sx, sy, Math.round(this.size), Math.round(this.size));
                ctx.stroke();
                ctx.setLineDash([]);
                const labelX = sx + Math.round(this.size / 2);
                const labelY = sy - 14;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'bottom';
                ctx.font = 'bold 16px sans-serif';
                ctx.fillStyle = 'rgba(0,0,0,0.6)';
                ctx.fillText('Ready to Deploy', labelX + 1, labelY + 1);
		ctx.fillStyle = '#8af7ff';
		ctx.fillText('Ready to Deploy', labelX, labelY);
		ctx.restore();

		// Display SERVER-AUTHORITATIVE level selection (all players see the same)
		const selectedLevel = (typeof window !== 'undefined' && window.serverLevelType) 
			? window.serverLevelType 
			: 'extraction'; // default to extraction
		
	let levelText = 'Mission: Extraction';
	if (selectedLevel === 'test') {
		levelText = 'Mission: Test Level';
	} else if (selectedLevel === 'payload') {
		levelText = 'Mission: Payload Escort';
	} else if (selectedLevel === 'trenchraid') {
		levelText = 'Mission: Trench Raid';
	} else if (selectedLevel === 'extraction') {
		levelText = 'Mission: Extraction';
	}
		
		// Draw level text below the dotted box, centered, same font and scale
		const levelTextY = sy + Math.round(this.size) + 24;
		ctx.save();
		ctx.textAlign = 'center';
		ctx.textBaseline = 'top';
		ctx.font = 'bold 16px sans-serif';
		ctx.fillStyle = 'rgba(0,0,0,0.6)';
		ctx.fillText(levelText, labelX + 1, levelTextY + 1);
		ctx.fillStyle = '#8af7ff';
		ctx.fillText(levelText, labelX, levelTextY);
		ctx.restore();

		const cx = Math.round(this.x - camera.x);
		const cy = Math.round(this.y - camera.y);
		const boxW = 42, boxH = 42;
                ctx.save();
                ctx.fillStyle = '#4da3ff';
                ctx.strokeStyle = '#1f4d8a';
                ctx.lineWidth = 3;
                ctx.beginPath();
                ctx.rect(cx - Math.floor(boxW / 2), cy - Math.floor(boxH / 2), boxW, boxH);
                ctx.fill();
                ctx.stroke();
                ctx.restore();

                if (!this.started && this._isPlayerNearCenter(player)) {
                        ctx.save();
                        ctx.textAlign = 'center';
                        ctx.textBaseline = 'bottom';
                        ctx.font = '14px sans-serif';
                        const allIn = this._areAllPlayersInZone();
                        const tip = allIn ? 'Press E to deploy' : 'All players must be inside the zone';
                        ctx.fillStyle = 'rgba(0,0,0,0.6)';
                        ctx.fillText(tip, cx + 1, cy - Math.floor(boxH / 2) - 12 + 1);
                        ctx.fillStyle = '#ffffff';
                        ctx.fillText(tip, cx, cy - Math.floor(boxH / 2) - 12);
                        ctx.restore();
                }

                // Progress bar when deploying
                if (this.started) {
                        const label = 'Deploying in 10 seconds';
                        const timeLeft = Math.max(0, this.timeLeft || 0);
                        const frac = Math.max(0, Math.min(1, 1 - (timeLeft / Math.max(0.0001, this.timeTotal || 1))));
                        const barW = 160, barH = 14;
                        const bx = cx;
                        const by = cy - Math.floor(boxH / 2) - 24;
                        ctx.save();
                        ctx.textAlign = 'center';
                        ctx.textBaseline = 'bottom';
                        ctx.font = '14px sans-serif';
                        ctx.fillStyle = 'rgba(0,0,0,0.6)';
                        ctx.fillText(label, bx + 1, by - 18 + 1);
                        ctx.fillStyle = '#ffffff';
                        ctx.fillText(label, bx, by - 18);
                        // Bar background
                        ctx.fillStyle = 'rgba(255,255,255,0.12)';
                        ctx.fillRect(bx - barW / 2, by - barH / 2, barW, barH);
                        // Fill
                        ctx.fillStyle = '#8af7ff';
                        ctx.fillRect(bx - barW / 2, by - barH / 2, Math.round(barW * frac), barH);
                        // Stroke
                        ctx.lineWidth = 2;
                        ctx.strokeStyle = 'rgba(0,0,0,0.6)';
                        ctx.strokeRect(Math.round(bx - barW / 2) + 0.5, Math.round(by - barH / 2) + 0.5, barW, barH);
                        // Countdown text
                        const tlabel = `${timeLeft.toFixed(1)}s`;
                        ctx.fillStyle = 'rgba(0,0,0,0.6)';
                        ctx.fillText(tlabel, bx + 1, by + barH + 4 + 1);
                        ctx.fillStyle = '#ffffff';
                        ctx.fillText(tlabel, bx, by + barH + 4);
                        ctx.restore();
                }
        }
}

class Ducat {
	constructor(x, y, amount = 1) {
		this.x = x;
		this.y = y;
		this.amount = amount;
		this.radius = 8;
		this.type = 'ducat';
		this.magnetRadius = 188; // Auto-pickup radius (increased by 25%)
		this.attracting = false;
		this.attractTarget = null;
		this.attractSpeed = 200; // Starting speed in pixels per second
		this.currentSpeed = 200; // Current movement speed
		this.attractAcceleration = 800; // Acceleration in pixels per second squared
		this.pickupLockout = 0.15; // Prevent immediate pickup
		this.bobTime = Math.random() * Math.PI * 2;
		this.spinTime = Math.random() * Math.PI * 2;
	}

	update(dt, players) {
		if (this.pickupLockout > 0) {
			this.pickupLockout -= dt;
			if (this.pickupLockout < 0) this.pickupLockout = 0;
		}
		
		// Bob animation
		this.bobTime += dt * 2;
		this.spinTime += dt * 4;
		
		// Magnet attraction to nearest player
		if (!this.attracting && this.pickupLockout <= 0) {
			let nearest = null;
			let nearestDist = this.magnetRadius;
			
			// Check all players (local + remote in multiplayer)
			const allPlayers = [];
			if (window.player) allPlayers.push(window.player);
			if (window.networkManager && window.networkManager.otherPlayers) {
				for (const [id, p] of window.networkManager.otherPlayers) {
					if (p) allPlayers.push(p);
				}
			}
			
			for (let i = 0; i < allPlayers.length; i++) {
				const p = allPlayers[i];
				if (!p || (p.health !== undefined && p.health <= 0)) continue;
				const dx = p.x - this.x;
				const dy = p.y - this.y;
				const dist = Math.hypot(dx, dy);
				if (dist < nearestDist) {
					nearestDist = dist;
					nearest = p;
				}
			}
			
			if (nearest) {
				this.attracting = true;
				this.attractTarget = nearest;
				this.currentSpeed = this.attractSpeed; // Reset speed when starting attraction
			}
		}
		
		// Move toward target with constant acceleration
		if (this.attracting && this.attractTarget) {
			const target = this.attractTarget;
			const dx = target.x - this.x;
			const dy = target.y - this.y;
			const dist = Math.hypot(dx, dy);
			
			if (dist < (target.radius || 26) + this.radius + 10) {
				// Close enough - will be picked up by collision check
				return;
			}
			
			// Accelerate constantly until picked up
			this.currentSpeed += this.attractAcceleration * dt;
			
			const moveAmount = Math.min(this.currentSpeed * dt, dist);
			this.x += (dx / dist) * moveAmount;
			this.y += (dy / dist) * moveAmount;
		}
	}

	draw(ctx, camera) {
		const sx = this.x - camera.x;
		const sy = this.y - camera.y + Math.sin(this.bobTime) * 3;
		
		ctx.save();
		ctx.translate(sx, sy);
		
		// Rotate for 3D coin effect
		const angle = Math.sin(this.spinTime) * 0.3;
		ctx.scale(Math.cos(angle), 1);
		
		// Gold coin with pixel art style
		const r = 10;
		
		// Outer gold ring
		ctx.fillStyle = '#d4af37';
		ctx.beginPath();
		ctx.arc(0, 0, r, 0, Math.PI * 2);
		ctx.fill();
		
		// Darker gold outline
		ctx.strokeStyle = '#8a6d1f';
		ctx.lineWidth = 2;
		ctx.stroke();
		
		// Inner circle (slightly lighter)
		ctx.fillStyle = '#f4cf47';
		ctx.beginPath();
		ctx.arc(0, 0, r - 3, 0, Math.PI * 2);
		ctx.fill();
		
		// Glint
		ctx.fillStyle = 'rgba(255, 255, 200, 0.6)';
		ctx.beginPath();
		ctx.arc(-2, -2, 3, 0, Math.PI * 2);
		ctx.fill();
		
		ctx.restore();
		
		// Amount label below coin
		if (this.amount > 1) {
			ctx.save();
			ctx.font = 'bold 11px monospace';
			ctx.textAlign = 'center';
			ctx.textBaseline = 'top';
			ctx.fillStyle = 'rgba(0,0,0,0.6)';
			ctx.fillText(`×${this.amount}`, sx + 1, sy + r + 3 + 1);
			ctx.fillStyle = '#ffd36b';
			ctx.fillText(`×${this.amount}`, sx, sy + r + 3);
			ctx.restore();
		}
	}
}

class BloodMarker {
	constructor(x, y, amount = 1) {
		this.x = x;
		this.y = y;
		this.amount = amount;
		this.radius = 8;
		this.type = 'bloodMarker';
		this.magnetRadius = 188; // Auto-pickup radius (increased by 25%)
		this.attracting = false;
		this.attractTarget = null;
		this.attractSpeed = 200; // Starting speed in pixels per second
		this.currentSpeed = 200; // Current movement speed
		this.attractAcceleration = 800; // Acceleration in pixels per second squared
		this.pickupLockout = 0.15; // Prevent immediate pickup
		this.bobTime = Math.random() * Math.PI * 2;
		this.pulseTime = Math.random() * Math.PI * 2;
	}

	update(dt, players) {
		if (this.pickupLockout > 0) {
			this.pickupLockout -= dt;
			if (this.pickupLockout < 0) this.pickupLockout = 0;
		}
		
		// Bob animation
		this.bobTime += dt * 2;
		this.pulseTime += dt * 3;
		
		// Magnet attraction to nearest player
		if (!this.attracting && this.pickupLockout <= 0) {
			let nearest = null;
			let nearestDist = this.magnetRadius;
			
			// Check all players (local + remote in multiplayer)
			const allPlayers = [];
			if (window.player) allPlayers.push(window.player);
			if (window.networkManager && window.networkManager.otherPlayers) {
				for (const [id, p] of window.networkManager.otherPlayers) {
					if (p) allPlayers.push(p);
				}
			}
			
			for (let i = 0; i < allPlayers.length; i++) {
				const p = allPlayers[i];
				if (!p || (p.health !== undefined && p.health <= 0)) continue;
				const dx = p.x - this.x;
				const dy = p.y - this.y;
				const dist = Math.hypot(dx, dy);
				if (dist < nearestDist) {
					nearestDist = dist;
					nearest = p;
				}
			}
			
			if (nearest) {
				this.attracting = true;
				this.attractTarget = nearest;
				this.currentSpeed = this.attractSpeed; // Reset speed when starting attraction
			}
		}
		
		// Move toward target with constant acceleration
		if (this.attracting && this.attractTarget) {
			const target = this.attractTarget;
			const dx = target.x - this.x;
			const dy = target.y - this.y;
			const dist = Math.hypot(dx, dy);
			
			if (dist < (target.radius || 26) + this.radius + 10) {
				// Close enough - will be picked up by collision check
				return;
			}
			
			// Accelerate constantly until picked up
			this.currentSpeed += this.attractAcceleration * dt;
			
			const moveAmount = Math.min(this.currentSpeed * dt, dist);
			this.x += (dx / dist) * moveAmount;
			this.y += (dy / dist) * moveAmount;
		}
	}

	draw(ctx, camera) {
		const sx = this.x - camera.x;
		const sy = this.y - camera.y + Math.sin(this.bobTime) * 3;
		const pulse = 0.9 + Math.sin(this.pulseTime) * 0.1;
		
		ctx.save();
		ctx.translate(sx, sy);
		
		// Blood drop shape (proper teardrop - thin top, fat rounded bottom)
		const h = 16 * pulse; // Height of drop (increased from 14)
		const w = 12 * pulse; // Width at widest point (increased from 10)
		
		// Outer glow
		ctx.shadowColor = 'rgba(139, 0, 0, 0.6)';
		ctx.shadowBlur = 12;
		
		// Draw improved teardrop shape
		ctx.fillStyle = '#8b0000';
		ctx.beginPath();
		// Start at very top (thin point)
		ctx.moveTo(0, -h/2);
		// Right side curves - gentle curve at top, wider at bottom
		ctx.bezierCurveTo(w/3, -h/3, w/2, -h/8, w/2, h/6);
		// Bottom right curve (fat rounded part)
		ctx.bezierCurveTo(w/2, h/3, w/3, h/2.2, 0, h/2);
		// Bottom left curve (fat rounded part)
		ctx.bezierCurveTo(-w/3, h/2.2, -w/2, h/3, -w/2, h/6);
		// Left side curves back to top
		ctx.bezierCurveTo(-w/2, -h/8, -w/3, -h/3, 0, -h/2);
		ctx.fill();
		
		// Inner highlight (top area of drop)
		ctx.shadowBlur = 0;
		ctx.fillStyle = '#c41e1e';
		ctx.beginPath();
		ctx.arc(-1.5, -h/5, 2.5, 0, Math.PI * 2);
		ctx.fill();
		
		// Dark outline
		ctx.strokeStyle = '#3b0000';
		ctx.lineWidth = 2;
		ctx.beginPath();
		ctx.moveTo(0, -h/2);
		ctx.bezierCurveTo(w/3, -h/3, w/2, -h/8, w/2, h/6);
		ctx.bezierCurveTo(w/2, h/3, w/3, h/2.2, 0, h/2);
		ctx.bezierCurveTo(-w/3, h/2.2, -w/2, h/3, -w/2, h/6);
		ctx.bezierCurveTo(-w/2, -h/8, -w/3, -h/3, 0, -h/2);
		ctx.stroke();
		
		ctx.restore();
		
		// Amount label below marker
		if (this.amount > 1) {
			ctx.save();
			ctx.font = 'bold 11px monospace';
			ctx.textAlign = 'center';
			ctx.textBaseline = 'top';
			ctx.fillStyle = 'rgba(0,0,0,0.6)';
			ctx.fillText(`×${this.amount}`, sx + 1, sy + h/2 + 3 + 1);
			ctx.fillStyle = '#ff5a5a';
			ctx.fillText(`×${this.amount}`, sx, sy + h/2 + 3);
			ctx.restore();
		}
	}
}

// Battery - WW1/WW2 style military field radio battery
class Battery {
	constructor(x, y, id, options = {}) {
		this.x = x;
		this.y = y;
		this.id = id;
		this.radius = 15;
		this.carriedBy = null;      // playerId if being carried
		this.slotIndex = null;      // 0,1,2 if placed in station slot
		this.onGround = true;
		this.pickupLockout = 0.3;   // Brief delay before pickup
		this.bobTime = Math.random() * Math.PI * 2;
		this.pulseTime = Math.random() * Math.PI * 2;
	}
	
	canPickUp(player) {
		if (!player || this.carriedBy) return false;
		if (!this.onGround) return false;
		if (this.slotIndex !== null) return false;  // Already placed in slot
		if (this.pickupLockout > 0) return false;
		const dx = player.x - this.x;
		const dy = player.y - this.y;
		const r = (player.radius || 26) + this.radius + 40;
		return (dx * dx + dy * dy) <= r * r;
	}
	
	update(dt, player, aimAngle) {
		if (this.pickupLockout > 0) {
			this.pickupLockout -= dt;
			if (this.pickupLockout < 0) this.pickupLockout = 0;
		}
		
		// Animation timers
		this.bobTime += dt * 2;
		this.pulseTime += dt * 3;
		
		// Follow carrier if being carried
		if (this.carriedBy && player && this.carriedBy === window.networkManager?.playerId) {
			const backAng = (typeof aimAngle === 'number') ? (aimAngle + Math.PI) : Math.PI;
			const dist = (player.radius || 26) + 20;
			this.x = player.x + Math.cos(backAng) * dist;
			this.y = player.y + Math.sin(backAng) * dist;
			this.onGround = false;
		}
	}
	
	draw(ctx, camera, player) {
		// Don't draw if placed in slot (station draws it)
		if (this.slotIndex !== null) return;
		
		// Don't draw if carried by remote player (they render it)
		if (this.carriedBy && this.carriedBy !== window.networkManager?.playerId) return;
		
		const sx = this.x - camera.x;
		const sy = this.y - camera.y + (this.onGround ? Math.sin(this.bobTime) * 3 : 0);
		
		ctx.save();
		ctx.translate(sx, sy);
		
		// WW2 Military battery dimensions (boxy, heavy)
		const w = 28;
		const h = 38;
		
		// Colors - olive drab military style
		const oliveDrab = '#4a4a32';
		const oliveDark = '#3a3a28';
		const oliveDarker = '#2a2a1c';
		const rust = '#6b4423';
		const rustDark = '#4a2f18';
		const metalGray = '#5a5a5a';
		const metalDark = '#3a3a3a';
		
		// Shadow underneath
		ctx.fillStyle = 'rgba(0,0,0,0.3)';
		ctx.fillRect(-w/2 + 2, h/2 - 2, w, 4);
		
		// Main battery body (olive drab metal box)
		ctx.fillStyle = oliveDrab;
		ctx.fillRect(-w/2, -h/2, w, h);
		
		// Darker side panel (depth effect)
		ctx.fillStyle = oliveDark;
		ctx.fillRect(-w/2, -h/2, 4, h);
		
		// Top plate (slightly lighter)
		ctx.fillStyle = '#5a5a42';
		ctx.fillRect(-w/2, -h/2, w, 8);
		
		// Metal terminals on top (two posts)
		ctx.fillStyle = metalGray;
		ctx.fillRect(-8, -h/2 - 6, 6, 8);
		ctx.fillRect(2, -h/2 - 6, 6, 8);
		
		// Red terminal with bright pulsing glow (indicates power - highly visible)
		const redPulse = 0.6 + Math.sin(this.pulseTime * 2) * 0.4;
		const glowSize = 18 + Math.sin(this.pulseTime * 2) * 8;
		
		// Outer glow halo for visibility
		ctx.shadowColor = `rgba(255, 40, 40, ${redPulse})`;
		ctx.shadowBlur = glowSize;
		
		// Larger red light base
		ctx.fillStyle = '#cc0000';
		ctx.beginPath();
		ctx.arc(-5, -h/2 - 6, 5, 0, Math.PI * 2);
		ctx.fill();
		
		// Bright pulsing center
		ctx.fillStyle = `rgba(255, 80, 80, ${0.7 + Math.sin(this.pulseTime * 2) * 0.3})`;
		ctx.beginPath();
		ctx.arc(-5, -h/2 - 6, 3.5, 0, Math.PI * 2);
		ctx.fill();
		
		// Hot white core
		ctx.fillStyle = `rgba(255, 200, 200, ${0.5 + Math.sin(this.pulseTime * 2) * 0.4})`;
		ctx.beginPath();
		ctx.arc(-5, -h/2 - 6, 2, 0, Math.PI * 2);
		ctx.fill();
		
		ctx.shadowBlur = 0;
		
		// Black terminal (no glow)
		ctx.fillStyle = '#1a1a1a';
		ctx.fillRect(3, -h/2 - 8, 4, 4);
		
		// Horizontal ridges (reinforcement bands)
		ctx.fillStyle = oliveDarker;
		ctx.fillRect(-w/2, -h/4 - 2, w, 4);
		ctx.fillRect(-w/2, h/4 - 2, w, 4);
		
		// Rust/weathering patches
		ctx.fillStyle = rust;
		ctx.globalAlpha = 0.5;
		ctx.fillRect(-w/2, h/2 - 8, 8, 6);
		ctx.fillRect(w/2 - 10, -h/4, 8, 10);
		ctx.fillRect(-w/2 + 3, -h/2 + 10, 5, 8);
		ctx.globalAlpha = 1.0;
		
		// Stenciled marking (worn)
		ctx.fillStyle = '#2a2a1c';
		ctx.globalAlpha = 0.6;
		ctx.font = 'bold 8px monospace';
		ctx.textAlign = 'center';
		ctx.textBaseline = 'middle';
		ctx.fillText('PWR', 0, 0);
		ctx.globalAlpha = 1.0;
		
		// Handle on top (carrying strap attachment)
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
		
		// Tooltip when close and on ground
		if (this.onGround && !this.carriedBy && player) {
			const dx = player.x - this.x;
			const dy = player.y - this.y;
			const r2 = Math.pow((player.radius || 26) + this.radius + 40, 2);
			if (dx * dx + dy * dy <= r2) {
				ctx.save();
				ctx.textAlign = 'center';
				ctx.textBaseline = 'bottom';
				ctx.font = '14px sans-serif';
				ctx.fillStyle = 'rgba(0,0,0,0.6)';
				ctx.fillText('Press E to pick up Battery', sx + 1, sy - 28 + 1);
				ctx.fillStyle = '#ffffff';
				ctx.fillText('Press E to pick up Battery', sx, sy - 28);
				ctx.restore();
			}
		}
	}
}

// BatteryStation - WW1/WW2 style military power junction box
class BatteryStation {
	constructor(x, y, radioTowerX, radioTowerY, options = {}) {
		this.x = x;
		this.y = y;
		this.radioTowerX = radioTowerX;
		this.radioTowerY = radioTowerY;
		
		// Cable endpoints (from RadioTower base to station)
		this.cableStartX = radioTowerX;
		this.cableStartY = radioTowerY + 140;  // Bottom of RadioTower
		this.cableEndX = x + 80;  // Right side of station
		this.cableEndY = y;
		
		// Slot states (false = empty, true = filled)
		this.slots = [false, false, false];
		this.slotWidth = 34;
		this.slotHeight = 48;
		this.slotSpacing = 44;
		
		this.isPowered = false;
		this.powerTime = 0;  // For blinking animation
	}
	
	getSlotPosition(index) {
		// Slots arranged horizontally
		const totalWidth = (this.slotWidth + this.slotSpacing) * 2 + this.slotWidth;
		const startX = this.x - totalWidth / 2 + this.slotWidth / 2;
		return {
			x: startX + index * (this.slotWidth + this.slotSpacing),
			y: this.y + 5
		};
	}
	
	canPlaceBattery(player, slotIndex) {
		if (!player) return false;
		if (slotIndex < 0 || slotIndex > 2) return false;
		if (this.slots[slotIndex]) return false;  // Already filled
		
		const slotPos = this.getSlotPosition(slotIndex);
		const dx = player.x - slotPos.x;
		const dy = player.y - slotPos.y;
		const r = (player.radius || 26) + 50;
		return (dx * dx + dy * dy) <= r * r;
	}
	
	getFirstEmptySlotNearPlayer(player) {
		if (!player) return -1;
		for (let i = 0; i < 3; i++) {
			if (!this.slots[i] && this.canPlaceBattery(player, i)) {
				return i;
			}
		}
		return -1;
	}
	
	isPlayerNearStation(player) {
		if (!player) return false;
		const dx = player.x - this.x;
		const dy = player.y - this.y;
		const r = (player.radius || 26) + 100;
		return (dx * dx + dy * dy) <= r * r;
	}
	
	update(dt) {
		// Check if all slots are filled
		const wasPowered = this.isPowered;
		this.isPowered = this.slots[0] && this.slots[1] && this.slots[2];
		
		// Count filled slots for progressive effects
		this.filledCount = (this.slots[0] ? 1 : 0) + (this.slots[1] ? 1 : 0) + (this.slots[2] ? 1 : 0);
		
		// Always update powerTime when any battery is inserted (for pulsing)
		if (this.filledCount > 0) {
			this.powerTime += dt;
		}
		
		// Just became powered - trigger artillery bonus (single-player only)
		if (!wasPowered && this.isPowered && !window.isMultiplayer) {
			// Add artillery bonus in single-player
			if (window.clientGameMode && typeof window.clientGameMode.addArtilleryBonus === 'function') {
				const bonusSeconds = window.clientGameMode.addArtilleryBonus(150, true); // 2.5 minutes or 1 min if overtime
				
				// Show notification using existing UI system
				if (window.ui && bonusSeconds > 0) {
					const mins = Math.floor(bonusSeconds / 60);
					const secs = Math.floor(bonusSeconds % 60);
					const timeStr = secs > 0 ? `${mins}:${secs.toString().padStart(2, '0')}` : `${mins}:00`;
					const wasOvertime = bonusSeconds === 60;
					const message = wasOvertime 
						? `Radio Tower Online! +${timeStr} Reprieve`
						: `Radio Tower Online! +${timeStr} Artillery Delay`;
					window.ui.showNotification(message, 4000);
				}
			}
		}
		
		return !wasPowered && this.isPowered;  // Return true if just became powered
	}
	
	draw(ctx, camera, player) {
		const sx = this.x - camera.x;
		const sy = this.y - camera.y;
		
		// Colors - industrial military style matching the RadioTower
		const metalDark = '#3a3a3a';
		const metalMed = '#5a5a5a';
		const metalLight = '#6a6a6a';
		const rust = '#6b4423';
		const rustDark = '#4a2f18';
		const oliveDrab = '#4a4a32';
		const oliveDark = '#3a3a28';
		
		// Draw cable from RadioTower base to station
		this._drawCable(ctx, camera);
		
		ctx.save();
		
		// Station base dimensions
		const baseW = 180;
		const baseH = 85;
		
		// Shadow underneath
		ctx.fillStyle = 'rgba(0,0,0,0.4)';
		ctx.fillRect(sx - baseW/2 + 4, sy + baseH/2 - 4, baseW, 8);
		
		// Main housing (heavy industrial metal box)
		ctx.fillStyle = metalDark;
		ctx.fillRect(sx - baseW/2, sy - baseH/2, baseW, baseH);
		
		// Top panel (slightly angled look)
		ctx.fillStyle = metalMed;
		ctx.fillRect(sx - baseW/2, sy - baseH/2, baseW, 12);
		
		// Side panels for depth
		ctx.fillStyle = '#2a2a2a';
		ctx.fillRect(sx - baseW/2, sy - baseH/2, 6, baseH);
		ctx.fillRect(sx + baseW/2 - 6, sy - baseH/2, 6, baseH);
		
		// Reinforcement frame (welded metal strips)
		ctx.strokeStyle = metalLight;
		ctx.lineWidth = 3;
		ctx.strokeRect(sx - baseW/2 + 3, sy - baseH/2 + 3, baseW - 6, baseH - 6);
		
		// Rivets along top edge
		ctx.fillStyle = metalLight;
		for (let i = 0; i < 7; i++) {
			const rx = sx - baseW/2 + 15 + i * 25;
			ctx.beginPath();
			ctx.arc(rx, sy - baseH/2 + 6, 3, 0, Math.PI * 2);
			ctx.fill();
		}
		
		// Rivets along bottom edge
		for (let i = 0; i < 7; i++) {
			const rx = sx - baseW/2 + 15 + i * 25;
			ctx.beginPath();
			ctx.arc(rx, sy + baseH/2 - 6, 3, 0, Math.PI * 2);
			ctx.fill();
		}
		
		// Rust/weathering patches
		ctx.fillStyle = rust;
		ctx.globalAlpha = 0.4;
		ctx.fillRect(sx - baseW/2 + 8, sy + baseH/2 - 20, 25, 15);
		ctx.fillRect(sx + baseW/2 - 35, sy - baseH/2 + 15, 20, 25);
		ctx.fillRect(sx - 20, sy + baseH/2 - 12, 15, 8);
		ctx.globalAlpha = 1.0;
		
		// Stenciled label (worn military markings)
		ctx.fillStyle = oliveDrab;
		ctx.globalAlpha = 0.7;
		ctx.font = 'bold 10px monospace';
		ctx.textAlign = 'center';
		ctx.textBaseline = 'middle';
		ctx.fillText('PWR SUPPLY', sx, sy - baseH/2 + 22);
		ctx.globalAlpha = 1.0;
		
		// Draw 3 battery slots
		for (let i = 0; i < 3; i++) {
			const slotPos = this.getSlotPosition(i);
			const slotX = slotPos.x - camera.x;
			const slotY = slotPos.y - camera.y;
			
			// Slot housing (recessed metal compartment)
			ctx.fillStyle = '#1a1a1a';
			ctx.fillRect(slotX - this.slotWidth/2 - 3, slotY - this.slotHeight/2 - 3, this.slotWidth + 6, this.slotHeight + 6);
			
			// Slot inner (darker recess)
			ctx.fillStyle = this.slots[i] ? '#2a2a20' : '#0a0a0a';
			ctx.fillRect(slotX - this.slotWidth/2, slotY - this.slotHeight/2, this.slotWidth, this.slotHeight);
			
			// Slot frame
			ctx.strokeStyle = this.slots[i] ? oliveDrab : '#333333';
			ctx.lineWidth = 2;
			ctx.strokeRect(slotX - this.slotWidth/2, slotY - this.slotHeight/2, this.slotWidth, this.slotHeight);
			
			// Contact prongs at bottom of slot
			ctx.fillStyle = this.slots[i] ? '#8b6914' : metalDark;
			ctx.fillRect(slotX - 8, slotY + this.slotHeight/2 - 8, 5, 8);
			ctx.fillRect(slotX + 3, slotY + this.slotHeight/2 - 8, 5, 8);
			
			// If slot is filled, draw battery inside (WW2 style)
			if (this.slots[i]) {
				const bw = 26;
				const bh = 36;
				
				// Battery body
				ctx.fillStyle = oliveDrab;
				ctx.fillRect(slotX - bw/2, slotY - bh/2 + 2, bw, bh);
				
				// Side shading
				ctx.fillStyle = oliveDark;
				ctx.fillRect(slotX - bw/2, slotY - bh/2 + 2, 3, bh);
				
				// Top plate
				ctx.fillStyle = '#5a5a42';
				ctx.fillRect(slotX - bw/2, slotY - bh/2 + 2, bw, 6);
				
				// Terminals
				ctx.fillStyle = '#8b0000';
				ctx.fillRect(slotX - 6, slotY - bh/2 - 2, 4, 6);
				ctx.fillStyle = '#1a1a1a';
				ctx.fillRect(slotX + 2, slotY - bh/2 - 2, 4, 6);
				
				// Reinforcement bands
				ctx.fillStyle = '#2a2a1c';
				ctx.fillRect(slotX - bw/2, slotY - 4, bw, 3);
				ctx.fillRect(slotX - bw/2, slotY + 8, bw, 3);
				
				// Rust
				ctx.fillStyle = rust;
				ctx.globalAlpha = 0.4;
				ctx.fillRect(slotX - bw/2, slotY + bh/2 - 8, 6, 5);
				ctx.globalAlpha = 1.0;
				
				// Pulsing warm glow - speed increases with more batteries
				// 1 battery = slow (1x), 2 batteries = medium (2x), 3 batteries = fast (3x)
				const filledCount = this.filledCount || 0;
				if (filledCount > 0) {
					const pulseSpeed = filledCount * 1.5;  // 1.5, 3.0, 4.5
					const pulse = 0.2 + Math.sin(this.powerTime * pulseSpeed) * 0.2;
					const glowIntensity = 0.2 + (filledCount / 3) * 0.4;  // Stronger glow with more batteries
					ctx.shadowColor = `rgba(255, 180, 50, ${pulse + glowIntensity})`;
					ctx.shadowBlur = 8 + filledCount * 3 + Math.sin(this.powerTime * pulseSpeed) * 3;
					ctx.strokeStyle = `rgba(255, 160, 40, ${pulse + glowIntensity})`;
					ctx.lineWidth = 2 + filledCount * 0.5;
					ctx.strokeRect(slotX - bw/2 - 1, slotY - bh/2 + 1, bw + 2, bh + 2);
					ctx.shadowBlur = 0;
				}
			} else {
				// Empty slot - show contact points
				ctx.fillStyle = '#333333';
				ctx.font = 'bold 12px monospace';
				ctx.textAlign = 'center';
				ctx.textBaseline = 'middle';
				ctx.fillText('[ ]', slotX, slotY);
			}
			
			// Slot number stencil
			ctx.fillStyle = '#555555';
			ctx.font = 'bold 9px monospace';
			ctx.textAlign = 'center';
			ctx.textBaseline = 'top';
			ctx.fillText(`${i + 1}`, slotX, slotY + this.slotHeight/2 + 6);
		}
		
		// Cable connection point on right side
		ctx.fillStyle = metalDark;
		ctx.fillRect(sx + baseW/2 - 4, sy - 8, 8, 16);
		ctx.fillStyle = '#1a1a1a';
		ctx.beginPath();
		ctx.arc(sx + baseW/2 + 2, sy, 4, 0, Math.PI * 2);
		ctx.fill();
		
		ctx.restore();
		
		// Tooltip when near and has empty slots
		if (player && this.isPlayerNearStation(player)) {
			const emptySlot = this.getFirstEmptySlotNearPlayer(player);
			// Check if player is carrying a battery
			let carryingBattery = false;
			const batteries = window._batteries || [];
			for (let i = 0; i < batteries.length; i++) {
				if (batteries[i].carriedBy === window.networkManager?.playerId) {
					carryingBattery = true;
					break;
				}
			}
			
			if (carryingBattery && emptySlot >= 0) {
				ctx.save();
				ctx.textAlign = 'center';
				ctx.textBaseline = 'bottom';
				ctx.font = '14px sans-serif';
				ctx.fillStyle = 'rgba(0,0,0,0.6)';
				ctx.fillText('Press E to place Battery', sx + 1, sy - baseH/2 - 10 + 1);
				ctx.fillStyle = '#ffffff';
				ctx.fillText('Press E to place Battery', sx, sy - baseH/2 - 10);
				ctx.restore();
			} else if (!this.isPowered && !carryingBattery) {
				const filledCount = this.slots.filter(s => s).length;
				ctx.save();
				ctx.textAlign = 'center';
				ctx.textBaseline = 'bottom';
				ctx.font = '14px sans-serif';
				ctx.fillStyle = 'rgba(0,0,0,0.6)';
				ctx.fillText(`Power Station (${filledCount}/3)`, sx + 1, sy - baseH/2 - 10 + 1);
				ctx.fillStyle = '#aaaaaa';
				ctx.fillText(`Power Station (${filledCount}/3)`, sx, sy - baseH/2 - 10);
				ctx.restore();
			}
		}
	}
	
	_drawCable(ctx, camera) {
		const startX = this.cableStartX - camera.x;
		const startY = this.cableStartY - camera.y;
		const endX = this.cableEndX - camera.x;
		const endY = this.cableEndY - camera.y;
		
		// Sagging cable curve control point
		const midX = (startX + endX) / 2;
		const midY = Math.max(startY, endY) + 50;  // Heavy sag for thick cable
		
		ctx.save();
		
		// Cable shadow on ground
		ctx.strokeStyle = 'rgba(0, 0, 0, 0.4)';
		ctx.lineWidth = 12;
		ctx.lineCap = 'round';
		ctx.beginPath();
		ctx.moveTo(startX + 3, startY + 4);
		ctx.quadraticCurveTo(midX + 3, midY + 4, endX + 3, endY + 4);
		ctx.stroke();
		
		// Outer cable jacket (thick rubber/cloth insulation - dark olive)
		ctx.strokeStyle = '#2a2a1c';
		ctx.lineWidth = 10;
		ctx.beginPath();
		ctx.moveTo(startX, startY);
		ctx.quadraticCurveTo(midX, midY, endX, endY);
		ctx.stroke();
		
		// Inner cable (dark core)
		ctx.strokeStyle = '#1a1a12';
		ctx.lineWidth = 6;
		ctx.beginPath();
		ctx.moveTo(startX, startY);
		ctx.quadraticCurveTo(midX, midY, endX, endY);
		ctx.stroke();
		
		// Cloth wrapping bands (old military style)
		ctx.strokeStyle = '#3a3a28';
		ctx.lineWidth = 10;
		ctx.setLineDash([6, 18]);
		ctx.beginPath();
		ctx.moveTo(startX, startY);
		ctx.quadraticCurveTo(midX, midY, endX, endY);
		ctx.stroke();
		ctx.setLineDash([]);
		
		// Worn/frayed sections
		ctx.strokeStyle = '#4a4a32';
		ctx.lineWidth = 8;
		ctx.setLineDash([2, 40]);
		ctx.lineDashOffset = 10;
		ctx.beginPath();
		ctx.moveTo(startX, startY);
		ctx.quadraticCurveTo(midX, midY, endX, endY);
		ctx.stroke();
		ctx.setLineDash([]);
		ctx.lineDashOffset = 0;
		
		// Connection point at RadioTower (metal clamp)
		ctx.fillStyle = '#3a3a3a';
		ctx.beginPath();
		ctx.arc(startX, startY, 10, 0, Math.PI * 2);
		ctx.fill();
		ctx.strokeStyle = '#2a2a2a';
		ctx.lineWidth = 3;
		ctx.stroke();
		// Bolt
		ctx.fillStyle = '#5a5a5a';
		ctx.beginPath();
		ctx.arc(startX, startY, 4, 0, Math.PI * 2);
		ctx.fill();
		
		// Connection point at station (metal clamp)
		ctx.fillStyle = '#3a3a3a';
		ctx.beginPath();
		ctx.arc(endX, endY, 10, 0, Math.PI * 2);
		ctx.fill();
		ctx.strokeStyle = '#2a2a2a';
		ctx.lineWidth = 3;
		ctx.stroke();
		// Bolt
		ctx.fillStyle = '#5a5a5a';
		ctx.beginPath();
		ctx.arc(endX, endY, 4, 0, Math.PI * 2);
		ctx.fill();
		
		// Progressive warm electric glow through cable based on battery count
		const filledCount = this.filledCount || 0;
		if (filledCount > 0) {
			// Pulse speed increases with more batteries
			const pulseSpeed = filledCount * 1.5;  // 1.5, 3.0, 4.5
			const pulse = 0.15 + Math.sin(this.powerTime * pulseSpeed) * 0.12;
			const glowIntensity = 0.1 + (filledCount / 3) * 0.25;
			
			ctx.strokeStyle = `rgba(255, 180, 50, ${pulse + glowIntensity})`;
			ctx.lineWidth = 3 + filledCount;
			ctx.lineCap = 'round';
			
			// Draw glow progressively along cable (from station toward tower)
			// 1 battery = 1/3 of cable, 2 = 2/3, 3 = full
			const progress = filledCount / 3;
			
			// Calculate points along the quadratic bezier curve
			// We'll draw from endX,endY (station) toward startX,startY (tower)
			ctx.beginPath();
			ctx.moveTo(endX, endY);
			
			// Draw segments along the curve up to the progress point
			const segments = 20;
			const targetSegment = Math.floor(segments * progress);
			for (let seg = 1; seg <= targetSegment; seg++) {
				const t = seg / segments;
				// Quadratic bezier: B(t) = (1-t)²P0 + 2(1-t)tP1 + t²P2
				// But we're going from end to start, so reverse
				const rt = 1 - t;  // reversed t
				const px = rt * rt * endX + 2 * rt * t * midX + t * t * startX;
				const py = rt * rt * endY + 2 * rt * t * midY + t * t * startY;
				ctx.lineTo(px, py);
			}
			ctx.stroke();
			
			// Add a glowing "energy front" at the progress point
			if (filledCount < 3) {
				const t = progress;
				const rt = 1 - t;
				const frontX = rt * rt * endX + 2 * rt * t * midX + t * t * startX;
				const frontY = rt * rt * endY + 2 * rt * t * midY + t * t * startY;
				
				// Pulsing energy orb at the front
				const orbPulse = 0.5 + Math.sin(this.powerTime * pulseSpeed * 2) * 0.3;
				ctx.beginPath();
				ctx.arc(frontX, frontY, 6 + Math.sin(this.powerTime * pulseSpeed) * 2, 0, Math.PI * 2);
				ctx.fillStyle = `rgba(255, 200, 80, ${orbPulse})`;
				ctx.shadowColor = 'rgba(255, 180, 50, 0.8)';
				ctx.shadowBlur = 12;
				ctx.fill();
				ctx.shadowBlur = 0;
			}
		}
		
		ctx.restore();
	}
}

// Radio Tower - Decorative cement cross with antennas and wires (New Antioch landmark)
class RadioTower {
	constructor(x, y, options = {}) {
		this.x = x;
		this.y = y;
		this.scale = options.scale || 1.0;
		
		// Cross dimensions (scaled)
		this.baseWidth = 60 * this.scale;  // Width of vertical beam
		this.baseHeight = 280 * this.scale; // Total height
		this.armWidth = 180 * this.scale;  // Total arm span
		this.armHeight = 50 * this.scale;  // Height of horizontal arm
		this.armY = -40 * this.scale;      // Y offset of arm from center (negative = up) - positioned lower for taller top
		
		// Power state (controlled by BatteryStation)
		this.isPowered = false;
		this.lightBlinkTime = 0;
		
		// Pre-generate random damage chunks (so they don't change each frame)
		this.damageChunks = this._generateDamageChunks();
		this.antennas = this._generateAntennas();
		this.wires = this._generateWires();
	}
	
	_generateDamageChunks() {
		const chunks = [];
		const rng = () => Math.random();
		
		// Add several damaged/broken chunks to edges
		// Top of cross
		chunks.push({ x: -12 + rng() * 24, y: -this.baseHeight/2 - 5, w: 15 + rng() * 20, h: 20 + rng() * 15, type: 'break' });
		chunks.push({ x: 8 + rng() * 10, y: -this.baseHeight/2 + 10, w: 12 + rng() * 10, h: 25, type: 'chip' });
		
		// Left arm tip
		chunks.push({ x: -this.armWidth/2 - 5, y: this.armY - 10 + rng() * 20, w: 25 + rng() * 15, h: 15 + rng() * 20, type: 'break' });
		chunks.push({ x: -this.armWidth/2 + 15, y: this.armY + this.armHeight/2 - 5, w: 20, h: 12 + rng() * 10, type: 'chip' });
		
		// Right arm tip  
		chunks.push({ x: this.armWidth/2 - 20 - rng() * 10, y: this.armY - 8 + rng() * 16, w: 28 + rng() * 12, h: 18 + rng() * 15, type: 'break' });
		
		// Body damage (holes and chips)
		chunks.push({ x: -8 + rng() * 16, y: 20 + rng() * 40, w: 18 + rng() * 12, h: 22 + rng() * 15, type: 'hole' });
		chunks.push({ x: -15 + rng() * 10, y: 80 + rng() * 30, w: 14, h: 18, type: 'chip' });
		chunks.push({ x: 5 + rng() * 10, y: -40 + rng() * 20, w: 10, h: 15, type: 'chip' });
		
		// Base damage
		chunks.push({ x: -20 + rng() * 15, y: this.baseHeight/2 - 30, w: 22 + rng() * 10, h: 18 + rng() * 12, type: 'break' });
		
		return chunks;
	}
	
	_generateAntennas() {
		const antennas = [];
		const rng = () => Math.random();
		
		// Main tall antenna on top
		antennas.push({
			x: 0,
			y: -this.baseHeight/2,
			height: 80 + rng() * 30,
			thickness: 3,
			tilt: (rng() - 0.5) * 0.15,
			hasCrossbar: true
		});
		
		// Shorter antennas on top
		antennas.push({
			x: -15,
			y: -this.baseHeight/2 + 5,
			height: 45 + rng() * 20,
			thickness: 2,
			tilt: -0.1 - rng() * 0.1,
			hasCrossbar: false
		});
		antennas.push({
			x: 18,
			y: -this.baseHeight/2 + 8,
			height: 50 + rng() * 15,
			thickness: 2,
			tilt: 0.08 + rng() * 0.12,
			hasCrossbar: false
		});
		
		// Antennas on arm tips
		antennas.push({
			x: -this.armWidth/2 + 10,
			y: this.armY - 5,
			height: 35 + rng() * 20,
			thickness: 2,
			tilt: -0.2 - rng() * 0.15,
			hasCrossbar: false
		});
		antennas.push({
			x: this.armWidth/2 - 10,
			y: this.armY - 5,
			height: 40 + rng() * 15,
			thickness: 2,
			tilt: 0.15 + rng() * 0.2,
			hasCrossbar: false
		});
		
		return antennas;
	}
	
	_generateWires() {
		const wires = [];
		const rng = () => Math.random();
		
		// Wire from top antenna to left arm
		wires.push({
			x1: 0, y1: -this.baseHeight/2 - 60,
			x2: -this.armWidth/2 + 15, y2: this.armY - 20,
			sag: 25 + rng() * 15,
			segments: 8
		});
		
		// Wire from top antenna to right arm
		wires.push({
			x1: 5, y1: -this.baseHeight/2 - 50,
			x2: this.armWidth/2 - 15, y2: this.armY - 25,
			sag: 30 + rng() * 10,
			segments: 8
		});
		
		// Wire hanging from left arm (broken, hanging down)
		wires.push({
			x1: -this.armWidth/2 + 25, y1: this.armY + this.armHeight/2,
			x2: -this.armWidth/2 + 40, y2: this.armY + this.armHeight/2 + 60 + rng() * 40,
			sag: -10 - rng() * 15,
			segments: 5
		});
		
		// Wire between arm antennas (shorter connection)
		wires.push({
			x1: -this.armWidth/2 + 10, y1: this.armY - 35,
			x2: -25, y2: -this.baseHeight/2 - 30,
			sag: 15 + rng() * 10,
			segments: 6
		});
		
		// Another hanging wire on right
		wires.push({
			x1: this.armWidth/2 - 20, y1: this.armY - 30,
			x2: this.armWidth/2 - 35, y2: this.armY + 80 + rng() * 30,
			sag: -8 - rng() * 12,
			segments: 6
		});
		
		return wires;
	}
	
	update(dt) {
		// Update blink timer when powered
		if (this.isPowered) {
			this.lightBlinkTime += dt;
		}
	}
	
	draw(ctx, camera) {
		const sx = Math.round(this.x - camera.x);
		const sy = Math.round(this.y - camera.y);
		
		ctx.save();
		ctx.translate(sx, sy);
		
		// Colors for weathered concrete
		const cementBase = '#5a5f5a';      // Dark gray-green cement
		const cementLight = '#7a7f7a';     // Lighter cement
		const cementDark = '#3a3f3a';      // Darker shadows
		const cementStain = '#4a4540';     // Dirty/stained areas
		const metalDark = '#2a2a2a';       // Dark metal for antennas
		const metalRust = '#5a3a2a';       // Rusted metal
		const wireColor = '#1a1a1a';       // Black wires
		
		// Draw main cross body (vertical beam)
		ctx.fillStyle = cementBase;
		ctx.fillRect(-this.baseWidth/2, -this.baseHeight/2, this.baseWidth, this.baseHeight);
		
		// Draw horizontal arm
		ctx.fillRect(-this.armWidth/2, this.armY - this.armHeight/2, this.armWidth, this.armHeight);
		
		// Add cement texture/weathering with stripes
		ctx.fillStyle = cementLight;
		for (let i = 0; i < 12; i++) {
			const y = -this.baseHeight/2 + i * 25 + 5;
			ctx.fillRect(-this.baseWidth/2 + 3, y, this.baseWidth - 6, 3);
		}
		for (let i = 0; i < 6; i++) {
			const x = -this.armWidth/2 + i * 35 + 10;
			ctx.fillRect(x, this.armY - this.armHeight/2 + 5, 4, this.armHeight - 10);
		}
		
		// Add staining/dirt patches
		ctx.fillStyle = cementStain;
		ctx.globalAlpha = 0.4;
		ctx.fillRect(-this.baseWidth/2, 30, this.baseWidth, 50);
		ctx.fillRect(-this.baseWidth/2 + 5, -60, 15, 40);
		ctx.fillRect(-this.armWidth/2, this.armY, 40, this.armHeight);
		ctx.globalAlpha = 1.0;
		
		// Draw damage chunks (breaks, chips, holes)
		for (const chunk of this.damageChunks) {
			if (chunk.type === 'break') {
				// Break removes a chunk, showing dark interior
				ctx.fillStyle = cementDark;
				ctx.fillRect(chunk.x - chunk.w/2, chunk.y - chunk.h/2, chunk.w, chunk.h);
				// Jagged edge effect
				ctx.fillStyle = cementBase;
				ctx.beginPath();
				ctx.moveTo(chunk.x - chunk.w/2, chunk.y - chunk.h/2);
				ctx.lineTo(chunk.x - chunk.w/2 + 5, chunk.y);
				ctx.lineTo(chunk.x - chunk.w/2, chunk.y + chunk.h/2);
				ctx.fill();
			} else if (chunk.type === 'hole') {
				// Hole shows very dark interior
				ctx.fillStyle = '#1a1a1a';
				ctx.beginPath();
				ctx.ellipse(chunk.x, chunk.y, chunk.w/2, chunk.h/2, 0, 0, Math.PI * 2);
				ctx.fill();
				// Cracked edges
				ctx.strokeStyle = cementDark;
				ctx.lineWidth = 2;
				ctx.beginPath();
				ctx.ellipse(chunk.x, chunk.y, chunk.w/2 + 3, chunk.h/2 + 3, 0, 0, Math.PI * 2);
				ctx.stroke();
			} else if (chunk.type === 'chip') {
				// Chip is a lighter colored damaged area
				ctx.fillStyle = cementLight;
				ctx.fillRect(chunk.x - chunk.w/2, chunk.y - chunk.h/2, chunk.w, chunk.h);
			}
		}
		
		// Draw structural cracks
		ctx.strokeStyle = cementDark;
		ctx.lineWidth = 2;
		ctx.beginPath();
		ctx.moveTo(-5, -30); ctx.lineTo(-15, 20); ctx.lineTo(-8, 60);
		ctx.stroke();
		ctx.beginPath();
		ctx.moveTo(10, this.armY - 10); ctx.lineTo(25, this.armY + 5); ctx.lineTo(50, this.armY);
		ctx.stroke();
		
		// Draw outline for definition
		ctx.strokeStyle = cementDark;
		ctx.lineWidth = 3;
		// Vertical beam outline
		ctx.strokeRect(-this.baseWidth/2, -this.baseHeight/2, this.baseWidth, this.baseHeight);
		// Horizontal arm outline
		ctx.strokeRect(-this.armWidth/2, this.armY - this.armHeight/2, this.armWidth, this.armHeight);
		
		// Draw antennas
		for (let antIdx = 0; antIdx < this.antennas.length; antIdx++) {
			const ant = this.antennas[antIdx];
			ctx.save();
			ctx.translate(ant.x, ant.y);
			ctx.rotate(ant.tilt);
			
			// Main antenna pole
			ctx.fillStyle = metalDark;
			ctx.fillRect(-ant.thickness/2, -ant.height, ant.thickness, ant.height);
			
			// Rust patches
			ctx.fillStyle = metalRust;
			ctx.fillRect(-ant.thickness/2, -ant.height * 0.7, ant.thickness, 10);
			ctx.fillRect(-ant.thickness/2, -ant.height * 0.3, ant.thickness, 8);
			
			// Crossbar on main antenna
			if (ant.hasCrossbar) {
				ctx.fillStyle = metalDark;
				ctx.fillRect(-15, -ant.height + 20, 30, 3);
				ctx.fillRect(-10, -ant.height + 40, 20, 2);
				// Small vertical elements on crossbar
				ctx.fillRect(-12, -ant.height + 10, 2, 15);
				ctx.fillRect(10, -ant.height + 10, 2, 15);
			}
			
			// Antenna tip
			ctx.fillStyle = metalDark;
			ctx.beginPath();
			ctx.arc(0, -ant.height - 3, 3, 0, Math.PI * 2);
			ctx.fill();
			
			// Blinking red light at antenna tip when powered (offset timing per antenna)
			if (this.isPowered) {
				// Each antenna has a different phase offset for staggered blinking
				const phaseOffset = antIdx * 0.7;  // ~0.7 seconds offset between each
				const blink = Math.sin((this.lightBlinkTime + phaseOffset) * 4) > 0;
				if (blink) {
					// Red glow
					ctx.shadowColor = '#ff0000';
					ctx.shadowBlur = 12;
					ctx.fillStyle = '#ff3333';
					ctx.beginPath();
					ctx.arc(0, -ant.height - 3, 5, 0, Math.PI * 2);
					ctx.fill();
					ctx.shadowBlur = 0;
				} else {
					// Dim red (off state)
					ctx.fillStyle = '#661111';
					ctx.beginPath();
					ctx.arc(0, -ant.height - 3, 4, 0, Math.PI * 2);
					ctx.fill();
				}
			}
			
			ctx.restore();
		}
		
		// Draw wires with catenary sag
		ctx.strokeStyle = wireColor;
		ctx.lineWidth = 1.5;
		for (const wire of this.wires) {
			ctx.beginPath();
			ctx.moveTo(wire.x1, wire.y1);
			
			// Draw wire with sag using quadratic curve segments
			for (let i = 1; i <= wire.segments; i++) {
				const t = i / wire.segments;
				const x = wire.x1 + (wire.x2 - wire.x1) * t;
				const baseY = wire.y1 + (wire.y2 - wire.y1) * t;
				// Parabolic sag (max at middle)
				const sagAmount = wire.sag * 4 * t * (1 - t);
				const y = baseY + sagAmount;
				ctx.lineTo(x, y);
			}
			ctx.stroke();
		}
		
		// Add some small detail wires/debris hanging
		ctx.strokeStyle = wireColor;
		ctx.lineWidth = 1;
		ctx.beginPath();
		ctx.moveTo(-this.armWidth/2 + 5, this.armY + this.armHeight/2);
		ctx.lineTo(-this.armWidth/2 + 8, this.armY + this.armHeight/2 + 25);
		ctx.lineTo(-this.armWidth/2 + 3, this.armY + this.armHeight/2 + 45);
		ctx.stroke();
		
		ctx.beginPath();
		ctx.moveTo(this.armWidth/2 - 8, this.armY + this.armHeight/2);
		ctx.lineTo(this.armWidth/2 - 5, this.armY + this.armHeight/2 + 30);
		ctx.stroke();
		
		ctx.restore();
	}
}

class EnemyShield {
	constructor(owner) {
		this.owner = owner; // Reference to WallGuy enemy
		this.x = owner.x;
		this.y = owner.y;
		this.width = 80; // Longer than wide
		this.depth = 20; // Narrow depth
		this.radius = Math.max(this.width, this.depth) / 2; // For spatial grid
		this.angle = 0; // Rotation angle
		this.color = '#8B0000'; // Dark red
		this.alive = true;
		
		// For collision registration
		this.id = `shield_${owner.id}`;
		this.isEnemyShield = true;
	}
	
	update(dt, ownerAngle) {
		if (!this.owner || !this.owner.alive) {
			this.alive = false;
			// Remove from environment.orientedBoxes when shield dies
			if (this._envBoxIndex !== undefined && window.environment && window.environment.orientedBoxes) {
				window.environment.orientedBoxes.splice(this._envBoxIndex, 1);
				// Update indices for shields that came after this one
				for (let i = this._envBoxIndex; i < window.environment.orientedBoxes.length; i++) {
					const box = window.environment.orientedBoxes[i];
					// Find the shield that owns this box and update its index
					const enemyList = window.enemies?.items || [];
					for (const enemy of enemyList) {
						if (enemy.shield && enemy.shield.collisionBox === box) {
							enemy.shield._envBoxIndex = i;
							break;
						}
					}
				}
				this._envBoxIndex = undefined;
			}
			return;
		}
		
		// Position shield in front of owner
		this.angle = ownerAngle;
		const dist = (this.owner.radius || 28) + this.depth/2 + 5;
		this.x = this.owner.x + Math.cos(this.angle) * dist;
		this.y = this.owner.y + Math.sin(this.angle) * dist;
		
		// Update collision box position and rotation
		if (this.collisionBox) {
			this.collisionBox.x = this.x;
			this.collisionBox.y = this.y;
			this.collisionBox.angle = this.angle;
		}
	}
	
	draw(ctx, camera) {
		if (!this.alive) return;
		
		const sx = this.x - camera.x;
		const sy = this.y - camera.y;
		
		ctx.save();
		ctx.translate(sx, sy);
		ctx.rotate(this.angle);
		
		const halfW = this.width / 2;  // 40
		const halfD = this.depth / 2;  // 10
		
		// Dark red color (matching weapon1's shield wall style)
		const shieldColor = '#cc0000'; // Bright red
		
		// Semi-transparent fill with glow (like weapon1 shield walls)
		ctx.globalAlpha = 0.5;
		ctx.fillStyle = shieldColor;
		ctx.shadowColor = shieldColor;
		ctx.shadowBlur = 15;
		ctx.fillRect(-halfD, -halfW, this.depth, this.width);
		
		// Glowing outline with pulse effect
		ctx.globalAlpha = 0.9;
		ctx.strokeStyle = shieldColor;
		ctx.lineWidth = 3;
		ctx.shadowBlur = 8;
		ctx.strokeRect(-halfD, -halfW, this.depth, this.width);
		
		ctx.restore();
	}
	
	// Check if a point hits the shield
	pointInShield(px, py) {
		// Transform point to shield's local space
		const dx = px - this.x;
		const dy = py - this.y;
		const cos = Math.cos(-this.angle);
		const sin = Math.sin(-this.angle);
		const localX = dx * cos - dy * sin;
		const localY = dx * sin + dy * cos;
		
		const halfW = this.width / 2;
		const halfD = this.depth / 2;
		
		return (Math.abs(localX) <= halfD && Math.abs(localY) <= halfW);
	}
}

// Expose to window
window.Ducat = Ducat;
window.BloodMarker = BloodMarker;
window.EnemyShield = EnemyShield;
window.RadioTower = RadioTower;
window.Battery = Battery;
window.BatteryStation = BatteryStation;

window.GameObjects = { Chest, Artifact, HexStat, ExtractionZone, ReadyZone, HereticExtractionZone, Ducat, BloodMarker, EnemyShield, RadioTower, Battery, BatteryStation };



