-- Machine tokens for the MCP server's HTTP transport (docs/mcp-server-plan.md
-- decision D3). Only the SHA-256 hash of the presented token is stored; the
-- plaintext is shown once at issuance. Read-only scope at launch.
create table api_tokens (
  id bigint generated always as identity primary key,
  workspace_id bigint not null references workspaces (id),
  label text not null,
  token_hash text not null unique,
  scopes text[] not null default '{mcp:read}',
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

create index api_tokens_workspace_idx on api_tokens (workspace_id);
