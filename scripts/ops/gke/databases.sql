\getenv mattermost_password MATTERMOST_PASSWORD
\getenv gitea_password GITEA_PASSWORD
\getenv platform_migration_password PLATFORM_MIGRATION_PASSWORD
\getenv platform_runtime_password PLATFORM_RUNTIME_PASSWORD
\getenv agent_admin_password AGENT_ADMIN_PASSWORD
SELECT format('CREATE ROLE %I LOGIN', name)
FROM (VALUES ('mattermost'), ('gitea'), ('platform_migration'), ('platform_runtime')) AS roles(name)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = name)
\gexec
SELECT 'CREATE ROLE agent_admin LOGIN CREATEROLE'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agent_admin')
\gexec
ALTER ROLE mattermost PASSWORD :'mattermost_password';
ALTER ROLE gitea PASSWORD :'gitea_password';
ALTER ROLE platform_migration PASSWORD :'platform_migration_password';
ALTER ROLE platform_runtime PASSWORD :'platform_runtime_password';
ALTER ROLE agent_admin PASSWORD :'agent_admin_password';
GRANT mattermost, gitea, platform_migration, agent_admin TO CURRENT_USER;
SELECT format('CREATE DATABASE %I OWNER %I', name, owner)
FROM (VALUES ('mattermost', 'mattermost'), ('gitea', 'gitea'),
             ('octogee_platform', 'platform_migration'), ('octogee_agents', 'agent_admin')) AS databases(name, owner)
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = name)
\gexec
