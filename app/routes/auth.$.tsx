import type { LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { withOfflineTokenRetry } from "../models/offline-token-retry.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await withOfflineTokenRetry(() => authenticate.admin(request));

  return null;
};
