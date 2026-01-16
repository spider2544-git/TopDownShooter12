// Server configuration constants
const SERVER_CONFIG = {
    TICK_RATE: 60,               // Keep physics at 60Hz
    BROADCAST_RATE: 30,          // Player state updates (30Hz)
    BROADCAST_RATE_LOW: 10,      // Non-critical data: timers, chests, UI (10Hz)
    PORT: process.env.PORT || 5000,
    CORS_ORIGIN: "*",
    ENEMY_BROADCAST_HZ: 10,      // Enemy updates (10Hz)
};

module.exports = { SERVER_CONFIG };
