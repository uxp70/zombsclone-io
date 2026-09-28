# ZombsClone.io — open-source ZombsRoyale.io clone

2D top-down battle royale in vanilla JS + Canvas. Solo vs bots offline, **P2P online with friends** (WebRTC via PeerJS cloud — no server to host), bots fill lobby gaps. Deployable to **GitHub Pages** as pure static files.

Inspired by [ZombsRoyale.io](https://en.wikipedia.org/wiki/ZombsRoyale.io).

## Play

- Open `index.html` (or the GitHub Pages URL) → nickname → Solo/Duo/Squad → **PLAY**
- **Solo**: offline, 75 bots, shrinking poison-gas zone, plane drops
- **Play with friends**: `Create Room` → share 4-letter code → friends `Join`. Host simulates authoritatively at 12 snaps/s; bots backfill. Duo/Squad shares a team with the host.

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
- Pre-match **lobby plaza** with countdown, plane flyover, steerable **parachute** (no shooting until you land), 🕊️ **grace period** where bots hold fire (they still retaliate), shrinking gas circles
- 6000px map with 13 named POIs (Mansion, Lab, Farm…), pine forests, rocky corner, 900+ obstacles
- Bots: trickle into the lobby gradually, scatter-drop across the map, loot scoring, zone rotation, strafing, range-keeping, miss-skill, healing, crate-breaking. Bots never chat.
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

- `src/net.js` uses PeerJS cloud for NAT-traversed WebRTC: host = authority, guests relay inputs.
- Rooms are **public by default**: anyone with the 4-letter code or invite link (`?room=CODE`, auto-joins) can drop in. Hosts can switch to **Private** + password instead.
- Want true massive online? Self-host `server/` (not included — see issues) and point the client at a WebSocket URL. The `Game.snapshot()` / `applySnapshot()` protocol is already decoupled for this.

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
src/net.js      PeerJS P2P rooms
src/game.js     sim + render (plane, gas, combat, minimap)
src/audio.js    procedural SFX
src/main.js     menu/HUD/P2P wiring
```

## License

MIT — clean-room clone, no ZombsRoyale assets copied.
