# DevSpace Portable 1.1.62

1.1.62 is the stable release promoted from the validated 1.1.62 dev9 line.

## Default execution policy

- Automatic continuation is **disabled by default**.
- While automatic continuation is disabled, normal DevSpace work remains headless:
  no continuation anchor is created automatically and ordinary tool calls are not
  blocked on a milestone card.
- When automatic continuation is explicitly enabled, each new manual DevSpace
  work round requires exactly one fresh continuation anchor before substantive work.
- Existing continuation task/card history is preserved when the switch is turned off.

## Tool mode

- New installations default to **`codex`** tool mode instead of `full`.
- Existing installations that explicitly saved another tool mode keep their saved choice.

## Desktop UI

- The 1.1.62 desktop UI keeps the dev8 navigation simplification: duplicate settings
  destinations and duplicate homepage actions remain removed.
- Automatic-continuation copy now makes the anchor behavior of the switch explicit.

## Validation

- Full source and Portable regression suite passed before promotion.
- Continuation guard, architecture, real MCP wire contract, ATCC, resident recovery,
  milestone-card lifecycle, UI build/security, Electron navigation and close/tray tests passed.
- Stable release packaging is verified against the maintained source tree and excludes
  local credentials, runtime state, logs and developer-only output.
