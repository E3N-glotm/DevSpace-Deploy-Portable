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
    {
        version: 14,
        name: "continuation-app-coordinator-observability",
        up: migrateContinuationCoordinatorObservability,
    },
    {
        version: 15,
        name: "continuation-host-budget-learning",
        up: migrateContinuationHostBudgetLearning,
    },
    {
        version: 16,
        name: "continuation-owner-controls",
        up: migrateContinuationOwnerControls,
    },
    {
        version: 17,
        name: "continuation-model-activity-watchdog",
        up: migrateContinuationModelActivityWatchdog,
    },
    {
        version: 18,
        name: "continuation-explicit-long-task-mode",
        up: migrateContinuationExplicitLongTaskMode,
    },
    {
        version: 19,
        name: "continuation-strict-trigger-modes",
        up: migrateContinuationStrictTriggerModes,
    },
    {
        version: 20,
        name: "continuation-confirmed-turn-limit",
        up: migrateContinuationConfirmedTurnLimit,
    },
    {
        version: 21,
        name: "continuation-task-contract-turn-lease",
        up: migrateContinuationTaskContractTurnLease,
    },
    {
        version: 22,
        name: "continuation-completion-driven-unbounded",
        up: migrateContinuationCompletionDrivenUnbounded,
    },
    {
        version: 23,
        name: "continuation-stall-detector-host-regimes",
        up: migrateContinuationStallDetectorHostRegimes,
    },
    {
        version: 24,
        name: "continuation-delivery-readiness-backoff",
        up: migrateContinuationDeliveryReadinessBackoff,
    },
    {
        version: 25,
        name: "continuation-conversation-singleton",
        up: migrateContinuationConversationSingleton,
    },
    {
        version: 26,
        name: "continuation-manual-takeover-and-singleton-repair",
        up: migrateContinuationManualTakeoverAndSingletonRepair,
    },
    {
        version: 27,
        name: "continuation-verified-anchor-mount",
        up: migrateContinuationVerifiedAnchorMount,
    },
    {
        version: 28,
        name: "continuation-anchor-generation-turn-fingerprint",
        up: migrateContinuationAnchorGenerationTurnFingerprint,
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
function migrateContinuationCoordinatorObservability(sqlite) {
    addColumnIfMissing(sqlite, "continuation_tasks", "last_activity_at", "text");
    addColumnIfMissing(sqlite, "continuation_tasks", "last_ui_heartbeat_at", "text");
    addColumnIfMissing(sqlite, "continuation_tasks", "last_send_attempt_at", "text");
    addColumnIfMissing(sqlite, "continuation_tasks", "last_send_result", "text");
    addColumnIfMissing(sqlite, "continuation_tasks", "coordinator_instance_id", "text");
}
function migrateContinuationHostBudgetLearning(sqlite) {
    addColumnIfMissing(sqlite, "continuation_tasks", "host_profile_id", "text");
    addColumnIfMissing(sqlite, "continuation_tasks", "observed_turn_budget_ms", "integer");
    addColumnIfMissing(sqlite, "continuation_tasks", "recommended_continue_after_ms", "integer");
    addColumnIfMissing(sqlite, "continuation_tasks", "host_timeout_samples", "integer not null default 0");
    addColumnIfMissing(sqlite, "continuation_tasks", "last_host_signal", "text");
    addColumnIfMissing(sqlite, "continuation_tasks", "last_host_signal_at", "text");
    addColumnIfMissing(sqlite, "continuation_tasks", "watch_process_handles_json", "text not null default '[]'");
    sqlite.exec(`
    create table if not exists continuation_host_profiles (
      id text primary key,
      observed_turn_budget_ms integer,
      recommended_continue_after_ms integer,
      timeout_samples integer not null default 0,
      last_timeout_at text,
      last_signal text,
      last_signal_at text,
      created_at text not null,
      updated_at text not null
    );

    create index if not exists continuation_host_profiles_updated_idx
      on continuation_host_profiles(updated_at desc);
  `);
}
function migrateContinuationOwnerControls(sqlite) {
    addColumnIfMissing(sqlite, "continuation_tasks", "owner_locked", "integer not null default 0");
    addColumnIfMissing(sqlite, "continuation_tasks", "owner_locked_at", "text");
    addColumnIfMissing(sqlite, "continuation_tasks", "owner_control_note", "text");
    sqlite.exec(`
    create index if not exists continuation_tasks_owner_locked_idx
      on continuation_tasks(owner_locked, state, updated_at desc);
  `);
}
function migrateContinuationModelActivityWatchdog(sqlite) {
    addColumnIfMissing(sqlite, "continuation_tasks", "last_model_activity_at", "text");
    sqlite.exec(`
    update continuation_tasks
      set last_model_activity_at=coalesce(last_model_activity_at, turn_started_at, last_activity_at, created_at)
      where last_model_activity_at is null;

    create index if not exists continuation_tasks_model_activity_idx
      on continuation_tasks(state, last_model_activity_at desc);
  `);
}
function migrateContinuationExplicitLongTaskMode(sqlite) {
    // Compatibility-created tasks must stay conservative: only an explicit
    // continuation_anchor/begin upgrades a task into the mode that is allowed
    // to recover a silent host truncation without a timeout event.
    addColumnIfMissing(sqlite, "continuation_tasks", "continuation_mode", "text not null default 'compat'");
    sqlite.exec(`
    create index if not exists continuation_tasks_mode_state_idx
      on continuation_tasks(continuation_mode, state, updated_at desc);
  `);
}
function migrateContinuationStrictTriggerModes(sqlite) {
    // 1.1.48 briefly used "explicit-long" as a broad automatic-continuation
    // mode. Convert it to the fail-closed timeout-recovery policy and discard
    // any stale process-wake lease: process/stage wakes are now reserved for an
    // explicitly user-authorized resident/monitor task.
    addColumnIfMissing(sqlite, "continuation_tasks", "continuation_mode", "text not null default 'compat'");
    sqlite.exec(`
      update continuation_tasks
      set continuation_mode='timeout-recovery',
          watch_process_handles_json='[]',
          continuation_pending=case when continuation_pending in (2,3,4) then 0 else continuation_pending end
      where continuation_mode='explicit-long';

      update continuation_tasks
      set continuation_mode='compat'
      where continuation_mode not in ('compat','timeout-recovery','resident');
    `);
}
function migrateContinuationConfirmedTurnLimit(sqlite) {
    // The Apps SDK does not expose a standard assistant-turn deadline and its
    // resource-teardown notification carries no reason. Store an explicitly
    // confirmed lower bound so a teardown can be classified as time-limit
    // ending only after that bound has actually elapsed. This value never
    // drives a proactive timer.
    addColumnIfMissing(sqlite, "continuation_tasks", "confirmed_turn_limit_ms", "integer");
    addColumnIfMissing(sqlite, "continuation_tasks", "confirmed_turn_limit_at", "text");
    addColumnIfMissing(sqlite, "continuation_tasks", "confirmed_turn_limit_source", "text");
    addColumnIfMissing(sqlite, "continuation_host_profiles", "confirmed_turn_limit_ms", "integer");
    addColumnIfMissing(sqlite, "continuation_host_profiles", "confirmed_turn_limit_at", "text");
    addColumnIfMissing(sqlite, "continuation_host_profiles", "confirmed_turn_limit_source", "text");
}
function migrateContinuationTaskContractTurnLease(sqlite) {
    // 1.1.50 makes continuation state a conversation+workspace task contract
    // instead of an optional empty guard.  Source/lease metadata is persisted
    // so the control center can explain who created a task and so a recreated
    // Workspace App can refresh the same recovery sender without shadow tasks.
    addColumnIfMissing(sqlite, "continuation_tasks", "task_source", "text not null default 'legacy'");
    addColumnIfMissing(sqlite, "continuation_tasks", "source_tool", "text");
    addColumnIfMissing(sqlite, "continuation_tasks", "contract_version", "integer not null default 0");
    addColumnIfMissing(sqlite, "continuation_tasks", "auto_created", "integer not null default 0");
    addColumnIfMissing(sqlite, "continuation_tasks", "substantive_activity_count", "integer not null default 0");
    addColumnIfMissing(sqlite, "continuation_tasks", "turn_lease_id", "text");
    addColumnIfMissing(sqlite, "continuation_tasks", "last_anchor_mounted_at", "text");
    addColumnIfMissing(sqlite, "continuation_tasks", "anchor_lease_expires_at", "text");
    sqlite.exec(`
      create index if not exists continuation_tasks_source_state_idx
        on continuation_tasks(task_source, state, updated_at desc);

      update continuation_tasks
      set task_source=case
            when task_source is null or trim(task_source)='' then 'legacy'
            else task_source
          end,
          contract_version=case
            when contract_version is null then 0
            else contract_version
          end,
          auto_created=coalesce(auto_created, 0),
          substantive_activity_count=coalesce(substantive_activity_count, 0);

      update continuation_tasks
      set task_source='legacy-auto', auto_created=1
      where task_source='legacy'
        and continuation_mode='compat'
        and required_milestones_json='[]'
        and objective like 'Continue the current DevSpace work%';
    `);
}
function migrateContinuationVerifiedAnchorMount(sqlite) {
    // `last_anchor_mounted_at` predates a trustworthy UI acknowledgement.  It
    // could be written by the model-side continuation_anchor invocation itself
    // and, historically, by any Workspace App heartbeat.  Keep the legacy
    // columns for diagnostics, but never backfill the new verified field from
    // them: an existing conversation must prove that the actual continuation
    // iframe initialized before the server treats the one-card precondition as
    // satisfied.
    addColumnIfMissing(sqlite, "continuation_tasks", "anchor_mount_verified_at", "text");
    addColumnIfMissing(sqlite, "continuation_tasks", "anchor_mount_token", "text");
    addColumnIfMissing(sqlite, "continuation_tasks", "anchor_mount_requested_at", "text");
    addColumnIfMissing(sqlite, "continuation_tasks", "anchor_mount_coordinator_id", "text");
    sqlite.exec(`
      create index if not exists continuation_tasks_anchor_verified_idx
        on continuation_tasks(anchor_mount_verified_at, state, updated_at desc);
    `);
}
function migrateContinuationAnchorGenerationTurnFingerprint(sqlite) {
    // An Apps SDK tool result may be accepted into chat history without the
    // Host ever initializing its iframe.  Track a monotonically increasing
    // anchor generation plus a privacy-preserving Host-turn fingerprint so a
    // later assistant turn can recover an unmounted (ghost) issuance on the
    // same lifetime task.  The raw Host trace id is never persisted.
    addColumnIfMissing(sqlite, "continuation_tasks", "anchor_mount_generation", "integer not null default 0");
    addColumnIfMissing(sqlite, "continuation_tasks", "anchor_mount_host_turn_hash", "text");
    sqlite.exec(`
      update continuation_tasks
      set anchor_mount_generation=case
            when coalesce(anchor_mount_generation,0) > 0 then anchor_mount_generation
            when anchor_mount_requested_at is not null then 1
            else 0
          end;

      create index if not exists continuation_tasks_anchor_generation_idx
        on continuation_tasks(anchor_mount_verified_at, anchor_mount_generation, anchor_mount_requested_at);
    `);
}
function migrateContinuationCompletionDrivenUnbounded(sqlite) {
    // 1.1.50 Task Contracts are completion-driven: while required milestones
    // remain, the task owns a renewable model Turn Lease and may recover a
    // prematurely-ended assistant turn.  Continuation-count and wall-clock
    // budgets default to unlimited (0 / NULL) and are no longer terminal gates
    // unless an owner/model explicitly supplies a positive budget.
    addColumnIfMissing(sqlite, "continuation_tasks", "turn_lease_expires_at", "text");
    sqlite.exec(`
      update continuation_tasks
      set continuation_mode='completion-driven',
          max_continuations=0,
          deadline_at=null,
          turn_lease_expires_at=coalesce(
            turn_lease_expires_at,
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+3 minutes')
          ),
          task_source=case
            when contract_version=0 and task_source='legacy' then 'migrated-1.1.49'
            else task_source
          end,
          contract_version=case when contract_version < 1 then 1 else contract_version end
      where state not in ('SUCCEEDED','FAILED_TERMINAL','CANCELLED_BY_USER','ABORTED_NO_PROGRESS','BUDGET_EXHAUSTED','ABANDONED_AUTO_TASK')
        and (
          (contract_version >= 1 and task_source in ('auto-conversation','model-refined'))
          or (
            contract_version=0
            and task_source='legacy'
            and continuation_mode='timeout-recovery'
            and coalesce(required_milestones_json,'[]') <> '[]'
          )
        );

      create index if not exists continuation_tasks_turn_lease_idx
        on continuation_tasks(continuation_mode, state, turn_lease_expires_at);
    `);
}
function migrateContinuationStallDetectorHostRegimes(sqlite) {
    // A model-activity lease is only a weak liveness hint.  Expiry must move an
    // unfinished completion-driven task into SUSPECTED_STALL first; a later,
    // independent Workspace App heartbeat can corroborate the suspicion before
    // the server exposes CONTINUATION_ARMED.  This prevents a long model think
    // with no MCP calls from being treated as a definitive assistant-turn end.
    addColumnIfMissing(sqlite, "continuation_tasks", "stall_state", "text not null default 'ACTIVE'");
    addColumnIfMissing(sqlite, "continuation_tasks", "stall_suspected_at", "text");
    addColumnIfMissing(sqlite, "continuation_tasks", "stall_probe_count", "integer not null default 0");
    addColumnIfMissing(sqlite, "continuation_tasks", "stall_last_probe_at", "text");
    addColumnIfMissing(sqlite, "continuation_tasks", "stall_armed_at", "text");
    addColumnIfMissing(sqlite, "continuation_tasks", "stall_evidence", "text");

    // Host cutoff values are a current regime estimate, not a permanent
    // monotonic lower bound.  Keep a small authoritative timeout sample window
    // so shorter (or, after corroboration, longer) ChatGPT host regimes can be
    // learned without baking a product-specific minute limit into DevSpace.
    addColumnIfMissing(sqlite, "continuation_host_profiles", "cutoff_samples_json", "text not null default '[]'");
    addColumnIfMissing(sqlite, "continuation_host_profiles", "cutoff_epoch", "integer not null default 0");
    addColumnIfMissing(sqlite, "continuation_host_profiles", "cutoff_regime_changed_at", "text");
    addColumnIfMissing(sqlite, "continuation_tasks", "cutoff_samples_json", "text not null default '[]'");
    addColumnIfMissing(sqlite, "continuation_tasks", "cutoff_epoch", "integer not null default 0");
    addColumnIfMissing(sqlite, "continuation_tasks", "cutoff_regime_changed_at", "text");

    sqlite.exec(`
      update continuation_tasks
      set stall_state=case
            when continuation_mode='completion-driven' and state='RUNNING' then 'ACTIVE'
            else coalesce(nullif(stall_state,''), 'ACTIVE')
          end,
          stall_probe_count=coalesce(stall_probe_count, 0),
          cutoff_samples_json=coalesce(nullif(cutoff_samples_json,''), '[]'),
          cutoff_epoch=coalesce(cutoff_epoch, 0);

      update continuation_host_profiles
      set cutoff_samples_json=coalesce(nullif(cutoff_samples_json,''), '[]'),
          cutoff_epoch=coalesce(cutoff_epoch, 0);

      create index if not exists continuation_tasks_stall_state_idx
        on continuation_tasks(continuation_mode, state, stall_state, updated_at desc);
    `);
}
function migrateContinuationDeliveryReadinessBackoff(sqlite) {
    // app.sendMessage acceptance only proves that the Host accepted a synthetic
    // continuation message. It does not prove that the newly-created model turn
    // has already rehydrated its MCP connector. Persist the post-delivery ACK
    // retry schedule so a surviving Workspace App can retry the same logical
    // continuation with bounded exponential backoff until a model-side status
    // call proves DevSpace connectivity.
    addColumnIfMissing(sqlite, "continuation_tasks", "delivery_ack_started_at", "text");
    addColumnIfMissing(sqlite, "continuation_tasks", "delivery_ack_retry_count", "integer not null default 0");
    addColumnIfMissing(sqlite, "continuation_tasks", "delivery_ack_retry_after_at", "text");
    sqlite.exec(`
      update continuation_tasks
      set delivery_ack_started_at=case
            when continuation_pending in (4,5) then coalesce(delivery_ack_started_at, last_send_attempt_at)
            else delivery_ack_started_at
          end,
          delivery_ack_retry_count=case
            when continuation_pending in (4,5) and coalesce(delivery_ack_retry_count,0)=0 then 1
            else coalesce(delivery_ack_retry_count,0)
          end,
          delivery_ack_retry_after_at=case
            when continuation_pending in (4,5) and delivery_ack_retry_after_at is null and last_send_attempt_at is not null
              then strftime('%Y-%m-%dT%H:%M:%fZ', last_send_attempt_at, '+15 seconds')
            else delivery_ack_retry_after_at
          end;

      create index if not exists continuation_tasks_delivery_ack_idx
        on continuation_tasks(continuation_pending, delivery_ack_retry_after_at);
    `);
}
function migrateContinuationConversationSingleton(sqlite) {
    // ChatGPT conversation scope is the durable Task Contract identity.  A
    // conversation may move between DevSpace workspaces, but that must not
    // create multiple active software tasks.  Reconcile old 1.1.50 duplicates
    // first, then let SQLite enforce the invariant for all real v1/* scopes.
    sqlite.exec(`
      with ranked as (
        select id,
          row_number() over (
            partition by conversation_scope_id
            order by
              case task_source
                when 'model-refined' then 60
                when 'explicit-anchor' then 50
                when 'auto-conversation' then 40
                when 'migrated-1.1.49' then 30
                when 'legacy' then 20
                else 10
              end desc,
              case when coalesce(required_milestones_json,'[]') <> '[]' then 1 else 0 end desc,
              coalesce(substantive_activity_count,0) desc,
              updated_at desc
          ) as rn
        from continuation_tasks
        where conversation_scope_id glob 'v1/*'
          and state not in ('SUCCEEDED','FAILED_TERMINAL','CANCELLED_BY_USER','ABORTED_NO_PROGRESS','BUDGET_EXHAUSTED','ABANDONED_AUTO_TASK')
      )
      update continuation_tasks
      set state='ABANDONED_AUTO_TASK',
          terminal_reason='merged-duplicate-conversation-contract',
          continuation_pending=0,
          watch_process_handles_json='[]',
          waiting_reason=null,
          owner_control_note='Merged by conversation-scoped singleton migration.',
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      where id in (select id from ranked where rn > 1);

      create index if not exists continuation_tasks_conversation_state_idx
        on continuation_tasks(conversation_scope_id, state, updated_at desc);

      create unique index if not exists continuation_tasks_conversation_active_unique
        on continuation_tasks(conversation_scope_id)
        where conversation_scope_id glob 'v1/*'
          and state not in ('SUCCEEDED','FAILED_TERMINAL','CANCELLED_BY_USER','ABORTED_NO_PROGRESS','BUDGET_EXHAUSTED','ABANDONED_AUTO_TASK');

      update continuation_tasks
      set contract_version=case when contract_version < 2 then 2 else contract_version end
      where conversation_scope_id glob 'v1/*'
        and state not in ('SUCCEEDED','FAILED_TERMINAL','CANCELLED_BY_USER','ABORTED_NO_PROGRESS','BUDGET_EXHAUSTED','ABANDONED_AUTO_TASK');
    `);
}
function migrateContinuationManualTakeoverAndSingletonRepair(sqlite) {
    // Re-run the singleton reconciliation deliberately.  This makes the
    // invariant self-healing for installations that recorded an interrupted or
    // same-version 1.1.50 migration while the old runtime was still active.
    migrateContinuationConversationSingleton(sqlite);
    addColumnIfMissing(sqlite, "continuation_tasks", "delivery_generation", "integer not null default 0");
    addColumnIfMissing(sqlite, "continuation_tasks", "delivery_token", "text");
    addColumnIfMissing(sqlite, "continuation_tasks", "delivery_owner", "text");
    addColumnIfMissing(sqlite, "continuation_tasks", "delivery_owner_expires_at", "text");
    addColumnIfMissing(sqlite, "continuation_tasks", "manual_takeover_at", "text");
    addColumnIfMissing(sqlite, "continuation_tasks", "superseded_delivery_token", "text");
    sqlite.exec(`
      update continuation_tasks
      set delivery_generation=coalesce(delivery_generation,0),
          delivery_owner=case
            when continuation_pending in (4,5) and delivery_owner is null then 'legacy-pending'
            else delivery_owner
          end;

      -- Same-version 1.1.50 builds could successfully invoke the UI-bearing
      -- continuation_anchor while failing to persist the mount timestamp.  The
      -- durable source_tool is authoritative evidence that the immutable card
      -- was actually requested, so repair that metadata instead of asking the
      -- model to create another visible card after upgrade.
      update continuation_tasks
      set last_anchor_mounted_at=coalesce(last_anchor_mounted_at, updated_at, created_at),
          anchor_lease_expires_at=null,
          owner_control_note=case
            when owner_control_note is null or trim(owner_control_note)='' then 'Repaired historical continuation_anchor mount metadata during 1.1.51 migration.'
            else owner_control_note
          end
      where state not in ('SUCCEEDED','FAILED_TERMINAL','CANCELLED_BY_USER','ABORTED_NO_PROGRESS','BUDGET_EXHAUSTED','ABANDONED_AUTO_TASK')
        and source_tool='continuation_anchor'
        and coalesce(last_anchor_mounted_at,'')='';

      create index if not exists continuation_tasks_delivery_owner_idx
        on continuation_tasks(delivery_owner, delivery_owner_expires_at, updated_at desc);
    `);
}
function addColumnIfMissing(sqlite, table, column, definition) {
    const columns = sqlite.prepare(`pragma table_info(${table})`).all();
    if (columns.some((existingColumn) => existingColumn.name === column))
        return;
    sqlite.exec(`alter table ${table} add column ${column} ${definition}`);
}
