const TARGET_ORIGIN = "https://chat.sharedchat.cn";

export default {
  async fetch(request) {
    const incomingUrl = new URL(request.url);

    if (incomingUrl.pathname === "/__health") {
      return new Response("ok");
    }

    const targetUrl = new URL(incomingUrl.pathname + incomingUrl.search, TARGET_ORIGIN);

    const reqHeaders = new Headers(request.headers);
    reqHeaders.delete("host");
    reqHeaders.set("origin", TARGET_ORIGIN);
    reqHeaders.set("referer", TARGET_ORIGIN + "/");

    const init = {
      method: request.method,
      headers: reqHeaders,
      redirect: "manual",
    };

    if (!["GET", "HEAD"].includes(request.method)) {
      init.body = request.body;
    }

    const upstream = await fetch(targetUrl.toString(), init);

    const resHeaders = new Headers(upstream.headers);

    // Remove headers that may block injected script or proxy rendering.
    resHeaders.delete("content-security-policy");
    resHeaders.delete("content-security-policy-report-only");
    resHeaders.delete("x-frame-options");

    // Rewrite upstream redirects so they stay inside this Worker.
    const location = resHeaders.get("location");
    if (location) {
      resHeaders.set("location", rewriteUrlToProxy(location));
    }

    rewriteSetCookieHeaders(upstream.headers, resHeaders);

    const contentType = resHeaders.get("content-type") || "";

    let response = new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: resHeaders,
    });

    if (contentType.includes("text/html")) {
      response = new HTMLRewriter()
        .on("a", new AttrRewriter("href"))
        .on("link", new AttrRewriter("href"))
        .on("script", new AttrRewriter("src"))
        .on("img", new AttrRewriter("src"))
        .on("form", new AttrRewriter("action"))
        .on("body", {
          element(element) {
            element.append(AUTO_SCRIPT, { html: true });
          },
        })
        .transform(response);
    }

    return response;
  },
};

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
      value.startsWith("javascript:")
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

    // Remove Domain so cookies bind to your Worker domain.
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

    const nativeSetter =
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")
        ?.set ||
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")
        ?.set;

    if (nativeSetter) {
      nativeSetter.call(input, value);
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
