/**
 * RoomContext - Phase 2
 * 
 * Encapsulates per-tick/broadcast context passed to GameRoom subsystems.
 * This replaces scattered parameter passing and makes dependencies explicit.
 * 
 * Benefits:
 * - Clear API boundary for what systems can access
 * - Easy to pass to extracted handlers
 * - Supports testing (can mock context)
 * - Prepares for eventual GameRoom extraction
 */

/**
 * Creates a RoomContext for a tick or broadcast operation
 * 
 * @param {object} options
 * @param {object} options.io - Socket.IO server instance
 * @param {object} options.config - SERVER_CONFIG (tick rates, etc.)
 * @param {GameRoom} options.room - The GameRoom instance
 * @param {number} options.now - Current timestamp (Date.now())
 * @param {number} options.dt - Delta time in seconds
 * @param {object} options.rng - SeededRNG instance (room.rng)
 * @param {object} options.logger - Optional logger (defaults to console)
 * @returns {RoomContext}
 */
function createRoomContext({ io, config, room, now, dt, rng, logger }) {
	return {
		// ===== SERVICES =====
		io,           // Socket.IO server
		config,       // SERVER_CONFIG
		logger: logger || console,
		
		// ===== ROOM STATE =====
		room,         // GameRoom instance (still owns all state)
		
		// ===== TIMING =====
		now,          // Current timestamp (ms)
		dt,           // Delta time (seconds)
		
		// ===== DETERMINISM =====
		rng           // SeededRNG for this room
	};
}

/**
 * Validates a RoomContext to catch errors early
 * @param {object} ctx 
 * @returns {boolean}
 */
function validateRoomContext(ctx) {
	if (!ctx) return false;
	if (!ctx.io || typeof ctx.io.to !== 'function') return false;
	if (!ctx.config) return false;
	if (!ctx.room || !ctx.room.id) return false;
	if (typeof ctx.now !== 'number' || ctx.now <= 0) return false;
	if (typeof ctx.dt !== 'number' || ctx.dt < 0) return false;
	return true;
}

module.exports = {
	createRoomContext,
	validateRoomContext
};
