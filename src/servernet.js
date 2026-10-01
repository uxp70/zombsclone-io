// WebSocket client for the dedicated ZombsClone server.
// Same message protocol as server/server.js. Replaces the old P2P layer:
// nobody hosts — the server simulates, every player is an equal client.
export class ServerNet {
  constructor() {
    this.ws = null;
    this._intentional = false;
    this.onSnapshot = null; this.onLobby = null; this.onStart = null;
    this.onDenied = null; this.onChatMsg = null; this.onEnd = null;
    this.onClose = null;
  }
  get connected() { return !!this.ws && this.ws.readyState === 1; }
  connect(url) {
    return new Promise((res, rej) => {
      this.destroy();
      this._intentional = false;
      let done = false;
      let ws;
      try { ws = new WebSocket(url); } catch (e) { rej(new Error('Bad server URL.')); return; }
      const to = setTimeout(() => { if (!done) { done = true; try { ws.close(); } catch { } rej(new Error('Server unreachable (' + url + '). Is it running?')); } }, 8000);
      ws.onopen = () => { if (!done) { done = true; clearTimeout(to); this.ws = ws; this._wire(); res(); } };
      ws.onerror = () => { if (!done) { done = true; clearTimeout(to); rej(new Error('Cannot reach server (' + url + ').')); } };
    });
  }
  _wire() {
    const ws = this.ws;
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (!msg || !msg.t) return;
      if (msg.t === 'snap') this.onSnapshot && this.onSnapshot(msg.snap);
      else if (msg.t === 'lobby') this.onLobby && this.onLobby(msg);
      else if (msg.t === 'start') this.onStart && this.onStart(msg.seed);
      else if (msg.t === 'denied') this.onDenied && this.onDenied(msg.reason || 'Denied.');
      else if (msg.t === 'chat') this.onChatMsg && this.onChatMsg(msg.name, msg.text);
      else if (msg.t === 'end') this.onEnd && this.onEnd(msg);
      else if (msg.t === 'welcome') { /* joined */ }
    };
    ws.onclose = () => {
      const wasIntentional = this._intentional;
      this.ws = null;
      if (!wasIntentional) this.onClose && this.onClose();
    };
    ws.onerror = () => { };
  }
  send(obj) {
    try { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj)); } catch { }
  }
  sendInput(input, _meta) { this.send({ t: 'input', input }); }
  sendHello(meta) { this.send({ t: 'hello', name: meta && meta.name }); }
  sendChat(name, text) { this.send({ t: 'chat', text }); }
  destroy() {
    this._intentional = true;
    try { this.ws && this.ws.close(); } catch { }
    this.ws = null;
  }
}
