export function getFileRoomName(workspace: string, filePath: string): string {
  const normalizedWorkspace = (workspace || 'default').trim() || 'default';
  const normalizedPath = filePath.replace(/\\/g, '/');
  return `${encodeURIComponent(normalizedWorkspace)}--${encodeURIComponent(normalizedPath)}`;
}

export function encodeQueryValue(value: string): string {
  return encodeURIComponent(value);
}
