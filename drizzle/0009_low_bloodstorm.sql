CREATE TABLE `runtime_settings` (
	`owner_id` text PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`packages_json` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `runtime_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`notebook_id` text NOT NULL,
	`runtime_id` text NOT NULL,
	`request_key` text NOT NULL,
	`kind` text NOT NULL,
	`config_json` text NOT NULL,
	`state` text NOT NULL,
	`result_json` text,
	`error_json` text,
	`created_at` integer NOT NULL,
	`finished_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runtime_setup_idempotency` ON `runtime_tasks` (`notebook_id`,`request_key`);--> statement-breakpoint
ALTER TABLE `notebooks` ADD `active_setup_id` text;