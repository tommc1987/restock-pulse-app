// app/models/email-digest.server.ts
//
// Sends a daily digest email to the shop owner when RestockPulse has flagged
// anything. Uses Resend's HTTP API directly (no SDK dependency needed).

import type { AdminApiContext } from "@shopify/shopify-app-remix/server";
import type { ScoredProduct } from "./trend-score.server";

const SHOP_EMAIL_QUERY = `#graphql
  query ShopEmail {
    shop {
      email
      name
    }
  }
`;

/** Looks up the merchant's own store email via the Admin API — this is the
 * shop owner's account email, not customer data, so no extra scope needed. */
export async function getShopContactInfo(
  admin: AdminApiContext,
): Promise<{ email: string; shopName: string } | null> {
  const response = await admin.graphql(SHOP_EMAIL_QUERY);
  const data = await response.json();
  const shop = data?.data?.shop;
  if (!shop?.email) return null;
  return { email: shop.email, shopName: shop.name };
}

function buildDigestHtml(shopName: string, scored: ScoredProduct[]): string {
  const rows = scored
    .slice(0, 15) // keep the email skimmable — full list is always in the dashboard
    .map((p) => {
      const badgeColor =
        p.flag === "RESTOCK_URGENT" ? "#D82C0D" : p.flag === "TRENDING_UP" ? "#008060" : "#B98900";
      const badgeLabel =
        p.flag === "RESTOCK_URGENT" ? "Restock urgent" : p.flag === "TRENDING_UP" ? "Trending up" : "Slow mover";
      return `
        <tr>
          <td style="padding:8px 12px;border-bottom:1px solid #eee;">${p.title}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #eee;">
            <span style="background:${badgeColor}1A;color:${badgeColor};padding:2px 8px;border-radius:12px;font-size:12px;font-weight:600;">${badgeLabel}</span>
          </td>
          <td style="padding:8px 12px;border-bottom:1px solid #eee;">${p.reason}</td>
        </tr>`;
    })
    .join("");

  return `
    <div style="font-family:-apple-system,sans-serif;max-width:600px;margin:0 auto;">
      <h2 style="color:#08883A;">Stockler — ${shopName}</h2>
      <p>Here's what needs your attention today:</p>
      <table style="width:100%;border-collapse:collapse;">
        <thead>
          <tr style="text-align:left;">
            <th style="padding:8px 12px;border-bottom:2px solid #08883A;">Product</th>
            <th style="padding:8px 12px;border-bottom:2px solid #08883A;">Signal</th>
            <th style="padding:8px 12px;border-bottom:2px solid #08883A;">Why</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <p style="margin-top:24px;color:#666;font-size:13px;">
        This is an automated daily summary from Stockler. Open your app dashboard for the full list.
      </p>
    </div>
  `;
}

/** Sends the digest via Resend. Silently skips (no throw) if RESEND_API_KEY
 * isn't set, so a missing key never breaks the sync job itself. */
export async function sendDigestEmail(
  shop: string,
  toEmail: string,
  shopName: string,
  scored: ScoredProduct[],
): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn("[email-digest] RESEND_API_KEY not set — skipping email send.");
    return;
  }
  if (scored.length === 0) return; // don't email when there's nothing to report

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      // getstockler.com isn't verified in Resend yet — until it is, sends must stay on
      // Resend's shared onboarding@resend.dev domain. Once verified, set RESEND_FROM_ADDRESS
      // to something like "Stockler <hello@getstockler.com>".
      from: process.env.RESEND_FROM_ADDRESS || "Stockler <onboarding@resend.dev>",
      to: [toEmail],
      subject: `Stockler: ${scored.length} product${scored.length === 1 ? "" : "s"} need attention today`,
      html: buildDigestHtml(shopName, scored),
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[email-digest] Failed to send: ${response.status} ${errorText}`);
    return;
  }

  console.log(
    `[email-digest] Sent digest to ${toEmail} for ${shop} — ${scored.length} product${scored.length === 1 ? "" : "s"} flagged`,
  );
}
