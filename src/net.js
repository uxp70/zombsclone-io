// Automatic public lobbies over PeerJS cloud (no server to host).
// Lobby N lives at the fixed id 'zombsclone-lobby-N' (N = 1..5).
// First arrival hosts (authoritative sim), the rest join as guests.
// Host holds up to 5 guests (6 humans) + bots fill the match.
const LOBBY_SLOTS = 5;
const MAX_GUESTS = 5;

export class P2PNet {
  constructor() {
    this.peer = null; this.conns = new Map(); this.isHost = false;
    this.room = null; this.onSnapshot = null; this.onInput = null;
    this.onChatMsg = null; this.onMember = null; this.onDenied = null;
    this.onLobby = null; this.onStart = null;
    this.gameInfo = { started: false, seed: 0 };
  }
  get supported() { return typeof window !== 'undefined' && typeof window.Peer !== 'undefined'; }

  // Find a lobby: host an empty slot or join an existing one.
  async findLobby(onStatus) {
    this.destroy();
    if (!this.supported) throw new Error('P2P library failed to load (offline?).');
    for (let n = 1; n <= LOBBY_SLOTS; n++) {
      const id = 'zombsclone-lobby-' + n;
      onStatus && onStatus('Trying lobby ' + n + '…');
      try {
        await this._open(id); // host it if free
        this.isHost = true; this.room = 'L' + n;
        this.peer.on('connection', (c) => this._wireHostConn(c));
        return { role: 'host', lobby: n };
      } catch (e) {
        this.destroy();
        if (!/taken/i.test(e.message)) throw e; // real network problem, don't scan on
      }
      onStatus && onStatus('Joining lobby ' + n + '…');
      try {
        await this._open(); // random id for guest
        const ok = await this._connectTo(id);
        if (ok) {
          this.isHost = false; this.room = 'L' + n;
          return { role: 'guest', lobby: n };
        }
      } catch { /* fall through to next lobby */ }
      this.destroy();
    }
    throw new Error('All lobbies are full right now — try again in a bit.');
  }

  _open(id) {
    return new Promise((res, rej) => {
      this.destroy();
      let done = false;
      const fail = (msg) => { if (!done) { done = true; try { this.peer && this.peer.destroy(); } catch { } this.peer = null; rej(new Error(msg)); } };
      try {
        this.peer = id ? new window.Peer(id) : new window.Peer();
      } catch (e) { fail('P2P init failed.'); return; }
      const to = setTimeout(() => fail('P2P network timeout.'), 10000);
      this.peer.on('open', () => { if (!done) { done = true; clearTimeout(to); res(); } });
      this.peer.on('error', (e) => {
        const t = (e && e.type) || '';
        if (t === 'unavailable-id') fail('taken: lobby id in use');
        else if (!done) fail('P2P error: ' + t);
      });
    });
  }

  _connectTo(id) {
    return new Promise((resolve) => {
      let done = false;
      const conn = this.peer.connect(id, { reliable: true });
      const to = setTimeout(() => { if (!done) { done = true; try { conn.close(); } catch { } resolve(false); } }, 4000);
      conn.on('open', () => { if (!done) { done = true; clearTimeout(to); this._wireClientConn(conn); resolve(true); } });
      const nope = () => { if (!done) { done = true; clearTimeout(to); resolve(false); } };
      conn.on('error', nope);
      conn.on('close', nope);
    });
  }

  _openConns() {
    let n = 0;
    for (const [, c] of this.conns) { try { if (c.open) n++; } catch { } }
    return n;
  }

  _wireHostConn(conn) {
    conn.on('open', () => {
      this.conns.set(conn.peer, conn);
      this.onMember && this.onMember(this._openConns());
    });
    conn.on('data', (msg) => {
      if (!msg) return;
      if (msg.t === 'input') this.onInput && this.onInput(conn.peer, msg.input, msg.meta);
      else if (msg.t === 'chat') this.onChatMsg && this.onChatMsg(msg.name, msg.text);
      else if (msg.t === 'hello') {
        if (this._openConns() > MAX_GUESTS) {
          try { conn.send({ t: 'denied', reason: 'Lobby is full (6 players).' }); } catch { }
          setTimeout(() => { try { conn.close(); } catch { } }, 400);
          return;
        }
        this.onMember && this.onMember(this._openConns(), msg);
        conn.send({ t: 'welcome', room: this.room });
        // late join straight into the running match
        if (this.gameInfo && this.gameInfo.started) conn.send({ t: 'start', seed: this.gameInfo.seed });
      }
    });
    conn.on('close', () => { this.conns.delete(conn.peer); this.onMember && this.onMember(this._openConns()); });
    conn.on('error', () => { });
  }

  _wireClientConn(conn) {
    this.clientConn = conn;
    conn.on('data', (msg) => {
      if (!msg) return;
      if (msg.t === 'snap') this.onSnapshot && this.onSnapshot(msg.snap);
      else if (msg.t === 'lobby') this.onLobby && this.onLobby(msg);
      else if (msg.t === 'start') this.onStart && this.onStart(msg.seed);
      else if (msg.t === 'denied') this.onDenied && this.onDenied(msg.reason || 'Join denied.');
      else if (msg.t === 'chat') this.onChatMsg && this.onChatMsg(msg.name, msg.text);
      else if (msg.t === 'welcome') { /* joined */ }
    });
    conn.on('error', () => { });
  }

  // host → all
  broadcastSnap(snap) {
    for (const [, c] of this.conns) { try { if (c.open) c.send({ t: 'snap', snap }); } catch { } }
  }
  broadcastChat(name, text) {
    for (const [, c] of this.conns) { try { if (c.open) c.send({ t: 'chat', name, text }); } catch { } }
  }
  broadcastLobby(info) {
    for (const [, c] of this.conns) { try { if (c.open) c.send({ t: 'lobby', ...info }); } catch { } }
  }
  broadcastStart(seed) {
    for (const [, c] of this.conns) { try { if (c.open) c.send({ t: 'start', seed }); } catch { } }
  }
  // client → host
  sendInput(input, meta) {
    try { if (this.clientConn && this.clientConn.open) this.clientConn.send({ t: 'input', input, meta }); } catch { }
  }
  sendHello(meta) {
    try { if (this.clientConn && this.clientConn.open) this.clientConn.send({ t: 'hello', ...meta }); } catch { }
  }
  sendChat(name, text) {
    try { if (this.clientConn && this.clientConn.open) this.clientConn.send({ t: 'chat', name, text }); } catch { }
  }
  get peerCount() { return this.isHost ? this._openConns() : (this.clientConn ? 1 : 0); }
  destroy() {
    try { this.clientConn && this.clientConn.close(); } catch { }
    try { this.peer && this.peer.destroy(); } catch { }
    this.peer = null; this.conns.clear(); this.clientConn = null;
  }
}
