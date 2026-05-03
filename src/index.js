const WORKER_VERSION = "v3-redirect-guard";
const TARGET_ORIGIN = "https://chat.sharedchat.cn";
const DEFAULT_ENTRY_PATH = "/list";
const MAX_REDIRECTS = 5;

export default {
  async fetch(request) {
    const incomingUrl = new URL(request.url);

    if (incomingUrl.pathname === "/__health") {
      return new Response("ok " + WORKER_VERSION, {
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
          "x-worker-version": WORKER_VERSION,
        },
      });
    }

    if (incomingUrl.pathname === "/__version") {
      return Response.json({ version: WORKER_VERSION }, { headers: noStoreHeaders() });
    }

    if (incomingUrl.pathname === "/__debug") {
      return debugUpstream(request);
    }

    // Root is a local shell. This prevents the browser address bar from being
    // sent away by upstream 30x or top-level navigation attempts.
    if (incomingUrl.pathname === "/") {
      return new Response(makeShellHtml(), {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "x-worker-version": WORKER_VERSION,
        },
      });
    }

    return proxyRequest(request, incomingUrl);
  },
};

async function proxyRequest(request, incomingUrl) {
  const targetUrl = new URL(incomingUrl.pathname + incomingUrl.search, TARGET_ORIGIN);
  const result = await fetchUpstreamFollowingSameOriginRedirects(request, targetUrl);

  if (result.error) {
    return new Response(makeDiagnosticHtml({
      title: "Worker fetch failed",
      message: result.error,
      targetUrl: targetUrl.toString(),
    }), {
      status: 502,
      headers: htmlHeaders(),
    });
  }

  if (result.externalRedirect) {
    return new Response(makeDiagnosticHtml({
      title: "External redirect blocked",
      message: "The upstream site returned a redirect outside chat.sharedchat.cn. The Worker stopped it so your browser will not be redirected.",
      targetUrl: result.requestedUrl,
      externalRedirect: result.externalRedirect,
      status: result.response.status,
      statusText: result.response.statusText,
    }), {
      status: 502,
      headers: htmlHeaders(),
    });
  }

  const upstream = result.response;
  const responseHeaders = new Headers(upstream.headers);
  sanitizeResponseHeaders(responseHeaders);
  rewriteSetCookieHeaders(upstream.headers, responseHeaders);
  responseHeaders.set("x-worker-version", WORKER_VERSION);
  responseHeaders.set("x-upstream-final-url", result.finalUrl);

  const contentType = responseHeaders.get("content-type") || "";

  let response = new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });

  if (contentType.includes("text/html")) {
    response = new HTMLRewriter()
      .on("head", {
        element(element) {
          element.prepend(EARLY_GUARD_SCRIPT, { html: true });
        },
      })
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

  return response;
}

async function fetchUpstreamFollowingSameOriginRedirects(request, initialUrl) {
  let currentUrl = new URL(initialUrl.toString());

  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    let upstream;

    try {
      upstream = await fetch(currentUrl.toString(), {
        method: request.method,
        headers: makeCleanUpstreamHeaders(request),
        body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
        redirect: "manual",
      });
    } catch (err) {
      return { error: err.message, requestedUrl: currentUrl.toString() };
    }

    const location = upstream.headers.get("location");
    const isRedirect = [301, 302, 303, 307, 308].includes(upstream.status);

    if (!isRedirect || !location) {
      return {
        response: upstream,
        finalUrl: currentUrl.toString(),
        requestedUrl: currentUrl.toString(),
      };
    }

    const nextUrl = new URL(location, currentUrl);

    if (nextUrl.origin !== TARGET_ORIGIN) {
      return {
        response: upstream,
        finalUrl: currentUrl.toString(),
        requestedUrl: currentUrl.toString(),
        externalRedirect: nextUrl.toString(),
      };
    }

    currentUrl = nextUrl;
  }

  return { error: "Too many upstream redirects", requestedUrl: currentUrl.toString() };
}

async function debugUpstream(request) {
  const targets = ["/", DEFAULT_ENTRY_PATH];
  const results = [];

  for (const path of targets) {
    const url = new URL(path, TARGET_ORIGIN);

    try {
      const upstream = await fetch(url.toString(), {
        method: "GET",
        headers: makeCleanUpstreamHeaders(request),
        redirect: "manual",
      });

      let preview = "";
      try {
        preview = await upstream.clone().text();
        preview = preview.slice(0, 1200);
      } catch (err) {
        preview = "Cannot read upstream body: " + err.message;
      }

      results.push({
        target: url.toString(),
        ok: upstream.ok,
        status: upstream.status,
        statusText: upstream.statusText,
        location: upstream.headers.get("location"),
        contentType: upstream.headers.get("content-type"),
        server: upstream.headers.get("server"),
        cfRay: upstream.headers.get("cf-ray"),
        bodyPreview: preview,
      });
    } catch (err) {
      results.push({ target: url.toString(), ok: false, error: err.message });
    }
  }

  return Response.json(
    {
      workerVersion: WORKER_VERSION,
      targetOrigin: TARGET_ORIGIN,
      results,
    },
    { headers: noStoreHeaders() }
  );
}

function makeCleanUpstreamHeaders(request) {
  const source = request.headers;
  const headers = new Headers();

  headers.set(
    "user-agent",
    source.get("user-agent") ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
  );
  headers.set(
    "accept",
    source.get("accept") ||
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"
  );
  headers.set("accept-language", source.get("accept-language") || "zh-TW,zh;q=0.9,en;q=0.8");
  headers.set("cache-control", "no-cache");
  headers.set("pragma", "no-cache");
  headers.set("referer", TARGET_ORIGIN + "/");

  const cookie = source.get("cookie");
  if (cookie) headers.set("cookie", cookie);

  const contentType = source.get("content-type");
  if (contentType) headers.set("content-type", contentType);

  if (!["GET", "HEAD"].includes(request.method)) {
    headers.set("origin", TARGET_ORIGIN);
  }

  return headers;
}

function sanitizeResponseHeaders(headers) {
  headers.delete("content-security-policy");
  headers.delete("content-security-policy-report-only");
  headers.delete("x-frame-options");
  headers.delete("cross-origin-opener-policy");
  headers.delete("cross-origin-embedder-policy");
  headers.delete("cross-origin-resource-policy");
  headers.delete("location");
  headers.set("cache-control", "no-store");
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

    const url = new URL(value, TARGET_ORIGIN);

    if (url.origin === TARGET_ORIGIN) {
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

function htmlHeaders() {
  return {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-worker-version": WORKER_VERSION,
  };
}

function noStoreHeaders() {
  return {
    "cache-control": "no-store",
    "x-worker-version": WORKER_VERSION,
  };
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function makeShellHtml() {
  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>SharedChat Auto</title>
  <style>
    html, body { margin: 0; height: 100%; background: #111; }
    iframe { position: fixed; inset: 0; width: 100%; height: 100%; border: 0; background: #fff; }
    .badge { position: fixed; right: 10px; bottom: 10px; z-index: 10; background: rgba(0,0,0,.72); color: #fff; font: 12px system-ui, sans-serif; padding: 8px 10px; border-radius: 9px; }
    .badge a { color: #fff; }
  </style>
</head>
<body>
  <iframe src="${DEFAULT_ENTRY_PATH}" sandbox="allow-forms allow-scripts allow-same-origin allow-downloads allow-popups"></iframe>
  <div class="badge">${WORKER_VERSION} · <a href="/__debug" target="_blank">debug</a></div>
</body>
</html>`;
}

function makeDiagnosticHtml({ title, message, targetUrl, externalRedirect, status, statusText }) {
  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; line-height: 1.55; padding: 28px; max-width: 860px; margin: auto; }
    code, pre { background: #f3f4f6; padding: 2px 5px; border-radius: 6px; }
    pre { padding: 14px; overflow: auto; }
  </style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <p>${escapeHtml(message)}</p>
  <pre>${escapeHtml(JSON.stringify({ workerVersion: WORKER_VERSION, targetUrl, externalRedirect, status, statusText }, null, 2))}</pre>
  <p>Open <a href="/__debug" target="_blank">/__debug</a> and send the JSON if you want me to diagnose the upstream response.</p>
</body>
</html>`;
}

const EARLY_GUARD_SCRIPT = `
<script>
(() => {
  window.__sharedChatWorkerVersion = ${JSON.stringify(WORKER_VERSION)};
  window.addEventListener("beforeunload", () => {}, { capture: true });
})();
</script>
`;

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
    return String(text || "").replace(/\s+/g, "").trim();
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

    const candidates = Array.from(
      document.querySelectorAll("button, [role='button'], a, div, span, li, p")
    )
      .filter(isVisible)
      .filter((el) => textOf(el).includes(needle))
      .sort((a, b) => textOf(a).length - textOf(b).length);

    return candidates[0] || null;
  }

  function pageContainsText(text) {
    return normalize(document.body ? document.body.innerText : "").includes(
      normalize(text)
    );
  }

  function findPasswordInput() {
    const inputs = Array.from(
      document.querySelectorAll(
        "input[type='password'], input[placeholder*='密码'], input[placeholder*='密碼'], input, textarea"
      )
    ).filter(isVisible);

    return (
      inputs.find((el) => {
        const type = (el.getAttribute("type") || "").toLowerCase();
        const placeholder = el.getAttribute("placeholder") || "";
        return (
          type === "password" ||
          placeholder.includes("密码") ||
          placeholder.includes("密碼")
        );
      }) || inputs[0] || null
    );
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

    const inputSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    const textareaSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
    const setter = input instanceof HTMLTextAreaElement ? textareaSetter : inputSetter;

    if (setter) {
      setter.call(input, value);
    } else {
      input.value = value;
    }

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
        "max-width:320px"
      ].join(";");

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
</script>
`;
