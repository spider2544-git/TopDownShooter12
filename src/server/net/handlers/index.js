/**
 * Handler Module Index - Phase 2
 * 
 * Central export point for all socket handler modules.
 * Each module receives { io, rooms, Protocol, serverDebugger, nfcTagManager }
 * and returns an object with handler functions.
 */

const createCombatHandlers = require('./combatHandlers.js');
const createAbilityHandlers = require('./abilityHandlers.js');
const createPlayerHandlers = require('./playerHandlers.js');
const createItemHandlers = require('./itemHandlers.js');
const createModeHandlers = require('./modeHandlers.js');
const createNpcHandlers = require('./npcHandlers.js');
const createShopHandlers = require('./shopHandlers.js');
const createDebugHandlers = require('./debugHandlers.js');
const createConnectionHandlers = require('./connectionHandlers.js');

/**
 * Creates all handler modules with shared dependencies
 * @param {object} deps - Shared dependencies
 * @param {object} deps.io - Socket.IO server instance
 * @param {Map} deps.rooms - Map of active game rooms
 * @param {object} deps.Protocol - Network protocol definition
 * @param {object} deps.serverDebugger - Server debugger instance
 * @param {object} deps.nfcTagManager - NFC tag manager instance
 * @param {function} deps.GameRoom - GameRoom class for connection handlers
 * @returns {object} All handlers organized by category
 */
function createAllHandlers(deps) {
    return {
        combat: createCombatHandlers(deps),
        ability: createAbilityHandlers(deps),
        player: createPlayerHandlers(deps),
        item: createItemHandlers(deps),
        mode: createModeHandlers(deps),
        npc: createNpcHandlers(deps),
        shop: createShopHandlers(deps),
        debug: createDebugHandlers(deps),
        connection: createConnectionHandlers(deps)
    };
}

module.exports = { createAllHandlers };
