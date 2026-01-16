/**
 * Network Protocol Definition - Phase 3
 * 
 * This module is the SINGLE SOURCE OF TRUTH for all network event names and payload shapes.
 * It works in both browser (classic script) and Node.js (CommonJS).
 * 
 * Goals:
 * - Versioned protocol to detect client/server mismatches
 * - Canonical event names to avoid typos and drift
 * - Runtime validation for client→server events (security)
 * - Feature flags for dual-emit during entity consolidation
 */

(function(global) {
	'use strict';
	
	// ========== PROTOCOL VERSION ==========
	const PROTOCOL_VERSION = '1.0.0-refactor';
	
	// ========== FEATURE FLAGS ==========
	// Phase 4: Keeping dual-emit for stability (can disable after thorough testing)
	const FEATURES = {
		// Keep both formats for now to ensure compatibility
		DUAL_EMIT_ENTITIES: true,
		
		// Individual entity type flags (allows gradual rollout)
		ENTITIES_INCLUDE_ENEMIES: true,  // Active - using entitiesState
		ENTITIES_INCLUDE_NPCS: false,     // Future expansion
		ENTITIES_INCLUDE_TROOPS: false,   // Future expansion
		ENTITIES_INCLUDE_HAZARDS: false   // Future expansion
	};
	
	// ========== CLIENT → SERVER EVENTS ==========
	// These are requests/inputs sent from client to authoritative server
	const ClientEvents = {
		// Connection & room
		JOIN_ROOM: 'joinRoom',
		PLAYER_INPUT: 'playerInput',
		DISCONNECT: 'disconnect',
		
		// NFC
		REQUEST_NFC_UNLOCK: 'requestNfcUnlock',
		
		// Timers & mode selection
		SET_LEVEL_TYPE: 'setLevelType',
		READY_TIMER_START: 'readyTimerStart',
		READY_TIMER_CANCEL: 'readyTimerCancel',
		EXTRACTION_TIMER_START: 'extractionTimerStart',
		EXTRACTION_TIMER_CANCEL: 'extractionTimerCancel',
		SCENE_CHANGE: 'sceneChange',
		
		// Player lifecycle
		PLAYER_DEATH: 'playerDeath',
		PLAYER_RESPAWN: 'playerRespawn',
		REVIVE_START_REQUEST: 'reviveStartRequest',
		REVIVE_ACCEPT: 'reviveAccept',
		
		// PvP & state
		SET_EVIL_STATE: 'setEvilState',
		PVP_DIRECT_DAMAGE: 'pvpDirectDamage',
		INVINCIBILITY_TOGGLE: 'invincibilityToggle',
		INVISIBILITY_TOGGLE: 'invisibilityToggle',
		
		// Items, loot, objectives
		CHEST_OPEN_REQUEST: 'chestOpenRequest',
		CHEST_DAMAGE: 'chestDamage',
		INVENTORY_DROP_REQUEST: 'inventoryDropRequest',
		INVENTORY_PICKUP_REQUEST: 'inventoryPickupRequest',
		ARTIFACT_PICKUP_REQUEST: 'artifactPickupRequest',
		ARTIFACT_DROP_REQUEST: 'artifactDropRequest',
		ARTIFACT_DAMAGE: 'artifactDamage',
		BATTERY_PICKUP_REQUEST: 'batteryPickupRequest',
		BATTERY_DROP_REQUEST: 'batteryDropRequest',
		BATTERY_PLACE_REQUEST: 'batteryPlaceRequest',
		
		// Combat
		BULLET_FIRED: 'bulletFired',
		WEAPON7_HITSCAN: 'weapon7Hitscan',
		WEAPON8_HITSCAN: 'weapon8Hitscan',
		PROJECTILE_HIT: 'projectileHit',
		EXPLOSION_DAMAGE: 'explosionDamage',
		DOT_TICK: 'dotTick',
		BARREL_DAMAGE: 'barrelDamage',
		ENEMY_DIED: 'enemyDied', // Client reporting death (server validates)
		
		// NPCs
		NPC_DAMAGE: 'npcDamage',
		NPC_DOT: 'npcDot',
		NPC_SET_STATE: 'npcSetState',
		
		// Abilities
		ABILITY_CREATE: 'abilityCreate',
		ABILITY_DAMAGE: 'abilityDamage',
		ABILITY_TRIGGER: 'abilityTrigger',
		ABILITY_DOT_DAMAGE: 'abilityDotDamage',
		
		// Shop & quartermaster
		REQUEST_SHOP_INVENTORY: 'requestShopInventory',
		PURCHASE_SHOP_ITEM: 'purchaseShopItem',
		QUARTERMASTER_REQUISITION: 'quartermasterRequisition',
		
		// Potions
		USE_HEALTH_POTION: 'useHealthPotion',
		
		// Debug
		DEBUG_SPAWN_HORDE: 'debugSpawnHorde',
		DEBUG_SET_VALUE: 'debugSetValue',
		KILL_GHOST_ENEMY: 'killGhostEnemy'
	};
	
	// ========== SERVER → CLIENT EVENTS ==========
	// These are state updates + gameplay events sent from authoritative server
	const ServerEvents = {
		// Core sync
		WORLD_SEED: 'worldSeed',
		ROOM_SNAPSHOT: 'roomSnapshot',
		GAME_STATE: 'gameState',
		GAME_STATE_DELTA: 'gameStateDelta',
		PLAYER_JOINED: 'playerJoined',
		PLAYER_LEFT: 'playerLeft',
		PLAYER_UPDATE: 'playerUpdate',
		
		// Level & mode sync
		LEVEL_TYPE_SYNC: 'levelTypeSync',
		SCENE_CHANGE: 'sceneChange',
		NAV_MESH_DEBUG: 'navMeshDebug',
		
		// Enemies (legacy - being migrated to entitiesState)
		ENEMIES_STATE: 'enemiesState',
		ENEMY_HEALTH_UPDATE: 'enemyHealthUpdate',
		ENEMY_DIED: 'enemyDied',
		HORDE_SPAWNED: 'hordeSpawned',
		HORDE_SPAWNED_LEGACY: 'horde_spawned',
		ENEMY_DEAD: 'enemy_dead',
		ENTITY_DEAD: 'entity_dead',
		ENEMY_DASH_WINDUP: 'enemyDashWindup',
		ENEMY_DASH: 'enemyDash',
		BOOMER_EXPLODED: 'boomerExploded',
		ENEMY_PROJECTILE_FIRED: 'enemyProjectileFired',
		ENEMY_PROJECTILE_HIT: 'enemyProjectileHit',
		ENEMY_MELEE_ATTACK: 'enemyMeleeAttack',
		ARTILLERY_STRIKE: 'artilleryStrike',
		ARTILLERY_GUN_STRIKE: 'artilleryGunStrike',
		DEFENSE_TURRET_SHOT: 'defenseTurretShot',
		BOSS_FAST_BALL: 'bossFastBall',
		BOSS_DASHED: 'bossDashed',
		
		// Phase 3: New consolidated entity stream (replaces enemiesState, npcsState, troopsState)
		ENTITIES_STATE: 'entitiesState',
		ENTITY_EVENT: 'entityEvent',
		
		// Players & status
		PLAYER_HEALTH: 'playerHealth',
		PLAYER_HEALTH_UPDATE: 'playerHealthUpdate',
		PLAYER_HEALED: 'playerHealed',
		DASH_FEEDBACK: 'dashFeedback',
		PLAYER_SLOW_STATE: 'playerSlowState',
		PLAYER_MUD_SLOW_STATE: 'playerMudSlowState',
		PLAYER_GAS_INTENSITY: 'playerGasIntensity',
		LICKER_ENSNARED: 'lickerEnsnared',
		PLAYER_EVIL_STATE: 'playerEvilState',
		INVINCIBILITY_SYNC: 'invincibilitySync',
		INVISIBILITY_STATE: 'invisibilityState',
		INVISIBILITY_REJECTED: 'invisibilityRejected',
		
		// Revive
		REVIVE_READY: 'reviveReady',
		
		// Hazards
		HAZARDS_STATE: 'hazardsState',
		HAZARD_HIT: 'hazardHit',
		HAZARD_REMOVED: 'hazardRemoved',
		BARREL_FUSE_START: 'barrelFuseStart',
		BARREL_HIT: 'barrelHit',
		BARREL_EXPLODED: 'barrelExploded',
		
		// NPCs
		AMBIENT_NPCS_SYNC: 'ambientNpcsSync',
		NPCS_STATE: 'npcsState',
		NPC_ATTACK: 'npcAttack',
		NPC_EXPLODE: 'npcExplode',
		NPC_FIRE: 'npc_fire',
		NPC_DAMAGED: 'npcDamaged',
		NPC_DOT_DAMAGE: 'npcDotDamage',
		NPC_DEAD: 'npc_dead',
		
		// Troops
		TROOPS_STATE: 'troopsState',
		TROOP_ATTACK: 'troopAttack',
		TROOP_HITSCAN: 'troopHitscan',
		TROOP_GRENADE: 'troopGrenade',
		TROOP_DAMAGED: 'troopDamaged',
		TROOP_DEATH: 'troopDeath',
		
		// Timers & mission
		READY_TIMER_UPDATE: 'readyTimerUpdate',
		EXTRACTION_TIMER_UPDATE: 'extractionTimerUpdate',
		PHASE_TIMER_UPDATE: 'phase_timer_update',
		PHASE_CHANGE: 'phase_change',
		WAVE_START: 'wave_start',
		MISSION_FAILED: 'missionFailed',
		MISSION_SUCCESS: 'missionSuccess',
		
		// Chests, loot, inventory
		CHEST_TIMER_UPDATE: 'chestTimerUpdate',
		CHEST_OPENED: 'chestOpened',
		CHEST_HEALTH_UPDATE: 'chestHealthUpdate',
		CHEST_HIT_FLASH: 'chestHitFlash',
		BOSS_SPAWN_DATA: 'bossSpawnData',
		BOSS_LOOT_DROPPED: 'bossLootDropped',
		ENEMY_DROPS: 'enemyDrops',
		INVENTORY_DROPPED: 'inventoryDropped',
		INVENTORY_PICKED_UP: 'inventoryPickedUp',
		CURRENCY_PICKED_UP: 'currencyPickedUp',
		CURRENCY_UPDATED: 'currencyUpdated',
		
		// Artifact
		ARTIFACT_PICKED_UP: 'artifactPickedUp',
		ARTIFACT_DROPPED: 'artifactDropped',
		ARTIFACT_HEALTH_UPDATE: 'artifactHealthUpdate',
		ARTIFACT_HIT_FLASH: 'artifactHitFlash',
		ARTIFACT_DESTROYED: 'artifactDestroyed',
		
		// Batteries
		BATTERY_STATION_STATE: 'batteryStationState',
		BATTERY_STATE: 'batteryState',
		BATTERY_PICKED_UP: 'batteryPickedUp',
		BATTERY_DROPPED: 'batteryDropped',
		BATTERY_PLACED: 'batteryPlaced',
		BATTERY_STATION_POWERED: 'batteryStationPowered',
		
		// Shop & quartermaster
		SHOP_INVENTORY: 'shopInventory',
		PURCHASE_RESULT: 'purchaseResult',
		QUARTERMASTER_REWARD: 'quartermasterReward',
		
		// Abilities & VFX
		ABILITY_REJECTED: 'abilityRejected',
		ABILITY_CREATED: 'abilityCreated',
		ABILITY_DAMAGED: 'abilityDamaged',
		ABILITY_HEALTH_UPDATE: 'abilityHealthUpdate',
		ABILITY_EXPIRED: 'abilityExpired',
		ABILITY_TRIGGERED: 'abilityTriggered',
		TURRET_FIRE: 'turretFire',
		VFX_EVENT: 'vfxEvent',
		VFX_CREATED: 'vfxCreated',
		
		// NFC
		NFC_STATUS: 'nfcStatus',
		NFC_UNLOCK: 'nfcUnlock',
		
		// Potions
		POTION_STARTED: 'potionStarted',
		POTION_ENDED: 'potionEnded'
	};
	
	// ========== PAYLOAD VALIDATORS ==========
	// These validate client→server events to prevent malicious/malformed requests
	
	/**
	 * Validates a client event payload. Returns { valid: boolean, error?: string }
	 */
	function validateClientEvent(eventName, payload) {
		// Basic type checks for most common/security-critical events
		// Expand this as we identify high-risk payloads
		
		switch (eventName) {
			case ClientEvents.PLAYER_INPUT:
				if (!payload || typeof payload !== 'object') {
					return { valid: false, error: 'playerInput must be an object' };
				}
				// Could add more specific validation here (keys, angles, etc.)
				return { valid: true };
			
			case ClientEvents.BULLET_FIRED:
			case ClientEvents.WEAPON7_HITSCAN:
			case ClientEvents.WEAPON8_HITSCAN:
				if (!payload || typeof payload !== 'object') {
					return { valid: false, error: `${eventName} must be an object` };
				}
				if (typeof payload.x !== 'number' || typeof payload.y !== 'number') {
					return { valid: false, error: `${eventName} requires numeric x,y` };
				}
				return { valid: true };
			
			case ClientEvents.EXPLOSION_DAMAGE:
			case ClientEvents.DOT_TICK:
				if (!payload || typeof payload !== 'object') {
					return { valid: false, error: `${eventName} must be an object` };
				}
				if (typeof payload.damage !== 'number' || payload.damage < 0 || payload.damage > 10000) {
					return { valid: false, error: `${eventName} damage out of range` };
				}
				return { valid: true };
			
			case ClientEvents.PURCHASE_SHOP_ITEM:
				if (!payload || typeof payload !== 'object') {
					return { valid: false, error: 'purchaseShopItem must be an object' };
				}
				if (typeof payload.itemId !== 'string' && typeof payload.itemId !== 'number') {
					return { valid: false, error: 'purchaseShopItem requires itemId' };
				}
				return { valid: true };
			
			// For events without specific validation, allow through
			// (Server must still validate business logic)
			default:
				return { valid: true };
		}
	}
	
	/**
	 * Validates a server event payload (lightweight checks for development)
	 * In production, we trust the server, but this helps catch bugs during development
	 */
	function validateServerEvent(eventName, payload) {
		// Lightweight validation - mostly for development debugging
		if (eventName === ServerEvents.ENTITIES_STATE && FEATURES.DUAL_EMIT_ENTITIES) {
			if (!payload || !Array.isArray(payload.entities)) {
				return { valid: false, error: 'entitiesState requires entities array' };
			}
		}
		return { valid: true };
	}
	
	// ========== ENTITY TYPE CONSTANTS ==========
	// For the new consolidated entitiesState stream
	const EntityType = {
		ENEMY: 'enemy',
		NPC: 'npc',
		TROOP: 'troop',
		HAZARD: 'hazard'
	};
	
	// ========== EXPORTS ==========
	const Protocol = {
		VERSION: PROTOCOL_VERSION,
		FEATURES: FEATURES,
		ClientEvents: ClientEvents,
		ServerEvents: ServerEvents,
		EntityType: EntityType,
		validateClientEvent: validateClientEvent,
		validateServerEvent: validateServerEvent
	};
	
	// Export for both browser (classic script) and Node.js (CommonJS)
	if (typeof module !== 'undefined' && module.exports) {
		// Node.js
		module.exports = Protocol;
	} else {
		// Browser (classic script)
		global.Protocol = Protocol;
	}
	
})(typeof window !== 'undefined' ? window : global);
