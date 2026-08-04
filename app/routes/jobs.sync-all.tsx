// app/routes/jobs.sync-all.tsx
//
// Called once a day by a Fly scheduled machine (see the `flyctl machine run
// --schedule daily ...` command in project notes). Protected by a shared
// secret sent as a header — not Shopify OAuth, since this isn't triggered
// by a merchant browsing the app. Deliberately a header rather than a
// query-string parameter: full request URLs (including query strings) show
// up in plaintext in Fly's access logs, which would otherwise leak the
// secret into the log stream on every single run.

import { type ActionFunctionArgs, json } from "@remix-run/node";
import prisma from "../db.server";
import { unauthenticated } from "../shopify.server"; // template helper for server-to-server admin calls
import { syncShopInventory, loadScoredProducts } from "../models/inventory-sync.server";
import { scoreCatalogue } from "../models/trend-score.server";
import { getShopContactInfo, sendDigestEmail } from "../models/email-digest.server";
import { withOfflineTokenRetry } from "../models/offline-token-retry.server";

export async function action({ request }: ActionFunctionArgs) {
  const secret = request.headers.get("X-Sync-Secret");

  if (secret !== process.env.SYNC_JOB_SECRET) {
    return json({ error: "unauthorized" }, { status: 401 });
  }

  const sessions = await prisma.session.findMany({ where: { isOnline: false } });
  const shops = [...new Set(sessions.map((s) => s.shop))];

  const results = await Promise.allSettled(
    shops.map(async (shop) => {
      // See models/offline-token-retry.server.ts — unauthenticated.admin()
      // can throw a bare 500 on a one-off transient failure refreshing this
      // shop's offline token, unrelated to whether the shop is actually
      // still installed. Worth one immediate retry before letting
      // Promise.allSettled below record it as a real failure for today.
      const { admin } = await withOfflineTokenRetry(() => unauthenticated.admin(shop));
      await syncShopInventory(shop, admin);

      // After syncing, check if there's anything worth emailing about.
      // Failures here are logged but never break the sync itself — a missed
      // email is far less bad than a failed data sync.
      try {
        const snapshots = await loadScoredProducts(shop);
        const scored = scoreCatalogue(snapshots);
        if (scored.length > 0) {
          const contact = await getShopContactInfo(admin);
          if (contact) {
            await sendDigestEmail(contact.email, contact.shopName, scored);
          }
        }
      } catch (emailError) {
        console.error(`[sync-all] Digest email failed for ${shop}:`, emailError);
      }
    }),
  );

  // Log the real error for every shop that failed — without this, a failed
  // sync just shows as a number with no way to tell why.
  const errors: { shop: string; message: string }[] = [];
  for (const [i, result] of results.entries()) {
    if (result.status === "rejected") {
      const reason = result.reason;
      let message: string;

      if (reason instanceof Response) {
        // Shopify's admin client throws raw Response objects on auth/API
        // failures — .message is empty on these, so read the body instead.
        const bodyText = await reason.text().catch(() => "(could not read response body)");
        message = `HTTP ${reason.status} ${reason.statusText} — ${bodyText}`;
      } else if (reason instanceof Error) {
        message = reason.message;
      } else {
        message = String(reason);
      }

      console.error(`[sync-all] Failed for shop ${shops[i]}:`, message);
      errors.push({ shop: shops[i], message });
    }
  }

  const failed = results.filter((r) => r.status === "rejected").length;
  return json({ synced: shops.length - failed, failed, total: shops.length, errors });
}

// --- Fly scheduled machine (already created — "daily-inventory-sync") ---
//
// flyctl machine run curlimages/curl:latest -a restockpulse-app \
//   --region lhr --schedule daily --name daily-inventory-sync \
//   --vm-memory 256 --entrypoint /bin/sh \
//   -- -c 'curl -fsS -X POST -H "X-Sync-Secret: $SYNC_JOB_SECRET" https://restockpulse-app.fly.dev/jobs/sync-all'
//
// Runs inside the same Fly app as the web service, so SYNC_JOB_SECRET is
// already available in its environment via the app's existing secret —
// nothing extra to configure.