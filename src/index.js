const VERSION = "v5-self-rendered-list";
const LIST_URL = "https://sharedchat.cn/";
const CHAT_LIST_URL = "https://chat.sharedchat.cn/list";

const CONTROL_PATHS = new Set([
  "/",
  "/__health",
  "/__version",
  "/__debug",
  "/__clear",
  "/__list_html",
  "/__proxy",
]);

export default {
  async fetch(request) {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/__health") {
        return text("ok " + VERSION, 200);
      }

      if (url.pathname === "/__version") {
        return json({ version: VERSION });
      }

      if (url.pathname === "/__clear") {
        return clearPage();
      }

      if (url.pathname === "/__debug") {
        return debugResponse();
      }

      if (url.pathname === "/__list_html") {
        return upstreamText(LIST_URL);
      }

      if (url.pathname === "/__proxy") {
        return proxyFromQuery(request);
      }

      if (url.pathname === "/") {
        return html(indexHtml(), 200, {
          "cache-control": "no-store",
        });
      }

      // Fallback for scripts and API calls made with absolute paths, for example /api/...
      // The latest proxied origin is stored in a cookie when an HTML page is proxied.
      const cookieOrigin = readCookie(request.headers.get("cookie") || "", "__proxy_origin");
      if (cookieOrigin) {
        const targetUrl = new URL(url.pathname + url.search, cookieOrigin);
        return proxy(request, targetUrl);
      }

      return html(indexHtml("找不到代理目標，請先從首頁進入。"), 404);
    } catch (err) {
      return html(errorHtml(err), 500);
    }
  },
};

function text(body, status = 200, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      ...extraHeaders,
    },
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function html(body, status = 200, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

async function upstreamText(target) {
  const targetUrl = new URL(target);
  const res = await fetch(targetUrl.toString(), {
    method: "GET",
    redirect: "follow",
    headers: upstreamHeaders(targetUrl),
  });

  const body = await res.text();
  return new Response(body, {
    status: res.status,
    statusText: res.statusText,
    headers: {
      "content-type": res.headers.get("content-type") || "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-upstream-status": String(res.status),
      "x-upstream-url": targetUrl.toString(),
    },
  });
}

async function debugResponse() {
  const targets = [CHAT_LIST_URL, LIST_URL];
  const results = [];

  for (const target of targets) {
    const targetUrl = new URL(target);
    const res = await fetch(targetUrl.toString(), {
      method: "GET",
      redirect: "manual",
      headers: upstreamHeaders(targetUrl),
    });
    const body = await res.text().catch(() => "");

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
  }

  return json({ workerVersion: VERSION, results });
}

function proxyFromQuery(request) {
  const url = new URL(request.url);
  const raw = url.searchParams.get("url");
  if (!raw) return html(indexHtml("缺少 url 參數。"), 400);

  const targetUrl = normalizeTargetUrl(raw, LIST_URL);
  return proxy(request, targetUrl);
}

async function proxy(request, targetUrl) {
  ensureAllowedTarget(targetUrl);

  const init = {
    method: request.method,
    redirect: "manual",
    headers: upstreamHeaders(targetUrl, request),
  };

  if (!isBodylessMethod(request.method)) {
    init.body = request.body;
  }

  const upstream = await fetch(targetUrl.toString(), init);

  if (isRedirect(upstream.status)) {
    const location = upstream.headers.get("location");
    if (location) {
      const nextUrl = normalizeTargetUrl(location, targetUrl.toString());
      ensureAllowedTarget(nextUrl);
      return Response.redirect(makeProxyUrl(nextUrl.toString()), 302);
    }
  }

  const headers = cleanHeaders(upstream.headers);
  const contentType = headers.get("content-type") || "";

  headers.append("set-cookie", makeCookie("__proxy_origin", targetUrl.origin, { path: "/" }));
  headers.append("set-cookie", makeCookie("__proxy_url", targetUrl.toString(), { path: "/" }));

  if (contentType.includes("text/html")) {
    const response = new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });

    return new HTMLRewriter()
      .on("a", new AttrRewriter("href", targetUrl))
      .on("link", new AttrRewriter("href", targetUrl))
      .on("script", new AttrRewriter("src", targetUrl))
      .on("img", new AttrRewriter("src", targetUrl))
      .on("source", new AttrRewriter("src", targetUrl))
      .on("iframe", new AttrRewriter("src", targetUrl))
      .on("form", new AttrRewriter("action", targetUrl))
      .on("body", {
        element(element) {
          element.append(AUTO_SCRIPT, { html: true });
        },
      })
      .transform(response);
  }

  if (contentType.includes("text/css")) {
    const css = await upstream.text();
    return new Response(rewriteCssUrls(css, targetUrl), {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

class AttrRewriter {
  constructor(attr, baseUrl) {
    this.attr = attr;
    this.baseUrl = baseUrl;
  }

  element(element) {
    const value = element.getAttribute(this.attr);
    if (!value) return;
    const rewritten = rewriteUrl(value, this.baseUrl);
    if (rewritten !== value) element.setAttribute(this.attr, rewritten);
  }
}

function rewriteCssUrls(css, baseUrl) {
  return css.replace(/url\((['"]?)([^'"()]+)\1\)/g, (match, quote, value) => {
    const rewritten = rewriteUrl(value.trim(), baseUrl);
    return `url(${quote}${rewritten}${quote})`;
  });
}

function rewriteUrl(value, baseUrl) {
  try {
    if (shouldIgnoreUrl(value)) return value;
    const resolved = normalizeTargetUrl(value, baseUrl.toString());
    ensureAllowedTarget(resolved);
    return makeProxyUrl(resolved.toString());
  } catch {
    return value;
  }
}

function makeProxyUrl(target) {
  return "/__proxy?url=" + encodeURIComponent(target);
}

function normalizeTargetUrl(raw, base) {
  const value = String(raw || "").trim();
  const url = new URL(value, base);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("不支援的 URL protocol: " + url.protocol);
  }
  return url;
}

function shouldIgnoreUrl(value) {
  const v = String(value || "").trim().toLowerCase();
  return (
    !v ||
    v.startsWith("#") ||
    v.startsWith("data:") ||
    v.startsWith("blob:") ||
    v.startsWith("mailto:") ||
    v.startsWith("tel:") ||
    v.startsWith("javascript:")
  );
}

function ensureAllowedTarget(url) {
  const h = url.hostname.toLowerCase();
  const allowed = h === "sharedchat.cn" || h.endsWith(".sharedchat.cn") || h === "chat.sharedchat.cn";
  if (!allowed) {
    throw new Error("已阻擋非 sharedchat.cn 目標: " + h);
  }
}

function upstreamHeaders(targetUrl, request) {
  const headers = new Headers();
  headers.set("accept", request?.headers.get("accept") || "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
  headers.set("accept-language", request?.headers.get("accept-language") || "zh-TW,zh;q=0.9,en;q=0.8");
  headers.set("user-agent", request?.headers.get("user-agent") || "Mozilla/5.0 AppleWebKit/537.36 Chrome Safari");
  headers.set("referer", targetUrl.origin + "/");
  headers.set("origin", targetUrl.origin);

  const cookie = request?.headers.get("cookie") || "";
  if (cookie) {
    const filtered = cookie
      .split(";")
      .map((x) => x.trim())
      .filter((x) => x && !x.startsWith("__proxy_"))
      .join("; ");
    if (filtered) headers.set("cookie", filtered);
  }

  if (request) {
    const ct = request.headers.get("content-type");
    if (ct) headers.set("content-type", ct);
  }

  return headers;
}

function cleanHeaders(source) {
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

function makeCookie(name, value, opts = {}) {
  const pieces = [`${name}=${encodeURIComponent(value)}`];
  if (opts.path) pieces.push(`Path=${opts.path}`);
  pieces.push("SameSite=Lax");
  pieces.push("HttpOnly");
  pieces.push("Secure");
  return pieces.join("; ");
}

function readCookie(cookieHeader, name) {
  const parts = cookieHeader.split(";").map((part) => part.trim());
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq);
    const value = part.slice(eq + 1);
    if (key === name) return decodeURIComponent(value);
  }
  return "";
}

function isRedirect(status) {
  return status >= 300 && status < 400;
}

function isBodylessMethod(method) {
  return method === "GET" || method === "HEAD";
}

function clearPage() {
  const expired = "=; Max-Age=0; Path=/; SameSite=Lax; Secure";
  return html(`<!doctype html><meta charset="utf-8"><title>Clear</title><body style="font-family:system-ui;padding:24px"><h2>已清除 Worker cookie</h2><p><a href="/?v=5">回首頁</a></p></body>`, 200, {
    "set-cookie": [
      "__proxy_origin" + expired,
      "__proxy_url" + expired,
      "__sharedchat_random_password" + expired,
    ].join(", "),
  });
}

function indexHtml(message = "") {
  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>SharedChat Auto</title>
  <style>
    body{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;background:#f7f7f8;color:#111827}
    .wrap{max-width:880px;margin:40px auto;padding:24px}
    .card{background:#fff;border:1px solid #e5e7eb;border-radius:18px;padding:22px;box-shadow:0 8px 30px rgba(0,0,0,.06)}
    h1{font-size:22px;margin:0 0 12px}.muted{color:#6b7280;font-size:14px;line-height:1.6}
    #status{margin:14px 0;padding:12px;border-radius:12px;background:#eef2ff;color:#3730a3;white-space:pre-wrap}
    .item{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 0;border-top:1px solid #e5e7eb}
    .item:first-child{border-top:0}.name{font-weight:650}.url{font-size:12px;color:#6b7280;word-break:break-all;margin-top:4px}
    button,a.btn{border:0;border-radius:12px;background:#111827;color:#fff;padding:10px 14px;cursor:pointer;text-decoration:none;white-space:nowrap}
    .danger{background:#fff7ed;color:#9a3412;padding:12px;border-radius:12px;margin:12px 0}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1>SharedChat Auto v5</h1>
      <p class="muted">這版不直接代理空白頁，會先在 Worker 自己的頁面讀取清單，找到 <b>TEAM空闲|推荐</b> 後再用本地代理打開，避免跳到 workers.cloudflare.com。</p>
      ${message ? `<div class="danger">${escapeHtml(message)}</div>` : ""}
      <div id="status">正在讀取 sharedchat 清單...</div>
      <div id="list"></div>
      <p class="muted"><a href="/__debug" target="_blank">查看 debug</a> · <a href="/__clear">清除 cookie</a></p>
    </div>
  </div>
<script>
(() => {
  const targetText = "TEAM空闲|推荐";
  const statusEl = document.getElementById("status");
  const listEl = document.getElementById("list");

  function norm(s){ return String(s || "").replace(/\\s+/g, "").trim(); }
  function abs(href){ return new URL(href, "${LIST_URL}").toString(); }
  function go(href){ location.href = "/__proxy?url=" + encodeURIComponent(abs(href)); }
  function setStatus(s){ statusEl.textContent = s; }
  function esc(s){ return String(s).replace(/[&<>"']/g, m => ({"&":"&amp;","<":"&lt;",">":"&gt;","\\\"":"&quot;","'":"&#39;"}[m])); }

  fetch("/__list_html?t=" + Date.now(), { cache: "no-store" })
    .then(r => r.text())
    .then(html => {
      const doc = new DOMParser().parseFromString(html, "text/html");
      let anchors = Array.from(doc.querySelectorAll("a[href]"))
        .map(a => ({ text: norm(a.innerText || a.textContent || a.getAttribute("title") || ""), href: a.getAttribute("href") }))
        .filter(x => x.href && !x.href.startsWith("javascript:"));

      const exact = anchors.find(x => x.text.includes(norm(targetText)));
      const loose = anchors.filter(x => /TEAM|空闲|空閒|推荐|推薦/i.test(x.text));
      const shown = exact ? [exact] : (loose.length ? loose : anchors.slice(0, 20));

      if (exact) {
        setStatus("找到：" + exact.text + "\\n1 秒後自動打開...");
        render(shown);
        setTimeout(() => go(exact.href), 1000);
        return;
      }

      if (loose.length) {
        setStatus("沒找到完全相同文字，但找到可能的 TEAM/空闲/推荐項目。請手動點第一個相近項目。");
      } else {
        setStatus("沒找到 TEAM空闲|推荐。下面先顯示前 20 個可用連結，請手動選擇。");
      }
      render(shown);
    })
    .catch(err => {
      setStatus("讀取清單失敗：" + err.message + "\\n請打開 /__debug 檢查上游狀態。");
    });

  function render(items) {
    listEl.innerHTML = items.map((item, i) => {
      const full = abs(item.href);
      return '<div class="item"><div><div class="name">' + esc(item.text || '(無文字連結)') + '</div><div class="url">' + esc(full) + '</div></div><button data-i="' + i + '">打開</button></div>';
    }).join("");
    listEl.querySelectorAll("button[data-i]").forEach(btn => {
      btn.addEventListener("click", () => go(items[Number(btn.dataset.i)].href));
    });
  }
})();
</script>
</body>
</html>`;
}

function errorHtml(err) {
  return `<!doctype html><meta charset="utf-8"><title>Worker Error</title><body style="font-family:system-ui;padding:24px"><h2>Worker 錯誤</h2><pre>${escapeHtml(err && err.stack ? err.stack : String(err))}</pre><p><a href="/__debug">debug</a> · <a href="/__clear">clear</a></p></body>`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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

  function normalize(text) {
    return String(text || "").replace(/\\s+/g, "").trim();
  }

  function isVisible(el) {
    if (!el) return false;
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  }

  function textOf(el) {
    return normalize(el.innerText || el.textContent || "");
  }

  function findByText(text) {
    const needle = normalize(text);
    const candidates = Array.from(document.querySelectorAll("button,[role='button'],a,div,span,li,p"))
      .filter(isVisible)
      .filter(el => textOf(el).includes(needle))
      .sort((a, b) => textOf(a).length - textOf(b).length);
    return candidates[0] || null;
  }

  function pageContainsText(text) {
    return normalize(document.body ? document.body.innerText : "").includes(normalize(text));
  }

  function findPasswordInput() {
    const inputs = Array.from(document.querySelectorAll("input[type='password'],input[placeholder*='密码'],input[placeholder*='密碼'],input,textarea")).filter(isVisible);
    return inputs.find(el => {
      const type = (el.getAttribute("type") || "").toLowerCase();
      const placeholder = el.getAttribute("placeholder") || "";
      return type === "password" || placeholder.includes("密码") || placeholder.includes("密碼");
    }) || inputs[0] || null;
  }

  function clickElement(el) {
    el.scrollIntoView({ block: "center", inline: "center" });
    el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    el.click();
  }

  function setInputValue(input, value) {
    input.focus();
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
    if (nativeSetter) nativeSetter.call(input, value);
    else input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function showStatus(message) {
    let box = document.getElementById("__sharedchat_auto_status");
    if (!box) {
      box = document.createElement("div");
      box.id = "__sharedchat_auto_status";
      box.style.cssText = "position:fixed;right:12px;bottom:12px;z-index:2147483647;background:rgba(0,0,0,.82);color:#fff;font:13px/1.45 system-ui;padding:10px 12px;border-radius:10px;box-shadow:0 6px 20px rgba(0,0,0,.25);max-width:360px";
      document.documentElement.appendChild(box);
    }
    box.textContent = message;
  }

  showStatus("自動流程啟動，隨機密碼：" + password);

  const timer = setInterval(() => {
    try {
      if (Date.now() - startedAt > 45000) {
        showStatus("自動流程逾時；隨機密碼：" + password);
        clearInterval(timer);
        return;
      }

      if (!clickedTeam) {
        const teamButton = findByText(TEAM_TEXT);
        if (teamButton) {
          clickElement(teamButton);
          clickedTeam = true;
          showStatus("已點擊 TEAM空闲|推荐，隨機密碼：" + password);
        } else {
          // Some pages already opened the selected item, so continue to password detection.
          clickedTeam = true;
        }
        return;
      }

      if (!filledPassword) {
        if (!pageContainsText(PASSWORD_HINT_TEXT)) return;
        const input = findPasswordInput();
        if (input) {
          setInputValue(input, password);
          filledPassword = true;
          showStatus("已填入 9 位數密碼：" + password);
        }
        return;
      }

      if (!clickedOk) {
        const okButton = findByText(OK_TEXT);
        if (okButton) {
          clickElement(okButton);
          clickedOk = true;
          showStatus("完成：已點擊 OK。密碼：" + password);
          clearInterval(timer);
        }
      }
    } catch (err) {
      showStatus("自動流程錯誤：" + err.message + "；密碼：" + password);
      clearInterval(timer);
    }
  }, 500);
})();
</script>`;
