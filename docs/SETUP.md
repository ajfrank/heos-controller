# HEOS Controller — Setup

The controller itself needs no special setup beyond `npm install` + Spotify
credentials (see README). The notes below cover the iPad wall-tablet kiosk
story and the optional custom icon.

## iPad kiosk mode

### 1. Install as PWA

On the iPad, open Safari to `http://<mac>.local:8080` (replace `<mac>` with
your Mac's hostname — `scutil --get LocalHostName` to check), then **Share
→ Add to Home Screen**. Launch from the home screen icon — no Safari chrome.

### 2. Lock to the app with Guided Access

Guided Access is the only true kiosk lock on iPadOS.

1. **Settings → Accessibility → Guided Access** → enable, set a passcode.
2. Open the controller from the home screen, then triple-click the side button.
3. Tap **Start** in the top-right. The iPad is now locked to the controller
   until you triple-click again and enter the passcode.

The app requests a Wake Lock on first interaction so the screen stays awake
while in use. iPadOS still dims after a while; if you want fully always-on,
**Settings → Display & Brightness → Auto-Lock → Never** while the iPad is on
its mount.

---

## Custom icon (optional)

Edit `web/public/icons/icon.svg`, then regenerate the PNG variants:

```sh
sips -s format png -z 192 192 web/public/icons/icon.svg --out web/public/icons/icon-192.png
sips -s format png -z 512 512 web/public/icons/icon.svg --out web/public/icons/icon-512.png
sips -s format png -z 180 180 web/public/icons/icon.svg --out web/public/icons/apple-touch-icon.png
```
