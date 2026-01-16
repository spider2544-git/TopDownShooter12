// Skin rendering functions for cosmetic items (body accessories)
// All skins stay upright regardless of player rotation

class SkinRenderer {
    // Draw shield shoulder pads with crosses and brown leather belt with pouches
    static drawCrusaderArmor(ctx, screenX, screenY, playerRadius, color) {
        const shoulderSize = playerRadius * 1.1; // Larger shoulders
        const shoulderOffsetY = screenY - playerRadius * 0.3; // Upper chest area
        
        ctx.save();
        
        // === LEFT SHOULDER PAD ===
        const leftX = screenX - playerRadius * 0.9; // Stick out further
        
        // Shield shape with metallic gradient
        const leftGradient = ctx.createLinearGradient(leftX - shoulderSize * 0.3, shoulderOffsetY - shoulderSize * 0.2, 
                                                       leftX + shoulderSize * 0.3, shoulderOffsetY + shoulderSize * 0.2);
        leftGradient.addColorStop(0, this.lighten(color, 25));
        leftGradient.addColorStop(0.5, color);
        leftGradient.addColorStop(1, this.darken(color, 30));
        
        ctx.fillStyle = leftGradient;
        ctx.strokeStyle = this.darken(color, 45);
        ctx.lineWidth = 2;
        
        // Shield pad shape (rounded rectangle)
        this.drawRoundedRect(ctx, leftX - shoulderSize * 0.35, shoulderOffsetY - shoulderSize * 0.25, 
                            shoulderSize * 0.7, shoulderSize * 0.5, shoulderSize * 0.1);
        ctx.fill();
        ctx.stroke();
        
        // Cross emblem on left shoulder
        const leftCrossSize = shoulderSize * 0.25;
        ctx.fillStyle = this.darken(color, 55);
        ctx.strokeStyle = this.darken(color, 65);
        ctx.lineWidth = 1;
        
        // Vertical bar
        ctx.fillRect(leftX - leftCrossSize * 0.1, shoulderOffsetY - leftCrossSize * 0.5, 
                    leftCrossSize * 0.2, leftCrossSize);
        ctx.strokeRect(leftX - leftCrossSize * 0.1, shoulderOffsetY - leftCrossSize * 0.5, 
                      leftCrossSize * 0.2, leftCrossSize);
        
        // Horizontal bar
        ctx.fillRect(leftX - leftCrossSize * 0.45, shoulderOffsetY - leftCrossSize * 0.1, 
                    leftCrossSize * 0.9, leftCrossSize * 0.2);
        ctx.strokeRect(leftX - leftCrossSize * 0.45, shoulderOffsetY - leftCrossSize * 0.1, 
                      leftCrossSize * 0.9, leftCrossSize * 0.2);
        
        // Rivets on left pad
        ctx.fillStyle = this.darken(color, 60);
        const rivetRadius = 1.2;
        for (let i = 0; i < 4; i++) {
            const angle = (i * Math.PI / 2) + Math.PI / 4;
            const rivetDist = shoulderSize * 0.25;
            const rx = leftX + Math.cos(angle) * rivetDist;
            const ry = shoulderOffsetY + Math.sin(angle) * rivetDist;
            ctx.beginPath();
            ctx.arc(rx, ry, rivetRadius, 0, Math.PI * 2);
            ctx.fill();
        }
        
        // === RIGHT SHOULDER PAD ===
        const rightX = screenX + playerRadius * 0.9; // Stick out further
        
        // Shield shape with metallic gradient (mirrored)
        const rightGradient = ctx.createLinearGradient(rightX - shoulderSize * 0.3, shoulderOffsetY - shoulderSize * 0.2, 
                                                        rightX + shoulderSize * 0.3, shoulderOffsetY + shoulderSize * 0.2);
        rightGradient.addColorStop(0, this.darken(color, 30));
        rightGradient.addColorStop(0.5, color);
        rightGradient.addColorStop(1, this.lighten(color, 25));
        
        ctx.fillStyle = rightGradient;
        ctx.strokeStyle = this.darken(color, 45);
        ctx.lineWidth = 2;
        
        // Shield pad shape (rounded rectangle)
        this.drawRoundedRect(ctx, rightX - shoulderSize * 0.35, shoulderOffsetY - shoulderSize * 0.25, 
                            shoulderSize * 0.7, shoulderSize * 0.5, shoulderSize * 0.1);
        ctx.fill();
        ctx.stroke();
        
        // Cross emblem on right shoulder
        const rightCrossSize = shoulderSize * 0.25;
        ctx.fillStyle = this.darken(color, 55);
        ctx.strokeStyle = this.darken(color, 65);
        ctx.lineWidth = 1;
        
        // Vertical bar
        ctx.fillRect(rightX - rightCrossSize * 0.1, shoulderOffsetY - rightCrossSize * 0.5, 
                    rightCrossSize * 0.2, rightCrossSize);
        ctx.strokeRect(rightX - rightCrossSize * 0.1, shoulderOffsetY - rightCrossSize * 0.5, 
                      rightCrossSize * 0.2, rightCrossSize);
        
        // Horizontal bar
        ctx.fillRect(rightX - rightCrossSize * 0.45, shoulderOffsetY - rightCrossSize * 0.1, 
                    rightCrossSize * 0.9, rightCrossSize * 0.2);
        ctx.strokeRect(rightX - rightCrossSize * 0.45, shoulderOffsetY - rightCrossSize * 0.1, 
                      rightCrossSize * 0.9, rightCrossSize * 0.2);
        
        // Rivets on right pad
        ctx.fillStyle = this.darken(color, 60);
        for (let i = 0; i < 4; i++) {
            const angle = (i * Math.PI / 2) + Math.PI / 4;
            const rivetDist = shoulderSize * 0.25;
            const rx = rightX + Math.cos(angle) * rivetDist;
            const ry = shoulderOffsetY + Math.sin(angle) * rivetDist;
            ctx.beginPath();
            ctx.arc(rx, ry, rivetRadius, 0, Math.PI * 2);
            ctx.fill();
        }
        
        // === LEATHER BELT WITH POUCHES ===
        const beltY = screenY + playerRadius * 0.1; // Around belly area
        const beltWidth = playerRadius * 2.0; // Full width to edge of body
        const beltHeight = playerRadius * 0.25; // Thinner belt
        
        // Brown leather colors
        const leatherBrown = '#5c4033';
        const leatherDark = '#3d2a22';
        const leatherLight = '#8b6f47';
        
        // Main belt
        const beltGradient = ctx.createLinearGradient(screenX, beltY - beltHeight * 0.5, 
                                                      screenX, beltY + beltHeight * 0.5);
        beltGradient.addColorStop(0, leatherDark);
        beltGradient.addColorStop(0.3, leatherBrown);
        beltGradient.addColorStop(0.7, leatherBrown);
        beltGradient.addColorStop(1, leatherDark);
        
        ctx.fillStyle = beltGradient;
        ctx.strokeStyle = leatherDark;
        ctx.lineWidth = 1.5;
        
        // Belt body
        this.drawRoundedRect(ctx, screenX - beltWidth * 0.5, beltY - beltHeight * 0.5, 
                            beltWidth, beltHeight, beltHeight * 0.2);
        ctx.fill();
        ctx.stroke();
        
        // Belt stitching lines (top and bottom)
        ctx.strokeStyle = leatherLight;
        ctx.lineWidth = 0.8;
        ctx.setLineDash([2, 3]);
        
        // Top stitching
        ctx.beginPath();
        ctx.moveTo(screenX - beltWidth * 0.45, beltY - beltHeight * 0.3);
        ctx.lineTo(screenX + beltWidth * 0.45, beltY - beltHeight * 0.3);
        ctx.stroke();
        
        // Bottom stitching
        ctx.beginPath();
        ctx.moveTo(screenX - beltWidth * 0.45, beltY + beltHeight * 0.3);
        ctx.lineTo(screenX + beltWidth * 0.45, beltY + beltHeight * 0.3);
        ctx.stroke();
        
        ctx.setLineDash([]); // Reset dash
        
        // Pouches - more pouches, smaller
        const pouchWidth = beltWidth * 0.15;
        const pouchHeight = beltHeight * 1.4;
        const pouchSpacing = beltWidth * 0.25;
        
        // Draw five pouches
        for (let i = -2; i <= 2; i++) {
            const pouchX = screenX + i * pouchSpacing;
            const pouchY = beltY + beltHeight * 0.3;
            
            // Pouch gradient
            const pouchGradient = ctx.createRadialGradient(pouchX, pouchY, 0, pouchX, pouchY, pouchWidth * 0.6);
            pouchGradient.addColorStop(0, leatherLight);
            pouchGradient.addColorStop(0.6, leatherBrown);
            pouchGradient.addColorStop(1, leatherDark);
            
            ctx.fillStyle = pouchGradient;
            ctx.strokeStyle = leatherDark;
            ctx.lineWidth = 1.5;
            
            // Pouch body (rounded bottom)
            ctx.beginPath();
            ctx.moveTo(pouchX - pouchWidth * 0.5, pouchY);
            ctx.lineTo(pouchX - pouchWidth * 0.5, pouchY + pouchHeight * 0.6);
            ctx.quadraticCurveTo(pouchX, pouchY + pouchHeight, pouchX + pouchWidth * 0.5, pouchY + pouchHeight * 0.6);
            ctx.lineTo(pouchX + pouchWidth * 0.5, pouchY);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
            
            // Pouch flap
            ctx.fillStyle = this.darken(leatherBrown, 15);
            ctx.beginPath();
            ctx.moveTo(pouchX - pouchWidth * 0.5, pouchY);
            ctx.lineTo(pouchX - pouchWidth * 0.5, pouchY + pouchHeight * 0.2);
            ctx.quadraticCurveTo(pouchX, pouchY + pouchHeight * 0.25, pouchX + pouchWidth * 0.5, pouchY + pouchHeight * 0.2);
            ctx.lineTo(pouchX + pouchWidth * 0.5, pouchY);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
            
            // Button/clasp
            ctx.fillStyle = '#8b8b8b'; // Metallic button
            ctx.strokeStyle = '#5a5a5a';
            ctx.lineWidth = 0.8;
            ctx.beginPath();
            ctx.arc(pouchX, pouchY + pouchHeight * 0.15, pouchWidth * 0.1, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
        }
        
        // Central belt buckle
        const buckleWidth = beltWidth * 0.15;
        const buckleHeight = beltHeight * 0.7;
        
        ctx.fillStyle = '#a8a8a8'; // Metallic buckle
        ctx.strokeStyle = '#6a6a6a';
        ctx.lineWidth = 1.5;
        
        this.drawRoundedRect(ctx, screenX - buckleWidth * 0.5, beltY - buckleHeight * 0.5, 
                            buckleWidth, buckleHeight, buckleHeight * 0.15);
        ctx.fill();
        ctx.stroke();
        
        // Buckle pin
        ctx.strokeStyle = '#5a5a5a';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(screenX - buckleWidth * 0.3, beltY);
        ctx.lineTo(screenX + buckleWidth * 0.3, beltY);
        ctx.stroke();
        
        ctx.restore();
    }
    
    // Helper: Draw rounded rectangle
    static drawRoundedRect(ctx, x, y, width, height, radius) {
        ctx.beginPath();
        ctx.moveTo(x + radius, y);
        ctx.lineTo(x + width - radius, y);
        ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
        ctx.lineTo(x + width, y + height - radius);
        ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
        ctx.lineTo(x + radius, y + height);
        ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
        ctx.lineTo(x, y + radius);
        ctx.quadraticCurveTo(x, y, x + radius, y);
        ctx.closePath();
    }
    
    // Draw religious iconoclast - ropes, leather straps, icons, and cross shields
    static drawIconoclast(ctx, screenX, screenY, playerRadius, color) {
        ctx.save();
        
        // Colors
        const rustIron = '#6b4423';
        const darkRust = '#4a2f1a';
        const lightRust = '#8b6f47';
        const ropeColor = '#8b7355';
        const ropeDark = '#6b5a45';
        const leatherBrown = '#5c4033';
        const leatherDark = '#3d2a22';
        
        // === RUSTED CROSS SHOULDER SHIELDS ===
        const shoulderSize = playerRadius * 1.1; // Larger shields
        const shoulderOffsetY = screenY - playerRadius * 0.35;
        
        // Left shoulder shield
        const leftX = screenX - playerRadius * 0.85; // Further out
        const shieldGradient = ctx.createRadialGradient(leftX, shoulderOffsetY, 0, leftX, shoulderOffsetY, shoulderSize * 0.5);
        shieldGradient.addColorStop(0, rustIron);
        shieldGradient.addColorStop(0.6, darkRust);
        shieldGradient.addColorStop(1, '#3d2a22');
        
        ctx.fillStyle = shieldGradient;
        ctx.strokeStyle = darkRust;
        ctx.lineWidth = 2;
        
        // Shield shape (rounded rectangle)
        this.drawRoundedRect(ctx, leftX - shoulderSize * 0.35, shoulderOffsetY - shoulderSize * 0.25, 
                            shoulderSize * 0.7, shoulderSize * 0.5, shoulderSize * 0.1);
        ctx.fill();
        ctx.stroke();
        
        // Cross on left shield
        const crossSize = shoulderSize * 0.35;
        ctx.fillStyle = '#c9a86a'; // Brighter gold/bronze
        ctx.strokeStyle = rustIron;
        ctx.lineWidth = 1.5;
        ctx.fillRect(leftX - crossSize * 0.12, shoulderOffsetY - crossSize * 0.5, crossSize * 0.24, crossSize);
        ctx.strokeRect(leftX - crossSize * 0.12, shoulderOffsetY - crossSize * 0.5, crossSize * 0.24, crossSize);
        ctx.fillRect(leftX - crossSize * 0.5, shoulderOffsetY - crossSize * 0.12, crossSize, crossSize * 0.24);
        ctx.strokeRect(leftX - crossSize * 0.5, shoulderOffsetY - crossSize * 0.12, crossSize, crossSize * 0.24);
        
        // Right shoulder shield
        const rightX = screenX + playerRadius * 0.85; // Further out
        const shieldGradient2 = ctx.createRadialGradient(rightX, shoulderOffsetY, 0, rightX, shoulderOffsetY, shoulderSize * 0.5);
        shieldGradient2.addColorStop(0, rustIron);
        shieldGradient2.addColorStop(0.6, darkRust);
        shieldGradient2.addColorStop(1, '#3d2a22');
        
        ctx.fillStyle = shieldGradient2;
        ctx.strokeStyle = darkRust;
        ctx.lineWidth = 2;
        
        this.drawRoundedRect(ctx, rightX - shoulderSize * 0.35, shoulderOffsetY - shoulderSize * 0.25, 
                            shoulderSize * 0.7, shoulderSize * 0.5, shoulderSize * 0.1);
        ctx.fill();
        ctx.stroke();
        
        // Cross on right shield
        ctx.fillStyle = '#c9a86a'; // Brighter gold/bronze
        ctx.strokeStyle = rustIron;
        ctx.lineWidth = 1.5;
        ctx.fillRect(rightX - crossSize * 0.12, shoulderOffsetY - crossSize * 0.5, crossSize * 0.24, crossSize);
        ctx.strokeRect(rightX - crossSize * 0.12, shoulderOffsetY - crossSize * 0.5, crossSize * 0.24, crossSize);
        ctx.fillRect(rightX - crossSize * 0.5, shoulderOffsetY - crossSize * 0.12, crossSize, crossSize * 0.24);
        ctx.strokeRect(rightX - crossSize * 0.5, shoulderOffsetY - crossSize * 0.12, crossSize, crossSize * 0.24);
        
        // === LEATHER STRAPS (HORIZONTAL) ===
        const strapHeight = playerRadius * 0.15;
        const strapY1 = screenY - playerRadius * 0.1; // Upper strap
        const strapY2 = screenY + playerRadius * 0.3; // Lower strap
        
        for (const strapY of [strapY1, strapY2]) {
            // Leather strap
            const strapGradient = ctx.createLinearGradient(screenX, strapY - strapHeight/2, screenX, strapY + strapHeight/2);
            strapGradient.addColorStop(0, leatherDark);
            strapGradient.addColorStop(0.5, leatherBrown);
            strapGradient.addColorStop(1, leatherDark);
            
            ctx.fillStyle = strapGradient;
            ctx.strokeStyle = leatherDark;
            ctx.lineWidth = 1;
            this.drawRoundedRect(ctx, screenX - playerRadius, strapY - strapHeight/2, 
                                playerRadius * 2.0, strapHeight, strapHeight * 0.25); // Full width to edge
            ctx.fill();
            ctx.stroke();
            
            // Stitching
            ctx.strokeStyle = ropeDark;
            ctx.lineWidth = 0.8;
            ctx.setLineDash([2, 3]);
            ctx.beginPath();
            ctx.moveTo(screenX - playerRadius * 0.95, strapY - strapHeight * 0.25);
            ctx.lineTo(screenX + playerRadius * 0.95, strapY - strapHeight * 0.25);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(screenX - playerRadius * 0.95, strapY + strapHeight * 0.25);
            ctx.lineTo(screenX + playerRadius * 0.95, strapY + strapHeight * 0.25);
            ctx.stroke();
            ctx.setLineDash([]);
            
            // Buckles
            const buckleSize = strapHeight * 0.5;
            for (const side of [-0.65, 0, 0.65]) {
                const buckleX = screenX + side * playerRadius;
                ctx.fillStyle = '#5a5a5a';
                ctx.strokeStyle = '#3a3a3a';
                ctx.lineWidth = 0.8;
                ctx.fillRect(buckleX - buckleSize/2, strapY - buckleSize/2, buckleSize, buckleSize);
                ctx.strokeRect(buckleX - buckleSize/2, strapY - buckleSize/2, buckleSize, buckleSize);
            }
        }
        
        // === ROPE STRAPS (DIAGONAL X) ===
        ctx.strokeStyle = ropeColor;
        ctx.lineWidth = 2.5;
        ctx.lineCap = 'round';
        
        // Left diagonal
        ctx.beginPath();
        ctx.moveTo(screenX - playerRadius * 0.7, screenY - playerRadius * 0.5);
        ctx.lineTo(screenX + playerRadius * 0.7, screenY + playerRadius * 0.7);
        ctx.stroke();
        
        // Right diagonal
        ctx.beginPath();
        ctx.moveTo(screenX + playerRadius * 0.7, screenY - playerRadius * 0.5);
        ctx.lineTo(screenX - playerRadius * 0.7, screenY + playerRadius * 0.7);
        ctx.stroke();
        
        // Add rope texture to diagonals
        ctx.strokeStyle = ropeDark;
        ctx.lineWidth = 0.8;
        for (let i = 0; i < 6; i++) {
            const t = i / 5;
            // Left diagonal texture
            const x1 = screenX - playerRadius * 0.7 + playerRadius * 1.4 * t;
            const y1 = screenY - playerRadius * 0.5 + playerRadius * 1.2 * t;
            const offset = (i % 2) * 2 - 1;
            ctx.beginPath();
            ctx.moveTo(x1 - offset, y1 - offset);
            ctx.lineTo(x1 + offset, y1 + offset);
            ctx.stroke();
            
            // Right diagonal texture
            const x2 = screenX + playerRadius * 0.7 - playerRadius * 1.4 * t;
            const y2 = screenY - playerRadius * 0.5 + playerRadius * 1.2 * t;
            ctx.beginPath();
            ctx.moveTo(x2 - offset, y2 - offset);
            ctx.lineTo(x2 + offset, y2 + offset);
            ctx.stroke();
        }
        
        // === RELIGIOUS ICONS (REDUCED TO 3) ===
        const icons = [
            // Center large icon
            { x: 0, y: 0.05, w: 0.5, h: 0.65, colors: ['#8b7355', '#d4af37', '#6b4423'] },
            // Upper left
            { x: -0.45, y: -0.35, w: 0.35, h: 0.45, colors: ['#a0826d', '#cd853f', '#4a2f1a'] },
            // Upper right
            { x: 0.45, y: -0.3, w: 0.35, h: 0.45, colors: ['#8b6f47', '#daa520', '#5c4033'] }
        ];
        
        for (const icon of icons) {
            const ix = screenX + icon.x * playerRadius;
            const iy = screenY + icon.y * playerRadius;
            const iw = icon.w * playerRadius;
            const ih = icon.h * playerRadius;
            
            // Icon background (aged canvas)
            const iconGradient = ctx.createLinearGradient(ix - iw/2, iy - ih/2, ix + iw/2, iy + ih/2);
            iconGradient.addColorStop(0, icon.colors[0]);
            iconGradient.addColorStop(0.5, icon.colors[1]);
            iconGradient.addColorStop(1, icon.colors[2]);
            
            ctx.fillStyle = iconGradient;
            ctx.strokeStyle = darkRust;
            ctx.lineWidth = 1.5;
            ctx.fillRect(ix - iw/2, iy - ih/2, iw, ih);
            ctx.strokeRect(ix - iw/2, iy - ih/2, iw, ih);
            
            // Simple figure silhouette (dark)
            ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
            ctx.beginPath();
            // Head
            ctx.arc(ix, iy - ih * 0.2, iw * 0.15, 0, Math.PI * 2);
            ctx.fill();
            // Body
            ctx.fillRect(ix - iw * 0.15, iy - ih * 0.05, iw * 0.3, ih * 0.45);
            
            // Frame edge highlight
            ctx.strokeStyle = lightRust;
            ctx.lineWidth = 0.8;
            ctx.strokeRect(ix - iw/2 + 1.5, iy - ih/2 + 1.5, iw - 3, ih - 3);
        }
        
        ctx.restore();
    }
    
    // Draw military officer - green lapels over metal cuirass with badges
    static drawOfficer(ctx, screenX, screenY, playerRadius, color) {
        ctx.save();
        
        // Colors
        const metalGrey = '#8b8b8b';
        const metalDark = '#5a5a5a';
        const metalLight = '#b8b8b8';
        const armyGreen = '#5c6b4a';
        const greenDark = '#3d4a2f';
        const greenLight = '#7a8c65';
        const leatherBrown = '#5c4033';
        const leatherDark = '#3d2a22';
        const badgeGold = '#d4af37';
        const badgeGoldDark = '#b8941f';
        
        // === METAL CUIRASS ARMOR (BREASTPLATE) ===
        const cuirassWidth = playerRadius * 1.3;
        const cuirassHeight = playerRadius * 1.5;
        const cuirassY = screenY + playerRadius * 0.1;
        
        // Main breastplate with metallic gradient
        const cuirassGradient = ctx.createLinearGradient(
            screenX - cuirassWidth/2, cuirassY - cuirassHeight/2,
            screenX + cuirassWidth/2, cuirassY + cuirassHeight/2
        );
        cuirassGradient.addColorStop(0, metalLight);
        cuirassGradient.addColorStop(0.3, metalGrey);
        cuirassGradient.addColorStop(0.7, metalDark);
        cuirassGradient.addColorStop(1, metalGrey);
        
        ctx.fillStyle = cuirassGradient;
        ctx.strokeStyle = metalDark;
        ctx.lineWidth = 2;
        
        // Breastplate shape (rounded at top, straight at bottom)
        ctx.beginPath();
        ctx.moveTo(screenX - cuirassWidth/2, cuirassY - cuirassHeight/3);
        ctx.quadraticCurveTo(screenX - cuirassWidth/2, cuirassY - cuirassHeight/2, 
                            screenX - cuirassWidth/3, cuirassY - cuirassHeight/2);
        ctx.lineTo(screenX + cuirassWidth/3, cuirassY - cuirassHeight/2);
        ctx.quadraticCurveTo(screenX + cuirassWidth/2, cuirassY - cuirassHeight/2,
                            screenX + cuirassWidth/2, cuirassY - cuirassHeight/3);
        ctx.lineTo(screenX + cuirassWidth/2, cuirassY + cuirassHeight/2);
        ctx.lineTo(screenX - cuirassWidth/2, cuirassY + cuirassHeight/2);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        
        // Central ridge line on breastplate
        ctx.strokeStyle = metalLight;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(screenX, cuirassY - cuirassHeight/2);
        ctx.lineTo(screenX, cuirassY + cuirassHeight/2);
        ctx.stroke();
        
        // Armor plate seams
        ctx.strokeStyle = metalDark;
        ctx.lineWidth = 1;
        for (let i = 0; i < 3; i++) {
            const y = cuirassY - cuirassHeight/4 + i * (cuirassHeight/4);
            ctx.beginPath();
            ctx.moveTo(screenX - cuirassWidth/2.5, y);
            ctx.lineTo(screenX + cuirassWidth/2.5, y);
            ctx.stroke();
        }
        
        // === BELT WITH POUCHES (ABOVE ARMOR) ===
        const beltY = screenY + playerRadius * 0.3;
        const beltWidth = playerRadius * 1.8;
        const beltHeight = playerRadius * 0.22;
        
        // Leather belt
        const beltGradient = ctx.createLinearGradient(screenX, beltY - beltHeight/2, 
                                                      screenX, beltY + beltHeight/2);
        beltGradient.addColorStop(0, leatherDark);
        beltGradient.addColorStop(0.5, leatherBrown);
        beltGradient.addColorStop(1, leatherDark);
        
        ctx.fillStyle = beltGradient;
        ctx.strokeStyle = leatherDark;
        ctx.lineWidth = 1.5;
        this.drawRoundedRect(ctx, screenX - beltWidth/2, beltY - beltHeight/2, 
                            beltWidth, beltHeight, beltHeight * 0.2);
        ctx.fill();
        ctx.stroke();
        
        // Belt stitching
        ctx.strokeStyle = '#6b5a45';
        ctx.lineWidth = 0.8;
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.moveTo(screenX - beltWidth/2.2, beltY - beltHeight * 0.25);
        ctx.lineTo(screenX + beltWidth/2.2, beltY - beltHeight * 0.25);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(screenX - beltWidth/2.2, beltY + beltHeight * 0.25);
        ctx.lineTo(screenX + beltWidth/2.2, beltY + beltHeight * 0.25);
        ctx.stroke();
        ctx.setLineDash([]);
        
        // Pouches on belt
        const pouchWidth = beltWidth * 0.14;
        const pouchHeight = beltHeight * 1.3;
        const pouchPositions = [-0.6, -0.3, 0, 0.3, 0.6];
        
        for (const pos of pouchPositions) {
            const pouchX = screenX + pos * beltWidth/2;
            const pouchY = beltY + beltHeight * 0.4;
            
            // Pouch body
            const pouchGradient = ctx.createRadialGradient(pouchX, pouchY, 0, pouchX, pouchY, pouchWidth * 0.6);
            pouchGradient.addColorStop(0, '#8b6f47');
            pouchGradient.addColorStop(0.6, leatherBrown);
            pouchGradient.addColorStop(1, leatherDark);
            
            ctx.fillStyle = pouchGradient;
            ctx.strokeStyle = leatherDark;
            ctx.lineWidth = 1;
            
            ctx.beginPath();
            ctx.moveTo(pouchX - pouchWidth/2, pouchY);
            ctx.lineTo(pouchX - pouchWidth/2, pouchY + pouchHeight * 0.6);
            ctx.quadraticCurveTo(pouchX, pouchY + pouchHeight, pouchX + pouchWidth/2, pouchY + pouchHeight * 0.6);
            ctx.lineTo(pouchX + pouchWidth/2, pouchY);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
            
            // Pouch flap
            ctx.fillStyle = this.darken(leatherBrown, 10);
            ctx.beginPath();
            ctx.moveTo(pouchX - pouchWidth/2, pouchY);
            ctx.lineTo(pouchX - pouchWidth/2, pouchY + pouchHeight * 0.2);
            ctx.quadraticCurveTo(pouchX, pouchY + pouchHeight * 0.25, pouchX + pouchWidth/2, pouchY + pouchHeight * 0.2);
            ctx.lineTo(pouchX + pouchWidth/2, pouchY);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
        }
        
        // Belt buckle
        const buckleWidth = beltWidth * 0.12;
        const buckleHeight = beltHeight * 0.7;
        ctx.fillStyle = '#8b8b8b';
        ctx.strokeStyle = '#5a5a5a';
        ctx.lineWidth = 1.5;
        this.drawRoundedRect(ctx, screenX - buckleWidth/2, beltY - buckleHeight/2, 
                            buckleWidth, buckleHeight, buckleHeight * 0.15);
        ctx.fill();
        ctx.stroke();
        
        // === DRAB GREEN JACKET LAPELS ===
        const lapelWidth = playerRadius * 0.85;
        const lapelHeight = playerRadius * 1.6;
        const lapelY = screenY;
        
        // Left lapel
        const leftLapelX = screenX - playerRadius * 0.25;
        const leftLapelGradient = ctx.createLinearGradient(
            leftLapelX - lapelWidth, lapelY - lapelHeight/2,
            leftLapelX, lapelY + lapelHeight/2
        );
        leftLapelGradient.addColorStop(0, greenDark);
        leftLapelGradient.addColorStop(0.4, armyGreen);
        leftLapelGradient.addColorStop(1, greenDark);
        
        ctx.fillStyle = leftLapelGradient;
        ctx.strokeStyle = greenDark;
        ctx.lineWidth = 2;
        
        // Left lapel shape (angled)
        ctx.beginPath();
        ctx.moveTo(leftLapelX - lapelWidth, lapelY - lapelHeight/2);
        ctx.lineTo(leftLapelX - lapelWidth * 0.3, lapelY - lapelHeight/2);
        ctx.lineTo(leftLapelX, lapelY + lapelHeight/2);
        ctx.lineTo(leftLapelX - lapelWidth * 0.5, lapelY + lapelHeight/2);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        
        // Left lapel fold line
        ctx.strokeStyle = greenLight;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(leftLapelX - lapelWidth * 0.6, lapelY - lapelHeight/2);
        ctx.lineTo(leftLapelX - lapelWidth * 0.1, lapelY + lapelHeight/2);
        ctx.stroke();
        
        // Right lapel
        const rightLapelX = screenX + playerRadius * 0.25;
        const rightLapelGradient = ctx.createLinearGradient(
            rightLapelX, lapelY - lapelHeight/2,
            rightLapelX + lapelWidth, lapelY + lapelHeight/2
        );
        rightLapelGradient.addColorStop(0, greenDark);
        rightLapelGradient.addColorStop(0.6, armyGreen);
        rightLapelGradient.addColorStop(1, greenDark);
        
        ctx.fillStyle = rightLapelGradient;
        ctx.strokeStyle = greenDark;
        ctx.lineWidth = 2;
        
        // Right lapel shape (angled)
        ctx.beginPath();
        ctx.moveTo(rightLapelX + lapelWidth, lapelY - lapelHeight/2);
        ctx.lineTo(rightLapelX + lapelWidth * 0.3, lapelY - lapelHeight/2);
        ctx.lineTo(rightLapelX, lapelY + lapelHeight/2);
        ctx.lineTo(rightLapelX + lapelWidth * 0.5, lapelY + lapelHeight/2);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        
        // Right lapel fold line
        ctx.strokeStyle = greenLight;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(rightLapelX + lapelWidth * 0.6, lapelY - lapelHeight/2);
        ctx.lineTo(rightLapelX + lapelWidth * 0.1, lapelY + lapelHeight/2);
        ctx.stroke();
        
        // === CROSS BADGES ON LAPELS ===
        const badgeSize = playerRadius * 0.3;
        const badgeOffsetY = screenY - playerRadius * 0.35;
        
        // Left badge
        const leftBadgeX = leftLapelX - lapelWidth * 0.5;
        
        // Badge background (golden rectangle)
        ctx.fillStyle = badgeGold;
        ctx.strokeStyle = badgeGoldDark;
        ctx.lineWidth = 1.5;
        ctx.fillRect(leftBadgeX - badgeSize/2, badgeOffsetY - badgeSize * 0.6, badgeSize, badgeSize * 1.2);
        ctx.strokeRect(leftBadgeX - badgeSize/2, badgeOffsetY - badgeSize * 0.6, badgeSize, badgeSize * 1.2);
        
        // Cross on left badge
        ctx.fillStyle = badgeGoldDark;
        ctx.strokeStyle = '#8b7355';
        ctx.lineWidth = 0.8;
        const crossSize = badgeSize * 0.5;
        // Vertical
        ctx.fillRect(leftBadgeX - crossSize * 0.12, badgeOffsetY - crossSize * 0.6, crossSize * 0.24, crossSize * 1.2);
        ctx.strokeRect(leftBadgeX - crossSize * 0.12, badgeOffsetY - crossSize * 0.6, crossSize * 0.24, crossSize * 1.2);
        // Horizontal
        ctx.fillRect(leftBadgeX - crossSize * 0.5, badgeOffsetY - crossSize * 0.12, crossSize, crossSize * 0.24);
        ctx.strokeRect(leftBadgeX - crossSize * 0.5, badgeOffsetY - crossSize * 0.12, crossSize, crossSize * 0.24);
        
        // Right badge
        const rightBadgeX = rightLapelX + lapelWidth * 0.5;
        
        // Badge background
        ctx.fillStyle = badgeGold;
        ctx.strokeStyle = badgeGoldDark;
        ctx.lineWidth = 1.5;
        ctx.fillRect(rightBadgeX - badgeSize/2, badgeOffsetY - badgeSize * 0.6, badgeSize, badgeSize * 1.2);
        ctx.strokeRect(rightBadgeX - badgeSize/2, badgeOffsetY - badgeSize * 0.6, badgeSize, badgeSize * 1.2);
        
        // Cross on right badge
        ctx.fillStyle = badgeGoldDark;
        ctx.strokeStyle = '#8b7355';
        ctx.lineWidth = 0.8;
        // Vertical
        ctx.fillRect(rightBadgeX - crossSize * 0.12, badgeOffsetY - crossSize * 0.6, crossSize * 0.24, crossSize * 1.2);
        ctx.strokeRect(rightBadgeX - crossSize * 0.12, badgeOffsetY - crossSize * 0.6, crossSize * 0.24, crossSize * 1.2);
        // Horizontal
        ctx.fillRect(rightBadgeX - crossSize * 0.5, badgeOffsetY - crossSize * 0.12, crossSize, crossSize * 0.24);
        ctx.strokeRect(rightBadgeX - crossSize * 0.5, badgeOffsetY - crossSize * 0.12, crossSize, crossSize * 0.24);
        
        ctx.restore();
    }
    
    // Draw inquisitor - large red shoulder pauldrons with heraldic badges
    static drawInquisitor(ctx, screenX, screenY, playerRadius, color) {
        ctx.save();
        
        // Colors
        const inquisitorRed = '#6b2424';
        const redDark = '#4a1818';
        const redLight = '#8b3a3a';
        const metalGrey = '#8b8b8b';
        const metalDark = '#5a5a5a';
        const shieldTeal = '#4a7a7a';
        const shieldBrown = '#5c4033';
        const swordGold = '#d4af37';
        const swordGoldDark = '#b8941f';
        
        // === RED TORSO ARMOR (DRAW FIRST, UNDER PAULDRONS) ===
        const torsoWidth = playerRadius * 1.4;
        const torsoHeight = playerRadius * 1.2;
        const torsoY = screenY + playerRadius * 0.2;
        
        const torsoGradient = ctx.createLinearGradient(screenX, torsoY - torsoHeight/2, screenX, torsoY + torsoHeight/2);
        torsoGradient.addColorStop(0, redLight);
        torsoGradient.addColorStop(0.5, inquisitorRed);
        torsoGradient.addColorStop(1, redDark);
        
        ctx.fillStyle = torsoGradient;
        ctx.strokeStyle = redDark;
        ctx.lineWidth = 2;
        
        this.drawRoundedRect(ctx, screenX - torsoWidth/2, torsoY - torsoHeight/2, 
                            torsoWidth, torsoHeight, torsoHeight * 0.15);
        ctx.fill();
        ctx.stroke();
        
        // Torso armor seams
        ctx.strokeStyle = metalDark;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(screenX, torsoY - torsoHeight/2);
        ctx.lineTo(screenX, torsoY + torsoHeight/2);
        ctx.stroke();
        
        // === LARGE SHOULDER PAULDRONS (DRAW OVER TORSO) ===
        const pauldronSize = playerRadius * 1.3;
        const pauldronOffsetY = screenY - playerRadius * 0.4;
        
        // Left pauldron
        const leftX = screenX - playerRadius * 0.9;
        
        // Main pauldron body (large rounded armor plate)
        const leftGradient = ctx.createRadialGradient(leftX, pauldronOffsetY, 0, leftX, pauldronOffsetY, pauldronSize * 0.6);
        leftGradient.addColorStop(0, redLight);
        leftGradient.addColorStop(0.5, inquisitorRed);
        leftGradient.addColorStop(1, redDark);
        
        ctx.fillStyle = leftGradient;
        ctx.strokeStyle = redDark;
        ctx.lineWidth = 2.5;
        
        // Pauldron shape (large rounded with spiky edges)
        ctx.beginPath();
        // Top spike
        ctx.moveTo(leftX - pauldronSize * 0.15, pauldronOffsetY - pauldronSize * 0.5);
        ctx.lineTo(leftX - pauldronSize * 0.05, pauldronOffsetY - pauldronSize * 0.65);
        ctx.lineTo(leftX + pauldronSize * 0.05, pauldronOffsetY - pauldronSize * 0.5);
        // Right curve
        ctx.quadraticCurveTo(leftX + pauldronSize * 0.45, pauldronOffsetY - pauldronSize * 0.3,
                            leftX + pauldronSize * 0.45, pauldronOffsetY);
        // Right spike
        ctx.lineTo(leftX + pauldronSize * 0.5, pauldronOffsetY + pauldronSize * 0.15);
        ctx.lineTo(leftX + pauldronSize * 0.4, pauldronOffsetY + pauldronSize * 0.3);
        // Bottom
        ctx.lineTo(leftX - pauldronSize * 0.3, pauldronOffsetY + pauldronSize * 0.3);
        // Left spike
        ctx.lineTo(leftX - pauldronSize * 0.45, pauldronOffsetY + pauldronSize * 0.15);
        ctx.lineTo(leftX - pauldronSize * 0.4, pauldronOffsetY);
        // Left curve back to top
        ctx.quadraticCurveTo(leftX - pauldronSize * 0.4, pauldronOffsetY - pauldronSize * 0.3,
                            leftX - pauldronSize * 0.15, pauldronOffsetY - pauldronSize * 0.5);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        
        // Metallic trim on left pauldron
        ctx.strokeStyle = metalGrey;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        
        // Armor plates detail
        ctx.strokeStyle = redDark;
        ctx.lineWidth = 1;
        for (let i = 0; i < 3; i++) {
            const y = pauldronOffsetY - pauldronSize * 0.3 + i * (pauldronSize * 0.2);
            ctx.beginPath();
            ctx.moveTo(leftX - pauldronSize * 0.35, y);
            ctx.lineTo(leftX + pauldronSize * 0.35, y);
            ctx.stroke();
        }
        
        // Right pauldron
        const rightX = screenX + playerRadius * 0.9;
        
        const rightGradient = ctx.createRadialGradient(rightX, pauldronOffsetY, 0, rightX, pauldronOffsetY, pauldronSize * 0.6);
        rightGradient.addColorStop(0, redLight);
        rightGradient.addColorStop(0.5, inquisitorRed);
        rightGradient.addColorStop(1, redDark);
        
        ctx.fillStyle = rightGradient;
        ctx.strokeStyle = redDark;
        ctx.lineWidth = 2.5;
        
        // Right pauldron shape (mirrored)
        ctx.beginPath();
        // Top spike
        ctx.moveTo(rightX + pauldronSize * 0.15, pauldronOffsetY - pauldronSize * 0.5);
        ctx.lineTo(rightX + pauldronSize * 0.05, pauldronOffsetY - pauldronSize * 0.65);
        ctx.lineTo(rightX - pauldronSize * 0.05, pauldronOffsetY - pauldronSize * 0.5);
        // Left curve
        ctx.quadraticCurveTo(rightX - pauldronSize * 0.45, pauldronOffsetY - pauldronSize * 0.3,
                            rightX - pauldronSize * 0.45, pauldronOffsetY);
        // Left spike
        ctx.lineTo(rightX - pauldronSize * 0.5, pauldronOffsetY + pauldronSize * 0.15);
        ctx.lineTo(rightX - pauldronSize * 0.4, pauldronOffsetY + pauldronSize * 0.3);
        // Bottom
        ctx.lineTo(rightX + pauldronSize * 0.3, pauldronOffsetY + pauldronSize * 0.3);
        // Right spike
        ctx.lineTo(rightX + pauldronSize * 0.45, pauldronOffsetY + pauldronSize * 0.15);
        ctx.lineTo(rightX + pauldronSize * 0.4, pauldronOffsetY);
        // Right curve back to top
        ctx.quadraticCurveTo(rightX + pauldronSize * 0.4, pauldronOffsetY - pauldronSize * 0.3,
                            rightX + pauldronSize * 0.15, pauldronOffsetY - pauldronSize * 0.5);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        
        // Metallic trim on right pauldron
        ctx.strokeStyle = metalGrey;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        
        // Armor plates detail
        ctx.strokeStyle = redDark;
        ctx.lineWidth = 1;
        for (let i = 0; i < 3; i++) {
            const y = pauldronOffsetY - pauldronSize * 0.3 + i * (pauldronSize * 0.2);
            ctx.beginPath();
            ctx.moveTo(rightX - pauldronSize * 0.35, y);
            ctx.lineTo(rightX + pauldronSize * 0.35, y);
            ctx.stroke();
        }
        
        // === HERALDIC SHIELD BADGES (SMALLER, AT OVERLAP CORNER) ===
        const shieldWidth = pauldronSize * 0.4; // Smaller from 0.5
        const shieldHeight = pauldronSize * 0.48; // Smaller from 0.6
        
        // Left shield badge (positioned at overlap corner - more inward and lower)
        const leftBadgeX = screenX - playerRadius * 0.55; // More inward from leftX
        const leftBadgeY = pauldronOffsetY + pauldronSize * 0.15; // Lower, at overlap
        
        ctx.save();
        ctx.translate(leftBadgeX, leftBadgeY);
        
        // Shield outline
        ctx.strokeStyle = metalDark;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(-shieldWidth/2, -shieldHeight/2);
        ctx.lineTo(shieldWidth/2, -shieldHeight/2);
        ctx.lineTo(shieldWidth/2, shieldHeight/4);
        ctx.lineTo(0, shieldHeight/2);
        ctx.lineTo(-shieldWidth/2, shieldHeight/4);
        ctx.closePath();
        ctx.stroke();
        
        // Shield quarters (teal and brown)
        // Top left quarter (teal)
        ctx.fillStyle = shieldTeal;
        ctx.beginPath();
        ctx.moveTo(-shieldWidth/2, -shieldHeight/2);
        ctx.lineTo(0, -shieldHeight/2);
        ctx.lineTo(0, 0);
        ctx.lineTo(-shieldWidth/2, 0);
        ctx.closePath();
        ctx.fill();
        
        // Top right quarter (brown)
        ctx.fillStyle = shieldBrown;
        ctx.beginPath();
        ctx.moveTo(0, -shieldHeight/2);
        ctx.lineTo(shieldWidth/2, -shieldHeight/2);
        ctx.lineTo(shieldWidth/2, 0);
        ctx.lineTo(0, 0);
        ctx.closePath();
        ctx.fill();
        
        // Bottom left quarter (brown)
        ctx.fillStyle = shieldBrown;
        ctx.beginPath();
        ctx.moveTo(-shieldWidth/2, 0);
        ctx.lineTo(0, 0);
        ctx.lineTo(0, shieldHeight/4);
        ctx.lineTo(-shieldWidth/4, shieldHeight/4);
        ctx.closePath();
        ctx.fill();
        
        // Bottom right quarter (teal)
        ctx.fillStyle = shieldTeal;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(shieldWidth/2, 0);
        ctx.lineTo(shieldWidth/2, shieldHeight/4);
        ctx.lineTo(shieldWidth/4, shieldHeight/4);
        ctx.lineTo(0, shieldHeight/4);
        ctx.closePath();
        ctx.fill();
        
        // Center point
        ctx.beginPath();
        ctx.moveTo(0, shieldHeight/4);
        ctx.lineTo(-shieldWidth/4, shieldHeight/4);
        ctx.lineTo(0, shieldHeight/2);
        ctx.lineTo(shieldWidth/4, shieldHeight/4);
        ctx.closePath();
        ctx.fillStyle = shieldTeal;
        ctx.fill();
        
        // Gold sword in center
        ctx.fillStyle = swordGold;
        ctx.strokeStyle = swordGoldDark;
        ctx.lineWidth = 1;
        
        // Sword blade
        ctx.beginPath();
        ctx.moveTo(0, -shieldHeight/2.5);
        ctx.lineTo(-shieldWidth * 0.08, -shieldHeight/2.5 + shieldHeight * 0.1);
        ctx.lineTo(-shieldWidth * 0.05, shieldHeight/4);
        ctx.lineTo(shieldWidth * 0.05, shieldHeight/4);
        ctx.lineTo(shieldWidth * 0.08, -shieldHeight/2.5 + shieldHeight * 0.1);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        
        // Sword crossguard
        ctx.fillRect(-shieldWidth * 0.2, -shieldHeight/2.5 + shieldHeight * 0.08, shieldWidth * 0.4, shieldHeight * 0.06);
        ctx.strokeRect(-shieldWidth * 0.2, -shieldHeight/2.5 + shieldHeight * 0.08, shieldWidth * 0.4, shieldHeight * 0.06);
        
        // Sword pommel
        ctx.beginPath();
        ctx.arc(0, -shieldHeight/2.5, shieldWidth * 0.06, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        
        ctx.restore();
        
        // Right shield badge (positioned at overlap corner - more inward and lower)
        const rightBadgeX = screenX + playerRadius * 0.55; // More inward from rightX
        const rightBadgeY = pauldronOffsetY + pauldronSize * 0.15; // Lower, at overlap
        
        ctx.save();
        ctx.translate(rightBadgeX, rightBadgeY);
        
        // Shield outline
        ctx.strokeStyle = metalDark;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(-shieldWidth/2, -shieldHeight/2);
        ctx.lineTo(shieldWidth/2, -shieldHeight/2);
        ctx.lineTo(shieldWidth/2, shieldHeight/4);
        ctx.lineTo(0, shieldHeight/2);
        ctx.lineTo(-shieldWidth/2, shieldHeight/4);
        ctx.closePath();
        ctx.stroke();
        
        // Shield quarters
        ctx.fillStyle = shieldTeal;
        ctx.beginPath();
        ctx.moveTo(-shieldWidth/2, -shieldHeight/2);
        ctx.lineTo(0, -shieldHeight/2);
        ctx.lineTo(0, 0);
        ctx.lineTo(-shieldWidth/2, 0);
        ctx.closePath();
        ctx.fill();
        
        ctx.fillStyle = shieldBrown;
        ctx.beginPath();
        ctx.moveTo(0, -shieldHeight/2);
        ctx.lineTo(shieldWidth/2, -shieldHeight/2);
        ctx.lineTo(shieldWidth/2, 0);
        ctx.lineTo(0, 0);
        ctx.closePath();
        ctx.fill();
        
        ctx.fillStyle = shieldBrown;
        ctx.beginPath();
        ctx.moveTo(-shieldWidth/2, 0);
        ctx.lineTo(0, 0);
        ctx.lineTo(0, shieldHeight/4);
        ctx.lineTo(-shieldWidth/4, shieldHeight/4);
        ctx.closePath();
        ctx.fill();
        
        ctx.fillStyle = shieldTeal;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(shieldWidth/2, 0);
        ctx.lineTo(shieldWidth/2, shieldHeight/4);
        ctx.lineTo(shieldWidth/4, shieldHeight/4);
        ctx.lineTo(0, shieldHeight/4);
        ctx.closePath();
        ctx.fill();
        
        ctx.beginPath();
        ctx.moveTo(0, shieldHeight/4);
        ctx.lineTo(-shieldWidth/4, shieldHeight/4);
        ctx.lineTo(0, shieldHeight/2);
        ctx.lineTo(shieldWidth/4, shieldHeight/4);
        ctx.closePath();
        ctx.fillStyle = shieldTeal;
        ctx.fill();
        
        // Gold sword
        ctx.fillStyle = swordGold;
        ctx.strokeStyle = swordGoldDark;
        ctx.lineWidth = 1;
        
        ctx.beginPath();
        ctx.moveTo(0, -shieldHeight/2.5);
        ctx.lineTo(-shieldWidth * 0.08, -shieldHeight/2.5 + shieldHeight * 0.1);
        ctx.lineTo(-shieldWidth * 0.05, shieldHeight/4);
        ctx.lineTo(shieldWidth * 0.05, shieldHeight/4);
        ctx.lineTo(shieldWidth * 0.08, -shieldHeight/2.5 + shieldHeight * 0.1);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        
        ctx.fillRect(-shieldWidth * 0.2, -shieldHeight/2.5 + shieldHeight * 0.08, shieldWidth * 0.4, shieldHeight * 0.06);
        ctx.strokeRect(-shieldWidth * 0.2, -shieldHeight/2.5 + shieldHeight * 0.08, shieldWidth * 0.4, shieldHeight * 0.06);
        
        ctx.beginPath();
        ctx.arc(0, -shieldHeight/2.5, shieldWidth * 0.06, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        
        ctx.restore();
    }
    
    // Main render function - dispatches to specific skin type
    static render(ctx, screenX, screenY, playerRadius, skinName, skinColor) {
        if (!skinName || !skinColor) return;
        
        switch(skinName) {
            case 'Crusader Armor':
                this.drawCrusaderArmor(ctx, screenX, screenY, playerRadius, skinColor);
                break;
            case 'Iconoclast':
                this.drawIconoclast(ctx, screenX, screenY, playerRadius, skinColor);
                break;
            case 'Officer':
                this.drawOfficer(ctx, screenX, screenY, playerRadius, skinColor);
                break;
            case 'Inquisitor':
                this.drawInquisitor(ctx, screenX, screenY, playerRadius, skinColor);
                break;
            default:
                console.warn('Unknown skin type:', skinName);
        }
    }
    
    // Helper color functions (same as HatRenderer)
    static lighten(hexColor, percent) {
        const rgb = this.hexToRgb(hexColor);
        if (!rgb) return hexColor;
        const factor = 1 + percent / 100;
        return this.rgbToHex(
            Math.min(255, Math.round(rgb.r * factor)),
            Math.min(255, Math.round(rgb.g * factor)),
            Math.min(255, Math.round(rgb.b * factor))
        );
    }
    
    static darken(hexColor, percent) {
        const rgb = this.hexToRgb(hexColor);
        if (!rgb) return hexColor;
        const factor = 1 - percent / 100;
        return this.rgbToHex(
            Math.max(0, Math.round(rgb.r * factor)),
            Math.max(0, Math.round(rgb.g * factor)),
            Math.max(0, Math.round(rgb.b * factor))
        );
    }
    
    static hexToRgb(hex) {
        const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        return result ? {
            r: parseInt(result[1], 16),
            g: parseInt(result[2], 16),
            b: parseInt(result[3], 16)
        } : null;
    }
    
    static rgbToHex(r, g, b) {
        return "#" + [r, g, b].map(x => {
            const hex = x.toString(16);
            return hex.length === 1 ? "0" + hex : hex;
        }).join('');
    }
}

// Export for use in other modules
if (typeof window !== 'undefined') {
    window.SkinRenderer = SkinRenderer;
}

