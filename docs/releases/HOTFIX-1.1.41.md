# DevSpace Portable 1.1.41

## Scope

1.1.41 is the stable Remote Workspace Agent SSH-rescue hotfix. It fixes the Windows-to-Linux shell transport used by **Test SSH**, **One-click recover / install Agent**, and background SSH recovery. Portable Protocol remains 1.5 and the MCP tool schema is unchanged from 1.1.40.

Because 1.1.32-1.1.39 clients predate the multi-Release incremental planner and require one exact `fromVersion -> latest` edge, the 1.1.41 Release preserves direct incremental compatibility for all of those installed versions. In addition, it publishes the normal `1.1.40 -> 1.1.41` adjacent delta and carries forward the validated historical incremental graph from 1.1.40. Therefore 1.1.32-1.1.39 users can still update directly to the latest stable Release without downloading the full Portable ZIP, while 1.1.40+ clients retain the long-term transactional chain model.

## SSH rescue CRLF fix

The 1.1.40 native control center stores its C# source with Windows CRLF line endings. `ExistingAgentRecoveryScript()` is a verbatim multi-line C# string, so the compiled string also contains CRLF. The SSH path previously wrote that string directly to the stdin of:

`ssh ... bash -s`

On Linux, Bash therefore received tokens such as `set -eu\r` and `do\r`. Depending on the first affected token this produced errors including `set: invalid option` and `syntax error near unexpected token '$'do\r''`, preventing the existing Agent from being recovered even though SSH authentication itself succeeded.

1.1.41 normalizes every shell script at the SSH transport boundary:

- CRLF becomes LF;
- any remaining lone CR becomes LF;
- the script is guaranteed to end with LF;
- the redirected stdin writer also uses LF as its newline convention.

The normalization is applied centrally in `RunSshScriptWithProfileAsync`, so explicit SSH testing, existing-Agent recovery, automatic background recovery, and enrollment/install fallback all use the same Linux-safe transport. The actual recovery commands and privilege behavior are unchanged.

## Security and compatibility

- Saved SSH passwords remain protected with Windows DPAPI CurrentUser scope.
- Passwords are still passed only through the child-process environment and `DevSpace-SshAskPass.exe`, not through SSH arguments or remote shell text.
- Existing Agent identity is still recovered before a new enrollment is created.
- systemd user service, passwordless system service restart, and ordinary-user `nohup` fallback remain unchanged.
- The manual installer command remains available as the final fallback.
- Portable Protocol: 1.5.
- MCP schema: unchanged from 1.1.40; no tool rescan is required solely for this hotfix.

## Regression coverage

The native self-test now sends a synthetic shell string containing CRLF and a lone CR through the same normalization helper and fails unless the result contains LF only and ends in LF. The SSH rescue contract also requires the transport normalization call and forbids the previous implicit Windows `WriteLine()` fallback.

The Release contract additionally requires 1.1.41 to publish exact deltas from 1.1.32 through 1.1.39, the adjacent 1.1.40-to-1.1.41 delta, the 1.1.33 Rescue fallback, and a carry-forward incremental graph manifest.
