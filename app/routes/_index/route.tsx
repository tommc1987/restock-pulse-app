import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { Form, useLoaderData } from "@remix-run/react";

import { login } from "../../shopify.server";

import styles from "./styles.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export default function App() {
  const { showForm } = useLoaderData<typeof loader>();

  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>Know what to restock before you run out</h1>
        <p className={styles.text}>
          RestockPulse watches your sales velocity and flags which products
          are trending, slow-moving, or at risk of stocking out — so you
          always know what to reorder next.
        </p>
        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label}>
              <span>Shop domain</span>
              <input className={styles.input} type="text" name="shop" />
              <span>e.g: my-shop-domain.myshopify.com</span>
            </label>
            <button className={styles.button} type="submit">
              Log in
            </button>
          </Form>
        )}
        <ul className={styles.list}>
          <li>
            <strong>Restock urgency scoring</strong>. Every product is ranked
            by how soon it's likely to sell out, based on its recent sales
            velocity and remaining inventory.
          </li>
          <li>
            <strong>Trending &amp; slow-moving flags</strong>. Instantly see
            which products are picking up momentum and which are sitting on
            the shelf, so you can act on both.
          </li>
          <li>
            <strong>At-a-glance stockout risk</strong>. Catch products headed
            for a stockout early, with enough lead time to reorder before you
            lose sales.
          </li>
        </ul>
      </div>
    </div>
  );
}
