CREATE TABLE `artifact_downloads` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`artifact_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `maintenance_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`result_json` text
);
--> statement-breakpoint
CREATE TABLE `notebook_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`notebook_id` text NOT NULL,
	`run_id` text NOT NULL,
	`path` text NOT NULL,
	`size` integer NOT NULL,
	`sha256` text NOT NULL,
	`object_key` text NOT NULL,
	`media_type` text NOT NULL,
	`state` text NOT NULL,
	`permanent` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`saved_at` integer,
	`expires_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notebook_artifact_run_path` ON `notebook_artifacts` (`run_id`,`path`);--> statement-breakpoint
ALTER TABLE `notebook_runs` ADD `terminal_at` integer;--> statement-breakpoint
ALTER TABLE `notebook_runs` ADD `artifacts_state` text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE `notebook_runs` ADD `artifact_error_json` text;--> statement-breakpoint
ALTER TABLE `notebook_runtimes` ADD `accelerator` text DEFAULT 'CPU' NOT NULL;--> statement-breakpoint
ALTER TABLE `notebooks` ADD `last_activity_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `notebooks` ADD `last_terminal_at` integer;