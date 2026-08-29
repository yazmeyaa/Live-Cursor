const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const esbuild = require('esbuild');

const sourcePath = path.resolve(__dirname, '..', 'syncProtocol.ts');
const { code } = esbuild.transformSync(fs.readFileSync(sourcePath, 'utf8'), {
  loader: 'ts',
  format: 'cjs',
  target: 'node20'
});
const compiled = new Module(sourcePath);
compiled.paths = module.paths;
compiled._compile(code, sourcePath);

const {
  getDefaultSyncFolder,
  getLocalPath,
  getRemotePath,
  normalizeServerUrl,
  normalizeSyncFolder
} = compiled.exports;

test('server URL normalization keeps sync-state scopes stable', () => {
  assert.equal(normalizeServerUrl('https://example.com/sync/'), 'wss://example.com');
  assert.equal(normalizeServerUrl(' example.com:4444/ '), 'ws://example.com:4444');
});

test('room paths cannot escape or address the rest of the vault', () => {
  assert.equal(getDefaultSyncFolder('team/room'), 'team-room[laplas_cowork]');
  assert.equal(normalizeSyncFolder(' Work\\Shared/ ', 'room'), 'Work/Shared');
  assert.equal(normalizeSyncFolder('Work:Team/Shared?', 'room'), 'Work-Team/Shared-');
  assert.equal(normalizeSyncFolder('../outside', 'room'), 'room[laplas_cowork]');
  assert.equal(normalizeSyncFolder('.obsidian/plugins', 'room'), 'room[laplas_cowork]');
  assert.equal(getRemotePath('Work/Shared/note.md', 'Work/Shared'), 'note.md');
  assert.equal(getRemotePath('Private/note.md', 'Work/Shared'), undefined);
  assert.equal(getLocalPath('nested/note.md', 'Work/Shared'), 'Work/Shared/nested/note.md');
  assert.throws(() => getLocalPath('../private.md', 'Work/Shared'), /Invalid remote path/);
});
