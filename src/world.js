import { WORLD_SIZE, rand, randi, pick } from './config.js?v=133';

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
  uid = 1; // deterministic ids per seed — host + P2P guests generate identical worlds
  const R = rng(seed);
  const S = WORLD_SIZE;
  const obstacles = [];
  const loot = [];
  const houses = [];   // {x,y,w,h} floor drawn under walls
  const chests = [];   // {x,y,tier:'basic'|'golden'} — the ONLY gun source

  const RR = (a, b) => a + R() * (b - a);

  // Ponds (non-solid decor, slow)
  const ponds = [];
  for (let i = 0; i < 11; i++) ponds.push({ x: RR(300, S - 300), y: RR(300, S - 300), r: RR(90, 190) });

  // Roads (decor)
  const roads = [
    { x: 0, y: S * 0.5 - 40, w: S, h: 80, vert: false },
    { x: S * 0.5 - 40, y: 0, w: 80, h: S, vert: true },
    { x: 0, y: S * 0.24 - 30, w: S, h: 60, vert: false },
    { x: S * 0.74 - 30, y: 0, w: 60, h: S, vert: true },
  ];

  const POI_NAMES = ['Mansion', 'Lab', 'Farm', 'Factory', 'Docks', 'Castle', 'Village', 'Observatory', 'Prison', 'Mall', 'Airport', 'School', 'Stadium', 'Church'];

  // Compounds / buildings (walls + crates inside) — like lab / houses
  const compounds = [];
  const nComp = 13;
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
    compounds.push({ x: cx, y: cy, w, h, name: POI_NAMES[i % POI_NAMES.length] });
    // chest(s) + ammo inside — guns ONLY come from chests
    chests.push({ x: cx + RR(-30, 30), y: cy + RR(-30, 30), tier: 'basic' });
    if (w * h > 110000 || R() < 0.45) {
      chests.push({
        x: cx + RR(-w / 4, w / 4), y: cy + RR(-h / 4, h / 4),
        tier: (w * h > 120000 && R() < 0.5) ? 'golden' : 'basic',
      });
    }
    for (let k = 0; k < 2; k++) {
      loot.push(makeLoot(RR(cx - w / 2 + 50, cx + w / 2 - 50), RR(cy - h / 2 + 50, cy + h / 2 - 50), R));
    }
    for (let k = 0; k < 3; k++) obstacles.push({ id: nid(), type: 'crate', x: RR(cx - w / 2 + 40, cx + w / 2 - 40), y: RR(cy - h / 2 + 40, cy + h / 2 - 40), r: 22, hp: 60, solid: true });
  }

  // Houses: small walled buildings with a guaranteed chest inside
  const nHouses = 30;
  let placed = 0, tries = 0;
  while (placed < nHouses && tries < 200) {
    tries++;
    const cx = RR(400, S - 400), cy = RR(400, S - 400);
    const w = RR(200, 330), h = RR(180, 290);
    let clear = true;
    for (const c of compounds) { if (Math.abs(c.x - cx) < 420 && Math.abs(c.y - cy) < 420) { clear = false; break; } }
    for (const hh of houses) { if (Math.abs(hh.x - cx) < 380 && Math.abs(hh.y - cy) < 380) { clear = false; break; } }
    if (!clear) continue;
    placed++;
    const t = 20, doorSide = (R() * 4) | 0, gap = 95;
    const gc = RR(0.3, 0.7); // gap position along side
    const seg = (x, y, ww, hh) => { if (ww > 4 && hh > 4) { const o = { type: 'wall', x, y, w: ww, h: hh, hp: 100, id: nid() }; obstacles.push(o); } };
    let door = null;
    if (doorSide === 0) { // top has door
      const gx = cx - w / 2 + w * gc;
      door = { x: gx, y: cy - h / 2 };
      seg(cx - w / 2, cy - h / 2, gx - gap / 2 - (cx - w / 2), t);
      seg(gx + gap / 2, cy - h / 2, (cx + w / 2) - (gx + gap / 2), t);
      seg(cx - w / 2, cy + h / 2 - t, w, t);
    } else if (doorSide === 1) { // bottom
      const gx = cx - w / 2 + w * gc;
      door = { x: gx, y: cy + h / 2 };
      seg(cx - w / 2, cy - h / 2, w, t);
      seg(cx - w / 2, cy + h / 2 - t, gx - gap / 2 - (cx - w / 2), t);
      seg(gx + gap / 2, cy + h / 2 - t, (cx + w / 2) - (gx + gap / 2), t);
    } else if (doorSide === 2) { // left
      const gy = cy - h / 2 + h * gc;
      door = { x: cx - w / 2, y: gy };
      seg(cx - w / 2, cy - h / 2, w, t);
      seg(cx - w / 2, cy + h / 2 - t, w, t);
      seg(cx - w / 2, cy - h / 2, t, gy - gap / 2 - (cy - h / 2));
      seg(cx - w / 2, gy + gap / 2, t, (cy + h / 2) - (gy + gap / 2));
    } else { // right
      const gy = cy - h / 2 + h * gc;
      door = { x: cx + w / 2, y: gy };
      seg(cx - w / 2, cy - h / 2, w, t);
      seg(cx - w / 2, cy + h / 2 - t, w, t);
      seg(cx + w / 2 - t, cy - h / 2, t, gy - gap / 2 - (cy - h / 2));
      seg(cx + w / 2 - t, gy + gap / 2, t, (cy + h / 2) - (gy + gap / 2));
    }
    houses.push({ x: cx, y: cy, w, h, door });
    const big = w * h > 70000;
    chests.push({ x: cx + RR(-40, 40), y: cy + RR(-30, 30), tier: big && R() < 0.3 ? 'golden' : 'basic' });
    if (big && R() < 0.45) chests.push({ x: cx + RR(-w / 4, w / 4), y: cy + RR(-h / 4, h / 4), tier: 'basic' });
    loot.push(makeLoot(cx + RR(-60, 60), cy + RR(-50, 50), R));
    if (R() < 0.5) obstacles.push({ id: nid(), type: 'crate', x: cx + RR(-w / 3, w / 3), y: cy + RR(-h / 3, h / 3), r: 22, hp: 60, solid: true });
  }

  // Lone wild chests (basic) scattered around the map
  for (let i = 0; i < 34; i++) chests.push({ x: RR(150, S - 150), y: RR(150, S - 150), tier: 'basic' });

  // guarantee enough golden chests for a full lobby
  let gold = chests.filter((c) => c.tier === 'golden').length;
  let guard = 200;
  while (gold < 14 && guard-- > 0) {
    const c = chests[(R() * chests.length) | 0];
    if (c.tier !== 'golden') { c.tier = 'golden'; gold++; }
  }

  // Scatter: trees / rocks / crates / barrels / bushes
  // density varies by quadrant for a less uniform look
  const N = 1600;
  for (let i = 0; i < N; i++) {
    const x = RR(80, S - 80), y = RR(80, S - 80);
    const roll = R();
    const rocky = (x > S * 0.6 && y < S * 0.4) ? 0.12 : 0; // rocky NE corner
    if (roll < 0.34 - rocky) obstacles.push({ id: nid(), type: 'tree', x, y, r: RR(22, 46), hp: 80, solid: true, pine: x < S * 0.45 && y > S * 0.55 });
    else if (roll < 0.52) obstacles.push({ id: nid(), type: 'rock', x, y, r: RR(18, 42), hp: 120, solid: true });
    else if (roll < 0.66) obstacles.push({ id: nid(), type: 'crate', x, y, r: 22, hp: 60, solid: true });
    else if (roll < 0.76) obstacles.push({ id: nid(), type: 'barrel', x, y, r: 18, hp: 40, solid: true });
    else if (roll < 0.9) obstacles.push({ id: nid(), type: 'bush', x, y, r: RR(20, 30), hp: 20, solid: false });
    else obstacles.push({ id: nid(), type: 'rocksmall', x, y, r: RR(10, 16), hp: 30, solid: true });
  }

  // Ground loot scattered — ammo + heals only (guns come from chests)
  for (let i = 0; i < 700; i++) loot.push(makeLoot(RR(100, S - 100), RR(100, S - 100), R));
  // Heals / ammo top-up
  for (let i = 0; i < 420; i++) {
    const r = R();
    const x = RR(100, S - 100), y = RR(100, S - 100);
    if (r < 0.4) loot.push({ id: nid(), kind: 'heal', heal: 'bandage', x, y });
    else if (r < 0.55) loot.push({ id: nid(), kind: 'heal', heal: 'medkit', x, y });
    else if (r < 0.7) loot.push({ id: nid(), kind: 'heal', heal: 'shield', x, y });
    else if (r < 0.85) loot.push({ id: nid(), kind: 'ammo', ammo: 'light', amount: 30, x, y });
    else if (r < 0.93) loot.push({ id: nid(), kind: 'ammo', ammo: 'medium', amount: 30, x, y });
    else loot.push({ id: nid(), kind: 'ammo', ammo: pick(['shell', 'heavy']), amount: 12, x, y });
  }

  return { seed, obstacles, loot, ponds, roads, compounds, houses, chests };
}

// Ground loot is ammo + heals only — guns come exclusively from chests.
function makeLoot(x, y, R) {
  const r = R();
  const jx = x + (R() - 0.5) * 20, jy = y + (R() - 0.5) * 20;
  if (r < 0.3) return { id: nid(), kind: 'heal', heal: 'bandage', x: jx, y: jy };
  if (r < 0.42) return { id: nid(), kind: 'heal', heal: 'medkit', x: jx, y: jy };
  if (r < 0.56) return { id: nid(), kind: 'heal', heal: 'shield', x: jx, y: jy };
  if (r < 0.74) return { id: nid(), kind: 'ammo', ammo: 'light', amount: 30, x: jx, y: jy };
  if (r < 0.88) return { id: nid(), kind: 'ammo', ammo: 'medium', amount: 30, x: jx, y: jy };
  return { id: nid(), kind: 'ammo', ammo: pick(['shell', 'heavy']), amount: 12, x: jx, y: jy };
}

export function spawnPoints(n, R) {
  const pts = [];
  for (let i = 0; i < n; i++) pts.push({ x: 150 + R() * (WORLD_SIZE - 300), y: 150 + R() * (WORLD_SIZE - 300) });
  return pts;
}
