const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const Y = require('yjs');
const { WebsocketProvider } = require('y-websocket');
const WebSocket = require('ws');

const waitFor = async (predicate, message, timeout = 5000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(message);
};

const onceSynced = provider => new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error(`Timed out syncing ${provider.url}`)), 5000);
  provider.on('sync', synced => {
    if (synced) {
      clearTimeout(timeout);
      resolve();
    }
  });
  provider.connect();
});

test('WebSocket, HTTP mirror, room state, and tombstones share one document', async t => {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'laplas-cowork-test-'));
  const sharedSecret = 'integration-test-secret';
  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PORT: '0', DB_DIR: dbDir, LAPLAS_COWORK_SECRET: sharedSecret },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let serverOutput = '';
  server.stdout.on('data', chunk => { serverOutput += chunk; });
  server.stderr.on('data', chunk => { serverOutput += chunk; });

  const providers = [];
  t.after(async () => {
    for (const provider of providers) {
      provider.destroy();
      provider.doc.destroy();
    }
    server.kill('SIGTERM');
    if (server.exitCode === null) await new Promise(resolve => server.once('exit', resolve));
    fs.rmSync(dbDir, { recursive: true, force: true });
  });

  await waitFor(() => serverOutput.includes('[*] Listening on:'), `Server did not start:\n${serverOutput}`);
  const port = Number(serverOutput.match(/Listening on: 0\.0\.0\.0:(\d+)/)?.[1]);
  assert.ok(port > 0, `Could not determine server port from:\n${serverOutput}`);

  const workspace = 'team room';
  const filePath = 'Folder/Shared note.md';
  const room = `${encodeURIComponent(workspace)}--${encodeURIComponent(filePath)}`;
  const serverUrl = `ws://127.0.0.1:${port}`;
  const apiUrl = `http://127.0.0.1:${port}/api`;
  const protocol = '2';
  const query = new URLSearchParams({ workspace, path: filePath, pass: sharedSecret, protocol });

  const legacyProtocol = await fetch(`${apiUrl}/manifest?workspace=${encodeURIComponent(workspace)}&pass=${encodeURIComponent(sharedSecret)}`);
  assert.equal(legacyProtocol.status, 426);
  const invalidPathQuery = new URLSearchParams({ workspace, path: 'folder/../private.md', pass: sharedSecret, protocol });
  const invalidPath = await fetch(`${apiUrl}/upload?${invalidPathQuery}&baseRevision=0`, { method: 'POST', body: 'nope' });
  assert.equal(invalidPath.status, 400);

  const createResponse = await fetch(`${apiUrl}/upload?${query}&baseRevision=0&mtime=${Date.now()}`, {
    method: 'POST',
    body: ''
  });
  assert.equal(createResponse.status, 200);

  const makeProvider = doc => {
    const provider = new WebsocketProvider(serverUrl, room, doc, {
      connect: false,
      disableBc: true,
      WebSocketPolyfill: WebSocket,
      params: { workspace, path: filePath, pass: sharedSecret, protocol }
    });
    providers.push(provider);
    return provider;
  };

  const first = new Y.Doc();
  const second = new Y.Doc();
  await Promise.all([onceSynced(makeProvider(first)), onceSynced(makeProvider(second))]);

  first.getText('content').insert(0, 'live update');
  await waitFor(() => second.getText('content').toString() === 'live update', 'WebSocket update did not reach peer');

  assert.equal((await fetch(`${apiUrl}/manifest?workspace=${encodeURIComponent(workspace)}&protocol=${protocol}`)).status, 401);
  const liveManifest = await fetch(`${apiUrl}/manifest?workspace=${encodeURIComponent(workspace)}&pass=${encodeURIComponent(sharedSecret)}&protocol=${protocol}`).then(response => response.json());
  const downloaded = await fetch(`${apiUrl}/download?${query}`).then(response => response.text());
  assert.equal(downloaded, 'live update');

  const replacement = 'uploaded while another client is live';
  const beforeUpload = liveManifest;
  const uploadResponse = await fetch(`${apiUrl}/upload?${query}&baseRevision=${beforeUpload[filePath].revision}&mtime=${Date.now()}`, {
    method: 'POST',
    body: replacement
  });
  assert.equal(uploadResponse.status, 200);
  await waitFor(
    () => first.getText('content').toString() === replacement && second.getText('content').toString() === replacement,
    'HTTP upload did not update live peers'
  );

  const roomUpdate = new Uint8Array(await fetch(`${apiUrl}/room-state?${query}`).then(response => response.arrayBuffer()));
  const restored = new Y.Doc();
  t.after(() => restored.destroy());
  Y.applyUpdate(restored, roomUpdate);
  assert.equal(restored.getText('content').toString(), replacement);

  const uploaded = await uploadResponse.json();
  const staleUpload = await fetch(`${apiUrl}/upload?${query}&baseRevision=${beforeUpload[filePath].revision}&mtime=${Date.now()}`, {
    method: 'POST',
    body: 'stale overwrite'
  });
  assert.equal(staleUpload.status, 409);

  const deleteResponse = await fetch(`${apiUrl}/delete?${query}&baseRevision=${uploaded.revision}&user=test-device`, { method: 'DELETE' });
  assert.equal(deleteResponse.status, 200);
  const manifest = await fetch(`${apiUrl}/manifest?workspace=${encodeURIComponent(workspace)}&pass=${encodeURIComponent(sharedSecret)}&protocol=${protocol}`).then(response => response.json());
  assert.equal(manifest[filePath].deleted, true);
  assert.match(manifest[filePath].hash, /^[a-f0-9]{64}$/);

  const resurrection = await fetch(`${apiUrl}/upload?${query}&baseRevision=0&mtime=${Date.now()}`, {
    method: 'POST',
    body: replacement
  });
  assert.equal(resurrection.status, 409);

  const raceQuery = new URLSearchParams({ workspace, path: 'Race.md', pass: sharedSecret, protocol });
  const competingCreates = await Promise.all(['first seed', 'second seed'].map(body =>
    fetch(`${apiUrl}/upload?${raceQuery}&baseRevision=0&mtime=${Date.now()}`, { method: 'POST', body })
  ));
  assert.deepEqual(competingCreates.map(response => response.status).sort(), [200, 409]);
  const raceContent = await fetch(`${apiUrl}/download?${raceQuery}`).then(response => response.text());
  assert.ok(raceContent === 'first seed' || raceContent === 'second seed');

  fs.unlinkSync(path.join(dbDir, 'config', 'team_room', 'Race.md'));
  const afterExternalDelete = await fetch(`${apiUrl}/manifest?workspace=${encodeURIComponent(workspace)}&pass=${encodeURIComponent(sharedSecret)}&protocol=${protocol}`).then(response => response.json());
  assert.equal(afterExternalDelete['Race.md'].deleted, true);
  assert.ok(afterExternalDelete['Race.md'].revision > 1);
});
