import crypto from 'node:crypto';
import express from 'express';
import swaggerUi from 'swagger-ui-dist';
import { ografOpenApi } from './ograf-openapi.js';

// Interactive documentation of Grafonaut's OGraf Server API (Swagger UI) at /api-docs/. For signed-in users the OpenAPI
// document's server is their own API URL, so "Try it out" works right away.
export function createApiDocs({ apiUrlFor }) {
  const router = express.Router();
  const assets = swaggerUi.getAbsoluteFSPath();
  router.use('/assets', express.static(assets, { index: false, maxAge: '1d' }));
  router.get('/openapi.json', async (request, response) => {
    let serverUrl;
    try { serverUrl = await apiUrlFor(request); } catch { serverUrl = undefined; }
    response.set('Cache-Control', 'private, no-store').json(ografOpenApi({ serverUrl }));
  });
  router.get('/', (_request, response) => {
    const nonce = crypto.randomBytes(16).toString('base64');
    response.set({
      'Content-Security-Policy': ["default-src 'none'", `script-src 'self' 'nonce-${nonce}'`, "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:", "font-src 'self' data:", "connect-src 'self'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"].join('; '),
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-cache'
    }).type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Grafonaut · OGraf Server API</title>
<link rel="stylesheet" href="/api-docs/assets/swagger-ui.css">
<style>body{margin:0;background:#fafafa}.docs-bar{display:flex;align-items:center;gap:16px;padding:14px 20px;background:#17332f;color:#fdf9ef;font:14px Arial,sans-serif}
.docs-bar a{color:#fdf9ef}.docs-bar strong{letter-spacing:.2em}</style>
</head><body><div class="docs-bar"><strong>GRAFONAUT</strong><span>OGraf Server API</span><a href="/#renderer">Back to the Renderer page</a></div>
<div id="swagger-ui"></div>
<script src="/api-docs/assets/swagger-ui-bundle.js"></script>
<script nonce="${nonce}">window.ui = SwaggerUIBundle({ url: '/api-docs/openapi.json', dom_id: '#swagger-ui', deepLinking: true,
  tryItOutEnabled: true, displayRequestDuration: true, defaultModelsExpandDepth: 0 });</script>
</body></html>`);
  });
  return router;
}
