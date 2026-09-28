import { Game } from './game.js?v=113';
import { P2PNet } from './net.js?v=113';
import { WEAPONS } from './config.js?v=113';
import { sfx } from './audio.js?v=113';
import { auth } from './auth.js?v=113';
window.__ZC_BUILD = 'v113';
console.log('%cZombsClone ' + window.__ZC_BUILD, 'font-weight:bold');

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
  // bigger 6000px map supports bigger lobbies
  return mode === 'solo' ? 90 : mode === 'duo' ? 70 : 60;
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

// --- P2P rooms (public by default, optional private password) ---
let roomPublic = true;
$('pubBtn').onclick = () => {
  roomPublic = true; sfx.ui();
  $('pubBtn').classList.add('active'); $('privBtn').classList.remove('active');
  $('roomPass').classList.add('hidden');
};
$('privBtn').onclick = () => {
  roomPublic = false; sfx.ui();
  $('privBtn').classList.add('active'); $('pubBtn').classList.remove('active');
  $('roomPass').classList.remove('hidden');
};
function roomLink(code) {
  return location.origin + location.pathname + '?room=' + code;
}
$('copyBtn').onclick = async () => {
  const link = $('shareLink').value;
  try { await navigator.clipboard.writeText(link); $('copyBtn').textContent = 'Copied!'; }
  catch { $('shareLink').select(); document.execCommand('copy'); $('copyBtn').textContent = 'Copied!'; }
  setTimeout(() => { $('copyBtn').textContent = 'Copy link'; }, 2000);
};
$('createBtn').onclick = async () => {
  try {
    sfx.ui();
    const pass = roomPublic ? '' : $('roomPass').value;
    if (!roomPublic && !pass) { $('roomInfo').textContent = 'Set a password for a private room (or switch to Public).'; return; }
    $('roomInfo').textContent = 'Creating room… allow WebRTC…';
    const code = await net.host(pass);
    roomCode = code; isHost = true;
    $('roomCode').value = code;
    $('shareLink').value = roomLink(code);
    $('shareRow').classList.remove('hidden');
    $('roomInfo').textContent = roomPublic
      ? `🌐 Public room ${code} — share the code/link, anyone can join! Press PLAY to start as host (bots fill gaps).`
      : `🔒 Private room ${code} — guests need your password. Press PLAY to start as host.`;
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
        game.feed(`<b>${escapeHtml(p.name)}</b> joined`);
      }
      p.input.mx = input.mx || 0; p.input.my = input.my || 0; p.input.shoot = !!input.shoot;
      p.aimX = input.ax ?? p.aimX; p.aimY = input.ay ?? p.aimY;
      p.faceAngle = Math.atan2(p.aimY - p.y, p.aimX - p.x);
      if (input.drop && p.dropping) game.tryDrop(p);
    };
    net.onMember = (n) => { $('roomInfo').textContent = `Room ${code} — ${n} friend(s) connected (+bots).`; };
    net.onChatMsg = (n, t) => { game.feed(`<b>${escapeHtml(n)}</b>: ${escapeHtml(t)}`); };
  } catch (e) {
    $('roomInfo').textContent = 'Failed: ' + e.message + ' — playing solo with bots instead.';
  }
};

async function joinRoom(code, pass = '') {
  sfx.ui();
  code = (code || '').trim().toUpperCase();
  if (!code) { $('roomInfo').textContent = 'Enter a room code first.'; return; }
  $('roomInfo').textContent = 'Joining ' + code + '…';
  await net.join(code);
  roomCode = code; isHost = false;
  const name = (auth.current() && auth.current().name) || $('nick').value || 'Prodigy';
  net.onDenied = (reason) => {
    game.centerMsg('Join denied: ' + reason, 4);
    setTimeout(() => { net.destroy(); showMenu(); $('roomInfo').textContent = 'Join denied: ' + reason + ' Check the password and retry.'; }, 2500);
  };
  showGameUI();
  // guest: remote-render mode; seed stub world (host snapshot corrects)
  game.start({ name, mode: 'solo', botCount: 0, net, isRemote: true });
  // local pseudo player for camera/identity
  game.local = { name, x: 2100, y: 2100 };
  // build a stub world so map renders before first snapshot
  const { generateWorld } = await import('./world.js?v=113');
  const w = generateWorld(12345);
  game.obstacles = w.obstacles; game.loot = w.loot; game.ponds = w.ponds; game.roads = w.roads;
  game.gas = { x: 2100, y: 2100, r: 2500, tx: 2100, ty: 2100, tr: 1500 };
  net.onSnapshot = (snap) => game.applySnapshot(snap);
  net.sendHello({ name, pass });
  $('roomInfo').textContent = `Joined ${code} — following host simulation.`;
}

$('joinBtn').onclick = async () => {
  try {
    await joinRoom($('roomCode').value, $('roomPass').value);
  } catch (e) {
    $('roomInfo').textContent = 'Join failed: ' + e.message;
  }
};

// invite links: ?room=CODE auto-joins as guest
(function () {
  try {
    const q = new URLSearchParams(location.search).get('room');
    if (q && /^[A-Za-z0-9]{4}$/.test(q.trim())) {
      $('roomCode').value = q.trim().toUpperCase();
      $('roomInfo').textContent = `Invite link for room ${q.trim().toUpperCase()} — joining… (private rooms need the password in the field above)`;
      setTimeout(() => { joinRoom(q, '').catch((e) => { $('roomInfo').textContent = 'Join failed: ' + e.message; }); }, 800);
    }
  } catch { /* no URL API — ignore */ }
})();

// Custom chat: Enter opens the box, type, Enter sends, Esc cancels
let chatOpen = false;
function inGame() {
  return game.local && !game.local.dead && $('menu').classList.contains('hidden');
}
function openChat() {
  if (!inGame() || chatOpen) return;
  chatOpen = true;
  $('chatBox').classList.remove('hidden');
  $('chatInput').value = '';
  setTimeout(() => $('chatInput').focus(), 0);
}
function closeChat(send) {
  if (!chatOpen) return;
  chatOpen = false;
  const v = $('chatInput').value.trim().slice(0, 60);
  $('chatBox').classList.add('hidden');
  $('chatInput').blur();
  if (send && v && inGame()) {
    game.chat(game.local, v);
    if (net.isHost) net.broadcastChat(game.local.name, v);
    else if (!net.isHost && net.clientConn) net.sendChat(game.local.name, v);
  }
}
$('chatInput').addEventListener('keydown', (e) => {
  e.stopPropagation(); // keep game keys out while typing
  if (e.key === 'Enter') closeChat(true);
  else if (e.key === 'Escape') closeChat(false);
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && chatOpen) { closeChat(false); return; }
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'BUTTON' || tag === 'TEXTAREA') return;
  if (e.key === 'Enter') openChat(); // type a custom message, Enter again to send
});

function escapeHtml(s) { return String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c])); }
