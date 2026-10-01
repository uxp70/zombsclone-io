import { WORLD_SIZE, WEAPONS, RARITIES, GAS_PHASES, BOT_NAMES, LOBBY_TIME, GRACE_TIME, CHUTE_TIME, CHEST_POOL_BASIC, CHEST_POOL_GOLDEN, rand, randi, pick, clamp, dist2, angleLerp } from './config.js?v=124';
import { generateWorld } from './world.js?v=124';
import { makeBotController } from './bots.js?v=124';
import { sfx } from './audio.js?v=124';

let PID = 1;

export class Game {
  constructor(canvas, minimap) {
    this.cv = canvas; this.ctx = canvas.getContext('2d');
    this.mm = minimap; this.mctx = minimap ? minimap.getContext('2d') : null;
    this.players = []; this.bullets = []; this.particles = [];
    this.loot = []; this.obstacles = [];
    this.floatChats = []; // {pid,text,t}
    this.killfeed = [];
    this.running = false; this.last = 0;
    this.cam = { x: 0, y: 0, zoom: 1 };
    this.keys = {};
    this.mouse = { x: 0, y: 0, down: false };
    this.local = null;
    this.mode = 'solo';
    this.net = null; this.isRemote = false; this.remoteSnap = null; this.snapT = 0;
    this.onKillfeed = null; this.onChat = null; this.onHud = null; this.onDeath = null; this.onWin = null;
    this.gas = null; this.plane = null; this.time = 0;
    this.botControllers = new Map();
    this.takenIds = new Set();
    this.bigMap = false;
    this._bindInput();
    this._resize();
    window.addEventListener('resize', () => this._resize());
  }

  _resize() {
    this.cv.width = window.innerWidth; this.cv.height = window.innerHeight;
    const base = Math.min(window.innerWidth, window.innerHeight);
    this.baseZoom = clamp(base / 1100, 0.7, 1.35);
  }

  _bindInput() {
    window.addEventListener('keydown', (e) => {
      // don't steal keystrokes while typing (chat box, menu inputs)
      const ae = document.activeElement;
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return;
      this.keys[e.key.toLowerCase()] = true;
      if ([' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(e.key.toLowerCase())) e.preventDefault();
      if (!this.local || this.local.dead) return;
      const k = e.key.toLowerCase();
      if (k === 'e') this.tryInteract(this.local);
      if (k === 'r') this.startReload(this.local);
      if (k === 'q') this.startHeal(this.local, 'bandage');
      if (k === 'x') this.startHeal(this.local, this.local.shield < 100 && this.local.heals.shield > 0 ? 'shield' : 'medkit');
      if (k === 'f' || k === ' ') this.tryDrop(this.local);
      if (k === 'm') this.bigMap = !this.bigMap;
      if (k >= '1' && k <= '4') this.switchSlot(this.local, +k - 1);
    });
    window.addEventListener('keyup', (e) => { this.keys[e.key.toLowerCase()] = false; });
    this.cv.addEventListener('mousemove', (e) => { this.mouse.x = e.clientX; this.mouse.y = e.clientY; });
    this.cv.addEventListener('mousedown', (e) => { if (e.button === 0) this.mouse.down = true; sfx.ensure(); });
    window.addEventListener('mouseup', () => { this.mouse.down = false; });
    this.cv.addEventListener('contextmenu', (e) => e.preventDefault());
    // touch: left half move, right half aim+shoot
    const sticks = { move: null, aim: null };
    this.cv.addEventListener('touchstart', (e) => {
      sfx.ensure();
      for (const t of e.changedTouches) {
        if (t.clientX < window.innerWidth / 2 && !sticks.move) sticks.move = { id: t.identifier, sx: t.clientX, sy: t.clientY, dx: 0, dy: 0 };
        else if (!sticks.aim) sticks.aim = { id: t.identifier, sx: t.clientX, sy: t.clientY };
      }
      this._sticks = sticks;
      e.preventDefault();
    }, { passive: false });
    this.cv.addEventListener('touchmove', (e) => {
      const s = this._sticks; if (!s) return;
      for (const t of e.changedTouches) {
        if (s.move && t.identifier === s.move.id) { s.move.dx = t.clientX - s.move.sx; s.move.dy = t.clientY - s.move.sy; }
        if (s.aim && t.identifier === s.aim.id) { this.mouse.x = t.clientX; this.mouse.y = t.clientY; this.mouse.down = true; }
      }
      e.preventDefault();
    }, { passive: false });
    this.cv.addEventListener('touchend', (e) => {
      const s = this._sticks; if (!s) return;
      for (const t of e.changedTouches) {
        if (s.move && t.identifier === s.move.id) s.move = null;
        if (s.aim && t.identifier === s.aim.id) { s.aim = null; this.mouse.down = false; }
      }
    });
  }

  // ---------- setup ----------
  start({ name = 'Prodigy', mode = 'solo', botCount = 70, seed = (Math.random() * 1e9) | 0, net = null, isRemote = false, teamId = null, dedicated = false } = {}) {
    this.stop();
    this.mode = mode; this.net = net; this.isRemote = isRemote; this.dedicated = dedicated;
    const w = generateWorld(seed);
    this.seed = seed;
    this.obstacles = w.obstacles; this.loot = w.loot; this.ponds = w.ponds; this.roads = w.roads;
    this.houses = w.houses;
    // chests are the ONLY gun source: basic (1x1) + golden (1x2)
    this.chests = this.wrapChests(w.chests);
    this.openedIds = new Set();
    // (pen clearing happens below once the lobby rect is defined)
    this.players = []; this.bullets = []; this.particles = []; this.floatChats = [];
    this.time = 0; this.takenIds.clear();
    this._won = false; this.killfeed = [];
    this.pidMap = new Map();
    this.botControllers.clear();
    this.pendingBots = [];
    this.joinAcc = 0;

    // gas init: full map → first target (small lobbies get a tighter zone
    // so few humans actually meet on a 9000px map)
    const zoneScale = botCount === 0 ? 0.38 : 0.72;
    this.gas = {
      x: WORLD_SIZE / 2, y: WORLD_SIZE / 2, r: WORLD_SIZE * zoneScale,
      tx: WORLD_SIZE / 2, ty: WORLD_SIZE / 2, tr: WORLD_SIZE * zoneScale * 0.62,
      fx: WORLD_SIZE / 2, fy: WORLD_SIZE / 2, fr: WORLD_SIZE * 0.72,
      phase: 0, state: 'waiting', t: GAS_PHASES[0].wait, dps: 0,
    };
    this._nextGasTarget();

    // lobby plaza at map center — cleared of obstacles/loot below
    const pw = 820, ph = 620;
    this.lobby = { x: WORLD_SIZE / 2 - pw / 2, y: WORLD_SIZE / 2 - ph / 2, w: pw, h: ph };
    const inPen = (x, y) => x > this.lobby.x - 40 && x < this.lobby.x + this.lobby.w + 40 && y > this.lobby.y - 40 && y < this.lobby.y + this.lobby.h + 40;
    this.clearPen(inPen);
    this.compounds = w.compounds;
    this.buildGrid();

    this.phase = 'lobby';
    this.lobbyT = LOBBY_TIME;
    this.peaceT = 0;
    this.plane = { x: 0, y: 0, dx: 1, dy: 0, speed: 460, active: false, t: 0, ex: 0, ey: 0 };

    // teams
    const names = shuffle([...BOT_NAMES]).slice(0, botCount + 8);
    let ni = 0;
    const mkName = (preferred) => preferred && preferred.trim() ? preferred.trim().slice(0, 14) : (names[ni++] || 'bot' + ni);
    const penSpawn = () => ({
      x: this.lobby.x + rand(60, this.lobby.w - 60),
      y: this.lobby.y + rand(60, this.lobby.h - 60),
    });

    if (!isRemote && !dedicated) {
      this.local = this._mkPlayer(mkName(name), false, teamId || 't-local');
      Object.assign(this.local, penSpawn());
      this.local.faceAngle = rand(0, 6.28);
      this.players.push(this.local);
      // offline teammates for duo/squad join instantly
      const mateCount = mode === 'duo' ? 1 : mode === 'squad' ? 3 : 0;
      for (let i = 0; i < mateCount; i++) {
        const m = this._mkPlayer(names[ni++] || ('mate' + i), true, 't-local');
        Object.assign(m, penSpawn());
        m.skill = rand(0.55, 0.85);
        this.players.push(m);
        this.botControllers.set(m.id, makeBotController(m, this));
      }
      // bots trickle into the lobby gradually (see updateLobby) —
      // first batch joins instantly so the lobby never looks empty
      this.pendingBots = [];
      for (let i = 0; i < botCount; i++) {
        this.pendingBots.push({ name: names[ni++] || ('bot' + i), skill: rand(0.25, 0.9), team: 't-' + i });
      }
      this.joinAcc = 0;
      for (let i = 0; i < 8 && this.pendingBots.length; i++) this.spawnBot(this.pendingBots.shift());
      this.centerMsg('Match starting soon — run around!', 3);
    }

    this.running = true; this.last = performance.now();
    cancelAnimationFrame(this._raf);
    const loop = (t) => {
      if (!this.running) return;
      const dt = Math.min(0.05, (t - this.last) / 1000 || 0.016);
      this.last = t;
      try {
        if (!this.isRemote) this.update(dt); else this.updateRemote(dt);
        this.render();
      } catch (err) { console.error('[game] frame error:', err); }
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
  }

  _mkPlayer(name, isBot, team) {
    const p = {
      id: PID++, name, isBot, team,
      x: 0, y: 0, vx: 0, vy: 0, r: 20,
      hp: 100, maxHp: 100, shield: 0, dead: false,
      faceAngle: Math.random() * 6.28, aimX: 0, aimY: 0,
      speed: 265, gun: 'fists', slots: [{ gun: 'fists', rarity: 0, magAmmo: Infinity }], slotI: 0,
      ammo: { light: 60, medium: 30, shell: 8, heavy: 5 },
      heals: { bandage: 1, medkit: 0, shield: 0 },
      kills: 0, dropping: false, chute: 0, reloadT: 0, shootCd: 0, healing: null, useCd: 0,
      input: { mx: 0, my: 0, shoot: false },
      skill: rand(0.3, 0.8), armor: 0,
      color: `hsl(${(Math.random() * 360) | 0} 65% 55%)`,
      lastDmgFrom: null,
    };
    p.aimX = p.x + 100; p.aimY = p.y;
    return p;
  }

  stop() { this.running = false; cancelAnimationFrame(this._raf); }

  // ---------- gas ----------
  _nextGasTarget() {
    const g = this.gas;
    const shrink = 0.62 + Math.random() * 0.12;
    const nr = Math.max(120, g.tr * shrink);
    const maxOff = Math.max(0, (g.tr - nr) * 0.7);
    const a = Math.random() * Math.PI * 2, d = Math.random() * maxOff;
    g.tx = clamp(g.tx + Math.cos(a) * d, nr, WORLD_SIZE - nr);
    g.ty = clamp(g.ty + Math.sin(a) * d, nr, WORLD_SIZE - nr);
    g.tr = nr;
  }

  isOutsideGas(x, y) {
    const g = this.gas;
    return Math.hypot(x - g.x, y - g.y) > g.r;
  }

  // ---------- combat / loot ----------
  startReload(p) {
    if (p.dead || p.dropping || p.reloadT > 0 || p.healing) return;
    const s = p.slots[p.slotI]; if (!s) return;
    const w = WEAPONS[s.gun];
    if (w.mag === Infinity || s.magAmmo === w.mag) return;
    if ((p.ammo[w.ammo] || 0) <= 0) return;
    p.reloadT = w.reload / 1000;
    sfx.reload();
  }
  switchSlot(p, i) {
    if (!p.slots[i]) return;
    const cur = p.slots[p.slotI];
    if (cur) cur._reloading = false;
    p.slotI = i; p.gun = p.slots[i].gun; p.reloadT = 0; p.healing = null;
    sfx.ui();
  }
  startHeal(p, type) {
    if (p.dead || p.dropping || p.healing || p.reloadT > 0) return;
    if (type === 'bandage' && p.heals.bandage > 0 && p.hp < p.maxHp) p.healing = { type, t: 2.0 };
    else if (type === 'medkit' && p.heals.medkit > 0 && p.hp < p.maxHp) p.healing = { type, t: 3.0 };
    else if (type === 'shield' && p.heals.shield > 0 && p.shield < 100) p.healing = { type, t: 2.4 };
  }
  tryDrop(p) {
    if (this.phase !== 'plane' || !p.dropping || p.dead) return;
    p.dropping = false;
    p.chute = CHUTE_TIME;
    // steerable descent — scatter the landing
    p.x = clamp(p.x + rand(-380, 380), 60, WORLD_SIZE - 60);
    p.y = clamp(p.y + rand(-380, 380), 60, WORLD_SIZE - 60);
    if (p === this.local) this.centerMsg('Steer with WASD — landing…', 2);
  }
  nearestLoot(p, maxD = 70) {
    let best = null, bd = maxD * maxD;
    for (const l of this.loot) {
      if (l.taken) continue;
      const d2 = dist2(p.x, p.y, l.x, l.y);
      if (d2 < bd) { bd = d2; best = l; }
    }
    return best;
  }
  tryPickupNearest(p) {
    const l = this.nearestLoot(p, 80);
    if (l) this.tryPickup(p, l);
  }
  tryPickup(p, l) {
    if (!l || l.taken || p.dead || p.dropping || p.chute > 0) return false;
    if (dist2(p.x, p.y, l.x, l.y) > 85 * 85) return false;
    if (l.kind === 'weapon') {
      const existing = p.slots.findIndex((s) => s && s.gun === l.weapon);
      if (existing >= 0) {
        if (l.rarity > p.slots[existing].rarity) p.slots[existing].rarity = l.rarity;
        const w = WEAPONS[l.weapon];
        p.ammo[w.ammo] = (p.ammo[w.ammo] || 0) + w.mag;
      } else {
        const idx = p.slots.findIndex((s) => !s) >= 0 ? p.slots.findIndex((s) => !s)
          : (p.slots.length < 4 ? p.slots.length : 1 + ((Math.random() * 3) | 0));
        const w = WEAPONS[l.weapon];
        p.slots[idx] = { gun: l.weapon, rarity: l.rarity, magAmmo: w.mag };
        p.ammo[w.ammo] = (p.ammo[w.ammo] || 0) + Math.ceil(w.mag * 0.7);
        if (p.isBot || p.gun === 'fists' || Math.random() < 0.6) { p.slotI = idx; p.gun = l.weapon; }
      }
      l.taken = true; this.takenIds.add(l.id);
      if (p === this.local) sfx.pickup();
      return true;
    } else if (l.kind === 'heal') {
      if (l.heal === 'bandage' && p.heals.bandage >= 8) return false;
      if (l.heal === 'medkit' && p.heals.medkit >= 3) return false;
      if (l.heal === 'shield' && p.heals.shield >= 3) return false;
      p.heals[l.heal]++; l.taken = true; this.takenIds.add(l.id);
      if (p === this.local) sfx.pickup();
      return true;
    } else if (l.kind === 'ammo') {
      p.ammo[l.ammo] = (p.ammo[l.ammo] || 0) + l.amount;
      l.taken = true; this.takenIds.add(l.id);
      if (p === this.local) sfx.pickup();
      return true;
    }
    return false;
  }

  fire(p) {
    // no shooting in the lobby, on the plane, or while parachuting — land first
    if (this.phase === 'lobby' || p.dropping || p.chute > 0) return;
    const s = p.slots[p.slotI]; if (!s) return;
    const w = WEAPONS[s.gun];
    if (p.reloadT > 0 || p.shootCd > 0 || p.healing) return;
    if (s.gun !== 'fists') {
      if (s.magAmmo <= 0) { this.startReload(p); return; }
      s.magAmmo--;
      if (s.magAmmo === 0) setTimeout(() => { if (!p.dead) this.startReload(p); }, 180);
    }
    p.shootCd = w.rof / 1000;
    const baseA = Math.atan2(p.aimY - p.y, p.aimX - p.x);
    const rar = RARITIES[s.rarity || 0];
    if (p === this.local || dist2(p.x, p.y, this.local?.x || 0, this.local?.y || 0) < 1400 * 1400) {
      if (p === this.local) sfx.shoot(s.gun);
      else sfx.shoot(s.gun); // audible nearby (same synth, could add distance vol later)
    }
    // muzzle particles
    this.particles.push({ x: p.x + Math.cos(baseA) * 30, y: p.y + Math.sin(baseA) * 30, vx: 0, vy: 0, t: 0.08, max: 0.08, c: '#ffdd55', r: 5 });
    for (let i = 0; i < w.pellets; i++) {
      const a = baseA + (Math.random() - 0.5) * 2 * w.spread;
      const dmg = w.dmg * rar.mult * rand(0.92, 1.08);
      if (s.gun === 'fists') {
        // melee arc
        this._meleeHit(p, baseA, dmg);
      } else {
        this.bullets.push({
          x: p.x + Math.cos(a) * 26, y: p.y + Math.sin(a) * 26,
          vx: Math.cos(a) * w.speed, vy: Math.sin(a) * w.speed,
          dmg, range: w.range * rand(0.9, 1.1), traveled: 0, from: p.id, team: p.team, gun: s.gun,
          splash: w.splash || 0,
        });
      }
    }
    // recoil nudge
    p.vx -= Math.cos(baseA) * (s.gun === 'shotgun' ? 60 : 12);
    p.vy -= Math.sin(baseA) * (s.gun === 'shotgun' ? 60 : 12);
  }

  _meleeHit(p, a, dmg) {
    for (const q of this.players) {
      if (q === p || q.dead || q.dropping) continue;
      if (q.team && p.team && q.team === p.team) continue;
      if (dist2(p.x, p.y, q.x, q.y) < 70 * 70 && Math.abs(angDiff(a, Math.atan2(q.y - p.y, q.x - p.x))) < 1.0) {
        this.damage(q, dmg, p);
      }
    }
    // hit crates
    for (const o of this.obstacles) {
      if (o.destroyed) continue;
      const d = o.type === 'wall' ? distRect(p.x, p.y, o) : Math.hypot(o.x - p.x, o.y - p.y) - (o.r || 0);
      if (d < 60 && Math.abs(angDiff(a, Math.atan2((o.y + (o.h || 0) / 2) - p.y, (o.x + (o.w || 0) / 2) - p.x))) < 1.1) this.damageObstacle(o, dmg, p);
    }
  }

  explode(x, y, radius, dmg, fromId) {
    const shooter = this.players.find((s) => s.id === fromId);
    for (const p of this.players) {
      if (p.dead || p.dropping) continue;
      if (shooter && shooter.team && p.team && shooter.team === p.team && p !== shooter) continue;
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < radius + p.r) {
        const fall = 1 - 0.6 * (d / (radius + p.r));
        this.damage(p, dmg * fall * (p === shooter ? 0.5 : 1), shooter);
      }
    }
    const near = this.grid ? this.gridQuery(x - radius, y - radius, x + radius, y + radius) : this.obstacles;
    for (const o of near) {
      if (o.destroyed || o.type === 'chest' || o.type === 'chest_gold') continue;
      const ox = o.type === 'wall' ? o.x + o.w / 2 : o.x;
      const oy = o.type === 'wall' ? o.y + o.h / 2 : o.y;
      if (Math.hypot(ox - x, oy - y) < radius + 20) this.damageObstacle(o, dmg, shooter);
    }
    for (let i = 0; i < 26; i++) {
      const a = Math.random() * Math.PI * 2, sp = rand(40, 320);
      this.particles.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, t: rand(0.3, 0.7), max: 0.7, c: pick(['#ffdd44', '#ff8830', '#ff4422', '#555555']), r: rand(3, 8) });
    }
    this.particles.push({ x, y, vx: 0, vy: 0, t: 0.25, max: 0.25, c: '#fff2c0', r: radius * 0.7 });
    sfx.boom();
    this._shake = 10;
  }

  damage(target, dmg, attacker) {
    if (target.dead || this.phase === 'lobby') return;
    target.lastDmgFrom = attacker;
    target.lastDmgT = this.time;
    let rem = dmg;
    if (target.shield > 0) {
      const absorbed = Math.min(target.shield, rem * 0.6);
      target.shield -= absorbed; rem -= absorbed;
    }
    target.hp -= rem;
    if (target === this.local) { sfx.hurt(); this._shake = 6; }
    else if (attacker === this.local) sfx.hit();
    this.particles.push({ x: target.x, y: target.y, vx: rand(-60, 60), vy: rand(-60, 60), t: 0.3, max: 0.3, c: '#ff4444', r: 4 });
    if (target.hp <= 0) this.kill(target, attacker);
  }

  damageObstacle(o, dmg, attacker) {
    o.hp -= dmg;
    if (o.hp <= 0 && !o.destroyed) {
      o.destroyed = true;
      this.particles.push({ x: o.x + (o.w || 0) / 2, y: o.y + (o.h || 0) / 2, vx: 0, vy: 0, t: 0.3, max: 0.3, c: '#8a5a2b', r: 16 });
      if (attacker === this.local) sfx.chest();
      // crates drop ammo/heals only — guns come exclusively from chests
      if (o.type === 'crate' || o.type === 'barrel') {
        const cx = o.x, cy = o.y;
        const roll = Math.random();
        if (roll < 0.5) this.dropLoot({ kind: 'heal', heal: pick(['bandage', 'bandage', 'medkit', 'shield']), x: cx, y: cy });
        else this.dropLoot({ kind: 'ammo', ammo: pick(['light', 'medium', 'shell', 'heavy']), amount: 20, x: cx, y: cy });
      }
    }
  }

  kill(victim, killer) {
    if (victim.dead) return;
    victim.dead = true; victim.hp = 0;
    // drop loot
    for (const s of victim.slots) {
      if (s && s.gun !== 'fists') this.dropLoot({ kind: 'weapon', weapon: s.gun, rarity: s.rarity || 0, x: victim.x + rand(-30, 30), y: victim.y + rand(-30, 30) });
    }
    if (victim.heals.bandage > 0) this.dropLoot({ kind: 'heal', heal: 'bandage', x: victim.x + 20, y: victim.y });
    for (let i = 0; i < 10; i++) this.particles.push({ x: victim.x, y: victim.y, vx: rand(-160, 160), vy: rand(-160, 160), t: 0.5, max: 0.5, c: victim.color, r: 5 });
    if (killer && killer !== victim && !killer.dead) {
      killer.kills++;
      this.feed(`<b>${esc(killer.name)}</b> killed <b>${esc(victim.name)}</b> ${killer === this.local ? '☠️' : ''}`);
    } else {
      this.feed(`<b>${esc(victim.name)}</b> died to gas`);
    }
    if (victim === this.local) {
      sfx.death();
      const alive = this.players.filter((p) => !p.dead).length;
      const rank = alive + 1;
      this.onDeath && this.onDeath({ rank, total: this.players.length, by: victim.lastDmgFrom?.name || 'the gas', kills: victim.kills });
    }
    this.checkWin();
  }

  feed(html) {
    this.killfeed.unshift(html);
    this.killfeed = this.killfeed.slice(0, 6);
    this.onKillfeed && this.onKillfeed(this.killfeed);
  }

  chat(p, text) {
    this.floatChats.push({ pid: p.id, text: String(text).slice(0, 60), t: 3.2 });
    this.onChat && this.onChat(p, text);
  }

  centerMsg(text, dur = 2) {
    this._center = { text, t: dur };
    const el = document.getElementById('centerMsg');
    if (el) { el.textContent = text; el.classList.remove('hidden'); clearTimeout(this._centerTo); this._centerTo = setTimeout(() => el.classList.add('hidden'), dur * 1000); }
  }

  checkWin() {
    const alive = this.players.filter((p) => !p.dead);
    if (alive.length === 0) return;
    // team win: all alive share team
    const teams = new Set(alive.map((p) => p.team));
    if (alive.length === 1 || teams.size === 1) {
      const winners = alive;
      if (!this._won) {
        this._won = true;
        if (winners.includes(this.local) && !this.local.dead) {
          sfx.win();
          this.onWin && this.onWin({ kills: this.local.kills });
        }
      }
    }
  }

  spawnBot(spec) {
    const b = this._mkPlayer(spec.name, true, spec.team);
    const lb = this.lobby;
    b.x = lb.x + rand(60, lb.w - 60);
    b.y = lb.y + rand(60, lb.h - 60);
    b.skill = spec.skill;
    b.faceAngle = rand(0, 6.28);
    this.players.push(b);
    this.botControllers.set(b.id, makeBotController(b, this));
    for (let i = 0; i < 6; i++) this.particles.push({ x: b.x + rand(-12, 12), y: b.y + rand(-12, 12), vx: rand(-50, 50), vy: rand(-50, 50), t: 0.35, max: 0.35, c: '#ffffff', r: 4 });
    return b;
  }

  wrapChests(list) {
    return (list || []).map((c, i) => ({
      id: 500000 + i, x: c.x, y: c.y, tier: c.tier, opened: !!c.opened,
      type: c.tier === 'golden' ? 'chest_gold' : 'chest',
      w: c.tier === 'golden' ? 58 : 32, h: c.tier === 'golden' ? 38 : 32,
      r: c.tier === 'golden' ? 30 : 22, solid: true, hp: Infinity,
    }));
  }

  // dynamic loot (chest fountains, crate/kill drops) — synced to P2P guests
  dropLoot(item) {
    if (item.id === undefined) item.id = 700000 + ((Math.random() * 1e6) | 0);
    this.loot.push(item);
    return item;
  }

  clearPen(inPen) {
    this.obstacles = this.obstacles.filter((o) => !inPen(o.x + (o.w || 0) / 2, o.y + (o.h || 0) / 2));
    this.loot = this.loot.filter((l) => !inPen(l.x, l.y));
    this.chests = this.chests.filter((c) => !inPen(c.x, c.y));
    this.houses = (this.houses || []).filter((h) => !inPen(h.x, h.y));
  }

  // dedicated-server helper: add a human player (lobby spawn or mid-match drop-in)
  spawnPlayer(name, team, inLobby = true) {
    const p = this._mkPlayer(name, false, team);
    p.remote = true;
    if (inLobby && this.lobby) {
      p.x = this.lobby.x + rand(60, this.lobby.w - 60);
      p.y = this.lobby.y + rand(60, this.lobby.h - 60);
      p.dropping = false; p.chute = 0;
      this.lobbyPos(p);
    } else {
      p.dropping = false; p.chute = 0;
      p.x = rand(600, WORLD_SIZE - 600);
      p.y = rand(600, WORLD_SIZE - 600);
    }
    this.players.push(p);
    return p;
  }

  startPlane() {
    const a = Math.random() * Math.PI * 2;
    const cx = WORLD_SIZE / 2, cy = WORLD_SIZE / 2, Lg = WORLD_SIZE * 0.62;
    const pl = this.plane;
    pl.x = cx - Math.cos(a) * Lg; pl.y = cy - Math.sin(a) * Lg;
    pl.dx = Math.cos(a); pl.dy = Math.sin(a);
    pl.ex = cx + Math.cos(a) * Lg; pl.ey = cy + Math.sin(a) * Lg;
    pl.speed = 560; pl.t = 0; pl.active = true;
    while (this.pendingBots && this.pendingBots.length) this.spawnBot(this.pendingBots.shift());
    for (const p of this.players) {
      if (p.dead) continue;
      p.dropping = true; p.chute = 0; p.healing = null; p.reloadT = 0;
      p.x = pl.x; p.y = pl.y;
      if (p.isBot) p.dropAt = rand(0.5, 12.5); // scatter bots across the whole map
    }
    this.bullets.length = 0;
    this.phase = 'plane';
    this.peaceT = GRACE_TIME; // grace runs from first jump, not plane end
    const humans = this.players.filter((p) => !p.isBot && !p.dead).length;
    const bots = this.players.length - humans;
    this.feed(bots > 0
      ? `<b>${bots} bots</b> + <b>${humans} human${humans === 1 ? '' : 's'}</b> — good luck!`
      : `<b>${humans} humans — last one standing wins!</b>`);
    this.centerMsg('Jump with SPACE / F!', 3);
  }

  lobbyPos(p) {
    const lb = this.lobby;
    p.x = clamp(p.x, lb.x + 24, lb.x + lb.w - 24);
    p.y = clamp(p.y, lb.y + 24, lb.y + lb.h - 24);
  }

  followCam(L, dt, zoomMul = 1) {
    const zoom = this.baseZoom * zoomMul;
    this.cam.zoom = lerp(this.cam.zoom || zoom, zoom, Math.min(1, dt * 4));
    const tx = L.x - this.cv.width / this.cam.zoom / 2;
    const ty = L.y - this.cv.height / this.cam.zoom / 2;
    if (Math.hypot(this.cam.x - tx, this.cam.y - ty) > 2500) { this.cam.x = tx; this.cam.y = ty; }
    else {
      this.cam.x = lerp(this.cam.x, tx, Math.min(1, dt * 8));
      this.cam.y = lerp(this.cam.y, ty, Math.min(1, dt * 8));
    }
  }

  updateLobby(dt) {
    this.lobbyT -= dt;
    // bots trickle in over the countdown — flush faster near the end
    if (this.pendingBots && this.pendingBots.length) {
      this.joinAcc = (this.joinAcc || 0) + dt * Math.max(1.5, this.pendingBots.length / Math.max(0.5, this.lobbyT));
      let guard = 12;
      while (this.pendingBots.length && this.joinAcc >= 1 && guard-- > 0) {
        this.joinAcc -= 1;
        this.spawnBot(this.pendingBots.shift());
      }
    }
    const L = this.local;
    if (L && !L.dead) {
      let mx = 0, my = 0;
      if (this.keys['w'] || this.keys['arrowup']) my -= 1;
      if (this.keys['s'] || this.keys['arrowdown']) my += 1;
      if (this.keys['a'] || this.keys['arrowleft']) mx -= 1;
      if (this.keys['d'] || this.keys['arrowright']) mx += 1;
      L.input.mx = mx; L.input.my = my; L.input.shoot = false;
      const wx = this.cam.x + this.mouse.x / this.cam.zoom;
      const wy = this.cam.y + this.mouse.y / this.cam.zoom;
      L.faceAngle = Math.atan2(wy - L.y, wx - L.x);
    }
    for (const [id, ctl] of this.botControllers) {
      const p = this.players.find((x) => x.id === id);
      if (!p || p.dead || p.remote) continue;
      ctl.update(dt);
    }
    for (const p of this.players) {
      if (p.dead) continue;
      const n = Math.hypot(p.input.mx, p.input.my);
      if (n > 0.01) {
        p.vx = lerp(p.vx, (p.input.mx / Math.max(1, n)) * p.speed, Math.min(1, dt * 10));
        p.vy = lerp(p.vy, (p.input.my / Math.max(1, n)) * p.speed, Math.min(1, dt * 10));
      } else { p.vx = lerp(p.vx, 0, Math.min(1, dt * 10)); p.vy = lerp(p.vy, 0, Math.min(1, dt * 10)); }
      p.x += p.vx * dt; p.y += p.vy * dt;
      this.lobbyPos(p);
    }
    for (let i = this.floatChats.length - 1; i >= 0; i--) {
      this.floatChats[i].t -= dt;
      if (this.floatChats[i].t <= 0) this.floatChats.splice(i, 1);
    }
    if (L) this.followCam(L, dt);
    if (this.onHud && L) {
      this.onHud({
        hp: L.hp, shield: L.shield, ammo: L.slots[L.slotI], reserve: L.ammo,
        heals: L.heals, slots: L.slots, slotI: L.slotI,
        alive: this.players.filter((p) => !p.dead).length, kills: L.kills,
        zone: `Starting in ${Math.max(0, Math.ceil(this.lobbyT))}`,
        dropping: false, reloading: false, healing: null, interact: null, lobby: true,
      });
    }
    if (this.lobbyT <= 0) this.startPlane();
  }

  // ---------- per-frame ----------
  update(dt) {
    this.time += dt;
    if (this.phase === 'lobby') { this.updateLobby(dt); return; }
    this.peaceT = Math.max(0, this.peaceT - dt);
    // plane
    const pl = this.plane;
    if (pl.active) {
      pl.t += dt;
      pl.x += pl.dx * pl.speed * dt; pl.y += pl.dy * pl.speed * dt;
      for (const p of this.players) if (p.dropping) { p.x = clamp(pl.x, 40, WORLD_SIZE - 40); p.y = clamp(pl.y, 40, WORLD_SIZE - 40); }
      // auto-drop bots over time — scattered across the map
      for (const p of this.players) {
        if (!p.dropping || p === this.local) continue;
        if ((p.dropAt !== undefined && pl.t > p.dropAt) || pl.t > 12.5) {
          p.dropping = false; p.chute = CHUTE_TIME;
          p.x = clamp(p.x + rand(-380, 380), 60, WORLD_SIZE - 60);
          p.y = clamp(p.y + rand(-380, 380), 60, WORLD_SIZE - 60);
        }
      }
      if (pl.t > 14 || Math.hypot(pl.x - pl.ex, pl.y - pl.ey) < 60) {
        pl.active = false;
        for (const p of this.players) {
          if (!p.dropping) continue;
          p.dropping = false; p.chute = CHUTE_TIME;
          p.x = clamp(p.x + rand(-200, 200), 60, WORLD_SIZE - 60);
          p.y = clamp(p.y + rand(-200, 200), 60, WORLD_SIZE - 60);
        }
        this.phase = 'play';
        if (this.peaceT > 0) this.centerMsg('Grace period — bots hold fire!', 2.5);
        else this.centerMsg('Fight!', 2);
      }
    } else if (this.phase === 'plane') {
      this.phase = 'play';
    }

    // gas (only once everyone is on the ground)
    if (this.phase === 'play') {
      const g = this.gas, ph = GAS_PHASES[Math.min(g.phase, GAS_PHASES.length - 1)];
      g.t -= dt;
      if (g.state === 'waiting') {
        g.dps = 0;
        if (g.t <= 0) { g.state = 'shrinking'; g.t = ph.shrink; g.fx = g.x; g.fy = g.y; g.fr = g.r; this.centerMsg('Zone shrinking!', 2); sfx.gas(); }
      } else {
        const total = ph.shrink, k = 1 - Math.max(0, g.t) / total;
        g.x = lerp(g.fx, g.tx, k); g.y = lerp(g.fy, g.ty, k); g.r = lerp(g.fr, g.tr, k);
        g.dps = ph.dps;
        if (g.t <= 0) {
          g.phase = Math.min(g.phase + 1, GAS_PHASES.length - 1);
          const nph = GAS_PHASES[g.phase];
          g.state = 'waiting'; g.t = nph.wait;
          this._nextGasTarget();
        }
      }
    }

    // local input → player
    const L = this.local;
    if (L && !L.dead) {
      if (L.dropping) { L.x = pl.x; L.y = pl.y; }
      else {
        let mx = 0, my = 0;
        if (this.keys['w'] || this.keys['arrowup']) my -= 1;
        if (this.keys['s'] || this.keys['arrowdown']) my += 1;
        if (this.keys['a'] || this.keys['arrowleft']) mx -= 1;
        if (this.keys['d'] || this.keys['arrowright']) mx += 1;
        if (this._sticks && this._sticks.move) { mx = this._sticks.move.dx / 40; my = this._sticks.move.dy / 40; const n = Math.hypot(mx, my); if (n > 1) { mx /= n; my /= n; } }
        L.input.mx = mx; L.input.my = my;
        L.input.shoot = this.mouse.down || !!this.keys[' '];
        // aim world coords
        const wx = this.cam.x + this.mouse.x / this.cam.zoom;
        const wy = this.cam.y + this.mouse.y / this.cam.zoom;
        L.aimX = wx; L.aimY = wy;
        L.faceAngle = Math.atan2(wy - L.y, wx - L.x);
      }
    }

    // bots think
    for (const [id, ctl] of this.botControllers) {
      const p = this.players.find((x) => x.id === id);
      if (!p || p.dead) continue;
      // remote-input players (P2P guests) skip AI
      if (p.remote) continue;
      ctl.update(dt);
    }

    // integrate players
    for (const p of this.players) {
      if (p.dead) continue;
      if (p.dropping) continue;
      if (p.chute > 0) {
        p.chute -= dt;
        if (p.chute <= 0) {
          p.chute = 0;
          for (let i = 0; i < 8; i++) this.particles.push({ x: p.x + rand(-14, 14), y: p.y + rand(-10, 10), vx: rand(-40, 40), vy: rand(-40, 40), t: 0.4, max: 0.4, c: '#d9cfae', r: 4 });
          if (p === this.local) { this.centerMsg('Landed — loot up!', 1.6); sfx.pickup(); }
        }
      }
      p.shootCd -= dt; p.reloadT -= dt;
      // healing
      if (p.healing) {
        p.healing.t -= dt;
        if (p.healing.t <= 0) {
          const h = p.healing.type;
          if (h === 'bandage' && p.heals.bandage > 0) { p.heals.bandage--; p.hp = Math.min(p.maxHp, p.hp + 20); }
          if (h === 'medkit' && p.heals.medkit > 0) { p.heals.medkit--; p.hp = p.maxHp; }
          if (h === 'shield' && p.heals.shield > 0) { p.heals.shield--; p.shield = Math.min(100, p.shield + 50); }
          p.healing = null;
          if (p === L) sfx.heal();
        }
      }
      // finish reload
      const slot = p.slots[p.slotI];
      if (slot && p.reloadT <= 0 && slot._reloading) {
        const w = WEAPONS[slot.gun];
        const need = w.mag - slot.magAmmo;
        const take = Math.min(need, p.ammo[w.ammo] || 0);
        slot.magAmmo += take; p.ammo[w.ammo] -= take;
        slot._reloading = false;
      }
      if (p.reloadT > 0 && slot && !slot._reloading) slot._reloading = true;

      const n = Math.hypot(p.input.mx, p.input.my);
      const wmul = (slot && WEAPONS[slot.gun].moveMul) || 1;
      // unarmed bots hustle to the nearest chest
      const hustle = (p.isBot && p.gun === 'fists' && p.chute <= 0) ? 1.12 : 1;
      let sp = p.speed * (p.healing ? 0.45 : 1) * (p.chute > 0 ? 0.5 : 1) * wmul * hustle * (slot && WEAPONS[slot.gun].len > 36 ? 0.94 : 1);
      if (p.useCd > 0) p.useCd -= dt;
      // pond slow
      if (this.inPond(p.x, p.y)) sp *= 0.75;
      if (n > 0.01) {
        const nx = p.input.mx / Math.max(1, n), ny = p.input.my / Math.max(1, n);
        p.vx = lerp(p.vx, nx * sp, Math.min(1, dt * 10));
        p.vy = lerp(p.vy, ny * sp, Math.min(1, dt * 10));
      } else { p.vx = lerp(p.vx, 0, Math.min(1, dt * 10)); p.vy = lerp(p.vy, 0, Math.min(1, dt * 10)); }
      p.x = clamp(p.x + p.vx * dt, 20, WORLD_SIZE - 20);
      p.y = clamp(p.y + p.vy * dt, 20, WORLD_SIZE - 20);
      this.collide(p);
      // gas dps
      if (this.phase === 'play' && this.isOutsideGas(p.x, p.y) && this.gas.dps > 0) {
        p.hp -= this.gas.dps * dt;
        p.lastDmgFrom = null;
        if (p.hp <= 0) this.kill(p, p.lastDmgFrom);
      }
      if (p.input.shoot) this.fire(p);
      // bot auto pickup + reload + heal key
      if (p.isBot) {
        const l = this.nearestLoot(p, 70);
        if (l) this.tryPickup(p, l);
        if (slot && slot.magAmmo === 0) this.startReload(p);
      } else if (p === L) {
        // auto-show interact tip handled in HUD
      }
    }

    // bullets
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const b = this.bullets[i];
      const step = Math.hypot(b.vx, b.vy) * dt;
      b.x += b.vx * dt; b.y += b.vy * dt; b.traveled += step;
      let dead = b.traveled > b.range || b.x < 0 || b.y < 0 || b.x > WORLD_SIZE || b.y > WORLD_SIZE;
      if (b.splash && dead) { this.explode(b.x, b.y, b.splash, b.dmg, b.from); }
      const hit = !dead ? this.hitObstacle(b.x, b.y) : null;
      if (hit) {
        if (b.splash) this.explode(b.x, b.y, b.splash, b.dmg, b.from);
        else this.damageObstacle(hit, b.dmg, this.players.find((p) => p.id === b.from));
        this.particles.push({ x: b.x, y: b.y, vx: 0, vy: 0, t: 0.12, max: 0.12, c: '#fff', r: 3 });
        dead = true;
      }
      if (!dead) {
        if (b.splash) {
          // lobbed grenades detonate on contact
          for (const p of this.players) {
            if (p.dead || p.dropping || p.id === b.from) continue;
            const shooter = this.players.find((s) => s.id === b.from);
            if (shooter && shooter.team && p.team && shooter.team === p.team) continue;
            if (dist2(b.x, b.y, p.x, p.y) < 30 * 30) {
              this.explode(b.x, b.y, b.splash, b.dmg, b.from);
              dead = true; break;
            }
          }
        } else for (const p of this.players) {
          if (p.dead || p.dropping || p.id === b.from) continue;
          const shooter = this.players.find((s) => s.id === b.from);
          if (shooter && shooter.team && p.team && shooter.team === p.team) continue;
          if (dist2(b.x, b.y, p.x, p.y) < (p.r + 3) * (p.r + 3)) {
            this.damage(p, b.dmg, shooter);
            dead = true; break;
          }
        }
      }
      if (dead) this.bullets.splice(i, 1);
    }

    // particles + chats decay
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const pt = this.particles[i];
      pt.t -= dt; pt.x += (pt.vx || 0) * dt; pt.y += (pt.vy || 0) * dt;
      if (pt.t <= 0) this.particles.splice(i, 1);
    }
    for (let i = this.floatChats.length - 1; i >= 0; i--) {
      this.floatChats[i].t -= dt;
      if (this.floatChats[i].t <= 0) this.floatChats.splice(i, 1);
    }

    // camera follows local
    if (L) this.followCam(L, dt, L.chute > 0 ? 0.75 : 1);

    // HUD + net
    this.snapT -= dt;
    if (this.onHud && L) {
      const alive = this.players.filter((p) => !p.dead).length;
      this.onHud({
        hp: L.hp, shield: L.shield, ammo: L.slots[L.slotI], reserve: L.ammo,
        heals: L.heals, slots: L.slots, slotI: L.slotI, alive, kills: L.kills,
        zone: this.zoneText(), dropping: L.dropping || L.chute > 0, reloading: L.reloadT > 0, healing: L.healing,
        interact: this.interactTarget(L),
      });
    }
    if (this.net && this.net.isHost && this.snapT <= 0) {
      this.snapT = 1 / 10;
      this.net.broadcastSnap(this.snapshot());
    }
  }

  zoneText() {
    if (this.phase === 'lobby') return `Starting in ${Math.max(0, Math.ceil(this.lobbyT))}`;
    if (this.phase === 'plane') return 'Jump! SPACE / F';
    const zt = this.gas.state === 'waiting' ? `Zone in ${Math.ceil(this.gas.t)}` : `Shrinking! ${Math.ceil(this.gas.t)}s`;
    return this.peaceT > 0 ? `🕊️ Grace ${Math.ceil(this.peaceT)} • ${zt}` : zt;
  }

  snapshot() {
    // kept small on purpose: oversized DataChannel messages get dropped
    // (notably ~16KB caps) while tiny ones like 'start' still arrive
    return {
      seed: this.seed,
      t: this.time,
      gas: this.gas,
      phase: this.phase,
      phaseStr: this.zoneText(),
      players: this.players.map((p) => ({ id: p.id, name: p.name, x: p.x | 0, y: p.y | 0, hp: p.hp | 0, shield: p.shield | 0, gun: p.gun, rarity: p.slots[p.slotI]?.rarity || 0, face: +p.faceAngle.toFixed(2), dead: p.dead, dropping: p.dropping, chute: p.chute > 0 ? 1 : 0, team: p.team, kills: p.kills })),
      bullets: this.bullets.slice(-24).map((b) => ({ x: b.x | 0, y: b.y | 0, vx: b.vx | 0, vy: b.vy | 0, gun: b.gun, splash: b.splash ? 1 : 0 })),
      taken: [...this.takenIds].slice(-120),
      opened: [...this.openedIds],
      fresh: this.loot.slice(-8),
      feed: this.killfeed.slice(0, 4),
      lobby: this.lobby,
    };
  }

  applySnapshot(s) {
    this.remoteSnap = s;
    this.lastSnapT = performance.now();
    this._rehelloed = false;
    this._stalled = false;
    if (s.gas) this.gas = s.gas;
    if (s.phase) this.phase = s.phase;
    // adopt the host's world (deterministic ids per seed keep loot in sync)
    if (s.seed && s.seed !== this.seed) {
      const w = generateWorld(s.seed);
      this.seed = s.seed;
      this.obstacles = w.obstacles; this.loot = w.loot; this.ponds = w.ponds; this.roads = w.roads;
      this.compounds = w.compounds; this.houses = w.houses;
      this.chests = this.wrapChests(w.chests);
      this.takenIds = new Set(); this.openedIds = new Set();
      if (s.lobby) {
        this.lobby = s.lobby;
        const lb = s.lobby;
        this.clearPen((x, y) => x > lb.x - 40 && x < lb.x + lb.w + 40 && y > lb.y - 40 && y < lb.y + lb.h + 40);
      }
      this.buildGrid();
    }
    // upsert dynamic loot (chest fountains, crate/kill drops)
    if (s.fresh) for (const f of s.fresh) {
      if (!this.loot.find((x) => x.id === f.id)) this.loot.push({ ...f });
    }
    // mark taken loot + opened chests
    if (s.taken) for (const id of s.taken) {
      const l = this.loot.find((x) => x.id === id);
      if (l) l.taken = true;
    }
    if (s.opened) for (const id of s.opened) {
      const c = this.chests.find((x) => x.id === id);
      if (c) c.opened = true;
    }
    // synced killfeed so guests see eliminations too
    if (s.feed) {
      const fj = JSON.stringify(s.feed);
      if (fj !== this._lastFeedJson) {
        this._lastFeedJson = fj;
        this.killfeed = s.feed.slice(0, 6);
        this.onKillfeed && this.onKillfeed(this.killfeed);
      }
    }
    // upsert players
    const seen = new Set();
    for (const sp of s.players) {
      seen.add(sp.id);
      let p = this.players.find((x) => x.id === sp.id);
      if (!p) {
        p = this._mkPlayer(sp.name, true, sp.team);
        p.id = sp.id; PID = Math.max(PID, sp.id + 1);
        this.players.push(p);
      }
      p.hp = sp.hp; p.shield = sp.shield; p.gun = sp.gun;
      // keep the wielded model in sync so guns render on remote players
      p.slots = [{ gun: sp.gun, rarity: sp.rarity || 0, magAmmo: 99 }];
      p.slotI = 0;
      // network targets — updateRemote lerps display pos toward these (smooth 10Hz)
      if (p.sx === undefined || Math.abs(sp.x - p.sx) > 600 || Math.abs(sp.y - p.sy) > 600) {
        p.x = sp.x; p.y = sp.y; p.sx = sp.x; p.sy = sp.y;
      } else { p.sx = sp.x; p.sy = sp.y; }
      p.faceAngle = sp.face; p.dead = sp.dead; p.dropping = sp.dropping; p.chute = sp.chute ? 1 : 0; p.kills = sp.kills;
    }
    // prune players who left (remote snapshots are the full roster)
    for (let i = this.players.length - 1; i >= 0; i--) {
      if (!seen.has(this.players[i].id)) this.players.splice(i, 1);
    }
    this.bullets = (s.bullets || []).map((b) => ({ ...b, dmg: 0, range: 300, traveled: 0, from: -1 }));
    // camera on local-by-name
    if (this.local) {
      const me = this.players.find((x) => x.name === this.local.name && !x.dead);
      if (me) { this.cam.x = me.x - this.cv.width / this.cam.zoom / 2; this.cam.y = me.y - this.cv.height / this.cam.zoom / 2; }
    }
  }

  updateRemote(dt) {
    // client: send input, render snapshot
    if (this.local && this.net) {
      let mx = 0, my = 0;
      if (this.keys['w']) my -= 1; if (this.keys['s']) my += 1;
      if (this.keys['a']) mx -= 1; if (this.keys['d']) mx += 1;
      const wx = this.cam.x + this.mouse.x / this.cam.zoom;
      const wy = this.cam.y + this.mouse.y / this.cam.zoom;
      this.net.sendInput({ mx, my, shoot: this.mouse.down, ax: wx | 0, ay: wy | 0, drop: !!(this.keys['f'] || this.keys[' ']), use: !!this.keys['e'] }, { name: this.local.name });
    }
    // stall detection: re-hello once for transient drops, ask for a full
    // rejoin at 6s (repeatable), boot to menu at 20s as a last resort
    const staleMs = performance.now() - (this.lastSnapT || 0);
    if (staleMs > 4000 && !this._rehelloed) {
      this._rehelloed = true;
      try { this.net && this.net.sendHello({ name: (this.local && this.local.name) || 'guest' }); } catch { }
    }
    if (staleMs > 6000 && !this._stalled && this.onStall) {
      this._stalled = true;
      this.onStall();
    }
    if (staleMs > 20000 && this.onTimeout) {
      const cb = this.onTimeout; this.onTimeout = null;
      cb();
      return;
    }
    for (let i = this.particles.length - 1; i >= 0; i--) { this.particles[i].t -= dt; if (this.particles[i].t <= 0) this.particles.splice(i, 1); }
    // coast snapshot bullets so tracers stay smooth between 10Hz snapshots
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const b = this.bullets[i];
      b.x += (b.vx || 0) * dt; b.y += (b.vy || 0) * dt;
      b.traveled = (b.traveled || 0) + Math.hypot(b.vx || 0, b.vy || 0) * dt;
      if (b.traveled > 1400) this.bullets.splice(i, 1);
    }
    // interpolate remote players toward snapshot targets (smooth 10Hz)
    for (const p of this.players) {
      if (p.dead || p.sx === undefined) continue;
      const dx = p.sx - p.x, dy = p.sy - p.y;
      const k = Math.min(1, dt * 11);
      p.x += dx * k; p.y += dy * k;
    }
    if (this.onHud) {
      const alive = this.players.filter((p) => !p.dead).length;
      let zone = (this.remoteSnap && this.remoteSnap.phaseStr) || 'Online';
      if (!this.remoteSnap || performance.now() - (this.lastSnapT || 0) > 3000) zone = '🛰️ Waiting for host…';
      this.onHud({ hp: 100, shield: 0, slots: [], slotI: 0, alive, kills: 0, zone, remote: true });
    }
  }

  inPond(x, y) {
    if (!this.ponds) return false;
    for (const p of this.ponds) if (dist2(x, y, p.x, p.y) < p.r * p.r) return true;
    return false;
  }

  // uniform spatial grid — the 9000px map holds 1600+ obstacles
  buildGrid() {
    this.gridCell = 256;
    this.grid = new Map();
    const all = this.obstacles.concat(this.chests);
    for (const o of all) {
      const b = this.obBox(o);
      const x0 = Math.floor(b.x0 / this.gridCell), x1 = Math.floor(b.x1 / this.gridCell);
      const y0 = Math.floor(b.y0 / this.gridCell), y1 = Math.floor(b.y1 / this.gridCell);
      for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) {
        const k = cx + ':' + cy;
        let arr = this.grid.get(k);
        if (!arr) { arr = []; this.grid.set(k, arr); }
        arr.push(o);
      }
    }
  }
  obBox(o) {
    if (o.type === 'wall') return { x0: o.x, y0: o.y, x1: o.x + o.w, y1: o.y + o.h };
    const cx = o.x, cy = o.y, r = o.r || 20;
    return { x0: cx - r, y0: cy - r, x1: cx + r, y1: cy + r };
  }
  gridQuery(x0, y0, x1, y1) {
    const seen = new Set(), out = [];
    const cx0 = Math.floor(x0 / this.gridCell), cx1 = Math.floor(x1 / this.gridCell);
    const cy0 = Math.floor(y0 / this.gridCell), cy1 = Math.floor(y1 / this.gridCell);
    for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) {
      const arr = this.grid.get(cx + ':' + cy);
      if (!arr) continue;
      for (const o of arr) if (!seen.has(o)) { seen.add(o); out.push(o); }
    }
    return out;
  }

  nearestChest(p, maxD = 120) {
    let best = null, bd = maxD * maxD;
    for (const c of this.chests) {
      if (c.opened) continue;
      const d2 = dist2(p.x, p.y, c.x, c.y);
      if (d2 < bd) { bd = d2; best = c; }
    }
    return best;
  }

  chestRoll(tier) {
    const r = Math.random();
    return tier === 'golden'
      ? (r < 0.05 ? 0 : r < 0.25 ? 1 : r < 0.6 ? 2 : r < 0.87 ? 3 : 4)
      : (r < 0.55 ? 0 : r < 0.83 ? 1 : r < 0.95 ? 2 : r < 0.995 ? 3 : 4);
  }

  openChest(p, c) {
    if (!c || c.opened || p.dead || p.dropping || p.chute > 0) return false;
    if (dist2(p.x, p.y, c.x, c.y) > 100 * 100) return false;
    c.opened = true;
    this.openedIds.add(c.id);
    const pool = c.tier === 'golden' ? CHEST_POOL_GOLDEN : CHEST_POOL_BASIC;
    const drops = [];
    const nGuns = c.tier === 'golden' ? (Math.random() < 0.5 ? 2 : 1) : 1;
    for (let i = 0; i < nGuns; i++) drops.push({ kind: 'weapon', weapon: pick(pool), rarity: this.chestRoll(c.tier) });
    const w0 = WEAPONS[drops[0].weapon];
    drops.push({ kind: 'ammo', ammo: w0.ammo, amount: w0.mag * 2 });
    if (Math.random() < (c.tier === 'golden' ? 0.8 : 0.45)) drops.push({ kind: 'heal', heal: pick(['bandage', 'bandage', 'medkit']) });
    if (c.tier === 'golden' && Math.random() < 0.5) drops.push({ kind: 'heal', heal: 'shield' });
    for (const d of drops) {
      const a = Math.random() * Math.PI * 2, rr = rand(30, 52);
      d.x = clamp(c.x + Math.cos(a) * rr, 30, WORLD_SIZE - 30);
      d.y = clamp(c.y + Math.sin(a) * rr, 30, WORLD_SIZE - 30);
      this.dropLoot(d);
    }
    for (let i = 0; i < 14; i++) this.particles.push({ x: c.x + rand(-16, 16), y: c.y + rand(-12, 12), vx: rand(-120, 120), vy: rand(-160, -20), t: 0.6, max: 0.6, c: c.tier === 'golden' ? '#ffd23f' : '#fff', r: 4 });
    if (p === this.local) {
      if (c.tier === 'golden') { this.centerMsg('💛 GOLDEN CHEST!', 1.8); sfx.fanfare(); }
      else sfx.chest();
    } else if (p.isBot && Math.hypot(p.x - (this.local?.x || 0), p.y - (this.local?.y || 0)) < 900) sfx.chest();
    return true;
  }

  // E key: open chest first, else pick up loot
  tryInteract(p) {
    if (!p || p.dead || p.dropping || p.chute > 0) return false;
    if ((p.useCd || 0) > 0) return false;
    p.useCd = 0.25;
    const c = this.nearestChest(p, 100);
    if (c) return this.openChest(p, c);
    const l = this.nearestLoot(p, 80);
    if (l) return this.tryPickup(p, l);
    return false;
  }

  interactTarget(p) {
    if (!p || p.dead || p.dropping || p.chute > 0 || this.phase !== 'play') return null;
    const c = this.nearestChest(p, 100);
    if (c) return { chest: true, tier: c.tier };
    return this.nearestLoot(p, 80);
  }

  hitObstacle(x, y) {
    const near = this.grid ? this.gridQuery(x - 60, y - 60, x + 60, y + 60) : this.obstacles;
    for (const o of near) {
      if (o.destroyed) continue;
      if (o.type === 'wall') {
        if (x > o.x && x < o.x + o.w && y > o.y && y < o.y + o.h) return o;
      } else if (o.type === 'chest' || o.type === 'chest_gold') {
        continue; // bullets fly over chests
      } else if (o.solid !== false && o.r) {
        if (dist2(x, y, o.x, o.y) < o.r * o.r) return o;
      }
    }
    return null;
  }

  collide(p) {
    const near = this.grid ? this.gridQuery(p.x - p.r - 60, p.y - p.r - 60, p.x + p.r + 60, p.y + p.r + 60) : this.obstacles.concat(this.chests);
    for (const o of near) {
      if (o.destroyed || o.solid === false) continue;
      if (o.type === 'chest' || o.type === 'chest_gold') {
        const d2 = dist2(p.x, p.y, o.x, o.y);
        const rr = p.r + o.r * 0.75;
        if (d2 < rr * rr && d2 > 0.01) {
          const d = Math.sqrt(d2), push = rr - d;
          p.x += ((p.x - o.x) / d) * push;
          p.y += ((p.y - o.y) / d) * push;
        }
        continue;
      }
      if (o.type === 'wall') {
        const nx = clamp(p.x, o.x, o.x + o.w), ny = clamp(p.y, o.y, o.y + o.h);
        const d2 = dist2(p.x, p.y, nx, ny);
        if (d2 < p.r * p.r) {
          const d = Math.sqrt(d2) || 0.01;
          p.x = nx + ((p.x - nx) / d) * p.r;
          p.y = ny + ((p.y - ny) / d) * p.r;
        }
      } else if (o.r) {
        const d2 = dist2(p.x, p.y, o.x, o.y);
        const rr = p.r + o.r * 0.8;
        if (d2 < rr * rr && d2 > 0.01) {
          const d = Math.sqrt(d2);
          const push = (rr - d);
          p.x += ((p.x - o.x) / d) * push;
          p.y += ((p.y - o.y) / d) * push;
        }
      }
    }
  }

  // interiors stay hidden under the roof unless you're inside or at the door
  houseRevealed(h, p) {
    if (!h || !h.door || !p || p.dead) return true;
    const inside = p.x > h.x - h.w / 2 - 12 && p.x < h.x + h.w / 2 + 12 &&
      p.y > h.y - h.h / 2 - 12 && p.y < h.y + h.h / 2 + 12;
    if (inside) return true;
    return dist2(p.x, p.y, h.door.x, h.door.y) < 120 * 120;
  }

  // ---------- render ----------
  render() {
    const { ctx, cv } = this;
    const z = this.cam.zoom || 1;
    // bg
    ctx.fillStyle = '#7ab648';
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.save();
    ctx.scale(z, z);
    ctx.translate(-this.cam.x, -this.cam.y);

    const vx0 = this.cam.x - 100, vy0 = this.cam.y - 100;
    const vx1 = this.cam.x + cv.width / z + 100, vy1 = this.cam.y + cv.height / z + 100;

    // grid
    ctx.strokeStyle = 'rgba(0,0,0,0.07)'; ctx.lineWidth = 1.5;
    const gs = 120;
    ctx.beginPath();
    for (let x = Math.floor(vx0 / gs) * gs; x < vx1; x += gs) { ctx.moveTo(x, vy0); ctx.lineTo(x, vy1); }
    for (let y = Math.floor(vy0 / gs) * gs; y < vy1; y += gs) { ctx.moveTo(vx0, y); ctx.lineTo(vx1, y); }
    ctx.stroke();

    // roads
    if (this.roads) for (const r of this.roads) {
      ctx.fillStyle = '#b99a63';
      ctx.fillRect(r.x, r.y, r.w, r.h);
    }
    // ponds
    if (this.ponds) for (const p of this.ponds) {
      if (p.x + p.r < vx0 || p.x - p.r > vx1) continue;
      ctx.fillStyle = '#5aa9d6';
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 7); ctx.fill();
      ctx.fillStyle = '#6cbcE6';
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r * 0.75, 0, 7); ctx.fill();
    }

    // loot (ground)
    for (const l of this.loot) {
      if (l.taken || l.x < vx0 || l.x > vx1 || l.y < vy0 || l.y > vy1) continue;
      this.drawLoot(l);
    }

    // lobby plaza
    if (this.lobby && this.phase === 'lobby') {
      const lb = this.lobby;
      ctx.fillStyle = '#c9b183';
      ctx.fillRect(lb.x, lb.y, lb.w, lb.h);
      ctx.fillStyle = '#8a6d3b';
      for (let fx = lb.x; fx <= lb.x + lb.w; fx += 64) {
        ctx.fillRect(fx - 4, lb.y - 4, 8, 8);
        ctx.fillRect(fx - 4, lb.y + lb.h - 4, 8, 8);
      }
      for (let fy = lb.y; fy <= lb.y + lb.h; fy += 64) {
        ctx.fillRect(lb.x - 4, fy - 4, 8, 8);
        ctx.fillRect(lb.x + lb.w - 4, fy - 4, 8, 8);
      }
      ctx.strokeStyle = '#7a5c2e'; ctx.lineWidth = 4;
      ctx.strokeRect(lb.x, lb.y, lb.w, lb.h);
      ctx.font = 'bold 36px sans-serif'; ctx.textAlign = 'center';
      ctx.lineWidth = 5; ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.strokeText('🎪 LOBBY', lb.x + lb.w / 2, lb.y + 64);
      ctx.fillStyle = '#5c4a20';
      ctx.fillText('🎪 LOBBY', lb.x + lb.w / 2, lb.y + 64);
    }

    // house floors
    if (this.houses) for (const h of this.houses) {
      if (h.x + h.w / 2 < vx0 || h.x - h.w / 2 > vx1 || h.y + h.h / 2 < vy0 || h.y - h.h / 2 > vy1) continue;
      ctx.fillStyle = '#d9b77c';
      ctx.fillRect(h.x - h.w / 2, h.y - h.h / 2, h.w, h.h);
      ctx.fillStyle = '#c9a668';
      ctx.fillRect(h.x - h.w / 2 + 10, h.y - h.h / 2 + 10, h.w - 20, h.h - 20);
      ctx.strokeStyle = 'rgba(90,60,20,0.25)'; ctx.lineWidth = 1.5;
      for (let pl = h.x - h.w / 2 + 24; pl < h.x + h.w / 2; pl += 22) {
        ctx.beginPath(); ctx.moveTo(pl, h.y - h.h / 2 + 10); ctx.lineTo(pl, h.y + h.h / 2 - 10); ctx.stroke();
      }
      // doorway mat + posts so the entrance reads clearly
      if (h.door) {
        ctx.fillStyle = 'rgba(60,35,10,0.55)';
        ctx.beginPath(); ctx.arc(h.door.x, h.door.y, 24, 0, 7); ctx.fill();
        ctx.fillStyle = '#8a5a2b';
        ctx.beginPath(); ctx.arc(h.door.x - 26, h.door.y, 6, 0, 7); ctx.fill();
        ctx.beginPath(); ctx.arc(h.door.x + 26, h.door.y, 6, 0, 7); ctx.fill();
      }
    }

    // obstacles
    for (const o of this.obstacles) {
      if (o.destroyed) continue;
      const ox = o.x + (o.w || 0) / 2, oy = o.y + (o.h || 0) / 2;
      if (ox < vx0 || ox > vx1 || oy < vy0 || oy > vy1) continue;
      this.drawObstacle(o);
    }

    // chests (basic 1x1 + golden 1x2 — the only gun source)
    if (this.chests) for (const c of this.chests) {
      if (c.x < vx0 || c.x > vx1 || c.y < vy0 || c.y > vy1) continue;
      this.drawChest(c);
    }

    // POI name labels
    if (this.compounds) {
      ctx.textAlign = 'center'; ctx.font = 'bold 17px sans-serif';
      for (const c of this.compounds) {
        if (c.x < vx0 || c.x > vx1 || c.y < vy0 || c.y > vy1) continue;
        ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.strokeText(c.name, c.x, c.y - c.h / 2 - 12);
        ctx.fillStyle = 'rgba(30,60,20,0.9)';
        ctx.fillText(c.name, c.x, c.y - c.h / 2 - 12);
      }
    }

    // bullets
    ctx.lineCap = 'round';
    ctx.lineCap = 'round';
    for (const b of this.bullets) {
      if (b.gun === 'grenade' || b.splash) {
        ctx.fillStyle = '#2c3a2c';
        ctx.beginPath(); ctx.arc(b.x, b.y, 7, 0, 7); ctx.fill();
        ctx.strokeStyle = '#111'; ctx.lineWidth = 2; ctx.stroke();
        ctx.fillStyle = (this.time * 10 | 0) % 2 ? '#ffdd44' : '#ff5522';
        ctx.beginPath(); ctx.arc(b.x + 5, b.y - 5, 3, 0, 7); ctx.fill();
        continue;
      }
      ctx.strokeStyle = b.gun === 'crossbow' ? '#d8f0d8' : '#fff8';
      ctx.lineWidth = b.gun === 'sniper' || b.gun === 'scout' ? 5 : 4;
      ctx.beginPath(); ctx.moveTo(b.x - b.vx * 0.012, b.y - b.vy * 0.012); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.fillStyle = '#ffdd44';
      ctx.beginPath(); ctx.arc(b.x, b.y, 3, 0, 7); ctx.fill();
    }

    // players sorted by y
    const ps = [...this.players].filter((p) => !p.dead && !p.dropping).sort((a, b) => a.y - b.y);
    // dropping (parachute) on top
    for (const p of this.players) if (!p.dead && p.dropping) this.drawDropping(p);
    for (const p of ps) this.drawPlayer(p);

    // particles
    for (const pt of this.particles) {
      ctx.globalAlpha = Math.max(0, pt.t / pt.max);
      ctx.fillStyle = pt.c;
      ctx.beginPath(); ctx.arc(pt.x, pt.y, pt.r, 0, 7); ctx.fill();
      ctx.globalAlpha = 1;
    }

    // chat bubbles
    ctx.font = '12px sans-serif'; ctx.textAlign = 'center';
    for (const c of this.floatChats) {
      const p = this.players.find((x) => x.id === c.pid);
      if (!p || p.dead) continue;
      const w = ctx.measureText(c.text).width + 16;
      ctx.fillStyle = '#fff';
      roundRect(ctx, p.x - w / 2, p.y - 52, w, 22, 6); ctx.fill();
      ctx.fillStyle = '#222'; ctx.fillText(c.text, p.x, p.y - 37);
    }

    // house roofs — interiors stay hidden unless you're inside or at the door
    if (this.houses) for (const h of this.houses) {
      if (h.x + h.w / 2 + 30 < vx0 || h.x - h.w / 2 - 30 > vx1 || h.y + h.h / 2 + 30 < vy0 || h.y - h.h / 2 - 30 > vy1) continue;
      if (this.houseRevealed(h, this.local)) continue;
      const rx = h.x - h.w / 2 - 18, ry = h.y - h.h / 2 - 18, rw = h.w + 36, rh = h.h + 36;
      ctx.fillStyle = 'rgba(0,0,0,0.28)';
      ctx.fillRect(rx + 6, ry + 8, rw, rh);
      const roof = ctx.createLinearGradient(rx, ry, rx, ry + rh);
      roof.addColorStop(0, '#c25e3a'); roof.addColorStop(1, '#8e3a20');
      ctx.fillStyle = roof;
      ctx.fillRect(rx, ry, rw, rh);
      ctx.strokeStyle = 'rgba(120,40,20,0.6)'; ctx.lineWidth = 2;
      for (let sy = ry + 18; sy < ry + rh; sy += 20) {
        ctx.beginPath(); ctx.moveTo(rx, sy); ctx.lineTo(rx + rw, sy); ctx.stroke();
      }
      ctx.fillStyle = 'rgba(255,255,255,0.16)';
      ctx.fillRect(rx, ry, rw, 8);
      ctx.strokeStyle = '#5c1f0e'; ctx.lineWidth = 4;
      ctx.strokeRect(rx, ry, rw, rh);
      // ridge beam
      ctx.fillStyle = '#6e2a15';
      ctx.fillRect(h.x - 8, ry, 16, rh);
    }

    // plane
    if (this.plane && this.plane.active) {
      const pl = this.plane;
      ctx.save(); ctx.translate(pl.x, pl.y); ctx.rotate(Math.atan2(pl.dy, pl.dx));
      // cargo plane: fuselage, wings, tail, cockpit, spinning prop
      ctx.fillStyle = 'rgba(0,0,0,0.2)';
      ctx.beginPath(); ctx.ellipse(4, 6, 74, 28, 0, 0, 7); ctx.fill();
      ctx.fillStyle = '#4a90e2';
      ctx.beginPath(); ctx.ellipse(0, 0, 70, 25, 0, 0, 7); ctx.fill();
      ctx.fillStyle = '#6fb3f0';
      ctx.beginPath(); ctx.ellipse(14, -4, 44, 13, 0, 0, 7); ctx.fill();
      ctx.fillStyle = '#3570b5';
      ctx.fillRect(-14, -52, 24, 104);           // main wing
      ctx.fillRect(-12, -50, 8, 100);
      ctx.fillStyle = '#2c5a92';
      ctx.fillRect(-64, -26, 18, 52);            // tail wing
      ctx.fillRect(-66, -8, 22, 16);             // tail fin
      ctx.fillStyle = '#dff1ff';                 // cockpit
      ctx.beginPath(); ctx.ellipse(48, 0, 12, 9, 0, 0, 7); ctx.fill();
      ctx.fillStyle = 'rgba(180,220,255,0.7)';   // prop blur
      ctx.fillRect(66, -20, 5, 40);
      ctx.fillStyle = '#fff'; ctx.font = 'bold 20px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('22', -2, 7);
      ctx.restore();
    }

    // STORM (re-coded): no full-screen wash. A pulsing energy wall marks the
    // zone rim, the next circle stays gold, and caught players get guidance.
    const g = this.gas;
    if (g && this.phase === 'play') {
      const pulse = 0.55 + 0.45 * Math.sin(this.time * 3.2);
      ctx.save();
      // energy wall: soft wide band + bright animated rim on the zone edge
      ctx.strokeStyle = `rgba(150,60,220,${0.22 + 0.18 * pulse})`;
      ctx.lineWidth = 30;
      ctx.beginPath(); ctx.arc(g.x, g.y, g.r, 0, 7); ctx.stroke();
      ctx.strokeStyle = `rgba(225,190,255,${0.55 + 0.4 * pulse})`;
      ctx.lineWidth = 5; ctx.setLineDash([26, 18]);
      ctx.lineDashOffset = -this.time * 60;
      ctx.beginPath(); ctx.arc(g.x, g.y, g.r, 0, 7); ctx.stroke();
      ctx.setLineDash([]);
      // next-zone ring
      ctx.strokeStyle = '#ffd23f'; ctx.lineWidth = 3; ctx.setLineDash([14, 10]);
      ctx.beginPath(); ctx.arc(g.tx, g.ty, g.tr, 0, 7); ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
      // guidance arrow + distance for players caught outside
      const L = this.local;
      if (L && !L.dead && this.isOutsideGas(L.x, L.y)) {
        const a = Math.atan2(g.y - L.y, g.x - L.x);
        const d = Math.hypot(g.x - L.x, g.y - L.y) - g.r;
        const ax = L.x + Math.cos(a) * 76, ay = L.y + Math.sin(a) * 76;
        ctx.save(); ctx.translate(ax, ay); ctx.rotate(a);
        ctx.fillStyle = `rgba(255,70,70,${0.7 + 0.3 * pulse})`;
        ctx.beginPath(); ctx.moveTo(18, 0); ctx.lineTo(-9, -12); ctx.lineTo(-9, 12); ctx.closePath(); ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 2; ctx.stroke();
        ctx.restore();
        const label = 'ZONE ' + Math.max(1, Math.round(d / 50)) + 'm';
        ctx.font = 'bold 14px sans-serif'; ctx.textAlign = 'center';
        ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0,0,0,0.7)';
        ctx.strokeText(label, L.x, L.y - 60);
        ctx.fillStyle = '#ff6b6b';
        ctx.fillText(label, L.x, L.y - 60);
      }
    }

    // world border
    ctx.strokeStyle = '#3d6b1f'; ctx.lineWidth = 12;
    ctx.strokeRect(0, 0, WORLD_SIZE, WORLD_SIZE);

    ctx.restore();

    // shake
    if (this._shake > 0) { this._shake *= 0.85; if (this._shake < 0.3) this._shake = 0; }

    this.drawMinimap();
    if (this.bigMap) this.drawBigMap();
  }

  drawLoot(l) {
    const { ctx } = this;
    if (l.kind === 'weapon') {
      const rar = RARITIES[l.rarity || 0];
      const w = WEAPONS[l.weapon];
      if (l.rarity === 4) {
        ctx.fillStyle = 'rgba(255,210,63,0.25)';
        ctx.beginPath(); ctx.arc(l.x, l.y, 34 + Math.sin(this.time * 4 + l.x) * 3, 0, 7); ctx.fill();
      }
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.beginPath(); ctx.ellipse(l.x, l.y + 10, 30, 9, 0, 0, 7); ctx.fill();
      // rarity plate + gun silhouette lying on the ground
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      roundRect(ctx, l.x - 30, l.y - 14, 60, 26, 6); ctx.fill();
      ctx.save(); ctx.translate(l.x - 4, l.y - 1); ctx.rotate(-0.35); ctx.scale(0.85, 0.85);
      this.drawGunModel(l.weapon, rar.color, w.len);
      ctx.restore();
      ctx.fillStyle = rar.color;
      roundRect(ctx, l.x - 30, l.y + 12, 60, 15, 4); ctx.fill();
      ctx.fillStyle = '#111'; ctx.font = 'bold 10px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(w.name, l.x, l.y + 23);
    } else if (l.kind === 'heal') {
      ctx.fillStyle = l.heal === 'bandage' ? '#fff' : l.heal === 'medkit' ? '#ff5555' : '#4ad2ff';
      roundRect(ctx, l.x - 12, l.y - 12, 24, 24, 6); ctx.fill();
      ctx.strokeStyle = '#0007'; ctx.lineWidth = 2; ctx.stroke();
      ctx.fillStyle = l.heal === 'bandage' ? '#c00' : '#fff';
      ctx.font = 'bold 14px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(l.heal === 'bandage' ? '+' : l.heal === 'medkit' ? '✚' : '◈', l.x, l.y + 5);
    } else if (l.kind === 'ammo') {
      ctx.fillStyle = '#8a6d1b';
      roundRect(ctx, l.x - 12, l.y - 9, 24, 18, 4); ctx.fill();
      ctx.fillStyle = '#ffe27a'; ctx.font = 'bold 10px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(l.ammo.toUpperCase().slice(0, 3), l.x, l.y + 4);
    }
  }

  drawChest(c) {
    const { ctx } = this;
    const gold = c.tier === 'golden';
    const w = c.w, h = c.h;
    // glow for golden
    if (gold && !c.opened) {
      ctx.fillStyle = 'rgba(255,210,63,0.22)';
      ctx.beginPath(); ctx.arc(c.x, c.y, 52 + Math.sin(this.time * 3) * 5, 0, 7); ctx.fill();
    }
    // shadow
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath(); ctx.ellipse(c.x, c.y + h / 2, w / 2, 7, 0, 0, 7); ctx.fill();
    // base
    const grad = ctx.createLinearGradient(c.x, c.y - h / 2, c.x, c.y + h / 2);
    if (gold) { grad.addColorStop(0, '#ffe27a'); grad.addColorStop(1, '#c9920e'); }
    else { grad.addColorStop(0, '#b07a3f'); grad.addColorStop(1, '#7a4d1e'); }
    ctx.fillStyle = grad;
    roundRect(ctx, c.x - w / 2, c.y - h / 2 + 8, w, h - 8, 4); ctx.fill();
    ctx.strokeStyle = gold ? '#7a5c00' : '#4a2d0e'; ctx.lineWidth = 2.5; ctx.stroke();
    // lid
    if (c.opened) {
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      roundRect(ctx, c.x - w / 2 + 3, c.y - h / 2 + 11, w - 6, 8, 3); ctx.fill();
      ctx.save(); ctx.translate(c.x - w / 2 + 4, c.y - h / 2 + 10); ctx.rotate(-0.9);
      ctx.fillStyle = gold ? '#c9920e' : '#7a4d1e';
      ctx.fillRect(0, -14, w * 0.9, 12);
      ctx.restore();
    } else {
      ctx.fillStyle = gold ? '#fff0b0' : '#d09a55';
      roundRect(ctx, c.x - w / 2, c.y - h / 2, w, 14, 5); ctx.fill();
      ctx.strokeStyle = gold ? '#7a5c00' : '#4a2d0e'; ctx.lineWidth = 2; ctx.stroke();
      // bands + lock
      ctx.fillStyle = gold ? '#8a6d00' : '#3d3d3d';
      ctx.fillRect(c.x - 4, c.y - h / 2, 8, h - 4);
      ctx.beginPath(); ctx.arc(c.x, c.y + 2, gold ? 7 : 5, 0, 7); ctx.fill();
      ctx.fillStyle = '#222';
      ctx.beginPath(); ctx.arc(c.x, c.y + 2, 2.2, 0, 7); ctx.fill();
      if (gold) {
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'center';
        ctx.fillText('★', c.x - w / 2 + 11, c.y + 8);
        ctx.fillText('★', c.x + w / 2 - 11, c.y + 8);
      }
    }
  }

  drawObstacle(o) {
    const { ctx } = this;
    if (o.type === 'tree') {
      const r = o.r;
      ctx.fillStyle = 'rgba(0,0,0,0.22)';
      ctx.beginPath(); ctx.ellipse(o.x, o.y + r * 0.75, r, r * 0.35, 0, 0, 7); ctx.fill();
      if (o.pine) {
        // pine: stacked triangles
        ctx.fillStyle = '#5a3a1a';
        ctx.fillRect(o.x - 4, o.y + r * 0.1, 8, r * 0.5);
        const layers = [[0, -0.75, 0.95], [0, -0.35, 1.1], [0, 0.05, 1.2]];
        for (const [ox, oy, s] of layers) {
          ctx.fillStyle = '#1d4d18';
          ctx.beginPath();
          ctx.moveTo(o.x + ox * r - r * s * 0.62, o.y + oy * r + r * 0.42);
          ctx.lineTo(o.x + ox * r, o.y + oy * r - r * 0.5);
          ctx.lineTo(o.x + ox * r + r * s * 0.62, o.y + oy * r + r * 0.42);
          ctx.closePath(); ctx.fill();
          ctx.fillStyle = 'rgba(255,255,255,0.10)';
          ctx.beginPath();
          ctx.moveTo(o.x + ox * r - r * s * 0.3, o.y + oy * r + r * 0.3);
          ctx.lineTo(o.x + ox * r, o.y + oy * r - r * 0.5);
          ctx.lineTo(o.x + ox * r, o.y + oy * r + r * 0.35);
          ctx.closePath(); ctx.fill();
        }
      } else {
        // broadleaf: trunk + layered canopy blobs
        ctx.fillStyle = '#6b4423';
        roundRect(ctx, o.x - r * 0.14, o.y - r * 0.1, r * 0.28, r * 0.75, 4); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.15)';
        ctx.fillRect(o.x - r * 0.14, o.y - r * 0.1, r * 0.1, r * 0.75);
        const blobs = [[0, -0.15, 1.0, '#2f7a24'], [-0.42, 0.12, 0.72, '#2a6c20'], [0.42, 0.12, 0.72, '#35902b'], [0, -0.42, 0.62, '#3f9c33']];
        for (const [ox, oy, s, c] of blobs) {
          ctx.fillStyle = c;
          ctx.beginPath(); ctx.arc(o.x + ox * r, o.y + oy * r, r * s * 0.62, 0, 7); ctx.fill();
        }
        ctx.fillStyle = 'rgba(255,255,255,0.18)';
        ctx.beginPath(); ctx.arc(o.x - r * 0.22, o.y - r * 0.42, r * 0.3, 0, 7); ctx.fill();
      }
    } else if (o.type === 'rock' || o.type === 'rocksmall') {
      const r = o.r;
      ctx.fillStyle = 'rgba(0,0,0,0.2)';
      ctx.beginPath(); ctx.ellipse(o.x, o.y + r * 0.8, r, r * 0.3, 0, 0, 7); ctx.fill();
      // faceted polygon, shape seeded by id so it never shimmers
      const n = 7, wob = ((o.id || 1) % 10) / 10;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + wob;
        const rr = r * (0.82 + 0.25 * Math.abs(Math.sin(i * 3.7 + wob * 9)));
        const px = o.x + Math.cos(a) * rr, py = o.y + Math.sin(a) * rr * 0.92;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
      const rg = ctx.createLinearGradient(o.x - r, o.y - r, o.x + r, o.y + r);
      rg.addColorStop(0, '#a8a8a8'); rg.addColorStop(1, '#6e6e6e');
      ctx.fillStyle = rg; ctx.fill();
      ctx.strokeStyle = '#4c4c4c'; ctx.lineWidth = 2.5; ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.25)';
      ctx.beginPath(); ctx.ellipse(o.x - r * 0.25, o.y - r * 0.3, r * 0.32, r * 0.2, -0.5, 0, 7); ctx.fill();
    } else if (o.type === 'crate') {
      ctx.fillStyle = 'rgba(0,0,0,0.2)';
      ctx.beginPath(); ctx.ellipse(o.x, o.y + 20, 21, 6, 0, 0, 7); ctx.fill();
      const cg = ctx.createLinearGradient(o.x, o.y - 20, o.x, o.y + 20);
      cg.addColorStop(0, '#d89a4e'); cg.addColorStop(1, '#a06a28');
      ctx.fillStyle = cg;
      roundRect(ctx, o.x - 20, o.y - 20, 40, 40, 4); ctx.fill();
      ctx.strokeStyle = '#6b4211'; ctx.lineWidth = 3; ctx.stroke();
      // planks
      ctx.strokeStyle = 'rgba(107,66,17,0.7)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(o.x - 20, o.y - 7); ctx.lineTo(o.x + 20, o.y - 7); ctx.moveTo(o.x - 20, o.y + 7); ctx.lineTo(o.x + 20, o.y + 7); ctx.stroke();
      // cross brace + corner brackets + nails
      ctx.strokeStyle = '#7a4d00'; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.moveTo(o.x - 20, o.y - 20); ctx.lineTo(o.x + 20, o.y + 20); ctx.moveTo(o.x + 20, o.y - 20); ctx.lineTo(o.x - 20, o.y + 20); ctx.stroke();
      ctx.fillStyle = '#5c5c5c';
      for (const [nx, ny] of [[-14, -14], [14, -14], [-14, 14], [14, 14]]) {
        ctx.beginPath(); ctx.arc(o.x + nx, o.y + ny, 2.5, 0, 7); ctx.fill();
      }
    } else if (o.type === 'barrel') {
      const r = o.r;
      ctx.fillStyle = 'rgba(0,0,0,0.22)';
      ctx.beginPath(); ctx.ellipse(o.x, o.y + r * 0.9, r, r * 0.3, 0, 0, 7); ctx.fill();
      const bg = ctx.createLinearGradient(o.x - r, 0, o.x + r, 0);
      bg.addColorStop(0, '#8e2f1c'); bg.addColorStop(0.5, '#c8502f'); bg.addColorStop(1, '#7e2818');
      ctx.fillStyle = bg;
      ctx.beginPath(); ctx.arc(o.x, o.y, r, 0, 7); ctx.fill();
      ctx.strokeStyle = '#5c1a0e'; ctx.lineWidth = 2.5; ctx.stroke();
      // metal bands + staves
      ctx.strokeStyle = '#3f3f3f'; ctx.lineWidth = 3.5;
      ctx.beginPath(); ctx.arc(o.x, o.y, r * 0.98, -0.5, 0.5); ctx.stroke();
      ctx.beginPath(); ctx.arc(o.x, o.y, r * 0.98, Math.PI - 0.5, Math.PI + 0.5); ctx.stroke();
      ctx.strokeStyle = 'rgba(0,0,0,0.25)'; ctx.lineWidth = 1.5;
      for (const off of [-0.5, 0, 0.5]) {
        ctx.beginPath(); ctx.moveTo(o.x + off * r, o.y - r * 0.86); ctx.lineTo(o.x + off * r, o.y + r * 0.86); ctx.stroke();
      }
      ctx.fillStyle = '#ffcf3f';
      ctx.beginPath(); ctx.arc(o.x, o.y, 5.5, 0, 7); ctx.fill();
      ctx.strokeStyle = '#7a4d00'; ctx.lineWidth = 1.5; ctx.stroke();
    } else if (o.type === 'bush') {
      const r = o.r;
      ctx.fillStyle = 'rgba(0,0,0,0.15)';
      ctx.beginPath(); ctx.ellipse(o.x, o.y + r * 0.7, r, r * 0.3, 0, 0, 7); ctx.fill();
      const puffs = [[0, 0, 1, '#2f7a24'], [-0.5, 0.1, 0.66, '#35902b'], [0.5, 0.1, 0.66, '#2a6c20'], [-0.22, -0.35, 0.6, '#3f9c33'], [0.25, -0.3, 0.55, '#46a838']];
      for (const [ox, oy, s, c] of puffs) {
        ctx.fillStyle = c;
        ctx.beginPath(); ctx.arc(o.x + ox * r, o.y + oy * r, r * s * 0.55, 0, 7); ctx.fill();
      }
    } else if (o.type === 'wall') {
      const wg = ctx.createLinearGradient(o.x, o.y, o.x, o.y + o.h);
      wg.addColorStop(0, '#d4ab72'); wg.addColorStop(1, '#a87f4e');
      ctx.fillStyle = wg;
      ctx.fillRect(o.x, o.y, o.w, o.h);
      // plank seams
      ctx.strokeStyle = 'rgba(107,74,38,0.55)'; ctx.lineWidth = 1.5;
      ctx.beginPath();
      if (o.w > o.h) { for (let py = o.y + 14; py < o.y + o.h; py += 14) { ctx.moveTo(o.x, py); ctx.lineTo(o.x + o.w, py); } }
      else { for (let px = o.x + 14; px < o.x + o.w; px += 14) { ctx.moveTo(px, o.y); ctx.lineTo(px, o.y + o.h); } }
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      ctx.fillRect(o.x, o.y, o.w, 4);
      ctx.strokeStyle = '#6b4a26'; ctx.lineWidth = 2;
      ctx.strokeRect(o.x, o.y, o.w, o.h);
      // posts
      ctx.fillStyle = '#8a5a2b';
      ctx.fillRect(o.x - 5, o.y - 5, 12, 12);
    }
  }

  // distinct gun silhouettes, drawn facing +x from the hands (origin ≈ grip)
  drawGunModel(gun, rarColor, L) {
    const { ctx } = this;
    const body = '#41414a', dark = '#202027', wood = '#8a5a28', woodD = '#5e3a15', steel = '#9aa0ad';
    ctx.lineWidth = 1.6; ctx.strokeStyle = '#141419';
    const R = (x, y, w, h, fill) => { ctx.fillStyle = fill || body; ctx.fillRect(x, y, w, h); ctx.strokeRect(x, y, w, h); };
    const tip = (x, w = 8, h = 9) => { ctx.fillStyle = rarColor; ctx.fillRect(x, -h / 2, w, h); ctx.strokeRect(x, -h / 2, w, h); };
    const shine = (x, y, w) => { ctx.fillStyle = 'rgba(255,255,255,0.28)'; ctx.fillRect(x, y, w, 1.6); };
    switch (gun) {
      case 'pistol':
        R(10, -4, L * 0.62, 8); shine(10, -3, L * 0.62);
        R(13, 3, 7, 11, wood);
        R(10 + L * 0.62 - 2, -3, 6, 6, dark);
        tip(10 + L * 0.62 - 2, 6); break;
      case 'revolver':
        R(10, -3.5, L * 0.55, 7); shine(10, -2.5, L * 0.55);
        ctx.fillStyle = steel; ctx.beginPath(); ctx.arc(22, 0, 6.5, 0, 7); ctx.fill(); ctx.stroke();
        ctx.fillStyle = dark; ctx.beginPath(); ctx.arc(22, 0, 2.4, 0, 7); ctx.fill();
        R(13, 4, 7, 11, wood);
        tip(10 + L * 0.55 - 2, 6); break;
      case 'smg':
        R(1, -3, 10, 6, woodD);
        R(10, -4.5, L * 0.6, 9); shine(10, -3.5, L * 0.6);
        ctx.save(); ctx.translate(24, 3); ctx.rotate(0.18); ctx.fillStyle = dark; ctx.fillRect(-3, 0, 7, 12); ctx.strokeRect(-3, 0, 7, 12); ctx.restore();
        R(14, -8, 5, 4, dark);
        tip(10 + L * 0.6 - 2); break;
      case 'shotgun':
        R(10, -5, L * 0.72, 4.5, steel); R(10, 0.5, L * 0.72, 4.5, steel);
        R(15, -6, 13, 12, wood); shine(15, -5, 13);
        R(2, -4, 9, 8, woodD);
        ctx.fillStyle = rarColor; ctx.fillRect(10 + L * 0.72 - 3, -5, 7, 10); ctx.strokeRect(10 + L * 0.72 - 3, -5, 7, 10); break;
      case 'ar': case 'burst': {
        const long = L * 0.78;
        R(0, -4, 11, 8, woodD);
        R(10, -3.5, long, 7); shine(10, -2.5, long);
        ctx.save(); ctx.translate(26, 3); ctx.rotate(0.35); ctx.fillStyle = dark; ctx.fillRect(-3, 0, 7, 13); ctx.strokeRect(-3, 0, 7, 13); ctx.restore();
        R(19, -9, 8, 6, dark);
        ctx.fillStyle = gun === 'burst' ? rarColor : '#7CFC00';
        ctx.beginPath(); ctx.arc(23, -6, 2, 0, 7); ctx.fill();
        tip(10 + long - 2); break;
      }
      case 'lmg':
        R(0, -4, 10, 8, woodD);
        R(8, -5.5, L * 0.6, 11); shine(8, -4.5, L * 0.6);
        ctx.fillStyle = dark; ctx.beginPath(); ctx.arc(25, 5, 8, 0, 7); ctx.fill(); ctx.stroke();
        ctx.fillStyle = steel; ctx.beginPath(); ctx.arc(25, 5, 3, 0, 7); ctx.fill();
        R(30, 8, 4, 8, dark);
        tip(8 + L * 0.6 - 2); break;
      case 'minigun':
        R(0, -3, 8, 10, woodD);
        R(5, -8, 15, 16, dark);
        ctx.fillStyle = '#c33'; ctx.beginPath(); ctx.arc(12.5, 0, 3, 0, 7); ctx.fill();
        ctx.fillStyle = steel;
        for (const oy of [-6.5, -1.8, 2.8]) { ctx.fillRect(13, oy, L * 0.68, 4); ctx.strokeRect(13, oy, L * 0.68, 4); }
        shine(13, -5.5, L * 0.68);
        tip(13 + L * 0.68 - 2, 10, 11); break;
      case 'scout': case 'sniper': {
        const long = gun === 'sniper';
        const bl = L * (long ? 0.95 : 0.85);
        R(2, -4, 10, 8, wood);
        R(8, -2.5, bl, 5, steel); shine(8, -1.8, bl);
        R(17, -9.5, 11, 5.5, dark);
        R(20, -4, 2, 3, dark); R(26, -4, 2, 3, dark);
        ctx.fillStyle = '#bfe9ff'; ctx.fillRect(18.5, -8.5, 8, 3);
        if (long) { R(8 + bl - 14, -4, 10, 2.5, dark); }
        tip(8 + bl - 2, 6); break;
      }
      case 'crossbow':
        R(8, -3, L * 0.6, 6, wood); shine(8, -2, L * 0.6);
        ctx.strokeStyle = woodD; ctx.lineWidth = 5;
        ctx.beginPath(); ctx.moveTo(10 + L * 0.42, -14); ctx.quadraticCurveTo(10 + L * 0.64, 0, 10 + L * 0.42, 14); ctx.stroke();
        ctx.strokeStyle = '#e8e8e8'; ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.moveTo(10 + L * 0.42, -14); ctx.lineTo(15, 0); ctx.lineTo(10 + L * 0.42, 14); ctx.stroke();
        ctx.fillStyle = steel; ctx.fillRect(11, -1.5, L * 0.58, 3);
        ctx.fillStyle = rarColor;
        ctx.beginPath(); ctx.moveTo(11 + L * 0.58 + 5, 0); ctx.lineTo(11 + L * 0.58 - 1, -3); ctx.lineTo(11 + L * 0.58 - 1, 3); ctx.closePath(); ctx.fill();
        break;
      case 'grenade':
        R(10, -6, L * 0.55, 12); shine(10, -5, L * 0.55);
        ctx.fillStyle = dark; ctx.beginPath(); ctx.arc(26, 8, 7.5, 0, 7); ctx.fill(); ctx.stroke();
        ctx.fillStyle = wood; ctx.fillRect(12, 5, 7, 10); ctx.strokeRect(12, 5, 7, 10);
        R(10 + L * 0.55 - 2, -7, 10, 14, dark);
        tip(10 + L * 0.55 - 2, 10, 14); break;
      default:
        R(10, -4, L * 0.7, 8);
        tip(10 + L * 0.7 - 2); break;
    }
    ctx.lineWidth = 1; ctx.strokeStyle = '#000';
  }

  // cached data-URL icon for HUD slots — rendered once per gun+rarity
  gunIcon(gun, rarity) {
    this._iconCache = this._iconCache || {};
    const k = gun + ':' + rarity;
    if (this._iconCache[k]) return this._iconCache[k];
    const c = document.createElement('canvas');
    c.width = 64; c.height = 40;
    const g2 = c.getContext('2d');
    const real = this.ctx;
    this.ctx = g2;
    try {
      g2.translate(6, 22); g2.scale(1.05, 1.05);
      this.drawGunModel(gun, (RARITIES[rarity] || RARITIES[0]).color, WEAPONS[gun].len);
    } catch { /* headless — no canvas */ }
    this.ctx = real;
    let url = '';
    try { url = c.toDataURL(); } catch { }
    this._iconCache[k] = url;
    return url;
  }

  drawPlayer(p) {
    const { ctx } = this;
    const isMe = p === this.local;
    // shadow
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath(); ctx.ellipse(p.x, p.y + 16, 18, 7, 0, 0, 7); ctx.fill();
    // body
    const scale = p.chute > 0 ? 1 + p.chute * 0.06 : 1;
    ctx.save(); ctx.translate(p.x, p.y); ctx.scale(scale, scale);
    // parachute canopy while descending — no shooting until landing
    if (p.chute > 0) {
      const cw = 30 + p.chute * 7;
      ctx.strokeStyle = '#7a1f1f'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(-cw + 4, -36); ctx.lineTo(-8, -6); ctx.moveTo(cw - 4, -36); ctx.lineTo(8, -6); ctx.stroke();
      ctx.fillStyle = '#e14b4b';
      ctx.beginPath(); ctx.ellipse(0, -38, cw, cw * 0.45, 0, Math.PI, 0); ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.ellipse(0, -38, cw * 0.38, cw * 0.45, 0, Math.PI, 0); ctx.fill();
    }
    // hands + gun
    const ga = Math.atan2(p.aimY - p.y, p.aimX - p.x);
    const slot = p.slots[p.slotI];
    const wlen = slot ? (WEAPONS[slot.gun].len || 26) : 22;
    ctx.save(); ctx.rotate(ga);
    if (slot && slot.gun !== 'fists') this.drawGunModel(slot.gun, RARITIES[slot.rarity || 0].color, wlen);
    // hands
    ctx.fillStyle = '#f2c89b';
    ctx.beginPath(); ctx.arc(12, -8, 7, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.arc(12, 8, 7, 0, 7); ctx.fill();
    ctx.strokeStyle = 'rgba(120,70,30,0.5)'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(12, -8, 7, 0, 7); ctx.stroke();
    ctx.beginPath(); ctx.arc(12, 8, 7, 0, 7); ctx.stroke();
    ctx.restore();
    // body circle with soft gradient
    const bg2 = ctx.createRadialGradient(-6, -8, 4, 0, 0, p.r + 2);
    bg2.addColorStop(0, '#ffffff55');
    bg2.addColorStop(0.35, p.color);
    bg2.addColorStop(1, 'rgba(0,0,0,0.28)');
    ctx.fillStyle = bg2;
    ctx.beginPath(); ctx.arc(0, 0, p.r, 0, 7); ctx.fill();
    ctx.lineWidth = isMe ? 4 : 3; ctx.strokeStyle = isMe ? '#ffd23f' : 'rgba(0,0,0,0.45)';
    ctx.stroke();
    // eyes look toward aim
    const ex = Math.cos(ga), ey = Math.sin(ga);
    const px2 = -ey, py2 = ex;
    for (const s of [-1, 1]) {
      const cxp = ex * 9 + px2 * 7 * s, cyp = ey * 9 + py2 * 7 * s;
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(cxp, cyp, 5.5, 0, 7); ctx.fill();
      ctx.fillStyle = '#1a1a1a';
      ctx.beginPath(); ctx.arc(cxp + ex * 2, cyp + ey * 2, 2.6, 0, 7); ctx.fill();
    }
    // shield ring
    if (p.shield > 0) {
      ctx.strokeStyle = 'rgba(74,210,255,0.9)'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(0, 0, p.r + 4, 0, 7); ctx.stroke();
    }
    // healing / reload arc
    if (p.healing) {
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.arc(0, 0, p.r + 8, -1.57, -1.57 + 6.28 * (1 - p.healing.t / 3)); ctx.stroke();
    } else if (p.reloadT > 0) {
      ctx.strokeStyle = '#ffd23f'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(0, 0, p.r + 8, -1.57, -1.57 + 6.28 * 0.5); ctx.stroke();
    }
    ctx.restore();
    // name + hp
    ctx.textAlign = 'center';
    ctx.font = 'bold 13px sans-serif';
    ctx.fillStyle = '#fff'; ctx.strokeStyle = '#000'; ctx.lineWidth = 3;
    ctx.strokeText(p.name, p.x, p.y - 30);
    ctx.fillText(p.name, p.x, p.y - 30);
    const w = 56;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    roundRect(ctx, p.x - w / 2, p.y - 27, w, 7, 3); ctx.fill();
    ctx.fillStyle = p.hp > 50 ? '#6dff5d' : p.hp > 25 ? '#ffd23f' : '#ff5555';
    ctx.fillRect(p.x - w / 2, p.y - 27, w * clamp(p.hp / 100, 0, 1), 7);
  }

  drawDropping(p) {
    const { ctx } = this;
    ctx.fillStyle = '#4a90e2';
    ctx.beginPath(); ctx.arc(p.x, p.y - 24, 22, 3.14, 0); ctx.fill();
    ctx.strokeStyle = '#234a7a'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(p.x - 22, p.y - 24); ctx.lineTo(p.x, p.y); ctx.moveTo(p.x + 22, p.y - 24); ctx.lineTo(p.x, p.y); ctx.stroke();
    this.drawPlayer({ ...p, dropping: false, chute: 0 });
    ctx.fillStyle = '#fff'; ctx.font = 'bold 12px sans-serif'; ctx.textAlign = 'center';
    if (p === this.local) ctx.fillText('SPACE / F to drop!', p.x, p.y - 52);
  }

  drawMinimap() {
    if (!this.mctx) return;
    const c = this.mctx, S = this.mm.width;
    c.clearRect(0, 0, S, S);
    c.fillStyle = '#7ab648'; c.fillRect(0, 0, S, S);
    const k = S / WORLD_SIZE;
    // gas
    if (this.gas) {
      c.fillStyle = 'rgba(150,40,200,0.5)';
      c.fillRect(0, 0, S, S);
      c.fillStyle = '#7ab648';
      c.beginPath(); c.arc(this.gas.x * k, this.gas.y * k, this.gas.r * k, 0, 7); c.fill();
      c.strokeStyle = '#fff'; c.lineWidth = 1.5;
      c.beginPath(); c.arc(this.gas.tx * k, this.gas.ty * k, this.gas.tr * k, 0, 7); c.stroke();
    }
    c.fillStyle = '#ff4444';
    for (const p of this.players) {
      if (p.dead) continue;
      if (p === this.local) continue;
      c.fillRect(p.x * k - 1, p.y * k - 1, 2, 2);
    }
    if (this.local) {
      c.fillStyle = '#ffd23f';
      c.beginPath(); c.arc(this.local.x * k, this.local.y * k, 4, 0, 7); c.fill();
      c.strokeStyle = '#000'; c.stroke();
    }
  }

  drawBigMap() {
    const { ctx, cv } = this;
    const S = Math.min(cv.width, cv.height) * 0.7;
    const x0 = (cv.width - S) / 2, y0 = (cv.height - S) / 2;
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(x0, y0, S, S);
    const k = S / WORLD_SIZE;
    ctx.strokeStyle = '#fff';
    ctx.strokeRect(x0, y0, S, S);
    if (this.gas) {
      ctx.fillStyle = 'rgba(150,40,200,0.5)';
      ctx.fillRect(x0, y0, S, S);
      ctx.fillStyle = '#7ab648';
      ctx.beginPath(); ctx.arc(x0 + this.gas.x * k, y0 + this.gas.y * k, this.gas.r * k, 0, 7); ctx.fill();
    }
    ctx.fillStyle = '#ffd23f';
    if (this.local) { ctx.beginPath(); ctx.arc(x0 + this.local.x * k, y0 + this.local.y * k, 5, 0, 7); ctx.fill(); }
    ctx.restore();
  }
}

function lerp(a, b, t) { return a + (b - a) * t; }
function angDiff(a, b) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
function distRect(px, py, r) {
  const nx = clamp(px, r.x, r.x + r.w), ny = clamp(py, r.y, r.y + r.h);
  return Math.hypot(px - nx, py - ny);
}
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function esc(s) { return String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])); }
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; }
