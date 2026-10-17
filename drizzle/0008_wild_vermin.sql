CREATE TABLE `notebook_inputs` (
	`id` text PRIMARY KEY NOT NULL,
	`notebook_id` text NOT NULL,
	`runtime_id` text NOT NULL,
	`request_key` text NOT NULL,
	`file_id` text NOT NULL,
	`file_name` text NOT NULL,
	`mime_type` text,
	`state` text NOT NULL,
	`size` integer,
	`sha256` text,
	`error_json` text,
	`created_at` integer NOT NULL,
	`finished_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notebook_input_idempotency` ON `notebook_inputs` (`notebook_id`,`request_key`);--> statement-breakpoint
ALTER TABLE `notebooks` ADD `active_input_id` text;