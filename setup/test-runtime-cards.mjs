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
    !html.includes("const RUNTIME_TOOLS = new Set([")
    || !html.includes(".codex-runtime-card{")
    || !html.includes(".devspace-session-review{")
    || !html.includes(".devspace-operation-timeline {")
    || /<script[^>]+src=/.test(html)
    || /<link[^>]+rel="stylesheet"/.test(html)
  ) {
    throw new Error("runtime enhancement assets are not self-contained in the workspace app");
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
    features: { continuationGuard: true },
    oauth: { scopes: ["devspace"] },
    publicBaseUrl: "https://devspace.example.test",
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
  if (shouldAttachWidget(changesConfig, "workspace")) {
    throw new Error("open_workspace must stay headless so reopening/reconnecting cannot create duplicate milestone cards");
  }
  if (!shouldAttachWidget(changesConfig, "continuation-anchor")) {
    throw new Error("continuation_anchor must remain the one deliberate visible milestone-card entry point");
  }
  const renderMeta = toolWidgetDescriptorMeta(changesConfig, "show_changes");
  const renderUri = renderMeta._meta?.ui?.resourceUri;
  if (
    !/^ui:\/\/devspace\/workspace-app-[0-9a-f]{16}\.html$/.test(renderUri ?? "")
    || renderMeta._meta?.["openai/outputTemplate"] !== renderUri
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
  const anchorMeta = toolWidgetDescriptorMeta(changesConfig, "continuation-anchor");
  if (anchorMeta._meta?.ui?.resourceUri !== renderUri || anchorMeta._meta?.["openai/outputTemplate"] !== renderUri) {
    throw new Error("continuation_anchor must render the same revisioned Workspace App through the one explicit card entry point");
  }
  const enhancementSource = await readFile(
    new URL("../app/node_modules/@waishnav/devspace/dist/ui/assets/runtime-enhancements.js", import.meta.url),
    "utf8",
  );
  const enhancementCss = await readFile(
    new URL("../app/node_modules/@waishnav/devspace/dist/ui/assets/runtime-enhancements.css", import.meta.url),
    "utf8",
  );
  const featureToolsSource = await readFile(
    new URL("../app/node_modules/@waishnav/devspace/dist/feature-tools.js", import.meta.url),
    "utf8",
  );
  const serverSource = await readFile(
    new URL("../app/node_modules/@waishnav/devspace/dist/server.js", import.meta.url),
    "utf8",
  );
  const portableVersion = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version;
  if (!enhancementSource.includes(`DevSpace Portable ${portableVersion} · Protocol 1.5`)
      || !enhancementSource.includes("session_rollback")
      || !enhancementSource.includes("session_changes")) {
    throw new Error("session review, rollback, or version footer is missing from the Workspace App");
  }
  if (!enhancementSource.includes('const CONTINUATION_TOOLS = new Set(["continuation_anchor"]);')) {
    throw new Error("only continuation_anchor may render the continuation milestone mode");
  }
  if (!enhancementSource.includes('devspace-review-collapsed')) {
    throw new Error("review cards must support a compact collapsed state rather than leaving Applied patch permanently expanded");
  }
  if (!enhancementCss.includes('.tool-card.review.devspace-review-collapsed .tool-header')
      || !enhancementCss.includes('min-height:54px')) {
    throw new Error("collapsed review cards must shrink to the compact milestone-card scale");
  }
  if (!enhancementSource.includes('session_rollback')) {
    throw new Error("session rollback must be wired to a real Workspace App tool call instead of rendering a dead control");
  }
  if (!enhancementSource.includes('app.callServerTool({ name, arguments: args })')) {
    throw new Error("Workspace App actions must prefer the initialized Apps SDK callServerTool transport");
  }
  if (enhancementSource.includes('window.confirm(')) {
    throw new Error("rollback confirmation must remain inside the card because sandboxed Apps may suppress native modal dialogs");
  }
  if (!featureToolsSource.includes('...appToolMeta("review")')
      || !featureToolsSource.includes('...appToolMeta("write")')
      || !serverSource.includes('appToolMeta: (kind) => appCallableToolMeta(config, kind)')) {
    throw new Error("session_changes/session_rollback must be explicitly callable from the rendered App");
  }
  if (!enhancementSource.includes('review-loading-state') || !enhancementSource.includes('review-error-state')) {
    throw new Error("review preview must expose finite loading/error states instead of a permanent Loading review placeholder");
  }
  if (!enhancementSource.includes('8_000') || !enhancementSource.includes('Collapse and expand to retry')) {
    throw new Error("review loading must time out into a retryable state instead of spinning forever");
  }
  if (!/element\("details", \{ className: "devspace-operation-timeline" \}\)/.test(enhancementSource)
      || !enhancementSource.includes("operation-timeline-summary")) {
    throw new Error("operation history must be wrapped in a user-collapsible details card");
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
      singleContinuationCardEntry: true,
      invocationStatusMetadata: true,
      sessionReviewUi: true,
      compactReviewCollapse: true,
      appCallableRollback: true,
      finiteReviewLoading: true,
      collapsibleOperationHistory: true,
      versionFooter: true,
    }),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
