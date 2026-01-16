/**
 * NPC Handlers - Phase 6
 * 
 * Handles NPC damage, DOT, and state changes
 * Extracted from server.js to improve modularity
 * 
 * Handlers:
 * - npcDamage: Handles direct damage to NPCs (~18 lines)
 * - npcDot: Handles DOT (Damage Over Time) application to NPCs (~18 lines)
 * - npcSetState: Handles NPC state changes (hostile, dialogue, etc.) (~11 lines)
 */

module.exports = function createNpcHandlers({ io, rooms, Protocol }) {
    return {
        /**
         * npcDamage - Handles direct damage dealt to NPCs
         * Server-authoritative damage validation
         */
        npcDamage: (socket, data) => {
            // data: { npcId, damage, noDamage }
            const npcId = data && data.npcId;
            const damage = data && typeof data.damage === 'number' ? data.damage : 0;
            
            if (!npcId || damage <= 0) return;
            // Note: Removed noDamage check - weapon 1 melee uses noDamage=true for VFX suppression
            // but still sends real damage values that must be processed
            
            // Find which room this player is in and damage the NPC
            for (const [roomId, room] of rooms) {
                if (room.players.has(socket.id)) {
                    if (room.npcManager) {
                        room.npcManager.damageNPC(npcId, damage, socket.id);
                    }
                    break;
                }
            }
        },

        /**
         * npcDot - Handles DOT (Damage Over Time) application to NPCs
         * Applies fire, poison, or other DOT effects
         */
        npcDot: (socket, data) => {
            // data: { npcId, dps, duration }
            const npcId = data && data.npcId;
            const dps = data && typeof data.dps === 'number' ? data.dps : 0;
            const duration = data && typeof data.duration === 'number' ? data.duration : 0;
            
            if (!npcId || dps <= 0 || duration <= 0) return;
            
            // Find which room this player is in and apply DOT to the NPC
            for (const [roomId, room] of rooms) {
                if (room.players.has(socket.id)) {
                    if (room.npcManager) {
                        room.npcManager.applyNpcDot(npcId, dps, duration, socket.id);
                    }
                    break;
                }
            }
        },

        /**
         * npcSetState - Handles NPC state changes
         * Changes NPC state (hostile, dialogue, friendly, etc.)
         */
        npcSetState: (socket, data) => {
            // Find which room this player is in
            for (const [roomId, room] of rooms) {
                if (room.players.has(socket.id)) {
                    if (room.npcManager) {
                        room.npcManager.handleSetState(data.npcId, data.state, data.playerId);
                    }
                    break;
                }
            }
        }
    };
};
