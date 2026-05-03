const WORKER_VERSION = "v7-auto-select";
const DEFAULT_ORIGIN = "https://sharedchat.cn";
const FALLBACK_LIST_URL = "https://chat.sharedchat.cn/list";

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/__health") {
      return text(`ok ${WORKER_VERSION}`);
    }

    if (url.pathname === "/__version") {
      return json({ workerVersion: WORKER_VERSION });
    }

    if (url.pathname === "/__clear") {
      return clearCookies();
    }

    if (url.pathname === "/__debug") {
      return debugUpstream(request);
    }

    if (url.pathname === "/__asset_debug") {
      return assetDebug(request);
    }

    if (url.pathname === "/__proxy") {
      const encoded = url.searchParams.get("u");
      if (!encoded) return text("missing u", 400);

      let target;
      try {
        target = decodeProxyUrl(encoded);
      } catch (err) {
        return text(`bad proxy url: ${err.message}`, 400);
      }

      if (!isAllowedTarget(target)) {
        return text("blocked target", 403);
      }

      return proxy(request, target);
    }

    const target = new URL(url.pathname + url.search + url.hash, DEFAULT_ORIGIN);
    return proxy(request, target);
  },
};

async function proxy(request, targetUrl) {
  const target = typeof targetUrl === "string" ? new URL(targetUrl) : targetUrl;
  if (!isAllowedTarget(target)) return text("blocked target", 403);

  const upstreamRequest = buildUpstreamRequest(request, target);
  const upstream = await fetch(upstreamRequest);
  const headers = sanitizeResponseHeaders(upstream.headers);

  const location = upstream.headers.get("location");
  if (location && upstream.status >= 300 && upstream.status < 400) {
    const next = new URL(location, target.href);
    if (isAllowedTarget(next)) {
      headers.set("location", localizeUrl(next.href, target.href));
      return new Response(null, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers,
      });
    }

    return html(shellPage(`Blocked external redirect to ${escapeHtml(next.href)}`), 200, headers);
  }

  const contentType = upstream.headers.get("content-type") || "";

  if (contentType.includes("text/html")) {
    headers.delete("content-length");
    const response = new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });

    return new HTMLRewriter()
      .on("a", new AttrRewriter("href", target.href))
      .on("link", new AttrRewriter("href", target.href))
      .on("script", new AttrRewriter("src", target.href))
      .on("img", new AttrRewriter("src", target.href))
      .on("source", new AttrRewriter("src", target.href))
      .on("video", new AttrRewriter("src", target.href))
      .on("audio", new AttrRewriter("src", target.href))
      .on("form", new AttrRewriter("action", target.href))
      .on("body", {
        element(element) {
          element.append(AUTO_SCRIPT, { html: true });
        },
      })
      .transform(response);
  }

  if (isJavaScript(contentType)) {
    const body = await upstream.text();
    headers.delete("content-length");
    return new Response(rewriteJavaScript(body), {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  }

  if (contentType.includes("text/css")) {
    const body = await upstream.text();
    headers.delete("content-length");
    return new Response(rewriteCss(body, target.href), {
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

function buildUpstreamRequest(request, target) {
  const inputHeaders = request.headers;
  const headers = new Headers();

  copyHeader(inputHeaders, headers, "accept");
  copyHeader(inputHeaders, headers, "accept-language");
  copyHeader(inputHeaders, headers, "content-type");
  copyHeader(inputHeaders, headers, "cookie");
  copyHeader(inputHeaders, headers, "range");

  headers.set(
    "user-agent",
    inputHeaders.get("user-agent") ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"
  );
  headers.set("origin", target.origin);
  headers.set("referer", target.origin + "/");

  const init = {
    method: request.method,
    headers,
    redirect: "manual",
  };

  if (!["GET", "HEAD"].includes(request.method)) {
    init.body = request.body;
  }

  return new Request(target.href, init);
}

function copyHeader(from, to, name) {
  const value = from.get(name);
  if (value) to.set(name, value);
}

function sanitizeResponseHeaders(source) {
  const headers = new Headers(source);
  headers.delete("content-security-policy");
  headers.delete("content-security-policy-report-only");
  headers.delete("x-frame-options");
  headers.delete("cross-origin-opener-policy");
  headers.delete("cross-origin-embedder-policy");
  headers.delete("cross-origin-resource-policy");
  headers.delete("content-encoding");
  rewriteSetCookieHeaders(source, headers);
  return headers;
}

class AttrRewriter {
  constructor(attr, baseUrl) {
    this.attr = attr;
    this.baseUrl = baseUrl;
  }

  element(element) {
    const value = element.getAttribute(this.attr);
    if (!value) return;
    element.setAttribute(this.attr, localizeUrl(value, this.baseUrl));
  }
}

function localizeUrl(value, baseUrl) {
  try {
    if (isSpecialUrl(value)) return value;
    const url = new URL(value, baseUrl);
    if (!isAllowedTarget(url)) return value;

    if (url.hostname === "sharedchat.cn") {
      return url.pathname + url.search + url.hash;
    }

    return `/__proxy?u=${encodeURIComponent(encodeProxyUrl(url.href))}`;
  } catch (_) {
    return value;
  }
}

function isSpecialUrl(value) {
  return /^(data:|blob:|mailto:|tel:|javascript:|about:)/i.test(String(value || ""));
}

function isAllowedTarget(urlOrString) {
  try {
    const url = typeof urlOrString === "string" ? new URL(urlOrString) : urlOrString;
    const host = url.hostname.toLowerCase();
    return url.protocol === "https:" && (host === "sharedchat.cn" || host.endsWith(".sharedchat.cn"));
  } catch (_) {
    return false;
  }
}

function encodeProxyUrl(value) {
  const raw = btoa(value);
  return raw.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeProxyUrl(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return new URL(atob(padded));
}

function isJavaScript(contentType) {
  return (
    contentType.includes("javascript") ||
    contentType.includes("ecmascript") ||
    contentType.includes("text/js") ||
    contentType.includes("application/x-javascript")
  );
}

function rewriteJavaScript(body) {
  return body
    .replace(/window\.location\.hostname/g, '"sharedchat.cn"')
    .replace(/location\.hostname/g, '"sharedchat.cn"')
    .replace(/window\.location\.host/g, '"sharedchat.cn"')
    .replace(/location\.host/g, '"sharedchat.cn"');
}

function rewriteCss(body, baseUrl) {
  return body.replace(/url\((['"]?)([^)'"#?]+[^)'"]*)(['"]?)\)/g, (match, q1, raw, q2) => {
    if (isSpecialUrl(raw)) return match;
    const rewritten = localizeUrl(raw, baseUrl);
    return `url(${q1}${rewritten}${q2})`;
  });
}

function rewriteSetCookieHeaders(sourceHeaders, targetHeaders) {
  const cookies =
    typeof sourceHeaders.getSetCookie === "function"
      ? sourceHeaders.getSetCookie()
      : splitCookiesString(sourceHeaders.get("set-cookie") || "");

  targetHeaders.delete("set-cookie");

  for (const cookie of cookies) {
    if (!cookie) continue;
    const rewritten = cookie
      .replace(/;\s*Domain=[^;]*/gi, "")
      .replace(/;\s*SameSite=None/gi, "; SameSite=Lax");
    targetHeaders.append("set-cookie", rewritten);
  }
}

function splitCookiesString(header) {
  if (!header) return [];
  return header.split(/,(?=\s*[^;,]+=)/g);
}

async function debugUpstream() {
  const targets = [
    DEFAULT_ORIGIN + "/",
    FALLBACK_LIST_URL,
  ];
  const results = [];

  for (const target of targets) {
    const res = await fetch(target, { redirect: "manual" });
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
      bodyPreview: body.slice(0, 1200),
    });
  }

  return json({ workerVersion: WORKER_VERSION, results });
}

async function assetDebug() {
  const home = await fetch(DEFAULT_ORIGIN + "/", { redirect: "manual" });
  const htmlText = await home.text();
  const assets = [];
  const re = /(?:src|href)=["']([^"']+)["']/g;
  let match;
  while ((match = re.exec(htmlText)) && assets.length < 20) {
    const assetUrl = new URL(match[1], DEFAULT_ORIGIN + "/");
    if (!isAllowedTarget(assetUrl)) continue;
    const res = await fetch(assetUrl.href, { redirect: "manual" });
    assets.push({
      asset: assetUrl.href,
      ok: res.ok,
      status: res.status,
      contentType: res.headers.get("content-type"),
      sizeHint: res.headers.get("content-length"),
    });
  }

  return json({ workerVersion: WORKER_VERSION, homeStatus: home.status, assets });
}

function clearCookies() {
  const headers = new Headers({ "content-type": "text/html; charset=utf-8" });
  for (const name of ["prefix", "gfsessionid", "session", "token", "auth", "password"]) {
    headers.append("set-cookie", `${name}=; Max-Age=0; path=/; SameSite=Lax; Secure`);
  }
  return new Response(shellPage("Cookies cleared. <a href='/?v=7'>Open v7</a>"), { headers });
}

function shellPage(message) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${WORKER_VERSION}</title><body style="font-family:system-ui,sans-serif;padding:24px"><h1>${WORKER_VERSION}</h1><p>${message}</p></body>`;
}

function text(value, status = 200) {
  return new Response(value, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

function html(value, status = 200, extraHeaders = new Headers()) {
  const headers = new Headers(extraHeaders);
  headers.set("content-type", "text/html; charset=utf-8");
  return new Response(value, { status, headers });
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const AUTO_SCRIPT = `
<script>
(() => {
  if (window.__sharedChatAutoSelectV7) return;
  window.__sharedChatAutoSelectV7 = true;

  const TEAM_TEXT = "TEAM\\u7a7a\\u95f2|\\u63a8\\u8350";
  const TEAM_TEXT_ALT = "TEAM\\u7a7a\\u95f2\\uff5c\\u63a8\\u8350";
  const PASSWORD_HINT_TEXT = "\\u8bbe\\u7f6e\\u5bc6\\u7801\\u4ee5\\u533a\\u5206\\u9694\\u79bb\\u4f1a\\u8bdd";
  const OK_TEXT = "OK";
  const WORKER_VERSION = "${WORKER_VERSION}";

  const password =
    sessionStorage.getItem("__sharedchat_random_password_v7") ||
    String(Math.floor(100000000 + Math.random() * 900000000));
  sessionStorage.setItem("__sharedchat_random_password_v7", password);

  let teamClickCount = 0;
  let lastTeamClickAt = 0;
  let passwordFilled = false;
  let okClicked = false;
  let startedAt = Date.now();

  patchNetwork();
  installNavigationGuard();
  showStatus("v7 auto-select ready. Password: " + password);

  const observer = new MutationObserver(() => {
    rewriteLinks();
    step();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["href", "src", "action"] });

  const timer = setInterval(step, 450);

  function step() {
    rewriteLinks();

    if (Date.now() - startedAt > 60000) {
      showStatus("Timed out. Password: " + password + ". Open console for details.");
      console.warn("[sharedchat-auto] timeout", collectVisibleTexts());
      clearInterval(timer);
      observer.disconnect();
      return;
    }

    const hasPasswordPrompt = pageContains(PASSWORD_HINT_TEXT);
    if (hasPasswordPrompt && !passwordFilled) {
      const input = findPasswordInput();
      if (input) {
        setInputValue(input, password);
        passwordFilled = true;
        showStatus("Password filled: " + password);
      }
      return;
    }

    if (passwordFilled && !okClicked) {
      const ok = findByText(OK_TEXT, { exact: true }) || findByText(OK_TEXT);
      if (ok) {
        clickElement(ok);
        okClicked = true;
        showStatus("Finished. Clicked OK. Password: " + password);
        clearInterval(timer);
        observer.disconnect();
      }
      return;
    }

    if (!passwordFilled && !hasPasswordPrompt) {
      const now = Date.now();
      if (now - lastTeamClickAt < 2500) return;

      const team = findByText(TEAM_TEXT, { preferClickable: true }) ||
        findByText(TEAM_TEXT_ALT, { preferClickable: true }) ||
        findLooseTeamCandidate();

      if (team) {
        lastTeamClickAt = now;
        teamClickCount += 1;
        showStatus("Auto-clicking TEAM option, attempt " + teamClickCount + ". Password: " + password);
        console.log("[sharedchat-auto] clicking team candidate", team, textOf(team));
        clickElement(team);
      } else if (Date.now() - startedAt > 6000) {
        showStatus("Waiting for TEAM option. Password: " + password);
      }
    }
  }

  function patchNetwork() {
    const nativeFetch = window.fetch;
    window.fetch = function(input, init) {
      try {
        if (typeof input === "string" || input instanceof URL) {
          input = toLocalUrl(String(input));
        } else if (input instanceof Request) {
          const rewritten = toLocalUrl(input.url);
          if (rewritten !== input.url) input = new Request(rewritten, input);
        }
      } catch (err) {
        console.warn("[sharedchat-auto] fetch rewrite failed", err);
      }
      return nativeFetch.call(this, input, init);
    };

    const nativeOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url) {
      try {
        arguments[1] = toLocalUrl(String(url));
      } catch (_) {}
      return nativeOpen.apply(this, arguments);
    };

    if (navigator.sendBeacon) {
      const nativeBeacon = navigator.sendBeacon.bind(navigator);
      navigator.sendBeacon = function(url, data) {
        return nativeBeacon(toLocalUrl(String(url)), data);
      };
    }

    const nativeOpenWindow = window.open;
    window.open = function(url, target, features) {
      if (url) url = toLocalUrl(String(url));
      return nativeOpenWindow.call(window, url, target, features);
    };
  }

  function installNavigationGuard() {
    document.addEventListener("click", (event) => {
      const target = event.target && event.target.closest ? event.target.closest("a[href]") : null;
      if (!target) return;
      const href = target.getAttribute("href");
      const rewritten = toLocalUrl(href);
      if (rewritten !== href && rewritten !== target.href) {
        event.preventDefault();
        event.stopPropagation();
        location.href = rewritten;
      }
    }, true);

    document.addEventListener("submit", (event) => {
      const form = event.target;
      if (!form || !form.getAttribute) return;
      const action = form.getAttribute("action") || location.href;
      form.setAttribute("action", toLocalUrl(action));
    }, true);
  }

  function rewriteLinks() {
    for (const el of document.querySelectorAll("a[href], link[href], script[src], img[src], source[src], form[action]")) {
      const attr = el.hasAttribute("href") ? "href" : el.hasAttribute("src") ? "src" : "action";
      const value = el.getAttribute(attr);
      const rewritten = toLocalUrl(value);
      if (rewritten !== value) el.setAttribute(attr, rewritten);
    }
  }

  function allowedHost(host) {
    host = String(host || "").toLowerCase();
    return host === "sharedchat.cn" || host.endsWith(".sharedchat.cn");
  }

  function toLocalUrl(value) {
    if (!value || /^(data:|blob:|mailto:|tel:|javascript:|about:)/i.test(value)) return value;
    let url;
    try {
      url = new URL(value, location.href);
    } catch (_) {
      return value;
    }
    if (!allowedHost(url.hostname)) return value;
    if (url.hostname === "sharedchat.cn") return url.pathname + url.search + url.hash;
    return "/__proxy?u=" + encodeURIComponent(base64Url(url.href));
  }

  function base64Url(value) {
    return btoa(value).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/g, "");
  }

  function normalize(text) {
    return String(text || "")
      .replace(/[\\s\\u00a0]+/g, "")
      .replace(/\\uff5c/g, "|")
      .trim();
  }

  function textOf(el) {
    return normalize(el && (el.innerText || el.textContent || ""));
  }

  function pageContains(text) {
    return normalize(document.body ? document.body.innerText : "").includes(normalize(text));
  }

  function isVisible(el) {
    if (!el || el.id === "__sharedchat_auto_status") return false;
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  }

  function findByText(text, options = {}) {
    const needle = normalize(text);
    const candidates = Array.from(document.querySelectorAll("button, [role='button'], a, li, div, span, p"))
      .filter(isVisible)
      .map((el) => ({ el, text: textOf(el) }))
      .filter((item) => options.exact ? item.text === needle : item.text.includes(needle))
      .sort((a, b) => scoreCandidate(a.el, a.text, options) - scoreCandidate(b.el, b.text, options));

    if (!candidates.length) return null;
    return options.preferClickable ? closestClickable(candidates[0].el) : closestClickable(candidates[0].el);
  }

  function findLooseTeamCandidate() {
    const candidates = Array.from(document.querySelectorAll("button, [role='button'], a, li, div, span, p"))
      .filter(isVisible)
      .map((el) => ({ el, text: textOf(el) }))
      .filter((item) => item.text.includes("TEAM") && item.text.includes("\\u7a7a\\u95f2") && item.text.includes("\\u63a8\\u8350"))
      .sort((a, b) => scoreCandidate(a.el, a.text, { preferClickable: true }) - scoreCandidate(b.el, b.text, { preferClickable: true }));
    return candidates.length ? closestClickable(candidates[0].el) : null;
  }

  function scoreCandidate(el, text, options) {
    let score = text.length;
    const clickable = closestClickable(el);
    if (clickable !== el) score += 15;
    if (options.preferClickable && clickable) score -= 50;
    if (el.tagName === "A" || el.tagName === "BUTTON") score -= 30;
    return score;
  }

  function closestClickable(el) {
    let node = el;
    for (let i = 0; node && i < 8; i++, node = node.parentElement) {
      if (!isVisible(node)) continue;
      const role = node.getAttribute && node.getAttribute("role");
      const tag = node.tagName;
      const style = getComputedStyle(node);
      if (tag === "A" || tag === "BUTTON" || role === "button" || node.onclick || style.cursor === "pointer") {
        return node;
      }
    }
    return el;
  }

  function findPasswordInput() {
    const inputs = Array.from(document.querySelectorAll("input, textarea"))
      .filter(isVisible)
      .filter((el) => !el.disabled && !el.readOnly);

    return inputs.find((el) => {
      const type = (el.getAttribute("type") || "").toLowerCase();
      const placeholder = el.getAttribute("placeholder") || "";
      const aria = el.getAttribute("aria-label") || "";
      return type === "password" || placeholder.includes("\\u5bc6\\u7801") || placeholder.includes("\\u5bc6\\u78bc") || aria.includes("\\u5bc6\\u7801");
    }) || inputs[0] || null;
  }

  function setInputValue(input, value) {
    input.focus();
    const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(input, value);
    else input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
  }

  function clickElement(el) {
    if (!el) return;
    el.scrollIntoView({ block: "center", inline: "center" });
    const opts = { bubbles: true, cancelable: true, view: window };
    el.dispatchEvent(new MouseEvent("mouseover", opts));
    el.dispatchEvent(new MouseEvent("mousemove", opts));
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.click();
  }

  function showStatus(message) {
    let box = document.getElementById("__sharedchat_auto_status");
    if (!box) {
      box = document.createElement("div");
      box.id = "__sharedchat_auto_status";
      box.style.cssText = [
        "position:fixed",
        "right:12px",
        "bottom:12px",
        "z-index:2147483647",
        "background:rgba(0,0,0,.84)",
        "color:#fff",
        "font:13px/1.45 system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif",
        "padding:10px 12px",
        "border-radius:10px",
        "box-shadow:0 6px 20px rgba(0,0,0,.25)",
        "max-width:360px",
        "white-space:normal"
      ].join(";");
      document.documentElement.appendChild(box);
    }
    box.textContent = "[" + WORKER_VERSION + "] " + message;
  }

  function collectVisibleTexts() {
    return Array.from(document.querySelectorAll("button, [role='button'], a, li, div, span, p"))
      .filter(isVisible)
      .map((el) => textOf(el))
      .filter(Boolean)
      .slice(0, 80);
  }
})();
</script>
`;
