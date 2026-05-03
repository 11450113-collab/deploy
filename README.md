# sharedchat-auto-worker v6

Cloudflare Worker project. It proxies the real SharedChat SPA on `https://sharedchat.cn/`, keeps the browser on your workers.dev URL, injects an auto-click script, generates a random 9-digit password, fills the password prompt, and clicks OK.

## Deploy with GitHub Actions

Required GitHub repository secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

Push to `main` to deploy.

## Test URLs

```text
https://red-wind-9895.pichulinboy.workers.dev/__health
https://red-wind-9895.pichulinboy.workers.dev/__debug
https://red-wind-9895.pichulinboy.workers.dev/__asset_debug
https://red-wind-9895.pichulinboy.workers.dev/__clear
https://red-wind-9895.pichulinboy.workers.dev/?v=6
```

If the page appears blank, open `/__asset_debug` and check whether the JS and CSS assets return status `200` with the right content type.
