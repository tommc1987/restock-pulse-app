// app/billing.server.ts
//
// MONTHLY_PLAN (the plan name) is the real single source of truth here, and
// is imported by both shopify.server.ts and app._index.tsx. BILLING_CONFIG
// below is NOT currently imported anywhere — shopify.server.ts's own
// `billing: {...}` block has its own separate, hardcoded copy of the amount.
// Keep both in sync by hand until that's consolidated; this one exists as
// documentation of the intended price, not as the actual charge-creation
// config Shopify's Billing API uses.

export const MONTHLY_PLAN = "Monthly Subscription";

export const BILLING_CONFIG = {
  [MONTHLY_PLAN]: {
    amount: 9.99,
    currencyCode: "USD",
    interval: "EVERY_30_DAYS" as const,
    trialDays: 7,
  },
};