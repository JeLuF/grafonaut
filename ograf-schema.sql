-- =============================================================================
-- OGraf Hosting & Rendering Platform - MySQL schema
--
-- Derived from ograf-platform-requirements.md. See ograf-schema.mermaid for the
-- accompanying ER diagram.
--
-- Requires MySQL 8.0.16+ (CHECK constraints, JSON expression defaults).
--
-- Design notes / assumptions made while turning the requirements into a schema
-- (none of these are called out explicitly in the requirements doc, flagging
-- them here so they're easy to revisit):
--
--   * "Disable" (packages.disabled, §3/§11) and a My Graphics entry's own
--     "enable/disable" (my_graphics_entries.enabled, §3) are modelled as two
--     independent flags at two different levels: one on the package itself
--     (personal-or-moderation kill switch, affects everyone referencing it),
--     one per user-owned entry (purely personal, affects only that user).
--   * A My Graphics entry (my_graphics_entries) references a *package*, not a
--     fixed package_version. Which version it actually resolves to at
--     load-time is application logic: the owner's own package always
--     resolves to packages.latest_version_id (so they can use/test unpublished
--     uploads immediately); a catalog package added by someone other than its
--     owner resolves to packages.current_published_version_id (so nobody sees
--     another account's unpublished/unreviewed content). §7's version
--     immutability guarantee ("a running render instance keeps using the
--     version it loaded until explicitly updated") is enforced at the
--     application/render-instance layer, not by pinning a version_id here.
--   * renderer_connections models live WebSocket connections in MySQL for
--     completeness (§8 lists it as an expected table). In a horizontally
--     scaled deployment this is churny, process-local, ephemeral state that
--     may fit a fast in-memory store (e.g. Redis) better than MySQL - worth
--     revisiting under BE-8.
--   * XC-2 (moderation reporting/flagging, ToS) is explicitly "not yet
--     scoped" in §11, so no table is created for it here.
--   * API tokens: §5 describes a single account-specific token, stored
--     encrypted at rest with a server-held key (not one-way hashed) so it can
--     be decrypted and redisplayed in settings on demand, same as Twitch does
--     for stream keys - an accepted tradeoff given the token's low blast
--     radius (it only controls that account's own stream overlays). Modelled
--     as one ciphertext column on accounts rather than a separate
--     token-history table, since no multi-token or rotation-history
--     requirement was stated; api_token_key_version exists so a future
--     encryption-key rotation can identify which rows need re-encrypting.
-- =============================================================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- -----------------------------------------------------------------------------
-- accounts - one row per Twitch-authenticated account (§4, §5)
-- -----------------------------------------------------------------------------
DROP TABLE IF EXISTS accounts;
CREATE TABLE accounts (
    id                      BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    twitch_user_id          VARCHAR(64)  NOT NULL,
    twitch_login            VARCHAR(64)  NOT NULL COMMENT 'logged instead of the API token, §5',
    twitch_display_name     VARCHAR(64)  NOT NULL,
    is_approver             BOOLEAN      NOT NULL DEFAULT FALSE COMMENT 'additive to User, §4',
    api_token_encrypted     VARBINARY(255) NULL COMMENT 'AES-256-GCM ciphertext (IV+tag+token) of the current OGraf API token, §5; decryptable on demand, not one-way hashed',
    api_token_key_version   TINYINT UNSIGNED NULL COMMENT 'which server-held encryption key encrypted this value, for future key rotation',
    api_token_created_at    DATETIME     NULL,
    created_at              DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at              DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_accounts_twitch_user_id (twitch_user_id),
    UNIQUE KEY uq_accounts_twitch_login (twitch_login)
    -- no uniqueness constraint on api_token_encrypted: AES-GCM's random IV means
    -- ciphertext differs even for identical plaintext tokens, so the DB can't
    -- enforce token uniqueness the way it could on a hash. Relying on the
    -- token's own entropy (32+ random bytes) instead, same as for UUIDs.
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -----------------------------------------------------------------------------
-- packages - one row per logical package; a package may have several
-- immutable versions (package_versions). §7, §8
-- -----------------------------------------------------------------------------
DROP TABLE IF EXISTS packages;
CREATE TABLE packages (
    id                              CHAR(36)     NOT NULL COMMENT 'UUID, also the storage dir name, §7',
    owner_account_id                BIGINT UNSIGNED NULL COMMENT 'NULL = platform/seed-provided package',
    manifest_id                     VARCHAR(255) NOT NULL COMMENT 'the package''s own declared id, informational only, §7',
    display_name                    VARCHAR(255) NULL COMMENT 'denormalized cache of current/latest version''s manifest name',
    latest_version_id               CHAR(36)     NULL COMMENT 'most recent upload; owner''s private/testing default',
    current_published_version_id    CHAR(36)     NULL COMMENT 'version currently live in the public catalog',
    disabled                        BOOLEAN      NOT NULL DEFAULT FALSE COMMENT 'personal or moderation kill-switch, §3/§11',
    disabled_by_account_id          BIGINT UNSIGNED NULL,
    disabled_at                     DATETIME     NULL,
    created_at                      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at                      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_packages_owner (owner_account_id),
    KEY idx_packages_catalog (disabled, current_published_version_id),
    CONSTRAINT fk_packages_owner
        FOREIGN KEY (owner_account_id) REFERENCES accounts (id) ON DELETE SET NULL,
    CONSTRAINT fk_packages_disabled_by
        FOREIGN KEY (disabled_by_account_id) REFERENCES accounts (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -----------------------------------------------------------------------------
-- package_versions - one row per uploaded/imported .ograf.zip, immutable
-- once created (§6, §7)
-- -----------------------------------------------------------------------------
DROP TABLE IF EXISTS package_versions;
CREATE TABLE package_versions (
    id                          CHAR(36)     NOT NULL COMMENT 'UUID, also the storage dir name, §7',
    package_id                  CHAR(36)     NOT NULL,
    version_label                VARCHAR(64)  NOT NULL COMMENT 'manifest''s own declared version string',
    manifest_name                VARCHAR(255) NOT NULL,
    manifest_description         TEXT         NULL,
    manifest_json                 JSON         NOT NULL COMMENT 'full parsed manifest incl. schema, drives FE-5 property dialog',
    main_file_relpath            VARCHAR(512) NOT NULL COMMENT 'validated .mjs entry point path, relative to this version''s storage dir, §6',
    zip_checksum_sha256          CHAR(64)     NOT NULL COMMENT 'used for the rejected-resubmission block, §6/§7',
    zip_size_bytes                INT UNSIGNED NOT NULL COMMENT 'must be <= 10 MB at upload time, §6',
    uncompressed_size_bytes       INT UNSIGNED NOT NULL COMMENT 'must be <= 50 MB, enforced during streaming extraction, §6',
    file_count                    INT UNSIGNED NOT NULL COMMENT 'must be <= 5000, §6',
    source                        ENUM('user_upload','seed_builtin','seed_volume') NOT NULL DEFAULT 'user_upload' COMMENT '§2, BE-6',
    uploaded_by_account_id       BIGINT UNSIGNED NULL COMMENT 'NULL for seed-imported versions',
    review_state                  ENUM('draft','pending','published','rejected') NOT NULL DEFAULT 'draft' COMMENT '§11',
    submitted_for_review_at      DATETIME     NULL,
    reviewed_by_account_id       BIGINT UNSIGNED NULL,
    reviewed_at                   DATETIME     NULL,
    reviewer_note                  TEXT         NULL COMMENT 'optional on approval, required on rejection, §4/§11',
    created_at                    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_versions_package (package_id),
    KEY idx_versions_checksum (zip_checksum_sha256),
    KEY idx_versions_review_state (review_state),
    CONSTRAINT fk_versions_package
        FOREIGN KEY (package_id) REFERENCES packages (id) ON DELETE CASCADE,
    CONSTRAINT fk_versions_uploaded_by
        FOREIGN KEY (uploaded_by_account_id) REFERENCES accounts (id) ON DELETE SET NULL,
    CONSTRAINT fk_versions_reviewed_by
        FOREIGN KEY (reviewed_by_account_id) REFERENCES accounts (id) ON DELETE SET NULL,
    CONSTRAINT chk_versions_size CHECK (zip_size_bytes <= 10 * 1024 * 1024),
    CONSTRAINT chk_versions_uncompressed_size CHECK (uncompressed_size_bytes <= 50 * 1024 * 1024),
    CONSTRAINT chk_versions_file_count CHECK (file_count <= 5000),
    CONSTRAINT chk_versions_reject_requires_note
        CHECK (review_state <> 'rejected' OR reviewer_note IS NOT NULL)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- circular FKs from packages -> package_versions, added after both tables exist
ALTER TABLE packages
    ADD CONSTRAINT fk_packages_latest_version
        FOREIGN KEY (latest_version_id) REFERENCES package_versions (id) ON DELETE SET NULL,
    ADD CONSTRAINT fk_packages_current_published_version
        FOREIGN KEY (current_published_version_id) REFERENCES package_versions (id) ON DELETE SET NULL;

-- -----------------------------------------------------------------------------
-- my_graphics_entries - one row per item in a user's "My Graphics" view; the
-- same package may be referenced by several entries for the same account
-- (§3, §8)
-- -----------------------------------------------------------------------------
DROP TABLE IF EXISTS my_graphics_entries;
CREATE TABLE my_graphics_entries (
    id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    account_id      BIGINT UNSIGNED NOT NULL COMMENT 'the entry''s owner; not necessarily the package owner',
    package_id      CHAR(36)     NOT NULL,
    label           VARCHAR(100) NULL COMMENT 'e.g. Left / Right, §3',
    schema_data     JSON         NOT NULL DEFAULT (JSON_OBJECT()) COMMENT 'this entry''s own independent property values',
    enabled         BOOLEAN      NOT NULL DEFAULT TRUE COMMENT 'per-entry personal toggle, independent of packages.disabled',
    sort_order      INT          NOT NULL DEFAULT 0,
    created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_mge_account (account_id),
    KEY idx_mge_package (package_id),
    CONSTRAINT fk_mge_account
        FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE,
    CONSTRAINT fk_mge_package
        FOREIGN KEY (package_id) REFERENCES packages (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -----------------------------------------------------------------------------
-- action_groups / action_group_steps - combined/grouped actions (§3, FE-7)
-- -----------------------------------------------------------------------------
DROP TABLE IF EXISTS action_group_steps;
DROP TABLE IF EXISTS action_groups;

CREATE TABLE action_groups (
    id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    account_id      BIGINT UNSIGNED NOT NULL,
    name            VARCHAR(100) NOT NULL,
    sort_order      INT          NOT NULL DEFAULT 0,
    created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_ag_account (account_id),
    CONSTRAINT fk_ag_account
        FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE action_group_steps (
    id                      BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    action_group_id         BIGINT UNSIGNED NOT NULL,
    my_graphics_entry_id    BIGINT UNSIGNED NOT NULL,
    action_type             ENUM('play','stop','update') NOT NULL COMMENT 'mixed types within one group are allowed, e.g. stop+play, §3',
    action_payload           JSON NULL COMMENT 'e.g. partial data for an update step',
    step_order               INT NOT NULL DEFAULT 0,
    PRIMARY KEY (id),
    KEY idx_ags_group (action_group_id),
    KEY idx_ags_entry (my_graphics_entry_id),
    CONSTRAINT fk_ags_group
        FOREIGN KEY (action_group_id) REFERENCES action_groups (id) ON DELETE CASCADE,
    CONSTRAINT fk_ags_entry
        FOREIGN KEY (my_graphics_entry_id) REFERENCES my_graphics_entries (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- -----------------------------------------------------------------------------
-- renderer_connections - live renderer WebSocket connections; an account can
-- have several at once (OBS + browser test tab, multiple venue screens, ...),
-- and every action broadcasts to all of an account's connections (§10)
-- -----------------------------------------------------------------------------
DROP TABLE IF EXISTS renderer_connections;
CREATE TABLE renderer_connections (
    id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    account_id          BIGINT UNSIGNED NOT NULL,
    label               VARCHAR(100) NULL COMMENT 'e.g. "OBS - Main PC", "Browser test", §10',
    connected_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    disconnected_at     DATETIME NULL COMMENT 'NULL while still connected',
    PRIMARY KEY (id),
    KEY idx_rc_account (account_id),
    KEY idx_rc_active (account_id, disconnected_at),
    CONSTRAINT fk_rc_account
        FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

SET FOREIGN_KEY_CHECKS = 1;
