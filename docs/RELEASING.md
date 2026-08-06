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
python setup/create-update-manifest.py --repository E3N-glotm/DevSpace-Deploy-Portable
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
- `release-assets/update-manifest.json`
- `release-assets/SHA256SUMS-release.txt`

## First bootstrap Release

The first source-only repository Release cannot hydrate its runtime from an
older Release. Upload the already validated 1.1.14 ZIP manually. All later
versions can use 1.1.14 as the runtime bootstrap source.

The repository includes a streaming uploader that reads `GH_TOKEN`,
`GITHUB_TOKEN`, or the current Git credential store without printing the
credential:

```powershell
PowerShell -NoProfile -ExecutionPolicy Bypass -File scripts/publish-github-release.ps1 -Version 1.1.14
```

## Public-release gate

Before changing repository or Releases from private to public:

1. remove bundled `runtime/ngrok/ngrok.exe` from the public ZIP or obtain
   redistribution permission;
2. replace it with an official first-run download and SHA-256 verification;
3. review third-party notices and generated SBOM;
4. confirm no historical commit or Release contains credentials or local
   runtime state.

