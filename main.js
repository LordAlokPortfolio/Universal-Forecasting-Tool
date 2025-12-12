"use strict";
const HOLIDAYS = new Set([
    // Ontario statutory holidays (observed) 2024
    '2024-01-01', // New Year's Day
    '2024-02-19', // Family Day
    '2024-03-29', // Good Friday
    '2024-05-20', // Victoria Day
    '2024-07-01', // Canada Day
    '2024-09-02', // Labour Day
    '2024-10-14', // Thanksgiving
    '2024-12-25', // Christmas Day
    '2024-12-26', // Boxing Day
    // 2025
    '2025-01-01',
    '2025-02-17',
    '2025-04-18',
    '2025-05-19',
    '2025-07-01',
    '2025-09-01',
    '2025-10-13',
    '2025-12-25',
    '2025-12-26',
    // 2026 (forward-compatible)
    '2026-01-01',
    '2026-02-16',
    '2026-04-03',
    '2026-05-18',
    '2026-07-01',
    '2026-09-07',
    '2026-10-12',
    '2026-12-25',
    '2026-12-28'
]);
const MONTH_MAP = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
    jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
};
const state = {
    series: [],
    mode: 'analyst',
    validation: null
};
function parseIsoDate(d) {
    return new Date(d + 'T00:00:00');
}
function formatIso(y, m, day) {
    const mm = m < 10 ? '0' + m : String(m);
    const dd = day < 10 ? '0' + day : String(day);
    return `${y}-${mm}-${dd}`;
}
function isWorkingDay(iso) {
    const d = parseIsoDate(iso);
    const dow = d.getUTCDay();
    const weekend = dow === 0 || dow === 6;
    if (weekend)
        return false;
    if (HOLIDAYS.has(iso))
        return false;
    return true;
}
function countWorkingDays(startIso, endIso) {
    const start = parseIsoDate(startIso);
    const end = parseIsoDate(endIso);
    if (end <= start)
        return 0;
    let count = 0;
    const d = new Date(start.getTime());
    d.setUTCDate(d.getUTCDate() + 1);
    while (d <= end) {
        const iso = d.toISOString().slice(0, 10);
        if (isWorkingDay(iso))
            count += 1;
        d.setUTCDate(d.getUTCDate() + 1);
    }
    return count;
}
function computeWindows(history) {
    const zero = { raw: 0, workingDays: 0, adjusted: 0 };
    if (history.length === 0) {
        return { window30: zero, window60: zero, window90: zero };
    }
    const maxDateIso = history[history.length - 1].date;
    const maxDate = parseIsoDate(maxDateIso);
    function windowFor(days) {
        let raw = 0;
        let wd = 0;
        for (const p of history) {
            const d = parseIsoDate(p.date);
            const diffDays = Math.floor((maxDate.getTime() - d.getTime()) / 86400000);
            if (diffDays >= 0 && diffDays < days) {
                raw += p.qty;
                wd += p.workingDays;
            }
        }
        const adjusted = wd > 0 ? raw / wd : 0;
        return { raw, workingDays: wd, adjusted };
    }
    const window30 = windowFor(30);
    const window60 = windowFor(60);
    const window90 = windowFor(90);
    return { window30, window60, window90 };
}
function parseCsv(text) {
    const out = Papa.parse(text, { header: true, skipEmptyLines: true });
    const fields = out.meta.fields || [];
    const rows = out.data;
    const errorBox = document.getElementById('error-box');
    if (errorBox)
        errorBox.textContent = '';
    if (fields.length === 0) {
        if (errorBox)
            errorBox.textContent = 'No header row detected in CSV.';
        state.series = [];
        state.validation = null;
        renderAnalystTable();
        renderManagementTable();
        renderValidation();
        return;
    }
    const headerInfos = [];
    const isoRegex = /^\d{4}-\d{2}-\d{2}$/;
    const shortRegex = /^\s*(\d{1,2})[-\/\s](Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s*$/i;
    fields.forEach((f, idx) => {
        const trimmed = String(f).trim();
        let isDate = false;
        let iso;
        let shortDay;
        let shortMonth;
        if (isoRegex.test(trimmed)) {
            isDate = true;
            iso = trimmed;
        }
        else {
            const m = trimmed.match(shortRegex);
            if (m) {
                isDate = true;
                const day = parseInt(m[1], 10);
                const monKey = m[2].toLowerCase().slice(0, 3);
                const mon = MONTH_MAP[monKey];
                if (mon && day >= 1 && day <= 31) {
                    shortDay = day;
                    shortMonth = mon;
                }
                else {
                    isDate = false;
                }
            }
        }
        headerInfos.push({
            field: f,
            index: idx,
            isDate,
            iso,
            shortDay,
            shortMonth
        });
    });
    const dateHeadersOriginal = headerInfos.filter(h => h.isDate);
    const shortHeaders = dateHeadersOriginal.filter(h => !h.iso && h.shortMonth && h.shortDay);
    if (shortHeaders.length > 0) {
        const currentYear = new Date().getFullYear();
        let year = currentYear;
        let prevMonth = null;
        const ordered = shortHeaders.slice().sort((a, b) => a.index - b.index);
        ordered.forEach(h => {
            const month = h.shortMonth;
            const day = h.shortDay;
            if (prevMonth !== null && month < prevMonth) {
                year += 1;
            }
            prevMonth = month;
            h.iso = formatIso(year, month, day);
        });
    }
    const dateHeadersWithIso = dateHeadersOriginal.filter(h => h.iso);
    if (dateHeadersWithIso.length === 0) {
        if (errorBox)
            errorBox.textContent = 'No recognizable date columns found. Use ISO dates (YYYY-MM-DD) or formats like 9-Dec.';
        state.series = [];
        state.validation = null;
        renderAnalystTable();
        renderManagementTable();
        renderValidation();
        return;
    }
    const dateHeadersSorted = dateHeadersWithIso
        .slice()
        .sort((a, b) => Date.parse(a.iso) - Date.parse(b.iso));
    let nonChronological = false;
    if (dateHeadersWithIso.length > 1) {
        const originalOrder = dateHeadersWithIso.slice().sort((a, b) => a.index - b.index);
        for (let i = 0; i < originalOrder.length; i += 1) {
            if (originalOrder[i].field !== dateHeadersSorted[i].field) {
                nonChronological = true;
                break;
            }
        }
    }
    const skuCol = fields.find(f => f.toLowerCase() === 'sku') || fields[0];
    const descCol = fields.find(f => f.toLowerCase().includes('desc')) || '';
    const validation = {
        missingStockCells: 0,
        nonChronological,
        invalidStockCells: 0,
        replenishmentEvents: 0,
        duplicateSkus: []
    };
    const seenSkus = new Map();
    const duplicateSet = new Set();
    const series = [];
    rows.forEach(row => {
        const rawSku = row[skuCol];
        const sku = String(rawSku || '').trim();
        if (!sku)
            return;
        const prevCount = seenSkus.get(sku) || 0;
        seenSkus.set(sku, prevCount + 1);
        if (prevCount + 1 > 1)
            duplicateSet.add(sku);
        if (dateHeadersWithIso.length > 0) {
            dateHeadersWithIso.forEach(h => {
                const cell = row[h.field];
                const txt = cell === null || cell === undefined ? '' : String(cell).trim();
                if (txt === '') {
                    validation.missingStockCells += 1;
                }
                else {
                    const num = Number(txt);
                    if (!Number.isFinite(num) || num < 0) {
                        validation.invalidStockCells += 1;
                    }
                }
            });
        }
        const description = descCol ? String(row[descCol] || '').trim() : '';
        const history = [];
        for (let i = 1; i < dateHeadersSorted.length; i += 1) {
            const prevHeader = dateHeadersSorted[i - 1];
            const currHeader = dateHeadersSorted[i];
            const prevIso = prevHeader.iso;
            const currIso = currHeader.iso;
            const prevRaw = row[prevHeader.field];
            const currRaw = row[currHeader.field];
            const prev = Number(prevRaw || 0);
            const curr = Number(currRaw || 0);
            if (Number.isFinite(prev) && Number.isFinite(curr) && curr > prev) {
                validation.replenishmentEvents += 1;
            }
            const movedRaw = prev - curr;
            const moved = movedRaw > 0 && Number.isFinite(movedRaw) ? movedRaw : 0;
            const wd = countWorkingDays(prevIso, currIso);
            const rate = wd > 0 ? moved / wd : 0;
            history.push({
                date: currIso,
                qty: moved,
                workingDays: wd,
                ratePerWorkingDay: rate
            });
        }
        const totalQty = history.reduce((s, p) => s + p.qty, 0);
        const totalWorking = history.reduce((s, p) => s + p.workingDays, 0);
        const periods = history.length;
        const positivePeriods = history.filter(p => p.qty > 0).length;
        const avgDemand = periods > 0 ? totalQty / periods : 0;
        const avgPerWorkingDay = totalWorking > 0 ? totalQty / totalWorking : 0;
        let classification = 'Active';
        if (totalQty === 0)
            classification = 'Dead';
        else if (positivePeriods <= 2)
            classification = 'Low-Movement';
        const ma = computeMA(history, 4, 3);
        const mape = computeMape(history);
        const { window30, window60, window90 } = computeWindows(history);
        series.push({
            sku,
            description,
            history,
            totalQty,
            periods,
            positivePeriods,
            classification,
            avgDemand,
            mapePercent: mape,
            forecast: classification === 'Active' ? ma : [],
            totalWorkingDays: totalWorking,
            avgPerWorkingDay,
            window30,
            window60,
            window90
        });
    });
    validation.duplicateSkus = Array.from(duplicateSet).sort();
    state.series = series;
    state.validation = validation;
    renderAnalystTable();
    renderManagementTable();
    renderValidation();
}
function computeMA(hist, horizon, w) {
    if (hist.length === 0)
        return [];
    const slice = hist.slice(-w);
    const avg = slice.reduce((s, p) => s + p.qty, 0) / slice.length;
    const value = avg > 0 ? avg : 0;
    return Array(horizon).fill(value);
}
function computeMape(hist) {
    if (hist.length < 3)
        return null;
    let sum = 0;
    let count = 0;
    for (let i = 1; i < hist.length; i += 1) {
        const actual = hist[i].qty;
        const forecast = hist[i - 1].qty;
        if (actual > 0) {
            sum += Math.abs(actual - forecast) / actual;
            count += 1;
        }
    }
    if (count === 0)
        return null;
    return (sum / count) * 100;
}
function renderAnalystTable() {
    const tbody = document.getElementById('summary-body');
    if (!tbody)
        return;
    tbody.innerHTML = '';
    state.series.forEach(s => {
        const tr = document.createElement('tr');
        tr.onclick = () => renderDetail(s);
        tr.innerHTML = `
      <td>${s.sku}</td>
      <td>${s.classification}</td>
      <td>${s.periods}</td>
      <td>${s.totalQty}</td>
      <td>${s.avgDemand.toFixed(2)}</td>
      <td>${s.mapePercent === null ? '—' : s.mapePercent.toFixed(1)}</td>
      <td>${s.forecast.length > 0 ? '[' + s.forecast.map(v => v.toFixed(0)).join(', ') + ']' : '—'}</td>
    `;
        tbody.appendChild(tr);
    });
}
function usageLabel(cls) {
    if (cls === 'Active')
        return 'Regularly Used';
    if (cls === 'Low-Movement')
        return 'Rarely Used';
    return 'No Usage';
}
function recommendation(s) {
    const adj = s.avgPerWorkingDay;
    if (s.classification === 'Dead' || (s.window90.raw === 0 && s.totalQty === 0)) {
        return 'Hold at zero and order only when a real requirement appears';
    }
    if (s.classification === 'Low-Movement') {
        return `Keep minimal stock based on roughly ${adj.toFixed(2)} units per working day`;
    }
    const weeklyNeed = adj * 5;
    const buffer = Math.max(Math.round(weeklyNeed * 2), 1);
    return `Plan for about ${Math.round(weeklyNeed)} units per week and keep ${buffer} units as a two-week buffer`;
}
function renderManagementTable() {
    const tbody = document.getElementById('mgmt-body');
    if (!tbody)
        return;
    tbody.innerHTML = '';
    state.series.forEach(s => {
        const tr = document.createElement('tr');
        tr.onclick = () => renderDetail(s);
        const adjStr = s.avgPerWorkingDay > 0 ? s.avgPerWorkingDay.toFixed(2) : '0.00';
        const w30 = s.window30.adjusted.toFixed(2);
        const w60 = s.window60.adjusted.toFixed(2);
        const w90 = s.window90.adjusted.toFixed(2);
        tr.innerHTML = `
      <td>${s.sku}</td>
      <td>${usageLabel(s.classification)}</td>
      <td>${adjStr}</td>
      <td>30d: ${w30} · 60d: ${w60} · 90d: ${w90}</td>
      <td>${recommendation(s)}</td>
    `;
        tbody.appendChild(tr);
    });
}
function renderDetail(s) {
    const box = document.getElementById('detail-content');
    if (!box)
        return;
    if (state.mode === 'analyst') {
        const lines = [];
        lines.push(`<div class="section"><h4>${s.sku}</h4>${s.description || ''}</div>`);
        lines.push(`
      <div class="section">
        <strong>Summary</strong><br>
        Periods: ${s.periods}<br>
        Total Qty (raw): ${s.totalQty}<br>
        Total working days: ${s.totalWorkingDays}<br>
        Avg per period: ${s.avgDemand.toFixed(2)}<br>
        Avg per working day: ${s.avgPerWorkingDay.toFixed(4)}
      </div>
    `);
        lines.push(`
      <div class="section">
        <strong>Rolling usage (raw vs working-day adjusted)</strong><br>
        30 days: ${s.window30.raw} raw over ${s.window30.workingDays} working days
        ⇒ ${s.window30.adjusted.toFixed(4)} / working day<br>
        60 days: ${s.window60.raw} raw over ${s.window60.workingDays} working days
        ⇒ ${s.window60.adjusted.toFixed(4)} / working day<br>
        90 days: ${s.window90.raw} raw over ${s.window90.workingDays} working days
        ⇒ ${s.window90.adjusted.toFixed(4)} / working day
      </div>
    `);
        lines.push(`
      <div class="section">
        <strong>Forecast (3-point moving average)</strong><br>
        ${s.forecast.length > 0 ? s.forecast.map(v => v.toFixed(0)).join(', ') : '—'}
      </div>
    `);
        const historyLines = s.history.map(p => {
            const rate = p.workingDays > 0 ? p.ratePerWorkingDay.toFixed(4) : '0.0000';
            return `${p.date}: ${p.qty} (working days: ${p.workingDays}, per day: ${rate})`;
        });
        lines.push(`
      <div class="section">
        <strong>History</strong><br>
        ${historyLines.join('<br>')}
      </div>
    `);
        box.innerHTML = lines.join('');
    }
    else if (state.mode === 'management') {
        const lines = [];
        lines.push(`<div class="section"><h4>${s.sku}</h4>${s.description || ''}</div>`);
        lines.push(`
      <div class="section">
        <strong>Usage pattern:</strong> ${usageLabel(s.classification)}<br>
        <strong>Adj usage per working day:</strong> ${s.avgPerWorkingDay.toFixed(4)}
      </div>
    `);
        lines.push(`
      <div class="section">
        <strong>Rolling windows (adjusted)</strong><br>
        30 days: ${s.window30.adjusted.toFixed(4)} / working day<br>
        60 days: ${s.window60.adjusted.toFixed(4)} / working day<br>
        90 days: ${s.window90.adjusted.toFixed(4)} / working day
      </div>
    `);
        lines.push(`
      <div class="section">
        <strong>Recommendation</strong><br>
        ${recommendation(s)}
      </div>
    `);
        lines.push(`
      <div class="section">
        <strong>Recent usage (last 8 points)</strong><br>
        ${s.history.slice(-8).map(p => `${p.date}: ${p.qty}`).join('<br>')}
      </div>
    `);
        box.innerHTML = lines.join('');
    }
    else {
        box.innerHTML = 'About mode is active. Switch back to Analyst or Management to see SKU details.';
    }
}
function renderValidation() {
    const scoreEl = document.getElementById('validation-score');
    const missingEl = document.getElementById('val-missing');
    const nonChronoEl = document.getElementById('val-nonchrono');
    const invalidEl = document.getElementById('val-invalid');
    const replEl = document.getElementById('val-replenish');
    const dupEl = document.getElementById('val-duplicates');
    if (!scoreEl || !missingEl || !nonChronoEl || !invalidEl || !replEl || !dupEl)
        return;
    const v = state.validation;
    if (!v) {
        scoreEl.textContent = 'Waiting for data';
        scoreEl.className = 'badge badge-good';
        missingEl.textContent = '0';
        nonChronoEl.textContent = 'No';
        invalidEl.textContent = '0';
        replEl.textContent = '0';
        dupEl.textContent = 'None';
        return;
    }
    const issues = v.missingStockCells > 0 ||
        v.nonChronological ||
        v.invalidStockCells > 0 ||
        v.replenishmentEvents > 0 ||
        v.duplicateSkus.length > 0;
    scoreEl.textContent = issues ? 'Needs Attention' : 'Good';
    scoreEl.className = issues ? 'badge badge-warn' : 'badge badge-good';
    missingEl.textContent = String(v.missingStockCells);
    nonChronoEl.textContent = v.nonChronological ? 'Yes' : 'No';
    invalidEl.textContent = String(v.invalidStockCells);
    replEl.textContent = String(v.replenishmentEvents);
    dupEl.textContent = v.duplicateSkus.length > 0 ? v.duplicateSkus.join(', ') : 'None';
}
function setMode(mode) {
    state.mode = mode;
    const btnAnalyst = document.getElementById('btn-analyst');
    const btnMgmt = document.getElementById('btn-management');
    const btnAbout = document.getElementById('btn-about');
    const analystPanel = document.getElementById('analyst-table');
    const mgmtPanel = document.getElementById('management-table');
    const detailView = document.getElementById('detail-view');
    const aboutPage = document.getElementById('about-page');
    const fileArea = document.getElementById('file-area');
    const validationPanel = document.getElementById('validation-panel');
    const detailContent = document.getElementById('detail-content');
    if (btnAnalyst)
        btnAnalyst.classList.toggle('active', mode === 'analyst');
    if (btnMgmt)
        btnMgmt.classList.toggle('active', mode === 'management');
    if (btnAbout)
        btnAbout.classList.toggle('active', mode === 'about');
    if (mode === 'about') {
        if (fileArea)
            fileArea.classList.add('hidden');
        if (analystPanel)
            analystPanel.classList.add('hidden');
        if (mgmtPanel)
            mgmtPanel.classList.add('hidden');
        if (validationPanel)
            validationPanel.classList.add('hidden');
        if (detailView)
            detailView.classList.add('hidden');
        if (aboutPage)
            aboutPage.classList.remove('hidden');
    }
    else if (mode === 'analyst') {
        if (fileArea)
            fileArea.classList.remove('hidden');
        if (analystPanel)
            analystPanel.classList.remove('hidden');
        if (mgmtPanel)
            mgmtPanel.classList.add('hidden');
        if (validationPanel)
            validationPanel.classList.remove('hidden');
        if (detailView)
            detailView.classList.remove('hidden');
        if (aboutPage)
            aboutPage.classList.add('hidden');
        renderAnalystTable();
        renderValidation();
        if (detailContent)
            detailContent.innerHTML = 'Click a SKU.';
    }
    else {
        if (fileArea)
            fileArea.classList.remove('hidden');
        if (analystPanel)
            analystPanel.classList.add('hidden');
        if (mgmtPanel)
            mgmtPanel.classList.remove('hidden');
        if (validationPanel)
            validationPanel.classList.add('hidden');
        if (detailView)
            detailView.classList.remove('hidden');
        if (aboutPage)
            aboutPage.classList.add('hidden');
        renderManagementTable();
        if (detailContent)
            detailContent.innerHTML = 'Click a SKU.';
    }
}
document.addEventListener('DOMContentLoaded', () => {
    const btnAnalyst = document.getElementById('btn-analyst');
    const btnMgmt = document.getElementById('btn-management');
    const btnAbout = document.getElementById('btn-about');
    const fileInput = document.getElementById('file-input');
    if (btnAnalyst)
        btnAnalyst.onclick = () => setMode('analyst');
    if (btnMgmt)
        btnMgmt.onclick = () => setMode('management');
    if (btnAbout)
        btnAbout.onclick = () => setMode('about');
    if (fileInput) {
        fileInput.addEventListener('change', e => {
            const target = e.target;
            const file = target.files && target.files[0];
            if (!file)
                return;
            const reader = new FileReader();
            reader.onload = () => {
                parseCsv(String(reader.result));
                setMode(state.mode);
            };
            reader.readAsText(file);
        });
    }
    setMode('analyst');
});
