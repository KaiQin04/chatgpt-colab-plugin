CREATE TABLE `google_grants` (
	`owner_id` text PRIMARY KEY NOT NULL,
	`google_subject` text NOT NULL,
	`masked_email` text NOT NULL,
	`encrypted_refresh_token` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `latest_status` (
	`owner_id` text PRIMARY KEY NOT NULL,
	`result_json` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `oauth_states` (
	`state_hash` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`code_verifier` text NOT NULL,
	`nonce` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `operation_lock` (
	`singleton` integer PRIMARY KEY NOT NULL,
	`operation_id` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `probe_runs` (
	`operation_id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`notebook_hash` text NOT NULL,
	`endpoint` text,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`released` integer DEFAULT 0 NOT NULL,
	`result_json` text
);
--> statement-breakpoint
CREATE TABLE `site_owner` (
	`singleton` integer PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL
);
