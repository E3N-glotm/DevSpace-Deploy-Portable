const migrations = [
    {
        version: 1,
        name: "workspace-state",
        up: migrateWorkspaceState,
    },
    {
        version: 2,
        name: "oauth-state",
        up: migrateOAuthState,
    },
    {
        version: 3,
        name: "local-agent-sessions",
        up: migrateLocalAgentSessions,
    },
    {
        version: 4,
        name: "persistent-process-registry",
        up: migratePersistentProcessRegistry,
    },
    {
        version: 5,
        name: "workspace-session-metadata",
        up: migrateWorkspaceSessionMetadata,
    },
    {
        version: 6,
        name: "events-structured-logs-diagnostics-watches",
        up: migrateStructuredRuntimeState,
    },
    {
        version: 7,
        name: "plugin-cache-and-state",
        up: migratePluginState,
    },
    {
        version: 8,
        name: "reserved-plugin-slots",
        up: migrateReservedPluginSlots,
    },
    {
        version: 9,
        name: "workspace-conversation-bindings",
        up: migrateWorkspaceConversationBindings,
    },
    {
        version: 10,
        name: "remote-workspace-backend",
        up: migrateRemoteWorkspaceBackend,
    },
    {
        version: 11,
        name: "remote-agent-enrollment-recovery",
        up: migrateRemoteAgentEnrollmentRecovery,
    },
    {
        version: 12,
        name: "remote-agent-access-model",
        up: migrateRemoteAgentAccessModel,
    },
    {
        version: 13,
        name: "continuation-task-controller",
        up: migrateContinuationTasks,
    },
];
export function migrateDatabase(sqlite) {
    const migrate = sqlite.transaction(() => {
        sqlite.exec(`
      create table if not exists devspace_schema_migrations (
        version integer primary key,
        name text not null,
        applied_at text not null
      );
    `);
        const applied = new Set(sqlite.prepare("select version from devspace_schema_migrations").all().map((row) => row.version));
        const recordMigration = sqlite.prepare("insert into devspace_schema_migrations (version, name, applied_at) values (?, ?, ?)");
        for (const migration of migrations) {
            if (applied.has(migration.version))
                continue;
            migration.up(sqlite);
            recordMigration.run(migration.version, migration.name, new Date().toISOString());
        }
    });
    migrate.immediate();
}
function migrateWorkspaceState(sqlite) {
    sqlite.exec(`
    create table if not exists workspace_sessions (
      id text primary key,
      root text not null,
      status text not null default 'active',
      mode text not null default 'checkout',
      source_root text,
      base_ref text,
      base_sha text,
      managed text not null default 'false',
      created_at text not null,
      last_used_at text not null
    );

    create index if not exists workspace_sessions_root_idx
      on workspace_sessions(root, last_used_at desc);

    create index if not exists workspace_sessions_status_idx
      on workspace_sessions(status, last_used_at desc);

    create table if not exists loaded_agent_files (
      workspace_session_id text not null,
      path text not null,
      content_hash text not null,
      content text not null,
      loaded_at text not null,
      last_seen_at text not null,
      primary key (workspace_session_id, path),
      foreign key (workspace_session_id)
        references workspace_sessions(id)
        on delete cascade
    );

    create index if not exists loaded_agent_files_path_idx
      on loaded_agent_files(path);
  `);
    addColumnIfMissing(sqlite, "workspace_sessions", "mode", "text not null default 'checkout'");
    addColumnIfMissing(sqlite, "workspace_sessions", "source_root", "text");
    addColumnIfMissing(sqlite, "workspace_sessions", "base_ref", "text");
    addColumnIfMissing(sqlite, "workspace_sessions", "base_sha", "text");
    addColumnIfMissing(sqlite, "workspace_sessions", "managed", "text not null default 'false'");
}
function migrateOAuthState(sqlite) {
    sqlite.exec(`
    create table if not exists oauth_clients (
      client_id text primary key,
      client_json text not null,
      issued_at integer not null
    );

    create index if not exists oauth_clients_issued_at_idx
      on oauth_clients(issued_at desc);

    create table if not exists oauth_access_tokens (
      token_hash text primary key,
      client_id text not null,
      scopes_json text not null,
      expires_at integer not null,
      resource text,
      foreign key (client_id) references oauth_clients(client_id) on delete cascade
    );

    create index if not exists oauth_access_tokens_client_id_idx
      on oauth_access_tokens(client_id);

    create index if not exists oauth_access_tokens_expires_at_idx
      on oauth_access_tokens(expires_at);

    create table if not exists oauth_refresh_tokens (
      token_hash text primary key,
      client_id text not null,
      scopes_json text not null,
      expires_at integer not null,
      resource text,
      foreign key (client_id) references oauth_clients(client_id) on delete cascade
    );

    create index if not exists oauth_refresh_tokens_client_id_idx
      on oauth_refresh_tokens(client_id);

    create index if not exists oauth_refresh_tokens_expires_at_idx
      on oauth_refresh_tokens(expires_at);
  `);
}
function migrateLocalAgentSessions(sqlite) {
    sqlite.exec(`
    create table if not exists local_agent_sessions (
      id text primary key,
      workspace_id text,
      workspace_root text not null,
      profile_name text not null,
      provider text not null,
      model text,
      thinking text,
      provider_session_id text,
      status text not null,
      latest_response text,
      error text,
      created_at text not null,
      updated_at text not null
    );

    create index if not exists local_agent_sessions_workspace_id_idx
      on local_agent_sessions(workspace_id, updated_at desc);

    create index if not exists local_agent_sessions_workspace_root_idx
      on local_agent_sessions(workspace_root, updated_at desc);

    create index if not exists local_agent_sessions_provider_session_id_idx
      on local_agent_sessions(provider_session_id);
  `);
    addColumnIfMissing(sqlite, "local_agent_sessions", "thinking", "text");
}
function migratePersistentProcessRegistry(sqlite) {
    sqlite.exec(`
    create table if not exists process_registry (
      handle text primary key,
      workspace_id text not null,
      workspace_root text not null,
      legacy_session_id integer,
      command_json text,
      shell_command text,
      cwd text not null,
      env_json text,
      tty integer not null default 0,
      persistent integer not null default 0,
      pid integer,
      status text not null,
      exit_code integer,
      signal text,
      owner_instance_id text,
      started_at text not null,
      updated_at text not null,
      completed_at text
    );

    create index if not exists process_registry_workspace_idx
      on process_registry(workspace_id, updated_at desc);

    create index if not exists process_registry_status_idx
      on process_registry(status, updated_at desc);

    create index if not exists process_registry_pid_idx
      on process_registry(pid);
  `);
}
function migrateWorkspaceSessionMetadata(sqlite) {
    addColumnIfMissing(sqlite, "workspace_sessions", "title", "text");
    addColumnIfMissing(sqlite, "workspace_sessions", "git_sha", "text");
    addColumnIfMissing(sqlite, "workspace_sessions", "git_branch", "text");
    addColumnIfMissing(sqlite, "workspace_sessions", "git_origin_url", "text");
    addColumnIfMissing(sqlite, "workspace_sessions", "archived_at", "text");
    sqlite.exec(`
    create index if not exists workspace_sessions_git_sha_idx
      on workspace_sessions(git_sha);
  `);
}
function migrateStructuredRuntimeState(sqlite) {
    sqlite.exec(`
    create table if not exists event_journal (
      sequence integer primary key autoincrement,
      kind text not null,
      subject text,
      workspace_id text,
      payload_json text not null,
      created_at text not null
    );

    create index if not exists event_journal_kind_sequence_idx
      on event_journal(kind, sequence);

    create index if not exists event_journal_subject_sequence_idx
      on event_journal(subject, sequence);

    create table if not exists structured_tool_calls (
      id integer primary key autoincrement,
      request_id text,
      tool text not null,
      workspace_id text,
      process_handle text,
      success integer not null,
      duration_ms integer,
      exit_code integer,
      signal text,
      details_json text not null,
      created_at text not null
    );

    create index if not exists structured_tool_calls_tool_created_idx
      on structured_tool_calls(tool, created_at desc);

    create index if not exists structured_tool_calls_workspace_created_idx
      on structured_tool_calls(workspace_id, created_at desc);

    create table if not exists diagnostic_runs (
      id text primary key,
      overall_status text not null,
      summary_json text not null,
      suggested_fixes_json text not null,
      created_at text not null
    );

    create table if not exists diagnostic_checks (
      run_id text not null,
      check_id text not null,
      category text not null,
      status text not null,
      summary text not null,
      details_json text not null,
      remediation text,
      primary key (run_id, check_id),
      foreign key (run_id) references diagnostic_runs(id) on delete cascade
    );

    create index if not exists diagnostic_checks_status_idx
      on diagnostic_checks(status, category);

    create table if not exists file_watches (
      watch_id text primary key,
      workspace_id text not null,
      path text not null,
      recursive integer not null default 1,
      status text not null,
      created_at text not null,
      updated_at text not null
    );

    create index if not exists file_watches_workspace_idx
      on file_watches(workspace_id, status);
  `);
}
function migratePluginState(sqlite) {
    sqlite.exec(`
    create table if not exists plugin_versions (
      plugin_id text not null,
      version text not null,
      manifest_path text not null,
      manifest_json text not null,
      content_hash text not null,
      maturity text not null,
      discovered_at text not null,
      last_seen_at text not null,
      primary key (plugin_id, version)
    );

    create index if not exists plugin_versions_seen_idx
      on plugin_versions(last_seen_at desc);

    create table if not exists plugin_state (
      plugin_id text primary key,
      enabled integer not null default 0,
      selected_version text,
      updated_at text not null
    );
  `);
}
function migrateReservedPluginSlots(sqlite) {
    sqlite.exec(`
    create table if not exists plugin_slots (
      slot integer primary key check (slot between 1 and 16),
      plugin_id text not null,
      plugin_version text not null,
      plugin_content_hash text not null,
      tool_name text not null,
      read_only integer not null default 0,
      created_at text not null,
      updated_at text not null,
      foreign key (plugin_id) references plugin_state(plugin_id) on delete cascade
    );

    create index if not exists plugin_slots_plugin_idx
      on plugin_slots(plugin_id, tool_name);
  `);
}
function migrateWorkspaceConversationBindings(sqlite) {
    sqlite.exec(`
    create table if not exists workspace_conversation_bindings (
      conversation_scope_id text not null,
      target_key text not null,
      workspace_session_id text not null,
      created_at text not null,
      last_used_at text not null,
      primary key (conversation_scope_id, target_key),
      foreign key (workspace_session_id)
        references workspace_sessions(id)
        on delete cascade
    );

    create index if not exists workspace_conversation_bindings_workspace_idx
      on workspace_conversation_bindings(workspace_session_id);
  `);
}
function migrateRemoteWorkspaceBackend(sqlite) {
    addColumnIfMissing(sqlite, "workspace_sessions", "backend", "text not null default 'local'");
    addColumnIfMissing(sqlite, "workspace_sessions", "backend_id", "text");
    sqlite.exec(`
    create index if not exists workspace_sessions_backend_idx
      on workspace_sessions(backend, backend_id, last_used_at desc);

    create table if not exists remote_agents (
      id text primary key,
      name text not null,
      secret_hash text not null,
      status text not null default 'offline',
      allowed_roots_json text not null,
      hostname text,
      platform text,
      agent_version text,
      capabilities_json text not null default '{}',
      metadata_json text not null default '{}',
      created_at text not null,
      connected_at text,
      last_seen_at text,
      revoked_at text
    );

    create index if not exists remote_agents_name_idx on remote_agents(name);
    create index if not exists remote_agents_status_idx on remote_agents(status, last_seen_at desc);

    create table if not exists remote_agent_enrollments (
      token_hash text primary key,
      name text not null,
      allowed_roots_json text not null,
      expires_at text not null,
      created_at text not null,
      used_at text,
      agent_id text
    );

    create index if not exists remote_agent_enrollments_expires_idx
      on remote_agent_enrollments(expires_at);
  `);
}
function migrateRemoteAgentEnrollmentRecovery(sqlite) {
    addColumnIfMissing(sqlite, "remote_agent_enrollments", "agent_id", "text");
    sqlite.exec(`
    create index if not exists remote_agent_enrollments_agent_id_idx
      on remote_agent_enrollments(agent_id);
  `);
}
function migrateRemoteAgentAccessModel(sqlite) {
    addColumnIfMissing(sqlite, "remote_agents", "access_mode", "text not null default 'scoped'");
    addColumnIfMissing(sqlite, "remote_agents", "install_root", "text");
    addColumnIfMissing(sqlite, "remote_agent_enrollments", "access_mode", "text not null default 'scoped'");
    addColumnIfMissing(sqlite, "remote_agent_enrollments", "install_root", "text");
}
function migrateContinuationTasks(sqlite) {
    sqlite.exec(`
    create table if not exists continuation_tasks (
      id text primary key,
      conversation_scope_id text not null,
      workspace_id text,
      objective text not null,
      state text not null,
      required_milestones_json text not null default '[]',
      completed_milestones_json text not null default '[]',
      evidence_json text not null default '{}',
      progress_fingerprint text,
      failure_fingerprint text,
      continuation_count integer not null default 0,
      no_progress_count integer not null default 0,
      same_failure_count integer not null default 0,
      max_continuations integer not null default 5,
      max_no_progress integer not null default 2,
      max_same_failure integer not null default 2,
      continuation_pending integer not null default 0,
      waiting_reason text,
      terminal_reason text,
      deadline_at text,
      turn_started_at text,
      last_continuation_at text,
      created_at text not null,
      updated_at text not null
    );

    create index if not exists continuation_tasks_workspace_state_idx
      on continuation_tasks(conversation_scope_id, workspace_id, state, updated_at desc);

    create index if not exists continuation_tasks_state_updated_idx
      on continuation_tasks(state, updated_at desc);
  `);
}
function addColumnIfMissing(sqlite, table, column, definition) {
    const columns = sqlite.prepare(`pragma table_info(${table})`).all();
    if (columns.some((existingColumn) => existingColumn.name === column))
        return;
    sqlite.exec(`alter table ${table} add column ${column} ${definition}`);
}
