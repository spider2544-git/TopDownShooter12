// Server-side Troops Manager (allied units on player team)
// Mirrors enemiesState pattern: server-authoritative positions broadcast at 10Hz.
// Troops are friendly units that spawn behind players in Trench Raid and follow/charge.

class TroopManager {
    constructor(room, io, opts = {}) {
        this.room = room;
        this.io = io;
        this.troops = new Map();
        this.BROADCAST_HZ = opts.broadcastHz || 10;
        this._broadcastIntervalMs = 1000 / this.BROADCAST_HZ;
        this._nextBroadcastTime = 0;
        this.barracks = [];
        this._nextTroopId = 0;
        this._spawnCooldowns = new Map();
    }
    
    _getAntiClumpingSeparation(troop) {
        const separationRadius = 70;
        const separationForce = { x: 0, y: 0 };
        let nearbyCount = 0;
        for (const other of this.troops.values()) {
            if (!other || !other.alive || other.id === troop.id) continue;
            const odx = troop.x - other.x;
            const ody = troop.y - other.y;
            const odist = Math.hypot(odx, ody);
            if (odist < separationRadius && odist > 0.1) {
                const force = (separationRadius - odist) / separationRadius;
                separationForce.x += (odx / odist) * force;
                separationForce.y += (ody / odist) * force;
                nearbyCount++;
            }
        }
        if (nearbyCount > 0) {
            separationForce.x /= nearbyCount;
            separationForce.y /= nearbyCount;
            return separationForce;
        }
        return null;
    }
}

module.exports = { TroopManager };
