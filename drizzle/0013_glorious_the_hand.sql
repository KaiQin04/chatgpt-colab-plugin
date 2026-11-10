DROP INDEX `notebook_live_runtime`;--> statement-breakpoint
ALTER TABLE `notebook_runtimes` ADD `allocation_failed` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `notebook_live_runtime` ON `notebook_runtimes` (`notebook_id`) WHERE "notebook_runtimes"."released"=0 AND "notebook_runtimes"."allocation_failed"=0;