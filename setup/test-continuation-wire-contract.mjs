import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "../app/node_modules/@waishnav/devspace/dist/server.js";
import { loadConfig } from "../app/node_modules/@waishnav/devspace/dist/config.js";
import { SingleUserOAuthProvider } from "../app/node_modules/@waishnav/devspace/dist/oauth-provider.js";
import { Client } from "../app/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StreamableHTTPClientTransport } from "../app/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js";
import { AjvJsonSchemaValidator } from "../app/node_modules/@modelcontextprotocol/sdk/dist/esm/validation/ajv-provider.js";

// Exercise the advertised JSON Schema through the actual MCP client. Direct
// RuntimeState/FakeApp tests miss a response rejected after its side effects.
const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
for (const file of ["server.js", "runtime-state.js", "ui/assets/continuation-coordinator.js"]) {
  assert.ok(readFileSync(join(ROOT, "vendor/waishnav-devspace/dist", file)).equals(
    readFileSync(join(ROOT, "app/node_modules/@waishnav/devspace/dist", file))),
  `Install current canonical ${file} before running the wire regression`);
}
const cache = join(ROOT, ".test-cache");
mkdirSync(cache, { recursive: true });
const temp = mkdtempSync(join(cache, "continuation-wire-"));
const configDir = join(temp, "config");
const stateDir = join(temp, "state");
mkdirSync(configDir, { recursive: true });
writeFileSync(join(configDir, "config.json"), JSON.stringify({
  host: "127.0.0.1", port: 17676, publicBaseUrl: "http://127.0.0.1:17676",
  allowedRoots: [temp], stateDir, subagents: false,
  features: { continuationGuard: true },
}));
writeFileSync(join(configDir, "auth.json"), JSON.stringify({
  ownerToken: "isolated-continuation-wire-test-owner-token",
}));
process.env.DEVSPACE_PLUGIN_ROOT = join(temp, "plugins");
const config = loadConfig({ ...process.env,
  DEVSPACE_CONFIG_DIR: configDir, DEVSPACE_STATE_DIR: stateDir,
  DEVSPACE_TOOL_MODE: "codex", DEVSPACE_WIDGETS: "changes", DEVSPACE_SUBAGENTS: "0",
  DEVSPACE_LOG_REQUESTS: "0", DEVSPACE_LOG_TOOL_CALLS: "0",
});
const service = createServer(config);
const http = service.app.listen(0, "127.0.0.1");
await new Promise((done, reject) => { http.once("listening", done); http.once("error", reject); });
const provider = new SingleUserOAuthProvider(config.oauth, new URL("/mcp", config.publicBaseUrl), stateDir);
// Tokens exist only in this isolated test database and never touch live auth.
const testClient = provider.oauthStore.registerClient({
  client_name: "continuation-wire-test", redirect_uris: ["http://127.0.0.1/callback"],
}, ["127.0.0.1"]);
const credential = provider.issueTokens(testClient.client_id, config.oauth.scopes,
  new URL("/mcp", config.publicBaseUrl));
class DiagnosticSchemaValidator extends AjvJsonSchemaValidator {
  getValidator(schema) {
    const validate = super.getValidator(schema);
    return (input) => {
      const result = validate(input);
      if (!result.valid) {
        const extra = Object.keys(input ?? {}).filter((key) => !Object.hasOwn(schema.properties ?? {}, key));
        result.errorMessage += `; undeclared top-level fields: ${extra.join(", ")}`;
      }
      return result;
    };
  }
}
const client = new Client({ name: "continuation-wire-regression", version: "1" }, {
  jsonSchemaValidator: new DiagnosticSchemaValidator(),
});
const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${http.address().port}/mcp`), {
  requestInit: { headers: { Authorization: `Bearer ${credential.access_token}` } },
});
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const descriptor = tools.find((tool) => tool.name === "continuation_sender");
  assert.ok(descriptor, "sender must be advertised to the Host");
  for (const name of ["continuation_task", "continuation_anchor", "continuation_sender"]) {
    const schema = tools.find((tool) => tool.name === name).outputSchema;
    const validate = new DiagnosticSchemaValidator().getValidator(schema);
    assert.equal(validate({ result: "test", unexpectedProtocolField: true }).valid, false,
      `${name} must retain strict validation instead of hiding future contract drift`);
  }
  const runtime = service.runtimeState;
  const scope = "v1/isolated-continuation-wire-contract";
  const started = runtime.continuationTask({ action: "begin", conversationScopeId: scope,
    objective: "Validate actual sender protocol responses", requiredMilestones: ["wire contract"],
    continuationMode: "completion-driven" });
  const mount = runtime.prepareContinuationAnchorMount({ taskId: started.task.id, conversationScopeId: scope });
  async function wire(name, args, meta) {
    try {
      const result = await client.callTool({ name, arguments: args, ...(meta ? { _meta: meta } : {}) });
      assert.notEqual(result.isError, true, `${name}/${args.action ?? args.bridgeAction ?? "anchor"}`);
      return result.structuredContent;
    } catch (error) {
      console.error("wire action failed:", name, args.action ?? args.bridgeAction ?? "anchor");
      throw error;
    }
  }
  await wire("continuation_task", { action: "status", taskId: started.task.id,
    coordinatorInstanceId: "ui_wire_contract", readOnlyStatus: true });
  await wire("continuation_anchor", { taskId: started.task.id });
  const bindArgs = {
    action: "bind", taskId: started.task.id, conversationScopeId: scope,
    senderInstanceId: "ui_wire_contract", senderProtocolEpoch: runtime.continuationSenderProtocolEpoch,
    senderAssetRevision: runtime.continuationSenderAssetRevision,
    anchorMountGeneration: mount.anchorMountGeneration,
  };
  let reply;
  try {
    reply = await client.callTool({ name: "continuation_sender", arguments: bindArgs });
  } catch (error) {
    const persisted = runtime.database.sqlite.prepare(
      "select sender_lease_state from continuation_conversation_cards where conversation_scope_id=?"
    ).get(scope);
    console.error("sender state after rejected wire response:", persisted?.sender_lease_state);
    throw error;
  }
  assert.equal(reply.isError, undefined);
  const bound = reply.structuredContent;
  assert.equal(bound.accepted, true);
  for (const key of ["taskId", "conversationScopeId", "anchorMountToken", "anchorMountGeneration", "task"]) {
    assert.ok(bound[key], `bind response must preserve ${key}`);
    assert.ok(descriptor.outputSchema.properties[key], `outputSchema must declare ${key}`);
  }
  for (const action of ["heartbeat", "telemetry", "claim"]) {
    const result = await client.callTool({ name: "continuation_sender", arguments: {
      ...bindArgs, action, anchorMountToken: bound.anchorMountToken,
      ...(action === "telemetry" ? { telemetry: { parentMethods: ["ui/initialize"] } } : {}),
    } });
    assert.notEqual(result.isError, true, `${action} must survive real output validation`);
    if (action === "claim") {
      assert.equal(result.structuredContent.accepted, false);
      assert.equal(result.structuredContent.reason, "no-ready-generation");
    } else assert.equal(result.structuredContent.accepted, true);
  }
  const taskArgs = { taskId: started.task.id, coordinatorInstanceId: "ui_wire_contract",
    anchorMountToken: bound.anchorMountToken, anchorMountGeneration: bound.anchorMountGeneration };
  for (const action of ["anchor-mounted", "heartbeat", "host-signal"]) {
    await wire("continuation_task", { ...taskArgs, action,
      ...(action === "host-signal" ? { hostSignal: "connected" } : {}) });
  }
  const bridgeBind = await wire("continuation_anchor", { ...bindArgs, bridgeAction: "sender-bind" });
  assert.equal(bridgeBind.accepted, true, "cached same-source bridge must have a valid output contract");
  await wire("continuation_anchor", { ...taskArgs, bridgeAction: "task-status", readOnlyStatus: true });
  runtime.touchContinuationModelActivity({ conversationScopeId: scope, substantive: true });
  const completedTurn = await wire("continuation_task", { action: "turn-complete", taskId: started.task.id });
  assert.equal(completedTurn.accepted, true);
  runtime.continuationSupervisorSweep();
  const senderArgs = { ...bindArgs, anchorMountToken: bound.anchorMountToken };
  const ready = await wire("continuation_task", { ...taskArgs, action: "status", readOnlyStatus: true });
  assert.ok(ready.readyGeneration, "pre-armed READY must cross the actual status schema");
  const claim = await wire("continuation_sender", { ...senderArgs, action: "claim" });
  assert.equal(claim.accepted, true);
  const deliveryArgs = { ...senderArgs, deliveryToken: claim.deliveryToken };
  const authorization = await wire("continuation_sender", { ...deliveryArgs, action: "authorize-delivery" });
  assert.equal(authorization.accepted, true);
  const uncertain = await wire("continuation_sender", { ...deliveryArgs, action: "delivery-result",
    result: "unknown", method: "isolated-wire-test" });
  assert.equal(uncertain.outcomeUncertain, true);
  const delivered = await wire("continuation_sender", { ...deliveryArgs, action: "delivery-result",
    result: "accepted", method: "isolated-wire-test" });
  assert.equal(delivered.accepted, true);
  const ack = await wire("continuation_task", { action: "status", taskId: started.task.id,
    deliveryToken: claim.deliveryToken });
  assert.equal(ack.accepted, true);
  const modelMeta = { "openai/session": scope };
  const workspace = await wire("open_workspace", { path: temp }, modelMeta);
  assert.ok(workspace.workspaceId);
  const read = await wire("read", { workspaceId: workspace.workspaceId, path: "config/config.json" }, modelMeta);
  assert.ok(read.result.includes("allowedRoots"));
  let processResult = await wire("exec_command", { workspaceId: workspace.workspaceId,
    argv: [process.execPath, "-e", "console.log('continuation-wire-ok')"], yieldTimeMs: 1000 }, modelMeta);
  let processOutput = processResult.result;
  while (processResult.running) {
    processResult = await wire("write_stdin", { workspaceId: workspace.workspaceId,
      processHandle: processResult.processHandle, yieldTimeMs: 1000 }, modelMeta);
    processOutput += processResult.result;
  }
  assert.equal(processResult.exitCode, 0);
  assert.ok(processOutput.includes("continuation-wire-ok"));
  await wire("apply_patch", { workspaceId: workspace.workspaceId,
    patch: "*** Begin Patch\n*** Add File: wire-result.txt\n+verified synthetic work\n*** End Patch" }, modelMeta);
  const written = await wire("read", { workspaceId: workspace.workspaceId, path: "wire-result.txt" }, modelMeta);
  assert.ok(written.result.includes("verified synthetic work"));
  await wire("continuation_task", { action: "checkpoint", taskId: started.task.id,
    completedMilestones: ["wire contract"] });
  await wire("continuation_task", { action: "complete", taskId: started.task.id });
  // Exercise actual wire replies on alternate paths too. Fixtures and Host
  // delivery receipts below are isolated simulations, never live ChatGPT ACKs.
  for (const scenario of ["timeout", "manual-takeover", "rejected", "failed", "fallback-accepted"]) {
    const scenarioScope = `${scope}/${scenario}`;
    const scenarioTask = runtime.continuationTask({ action: "begin", conversationScopeId: scenarioScope,
      objective: `Validate ${scenario} wire responses`, requiredMilestones: [scenario],
      continuationMode: "completion-driven" }).task;
    const anchor = await wire("continuation_anchor", { taskId: scenarioTask.id });
    const binding = { ...bindArgs, taskId: scenarioTask.id, conversationScopeId: scenarioScope,
      senderInstanceId: `ui_wire_${scenario}`, anchorMountGeneration: anchor.anchorMountGeneration };
    const capability = await wire("continuation_anchor", { ...binding, bridgeAction: "sender-bind" });
    assert.equal(capability.accepted, true);
    const sender = { ...binding, anchorMountToken: capability.anchorMountToken };
    const coordinator = { taskId: scenarioTask.id, coordinatorInstanceId: binding.senderInstanceId,
      anchorMountToken: capability.anchorMountToken, anchorMountGeneration: capability.anchorMountGeneration };
    for (const bridgeAction of ["task-anchor-mounted", "task-heartbeat", "task-host-signal"]) {
      assert.equal((await wire("continuation_anchor", { ...coordinator, bridgeAction,
        ...(bridgeAction === "task-host-signal" ? { hostSignal: "connected" } : {}) })).accepted, true);
    }
    for (const bridgeAction of ["sender-heartbeat", "sender-telemetry"]) {
      assert.equal((await wire("continuation_anchor", { ...sender, bridgeAction })).accepted, true);
    }
    const staleTimeout = await wire("continuation_sender", { ...sender, action: "host-timeout",
      turnLeaseId: "turn_stale_wire_test", hostProfileId: "chatgpt@wire-test", elapsedMs: 1000 });
    assert.equal(staleTimeout.accepted, false);
    assert.equal(staleTimeout.reason, "stale-sender-turn-lease");
    runtime.touchContinuationModelActivity({ conversationScopeId: scenarioScope, substantive: true });
    if (scenario === "timeout") {
      const current = await wire("continuation_task", { ...coordinator, action: "status", readOnlyStatus: true });
      const timedOut = await wire("continuation_anchor", { ...sender, bridgeAction: "sender-host-timeout",
        turnLeaseId: current.task.turnLeaseId, hostProfileId: "chatgpt@wire-test",
        elapsedMs: 1000, note: "explicit isolated Host timeout fixture" });
      assert.equal(timedOut.accepted, true);
    } else {
      assert.equal((await wire("continuation_task", { taskId: scenarioTask.id, action: "turn-complete" })).accepted, true);
    }
    runtime.continuationSupervisorSweep();
    const bridgeReady = await wire("continuation_anchor", { ...coordinator, bridgeAction: "task-status" });
    assert.ok(bridgeReady.readyGeneration, `${scenario} must produce READY immediately after the verified turn end`);
    const acquired = await wire("continuation_anchor", { ...sender, bridgeAction: "sender-claim" });
    assert.equal(acquired.accepted, true);
    const retry = await wire("continuation_sender", { ...sender, action: "claim" });
    assert.equal(retry.accepted, false);
    assert.equal(retry.reason, "delivery-in-flight-no-retransmit");
    const delivery = { ...sender, deliveryToken: acquired.deliveryToken };
    assert.equal((await wire("continuation_anchor", { ...delivery, bridgeAction: "sender-authorize-delivery" })).accepted, true);
    if (scenario === "manual-takeover") {
      const manual = await wire("continuation_task", { taskId: scenarioTask.id, action: "status", manualTakeover: true });
      assert.equal(manual.manualRoundCardRequired, true);
      assert.equal((await wire("continuation_sender", { ...delivery, action: "authorize-delivery" })).accepted, false);
      assert.equal((await wire("continuation_sender", { ...delivery, action: "delivery-result", result: "accepted" })).accepted, false);
      assert.equal((await wire("continuation_sender", { ...sender, action: "heartbeat" })).accepted, false);
    } else {
      const result = scenario === "timeout" ? "accepted" : scenario;
      const receipt = await wire("continuation_anchor", { ...delivery, bridgeAction: "sender-delivery-result",
        result, method: "isolated-wire-test" });
      assert.equal(receipt.accepted, true);
      if (result === "rejected" || result === "failed") assert.equal(receipt.retryRequired, true);
      else {
        const resumed = await wire("continuation_task", { taskId: scenarioTask.id, action: "status", deliveryToken: acquired.deliveryToken });
        assert.equal(resumed.accepted, true);
        const emptyFinal = await wire("continuation_task", { taskId: scenarioTask.id, action: "turn-complete" });
        assert.equal(emptyFinal.accepted, false);
        assert.equal(emptyFinal.minimumSubstantiveWorkDelta, 4);
      }
    }
    await wire("continuation_task", { taskId: scenarioTask.id, action: "cancel" });
  }
  console.log("PASS: strict schema, cached bridge, timeout, manual fencing, rejection, retry and synthetic work floor");
  console.log("PASS: real MCP anchor/status/bind/heartbeat/READY/claim/authorize/receipt/ACK/completion contracts");
} finally {
  await client.close().catch(() => undefined);
  http.closeAllConnections();
  await new Promise((done) => http.close(done));
  await service.close();
  provider.close();
  rmSync(temp, { recursive: true, force: true });
}
