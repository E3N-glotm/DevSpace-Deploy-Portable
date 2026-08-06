import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DEVSPACE_PROTOCOL_VERSION, DEVSPACE_SERVER_VERSION, FEATURE_CATALOG } from "./capabilities.js";

export const pluginManifestSchema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://devspace.local/schemas/plugin-manifest-1.1.json",
    title: "DevSpace Plugin Manifest",
    type: "object",
    required: ["id", "version"],
    properties: {
        id: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]{0,63}$" },
        name: { type: "string" },
        description: { type: "string" },
        version: { type: "string", minLength: 1 },
        maturity: { enum: ["stable", "experimental", "deprecated"] },
        enabledByDefault: { type: "boolean" },
        skillRoots: { type: "array", items: { type: "string" } },
        dependencies: {
            type: "object",
            properties: {
                platforms: { type: "array", items: { type: "string" } },
                executables: { type: "array", items: { type: "string" } },
                optionalExecutables: { type: "array", items: { type: "string" } },
                environment: { type: "array", items: { type: "string" } },
                files: { type: "array", items: { type: "string" } },
            },
            additionalProperties: false,
        },
        tools: {
            type: "array",
            items: {
                type: "object",
                required: ["name"],
                properties: {
                    name: { type: "string", pattern: "^[a-zA-Z][a-zA-Z0-9_-]{0,63}$" },
                    title: { type: "string" },
                    description: { type: "string" },
                    maturity: { enum: ["stable", "experimental", "deprecated"] },
                    command: { type: "string" },
                    argv: { type: "array", minItems: 1, items: { type: "string" } },
                    env: { type: "object", additionalProperties: { type: ["string", "null"] } },
                    workingDirectory: { type: "string" },
                    tty: { type: "boolean" },
                    persistent: { type: "boolean" },
                    readOnly: { type: "boolean" },
                },
                oneOf: [
                    { required: ["command"], not: { required: ["argv"] } },
                    { required: ["argv"], not: { required: ["command"] } },
                ],
                additionalProperties: true,
            },
        },
    },
    additionalProperties: true,
};

export const permissionRulesSchema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://devspace.local/schemas/permission-rules-1.json",
    title: "DevSpace Permission Rules",
    type: "object",
    required: ["version", "defaultDecision", "rules"],
    properties: {
        version: { type: "integer", minimum: 1 },
        defaultDecision: { enum: ["allow", "deny", "audit"] },
        rules: {
            type: "array",
            items: {
                type: "object",
                required: ["id", "decision"],
                properties: {
                    id: { type: "string" },
                    description: { type: "string" },
                    enabled: { type: "boolean" },
                    executable: { type: "string" },
                    commandPattern: { type: "string" },
                    workspacePattern: { type: "string" },
                    argvPrefix: { type: "array", items: { type: "string" } },
                    decision: { enum: ["allow", "deny", "audit"] },
                },
                additionalProperties: false,
            },
        },
    },
    additionalProperties: false,
};

export const reservedPluginSlotSchema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://devspace.local/schemas/reserved-plugin-slot-1.json",
    title: "DevSpace Reserved Plugin Slot Binding",
    type: "object",
    required: ["slot", "pluginId", "pluginVersion", "contentHash", "toolName"],
    properties: {
        slot: { type: "integer", minimum: 1, maximum: 16 },
        pluginId: { type: "string" },
        pluginVersion: { type: "string" },
        contentHash: { type: "string", pattern: "^[0-9a-f]{64}$" },
        toolName: { type: "string" },
        readOnly: { type: "boolean" },
    },
    additionalProperties: false,
};

export function generateSchemaBundle(pluginManager) {
    return {
        generatedAt: new Date().toISOString(),
        protocolVersion: DEVSPACE_PROTOCOL_VERSION,
        serverVersion: DEVSPACE_SERVER_VERSION,
        featureCatalog: FEATURE_CATALOG,
        schemas: {
            pluginManifest: pluginManifestSchema,
            permissionRules: permissionRulesSchema,
            reservedPluginSlot: reservedPluginSlotSchema,
        },
        reservedPluginSlots: pluginManager.slots(),
        dynamicPluginTools: pluginManager.dynamicTools().map((tool) => ({
            name: tool.registeredName,
            pluginId: tool.pluginId,
            pluginVersion: tool.pluginVersion,
            maturity: tool.maturity,
            inputSchema: {
                type: "object",
                required: ["workspaceId"],
                properties: {
                    workspaceId: { type: "string" },
                    parameters: { type: "object", additionalProperties: true },
                    workingDirectory: { type: "string" },
                    processHandle: { type: "string" },
                },
            },
        })),
    };
}

export async function writeSchemaBundle(path, bundle) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
}
