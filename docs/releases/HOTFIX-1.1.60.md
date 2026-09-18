# DevSpace Portable 1.1.60

`1.1.60` is the first stable release after the internal `1.1.59 dev*` series.
It consolidates the automatic-continuation work, Portable runtime/UI hardening,
Computer Use permission fixes, Remote Agent recovery improvements, and the new
legacy updater bootstrap into one production release.

## Automatic continuation

- Automatic continuation is authorized only by a model-signed unfinished-stage
  boundary or Host-cutoff recovery. Ordinary tool silence is not treated as
  proof that the model stopped, so long reasoning/reply windows are not
  preempted merely because no DevSpace tool was called for a while.
- Manual user input keeps priority over synthetic continuation. Generation,
  sender, delivery and ACK state use the durable continuation ledger and
  fail-closed fencing used by the dev85-dev90 live acceptance runs.
- Synthetic turns restore the durable objective/milestones, ACK the exact
  delivery generation, and must continue substantive work rather than ending
  after a status-only or short placeholder response.
- A runnable synthetic turn is tool-only. After the status ACK, and after every
  subsequent substantive tool result, the next model output must be another
  substantive DevSpace tool call while any milestone remains runnable. Text
  such as `继续` / `继续处理中` / `still working`, progress summaries and
  promises are not valid in-turn yield points: current ChatGPT Host behavior can
  surface such prose as a real final, after which no background model execution
  continues. The milestone card and native tool activity are the live progress
  surface until the Task Contract reaches a terminal/non-runnable boundary.
- The current ChatGPT Apps surface does not expose an authoritative timeout
  lifecycle event. Where required, cutoff recovery uses the separately bounded
  clustered historical-cutoff fallback and records that distinction instead of
  pretending it received a Host timeout callback.

## Portable performance and Computer Use

- Native UI heartbeat, dashboard and continuation refreshes are consolidated
  into one low-frequency `ui-runtime-poll` (15 s while visible, 30 s in tray),
  eliminating the previous independent short-lived Node polling loops.
- Native Computer Use queue handling is event-driven with `FileSystemWatcher`
  rather than a 15 ms directory poll. The non-native compatibility broker uses
  a low-frequency fallback path.
- Disabling Computer Use is an immediate live kill-switch. The persisted UI
  lease, server tool guard, broker and Native worker all fail closed. Native
  input/capture rechecks the exact lease id, `computerUseEnabled=true`, and an
  unexpired lease immediately before execution, so a request that arrives after
  the owner disables Computer Use is rejected and cannot survive until a later
  re-enable.

## Remote Agent and runtime reliability

- Root-only SSH targets can explicitly install/update a root Remote Agent via
  the Portable SSH workflow. Root service remains opt-in; ordinary sudo/root
  installer use keeps the safer ordinary-user fallback/default denial.
- Local MCP restart, task recovery, sender rebinding and updater transactions
  retain rollback/fail-closed behavior validated throughout the dev series.
- Portable process ownership now carries process creation identity in addition
  to PID/ParentProcessId. A stale parent PID left behind after its creator exits
  cannot be mistaken for a later Windows process that reused the same numeric
  PID, preventing strict stop from incorrectly exempting an owned orphan on
  fast-recycling Windows runners.

## Updating from older releases

The in-place one-click update path is validated for every actually published
release in the `1.1.36`-`1.1.58` compatibility set:

`1.1.36`, `1.1.37`, `1.1.38`, `1.1.39`, `1.1.40`, `1.1.41`, `1.1.42`,
`1.1.43`, `1.1.44`, `1.1.45`, `1.1.46`, `1.1.47`, `1.1.48`, `1.1.49`,
`1.1.51`, `1.1.52`, `1.1.54`, `1.1.56`, `1.1.57`, `1.1.58`.

These versions do not have to unpack the complete modern package with their old
updater. `1.1.60` publishes a shallow exact-version bootstrap delta that first
installs the hardened update control chain; the new control center then performs
an automatic same-version full repair. This specifically avoids the historical
deep-path `.NET ZipFile.ExtractToDirectory` failure while preserving the live
`data`, `logs`, and `reports` trees.

Release acceptance exercises the historical updater script from all 20 versions
for route selection, legacy .NET extraction, and the actual incremental Apply
transaction, followed by the same-version full-repair transaction with
persistent-root sentinels intact.

`1.1.14`-`1.1.35` are not advertised as guaranteed one-click upgrades in this
release because they predate the validated transactional updater floor;
`1.1.14` does not contain the updater at all.
