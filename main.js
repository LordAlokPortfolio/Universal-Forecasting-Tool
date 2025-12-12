/* =========================================================
   UNIVERSAL DEMAND FORECASTING SPA — FINAL MAIN.JS
   COMPLETE REPLACEMENT — STRICT-COMPLIANT — CLIENT-ONLY
========================================================= */

/* =========================
   CONSTANTS
========================= */

const HOLIDAYS = new Set([
  "2024-01-01","2024-02-19","2024-03-29","2024-05-20","2024-07-01","2024-09-02","2024-10-14","2024-12-25","2024-12-26",
  "2025-01-01","2025-02-17","2025-04-18","2025-05-19","2025-07-01","2025-09-01","2025-10-13","2025-12-25","2025-12-26",
  "2026-01-01","2026-02-16","2026-04-03","2026-05-18","2026-07-01","2026-09-07","2026-10-12","2026-12-25","2026-12-28"
])

/* =========================
   GLOBAL STATE
========================= */

const state = {
  mode: "analyst",
  rows: [],
  series: [],
  expandedSku: null,
  vendors: [],
  vendorFilter: new Set(),
  planning: {
    windowDays: 90,
    allHistory: false,
    vendorLeadWeeks: {}
  },
  validation: {
    missing: 0,
    nonChrono: false,
    invalid: 0,
    replenish: 0,
    duplicates: 0
  }
}

/* =========================
   DATE / WORKDAY UTILS
========================= */

const isoDate = d => new Date(d + "T00:00:00")

function isWorkingDay(iso) {
  const d = isoDate(iso)
  const w = d.getUTCDay()
  return w !== 0 && w !== 6 && !HOLIDAYS.has(iso)
}

function countWorkingDays(startIso, endIso) {
  const s = isoDate(startIso)
  const e = isoDate(endIso)
  if (e <= s) return 0
  let c = 0
  const d = new Date(s)
  d.setUTCDate(d.getUTCDate() + 1)
  while (d <= e) {
    const iso = d.toISOString().slice(0, 10)
    if (isWorkingDay(iso)) c++
    d.setUTCDate(d.getUTCDate() + 1)
  }
  return c
}

const MONTHS = {
  jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,sept:8,oct:9,nov:10,dec:11
}

function normalizeHeaderDate(label) {
  const clean = String(label).trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(clean)) {
    const d = isoDate(clean)
    return isNaN(d) ? null : { iso: clean, date: d }
  }
  const short = clean.match(/^(\d{1,2})[ \-/](\w{3,})$/i)
  if (short) {
    const day = Number(short[1])
    const month = MONTHS[short[2].toLowerCase()]
    if (Number.isFinite(day) && month >= 0) {
      const year = new Date().getUTCFullYear()
      const d = new Date(Date.UTC(year, month, day))
      const iso = d.toISOString().slice(0, 10)
      return { iso, date: d }
    }
  }
  return null
}

/* =========================
   CSV PARSE & SERIES BUILD
========================= */

function parseCsv(text) {
  const parsed = Papa.parse(text, { header: true, skipEmptyLines: true })
  const fields = parsed.meta.fields || []
  const rows = parsed.data || []
  if (!fields.length) return

  const skuCol = fields.find(f => f.toLowerCase() === "sku") || fields[0]
  const descCol = fields.find(f => f.toLowerCase().includes("desc"))
  const vendorCol = fields.find(f => /vendor|supplier/i.test(f))
  const leadCol = fields.find(f => /lead.*week/i.test(f))

  const dateCandidates = fields
    .map((f, idx) => {
      const norm = normalizeHeaderDate(f)
      return norm ? { header: f, iso: norm.iso, date: norm.date, originalIndex: idx } : null
    })
    .filter(Boolean)
  const sortedDates = [...dateCandidates].sort((a, b) => a.date - b.date)
  const nonChrono = dateCandidates.some((c, i) => c.header !== sortedDates[i]?.header)
  if (sortedDates.length < 2) return

  let missingStock = 0
  let invalidValues = 0
  let replenishmentJumps = 0
  let duplicates = 0
  const seenSku = new Set()
  const map = new Map()

  rows.forEach(r => {
    const sku = String(r[skuCol] || "").trim()
    if (!sku) return
    if (seenSku.has(sku)) duplicates++
    else seenSku.add(sku)

    sortedDates.forEach(col => {
      const rawVal = r[col.header]
      if (rawVal === "" || rawVal === null || rawVal === undefined) missingStock++
      const num = Number(rawVal)
      if (!Number.isFinite(num) || num < 0) invalidValues++
    })

    if (!map.has(sku)) {
      map.set(sku, {
        sku,
        description: descCol ? String(r[descCol] || "") : "",
        vendor: vendorCol ? String(r[vendorCol] || "") : "",
        lead: leadCol ? Number(r[leadCol] || 0) : 0,
        history: []
      })
    }

    const s = map.get(sku)

    for (let i = 1; i < sortedDates.length; i++) {
      const prevCol = sortedDates[i - 1]
      const curCol = sortedDates[i]
      const prev = Number(r[prevCol.header] || 0)
      const cur = Number(r[curCol.header] || 0)
      const moved = Math.max(prev - cur, 0)
      if (cur > prev) replenishmentJumps++
      const wd = countWorkingDays(prevCol.iso, curCol.iso)
      s.history.push({
        date: curCol.iso,
        qty: moved,
        workingDays: wd,
        ratePerWorkingDay: wd > 0 ? moved / wd : 0
      })
    }
  })

  state.validation = {
    missing: missingStock,
    nonChrono,
    invalid: invalidValues,
    replenish: replenishmentJumps,
    duplicates
  }

  state.series = [...map.values()].map(s => {
    const total = s.history.reduce((a, b) => a + b.qty, 0)
    const nonZero = s.history.filter(h => h.qty > 0).length
    const classification =
      total === 0 ? "Dead" :
      nonZero <= 2 ? "Low-Movement" :
      "Active"

    const windows = computeWindows(s.history)
    const forecastStats = computeForecastStats(s.history)

    return {
      ...s,
      totalQty: total,
      classification,
      ...windows,
      forecast: forecastStats.forecast,
      mape: forecastStats.mape
    }
  })

  state.vendors = [...new Set(state.series.map(s => s.vendor).filter(Boolean))]
  state.vendorFilter = new Set(state.vendors)
  state.vendors.forEach(v => {
  state.planning.vendorLeadWeeks[v] = state.planning.vendorLeadWeeks[v] || 0
})
updateVendorFilterUI()
renderVendorLeadEditor()


/* =========================
   ROLLING WINDOWS (BASE)
========================= */

function computeWindows(history) {
  const zero = { raw: 0, workingDays: 0, adjusted: 0 }
  if (!history.length) {
    return { window30: zero, window60: zero, window90: zero }
  }

  const max = isoDate(history.at(-1).date)

  const calc = days => {
    let raw = 0
    let wd = 0
    history.forEach(p => {
      const diff = Math.floor((max - isoDate(p.date)) / 86400000)
      if (diff >= 0 && diff < days) {
        raw += p.qty
        wd += p.workingDays
      }
    })
    return { raw, workingDays: wd, adjusted: wd > 0 ? raw / wd : 0 }
  }

  return {
    window30: calc(30),
    window60: calc(60),
    window90: calc(90)
  }
}

/* =========================
   HISTORICAL USAGE SELECTOR
========================= */

function getAdjustedUsage(s) {
  if (state.planning.allHistory) {
    const wd = s.history.reduce((a, b) => a + b.workingDays, 0)
    return wd > 0 ? s.totalQty / wd : 0
  }
  if (state.planning.windowDays === 30) return s.window30.adjusted
  if (state.planning.windowDays === 60) return s.window60.adjusted
  if (state.planning.windowDays === 90) return s.window90.adjusted
  return s.window90.adjusted
}

/* =========================
   PATTERN & RECOMMENDATION
========================= */

function patternLabel(s) {
  if (s.classification === "Dead") return "No recent usage"
  if (s.classification === "Low-Movement") return "Intermittent usage"

  const base = s.window90.adjusted
  const recent = s.window30.adjusted
  if (base === 0 && recent === 0) return "Stable at low usage"

  const delta = base > 0 ? (recent - base) / base : 0
  if (delta > 0.25) return "Demand increasing"
  if (delta < -0.25) return "Demand slowing"
  return "Stable demand"
}

function recommendationText(s) {
  const daily = getAdjustedUsage(s)
  const weekly = daily * 5
  const lt = s.lead || state.planning.vendorLeadWeeks[s.vendor] || 2
  const buffer = Math.max(1, Math.round(weekly * lt))
  return `Weekly need: ~${Math.round(weekly)} | Buffer: ${buffer} | Cover: ~${lt} weeks`
}

/* =========================
   FORECAST & MAPE
========================= */

function computeForecastStats(history) {
  if (history.length === 0) return { forecast: 0, mape: null }
  const qty = history.map(h => h.qty)
  const forecast = qty.slice(-3).reduce((a, b) => a + b, 0) / Math.min(3, qty.length)
  if (qty.length < 4) return { forecast, mape: null }

  let errors = 0
  let count = 0
  for (let i = 1; i < qty.length; i++) {
    const start = Math.max(0, i - 3)
    const prior = qty.slice(start, i)
    const f = prior.reduce((a, b) => a + b, 0) / prior.length
    const actual = qty[i]
    if (actual !== 0) {
      errors += Math.abs(actual - f) / Math.abs(actual)
      count++
    }
  }
  const mape = count ? (errors / count) * 100 : null
  return { forecast, mape }
}

/* =========================
   DECISION & RISK ENGINE
========================= */

function ewma(series, a = 0.4) {
  let v = 0
  series.forEach(x => v = a * x + (1 - a) * v)
  return v
}

function croston(series) {
  let z = 0, p = 0, q = 0, a = 0.4
  series.forEach(x => {
    if (x > 0) {
      z = a * x + (1 - a) * z
      p = a * q + (1 - a) * p
      q = 1
    } else {
      q++
    }
  })
  return p > 0 ? z / p : 0
}

function selectRate(rates) {
  if (!rates.length) return { rate: 0, type: "none" }
  const zeros = rates.filter(x => x === 0).length / rates.length
  const mean = rates.reduce((a, b) => a + b, 0) / rates.length
  const variance = rates.reduce((a, b) => a + (b - mean) ** 2, 0) / rates.length

  if (zeros > 0.5) return { rate: croston(rates), type: "intermittent" }
  if (variance / (mean || 1) > 1.5) return { rate: ewma(rates), type: "volatile" }
  return { rate: ewma(rates), type: "stable" }
}

function demandAcceleration(s) {
  const base = s.window90.adjusted
  const recent = s.window30.adjusted
  if (base === 0) return recent > 0 ? 1 : 0
  return (recent - base) / base
}

function volatilityScore(rates) {
  if (!rates.length) return 0
  const mean = rates.reduce((a, b) => a + b, 0) / rates.length
  if (mean === 0) return 0
  const variance = rates.reduce((a, b) => a + (b - mean) ** 2, 0) / rates.length
  return Math.sqrt(variance) / mean
}

function decisionMetrics(s) {
  const daily = getAdjustedUsage(s)
  const weekly = daily * 5
  const lt = s.lead || state.planning.vendorLeadWeeks[s.vendor] || 2
  const coverage = weekly > 0 ? s.totalQty / weekly : Infinity

  const rates = s.history.slice(-12).map(h => h.ratePerWorkingDay || 0)
  const sel = selectRate(rates)
  const accel = demandAcceleration(s)
  const vol = volatilityScore(rates)

  const bayesWeight = 0.6
  const baseRisk = weekly === 0 ? 0 : Math.max(0, Math.min(95, 40 + (lt - coverage) * 12 + vol * 20 - accel * 15))
  const risk = Math.round(baseRisk * bayesWeight + (sel.type === "intermittent" ? 20 : 10) * (1 - bayesWeight))

  const decision =
    weekly === 0 ? "Do Not Stock" :
    coverage < lt * 0.8 ? "Order Now" :
    coverage < lt * 1.2 ? "Order Soon" :
    "Watch"

  const runoutMin = weekly > 0 ? Math.max(0, s.totalQty / (weekly * (1 + vol))) : Infinity
  const runoutMax = weekly > 0 ? s.totalQty / (weekly * Math.max(0.5, 1 + accel)) : Infinity
  const volatility = Math.min(100, Math.round(vol * 100))
  const accelerationIndex = Math.round(accel * 100)

  return {
    decision,
    coverage,
    risk,
    runout: { min: runoutMin, max: runoutMax },
    accelerationIndex,
    volatility
  }
}

/* =========================
   ABC GROUPING
========================= */

function computeABC(list) {
  const total = list.reduce((a, b) => a + b.metric, 0) || 1
  let run = 0
  return list.map(x => {
    run += x.metric
    const c = run / total
    return { ...x, abc: c <= 0.8 ? "A" : c <= 0.95 ? "B" : "C" }
  })
}

/* =========================
   VALIDATION PANEL
========================= */

function updateValidationPanel() {
  const set = (id, val) => {
    const el = document.getElementById(id)
    if (el) el.textContent = val
  }
  set("val-missing", state.validation.missing)
  set("val-nonchrono", state.validation.nonChrono ? "Yes" : "No")
  set("val-invalid", state.validation.invalid)
  set("val-replenish", state.validation.replenish)
  set("val-duplicates", state.validation.duplicates || "None")

  const badge = document.getElementById("validation-score")
  if (badge) {
    const issues = state.validation.missing + state.validation.invalid + state.validation.replenish + state.validation.duplicates
    badge.textContent = issues === 0 && !state.validation.nonChrono ? "Data OK" : "Check data"
    badge.className = `badge ${issues === 0 && !state.validation.nonChrono ? "badge-good" : "badge-warn"}`
  }
}

/* =========================
   RENDER — ANALYST
========================= */

function renderAnalyst() {
  const tbody = document.getElementById("summary-body")
  if (!tbody) return
  tbody.innerHTML = ""
  state.series.forEach(s => {
    tbody.insertAdjacentHTML("beforeend", `
      <tr>
        <td>${s.sku}</td>
        <td>${s.classification}</td>
        <td>${s.history.length}</td>
        <td>${s.totalQty}</td>
        <td>${(s.totalQty / Math.max(1, s.history.length)).toFixed(2)}</td>
        <td>${s.mape === null ? "N/A" : s.mape.toFixed(1)}</td>
        <td>${s.forecast.toFixed(2)}</td>
      </tr>
    `)
  })
}

/* =========================
   RENDER — MANAGEMENT
========================= */

function renderManagement() {
  const tbody = document.getElementById("mgmt-body")
  if (!tbody) return
  tbody.innerHTML = ""

    let list = state.series
    .filter(s => {
      const hasVendor = Boolean(s.vendor)
      if (state.vendors.length <= 1) return true
      // Keep untagged SKUs visible; otherwise require selection
      if (!hasVendor) return true
      return state.vendorFilter.has(s.vendor)
    })
    .map(s => ({
      s,
      metric: getAdjustedUsage(s)
    }))
    .sort((a, b) => b.metric - a.metric)


  list = computeABC(list)
  if (state.expandedSku && !list.some(x => x.s.sku === state.expandedSku)) {
    state.expandedSku = null
  }

  let currentGroup = ""
  list.forEach(({ s, metric, abc }) => {
    if (abc !== currentGroup) {
      currentGroup = abc
      tbody.insertAdjacentHTML("beforeend", `
        <tr class="sep"><td colspan="4">${abc} items</td></tr>
      `)
    }

    const d = decisionMetrics(s)

    tbody.insertAdjacentHTML("beforeend", `
      <tr class="data" data-sku="${s.sku}">
        <td>
          <span class="badge badge-${abc.toLowerCase()}">${abc}</span>
          ${s.sku}
          <div class="badge ${d.decision === "Order Now" ? "badge-warn" : "badge-good"}">${d.decision}</div>
        </td>
        <td>${patternLabel(s)}</td>
        <td>${metric.toFixed(4)}</td>
        <td>${recommendationText(s)}</td>
      </tr>
    `)

    if (state.expandedSku === s.sku) renderInlineDetail(s)
  })

  tbody.onclick = e => {
    const row = e.target.closest("tr.data")
    if (!row) return
    const sku = row.dataset.sku
    state.expandedSku = state.expandedSku === sku ? null : sku
    renderManagement()
  }
}

function renderInlineDetail(s) {
  const tbody = document.getElementById("mgmt-body")
  const rows = [...tbody.querySelectorAll("tr.data")]
  const anchor = rows.find(r => r.dataset.sku === s.sku)
  if (!anchor) return

  const d = decisionMetrics(s)
  const formatRunout = r => (!isFinite(r.min) || !isFinite(r.max)) ? "N/A" : `${r.min.toFixed(1)} - ${r.max.toFixed(1)} wks`

  anchor.insertAdjacentHTML("afterend", `
    <tr class="inline-detail">
      <td colspan="4">
        <strong>${s.sku}</strong> — ${s.description || ""}<br>
        Vendor: ${s.vendor || "Unspecified"}<br>
        Historical window: ${state.planning.allHistory ? "All" : `Last ${state.planning.windowDays} days`}<br>
        Adj usage / wd: ${getAdjustedUsage(s).toFixed(4)}<br>
        Coverage vs LT: ${d.coverage === Infinity ? "N/A" : d.coverage.toFixed(1)} weeks<br>
        Runout window: ${formatRunout(d.runout)}<br>
        Stockout risk: ${d.risk}%<br>
        Acceleration index: ${d.accelerationIndex}%<br>
        Volatility score: ${d.volatility}<br>
        Decision: <strong>${d.decision}</strong>
      </td>
    </tr>
  `)
}

/* =========================
   VENDOR FILTER UI
========================= */

function updateVendorFilterUI() {
  const wrap = document.getElementById("vendor-filter")
  const select = document.getElementById("vendor-filter-select")
  if (!wrap || !select) return

  if (state.vendors.length <= 1) {
    wrap.classList.add("hidden")
    state.vendorFilter = new Set(state.vendors)
    return
  }

  wrap.classList.remove("hidden")
  select.innerHTML = ""
  state.vendors.forEach(v => {
    const opt = document.createElement("option")
    opt.value = v
    opt.textContent = v
    opt.selected = true
    select.appendChild(opt)
  })
  state.vendorFilter = new Set(state.vendors)

  select.onchange = () => {
    const chosen = new Set([...select.options].filter(o => o.selected).map(o => o.value))
    state.vendorFilter = chosen.size ? chosen : new Set(state.vendors)
    renderManagement()
  }
}

/* =========================
   RENDER DISPATCH
========================= */

function renderAll() {
  renderAnalyst()
  renderManagement()
}

/* =========================
   EVENTS & MODE
========================= */

function setMode(mode) {
  state.mode = mode
  const analyst = document.getElementById("analyst-table")
  const mgmt = document.getElementById("management-layout")
  const about = document.getElementById("about-page")
  const validation = document.getElementById("validation-panel")
  const fileArea = document.getElementById("file-area")

  if (analyst) analyst.classList.toggle("hidden", mode !== "analyst")
  if (mgmt) mgmt.classList.toggle("hidden", mode !== "management")
  if (validation) validation.classList.toggle("hidden", mode === "about")
  if (fileArea) fileArea.classList.toggle("hidden", mode === "about")
  if (about) about.classList.toggle("hidden", mode !== "about")

  document.querySelectorAll(".toggle-button").forEach(btn => {
    btn.classList.toggle("active", btn.id === `btn-${mode}`)
  })
}


function renderVendorLeadEditor() {
  const wrap = document.getElementById("vendor-lead-editor")
  if (!wrap) return
  if (!state.vendors.length) {
    wrap.innerHTML = '<div class="muted">Upload a CSV to configure vendor lead time.</div>'
    return
  }
  wrap.innerHTML = `
    <div class="vendor-lead-editor-title">Vendor lead time (weeks)</div>
    ${state.vendors.map(v => `
      <div class="vendor-lead-row">
        <span>${v}</span>
        <input type="number" min="0" step="0.5" value="${state.planning.vendorLeadWeeks[v] || ""}" data-vendor="${v}" />
      </div>
    `).join("")}
  `
  wrap.querySelectorAll("input[data-vendor]").forEach(inp => {
    inp.oninput = e => {
      const v = e.target.getAttribute("data-vendor")
      const val = Number(e.target.value)
      if (Number.isFinite(val)) state.planning.vendorLeadWeeks[v] = val
      renderManagement()
    }
  })
}



document.addEventListener("DOMContentLoaded", () => {
  const btnAnalyst = document.getElementById("btn-analyst")
  const btnManagement = document.getElementById("btn-management")
  const btnAbout = document.getElementById("btn-about")
  if (btnAnalyst) btnAnalyst.onclick = () => setMode("analyst")
  if (btnManagement) btnManagement.onclick = () => setMode("management")
  if (btnAbout) btnAbout.onclick = () => setMode("about")

  const slider = document.getElementById("hist-slider")
  if (slider) {
    slider.oninput = e => {
      state.planning.windowDays = Number(e.target.value)
      state.planning.allHistory = false
      const label = document.getElementById("hist-label")
      if (label) label.textContent = `Last ${state.planning.windowDays} days`
      const allChk = document.getElementById("hist-all")
      if (allChk) allChk.checked = false
      renderManagement()
    }
  }

  const allToggle = document.getElementById("hist-all")
  if (allToggle) {
    allToggle.onchange = e => {
      state.planning.allHistory = e.target.checked
      const label = document.getElementById("hist-label")
      if (label) label.textContent = e.target.checked ? "All history" : `Last ${state.planning.windowDays} days`
      renderManagement()
    }
  }

  const fileInput = document.getElementById("file-input")
  if (fileInput) {
    fileInput.addEventListener("change", e => {
      const f = e.target.files?.[0]
      if (!f) return
      const r = new FileReader()
      r.onload = () => parseCsv(String(r.result))
      r.readAsText(f)
    })
  }

  const label = document.getElementById("hist-label")
  if (label) label.textContent = "Last 90 days"

  setMode("analyst")
})
/* ========================================================= */
/*   END OF UNIVERSAL DEMAND FORECASTING SPA — MAIN.JS
   ========================================================= */