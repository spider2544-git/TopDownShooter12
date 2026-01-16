/**
 * NFCTag.js - NFC Unlock Handler for Weapon Unlocks
 * 
 * Weapon 8 is ALWAYS locked by default. Unlock sources:
 *   1. Direct NFC scan (reader attached to server) → source: 'direct'
 *   2. Double-tap "." keyboard in browser → source: 'keyboard'
 *   3. NFC bridge client (nfc-bridge.js) → source: 'bridge'
 */

class NFCTagManager {
    constructor() {
        this.io = null;
        this.nfc = null;
        this.readers = new Map();
    }
    
    /**
     * Initialize with Socket.IO instance
     * @param {SocketIO.Server} io - Socket.IO server instance
     */
    init(io) {
        this.io = io;
        
        // Try to load nfc-pcsc for direct mode (graceful fail if not installed)
        try {
            const { NFC } = require('nfc-pcsc');
            this.nfc = new NFC();
            this._setupDirectListeners();
            console.log('[NFCTag] NFC Manager initialized - waiting for reader...');
        } catch (err) {
            console.log('[NFCTag] nfc-pcsc not available - keyboard unlock only');
        }
        
        console.log('[NFCTag] Weapon8 locked by default');
        console.log('[NFCTag] Unlock via: NFC tag scan or double-tap "." keyboard');
        return this;
    }
    
    /**
     * Set up direct NFC reader listeners
     */
    _setupDirectListeners() {
        if (!this.nfc) return;
        
        this.nfc.on('reader', reader => {
            const readerName = reader.reader.name;
            this.readers.set(readerName, reader);
            console.log(`[NFCTag] ✓ Reader connected: ${readerName}`);
            
            // Card detected - trigger unlock
            reader.on('card', card => {
                console.log(`[NFCTag] 🏷️  Tag scanned - UID: ${card.uid}`);
                this._broadcastUnlock('direct', null, card.uid);
            });
            
            reader.on('error', err => {
                console.error(`[NFCTag] Reader error (${readerName}):`, err.message);
            });
            
            reader.on('end', () => {
                console.log(`[NFCTag] Reader disconnected: ${readerName}`);
                this.readers.delete(readerName);
            });
        });
        
        this.nfc.on('error', err => {
            if (err.message?.includes('SCARD_E_NO_SERVICE')) {
                console.log('[NFCTag] No PC/SC service - direct NFC disabled');
            } else {
                console.error('[NFCTag] NFC Error:', err.message);
            }
        });
    }
    
    /**
     * Handle unlock request from client (double-tap "." or NFC bridge)
     * @param {Socket} socket - Socket that sent the request
     * @param {Object} data - { source: 'keyboard' | 'bridge', uid?: string }
     */
    handleUnlockRequest(socket, data = {}) {
        const source = data.source || 'keyboard';
        const uid = data.uid || null;
        
        // Log with UID if provided (from bridge NFC scan)
        if (uid) {
            console.log(`[NFCTag] 🔓 Unlock request from ${socket.id} (source: ${source}, uid: ${uid})`);
        } else {
            console.log(`[NFCTag] 🔓 Unlock request from ${socket.id} (source: ${source})`);
        }
        this._broadcastUnlock(source, socket.id, uid);
    }
    
    /**
     * Broadcast unlock to all clients
     */
    _broadcastUnlock(source, triggeredBy, uid) {
        if (!this.io) return;
        
        const payload = {
            weapon: 'weapon8',
            source: source,
            triggeredBy: triggeredBy || 'server',
            timestamp: Date.now()
        };
        
        if (uid) {
            payload.uid = uid;
        }
        
        this.io.emit('nfcUnlock', payload);
        console.log(`[NFCTag] 📡 Broadcast unlock: weapon8 (source: ${source})`);
    }
    
    /**
     * Send initial status to a newly connected client
     * Always tells client weapon8 is locked
     * @param {Socket} socket - Socket.IO socket instance
     */
    sendStatusToSocket(socket) {
        socket.emit('nfcStatus', { locked: true });
    }
}

// Export singleton instance
const nfcTagManager = new NFCTagManager();

module.exports = { NFCTagManager, nfcTagManager };
