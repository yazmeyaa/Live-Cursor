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

const { decideSyncAction, normalizeServerUrl } = compiled.exports;

test('three-way sync only reports a conflict when both known sides changed', () => {
  assert.equal(decideSyncAction('base', 'same', 'same'), 'equal');
  assert.equal(decideSyncAction('base', 'base', 'remote'), 'download');
  assert.equal(decideSyncAction('base', 'local', 'base'), 'upload');
  assert.equal(decideSyncAction('base', 'local', 'remote'), 'conflict');
  assert.equal(decideSyncAction(undefined, 'local', 'remote'), 'bootstrap');
});

test('server URL normalization keeps sync-state scopes stable', () => {
  assert.equal(normalizeServerUrl('https://example.com/sync/'), 'wss://example.com');
  assert.equal(normalizeServerUrl(' example.com:4444/ '), 'ws://example.com:4444');
});
