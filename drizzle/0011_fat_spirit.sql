ALTER TABLE `notebook_artifacts` ADD `upload_id` text;--> statement-breakpoint
ALTER TABLE `notebook_artifacts` ADD `uploaded_parts_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `notebook_artifacts` ADD `upload_lease_token` text;--> statement-breakpoint
ALTER TABLE `notebook_artifacts` ADD `upload_lease_expires_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `notebook_artifacts` ADD `storage_version` text;