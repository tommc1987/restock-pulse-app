// app/routes/webhooks.compliance.tsx
//
// Handles all three mandatory GDPR compliance topics on one shared endpoint,
// as required by Shopify (compliance topics use a single uri, unlike normal
// webhook subscriptions which can each have their own).

import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { isOfflineTokenRefreshFailure, withOfflineTokenRetryForRequest } from "../models/offline-token-retry.server";
import prisma from "../db.server";

async function handleTopic(topic: string, shop: string, payload: unknown) {
  switch (topic) {
    case "CUSTOMERS_DATA_REQUEST":
      // RestockPulse stores no customer-level PII — only shop-wide product
      // and order aggregates — so there's nothing to export for this request.
      void payload;
      break;

    case "CUSTOMERS_REDACT":
      // Same reasoning: nothing customer-specific is stored, so nothing to delete.
      void payload;
      break;

    case "SHOP_REDACT":
      // This one matters — delete everything held for this shop, across
      // every shop-scoped model in the schema (Session, ProductSnapshot,
      // ShopSyncStatus, ProductSaleEvent).
      await prisma.productSnapshot.deleteMany({ where: { shop } });
      await prisma.shopSyncStatus.deleteMany({ where: { shop } });
      await prisma.productSaleEvent.deleteMany({ where: { shop } });
      await prisma.session.deleteMany({ where: { shop } });
      break;

    default:
      console.warn(`Unhandled compliance topic: ${topic}`);
  }
}

export async function action({ request }: ActionFunctionArgs) {
  try {
    const { topic, shop, payload } = await withOfflineTokenRetryForRequest(request, (req) =>
      authenticate.webhook(req),
    );

    console.log(`Received ${topic} webhook for ${shop}`);
    await handleTopic(topic, shop, payload);
  } catch (error) {
    if (!isOfflineTokenRefreshFailure(error)) {
      throw error;
    }

    // HMAC is verified before the offline-token refresh is attempted (see
    // offline-token-retry.server.ts), so a failure here still means this is a
    // legitimate request — shop/redact fires 48 hours after uninstall, long
    // after the shop's offline token has expired or been revoked, so a
    // refresh failure here is the expected case, not an error. None of the
    // cleanup above calls the Admin API, so fall back to the topic and shop
    // domain Shopify sends as plain headers instead of failing a mandatory
    // compliance webhook over a token we never needed.
    const topic = request.headers.get("X-Shopify-Topic")?.toUpperCase().replace(/\//g, "_");
    const shop = request.headers.get("X-Shopify-Shop-Domain");
    console.warn(
      `[webhooks.compliance] Offline token refresh failed for ${shop ?? "unknown shop"} (${topic ?? "unknown topic"}) — proceeding without Admin API access.`,
    );
    if (topic && shop) {
      await handleTopic(topic, shop, undefined);
    }
  }

  return new Response();
}