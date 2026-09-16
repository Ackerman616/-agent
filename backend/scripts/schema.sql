CREATE DATABASE IF NOT EXISTS consensus_travel
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_unicode_ci;

USE consensus_travel;

CREATE TABLE IF NOT EXISTS trips (
  id CHAR(36) NOT NULL PRIMARY KEY,
  destination VARCHAR(128) NOT NULL,
  origin VARCHAR(128) NOT NULL,
  start_at DATETIME NOT NULL,
  days INT NOT NULL,
  nights INT NOT NULL DEFAULT 0,
  return_deadline TIME NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'created',
  raw_request JSON NOT NULL,
  note TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_trips_created_at (created_at),
  KEY idx_trips_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS trip_members (
  id CHAR(36) NOT NULL PRIMARY KEY,
  trip_id CHAR(36) NOT NULL,
  name VARCHAR(64) NOT NULL,
  budget_max DECIMAL(10, 2) NOT NULL,
  walking_limit_km DECIMAL(6, 2) NOT NULL,
  earliest_start TIME NOT NULL,
  latest_end TIME NOT NULL,
  pace VARCHAR(32) NOT NULL,
  must_visit JSON NOT NULL,
  forbidden JSON NOT NULL,
  dietary_rules JSON NOT NULL,
  soft_preferences JSON NOT NULL,
  additional_notes TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_trip_member_name (trip_id, name),
  KEY idx_trip_members_trip_id (trip_id),
  CONSTRAINT fk_trip_members_trip_id FOREIGN KEY (trip_id) REFERENCES trips (id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS travel_plans (
  id CHAR(36) NOT NULL PRIMARY KEY,
  trip_id CHAR(36) NOT NULL,
  status VARCHAR(32) NOT NULL,
  summary TEXT NULL,
  candidates JSON NOT NULL,
  evidence JSON NOT NULL,
  final_plan JSON NULL,
  resolved_candidate_id VARCHAR(64) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_travel_plans_trip_id (trip_id),
  KEY idx_travel_plans_status (status),
  CONSTRAINT fk_travel_plans_trip_id FOREIGN KEY (trip_id) REFERENCES trips (id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS agent_tasks (
  id CHAR(36) NOT NULL PRIMARY KEY,
  trip_id CHAR(36) NOT NULL,
  plan_id CHAR(36) NULL,
  task_type VARCHAR(32) NOT NULL,
  status VARCHAR(32) NOT NULL,
  payload JSON NULL,
  result JSON NULL,
  error_code VARCHAR(16) NULL,
  error_message TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at DATETIME NULL,
  finished_at DATETIME NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_agent_tasks_trip_id (trip_id),
  KEY idx_agent_tasks_status (status),
  CONSTRAINT fk_agent_tasks_trip_id FOREIGN KEY (trip_id) REFERENCES trips (id)
    ON DELETE CASCADE,
  CONSTRAINT fk_agent_tasks_plan_id FOREIGN KEY (plan_id) REFERENCES travel_plans (id)
    ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS plan_votes (
  id CHAR(36) NOT NULL PRIMARY KEY,
  plan_id CHAR(36) NOT NULL,
  member_id CHAR(36) NOT NULL,
  candidate_ids JSON NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_plan_member_vote (plan_id, member_id),
  KEY idx_plan_votes_plan_id (plan_id),
  KEY idx_plan_votes_member_id (member_id),
  CONSTRAINT fk_plan_votes_plan_id FOREIGN KEY (plan_id) REFERENCES travel_plans (id)
    ON DELETE CASCADE,
  CONSTRAINT fk_plan_votes_member_id FOREIGN KEY (member_id) REFERENCES trip_members (id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS app_logs (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  request_id VARCHAR(36) NULL,
  level VARCHAR(16) NOT NULL,
  error_code VARCHAR(16) NULL,
  message TEXT NOT NULL,
  context JSON NULL,
  path VARCHAR(255) NULL,
  method VARCHAR(16) NULL,
  duration_ms INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_app_logs_request_id (request_id),
  KEY idx_app_logs_error_code (error_code),
  KEY idx_app_logs_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS trace_logs (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  request_id VARCHAR(36) NULL,
  trace_name VARCHAR(128) NOT NULL,
  span_name VARCHAR(128) NOT NULL,
  parent_span_id VARCHAR(64) NULL,
  metadata_json JSON NULL,
  started_at DATETIME NULL,
  ended_at DATETIME NULL,
  duration_ms INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_trace_logs_request_id (request_id),
  KEY idx_trace_logs_trace_name (trace_name),
  KEY idx_trace_logs_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
