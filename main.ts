declare const Papa: any

type Classification = 'Active' | 'Low-Movement' | 'Dead'

interface TimePoint { date: string; qty: number }
interface SkuSeries {
  sku: string
  description: string
  history: TimePoint[]
  totalQty: number
  periods: number
  positivePeriods: number
  classification: Classification
  avgDemand: number
  mapePercent: number | null
  forecast: number[]
}

const state = {
  series: [] as SkuSeries[],
  mode: 'analyst' as 'analyst' | 'management'
}

function parseCsv(text: string) {
  const out = Papa.parse(text, { header:true, skipEmptyLines:true })
  const fields: string[] = out.meta.fields || []
  const rows: any[] = out.data

  const dateCols = fields.filter(f => /^\d{4}-\d{2}-\d{2}$/.test(f))
  dateCols.sort((a,b)=> Date.parse(a)-Date.parse(b))
  const skuCol = fields.find(f => f.toLowerCase()==='sku') || fields[0]
  const descCol = fields.find(f => f.toLowerCase().includes('desc')) || ''

  const series: SkuSeries[] = []

  rows.forEach(row => {
    const sku = String(row[skuCol]||'').trim()
    if(!sku) return

    const description = descCol ? String(row[descCol]||'').trim() : ''

    const hist: TimePoint[] = []
    for(let i=1;i<dateCols.length;i++){
      const prev = Number(row[dateCols[i-1]]||0)
      const curr = Number(row[dateCols[i]]||0)
      const moved = prev-curr > 0 ? prev-curr : 0
      hist.push({ date:dateCols[i], qty:moved })
    }

    const total = hist.reduce((s,p)=>s+p.qty,0)
    const pos = hist.filter(p=>p.qty>0).length
    const avg = hist.length>0 ? total/hist.length : 0

    let cls: Classification = 'Active'
    if(total===0) cls='Dead'
    else if(pos<=2) cls='Low-Movement'

    const ma = computeMA(hist,4,3)
    const mape = computeMape(hist)

    series.push({
      sku, description,
      history:hist,
      totalQty:total,
      periods:hist.length,
      positivePeriods:pos,
      classification:cls,
      avgDemand:avg,
      mapePercent:mape,
      forecast:cls==='Active'? ma : []
    })
  })

  state.series = series
}

function computeMA(hist: TimePoint[], horizon:number, w:number){
  if(hist.length===0) return []
  const slice = hist.slice(-w)
  const avg = slice.reduce((s,p)=>s+p.qty,0)/slice.length
  return Array(horizon).fill(avg>0?avg:0)
}

function computeMape(hist:TimePoint[]){
  if(hist.length<3) return null
  let sum=0, count=0
  for(let i=1;i<hist.length;i++){
    const a = hist[i].qty
    const f = hist[i-1].qty
    if(a>0){
      sum += Math.abs(a-f)/a
      count++
    }
  }
  if(count===0) return null
  return (sum/count)*100
}

function renderAnalystTable(){
  const tbody = document.getElementById('summary-body')!
  tbody.innerHTML = ''

  state.series.forEach(s=>{
    const tr = document.createElement('tr')
    tr.onclick = ()=> renderDetail(s)

    tr.innerHTML = `
      <td>${s.sku}</td>
      <td>${s.classification}</td>
      <td>${s.periods}</td>
      <td>${s.totalQty}</td>
      <td>${s.avgDemand.toFixed(2)}</td>
      <td>${s.mapePercent===null?'—':s.mapePercent.toFixed(1)}</td>
      <td>${s.forecast.length>0?'['+s.forecast.map(v=>v.toFixed(0)).join(', ')+']':'—'}</td>
    `
    tbody.appendChild(tr)
  })
}

function usageLabel(cls: Classification){
  if(cls==='Active') return 'Regularly Used'
  if(cls==='Low-Movement') return 'Rarely Used'
  return 'No Usage'
}

function recommendation(s: SkuSeries){
  if(s.classification==='Dead')
    return 'Hold at zero until required'

  if(s.classification==='Low-Movement')
    return 'Keep minimal stock'

  const need = Math.round(s.avgDemand)
  return `Keep ${need}-${need+1} units available`
}

function last30Used(s: SkuSeries){
  const last = s.history.slice(-4)
  return last.reduce((sum,p)=>sum+p.qty,0)
}

function renderManagementTable(){
  const tbody = document.getElementById('mgmt-body')!
  tbody.innerHTML = ''

  state.series.forEach(s=>{
    const tr = document.createElement('tr')
    tr.onclick = ()=> renderDetail(s)

    tr.innerHTML = `
      <td>${s.sku}</td>
      <td>${usageLabel(s.classification)}</td>
      <td>${Math.round(s.avgDemand)} units</td>
      <td>${last30Used(s)}</td>
      <td>${recommendation(s)}</td>
    `
    tbody.appendChild(tr)
  })
}

function renderDetail(s: SkuSeries){
  const box = document.getElementById('detail-content')!

  if(state.mode==='analyst'){
    box.innerHTML = `
      <strong>${s.sku}</strong><br>
      ${s.description}<br><br>
      Periods: ${s.periods}<br>
      Total Qty: ${s.totalQty}<br>
      Avg: ${s.avgDemand.toFixed(2)}<br><br>
      Forecast: ${s.forecast.map(v=>v.toFixed(0)).join(', ')}<br><br>
      History:<br>
      ${s.history.map(p=>`${p.date}: ${p.qty}`).join('<br>')}
    `
  } else {
    box.innerHTML = `
      <strong>${s.sku}</strong><br>
      ${s.description}<br><br>
      Usage Pattern: ${usageLabel(s.classification)}<br>
      Typical Need: ~${Math.round(s.avgDemand)} units/week<br>
      Last 30 Days Used: ${last30Used(s)}<br>
      Recommendation: ${recommendation(s)}<br><br>
      Recent Usage:<br>
      ${s.history.slice(-8).map(p=>`${p.date}: ${p.qty}`).join('<br>')}
    `
  }
}

function setMode(mode: 'analyst' | 'management'){
  state.mode = mode
  document.getElementById('btn-analyst')!.classList.toggle('active', mode==='analyst')
  document.getElementById('btn-management')!.classList.toggle('active', mode==='management')
  document.getElementById('analyst-table')!.classList.toggle('hidden', mode==='management')
  document.getElementById('management-table')!.classList.toggle('hidden', mode==='analyst')

  if(mode==='analyst') renderAnalystTable()
  else renderManagementTable()

  document.getElementById('detail-content')!.innerHTML = 'Click a SKU.'
}

document.addEventListener('DOMContentLoaded', ()=>{
  document.getElementById('btn-analyst')!.onclick = ()=> setMode('analyst')
  document.getElementById('btn-management')!.onclick = ()=> setMode('management')

  document.getElementById('file-input')!.addEventListener('change', (e:any)=>{
    const file = e.target.files[0]
    if(!file) return
    const reader = new FileReader()
    reader.onload = ()=>{
      parseCsv(String(reader.result))
      setMode(state.mode)
    }
    reader.readAsText(file)
  })
})
