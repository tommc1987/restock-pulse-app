// app/models/shop-uninstall.server.ts
//
// Records when a shop uninstalls, so a future shop/redact backfill can check
// the 48-hour compliance window against a real timestamp instead of
// inferring it from unrelated activity data (see webhooks.app.uninstalled.tsx
// and jobs.sync-all.tsx for the two places this gets written).

import prisma from "../db.server";

export type ShopUninstallSource = "webhook" | "cron_inferred";

/**
 * Records an uninstall event. A "webhook" record (a genuine app/uninstalled
 * delivery) is never downgraded by a later "cron_inferred" write for the
 * same shop — the cron's dead-token detection is a lower-confidence signal,
 * only worth recording when there's no better one yet.
 */
export async function recordShopUninstall(shop: string, source: ShopUninstallSource) {
  const existing = await prisma.shopUninstall.findUnique({ where: { shop } });
  if (existing?.source === "webhook" && source === "cron_inferred") {
    return;
  }

  await prisma.shopUninstall.upsert({
    where: { shop },
    create: { shop, uninstalledAt: new Date(), source },
    update: { uninstalledAt: new Date(), source },
  });
}
