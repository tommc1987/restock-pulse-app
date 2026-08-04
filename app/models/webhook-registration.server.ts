// app/models/webhook-registration.server.ts
//
// Explicit, idempotent per-shop webhook registration.
//
// WHY THIS EXISTS: shopify.app.toml declares these webhooks, and
// `shopify app deploy` reports success releasing that config — but
// verified directly against real installs that Shopify's declarative
// auto-registration was NOT actually subscribing shops to
// inventory_levels/update. Checking further: the SAME gap exists for
// app/uninstalled and app/scopes_update — confirmed via a direct
// webhookSubscriptions query on a fresh install returning only the one
// topic we'd already fixed manually. `shopify.registerWebhooks()` (the
// library's other built-in registration path) is not a fix either — it
// only registers topics passed via a JS `webhooks` config object to
// shopifyApp(), which this app doesn't set; calling it would be a no-op.
// This calls the same webhookSubscriptionCreate mutation directly — the
// one already confirmed live and working end-to-end for the inventory
// topic — from application code, so every real install gets all of them
// automatically instead of needing a manual GraphQL call per topic.
//
// NOT covered here: the three mandatory compliance topics
// (customers/data_request, customers/redact, shop/redact). Confirmed via
// direct schema introspection that these aren't even valid values of the
// WebhookSubscriptionTopic enum this mutation takes — they're configured
// at the app level via shopify.app.toml's `compliance_topics` block +
// `shopify app deploy`, not per-shop like the topics below, so they can't
// be "fixed" the same way and don't show up in a per-shop
// webhookSubscriptions query even when correctly configured.
//
// Checks for an existing subscription first: webhookSubscriptionCreate
// isn't guaranteed idempotent across repeated afterAuth firings (re-auth,
// scope updates), and afterAuth can run more than once per shop.

const EXISTING_SUBSCRIPTION_QUERY = `#graphql
  query ExistingWebhook($topics: [WebhookSubscriptionTopic!]) {
    webhookSubscriptions(first: 5, topics: $topics) {
      nodes { id }
    }
  }
`;

const CREATE_SUBSCRIPTION_MUTATION = `#graphql
  mutation CreateWebhook($topic: WebhookSubscriptionTopic!, $callbackUrl: URL!) {
    webhookSubscriptionCreate(
      topic: $topic
      webhookSubscription: { callbackUrl: $callbackUrl, format: JSON }
    ) {
      webhookSubscription { id }
      userErrors { field message }
    }
  }
`;

type AdminLike = {
  graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;
};

async function ensureWebhookRegistered(
  admin: AdminLike,
  topic: string,
  callbackUrl: string,
): Promise<void> {
  try {
    const existingResponse = await admin.graphql(EXISTING_SUBSCRIPTION_QUERY, {
      variables: { topics: [topic] },
    });
    const existingData = await existingResponse.json();
    const alreadyRegistered =
      (existingData?.data?.webhookSubscriptions?.nodes?.length ?? 0) > 0;

    if (alreadyRegistered) {
      return;
    }

    const createResponse = await admin.graphql(CREATE_SUBSCRIPTION_MUTATION, {
      variables: { topic, callbackUrl },
    });
    const createData = await createResponse.json();
    const errors = createData?.data?.webhookSubscriptionCreate?.userErrors ?? [];
    if (errors.length > 0) {
      console.error(`[afterAuth] ${topic} webhook registration userErrors:`, errors);
    }
  } catch (error) {
    console.error(`[afterAuth] ${topic} webhook registration failed:`, error);
  }
}

/** Registers every per-shop-registrable topic this app declares in
 * shopify.app.toml. Run in parallel — each is independently try/caught,
 * so one failing doesn't block the others. */
export async function ensureAllWebhooksRegistered(
  admin: AdminLike,
  appUrl: string,
): Promise<void> {
  await Promise.all([
    ensureWebhookRegistered(
      admin,
      "INVENTORY_LEVELS_UPDATE",
      `${appUrl}/webhooks/inventory-levels-update`,
    ),
    ensureWebhookRegistered(admin, "APP_UNINSTALLED", `${appUrl}/webhooks/app/uninstalled`),
    ensureWebhookRegistered(
      admin,
      "APP_SCOPES_UPDATE",
      `${appUrl}/webhooks/app/scopes_update`,
    ),
  ]);
}
