CREATE TABLE IF NOT EXISTS accounts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  -- Each login provider has its own accounts; the same person signing in with Twitch and Google gets two accounts.
  provider ENUM('twitch','google') NOT NULL,
  provider_user_id VARCHAR(255) NOT NULL,
  login VARCHAR(255) NULL,
  display_name VARCHAR(255) NOT NULL,
  is_approver BOOLEAN NOT NULL DEFAULT FALSE,
  current_rundown_id BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_accounts_provider_user (provider, provider_user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- A rundown groups My Graphics entries for one event. The account's current rundown is what the renderer shows.
CREATE TABLE IF NOT EXISTS rundowns (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  account_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(100) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_rundowns_account_name (account_id, name),
  CONSTRAINT fk_rundowns_account FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

ALTER TABLE accounts
  ADD CONSTRAINT fk_accounts_current_rundown FOREIGN KEY (current_rundown_id) REFERENCES rundowns (id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS packages (
  id CHAR(36) NOT NULL,
  owner_account_id BIGINT UNSIGNED NULL,
  manifest_id VARCHAR(255) NOT NULL,
  display_name VARCHAR(255) NULL,
  latest_version_id CHAR(36) NULL,
  current_published_version_id CHAR(36) NULL,
  disabled BOOLEAN NOT NULL DEFAULT FALSE,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_packages_catalog (disabled, current_published_version_id),
  UNIQUE KEY uq_packages_owner_manifest (owner_account_id, manifest_id),
  CONSTRAINT fk_mvp_packages_owner FOREIGN KEY (owner_account_id) REFERENCES accounts (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS package_versions (
  id CHAR(36) NOT NULL,
  package_id CHAR(36) NOT NULL,
  -- The unpacked upload this version's files live in (storage/archives/<archive_id>); all graphics of one
  -- .ograf.zip share it.
  archive_id CHAR(36) NOT NULL,
  version_label VARCHAR(64) NOT NULL,
  manifest_name VARCHAR(255) NOT NULL,
  manifest_description TEXT NULL,
  manifest_json JSON NOT NULL,
  manifest_file_relpath VARCHAR(512) NULL,
  main_file_relpath VARCHAR(512) NOT NULL,
  zip_checksum_sha256 CHAR(64) NOT NULL,
  zip_size_bytes INT UNSIGNED NOT NULL,
  uncompressed_size_bytes INT UNSIGNED NOT NULL,
  file_count INT UNSIGNED NOT NULL,
  source ENUM('user_upload','seed_builtin','seed_volume') NOT NULL DEFAULT 'user_upload',
  uploaded_by_account_id BIGINT UNSIGNED NULL,
  review_state ENUM('draft','pending','published','rejected') NOT NULL DEFAULT 'draft',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_versions_checksum (zip_checksum_sha256),
  KEY idx_versions_archive (archive_id),
  KEY idx_mvp_versions_catalog (package_id, review_state),
  CONSTRAINT fk_mvp_versions_package FOREIGN KEY (package_id) REFERENCES packages (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

ALTER TABLE packages
  ADD CONSTRAINT fk_mvp_packages_latest FOREIGN KEY (latest_version_id) REFERENCES package_versions (id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_mvp_packages_published FOREIGN KEY (current_published_version_id) REFERENCES package_versions (id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS my_graphics_entries (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  account_id BIGINT UNSIGNED NOT NULL,
  rundown_id BIGINT UNSIGNED NOT NULL,
  package_version_id CHAR(36) NOT NULL,
  label VARCHAR(100) NULL,
  schema_data JSON NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  sort_position BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_entries_rundown (rundown_id, sort_position),
  CONSTRAINT fk_mvp_entries_account FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE,
  CONSTRAINT fk_entries_rundown FOREIGN KEY (rundown_id) REFERENCES rundowns (id) ON DELETE CASCADE,
  CONSTRAINT fk_mvp_entries_version FOREIGN KEY (package_version_id) REFERENCES package_versions (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS renderer_tokens (
  account_id BIGINT UNSIGNED NOT NULL,
  token_hash CHAR(64) NOT NULL,
  token_ciphertext VARCHAR(255) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (account_id),
  UNIQUE KEY uq_renderer_tokens_hash (token_hash),
  CONSTRAINT fk_renderer_tokens_account FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS api_tokens (
  account_id BIGINT UNSIGNED NOT NULL,
  token_hash CHAR(64) NOT NULL,
  token_ciphertext VARCHAR(255) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (account_id),
  UNIQUE KEY uq_api_tokens_hash (token_hash),
  CONSTRAINT fk_api_tokens_account FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS render_instances (
  entry_id BIGINT UNSIGNED NOT NULL,
  account_id BIGINT UNSIGNED NOT NULL,
  instance_id VARCHAR(64) NOT NULL,
  data JSON NOT NULL,
  current_step INT NULL,
  playing BOOLEAN NOT NULL DEFAULT FALSE,
  -- The graphic reached its end node (one-shot graphic played, played past its last step, or stopped).
  ended BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (entry_id),
  KEY idx_render_instances_account (account_id),
  CONSTRAINT fk_render_instances_entry FOREIGN KEY (entry_id) REFERENCES my_graphics_entries (id) ON DELETE CASCADE,
  CONSTRAINT fk_render_instances_account FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Named groups of actions on the entries of a rundown, triggered with one click (FE-7). Steps are stored as JSON:
-- { type: play|stop|update, entryId } | { type: custom, entryId, actionId, payload } | { type: sleep, ms }.
CREATE TABLE IF NOT EXISTS group_actions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  account_id BIGINT UNSIGNED NOT NULL,
  rundown_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(100) NOT NULL,
  steps JSON NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_group_actions_rundown (rundown_id),
  CONSTRAINT fk_group_actions_account FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE,
  CONSTRAINT fk_group_actions_rundown FOREIGN KEY (rundown_id) REFERENCES rundowns (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Media library: files an account uploads for graphic properties (e.g. images). Stored as
-- storage/media/<account_id>/<id>.<extension> and served to graphics as /render/media/<id>.<extension>.
CREATE TABLE IF NOT EXISTS media (
  id CHAR(36) NOT NULL,
  account_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(255) NOT NULL,
  extension VARCHAR(16) NOT NULL,
  size_bytes INT UNSIGNED NOT NULL,
  checksum_sha256 CHAR(64) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_media_account (account_id, created_at),
  CONSTRAINT fk_media_account FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- MCP interface (MCP.md): OAuth clients registered through dynamic client registration. `metadata` is the client
-- information returned at registration (redirect URIs, name, ...); the secret of confidential clients is stored
-- encrypted like the account tokens.
CREATE TABLE IF NOT EXISTS oauth_clients (
  id CHAR(36) NOT NULL,
  secret_ciphertext VARCHAR(255) NULL,
  metadata JSON NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- One grant per approved authorization of a client for an account. It holds the current access token and refresh
-- token (SHA-256 hashes; both are replaced at every refresh) and is what the user sees and revokes as a connected app.
CREATE TABLE IF NOT EXISTS mcp_grants (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  account_id BIGINT UNSIGNED NOT NULL,
  client_id CHAR(36) NOT NULL,
  scope VARCHAR(255) NOT NULL,
  resource VARCHAR(512) NOT NULL,
  access_token_hash CHAR(64) NOT NULL,
  access_expires_at DATETIME NOT NULL,
  refresh_token_hash CHAR(64) NOT NULL,
  -- The refresh token replaced at the last refresh: presenting it again means it was copied, and revokes the grant.
  previous_refresh_hash CHAR(64) NULL,
  refresh_expires_at DATETIME NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_mcp_grants_access (access_token_hash),
  UNIQUE KEY uq_mcp_grants_refresh (refresh_token_hash),
  KEY idx_mcp_grants_previous (previous_refresh_hash),
  KEY idx_mcp_grants_account (account_id),
  CONSTRAINT fk_mcp_grants_account FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE,
  CONSTRAINT fk_mcp_grants_client FOREIGN KEY (client_id) REFERENCES oauth_clients (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Changes made through the MCP interface, shown to the account on the Renderer page (kept for 90 days).
CREATE TABLE IF NOT EXISTS mcp_activity (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  account_id BIGINT UNSIGNED NOT NULL,
  client_name VARCHAR(255) NOT NULL,
  tool VARCHAR(64) NOT NULL,
  summary VARCHAR(255) NOT NULL,
  ok BOOLEAN NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_mcp_activity_account (account_id, created_at),
  CONSTRAINT fk_mcp_activity_account FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
