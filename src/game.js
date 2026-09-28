import { WORLD_SIZE, WEAPONS, RARITIES, GAS_PHASES, BOT_NAMES, BOT_CHATS, rand, randi, pick, clamp, dist2, angleLerp } from './config.js';
import { generateWorld } from './world.js';
import { makeBotController } from './bots.js';
import { sfx } from './audio.js';

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
      this.keys[e.key.toLowerCase()] = true;
      if ([' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(e.key.toLowerCase())) e.preventDefault();
      if (!this.local || this.local.dead) return;
      const k = e.key.toLowerCase();
      if (k === 'e') this.tryPickupNearest(this.local);
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
  start({ name = 'Prodigy', mode = 'solo', botCount = 70, seed = (Math.random() * 1e9) | 0, net = null, isRemote = false, teamId = null }) {
    this.stop();
    this.mode = mode; this.net = net; this.isRemote = isRemote;
    const w = generateWorld(seed);
    this.seed = seed;
    this.obstacles = w.obstacles; this.loot = w.loot; this.ponds = w.ponds; this.roads = w.roads;
    this.players = []; this.bullets = []; this.particles = []; this.floatChats = [];
    this.time = 0; this.takenIds.clear();
    this._won = false; this.killfeed = [];
    this.pidMap = new Map();

    // gas init: full map → first target
    this.gas = {
      x: WORLD_SIZE / 2, y: WORLD_SIZE / 2, r: WORLD_SIZE * 0.72,
      tx: WORLD_SIZE / 2, ty: WORLD_SIZE / 2, tr: WORLD_SIZE * 0.45,
      fx: WORLD_SIZE / 2, fy: WORLD_SIZE / 2, fr: WORLD_SIZE * 0.72,
      phase: 0, state: 'waiting', t: GAS_PHASES[0].wait, dps: 0,
    };
    this._nextGasTarget();

    // plane path across map
    const a = Math.random() * Math.PI * 2;
    const cx = WORLD_SIZE / 2, cy = WORLD_SIZE / 2, L = WORLD_SIZE * 0.75;
    this.plane = {
      x: cx - Math.cos(a) * L, y: cy - Math.sin(a) * L,
      dx: Math.cos(a), dy: Math.sin(a), speed: 420, active: true, t: 0,
      ex: cx + Math.cos(a) * L, ey: cy + Math.sin(a) * L,
    };

    // teams
    const names = shuffle([...BOT_NAMES]).slice(0, botCount + 8);
    let ni = 0;
    const mkName = (preferred) => preferred && preferred.trim() ? preferred.trim().slice(0, 14) : (names[ni++] || 'bot' + ni);

    if (!isRemote) {
      this.local = this._mkPlayer(mkName(name), false, teamId || 't-local');
      this.local.x = this.plane.x; this.local.y = this.plane.y; this.local.dropping = true;
      this.players.push(this.local);
      // offline teammates for duo/squad
      const mateCount = mode === 'duo' ? 1 : mode === 'squad' ? 3 : 0;
      for (let i = 0; i < mateCount; i++) {
        const m = this._mkPlayer(names[ni++] || ('mate' + i), true, 't-local');
        m.x = this.plane.x; m.y = this.plane.y; m.dropping = true;
        m.skill = rand(0.55, 0.85);
        this.players.push(m);
        this.botControllers.set(m.id, makeBotController(m, this));
      }
      for (let i = 0; i < botCount; i++) {
        const b = this._mkPlayer(names[ni++] || ('bot' + i), true, 't-' + i);
        b.x = this.plane.x; b.y = this.plane.y; b.dropping = true;
        b.skill = rand(0.25, 0.9);
        // give a few bots better landing loot luck via drop timing
        b.dropAt = rand(1.5, 9);
        this.players.push(b);
        this.botControllers.set(b.id, makeBotController(b, this));
      }
      this.centerMsg('Jump with SPACE / F!', 3);
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
      kills: 0, dropping: false, dropAnim: 0, reloadT: 0, shootCd: 0, healing: null,
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
    if (!p.dropping) return;
    p.dropping = false; p.dropAnim = 1.4;
    // scatter landing a bit
    p.x += rand(-40, 40); p.y += rand(-40, 40);
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
    if (!l || l.taken || p.dead) return false;
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
        if (p.isBot || Math.random() < 0.6) { p.slotI = idx; p.gun = l.weapon; }
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

  damage(target, dmg, attacker) {
    if (target.dead) return;
    target.lastDmgFrom = attacker;
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
      // crates drop loot
      if (o.type === 'crate' || o.type === 'barrel') {
        const cx = o.x, cy = o.y;
        const roll = Math.random();
        if (roll < 0.45) {
          const w = pick(['pistol', 'smg', 'shotgun', 'ar', 'burst', 'sniper', 'lmg']);
          this.loot.push({ id: 900000 + ((Math.random() * 1e6) | 0), kind: 'weapon', weapon: w, rarity: randi(0, 4), x: cx + rand(-20, 20), y: cy + rand(-20, 20) });
        } else if (roll < 0.7) this.loot.push({ id: 900000 + ((Math.random() * 1e6) | 0), kind: 'heal', heal: pick(['bandage', 'bandage', 'medkit', 'shield']), x: cx, y: cy });
        else this.loot.push({ id: 900000 + ((Math.random() * 1e6) | 0), kind: 'ammo', ammo: pick(['light', 'medium', 'shell', 'heavy']), amount: 20, x: cx, y: cy });
      }
    }
  }

  kill(victim, killer) {
    if (victim.dead) return;
    victim.dead = true; victim.hp = 0;
    // drop loot
    for (const s of victim.slots) {
      if (s && s.gun !== 'fists') this.loot.push({ id: 800000 + ((Math.random() * 1e6) | 0), kind: 'weapon', weapon: s.gun, rarity: s.rarity || 0, x: victim.x + rand(-30, 30), y: victim.y + rand(-30, 30) });
    }
    if (victim.heals.bandage > 0) this.loot.push({ id: 800000 + ((Math.random() * 1e6) | 0), kind: 'heal', heal: 'bandage', x: victim.x + 20, y: victim.y });
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

  // ---------- per-frame ----------
  update(dt) {
    this.time += dt;
    // plane
    const pl = this.plane;
    if (pl.active) {
      pl.t += dt;
      pl.x += pl.dx * pl.speed * dt; pl.y += pl.dy * pl.speed * dt;
      for (const p of this.players) if (p.dropping) { p.x = pl.x; p.y = pl.y; }
      // auto-drop bots over time
      for (const p of this.players) {
        if (!p.dropping || p === this.local) continue;
        if ((p.dropAt !== undefined && pl.t > p.dropAt) || Math.hypot(pl.x - WORLD_SIZE / 2, pl.y - WORLD_SIZE / 2) < 500 || pl.t > 11) {
          p.dropping = false; p.dropAnim = 1.4;
          p.x += rand(-30, 30); p.y += rand(-30, 30);
          p.x = clamp(p.x, 60, WORLD_SIZE - 60); p.y = clamp(p.y, 60, WORLD_SIZE - 60);
        }
      }
      if (pl.t > 14 || Math.hypot(pl.x - pl.ex, pl.y - pl.ey) < 60) {
        pl.active = false;
        for (const p of this.players) if (p.dropping) { p.dropping = false; p.dropAnim = 1.2; }
      }
    }

    // gas
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
      if (p.dropAnim > 0) p.dropAnim -= dt;
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
      let sp = p.speed * (p.healing ? 0.45 : 1) * (slot && WEAPONS[slot.gun].len > 36 ? 0.94 : 1);
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
      if (this.isOutsideGas(p.x, p.y) && g.dps > 0) {
        p.hp -= g.dps * dt;
        p.lastDmgFrom = null;
        if (p.hp <= 0) this.kill(p, p.lastDmgFrom);
      }
      if (p.input.shoot) this.fire(p);
      // bot auto pickup + reload + heal key
      if (p.isBot) {
        const l = this.nearestLoot(p, 55);
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
      if (!dead && this.hitObstacle(b.x, b.y)) {
        const o = this.hitObstacle(b.x, b.y);
        this.damageObstacle(o, b.dmg, this.players.find((p) => p.id === b.from));
        this.particles.push({ x: b.x, y: b.y, vx: 0, vy: 0, t: 0.12, max: 0.12, c: '#fff', r: 3 });
        dead = true;
      }
      if (!dead) {
        for (const p of this.players) {
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
    if (L) {
      const zoom = this.baseZoom * (L.dropAnim > 0 ? 0.7 : 1);
      this.cam.zoom = lerp(this.cam.zoom || zoom, zoom, Math.min(1, dt * 4));
      this.cam.x = lerp(this.cam.x, L.x - this.cv.width / this.cam.zoom / 2, Math.min(1, dt * 8));
      this.cam.y = lerp(this.cam.y, L.y - this.cv.height / this.cam.zoom / 2, Math.min(1, dt * 8));
    }

    // HUD + net
    this.snapT -= dt;
    if (this.onHud && L) {
      const alive = this.players.filter((p) => !p.dead).length;
      const ph2 = GAS_PHASES[Math.min(this.gas.phase, GAS_PHASES.length - 1)];
      const zt = this.gas.state === 'waiting' ? `Starting in ${Math.ceil(this.gas.t)}` : `Shrinking! ${Math.ceil(this.gas.t)}s`;
      this.onHud({
        hp: L.hp, shield: L.shield, ammo: L.slots[L.slotI], reserve: L.ammo,
        heals: L.heals, slots: L.slots, slotI: L.slotI, alive, kills: L.kills,
        zone: zt, dropping: L.dropping, reloading: L.reloadT > 0, healing: L.healing,
        interact: this.nearestLoot(L, 80),
      });
    }
    if (this.net && this.net.isHost && this.snapT <= 0) {
      this.snapT = 1 / 12;
      this.net.broadcastSnap(this.snapshot());
    }
  }

  snapshot() {
    return {
      seed: this.seed,
      t: this.time,
      gas: this.gas,
      players: this.players.map((p) => ({ id: p.id, name: p.name, x: p.x | 0, y: p.y | 0, hp: p.hp | 0, shield: p.shield | 0, gun: p.gun, rarity: p.slots[p.slotI]?.rarity || 0, face: +p.faceAngle.toFixed(2), dead: p.dead, dropping: p.dropping, team: p.team, kills: p.kills })),
      bullets: this.bullets.slice(-60).map((b) => ({ x: b.x | 0, y: b.y | 0, vx: b.vx | 0, vy: b.vy | 0 })),
      taken: [...this.takenIds].slice(-500),
    };
  }

  applySnapshot(s) {
    this.remoteSnap = s;
    if (s.gas) this.gas = s.gas;
    // mark taken loot
    if (s.taken) for (const id of s.taken) {
      const l = this.loot.find((x) => x.id === id);
      if (l) l.taken = true;
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
      p.x = sp.x; p.y = sp.y; p.hp = sp.hp; p.shield = sp.shield; p.gun = sp.gun;
      p.faceAngle = sp.face; p.dead = sp.dead; p.dropping = sp.dropping; p.kills = sp.kills;
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
      this.net.sendInput({ mx, my, shoot: this.mouse.down, ax: wx | 0, ay: wy | 0 }, { name: this.local.name });
    }
    for (let i = this.particles.length - 1; i >= 0; i--) { this.particles[i].t -= dt; if (this.particles[i].t <= 0) this.particles.splice(i, 1); }
    if (this.onHud) {
      const alive = this.players.filter((p) => !p.dead).length;
      this.onHud({ hp: 100, shield: 0, slots: [], slotI: 0, alive, kills: 0, zone: 'Online', remote: true });
    }
  }

  inPond(x, y) {
    if (!this.ponds) return false;
    for (const p of this.ponds) if (dist2(x, y, p.x, p.y) < p.r * p.r) return true;
    return false;
  }

  hitObstacle(x, y) {
    // check walls first (rects), then circles — only solid & alive
    for (const o of this.obstacles) {
      if (o.destroyed) continue;
      if (o.type === 'wall') {
        if (x > o.x && x < o.x + o.w && y > o.y && y < o.y + o.h) return o;
      } else if (o.solid !== false && o.r) {
        if (dist2(x, y, o.x, o.y) < o.r * o.r) return o;
      }
    }
    return null;
  }

  collide(p) {
    for (const o of this.obstacles) {
      if (o.destroyed || o.solid === false) continue;
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

    // obstacles
    for (const o of this.obstacles) {
      if (o.destroyed) continue;
      const ox = o.x + (o.w || 0) / 2, oy = o.y + (o.h || 0) / 2;
      if (ox < vx0 || ox > vx1 || oy < vy0 || oy > vy1) continue;
      this.drawObstacle(o);
    }

    // bullets
    ctx.lineCap = 'round';
    for (const b of this.bullets) {
      ctx.strokeStyle = '#fff8';
      ctx.lineWidth = 4;
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

    // plane
    if (this.plane && this.plane.active) {
      const pl = this.plane;
      ctx.save(); ctx.translate(pl.x, pl.y); ctx.rotate(Math.atan2(pl.dy, pl.dx));
      ctx.fillStyle = '#4a90e2';
      ctx.beginPath(); ctx.ellipse(0, 0, 70, 26, 0, 0, 7); ctx.fill();
      ctx.fillStyle = '#3570b5';
      ctx.fillRect(-10, -48, 22, 96);
      ctx.fillStyle = '#fff'; ctx.font = 'bold 20px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('22', 0, 7);
      ctx.restore();
    }

    // gas overlay: darken outside circle
    const g = this.gas;
    if (g) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(vx0 - 500, vy0 - 500, (vx1 - vx0) + 1000, (vy1 - vy0) + 1000);
      ctx.arc(g.x, g.y, Math.max(1, g.r), 0, 7, true);
      ctx.fillStyle = 'rgba(150,40,200,0.35)';
      ctx.fill('evenodd');
      // zone lines
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 3; ctx.setLineDash([14, 10]);
      ctx.beginPath(); ctx.arc(g.x, g.y, g.r, 0, 7); ctx.stroke();
      ctx.strokeStyle = '#ffd23f';
      ctx.beginPath(); ctx.arc(g.tx, g.ty, g.tr, 0, 7); ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
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
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.beginPath(); ctx.ellipse(l.x, l.y + 8, 26, 9, 0, 0, 7); ctx.fill();
      ctx.fillStyle = rar.color;
      roundRect(ctx, l.x - 26, l.y - 10, 52, 22, 5); ctx.fill();
      ctx.strokeStyle = '#0008'; ctx.lineWidth = 2; ctx.stroke();
      ctx.fillStyle = '#222'; ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(WEAPONS[l.weapon].name, l.x, l.y + 5);
      ctx.fillStyle = '#111';
      ctx.save(); ctx.translate(l.x, l.y - 16); ctx.rotate(-0.5);
      ctx.fillRect(-16, -3, 32, 6); ctx.restore();
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

  drawObstacle(o) {
    const { ctx } = this;
    if (o.type === 'tree') {
      ctx.fillStyle = 'rgba(0,0,0,0.2)';
      ctx.beginPath(); ctx.ellipse(o.x, o.y + o.r * 0.7, o.r, o.r * 0.35, 0, 0, 7); ctx.fill();
      ctx.fillStyle = '#5a3a1a';
      ctx.beginPath(); ctx.arc(o.x, o.y, o.r * 0.28, 0, 7); ctx.fill();
      ctx.fillStyle = '#2f7a24';
      ctx.beginPath(); ctx.arc(o.x, o.y, o.r, 0, 7); ctx.fill();
      ctx.fillStyle = '#3f9c33';
      ctx.beginPath(); ctx.arc(o.x - o.r * 0.25, o.y - o.r * 0.25, o.r * 0.6, 0, 7); ctx.fill();
    } else if (o.type === 'rock' || o.type === 'rocksmall') {
      ctx.fillStyle = '#7a7a7a';
      ctx.beginPath(); ctx.arc(o.x, o.y, o.r, 0, 7); ctx.fill();
      ctx.fillStyle = '#9a9a9a';
      ctx.beginPath(); ctx.arc(o.x - o.r * 0.2, o.y - o.r * 0.2, o.r * 0.6, 0, 7); ctx.fill();
      ctx.strokeStyle = '#555'; ctx.lineWidth = 2; ctx.stroke();
    } else if (o.type === 'crate') {
      ctx.fillStyle = '#c98f3d';
      roundRect(ctx, o.x - 20, o.y - 20, 40, 40, 4); ctx.fill();
      ctx.strokeStyle = '#7a4d00'; ctx.lineWidth = 3; ctx.stroke();
      ctx.beginPath(); ctx.moveTo(o.x - 20, o.y - 20); ctx.lineTo(o.x + 20, o.y + 20); ctx.moveTo(o.x + 20, o.y - 20); ctx.lineTo(o.x - 20, o.y + 20); ctx.stroke();
    } else if (o.type === 'barrel') {
      ctx.fillStyle = '#b8452e';
      ctx.beginPath(); ctx.arc(o.x, o.y, o.r, 0, 7); ctx.fill();
      ctx.strokeStyle = '#6e2415'; ctx.lineWidth = 3; ctx.stroke();
      ctx.fillStyle = '#ffcf3f';
      ctx.beginPath(); ctx.arc(o.x, o.y, 5, 0, 7); ctx.fill();
    } else if (o.type === 'bush') {
      ctx.fillStyle = 'rgba(47,122,36,0.85)';
      ctx.beginPath(); ctx.arc(o.x, o.y, o.r, 0, 7); ctx.fill();
      ctx.fillStyle = 'rgba(63,156,51,0.9)';
      ctx.beginPath(); ctx.arc(o.x - 6, o.y - 6, o.r * 0.6, 0, 7); ctx.fill();
    } else if (o.type === 'wall') {
      ctx.fillStyle = '#c9a06a';
      ctx.fillRect(o.x, o.y, o.w, o.h);
      ctx.fillStyle = '#a87f4e';
      ctx.fillRect(o.x, o.y, o.w, 5);
      ctx.strokeStyle = '#6b4a26'; ctx.lineWidth = 2;
      ctx.strokeRect(o.x, o.y, o.w, o.h);
      // posts
      ctx.fillStyle = '#8a5a2b';
      ctx.fillRect(o.x - 5, o.y - 5, 12, 12);
    }
  }

  drawPlayer(p) {
    const { ctx } = this;
    const isMe = p === this.local;
    // shadow
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath(); ctx.ellipse(p.x, p.y + 16, 18, 7, 0, 0, 7); ctx.fill();
    // body
    const scale = p.dropAnim > 0 ? 1 + p.dropAnim * 0.8 : 1;
    ctx.save(); ctx.translate(p.x, p.y); ctx.scale(scale, scale);
    // hands + gun
    const ga = Math.atan2(p.aimY - p.y, p.aimX - p.x);
    const slot = p.slots[p.slotI];
    const wlen = slot ? (WEAPONS[slot.gun].len || 26) : 22;
    ctx.save(); ctx.rotate(ga);
    if (slot && slot.gun !== 'fists') {
      ctx.fillStyle = '#333';
      ctx.fillRect(10, -4, wlen, 9);
      ctx.fillStyle = RARITIES[slot.rarity || 0].color;
      ctx.fillRect(10 + wlen - 8, -4, 8, 9);
    }
    // hands
    ctx.fillStyle = '#f2c89b';
    ctx.beginPath(); ctx.arc(12, -8, 7, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.arc(12, 8, 7, 0, 7); ctx.fill();
    ctx.restore();
    // body circle
    ctx.fillStyle = p.color;
    ctx.beginPath(); ctx.arc(0, 0, p.r, 0, 7); ctx.fill();
    ctx.lineWidth = isMe ? 4 : 3; ctx.strokeStyle = isMe ? '#ffd23f' : 'rgba(0,0,0,0.45)';
    ctx.stroke();
    // face direction nub
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath(); ctx.arc(Math.cos(ga) * 10, Math.sin(ga) * 10, 5, 0, 7); ctx.fill();
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
    this.drawPlayer({ ...p, dropping: false, dropAnim: 0 });
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
