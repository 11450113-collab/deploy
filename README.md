# sharedchat-auto-worker

這是一個 Cloudflare Worker 專案，可用 GitHub 自動部署。

功能：
- 使用 Worker 代理載入 `https://chat.sharedchat.cn/`
- 不是 redirect
- 自動尋找並點擊 `TEAM空闲|推荐`
- 出現 `设置密码以区分隔离会话` 後，自動產生隨機 9 位數密碼
- 自動填入密碼並點擊 `OK`

## 重要：Worker 名稱

目前 `wrangler.toml` 已設定：

```toml
name = "red-wind-9895"
```

如果你想用其他 Worker 名稱，請先修改 `wrangler.toml` 裡的 `name`。

## 用 GitHub Actions 部署

1. 在 GitHub 建立新 repository。
2. 把這個資料夾裡的所有檔案 push 到 GitHub。
3. 到 Cloudflare Dashboard 建立 API Token：
   - My Profile / API Tokens
   - Create Token
   - 選 `Edit Cloudflare Workers` template
   - Scope 選你的 Cloudflare account
4. 到 GitHub repository：
   - Settings
   - Secrets and variables
   - Actions
   - New repository secret
5. 新增兩個 secrets：
   - `CLOUDFLARE_API_TOKEN`：Cloudflare API Token
   - `CLOUDFLARE_ACCOUNT_ID`：Cloudflare Account ID
6. push 到 `main` branch 後，GitHub Actions 會自動部署。

## 本地測試

```bash
npm install
npm run dev
```

## 手動部署

```bash
npm install
npm run deploy
```

## 注意

這種方式是「反向代理 + 注入前端腳本」。如果目標網站使用強 CSP、防代理、特殊 WebSocket、跨域 API 或前端檢測，可能需要再針對實際網頁結構調整 `src/index.js` 裡的 selector / 文字搜尋邏輯。
