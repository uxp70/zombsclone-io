import { Game } from './game.js?v=119';
import { P2PNet } from './net.js?v=119';
import { WEAPONS } from './config.js?v=119';
import { sfx } from './audio.js?v=119';
import { auth } from './auth.js?v=119';
window.__ZC_BUILD = 'v119';
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
  // 9000px map supports 100-player lobbies
  return mode === 'solo' ? 100 : mode === 'duo' ? 80 : 60;
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
    const iconEl = el.querySelector('.wicon');
    if (s && s.gun !== 'fists') {
      const k = s.gun + ':' + (s.rarity || 0);
      if (iconEl.dataset.k !== k) {
        const url = game.gunIcon(s.gun, s.rarity || 0);
        iconEl.innerHTML = url ? `<img src="${url}" alt="${s.gun}" />` : WEAPONS[s.gun].icon;
        iconEl.dataset.k = k;
      }
    } else {
      if (iconEl.dataset.k !== 'txt') { iconEl.textContent = s ? WEAPONS[s.gun].icon : '—'; iconEl.dataset.k = 'txt'; }
    }
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
    const label = l.chest
      ? (l.tier === 'golden' ? '💛 Golden Chest — better loot!' : '🎁 Basic Chest')
      : l.kind === 'weapon' ? `${WEAPONS[l.weapon].name} [${['C', 'U', 'R', 'E', 'L'][l.rarity]}]` : l.kind === 'heal' ? l.heal : l.ammo + ' ammo';
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

$('botsBtn').onclick = () => {
  sfx.ensure(); sfx.ui();
  const me = auth.current();
  const name = (me && me.name) || $('nick').value || 'Prodigy';
  roomCode = null; isHost = false;
  showGameUI();
  game.start({ name, mode, botCount: botCountFor(), net: null, isRemote: false });
  if (me && game.local) game.local.color = me.color;
  $('repoLink').href = location.href.includes('github.io') ? location.href : 'https://github.com';
};

$('againBtn').onclick = () => { showMenu(); $('botsBtn').click(); };
$('menuBtn').onclick = showMenu;

// --- ONLINE: automatic public lobbies, no rooms/codes. Humans only, NO bots.
// First arrival hosts (authoritative sim), rest join as guests.
// Match starts 30s after 2+ humans are present (waits as long as needed).
const ONLINE_START_WAIT = 30;
let onlineTimer = null;
let onlineCancelled = false;

function onlineStatus(text) {
  $('onlineBox').classList.remove('hidden');
  $('onlineStatus').textContent = text;
}
function onlineIdle() {
  $('onlineBox').classList.add('hidden');
  $('botsBtn').disabled = false; $('onlineBtn').disabled = false;
  if (onlineTimer) { clearInterval(onlineTimer); onlineTimer = null; }
}
$('cancelOnlineBtn').onclick = () => {
  onlineCancelled = true;
  if (onlineTimer) { clearInterval(onlineTimer); onlineTimer = null; }
  net.destroy();
  onlineIdle();
  showMenu();
};

function playerName() {
  const me = auth.current();
  return (me && me.name) || $('nick').value || 'Prodigy';
}

$('onlineBtn').onclick = async () => {
  sfx.ensure(); sfx.ui();
  onlineCancelled = false;
  $('botsBtn').disabled = true; $('onlineBtn').disabled = true;
  const name = playerName();
  try {
    onlineStatus('Searching for a public lobby…');
    const found = await net.findLobby((s) => { if (!onlineCancelled) onlineStatus(s); });
    if (onlineCancelled) return;
    if (found.role === 'host') hostOnlineLobby(name, found.lobby);
    else guestOnlineLobby(name, found.lobby);
  } catch (e) {
    if (!onlineCancelled) onlineStatus('Failed: ' + e.message);
    $('botsBtn').disabled = false; $('onlineBtn').disabled = false;
  }
};

function openHumans() {
  return 1 + net.peerCount;
}

function hostOnlineLobby(name, lobby) {
  net.gameInfo = { started: false, seed: 0 };
  // member joins/leaves are counted silently by the interval below —
  // feed messages only fire once per player when they actually enter the match
  net.onMember = () => {};
  net.onLeave = (peerId) => {
    const i = game.players.findIndex((x) => x.remotePeer === peerId);
    if (i >= 0) {
      const p = game.players[i];
      game.players.splice(i, 1);
      if (game.running) game.feed(`<b>${escapeHtml(p.name)}</b> left`);
    }
  };
  net.onChatMsg = (n, t) => { game.feed(`<b>${escapeHtml(n)}</b>: ${escapeHtml(t)}`); };
  wireHostSim(); // listen early so first inputs aren't missed
  let countdown = -1;
  onlineStatus(`Hosting lobby ${lobby} — waiting for players… (1 here)`);
  onlineTimer = setInterval(() => {
    if (onlineCancelled) { clearInterval(onlineTimer); onlineTimer = null; return; }
    const humans = openHumans();
    if (humans >= 2 && countdown < 0) countdown = ONLINE_START_WAIT;
    if (countdown >= 0) {
      countdown -= 0.5;
      onlineStatus(`Starting in ${Math.max(0, Math.ceil(countdown))}… (${humans} players)`);
      if (countdown <= 0) {
        clearInterval(onlineTimer); onlineTimer = null;
        startOnlineMatch(name);
        return;
      }
    } else {
      onlineStatus(`Waiting for players… (${humans} here) — match starts 30s after 2+ join.`);
    }
    net.broadcastLobby({ humans, countdown: Math.max(0, Math.ceil(countdown)), started: false });
  }, 500);
}

function wireHostSim() {
  net.onInput = (peerId, input, meta) => {
    let p = game.players.find((x) => x.remotePeer === peerId);
    if (!p) {
      p = game._mkPlayer(meta?.name || ('guest' + peerId.slice(-3)), false, 't-' + peerId);
      p.remote = true; p.remotePeer = peerId;
      const L = game.local;
      p.x = (L ? L.x : 4500) + 60; p.y = (L ? L.y : 4500) + 60;
      if (game.phase !== 'lobby') {
        // late join straight into the action
        p.dropping = false; p.chute = 0;
        p.x = Math.min(Math.max(p.x, 60), 8940); p.y = Math.min(Math.max(p.y, 60), 8940);
      } else {
        game.lobbyPos(p);
      }
      game.players.push(p);
      game.feed(`<b>${escapeHtml(p.name)}</b> joined`);
    }
    p.input.mx = input.mx || 0; p.input.my = input.my || 0; p.input.shoot = !!input.shoot;
    p.aimX = input.ax ?? p.aimX; p.aimY = input.ay ?? p.aimY;
    p.faceAngle = Math.atan2(p.aimY - p.y, p.aimX - p.x);
    if (input.drop && p.dropping) game.tryDrop(p);
    if (input.use) game.tryInteract(p);
  };
}

function startOnlineMatch(name) {
  const seed = (Math.random() * 1e9) | 0;
  net.gameInfo = { started: true, seed };
  net.broadcastStart(seed);
  wireHostSim();
  onlineIdle();
  showGameUI();
  // online is humans-only free-for-all: every human on their own team, no bots
  game.start({ name, mode: 'solo', botCount: 0, net, isRemote: false, teamId: 't-' + name, seed });
  const me = auth.current();
  if (me && game.local) game.local.color = me.color;
}

function guestOnlineLobby(name, lobby) {
  onlineStatus(`Joined lobby ${lobby} — waiting for players…`);
  let lastMsg = Date.now();
  let started = false;
  const heartbeat = setInterval(() => {
    if (started || onlineCancelled) { clearInterval(heartbeat); return; }
    if (Date.now() - lastMsg > 12000) {
      clearInterval(heartbeat);
      onlineIdle(); net.destroy(); showMenu();
      onlineStatus(''); $('onlineBox').classList.remove('hidden');
      $('onlineStatus').textContent = 'Lost connection to the lobby host. Hit 🌐 PLAY ONLINE to try again.';
    }
  }, 1000);
  net.onLobby = (m) => {
    lastMsg = Date.now();
    if (m.countdown > 0) onlineStatus(`Starting in ${m.countdown}… (${m.humans} players)`);
    else onlineStatus(`Waiting for players… (${m.humans} here) — starts 30s after 2+ join.`);
  };
  net.onDenied = (reason) => {
    started = true;
    onlineIdle(); net.destroy(); showMenu();
    onlineStatus(''); $('onlineBox').classList.remove('hidden');
    $('onlineStatus').textContent = 'Join denied: ' + reason;
  };
  net.onChatMsg = (n, t) => { game.feed(`<b>${escapeHtml(n)}</b>: ${escapeHtml(t)}`); };
  net.onStart = (seed) => {
    if (started || game.running) return; // ignore duplicate starts
    started = true;
    clearInterval(heartbeat);
    net.onSnapshot = (snap) => game.applySnapshot(snap);
    onlineIdle();
    showGameUI();
    game.start({ name, mode: 'solo', botCount: 0, net, isRemote: true, seed });
    game.local = { name, x: 4500, y: 4500 };
    net.sendHello({ name });
  };
}

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
