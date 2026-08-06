// app/routes/webhooks.orders.paid.tsx
//
// Registers for orders/paid, not orders/create — orders/create fires for
// draft/unpaid orders too, which shouldn't count as sales. orders/paid is
// Shopify's own "payment captured" event, matching what the daily full sync
// already treats as a sale (see inventory-sync.server.ts's ORDERS_QUERY).
//
// Payload field names (id, created_at, line_items[].product_id/quantity)
// confirmed against Shopify's documented Order resource shape — all
// order-lifecycle webhooks deliver this same resource. Final confirmation is
// the live test order verification this change ships with.

import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { withOfflineTokenRetryForRequest } from "../models/offline-token-retry.server";
import { recordPaidOrderLineItem } from "../models/inventory-sync.server";

interface OrdersPaidPayload {
  id: number;
  created_at: string;
  line_items: Array<{ product_id: number | null; quantity: number }>;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload, topic } = await withOfflineTokenRetryForRequest(request, (req) =>
    authenticate.webhook(req),
  );

  console.log(`Received ${topic} webhook for ${shop}`);

  const order = payload as unknown as OrdersPaidPayload;
  const orderId = String(order.id);
  const occurredAt = new Date(order.created_at);

  // Combine multiple line items for the same product (different variants)
  // into one quantity before recording — ProductSaleEvent has exactly one
  // row per (shop, productId, orderId), same aggregation the daily full
  // sync already does per order in fetchOrderAggregates().
  const quantityByProduct = new Map<string, number>();
  for (const line of order.line_items) {
    if (!line.product_id) continue; // skip deleted/custom line items
    const productId = `gid://shopify/Product/${line.product_id}`;
    quantityByProduct.set(productId, (quantityByProduct.get(productId) ?? 0) + line.quantity);
  }

  for (const [productId, quantity] of quantityByProduct) {
    await recordPaidOrderLineItem(shop, productId, orderId, quantity, occurredAt);
  }

  return new Response();
};
