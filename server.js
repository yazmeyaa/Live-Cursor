const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const wsModule = require('ws');
const WebSocketServer = wsModule.WebSocketServer || wsModule.Server;
const Y = require('yjs');
const { setupWSConnection, docs: yWSdocs, getYDoc } = require('y-websocket/bin/utils');

const port = process.env.PORT || 4444;
const dbDir = process.env.DB_DIR || path.join(__dirname, 'data');
const sharedSecret = process.env.LAPLAS_COWORK_SECRET || '';
const protocolVersion = '2';

if (!sharedSecret) {
  throw new Error('LAPLAS_COWORK_SECRET is required. Refusing to start an unauthenticated sync server.');
}

function isAuthorized(urlObj) {
  const provided = urlObj.searchParams.get('pass') || '';
  const expectedBuffer = Buffer.from(sharedSecret);
  const providedBuffer = Buffer.from(provided);
  return expectedBuffer.length === providedBuffer.length && crypto.timingSafeEqual(expectedBuffer, providedBuffer);
}

// Create storage directories
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}
const roomsDir = path.join(dbDir, 'rooms');
if (!fs.existsSync(roomsDir)) {
  fs.mkdirSync(roomsDir, { recursive: true });
}
const configDir = path.join(dbDir, 'config');
if (!fs.existsSync(configDir)) {
  fs.mkdirSync(configDir, { recursive: true });
}

const saveTimeouts = new Map();
const roomMetadata = new Map();
const initializedRooms = new Set();
const hashCache = new Map();
const tombstonesPath = path.join(dbDir, 'tombstones.json');
const revisionsPath = path.join(dbDir, 'revisions.json');
let tombstones = {};
let revisions = {};

try {
  if (fs.existsSync(tombstonesPath)) {
    tombstones = JSON.parse(fs.readFileSync(tombstonesPath, 'utf8'));
  }
} catch (error) {
  console.error('[Database] Failed to load tombstones:', error);
}

try {
  if (fs.existsSync(revisionsPath)) {
    revisions = JSON.parse(fs.readFileSync(revisionsPath, 'utf8'));
  }
} catch (error) {
  console.error('[Database] Failed to load revisions:', error);
}

// Helper to get room path for persistence
function getRoomPath(roomId) {
  const digest = crypto.createHash('sha256').update(roomId).digest('hex');
  return path.join(roomsDir, digest + '.bin');
}

function saveRevisions() {
  const tempPath = revisionsPath + '.tmp';
  fs.writeFileSync(tempPath, JSON.stringify(revisions));
  fs.renameSync(tempPath, revisionsPath);
}

function getWorkspaceRevisions(workspace) {
  const key = workspace || 'default';
  return revisions[key] || (revisions[key] = {});
}

function getFileRevision(workspace, filePath) {
  return getWorkspaceRevisions(workspace)[filePath];
}

function recordFileRevision(workspace, filePath, hash, deleted, device, persist = true) {
  const workspaceRevisions = getWorkspaceRevisions(workspace);
  const previous = workspaceRevisions[filePath];
  if (previous && previous.hash === hash && Boolean(previous.deleted) === Boolean(deleted)) return previous;
  const next = {
    hash: hash || previous?.hash || '',
    revision: (previous?.revision || 0) + 1,
    deleted: Boolean(deleted),
    updatedAt: Date.now(),
    device: device || 'Server'
  };
  workspaceRevisions[filePath] = next;
  if (persist) saveRevisions();
  return next;
}

function observeServerFile(workspace, filePath, fullPath, stat = fs.statSync(fullPath), persist = true) {
  const hash = getFileHash(fullPath, stat);
  const current = getFileRevision(workspace, filePath);
  if (!current || current.hash !== hash || current.deleted) {
    const observed = recordFileRevision(workspace, filePath, hash, false, 'Server', persist);
    clearTombstone(workspace, filePath);
    return observed;
  }
  return current;
}

function getCurrentRevision(workspace, filePath, fullPath) {
  if (filePath.endsWith('.md')) {
    const roomName = getRequestedRoom({ workspace, path: filePath });
    const liveDoc = yWSdocs.get(roomName);
    if (liveDoc) {
      const liveHash = crypto.createHash('sha256').update(liveDoc.getText('content').toString()).digest('hex');
      const current = getFileRevision(workspace, filePath);
      if (!current || current.hash !== liveHash || current.deleted) {
        return recordFileRevision(workspace, filePath, liveHash, false, 'Server');
      }
      return current;
    }
  }
  if (fs.existsSync(fullPath)) return observeServerFile(workspace, filePath, fullPath);
  const current = getFileRevision(workspace, filePath);
  if (current) return current;
  const tombstone = getWorkspaceTombstones(workspace)[filePath];
  return tombstone
    ? recordFileRevision(workspace, filePath, tombstone.hash, true, tombstone.device)
    : undefined;
}

function getFileHash(filePath, stat = fs.statSync(filePath)) {
  const cached = hashCache.get(filePath);
  if (cached && cached.size === stat.size && cached.mtime === stat.mtimeMs) return cached.hash;
  const hash = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  hashCache.set(filePath, { size: stat.size, mtime: stat.mtimeMs, hash });
  return hash;
}

function saveTombstones() {
  const tempPath = tombstonesPath + '.tmp';
  fs.writeFileSync(tempPath, JSON.stringify(tombstones));
  fs.renameSync(tempPath, tombstonesPath);
}

function getWorkspaceTombstones(workspace) {
  return tombstones[workspace || 'default'] || {};
}

function setTombstone(workspace, filePath, value) {
  const key = workspace || 'default';
  tombstones[key] = tombstones[key] || {};
  tombstones[key][filePath] = value;
  saveTombstones();
}

function clearTombstone(workspace, filePath) {
  const key = workspace || 'default';
  if (!tombstones[key]?.[filePath]) return;
  delete tombstones[key][filePath];
  if (Object.keys(tombstones[key]).length === 0) delete tombstones[key];
  saveTombstones();
}

function resolveWorkspaceFile(workspaceDir, relativePath) {
  if (!relativePath || path.isAbsolute(relativePath)) throw new Error('Invalid path');
  const normalized = relativePath.replace(/\\/g, '/');
  const parts = normalized.split('/');
  if (
    parts.some(part => !part || part === '.' || part === '..') ||
    parts[0] === '.laplas-conflicts'
  ) throw new Error('Invalid path');
  const fullPath = path.resolve(workspaceDir, normalized);
  const root = path.resolve(workspaceDir);
  if (fullPath !== root && !fullPath.startsWith(root + path.sep)) throw new Error('Invalid path');
  return fullPath;
}

function getRequestedRoom(params) {
  return `${encodeURIComponent(params.workspace || 'default')}--${encodeURIComponent((params.path || '').replace(/\\/g, '/'))}`;
}

// Load document state from disk database
function loadDoc(roomId, doc, metadata) {
  const candidates = [getRoomPath(roomId)];
  const persistedPath = candidates.find(candidate => fs.existsSync(candidate));
  if (persistedPath) {
    try {
      const data = fs.readFileSync(persistedPath);
      Y.applyUpdate(doc, new Uint8Array(data));
      console.log(`[Database] Loaded persistent state for room: ${roomId}`);
    } catch (e) {
      console.error(`[Database] Failed to load room "${roomId}"`, e);
    }
  } else if (metadata?.workspace && metadata?.path?.endsWith('.md')) {
    try {
      const workspaceDir = getConfigWorkspacePath(metadata.workspace);
      const mirrorPath = resolveWorkspaceFile(workspaceDir, metadata.path);
      if (fs.existsSync(mirrorPath)) doc.getText('content').insert(0, fs.readFileSync(mirrorPath, 'utf8'));
    } catch (error) {
      console.error(`[Database] Failed to bootstrap room "${roomId}" from its file mirror`, error);
    }
  }
}

// Save document state to disk database
function saveDoc(roomId, doc) {
  const p = getRoomPath(roomId);
  try {
    const state = Y.encodeStateAsUpdate(doc);
    fs.writeFileSync(p, Buffer.from(state.buffer, state.byteOffset, state.byteLength));
    console.log(`[Database] Saved state for room: ${roomId}`);
  } catch (e) {
    console.error(`[Database] Failed to save room "${roomId}"`, e);
  }
}

function reconcileText(ytext, text) {
  const current = ytext.toString();
  if (current === text) return;
  let start = 0;
  while (start < current.length && start < text.length && current[start] === text[start]) start++;
  let currentEnd = current.length;
  let textEnd = text.length;
  while (currentEnd > start && textEnd > start && current[currentEnd - 1] === text[textEnd - 1]) {
    currentEnd--;
    textEnd--;
  }
  ytext.doc.transact(() => {
    if (currentEnd > start) ytext.delete(start, currentEnd - start);
    if (textEnd > start) ytext.insert(start, text.slice(start, textEnd));
  });
}

function persistRoom(roomName, doc) {
  saveDoc(roomName, doc);
  const metadata = roomMetadata.get(roomName);
  if (!metadata?.path?.endsWith('.md')) return;
  try {
    const workspaceDir = getConfigWorkspacePath(metadata.workspace);
    const mirrorPath = resolveWorkspaceFile(workspaceDir, metadata.path);
    fs.mkdirSync(path.dirname(mirrorPath), { recursive: true });
    fs.writeFileSync(mirrorPath, doc.getText('content').toString(), 'utf8');
    hashCache.delete(mirrorPath);
    observeServerFile(metadata.workspace, metadata.path, mirrorPath);
    clearTombstone(metadata.workspace, metadata.path);
  } catch (error) {
    console.error(`[Database] Failed to update file mirror for room "${roomName}"`, error);
  }
}

function getPersistentDoc(roomName, metadata) {
  if (metadata?.workspace && metadata?.path) roomMetadata.set(roomName, metadata);
  const doc = getYDoc(roomName);
  if (!initializedRooms.has(roomName)) {
    loadDoc(roomName, doc, metadata);
    doc.on('update', () => {
      const existing = saveTimeouts.get(roomName);
      if (existing) clearTimeout(existing);
      saveTimeouts.set(roomName, setTimeout(() => {
        persistRoom(roomName, doc);
        saveTimeouts.delete(roomName);
      }, 500));
    });
    initializedRooms.add(roomName);
  }
  return doc;
}

function destroyRoom(roomName) {
  const timeout = saveTimeouts.get(roomName);
  if (timeout) clearTimeout(timeout);
  saveTimeouts.delete(roomName);
  const doc = yWSdocs.get(roomName);
  if (doc?.conns) {
    for (const connection of doc.conns.keys()) connection.close();
  }
  if (doc) doc.destroy();
  yWSdocs.delete(roomName);
  initializedRooms.delete(roomName);
  roomMetadata.delete(roomName);
}

// Helper for parsing query params
function getQueryParams(reqUrl) {
  const urlObj = new URL(reqUrl, `http://localhost`);
  return Object.fromEntries(urlObj.searchParams.entries());
}

function getConfigWorkspacePath(workspace) {
  const safeWorkspace = encodeURIComponent(workspace || 'default').replace(/%20/g, '_');
  const wsDir = path.join(configDir, safeWorkspace);
  if (!fs.existsSync(wsDir)) {
    fs.mkdirSync(wsDir, { recursive: true });
  }
  return wsDir;
}

// Create standard HTTP server
const server = http.createServer((req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = urlObj.pathname;

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    return res.end();
  }

  if (!isAuthorized(urlObj)) {
    res.writeHead(401, { 'Content-Type': 'text/plain' });
    return res.end('Unauthorized');
  }

  if (urlObj.searchParams.get('protocol') !== protocolVersion) {
    res.writeHead(426, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Unsupported sync protocol', protocol: protocolVersion }));
  }

  console.log(`[HTTP] ${req.method} ${pathname}`);

  // --- GET /api/manifest ---
  if (pathname === '/api/manifest' && req.method === 'GET') {
    const params = getQueryParams(req.url);
    const wsDir = getConfigWorkspacePath(params.workspace);
    const manifest = {};

    function scanDir(dir) {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        const fullPath = path.join(dir, file);
        let stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          scanDir(fullPath);
        } else {
          const relPath = path.relative(wsDir, fullPath).replace(/\\/g, '/');
          if (relPath.endsWith('.md')) {
            const roomName = getRequestedRoom({ workspace: params.workspace, path: relPath });
            const liveDoc = yWSdocs.get(roomName);
            if (liveDoc) {
              persistRoom(roomName, liveDoc);
              stat = fs.statSync(fullPath);
            }
          }
          const revision = observeServerFile(params.workspace, relPath, fullPath, stat, false);
          manifest[relPath] = {
            size: stat.size,
            mtime: stat.mtimeMs,
            hash: revision.hash,
            revision: revision.revision,
            device: 'Server'
          };
        }
      }
    }
    
    try {
      scanDir(wsDir);
      for (const [relPath, storedRevision] of Object.entries(getWorkspaceRevisions(params.workspace))) {
        if (manifest[relPath]) continue;
        let deletedRevision = storedRevision;
        if (!storedRevision.deleted) {
          const tombstone = {
            deletedAt: Date.now(),
            hash: storedRevision.hash,
            device: 'Server'
          };
          setTombstone(params.workspace, relPath, tombstone);
          deletedRevision = recordFileRevision(params.workspace, relPath, storedRevision.hash, true, 'Server', false);
          const roomName = getRequestedRoom({ workspace: params.workspace, path: relPath });
          destroyRoom(roomName);
          const roomPath = getRoomPath(roomName);
          if (fs.existsSync(roomPath)) fs.unlinkSync(roomPath);
        }
        manifest[relPath] = {
          size: 0,
          mtime: deletedRevision.updatedAt,
          hash: deletedRevision.hash,
          revision: deletedRevision.revision,
          deleted: true,
          device: deletedRevision.device || 'Server'
        };
      }
      for (const [relPath, tombstone] of Object.entries(getWorkspaceTombstones(params.workspace))) {
        if (!manifest[relPath]) {
          const revision = getCurrentRevision(
            params.workspace,
            relPath,
            resolveWorkspaceFile(wsDir, relPath)
          );
          manifest[relPath] = {
            size: 0,
            mtime: tombstone.deletedAt,
            hash: tombstone.hash,
            revision: revision.revision,
            deleted: true,
            device: tombstone.device || 'Server'
          };
        }
      }
      saveRevisions();
      console.log(`[HTTP] 200 OK /api/manifest - Scanned ${Object.keys(manifest).length} files for workspace: ${params.workspace}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(manifest));
    } catch (e) {
      console.error(`[HTTP] 500 Error /api/manifest: ${e.message}`);
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // --- POST /api/upload ---
  if (pathname === '/api/upload' && req.method === 'POST') {
    const params = getQueryParams(req.url);
    const wsDir = getConfigWorkspacePath(params.workspace);
    const relPath = params.path;
    const baseRevision = Number(params.baseRevision);
    
    if (!relPath || !Number.isInteger(baseRevision) || baseRevision < 0) {
      console.warn(`[HTTP] 400 Bad Request /api/upload - Invalid path: ${relPath}`);
      res.writeHead(400);
      return res.end('Invalid path');
    }

    let fullPath;
    try {
      fullPath = resolveWorkspaceFile(wsDir, relPath);
    } catch {
      res.writeHead(400);
      return res.end('Invalid path');
    }
    const targetDir = path.dirname(fullPath);
    
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const buffer = Buffer.concat(chunks);
      try {
        const current = getCurrentRevision(params.workspace, relPath, fullPath);
        const currentRevision = current?.revision || 0;
        if (currentRevision !== baseRevision) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Revision conflict', current }));
        }
        fs.writeFileSync(fullPath, buffer);
        hashCache.delete(fullPath);
        clearTombstone(params.workspace, relPath);
        const hash = crypto.createHash('sha256').update(buffer).digest('hex');
        const revision = recordFileRevision(params.workspace, relPath, hash, false, params.user);

        // Set the file's mtime to what the client sent, if provided
        if (params.mtime) {
          const mtime = parseInt(params.mtime) / 1000;
          try {
            fs.utimesSync(fullPath, mtime, mtime);
          } catch(e) {}
        }

        // If it's a markdown file, sync the Yjs room state binary to match this new text!
        if (relPath.endsWith('.md')) {
          const text = buffer.toString('utf-8');
          const roomName = getRequestedRoom(params);
          const doc = getPersistentDoc(roomName, { workspace: params.workspace, path: relPath });
          const ytext = doc.getText('content');
          reconcileText(ytext, text);
          persistRoom(roomName, doc);
          console.log(`[Database] Updated Yjs state for ${roomName} from uploaded file`);
        }

        console.log(`[HTTP] 200 OK /api/upload - Path: ${relPath} for workspace: ${params.workspace}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ hash: revision.hash, revision: revision.revision }));
      } catch (err) {
        console.error(`[HTTP] 500 Error /api/upload:`, err);
        res.writeHead(500);
        res.end(`Upload failed: ${err.message}`);
      }
    });
    return;
  }

  // --- GET /api/download ---
  if (pathname === '/api/download' && req.method === 'GET') {
    const params = getQueryParams(req.url);
    const wsDir = getConfigWorkspacePath(params.workspace);
    const relPath = params.path;
    
    if (!relPath) {
      console.warn(`[HTTP] 400 Bad Request /api/download - Invalid path: ${relPath}`);
      res.writeHead(400);
      return res.end('Invalid path');
    }

    let fullPath;
    try {
      fullPath = resolveWorkspaceFile(wsDir, relPath);
    } catch {
      res.writeHead(400);
      return res.end('Invalid path');
    }
    if (!fs.existsSync(fullPath)) {
      console.warn(`[HTTP] 404 Not Found /api/download - Path: ${relPath}`);
      res.writeHead(404);
      return res.end('File not found');
    }

    console.log(`[HTTP] 200 OK /api/download - Path: ${relPath} for workspace: ${params.workspace}`);
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    fs.createReadStream(fullPath).pipe(res);
    return;
  }
  // --- DELETE /api/delete ---
  if (pathname === '/api/delete' && req.method === 'DELETE') {
    const params = getQueryParams(req.url);
    const wsDir = getConfigWorkspacePath(params.workspace);
    const relPath = params.path;
    const baseRevision = Number(params.baseRevision);
    
    if (!relPath || !Number.isInteger(baseRevision) || baseRevision < 1) {
      console.warn(`[HTTP] 400 Bad Request /api/delete - Invalid path: ${relPath}`);
      res.writeHead(400);
      return res.end('Invalid path');
    }

    let fullPath;
    try {
      fullPath = resolveWorkspaceFile(wsDir, relPath);
    } catch {
      res.writeHead(400);
      return res.end('Invalid path');
    }
    console.log(`[HTTP] DELETE /api/delete?user=${params.user}&workspace=${params.workspace}&path=${encodeURIComponent(relPath)} - Request received`);

    const current = getCurrentRevision(params.workspace, relPath, fullPath);
    if (!current || current.revision !== baseRevision || current.deleted) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Revision conflict', current }));
    }

    const roomName = getRequestedRoom(params);
    const roomPaths = [getRoomPath(roomName)];

    let deletedHash = getWorkspaceTombstones(params.workspace)[relPath]?.hash;
    if (fs.existsSync(fullPath)) {
      try { deletedHash = getFileHash(fullPath); } catch {}
    }
    setTombstone(params.workspace, relPath, {
      deletedAt: Date.now(),
      hash: deletedHash,
      device: params.user || 'Unknown Device'
    });
    const deletedRevision = recordFileRevision(
      params.workspace,
      relPath,
      deletedHash,
      true,
      params.user || 'Unknown Device'
    );

    destroyRoom(roomName);

    for (const roomPath of new Set(roomPaths)) {
      if (fs.existsSync(roomPath)) {
        try {
          fs.unlinkSync(roomPath);
          console.log(`[Database] Deleted room state for: ${roomName}`);
        } catch (e) {
          console.error(`[Database] Failed to delete room state:`, e);
        }
      }
    }

    if (fs.existsSync(fullPath)) {
      try {
        fs.unlinkSync(fullPath);
        hashCache.delete(fullPath);
        console.log(`[HTTP] 200 OK /api/delete - Path: ${relPath} for workspace: ${params.workspace}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ hash: deletedRevision.hash, revision: deletedRevision.revision, deleted: true }));
      } catch (e) {
        console.error(`[HTTP] 500 Error /api/delete: ${e.message}`);
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      }
    } else {
      console.log(`[HTTP] 200 OK /api/delete (Already missing) - Path: ${relPath}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ hash: deletedRevision.hash, revision: deletedRevision.revision, deleted: true }));
    }
    return;
  }


  // --- GET /api/room-state ---
  if (pathname === '/api/room-state' && req.method === 'GET') {
    const params = getQueryParams(req.url);
    const relPath = params.path;
    if (!relPath) {
      res.writeHead(400);
      return res.end('Missing path');
    }
    const roomName = getRequestedRoom(params);
    console.log(`[HTTP] GET /api/room-state - Path: ${relPath} for workspace: ${params.workspace}`);
    
    const doc = getPersistentDoc(roomName, { workspace: params.workspace, path: relPath });
    const update = Y.encodeStateAsUpdate(doc);
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.end(Buffer.from(update.buffer, update.byteOffset, update.byteLength));
    return;
  }

  // --- POST /api/room-state ---
  if (pathname === '/api/room-state' && req.method === 'POST') {
    res.writeHead(410, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Snapshot CRDT merging was removed; use revisioned file sync or WebSocket updates.' }));
    return;
  }

  console.log(`[HTTP] 200 OK / (default root status check page)`);
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Laplas Cowork Sync Server (WebSocket + DB) is running.');
});

// Create WebSocket server
const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const roomName = url.pathname.replace(/^\/+/, '');
  const workspace = url.searchParams.get('workspace') || 'default';
  const filePath = url.searchParams.get('path') || '';

  console.log(`[+] Client connected to room: ${roomName}`);

  // Pre-load or retrieve the shared doc instance before connection setup so Yjs
  // has correct disk state BEFORE synchronization begins!
  getPersistentDoc(roomName, { workspace, path: filePath });

  // Bind connection to standard y-websocket protocol — this uses our pre-loaded doc
  setupWSConnection(ws, req, { docName: roomName });
});

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  if (!isAuthorized(url)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  if (url.searchParams.get('protocol') !== protocolVersion) {
    socket.write('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  const workspace = url.searchParams.get('workspace') || 'default';
  const filePath = url.searchParams.get('path') || '';
  const roomName = url.pathname.replace(/^\/+/, '');
  if (!filePath || roomName !== getRequestedRoom({ workspace, path: filePath })) {
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  if (filePath && getWorkspaceTombstones(workspace)[filePath]) {
    socket.write('HTTP/1.1 410 Gone\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  try {
    const workspaceDir = getConfigWorkspacePath(workspace);
    const mirrorPath = resolveWorkspaceFile(workspaceDir, filePath);
    if (!fs.existsSync(mirrorPath)) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
  } catch {
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

server.listen(port, '0.0.0.0', () => {
  const actualPort = server.address().port;
  console.log('===================================================');
  console.log('       LAPLAS COWORK PRIVATE SYNC SERVER             ');
  console.log('===================================================');
  console.log(`[*] Version: 2.1.1`);
  console.log(`[*] Mode: Self-hosted`);
  console.log(`[*] Port: ${actualPort}`);
  console.log(`[*] Database Directory: ${dbDir}`);
  console.log(`[*] Listening on: 0.0.0.0:${actualPort}`);
  console.log('===================================================');
});

// Flush pending saves on server termination
function flushAllDocs() {
  console.log('[Database] Flushing all documents to disk before shutdown...');
  for (const [roomName, doc] of yWSdocs.entries()) {
    saveDoc(roomName, doc);
  }
}
process.on('SIGTERM', () => {
  flushAllDocs();
  process.exit(0);
});
process.on('SIGINT', () => {
  flushAllDocs();
  process.exit(0);
});
