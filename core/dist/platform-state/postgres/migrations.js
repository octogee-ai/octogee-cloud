const CORE_SCHEMA = String.raw `
CREATE SEQUENCE record_revision_seq;

CREATE FUNCTION now_ms() RETURNS bigint LANGUAGE sql VOLATILE
  AS $$ SELECT (extract(epoch FROM clock_timestamp()) * 1000)::bigint $$;

CREATE FUNCTION bump_revision() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN NEW.revision := nextval('record_revision_seq'); RETURN NEW; END $$;

CREATE FUNCTION bump_revision_and_touch() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN NEW.revision := nextval('record_revision_seq'); NEW.updated_at := now_ms(); RETURN NEW; END $$;

CREATE TABLE operations (
  id                                   text PRIMARY KEY CHECK (id <> '' AND id NOT LIKE 'audit-%'),
  kind                                 text NOT NULL CHECK (kind IN ('add-gateway','gateway-vm','migrate-customer','retire-gateway',
                                         'restart-gateway','recycle-gateway','scale-shared-member','rollout',
                                         'deprovision-customer','suspend-customer','erase-customer')),
  status                               text NOT NULL CHECK (status IN ('pending','running','succeeded','failed','rolled-back')),
  origin                               text CHECK (origin IN ('automatic','operator')),
  created_by                           text NOT NULL,
  created_at                           bigint NOT NULL,
  started_at                           bigint,
  first_started_at                     bigint,
  last_resumed_at                      bigint,
  queued_at                            bigint,
  completed_at                         bigint,
  last_progress_at                     bigint,
  next_attempt_at                      bigint,
  waiting_on                           text,
  attempts                             integer CHECK (attempts >= 0),
  resume_count                         integer CHECK (resume_count >= 0),
  error                                text,
  rolled_back                          boolean,
  input                                jsonb NOT NULL CHECK (jsonb_typeof(input) = 'object'),
  steps                                jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(steps) = 'array'),
  attempt_history                      jsonb CHECK (jsonb_typeof(attempt_history) = 'array'),
  output                               jsonb,
  progress                             jsonb CHECK (jsonb_typeof(progress) = 'array'),
  gateway_id                           text,
  input_uid                            text,
  input_gateway_id                     text GENERATED ALWAYS AS (input ->> 'gatewayId') STORED,
  input_uid_raw                        text GENERATED ALWAYS AS (input ->> 'uid') STORED,
  input_user_slug                   text GENERATED ALWAYS AS (input ->> 'builderSlug') STORED,
  user_migration_v2                jsonb,
  source_transfer_execution            jsonb,
  scheduler_handoff                    jsonb,
  scheduler_handoff_released           boolean,
  scheduler_handoff_released_at        bigint,
  scheduler_handoff_lost               text,
  cutover_committed_at                 bigint,
  cancellation_requested_at            bigint,
  cancelled_by_deletion_id             text,
  retry_requested_at                   bigint,
  retry_requested_by                   text,
  superseded_by                        text,
  restore_attempt                      jsonb,
  restore_runtime_recovery             jsonb,
  source_runtime_recovery              jsonb,
  source_recovery_superseded_by        text,
  source_recovery_requested_at         bigint,
  source_recovery_requested_by         text,
  native_return_source_recovery_receipts jsonb CHECK (jsonb_typeof(native_return_source_recovery_receipts) = 'array'),
  force_drain_request                  jsonb,
  rollout_lane                         text,
  expire_at                            bigint,
  revision                             bigint NOT NULL DEFAULT nextval('record_revision_seq'),
  updated_at                           bigint NOT NULL DEFAULT now_ms()
);
CREATE INDEX operations_status_idx              ON operations (status);
CREATE INDEX operations_unreleased_handoff_idx  ON operations (status) WHERE scheduler_handoff_released = false;
CREATE INDEX operations_gateway_idx             ON operations (gateway_id, created_at DESC);
CREATE INDEX operations_input_gateway_idx       ON operations (input_gateway_id);
CREATE INDEX operations_input_uid_idx           ON operations (input_uid, status, kind);
CREATE INDEX operations_input_uid_raw_idx       ON operations (input_uid_raw);
CREATE INDEX operations_created_by_idx          ON operations (created_by);
CREATE INDEX operations_kind_idx                ON operations (kind, status);
CREATE INDEX operations_created_at_idx          ON operations (created_at DESC);
CREATE INDEX operations_expire_idx              ON operations (expire_at) WHERE expire_at IS NOT NULL;
CREATE INDEX operations_user_slug_idx        ON operations (input_user_slug text_pattern_ops);
CREATE TRIGGER operations_revision BEFORE UPDATE ON operations FOR EACH ROW EXECUTE FUNCTION bump_revision_and_touch();

CREATE TABLE operation_audits (
  id                     text PRIMARY KEY CHECK (id LIKE 'audit-%'),
  schema_version         smallint NOT NULL CHECK (schema_version = 1),
  status                 text NOT NULL CHECK (status IN ('recorded','in-progress','completed','failed')),
  lifecycle_stage        text NOT NULL CHECK (lifecycle_stage IN ('intent-recorded','action-started','action-completed',
                           'action-partial','action-failed')),
  idempotency_key        text NOT NULL UNIQUE,
  mutation_fingerprint   text NOT NULL,
  mutation               jsonb NOT NULL,
  actor                  text NOT NULL,
  forced                 boolean NOT NULL,
  what                   text NOT NULL,
  why                    text NOT NULL,
  target                 jsonb NOT NULL,
  pre_action_status      jsonb NOT NULL,
  alias_plan             jsonb NOT NULL CHECK (jsonb_typeof(alias_plan) = 'array'),
  alias_outcomes         jsonb,
  release_rollout        jsonb,
  test_provenance        jsonb,
  outcome                text CHECK (outcome IN ('completed','partial','failed')),
  partial_outcome        jsonb,
  created_at             bigint NOT NULL,
  action_claim_id        text,
  action_started_at      bigint,
  action_recovery_count  integer CHECK (action_recovery_count >= 0),
  completed_at           bigint,
  error                  text,
  expire_at              bigint,
  revision               bigint NOT NULL DEFAULT nextval('record_revision_seq'),
  updated_at             bigint NOT NULL DEFAULT now_ms(),
  CHECK (id = 'audit-' || encode(sha256(convert_to(idempotency_key, 'UTF8')), 'hex')),
  CHECK ((action_claim_id IS NULL) = (action_started_at IS NULL))
);
CREATE INDEX operation_audits_created_at_idx ON operation_audits (created_at DESC);
CREATE INDEX operation_audits_status_idx     ON operation_audits (status);
CREATE INDEX operation_audits_expire_idx     ON operation_audits (expire_at) WHERE expire_at IS NOT NULL;
CREATE TRIGGER operation_audits_revision BEFORE UPDATE ON operation_audits FOR EACH ROW EXECUTE FUNCTION bump_revision_and_touch();

CREATE TABLE gateway_recovery_receipts (
  id                 text PRIMARY KEY CHECK (id LIKE 'builder-recover-%'),
  kind               text NOT NULL CHECK (kind = 'recover-unreachable-disposable'),
  status             text NOT NULL CHECK (status IN ('pending','running','succeeded','failed','rolled-back')),
  origin             text CHECK (origin IN ('automatic','operator')),
  created_by         text NOT NULL,
  created_at         bigint NOT NULL,
  started_at         bigint,
  first_started_at   bigint,
  completed_at       bigint,
  input              jsonb NOT NULL CHECK (jsonb_typeof(input) = 'object'),
  input_uid_raw      text GENERATED ALWAYS AS (input ->> 'uid') STORED,
  steps              jsonb NOT NULL DEFAULT '[]',
  gateway_id         text NOT NULL,
  input_uid          text NOT NULL,
  recovery_receipt   jsonb,
  revision           bigint NOT NULL DEFAULT nextval('record_revision_seq'),
  updated_at         bigint NOT NULL DEFAULT now_ms()
);
CREATE INDEX gateway_recovery_receipts_uid_idx     ON gateway_recovery_receipts (input_uid);
CREATE INDEX gateway_recovery_receipts_uid_raw_idx ON gateway_recovery_receipts (input_uid_raw);
CREATE TRIGGER gateway_recovery_receipts_revision BEFORE UPDATE ON gateway_recovery_receipts FOR EACH ROW EXECUTE FUNCTION bump_revision_and_touch();

CREATE TABLE gateways (
  gateway_id                          text PRIMARY KEY CHECK (gateway_id ~ '^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$'),
  created_at                          bigint NOT NULL,
  created_by                          text NOT NULL,
  updated_at                          bigint NOT NULL,
  updated_by                          text NOT NULL,
  latest_release                      integer NOT NULL CHECK (latest_release >= 0),
  desired_release                     integer NOT NULL CHECK (desired_release >= 0 AND desired_release <= latest_release),
  live_release                        integer CHECK (live_release >= 1 AND live_release <= latest_release),
  desired_status                      text NOT NULL CHECK (desired_status IN ('running','paused','draining','retired')),
  retire_after                        bigint,
  retirement_version                  integer CHECK (retirement_version >= 1),
  retirement_claim                    jsonb,
  runtime_restart_fence               jsonb,
  config_schema_version               smallint NOT NULL CHECK (config_schema_version = 1),
  profile                             text CHECK (profile IN ('standard','builder')),
  gateway_class                       text NOT NULL CHECK (gateway_class IN ('shared','builder')),
  image_profile                       text NOT NULL CHECK (image_profile IN ('standard','builder')),
  sizing_tier                         text,
  gcp_project                         text,
  gateway_container_security_context  jsonb,
  service_account_name                text,
  service_account                     jsonb,
  user_access                      jsonb,
  owner_uid                           text,
  user_slug                        text,
  model_broker_limits                 jsonb,
  allocation_lease_id                 text,
  allocation_generation               integer CHECK (allocation_generation >= 1),
  allocation_claimed_by_uid           text,
  last_error                          jsonb,
  last_pre_stop_flush                 jsonb,
  config_backfill                     jsonb,
  revision                            bigint NOT NULL DEFAULT nextval('record_revision_seq'),
  CHECK (gateway_class <> 'shared' OR gateway_id ~ '^shared-[a-z0-9]+$'),
  CHECK ((allocation_lease_id IS NULL) = (allocation_generation IS NULL)
     AND (allocation_lease_id IS NULL) = (allocation_claimed_by_uid IS NULL))
);
CREATE INDEX gateways_owner_idx           ON gateways (owner_uid);
CREATE INDEX gateways_class_idx           ON gateways (gateway_class);
CREATE INDEX gateways_service_account_idx ON gateways (service_account_name);
CREATE TRIGGER gateways_revision BEFORE UPDATE ON gateways FOR EACH ROW EXECUTE FUNCTION bump_revision();

CREATE TABLE gateway_releases (
  gateway_id      text NOT NULL REFERENCES gateways (gateway_id) ON DELETE CASCADE,
  release         integer NOT NULL CHECK (release >= 1),
  created_at      bigint NOT NULL,
  created_by      text NOT NULL,
  source_release  integer CHECK (source_release >= 1),
  note            text,
  payload_hash    text NOT NULL,
  payload         jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  PRIMARY KEY (gateway_id, release)
);

CREATE FUNCTION release_within_latest() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM gateways g WHERE g.gateway_id = NEW.gateway_id AND NEW.release <= g.latest_release) THEN
    RAISE EXCEPTION 'release % exceeds latest_release of %', NEW.release, NEW.gateway_id USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER gateway_releases_within_latest AFTER INSERT ON gateway_releases
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION release_within_latest();

CREATE TABLE gateway_assignments (
  gateway_id                      text NOT NULL REFERENCES gateways (gateway_id) ON DELETE CASCADE,
  uid                             text NOT NULL,
  slug                            text NOT NULL CHECK (slug <> ''),
  source                          text NOT NULL CHECK (source IN ('onboarding','migrate-customer','repair')),
  state                           text NOT NULL CHECK (state IN ('serving','quiescing','migrating')),
  epoch                           integer NOT NULL CHECK (epoch >= 0),
  created_at                      bigint NOT NULL,
  updated_at                      bigint NOT NULL,
  updated_by_operation_id         text,
  handoff_progress                jsonb CHECK (jsonb_typeof(handoff_progress) = 'array'),
  shared_surge_forward_recovery   jsonb,
  revision                        bigint NOT NULL DEFAULT nextval('record_revision_seq'),
  PRIMARY KEY (gateway_id, uid),
  UNIQUE (gateway_id, slug)
);
CREATE INDEX gateway_assignments_uid_idx  ON gateway_assignments (uid);
CREATE INDEX gateway_assignments_slug_idx ON gateway_assignments (slug);
CREATE TRIGGER gateway_assignments_revision BEFORE UPDATE ON gateway_assignments FOR EACH ROW EXECUTE FUNCTION bump_revision();

CREATE TABLE gateway_vm_runtime (
  gateway_id  text PRIMARY KEY,
  bundle      jsonb NOT NULL CHECK (jsonb_typeof(bundle) = 'object'),
  revision    bigint NOT NULL DEFAULT nextval('record_revision_seq'),
  updated_at  bigint NOT NULL DEFAULT now_ms()
);
CREATE TRIGGER gateway_vm_runtime_revision BEFORE UPDATE ON gateway_vm_runtime FOR EACH ROW EXECUTE FUNCTION bump_revision_and_touch();

CREATE TABLE fleet_registry (
  gateway_id                  text PRIMARY KEY,
  release                     integer NOT NULL CHECK (release >= 0),
  lifecycle                   text NOT NULL CHECK (lifecycle IN ('provisioning','serving','failed')),
  retired_at                  bigint,
  created_at                  bigint NOT NULL,
  created_by_operation_id     text,
  runtime                     text CHECK (runtime IN ('cluster','gce-vm')),
  helm                        jsonb NOT NULL,
  heartbeat                   jsonb NOT NULL,
  heartbeat_status            text GENERATED ALWAYS AS (heartbeat ->> 'status') STORED,
  heartbeat_at                bigint GENERATED ALWAYS AS ((heartbeat ->> 'lastHeartbeatAt')::bigint) STORED,
  kubernetes                  jsonb,
  pod_replacements            jsonb,
  last_error                  jsonb NOT NULL,
  vm_spec                     jsonb,
  vm                          jsonb,
  vm_instance_id              text GENERATED ALWAYS AS (vm ->> 'instanceId') STORED,
  vm_instance                 jsonb,
  vm_home                     jsonb,
  vm_stop_on_park             jsonb,
  vm_boot_recovery            jsonb,
  vm_preemption               jsonb,
  vm_disk                     jsonb,
  vm_images                   jsonb,
  vm_egress                   jsonb,
  surge_crash_loop_evictions  jsonb,
  openclaw_healthy_build      jsonb,
  revision                    bigint NOT NULL DEFAULT nextval('record_revision_seq'),
  updated_at                  bigint NOT NULL DEFAULT now_ms()
);
CREATE INDEX fleet_registry_runtime_idx ON fleet_registry (runtime);
CREATE UNIQUE INDEX fleet_registry_vm_instance_idx ON fleet_registry (vm_instance_id) WHERE vm_instance_id IS NOT NULL;
CREATE TRIGGER fleet_registry_revision BEFORE UPDATE ON fleet_registry FOR EACH ROW EXECUTE FUNCTION bump_revision_and_touch();

CREATE TABLE shared_pool_scaler_state (
  id               text PRIMARY KEY CHECK (id = 'sharedPoolScaler'),
  schema_version   smallint NOT NULL CHECK (schema_version = 1),
  action_sequence  bigint NOT NULL CHECK (action_sequence >= 0),
  last_action_at   bigint,
  replacements     jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(replacements) = 'array'),
  last_action      jsonb,
  updated_at       bigint,
  revision         bigint NOT NULL DEFAULT nextval('record_revision_seq')
);
CREATE TRIGGER shared_pool_scaler_state_revision BEFORE UPDATE ON shared_pool_scaler_state FOR EACH ROW EXECUTE FUNCTION bump_revision();

CREATE TABLE platform_release_record (
  id                   text PRIMARY KEY CHECK (id = 'platformRelease'),
  schema_version       smallint NOT NULL CHECK (schema_version = 1),
  payload_hash         text NOT NULL,
  image_tag            text NOT NULL,
  openclaw_source_sha  text,
  written_at           bigint NOT NULL,
  revision             bigint NOT NULL DEFAULT nextval('record_revision_seq')
);
CREATE TRIGGER platform_release_record_revision BEFORE UPDATE ON platform_release_record FOR EACH ROW EXECUTE FUNCTION bump_revision();

CREATE TABLE migration_transfer_tasks (
  id                   text PRIMARY KEY,
  kind                 text NOT NULL,
  migration_id         text NOT NULL,
  slug                 text NOT NULL,
  mode                 text NOT NULL CHECK (mode IN ('keys','pre','final')),
  source_gateway_id    text NOT NULL,
  target_gateway_id    text NOT NULL,
  status               text NOT NULL CHECK (status IN ('running','succeeded','failed')),
  attempt              integer NOT NULL CHECK (attempt >= 1),
  attempt_id           text NOT NULL,
  lease_owner          text,
  lease_pod_name       text,
  lease_pod_uid        text,
  lease_expires_at     bigint,
  lease_restart_count  integer,
  created_at           bigint NOT NULL,
  updated_at           bigint NOT NULL,
  started_at           bigint NOT NULL,
  completed_at         bigint,
  error                text,
  revision             bigint NOT NULL DEFAULT nextval('record_revision_seq'),
  UNIQUE (migration_id, mode),
  CHECK (id = regexp_replace(migration_id, '[^A-Za-z0-9._-]', '_', 'g') || '__' || mode),
  CHECK ((lease_pod_name IS NULL) = (lease_pod_uid IS NULL))
);
CREATE INDEX migration_transfer_tasks_status_idx ON migration_transfer_tasks (status);
CREATE TRIGGER migration_transfer_tasks_revision BEFORE UPDATE ON migration_transfer_tasks FOR EACH ROW EXECUTE FUNCTION bump_revision();

CREATE TABLE orchestrator_config (
  id                           text PRIMARY KEY CHECK (id = 'orchestrator'),
  shared_autoscaling_enabled   boolean,
  shared_users_per_gateway  integer CHECK (shared_users_per_gateway >= 1),
  default_gateway_id           text,
  disposable_gateway_idle_ms   bigint CHECK (disposable_gateway_idle_ms >= 0),
  placement_updated_at         bigint,
  placement_updated_by         text,
  sizing_profiles              jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(sizing_profiles) = 'object'),
  revision                     bigint NOT NULL DEFAULT nextval('record_revision_seq'),
  CHECK ((shared_autoscaling_enabled IS NULL) = (shared_users_per_gateway IS NULL))
);
CREATE TRIGGER orchestrator_config_revision BEFORE UPDATE ON orchestrator_config FOR EACH ROW EXECUTE FUNCTION bump_revision();

CREATE TABLE writer_quiescence (
  id        text PRIMARY KEY CHECK (id = 'platformMigrationWriterQuiescence'),
  record    jsonb NOT NULL,
  revision  bigint NOT NULL DEFAULT nextval('record_revision_seq')
);
CREATE TRIGGER writer_quiescence_revision BEFORE UPDATE ON writer_quiescence FOR EACH ROW EXECUTE FUNCTION bump_revision();

CREATE TABLE channel_host_admin (
  id          text PRIMARY KEY CHECK (id = 'mattermostAdmin'),
  user_id     text NOT NULL,
  proxy_url   text,
  updated_at  bigint NOT NULL,
  revision    bigint NOT NULL DEFAULT nextval('record_revision_seq')
);
CREATE TRIGGER channel_host_admin_revision BEFORE UPDATE ON channel_host_admin FOR EACH ROW EXECUTE FUNCTION bump_revision();

CREATE TABLE platform_config (
  key         text PRIMARY KEY CHECK (key IN ('models','free','connect')),
  value       jsonb NOT NULL CHECK (jsonb_typeof(value) = 'object'),
  updated_at  bigint,
  updated_by  text,
  revision    bigint NOT NULL DEFAULT nextval('record_revision_seq')
);
CREATE TRIGGER platform_config_revision BEFORE UPDATE ON platform_config FOR EACH ROW EXECUTE FUNCTION bump_revision();

CREATE TABLE users (
  uid                                 text PRIMARY KEY CHECK (uid <> ''),
  slug                                text,
  admitted                            boolean NOT NULL DEFAULT false,
  persona                             jsonb CHECK (persona IS NULL OR jsonb_typeof(persona) = 'object'),
  workspace_id                        text,
  role                                text CHECK (role IN ('user','admin')),
  created_at                          bigint,
  provisioning_status                 text,
  provisioning_started_at             bigint,
  git_repo_url                        text,
  git_created_at                      bigint,
  gateway_id                          text,
  gateway_assigned_at                 bigint,
  gateway_profile                     text CHECK (gateway_profile IN ('standard','builder')),
  control_ui_enabled                  boolean,
  openclaw_status                     text,
  openclaw_version                    text,
  agent_id                            text,
  user_dir                        text,
  provisioned_at                      bigint,
  mounted                             boolean,
  managed_by                          text CHECK (managed_by IN ('cowboy','operator')),
  greeting                            jsonb,
  toolchain                           jsonb,
  lifecycle_status                    text CHECK (lifecycle_status IN ('active','suspended','deletion_scheduled','erasing')),
  lifecycle_deletion_id               text,
  lifecycle_suspended_at              bigint,
  lifecycle_erase_after               bigint,
  activation_lease                    jsonb CHECK (activation_lease IS NULL OR (jsonb_typeof(activation_lease) = 'object'
                                        AND activation_lease ? 'leaseId' AND activation_lease ? 'generation' AND activation_lease ? 'status')),
  lease_id                            text GENERATED ALWAYS AS (activation_lease ->> 'leaseId') STORED,
  lease_generation                    integer GENERATED ALWAYS AS ((activation_lease ->> 'generation')::integer) STORED,
  lease_status                        text GENERATED ALWAYS AS (activation_lease ->> 'status') STORED,
  lease_target_gateway_id             text GENERATED ALWAYS AS (activation_lease ->> 'targetGatewayId') STORED,
  lease_source_gateway_id             text GENERATED ALWAYS AS (activation_lease ->> 'sourceGatewayId') STORED,
  restore_fence                       jsonb,
  source_transfer_fence               jsonb,
  source_transfer_source_gateway_id   text GENERATED ALWAYS AS (source_transfer_fence ->> 'sourceGatewayId') STORED,
  source_transfer_target_gateway_id   text GENERATED ALWAYS AS (source_transfer_fence ->> 'targetGatewayId') STORED,
  computer_recovery                   jsonb,
  computer_recovery_gateway_id        text GENERATED ALWAYS AS (computer_recovery ->> 'gatewayId') STORED,
  migration_marker                    jsonb,
  migration_operation_id              text GENERATED ALWAYS AS (migration_marker ->> 'operationId') STORED,
  pending_native_scheduler_retirement jsonb,
  runtime_reset                       jsonb,
  computer                            jsonb,
  computer_instance_id                text GENERATED ALWAYS AS (computer ->> 'instanceId') STORED,
  home_checkpoint                     jsonb,
  home_disk                           jsonb,
  home_storage                        jsonb,
  home_migration                      jsonb,
  home_erasure                        jsonb CHECK (jsonb_typeof(home_erasure) = 'array'),
  home_capacity                       jsonb,
  project_storage_native_boot         jsonb,
  activated_agents                    text[] NOT NULL DEFAULT '{}' CHECK (array_position(activated_agents, NULL) IS NULL),
  revision                            bigint NOT NULL DEFAULT nextval('record_revision_seq'),
  updated_at                          bigint NOT NULL DEFAULT now_ms(),
  CHECK (lease_status IN ('requested','provisioning','activating','active','returning','parked','failed')),
  CHECK (lease_generation >= 1),
  CHECK (NOT admitted OR provisioning_status IS NOT NULL),
  CHECK (NOT admitted OR slug IS NOT NULL)
);
CREATE UNIQUE INDEX users_slug_idx              ON users (slug) WHERE slug IS NOT NULL;
CREATE UNIQUE INDEX users_computer_instance_idx ON users (computer_instance_id) WHERE computer_instance_id IS NOT NULL;
CREATE INDEX users_gateway_idx                  ON users (gateway_id, openclaw_status);
CREATE INDEX users_openclaw_status_idx          ON users (openclaw_status);
CREATE INDEX users_transfer_source_idx          ON users (source_transfer_source_gateway_id) WHERE source_transfer_source_gateway_id IS NOT NULL;
CREATE INDEX users_transfer_target_idx          ON users (source_transfer_target_gateway_id) WHERE source_transfer_target_gateway_id IS NOT NULL;
CREATE INDEX users_computer_recovery_idx        ON users (computer_recovery_gateway_id) WHERE computer_recovery_gateway_id IS NOT NULL;
CREATE INDEX users_admitted_idx                 ON users (uid) WHERE admitted;
CREATE INDEX users_agent_idx                    ON users (agent_id);
CREATE INDEX users_created_at_idx               ON users (created_at DESC, uid);
CREATE TRIGGER users_revision BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION bump_revision_and_touch();

CREATE TABLE user_agents (
  uid        text NOT NULL REFERENCES users (uid) ON DELETE CASCADE,
  agent_id   text NOT NULL CHECK (agent_id <> ''),
  PRIMARY KEY (uid, agent_id)
);
CREATE INDEX user_agents_agent_idx ON user_agents (agent_id);

CREATE TABLE placement_receipts (
  uid                      text NOT NULL REFERENCES users (uid) ON DELETE CASCADE,
  receipt_id               text NOT NULL,
  schema_version           smallint NOT NULL CHECK (schema_version = 1),
  kind                     text NOT NULL CHECK (kind IN ('activated','returned','activation-failed')),
  at                       bigint NOT NULL,
  user_slug             text,
  lease_id                 text NOT NULL CHECK (lease_id <> ''),
  generation               integer NOT NULL CHECK (generation >= 1),
  cause                    text,
  sizing_tier              text,
  entitlement_tier         text,
  gateway_id               text NOT NULL,
  shared_gateway_id        text,
  requested_at             bigint,
  wake_duration_ms         bigint,
  active_duration_ms       bigint,
  operation_id             text,
  retirement_operation_id  text,
  operator_terminated      boolean NOT NULL,
  error                    text,
  PRIMARY KEY (uid, receipt_id),
  UNIQUE (uid, lease_id, generation, kind),
  CHECK (receipt_id = lease_id || '-' || generation || '-' || kind)
);
CREATE INDEX placement_receipts_at_idx ON placement_receipts (uid, at DESC);

CREATE TABLE schedule_transfers (
  uid                   text NOT NULL REFERENCES users (uid) ON DELETE CASCADE,
  migration_id          text NOT NULL,
  slug                  text NOT NULL,
  source_gateway_id     text NOT NULL,
  target_gateway_id     text NOT NULL,
  records               jsonb NOT NULL CHECK (jsonb_typeof(records) = 'array'),
  skipped               jsonb NOT NULL CHECK (jsonb_typeof(skipped) = 'array'),
  snapshot_at           bigint NOT NULL,
  restore_attempted_to  text,
  restore_attempted_at  bigint,
  restored_to           text,
  restored_at           bigint,
  restore_failures      jsonb,
  revision              bigint NOT NULL DEFAULT nextval('record_revision_seq'),
  PRIMARY KEY (uid, migration_id)
);
CREATE TRIGGER schedule_transfers_revision BEFORE UPDATE ON schedule_transfers FOR EACH ROW EXECUTE FUNCTION bump_revision();

CREATE TABLE agent_stores (
  uid               text NOT NULL REFERENCES users (uid) ON DELETE CASCADE,
  store_key         text NOT NULL,
  store_kind        text GENERATED ALWAYS AS (CASE WHEN store_key = '_gateway-state' THEN 'gateway-state'
                                                   WHEN store_key LIKE '\_gateway-%' THEN 'auxiliary'
                                                   ELSE 'agent' END) STORED,
  store_id          text NOT NULL,
  agent_id          text,
  family            text CHECK (family IN ('workboard','logbook','team-reports')),
  schema            text NOT NULL,
  gateway_id        text,
  assignment_epoch  integer CHECK (assignment_epoch >= 0),
  generation        integer CHECK (generation >= 0),
  recorded_at       bigint NOT NULL,
  revision          bigint NOT NULL DEFAULT nextval('record_revision_seq'),
  updated_at        bigint NOT NULL DEFAULT now_ms(),
  PRIMARY KEY (uid, store_key),
  CHECK (store_key IN ('_gateway-state','_gateway-workboard','_gateway-logbook','_gateway-team-reports')
         OR (store_key NOT LIKE '\_%' AND agent_id = store_key)),
  CHECK ((store_key LIKE '\_gateway-%' AND store_key <> '_gateway-state') = (family IS NOT NULL))
);
CREATE TRIGGER agent_stores_revision BEFORE UPDATE ON agent_stores FOR EACH ROW EXECUTE FUNCTION bump_revision_and_touch();

CREATE TABLE workspaces (
  slug                text PRIMARY KEY CHECK (slug <> ''),
  id                  text NOT NULL,
  owner_uid           text NOT NULL,
  owner_active        boolean NOT NULL DEFAULT true,
  channel_provider      text NOT NULL DEFAULT 'managed',
  channel_installation  text NOT NULL DEFAULT 'default',
  channel_host_team_id  text,
  git_host       text NOT NULL DEFAULT 'managed',
  git_owner      text,
  git_repo     text,
  created_at          bigint,
  updated_at          bigint,
  revision            bigint NOT NULL DEFAULT nextval('record_revision_seq')
);
CREATE INDEX workspaces_owner_idx ON workspaces (owner_uid);
CREATE TRIGGER workspaces_revision BEFORE UPDATE ON workspaces FOR EACH ROW EXECUTE FUNCTION bump_revision();

CREATE TABLE workspace_members (
  workspace_slug      text NOT NULL REFERENCES workspaces (slug) ON DELETE CASCADE,
  uid                 text NOT NULL,
  role                text NOT NULL CHECK (role IN ('owner','member')),
  joined_at           bigint,
  channel_host_user_id  text,
  revision            bigint NOT NULL DEFAULT nextval('record_revision_seq'),
  PRIMARY KEY (workspace_slug, uid)
);
CREATE INDEX workspace_members_uid_idx ON workspace_members (uid);
CREATE TRIGGER workspace_members_revision BEFORE UPDATE ON workspace_members FOR EACH ROW EXECUTE FUNCTION bump_revision();

CREATE TABLE workspace_projects (
  workspace_slug               text NOT NULL REFERENCES workspaces (slug) ON DELETE CASCADE,
  project_slug                 text NOT NULL CHECK (project_slug <> ''),
  owner_uid                    text NOT NULL,
  owner_active                 boolean NOT NULL DEFAULT true,
  git_host              text NOT NULL DEFAULT 'managed',
  git_repo              text,
  provisioning_state           text,
  provisioning_error           text,
  pending_visibility           text,
  visibility                   text,
  checkout_enabled             boolean,
  status                       text,
  archived                     boolean NOT NULL DEFAULT false,
  commercial_lifecycle_status  text,
  repo_source                  jsonb,
  agent                        jsonb,
  updated_at                   bigint,
  revision                     bigint NOT NULL DEFAULT nextval('record_revision_seq'),
  PRIMARY KEY (workspace_slug, project_slug)
);
CREATE INDEX workspace_projects_owner_idx ON workspace_projects (owner_uid);
CREATE TRIGGER workspace_projects_revision BEFORE UPDATE ON workspace_projects FOR EACH ROW EXECUTE FUNCTION bump_revision();

CREATE TABLE workspace_channels (
  workspace_slug         text NOT NULL REFERENCES workspaces (slug) ON DELETE CASCADE,
  project_slug           text NOT NULL DEFAULT '',
  channel_id             text NOT NULL CHECK (channel_id <> ''),
  kind                   text NOT NULL,
  channel_provider       text NOT NULL DEFAULT 'managed',
  channel_installation   text NOT NULL DEFAULT 'default',
  channel_host_channel_id  text,
  archived_at            bigint,
  created_by             text,
  created_at             bigint,
  revision               bigint NOT NULL DEFAULT nextval('record_revision_seq'),
  PRIMARY KEY (workspace_slug, project_slug, channel_id)
);
CREATE UNIQUE INDEX workspace_channels_channel_host_idx ON workspace_channels (channel_provider, channel_installation, channel_host_channel_id) WHERE channel_host_channel_id IS NOT NULL;
CREATE TRIGGER workspace_channels_revision BEFORE UPDATE ON workspace_channels FOR EACH ROW EXECUTE FUNCTION bump_revision();

CREATE TABLE user_agent_identities (
  uid                 text PRIMARY KEY,
  created_at          bigint,
  updated_at          bigint,
  revision            bigint NOT NULL DEFAULT nextval('record_revision_seq')
);
CREATE TRIGGER user_agent_identities_revision BEFORE UPDATE ON user_agent_identities FOR EACH ROW EXECUTE FUNCTION bump_revision();

CREATE TABLE channel_identities (
  channel_provider      text NOT NULL CHECK (channel_provider <> ''),
  channel_installation  text NOT NULL CHECK (channel_installation <> ''),
  external_user_id      text NOT NULL CHECK (external_user_id <> ''),
  owner_kind            text NOT NULL CHECK (owner_kind IN ('user','agent')),
  owner_id              text NOT NULL CHECK (owner_id <> ''),
  revision              bigint NOT NULL DEFAULT nextval('record_revision_seq'),
  PRIMARY KEY (channel_provider, channel_installation, external_user_id)
);
CREATE UNIQUE INDEX channel_identities_owner_idx ON channel_identities (owner_id, owner_kind, channel_provider, channel_installation);
CREATE TRIGGER channel_identities_revision BEFORE UPDATE ON channel_identities FOR EACH ROW EXECUTE FUNCTION bump_revision();
CREATE FUNCTION forget_channel_identities() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  DELETE FROM channel_identities WHERE owner_kind = TG_ARGV[0] AND owner_id = OLD.uid;
  RETURN OLD;
END
$$;
CREATE FUNCTION touch_managed_channel_identity_owner() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  identity channel_identities;
BEGIN
  IF TG_OP = 'DELETE' THEN identity := OLD; ELSE identity := NEW; END IF;
  IF identity.channel_provider <> 'managed' OR identity.channel_installation <> 'default' THEN RETURN NULL; END IF;
  IF identity.owner_kind = 'user' THEN
    UPDATE users SET uid = uid WHERE uid = identity.owner_id;
  ELSE
    UPDATE user_agent_identities SET uid = uid WHERE uid = identity.owner_id;
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER channel_identities_touch_owner AFTER INSERT OR DELETE ON channel_identities
  FOR EACH ROW EXECUTE FUNCTION touch_managed_channel_identity_owner();
CREATE TRIGGER users_forget_channel_identities AFTER DELETE ON users
  FOR EACH ROW EXECUTE FUNCTION forget_channel_identities('user');
CREATE TRIGGER user_agent_identities_forget_channel_identities AFTER DELETE ON user_agent_identities
  FOR EACH ROW EXECUTE FUNCTION forget_channel_identities('agent');

CREATE TABLE user_secrets (
  uid                     text NOT NULL REFERENCES users (uid) ON DELETE CASCADE,
  secret_id               text NOT NULL CHECK (secret_id <> ''),
  secret_kind             text GENERATED ALWAYS AS (CASE WHEN secret_id = 'mattermost' THEN 'builder-mattermost'
                                                         WHEN secret_id = 'coachMattermost' THEN 'coach-mattermost'
                                                         WHEN secret_id LIKE 'projectAgentMattermost-%' THEN 'project-agent-mattermost'
                                                         ELSE 'connector' END) STORED,
  project_id              text GENERATED ALWAYS AS (CASE WHEN secret_id LIKE 'projectAgentMattermost-%'
                                                         THEN substr(secret_id, length('projectAgentMattermost-') + 1) END) STORED,
  personal_token          text,
  channel_host_user_id      text,
  encrypted_access_token  text,
  encrypted_refresh_token text,
  detail                  jsonb,
  created_at              bigint,
  rotated_at              bigint,
  revision                bigint NOT NULL DEFAULT nextval('record_revision_seq'),
  updated_at              bigint NOT NULL DEFAULT now_ms(),
  PRIMARY KEY (uid, secret_id),
  CHECK ((secret_kind = 'connector') = (personal_token IS NULL)),
  CHECK ((secret_kind = 'connector') = (detail IS NOT NULL))
);
CREATE INDEX user_secrets_kind_idx ON user_secrets (uid, secret_kind);
CREATE TRIGGER user_secrets_revision BEFORE UPDATE ON user_secrets FOR EACH ROW EXECUTE FUNCTION bump_revision_and_touch();

CREATE TABLE gateway_tickets (
  ticket_id   text PRIMARY KEY,
  uid         text NOT NULL,
  gateway_id  text NOT NULL,
  expires_at  bigint NOT NULL,
  access_grant jsonb NOT NULL,
  revision    bigint NOT NULL DEFAULT nextval('record_revision_seq')
);
CREATE INDEX gateway_tickets_expiry_idx ON gateway_tickets (expires_at);
CREATE TRIGGER gateway_tickets_revision BEFORE UPDATE ON gateway_tickets FOR EACH ROW EXECUTE FUNCTION bump_revision();

CREATE TABLE control_tickets (
  ticket_hash  text PRIMARY KEY,
  gateway_id   text NOT NULL,
  uid          text NOT NULL,
  created_at   bigint NOT NULL,
  expires_at   bigint NOT NULL,
  redeemed_at  bigint,
  access_grant jsonb NOT NULL,
  revision     bigint NOT NULL DEFAULT nextval('record_revision_seq')
);
CREATE INDEX control_tickets_expiry_idx ON control_tickets (expires_at);
CREATE TRIGGER control_tickets_revision BEFORE UPDATE ON control_tickets FOR EACH ROW EXECUTE FUNCTION bump_revision();

CREATE TABLE control_sessions (
  session_hash   text PRIMARY KEY,
  gateway_id     text NOT NULL,
  uid            text NOT NULL,
  created_at     bigint,
  expires_at     bigint NOT NULL,
  attachment_id  text,
  access_grant   jsonb NOT NULL,
  revision      bigint NOT NULL DEFAULT nextval('record_revision_seq')
);
CREATE INDEX control_sessions_expiry_idx ON control_sessions (expires_at);
CREATE TRIGGER control_sessions_revision BEFORE UPDATE ON control_sessions FOR EACH ROW EXECUTE FUNCTION bump_revision();

CREATE TABLE model_broker_tokens (
  token_hash                 text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  gateway_id                 text NOT NULL,
  owner_uid                  text,
  provider                   text NOT NULL CHECK (provider IN ('anthropic','vertex','openrouter','openai')),
  purpose                    text NOT NULL CHECK (purpose IN ('model','embeddings')),
  secret_name                text NOT NULL,
  created_at                 bigint NOT NULL,
  expires_at                 bigint,
  limit_spend_window_usd     double precision CHECK (limit_spend_window_usd >= 0),
  limit_spend_week_usd       double precision CHECK (limit_spend_week_usd >= 0),
  limit_requests_per_minute  double precision CHECK (limit_requests_per_minute >= 0),
  rail_policy                jsonb NOT NULL CHECK (jsonb_typeof(rail_policy) = 'object'),
  trace                      jsonb CHECK (trace IS NULL OR jsonb_typeof(trace) = 'object'),
  revoked                    boolean NOT NULL DEFAULT false,
  revoked_at                 bigint,
  revision                   bigint NOT NULL DEFAULT nextval('record_revision_seq'),
  CHECK (revoked = (revoked_at IS NOT NULL))
);
CREATE INDEX model_broker_tokens_owner_idx   ON model_broker_tokens (owner_uid) WHERE owner_uid IS NOT NULL;
CREATE INDEX model_broker_tokens_gateway_idx ON model_broker_tokens (gateway_id);
CREATE TRIGGER model_broker_tokens_revision BEFORE UPDATE ON model_broker_tokens FOR EACH ROW EXECUTE FUNCTION bump_revision();

CREATE TABLE model_broker_gateway_tokens (
  pointer_key  text PRIMARY KEY,
  gateway_id   text NOT NULL,
  owner_uid    text,
  provider     text NOT NULL CHECK (provider IN ('anthropic','vertex','openrouter','openai')),
  secret_name  text NOT NULL,
  token_hash   text NOT NULL REFERENCES model_broker_tokens (token_hash) ON DELETE CASCADE,
  updated_at   bigint NOT NULL,
  revision     bigint NOT NULL DEFAULT nextval('record_revision_seq')
);
CREATE INDEX model_broker_gateway_tokens_owner_idx ON model_broker_gateway_tokens (owner_uid) WHERE owner_uid IS NOT NULL;
CREATE INDEX model_broker_gateway_tokens_token_idx ON model_broker_gateway_tokens (token_hash);
CREATE TRIGGER model_broker_gateway_tokens_revision BEFORE UPDATE ON model_broker_gateway_tokens FOR EACH ROW EXECUTE FUNCTION bump_revision();

CREATE TABLE gateway_access_audit (
  id          text PRIMARY KEY,
  at          bigint NOT NULL,
  gateway_id  text NOT NULL,
  uid         text,
  reason      text NOT NULL,
  detail      jsonb NOT NULL
);
CREATE INDEX gateway_access_audit_gateway_idx ON gateway_access_audit (gateway_id, at DESC);

CREATE TABLE user_deletion_jobs (
  deletion_id                   text PRIMARY KEY,
  version                       smallint NOT NULL CHECK (version = 1),
  uid                           text NOT NULL,
  slug                          text,
  status                        text NOT NULL CHECK (status IN ('suspension_pending', 'suspending', 'hibernating', 'product_verification_pending', 'verified_pending_completion', 'verified')),
  requested_by                  text NOT NULL,
  requested_at                  bigint NOT NULL,
  erase_after                   bigint NOT NULL,
  current_gateway_id            text,
  erasure_operation_id          text NOT NULL,
  suspension_operation_id       text NOT NULL,
  cleanup_context               jsonb,
  postgres_agent_store_targets  jsonb,
  shared_agent_store_cleanup    jsonb,
  retired_gateway_proofs        jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(retired_gateway_proofs) = 'object'),
  archive_id                    text,
  product_context               jsonb CHECK (product_context IS NULL OR jsonb_typeof(product_context) = 'object'),
  suspended_at                  bigint,
  cloud_erased_at               bigint,
  verified_at                   bigint,
  completed_at                  bigint,
  updated_at                    bigint,
  revision                      bigint NOT NULL DEFAULT nextval('record_revision_seq')
);
CREATE INDEX user_deletion_jobs_uid_idx    ON user_deletion_jobs (uid);
CREATE INDEX user_deletion_jobs_status_idx ON user_deletion_jobs (status);
CREATE TRIGGER user_deletion_jobs_revision BEFORE UPDATE ON user_deletion_jobs FOR EACH ROW EXECUTE FUNCTION bump_revision();

CREATE TABLE anonymous_operational_archives (
  id           text PRIMARY KEY,
  archived_at  bigint NOT NULL,
  record       jsonb NOT NULL,
  revision     bigint NOT NULL DEFAULT nextval('record_revision_seq')
);
CREATE INDEX anonymous_operational_archives_at_idx ON anonymous_operational_archives (archived_at DESC);
CREATE TRIGGER anonymous_operational_archives_revision BEFORE UPDATE ON anonymous_operational_archives FOR EACH ROW EXECUTE FUNCTION bump_revision();

CREATE TABLE agent_imports (
  uid            text NOT NULL REFERENCES users (uid) ON DELETE CASCADE,
  import_id      text NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('import','export')),
  slug           text,
  status         text NOT NULL,
  import_commit  text,
  cleanup_at     bigint,
  created_at     bigint NOT NULL,
  updated_at     bigint NOT NULL,
  record         jsonb NOT NULL,
  revision       bigint NOT NULL DEFAULT nextval('record_revision_seq'),
  PRIMARY KEY (uid, import_id)
);
CREATE INDEX agent_imports_cleanup_idx ON agent_imports (cleanup_at) WHERE cleanup_at IS NOT NULL;
CREATE TRIGGER agent_imports_revision BEFORE UPDATE ON agent_imports FOR EACH ROW EXECUTE FUNCTION bump_revision();

CREATE TABLE agent_import_pointers (
  uid         text NOT NULL REFERENCES users (uid) ON DELETE CASCADE,
  pointer     text NOT NULL CHECK (pointer IN ('latest','export-latest')),
  import_id   text NOT NULL,
  updated_at  bigint NOT NULL,
  revision    bigint NOT NULL DEFAULT nextval('record_revision_seq'),
  PRIMARY KEY (uid, pointer),
  FOREIGN KEY (uid, import_id) REFERENCES agent_imports (uid, import_id) ON DELETE CASCADE
);
CREATE TRIGGER agent_import_pointers_revision BEFORE UPDATE ON agent_import_pointers FOR EACH ROW EXECUTE FUNCTION bump_revision();
`;
const CHANGE_FEED = String.raw `
CREATE TABLE change_log (
  seq           bigserial PRIMARY KEY,
  txid          xid8 NOT NULL DEFAULT pg_current_xact_id(),
  aggregate     text NOT NULL,
  record_key    text NOT NULL,
  filter_keys   jsonb NOT NULL,
  committed_at  bigint NOT NULL DEFAULT now_ms()
);
CREATE INDEX change_log_txid_idx ON change_log (txid, seq);
CREATE INDEX change_log_aggregate_idx ON change_log (aggregate, txid);

CREATE TABLE change_log_retention (
  id              boolean PRIMARY KEY DEFAULT true CHECK (id),
  purged_through  xid8 NOT NULL
);

CREATE FUNCTION record_change() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  row_data jsonb := to_jsonb(COALESCE(NEW, OLD));
  old_data jsonb := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END;
  key_text text := '';
  filters jsonb := '{}'::jsonb;
  i integer;
BEGIN
  FOR i IN 1 .. TG_NARGS - 1 LOOP
    IF left(TG_ARGV[i], 7) = 'filter:' THEN
      filters := filters || jsonb_build_object(
        substr(TG_ARGV[i], 8),
        jsonb_build_array(row_data -> substr(TG_ARGV[i], 8), old_data -> substr(TG_ARGV[i], 8)));
    ELSE
      key_text := key_text || CASE WHEN key_text = '' THEN '' ELSE '/' END || (row_data ->> TG_ARGV[i]);
    END IF;
  END LOOP;
  INSERT INTO change_log (aggregate, record_key, filter_keys) VALUES (TG_ARGV[0], key_text, filters);
  PERFORM pg_notify('platform_state', TG_ARGV[0]);
  RETURN NULL;
END $$;

CREATE TRIGGER operations_change AFTER INSERT OR UPDATE OR DELETE ON operations
  FOR EACH ROW EXECUTE FUNCTION record_change('operations', 'id', 'filter:status');
CREATE TRIGGER gateways_change AFTER INSERT OR UPDATE OR DELETE ON gateways
  FOR EACH ROW EXECUTE FUNCTION record_change('gateways', 'gateway_id', 'filter:gateway_id');
CREATE TRIGGER gateway_assignments_change AFTER INSERT OR UPDATE OR DELETE ON gateway_assignments
  FOR EACH ROW EXECUTE FUNCTION record_change('assignments', 'gateway_id', 'uid', 'filter:gateway_id');
CREATE TRIGGER fleet_registry_change AFTER INSERT OR UPDATE OR DELETE ON fleet_registry
  FOR EACH ROW EXECUTE FUNCTION record_change('fleetRegistry', 'gateway_id', 'filter:gateway_id');
CREATE TRIGGER users_change AFTER INSERT OR UPDATE OR DELETE ON users
  FOR EACH ROW EXECUTE FUNCTION record_change('builders', 'uid', 'filter:uid', 'filter:gateway_id');
CREATE TRIGGER user_agents_change AFTER INSERT OR UPDATE OR DELETE ON user_agents
  FOR EACH ROW EXECUTE FUNCTION record_change('builders', 'uid', 'filter:uid');
CREATE TRIGGER orchestrator_config_change AFTER INSERT OR UPDATE OR DELETE ON orchestrator_config
  FOR EACH ROW EXECUTE FUNCTION record_change('config', 'id');
CREATE TRIGGER platform_config_change AFTER INSERT OR UPDATE OR DELETE ON platform_config
  FOR EACH ROW EXECUTE FUNCTION record_change('config', 'key');
CREATE TRIGGER migration_transfer_tasks_change AFTER INSERT OR UPDATE OR DELETE ON migration_transfer_tasks
  FOR EACH ROW EXECUTE FUNCTION record_change('migrationTasks', 'id', 'filter:status');
CREATE TRIGGER workspaces_change AFTER INSERT OR UPDATE OR DELETE ON workspaces
  FOR EACH ROW EXECUTE FUNCTION record_change('workspaces', 'slug', 'filter:owner_uid');
CREATE TRIGGER workspace_members_change AFTER INSERT OR UPDATE OR DELETE ON workspace_members
  FOR EACH ROW EXECUTE FUNCTION record_change('workspaceMembers', 'workspace_slug', 'uid', 'filter:workspace_slug', 'filter:uid');
CREATE TRIGGER workspace_projects_change AFTER INSERT OR UPDATE OR DELETE ON workspace_projects
  FOR EACH ROW EXECUTE FUNCTION record_change('workspaceProjects', 'workspace_slug', 'project_slug', 'filter:workspace_slug');
CREATE TRIGGER workspace_channels_change AFTER INSERT OR UPDATE OR DELETE ON workspace_channels
  FOR EACH ROW EXECUTE FUNCTION record_change('workspaceChannels', 'workspace_slug', 'project_slug', 'channel_id', 'filter:workspace_slug');
CREATE TRIGGER user_agent_identities_change AFTER INSERT OR UPDATE OR DELETE ON user_agent_identities
  FOR EACH ROW EXECUTE FUNCTION record_change('agentIdentities', 'uid', 'filter:uid');
`;
const USER_CONSTRAINTS = String.raw `
ALTER TABLE gateway_assignments
  ADD CONSTRAINT gateway_assignments_user_fk FOREIGN KEY (uid) REFERENCES users (uid) ON DELETE CASCADE;

CREATE FUNCTION user_mirror_assigned() RETURNS trigger LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
DECLARE
  target_uid text;
BEGIN
  IF TG_TABLE_NAME = 'users' THEN target_uid := NEW.uid; ELSE target_uid := OLD.uid; END IF;
  IF EXISTS (
    SELECT 1 FROM users b
    WHERE b.uid = target_uid AND b.gateway_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM gateway_assignments a WHERE a.gateway_id = b.gateway_id AND a.uid = b.uid)
  ) THEN
    RAISE EXCEPTION 'user % mirrors a gateway without an assignment', target_uid USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER users_mirror_assigned AFTER INSERT OR UPDATE OF gateway_id ON users
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION user_mirror_assigned();
CREATE CONSTRAINT TRIGGER gateway_assignments_mirror_assigned AFTER DELETE OR UPDATE OF gateway_id, uid ON gateway_assignments
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION user_mirror_assigned();
`;
const WORKSPACE_AND_JOB_FIDELITY = String.raw `
ALTER TABLE workspaces
  ALTER COLUMN owner_active DROP NOT NULL,
  ALTER COLUMN owner_active DROP DEFAULT;

ALTER TABLE workspace_projects
  ALTER COLUMN owner_active DROP NOT NULL,
  ALTER COLUMN owner_active DROP DEFAULT,
  ALTER COLUMN archived DROP NOT NULL,
  ALTER COLUMN archived DROP DEFAULT,
  ADD COLUMN archived_at bigint;

ALTER TABLE workspace_channels
  ALTER COLUMN kind DROP NOT NULL,
  ADD COLUMN channel_key text GENERATED ALWAYS AS (
    CASE WHEN project_slug = '' THEN workspace_slug || '/' || channel_id
         ELSE workspace_slug || '/' || project_slug || '/' || channel_id END) STORED;

DROP TRIGGER workspace_channels_change ON workspace_channels;
CREATE TRIGGER workspace_channels_change AFTER INSERT OR UPDATE OR DELETE ON workspace_channels
  FOR EACH ROW EXECUTE FUNCTION record_change('workspaceChannels', 'channel_key', 'filter:workspace_slug');

ALTER TABLE user_deletion_jobs
  ALTER COLUMN uid DROP NOT NULL,
  ALTER COLUMN requested_by DROP NOT NULL,
  ALTER COLUMN erasure_operation_id DROP NOT NULL,
  ALTER COLUMN suspension_operation_id DROP NOT NULL,
  ALTER COLUMN retired_gateway_proofs DROP NOT NULL,
  ALTER COLUMN retired_gateway_proofs DROP DEFAULT;

ALTER TABLE agent_import_pointers
  ADD COLUMN slug text,
  ALTER COLUMN updated_at DROP NOT NULL;

CREATE FUNCTION jsonb_merge_deep(target jsonb, patch jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path FROM CURRENT AS $$
DECLARE
  merged jsonb;
  entry record;
BEGIN
  IF patch IS NULL THEN RETURN target; END IF;
  IF jsonb_typeof(patch) <> 'object' THEN RETURN patch; END IF;
  merged := CASE WHEN jsonb_typeof(target) = 'object' THEN target ELSE '{}'::jsonb END;
  FOR entry IN SELECT key, value FROM jsonb_each(patch) LOOP
    IF entry.value = '{"clear": true}'::jsonb THEN
      merged := merged - entry.key;
    ELSE
      merged := merged || jsonb_build_object(entry.key, jsonb_merge_deep(merged -> entry.key, entry.value));
    END IF;
  END LOOP;
  RETURN merged;
END $$;
`;
const GATEWAY_AGGREGATE_FENCES = String.raw `
ALTER TABLE gateways ADD COLUMN last_error_slug text GENERATED ALWAYS AS (last_error ->> 'slug') STORED;

ALTER TABLE orchestrator_config DROP CONSTRAINT orchestrator_config_shared_users_per_gateway_check;
ALTER TABLE orchestrator_config ADD CONSTRAINT orchestrator_config_shared_users_per_gateway_check
  CHECK (shared_users_per_gateway >= 2);

ALTER TABLE platform_config ADD COLUMN watch_key text GENERATED ALWAYS AS ('platform/' || key) STORED;
DROP TRIGGER platform_config_change ON platform_config;
CREATE TRIGGER platform_config_change AFTER INSERT OR UPDATE OR DELETE ON platform_config
  FOR EACH ROW EXECUTE FUNCTION record_change('config', 'watch_key');
`;
const PROJECT_MEMBERS = String.raw `
CREATE TABLE workspace_project_members (
  workspace_slug text NOT NULL,
  project_slug text NOT NULL,
  uid text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner', 'member')),
  revision bigint NOT NULL DEFAULT nextval('record_revision_seq'),
  PRIMARY KEY (workspace_slug, project_slug, uid),
  FOREIGN KEY (workspace_slug, project_slug) REFERENCES workspace_projects (workspace_slug, project_slug) ON DELETE CASCADE
);
CREATE TRIGGER workspace_project_members_revision BEFORE UPDATE ON workspace_project_members
  FOR EACH ROW EXECUTE FUNCTION bump_revision();
CREATE INDEX workspaces_channel_host_team_idx ON workspaces (channel_provider, channel_installation, channel_host_team_id);
`;
const OPERATION_PORT_FIDELITY = String.raw `
ALTER TABLE operations ALTER COLUMN input DROP NOT NULL;
ALTER TABLE operations ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE operations ALTER COLUMN superseded_by TYPE jsonb USING superseded_by::jsonb;
`;
const CANONICAL_MEMBERSHIPS = String.raw `
ALTER TABLE workspace_members ADD COLUMN channel_host_channel_id text;
ALTER TABLE workspace_members ADD COLUMN canonical_source text;
ALTER TABLE workspace_members ADD COLUMN canonical_state text;
`;
const EDGE_PROJECT_AND_TICKET_STATE = String.raw `
ALTER TABLE workspace_project_members ADD COLUMN joined_at bigint;
CREATE INDEX workspace_project_members_uid_idx ON workspace_project_members (uid);
CREATE TRIGGER workspace_project_members_change AFTER INSERT OR UPDATE OR DELETE ON workspace_project_members
  FOR EACH ROW EXECUTE FUNCTION record_change('workspaceProjectMembers', 'workspace_slug', 'project_slug', 'uid', 'filter:workspace_slug', 'filter:uid');

ALTER TABLE workspace_projects ADD COLUMN provisioning_cleanup jsonb;

CREATE INDEX gateway_tickets_uid_purpose_idx ON gateway_tickets (uid, (access_grant ->> 'purpose'), expires_at);

CREATE TABLE gateway_ticket_mint_log (
  id text PRIMARY KEY,
  uid text NOT NULL,
  purpose text NOT NULL,
  minted_at bigint NOT NULL,
  expires_at bigint NOT NULL
);
CREATE INDEX gateway_ticket_mint_log_uid_purpose_idx ON gateway_ticket_mint_log (uid, purpose, minted_at);
CREATE INDEX gateway_ticket_mint_log_expiry_idx ON gateway_ticket_mint_log (expires_at);
`;
const RUNTIME_SECRET_STORE = String.raw `
CREATE TABLE runtime_secret_key (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  key_id text NOT NULL CHECK (key_id ~ '^[a-f0-9]{64}$')
);

CREATE TABLE runtime_secrets (
  name text PRIMARY KEY,
  labels jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_version integer NOT NULL DEFAULT 0 CHECK (last_version >= 0)
);

CREATE TABLE runtime_secret_versions (
  name text NOT NULL REFERENCES runtime_secrets (name) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  key_id text NOT NULL CHECK (key_id ~ '^[a-f0-9]{64}$'),
  ciphertext text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  PRIMARY KEY (name, version)
);
`;
const META_BROKER_PROVIDER = String.raw `
ALTER TABLE model_broker_tokens
  DROP CONSTRAINT model_broker_tokens_provider_check,
  ADD CONSTRAINT model_broker_tokens_provider_check
  CHECK (provider IN ('anthropic', 'vertex', 'openrouter', 'openai', 'meta'));

ALTER TABLE model_broker_gateway_tokens
  DROP CONSTRAINT model_broker_gateway_tokens_provider_check,
  ADD CONSTRAINT model_broker_gateway_tokens_provider_check
  CHECK (provider IN ('anthropic', 'vertex', 'openrouter', 'openai', 'meta'));
`;
const NEUTRAL_STORED_NAMES = String.raw `
ALTER TABLE operations DROP CONSTRAINT operations_kind_check;
ALTER TABLE operations ADD CONSTRAINT operations_kind_check CHECK (kind IN (
  'add-gateway','gateway-vm','migrate-user','retire-gateway','restart-gateway','recycle-gateway','scale-shared-member',
  'rollout','deprovision-user','suspend-user','erase-user',
  'migrate-customer','deprovision-customer','suspend-customer','erase-customer'));
UPDATE operations SET kind = CASE kind
    WHEN 'migrate-customer' THEN 'migrate-user'
    WHEN 'deprovision-customer' THEN 'deprovision-user'
    WHEN 'suspend-customer' THEN 'suspend-user'
    WHEN 'erase-customer' THEN 'erase-user'
  END
  WHERE kind IN ('migrate-customer','deprovision-customer','suspend-customer','erase-customer');

ALTER TABLE gateway_assignments DROP CONSTRAINT gateway_assignments_source_check;
ALTER TABLE gateway_assignments ADD CONSTRAINT gateway_assignments_source_check
  CHECK (source IN ('onboarding','migrate-user','repair','migrate-customer'));
UPDATE gateway_assignments SET source = 'migrate-user' WHERE source = 'migrate-customer';

UPDATE operation_audits SET mutation = jsonb_set(mutation, '{kind}', to_jsonb(CASE mutation ->> 'kind'
    WHEN 'assign-customer' THEN 'assign-user'
    WHEN 'unassign-customer' THEN 'unassign-user'
    WHEN 'give-isolated-gateway' THEN 'move-to-isolated-gateway'
    WHEN 'schedule-customer-deletion' THEN 'schedule-user-deletion'
    WHEN 'accelerate-customer-erasure' THEN 'accelerate-user-erasure'
    WHEN 'park-builder' THEN 'park-user'
    WHEN 'place-builder' THEN 'place-user'
  END))
  WHERE mutation ->> 'kind' IN ('assign-customer','unassign-customer','give-isolated-gateway','schedule-customer-deletion',
    'accelerate-customer-erasure','park-builder','place-builder');
UPDATE operation_audits SET what = 'move user to an isolated gateway' WHERE what = 'give user an isolated gateway';

ALTER TABLE gateways DROP CONSTRAINT gateways_profile_check;
ALTER TABLE gateways DROP CONSTRAINT gateways_gateway_class_check;
ALTER TABLE gateways DROP CONSTRAINT gateways_image_profile_check;
ALTER TABLE gateways ADD CONSTRAINT gateways_profile_check CHECK (profile IN ('standard','isolated','builder'));
ALTER TABLE gateways ADD CONSTRAINT gateways_gateway_class_check CHECK (gateway_class IN ('shared','isolated','builder'));
ALTER TABLE gateways ADD CONSTRAINT gateways_image_profile_check CHECK (image_profile IN ('standard','isolated','builder'));
UPDATE gateways SET
    profile = CASE WHEN profile = 'builder' THEN 'isolated' ELSE profile END,
    gateway_class = CASE WHEN gateway_class = 'builder' THEN 'isolated' ELSE gateway_class END,
    image_profile = CASE WHEN image_profile = 'builder' THEN 'isolated' ELSE image_profile END
  WHERE 'builder' IN (profile, gateway_class, image_profile);

ALTER TABLE users DROP CONSTRAINT users_gateway_profile_check;
ALTER TABLE users ADD CONSTRAINT users_gateway_profile_check CHECK (gateway_profile IN ('standard','isolated','builder'));
UPDATE users SET gateway_profile = 'isolated' WHERE gateway_profile = 'builder';
`;
const ACTIVITY_RECEIPTS = String.raw `
CREATE TABLE activity_receipts (
  workspace_slug  text NOT NULL,
  project_slug    text NOT NULL,
  channel_id      text NOT NULL,
  receipt_id      text NOT NULL CHECK (receipt_id ~ '^[a-f0-9]{64}$'),
  receipt         jsonb NOT NULL,
  revision        bigint NOT NULL DEFAULT nextval('record_revision_seq'),
  PRIMARY KEY (workspace_slug, project_slug, channel_id, receipt_id),
  FOREIGN KEY (workspace_slug, project_slug, channel_id)
    REFERENCES workspace_channels (workspace_slug, project_slug, channel_id) ON DELETE CASCADE
);
CREATE TRIGGER activity_receipts_revision BEFORE UPDATE ON activity_receipts
  FOR EACH ROW EXECUTE FUNCTION bump_revision();
`;
const USER_ACCOUNTS = String.raw `
CREATE TABLE user_accounts (
  uid         text PRIMARY KEY REFERENCES users (uid) ON DELETE CASCADE,
  name        text NOT NULL UNIQUE CHECK (name <> ''),
  email       text NOT NULL UNIQUE CHECK (email <> '' AND email = lower(email)),
  created_at  bigint NOT NULL,
  revision    bigint NOT NULL DEFAULT nextval('record_revision_seq')
);
`;
const MODEL_BROKER_USAGE = String.raw `
CREATE TABLE model_broker_usage_events (
  event_id    text PRIMARY KEY CHECK (event_id <> ''),
  owner_key   text NOT NULL CHECK (owner_key <> ''),
  created_at  bigint NOT NULL,
  expires_at  bigint NOT NULL,
  event       jsonb NOT NULL CHECK (jsonb_typeof(event) = 'object')
);
CREATE INDEX model_broker_usage_events_expiry_idx ON model_broker_usage_events (expires_at);

CREATE TABLE model_broker_spend_periods (
  owner_key      text NOT NULL CHECK (owner_key <> ''),
  period         text NOT NULL CHECK (period IN ('window', 'week')),
  start_ms       bigint NOT NULL,
  request_count  bigint NOT NULL CHECK (request_count > 0),
  total_tokens   bigint NOT NULL CHECK (total_tokens >= 0),
  cost_usd       double precision NOT NULL CHECK (cost_usd >= 0),
  charge_usd     double precision NOT NULL CHECK (charge_usd >= 0),
  PRIMARY KEY (owner_key, period)
);

CREATE TABLE model_broker_rate_windows (
  owner_key      text PRIMARY KEY CHECK (owner_key <> ''),
  start_ms       bigint NOT NULL,
  request_count  integer NOT NULL CHECK (request_count > 0)
);
`;
const NEUTRAL_STORED_NAMES_ONLY = String.raw `
UPDATE operations SET kind = CASE kind
    WHEN 'migrate-customer' THEN 'migrate-user'
    WHEN 'deprovision-customer' THEN 'deprovision-user'
    WHEN 'suspend-customer' THEN 'suspend-user'
    WHEN 'erase-customer' THEN 'erase-user'
  END
  WHERE kind IN ('migrate-customer','deprovision-customer','suspend-customer','erase-customer');
ALTER TABLE operations DROP CONSTRAINT operations_kind_check;
ALTER TABLE operations ADD CONSTRAINT operations_kind_check CHECK (kind IN (
  'add-gateway','gateway-vm','migrate-user','retire-gateway','restart-gateway','recycle-gateway','scale-shared-member',
  'rollout','deprovision-user','suspend-user','erase-user'));

UPDATE gateway_assignments SET source = 'migrate-user' WHERE source = 'migrate-customer';
ALTER TABLE gateway_assignments DROP CONSTRAINT gateway_assignments_source_check;
ALTER TABLE gateway_assignments ADD CONSTRAINT gateway_assignments_source_check
  CHECK (source IN ('onboarding','migrate-user','repair'));

UPDATE operation_audits SET mutation = jsonb_set(mutation, '{kind}', to_jsonb(CASE mutation ->> 'kind'
    WHEN 'assign-customer' THEN 'assign-user'
    WHEN 'unassign-customer' THEN 'unassign-user'
    WHEN 'give-isolated-gateway' THEN 'move-to-isolated-gateway'
    WHEN 'schedule-customer-deletion' THEN 'schedule-user-deletion'
    WHEN 'accelerate-customer-erasure' THEN 'accelerate-user-erasure'
    WHEN 'park-builder' THEN 'park-user'
    WHEN 'place-builder' THEN 'place-user'
  END))
  WHERE mutation ->> 'kind' IN ('assign-customer','unassign-customer','give-isolated-gateway','schedule-customer-deletion',
    'accelerate-customer-erasure','park-builder','place-builder');

UPDATE gateways SET
    profile = CASE WHEN profile = 'builder' THEN 'isolated' ELSE profile END,
    gateway_class = CASE WHEN gateway_class = 'builder' THEN 'isolated' ELSE gateway_class END,
    image_profile = CASE WHEN image_profile = 'builder' THEN 'isolated' ELSE image_profile END
  WHERE 'builder' IN (profile, gateway_class, image_profile);
ALTER TABLE gateways DROP CONSTRAINT gateways_profile_check;
ALTER TABLE gateways DROP CONSTRAINT gateways_gateway_class_check;
ALTER TABLE gateways DROP CONSTRAINT gateways_image_profile_check;
ALTER TABLE gateways ADD CONSTRAINT gateways_profile_check CHECK (profile IN ('standard','isolated'));
ALTER TABLE gateways ADD CONSTRAINT gateways_gateway_class_check CHECK (gateway_class IN ('shared','isolated'));
ALTER TABLE gateways ADD CONSTRAINT gateways_image_profile_check CHECK (image_profile IN ('standard','isolated'));

UPDATE users SET gateway_profile = 'isolated' WHERE gateway_profile = 'builder';
ALTER TABLE users DROP CONSTRAINT users_gateway_profile_check;
ALTER TABLE users ADD CONSTRAINT users_gateway_profile_check CHECK (gateway_profile IN ('standard','isolated'));

UPDATE operations SET user_migration_v2 = jsonb_set(user_migration_v2, '{sourceRootFence,gatewayClass}', '"isolated"')
  WHERE user_migration_v2 #>> '{sourceRootFence,gatewayClass}' = 'builder';
UPDATE operations SET user_migration_v2 = jsonb_set(user_migration_v2, '{targetRootFence,gatewayClass}', '"isolated"')
  WHERE user_migration_v2 #>> '{targetRootFence,gatewayClass}' = 'builder';

UPDATE operations SET input = input || jsonb_build_object('userSlug', input -> 'builderSlug')
  WHERE input ? 'builderSlug' AND NOT input ? 'userSlug';
DROP INDEX operations_user_slug_idx;
ALTER TABLE operations DROP COLUMN input_user_slug;
ALTER TABLE operations ADD COLUMN input_user_slug text
  GENERATED ALWAYS AS (COALESCE(input ->> 'userSlug', input ->> 'builderSlug')) STORED;
CREATE INDEX operations_user_slug_idx ON operations (input_user_slug text_pattern_ops);
`;
export const PLATFORM_STATE_MIGRATIONS = [
    { version: 1, name: "core-schema", sql: CORE_SCHEMA },
    { version: 2, name: "change-feed", sql: CHANGE_FEED },
    { version: 3, name: "user-constraints", sql: USER_CONSTRAINTS },
    { version: 4, name: "workspace-and-job-fidelity", sql: WORKSPACE_AND_JOB_FIDELITY },
    { version: 5, name: "gateway-aggregate-fences", sql: GATEWAY_AGGREGATE_FENCES },
    { version: 6, name: "project-members", sql: PROJECT_MEMBERS },
    { version: 7, name: "operation-port-fidelity", sql: OPERATION_PORT_FIDELITY },
    { version: 8, name: "canonical-memberships", sql: CANONICAL_MEMBERSHIPS },
    { version: 9, name: "edge-project-and-ticket-state", sql: EDGE_PROJECT_AND_TICKET_STATE },
    { version: 10, name: "runtime-secret-store", sql: RUNTIME_SECRET_STORE },
    { version: 11, name: "meta-broker-provider", sql: META_BROKER_PROVIDER },
    { version: 12, name: "neutral-stored-names", sql: NEUTRAL_STORED_NAMES },
    { version: 13, name: "activity-receipts", sql: ACTIVITY_RECEIPTS },
    { version: 14, name: "user-accounts", sql: USER_ACCOUNTS },
    { version: 15, name: "model-broker-usage", sql: MODEL_BROKER_USAGE },
    { version: 16, name: "neutral-stored-names-only", sql: NEUTRAL_STORED_NAMES_ONLY },
];
