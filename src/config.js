// Shared tuning — ZombsRoyale.io-like values
export const WORLD_SIZE = 9000;

export const LOBBY_TIME = 12;   // pre-match lobby countdown (s)
export const GRACE_TIME = 22;   // bots hold fire after landing (s)
export const CHUTE_TIME = 3.2;  // parachute descent after jumping (s)

export const RARITIES = [
  { id: 0, name: 'Common',    color: '#b8b8b8', mult: 1.0 },
  { id: 1, name: 'Uncommon',  color: '#5dff5d', mult: 1.12 },
  { id: 2, name: 'Rare',      color: '#4aa8ff', mult: 1.25 },
  { id: 3, name: 'Epic',      color: '#c26bff', mult: 1.38 },
  { id: 4, name: 'Legendary', color: '#ffd23f', mult: 1.55 },
];

// dmg = base per bullet/pellet, rof ms, mag, reload ms, spread rad, speed px/s, range px, pellets, auto
// Guns ONLY come from chests (basic + golden). Ground loot is ammo/heals.
export const WEAPONS = {
  fists:    { name: 'Fists',   icon: '👊', dmg: 12, rof: 420, mag: Infinity, reload: 0,   spread: 0.12, speed: 0,    range: 70,  pellets: 1, auto: true,  ammo: null,      len: 22, moveMul: 1 },
  pistol:   { name: 'Pistol',  icon: '🔫', dmg: 15, rof: 300, mag: 12, reload: 1100, spread: 0.07, speed: 1150, range: 620, pellets: 1, auto: false, ammo: 'light',     len: 30, moveMul: 1 },
  revolver: { name: 'Revolver',icon: '🔫', dmg: 34, rof: 560, mag: 6,  reload: 1450, spread: 0.045,speed: 1300, range: 660, pellets: 1, auto: false, ammo: 'medium',    len: 30, moveMul: 1 },
  smg:      { name: 'SMG',     icon: '🔫', dmg: 11, rof: 95,  mag: 32, reload: 1500, spread: 0.11, speed: 1050, range: 520, pellets: 1, auto: true,  ammo: 'light',     len: 30, moveMul: 1 },
  shotgun:  { name: 'Shotgun', icon: '🔫', dmg: 9,  rof: 950, mag: 6,  reload: 1900, spread: 0.28, speed: 950,  range: 340, pellets: 8, auto: false, ammo: 'shell',     len: 32, moveMul: 1 },
  ar:       { name: 'Assault', icon: '🔫', dmg: 19, rof: 155, mag: 30, reload: 1700, spread: 0.06, speed: 1350, range: 760, pellets: 1, auto: true,  ammo: 'medium',    len: 38, moveMul: 1 },
  burst:    { name: 'Burst',   icon: '🔫', dmg: 16, rof: 420, mag: 24, reload: 1600, spread: 0.05, speed: 1350, range: 700, pellets: 3, auto: false, ammo: 'medium',    len: 36, moveMul: 1 },
  lmg:      { name: 'LMG',     icon: '🔫', dmg: 17, rof: 125, mag: 60, reload: 2600, spread: 0.09, speed: 1250, range: 700, pellets: 1, auto: true,  ammo: 'medium',    len: 40, moveMul: 1 },
  minigun:  { name: 'Minigun', icon: '🔫', dmg: 13, rof: 70,  mag: 100,reload: 3400, spread: 0.13, speed: 1150, range: 640, pellets: 1, auto: true,  ammo: 'light',     len: 44, moveMul: 0.88 },
  scout:    { name: 'Scout',   icon: '🔫', dmg: 55, rof: 1000,mag: 8,  reload: 1900, spread: 0.012,speed: 2000, range: 950, pellets: 1, auto: false, ammo: 'heavy',     len: 42, moveMul: 1 },
  sniper:   { name: 'Sniper',  icon: '🔫', dmg: 85, rof: 1300,mag: 5,  reload: 2200, spread: 0.008,speed: 2200, range: 1100,pellets: 1, auto: false, ammo: 'heavy',     len: 44, moveMul: 1 },
  crossbow: { name: 'Crossbow',icon: '🏹', dmg: 46, rof: 820, mag: 1,  reload: 950,  spread: 0.01, speed: 1550, range: 820, pellets: 1, auto: false, ammo: 'medium',    len: 34, moveMul: 1 },
  grenade:  { name: 'Launcher',icon: '💣', dmg: 72, rof: 950, mag: 4,  reload: 2100, spread: 0.03, speed: 640,  range: 540, pellets: 1, auto: false, ammo: 'heavy',     len: 32, moveMul: 1, splash: 130 },
};

export const CHEST_POOL_BASIC = ['pistol','pistol','revolver','smg','smg','shotgun','shotgun','ar','burst','crossbow','scout'];
export const CHEST_POOL_GOLDEN = ['ar','burst','lmg','minigun','scout','sniper','sniper','crossbow','grenade','grenade','revolver'];

export const BOT_NAMES = ['Prodigy','CABOOSE','yeet','wires flowey','poor bob','weird flex but ok','oof','sneaky','clutch','noobslayer','ZombsKing','bushcamper','aimbot?!','laggy','potato','VEX','Nova','Ghost','Toxic','Blitz','Mango','Pixel','Rogue','Socks','Dabz','Frosty','Karen','Chad','Milly','Zed','Hanzo','Bubbles','Turbo','Waffles','SniperWolf','Cringe','Dad','Mom','Timmy','xX_sniper_Xx','killjoy','lootgoblin','gasman','crateopener','camper','rusher','healz','shieldz','doge','pepe','sus','amogus','builder','miner','farmer','hunter','emo','gamer','pro','noob','bot','sigma','alpha','omega','taco','burrito','pizza','burger','fries','soda','cookie','muffin','donut','cake','icecream','sandwich','hotdog','popcorn','nachos','pretzel','chips','candy','choco','jelly','jam','honey','milk','cereal','toast','egg','bacon','pancake','waffle'];
export const BOT_CHATS = ['weird flex but ok','oof','yeet','where are the vending machines?','starting in 2','bring can shoes before me me up','peekaboo?','poor bob','burger ready to go?','miss flowery','yessir','gg','lol','L','W','rush me','camp much?','nice shot','that hurt','heal diff','lag!!','my aim is potato','who took my loot?!','gas gas gas','zone is far','need shield','anyone got medkit?','1v1 me','clip it','so close','revive pls','squad wipe!','solo clutch incoming','touch grass','skill issue','ratio','ez','that was sus','amogus','no cap','fr fr','lets gooo','oh nah','im him','aura +1000'];

export const GAS_PHASES = [
  { wait: 14, shrink: 22, dps: 2 },
  { wait: 12, shrink: 20, dps: 4 },
  { wait: 11, shrink: 18, dps: 7 },
  { wait: 10, shrink: 16, dps: 11 },
  { wait: 9,  shrink: 14, dps: 16 },
  { wait: 8,  shrink: 12, dps: 24 },
];

export function rand(a, b) { return a + Math.random() * (b - a); }
export function randi(a, b) { return Math.floor(rand(a, b + 1)); }
export function pick(arr) { return arr[(Math.random() * arr.length) | 0]; }
export function dist2(ax, ay, bx, by) { const dx = ax - bx, dy = ay - by; return dx * dx + dy * dy; }
export function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
export function angleLerp(a, b, t) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}
