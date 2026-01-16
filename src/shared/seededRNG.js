/**
 * Universal Seeded Random Number Generator
 * Works in both browser and Node.js environments
 * Uses Linear Congruential Generator (LCG) for deterministic randomness
 */

(function(root, factory) {
    // Universal Module Definition (UMD) pattern
    if (typeof module === 'object' && module.exports) {
        // Node.js / CommonJS
        module.exports = factory();
    } else {
        // Browser globals
        root.SeededRNG = factory().SeededRNG;
        root.WorldRNG = factory().WorldRNG;
    }
}(typeof self !== 'undefined' ? self : this, function() {
    'use strict';

    /**
     * Seeded Random Number Generator class
     * Generates deterministic pseudo-random numbers from a seed
     */
    class SeededRNG {
        constructor(seed) {
            this.seed = seed % 2147483647;
            if (this.seed <= 0) this.seed += 2147483646;
            this.current = this.seed;
        }
        
        /**
         * Generate next random number in range [0, 1)
         * Compatible with Math.random()
         */
        random() {
            this.current = (this.current * 16807) % 2147483647;
            return (this.current - 1) / 2147483646;
        }
        
        /**
         * Generate random integer in range [min, max] (inclusive)
         */
        randomInt(min, max) {
            return Math.floor(this.random() * (max - min + 1)) + min;
        }
        
        /**
         * Generate random float in range [min, max)
         */
        randomFloat(min, max) {
            return this.random() * (max - min) + min;
        }
        
        /**
         * Pick random element from array
         */
        pick(array) {
            if (!Array.isArray(array) || array.length === 0) return undefined;
            return array[Math.floor(this.random() * array.length)];
        }
        
        /**
         * Reset to initial seed state
         */
        reset() {
            this.current = this.seed;
        }
        
        /**
         * Get current seed for debugging
         */
        getSeed() {
            return this.seed;
        }
    }

    // Browser-only: Create global WorldRNG utility
    let worldRNG = null;
    
    const WorldRNG = {
        /**
         * Initialize with seed (called by networking system)
         */
        setSeed(seed) {
            if (typeof console !== 'undefined') {
                console.log('[WorldRNG] Setting world generation seed:', seed);
            }
            worldRNG = new SeededRNG(seed);
            return worldRNG;
        },
        
        /**
         * Get seeded random number [0, 1) - drop-in replacement for Math.random()
         */
        random() {
            if (!worldRNG) {
                try {
                    // PERF: This can spam and tank FPS. Warn at most once, and only when console logs are enabled.
                    if (typeof window !== 'undefined' && window.GameConstants?.ENABLE_DEBUG_LOGS) {
                        if (!window.__worldRngNoSeedWarned) {
                            window.__worldRngNoSeedWarned = true;
                            console.warn('[WorldRNG] No world seed set, falling back to Math.random()');
                        }
                    }
                } catch(_) {}
                return Math.random();
            }
            return worldRNG.random();
        },
        
        /**
         * Generate random integer in range [min, max] (inclusive)
         */
        randomInt(min, max) {
            if (!worldRNG) {
                try {
                    if (typeof window !== 'undefined' && window.GameConstants?.ENABLE_DEBUG_LOGS) {
                        if (!window.__worldRngNoSeedWarned) {
                            window.__worldRngNoSeedWarned = true;
                            console.warn('[WorldRNG] No world seed set, falling back to Math.random()');
                        }
                    }
                } catch(_) {}
                return Math.floor(Math.random() * (max - min + 1)) + min;
            }
            return worldRNG.randomInt(min, max);
        },
        
        /**
         * Generate random float in range [min, max)
         */
        randomFloat(min, max) {
            if (!worldRNG) {
                try {
                    if (typeof window !== 'undefined' && window.GameConstants?.ENABLE_DEBUG_LOGS) {
                        if (!window.__worldRngNoSeedWarned) {
                            window.__worldRngNoSeedWarned = true;
                            console.warn('[WorldRNG] No world seed set, falling back to Math.random()');
                        }
                    }
                } catch(_) {}
                return Math.random() * (max - min) + min;
            }
            return worldRNG.randomFloat(min, max);
        },
        
        /**
         * Pick random element from array
         */
        pick(array) {
            if (!worldRNG) {
                try {
                    if (typeof window !== 'undefined' && window.GameConstants?.ENABLE_DEBUG_LOGS) {
                        if (!window.__worldRngNoSeedWarned) {
                            window.__worldRngNoSeedWarned = true;
                            console.warn('[WorldRNG] No world seed set, falling back to Math.random()');
                        }
                    }
                } catch(_) {}
                if (!Array.isArray(array) || array.length === 0) return undefined;
                return array[Math.floor(Math.random() * array.length)];
            }
            return worldRNG.pick(array);
        },
        
        /**
         * Check if world RNG is initialized
         */
        isInitialized() {
            return worldRNG !== null;
        },
        
        /**
         * Get current seed (for debugging)
         */
        getCurrentSeed() {
            return worldRNG ? worldRNG.getSeed() : null;
        },
        
        /**
         * Reset RNG to initial seed state
         */
        reset() {
            if (worldRNG) {
                worldRNG.reset();
            }
        }
    };

    // Browser-only: Set up global worldRNG reference
    if (typeof window !== 'undefined') {
        window.worldRNG = worldRNG;
        console.log('[WorldRNG] Seeded RNG system initialized');
    }

    // Export for both environments
    return {
        SeededRNG: SeededRNG,
        WorldRNG: WorldRNG
    };
}));
