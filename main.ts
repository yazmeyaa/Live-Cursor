import { App, Plugin, PluginSettingTab, Setting, TFile, WorkspaceLeaf, MarkdownView, Notice, Platform, debounce } from 'obsidian';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { WebsocketProvider } from 'y-websocket';
import { EditorView } from '@codemirror/view';
import { Compartment, StateEffect } from '@codemirror/state';
import { collaborationExtension } from './collabExtension';
import { reconcileYText } from './reconcile';
import { ConfigSyncEngine } from './configSync';
import { getDefaultSyncFolder, getFileRoomName, normalizeServerUrl, normalizeSyncFolder, SYNC_PROTOCOL_VERSION } from './syncProtocol';
import embeddedServerSource from './server.js?embedded';

// Electron/Node APIs — only available on desktop
declare const require: (module: string) => any;

export { normalizeServerUrl } from './syncProtocol';

interface LaplasCoworkSettings {
  nickname: string;
  cursorColor: string;
  roomName: string;
  signalingUrl: string;
  sharedSecret: string;
  syncFolder: string;
}

const DEFAULT_SETTINGS: LaplasCoworkSettings = {
  nickname: 'Me',
  cursorColor: '#6366f1',
  roomName: 'default-laplas-cowork-room',
  signalingUrl: 'ws://localhost:4444',
  sharedSecret: '',
  syncFolder: '',
}

type ConnectionStatus = 'connected' | 'connecting' | 'disconnected';

export default class LaplasCoworkPlugin extends Plugin {
  settings!: LaplasCoworkSettings;
  public activeSyncs: Map<string, { doc: Y.Doc, awareness: Awareness, provider: WebsocketProvider, initialized: boolean }> = new Map();
  private simulatorInterval: any = null;
  private statusBarItem: HTMLElement | null = null;
  private diskDebouncers: Map<string, (file: TFile) => void> = new Map();
  private connectionStatus: ConnectionStatus = 'disconnected';
  private serverProcess: any = null;
  private settingsTab: LaplasCoworkSettingTab | null = null;
  private unpublishedNotices = new Set<string>();
  public configSyncEngine: ConfigSyncEngine | null = null;

  async onload() {
    await this.loadSettings();

    this.statusBarItem = this.addStatusBarItem();
    this.updateStatusBar();

    const serverUrl = normalizeServerUrl(this.settings.signalingUrl);
    this.configSyncEngine = new ConfigSyncEngine(
      this.app,
      serverUrl,
      this.settings.nickname,
      this.settings.sharedSecret,
      this.settings.roomName, // Using room name as workspace name
      this.settings.nickname,
      this.settings.syncFolder,
      (path) => this.activeSyncs.has(path),
      `${this.app.vault.configDir}/plugins/${this.manifest.id}/data`
    );

    // Start local server automatically on desktop if configured for localhost
    if (this.isDesktop()) {
      const isLocal = serverUrl.includes('localhost') || serverUrl.includes('127.0.0.1');
      if (isLocal) {
        this.startLocalServer(true);
      }
    }

    // Commands
    this.addRibbonIcon('users', 'Simulate Collaborator Activity', () => {
      this.toggleSimulator();
    });

    // Commands
    this.addCommand({
      id: 'toggle-collaborator-simulation',
      name: 'Simulate Remote Collaborator Activity',
      callback: () => { this.toggleSimulator(); }
    });

    this.addCommand({
      id: 'start-local-server',
      name: 'Start Local Sync Server',
      callback: () => { this.startLocalServer(); }
    });

    this.addCommand({
      id: 'stop-local-server',
      name: 'Stop Local Sync Server',
      callback: () => { this.stopLocalServer(); }
    });

    this.addCommand({
      id: 'reconnect-all',
      name: 'Reconnect All Files',
      callback: () => { this.reconnectAll(); }
    });

    this.addCommand({
      id: 'merge-conflicts',
      name: 'Clean Up Identical Conflict Files',
      callback: () => { this.cleanupAndMergeConflicts(); }
    });

    this.settingsTab = new LaplasCoworkSettingTab(this.app, this);
    this.addSettingTab(this.settingsTab);

    // Listen to file opens
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', (leaf: WorkspaceLeaf | null) => {
        if (!leaf) return;
        const view = leaf.view;
        if (view instanceof MarkdownView && view.file) {
          void this.syncFile(view.file);
        }
      })
    );

    // Clean up closed files
    this.registerEvent(
      this.app.workspace.on('layout-change', () => {
        const openPaths = new Set<string>();
        this.app.workspace.iterateAllLeaves((leaf) => {
          if (leaf.view instanceof MarkdownView && leaf.view.file) {
            openPaths.add(leaf.view.file.path);
          }
        });

        for (const [path, sync] of this.activeSyncs.entries()) {
          if (!openPaths.has(path)) {
            sync.provider.destroy();
            sync.doc.destroy();
            this.activeSyncs.delete(path);
            this.diskDebouncers.delete(path);
          }
        }
        this.updateStatusBar();
      })
    );

    // Sync disk changes back into Yjs
    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        if (file instanceof TFile && this.isManagedPath(file.path)) {
          let debouncer = this.diskDebouncers.get(file.path);
          if (!debouncer) {
            debouncer = debounce(async (f: TFile) => {
              const sync = this.activeSyncs.get(f.path);
              if (sync?.initialized) {
                const diskContent = await this.app.vault.read(f);
                const currentYText = sync.doc.getText('content');
                if (currentYText.toString() !== diskContent) {
                  reconcileYText(currentYText, diskContent);
                }
              }
            }, 50, true);
            this.diskDebouncers.set(file.path, debouncer);
          }
          debouncer(file);
        }
      })
    );

    // Background Vault Syncing (like Obsidian LiveSync)
    const backgroundSyncDebouncer = debounce(() => {
      if (this.configSyncEngine) {
        this.configSyncEngine.syncConfig(true);
      }
    }, 5000, true);

    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        // If it's not currently open, sync it in the background
        if (file instanceof TFile && this.isManagedPath(file.path) && !this.activeSyncs.has(file.path)) {
          backgroundSyncDebouncer();
        }
      })
    );
    this.registerEvent(this.app.vault.on('create', (file) => {
      if (file instanceof TFile && this.isManagedPath(file.path)) backgroundSyncDebouncer();
    }));
    this.registerEvent(this.app.vault.on('delete', (file) => {
      if (file instanceof TFile) {
        const sync = this.activeSyncs.get(file.path);
        if (sync) {
          this.detachEditorForFile(file.path);
          sync.provider.destroy();
          sync.doc.destroy();
          this.activeSyncs.delete(file.path);
          this.diskDebouncers.delete(file.path);
        }
        void this.configSyncEngine?.deleteRemoteFile(file.path);
      }
      if (file instanceof TFile && this.isManagedPath(file.path)) backgroundSyncDebouncer();
    }));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      const sync = this.activeSyncs.get(oldPath);
      if (sync) {
        this.detachEditorForFile(oldPath);
        sync.provider.destroy();
        sync.doc.destroy();
        this.activeSyncs.delete(oldPath);
        this.diskDebouncers.delete(oldPath);
      }
      void this.configSyncEngine?.deleteRemoteFile(oldPath);
      if (file instanceof TFile && this.isManagedPath(file.path)) void this.syncFile(file);
      if (this.isManagedPath(oldPath) || (file instanceof TFile && this.isManagedPath(file.path))) backgroundSyncDebouncer();
    }));

    // Automatically check for remote vault changes every 30 seconds
    this.registerInterval(window.setInterval(() => backgroundSyncDebouncer(), 30000));

    // Sync the currently active file
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (activeView && activeView.file) {
      void this.syncFile(activeView.file);
    }
    void this.configSyncEngine.syncConfig(true);
  }

  // ─────────────────────────────────────────────
  // LOCAL SERVER MANAGEMENT (Desktop Only)
  // ─────────────────────────────────────────────

  isDesktop(): boolean {
    return Platform.isDesktopApp;
  }

  isManagedPath(path: string): boolean {
    return this.configSyncEngine?.getRemotePath(path) !== undefined;
  }

  isServerRunning(): boolean {
    return this.serverProcess !== null;
  }

  async startLocalServer(silent: boolean = false): Promise<void> {
    if (!this.isDesktop()) {
      if (!silent) new Notice('Local server can only be started on desktop.');
      return;
    }
    if (this.serverProcess) {
      if (!silent) new Notice('Local server is already running on port 4444.');
      return;
    }
    if (!this.settings.sharedSecret) {
      if (!silent) new Notice('Set a shared secret before starting the local server.');
      return;
    }

    try {
      const { spawn } = require('child_process');
      const path = require('path');
      const fs = require('fs');
      const electronProcess = (globalThis as any).process;
      if (!electronProcess?.execPath) throw new Error('The desktop runtime executable could not be found.');

      const basePath = (this.app.vault.adapter as any).getBasePath?.();
      if (!basePath) throw new Error('This vault adapter does not expose a local filesystem path.');
      const pluginDir = path.join(
        basePath,
        this.manifest.dir || `${this.app.vault.configDir}/plugins/${this.manifest.id}`
      );
      const dataDir = path.join(pluginDir, 'data');
      const serverPath = path.join(dataDir, 'server.bundle.js');
      fs.mkdirSync(dataDir, { recursive: true });
      if (!fs.existsSync(serverPath) || fs.readFileSync(serverPath, 'utf8') !== embeddedServerSource) {
        fs.writeFileSync(serverPath, embeddedServerSource, { encoding: 'utf8', mode: 0o600 });
      }

      this.serverProcess = spawn(electronProcess.execPath, [serverPath], {
        detached: false,
        stdio: ['ignore', 'ignore', 'pipe'],
        env: {
          ...electronProcess.env,
          ELECTRON_RUN_AS_NODE: '1',
          DB_DIR: dataDir,
          LAPLAS_COWORK_SECRET: this.settings.sharedSecret
        }
      });

      this.serverProcess.stderr.on('data', (data: Buffer) => {
        console.error(`[LaplasCowork Server ERR] ${data.toString().trim()}`);
      });

      this.serverProcess.on('error', (err: Error) => {
        console.error('[LaplasCowork] Failed to start server:', err);
        new Notice(`❌ Failed to start server: ${err.message}`);
        this.serverProcess = null;
        this.settingsTab?.display();
      });

      this.serverProcess.on('exit', (code: number) => {
        this.serverProcess = null;
        this.settingsTab?.display();
        this.updateStatusBar();
      });

      // Give it a moment to start, then reconnect
      setTimeout(() => {
        if (!silent) new Notice('🟢 Local server started on port 4444. Connecting...');
        this.settingsTab?.display();
        this.reconnectAll();
        void this.configSyncEngine?.syncConfig(true);
      }, 1500);

    } catch (err: any) {
      console.error('[LaplasCowork] Cannot start server:', err);
      new Notice(`❌ Cannot start server: ${err.message}`);
    }
  }

  stopLocalServer(silent: boolean = false): void {
    if (!this.serverProcess) {
      if (!silent) new Notice('No local server is running.');
      return;
    }
    try {
      this.serverProcess.kill();
      this.serverProcess = null;
      if (!silent) new Notice('⏹ Local server stopped.');
      this.settingsTab?.display();
      this.updateStatusBar();
    } catch (err: any) {
      console.error('[LaplasCowork] Failed to stop server:', err);
      new Notice(`❌ Failed to stop server: ${err.message}`);
    }
  }

  // ─────────────────────────────────────────────
  // RECONNECT
  // ─────────────────────────────────────────────

  reconnectAll() {
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view instanceof MarkdownView && leaf.view.file) {
        const path = leaf.view.file.path;
        const sync = this.activeSyncs.get(path);
        if (sync) {
          this.detachEditorForFile(path);
          sync.provider.destroy();
          sync.doc.destroy();
        }
        // Remove from map to force re-create
        this.activeSyncs.delete(path);
        void this.syncFile(leaf.view.file);
      }
    });
    this.updateStatusBar();
  }

  async cleanupAndMergeConflicts() {
    const files = this.app.vault.getFiles();
    let cleanedCount = 0;
    let unresolvedCount = 0;

    for (const file of files) {
      if (!this.isManagedPath(file.path)) continue;
      const match = file.name.match(/^(.*?) \(Conflict from .*\)\.md$/);
      if (match) {
        const baseName = match[1] + '.md';
        const basePath = file.path.replace(file.name, baseName);
        const baseFile = this.app.vault.getAbstractFileByPath(basePath);

        if (baseFile instanceof TFile) {
          const baseContent = await this.app.vault.read(baseFile);
          const conflictContent = await this.app.vault.read(file);

          if (baseContent === conflictContent) {
            // Identical, just delete the conflict file
            await this.app.vault.trash(file, true);
            cleanedCount++;
            continue;
          }
          // A conflict copy has no common CRDT base. Keep both versions for
          // explicit review instead of silently concatenating incompatible text.
          unresolvedCount++;
        }
      }
    }

    new Notice(
      `Cleaned ${cleanedCount} identical conflict files. ${unresolvedCount} divergent files kept for review.`,
      5000
    );
  }

  onunload() {
    if (this.simulatorInterval) {
      clearInterval(this.simulatorInterval);
      this.simulatorInterval = null;
    }
    for (const [, sync] of this.activeSyncs.entries()) {
      sync.provider.destroy();
      sync.doc.destroy();
    }
    this.activeSyncs.clear();

    this.stopLocalServer(true);
  }

  // ─────────────────────────────────────────────
  // EDITOR BINDING
  // ─────────────────────────────────────────────

  private configureEditorForFile(file: TFile) {
    const sync = this.activeSyncs.get(file.path);
    if (!sync?.initialized) return;

    let retries = 0;
    const bind = () => {
      let boundCount = 0;
      this.app.workspace.iterateAllLeaves((leaf) => {
        if (leaf.view instanceof MarkdownView && leaf.view.file?.path === file.path) {
          const cm = (leaf.view.editor as any).cm as EditorView;
          if (!cm) return;

          // Restore CodeMirror's native focus detection for nested editors such
          // as Obsidian's table cells. Older plugin versions installed an own
          // getter here, causing the outer editor to steal their selection.
          if (Object.prototype.hasOwnProperty.call(cm, 'hasFocus')) {
            delete (cm as any).hasFocus;
          }

          // Create or reuse the compartment stored on the CM instance
          let compartment = (cm as any)._laplasCoworkCompartment as Compartment | undefined;
          if (!compartment) {
            compartment = new Compartment();
            (cm as any)._laplasCoworkCompartment = compartment;
            cm.dispatch({ effects: StateEffect.appendConfig.of(compartment.of([])) });
          }

          const ytext = sync.doc.getText('content');

          // Detach a previous room before aligning the editor, otherwise the
          // alignment itself is sent to the old Y.Doc during reconnect.
          cm.dispatch({ effects: compartment.reconfigure([]) });
          const sharedText = ytext.toString();
          if (cm.state.doc.toString() !== sharedText) {
            cm.dispatch({
              changes: { from: 0, to: cm.state.doc.length, insert: sharedText }
            });
          }

          // collaborationExtension now wraps yCollab internally.
          // It passes both ytext and awareness so that yCollab can use
          // Y.RelativePosition for cursor tracking (the correct approach).
          cm.dispatch({
            effects: compartment.reconfigure(
              collaborationExtension(ytext, sync.awareness)
            )
          });

          // Force awareness ping so remote peers immediately see our cursor
          const pingAwareness = () => {
            if (!(cm as any).destroyed) {
              const localState = sync.awareness.getLocalState();
              if (localState) {
                sync.awareness.setLocalState({ ...localState });
              }
            }
          };
          setTimeout(pingAwareness, 50);
          setTimeout(pingAwareness, 500); // Follow-up ping for reliability

          boundCount++;
        }
      });
      if (boundCount === 0 && retries < 20) {
        retries++;
        setTimeout(bind, 100);
      } else if (boundCount === 0) {
        console.warn(`[LaplasCowork] Could not bind editor for ${file.path} after ${retries} retries`);
      }
    };
    bind();
  }

  private detachEditorForFile(path: string) {
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view instanceof MarkdownView && leaf.view.file?.path === path) {
        const cm = (leaf.view.editor as any).cm as EditorView | undefined;
        const compartment = (cm as any)?._laplasCoworkCompartment as Compartment | undefined;
        if (cm && compartment) cm.dispatch({ effects: compartment.reconfigure([]) });
      }
    });
  }

  private async getCurrentFileContent(file: TFile): Promise<string> {
    let editorContent: string | null = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (editorContent === null && leaf.view instanceof MarkdownView && leaf.view.file?.path === file.path) {
        const cm = (leaf.view.editor as any).cm as EditorView | undefined;
        if (cm) editorContent = cm.state.doc.toString();
      }
    });
    return editorContent ?? await this.app.vault.read(file);
  }

  private async preserveLocalConflict(file: TFile, content: string, hash: string) {
    const syncEngine = this.configSyncEngine;
    const remotePath = syncEngine?.getRemotePath(file.path);
    if (!syncEngine || !remotePath) return;
    const normalized = remotePath.replace(/\\/g, '/');
    const slash = normalized.lastIndexOf('/');
    const parent = slash === -1 ? '' : normalized.slice(0, slash);
    const name = slash === -1 ? normalized : normalized.slice(slash + 1);
    const dot = name.lastIndexOf('.');
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    const conflictRoot = `${syncEngine.folder}/.laplas-conflicts`;
    const conflictDir = `${conflictRoot}/${parent}`.replace(/\/$/, '');
    await this.app.vault.adapter.mkdir(syncEngine.folder).catch(() => {});
    await this.app.vault.adapter.mkdir(conflictRoot).catch(() => {});
    if (parent) {
      let current = conflictRoot;
      for (const part of parent.split('/')) {
        current += `/${part}`;
        await this.app.vault.adapter.mkdir(current).catch(() => {});
      }
    }
    let conflictPath = `${conflictDir}/${base} (Local before sync ${hash.slice(0, 12)})${ext}`;
    if (await this.app.vault.adapter.exists(conflictPath)) {
      if (await this.app.vault.adapter.read(conflictPath) === content) return;
      conflictPath = `${conflictDir}/${base} (Local before sync ${hash})${ext}`;
      if (await this.app.vault.adapter.exists(conflictPath)) {
        if (await this.app.vault.adapter.read(conflictPath) === content) return;
        conflictPath = `${conflictDir}/${base} (Local before sync ${hash} ${Date.now()})${ext}`;
      }
    }
    await this.app.vault.adapter.write(conflictPath, content);
    new Notice(`Laplas Cowork preserved local edits in ${conflictPath}`, 6000);
  }

  // ─────────────────────────────────────────────
  // SYNC FILE
  // ─────────────────────────────────────────────

  private async syncFile(file: TFile) {
    const syncEngine = this.configSyncEngine;
    const remotePath = syncEngine?.getRemotePath(file.path);
    if (!syncEngine || !remotePath || !file.path.endsWith('.md')) return;

    if (this.activeSyncs.has(file.path)) {
      this.configureEditorForFile(file);
      this.updateStatusBar();
      return;
    }

    // Closed-file synchronization performs the only snapshot upload. The
    // WebSocket client connects only after the server has a canonical file.
    if (!await syncEngine.syncConfig(true)) return;
    if (!await syncEngine.canCollaborate(file.path)) {
      if (!this.unpublishedNotices.has(file.path)) {
        this.unpublishedNotices.add(file.path);
        new Notice(`${file.path} is local-only. Publish existing local files from Laplas Cowork settings to collaborate.`, 6000);
      }
      return;
    }
    this.unpublishedNotices.delete(file.path);
    if (this.activeSyncs.has(file.path)) return;

    const doc = new Y.Doc();
    const ytext = doc.getText('content');

    const awareness = new Awareness(doc);
    awareness.setLocalStateField('user', {
      name: this.settings.nickname,
      color: this.settings.cursorColor,
      colorLight: this.settings.cursorColor + '33'
    });

    const fileRoomName = getFileRoomName(this.settings.roomName, remotePath);
    const serverUrl = normalizeServerUrl(this.settings.signalingUrl);

    // Register all listeners before opening the socket so a fast local server
    // cannot emit the initial sync event before we are ready.
    const provider = new WebsocketProvider(serverUrl, fileRoomName, doc, {
      awareness,
      connect: false,
      params: {
        workspace: this.settings.roomName,
        path: remotePath,
        pass: this.settings.sharedSecret,
        protocol: SYNC_PROTOCOL_VERSION,
      }
    });

    const sync = { doc, awareness, provider, initialized: false };
    this.activeSyncs.set(file.path, sync);
    this.updateStatusBar();

    // Prevent duplicate initialization and wait for the authoritative server sync.
    let hasInitialized = false;
    const initializeCollab = async () => {
      if (hasInitialized) return;
      hasInitialized = true;

      const currentLocalContent = await this.getCurrentFileContent(file);
      if (this.activeSyncs.get(file.path) !== sync) return;
      const remoteContent = ytext.toString();

      const [localHash, remoteHash] = await Promise.all([
        syncEngine.hashText(currentLocalContent),
        syncEngine.hashText(remoteContent),
      ]);
      if (this.activeSyncs.get(file.path) !== sync) return;

      if (localHash !== remoteHash) {
        try {
          await this.preserveLocalConflict(file, currentLocalContent, localHash);
        } catch (error) {
          console.error(`[LaplasCowork] Failed to preserve local conflict for ${file.path}:`, error);
          new Notice(`Laplas Cowork could not preserve local edits for ${file.path}`, 8000);
          hasInitialized = false;
          return;
        }
        await this.app.vault.modify(file, remoteContent);
      }

      await syncEngine.recordSyncedHash(file.path, remoteHash).catch(error => {
        console.warn(`[LaplasCowork] Could not record sync state for ${file.path}:`, error);
      });

      if (this.activeSyncs.get(file.path) !== sync) return;
      sync.initialized = true;
      this.configureEditorForFile(file);

      // Write remote changes back to disk if the file isn't open
      ytext.observe((event, transaction) => {
        if (!transaction.local) {
          let isOpen = false;
          this.app.workspace.iterateAllLeaves((leaf) => {
            if (leaf.view instanceof MarkdownView && leaf.view.file?.path === file.path) isOpen = true;
          });
          if (!isOpen) {
            this.app.vault.modify(file, ytext.toString()).catch(e => console.error(e));
          }
        }
      });
    };

    provider.on('sync', (isSynced: boolean) => {
      if (isSynced) initializeCollab();
    });

    // ── Real connection status tracking ──
    provider.on('status', ({ status }: { status: string }) => {
      if (status === 'connected') {
        this.connectionStatus = 'connected';
        // Trigger background vault sync if not already syncing
        if (this.configSyncEngine) {
          this.configSyncEngine.syncConfig(true);
        }
      } else if (status === 'connecting') {
        this.connectionStatus = 'connecting';
      } else if (status === 'disconnected') {
        this.connectionStatus = 'disconnected';
      }
      this.updateStatusBar();
    });
    provider.connect();
  }

  // ─────────────────────────────────────────────
  // SIMULATOR
  // ─────────────────────────────────────────────

  toggleSimulator() {
    if (this.simulatorInterval) {
      clearInterval(this.simulatorInterval);
      this.simulatorInterval = null;
      new Notice('Collaborator simulation stopped.');
      this.updateStatusBar();

      for (const sync of this.activeSyncs.values()) {
        const mockClientId = 133742;
        sync.awareness.states.delete(mockClientId);
        sync.awareness.emit('change', [{ added: [], updated: [], removed: [mockClientId] }]);
      }
      return;
    }

    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!activeView || !activeView.file) {
      new Notice('Please open a note to simulate collaboration.');
      return;
    }

    const sync = this.activeSyncs.get(activeView.file.path);
    if (!sync) {
      new Notice('Active note is not synced. Opening session...');
      this.syncFile(activeView.file);
      return;
    }

    const mockClientId = 133742;
    let typingDirection = 1;
    let mockHead = 0;

    this.simulatorInterval = setInterval(() => {
      const currentView = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (!currentView || !currentView.file) return;
      const currentSync = this.activeSyncs.get(currentView.file.path);
      if (!currentSync) return;

      const ytext = currentSync.doc.getText('content');
      const docLength = ytext.length;
      if (docLength === 0) return;

      if (Math.random() < 0.2) {
        mockHead = Math.floor(Math.random() * docLength);
      } else {
        mockHead += typingDirection * Math.floor(Math.random() * 3 + 1);
        if (mockHead >= docLength) { mockHead = docLength - 1; typingDirection = -1; }
        else if (mockHead <= 0) { mockHead = 0; typingDirection = 1; }
      }

      const mockAnchorAbs = Math.random() < 0.35
        ? Math.max(0, mockHead - Math.floor(Math.random() * 20 + 5))
        : mockHead;

      // Use Y.RelativePosition so the cursor is compatible with yCollab's
      // yRemoteSelections plugin, which reads cursor.anchor and cursor.head
      // as relative positions.
      const anchor = Y.createRelativePositionFromTypeIndex(ytext, mockAnchorAbs);
      const head   = Y.createRelativePositionFromTypeIndex(ytext, mockHead);

      currentSync.awareness.states.set(mockClientId, {
        user: { name: 'Jane Doe (Simulated)', color: '#ec4899', colorLight: '#ec489922' },
        cursor: { anchor, head }
      });
      currentSync.awareness.emit('change', [{ added: [], updated: [mockClientId], removed: [] }]);
    }, 1000);

    new Notice('Collaborator simulation started (Jane Doe is active).');
    this.updateStatusBar();
  }

  // ─────────────────────────────────────────────
  // STATUS BAR
  // ─────────────────────────────────────────────

  updateStatusBar() {
    if (!this.statusBarItem) return;

    if (this.simulatorInterval) {
      this.statusBarItem.setText('Laplas Cowork 🟣 Simulating');
      return;
    }

    let connected = 0;
    let connecting = 0;
    for (const sync of this.activeSyncs.values()) {
      if (!sync.provider) continue;
      if (sync.provider.wsconnected) connected++;
      else if (!sync.provider.wsconnected && sync.provider.shouldConnect) connecting++;
    }

    if (connected > 0) {
      this.statusBarItem.setText(`Laplas Cowork 🟢 ${connected} synced`);
    } else if (connecting > 0) {
      this.statusBarItem.setText('Laplas Cowork 🟡 Connecting...');
    } else if (this.activeSyncs.size > 0) {
      this.statusBarItem.setText('Laplas Cowork 🔴 Disconnected');
    } else {
      this.statusBarItem.setText('Laplas Cowork ⚪ Standby');
    }
  }

  // ─────────────────────────────────────────────
  // SETTINGS
  // ─────────────────────────────────────────────

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    if (!this.settings.sharedSecret) {
      const bytes = globalThis.crypto.getRandomValues(new Uint8Array(24));
      this.settings.sharedSecret = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
      await this.saveSettings();
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

// ─────────────────────────────────────────────────────────────────
// SETTINGS TAB
// ─────────────────────────────────────────────────────────────────

class LaplasCoworkSettingTab extends PluginSettingTab {
  plugin: LaplasCoworkPlugin;

  constructor(app: App, plugin: LaplasCoworkPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // ── Header ──
    const header = containerEl.createEl('div');
    header.style.marginBottom = '24px';
    const title = header.createEl('h2', { text: 'Laplas Cowork Settings' });
    title.style.margin = '0 0 6px 0';
    const subtitle = header.createEl('p', { text: 'Real-time collaboration inside an isolated room folder.' });
    subtitle.style.margin = '0';
    subtitle.style.fontSize = 'var(--font-ui-small)';
    subtitle.style.color = 'var(--text-muted)';

    // ── Quick-Start Tutorial Card ──
    const tutorialCard = containerEl.createEl('div');
    tutorialCard.style.cssText = 'background: linear-gradient(135deg, rgba(99, 102, 241, 0.05) 0%, rgba(139, 92, 246, 0.05) 100%); border: 1px solid rgba(99, 102, 241, 0.22); border-radius: 12px; padding: 18px; margin-bottom: 24px; box-shadow: 0 4px 12px rgba(0,0,0,0.05);';
    tutorialCard.createEl('h3', { text: '🎓 Quick-Start Collaboration Guide' });
    tutorialCard.createEl('p', { text: 'Use the same server URL, room name, and shared secret on every device.' });
    const steps = tutorialCard.createEl('ol');
    steps.createEl('li', { text: 'On a desktop, start the local server.' });
    steps.createEl('li', { text: 'On other devices, enter the host address, for example ws://192.168.1.12:4444.' });
    steps.createEl('li', { text: 'Copy the room name and shared secret exactly.' });
    steps.createEl('li', { text: 'Work only inside the configured Laplas Cowork folder.' });

    // ── Section: Profile ──
    containerEl.createEl('h3', { text: '👤 Your Profile', attr: { style: sectionHeaderStyle() } });

    new Setting(containerEl)
      .setName('Collaborator Nickname')
      .setDesc('The name shown next to your cursor on other devices.')
      .addText(text => text
        .setPlaceholder('Anonymous Editor')
        .setValue(this.plugin.settings.nickname)
        .onChange(async (val) => {
          this.plugin.settings.nickname = val || 'Anonymous';
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Cursor Color')
      .setDesc('Your cursor and selection highlight color.')
      .addColorPicker(color => color
        .setValue(this.plugin.settings.cursorColor)
        .onChange(async (val) => {
          this.plugin.settings.cursorColor = val;
          await this.plugin.saveSettings();
        }));

    // ── Section: Active Collaborators ──
    containerEl.createEl('h3', { text: '👥 Connected Collaborators', attr: { style: sectionHeaderStyle() } });

    const activeUsers = new Map<string, { name: string, color: string }>();
    for (const sync of this.plugin.activeSyncs.values()) {
      for (const [clientId, state] of sync.awareness.getStates().entries()) {
        if (clientId === sync.awareness.clientID) continue;
        if (state.user?.name) {
          activeUsers.set(state.user.name, state.user);
        }
      }
    }

    const usersContainer = containerEl.createEl('div');
    usersContainer.style.cssText = 'padding: 10px 14px; background: var(--background-secondary); border-radius: 8px; border: 1px solid var(--background-modifier-border); margin-bottom: 16px;';

    if (activeUsers.size === 0) {
      const emptyMsg = usersContainer.createEl('div', { text: 'No other collaborators are currently connected.' });
      emptyMsg.style.color = 'var(--text-muted)';
      emptyMsg.style.fontStyle = 'italic';
      emptyMsg.style.fontSize = 'var(--font-ui-small)';
    } else {
      const listEl = usersContainer.createEl('ul', { attr: { style: 'margin: 0; padding-left: 0; list-style: none;' } });
      for (const user of activeUsers.values()) {
        const li = listEl.createEl('li');
        li.style.cssText = 'display: flex; align-items: center; gap: 8px; margin-bottom: 8px;';
        
        const dot = li.createEl('span');
        dot.style.cssText = `display: inline-block; width: 10px; height: 10px; border-radius: 50%; background-color: ${user.color}; box-shadow: 0 0 4px ${user.color}88;`;
        
        const nameEl = li.createEl('span', { text: user.name });
        nameEl.style.fontWeight = '500';
      }
      listEl.lastElementChild?.setAttribute('style', listEl.lastElementChild.getAttribute('style') + ' margin-bottom: 0;');
    }

    // ── Section: Local Server ──
    containerEl.createEl('h3', { text: '🖥️ Local Sync Server', attr: { style: sectionHeaderStyle() } });

    // Server status indicator
    const statusEl = containerEl.createEl('div');
    statusEl.style.cssText = 'padding: 10px 14px; border-radius: 8px; margin-bottom: 16px; font-size: var(--font-ui-small); display: flex; align-items: center; gap: 10px;';

    const isRunning = this.plugin.isServerRunning();
    if (isRunning) {
      statusEl.style.background = 'rgba(34, 197, 94, 0.12)';
      statusEl.style.border = '1px solid rgba(34, 197, 94, 0.3)';
      statusEl.createSpan({ text: '🟢' });
      statusEl.createSpan({ text: 'Server running on port 4444 — your devices can connect.' });
    } else {
      statusEl.style.background = 'rgba(239, 68, 68, 0.1)';
      statusEl.style.border = '1px solid rgba(239, 68, 68, 0.25)';
      statusEl.createSpan({ text: '🔴' });
      statusEl.createSpan({ text: 'Server not running. Start it below to enable local sync.' });
    }

    // Server start/stop buttons
    const serverButtonSetting = new Setting(containerEl)
      .setName('Local Server')
      .setDesc('Runs a private sync server on your PC. All your devices on the same network connect through it.');

    if (!isRunning) {
      serverButtonSetting.addButton(btn => btn
        .setButtonText('▶  Start Local Server')
        .setCta()
        .onClick(async () => {
          await this.plugin.startLocalServer();
        }));
    } else {
      serverButtonSetting.addButton(btn => btn
        .setButtonText('⏹  Stop Server')
        .setWarning()
        .onClick(() => {
          this.plugin.stopLocalServer();
        }));
    }

    // Show local IP hint
    const ipHint = containerEl.createEl('div');
    ipHint.style.cssText = 'margin: 0 0 16px 0; padding: 10px 14px; background: var(--background-secondary); border-radius: 8px; font-size: var(--font-ui-small); color: var(--text-muted);';
    ipHint.createEl('strong', { text: '📱 Connecting from mobile or another device?' });
    ipHint.createEl('div', { text: 'Find the desktop host IP and use ws://YOUR_PC_IP:4444 on the other devices.' });
    ipHint.createEl('code', { text: 'Example: ws://192.168.1.12:4444' });

    // ── Section: Connection ──
    containerEl.createEl('h3', { text: '🔗 Connection & Room', attr: { style: sectionHeaderStyle() } });

    new Setting(containerEl)
      .setName('Room Name')
      .setDesc('All devices must use the exact same room name to collaborate together.')
      .addText(text => {
        let applyTimeout: number | undefined;
        return text
          .setPlaceholder('default-laplas-cowork-room')
          .setValue(this.plugin.settings.roomName)
          .onChange((val) => {
            if (applyTimeout !== undefined) window.clearTimeout(applyTimeout);
            applyTimeout = window.setTimeout(async () => {
              const engine = this.plugin.configSyncEngine;
              if (engine) await engine.syncConfig(true);
              this.plugin.settings.roomName = val || 'default-laplas-cowork-room';
              if (engine) engine.workspace = this.plugin.settings.roomName;
              await this.plugin.saveSettings();
              this.plugin.reconnectAll();
            }, 750);
          });
      });

    new Setting(containerEl)
      .setName('Room Folder')
      .setDesc('Only this folder is synchronized. Files elsewhere in your vault are never uploaded, replaced, or deleted by Laplas Cowork.')
      .addText(text => {
        let applyTimeout: number | undefined;
        return text
          .setPlaceholder(getDefaultSyncFolder(this.plugin.settings.roomName))
          .setValue(this.plugin.settings.syncFolder || getDefaultSyncFolder(this.plugin.settings.roomName))
          .onChange((val) => {
            if (applyTimeout !== undefined) window.clearTimeout(applyTimeout);
            applyTimeout = window.setTimeout(async () => {
              const engine = this.plugin.configSyncEngine;
              if (engine) await engine.syncConfig(true);
              const normalized = normalizeSyncFolder(val, this.plugin.settings.roomName);
              this.plugin.settings.syncFolder = normalized;
              if (engine) engine.syncFolder = normalized;
              await this.plugin.saveSettings();
              this.plugin.reconnectAll();
            }, 750);
          });
      });

    new Setting(containerEl)
      .setName('Server Connection URL')
      .setDesc('The WebSocket server all your devices connect to. Default: ws://localhost:4444 (local server on this PC).')
      .addText(text => {
        let applyTimeout: number | undefined;
        return text
          .setPlaceholder('ws://localhost:4444')
          .setValue(this.plugin.settings.signalingUrl)
          .onChange((val) => {
            if (applyTimeout !== undefined) window.clearTimeout(applyTimeout);
            applyTimeout = window.setTimeout(async () => {
              const engine = this.plugin.configSyncEngine;
              if (engine) await engine.syncConfig(true);
              this.plugin.settings.signalingUrl = val;
              if (engine) engine.serverUrl = val || 'ws://localhost:4444';
              await this.plugin.saveSettings();
              this.plugin.reconnectAll();
            }, 750);
          });
      });

    new Setting(containerEl)
      .setName('Shared Secret')
      .setDesc('Required by the server. Copy the same generated value to every device. Restart the local server after changing it.')
      .addText(text => {
        let applyTimeout: number | undefined;
        text.inputEl.type = 'password';
        return text
          .setPlaceholder('Generated automatically')
          .setValue(this.plugin.settings.sharedSecret)
          .onChange((val) => {
            if (applyTimeout !== undefined) window.clearTimeout(applyTimeout);
            applyTimeout = window.setTimeout(async () => {
              const engine = this.plugin.configSyncEngine;
              if (engine) await engine.syncConfig(true);
              this.plugin.settings.sharedSecret = val.trim();
              if (engine) engine.pass = val.trim();
              await this.plugin.saveSettings();
            }, 750);
          });
      })
      .addButton(button => button
        .setButtonText('Copy')
        .onClick(async () => {
          await navigator.clipboard.writeText(this.plugin.settings.sharedSecret);
          new Notice('Shared secret copied.');
        }));

    new Setting(containerEl)
      .setName('Reconnect All Files')
      .setDesc('Force a reconnection to the server with current settings.')
      .addButton(btn => btn
        .setButtonText('🔄 Reconnect')
        .onClick(() => {
          this.plugin.reconnectAll();
          new Notice('Reconnecting to server...');
        }));

    // ── Section: Isolated Room Sync ──
    containerEl.createEl('h3', { text: '📂 Isolated Room Sync', attr: { style: sectionHeaderStyle() } });
    
    new Setting(containerEl)
      .setName('Sync Room Folder')
      .setDesc(`Synchronize only ${this.plugin.configSyncEngine?.folder || getDefaultSyncFolder(this.plugin.settings.roomName)}. The rest of the vault is outside plugin scope.`)
      .addButton(btn => btn
        .setButtonText('Sync Folder Now')
        .setCta()
        .onClick(async () => {
          if (!this.plugin.configSyncEngine) {
            new Notice('Sync engine not initialized.');
            return;
          }
          await this.plugin.configSyncEngine.syncConfig(false);
        }));

    new Setting(containerEl)
      .setName('Publish Existing Local Files')
      .setDesc('First connection is pull-first. Use this explicitly to upload files that already existed in the room folder before Laplas Cowork connected.')
      .addButton(btn => btn
        .setButtonText('Publish Local Files')
        .setWarning()
        .onClick(async () => {
          const confirmPublish = confirm('Publish previously existing files from the isolated room folder?\n\nFiles are created only when the path does not already exist on the server. Server versions always win conflicts.');
          if (confirmPublish) await this.plugin.configSyncEngine?.publishLocalFiles();
        }));
  }
}

function sectionHeaderStyle(): string {
  return 'margin-top: 24px; margin-bottom: 12px; border-bottom: 1px solid var(--background-modifier-border); padding-bottom: 6px; font-size: 1.05em;';
}
