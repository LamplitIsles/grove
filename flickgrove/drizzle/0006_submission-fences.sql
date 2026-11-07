CREATE TABLE `submission_fences` (
	`session_id` text NOT NULL,
	`operation_id` text NOT NULL,
	`envelope_hash` text NOT NULL,
	PRIMARY KEY(`session_id`, `operation_id`),
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
