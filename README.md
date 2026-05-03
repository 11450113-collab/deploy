# sharedchat-auto-worker v2

Cloudflare Worker reverse proxy for https://chat.sharedchat.cn/ with injected auto-click script.

## Deploy with GitHub Actions

1. Upload this folder to a GitHub repo.
2. Add repo secrets:
   - CLOUDFLARE_API_TOKEN
   - CLOUDFLARE_ACCOUNT_ID
3. Push to the `main` branch.

## Test

- Health check: `https://red-wind-9895.<your-subdomain>.workers.dev/__health`
- Upstream debug: `https://red-wind-9895.<your-subdomain>.workers.dev/__debug`
- Main page: `https://red-wind-9895.<your-subdomain>.workers.dev/`

If `/__health` shows `ok` but `/__debug` shows 403, the upstream site is blocking Cloudflare Worker fetch requests.
