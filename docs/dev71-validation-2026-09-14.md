# DevSpace 1.1.59 dev71

## Incident and scope

The supplied dev70 incident records generation 7 ACK at 03:23:03.736Z,
with substantive activity remaining at 365 (post-ACK delta zero).
The durable 40-minute monitor completed, but synthetic work acceptance failed.
Large discovery and ACK payloads are a plausible contributor, not proof of the
Host's internal reason for emitting an empty final.

## Changes

- Keep shared card/ownership rules while removing the exact task-control tool
  name from ordinary advertised descriptions, including open_workspace.
- Project successful model ACK replies into a compact work ticket at the MCP
  transport boundary. Keep full runtime state and evidence server-side.
- Preserve manual, read-only, coordinator and rejection responses unchanged.
- Reuse existing top-level output fields; place ticket identity/action inside
  the already-extensible task field so cached pre-dev71 schemas accept it.
- Keep all existing timeout, manual ownership and no-silence-retry guards.

## Verification

Final packed-core parity and seven regression groups passed (all exit 0):
continuation guard, ATCC, architecture, actual MCP wire, runtime cards,
release migration, and blockmap update. Final timings and full test output
are retained in reports/dev71/final-regressions.json and sibling logs.

The wire test verifies exact-name discovery finds only continuation_task;
large historical evidence stays server-side while the complete ACK structured
response stays below 5 KB; both token and compatible tokenless ACKs work;
ordinary diagnostics retain the history; cached output fields are respected;
and post-ACK read/exec/edit operations still execute through strict MCP schema
validation. These are isolated protocol tests, not real ChatGPT continuations.

Native UI build passed. Core package SHA-256:
82d86850108ad1d089218db9408ef8dab29924c86ebc852bd602c73f9dc24af4.

Pending: D-live deployment and real Host synthetic acceptance. Deployment
verification is recorded separately under reports/dev71 so the finalized
manifest can keep this source report immutable through the live copy.
All source changes are confined to E:\program\Python\DevSpaceDeploy.
No GitHub Release is authorized by this development iteration.
