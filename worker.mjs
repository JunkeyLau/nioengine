/* Cloudflare Worker wrapper for static assets.
   The Worker runs first so it can set a strict no-store policy for the
   single-page app and its worklet files. */
export default {
  async fetch(request, env) {
    const response = await env.ASSETS.fetch(request);
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "no-store");
    headers.set("X-Content-Type-Options", "nosniff");

    const status = response.status;
    const body = status === 204 || status === 304 ? null : response.body;

    return new Response(body, {
      status,
      statusText: response.statusText,
      headers
    });
  }
};
