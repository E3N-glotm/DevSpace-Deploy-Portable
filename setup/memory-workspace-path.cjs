"use strict";

const fs = require("node:fs");
const path = require("node:path");

// The UI may bind a Memory to a nested workspace, but must not expand the
// Portable installation's configured file-access roots.
function validateMemoryWorkspaceRoot(value, allowedRoots, dependencies = { fs, path }) {
  const { fs: filesystem, path: paths } = dependencies;
  const requested = String(value || "").trim();
  if (!requested || !paths.isAbsolute(requested)) {
    throw new Error("Memory workspace directory must be an absolute path.");
  }
  const workspace = paths.resolve(requested);
  if (!filesystem.existsSync(workspace) || !filesystem.statSync(workspace).isDirectory()) {
    throw new Error("Memory workspace directory must exist and be a directory.");
  }
  const physicalWorkspace = filesystem.realpathSync(workspace);
  const authorized = Array.isArray(allowedRoots) && allowedRoots.some(root => {
    if (typeof root !== "string" || !paths.isAbsolute(root)) return false;
    let physicalRoot;
    try {
      physicalRoot = filesystem.realpathSync(paths.resolve(root));
    } catch { return false; }
    const relative = paths.relative(physicalRoot, physicalWorkspace);
    return !relative || (relative !== ".." && !relative.startsWith(".." + paths.sep) &&
      !paths.isAbsolute(relative));
  });
  if (!authorized) {
    throw new Error("Memory workspace directory must be inside a configured allowed root.");
  }
  return workspace;
}

module.exports = { validateMemoryWorkspaceRoot };
