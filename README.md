# Natsoft Live (web)

A cleaner live timing page for Natsoft meetings that works on your phone, plus a JSON feed for broadcast
graphics. Runs on Cloudflare Workers, usually within the free plan.

Unofficial. Not affiliated with Natsoft or any series.

```
Natsoft ──(one connection per meeting)──► Cloudflare relay ──► phones, tablets, overlays
```

The relay holds a single connection to Natsoft for each meeting, however many people are watching. It only
connects while someone has the page open (or something polls the JSON), and disconnects 2 minutes after the
last viewer leaves.

## Deploy it (about 5 minutes)

You need [Node.js](https://nodejs.org) (the LTS installer is fine) and a free Cloudflare account.

```sh
cd natsoft-web
npm install
npx wrangler login     # opens your browser to sign in to Cloudflare
npm run deploy
```

The last line prints your address, something like `https://natsoft-live.<your-subdomain>.workers.dev`.
The first time, Cloudflare asks you to pick that subdomain.

### Then check it can reach Natsoft (do this first)

Open your address, tap **Test the connection** (or go to `/#check:V8SUPER`). You want four green ticks:

1. Load the meeting page (port 8080)
2. Find the live token on the page
3. Open the live timing WebSocket
4. Wait for the first message: `<New>` means live timing is flowing; `NotFound` also counts as a pass, since
   it means Natsoft answered but the meeting isn't live right now.

If step 1 or 3 fails, Natsoft is refusing connections from Cloudflare's network. Send me the results and we'll
move the relay somewhere else (the phone page stays the same).

## Put it on your iPhone

Open the address in Safari, tap **Share → Add to Home Screen**. It opens full screen like an app.

- Type a meeting ID (`V8SUPER` for Supercars weekends), or paste a LiveMeeting link.
- The **Gap / Int / Last / Best** buttons switch the right-hand column. Turn the phone sideways to see them all,
  plus sectors.
- Tap a car for its details; star it there to highlight it.
- **Race Control** shows stewards' messages, with a badge for new ones.
- **Screen on** stops the phone going to sleep while you watch (iOS 16.4+).
- `DEMO` runs a made-up race, so you can try it any time.

## Keep it private (recommended)

Anyone with the address can use it. To require a key:

```sh
npx wrangler secret put ACCESS_KEY    # type a password when asked
```

The page then asks for the key once and remembers it. The relay still serves the page itself to anyone, but
not the timing data. For per-person logins, you can put
[Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/self-hosted-apps/)
in front instead (free for up to 50 users).

## For broadcast graphics

`GET /api/state?meeting=V8SUPER` returns the current state as JSON (add `&key=…` if you set a key):
session, flag, clock, session best, lap record, every car (position, number, driver, vehicle, laps, gap,
interval, last/best laps, sectors, speed, pit status, stops) and race control messages.

- vMix: add it as a **Data Source → JSON** and poll it every second.
- Polling keeps the Natsoft connection open; it closes 2 minutes after the last poll.
- For live push instead of polling, `wss://…/api/live?meeting=…` sends `{"type":"full"}` once, then
  `{"type":"patch"}` messages with only what changed (see `public/app.js` for how to apply them).

## Costs

The free plan includes 13,000 GB-seconds of Durable Object time a day, and one relay running all day uses about
11,000, so even a full day of a meeting fits. Viewer updates aren't charged. If you ever go over, the paid
Workers plan is US$5/month. A phone uses about 4–5 MB an hour during a session.

## How it talks to Natsoft

Like Natsoft's own page, one tab's worth:

1. Loads `https://server.natsoft.com.au:8080/LiveMeeting/<ID>` for its `gsLiveToken`.
2. Opens `wss://server.natsoft.com.au:8080/LiveMeeting/<ID>?Token=…` with the same browser User-Agent and
   Natsoft's Origin. It never sends anything.
3. Decodes each frame (plain or XOR-chained XML) and applies the `<New>` snapshot and updates.

Cloudflare's `fetch()` only reaches ports 80 and 443, so the relay opens a TLS socket to port 8080 with
`connect()` and speaks HTTP and WebSocket itself (`src/wsclient.ts`). `<NotFound/>` retries every 30 s,
`<Redirect/>` is followed straight away, and errors retry after 10 s.

Protocol notes come from the open-source [supercars-timing](https://github.com/J-Haynes/supercars-timing) project.
For anything you broadcast commercially, ask the timekeepers for their official feed.

## Developing

```sh
npm run dev      # local server at http://localhost:8787 (the DEMO meeting works offline)
npm test         # decoder, XML, timing model, and the WebSocket client against a fake Natsoft server
npm run check    # type-check
```

```
src/index.ts      routes: page, /api/live, /api/state, /api/check
src/relay.ts      Durable Object: one Natsoft connection per meeting, fan-out to viewers
src/natsoft.ts    token, connection loop, reconnects, connection check
src/wsclient.ts   HTTP + WebSocket client over a raw TLS socket
src/decoder.ts    Natsoft frame decoding
src/xml.ts        tiny XML reader
src/timing.ts     timing state and the JSON snapshot
src/demo.ts       made-up race for the DEMO meeting
public/           the phone page
```
