import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

import {
  collectWorkspacePreviews,
  nativeAttachmentContent,
  processToolResponse,
  redactDisplayArgv,
  reviewOperation,
  shouldAttachWidget,
  toolInvocationStatus,
  toolWidgetDescriptorMeta,
  workspaceAppHtml,
} from "../app/node_modules/@waishnav/devspace/dist/server.js";

const root = await mkdtemp(join(tmpdir(), "devspace-runtime-card-smoke-"));

try {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z6i8AAAAASUVORK5CYII=",
    "base64",
  );
  await writeFile(join(root, "preview.png"), png);
  await writeFile(join(root, "report.pdf"), Buffer.from("%PDF-1.4\n"));

  const workspaces = {
    resolvePath(_workspace, relativePath) {
      const absolutePath = resolve(root, relativePath);
      if (absolutePath !== root && !absolutePath.startsWith(`${root}${sep}`)) {
        throw new Error("preview path escaped the workspace");
      }
      return absolutePath;
    },
  };

  const preview = await collectWorkspacePreviews(
    { root },
    [
      { path: "preview.png", type: "new" },
      { path: "report.pdf", type: "new" },
    ],
    workspaces,
  );
  if (preview.previews.length !== 1 || preview.artifacts.length !== 2 || preview.imageContent.length !== 1) {
    throw new Error("preview classification failed");
  }

  const nativeImage = nativeAttachmentContent("ws_test", "preview.png", "image/png", png);
  if (nativeImage.length !== 1 || nativeImage[0].type !== "image" || nativeImage[0].mimeType !== "image/png") {
    throw new Error("native image attachment block is invalid");
  }
  const pdfBytes = Buffer.from("%PDF-1.4\n");
  const nativePdf = nativeAttachmentContent("ws_test", "report.pdf", "application/pdf", pdfBytes);
  if (
    nativePdf.length !== 1
    || nativePdf[0].type !== "resource"
    || nativePdf[0].resource?.mimeType !== "application/pdf"
    || Buffer.from(nativePdf[0].resource?.blob ?? "", "base64").compare(pdfBytes) !== 0
  ) {
    throw new Error("native PDF attachment resource is invalid");
  }

  const safeArgv = redactDisplayArgv([
    "python",
    "train.py",
    "--token",
    "secret-token",
    "--password=secret-password",
  ]);
  if (JSON.stringify(safeArgv).includes("secret-")) {
    throw new Error("argv redaction failed");
  }

  const response = processToolResponse(
    "exec_command",
    "ws_test",
    {
      output: "done\n",
      processHandle: "proc_test",
      sessionId: 1,
      running: false,
      exitCode: 0,
      wallTimeMs: 12,
      pid: 42,
      outputTruncated: false,
    },
    { command: "python train.py --token <redacted>", running: false, exitCode: 0 },
    {
      command: "python train.py --token <redacted>",
      argv: safeArgv,
      environment: { API_TOKEN: "secret-environment" },
      workingDirectory: root,
    },
  );
  if (JSON.stringify(response).includes("secret-")) {
    throw new Error("runtime response redaction failed");
  }

  const operation = reviewOperation({
    id: 7,
    tool: "exec_command",
    success: true,
    durationMs: 18,
    createdAt: "2026-08-04T00:00:00.000Z",
    details: {
      command: "python train.py --token <redacted>",
      workingDirectory: root,
      permissionDecision: "allow",
      permissionRule: "default",
    },
  });
  if (operation.tool !== "exec_command" || operation.command.includes("secret")) {
    throw new Error("operation timeline normalization failed");
  }

  const html = workspaceAppHtml({ publicBaseUrl: "https://example.test" });
  if (
    !html.includes("runtime-enhancements.js")
    || !html.includes("runtime-enhancements.css")
    || !html.includes("session-review.css")
    || !html.includes("runtime-timeline.css")
  ) {
    throw new Error("runtime enhancement assets are missing from the workspace app");
  }

  for (const relativePath of [
    "../app/node_modules/@waishnav/devspace/dist/ui/assets/runtime-enhancements.js",
    "../app/node_modules/@waishnav/devspace/dist/ui/assets/runtime-enhancements.css",
    "../app/node_modules/@waishnav/devspace/dist/ui/assets/session-review.css",
    "../app/node_modules/@waishnav/devspace/dist/ui/assets/runtime-timeline.css",
  ]) {
    if ((await readFile(new URL(relativePath, import.meta.url))).length === 0) {
      throw new Error(`empty runtime enhancement asset: ${relativePath}`);
    }
  }

  const changesConfig = {
    widgets: "changes",
    toolMode: "codex",
    oauth: { scopes: ["devspace"] },
  };
  if (shouldAttachWidget(changesConfig, "runtime")) {
    throw new Error("runtime tools must stay headless in changes mode");
  }
  if (shouldAttachWidget(changesConfig, "edit")) {
    throw new Error("edit tools must stay headless in changes mode");
  }
  if (!shouldAttachWidget(changesConfig, "show_changes")) {
    throw new Error("show_changes must remain the dedicated render tool");
  }
  const renderMeta = toolWidgetDescriptorMeta(changesConfig, "show_changes");
  if (
    renderMeta._meta?.ui?.resourceUri !== "ui://devspace/workspace-app.html"
    || renderMeta._meta?.["openai/outputTemplate"] !== "ui://devspace/workspace-app.html"
  ) {
    throw new Error("show_changes render metadata is incomplete");
  }
  const runtimeMeta = toolWidgetDescriptorMeta(changesConfig, "runtime");
  if (runtimeMeta._meta?.ui || runtimeMeta._meta?.["openai/outputTemplate"]) {
    throw new Error("headless runtime tools unexpectedly expose a widget template");
  }
  if (!runtimeMeta._meta?.["openai/toolInvocation/invoking"] || !runtimeMeta._meta?.["openai/toolInvocation/invoked"]) {
    throw new Error("runtime invocation status metadata is missing");
  }
  if (toolInvocationStatus("workspace").invoked !== "工作区已就绪") {
    throw new Error("workspace invocation status is incorrect");
  }
  const enhancementSource = await readFile(
    new URL("../app/node_modules/@waishnav/devspace/dist/ui/assets/runtime-enhancements.js", import.meta.url),
    "utf8",
  );
  if (!enhancementSource.includes("DevSpace Portable 1.1.8 · Protocol 1.5")
      || !enhancementSource.includes("session_rollback")
      || !enhancementSource.includes("session_changes")) {
    throw new Error("session review, rollback, or version footer is missing from the Workspace App");
  }

  console.log(
    JSON.stringify({
      previewFiles: preview.previews.length,
      artifacts: preview.artifacts.length,
      imageBlocks: preview.imageContent.length,
      nativeImageAttachment: true,
      nativePdfAttachment: true,
      argvRedacted: true,
      runtimeResponseRedacted: true,
      operationTimeline: true,
      runtimeAssets: true,
      decoupledRenderTool: true,
      invocationStatusMetadata: true,
      sessionReviewUi: true,
      versionFooter: true,
    }),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
