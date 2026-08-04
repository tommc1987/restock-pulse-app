// app/routes/webhooks.inventory-levels-update.tsx
//
// Recalculates one product's stock status the moment a merchant (or POS,
// or a third-party inventory tool) changes on-hand inventory, instead of
// waiting on the next daily sync. See models/inventory-sync.server.ts for
// why this only touches currentInventory and re-reads it from the API
// rather than trusting the webhook payload's own `available` count.

import type { ActionFunctionArgs } from "@remix-run/node";
import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import { authenticate, unauthenticated } from "../shopify.server";
import { syncSingleProductFromInventoryItem } from "../models/inventory-sync.server";

interface InventoryLevelsUpdatePayload {
  inventory_item_id: number;
  location_id: number;
  available: number;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  // Keep our own copy of the body before authenticate.webhook() consumes
  // the original — if it throws (see catch below), the payload it parsed
  // internally is lost with it, since that happens before webhookContext
  // is ever built.
  const bodyClone = request.clone();

  let shop: string | null;
  let payload: InventoryLevelsUpdatePayload;
  let admin: AdminApiContext | undefined;

  try {
    const result = await authenticate.webhook(request);
    shop = result.shop;
    payload = result.payload as InventoryLevelsUpdatePayload;
    admin = result.admin;
  } catch (error) {
    // With future.expiringOfflineAccessTokens on, authenticate.webhook()
    // proactively refreshes the shop's offline token before returning —
    // within 5 minutes of its expiry — and throws a bare 500 Response if
    // that refresh call fails for ANY reason, including a one-off
    // transient network/API error, not just a genuinely dead token. HMAC
    // validation runs before the refresh attempt, so a caught error here
    // still means the request was verified. inventory_levels/update fires
    // far more often than app/uninstalled ever would, making this worth a
    // real retry rather than just dropping the event.
    if (!(error instanceof Response && error.status === 500)) {
      throw error;
    }

    shop = request.headers.get("X-Shopify-Shop-Domain");
    payload = await bodyClone.json();
  }

  if (!shop) {
    return new Response(null, { status: 200 });
  }

  if (!admin) {
    // Independent second attempt at a working admin client. This shares
    // the same underlying session/refresh logic, so it isn't guaranteed to
    // succeed — but the original failure is often a one-off transient
    // error during that ONE refresh call, and this retries it cleanly. If
    // it fails again here, we let it throw: Shopify's own webhook retry
    // will pick this back up later, rather than us silently dropping a
    // real inventory change.
    ({ admin } = await unauthenticated.admin(shop));
  }

  await syncSingleProductFromInventoryItem(shop, admin, payload.inventory_item_id);

  return new Response(null, { status: 200 });
};
