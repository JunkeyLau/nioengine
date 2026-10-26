/* Engine Sound Lab — P2.0 sensor probe.
   No uploads. All samples stay in this tab unless the user exports them. */
(function () {
  "use strict";

  var I18N = window.P2_I18N || { zh: {}, en: {} };
  var BUILD = window.P2_BUILD || { version: "0.1.0", time: "" };
  var LANG_KEY = "nioengine.sensors.lang";
  var MAX_GEO = 3000;
  var MAX_MOTION = 30000;
  var MAX_ORIENT = 6000;
  var MOTION_SAMPLE_MS = 40;
  var ORIENT_SAMPLE_MS = 100;

  var state = {
    lang: "zh",
    secure: false,
    geo: {
      supported: false,
      watching: false,
      watchId: null,
      permission: "unknown",
      count: 0,
      lastFixAt: 0,
      lastWall: 0,
      intervalMs: null,
      speedMps: null,
      gpsSpeedMps: null,
      derivedMps: null,
      accuracy: null,
      heading: null,
      error: null,
      lastPos: null,
      firstLogged: false
    },
    motion: {
      supported: false,
      listening: false,
      permission: "unknown",
      count: 0,
      lastAt: 0,
      lastWall: 0,
      intervalMs: null,
      rateHz: 0,
      rateStart: 0,
      rateCount: 0,
      accel: null,
      accelG: null,
      rotation: null,
      gravity: null,
      error: null,
      lastSampleAt: 0
    },
    orient: {
      supported: false,
      listening: false,
      permission: "unknown",
      count: 0,
      lastAt: 0,
      lastWall: 0,
      alpha: null,
      beta: null,
      gamma: null,
      absolute: null,
      lastSampleAt: 0
    },
    generic: {
      support: {
        accelerometer: false,
        linear: false,
        gyroscope: false,
        absolute: false,
        relative: false
      },
      active: {},
      last: {},
      errors: {}
    },
    permissions: {
      geolocation: "unknown",
      accelerometer: "unknown",
      gyroscope: "unknown",
      magnetometer: "unknown"
    },
    permissionStatuses: {},
    samples: { geo: [], motion: [], orient: [] },
    record: {
      active: false,
      start: 0,
      duration: 0,
      startedAt: null
    },
    events: [],
    mock: false,
    toastTimer: 0,
    uiTimer: 0,
    chartTimer: 0
  };

  var els = {};

  /* ------------------------------------------------------------------ */
  /* Helpers                                                            */
  /* ------------------------------------------------------------------ */

  function byId(id) { return document.getElementById(id); }

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

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function setText(el, text) {
    if (el && el.textContent !== String(text)) el.textContent = String(text);
  }

  function fmtNum(value, digits) {
    if (value === null || value === undefined || !isFinite(value)) return "—";
    return Number(value).toFixed(digits);
  }

  function fmtMs(value) {
    if (value === null || value === undefined || !isFinite(value)) return "—";
    return Math.round(value) + " " + t("value.ms");
  }

  function fmtDuration(ms) {
    if (!isFinite(ms) || ms < 0) ms = 0;
    var total = Math.floor(ms / 1000);
    var m = Math.floor(total / 60);
    var s = total % 60;
    return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
  }

  function fmtTime(ms) {
    if (!ms) return "—";
    try {
      return new Date(ms).toLocaleTimeString(state.lang === "zh" ? "zh-CN" : "en-US", { hour12: false });
    } catch (err) {
      return "—";
    }
  }

  function fmtSpeed(mps) {
    if (mps === null || mps === undefined || !isFinite(mps)) return "—";
    return (mps * 3.6).toFixed(1) + " " + t("value.kmh");
  }

  function fmtMps(mps) {
    if (mps === null || mps === undefined || !isFinite(mps)) return "—";
    return mps.toFixed(2) + " " + t("value.mps2");
  }

  function fmtDeg(value) {
    if (value === null || value === undefined || !isFinite(value)) return "—";
    return Number(value).toFixed(1) + t("value.deg");
  }

  function permissionText(p) {
    var key = "permission." + p;
    var text = t(key);
    return text === key ? t("permission.unknown") : text;
  }

  function permissionKind(p) {
    if (p === "granted") return "ok";
    if (p === "denied") return "bad";
    if (p === "prompt") return "warn";
    return "neutral";
  }

  function permissionPill(p) {
    return pill(permissionText(p), permissionKind(p));
  }

  function pill(text, kind) {
    var span = document.createElement("span");
    span.className = "pill " + (kind || "neutral");
    span.textContent = text;
    return span;
  }

  function boolPill(value) {
    return pill(value ? t("value.yes") : t("value.no"), value ? "ok" : "bad");
  }

  function row(labelKey, value) {
    var node = document.createElement("div");
    node.className = "kv";
    var k = document.createElement("span");
    k.className = "k";
    k.textContent = t(labelKey);
    var v = document.createElement("span");
    v.className = "v";
    if (value instanceof Node) v.appendChild(value);
    else if (value === null || value === undefined || value === "") v.textContent = "—";
    else v.textContent = String(value);
    node.appendChild(k);
    node.appendChild(v);
    return node;
  }

  function renderRows(container, rows) {
    if (!container) return;
    while (container.firstChild) container.removeChild(container.firstChild);
    for (var i = 0; i < rows.length; i++) container.appendChild(rows[i]);
  }

  function showToast(text, duration) {
    if (!els.toast) return;
    els.toast.textContent = text;
    els.toast.hidden = false;
    if (state.toastTimer) clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(function () {
      els.toast.hidden = true;
      state.toastTimer = 0;
    }, duration || 3000);
  }

  function copyText(text, okMessage, failMessage) {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(
        function () { showToast(okMessage); },
        function () { fallbackCopy(text, okMessage, failMessage); }
      );
      return;
    }
    fallbackCopy(text, okMessage, failMessage);
  }

  function fallbackCopy(text, okMessage, failMessage) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    ta.style.top = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    var copied = false;
    try { copied = document.execCommand("copy"); } catch (err) { copied = false; }
    document.body.removeChild(ta);
    showToast(copied ? okMessage : failMessage, copied ? 2200 : 3800);
  }

  /* ------------------------------------------------------------------ */
  /* Event log                                                          */
  /* ------------------------------------------------------------------ */

  function log(type, detail) {
    var entry = {
      type: type,
      detail: detail === undefined || detail === null ? "" : String(detail),
      wall: new Date().toISOString(),
      rel: performance.now()
    };
    state.events.unshift(entry);
    if (state.events.length > 250) state.events.length = 250;
    renderLog();
  }

  function renderLog() {
    if (!els.log) return;
    if (state.events.length === 0) {
      var empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = t("log.empty");
      els.log.replaceChildren(empty);
      return;
    }
    var count = Math.min(state.events.length, 200);
    var nodes = [];
    for (var i = 0; i < count; i++) {
      var ev = state.events[i];
      var item = document.createElement("div");
      item.className = "log-item";

      var time = document.createElement("time");
      time.textContent = fmtDuration(ev.rel) + "." + String(Math.floor(ev.rel % 1000)).padStart(3, "0");

      var type = document.createElement("span");
      var cls = "";
      var lowerType = ev.type.toLowerCase();
      if (lowerType.indexOf("error") !== -1 || lowerType.indexOf("denied") !== -1 || lowerType.indexOf("fail") !== -1) cls = "error";
      else if (lowerType.indexOf("permission") !== -1) cls = "warn";
      else if (lowerType.indexOf("start") !== -1 || lowerType.indexOf("first") !== -1) cls = "ok";
      type.className = "type" + (cls ? " " + cls : "");
      type.textContent = ev.type;

      var detail = document.createElement("span");
      detail.className = "detail";
      detail.textContent = ev.detail;

      item.appendChild(time);
      item.appendChild(type);
      item.appendChild(detail);
      nodes.push(item);
    }
    els.log.replaceChildren.apply(els.log, nodes);
  }

  /* ------------------------------------------------------------------ */
  /* Language                                                           */
  /* ------------------------------------------------------------------ */

  function detectLang() {
    var q = new URLSearchParams(window.location.search).get("lang");
    if (q === "zh" || q === "en") return q;
    try {
      var saved = localStorage.getItem(LANG_KEY);
      if (saved === "zh" || saved === "en") return saved;
    } catch (err) { /* ignore */ }
    return (navigator.language || "").toLowerCase().indexOf("zh") === 0 ? "zh" : "en";
  }

  function applyI18n() {
    var nodes = document.querySelectorAll("[data-i18n]");
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].textContent = t(nodes[i].getAttribute("data-i18n"));
    }
    document.documentElement.lang = state.lang === "zh" ? "zh-CN" : "en";
  }

  function updateLangButtons() {
    var buttons = document.querySelectorAll("[data-lang]");
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].setAttribute(
        "aria-pressed",
        buttons[i].getAttribute("data-lang") === state.lang ? "true" : "false"
      );
    }
  }

  function setLang(lang) {
    if (lang !== "zh" && lang !== "en") return;
    state.lang = lang;
    try { localStorage.setItem(LANG_KEY, lang); } catch (err) { /* ignore */ }
    applyI18n();
    updateLangButtons();
    if (els.toast) els.toast.hidden = true;
    updateUI();
    updateGenericActions();
    drawChart();
    log("language", t("log.language", { lang: lang === "zh" ? "中文" : "English" }));
  }

  /* ------------------------------------------------------------------ */
  /* Permissions / support                                              */
  /* ------------------------------------------------------------------ */

  function detectSupport() {
    state.secure = !!window.isSecureContext;
    state.geo.supported = !!navigator.geolocation;
    state.motion.supported = typeof window.DeviceMotionEvent !== "undefined";
    state.orient.supported = typeof window.DeviceOrientationEvent !== "undefined";
    state.generic.support.accelerometer = typeof window.Accelerometer === "function";
    state.generic.support.linear = typeof window.LinearAccelerationSensor === "function";
    state.generic.support.gyroscope = typeof window.Gyroscope === "function";
    state.generic.support.absolute = typeof window.AbsoluteOrientationSensor === "function";
    state.generic.support.relative = typeof window.RelativeOrientationSensor === "function";

    state.geo.permission = state.geo.supported ? "prompt" : "unsupported";
    state.motion.permission = state.motion.supported ? "prompt" : "unsupported";
    state.orient.permission = state.orient.supported ? "prompt" : "unsupported";
  }

  async function queryPermission(name) {
    if (!navigator.permissions || !navigator.permissions.query) return "unsupported";
    try {
      var status = await navigator.permissions.query({ name: name });
      if (!state.permissionStatuses[name] && status.addEventListener) {
        state.permissionStatuses[name] = status;
        status.addEventListener("change", function () {
          state.permissions[name] = status.state;
          if (name === "geolocation") state.geo.permission = status.state;
          log("permission", t("log.permission", { name: name, state: permissionText(status.state) }));
          updateUI();
        });
      }
      return status.state;
    } catch (err) {
      return "unsupported";
    }
  }

  async function refreshPermissions() {
    var names = ["geolocation", "accelerometer", "gyroscope", "magnetometer"];
    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      state.permissions[name] = await queryPermission(name);
    }
    state.geo.permission = state.permissions.geolocation;
    updateUI();
  }

  /* ------------------------------------------------------------------ */
  /* Geolocation                                                        */
  /* ------------------------------------------------------------------ */

  function haversine(lat1, lon1, lat2, lon2) {
    var R = 6371000;
    var dLat = ((lat2 - lat1) * Math.PI) / 180;
    var dLon = ((lon2 - lon1) * Math.PI) / 180;
    var a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function requestGeolocation() {
    if (!state.secure) { showToast(t("toast.secured"), 3600); return; }
    if (!state.geo.supported) { showToast(t("toast.unsupported"), 3200); return; }
    if (state.geo.watching) return;

    state.geo.error = null;
    state.geo.firstLogged = false;
    log("geoStart", t("log.geoStart"));
    try {
      state.geo.watchId = navigator.geolocation.watchPosition(
        onGeoSuccess,
        onGeoError,
        { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }
      );
      state.geo.watching = true;
      state.geo.permission = state.permissions.geolocation === "denied"
        ? "denied"
        : state.permissions.geolocation === "granted"
        ? "granted"
        : "prompt";
      showToast(t("toast.permissionRequested"), 2600);
    } catch (err) {
      state.geo.error = String(err);
      showToast(t("toast.geoError", { error: String(err) }), 4200);
      log("geoError", t("log.geoError", { error: String(err) }));
    }
    updateUI();
  }

  function onGeoSuccess(position) {
    var now = performance.now();
    var coords = position.coords;
    var ts = position.timestamp || Date.now();
    var accuracy = typeof coords.accuracy === "number" ? coords.accuracy : null;
    var speed = typeof coords.speed === "number" && isFinite(coords.speed) ? coords.speed : null;
    var derived = null;

    if (state.geo.lastPos && ts > state.geo.lastPos.ts) {
      var dt = (ts - state.geo.lastPos.ts) / 1000;
      if (dt >= 0.5 && dt < 15 && (accuracy === null || accuracy < 100)) {
        var distance = haversine(
          state.geo.lastPos.lat,
          state.geo.lastPos.lon,
          coords.latitude,
          coords.longitude
        );
        derived = distance / dt;
      }
    }

    var effective = speed !== null ? speed : derived;
    var interval = state.geo.lastFixAt ? now - state.geo.lastFixAt : null;

    state.geo.count += 1;
    state.geo.watching = true;
    state.geo.permission = "granted";
    state.geo.error = null;
    state.geo.lastAt = now;
    state.geo.lastWall = Date.now();
    state.geo.lastFixAt = now;
    state.geo.intervalMs = interval;
    state.geo.speedMps = effective;
    state.geo.gpsSpeedMps = speed;
    state.geo.derivedMps = derived;
    state.geo.accuracy = accuracy;
    state.geo.heading = typeof coords.heading === "number" ? coords.heading : null;
    state.geo.lastPos = {
      lat: coords.latitude,
      lon: coords.longitude,
      ts: ts,
      accuracy: accuracy
    };

    if (!state.geo.firstLogged) {
      state.geo.firstLogged = true;
      log("geoFirst", t("log.geoFirst"));
    }

    if (state.record.active) {
      state.samples.geo.push({
        t: now,
        ts: ts,
        speedMps: effective,
        gpsSpeedMps: speed,
        derivedSpeedMps: derived,
        accuracyMps: accuracy,
        headingDeg: state.geo.heading,
        intervalMs: interval
      });
      if (state.samples.geo.length > MAX_GEO) state.samples.geo.shift();
    }
    updateUI();
  }

  function onGeoError(error) {
    var message = error && error.message ? error.message : "unknown";
    state.geo.error = message;
    state.geo.permission = error && error.code === 1 ? "denied" : state.geo.permission;
    log("geoError", t("log.geoError", { error: message }));
    if (error && error.code === 1) {
      state.geo.watching = false;
      if (state.geo.watchId !== null) {
        try { navigator.geolocation.clearWatch(state.geo.watchId); } catch (err) { /* ignore */ }
        state.geo.watchId = null;
      }
      showToast(t("toast.geoDenied"), 4200);
    } else if (error && error.code === 3) {
      showToast(t("toast.geoError", { error: message }), 4200);
    }
    updateUI();
  }

  function stopGeolocation() {
    if (state.geo.watchId !== null) {
      try { navigator.geolocation.clearWatch(state.geo.watchId); } catch (err) { /* ignore */ }
    }
    state.geo.watchId = null;
    state.geo.watching = false;
    log("geoStop", t("log.geoStop"));
    updateUI();
  }

  /* ------------------------------------------------------------------ */
  /* Motion / orientation                                               */
  /* ------------------------------------------------------------------ */

  async function requestMotion() {
    if (!state.secure) { showToast(t("toast.secured"), 3600); return; }
    if (!state.motion.supported) { showToast(t("toast.unsupported"), 3200); return; }
    if (state.motion.listening) return;

    try {
      if (
        window.DeviceMotionEvent &&
        typeof window.DeviceMotionEvent.requestPermission === "function"
      ) {
        var result = await window.DeviceMotionEvent.requestPermission();
        if (result !== "granted") {
          state.motion.permission = "denied";
          log("motionDenied", t("log.motionDenied"));
          showToast(t("toast.motionDenied"), 3600);
          updateUI();
          return;
        }
      }
      startMotion();
    } catch (err) {
      state.motion.permission = "denied";
      state.motion.error = String(err);
      log("motionDenied", t("log.motionDenied"));
      showToast(t("toast.denied", { name: "motion" }), 3600);
      updateUI();
    }
  }

  function startMotion() {
    if (state.motion.listening) return;
    window.addEventListener("devicemotion", onMotion, false);
    state.motion.listening = true;
    state.motion.permission = "granted";
    state.motion.error = null;
    log("motionStart", t("log.motionStart"));
    updateUI();
  }

  function stopMotion() {
    window.removeEventListener("devicemotion", onMotion, false);
    state.motion.listening = false;
    log("motionStop", t("log.motionStop"));
    updateUI();
  }

  function onMotion(event) {
    var now = performance.now();
    var interval =
      typeof event.interval === "number" && event.interval > 0
        ? event.interval
        : state.motion.lastAt
        ? now - state.motion.lastAt
        : null;

    state.motion.count += 1;
    state.motion.permission = "granted";
    state.motion.lastAt = now;
    state.motion.lastWall = Date.now();
    state.motion.intervalMs = interval;

    if (!state.motion.rateStart) {
      state.motion.rateStart = now;
      state.motion.rateCount = 0;
    }
    state.motion.rateCount += 1;
    if (now - state.motion.rateStart >= 1000) {
      state.motion.rateHz = (state.motion.rateCount * 1000) / (now - state.motion.rateStart);
      state.motion.rateCount = 0;
      state.motion.rateStart = now;
    }

    var a = event.acceleration;
    var ag = event.accelerationIncludingGravity;
    var rr = event.rotationRate;
    state.motion.accel = a
      ? { x: a.x, y: a.y, z: a.z }
      : null;
    state.motion.accelG = ag
      ? { x: ag.x, y: ag.y, z: ag.z }
      : null;
    state.motion.rotation = rr
      ? { alpha: rr.alpha, beta: rr.beta, gamma: rr.gamma }
      : null;
    state.motion.gravity = ag &&
      typeof ag.x === "number" && isFinite(ag.x) &&
      typeof ag.y === "number" && isFinite(ag.y) &&
      typeof ag.z === "number" && isFinite(ag.z)
      ? Math.sqrt(ag.x * ag.x + ag.y * ag.y + ag.z * ag.z)
      : null;

    if (state.record.active && now - state.motion.lastSampleAt >= MOTION_SAMPLE_MS) {
      state.motion.lastSampleAt = now;
      state.samples.motion.push({
        t: now,
        ax: a ? a.x : null,
        ay: a ? a.y : null,
        az: a ? a.z : null,
        agx: ag ? ag.x : null,
        agy: ag ? ag.y : null,
        agz: ag ? ag.z : null,
        ra: rr ? rr.alpha : null,
        rb: rr ? rr.beta : null,
        rg: rr ? rr.gamma : null,
        intervalMs: interval
      });
      if (state.samples.motion.length > MAX_MOTION) state.samples.motion.shift();
    }
  }

  async function requestOrientation() {
    if (!state.secure) { showToast(t("toast.secured"), 3600); return; }
    if (!state.orient.supported) { showToast(t("toast.unsupported"), 3200); return; }
    if (state.orient.listening) return;

    try {
      if (
        window.DeviceOrientationEvent &&
        typeof window.DeviceOrientationEvent.requestPermission === "function"
      ) {
        var result = await window.DeviceOrientationEvent.requestPermission();
        if (result !== "granted") {
          state.orient.permission = "denied";
          showToast(t("toast.orientDenied"), 3600);
          updateUI();
          return;
        }
      }
      startOrientation();
    } catch (err) {
      state.orient.permission = "denied";
      showToast(t("toast.denied", { name: "orientation" }), 3600);
      updateUI();
    }
  }

  function startOrientation() {
    if (state.orient.listening) return;
    window.addEventListener("deviceorientation", onOrientation, false);
    state.orient.listening = true;
    state.orient.permission = "granted";
    log("orientStart", t("log.orientStart"));
    updateUI();
  }

  function stopOrientation() {
    window.removeEventListener("deviceorientation", onOrientation, false);
    state.orient.listening = false;
    log("orientStop", t("log.orientStop"));
    updateUI();
  }

  function onOrientation(event) {
    var now = performance.now();
    state.orient.count += 1;
    state.orient.lastAt = now;
    state.orient.lastWall = Date.now();
    state.orient.alpha = typeof event.alpha === "number" ? event.alpha : null;
    state.orient.beta = typeof event.beta === "number" ? event.beta : null;
    state.orient.gamma = typeof event.gamma === "number" ? event.gamma : null;
    state.orient.absolute = typeof event.absolute === "boolean" ? event.absolute : null;
    state.orient.permission = "granted";

    if (state.record.active && now - state.orient.lastSampleAt >= ORIENT_SAMPLE_MS) {
      state.orient.lastSampleAt = now;
      state.samples.orient.push({
        t: now,
        alpha: state.orient.alpha,
        beta: state.orient.beta,
        gamma: state.orient.gamma,
        absolute: state.orient.absolute
      });
      if (state.samples.orient.length > MAX_ORIENT) state.samples.orient.shift();
    }
  }

  /* ------------------------------------------------------------------ */
  /* Generic Sensor API                                                 */
  /* ------------------------------------------------------------------ */

  function genericSpecs() {
    return {
      linear: {
        Ctor: window.LinearAccelerationSensor,
        nameKey: "row.linear",
        startKey: "generic.startLinear"
      },
      gyro: {
        Ctor: window.Gyroscope,
        nameKey: "row.gyroscope",
        startKey: "generic.startGyro"
      },
      absolute: {
        Ctor: window.AbsoluteOrientationSensor,
        nameKey: "row.absoluteOrient",
        startKey: "generic.startAbsolute"
      }
    };
  }

  function buildGenericActions() {
    if (!els.genericActions) return;
    var specs = genericSpecs();
    var nodes = [];
    Object.keys(specs).forEach(function (kind) {
      var spec = specs[kind];
      if (typeof spec.Ctor !== "function") return;
      var button = document.createElement("button");
      button.type = "button";
      button.className = "btn ghost";
      button.setAttribute("data-generic", kind);
      button.textContent = t(spec.startKey);
      button.addEventListener("click", function () { toggleGeneric(kind); });
      nodes.push(button);
    });
    els.genericActions.replaceChildren.apply(els.genericActions, nodes);
    updateGenericActions();
  }

  function updateGenericActions() {
    if (!els.genericActions) return;
    var specs = genericSpecs();
    var buttons = els.genericActions.querySelectorAll("[data-generic]");
    for (var i = 0; i < buttons.length; i++) {
      var kind = buttons[i].getAttribute("data-generic");
      var active = !!state.generic.active[kind];
      buttons[i].textContent = active ? t("generic.stop") : t(specs[kind].startKey);
      buttons[i].classList.toggle("primary", active);
      buttons[i].classList.toggle("ghost", !active);
    }
  }

  function toggleGeneric(kind) {
    if (state.generic.active[kind]) {
      stopGeneric(kind);
      return;
    }
    startGeneric(kind);
  }

  function startGeneric(kind) {
    var specs = genericSpecs();
    var spec = specs[kind];
    if (!spec || typeof spec.Ctor !== "function") {
      showToast(t("toast.unsupported"), 3200);
      return;
    }
    var sensor = null;
    try {
      try {
        sensor = new spec.Ctor({ frequency: 60, referenceFrame: "device" });
      } catch (err) {
        sensor = new spec.Ctor({ frequency: 60 });
      }
    } catch (err) {
      state.generic.errors[kind] = String(err);
      log("genericError", t("log.genericError", { name: t(spec.nameKey), error: String(err) }));
      showToast(t("toast.genericError", { error: String(err) }), 4200);
      return;
    }

    sensor.onreading = function () {
      var last = { t: performance.now() };
      if (kind === "absolute") {
        last.quaternion = sensor.quaternion
          ? Array.prototype.slice.call(sensor.quaternion)
          : null;
      } else {
        last.x = sensor.x;
        last.y = sensor.y;
        last.z = sensor.z;
      }
      state.generic.last[kind] = last;
      state.generic.active[kind].last = last;
    };
    sensor.onerror = function (event) {
      var message = event && event.error ? event.error.message || String(event.error) : "sensor error";
      state.generic.errors[kind] = message;
      log("genericError", t("log.genericError", { name: t(spec.nameKey), error: message }));
      showToast(t("toast.genericError", { error: message }), 4200);
      stopGeneric(kind);
    };

    state.generic.active[kind] = { sensor: sensor, last: null };
    try {
      sensor.start();
    } catch (err) {
      delete state.generic.active[kind];
      state.generic.errors[kind] = String(err);
      log("genericError", t("log.genericError", { name: t(spec.nameKey), error: String(err) }));
      showToast(t("toast.genericError", { error: String(err) }), 4200);
      updateUI();
      return;
    }

    delete state.generic.errors[kind];
    log("genericStart", t("log.genericStart", { name: t(spec.nameKey) }));
    showToast(t("toast.genericStarted", { name: t(spec.nameKey) }), 2400);
    updateUI();
  }

  function stopGeneric(kind) {
    var active = state.generic.active[kind];
    if (!active) return;
    try { active.sensor.stop(); } catch (err) { /* ignore */ }
    delete state.generic.active[kind];
    log("genericStop", t("log.genericStop", { name: t(genericSpecs()[kind].nameKey) }));
    updateUI();
  }

  /* ------------------------------------------------------------------ */
  /* Recording / report                                                 */
  /* ------------------------------------------------------------------ */

  function hasActiveSensor() {
    return (
      state.mock ||
      state.geo.watching ||
      state.motion.listening ||
      state.orient.listening ||
      Object.keys(state.generic.active).length > 0
    );
  }

  function startRecording(force) {
    if (state.record.active) return;
    if (!force && !hasActiveSensor()) {
      showToast(t("toast.noSensor"), 3600);
      return;
    }
    state.record.active = true;
    state.record.start = performance.now();
    state.record.duration = 0;
    state.record.startedAt = new Date().toISOString();
    state.samples.geo = [];
    state.samples.motion = [];
    state.samples.orient = [];
    state.geo.firstLogged = false;
    log("recordStart", t("log.recordStart"));
    showToast(t("toast.recordStarted"), 2200);
    updateUI();
  }

  function stopRecording() {
    if (!state.record.active) return;
    state.record.duration = performance.now() - state.record.start;
    state.record.active = false;
    log("recordStop", t("log.recordStop"));
    showToast(t("toast.recordStopped"), 2200);
    updateUI();
  }

  function toggleRecording() {
    if (state.record.active) stopRecording();
    else startRecording();
  }

  function clearSamples() {
    state.record.active = false;
    state.record.start = 0;
    state.record.duration = 0;
    state.record.startedAt = null;
    state.samples.geo = [];
    state.samples.motion = [];
    state.samples.orient = [];
    log("clear", t("log.clear"));
    showToast(t("toast.cleared"), 2200);
    updateUI();
  }

  function totalSamples() {
    return state.samples.geo.length + state.samples.motion.length + state.samples.orient.length;
  }

  function buildReport() {
    var now = performance.now();
    var duration = state.record.active
      ? now - state.record.start
      : state.record.duration;

    var geoSpeeds = [];
    var geoAcc = [];
    var geoIntervals = [];
    var noSpeed = 0;
    for (var i = 0; i < state.samples.geo.length; i++) {
      var g = state.samples.geo[i];
      if (typeof g.speedMps === "number" && isFinite(g.speedMps)) geoSpeeds.push(g.speedMps);
      else noSpeed += 1;
      if (typeof g.accuracyMps === "number") geoAcc.push(g.accuracyMps);
      if (typeof g.intervalMs === "number") geoIntervals.push(g.intervalMs);
    }
    var geoSummary = {
      samples: state.samples.geo.length,
      speedMinKmh: geoSpeeds.length ? Math.min.apply(null, geoSpeeds) * 3.6 : null,
      speedMaxKmh: geoSpeeds.length ? Math.max.apply(null, geoSpeeds) * 3.6 : null,
      speedAvgKmh: geoSpeeds.length ? (geoSpeeds.reduce(function (a, b) { return a + b; }, 0) / geoSpeeds.length) * 3.6 : null,
      accuracyAvgM: geoAcc.length ? geoAcc.reduce(function (a, b) { return a + b; }, 0) / geoAcc.length : null,
      intervalAvgMs: geoIntervals.length ? geoIntervals.reduce(function (a, b) { return a + b; }, 0) / geoIntervals.length : null,
      noSpeedSamples: noSpeed
    };

    var motionAx = [];
    var motionAy = [];
    var motionAz = [];
    var gravity = [];
    var motionIntervals = [];
    for (var j = 0; j < state.samples.motion.length; j++) {
      var m = state.samples.motion[j];
      if (typeof m.ax === "number") motionAx.push(m.ax);
      if (typeof m.ay === "number") motionAy.push(m.ay);
      if (typeof m.az === "number") motionAz.push(m.az);
      if (typeof m.agx === "number" && typeof m.agy === "number" && typeof m.agz === "number") {
        gravity.push(Math.sqrt(m.agx * m.agx + m.agy * m.agy + m.agz * m.agz));
      }
      if (typeof m.intervalMs === "number") motionIntervals.push(m.intervalMs);
    }
    var motionSummary = {
      samples: state.samples.motion.length,
      intervalAvgMs: motionIntervals.length ? motionIntervals.reduce(function (a, b) { return a + b; }, 0) / motionIntervals.length : null,
      axMin: motionAx.length ? Math.min.apply(null, motionAx) : null,
      axMax: motionAx.length ? Math.max.apply(null, motionAx) : null,
      ayMin: motionAy.length ? Math.min.apply(null, motionAy) : null,
      ayMax: motionAy.length ? Math.max.apply(null, motionAy) : null,
      azMin: motionAz.length ? Math.min.apply(null, motionAz) : null,
      azMax: motionAz.length ? Math.max.apply(null, motionAz) : null,
      gravityAvg: gravity.length ? gravity.reduce(function (a, b) { return a + b; }, 0) / gravity.length : null
    };

    var orientSummary = {
      samples: state.samples.orient.length,
      last: state.samples.orient.length ? state.samples.orient[state.samples.orient.length - 1] : null
    };

    return {
      schema: "nioengine.sensors/1",
      createdAt: new Date().toISOString(),
      build: BUILD,
      locale: state.lang,
      url: location.href,
      mock: state.mock,
      secureContext: state.secure,
      userAgent: navigator.userAgent,
      screen: {
        width: screen.width,
        height: screen.height,
        dpr: window.devicePixelRatio || 1,
        orientation: screen.orientation ? screen.orientation.type : null,
        angle: screen.orientation ? screen.orientation.angle : null
      },
      viewport: {
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        clientWidth: document.documentElement.clientWidth,
        clientHeight: document.documentElement.clientHeight
      },
      support: {
        geolocation: state.geo.supported,
        deviceMotion: state.motion.supported,
        deviceOrientation: state.orient.supported,
        generic: state.generic.support
      },
      permissions: state.permissions,
      record: {
        active: state.record.active,
        startedAt: state.record.startedAt,
        durationMs: duration,
        motionSampleHz: MOTION_SAMPLE_MS ? Math.round(1000 / MOTION_SAMPLE_MS) : null
      },
      geolocation: {
        samples: state.samples.geo,
        summary: geoSummary,
        last: state.geo.lastAt
          ? {
              speedMps: state.geo.speedMps,
              gpsSpeedMps: state.geo.gpsSpeedMps,
              derivedMps: state.geo.derivedMps,
              accuracyMps: state.geo.accuracy,
              headingDeg: state.geo.heading,
              intervalMs: state.geo.intervalMs,
              lastWall: state.geo.lastWall
            }
          : null
      },
      motion: {
        samples: state.samples.motion,
        summary: motionSummary,
        last: state.motion.lastAt
          ? {
              accel: state.motion.accel,
              accelGravity: state.motion.accelG,
              rotation: state.motion.rotation,
              gravity: state.motion.gravity,
              intervalMs: state.motion.intervalMs,
              rateHz: state.motion.rateHz,
              lastWall: state.motion.lastWall
            }
          : null
      },
      orientation: {
        samples: state.samples.orient,
        summary: orientSummary,
        last: state.orient.lastAt
          ? {
              alpha: state.orient.alpha,
              beta: state.orient.beta,
              gamma: state.orient.gamma,
              absolute: state.orient.absolute,
              lastWall: state.orient.lastWall
            }
          : null
      },
      generic: {
        support: state.generic.support,
        active: Object.keys(state.generic.active),
        last: state.generic.last,
        errors: state.generic.errors
      },
      events: state.events,
      notes: {
        gpsSpeedIsGroundSpeed: true,
        motionAxesAreDeviceAxes: true,
        noVehicleCanData: true,
        noUpload: true
      }
    };
  }

  function exportReport() {
    var report = buildReport();
    var text = JSON.stringify(report, null, 2);
    var blob = new Blob([text], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    var stamp = new Date().toISOString().replace(/[:.]/g, "-");
    a.href = url;
    a.download = "nioengine-sensors-" + stamp + ".json";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    log("export", t("log.export"));
    showToast(t("toast.exported"), 2600);
  }

  function copyReport() {
    copyText(
      JSON.stringify(buildReport(), null, 2),
      t("toast.copied"),
      t("toast.copyFail")
    );
  }

  /* ------------------------------------------------------------------ */
  /* UI                                                                 */
  /* ------------------------------------------------------------------ */

  function sensorStatusText(kind) {
    if (kind === "geo") {
      if (!state.geo.supported) return "unsupported";
      if (state.geo.error) return "error";
      if (state.geo.watching) return "watching";
      return "idle";
    }
    if (kind === "motion") {
      if (!state.motion.supported) return "unsupported";
      if (state.motion.listening) return "listening";
      return "idle";
    }
    if (!state.orient.supported) return "unsupported";
    if (state.orient.listening) return "listening";
    return "idle";
  }

  function sensorStatusPill(kind) {
    var status = sensorStatusText(kind);
    var map = {
      watching: "ok",
      listening: "ok",
      idle: "neutral",
      unsupported: "bad",
      error: "bad"
    };
    var key = "status." + status;
    return pill(t(key), map[status] || "neutral");
  }

  function setStatusPill(el, kind) {
    if (!el) return;
    var status = sensorStatusText(kind);
    var map = {
      watching: "ok",
      listening: "ok",
      idle: "neutral",
      unsupported: "bad",
      error: "bad"
    };
    el.textContent = t("status." + status);
    el.className = "pill " + (map[status] || "neutral");
  }

  function renderGeoRows() {
    var g = state.geo;
    var source = !g.watching
      ? t("geo.sourceIdle")
      : g.speedMps !== null && g.gpsSpeedMps !== null
      ? t("geo.sourceGps")
      : g.speedMps !== null
      ? t("geo.sourceDerived")
      : t("geo.sourceNoSpeed");
    setText(els.geoSource, source);
    var hasSpeed = g.speedMps !== null && isFinite(g.speedMps);
    setText(els.geoKmh, hasSpeed ? (g.speedMps * 3.6).toFixed(1) : "—");
    if (els.geoKmh) els.geoKmh.classList.toggle("empty", !hasSpeed);

    var rows = [
      row("row.permission", permissionPill(g.permission)),
      row("row.state", sensorStatusPill("geo")),
      row("row.speed", fmtSpeed(g.speedMps)),
      row("row.derived", fmtSpeed(g.derivedMps)),
      row("row.accuracy", g.accuracy === null ? "—" : Math.round(g.accuracy) + " m"),
      row("row.interval", fmtMs(g.intervalMs)),
      row("row.heading", fmtDeg(g.heading)),
      row("row.last", fmtTime(g.lastWall)),
      row("row.samples", String(state.samples.geo.length))
    ];
    if (g.error) rows.push(row("row.state", g.error));
    renderRows(els.geoRows, rows);
  }

  function renderMotionRows() {
    var m = state.motion;
    setText(els.ax, m.accel && m.accel.x !== null ? fmtNum(m.accel.x, 2) : "—");
    setText(els.ay, m.accel && m.accel.y !== null ? fmtNum(m.accel.y, 2) : "—");
    setText(els.az, m.accel && m.accel.z !== null ? fmtNum(m.accel.z, 2) : "—");

    var rows = [
      row("row.permission", permissionPill(m.permission)),
      row("row.state", sensorStatusPill("motion")),
      row("row.rate", m.rateHz ? m.rateHz.toFixed(1) + " " + t("value.hz") : "—"),
      row("row.interval", fmtMs(m.intervalMs)),
      row("row.gravity", m.gravity === null || !isFinite(m.gravity) ? "—" : m.gravity.toFixed(2) + " " + t("value.mps2")),
      row("row.rotation", m.rotation
        ? [m.rotation.alpha, m.rotation.beta, m.rotation.gamma]
            .map(function (v) { return fmtNum(v, 1); })
            .join(" / ") + " " + t("value.dps")
        : "—"),
      row("row.last", fmtTime(m.lastWall)),
      row("row.samples", String(state.samples.motion.length))
    ];
    if (m.error) rows.push(row("row.state", m.error));
    renderRows(els.motionRows, rows);
  }

  function renderOrientRows() {
    var o = state.orient;
    var rows = [
      row("row.permission", permissionPill(o.permission)),
      row("row.state", sensorStatusPill("orient")),
      row("row.alpha", fmtDeg(o.alpha)),
      row("row.beta", fmtDeg(o.beta)),
      row("row.gamma", fmtDeg(o.gamma)),
      row("row.absolute", o.absolute === null ? "—" : o.absolute ? t("value.yes") : t("value.no")),
      row("row.screen", screen.orientation
        ? screen.orientation.type + " · " + screen.orientation.angle + "°"
        : "—"),
      row("row.last", fmtTime(o.lastWall)),
      row("row.samples", String(state.samples.orient.length))
    ];
    renderRows(els.orientRows, rows);
  }

  function renderGeneric() {
    var supportRows = [
      row("row.accelerometer", boolPill(state.generic.support.accelerometer)),
      row("row.linear", boolPill(state.generic.support.linear)),
      row("row.gyroscope", boolPill(state.generic.support.gyroscope)),
      row("row.absoluteOrient", boolPill(state.generic.support.absolute)),
      row("row.relativeOrient", boolPill(state.generic.support.relative)),
      row("row.accelPermission", permissionPill(state.permissions.accelerometer)),
      row("row.gyroPermission", permissionPill(state.permissions.gyroscope))
    ];
    renderRows(els.genericSupport, supportRows);

    var specs = genericSpecs();
    var readingRows = [];
    var activeKinds = Object.keys(state.generic.active);
    if (activeKinds.length === 0) {
      readingRows.push(row("row.genericActive", t("value.none")));
    } else {
      activeKinds.forEach(function (kind) {
        var last = state.generic.last[kind];
        var text = "—";
        if (last) {
          if (kind === "absolute") {
            text = last.quaternion ? last.quaternion.map(function (v) { return fmtNum(v, 2); }).join(" / ") : "—";
          } else {
            text = [fmtNum(last.x, 2), fmtNum(last.y, 2), fmtNum(last.z, 2)].join(" / ");
          }
        }
        readingRows.push(row(specs[kind].nameKey, text));
      });
    }
    renderRows(els.genericReadings, readingRows);
    updateGenericActions();
  }

  function renderRecord() {
    var elapsed = state.record.active
      ? performance.now() - state.record.start
      : state.record.duration;
    setText(els.recordElapsed, fmtDuration(elapsed));
    setText(els.geoCount, String(state.samples.geo.length));
    setText(els.motionCount, String(state.samples.motion.length));
    setText(els.orientCount, String(state.samples.orient.length));

    var status = state.record.active ? "recording" : totalSamples() > 0 ? "stopped" : "ready";
    if (els.recordStatus) {
      els.recordStatus.textContent = t("status." + status);
      els.recordStatus.className = "pill " + (state.record.active ? "ok" : "neutral");
    }
    if (els.recordBtn) els.recordBtn.textContent = state.record.active ? t("action.stopRecord") : t("action.startRecord");
    if (els.recordToggle) els.recordToggle.textContent = state.record.active ? t("action.stopRecord") : t("action.startRecord");
    if (els.exportBtn) els.exportBtn.disabled = false;
    if (els.copyBtn) els.copyBtn.disabled = false;

    if (els.recordSummary) {
      if (totalSamples() === 0) {
        els.recordSummary.hidden = true;
      } else {
        els.recordSummary.hidden = false;
        els.recordSummary.textContent =
          t("record.summary", {
            geo: state.samples.geo.length,
            motion: state.samples.motion.length,
            orient: state.samples.orient.length
          }) +
          " · " +
          t("record.duration", { duration: fmtDuration(elapsed) });
      }
    }
  }

  function updateUI() {
    if (els.secureBadge) {
      els.secureBadge.textContent = state.secure ? t("secure.ok") : t("secure.bad");
      els.secureBadge.className = "pill " + (state.secure ? "ok" : "bad");
    }
    setStatusPill(els.geoStatus, "geo");
    setStatusPill(els.motionStatus, "motion");
    setStatusPill(els.orientStatus, "orient");

    renderGeoRows();
    renderMotionRows();
    renderOrientRows();
    renderGeneric();
    renderRecord();

    setText(els.statusLine, state.secure
      ? t("summary.sensors", {
          geo: t("status." + sensorStatusText("geo")),
          motion: t("status." + sensorStatusText("motion")),
          orient: t("status." + sensorStatusText("orient"))
        })
      : t("toast.secured"));

    if (els.geoStart) els.geoStart.disabled = !state.geo.supported || state.geo.watching;
    if (els.geoStop) els.geoStop.disabled = !state.geo.watching;
    if (els.motionStart) els.motionStart.disabled = !state.motion.supported || state.motion.listening;
    if (els.motionStop) els.motionStop.disabled = !state.motion.listening;
    if (els.orientStart) els.orientStart.disabled = !state.orient.supported || state.orient.listening;
    if (els.orientStop) els.orientStop.disabled = !state.orient.listening;

    drawChart();
  }

  /* ------------------------------------------------------------------ */
  /* Chart                                                              */
  /* ------------------------------------------------------------------ */

  function drawChart() {
    var canvas = els.chart;
    if (!canvas) return;
    var w = canvas.clientWidth;
    var h = canvas.clientHeight;
    if (w < 20 || h < 20) return;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var pw = Math.round(w * dpr);
    var ph = Math.round(h * dpr);
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
    var ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    var pad = 12;
    var plotW = w - pad * 2;
    var plotH = h - pad * 2;
    ctx.strokeStyle = "rgba(255,255,255,.07)";
    ctx.lineWidth = 1;
    for (var i = 0; i <= 4; i++) {
      var y = pad + (plotH * i) / 4;
      ctx.beginPath();
      ctx.moveTo(pad, y);
      ctx.lineTo(w - pad, y);
      ctx.stroke();
    }
    for (var j = 0; j <= 6; j++) {
      var x = pad + (plotW * j) / 6;
      ctx.beginPath();
      ctx.moveTo(x, pad);
      ctx.lineTo(x, h - pad);
      ctx.stroke();
    }

    var geo = state.samples.geo;
    var motion = state.samples.motion;
    var lastT = 0;
    if (geo.length) lastT = Math.max(lastT, geo[geo.length - 1].t);
    if (motion.length) lastT = Math.max(lastT, motion[motion.length - 1].t);
    if (state.record.active) lastT = Math.max(lastT, performance.now());
    if (!geo.length && !motion.length) {
      ctx.fillStyle = "rgba(145,164,184,.65)";
      ctx.font = "600 12px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(t("chart.empty"), w / 2, h / 2);
      return;
    }

    var tEnd = lastT || performance.now();
    var tStart = Math.max(0, tEnd - 120000);
    var span = Math.max(1, tEnd - tStart);

    var speedMax = 80;
    for (var a = 0; a < geo.length; a++) {
      if (typeof geo[a].speedMps === "number") speedMax = Math.max(speedMax, geo[a].speedMps * 3.6);
    }
    speedMax = Math.ceil((speedMax * 1.15) / 20) * 20;

    var accelMax = 3;
    for (var b = 0; b < motion.length; b++) {
      var m = motion[b];
      var mag = 0;
      if (typeof m.ax === "number" && typeof m.ay === "number" && typeof m.az === "number") {
        mag = Math.sqrt(m.ax * m.ax + m.ay * m.ay + m.az * m.az);
      }
      accelMax = Math.max(accelMax, mag);
    }
    accelMax = Math.ceil((accelMax * 1.15) * 2) / 2;

    function xOf(tt) { return pad + ((tt - tStart) / span) * plotW; }
    function ySpeed(v) { return h - pad - (v / speedMax) * plotH; }
    function yAccel(v) { return h - pad - (v / accelMax) * plotH; }

    if (geo.length > 1) {
      ctx.beginPath();
      var speedStarted = false;
      for (var k = 0; k < geo.length; k++) {
        var g = geo[k];
        if (typeof g.speedMps !== "number") continue;
        var gx = xOf(g.t);
        var gy = ySpeed(g.speedMps * 3.6);
        if (!speedStarted) {
          ctx.moveTo(gx, gy);
          speedStarted = true;
        } else {
          ctx.lineTo(gx, gy);
        }
      }
      ctx.strokeStyle = "#ff6a2a";
      ctx.lineWidth = 2;
      ctx.shadowBlur = 8;
      ctx.shadowColor = "rgba(255,90,31,.4)";
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    if (motion.length > 1) {
      ctx.beginPath();
      var accelStarted = false;
      for (var n = 0; n < motion.length; n++) {
        var mm = motion[n];
        if (typeof mm.ax !== "number" || typeof mm.ay !== "number" || typeof mm.az !== "number") continue;
        var mx = xOf(mm.t);
        var my = yAccel(Math.sqrt(mm.ax * mm.ax + mm.ay * mm.ay + mm.az * mm.az));
        if (!accelStarted) {
          ctx.moveTo(mx, my);
          accelStarted = true;
        } else {
          ctx.lineTo(mx, my);
        }
      }
      ctx.strokeStyle = "#4aa8ff";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    ctx.fillStyle = "rgba(145,164,184,.65)";
    ctx.font = "10px system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText(speedMax + " km/h", pad, pad);
    ctx.textAlign = "right";
    ctx.fillText(accelMax.toFixed(1) + " m/s²", w - pad, pad);
  }

  /* ------------------------------------------------------------------ */
  /* Init                                                               */
  /* ------------------------------------------------------------------ */

  function cacheElements() {
    els = {
      secureBadge: byId("secureBadge"),
      statusLine: byId("statusLine"),
      startAll: byId("startAll"),
      recordBtn: byId("recordBtn"),
      geoStatus: byId("geoStatus"),
      geoKmh: byId("geoKmh"),
      geoSource: byId("geoSource"),
      geoRows: byId("geoRows"),
      geoStart: byId("geoStart"),
      geoStop: byId("geoStop"),
      motionStatus: byId("motionStatus"),
      ax: byId("ax"),
      ay: byId("ay"),
      az: byId("az"),
      motionRows: byId("motionRows"),
      motionStart: byId("motionStart"),
      motionStop: byId("motionStop"),
      orientStatus: byId("orientStatus"),
      orientRows: byId("orientRows"),
      orientStart: byId("orientStart"),
      orientStop: byId("orientStop"),
      genericSupport: byId("genericSupport"),
      genericReadings: byId("genericReadings"),
      genericActions: byId("genericActions"),
      recordStatus: byId("recordStatus"),
      recordElapsed: byId("recordElapsed"),
      geoCount: byId("geoCount"),
      motionCount: byId("motionCount"),
      orientCount: byId("orientCount"),
      recordToggle: byId("recordToggle"),
      exportBtn: byId("exportBtn"),
      copyBtn: byId("copyBtn"),
      clearBtn: byId("clearBtn"),
      recordSummary: byId("recordSummary"),
      chart: byId("chart"),
      log: byId("log"),
      clearLog: byId("clearLog"),
      toast: byId("toast"),
      buildInfo: byId("buildInfo")
    };
  }

  function setupEvents() {
    if (els.geoStart) els.geoStart.addEventListener("click", requestGeolocation);
    if (els.geoStop) els.geoStop.addEventListener("click", stopGeolocation);
    if (els.motionStart) els.motionStart.addEventListener("click", function () { requestMotion(); });
    if (els.motionStop) els.motionStop.addEventListener("click", stopMotion);
    if (els.orientStart) els.orientStart.addEventListener("click", function () { requestOrientation(); });
    if (els.orientStop) els.orientStop.addEventListener("click", stopOrientation);
    if (els.startAll) {
      els.startAll.addEventListener("click", function () {
        if (!state.secure) { showToast(t("toast.secured"), 3600); return; }
        showToast(t("toast.permissionRequested"), 2600);
        requestGeolocation();
        requestMotion();
        requestOrientation();
        refreshPermissions();
      });
    }
    if (els.recordBtn) els.recordBtn.addEventListener("click", toggleRecording);
    if (els.recordToggle) els.recordToggle.addEventListener("click", toggleRecording);
    if (els.exportBtn) els.exportBtn.addEventListener("click", exportReport);
    if (els.copyBtn) els.copyBtn.addEventListener("click", copyReport);
    if (els.clearBtn) els.clearBtn.addEventListener("click", clearSamples);
    if (els.clearLog) {
      els.clearLog.addEventListener("click", function () {
        state.events = [];
        renderLog();
        showToast(t("toast.logCleared"), 1800);
      });
    }

    var langButtons = document.querySelectorAll("[data-lang]");
    for (var i = 0; i < langButtons.length; i++) {
      (function (button) {
        button.addEventListener("click", function () { setLang(button.getAttribute("data-lang")); });
      })(langButtons[i]);
    }

    document.addEventListener("visibilitychange", function () {
      log("visibility", t("log.visibility", { state: document.visibilityState }));
      if (document.visibilityState === "visible") {
        refreshPermissions();
        drawChart();
      }
    });

    if (screen.orientation && screen.orientation.addEventListener) {
      screen.orientation.addEventListener("change", function () {
        log("orientation", t("log.orientation", {
          state: screen.orientation.type + " · " + screen.orientation.angle + "°"
        }));
        updateUI();
      });
    }

    window.addEventListener("resize", function () {
      drawChart();
    });

    window.addEventListener("error", function (event) {
      var message = event && event.message ? event.message : "unknown error";
      log("error", t("log.error", { error: message }));
    });
    window.addEventListener("unhandledrejection", function (event) {
      var message = event && event.reason ? String(event.reason) : "unhandled rejection";
      log("error", t("log.error", { error: message }));
    });
  }

  function init() {
    cacheElements();
    state.lang = detectLang();
    detectSupport();
    applyI18n();
    updateLangButtons();
    if (els.buildInfo) {
      els.buildInfo.textContent = BUILD.version + " · " + BUILD.time;
    }
    buildGenericActions();
    setupEvents();
    updateUI();
    refreshPermissions();
    state.uiTimer = setInterval(updateUI, 250);

    log("pageLoad", t("log.pageLoad"));
    if (
      !state.geo.supported &&
      !state.motion.supported &&
      !state.orient.supported &&
      !state.generic.support.linear &&
      !state.generic.support.accelerometer
    ) {
      log("noSensors", t("log.noSensors"));
    }

    window.__SENSORS__ = {
      state: state,
      startRecording: startRecording,
      stopRecording: stopRecording,
      buildReport: buildReport,
      injectGeo: injectGeo,
      injectMotion: injectMotion,
      injectOrientation: injectOrientation,
      startGeo: requestGeolocation,
      stopGeo: stopGeolocation,
      startMotion: requestMotion,
      startOrientation: requestOrientation,
      drawChart: drawChart
    };
  }

  /* Debug-only injection for headless layout/report testing. */
  function injectGeo(data) {
    state.mock = true;
    state.geo.supported = true;
    var now = performance.now();
    state.geo.count += 1;
    state.geo.watching = true;
    state.geo.permission = "granted";
    state.geo.lastAt = now;
    state.geo.lastFixAt = now;
    state.geo.lastWall = Date.now();
    state.geo.intervalMs = data.intervalMs === undefined ? 1000 : data.intervalMs;
    state.geo.speedMps = data.speedMps === undefined ? 0 : data.speedMps;
    state.geo.gpsSpeedMps = data.speedMps === undefined ? null : data.speedMps;
    state.geo.derivedMps = data.derivedMps === undefined ? null : data.derivedMps;
    state.geo.accuracy = data.accuracy === undefined ? 5 : data.accuracy;
    state.geo.heading = data.heading === undefined ? null : data.heading;
    state.geo.error = null;
    if (state.record.active) {
      state.samples.geo.push({
        t: now,
        ts: Date.now(),
        speedMps: state.geo.speedMps,
        gpsSpeedMps: state.geo.gpsSpeedMps,
        derivedSpeedMps: state.geo.derivedMps,
        accuracyMps: state.geo.accuracy,
        headingDeg: state.geo.heading,
        intervalMs: state.geo.intervalMs
      });
      if (state.samples.geo.length > MAX_GEO) state.samples.geo.shift();
    }
    if (!state.geo.firstLogged) {
      state.geo.firstLogged = true;
      log("geoFirst", t("log.geoFirst"));
    }
    updateUI();
  }

  function injectMotion(data) {
    state.mock = true;
    state.motion.supported = true;
    var now = performance.now();
    state.motion.count += 1;
    state.motion.listening = true;
    state.motion.permission = "granted";
    state.motion.lastAt = now;
    state.motion.lastWall = Date.now();
    state.motion.intervalMs = data.intervalMs === undefined ? 40 : data.intervalMs;
    state.motion.accel = { x: data.ax, y: data.ay, z: data.az };
    state.motion.accelG = { x: data.agx, y: data.agy, z: data.agz };
    state.motion.rotation = { alpha: data.ra, beta: data.rb, gamma: data.rg };
    state.motion.gravity = data.agx !== undefined
      ? Math.sqrt((data.agx || 0) * (data.agx || 0) + (data.agy || 0) * (data.agy || 0) + (data.agz || 0) * (data.agz || 0))
      : null;
    if (state.record.active) {
      state.samples.motion.push({
        t: now,
        ax: data.ax === undefined ? null : data.ax,
        ay: data.ay === undefined ? null : data.ay,
        az: data.az === undefined ? null : data.az,
        agx: data.agx === undefined ? null : data.agx,
        agy: data.agy === undefined ? null : data.agy,
        agz: data.agz === undefined ? null : data.agz,
        ra: data.ra === undefined ? null : data.ra,
        rb: data.rb === undefined ? null : data.rb,
        rg: data.rg === undefined ? null : data.rg,
        intervalMs: state.motion.intervalMs
      });
      if (state.samples.motion.length > MAX_MOTION) state.samples.motion.shift();
    }
    updateUI();
  }

  function injectOrientation(data) {
    state.mock = true;
    state.orient.supported = true;
    var now = performance.now();
    state.orient.count += 1;
    state.orient.listening = true;
    state.orient.permission = "granted";
    state.orient.lastAt = now;
    state.orient.lastWall = Date.now();
    state.orient.alpha = data.alpha === undefined ? null : data.alpha;
    state.orient.beta = data.beta === undefined ? null : data.beta;
    state.orient.gamma = data.gamma === undefined ? null : data.gamma;
    state.orient.absolute = data.absolute === undefined ? null : data.absolute;
    if (state.record.active) {
      state.samples.orient.push({
        t: now,
        alpha: state.orient.alpha,
        beta: state.orient.beta,
        gamma: state.orient.gamma,
        absolute: state.orient.absolute
      });
      if (state.samples.orient.length > MAX_ORIENT) state.samples.orient.shift();
    }
    updateUI();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
