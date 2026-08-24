import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
export const workspaceSessions = sqliteTable("workspace_sessions", {
    id: text("id").primaryKey(),
    root: text("root").notNull(),
    status: text("status").notNull().default("active"),
    mode: text("mode").notNull().default("checkout"),
    sourceRoot: text("source_root"),
    baseRef: text("base_ref"),
    baseSha: text("base_sha"),
    managed: text("managed").notNull().default("false"),
    title: text("title"),
    gitSha: text("git_sha"),
    gitBranch: text("git_branch"),
    gitOriginUrl: text("git_origin_url"),
    backend: text("backend").notNull().default("local"),
    backendId: text("backend_id"),
    archivedAt: text("archived_at"),
    createdAt: text("created_at").notNull(),
    lastUsedAt: text("last_used_at").notNull(),
}, (table) => [
    index("workspace_sessions_root_idx").on(table.root, table.lastUsedAt),
    index("workspace_sessions_status_idx").on(table.status, table.lastUsedAt),
]);
export const remoteAgents = sqliteTable("remote_agents", {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    secretHash: text("secret_hash").notNull(),
    status: text("status").notNull().default("offline"),
    allowedRootsJson: text("allowed_roots_json").notNull(),
    accessMode: text("access_mode").notNull().default("scoped"),
    installRoot: text("install_root"),
    hostname: text("hostname"),
    platform: text("platform"),
    agentVersion: text("agent_version"),
    capabilitiesJson: text("capabilities_json").notNull().default("{}"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: text("created_at").notNull(),
    connectedAt: text("connected_at"),
    lastSeenAt: text("last_seen_at"),
    revokedAt: text("revoked_at"),
}, (table) => [
    index("remote_agents_name_idx").on(table.name),
    index("remote_agents_status_idx").on(table.status, table.lastSeenAt),
]);
export const remoteAgentEnrollments = sqliteTable("remote_agent_enrollments", {
    tokenHash: text("token_hash").primaryKey(),
    name: text("name").notNull(),
    allowedRootsJson: text("allowed_roots_json").notNull(),
    accessMode: text("access_mode").notNull().default("scoped"),
    installRoot: text("install_root"),
    expiresAt: text("expires_at").notNull(),
    createdAt: text("created_at").notNull(),
    usedAt: text("used_at"),
    agentId: text("agent_id"),
}, (table) => [
    index("remote_agent_enrollments_expires_idx").on(table.expiresAt),
    index("remote_agent_enrollments_agent_id_idx").on(table.agentId),
]);
export const loadedAgentFiles = sqliteTable("loaded_agent_files", {
    workspaceSessionId: text("workspace_session_id")
        .notNull()
        .references(() => workspaceSessions.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    contentHash: text("content_hash").notNull(),
    content: text("content").notNull(),
    loadedAt: text("loaded_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
}, (table) => [
    primaryKey({ columns: [table.workspaceSessionId, table.path] }),
    index("loaded_agent_files_path_idx").on(table.path),
]);
export const workspaceConversationBindings = sqliteTable("workspace_conversation_bindings", {
    conversationScopeId: text("conversation_scope_id").notNull(),
    targetKey: text("target_key").notNull(),
    workspaceSessionId: text("workspace_session_id")
        .notNull()
        .references(() => workspaceSessions.id, { onDelete: "cascade" }),
    createdAt: text("created_at").notNull(),
    lastUsedAt: text("last_used_at").notNull(),
}, (table) => [
    primaryKey({ columns: [table.conversationScopeId, table.targetKey] }),
    index("workspace_conversation_bindings_workspace_idx").on(table.workspaceSessionId),
]);
export const oauthClients = sqliteTable("oauth_clients", {
    clientId: text("client_id").primaryKey(),
    clientJson: text("client_json").notNull(),
    issuedAt: integer("issued_at").notNull(),
});
export const oauthAccessTokens = sqliteTable("oauth_access_tokens", {
    tokenHash: text("token_hash").primaryKey(),
    clientId: text("client_id")
        .notNull()
        .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    scopesJson: text("scopes_json").notNull(),
    expiresAt: integer("expires_at").notNull(),
    resource: text("resource"),
});
export const oauthRefreshTokens = sqliteTable("oauth_refresh_tokens", {
    tokenHash: text("token_hash").primaryKey(),
    clientId: text("client_id")
        .notNull()
        .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    scopesJson: text("scopes_json").notNull(),
    expiresAt: integer("expires_at").notNull(),
    resource: text("resource"),
});
export const localAgentSessions = sqliteTable("local_agent_sessions", {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id"),
    workspaceRoot: text("workspace_root").notNull(),
    profileName: text("profile_name").notNull(),
    provider: text("provider").notNull(),
    model: text("model"),
    thinking: text("thinking"),
    providerSessionId: text("provider_session_id"),
    status: text("status").notNull(),
    latestResponse: text("latest_response"),
    error: text("error"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
}, (table) => [
    index("local_agent_sessions_workspace_id_idx").on(table.workspaceId, table.updatedAt),
    index("local_agent_sessions_workspace_root_idx").on(table.workspaceRoot, table.updatedAt),
    index("local_agent_sessions_provider_session_id_idx").on(table.providerSessionId),
]);
export const pluginSlots = sqliteTable("plugin_slots", {
    slot: integer("slot").primaryKey(),
    pluginId: text("plugin_id").notNull(),
    pluginVersion: text("plugin_version").notNull(),
    pluginContentHash: text("plugin_content_hash").notNull(),
    toolName: text("tool_name").notNull(),
    readOnly: integer("read_only").notNull().default(0),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
}, (table) => [
    index("plugin_slots_plugin_idx").on(table.pluginId, table.toolName),
]);
