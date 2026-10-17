ALTER TABLE `notebook_cells` ADD `updated_by` text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE `notebooks` ADD `structure_version` integer DEFAULT 1 NOT NULL;