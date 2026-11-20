import express from "express";
import { createProxyMiddleware, responseInterceptor } from "http-proxy-middleware";

const app = express();
const PORT = process.env.PORT || 3000;

app.disable("x-powered-by");

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "web-proxy" });
});

app.use(express.static("public"));

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
    /(<(?:img|script|iframe|video|audio|source|track|input|embed|object|link)[^>]+\s(?:src|href|poster|data)=["'])([^"']+)(["'])/gi,
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
          if (!url) return item;
          return [url, ...parts.slice(1)].join(" ");
        })
        .join(", ");
      return prefix + rewritten + suffix;
    }
  );

  // CSS url(...) inside inline styles.
  html = html.replace(
    /url\((["']?)([^)"']+)\1\)/gi,
    (full, quote, value) => {
      if (/^(data:|blob:|https?:\/\/|\/\/)/i.test(value)) {
        if (/^https?:\/\//i.test(value)) {
          const rewritten = proxyUrl(value, base);
          return rewritten ? "url(" + quote + rewritten + quote + ")" : full;
        }
        return full;
      }
      const rewritten = proxyUrl(value, base);
      return rewritten ? "url(" + quote + rewritten + quote + ")" : full;
    }
  );

  return html;
}

function rewriteLocationHeader(location, target) {
  try {
    const absolute = new URL(location, target).href;
    return "/proxy?url=" + encodeURIComponent(absolute);
  } catch {
    return location;
  }
}

app.use(
  "/proxy",
  createProxyMiddleware({
    changeOrigin: true,
    ws: true,
    selfHandleResponse: true,

    router: (req) => {
      const target = req.query.url;
      if (!target) return "http://example.com";

      try {
        const parsed = new URL(target);
        if (!["http:", "https:"].includes(parsed.protocol)) {
          throw new Error("Unsupported protocol");
        }
        return parsed.origin;
      } catch {
        return "http://example.com";
      }
    },

    pathRewrite: (path, req) => {
      const target = req.query.url;
      if (!target) return "/";

      try {
        const u = new URL(target);
        return u.pathname + u.search;
      } catch {
        return "/";
      }
    },

    on: {
      proxyReq(proxyReq, req) {
        const target = req.query.url;
        if (target) {
          try {
            const u = new URL(target);
            proxyReq.setHeader("host", u.host);
            proxyReq.setHeader("referer", u.origin + "/");
          } catch {}
        }
      },

      proxyRes: responseInterceptor(async (responseBuffer, proxyRes, req, res) => {
        const target = req.query.url;

        if (proxyRes.headers.location && target) {
          proxyRes.headers.location = rewriteLocationHeader(
            proxyRes.headers.location,
            target
          );
        }

        const contentType = String(proxyRes.headers["content-type"] || "");

        if (!target || !contentType.includes("text/html")) {
          return responseBuffer;
        }

        try {
          const html = responseBuffer.toString("utf8");
          return rewriteHtml(html, target);
        } catch {
          return responseBuffer;
        }
      })
    }
  })
);

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "Proxy error" });
});

app.listen(PORT, () => {
  console.log(`web-proxy listening on ${PORT}`);
});
