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
import { CreateMessageRequestSchema } from "../app/node_modules/@modelcontextprotocol/sdk/dist/esm/types.js";

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
let samplingClient;
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.filter((tool) => `${tool.name} ${tool.description}`.includes("continuation_task"))
    .map((tool) => tool.name), ["continuation_task"],
  "exact task-control discovery must not load unrelated tool schemas");
  const descriptor = tools.find((tool) => tool.name === "continuation_sender");
  assert.ok(descriptor, "sender must be advertised to the Host");
  for (const name of ["continuation_task", "continuation_anchor", "continuation_sender"]) {
    const schema = tools.find((tool) => tool.name === name).outputSchema;
    const validate = new DiagnosticSchemaValidator().getValidator(schema);
    assert.equal(validate({ result: "test", unexpectedProtocolField: true }).valid, false,
      `${name} must retain strict validation instead of hiding future contract drift`);
  }
  const runtime = service.runtimeState;
  const capabilityEventRow = runtime.database.sqlite.prepare(
    "select payload_json from event_journal where kind='mcp.client.capabilities' order by sequence desc limit 1"
  ).get();
  assert.ok(capabilityEventRow?.payload_json, "MCP initialize must persist the real client capability snapshot");
  const capabilityEvent = JSON.parse(capabilityEventRow.payload_json);
  assert.equal(capabilityEvent.clientVersion?.name, "continuation-wire-regression");
  assert.ok(capabilityEvent.protocolVersion, "MCP capability telemetry must record the requested/negotiated protocol version");
  assert.equal(capabilityEvent.samplingSupported, false,
    "the plain regression client does not advertise sampling and must remain fail-closed for server-owned model requests");
  assert.equal(capabilityEvent.samplingToolsSupported, false);

  samplingClient = new Client({ name: "continuation-wire-sampling-regression", version: "1" }, {
    capabilities: { sampling: {} },
    jsonSchemaValidator: new DiagnosticSchemaValidator(),
  });
  samplingClient.setRequestHandler(CreateMessageRequestSchema, async () => ({
    model: "mock-sampling-model",
    role: "assistant",
    content: { type: "text", text: "sampling fixture response" },
  }));
  const samplingTransport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${http.address().port}/mcp`),
    { requestInit: { headers: { Authorization: `Bearer ${credential.access_token}` } } },
  );
  await samplingClient.connect(samplingTransport);
  const samplingCapabilityEventRow = runtime.database.sqlite.prepare(
    "select payload_json from event_journal where kind='mcp.client.capabilities' order by sequence desc limit 1"
  ).get();
  const samplingCapabilityEvent = JSON.parse(samplingCapabilityEventRow.payload_json);
  assert.equal(samplingCapabilityEvent.clientVersion?.name, "continuation-wire-sampling-regression");
  assert.equal(samplingCapabilityEvent.samplingSupported, true,
    "a client that explicitly advertises sampling must be discoverable for a future server-owned dispatcher");
  assert.equal(samplingCapabilityEvent.samplingToolsSupported, false,
    "plain sampling support must not be confused with the stronger sampling.tools capability");
  const scope = "v1/isolated-continuation-wire-contract";
  const started = runtime.continuationTask({ action: "begin", conversationScopeId: scope,
    objective: "Validate actual sender protocol responses", requiredMilestones: ["wire contract"],
    continuationMode: "completion-driven" });
  const mount = runtime.prepareContinuationAnchorMount({ taskId: started.task.id, conversationScopeId: scope });
  let lastWireReply;
  async function wire(name, args, meta) {
    try {
      const result = await client.callTool({ name, arguments: args, ...(meta ? { _meta: meta } : {}) });
      assert.notEqual(result.isError, true, `${name}/${args.action ?? args.bridgeAction ?? "anchor"}`);
      lastWireReply = result;
      return result.structuredContent;
    } catch (error) {
      console.error("wire action failed:", name, args.action ?? args.bridgeAction ?? "anchor");
      throw error;
    }
  }
  await wire("continuation_task", { action: "status", taskId: started.task.id,
    coordinatorInstanceId: "ui_wire_contract", readOnlyStatus: true });
  await wire("continuation_anchor", { taskId: started.task.id });
  for (const epoch of [11, runtime.continuationSenderProtocolEpoch + 1]) {
    for (const name of ["continuation_sender", "continuation_anchor"]) {
      const staleEpochReply = await wire(name, {
        ...(name === "continuation_sender" ? { action: "bind" } : { bridgeAction: "sender-bind" }),
        taskId: started.task.id, conversationScopeId: scope,
        senderInstanceId: "ui_wire_contract_stale_epoch", senderProtocolEpoch: epoch,
        // A valid revision is essential: malformed input only tests JSON Schema.
        senderAssetRevision: "c71b36ee04631e0a",
        anchorMountGeneration: mount.anchorMountGeneration,
      });
      assert.equal(staleEpochReply.accepted, false);
      assert.equal(staleEpochReply.reason, "sender-protocol-epoch-mismatch");
      assert.equal(staleEpochReply.expectedSenderProtocolEpoch, 13);
    }
  }
  const staleEpochCard = runtime.database.sqlite.prepare(
    "select sender_instance_id,sender_lease_state from continuation_conversation_cards where conversation_scope_id=?"
  ).get(scope);
  assert.notEqual(staleEpochCard?.sender_instance_id, "ui_wire_contract_stale_epoch",
    "a behaviourally incompatible cached sender must never regain transport authority");
  assert.notEqual(staleEpochCard?.sender_lease_state, "ACTIVE",
    "a rejected stale epoch must not leave the old sender lease active");
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
  assert.equal(runtime.database.sqlite.prepare(
    "select sender_lease_state from continuation_conversation_cards where conversation_scope_id=?"
  ).get(scope)?.sender_lease_state, "ACTIVE",
  "a current-epoch App surface must replace the upgrade-required stale sender lease");
  // Reproduce the exact cached epoch/revision shape observed on D-live. The
  // Host may cache the registered outputTemplate and referenced App body
  // across a Portable hot update. Same-protocol revision drift must now fail
  // closed: executable continuation semantics changed even though the wire ABI
  // did not, so stale JavaScript must not regain sender authority.
  bindArgs.senderProtocolEpoch = 12;
  bindArgs.senderAssetRevision = "c71b36ee04631e0a";
  const cachedBound = await wire("continuation_sender", bindArgs);
  assert.equal(cachedBound.accepted, false, JSON.stringify(cachedBound));
  assert.equal(cachedBound.reason, "sender-asset-revision-mismatch");
  const normalizedCard = runtime.database.sqlite.prepare(
    "select sender_protocol_epoch,sender_asset_revision,sender_lease_state,mount_generation,mount_state from continuation_conversation_cards where conversation_scope_id=?"
  ).get(scope);
  assert.equal(normalizedCard.sender_protocol_epoch, 13);
  assert.equal(normalizedCard.sender_asset_revision, runtime.continuationSenderAssetRevision,
    "rejected stale bind must not overwrite the current resource provenance");
  assert.equal(normalizedCard.sender_lease_state, "NEED_REBIND",
    "revision mismatch must revoke transport until the current immutable resource rebinds");
  assert.equal(normalizedCard.mount_generation, mount.anchorMountGeneration);
  assert.equal(normalizedCard.mount_state, "UNMOUNTED",
    "revision mismatch must request a same-generation current-resource remount instead of leaving stale VERIFIED bytes authoritative");
  const recoveryAnchor = await wire("continuation_anchor", { taskId: started.task.id });
  assert.equal(recoveryAnchor.continuationAnchor, true, JSON.stringify(recoveryAnchor));
  assert.equal(recoveryAnchor.anchorMountVerified, false,
    "asset-revision recovery must issue a fresh same-generation mount request");
  assert.equal(recoveryAnchor.anchorMountGeneration, mount.anchorMountGeneration,
    "asset-revision recovery must reuse the immutable card generation");
  // Restore the current-revision sender on the same immutable card generation
  // and use that authority for the remainder of the real MCP wire fixture.
  bindArgs.senderProtocolEpoch = runtime.continuationSenderProtocolEpoch;
  bindArgs.senderAssetRevision = runtime.continuationSenderAssetRevision;
  const reboundCurrent = await wire("continuation_sender", bindArgs);
  assert.equal(reboundCurrent.accepted, true);
  assert.equal(reboundCurrent.anchorMountToken, bound.anchorMountToken);
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
  const prematureAuthorization = await wire("continuation_sender", { ...deliveryArgs, action: "authorize-delivery" });
  assert.equal(prematureAuthorization.accepted, false,
    "pre-armed READY/CLAIMED must not bypass the signed completion handoff grace");
  runtime.database.sqlite.prepare("update continuation_tasks set assistant_turn_completion_requested_at=? where id=?")
    .run(new Date(Date.now() - 9_001).toISOString(), started.task.id);
  const authorization = await wire("continuation_sender", { ...deliveryArgs, action: "authorize-delivery" });
  assert.equal(authorization.accepted, true);
  const uncertain = await wire("continuation_sender", { ...deliveryArgs, action: "delivery-result",
    result: "unknown", method: "isolated-wire-test" });
  assert.equal(uncertain.outcomeUncertain, true);
  const delivered = await wire("continuation_sender", { ...deliveryArgs, action: "delivery-result",
    result: "accepted", method: "isolated-wire-test" });
  assert.equal(delivered.accepted, true);
  const historyMarker = "dev71-history-must-stay-server-side-".repeat(4000);
  const evidenceBeforeAck = runtime.database.sqlite.prepare("select evidence_json from continuation_tasks where id=?")
    .get(started.task.id).evidence_json;
  runtime.database.sqlite.prepare("update continuation_tasks set evidence_json=? where id=?")
    .run(JSON.stringify({ ...JSON.parse(evidenceBeforeAck || "{}"), dev71History: historyMarker }), started.task.id);
  runtime.recordContinuationResumeOperation({
    conversationScopeId: scope,
    workspaceId: started.task.workspaceId,
    operation: {
      tool: "read",
      path: "vendor/waishnav-devspace/dist/runtime-state.js",
      resultSummary: "located durable continuation state and next executable step",
    },
  });
  const ack = await wire("continuation_task", { action: "status", taskId: started.task.id,
    deliveryToken: claim.deliveryToken });
  assert.equal(ack.accepted, true);
  assert.equal(ack.task.workTicket, "synthetic-execution-v3");
  assert.equal(ack.task.nextAction, "CALL_SUBSTANTIVE_DEVSPACE_TOOL_NOW");
  const cachedAckKeys = new Set(["result", "task", "accepted", "reason", "reanchorRequired",
    "remainingMilestones", "taskIncomplete", "continueInSameTurn", "syntheticWorkMustContinue",
    "finalResponseAllowed", "preFinalControlRequired", "requiredBeforeFinal", "continueRequired",
    "nextRequiredMilestones"]);
  assert.deepEqual(Object.keys(ack).filter((key) => !cachedAckKeys.has(key)), [],
    "compact ACK must not introduce fields rejected by cached pre-dev71 schemas");
  assert.equal(ack.syntheticWorkMustContinue, true);
  assert.equal(ack.finalResponseAllowed, false);
  assert.deepEqual(ack.remainingMilestones, ["wire contract"]);
  assert.deepEqual(ack.nextRequiredMilestones, ["wire contract"]);
  assert.equal(ack.task.id, started.task.id);
  assert.equal(ack.task.assistantTurnOwner, "synthetic");
  assert.deepEqual(ack.task.requiredMilestones, ["wire contract"]);
  assert.deepEqual(ack.task.completedMilestones, []);
  assert.equal(ack.task.nextMilestone, "wire contract");
  assert.equal(ack.task.executionContract.protocol, "devspace-synthetic-execution-v3");
  assert.equal(ack.task.resumeContext.protocol, "devspace-resume-execution-v1");
  assert.equal(ack.task.resumeContext.operations.at(-1).path,
    "vendor/waishnav-devspace/dist/runtime-state.js");
  assert.match(ack.task.executionContract.resumeInstruction, /latest concrete operation/i);
  assert.equal(ack.task.executionContract.mustContinueSameTurn, true);
  assert.equal(ack.task.executionContract.finalResponseAllowed, false);
  assert.match(ack.requiredBeforeFinal, /MANDATORY NEXT OUTPUT/);
  assert.match(ack.requiredBeforeFinal, /MANDATORY NEXT OUTPUT: substantive DevSpace tool call/);
  assert.match(ack.requiredBeforeFinal, /'继续处理中'/);
  assert.match(ack.requiredBeforeFinal, /genuine stage boundary/);
  assert.match(ack.requiredBeforeFinal, /turn-complete/);
  assert.match(ack.requiredBeforeFinal, /concise visible progress summary/);
  assert.match(ack.requiredBeforeFinal, /auto-resume in the next synthetic turn/);
  assert.match(ack.requiredBeforeFinal, /wire contract/);
  assert.match(lastWireReply.content?.[0]?.text ?? "", /DEVSPACE SYNTHETIC EXECUTION HANDOFF \[P0\]/,
    "successful synthetic ACK must put the execution handoff before the JSON payload");
  assert.match(lastWireReply.content?.[0]?.text ?? "", /ACK\/status is not work/,
    "ACK must explicitly forbid treating status as substantive work");
  assert.equal(Object.hasOwn(ack.task, "evidence"), false);
  const ackBytes = Buffer.byteLength(JSON.stringify(ack));
  console.log(`ACK_BYTES=${ackBytes}`);
  assert.ok(ackBytes < 8000, "first ACK stays bounded with large history");
  assert.equal(JSON.stringify(ack).includes("dev71-history"), false);
  const diagnostic = await wire("continuation_task", { action: "status", taskId: started.task.id, readOnlyStatus: true });
  assert.equal(diagnostic.task.workTicket, undefined, "read-only diagnostics retain full state");
  assert.equal(diagnostic.task.evidence.dev71History, historyMarker, "ACK projection must not erase persisted evidence");
  const modelMeta = { "openai/session": scope };
  const workspace = await wire("open_workspace", { path: temp }, modelMeta);
  assert.ok(workspace.workspaceId);
  const read = await wire("read", { workspaceId: workspace.workspaceId, path: "config/config.json" }, modelMeta);
  assert.ok(read.result.includes("allowedRoots"));
  assert.equal(read.devspacePreFinalBarrier?.mustContinueSameTurn, true,
    "ordinary data-plane results retain the compact unfinished-work gate");
  assert.equal(Object.hasOwn(read, "task"), false,
    "ordinary results must not replay the full mutable task projection");
  assert.equal(Object.hasOwn(read, "taskContract"), false,
    "ordinary results must not replay the full Task Contract projection");
  assert.equal(JSON.stringify(read).includes("resumeContext"), false,
    "the durable resume capsule is control-plane state, not per-operation payload");
  assert.ok(Buffer.byteLength(JSON.stringify(read)) < ackBytes,
    "a small ordinary result must stay below the one-time bounded synthetic execution ACK");
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
  const afterDataPlaneWork = await wire("continuation_task", {
    action: "status", taskId: started.task.id, readOnlyStatus: true,
  });
  assert.ok(afterDataPlaneWork.task.resumeContext.operations.some((operation) => operation.tool === "apply_patch"),
    "data-plane compaction must not stop durable resume-capsule persistence");
  assert.equal(JSON.stringify(written).includes("resumeContext"), false,
    "later ordinary results must remain compact even as the durable capsule grows server-side");
  await wire("continuation_task", { action: "checkpoint", taskId: started.task.id,
    completedMilestones: ["wire contract"] });
  await wire("continuation_task", { action: "complete", taskId: started.task.id });
  // Exercise actual wire replies on alternate paths too. Fixtures and Host
  // delivery receipts below are isolated simulations, never live ChatGPT ACKs.
  for (const epoch of [12, runtime.continuationSenderProtocolEpoch]) {
  for (const scenario of ["timeout", "manual-takeover", "rejected", "failed", "fallback-accepted"]) {
    const scenarioScope = `${scope}/epoch-${epoch}/${scenario}`;
    const scenarioTask = runtime.continuationTask({ action: "begin", conversationScopeId: scenarioScope,
      objective: `Validate ${scenario} wire responses`, requiredMilestones: [scenario],
      continuationMode: "completion-driven" }).task;
    const anchor = await wire("continuation_anchor", { taskId: scenarioTask.id });
    const binding = { ...bindArgs, taskId: scenarioTask.id, conversationScopeId: scenarioScope,
      senderProtocolEpoch: epoch,
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
    if (scenario !== "timeout") {
      assert.equal((await wire("continuation_anchor", { ...delivery,
        bridgeAction: "sender-authorize-delivery" })).accepted, false,
      `${scenario}: cached bridge must also enforce the completion grace`);
      runtime.database.sqlite.prepare("update continuation_tasks set assistant_turn_completion_requested_at=? where id=?")
        .run(new Date(Date.now() - 9_001).toISOString(), scenarioTask.id);
    }
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
        const deliveryProbe = await wire("continuation_task", {
          taskId: scenarioTask.id, action: "status", readOnlyStatus: true });
        assert.equal(deliveryProbe.deliveryDiagnostics.state, "DELIVERED");
        assert.equal(deliveryProbe.deliveryDiagnostics.turnAckedAt, null);
        assert.equal(deliveryProbe.deliveryDiagnostics.blockReason, null);
        assert.equal(JSON.stringify(deliveryProbe.deliveryDiagnostics).includes(acquired.deliveryToken), false);
        const resumed = await wire("continuation_task", { taskId: scenarioTask.id, action: "status",
          ...(scenario === "fallback-accepted" ? {} : { deliveryToken: acquired.deliveryToken }) });
        assert.equal(resumed.accepted, true);
        assert.equal(resumed.task.workTicket, "synthetic-execution-v3", "token and compatible tokenless ACKs both stay execution-focused");
        assert.equal(resumed.task.nextAction, "CALL_SUBSTANTIVE_DEVSPACE_TOOL_NOW");
        assert.equal(resumed.task.executionContract.mustContinueSameTurn, true);
        assert.equal(resumed.task.nextMilestone, scenario);
        assert.equal(resumed.finalResponseAllowed, false);
        const acknowledgedGeneration = runtime.database.sqlite.prepare(
          "select * from continuation_generations where delivery_token=?").get(acquired.deliveryToken);
        for (const lateResult of ["accepted", "unknown", "rejected", "failed"]) {
          for (const bridge of [false, true]) {
            const late = await wire(bridge ? "continuation_anchor" : "continuation_sender", {
              ...delivery, ...(bridge ? { bridgeAction: "sender-delivery-result" } : { action: "delivery-result" }),
              result: lateResult, method: "isolated-late-wire-test",
            });
            assert.equal(late.accepted, true);
            assert.equal(late.reason, "generation-state-already-advanced");
            assert.deepEqual(runtime.database.sqlite.prepare(
              "select * from continuation_generations where delivery_token=?").get(acquired.deliveryToken),
            acknowledgedGeneration, "late receipt must not downgrade the actual wire ACK");
          }
        }
        const emptyFinal = await wire("continuation_task", { taskId: scenarioTask.id, action: "turn-complete" });
        assert.equal(emptyFinal.accepted, false);
        assert.equal(emptyFinal.minimumSubstantiveWorkDelta, 4);
      }
    }
    await wire("continuation_task", { taskId: scenarioTask.id, action: "cancel" });
  }
  }
  console.log("PASS: epoch 12/13 wire compatibility, epoch 11/future rejection, normalized leases and cached sender manual fencing");
  console.log("PASS: strict schema, cached bridge, timeout, manual fencing, rejection, retry and synthetic work floor");
  console.log("PASS: selective task discovery and bounded execution ACK with retained server-side history");
  console.log("PASS: real MCP anchor/status/bind/heartbeat/READY/claim/authorize/receipt/ACK/completion contracts");
} finally {
  await samplingClient?.close().catch(() => undefined);
  await client.close().catch(() => undefined);
  http.closeAllConnections();
  await new Promise((done) => http.close(done));
  await service.close();
  provider.close();
  rmSync(temp, { recursive: true, force: true });
}
