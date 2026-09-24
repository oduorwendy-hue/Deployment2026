# Stand Here — Visual Ride Match (peer-to-peer)

A prototype for two people meeting up to confirm they've found each other:
type the same meeting-location name on both phones, get the same
**color + shape + number**, and get glow + vibration + a sound cue as your
live distance closes.

No build step, no account signups required. Plain HTML/CSS/JS — drop it on
Vercel or Netlify as-is and it works.

## Deploy it (2 minutes)

**Vercel**
1. Go to vercel.com -> Add New -> Project -> drag this folder in (or push it
   to a GitHub repo and import that repo).
2. No framework, no build command needed — it deploys as static files.
3. Open the URL it gives you.

**Netlify**
1. Go to app.netlify.com -> Add new site -> Deploy manually -> drag this
   folder in (or connect a GitHub repo).
2. Same deal — static site, no build command.

That's it. **Both Demo Mode and Live Mode work immediately with zero setup**
— there's nothing to configure before your demo.

## How this is one app used by two phones

This is important and easy to misread as a bug: **it's one link, opened
separately on two phones** — not a split-screen that shows both people at
once. Person A opens the link on their phone, Person B opens the *same*
link on theirs. Each phone shows only itself. Typing the same location text
on both is what makes them land on the same color/shape/number and find
each other.

## How Live Mode syncs two real phones (no backend account needed)

Both phones hash the location text into the same ID. Whichever phone taps
Start first claims that ID as a rendezvous point on **PeerJS's free public
signaling service**; the second phone's attempt to claim the same ID fails
(IDs are unique), which is exactly how it recognizes "I'm the second phone"
and instead connects *to* the first one. Once connected, the two phones talk
**directly to each other** over WebRTC — your location is never sent to a
database or a server of ours.

**Known limitation:** this handshake uses a free, best-effort public relay
and Google's public STUN servers for NAT traversal. It's reliable on the
same WiFi network (recommended for a class demo) and usually fine across
cellular carriers too, but there's no paid TURN relay behind it — on a very
locked-down network (some corporate/campus firewalls) the direct connection
can fail to establish. If that happens repeatedly, the fix is adding a TURN
server (e.g. a free tier from metered.ca or Twilio) to the PeerJS config in
`app.js` — ask if you want that wired in.

## Testing with two real phones

1. Deploy it (or run it locally over **https://** or **localhost** —
   geolocation is blocked on plain `http://` on a phone).
2. On phone A, open the site, type "Starbucks" (or whatever you're actually
   meeting at), tap **Start (Live Mode)**.
3. On phone B, open the same site, type the *exact same* location text, tap
   **Start (Live Mode)**.
4. Both phones should show the same `COLOR SHAPE NUMBER`. As you physically
   walk toward each other: distance updates live, the interface simplifies
   inside ~150m, and inside ~25m both phones glow, vibrate, and play a
   two-tone chime together.

**Known limitation:** the match ID and rendezvous ID both come purely from
the location text, so two unrelated pairs typing the same common location
on the same day would collide into the same session. Fine for a classroom
demo; a real product would add a short PIN or a date component.

## Sensory feedback and browser support

- **Vibration** (`navigator.vibrate()`): Android Chrome/Firefox support it.
  **iOS Safari does not implement the Vibration API at all** — on an
  iPhone you'll get the glow and the sound, not the buzz. The app detects
  support and shows it either way.
- **Sound**: a short chime plays via the Web Audio API — no audio file
  needed. Browsers require a user tap before any sound can play, which is
  why it's unlocked the moment you tap Start/Demo — no extra step needed.
- **Glow**: always fires regardless of the above, so there's always at
  least one confirmation signal.

This 3-way redundancy (glow + vibration + sound) is deliberately designed
so a real rideshare match confirmation would work even if someone isn't
looking at their phone, doesn't feel a buzz, or has sound muted.

## Files

- `index.html` — the join screen and the live match screen (one page, two states)
- `app.js` — state machine, geolocation, PeerJS sync, optional Mapbox calls, vibration + sound
- `config.js` — optional Mapbox key and the distance thresholds
- `styles.css` — dark, high-contrast visual design
- `vercel.json` / `netlify.toml` — grant the page geolocation permission on each host

## Extending this toward a real rideshare use case

- Swap the location-text hash for a real ride-assignment payload from a
  dispatch system (this is exactly where an Uber/Lyft-style backend would
  plug in — the color/shape/number generation and the glow/vibrate/sound
  confirmation logic wouldn't need to change).
- Add a TURN server for guaranteed connectivity on any network (see above).
- Move to a proper backend (Firebase, Supabase, or a small server) once you
  need more than two participants, message history, or reconnect handling
  beyond what a direct WebRTC connection gives you.
- Add the optional Mapbox key for real walking ETAs instead of straight-line
  distance.
