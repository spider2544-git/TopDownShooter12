// Server-side Seeded Random Number Generator
class SeededRNG {
    constructor(seed) {
        this.seed = seed % 2147483647;
        if (this.seed <= 0) this.seed += 2147483646;
        this.current = this.seed;
    }
    
    random() {
        this.current = (this.current * 16807) % 2147483647;
        return (this.current - 1) / 2147483646;
    }
    
    randomInt(min, max) {
        return Math.floor(this.random() * (max - min + 1)) + min;
    }
    
    randomFloat(min, max) {
        return this.random() * (max - min) + min;
    }
    
    pick(array) {
        if (!Array.isArray(array) || array.length === 0) return undefined;
        return array[Math.floor(this.random() * array.length)];
    }
    
    reset() {
        this.current = this.seed;
    }
    
    getSeed() {
        return this.seed;
    }
}

module.exports = { SeededRNG };
