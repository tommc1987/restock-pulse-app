// app/routes/webhooks.billing-failure.tsx
//
// Registers for the REAL, documented subscription_billing_attempts/failure
// webhook topic. Payload shape CONFIRMED against Shopify's official
// Subscriptions Reference App docs (25 July 2026) — this is no longer a
// guess:
//
//   interface SubscriptionBillingAttemptFailure {
//     admin_graphql_api_id: string;
//     admin_graphql_api_subscription_contract_id: string;
//     error_code: string;
//     error_message: string;
//   }
//
// IMPORTANT: this payload is deliberately thin — no customer email, no
// amount. We have to make a follow-up GraphQL query using the contract ID
// to fetch those. The query below is NOT yet confirmed against a live
// SubscriptionContract response — same "verify before trusting" caveat
// applies to this second query as applied to the whole webhook before.
//
// ⚠️ SCOPE TO CONFIRM: likely `read_own_subscription_contracts`, verify
// against current docs.
// ⚠️ LIKELY NEEDS PROTECTED CUSTOMER DATA APPROVAL: the enrichment query
// fetches a customer email, same category that needed Partner Dashboard
// approval for Stockler's order scope.

import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate, unauthenticated } from "../shopify.server";
import prisma from "../db.server";
import { classifyFailure } from "../models/dunning-classifier.server";

const CONTRACT_ENRICHMENT_QUERY = `#graphql
  query SubscriptionContractDetails($id: ID!) {
    subscriptionContract(id: $id) {
      customer {
        email
      }
      lines(first: 10) {
        nodes {
          currentPrice {
            amount
          }
        }
      }
    }
  }
`;

export async function action({ request }: ActionFunctionArgs) {
  const { shop, payload } = await authenticate.webhook(request);

  // These four fields are confirmed real — safe to trust.
  const attemptId = payload.admin_graphql_api_id as string;
  const contractId = payload.admin_graphql_api_subscription_contract_id as string;
  const errorCode = (payload.error_code as string) ?? "UNKNOWN";
  const errorMessage = (payload.error_message as string) ?? null;
  const occurredAt = request.headers.get("X-Shopify-Triggered-At") ?? new Date().toISOString();

  // Follow-up query for the data the webhook itself doesn't include.
  // NOT YET VERIFIED against a real response — check this shape works
  // before trusting it in production.
  const { admin } = await unauthenticated.admin(shop);
  const response = await admin.graphql(CONTRACT_ENRICHMENT_QUERY, {
    variables: { id: contractId },
  });
  const data = await response.json();
  const contract = data?.data?.subscriptionContract;

  const customerEmail: string | null = contract?.customer?.email ?? null;
  const amount = contract?.lines?.nodes?.[0]?.currentPrice?.amount
    ? parseFloat(contract.lines.nodes[0].currentPrice.amount)
    : 0;

  const classified = classifyFailure({
    contractId,
    customerEmail,
    errorCode,
    errorMessage,
    amount,
    occurredAt,
    attemptsRemaining: null,
  });

  await prisma.billingFailure.upsert({
    where: {
      shop_contractId_occurredAt: { shop, contractId, occurredAt: new Date(occurredAt) },
    },
    create: {
      shop,
      contractId,
      customerEmail: classified.customerEmail,
      errorCode: classified.errorCode,
      category: classified.category,
      reason: classified.reason,
      suggestedAction: classified.suggestedAction,
      amount: classified.amount,
      occurredAt: new Date(occurredAt),
    },
    update: {},
  });

  return new Response();
}
