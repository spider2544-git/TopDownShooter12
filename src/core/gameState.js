// Game state management
class GameState {
    constructor() {
        this.viewportWidth = window.innerWidth;
        this.viewportHeight = window.innerHeight;
        this.lastTimestamp = 0;
        this.deathTimer = 0;
        this.deathTimerInitialized = false;
        this.respawnPending = false;
        this.cameraX = 0;
        this.cameraY = 0;
        this.keys = { 
            KeyW: false, KeyA: false, KeyS: false, KeyD: false, 
            ShiftLeft: false, ShiftRight: false, KeyE: false, 
            Space: false,
            Backquote: false, BracketRight: false,
            Minus: false
        };
        
        // Cheat/debug states
        this.invincible = false;
        this.mouse = { x: 0, y: 0 };
        this.mouseDown = false;
        this.justPressed = false;
        this.justReleased = false;
        this.mouseDownRight = false;
        this.justPressedRight = false;
        this.justReleasedRight = false;
        this.justPressedKeyE = false;
        
        // UI interaction flags
        this.uiDragSlider = false;
        
        // Guidance arrow opacity (0..1)
        this.arrowAlpha = 0;
        
        // Extraction outcome overlay: null | { type: 'win'|'lose', reason?: string }
        this.extractionEnd = null;
        this.extractionButtonRect = null;
        
        // NFC unlock popup: null | { weapon: string, title: string }
        this.nfcUnlockPopup = null;
        this.nfcUnlockButtonRect = null;
        
        // Mission accomplishments for Victory Points display
        this.missionAccomplishments = null;
        
        // Track whether the artifact has ever been picked up in this run
        this.artifactEverPicked = false;
        
        // Track whether the boss has been spawned already (after artifact pickup)
        this.bossSpawned = false;
        
        // When true, freeze gameplay (on successful extraction pre-win)
        this.isFrozen = false;
        
        // Screen shake state
        this.shakeTime = 0;
        this.shakeDur = 0;
        this.shakeMag = 0;
        
        // Consecutive damage streak timer (seconds)
        this.damageStreakTime = 0;
        
        // 0..1 ramp that grows while taking damage and decays otherwise (controls amplitude easing)
        this.shakeProgress = 0;
        
        // Frequency/phase controls for smoother, controllable shake motion
        this.shakePhase = 0;
        this.shakeBaseAX = 0;
        this.shakeBaseAY = 0;
        this.shakeFreqHz = 0;
        
        // Damage vignette intensity 0..1 (fast rise on damage, slow decay)
        this.vignette = 0;
        
        // Gas fog of war intensity 0..1 (blocks visibility when in gas, managed by server)
        this.gasFog = 0;
        this.gasCoughTimer = 0; // Timer for periodic coughing throb
        this.gasCoughFlash = 0; // Current throb intensity 0..1
        this.gasCoughPhase = 0; // 0=idle, 1=rising, 2=falling
        
        // Quickbar fade timer when hiding (0..0.7)
        this.quickbarFade = 0;
        
        // Track which NPC is currently showing the talk hint, for bark suppression
        this.talkHintNpcId = null;
        
        // Internal tracking
        this._lastDt = 0;
    }
    
    // Simple screen shake trigger: call with magnitude in pixels and duration seconds
    triggerScreenShake(magnitude = 6, duration = 0.15) {
        try {
            this.shakeMag = Math.max(this.shakeMag || 0, magnitude);
            this.shakeTime = Math.max(this.shakeTime || 0, duration);
            this.shakeDur = Math.max(0.0001, duration);
            // Initialize smooth shake parameters when starting a shake burst
            if (!this._shakeInit || this.shakeTime === duration) {
                this.shakePhase = 0;
                // Randomize base axes so motion isn't always the same direction
                const ang = Math.random() * Math.PI * 2;
                this.shakeBaseAX = Math.cos(ang);
                this.shakeBaseAY = Math.sin(ang);
                this.shakeFreqHz = 0.5; // start with low frequency (subtle)
                this._shakeInit = true;
            }
        } catch(_) {}
    }
}

// Export as singleton
if (typeof window !== 'undefined') {
    window.GameState = GameState;
}
