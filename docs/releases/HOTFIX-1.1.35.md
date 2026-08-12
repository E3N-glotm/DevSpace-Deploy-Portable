# DevSpace Portable 1.1.35

## Scope

1.1.35 makes DevSpace's MCP OAuth layer vendor-neutral. ChatGPT's existing Dynamic Client Registration path remains supported, while Gemini, Claude, IDEs and other MCP clients can either register dynamically or use a manually provisioned confidential OAuth client when they require an explicit Client ID and Client Secret. Portable Protocol remains 1.5 and the top-level MCP tool schema is unchanged.

## Vendor-neutral Dynamic Client Registration

Earlier Portable builds accepted dynamic OAuth redirect hosts from a small default list centered on ChatGPT and localhost. A standards-compliant client using a different HTTPS callback could therefore reach DevSpace's `/register` endpoint but be rejected even though the rest of the OAuth flow was compatible.

1.1.35 removes the vendor hostname dependency. Redirect registration now accepts:

- arbitrary HTTPS callbacks;
- `localhost`, `127.0.0.1` and `[::1]` HTTP/HTTPS loopback callbacks;
- reverse-domain private URI schemes used by native applications.

Remote plain HTTP callbacks, redirect URIs containing embedded credentials or fragments, and unsafe generic schemes remain rejected.

The authorization endpoint still requires the requested redirect URI to match a registered redirect. Opening registration to other vendors therefore does not turn the redirect target into a free-form authorization parameter.

## Redirect review on Owner approval

The Owner Password authorization page now displays the exact Redirect URI alongside Client, Scope and Resource. This is an explicit consent boundary: before entering the Owner Password, the user can verify which client is requesting access and where the authorization response will be sent.

## Manual confidential OAuth clients

The native control center adds **AI / MCP OAuth 客户端** under **配置与权限**. It is intended for clients that do not perform Dynamic Client Registration or that explicitly ask the user for OAuth credentials.

The manager can:

- create a named confidential OAuth client from one or more Redirect URIs;
- generate a random Client ID and 256-bit random Client Secret;
- list existing manual and DCR clients without exposing stored secrets;
- rotate the Secret for manually managed clients;
- delete a client;
- revoke existing Access/Refresh Tokens when a Secret is rotated or a client is deleted.

The Client Secret is returned to the native UI only immediately after create/rotate. The normal list operation exposes only `secretPresent=true/false`, never the secret value.

OAuth client records stay in the existing `data/state/devspace.sqlite` state database. They are user runtime state and remain excluded from Git and release ZIP seed data, so Portable updates preserve them rather than replacing them.

## Compatibility workflow

For a DCR-capable client, the normal workflow remains only the MCP URL:

```text
https://your-domain.example/mcp
```

For a client that requests credentials:

1. copy the Redirect URI shown by that client;
2. open **配置与权限 → AI / MCP OAuth 客户端**;
3. create a client using that exact Redirect URI;
4. copy Client ID and Client Secret into the target client;
5. continue OAuth and verify the Redirect URI on the DevSpace Owner approval page.

No AI vendor name is required in configuration; interoperability is based on the MCP/OAuth behavior the client implements.

## Regression coverage

- arbitrary HTTPS DCR callback accepted even when the hostname is not in the historical ChatGPT allowlist;
- loopback HTTP callback accepted;
- reverse-domain private URI scheme accepted;
- remote plain HTTP and fragment-bearing callbacks rejected;
- manual confidential client creation returns a Secret once while list output remains redacted;
- Secret rotation produces a new Secret and revokes old Access/Refresh Tokens;
- client deletion removes the client and its tokens;
- native Windows control center builds with the OAuth client management dialog.

## Compatibility

- Portable version: 1.1.35;
- DevSpace server capability version: 1.1.35;
- Portable Protocol: 1.5;
- top-level MCP tool schema: unchanged;
- existing ChatGPT DCR clients: preserved;
- OAuth reset: not required;
- tool rescan: not required solely for this release.
