// popup.js — stable init + visual render; now mirrors signed-in email in sidebar credits.

const $ = id => document.getElementById(id);
const qsa = sel => Array.from(document.querySelectorAll(sel));
// safe binder
const on = (id, evt, fn) => {
  const el = $(id);
  if (el) el.addEventListener(evt, fn);
};


function surfaceError(e){
  console.error(e);
  const box = $('result');
  if (box) box.innerHTML = `<div class="card">❌ ${e?.message || e}</div>`;
}
function safe(fn){ try { return fn(); } catch(e){ surfaceError(e); } }

const state = { sites: [], perf: { range:'30', wholeProperty:false } };

function kv(k,v){ return `<div class="row kv"><div class="k">${k}</div><div>${v}</div></div>`; }
function badge(s, cls=''){ return `<span class="badge ${cls}">${s}</span>`; }
function stateBadge(s){
  const t = String(s||'').toLowerCase();
  if(/(valid|passed|ok|good|on google|submitted|success|100|90)/.test(t)) return badge(s,'good');
  if(/(warning|partial|unknown|needs|medium)/.test(t)) return badge(s,'ok');
  if(/(error|fail|not on google|blocked|denied|slow|poor|noindex)/.test(t)) return badge(s,'bad');
  return badge(s);
}
function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, m => (
    { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]
  ));
}
function clearResult(msg, targetId){
  const el = $(targetId || 'result'); if (!el) return;
  el.innerHTML = msg ? `<div class="card">${msg}</div>` : '';
  // Only wipe the Raw JSON panel when we’re writing to the main result box
  if (!targetId || targetId === 'result') {
    const raw = $('raw'); if (raw) raw.textContent = '';
  }
}
function setRaw(obj){
  const raw = $('raw'); if (!raw) return;
  try { raw.textContent = JSON.stringify(obj, null, 2); } catch(e){ raw.textContent = String(obj); }
}

/* ---------- URL & property helpers ---------- */
function normalizeUrl(raw){
  if (!raw) return null;
  let u = String(raw).trim();
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  try {
    const p = new URL(u);
    if (!/^https?:$/.test(p.protocol)) return null;
    p.hash=''; p.username=''; p.password='';
    const host = p.hostname;
    if (host === 'localhost' || host.endsWith('.local') ||
        /^127\./.test(host) || /^10\./.test(host) ||
        /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return null;
    return p.toString();
  } catch { return null; }
}
function propertyCoversUrl(siteUrl, url){
  try{
    if(siteUrl.startsWith('sc-domain:')){
      const domain = siteUrl.split(':')[1];
      const u = new URL(url);
      return u.hostname === domain || u.hostname.endsWith('.'+domain);
    }
    return url.startsWith(siteUrl);
  }catch{ return false; }
}
function setSites(sites){
  state.sites = sites || [];
  const sel = $('sites'); if(!sel) return;
  sel.innerHTML = '';
  for(const s of state.sites){
    const opt = document.createElement('option');
    opt.value = s.siteUrl;
    opt.textContent = s.siteUrl + (s.permissionLevel ? `  (${s.permissionLevel})` : '');
    sel.appendChild(opt);
  }
  setEnabled();
}
function getPermissionFor(siteUrl){
  const entry = (state.sites || []).find(s => s.siteUrl === siteUrl);
  return entry?.permissionLevel || '';
}
function isOwner(siteUrl){ return /owner/i.test(getPermissionFor(siteUrl)); }
function setEnabled(){
  const sitesSel = $('sites'); const urlInp = $('inspectUrl');
  if (!sitesSel || !urlInp) return;
  const siteUrl = sitesSel.value || '';
  const url = normalizeUrl(urlInp.value || '');
  const covers = siteUrl && url && propertyCoversUrl(siteUrl, url);
  const owner = isOwner(siteUrl);
  const setDis = (id, on) => { const el = $(id); if (el) el.disabled = on; };
  setDis('inspect', !covers);
  setDis('liveTest', !covers);
  const whole = state.perf.wholeProperty;
  setDis('loadPerf', !(siteUrl && (whole ? true : covers)));
  setDis('runOnPage', false);
  const indexingAllowed = covers && owner;
  setDis('notifyUpdate', !indexingAllowed);
  setDis('notifyRemove', !indexingAllowed);
  setDis('checkStatus', !indexingAllowed);
}
// ===== Google Analytics (GA4) =====
const GA = { props: null };


function isoDaysAgo(n){
  const d = new Date(); d.setDate(d.getDate()-n); return d.toISOString().slice(0,10);
}
function ensureLaggedEnd(endIso){
  // GA usually fine with T-0, but to mirror your GSC behavior, clamp to today (no -2 needed)
  const t = todayISO();
  return endIso > t ? t : endIso;
}

async function loadGaPropsOnce(){
  if (GA.props) return;
  const r = await send({ type:"gaListProperties" });
  if (!r.ok) throw new Error(r.error || "Failed to list GA properties");
  GA.props = r.data || [];
  const sel = $('gaProps'); sel.innerHTML = "";
  GA.props.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.id; opt.textContent = `${p.account} • ${p.displayName} (p:${p.id})`;
    sel.appendChild(opt);
  });
}

on('navAnalytics','click', async ()=>{
  try{
    await loadGaPropsOnce();
    const r = await send({ type: "gaDetectFromTab" });
    if (r.ok && r.data && r.data.propertyId){
      const sel = $('gaProps');
      if (sel && !Array.from(sel.options).some(o => o.value === r.data.propertyId)){
        // if property not in the list (rare), just skip
      }else if (sel){
        sel.value = r.data.propertyId;
        // Optional: small toast/note
        clearResult(`Matched GA4 property via ${r.data.via}: <b>${escapeHtml(r.data.propertyName)}</b> (G-ID: ${escapeHtml(r.data.measurementId||'—')})`, 'gaResult');
      }
    } else if (r.ok && r.data?.foundGIds?.length){
      clearResult(`Found GA IDs on page: ${r.data.foundGIds.join(', ')} — no matching property found in your account.`, 'gaResult');
    }
  }catch(e){
    // non-fatal; keep UI usable
  }
});


$('gaRange').addEventListener('change', ()=>{
  const custom = $('gaRange').value === 'custom';
  $('gaCustom').style.display = custom ? 'grid' : 'none';
});

$('gaLoad').addEventListener('click', async ()=>{
  const prop = $('gaProps')?.value;
  if (!prop) return clearResult("Pick a GA4 property first.", 'gaResult');

  let start, end;
  const rng = $('gaRange').value;
  if (rng === 'custom'){
    start = $('gaStart').value; end = $('gaEnd').value || todayISO();
    if (!start) return clearResult('Select a custom start date.', 'gaResult');
    if (start > end) return clearResult('Start date must be before end date.', 'gaResult');
  } else {
    const days = Number(rng);
    end = todayISO(); start = isoDaysAgo(days);
  }
  end = ensureLaggedEnd(end);

  const dim = $('gaDim').value || 'date';
  clearResult('Loading GA4…', 'gaResult');
  const rNow = await send({ type:"gaReport", propertyId: prop, startDate:start, endDate:end, dimension: dim });
  if (!rNow.ok) return clearResult('❌ ' + (rNow.error||'GA4 error'), 'gaResult');

  let prevData = null;
  if ($('gaCompare')?.checked){
    // previous period: same length immediately before start
    const msPerDay = 86400000;
    const s = new Date(start + "T00:00:00");
    const e = new Date(end + "T00:00:00");
    const spanDays = Math.max(1, Math.round((e - s)/msPerDay) + 1);
    const prevEnd = new Date(s.getTime() - msPerDay);
    const prevStart = new Date(prevEnd.getTime() - (spanDays-1)*msPerDay);
    const toISO = d => d.toISOString().slice(0,10);
    const rPrev = await send({ type:"gaReport", propertyId: prop, startDate: toISO(prevStart), endDate: toISO(prevEnd), dimension: dim });
    if (rPrev.ok) prevData = rPrev.data;
  }
  renderGaReport(rNow.data, { start, end, dim, prop }, prevData);
});

// Renderers
function renderGaReport(currData, meta, prevData){
  const res = $('gaResult');

  // empty state
  if (!currData || !Array.isArray(currData.rows) || !currData.rows.length){
    res.innerHTML = `<div class="card">No data for ${meta.start} → ${meta.end}.</div>`;
    return;
  }

  const metricIndexByName = Object.fromEntries((currData.metricHeaders||[]).map((h,i)=>[h.name,i]));
  const dimLabel = GA_DIM_LABELS[meta.dim] || meta.dim;

  // sums
  const sums = {};
  for (const row of currData.rows){
    row.metricValues?.forEach((mv,i)=>{
      const key = currData.metricHeaders[i].name;
      sums[key] = (sums[key]||0) + Number(mv.value||0);
    });
  }

  // prev sums (compare)
  let prevSums = null;
  if (prevData && Array.isArray(prevData.rows)){
    prevSums = {};
    for (const row of prevData.rows){
      row.metricValues?.forEach((mv,i)=>{
        const key = prevData.metricHeaders[i].name;
        prevSums[key] = (prevSums[key]||0) + Number(mv.value||0);
      });
    }
  }

  const metric = $('gaMetric')?.value || 'activeUsers';
  const mIdx = metricIndexByName[metric] ?? 0;
  const series = currData.rows.map(r => Number(r.metricValues?.[mIdx]?.value || 0));

  // KPI cards
  const kpi = (label, key) => {
    const val = sums[key]||0;
    const prev = prevSums ? (prevSums[key]||0) : null;
    const d = gaPctDelta(val, prev);
    return `<div class="kpi">
      <h5>${label}</h5>
      <span class="val">${gaNf(val)}</span>
      <span class="delta ${d.cls}">${d.text}</span>
    </div>`;
  };

  const kpiGrid = `
    <div class="kpi-grid">
      ${kpi('activeUsers','activeUsers')}
      ${kpi('sessions','sessions')}
      ${kpi('screenPageViews','screenPageViews')}
      ${kpi('eventCount','eventCount')}
    </div>
    ${meta.dim === 'date' ? gaSparklineSVG(series) : ''}
  `;

  // Table
  const header = (currData.dimensionHeaders||[]).map(h=>GA_DIM_LABELS[h.name]||h.name)
                 .concat((currData.metricHeaders||[]).map(h=>h.name));

  const rows = currData.rows.map(r=>{
    const dims = (r.dimensionValues||[]).map(v=> `<td>${escapeHtml(v.value||'')}</td>`);
    const mets = (r.metricValues||[]).map((v,i)=> `<td style="text-align:right">${gaNf(v.value||0)}</td>`);
    return `<tr>${dims.join('')}${mets.join('')}</tr>`;
  }).join('');

  const thead = `<tr>${header.map(x=>`<th>${escapeHtml(x)}</th>`).join('')}</tr>`;
  const table = `
    <div class="card">
      <h4>Breakdown by ${escapeHtml(dimLabel)}</h4>
      <div style="max-height:260px;overflow:auto;border:1px solid var(--border);border-radius:8px">
        <table class="table-compact"><thead>${thead}</thead><tbody>${rows}</tbody></table>
      </div>
    </div>`;

  res.innerHTML = `
    <div class="card"><h4>GA4 Summary (${meta.start} → ${meta.end})</h4>${kpiGrid}</div>
    ${table}
  `;

  // CSV export handler (current view)
  $('gaExport')?.addEventListener('click', ()=>{
    const csv = gaToCSV(currData);
    const blob = new Blob([csv], {type:'text/csv'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ga4-${meta.dim}-${meta.start}-${meta.end}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, { once:true });
}



// ensure when user opens the tab first time we populate property list
$('navAnalytics').addEventListener('click', async ()=>{
  const panel = $('panelAnalytics');
  if (!panel.classList.contains('hidden')) return;
  try{ await loadGaPropsOnce(); }catch(e){ clearResult('❌ '+String(e), 'gaResult'); }
});

// ---- GA helpers ----
const GA_DIM_LABELS = {
  date: "Date",
  sessionDefaultChannelGroup: "Default Channel Group",
  country: "Country",
  pagePathPlusQueryString: "Page"
};
function gaNf(n){ return Number(n||0).toLocaleString(); }
function gaPctDelta(curr, prev){
  if (prev == null || prev === 0) return {text:"—", cls:""};
  const d = ((curr - prev) / prev) * 100;
  return { text: (d>0?"+":"") + d.toFixed(1) + "%", cls: d>=0 ? "up" : "down" };
}
function gaSparklineSVG(vals){
  const w=120,h=28,p=2;
  if (!vals || !vals.length) return "";
  const min = Math.min(...vals), max = Math.max(...vals);
  const sx = (i)=> p + (i*(w-2*p)/Math.max(1, vals.length-1));
  const sy = (v)=> max===min ? h/2 : p + (h-2*p) * (1 - (v-min)/(max-min));
  let d="";
  vals.forEach((v,i)=>{ d += (i?" L":"M")+sx(i).toFixed(1)+" "+sy(v).toFixed(1); });
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>`;
}
function gaToCSV(data){
  const dimH = (data.dimensionHeaders||[]).map(h=>h.name);
  const metH = (data.metricHeaders||[]).map(h=>h.name);
  const head = dimH.concat(metH);
  const lines = [ head.join(",") ];
  for (const r of (data.rows||[])){
    const dims = (r.dimensionValues||[]).map(v=> `"${String(v.value||"").replace(/"/g,'""')}"`);
    const mets = (r.metricValues||[]).map(v=> String(v.value||"0"));
    lines.push(dims.concat(mets).join(","));
  }
  return lines.join("\n");
}


// Ends GA4


/* ---------- Active tab helpers ---------- */
async function getActiveTab(){ const [tab] = await chrome.tabs.query({ active:true, currentWindow:true }); return tab; }
async function getActiveTabUrl(){
  try{ const tab = await getActiveTab(); const url = tab?.url || ''; return /^https?:/i.test(url) ? url : ''; }
  catch{ return ''; }
}
function chooseBestProperty(sites, pageUrl){
  if(!Array.isArray(sites) || !pageUrl) return null;
  let best = null, bestScore = -1, bestLen = -1;
  let host = ''; try { host = new URL(pageUrl).hostname || ''; } catch{}
  for(const s of sites){
    const site = s.siteUrl; let covers = false, score = 0, len = site.length;
    if(site.startsWith('sc-domain:')){
      const domain = site.split(':')[1];
      if(host === domain || (host && host.endsWith('.'+domain))){ covers = true; score = 1; len = domain.length; }
    } else if(pageUrl.startsWith(site)){ covers = true; score = 2; len = site.length; }
    if(covers){ if(score > bestScore || (score === bestScore && len > bestLen)){ best = site; bestScore = score; bestLen = len; } }
  }
  return best;
}

/* ---------- Renderers ---------- */
function ms(v){ return typeof v==='number' ? `${(v/1000).toFixed(2)}s` : (v||'—'); }
function renderIndexing(data){
  const i = data?.inspectionResult || data; if(!i){ clearResult('No data'); return; }
  const idx = i.indexStatusResult || {};
  const cards = [];
  cards.push(`<div class="card">
    <h4>Indexing Status</h4>
    ${kv('Verdict', stateBadge(idx?.verdict || 'UNKNOWN'))}
    ${kv('Coverage', idx?.coverageState || 'Unknown')}
    ${kv('Last crawl', idx?.lastCrawlTime || '—')}
    ${kv('Robots', idx?.robotsTxtState || '—')}
    ${kv('User canonical', idx?.userCanonical || '—')}
    ${kv('Google canonical', idx?.googleCanonical || '—')}
  </div>`);
  if(i.mobileUsabilityResult){
    cards.push(`<div class="card">
      <h4>Mobile Usability</h4>
      ${kv('Status', stateBadge(i.mobileUsabilityResult.verdict || 'UNKNOWN'))}
    </div>`);
  }
  const result = $('result'); if (result) result.innerHTML = cards.join('');
  setRaw(i);
  const rp = $('rawPanel'); if(rp) rp.open = true;
}


function renderPSI(data){
  const lr = data?.lighthouseResult || {};
  const audits = lr.audits || {};
  const cats = lr.categories || {};
  const metrics = audits.metrics?.details?.items?.[0] || {};
  const shot = audits['final-screenshot']?.details?.data || null;

  // Field data (CrUX) containers
  const pageField   = data?.loadingExperience || {};
  const originField = data?.originLoadingExperience || {};

  // Existing badges
  const perf = Math.round((cats.performance?.score ?? 0) * 100);
  const seo  = Math.round((cats.seo?.score ?? 0) * 100);
  const acc  = Math.round((cats.accessibility?.score ?? 0) * 100);
  const bp   = Math.round((cats['best-practices']?.score ?? 0) * 100);

  // helpers
  const pct = (n)=> typeof n === 'number' ? `${Math.round(n)}%` : '—';
  const ms2 = (n)=> ms(n); // keep your existing ms() formatting

  // Build a compact stacked bar for CrUX distributions (inline styles so no CSS edits needed)
  function cruxBar(m, metricKey){
    if (!m || !m.metrics || !m.metrics[metricKey]) return '—';
    const mc = m.metrics[metricKey];
    const dist = mc.distributions || [];
    const p = mc.percentile;
    const cat = mc.category || '';
    const seg = (prop, color) =>
      `<span style="display:inline-block;height:100%;width:${Math.max(1, Math.round((prop||0)*100))}%;background:${color}"></span>`;
    const labelVal = (metricKey.includes('CUMULATIVE_LAYOUT_SHIFT')
      ? (p!=null ? (p/100).toFixed(3) : '—')
      : (p!=null ? `${Math.round(p)} ms` : '—'));

    return `
      <div style="position:relative;height:12px;border-radius:999px;border:1px solid var(--border);overflow:hidden;background:#1b2130">
        ${seg(dist[0]?.proportion, 'rgba(25,195,125,.5)')}
        ${seg(dist[1]?.proportion, 'rgba(245,165,36,.5)')}
        ${seg(dist[2]?.proportion, 'rgba(239,68,68,.5)')}
        <span style="position:absolute;left:8px;top:50%;transform:translateY(-50%);font-size:11px;opacity:.8">
          ${cat} • P${labelVal}
        </span>
      </div>`;
  }

  const cards = [];

  // Summary
  cards.push(`<div class="card">
    <h4>📱 Mobile Audit (Lighthouse)</h4>
    ${kv('Performance',    stateBadge(perf + '/100'))}
    ${kv('SEO',            stateBadge(seo + '/100'))}
    ${kv('Accessibility',  stateBadge(acc + '/100'))}
    ${kv('Best Practices', stateBadge(bp + '/100'))}
  </div>`);

  // Lab metrics
  cards.push(`<div class="card">
    <h4>Core/Key Metrics (Lab)</h4>
    ${kv('LCP',               ms2(metrics['largest-contentful-paint']))}
    ${kv('TBT (INP proxy)',   ms2(metrics['total-blocking-time']))}
    ${kv('CLS',               (typeof metrics['cumulative-layout-shift']==='number' ? metrics['cumulative-layout-shift'].toFixed(3) : '—'))}
    ${kv('FCP',               ms2(metrics['first-contentful-paint']))}
    ${kv('TTI',               ms2(metrics['interactive']))}
    ${kv('Speed Index',       ms2(metrics['speed-index']))}
  </div>`);

  // CrUX (page)
  const cruxPage =
    kv('FCP (field)', cruxBar(pageField, 'FIRST_CONTENTFUL_PAINT_MS')) +
    kv('LCP (field)', cruxBar(pageField, 'LARGEST_CONTENTFUL_PAINT_MS')) +
    kv('INP (field)', cruxBar(pageField, 'INTERACTION_TO_NEXT_PAINT')) +
    kv('CLS (field)', cruxBar(pageField, 'CUMULATIVE_LAYOUT_SHIFT_SCORE')) +
    kv('TTFB (field)', cruxBar(pageField, 'EXPERIMENTAL_TIME_TO_FIRST_BYTE'));
  if (cruxPage.trim()) {
    cards.push(`<div class="card"><h4>CrUX (This Page)</h4>${cruxPage}</div>`);
  }

  // CrUX (origin)
  const cruxOrigin =
    kv('FCP (origin)', cruxBar(originField, 'FIRST_CONTENTFUL_PAINT_MS')) +
    kv('LCP (origin)', cruxBar(originField, 'LARGEST_CONTENTFUL_PAINT_MS')) +
    kv('INP (origin)', cruxBar(originField, 'INTERACTION_TO_NEXT_PAINT')) +
    kv('CLS (origin)', cruxBar(originField, 'CUMULATIVE_LAYOUT_SHIFT_SCORE')) +
    kv('TTFB (origin)', cruxBar(originField, 'EXPERIMENTAL_TIME_TO_FIRST_BYTE'));
  if (cruxOrigin.trim()) {
    cards.push(`<div class="card"><h4>CrUX (Origin)</h4>${cruxOrigin}</div>`);
  }

  // Opportunities (top 8)
  const opps = Object.values(audits)
    .filter(a => a?.details?.type === 'opportunity')
    .sort((a,b) => (b?.details?.overallSavingsMs||0) - (a?.details?.overallSavingsMs||0))
    .slice(0,8);
  if (opps.length){
    cards.push(`<div class="card">
      <h4>Opportunities</h4>
      <table style="width:100%;border-collapse:collapse">
        <thead>
          <tr>
            <th style="text-align:left;padding:6px 8px;color:var(--muted);font-weight:600;border-top:1px solid var(--border)">Audit</th>
            <th style="text-align:right;padding:6px 8px;color:var(--muted);font-weight:600;border-top:1px solid var(--border)">Est. Savings</th>
          </tr>
        </thead>
        <tbody>
          ${opps.map(o => `
            <tr>
              <td style="padding:6px 8px;border-top:1px solid var(--border)">${o.title || o.id}</td>
              <td style="padding:6px 8px;border-top:1px solid var(--border);text-align:right">${ms2(o?.details?.overallSavingsMs||0)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`);
  }

  // Screenshot
  if (shot) {
    cards.push(`<div class="card">
      <h4>Rendered Screenshot</h4>
      <img alt="Final screenshot" src="${shot}" style="width:100%;border-radius:10px;border:1px solid var(--border)" />
    </div>`);
  }

  const result = $('result');
  if (result) result.innerHTML = cards.join('');

  // keep your raw JSON viewer behavior
  setRaw(data);
  const rp = $('rawPanel'); if (rp) rp.open = true; // set to false if you prefer collapsed by default
}



function renderPerf(data, meta){
  const row = (data?.rows && data.rows[0]) || { clicks:0, impressions:0, ctr:0, position:0 };
  const scopeLabel = meta.wholeProperty ? 'Whole property' : 'This page';
  const dateLabel = `${meta.start} → ${meta.end}`;
  const cards = [`<div class="card">
    <h4>Performance (totals)</h4>
    ${kv('Scope', scopeLabel)}
    ${kv('Date range', dateLabel)}
    ${kv('Clicks', row.clicks ?? 0)}
    ${kv('Impressions', row.impressions ?? 0)}
    ${kv('CTR', ((row.ctr ?? 0)*100).toFixed(2) + '%')}
    ${kv('Avg position', (row.position ?? 0).toFixed(2))}
  </div>`];
  const result = $('result'); if (result) result.innerHTML = cards.join('');
  setRaw(data);
  const rp = $('rawPanel'); if(rp) rp.open = false;
}
function renderOnPage(d){
  const cards = [`<div class="card">
    <h4>On-Page Summary</h4>
    ${kv('Title', d.title || '—')}
    ${kv('Meta description', d.metaDesc || '—')}
    ${kv('Robots meta', d.robotsMeta || '—')}
    ${kv('Canonical', d.canonical || '—')}
    ${kv('H1 count', d.h1Count ?? '—')}
    ${kv('Word count', d.wordCount ?? '—')}
    ${kv('Links (internal / external)', `${d.internalLinks ?? 0} / ${d.externalLinks ?? 0}`)}
    ${kv('Images (missing alt)', `${d.imgCount ?? 0}  (${d.imgMissingAlt ?? 0} missing alt)`)}
    ${kv('JSON-LD types', (d.ldTypes || []).join(', ') || '—')}
  </div>`];
  const result = $('result'); if (result) result.innerHTML = cards.join('');
  setRaw(d || {});
  const rp = $('rawPanel'); if(rp) rp.open = true;
}

/* ---------- deep links ---------- */
function openGSCInspect(siteUrl, url){
  const encoded = encodeURIComponent(url);
  const base = 'https://search.google.com/search-console/inspect';
  const qs = `?resource_id=${encodeURIComponent(siteUrl)}&url=${encoded}`;
  chrome.tabs.create({ url: base + qs });
}
const openGSCLive = openGSCInspect;

/* ---------- messaging ---------- */
async function send(msg){ return await chrome.runtime.sendMessage(msg); }

/* ---------- Dates ---------- */
function toISO(daysAgo){ const d = new Date(Date.now() - daysAgo*86400000); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function todayISO(){ const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }

/* ---------- Account label ---------- */
// safe JWT payload decoder (no deprecated escape())
function parseIdToken(idToken){
  try{
    const base64Url = idToken.split('.')[1];            // JWT payload
    const base64 = base64Url.replace(/-/g,'+').replace(/_/g,'/'); // base64url -> base64
    const bin = atob(base64);                           // binary string
    const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
    const json = new TextDecoder().decode(bytes);       // UTF-8 decode
    return JSON.parse(json);
  }catch{
    return null;
  }
}

async function setAccountLabel(){
  try{
    const r = await send({ type:'getAccount' });
    const idToken = r?.data || null;
    const payload = idToken ? parseIdToken(idToken) : null;
    const email = payload?.email || '';
    const label = $('accountLabel'); if (label) label.textContent = email ? `Signed in as ${email}` : '';
    const mini = $('accountMini'); if (mini) mini.textContent = email ? `Signed in: ${email}` : 'Signed in: —';
  }catch(e){ console.warn(e); }
}

/* ---------- NAV ---------- */
const navMap = {
  navIndex:     "panelIndex",
  navLive:      "panelLive",
  navAnalytics: "panelAnalytics",
  navPerf:      "panelPerf",
  navOnPage:    "panelOnPage"
};

function mountNav(){
  const show = (navId)=>{
    Object.values(navMap).forEach(id => { if(id){ const el=$(id); if(el) el.classList.add('hidden'); } });
    const pid = navMap[navId];
    if (pid) { const el=$(pid); if(el) el.classList.remove('hidden'); }

    // highlight selected
    Object.keys(navMap).forEach(nid => { const b=$(nid); if(b) b.classList.remove('active'); });
    const btn=$(navId); if(btn) btn.classList.add('active');

    // ✅ hide GSC top inputs only on Analytics
    const top = $('topControls');
    if (top) top.style.display = (pid === 'panelAnalytics') ? 'none' : '';
  };
  Object.keys(navMap).forEach(nid => { const b=$(nid); if(b) b.addEventListener('click', ()=>show(nid)); });
  show('navPerf'); // default
}


/* ---------- INIT ---------- */
async function init(){
  $('version').textContent = 'v' + (chrome.runtime.getManifest().version || '0');

  clearResult('Sign in if prompted, then pick your property.');
  mountNav();
  setAccountLabel().catch(()=>{});

  // prefill active tab url
  const tabUrlRaw = await getActiveTabUrl().catch(()=> '');
  const tabUrl = tabUrlRaw ? normalizeUrl(tabUrlRaw) : '';
  if (tabUrl && $('inspectUrl')) $('inspectUrl').value = tabUrl;

  // load sites
  const sitesResp = await send({ type:'listSites' }).catch(e => ({ ok:false, error:String(e)}));
  if(!sitesResp.ok){
    clearResult('Failed to load properties: ' + sitesResp.error);
  } else {
    setSites(sitesResp.data);
    if (tabUrl) {
      const best = chooseBestProperty(sitesResp.data, tabUrl);
      if (best && $('sites')) $('sites').value = best;
    }
    setEnabled();
    clearResult('');
  }

  // input enables
  $('inspectUrl').addEventListener('input', setEnabled);
  $('sites').addEventListener('change', setEnabled);

  // Performance pills/scope
  qsa('.pill').forEach(pill => pill.addEventListener('click', ()=>{
    qsa('.pill').forEach(x=>x.classList.remove('active'));
    pill.classList.add('active');
    state.perf.range = pill.dataset.range;
    const isCustom = state.perf.range === 'custom';
    $('customRange').classList.toggle('hidden', !isCustom);
    if(!isCustom){ $('dateStart').value=''; $('dateEnd').value=''; }
    setEnabled();
  }));
  $('scopeSwitch').addEventListener('click', ()=>{
    $('scopeSwitch').classList.toggle('on');
    state.perf.wholeProperty = $('scopeSwitch').classList.contains('on');
    setEnabled();
  });

  // Buttons
  $('refreshSites').onclick = async ()=>{
    clearResult('Loading properties…');
    const r = await send({ type:'listSites' });
    if(r.ok){
      setSites(r.data);
      const url = normalizeUrl($('inspectUrl')?.value?.trim() || '');
      if (url) { const best = chooseBestProperty(r.data, url); if (best && $('sites')) $('sites').value = best; }
      setEnabled(); clearResult('');
    } else clearResult('Failed to load properties: ' + r.error);
  };

  $('inspect').onclick = async ()=>{
    const siteUrl = $('sites')?.value?.trim(); const url = normalizeUrl($('inspectUrl')?.value?.trim() || '');
    if(!url) return clearResult('Enter a valid http(s) URL.');
    if(!propertyCoversUrl(siteUrl, url)) return clearResult('Selected property does not cover this URL.');
    clearResult('Inspecting…');
    const r = await send({ type:'inspect', siteUrl, url });
    if(r.ok){ renderIndexing(r.data); } else { clearResult('❌ ' + r.error); }
  };

  $('openGSC').onclick = ()=>{
    const siteUrl = $('sites')?.value?.trim(); const url = normalizeUrl($('inspectUrl')?.value?.trim() || '');
    if(siteUrl && url) openGSCInspect(siteUrl, url);
  };

  $('liveTest').onclick = async ()=>{
    const siteUrl = $('sites')?.value?.trim(); const url = normalizeUrl($('inspectUrl')?.value?.trim() || '');
    if(!url) return clearResult('Live Test needs a publicly reachable http(s) URL.');
    if(!propertyCoversUrl(siteUrl, url)) return clearResult('Live Test available only for verified properties that cover this URL.');
    clearResult('Running Lighthouse mobile audit…');
    const r = await send({ type:'liveTest', siteUrl, url });
    if(r.ok) renderPSI(r.data); else clearResult('❌ ' + r.error);
  };
  $('openLiveGSC').onclick = ()=>{
    const siteUrl = $('sites')?.value?.trim(); const url = normalizeUrl($('inspectUrl')?.value?.trim() || '');
    if(siteUrl && url) openGSCLive(siteUrl, url);
  };

  $('loadPerf').onclick = async ()=>{
    const siteUrl = $('sites')?.value?.trim();
    const whole = state.perf.wholeProperty;
    if(!siteUrl) return clearResult('Select a property.');
    const url = normalizeUrl($('inspectUrl')?.value?.trim() || '');
    if(!whole){
      if(!url) return clearResult('Enter a valid http(s) URL for page-level data.');
      if(!propertyCoversUrl(siteUrl, url)) return clearResult('Selected property does not cover this URL.');
    }
    let startDate, endDate;
    const today = new Date();
    const clampTo = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 2); // today - 2
    const clampISO = (d)=> `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    
    if(state.perf.range === 'custom'){
      startDate = $('dateStart')?.value || '';
      endDate = $('dateEnd')?.value || clampISO(clampTo);
      if(!startDate) return clearResult('Pick a start date.');
      if(startDate > endDate) return clearResult('Start date must be before end date.');
      // clamp if user picked a too-fresh end date
      if (endDate > clampISO(clampTo)) endDate = clampISO(clampTo);
    } else {
      const days = Number(state.perf.range || 30);
      endDate = clampISO(clampTo);
      startDate = toISO(days + 2); // keep the same span while ending 2 days earlier
    }
    clearResult('Loading performance…');
    const r = await send({ type:'perf', siteUrl, url: whole ? null : url, startDate, endDate, pageOnly: !whole });
    if(r.ok) renderPerf(r.data, { start:startDate, end:endDate, wholeProperty:whole });
    else clearResult('❌ ' + r.error);
  };

  $('runOnPage').onclick = async ()=>{
    const tab = await getActiveTab();
    if (!tab || !/^https?:/i.test(tab.url || '')) return clearResult('Open a public http(s) page to run On-Page audit.');
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const abs = (href)=>{ try{ return new URL(href, location.href).href; }catch{ return null; } };
        const txt = (sel)=> (document.querySelector(sel)?.getAttribute('content') || '').trim();
        const title = (document.title || '').trim();
        const metaDesc = txt('meta[name="description"]') || txt('meta[name="Description"]') || '';
        const robotsMeta = (txt('meta[name="robots"]') || txt('meta[name="ROBOTS"]')).toLowerCase();
        const xRobotsTag = '';
        const canonical = abs(document.querySelector('link[rel="canonical"]')?.getAttribute('href') || '') || '';
        let canonicalCrossDomain = false;
        try{
          if (canonical) {
            const ch = new URL(canonical).hostname.replace(/^www\./,'');
            const ph = location.hostname.replace(/^www\./,'');
            canonicalCrossDomain = ch && ph && ch !== ph;
          }
        }catch{}
        const h1s = Array.from(document.querySelectorAll('h1')).map(e=>e.textContent.trim()).filter(Boolean);
        const h1Count = h1s.length;
        const bodyText = (document.body?.innerText || '').replace(/\s+/g,' ').trim();
        const wordCount = bodyText ? bodyText.split(/\s+/).filter(w=>/\w/.test(w)).length : 0;
        const aTags = Array.from(document.querySelectorAll('a[href]'));
        let internalLinks = 0, externalLinks = 0;
        aTags.forEach(a=>{
          const u = abs(a.getAttribute('href')); if(!u) return;
          try{
            const uh = new URL(u).hostname.replace(/^www\./,'');
            const ph = location.hostname.replace(/^www\./,'');
            if(uh === ph) internalLinks++; else externalLinks++;
          }catch{}
        });
        const imgs = Array.from(document.querySelectorAll('img'));
        const imgCount = imgs.length;
        const imgMissingAlt = imgs.filter(i => !i.hasAttribute('alt') || String(i.getAttribute('alt')).trim()==='').length;
        const ldTypes = [];
        Array.from(document.querySelectorAll('script[type="application/ld+json"]')).forEach(s=>{
          try{
            const data = JSON.parse(s.textContent || 'null');
            const collect = (obj)=>{
              if(!obj) return;
              if(Array.isArray(obj)) return obj.forEach(collect);
              const t = obj['@type'];
              if(typeof t === 'string') ldTypes.push(t);
              else if(Array.isArray(t)) t.forEach(x=> typeof x==='string' && ldTypes.push(x));
              if (obj['@graph']) collect(obj['@graph']);
            };
            collect(data);
          }catch{}
        });
        return { url: location.href, title, metaDesc, robotsMeta, xRobotsTag,
                 canonical, canonicalCrossDomain, h1Count, wordCount,
                 internalLinks, externalLinks, imgCount, imgMissingAlt,
                 ldTypes: Array.from(new Set(ldTypes)) };
      }
    });
    renderOnPage(result || {});
  };

  $('logout').onclick = async (e)=>{ e.preventDefault(); await send({ type:'logout' }); $('accountLabel').textContent=''; $('accountMini').textContent='Signed in: —'; clearResult('Signed out. Reload properties to sign in again.'); };
}

/* ---------- Kick off ---------- */
const start = () => safe(init);
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start, { once:true });
} else {
  start();
}