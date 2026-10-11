# Nodal collaboration relay

A Cloudflare Worker plus one Durable Object per room. It forwards end-to-end encrypted messages between the people in a live session and stores the room's latest encrypted state. It can't read anything: the key exists only in the share link's `#fragment`.

It runs on the Workers free plan (SQLite-backed Durable Objects).

```sh
cd collab-server
npm install
npm run dev       # local relay on ws://127.0.0.1:8788
npx wrangler login
npm run deploy    # live at https://nodal-collab.nodal-collab.workers.dev
```

The web app connects to the URL in `COLLAB_URL` (`src/collab/session.ts`), or to `VITE_COLLAB_URL` at build time.

End-to-end test against a local relay (from the repo root, with `npm run dev` running here):

```sh
NODAL_RELAY=1 VITE_COLLAB_URL=ws://127.0.0.1:8788 npx vitest run src/__tests__/collabLive.test.ts
```
