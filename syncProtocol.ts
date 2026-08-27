export type SyncDecision = 'equal' | 'upload' | 'download' | 'conflict' | 'bootstrap';

export function decideSyncAction(
  baseHash: string | undefined,
  localHash: string,
  remoteHash: string
): SyncDecision {
  if (localHash === remoteHash) return 'equal';
  if (baseHash === undefined) return 'bootstrap';
  if (localHash === baseHash) return 'download';
  if (remoteHash === baseHash) return 'upload';
  return 'conflict';
}

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

export function encodeQueryValue(value: string): string {
  return encodeURIComponent(value);
}
