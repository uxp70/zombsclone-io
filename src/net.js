// P2P online via PeerJS cloud (free, no server to host). Host-authoritative.
// Solo: no net, bots fill to BOT_COUNT. Friends: host simulates, guests send inputs.
export class P2PNet {
  constructor() {
    this.peer = null; this.conns = new Map(); this.isHost = false;
    this.room = null; this.onPeers = null; this.onSnapshot = null; this.onInput = null;
    this.onChatMsg = null; this.onMember = null;
  }
  get supported() { return typeof window !== 'undefined' && typeof window.Peer !== 'undefined'; }
  makeCode() {
    const c = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    let s = ''; for (let i = 0; i < 4; i++) s += c[(Math.random() * c.length) | 0];
    return s;
  }
  async host() {
    if (!this.supported) throw new Error('P2P lib not loaded (offline?)');
    const code = this.makeCode();
    await this._open('zombsclone-' + code);
    this.isHost = true; this.room = code;
    this.peer.on('connection', (c) => this._wireHostConn(c));
    return code;
  }
  async join(code) {
    if (!this.supported) throw new Error('P2P lib not loaded (offline?)');
    code = (code || '').trim().toUpperCase();
    await this._open('zombsclone-' + code + '-' + Math.random().toString(36).slice(2, 7));
    this.isHost = false; this.room = code;
    const conn = this.peer.connect('zombsclone-' + code, { reliable: true });
    await new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error('Host not found. Check code + both online.')), 9000);
      conn.on('open', () => { clearTimeout(to); res(); });
      conn.on('error', (e) => { clearTimeout(to); rej(e); });
    });
    this._wireClientConn(conn);
    return code;
  }
  _open(id) {
    return new Promise((res, rej) => {
      this.destroy();
      this.peer = new window.Peer(id);
      this.peer.on('open', () => res());
      this.peer.on('error', (e) => {
        if (e && e.type === 'unavailable-id') rej(new Error('Room taken, retry.'));
        else if (e && e.type === 'peer-unavailable') rej(new Error('Room not found.'));
      });
    });
  }
  _wireHostConn(conn) {
    conn.on('open', () => {
      this.conns.set(conn.peer, conn);
      this.onMember && this.onMember(this.conns.size);
    });
    conn.on('data', (msg) => {
      if (!msg) return;
      if (msg.t === 'input') this.onInput && this.onInput(conn.peer, msg.input, msg.meta);
      else if (msg.t === 'chat') this.onChatMsg && this.onChatMsg(msg.name, msg.text);
      else if (msg.t === 'hello') {
        // reply with accept; game layer adds player
        this.onMember && this.onMember(this.conns.size, msg);
        conn.send({ t: 'welcome', room: this.room });
      }
    });
    conn.on('close', () => { this.conns.delete(conn.peer); this.onMember && this.onMember(this.conns.size); });
  }
  _wireClientConn(conn) {
    this.clientConn = conn;
    conn.on('data', (msg) => {
      if (!msg) return;
      if (msg.t === 'snap') this.onSnapshot && this.onSnapshot(msg.snap);
      else if (msg.t === 'chat') this.onChatMsg && this.onChatMsg(msg.name, msg.text);
      else if (msg.t === 'welcome') { /* joined */ }
    });
  }
  // host → all
  broadcastSnap(snap) {
    for (const [, c] of this.conns) { try { if (c.open) c.send({ t: 'snap', snap }); } catch { } }
  }
  broadcastChat(name, text) {
    for (const [, c] of this.conns) { try { if (c.open) c.send({ t: 'chat', name, text }); } catch { } }
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
  get peerCount() { return this.isHost ? this.conns.size : (this.clientConn ? 1 : 0); }
  destroy() {
    try { this.clientConn && this.clientConn.close(); } catch { }
    try { this.peer && this.peer.destroy(); } catch { }
    this.peer = null; this.conns.clear(); this.clientConn = null;
  }
}
