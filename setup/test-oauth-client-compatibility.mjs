import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const node = join(root, "runtime", "node", "node.exe");
const managerFile = join(root, "setup", "portable-manager.cjs");
const oauthStoreFile = join(root, "app", "node_modules", "@waishnav", "devspace", "dist", "oauth-store.js");
const databaseClientFile = join(root, "app", "node_modules", "@waishnav", "devspace", "dist", "db", "client.js");
const temporary = await mkdtemp(join(tmpdir(), "devspace-oauth-clients-"));
const stateDir = join(temporary, "state");
const configDir = join(temporary, "config");
const runDir = join(temporary, "run");
const env = {
  ...process.env,
  DEVSPACE_PORTABLE_STATE_DIR: stateDir,
  DEVSPACE_PORTABLE_CONFIG_DIR: configDir,
  DEVSPACE_PORTABLE_RUN_DIR: runDir,
};

function manager(command, payload = {}, expectSuccess = true) {
  const result = spawnSync(node, [managerFile, command, "--ascii-json"], {
    cwd: root,
    env,
    input: JSON.stringify(payload),
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
  });
  if (expectSuccess && result.status !== 0) {
    throw new Error(result.stderr || `${command} exited with ${result.status}`);
  }
  if (!expectSuccess) return result;
  return result.stdout.trim() ? JSON.parse(result.stdout.trim()) : {};
}

try {
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  mkdirSync(runDir, { recursive: true });

  const { SqliteOAuthStore } = await import(`${pathToFileURL(oauthStoreFile).href}?test=${Date.now()}`);
  const dcrStore = new SqliteOAuthStore(stateDir);
  try {
    const gemini = dcrStore.registerClient({
      client_name: "Gemini custom app",
      redirect_uris: ["https://gemini.google.com/mcp/oauth/callback"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }, ["chatgpt.com", "localhost", "127.0.0.1"]);
    assert.match(gemini.client_id, /^devspace-/);
    assert.deepEqual(gemini.redirect_uris, ["https://gemini.google.com/mcp/oauth/callback"]);

    const loopback = dcrStore.registerClient({
      client_name: "Native loopback MCP client",
      redirect_uris: ["http://127.0.0.1:54321/oauth/callback"],
      token_endpoint_auth_method: "none",
    }, []);
    assert.match(loopback.client_id, /^devspace-/);

    const nativeScheme = dcrStore.registerClient({
      client_name: "Native custom-scheme MCP client",
      redirect_uris: ["com.example.ai:/oauth/callback"],
      token_endpoint_auth_method: "none",
    }, []);
    assert.match(nativeScheme.client_id, /^devspace-/);

    assert.throws(() => dcrStore.registerClient({
      client_name: "Unsafe remote client",
      redirect_uris: ["http://example.com/oauth/callback"],
      token_endpoint_auth_method: "none",
    }, ["example.com"]), /redirect_uri is not allowed/i);

    assert.throws(() => dcrStore.registerClient({
      client_name: "Fragment callback client",
      redirect_uris: ["https://example.com/oauth/callback#fragment"],
      token_endpoint_auth_method: "none",
    }, []), /redirect_uri is not allowed/i);
  } finally {
    dcrStore.close();
  }

  const created = manager("oauth-client-create", {
    clientName: "Gemini manual fallback",
    redirectUris: ["https://gemini.google.com/mcp/oauth/callback"],
  });
  assert.equal(created.secretShownOnce, true);
  assert.match(created.client.clientId, /^devspace-manual-/);
  assert.equal(created.client.manual, true);
  assert.equal(created.client.tokenEndpointAuthMethod, "client_secret_post");
  assert.equal(created.client.secretPresent, true);
  assert.equal(typeof created.clientSecret, "string");
  assert.ok(created.clientSecret.length >= 40);

  const listed = manager("oauth-client-list").clients;
  const manual = listed.find((client) => client.clientId === created.client.clientId);
  assert.ok(manual);
  assert.equal(manual.secretPresent, true);
  assert.equal(Object.prototype.hasOwnProperty.call(manual, "clientSecret"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(manual, "client_secret"), false);
  assert.equal(JSON.stringify(listed).includes(created.clientSecret), false);

  const unsafeCreate = manager("oauth-client-create", {
    clientName: "Unsafe manual fallback",
    redirectUris: ["http://remote.example/oauth/callback"],
  }, false);
  assert.notEqual(unsafeCreate.status, 0);
  assert.match(unsafeCreate.stderr, /must use HTTPS/i);

  const loopbackCreated = manager("oauth-client-create", {
    clientName: "Local IDE",
    redirectUris: ["http://localhost:49152/oauth/callback"],
  });
  assert.match(loopbackCreated.client.clientId, /^devspace-manual-/);

  const nativeSchemeCreated = manager("oauth-client-create", {
    clientName: "Native custom-scheme AI",
    redirectUris: ["com.example.ai:/oauth/callback"],
  });
  assert.match(nativeSchemeCreated.client.clientId, /^devspace-manual-/);

  const databaseModule = await import(`${pathToFileURL(databaseClientFile).href}?test=${Date.now()}`);
  const database = databaseModule.openDatabase(stateDir);
  try {
    database.sqlite.prepare(`insert into oauth_access_tokens (token_hash, client_id, scopes_json, expires_at, resource)
      values (?, ?, ?, ?, ?)`)
      .run("test-access-token-hash", created.client.clientId, JSON.stringify(["devspace"]), Math.floor(Date.now() / 1000) + 3600, null);
    database.sqlite.prepare(`insert into oauth_refresh_tokens (token_hash, client_id, scopes_json, expires_at, resource)
      values (?, ?, ?, ?, ?)`)
      .run("test-refresh-token-hash", created.client.clientId, JSON.stringify(["devspace"]), Math.floor(Date.now() / 1000) + 7200, null);
  } finally {
    database.close();
  }

  const rotated = manager("oauth-client-rotate-secret", { clientId: created.client.clientId });
  assert.equal(rotated.tokensRevoked, true);
  assert.notEqual(rotated.clientSecret, created.clientSecret);
  assert.equal(rotated.secretShownOnce, true);

  const databaseAfterRotate = databaseModule.openDatabase(stateDir);
  try {
    assert.equal(databaseAfterRotate.sqlite.prepare("select count(*) as count from oauth_access_tokens where client_id = ?").get(created.client.clientId).count, 0);
    assert.equal(databaseAfterRotate.sqlite.prepare("select count(*) as count from oauth_refresh_tokens where client_id = ?").get(created.client.clientId).count, 0);
  } finally {
    databaseAfterRotate.close();
  }

  const dcrClient = manager("oauth-client-list").clients.find((client) => !client.manual);
  assert.ok(dcrClient);
  const rotateDcr = manager("oauth-client-rotate-secret", { clientId: dcrClient.clientId }, false);
  assert.notEqual(rotateDcr.status, 0);
  assert.match(rotateDcr.stderr, /Only manually managed OAuth clients/i);

  const deleted = manager("oauth-client-delete", { clientId: created.client.clientId });
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.tokensRevoked, true);
  assert.equal(manager("oauth-client-list").clients.some((client) => client.clientId === created.client.clientId), false);

  console.log(JSON.stringify({
    vendorNeutralHttpsDcr: true,
    loopbackHttpDcr: true,
    privateUriSchemeDcr: true,
    remoteHttpRejected: true,
    manualConfidentialClient: true,
    secretRedactedFromList: true,
    rotateRevokesTokens: true,
    deleteRevokesTokens: true,
  }));
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
