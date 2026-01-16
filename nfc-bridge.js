/**
 * NFC Bridge Script
 * 
 * Run this locally on a machine with an NFC reader connected.
 * When an NFC tag is scanned, it sends an unlock request directly to the game server.
 * 
 * This allows NFC unlocks to work even when the game server is hosted
 * remotely (e.g., on Replit).
 * 
 * Usage: node nfc-bridge.js [server-url]
 * Example: node nfc-bridge.js http://localhost:5000
 * Example: node nfc-bridge.js https://your-replit-app.replit.app
 * 
 * Requirements:
 * - nfc-pcsc: npm install nfc-pcsc
 * - socket.io-client: npm install socket.io-client
 */

const { NFC } = require('nfc-pcsc');
const io = require('socket.io-client');

// Parse command line arguments
const serverUrl = process.argv[2] || 'http://localhost:5000';

console.log('========================================');
console.log('  NFC Bridge - Remote Unlock Client');
console.log('========================================');
console.log(`Server: ${serverUrl}`);
console.log('');

// Track state
const readers = new Map();
let socket = null;
let connected = false;

// Connect to game server
function connectToServer() {
    console.log(`[Bridge] Connecting to server...`);
    
    socket = io(serverUrl, {
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionAttempts: Infinity
    });
    
    socket.on('connect', () => {
        connected = true;
        console.log(`[Bridge] ✓ Connected to server (socket: ${socket.id})`);
        
        // Report that we're a bridge with NFC capability
        if (readers.size > 0) {
            console.log(`[Bridge] 📡 Reporting ${readers.size} NFC reader(s) to server`);
        }
    });
    
    socket.on('disconnect', (reason) => {
        connected = false;
        console.log(`[Bridge] Disconnected from server: ${reason}`);
    });
    
    socket.on('connect_error', (err) => {
        console.log(`[Bridge] Connection error: ${err.message}`);
    });
    
    // Listen for unlock confirmations
    socket.on('nfcUnlock', (data) => {
        if (data.source === 'bridge') {
            console.log(`[Bridge] ✓ Unlock confirmed by server`);
        }
    });
}

// Send unlock request to server
function sendUnlockRequest(uid) {
    if (socket && connected) {
        socket.emit('requestNfcUnlock', { 
            source: 'bridge',
            uid: uid
        });
        console.log(`[Bridge] 📡 Sent unlock request to server (uid: ${uid})`);
        return true;
    } else {
        console.log(`[Bridge] ⚠️  Not connected to server - unlock not sent`);
        return false;
    }
}

// Initialize NFC reader
function initNFC() {
    const nfc = new NFC();
    
    nfc.on('reader', reader => {
        const readerName = reader.reader.name;
        readers.set(readerName, reader);
        console.log(`[NFC] ✓ Reader connected: ${readerName}`);
        
        // Handle card scan
        reader.on('card', async (card) => {
            console.log(`[NFC] 🏷️  Tag scanned - UID: ${card.uid}`);
            
            // Send unlock request to server
            const success = sendUnlockRequest(card.uid);
            
            if (success) {
                console.log('[NFC] ✓ Unlock signal sent!');
            } else {
                console.log('[NFC] ✗ Failed to send unlock - not connected');
            }
        });
        
        reader.on('card.off', card => {
            // Card removed - optional logging
        });
        
        reader.on('error', err => {
            console.error(`[NFC] Reader error (${readerName}):`, err.message);
        });
        
        reader.on('end', () => {
            console.log(`[NFC] Reader disconnected: ${readerName}`);
            readers.delete(readerName);
        });
    });
    
    nfc.on('error', err => {
        if (err.message?.includes('SCARD_E_NO_SERVICE')) {
            console.log('[NFC] No PC/SC service running - is an NFC reader connected?');
        } else {
            console.error('[NFC] Error:', err.message);
        }
    });
    
    console.log('[NFC] Waiting for NFC reader...');
}

// Start
console.log('[Bridge] Starting NFC Bridge...');
console.log('');

// Connect to server first
connectToServer();

// Then initialize NFC
initNFC();

console.log('');
console.log('[Bridge] ✓ Ready! Scan an NFC tag to unlock weapon 8.');
console.log('[Bridge] Press Ctrl+C to exit.');
console.log('');
