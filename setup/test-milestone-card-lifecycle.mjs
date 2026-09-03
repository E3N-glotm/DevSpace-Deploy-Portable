import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const runtimePath = join(ROOT, "app", "node_modules", "@waishnav", "devspace", "dist", "runtime-state.js");
const { StructuredRuntimeState } = await import(pathToFileURL(runtimePath).href);

const stateDir = mkdtempSync(join(tmpdir(), "devspace-milestone-card-lifecycle-"));
const runtime = new StructuredRuntimeState(stateDir);
const db = runtime.database.sqlite;

function mountAndVerify(taskId, conversationScopeId, coordinatorInstanceId) {
  const mount = runtime.prepareContinuationAnchorMount({ taskId, conversationScopeId });
  assert.ok(mount.anchorMountToken);
  assert.ok(Number(mount.anchorMountGeneration) > 0);
  const mounted = runtime.continuationTask({
    action: "anchor-mounted",
    taskId,
    conversationScopeId,
    coordinatorInstanceId,
    anchorMountToken: mount.anchorMountToken,
    anchorMountGeneration: mount.anchorMountGeneration,
    hostProfileId: "chatgpt@0.0.1",
  });
  assert.equal(mounted.accepted, true);
  return Number(mount.anchorMountGeneration);
}

function createVerifiedTask(conversationScopeId, milestone) {
  const begun = runtime.continuationTask({
    action: "begin",
    conversationScopeId,
    workspaceId: "ws_card_lifecycle",
    continuationMode: "completion-driven",
    objective: milestone,
    requiredMilestones: [milestone],
  });
  assert.ok(begun.task?.id);
  const generation = mountAndVerify(begun.task.id, conversationScopeId, `ui_${milestone}`);
  return { taskId: begun.task.id, generation };
}

function finishTask(taskId, conversationScopeId, milestone) {
  const finished = runtime.continuationTask({
    action: "checkpoint",
    taskId,
    conversationScopeId,
    completedMilestones: [milestone],
    evidence: { [milestone]: "verified" },
    progressFingerprint: `${milestone}-complete`,
  });
  assert.equal(finished.task.state, "SUCCEEDED");
  return finished;
}

try {
  // A terminal task must still create a fresh visible card as soon as the next
  // real manual user message starts DevSpace work. A following begin must reuse
  // that pending generation rather than rotate a duplicate card.
  {
    const scope = "v1/test-manual-terminal-status-card";
    const milestone = "manual-old";
    const { taskId, generation } = createVerifiedTask(scope, milestone);
    finishTask(taskId, scope, milestone);

    const manualStatus = runtime.continuationTask({
      action: "status",
      taskId,
      conversationScopeId: scope,
      manualTakeover: true,
    });
    assert.equal(manualStatus.accepted, true);
    assert.equal(manualStatus.reason, "manual-round-started");
    assert.equal(manualStatus.manualRoundCardRequired, true);
    assert.equal(manualStatus.milestoneCardRequired, true);
    assert.equal(manualStatus.initialAnchorRequired, true);
    assert.equal(manualStatus.reanchorRequired, true);
    assert.equal(Number(manualStatus.task.anchorMountGeneration), generation + 1,
      "every new manual user message must rotate one fresh visible card even when the lifetime task was terminal");

    const manualGeneration = Number(manualStatus.task.anchorMountGeneration);
    const reactivated = runtime.continuationTask({
      action: "begin",
      taskId,
      conversationScopeId: scope,
      workspaceId: "ws_card_lifecycle",
      continuationMode: "completion-driven",
      objective: "manual-new",
      requiredMilestones: ["manual-new"],
    });
    assert.equal(Number(reactivated.task.anchorMountGeneration), manualGeneration,
      "status + begin for one manual message must not create two card generations");
    assert.equal(reactivated.milestoneCardRequired, true);
  }

  // Hosts that call begin directly for genuinely new terminal work must still
  // obtain a fresh generation; the card rule cannot depend on a prior status
  // side effect.
  {
    const scope = "v1/test-manual-direct-begin-card";
    const milestone = "direct-old";
    const { taskId, generation } = createVerifiedTask(scope, milestone);
    finishTask(taskId, scope, milestone);

    const begun = runtime.continuationTask({
      action: "begin",
      taskId,
      conversationScopeId: scope,
      workspaceId: "ws_card_lifecycle",
      continuationMode: "completion-driven",
      objective: "direct-new",
      requiredMilestones: ["direct-new"],
    });
    assert.equal(Number(begun.task.anchorMountGeneration), generation + 1);
    assert.equal(begun.manualRoundCardRequired, true);
    assert.equal(begun.milestoneCardRequired, true);
    assert.equal(begun.reanchorRequired, true);
  }

  // A synthetic continuation keeps its current card while the required set is
  // stable. Appending a new required milestone is a visible contract revision
  // and must rotate exactly one generation. Repeating the same set or merely
  // completing milestones must not rotate again.
  {
    const scope = "v1/test-synthetic-milestone-revision-card";
    const { taskId, generation } = createVerifiedTask(scope, "synthetic-a");
    const workset = db.prepare(`
      select * from continuation_worksets
      where legacy_task_id=?
      order by sequence desc
      limit 1
    `).get(taskId);
    assert.ok(workset, "synthetic milestone revision test requires an active workset");
    const activeCard = db.prepare(`
      select * from continuation_conversation_cards where conversation_scope_id=?
    `).get(scope);
    assert.ok(activeCard?.mount_token, "verified synthetic test card must retain its sender capability");

    // Drive the exact production lifecycle instead of manufacturing
    // delivery_owner='synthetic-active' directly. A READY generation must come
    // from authoritative Host-end evidence (not request silence), then the
    // verified App sender claims/records delivery and model-side status
    // acknowledges the resumed synthetic turn.
    db.prepare(`
      update continuation_worksets
         set continuation_due_at=?,last_model_activity_at=?,updated_at=?
       where id=?
    `).run(
      new Date(Date.now() - 60_000).toISOString(),
      new Date(Date.now() - 60_000).toISOString(),
      new Date().toISOString(),
      workset.id,
    );
    runtime.continuationTask({
      action: "host-signal",
      taskId,
      conversationScopeId: scope,
      hostProfileId: "milestone-card-lifecycle@test",
      hostSignal: "timeout",
      elapsedMs: 60_000,
    });
    const swept = runtime.continuationSupervisorSweep();
    assert.ok(swept.ready?.length > 0, "explicit Host timeout must create a READY synthetic generation");

    const claimed = runtime.claimReadyContinuationGeneration({
      conversationScopeId: scope,
      taskId,
      senderInstanceId: "ui_synthetic_revision",
      anchorMountToken: activeCard.mount_token,
      anchorMountGeneration: Number(activeCard.mount_generation),
    });
    assert.equal(claimed.accepted, true, "verified sender must claim the READY generation");

    const authorized = runtime.authorizeContinuationGenerationDelivery({
      conversationScopeId: scope,
      taskId,
      senderInstanceId: "ui_synthetic_revision",
      anchorMountToken: activeCard.mount_token,
      anchorMountGeneration: Number(activeCard.mount_generation),
      deliveryToken: claimed.deliveryToken,
    });
    assert.equal(authorized.accepted, true, "claimed synthetic generation must enter DELIVERING");

    const delivered = runtime.recordContinuationGenerationDelivery({
      deliveryToken: claimed.deliveryToken,
      result: "accepted",
      method: "test-app.sendMessage",
    });
    assert.equal(delivered.accepted, true, "synthetic delivery must become WORK_REQUIRED");

    const syntheticStatus = runtime.continuationTask({
      action: "status",
      taskId,
      conversationScopeId: scope,
    });
    assert.equal(syntheticStatus.accepted, true, "model-side status must claim the expected synthetic turn");
    assert.equal(syntheticStatus.syntheticWorkMustContinue, true,
      "unfinished synthetic ownership must require sustained substantive work");
    assert.equal(syntheticStatus.continueInSameTurn, true,
      "unfinished synthetic ownership must continue in the same assistant turn");
    assert.equal(syntheticStatus.finalResponseAllowed, false,
      "unfinished synthetic ownership must forbid a voluntary final response");
    assert.equal(
      db.prepare("select delivery_owner from continuation_tasks where id=?").get(taskId)?.delivery_owner,
      "synthetic-active",
      "checkpoint precondition must be the real synthetic-active ownership state",
    );

    const revised = runtime.continuationTask({
      action: "checkpoint",
      taskId,
      conversationScopeId: scope,
      requiredMilestones: ["synthetic-b"],
      evidence: { phase: "revision" },
      progressFingerprint: "synthetic-added-b",
    });
    assert.equal(revised.accepted, true);
    assert.equal(revised.syntheticWorkMustContinue, true);
    assert.equal(revised.continueInSameTurn, true);
    assert.equal(revised.finalResponseAllowed, false);
    assert.equal(revised.milestoneCardRequired, true);
    assert.equal(revised.initialAnchorRequired, true);
    assert.equal(revised.reanchorRequired, true);
    assert.equal(Number(revised.task.anchorMountGeneration), generation + 1,
      "synthetic required-milestone revision must rotate one visible card generation");

    const revisedGeneration = Number(revised.task.anchorMountGeneration);
    const repeated = runtime.continuationTask({
      action: "checkpoint",
      taskId,
      conversationScopeId: scope,
      requiredMilestones: ["synthetic-a", "synthetic-b"],
      evidence: { phase: "same-set" },
      progressFingerprint: "synthetic-same-set",
    });
    assert.equal(Number(repeated.task.anchorMountGeneration), revisedGeneration,
      "repeating the same required milestone set must reuse the pending/current card");
    assert.notEqual(repeated.milestoneCardRequired, true);
    assert.equal(repeated.syntheticWorkMustContinue, true);
    assert.equal(repeated.continueInSameTurn, true);
    assert.equal(repeated.finalResponseAllowed, false);

    const completionOnly = runtime.continuationTask({
      action: "checkpoint",
      taskId,
      conversationScopeId: scope,
      completedMilestones: ["synthetic-a"],
      evidence: { "synthetic-a": "done" },
      progressFingerprint: "synthetic-completion-only",
    });
    assert.equal(Number(completionOnly.task.anchorMountGeneration), revisedGeneration,
      "completed/progress/evidence updates without a required-set change must not rotate a card");
    assert.notEqual(completionOnly.milestoneCardRequired, true);
  }

  console.log("milestone card lifecycle tests passed");
} finally {
  runtime.close();
  rmSync(stateDir, { recursive: true, force: true });
}
