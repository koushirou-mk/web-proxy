import express from "express";
import dns from "node:dns/promises";
import dnsSync from "node:dns";
import http from "node:http";
import https from "node:https";

dnsSync.setDefaultResultOrder("ipv4first");
import net from "node:net";
import { Readable } from "node:stream";

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

function requestUpstream(url, headers) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const client = target.protocol === "https:" ? https : http;

    const request = client.request(target, {
      method: "GET",
      headers,
      maxHeaderSize: 128 * 1024,
      timeout: 30000
    }, resolve);

    request.on("timeout", () => request.destroy(new Error("Upstream request timed out")));
    request.on("error", reject);
    request.end();
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

app.get("/proxy", async (req, res) => {
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
    const headers = {
      "user-agent": req.get("user-agent") || "Mozilla/5.0",
      "accept": req.get("accept") || "*/*",
      "accept-language": req.get("accept-language") || "ja,en;q=0.8"
    };

    if (req.get("range")) headers.range = req.get("range");
    if (req.get("referer")) headers.referer = req.get("referer");

    const upstream = await requestUpstream(target.href, {
      "user-agent": req.get("user-agent") || "Mozilla/5.0",
      "accept": req.get("accept") || "*/*",
      "accept-language": req.get("accept-language") || "ja,en;q=0.8",
      ...(req.get("range") ? { range: req.get("range") } : {}),
      ...(req.get("referer") ? { referer: req.get("referer") } : {})
    });

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
