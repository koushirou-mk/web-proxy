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

app.use(express.static("public"));

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
  const shim = `<script>
(() => {
  const prefix = ${JSON.stringify(proxyPrefix)};
  const origin = ${JSON.stringify(base.origin)};

  const toProxy = (value) => {
    try {
      const raw = typeof value === "string" ? value : value?.url;
      if (!raw) return value;
      const u = new URL(raw, location.href);
      if (u.origin !== origin) return value;
      if (u.pathname.startsWith("/proxy")) return value;
      const proxied = prefix + encodeURIComponent(u.href);
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
})();
</script>`;

  // Put the shim before site scripts so API calls are intercepted early.
  if (/<head\\b[^>]*>/i.test(html)) {
    html = html.replace(/(<head\\b[^>]*>)/i, "$1" + shim);
  } else {
    html = shim + html;
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

app.all("/proxy", async (req, res) => {
  const rawUrl = typeof req.query.url === "string" ? req.query.url : "";

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

app.listen(PORT, () => {
  console.log("web-proxy listening on " + PORT);
});
