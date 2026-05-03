# sharedchat-auto-worker v4

This Cloudflare Worker proxies the actual SharedChat app and injects an auto-click script.

Important: `chat.sharedchat.cn/list` contains a browser-side script that redirects based on the current hostname. When proxied through `workers.dev`, that script redirects to `workers.dev`, which Cloudflare then shows as `workers.cloudflare.com/zh-tw`. v4 bypasses `/list` and proxies `https://sharedchat.cn/` directly.

## GitHub deploy

1. Upload/commit all files to your GitHub repository.
2. Add repository secrets:
   - `CLOUDFLARE_API_TOKEN`
   - `CLOUDFLARE_ACCOUNT_ID`
3. Push to `main`.

## Test URLs

- `https://red-wind-9895.pichulinboy.workers.dev/__health`
- `https://red-wind-9895.pichulinboy.workers.dev/__version`
- `https://red-wind-9895.pichulinboy.workers.dev/__debug`
- `https://red-wind-9895.pichulinboy.workers.dev/?v=4`

Expected health output:

```text
ok v4-bypass-list
```
