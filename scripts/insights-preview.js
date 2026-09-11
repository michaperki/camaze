// Local-only UI preview with simulated authentication and usage. Never loads .env.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { createHandler } = require("../api/insights");
const { extract, normalize } = require("../lib/insights/source");
const { models } = require("../lib/insights/catalog");
const root = path.resolve(__dirname, "../public");
const now = () => new Date();
const snapshot = process.env.INSIGHTS_PREVIEW_HTML ? normalize(extract(fs.readFileSync(process.env.INSIGHTS_PREVIEW_HTML, "utf8")), models, fs.statSync(process.env.INSIGHTS_PREVIEW_HTML).mtime.toISOString()) : null;
const handler = createHandler({ verifyUser: async () => ({ id: "preview" }), getSource: async () => ({ status: snapshot ? "ok" : "pending", snapshot }),
  getUsage: async () => ["gpt-4o-2024-11-20", "gpt-4o"].map(model => ({ provider: "openai", model, amount_usd: 1, date: new Date(+now() - 2 * 86400000).toISOString().slice(0, 10) })) }, now);
http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  res.status = n => { res.statusCode = n; return res; };
  res.json = body => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(body)); };
  if (url.pathname === "/api/insights") { req.query = Object.fromEntries(url.searchParams); return handler(req, res); }
  if (url.pathname === "/api/config") return res.json({ supabaseUrl: "preview", supabaseAnonKey: "preview" });
  if (url.pathname === "/preview-auth.js") { res.setHeader("Content-Type", "text/javascript"); return res.end('window.supabase={createClient:()=>({auth:{getSession:async()=>({data:{session:{user:{email:"Local preview"},access_token:"preview"}}}),signOut:async()=>{}}})};'); }
  const filename = path.resolve(root, "." + (url.pathname === "/" ? "/insights.html" : url.pathname));
  if (!filename.startsWith(root + path.sep)) return res.status(404).end();
  try {
    let body = fs.readFileSync(filename);
    if (filename.endsWith(".html")) body = body.toString().replace("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js", "/preview-auth.js").replace("<main>", '<main><p style="color:var(--warning);font-size:13px">LOCAL PREVIEW: simulated usage and sign-in. Benchmark data is ' + (snapshot ? "from a public page fetched during this session." : "unavailable.") + '</p>');
    res.setHeader("Content-Type", ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" })[path.extname(filename)] || "application/octet-stream");
    res.end(body);
  } catch { res.status(404).end(); }
}).listen(Number(process.env.PORT || 3017), "127.0.0.1", () => console.log("Insights preview: http://127.0.0.1:" + (process.env.PORT || 3017)));
