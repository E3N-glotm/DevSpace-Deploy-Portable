# Release process

## Version preparation

1. Update code and tests.
2. Add `docs/releases/HOTFIX-<version>.md`.
3. Update `CHANGELOG.md`, README, UI, server, Portable manager, test strings,
   and `VERSION-MANIFEST.json`.
4. Run:

```powershell
npm run core:pack
python setup/finalize-release.py <version> --hotfix docs/releases/HOTFIX-<version>.md
PowerShell -NoProfile -ExecutionPolicy Bypass -File scripts/test-source.ps1
python setup/build-release.py
python setup/create-incremental-update.py --base-zip <previous-full.zip> --target-zip DevSpacePortable-Windows-x64-<version>.zip
python setup/create-update-manifest.py --repository E3N-glotm/DevSpace-Deploy-Portable --incremental DevSpacePortable-Update-<previous>-to-<version>.zip
```

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
- `DevSpacePortable-Update-<previous>-to-<version>.zip`
- `release-assets/update-manifest.json`
- `release-assets/SHA256SUMS-release.txt`

## First bootstrap Release

The first source-only repository Release could not hydrate its runtime from an
older Release. Version 1.1.14 is the validated bootstrap source; version
1.1.15 and later may restore the runtime from any compatible stable Release.

The repository includes a GitHub CLI wrapper that reads `GH_TOKEN`,
`GITHUB_TOKEN`, or the current Git credential store without printing or
writing the credential to a temporary file. Install GitHub CLI first with
`winget install --id GitHub.cli --exact --scope user`:

```powershell
PowerShell -NoProfile -ExecutionPolicy Bypass -File scripts/publish-github-release.ps1 -Version 1.1.16 -BypassProxy
```

`-BypassProxy` is optional. Use it when a local HTTP proxy makes large Release
uploads substantially slower and the machine can reach GitHub directly.

## Public-release requirements

The repository and Releases are public. Before each public binary Release:

1. remove bundled `runtime/ngrok/ngrok.exe` from the public ZIP or obtain
   redistribution permission;
2. replace it with an official first-run download and SHA-256 verification;
3. review third-party notices and generated SBOM;
4. confirm no historical commit or Release contains credentials or local
   runtime state.

