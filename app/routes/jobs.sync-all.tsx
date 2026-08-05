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
import { withOfflineTokenRetry, isOfflineTokenRefreshFailure } from "../models/offline-token-retry.server";

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
  const sessionsCleaned: string[] = [];
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

      // isOfflineTokenRefreshFailure only being true here means BOTH the
      // original attempt and withOfflineTokenRetry's single retry hit this
      // exact bare-500 signature — a first failure of any other shape
      // propagates immediately without a retry (see
      // offline-token-retry.server.ts), so this can't fire off an unrelated
      // transient error. Two genuine hits of the same signature means the
      // shop's offline token is dead, not flaky — most likely an
      // already-uninstalled shop whose app/uninstalled cleanup never ran.
      // Delete its session rows so tomorrow's run doesn't retry a lost
      // cause; mirrors the cleanup webhooks.app.uninstalled.tsx already
      // does on a clean uninstall.
      if (isOfflineTokenRefreshFailure(reason)) {
        await prisma.session.deleteMany({ where: { shop: shops[i] } });
        console.error(
          `[sync-all] Removing orphaned session for ${shops[i]} — repeated bare-500 offline token refresh failure`,
        );
        sessionsCleaned.push(shops[i]);
      }
    }
  }

  const failed = results.filter((r) => r.status === "rejected").length;
  return json({
    synced: shops.length - failed,
    failed,
    total: shops.length,
    errors,
    sessionsCleaned,
  });
}

// --- Fly scheduled machine (already created — "daily-inventory-sync") ---
//
// This machine exists only as a `fly machine run` invocation — there's no
// fly.toml entry or script for it, so if it's ever deleted, nothing in this
// repo recreates it automatically. Run the command below to recreate it.
//
// Verified 2026-08-04 by pulling the live machine's actual config
// (`fly machine status 82d1de1a732428 -a restockpulse-app --display-config`)
// and confirming it matches this recipe exactly — not reconstructed from
// memory. If you change this machine, re-verify the same way and update
// this comment.
//
// flyctl machine run curlimages/curl:latest -a restockpulse-app \
//   --region lhr --schedule daily --name daily-inventory-sync \
//   --vm-memory 256 --entrypoint /bin/sh \
//   -- -c 'curl -fsS -X POST -H "X-Sync-Secret: $SYNC_JOB_SECRET" https://restockpulse-app.fly.dev/jobs/sync-all'
//
// Runs inside the same Fly app as the web service, so SYNC_JOB_SECRET is
// already available in its environment via the app's existing secret —
// nothing extra to configure.
//
// Not in the command above because they're Fly's own defaults for any
// scheduled machine (confirmed via `fly machine run --help`), not something
// this recipe passes explicitly:
//   - restart policy: on-failure, max 3 retries
//   - guest: shared-cpu-1x (1 vCPU)
//
// The image resolves through Fly's Docker Hub mirror at recreation time;
// the exact digest running as of the last verification above was
// docker-hub-mirror.fly.io/curlimages/curl:latest@sha256:1ab04d023ece37e6ec991bf3306ad04e0ef0084e94a5c6b6563cfcb9563169db.
// The command uses the floating `:latest` tag deliberately — pin to that
// digest instead if byte-for-byte reproducibility ever matters more than
// picking up curl's upstream fixes.