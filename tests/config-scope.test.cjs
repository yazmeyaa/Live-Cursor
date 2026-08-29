const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const esbuild = require('esbuild');

const sourcePath = path.resolve(__dirname, '..', 'configSync.ts');
const enginePromise = esbuild.build({
  entryPoints: [sourcePath],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'node',
  plugins: [{
    name: 'obsidian-test-stub',
    setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'test' }));
      build.onLoad({ filter: /.*/, namespace: 'test' }, () => ({
        contents: `
          exports.TFile = class TFile {};
          exports.Notice = class Notice {};
          exports.requestUrl = (...args) => globalThis.__laplasRequestUrl(...args);
        `,
        loader: 'js'
      }));
    }
  }]
}).then(result => {
  const compiled = new Module(sourcePath);
  compiled.paths = module.paths;
  compiled._compile(result.outputFiles[0].text, sourcePath);
  return compiled.exports.ConfigSyncEngine;
});

test('initial sync scans only the room folder and requires explicit publication', async () => {
  const ConfigSyncEngine = await enginePromise;
  const encoder = new TextEncoder();
  const roomData = encoder.encode('local room note');
  const uploads = [];
  globalThis.__laplasRequestUrl = async options => {
    if (options.method === 'GET' && options.url.includes('/manifest')) {
      return { status: 200, json: {}, text: '' };
    }
    if (options.method === 'POST' && options.url.includes('/upload')) {
      uploads.push(new URL(options.url).searchParams.get('path'));
      return { status: 200, json: { hash: 'server-hash', revision: 1 }, text: '' };
    }
    throw new Error(`Unexpected request: ${options.method} ${options.url}`);
  };

  const listed = [];
  const storedText = new Map();
  const adapter = {
    async mkdir() {},
    async exists(filePath) { return storedText.has(filePath); },
    async read(filePath) { return storedText.get(filePath); },
    async write(filePath, value) { storedText.set(filePath, value); },
    async list(dir) {
      listed.push(dir);
      assert.equal(dir, 'team[laplas_cowork]');
      return { files: ['team[laplas_cowork]/note.md'], folders: [] };
    },
    async stat(filePath) {
      assert.equal(filePath, 'team[laplas_cowork]/note.md');
      return { mtime: 1, size: roomData.byteLength };
    },
    async readBinary(filePath) {
      assert.equal(filePath, 'team[laplas_cowork]/note.md');
      return roomData.buffer.slice(roomData.byteOffset, roomData.byteOffset + roomData.byteLength);
    }
  };
  const app = { vault: { adapter, getAbstractFileByPath: () => null } };
  const engine = new ConfigSyncEngine(
    app,
    'ws://localhost:4444',
    'device',
    'secret',
    'team',
    'device',
    '',
    () => false,
    '.plugin-data'
  );

  await engine.syncConfig(true);
  assert.deepEqual(listed, ['team[laplas_cowork]']);
  assert.deepEqual(uploads, []);

  await engine.publishLocalFiles();
  assert.deepEqual(uploads, ['note.md']);
  delete globalThis.__laplasRequestUrl;
});
