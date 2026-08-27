# Live Cursor for Obsidian

Live Cursor provides real-time collaborative editing, collaborator cursors, and background vault synchronization for Obsidian through a single self-hosted sync server.

---

## Architecture & Connection Modes

All clients connect to the same WebSocket/HTTP server and use the same room name. Markdown files use Yjs while they are open; closed notes and other vault files use hash-based background synchronization.

### 1. Host Local (LAN/Tailscale) 
**Best for:** Desktop users who want a quick, private sync session with other computers on their Wi-Fi or VPN.

- **How it works:** When you click "Start Local Host" on a Desktop PC, Live Cursor starts the bundled sync daemon on port 4444. Other devices connect to it using the desktop's LAN or Tailscale address (for example, `ws://192.168.1.12:4444`).
- **Simplicity:** No terminals, no Docker, no configuration files. One click and your PC is the server.
- **Limitations:** Only works on Desktop OS (Windows, Mac, Linux). Mobile devices (iOS/Android) cannot act as the "Host" in this mode because mobile operating systems block background TCP port binding. Mobile devices **can** easily join this host, but they cannot *be* the host.

### 2. Cloud Server
**Best for:** Enterprise teams, 24/7 always-on sync environments, and heavy multi-user collaboration.

- **How it works:** You deploy the background daemon (via Docker or Node) on a dedicated cloud VPS (like DigitalOcean, AWS, or a Raspberry Pi). You then point your Live Cursor settings to that `ws://` URL.
- **Limitations:** Requires technical knowledge to deploy a cloud server, setup DNS, and manage SSL/TLS if you want secure web-socket (`wss://`) traffic.

---

## Features

- **Real-Time Cursor Tracking**: View the live cursors and text selections of other vault editors inside your notes with custom user profiles and dynamic hex colors.
- **Background Vault Sync**: Content hashes detect real changes without relying on two-second timestamp windows.
- **Safe Conflicts and Deletes**: Divergent markdown is preserved as a conflict copy, while deletion tombstones prevent unchanged files from reappearing.

---

## Submitting to the Obsidian Community Plugins Tab

To make this plugin downloadable directly from the official Community Plugins catalog inside Obsidian, follow these steps:

### 1. Build and Release
Compile the plugin code locally:
```bash
npm run build
```
This updates `main.js` and creates the standalone `server.bundle.js` background daemon.

Create a new Release in your GitHub repository (`Live-Cursor/Live-Cursor`):
- Name the release exactly matching your version in `manifest.json` (e.g. `1.0.0`).
- Attach the following three compiled files as assets to the GitHub Release:
  1. `main.js`
  2. `server.bundle.js`
  3. `manifest.json`

### 2. Submit to Obsidian Releases
1. Fork the official [obsidianmd/obsidian-releases](https://github.com/obsidianmd/obsidian-releases) repository on GitHub.
2. Edit `community-plugins.json` inside your fork and append your plugin configuration object at the end:
   ```json
   {
     "id": "live-cursor",
     "name": "Live Cursor",
     "author": "Live-Cursor Organization",
     "description": "Real-time collaborative editing and cursor tracking for Obsidian notes.",
     "repo": "Live-Cursor/Live-Cursor"
   }
   ```
3. Commit the change and submit a Pull Request to the `obsidian-releases` repository. The Obsidian development team will automatically review, verify compliance, and add it to the live catalog!

---

## License

This project is licensed under the MIT License.
