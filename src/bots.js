import { WEAPONS, RARITIES, rand, dist2, clamp, angleLerp } from './config.js?v=132';

// Lightweight FSM bot: loot → fight → rotate to zone → heal. Silent (no chat).
export function makeBotController(bot, game) {
  return {
    bot,
    thinkT: Math.random() * 0.5,
    lobbyGoal: null,
    lobbyAct(dt) {
      const g = game, p = this.bot;
      this.thinkT -= dt;
        if (this.thinkT <= 0) {
        this.thinkT = rand(0.6, 1.8);
        this.lobbyGoal = {
          x: rand(g.lobby.x + 60, g.lobby.x + g.lobby.w - 60),
          y: rand(g.lobby.y + 60, g.lobby.y + g.lobby.h - 60),
        };
      }
      const gl = this.lobbyGoal || { x: p.x, y: p.y };
      const a = Math.atan2(gl.y - p.y, gl.x - p.x);
      const go = Math.hypot(gl.x - p.x, gl.y - p.y) > 30 ? 1 : 0;
      p.input.mx = Math.cos(a) * go; p.input.my = Math.sin(a) * go;
      p.input.shoot = false;
      p.faceAngle = angleLerp(p.faceAngle, a, Math.min(1, dt * 8));
      p.aimX = p.x + Math.cos(a) * 100; p.aimY = p.y + Math.sin(a) * 100;
    },
    targetLoot: null,
    wanderA: Math.random() * Math.PI * 2,
    strafeDir: Math.random() < 0.5 ? 1 : -1,
    strafeT: 0,
    panicT: 0,
    update(dt) {
      const g = game;
      const p = bot;
      if (p.dead) return;
      if (g.phase === 'lobby') { this.lobbyAct(dt); return; }
      this.thinkT -= dt;
      this.strafeT -= dt;
      if (this.strafeT <= 0) { this.strafeDir *= -1; this.strafeT = rand(0.5, 1.6); }
      // (bots never chat — silent)

      // Perception
      let enemy = nearestEnemy(g, p, 850);
      // grace period: bots hold fire unless retaliating against their attacker
      if (enemy && g.peaceT > 0) {
        const retaliate = p.lastDmgFrom === enemy && (g.time - (p.lastDmgT || -99)) < 6;
        if (!retaliate) enemy = null;
      }
      const inGas = g.isOutsideGas(p.x, p.y);
      const zone = { x: g.gas.tx, y: g.gas.ty, r: g.gas.tr };
      const zoneD = Math.hypot(p.x - zone.x, p.y - zone.y);

      let mvx = 0, mvy = 0;
      let wantShoot = false;
      let aimX = p.aimX, aimY = p.aimY;

      const hpFrac = p.hp / p.maxHp;

      // Heal logic
      if (hpFrac < 0.45 && (p.heals.bandage > 0 || p.heals.medkit > 0) && (!enemy || dist2(p.x, p.y, enemy.x, enemy.y) > 380 * 380)) {
        p.healing = p.healing || tryHeal(p);
      }

      // unarmed bots run to the nearest chest instead of fist-fighting —
      // but loose guns on the ground come first
      let toChest = null;
      const gunNearby = p.gun === 'fists' && this.targetLoot && this.targetLoot.kind === 'weapon' && !this.targetLoot.taken &&
        dist2(p.x, p.y, this.targetLoot.x, this.targetLoot.y) < 220 * 220;
      if (p.gun === 'fists' && !p.healing && !p.dropping && p.chute <= 0 && !gunNearby) {
        toChest = (this.targetChest && !this.targetChest.opened) ? this.targetChest : (g.nearestChest ? g.nearestChest(p, 3500) : null);
        if (toChest && dist2(p.x, p.y, toChest.x, toChest.y) < 90 * 90) {
          g.openChest(p, toChest);
          this.targetChest = null; toChest = null;
        }
      }
      if (toChest) {
        const ca = Math.atan2(toChest.y - p.y, toChest.x - p.x);
        mvx = Math.cos(ca); mvy = Math.sin(ca);
        aimX = toChest.x; aimY = toChest.y;
        wantShoot = false;
        enemy = null;
      }
      // grace: unarmed bots with no chest in reach flee instead of fist-fighting
      let flee = false;
      if (enemy && g.peaceT > 0 && p.gun === 'fists' && p.lastDmgFrom !== enemy) {
        const fa = Math.atan2(p.y - enemy.y, p.x - enemy.x);
        mvx = Math.cos(fa); mvy = Math.sin(fa);
        aimX = enemy.x; aimY = enemy.y;
        wantShoot = false; flee = true; enemy = null;
      }

      if (enemy && !p.healing) {
        const d = Math.hypot(enemy.x - p.x, enemy.y - p.y);
        const w = WEAPONS[p.gun];
        const ideal = w.range * 0.55;
        // aim with error by skill
        const err = (1.15 - p.skill) * 0.22;
        aimX = enemy.x + rand(-1, 1) * err * d * 0.35 + (enemy.vx || 0) * (d / (w.speed || 1200)) * 0.8 * p.skill;
        aimY = enemy.y + rand(-1, 1) * err * d * 0.35 + (enemy.vy || 0) * (d / (w.speed || 1200)) * 0.8 * p.skill;
        if (d < w.range * 1.05) wantShoot = Math.random() < (0.55 + p.skill * 0.45);
        // movement: keep distance + strafe + zone pull
        const a = Math.atan2(p.y - enemy.y, p.x - enemy.x);
        let radial = 0;
        if (d < ideal * 0.7) radial = 1; else if (d > ideal * 1.3) radial = -1;
        mvx = Math.cos(a) * radial + Math.cos(a + Math.PI / 2) * this.strafeDir * 0.9;
        mvy = Math.sin(a) * radial + Math.sin(a + Math.PI / 2) * this.strafeDir * 0.9;
        if (zoneD > zone.r * 0.9) { mvx += (zone.x - p.x) / zoneD * 1.2; mvy += (zone.y - p.y) / zoneD * 1.2; }
        if (inGas) { mvx += (zone.x - p.x) / Math.max(1, zoneD) * 2; mvy += (zone.y - p.y) / Math.max(1, zoneD) * 2; }
        if (hpFrac < 0.3) { mvx = Math.cos(a) * 1.2; mvy = Math.sin(a) * 1.2; wantShoot = wantShoot && Math.random() < 0.4; }
      } else {
        // No enemy: loot or rotate
        if (this.thinkT <= 0) {
          this.thinkT = rand(0.4, 1.0);
          this.targetLoot = nearestLoot(g, p, 900);
          // guns only come from chests — unarmed bots look far, armed bots detour nearby
          this.targetChest = g.nearestChest ? g.nearestChest(p, p.gun === 'fists' ? 3500 : 1000) : null;
          this.wanderA = Math.random() * Math.PI * 2;
        }
        if (toChest || flee) { /* movement already set above — chest run or grace flee */ }
        else if (p.healing) { /* stand still-ish */ mvx = 0; mvy = 0; }
        else if (inGas || zoneD > zone.r * 0.85) {
          const a = Math.atan2(zone.y - p.y, zone.x - p.x);
          mvx = Math.cos(a); mvy = Math.sin(a);
          aimX = p.x + Math.cos(a) * 100; aimY = p.y + Math.sin(a) * 100;
        } else if (!gunNearby && this.targetChest && !this.targetChest.opened && dist2(p.x, p.y, this.targetChest.x, this.targetChest.y) < 800 * 800) {
          // detour for a chest upgrade
          const c = this.targetChest;
          const a = Math.atan2(c.y - p.y, c.x - p.x);
          mvx = Math.cos(a); mvy = Math.sin(a);
          aimX = c.x; aimY = c.y;
          if (dist2(p.x, p.y, c.x, c.y) < 90 * 90) {
            g.openChest(p, c);
            this.targetChest = null;
          }
        } else if (this.targetLoot && !this.targetLoot.taken) {
          const a = Math.atan2(this.targetLoot.y - p.y, this.targetLoot.x - p.x);
          mvx = Math.cos(a); mvy = Math.sin(a);
          aimX = this.targetLoot.x; aimY = this.targetLoot.y;
          if (dist2(p.x, p.y, this.targetLoot.x, this.targetLoot.y) < 60 * 60) {
            g.tryPickup(p, this.targetLoot);
            this.targetLoot = null;
          }
        } else {
          mvx = Math.cos(this.wanderA) * 0.7; mvy = Math.sin(this.wanderA) * 0.7;
          // drift toward zone center slowly
          mvx += (zone.x - p.x) / S(zoneD) * 0.3; mvy += (zone.y - p.y) / S(zoneD) * 0.3;
          aimX = p.x + Math.cos(this.wanderA) * 120; aimY = p.y + Math.sin(this.wanderA) * 120;
        }
        // opportunistic crate shooting (not during grace — stray shots start wars)
        const crate = nearestBreakable(g, p, 420);
        if (crate && hasDecentGun(p) && g.peaceT <= 0) {
          aimX = crate.x; aimY = crate.y; wantShoot = true;
        }
      }

      const n = Math.hypot(mvx, mvy) || 1;
      const sp = p.speed * (p.healing ? 0.4 : 1) * clamp(1.15 - hpFrac * 0.15, 0.85, 1.1);
      p.input.mx = mvx / n * (Math.hypot(mvx, mvy) > 0.05 ? 1 : 0);
      p.input.my = mvy / n * (Math.hypot(mvx, mvy) > 0.05 ? 1 : 0);
      p.input.shoot = wantShoot;
      // anti-wedge: barely moving despite input → sidestep for a second
      if (!p.dropping) {
        const moved = Math.hypot(p.x - (this.lastX ?? p.x), p.y - (this.lastY ?? p.y));
        this.lastX = p.x; this.lastY = p.y;
        const want = Math.hypot(p.input.mx, p.input.my);
        if (want > 0.3 && moved < dt * 30) this.stuckAcc = (this.stuckAcc || 0) + dt;
        else this.stuckAcc = 0;
        if ((this.stuckAcc || 0) > 0.6) {
          this.stuckAcc = 0; this.detourT = 1.1;
          this.detourDir = (this.detourDir || 1) * -1;
        }
        if ((this.detourT || 0) > 0) {
          this.detourT -= dt;
          const ia = Math.atan2(p.input.my, p.input.mx) + this.detourDir * 1.8;
          p.input.mx = Math.cos(ia) * want; p.input.my = Math.sin(ia) * want;
        }
      }
      p.aimX = aimX; p.aimY = aimY;
      p.faceAngle = angleLerp(p.faceAngle, Math.atan2(aimY - p.y, aimX - p.x), Math.min(1, dt * 12));
    }
  };
}
function S(d) { return Math.max(1, d); }

function nearestEnemy(g, p, maxD) {
  let best = null, bd = maxD * maxD;
  for (const q of g.players) {
    if (q === p || q.dead || q.dropping) continue;
    if (q.team && p.team && q.team === p.team) continue;
    const d2 = dist2(p.x, p.y, q.x, q.y);
    if (d2 < bd) { bd = d2; best = q; }
  }
  return best;
}
function nearestLoot(g, p, maxD) {
  let best = null, bd = maxD * maxD, bs = -1;
  for (const l of g.loot) {
    if (l.taken) continue;
    const d2 = dist2(p.x, p.y, l.x, l.y);
    if (d2 > bd) continue;
    const score = lootScore(p, l) - Math.sqrt(d2) * 0.01;
    if (score > bs) { bs = score; best = l; }
  }
  return bs > 0.1 ? best : null;
}
function lootScore(p, l) {
  if (l.kind === 'weapon') {
    const cur = WEAPON_RANK[p.gun] ?? 0;
    const nw = (WEAPON_RANK[l.weapon] ?? 0) + l.rarity * 0.35;
    return nw > cur ? (nw - cur + 0.6) : 0;
  }
  if (l.kind === 'heal') {
    if (l.heal === 'bandage' && p.heals.bandage < 5) return 0.5;
    if (l.heal === 'medkit' && p.heals.medkit < 2) return 0.7;
    if (l.heal === 'shield' && p.shield < 100) return 0.8;
    return 0;
  }
  if (l.kind === 'ammo') return needsAmmo(p, l.ammo) ? 0.4 : 0;
  return 0;
}
const WEAPON_RANK = { fists: 0, pistol: 1, smg: 2, shotgun: 2, revolver: 2, burst: 3, ar: 4, lmg: 4, minigun: 4, scout: 3, sniper: 3, crossbow: 3, grenade: 3 };
function needsAmmo(p, a) {
  for (const s of p.slots) { if (!s) continue; const w = WEAPONS[s.gun]; if (w.ammo === a && (p.ammo[a] || 0) < 60) return true; }
  return false;
}
function hasDecentGun(p) { return p.gun !== 'fists' && p.gun !== 'pistol'; }
function nearestBreakable(g, p, maxD) {
  let best = null, bd = maxD * maxD;
  for (const o of g.obstacles) {
    if (o.destroyed || o.type === 'wall' || o.type === 'bush') continue;
    if (o.type !== 'crate' && o.type !== 'barrel') continue;
    const d2 = dist2(p.x, p.y, o.x, o.y);
    if (d2 < bd) { bd = d2; best = o; }
  }
  return best;
}
function tryHeal(p) {
  if (p.hp < 60 && p.heals.bandage > 0) return { type: 'bandage', t: 2.2 };
  if (p.heals.medkit > 0 && p.hp < p.maxHp) return { type: 'medkit', t: 3.2 };
  if (p.heals.shield > 0 && p.shield < 100) return { type: 'shield', t: 2.6 };
  if (p.heals.bandage > 0) return { type: 'bandage', t: 2.2 };
  return null;
}
