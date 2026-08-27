# Release Notes — Version 2.0.1

- Fixed table-cell editing during active collaboration by restoring native CodeMirror focus handling.
- Reduced false conflict files with three-way local/base/server hash comparison.
- Deduplicated repeated conflict snapshots by content hash.
- Migrated synchronization state from the previous `live-cursor` plugin directory.
- Hardened concurrent loading and saving of synchronization state.
