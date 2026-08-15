/**
 * proxyController — Tier 2 residential-proxy gateway validation (P4).
 *
 *   POST /api/proxy/test  { proxy, url? } → { ok, exitIp, status, latencyMs, error? }
 *
 * Verifies a rotating residential gateway URL actually works BEFORE a crawl
 * burns time on it: fetches an IP-echo (https://api.ipify.org?format=json by
 * default) THROUGH the proxy and returns the exit IP the crawl would use —
 * the "you're now on a different IP" confidence signal. The proxy URL is read
 * from the request, used transiently, and NEVER persisted or logged; error
 * text has the gateway URL redacted (same rule as the crawler's HTTP layer).
 */
const path = require('path');
const { pathToFileURL } = require('url');

// undici ships with the backend package (the crawler's HTTP layer uses its
// ProxyAgent); resolve it from there (the crawler moved to backend/crawler on
// Aug 10 — the frontend no longer carries crawler deps).
// undici's own fetch is used (not the global one): Node's global fetch is a
// different undici copy and rejects this package's ProxyAgent ("invalid
// onRequestStart method" — undici 8.x agent under Node 24's global fetch).
const { ProxyAgent, fetch: undiciFetch } = require(
  require.resolve('undici', { paths: [path.join(__dirname, '..')] })
);

const IP_ECHO_URL =
  process.env.PARITY_PROXY_ECHO_URL ?? 'https://api.ipify.org?format=json';
const PROXY_TEST_TIMEOUT_MS = 15_000;

// Single source of truth for gateway-URL redaction: the crawler's HTTP layer
// (`sanitizeProxyFromMessage` in core/http.ts — the same function the engine
// and the worker's boundary net use). Loaded via Node 24's native type-
// stripping, like the worker loads the crawler module itself. Cached after
// the first successful load; the local fallback below is only a safety net
// if that import ever fails (identical behavior, no second implementation
// to maintain).
let sharedRedact = null;
let sharedRedactPromise = null;
function loadSharedRedact() {
  if (!sharedRedactPromise) {
    sharedRedactPromise = (async () => {
      try {
        const moduleUrl = pathToFileURL(
          path.join(
            __dirname,
            '../crawler/core/http.ts'
          )
        ).href;
        const mod = await import(moduleUrl);
        sharedRedact = mod.sanitizeProxyFromMessage ?? null;
      } catch {
        sharedRedact = null;
      }
    })();
  }
  return sharedRedactPromise;
}

/** Redacts a gateway URL (and its credential form) out of an error message. */
async function redact(message, proxy) {
  await loadSharedRedact();
  if (sharedRedact) return sharedRedact(message, proxy);
  let text = String(message ?? '');
  if (proxy) {
    const withoutCreds = proxy.replace(/\/\/[^@/]*@/, '//[redacted]@');
    text = text.split(proxy).join('[proxy]').split(withoutCreds).join('[proxy]');
  }
  return text;
}

/** Parses an IP-echo body into a short IP string (best effort). */
function exitIpFrom(body, contentType) {
  if (contentType && contentType.includes('json')) {
    try {
      const json = JSON.parse(body);
      if (typeof json.ip === 'string') return json.ip;
      if (typeof json.origin === 'string') return json.origin.split(',')[0].trim();
    } catch {
      // Fall through to the raw-body heuristic.
    }
  }
  const trimmed = String(body ?? '').trim();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(trimmed)) return trimmed;
  return trimmed.slice(0, 64) || null;
}

/** POST /api/proxy/test — verify a gateway + show the exit IP it would use. */
const testProxy = async (req, res) => {
  try {
    const proxy = String(req.body?.proxy ?? '').trim();
    if (!/^https?:\/\/\S+/i.test(proxy)) {
      return res.status(400).json({
        success: false,
        message: 'Proxy must be a valid http(s) URL'
      });
    }
    const url = String(req.body?.url ?? IP_ECHO_URL).trim() || IP_ECHO_URL;
    const startedAt = Date.now();
    const agent = new ProxyAgent(proxy);
    try {
      const response = await undiciFetch(url, {
        dispatcher: agent,
        signal: AbortSignal.timeout(PROXY_TEST_TIMEOUT_MS),
        headers: { accept: 'application/json' }
      });
      const body = await response.text();
      return res.json({
        success: true,
        data: {
          ok: response.ok,
          exitIp: response.ok
            ? exitIpFrom(body, response.headers.get('content-type'))
            : null,
          status: response.status,
          latencyMs: Date.now() - startedAt,
          error: response.ok ? null : `HTTP ${response.status} from the proxy`
        }
      });
    } catch (error) {
      return res.json({
        success: true,
        data: {
          ok: false,
          exitIp: null,
          status: null,
          latencyMs: Date.now() - startedAt,
          error: await redact(error, proxy)
        }
      });
    } finally {
      agent.close().catch(() => {});
    }
  } catch (error) {
    console.error('Proxy test error:', await redact(error, req.body?.proxy));
    res.status(500).json({
      success: false,
      message: await redact(error, req.body?.proxy)
    });
  }
};

module.exports = { testProxy };
