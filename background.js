// background.js — MV3 module service worker
// OAuth (PKCE + client_secret when provided), GSC, PSI

import * as CFG from "./config.js";

const CLIENT_ID = CFG.CLIENT_ID;
const CLIENT_SECRET = CFG.CLIENT_SECRET || ""; // <-- optional, but required for Web client
const SCOPES = CFG.SCOPES;
const PSI_API_KEY = CFG.PSI_API_KEY || "";

const storage = chrome.storage.local;

async function getFromStore(key){ return (await storage.get(key))[key]; }
async function setInStore(obj){ return await storage.set(obj); }
async function delInStore(key){ return await storage.remove(key); }

function b64UrlEncode(ab){
  const b64 = btoa(String.fromCharCode(...new Uint8Array(ab)));
  return b64.replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
}
function str2ab(str){ return new TextEncoder().encode(str); }
async function sha256(str){
  const ab = await crypto.subtle.digest("SHA-256", str2ab(str));
  return b64UrlEncode(ab);
}

// ---------- OAuth (PKCE) ----------
async function getTokenInteractive(){
  const codeVerifier = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/[^a-zA-Z0-9]/g,"");
  const codeChallenge = await sha256(codeVerifier);
  const redirectUri = chrome.identity.getRedirectURL(); // https://<ext-id>.chromiumapp.org/

  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", CLIENT_ID);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", SCOPES);
  authUrl.searchParams.set("prompt", "consent");   // to get refresh_token
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("include_granted_scopes", "true");


  const resUrl = await chrome.identity.launchWebAuthFlow({ url: authUrl.toString(), interactive: true });
  const code = new URL(resUrl).searchParams.get("code");
  if(!code) throw new Error("No auth code received");

  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
    code_verifier: codeVerifier
  });
  if (CLIENT_SECRET) body.set("client_secret", CLIENT_SECRET); // <-- add secret when using Web client

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type":"application/x-www-form-urlencoded" },
    body
  }).then(r=>r.json());

  if(tokenRes.error) throw new Error(tokenRes.error_description || tokenRes.error);

  const now = Math.floor(Date.now()/1000);
  const token = {
    access_token: tokenRes.access_token,
    refresh_token: tokenRes.refresh_token || null,
    expires_at: now + (tokenRes.expires_in || 3600) - 60,
    id_token: tokenRes.id_token || null
  };
  await setInStore({ token });
  return token;
}

async function refreshToken(rt){
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: rt
  });
  if (CLIENT_SECRET) body.set("client_secret", CLIENT_SECRET); // <-- add if present

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type":"application/x-www-form-urlencoded" },
    body
  }).then(r=>r.json());

  if(tokenRes.error) throw new Error(tokenRes.error_description || tokenRes.error);

  const now = Math.floor(Date.now()/1000);
  const token = {
    access_token: tokenRes.access_token,
    refresh_token: rt,
    expires_at: now + (tokenRes.expires_in || 3600) - 60,
    id_token: tokenRes.id_token || null
  };
  await setInStore({ token });
  return token;
}

async function getToken(){
  let token = await getFromStore("token");
  const now = Math.floor(Date.now()/1000);
  if(token?.expires_at && token.expires_at > now) return token;
  if(token?.refresh_token){
    try { return await refreshToken(token.refresh_token); } catch(e){ /* fallthrough */ }
  }
  return await getTokenInteractive();
}

// ---------- HTTP helpers ----------
async function apiFetch(token, url, opt = {}){
  const o = Object.assign({ headers: {} }, opt);
  o.headers["Authorization"] = `Bearer ${token.access_token}`;
  if(opt.body && !o.headers["Content-Type"]) o.headers["Content-Type"] = "application/json";
  const r = await fetch(url, o);
  if(r.status === 401){
    const cur = await getFromStore("token");
    if(cur?.refresh_token){
      const t = await refreshToken(cur.refresh_token);
      o.headers["Authorization"] = `Bearer ${t.access_token}`;
      const rr = await fetch(url, o);
      if(!rr.ok) throw new Error(await rr.text());
      return rr;
    }
  }
  if(!r.ok){
    const txt = await r.text();
    throw new Error(txt || ("HTTP "+r.status));
  }
  return r;
}
// Put near your other helpers in background.js
async function withScopeRetry(run) {
  try {
    return await run();
  } catch (e) {
    const txt = String(e && e.message || e);
    // If token lacks scope, wipe it, re-auth, and retry once.
    if (/ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficient authentication scopes/i.test(txt)) {
      await delInStore("token");
      await getTokenInteractive();   // launches consent screen
      return await run();
    }
    throw e;
  }
}

function covers(siteUrl, pageUrl){
  try{
    if(siteUrl.startsWith("sc-domain:")){
      const domain = siteUrl.split(":")[1];
      const u = new URL(pageUrl);
      return u.hostname === domain || u.hostname.endsWith("."+domain);
    }
    return pageUrl.startsWith(siteUrl);
  }catch{ return false; }
}

// ---------- API wrappers ----------
async function listSites(){
  const token = await getToken();
  const res = await apiFetch(token, "https://www.googleapis.com/webmasters/v3/sites");
  const data = await res.json();
  return data?.siteEntry || [];
}
async function inspect(siteUrl, pageUrl){
  const token = await getToken();
  const payload = { inspectionUrl: pageUrl, siteUrl };
  const res = await apiFetch(token, "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect", {
    method:"POST", body: JSON.stringify(payload)
  });
  return await res.json();
}

// ===== GA4 =====

// List GA4 properties across all accounts (displayName + numeric id)
async function gaListProperties(){
  return withScopeRetry(async () => {
    const token = await getToken();
    const accRes = await apiFetch(token, "https://analyticsadmin.googleapis.com/v1beta/accounts");
    const accJson = await accRes.json();
    const accounts = accJson.accounts || [];
    const list = [];
    for (const a of accounts){
      const u = new URL("https://analyticsadmin.googleapis.com/v1beta/properties");
      u.searchParams.set("filter", "parent:" + a.name);
      u.searchParams.set("pageSize", "200");
      const pRes = await apiFetch(token, u.toString());
      const pJson = await pRes.json();
      for (const p of (pJson.properties || [])){
        const id = (p.name||"").split("/")[1];
        list.push({ id, displayName: p.displayName, account: a.displayName });
      }
    }
    list.sort((x,y)=> (x.account+x.displayName).localeCompare(y.account+y.displayName));
    return list;
  });
}

// Sync Active Tab to GA Proprty
// --- GA4 detection helpers ---

// List web data streams for a property
async function gaListWebStreams(propertyId){
  const token = await getToken();
  const url = `https://analyticsadmin.googleapis.com/v1beta/properties/${propertyId}/webDataStreams`;
  const res = await apiFetch(token, url);
  return await res.json();
}

// Inject into the active tab and collect GA4 Measurement IDs (G-XXXX…)
// Inject into ALL frames and collect GA4 Measurement IDs (G-XXXX…)
async function sniffGaMeasurementIdsFromTab(tabId, tries = 3, delayMs = 1200){
  const collectOnce = async () => {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: "MAIN",
      func: () => {
        const ids = new Set();
        const gtms = new Set();
        const push = v => { if (typeof v === 'string' && /^G-[A-Z0-9]{6,}/.test(v)) ids.add(v.trim()); };

        // 0) If gtag is present now, read known IDs from the queue/state
        try{
          // queued calls: gtag('config','G-XXXX')
          const dl = (window && window.dataLayer) || [];
          if (Array.isArray(dl)) {
            dl.forEach(ev=>{
              if (!ev || typeof ev !== 'object') return;
              // common shapes
              if (ev.measurement_id) push(ev.measurement_id);
              if (ev.send_to){
                if (Array.isArray(ev.send_to)) ev.send_to.forEach(push);
                else push(ev.send_to);
              }
              if (ev.config){
                if (Array.isArray(ev.config)) ev.config.forEach(push);
                else if (typeof ev.config === 'string') push(ev.config);
              }
            });
          }
        }catch(_){}

        // 1) Inline script contents
        document.querySelectorAll('script').forEach(s=>{
          try{
            const t = s.textContent || '';
            (t.match(/G-[A-Z0-9]{6,12}/g) || []).forEach(push);
            const src = s.getAttribute('src') || '';
            // gtag.js?id=G-XXXX, gtm.js?id=GTM-XXXX
            const m = src.match(/[?&]id=(G-[A-Z0-9]{6,12})/i);
            if (m) push(m[1]);
            const gtm = src.match(/[?&]id=(GTM-[A-Z0-9]{4,12})/i);
            if (gtm) gtms.add(gtm[1]);
          }catch(_){}
        });

        // 2) Meta / data attributes
        document.querySelectorAll('[data-measurement-id],meta[content^="G-"]').forEach(el=>{
          const v = el.getAttribute('data-measurement-id') || el.getAttribute('content') || '';
          push(v);
        });

        // 3) Noscript GTM iframe
        document.querySelectorAll('iframe[src*="googletagmanager.com/ns.html?id="]').forEach(f=>{
          const src = f.getAttribute('src') || '';
          const m = src.match(/[?&]id=(GTM-[A-Z0-9]{4,12})/i);
          if (m) gtms.add(m[1]);
        });

        return { ids: Array.from(ids), gtms: Array.from(gtms) };
      }
    });

    const set = new Set();
    (results || []).forEach(r => (r?.result?.ids || []).forEach(v => set.add(v)));
    return set;
  };

  let set = await collectOnce();
  while (set.size === 0 && tries-- > 0){
    await new Promise(r => setTimeout(r, delayMs));   // wait for GTM/consent to fire
    (await collectOnce()).forEach(v => set.add(v));
  }
  return set;
}


// Main: detect property for the active tab
async function gaDetectPropertyFromActiveTab(){
  const [tab] = await chrome.tabs.query({ active:true, currentWindow:true });
  if (!tab || !/^https?:/i.test(tab.url)) throw new Error("No http(s) active tab.");
  const tabHost = new URL(tab.url).host.toLowerCase();

  const gIds = await sniffGaMeasurementIdsFromTab(tab.id, 2, 1200);

  // Get all properties the user can access
  const props = await gaListProperties(); // you already have this
  let hostFallback = null;

  for (const p of props){
    const ws = await gaListWebStreams(p.id);
    for (const stream of (ws.webDataStreams || [])){
      const mId = stream.measurementId;
      const streamName = stream.name || '';
      const streamId = streamName.split('/').pop();
      const uri = (stream.defaultUri || '').toLowerCase();
      const uriHost = (()=>{ try{ return new URL(uri).host.toLowerCase(); }catch{ return ''; } })();

      // Best: direct measurementId match
      if (mId && gIds.has(mId)){
        return {
          propertyId: p.id, propertyName: p.displayName,
          measurementId: mId, streamId, defaultUri: uri,
          tabUrl: tab.url, via: "measurementId"
        };
      }
      // Fallback candidate: host equals stream defaultUri host
      if (!hostFallback && uriHost && uriHost === tabHost){
        hostFallback = {
          propertyId: p.id, propertyName: p.displayName,
          measurementId: mId || null, streamId, defaultUri: uri,
          tabUrl: tab.url, via: "hostMatch"
        };
      }
    }
  }

  return hostFallback || {
    propertyId: null, propertyName: null, measurementId: null,
    tabUrl: tab.url, via: "none", foundGIds: Array.from(gIds)
  };
}


// End Sync Active tab to GA Property

// Run a simple GA4 report
async function gaRunReport(propertyId, startDate, endDate, dimension){
  return withScopeRetry(async () => {
    const token = await getToken();
    const url = `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`;
    const body = {
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: dimension || "date" }],
      metrics: [
        { name: "activeUsers" },
        { name: "sessions" },
        { name: "screenPageViews" },
        { name: "eventCount" }
      ]
    };
    const res = await apiFetch(token, url, { method: "POST", body: JSON.stringify(body) });
    return await res.json();
  });
}
// GA4 Ends

async function liveTestPSI(pageUrl){
  const base = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";
  const params = new URLSearchParams({ url: pageUrl, category:"performance", strategy:"mobile" });
  if (PSI_API_KEY) params.set("key", PSI_API_KEY);

  let r = await fetch(base + "?" + params.toString());
  if (!r.ok) {
    const txt = await r.text();
    const isLH500 = (r.status >= 500) && /lighthouse/i.test(txt);
    // Retry once with desktop if Lighthouse crashed on mobile
    if (isLH500) {
      params.set("strategy", "desktop");
      r = await fetch(base + "?" + params.toString());
      if (!r.ok) throw new Error(await r.text());
      return await r.json();
    }
    throw new Error(txt || ("HTTP " + r.status));
  }
  return await r.json();
}

async function searchAnalytics(siteUrl, pageUrl, startDate, endDate, pageOnly = true){
  const token = await getToken();
  const body = { startDate, endDate, searchType: "web", dataState: "all" }; // include fresh data

  if (pageOnly && pageUrl){
    body.dimensionFilterGroups = [{
      filters: [{ dimension: "page", operator: "equals", expression: pageUrl }]
    }];
  }
  // Whole property totals (no page filter) -> force property aggregation
  if (!pageOnly) {
    body.aggregationType = "byProperty";
    body.rowLimit = 1;
  }
  const url = "https://www.googleapis.com/webmasters/v3/sites/" + encodeURIComponent(siteUrl) + "/searchAnalytics/query";
  const res = await apiFetch(token, url, { method:"POST", body: JSON.stringify(body) });
  const data = await res.json();

  // Fallback: sometimes property totals come back with empty rows.
  if (!pageOnly && (!data.rows || data.rows.length === 0)) {
    const byDateBody = { ...body, dimensions: ["date"], rowLimit: 1000 };
    const res2 = await apiFetch(token, url, { method:"POST", body: JSON.stringify(byDateBody) });
    const d2 = await res2.json();
    if (Array.isArray(d2.rows) && d2.rows.length) {
      const sums = d2.rows.reduce((acc, r) => {
        acc.clicks += r.clicks || 0;
        acc.impressions += r.impressions || 0;
        acc.positionSum += (typeof r.position === "number" ? r.position : 0);
        return acc;
      }, { clicks:0, impressions:0, positionSum:0 });
      const n = d2.rows.length;
      const ctr = sums.impressions ? (sums.clicks / sums.impressions) : 0;
      const position = n ? (sums.positionSum / n) : 0;
      data.rows = [{ clicks: sums.clicks, impressions: sums.impressions, ctr, position }];
    }
  }
  return data;
 }

async function probe(url){
  try{
    const r = await fetch(url, { method:"GET", redirect:"follow" });
    return { status: r.status, finalUrl: r.url || url };
  }catch(e){
    return { error: String(e) };
  }
}

// ---------- message router ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try{
      if (msg.type === "ping") return sendResponse({ ok:true, data:"pong" });

      if(msg.type === "listSites"){
        const s = await listSites(); return sendResponse({ ok:true, data:s });
      }
      if(msg.type === "inspect"){
        const { siteUrl, url } = msg;
        if(!covers(siteUrl, url)) return sendResponse({ ok:false, error:"Selected property does not cover this URL." });
        const d = await inspect(siteUrl, url); return sendResponse({ ok:true, data:d });
      }
      if(msg.type === "liveTest"){
        const { url } = msg;
        const d = await liveTestPSI(url); return sendResponse({ ok:true, data:d });
      }
      if(msg.type === "perf"){
        const { siteUrl, url, startDate, endDate, pageOnly } = msg;
        if(pageOnly && (!url || !covers(siteUrl, url))) return sendResponse({ ok:false, error:"Performance: selected property must cover the page URL." });
        const d = await searchAnalytics(siteUrl, url, startDate, endDate, !!pageOnly);
        return sendResponse({ ok:true, data:d });
      }
      if(msg.type === "probe"){
        const d = await probe(msg.url); return sendResponse({ ok:true, data:d });
      }
      if(msg.type === "logout"){
        await delInStore("token"); return sendResponse({ ok:true });
      }
      if(msg.type === "getAccount"){
        const t = await getFromStore("token"); return sendResponse({ ok:true, data: t?.id_token || null });
      }
            if (msg.type === "gaDetectFromTab"){
        const data = await gaDetectPropertyFromActiveTab();
        return sendResponse({ ok:true, data });
      } 
      // inside chrome.runtime.onMessage.addListener router
if (msg.type === "gaListProperties"){
  const props = await gaListProperties();
  return sendResponse({ ok:true, data: props });
}

if (msg.type === "gaReport"){
  const { propertyId, startDate, endDate, dimension } = msg;
  const data = await gaRunReport(propertyId, startDate, endDate, dimension);
  return sendResponse({ ok:true, data });
}
      // Ends inside chrome.runtime.onMessage.addListener router

      return sendResponse({ ok:false, error:"Unknown message" });
    }catch(e){
      console.error("[SCC] router error", e);
      sendResponse({ ok:false, error: String(e) });
    }
  })();
  return true;
});

console.log("[SCC] Service worker started");