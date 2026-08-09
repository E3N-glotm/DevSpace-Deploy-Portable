# DevSpace Portable 1.1.23

## Scope

1.1.23 is a native-control-center usability release. It reduces the visual
density of long session histories and makes first-run Owner Password handling
explicit without changing Portable Protocol 1.5 or the top-level MCP schema.

## Collapsible session groups

The session review page already groups rounds by normalized session title, but
prior releases rendered every child round immediately. Long-running projects
could therefore fill most of the page with dozens of rows from a few repeated
session names.

1.1.23 changes the presentation contract:

- every title group starts collapsed;
- a collapsed group shows `▶`, an expanded group shows `▼`;
- a single click on the group header toggles that group;
- `全部折叠` and `全部展开` control all groups at once;
- an active search temporarily reveals child rows from matching groups so a
  valid search result is never hidden behind the fold;
- group headers remain non-session rows and cannot enter review or rollback;
- concrete session rows retain the existing double-click review flow,
  per-file diff view, safety snapshot, and rollback behavior.

The fold state is UI-local. It does not change review metadata or write new
session state to disk.

## First-run Owner Password dialog

When DevSpace generates an Owner Password because no existing credential was
provided, the native dialog now makes the persistence location unambiguous.
It shows:

- the generated Owner Password;
- the complete path to `auth.json` where the password has already been saved;
- a `复制 Owner Password` button;
- a `复制 auth.json 路径` button.

The password is still returned to the UI only for the first generated-secret
prompt. Routine configuration reads do not expose the stored secret, and the
dialog does not change OAuth persistence behavior.

## Network compatibility

This release deliberately does not add an EasyConnect/Sangfor repair or
interception path. The 1.1.22 ownership boundary remains in force: DevSpace
manages only its own service/tunnel/update processes and does not alter
third-party VPN processes, Windows proxy settings, WinHTTP, routes, or network
adapters.

## Validation

Release acceptance requires:

- native WinForms compilation;
- session-collapse controls present in the native self-test;
- source regression checks for default folding, search reveal, and header
  isolation;
- first-run credential dialog checks for `auth.json` location and both copy
  actions;
- the complete Portable source/runtime regression suite;
- production dependency audit and normal Release ZIP/delta integrity checks.
