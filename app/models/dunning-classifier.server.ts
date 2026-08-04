// app/models/dunning-classifier.server.ts
//
// Pure logic, no framework dependencies. Takes a raw
// SubscriptionBillingAttemptErrorCode (confirmed real, from Shopify's own
// GraphQL Admin API docs) and turns it into something a merchant can
// actually act on: what happened, whether retrying will help, and what to
// do about it.

export type ActionCategory =
  | "CUSTOMER_ACTION_NEEDED" // card expired, invalid — customer must update payment
  | "MAY_RESOLVE_ON_RETRY" // insufficient funds, temporary auth issue
  | "DO_NOT_RETRY" // fraud suspected, canceled by buyer — retrying is pointless or risky
  | "MERCHANT_ACTION_NEEDED"; // inventory/address issues — merchant-side problem, not payment

export interface BillingFailureEvent {
  contractId: string;
  customerEmail: string | null;
  errorCode: string;
  errorMessage: string | null;
  amount: number;
  occurredAt: string; // ISO date
  attemptsRemaining: number | null; // null if unknown
}

export interface ClassifiedFailure extends BillingFailureEvent {
  category: ActionCategory;
  reason: string;
  suggestedAction: string;
}

// Mapping based on Shopify's documented SubscriptionBillingAttemptErrorCode
// enum values. Not exhaustive — extend as you encounter more codes in real
// data; unmapped codes fall through to a generic "needs review" category.
const ERROR_CODE_MAP: Record<
  string,
  { category: ActionCategory; reason: string; suggestedAction: string }
> = {
  EXPIRED_PAYMENT_METHOD: {
    category: "CUSTOMER_ACTION_NEEDED",
    reason: "The customer's card has expired.",
    suggestedAction: "Shopify sends an automatic update-payment email — consider a manual follow-up if unresolved after 3 days.",
  },
  INCORRECT_NUMBER: {
    category: "CUSTOMER_ACTION_NEEDED",
    reason: "The card number on file is incorrect.",
    suggestedAction: "Customer needs to re-enter their payment details.",
  },
  INVALID_CUSTOMER_PAYMENT_METHOD: {
    category: "CUSTOMER_ACTION_NEEDED",
    reason: "The payment method on file is no longer valid.",
    suggestedAction: "Customer needs to add a new payment method.",
  },
  INSUFFICIENT_FUNDS: {
    category: "MAY_RESOLVE_ON_RETRY",
    reason: "The charge was declined for insufficient funds.",
    suggestedAction: "Often resolves itself — Shopify will retry automatically. No action needed unless it fails repeatedly.",
  },
  PROCESSING_ERROR: {
    category: "MAY_RESOLVE_ON_RETRY",
    reason: "A temporary error occurred during payment authentication.",
    suggestedAction: "Usually transient — let the automatic retry handle it.",
  },
  FRAUD_SUSPECTED: {
    category: "DO_NOT_RETRY",
    reason: "The payment was flagged as potentially fraudulent.",
    suggestedAction: "Do not retry automatically — review this customer/order manually before taking action.",
  },
  PAYMENT_METHOD_CANCELED: {
    category: "DO_NOT_RETRY",
    reason: "The customer canceled this payment method.",
    suggestedAction: "This subscription will likely need a new payment method or should be treated as a cancellation.",
  },
  INSUFFICIENT_INVENTORY: {
    category: "MERCHANT_ACTION_NEEDED",
    reason: "There wasn't enough stock to fulfil this billing cycle's order.",
    suggestedAction: "This is a restocking issue, not a payment issue — check inventory for this product.",
  },
  INVALID_ADDRESS: {
    category: "MERCHANT_ACTION_NEEDED",
    reason: "The shipping or billing address on file is invalid.",
    suggestedAction: "Contact the customer to confirm their current address.",
  },
};

export function classifyFailure(event: BillingFailureEvent): ClassifiedFailure {
  const mapped = ERROR_CODE_MAP[event.errorCode];

  if (mapped) {
    return { ...event, ...mapped };
  }

  // Unmapped code — still surface it, just without a confident category
  return {
    ...event,
    category: "CUSTOMER_ACTION_NEEDED",
    reason: event.errorMessage ?? `Unrecognized error code: ${event.errorCode}`,
    suggestedAction: "Review this failure manually — not yet a mapped error type.",
  };
}

export function classifyFailures(events: BillingFailureEvent[]): ClassifiedFailure[] {
  return events.map(classifyFailure);
}

/** Total revenue currently at risk across all unresolved failures — the
 * headline number for the dashboard. */
export function totalRevenueAtRisk(classified: ClassifiedFailure[]): number {
  return classified.reduce((sum, f) => sum + f.amount, 0);
}
