# Mono Messenger · Vercel signaling

A tiny serverless relay for **WebRTC negotiation only**. Chat messages, voice and files go over a direct WebRTC DataChannel and **are never sent to this server**.

## Deploy

1. Create an Upstash Redis instance and note `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`.
2. Deploy this folder as a standalone Vercel project. Set the two variables under Project → Settings → Environment Variables.
3. Enter the deployed HTTPS origin (without `/api/signal`) in Mono → Workspaces → Messenger → Settings.
4. On both PCs configure the same origin, exchange Mono IDs, and accept the incoming connection.

## API

- `POST /api/signal` — WebRTC `{from,to,type,payload:{type,sdp}}`, max 45 KB SDP. Rate-limited by source IP.
- `GET /api/signal?id=MONO-XXXXXXXXXXXXXXXXXXXX` — consumes one queued SDP message. Returns `{signal:null}` if empty.
- `OPTIONS` — CORS preflight.

Only SDP signaling envelopes are briefly queued in Redis (**120-second TTL**, removed on fetch). Upstash may have service-level logs / persistence. **No chat messages are persisted or relayed by this API.**

## Limitations

- The mailbox is an unauthenticated rendezvous API. Mono IDs are difficult to guess but **not a cryptographic authentication factor**. For production, add signed identity verification, abuse prevention, and TURN fallback.
- Users need to be online simultaneously; no offline queues of messages.
- STUN may not suffice across restrictive NATs; no TURN included.
- Google/Cloudflare etc. may learn connection metadata when configured as STUN providers.
- Serverless polling every 5 seconds may use provider quota. Adjust for expected active users.

## No messenger database

The client stores only *local* profile, contacts and relay URL. The active conversation lives in browser memory and vanishes after the app closes.
