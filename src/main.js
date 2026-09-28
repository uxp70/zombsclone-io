import { Game } from './game.js';
import { P2PNet } from './net.js';
import { WEAPONS } from './config.js';
import { sfx } from './audio.js';
import { auth } from './auth.js';

const $ = (id) => document.getElementById(id);
const canvas = $('game'), minimap = $('minimap');
const game = new Game(canvas, minimap);
const net = new P2PNet();

let mode = 'solo';
let roomCode = null;
let isHost = false;

// mode buttons
document.querySelectorAll('.mode').forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll('.mode').forEach((x) => x.classList.remove('active'));
    b.classList.add('active'); mode = b.dataset.mode; sfx.ui();
  };
});

function botCountFor() {
  // keep perf sane: 70 solo, fewer with real players expected
  return mode === 'solo' ? 75 : mode === 'duo' ? 60 : 55;
}

function showGameUI() {
  $('menu').classList.add('hidden');
  $('deathScreen').classList.add('hidden');
  $('hud').classList.remove('hidden');
}
function showMenu() {
  game.stop();
  refreshAccount();
  $('hud').classList.add('hidden');
  $('deathScreen').classList.add('hidden');
  $('menu').classList.remove('hidden');
}

// ---------- accounts ----------
function authMsg(text, ok = false) {
  const el = $('authMsg');
  el.textContent = text || '';
  el.classList.toggle('ok', !!ok);
}
function refreshAccount() {
  const me = auth.current();
  $('authForm').classList.toggle('hidden', !!me);
  $('userChip').classList.toggle('hidden', !me);
  if (me) {
    $('userName').textContent = me.name;
    $('userDot').style.background = me.color;
    const s = me.stats || { games: 0, kills: 0, wins: 0 };
    $('userStats').textContent = `${s.games} games • ${s.kills} kills • ${s.wins} wins`;
    $('nick').value = me.name;
    $('nick').disabled = true;
  } else {
    $('nick').disabled = false;
  }
}
$('loginBtn').onclick = async () => {
  try { await auth.login($('authUser').value, $('authPass').value); authMsg('Logged in!', true); sfx.ui(); }
  catch (e) { authMsg(e.message); return; }
  $('authPass').value = '';
  refreshAccount();
};
$('regBtn').onclick = async () => {
  try { await auth.register($('authUser').value, $('authPass').value); authMsg('Account created!', true); sfx.ui(); }
  catch (e) { authMsg(e.message); return; }
  $('authPass').value = '';
  refreshAccount();
};
$('authPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('loginBtn').click(); });
$('logoutBtn').onclick = () => { auth.logout(); authMsg(''); refreshAccount(); };
$('colorBtn').onclick = () => {
  const c = auth.rerollColor();
  if (c) $('userDot').style.background = c;
};
refreshAccount();

// HUD wiring
game.onKillfeed = (feeds) => {
  const kf = $('killfeed');
  kf.innerHTML = feeds.map((f) => `<div class="feed">${f}</div>`).join('');
};
game.onChat = (p, text) => {
  const log = $('chatLog');
  const div = document.createElement('div');
  div.className = 'chat';
  div.innerHTML = `<b>${escapeHtml(p.name)}</b> ${escapeHtml(text)}`;
  log.appendChild(div);
  while (log.children.length > 4) log.removeChild(log.firstChild);
  setTimeout(() => div.remove(), 5000);
};
game.onHud = (h) => {
  if (h.remote) {
    $('aliveCount').textContent = h.alive;
    $('zoneTimer').textContent = h.zone;
    return;
  }
  $('aliveCount').textContent = h.alive;
  $('killCount').textContent = `${h.kills} Kills`;
  $('zoneTimer').textContent = (h.dropping ? 'SPACE / F to drop! — ' : '') + h.zone;
  $('hpfill').style.width = Math.max(0, h.hp) + '%';
  $('shieldfill').style.width = Math.max(0, h.shield) + '%';
  // slots
  const slots = $('slots');
  if (slots.children.length !== 4) {
    slots.innerHTML = '';
    for (let i = 0; i < 4; i++) {
      const d = document.createElement('div');
      d.className = 'slot'; d.innerHTML = `<div class="wicon">—</div><div class="wname"></div>`;
      slots.appendChild(d);
    }
  }
  [...slots.children].forEach((el, i) => {
    const s = h.slots[i];
    el.classList.toggle('active', i === h.slotI);
    el.querySelector('.wicon').textContent = s ? WEAPONS[s.gun].icon : '—';
    const wname = s ? `${WEAPONS[s.gun].name}${s.magAmmo === Infinity ? '' : ` ${s.magAmmo}`}` : '';
    el.querySelector('.wname').textContent = wname;
    el.style.borderColor = s ? ['#b8b8b8', '#5dff5d', '#4aa8ff', '#c26bff', '#ffd23f'][s.rarity || 0] : '';
  });
  const cur = h.ammo;
  $('ammoCount').textContent = !cur ? '—' : (cur.magAmmo === Infinity ? '∞' : `${cur.magAmmo} / ${h.reserve[WEAPONS[cur.gun].ammo] || 0}`) + (h.reloading ? ' ⟳' : '') + (h.healing ? ` +${h.healing.type}` : '');
  $('healRow').innerHTML = `🩹 ${h.heals.bandage} &nbsp; 💊 ${h.heals.medkit} &nbsp; 🛡️ ${h.heals.shield} &nbsp; <span style="opacity:.7">[Q] bandage [X] shield/medkit</span>`;
  $('pname').textContent = game.local ? game.local.name : '';
  // interact tip
  const tip = $('interactTip');
  if (h.interact && !h.dropping) {
    const l = h.interact;
    const label = l.kind === 'weapon' ? `${WEAPONS[l.weapon].name} [${['C', 'U', 'R', 'E', 'L'][l.rarity]}]` : l.kind === 'heal' ? l.heal : l.ammo + ' ammo';
    tip.innerHTML = `Press <b>E</b> — ${escapeHtml(label)}`;
    tip.classList.remove('hidden');
  } else tip.classList.add('hidden');
};
game.onDeath = ({ rank, total, by, kills }) => {
  auth.recordGame({ kills, win: false });
  $('deathTitle').textContent = `#${rank} of ${total}`;
  $('deathSub').textContent = `Eliminated by ${by} • ${kills} kills`;
  $('deathScreen').classList.remove('hidden');
};
game.onWin = ({ kills }) => {
  auth.recordGame({ kills, win: true });
  const b = $('winBanner');
  b.classList.remove('hidden');
  $('winSub').textContent = `#1 Victory Royale • ${kills} kills`;
  setTimeout(() => b.classList.add('hidden'), 6000);
};
// bot chatter → float bubbles
const origChat = game.chat.bind(game);
game.chat = (p, t) => origChat(p, t);
game.onChat = ((prev) => (p, t) => { prev && prev(p, t); })(game.onChat);
// hook bot chat: poll via wrapping? bots call g.onChat directly; also add float bubble:
const _oc = game.onChat;
game.onChat = (p, text) => {
  // ensure bubble exists even for DOM log path
  if (!game.floatChats.find((c) => c.pid === p.id && c.text === text)) game.floatChats.push({ pid: p.id, text: String(text).slice(0, 60), t: 3.2 });
  _oc && _oc(p, text);
};
// expose chat for bots (bots.js uses g.onChat)
game.feed = game.feed.bind(game);

$('playBtn').onclick = () => {
  sfx.ensure(); sfx.ui();
  const me = auth.current();
  const name = (me && me.name) || $('nick').value || 'Prodigy';
  roomCode = null; isHost = false;
  showGameUI();
  game.start({ name, mode, botCount: botCountFor(), net: null, isRemote: false });
  if (me && game.local) game.local.color = me.color;
  $('repoLink').href = location.href.includes('github.io') ? location.href : 'https://github.com';
};

$('againBtn').onclick = () => { $('playBtn').click(); };
$('menuBtn').onclick = showMenu;

// --- P2P rooms ---
$('createBtn').onclick = async () => {
  try {
    sfx.ui();
    $('roomInfo').textContent = 'Creating room… allow WebRTC…';
    const code = await net.host();
    roomCode = code; isHost = true;
    $('roomCode').value = code;
    $('roomInfo').textContent = `Room ${code} — share the code! Press PLAY to start as host (bots fill gaps). ${net.supported ? '' : ''}`;
    // host: start game immediately with fewer bots; guests join mid-game? v1: host starts now
    const name = (auth.current() && auth.current().name) || $('nick').value || 'Prodigy';
    showGameUI();
    game.start({ name, mode, botCount: 50, net, isRemote: false, teamId: 't-local' });
    net.onInput = (peerId, input, meta) => {
      // map peer → remote player (create on first hello/input)
      let p = game.players.find((x) => x.remotePeer === peerId);
      if (!p) {
        // reuse mkPlayer via game._mkPlayer
        p = game._mkPlayer(meta?.name || ('guest' + peerId.slice(-3)), false, mode === 'solo' ? 't-' + peerId : 't-local');
        p.remote = true; p.remotePeer = peerId;
        p.x = game.local.x + 60; p.y = game.local.y + 60;
        game.players.push(p);
        game.feed(`<b>${escapeHtml(p.name)}</b> joined`);
      }
      p.input.mx = input.mx || 0; p.input.my = input.my || 0; p.input.shoot = !!input.shoot;
      p.aimX = input.ax ?? p.aimX; p.aimY = input.ay ?? p.aimY;
      p.faceAngle = Math.atan2(p.aimY - p.y, p.aimX - p.x);
    };
    net.onMember = (n) => { $('roomInfo').textContent = `Room ${code} — ${n} friend(s) connected (+bots).`; };
    net.onChatMsg = (n, t) => { game.feed(`<b>${escapeHtml(n)}</b>: ${escapeHtml(t)}`); };
  } catch (e) {
    $('roomInfo').textContent = 'Failed: ' + e.message + ' — playing solo with bots instead.';
  }
};

$('joinBtn').onclick = async () => {
  try {
    sfx.ui();
    const code = $('roomCode').value.trim().toUpperCase();
    if (!code) { $('roomInfo').textContent = 'Enter a room code first.'; return; }
    $('roomInfo').textContent = 'Joining ' + code + '…';
    await net.join(code);
    roomCode = code; isHost = false;
    const name = (auth.current() && auth.current().name) || $('nick').value || 'Prodigy';
    showGameUI();
    // guest: remote-render mode; seed stub world (host snapshot corrects)
    game.start({ name, mode: 'solo', botCount: 0, net, isRemote: true });
    // local pseudo player for camera/identity
    game.local = { name, x: 2100, y: 2100 };
    // build a stub world so map renders before first snapshot
    const { generateWorld } = await import('./world.js');
    const w = generateWorld(12345);
    game.obstacles = w.obstacles; game.loot = w.loot; game.ponds = w.ponds; game.roads = w.roads;
    game.gas = { x: 2100, y: 2100, r: 2500, tx: 2100, ty: 2100, tr: 1500 };
    net.onSnapshot = (snap) => game.applySnapshot(snap);
    net.sendHello({ name });
    $('roomInfo').textContent = `Joined ${code} — following host simulation.`;
  } catch (e) {
    $('roomInfo').textContent = 'Join failed: ' + e.message;
  }
};

// Enter for quick-chat bubbles (only while playing, not while typing)
window.addEventListener('keydown', (e) => {
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'BUTTON' || tag === 'TEXTAREA') return;
  if (e.key === 'Enter' && game.local && !game.local.dead && $('menu').classList.contains('hidden')) {
    const msgs = ['gg', 'yeet', 'oof', 'rush me', 'need shield!', 'gas gas gas'];
    const t = msgs[(Math.random() * msgs.length) | 0];
    game.chat(game.local, t);
    if (net.isHost) net.broadcastChat(game.local.name, t);
    else if (!net.isHost && net.clientConn) net.sendChat(game.local.name, t);
  }
});

function escapeHtml(s) { return String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c])); }
