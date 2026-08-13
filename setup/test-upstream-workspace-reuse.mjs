import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { openAiConversationScopeId } from "../app/node_modules/@waishnav/devspace/dist/request-meta.js";
import { createWorkspaceStore } from "../app/node_modules/@waishnav/devspace/dist/workspace-store.js";
import { WorkspaceRegistry } from "../app/node_modules/@waishnav/devspace/dist/workspaces.js";

const root = resolve(tmpdir(), `devspace-conversation-reuse-${randomUUID()}`);
const stateDir = join(root, "state");
const agentDir = join(root, "agents");
const worktreeRoot = join(root, "worktrees");
const projectA = join(root, "project-a");
const projectB = join(root, "project-b");
for (const path of [stateDir, agentDir, worktreeRoot, projectA, projectB]) {
  mkdirSync(path, { recursive: true });
}

const config = {
  allowedRoots: [root],
  worktreeRoot,
  agentDir,
  devspaceSkillsDir: join(root, "devspace-skills"),
  devspaceAgentsDir: join(root, "devspace-agents"),
  skillPaths: [],
  skillsEnabled: false,
  subagents: false,
  permissions: {
    allowExternalPaths: false,
  },
};

function createRegistry() {
  const store = createWorkspaceStore(stateDir);
  return { store, registry: new WorkspaceRegistry(config, store) };
}

try {
  const installedServerSource = readFileSync(
    new URL("../app/node_modules/@waishnav/devspace/dist/server.js", import.meta.url),
    "utf8",
  );
  assert.match(installedServerSource, /openAiConversationScopeId\(_meta\)/);
  assert.match(installedServerSource, /workspaceReused/);
  assert.match(installedServerSource, /includeBootstrapContext/);

  assert.equal(openAiConversationScopeId({ "openai/session": "conversation-a" }), "conversation-a");
  assert.equal(openAiConversationScopeId({ "openai/session": "" }), undefined);
  assert.equal(openAiConversationScopeId({ "openai/session": 123 }), undefined);
  assert.equal(openAiConversationScopeId(undefined), undefined);

  const firstRuntime = createRegistry();
  const first = await firstRuntime.registry.openWorkspace(
    { path: projectA, mode: "checkout" },
    { conversationScopeId: "conversation-a" },
  );
  assert.match(first.workspace.id, /^ws_[0-9a-f]{10}$/);
  assert.equal(first.workspaceReused, false);
  assert.equal(first.includeBootstrapContext, true);

  const second = await firstRuntime.registry.openWorkspace(
    { path: projectA, mode: "checkout" },
    { conversationScopeId: "conversation-a" },
  );
  assert.equal(second.workspace.id, first.workspace.id);
  assert.equal(second.workspaceReused, true);
  assert.equal(second.includeBootstrapContext, false);

  const otherConversation = await firstRuntime.registry.openWorkspace(
    { path: projectA, mode: "checkout" },
    { conversationScopeId: "conversation-b" },
  );
  assert.notEqual(otherConversation.workspace.id, first.workspace.id);

  const concurrent = await Promise.all(
    Array.from({ length: 6 }, () => firstRuntime.registry.openWorkspace(
      { path: projectB, mode: "checkout" },
      { conversationScopeId: "conversation-concurrent" },
    )),
  );
  assert.equal(new Set(concurrent.map((item) => item.workspace.id)).size, 1);
  assert.equal(concurrent.filter((item) => item.includeBootstrapContext).length, 1);

  firstRuntime.store.close();

  const restartedRuntime = createRegistry();
  const afterRestart = await restartedRuntime.registry.openWorkspace(
    { path: projectA, mode: "checkout" },
    { conversationScopeId: "conversation-a" },
  );
  assert.equal(afterRestart.workspace.id, first.workspace.id);
  assert.equal(afterRestart.workspaceReused, true);
  assert.equal(afterRestart.includeBootstrapContext, false);

  restartedRuntime.registry.archiveSession(first.workspace.id);
  const afterArchive = await restartedRuntime.registry.openWorkspace(
    { path: projectA, mode: "checkout" },
    { conversationScopeId: "conversation-a" },
  );
  assert.notEqual(afterArchive.workspace.id, first.workspace.id);
  assert.equal(afterArchive.workspaceReused, false);
  assert.equal(afterArchive.includeBootstrapContext, true);

  assert.throws(
    () => restartedRuntime.registry.getWorkspace("ws_missing0000"),
    /Open the target project or worktree again and continue with the new workspaceId/,
  );

  restartedRuntime.store.close();

  console.log(JSON.stringify({
    requestMetaSessionScope: true,
    serverRequestMetaIntegration: true,
    sameConversationCheckoutReuse: true,
    bootstrapSuppressedOnReuse: true,
    differentConversationsRemainIsolated: true,
    concurrentDuplicateOpensCoalesced: true,
    reuseSurvivesRegistryRestart: true,
    archivedBindingRecoversSafely: true,
    compactWorkspaceIds: true,
    unknownWorkspaceRecoveryActionable: true,
  }));
} finally {
  rmSync(root, { recursive: true, force: true });
}
