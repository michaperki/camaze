// Streaming reverse proxy for Anthropic/OpenAI. A customer points their SDK
// at /api/gateway/<provider>/... with a camaze gateway key instead of their
// real one; we authenticate the gateway key, forward the request to the real
// provider with the user's stored key, stream the response back byte-for-byte,
// and log cost/usage afterward. Never buffers the response before forwarding —
// logging happens after the client has already gotten every byte.
const crypto = require("node:crypto");
const cryptoLib = require("../lib/crypto");
const { lookupGatewayKey, getProviderKey, logGatewayRequest } = require("../lib/supabase");

const UPSTREAM_HOST = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com",
};

// USD per million tokens, [input, output]. Unlisted models cost 0 — spend
// still shows up by token count, just not priced, rather than guessing.
const PRICE_PER_MILLION = {
  anthropic: {
    "claude-sonnet-4-6": [3.00, 15.00],
    "claude-opus-4-5": [15.00, 75.00],
    "claude-haiku-4-5": [0.80, 4.00],
  },
  openai: {
    "gpt-4o": [2.50, 10.00],
    "gpt-4o-mini": [0.15, 0.60],
    "o3": [10.00, 40.00],
  },
};

// Response headers that describe the upstream TCP/HTTP framing, not the
// payload — copying them would corrupt what we send (wrong length after
// streaming, double-encoding, etc).
const HOP_BY_HOP = new Set(["content-length", "content-encoding", "transfer-encoding", "connection", "keep-alive"]);

function hashKey(key) {
  return crypto.createHash("sha256").update(key).digest("hex");
}

function extractGatewayKey(req) {
  if (req.headers["x-api-key"]) return String(req.headers["x-api-key"]);
  const auth = req.headers["authorization"];
  if (auth && auth.startsWith("Bearer ")) return auth.slice(7);
  return null;
}

// "/api/gateway/anthropic/v1/messages" arrives here as req.query.rest ===
// "anthropic/v1/messages" (see the vercel.json rewrite) — split off the
// provider, forward everything after it as-is.
function parseRoute(req) {
  const rest = String(req.query?.rest || "");
  const slash = rest.indexOf("/");
  if (slash === -1) return null;
  const provider = rest.slice(0, slash);
  const upstreamPath = rest.slice(slash + 1);
  if (!UPSTREAM_HOST[provider] || !upstreamPath) return null;
  return { provider, upstreamPath };
}

function estimateCost(provider, model, inputTokens, outputTokens) {
  const prices = PRICE_PER_MILLION[provider]?.[model];
  if (!prices) return 0;
  const [inPrice, outPrice] = prices;
  return (inputTokens / 1_000_000) * inPrice + (outputTokens / 1_000_000) * outPrice;
}

// Reads usage out of whatever the upstream sent — an SSE event stream (parse
// every "data:" line, keep the last usage seen) or a single JSON body.
function extractUsage(provider, contentType, rawText) {
  try {
    if (contentType.includes("text/event-stream")) {
      let inputTokens = 0;
      let outputTokens = 0;
      for (const block of rawText.split("\n\n")) {
        const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
        if (!dataLine) continue;
        const payload = dataLine.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let evt;
        try { evt = JSON.parse(payload); } catch { continue; }
        if (provider === "anthropic") {
          if (evt.message?.usage?.input_tokens) inputTokens = evt.message.usage.input_tokens;
          if (evt.usage?.output_tokens) outputTokens = evt.usage.output_tokens;
        } else if (evt.usage) {
          inputTokens = evt.usage.prompt_tokens ?? inputTokens;
          outputTokens = evt.usage.completion_tokens ?? outputTokens;
        }
      }
      return { inputTokens, outputTokens };
    }

    const json = JSON.parse(rawText);
    if (provider === "anthropic") {
      return { inputTokens: json.usage?.input_tokens || 0, outputTokens: json.usage?.output_tokens || 0 };
    }
    return { inputTokens: json.usage?.prompt_tokens || 0, outputTokens: json.usage?.completion_tokens || 0 };
  } catch {
    return { inputTokens: 0, outputTokens: 0 };
  }
}

function buildUpstreamHeaders(provider, req, realKey) {
  const headers = { "content-type": "application/json" };
  if (provider === "anthropic") {
    headers["x-api-key"] = realKey;
    headers["anthropic-version"] = req.headers["anthropic-version"] || "2023-06-01";
    if (req.headers["anthropic-beta"]) headers["anthropic-beta"] = req.headers["anthropic-beta"];
  } else {
    headers["authorization"] = `Bearer ${realKey}`;
  }
  return headers;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const route = parseRoute(req);
  if (!route) {
    res.status(404).json({ error: "Unknown gateway route" });
    return;
  }
  const { provider, upstreamPath } = route;

  const gatewayKey = extractGatewayKey(req);
  if (!gatewayKey) {
    res.status(401).json({ error: "Missing gateway key" });
    return;
  }

  // Fail closed: any problem authenticating or unwrapping the customer's
  // real provider key ends the request here, before we've spent anything.
  let match;
  let realKey;
  try {
    match = await lookupGatewayKey(hashKey(gatewayKey));
    if (!match || match.provider !== provider) {
      res.status(401).json({ error: "Invalid gateway key" });
      return;
    }
    const encrypted = await getProviderKey(match.user_id, provider);
    if (!encrypted) {
      res.status(401).json({ error: "No provider key connected for this gateway key" });
      return;
    }
    realKey = cryptoLib.decrypt(encrypted);
  } catch {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const workflow = req.headers["x-camaze-workflow"] || null;
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const model = body.model || null;
  const start = Date.now();

  let upstreamRes;
  try {
    upstreamRes = await fetch(`${UPSTREAM_HOST[provider]}/${upstreamPath}`, {
      method: "POST",
      headers: buildUpstreamHeaders(provider, req, realKey),
      body: JSON.stringify(body),
    });
  } catch {
    res.status(502).json({ error: "Upstream request failed" });
    return;
  }

  res.status(upstreamRes.status);
  for (const [key, value] of upstreamRes.headers) {
    if (!HOP_BY_HOP.has(key.toLowerCase())) res.setHeader(key, value);
  }

  const contentType = upstreamRes.headers.get("content-type") || "";
  let full = "";
  const reader = upstreamRes.body?.getReader();
  if (reader) {
    const decoder = new TextDecoder();
    // Write each chunk to the client as it arrives, never waiting for the
    // full response — `full` is a side accumulation for usage parsing below,
    // not something the client waits on.
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
      full += decoder.decode(value, { stream: true });
    }
  }
  res.end();

  // Logging happens after the client already has its full response, so a
  // logging failure can never turn into a customer-facing outage.
  const durationMs = Date.now() - start;
  try {
    const { inputTokens, outputTokens } = extractUsage(provider, contentType, full);
    const costUsd = estimateCost(provider, model, inputTokens, outputTokens);
    await logGatewayRequest({
      userId: match.user_id,
      provider,
      model,
      workflow,
      inputTokens,
      outputTokens,
      costUsd,
      durationMs,
    });
  } catch (err) {
    console.error("gateway: failed to log request", err);
  }
};
