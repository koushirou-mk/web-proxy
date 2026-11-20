import express from "express";
import { createProxyMiddleware } from "http-proxy-middleware";

const app = express();
const PORT = process.env.PORT || 3000;

app.disable("x-powered-by");

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "web-proxy" });
});

app.use(express.static("public"));

app.use(
  "/proxy",
  createProxyMiddleware({
    changeOrigin: true,
    ws: true,
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
      if (!target) return path;
      try {
        return new URL(target).pathname + new URL(target).search;
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
      }
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
