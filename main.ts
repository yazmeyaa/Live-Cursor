import { App, Plugin, PluginSettingTab, Setting, TFile, WorkspaceLeaf, MarkdownView, Notice, debounce, requestUrl } from 'obsidian';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { WebsocketProvider } from 'y-websocket';
import { EditorView } from '@codemirror/view';
import { Compartment, StateEffect } from '@codemirror/state';
import { collaborationExtension } from './collabExtension';
import { reconcileYText } from './reconcile';
import { ConfigSyncEngine } from './configSync';
import { getFileRoomName } from './syncProtocol';

// Electron/Node APIs — only available on desktop
declare const require: (module: string) => any;

export function normalizeServerUrl(url: string): string {
  let cleaned = (url || '').trim();
  if (!cleaned) return 'ws://localhost:4444';

  // 1. If it has no protocol, prepend 'ws://'
  if (!/^https?:\/\//i.test(cleaned) && !/^wss?:\/\//i.test(cleaned)) {
    cleaned = 'ws://' + cleaned;
  }

  // 2. Map http:// -> ws:// and https:// -> wss://
  if (/^http:\/\//i.test(cleaned)) {
    cleaned = cleaned.replace(/^http:\/\//i, 'ws://');
  } else if (/^https:\/\//i.test(cleaned)) {
    cleaned = cleaned.replace(/^https:\/\//i, 'wss://');
  }

  // 3. Remove trailing slashes and '/sync' path suffix
  cleaned = cleaned.replace(/\/+$/, '');
  cleaned = cleaned.replace(/\/sync\/?$/i, '');
  cleaned = cleaned.replace(/\/+$/, '');

  return cleaned;
}

interface LiveCursorSettings {
  nickname: string;
  cursorColor: string;
  roomName: string;
  signalingUrl: string;
}

const DEFAULT_SETTINGS: LiveCursorSettings = {
  nickname: 'Me',
  cursorColor: '#6366f1',
  roomName: 'default-live-cursor-room',
  signalingUrl: 'ws://localhost:4444'
}

type ConnectionStatus = 'connected' | 'connecting' | 'disconnected';

export default class LiveCursorPlugin extends Plugin {
  settings!: LiveCursorSettings;
  public activeSyncs: Map<string, { doc: Y.Doc, awareness: Awareness, provider: WebsocketProvider, initialized: boolean }> = new Map();
  private simulatorInterval: any = null;
  private statusBarItem: HTMLElement | null = null;
  private diskDebouncers: Map<string, (file: TFile) => void> = new Map();
  private connectionStatus: ConnectionStatus = 'disconnected';
  private serverProcess: any = null;
  private settingsTab: LiveCursorSettingTab | null = null;
  public configSyncEngine: ConfigSyncEngine | null = null;

  async onload() {
    await this.loadSettings();

    this.statusBarItem = this.addStatusBarItem();
    this.updateStatusBar();

    const serverUrl = normalizeServerUrl(this.settings.signalingUrl);
    this.configSyncEngine = new ConfigSyncEngine(
      this.app,
      serverUrl,
      this.settings.nickname, // Basic auth placeholder
      'default-pass',
      this.settings.roomName, // Using room name as workspace name
      this.settings.nickname,
      (path) => this.activeSyncs.has(path)
    );

    // Start local server automatically on desktop if configured for localhost
    if (this.isDesktop()) {
      const isLocal = serverUrl.includes('localhost') || serverUrl.includes('127.0.0.1');
      if (isLocal) {
        console.log('[LiveCursor] Local URL configured. Auto-starting local sync server in the background.');
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

    this.settingsTab = new LiveCursorSettingTab(this.app, this);
    this.addSettingTab(this.settingsTab);

    // Listen to file opens
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', (leaf: WorkspaceLeaf | null) => {
        if (!leaf) return;
        const view = leaf.view;
        if (view instanceof MarkdownView && view.file) {
          this.syncFile(view.file);
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
            console.log(`[LiveCursor] Cleaning up closed file: ${path}`);
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
        if (file instanceof TFile) {
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
        if (file instanceof TFile && !this.activeSyncs.has(file.path)) {
          backgroundSyncDebouncer();
        }
      })
    );
    this.registerEvent(this.app.vault.on('create', () => backgroundSyncDebouncer()));
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
        this.configSyncEngine?.deleteRemoteFile(file.path);
      }
      backgroundSyncDebouncer();
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
      this.configSyncEngine?.deleteRemoteFile(oldPath);
      if (file instanceof TFile) this.syncFile(file);
      backgroundSyncDebouncer();
    }));

    // Automatically check for remote vault changes every 30 seconds
    this.registerInterval(window.setInterval(() => backgroundSyncDebouncer(), 30000));

    // Sync the currently active file
    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (activeView && activeView.file) {
      this.syncFile(activeView.file);
    }
    void this.configSyncEngine.syncConfig(true);
  }

  // ─────────────────────────────────────────────
  // LOCAL SERVER MANAGEMENT (Desktop Only)
  // ─────────────────────────────────────────────

  isDesktop(): boolean {
    try {
      require('child_process');
      return true;
    } catch {
      return false;
    }
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

    try {
      const { spawn } = require('child_process');
      const path = require('path');
      const fs = require('fs');

      // Find the plugin folder — server.js lives alongside main.js
      const pluginDir = (this.app.vault.adapter as any).getBasePath
        ? path.join((this.app.vault.adapter as any).getBasePath(), '.obsidian', 'plugins', 'live-cursor')
        : (this.manifest as any).dir || '';

      const bundledServerPath = path.join(pluginDir, 'server.bundle.js');
      const serverPath = fs.existsSync(bundledServerPath)
        ? bundledServerPath
        : path.join(pluginDir, 'server.js');
      console.log(`[LiveCursor] Starting server at: ${serverPath}`);

      this.serverProcess = spawn('node', [serverPath], {
        detached: false,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      this.serverProcess.stdout.on('data', (data: Buffer) => {
        console.log(`[LiveCursor Server] ${data.toString().trim()}`);
      });

      this.serverProcess.stderr.on('data', (data: Buffer) => {
        console.error(`[LiveCursor Server ERR] ${data.toString().trim()}`);
      });

      this.serverProcess.on('error', (err: Error) => {
        console.error('[LiveCursor] Failed to start server:', err);
        new Notice(`❌ Failed to start server: ${err.message}`);
        this.serverProcess = null;
        this.settingsTab?.display();
      });

      this.serverProcess.on('exit', (code: number) => {
        console.log(`[LiveCursor] Server exited with code ${code}`);
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
      console.error('[LiveCursor] Cannot start server:', err);
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
      console.error('[LiveCursor] Failed to stop server:', err);
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
        this.syncFile(leaf.view.file);
      }
    });
    this.updateStatusBar();
  }

  async reconstructDatabase(): Promise<void> {
    if (!this.configSyncEngine) {
      new Notice('Sync engine not initialized.');
      return;
    }

    try {
      new Notice('🔄 Resetting and reconstructing server database rooms...', 3000);

      // 1. Disconnect and clear all active docs locally
      for (const [path, sync] of this.activeSyncs.entries()) {
        sync.provider.destroy();
        sync.doc.destroy();
      }
      this.activeSyncs.clear();
      this.diskDebouncers.clear();

      // 2. Call reconstruct API on server
      const serverUrl = normalizeServerUrl(this.configSyncEngine.serverUrl);
      const httpUrl = `${serverUrl.replace(/^ws/i, 'http')}/api/reconstruct-db` +
        `?user=${encodeURIComponent(this.settings.nickname)}&workspace=${encodeURIComponent(this.settings.roomName)}`;
      const res = await requestUrl({ url: httpUrl, method: 'POST' });

      if (res.status !== 200) {
        throw new Error(`Server returned HTTP ${res.status}: ${res.text || 'No response body'}`);
      }

      new Notice('🧹 Server memory cleared. Re-uploading all files as source of truth...', 3500);

      // 3. Force full vault config and note re-upload!
      await this.configSyncEngine.syncConfig(false);

      // 4. Reconnect active workspace leaves
      this.reconnectAll();

      new Notice('✅ Database successfully reconstructed! All devices connected.', 4000);
    } catch (err: any) {
      console.error('[LiveCursor] Database reconstruction failed:', err);
      new Notice(`❌ Database reconstruction failed: ${err.message || err}`, 5000);
    }
  }

  async cleanupAndMergeConflicts() {
    const files = this.app.vault.getFiles();
    let cleanedCount = 0;
    let unresolvedCount = 0;

    for (const file of files) {
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

          // Override hasFocus to return true whenever the active Markdown view's path matches the file path.
          // This prevents y-codemirror from clearing cursor awareness state during focus transitions.
          try {
            Object.defineProperty(cm, 'hasFocus', {
              get: () => {
                return this.app.workspace.getActiveViewOfType(MarkdownView)?.file?.path === file.path;
              },
              configurable: true
            });
          } catch (e) {
            console.warn('[LiveCursor] Failed to override hasFocus getter:', e);
          }

          // Create or reuse the compartment stored on the CM instance
          let compartment = (cm as any)._liveCursorCompartment as Compartment | undefined;
          if (!compartment) {
            compartment = new Compartment();
            (cm as any)._liveCursorCompartment = compartment;
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
          console.log(`[LiveCursor] Editor bound for ${file.path}`);
        }
      });
      if (boundCount === 0 && retries < 20) {
        retries++;
        setTimeout(bind, 100);
      } else if (boundCount === 0) {
        console.warn(`[LiveCursor] Could not bind editor for ${file.path} after ${retries} retries`);
      }
    };
    bind();
  }

  private detachEditorForFile(path: string) {
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view instanceof MarkdownView && leaf.view.file?.path === path) {
        const cm = (leaf.view.editor as any).cm as EditorView | undefined;
        const compartment = (cm as any)?._liveCursorCompartment as Compartment | undefined;
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

  private async preserveLocalConflict(file: TFile, content: string) {
    const normalized = file.path.replace(/\\/g, '/');
    const slash = normalized.lastIndexOf('/');
    const parent = slash === -1 ? '' : normalized.slice(0, slash);
    const name = slash === -1 ? normalized : normalized.slice(slash + 1);
    const dot = name.lastIndexOf('.');
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const conflictDir = `Sync Conflicts/${parent}`.replace(/\/$/, '');
    await this.app.vault.adapter.mkdir('Sync Conflicts').catch(() => {});
    if (parent) {
      let current = 'Sync Conflicts';
      for (const part of parent.split('/')) {
        current += `/${part}`;
        await this.app.vault.adapter.mkdir(current).catch(() => {});
      }
    }
    const conflictPath = `${conflictDir}/${base} (Local before sync ${stamp})${ext}`;
    await this.app.vault.adapter.write(conflictPath, content);
    new Notice(`Live Cursor preserved local edits in ${conflictPath}`, 6000);
  }

  // ─────────────────────────────────────────────
  // SYNC FILE
  // ─────────────────────────────────────────────

  private async syncFile(file: TFile) {
    if (this.activeSyncs.has(file.path)) {
      this.configureEditorForFile(file);
      this.updateStatusBar();
      return;
    }

    console.log(`[LiveCursor] Starting sync for ${file.path}`);
    const doc = new Y.Doc();
    const ytext = doc.getText('content');

    const awareness = new Awareness(doc);
    awareness.setLocalStateField('user', {
      name: this.settings.nickname,
      color: this.settings.cursorColor,
      colorLight: this.settings.cursorColor + '33'
    });

    const fileRoomName = getFileRoomName(this.settings.roomName, file.path);
    const serverUrl = normalizeServerUrl(this.settings.signalingUrl);

    // Register all listeners before opening the socket so a fast local server
    // cannot emit the initial sync event before we are ready.
    const provider = new WebsocketProvider(serverUrl, fileRoomName, doc, {
      awareness,
      connect: false,
      params: { workspace: this.settings.roomName, path: file.path }
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
      if (ytext.toString() === '') {
        ytext.insert(0, currentLocalContent);
      } else if (ytext.toString() !== currentLocalContent) {
        // A plain local file has no Yjs history, so pretending it is a CRDT
        // update can overwrite newer remote edits. Preserve it and let the
        // synchronized Y.Doc remain authoritative.
        try {
          await this.preserveLocalConflict(file, currentLocalContent);
        } catch (error) {
          console.error(`[LiveCursor] Failed to preserve local conflict for ${file.path}:`, error);
          new Notice(`Live Cursor could not preserve local edits for ${file.path}`, 8000);
          hasInitialized = false;
          return;
        }
        await this.app.vault.modify(file, ytext.toString());
      }

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
      console.log(`[LiveCursor] Provider status for ${file.path}: ${status}`);

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
      this.statusBarItem.setText('Live Cursor 🟣 Simulating');
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
      this.statusBarItem.setText(`Live Cursor 🟢 ${connected} synced`);
    } else if (connecting > 0) {
      this.statusBarItem.setText('Live Cursor 🟡 Connecting...');
    } else if (this.activeSyncs.size > 0) {
      this.statusBarItem.setText('Live Cursor 🔴 Disconnected');
    } else {
      this.statusBarItem.setText('Live Cursor ⚪ Standby');
    }
  }

  // ─────────────────────────────────────────────
  // SETTINGS
  // ─────────────────────────────────────────────

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

// ─────────────────────────────────────────────────────────────────
// SETTINGS TAB
// ─────────────────────────────────────────────────────────────────

class LiveCursorSettingTab extends PluginSettingTab {
  plugin: LiveCursorPlugin;

  constructor(app: App, plugin: LiveCursorPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // ── Header ──
    const header = containerEl.createEl('div');
    header.style.marginBottom = '24px';
    const title = header.createEl('h2', { text: 'Live Cursor Settings' });
    title.style.margin = '0 0 6px 0';
    const subtitle = header.createEl('p', { text: 'Real-time collaborative editing for your Obsidian vault.' });
    subtitle.style.margin = '0';
    subtitle.style.fontSize = 'var(--font-ui-small)';
    subtitle.style.color = 'var(--text-muted)';

    // ── Quick-Start Tutorial Card ──
    const tutorialCard = containerEl.createEl('div');
    tutorialCard.style.cssText = 'background: linear-gradient(135deg, rgba(99, 102, 241, 0.05) 0%, rgba(139, 92, 246, 0.05) 100%); border: 1px solid rgba(99, 102, 241, 0.22); border-radius: 12px; padding: 18px; margin-bottom: 24px; box-shadow: 0 4px 12px rgba(0,0,0,0.05);';
    tutorialCard.innerHTML = `
      <h3 style="margin: 0 0 8px 0; color: var(--text-accent); font-size: 1.1em; display: flex; align-items: center; gap: 8px;">🎓 Quick-Start Collaboration Guide</h3>
      <p style="margin: 0 0 14px 0; font-size: var(--font-ui-small); color: var(--text-muted); line-height: 1.45;">Follow these simple steps to start collaborating and syncing in real time:</p>
      
      <div style="display: flex; flex-direction: column; gap: 12px; font-size: var(--font-ui-small); line-height: 1.45;">
        <div style="display: flex; align-items: flex-start; gap: 10px;">
          <div style="background: var(--interactive-accent); color: white; border-radius: 50%; width: 20px; height: 20px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; font-weight: bold; font-size: 11px;">1</div>
          <div><strong>Start Local Host (On PC)</strong>: Toggle the <strong>Local Server</strong> below to <span style="color: var(--text-success); font-weight: 600;">🟢 Running</span>. (Your PC acts as the secure host).</div>
        </div>
        
        <div style="display: flex; align-items: flex-start; gap: 10px;">
          <div style="background: var(--interactive-accent); color: white; border-radius: 50%; width: 20px; height: 20px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; font-weight: bold; font-size: 11px;">2</div>
          <div><strong>Connect from Mobile / Laptop</strong>: Ensure all devices are on the same Wi-Fi. Enter your PC's IP address (e.g. <code>ws://YOUR_PC_IP:4444</code>) in the <strong>Server Connection URL</strong> on the other devices.</div>
        </div>
        
        <div style="display: flex; align-items: flex-start; gap: 10px;">
          <div style="background: var(--interactive-accent); color: white; border-radius: 50%; width: 20px; height: 20px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; font-weight: bold; font-size: 11px;">3</div>
          <div><strong>Set Room Name</strong>: All devices collaborating together must use the exact same <strong>Room Name</strong> (e.g. <code>my-shared-room</code>).</div>
        </div>

        <div style="display: flex; align-items: flex-start; gap: 10px;">
          <div style="background: var(--interactive-accent); color: white; border-radius: 50%; width: 20px; height: 20px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; font-weight: bold; font-size: 11px;">4</div>
          <div><strong>Collaborate!</strong>: Open any markdown note and start typing! Remote cursors and highlight ranges will render in real time.</div>
        </div>
      </div>
    `;

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
      statusEl.innerHTML = '<span style="font-size:16px">🟢</span> <span><strong>Server running</strong> on port 4444 — your devices can connect.</span>';
    } else {
      statusEl.style.background = 'rgba(239, 68, 68, 0.1)';
      statusEl.style.border = '1px solid rgba(239, 68, 68, 0.25)';
      statusEl.innerHTML = '<span style="font-size:16px">🔴</span> <span><strong>Server not running.</strong> Start it below to enable local sync.</span>';
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
    ipHint.innerHTML = `
      <strong>📱 Connecting from mobile or another device?</strong><br>
      Find your PC's local IP with <code>ipconfig</code> (Windows) or <code>ifconfig</code> (Mac/Linux),
      then set the server URL below to <code>ws://YOUR_PC_IP:4444</code> on all devices.<br>
      <span style="opacity:0.7">Example: <code>ws://192.168.1.12:4444</code></span>
    `;

    // ── Section: Connection ──
    containerEl.createEl('h3', { text: '🔗 Connection & Room', attr: { style: sectionHeaderStyle() } });

    new Setting(containerEl)
      .setName('Room Name')
      .setDesc('All devices must use the exact same room name to collaborate together.')
      .addText(text => text
        .setPlaceholder('default-live-cursor-room')
        .setValue(this.plugin.settings.roomName)
        .onChange(async (val) => {
          this.plugin.settings.roomName = val || 'default-live-cursor-room';
          if (this.plugin.configSyncEngine) {
            this.plugin.configSyncEngine.workspace = this.plugin.settings.roomName;
          }
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Server Connection URL')
      .setDesc('The WebSocket server all your devices connect to. Default: ws://localhost:4444 (local server on this PC).')
      .addText(text => text
        .setPlaceholder('ws://localhost:4444')
        .setValue(this.plugin.settings.signalingUrl)
        .onChange(async (val) => {
          this.plugin.settings.signalingUrl = val;
          if (this.plugin.configSyncEngine) {
            this.plugin.configSyncEngine.serverUrl = val || 'ws://localhost:4444';
          }
          await this.plugin.saveSettings();
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

    // ── Section: Full Vault Sync ──
    containerEl.createEl('h3', { text: '📂 Full Vault Sync', attr: { style: sectionHeaderStyle() } });
    
    new Setting(containerEl)
      .setName('Sync Entire Vault Configurations')
      .setDesc('Synchronize plugins, themes, snippets, and all configuration files to the server database. This happens automatically in the background, but you can force it here.')
      .addButton(btn => btn
        .setButtonText('Sync Vault Now')
        .setCta()
        .onClick(async () => {
          if (!this.plugin.configSyncEngine) {
            new Notice('Sync engine not initialized.');
            return;
          }
          await this.plugin.configSyncEngine.syncConfig(false);
        }));

    // ── Section: Advanced Database Tools ──
    containerEl.createEl('h3', { text: '🛠️ Advanced Database Tools', attr: { style: sectionHeaderStyle() } });

    new Setting(containerEl)
      .setName('Reconstruct Server Database')
      .setDesc('Purges the server room-state binaries and reconstructs the server database using your current local notes as the source of truth. Use this to instantly resolve any persistent synchronization issues or phantom conflict files.')
      .addButton(btn => btn
        .setButtonText('⚠️ Reconstruct Database')
        .setWarning()
        .onClick(async () => {
          const confirmReset = confirm('⚠️ Are you sure you want to reconstruct the server database?\n\nThis will purge all server-side document history binaries and recreate them from your current local files. Other connected devices will temporarily disconnect and automatically resync.');
          if (confirmReset) {
            await this.plugin.reconstructDatabase();
          }
        }));
  }
}

function sectionHeaderStyle(): string {
  return 'margin-top: 24px; margin-bottom: 12px; border-bottom: 1px solid var(--background-modifier-border); padding-bottom: 6px; font-size: 1.05em;';
}
