# sharedchat-auto-worker v7

This Worker proxies `https://sharedchat.cn/` and injects an auto-selection script.

Auto flow:

1. Load the SharedChat SPA through your Worker URL.
2. Automatically find and click `TEAM\u7a7a\u95f2|\u63a8\u8350`.
3. When the password prompt appears, create a random 9-digit password.
4. Fill the password and click `OK`.

Useful URLs after deployment:

- `/__health` checks the deployed version.
- `/__debug` checks upstream HTML and asset status.
- `/__clear` clears local cookies.

Deploy through GitHub Actions by pushing to `main`.
