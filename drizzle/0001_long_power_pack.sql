CREATE TABLE `wait_diagnostics` (
	`diagnostic_id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`requested_seconds` integer NOT NULL,
	`transport` text NOT NULL,
	`status` text NOT NULL,
	`started_at` integer NOT NULL,
	`last_heartbeat_at` integer,
	`heartbeat_count` integer DEFAULT 0 NOT NULL,
	`finished_at` integer,
	`elapsed_ms` integer,
	`error_code` text
);
