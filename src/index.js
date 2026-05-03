const WORKER_VERSION = "v4-bypass-list";

// chat.sharedchat.cn redirects `/` -> `/list`, and `/list` has a browser script that
// changes location to the main domain. Under workers.dev that becomes workers.dev,
// which then sends the user to workers.cloudflare.com. So v4 proxies the real app
// domain directly and never serves the `/list` redirect page to the browser.
const ENTRY_ORIGIN = "https://chat.sharedchat.cn";
const APP_ORIGIN = "https://sharedchat.cn";
const KNOWN_ORIGINS = [ENTRY_ORIGIN, APP_ORIGIN];

export default {
  async fetch(request) {
    const incomingUrl = new URL(request.url);

    if (incomingUrl.pathname === "/__health") {
      return text("ok " + WORKER_VERSION);
    }

    if (incomingUrl.pathname === "/__version") {
      return json({ workerVersion: WORKER_VERSION, entryOrigin: ENTRY_ORIGIN, appOrigin: APP_ORIGIN });
    }

    if (incomingUrl.pathname === "/__debug") {
      return debug(request);
    }

    if (incomingUrl.pathname === "/__clear") {
      return clearCookies();
    }

    return proxyToApp(request);
  },
};

async function debug(request) {
  const tests = [
    ENTRY_ORIGIN + "/",
    ENTRY_ORIGIN + "/list",
    APP_ORIGIN + "/",
  ];

  const results = [];

  for (const target of tests) {
    try {
      const res = await fetch(target, {
        method: "GET",
        redirect: "manual",
        headers: makeUpstreamHeaders(request, new URL(target).origin),
      });

      const contentType = res.headers.get("content-type") || "";
      const preview = await res.clone().text().catch(() => "");

      results.push({
        target,
        ok: res.ok,
        status: res.status,
        statusText: res.statusText,
        location: res.headers.get("location"),
        contentType,
        server: res.headers.get("server"),
        cfRay: res.headers.get("cf-ray"),
        bodyPreview: preview.slice(0, 1200),
      });
    } catch (err) {
      results.push({ target, error: String(err && err.message ? err.message : err) });
    }
  }

  return json({ workerVersion: WORKER_VERSION, results });
}

async function proxyToApp(request) {
  const incomingUrl = new URL(request.url);

  // Avoid the broken client-side redirect page completely.
  let upstreamPath = incomingUrl.pathname;
  if (upstreamPath === "/" || upstreamPath === "/list") {
    upstreamPath = "/";
  }

  const upstreamUrl = new URL(upstreamPath + incomingUrl.search, APP_ORIGIN);

  const init = {
    method: request.method,
    headers: makeUpstreamHeaders(request, APP_ORIGIN),
    redirect: "manual",
  };

  if (!["GET", "HEAD"].includes(request.method)) {
    init.body = request.body;
  }

  let upstream = await fetch(upstreamUrl.toString(), init);

  // Follow safe redirects server-side, but never let the browser leave the Worker URL.
  for (let i = 0; i < 5 && isRedirect(upstream.status); i++) {
    const location = upstream.headers.get("location");
    if (!location) break;

    const nextUrl = new URL(location, upstreamUrl);

    if (!KNOWN_ORIGINS.includes(nextUrl.origin)) {
      return html(`<!doctype html>
<html lang="zh-Hant">
<head><meta charset="utf-8"><title>Blocked external redirect</title></head>
<body style="font-family:system-ui;padding:24px">
  <h2>已阻擋外部跳轉</h2>
  <p>上游嘗試跳到：<code>${escapeHtml(nextUrl.toString())}</code></p>
  <p>Worker 版本：<code>${WORKER_VERSION}</code></p>
  <p><a href="/__debug">查看 debug</a></p>
</body>
</html>`, 502);
    }

    upstream = await fetch(nextUrl.toString(), {
      ...init,
      headers: makeUpstreamHeaders(request, nextUrl.origin),
      redirect: "manual",
    });
  }

  const responseHeaders = new Headers(upstream.headers);
  sanitizeResponseHeaders(responseHeaders);
  rewriteSetCookieHeaders(upstream.headers, responseHeaders);

  const contentType = responseHeaders.get("content-type") || "";

  if (contentType.includes("text/html")) {
    const response = new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });

    return new HTMLRewriter()
      .on("a", new AttrRewriter("href"))
      .on("link", new AttrRewriter("href"))
      .on("script", new AttrRewriter("src"))
      .on("img", new AttrRewriter("src"))
      .on("source", new AttrRewriter("src"))
      .on("video", new AttrRewriter("src"))
      .on("audio", new AttrRewriter("src"))
      .on("form", new AttrRewriter("action"))
      .on("body", {
        element(element) {
          element.append(AUTO_SCRIPT, { html: true });
        },
      })
      .transform(response);
  }

  const location = responseHeaders.get("location");
  if (location) {
    responseHeaders.set("location", rewriteUrlToProxy(location));
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

function makeUpstreamHeaders(request, origin) {
  const incoming = request.headers;
  const headers = new Headers();

  const pass = ["accept", "accept-language", "content-type", "cookie", "user-agent"];
  for (const name of pass) {
    const value = incoming.get(name);
    if (value) headers.set(name, value);
  }

  headers.set("host", new URL(origin).host);
  headers.set("origin", origin);
  headers.set("referer", origin + "/");
  headers.set("accept-encoding", "identity");

  return headers;
}

class AttrRewriter {
  constructor(attr) {
    this.attr = attr;
  }

  element(element) {
    const value = element.getAttribute(this.attr);
    if (!value) return;

    const rewritten = rewriteUrlToProxy(value);
    if (rewritten !== value) {
      element.setAttribute(this.attr, rewritten);
    }
  }
}

function rewriteUrlToProxy(value) {
  try {
    if (
      value.startsWith("data:") ||
      value.startsWith("blob:") ||
      value.startsWith("mailto:") ||
      value.startsWith("tel:") ||
      value.startsWith("javascript:") ||
      value.startsWith("#")
    ) {
      return value;
    }

    const url = new URL(value, APP_ORIGIN);

    if (KNOWN_ORIGINS.includes(url.origin)) {
      return url.pathname + url.search + url.hash;
    }

    return value;
  } catch {
    return value;
  }
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

function sanitizeResponseHeaders(headers) {
  headers.delete("content-security-policy");
  headers.delete("content-security-policy-report-only");
  headers.delete("x-frame-options");
  headers.delete("content-length");
  headers.set("cache-control", "no-store, max-age=0");
}

function isRedirect(status) {
  return [301, 302, 303, 307, 308].includes(status);
}

function clearCookies() {
  const headers = new Headers({
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });

  for (const name of ["prefix", "gfsessionid", "sessionid"]) {
    headers.append("set-cookie", `${name}=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; SameSite=Lax`);
  }

  return new Response(`<!doctype html><meta charset="utf-8"><p>cookies cleared. <a href="/?v=4">go back</a></p>`, { headers });
}

function text(value, status = 200) {
  return new Response(value, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function html(value, status = 200) {
  return new Response(value, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch]));
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

    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      rect.width > 0 &&
      rect.height > 0
    );
  }

  function textOf(el) {
    return normalize(el.innerText || el.textContent || "");
  }

  function findByText(text) {
    const needle = normalize(text);
    const elements = Array.from(document.querySelectorAll("button, [role='button'], a, div, span, li, p"))
      .filter(isVisible)
      .filter((el) => textOf(el).includes(needle));

    const exact = elements.find((el) => textOf(el) === needle);
    if (exact) return exact;

    return elements.sort((a, b) => textOf(a).length - textOf(b).length)[0] || null;
  }

  function pageContainsText(text) {
    return normalize(document.body ? document.body.innerText : "").includes(normalize(text));
  }

  function findPasswordInput() {
    const inputs = Array.from(
      document.querySelectorAll("input[type='password'], input[placeholder*='密码'], input[placeholder*='密碼'], input, textarea")
    ).filter(isVisible);

    return (
      inputs.find((el) => {
        const type = (el.getAttribute("type") || "").toLowerCase();
        const placeholder = el.getAttribute("placeholder") || "";
        return type === "password" || placeholder.includes("密码") || placeholder.includes("密碼");
      }) || inputs[0] || null
    );
  }

  function clickElement(el) {
    el.scrollIntoView({ block: "center", inline: "center" });
    el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse" }));
    el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerType: "mouse" }));
    el.click();
  }

  function setInputValue(input, value) {
    input.focus();

    const proto = input.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const nativeSetter = Object.getOwnPropertyDescriptor(proto, "value")?.set;

    if (nativeSetter) nativeSetter.call(input, value);
    else input.value = value;

    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
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
        "background:rgba(0,0,0,.82)",
        "color:#fff",
        "font:13px/1.45 system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif",
        "padding:10px 12px",
        "border-radius:10px",
        "box-shadow:0 6px 20px rgba(0,0,0,.25)",
        "max-width:340px"
      ].join(";");

      document.documentElement.appendChild(box);
    }

    box.textContent = message;
  }

  function step() {
    try {
      if (Date.now() - startedAt > 45000) {
        showStatus("自動流程逾時；隨機密碼：" + password);
        return false;
      }

      if (!clickedTeam) {
        const teamButton = findByText(TEAM_TEXT);
        if (teamButton) {
          clickElement(teamButton);
          clickedTeam = true;
          showStatus("已點擊 TEAM空闲|推荐，隨機密碼：" + password);
        } else {
          showStatus("等待 TEAM空闲|推荐；隨機密碼：" + password);
        }
        return true;
      }

      if (!filledPassword) {
        if (!pageContainsText(PASSWORD_HINT_TEXT)) {
          showStatus("等待密碼提示；隨機密碼：" + password);
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
          showStatus("完成：已點擊 OK。密碼：" + password);
          return false;
        }
        showStatus("等待 OK；隨機密碼：" + password);
      }

      return true;
    } catch (err) {
      showStatus("自動流程錯誤：" + err.message + "；密碼：" + password);
      return false;
    }
  }

  const timer = setInterval(() => {
    if (!step()) clearInterval(timer);
  }, 500);

  const observer = new MutationObserver(() => step());
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
</script>
`;
