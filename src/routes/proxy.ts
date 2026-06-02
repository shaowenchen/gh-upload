import { Router } from "express";
import https from "node:https";

export const proxyRouter = Router();

proxyRouter.get("/:a/:b/:c", (req, res) => {
  const { a, b, c } = req.params;
  const targetPath = `/${a}/${b}/${c}`;

  const proxyReq = https.request(
    {
      hostname: "raw.githubusercontent.com",
      path: targetPath,
      method: "GET",
    },
    (proxyRes) => {
      if (targetPath.endsWith(".pdf")) {
        res.setHeader("content-type", "application/pdf");
      }
      if (proxyRes.headers["content-type"]) {
        res.setHeader("content-type", proxyRes.headers["content-type"]);
      }
      res.status(proxyRes.statusCode || 200);
      proxyRes.pipe(res);
    }
  );

  proxyReq.on("error", () => {
    if (!res.headersSent) {
      res.status(502).end();
    }
  });

  proxyReq.end();
});