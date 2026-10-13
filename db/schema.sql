CREATE TABLE IF NOT EXISTS accounts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  twitch_user_id VARCHAR(64) NOT NULL,
  twitch_login VARCHAR(64) NOT NULL,
  twitch_display_name VARCHAR(64) NOT NULL,
  is_approver BOOLEAN NOT NULL DEFAULT FALSE,
  current_rundown_id BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_accounts_twitch_user_id (twitch_user_id),
  UNIQUE KEY uq_accounts_twitch_login (twitch_login)
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

CREATE TABLE IF NOT EXISTS account_tokens (
  account_id BIGINT UNSIGNED NOT NULL,
  token_hash CHAR(64) NOT NULL,
  token_ciphertext VARCHAR(255) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (account_id),
  UNIQUE KEY uq_account_tokens_hash (token_hash),
  CONSTRAINT fk_account_tokens_account FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE
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
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (entry_id),
  KEY idx_render_instances_account (account_id),
  CONSTRAINT fk_render_instances_entry FOREIGN KEY (entry_id) REFERENCES my_graphics_entries (id) ON DELETE CASCADE,
  CONSTRAINT fk_render_instances_account FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
