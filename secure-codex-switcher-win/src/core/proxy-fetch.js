import { fetch as undiciFetch, ProxyAgent } from "undici";

export function createProxyAwareFetch(baseFetch = fetch, proxyUrl = resolveProxyUrl()) {
  if (!proxyUrl) {
    return baseFetch;
  }
  const dispatcher = new ProxyAgent(normalizeProxyUrl(proxyUrl));
  return (url, init = {}) => undiciFetch(url, { ...init, dispatcher });
}

export function resolveProxyUrl(env = process.env) {
  return env.HTTPS_PROXY || env.HTTP_PROXY || env.ALL_PROXY || env.https_proxy || env.http_proxy || env.all_proxy || "";
}

function normalizeProxyUrl(value) {
  if (/^https?:\/\//i.test(value)) {
    return value;
  }
  return `http://${value}`;
}
