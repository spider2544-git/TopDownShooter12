// Patch 1: Add logging after _ensnaredBy.set in lickerEnsnared handler (around line 1154)
// After: p._ensnaredBy.set(enemyId, Math.max(duration, p._ensnaredBy.get(enemyId) || 0));
// Add: console.log('🎯 [LickerEvent] Set ensnare - EnemyID:', enemyId, 'Duration:', duration, 'Map size:', p._ensnaredBy.size);

// Patch 2: Add logging in snapshot sync (around line 203)
// Replace the entire if block starting at line 203
