export const loader = async () => {
  const body = [
    "User-agent: *",
    "Allow: /",
    "Disallow: /app",
    "Disallow: /auth",
    "Disallow: /webhooks",
    "Disallow: /jobs",
  ].join("\n");

  return new Response(body, {
    headers: { "Content-Type": "text/plain" },
  });
};
