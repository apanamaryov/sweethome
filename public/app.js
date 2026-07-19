"use strict";

const $ = (id) => document.getElementById(id);

/* ---------- круговой секторный индикатор заряда ---------- */
const RING_SEGS = 20; // по 5% на сектор
const RING_GAP_DEG = 4.5;

function polar(cx, cy, r, deg) {
  const a = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}
function segPath(cx, cy, r1, r2, a1, a2) {
  const [x1, y1] = polar(cx, cy, r2, a1);
  const [x2, y2] = polar(cx, cy, r2, a2);
  const [x3, y3] = polar(cx, cy, r1, a2);
  const [x4, y4] = polar(cx, cy, r1, a1);
  const f = (n) => n.toFixed(2);
  return `M${f(x1)} ${f(y1)} A${r2} ${r2} 0 0 1 ${f(x2)} ${f(y2)} L${f(x3)} ${f(y3)} A${r1} ${r1} 0 0 0 ${f(x4)} ${f(y4)} Z`;
}
function buildRing() {
  const g = $("ring-segs");
  const step = 360 / RING_SEGS;
  for (let i = 0; i < RING_SEGS; i++) {
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("d", segPath(60, 60, 39, 55, i * step + RING_GAP_DEG / 2, (i + 1) * step - RING_GAP_DEG / 2));
    // Плотность дизеринга нарастает по кругу: d1..d5 по квинтилям
    p.setAttribute("class", "seg d" + (Math.floor(i / 4) + 1));
    g.appendChild(p);
  }
}
function updateRing(soc) {
  const filled = Math.round((soc / 100) * RING_SEGS);
  const segs = $("ring-segs").children;
  for (let i = 0; i < segs.length; i++) segs[i].classList.toggle("on", i < filled);
  $("soc-wrap").classList.toggle("low", soc <= 20);
}

let meta = null;
let lastSnapshot = null;
let staleTimer = null;

const SETTINGS_ROWS = [
  { key: "outputSourcePriority", labelKey: "sOsp", coded: "osp" },
  { key: "chargerSourcePriority", labelKey: "sCsp", coded: "csp" },
  { key: "maxChargingCurrent", labelKey: "sMcc", unit: "A" },
  { key: "maxAcChargingCurrent", labelKey: "sMacc", unit: "A" },
  { key: "batteryRechargeVoltage", labelKey: "sRecharge", unit: "V" },
  { key: "batteryRedischargeVoltage", labelKey: "sRedischarge", unit: "V" },
  { key: "batteryBulkVoltage", labelKey: "sBulk", unit: "V" },
  { key: "batteryFloatVoltage", labelKey: "sFloat", unit: "V" },
  { key: "batteryUnderVoltage", labelKey: "sCutoff", unit: "V" },
  { key: "batteryType", labelKey: "sBatType", map: { 0: "AGM", 1: "Flooded", 2: "User" } },
];

/* Локализованная метка кодового значения (приоритеты); фолбэк — метка из
   /api/meta (английская, серверная), затем само число. */
function codedValue(codedKey, value) {
  const local = t(codedKey);
  if (local && typeof local === "object" && local[value] !== undefined) return local[value];
  const metaKey = codedKey === "osp" ? "outputSourcePriority" : "chargerSourcePriority";
  if (meta && meta[metaKey] && meta[metaKey][value] !== undefined) return meta[metaKey][value];
  return value;
}
function settingDisplay(row, value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  if (row.coded) return codedValue(row.coded, value);
  if (row.map && row.map[value] !== undefined) return row.map[value];
  return value + (row.unit ? " " + t("unit_" + row.unit) : "");
}

/* ---------- helpers ---------- */
function fmt(v, digits = 0) {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return Number(v).toFixed(digits);
}
let toastTimer = null;
function toast(msg, kind = "") {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast " + kind;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 3200);
}

/* ---------- rendering ---------- */
function render(snap) {
  lastSnapshot = snap;
  const c = snap.connection;

  // Connection pill
  const conn = $("conn");
  if (c.mock) {
    conn.className = "pill pill-mock";
    conn.textContent = t("demoData");
  } else if (c.connected) {
    conn.className = "pill pill-ok";
    conn.textContent = t("connectedVia") + c.transport + (c.device ? " " + c.device : "");
  } else {
    conn.className = "pill pill-bad";
    conn.textContent = t("noConnection");
  }

  // Mode
  const mode = $("mode");
  mode.textContent = t("mode" + snap.mode) || snap.mode;
  mode.className = "mode-badge mode-" + snap.mode;

  // Updated time — с дискретной «e-ink» вспышкой на каждом обновлении
  if (snap.timestamp) {
    const d = new Date(snap.timestamp);
    const u = $("updated");
    u.textContent = t("updated") + d.toLocaleTimeString(t("langLocale"));
    u.classList.remove("flash");
    void u.offsetWidth; // перезапуск анимации
    u.classList.add("flash");
  }

  // Warnings banner
  const banner = $("banner");
  const warns = snap.warnings && snap.warnings.active ? snap.warnings.active : [];
  if (warns.length) {
    banner.classList.remove("hidden");
    banner.textContent = "⚠ " + warns.map(tWarn).join(" · ");
  } else {
    banner.classList.add("hidden");
  }

  const s = snap.status;
  if (s) {
    // Battery: секторное кольцо вокруг цифры заряда
    const soc = Number.isNaN(s.batteryCapacity) ? 0 : Math.max(0, Math.min(100, s.batteryCapacity));
    $("soc").textContent = fmt(s.batteryCapacity, 0);
    updateRing(soc);
    $("bat-v").textContent = fmt(s.batteryVoltage, 2);
    $("bat-charge").textContent = fmt(s.batteryChargingCurrent, 0);
    $("bat-discharge").textContent = fmt(s.batteryDischargeCurrent, 0);
    const charging = s.batteryChargingCurrent > 0;
    const discharging = s.batteryDischargeCurrent > 0;
    const batState = $("bat-state");
    batState.textContent = charging ? t("charging") : discharging ? t("discharging") : t("idle");
    batState.className = "tag " + (charging ? "state-charge" : discharging ? "state-discharge" : "state-idle");

    // Solar
    $("pv-w").textContent = fmt(s.pvChargingPower, 0);
    $("pv-v").textContent = fmt(s.pvInputVoltage, 1);
    $("pv-a").textContent = fmt(s.pvInputCurrent, 1);

    // Load
    $("load-w").textContent = fmt(s.acOutputActivePower, 0);
    $("load-va").textContent = fmt(s.acOutputApparentPower, 0);
    $("load-pct").textContent = fmt(s.outputLoadPercent, 0) + "%";
    $("out-v").textContent = fmt(s.acOutputVoltage, 1);
    $("out-hz").textContent = fmt(s.acOutputFrequency, 1);

    // Grid
    $("grid-v").textContent = fmt(s.gridVoltage, 1);
    $("grid-hz").textContent = fmt(s.gridFrequency, 1);
    $("temp").textContent = fmt(s.heatSinkTemperature, 0);
  }

  // Device info footer
  const info = snap.info;
  let footer = t("portLabel") + (c.device ? c.device : "—");
  if (info && info.acOutputRatingActivePower) footer += t("ratedLabel") + info.acOutputRatingActivePower + t("ratedUnit");
  $("device-info").textContent = footer;

  // Reflect current settings in controls — but not while unlocked: the user
  // may be picking a value, and each 5s snapshot would stomp their selection.
  const lockedNow = !snap.control || snap.control.locked !== false;
  if (meta && info && lockedNow) reflectControls(info);

  // Lock state + settings/baseline
  applyLockUi(snap.control || { allowControl: false, locked: true });
  renderSettings(snap);

  // Stale detection
  document.body.classList.remove("stale");
  if (staleTimer) clearTimeout(staleTimer);
  staleTimer = setTimeout(() => document.body.classList.add("stale"), 15000);
}

function reflectControls(info) {
  setActiveSegment("ctl-osp", info.outputSourcePriority);
  setActiveSegment("ctl-csp", info.chargerSourcePriority);
  if (Number.isFinite(info.maxChargingCurrent)) $("ctl-mcc").value = String(info.maxChargingCurrent);
  if (Number.isFinite(info.maxAcChargingCurrent)) $("ctl-macc").value = String(info.maxAcChargingCurrent);
}
function setActiveSegment(containerId, value) {
  const box = $(containerId);
  [...box.children].forEach((b) => b.classList.toggle("active", Number(b.dataset.value) === Number(value)));
}

function applyLockUi(control) {
  const locked = control.locked || !control.allowControl;
  const st = $("lock-status");
  const tg = $("lock-toggle");
  if (!control.allowControl) {
    st.textContent = t("lockDisabledServer");
    st.className = "lock-status locked";
    tg.classList.add("hidden");
  } else if (locked) {
    st.textContent = t("lockLocked");
    st.className = "lock-status locked";
    tg.textContent = t("btnUnlock");
    tg.className = "lock-toggle unlock";
    tg.classList.remove("hidden");
  } else {
    st.textContent = t("lockUnlocked");
    st.className = "lock-status unlocked";
    tg.textContent = t("btnLock");
    tg.className = "lock-toggle lock";
    tg.classList.remove("hidden");
  }
  document
    .querySelectorAll("#controls-body .apply, #controls-body .segmented button, #controls-body select")
    .forEach((el) => (el.disabled = locked));
}

function renderSettings(snap) {
  const info = snap.info;
  const base = snap.baseline && snap.baseline.info ? snap.baseline.info : null;
  const note = $("baseline-note");
  if (snap.baseline) {
    const d = new Date(snap.baseline.capturedAt).toLocaleString(t("langLocale"));
    // Build via DOM: deviceId comes from the device and must not hit innerHTML raw.
    note.textContent = "";
    note.append(t("blTakenAt"));
    const b = document.createElement("b");
    b.textContent = d;
    note.append(b, t("blDevice"));
    const code = document.createElement("code");
    code.textContent = snap.baseline.deviceId;
    note.append(code, t("blHint"));
  } else {
    note.textContent = t("blNone");
  }

  const table = $("settings-table");
  table.innerHTML = "";
  if (!info) {
    table.innerHTML = `<div class="srow"><span class="muted">${t("blNotRead")}</span></div>`;
  } else {
    // header
    const head = document.createElement("div");
    head.className = "srow shead";
    head.innerHTML = `<span>${t("thParam")}</span><span>${t("thCurrent")}</span><span>${t("thBaseline")}</span>`;
    table.appendChild(head);
    for (const row of SETTINGS_ROWS) {
      const cur = info[row.key];
      const bas = base ? base[row.key] : undefined;
      const bothNaN = Number.isNaN(Number(cur)) && Number.isNaN(Number(bas));
      const drift = base && !bothNaN && Number(cur) !== Number(bas);
      const el = document.createElement("div");
      el.className = "srow" + (drift ? " drift" : "");
      el.innerHTML =
        `<span class="slabel">${t(row.labelKey)}</span>` +
        `<span class="scur">${settingDisplay(row, cur)}</span>` +
        `<span class="sbase">${base ? settingDisplay(row, bas) : "—"}</span>`;
      table.appendChild(el);
    }
  }

  // flags
  const fl = $("flags-list");
  fl.innerHTML = "";
  const flags = snap.flags && snap.flags.flags ? snap.flags.flags : [];
  if (!flags.length) {
    fl.innerHTML = '<span class="muted">—</span>';
  } else {
    for (const f of flags) {
      const chip = document.createElement("span");
      chip.className = "flag-chip " + (f.enabled ? "on" : "off");
      chip.textContent = (f.enabled ? "✓ " : "✕ ") + tFlag(f.key, f.name);
      fl.appendChild(chip);
    }
  }
}

/* ---------- controls setup ---------- */
async function setupControls() {
  const resp = await fetch("/api/meta");
  if (resp.status === 401) {
    location.href = "/login.html";
    return;
  }
  meta = await resp.json();
  if (meta.authEnabled) $("logout").classList.remove("hidden");

  // Метки сегментов — локализованные (коды из meta, подписи из словаря)
  const localize = (mp, dictKey) =>
    Object.fromEntries(Object.keys(mp).map((k) => [k, codedValue(dictKey, k)]));
  buildSegment("ctl-osp", localize(meta.outputSourcePriority, "osp"), "outputSourcePriority");
  buildSegment("ctl-csp", localize(meta.chargerSourcePriority, "csp"), "chargerSourcePriority");
  buildSelect("ctl-mcc", meta.maxChargingCurrent);
  buildSelect("ctl-macc", meta.maxAcChargingCurrent);

  $("control-note").textContent = t("controlNote");

  document.querySelectorAll(".apply[data-apply]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const type = btn.dataset.apply;
      const sel = $(btn.dataset.select);
      const label = btn.closest(".control").querySelector("label").textContent;
      confirmAndSend(type, Number(sel.value), `${label}: ${sel.value}`);
    });
  });
}

function buildSegment(containerId, map, type) {
  const box = $(containerId);
  box.innerHTML = "";
  Object.entries(map).forEach(([value, label]) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.dataset.value = value;
    b.addEventListener("click", () => confirmAndSend(type, Number(value), label));
    box.appendChild(b);
  });
}
function buildSelect(id, values) {
  const sel = $(id);
  sel.innerHTML = "";
  values.forEach((v) => {
    const o = document.createElement("option");
    o.value = String(v);
    o.textContent = String(v);
    sel.appendChild(o);
  });
}

/* ---------- confirm + send ---------- */
let pendingAction = null;
function confirmAndSend(type, value, label) {
  const control = (lastSnapshot && lastSnapshot.control) || {};
  if (!control.allowControl) return;
  if (control.locked) {
    toast(t("toastLockFirst"), "bad");
    return;
  }
  pendingAction = { type, value };
  $("modal-text").textContent = t("modalConfirm").replace("{label}", label);
  $("modal").classList.remove("hidden");
}
async function doSend() {
  if (!pendingAction) return;
  const action = pendingAction;
  pendingAction = null;
  $("modal").classList.add("hidden");
  try {
    const res = await fetch("/api/control", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(action),
    });
    const data = await res.json();
    if (data.ok) toast(t("toastDone") + data.command + " → ACK", "ok");
    else toast(t("toastRejected") + (data.error || data.reply || "NAK"), "bad");
  } catch (e) {
    toast(t("toastNetErr") + e.message, "bad");
  }
}

/* ---------- websocket ---------- */
let ws = null;
let reconnectDelay = 1000;
function connectWs() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => (reconnectDelay = 1000);
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === "snapshot") render(msg.data);
    } catch {}
  };
  ws.onclose = (ev) => {
    if (ev.code === 4401) {
      // Сессия истекла/отозвана — на страницу входа.
      location.href = "/login.html";
      return;
    }
    setTimeout(connectWs, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.5, 10000);
  };
  ws.onerror = () => ws.close();
}

/* ---------- misc UI wiring ---------- */
function wireUi() {
  document.querySelectorAll(".panel-toggle").forEach((btn) => {
    btn.addEventListener("click", () => {
      const body = $(btn.dataset.target);
      body.classList.toggle("hidden");
      btn.classList.toggle("open");
    });
  });
  $("logout").addEventListener("click", async (e) => {
    e.preventDefault();
    try {
      await fetch("/api/logout", { method: "POST" });
    } catch {}
    location.href = "/login.html";
  });

  $("modal-ok").addEventListener("click", doSend);
  $("modal-cancel").addEventListener("click", () => {
    pendingAction = null;
    $("modal").classList.add("hidden");
  });

  $("lock-toggle").addEventListener("click", async () => {
    const currentlyLocked = (lastSnapshot && lastSnapshot.control && lastSnapshot.control.locked) !== false;
    try {
      const res = await fetch("/api/lock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locked: !currentlyLocked }),
      });
      const data = await res.json();
      if (data.ok) toast(data.locked ? t("toastLocked") : t("toastUnlocked"), data.locked ? "ok" : "");
      else toast(data.error || t("toastError"), "bad");
    } catch (e) {
      toast(t("toastNetErr") + e.message, "bad");
    }
  });

  $("recapture-btn").addEventListener("click", async () => {
    try {
      const res = await fetch("/api/baseline/recapture", { method: "POST" });
      const data = await res.json();
      if (data.ok) toast(t("toastBaselineOk"), "ok");
      else toast(data.error || t("toastError"), "bad");
    } catch (e) {
      toast(t("toastNetErr") + e.message, "bad");
    }
  });
  $("raw-send").addEventListener("click", async () => {
    const cmd = $("raw-cmd").value.trim().toUpperCase();
    if (!cmd) return;
    const out = $("raw-out");
    out.classList.remove("hidden");
    out.textContent = "…";
    try {
      const res = await fetch("/api/raw", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: cmd }),
      });
      const data = await res.json();
      out.textContent = data.ok ? data.reply : t("toastError") + ": " + data.error;
    } catch (e) {
      out.textContent = t("toastNetErr") + e.message;
    }
  });
}

/* ---------- init ---------- */
(async function init() {
  applyStaticI18n();
  buildRing();
  wireUi();
  // Controls need /api/meta; if the server is briefly unavailable, keep the
  // page alive (snapshot + WS still work) and retry meta in the background.
  const trySetupControls = async () => {
    try {
      await setupControls();
    } catch {
      setTimeout(trySetupControls, 5000);
    }
  };
  await trySetupControls();
  try {
    render(await (await fetch("/api/snapshot")).json());
  } catch {}
  connectWs();
})();
