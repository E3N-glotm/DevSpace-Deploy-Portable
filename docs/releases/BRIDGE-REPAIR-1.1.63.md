# v1.1.63 — legacy upgrade bridge and public health correction

The v1.1.63 Windows ZIP, blockmap and bridge assets are rebuilt together for
this same-version corrective publication. The already-published old ZIP was
complete, but did not contain the newer shallow-upgrade or public probe fixes.
The earlier `file-delta-v1` legacy bridges installed the compact Electron
launcher without installing Electron itself, but the new launcher did not
honor the previous native UI's `legacy-upgrade-bootstrap.json` hand-off.
This stranded some installations after the first (shallow) upgrade step.

The replacement bridge ZIPs for 1.1.36, 1.1.37, 1.1.38, 1.1.39 and 1.1.61:

- Include a rebuilt Next launcher which first recognizes the legacy marker
  and triggers a same-version ForceFull installation before checking Electron.
- Include a manager with classic WMI (`Get-WmiObject`) fallback when CIM
  (`Get-CimInstance`) process enumeration fails. If neither can prove exact
  process ownership, the update still stops safely before changing files.
- Preserve the published version manifest, updater binary/script and legacy
  marker exactly. The rest of the historical update graph is unchanged.
- Refresh `update-manifest.json` and `SHA256SUMS-release.txt` so new bridge
  sizes and hashes validate correctly for existing update clients.

Source of truth: download the 5 **original published bridges** and update
manifest/checksum file before rebuilding. The developer's local ZIP with the
same filename is *not* necessarily byte-identical to the GitHub Release.

The repair is shipped in both the rebuilt full ZIP and the five legacy bridges.
The existing version tag is not moved. The updated main-branch correction
commit and rebuilt release asset digests identify the precise revised build.

The Home public MCP card also no longer reports **red** merely because one
two-second outbound test timed out. Its endpoint probe now permits eight
seconds, retains recent successful evidence, and distinguishes transient
probe uncertainty from repeated explicit HTTP failures.

**Already affected users:** If the old bridge already replaced the launcher,
changing the online asset will not replace that local partially installed
launcher retroactively. Use the read-only diagnosis and full-package recovery
instructions in `docs/releases/LEGACY-NEXT-BOOTSTRAP-RECOVERY.md`; preserve
`data/`, `logs/`, `reports/` and never indiscriminately kill other processes.
