# Laplas Cowork

Laplas Cowork adds real-time collaborative editing, collaborator cursors, and background vault synchronization to Obsidian through a self-hosted WebSocket/HTTP server.

This repository is an independently maintained fork of the original Live Cursor project.

## Features

- Real-time collaborative editing and cursor presence for open Markdown notes.
- Hash-based background synchronization for closed notes and other vault files.
- Conflict copies when both local and remote content changed.
- Deletion tombstones that prevent unchanged files from reappearing.
- One-click local server on desktop; mobile devices can connect as clients.
- Shared-secret authentication for every HTTP and WebSocket request.

## Quick start

Windows users can follow the detailed [Windows installation guide](WINDOWS_INSTALL.md).

1. Install and enable the plugin on each device.
2. On the desktop that will host synchronization, keep the default `ws://localhost:4444` URL and start the local server.
3. Open the plugin settings and copy the room name and generated shared secret to every other device.
4. On other devices, set the server URL to the host address, for example `ws://192.168.1.12:4444`.
5. Open the same Markdown note on multiple devices.

The desktop host must remain running. Mobile devices can join a server but cannot host one.

## Security and privacy

The plugin sends vault paths, file contents, modification metadata, the configured nickname, and live cursor presence to the server selected in settings. It does not include analytics or connect to a vendor-operated service.

The desktop host starts a bundled Node.js child process, listens on `0.0.0.0:4444`, and stores its database under the plugin's `data` directory. The generated shared secret is stored in Obsidian plugin settings and is included in requests to the server.

Use `wss://` through a trusted TLS reverse proxy when traffic crosses an untrusted network. The shared secret controls access, but vault contents are not end-to-end encrypted by this plugin. Anyone who obtains both the server address and shared secret can read or change synchronized data.

The background synchronizer excludes `.git`, `.trash`, `node_modules`, installed plugin directories, device-specific workspace state, and its conflict directory. Review conflict copies before deleting them.

## External server

The bundled local server is sufficient for LAN or VPN use. For an always-on host, build the included Docker image and provide a strong secret at runtime:

```bash
docker build -t laplas-cowork .
docker run --rm -p 4444:4444 \
  -e LAPLAS_COWORK_SECRET='replace-with-a-long-random-secret' \
  -v laplas-cowork-data:/app/data \
  laplas-cowork
```

Configure the same secret and server URL in every client. The server refuses to start without `LAPLAS_COWORK_SECRET`.

## Development

```bash
npm ci --legacy-peer-deps
npm run typecheck
npm test
npm run build
```

The build embeds the desktop daemon in `main.js`. At runtime the desktop plugin extracts that bundled code into its own private data directory. A Community Plugins release therefore needs only:

- `main.js`
- `manifest.json`
- `styles.css`, if one is added later

The release tag must exactly match the version in `manifest.json` without a leading `v`. The included GitHub Actions workflow builds and uploads the required assets.

## Manual installation

Create `<vault>/.obsidian/plugins/laplas-cowork/`, copy `main.js` and `manifest.json` into it, then enable **Laplas Cowork** in Obsidian. The repository's `install.sh` performs these steps for the local paths configured at the top of that script.

## Attribution

This project is a modified fork of [Live Cursor](https://github.com/Live-Cursor/Live-Cursor), originally developed by the Live-Cursor contributors.

The original project and this fork are distributed under the MIT License. The original copyright and permission notice are preserved in [LICENSE](LICENSE).

Copyright (c) 2026 Live-Cursor

Copyright (c) 2026 yazmeyaa (modifications)

This fork is independently maintained and is not endorsed by the original authors.

## License

MIT. See [LICENSE](LICENSE).
