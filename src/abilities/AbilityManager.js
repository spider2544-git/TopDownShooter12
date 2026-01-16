// Manages all active secondary weapon abilities
class AbilityManager {
    constructor() {
        this.abilities = [];
        this._feedbackText = null;
        this._feedbackTimer = 0;
    }
    
    /**
     * Request ability creation from server (server-authoritative)
     * @param {Class} AbilityClass - The ability class (e.g., ShieldWall)
     * @param {number} bloodCost - Blood markers required
     * @param {Player} player - The player creating the ability
     * @param {...any} abilityArgs - Arguments to pass to ability constructor
     * @returns {boolean} true if request sent successfully
     */
    tryCreateAbility(AbilityClass, bloodCost, player, ...abilityArgs) {
        if (!player) return false;
        
        // Check if player has enough blood markers (client-side check for immediate feedback)
        if (!player.bloodMarkers || player.bloodMarkers < bloodCost) {
            this.showFeedback('Out of Blood Markers', '#ff4444');
            return false;
        }
        
        // Request server to create ability (server is authoritative)
        if (window.networkManager?.connected) {
            window.networkManager.socket.emit('abilityCreate', {
                type: AbilityClass.name,
                bloodCost: bloodCost,
                args: abilityArgs
            });
            console.log('[AbilityManager] Requested', AbilityClass.name, 'from server');
            return true;
        } else {
            console.error('[AbilityManager] Not connected to server');
            return false;
        }
    }
    
    /**
     * Add an ability created by server (from network sync)
     * @param {Class} AbilityClass - The ability class
     * @param {object} data - Server data including owner, position, etc.
     */
    addServerAbility(AbilityClass, data) {
        // Find owner player
        let owner = null;
        if (data.ownerId === window.player?.id) {
            owner = window.player;
        } else if (window.networkManager?.otherPlayers) {
            owner = window.networkManager.otherPlayers.get(data.ownerId);
        }
        
        // Create ability with server data
        const ability = new AbilityClass(owner, ...data.args);
        ability._serverId = data.serverId;
        ability.serverSync = true;
        
        this.abilities.push(ability);
        return ability;
    }
    
    /**
     * Update all active abilities
     */
    update(dt, environment, enemies, players) {
        // Update feedback text timer
        if (this._feedbackTimer > 0) {
            this._feedbackTimer -= dt;
        }
        
        // Update all abilities and remove dead ones
        for (let i = this.abilities.length - 1; i >= 0; i--) {
            const ability = this.abilities[i];
            
            if (!ability.alive) {
                this.abilities.splice(i, 1);
                continue;
            }
            
            ability.update(dt, environment, enemies, players);
        }
    }
    
    /**
     * Draw all abilities
     */
    draw(ctx, camera, localPlayer) {
        // Draw abilities
        for (const ability of this.abilities) {
            if (ability.alive) {
                ability.draw(ctx, camera);
            }
        }
        
        // Draw feedback text above player
        if (this._feedbackTimer > 0 && this._feedbackText && localPlayer) {
            const screenX = localPlayer.x - camera.x;
            const screenY = localPlayer.y - camera.y - (localPlayer.radius || 26) - 40;
            
            ctx.save();
            ctx.font = 'bold 18px Arial';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            
            // Shadow
            ctx.fillStyle = 'rgba(0,0,0,0.6)';
            ctx.fillText(this._feedbackText, screenX + 2, screenY + 2);
            
            // Main text
            ctx.fillStyle = this._feedbackColor || '#ff4444';
            ctx.fillText(this._feedbackText, screenX, screenY);
            
            ctx.restore();
        }
    }
    
    /**
     * Show feedback text above player
     */
    showFeedback(text, color = '#ffffff') {
        this._feedbackText = text;
        this._feedbackColor = color;
        this._feedbackTimer = 2.0; // Show for 2 seconds
    }
    
    /**
     * Find ability by server ID
     */
    findByServerId(serverId) {
        return this.abilities.find(a => a._serverId === serverId);
    }
    
    /**
     * Find ability by client ID
     */
    findByClientId(clientId) {
        return this.abilities.find(a => a.id === clientId);
    }
    
    /**
     * Remove ability by server ID
     */
    removeByServerId(serverId) {
        const idx = this.abilities.findIndex(a => a._serverId === serverId);
        if (idx >= 0) {
            const ability = this.abilities[idx];
            if (ability.onExpire) ability.onExpire();
            this.abilities.splice(idx, 1);
            return true;
        }
        return false;
    }
}

window.AbilityManager = AbilityManager;

