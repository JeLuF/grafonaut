CREATE TABLE IF NOT EXISTS accounts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  twitch_user_id VARCHAR(64) NOT NULL,
  twitch_login VARCHAR(64) NOT NULL,
  twitch_display_name VARCHAR(64) NOT NULL,
  is_approver BOOLEAN NOT NULL DEFAULT FALSE,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_accounts_twitch_user_id (twitch_user_id),
  UNIQUE KEY uq_accounts_twitch_login (twitch_login)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

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
  CONSTRAINT fk_mvp_packages_owner FOREIGN KEY (owner_account_id) REFERENCES accounts (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS package_versions (
  id CHAR(36) NOT NULL,
  package_id CHAR(36) NOT NULL,
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
  UNIQUE KEY uq_mvp_version_checksum (zip_checksum_sha256),
  KEY idx_mvp_versions_catalog (package_id, review_state),
  CONSTRAINT fk_mvp_versions_package FOREIGN KEY (package_id) REFERENCES packages (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

ALTER TABLE package_versions ADD COLUMN manifest_file_relpath VARCHAR(512) NULL;

ALTER TABLE packages
  ADD CONSTRAINT fk_mvp_packages_latest FOREIGN KEY (latest_version_id) REFERENCES package_versions (id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_mvp_packages_published FOREIGN KEY (current_published_version_id) REFERENCES package_versions (id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS my_graphics_entries (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  account_id BIGINT UNSIGNED NOT NULL,
  package_version_id CHAR(36) NOT NULL,
  label VARCHAR(100) NULL,
  schema_data JSON NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT fk_mvp_entries_account FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE,
  CONSTRAINT fk_mvp_entries_version FOREIGN KEY (package_version_id) REFERENCES package_versions (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
