import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
 
export const config = {
  api: { bodyParser: false },
  supportsResponseStreaming: true,
  maxDuration: 60,
};
 
const PROXY_ROOT = (process.env.UPSTREAM_HOST || "").replace(/\/$/, "");
 
// Headers that must not be forwarded to the upstream server
const EXCLUDED_HEADERS = new Set([
  "host", "connection", "keep-alive",
  "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
  "forwarded", "x-forwarded-host", "x-forwarded-proto", "x-forwarded-port",
]);
 
function isExcluded(key) {
  return EXCLUDED_HEADERS.has(key) || key.startsWith("x-vercel-");
}
 
function resolveClientIp(key, value, current) {
  if (key === "x-real-ip") return value;
  if (key === "x-forwarded-for" && !current) return value;
  return current;
}
 
function filterRequestHeaders(source) {
  const result = {};
  let callerIp = null;
 
  for (const originalKey of Object.keys(source)) {
    const normalizedKey = originalKey.toLowerCase();
    const headerValue = source[originalKey];
 
    if (isExcluded(normalizedKey)) continue;
 
    const updatedIp = resolveClientIp(normalizedKey, headerValue, callerIp);
    if (updatedIp !== callerIp) {
      callerIp = updatedIp;
      continue;
    }
 
    if (normalizedKey === "x-forwarded-for") continue;
 
    result[normalizedKey] = Array.isArray(headerValue) ? headerValue.join(", ") : headerValue;
  }
 
  if (callerIp) result["x-forwarded-for"] = callerIp;
 
  return result;
}
 
function buildFetchOptions(method, headers, req) {
  const opts = { method, headers, redirect: "manual" };
  const allowsBody = method !== "GET" && method !== "HEAD";
  if (allowsBody) {
    opts.body = Readable.toWeb(req);
    opts.duplex = "half";
  }
  return opts;
}
 
async function pipeResponse(upstreamRes, res) {
  res.statusCode = upstreamRes.status;
 
  for (const [headerName, headerVal] of upstreamRes.headers) {
    if (headerName.toLowerCase() === "transfer-encoding") continue;
    try { res.setHeader(headerName, headerVal); } catch {}
  }
 
  if (upstreamRes.body) {
    await pipeline(Readable.fromWeb(upstreamRes.body), res);
  } else {
    res.end();
  }
}
 
export default async function handler(req, res) {
  if (!PROXY_ROOT) {
    res.statusCode = 500;
    return res.end("Misconfigured: UPSTREAM_HOST is not set");
  }
 
  try {
    const forwardUrl = PROXY_ROOT + req.url;
    const outgoingHeaders = filterRequestHeaders(req.headers);
    const fetchOpts = buildFetchOptions(req.method, outgoingHeaders, req);
    const upstreamRes = await fetch(forwardUrl, fetchOpts);
    await pipeResponse(upstreamRes, res);
  } catch (err) {
    console.error("relay error:", err);
    if (!res.headersSent) {
      res.statusCode = 502;
      res.end("Bad Gateway: Tunnel Failed");
    }
  }
}
