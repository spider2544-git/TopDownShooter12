// Input management for keyboard and mouse
class InputManager {
    constructor(state) {
        this.state = state;
        this.setupEventListeners();
    }
    
    setupEventListeners() {
        // Keyboard events
        window.addEventListener('keydown', (e) => {
            if (e.code in this.state.keys) {
                this.state.keys[e.code] = true;
                if (e.code === 'KeyE') {
                    this.state.justPressedKeyE = true;
                }
                if (e.code === 'Space') {
                    console.log('[Client] 🎯 Space keydown detected - setting justPressedSpace=true');
                    this.state.justPressedSpace = true;
                    e.preventDefault(); // Prevent page scrolling
                }
            }
        });
        
        window.addEventListener('keyup', (e) => {
            if (e.code in this.state.keys) {
                this.state.keys[e.code] = false;
            }
        });
        
        // Mouse events
        window.addEventListener('mousemove', (e) => {
            this.state.mouse.x = e.clientX;
            this.state.mouse.y = e.clientY;
        });
        
        window.addEventListener('mousedown', (e) => {
            if (e.button === 0) { // Left click
                this.state.mouseDown = true;
                this.state.justPressed = true;
            } else if (e.button === 2) { // Right click
                this.state.mouseDownRight = true;
                this.state.justPressedRight = true;
            }
        });
        
        window.addEventListener('mouseup', (e) => {
            if (e.button === 0) {
                this.state.mouseDown = false;
                this.state.justReleased = true;
            } else if (e.button === 2) {
                this.state.mouseDownRight = false;
                this.state.justReleasedRight = true;
            }
        });
        
        // Prevent context menu
        window.addEventListener('contextmenu', (e) => {
            e.preventDefault();
        });
    }
    
    // Send input to server for multiplayer
    sendPlayerInput(player, isMultiplayer, networkManager) {
        if (!isMultiplayer || !networkManager || !networkManager.connected) return;
        
        // Suppress input while dead/ghost
        if (player.health <= 0) {
            // Send neutral input to keep server from moving/aiming us
            networkManager.sendInput({
                keys: { KeyW:false, KeyA:false, KeyS:false, KeyD:false, ShiftLeft:false, ShiftRight:false, Space:false },
                mouse: { x: 0, y: 0 },
                mouseDown: false,
                aimAngle: player.aimAngle || 0,
                wantsDash: false
            }, { x: player.x, y: player.y });
            return;
        }
        
        // Calculate aim angle from player position to mouse position in world coordinates
        // Account for zoom level - when zoomed out, screen pixels represent more world distance
        const cx = this.state.viewportWidth / 2;
        const cy = this.state.viewportHeight / 2;
        const zoomLevel = (window.clientRender?.zoomLevel) || 1.0;
        const worldMouseX = this.state.cameraX + cx + (this.state.mouse.x - cx) / zoomLevel;
        const worldMouseY = this.state.cameraY + cy + (this.state.mouse.y - cy) / zoomLevel;
        const aimAngle = Math.atan2(worldMouseY - player.y, worldMouseX - player.x);
        
        // Check if player just pressed Space for dash (but disable while ADS)
        const wantsDash = (!!this.state.justPressedSpace) && !player._weapon8ADS; // Disable dash while ADS
        if (this.state.justPressedSpace && !player._weapon8ADS) {
            const timestamp = Date.now();
            console.log(`[Client] [${timestamp}] 🚀 SPACE PRESSED - Sending wantsDash=true to server | Position: (${player.x.toFixed(1)}, ${player.y.toFixed(1)}) | Stamina: ${player.stamina.toFixed(1)}`);
            
            // Store client dash request for tracking
            if (!window._dashTracking) window._dashTracking = {};
            window._dashTracking.requestTime = timestamp;
            window._dashTracking.requestPos = { x: player.x, y: player.y };
            window._dashTracking.requestStamina = player.stamina;
            
            this.state.justPressedSpace = false; // Clear after sending
        }
        
        // Send input with current player position for client-side prediction
        // Include weapon 8 ADS state for server movement calculations
        const isWeapon8ADS = (player._weapon8ADS === true);
        
        networkManager.sendInput({
            keys: this.state.keys,
            mouse: this.state.mouse,
            mouseDown: this.state.mouseDown,
            aimAngle: aimAngle,
            wantsDash: wantsDash,
            isWeapon8ADS: isWeapon8ADS
        }, {
            x: player.x,
            y: player.y
        });
    }
    
    // Apply input to player for rollback re-simulation (MUST match server updatePlayerMovement exactly!)
    applyInputToPlayer(player, input, environment) {
        const speed = 220; // Player movement speed (matches server default from player.js)
        const deltaTime = 1/60; // Fixed 60 FPS for consistent re-simulation
        
        let vx = 0, vy = 0;
        
        // Handle WASD movement (matches server logic)
        if (input.keys.KeyW) vy -= 1;
        if (input.keys.KeyS) vy += 1;
        if (input.keys.KeyA) vx -= 1;
        if (input.keys.KeyD) vx += 1;
        
        // Normalize diagonal movement (matches server)
        if (vx !== 0 && vy !== 0) {
            const mag = Math.sqrt(vx * vx + vy * vy);
            vx /= mag;
            vy /= mag;
        }
        
        // Apply speed multiplier for shift key (matches server - 2x speed when sprinting, disabled while ADS)
        let actualSpeed = (input.keys.ShiftLeft || input.keys.ShiftRight) && !player._weapon8ADS ? speed * 2 : speed;
        
        // Apply boomer puke pool slow (50% speed reduction) - matches server
        if (player._svSlowed) {
            actualSpeed *= 0.5;
        }
        
        // Apply basic zombie melee slow (15% per zombie, stacks up to 5 zombies for 75% max slow) - matches server
        if (player._basicZombieSlowCount && player._basicZombieSlowCount > 0) {
            const slowPerZombie = 0.15; // 15% slow per zombie
            const maxZombies = 5; // Cap at 5 zombies for max effect
            const zombieCount = Math.min(player._basicZombieSlowCount, maxZombies);
            const slowMultiplier = 1 - (slowPerZombie * zombieCount); // 0.85 for 1 zombie, 0.25 for 5 zombies
            actualSpeed *= slowMultiplier;
        }
        
        // Apply weapon 8 ADS slow (40% speed) - matches server
        if (player._weapon8ADS === true) {
            actualSpeed *= 0.4;
        }
        
        // Update position (matches server)
        player.x += vx * actualSpeed * deltaTime;
        player.y += vy * actualSpeed * deltaTime;
        
        // Apply boundary constraints (matches server)
        const boundary = environment ? environment.boundary : 1000;
        player.x = Math.max(-boundary, Math.min(boundary, player.x));
        player.y = Math.max(-boundary, Math.min(boundary, player.y));
    }
}

// Export
if (typeof window !== 'undefined') {
    window.InputManager = InputManager;
}
