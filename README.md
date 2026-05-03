# sharedchat-auto-worker v5

This version avoids the white-page issue by serving a local picker page first, fetching the upstream list through the Worker, then opening the selected sharedchat page through a local proxy.

## Deploy with GitHub Actions

1. Upload all files to your GitHub repository.
2. Add repository secrets:
   - CLOUDFLARE_API_TOKEN
   - CLOUDFLARE_ACCOUNT_ID
3. Push to main.

## Test

- /__health should show `ok v5-self-rendered-list`
- /__debug shows upstream fetch status
- /__clear clears proxy cookies
