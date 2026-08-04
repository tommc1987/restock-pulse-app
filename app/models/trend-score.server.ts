// app/models/trend-score.server.ts
//
// Drop this into your Shopify Remix app's app/models/ directory.
// Pure logic, no framework dependencies — easy to unit test in isolation.

export type Flag = "RESTOCK_URGENT" | "TRENDING_UP" | "SLOW_MOVER" | null;

export interface ProductSalesSnapshot {
  productId: string;
  title: string;
  currentInventory: number;
  unitsSoldLast7Days: number;
  unitsSoldPrevious30DaysDailyAvg: number; // average per day over the prior 30-day window
  daysSinceLastSale: number;
}

export interface ScoredProduct extends ProductSalesSnapshot {
  flag: Flag;
  daysOfStockRemaining: number | null;
  velocityRatio: number; // last-7-days daily avg vs 30-day daily avg
  reason: string;
}

const RESTOCK_URGENT_DAYS_THRESHOLD = 7;
const TRENDING_VELOCITY_RATIO_THRESHOLD = 1.75; // 75% above baseline
const SLOW_MOVER_DAYS_THRESHOLD = 14;

/**
 * Scores a single product against the three v1 flag rules.
 * Priority when multiple rules match: RESTOCK_URGENT > TRENDING_UP > SLOW_MOVER.
 * A product about to sell out because it's trending gets both signals — surface
 * it as urgent, since that's the action-forcing one.
 */
export function scoreProduct(snapshot: ProductSalesSnapshot): ScoredProduct {
  // Direct rule, checked before any velocity math: zero (or negative, from
  // an oversell) on-hand stock is always urgent, full stop. The ratio-based
  // rules below can't express this — an item with no recent sales velocity
  // produces a null daysOfStockRemaining and silently falls through to
  // SLOW_MOVER instead, which is wrong for a genuinely out-of-stock item.
  if (snapshot.currentInventory <= 0) {
    return {
      ...snapshot,
      flag: "RESTOCK_URGENT",
      daysOfStockRemaining: 0,
      velocityRatio: 0,
      reason: "Out of stock right now — 0 units on hand.",
    };
  }

  const dailyVelocityLast7 = snapshot.unitsSoldLast7Days / 7;
  const baselineDailyVelocity = Math.max(snapshot.unitsSoldPrevious30DaysDailyAvg, 0.01); // avoid div/0
  const velocityRatio = dailyVelocityLast7 / baselineDailyVelocity;

  const daysOfStockRemaining =
    dailyVelocityLast7 > 0 ? snapshot.currentInventory / dailyVelocityLast7 : null;

  let flag: Flag = null;
  let reason = "";

  if (daysOfStockRemaining !== null && daysOfStockRemaining <= RESTOCK_URGENT_DAYS_THRESHOLD) {
    flag = "RESTOCK_URGENT";
    reason = `At current sales pace, stock runs out in ~${Math.max(
      1,
      Math.round(daysOfStockRemaining),
    )} day(s).`;
  } else if (velocityRatio >= TRENDING_VELOCITY_RATIO_THRESHOLD) {
    flag = "TRENDING_UP";
    reason = `Selling ${velocityRatio.toFixed(1)}x faster than its 30-day average this week.`;
  } else if (snapshot.daysSinceLastSale >= SLOW_MOVER_DAYS_THRESHOLD) {
    flag = "SLOW_MOVER";
    reason =
      snapshot.daysSinceLastSale >= 999
        ? "No sales on record — consider a promo or clearance."
        : `No sales in ${snapshot.daysSinceLastSale} days — consider a promo or clearance.`;
  }

  return {
    ...snapshot,
    flag,
    daysOfStockRemaining,
    velocityRatio,
    reason,
  };
}

/** Scores a merchant's full catalogue and returns only the flagged products, most urgent first. */
export function scoreCatalogue(snapshots: ProductSalesSnapshot[]): ScoredProduct[] {
  const priority: Record<Exclude<Flag, null>, number> = {
    RESTOCK_URGENT: 0,
    TRENDING_UP: 1,
    SLOW_MOVER: 2,
  };

  return snapshots
    .map(scoreProduct)
    .filter((p): p is ScoredProduct & { flag: Exclude<Flag, null> } => p.flag !== null)
    .sort((a, b) => priority[a.flag] - priority[b.flag]);
}