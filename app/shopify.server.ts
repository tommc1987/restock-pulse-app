import "@shopify/shopify-app-remix/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  BillingInterval,
  shopifyApp,
} from "@shopify/shopify-app-remix/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";
import { syncShopInventory } from "./models/inventory-sync.server";
import { ensureAllWebhooksRegistered } from "./models/webhook-registration.server";

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.January25,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  billing: {
    "Monthly Subscription": {
      trialDays: 7,
      lineItems: [
        {
          amount: 14.99,
          currencyCode: "USD",
          interval: BillingInterval.Every30Days,
        },
      ],
    },
  },
  hooks: {
    afterAuth: async ({ session, admin }) => {
      // Verified live against real installs that shopify.app.toml's
      // declarative webhook registration (synced via `shopify app deploy`)
      // does NOT reliably auto-subscribe shops to ANY of its declared
      // per-shop topics — confirmed empty for inventory_levels/update
      // across two installs, then confirmed the same gap for
      // app/uninstalled and app/scopes_update on a third. Awaited (not
      // fire-and-forget) since it's a handful of fast GraphQL calls,
      // unlike the sync below — worth the small wait to know it actually
      // happened before the merchant lands in the app.
      await ensureAllWebhooksRegistered(admin, process.env.SHOPIFY_APP_URL || "");

      // Backfill this shop's dashboard immediately on install/re-auth, so it
      // isn't empty (or wrong) until the next daily cron run. Deliberately
      // NOT awaited: syncShopInventory() pages through the whole catalogue
      // and 30 days of orders, which could be slow enough on a large store
      // to risk a slow or timed-out post-install redirect back into the
      // embedded app. Fire-and-forget instead — the merchant lands on an
      // empty/partial dashboard for a few seconds at most while this runs in
      // the background, rather than waiting on it before they see anything.
      // Wrapped so a sync failure (API hiccup, rate limit, etc.) can never
      // surface as an install/auth failure.
      syncShopInventory(session.shop, admin).catch((error) => {
        console.error(`[afterAuth] Install-time sync failed for ${session.shop}:`, error);
      });
    },
  },
  future: {
    unstable_newEmbeddedAuthStrategy: true,
    expiringOfflineAccessTokens: true,
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.January25;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;