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

  // dev12 manual-round contract on a still-running lifetime task. Every real
  // manual DevSpace message owns one fresh visible card. The same plan must
  // keep the existing workset; a different plan must replace the active
  // workset atomically before that one new card is prepared.
  {
    const scope = "v1/test-dev12-manual-running-card-contract";
    const { taskId, generation } = createVerifiedTask(scope, "manual-running-a");
    const initialSnapshot = runtime.continuationArchitectureSnapshot(scope);
    const initialWorksetId = initialSnapshot.card.active_workset_id;

    const samePlan = runtime.continuationTask({
      action: "status",
      taskId,
      conversationScopeId: scope,
      manualTakeover: true,
      requiredMilestones: ["manual-running-a"],
    });
    assert.equal(samePlan.accepted, true);
    assert.equal(samePlan.manualRoundCardRequired, true);
    assert.equal(samePlan.milestoneCardRequired, true);
    assert.equal(samePlan.manualMilestoneSetChanged, undefined);
    assert.equal(Number(samePlan.task.anchorMountGeneration), generation + 1,
      "every manual DevSpace message must rotate exactly one fresh card even when its milestone plan is unchanged");
    assert.equal(runtime.continuationArchitectureSnapshot(scope).card.active_workset_id, initialWorksetId,
      "same-plan manual input must not manufacture a new workset");
    assert.equal(mountAndVerify(taskId, scope, "ui_manual_running_same"), generation + 1);

    const changedPlan = runtime.continuationTask({
      action: "status",
      taskId,
      conversationScopeId: scope,
      manualTakeover: true,
      objective: "manual running replacement task",
      requiredMilestones: ["manual-running-b", "manual-running-c"],
    });
    assert.equal(changedPlan.accepted, true);
    assert.equal(changedPlan.manualRoundCardRequired, true);
    assert.equal(changedPlan.milestoneCardRequired, true);
    assert.equal(changedPlan.manualMilestoneSetChanged, true);
    assert.equal(Number(changedPlan.task.anchorMountGeneration), generation + 2,
      "a changed manual plan must still own only its single fresh manual card generation");
    assert.deepEqual(changedPlan.task.requiredMilestones, ["manual-running-b", "manual-running-c"]);
    const changedSnapshot = runtime.continuationArchitectureSnapshot(scope);
    assert.notEqual(changedSnapshot.card.active_workset_id, initialWorksetId);
    assert.equal(changedSnapshot.worksets.find((entry) => entry.id === initialWorksetId)?.state, "SUPERSEDED");
    assert.deepEqual(
      changedSnapshot.milestones
        .filter((entry) => entry.workset_id === changedSnapshot.card.active_workset_id)
        .map((entry) => entry.description),
      ["manual-running-b", "manual-running-c"],
      "the changed manual card/workset must contain only the new highest-priority plan",
    );
    assert.equal(mountAndVerify(taskId, scope, "ui_manual_running_changed"), generation + 2,
      "preparing and verifying the already-rotated manual card must not create a duplicate generation");
    const recovered = runtime.continuationTask({ action: "status", taskId, conversationScopeId: scope });
    assert.deepEqual(recovered.task.requiredMilestones, ["manual-running-b", "manual-running-c"],
      "canonical projection recovery must not resurrect the SUPERSEDED manual plan");
  }

  // The mandatory first status may only establish manual ownership. The
  // refined plan can arrive on the following begin/continuation_anchor. That
  // second control call must replace the active plan instead of merging the
  // historical lifetime milestone ledger into the current manual Workset.
  {
    const scope = "v1/test-manual-status-then-begin-plan-replacement";
    const { taskId, generation } = createVerifiedTask(scope, "historical-running-a");
    runtime.continuationTask({
      action: "checkpoint",
      taskId,
      conversationScopeId: scope,
      requiredMilestones: ["historical-running-b"],
      completedMilestones: ["historical-running-a"],
      progressFingerprint: "historical-plan-before-manual-switch",
    });
    const historicalWorksetId = runtime.continuationArchitectureSnapshot(scope).card.active_workset_id;

    const takeoverOnly = runtime.continuationTask({
      action: "status",
      taskId,
      conversationScopeId: scope,
      manualTakeover: true,
    });
    assert.equal(takeoverOnly.accepted, true);
    assert.equal(Number(takeoverOnly.task.anchorMountGeneration), generation + 1,
      "takeover-only first status must rotate exactly one fresh manual card");
    assert.ok(takeoverOnly.task.requiredMilestones.includes("historical-running-b"),
      "takeover-only status may temporarily retain the old plan until refinement arrives");
    const takeoverRow = db.prepare(`
      select manual_takeover_at,turn_started_at,assistant_turn_owner
      from continuation_tasks where id=?
    `).get(taskId);
    assert.equal(takeoverRow.manual_takeover_at, takeoverRow.turn_started_at,
      "manual takeover must persist an exact durable round-start marker for same-round plan refinement");
    assert.equal(takeoverRow.assistant_turn_owner, "manual",
      "manual takeover must persist manual assistant-turn ownership before same-round begin refinement");

    const refined = runtime.continuationTask({
      action: "begin",
      taskId,
      conversationScopeId: scope,
      workspaceId: "ws_card_lifecycle",
      continuationMode: "completion-driven",
      objective: "refined manual replacement after status",
      requiredMilestones: ["current-manual-a", "current-manual-b"],
    });
    assert.equal(Number(refined.task.anchorMountGeneration), generation + 1,
      "status followed by same-round plan refinement must not rotate a second card");
    assert.deepEqual(refined.task.requiredMilestones, ["current-manual-a", "current-manual-b"],
      "same-round explicit begin must replace rather than append the historical milestone ledger");
    assert.deepEqual(refined.task.completedMilestones, [],
      "completed milestones from the historical plan must not leak into an unrelated current plan");

    const refinedSnapshot = runtime.continuationArchitectureSnapshot(scope);
    const refinedWorksetId = refinedSnapshot.card.active_workset_id;
    assert.notEqual(refinedWorksetId, historicalWorksetId,
      "same-round plan replacement must allocate a fresh active Workset");
    assert.equal(refinedSnapshot.worksets.find((entry) => entry.id === historicalWorksetId)?.state, "SUPERSEDED");
    assert.deepEqual(
      refinedSnapshot.milestones
        .filter((entry) => entry.workset_id === refinedWorksetId && entry.state !== "ARCHIVED")
        .map((entry) => entry.description),
      ["current-manual-a", "current-manual-b"],
      "the active Workset must contain only the refined current-round plan",
    );

    const recovered = runtime.continuationTask({ action: "status", taskId, conversationScopeId: scope });
    assert.deepEqual(recovered.task.requiredMilestones, ["current-manual-a", "current-manual-b"],
      "later status/recovery must preserve the refined plan without resurrecting history");
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
      coordinatorInstanceId: "ui_synthetic-a",
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
    assert.equal(Number(syntheticStatus.task.anchorMountGeneration), generation,
      "automatic continuation with an unchanged milestone set must reuse the current visible card");
    assert.notEqual(syntheticStatus.milestoneCardRequired, true,
      "automatic continuation must not rotate a card merely because a synthetic Host turn started");
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
    assert.notEqual(repeated.milestoneCardRequired, true,
      "automatic same-set checkpoints must not request another card generation");
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
