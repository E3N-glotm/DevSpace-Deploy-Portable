# DevSpace Portable 1.1.66 dev1

Development preview on the existing E-drive source checkout. Not a stable
release and does not replace an installed production Portable instance.

## Changes

- Remote Agent restricted access: explicit multi-directory Linux allowlist,
  independently editable from the Agent installation directory. The same
  edited roots flow to one-click SSH deployment and manual enrollment.
  Incorrect or empty scoped directory entries block submission, and an
  authorized-root change now triggers redeployment.
- Explicit Memories: select an exact Windows workspace subdirectory using
  a directory picker or text input, not only the fixed drive roots. The
  Portable manager checks directory existence, physical path containment,
  and symlink/junction traversal against the configured allowed roots.
- First-run deployment: prevent a premature Electron timeout during the
  manager's three supported local-service startup attempts. Distinguish
  timeouts from other errors and preserve saved initial settings on retry.
  Report that the public endpoint may still be pending Cloudflare route
  synchronization even after local MCP successfully starts.

## Evidence and limitations

- In the supplied user logs, two starts at 17:10:26 and 17:11:47 did not
  reach a logged listening state; the third start at 17:13:17 succeeded.
  The first two exit reasons are not recorded, so a definite crash cause
  cannot be asserted.
- Cloudflare initially reported no ingress configuration at 17:13:52;
  routing arrived at 17:16:53. Later DNS resolver timeouts and canceled
  streams are network conditions, not proof of a credential failure.
- Validation is based on source-level tests and isolated development
  workflows. Do not infer production-machine remediation from this preview.
