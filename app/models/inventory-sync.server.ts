// app/models/inventory-sync.server.ts
//
// Drop into app/models/. This is the job that populates ProductSnapshot —
// run it once per shop per day (see "Scheduling" note at the bottom for how
// to trigger it without a long-running server process).

import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import prisma from "../db.server"; // the Prisma client the template already sets up
import type { ProductSnapshot } from "@prisma/client";
import type { ProductSalesSnapshot } from "./trend-score.server";

const PRODUCTS_PAGE_SIZE = 50;

// --- GraphQL queries -------------------------------------------------------

const PRODUCTS_QUERY = `#graphql
  query ProductsWithInventory($cursor: String) {
    products(first: ${PRODUCTS_PAGE_SIZE}, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        title
        totalInventory
      }
    }
  }
`;

// Resolves a single inventory_levels/update webhook's inventory_item_id
// back to its parent product. Deliberately does NOT read product.totalInventory
// — verified against a live multi-location store that this aggregate lags
// the actual inventoryLevels by a beat: querying it immediately on webhook
// receipt returned the PRE-change total, not the new one. inventoryLevels
// itself doesn't have that lag (it's the same record the webhook is about),
// so we sum it ourselves across every variant and location instead.
const INVENTORY_ITEM_QUERY = `#graphql
  query InventoryItemProduct($id: ID!) {
    inventoryItem(id: $id) {
      variant {
        product {
          id
          title
          variants(first: 250) {
            nodes {
              inventoryItem {
                inventoryLevels(first: 250) {
                  nodes {
                    quantities(names: ["available"]) { quantity }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

// Orders query is deliberately scoped to the last 30 days and only pulls
// line items — we aggregate units sold per product ourselves below.
const ORDERS_QUERY = `#graphql
  query RecentOrders($cursor: String, $query: String!) {
    orders(first: 100, after: $cursor, query: $query) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        createdAt
        lineItems(first: 50) {
          nodes {
            quantity
            product { id }
          }
        }
      }
    }
  }
`;

// --- Types -------------------------------------------------------------

interface ProductNode {
  id: string;
  title: string;
  totalInventory: number;
}

interface OrderLineAggregate {
  last7DaysUnits: number;
  last30DaysUnits: number;
  lastSaleDate: Date | null;
}

/** One row's worth of data for the ProductSaleEvent ledger — see
 * schema.prisma for why this table exists. */
interface SaleEvent {
  productId: string;
  orderId: string;
  quantity: number;
  occurredAt: Date;
}

interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

interface ProductsQueryResponse {
  data: { products: { nodes: ProductNode[]; pageInfo: PageInfo } };
}

interface OrdersQueryResponse {
  data: {
    orders: {
      nodes: Array<{
        id: string;
        createdAt: string;
        lineItems: { nodes: Array<{ quantity: number; product: { id: string } | null }> };
      }>;
      pageInfo: PageInfo;
    };
  };
}

// --- Main entry point --------------------------------------------------

/**
 * Runs the full sync for one shop: pulls all products, pulls 30 days of
 * orders, aggregates sales velocity per product, and upserts ProductSnapshot
 * rows. Call this once per shop per day (see scheduling note below).
 */
export async function syncShopInventory(shop: string, admin: AdminApiContext): Promise<void> {
  const products = await fetchAllProducts(admin);
  const { aggregates: salesByProduct, saleEvents } = await fetchOrderAggregates(admin);

  const now = new Date();

  await Promise.all(
    products.map((product) => {
      const agg = salesByProduct.get(product.id) ?? {
        last7DaysUnits: 0,
        last30DaysUnits: 0,
        lastSaleDate: null,
      };

      const daysSinceLastSale = agg.lastSaleDate
        ? Math.floor((now.getTime() - agg.lastSaleDate.getTime()) / (1000 * 60 * 60 * 24))
        : 999; // never sold — treat as long-dormant, not an error

      return prisma.productSnapshot.upsert({
        where: { shop_productId: { shop, productId: product.id } },
        create: {
          shop,
          productId: product.id,
          title: product.title,
          currentInventory: product.totalInventory,
          unitsSoldLast7Days: agg.last7DaysUnits,
          unitsSoldPrevious30DaysDailyAvg: agg.last30DaysUnits / 30,
          daysSinceLastSale,
        },
        update: {
          title: product.title,
          currentInventory: product.totalInventory,
          unitsSoldLast7Days: agg.last7DaysUnits,
          unitsSoldPrevious30DaysDailyAvg: agg.last30DaysUnits / 30,
          daysSinceLastSale,
        },
      });
    }),
  );

  // Replace this shop's ProductSaleEvent ledger wholesale with what we just
  // fetched — the orders/paid webhook derives its rolling-window figures
  // from this table, so it needs to reflect the same authoritative Orders
  // API data the snapshot rows above were just built from. Wrapped in a
  // single $transaction (one SQL BEGIN...COMMIT on SQLite) rather than two
  // independent statements: if the process dies mid-write, the transaction
  // never commits and rolls back to the untouched previous ledger — there's
  // no intermediate "empty" or "half-replaced" state observable from
  // outside it, only "still old" or "fully new."
  await prisma.$transaction([
    prisma.productSaleEvent.deleteMany({ where: { shop } }),
    prisma.productSaleEvent.createMany({
      data: saleEvents.map((event) => ({ shop, ...event })),
    }),
  ]);

  // Written last, after every product (even a catalogue of zero) has been
  // upserted — the dashboard uses this to tell "nothing to flag" apart from
  // "nothing's been synced yet," which look identical from row count alone.
  await prisma.shopSyncStatus.upsert({
    where: { shop },
    create: { shop },
    update: {},
  });
}

/** Whether a full catalogue sync has ever completed for this shop. */
export async function hasCompletedSync(shop: string): Promise<boolean> {
  const status = await prisma.shopSyncStatus.findUnique({ where: { shop } });
  return status !== null;
}

/**
 * Handles a single inventory_levels/update event. Only currentInventory
 * changes here — sales fields are order-derived and an inventory event
 * says nothing about sales, so there's no reason to re-page the whole
 * catalogue or re-aggregate orders for a one-field update. Sums
 * inventoryLevels across every variant and location ourselves rather than
 * trusting the webhook's own `available` count (scoped to one
 * (inventory_item_id, location_id) pair — wrong for multi-location or
 * multi-variant products) OR product.totalInventory (verified live against
 * a multi-location store: querying it synchronously on webhook receipt
 * returned the PRE-change total — it lags the inventoryLevels it's
 * derived from by a beat).
 */
export async function syncSingleProductFromInventoryItem(
  shop: string,
  admin: AdminApiContext,
  inventoryItemId: number,
): Promise<void> {
  const inventoryItemGid = `gid://shopify/InventoryItem/${inventoryItemId}`;
  const response = await admin.graphql(INVENTORY_ITEM_QUERY, {
    variables: { id: inventoryItemGid },
  });
  const data = await response.json();
  const product = data?.data?.inventoryItem?.variant?.product;

  if (!product) {
    // Deleted/archived product, or an inventory item with no product
    // attached — nothing for us to update.
    return;
  }

  const totalInventory: number = product.variants.nodes.reduce(
    (variantSum: number, variantNode: any) =>
      variantSum +
      variantNode.inventoryItem.inventoryLevels.nodes.reduce(
        (levelSum: number, levelNode: any) =>
          levelSum + (levelNode.quantities[0]?.quantity ?? 0),
        0,
      ),
    0,
  );

  await prisma.productSnapshot.upsert({
    where: { shop_productId: { shop, productId: product.id } },
    create: {
      shop,
      productId: product.id,
      title: product.title,
      currentInventory: totalInventory,
      // No sales data yet for a product we're seeing for the first time
      // via a webhook — corrected by the next full sync (install backfill
      // or daily cron), same as any other newly-created product would be.
      unitsSoldLast7Days: 0,
      unitsSoldPrevious30DaysDailyAvg: 0,
      daysSinceLastSale: 999,
    },
    update: {
      title: product.title,
      currentInventory: totalInventory,
    },
  });
}

/**
 * Handles one product line from an orders/paid webhook: records it in the
 * ProductSaleEvent ledger (idempotent — a redelivered webhook for the same
 * order+product upserts the same row rather than double-counting), then
 * recomputes that product's rolling-window fields as a real windowed SUM
 * over the ledger — never a "+quantity" increment. See schema.prisma's
 * comment on ProductSaleEvent for why a counter isn't good enough here.
 *
 * Only updates an existing ProductSnapshot row (updateMany, not upsert) —
 * mirrors syncSingleProductFromInventoryItem's convention: a product this
 * app hasn't cataloged yet via a full sync can't be safely created from a
 * sales event alone (no title/currentInventory), so it's left for the next
 * full sync, same as any other newly-seen product.
 */
export async function recordPaidOrderLineItem(
  shop: string,
  productId: string,
  orderId: string,
  quantity: number,
  occurredAt: Date,
): Promise<void> {
  await prisma.productSaleEvent.upsert({
    where: { shop_productId_orderId: { shop, productId, orderId } },
    create: { shop, productId, orderId, quantity, occurredAt },
    update: { quantity, occurredAt },
  });

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const events = await prisma.productSaleEvent.findMany({
    where: { shop, productId, occurredAt: { gte: thirtyDaysAgo } },
    select: { quantity: true, occurredAt: true },
  });

  let last7DaysUnits = 0;
  let last30DaysUnits = 0;
  let lastSaleDate: Date | null = null;
  for (const event of events) {
    last30DaysUnits += event.quantity;
    if (event.occurredAt >= sevenDaysAgo) last7DaysUnits += event.quantity;
    if (!lastSaleDate || event.occurredAt > lastSaleDate) lastSaleDate = event.occurredAt;
  }

  const daysSinceLastSale = lastSaleDate
    ? Math.floor((Date.now() - lastSaleDate.getTime()) / (1000 * 60 * 60 * 24))
    : 999;

  await prisma.productSnapshot.updateMany({
    where: { shop, productId },
    data: {
      unitsSoldLast7Days: last7DaysUnits,
      unitsSoldPrevious30DaysDailyAvg: last30DaysUnits / 30,
      daysSinceLastSale,
    },
  });
}

/** Reads back the cached snapshots for the dashboard route — no live API call. */
export async function loadScoredProducts(shop: string): Promise<ProductSalesSnapshot[]> {
  const rows: ProductSnapshot[] = await prisma.productSnapshot.findMany({ where: { shop } });
  return rows.map((r) => ({
    productId: r.productId,
    title: r.title,
    currentInventory: r.currentInventory,
    unitsSoldLast7Days: r.unitsSoldLast7Days,
    unitsSoldPrevious30DaysDailyAvg: r.unitsSoldPrevious30DaysDailyAvg,
    daysSinceLastSale: r.daysSinceLastSale,
  }));
}

// --- Helpers -------------------------------------------------------------

async function fetchAllProducts(admin: AdminApiContext): Promise<ProductNode[]> {
  const results: ProductNode[] = [];
  let cursor: string | null = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const response = await admin.graphql(PRODUCTS_QUERY, { variables: { cursor } });
    const data = (await response.json()) as ProductsQueryResponse;
    const { nodes, pageInfo } = data.data.products;
    results.push(...nodes);
    hasNextPage = pageInfo.hasNextPage;
    cursor = pageInfo.endCursor;
  }

  return results;
}

async function fetchOrderAggregates(
  admin: AdminApiContext,
): Promise<{ aggregates: Map<string, OrderLineAggregate>; saleEvents: SaleEvent[] }> {
  const aggregates = new Map<string, OrderLineAggregate>();
  // Keyed by `${orderId}:${productId}` — an order can have multiple line
  // items for the same product (different variants), and ProductSaleEvent
  // has exactly one row per (shop, productId, orderId), so quantities for
  // the same order+product need to be combined before they become a row.
  const eventsByOrderProduct = new Map<string, SaleEvent>();
  const sevenDaysAgo = daysAgoISO(7);
  const thirtyDaysAgo = daysAgoISO(30);

  let cursor: string | null = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const response = await admin.graphql(ORDERS_QUERY, {
      variables: { cursor, query: `created_at:>=${thirtyDaysAgo}` },
    });
    const data = (await response.json()) as OrdersQueryResponse;
    const { nodes, pageInfo } = data.data.orders;

    for (const order of nodes) {
      const createdAt = new Date(order.createdAt);
      const isWithin7Days = createdAt >= new Date(sevenDaysAgo);

      for (const line of order.lineItems.nodes) {
        if (!line.product?.id) continue; // skip deleted/custom line items
        const productId: string = line.product.id;

        const existing = aggregates.get(productId) ?? {
          last7DaysUnits: 0,
          last30DaysUnits: 0,
          lastSaleDate: null,
        };

        existing.last30DaysUnits += line.quantity;
        if (isWithin7Days) existing.last7DaysUnits += line.quantity;
        if (!existing.lastSaleDate || createdAt > existing.lastSaleDate) {
          existing.lastSaleDate = createdAt;
        }

        aggregates.set(productId, existing);

        const eventKey = `${order.id}:${productId}`;
        const existingEvent = eventsByOrderProduct.get(eventKey);
        if (existingEvent) {
          existingEvent.quantity += line.quantity;
        } else {
          eventsByOrderProduct.set(eventKey, {
            productId,
            orderId: order.id,
            quantity: line.quantity,
            occurredAt: createdAt,
          });
        }
      }
    }

    hasNextPage = pageInfo.hasNextPage;
    cursor = pageInfo.endCursor;
  }

  return { aggregates, saleEvents: [...eventsByOrderProduct.values()] };
}

function daysAgoISO(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().split("T")[0];
}

// --- Scheduling note -------------------------------------------------------
//
// This job needs a trigger outside the normal request cycle — a Remix app
// doesn't have a built-in cron. Simplest options, cheapest first:
//
// 1. GitHub Actions scheduled workflow that hits a protected route
//    (e.g. POST /jobs/sync-all) once daily. Free, zero extra infra.
// 2. Your hosting provider's native cron (Railway, Render, Fly.io all have one).
// 3. Only once you have real scale: a proper queue (e.g. Upstash QStash).
//
// Start with option 1 — don't build infra you don't need yet at 0 customers.
