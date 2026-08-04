// app/billing.server.ts
//
// Single source of truth for the plan definition — imported by both
// shopify.server.ts (to register it) and any route that needs to enforce it.

export const MONTHLY_PLAN = "Monthly Subscription";

export const BILLING_CONFIG = {
  [MONTHLY_PLAN]: {
    amount: 14.99,
    currencyCode: "USD",
    interval: "EVERY_30_DAYS" as const,
    trialDays: 7,
  },
};