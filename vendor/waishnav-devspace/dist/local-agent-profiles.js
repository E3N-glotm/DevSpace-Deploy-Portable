import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
export const LOCAL_AGENT_PROVIDERS = [
    "codex",
    "claude",
    "opencode",
    "pi",
    "cursor",
    "copilot",
];
const FRONTMATTER_DELIMITER = "---";
const PROVIDERS = new Set(LOCAL_AGENT_PROVIDERS);
export async function loadLocalAgentProfiles(config, workspaceRoot) {
    if (!config.subagents)
        return [];
    const profileDirs = [
        config.devspaceAgentsDir,
        join(workspaceRoot, ".devspace", "agents"),
    ];
    const profilesByName = new Map();
    for (const directory of profileDirs) {
        for (const profile of await loadProfilesFromDirectory(directory)) {
            profilesByName.set(profile.name, profile);
        }
    }
    return Array.from(profilesByName.values())
        .filter((profile) => !profile.disabled)
        .sort((a, b) => a.name.localeCompare(b.name));
}
export function summarizeLocalAgentProfile(profile) {
    return {
        name: profile.name,
        description: profile.description,
        provider: profile.provider,
        model: profile.model,
        thinking: profile.thinking,
    };
}
async function loadProfilesFromDirectory(directory) {
    const resolvedDirectory = resolve(directory);
    if (!existsSync(resolvedDirectory))
        return [];
    const entries = await readdir(resolvedDirectory, { withFileTypes: true });
    const profiles = [];
    for (const entry of entries) {
        if (!entry.isFile())
            continue;
        if (!entry.name.endsWith(".md"))
            continue;
        const filePath = join(resolvedDirectory, entry.name);
        try {
            profiles.push(await loadProfileFile(filePath));
        }
        catch (error) {
            console.warn(`Skipping invalid subagent profile ${filePath}: ${errorMessage(error)}`);
        }
    }
    return profiles;
}
async function loadProfileFile(filePath) {
    const content = await readFile(filePath, "utf8");
    const parsed = parseFrontmatter(content, filePath);
    return profileFromFrontmatter(parsed.frontmatter, parsed.body, filePath);
}
function parseFrontmatter(content, filePath) {
    const normalized = content.replace(/^\uFEFF/, "");
    const lines = normalized.split(/\r?\n/);
    if (lines[0]?.trim() !== FRONTMATTER_DELIMITER) {
        throw new Error(`Subagent profile is missing frontmatter: ${filePath}`);
    }
    const endIndex = lines.findIndex((line, index) => index > 0 && line.trim() === FRONTMATTER_DELIMITER);
    if (endIndex === -1) {
        throw new Error(`Subagent profile frontmatter is not closed: ${filePath}`);
    }
    return {
        frontmatter: parseProfileYaml(lines.slice(1, endIndex).join("\n"), filePath),
        body: lines.slice(endIndex + 1).join("\n").trim(),
    };
}
function parseProfileYaml(source, filePath) {
    let parsed;
    try {
        parsed = parseYaml(source) ?? {};
    }
    catch (error) {
        throw new Error(`Unable to parse subagent profile frontmatter: ${filePath}: ${errorMessage(error)}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`Subagent profile frontmatter must be a mapping: ${filePath}`);
    }
    return parsed;
}
function profileFromFrontmatter(frontmatter, body, filePath) {
    const name = readString(frontmatter, "name") ?? basename(filePath, ".md");
    const description = readString(frontmatter, "description");
    const provider = readProvider(frontmatter, filePath);
    if (!description) {
        throw new Error(`Subagent profile is missing description: ${filePath}`);
    }
    return {
        name,
        description,
        provider,
        model: readString(frontmatter, "model"),
        thinking: readString(frontmatter, "thinking"),
        filePath,
        body,
        disabled: frontmatter.disabled === true,
    };
}
function readProvider(frontmatter, filePath) {
    const provider = readString(frontmatter, "provider");
    if (!provider) {
        throw new Error(`Subagent profile is missing provider: ${filePath}`);
    }
    if (!PROVIDERS.has(provider)) {
        throw new Error(`Subagent profile provider must be codex, claude, opencode, pi, cursor, or copilot: ${filePath}`);
    }
    return provider;
}
export function isLocalAgentProvider(value) {
    return PROVIDERS.has(value);
}
function readString(frontmatter, key) {
    const value = frontmatter[key];
    if (typeof value !== "string")
        return undefined;
    const trimmed = value.trim();
    return trimmed || undefined;
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
