"use strict"
function renderAbout(){
  const el = document.getElementById("about-view")
  if (!el) return
  el.innerHTML = ABOUT_TEXT
}
function daysBetween(a, b){
  const d1 = new Date(a)
  const d2 = new Date(b)
  if (isNaN(d1) || isNaN(d2)) return null
  return Math.round((d2 - d1) / 86400000)
}

function median(arr){
  if (!arr || arr.length === 0) return 0
  const s = [...arr].sort((a,b)=>a-b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m-1] + s[m]) / 2
}

function formatESTDate(date) {
  if (!(date instanceof Date)) return "None"
  return date.toLocaleDateString("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "short",
    day: "2-digit"
  })
}


/* =========================
   CONSTANTS
   ========================= */

const HOLIDAYS = new Set([
  "2024-01-01","2024-02-19","2024-03-29","2024-05-20","2024-07-01","2024-09-02","2024-10-14","2024-12-25","2024-12-26",
  "2025-01-01","2025-02-17","2025-04-18","2025-05-19","2025-07-01","2025-09-01","2025-10-13","2025-12-25","2025-12-26",
  "2026-01-01","2026-02-16","2026-04-03","2026-05-18","2026-07-01","2026-09-07","2026-10-12","2026-12-25","2026-12-28"
])

const MONTH_MAP = {jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12}

// ðŸ”’ Horizon policy (NON-NEGOTIABLE)
const WEEKS_PER_MONTH = 4.33
const FORWARD_HORIZON_MONTHS = 24
const FORWARD_HORIZON_WEEKS = FORWARD_HORIZON_MONTHS * WEEKS_PER_MONTH

/* =========================
   STATE
   ========================= */

const state = {
  demand: [],
  supply: {},
  leadTimes: {},
  mode: "analyst",
  planning: { window: 90 },
  validation: null
}

/* =========================
   DATE / WORKDAY HELPERS
   ========================= */

function parseIsoDate(d){ return new Date(d+"T00:00:00") }

function formatIso(y,m,day){
  const mm=m<10?"0"+m:String(m)
  const dd=day<10?"0"+day:String(day)
  return `${y}-${mm}-${dd}`
}

function isWorkingDay(iso){
  const d=parseIsoDate(iso)
  const dow=d.getUTCDay()
  if(dow===0||dow===6)return false
  if(HOLIDAYS.has(iso))return false
  return true
}

function countWorkingDays(startIso,endIso){
  const start=parseIsoDate(startIso)
  const end=parseIsoDate(endIso)
  if(end<=start)return 0
  let count=0
  const d=new Date(start.getTime())
  d.setUTCDate(d.getUTCDate()+1)
  while(d<=end){
    const iso=d.toISOString().slice(0,10)
    if(isWorkingDay(iso))count+=1
    d.setUTCDate(d.getUTCDate()+1)
  }
  return count
}

/* =========================
   WINDOW / USAGE
   ========================= */

function computeWindows(history){
  const zero={raw:0,workingDays:0,adjusted:0}
  if(history.length===0)return{window30:zero,window60:zero,window90:zero}

  const maxIso=history[history.length-1].date
  const maxDate=parseIsoDate(maxIso)

  function windowFor(days){
    let raw=0,wd=0
    for(const p of history){
      const d=parseIsoDate(p.date)
      const diff=Math.floor((maxDate-d)/86400000)
      if(diff>=0&&diff<days){ raw+=p.qty; wd+=p.workingDays }
    }
    return {raw,workingDays:wd,adjusted:wd>0?raw/wd:0}
  }

  return {
    window30:windowFor(30),
    window60:windowFor(60),
    window90:windowFor(90)
  }
}

function getPlanningUsage(s){
  const w=state.planning.window
  if(w===30)return s.window30.adjusted||0
  if(w===60)return s.window60.adjusted||0
  if(w===90)return s.window90.adjusted||0
  return s.avgPerWorkingDay||0
}

function usageLabel(cls){
  if(cls==="A")return"Regular mover"
  if(cls==="B")return"Slow mover"
  return"No recent usage"
}

function patternLabel(s){
  if(s.class==="C")return"No recent usage"
  const base=s.window90.adjusted
  const recent=s.window30.adjusted
  if(base===0&&recent===0)return"Stable at low usage"
  const ratio=base>0?(recent-base)/base:0
  if(ratio>0.25)return"Demand increasing (last 30d > 90d)"
  if(ratio<-0.25)return"Demand slowing (last 30d < 90d)"
  return"Stable demand"
}


function recommendation(s) {
  // Guard: no demand
  if (!s.history || s.history.length === 0 || s.avgPerWorkingDay <= 0) {
    return "NO ACTION: No meaningful consumption history."
  }

  const vendor = s.vendor || "supplier"

  // =========================
  // CURRENT STOCK (LATEST ≤ TODAY)
  // =========================
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  if (
    s.currentStock === null ||
    isNaN(s.currentStock) ||
    (s.currentStockDate && new Date(s.currentStockDate) > today)
  ) {
    return `
<strong>INSUFFICIENT INVENTORY VISIBILITY</strong><br>
Latest usable cycle count must be dated <strong>on or before today</strong>.<br>
Recent usage: <strong>${s.avgPerWorkingDay.toFixed(2)} units/day</strong>.<br>
<strong>Action:</strong> Ensure the cycle-count CSV uses the most recent
count dated ≤ today (future dates are ignored).
`.trim()
  }

  const onHand = s.currentStock

  // =========================
  // OBSERVED LEAD TIME
  // =========================
  let leadWeeks = state.leadTimes[vendor]?.length
    ? median(state.leadTimes[vendor])
    : 0

  if (!leadWeeks || leadWeeks <= 0) leadWeeks = 2
  const leadDays = Math.round(leadWeeks * 7)

  // =========================
  // DEMAND
  // =========================
  const dailyUsage = s.avgPerWorkingDay
  const weeklyUsage = dailyUsage * 5
  const leadTimeDemand = dailyUsage * leadDays

  // =========================
  // 24-MONTH PLANNING
  // =========================
  const WORKING_DAYS_PER_YEAR = 260
  const plannedQty24m = dailyUsage * WORKING_DAYS_PER_YEAR * 2

  // =========================
  // DECISION
  // =========================
  let decision
  let reason

  if (onHand < leadTimeDemand) {
    decision = "PLACE ORDER"
    reason = "Current stock will not cover supplier lead time demand."
  } else {
    decision = "NO IMMEDIATE ORDER"
    reason = "Current stock is sufficient to cover supplier lead time demand."
  }

  // =========================
  // LEAD-TIME COVERAGE (NEW, CLEAR)
  // =========================
  let coverageSentence = "Lead-time coverage: Insufficient data."
  if (dailyUsage > 0 && leadDays > 0) {
    const daysOfCover = onHand / dailyUsage
    coverageSentence =
      daysOfCover >= leadDays
        ? "Lead-time coverage: Inventory covers supplier lead time demand."
        : "Lead-time coverage: Inventory does NOT cover supplier lead time demand."
  }

  return `
<strong>${decision}</strong><br>
Right now we have <strong>${onHand} units</strong> on hand.<br>
Recent usage: <strong>${dailyUsage.toFixed(2)} units/day</strong>
(~${Math.round(weeklyUsage)} per week).<br>
Observed supplier lead time: <strong>${leadDays} working days</strong> (${vendor}).<br>
Expected consumption during lead time: <strong>~${Math.round(leadTimeDemand)} units</strong>.<br>
<strong>${coverageSentence}</strong><br>
<strong>24-month planning view:</strong> expected consumption
<strong>~${Math.round(plannedQty24m)} units</strong> over the next 24 months.<br>
<strong>Decision basis:</strong> ${reason}
`.trim()
}



/* =========================
   CSV LOADING
   ========================= */

function loadCsv(file,cb){
  Papa.parse(file,{header:true,skipEmptyLines:true,complete:r=>cb(r.data)})
}

/* =========================
   DEMAND PARSE (v1 COMPLETE)
   ========================= */
const isoRegex = /^\d{4}-\d{2}-\d{2}$/
const slashRegex = /^\d{1,2}\/\d{1,2}\/\d{2,4}$/
const excelNumRegex = /^\d{5}$/
const shortRegex = /^\s*(\d{1,2})[-\/\s](Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s*$/i


function parseDemand(rows){
  if(!rows||rows.length===0)return

  const fields=Object.keys(rows[0])
  const headerInfos=[]
  fields.forEach((f,idx)=>{
    const t=f.trim()
    let isDate=false,iso,sd,sm
    if (isoRegex.test(t)) {
  isDate = true
  iso = t
} else if (slashRegex.test(t)) {
  const d = new Date(t)
  if (!isNaN(d)) {
    isDate = true
    iso = d.toISOString().slice(0,10)
  }
} else if (excelNumRegex.test(t)) {
  const d = new Date((Number(t) - 25569) * 86400 * 1000)
  isDate = true
  iso = d.toISOString().slice(0,10)
}

    else{
      const m=t.match(shortRegex)
      if(m){ isDate=true; sd=parseInt(m[1],10); sm=MONTH_MAP[m[2].toLowerCase().slice(0,3)] }
    }
    headerInfos.push({field:f,index:idx,isDate,iso,sd,sm})
  })

  const dateHeaders=headerInfos.filter(h=>h.isDate)
  const shortHeaders=dateHeaders.filter(h=>!h.iso&&h.sm&&h.sd)

  if(shortHeaders.length){
    let year=new Date().getFullYear(),prev=null
    shortHeaders.sort((a,b)=>a.index-b.index).forEach(h=>{
      if(prev!==null&&h.sm<prev)year++
      prev=h.sm
      h.iso=formatIso(year,h.sm,h.sd)
    })
  }

  const dateSorted=dateHeaders.filter(h=>h.iso).sort((a,b)=>Date.parse(a.iso)-Date.parse(b.iso))
  const skuCol = fields.find(f=>f.toLowerCase()==="sku") || fields[0]
  const descCol = fields.find(f=>f.toLowerCase().includes("desc")) || ""
  const vendorCol = fields.find(f=>{
    const l = f.toLowerCase()
    return l.includes("vendor") || l.includes("supplier")
  }) || ""

  const seen=new Map(),dup=new Set()
  const validation={missingStockCells:0,invalidStockCells:0,replenishmentEvents:0,duplicateSkus:[]}
  const series=[]

  rows.forEach(row=>{
    const sku=String(row[skuCol]||"").trim()
    if(!sku)return
    const c=(seen.get(sku)||0)+1; seen.set(sku,c); if(c>1)dup.add(sku)
    const todayIso = new Date().toISOString().slice(0,10)
    const validDates = dateSorted.filter(d => d.iso <= todayIso)
    const latest = validDates[validDates.length - 1]
    const currentStockRaw = latest ? row[latest.field] : null
    const currentStock = currentStockRaw == null || currentStockRaw === ""
      ? null : Number(currentStockRaw)

    const history=[]
    for(let i=1;i<dateSorted.length;i++){
      const prev=dateSorted[i-1],cur=dateSorted[i]
      const p=Number(row[prev.field]||0)
      const q=Number(row[cur.field]||0)
      if(q>p)validation.replenishmentEvents++
      const moved=Math.max(p-q,0)
      const wd=countWorkingDays(prev.iso,cur.iso)
      history.push({date:cur.iso,qty:moved,workingDays:wd})
    }

    const totalQty=history.reduce((s,p)=>s+p.qty,0)
    const totalWorking=history.reduce((s,p)=>s+p.workingDays,0)
    const {window30,window60,window90}=computeWindows(history)

series.push({
  sku,
  desc: descCol ? String(row[descCol] || "").trim() : "Description not provided",
  vendor: (
    vendorCol ? String(row[vendorCol] || "").trim() : ""
  ) || state.supply[sku]?.[0]?.vendor || "",
  history,
  totalQty,
  avgPerWorkingDay: totalWorking > 0 ? totalQty / totalWorking : 0,
  window30, window60, window90,
  currentStock,
  class: null
})

  })

  validation.duplicateSkus=[...dup]
  state.validation=validation
  state.demand=series

  // =========================
  // UNIVERSAL ABC CLASSIFICATION
  // =========================

  const items = state.demand.filter(s => s.avgPerWorkingDay > 0)

  if (items.length > 0) {
    const values = items.map(s => s.avgPerWorkingDay)
    const mean = values.reduce((a,b)=>a+b,0) / values.length
    const variance = values.reduce((s,v)=>s + (v-mean)**2, 0) / values.length
    const cv = Math.sqrt(variance) / mean

    items.sort((a,b)=>
      b.avgPerWorkingDay - a.avgPerWorkingDay ||
      b.window90.adjusted - a.window90.adjusted ||
      a.sku.localeCompare(b.sku)
    )

    if (cv >= 1.0) {
      const total = values.reduce((a,b)=>a+b,0)
      let cum = 0
      items.forEach(s=>{
        cum += s.avgPerWorkingDay
        const pct = cum / total
        s.class = pct <= 0.8 ? "A" : pct <= 0.95 ? "B" : "C"
      })
    } else {
      items.forEach((s,i)=>{
        const p = (i+1)/items.length
        s.class = p <= 0.2 ? "A" : p <= 0.5 ? "B" : "C"
      })
    }
  }

  state.demand.forEach(s=>{
    if (!s.class) s.class = "C"
  })

  setMode(state.mode)
}


/* =========================
   SUPPLY PARSE
   ========================= */

function parseSupply(rows) {
  state.supply = {}        // per-SKU supply events (received + open)
  state.leadTimes = {}     // per-vendor lead time samples (weeks)

  rows.forEach(r => {
    const sku =
      r["INVENTORY ID"] ||
      r["Inventory ID"] ||
      r["InventoryId"] ||
      r["InventoryID"]

    if (!sku) return

    const vendor = String(r["Vendor"] || "").trim() || "Vendor not provided"

    const poDateRaw = r["PO DATE"]
    const recvDateRaw = r["PO RECEIVEDATE"]

    if (!poDateRaw) return

    const poDate = new Date(poDateRaw)
    if (isNaN(poDate)) return

    // -----------------------------
    // OPEN ORDER (NO RECEIVEDATE)
    // -----------------------------
    if (!recvDateRaw || String(recvDateRaw).trim() === "") {
      if (!state.supply[sku]) state.supply[sku] = []
      state.supply[sku].push({
        vendor,
        poDate: poDate,
        recvDate: null,
        open: true
      })
      return
    }

    // -----------------------------
    // RECEIVED ORDER → LEAD TIME
    // -----------------------------
    const recvDate = new Date(recvDateRaw)
    if (isNaN(recvDate)) return

    const leadDays = daysBetween(poDate, recvDate)
    if (leadDays === null || leadDays <= 0) return

    const leadWeeks = leadDays / 7

    if (!state.supply[sku]) state.supply[sku] = []
    state.supply[sku].push({
      vendor,
      poDate: poDate,
      recvDate: recvDate,
      leadWeeks,
      open: false
    })

    if (!state.leadTimes[vendor]) state.leadTimes[vendor] = []
    state.leadTimes[vendor].push(leadWeeks)
  })

  // ---------------------------------
  // BACKFILL VENDOR INTO DEMAND SKUs
  // ---------------------------------
  state.demand.forEach(s => {
    if (!s.vendor && state.supply[s.sku]?.length) {
      s.vendor = state.supply[s.sku][0].vendor
    }
  })

  if (state.mode === "management") renderManagement()
}



/* =========================
   UI RENDER
   ========================= */

function renderAnalyst(){
  const tb = document.getElementById("analyst-body")
  if (!tb) return
  tb.innerHTML = ""

  const sorted = [...state.demand].sort((a,b)=>
    a.class.localeCompare(b.class) ||
    b.avgPerWorkingDay - a.avgPerWorkingDay ||
    b.window90.adjusted - a.window90.adjusted ||
    a.sku.localeCompare(b.sku)
  )

  sorted.forEach(s=>{
    tb.innerHTML += `
      <tr>
        <td>${s.sku}</td>
        <td>${s.class}</td>
        <td>${s.avgPerWorkingDay.toFixed(3)}</td>
        <td>${s.window30.adjusted.toFixed(3)}</td>
        <td>${s.window60.adjusted.toFixed(3)}</td>
        <td>${s.window90.adjusted.toFixed(3)}</td>
      </tr>`
  })
}


function renderManagement(){
  const r = document.getElementById("rolodex")
  if (!r) return
  r.innerHTML = ""

  const sorted = [...state.demand].sort((a,b)=>
    a.class.localeCompare(b.class) ||
    b.avgPerWorkingDay - a.avgPerWorkingDay ||
    b.window90.adjusted - a.window90.adjusted ||
    a.sku.localeCompare(b.sku)
  )

  sorted.forEach(s=>{
    const vendor = s.vendor || "Vendor not provided"
    const abc = s.class

    const u30 = s.window30.adjusted
    const u60 = s.window60.adjusted
    const u90 = s.window90.adjusted

    const dailyUsage = getPlanningUsage(s)
    const weeklyUsage = dailyUsage * 5

    const trueLead = state.leadTimes[vendor]
      ? median(state.leadTimes[vendor])
      : 0

    const monthsCover = trueLead ? (trueLead / 4.33).toFixed(1) : "—"
    // Next receipt (EST date only, no time)
    const supplyEvents = state.supply[s.sku] || []
    const openOrder = supplyEvents.find(x => x.open)
    const receivedOrder = supplyEvents.find(x => !x.open && x.recvDate)

    const nextReceipt = openOrder
      ? formatESTDate(openOrder.poDate)
      : receivedOrder
        ? formatESTDate(receivedOrder.recvDate)
        : "None"

    // Lead-time coverage (clear wording)
    let coverageText = "Lead-time coverage: Insufficient data."
    if (dailyUsage > 0 && trueLead > 0) {
      const daysOfCover = s.currentStock / dailyUsage
      const leadDays = trueLead * 7
      coverageText =
        daysOfCover >= leadDays
          ? "Lead-time coverage: Inventory covers supplier lead time demand."
          : "Lead-time coverage: Inventory does NOT cover supplier lead time demand."
    }


    r.innerHTML += `
      <div class="card card-${abc}">
        <div class="card-title">
          ${s.sku}
          <span class="badge badge-${abc}">${abc}</span>
        </div>

        <div class="card-desc">${s.desc}</div>

        <div class="card-body">
          <strong>Usage (units / working day)</strong><br>
          30d: ${u30.toFixed(3)} |
          60d: ${u60.toFixed(3)} |
          90d: ${u90.toFixed(3)}

          <br><br>
          <strong>Planning rate (${state.planning.window}d)</strong><br>
          ${dailyUsage.toFixed(3)} / day
          (${weeklyUsage.toFixed(1)} / week)

          <br><br>
          <strong>Supply</strong><br>
          Vendor:
          <input class="inline-edit" value="${vendor}"
            onchange="
              const d = state.demand.find(x=>x.sku==='${s.sku}')
              if (d) d.vendor=this.value
              if(!state.leadTimes[this.value]) state.leadTimes[this.value]=[]
              renderManagement()
            ">
          <br>
          Lead time:
          <input class="inline-edit" value="${trueLead.toFixed(2)}"
            onchange="
              state.leadTimes['${vendor}']=[Number(this.value)]
              renderManagement()
            "> weeks
          <br>
          True lead time: ${trueLead.toFixed(2)} weeks
          (~${monthsCover} months)
          <br>
          Next receipt: ${nextReceipt}

          <br><br>
          <strong>Risk</strong><br>
          ${coverageText}
        </div>

        <div class="card-footer">
          ${recommendation(s)}
        </div>
      </div>
    `
  })
}


function renderValidation(){
  const v = state.validation
  const el = document.getElementById("validation-summary")
  if (!el || !v) return

  const issues = []

  if (v.missingStockCells > 0) {
    issues.push(`${v.missingStockCells} missing values`)
  }
  if (v.invalidStockCells > 0) {
    issues.push(`${v.invalidStockCells} invalid entries`)
  }
  if (v.duplicateSkus.length > 0) {
    issues.push(`duplicate SKUs`)
  }

  if (issues.length === 0) {
    el.textContent =
      `Data check: OK — no missing values, no errors, ` +
      `replenishment history detected (${v.replenishmentEvents} events)`
  } else {
    el.textContent =
      `Data check: Attention needed — ` + issues.join(", ")
  }
}



/* =========================
   MODE
   ========================= */

function setMode(m){
  state.mode = m

  const views = ["analyst","management","planning","about"]
  views.forEach(v=>{
    document.getElementById(v+"-view")?.classList.toggle("hidden", v!==m)
    document.getElementById("btn-"+v)?.classList.toggle("active", v===m)
  })

  if (m === "about") {
    renderAbout()
  }

  if (m === "analyst") renderAnalyst()
  if (m === "management") renderManagement()

  document.getElementById("validation-view")
    ?.classList.toggle("hidden", m === "about" || m === "planning")

  if (m !== "about" && m !== "planning") {
    renderValidation()
  }
}


/* =========================
   INIT
   ========================= */

document.addEventListener("DOMContentLoaded",()=>{
  document.getElementById("cycle-file")?.addEventListener("change",e=>{
    loadCsv(e.target.files[0], parseDemand)
  })

  document.getElementById("po-file")?.addEventListener("change",e=>{
    loadCsv(e.target.files[0], parseSupply)
  })

  document.getElementById("btn-analyst")?.addEventListener("click",()=>setMode("analyst"))
  document.getElementById("btn-management")?.addEventListener("click",()=>setMode("management"))
  document.getElementById("btn-about")?.addEventListener("click",()=>setMode("about"))
  document.getElementById("btn-planning")
  ?.addEventListener("click",()=>setMode("planning"))


  renderAbout()        // ðŸ‘ˆ KEY FIX
  setMode("analyst")   // default view
})

// ---- Door-Equivalent Model ----

// conservative, stable coefficients
const DOOR_EQUIVALENTS = {
  single: 1.0,
  double: 1.9,
  single_sidelite: 1.5,
  double_sidelite: 2.5
}

// inferred historical mix (can be refined later)
const DEFAULT_MIX = {
  single: 0.52,
  double: 0.28,
  single_sidelite: 0.12,
  double_sidelite: 0.08
}

function computeDoorEquivalents(doorsPerDay) {
  let dePerDoor = 0
  for (const k in DEFAULT_MIX) {
    dePerDoor += DEFAULT_MIX[k] * DOOR_EQUIVALENTS[k]
  }
  return doorsPerDay * dePerDoor
}

// ---- Material intensity from history ----

function deriveMaterialPerDE(cycleCounts, purchaseHistory) {
  // aggregate material usage from purchases
  const materialTotals = {}

  purchaseHistory.forEach(r => {
    const mat = r.material
    if (!materialTotals[mat]) {
      materialTotals[mat] = {
        qty: 0,
        unit: r.unit
      }
    }
    materialTotals[mat].qty += r.quantity
  })

  // estimate total historical DE from cycle counts
  const totalDoors = cycleCounts.reduce((s, r) => s + r.doorsProduced, 0)
  const totalDE = computeDoorEquivalents(totalDoors / cycleCounts.length) * cycleCounts.length

  // material per DE
  const perDE = {}
  for (const m in materialTotals) {
    perDE[m] = {
      unit: materialTotals[m].unit,
      perDE: materialTotals[m].qty / totalDE
    }
  }

  return perDE
}

// ---- Planning engine ----

/* =========================
   PLANNING (TIME-BASED, CORRECT)
   ========================= */

/*
Planning definition (LOCKED):
- Consumables (paint, chemicals, MRO): time-based usage × horizon
- Production-linked (wood, glass): NOT PLANNED until material-per-door exists
*/

function runMaterialPlanning() {
  const workingDays = Number(document.getElementById("workingDays")?.value || 0)
  if (!workingDays) return

  const tbody = document.querySelector("#materialPlan tbody")
  if (!tbody) return
  tbody.innerHTML = ""

  let rowsWritten = 0

  state.demand.forEach(s=>{
    // Use only SKUs with real, stable consumption
    if (!s.avgPerWorkingDay || s.avgPerWorkingDay <= 0) return

    const dailyUsage = s.avgPerWorkingDay
    const plannedQty = dailyUsage * workingDays

    // Skip noise
    if (plannedQty <= 0) return

    tbody.innerHTML += `
      <tr>
        <td>${s.sku}</td>
        <td>${s.desc}</td>
        <td>${s.class}</td>
        <td>${plannedQty.toFixed(1)}</td>
        <td class="muted">Time-based consumption (planning horizon)</td>
      </tr>
    `
    rowsWritten++
  })

  if (rowsWritten === 0) {
    tbody.innerHTML =
      `<tr><td colspan="5" class="muted">
        No consumable demand detected for the selected horizon.
      </td></tr>`
  }
}
function sanitizeText(input) {
  if (!input) return ""
  return String(input)
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "")   // drop non-ASCII
    .replace(/\s+/g, " ")
    .trim()
}

function setPlanningWindow(days) {
  state.planning.window = days
  document.querySelectorAll(".plan-btn").forEach(b =>
    b.classList.toggle("active", b.textContent.startsWith(days))
  )
  if (state.mode === "analyst") renderAnalyst()
  if (state.mode === "management") renderManagement()
}

const ABOUT_TEXT = document.getElementById("about-view")?.innerHTML || ""



/* =========================
   PDF GENERATOR
   ========================= */

function exportManagementPdf() {
  const { jsPDF } = window.jspdf
  const doc = new jsPDF({ orientation: "portrait", unit: "pt", format: "a4" })

  let y = 40
  const pageHeight = doc.internal.pageSize.height
  const margin = 40
  const line = 14

  const ensureSpace = linesNeeded => {
    if (y + linesNeeded * line > pageHeight - 40) {
      doc.addPage()
      y = 40
    }
  }

  doc.setFont("Helvetica", "bold")
  doc.setFontSize(14)
  doc.text("Universal Forecasting Tool — Management Summary", margin, y)
  y += 20

  doc.setFontSize(9)
  doc.setFont("Helvetica", "normal")
  doc.text(`Generated: ${new Date().toLocaleDateString()}`, margin, y)
  y += 20

  const items = [...state.demand].sort((a, b) =>
    a.class.localeCompare(b.class) ||
    b.avgPerWorkingDay - a.avgPerWorkingDay
  )

  items.forEach(s => {
    ensureSpace(6)

    /* =========================
       SKU HEADER (same as UI)
       ========================= */
    doc.setFont("Helvetica", "bold")
    doc.text(
      `${s.sku} | Class ${s.class} | ${s.avgPerWorkingDay.toFixed(2)} units/day`,
      margin,
      y
    )
    y += line + 4

    doc.setFont("Helvetica", "normal")

    /* =========================
       CORE METRICS (same fields UI uses)
       ========================= */
    const baseLines = [
      `Description: ${s.desc || "Not provided"}`,
      `Vendor: ${s.vendor || "Not provided"}`,
      `Usage (30/60/90): ${s.window30.adjusted.toFixed(2)} / ${s.window60.adjusted.toFixed(2)} / ${s.window90.adjusted.toFixed(2)}`,
      `Planning rate (90d): ${s.avgPerWorkingDay.toFixed(2)} / day (${(s.avgPerWorkingDay * 5).toFixed(1)} / week)`
    ]

    baseLines.forEach(t => {
      ensureSpace(1)
      doc.text(sanitizeText(t), margin, y, { maxWidth: 520 })
      y += line
    })

    /* =========================
       SUPPLY (from parsed supply state)
       ========================= */
    const supply = state.supply[s.sku] || []
    const received = supply.filter(x => !x.open)
    const open = supply.filter(x => x.open)

    const leadWeeks =
      received.length
        ? (received.reduce((a, b) => a + b.leadWeeks, 0) / received.length)
        : null

    const nextReceipt =
      open.length
        ? `Open order (PO date ${new Date(open[0].poDate).toLocaleDateString()})`
        : "None"

    const supplyLines = [
      `Observed supplier lead time: ${
        leadWeeks ? `${(leadWeeks * 7).toFixed(0)} working days (${s.vendor})` : "Insufficient history"
      }`,
      `Next receipt: ${nextReceipt}`
    ]

    supplyLines.forEach(t => {
      ensureSpace(1)
      doc.text(sanitizeText(t), margin, y, { maxWidth: 520 })
      y += line
    })

    /* =========================
       DECISION / RISK (same as UI recommendation)
       ========================= */
    const decisionLines = sanitizeText(
      recommendation(s)
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<[^>]+>/g, "")
    ).split("\n")

    decisionLines.forEach(t => {
      if (!t.trim()) return
      ensureSpace(1)
      doc.text(t.trim(), margin, y, { maxWidth: 520 })
      y += line
    })

    /* =========================
       SECTION DIVIDER
       ========================= */
    y += 10
    doc.setDrawColor(55, 65, 81)
    doc.line(margin, y, margin + 520, y)
    y += 16
  })

  doc.save("Forecasting_Management_Summary.pdf")
}

document.getElementById("btn-export")?.addEventListener("click", () => {
  if (state.mode !== "management") {
    alert("Switch to Management view before exporting.")
    return
  }
  exportManagementPdf()
})
