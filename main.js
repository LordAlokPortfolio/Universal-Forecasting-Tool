"use strict"

/* =========================
   CONSTANTS & STATE
   ========================= */

const HOLIDAYS = new Set([
  "2024-01-01","2024-02-19","2024-03-29","2024-05-20","2024-07-01","2024-09-02","2024-10-14","2024-12-25","2024-12-26",
  "2025-01-01","2025-02-17","2025-04-18","2025-05-19","2025-07-01","2025-09-01","2025-10-13","2025-12-25","2025-12-26",
  "2026-01-01","2026-02-16","2026-04-03","2026-05-18","2026-07-01","2026-09-07","2026-10-12","2026-12-25","2026-12-28"
])

const MONTH_MAP = {
  jan:1,feb:2,mar:3,apr:4,may:5,jun:6,
  jul:7,aug:8,sep:9,oct:10,nov:11,dec:12
}

const state = {
  series: [],
  mode: "analyst",
  validation: null,
  planning: {
    window: 90,
    vendorLeadWeeks: {},
    hasVendorColumn: false,
    hasLeadColumn: false
  }
}

/* =========================
   DATE / WORKDAY HELPERS
   ========================= */

function parseIsoDate(d) { return new Date(d + "T00:00:00") }

function formatIso(y,m,day) {
  const mm = m < 10 ? "0"+m : String(m)
  const dd = day < 10 ? "0"+day : String(day)
  return `${y}-${mm}-${dd}`
}

function isWorkingDay(iso) {
  const d = parseIsoDate(iso)
  const dow = d.getUTCDay()
  if (dow === 0 || dow === 6) return false
  if (HOLIDAYS.has(iso)) return false
  return true
}

function countWorkingDays(startIso,endIso) {
  const start = parseIsoDate(startIso)
  const end = parseIsoDate(endIso)
  if (end <= start) return 0
  let count = 0
  const d = new Date(start.getTime())
  d.setUTCDate(d.getUTCDate()+1)
  while (d <= end) {
    const iso = d.toISOString().slice(0,10)
    if (isWorkingDay(iso)) count += 1
    d.setUTCDate(d.getUTCDate()+1)
  }
  return count
}

/* =========================
   WINDOW / USAGE (UNCHANGED)
   ========================= */

function computeWindows(history) {
  const zero = { raw:0, workingDays:0, adjusted:0 }
  if (history.length === 0) return { window30:zero, window60:zero, window90:zero }

  const maxIso = history[history.length-1].date
  const maxDate = parseIsoDate(maxIso)

  function windowFor(days) {
    let raw = 0
    let wd = 0
    for (const p of history) {
      const d = parseIsoDate(p.date)
      const diff = Math.floor((maxDate - d) / 86400000)
      if (diff >= 0 && diff < days) {
        raw += p.qty
        wd += p.workingDays
      }
    }
    return { raw, workingDays: wd, adjusted: wd > 0 ? raw / wd : 0 }
  }

  return {
    window30: windowFor(30),
    window60: windowFor(60),
    window90: windowFor(90)
  }
}

function getPlanningUsage(s) {
  const w = state.planning.window
  if (w === 30) return s.window30.adjusted || 0
  if (w === 60) return s.window60.adjusted || 0
  if (w === 90) return s.window90.adjusted || 0
  return s.avgPerWorkingDay || 0
}

function usageLabel(cls) {
  if (cls === "Active") return "Regular mover"
  if (cls === "Low-Movement") return "Slow mover"
  return "No recent usage"
}

function patternLabel(s) {
  if (s.classification === "Dead") return "No recent usage"
  if (s.classification === "Low-Movement") return "Infrequent usage"

  const base = s.window90.adjusted
  const recent = s.window30.adjusted
  if (base === 0 && recent === 0) return "Stable at low usage"

  const ratio = base > 0 ? (recent - base) / base : 0
  if (ratio > 0.25) return "Demand increasing (last 30d > 90d)"
  if (ratio < -0.25) return "Demand slowing (last 30d < 90d)"
  return "Stable demand"
}

function recommendation(s) {
  const adj = getPlanningUsage(s)

  if (s.classification === "Dead" || (s.window90.raw === 0 && s.totalQty === 0)) {
    return "Hold at zero and order only when a real requirement appears."
  }
  if (s.classification === "Low-Movement") {
    return `Keep minimal stock based on roughly ${adj.toFixed(2)} units per working day.`
  }

  const weeklyNeed = adj * 5
  const vendor = s.vendor || ""
  let leadWeeks = vendor ? (state.planning.vendorLeadWeeks[vendor] || 0) : 0
  if (!leadWeeks || leadWeeks <= 0) leadWeeks = 2

  const buffer = Math.max(Math.round(weeklyNeed * leadWeeks),1)

  if (vendor) {
    return `Plan for about ${Math.round(weeklyNeed)} units per week and keep ${buffer} units (~${leadWeeks} weeks of cover for ${vendor}).`
  }
  return `Plan for about ${Math.round(weeklyNeed)} units per week and keep ${buffer} units (~${leadWeeks} weeks of cover).`
}

/* =========================
   CSV PARSE (UNCHANGED)
   ========================= */

function parseCsv(text) {
  const out = Papa.parse(text,{header:true,skipEmptyLines:true})
  const fields = out.meta.fields || []
  const rows = out.data
  const errorBox = document.getElementById("error-box")
  if (errorBox) errorBox.textContent = ""

  if (fields.length === 0) {
    state.series = []
    state.validation = null
    renderAnalystTable()
    renderManagementRolodex()
    renderValidation()
    renderVendorLeadEditor()
    return
  }

  const headerInfos = []
  const isoRegex = /^\d{4}-\d{2}-\d{2}$/
  const shortRegex = /^\s*(\d{1,2})[-\/\s](Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s*$/i

  fields.forEach((f,idx) => {
    const t = String(f).trim()
    let isDate = false, iso, sd, sm
    if (isoRegex.test(t)) { isDate = true; iso = t }
    else {
      const m = t.match(shortRegex)
      if (m) {
        isDate = true
        sd = parseInt(m[1],10)
        sm = MONTH_MAP[m[2].toLowerCase().slice(0,3)]
      }
    }
    headerInfos.push({field:f,index:idx,isDate,iso,shortDay:sd,shortMonth:sm})
  })

  const dateHeaders = headerInfos.filter(h=>h.isDate)
  const shortHeaders = dateHeaders.filter(h=>!h.iso && h.shortMonth && h.shortDay)

  if (shortHeaders.length > 0) {
    const currentYear = new Date().getFullYear()
    let year = currentYear
    let prevMonth = null
    shortHeaders.sort((a,b)=>a.index-b.index).forEach(h=>{
      if (prevMonth !== null && h.shortMonth < prevMonth) year += 1
      prevMonth = h.shortMonth
      h.iso = formatIso(year,h.shortMonth,h.shortDay)
    })
  }

  const dateHeadersIso = dateHeaders.filter(h=>h.iso)
  if (dateHeadersIso.length === 0) {
    state.series = []
    state.validation = null
    renderAnalystTable()
    renderManagementRolodex()
    renderValidation()
    renderVendorLeadEditor()
    return
  }

  const dateSorted = dateHeadersIso.slice().sort((a,b)=>Date.parse(a.iso)-Date.parse(b.iso))

  const skuCol = fields.find(f=>f.toLowerCase()==="sku") || fields[0]
  const descCol = fields.find(f=>f.toLowerCase().includes("desc")) || ""

  const vendorCol = fields.find(f=>{
    const l=f.toLowerCase()
    return l.includes("vendor") || l.includes("supplier")
  }) || ""

  const leadCol = fields.find(f=>{
    const l=f.toLowerCase()
    return l.includes("lead") && l.includes("week")
  }) || ""

  state.planning.hasVendorColumn = !!vendorCol
  state.planning.hasLeadColumn = !!leadCol
  state.planning.vendorLeadWeeks = {}

  const validation = {
    missingStockCells:0,
    nonChronological:false,
    invalidStockCells:0,
    replenishmentEvents:0,
    duplicateSkus:[]
  }

  const seen = new Map()
  const dup = new Set()
  const series = []

  rows.forEach(row=>{
    const sku = String(row[skuCol]||"").trim()
    if (!sku) return

    const c = (seen.get(sku)||0)+1
    seen.set(sku,c)
    if (c>1) dup.add(sku)

    const vendor = vendorCol ? String(row[vendorCol]||"").trim() : ""
    if (vendor && !state.planning.vendorLeadWeeks.hasOwnProperty(vendor)) {
      state.planning.vendorLeadWeeks[vendor] = 0
    }
    if (vendor && leadCol) {
      const lt = Number(row[leadCol])
      if (Number.isFinite(lt) && lt>0) {
        const prev = state.planning.vendorLeadWeeks[vendor]
        state.planning.vendorLeadWeeks[vendor] = prev ? (prev+lt)/2 : lt
      }
    }

    dateHeadersIso.forEach(h=>{
      const txt = String(row[h.field]??"").trim()
      if (txt==="") validation.missingStockCells += 1
      else {
        const n = Number(txt)
        if (!Number.isFinite(n) || n<0) validation.invalidStockCells += 1
      }
    })

    const history = []
    for (let i=1;i<dateSorted.length;i+=1) {
      const prev = dateSorted[i-1]
      const curr = dateSorted[i]
      const p = Number(row[prev.field]||0)
      const cqty = Number(row[curr.field]||0)
      if (Number.isFinite(p) && Number.isFinite(cqty) && cqty>p) {
        validation.replenishmentEvents += 1
      }
      const moved = Math.max(p-cqty,0)
      const wd = countWorkingDays(prev.iso,curr.iso)
      history.push({
        date: curr.iso,
        qty: moved,
        workingDays: wd,
        ratePerWorkingDay: wd>0 ? moved/wd : 0
      })
    }

    const totalQty = history.reduce((s,p)=>s+p.qty,0)
    const totalWorking = history.reduce((s,p)=>s+p.workingDays,0)
    const periods = history.length
    const positivePeriods = history.filter(p=>p.qty>0).length

    let classification = "Active"
    if (totalQty===0) classification="Dead"
    else if (positivePeriods<=2) classification="Low-Movement"

    const {window30,window60,window90} = computeWindows(history)

    series.push({
      sku,
      description: descCol ? String(row[descCol]||"").trim() : "",
      vendor,
      history,
      totalQty,
      periods,
      positivePeriods,
      classification,
      avgDemand: periods>0 ? totalQty/periods : 0,
      avgPerWorkingDay: totalWorking>0 ? totalQty/totalWorking : 0,
      window30,window60,window90
    })
  })

  validation.duplicateSkus = Array.from(dup).sort()
  state.series = series
  state.validation = validation

  renderAnalystTable()
  renderManagementRolodex()
  renderValidation()
  renderVendorLeadEditor()
}

/* =========================
   ANALYST TABLE (UNCHANGED)
   ========================= */

function renderAnalystTable() {
  const tbody = document.getElementById("summary-body")
  if (!tbody) return
  tbody.innerHTML = ""
  state.series.forEach(s=>{
    const tr = document.createElement("tr")
    tr.onclick = ()=>renderDetail(s)
    tr.innerHTML = `
      <td>${s.sku}</td>
      <td>${s.classification}</td>
      <td>${s.periods}</td>
      <td>${s.totalQty}</td>
      <td>${s.avgDemand.toFixed(2)}</td>
      <td>—</td>
      <td>—</td>
    `
    tbody.appendChild(tr)
  })
}

/* =========================
   MANAGEMENT ROLODEX (NEW UI ONLY)
   ========================= */

function renderManagementRolodex() {
  const container = document.getElementById("mgmt-rolodex")
  if (!container) return
  container.innerHTML = ""

  const groups = {
    A: state.series.filter(s=>s.classification==="Active"),
    B: state.series.filter(s=>s.classification==="Low-Movement"),
    C: state.series.filter(s=>s.classification==="Dead")
  }

  ;["A","B","C"].forEach(letter=>{
    groups[letter].forEach(s=>{
      const card = document.createElement("div")
      card.className = `rolodex-card card-${letter}` + (letter==="C" ? " card-collapsed" : "")
      card.onclick = ()=>renderDetail(s)

      const header = `
        <div class="card-header">
          <div class="card-title">${s.sku}</div>
          <div class="badge badge-${letter}">${letter}</div>
        </div>
      `

      const body = `
        <div class="card-body">
          <div>${patternLabel(s)}</div>
          <div class="muted">Adj usage (${state.planning.window}d): ${getPlanningUsage(s).toFixed(4)} / working day</div>
        </div>
      `

      const footer = `
        <div class="card-footer">
          ${recommendation(s)}
        </div>
      `

      card.innerHTML = header + body + footer

      if (letter==="C") {
        const exp = document.createElement("div")
        exp.className = "card-expand"
        exp.textContent = "Show details"
        exp.onclick = e=>{
          e.stopPropagation()
          card.classList.toggle("card-collapsed")
          exp.textContent = card.classList.contains("card-collapsed")
            ? "Show details"
            : "Hide details"
        }
        card.appendChild(exp)
      }

      container.appendChild(card)
    })
  })
}

/* =========================
   DETAIL VIEW (UNCHANGED)
   ========================= */

function renderDetail(s) {
  const box = document.getElementById("detail-content")
  if (!box) return

  if (state.mode==="about") {
    box.textContent = "About mode active."
    return
  }

  const adj = getPlanningUsage(s)
  box.innerHTML = `
    <div class="section"><strong>${s.sku}</strong> ${s.description||""}</div>
    <div class="section">
      <strong>Usage pattern:</strong> ${patternLabel(s)} (${usageLabel(s.classification)})<br>
      <strong>Adj usage (${state.planning.window}d):</strong> ${adj.toFixed(4)}
    </div>
    <div class="section">
      <strong>Recommendation</strong><br>
      ${recommendation(s)}
    </div>
  `
}

/* =========================
   VALIDATION (UNCHANGED)
   ========================= */

function renderValidation() {
  const scoreEl = document.getElementById("validation-score")
  const missingEl = document.getElementById("val-missing")
  const nonChronoEl = document.getElementById("val-nonchrono")
  const invalidEl = document.getElementById("val-invalid")
  const replEl = document.getElementById("val-replenish")
  const dupEl = document.getElementById("val-duplicates")
  if (!scoreEl) return

  const v = state.validation
  if (!v) {
    scoreEl.textContent = "Waiting for data"
    scoreEl.className = "badge-good"
    missingEl.textContent = "0"
    nonChronoEl.textContent = "No"
    invalidEl.textContent = "0"
    replEl.textContent = "0"
    dupEl.textContent = "None"
    return
  }

  const issues =
    v.missingStockCells>0 ||
    v.nonChronological ||
    v.invalidStockCells>0 ||
    v.replenishmentEvents>0 ||
    v.duplicateSkus.length>0

  scoreEl.textContent = issues ? "Needs Attention" : "Good"
  scoreEl.className = issues ? "badge-warn" : "badge-good"
  missingEl.textContent = String(v.missingStockCells)
  nonChronoEl.textContent = v.nonChronological ? "Yes" : "No"
  invalidEl.textContent = String(v.invalidStockCells)
  replEl.textContent = String(v.replenishmentEvents)
  dupEl.textContent = v.duplicateSkus.length>0 ? v.duplicateSkus.join(", ") : "None"
}

/* =========================
   PLANNING CONTROLS
   ========================= */

function setPlanningWindow(days) {
  state.planning.window = days
  updatePlanningWindowUi()
  if (state.mode==="management") {
    renderManagementRolodex()
    const d = document.getElementById("detail-content")
    if (d) d.textContent = "Click a SKU."
  }
}

function updatePlanningWindowUi() {
  ;[30,60,90].forEach(d=>{
    const b = document.getElementById(`btn-win-${d}`)
    if (b) b.classList.toggle("active",state.planning.window===d)
  })
}

function renderVendorLeadEditor() {
  const container = document.getElementById("vendor-lead-editor")
  if (!container) return
  if (!state.planning.hasVendorColumn) {
    container.innerHTML = '<div class="muted">No vendor column detected.</div>'
    return
  }
  container.innerHTML = ""
}

/* =========================
   MODE SWITCH
   ========================= */

function setMode(mode) {
  state.mode = mode
  const a = document.getElementById("analyst-table")
  const m = document.getElementById("management-table")
  const v = document.getElementById("validation-panel")
  const d = document.getElementById("detail-view")
  const about = document.getElementById("about-page")

  document.getElementById("btn-analyst")?.classList.toggle("active",mode==="analyst")
  document.getElementById("btn-management")?.classList.toggle("active",mode==="management")
  document.getElementById("btn-about")?.classList.toggle("active",mode==="about")

  if (mode==="about") {
    a?.classList.add("hidden")
    m?.classList.add("hidden")
    v?.classList.add("hidden")
    d?.classList.add("hidden")
    about?.classList.remove("hidden")
    return
  }

  about?.classList.add("hidden")
  d?.classList.remove("hidden")

  if (mode==="analyst") {
    a?.classList.remove("hidden")
    m?.classList.add("hidden")
    v?.classList.remove("hidden")
    renderAnalystTable()
    renderValidation()
  } else {
    a?.classList.add("hidden")
    m?.classList.remove("hidden")
    v?.classList.add("hidden")
    renderManagementRolodex()
  }
}

/* =========================
   INIT
   ========================= */

document.addEventListener("DOMContentLoaded",()=>{
  document.getElementById("btn-analyst")?.onclick=()=>setMode("analyst")
  document.getElementById("btn-management")?.onclick=()=>setMode("management")
  document.getElementById("btn-about")?.onclick=()=>setMode("about")

  document.getElementById("file-input")?.addEventListener("change",e=>{
    const f = e.target.files?.[0]
    if (!f) return
    const r = new FileReader()
    r.onload = ()=>parseCsv(String(r.result))
    r.readAsText(f)
  })

  setMode("analyst")
})
