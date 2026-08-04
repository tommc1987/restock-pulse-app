// app/routes/webhooks.compliance.tsx
//
// Handles all three mandatory GDPR compliance topics on one shared endpoint,
// as required by Shopify (compliance topics use a single uri, unlike normal
// webhook subscriptions which can each have their own).

import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export async function action({ request }: ActionFunctionArgs) {
  const { topic, shop, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

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
      // This one matters — delete everything held for this shop.
      await prisma.productSnapshot.deleteMany({ where: { shop } });
      await prisma.session.deleteMany({ where: { shop } });
      break;

    default:
      console.warn(`Unhandled compliance topic: ${topic}`);
  }

  return new Response();
}