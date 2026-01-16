// Weapon Loot Progression Configuration
// Defines how weapon properties scale with player lootLevel (0-6)

const WEAPON_PROGRESSION = {
    // Weapon 1 (index 0) - Cone weapon
    0: {
        0: { 
            // Loot 0 - Primary lvl 1: Thinner Cone
            primary: { 
                coneRangeMultiplier: 0.7,   // 70% of baseline range
                coneHalfMultiplier: 0.8      // 80% of baseline width
            }
        },
        1: {
            // Loot 1 - Secondary lvl 1: Shield Wall (1 wall)
            // Primary stays same as loot 0
            primary: { 
                coneRangeMultiplier: 0.7,   // Same as loot 0
                coneHalfMultiplier: 0.8      // Same as loot 0
            },
            secondary: {
                maxWalls: 1                  // Can place 1 wall
            }
        },
        2: { 
            // Loot 2 - Primary lvl 2: Current Cone (baseline)
            primary: { 
                coneRangeMultiplier: 1.0,    // 100% baseline
                coneHalfMultiplier: 1.0      // 100% baseline
            },
            secondary: {
                maxWalls: 1                  // Secondary same as loot 1
            }
        },
        3: {
            // Loot 3 - Secondary lvl 2: Shield Wall (2 walls)
            // Primary stays same as loot 2
            primary: { 
                coneRangeMultiplier: 1.0,    // Same as loot 2
                coneHalfMultiplier: 1.0      // Same as loot 2
            },
            secondary: {
                maxWalls: 2                  // Can place 2 walls
            }
        },
        4: { 
            // Loot 4 - Primary lvl 3: Big Cone, wider Cone
            primary: { 
                coneRangeMultiplier: 1.3,    // 130% of baseline range
                coneHalfMultiplier: 1.4      // 140% of baseline width
            },
            secondary: {
                maxWalls: 2                  // Secondary same as loot 3
            }
        },
        5: {
            // Loot 5 - Secondary lvl 3: Shield Wall (2 longer walls)
            // Primary stays same as loot 4
            primary: { 
                coneRangeMultiplier: 1.3,    // Same as loot 4
                coneHalfMultiplier: 1.4      // Same as loot 4
            },
            secondary: {
                maxWalls: 2,                 // Can place 2 walls
                wallLengthMultiplier: 1.5    // 50% longer walls
            }
        },
        6: { 
            // Loot 6 - Ultimates: Nothing for now (same as loot 5)
            primary: { 
                coneRangeMultiplier: 1.3,    // Same as loot 4/5
                coneHalfMultiplier: 1.4      // Same as loot 4/5
            },
            secondary: {
                maxWalls: 2,                 // Same as loot 5
                wallLengthMultiplier: 1.5    // Same as loot 5
            }
        }
    },
    
    // Weapon 2 (index 1) - Explosive projectile weapon
    1: {
        0: { 
            // Loot 0 - Primary lvl 1: Smaller Projectile, Smaller explosion, Lower Damage
            primary: { 
                projectileSizeMultiplier: 0.7,    // 70% of baseline projectile size
                explosionRadiusMultiplier: 0.75,  // 75% of baseline explosion radius
                explosionDamageMultiplier: 0.8    // 80% of baseline damage
            }
        },
        1: {
            // Loot 1 - Secondary lvl 1: Place small landmines (cap of 2 mines)
            // Primary stays same as loot 0
            primary: { 
                projectileSizeMultiplier: 0.7,    // Same as loot 0
                explosionRadiusMultiplier: 0.75,  // Same as loot 0
                explosionDamageMultiplier: 0.8    // Same as loot 0
            },
            secondary: {
                maxMines: 2                       // Can place 2 mines
            }
        },
        2: { 
            // Loot 2 - Primary lvl 2: Current Projectile Radius, current explosion, Current Damage
            primary: { 
                projectileSizeMultiplier: 1.0,    // 100% baseline
                explosionRadiusMultiplier: 1.0,   // 100% baseline
                explosionDamageMultiplier: 1.0    // 100% baseline
            },
            secondary: {
                maxMines: 2                       // Secondary same as loot 1
            }
        },
        3: {
            // Loot 3 - Secondary lvl 2: Place medium landmines (current size, cap of 4 mines)
            // Primary stays same as loot 2
            primary: { 
                projectileSizeMultiplier: 1.0,    // Same as loot 2
                explosionRadiusMultiplier: 1.0,   // Same as loot 2
                explosionDamageMultiplier: 1.0    // Same as loot 2
            },
            secondary: {
                maxMines: 4                       // Can place 4 mines
            }
        },
        4: { 
            // Loot 4 - Primary lvl 3: Current Projectile Radius, Wider Explosion, +25% explosion damage
            primary: { 
                projectileSizeMultiplier: 1.0,    // Same projectile size
                explosionRadiusMultiplier: 1.3,   // 130% of baseline explosion radius
                explosionDamageMultiplier: 1.25   // 125% of baseline damage
            },
            secondary: {
                maxMines: 4                       // Secondary same as loot 3
            }
        },
        5: {
            // Loot 5 - Secondary lvl 3: Place big landmines (+50% current size and explosions, cap of 6 mines)
            // Primary stays same as loot 4
            primary: { 
                projectileSizeMultiplier: 1.0,    // Same as loot 4
                explosionRadiusMultiplier: 1.3,   // Same as loot 4
                explosionDamageMultiplier: 1.25   // Same as loot 4
            },
            secondary: {
                maxMines: 6,                      // Can place 6 mines
                mineSizeMultiplier: 1.25,          // 50% bigger mines
                mineExplosionMultiplier: 1.25      // 50% bigger explosions
            }
        },
        6: { 
            // Loot 6 - Ultimates: Nothing for now (same as loot 5)
            primary: { 
                projectileSizeMultiplier: 1.0,    // Same as loot 4/5
                explosionRadiusMultiplier: 1.3,   // Same as loot 4/5
                explosionDamageMultiplier: 1.25   // Same as loot 4/5
            },
            secondary: {
                maxMines: 6,                      // Same as loot 5
                mineSizeMultiplier: 1.25,          // Same as loot 5
                mineExplosionMultiplier: 1.25      // Same as loot 5
            }
        }
    },
    
    // Weapon 3 (index 2) - Charge shot projectile weapon with knockback
    2: {
        0: { 
            // Loot 0 - Primary lvl 1: 70% length of Projectile, must do Charge Shot to get knockback
            primary: { 
                projectileLengthMultiplier: 0.7,      // 70% of baseline projectile length
                normalKnockback: 0,                   // No knockback on normal shots
                chargeKnockbackMultiplier: 1.0,       // Baseline knockback on charge
                chargeSizeMultiplier: 1.2,            // Charge shot 20% larger
                chargeDamageMultiplier: 2.4,          // Charge shot 140% more damage (doubled)
                hasChargeShot: true,                  // Enable charge shot mechanic
                chargeTimeMs: 800                     // Time to fully charge (ms)
            }
        },
        1: {
            // Loot 1 - Secondary lvl 1: Place Heal Station 50hp, small diameter, cap 1
            // Primary stays same as loot 0
            primary: { 
                projectileLengthMultiplier: 0.7,      // Same as loot 0
                normalKnockback: 0,
                chargeKnockbackMultiplier: 1.0,
                chargeSizeMultiplier: 1.2,
                chargeDamageMultiplier: 2.4,
                hasChargeShot: true,
                chargeTimeMs: 800
            },
            secondary: {
                maxHealStations: 1,                   // Can place 1 heal station
                healAmount: 50,                       // 50 HP healing
                healDiameterMultiplier: 0.8           // Small diameter (80% of baseline)
            }
        },
        2: { 
            // Loot 2 - Primary lvl 2: Current projectile length, all shots do push back
            // Charge shot: 40% larger, 40% more pushback, 4x damage (doubled)
            primary: { 
                projectileLengthMultiplier: 1.0,      // 100% baseline length
                normalKnockback: 1.302,               // 125 knockback (125/96)
                chargeKnockbackMultiplier: 1.4,       // 40% more knockback on charge (175)
                chargeSizeMultiplier: 1.4,            // Charge shot 40% larger
                chargeDamageMultiplier: 4.0,          // Charge shot 4x damage (doubled)
                hasChargeShot: true,
                chargeTimeMs: 800
            },
            secondary: {
                maxHealStations: 1,                   // Secondary same as loot 1
                healAmount: 50,
                healDiameterMultiplier: 0.8
            }
        },
        3: {
            // Loot 3 - Secondary lvl 2: Place Heal Station 100hp, medium diameter, cap 2
            // Primary stays same as loot 2
            primary: { 
                projectileLengthMultiplier: 1.0,      // Same as loot 2
                normalKnockback: 1.302,               // 125 knockback (same as loot 2)
                chargeKnockbackMultiplier: 1.5,       // 50% more knockback on charge (187.5)
                chargeSizeMultiplier: 1.5,            // Charge shot 50% larger
                chargeDamageMultiplier: 4.0,          // Charge shot 4x damage (doubled)
                hasChargeShot: true,
                chargeTimeMs: 800
            },
            secondary: {
                maxHealStations: 2,                   // Can place 2 heal stations
                healAmount: 100,                      // 100 HP healing
                healDiameterMultiplier: 1.0           // Medium diameter (100% baseline)
            }
        },
        4: { 
            // Loot 4 - Primary lvl 3: +30% projectile length, all shots push back
            // Charge shot: 60% larger, 60% more pushback, 4.6x damage (doubled), gains width
            primary: { 
                projectileLengthMultiplier: 1.3,      // 130% baseline length (+30%)
                normalKnockback: 1.5625,              // 150 knockback (150/96)
                chargeKnockbackMultiplier: 1.6,       // 60% more knockback (240)
                chargeSizeMultiplier: 1.6,            // Charge shot 60% larger
                chargeDamageMultiplier: 4.6,          // Charge shot 4.6x damage (doubled)
                chargeGainsWidth: true,               // Charge shot also gains width at this tier
                hasChargeShot: true,
                chargeTimeMs: 800
            },
            secondary: {
                maxHealStations: 2,                   // Secondary same as loot 3
                healAmount: 100,
                healDiameterMultiplier: 1.0
            }
        },
        5: {
            // Loot 5 - Secondary lvl 3: Place Heal Station 150hp, large diameter, cap 3
            // Primary stays same as loot 4
            primary: { 
                projectileLengthMultiplier: 1.3,      // Same as loot 4
                normalKnockback: 1.5625,              // 150 knockback (same as loot 4)
                chargeKnockbackMultiplier: 1.6,       // 60% more knockback (240)
                chargeSizeMultiplier: 1.6,            // Charge shot 60% larger
                chargeDamageMultiplier: 4.6,          // Charge shot 4.6x damage (doubled)
                chargeGainsWidth: true,               // Charge shot also gains width at this tier
                hasChargeShot: true,
                chargeTimeMs: 800
            },
            secondary: {
                maxHealStations: 3,                   // Can place 3 heal stations
                healAmount: 150,                      // 150 HP healing
                healDiameterMultiplier: 1.3           // Large diameter (130% baseline)
            }
        },
        6: { 
            // Loot 6 - Ultimates: Nothing for now (same as loot 5)
            primary: { 
                projectileLengthMultiplier: 1.3,      // Same as loot 4/5
                normalKnockback: 1.5625,              // 150 knockback (same as loot 4/5)
                chargeKnockbackMultiplier: 1.6,       // 60% more knockback (240)
                chargeSizeMultiplier: 1.6,            // Charge shot 60% larger
                chargeDamageMultiplier: 4.6,          // Charge shot 4.6x damage (doubled)
                chargeGainsWidth: true,               // Charge shot also gains width at this tier
                hasChargeShot: true,
                chargeTimeMs: 800
            },
            secondary: {
                maxHealStations: 3,                   // Same as loot 5
                healAmount: 150,
                healDiameterMultiplier: 1.3
            }
        }
    },
    
    // Weapon 4 (index 3) - Flamethrower with Molotov Pool
    3: {
        0: { 
            // Loot 0 - Primary lvl 1: 2.5x faster stamina use, 40% weapon fire rate
            primary: { 
                fireRateMultiplier: 0.4,         // 40% of baseline fire rate (27.2 -> 10.88)
                staminaDrainMultiplier: 2.5      // 2.5x faster stamina consumption while firing
            }
        },
        1: {
            // Loot 1 - Secondary lvl 1: 65% DOTs, 30% diameter, cap 1
            primary: { 
                fireRateMultiplier: 0.4,         // Same as loot 0
                staminaDrainMultiplier: 2.5      // Same as loot 0
            },
            secondary: {
                maxPools: 1,                     // Can place 1 molotov pool
                dotDamageMultiplier: 0.65,       // 65% of baseline DOT damage
                poolDiameterMultiplier: 0.30     // 30% of baseline pool diameter
            }
        },
        2: { 
            // Loot 2 - Primary lvl 2: 1.25x faster stamina use, 60% weapon fire rate
            primary: { 
                fireRateMultiplier: 0.6,         // 60% of baseline fire rate (27.2 -> 16.32)
                staminaDrainMultiplier: 1.25     // 1.25x faster stamina consumption while firing
            },
            secondary: {
                maxPools: 1,                     // Secondary same as loot 1
                dotDamageMultiplier: 0.65,       // Same as loot 1
                poolDiameterMultiplier: 0.30     // Same as loot 1
            }
        },
        3: {
            // Loot 3 - Secondary lvl 2: 85% DOTs, 60% diameter, cap 1
            primary: { 
                fireRateMultiplier: 0.6,         // Same as loot 2
                staminaDrainMultiplier: 1.25     // Same as loot 2
            },
            secondary: {
                maxPools: 1,                     // Can place 1 molotov pool
                dotDamageMultiplier: 0.85,       // 85% of baseline DOT damage
                poolDiameterMultiplier: 0.60     // 60% of baseline pool diameter
            }
        },
        4: { 
            // Loot 4 - Primary lvl 3: Current flamethrower, 100% DOTs, 85% diameter
            primary: { 
                fireRateMultiplier: 1.0,         // 100% baseline fire rate (27.2)
                staminaDrainMultiplier: 1.0      // 1.0x baseline stamina consumption
            },
            secondary: {
                maxPools: 1,                     // Can place 1 molotov pool
                dotDamageMultiplier: 1.0,        // 100% of baseline DOT damage
                poolDiameterMultiplier: 0.85     // 85% of baseline pool diameter
            }
        },
        5: {
            // Loot 5 - Secondary lvl 3: 100% DOTs, 85% diameter, cap 1
            primary: { 
                fireRateMultiplier: 1.0,         // Same as loot 4
                staminaDrainMultiplier: 1.0      // Same as loot 4
            },
            secondary: {
                maxPools: 1,                     // Can place 1 molotov pool
                dotDamageMultiplier: 1.0,        // 100% of baseline DOT damage
                poolDiameterMultiplier: 0.85     // 85% of baseline pool diameter
            }
        },
        6: { 
            // Loot 6 - Ultimates: Nothing for now (same as loot 5)
            primary: { 
                fireRateMultiplier: 1.0,         // Same as loot 4/5
                staminaDrainMultiplier: 1.0      // Same as loot 4/5
            },
            secondary: {
                maxPools: 1,                     // Same as loot 5
                dotDamageMultiplier: 1.0,        // Same as loot 5
                poolDiameterMultiplier: 0.85     // Same as loot 5
            }
        }
    },
    
    // Weapon 5 (index 4) - Piercing burst projectile weapon
    4: {
        0: { 
            // Loot 0 - Primary lvl 1: 1 piercing shot (basically single shot)
            primary: { 
                burstCount: 1                        // Single shot per trigger pull
            }
        },
        1: {
            // Loot 1 - Secondary lvl 1: 10 Blood Markers Per Second (high drain)
            // Primary stays same as loot 0
            primary: { 
                burstCount: 1                        // Single shot per trigger pull
            },
            secondary: {
                bloodDrainPerSecond: 10              // Burns through blood quickly
            }
        },
        2: { 
            // Loot 2 - Primary lvl 2: 2 piercing shot burst
            primary: { 
                burstCount: 2                        // Double burst per trigger pull
            },
            secondary: {
                bloodDrainPerSecond: 10              // Secondary same as loot 1
            }
        },
        3: {
            // Loot 3 - Secondary lvl 2: 5 Blood Markers Per Second (medium drain)
            // Primary stays same as loot 2
            primary: { 
                burstCount: 2                        // Double burst per trigger pull
            },
            secondary: {
                bloodDrainPerSecond: 5               // More efficient blood usage
            }
        },
        4: { 
            // Loot 4 - Primary lvl 3: 3 piercing shot burst (current)
            primary: { 
                burstCount: 3                        // Triple burst per trigger pull
            },
            secondary: {
                bloodDrainPerSecond: 5               // Secondary same as loot 3
            }
        },
        5: {
            // Loot 5 - Secondary lvl 3: 2 Blood Markers Per Second (low drain)
            // Primary stays same as loot 4
            primary: { 
                burstCount: 3                        // Triple burst per trigger pull
            },
            secondary: {
                bloodDrainPerSecond: 2               // Very efficient blood usage
            }
        },
        6: { 
            // Loot 6 - Ultimates: Nothing for now (same as loot 5)
            primary: { 
                burstCount: 3                        // Triple burst per trigger pull
            },
            secondary: {
                bloodDrainPerSecond: 2               // Same as loot 5
            }
        }
    },
    
    // Weapon 6 (index 5) - High-speed tracer weapon with player recoil pushback
    5: {
        0: { 
            // Loot 0 - Primary lvl 1: 50% base damage, 9 units recoil, current projectile scale
            // No secondary ability unlocked yet
            primary: { 
                damageMultiplier: 0.5,          // 50% of baseline damage
                recoilMultiplier: 0.25,         // 9 units pushback (36 * 0.25)
                projectileScaleMultiplier: 1.0   // 100% baseline projectile scale
            }
        },
        1: {
            // Loot 1 - Secondary lvl 1: Small Attractor Radius (50% current radius), cap of 1
            // Primary stays same as loot 0
            primary: { 
                damageMultiplier: 0.5,          // Same as loot 0
                recoilMultiplier: 0.25,         // Same as loot 0 (9 units)
                projectileScaleMultiplier: 1.0   // Same as loot 0
            },
            secondary: {
                maxAttractors: 1,               // Can place 1 attractor
                targetRadiusMultiplier: 0.5,    // 50% of baseline target radius (150 * 0.5 = 75)
                attractionRadiusMultiplier: 0.5 // 50% of baseline attraction radius (200 * 0.5 = 100)
            }
        },
        2: { 
            // Loot 2 - Primary lvl 2: 75% base damage, 18 units recoil, 150% projectile scale
            // Secondary stays same as loot 1
            primary: { 
                damageMultiplier: 0.75,         // 75% of baseline damage
                recoilMultiplier: 0.5,          // 18 units pushback (36 * 0.5)
                projectileScaleMultiplier: 1.5   // 150% of baseline projectile scale
            },
            secondary: {
                maxAttractors: 1,               // Same as loot 1
                targetRadiusMultiplier: 0.5,    // Same as loot 1 (75 radius)
                attractionRadiusMultiplier: 0.5 // Same as loot 1 (100 radius)
            }
        },
        3: {
            // Loot 3 - Secondary lvl 2: Medium Attractor Radius (75% Current), cap of 2
            // Primary stays same as loot 2
            primary: { 
                damageMultiplier: 0.75,         // Same as loot 2
                recoilMultiplier: 0.5,          // Same as loot 2 (18 units)
                projectileScaleMultiplier: 1.5   // Same as loot 2
            },
            secondary: {
                maxAttractors: 2,               // Can place 2 attractors
                targetRadiusMultiplier: 0.75,   // 75% of baseline target radius (150 * 0.75 = 112.5)
                attractionRadiusMultiplier: 0.75 // 75% of baseline attraction radius (200 * 0.75 = 150)
            }
        },
        4: { 
            // Loot 4 - Primary lvl 3: 100% base damage, 36 units recoil, 200% projectile scale
            // Secondary stays same as loot 3
            primary: { 
                damageMultiplier: 1.0,          // 100% baseline damage
                recoilMultiplier: 1.0,          // 36 units pushback (36 * 1.0)
                projectileScaleMultiplier: 2.0   // 200% of baseline projectile scale
            },
            secondary: {
                maxAttractors: 2,               // Same as loot 3
                targetRadiusMultiplier: 0.75,   // Same as loot 3 (112.5 radius)
                attractionRadiusMultiplier: 0.75 // Same as loot 3 (150 radius)
            }
        },
        5: {
            // Loot 5 - Secondary lvl 3: Large Attractor Radius (Current), cap of 3
            // Primary stays same as loot 4
            primary: { 
                damageMultiplier: 1.0,          // Same as loot 4
                recoilMultiplier: 1.0,          // Same as loot 4 (36 units)
                projectileScaleMultiplier: 2.0   // Same as loot 4
            },
            secondary: {
                maxAttractors: 3,               // Can place 3 attractors
                targetRadiusMultiplier: 1.0,    // 100% of baseline target radius (150)
                attractionRadiusMultiplier: 1.0 // 100% of baseline attraction radius (200)
            }
        },
        6: { 
            // Loot 6 - Ultimates: Nothing for now (same as loot 5)
            primary: { 
                damageMultiplier: 1.0,          // Same as loot 4/5
                recoilMultiplier: 1.0,          // Same as loot 4/5 (36 units)
                projectileScaleMultiplier: 2.0   // Same as loot 4/5
            },
            secondary: {
                maxAttractors: 3,               // Same as loot 5
                targetRadiusMultiplier: 1.0,    // Same as loot 5 (150 radius)
                attractionRadiusMultiplier: 1.0 // Same as loot 5 (200 radius)
            }
        }
    },
    
    // Weapon 7 (index 6) - Auto-targeting tracer weapon with Auto Turret
    6: {
        0: { 
            // Loot 0 - Primary lvl 1: 30 rds, 50% fire rate
            primary: { 
                ammoMaxMultiplier: 0.5,         // 50% of baseline max ammo (60 * 0.5 = 30)
                fireRateMultiplier: 0.5          // 50% of baseline fire rate (6.8 * 0.5 = 3.4)
            }
        },
        1: {
            // Loot 1 - Secondary lvl 1: 1 turret cap, 50 hp/rds
            // Primary stays same as loot 0
            primary: { 
                ammoMaxMultiplier: 0.5,         // Same as loot 0 (30 rds)
                fireRateMultiplier: 0.5          // Same as loot 0
            },
            secondary: {
                maxTurrets: 1,                   // Can place 1 turret
                turretHealth: 50                 // 50 HP per turret
            }
        },
        2: { 
            // Loot 2 - Primary lvl 2: 45 rds, 75% fire rate
            primary: { 
                ammoMaxMultiplier: 0.75,        // 75% of baseline max ammo (60 * 0.75 = 45)
                fireRateMultiplier: 0.75         // 75% of baseline fire rate (6.8 * 0.75 = 5.1)
            },
            secondary: {
                maxTurrets: 1,                   // Secondary same as loot 1
                turretHealth: 50
            }
        },
        3: {
            // Loot 3 - Secondary lvl 2: 2 turret cap, 100 hp/rds
            // Primary stays same as loot 2
            primary: { 
                ammoMaxMultiplier: 0.75,        // Same as loot 2 (45 rds)
                fireRateMultiplier: 0.75         // Same as loot 2
            },
            secondary: {
                maxTurrets: 2,                   // Can place 2 turrets
                turretHealth: 100                // 100 HP per turret
            }
        },
        4: { 
            // Loot 4 - Primary lvl 3: Current (60 rds, 100% fire rate)
            primary: { 
                ammoMaxMultiplier: 1.0,         // 100% baseline max ammo (60)
                fireRateMultiplier: 1.0          // 100% baseline fire rate (6.8)
            },
            secondary: {
                maxTurrets: 2,                   // Secondary same as loot 3
                turretHealth: 100
            }
        },
        5: {
            // Loot 5 - Secondary lvl 3: 3 turret cap, 150 hp/rds
            // Primary stays same as loot 4
            primary: { 
                ammoMaxMultiplier: 1.0,         // Same as loot 4 (60 rds)
                fireRateMultiplier: 1.0          // Same as loot 4
            },
            secondary: {
                maxTurrets: 3,                   // Can place 3 turrets
                turretHealth: 150                // 150 HP per turret
            }
        },
        6: { 
            // Loot 6 - Ultimates: Nothing for now (same as loot 5)
            primary: { 
                ammoMaxMultiplier: 1.0,         // Same as loot 4/5 (60 rds)
                fireRateMultiplier: 1.0          // Same as loot 4/5
            },
            secondary: {
                maxTurrets: 3,                   // Same as loot 5
                turretHealth: 150
            }
        }
    },
    
    // Weapon 8 (index 7) - Shotgun primary / Hitscan ADS
    7: {
        0: {
            // Loot 0: 4 pellets, low fire rate, 3 blood markers per ADS shot, 75 damage, 15% crit, thin tracer
            primary: {
                fireRateMultiplier: 0.5,  // 7.0 rps (50% of baseline)
                pelletCount: 4,           // 4 shotgun pellets
                pelletDamage: 5,          // 5 damage per pellet (20 total)
                adsBloodCost: 3,
                adsDamage: 75,
                adsCritChance: 0.15,
                tracerRectWidth: 8,       // Thin tracer
                tracerRectHeight: 0.5
            }
        },
        1: {
            // Loot 1: Same as loot 0
            primary: {
                fireRateMultiplier: 0.5,
                pelletCount: 4,
                pelletDamage: 5,
                adsBloodCost: 3,
                adsDamage: 75,
                adsCritChance: 0.15,
                tracerRectWidth: 8,
                tracerRectHeight: 0.5
            }
        },
        2: {
            // Loot 2: 6 pellets, medium fire rate, 2 blood markers per ADS shot, 100 damage, 25% crit, medium tracer
            primary: {
                fireRateMultiplier: 0.75,  // 10.5 rps (75% of baseline)
                pelletCount: 6,            // 6 shotgun pellets
                pelletDamage: 5,           // 5 damage per pellet (30 total)
                adsBloodCost: 2,
                adsDamage: 100,
                adsCritChance: 0.25,
                tracerRectWidth: 12,       // Medium tracer
                tracerRectHeight: 1.0
            }
        },
        3: {
            // Loot 3: Same as loot 2
            primary: {
                fireRateMultiplier: 0.75,
                pelletCount: 6,
                pelletDamage: 5,
                adsBloodCost: 2,
                adsDamage: 100,
                adsCritChance: 0.25,
                tracerRectWidth: 12,
                tracerRectHeight: 1.0
            }
        },
        4: {
            // Loot 4: 8 pellets, high fire rate, 1 blood marker per ADS shot, 125 damage, 35% crit, thick tracer
            primary: {
                fireRateMultiplier: 1.0,  // 14.0 rps (100% baseline)
                pelletCount: 8,           // 8 shotgun pellets
                pelletDamage: 5,          // 5 damage per pellet (40 total)
                adsBloodCost: 1,
                adsDamage: 125,
                adsCritChance: 0.35,
                tracerRectWidth: 16,       // Thick tracer
                tracerRectHeight: 2.0
            }
        },
        5: {
            // Loot 5: Same as loot 4
            primary: {
                fireRateMultiplier: 1.0,
                pelletCount: 8,
                pelletDamage: 5,
                adsBloodCost: 1,
                adsDamage: 125,
                adsCritChance: 0.35,
                tracerRectWidth: 16,
                tracerRectHeight: 2.0
            }
        },
        6: {
            // Loot 6: Same as loot 4-5
            primary: {
                fireRateMultiplier: 1.0,
                pelletCount: 8,
                pelletDamage: 5,
                adsBloodCost: 1,
                adsDamage: 125,
                adsCritChance: 0.35,
                tracerRectWidth: 16,
                tracerRectHeight: 2.0
            }
        }
    }
};

/**
 * Get weapon progression data for a specific weapon at a specific loot level
 * @param {number} weaponIndex - Weapon index (0-6)
 * @param {number} lootLevel - Player's effective loot level (0-6)
 * @returns {object} Progression data with primary/secondary properties
 */
function getWeaponProgression(weaponIndex, lootLevel) {
    const clampedLevel = Math.max(0, Math.min(6, lootLevel));
    const weaponData = WEAPON_PROGRESSION[weaponIndex];
    
    if (!weaponData) {
        return {}; // Weapon not yet configured
    }
    
    // Return exact tier data if it exists, otherwise empty object
    return weaponData[clampedLevel] || {};
}

// Expose to window for global access (browser)
if (typeof window !== 'undefined') {
    window.getWeaponProgression = getWeaponProgression;
    window.WEAPON_PROGRESSION = WEAPON_PROGRESSION;
}

// Export for Node.js (server)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        getWeaponProgression,
        WEAPON_PROGRESSION
    };
}

