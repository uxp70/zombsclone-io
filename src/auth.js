// Local-first accounts for a static site (GitHub Pages has no backend).
// Users are stored in localStorage; passwords are salted + SHA-256 hashed.
// NOTE: this protects against casual snooping, not a determined attacker with
// device access. For real cross-device auth you need a server.
const USERS_KEY = 'zc_users_v1';
const SESSION_KEY = 'zc_session_v1';

function loadUsers() {
  try { return JSON.parse(localStorage.getItem(USERS_KEY)) || {}; } catch { return {}; }
}
function saveUsers(u) {
  try { localStorage.setItem(USERS_KEY, JSON.stringify(u)); } catch { /* storage full/blocked */ }
}

async function sha256Hex(str) {
  try {
    if (window.crypto && window.crypto.subtle) {
      const buf = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
      return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
    }
  } catch { /* fall through */ }
  // Fallback for non-secure contexts — NOT cryptographically strong.
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < str.length; i++) {
    h1 = Math.imul(h1 ^ str.charCodeAt(i), 16777619) >>> 0;
    h2 = Math.imul(h2 + str.charCodeAt(i), 2246822519) >>> 0;
  }
  return 'fb' + h1.toString(16) + h2.toString(16);
}

function randomColor() {
  return `hsl(${(Math.random() * 360) | 0} 65% 55%)`;
}
const keyOf = (name) => name.toLowerCase();

export function validName(name) {
  return /^[A-Za-z0-9_]{3,14}$/.test(name || '');
}

export const auth = {
  async register(name, pass) {
    name = (name || '').trim();
    if (!validName(name)) throw new Error('Username: 3–14 chars, letters/numbers/_ only.');
    if (!pass || pass.length < 4) throw new Error('Password needs 4+ characters.');
    const users = loadUsers();
    if (users[keyOf(name)]) throw new Error('Username taken on this device.');
    const salt = Math.random().toString(36).slice(2) + Date.now().toString(36);
    users[keyOf(name)] = {
      name, salt,
      hash: await sha256Hex(salt + '::' + pass),
      color: randomColor(),
      created: Date.now(),
      stats: { games: 0, kills: 0, wins: 0 },
    };
    saveUsers(users);
    localStorage.setItem(SESSION_KEY, keyOf(name));
    return users[keyOf(name)];
  },

  async login(name, pass) {
    name = (name || '').trim();
    const users = loadUsers();
    const u = users[keyOf(name)];
    if (!u) throw new Error('No such account on this device. Register first.');
    const hash = await sha256Hex(u.salt + '::' + (pass || ''));
    if (hash !== u.hash) throw new Error('Wrong password.');
    localStorage.setItem(SESSION_KEY, keyOf(name));
    return u;
  },

  logout() { try { localStorage.removeItem(SESSION_KEY); } catch { } },

  current() {
    try {
      const k = localStorage.getItem(SESSION_KEY);
      if (!k) return null;
      return loadUsers()[k] || null;
    } catch { return null; }
  },

  recordGame({ kills = 0, win = false } = {}) {
    const me = this.current();
    if (!me) return null;
    const users = loadUsers();
    const u = users[keyOf(me.name)];
    if (!u) return null;
    u.stats.games++;
    u.stats.kills += kills | 0;
    if (win) u.stats.wins++;
    saveUsers(users);
    return u.stats;
  },

  rerollColor() {
    const me = this.current();
    if (!me) return null;
    const users = loadUsers();
    const u = users[keyOf(me.name)];
    if (!u) return null;
    u.color = randomColor();
    saveUsers(users);
    return u.color;
  },
};
