// app/routes/webhooks.inventory-levels-update.tsx
//
// Recalculates one product's stock status the moment a merchant (or POS,
// or a third-party inventory tool) changes on-hand inventory, instead of
// waiting on the next daily sync. See models/inventory-sync.server.ts for
// why this only touches currentInventory and re-reads it from the API
// rather than trusting the webhook payload's own `available` count.

import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { withOfflineTokenRetryForRequest } from "../models/offline-token-retry.server";
import { syncSingleProductFromInventoryItem } from "../models/inventory-sync.server";

interface InventoryLevelsUpdatePayload {
  inventory_item_id: number;
  location_id: number;
  available: number;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  // With future.expiringOfflineAccessTokens on, authenticate.webhook()
  // proactively refreshes the shop's offline token before returning —
  // within 5 minutes of its expiry — and throws a bare 500 Response if that
  // refresh call fails for ANY reason, including a one-off transient
  // network/API error, not just a genuinely dead token. HMAC validation
  // runs before the refresh attempt, so a caught-and-retried error here
  // still means the request was verified. inventory_levels/update fires far
  // more often than app/uninstalled ever would, making this worth a real
  // retry rather than just dropping the event — hence the wrapper below. If
  // both attempts fail, it throws: Shopify's own webhook retry will pick
  // this back up later, rather than us silently dropping a real inventory
  // change.
  const { shop, payload, admin } = await withOfflineTokenRetryForRequest(
    request,
    (req) => authenticate.webhook(req),
  );

  // Webhook requests can arrive after the app's already been uninstalled —
  // in that case session/admin come back undefined. Nothing to sync for a
  // shop that no longer has the app, so just acknowledge and stop.
  if (!admin) {
    return new Response(null, { status: 200 });
  }

  await syncSingleProductFromInventoryItem(
    shop,
    admin,
    (payload as InventoryLevelsUpdatePayload).inventory_item_id,
  );

  return new Response(null, { status: 200 });
};
