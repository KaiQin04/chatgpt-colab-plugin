CREATE TABLE `maintenance_scan` (
	`owner_id` text PRIMARY KEY NOT NULL,
	`after_id` text DEFAULT '' NOT NULL,
	`lease_token` text,
	`lease_expires_at` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
DROP TABLE `notebook_owner_slot`;--> statement-breakpoint
ALTER TABLE `notebook_runtimes` ADD `requested_compute` text DEFAULT 'CPU' NOT NULL;--> statement-breakpoint
ALTER TABLE `notebook_runtimes` ADD `selected_accelerator` text;--> statement-breakpoint
ALTER TABLE `notebook_runtimes` ADD `machine_kind` text DEFAULT 'CPU' NOT NULL;--> statement-breakpoint
ALTER TABLE `notebook_runtimes` ADD `compute_verified` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `notebook_live_runtime` ON `notebook_runtimes` (`notebook_id`) WHERE "notebook_runtimes"."released"=0;--> statement-breakpoint
CREATE INDEX `notebook_runtime_ownership` ON `notebook_runtimes` (`owner_id`,`released`);--> statement-breakpoint
CREATE INDEX `notebook_live_scan` ON `notebooks` (`owner_id`,`id`);