CREATE OR REPLACE TEMP VIEW agent_store_reset_roles AS
WITH store AS (
  SELECT datdba, datacl FROM pg_catalog.pg_database WHERE datname = pg_catalog.current_database()
), owners AS (
  SELECT DISTINCT acl.grantee AS oid
  FROM store, pg_catalog.aclexplode(store.datacl) acl
  WHERE acl.grantee <> 0 AND acl.grantee <> store.datdba
), logins AS (
  SELECT DISTINCT m.member AS oid
  FROM pg_catalog.pg_auth_members m JOIN owners o ON o.oid = m.roleid, store
  WHERE m.member <> store.datdba
)
SELECT r.oid, r.rolname
FROM pg_catalog.pg_roles r
WHERE r.oid IN (SELECT oid FROM owners UNION SELECT oid FROM logins);

DO $reset$
DECLARE
  unexpected text;
BEGIN
  IF (SELECT datdba FROM pg_catalog.pg_database WHERE datname = pg_catalog.current_database())
     <> (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'agent store % is not owned by %', pg_catalog.current_database(), current_user;
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_extension WHERE extname IN ('unaccent', 'pg_trgm', 'vector')) <> 3 THEN
    RAISE EXCEPTION 'agent store % is missing one of the unaccent, pg_trgm and vector extensions', pg_catalog.current_database();
  END IF;
  SELECT string_agg(rolname, ', ' ORDER BY rolname) INTO unexpected
  FROM agent_store_reset_roles
  WHERE rolname !~ '^octogee_(gateway|shared|unclaimed|builder)_[0-9a-f]{24}$';
  IF unexpected IS NOT NULL THEN
    RAISE EXCEPTION 'agent store % grants roles the fleet did not create: %', pg_catalog.current_database(), unexpected;
  END IF;
  SELECT string_agg(r.rolname, ', ' ORDER BY r.rolname) INTO unexpected
  FROM agent_store_reset_roles r
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members m
    WHERE m.roleid = r.oid AND m.admin_option
      AND m.member = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)
  );
  IF unexpected IS NOT NULL THEN
    RAISE EXCEPTION '% does not administer agent-store roles: %', current_user, unexpected;
  END IF;
  SELECT string_agg(n.nspname, ', ' ORDER BY n.nspname) INTO unexpected
  FROM pg_catalog.pg_namespace n
  WHERE n.nspname NOT IN ('public', 'information_schema') AND n.nspname !~ '^pg_'
    AND n.nspowner <> (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)
    AND n.nspowner NOT IN (SELECT oid FROM agent_store_reset_roles);
  IF unexpected IS NOT NULL THEN
    RAISE EXCEPTION 'agent store % has schemas owned outside its fleet: %', pg_catalog.current_database(), unexpected;
  END IF;
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO unexpected
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_depend d
      WHERE d.classid = 'pg_catalog.pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e'
    );
  IF unexpected IS NOT NULL THEN
    RAISE EXCEPTION 'agent store % has relations in public: %', pg_catalog.current_database(), unexpected;
  END IF;
  PERFORM pg_catalog.pg_stat_clear_snapshot();
  SELECT string_agg(DISTINCT coalesce(a.usename::text, a.usesysid::text), ', ') INTO unexpected
  FROM pg_catalog.pg_stat_activity a
  WHERE a.datname = pg_catalog.current_database() AND a.pid <> pg_catalog.pg_backend_pid()
    AND a.backend_type = 'client backend'
    AND a.usesysid NOT IN (SELECT oid FROM agent_store_reset_roles);
  IF unexpected IS NOT NULL THEN
    RAISE EXCEPTION 'agent store % has sessions from roles outside its fleet: %', pg_catalog.current_database(), unexpected;
  END IF;
END
$reset$;

BEGIN;
DO $reset$
DECLARE
  fleet record;
BEGIN
  FOR fleet IN SELECT rolname FROM agent_store_reset_roles ORDER BY rolname LOOP
    EXECUTE format('ALTER ROLE %I NOLOGIN', fleet.rolname);
  END LOOP;
END
$reset$;
COMMIT;

BEGIN;
DO $reset$
DECLARE
  fleet record;
  deadline timestamptz := pg_catalog.clock_timestamp() + interval '30 seconds';
  remaining text;
BEGIN
  PERFORM pg_catalog.pg_stat_clear_snapshot();
  FOR fleet IN
    SELECT DISTINCT r.oid, r.rolname
    FROM agent_store_reset_roles r JOIN pg_catalog.pg_stat_activity a ON a.usesysid = r.oid
    WHERE a.datname = pg_catalog.current_database() AND a.pid <> pg_catalog.pg_backend_pid()
    ORDER BY r.rolname
  LOOP
    EXECUTE format('GRANT %I TO CURRENT_USER WITH SET TRUE', fleet.rolname);
    EXECUTE format('SET LOCAL ROLE %I', fleet.rolname);
    PERFORM pg_catalog.pg_terminate_backend(a.pid)
    FROM pg_catalog.pg_stat_activity a
    WHERE a.usesysid = fleet.oid AND a.datname = pg_catalog.current_database();
    RESET ROLE;
  END LOOP;
  LOOP
    PERFORM pg_catalog.pg_stat_clear_snapshot();
    SELECT string_agg(DISTINCT coalesce(a.usename::text, a.usesysid::text), ', ') INTO remaining
    FROM pg_catalog.pg_stat_activity a
    WHERE a.datname = pg_catalog.current_database() AND a.pid <> pg_catalog.pg_backend_pid()
      AND a.backend_type = 'client backend';
    EXIT WHEN remaining IS NULL;
    IF pg_catalog.clock_timestamp() > deadline THEN
      RAISE EXCEPTION 'agent store % still has sessions from %', pg_catalog.current_database(), remaining;
    END IF;
    PERFORM pg_catalog.pg_sleep(0.2);
  END LOOP;
END
$reset$;
COMMIT;

SET lock_timeout = '10s';

SELECT pg_catalog.format('GRANT %I TO CURRENT_USER WITH INHERIT TRUE, SET TRUE', rolname)
FROM agent_store_reset_roles
ORDER BY rolname
\gexec

SELECT pg_catalog.format('DROP SCHEMA %I CASCADE', nspname)
FROM pg_catalog.pg_namespace
WHERE nspname NOT IN ('public', 'information_schema') AND nspname !~ '^pg_'
ORDER BY nspname
\gexec

SELECT pg_catalog.format('DO $drop$ BEGIN EXECUTE %L; EXECUTE %L; END $drop$',
  pg_catalog.format('DROP OWNED BY %I CASCADE', r.rolname), pg_catalog.format('DROP ROLE %I', r.rolname))
FROM agent_store_reset_roles r
ORDER BY EXISTS (
  SELECT 1 FROM pg_catalog.pg_database d, pg_catalog.aclexplode(d.datacl) acl
  WHERE d.datname = pg_catalog.current_database() AND acl.grantee = r.oid
), r.rolname
\gexec

DO $reset$
DECLARE
  leftover text;
BEGIN
  SELECT string_agg(rolname, ', ' ORDER BY rolname) INTO leftover FROM agent_store_reset_roles;
  IF leftover IS NOT NULL THEN
    RAISE EXCEPTION 'agent store % still grants roles: %', pg_catalog.current_database(), leftover;
  END IF;
  SELECT string_agg(nspname, ', ' ORDER BY nspname) INTO leftover
  FROM pg_catalog.pg_namespace
  WHERE nspname NOT IN ('public', 'information_schema') AND nspname !~ '^pg_';
  IF leftover IS NOT NULL THEN
    RAISE EXCEPTION 'agent store % still has schemas: %', pg_catalog.current_database(), leftover;
  END IF;
  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO leftover
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_depend d
      WHERE d.classid = 'pg_catalog.pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e'
    );
  IF leftover IS NOT NULL THEN
    RAISE EXCEPTION 'agent store % still has relations in public: %', pg_catalog.current_database(), leftover;
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_extension WHERE extname IN ('unaccent', 'pg_trgm', 'vector')) <> 3 THEN
    RAISE EXCEPTION 'agent store % lost one of its extensions', pg_catalog.current_database();
  END IF;
END
$reset$;

SELECT 'OCTOGEE_AGENT_STORE_RESET=' || pg_catalog.current_database();
