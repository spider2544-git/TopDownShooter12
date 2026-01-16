// Scene management and world initialization
class SceneManager {
    constructor() {
        this.scene = { current: 'lobby' };
        this.worldInitialized = false;
        this.chests = [];
        this.extractionZone = null;
        this.hereticExtractionZone = null;
        this.groundDecals = [];
        
        // Expose scene globally
        window.scene = this.scene;
        window.chests = this.chests;
    }
    
    initializeWorld(seed, environment, enemies, director, player, npcs) {
        if (this.worldInitialized) {
            console.log('[Scene] World already initialized, skipping');
            return;
        }
        
        console.log('[Scene] Initializing world with seed:', seed);
        console.log('[Scene] WorldRNG available?', typeof WorldRNG !== 'undefined');
        console.log('[Scene] EnvironmentLobby available?', typeof window.EnvironmentLobby !== 'undefined');
        console.log('[Scene] Environment available?', typeof Environment !== 'undefined');
        
        // Ensure WorldRNG is properly initialized
        if (typeof WorldRNG !== 'undefined' && WorldRNG.setSeed) {
            WorldRNG.setSeed(seed);
            console.log('[Scene] WorldRNG initialized with seed:', seed);
        } else {
            console.error('[Scene] WorldRNG not available! World generation will not be synchronized!');
        }
        
        // Now create the environment with seeded RNG
        try {
            const newEnvironment = new (window.EnvironmentLobby || Environment)();
            console.log('[Scene] Environment created successfully');
            
            // Update window.environment so other systems can access it
            window.environment = newEnvironment;
            console.log('[Scene] Environment assigned to window.environment');
            
            // CRITICAL: Also update GameContext
            if (window.ctx) {
                window.ctx.environment = newEnvironment;
                console.log('[Scene] ✅ Environment synced to GameContext');
            }
            
            // Initialize director after environment is created
            if (director) {
                director.environment = newEnvironment;
                window.director = director;
                console.log('[Scene] Director initialized with environment');
                
                // CRITICAL: Also update GameContext
                if (window.ctx) {
                    window.ctx.director = director;
                    console.log('[Scene] ✅ Director synced to GameContext');
                }
            }
            
            this.worldInitialized = true;
            
            // Now that environment is ready, place the player and spawn NPCs
            this.placePlayerRandomly(newEnvironment, player);
            this.spawnLobbyMerchant(newEnvironment, npcs);
            this.spawnLobbyCommander(newEnvironment, npcs);
            this.spawnLobbyQuartermaster(newEnvironment, npcs);
            
            console.log('[Scene] World initialization completed successfully');
            return newEnvironment;
        } catch (error) {
            console.error('[Scene] Error creating environment:', error);
            return null;
        }
    }
    
    placePlayerRandomly(environment, player) {
        if (!environment || !this.worldInitialized) {
            console.log('[Scene] Environment not ready, deferring player placement');
            return;
        }
        
        const tries = 400;
        const clearance = Math.max(30, player.radius + 24);
        const b = environment.boundary - clearance - 10;
        for (let i = 0; i < tries; i++) {
            const nx = (Math.random() * 2 - 1) * b;
            const ny = (Math.random() * 2 - 1) * b;
            if (!environment.circleHitsAny(nx, ny, clearance) && environment.isInsideBounds(nx, ny, clearance)) {
                player.x = nx; player.y = ny;
                environment.spawnSafeX = nx; environment.spawnSafeY = ny; 
                environment.spawnSafeRadius = Math.max(environment.spawnSafeRadius, clearance * 2);
                console.log('[Scene] Player placed at:', {x: nx, y: ny});
                break;
            }
        }
    }
    
    spawnLobbyMerchant(environment, npcs) {
        try {
            if (this.scene.current !== 'lobby') return;
            if (!window.Merchant) return;
            if (!environment || !this.worldInitialized) {
                console.log('[Scene] Environment not ready, deferring merchant spawn');
                return;
            }
            const r = 24;
            const b = environment.boundary;
            const x = 200;
            const y = -b + r + 80;
            let mx = x, my = y;
            if (!environment.isInsideBounds(mx, my, r) || environment.circleHitsAny(mx, my, r)) {
                for (let dy = 100; dy <= 600; dy += 60) {
                    const ty = -b + r + 80 + dy;
                    if (environment.isInsideBounds(x, ty, r) && !environment.circleHitsAny(x, ty, r)) { my = ty; break; }
                }
            }
            npcs.add(new window.Merchant(mx, my));
        } catch(_) {}
    }
    
    spawnLobbyCommander(environment, npcs) {
        try {
            if (this.scene.current !== 'lobby') return;
            if (!window.Commander) return;
            if (!environment || !this.worldInitialized) {
                console.log('[Scene] Environment not ready, deferring commander spawn');
                return;
            }
            const r = 24;
            const b = environment.boundary;
            const x = -b + r + 140;
            const y = 0;
            let cx = x, cy = y;
            if (!environment.isInsideBounds(cx, cy, r) || environment.circleHitsAny(cx, cy, r)) {
                for (let step = 1; step <= 20; step++) {
                    const nx = x + step * 20;
                    if (environment.isInsideBounds(nx, y, r) && !environment.circleHitsAny(nx, y, r)) { cx = nx; cy = y; break; }
                }
            }
            npcs.add(new window.Commander(cx, cy));
        } catch(_) {}
    }

    spawnLobbyQuartermaster(environment, npcs) {
        try {
            if (this.scene.current !== 'lobby') return;
            if (!window.Quartermaster) return;
            if (!environment || !this.worldInitialized) {
                console.log('[Scene] Environment not ready, deferring quartermaster spawn');
                return;
            }
            const r = 24;
            // Near the bottom edge of the vertical sandbag fence (see lobby sandbag placement)
            const x = -307;
            const y = -534;
            let qx = x, qy = y;
            if (!environment.isInsideBounds(qx, qy, r) || environment.circleHitsAny(qx, qy, r)) {
                // Nudge right/down first to stay on the "lane" side of the fence
                const candidates = [];
                for (let step = 0; step <= 18; step++) {
                    const dx = step * 18;
                    const dy = step * 14;
                    candidates.push({ x: x + dx, y: y });
                    candidates.push({ x: x + dx, y: y + dy });
                    candidates.push({ x: x + dx, y: y - dy });
                    candidates.push({ x: x - dx, y: y + dy });
                }
                for (let i = 0; i < candidates.length; i++) {
                    const c = candidates[i];
                    if (environment.isInsideBounds(c.x, c.y, r) && !environment.circleHitsAny(c.x, c.y, r)) {
                        qx = c.x; qy = c.y;
                        break;
                    }
                }
            }
            npcs.add(new window.Quartermaster(qx, qy));
        } catch(_) {}
    }
    
    // Target dummy removed. Lobby training dummy is spawned by server as a normal enemy (type: targetDummy).
}

// Export
if (typeof window !== 'undefined') {
    window.SceneManager = SceneManager;
}
