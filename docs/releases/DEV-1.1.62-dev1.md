# DevSpace Portable 1.1.62 dev1 — interactive card foundation

Development build only. Keep the public stable Release and updater routes on
v1.1.61 until a separate release acceptance has completed. Do not deploy to
an active D-live service just to test the card UI; develop in the original
`E:\program\Python\DevSpaceDeploy` checkout.

## User-visible behavior

- Runtime and continuation cards offer an explicit **View fullscreen** action.
  The action is issued only after a user click via the optional ChatGPT
  `requestDisplayMode({ mode: "fullscreen" })` bridge. Unsupported or rejected
  requests keep the inline card usable without changing task ownership.
- Card disclosure preferences persist through the optional
  `window.openai.widgetState` / `setWidgetState` bridge and fall back to
  iframe sessionStorage on hosts without it. State is versioned, bounded and
  scoped by immutable card generation; host-visible keys are short hashes,
  never original command lines or task content. Other widget state is retained.
- Continuation cards display an accessible milestone progress bar based only
  on completed and required milestones. The UI cannot mark milestones
  complete, authorize a sender, or trigger a synthetic turn merely by rendering.
- A separate CSS resource is embedded inside the existing self-contained
  revisioned MCP Apps document. The primary Workspace App URI, single
  continuation-anchor card, sender protocol epoch, Host send/ACK contract,
  data and permission boundaries are unchanged.

## Deliberately deferred

- The optional `requestModal` API needs a separate, read-only registered
  template. Reusing the continuation-anchor template in a modal could mount
  a second coordinator, so dev1 does not expose a modal button.
- Host file upload/select/download APIs are not connected to workspace
  writes without an explicit authenticated server-side file-import contract.
- `@openai/apps-sdk-ui` is not installed as a new dependency; native CSS
  variables preserve existing MCP Host compatibility.

## Acceptance

Run `node setup/test-card-host-interactions.mjs`,
`node setup/test-runtime-cards.mjs`, the continuation guards, and the
full `scripts/test-source.ps1` source gate. A passing VM/mock Host test
is **not** proof of live ChatGPT fullscreen rendering: record live iframe
mount, state rehydration and Host mode-change tests before any D-live upgrade.
