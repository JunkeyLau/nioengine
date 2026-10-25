/* Engine Sound Lab — P0 capability probe.
   Written with conservative ES2017 syntax on purpose: the car browser is unknown. */
(function () {
  "use strict";

  var I18N = window.P0_I18N || { zh: {}, en: {} };
  var BUILD = window.P0_BUILD || { version: "0.1.0", time: "" };
  var REPORT_KEY = "nioengine.p0.report.v1";
  var LANG_KEY = "nioengine.p0.lang";
  var VOLUME_KEY = "nioengine.p0.volume";
  var MAX_EVENTS = 300;

  var state = {
    lang: "zh",
    started: false,
    detecting: false,
    detectError: false,
    ctx: null,
    master: null,
    comp: null,
    analyser: null,
    workletNode: null,
    worklet: {
      blob: { status: "notTested", ms: null, error: null },
      url: { status: "notTested", ms: null, error: null, url: null },
      node: { status: "notTested", ms: null, error: null },
      loaded: false,
      attempted: false,
      processorReady: false
    },
    fallback: null,
    fallbackActive: false,
    playing: false,
    mode: "idle",
    rpm: 900,
    volume: 0.35,
    heartbeat: {
      count: 0,
      lastAt: 0,
      lastGap: 0,
      maxGap: 0,
      lastGapLogAt: 0
    },
    meter: { rms: 0, peak: 0, rpm: 0, at: 0 },
    uaHighEntropy: null,
    env: {},
    audioApi: {},
    contextInfo: null,
    latency: { baseMs: null, outputMs: null, totalMs: null, rating: "unknown" },
    codecs: {},
    display: {
      canvas2d: false,
      webgl: false,
      webgl2: false,
      renderer: null,
      fullscreenApi: false,
      fullscreen: false,
      wakeLockApi: false,
      wakeLockActive: false,
      wakeLockWanted: false,
      wakeLockSentinel: null,
      orientationLock: false,
      touchPoints: 0,
      coarse: false,
      dvh: false,
      fps: null
    },
    audioTests: {},
    stability: {
      running: false,
      requestedMs: 0,
      startedAt: 0,
      endsAt: 0,
      actualMs: 0,
      completed: false,
      early: false,
      verdict: "notRun",
      reasons: [],
      summary: null,
      marks: [],
      stateChanges: 0,
      maxGap: 0,
      degraded: false,
      fps: { samples: [], frames: 0, lastAt: 0, worstFrameMs: 0, raf: 0 },
      memoryStart: null,
      memoryEnd: null,
      heartbeatCount: 0,
      audioState: null,
      timers: { end: 0, ui: 0, rpm: 0, save: 0 }
    },
    events: [],
    errors: [],
    savedReport: null,
    report: null,
    revTimers: [],
    scopeActive: false,
    scopeRaf: 0,
    scopeBuf: null,
    lastMeterRender: 0,
    lastAudioRender: 0,
    toastTimer: 0,
    resizeTimer: 0,
    autorun: false
  };

  var els = {};

  /* ------------------------------------------------------------------ */
  /* Small helpers                                                      */
  /* ------------------------------------------------------------------ */

  function byId(id) {
    return document.getElementById(id);
  }

  function t(key, vars) {
    var dict = I18N[state.lang] || I18N.en || {};
    var text = dict[key];
    if (text === undefined) text = (I18N.en || {})[key];
    if (text === undefined) text = key;
    if (!vars) return text;
    return String(text).replace(/\{(\w+)\}/g, function (match, name) {
      return vars[name] === undefined ? match : String(vars[name]);
    });
  }

  function fmtMs(value, digits) {
    if (value === null || value === undefined || !isFinite(value)) return "—";
    var d = digits === undefined ? 1 : digits;
    return value.toFixed(d) + " " + t("units.ms");
  }

  function fmtDuration(ms) {
    if (!isFinite(ms) || ms < 0) ms = 0;
    var total = Math.floor(ms / 1000);
    var h = Math.floor(total / 3600);
    var m = Math.floor((total % 3600) / 60);
    var s = total % 60;
    if (h > 0) {
      return h + ":" + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
    }
    return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
  }

  function fmtDurationWords(ms) {
    if (!isFinite(ms) || ms < 0) ms = 0;
    if (ms >= 60000) {
      return Math.round(ms / 60000) + " " + t("units.min");
    }
    return Math.round(ms / 1000) + " " + t("units.s");
  }

  function fmtTime(iso) {
    try {
      return new Date(iso).toLocaleTimeString(
        state.lang === "zh" ? "zh-CN" : "en-US",
        { hour12: false }
      );
    } catch (err) {
      return iso;
    }
  }

  function fmtClock(ms) {
    if (!isFinite(ms) || ms < 0) ms = 0;
    var total = Math.floor(ms);
    var m = Math.floor(total / 60000);
    var s = Math.floor((total % 60000) / 1000);
    var milli = total % 1000;
    return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0") + "." + String(milli).padStart(3, "0");
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function formatError(err) {
    if (!err) return "unknown";
    if (typeof err === "string") return err;
    var name = err.name ? String(err.name) : "Error";
    var message = err.message ? String(err.message) : String(err);
    return name + ": " + message;
  }

  function serializeError(err) {
    if (!err) return { name: "Error", message: "unknown" };
    return {
      name: err.name ? String(err.name) : "Error",
      message: err.message ? String(err.message) : String(err),
      stack: err.stack ? String(err.stack).slice(0, 1200) : null,
      at: new Date().toISOString()
    };
  }

  function clearNode(el) {
    while (el && el.firstChild) el.removeChild(el.firstChild);
  }

  function setChildren(el, nodes) {
    if (!el) return;
    clearNode(el);
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i]) el.appendChild(nodes[i]);
    }
  }

  function showToast(text, ms) {
    if (!els.toast) return;
    els.toast.textContent = text;
    els.toast.hidden = false;
    if (state.toastTimer) clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(function () {
      els.toast.hidden = true;
      state.toastTimer = 0;
    }, ms || 3200);
  }

  function statusPill(text, kind) {
    var span = document.createElement("span");
    span.className = "status-pill " + (kind || "neutral");
    span.textContent = text;
    return span;
  }

  function pillWithText(text, kind, suffix) {
    var wrap = document.createElement("span");
    wrap.appendChild(statusPill(text, kind));
    if (suffix) {
      wrap.appendChild(document.createTextNode(" " + suffix));
    }
    return wrap;
  }

  function row(labelKey, value, options) {
    var opts = options || {};
    var node = document.createElement("div");
    node.className = "kv" + (opts.long ? " long" : "");
    var k = document.createElement("span");
    k.className = "k";
    k.textContent = t(labelKey);
    var v = document.createElement("span");
    v.className = "v";
    if (value instanceof Node) {
      v.appendChild(value);
    } else if (value === null || value === undefined || value === "") {
      v.textContent = "—";
    } else {
      v.textContent = String(value);
    }
    node.appendChild(k);
    node.appendChild(v);
    return node;
  }

  function renderRows(container, rows) {
    if (!container) return;
    var nodes = [];
    for (var i = 0; i < rows.length; i++) nodes.push(rows[i]);
    setChildren(container, nodes);
  }

  function boolText(value) {
    return value ? t("value.yes") : t("value.no");
  }

  function supportText(value) {
    return value ? t("value.supported") : t("value.unsupported");
  }

  function secureLabel() {
    if (!state.env || !state.env.secureContext) {
      return { text: t("secure.bad"), kind: "bad" };
    }
    if (window.location.protocol === "https:") {
      return { text: t("secure.ok"), kind: "ok" };
    }
    return { text: t("secure.local"), kind: "ok" };
  }

  function safeLocalGet(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (err) {
      return null;
    }
  }

  function safeLocalSet(key, value) {
    try {
      window.localStorage.setItem(key, value);
      return true;
    } catch (err) {
      return false;
    }
  }

  function safeLocalRemove(key) {
    try {
      window.localStorage.removeItem(key);
    } catch (err) {
      /* ignore */
    }
  }

  function withTimeout(promise, ms, label) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        reject(new Error(label || "timeout"));
      }, ms);
      promise.then(
        function (value) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(value);
        },
        function (err) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          reject(err);
        }
      );
    });
  }

  /* ------------------------------------------------------------------ */
  /* i18n                                                               */
  /* ------------------------------------------------------------------ */

  function detectLang() {
    var params = new URLSearchParams(window.location.search);
    var q = params.get("lang");
    if (q === "zh" || q === "en") return q;
    var saved = safeLocalGet(LANG_KEY);
    if (saved === "zh" || saved === "en") return saved;
    var nav = (navigator.language || "").toLowerCase();
    return nav.indexOf("zh") === 0 ? "zh" : "en";
  }

  function applyI18n() {
    var nodes = document.querySelectorAll("[data-i18n]");
    for (var i = 0; i < nodes.length; i++) {
      var key = nodes[i].getAttribute("data-i18n");
      nodes[i].textContent = t(key);
    }
    var ariaNodes = document.querySelectorAll("[data-i18n-aria]");
    for (var j = 0; j < ariaNodes.length; j++) {
      ariaNodes[j].setAttribute("aria-label", t(ariaNodes[j].getAttribute("data-i18n-aria")));
    }
    document.documentElement.lang = state.lang === "zh" ? "zh-CN" : "en";
  }

  function updateLangButtons() {
    var buttons = document.querySelectorAll("[data-lang]");
    for (var i = 0; i < buttons.length; i++) {
      var lang = buttons[i].getAttribute("data-lang");
      buttons[i].setAttribute("aria-pressed", lang === state.lang ? "true" : "false");
    }
  }

  function setLang(lang) {
    if (lang !== "zh" && lang !== "en") return;
    state.lang = lang;
    safeLocalSet(LANG_KEY, lang);
    applyI18n();
    updateLangButtons();
    renderAll();
    log("language", t("log.language", { lang: lang === "zh" ? "中文" : "English" }));
  }

  /* ------------------------------------------------------------------ */
  /* Event log                                                          */
  /* ------------------------------------------------------------------ */

  function eventClass(type) {
    if (type.indexOf("error") !== -1 || type.indexOf("fail") !== -1) return "error";
    if (type.indexOf("gap") !== -1 || type.indexOf("warn") !== -1) return "warn";
    if (
      type === "play" ||
      type === "chime" ||
      type === "audio-state" ||
      type === "audio-context" ||
      type === "worklet-blob" ||
      type === "worklet-url" ||
      type === "worklet-ready" ||
      type === "node-ready"
    ) {
      return "audio";
    }
    return "";
  }

  function log(type, detail) {
    var entry = {
      type: type,
      detail: detail === undefined || detail === null ? "" : String(detail),
      wall: new Date().toISOString(),
      rel: window.performance && performance.now ? performance.now() : Date.now()
    };
    state.events.unshift(entry);
    if (state.events.length > MAX_EVENTS) state.events.length = MAX_EVENTS;
    renderEvents();
    if (state.report && !state.stability.running) {
      /* Keep the in-memory report roughly current without rebuilding on every log. */
      state.report.events = state.events.slice(0, MAX_EVENTS);
    }
  }

  function renderEvents() {
    if (!els.eventLog) return;
    if (state.events.length === 0) {
      var empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = t("events.empty");
      setChildren(els.eventLog, [empty]);
      return;
    }

    var count = Math.min(state.events.length, 200);
    var nodes = [];
    for (var i = 0; i < count; i++) {
      var ev = state.events[i];
      var node = document.createElement("div");
      node.className = "event";

      var time = document.createElement("time");
      time.textContent = fmtClock(ev.rel);

      var type = document.createElement("span");
      var cls = eventClass(ev.type);
      type.className = "type" + (cls ? " " + cls : "");
      type.textContent = ev.type;

      var detail = document.createElement("span");
      detail.className = "detail";
      detail.textContent = ev.detail;

      node.appendChild(time);
      node.appendChild(type);
      node.appendChild(detail);
      nodes.push(node);
    }
    setChildren(els.eventLog, nodes);
  }

  /* ------------------------------------------------------------------ */
  /* Environment / display detection                                    */
  /* ------------------------------------------------------------------ */

  function browserLabel() {
    var ua = navigator.userAgent || "";
    var brands = null;
    if (navigator.userAgentData && navigator.userAgentData.brands) {
      brands = navigator.userAgentData.brands;
    }
    if (brands && brands.length) {
      var real = [];
      for (var i = 0; i < brands.length; i++) {
        if (!/Not.?A.?Brand/i.test(brands[i].brand)) {
          real.push(brands[i].brand + " " + brands[i].version);
        }
      }
      if (real.length) return real.join(" · ");
    }
    var match = ua.match(/(Edg|Chrome|CriOS|Firefox|FxiOS|Version|Safari)\/([\d.]+)/);
    if (match) return match[1] + " " + match[2];
    return t("value.unknown");
  }

  function orientationLabel() {
    var viewportType =
      window.innerWidth > window.innerHeight
        ? "landscape"
        : window.innerWidth < window.innerHeight
        ? "portrait"
        : "square";
    var label = t("orientation." + viewportType);
    var apiType = null;
    if (window.screen && screen.orientation && screen.orientation.type) {
      apiType = screen.orientation.type;
    } else if (window.matchMedia) {
      apiType = window.matchMedia("(orientation: portrait)").matches
        ? "portrait-primary"
        : "landscape-primary";
    }
    var angle = null;
    if (window.screen && screen.orientation && typeof screen.orientation.angle === "number") {
      angle = screen.orientation.angle;
    } else if (typeof window.orientation === "number") {
      angle = window.orientation;
    }
    var suffix = "";
    if (angle !== null) suffix += " · " + angle + "°";
    if (apiType && viewportType !== "square" && apiType.indexOf(viewportType) === -1) {
      suffix += " · API " + apiType;
    }
    return label + suffix;
  }

  function collectStatic() {
    var uad = navigator.userAgentData || null;
    var he = state.uaHighEntropy || {};
    var conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection || null;
    var vv = window.visualViewport || null;
    var mqReduce =
      window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    var platform = navigator.platform || "";
    if (uad && uad.platform) platform = uad.platform;
    if (he.platformVersion) platform += " · " + he.platformVersion;

    state.env = {
      userAgent: navigator.userAgent || "",
      uaBrands: uad && uad.brands ? uad.brands : null,
      uaMobile: uad ? !!uad.mobile : null,
      uaHighEntropy: state.uaHighEntropy,
      platform: platform,
      vendor: navigator.vendor || "",
      browser: browserLabel(),
      model: he.model || null,
      architecture: he.architecture || null,
      bitness: he.bitness || null,
      fullVersionList: he.fullVersionList || null,
      language: navigator.language || "",
      languages: navigator.languages ? Array.prototype.slice.call(navigator.languages) : [],
      timezone: (function () {
        try {
          return Intl.DateTimeFormat().resolvedOptions().timeZone;
        } catch (err) {
          return null;
        }
      })(),
      online: navigator.onLine,
      connection: conn
        ? {
            effectiveType: conn.effectiveType || null,
            downlink: typeof conn.downlink === "number" ? conn.downlink : null,
            rtt: typeof conn.rtt === "number" ? conn.rtt : null,
            saveData: !!conn.saveData
          }
        : null,
      screen: {
        width: screen.width,
        height: screen.height,
        availWidth: screen.availWidth,
        availHeight: screen.availHeight,
        colorDepth: screen.colorDepth,
        pixelDepth: screen.pixelDepth,
        dpr: window.devicePixelRatio || 1,
        orientation: orientationLabel(),
        orientationApi:
          window.screen && screen.orientation && screen.orientation.type
            ? screen.orientation.type
            : null,
        orientationAngle:
          window.screen && screen.orientation && typeof screen.orientation.angle === "number"
            ? screen.orientation.angle
            : typeof window.orientation === "number"
            ? window.orientation
            : null
      },
      viewport: {
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        clientWidth: document.documentElement.clientWidth,
        clientHeight: document.documentElement.clientHeight,
        visualWidth: vv ? vv.width : null,
        visualHeight: vv ? vv.height : null,
        visualScale: vv ? vv.scale : null
      },
      hardwareConcurrency: navigator.hardwareConcurrency || null,
      deviceMemory: navigator.deviceMemory || null,
      secureContext: !!window.isSecureContext,
      crossOriginIsolated: !!window.crossOriginIsolated,
      reducedMotion: !!mqReduce,
      maxTouchPoints: navigator.maxTouchPoints || 0,
      protocol: window.location.protocol,
      url: window.location.href
    };
  }

  function detectDisplay() {
    var c2d = false;
    var canvas2d = document.createElement("canvas");
    try {
      c2d = !!canvas2d.getContext("2d");
    } catch (err) {
      c2d = false;
    }

    var webgl2 = false;
    var webgl = false;
    var renderer = null;
    var glCanvas = document.createElement("canvas");
    var gl = null;
    try {
      gl = glCanvas.getContext("webgl2");
      webgl2 = !!gl;
    } catch (err) {
      webgl2 = false;
    }
    if (!gl) {
      try {
        gl = glCanvas.getContext("webgl") || glCanvas.getContext("experimental-webgl");
        webgl = !!gl;
      } catch (err) {
        webgl = false;
      }
    } else {
      webgl = true;
    }

    if (gl) {
      try {
        var ext = gl.getExtension("WEBGL_debug_renderer_info");
        if (ext) {
          renderer =
            String(gl.getParameter(ext.UNMASKED_VENDOR_WEBGL)) +
            " / " +
            String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL));
        } else {
          renderer = String(gl.getParameter(gl.RENDERER));
        }
      } catch (err) {
        renderer = null;
      }
      try {
        var lose = gl.getExtension("WEBGL_lose_context");
        if (lose) lose.loseContext();
      } catch (err) {
        /* ignore */
      }
    }

    var fullscreenApi = !!(
      document.fullscreenEnabled ||
      document.webkitFullscreenEnabled ||
      document.documentElement.requestFullscreen ||
      document.documentElement.webkitRequestFullscreen
    );
    var wakeLockApi = !!(navigator.wakeLock && typeof navigator.wakeLock.request === "function");
    var orientationLock = !!(
      screen.orientation && typeof screen.orientation.lock === "function"
    );
    var coarse = false;
    try {
      coarse = window.matchMedia("(pointer: coarse)").matches;
    } catch (err) {
      coarse = false;
    }
    var dvh = false;
    try {
      dvh = !!(window.CSS && CSS.supports && CSS.supports("height", "100dvh"));
    } catch (err) {
      dvh = false;
    }

    var previous = state.display;
    state.display = {
      canvas2d: c2d,
      webgl: webgl,
      webgl2: webgl2,
      renderer: renderer,
      fullscreenApi: fullscreenApi,
      fullscreen: !!document.fullscreenElement,
      wakeLockApi: wakeLockApi,
      wakeLockActive: !!(previous.wakeLockSentinel && !previous.wakeLockSentinel.released),
      wakeLockWanted: previous.wakeLockWanted,
      wakeLockSentinel: previous.wakeLockSentinel,
      orientationLock: orientationLock,
      touchPoints: navigator.maxTouchPoints || 0,
      coarse: coarse,
      dvh: dvh,
      fps: previous.fps
    };
    if (!wakeLockApi) {
      state.display.wakeLockSentinel = null;
      state.display.wakeLockActive = false;
      state.display.wakeLockWanted = false;
    }
  }

  function collectAudioApi() {
    var AC = window.AudioContext || window.webkitAudioContext;
    state.audioApi = {
      audioContext: typeof AC === "function",
      webkitAudioContext: typeof window.webkitAudioContext === "function",
      audioWorklet:
        !!AC && !!AC.prototype && "audioWorklet" in AC.prototype && !!window.AudioWorkletNode,
      audioWorkletNode: typeof window.AudioWorkletNode === "function",
      offlineAudioContext:
        typeof window.OfflineAudioContext === "function" ||
        typeof window.webkitOfflineAudioContext === "function",
      scriptProcessor:
        !!AC && !!AC.prototype && typeof AC.prototype.createScriptProcessor === "function",
      audioSession: "audioSession" in navigator,
      mediaSession: "mediaSession" in navigator
    };

    var probe = document.createElement("audio");
    var map = {
      mp3: "audio/mpeg",
      wav: "audio/wav",
      ogg: 'audio/ogg; codecs="vorbis"',
      opus: 'audio/webm; codecs="opus"',
      aac: 'audio/mp4; codecs="mp4a.40.2"',
      flac: "audio/flac"
    };
    var codecs = {};
    for (var key in map) {
      if (!Object.prototype.hasOwnProperty.call(map, key)) continue;
      var value = "";
      try {
        value = probe.canPlayType(map[key]) || "";
      } catch (err) {
        value = "";
      }
      codecs[key] = value || "no";
    }
    state.codecs = codecs;
  }

  function collectContextInfo() {
    if (!state.ctx) {
      state.contextInfo = null;
      state.latency = { baseMs: null, outputMs: null, totalMs: null, rating: "unknown" };
      return;
    }
    var ctx = state.ctx;
    var base = typeof ctx.baseLatency === "number" ? ctx.baseLatency : null;
    var output = typeof ctx.outputLatency === "number" ? ctx.outputLatency : null;
    var total = null;
    if (base !== null || output !== null) {
      total = (base || 0) + (output || 0);
    }
    var rating = "unknown";
    if (total !== null) {
      var ms = total * 1000;
      if (ms < 30) rating = "good";
      else if (ms < 80) rating = "ok";
      else rating = "poor";
    }
    state.contextInfo = {
      state: ctx.state,
      sampleRate: ctx.sampleRate,
      baseLatency: base,
      outputLatency: output,
      latencyHint: ctx.latencyHint || null,
      maxChannelCount: ctx.destination.maxChannelCount || null,
      channelCount: ctx.destination.channelCount || null,
      channelCountMode: ctx.destination.channelCountMode || null
    };
    state.latency = {
      baseMs: base === null ? null : base * 1000,
      outputMs: output === null ? null : output * 1000,
      totalMs: total === null ? null : total * 1000,
      rating: rating
    };
  }

  async function collectHighEntropy() {
    var uad = navigator.userAgentData;
    if (!uad || typeof uad.getHighEntropyValues !== "function") return;
    try {
      var values = await withTimeout(
        uad.getHighEntropyValues([
          "architecture",
          "model",
          "platformVersion",
          "uaFullVersion",
          "fullVersionList",
          "bitness",
          "wow64"
        ]),
        2500,
        "UA high-entropy timeout"
      );
      state.uaHighEntropy = values;
      collectStatic();
      renderEnvironment();
    } catch (err) {
      log("high-entropy", t("log.highEntropy", { error: formatError(err) }));
    }
  }

  /* ------------------------------------------------------------------ */
  /* Renderers                                                          */
  /* ------------------------------------------------------------------ */

  function renderEnvironment() {
    var env = state.env || {};
    var screenInfo = env.screen || {};
    var viewport = env.viewport || {};
    var secure = secureLabel();
    var secureNode = pillWithText(secure.text, secure.kind);
    var connText = "—";
    if (env.connection) {
      connText =
        (env.connection.effectiveType || "?") +
        " · " +
        (env.connection.downlink === null ? "?" : env.connection.downlink) +
        " Mbps · RTT " +
        (env.connection.rtt === null ? "?" : env.connection.rtt) +
        " ms";
    }

    var rows = [
      row("env.browser", env.browser || "—"),
      row("env.platform", env.platform || "—"),
      row("env.model", env.model || "—"),
      row(
        "env.screen",
        screenInfo.width
          ? screenInfo.width +
              "×" +
              screenInfo.height +
              " · @" +
              screenInfo.dpr +
              "x · " +
              screenInfo.colorDepth +
              " bit"
          : "—"
      ),
      row(
        "env.viewport",
        viewport.innerWidth
          ? viewport.innerWidth +
              "×" +
              viewport.innerHeight +
              (viewport.visualWidth
                ? " · visual " + Math.round(viewport.visualWidth) + "×" + Math.round(viewport.visualHeight)
                : "")
          : "—"
      ),
      row("env.orientation", orientationLabel()),
      row("env.dpr", screenInfo.dpr ? screenInfo.dpr + "x" : "—"),
      row(
        "env.language",
        env.language
          ? env.language + (env.languages && env.languages.length ? " · " + env.languages.join(", ") : "")
          : "—"
      ),
      row("env.timezone", env.timezone || "—"),
      row("env.online", env.online === null || env.online === undefined ? "—" : boolText(env.online)),
      row("env.connection", connText),
      row("env.memory", env.deviceMemory ? env.deviceMemory + " " + t("units.gb") : "—"),
      row("env.cores", env.hardwareConcurrency || "—"),
      row("env.touch", env.maxTouchPoints === undefined ? "—" : String(env.maxTouchPoints)),
      row("env.secure", secureNode),
      row("env.isolated", env.crossOriginIsolated === undefined ? "—" : boolText(env.crossOriginIsolated)),
      row("env.reducedMotion", env.reducedMotion === undefined ? "—" : boolText(env.reducedMotion)),
      row("env.url", env.url || window.location.href, { long: true }),
      row("env.ua", env.userAgent || navigator.userAgent, { long: true })
    ];
    renderRows(els.envRows, rows);
  }

  function workletInfoNode(info) {
    if (!info || info.status === "notTested") {
      return pillWithText(t("value.notTested"), "neutral");
    }
    if (info.status === "loading") {
      return pillWithText(t("audio.workletLoading"), "warn");
    }
    if (info.status === "pass") {
      return pillWithText(t("value.pass"), "ok", info.ms === null ? "" : fmtMs(info.ms));
    }
    return pillWithText(t("value.fail"), "bad", info.error ? "· " + info.error : "");
  }

  function codecList() {
    var names = [];
    for (var key in state.codecs) {
      if (!Object.prototype.hasOwnProperty.call(state.codecs, key)) continue;
      if (state.codecs[key] !== "no") names.push(key);
    }
    return names.length ? names.join(" · ") : t("audio.codec.none");
  }

  function renderAudio() {
    var api = state.audioApi || {};
    var ctxInfo = state.contextInfo;
    var latency = state.latency;
    var apiText =
      "AudioContext " +
      supportText(api.audioContext) +
      " · Worklet " +
      supportText(api.audioWorklet) +
      " · Offline " +
      supportText(api.offlineAudioContext);

    var contextNode = null;
    if (ctxInfo) {
      var kind = ctxInfo.state === "running" ? "ok" : ctxInfo.state === "suspended" ? "warn" : "bad";
      contextNode = pillWithText(
        ctxInfo.state,
        kind,
        ctxInfo.sampleRate + " " + t("units.hz") + " · " + ctxInfo.channelCount + " ch"
      );
    }

    var latencyNode = null;
    if (latency.totalMs !== null) {
      var ratingKind =
        latency.rating === "good" ? "ok" : latency.rating === "ok" ? "warn" : "bad";
      latencyNode = pillWithText(
        t("audio.rating." + latency.rating),
        ratingKind,
        t("audio.latencyValue", {
          base: fmtMs(latency.baseMs, 1),
          output: fmtMs(latency.outputMs, 1),
          total: fmtMs(latency.totalMs, 1)
        })
      );
    }

    var rows = [
      row("audio.api", apiText),
      row("audio.context", contextNode || t("value.notTested")),
      row("audio.sampleRate", ctxInfo ? ctxInfo.sampleRate + " " + t("units.hz") : "—"),
      row("audio.baseLatency", fmtMs(latency.baseMs, 1)),
      row("audio.outputLatency", fmtMs(latency.outputMs, 1)),
      row("audio.latencyEstimate", latencyNode || t("value.notTested")),
      row(
        "audio.channels",
        ctxInfo
          ? String(ctxInfo.maxChannelCount) + " max / " + String(ctxInfo.channelCount) + " current"
          : "—"
      ),
      row("audio.workletBlob", workletInfoNode(state.worklet.blob)),
      row("audio.workletUrlTest", workletInfoNode(state.worklet.url)),
      row("audio.node", workletInfoNode(state.worklet.node)),
      row("audio.scriptProcessor", supportText(api.scriptProcessor)),
      row("audio.offline", supportText(api.offlineAudioContext)),
      row("audio.codecs", codecList()),
      row("audio.audioSession", supportText(api.audioSession)),
      row(
        "audio.heartbeat",
        state.heartbeat.count
          ? String(state.heartbeat.count) + " · " + fmtMs(state.heartbeat.lastGap, 0)
          : "—"
      ),
      row(
        "audio.lastMeter",
        state.heartbeat.count
          ? "RMS " +
              state.meter.rms.toFixed(3) +
              " · Peak " +
              state.meter.peak.toFixed(3) +
              " · " +
              Math.round(state.meter.rpm) +
              " " +
              t("units.rpm")
          : "—"
      )
    ];

    if (state.fallbackActive) {
      rows.push(row("audio.fallback", pillWithText(t("audio.fallbackActive"), "warn")));
    }

    renderRows(els.audioRows, rows);
    updateAudioStatus();
  }

  function renderDisplay() {
    var d = state.display;
    var fullscreenNode = pillWithText(
      d.fullscreenApi
        ? d.fullscreen
          ? t("display.fullscreenOn")
          : t("display.fullscreenOff")
        : t("value.unsupported"),
      d.fullscreenApi ? (d.fullscreen ? "ok" : "neutral") : "bad"
    );
    var wakeNode = pillWithText(
      d.wakeLockApi ? (d.wakeLockActive ? t("display.wakeLockOn") : t("display.wakeLockOff")) : t("value.unsupported"),
      d.wakeLockApi ? (d.wakeLockActive ? "ok" : "neutral") : "bad"
    );
    var fpsText = d.fps
      ? t("display.fpsResult", {
          avg: d.fps.avg.toFixed(1),
          min: d.fps.min.toFixed(1),
          frames: d.fps.frames
        })
      : t("display.fpsNotRun");

    var rows = [
      row("display.canvas2d", supportText(d.canvas2d)),
      row("display.webgl", supportText(d.webgl)),
      row("display.webgl2", supportText(d.webgl2)),
      row("display.renderer", d.renderer || "—", { long: true }),
      row("display.fullscreenApi", fullscreenNode),
      row("display.wakeLockApi", wakeNode),
      row("display.orientationLock", supportText(d.orientationLock)),
      row("display.touchPoints", String(d.touchPoints)),
      row("display.pointer", d.coarse ? t("display.pointerCoarse") : t("display.pointerFine")),
      row("display.dvh", supportText(d.dvh)),
      row("display.fps", fpsText)
    ];
    renderRows(els.displayRows, rows);

    if (els.fpsOut) els.fpsOut.textContent = fpsText;
    if (els.displayStatus) {
      els.displayStatus.textContent =
        t("display.fullscreenState") +
        ": " +
        (d.fullscreen ? t("display.fullscreenOn") : t("display.fullscreenOff")) +
        " · " +
        t("display.wakeLockState") +
        ": " +
        (d.wakeLockActive ? t("display.wakeLockOn") : t("display.wakeLockOff"));
    }
    if (els.fullscreenBtn) {
      els.fullscreenBtn.textContent = d.fullscreen
        ? t("display.exitFullscreen")
        : t("display.fullscreen");
    }
    if (els.wakeBtn) {
      els.wakeBtn.textContent = d.wakeLockActive
        ? t("display.releaseWakeLock")
        : t("display.wakeLock");
    }
  }

  function modeLabel(mode) {
    if (mode === "idle") return t("audio.statusIdle");
    var key = "audio.mode." + mode;
    var text = t(key);
    return text === key ? mode : text;
  }

  function updateAudioStatus() {
    if (!els.audioStatus) return;
    if (state.playing) {
      els.audioStatus.textContent = t("audio.nowPlaying", {
        mode: modeLabel(state.mode),
        rpm: Math.round(state.meter.rpm || state.rpm)
      });
    } else if (state.worklet.loaded) {
      els.audioStatus.textContent = t("audio.ready");
    } else if (state.ctx) {
      els.audioStatus.textContent = t("audio.tapToStart");
    } else {
      els.audioStatus.textContent = t("audio.noContext");
    }

    if (els.scopeState) {
      els.scopeState.textContent = state.playing
        ? modeLabel(state.mode) + " · LIVE"
        : t("audio.statusIdle");
    }
  }

  function renderHero() {
    var env = state.env;
    if (els.secureBadge) {
      var secure = secureLabel();
      els.secureBadge.textContent = secure.text;
      els.secureBadge.className = "pill " + secure.kind;
    }

    var statusText = t("status.idle");
    if (state.detecting) statusText = t("status.detecting");
    else if (state.detectError) statusText = t("status.error");
    else if (state.stability.running) statusText = t("status.testing");
    else if (state.started) statusText = t("status.ready");
    if (els.heroStatus) els.heroStatus.textContent = statusText;

    if (els.detectBtn) {
      els.detectBtn.disabled = state.detecting;
      els.detectBtn.textContent = state.detecting ? t("status.detecting") : t("hero.start");
    }

    if (els.heroLatency) {
      els.heroLatency.textContent =
        state.latency.totalMs === null ? "—" : fmtMs(state.latency.totalMs, 1);
      els.heroLatency.className =
        state.latency.rating === "good"
          ? "ok"
          : state.latency.rating === "ok"
          ? "warn"
          : state.latency.rating === "poor"
          ? "bad"
          : "";
    }
    if (els.heroRate) {
      els.heroRate.textContent = state.ctx ? state.ctx.sampleRate + " " + t("units.hz") : "—";
    }
    if (els.heroWorklet) {
      var nodeStatus = state.worklet.node.status;
      var blobStatus = state.worklet.blob.status;
      var urlStatus = state.worklet.url.status;
      if (nodeStatus === "pass") {
        els.heroWorklet.textContent = "OK";
        els.heroWorklet.className = "ok";
      } else if (nodeStatus === "fail" || (blobStatus === "fail" && urlStatus === "fail")) {
        els.heroWorklet.textContent = "FAIL";
        els.heroWorklet.className = "bad";
      } else {
        els.heroWorklet.textContent = "—";
        els.heroWorklet.className = "";
      }
    }
    if (els.panicBtn) {
      els.panicBtn.hidden = !(state.playing || state.stability.running);
    }
    updateAudioStatus();
  }

  function workletSummaryText(summary) {
    if (summary.verdict === "pass") {
      return t("stability.verdictPass", { duration: fmtDurationWords(summary.actualMs) });
    }
    if (summary.verdict === "warn") {
      return t("stability.verdictWarn", { reasons: summary.reasons.join("; ") });
    }
    return t("stability.verdictFail", { reasons: summary.reasons.join("; ") });
  }

  function renderStabilitySummary(summary) {
    if (!els.stabilitySummary) return;
    if (!summary) {
      els.stabilitySummary.hidden = true;
      els.stabilitySummary.className = "summary";
      clearNode(els.stabilitySummary);
      return;
    }
    els.stabilitySummary.hidden = false;
    els.stabilitySummary.className =
      "summary" + (summary.verdict === "warn" ? " warn" : summary.verdict === "fail" ? " bad" : "");

    var nodes = [];
    var title = document.createElement("strong");
    title.textContent = t("stability.summaryTitle");
    nodes.push(title);

    function line(label, value) {
      var p = document.createElement("p");
      p.style.margin = "6px 0 0";
      p.textContent = label + ": " + value;
      nodes.push(p);
    }

    line(
      t("stability.completed"),
      t("stability.durationValue", {
        actual: fmtDurationWords(summary.actualMs),
        target: fmtDurationWords(summary.requestedMs)
      })
    );
    line(t("stability.state"), summary.audioState || "—");
    line(t("stability.glitchMarks"), String(summary.marks));
    line(t("stability.stateChanges"), String(summary.stateChanges));
    line(t("stability.degraded"), boolText(summary.degraded));

    var verdict = document.createElement("p");
    verdict.style.margin = "9px 0 0";
    verdict.textContent = t("stability.verdict") + ": " + workletSummaryText(summary);
    nodes.push(verdict);

    setChildren(els.stabilitySummary, nodes);
  }

  function latestFps() {
    var samples = state.stability.fps.samples;
    if (samples && samples.length) return samples[samples.length - 1];
    if (state.display.fps) return state.display.fps.avg;
    return null;
  }

  function renderStability() {
    var s = state.stability;
    var running = s.running;
    var elapsed = 0;
    if (running) {
      elapsed = Math.min(performance.now() - s.startedAt, s.requestedMs);
    } else if (s.summary) {
      elapsed = s.summary.actualMs;
    }
    var total = s.requestedMs || 0;
    var progress = total > 0 ? Math.min(100, (elapsed / total) * 100) : 0;

    if (els.progressBar) els.progressBar.style.width = progress + "%";
    if (els.statElapsed) els.statElapsed.textContent = fmtDuration(elapsed);
    if (els.statState) els.statState.textContent = state.ctx ? state.ctx.state : "—";
    if (els.statHeartbeats) els.statHeartbeats.textContent = String(state.heartbeat.count);
    if (els.statMaxGap) {
      els.statMaxGap.textContent = state.heartbeat.maxGap
        ? fmtMs(state.heartbeat.maxGap, 0)
        : "—";
    }
    var fps = latestFps();
    if (els.statFps) els.statFps.textContent = fps === null ? "—" : Math.round(fps) + " " + t("units.fps");
    if (els.statMemory) {
      var memory = getMemoryMB();
      els.statMemory.textContent = memory === null ? "—" : memory.toFixed(1) + " " + t("units.mb");
    }

    if (els.markBtn) {
      els.markBtn.disabled = !running;
      els.markBtn.textContent =
        running && s.marks.length
          ? t("stability.mark") + " · " + s.marks.length
          : t("stability.mark");
    }
    if (els.stabilityBtn) els.stabilityBtn.disabled = running || state.detecting;
    if (els.stabilityStopBtn) els.stabilityStopBtn.disabled = !running;
    if (els.durSelect) els.durSelect.disabled = running;

    renderStabilitySummary(s.summary);
  }

  function renderReport() {
    if (!els.reportJson) return;
    if (state.report) {
      els.reportJson.textContent = JSON.stringify(state.report, null, 2);
    } else {
      els.reportJson.textContent = t("report.empty");
    }

    if (els.savedHint) {
      if (state.savedReport) {
        var key = state.savedReport.partial ? "report.savedPartial" : "report.saved";
        els.savedHint.textContent = t(key, {
          time: fmtTime(state.savedReport.savedAt)
        });
      } else {
        els.savedHint.textContent = t("report.none");
      }
    }
    if (els.loadSavedBtn) {
      els.loadSavedBtn.hidden = !state.savedReport;
    }
  }

  function renderAll() {
    renderHero();
    renderEnvironment();
    renderAudio();
    renderDisplay();
    renderStability();
    renderReport();
    renderEvents();
    updateControlState();
  }

  function updateControlState() {
    var busy = state.stability.running;
    if (els.rpmRange) els.rpmRange.disabled = !state.started || busy;
    var testButtons = [els.engineBtn, els.revBtn, els.sineBtn, els.leftBtn, els.rightBtn, els.clickBtn];
    for (var i = 0; i < testButtons.length; i++) {
      if (testButtons[i]) testButtons[i].disabled = busy;
    }
    if (els.stopBtn) els.stopBtn.disabled = busy || !state.playing;
    if (els.urlTestBtn) els.urlTestBtn.disabled = busy;
    if (els.chimeBtn) els.chimeBtn.disabled = busy;
    if (els.fullscreenBtn) els.fullscreenBtn.disabled = !state.display.fullscreenApi;
    if (els.wakeBtn) els.wakeBtn.disabled = !state.display.wakeLockApi;
    if (els.fpsBtn) els.fpsBtn.disabled = state.detecting;
    if (els.detectBtn) els.detectBtn.disabled = state.detecting;
    if (els.resetBtn) els.resetBtn.disabled = state.detecting || busy;
  }

  /* ------------------------------------------------------------------ */
  /* Audio graph / Worklet                                              */
  /* ------------------------------------------------------------------ */

  async function ensureAudio() {
    if (state.ctx) {
      if (state.ctx.state !== "running") {
        try {
          await state.ctx.resume();
        } catch (err) {
          log("error", t("log.error", { error: formatError(err) }));
        }
      }
      if (!state.worklet.loaded && !state.worklet.attempted) {
        await loadWorklet();
      }
      collectContextInfo();
      renderAudio();
      renderHero();
      return state.ctx;
    }

    var AC = window.AudioContext || window.webkitAudioContext;
    if (typeof AC !== "function") {
      throw new Error("AudioContext is not supported");
    }

    var ctx = null;
    try {
      ctx = new AC({ latencyHint: "interactive" });
    } catch (err) {
      ctx = new AC();
    }
    state.ctx = ctx;
    ctx.onstatechange = onAudioStateChange;

    var master = ctx.createGain();
    master.gain.value = state.volume * 0.6;

    var comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 12;
    comp.ratio.value = 8;
    comp.attack.value = 0.003;
    comp.release.value = 0.25;

    var analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.75;

    master.connect(comp);
    comp.connect(analyser);
    analyser.connect(ctx.destination);

    state.master = master;
    state.comp = comp;
    state.analyser = analyser;

    collectStatic();
    collectAudioApi();
    collectContextInfo();
    log("audio-context", t("log.audioContext", {
      state: ctx.state,
      rate: ctx.sampleRate
    }));

    var resumePromise = null;
    try {
      resumePromise = ctx.resume();
    } catch (err) {
      log("error", t("log.error", { error: formatError(err) }));
    }

    await loadWorklet();
    if (resumePromise) {
      try {
        await resumePromise;
      } catch (err) {
        log("error", t("log.error", { error: formatError(err) }));
      }
    }

    collectContextInfo();
    renderAudio();
    renderHero();
    return ctx;
  }

  function onAudioStateChange() {
    if (!state.ctx) return;
    var current = state.ctx.state;
    log("audio-state", t("log.audioState", { state: current }));
    if (state.stability.running) {
      state.stability.stateChanges += 1;
      if (current !== "running" && document.visibilityState === "visible") {
        setTimeout(function () {
          if (
            state.ctx &&
            state.ctx.state !== "running" &&
            state.stability.running
          ) {
            state.ctx.resume().catch(function (err) {
              log("error", t("log.error", { error: formatError(err) }));
            });
          }
        }, 300);
      }
    }
    collectContextInfo();
    renderAudio();
    renderHero();
    renderStability();
  }

  async function loadWorklet() {
    if (state.worklet.loaded || state.worklet.attempted) return;
    state.worklet.attempted = true;

    var ctx = state.ctx;
    if (!ctx || !ctx.audioWorklet) {
      state.worklet.blob = {
        status: "fail",
        ms: 0,
        error: "AudioWorklet not supported"
      };
      state.worklet.url = {
        status: "fail",
        ms: 0,
        error: "AudioWorklet not supported",
        url: null
      };
      state.worklet.node = {
        status: "fail",
        ms: 0,
        error: "AudioWorklet not supported"
      };
      state.worklet.loaded = false;
      log("no-worklet", t("log.noWorklet"));
      renderAudio();
      renderHero();
      updateControlState();
      return;
    }

    var source = document.getElementById("worklet-source");
    var code = source ? source.textContent : "";
    if (!code) {
      state.worklet.blob = { status: "fail", ms: 0, error: "empty worklet source" };
      state.worklet.node = { status: "fail", ms: 0, error: "empty worklet source" };
      state.worklet.loaded = false;
      renderAudio();
      return;
    }

    var registered = false;
    var start = performance.now();
    state.worklet.blob = { status: "loading", ms: null, error: null };
    renderAudio();

    var blobUrl = null;
    try {
      var blob = new Blob([code], { type: "application/javascript" });
      blobUrl = URL.createObjectURL(blob);
      await withTimeout(ctx.audioWorklet.addModule(blobUrl), 8000, "Blob Worklet load timeout");
      registered = true;
      var blobMs = performance.now() - start;
      state.worklet.blob = { status: "pass", ms: blobMs, error: null };
      log("worklet-blob", t("log.workletBlob", { status: t("value.pass"), ms: Math.round(blobMs) }));
    } catch (err) {
      var blobError = formatError(err);
      state.worklet.blob = {
        status: "fail",
        ms: performance.now() - start,
        error: blobError
      };
      log("worklet-blob", t("log.workletBlob", { status: t("value.fail"), ms: Math.round(performance.now() - start) }));
      log("error", t("log.error", { error: blobError }));
    } finally {
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    }

    if (!registered) {
      var url = null;
      var urlStart = performance.now();
      try {
        url = new URL("worklet.js", window.location.href).href;
        await withTimeout(ctx.audioWorklet.addModule(url), 8000, "URL Worklet load timeout");
        registered = true;
        state.worklet.url = {
          status: "pass",
          ms: performance.now() - urlStart,
          error: null,
          url: url
        };
        log("worklet-url", t("log.workletUrl", { status: t("value.pass"), ms: Math.round(performance.now() - urlStart) }));
      } catch (err) {
        state.worklet.url = {
          status: "fail",
          ms: performance.now() - urlStart,
          error: formatError(err),
          url: url
        };
        log("worklet-url", t("log.workletUrl", { status: t("value.fail"), ms: Math.round(performance.now() - urlStart) }));
      }
    }

    if (!registered) {
      state.worklet.node = { status: "fail", ms: 0, error: "Could not register processor" };
      state.worklet.loaded = false;
      showToast(t("toast.workletFail"));
      renderAudio();
      renderHero();
      updateControlState();
      return;
    }

    var nodeStart = performance.now();
    var node = null;
    var nodeError = null;
    var optionSets = [
      {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        channelCount: 2,
        channelCountMode: "explicit"
      },
      { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] },
      {}
    ];
    for (var i = 0; i < optionSets.length; i++) {
      try {
        node = new AudioWorkletNode(ctx, "engine-probe", optionSets[i]);
        break;
      } catch (err) {
        nodeError = err;
        node = null;
      }
    }

    if (!node) {
      state.worklet.node = {
        status: "fail",
        ms: performance.now() - nodeStart,
        error: formatError(nodeError)
      };
      state.worklet.loaded = false;
      log("error", t("log.error", { error: formatError(nodeError) }));
      showToast(t("toast.workletFail"));
      renderAudio();
      renderHero();
      updateControlState();
      return;
    }

    node.port.onmessage = onWorkletMessage;
    node.onprocessorerror = function (event) {
      var message = event && event.message ? event.message : "processor error";
      log("error", t("log.error", { error: message }));
      state.errors.push({ name: "AudioWorkletError", message: String(message), at: new Date().toISOString() });
    };
    node.connect(state.master);
    node.port.postMessage({ type: "config", load: 0.35 });

    state.workletNode = node;
    state.worklet.node = {
      status: "pass",
      ms: performance.now() - nodeStart,
      error: null
    };
    state.worklet.loaded = true;
    log("node-ready", t("log.nodeReady"));
    renderAudio();
    renderHero();
    updateControlState();
  }

  function onWorkletMessage(event) {
    var msg = event.data;
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "ready") {
      state.worklet.processorReady = true;
      log("worklet-ready", t("log.workletReady"));
      renderAudio();
      if (state.started && !state.stability.running) saveReport(false, true);
      return;
    }

    if (msg.type === "meter") {
      var now = performance.now();
      if (state.heartbeat.lastAt) {
        var gap = now - state.heartbeat.lastAt;
        state.heartbeat.lastGap = gap;
        if (gap > state.heartbeat.maxGap) state.heartbeat.maxGap = gap;
        if (state.stability.running && gap > state.stability.maxGap) {
          state.stability.maxGap = gap;
        }
        if (gap > 500 && now - state.heartbeat.lastGapLogAt > 3000) {
          state.heartbeat.lastGapLogAt = now;
          log("heartbeat-gap", t("log.heartbeatGap", { ms: Math.round(gap) }));
        }
      }
      state.heartbeat.lastAt = now;
      state.heartbeat.count += 1;
      state.meter = {
        rms: typeof msg.rms === "number" ? msg.rms : 0,
        peak: typeof msg.peak === "number" ? msg.peak : 0,
        rpm: typeof msg.rpm === "number" ? msg.rpm : 0,
        at: now
      };
      if (now - state.lastMeterRender > 250) {
        state.lastMeterRender = now;
        updateAudioStatus();
        if (els.statHeartbeats) els.statHeartbeats.textContent = String(state.heartbeat.count);
        if (els.statMaxGap) {
          els.statMaxGap.textContent = state.heartbeat.maxGap
            ? fmtMs(state.heartbeat.maxGap, 0)
            : "—";
        }
        if (els.statState) els.statState.textContent = state.ctx ? state.ctx.state : "—";
      }
      if (now - state.lastAudioRender > 1000) {
        state.lastAudioRender = now;
        renderAudio();
      }
      return;
    }

    if (msg.type === "click") {
      if (els.flash) {
        els.flash.className = "flash on";
        setTimeout(function () {
          if (els.flash) els.flash.className = "flash";
        }, 80);
      }
      return;
    }

    if (msg.type === "error") {
      var text = msg.error ? String(msg.error) : "worklet error";
      state.errors.push({ name: "WorkletError", message: text, at: new Date().toISOString() });
      log("error", t("log.error", { error: text }));
      return;
    }
  }

  async function testWorkletUrl(silent) {
    if (!state.ctx) {
      try {
        await ensureAudio();
      } catch (err) {
        if (!silent) showToast(t("status.error"));
        return;
      }
    }
    if (!state.ctx || !state.ctx.audioWorklet) {
      state.worklet.url = {
        status: "fail",
        ms: 0,
        error: "AudioWorklet not supported",
        url: null
      };
      renderAudio();
      return;
    }
    if (state.worklet.url.status === "pass") {
      renderAudio();
      return;
    }

    if (!silent) {
      log("url-test", t("log.urlTest"));
      showToast(t("toast.urlTesting"), 1800);
    }

    var AC = window.AudioContext || window.webkitAudioContext;
    var temp = null;
    var start = performance.now();
    var url = null;
    try {
      url = new URL("worklet.js", window.location.href).href;
      temp = new AC({ latencyHint: "interactive" });
      await withTimeout(temp.audioWorklet.addModule(url), 6000, "URL Worklet load timeout");
      state.worklet.url = {
        status: "pass",
        ms: performance.now() - start,
        error: null,
        url: url
      };
      log("worklet-url", t("log.workletUrl", { status: t("value.pass"), ms: Math.round(performance.now() - start) }));
      if (!silent) {
        showToast(t("toast.urlOk", { ms: fmtMs(performance.now() - start, 0) }));
      }
    } catch (err) {
      state.worklet.url = {
        status: "fail",
        ms: performance.now() - start,
        error: formatError(err),
        url: url
      };
      log("worklet-url", t("log.workletUrl", { status: t("value.fail"), ms: Math.round(performance.now() - start) }));
      if (!silent) {
        showToast(t("toast.urlFail", { error: formatError(err) }));
      }
    } finally {
      if (temp) {
        try {
          await temp.close();
        } catch (err) {
          /* ignore */
        }
      }
      renderAudio();
      renderHero();
      if (state.started && !state.stability.running) saveReport(false, true);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Playback                                                           */
  /* ------------------------------------------------------------------ */

  function stopRevTimers() {
    for (var i = 0; i < state.revTimers.length; i++) clearTimeout(state.revTimers[i]);
    state.revTimers = [];
  }

  function startAutoRev() {
    stopRevTimers();
    var seq = [900, 1500, 2800, 4400, 5600, 4200, 2200, 900];
    for (var i = 0; i < seq.length; i++) {
      (function (rpm, index) {
        var timer = setTimeout(function () {
          if (state.playing) setRpm(rpm);
        }, 600 + index * 550);
        state.revTimers.push(timer);
      })(seq[i], i);
    }
    log("auto-rev", t("log.autoRev"));
  }

  async function playMode(mode) {
    try {
      await ensureAudio();
    } catch (err) {
      state.errors.push(serializeError(err));
      log("error", t("log.error", { error: formatError(err) }));
      showToast(t("status.error"));
      return false;
    }

    stopRevTimers();
    var workletMode = mode === "rev" ? "engine" : mode;
    state.mode = mode;
    state.audioTests[mode] = true;

    if (state.worklet.loaded && state.workletNode) {
      stopFallback();
      renderAudio();
      state.workletNode.port.postMessage({
        type: "start",
        mode: workletMode,
        gain: 0.8,
        rpm: state.rpm
      });
      state.playing = true;
      log("play", t("log.play", { mode: modeLabel(mode) }));
      updateAudioStatus();
      startScope();
      renderHero();
      updateControlState();
      if (state.started && !state.stability.running) saveReport(false, true);
      return true;
    }

    startFallback(workletMode);
    state.playing = true;
    log("fallback", t("log.fallback", { mode: modeLabel(mode) }));
    showToast(t("toast.workletFail"));
    updateAudioStatus();
    startScope();
    renderHero();
    updateControlState();
    if (state.started && !state.stability.running) saveReport(false, true);
    return true;
  }

  function stopFallback() {
    var fallback = state.fallback;
    if (!fallback) {
      state.fallbackActive = false;
      return;
    }
    if (fallback.clickTimer) clearInterval(fallback.clickTimer);
    if (fallback.osc) {
      var now = state.ctx ? state.ctx.currentTime : 0;
      try {
        fallback.gain.gain.cancelScheduledValues(now);
        fallback.gain.gain.setTargetAtTime(0.0001, now, 0.02);
      } catch (err) {
        /* ignore */
      }
      var osc = fallback.osc;
      var gain = fallback.gain;
      var filter = fallback.filter;
      var panner = fallback.panner;
      setTimeout(function () {
        try {
          osc.stop();
        } catch (err) {
          /* ignore */
        }
        try {
          osc.disconnect();
          gain.disconnect();
          if (filter) filter.disconnect();
          if (panner) panner.disconnect();
        } catch (err) {
          /* ignore */
        }
      }, 120);
    }
    state.fallback = null;
    state.fallbackActive = false;
  }

  function startFallback(mode) {
    stopFallback();
    if (!state.ctx || !state.master) return;

    if (mode === "click") {
      var timer = setInterval(function () {
        if (!state.ctx || state.ctx.state !== "running") return;
        var now = state.ctx.currentTime;
        var osc = state.ctx.createOscillator();
        var gain = state.ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = 1800;
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(0.18, now + 0.004);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.035);
        osc.connect(gain);
        gain.connect(state.master);
        osc.start(now);
        osc.stop(now + 0.04);
      }, 500);
      state.fallback = { clickTimer: timer, mode: mode };
      state.fallbackActive = true;
      renderAudio();
      return;
    }

    var ctx = state.ctx;
    var now = ctx.currentTime;
    var osc = ctx.createOscillator();
    var filter = ctx.createBiquadFilter();
    var gain = ctx.createGain();
    var panner = null;

    osc.type = mode === "engine" ? "sawtooth" : "sine";
    var freq = mode === "engine" ? Math.max(20, (state.rpm / 60) * 2) : 440;
    osc.frequency.setValueAtTime(freq, now);
    filter.type = "lowpass";
    filter.frequency.value = mode === "engine" ? 1800 : 8000;
    filter.Q.value = 0.8;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.16, now + 0.06);

    osc.connect(filter);
    filter.connect(gain);
    if (ctx.createStereoPanner && (mode === "left" || mode === "right")) {
      panner = ctx.createStereoPanner();
      panner.pan.value = mode === "left" ? -1 : 1;
      gain.connect(panner);
      panner.connect(state.master);
    } else {
      gain.connect(state.master);
    }
    osc.start(now);

    state.fallback = {
      osc: osc,
      filter: filter,
      gain: gain,
      panner: panner,
      mode: mode,
      clickTimer: 0
    };
    state.fallbackActive = true;
    renderAudio();
  }

  function setRpm(value) {
    var rpm = clamp(Number(value) || 0, 800, 6500);
    state.rpm = rpm;
    if (els.rpmOut) els.rpmOut.textContent = Math.round(rpm) + " " + t("units.rpm");
    if (els.rpmRange && Math.abs(Number(els.rpmRange.value) - rpm) > 20) {
      els.rpmRange.value = String(Math.round(rpm));
    }
    if (state.worklet.loaded && state.workletNode) {
      state.workletNode.port.postMessage({ type: "rpm", rpm: rpm });
    }
    if (state.fallback && state.fallback.osc && state.fallback.mode === "engine" && state.ctx) {
      var freq = Math.max(20, (rpm / 60) * 2);
      state.fallback.osc.frequency.setTargetAtTime(freq, state.ctx.currentTime, 0.03);
      if (state.fallback.filter) {
        state.fallback.filter.frequency.setTargetAtTime(
          Math.min(6000, 800 + rpm * 0.5),
          state.ctx.currentTime,
          0.05
        );
      }
    }
  }

  function setVolume(value) {
    var volume = clamp(Number(value) || 0, 0, 1);
    state.volume = volume;
    if (els.volOut) els.volOut.textContent = Math.round(volume * 100) + " " + t("units.percent");
    if (state.master && state.ctx) {
      state.master.gain.setTargetAtTime(volume * 0.6, state.ctx.currentTime, 0.03);
    }
  }

  async function playChime() {
    try {
      await ensureAudio();
    } catch (err) {
      return;
    }
    if (!state.ctx || !state.master || state.ctx.state !== "running") return;

    var ctx = state.ctx;
    var t0 = ctx.currentTime + 0.03;
    var notes = [
      { freq: 660, start: 0, dur: 0.16, peak: 0.16 },
      { freq: 880, start: 0.18, dur: 0.26, peak: 0.14 }
    ];
    for (var i = 0; i < notes.length; i++) {
      (function (note) {
        var osc = ctx.createOscillator();
        var gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = note.freq;
        var start = t0 + note.start;
        var end = start + note.dur;
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(note.peak, start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, end);
        osc.connect(gain);
        gain.connect(state.master);
        osc.start(start);
        osc.stop(end + 0.02);
      })(notes[i]);
    }
    state.audioTests.chime = true;
    log("chime", t("log.chime"));
  }

  function startScope() {
    if (state.scopeActive) return;
    state.scopeActive = true;
    if (!state.scopeBuf) state.scopeBuf = new Float32Array(2048);
    drawScopeLoop();
  }

  function drawScopeLoop() {
    if (!state.scopeActive) return;
    drawScope();
    state.scopeRaf = requestAnimationFrame(drawScopeLoop);
  }

  function drawScope() {
    var canvas = els.scope;
    if (!canvas) return;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var width = canvas.clientWidth;
    var height = canvas.clientHeight;
    if (!width || !height) return;
    var pixelWidth = Math.round(width * dpr);
    var pixelHeight = Math.round(height * dpr);
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }
    var c = canvas.getContext("2d");
    if (!c) return;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, width, height);

    c.strokeStyle = "rgba(255,255,255,0.08)";
    c.lineWidth = 1;
    for (var x = 0; x <= width; x += width / 8) {
      c.beginPath();
      c.moveTo(x, 0);
      c.lineTo(x, height);
      c.stroke();
    }
    for (var y = 0; y <= height; y += height / 4) {
      c.beginPath();
      c.moveTo(0, y);
      c.lineTo(width, y);
      c.stroke();
    }

    var data = state.scopeBuf;
    var hasSignal = false;
    if (state.analyser && state.playing) {
      try {
        state.analyser.getFloatTimeDomainData(data);
        hasSignal = true;
      } catch (err) {
        hasSignal = false;
      }
    }

    c.beginPath();
    if (hasSignal) {
      for (var i = 0; i < data.length; i++) {
        var px = (i / (data.length - 1)) * width;
        var py = height / 2 - data[i] * height * 0.42;
        if (i === 0) c.moveTo(px, py);
        else c.lineTo(px, py);
      }
      c.strokeStyle = "#ff6a2a";
      c.lineWidth = 2;
      c.shadowBlur = 10;
      c.shadowColor = "rgba(255,90,31,0.55)";
    } else {
      c.moveTo(0, height / 2);
      c.lineTo(width, height / 2);
      c.strokeStyle = "rgba(145,164,184,0.35)";
      c.lineWidth = 1.5;
      c.shadowBlur = 0;
    }
    c.stroke();
    c.shadowBlur = 0;
  }

  function drawScopeIdle() {
    state.scopeActive = false;
    if (state.scopeRaf) cancelAnimationFrame(state.scopeRaf);
    state.scopeRaf = 0;
    drawScope();
  }

  function stopAudio(skipLog) {
    stopRevTimers();
    var wasPlaying = state.playing;
    if (state.workletNode) {
      state.workletNode.port.postMessage({ type: "stop" });
    }
    stopFallback();
    state.playing = false;
    state.mode = "idle";
    state.scopeActive = false;
    if (state.scopeRaf) cancelAnimationFrame(state.scopeRaf);
    state.scopeRaf = 0;
    drawScope();
    renderAudio();
    renderHero();
    updateControlState();
    if (wasPlaying && !skipLog) log("stop", t("log.stop"));
  }

  async function switchMode(mode) {
    if (state.stability.running) return;
    var ok = await playMode(mode);
    if (!ok) return;
    if (mode === "rev") startAutoRev();
  }

  /* ------------------------------------------------------------------ */
  /* Stability test                                                     */
  /* ------------------------------------------------------------------ */

  function getMemoryMB() {
    try {
      if (window.performance && performance.memory && performance.memory.usedJSHeapSize) {
        return performance.memory.usedJSHeapSize / (1024 * 1024);
      }
    } catch (err) {
      /* ignore */
    }
    return null;
  }

  function startFpsSampler() {
    var s = state.stability;
    s.fps = {
      samples: [],
      frames: 0,
      lastAt: performance.now(),
      worstFrameMs: 0,
      raf: 0
    };
    function tick(now) {
      if (!s.running) return;
      s.fps.frames += 1;
      var dt = now - s.fps.lastAt;
      if (dt > s.fps.worstFrameMs) s.fps.worstFrameMs = dt;
      if (dt >= 1000) {
        var fps = (s.fps.frames * 1000) / dt;
        s.fps.samples.push(fps);
        s.fps.frames = 0;
        s.fps.lastAt = now;
        if (s.fps.samples.length > 3600) s.fps.samples.shift();
      }
      s.fps.raf = requestAnimationFrame(tick);
    }
    s.fps.raf = requestAnimationFrame(tick);
  }

  function stopFpsSampler() {
    if (state.stability.fps.raf) cancelAnimationFrame(state.stability.fps.raf);
    state.stability.fps.raf = 0;
  }

  function clearStabilityTimers() {
    var timers = state.stability.timers;
    if (timers.end) clearTimeout(timers.end);
    if (timers.ui) clearInterval(timers.ui);
    if (timers.rpm) clearInterval(timers.rpm);
    if (timers.save) clearInterval(timers.save);
    state.stability.timers = { end: 0, ui: 0, rpm: 0, save: 0 };
  }

  async function startStability() {
    if (state.stability.running || state.detecting) return;
    if (!state.started) {
      showToast(t("toast.needTap"));
      return;
    }

    try {
      await ensureAudio();
    } catch (err) {
      state.errors.push(serializeError(err));
      log("error", t("log.error", { error: formatError(err) }));
      showToast(t("status.error"));
      return;
    }

    if (state.ctx && state.ctx.state !== "running") {
      try {
        await state.ctx.resume();
      } catch (err) {
        log("error", t("log.error", { error: formatError(err) }));
      }
    }

    var minutes = Number(els.durSelect ? els.durSelect.value : 10) || 10;
    var requestedMs = minutes * 60000;
    var now = performance.now();

    state.heartbeat.maxGap = 0;
    state.heartbeat.lastAt = now;
    state.heartbeat.count = 0;
    state.heartbeat.lastGap = 0;

    state.stability = {
      running: true,
      requestedMs: requestedMs,
      startedAt: now,
      endsAt: now + requestedMs,
      actualMs: 0,
      completed: false,
      early: false,
      verdict: "notRun",
      reasons: [],
      summary: null,
      marks: [],
      stateChanges: 0,
      maxGap: 0,
      degraded: !state.worklet.loaded,
      fps: { samples: [], frames: 0, lastAt: 0, worstFrameMs: 0, raf: 0 },
      memoryStart: getMemoryMB(),
      memoryEnd: null,
      heartbeatCount: 0,
      audioState: state.ctx ? state.ctx.state : null,
      timers: { end: 0, ui: 0, rpm: 0, save: 0 }
    };

    state.stability.timers.end = setTimeout(function () {
      finishStability(false);
    }, requestedMs);
    state.stability.timers.ui = setInterval(updateStabilityUI, 250);
    state.stability.timers.rpm = setInterval(function () {
      if (!state.stability.running) return;
      var elapsed = performance.now() - state.stability.startedAt;
      var rpm = 900 + (0.5 - 0.5 * Math.cos(elapsed / 3000)) * 3800;
      setRpm(Math.round(rpm / 10) * 10);
    }, 200);
    state.stability.timers.save = setInterval(function () {
      saveReport(true, true);
    }, 5000);

    startFpsSampler();
    var ok = await playMode("engine");
    if (!ok) {
      finishStability(true);
      return;
    }

    log("stability-start", t("log.stabilityStart", {
      duration: minutes + " " + t("units.min")
    }));
    showToast(t("stability.started", { duration: minutes + " " + t("units.min") }), 2600);
    renderStability();
    renderHero();
    updateControlState();
  }

  function finishStability(early) {
    var s = state.stability;
    if (!s.running) return;
    s.running = false;
    clearStabilityTimers();
    stopFpsSampler();
    stopAudio(true);

    var endedAt = performance.now();
    s.actualMs = Math.min(Math.max(0, endedAt - s.startedAt), s.requestedMs);
    s.early = !!early || s.actualMs < s.requestedMs - 1000;
    s.completed = !s.early;
    s.audioState = state.ctx ? state.ctx.state : "none";
    s.memoryEnd = getMemoryMB();
    s.heartbeatCount = state.heartbeat.count;
    s.maxGap = state.heartbeat.maxGap;

    var marks = s.marks.length;
    var reasons = [];
    if (s.early) reasons.push(t("stability.reasonEarly"));
    if (s.audioState !== "running") {
      reasons.push(t("stability.reasonSuspended", { state: s.audioState }));
    }
    if (marks > 0) reasons.push(t("stability.reasonMarks", { n: marks }));
    if (s.maxGap > 500) reasons.push(t("stability.reasonGap", { ms: Math.round(s.maxGap) }));
    if (s.degraded) reasons.push(t("stability.reasonDegraded"));
    if (!s.degraded && s.heartbeatCount === 0) {
      reasons.push(t("stability.reasonNoHeartbeat"));
    }
    if (s.stateChanges > 0) {
      reasons.push(t("stability.reasonStateChanges", { n: s.stateChanges }));
    }

    var verdict = "pass";
    if (
      s.audioState !== "running" ||
      marks > 0 ||
      (!s.degraded && s.heartbeatCount === 0)
    ) {
      verdict = "fail";
    } else if (reasons.length) {
      verdict = "warn";
    }

    var samples = s.fps.samples;
    var avg = null;
    var min = null;
    if (samples.length) {
      var sum = 0;
      var worst = 0;
      for (var i = 0; i < samples.length; i++) {
        sum += samples[i];
        if (samples[i] < worst || i === 0) worst = samples[i];
      }
      avg = sum / samples.length;
      min = worst;
    } else if (s.fps.worstFrameMs > 0) {
      min = 1000 / s.fps.worstFrameMs;
      avg = min;
    }

    s.verdict = verdict;
    s.reasons = reasons;
    s.summary = {
      verdict: verdict,
      requestedMs: s.requestedMs,
      actualMs: s.actualMs,
      completed: s.completed,
      early: s.early,
      audioState: s.audioState,
      marks: marks,
      stateChanges: s.stateChanges,
      maxGapMs: s.maxGap,
      degraded: s.degraded,
      reasons: reasons,
      fps: { avg: avg, min: min, samples: samples.length },
      memoryStart: s.memoryStart,
      memoryEnd: s.memoryEnd,
      heartbeatCount: s.heartbeatCount
    };

    log("stability-end", t("log.stabilityEnd", {
      verdict: workletSummaryText(s.summary)
    }));
    if (verdict === "pass") showToast(t("stability.verdictPass", { duration: fmtDurationWords(s.actualMs) }));
    else if (verdict === "warn") showToast(t("stability.verdictWarn", { reasons: reasons.join("; ") }), 5000);
    else showToast(t("stability.verdictFail", { reasons: reasons.join("; ") }), 5000);

    renderStability();
    renderHero();
    renderAudio();
    updateControlState();
    saveReport(false);
  }

  function updateStabilityUI() {
    var s = state.stability;
    if (!s.running) return;
    var elapsed = performance.now() - s.startedAt;
    if (elapsed >= s.requestedMs + 1500) {
      finishStability(false);
      return;
    }
    renderStability();
  }

  function markGlitch() {
    var s = state.stability;
    if (!s.running) return;
    var at = performance.now() - s.startedAt;
    s.marks.push({ at: at, wall: new Date().toISOString() });
    log("mark", t("log.mark", { time: fmtDuration(at) }));
    showToast(t("toast.marked", { time: fmtDuration(at) }), 2200);
    renderStability();
  }

  /* ------------------------------------------------------------------ */
  /* Fullscreen / wake lock / FPS                                       */
  /* ------------------------------------------------------------------ */

  async function toggleFullscreen() {
    try {
      if (!document.fullscreenElement) {
        var el = document.documentElement;
        if (el.requestFullscreen) await el.requestFullscreen();
        else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
        else throw new Error("Fullscreen is not supported");
        showToast(t("toast.fullscreen"));
      } else {
        if (document.exitFullscreen) await document.exitFullscreen();
        else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
      }
    } catch (err) {
      showToast(t("toast.fullscreenFail", { error: formatError(err) }));
      log("error", t("log.error", { error: formatError(err) }));
    }
    state.display.fullscreen = !!document.fullscreenElement;
    renderDisplay();
    updateControlState();
  }

  async function requestWakeLock(silent) {
    if (!navigator.wakeLock || typeof navigator.wakeLock.request !== "function") {
      if (!silent) showToast(t("toast.wakeFail", { error: "Wake Lock unsupported" }));
      return;
    }
    try {
      var sentinel = await navigator.wakeLock.request("screen");
      state.display.wakeLockSentinel = sentinel;
      state.display.wakeLockActive = true;
      state.display.wakeLockWanted = true;
      sentinel.addEventListener("release", function () {
        state.display.wakeLockActive = false;
        state.display.wakeLockSentinel = null;
        log("wake-lock", t("log.wakeLock", { state: "released" }));
        renderDisplay();
        updateControlState();
      });
      if (!silent) showToast(t("toast.wakeOn"));
      log("wake-lock", t("log.wakeLock", { state: "on" }));
    } catch (err) {
      state.display.wakeLockWanted = false;
      if (!silent) showToast(t("toast.wakeFail", { error: formatError(err) }));
      log("error", t("log.error", { error: formatError(err) }));
    }
    renderDisplay();
    updateControlState();
  }

  async function releaseWakeLock(silent) {
    state.display.wakeLockWanted = false;
    var sentinel = state.display.wakeLockSentinel;
    if (sentinel) {
      try {
        await sentinel.release();
      } catch (err) {
        /* ignore */
      }
    }
    state.display.wakeLockSentinel = null;
    state.display.wakeLockActive = false;
    if (!silent) showToast(t("toast.wakeOff"));
    log("wake-lock", t("log.wakeLock", { state: "off" }));
    renderDisplay();
    updateControlState();
  }

  function toggleWakeLock() {
    if (state.display.wakeLockActive) releaseWakeLock(false);
    else requestWakeLock(false);
  }

  function measureFps(duration) {
    var ms = duration || 3000;
    return new Promise(function (resolve) {
      var frames = 0;
      var start = 0;
      var last = 0;
      var worstFrameMs = 0;
      function step(now) {
        if (!start) {
          start = now;
          last = now;
          requestAnimationFrame(step);
          return;
        }
        var dt = now - last;
        last = now;
        frames += 1;
        if (dt > worstFrameMs) worstFrameMs = dt;
        if (now - start < ms) {
          requestAnimationFrame(step);
        } else {
          var elapsed = now - start;
          resolve({
            avg: (frames * 1000) / elapsed,
            min: worstFrameMs > 0 ? 1000 / worstFrameMs : 0,
            frames: frames,
            elapsed: elapsed
          });
        }
      }
      requestAnimationFrame(step);
    });
  }

  async function runFpsTest() {
    if (!els.fpsBtn) return;
    els.fpsBtn.disabled = true;
    if (els.fpsOut) els.fpsOut.textContent = t("status.detecting");
    var result = await measureFps(3000);
    state.display.fps = result;
    if (els.fpsOut) {
      els.fpsOut.textContent = t("display.fpsResult", {
        avg: result.avg.toFixed(1),
        min: result.min.toFixed(1),
        frames: result.frames
      });
    }
    log("fps", t("log.fps", {
      avg: result.avg.toFixed(1),
      min: result.min.toFixed(1)
    }));
    renderDisplay();
    renderStability();
    els.fpsBtn.disabled = false;
    saveReport(false);
  }

  /* ------------------------------------------------------------------ */
  /* Report                                                             */
  /* ------------------------------------------------------------------ */

  function buildReport(partial) {
    collectContextInfo();
    var environment = {};
    for (var key in state.env) {
      if (Object.prototype.hasOwnProperty.call(state.env, key)) {
        environment[key] = state.env[key];
      }
    }
    var display = {};
    for (var dkey in state.display) {
      if (!Object.prototype.hasOwnProperty.call(state.display, dkey)) continue;
      if (dkey === "wakeLockSentinel") continue;
      display[dkey] = state.display[dkey];
    }
    display.fullscreen = !!document.fullscreenElement;
    display.wakeLockActive = !!(
      state.display.wakeLockSentinel && !state.display.wakeLockSentinel.released
    );

    var stabilityRunning = state.stability.running;
    var stabilityElapsed = stabilityRunning
      ? Math.min(
          Math.max(0, performance.now() - state.stability.startedAt),
          state.stability.requestedMs
        )
      : state.stability.actualMs;
    var stability = {
      running: stabilityRunning,
      requestedMs: state.stability.requestedMs,
      actualMs: stabilityElapsed,
      completed: state.stability.completed,
      early: state.stability.early,
      verdict: state.stability.verdict,
      reasons: state.stability.reasons,
      summary: state.stability.summary,
      marks: state.stability.marks,
      stateChanges: state.stability.stateChanges,
      maxGapMs: stabilityRunning ? state.heartbeat.maxGap : state.stability.maxGap,
      degraded: state.stability.degraded,
      heartbeatCount: stabilityRunning ? state.heartbeat.count : state.stability.heartbeatCount,
      audioState:
        stabilityRunning && state.ctx ? state.ctx.state : state.stability.audioState,
      fps: state.stability.summary ? state.stability.summary.fps : null,
      memoryStart: state.stability.memoryStart,
      memoryEnd: state.stability.memoryEnd
    };

    return {
      schema: "nioengine.p0/1",
      partial: !!partial,
      generatedAt: new Date().toISOString(),
      locale: state.lang,
      url: window.location.href,
      build: BUILD,
      environment: environment,
      audio: {
        api: state.audioApi,
        context: state.contextInfo,
        latency: state.latency,
        worklet: {
          blob: state.worklet.blob,
          url: state.worklet.url,
          node: state.worklet.node,
          loaded: state.worklet.loaded,
          processorReady: state.worklet.processorReady
        },
        codecs: state.codecs,
        heartbeat: {
          count: state.heartbeat.count,
          lastGapMs: state.heartbeat.lastGap,
          maxGapMs: state.heartbeat.maxGap
        },
        lastMeter: state.meter,
        fallbackActive: state.fallbackActive,
        tests: state.audioTests
      },
      display: display,
      stability: stability,
      events: state.events.slice(0, MAX_EVENTS),
      errors: state.errors.slice(0, 50),
      notes: {
        noVehicleSignals: true,
        browserCannotMeasureAcousticLatency: true,
        reportedLatencyOnly: true
      }
    };
  }

  function saveReport(partial, silent) {
    if (!state.started && !state.detecting && !state.stability.running) return;
    var report = buildReport(!!partial);
    state.report = report;
    var savedAt = new Date().toISOString();
    var ok = safeLocalSet(
      REPORT_KEY,
      JSON.stringify({ savedAt: savedAt, partial: !!partial, report: report })
    );
    if (ok) {
      state.savedReport = { savedAt: savedAt, partial: !!partial, report: report };
    }
    if (!partial) {
      if (!silent) log("saved", t("log.saved"));
      renderReport();
      renderStability();
    }
  }

  function loadSavedMeta() {
    var raw = safeLocalGet(REPORT_KEY);
    if (!raw) return;
    try {
      var parsed = JSON.parse(raw);
      if (parsed && parsed.report && parsed.report.schema === "nioengine.p0/1") {
        state.savedReport = parsed;
      }
    } catch (err) {
      /* ignore corrupt storage */
    }
  }

  function loadSavedReport() {
    if (!state.savedReport) {
      showToast(t("toast.noReport"));
      return;
    }
    state.report = state.savedReport.report;
    renderReport();
    log("load-saved", t("log.loadSaved"));
    showToast(t("toast.savedLoaded"));
  }

  async function copyReport() {
    if (!state.report) {
      showToast(t("toast.noReport"));
      return;
    }
    var text = JSON.stringify(state.report, null, 2);
    var copied = false;
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        copied = true;
      } catch (err) {
        copied = false;
      }
    }
    if (!copied) {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      ta.style.top = "0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      try {
        copied = document.execCommand("copy");
      } catch (err) {
        copied = false;
      }
      document.body.removeChild(ta);
    }
    showToast(copied ? t("report.copyOk") : t("report.copyFail"), 4200);
  }

  function downloadReport() {
    if (!state.report) {
      showToast(t("toast.noReport"));
      return;
    }
    var text = JSON.stringify(state.report, null, 2);
    var blob = new Blob([text], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    var stamp = new Date().toISOString().replace(/[:.]/g, "-");
    a.href = url;
    a.download = t("report.fileName") + "-" + stamp + ".json";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 1000);
    showToast(t("report.downloadOk"));
  }

  function clearData() {
    if (state.stability.running) finishStability(true);
    stopAudio(true);
    safeLocalRemove(REPORT_KEY);
    state.savedReport = null;
    state.report = null;
    state.events = [];
    state.errors = [];
    state.audioTests = {};
    state.started = false;
    state.detectError = false;
    state.heartbeat.count = 0;
    state.heartbeat.maxGap = 0;
    state.heartbeat.lastGap = 0;
    state.stability.summary = null;
    state.stability.verdict = "notRun";
    state.stability.reasons = [];
    state.stability.marks = [];
    state.stability.requestedMs = 0;
    state.stability.actualMs = 0;
    state.stability.completed = false;
    state.stability.early = false;
    state.stability.stateChanges = 0;
    state.stability.maxGap = 0;
    state.stability.degraded = false;
    state.stability.audioState = null;
    state.stability.heartbeatCount = 0;
    state.stability.memoryStart = null;
    state.stability.memoryEnd = null;
    state.stability.fps = { samples: [], frames: 0, lastAt: 0, worstFrameMs: 0, raf: 0 };
    renderAll();
    log("clear", t("log.clear"));
    showToast(t("toast.cleared"));
  }

  /* ------------------------------------------------------------------ */
  /* Detection flow                                                     */
  /* ------------------------------------------------------------------ */

  async function runDetection() {
    if (state.detecting) return;
    state.detecting = true;
    state.detectError = false;
    renderHero();
    updateControlState();
    log("detect-start", t("log.detectStart"));
    var startedAt = performance.now();

    try {
      collectStatic();
      collectAudioApi();
      detectDisplay();
      renderAll();
      await collectHighEntropy();
      await ensureAudio();
      collectContextInfo();
      renderAll();
      await playChime();
      state.started = true;
      // Do not block the probe on the second AudioContext used for the
      // same-origin URL test. Some car browsers throttle a second context.
      testWorkletUrl(true);
      log("detect-done", t("log.detectDone", {
        ms: Math.round(performance.now() - startedAt)
      }));
      showToast(t("toast.detected"), 4200);
    } catch (err) {
      state.detectError = true;
      state.started = true;
      state.errors.push(serializeError(err));
      log("error", t("log.detectionError", { error: formatError(err) }));
      showToast(t("status.error"), 4200);
    } finally {
      state.detecting = false;
      collectContextInfo();
      renderAll();
      saveReport(false);
      updateControlState();
    }
  }

  /* ------------------------------------------------------------------ */
  /* Init                                                               */
  /* ------------------------------------------------------------------ */

  function cacheElements() {
    els = {
      detectBtn: byId("detectBtn"),
      resetBtn: byId("resetBtn"),
      heroStatus: byId("heroStatus"),
      secureBadge: byId("secureBadge"),
      scope: byId("scope"),
      scopeState: byId("scopeState"),
      heroLatency: byId("heroLatency"),
      heroRate: byId("heroRate"),
      heroWorklet: byId("heroWorklet"),
      envRows: byId("envRows"),
      audioRows: byId("audioRows"),
      displayRows: byId("displayRows"),
      rpmRange: byId("rpmRange"),
      rpmOut: byId("rpmOut"),
      volRange: byId("volRange"),
      volOut: byId("volOut"),
      engineBtn: byId("engineBtn"),
      revBtn: byId("revBtn"),
      sineBtn: byId("sineBtn"),
      leftBtn: byId("leftBtn"),
      rightBtn: byId("rightBtn"),
      clickBtn: byId("clickBtn"),
      stopBtn: byId("stopBtn"),
      audioStatus: byId("audioStatus"),
      urlTestBtn: byId("urlTestBtn"),
      chimeBtn: byId("chimeBtn"),
      fpsBtn: byId("fpsBtn"),
      fpsOut: byId("fpsOut"),
      fullscreenBtn: byId("fullscreenBtn"),
      wakeBtn: byId("wakeBtn"),
      displayStatus: byId("displayStatus"),
      durSelect: byId("durSelect"),
      stabilityBtn: byId("stabilityBtn"),
      stabilityStopBtn: byId("stabilityStopBtn"),
      progressBar: byId("progressBar"),
      statElapsed: byId("statElapsed"),
      statState: byId("statState"),
      statHeartbeats: byId("statHeartbeats"),
      statMaxGap: byId("statMaxGap"),
      statFps: byId("statFps"),
      statMemory: byId("statMemory"),
      markBtn: byId("markBtn"),
      stabilitySummary: byId("stabilitySummary"),
      copyBtn: byId("copyBtn"),
      downloadBtn: byId("downloadBtn"),
      loadSavedBtn: byId("loadSavedBtn"),
      clearBtn: byId("clearBtn"),
      savedHint: byId("savedHint"),
      reportJson: byId("reportJson"),
      clearLogBtn: byId("clearLogBtn"),
      eventLog: byId("eventLog"),
      panicBtn: byId("panicBtn"),
      toast: byId("toast"),
      flash: byId("flash"),
      buildInfo: byId("buildInfo")
    };
  }

  function setupEventListeners() {
    if (els.detectBtn) {
      els.detectBtn.addEventListener("click", function () {
        runDetection();
      });
    }
    if (els.resetBtn) {
      els.resetBtn.addEventListener("click", function () {
        if (state.started) saveReport(false, true);
        window.location.reload();
      });
    }
    if (els.engineBtn) els.engineBtn.addEventListener("click", function () { switchMode("engine"); });
    if (els.revBtn) els.revBtn.addEventListener("click", function () { switchMode("rev"); });
    if (els.sineBtn) els.sineBtn.addEventListener("click", function () { switchMode("sine"); });
    if (els.leftBtn) els.leftBtn.addEventListener("click", function () { switchMode("left"); });
    if (els.rightBtn) els.rightBtn.addEventListener("click", function () { switchMode("right"); });
    if (els.clickBtn) els.clickBtn.addEventListener("click", function () { switchMode("click"); });
    if (els.stopBtn) els.stopBtn.addEventListener("click", function () { stopAudio(false); });
    if (els.chimeBtn) els.chimeBtn.addEventListener("click", function () { playChime(); });
    if (els.urlTestBtn) {
      els.urlTestBtn.addEventListener("click", function () {
        testWorkletUrl(false);
      });
    }
    if (els.rpmRange) {
      els.rpmRange.addEventListener("input", function () {
        setRpm(Number(els.rpmRange.value));
      });
    }
    if (els.volRange) {
      els.volRange.addEventListener("input", function () {
        setVolume(Number(els.volRange.value) / 100);
      });
      els.volRange.addEventListener("change", function () {
        safeLocalSet(VOLUME_KEY, String(state.volume));
      });
    }
    if (els.stabilityBtn) {
      els.stabilityBtn.addEventListener("click", function () {
        startStability();
      });
    }
    if (els.stabilityStopBtn) {
      els.stabilityStopBtn.addEventListener("click", function () {
        finishStability(true);
      });
    }
    if (els.markBtn) {
      els.markBtn.addEventListener("click", markGlitch);
    }
    if (els.fpsBtn) {
      els.fpsBtn.addEventListener("click", function () {
        runFpsTest();
      });
    }
    if (els.fullscreenBtn) {
      els.fullscreenBtn.addEventListener("click", function () {
        toggleFullscreen();
      });
    }
    if (els.wakeBtn) {
      els.wakeBtn.addEventListener("click", function () {
        toggleWakeLock();
      });
    }
    if (els.copyBtn) els.copyBtn.addEventListener("click", function () { copyReport(); });
    if (els.downloadBtn) els.downloadBtn.addEventListener("click", downloadReport);
    if (els.loadSavedBtn) els.loadSavedBtn.addEventListener("click", loadSavedReport);
    if (els.clearBtn) els.clearBtn.addEventListener("click", clearData);
    if (els.clearLogBtn) {
      els.clearLogBtn.addEventListener("click", function () {
        state.events = [];
        renderEvents();
        showToast(t("events.cleared"));
      });
    }
    if (els.panicBtn) {
      els.panicBtn.addEventListener("click", function () {
        if (state.stability.running) finishStability(true);
        else stopAudio(false);
      });
    }

    var langButtons = document.querySelectorAll("[data-lang]");
    for (var i = 0; i < langButtons.length; i++) {
      (function (button) {
        button.addEventListener("click", function () {
          setLang(button.getAttribute("data-lang"));
        });
      })(langButtons[i]);
    }

    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape") {
        if (state.stability.running) finishStability(true);
        else stopAudio(false);
      }
    });

    document.addEventListener("visibilitychange", function () {
      log("visibility", t("log.visibility", { state: document.visibilityState }));
      if (document.visibilityState === "visible") {
        if (state.ctx && state.ctx.state === "suspended" && state.playing) {
          state.ctx.resume().catch(function (err) {
            log("error", t("log.error", { error: formatError(err) }));
          });
        }
        if (state.display.wakeLockWanted && state.display.wakeLockApi && !state.display.wakeLockSentinel) {
          requestWakeLock(true);
        }
        if (state.stability.running) updateStabilityUI();
      } else if (state.stability.running) {
        saveReport(true, true);
      }
    });

    window.addEventListener("focus", function () { log("focus", t("log.focus")); });
    window.addEventListener("blur", function () { log("blur", t("log.blur")); });
    window.addEventListener("online", function () { log("online", "online"); });
    window.addEventListener("offline", function () { log("offline", "offline"); });

    window.addEventListener("orientationchange", function () {
      log("orientation", t("log.orientation", { state: orientationLabel() }));
      collectStatic();
      renderEnvironment();
      setTimeout(function () {
        if (state.playing) {
          startScope();
          drawScope();
        } else {
          drawScopeIdle();
        }
      }, 120);
    });
    if (window.screen && screen.orientation && screen.orientation.addEventListener) {
      screen.orientation.addEventListener("change", function () {
        log("orientation", t("log.orientation", { state: orientationLabel() }));
        collectStatic();
        renderEnvironment();
      });
    }
    window.addEventListener("resize", function () {
      if (state.resizeTimer) clearTimeout(state.resizeTimer);
      state.resizeTimer = setTimeout(function () {
        collectStatic();
        renderEnvironment();
        if (state.scopeActive) drawScope();
        else drawScopeIdle();
        log("resize", t("log.resize", {
          w: window.innerWidth,
          h: window.innerHeight
        }));
      }, 300);
    });
    document.addEventListener("fullscreenchange", function () {
      state.display.fullscreen = !!document.fullscreenElement;
      log("fullscreen", t("log.fullscreen", {
        state: state.display.fullscreen ? t("display.fullscreenOn") : t("display.fullscreenOff")
      }));
      renderDisplay();
      updateControlState();
    });

    window.addEventListener("error", function (event) {
      var message = event && event.message ? event.message : "unknown error";
      state.errors.push({
        name: "WindowError",
        message: String(message),
        at: new Date().toISOString()
      });
      log("error", t("log.error", { error: message }));
    });
    window.addEventListener("unhandledrejection", function (event) {
      var reason = event && event.reason ? formatError(event.reason) : "unhandled rejection";
      state.errors.push({
        name: "UnhandledRejection",
        message: reason,
        at: new Date().toISOString()
      });
      log("error", t("log.error", { error: reason }));
    });

    window.addEventListener("pagehide", function () {
      if (state.stability.running) saveReport(true, true);
    });
    window.addEventListener("beforeunload", function () {
      if (state.stability.running) saveReport(true, true);
    });
  }

  function restoreVolume() {
    var saved = safeLocalGet(VOLUME_KEY);
    if (saved !== null) {
      var value = Number(saved);
      if (isFinite(value) && value >= 0 && value <= 1) state.volume = value;
    }
    if (els.volRange) els.volRange.value = String(Math.round(state.volume * 100));
    if (els.volOut) els.volOut.textContent = Math.round(state.volume * 100) + " " + t("units.percent");
  }

  function init() {
    cacheElements();
    state.lang = detectLang();
    applyI18n();
    updateLangButtons();

    if (els.buildInfo) {
      var time = BUILD.time ? " · " + BUILD.time : "";
      els.buildInfo.textContent = BUILD.version + time;
    }

    collectStatic();
    collectAudioApi();
    detectDisplay();
    restoreVolume();
    setupEventListeners();

    if (els.rpmOut) els.rpmOut.textContent = Math.round(state.rpm) + " " + t("units.rpm");
    if (els.rpmRange) els.rpmRange.value = String(state.rpm);
    if (els.durSelect) els.durSelect.value = "10";

    loadSavedMeta();
    renderAll();
    updateAudioStatus();
    requestAnimationFrame(drawScopeIdle);

    log("page-load", t("log.pageLoad") + " · " + (navigator.userAgent || ""));

    window.__P0__ = {
      state: state,
      runDetection: runDetection,
      buildReport: buildReport,
      playMode: playMode,
      stopAudio: stopAudio,
      testWorkletUrl: testWorkletUrl,
      startStability: startStability,
      finishStability: finishStability,
      setRpm: setRpm,
      setVolume: setVolume
    };

    var params = new URLSearchParams(window.location.search);
    var autorun = params.get("autorun");
    if (autorun) {
      state.autorun = true;
      document.documentElement.setAttribute("data-autorun", "running");
      setTimeout(async function () {
        try {
          await runDetection();
          if (autorun === "full") {
            await playMode("engine");
            setTimeout(function () {
              stopAudio(true);
              state.report = buildReport(false);
              var pre = document.createElement("pre");
              pre.id = "autorun-json";
              pre.style.display = "none";
              pre.textContent = JSON.stringify(state.report, null, 2);
              document.body.appendChild(pre);
              document.documentElement.setAttribute("data-autorun", "ready");
              document.title = "P0 READY";
            }, 2500);
          } else {
            document.documentElement.setAttribute("data-autorun", "ready");
            document.title = "P0 DETECTED";
          }
        } catch (err) {
          document.documentElement.setAttribute("data-autorun", "error");
          document.title = "P0 ERROR";
          var pre = document.createElement("pre");
          pre.id = "autorun-error";
          pre.textContent = formatError(err);
          document.body.appendChild(pre);
        }
      }, 120);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
