# חובות - Debt Management PWA

Progressive Web App for managing customer debts, with cloud sync via Cloudflare Pages.

## 🌐 Live URL

https://hovot-app.pages.dev

## 🚀 Tech Stack

- **Frontend:** Single-file HTML + vanilla JS (index.html, ~2000 lines)
- **PWA:** manifest.json + sw.js (Service Worker)
- **Hosting:** Cloudflare Pages
- **Cloud sync:** Cloudflare Pages Functions + KV storage

## 📁 Structure

```
├── index.html              # Main app (HTML + CSS + JS all-in-one)
├── manifest.json           # PWA manifest
├── sw.js                   # Service Worker
├── icon-*.png              # PWA icons
└── functions/
    └── api/
        └── sync.js         # Cloudflare Pages Function (/api/sync)
```

## ⚙️ Cloudflare Pages Setup

The sync function requires a **KV namespace binding** in Cloudflare Pages:

1. Cloudflare Dashboard → Pages → hovot-app → Settings → Functions → KV namespace bindings
2. Add binding: **variable name = `DEBTS`**, namespace = your KV namespace
3. Repeat for both **Production** and **Preview** environments

Without this binding, `/api/sync` will return 500 with "Storage not configured".

## 🔒 Security Notes

- Sync code is the ONLY authentication - treat it as a password (12+ chars recommended)
- Data is stored per-sync-code in KV; anyone with the code has full read/write access
- CORS is currently set to same-origin

## 🚧 Development

Just edit `index.html`, commit, push - Cloudflare Pages auto-deploys.

Test locally with any static HTTP server (e.g. `python -m http.server`).
