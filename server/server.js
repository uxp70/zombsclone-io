// ZombsClone dedicated server — authoritative sim, no player hosts.
// Run:  npm install --prefix server && npm start --prefix server
// Then point clients at ws://HOST:PORT (default 8081, or $PORT).
// The same process also serves the static game client, so one Render URL
// hosts everything: https://<app>.onrender.com plays, wss://… plays online.
//
// Uses the exact same Game simulation as the browser (headless stubs below).
// Humans only, no bots. 2+ humans trigger a 30s countdown, then plane/grace/fight.

const noop = () => {};
function makeCtx() {
  const grad = { addColorStop: noop };
  return new Proxy({}, {
    get(t, p) {
      if (p === 'measureText') return () => ({ width: 10 });
      if (p === 'canvas') return { width: 300, height: 300 };
      if (p === 'createLinearGradient' || p === 'createRadialGradient') return () => grad;
      return noop;
    },
    set() { return true; },
  });
}
function makeCanvas() {
  return { width: 1280, height: 800, getContext: () => makeCtx(), addEventListener: noop, style: {} };
}
const fakeEl = () => ({ classList: { add: noop, remove: noop }, textContent: '', innerHTML: '' });
globalThis.window = { innerWidth: 1280, innerHeight: 800, addEventListener: noop, removeEventListener: noop };
globalThis.document = { getElementById: () => fakeEl(), createElement: () => makeCanvas() };
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = noop;

const { WebSocketServer } = await import('ws');
const { Game } = await import('../src/game.js');

const PORT = +(process.env.PORT || 8081);
const MAX_HUMANS = 6;
const START_WAIT = +(process.env.START_WAIT || 30);
// bump when the protocol/world changes so clients can warn on stale servers
const SERVER_BUILD = 1;
const TICK = 1000 / 60;

const game = new Game(makeCanvas(), makeCanvas());
game.onHud = null; game.onKillfeed = null; game.onChat = null;
game.onDeath = null; game.onWin = null;

let state = 'idle'; // idle | lobby | countdown | playing | ended
let countdown = -1;
let matchTime = 0;
let humanSeq = 0;
const clients = new Map(); // ws -> { name, playerId }

function send(ws, msg) {
  try { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); } catch { }
}
function broadcast(msg, except = null) {
  const json = JSON.stringify(msg);
  for (const [ws] of clients) {
    if (ws === except) continue;
    try { if (ws.readyState === 1) ws.send(json); } catch { }
  }
}
function humans() { return [...clients.values()]; }
function clampNum(v, a, b) { v = +v; if (!isFinite(v)) return a; return v < a ? a : v > b ? b : v; }

function startLobby(respawnAll) {
  const seed = (Math.random() * 1e9) | 0;
  game.start({ name: 'server', mode: 'solo', botCount: 0, dedicated: true, seed });
  game.lobbyT = Infinity; // released when the countdown finishes
  state = 'lobby';
  countdown = -1;
  if (respawnAll) {
    // fresh lobby between matches: re-seat everyone still connected
    for (const c of clients.values()) {
      const p = game.spawnPlayer(c.name, c.team, true);
      c.playerId = p.id;
    }
  }
  console.log(`[lobby] new lobby, seed ${seed}, ${clients.size} waiting`);
}

function beginMatch() {
  state = 'playing';
  matchTime = 0;
  game.lobbyT = 0.01; // updateLobby fires startPlane on next tick
  broadcast({ t: 'start', seed: game.seed });
  console.log(`[match] starting with ${humans().length} humans`);
}

function endMatch() {
  const alive = game.players.filter((p) => !p.dead);
  const winner = alive.length === 1 ? alive[0].name : null;
  state = 'ended';
  broadcast({ t: 'end', winner });
  console.log(`[match] over, winner: ${winner || '(draw)'}`);
  setTimeout(() => {
    if (clients.size === 0) { state = 'idle'; game.stop(); console.log('[lobby] empty, idling'); return; }
    startLobby(true);
  }, 8000);
}

const httpMod = await import('node:http');
const fsMod = await import('node:fs');
const pathMod = await import('node:path');
const { fileURLToPath } = await import('node:url');
const ROOT = pathMod.dirname(pathMod.dirname(fileURLToPath(import.meta.url)));
// strict whitelist: only the public client files, never server/ or dotfiles
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
function serveStatic(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return true; }
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  if (p.includes('..') || p.includes('\0')) { res.writeHead(400); res.end(); return true; }
  const ok = p === '/index.html' || p === '/styles.css' || p.startsWith('/src/');
  if (!ok) return false;
  const ext = pathMod.extname(p);
  if (!MIME[ext]) { res.writeHead(403); res.end(); return true; }
  const full = pathMod.join(ROOT, p);
  fsMod.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': MIME[ext], 'cache-control': 'public, max-age=300' });
    if (req.method === 'GET') res.end(data); else res.end();
  });
  return true;
}
const wss = (() => {
  // plain HTTP handler: health checks + static client; upgrades go to ws
  const httpServer = httpMod.default.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/health/') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('zombsclone ok');
      return;
    }
    if (serveStatic(req, res)) return;
    res.writeHead(404); res.end();
  });
  const server = new WebSocketServer({ server: httpServer });
  httpServer.listen(PORT, () => console.log(`[server] listening on :${PORT}`));
  return server;
})();

wss.on('connection', (ws) => {
  const c = { name: 'Guest', team: 't-h' + (++humanSeq), playerId: null };
  clients.set(ws, c);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.t === 'hello') {
      c.name = String(msg.name || 'Guest').slice(0, 14) || 'Guest';
      console.log(`[hello] ${c.name} (state=${state}, players=${game.players.length})`);
      c.name = String(msg.name || 'Guest').slice(0, 14) || 'Guest';
      if (clients.size > MAX_HUMANS) {
        send(ws, { t: 'denied', reason: 'Server is full (6 players).' });
        ws.close();
        return;
      }
      // one player entity per connection — re-hello just renames
      const existing = game.players.find((x) => x.id === c.playerId);
      if (existing) {
        existing.name = c.name;
        send(ws, { t: 'welcome' });
        if (state === 'playing') send(ws, { t: 'start', seed: game.seed });
        return;
      }
      if (state === 'idle') startLobby(false);
      if (state === 'lobby' || state === 'countdown') {
        const p = game.spawnPlayer(c.name, c.team, true);
        c.playerId = p.id;
        send(ws, { t: 'welcome' });
        send(ws, { t: 'lobby', humans: humans().length, countdown: state === 'countdown' ? Math.max(0, Math.ceil(countdown)) : 0, started: false, build: SERVER_BUILD });
        broadcast({ t: 'chat', name: '', text: `${c.name} joined (${humans().length})` });
      } else if (state === 'playing') {
        // late join straight into the action
        const p = game.spawnPlayer(c.name, c.team, false);
        c.playerId = p.id;
        send(ws, { t: 'welcome' });
        send(ws, { t: 'start', seed: game.seed });
      } else {
        send(ws, { t: 'welcome' }); // match ending; client waits for next lobby
      }
    } else if (msg.t === 'input') {
      const p = game.players.find((x) => x.id === c.playerId);
      if (!p || p.dead) return;
      const input = msg.input || {};
      // client-authoritative position: adopt it (clamped, capped per tick).
      // airborne players stay server-driven (plane/chute).
      if (!p.dropping && typeof input.px === 'number' && typeof input.py === 'number') {
        const nx = clampNum(input.px, 20, 8980), ny = clampNum(input.py, 20, 8980);
        if (Math.abs(nx - p.x) < 60 && Math.abs(ny - p.y) < 60) { p.x = nx; p.y = ny; }
      }
      game.applyRemoteInput(p, input);
    } else if (msg.t === 'chat') {
      const text = String(msg.text || '').slice(0, 60);
      if (text) broadcast({ t: 'chat', name: c.name, text });
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    const i = game.players.findIndex((x) => x.id === c.playerId);
    if (i >= 0) {
      const pname = game.players[i].name;
      game.players.splice(i, 1);
      broadcast({ t: 'chat', name: '', text: `${pname} left` });
    }
    if (state === 'countdown' && humans().length < 2) {
      state = 'lobby'; countdown = -1; game.lobbyT = Infinity;
      console.log('[lobby] countdown cancelled, back to waiting');
    }
  });
});

// main loop
let tick = 0;
setInterval(() => {
  tick++;
  if (state === 'lobby' || state === 'countdown') {
    const n = humans().length;
    if (n >= 2 && state === 'lobby') { state = 'countdown'; countdown = START_WAIT; }
    if (state === 'countdown') {
      countdown -= TICK / 1000;
      game.lobbyT = Math.max(0.01, countdown);
      if (countdown <= 0) beginMatch();
    }
    game.update(TICK / 1000); // lobby wander (no-op without players is fine)
    if (tick % 30 === 0) {
      broadcast({ t: 'lobby', humans: n, countdown: Math.max(0, Math.ceil(countdown)), started: false, build: SERVER_BUILD });
    }
    // stream the plaza so waiters render the 3D lobby instead of a dead menu
    if (tick % 12 === 0 && game.players.length) broadcast({ t: 'snap', snap: game.snapshot() });
  } else if (state === 'playing') {
    matchTime += TICK / 1000;
    game.update(TICK / 1000);
    // tailored snapshot per client (their own full HUD state included)
    if (tick % 4 === 0) {
      for (const [ws, cc] of clients) {
        if (ws.readyState !== 1) continue;
        try { ws.send(JSON.stringify({ t: 'snap', snap: game.snapshot(cc.playerId) })); } catch { }
      }
    }
    if (matchTime > 10) {
      const alive = game.players.filter((p) => !p.dead);
      if (alive.length <= 1) endMatch();
    }
  }
}, TICK);
