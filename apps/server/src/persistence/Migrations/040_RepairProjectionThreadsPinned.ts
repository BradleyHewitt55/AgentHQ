// Migration 38 was introduced below the fork's already-applied migration 39
// (ProjectionThreadTitleRegeneration), so the migrator skipped it on databases
// that had already reached 39. Those databases never received pinned_at.
// Re-run the idempotent schema change under a new ID to reconcile them.
export { default } from "./038_ProjectionThreadsPinned.ts";
