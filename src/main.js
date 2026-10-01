import { Game } from './game.js?v=128';
import { ServerNet } from './servernet.js?v=128';
import { WEAPONS } from './config.js?v=128';
import { sfx } from './audio.js?v=128';
import { auth } from './auth.js?v=128';
window.__ZC_BUILD = 'v128';
console.log('%cZombsClone ' + window.__ZC_BUILD, 'font-weight:bold');

const $ = (id) => document.getElementById(id);
const canvas = $('game'), minimap = $('minimap');
const game = new Game(canvas, minimap);
const net = new ServerNet();

let mode = 'solo';
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
  updateNetStat(h);
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
  isHost = false; lastWasOnline = false;
  showGameUI();
  game.start({ name, mode, botCount: botCountFor(), net: null, isRemote: false });
  if (me && game.local) game.local.color = me.color;
  $('repoLink').href = location.href.includes('github.io') ? location.href : 'https://github.com';
};

$('againBtn').onclick = () => { playAgain(); };
$('menuBtn').onclick = () => { goHome(); };
$('winHomeBtn').onclick = () => { goHome(); };
$('winAgainBtn').onclick = () => { playAgain(); };

let lastWasOnline = false;
function goHome() {
  $('winBanner').classList.add('hidden');
  try { net.destroy(); } catch { }
  onlineIdle();
  onlineCancelled = true;
  showMenu();
}
function playAgain() {
  const wasOnline = lastWasOnline;
  goHome();
  setTimeout(() => { $(wasOnline ? 'onlineBtn' : 'botsBtn').click(); }, 60);
}

// --- ONLINE: dedicated server, no player hosts ---
// The server (server/server.js) simulates authoritatively; every browser is
// an equal client. Humans only, no bots. Match starts 30s after 2+ join.
function serverURL() {
  try {
    const saved = localStorage.getItem('zc_server_url');
    if (saved) return saved;
  } catch { }
  try {
    const host = location.hostname;
    if (host && !/^(localhost|127\.|0\.0\.0\.0)/.test(host) && !/github\.io$/.test(host)) {
      // client served by the game server itself (e.g. Render): same origin
      return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
    }
    if (/github\.io$/.test(host)) return 'wss://zombsclone-server.onrender.com';
  } catch { }
  return 'ws://localhost:8081';
}

function onlineStatus(text) {
  $('onlineBox').classList.remove('hidden');
  $('onlineStatus').textContent = text;
}
function onlineIdle() {
  $('onlineBox').classList.add('hidden');
  $('botsBtn').disabled = false; $('onlineBtn').disabled = false;
}
$('cancelOnlineBtn').onclick = () => {
  onlineCancelled = true;
  if (typeof lobbyBeat !== 'undefined' && lobbyBeat) { clearInterval(lobbyBeat); lobbyBeat = null; }
  try { net.destroy(); } catch { }
  onlineIdle();
  showMenu();
};

function playerName() {
  const me = auth.current();
  return (me && me.name) || $('nick').value || 'Prodigy';
}

let onlineCancelled = false;
let reconnectTries = 0;
let lobbyBeat = null;
let rejoiningRemote = false;
// must match server/server.js SERVER_BUILD or the menu warns
const EXPECTED_SERVER_BUILD = 1;

$('onlineBtn').onclick = async () => {
  sfx.ensure(); sfx.ui();
  onlineCancelled = false;
  reconnectTries = 0;
  $('botsBtn').disabled = true; $('onlineBtn').disabled = true;
  const name = playerName();
  const url = ($('srvUrl').value || '').trim() || serverURL();
  try { localStorage.setItem('zc_server_url', url); } catch { }
  await joinServer(url, name, false);
};

if ($('srvUrl')) {
  try { $('srvUrl').value = localStorage.getItem('zc_server_url') || ''; } catch { }
  $('srvUrl').placeholder = 'ws://localhost:8081';
}
if ($('srvTestBtn')) $('srvTestBtn').onclick = async () => {
  const msg = $('srvMsg');
  const url = ($('srvUrl').value || '').trim() || serverURL();
  msg.classList.remove('bad');
  msg.textContent = 'Testing…';
  const t = new ServerNet();
  try {
    await t.connect(url);
    t.destroy();
    msg.textContent = '✅ Server reachable!';
  } catch (e) {
    msg.classList.add('bad');
    msg.textContent = '❌ ' + e.message;
  }
};

async function joinServer(url, name, isRetry) {
  if (!isRetry) onlineStatus('Connecting to server…');
  // free-tier hosts sleep: retry a few times while they wake (~50s cover)
  for (let attempt = 1; attempt <= 4; attempt++) {
    if (onlineCancelled) { net.destroy(); return; }
    if (attempt > 1) onlineStatus(`Waking server… (attempt ${attempt}/4)`);
    try {
      await net.connect(url);
      break;
    } catch (e) {
      if (attempt === 4 || onlineCancelled) {
        if (!onlineCancelled) {
          onlineStatus('Failed: ' + e.message + ' Run the server (see README) or fix the URL below.');
          $('botsBtn').disabled = false; $('onlineBtn').disabled = false;
        }
        return;
      }
      await new Promise((r) => setTimeout(r, 7000));
    }
  }
  if (onlineCancelled) { net.destroy(); return; }
  wireServerHandlers(url, name);
  net.sendHello({ name });
}

function wireServerHandlers(url, name) {
  if (lobbyBeat) { clearInterval(lobbyBeat); lobbyBeat = null; }
  let started = false;
  let lastMsg = Date.now();
  let matchOver = false;
  const heartbeat = lobbyBeat = setInterval(() => {
    if (started || onlineCancelled) { clearInterval(heartbeat); return; }
    if (Date.now() - lastMsg > 12000) {
      clearInterval(heartbeat);
      onlineIdle(); net.destroy(); showMenu();
      onlineStatus(''); $('onlineBox').classList.remove('hidden');
      $('onlineStatus').textContent = 'Lost the server. Check it is running, then try again.';
    }
  }, 1000);
  net.onLobby = (m) => {
    lastMsg = Date.now();
    if (m.build !== undefined && m.build !== EXPECTED_SERVER_BUILD) {
      onlineStatus(`⚠️ Server is outdated (build ${m.build}, need ${EXPECTED_SERVER_BUILD}) — redeploy it on Render, then rejoin.`);
      return;
    }
    if (m.countdown > 0) onlineStatus(`Starting in ${m.countdown}… (${m.humans} players)`);
    else onlineStatus(`Waiting for players… (${m.humans} here) — starts 30s after 2+ join.`);
  };
  net.onDenied = (reason) => {
    started = true;
    clearInterval(heartbeat);
    onlineIdle(); net.destroy(); showMenu();
    onlineStatus(''); $('onlineBox').classList.remove('hidden');
    $('onlineStatus').textContent = 'Server says no: ' + reason;
  };
  net.onChatMsg = (n, t) => {
    if (!n) game.feed(escapeHtml(t));
    else game.feed(`<b>${escapeHtml(n)}</b>: ${escapeHtml(t)}`);
  };
  net.onClose = () => {
    // unexpected drop mid-match: one auto-retry, then menu
    if (onlineCancelled) return;
    if (!game.running || game.isRemote === false && !started) {
      clearInterval(heartbeat);
      onlineIdle(); showMenu();
      onlineStatus(''); $('onlineBox').classList.remove('hidden');
      $('onlineStatus').textContent = 'Disconnected from server.';
      return;
    }
    if (reconnectTries < 1) {
      reconnectTries++;
      game.centerMsg('Disconnected — retrying…', 3);
      setTimeout(() => { if (!onlineCancelled) joinServer(url, name, true); }, 1500);
    } else {
      clearInterval(heartbeat);
      onlineIdle(); net.destroy(); showMenu();
      onlineStatus(''); $('onlineBox').classList.remove('hidden');
      $('onlineStatus').textContent = 'Disconnected from server. Hit 🌐 PLAY ONLINE to re-queue.';
    }
  };
  net.onEnd = (msg) => {
    const winner = msg && msg.winner;
    const me = playerName();
    auth.recordGame({ kills: (game.local && game.local.kills) || 0, win: winner === me });
    if (winner === me) {
      sfx.win();
      $('winSub').textContent = '#1 Victory Royale (online)';
      $('winBanner').classList.remove('hidden');
    } else {
      $('deathTitle').textContent = 'Match over';
      $('deathSub').textContent = winner ? `Winner: ${winner}` : 'No survivors';
      $('deathScreen').classList.remove('hidden');
    }
  };
  net.onStart = (seed) => { beginRemote(seed, true); };
  net.onWelcome = () => { beginRemote(0, false); };

  function beginRemote(seed, sendHi) {
    if (onlineCancelled) return;
    if (started && game.running && !rejoiningRemote) return; // ignore duplicate starts
    started = true; rejoiningRemote = false;
    lastWasOnline = true;
    clearInterval(heartbeat);
    console.log('[net] entering match, seed ' + seed);
    net.onSnapshot = (snap) => game.applySnapshot(snap);
    onlineIdle();
    showGameUI();
    game.start({ name, mode: 'solo', botCount: 0, net, isRemote: true, seed });
    game.local = { name, x: 4500, y: 4500 };
    game.lastSnapT = performance.now();
    game.onStall = () => {
      // one auto-rejoin attempt; the 20s timeout boots to menu if it fails
      if (rejoiningRemote || onlineCancelled) return;
      rejoiningRemote = true;
      game.centerMsg('Connection stalled — rejoining…', 4);
      console.log('[net] stalled, rejoining');
      (async () => {
        try {
          net.destroy();
          await net.connect(url);
          if (onlineCancelled) return;
          wireServerHandlers(url, name);
          rejoiningRemote = true;
          net.sendHello({ name });
        } catch (e) {
          rejoiningRemote = false;
        }
      })();
    };
    game.onTimeout = () => {
      try { net.destroy(); } catch { }
      onlineIdle(); showMenu();
      onlineStatus(''); $('onlineBox').classList.remove('hidden');
      $('onlineStatus').textContent = 'Lost the server mid-match. Hit 🌐 PLAY ONLINE to re-queue.';
    };
    if (sendHi) net.sendHello({ name });
  }
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
    try { net.sendChat(game.local.name, v); } catch { }
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

// tiny connection readout under the alive counter (online only)
let lastNsT = 0;
function updateNetStat(h) {
  const el = $('netStat');
  const online = net && net.connected;
  if (!online || $('hud').classList.contains('hidden')) { el.classList.add('hidden'); return; }
  const now = Date.now();
  if (now - lastNsT < 500) return;
  lastNsT = now;
  el.classList.remove('hidden');
  const age = game.lastSnapT ? (performance.now() - game.lastSnapT) / 1000 : 99;
  const stale = age > 2;
  el.classList.toggle('bad', stale);
  el.textContent = stale ? `🌐 STALE ${age.toFixed(0)}s` : `🌐 ${age.toFixed(1)}s`;
}

function escapeHtml(s) { return String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c])); }
