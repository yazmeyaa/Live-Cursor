# Release Notes — Version 2.1.1

- Fixed newly created files being immediately removed when their path had an existing server tombstone.
- Files created during the current session now safely recreate that exact tombstone revision without allowing stale devices to resurrect deleted data.
