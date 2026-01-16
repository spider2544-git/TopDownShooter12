/**
 * LootManager - Manages chest, ground item, and shop systems for GameRoom
 * 
 * Extracted from GameRoom (Phase 2 of incremental manager extraction)
 * 
 * Handles:
 * - Chest loot generation (brown chests, starting gear, gold chests, boss loot)
 * - Ground item positioning
 * - Shop inventory generation and purchases
 * - Enemy drops (ducats, blood markers)
 */

// Import required modules
const GameModeConfigs = require('../../levels/GameModeConfigs.js');

// Check if ENABLE_DEBUG_CHESTS is defined (from server.js global)
const ENABLE_DEBUG_CHESTS = typeof global.ENABLE_DEBUG_CHESTS !== 'undefined' 
    ? global.ENABLE_DEBUG_CHESTS 
    : false;

class LootManager {
    /**
     * @param {GameRoom} room - Reference to the parent GameRoom for state access
     */
    constructor(room) {
        this.room = room;
    }

    // =========================================
    // UTILITY/HELPER METHODS
    // =========================================

    _rng(seed) {
        let s = Math.max(1, Math.floor(seed) % 2147483647);
        return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
    }

    _hashChestId(id) {
        let h = 0; for (let i = 0; i < String(id).length; i++) { h = ((h << 5) - h) + String(id).charCodeAt(i); h |= 0; }
        return Math.abs(h);
    }

    // =========================================
    // CHEST LOOT GENERATION METHODS
    // =========================================

    _generateBrownDrops(chestId, dropCount = 10) {
        const labels = ['+MovSpd','+AtkSpd','+AtkPwr','+Armor','+HP','+Stm','+CritChan','+CritDmg'];
        const rarities = [
            { name: 'Common', color: '#ffffff' },
            { name: 'Uncommon', color: '#2ecc71' },
            { name: 'Rare', color: '#4da3ff' },
            { name: 'Epic', color: '#b26aff' },
            { name: 'Legendary', color: '#ffa64d' }
        ];
        // Seed RNG with room seed + chest hash
        const seed = (this.room.worldSeed || 1) + this._hashChestId(chestId);
        const rnd = this._rng(seed);
        const picks = [];
        const count = dropCount; // Use dropCount parameter from game mode config
        for (let i = 0; i < count; i++) {
            const lab = labels[Math.floor(rnd() * labels.length)];
            const rPick = rnd();
            let rarityIdx = 0; // weighted
            if (rPick < 0.50) rarityIdx = 0; else if (rPick < 0.75) rarityIdx = 1; else if (rPick < 0.90) rarityIdx = 2; else if (rPick < 0.98) rarityIdx = 3; else rarityIdx = 4;
            const rar = rarities[rarityIdx];
            const statData = this._computeStatBonus(lab, rar.name);
            picks.push({ 
                label: lab, 
                rarityName: rar.name, 
                color: rar.color,
                rarity: rar,
                statKey: statData.statKey,
                bonusValue: statData.value,
                isPercent: statData.isPercent
            });
        }
        return picks;
    }
    
    _generateStartingGearDrops(chestId, dropCount = 1) {
        // Starting gear chests always drop Legendary (orange) items
        const labels = ['+MovSpd','+AtkSpd','+AtkPwr','+Armor','+HP','+Stm','+CritChan','+CritDmg'];
        const legendaryRarity = { name: 'Legendary', color: '#ffa64d' };
        
        // Seed RNG with room seed + chest hash for deterministic selection
        const seed = (this.room.worldSeed || 1) + this._hashChestId(chestId);
        const rnd = this._rng(seed);
        const picks = [];
        
        for (let i = 0; i < dropCount; i++) {
            // Pick random stat label
            const lab = labels[Math.floor(rnd() * labels.length)];
            const statData = this._computeStatBonus(lab, legendaryRarity.name);
            picks.push({ 
                label: lab, 
                rarityName: legendaryRarity.name, 
                color: legendaryRarity.color,
                rarity: legendaryRarity,
                statKey: statData.statKey,
                bonusValue: statData.value,
                isPercent: statData.isPercent
            });
        }
        return picks;
    }
    
    // DEBUG FEATURE: Spawn debug chests near each player with 6 random loot items
    // Can be toggled on/off via ENABLE_DEBUG_CHESTS flag
    _spawnDebugChestsNearPlayers() {
        console.log(`[DEBUG_CHEST] === DEBUG CHEST SPAWNER CALLED ===`);
        console.log(`[DEBUG_CHEST] ENABLE_DEBUG_CHESTS flag: ${ENABLE_DEBUG_CHESTS}`);
        console.log(`[DEBUG_CHEST] Current scene: ${this.room.scene}`);
        console.log(`[DEBUG_CHEST] Environment exists: ${!!this.room.environment}`);
        console.log(`[DEBUG_CHEST] Player count: ${this.room.players.size}`);
        
        if (!ENABLE_DEBUG_CHESTS) {
            console.log('[DEBUG_CHEST] ❌ Aborted: ENABLE_DEBUG_CHESTS is false');
            return;
        }
        if (this.room.scene !== 'level') {
            console.log(`[DEBUG_CHEST] ❌ Aborted: Scene is "${this.room.scene}", not "level"`);
            return;
        }
        if (!this.room.environment) {
            console.log('[DEBUG_CHEST] ❌ Aborted: No environment exists');
            return;
        }
        
        console.log('[DEBUG_CHEST] ✅ All checks passed, spawning debug chests near players...');
        
        let chestCount = 0;
        this.room.players.forEach((player, playerId) => {
            console.log(`[DEBUG_CHEST] Processing player ${playerId} at position (${player.x.toFixed(1)}, ${player.y.toFixed(1)})`);

            // Try to find a clear spot near the player
            const clearance = 28;
            const minDist = 80;
            const maxDist = 150;
            const tries = 50;
            
            let chestX = null;
            let chestY = null;
            
            for (let i = 0; i < tries; i++) {
                const angle = Math.random() * Math.PI * 2;
                const dist = minDist + Math.random() * (maxDist - minDist);
                const testX = player.x + Math.cos(angle) * dist;
                const testY = player.y + Math.sin(angle) * dist;
                
                // Check if position is valid
                if (this.room.environment.isInsideBounds(testX, testY, clearance) && 
                    !this.room.environment.circleHitsAny(testX, testY, clearance)) {
                    chestX = testX;
                    chestY = testY;
                    break;
                }
            }
            
            // If no clear spot found, just place it near player anyway
            if (chestX === null || chestY === null) {
                chestX = player.x + 100;
                chestY = player.y + 100;
                console.warn(`[DEBUG_CHEST] ⚠️ Could not find clear spot for player ${playerId}, placing at offset position (${chestX.toFixed(0)}, ${chestY.toFixed(0)})`);
            } else {
                console.log(`[DEBUG_CHEST] ✅ Found clear spot for player ${playerId} at (${chestX.toFixed(0)}, ${chestY.toFixed(0)})`);
            }
            
            // Create debug chest with unique ID
            const debugChestId = `debug_${playerId}_${Date.now()}`;
            const debugChest = {
                id: debugChestId,
                x: chestX,
                y: chestY,
                variant: 'brown',
                opening: false,
                opened: false,
                timeTotal: 10.0,
                timeLeft: 0,
                startedBy: null,
                drops: [],
                dropCount: 6, // 6 items instead of default 10
                radius: 20,
                isDebugChest: true // Mark this as a debug chest for identification
            };
            
            this.room.chests.set(debugChestId, debugChest);
            
            // CRITICAL: Also add to levelSpawns.chests so clients receive it in roomSnapshot
            if (!this.room.levelSpawns) {
                this.room.levelSpawns = { chests: [], npcs: [] };
            }
            if (!this.room.levelSpawns.chests) {
                this.room.levelSpawns.chests = [];
            }
            this.room.levelSpawns.chests.push({
                id: debugChestId,
                x: chestX,
                y: chestY,
                variant: 'brown',
                dropCount: 6
            });
            
            chestCount++;
            
            console.log(`[DEBUG_CHEST] ✅ Created and registered debug chest:`);
            console.log(`[DEBUG_CHEST]    - ID: ${debugChestId}`);
            console.log(`[DEBUG_CHEST]    - Position: (${chestX.toFixed(0)}, ${chestY.toFixed(0)})`);
            console.log(`[DEBUG_CHEST]    - Variant: ${debugChest.variant}`);
            console.log(`[DEBUG_CHEST]    - DropCount: ${debugChest.dropCount}`);
            console.log(`[DEBUG_CHEST]    - Total chests in Map: ${this.room.chests.size}`);
            console.log(`[DEBUG_CHEST]    - Total chests in levelSpawns: ${this.room.levelSpawns.chests.length}`);
        });
        
        console.log(`[DEBUG_CHEST] === SPAWNING COMPLETE ===`);
        console.log(`[DEBUG_CHEST] Successfully spawned ${chestCount} debug chest(s)`);
        console.log(`[DEBUG_CHEST] Total chests in Map: ${this.room.chests.size}`);
        console.log(`[DEBUG_CHEST] Total chests in levelSpawns.chests: ${this.room.levelSpawns.chests.length}`);
    }
    
    _computeStatBonus(label, rarityName) {
        // Map label to stat key
        const raw = label.trim().replace(/^\+/, '');
        let statKey = null;
        switch (raw) {
            case 'HP': statKey = 'Health'; break;
            case 'Health': statKey = 'Health'; break;
            case 'Armor': statKey = 'Armor'; break;
            case 'Stm': statKey = 'Stamina'; break;
            case 'Stamina': statKey = 'Stamina'; break;
            case 'MovSpd': statKey = 'MovSpd'; break;
            case 'AtkSpd': statKey = 'AtkSpd'; break;
            case 'AtkPwr': statKey = 'AtkPwr'; break;
            case 'CritChan': statKey = 'CritChance'; break;
            case 'CritChance': statKey = 'CritChance'; break;
            case 'CritDmg': statKey = 'CritDmg'; break;
        }
        
        // Stat configurations by rarity
        const configs = {
            Health: { values: [10, 20, 50, 100, 150], percent: false },
            Armor: { values: [5, 10, 15, 25, 35], percent: true },
            Stamina: { values: [10, 20, 50, 100, 150], percent: false },
            MovSpd: { values: [5, 10, 15, 25, 30], percent: true },
            AtkSpd: { values: [5, 10, 15, 20, 40], percent: true },
            AtkPwr: { values: [2, 5, 10, 20, 30], percent: false },
            CritChance: { values: [2, 5, 10, 20, 30], percent: true },
            CritDmg: { values: [10, 20, 30, 50, 60], percent: true }
        };
        
        if (!statKey || !configs[statKey]) return { statKey: null, value: 0, isPercent: false };
        
        const rarityOrder = ['Common', 'Uncommon', 'Rare', 'Epic', 'Legendary'];
        const rIdx = rarityOrder.indexOf(rarityName);
        const cfg = configs[statKey];
        const value = cfg.values[Math.max(0, Math.min(rIdx, cfg.values.length - 1))] || 0;
        
        return { statKey, value, isPercent: cfg.percent };
    }

    _generateBossLoot(enemyId) {
        const labels = ['+MovSpd', '+AtkSpd', '+AtkPwr', '+Armor', '+HP', '+Stm', '+CritChan', '+CritDmg'];
        const rarities = [
            { name: 'Epic', color: '#b26aff' },      // purple
            { name: 'Legendary', color: '#ffa64d' }  // orange
        ];
        // Seed RNG with room seed + enemy id for deterministic loot
        const seed = (this.room.worldSeed || 1) + this._hashChestId(String(enemyId));
        const rnd = this._rng(seed);
        const picks = [];
        const count = 10;
        for (let i = 0; i < count; i++) {
            const lab = labels[Math.floor(rnd() * labels.length)];
            const rPick = rnd();
            // Epic (55%) or Legendary (45%)
            const rarityIdx = rPick < 0.55 ? 0 : 1;
            const rar = rarities[rarityIdx];
            const statData = this._computeStatBonus(lab, rar.name);
            picks.push({ 
                label: lab, 
                rarityName: rar.name, 
                color: rar.color,
                rarity: rar,
                statKey: statData.statKey,
                bonusValue: statData.value,
                isPercent: statData.isPercent
            });
        }
          return picks;
      }
  
      _generateEnemyDrops(enemyId, enemyType) {
          // Get drop rates from game mode config
          const config = GameModeConfigs.get(this.room.levelType);
          if (!config || !config.enemies || !config.enemies.dropRates) {
              return { ducats: [], bloodMarkers: [] };
          }
          
          const dropRates = config.enemies.dropRates[enemyType];
          if (!dropRates) return { ducats: [], bloodMarkers: [] };
          
          const drops = { ducats: [], bloodMarkers: [] };
          
          // Roll for ducats with independent RNG seed
          if (dropRates.ducats) {
              const ducatSeed = (this.room.worldSeed || 1) + this._hashChestId(String(enemyId) + '_ducat');
              const ducatRnd = this._rng(ducatSeed);
              const ducatRoll = ducatRnd();
              if (ducatRoll < dropRates.ducats.chance) {
                  const amount = Math.floor(
                      dropRates.ducats.min + ducatRnd() * (dropRates.ducats.max - dropRates.ducats.min + 1)
                  );
                  drops.ducats.push({ amount });
              }
          }
          
          // Roll for blood markers with independent RNG seed
          if (dropRates.bloodMarkers) {
              const markerSeed = (this.room.worldSeed || 1) + this._hashChestId(String(enemyId) + '_marker');
              const markerRnd = this._rng(markerSeed);
              const markerRoll = markerRnd();
              if (markerRoll < dropRates.bloodMarkers.chance) {
                  const amount = Math.floor(
                      dropRates.bloodMarkers.min + markerRnd() * (dropRates.bloodMarkers.max - dropRates.bloodMarkers.min + 1)
                  );
                  drops.bloodMarkers.push({ amount });
              }
          }
          
          return drops;
      }

    // =========================================
    // GROUND ITEM POSITIONING METHODS
    // =========================================

    findClearGroundPosition(baseX, baseY, angle, itemRadius = 12, maxAttempts = 20) {
        const minSpacing = itemRadius * 2 + 6; // 30px for 12px radius items
        let radius = 60; // Start with reasonable distance from drop point
        let currentAngle = angle;
        
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            const x = baseX + Math.cos(currentAngle) * radius;
            const y = baseY + Math.sin(currentAngle) * radius;
            
            // Check boundaries
            if (x < -this.room.boundary || x > this.room.boundary || y < -this.room.boundary || y > this.room.boundary) {
                radius += 20;
                continue;
            }
            
            // Check overlap with existing ground items
            let overlaps = false;
            for (const existingItem of this.room.groundItems.values()) {
                const dx = x - existingItem.x;
                const dy = y - existingItem.y;
                const distance = Math.sqrt(dx * dx + dy * dy);
                if (distance < minSpacing) {
                    overlaps = true;
                    break;
                }
            }
            
            if (!overlaps) {
                return { x, y };
            }
            
            // Try next position: increment angle slightly and increase radius if needed
            currentAngle += 0.3; // ~17 degrees
            if (attempt % 6 === 5) radius += 20; // Expand search radius every 6 attempts
        }
        
        // Fallback: return position even if overlapping (better than infinite loop)
        return { x: baseX + Math.cos(angle) * radius, y: baseY + Math.sin(angle) * radius };
    }

    // =========================================
    // SHOP METHODS
    // =========================================

    _generateShopInventory() {
        const labels = ['+MovSpd', '+AtkSpd', '+AtkPwr', '+Armor', '+HP', '+Stm', '+CritChan', '+CritDmg'];
        const items = [];
        
        // Seed RNG with world seed + timestamp for variety
        const seed = this.room.worldSeed + Date.now();
        const rng = this._createSeededRNG(seed);
        
        // 4 Epic items (purple)
        for (let i = 0; i < 4; i++) {
            const label = labels[Math.floor(rng() * labels.length)];
            const priceMin = 200;
            const priceMax = 400;
            const price = Math.floor((priceMin + rng() * (priceMax - priceMin)) / 25) * 25;
            
            items.push({
                label: label,
                rarityName: 'Epic',
                color: '#b26aff',
                price: price,
                sold: false,
                placeholder: false
            });
        }
        
        // 4 Legendary items (orange)
        for (let i = 0; i < 4; i++) {
            const label = labels[Math.floor(rng() * labels.length)];
            const priceMin = 400;
            const priceMax = 700;
            const price = Math.floor((priceMin + rng() * (priceMax - priceMin)) / 25) * 25;
            
            items.push({
                label: label,
                rarityName: 'Legendary',
                color: '#ffa64d',
                price: price,
                sold: false,
                placeholder: false
            });
        }
        
        // 4 Hats (cosmetic items) - priced in VP
        const hats = [
            { name: 'Capirote', price: 1, currency: 'vp', color: '#8b7355', description: 'Rusted metal conical hat' },
            { name: 'Pope Hat', price: 3, currency: 'vp', color: '#6b2424', description: 'Ornate red papal mitre' },
            { name: 'Prussian Helmet', price: 2, currency: 'vp', color: '#2f4f4f', description: 'WWI Pickelhaube' },
            { name: 'Knight Helmet', price: 2, currency: 'vp', color: '#c0c0c0', description: 'Medieval great helm' }
        ];
        
        for (const hat of hats) {
            items.push({
                type: 'hat',
                label: hat.name,
                rarityName: 'Cosmetic',
                color: hat.color,
                price: hat.price,
                currency: hat.currency,
                sold: false,
                placeholder: false
            });
        }
        
        // 4 Skins (cosmetic body accessories) - ALL COMPLETE - priced in VP
        const skins = [
            { name: 'Crusader Armor', price: 1, currency: 'vp', color: '#8b8b8b', description: 'Shield shoulder pads with crosses and leather belt with pouches' },
            { name: 'Iconoclast', price: 2, currency: 'vp', color: '#6b4423', description: 'Rusted cross shoulder shields, leather straps, rope bindings, and religious icons' },
            { name: 'Officer', price: 2, currency: 'vp', color: '#5c6b4a', description: 'Drab green lapels over metal cuirass with golden cross badges and belt' },
            { name: 'Inquisitor', price: 3, currency: 'vp', color: '#6b2424', description: 'Large red shoulder pauldrons with spikes and heraldic shield badges' }
        ];
        
        for (const skin of skins) {
            items.push({
                type: 'skin',
                label: skin.name,
                rarityName: 'Cosmetic',
                color: skin.color,
                price: skin.price,
                currency: skin.currency,
                sold: false,
                placeholder: false
            });
        }
        
        // No more skin placeholders - all 4 complete!
        
        this.room.shopInventory = items;
        this.room._shopNeedsRefresh = false;
        console.log('[SHOP] Generated new shop inventory with', items.filter(i => !i.placeholder).length, 'items for sale');
    }
    
    _createSeededRNG(seed) {
        let state = seed;
        return function() {
            state = (state * 9301 + 49297) % 233280;
            return state / 233280;
        };
    }
    
    refreshShopIfNeeded() {
        if (this.room._shopNeedsRefresh) {
            this._generateShopInventory();
        }
    }
    
    markShopForRefresh() {
        this.room._shopNeedsRefresh = true;
        console.log('[SHOP] Marked shop for refresh on next request');
    }
    
    getShopInventory() {
        this.refreshShopIfNeeded();
        return this.room.shopInventory;
    }
    
    purchaseShopItem(socketId, itemIndex) {
        const player = this.room.players.get(socketId);
        if (!player) {
            console.warn('[SHOP] Purchase failed: player not found');
            return { success: false, reason: 'Player not found' };
        }
        
        if (itemIndex < 0 || itemIndex >= this.room.shopInventory.length) {
            console.warn('[SHOP] Purchase failed: invalid item index', itemIndex);
            return { success: false, reason: 'Invalid item' };
        }
        
        const item = this.room.shopInventory[itemIndex];
        if (!item || item.sold || item.placeholder) {
            console.warn('[SHOP] Purchase failed: item unavailable');
            return { success: false, reason: 'Item unavailable' };
        }
        
        // Check currency type (default to ducats for backwards compatibility)
        const currency = item.currency || 'ducats';
        
        // Check if player has enough currency
        if (currency === 'vp') {
            if ((player.victoryPoints || 0) < item.price) {
                console.warn('[SHOP] Purchase failed: insufficient VP');
                return { success: false, reason: 'Insufficient Victory Points' };
            }
            // Deduct VP
            player.victoryPoints = (player.victoryPoints || 0) - item.price;
        } else {
            if ((player.ducats || 0) < item.price) {
                console.warn('[SHOP] Purchase failed: insufficient ducats');
                return { success: false, reason: 'Insufficient ducats' };
            }
            // Deduct ducats
            player.ducats = (player.ducats || 0) - item.price;
        }
        
        // Check if item is a hat (cosmetic item)
        if (item.type === 'hat') {
            // Equip the hat directly
            player.equippedHat = {
                name: item.label,
                color: item.color
            };
            
            // Mark item as sold
            item.sold = true;
            
            const currencyName = currency === 'vp' ? 'VP' : 'ducats';
            console.log(`[SHOP] Player ${socketId} equipped hat: ${item.label} for ${item.price} ${currencyName}`);
            
            return { 
                success: true, 
                item: { type: 'hat', label: item.label, color: item.color },
                newDucats: player.ducats,
                newVictoryPoints: player.victoryPoints,
                newInventory: player.inventory,
                equippedHat: player.equippedHat
            };
        }
        
        // Check if item is a skin (cosmetic body accessory)
        if (item.type === 'skin') {
            // Equip the skin directly
            player.equippedSkin = {
                name: item.label,
                color: item.color
            };
            
            // Mark item as sold
            item.sold = true;
            
            const currencyName = currency === 'vp' ? 'VP' : 'ducats';
            console.log(`[SHOP] Player ${socketId} equipped skin: ${item.label} for ${item.price} ${currencyName}`);
            
            return { 
                success: true, 
                item: { type: 'skin', label: item.label, color: item.color },
                newDucats: player.ducats,
                newVictoryPoints: player.victoryPoints,
                newInventory: player.inventory,
                equippedSkin: player.equippedSkin
            };
        }
        
        // Add stat item to player inventory using HexStat-equivalent fields
        const normalizeLabelToKey = (label) => {
            if (!label || typeof label !== 'string') return null;
            const raw = label.trim().replace(/^\+/, '');
            switch (raw) {
                case 'HP': return 'Health';
                case 'Health': return 'Health';
                case 'Armor': return 'Armor';
                case 'Stm': return 'Stamina';
                case 'Stamina': return 'Stamina';
                case 'MovSpd': return 'MovSpd';
                case 'AtkSpd': return 'AtkSpd';
                case 'AtkPwr': return 'AtkPwr';
                case 'CritChan': return 'CritChance';
                case 'CritChance': return 'CritChance';
                case 'CritDmg': return 'CritDmg';
                default: return null;
            }
        };
        const rarityIndex = (name) => {
            const order = ['Common', 'Uncommon', 'Rare', 'Epic', 'Legendary'];
            const idx = order.indexOf(name);
            return idx >= 0 ? idx : 0;
        };
        const STAT_CONFIG = {
            Health: { values: [10, 20, 50, 100, 150], percent: false },
            Armor: { values: [5, 10, 15, 25, 35], percent: true },
            Stamina: { values: [10, 20, 50, 100, 150], percent: false },
            MovSpd: { values: [5, 10, 15, 25, 30], percent: true },
            AtkSpd: { values: [5, 10, 15, 20, 40], percent: true },
            AtkPwr: { values: [2, 5, 10, 20, 30], percent: false },
            CritChance: { values: [2, 5, 10, 20, 30], percent: true },
            CritDmg: { values: [10, 20, 30, 50, 60], percent: true }
        };
        const statKey = normalizeLabelToKey(item.label);
        const cfg = STAT_CONFIG[statKey] || null;
        const rIdx = rarityIndex(item.rarityName);
        const values = cfg ? cfg.values : [0];
        const bonusValue = values[Math.min(Math.max(rIdx, 0), values.length - 1)] || 0;
        const isPercent = cfg ? !!cfg.percent : false;

        const inventoryItem = {
            type: 'HexStat',
            label: item.label,
            rarityName: item.rarityName,
            color: item.color,
            statKey,
            bonusValue,
            isPercent
        };
        
        if (!Array.isArray(player.inventory)) {
            player.inventory = [];
        }
        player.inventory.push(inventoryItem);
        
        // Update loot level and recalc stats immediately
        player.lootLevel = player.inventory.length;
        this.room.recalculatePlayerStats(player);
        
        // Mark item as sold
        item.sold = true;
        
        const currencyName = currency === 'vp' ? 'VP' : 'ducats';
        console.log(`[SHOP] Player ${socketId} purchased ${item.label} (${item.rarityName}) for ${item.price} ${currencyName}`);
        
        return { 
            success: true, 
            item: inventoryItem,
            newDucats: player.ducats,
            newVictoryPoints: player.victoryPoints,
            newInventory: player.inventory
        };
    }
}

module.exports = LootManager;
