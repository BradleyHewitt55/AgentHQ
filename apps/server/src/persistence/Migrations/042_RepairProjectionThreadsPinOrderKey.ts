// Migration 38 on the fork's history is ProjectionThreadsPinned, so upstream's
// ProjectionThreadsPinOrderKey was never registered and on databases that
// applied the fork chain the pin_order_key column is missing. The merged query
// layer reads it, so this re-runs the idempotent ALTER under a new ID.
export { default } from "./038_ProjectionThreadsPinOrderKey.ts";
