# DevSpace Portable 1.1.62 dev9

dev9 changes the default execution posture requested for the current 1.1.62 development line.

## Defaults

- Automatic continuation is now **off by default**. A missing, malformed, or unreadable
  `auto-continuation.json` fails closed to disabled.
- The default MCP tool mode is now **`codex`** instead of `full`. Existing installations
  that explicitly saved `full` keep that choice.

## Continuation anchor policy

- With automatic continuation **off**, manual DevSpace work remains headless: status does not
  report a required milestone card, ordinary tool calls are not blocked on an anchor, and
  automatic anchor preparation is rejected.
- With automatic continuation **on**, the existing strict behavior remains: each new manual
  DevSpace work round requires exactly one fresh continuation anchor before substantive work.
- Turning the switch off does not delete historical task/card records; it prevents new automatic
  anchor issuance and synthetic continuation authorization.

## UI

- Native and React control-center defaults match the new policy.
- The automatic-continuation toggle text now explains that disabled mode creates no automatic
  continuation anchor and enabled mode enforces one.
- Version identity is updated to `1.1.62 dev9`.

## Validation

dev9 adds focused default-policy coverage in `setup/test-dev9-defaults.mjs` and expands
`setup/test-auto-continuation-toggle.mjs` to verify both headless-off and forced-anchor-on
behavior.
