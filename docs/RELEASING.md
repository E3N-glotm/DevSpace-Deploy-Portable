# Release process

## Version preparation

1. Update code and tests.
2. Add `docs/releases/HOTFIX-<version>.md`.
3. Update `CHANGELOG.md`, README, UI, server, Portable manager, test strings,
   and `VERSION-MANIFEST.json`.
4. Run:

```powershell
npm run source:verify
npm run core:pack
npm ci --prefix app
node setup/harden-nested-dependencies.mjs
PowerShell -NoProfile -ExecutionPolicy Bypass -File scripts/test-source.ps1 -SkipInstall
npm audit --omit=dev --prefix app
python setup/finalize-release.py <version> --hotfix docs/releases/HOTFIX-<version>.md
python setup/build-release.py
```

The order above is intentional. `core:pack` may update the local core archive
and lockfile, so `npm ci --prefix app` must run after the current pack before a
formal ZIP is built. `test-source.ps1 -SkipInstall` is only valid here because
the clean install has already completed in the preceding step. Running
`build-release.py` directly against a stale lockfile or stale
`app/node_modules/@waishnav/devspace` is rejected by the release preflight.

The source preflight also checks the working-tree EOLs declared by
`.gitattributes`. This matters on long-lived Windows checkouts: Git can regard
the logical text as clean while the on-disk LF/CRLF representation has drifted,
which would otherwise change the bytes placed in a Portable ZIP or core TGZ.
Re-materialize the checkout before releasing if that check fails.

Generated Python bytecode is never part of the maintained core package.
`__pycache__`, `*.pyc`, and `*.pyo` are excluded by the core packer so running
Python-side tests before a pack cannot perturb the release payload.

Every full `DevSpacePortable-Windows-x64-<version>.zip` must include the bundled
`codex-runtime-bridge` plugin under
`data/plugins/installed/codex-runtime-bridge/<version>/`. This is a mandatory
release invariant, not an optional extra. `setup/build-release.py` validates
the manifest, runtime, keep-awake helper, and Skill payload and fails the build
if the bundled plugin is absent or incomplete.

Incremental `DevSpacePortable-Update-<from>-to-<version>.zip` packages also
always carry the `setup/bundled-plugins/codex-runtime-bridge/` seed payload,
even when that plugin is byte-identical to the base release. This keeps every
official DevSpace ZIP self-contained with the bridge payload while still
excluding user-persistent `data/`, `logs/`, and `reports/` roots from deltas.

Versioned packed-core archives under
`packages/waishnav-devspace-<semver>.tgz` are special-cased when they disappear
from a target release. The delta records them as `retainedObsoleteFiles`
instead of strict `deletedFiles`. The target lockfile points at the new core
archive, so an older TGZ is inert; retaining it avoids rejecting historical
same-version repacks whose generated TGZ bytes differ from the canonical base.
All ordinary deleted program files keep the existing base-SHA drift guard.

Version 1.1.40 is the updater migration checkpoint. Its GitHub workflow builds
exact deltas from every canonical 1.1.32-1.1.39 full ZIP plus the historical
1.1.33 direct-extract rescue overlay. Version 1.1.41 is the stable follow-up to
that migration and intentionally repeats the exact 1.1.32-1.1.39 compatibility
edges while also publishing the normal 1.1.40 -> 1.1.41 adjacent edge. This is
required because installed 1.1.32-1.1.39 clients can only select one exact
fromVersion -> latest edge. The final 1.1.42 repack expands the direct matrix
through 1.1.41 except 1.1.35 (and retains 1.1.32 compatibility), while introducing
`block-pack-v2`. These generated ZIPs live only on the Release. Later Releases
keep one direct `1.1.42 -> current` legacy delta as a bootstrap bridge for an
earlier installed 1.1.42 updater; blockmap-capable clients do not need a
growing previous -> current graph.

## Tag release

Commit the release state, then create an annotated tag:

```powershell
git tag -a v<version> -m "DevSpace Portable <version>"
git push origin main --follow-tags
```

The GitHub Release workflow uses the tag version, restores bundled runtimes
from the latest existing stable Release, performs a clean dependency install,
runs tests, rebuilds the Portable ZIP, and uploads:

- `DevSpacePortable-Windows-x64-<version>.zip`
- for `v1.1.40`, eight migration deltas from `1.1.32` through `1.1.39`;
- for `v1.1.41`, eight direct legacy deltas from `1.1.32` through `1.1.39`
  plus `DevSpacePortable-Update-1.1.40-to-1.1.41.zip`;
- for the final `v1.1.42` repack, nine direct deltas from `1.1.32`, `1.1.33`,
  `1.1.34` and `1.1.36` through `1.1.41`; `1.1.35` is intentionally omitted;
- for `v1.1.42` and later, `DevSpacePortable-Windows-x64-<version>.blockmap`,
  the content-addressed Range-download asset;
- after `v1.1.42`, one `DevSpacePortable-Update-1.1.42-to-<version>.zip`
  bootstrap edge for the legacy 1.1.42 updater;
- the `1.1.33 -> target` Rescue overlay on the 1.1.40, 1.1.41 and 1.1.42 compatibility Releases;
- `release-assets/update-manifest.json`
- `release-assets/SHA256SUMS-release.txt`

The 1.1.40-1.1.42 compatibility manifests carry `incrementalGraphAssets`, a
compact SHA-256/size/download-URL graph copied forward from the previous
manifest plus the current Release edge. The 1.1.42 manifest also carries
`blockmapAsset`, including the block-pack SHA-256, compressed-header size and
compressed-header SHA-256. The client validates that header, reuses matching
local 1 MiB chunks and downloads only missing packed chunks with HTTP Range.
Later manifests use this blockmap metadata as the primary path and do not need
to keep expanding the historical graph. Legacy incremental and full ZIP paths
remain bounded fallbacks.

The blockmap excludes persistent `data`, `logs` and `reports` content except
for the fixed Release-owned `data/plugins/installed/codex-runtime-bridge/`
seed prefix present in the full ZIP checksum manifest. Apply still preserves
the live `data` tree; the existing manager seed remains non-destructive.

Use the `Backfill Incremental Update` workflow for that case. It downloads the
already-published canonical full ZIPs for both versions on a GitHub runner,
builds `DevSpacePortable-Update-<from>-to-<to>.zip`, preserves the delta and
rescue entries already advertised by the target Release manifest, refreshes
`update-manifest.json` and `SHA256SUMS-release.txt`, and uploads only those
supplemental updater assets. It never rebuilds or replaces the target full ZIP.

Version 1.1.40 is the migration checkpoint for the long-term updater topology.
Its Release workflow downloads the canonical 1.1.32 through 1.1.39 full ZIPs on
the GitHub runner and publishes eight exact `*-to-1.1.40.zip` migration deltas.
Version 1.1.41 repeats those eight legacy compatibility edges to the new latest
stable target and adds the adjacent `1.1.40 -> 1.1.41` edge. Those generated
ZIPs are Release assets only; they are never committed to Git. The final
1.1.42 repack refreshes the exact direct edges from 1.1.32 through 1.1.41 except
1.1.35. The omitted 1.1.35 asset must not remain on the repacked Release, so no
published same-version asset points at an older target tree.

After 1.1.42, do **not** pass the previous manifest through
`--carry-forward-manifest`. Generate the latest full ZIP, latest `.blockmap`,
and one `1.1.42 -> latest` compatibility delta. The bridge exists only to
bootstrap an earlier installed 1.1.42 updater into the blockmap-capable runtime;
after that, clients jump directly to the newest Release by reconstructing the
target from local blocks plus missing Range data. This keeps Git history free
of binary update artifacts and prevents the latest Release metadata from
accumulating an unbounded historical edge graph.

## First bootstrap Release

The first source-only repository Release could not hydrate its runtime from an
older Release. Version 1.1.14 is the validated bootstrap source; version
1.1.15 and later may restore the runtime from any compatible stable Release.

The repository includes a GitHub CLI wrapper that reads `GH_TOKEN`,
`GITHUB_TOKEN`, or the current Git credential store without printing or
writing the credential to a temporary file. Install GitHub CLI first with
`winget install --id GitHub.cli --exact --scope user`:

```powershell
PowerShell -NoProfile -ExecutionPolicy Bypass -File scripts/publish-github-release.ps1 -Version 1.1.38 -BypassProxy
```

`-BypassProxy` is optional. Use it when a local HTTP proxy makes large Release
uploads substantially slower and the machine can reach GitHub directly.

The manual publisher is idempotent by default. An existing asset is skipped
when its GitHub SHA-256, size, and upload state already match the local file.
If the same Release already contains an asset with the same name but different
bytes, the script fails before calling `--clobber`. Use `-AllowRepack` only for
an intentional same-version replacement after the new full ZIP, deltas,
manifest, checksums, and upgrade path have been independently validated.

## Public-release requirements

The repository and Releases are public. Before each public binary Release:

1. remove bundled `runtime/ngrok/ngrok.exe` from the public ZIP or obtain
   redistribution permission;
2. replace it with an official first-run download and SHA-256 verification;
3. review third-party notices and generated SBOM;
4. confirm no historical commit or Release contains credentials or local
   runtime state.
