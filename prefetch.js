(() => {
  const AHEAD = 4;
  const TTL_MS = 60000;
  const MAX_ENTRIES = 24;
  const SEG_RE = /^(https?:\/\/[^?#]*\/)(\d+)(\.m4s)(\?[^#]*)?$/;

  const origFetch = window.fetch.bind(window);
  const cache = new Map(); // url -> { t, p: Promise<{buf, type} | null> }

  const segName = (u) => u.split("?")[0].split("/").pop();

  function prefetch(url) {
    const t0 = performance.now();
    const p = (async () => {
      try {
        const r = await origFetch(url);
        if (!r.ok) return null;
        const buf = await r.arrayBuffer();
        const dt = (performance.now() - t0) / 1000;
        console.log(`[plex-prefetch] fetched ${segName(url)} ` +
          `${(buf.byteLength / 1e6).toFixed(2)} MB in ${dt.toFixed(2)}s ` +
          `(${((buf.byteLength * 8) / dt / 1e6).toFixed(1)} Mbit/s)`);
        return { buf, type: r.headers.get("content-type") || "video/mp4" };
      } catch (e) {
        console.warn("[plex-prefetch] failed", segName(url), e);
        return null;
      }
    })();
    const entry = { t: Date.now(), p };
    cache.set(url, entry);
    p.then((res) => { if (!res && cache.get(url) === entry) cache.delete(url); });
  }

  function normalize(rawUrl) {
    try { return new URL(rawUrl, location.href).href; } catch { return null; }
  }

  function onSegmentRequest(url) {
    const m = SEG_RE.exec(url);
    if (!m) return;
    const now = Date.now();
    for (const [u, e] of cache) if (now - e.t > TTL_MS) cache.delete(u);
    while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
    const n = parseInt(m[2], 10);
    for (let i = 1; i <= AHEAD; i++) {
      const next = `${m[1]}${n + i}${m[3]}${m[4] || ""}`;
      if (!cache.has(next)) prefetch(next);
    }
  }

  // ---- fetch ----
  window.fetch = function (input, init) {
    const url = normalize(typeof input === "string" ? input : input && input.url);
    const method = ((init && init.method) || (input && input.method) || "GET").toUpperCase();
    const headers = new Headers((init && init.headers) || (input && input.headers) || undefined);
    if (url && SEG_RE.test(url)) {
      onSegmentRequest(url);
      const entry = cache.get(url);
      if (entry && method === "GET" && !headers.has("range")) {
        return entry.p.then((res) => {
          if (!res) return origFetch(input, init);
          console.log(`[plex-prefetch] served ${segName(url)} from memory (fetch)`);
          return new Response(res.buf.slice(0), {
            status: 200,
            headers: { "content-type": res.type, "content-length": String(res.buf.byteLength) },
          });
        });
      }
    }
    return origFetch(input, init);
  };

  // ---- XMLHttpRequest ----
  const XP = XMLHttpRequest.prototype;
  const origOpen = XP.open;
  const origSend = XP.send;
  const origSetHeader = XP.setRequestHeader;
  const origAbort = XP.abort;

  XP.open = function (method, url, ...rest) {
    this.__pf = { method: String(method).toUpperCase(), url: normalize(String(url)), range: false, aborted: false, async: rest[0] !== false };
    return origOpen.call(this, method, url, ...rest);
  };
  XP.setRequestHeader = function (name, value) {
    if (this.__pf && String(name).toLowerCase() === "range") this.__pf.range = true;
    return origSetHeader.call(this, name, value);
  };
  XP.abort = function () {
    if (this.__pf) this.__pf.aborted = true;
    return origAbort.call(this);
  };

  function defineProps(xhr, res) {
    const rt = xhr.responseType;
    let response;
    if (rt === "arraybuffer") response = res.buf.slice(0);
    else if (rt === "blob") response = new Blob([res.buf], { type: res.type });
    else {
      const text = new TextDecoder().decode(res.buf);
      response = rt === "json" ? JSON.parse(text) : text;
    }
    const props = {
      readyState: 4,
      status: 200,
      statusText: "OK",
      response,
      responseURL: xhr.__pf.url,
    };
    if (rt === "" || rt === "text") props.responseText = response;
    for (const [k, v] of Object.entries(props)) {
      Object.defineProperty(xhr, k, { value: v, configurable: true });
    }
    Object.defineProperty(xhr, "getResponseHeader", {
      configurable: true,
      value: (h) => {
        h = String(h).toLowerCase();
        if (h === "content-type") return res.type;
        if (h === "content-length") return String(res.buf.byteLength);
        return null;
      },
    });
    Object.defineProperty(xhr, "getAllResponseHeaders", {
      configurable: true,
      value: () => `content-type: ${res.type}\r\ncontent-length: ${res.buf.byteLength}\r\n`,
    });
  }

  XP.send = function (body) {
    const st = this.__pf;
    if (st && st.url && SEG_RE.test(st.url)) {
      onSegmentRequest(st.url);
      const entry = cache.get(st.url);
      if (entry && st.method === "GET" && !st.range && st.async) {
        const xhr = this;
        const args = arguments;
        entry.p.then((res) => {
          if (st.aborted) return;
          if (!res) return origSend.apply(xhr, args);
          console.log(`[plex-prefetch] served ${segName(st.url)} from memory (xhr)`);
          defineProps(xhr, res);
          const total = res.buf.byteLength;
          const ev = (type) => xhr.dispatchEvent(new ProgressEvent(type, { lengthComputable: true, loaded: total, total }));
          ev("loadstart");
          xhr.dispatchEvent(new Event("readystatechange"));
          ev("progress");
          ev("load");
          ev("loadend");
        });
        return;
      }
    }
    return origSend.call(this, body);
  };

  console.log("[plex-prefetch] active (in-memory mode)");
})();
