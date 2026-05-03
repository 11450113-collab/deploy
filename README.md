# sharedchat-auto-worker v3

Cloudflare Worker reverse proxy + auto click script.

## Deploy with GitHub Actions

1. Upload these files to your GitHub repository.
2. Add repository secrets:
   - CLOUDFLARE_API_TOKEN
   - CLOUDFLARE_ACCOUNT_ID
3. Push to `main`.

## Test

- `/__health` should show `ok v3`
- `/__debug` shows upstream status and redirect info
- `/__version` shows worker version

If `/__debug` shows an external redirect to `workers.cloudflare.com`, the upstream site is redirecting Cloudflare Worker fetches. v3 will stop forwarding that redirect and show a diagnostic page instead.
