"use strict";
/* ---------- tiny helpers ---------- */
const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const MIN = 60000, DAY = 86400000;
const MAX_TOTAL_EVENTS = 60000;
const MAX_BYTES = 10*1024*1024, MAX_EVENTS = 20000, MAX_PEOPLE = 24, WORK_BUDGET = 600000;
const BUDGET = {n: WORK_BUDGET, hit: false};
const COLORS = ['#0072B2','#D55E00','#009E73','#CC79A7','#E69F00','#56B4E9','#7A5195','#8C564B'];
const DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const DOWCODE = {SU:0,MO:1,TU:2,WE:3,TH:4,FR:5,SA:6};
const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

/* ---------- time zones ---------- */
const WIN_TZ = {"Eastern Standard Time":"America/New_York","Central Standard Time":"America/Chicago","Mountain Standard Time":"America/Denver","Pacific Standard Time":"America/Los_Angeles","US Mountain Standard Time":"America/Phoenix","Alaskan Standard Time":"America/Anchorage","Hawaiian Standard Time":"Pacific/Honolulu","GMT Standard Time":"Europe/London","Greenwich Standard Time":"Atlantic/Reykjavik","W. Europe Standard Time":"Europe/Berlin","Romance Standard Time":"Europe/Paris","Central Europe Standard Time":"Europe/Budapest","Central European Standard Time":"Europe/Warsaw","E. Europe Standard Time":"Europe/Chisinau","India Standard Time":"Asia/Kolkata","China Standard Time":"Asia/Shanghai","Tokyo Standard Time":"Asia/Tokyo","Korea Standard Time":"Asia/Seoul","AUS Eastern Standard Time":"Australia/Sydney","E. Australia Standard Time":"Australia/Brisbane","New Zealand Standard Time":"Pacific/Auckland","UTC":"UTC","Singapore Standard Time":"Asia/Singapore","Arabian Standard Time":"Asia/Dubai","Israel Standard Time":"Asia/Jerusalem","South Africa Standard Time":"Africa/Johannesburg","E. South America Standard Time":"America/Sao_Paulo","Canada Central Standard Time":"America/Regina","Atlantic Standard Time":"America/Halifax"};
const tzOk = {};
function resolveTz(tz){
  if(!tz) return null;
  if(tz in tzOk) return tzOk[tz];
  const tries = [tz, WIN_TZ[tz], tz.split('/').slice(-2).join('/'), tz.split('/').slice(-1)[0]];
  for(const t of tries){
    if(!t) continue;
    try{ new Intl.DateTimeFormat('en-US',{timeZone:t}); return (tzOk[tz]=t); }catch(e){}
  }
  return (tzOk[tz]=null);
}
const dtfCache = {};
function dtf(tz){
  return dtfCache[tz] || (dtfCache[tz] = new Intl.DateTimeFormat('en-US',{timeZone:tz,hourCycle:'h23',year:'numeric',month:'numeric',day:'numeric',hour:'numeric',minute:'numeric',second:'numeric'}));
}
function offsetAt(tz, ts){
  const p = {};
  dtf(tz).formatToParts(new Date(ts)).forEach(x => p[x.type] = x.value);
  return Date.UTC(+p.year, +p.month-1, +p.day, (+p.hour)%24, +p.minute, +p.second) - Math.floor(ts/1000)*1000;
}
function zonedToUtc(y,m,d,h,mi,s,tz){
  const guess = Date.UTC(y,m-1,d,h,mi,s);
  const o1 = offsetAt(tz, guess);
  let t = guess - o1;
  const o2 = offsetAt(tz, t);
  if(o2 !== o1) t = guess - o2;
  return t;
}

/* ---------- ICS parsing ---------- */
function splitUnquoted(str, sep){
  const out = []; let cur = '', q = false;
  for(const c of str){
    if(c === '"') q = !q;
    if(c === sep && !q){ out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur); return out;
}
function parseLine(line){
  let q = false, idx = -1;
  for(let i=0;i<line.length;i++){
    const c = line[i];
    if(c === '"') q = !q;
    else if(c === ':' && !q){ idx = i; break; }
  }
  if(idx < 0) return null;
  const parts = splitUnquoted(line.slice(0,idx), ';');
  const name = parts.shift().toUpperCase();
  const params = {};
  parts.forEach(p => { const e = p.indexOf('='); if(e > 0) params[p.slice(0,e).toUpperCase()] = p.slice(e+1).replace(/^"|"$/g,''); });
  return {name, params, value: line.slice(idx+1)};
}
function parseDT(prop){
  const m = /^(\d{4})(\d\d)(\d\d)(?:T(\d\d)(\d\d)(\d\d)?(Z)?)?$/i.exec((prop.value||'').trim());
  if(!m) return null;
  const allDay = prop.params.VALUE === 'DATE' || m[4] === undefined;
  return {allDay, y:+m[1], m:+m[2], d:+m[3], h:+(m[4]||0), mi:+(m[5]||0), s:+(m[6]||0), utc:!!m[7], tz: m[7] ? null : resolveTz(prop.params.TZID)};
}
function dtToTs(dt){
  if(dt.allDay) return new Date(dt.y, dt.m-1, dt.d).getTime();
  if(dt.utc) return Date.UTC(dt.y,dt.m-1,dt.d,dt.h,dt.mi,dt.s);
  if(dt.tz) return zonedToUtc(dt.y,dt.m,dt.d,dt.h,dt.mi,dt.s,dt.tz);
  return new Date(dt.y,dt.m-1,dt.d,dt.h,dt.mi,dt.s).getTime();
}
function parseDuration(v){
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec((v||'').trim());
  if(!m) return null;
  const ms = ((+m[2]||0)*7*24*3600 + (+m[3]||0)*24*3600 + (+m[4]||0)*3600 + (+m[5]||0)*60 + (+m[6]||0)) * 1000;
  return m[1] === '-' ? -ms : ms;
}
const unesc = s => (s||'').replace(/\\n/gi,' ').replace(/\\([,;\\])/g,'$1');

function parseICS(text){
  const lines = text.replace(/\r\n?/g,'\n').replace(/\n[ \t]/g,'').split('\n');
  let calName = '', cur = null, skip = 0, vevents = [];
  for(const raw of lines){
    const line = raw.trimEnd();
    if(!line) continue;
    const u = line.toUpperCase();
    if(u === 'BEGIN:VEVENT'){ cur = {}; skip = 0; continue; }
    if(u === 'END:VEVENT'){ if(cur) vevents.push(cur); cur = null; continue; }
    if(cur){
      if(u.startsWith('BEGIN:')){ skip++; continue; }
      if(u.startsWith('END:')){ skip = Math.max(0, skip-1); continue; }
      if(skip) continue;
    }
    const p = parseLine(line);
    if(!p) continue;
    if(cur){ (cur[p.name] = cur[p.name] || []).push(p); }
    else if(p.name === 'X-WR-CALNAME' && !calName) calName = unesc(p.value);
  }
  if(vevents.length > MAX_EVENTS) throw new Error('That calendar has over '+MAX_EVENTS.toLocaleString()+' events, which is too many to load safely. Export a shorter date range.');
  const events = [], overrides = [];
  for(const v of vevents){
    const ev = buildEvent(v);
    if(!ev) continue;
    (ev.recId != null ? overrides : events).push(ev);
  }
  // an edited single occurrence replaces that slot of its series
  for(const o of overrides){
    const master = events.find(e => e.uid && e.uid === o.uid && e.rrule);
    if(master) master.skip.add(o.recId);
    events.push(o);
  }
  return {calName, events, total: events.length, unsupported: events.filter(e => e.unsupported).length};
}
function buildEvent(p){
  const g = n => p[n] && p[n][0];
  const ds = g('DTSTART'); if(!ds) return null;
  if(((g('STATUS')||{}).value||'').toUpperCase() === 'CANCELLED') return null;
  if(((g('TRANSP')||{}).value||'').toUpperCase() === 'TRANSPARENT') return null;
  const start = parseDT(ds); if(!start) return null;
  let allDay = start.allDay, days = 1, dur = 0;
  const de = g('DTEND'), du = g('DURATION');
  if(de){
    const end = parseDT(de);
    if(end){
      if(allDay) days = Math.max(1, Math.round((Date.UTC(end.y,end.m-1,end.d) - Date.UTC(start.y,start.m-1,start.d))/DAY));
      else dur = dtToTs(end) - dtToTs(start);
    }
  } else if(du){
    const ms = parseDuration(du.value) || 0;
    if(allDay) days = Math.max(1, Math.round(ms/DAY)); else dur = ms;
  }
  if(!allDay && dur <= 0) return null;
  let rrule = null, unsupported = false;
  const rr = g('RRULE');
  if(rr){
    rrule = {};
    rr.value.split(';').forEach(kv => { const i = kv.indexOf('='); if(i>0) rrule[kv.slice(0,i).toUpperCase()] = kv.slice(i+1); });
    if(!rrule.FREQ) rrule = null;
    else unsupported = ['BYWEEKNO','BYYEARDAY','BYHOUR','BYMINUTE','BYSECOND'].some(k => k in rrule) || !['DAILY','WEEKLY','MONTHLY','YEARLY'].includes(rrule.FREQ.toUpperCase());
  }
  const skip = new Set();
  (p['EXDATE']||[]).forEach(x => x.value.split(',').forEach(val => {
    const dt = parseDT({value:val, params:Object.assign({}, x.params)});
    if(dt) skip.add(dtToTs(dt));
  }));
  const rid = g('RECURRENCE-ID');
  let recId = null;
  if(rid){ const dt = parseDT(rid); if(dt) recId = dtToTs(dt); }
  return {uid:(g('UID')||{}).value, title: unesc((g('SUMMARY')||{}).value) || 'Busy', start, allDay, days, dur, rrule, skip, recId, unsupported};
}

/* expand one event into [start,end,title] busy intervals overlapping [from,to] */
function expandEvent(ev, from, to, out){
  const st = ev.start;
  const mk = (y,m,d) => {
    if(ev.allDay){ const s = new Date(y,m-1,d).getTime(); return [s, new Date(y,m-1,d+ev.days).getTime()]; }
    let s;
    if(st.utc) s = Date.UTC(y,m-1,d,st.h,st.mi,st.s);
    else if(st.tz) s = zonedToUtc(y,m,d,st.h,st.mi,st.s,st.tz);
    else s = new Date(y,m-1,d,st.h,st.mi,st.s).getTime();
    return [s, s + ev.dur];
  };
  if(!ev.rrule || ev.unsupported){
    const [s,e] = mk(st.y,st.m,st.d);
    if(e > from && s < to) out.push([s,e,ev.title,ev.allDay]);
    return;
  }
  const r = ev.rrule, freq = r.FREQ.toUpperCase(), interval = Math.max(1, +r.INTERVAL || 1);
  const maxCount = r.COUNT ? +r.COUNT : Infinity;
  let untilTs = Infinity;
  if(r.UNTIL){
    const ud = parseDT({value:r.UNTIL, params:{}});
    if(ud){ untilTs = dtToTs(ud); if(ud.allDay) untilTs += DAY; }
  }
  const byday = r.BYDAY ? r.BYDAY.split(',').map(x => {
    const m = /^([+-]?\d+)?([A-Z]{2})$/.exec(x.trim().toUpperCase());
    return m ? {n: m[1] ? +m[1] : 0, dow: DOWCODE[m[2]]} : null;
  }).filter(Boolean) : [];
  const bymonthday = r.BYMONTHDAY ? r.BYMONTHDAY.split(',').map(Number) : [];
  const bymonth = r.BYMONTH ? r.BYMONTH.split(',').map(Number) : [];
  const base = Date.UTC(st.y, st.m-1, st.d);
  const baseDow = new Date(base).getUTCDay();
  let count = 0, done = false;

  const wkst = DOWCODE[(r.WKST || 'MO').toUpperCase()] ?? 1;
  const passes = (dayMs, isDaily) => {
    const dt = new Date(dayMs);
    if(bymonth.length && !bymonth.includes(dt.getUTCMonth()+1)) return false;
    if(isDaily){
      if(byday.length && !byday.some(b => b.dow === dt.getUTCDay())) return false;
      if(bymonthday.length){
        const dim = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth()+1, 0)).getUTCDate(), dd = dt.getUTCDate();
        if(!bymonthday.some(x => x > 0 ? x === dd : dim + x + 1 === dd)) return false;
      }
    }
    return true;
  };
  const emit = (dayMs) => {
    if(dayMs < base) return;
    const dt = new Date(dayMs);
    const [s,e] = mk(dt.getUTCFullYear(), dt.getUTCMonth()+1, dt.getUTCDate());
    if(s > untilTs || count >= maxCount || s >= to + DAY){ done = true; return; }
    count++;
    if(ev.skip.has(s)) return;
    if(e > from && s < to) out.push([s,e,ev.title,ev.allDay]);
  };
  const nthWeekday = (y, mo, n, dow) => {
    const first = new Date(Date.UTC(y,mo,1)).getUTCDay();
    const dim = new Date(Date.UTC(y,mo+1,0)).getUTCDate();
    const days = []; for(let d = 1 + ((dow - first + 7) % 7); d <= dim; d += 7) days.push(d);
    if(!n) return days;
    const pick = n > 0 ? days[n-1] : days[days.length + n];
    return pick ? [pick] : [];
  };
  for(let k = 0; k < 20000 && !done; k++){
    if(--BUDGET.n < 0){ BUDGET.hit = true; break; }
    if(freq === 'DAILY'){
      const dayMs = base + k*interval*DAY;
      if(!passes(dayMs, true)) continue;
      emit(dayMs);
    } else if(freq === 'WEEKLY'){
      const wkBase = base - ((baseDow - wkst + 7) % 7) * DAY;
      const list = (byday.length ? byday.map(b => b.dow) : [baseDow]).map(d => (d - wkst + 7) % 7).sort((a,b) => a-b);
      for(const idx of list){ if(done) break; const dm = wkBase + (k*interval*7 + idx)*DAY; if(passes(dm, false)) emit(dm); }
    } else if(freq === 'MONTHLY' || freq === 'YEARLY'){
      let y, months;
      if(freq === 'MONTHLY'){
        const t = (st.m-1) + k*interval; y = st.y + Math.floor(t/12); months = [((t%12)+12)%12];
        if(bymonth.length && !bymonth.includes(months[0]+1)) continue;
      } else { y = st.y + k*interval; months = (bymonth.length ? bymonth : [st.m]).map(m => m-1).sort((a,b) => a-b); }
      for(const mo of months){
        if(done) break;
        const dim = new Date(Date.UTC(y,mo+1,0)).getUTCDate();
        let ds = [];
        if(bymonthday.length) ds = bymonthday.map(d => d > 0 ? d : dim + d + 1).filter(d => d >= 1 && d <= dim);
        else if(byday.length) byday.forEach(b => ds.push(...nthWeekday(y, mo, b.n, b.dow)));
        else if(st.d <= dim) ds = [st.d];
        ds = [...new Set(ds)].sort((a,b) => a-b);
        if(r.BYSETPOS){
          const sp = r.BYSETPOS.split(',').map(Number);
          ds = [...new Set(sp.map(n => n > 0 ? ds[n-1] : ds[ds.length + n]).filter(Boolean))].sort((a,b) => a-b);
        }
        for(const d of ds){ if(done) break; emit(Date.UTC(y,mo,d)); }
      }
    } else break;
    if(base + k*interval*DAY > to + 800*DAY && freq !== 'YEARLY') break;
  }
}

/* ---------- state ---------- */
let nextId = 1;
const people = [];
const todayStr = tz => new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const S = {
  tz: LOCAL_TZ, start: todayStr(LOCAL_TZ), days: 14, from: 540, to: 1260,
  dows: [1,1,1,1,1,1,1], dur: 60, buf: 0, need: 'all', allDay: false, snap: true, titles: false, showAll: false, selRun: null
};
let calc = null;   // latest computation

/* ---------- formatting ---------- */
const fmtDayF = () => new Intl.DateTimeFormat('en-US',{timeZone:S.tz,weekday:'short',month:'short',day:'numeric'});
const fmtTimeF = () => new Intl.DateTimeFormat('en-US',{timeZone:S.tz,hour:'numeric',minute:'2-digit'});
function fmtDur(min){ const h = Math.floor(min/60), m = min%60; return (h ? h+'h' : '') + (h && m ? ' ' : '') + (m ? m+'m' : ''); }
function fmtClock(mm){ const h = Math.floor(mm/60)%24, m = mm%60; return (h%12||12) + (m ? ':'+String(m).padStart(2,'0') : '') + (h<12 ? ' AM' : ' PM'); }
function tzAbbr(){ try{ return new Intl.DateTimeFormat('en-US',{timeZone:S.tz,timeZoneName:'short'}).formatToParts(new Date()).find(p => p.type==='timeZoneName').value; }catch(e){ return S.tz; } }
function toast(msg){ const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 3200); }

/* ---------- adding calendars ---------- */
function stemName(file, cal){
  let stem = (file||'').replace(/\.[^.]+$/,'').replace(/[_-]+/g,' ').trim();
  if(stem.includes('@')) stem = stem.split('@')[0];
  if(!stem || /^(basic|calendar|cal|export|events|icalfeed|feed|download)$/i.test(stem)) stem = cal || stem || 'Person';
  if(stem.includes('@')) stem = stem.split('@')[0];
  return stem.slice(0,40);
}
function addSource(personId, name, fileName, text){
  if(text.length > MAX_BYTES) throw new Error('That file is larger than 10 MB.');
  if(!people.some(x => x.id === personId) && people.length >= MAX_PEOPLE) throw new Error('Up to '+MAX_PEOPLE+' people at a time.');
  const parsed = parseICS(text);
  if(!/BEGIN:VCALENDAR/i.test(text) && !parsed.total) throw new Error("That doesn't look like a calendar (.ics) file.");
  const have = people.reduce((n, q) => n + q.sources.reduce((m, src) => m + src.parsed.total, 0), 0);
  if(have + parsed.total > MAX_TOTAL_EVENTS) throw new Error('That would bring the total past '+MAX_TOTAL_EVENTS.toLocaleString()+' events across all calendars. Remove someone or export a shorter date range.');
  let p = people.find(x => x.id === personId);
  if(!p){
    p = {id: nextId++, name: name || stemName(fileName, parsed.calName), color: COLORS[(nextId-2) % COLORS.length], on: true, sources: []};
    people.push(p);
  }
  p.sources.push({id: nextId++, label: fileName || 'pasted', parsed});
  return {p, parsed};
}
async function readFiles(files, personId){
  let added = 0;
  for(const f of files){
    try{
      if(f.size > MAX_BYTES) throw new Error('larger than 10 MB, skipped');
      const text = await f.text();
      const r = addSource(personId, '', f.name, text);
      added++;
      if(personId == null) {} // each file becomes a person
    }catch(e){ toast(f.name + ': ' + e.message); }
  }
  if(added){ refresh(); }
}

/* ---------- computation ---------- */
function compute(){
  BUDGET.n = WORK_BUDGET; BUDGET.hit = false;
  const inc = people.filter(p => p.on);
  const [y,m,d] = S.start.split('-').map(Number);
  const slots = [], days = [];
  for(let i = 0; i < S.days; i++){
    const dt = new Date(Date.UTC(y, m-1, d+i)), dow = dt.getUTCDay();
    if(!S.dows[dow]) continue;
    const Y = dt.getUTCFullYear(), M = dt.getUTCMonth()+1, D = dt.getUTCDate();
    const day = {Y,M,D,dow, first: slots.length};
    for(let mm = S.from; mm < S.to; mm += 15)
      slots.push({ts: zonedToUtc(Y,M,D,Math.floor(mm/60),mm%60,0,S.tz), mm, day: days.length});
    day.last = slots.length;
    days.push(day);
  }
  const res = {inc, slots, days, free: [], ivs: [], runs: [], need: 0};
  if(!slots.length || !inc.length) return res;
  const from = slots[0].ts - DAY, to = slots[slots.length-1].ts + DAY;
  inc.forEach(p => {
    let list = [];
    p.sources.forEach(s => s.parsed.events.forEach(ev => expandEvent(ev, from - 3*DAY, to + 3*DAY, list)));
    list = list.filter(x => S.allDay || !x[3]);
    if(S.buf) list = list.map(x => x[3] ? x : [x[0]-S.buf*MIN, x[1]+S.buf*MIN, x[2], x[3]]);
    list.sort((a,b) => a[0]-b[0]);
    res.ivs.push(list);
    const merged = [];
    for(const x of list){
      const last = merged[merged.length-1];
      if(last && x[0] <= last[1]) last[1] = Math.max(last[1], x[1]); else merged.push([x[0], x[1]]);
    }
    const flags = new Array(slots.length); let j = 0;
    for(let i = 0; i < slots.length; i++){
      const ts = slots[i].ts;
      while(j < merged.length && merged[j][1] <= ts) j++;
      flags[i] = !(j < merged.length && merged[j][0] < ts + 15*MIN);
    }
    res.free.push(flags);
  });
  const N = inc.length;
  res.need = S.need === 'all' ? N : Math.min(+S.need || N, N);
  res.count = slots.map((_, i) => res.free.reduce((n, f) => n + (f[i] ? 1 : 0), 0));
  const keyOf = i => res.free.map(f => f[i] ? 1 : 0).join('');
  for(const day of days){
    let a = -1, key = '';
    const close = b => {
      let ia = a, ib = b;
      if(S.snap){
        while(ia <= ib && slots[ia].mm % 30 !== 0) ia++;
        while(ib >= ia && slots[ib].mm % 30 !== 15) ib--;
      }
      const dur = (ib - ia + 1) * 15;
      if(ia <= ib && dur >= S.dur){
        const who = []; for(let k = 0; k < N; k++) if(res.free[k][ia]) who.push(k);
        res.runs.push({a:ia, b:ib, start:slots[ia].ts, end:slots[ib].ts + 15*MIN, dur, who, count:who.length});
      }
    };
    for(let i = day.first; i < day.last; i++){
      const ok = res.count[i] >= res.need && res.count[i] > 0;
      const k = ok ? keyOf(i) : '';
      if(a >= 0 && k !== key){ close(i-1); a = -1; }
      if(ok && a < 0){ a = i; key = k; }
    }
    if(a >= 0) close(day.last-1);
  }
  res.runs.sort((x,y) => (y.count - x.count) || (S.sort === 'long' ? y.dur - x.dur : 0) || x.start - y.start);
  return res;
}

/* ---------- rendering ---------- */
function renderPeople(){
  $('#people').innerHTML = people.map(p => `
    <li class="person ${p.on?'':'off'}" data-id="${p.id}">
      <div class="p-head">
        <input class="chk" type="checkbox" data-act="toggle" ${p.on?'checked':''} aria-label="Include ${esc(p.name)}">
        <span class="dot" style="background:${p.color}"></span>
        <input type="text" data-act="rename" value="${esc(p.name)}" aria-label="Name">
        <button class="btn ghost icon-btn" data-act="remove" aria-label="Remove ${esc(p.name)}" title="Remove person">✕</button>
      </div>
      ${p.sources.map(s => `<div class="src"><span title="${esc(s.label)}">${esc(s.label)} · ${s.parsed.total} event${s.parsed.total===1?'':'s'}</span><button class="btn ghost icon-btn" style="width:28px;height:28px" data-act="rmsrc" data-sid="${s.id}" aria-label="Remove ${esc(s.label)}">✕</button></div>`).join('')}
      <div class="p-actions">
        <button class="btn small" data-act="addfile">+ File</button>
        <button class="btn small" data-act="addlink">+ Link</button>
      </div>
    </li>`).join('');
  $('#btnClear').classList.toggle('hidden', !people.length);
  const inc = people.filter(p => p.on).length;
  const opts = ['<option value="all">Everyone ('+inc+')</option>'];
  for(let n = inc-1; n >= 2; n--) opts.push(`<option value="${n}">At least ${n} of ${inc}</option>`);
  const sel = $('#sNeed'); sel.innerHTML = opts.join('');
  if(![...sel.options].some(o => o.value === String(S.need))) S.need = 'all';
  sel.value = String(S.need);
}

function pips(idxs, inc){ return `<span class="pips">${idxs.map(i => `<span class="pip" style="background:${inc[i].color}" title="${esc(inc[i].name)}"></span>`).join('')}</span>`; }

function renderResults(){
  saveSettings();   // remember the current settings every time the page redraws
  const el = $('#results');
  const inc = people.filter(p => p.on);
  if(!people.length){
    el.innerHTML = `<section class="card empty">
      <h3>Find the time that works for everyone.</h3>
      <ol><li>Export each person's calendar as an .ics file.</li><li>Drop the files on the left, one per person.</li><li>Overlap shows the stretches when everyone is free.</li></ol>
      <button class="btn primary" data-act="demo" type="button">Try it with sample calendars</button>
    </section>`;
    return;
  }
  if(!inc.length){ el.innerHTML = `<section class="card"><p>Turn on at least one person to see their free time.</p></section>`; return; }
  calc = compute();
  const c = calc;
  if(!c.slots.length){ el.innerHTML = `<section class="card"><p>No days selected, or the daily window is empty. Adjust "When to look".</p></section>`; return; }
  const dayF = fmtDayF(), timeF = fmtTimeF();
  const total = c.runs.length;
  const allCount = c.runs.filter(r => r.count === inc.length).length;
  const first = c.slots[0].ts, last = c.slots[c.slots.length-1].ts;
  const big = total
    ? `${total} time${total===1?'':'s'} to meet`
    : (S.need==='all' ? 'No shared time yet' : 'No matching time');
  let notice = '';
  const unsup = inc.reduce((n, q) => n + q.sources.reduce((m, src) => m + src.parsed.unsupported, 0), 0);
  if(unsup) notice += `<div class="notice"><span>${unsup} repeating event${unsup===1?' uses a rule':'s use rules'} this page can't read. Only the first occurrence is counted, so some busy time may be missing.</span></div>`;
  if(BUDGET.hit) notice += `<div class="notice"><span>One of the calendars has very long repeating events, so some of them were cut short. Results may be incomplete.</span></div>`;
  if(!total){
    const cur = c.need;
    if(cur > 2 && inc.length > 2) notice = `<div class="notice"><span>Nobody is free for ${fmtDur(S.dur)} across all ${cur} people.</span><button class="btn small" data-act="relax" data-n="${cur-1}">Try ${cur-1} of ${inc.length}</button></div>`;
    else notice = `<div class="notice"><span>No ${fmtDur(S.dur)} window fits. Try a shorter length, more days, or a wider daily window.</span></div>`;
  } else if(S.need !== 'all' && allCount === 0){
    notice = `<div class="notice"><span>Nobody found a time for all ${inc.length}. These are the best partial matches.</span></div>`;
  }
  const shown = S.showAll ? c.runs : c.runs.slice(0, 8);
  const sugs = shown.map((r, i) => {
    const idx = i;
    return `<div class="sug ${S.selRun===r.a?'sel':''}" data-act="pick" data-a="${r.a}" data-b="${r.b}" role="button" tabindex="0" aria-label="Highlight ${dayF.format(r.start)}">
      <div>
        <div class="when">${dayF.format(r.start)} · ${timeF.format(r.start)} – ${timeF.format(r.end)}</div>
        <div class="meta"><span>${fmtDur(r.dur)} free</span>${pips(r.who, inc)}<span>${r.count===inc.length ? 'Everyone' : r.count+' of '+inc.length+': '+r.who.map(k => esc(inc[k].name)).join(', ')}</span></div>
      </div>
      <div class="sug-actions">
        <button class="btn small" data-act="copy" data-i="${idx}">Copy</button>
        <button class="btn small primary" data-act="ics" data-i="${idx}" title="Download a calendar invite for the first ${fmtDur(S.dur)}">Invite</button>
      </div>
    </div>`;
  }).join('');
  const more = total > 8 ? `<button class="btn" style="margin-top:12px" data-act="more">${S.showAll ? 'Show fewer' : 'Show all '+total}</button>` : '';

  // heatmap
  const nd = c.days.length;
  const hours = [];
  let heat = `<div class="heat" id="heat" style="grid-template-columns:52px repeat(${nd},minmax(58px,1fr))"><div class="hh" style="left:0;z-index:3"></div>`;
  c.days.forEach(d => {
    const ts = zonedToUtc(d.Y,d.M,d.D,12,0,0,S.tz);
    heat += `<div class="hh"><b>${DOW[d.dow]}</b><span>${new Intl.DateTimeFormat('en-US',{timeZone:S.tz,month:'short',day:'numeric'}).format(ts)}</span></div>`;
  });
  const rows = (S.to - S.from) / 15;
  const N = inc.length;
  for(let r = 0; r < rows; r++){
    const mm = S.from + r*15;
    heat += `<div class="tl">${mm%60===0 ? fmtClock(mm) : ''}</div>`;
    c.days.forEach((d, di) => {
      const si = d.first + r, cnt = c.count[si], f = cnt / N;
      heat += `<div class="cell ${mm%60===0?'hr':''} ${cnt>=c.need&&cnt>0?'ok':''} ${cnt===0?'none':''}" data-s="${si}" style="--f:${f.toFixed(3)}"></div>`;
    });
  }
  heat += '</div>';
  el.innerHTML = `
    <section class="card">
      <div class="summary">
        <div><div class="big">${big}</div>
        <div class="sub">${N} ${N===1?'person':'people'} · ${new Intl.DateTimeFormat('en-US',{timeZone:S.tz,month:'short',day:'numeric'}).format(first)} – ${new Intl.DateTimeFormat('en-US',{timeZone:S.tz,month:'short',day:'numeric'}).format(last)} · ${fmtClock(S.from)}–${fmtClock(S.to)} ${esc(tzAbbr())}</div></div>
        <label class="f" style="min-width:150px">Order<select id="sSort"><option value="soon" ${S.sort!=='long'?'selected':''}>Soonest first</option><option value="long" ${S.sort==='long'?'selected':''}>Longest first</option></select></label>
      </div>
      ${notice}
      <div class="sugs">${sugs}</div>${more}
    </section>
    <section class="card">
      <div class="heat-head"><h2 style="margin:0">Every day at a glance</h2>
        <div class="legend"><span>Busy</span><i></i><span>All free</span></div></div>
      <div class="heat-scroll">${heat}</div>
      <div class="readout" id="readout">Hover or tap a time to see who's free.</div>
    </section>`;
  applySel();
}

function applySel(){
  document.querySelectorAll('.cell.sel').forEach(x => x.classList.remove('sel','selt','selb'));
  document.querySelectorAll('.sug').forEach(x => x.classList.toggle('sel', S.selRun !== null && +x.dataset.a === S.selRun));
  if(S.selRun === null || !calc) return;
  const r = calc.runs.find(x => x.a === S.selRun); if(!r) return;
  for(let i = r.a; i <= r.b; i++){ const c = document.querySelector(`.cell[data-s="${i}"]`); if(c){ c.classList.add('sel'); if(i === r.a) c.classList.add('selt'); if(i === r.b) c.classList.add('selb'); } }
}

function showReadout(si){
  const c = calc, ro = $('#readout'); if(!c || !ro) return;
  const slot = c.slots[si]; if(!slot) return;
  const free = [], busy = [];
  c.inc.forEach((p, k) => {
    if(c.free[k][si]) free.push(p);
    else {
      const ev = c.ivs[k].find(x => x[0] < slot.ts + 15*MIN && x[1] > slot.ts);
      busy.push({p, title: ev ? ev[2] : 'busy'});
    }
  });
  const who = (p, extra) => `<span class="who"><span class="pip" style="background:${p.color}"></span>${esc(p.name)}${extra ? ' <span style="color:var(--muted)">('+esc(extra)+')</span>' : ''}</span>`;
  ro.innerHTML = `<b>${fmtDayF().format(slot.ts)}, ${fmtTimeF().format(slot.ts)}</b><br>`
    + `Free: ${free.length ? free.map(p => who(p)).join('') : '<span style="color:var(--muted)">nobody</span>'}`
    + (busy.length ? `<br>Busy: ${busy.map(b => who(b.p, S.titles ? b.title : '')).join('')}` : '');
}

/* ---------- actions on suggestions ---------- */
function runText(r){
  const inc = calc.inc;
  return `Free ${fmtDayF().format(r.start)}, ${fmtTimeF().format(r.start)} – ${fmtTimeF().format(r.end)} ${tzAbbr()} (${fmtDur(r.dur)}): ` + r.who.map(k => inc[k].name).join(', ');
}
function icsStamp(ts){ return new Date(ts).toISOString().replace(/[-:]/g,'').replace(/\.\d{3}/,''); }
function downloadInvite(r){
  const end = r.start + Math.min(r.end - r.start, S.dur*MIN);
  const body = ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Overlap//EN','BEGIN:VEVENT',
    'UID:overlap-'+r.start+'-'+Math.random().toString(36).slice(2)+'@local','DTSTAMP:'+icsStamp(Date.now()),
    'DTSTART:'+icsStamp(r.start),'DTEND:'+icsStamp(end),'SUMMARY:Hang out','END:VEVENT','END:VCALENDAR'].join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([body], {type:'text/calendar'}));
  a.download = 'hangout.ics'; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast('Invite downloaded. Open it to add it to your calendar.');
}
async function copyText(t){
  try{ await navigator.clipboard.writeText(t); toast('Copied'); }
  catch(e){ const ta = document.createElement('textarea'); ta.value = t; document.body.appendChild(ta); ta.select(); try{ document.execCommand('copy'); toast('Copied'); }catch(_){ toast('Copy failed'); } ta.remove(); }
}

/* ---------- sample data ---------- */
function demoCalendars(){
  const today = new Date();
  const ymd = (off) => { const t = new Date(today.getFullYear(), today.getMonth(), today.getDate()+off); return t.getFullYear()+String(t.getMonth()+1).padStart(2,'0')+String(t.getDate()).padStart(2,'0'); };
  const ev = (title, day, s, e, tz, rule) => `BEGIN:VEVENT\r\nUID:${Math.random().toString(36).slice(2)}\r\nSUMMARY:${title}\r\nDTSTART;TZID=${tz}:${ymd(day)}T${s}00\r\nDTEND;TZID=${tz}:${ymd(day)}T${e}00\r\n${rule?'RRULE:'+rule+'\r\n':''}END:VEVENT\r\n`;
  const allDay = (title, day) => `BEGIN:VEVENT\r\nUID:${Math.random().toString(36).slice(2)}\r\nSUMMARY:${title}\r\nDTSTART;VALUE=DATE:${ymd(day)}\r\nDTEND;VALUE=DATE:${ymd(day+1)}\r\nEND:VEVENT\r\n`;
  const wrap = (name, body) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nX-WR-CALNAME:${name}\r\n${body}END:VCALENDAR\r\n`;
  const WK = 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', L = LOCAL_TZ;
  return [
    ['Alex', wrap('Alex', ev('Standup',0,'0930','1000',L,WK)+ev('Design review',0,'1300','1500',L,'FREQ=WEEKLY;BYDAY=TU,TH')+ev('Gym',0,'1730','1830',L,'FREQ=WEEKLY;BYDAY=MO,WE')+ev('Dentist',3,'1100','1200',L)+ev('Dinner with parents',5,'1800','2100',L)+allDay('Birthday',4))],
    ['Sam', wrap('Sam', ev('Class',0,'1000','1200',L,'FREQ=WEEKLY;BYDAY=MO,WE,FR')+ev('Work',0,'1230','1630',L,WK)+ev('Band practice',0,'1900','2100',L,'FREQ=WEEKLY;BYDAY=TU')+ev('Soccer',6,'0900','1100',L)+ev('Flight',9,'0800','1400',L))],
    ['Priya', wrap('Priya', ev('Team block',0,'0900','1200','America/Los_Angeles',WK)+ev('Customer calls',0,'1300','1600','America/Los_Angeles','FREQ=WEEKLY;BYDAY=TU,TH')+ev('Yoga',0,'1000','1100','America/Los_Angeles','FREQ=WEEKLY;BYDAY=SA')+ev('Concert',2,'1830','2230','America/Los_Angeles'))],
    ['Jordan', wrap('Jordan', ev('Shift',0,'0800','1600','America/New_York','FREQ=WEEKLY;BYDAY=MO,TU,TH')+ev('Book club',0,'1900','2100','America/New_York','FREQ=WEEKLY;BYDAY=WE')+ev('Family visit',7,'1000','1800','America/New_York'))]
  ];
}

/* ---------- refresh ---------- */
function refresh(){ renderPeople(); renderResults(); }

/* ---------- wiring ---------- */
function buildSelectors(){
  const opts = (from, to) => { const o = []; for(let mm = from; mm <= to; mm += 30) o.push(`<option value="${mm}">${fmtClock(mm)}</option>`); return o.join(''); };
  $('#sFrom').innerHTML = opts(0, 1380); $('#sTo').innerHTML = opts(30, 1440).replace('>12 AM<', '>12 AM (midnight)<');
  $('#sDur').innerHTML = [30,45,60,90,120,180,240,360].map(n => `<option value="${n}">${fmtDur(n)}</option>`).join('');
  $('#dows').innerHTML = [1,2,3,4,5,6,0].map(d => `<label><input type="checkbox" data-dow="${d}" checked aria-label="${DOW[d]}"><span>${DOW[d]}</span></label>`).join('');
  let zones = [];
  try{ zones = Intl.supportedValuesOf('timeZone'); }catch(e){}
  if(!zones.includes(LOCAL_TZ)) zones.unshift(LOCAL_TZ);
  if(!zones.includes('UTC')) zones.push('UTC');
  $('#sTz').innerHTML = zones.map(z => `<option value="${esc(z)}">${esc(z.replace(/_/g,' '))}${z===LOCAL_TZ?' (yours)':''}</option>`).join('');
  $('#sStart').value = S.start; $('#sDays').value = S.days; $('#sFrom').value = S.from; $('#sTo').value = S.to; $('#sDur').value = S.dur; $('#sTz').value = S.tz;
  // show the remembered settings in the controls
  $('#sBuf').value = S.buf; $('#oAllDay').checked = S.allDay; $('#oSnap').checked = S.snap; $('#oTitles').checked = S.titles;
  document.querySelectorAll('[data-dow]').forEach(x => x.checked = !!S.dows[+x.dataset.dow]);
}
function syncSettings(){
  S.start = $('#sStart').value || todayStr(S.tz);
  S.days = +$('#sDays').value; S.from = +$('#sFrom').value; S.to = +$('#sTo').value;
  if(S.to <= S.from){ S.to = Math.min(1440, S.from + 30); $('#sTo').value = S.to; }
  S.dur = +$('#sDur').value; S.buf = +$('#sBuf').value; S.need = $('#sNeed').value; S.tz = $('#sTz').value;
  S.allDay = $('#oAllDay').checked; S.snap = $('#oSnap').checked; S.titles = $('#oTitles').checked;
  document.querySelectorAll('[data-dow]').forEach(x => S.dows[+x.dataset.dow] = x.checked ? 1 : 0);
  S.selRun = null;
  renderResults();
}
['#sStart','#sDays','#sFrom','#sTo','#sDur','#sBuf','#sNeed','#sTz','#oAllDay','#oSnap','#oTitles'].forEach(id => $(id).addEventListener('change', syncSettings));
$('#dows').addEventListener('change', syncSettings);

/* dialog for link / paste */
let dlgMode = 'link', dlgTarget = null, dlgConfirmed = null;
function openDlg(mode, personId){
  dlgMode = mode; dlgTarget = personId || null;
  $('#dlgTitle').textContent = mode === 'link' ? 'Add a calendar link' : 'Paste calendar text';
  $('#dlgUrlWrap').classList.toggle('hidden', mode !== 'link');
  $('#dlgTextWrap').classList.toggle('hidden', mode !== 'paste');
  $('#dlgPerson').innerHTML = '<option value="">New person</option>' + people.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  $('#dlgPerson').value = personId ? String(personId) : '';
  $('#dlgName').value = ''; $('#dlgUrl').value = ''; $('#dlgText').value = ''; $('#dlgErr').textContent = '';
  $('#dlgNameWrap').classList.toggle('hidden', !!personId);
  dlgConfirmed = null; $('#dlgNote').textContent = '';
  $('#dlgOk').disabled = false; $('#dlgOk').textContent = 'Add';
  $('#dlg').showModal();
}
$('#dlgPerson').addEventListener('change', e => $('#dlgNameWrap').classList.toggle('hidden', !!e.target.value));
$('#dlgCancel').addEventListener('click', () => $('#dlg').close());
$('#dlg').addEventListener('close', () => { $('#dlgText').value = ''; $('#dlgUrl').value = ''; $('#dlgName').value = ''; $('#dlgErr').textContent = ''; $('#dlgNote').textContent = ''; dlgConfirmed = null; });
$('#dlgUrl').addEventListener('input', () => { dlgConfirmed = null; $('#dlgNote').textContent = ''; $('#dlgOk').textContent = 'Add'; });
$('#dlgForm').addEventListener('submit', async e => {
  e.preventDefault();
  const pid = $('#dlgPerson').value ? +$('#dlgPerson').value : null;
  const name = $('#dlgName').value.trim();
  const err = $('#dlgErr'); err.textContent = '';
  try{
    let text, label;
    if(dlgMode === 'link'){
      let url = $('#dlgUrl').value.trim();
      if(!url) throw new Error('Paste a calendar link first.');
      url = url.replace(/^webcal:/i, 'https:');
      if(!/^https:\/\//i.test(url)) throw new Error('Only https:// and webcal:// links are allowed.');
      let host; try{ host = new URL(url).hostname; }catch(_){ throw new Error('That link is not a valid web address.'); }
      if(dlgConfirmed !== host){
        dlgConfirmed = host;
        const local = /^(localhost|.*\.local|10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(host);
        $('#dlgNote').textContent = 'This will contact ' + host + ' from your browser, and that site will see your IP address.' + (local ? ' It looks like an address on your own network.' : '') + ' Click again to continue.';
        $('#dlgOk').textContent = 'Fetch from ' + host;
        return;
      }
      $('#dlgOk').disabled = true; $('#dlgOk').textContent = 'Fetching…';
      try{ const ac = new AbortController(); const to = setTimeout(() => ac.abort(), 15000); const r = await fetch(url, {signal: ac.signal, credentials:'omit', referrerPolicy:'no-referrer', redirect:'follow'}); clearTimeout(to); if(!r.ok) throw new Error('HTTP '+r.status); text = await r.text(); }
      catch(ex){ throw new Error("Couldn't read that link from the browser (most calendar hosts block this). Download the .ics file and drop it in instead."); }
      label = url.replace(/^https?:\/\//,'').slice(0,40);
    } else {
      text = $('#dlgText').value; if(!text.trim()) throw new Error('Paste the contents of an .ics file first.');
      label = 'pasted text';
    }
    addSource(pid, name, label, text);
    $('#dlg').close(); refresh();
  }catch(ex){ err.textContent = ex.message; $('#dlgOk').disabled = false; $('#dlgOk').textContent = 'Add'; }
});

/* buttons & delegation */
$('#btnFiles').addEventListener('click', () => $('#fileIn').click());
$('#btnLink').addEventListener('click', () => openDlg('link'));
$('#btnPaste').addEventListener('click', () => openDlg('paste'));
$('#fileIn').addEventListener('change', e => { readFiles([...e.target.files], null); e.target.value = ''; });
let pendingPerson = null;
$('#fileInPerson').addEventListener('change', e => { readFiles([...e.target.files], pendingPerson); e.target.value = ''; });
$('#btnClear').addEventListener('click', () => { people.length = 0; S.selRun = null; refresh(); });
function loadDemo(){
  people.length = 0; nextId = 1;
  demoCalendars().forEach(([name, text]) => addSource(null, name, name.toLowerCase()+'.ics', text));
  S.selRun = null; refresh();
}
$('#btnDemo').addEventListener('click', loadDemo);

$('#people').addEventListener('click', e => {
  const b = e.target.closest('[data-act]'); if(!b) return;
  const li = b.closest('.person'), id = +li.dataset.id, p = people.find(x => x.id === id);
  const act = b.dataset.act;
  if(act === 'remove'){ people.splice(people.indexOf(p), 1); refresh(); }
  else if(act === 'rmsrc'){ p.sources = p.sources.filter(s => s.id !== +b.dataset.sid); if(!p.sources.length) people.splice(people.indexOf(p), 1); refresh(); }
  else if(act === 'addfile'){ pendingPerson = id; $('#fileInPerson').click(); }
  else if(act === 'addlink'){ openDlg('link', id); }
});
$('#people').addEventListener('change', e => {
  const li = e.target.closest('.person'); if(!li) return;
  const p = people.find(x => x.id === +li.dataset.id);
  if(e.target.dataset.act === 'toggle'){ p.on = e.target.checked; S.selRun = null; refresh(); }
  else if(e.target.dataset.act === 'rename'){ p.name = e.target.value.trim() || 'Person'; renderResults(); }
});

$('#results').addEventListener('click', e => {
  const b = e.target.closest('[data-act]');
  if(!b){ const c = e.target.closest('.cell'); if(c) showReadout(+c.dataset.s); return; }
  const act = b.dataset.act;
  if(act === 'demo') loadDemo();
  else if(act === 'more'){ S.showAll = !S.showAll; renderResults(); }
  else if(act === 'relax'){ S.need = b.dataset.n; $('#sNeed').value = S.need; renderResults(); }
  else if(act === 'copy'){ e.stopPropagation(); copyText(runText(calc.runs[+b.dataset.i])); }
  else if(act === 'ics'){ e.stopPropagation(); downloadInvite(calc.runs[+b.dataset.i]); }
  else if(act === 'pick'){
    S.selRun = (S.selRun === +b.dataset.a) ? null : +b.dataset.a; applySel();
    const cell = document.querySelector(`.cell[data-s="${b.dataset.a}"]`);
    if(cell && S.selRun !== null){ const sc = cell.closest('.heat-scroll'); const r = cell.getBoundingClientRect(), rs = sc.getBoundingClientRect(); if(r.top < rs.top || r.bottom > rs.bottom) sc.scrollTop += r.top - rs.top - 60; showReadout(+b.dataset.a); }
  }
});
$('#results').addEventListener('keydown', e => {
  if((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('sug')){ e.preventDefault(); e.target.click(); }
});
$('#results').addEventListener('change', e => { if(e.target.id === 'sSort'){ S.sort = e.target.value; renderResults(); } });
$('#results').addEventListener('mouseover', e => { const c = e.target.closest('.cell'); if(c) showReadout(+c.dataset.s); });

/* drag and drop anywhere */
let dragN = 0;
window.addEventListener('dragenter', e => { if(e.dataTransfer && [...e.dataTransfer.types].includes('Files')){ dragN++; document.body.classList.add('dragging'); } });
window.addEventListener('dragleave', () => { dragN = Math.max(0, dragN-1); if(!dragN) document.body.classList.remove('dragging'); });
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => {
  e.preventDefault(); dragN = 0; document.body.classList.remove('dragging');
  const files = [...(e.dataTransfer.files || [])]; if(files.length) readFiles(files, null);
});

/* ---------- Saved settings (localStorage) ----------
   localStorage keeps small pieces of text in the browser, even after you close the tab.
   Here it remembers your "When to look" choices. Calendars are NOT saved. */
const SAVE_KEY = 'overlap-settings';
const SAVED_FIELDS = ['tz','days','from','to','dows','dur','buf','allDay','snap','titles','sort'];

function saveSettings(){
  try{
    const out = {};
    SAVED_FIELDS.forEach(k => out[k] = S[k]);
    localStorage.setItem(SAVE_KEY, JSON.stringify(out));   // objects must become text first
  }catch(e){}   // storage can be blocked (private mode); the site still works without it
}

function loadSettings(){
  let d;
  try{ d = JSON.parse(localStorage.getItem(SAVE_KEY)); }catch(e){ return; }
  if(!d || typeof d !== 'object') return;
  // Saved text can be edited by anyone, so check every value before using it.
  const tz = resolveTz(d.tz);
  if(tz){ S.tz = tz; S.start = todayStr(tz); }
  if([7,14,21,28,42].includes(d.days)) S.days = d.days;
  if(Number.isInteger(d.from) && Number.isInteger(d.to) && d.from >= 0 && d.from <= 1380 && d.to > d.from && d.to <= 1440 && d.from % 30 === 0 && d.to % 30 === 0){ S.from = d.from; S.to = d.to; }
  if(Array.isArray(d.dows) && d.dows.length === 7) S.dows = d.dows.map(x => x ? 1 : 0);
  if([30,45,60,90,120,180,240,360].includes(d.dur)) S.dur = d.dur;
  if([0,15,30,60].includes(d.buf)) S.buf = d.buf;
  ['allDay','snap','titles'].forEach(k => { if(typeof d[k] === 'boolean') S[k] = d[k]; });
  if(d.sort === 'soon' || d.sort === 'long') S.sort = d.sort;
}

/* init */
S.sort = 'soon';
loadSettings();
buildSelectors();
refresh();
