export const SYNC_PROTOCOL_VERSION = '2';

export function normalizeServerUrl(url: string): string {
  let cleaned = (url || '').trim();
  if (!cleaned) return 'ws://localhost:4444';
  if (!/^https?:\/\//i.test(cleaned) && !/^wss?:\/\//i.test(cleaned)) {
    cleaned = 'ws://' + cleaned;
  }
  if (/^http:\/\//i.test(cleaned)) cleaned = cleaned.replace(/^http:\/\//i, 'ws://');
  else if (/^https:\/\//i.test(cleaned)) cleaned = cleaned.replace(/^https:\/\//i, 'wss://');
  return cleaned.replace(/\/+$/, '').replace(/\/sync\/?$/i, '').replace(/\/+$/, '');
}

export function getFileRoomName(workspace: string, filePath: string): string {
  const normalizedWorkspace = (workspace || 'default').trim() || 'default';
  const normalizedPath = filePath.replace(/\\/g, '/');
  return `${encodeURIComponent(normalizedWorkspace)}--${encodeURIComponent(normalizedPath)}`;
}

export function getDefaultSyncFolder(workspace: string): string {
  const safeWorkspace = ((workspace || 'default-workspace').trim() || 'default-workspace')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\.+$/g, '') || 'default-workspace';
  return `${safeWorkspace}[laplas_cowork]`;
}

export function normalizeSyncFolder(folder: string, workspace: string): string {
  const candidate = (folder || getDefaultSyncFolder(workspace)).trim().replace(/\\/g, '/');
  const rawParts = candidate.split('/').filter(part => part && part !== '.');
  if (rawParts.length === 0 || rawParts.some(part => part === '..')) {
    return getDefaultSyncFolder(workspace);
  }
  const parts = rawParts.map(part => part.replace(/[\\:*?"<>|]/g, '-').replace(/\.+$/g, '').trim());
  const protectedRoots = new Set(['.obsidian', '.git', '.trash', 'node_modules']);
  if (parts.some(part => !part) || protectedRoots.has((parts[0] as string).toLowerCase())) {
    return getDefaultSyncFolder(workspace);
  }
  return parts.join('/');
}

export function getRemotePath(localPath: string, syncFolder: string): string | undefined {
  const normalizedPath = localPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const normalizedFolder = syncFolder.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!normalizedFolder || normalizedPath === normalizedFolder) return undefined;
  const prefix = `${normalizedFolder}/`;
  return normalizedPath.startsWith(prefix) ? normalizedPath.slice(prefix.length) : undefined;
}

export function getLocalPath(remotePath: string, syncFolder: string): string {
  const normalizedRemote = remotePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const parts = normalizedRemote.split('/');
  if (!normalizedRemote || parts.some(part => !part || part === '.' || part === '..')) {
    throw new Error('Invalid remote path');
  }
  return `${syncFolder.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')}/${normalizedRemote}`;
}

export function encodeQueryValue(value: string): string {
  return encodeURIComponent(value);
}
