import express from "express";
import dns from "node:dns/promises";
import dnsSync from "node:dns";
import http from "node:http";
import https from "node:https";

dnsSync.setDefaultResultOrder("ipv4first");
import net from "node:net";

const app = express();
const PORT = process.env.PORT || 3000;

app.disable("x-powered-by");

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "web-proxy" });
});

// YouTube uses this lightweight endpoint as an online/offline connectivity check.
// Return a clean 204 from the proxy origin so the check itself cannot fail because
// the browser is unable to reach YouTube directly.
app.all("/youtube-generate-204", (_req, res) => {
  res.status(204).end();
});

app.post("/youtube-debug", express.json({ limit: "2kb" }), (req, res) => {
  const event = typeof req.body?.event === "string" ? req.body.event : "unknown";
  const detail = req.body?.detail && typeof req.body.detail === "object" ? req.body.detail : {};
  console.log("[yt-debug]", event, JSON.stringify(detail).slice(0, 1000));
  res.status(204).end();
});

app.use(express.static("public"));

// Explicit root route for Vercel's serverless Express runtime.
// Keep the Render/local behavior unchanged while ensuring GET / is served
// even when the static middleware is not resolved as the project root.
app.get("/", (_req, res) => {
  res.sendFile(new URL("./public/index.html", import.meta.url).pathname);
});

// Vercel's Express runtime should serve the proxy landing page explicitly.
// Keep / as a normal Express route as well as the static index fallback.
app.get("/", (_req, res) => {
  res.sendFile("index.html", { root: "public" });
});

app.get("/sw.js", (_req, res) => {
  res.type("application/javascript").send(`self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // Never intercept the proxy's own relay endpoints or the service worker itself.
  if (url.pathname === "/proxy" || url.pathname === "/yt-api" || url.pathname === "/sw.js") {
    return;
  }

  const clientPromise = request.clientId ? self.clients.get(request.clientId) : Promise.resolve(null);

  event.respondWith((async () => {
    const client = await clientPromise;
    const clientUrl = client ? new URL(client.url) : null;

    // The proxied YouTube page carries its real upstream URL in /proxy?url=...
    // Use that origin as the base for relative API requests such as
    // /youtubei/v1/search. This catches requests made outside window.fetch,
    // including worker/service-worker initiated fetches.
    if (clientUrl && clientUrl.pathname === "/proxy") {
      const upstreamRaw = clientUrl.searchParams.get("url");
      if (upstreamRaw) {
        try {
          const upstreamBase = new URL(upstreamRaw);
          let target;

          if (url.origin === self.location.origin) {
            target = new URL(url.pathname + url.search, upstreamBase.origin);
          } else if (url.protocol === "http:" || url.protocol === "https:") {
            target = url;
          }

          if (target && target.pathname === "/generate_204") {
            return fetch(new Request(new URL("/youtube-generate-204", self.location.origin), request));
          }

          if (target && !target.pathname.startsWith("/proxy") && !target.pathname.startsWith("/yt-api")) {
            const relay = new URL("/proxy", self.location.origin);
            relay.searchParams.set("url", target.href);

            return fetch(new Request(relay.href, request));
          }
        } catch {}
      }
    }

    return fetch(request);
  })());
});`);
});

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }

  if (net.isIPv6(ip)) {
    const normalized = ip.toLowerCase();
    return normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:");
  }

  return false;
}

async function validateTarget(rawUrl) {
  const target = new URL(rawUrl);

  if (!["http:", "https:"].includes(target.protocol)) {
    throw new Error("Unsupported protocol");
  }

  if (target.username || target.password) {
    throw new Error("Credentials in URL are not allowed");
  }

  const hostname = target.hostname.toLowerCase();

  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local")
  ) {
    throw new Error("Private host is not allowed");
  }

  const addresses = await dns.lookup(hostname, { all: true });
  if (addresses.some(({ address }) => isPrivateIp(address))) {
    throw new Error("Private host is not allowed");
  }

  return target;
}

function proxyUrl(target, base) {
  try {
    const u = new URL(target, base);
    if (!["http:", "https:"].includes(u.protocol)) return null;

    // YouTube's InnerTube API is POST-based. Give it a dedicated same-origin
    // relay so the browser can send the original request body and the proxy
    // can forward the YouTube-specific headers/cookies without depending on
    // URL rewriting inside the site's JavaScript.
    const isYouTubeApi =
      (u.hostname === "www.youtube.com" ||
        u.hostname === "youtubei.googleapis.com" ||
        u.hostname === "music.youtube.com") &&
      u.pathname.startsWith("/youtubei/");

    if (isYouTubeApi) {
      return "/yt-api?url=" + encodeURIComponent(u.href);
    }

    return "/proxy?url=" + encodeURIComponent(u.href);
  } catch {
    return null;
  }
}

function rewriteHtml(html, target) {
  const base = new URL(target);

  html = html.replace(
    /(<(?:img|script|iframe|video|audio|source|track|input|embed|object)[^>]+\s(?:src|poster|data)=["'])([^"']+)(["'])/gi,
    (full, prefix, value, suffix) => {
      if (/^(data:|blob:|javascript:|mailto:|tel:|#)/i.test(value)) return full;
      const rewritten = proxyUrl(value, base);
      return rewritten ? prefix + rewritten + suffix : full;
    }
  );

  html = html.replace(
    /(<link[^>]+\shref=["'])([^"']+)(["'])/gi,
    (full, prefix, value, suffix) => {
      if (/^(data:|blob:|javascript:|mailto:|tel:|#)/i.test(value)) return full;
      const rewritten = proxyUrl(value, base);
      return rewritten ? prefix + rewritten + suffix : full;
    }
  );

  html = html.replace(
    /(<(?:a|form)[^>]+\s(?:href|action)=["'])([^"']+)(["'])/gi,
    (full, prefix, value, suffix) => {
      if (/^(javascript:|mailto:|tel:|#)/i.test(value)) return full;
      const rewritten = proxyUrl(value, base);
      return rewritten ? prefix + rewritten + suffix : full;
    }
  );

  html = html.replace(
    /(<[^>]+\ssrcset=["'])([^"']+)(["'])/gi,
    (full, prefix, value, suffix) => {
      const rewritten = value
        .split(",")
        .map((item) => {
          const parts = item.trim().split(/\s+/);
          const url = proxyUrl(parts[0], base);
          return url ? [url, ...parts.slice(1)].join(" ") : item;
        })
        .join(", ");
      return prefix + rewritten + suffix;
    }
  );

  html = html.replace(
    /url\((["']?)([^)"']+)\1\)/gi,
    (full, quote, value) => {
      if (/^(data:|blob:|javascript:)/i.test(value)) return full;
      const rewritten = proxyUrl(value, base);
      return rewritten ? "url(" + quote + rewritten + quote + ")" : full;
    }
  );

  // YouTube and other modern sites make API calls from JavaScript after the
  // initial HTML loads. Those calls use relative or same-origin URLs and would
  // otherwise bypass this proxy. Install a small early shim that routes
  // fetch/XHR/WebSocket/navigation URLs back through /proxy.
  const proxyPrefix = "/proxy?url=";
  const youtubeApiPrefix = "/yt-api?url=";
  const shim = `<script>
(() => {
  const prefix = ${JSON.stringify(proxyPrefix)};
  const origin = ${JSON.stringify(base.origin)};

  const toProxy = (value) => {
    try {
      const raw = typeof value === "string" ? value : value?.url;
      if (!raw) return value;
      const u = new URL(raw, origin + "/");
      if (!["http:", "https:"].includes(u.protocol)) return value;
      if (u.pathname.startsWith("/proxy") && u.origin === location.origin) return value;

      // Modern sites such as YouTube call the InnerTube API with POST.
      // Route those calls through a dedicated relay instead of the generic
      // page proxy. This preserves the request body and YouTube API headers.
      const isYouTubeApi =
        (u.hostname === "www.youtube.com" ||
          u.hostname === "youtubei.googleapis.com" ||
          u.hostname === "music.youtube.com") &&
        u.pathname.startsWith("/youtubei/");

      // YouTube search can navigate through a page-level URL rather than
      // window.fetch/XHR. Force the search endpoint itself through the proxy.
      if (u.hostname === "www.youtube.com" && u.pathname === "/generate_204") {
        return "/youtube-generate-204";
      }

      if (u.hostname === "www.youtube.com" && u.pathname === "/results") {
        const searchUrl = prefix + encodeURIComponent(u.href);
        if (typeof value === "string") return searchUrl;
        return new Request(searchUrl, value);
      }

      const proxied = (isYouTubeApi ? youtubeApiPrefix : prefix) + encodeURIComponent(u.href);
      if (typeof value === "string") return proxied;
      return new Request(proxied, value);
    } catch {
      return value;
    }
  };

  const originalFetch = window.fetch;
  window.fetch = function(input, init) {
    return originalFetch.call(this, toProxy(input), init);
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    return originalOpen.call(this, method, toProxy(url), ...rest);
  };

  const originalWebSocket = window.WebSocket;
  window.WebSocket = function(url, protocols) {
    const proxied = toProxy(url);
    return new originalWebSocket(proxied, protocols);
  };
  window.WebSocket.prototype = originalWebSocket.prototype;

  // Some YouTube code runs network requests from dedicated workers or uses
  // browser networking APIs that are not covered by fetch/XHR hooks. Route
  // those URL-bearing entry points through the same proxy as well.
  const originalWorker = window.Worker;
  if (originalWorker) {
    window.Worker = function(scriptURL, options) {
      return new originalWorker(toProxy(scriptURL), options);
    };
    window.Worker.prototype = originalWorker.prototype;
  }

  const originalSharedWorker = window.SharedWorker;
  if (originalSharedWorker) {
    window.SharedWorker = function(scriptURL, options) {
      return new originalSharedWorker(toProxy(scriptURL), options);
    };
    window.SharedWorker.prototype = originalSharedWorker.prototype;
  }

  const originalEventSource = window.EventSource;
  if (originalEventSource) {
    window.EventSource = function(url, options) {
      return new originalEventSource(toProxy(url), options);
    };
    window.EventSource.prototype = originalEventSource.prototype;
  }

  const originalSendBeacon = navigator.sendBeacon?.bind(navigator);
  if (originalSendBeacon) {
    navigator.sendBeacon = function(url, data) {
      return originalSendBeacon(toProxy(url), data);
    };
  }

  // SPA navigation/forms can otherwise escape the proxy even though fetch/XHR
  // requests are intercepted. Catch same-origin navigations as well.
  document.addEventListener("submit", (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    const rawAction = form.getAttribute("action") || location.href;
    try {
      const actionUrl = new URL(rawAction, origin + "/");
      let u = actionUrl;

      // rewriteHtml() rewrites YouTube's form action to /proxy?url=... .
      // In that case the search query must be merged into the embedded
      // upstream URL, not appended to the outer /proxy URL. Otherwise the
      // proxy receives /proxy?url=https://www.youtube.com/results with
      // search_query sitting outside the encoded target, so /results is never
      // requested upstream.
      if (actionUrl.origin === location.origin && actionUrl.pathname === "/proxy") {
        const embedded = actionUrl.searchParams.get("url");
        if (!embedded) return;
        u = new URL(embedded);
      } else if (actionUrl.origin !== origin) {
        return;
      }

      event.preventDefault();

      const data = new FormData(form);
      const method = (form.method || "get").toLowerCase();

      if (method === "get") {
        for (const [key, value] of data.entries()) {
          if (typeof value === "string") {
            u.searchParams.set(key, value);
          }
        }
        location.href = prefix + encodeURIComponent(u.href);
      }
    } catch {}
  }, true);

  // YouTube's search UI is a custom button, so it may never submit the
  // rewritten HTML form. Capture Enter on the actual search input before
  // YouTube handles the event and navigate directly to the proxied /results URL.
  const findSearchInput = (root) => {
    if (!root) return null;
    const direct = root.querySelector?.('#search, input[name="search_query"]');
    if (direct) return direct;

    for (const element of root.querySelectorAll?.("*") || []) {
      if (element.shadowRoot) {
        const nested = findSearchInput(element.shadowRoot);
        if (nested) return nested;
      }
    }
    return null;
  };

  const getSearchInput = (event) => {
    // Search events can cross a custom-element boundary. composedPath()
    // identifies the real input even when document.querySelector() cannot.
    const path = typeof event?.composedPath === "function" ? event.composedPath() : [];
    const fromPath = path.find(
      (node) =>
        node instanceof HTMLInputElement &&
        (node.matches("#search") || node.name === "search_query")
    );
    if (fromPath) return fromPath;

    const active = document.activeElement;
    if (
      active instanceof HTMLInputElement &&
      (active.matches("#search") || active.name === "search_query")
    ) {
      return active;
    }

    return findSearchInput(document);
  };

  const originalSendBeaconForDebug = navigator.sendBeacon?.bind(navigator);
  const youtubeDebug = (event, detail = {}) => {
    try {
      if (originalSendBeaconForDebug) {
        originalSendBeaconForDebug("/youtube-debug", new Blob([
          JSON.stringify({ event, detail })
        ], { type: "application/json" }));
      }
    } catch {}
  };

  const navigateYouTubeSearch = (event) => {
    const input = getSearchInput(event);
    youtubeDebug("navigate-attempt", {
      inputFound: !!input,
      tag: input?.tagName || null,
      name: input?.name || null,
      valueLength: input ? String(input.value || "").length : 0
    });
    if (!input) return false;

    const query = String(input.value || "").trim();
    if (!query) {
      youtubeDebug("navigate-empty", {});
      return false;
    }

    event.preventDefault();
    event.stopImmediatePropagation();

    const results = new URL("https://www.youtube.com/results");
    results.searchParams.set("search_query", query);
    youtubeDebug("navigate", { valueLength: query.length });
    location.href = prefix + encodeURIComponent(results.href);
    return true;
  };

  document.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.key !== "Enter") return;
    youtubeDebug("keydown-enter", {
      targetTag: event.target?.tagName || null,
      targetName: event.target?.name || null
    });

    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    const inSearchBox = path.some(
      (node) =>
        node instanceof HTMLInputElement &&
        (node.matches("#search") || node.name === "search_query") ||
        node?.matches?.("ytd-searchbox, ytm-searchbox, yt-searchbox")
    );

    if (!inSearchBox) return;
    navigateYouTubeSearch(event);
  }, true);

  // The iPad search control may be a custom element or a button inside a
  // shadow root. Use the composed event path instead of relying on
  // document.querySelector() for the button itself.
  document.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0) return;

    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    const isSearchControl = path.some(
      (node) =>
        node?.matches?.(
          "#search-icon-legacy, ytd-searchbox, ytm-searchbox, yt-searchbox, " +
          'button[aria-label*="Search"], button[aria-label*="検索"]'
        )
    );

    if (!isSearchControl) return;
    navigateYouTubeSearch(event);
  }, true);

  document.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0) return;

    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    const isSearchButton = path.some(
      (node) =>
        node?.matches?.(
          "#search-icon-legacy, button[aria-label*=\"Search\"], button[aria-label*=\"検索\"]"
        )
    );

    if (!isSearchButton) return;
    navigateYouTubeSearch(event);
  }, true);

  document.addEventListener("click", (event) => {
    const anchor = event.target?.closest?.("a[href]");
    if (!anchor) return;
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

    try {
      const u = new URL(anchor.getAttribute("href"), origin + "/");
      if (u.origin !== origin) return;
      if (u.pathname.startsWith("/proxy")) return;
      event.preventDefault();
      location.href = prefix + encodeURIComponent(u.href);
    } catch {}
  }, true);
})();
</script>`;

  // Register a same-origin service worker as a second interception layer.
  // This catches requests initiated outside window.fetch/XHR as well.
  const swShim = `<script>
(() => {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {});
  }
})();
</script>`;

  // Keep the generic proxy generic: only inject the heavy client-side
  // interception layer into YouTube pages. Ordinary sites get only the
  // normal URL rewriting above.
  const isYouTubePage =
    base.hostname === "www.youtube.com" ||
    base.hostname === "youtube.com" ||
    base.hostname === "m.youtube.com";

  if (isYouTubePage) {
    // Put the shim before site scripts so YouTube API calls are intercepted early.
    if (/<head\b[^>]*>/i.test(html)) {
      html = html.replace(/(<head\b[^>]*>)/i, "$1" + shim);
    } else {
      html = shim + html;
    }
  }

  return html;
}

function rewriteLocation(location, target) {
  try {
    const absolute = new URL(location, target).href;
    return "/proxy?url=" + encodeURIComponent(absolute);
  } catch {
    return location;
  }
}

function requestUpstream(url, method, headers, req) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const client = target.protocol === "https:" ? https : http;

    const requestHeaders = { ...headers };
    delete requestHeaders.host;
    delete requestHeaders.connection;

    const request = client.request(target, {
      method,
      headers: requestHeaders,
      maxHeaderSize: 128 * 1024,
      timeout: 60000
    }, resolve);

    request.on("timeout", () => request.destroy(new Error("Upstream request timed out")));
    request.on("error", reject);

    if (method === "GET" || method === "HEAD") {
      request.end();
    } else {
      req.pipe(request);
    }
  });
}

function setProxySafeCookies(headers, res) {
  const raw = headers["set-cookie"];
  if (!raw) return;

  const cookies = (Array.isArray(raw) ? raw : [raw]).map((cookie) =>
    cookie
      .replace(/;\\s*Domain=[^;]+/gi, "")
      .replace(/;\\s*Path=[^;]+/gi, "; Path=/")
  );

  res.setHeader("set-cookie", cookies);
}

function copyResponseHeadersFromNode(source, res) {
  const skip = new Set([
    "content-length",
    "connection",
    "keep-alive",
    "transfer-encoding"
  ]);

  for (const [key, value] of Object.entries(source)) {
    if (!skip.has(key.toLowerCase()) && value !== undefined) {
      res.setHeader(key, value);
    }
  }
}

function copyResponseHeaders(source, res) {
  const skip = new Set([
    "content-length",
    "content-encoding",
    "transfer-encoding",
    "connection",
    "keep-alive"
  ]);

  for (const [key, value] of source.entries()) {
    if (!skip.has(key.toLowerCase())) res.setHeader(key, value);
  }
}

app.all("/yt-api", async (req, res) => {
  const rawUrl = typeof req.query.url === "string" ? req.query.url : "";

  if (!rawUrl) {
    return res.status(400).send("Missing url");
  }

  let target;
  try {
    target = await validateTarget(rawUrl);

    const allowedHost = new Set([
      "www.youtube.com",
      "youtubei.googleapis.com",
      "music.youtube.com"
    ]);

    if (!allowedHost.has(target.hostname.toLowerCase()) ||
        !target.pathname.startsWith("/youtubei/")) {
      throw new Error("YouTube API host is not allowed");
    }
  } catch (error) {
    return res.status(400).send("Invalid YouTube API target: " + error.message);
  }

  try {
    // YouTube also performs its connectivity check against i.ytimg.com.
    // Return 204 locally for this check instead of making the image host decide
    // whether the proxied browser is online.
    if (target.pathname === "/generate_204" &&
        (target.hostname === "www.youtube.com" || target.hostname === "i.ytimg.com")) {
      return res.status(204).end();
    }

    const incomingHeaders = { ...req.headers };
    delete incomingHeaders.host;
    delete incomingHeaders.connection;

    // InnerTube expects the request to look like a first-party YouTube
    // request. Keep YouTube's client headers/cookies/body from Safari while
    // replacing only the network destination.
    // InnerTube API requests are initiated by the YouTube web client.
    // Even when the network host is youtubei.googleapis.com, the browser
    // origin/referer must remain the YouTube website origin.
    incomingHeaders.origin = "https://www.youtube.com";
    incomingHeaders.referer = "https://www.youtube.com/";
    incomingHeaders["x-origin"] = "https://www.youtube.com";
    incomingHeaders["accept-encoding"] = "identity";

    const upstream = await requestUpstream(
      target.href,
      req.method,
      incomingHeaders,
      req
    );

    console.log(
      "[yt-api]",
      req.method,
      target.hostname + target.pathname,
      "=>",
      upstream.statusCode,
      upstream.headers["content-type"] || "no-content-type"
    );

    if (upstream.statusCode >= 300 && upstream.statusCode < 400) {
      const location = upstream.headers.location;
      if (location) {
        res.status(upstream.statusCode);
        copyResponseHeadersFromNode(upstream.headers, res);
        res.setHeader("location", rewriteLocation(location, target.href));
        upstream.resume();
        return res.end();
      }
    }

    res.status(upstream.statusCode || 502);
    copyResponseHeadersFromNode(upstream.headers, res);
    setProxySafeCookies(upstream.headers, res);

    // The API response is intentionally streamed untouched. YouTube's
    // client expects its original JSON structure and response headers.
    return upstream.pipe(res);
  } catch (error) {
    console.error("YouTube API proxy error:", error, error?.cause || "");
    const detail =
      error?.cause?.code ||
      error?.cause?.message ||
      error?.code ||
      error?.message ||
      "unknown";

    return res.status(502).send("YouTube API proxy error: " + detail);
  }
});

// YouTube uses normal browser navigation for video, Shorts, channels, playlists, etc.
// If that navigation reaches the proxy origin without the client shim rewriting it,
// recover the upstream YouTube URL server-side instead of letting Express return
// "Cannot GET /...".
app.all(/^\/(?:shorts|watch|channel|playlist|@[^/]+)(?:\/|$)/, (req, res) => {
  const target = new URL("https://www.youtube.com" + req.originalUrl);
  return res.redirect("/proxy?url=" + encodeURIComponent(target.href));
});

app.all("/results", (req, res) => {
  const searchQuery = typeof req.query.search_query === "string"
    ? req.query.search_query
    : "";

  // If YouTube's SPA navigation escapes the client shim and lands on the
  // proxy origin as /results, recover it server-side instead of returning
  // Express's default "Cannot GET /results".
  if (searchQuery) {
    const target = new URL("https://www.youtube.com/results");
    target.searchParams.set("search_query", searchQuery);

    const extra = new URLSearchParams();
    for (const [key, value] of Object.entries(req.query)) {
      if (key === "search_query" || typeof value !== "string") continue;
      extra.set(key, value);
    }

    const query = extra.toString();
    if (query) {
      for (const [key, value] of extra.entries()) {
        target.searchParams.set(key, value);
      }
    }

    return res.redirect("/proxy?url=" + encodeURIComponent(target.href));
  }

  return res.status(404).send("Not found");
});

app.all("/proxy", async (req, res) => {
  const rawUrl = typeof req.query.url === "string" ? req.query.url : "";
  console.log("[proxy]", req.method, rawUrl.slice(0, 240));

  if (!rawUrl) {
    return res.status(400).send("Missing url");
  }

  let target;
  try {
    target = await validateTarget(rawUrl);
  } catch (error) {
    return res.status(400).send("Invalid target: " + error.message);
  }

  try {
    // YouTube's connectivity check can arrive through the generic proxy,
    // not /yt-api. Handle the image-host check here as well.
    if (
      target.hostname === "i.ytimg.com" &&
      target.pathname === "/generate_204"
    ) {
      return res.status(204).end();
    }

    const incomingHeaders = { ...req.headers };
    delete incomingHeaders.host;
    delete incomingHeaders.connection;

    // Keep browser identity/session headers, but make them describe the
    // upstream site rather than the Render proxy.
    incomingHeaders.host = target.host;
    incomingHeaders.origin = target.origin;
    incomingHeaders.referer = target.origin + "/";
    incomingHeaders["accept-encoding"] = "identity";

    const upstream = await requestUpstream(
      target.href,
      req.method,
      incomingHeaders,
      req
    );

    if (upstream.statusCode >= 300 && upstream.statusCode < 400) {
      const location = upstream.headers.location;
      if (location) {
        res.status(upstream.statusCode);
        copyResponseHeadersFromNode(upstream.headers, res);
        res.setHeader("location", rewriteLocation(location, target.href));
        upstream.resume();
        return res.end();
      }
    }

    const contentType = String(upstream.headers["content-type"] || "");
    res.status(upstream.statusCode || 502);
    copyResponseHeadersFromNode(upstream.headers, res);
    setProxySafeCookies(upstream.headers, res);

    if (contentType.includes("text/html")) {
      const chunks = [];
      for await (const chunk of upstream) chunks.push(Buffer.from(chunk));
      const html = Buffer.concat(chunks).toString("utf8");

      // These headers can prevent the injected proxy shim from running.
      res.removeHeader("content-security-policy");
      res.removeHeader("content-security-policy-report-only");
      res.removeHeader("x-frame-options");
      res.removeHeader("content-length");
      res.removeHeader("content-encoding");

      return res.send(rewriteHtml(html, target.href));
    }

    return upstream.pipe(res);
  } catch (error) {
    console.error("Proxy error:", error, error?.cause || "");
    const detail = error?.cause?.code || error?.cause?.message || error?.code || error?.message || "unknown";
    return res.status(502).send("Error occurred while trying to proxy: " + detail);
  }
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "Proxy error" });
});

// Render/local runs the Express listener normally. Vercel imports the app
// as a serverless function instead of opening a long-lived listener.
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log("web-proxy listening on " + PORT);
  });
}

export default app;
