import { App, Notice, requestUrl, TFile } from 'obsidian';
import {
  encodeQueryValue,
  getLocalPath,
  getRemotePath,
  normalizeServerUrl,
  normalizeSyncFolder,
  SYNC_PROTOCOL_VERSION,
} from './syncProtocol';

export interface RemoteFile {
  size: number;
  mtime: number;
  hash?: string;
  revision: number;
  deleted?: boolean;
  device?: string;
}

export interface FileManifest {
  [filePath: string]: RemoteFile;
}

interface SyncedFileState {
  hash: string;
  revision: number;
  deleted?: boolean;
}

interface SyncScopeState {
  initialized: boolean;
  files: Record<string, SyncedFileState>;
  unpublished: Record<string, string>;
}

interface StoredSyncState {
  version: 2;
  scopes: Record<string, SyncScopeState>;
}

function shouldIgnoreRemotePath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/');
  return normalized === '.laplas-conflicts' || normalized.startsWith('.laplas-conflicts/');
}

export class ConfigSyncEngine {
  private syncPromise: Promise<boolean> | null = null;
  private syncPending = false;
  private syncStateLoadPromise: Promise<void> | null = null;
  private syncStateSavePromise: Promise<void> = Promise.resolve();
  private syncState: StoredSyncState = { version: 2, scopes: {} };
  private syncStateDirty = false;
  private localCreations = new Set<string>();

  constructor(
    private app: App,
    public serverUrl: string,
    private user: string,
    public pass: string,
    public workspace: string = 'default-workspace',
    private deviceName: string = 'Unknown Device',
    public syncFolder: string = '',
    private isLivePath: (localPath: string) => boolean = () => false,
    private dataDir: string = '.obsidian/plugins/laplas-cowork/data'
  ) {}

  public get folder(): string {
    return normalizeSyncFolder(this.syncFolder, this.workspace);
  }

  public getRemotePath(localPath: string): string | undefined {
    return getRemotePath(localPath, this.folder);
  }

  public getLocalPath(remotePath: string): string {
    return getLocalPath(remotePath, this.folder);
  }

  public markLocalCreation(localPath: string): void {
    const relativePath = this.getRemotePath(localPath);
    if (relativePath && !shouldIgnoreRemotePath(relativePath)) this.localCreations.add(relativePath);
  }

  public async renameLocalFile(oldLocalPath: string, newLocalPath: string): Promise<void> {
    this.markLocalCreation(newLocalPath);
    await this.deleteRemoteFile(oldLocalPath);
  }

  private getQuery(relativePath?: string): string {
    const values = [
      `user=${encodeQueryValue(this.user)}`,
      `pass=${encodeQueryValue(this.pass)}`,
      `workspace=${encodeQueryValue(this.workspace)}`,
      `protocol=${SYNC_PROTOCOL_VERSION}`,
    ];
    if (relativePath !== undefined) values.push(`path=${encodeQueryValue(relativePath)}`);
    return values.join('&');
  }

  private getApiUrl(endpoint: string): string {
    return `${normalizeServerUrl(this.serverUrl).replace(/^ws/i, 'http')}/api${endpoint}`;
  }

  private async getRemoteManifest(): Promise<FileManifest> {
    const res = await requestUrl({ url: `${this.getApiUrl('/manifest')}?${this.getQuery()}`, method: 'GET' });
    if (res.status !== 200) throw new Error(`Server returned HTTP ${res.status}: ${res.text || 'No response body'}`);
    return res.json as FileManifest;
  }

  private async uploadFile(relativePath: string, data: ArrayBuffer, mtime: number, baseRevision: number): Promise<SyncedFileState | null> {
    const url = `${this.getApiUrl('/upload')}?${this.getQuery(relativePath)}` +
      `&mtime=${mtime}&baseRevision=${baseRevision}`;
    const res = await requestUrl({ url, method: 'POST', body: data });
    if (res.status === 409) return null;
    if (res.status !== 200) throw new Error(`Upload failed: ${res.text}`);
    const result = res.json as { hash: string; revision: number };
    return { hash: result.hash, revision: result.revision };
  }

  private async downloadFile(relativePath: string): Promise<ArrayBuffer> {
    const res = await requestUrl({
      url: `${this.getApiUrl('/download')}?${this.getQuery(relativePath)}`,
      method: 'GET',
    });
    if (res.status !== 200) throw new Error(`Download failed for ${relativePath}`);
    return res.arrayBuffer;
  }

  public async deleteRemoteFile(localPath: string): Promise<void> {
    const relativePath = this.getRemotePath(localPath);
    if (!relativePath || shouldIgnoreRemotePath(relativePath)) return;
    await this.loadSyncState();
    const previous = this.getScopeState().files[relativePath];
    if (!previous || previous.deleted) return;
    try {
      const url = `${this.getApiUrl('/delete')}?${this.getQuery(relativePath)}` +
        `&baseRevision=${previous.revision}`;
      const res = await requestUrl({ url, method: 'DELETE' });
      if (res.status === 409) {
        void this.syncConfig(true);
        return;
      }
      if (res.status !== 200) throw new Error(`Server returned HTTP ${res.status}`);
      const result = res.json as { hash?: string; revision: number };
      this.setFileState(relativePath, { hash: result.hash || previous.hash, revision: result.revision, deleted: true });
      await this.saveSyncState();
    } catch (error) {
      console.warn(`[LaplasCowork] Failed to delete remote file ${relativePath}:`, error);
    }
  }

  private async hashData(data: ArrayBuffer): Promise<string> {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  }

  public hashText(text: string): Promise<string> {
    return this.hashData(new TextEncoder().encode(text).buffer as ArrayBuffer);
  }

  private get syncScope(): string {
    return `${normalizeServerUrl(this.serverUrl)}|${this.workspace.trim()}|${this.folder}`;
  }

  private loadSyncState(): Promise<void> {
    return this.syncStateLoadPromise ??= this.readSyncState();
  }

  private async readSyncState(): Promise<void> {
    const statePath = `${this.dataDir}/sync-state-v2.json`;
    try {
      if (!await this.app.vault.adapter.exists(statePath)) return;
      const parsed = JSON.parse(await this.app.vault.adapter.read(statePath)) as StoredSyncState;
      if (parsed.version === 2 && parsed.scopes) this.syncState = parsed;
    } catch (error) {
      console.warn('[LaplasCowork] Could not load scoped sync state.', error);
      this.syncState = { version: 2, scopes: {} };
    }
  }

  private getScopeState(): SyncScopeState {
    return this.syncState.scopes[this.syncScope] ??= { initialized: false, files: {}, unpublished: {} };
  }

  private setFileState(path: string, state: SyncedFileState): void {
    this.getScopeState().files[path] = state;
    this.syncStateDirty = true;
  }

  private saveSyncState(): Promise<void> {
    const save = this.syncStateSavePromise.then(async () => {
      if (!this.syncStateDirty) return;
      const serialized = JSON.stringify(this.syncState);
      this.syncStateDirty = false;
      try {
        await this.app.vault.adapter.mkdir(this.dataDir).catch(() => {});
        await this.app.vault.adapter.write(`${this.dataDir}/sync-state-v2.json`, serialized);
      } catch (error) {
        this.syncStateDirty = true;
        throw error;
      }
    });
    this.syncStateSavePromise = save.catch(() => {});
    return save;
  }

  public async recordSyncedHash(localPath: string, hash: string): Promise<void> {
    await this.loadSyncState();
    const relativePath = this.getRemotePath(localPath);
    if (!relativePath) return;
    const previous = this.getScopeState().files[relativePath];
    if (!previous) return;
    this.setFileState(relativePath, { ...previous, hash, deleted: false });
    await this.saveSyncState();
  }

  public async canCollaborate(localPath: string): Promise<boolean> {
    await this.loadSyncState();
    const relativePath = this.getRemotePath(localPath);
    if (!relativePath) return false;
    const scope = this.getScopeState();
    return Boolean(scope.files[relativePath] && !scope.files[relativePath]?.deleted && !scope.unpublished[relativePath]);
  }

  public async publishLocalFiles(): Promise<void> {
    if (!await this.syncConfig(false)) return;
    const scope = this.getScopeState();
    scope.unpublished = {};
    this.syncStateDirty = true;
    await this.saveSyncState();
    await this.syncConfig(false);
  }

  private async removeLocalFile(localPath: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(localPath);
    if (file instanceof TFile) await this.app.vault.delete(file);
    else if (await this.app.vault.adapter.exists(localPath)) await this.app.vault.adapter.remove(localPath);
  }

  private async ensureDirExists(localPath: string): Promise<void> {
    const parts = localPath.replace(/\\/g, '/').split('/');
    let current = '';
    for (let i = 0; i < parts.length - 1; i++) {
      current = current ? `${current}/${parts[i]}` : parts[i] as string;
      if (!await this.app.vault.adapter.exists(current)) {
        await this.app.vault.adapter.mkdir(current).catch(() => {});
      }
    }
  }

  private async writeLocal(relativePath: string, data: ArrayBuffer): Promise<void> {
    const localPath = this.getLocalPath(relativePath);
    await this.ensureDirExists(localPath);
    await this.app.vault.adapter.writeBinary(localPath, data);
  }

  private async preserveConflict(relativePath: string, data: ArrayBuffer, source: string): Promise<void> {
    const hash = await this.hashData(data);
    const normalized = relativePath.replace(/\\/g, '/');
    const slash = normalized.lastIndexOf('/');
    const parent = slash === -1 ? '' : normalized.slice(0, slash);
    const name = slash === -1 ? normalized : normalized.slice(slash + 1);
    const dot = name.lastIndexOf('.');
    const base = dot > 0 ? name.slice(0, dot) : name;
    const extension = dot > 0 ? name.slice(dot) : '';
    const safeSource = source.replace(/[\\/:*?"<>|]/g, '-');
    const conflictPath = `${this.folder}/.laplas-conflicts/${parent ? `${parent}/` : ''}` +
      `${base} (${safeSource} ${hash.slice(0, 12)})${extension}`;
    await this.ensureDirExists(conflictPath);
    if (await this.app.vault.adapter.exists(conflictPath)) {
      const existing = await this.app.vault.adapter.readBinary(conflictPath);
      if (await this.hashData(existing) === hash) return;
    }
    await this.app.vault.adapter.writeBinary(conflictPath, data);
  }

  public async syncConfig(silent: boolean = false): Promise<boolean> {
    if (this.syncPromise) {
      this.syncPending = true;
      if (!silent) new Notice('Sync already in progress...');
      return this.syncPromise;
    }
    this.syncPromise = this.runSync(silent).finally(() => {
      this.syncPromise = null;
      if (this.syncPending) {
        this.syncPending = false;
        void this.syncConfig(true);
      }
    });
    return this.syncPromise;
  }

  private async runSync(silent: boolean): Promise<boolean> {
    if (!silent) new Notice(`Syncing ${this.folder}...`, 2000);
    try {
      await this.loadSyncState();
      await this.app.vault.adapter.mkdir(this.folder).catch(() => {});
      const remoteManifest = await this.getRemoteManifest();
      const scope = this.getScopeState();
      const firstSync = !scope.initialized;
      const localMap = new Map<string, { localPath: string; stat: { mtime: number } }>();

      const scanDir = async (dir: string): Promise<void> => {
        const list = await this.app.vault.adapter.list(dir);
        for (const localPath of list.files) {
          const relativePath = this.getRemotePath(localPath);
          if (!relativePath || shouldIgnoreRemotePath(relativePath)) continue;
          const stat = await this.app.vault.adapter.stat(localPath);
          if (stat) localMap.set(relativePath, { localPath, stat });
        }
        for (const folder of list.folders) {
          const relativePath = this.getRemotePath(folder);
          if (relativePath && !shouldIgnoreRemotePath(relativePath)) await scanDir(folder);
        }
      };
      await scanDir(this.folder);

      const allPaths = new Set([...localMap.keys(), ...Object.keys(remoteManifest)]);
      let actionsCount = 0;

      for (const relativePath of allPaths) {
        const local = localMap.get(relativePath);
        const remote = remoteManifest[relativePath];
        const localPath = local?.localPath ?? this.getLocalPath(relativePath);
        if (this.isLivePath(localPath) && !remote?.deleted) continue;

        if (remote?.deleted) {
          if (local) {
            const localData = await this.app.vault.adapter.readBinary(local.localPath);
            const localHash = await this.hashData(localData);
            if (this.localCreations.has(relativePath)) {
              const recreated = await this.uploadFile(relativePath, localData, local.stat.mtime, remote.revision);
              if (recreated) {
                this.localCreations.delete(relativePath);
                delete scope.unpublished[relativePath];
                this.setFileState(relativePath, recreated);
                actionsCount++;
              } else {
                this.syncPending = true;
              }
              continue;
            }
            if (localHash !== remote.hash) await this.preserveConflict(relativePath, localData, this.deviceName);
            await this.removeLocalFile(local.localPath);
            actionsCount++;
          }
          delete scope.unpublished[relativePath];
          this.setFileState(relativePath, {
            hash: remote.hash || '',
            revision: remote.revision,
            deleted: true,
          });
          continue;
        }

        if (local && !remote) {
          const data = await this.app.vault.adapter.readBinary(local.localPath);
          const localHash = await this.hashData(data);
          const createdNow = this.localCreations.has(relativePath);
          if (!createdNow && (firstSync || scope.unpublished[relativePath])) {
            scope.unpublished[relativePath] = localHash;
            this.syncStateDirty = true;
            continue;
          }
          const uploaded = await this.uploadFile(relativePath, data, local.stat.mtime, 0);
          if (uploaded) {
            this.localCreations.delete(relativePath);
            delete scope.unpublished[relativePath];
            this.setFileState(relativePath, uploaded);
            actionsCount++;
          } else {
            this.syncPending = true;
          }
          continue;
        }

        if (!local && remote) {
          const data = await this.downloadFile(relativePath);
          await this.writeLocal(relativePath, data);
          delete scope.unpublished[relativePath];
          this.localCreations.delete(relativePath);
          this.setFileState(relativePath, {
            hash: remote.hash ?? await this.hashData(data),
            revision: remote.revision,
          });
          actionsCount++;
          continue;
        }

        if (!local || !remote) continue;
        const localData = await this.app.vault.adapter.readBinary(local.localPath);
        const localHash = await this.hashData(localData);
        const remoteHash = remote.hash ?? '';
        if (localHash === remoteHash) {
          delete scope.unpublished[relativePath];
          this.localCreations.delete(relativePath);
          this.setFileState(relativePath, { hash: remoteHash, revision: remote.revision });
          continue;
        }

        const previous = scope.files[relativePath];
        const localChanged = Boolean(previous && localHash !== previous.hash);
        const remoteChanged = !previous || remoteHash !== previous.hash || remote.revision !== previous.revision;

        if (localChanged && !remoteChanged && previous) {
          const uploaded = await this.uploadFile(relativePath, localData, local.stat.mtime, previous.revision);
          if (uploaded) {
            this.setFileState(relativePath, uploaded);
            actionsCount++;
          } else {
            this.syncPending = true;
          }
        } else {
          await this.preserveConflict(relativePath, localData, this.deviceName);
          const remoteData = await this.downloadFile(relativePath);
          await this.writeLocal(relativePath, remoteData);
          delete scope.unpublished[relativePath];
          this.setFileState(relativePath, {
            hash: remoteHash || await this.hashData(remoteData),
            revision: remote.revision,
          });
          actionsCount++;
        }
      }

      scope.initialized = true;
      this.syncStateDirty = true;
      if (!silent) new Notice(actionsCount ? `Sync complete (${actionsCount} updated)` : 'Room folder is in sync.', 2000);
      return true;
    } catch (error: any) {
      console.error('[LaplasCowork] Sync Error:', error);
      if (!silent) new Notice(`Sync failed: ${error.message || String(error)}`, 5000);
      return false;
    } finally {
      await this.saveSyncState().catch(error => console.error('[LaplasCowork] Failed to save sync state:', error));
    }
  }
}
