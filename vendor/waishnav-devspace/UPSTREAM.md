# Upstream provenance

- Upstream repository: `https://github.com/Waishnav/devspace`
- Upstream package: `@waishnav/devspace@1.0.5`
- Pinned upstream release commit: `dca3b6a345a9285e63446d72376afdafe8c72af4`
- Upstream license: MIT (`LICENSE` in this directory)

This directory is the maintained Portable fork consumed by the Windows
distribution. It contains the published ESM package layout plus Portable
changes. Do not edit the generated installation under `app/node_modules`;
modify this directory, run `npm run core:pack`, and reinstall `app/`.

The Portable project currently maintains the published `dist/` package as its
controlled integration surface. A future cleanup may port all changes back to
the upstream TypeScript source tree, but until that migration is complete this
directory is the authoritative reviewable source used by Releases.

