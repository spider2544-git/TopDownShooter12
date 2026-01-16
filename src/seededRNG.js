// Seeded Random Number Generator for synchronized world generation
// Uses a simple but effective Linear Congruential Generator (LCG)
class SeededRNG {
    constructor(seed) {
        this.seed = seed % 2147483647;
        if (this.seed <= 0) this.seed += 2147483646;
        this.current = this.seed;
    }
    
    // Generate next random number in range [0, 1) - compatible with Math.random()
    random() {
        this.current = (this.current * 16807) % 2147483647;
        return (this.current - 1) / 2147483646;
    }
    
    // Generate random integer in range [min, max] (inclusive)
    randomInt(min, max) {
        return Math.floor(this.random() * (max - min + 1)) + min;
    }
    
    // Generate random float in range [min, max)
    randomFloat(min, max) {
        return this.random() * (max - min) + min;
    }
    
    // Pick random element from array
    pick(array) {
        if (!Array.isArray(array) || array.length === 0) return undefined;
        return array[Math.floor(this.random() * array.length)];
    }
    
    // Reset to initial seed state
    reset() {
        this.current = this.seed;
    }
    
    // Get current seed for debugging
    getSeed() {
        return this.seed;
    }
}

// Global world generation RNG instance
// This will be set by the networking system when a world seed is received
window.worldRNG = null;

// Utility functions that match Math.random() API but use seeded generation
window.WorldRNG = {
    // Initialize with seed (called by networking system)
    setSeed(seed) {
        console.log('[WorldRNG] Setting world generation seed:', seed);
        window.worldRNG = new SeededRNG(seed);
        return window.worldRNG;
    },
    
    // Get seeded random number [0, 1) - drop-in replacement for Math.random()
    random() {
        if (!window.worldRNG) {
            try {
                // PERF: avoid console spam; warn once and only when console logs are enabled.
                if (window.GameConstants?.ENABLE_DEBUG_LOGS) {
                    if (!window.__worldRngNoSeedWarned) {
                        window.__worldRngNoSeedWarned = true;
                        console.warn('[WorldRNG] No world seed set, falling back to Math.random()');
                    }
                }
            } catch(_) {}
            return Math.random();
        }
        return window.worldRNG.random();
    },
    
    // Generate random integer in range [min, max] (inclusive)
    randomInt(min, max) {
        if (!window.worldRNG) {
            try {
                if (window.GameConstants?.ENABLE_DEBUG_LOGS) {
                    if (!window.__worldRngNoSeedWarned) {
                        window.__worldRngNoSeedWarned = true;
                        console.warn('[WorldRNG] No world seed set, falling back to Math.random()');
                    }
                }
            } catch(_) {}
            return Math.floor(Math.random() * (max - min + 1)) + min;
        }
        return window.worldRNG.randomInt(min, max);
    },
    
    // Generate random float in range [min, max)  
    randomFloat(min, max) {
        if (!window.worldRNG) {
            try {
                if (window.GameConstants?.ENABLE_DEBUG_LOGS) {
                    if (!window.__worldRngNoSeedWarned) {
                        window.__worldRngNoSeedWarned = true;
                        console.warn('[WorldRNG] No world seed set, falling back to Math.random()');
                    }
                }
            } catch(_) {}
            return Math.random() * (max - min) + min;
        }
        return window.worldRNG.randomFloat(min, max);
    },
    
    // Pick random element from array
    pick(array) {
        if (!window.worldRNG) {
            try {
                if (window.GameConstants?.ENABLE_DEBUG_LOGS) {
                    if (!window.__worldRngNoSeedWarned) {
                        window.__worldRngNoSeedWarned = true;
                        console.warn('[WorldRNG] No world seed set, falling back to Math.random()');
                    }
                }
            } catch(_) {}
            if (!Array.isArray(array) || array.length === 0) return undefined;
            return array[Math.floor(Math.random() * array.length)];
        }
        return window.worldRNG.pick(array);
    },
    
    // Check if world RNG is initialized
    isInitialized() {
        return window.worldRNG !== null;
    },
    
    // Get current seed (for debugging)
    getCurrentSeed() {
        return window.worldRNG ? window.worldRNG.getSeed() : null;
    },
    
    // Reset RNG to initial seed state
    reset() {
        if (window.worldRNG) {
            window.worldRNG.reset();
        }
    }
};

console.log('[WorldRNG] Seeded RNG system initialized');