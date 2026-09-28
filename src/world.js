import { WORLD_SIZE, LOOT_TABLE, rand, randi, pick } from './config.js?v=111';

let uid = 1;
export function nid() { return uid++; }

// Seeded RNG (mulberry32) so host + clients can share map via seed
export function rng(seed) {
  let t = seed >>> 0;
  return function () {
    t += 0x6D2B79F5;
    let z = Math.imul(t ^ (t >>> 15), t | 1);
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61);
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  };
}

export function generateWorld(seed = (Math.random() * 1e9) | 0) {
  const R = rng(seed);
  const S = WORLD_SIZE;
  const obstacles = [];
  const loot = [];

  const RR = (a, b) => a + R() * (b - a);

  // Ponds (non-solid decor, slow)
  const ponds = [];
  for (let i = 0; i < 7; i++) ponds.push({ x: RR(300, S - 300), y: RR(300, S - 300), r: RR(90, 170) });

  // Roads (decor)
  const roads = [
    { x: 0, y: S * 0.5 - 40, w: S, h: 80, vert: false },
    { x: S * 0.5 - 40, y: 0, w: 80, h: S, vert: true },
  ];

  // Compounds / buildings (walls + crates inside) — like lab / houses
  const compounds = [];
  const nComp = 9;
  for (let i = 0; i < nComp; i++) {
    const cx = RR(500, S - 500), cy = RR(500, S - 500);
    const w = RR(220, 420), h = RR(220, 380);
    const walls = [];
    const t = 22;
    // 4 walls with door gaps
    const gap = () => RR(0.25, 0.7);
    const g1 = gap(), g2 = gap(), g3 = gap(), g4 = gap();
    const gw = 90;
    // top (two segs)
    walls.push({ type: 'wall', x: cx - w / 2, y: cy - h / 2, w: w * g1 - gw / 2, h: t, hp: 120 });
    walls.push({ type: 'wall', x: cx - w / 2 + w * g1 + gw / 2, y: cy - h / 2, w: w - (w * g1 + gw / 2), h: t, hp: 120 });
    // bottom
    walls.push({ type: 'wall', x: cx - w / 2, y: cy + h / 2 - t, w: w * g2 - gw / 2, h: t, hp: 120 });
    walls.push({ type: 'wall', x: cx - w / 2 + w * g2 + gw / 2, y: cy + h / 2 - t, w: w - (w * g2 + gw / 2), h: t, hp: 120 });
    // left
    walls.push({ type: 'wall', x: cx - w / 2, y: cy - h / 2, w: t, h: h * g3 - gw / 2, hp: 120 });
    walls.push({ type: 'wall', x: cx - w / 2, y: cy - h / 2 + h * g3 + gw / 2, w: t, h: h - (h * g3 + gw / 2), hp: 120 });
    // right
    walls.push({ type: 'wall', x: cx + w / 2 - t, y: cy - h / 2, w: t, h: h * g4 - gw / 2, hp: 120 });
    walls.push({ type: 'wall', x: cx + w / 2 - t, y: cy - h / 2 + h * g4 + gw / 2, w: t, h: h - (h * g4 + gw / 2), hp: 120 });
    for (const wl of walls) { wl.id = nid(); obstacles.push(wl); }
    compounds.push({ x: cx, y: cy, w, h });
    // loot + crates inside
    const nIn = randi(4, 7);
    for (let k = 0; k < nIn; k++) {
      const lx = RR(cx - w / 2 + 50, cx + w / 2 - 50), ly = RR(cy - h / 2 + 50, cy + h / 2 - 50);
      loot.push(makeLoot(lx, ly, R));
    }
    for (let k = 0; k < 3; k++) obstacles.push({ id: nid(), type: 'crate', x: RR(cx - w / 2 + 40, cx + w / 2 - 40), y: RR(cy - h / 2 + 40, cy + h / 2 - 40), r: 22, hp: 60, solid: true });
  }

  // Scatter: trees / rocks / crates / barrels / bushes
  const N = 520;
  for (let i = 0; i < N; i++) {
    const x = RR(80, S - 80), y = RR(80, S - 80);
    const roll = R();
    if (roll < 0.34) obstacles.push({ id: nid(), type: 'tree', x, y, r: RR(22, 42), hp: 80, solid: true });
    else if (roll < 0.52) obstacles.push({ id: nid(), type: 'rock', x, y, r: RR(18, 38), hp: 120, solid: true });
    else if (roll < 0.66) obstacles.push({ id: nid(), type: 'crate', x, y, r: 22, hp: 60, solid: true });
    else if (roll < 0.76) obstacles.push({ id: nid(), type: 'barrel', x, y, r: 18, hp: 40, solid: true });
    else if (roll < 0.9) obstacles.push({ id: nid(), type: 'bush', x, y, r: RR(20, 30), hp: 20, solid: false });
    else obstacles.push({ id: nid(), type: 'rocksmall', x, y, r: RR(10, 16), hp: 30, solid: true });
  }

  // Ground loot scattered
  for (let i = 0; i < 260; i++) loot.push(makeLoot(RR(100, S - 100), RR(100, S - 100), R));
  // Heals / ammo top-up
  for (let i = 0; i < 160; i++) {
    const r = R();
    const x = RR(100, S - 100), y = RR(100, S - 100);
    if (r < 0.4) loot.push({ id: nid(), kind: 'heal', heal: 'bandage', x, y });
    else if (r < 0.55) loot.push({ id: nid(), kind: 'heal', heal: 'medkit', x, y });
    else if (r < 0.7) loot.push({ id: nid(), kind: 'heal', heal: 'shield', x, y });
    else if (r < 0.85) loot.push({ id: nid(), kind: 'ammo', ammo: 'light', amount: 30, x, y });
    else if (r < 0.93) loot.push({ id: nid(), kind: 'ammo', ammo: 'medium', amount: 30, x, y });
    else loot.push({ id: nid(), kind: 'ammo', ammo: pick(['shell', 'heavy']), amount: 12, x, y });
  }

  return { seed, obstacles, loot, ponds, roads, compounds };
}

function makeLoot(x, y, R) {
  const w = LOOT_TABLE[(R() * LOOT_TABLE.length) | 0];
  // rarity weighted: common 40 / uncommon 28 / rare 17 / epic 10 / legendary 5
  const r = R();
  const rarity = r < 0.4 ? 0 : r < 0.68 ? 1 : r < 0.85 ? 2 : r < 0.95 ? 3 : 4;
  return { id: nid(), kind: 'weapon', weapon: w, rarity, x: x + (R() - 0.5) * 20, y: y + (R() - 0.5) * 20 };
}

export function spawnPoints(n, R) {
  const pts = [];
  for (let i = 0; i < n; i++) pts.push({ x: 150 + R() * (WORLD_SIZE - 300), y: 150 + R() * (WORLD_SIZE - 300) });
  return pts;
}
