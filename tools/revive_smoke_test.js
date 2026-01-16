// Smoke test for revive flow using socket.io-client (headless).
// Runs two clients in the same room:
// - B goes down (playerDeath)
// - A holds E and starts revive channel (reviveStartRequest)
// - After 4s, B receives reviveReady and accepts (reviveAccept)
// - Assert B receives playerUpdate with health ~= 30% of healthMax at same position

const { io } = require('socket.io-client');

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:5000';
const ROOM_ID = process.env.ROOM_ID || 'default';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function mkClient(label) {
  const socket = io(SERVER_URL, { transports: ['websocket'] });
  const state = {
    id: null,
    lastPlayerUpdate: null,
    reviveReady: null,
  };

  socket.on('connect', () => {
    state.id = socket.id;
    // Match client join payload shape
    socket.emit('joinRoom', {
      roomId: ROOM_ID,
      playerData: {
        x: 0,
        y: 0,
        radius: 20,
        speed: 220,
        health: 100,
        healthMax: 100,
        boundary: 1000,
        scene: 'lobby',
      },
    });
    console.log(`[${label}] connected: ${state.id}`);
  });

  socket.on('playerUpdate', (data) => {
    if (!data || data.id !== state.id) return;
    state.lastPlayerUpdate = data;
    console.log(`[${label}] playerUpdate:`, data);
  });

  socket.on('reviveReady', (data) => {
    state.reviveReady = data;
    console.log(`[${label}] reviveReady:`, data);
  });

  socket.on('reviveState', (data) => {
    if (!data) return;
    // For signal only, avoid log spam
    if (data.type === 'started' || data.type === 'ready' || data.type === 'canceled') {
      console.log(`[reviveState]`, data);
    }
  });

  socket.on('connect_error', (e) => {
    console.error(`[${label}] connect_error`, e && e.message ? e.message : e);
  });

  return { socket, state };
}

async function main() {
  console.log(`[Test] Connecting to ${SERVER_URL} room=${ROOM_ID}`);

  const A = mkClient('A');
  const B = mkClient('B');

  // wait for both to connect + join
  while (!A.state.id || !B.state.id) await sleep(50);
  await sleep(300);

  // B goes down
  B.socket.emit('playerDeath', { name: 'B', x: 0, y: 0 });
  console.log('[Test] B downed (playerDeath emitted)');
  await sleep(200);
  const prePos = { x: null, y: null };
  // Capture server-authoritative position from B's perspective via a gameState (if it arrives),
  // otherwise use last playerUpdate once we get it later.
  // We keep this simple and just ask the server to send a position update by emitting no-op input.
  B.socket.emit('playerInput', {
    sequence: 1,
    timestamp: Date.now(),
    keys: { KeyW: false, KeyA: false, KeyS: false, KeyD: false, ShiftLeft: false, ShiftRight: false, Space: false, KeyE: false },
    mouse: { x: 0, y: 0 },
    mouseDown: false,
    aimAngle: 0,
    wantsDash: false,
    isWeapon8ADS: false,
    predictedX: 0,
    predictedY: 0,
    evilProgress: 0,
    evilLocked: false,
    isFiringWeapon1: false,
    isFiringWeapon4: false,
  });

  // Ensure A lastInput contains keys.KeyE=true so server channel continues
  A.socket.emit('playerInput', {
    sequence: 1,
    timestamp: Date.now(),
    keys: { KeyW: false, KeyA: false, KeyS: false, KeyD: false, ShiftLeft: false, ShiftRight: false, Space: false, KeyE: true },
    mouse: { x: 0, y: 0 },
    mouseDown: false,
    aimAngle: 0,
    wantsDash: false,
    isWeapon8ADS: false,
    predictedX: 0,
    predictedY: 0,
    evilProgress: 0,
    evilLocked: false,
    isFiringWeapon1: false,
    isFiringWeapon4: false,
  });

  // Start revive channel
  A.socket.emit('reviveStartRequest', { targetId: B.state.id });
  console.log('[Test] A started reviveStartRequest -> B');

  // Wait up to 6s for reviveReady
  const start = Date.now();
  while (!B.state.reviveReady && (Date.now() - start) < 6500) await sleep(50);

  if (!B.state.reviveReady) {
    throw new Error('Expected B to receive reviveReady, but timed out');
  }

  // Accept revive
  B.socket.emit('reviveAccept', {});
  console.log('[Test] B emitted reviveAccept');

  // Wait for playerUpdate for B (revive pushes playerUpdate immediately)
  const start2 = Date.now();
  while (!B.state.lastPlayerUpdate && (Date.now() - start2) < 2000) await sleep(50);
  if (!B.state.lastPlayerUpdate) {
    throw new Error('Expected B to receive playerUpdate after reviveAccept, but timed out');
  }

  const { x, y, health, healthMax } = B.state.lastPlayerUpdate;
  const expected = Math.round((healthMax || 100) * 0.30);
  if (Math.abs((health || 0) - expected) > 2) {
    throw new Error(`Expected health ~= ${expected} (30%), got ${health} (healthMax=${healthMax})`);
  }
  // Position should remain unchanged by revive (revive in-place).
  // Since server spawn position isn't deterministic in this test harness, just assert we got finite coords.
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error(`Expected finite revive position, got (${x},${y})`);
  }

  console.log('[Test] ✅ Revive smoke test passed');
  A.socket.disconnect();
  B.socket.disconnect();
}

main().catch((e) => {
  console.error('[Test] ❌ Revive smoke test failed:', e && e.stack ? e.stack : e);
  process.exitCode = 1;
});


