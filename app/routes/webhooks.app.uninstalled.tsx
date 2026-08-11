import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { isOfflineTokenRefreshFailure, withOfflineTokenRetryForRequest } from "../models/offline-token-retry.server";
import { recordShopUninstall } from "../models/shop-uninstall.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  let shop: string;

  try {
    const result = await withOfflineTokenRetryForRequest(request, (req) => authenticate.webhook(req));
    shop = result.shop;
    console.log(`Received ${result.topic} webhook for ${shop}`);
  } catch (error) {
    if (!isOfflineTokenRefreshFailure(error)) {
      throw error;
    }

    // HMAC is verified before the offline-token refresh is attempted (see
    // offline-token-retry.server.ts), so a failure here still means this is a
    // legitimate request — app/uninstalled fires right as Shopify revokes the
    // shop's offline token, so a refresh failure here is the expected case,
    // not an error. Cleanup below is a plain database delete, not an Admin
    // API call, so fall back to the shop domain Shopify sends as a plain
    // header instead of failing a mandatory webhook over a token we never
    // needed in the first place.
    const fallbackShop = request.headers.get("X-Shopify-Shop-Domain");
    if (!fallbackShop) {
      console.warn("[webhooks.app.uninstalled] Offline token refresh failed and no shop domain header present — nothing to clean up.");
      return new Response();
    }
    shop = fallbackShop;
    console.warn(`[webhooks.app.uninstalled] Offline token refresh failed for ${shop} — likely already uninstalled. Continuing with cleanup.`);
  }

  await recordShopUninstall(shop, "webhook");

  // Webhook requests can trigger multiple times, and the session may already
  // be gone by the time this runs (an earlier delivery, or shop/redact) —
  // deleteMany is a safe no-op when nothing matches.
  await db.session.deleteMany({ where: { shop } });

  return new Response();
};
