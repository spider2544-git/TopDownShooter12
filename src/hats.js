// Hat rendering functions for cosmetic items
// All hats stay upright regardless of player rotation

class HatRenderer {
    // Draw a capirote (tall conical hat made of rusted metal - Trench Crusade style)
    static drawCapirote(ctx, screenX, screenY, playerRadius, color) {
        const hatHeight = playerRadius * 2.8; // Very tall conical shape
        const hatBase = playerRadius * 0.8;
        const hatBottom = screenY - playerRadius * 0.75; // Bottom 25% down the player sphere
        const hatTop = hatBottom - hatHeight;
        
        ctx.save();
        
        // Main cone body (rusted metal texture)
        const gradient = ctx.createLinearGradient(screenX, hatTop, screenX, hatBottom);
        gradient.addColorStop(0, color); // Base color at top
        gradient.addColorStop(0.4, this.lighten(color, 20)); // Highlight
        gradient.addColorStop(0.7, this.darken(color, 20)); // Shadow
        gradient.addColorStop(1, this.darken(color, 30)); // Bottom shadow
        
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.moveTo(screenX, hatTop); // Tip
        ctx.lineTo(screenX + hatBase, hatBottom); // Right base
        ctx.lineTo(screenX - hatBase, hatBottom); // Left base
        ctx.closePath();
        ctx.fill();
        
        // Outline
        ctx.strokeStyle = this.darken(color, 40);
        ctx.lineWidth = 2;
        ctx.stroke();
        
        // Cross emblem in the centerline (Trench Crusade style)
        const crossCenterY = hatBottom - hatHeight * 0.5;
        const crossSize = hatBase * 0.4;
        ctx.fillStyle = this.darken(color, 60);
        ctx.strokeStyle = this.darken(color, 70);
        ctx.lineWidth = 1;
        
        // Vertical bar of cross
        ctx.fillRect(screenX - crossSize * 0.12, crossCenterY - crossSize * 0.7, crossSize * 0.24, crossSize * 1.4);
        ctx.strokeRect(screenX - crossSize * 0.12, crossCenterY - crossSize * 0.7, crossSize * 0.24, crossSize * 1.4);
        
        // Horizontal bar of cross
        ctx.fillRect(screenX - crossSize * 0.6, crossCenterY - crossSize * 0.12, crossSize * 1.2, crossSize * 0.24);
        ctx.strokeRect(screenX - crossSize * 0.6, crossCenterY - crossSize * 0.12, crossSize * 1.2, crossSize * 0.24);
        
        // Symmetrical offset grid pattern of holes (ventilation pattern)
        const faceAreaStartY = hatBottom - hatHeight * 0.35;
        const faceAreaHeight = hatHeight * 0.25;
        const holeRadius = hatBase * 0.08;
        const horizontalSpacing = hatBase * 0.22;
        const verticalSpacing = hatHeight * 0.08;
        
        ctx.fillStyle = '#000000';
        
        // Create offset grid pattern (5 rows, alternating columns)
        for (let row = 0; row < 5; row++) {
            const y = faceAreaStartY + row * verticalSpacing;
            // Offset every other row for a brick-like pattern
            const offset = (row % 2 === 0) ? 0 : horizontalSpacing * 0.5;
            const numHoles = (row % 2 === 0) ? 3 : 2;
            
            for (let col = 0; col < numHoles; col++) {
                // Center the pattern
                const startX = (row % 2 === 0) ? 
                    screenX - horizontalSpacing : 
                    screenX - horizontalSpacing * 0.5;
                const x = startX + col * horizontalSpacing;
                
                // Draw hole
                ctx.beginPath();
                ctx.arc(x, y, holeRadius, 0, Math.PI * 2);
                ctx.fill();
                
                // Metallic edge highlight
                ctx.save();
                ctx.strokeStyle = this.lighten(color, 10);
                ctx.lineWidth = 0.8;
                ctx.stroke();
                ctx.restore();
            }
        }
        
        // Rust spots/weathering (small dark patches on the metal)
        ctx.fillStyle = this.darken(color, 50);
        for (let i = 0; i < 5; i++) {
            const rustY = hatTop + (hatHeight * (0.2 + i * 0.15));
            const rustX = screenX + (i % 2 === 0 ? hatBase * 0.4 : -hatBase * 0.35);
            ctx.beginPath();
            ctx.arc(rustX, rustY, 1.5, 0, Math.PI * 2);
            ctx.fill();
        }
        
        ctx.restore();
    }
    
    // Draw a papal mitre (inquisitor red with ornate cross)
    static drawPopeHat(ctx, screenX, screenY, playerRadius, color) {
        const hatHeight = playerRadius * 2.2; // Taller mitre
        const hatWidth = playerRadius * 1.3;
        const hatBottom = screenY - playerRadius * 0.75; // Bottom 25% down the player sphere
        const hatTop = hatBottom - hatHeight;
        const bandHeight = playerRadius * 0.3;
        
        ctx.save();
        
        // Inquisitor red color scheme
        const inquisitorRed = '#6b2424';
        const redDark = '#4a1818';
        const redLight = '#8b3a3a';
        
        // Main mitre body (red gradient)
        const gradient = ctx.createLinearGradient(screenX, hatTop, screenX, hatBottom);
        gradient.addColorStop(0, redLight);
        gradient.addColorStop(0.5, inquisitorRed);
        gradient.addColorStop(1, redDark);
        
        ctx.fillStyle = gradient;
        ctx.beginPath();
        // Taller, more pointed mitre shape
        ctx.moveTo(screenX - hatWidth * 0.5, hatBottom);
        ctx.lineTo(screenX - hatWidth * 0.35, hatBottom - hatHeight * 0.6);
        ctx.quadraticCurveTo(screenX - hatWidth * 0.25, hatTop - hatHeight * 0.05, screenX, hatTop);
        ctx.quadraticCurveTo(screenX + hatWidth * 0.25, hatTop - hatHeight * 0.05, screenX + hatWidth * 0.35, hatBottom - hatHeight * 0.6);
        ctx.lineTo(screenX + hatWidth * 0.5, hatBottom);
        ctx.closePath();
        ctx.fill();
        
        // Outline
        ctx.strokeStyle = redDark;
        ctx.lineWidth = 2;
        ctx.stroke();
        
        // Central vertical band
        const bandWidth = hatWidth * 0.35;
        ctx.fillStyle = this.darken(inquisitorRed, 10);
        ctx.beginPath();
        ctx.moveTo(screenX - bandWidth * 0.5, hatBottom);
        ctx.lineTo(screenX - bandWidth * 0.35, hatBottom - hatHeight * 0.6);
        ctx.quadraticCurveTo(screenX - bandWidth * 0.25, hatTop - hatHeight * 0.05, screenX, hatTop);
        ctx.quadraticCurveTo(screenX + bandWidth * 0.25, hatTop - hatHeight * 0.05, screenX + bandWidth * 0.35, hatBottom - hatHeight * 0.6);
        ctx.lineTo(screenX + bandWidth * 0.5, hatBottom);
        ctx.closePath();
        ctx.fill();
        
        // Ornate cross with fleur-de-lis style ends (gold colored)
        const crossCenterY = hatBottom - hatHeight * 0.45;
        const crossSize = hatWidth * 0.25;
        const crossColor = '#d4af37'; // Gold for the cross
        const crossOutline = '#b8941f';
        
        ctx.fillStyle = crossColor;
        ctx.strokeStyle = crossOutline;
        ctx.lineWidth = 1;
        
        // Vertical bar of cross
        ctx.fillRect(screenX - crossSize * 0.08, crossCenterY - crossSize * 0.7, crossSize * 0.16, crossSize * 1.4);
        ctx.strokeRect(screenX - crossSize * 0.08, crossCenterY - crossSize * 0.7, crossSize * 0.16, crossSize * 1.4);
        
        // Horizontal bar of cross
        ctx.fillRect(screenX - crossSize * 0.6, crossCenterY - crossSize * 0.08, crossSize * 1.2, crossSize * 0.16);
        ctx.strokeRect(screenX - crossSize * 0.6, crossCenterY - crossSize * 0.08, crossSize * 1.2, crossSize * 0.16);
        
        // Fleur-de-lis style decorative ends on cross arms
        const drawFleurTip = (x, y, angle) => {
            ctx.save();
            ctx.translate(x, y);
            ctx.rotate(angle);
            ctx.beginPath();
            ctx.moveTo(0, -3);
            ctx.lineTo(-2, 0);
            ctx.quadraticCurveTo(-1.5, 1, 0, 2);
            ctx.quadraticCurveTo(1.5, 1, 2, 0);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
            ctx.restore();
        };
        
        // Top fleur
        drawFleurTip(screenX, crossCenterY - crossSize * 0.7, 0);
        // Bottom fleur
        drawFleurTip(screenX, crossCenterY + crossSize * 0.7, Math.PI);
        // Left fleur
        drawFleurTip(screenX - crossSize * 0.6, crossCenterY, -Math.PI / 2);
        // Right fleur
        drawFleurTip(screenX + crossSize * 0.6, crossCenterY, Math.PI / 2);
        
        // Crown/band at the bottom
        ctx.fillStyle = crossColor;
        ctx.strokeStyle = crossOutline;
        ctx.lineWidth = 1.5;
        ctx.fillRect(screenX - hatWidth * 0.5, hatBottom - bandHeight, hatWidth, bandHeight);
        ctx.strokeRect(screenX - hatWidth * 0.5, hatBottom - bandHeight, hatWidth, bandHeight);
        
        // Decorative gold trim lines on band
        ctx.strokeStyle = crossOutline;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(screenX - hatWidth * 0.5, hatBottom - bandHeight * 0.3);
        ctx.lineTo(screenX + hatWidth * 0.5, hatBottom - bandHeight * 0.3);
        ctx.stroke();
        
        ctx.restore();
    }
    
    // Draw a Prussian WWI Pickelhaube helmet (Trench Crusade style - angular and menacing)
    static drawPrussianHelmet(ctx, screenX, screenY, playerRadius, color) {
        const helmetHeight = playerRadius * 1.85; // Scaled up from 1.5
        const helmetWidth = playerRadius * 1.6; // Scaled up from 1.3
        const helmetBottom = screenY - playerRadius * 0.75; // Bottom 25% down the player sphere
        const helmetTop = helmetBottom - helmetHeight;
        const spikeHeight = playerRadius * 1.1; // Scaled up from 0.9
        
        ctx.save();
        
        // Main helmet dome (darker, more angular)
        const gradient = ctx.createLinearGradient(screenX - helmetWidth * 0.5, helmetTop, screenX + helmetWidth * 0.5, helmetTop);
        gradient.addColorStop(0, this.darken(color, 35));
        gradient.addColorStop(0.5, this.darken(color, 15));
        gradient.addColorStop(1, this.darken(color, 40));
        
        ctx.fillStyle = gradient;
        ctx.beginPath();
        // More angular dome shape
        ctx.moveTo(screenX - helmetWidth * 0.5, helmetBottom - helmetHeight * 0.3);
        ctx.lineTo(screenX - helmetWidth * 0.45, helmetTop + helmetHeight * 0.2);
        ctx.quadraticCurveTo(screenX - helmetWidth * 0.3, helmetTop, screenX, helmetTop);
        ctx.quadraticCurveTo(screenX + helmetWidth * 0.3, helmetTop, screenX + helmetWidth * 0.45, helmetTop + helmetHeight * 0.2);
        ctx.lineTo(screenX + helmetWidth * 0.5, helmetBottom - helmetHeight * 0.3);
        ctx.lineTo(screenX + helmetWidth * 0.35, helmetBottom);
        ctx.lineTo(screenX - helmetWidth * 0.35, helmetBottom);
        ctx.closePath();
        ctx.fill();
        
        // Helmet outline (thicker, darker)
        ctx.strokeStyle = this.darken(color, 60);
        ctx.lineWidth = 2.5;
        ctx.stroke();
        
        // Prominent spike on top (longer and sharper)
        const spikeGradient = ctx.createLinearGradient(screenX, helmetTop - spikeHeight, screenX, helmetTop);
        spikeGradient.addColorStop(0, this.lighten(color, 5));
        spikeGradient.addColorStop(1, this.darken(color, 20));
        
        ctx.fillStyle = spikeGradient;
        ctx.beginPath();
        ctx.moveTo(screenX, helmetTop - spikeHeight); // Sharp tip
        ctx.lineTo(screenX + 5, helmetTop + 2); // Right base (wider)
        ctx.lineTo(screenX - 5, helmetTop + 2); // Left base
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = this.darken(color, 55);
        ctx.lineWidth = 2;
        ctx.stroke();
        
        // Spike base plate (ring around spike)
        ctx.fillStyle = this.darken(color, 25);
        ctx.beginPath();
        ctx.arc(screenX, helmetTop + 2, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = this.darken(color, 60);
        ctx.lineWidth = 1.5;
        ctx.stroke();
        
        // Angular face guard with horizontal eye slit
        const faceGuardY = helmetTop + helmetHeight * 0.5;
        ctx.fillStyle = this.darken(color, 20);
        ctx.fillRect(screenX - helmetWidth * 0.35, faceGuardY, helmetWidth * 0.7, helmetHeight * 0.35);
        ctx.strokeStyle = this.darken(color, 55);
        ctx.lineWidth = 2;
        ctx.strokeRect(screenX - helmetWidth * 0.35, faceGuardY, helmetWidth * 0.7, helmetHeight * 0.35);
        
        // Horizontal eye slit
        const slitY = faceGuardY + helmetHeight * 0.15;
        const slitWidth = helmetWidth * 0.55;
        const slitHeight = helmetHeight * 0.06;
        ctx.fillStyle = '#000000';
        ctx.fillRect(screenX - slitWidth * 0.5, slitY, slitWidth, slitHeight);
        ctx.strokeStyle = this.darken(color, 50);
        ctx.lineWidth = 1;
        ctx.strokeRect(screenX - slitWidth * 0.5, slitY, slitWidth, slitHeight);
        
        // Breathing holes below eye slit (small circles)
        const breathY = slitY + helmetHeight * 0.12;
        ctx.fillStyle = '#000000';
        for (let i = -2; i <= 2; i++) {
            if (i === 0) continue; // Skip center
            ctx.beginPath();
            ctx.arc(screenX + i * (helmetWidth * 0.12), breathY, 2, 0, Math.PI * 2);
            ctx.fill();
        }
        
        // Cross symbol on forehead plate
        const crossY = faceGuardY - helmetHeight * 0.15;
        const crossSize = helmetWidth * 0.12;
        ctx.strokeStyle = this.darken(color, 65);
        ctx.lineWidth = 2;
        // Vertical bar
        ctx.beginPath();
        ctx.moveTo(screenX, crossY - crossSize * 0.5);
        ctx.lineTo(screenX, crossY + crossSize * 0.5);
        ctx.stroke();
        // Horizontal bar
        ctx.beginPath();
        ctx.moveTo(screenX - crossSize * 0.4, crossY);
        ctx.lineTo(screenX + crossSize * 0.4, crossY);
        ctx.stroke();
        
        // Rivets on helmet (metal construction details)
        const rivetColor = this.darken(color, 50);
        const rivetRadius = 1.5;
        ctx.fillStyle = rivetColor;
        
        // Rivets along center seam
        for (let i = 0; i < 3; i++) {
            const ry = helmetTop + helmetHeight * (0.15 + i * 0.2);
            ctx.beginPath();
            ctx.arc(screenX, ry, rivetRadius, 0, Math.PI * 2);
            ctx.fill();
        }
        
        // Side rivets
        [-1, 1].forEach(side => {
            for (let i = 0; i < 2; i++) {
                const rx = screenX + side * helmetWidth * 0.35;
                const ry = helmetTop + helmetHeight * (0.3 + i * 0.3);
                ctx.beginPath();
                ctx.arc(rx, ry, rivetRadius, 0, Math.PI * 2);
                ctx.fill();
            }
        });
        
        // Battle damage (scratches and dents)
        ctx.strokeStyle = this.darken(color, 55);
        ctx.lineWidth = 1;
        // Scratch on left side
        ctx.beginPath();
        ctx.moveTo(screenX - helmetWidth * 0.3, helmetTop + helmetHeight * 0.25);
        ctx.lineTo(screenX - helmetWidth * 0.25, helmetTop + helmetHeight * 0.32);
        ctx.stroke();
        // Scratch on right side
        ctx.beginPath();
        ctx.moveTo(screenX + helmetWidth * 0.25, helmetTop + helmetHeight * 0.4);
        ctx.lineTo(screenX + helmetWidth * 0.32, helmetTop + helmetHeight * 0.45);
        ctx.stroke();
        
        ctx.restore();
    }
    
    // Draw a medieval knight's great helm (Trench Crusade style - plain and angular)
    static drawKnightHelmet(ctx, screenX, screenY, playerRadius, color) {
        const helmetHeight = playerRadius * 1.6;
        const helmetWidth = playerRadius * 1.1;
        const helmetBottom = screenY - playerRadius * 0.75; // Bottom 25% down the player sphere
        const helmetTop = helmetBottom - helmetHeight;
        
        ctx.save();
        
        // Main helmet body (boxy, angular shape - less curved than before)
        const gradient = ctx.createLinearGradient(screenX - helmetWidth * 0.5, helmetTop, screenX + helmetWidth * 0.5, helmetTop);
        gradient.addColorStop(0, this.darken(color, 30));
        gradient.addColorStop(0.5, this.darken(color, 10));
        gradient.addColorStop(1, this.darken(color, 35));
        
        ctx.fillStyle = gradient;
        ctx.beginPath();
        // Boxy, angular shape with flat sides
        ctx.moveTo(screenX - helmetWidth * 0.5, helmetBottom);
        ctx.lineTo(screenX - helmetWidth * 0.48, helmetTop + helmetHeight * 0.1);
        ctx.lineTo(screenX - helmetWidth * 0.4, helmetTop);
        ctx.lineTo(screenX + helmetWidth * 0.4, helmetTop);
        ctx.lineTo(screenX + helmetWidth * 0.48, helmetTop + helmetHeight * 0.1);
        ctx.lineTo(screenX + helmetWidth * 0.5, helmetBottom);
        ctx.closePath();
        ctx.fill();
        
        // Outline (thicker, darker for that weathered look)
        ctx.strokeStyle = this.darken(color, 60);
        ctx.lineWidth = 2.5;
        ctx.stroke();
        
        // Horizontal eye slit (narrow viewing slot)
        const slitY = helmetTop + helmetHeight * 0.5;
        const slitWidth = helmetWidth * 0.65;
        const slitHeight = helmetHeight * 0.08;
        
        ctx.fillStyle = '#000000';
        
        // Main horizontal slit
        ctx.fillRect(
            screenX - slitWidth * 0.5,
            slitY - slitHeight * 0.5,
            slitWidth,
            slitHeight
        );
        
        // Subtle metal edges around the slit (showing depth)
        ctx.strokeStyle = this.darken(color, 50);
        ctx.lineWidth = 1;
        ctx.strokeRect(
            screenX - slitWidth * 0.5,
            slitY - slitHeight * 0.5,
            slitWidth,
            slitHeight
        );
        
        // Inner shadow edge (top of slit darker)
        ctx.fillStyle = this.darken(color, 55);
        ctx.fillRect(
            screenX - slitWidth * 0.5,
            slitY - slitHeight * 0.5,
            slitWidth,
            slitHeight * 0.25
        );
        
        // Metal plates/panels (weathered look)
        ctx.strokeStyle = this.darken(color, 45);
        ctx.lineWidth = 1.5;
        
        // Vertical center seam
        ctx.beginPath();
        ctx.moveTo(screenX, helmetTop);
        ctx.lineTo(screenX, helmetBottom);
        ctx.stroke();
        
        // Horizontal plate line near top
        ctx.beginPath();
        ctx.moveTo(screenX - helmetWidth * 0.4, helmetTop + helmetHeight * 0.2);
        ctx.lineTo(screenX + helmetWidth * 0.4, helmetTop + helmetHeight * 0.2);
        ctx.stroke();
        
        // Battle damage/wear marks (small dents and scratches)
        ctx.strokeStyle = this.darken(color, 50);
        ctx.lineWidth = 1;
        
        // Random wear marks on left side
        ctx.beginPath();
        ctx.moveTo(screenX - helmetWidth * 0.3, helmetTop + helmetHeight * 0.35);
        ctx.lineTo(screenX - helmetWidth * 0.25, helmetTop + helmetHeight * 0.38);
        ctx.stroke();
        
        // Random wear marks on right side
        ctx.beginPath();
        ctx.moveTo(screenX + helmetWidth * 0.25, helmetTop + helmetHeight * 0.7);
        ctx.lineTo(screenX + helmetWidth * 0.32, helmetTop + helmetHeight * 0.72);
        ctx.stroke();
        
        ctx.restore();
    }
    
    // Main render function - dispatches to specific hat type
    static render(ctx, screenX, screenY, playerRadius, hatName, hatColor) {
        if (!hatName || !hatColor) return;
        
        switch(hatName) {
            case 'Capirote':
                this.drawCapirote(ctx, screenX, screenY, playerRadius, hatColor);
                break;
            case 'Pope Hat':
                this.drawPopeHat(ctx, screenX, screenY, playerRadius, hatColor);
                break;
            case 'Prussian Helmet':
                this.drawPrussianHelmet(ctx, screenX, screenY, playerRadius, hatColor);
                break;
            case 'Knight Helmet':
                this.drawKnightHelmet(ctx, screenX, screenY, playerRadius, hatColor);
                break;
            default:
                console.warn('Unknown hat type:', hatName);
        }
    }
    
    // Helper color functions
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
    window.HatRenderer = HatRenderer;
}

