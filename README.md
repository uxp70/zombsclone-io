# ZombsClone.io — open-source ZombsRoyale.io clone

2D top-down battle royale in vanilla JS + Canvas. Solo vs bots offline, **online multiplayer on a dedicated server** (authoritative Node sim, no player hosts). Deploy the static client to **GitHub Pages** + run the server anywhere Node runs.

Inspired by [ZombsRoyale.io](https://en.wikipedia.org/wiki/ZombsRoyale.io).

## Play

- Open `index.html` (or the GitHub Pages URL) → optional login → **🤖 PLAY VS BOTS** (offline, up to 100 bots) or **🌐 PLAY ONLINE** (humans only, auto-joins a public lobby, starts 30s after 2+ real players)
- Solo/Duo/Squad team sizes apply to bots mode. Online is free-for-all.

## Controls

| Key | Action |
|---|---|
| WASD / arrows | move |
| Mouse | aim, click / Space shoot |
| Space / F | jump from plane |
| E | pick up loot |
| R | reload |
| 1–4 | switch weapon |
| Q | bandage, X shield/medkit |
| M | big map, Enter custom chat |

Mobile: left-half virtual stick moves, right-half aims + fires.

## Features (accuracy notes)

- Grid grass, roads, ponds (slow), trees/rocks/crates/barrels/bushes, walled compounds with door gaps
- Loot tiers Common→Legendary (gray/green/blue/purple/gold) × Pistol/SMG/Shotgun/AR/Burst/LMG/Sniper + ammo/heals/shield
- Pre-match **lobby plaza** with countdown, plane flyover, steerable **parachute** (no shooting until you land), 🕊️ **grace period** where bots hold fire (they still retaliate), and a re-coded **storm**: no full-screen wash — a pulsing energy wall marks the zone rim, next circle stays gold, and caught players get an arrow + distance readout
- 9000px map with 13 named POIs (Mansion, Lab, Farm…), 30 enterable **houses with doors + roofs** — interiors stay hidden until you're inside or at the door, guns come **only from chests**: 🎁 basic (1×1) and 💛 golden (1×2, better loot, glow) — in houses, POIs and the wilds. Press **E** to open. Ground loot and crates give ammo/heals only.
- 13 weapons: Fists, Pistol, Revolver, SMG, Shotgun, Assault, Burst, LMG, Minigun (slows you down), Scout, Sniper, Crossbow, grenade **Launcher** (AoE explosions) — each with a distinct shaded in-hand model (also shown in the HUD slots) and 5 rarity tiers
- Bots: trickle into the lobby gradually, scatter-drop across the map, seek chests when unarmed, unstick themselves from walls, loot scoring, zone rotation, strafing, healing, crate-breaking. Bots never chat.
- Custom chat: press **Enter**, type your message, **Enter** again to send (**Esc** cancels). Shown as a bubble + in the chat log, relayed to P2P friends.
- Procedural WebAudio SFX (no assets)

## Accounts (login system)

No server needed: register/login on the menu with a username + password.
Accounts live in the browser (`localStorage`), passwords are salted +
SHA-256 hashed, and each account keeps persistent stats (games / kills /
wins) plus a body color (reroll with 🎨). Logged-in players always play
under their username; guests can still play via the nickname field.

> Local auth stops casual snooping, not a determined attacker with device
> access. True cross-device accounts would need a backend.

## Why P2P and not a dedicated server?

GitHub Pages serves **static files only**. A real 100-player authoritative server (Node + WebSockets) can't run there. So:

- `src/servernet.js` speaks to the dedicated server over WebSocket: server simulates, every browser is an equal client with interpolated remote players, synced guns + killfeed.
- **No rooms, no codes, no bots**: press **🌐 PLAY ONLINE** to auto-matchmake into a public lobby (5 slots). First arrival hosts; the match starts 30s after 2+ humans join and waits as long as needed. Small lobbies get a tighter starting zone. Leavers are removed cleanly; stalled guests auto-rejoin once, then exit with a message. A tiny H/G readout under the alive counter shows connection health.
- Want true massive online? Self-host `server/` (not included — see issues) and point the client at a WebSocket URL. The `Game.snapshot()` / `applySnapshot()` protocol is already decoupled for this.

## Run the server (for online play)

The client is static, but online needs the Node server running somewhere reachable:

```bash
npm install --prefix server
npm start --prefix server        # ws://localhost:8081 (or $PORT), /health for checks
```

- **Same PC / LAN:** both players press 🌐 PLAY ONLINE with the server field set to `ws://<host-ip>:8081`. Use the **Test** button on the menu to check reachability first.
- **Internet (free):** host it on Render in one click (free tier sleeps when idle — the client retries while it wakes):

  [![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/uxp70/zombsclone-io)

  Then put your `wss://<your-app>.onrender.com` URL in the menu's server field (it remembers it). `render.yaml` + `/health` checks are already in the repo.
- Protocol is plain JSON (`hello`/`input`/`chat` → `welcome`/`lobby`/`start`/`snap`/`end`/`denied`). Snapshots are trimmed to ~12KB @ 10Hz; clients interpolate between them and show a 🌐 readout (snapshot age, red STALE when starved, auto-retry + re-queue on drops).

## Run locally

```bash
# any static server (ES modules need http, not file://)
npx serve .
# or
python -m http.server 8080
```

## Deploy (GitHub Pages)

Push to `main`; workflow `.github/workflows/pages.yml` publishes the repo root. Enable **Settings → Pages → Source: GitHub Actions**.

## Structure

```
index.html      menu + HUD + canvas
styles.css
src/config.js   weapons/rarities/bots/gas tuning
src/world.js    seeded map gen (compounds, scatter, loot)
src/bots.js     bot FSM AI
src/servernet.js  WebSocket client for the dedicated server
src/game.js     sim + render (plane, gas, combat, minimap)
src/audio.js    procedural SFX
src/main.js     menu/HUD/P2P wiring
```

## License

MIT — clean-room clone, no ZombsRoyale assets copied.
