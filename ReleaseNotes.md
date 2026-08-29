# Release Notes — Version 2.1.0

- Laplas Cowork now works only inside a configurable isolated room folder.
- New devices pull server state first; existing local files are published only after explicit confirmation.
- Server revisions reject stale uploads, deletes, and tombstone resurrection.
- Server-owned Yjs bootstrap prevents duplicate full-document insertion.
- Legacy truncated room lookup was removed to prevent cross-document state collisions.
