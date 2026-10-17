CREATE TABLE `notebook_cells` (
	`id` text PRIMARY KEY NOT NULL,
	`notebook_id` text NOT NULL,
	`kind` text NOT NULL,
	`source` text NOT NULL,
	`version` integer NOT NULL,
	`position` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `notebook_owner_slot` (
	`owner_id` text PRIMARY KEY NOT NULL,
	`runtime_id` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `notebook_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`notebook_id` text NOT NULL,
	`runtime_id` text NOT NULL,
	`cell_id` text NOT NULL,
	`cell_version` integer NOT NULL,
	`request_key` text NOT NULL,
	`source` text NOT NULL,
	`actor` text NOT NULL,
	`state` text NOT NULL,
	`result_json` text,
	`error_json` text,
	`interrupt_requested` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notebook_run_idempotency` ON `notebook_runs` (`notebook_id`,`request_key`);--> statement-breakpoint
CREATE TABLE `notebook_runtimes` (
	`id` text PRIMARY KEY NOT NULL,
	`notebook_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`request_key` text NOT NULL,
	`state` text NOT NULL,
	`notebook_hash` text NOT NULL,
	`endpoint` text,
	`kernel_id` text,
	`error_json` text,
	`released` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notebook_open_idempotency` ON `notebook_runtimes` (`owner_id`,`request_key`);--> statement-breakpoint
CREATE TABLE `notebooks` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`title` text NOT NULL,
	`version` integer NOT NULL,
	`state` text NOT NULL,
	`runtime_id` text,
	`active_run_id` text,
	`mutation_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
