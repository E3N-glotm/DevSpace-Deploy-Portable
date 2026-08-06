import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
export class AccessDeniedError extends Error {
    constructor(message) {
        super(message);
        this.name = "AccessDeniedError";
    }
}
export function expandHomePath(path) {
    if (path === "~")
        return homedir();
    if (path.startsWith("~/") || path.startsWith("~\\")) {
        return resolve(homedir(), path.slice(2));
    }
    return path;
}
export function isPathInsideRoot(path, root) {
    const resolvedPath = resolve(expandHomePath(path));
    const resolvedRoot = resolve(expandHomePath(root));
    const relationship = relative(resolvedRoot, resolvedPath);
    return (relationship === "" ||
        (!isAbsolute(relationship) &&
            !relationship.startsWith("..") &&
            relationship !== ".." &&
            !relationship.includes(`..${sep}`)));
}
export function assertAllowedPath(path, allowedRoots) {
    const resolvedPath = resolve(expandHomePath(path));
    if (allowedRoots.some((root) => isPathInsideRoot(resolvedPath, root))) {
        return resolvedPath;
    }
    throw new AccessDeniedError(`Path is outside allowed roots: ${path}`);
}
export function resolveAllowedPath(inputPath, cwd, allowedRoots) {
    const absolutePath = resolve(cwd, inputPath);
    return assertAllowedPath(absolutePath, allowedRoots);
}
