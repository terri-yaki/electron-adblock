import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

// Local HTTP origin used by the integration tests. Ads are referenced through the
// fake host "ads.test", which the fixture maps to 127.0.0.1 via --host-resolver-rules.
export interface AdServerRequest {
  path: string;
  host: string;
  url: string;
}

export interface AdServer {
  readonly port: number;
  readonly origin: string;
  readonly pageUrl: string;
  readonly page2Url: string;
  count(pathname: string): number;
  counts(): Record<string, number>;
  resetCounts(): void;
  requests(): readonly AdServerRequest[];
  close(): Promise<void>;
}

const AD_SCRIPT = `window.__adScriptLoaded = true;
window.__adScriptRuns = (window.__adScriptRuns || 0) + 1;
document.documentElement.setAttribute('data-ad-script', 'loaded');
`;

// 1x1 transparent PNG.
const PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function pageShell(title: string, body: string, inlineScript: string, adBase?: string): string {
  const adTags = adBase
    ? `  <script src="${adBase}/ad.js"></script>
  <img id="ad-pixel" src="${adBase}/pixel.png" alt="" width="1" height="1" />`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${title}</title>
<style>
  html, body { margin: 0; padding: 0; font-family: sans-serif; }
  #content { padding: 16px; }
  .ad-banner { display: block; width: 640px; height: 120px; background: #b00; color: #fff; }
  aside.sponsor-slot { display: block; width: 320px; height: 100px; background: #06c; color: #fff; }
  #pick-target { width: 240px; height: 90px; margin: 24px 0; background: #280; color: #fff; }
</style>
</head>
<body>
${body}
  <script>${inlineScript}</script>
${adTags}
</body>
</html>`;
}

function page1Html(adBase: string): string {
  return pageShell(
    'QA ad page',
    `  <div id="content" class="content">Page one content</div>
  <div id="ad-banner" class="ad-banner">Ad banner</div>
  <aside id="sponsor-slot" class="sponsor-slot">Sponsor slot</aside>
  <div id="pick-target" class="promo-widget" title="pick me">Pick target</div>`,
    "window.__adScriptLoaded = false; window.__pageReady = 'page1';",
    adBase,
  );
}

function page2Html(): string {
  return pageShell(
    'QA ad page 2',
    `  <div id="content" class="content">Page two content</div>
  <div id="ad-banner" class="ad-banner">Page two ad banner</div>
  <aside id="sponsor-slot" class="sponsor-slot">Page two sponsor slot</aside>
  <div id="pick-target" class="promo-widget" title="pick me">Page two pick target</div>
  <h1 id="page2">Page 2</h1>`,
    "window.__pageReady = 'page2';",
  );
}

function send(res: ServerResponse, status: number, contentType: string, body: string | Buffer): void {
  const buffer = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  res.statusCode = status;
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Content-Length', String(buffer.length));
  res.end(buffer);
}

export async function startAdServer(): Promise<AdServer> {
  const countsByPath = new Map<string, number>();
  const recentRequests: AdServerRequest[] = [];
  let port = 0;
  let closing: Promise<void> | null = null;

  const server = createServer((req, res) => {
    const host = req.headers.host ?? '';
    const requestUrl = new URL(req.url ?? '/', 'http://' + (host || '127.0.0.1'));
    const pathname = requestUrl.pathname;

    countsByPath.set(pathname, (countsByPath.get(pathname) ?? 0) + 1);
    recentRequests.push({ path: pathname, host, url: requestUrl.href });
    if (recentRequests.length > 200) recentRequests.shift();

    try {
      if (pathname === '/' || pathname === '/index.html' || pathname === '/page.html') {
        send(res, 200, 'text/html; charset=utf-8', page1Html('http://ads.test:' + port));
        return;
      }
      if (pathname === '/page2.html') {
        send(res, 200, 'text/html; charset=utf-8', page2Html());
        return;
      }
      if (pathname === '/ad.js') {
        send(res, 200, 'application/javascript; charset=utf-8', AD_SCRIPT);
        return;
      }
      if (pathname === '/pixel.png') {
        send(res, 200, 'image/png', PIXEL_PNG);
        return;
      }
      send(res, 404, 'text/plain; charset=utf-8', 'not found');
    } catch (error) {
      res.destroy(error instanceof Error ? error : undefined);
    }
  });

  server.on('clientError', (error, socket) => {
    socket.destroy();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  port = address.port;
  const origin = 'http://127.0.0.1:' + port;

  return {
    port,
    origin,
    pageUrl: origin + '/',
    page2Url: origin + '/page2.html',
    count(pathname: string): number {
      return countsByPath.get(pathname) ?? 0;
    },
    counts(): Record<string, number> {
      const snapshot: Record<string, number> = {};
      for (const [pathname, count] of countsByPath) snapshot[pathname] = count;
      return snapshot;
    },
    resetCounts(): void {
      countsByPath.clear();
      recentRequests.length = 0;
    },
    requests(): readonly AdServerRequest[] {
      return recentRequests.slice();
    },
    async close(): Promise<void> {
      if (closing) return closing;
      closing = new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
      return closing;
    },
  };
}
