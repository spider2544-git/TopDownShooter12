/**
 * Pooled Object Implementations for High-Performance Game Objects
 * Uses ObjectPool to eliminate allocations during gameplay
 * 
 * Expected Performance Improvements:
 * - 60-80% reduction in garbage collection
 * - 10-20% FPS improvement in intense combat
 * - More consistent frame times
 * - Reduced memory usage
 */

// Object pools (initialized after classes are defined)
let bulletPool = null;
let impactVfxPool = null;
let explosionVfxPool = null;
let damageBlastPool = null; // For explosion damage circles
let _warnedExplosionVfxPoolMissing = false;

/**
 * Initialize all object pools
 * Call this during game initialization
 */
function initializeObjectPools() {
    if (typeof ObjectPool === 'undefined') {
        console.error('[ObjectPools] ObjectPool class not found! Load src/shared/objectPool.js first.');
        return;
    }

    // Bullet Pool - Use actual Bullet class (has update(), draw(), etc.)
    if (typeof window.Bullet === 'undefined') {
        console.error('[ObjectPools] Bullet class not found! Load src/weapons.js first.');
        return;
    }
    
    // ObjectPool signature: (factory, reset, initialSize, maxSize)
    bulletPool = new ObjectPool(
        // Factory: Create new Bullet instance (with deterministic values for pre-warming)
        () => {
            // Use Math.random() during pre-warm since WorldRNG isn't seeded yet
            const bias = (Math.random() * 2 - 1) * 0.35;
            return new window.Bullet(0, 0, 0, 0, 10, '#FFFFFF', 1, 0, true, { bias });
        },
        // Reset: Use Bullet's init() method to reset state
        (bullet, x, y, vx, vy, radius, color, lifeSeconds, angle, noDamage, options) => {
            bullet.init(x, y, vx, vy, radius, color, lifeSeconds, angle, noDamage, options);
        },
        0, // Initial size: 0 (don't pre-warm, create on demand)
        500  // Max size: 500 bullets
    );

    // Impact VFX Pool
    impactVfxPool = new ObjectPool(
        // Factory: Create new impact VFX
        () => ({
            x: 0, y: 0,
            totalLife: 0.22, life: 0.22,
            color: '#fff', scale: 1,
            sparks: [], // Pre-allocated array
            drawBehind: false
        }),
        // Reset: Reinitialize impact VFX
        (vfx, x, y, color, dirX, dirY, options) => {
            vfx.x = x;
            vfx.y = y;
            vfx.totalLife = 0.22;
            vfx.life = vfx.totalLife;
            vfx.color = color || '#fff';
            options = options || {};
            vfx.scale = options.scale || 1;
            vfx.drawBehind = !!options.drawBehind;
            
            // Generate sparks
            const baseAngle = Math.atan2(dirY || 1, dirX || 0);
            const num = 12 + Math.floor(WorldRNG.random() * 6);
            vfx.sparks.length = 0; // Clear existing
            for (let i = 0; i < num; i++) {
                const angle = baseAngle + (WorldRNG.random() - 0.5) * (Math.PI * 2 / 3);
                vfx.sparks.push({
                    angle,
                    maxDist: (10 + WorldRNG.random() * 20) * vfx.scale,
                    length: (3 + WorldRNG.random() * 6) * vfx.scale,
                    width: (1 + WorldRNG.random() * 1.2) * vfx.scale,
                    alpha: 0.85 + WorldRNG.random() * 0.15
                });
            }
        },
        50,  // Initial size: 50 impact VFX
        200  // Max size: 200 impact VFX
    );

    // Explosion VFX Pool
    if (typeof window.ExplosionVfx === 'undefined') {
        console.error('[ObjectPools] ExplosionVfx class not found! Load src/weapons.js before pooledObjects.js init.');
        return;
    }
    explosionVfxPool = new ObjectPool(
        // Factory: Create reusable ExplosionVfx instances (must support init()).
        () => new window.ExplosionVfx(0, 0, '#ffae00', { scale: 1 }),
        // Reset: Reinitialize ExplosionVfx in-place (no allocations).
        (vfx, x, y, color, options) => {
            if (vfx && typeof vfx.init === 'function') {
                vfx.init(x, y, color, options);
            } else {
                // Fallback for older builds: recreate (still avoids crashing).
                try {
                    vfx.x = x;
                    vfx.y = y;
                    vfx.life = 0;
                } catch (_) {}
            }
        },
        30,  // Initial size: 30 explosions
        150  // Max size: 150 explosions
    );

    // Damage Blast Pool (for explosion damage circles)
    damageBlastPool = new ObjectPool(
        // Factory: Create new damage blast
        () => ({
            life: 0.25, totalLife: 0.25,
            x: 0, y: 0, radius: 100,
            hitEnemyIds: new Set(), hitPlayer: false,
            baseOffset: 0, owner: null,
            drawBehind: true,
            color: '#ffd36b', alpha: 0.35
        }),
        // Reset: Reinitialize damage blast
        (blast, x, y, radius, baseOffset, owner, options) => {
            blast.life = 0.25;
            blast.totalLife = 0.25;
            blast.x = x;
            blast.y = y;
            blast.radius = radius || 100;
            blast.hitEnemyIds.clear();
            blast.hitPlayer = false;
            blast.baseOffset = baseOffset || 0;
            blast.owner = owner || null;
            options = options || {};
            blast.drawBehind = options.drawBehind !== undefined ? options.drawBehind : true;
            blast.color = options.color || '#ffd36b';
            blast.alpha = options.alpha || 0.35;
        },
        20,  // Initial size: 20 damage blasts
        100  // Max size: 100 damage blasts
    );

    console.log('[ObjectPools] Initialized all object pools:', {
        bullets: bulletPool.getStats(),
        impactVfx: impactVfxPool.getStats(),
        explosionVfx: explosionVfxPool.getStats(),
        damageBlast: damageBlastPool.getStats()
    });
}

/**
 * Create a pooled bullet (replaces 'new Bullet()')
 */
function createBullet(x, y, vx, vy, radius, color, lifeSeconds, angle, noDamage, options) {
    if (!bulletPool) {
        console.warn('[ObjectPools] bulletPool not initialized, falling back to regular allocation');
        return new window.Bullet(x, y, vx, vy, radius, color, lifeSeconds, angle, noDamage, options);
    }
    return bulletPool.acquire(x, y, vx, vy, radius, color, lifeSeconds, angle, noDamage, options);
}

/**
 * Create a pooled impact VFX (replaces 'new ImpactVfx()')
 */
function createImpactVfx(x, y, color, dirX, dirY, options) {
    if (!impactVfxPool) {
        console.warn('[ObjectPools] impactVfxPool not initialized, falling back to regular allocation');
        return new window.ImpactVfx(x, y, color, dirX, dirY, options);
    }
    return impactVfxPool.acquire(x, y, color, dirX, dirY, options);
}

/**
 * Create a pooled explosion VFX (replaces 'new ExplosionVfx()')
 */
function createExplosionVfx(x, y, color, options) {
    if (!explosionVfxPool) {
        // Avoid log spam during combat; this path can be hit many times per second.
        if (!_warnedExplosionVfxPoolMissing) {
            _warnedExplosionVfxPoolMissing = true;
            console.warn('[ObjectPools] explosionVfxPool not initialized, falling back to regular allocation');
        }
        return new window.ExplosionVfx(x, y, color, options);
    }
    return explosionVfxPool.acquire(x, y, color, options);
}

/**
 * Create a pooled damage blast (replaces inline damage circle objects)
 */
function createDamageBlast(x, y, radius, baseOffset, owner, options) {
    if (!damageBlastPool) {
        console.warn('[ObjectPools] damageBlastPool not initialized, creating fallback object');
        const blast = {
            life: 0.25,
            totalLife: 0.25,
            x, y, radius,
            hitEnemyIds: new Set(),
            hitPlayer: false,
            baseOffset: baseOffset || 0,
            owner: owner || null,
            drawBehind: (options && options.drawBehind) !== undefined ? options.drawBehind : true,
            color: (options && options.color) || '#ffd36b',
            alpha: (options && options.alpha) || 0.35
        };
        return blast;
    }
    return damageBlastPool.acquire(x, y, radius, baseOffset, owner, options);
}

/**
 * Return bullet to pool (call when bullet dies)
 */
function releaseBullet(bullet) {
    if (bulletPool && bullet) {
        // Deactivate bullet before returning to pool
        if (typeof bullet.deactivate === 'function') {
            bullet.deactivate();
        }
        bulletPool.release(bullet);
    }
}

/**
 * Return impact VFX to pool (call when VFX finishes)
 */
function releaseImpactVfx(vfx) {
    if (impactVfxPool && vfx) {
        impactVfxPool.release(vfx);
    }
}

/**
 * Return explosion VFX to pool (call when VFX finishes)
 */
function releaseExplosionVfx(vfx) {
    if (explosionVfxPool && vfx) {
        explosionVfxPool.release(vfx);
    }
}

/**
 * Return damage blast to pool (call when blast finishes)
 */
function releaseDamageBlast(blast) {
    if (damageBlastPool && blast) {
        damageBlastPool.release(blast);
    }
}

/**
 * Get pool statistics for performance monitoring
 */
function getPoolStats() {
    return {
        bullet: bulletPool ? bulletPool.getStats() : null,
        impactVfx: impactVfxPool ? impactVfxPool.getStats() : null,
        explosionVfx: explosionVfxPool ? explosionVfxPool.getStats() : null,
        damageBlast: damageBlastPool ? damageBlastPool.getStats() : null
    };
}

/**
 * Pre-warm all pools for combat (call before intense sequences)
 */
function prewarmPools() {
    if (bulletPool) bulletPool.prewarm(200);
    if (impactVfxPool) impactVfxPool.prewarm(100);
    if (explosionVfxPool) explosionVfxPool.prewarm(50);
    if (damageBlastPool) damageBlastPool.prewarm(30);
    console.log('[ObjectPools] Pre-warmed all pools');
}

// Export for browser
if (typeof window !== 'undefined') {
    window.initializeObjectPools = initializeObjectPools;
    window.createBullet = createBullet;
    window.createImpactVfx = createImpactVfx;
    window.createExplosionVfx = createExplosionVfx;
    window.createDamageBlast = createDamageBlast;
    window.releaseBullet = releaseBullet;
    window.releaseImpactVfx = releaseImpactVfx;
    window.releaseExplosionVfx = releaseExplosionVfx;
    window.releaseDamageBlast = releaseDamageBlast;
    window.getPoolStats = getPoolStats;
    window.prewarmPools = prewarmPools;
}
