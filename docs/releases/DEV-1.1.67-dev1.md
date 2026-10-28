# DevSpace Portable 1.1.67 dev1

Development-only release for SSH credential rotation and safe Remote Agent
recovery. Built from the original E-drive checkout; not a stable GitHub
release and not deployed to the currently installed D-drive instance.

## SSH password rotation and recovery

- Saving SSH credentials for an **offline** existing Agent now first verifies
  the stored credentials and then recovers the same enrolled Agent ID. Online
  Agents are not restarted just because their SSH password changed.
- Explicit SSH recovery also verifies the credentials before touching remote
  processes. Recovery carries the current scoped writable roots rather than
  accidentally reusing an obsolete list.
- A stored SSH password and a successfully recovered Agent are reported as
  **separate outcomes**. A password-save success is never advertised as an
  Agent connection success.
- Revoked Agent identities cannot be restored by restarting SSH/Agent (this is
  enforced by the existing enrollment store). Saving a password does not
  reactivate a revoked identity. The UI offers a separate explicit-confirmation
  new-enrollment action that allocates a new Agent ID and preserves the revoked
  old identity and historical record.
- SSH errors are reduced to allowlisted, secret-free reason codes before
  crossing the Electron IPC boundary: host-key mismatch, authentication
  rejection, network timeout/refusal, state not found, Agent endpoint
  unavailable, or missing controller heartbeat.

## SSH host identity changes

- A read-only check on the user's current 55301 endpoint returned
  `REMOTE HOST IDENTIFICATION HAS CHANGED`. SSH key changes cannot be fixed
  merely by saving a different login password.
- The UI can retrieve the endpoint's current SHA-256 fingerprints and review
  its previously trusted fingerprints. An **explicit confirmation** is required
  before replacing only that endpoint's trusted host key. The key is re-scanned
  at approval time to reject changes between preview and approval.
- Portable now maintains its own SSH known_hosts trust file. On first use it
  copies the existing user's known_hosts as the trust baseline, without
  modifying that original file. It does not disable host verification or
  automatically accept changes to previously trusted host identities.
- After confirmation, the UI verifies the saved SSH password and retries
  the selected enrollment/recovery action. Failure remains visible if the
  password is wrong or the Agent/controller still cannot communicate.

## Scope of verification

- Automated checks cover host-key mismatch, approval, replacement, stale
  preview rejection, preservation of unrelated host trust, no user-file
  mutation, SSH error classifications, and password-update/recovery workflow.
- Source-level integration tests do not guarantee reconnection to a particular
  live server if the user has not independently verified the new host key or
  the new login password.
