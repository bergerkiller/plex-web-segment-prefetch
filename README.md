# Plex Web Segment Prefetch

A small browser extension for **Plex Web** (`app.plex.tv`) that fixes buffering when streaming from a remote server
over a high-latency connection, even though your bandwidth is plenty.

## The problem

Plex Web's DASH player downloads transcoded segments (`.../<n>.m4s`) one after another over what is effectively a
**single sequential TCP stream**. The speed of one TCP stream is limited by round-trip latency and by how the
sender's congestion control reacts to packet loss. On a high-latency path, or when the server uses a loss-based
algorithm like CUBIC, a single stream can end up far slower than the connection itself. If that is below the stream's
bitrate, the player keeps running out of buffer, even though a speed test or several parallel downloads show plenty of
bandwidth.

The server's transcoder is not the problem here. Plex can report that it's "throttled" and already far ahead of the
player, while the player is still stuck buffering, because the data is waiting on the slow transfer.

The proper fix is on the server, for example enabling BBR as its TCP congestion control, but that is only possible if
you control the server.

## What it does

The extension works around the single-stream limit from the client side. When the player requests segment `n`, it
immediately fetches `n+1 … n+4` in parallel, keeps them in memory for 60 seconds, and hands them to the player when it
asks for them. Several concurrent downloads together use much more of the available bandwidth than one stream does,
so the player buffers well ahead instead of stalling.

- Wraps `fetch` and `XMLHttpRequest` in the page (works with either).
- Matches any request whose path ends in `/<number>.m4s`.
- Runs only on `https://app.plex.tv/*`. No permissions requested, no data sent anywhere.
- Skips `Range` requests and non-`GET` requests.

It does not make the HTTP cache do the work, because browsers decide what to store before extensions can edit
response headers. It serves from its own in-memory cache instead.

## Install in Brave (also works in Chrome / Edge / other Chromium browsers)

The extension isn't in a web store, so load it as an unpacked extension:

1. Download or clone this repository so the folder containing `manifest.json` is on your disk.
2. Open `brave://extensions` in Brave.
3. Turn on **Developer mode** (toggle in the top-right).
4. Click **Load unpacked** and select the folder that contains `manifest.json`.
5. Open (or reload) `https://app.plex.tv`, start playing something, and open DevTools → Console. You should see
   `[plex-prefetch] active (in-memory mode)`.

After changing any file, press the reload icon on the extension's card in `brave://extensions` and refresh the Plex tab.

### Flatpak Brave

If Brave is a Flatpak (`com.brave.Browser`), the file picker may not see your home directory. Put the extension
somewhere Brave can read, for example `~/.var/app/com.brave.Browser/`, or grant access with
`flatpak override --user --filesystem=/path/to/extension:ro com.brave.Browser`.

## Checking that it works

In the Console:

```
[plex-prefetch] fetched 1432.m4s 3.50 MB in 0.90s (31.1 Mbit/s)
[plex-prefetch] served 1432.m4s from memory (xhr)
```

`fetched` lines are background downloads; `served` lines are segments the player received instantly from memory.
In the Network tab the player's requests for prefetched segments disappear or are near-instant.

## Settings

Constants at the top of `prefetch.js`:

| Name          | Default | Meaning                                         |
|---------------|---------|-------------------------------------------------|
| `AHEAD`       | `4`     | Segments to prefetch beyond the one requested   |
| `TTL_MS`      | `60000` | How long a prefetched segment is kept           |
| `MAX_ENTRIES` | `24`    | Max segments held in memory (~3.5 MB each)      |

The matching regex is `SEG_RE` in the same file.

## Limitations

- Only DASH segments named with a numeric `<n>.m4s`. HLS or other naming isn't handled.
- Only works in the Plex Web app on `app.plex.tv`, not other Plex clients or a server's own `/web` page.
- If total bandwidth is the limit (not per-connection throughput), prefetching won't help.
- Seeking invalidates what was prefetched; the cache refills from the new position.
- Higher `AHEAD` makes Plex's transcoder work further ahead and uses more memory.

## Files

- `manifest.json` – Manifest V3 definition; injects `prefetch.js` into the page's main world.
- `prefetch.js` – prefetching and in-memory serving logic.

## License

[CC0 1.0 Universal](LICENSE) (public domain dedication). Use it however you like, no attribution required.
