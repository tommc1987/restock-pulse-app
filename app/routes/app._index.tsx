// app/routes/app._index.tsx
//
// Replace the template's default app._index.tsx with this. It renders the
// merchant's flagged products in a Polaris DataTable, most urgent first.
//
// This assumes a loader that fetches ScoredProduct[] — wire `loadScoredProducts`
// up to your Prisma-cached snapshot table (populated by the nightly sync job).

import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useRevalidator } from "@remix-run/react";
import { useEffect } from "react";
import { Page, Layout, Card, DataTable, Badge, EmptyState, BlockStack, Tooltip } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { withOfflineTokenRetry } from "../models/offline-token-retry.server";
import { MONTHLY_PLAN } from "../billing.server";
import { scoreCatalogue, type ScoredProduct } from "../models/trend-score.server";
import { loadScoredProducts, hasCompletedSync } from "../models/inventory-sync.server"; // implement: reads cached snapshots

export async function loader({ request }: LoaderFunctionArgs) {
  const { session, billing } = await withOfflineTokenRetry(() => authenticate.admin(request));

  // Gate the dashboard behind an active subscription. If the shop isn't on
  // the plan, billing.request() redirects them to Shopify's approval screen
  // and never returns here until they've accepted (or declined and left).
  //
  // Force test mode for now — flip this to false deliberately, later, once
  // you're genuinely ready to onboard real paying merchants. Tying this to
  // NODE_ENV was a mistake: production hosting sets NODE_ENV=production
  // automatically, which silently turned test mode off before we were ready.
  await billing.require({
    plans: [MONTHLY_PLAN],
    isTest: true,
    onFailure: async () =>
      billing.request({
        plan: MONTHLY_PLAN,
        isTest: true,
      }),
  });

  const synced = await hasCompletedSync(session.shop);
  const snapshots = await loadScoredProducts(session.shop);
  const scored = scoreCatalogue(snapshots);
  return json({ synced, scored });
}

function badgeFor(flag: ScoredProduct["flag"]) {
  switch (flag) {
    case "RESTOCK_URGENT":
      return (
        <Tooltip content="Alert only — this doesn't change whether the product can still be bought on your storefront.">
          <Badge tone="critical">Restock urgent</Badge>
        </Tooltip>
      );
    case "TRENDING_UP":
      return <Badge tone="success">Trending up</Badge>;
    case "SLOW_MOVER":
      return <Badge tone="warning">Slow mover</Badge>;
    default:
      return null;
  }
}

export default function Dashboard() {
  const { synced, scored } = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();

  // Poll while unsynced so the page transitions to the real dashboard on
  // its own — without this, "check back in a moment" is a lie: nothing
  // makes that happen, and a merchant (or reviewer) who just leaves the
  // tab open sees it sit there unchanged indefinitely, which reads as a
  // second bug stacked on the one this state exists to avoid. Stops
  // itself once `synced` flips true: the effect re-runs on that change,
  // the early return skips setting a new interval, and the old one was
  // already cleared by the cleanup below.
  useEffect(() => {
    if (synced) return;
    const interval = setInterval(() => revalidator.revalidate(), 2500);
    return () => clearInterval(interval);
  }, [synced, revalidator]);

  // Distinct from "synced and genuinely nothing to flag" below — this is
  // "we don't know yet." The install-time backfill is fire-and-forget, so
  // there's a real gap right after install where no sync has completed and
  // scored.length === 0 for a totally different reason. Claiming a clean
  // bill of health in that gap is actively misleading, not just an empty
  // state — a reviewer's fresh install could land here before the backfill
  // finishes and see what looks exactly like the original flagging bug.
  if (!synced) {
    return (
      <Page title="RestockPulse">
        <Card>
          <EmptyState heading="Syncing your inventory" image="/empty-state.svg">
            <p>We're pulling in your products and recent orders now — this page will update on its own once it's ready.</p>
          </EmptyState>
        </Card>
      </Page>
    );
  }

  if (scored.length === 0) {
    return (
      <Page title="RestockPulse">
        <Card>
          <EmptyState heading="Nothing flagged today" image="/empty-state.svg">
            <p>Your catalogue looks healthy. Check back tomorrow.</p>
          </EmptyState>
        </Card>
      </Page>
    );
  }

  const rows = scored.map((p) => [
    p.title,
    badgeFor(p.flag),
    p.currentInventory.toString(),
    p.daysOfStockRemaining !== null ? `${Math.round(p.daysOfStockRemaining)} days left` : "—",
    p.reason,
  ]);

  return (
    <Page title="RestockPulse" subtitle="Products that need your attention today">
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <DataTable
                columnContentTypes={["text", "text", "numeric", "text", "text"]}
                headings={["Product", "Signal", "Stock", "Runway", "Why"]}
                rows={rows}
              />
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}