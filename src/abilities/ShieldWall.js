// Shield Wall - Weapon 1 Secondary (2 blood markers)
// Rotated rectangle collision that EXACTLY matches visual placement
class ShieldWall extends AbilityBase {
    constructor(player, aimAngle, placementX, placementY, wallWidth = 100) {
        super(placementX, placementY, player, {
            maxLife: 60.0, // 60 seconds duration
            color: '#4da3ff'
        });
        
        this.aimAngle = aimAngle;
        this.width = wallWidth; // units across (progression-based)
        this.depth = 20; // units deep
        
        // Calculate wall corners for rendering
        this._calculateCorners();
        
        // Visual decay
        this.decayTimer = 0;
        this.pulseTime = 0;
        
        // Add to environment's oriented boxes for collision
        this._addToEnvironment();
    }
    
    _calculateCorners() {
        // Wall is perpendicular to aim direction
        const perpAngle = this.aimAngle + Math.PI / 2;
        const halfWidth = this.width / 2;
        const halfDepth = this.depth / 2;
        
        // Forward/back along aim direction
        const fwdX = Math.cos(this.aimAngle);
        const fwdY = Math.sin(this.aimAngle);
        
        // Left/right perpendicular to aim
        const perpX = Math.cos(perpAngle);
        const perpY = Math.sin(perpAngle);
        
        // Four corners of the wall rectangle
        this.corners = [
            { x: this.x - perpX * halfWidth - fwdX * halfDepth, y: this.y - perpY * halfWidth - fwdY * halfDepth },
            { x: this.x + perpX * halfWidth - fwdX * halfDepth, y: this.y + perpY * halfWidth - fwdY * halfDepth },
            { x: this.x + perpX * halfWidth + fwdX * halfDepth, y: this.y + perpY * halfWidth + fwdY * halfDepth },
            { x: this.x - perpX * halfWidth + fwdX * halfDepth, y: this.y - perpY * halfWidth + fwdY * halfDepth }
        ];
    }
    
    _addToEnvironment() {
        if (!window.environment) {
            console.error('[ShieldWall] Cannot add - environment not ready');
            return;
        }
        
        // Initialize orientedBoxes if it doesn't exist (safety check for client-side)
        if (!window.environment.orientedBoxes) {
            console.warn('[ShieldWall] orientedBoxes missing on client, initializing now');
            window.environment.orientedBoxes = [];
        }
        
        // Create oriented box collision that EXACTLY matches visual
        // Visual: width runs along perpendicular to aim, depth runs along aim
        // So collision angle must be perpendicular to aim angle
        const perpAngle = this.aimAngle + Math.PI / 2;
        
        this.collisionBox = {
            x: this.x,
            y: this.y,
            w: this.width,  // 100 units wide (along perpAngle)
            h: this.depth,  // 20 units deep (along aimAngle)
            angle: perpAngle,  // Rotate 90° from aim to match visual orientation
            _abilityId: this.id
        };
        
        window.environment.orientedBoxes.push(this.collisionBox);
        this._envBoxIndex = window.environment.orientedBoxes.length - 1;
        
        console.log('[ShieldWall] CLIENT added OBB at index:', this._envBoxIndex, 'total boxes:', window.environment.orientedBoxes.length);
    }
    
    update(dt, environment, enemies, players) {
        super.update(dt, environment, enemies, players);
        
        this.pulseTime += dt * 2;
        
        // Visual decay as lifetime runs out
        if (this.lifeLeft !== null && this.maxLife) {
            this.decayTimer = 1.0 - (this.lifeLeft / this.maxLife);
        }
    }
    
    onExpire() {
        // Remove collision box from environment
        if (window.environment && window.environment.orientedBoxes && this._envBoxIndex !== undefined) {
            const idx = window.environment.orientedBoxes.findIndex(box => box._abilityId === this.id);
            if (idx !== -1) {
                window.environment.orientedBoxes.splice(idx, 1);
                console.log('[ShieldWall] Removed OBB collision at expiry');
            }
        }
    }
    
    draw(ctx, camera) {
        if (!this.alive) return;
        
        const alpha = Math.max(0.3, 1.0 - this.decayTimer * 0.7);
        const pulse = 0.9 + Math.sin(this.pulseTime) * 0.1;
        
        ctx.save();
        
        // Draw wall as glowing rectangle
        const c = this.corners;
        ctx.globalAlpha = alpha * 0.4;
        ctx.fillStyle = this.color;
        ctx.shadowColor = this.color;
        ctx.shadowBlur = 15;
        ctx.beginPath();
        ctx.moveTo(c[0].x - camera.x, c[0].y - camera.y);
        for (let i = 1; i < c.length; i++) {
            ctx.lineTo(c[i].x - camera.x, c[i].y - camera.y);
        }
        ctx.closePath();
        ctx.fill();
        
        // Draw outline
        ctx.globalAlpha = alpha * pulse;
        ctx.strokeStyle = this.color;
        ctx.lineWidth = 3;
        ctx.shadowBlur = 8;
        ctx.stroke();
        
        // Draw lifetime bar above wall
        if (this.lifeLeft !== null && this.maxLife) {
            const sx = this.x - camera.x;
            const sy = this.y - camera.y - 30;
            const barW = 80;
            const barH = 6;
            const frac = this.lifeLeft / this.maxLife;
            
            ctx.globalAlpha = 0.8;
            ctx.shadowBlur = 0;
            ctx.fillStyle = 'rgba(0,0,0,0.4)';
            ctx.fillRect(sx - barW / 2, sy - barH / 2, barW, barH);
            
            ctx.fillStyle = this.color;
            ctx.fillRect(sx - barW / 2, sy - barH / 2, barW * frac, barH);
            
            ctx.strokeStyle = 'rgba(0,0,0,0.6)';
            ctx.lineWidth = 2;
            ctx.strokeRect(sx - barW / 2, sy - barH / 2, barW, barH);
        }
        
        ctx.restore();
    }
    
    getNetworkData() {
        return {
            aimAngle: this.aimAngle,
            placementX: this.x,
            placementY: this.y
        };
    }
}

window.ShieldWall = ShieldWall;

