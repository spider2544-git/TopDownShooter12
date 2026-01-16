// Camera management with deadzone and smoothing
class Camera {
    constructor(state) {
        this.state = state;
    }
    
    update(dt, player) {
        // Camera follow with deadzone and smoothing
        const cx = this.state.viewportWidth / 2;
        const cy = this.state.viewportHeight / 2;
        const deadzoneX = this.state.viewportWidth * 0.15;
        const deadzoneY = this.state.viewportHeight * 0.15;
        const left = cx - deadzoneX;
        const right = cx + deadzoneX;
        const top = cy - deadzoneY;
        const bottom = cy + deadzoneY;

        const screenX = player.x - this.state.cameraX;
        const screenY = player.y - this.state.cameraY;

        let targetCamX = this.state.cameraX;
        let targetCamY = this.state.cameraY;

        if (screenX < left) targetCamX = player.x - left;
        else if (screenX > right) targetCamX = player.x - right;

        if (screenY < top) targetCamY = player.y - top;
        else if (screenY > bottom) targetCamY = player.y - bottom;

        const followStrength = 10;
        const t = 1 - Math.exp(-followStrength * dt);
        this.state.cameraX += (targetCamX - this.state.cameraX) * t;
        this.state.cameraY += (targetCamY - this.state.cameraY) * t;
    }
    
    // Expose camera getter for modules
    getCamera() {
        return { 
            x: this.state.cameraX, 
            y: this.state.cameraY, 
            width: this.state.viewportWidth, 
            height: this.state.viewportHeight 
        };
    }
}

// Export
if (typeof window !== 'undefined') {
    window.Camera = Camera;
    
    // Expose camera getter for other modules (maintains backward compatibility)
    window.getCamera = function() {
        try {
            if (window.camera) {
                return window.camera.getCamera();
            }
            return null;
        } catch(_) { 
            return null; 
        }
    };
}
