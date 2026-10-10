import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { CompanyClient } from './company.js';
import { PoppyError } from './errors.js';
import { normalizeDomain, randomId, requireSecureUrl } from './util.js';

/**
 * Builds the browser assertion of section 5 for the current Session, after checking that
 * `return_to` is an HTTPS URL on `organization.domain` or a subdomain of it.
 */
export async function createBrowserAssertion(
  company: CompanyClient,
  returnTo: string,
): Promise<{ endpoint: string; assertion: string; sessionId: string }> {
  const ep = company.document.web?.browser_session_endpoint;
  if (!ep) {
    throw new PoppyError(
      'no_browser_session_endpoint',
      'Company has no web.browser_session_endpoint: browse as an ordinary signed-out visitor',
    );
  }
  const endpoint = requireSecureUrl(
    ep,
    'web.browser_session_endpoint',
    company.security,
  ).toString();
  const target = requireSecureUrl(returnTo, 'return_to', company.security);
  const org = normalizeDomain(company.document.organization.domain.replace(/:\d+$/, ''));
  const host = target.hostname.toLowerCase();
  if (normalizeDomain(host) !== org && !host.endsWith(`.${org}`)) {
    throw new PoppyError(
      'invalid_return_to',
      `return_to must be on ${org} or a subdomain (section 5)`,
    );
  }
  const { sessionId } = await company.token();
  const assertion = await company.agent.identity.browserAssertion({
    userId: company.userId,
    endpoint,
    sessionId,
    returnTo: target.toString(),
  });
  return { endpoint, assertion, sessionId };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** A page whose form POSTs the assertion as a top-level navigation. Never in the URL (5). */
export function autoSubmitFormHtml(endpoint: string, assertion: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Joining session…</title></head>
<body>
<form method="post" action="${escapeHtml(endpoint)}" enctype="application/x-www-form-urlencoded">
<input type="hidden" name="assertion" value="${escapeHtml(assertion)}">
<noscript><button type="submit">Continue</button></noscript>
</form>
<script>document.forms[0].submit()</script>
</body></html>`;
}

/**
 * Serves the auto-submitting page once, on 127.0.0.1 at an unguessable path, so a local
 * browser can load it. The page is gone after the first load (the assertion lives 60s anyway).
 */
export async function serveOneShotPage(
  html: string,
  opts: { timeoutMs?: number } = {},
): Promise<{ url: string; served: Promise<void>; close: () => void }> {
  const path = `/${randomId('', 16)}`;
  let resolveServed!: () => void;
  const served = new Promise<void>((r) => {
    resolveServed = r;
  });
  let used = false;
  const server = createServer((req, res) => {
    if (req.url !== path || used) {
      res.writeHead(404).end();
      return;
    }
    used = true;
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    });
    res.end(html);
    resolveServed();
    setTimeout(() => server.close(), 1000).unref();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const timer = setTimeout(() => server.close(), opts.timeoutMs ?? 60_000);
  timer.unref();
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}${path}`,
    served,
    close: () => {
      clearTimeout(timer);
      server.close();
    },
  };
}
