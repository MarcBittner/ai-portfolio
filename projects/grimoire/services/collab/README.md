# grimoire — collab WS service

Dedicated Yjs WebSocket service for **live multi-cursor co-editing**, persisted to
MongoDB. It runs as its own container / Render service behind `COLLAB_WS_URL`, so the
main Next.js app stays **stateless and Vercel-portable** — this WS server is the one
stateful piece, isolated behind a URL.

> **Full documentation** — architecture, HMAC ticket auth, app integration, and the
> activation checklist — lives in **[`docs/collab.md`](../../docs/collab.md)**.

## Run

```
MONGODB_URI=mongodb+srv://…  PORT=1234  [COLLAB_TOKEN=…]  npm start
```

- `MONGODB_URI` — same Atlas cluster; Yjs state goes in a `yjs` collection.
- `COLLAB_TOKEN` — shared secret backing the app-minted per-room ticket.
- Health check: `GET /healthz`.

Deploy as a separate Render web service (own `Dockerfile` here). See
[`docs/collab.md`](../../docs/collab.md) for how the app opens rooms and how to turn
collaboration on.
