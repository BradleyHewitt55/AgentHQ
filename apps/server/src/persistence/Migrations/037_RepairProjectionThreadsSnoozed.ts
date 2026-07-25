// Migration 34 was briefly used by the in-progress project-tasks work before
// ProjectionThreadsSnoozed landed with the same ID. Databases that ran that
// local migration record 34 as complete without receiving the snoozed columns.
// Re-run the idempotent schema change under a new ID to reconcile those databases.
// Companion to 036_RepairProjectionThreadsSettled, which covers migration 33.
export { default } from "./034_ProjectionThreadsSnoozed.ts";
