# DevSpace Portable 1.1.43

1.1.43 is the blockmap differential-update release. Portable Protocol remains 1.5. The main change is the updater distribution topology: new clients no longer need a growing historical delta graph to reach the latest version.

## Block-pack v2 differential updater

- Every Release keeps the normal `DevSpacePortable-Windows-x64-<version>.zip` as the final compatibility fallback and now also publishes `DevSpacePortable-Windows-x64-<version>.blockmap`.
- The blockmap is a content-addressed block pack, not a JSON list over the compressed ZIP. Target files are divided into 1 MiB logical chunks, unique chunks are stored once, and each chunk is independently `zlib` compressed or stored raw when secondary compression would be larger.
- A compact authenticated header records every target file SHA-256, its ordered chunk hashes, and the physical offset/encoded size of every unique chunk. `update-manifest.json` pins the blockmap asset SHA-256 plus the compressed-header size and SHA-256 before any Range payload is trusted.
- The installed client scans the same target path/offset in the existing Portable tree. A local chunk is reused only when its size and SHA-256 match the target block hash. Missing unique chunks are fetched with bounded HTTP Range requests, decompressed independently, and SHA-256 checked before use.
- Reconstructed files are written into the normal staging tree and each completed file is verified against its target SHA-256. Only then does the existing detached updater enter the normal transactional Apply path. `data`, `logs`, and `reports` remain persistent roots and are never reconstructed by the blockmap pack.

## Faster Release downloads and failover

- The differential engine probes configured GitHub mirrors, inherited proxy candidates and the official Release URL in parallel with a bounded 128 KiB Range request.
- A candidate is accepted only when it actually returns HTTP 206 with the exact requested byte count. Healthy candidates are ranked using measured total time, download speed and TTFB rather than a fixed mirror order.
- Missing-chunk Range groups use the ranked list and fail over without trusting a mirror merely because its hostname is configured. This avoids long stalls on a reachable but slow or Range-incompatible mirror.
- Existing full-package transports remain available, including Windows system proxy, explicit proxy/environment settings, direct/TUN .NET, direct curl, mirror-first endpoints, resume support and full-package SHA-256 verification.

## Compatibility topology

- v1.1.42 is the last published updater that does not understand block-pack v2. Each post-1.1.42 Release therefore publishes one compatibility asset, `DevSpacePortable-Update-1.1.42-to-<latest>.zip`.
- That single edge means an installed 1.1.42 client may skip any number of Releases and still bootstrap directly into the current blockmap-capable updater. It does not require one `to-latest` asset for every historical version.
- Once a client is on 1.1.43 or newer, it can reconstruct the newest Release directly from its current installation plus the newest blockmap. Intermediate Releases are not downloaded or applied.
- 1.1.40-1.1.42 retain their historical migration assets unchanged. Very old 1.1.32-1.1.39 clients may continue to use their existing compatibility route or the full-package fallback when jumping beyond the migration Releases.

## Integrity and fallback behavior

The preferred order is now:

1. authenticated blockmap differential reconstruction;
2. legacy `file-delta-v1` direct/chain compatibility path when available;
3. complete Release ZIP.

The blockmap path fails closed on an invalid header digest, unsafe path, missing chunk index, non-206 Range source, chunk hash mismatch, reconstructed file hash mismatch or target-version mismatch. A staging failure removes the partial blockmap staging directory and continues to the legacy/full fallback. Apply-time failure continues to use the existing pre-update backup, rollback, task repair and service-recovery logic.

## Regression coverage

The new regression suite covers:

- real HTTP 206 Range serving against a synthetic target tree;
- local reuse of unchanged 1 MiB blocks;
- missing-block download and target reconstruction;
- target-file SHA-256 equality after reconstruction;
- authenticated blockmap-header rejection on a wrong digest;
- rejection of an endpoint that ignores Range and returns HTTP 200;
- Windows `NamedTemporaryFile` cleanup semantics;
- release workflow enforcement of one 1.1.42 bootstrap edge and no new carry-forward graph after the compatibility boundary.

The release remains compatible with the existing OAuth database, tokens, explicit Memories, plugins, session state and Remote Workspace Agent configuration. No data-schema migration is required.
