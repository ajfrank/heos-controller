# House Music — a simpler HEOS controller

A small self-hosted web app that replaces the official HEOS app for the two things that actually matter:

1. Pick which **rooms** to play in.
2. Play music from **Spotify**.

Runs on your Mac, opens in any browser on your Wi-Fi (phone, tablet, laptop).

## Architecture (one paragraph)

A Node.js server on your Mac talks to your HEOS speakers over the local HEOS CLI protocol (TCP 1255). Spotify playback uses Spotify Connect — HEOS speakers register themselves as Spotify devices, so the server tells Spotify "play X on this speaker." The web UI is a single screen built with HeroUI + Tailwind, animated with framer-motion: now-playing card on top, zone tiles, then a Spotify search box that returns tracks, playlists, and albums.

## One-time setup

### 1. Install Node 20+

```sh
brew install node
```

### 2. Register a Spotify app

1. Go to https://developer.spotify.com/dashboard and create a free app.
2. In the app's settings, add this Redirect URI: `http://127.0.0.1:8080/api/spotify/callback`.
3. Copy the Client ID and Client Secret.

### 3. Configure this app

```sh
cd "Random AI Stuff/Heos"
cp .env.example .env
# edit .env and paste your Spotify credentials
npm install
```

### 4. (Optional) Set HEOS speaker IP

The server auto-discovers a HEOS speaker via SSDP. If discovery is flaky on your network, find any HEOS speaker's IP (it's in the official HEOS app under Settings → My Devices) and add to `.env`:

```
HEOS_HOST=192.168.1.42
```

## Running

```sh
# dev mode (live reload for both server and web)
npm run dev

# production-style: build the web app and serve it from the Node server
npm start
```

Then open `http://localhost:8080` on your Mac, or `http://<your-mac-name>.local:8080` on any other device on the same Wi-Fi.

On first load, click the **Connect Spotify** banner and complete the OAuth flow in your browser. Tokens are stored at `~/.heos-controller/spotify-tokens.json` and refreshed automatically.

## Verifying everything works

In order, expect each of these to succeed:

1. **Server starts**: terminal shows `[heos] connected`.
2. **UI loads**: browser shows your zones as buttons.
3. **Spotify**: tap a zone, then search for a song → it plays in that room within a few seconds.
4. **Multi-room**: tap two zones, then play → both rooms play in sync.
5. **Phone**: open `http://<mac>.local:8080` in iPhone Safari → same UI, thumb-friendly.
6. **Tablet**: in iPad Safari, tap the share icon → "Add to Home Screen" → opens fullscreen.

## File layout

```
server/
  index.js     — Express + WebSocket entry, REST API, Spotify OAuth callback
  heos.js      — HEOS CLI client (SSDP discovery + TCP protocol)
  spotify.js   — Spotify Web API + token storage
  state.js     — Shared in-memory state with change events
web/
  index.html
  vite.config.js
  tailwind.config.js, postcss.config.js
  src/
    App.jsx, main.jsx, api.js, index.css
    components/{NowPlaying,ZoneGrid,SearchResults,Backdrop}.jsx
```

## Out of scope for v1 (easy follow-ups)

- Always-on hosting on a Raspberry Pi (so the controller works when your Mac is asleep).
- Sleep timers, alarms, EQ.
- Per-zone different audio sources at the same time.

## Troubleshooting

- **"No HEOS speaker responded to SSDP"**: your Mac must be on the same Wi-Fi as the speakers. Add `HEOS_HOST=<ip>` to `.env` to skip discovery.
- **"No Spotify Connect device matching HEOS player"**: the speaker has gone to sleep. Tap any control on it (or play one second of audio in the official HEOS app) to wake it up.
- **Wife still doesn't like it**: open an issue with what specifically would make it better.
