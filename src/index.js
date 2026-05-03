const VERSION = "v6-direct-spa-proxy";

// /list is only a redirect helper page. The real SPA is on sharedchat.cn.
const ENTRY_ORIGIN = "https://chat.sharedchat.cn";
const APP_ORIGIN = "https://sharedchat.cn";
const KNOWN_ORIGINS = new Set([ENTRY_ORIGIN, APP_ORIGIN]);

export default {
  async fetch(request) {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/__health") return text("ok " + VERSION);
      if (url.pathname === "/__version") return json({ workerVersion: VERSION, appOrigin: APP_ORIGIN, entryOrigin: ENTRY_ORIGIN });
      if (url.pathname === "/__debug") return debug(request);
      if (url.pathname === "/__asset_debug") return assetDebug(request);
      if (url.pathname === "/__clear") return clearCookies();

      return proxyToApp(request);
    } catch (err) {
      return html(errorPage(err), 500);
    }
  },
};

async function proxyToApp(request) {
  const incomingUrl = new URL(request.url);

  let upstreamPath = incomingUrl.pathname;
  if (upstreamPath === "/list") upstreamPath = "/";

  const upstreamUrl = new URL(upstreamPath + incomingUrl.search, APP_ORIGIN);
  const upstream = await fetchFollowSafe(request, upstreamUrl);

  const responseHeaders = cleanResponseHeaders(upstream.headers);
  const contentType = responseHeaders.get("content-type") || "";
  responseHeaders.set("cache-control", "no-store, max-age=0");

  if (contentType.includes("text/html")) {
    const response = new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });

    return new HTMLRewriter()
      .on("head", {
        element(element) {
          element.prepend(makePreScript(new URL(request.url).origin), { html: true });
        },
      })
      .on("a", new AttrRewriter("href"))
      .on("link", new AttrRewriter("href"))
      .on("script", new AttrRewriter("src"))
      .on("img", new AttrRewriter("src"))
      .on("source", new AttrRewriter("src"))
      .on("video", new AttrRewriter("src"))
      .on("audio", new AttrRewriter("src"))
      .on("iframe", new AttrRewriter("src"))
      .on("form", new AttrRewriter("action"))
      .on("body", {
        element(element) {
          element.append(AUTO_SCRIPT, { html: true });
        },
      })
      .transform(response);
  }

  if (looksLikeJavascript(contentType, upstreamUrl.pathname)) {
    const js = await upstream.text();
    const rewritten = rewriteJavascript(js, new URL(request.url).origin);
    responseHeaders.set("content-type", "application/javascript; charset=utf-8");
    responseHeaders.delete("content-length");
    return new Response(rewritten, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  }

  if (contentType.includes("text/css")) {
    const css = await upstream.text();
    responseHeaders.delete("content-length");
    return new Response(rewriteCssUrls(css), {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

async function fetchFollowSafe(request, firstUrl) {
  let currentUrl = firstUrl;
  let current = await fetch(currentUrl.toString(), makeFetchInit(request, currentUrl.origin));

  for (let i = 0; i < 5 && isRedirect(current.status); i++) {
    const location = current.headers.get("location");
    if (!location) break;

    const nextUrl = new URL(location, currentUrl);
    if (!isKnownOrigin(nextUrl.origin)) {
      return html(`<!doctype html><meta charset="utf-8"><title>Blocked redirect</title><body style="font-family:system-ui;padding:24px"><h2>已阻擋外部跳轉</h2><p>上游嘗試跳到：<code>${escapeHtml(nextUrl.toString())}</code></p><p><a href="/__debug">查看 debug</a></p></body>`, 502);
    }

    currentUrl = normalizeAppUrl(nextUrl);
    current = await fetch(currentUrl.toString(), makeFetchInit(request, currentUrl.origin));
  }

  return current;
}

function normalizeAppUrl(url) {
  const out = new URL(url.toString());
  if (out.origin === ENTRY_ORIGIN && (out.pathname === "/" || out.pathname === "/list")) {
    return new URL("/", APP_ORIGIN);
  }
  if (out.origin === ENTRY_ORIGIN) {
    return new URL(out.pathname + out.search + out.hash, APP_ORIGIN);
  }
  return out;
}

function makeFetchInit(request, origin) {
  const headers = makeUpstreamHeaders(request, origin);
  const init = {
    method: request.method,
    headers,
    redirect: "manual",
  };
  if (!isBodylessMethod(request.method)) init.body = request.body;
  return init;
}

function makeUpstreamHeaders(request, origin) {
  const incoming = request.headers;
  const headers = new Headers();

  for (const name of ["accept", "accept-language", "content-type", "user-agent"]) {
    const value = incoming.get(name);
    if (value) headers.set(name, value);
  }

  const cookie = incoming.get("cookie");
  if (cookie) headers.set("cookie", removeWorkerCookies(cookie));

  headers.set("referer", origin + "/");
  headers.set("origin", origin);
  headers.set("accept-encoding", "identity");
  return headers;
}

function removeWorkerCookies(cookie) {
  return cookie
    .split(";")
    .map((x) => x.trim())
    .filter((x) => x && !x.startsWith("__sharedchat_worker_"))
    .join("; ");
}

class AttrRewriter {
  constructor(attr) {
    this.attr = attr;
  }

  element(element) {
    const value = element.getAttribute(this.attr);
    if (!value) return;
    const rewritten = rewriteUrlToWorkerPath(value, APP_ORIGIN);
    if (rewritten !== value) element.setAttribute(this.attr, rewritten);
  }
}

function rewriteUrlToWorkerPath(raw, base) {
  try {
    if (shouldIgnoreUrl(raw)) return raw;
    const url = new URL(raw, base);
    if (!isKnownOrigin(url.origin)) return raw;

    const normalized = normalizeAppUrl(url);
    return normalized.pathname + normalized.search + normalized.hash;
  } catch {
    return raw;
  }
}

function rewriteCssUrls(css) {
  return css.replace(/url\((['"]?)([^'"()]+)\1\)/g, (match, quote, value) => {
    const rewritten = rewriteUrlToWorkerPath(value.trim(), APP_ORIGIN);
    return `url(${quote}${rewritten}${quote})`;
  });
}

function rewriteJavascript(source, workerOrigin) {
  let js = source;

  // Make absolute calls stay on the Worker URL so they are proxied back to sharedchat.cn.
  const escapedWorkerOrigin = workerOrigin.replace(/\$/g, "$$$$");
  js = js.replace(/https:\/\/chat\.sharedchat\.cn/g, escapedWorkerOrigin);
  js = js.replace(/https:\/\/sharedchat\.cn/g, escapedWorkerOrigin);
  js = js.replace(/http:\/\/chat\.sharedchat\.cn/g, escapedWorkerOrigin);
  js = js.replace(/http:\/\/sharedchat\.cn/g, escapedWorkerOrigin);

  // Some bundled code derives the main domain from window.location.hostname.
  // On workers.dev that would become workers.dev and can send the page to workers.cloudflare.com.
  js = js.replace(/window\.location\.hostname/g, '"sharedchat.cn"');
  js = js.replace(/document\.location\.hostname/g, '"sharedchat.cn"');
  js = js.replace(/(?<![A-Za-z0-9_$\.])location\.hostname/g, '"sharedchat.cn"');
  js = js.replace(/window\.location\.host/g, '"sharedchat.cn"');
  js = js.replace(/document\.location\.host/g, '"sharedchat.cn"');
  js = js.replace(/(?<![A-Za-z0-9_$\.])location\.host/g, '"sharedchat.cn"');

  // Keep origin-based API calls on the Worker origin, not on sharedchat.cn.
  const quotedWorkerOrigin = JSON.stringify(workerOrigin);
  js = js.replace(/window\.location\.origin/g, quotedWorkerOrigin);
  js = js.replace(/document\.location\.origin/g, quotedWorkerOrigin);
  js = js.replace(/(?<![A-Za-z0-9_$\.])location\.origin/g, quotedWorkerOrigin);

  return js;
}

function makePreScript(workerOrigin) {
  const origin = JSON.stringify(workerOrigin);
  return `<script>
(() => {
  const WORKER_ORIGIN = ${origin};
  const UPSTREAM_RE = /^https?:\\/\\/(?:chat\\.)?sharedchat\\.cn(?::\\d+)?/i;
  function toWorkerUrl(value) {
    try {
      if (!value) return value;
      const url = new URL(value, location.href);
      if (UPSTREAM_RE.test(url.origin)) return WORKER_ORIGIN + url.pathname + url.search + url.hash;
      return value;
    } catch { return value; }
  }
  const oldOpen = window.open;
  window.open = function(url, target, features) {
    return oldOpen.call(window, toWorkerUrl(url), target, features);
  };
  for (const name of ["assign", "replace"]) {
    try {
      const old = Location.prototype[name];
      Location.prototype[name] = function(url) { return old.call(this, toWorkerUrl(url)); };
    } catch {}
  }
  document.addEventListener("click", (event) => {
    const a = event.target && event.target.closest ? event.target.closest("a[href]") : null;
    if (!a) return;
    const next = toWorkerUrl(a.href);
    if (next && next !== a.href) a.href = next;
  }, true);
})();
</script>`;
}

function cleanResponseHeaders(source) {
  const headers = new Headers(source);
  headers.delete("content-security-policy");
  headers.delete("content-security-policy-report-only");
  headers.delete("x-frame-options");
  headers.delete("cross-origin-opener-policy");
  headers.delete("cross-origin-embedder-policy");
  headers.delete("cross-origin-resource-policy");
  headers.delete("content-length");

  const cookies = getSetCookies(source);
  headers.delete("set-cookie");
  for (const cookie of cookies) {
    headers.append("set-cookie", rewriteSetCookie(cookie));
  }
  return headers;
}

function getSetCookies(headers) {
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
  const raw = headers.get("set-cookie");
  if (!raw) return [];
  return raw.split(/,(?=\s*[^;,]+=)/g);
}

function rewriteSetCookie(cookie) {
  return cookie
    .replace(/;\s*Domain=[^;]*/gi, "")
    .replace(/;\s*SameSite=None/gi, "; SameSite=Lax");
}

async function debug(request) {
  const targets = [ENTRY_ORIGIN + "/", ENTRY_ORIGIN + "/list", APP_ORIGIN + "/"];
  const results = [];
  for (const target of targets) {
    try {
      const targetUrl = new URL(target);
      const res = await fetch(target, {
        method: "GET",
        redirect: "manual",
        headers: makeUpstreamHeaders(request, targetUrl.origin),
      });
      const body = await res.clone().text().catch(() => "");
      results.push({
        target,
        ok: res.ok,
        status: res.status,
        statusText: res.statusText,
        location: res.headers.get("location"),
        contentType: res.headers.get("content-type"),
        server: res.headers.get("server"),
        cfRay: res.headers.get("cf-ray"),
        bodyPreview: body.slice(0, 1400),
      });
    } catch (err) {
      results.push({ target, error: String(err && err.message ? err.message : err) });
    }
  }
  return json({ workerVersion: VERSION, results });
}

async function assetDebug(request) {
  const root = await fetch(APP_ORIGIN + "/", {
    method: "GET",
    redirect: "manual",
    headers: makeUpstreamHeaders(request, APP_ORIGIN),
  });
  const rootText = await root.text();
  const assetUrls = Array.from(rootText.matchAll(/(?:src|href)=["']([^"']+)["']/g))
    .map((m) => new URL(m[1], APP_ORIGIN).toString())
    .filter((u) => isKnownOrigin(new URL(u).origin));

  const results = [];
  for (const asset of assetUrls.slice(0, 20)) {
    const u = new URL(asset);
    const res = await fetch(asset, {
      method: "GET",
      redirect: "manual",
      headers: makeUpstreamHeaders(request, u.origin),
    });
    const preview = looksLikeJavascript(res.headers.get("content-type") || "", u.pathname)
      ? (await res.clone().text().catch(() => "")).slice(0, 500)
      : "";
    results.push({
      asset,
      ok: res.ok,
      status: res.status,
      contentType: res.headers.get("content-type"),
      length: res.headers.get("content-length"),
      preview,
    });
  }

  return json({ workerVersion: VERSION, rootStatus: root.status, assets: results });
}

function isKnownOrigin(origin) {
  return KNOWN_ORIGINS.has(origin);
}

function looksLikeJavascript(contentType, pathname) {
  const ct = String(contentType || "").toLowerCase();
  return ct.includes("javascript") || ct.includes("ecmascript") || pathname.endsWith(".js") || pathname.endsWith(".mjs");
}

function shouldIgnoreUrl(value) {
  const v = String(value || "").trim().toLowerCase();
  return !v || v.startsWith("#") || v.startsWith("data:") || v.startsWith("blob:") || v.startsWith("mailto:") || v.startsWith("tel:") || v.startsWith("javascript:");
}

function isRedirect(status) {
  return [301, 302, 303, 307, 308].includes(status);
}

function isBodylessMethod(method) {
  return method === "GET" || method === "HEAD";
}

function clearCookies() {
  const headers = new Headers({
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });

  for (const name of ["prefix", "gfsessionid", "sessionid", "__sharedchat_random_password", "__sharedchat_worker_dummy"]) {
    headers.append("set-cookie", `${name}=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; SameSite=Lax; Secure`);
  }

  return new Response(`<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:24px"><h2>已清除 cookie</h2><p><a href="/?v=6">回首頁</a></p></body>`, { headers });
}

function text(value, status = 200) {
  return new Response(value, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

function html(value, status = 200) {
  return new Response(value, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

function errorPage(err) {
  return `<!doctype html><meta charset="utf-8"><title>Worker Error</title><body style="font-family:system-ui;padding:24px"><h2>Worker 錯誤</h2><pre>${escapeHtml(err && err.stack ? err.stack : String(err))}</pre><p><a href="/__debug">debug</a> · <a href="/__asset_debug">asset debug</a> · <a href="/__clear">clear</a></p></body>`;
}

const AUTO_SCRIPT = `
<script>
(() => {
  if (window.__sharedChatAutoSetupRunning) return;
  window.__sharedChatAutoSetupRunning = true;

  const TEAM_TEXT = "TEAM空闲|推荐";
  const PASSWORD_HINT_TEXT = "设置密码以区分隔离会话";
  const OK_TEXT = "OK";

  const password =
    sessionStorage.getItem("__sharedchat_random_password") ||
    String(Math.floor(100000000 + Math.random() * 900000000));
  sessionStorage.setItem("__sharedchat_random_password", password);

  let clickedTeam = false;
  let filledPassword = false;
  let clickedOk = false;
  const startedAt = Date.now();

  function normalize(text) { return String(text || "").replace(/\s+/g, "").trim(); }
  function isVisible(el) {
    if (!el) return false;
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  }
  function textOf(el) { return normalize(el.innerText || el.textContent || ""); }
  function pageContainsText(text) { return normalize(document.body ? document.body.innerText : "").includes(normalize(text)); }
  function findByText(text) {
    const needle = normalize(text);
    const elements = Array.from(document.querySelectorAll("button,[role='button'],a,div,span,li,p"))
      .filter(isVisible)
      .filter((el) => textOf(el).includes(needle));
    const exact = elements.find((el) => textOf(el) === needle);
    if (exact) return exact;
    return elements.sort((a, b) => textOf(a).length - textOf(b).length)[0] || null;
  }
  function findPasswordInput() {
    const inputs = Array.from(document.querySelectorAll("input[type='password'],input[placeholder*='密码'],input[placeholder*='密碼'],input,textarea")).filter(isVisible);
    return inputs.find((el) => {
      const type = (el.getAttribute("type") || "").toLowerCase();
      const placeholder = el.getAttribute("placeholder") || "";
      return type === "password" || placeholder.includes("密码") || placeholder.includes("密碼");
    }) || inputs[0] || null;
  }
  function clickElement(el) {
    el.scrollIntoView({ block: "center", inline: "center" });
    try { el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse" })); } catch {}
    el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    try { el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerType: "mouse" })); } catch {}
    el.click();
  }
  function setInputValue(input, value) {
    input.focus();
    const proto = input.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const nativeSetter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (nativeSetter) nativeSetter.call(input, value); else input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
  }
  function showStatus(message) {
    let box = document.getElementById("__sharedchat_auto_status");
    if (!box) {
      box = document.createElement("div");
      box.id = "__sharedchat_auto_status";
      box.style.cssText = "position:fixed;right:12px;bottom:12px;z-index:2147483647;background:rgba(0,0,0,.84);color:#fff;font:13px/1.45 system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;padding:10px 12px;border-radius:10px;box-shadow:0 6px 20px rgba(0,0,0,.25);max-width:380px;white-space:pre-wrap";
      document.documentElement.appendChild(box);
    }
    box.textContent = message;
  }
  function step() {
    try {
      if (Date.now() - startedAt > 60000) {
        showStatus("自動流程逾時；隨機密碼：" + password + "\n可開 /__debug 或 /__asset_debug 檢查。");
        return false;
      }
      if (!clickedTeam && pageContainsText(PASSWORD_HINT_TEXT)) clickedTeam = true;
      if (!clickedTeam) {
        const teamButton = findByText(TEAM_TEXT);
        if (teamButton) {
          clickElement(teamButton);
          clickedTeam = true;
          showStatus("已點擊 TEAM空闲|推荐\n隨機密碼：" + password);
        } else {
          showStatus("等待 TEAM空闲|推荐\n隨機密碼：" + password);
        }
        return true;
      }
      if (!filledPassword) {
        if (!pageContainsText(PASSWORD_HINT_TEXT)) {
          showStatus("等待密碼提示\n隨機密碼：" + password);
          return true;
        }
        const input = findPasswordInput();
        if (input) {
          setInputValue(input, password);
          filledPassword = true;
          showStatus("已填入 9 位數密碼：" + password);
        }
        return true;
      }
      if (!clickedOk) {
        const okButton = findByText(OK_TEXT);
        if (okButton) {
          clickElement(okButton);
          clickedOk = true;
          showStatus("完成：已點擊 OK\n密碼：" + password);
          return false;
        }
        showStatus("等待 OK\n隨機密碼：" + password);
      }
      return true;
    } catch (err) {
      showStatus("自動流程錯誤：" + err.message + "\n密碼：" + password);
      return false;
    }
  }
  const timer = setInterval(() => { if (!step()) clearInterval(timer); }, 500);
  const observer = new MutationObserver(() => step());
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
  step();
})();
</script>`;
