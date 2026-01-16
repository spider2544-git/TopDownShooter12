// Base class for all secondary weapon abilities
class AbilityBase {
    constructor(x, y, owner, options = {}) {
        if (typeof AbilityBase._nextId !== 'number') AbilityBase._nextId = 1;
        this.id = AbilityBase._nextId++;
        this.x = Number(x) || 0;
        this.y = Number(y) || 0;
        this.owner = owner; // Player who created this ability
        this.ownerId = owner ? owner.id : null;
        this.alive = true;
        this.age = 0;
        
        // Server replication
        this._serverId = options._serverId || null;
        this.serverSync = !!options.serverSync;
        
        // Visual
        this.radius = options.radius || 20;
        this.color = options.color || '#ffffff';
        
        // Lifetime
        this.maxLife = options.maxLife || null; // null = permanent until destroyed
        this.lifeLeft = this.maxLife;
    }
    
    update(dt, environment, enemies, players) {
        if (!this.alive) return;
        this.age += dt;
        
        if (this.lifeLeft !== null) {
            this.lifeLeft -= dt;
            if (this.lifeLeft <= 0) {
                this.alive = false;
                this.onExpire();
            }
        }
    }
    
    draw(ctx, camera) {
        // Override in subclasses
    }
    
    onExpire() {
        // Override for cleanup/death effects
    }
    
    takeDamage(amount) {
        // Override for damageable abilities
    }
    
    // Check if this ability is hostile to a given player (for PvP)
    isHostileTo(player) {
        if (!this.owner || !player) return false;
        try {
            // Check if owner and player have different evil states
            const ownerEvil = window.networkManager?.remotePlayerEvilStates?.get(this.ownerId) || 
                             (this.owner === window.player && window.__killThemAllLocked === true);
            const playerEvil = (player === window.player && window.__killThemAllLocked === true) ||
                             window.networkManager?.remotePlayerEvilStates?.get(player.id);
            return ownerEvil !== playerEvil;
        } catch(_) {}
        return false;
    }
}

window.AbilityBase = AbilityBase;

