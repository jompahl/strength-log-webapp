import { DB } from "./seedData.js";
import { MUSCLE, STRENGTH_BURN } from "./domain.js";
import { parseWorkoutCsv } from "./importWorkoutCsv.js";
import coachTompahlUrl from "./assets/coaches/tompahl.jpg";
import coachCalgaroUrl from "./assets/coaches/calgaro.jpg";
import coachJompahlUrl from "./assets/coaches/jompahl.jpg";

const muscleOf = n => MUSCLE[n] || "Other";

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}

const COACHES = [
  { id:"tompahl", name:"Tompahl", label:"Coach Tompahl", initials:"CT", image:coachTompahlUrl },
  { id:"calgaro", name:"Calgaro", label:"Coach Calgaro", initials:"CC", image:coachCalgaroUrl },
  { id:"jompahl", name:"Jompahl", label:"Coach Jompahl", initials:"CJ", image:coachJompahlUrl },
];
function selectedCoach(){
  const id=(STORE&&STORE.coachId)||localStorage.getItem("strengthlog.coachId")||"jompahl";
  return COACHES.find(c=>c.id===id)||COACHES[2];
}
function setCoach(id){
  const coach=COACHES.find(c=>c.id===id)||COACHES[2];
  if(STORE) { STORE.coachId=coach.id; saveStore(STORE); }
  localStorage.setItem("strengthlog.coachId", coach.id);
  renderCoachIdentity();
}

// ---- storage ----
const LS_KEY = "strengthlog.v2";
function loadStore(){
  try{ const r=localStorage.getItem(LS_KEY); return r?JSON.parse(r):{entries:[],food:[],profile:null,aiUsage:[]}; }
  catch(e){ return {entries:[],food:[],profile:null,aiUsage:[]}; }
}
function saveStore(s){ try{ localStorage.setItem(LS_KEY, JSON.stringify(s)); }catch(e){ toast("Storage unavailable"); } schedulePush(); }

/* ===================== AUTH + CLOUD SYNC ===================== */
let CLIENT_ID_RESOLVED = "";   // fetched from /api/config at startup
const API_URL = "/api/sync";
let ID_TOKEN = null;        // current Google ID token (proof of identity)
let CURRENT_USER = null;    // {email, name}
let pushTimer=null;
let FIRST_PULL_DONE=false;  // becomes true after the initial load; gates pushes

function syncPayload(){
  return {entries:STORE.entries||[], food:STORE.food||[], weights:STORE.weights||[],
    hiddenFood:STORE.hiddenFood||[], profile:STORE.profile||{}, aiUsage:STORE.aiUsage||[],
    ouraDaily:STORE.ouraDaily||[],
    coachId:STORE.coachId||selectedCoach().id, seedImported:!!STORE.seedImported};
}
function applyPayload(d){
  if(!d) return;
  STORE.entries=d.entries||[]; STORE.food=d.food||[]; STORE.weights=d.weights||[];
  STORE.hiddenFood=d.hiddenFood||[]; STORE.aiUsage=d.aiUsage||[]; STORE.ouraDaily=d.ouraDaily||[];
  if(d.coachId) STORE.coachId=d.coachId;
  if(d.profile&&Object.keys(d.profile).length) STORE.profile=d.profile;
  if(typeof d.seedImported!=="undefined") STORE.seedImported=!!d.seedImported;
  try{ localStorage.setItem(LS_KEY, JSON.stringify(STORE)); }catch(e){}
}

function calcBmr(profile){
  const base=(10*profile.weight_kg)+(6.25*profile.height_cm)-(5*profile.age);
  return Math.round(base + (profile.sex==="female" ? -161 : 5));
}

function goalFromWeights(weight, target){
  if(!target || Math.abs(target-weight)<1) {
    return {goal:"maintain", calorie_delta:0, deficit_target:0, label:"Maintain"};
  }
  if(target<weight) {
    return {goal:"cut", calorie_delta:-400, deficit_target:400, label:"Cut"};
  }
  return {goal:"gain", calorie_delta:250, deficit_target:0, label:"Gain"};
}

function applyWelcomeProfile({weight, height, age, activityMult, targetWeight}){
  const goal=goalFromWeights(weight, targetWeight);
  const profile={
    ...(STORE.profile||{}),
    weight_kg:weight,
    height_cm:height,
    age,
    sex:(STORE.profile&&STORE.profile.sex)||"male",
    activityMult,
    protein_per_kg:(STORE.profile&&STORE.profile.protein_per_kg)||2.0,
    target_weight_kg:targetWeight,
    onboardingComplete:true,
    ...goal,
  };
  profile.bmr=calcBmr(profile);
  profile.maintenance=Math.round(profile.bmr*activityMult);
  STORE.profile=profile;
  STORE.weights=STORE.weights||[];
  const today=localDateString();
  if(!STORE.weights.some(w=>w.date===today)) STORE.weights.push({date:today, kg:weight});
  saveStore(STORE);
}

function profileIncomplete(){
  const p=STORE.profile||{};
  return !p.onboardingComplete || !p.weight_kg || !p.height_cm || !p.age || !p.target_weight_kg;
}

function recordAiUsage(usage){
  if(!usage) return;
  const inputTokens=usage.inputTokens||0;
  const outputTokens=usage.outputTokens||0;
  STORE.aiUsage=STORE.aiUsage||[];
  STORE.aiUsage.push({
    id:"ai"+Date.now()+Math.random().toString(36).slice(2,6),
    createdAt:new Date().toISOString(),
    provider:usage.provider||"anthropic",
    model:usage.model||"",
    requestType:usage.requestType||"text",
    inputTokens,
    outputTokens,
    totalTokens:inputTokens+outputTokens,
  });
  saveStore(STORE);
}

function aiUsageSummary(){
  const now=new Date();
  const month=now.toISOString().slice(0,7);
  const all=STORE.aiUsage||[];
  const monthRows=all.filter(u=>(u.createdAt||"").slice(0,7)===month);
  return {
    totalRequests:all.length,
    monthRequests:monthRows.length,
    monthImages:monthRows.filter(u=>u.requestType==="image").length,
    monthTokens:monthRows.reduce((sum,u)=>sum+(u.totalTokens||0),0),
  };
}

function renderAiUsageStatus(){
  const el=document.getElementById("aiUsageStatus");
  if(!el) return;
  const s=aiUsageSummary();
  const cell=(label,value)=>`<div><div style="color:var(--faint); font-size:10.5px; text-transform:uppercase; letter-spacing:0.05em">${label}</div><div class="mono" style="font-weight:700; margin-top:2px">${value}</div></div>`;
  el.innerHTML=[
    cell("This month", s.monthRequests+" req"),
    cell("Photo scans", s.monthImages),
    cell("Month tokens", fmt0(s.monthTokens)),
    cell("All time", s.totalRequests+" req"),
  ].join("");
}

function setAvatar(el, coach){
  if(!el) return;
  el.textContent="";
  el.style.backgroundImage=`url("${coach.image}")`;
  el.title=coach.label;
}

function renderCoachIdentity(){
  const coach=selectedCoach();
  document.getElementById("coachHeaderName").textContent=coach.label;
  setAvatar(document.getElementById("coachHeaderAvatar"), coach);
  const picker=document.getElementById("coachPicker");
  if(picker){
    picker.innerHTML=COACHES.map(c=>`<button class="coachPick ${c.id===coach.id?"on":""}" data-coach="${c.id}" title="${c.label}" aria-label="${c.label}" style="background-image:url('${c.image}')"></button>`).join("");
    picker.querySelectorAll("[data-coach]").forEach(btn=>btn.onclick=()=>setCoach(btn.dataset.coach));
  }
}

function fillAccountProfileForm(){
  const p=STORE.profile||{};
  document.getElementById("acctWeight").value=p.weight_kg||"";
  document.getElementById("acctHeight").value=p.height_cm||"";
  document.getElementById("acctAge").value=p.age||"";
  document.getElementById("acctActivity").value=String(p.activityMult||1.2);
  document.getElementById("acctTarget").value=p.target_weight_kg||p.weight_kg||"";
  document.getElementById("acctProfileMsg").textContent=profileIncomplete()?"Add these details for better calorie targets.":"";
}

function saveAccountProfile(){
  const weight=parseFloat(document.getElementById("acctWeight").value);
  const height=parseFloat(document.getElementById("acctHeight").value);
  const age=parseInt(document.getElementById("acctAge").value,10);
  const activityMult=parseFloat(document.getElementById("acctActivity").value);
  const targetWeight=parseFloat(document.getElementById("acctTarget").value);
  const msg=document.getElementById("acctProfileMsg");
  if(!weight||weight<30||weight>250){ msg.textContent="Check weight."; return; }
  if(!height||height<120||height>230){ msg.textContent="Check height."; return; }
  if(!age||age<13||age>100){ msg.textContent="Check age."; return; }
  if(!targetWeight||targetWeight<30||targetWeight>250){ msg.textContent="Check target."; return; }
  applyWelcomeProfile({weight,height,age,activityMult,targetWeight});
  msg.textContent="Saved.";
  renderCalories();
}

function desiredCalorieDelta(profile){
  if(typeof profile.calorie_delta==="number") return profile.calorie_delta;
  return -(profile.deficit_target||400);
}

function goalText(profile){
  const d=desiredCalorieDelta(profile);
  if(d<0) return "−"+fmt0(Math.abs(d))+" kcal";
  if(d>0) return "+"+fmt0(d)+" kcal";
  return "maintenance";
}

function schedulePush(){
  if(!ID_TOKEN) return;            // not signed in → local only
  if(!FIRST_PULL_DONE) return;     // never push before we've loaded from the server
  clearTimeout(pushTimer);
  pushTimer=setTimeout(pushNow, 1500);
}
async function apiCall(action, data){
  const res=await fetch(API_URL,{method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({idToken:ID_TOKEN, action, data})});
  return res.json();
}
async function pushNow(){
  if(!ID_TOKEN) return;
  setSyncStatus("Saving…","wait");
  try{
    const j=await apiCall("save", syncPayload());
    if(j.ok){ const t=new Date().toLocaleTimeString(); setSyncStatus("Saved ✓ "+t,"ok"); }
    else if(/sign-in/i.test(j.error||"")){ setSyncStatus("Session expired — sign in again.","err"); requireSignIn(); }
    else setSyncStatus("Save error: "+(j.error||"unknown"),"err");
  }catch(e){ setSyncStatus("Couldn't reach the server. Check your connection.","err"); }
}
async function pullNow(){
  if(!ID_TOKEN) return;
  setSyncStatus("Loading your data…","wait");
  try{
    const j=await apiCall("load", null);
    if(j.ok){
      const remote=j.data;
      const hasRemote=remote&&((remote.entries&&remote.entries.length)||(remote.food&&remote.food.length)||
        (remote.weights&&remote.weights.length)||(remote.aiUsage&&remote.aiUsage.length)||
        (remote.ouraDaily&&remote.ouraDaily.length)||(remote.profile&&remote.profile.onboardingComplete));
      if(hasRemote){ applyPayload(remote); FIRST_PULL_DONE=true; }
      else {
        // brand-new account: start blank (no demo history). Mark as initialized so
        // the built-in DB demo data is never merged in, then save the empty state.
        STORE.entries=STORE.entries||[]; STORE.food=STORE.food||[]; STORE.weights=STORE.weights||[]; STORE.aiUsage=STORE.aiUsage||[];
        STORE.seedImported=true;
        if(STORE.profile) STORE.profile.onboardingComplete=false;
        try{ localStorage.setItem(LS_KEY, JSON.stringify(STORE)); }catch(e){}
        FIRST_PULL_DONE=true;   // safe to push now: we've confirmed the account is empty
        startOnboardingChat();
      }
      const t=new Date().toLocaleTimeString(); setSyncStatus("Synced ✓ "+t,"ok");
      buildStrip(); buildSelect(); renderStrength(); rebuildDatalist();
      if(document.getElementById("view-cardio").classList.contains("on")) buildCardio();
      if(document.getElementById("view-calories").classList.contains("on")) renderCalories();
      if(!new URLSearchParams(location.search).has("oura")) maybeAutoSyncOura();
    } else if(/sign-in/i.test(j.error||"")){ requireSignIn(); }
    else setSyncStatus("Load error: "+(j.error||"unknown"),"err");
  }catch(e){ setSyncStatus("Couldn't reach the server.","err"); }
}
function setSyncStatus(msg,kind){
  const el=document.getElementById("syncStatus"); if(el){
    const col=kind==="ok"?"var(--green)":kind==="err"?"var(--red)":kind==="wait"?"var(--amber)":"var(--muted)";
    el.style.color=col; el.textContent=msg;
  }
  const b=document.getElementById("acctBtn");
  if(b&&CURRENT_USER){ b.textContent=(CURRENT_USER.name||"Account").split(" ")[0]; }
}

/* ---- Google Sign-In ---- */
function handleCredential(resp){
  ID_TOKEN = resp.credential;
  let newUser={email:"",name:"Account"};
  try{
    const payload=JSON.parse(atob(resp.credential.split(".")[1]));
    newUser={email:payload.email, name:payload.name||payload.email, sub:payload.sub};
  }catch(e){}
  // if switching accounts on this device, wipe local cache so we don't show stale data
  const prevSub=localStorage.getItem("strengthlog.sub");
  if(prevSub && newUser.sub && prevSub!==newUser.sub){
    STORE={entries:[],food:[],weights:[],hiddenFood:[],profile:JSON.parse(JSON.stringify(DB.profile)),seedImported:false};
    try{ localStorage.setItem(LS_KEY, JSON.stringify(STORE)); }catch(e){}
  }
  if(newUser.sub) localStorage.setItem("strengthlog.sub", newUser.sub);
  CURRENT_USER=newUser;
  sessionStorage.setItem("idtoken", ID_TOKEN);
  showApp();
  pullNow().finally(handleOuraReturn);
}
function showApp(){
  document.getElementById("signinOverlay").style.display="none";
  document.getElementById("appWrap").style.display="block";
  document.getElementById("coachFab").style.display="block";
  const b=document.getElementById("acctBtn");
  if(b&&CURRENT_USER) b.textContent=(CURRENT_USER.name||"Account").split(" ")[0];
  if(new URLSearchParams(location.search).has("welcomePreview")) startOnboardingChat();
  if(STORE.profile && STORE.profile.onboardingComplete===false) startOnboardingChat();
}
function requireSignIn(){
  ID_TOKEN=null; CURRENT_USER=null; sessionStorage.removeItem("idtoken");
  document.getElementById("appWrap").style.display="none";
  document.getElementById("coachFab").style.display="none";
  document.getElementById("coachOverlay").style.display="none";
  document.getElementById("signinOverlay").style.display="flex";
}
function showLocalDevSignIn(message){
  const btnWrap=document.getElementById("gsiButton");
  const msg=document.getElementById("signinMsg");
  if(msg) msg.textContent=message||"Local API config is unavailable. You can continue in local-only mode.";
  if(!btnWrap || btnWrap.dataset.localReady) return;
  btnWrap.dataset.localReady="1";
  btnWrap.innerHTML=`<button class="primary" id="localDevBtn" style="border-radius:22px; padding:11px 18px">Continue locally</button>`;
  document.getElementById("localDevBtn").addEventListener("click",()=>{
    ID_TOKEN=null;
    CURRENT_USER={email:"local@strength-log.dev", name:"Local dev", sub:"local-dev"};
    FIRST_PULL_DONE=false;
    showApp();
    toast("Local-only mode: sync and AI calls need Vercel/API config.");
  });
}
function initGoogle(){
  if(!window.google||!google.accounts){ setTimeout(initGoogle,300); return; }
  if(!CLIENT_ID_RESOLVED){
    // fetch the public client ID from the server, then retry
    fetch("/api/config").then(r=>r.json()).then(j=>{
      CLIENT_ID_RESOLVED=j.clientId||"";
      if(!CLIENT_ID_RESOLVED){ showLocalDevSignIn("No Google client ID returned. Continue locally, or run through Vercel with env vars."); return; }
      initGoogle();
    }).catch(()=>{ showLocalDevSignIn("Couldn't reach /api/config. Continue locally, or run the Vercel API runtime."); });
    return;
  }
  google.accounts.id.initialize({client_id:CLIENT_ID_RESOLVED, callback:handleCredential, auto_select:true});
  google.accounts.id.renderButton(document.getElementById("gsiButton"),
    {theme:"filled_black", size:"large", text:"continue_with", shape:"pill", width:280});
  google.accounts.id.prompt();
}

function showWelcomeModal(){
  const modal=document.getElementById("welcomeModal");
  if(!modal) return;
  const p=STORE.profile||DB.profile;
  document.getElementById("welcomeWeight").value=p.weight_kg||"";
  document.getElementById("welcomeHeight").value=p.height_cm||"";
  document.getElementById("welcomeAge").value=p.age||"";
  document.getElementById("welcomeActivity").value=String(p.activityMult||1.2);
  document.getElementById("welcomeTarget").value=p.target_weight_kg||p.weight_kg||"";
  document.getElementById("welcomeError").textContent="";
  modal.style.display="flex";
}

function closeWelcomeModal(){
  const modal=document.getElementById("welcomeModal");
  if(modal) modal.style.display="none";
}

function saveWelcomeProfile(){
  const weight=parseFloat(document.getElementById("welcomeWeight").value);
  const height=parseFloat(document.getElementById("welcomeHeight").value);
  const age=parseInt(document.getElementById("welcomeAge").value,10);
  const activityMult=parseFloat(document.getElementById("welcomeActivity").value);
  const targetWeight=parseFloat(document.getElementById("welcomeTarget").value);
  const err=document.getElementById("welcomeError");
  if(!weight||weight<30||weight>250){ err.textContent="Enter a realistic current weight in kg."; return; }
  if(!height||height<120||height>230){ err.textContent="Enter a realistic height in cm."; return; }
  if(!age||age<13||age>100){ err.textContent="Enter a realistic age."; return; }
  if(!targetWeight||targetWeight<30||targetWeight>250){ err.textContent="Enter a realistic target weight in kg."; return; }
  applyWelcomeProfile({weight,height,age,activityMult,targetWeight});
  closeWelcomeModal();
  buildStrip(); buildSelect(); renderStrength(); rebuildDatalist();
  if(document.getElementById("view-cardio").classList.contains("on")) buildCardio();
  if(document.getElementById("view-calories").classList.contains("on")) renderCalories();
  else renderCalories();
  toast("Profile set up ✓");
}

let STORE = loadStore();
if(!STORE.profile) STORE.profile = JSON.parse(JSON.stringify(DB.profile));
if(!STORE.weights) STORE.weights = [];
if(!STORE.ouraDaily) STORE.ouraDaily = [];
// never show the built-in demo data in the multi-user app; real data comes from the Sheet
if(typeof STORE.seedImported==="undefined") STORE.seedImported = true;

function entries(){ const base = STORE.seedImported ? [] : DB.entries; return base.concat(STORE.entries).slice().sort((a,b)=> a.date<b.date?-1:1); }
function strengthEntries(){ return entries().filter(e=>e.kind==="strength"); }
function cardioEntries(){ return entries().filter(e=>e.kind==="cardio"); }
function foodEntries(){ const hidden=STORE.hiddenFood||[]; const base = STORE.seedImported ? [] : (DB.food||[]); return base.concat(STORE.food||[]).filter(f=>!hidden.includes(f._id)); }

function fmt(n){ if(n===null||n===undefined) return "—"; return (Math.round(n*10)/10).toString(); }
function fmt0(n){ return Math.round(n).toLocaleString(); }
function fmtDate(d){ const [y,m,da]=d.split("-"); return `${da}/${m}`; }
function localDateString(date=new Date()){
  const y=date.getFullYear();
  const m=String(date.getMonth()+1).padStart(2,"0");
  const d=String(date.getDate()).padStart(2,"0");
  return `${y}-${m}-${d}`;
}
function addLocalDays(ymd, days){
  const [y,m,d]=ymd.split("-").map(Number);
  const date=new Date(y,m-1,d);
  date.setDate(date.getDate()+days);
  return localDateString(date);
}
function pace(min){ const m=Math.floor(min); const s=Math.round((min-m)*60); return `${m}:${s.toString().padStart(2,'0')}`; }

let toastTimer=null;
function toast(msg){ const t=document.getElementById("toast"); t.textContent=msg; t.classList.add("show");
  clearTimeout(toastTimer); toastTimer=setTimeout(()=>t.classList.remove("show"),2200); }

/* ===================== STRENGTH ===================== */
function isAssisted(name){ return /assisted/i.test(name); }
function isBodyweight(sets){ return sets.every(s=> s.weight===0); }
function hasLevels(sets){ return sets.some(s=> s.weight===null); }
function setLabel(set){
  if(set.duration_sec) return `${set.duration_sec}s`;
  const weight=set.weight===null?"lvl":set.weight===0?"BW":set.weight;
  return `${set.reps}×${weight}`;
}

function sessionMetric(ex, metric){
  const sets=ex.sets;
  if(metric==="volume"){ let v=0,any=false; sets.forEach(s=>{ if(typeof s.weight==="number"&&s.weight>0){v+=s.reps*s.weight;any=true;} }); return any?v:null; }
  const assisted=isAssisted(ex.name), bw=isBodyweight(sets), levels=hasLevels(sets);
  if(metric==="topweight"){
    if(assisted){ let b=null; sets.forEach(s=>{ if(typeof s.weight==="number"){ if(b===null||s.weight>b.weight||(s.weight===b.weight&&s.reps>b.reps)) b=s; } }); return b?b.weight:null; }
    if(bw) return Math.max(...sets.map(s=>s.reps));
    if(levels) return null;
    let mx=null; sets.forEach(s=>{ if(typeof s.weight==="number"&&s.weight>0){ if(mx===null||s.weight>mx) mx=s.weight; } }); return mx;
  }
  if(assisted){ let b=null; sets.forEach(s=>{ if(typeof s.weight==="number"){ const sc=s.weight*(1+s.reps/30); if(b===null||sc>b) b=sc; } }); return b; }
  if(bw) return Math.max(...sets.map(s=>s.reps));
  if(levels) return null;
  let b=null; sets.forEach(s=>{ if(typeof s.weight==="number"&&s.weight>0){ const sc=s.weight*(1+s.reps/30); if(b===null||sc>b) b=sc; } }); return b;
}
function exerciseSeries(name, metric){
  const out=[]; strengthEntries().forEach(s=> s.exercises.forEach(ex=>{ if(ex.name===name){ const v=sessionMetric(ex,metric); if(v!==null&&v!==undefined) out.push({date:s.date,value:v}); } })); return out;
}
function exerciseList(){
  const seen={}; strengthEntries().forEach(s=> s.exercises.forEach(e=>{ seen[e.name]=(seen[e.name]||0)+1; }));
  return Object.keys(seen).sort((a,b)=>{ const ga=muscleOf(a),gb=muscleOf(b); if(ga!==gb) return ga<gb?-1:1; return a<b?-1:1; }).map(n=>({name:n,count:seen[n],muscle:muscleOf(n)}));
}
let CURRENT_EX="Bench Press", CURRENT_METRIC="topweight", chart=null;

function metricMeta(name){
  const allSets=[]; strengthEntries().forEach(s=>s.exercises.forEach(e=>{ if(e.name===name) allSets.push(...e.sets); }));
  const bw=allSets.length&&allSets.every(s=>s.weight===0); const levels=allSets.some(s=>s.weight===null);
  return {assisted:isAssisted(name),bw,levels};
}
function buildStrip(){
  const ss=strengthEntries(); const types={Push:0,Pull:0,Legs:0,Other:0}; let sets=0,vol=0;
  ss.forEach(s=>{ types[s.type]=(types[s.type]||0)+1; s.exercises.forEach(e=>e.sets.forEach(st=>{ sets++; if(typeof st.weight==="number"&&st.weight>0) vol+=st.reps*st.weight; })); });
  document.getElementById("strip").innerHTML=`
    <div class="stat"><div class="k">Sessions</div><div class="v mono">${ss.length}</div></div>
    <div class="stat"><div class="k">Working volume</div><div class="v mono">${(vol/1000).toFixed(1)}<small> t</small></div></div>
    <div class="stat"><div class="k">Total sets</div><div class="v mono">${sets}</div></div>
    <div class="stat"><div class="k">Push / Pull / Legs</div><div class="v mono" style="font-size:19px">${types.Push} · ${types.Pull} · ${types.Legs}</div></div>`;
}
function buildSelect(){
  const sel=document.getElementById("exSelect"); const list=exerciseList(); let html="",lastG=null;
  list.forEach(e=>{ if(e.muscle!==lastG){ if(lastG!==null) html+="</optgroup>"; html+=`<optgroup label="${e.muscle}">`; lastG=e.muscle; } html+=`<option value="${e.name.replace(/"/g,'&quot;')}">${e.name} (${e.count})</option>`; });
  if(lastG!==null) html+="</optgroup>"; sel.innerHTML=html;
  if(!list.find(e=>e.name===CURRENT_EX)&&list.length) CURRENT_EX=list[0].name; sel.value=CURRENT_EX;
}
function renderStrength(){
  const meta=metricMeta(CURRENT_EX); const series=exerciseSeries(CURRENT_EX,CURRENT_METRIC);
  document.getElementById("exName").textContent=CURRENT_EX;
  document.getElementById("exTag").textContent=muscleOf(CURRENT_EX);
  document.getElementById("histExName").textContent=CURRENT_EX;
  let unit="kg",note="";
  if(meta.assisted){ unit=""; note="Assistance load (kg). Less assistance = stronger — the line climbing toward zero is progress."; }
  else if(meta.bw){ unit=" reps"; note="Bodyweight exercise — tracking reps in the top set."; }
  else if(meta.levels&&CURRENT_METRIC!=="volume"){ note="Some sessions use machine levels, so only weighted sessions appear here."; }
  if(CURRENT_METRIC==="volume"){ unit=" kg"; note="Total weighted volume (reps × weight, summed across sets)."; }
  if(CURRENT_METRIC==="e1rm"&&!meta.assisted&&!meta.bw) note="Epley estimate from your best working set: weight × (1 + reps/30).";
  if(CURRENT_METRIC==="topweight"&&meta.assisted) note="Least assistance used in a session (closer to 0 is stronger).";
  document.getElementById("metricNote").textContent=note;
  const dEl=document.getElementById("exDelta");
  if(series.length>=2){ const a=series[0].value,b=series[series.length-1].value,diff=b-a;
    const cls=diff>0.05?"up":diff<-0.05?"down":"flat"; const arrow=cls==="up"?"▲":cls==="down"?"▼":"●";
    dEl.innerHTML=`<span class="${cls}">${arrow} ${diff>0?"+":""}${fmt(diff)}${unit}</span> <span style="color:var(--faint)">since start</span>`;
  } else dEl.innerHTML=`<span class="flat">single session</span>`;
  drawLine("mainChart", series, unit, meta);
  buildHist(); buildPR();
}
function drawLine(canvasId, series, unit, meta){
  const ctx=document.getElementById(canvasId); const labels=series.map(p=>fmtDate(p.date)); const vals=series.map(p=>p.value);
  if(chart&&canvasId==="mainChart") chart.destroy();
  const grad=ctx.getContext("2d").createLinearGradient(0,0,0,300);
  grad.addColorStop(0,"rgba(245,166,35,0.22)"); grad.addColorStop(1,"rgba(245,166,35,0.01)");
  let runMax=-Infinity; const prF=vals.map(v=>{ const p=v>runMax; if(v>runMax)runMax=v; return p; });
  const c=new Chart(ctx,{type:"line",data:{labels,datasets:[{data:vals,borderColor:"#f5a623",backgroundColor:grad,fill:true,borderWidth:2.5,tension:0.28,
    pointRadius:vals.map((v,i)=>prF[i]?5:3.5),pointBackgroundColor:vals.map((v,i)=>prF[i]?"#f5a623":"#1b1f28"),pointBorderColor:"#f5a623",pointBorderWidth:2,pointHoverRadius:6}]},
    options:{responsive:true,maintainAspectRatio:false,interaction:{intersect:false,mode:"index"},
      plugins:{legend:{display:false},tooltip:{backgroundColor:"#0e1116",borderColor:"#2c323d",borderWidth:1,titleColor:"#e8eaed",bodyColor:"#f5a623",padding:11,displayColors:false,
        titleFont:{family:"Inter",weight:"600",size:12},bodyFont:{family:"SF Mono, monospace",size:14,weight:"700"},
        callbacks:{title:(it)=>series[it[0].dataIndex].date,label:(it)=>`${fmt(it.raw)}${unit}${prF[it.dataIndex]?"   ★ PR":""}`}}},
      scales:{x:{grid:{color:"rgba(44,50,61,0.5)"},ticks:{color:"#5a626f",font:{family:"SF Mono, monospace",size:10.5},maxRotation:0}},
        y:{grid:{color:"rgba(44,50,61,0.5)"},ticks:{color:"#5a626f",font:{family:"SF Mono, monospace",size:10.5}}}}}});
  if(canvasId==="mainChart") chart=c;
}
function buildHist(){
  const rows=[]; let runMax=-Infinity;
  strengthEntries().forEach(s=>s.exercises.forEach(e=>{ if(e.name===CURRENT_EX){ const m=sessionMetric(e,"e1rm"); const pr=m!==null&&m>runMax; if(m!==null&&m>runMax)runMax=m; rows.push({date:s.date,sets:e.sets,e1:m,pr}); } }));
  rows.reverse(); let html=`<tr><th>Date</th><th>Sets (reps × kg)</th><th class="r">e1RM</th></tr>`;
  rows.forEach(r=>{ const pills=r.sets.map(st=>`<span class="setpill mono">${setLabel(st)}</span>`).join("");
    html+=`<tr><td class="mono" style="white-space:nowrap">${r.date}</td><td>${pills}</td><td class="r mono ${r.pr?'pr':''}">${r.e1===null?"—":fmt(r.e1)}${r.pr?" ★":""}</td></tr>`; });
  document.getElementById("histTable").innerHTML=html;
}
function buildPR(){
  const best={}; strengthEntries().forEach(s=>s.exercises.forEach(e=>{ const m=sessionMetric(e,"e1rm"); if(m===null) return;
    if(!best[e.name]||m>best[e.name].val) best[e.name]={val:m,date:s.date,muscle:muscleOf(e.name),assisted:isAssisted(e.name),bw:isBodyweight(e.sets)}; }));
  const arr=Object.keys(best).map(n=>({name:n,...best[n]})).filter(x=>!x.assisted&&!x.bw).sort((a,b)=>b.val-a.val).slice(0,10);
  let html=`<tr><th>Exercise</th><th class="r">e1RM</th></tr>`;
  arr.forEach(x=>{ html+=`<tr><td>${x.name}<div style="color:var(--faint);font-size:11px">${x.muscle} · ${x.date}</div></td><td class="r mono pr">${fmt(x.val)}<small style="color:var(--faint)"> kg</small></td></tr>`; });
  document.getElementById("prTable").innerHTML=html;
}

/* ===================== CARDIO ===================== */
let CARDIO_METRIC="pace", cardioChart=null, CARDIO_ACT=null;
// activities that track distance/pace; everything else is calorie-only
const DISTANCE_ACTIVITIES=["Run","Walk","Cycle","Row","Swim","Hike"];
function isDistanceActivity(name){ return DISTANCE_ACTIVITIES.some(a=> (name||"").toLowerCase().startsWith(a.toLowerCase())); }

function buildCardio(){
  const all=cardioEntries();
  // populate activity selector from logged activities
  const acts=[...new Set(all.map(c=>c.activity||"Cardio"))];
  if(!acts.length) acts.push("Run");
  // default selection: Run if present, else first
  if(!CARDIO_ACT || !acts.includes(CARDIO_ACT)) CARDIO_ACT = acts.includes("Run")?"Run":acts[0];
  const sel=document.getElementById("cardioActSelect");
  sel.innerHTML=acts.map(a=>`<option value="${a.replace(/"/g,'&quot;')}">${a}</option>`).join("");
  sel.value=CARDIO_ACT;

  const ce=all.filter(c=>(c.activity||"Cardio")===CARDIO_ACT);
  const distbased=isDistanceActivity(CARDIO_ACT);

  // show/hide metric buttons based on activity type; calorie-only forces "calories"
  document.querySelectorAll("#cardioSeg button").forEach(b=>{
    const m=b.dataset.m;
    b.style.display = (!distbased && (m==="pace"||m==="distance")) ? "none" : "";
  });
  if(!distbased){
    CARDIO_METRIC="calories";
    document.querySelectorAll("#cardioSeg button").forEach(x=>x.classList.toggle("on",x.dataset.m==="calories"));
  }

  let totDist=0,totTime=0,totCal=0; ce.forEach(c=>{ totDist+=c.distance_km||0; totTime+=c.duration_min||0; totCal+=c.calories||0; });
  const bestPace=ce.filter(c=>c.pace_min_km).length?Math.min(...ce.filter(c=>c.pace_min_km).map(c=>c.pace_min_km)):0;
  document.getElementById("cardioStrip").innerHTML = distbased ? `
    <div class="stat"><div class="k">Sessions</div><div class="v mono">${ce.length}</div></div>
    <div class="stat"><div class="k">Total distance</div><div class="v mono">${totDist.toFixed(1)}<small> km</small></div></div>
    <div class="stat"><div class="k">Best pace</div><div class="v mono">${bestPace?pace(bestPace):"—"}<small> /km</small></div></div>
    <div class="stat"><div class="k">Calories</div><div class="v mono">${fmt0(totCal)}</div></div>` : `
    <div class="stat"><div class="k">Sessions</div><div class="v mono">${ce.length}</div></div>
    <div class="stat"><div class="k">Total time</div><div class="v mono">${Math.round(totTime)}<small> min</small></div></div>
    <div class="stat"><div class="k">Calories</div><div class="v mono">${fmt0(totCal)}</div></div>
    <div class="stat"><div class="k">Avg / session</div><div class="v mono">${ce.length?fmt0(totCal/ce.length):0}<small> kcal</small></div></div>`;

  const series=ce.map(c=>({date:c.date, pace:c.pace_min_km, distance:c.distance_km, calories:c.calories}));
  const metric = distbased ? CARDIO_METRIC : "calories";
  const vals=series.map(p=>p[metric]); const labels=series.map(p=>fmtDate(p.date));
  const ctx=document.getElementById("cardioChart"); if(cardioChart) cardioChart.destroy();
  const grad=ctx.getContext("2d").createLinearGradient(0,0,0,300); grad.addColorStop(0,"rgba(91,155,213,0.22)"); grad.addColorStop(1,"rgba(91,155,213,0.01)");
  cardioChart=new Chart(ctx,{type:series.length===1?"bar":"line",data:{labels,datasets:[{data:vals,borderColor:"#5b9bd5",backgroundColor:series.length===1?"#5b9bd5":grad,fill:true,borderWidth:2.5,tension:0.28,pointRadius:4,pointBackgroundColor:"#5b9bd5",borderRadius:6,maxBarThickness:60}]},
    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{backgroundColor:"#0e1116",borderColor:"#2c323d",borderWidth:1,titleColor:"#e8eaed",bodyColor:"#5b9bd5",padding:11,displayColors:false,
      callbacks:{title:(it)=>series[it[0].dataIndex].date,label:(it)=> metric==="pace"?pace(it.raw)+" /km":metric==="distance"?it.raw+" km":fmt0(it.raw)+" kcal"}}},
      scales:{x:{grid:{color:"rgba(44,50,61,0.5)"},ticks:{color:"#5a626f",font:{family:"SF Mono, monospace",size:10.5},maxRotation:0}},
        y:{grid:{color:"rgba(44,50,61,0.5)"},ticks:{color:"#5a626f",font:{family:"SF Mono, monospace",size:10.5},callback:v=>metric==="pace"?pace(v):v}}}}});
  document.getElementById("cardioNote").textContent = metric==="pace"?"Pace per km (lower is faster — a downward line means you're getting quicker).":metric==="distance"?"Distance per session.":"Calories burned per session.";

  // table
  let html=`<tr><th>Date</th><th>Activity</th><th class="r">Dist</th><th class="r">Time</th><th class="r">Pace</th><th class="r">kcal</th></tr>`;
  ce.slice().reverse().forEach(c=>{ html+=`<tr><td class="mono" style="white-space:nowrap">${c.date}</td><td>${c.activity}${c.note?`<div style="color:var(--faint);font-size:11px">${c.note}</div>`:""}</td>
    <td class="r mono">${c.distance_km?c.distance_km.toFixed(2):"—"}</td><td class="r mono">${c.duration_min?Math.round(c.duration_min)+'m':"—"}</td>
    <td class="r mono">${c.pace_min_km?pace(c.pace_min_km):"—"}</td><td class="r mono">${c.calories?fmt0(c.calories):"—"}</td></tr>`; });
  document.getElementById("cardioTable").innerHTML=html;
}

/* ===================== CALORIES ===================== */
let CAL_DAY=localDateString();
function profile(){ return STORE.profile; }
function workoutBurnForDay(day){
  let burn=0;
  entries().forEach(e=>{ if(e.date!==day) return;
    if(e.kind==="cardio") burn+=e.calories||0;
    else if(e.kind==="strength") burn+=STRENGTH_BURN[e.type]||280; });
  return burn;
}
function foodForDay(day){ return foodEntries().filter(f=>f.date===day); }
function ouraForDay(day){ return (STORE.ouraDaily||[]).find(row=>row.date===day&&row.totalCalories>0)||null; }
function dayTotals(day,{includeOura=true}={}){
  const p=profile(); const maint=Math.round(p.bmr*parseFloat(p.activityMult||1.2));
  let workout=workoutBurnForDay(day);
  const foods=foodForDay(day); const intake=foods.reduce((a,f)=>a+(f.kcal||0),0);
  const protein=foods.reduce((a,f)=>a+(f.p||0),0);
  const oura=includeOura?ouraForDay(day):null;
  const awaitingOura=includeOura&&OURA_CONNECTED&&!oura;
  let base=maint, out=maint+workout;
  if(oura){
    out=oura.totalCalories;
    workout=oura.activeCalories||0;
    base=Math.max(0,out-workout);
  }else if(awaitingOura){
    // Once Oura is connected, never mix its totals with app-estimated workout
    // burn. Leave burn-dependent values unavailable until Oura finalizes the day.
    base=null;
    workout=null;
    out=null;
  }
  const net=out===null?null:intake-out; // negative = deficit
  return {maint:base,workout,out,intake,protein,net,foods,oura,awaitingOura};
}
function renderCalories(){
  const p=profile();
  if(!p.activityMult) p.activityMult=1.2;
  document.getElementById("calDate").value=CAL_DAY;
  const t=dayTotals(CAL_DAY);
  const burnAvailable=t.out!==null;
  document.getElementById("lMaint").textContent=burnAvailable?fmt0(t.maint)+" kcal":"—";
  document.getElementById("lWorkout").textContent=burnAvailable?(t.workout?"+":"")+fmt0(t.workout)+" kcal":"—";
  document.getElementById("lMaintLabel").textContent=t.oura||t.awaitingOura?"Base / resting burn (Oura)":"Resting burn (BMR×activity)";
  document.getElementById("lWorkoutLabel").textContent=t.oura||t.awaitingOura?"Active burn (Oura)":"Workout burn";
  document.getElementById("lOut").textContent=burnAvailable?fmt0(t.out)+" kcal":"Waiting for Oura";
  document.getElementById("lIn").textContent=fmt0(t.intake)+" kcal";
  const deficit=burnAvailable?-t.net:0;
  const targetDelta=desiredCalorieDelta(p);
  const deltaGap=burnAvailable?t.net-targetDelta:Infinity;
  const lNet=document.getElementById("lNet");
  lNet.textContent=burnAvailable?(t.net<0?"−":"+")+fmt0(Math.abs(t.net))+" kcal":"—";
  lNet.style.color=burnAvailable?(Math.abs(deltaGap)<=150?"var(--green)":Math.abs(deltaGap)<=300?"var(--amber)":"var(--red)"):"var(--muted)";

  document.getElementById("netNum").innerHTML = burnAvailable?(t.net<0?"−":"+")+fmt0(Math.abs(t.net))+`<small> kcal</small>`:`—<small> kcal</small>`;
  document.getElementById("netSub").textContent = t.awaitingOura ? "Oura has not finalized calorie burn for this day yet." : t.intake===0 ? "No food logged yet for this day" :
    (targetDelta<0 ? `Target: ${goalText(p)}. Current: ${t.net<0?"−":"+"}${fmt0(Math.abs(t.net))}.` :
    targetDelta>0 ? `Target: ${goalText(p)}. Current: ${t.net<0?"−":"+"}${fmt0(Math.abs(t.net))}.` :
    `Target: maintenance. Current: ${t.net<0?"−":"+"}${fmt0(Math.abs(t.net))}.`);

  // bar: food in vs total out
  const maxv=Math.max(t.out||0,t.intake,1); const fill=document.getElementById("calFill");
  const pct=burnAvailable?Math.min(100,(t.intake/maxv)*100):0;
  fill.style.width=pct+"%"; fill.style.background = burnAvailable&&t.intake>t.out?"var(--red)":"var(--green)";
  document.getElementById("barInLbl").textContent="in "+fmt0(t.intake);
  document.getElementById("barOutLbl").textContent=burnAvailable?"out "+fmt0(t.out):"out —";

  // verdict pill
  const v=document.getElementById("calVerdict"); const target=p.deficit_target||400;
  if(!burnAvailable){ v.innerHTML=`<span class="verdict near">waiting for Oura</span>`; }
  else if(t.intake===0){ v.innerHTML=`<span class="verdict near">awaiting food</span>`; }
  else if(targetDelta<0 && deficit>=Math.abs(targetDelta)){ v.innerHTML=`<span class="verdict deficit">on track · −${fmt0(deficit)}</span>`; }
  else if(targetDelta<0 && deficit>0){ v.innerHTML=`<span class="verdict near">mild deficit · −${fmt0(deficit)}</span>`; }
  else if(targetDelta>0 && t.net>=targetDelta){ v.innerHTML=`<span class="verdict surplus">on track · +${fmt0(t.net)}</span>`; }
  else if(targetDelta>0 && t.net>0){ v.innerHTML=`<span class="verdict near">mild surplus · +${fmt0(t.net)}</span>`; }
  else if(targetDelta===0 && Math.abs(t.net)<=150){ v.innerHTML=`<span class="verdict near">near maintenance</span>`; }
  else { v.innerHTML=`<span class="verdict surplus">${t.net<0?"under":"over"} · ${t.net<0?"−":"+"}${fmt0(Math.abs(t.net))}</span>`; }

  // protein calculator
  if(!p.protein_per_kg) p.protein_per_kg=2.0;
  const proTarget=Math.round(p.weight_kg*p.protein_per_kg);
  const proEaten=Math.round(t.protein);
  document.getElementById("proPerKg").value=String(p.protein_per_kg);
  document.getElementById("proNum").innerHTML=`${proEaten}<small> / ${proTarget} g</small>`;
  const proPct=Math.min(100,proTarget?proEaten/proTarget*100:0);
  const pf=document.getElementById("proFill");
  pf.style.width=proPct+"%";
  pf.style.background = proEaten>=proTarget?"var(--green)":proEaten>=proTarget*0.8?"var(--amber)":"var(--blue)";
  document.getElementById("proEaten").textContent=proEaten+"g eaten";
  document.getElementById("proTarget").textContent=proTarget+"g target ("+p.protein_per_kg+" g/kg)";
  const proGap=proTarget-proEaten;
  if(t.protein===0) document.getElementById("proNote").textContent=`Aim for ${proTarget}g today to hold muscle while cutting — that's ${p.protein_per_kg} g per kg of bodyweight.`;
  else if(proGap>0) document.getElementById("proNote").textContent=`${proGap}g to go. A chicken breast (~45g), Greek yogurt (~15g), or a scoop of whey (~25g) closes the gap.`;
  else document.getElementById("proNote").textContent=`Target hit — ${proEaten}g logged. Good protein day for protecting muscle on a cut.`;

  // food list
  document.getElementById("foodDayLbl").textContent=fmtDate(CAL_DAY);
  const fl=document.getElementById("foodList");
  if(!t.foods.length){ fl.innerHTML=`<div style="color:var(--faint);font-size:13px;padding:8px 0">Nothing logged. Snap a meal photo in chat and I'll give you the numbers, or add manually below.</div>`; }
  else{
    fl.innerHTML=t.foods.map((f,i)=>`<div class="foodItem"><div><div style="font-weight:600">${f.name}</div>
      <div class="macro">${f.p?`<span>P <b>${f.p}g</b></span>`:""}${f.c?`<span>C <b>${f.c}g</b></span>`:""}${f.fat?`<span>F <b>${f.fat}g</b></span>`:""}</div></div>
      <div style="display:flex;align-items:center;gap:10px"><span class="mono" style="font-weight:700">${fmt0(f.kcal)}</span>
      <button class="xBtn" data-fi="${f._id}">✕</button></div></div>`).join("");
    fl.querySelectorAll("[data-fi]").forEach(b=> b.onclick=()=>{ removeFood(b.dataset.fi); });
  }

  // 7-day chart
  drawWeek();
  drawProteinWeek();
  // weight trend
  renderWeight();

  // profile panel
  document.getElementById("pStats").textContent=`${p.weight_kg} kg · ${p.height_cm} cm · ${p.age} y`;
  document.getElementById("pBmr").textContent=fmt0(p.bmr)+" kcal";
  document.getElementById("pMaint").textContent=fmt0(Math.round(p.bmr*parseFloat(p.activityMult)))+" kcal";
  document.getElementById("pTarget").textContent=goalText(p);
  document.getElementById("goalLbl").textContent=targetDelta<0?fmt0(Math.abs(targetDelta)):targetDelta>0?fmt0(targetDelta):"0";
  document.getElementById("pGoalHint").textContent=targetDelta<0?
    "Your target weight is lower than your current weight, so the app is aiming for a steady calorie deficit.":
    targetDelta>0?"Your target weight is higher than your current weight, so the app is aiming for a controlled surplus.":
    "Your target is close to your current weight, so the app is aiming around maintenance.";
  document.getElementById("pActivity").value=String(p.activityMult);
}
let weekChart=null;
function drawWeek(){
  const p=profile(); const target=Math.abs(desiredCalorieDelta(p));
  const days=[];
  for(let i=6;i>=0;i--) days.push(addLocalDays(CAL_DAY,-i));
  const nets=days.map(d=>{ const t=dayTotals(d); return t.intake===0||t.net===null?null:t.net; });
  const ctx=document.getElementById("weekChart"); if(weekChart) weekChart.destroy();
  weekChart=new Chart(ctx,{type:"bar",data:{labels:days.map(fmtDate),datasets:[{data:nets.map(n=>n===null?0:n),
    backgroundColor:nets.map(n=>n===null?"#2c323d":n<0?"#4ade80":"#e3604d"),borderRadius:5,maxBarThickness:34}]},
    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},
      tooltip:{backgroundColor:"#0e1116",borderColor:"#2c323d",borderWidth:1,padding:10,displayColors:false,
        callbacks:{label:(it)=>{ const n=nets[it.dataIndex]; return n===null?"no food logged":(n<0?"−":"+")+fmt0(Math.abs(n))+" kcal"; }}},
      annotation:false},
      scales:{x:{grid:{display:false},ticks:{color:"#5a626f",font:{family:"SF Mono, monospace",size:10}}},
        y:{grid:{color:"rgba(44,50,61,0.5)"},ticks:{color:"#5a626f",font:{family:"SF Mono, monospace",size:10}},
          afterBuildTicks:(ax)=>{} }}}});
}
let proteinWeekChart=null;
function drawProteinWeek(){
  const p=profile();
  const proTarget=Math.round((p.weight_kg||0)*(p.protein_per_kg||2));
  const days=[];
  for(let i=6;i>=0;i--) days.push(addLocalDays(CAL_DAY,-i));
  const vals=days.map(d=>dayTotals(d).protein||0);
  const ctx=document.getElementById("proteinWeekChart"); if(proteinWeekChart) proteinWeekChart.destroy();
  proteinWeekChart=new Chart(ctx,{type:"bar",data:{labels:days.map(fmtDate),datasets:[{data:vals,
    backgroundColor:vals.map(v=>v>=proTarget?"#4ade80":v>=proTarget*0.8?"#f5a623":"#5b9bd5"),
    borderRadius:5,maxBarThickness:34}]},
    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},
      tooltip:{backgroundColor:"#0e1116",borderColor:"#2c323d",borderWidth:1,padding:10,displayColors:false,
        callbacks:{label:(it)=>fmt0(it.raw)+"g protein"}}},
      scales:{x:{grid:{display:false},ticks:{color:"#5a626f",font:{family:"SF Mono, monospace",size:10}}},
        y:{grid:{color:"rgba(44,50,61,0.5)"},ticks:{color:"#5a626f",font:{family:"SF Mono, monospace",size:10},callback:v=>v+"g"},
          suggestedMax:Math.max(proTarget, ...vals, 1)}}}});
}

/* ---- weight tracking ---- */
function weights(){ return (STORE.weights||[]).slice().sort((a,b)=> a.date<b.date?-1:1); }
function rollingAvg(arr, idx, win){
  // average of up to `win` points ending at idx
  let s=0,n=0; for(let i=Math.max(0,idx-win+1);i<=idx;i++){ s+=arr[i].kg; n++; } return s/n;
}
let weightChart=null;
function renderWeight(){
  const w=weights();
  const latestEl=document.getElementById("wLatest");
  const rateEl=document.getElementById("wRate");
  const subEl=document.getElementById("wRateSub");
  if(!w.length){
    latestEl.innerHTML=`—<small> kg</small>`;
    rateEl.textContent=""; subEl.textContent="Log your morning weight to start the trend. Withings users: read the number off the app each morning.";
    if(weightChart) weightChart.destroy();
    const ctx=document.getElementById("weightChart");
    weightChart=new Chart(ctx,{type:"line",data:{labels:[],datasets:[{data:[]}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}}}});
    return;
  }
  const last=w[w.length-1];
  latestEl.innerHTML=`${last.kg.toFixed(1)}<small> kg</small>`;

  // 7-day rolling average series
  const avg=w.map((p,i)=>rollingAvg(w,i,7));
  // weekly rate: compare current avg to avg ~7 days earlier (by index, best-effort)
  let rate=null;
  if(w.length>=2){
    // find a point ~7 days before the last date
    const lastDate=new Date(last.date+"T00:00:00");
    let refIdx=0;
    for(let i=0;i<w.length;i++){ const d=new Date(w[i].date+"T00:00:00"); if((lastDate-d)/86400000<=7){ refIdx=i; break; } }
    const days=Math.max(1,(lastDate-new Date(w[refIdx].date+"T00:00:00"))/86400000);
    const deltaAvg=avg[w.length-1]-avg[refIdx];
    rate = days>0 ? deltaAvg/days*7 : null;  // kg per week
  }
  if(rate!==null && w.length>=3){
    const down=rate<0;
    rateEl.innerHTML=`<span style="color:${down?'var(--green)':'var(--red)'}">${rate>0?'+':''}${rate.toFixed(2)} kg/wk</span>`;
    let msg;
    const mag=Math.abs(rate);
    if(down && mag>=0.3 && mag<=0.6) msg="In the ideal cut zone — fat loss with muscle spared.";
    else if(down && mag<0.3) msg="Slow loss. Fine, or tighten the deficit slightly if you want it faster.";
    else if(down && mag>0.6) msg="Fast loss — watch your lifts; if they dip, eat a bit more.";
    else if(!down) msg="Trending up. If shredding is the goal, widen the deficit.";
    subEl.textContent=msg+" (based on the 7-day average, not daily noise)";
  } else {
    rateEl.textContent="";
    subEl.textContent=`${w.length} weigh-in${w.length>1?'s':''} logged — a few more days and the weekly rate appears.`;
  }

  // chart: faint daily points + bold rolling avg line
  const labels=w.map(p=>fmtDate(p.date));
  const ctx=document.getElementById("weightChart"); if(weightChart) weightChart.destroy();
  weightChart=new Chart(ctx,{type:"line",data:{labels,datasets:[
    {label:"Daily", data:w.map(p=>p.kg), borderColor:"rgba(139,147,161,0.25)", backgroundColor:"transparent",
      borderWidth:1, pointRadius:2.5, pointBackgroundColor:"rgba(139,147,161,0.5)", pointBorderWidth:0, tension:0, order:2},
    {label:"7-day avg", data:avg, borderColor:"#f5a623", backgroundColor:"transparent",
      borderWidth:2.5, pointRadius:0, tension:0.3, order:1}
  ]},
    options:{responsive:true,maintainAspectRatio:false,interaction:{intersect:false,mode:"index"},
      plugins:{legend:{display:true, labels:{color:"#8b93a1", font:{size:11}, boxWidth:14, usePointStyle:true}},
        tooltip:{backgroundColor:"#0e1116",borderColor:"#2c323d",borderWidth:1,padding:10,
          callbacks:{label:(it)=>`${it.dataset.label}: ${it.raw.toFixed(1)} kg`}}},
      scales:{x:{grid:{color:"rgba(44,50,61,0.4)"},ticks:{color:"#5a626f",font:{family:"SF Mono, monospace",size:10},maxRotation:0,autoSkip:true,maxTicksLimit:8}},
        y:{grid:{color:"rgba(44,50,61,0.5)"},ticks:{color:"#5a626f",font:{family:"SF Mono, monospace",size:10},callback:v=>v+" kg"}}}}});
}
function saveWeight(){
  const v=parseFloat(document.getElementById("wInput").value);
  if(isNaN(v)||v<=0){ toast("Enter a weight in kg"); return; }
  STORE.weights=STORE.weights||[];
  // one entry per day — replace if same date exists
  const existing=STORE.weights.find(x=>x.date===CAL_DAY);
  if(existing) existing.kg=v; else STORE.weights.push({date:CAL_DAY, kg:v});
  saveStore(STORE);
  document.getElementById("wInput").value="";
  toast("Weight logged ✓");
  renderWeight();
}

function removeFood(id){
  // custom food: remove outright. seed food: add to a hidden set so it disappears.
  const before=(STORE.food||[]).length;
  STORE.food=(STORE.food||[]).filter(f=>f._id!==id);
  if((STORE.food||[]).length===before){
    STORE.hiddenFood=STORE.hiddenFood||[]; if(!STORE.hiddenFood.includes(id)) STORE.hiddenFood.push(id);
  }
  saveStore(STORE); renderCalories(); toast("Removed");
}

/* ===================== FORMS ===================== */
// strength add
let exFormCount=0;
function setRowHTML(i){ return `<div class="setRow"><span class="ix mono">Set ${i}</span>
  <input type="number" class="sReps" placeholder="reps" min="0" step="1"><span style="color:var(--faint)">×</span>
  <input type="number" class="sWeight" placeholder="kg" step="0.1"><button class="xBtn rmSet">✕</button></div>`; }
function exBlockHTML(){ exFormCount++; return `<div class="exBlock">
  <div class="frow" style="margin-bottom:10px"><div class="field" style="flex:1"><label>Exercise</label>
  <input type="text" class="exName" list="exNames" placeholder="e.g. Bench Press"></div>
  <button class="xBtn rmEx" title="Remove">✕</button></div><div class="setList"></div>
  <button class="linkBtn addSet">+ Add set</button></div>`; }
function addSetTo(block){ const list=block.querySelector(".setList"); const i=list.children.length+1;
  const d=document.createElement("div"); d.innerHTML=setRowHTML(i); list.appendChild(d.firstElementChild);
  block.querySelectorAll(".rmSet").forEach(b=> b.onclick=()=>{ b.closest(".setRow").remove(); }); }
function addExBlock(){ const c=document.getElementById("exContainer"); const d=document.createElement("div"); d.innerHTML=exBlockHTML();
  const block=d.firstElementChild; c.appendChild(block); block.querySelector(".addSet").onclick=()=>addSetTo(block);
  block.querySelector(".rmEx").onclick=()=>block.remove(); addSetTo(block);addSetTo(block);addSetTo(block); }
function resetStrengthForm(){ document.getElementById("exContainer").innerHTML=""; exFormCount=0;
  document.getElementById("fDate").value=localDateString(); document.getElementById("fType").value="Push"; addExBlock(); }
function saveStrength(){
  const date=document.getElementById("fDate").value, type=document.getElementById("fType").value;
  if(!date){ toast("Pick a date"); return; }
  const exercises=[];
  document.querySelectorAll("#exContainer .exBlock").forEach(block=>{
    const name=block.querySelector(".exName").value.trim(); if(!name) return; const sets=[];
    block.querySelectorAll(".setRow").forEach(row=>{ const reps=parseFloat(row.querySelector(".sReps").value); const wRaw=row.querySelector(".sWeight").value;
      if(isNaN(reps)) return; let weight=wRaw===""?0:parseFloat(wRaw); if(isNaN(weight)) weight=0; sets.push({reps,weight}); });
    if(sets.length) exercises.push({name,muscle:muscleOf(name),sets}); });
  if(!exercises.length){ toast("Add at least one exercise"); return; }
  STORE.entries.push({kind:"strength",date,type,exercises}); saveStore(STORE);
  toast("Session saved ✓"); document.getElementById("addForm").classList.remove("open"); document.getElementById("toggleForm").textContent="+ Add session";
  buildStrip(); buildSelect(); CURRENT_EX=exercises[0].name; document.getElementById("exSelect").value=CURRENT_EX; rebuildDatalist(); renderStrength();
}
// cardio add
function saveCardioEntry(){
  const date=document.getElementById("cDate").value, act=document.getElementById("cAct").value.trim()||"Run";
  const dist=parseFloat(document.getElementById("cDist").value), time=parseFloat(document.getElementById("cTime").value), cal=parseFloat(document.getElementById("cCal").value);
  if(!date){ toast("Pick a date"); return; }
  const e={kind:"cardio",date,activity:act};
  if(!isNaN(dist)) e.distance_km=dist; if(!isNaN(time)) e.duration_min=time;
  if(!isNaN(dist)&&!isNaN(time)&&dist>0) e.pace_min_km=time/dist; if(!isNaN(cal)) e.calories=cal;
  STORE.entries.push(e); saveStore(STORE); toast("Cardio saved ✓");
  document.getElementById("cardioForm").classList.remove("open"); document.getElementById("toggleCardio").textContent="+ Add cardio";
  buildCardio();
}
// food add
function saveFoodEntry(){
  const name=document.getElementById("foodName").value.trim(); const kcal=parseFloat(document.getElementById("foodKcal").value);
  if(!name||isNaN(kcal)){ toast("Need a name and calories"); return; }
  const f={_id:"f"+Date.now()+Math.random().toString(36).slice(2,6),date:CAL_DAY,name,kcal,
    p:parseFloat(document.getElementById("foodP").value)||0,c:parseFloat(document.getElementById("foodC").value)||0,fat:parseFloat(document.getElementById("foodF").value)||0};
  STORE.food=STORE.food||[]; STORE.food.push(f); saveStore(STORE);
  ["foodName","foodKcal","foodP","foodC","foodF"].forEach(id=>document.getElementById(id).value="");
  document.getElementById("foodForm").classList.remove("open"); document.getElementById("toggleFood").textContent="+ Add food";
  toast("Food added ✓"); renderCalories();
}

function rebuildDatalist(){
  const names=[...new Set(strengthEntries().flatMap(s=>s.exercises.map(e=>e.name)))].sort();
  document.getElementById("exNames").innerHTML=names.map(n=>`<option value="${n.replace(/"/g,'&quot;')}">`).join("");
}

/* ===================== EVENTS / INIT ===================== */
document.querySelector(".tabs").addEventListener("click",e=>{ const b=e.target.closest("button"); if(!b) return;
  document.querySelectorAll(".tabs button").forEach(x=>x.classList.remove("on")); b.classList.add("on");
  const v=b.dataset.v; document.querySelectorAll(".view").forEach(x=>x.classList.remove("on"));
  document.getElementById("view-"+v).classList.add("on");
  if(v==="cardio") buildCardio();
  if(v==="calories"){
    renderCalories();
    maybeAutoSyncOura(true);
  }
});
document.getElementById("exSelect").addEventListener("change",e=>{ CURRENT_EX=e.target.value; renderStrength(); });
document.getElementById("metricSeg").addEventListener("click",e=>{ const b=e.target.closest("button"); if(!b) return;
  document.querySelectorAll("#metricSeg button").forEach(x=>x.classList.remove("on")); b.classList.add("on"); CURRENT_METRIC=b.dataset.m; renderStrength(); });
document.getElementById("cardioSeg").addEventListener("click",e=>{ const b=e.target.closest("button"); if(!b) return;
  document.querySelectorAll("#cardioSeg button").forEach(x=>x.classList.remove("on")); b.classList.add("on"); CARDIO_METRIC=b.dataset.m; buildCardio(); });
document.getElementById("cardioActSelect").addEventListener("change",e=>{ CARDIO_ACT=e.target.value; CARDIO_METRIC="pace"; buildCardio(); });

document.getElementById("toggleForm").addEventListener("click",()=>{ const f=document.getElementById("addForm"); const open=f.classList.toggle("open");
  document.getElementById("toggleForm").textContent=open?"Close":"+ Add session"; if(open&&!document.getElementById("exContainer").children.length) resetStrengthForm(); });
document.getElementById("cancelBtn").addEventListener("click",()=>{ document.getElementById("addForm").classList.remove("open"); document.getElementById("toggleForm").textContent="+ Add session"; });
document.getElementById("addExBtn").addEventListener("click",addExBlock);
document.getElementById("saveBtn").addEventListener("click",saveStrength);

document.getElementById("toggleCardio").addEventListener("click",()=>{ const f=document.getElementById("cardioForm"); const open=f.classList.toggle("open");
  document.getElementById("toggleCardio").textContent=open?"Close":"+ Add cardio"; if(open) document.getElementById("cDate").value=localDateString(); });
document.getElementById("cancelCardio").addEventListener("click",()=>{ document.getElementById("cardioForm").classList.remove("open"); document.getElementById("toggleCardio").textContent="+ Add cardio"; });
document.getElementById("saveCardio").addEventListener("click",saveCardioEntry);

document.getElementById("toggleFood").addEventListener("click",()=>{ const f=document.getElementById("foodForm"); const open=f.classList.toggle("open"); document.getElementById("toggleFood").textContent=open?"Close":"+ Add food"; });
document.getElementById("cancelFood").addEventListener("click",()=>{ document.getElementById("foodForm").classList.remove("open"); document.getElementById("toggleFood").textContent="+ Add food"; });
document.getElementById("saveFood").addEventListener("click",saveFoodEntry);

document.getElementById("calDate").addEventListener("change",e=>{ CAL_DAY=e.target.value; renderCalories(); });
document.getElementById("dayPrev").addEventListener("click",()=>{ CAL_DAY=addLocalDays(CAL_DAY,-1); renderCalories(); });
document.getElementById("dayNext").addEventListener("click",()=>{ CAL_DAY=addLocalDays(CAL_DAY,1); renderCalories(); });
document.getElementById("dayToday").addEventListener("click",()=>{ CAL_DAY=localDateString(); renderCalories(); });
document.getElementById("pActivity").addEventListener("change",e=>{ STORE.profile.activityMult=parseFloat(e.target.value); STORE.profile.bmr=calcBmr(STORE.profile); STORE.profile.maintenance=Math.round(STORE.profile.bmr*STORE.profile.activityMult); saveStore(STORE); renderCalories(); });
document.getElementById("proPerKg").addEventListener("change",e=>{ STORE.profile.protein_per_kg=parseFloat(e.target.value); saveStore(STORE); renderCalories(); });
document.getElementById("wSave").addEventListener("click",saveWeight);
document.getElementById("wInput").addEventListener("keydown",e=>{ if(e.key==="Enter") saveWeight(); });
document.getElementById("welcomeSave").addEventListener("click",saveWelcomeProfile);
["welcomeWeight","welcomeHeight","welcomeAge","welcomeTarget"].forEach(id=>{
  document.getElementById(id).addEventListener("keydown",e=>{ if(e.key==="Enter") saveWelcomeProfile(); });
});

let OURA_CONNECTED=false;
let OURA_RETURN_ERROR="";
const OURA_ERRORS={
  not_configured:"Oura credentials are missing from this deployment.",
  invalid_state:"The Oura login session expired. Please try connecting again.",
  access_denied:"Oura access was not approved.",
  missing_code:"Oura did not return an authorization code.",
  daily_scope_required:"Please approve Daily access when connecting Oura.",
  token_exchange_failed:"Oura rejected the client ID, secret, or redirect URI.",
  token_storage_failed:"Oura authorized successfully, but the token could not be saved. Check the server logs.",
};
async function ouraCall(action,data={}){
  const response=await fetch("/api/oura",{method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({idToken:ID_TOKEN,action,...data})});
  const result=await response.json().catch(()=>({ok:false,error:"Invalid response from Oura sync."}));
  if(!result.ok) throw new Error(result.error||"Oura sync failed.");
  return result;
}
function latestOuraSync(){
  const values=(STORE.ouraDaily||[]).map(row=>row.syncedAt).filter(Boolean).sort();
  return values.length?values[values.length-1]:null;
}
function setOuraUi({configured=true,connected=false,message=""}={}){
  const toggle=document.getElementById("ouraToggle");
  const status=document.getElementById("ouraStatus");
  const actions=document.getElementById("ouraActions");
  OURA_CONNECTED=connected;
  toggle.checked=connected;
  toggle.disabled=!configured||!ID_TOKEN;
  actions.style.display=connected?"flex":"none";
  if(message) status.textContent=message;
  else if(!configured) status.textContent="Oura API credentials still need to be configured.";
  else if(connected){
    const last=latestOuraSync();
    status.textContent=last?`Connected · last synced ${new Date(last).toLocaleString()}`:"Connected · ready to sync";
  } else status.textContent="Off · use Oura Total Burn instead of calorie estimates";
}
async function renderOuraStatus(){
  if(!ID_TOKEN){ setOuraUi({configured:false,message:"Sign in to connect Oura."}); return; }
  setOuraUi({configured:true,connected:OURA_CONNECTED,message:"Checking connection…"});
  try{
    const result=await ouraCall("status");
    if(!result.connected&&result.lastOAuthResult&&OURA_ERRORS[result.lastOAuthResult]){
      OURA_RETURN_ERROR=OURA_ERRORS[result.lastOAuthResult];
    }
    setOuraUi({configured:result.configured,connected:result.connected,
      message:!result.connected&&OURA_RETURN_ERROR?OURA_RETURN_ERROR:""});
    if(document.getElementById("view-calories").classList.contains("on")) renderCalories();
  }catch(e){ setOuraUi({configured:true,connected:false,message:e.message}); }
}
async function maybeAutoSyncOura(force=false){
  if(!ID_TOKEN) return;
  try{
    const status=await ouraCall("status");
    if(!status.configured||!status.connected) return;
    OURA_CONNECTED=true;
    const last=latestOuraSync();
    if(force||!last||Date.now()-new Date(last).getTime()>6*60*60*1000) await syncOuraData(false);
    else if(document.getElementById("view-calories").classList.contains("on")) renderCalories();
  }catch(e){}
}
async function syncOuraData(showMessage=true){
  if(!ID_TOKEN) return;
  if(showMessage) setOuraUi({configured:true,connected:true,message:"Syncing daily calorie burn…"});
  try{
    const result=await ouraCall("sync",{startDate:addLocalDays(localDateString(),-90),endDate:localDateString()});
    if(!result.daily.length){
      const detail=result.receivedDays
        ?`Oura returned ${result.receivedDays} day${result.receivedDays===1?'':'s'}, but none included total calories.`
        :"Oura returned no Daily Activity data. Reconnect and make sure Daily access is approved.";
      throw new Error(detail);
    }
    const byDate=new Map((STORE.ouraDaily||[]).map(row=>[row.date,row]));
    result.daily.forEach(row=>byDate.set(row.date,row));
    const retentionStart=addLocalDays(localDateString(),-90);
    STORE.ouraDaily=[...byDate.values()].filter(row=>row.date>=retentionStart).sort((a,b)=>a.date<b.date?-1:1);
    saveStore(STORE);
    setOuraUi({configured:true,connected:true,message:`Connected · ${result.daily.length} day${result.daily.length===1?'':'s'} synced`});
    if(document.getElementById("view-calories").classList.contains("on")) renderCalories();
  }catch(e){ setOuraUi({configured:true,connected:true,message:e.message}); }
}
async function handleOuraReturn(){
  const params=new URLSearchParams(location.search);
  const result=params.get("oura");
  const errorCode=params.get("message")||"";
  if(!result) return;
  params.delete("oura"); params.delete("message");
  history.replaceState({},"",location.pathname+(params.toString()?"?"+params.toString():"")+location.hash);
  document.getElementById("acctBtn").click();
  if(result==="connected"){
    OURA_RETURN_ERROR="";
    setOuraUi({configured:true,connected:true,message:"Oura connected · importing daily burn…"});
    await syncOuraData(false);
  }else{
    OURA_RETURN_ERROR=OURA_ERRORS[errorCode]||"Oura could not be connected. Please try again.";
    setOuraUi({configured:true,connected:false,message:OURA_RETURN_ERROR});
  }
}

// account modal
const syncModal=document.getElementById("syncModal");
document.getElementById("acctBtn").addEventListener("click",()=>{
  const el=document.getElementById("syncStatus");
  el.style.color="var(--muted)";
  el.textContent=CURRENT_USER?("Signed in as "+(CURRENT_USER.email||CURRENT_USER.name)):"Not signed in";
  fillAccountProfileForm();
  renderAiUsageStatus();
  renderOuraStatus();
  syncModal.style.display="flex";
});
document.getElementById("acctProfileSave").addEventListener("click",saveAccountProfile);
document.getElementById("syncClose").addEventListener("click",()=>{ syncModal.style.display="none"; });
syncModal.addEventListener("click",e=>{ if(e.target===syncModal) syncModal.style.display="none"; });
document.getElementById("syncPush").addEventListener("click",pushNow);
document.getElementById("ouraSyncNow").addEventListener("click",()=>syncOuraData(true));
document.getElementById("ouraToggle").addEventListener("change",async e=>{
  const toggle=e.currentTarget;
  toggle.disabled=true;
  if(toggle.checked){
    OURA_RETURN_ERROR="";
    try{
      const result=await ouraCall("connect");
      location.assign(result.url);
    }catch(err){ setOuraUi({configured:true,connected:false,message:err.message}); }
    return;
  }
  if(!confirm("Turn off Oura sync and remove synced Oura calorie data from Strength Log?")){
    setOuraUi({configured:true,connected:true}); return;
  }
  try{
    await ouraCall("disconnect");
    STORE.ouraDaily=[];
    saveStore(STORE);
    await pushNow();
    setOuraUi({configured:true,connected:false,message:"Oura sync is off."});
    if(document.getElementById("view-calories").classList.contains("on")) renderCalories();
  }catch(err){ setOuraUi({configured:true,connected:true,message:err.message}); }
});

/* ---- floating coach chat ---- */
let QA_IMAGE=null, QA_MEDIA=null, CHAT_HISTORY=[], CHAT_CONTEXT=[];
let ONBOARDING_ACTIVE=false;
const coachOverlay=document.getElementById("coachOverlay");
function openCoach(){
  renderCoachIdentity();
  coachOverlay.style.display="flex";
  if(!CHAT_HISTORY.length){
    addBubble("coach", ONBOARDING_ACTIVE ? onboardingPrompt() : `Hey, ${selectedCoach().label} here. Tell me what you ate or trained, snap a food photo, or ask me anything about your progress.`);
  }
  setTimeout(()=>document.getElementById("chatText").focus(),50);
}
function onboardingPrompt(){
  return `Hey there, ${selectedCoach().label} here. Looks like you're new here.\n\nTell me a little bit about yourself so I can set up your calories tab:\n- current weight\n- height\n- age\n- how active your days usually are\n- target weight\n\nYou can write it casually, like "I'm 82 kg, 180 cm, 32, mostly desk work, and I want to get to 78 kg."\n\nYou can also edit this later in Personal info by clicking your name at the top.`;
}
function startOnboardingChat(){
  ONBOARDING_ACTIVE=true;
  renderCoachIdentity();
  coachOverlay.style.display="flex";
  document.getElementById("chatText").placeholder="Tell me your weight, height, age, activity, and target…";
  if(!CHAT_HISTORY.includes("onboarding-started")){
    CHAT_HISTORY.push("onboarding-started");
    addBubble("coach", onboardingPrompt());
  }
  setTimeout(()=>document.getElementById("chatText").focus(),50);
}
function closeCoach(){
  if(ONBOARDING_ACTIVE && profileIncomplete() && !CHAT_HISTORY.includes("onboarding-reminder")){
    CHAT_HISTORY.push("onboarding-reminder");
    addBubble("coach","It will be a better experience if the app knows a little bit about you. You can add or edit this later in the Personal info section by clicking your name at the top.");
  }
  coachOverlay.style.display="none";
}
document.getElementById("coachFab").addEventListener("click",openCoach);
document.getElementById("coachClose").addEventListener("click",closeCoach);
coachOverlay.addEventListener("click",e=>{ if(e.target===coachOverlay) closeCoach(); });

document.getElementById("chatPhotoBtn").addEventListener("click",()=>document.getElementById("chatPhoto").click());
function compressImage(file, maxDim, quality){
  return new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onerror=()=>reject(new Error("read failed"));
    reader.onload=()=>{
      const img=new Image();
      img.onerror=()=>reject(new Error("decode failed"));
      img.onload=()=>{
        let {width,height}=img;
        if(width>height && width>maxDim){ height=Math.round(height*maxDim/width); width=maxDim; }
        else if(height>=width && height>maxDim){ width=Math.round(width*maxDim/height); height=maxDim; }
        const canvas=document.createElement("canvas");
        canvas.width=width; canvas.height=height;
        const ctx=canvas.getContext("2d");
        ctx.drawImage(img,0,0,width,height);
        const dataUrl=canvas.toDataURL("image/jpeg", quality);
        resolve({ dataUrl, base64:dataUrl.split(",")[1], media:"image/jpeg" });
      };
      img.src=reader.result;
    };
    reader.readAsDataURL(file);
  });
}
document.getElementById("chatPhoto").addEventListener("change",async e=>{
  const f=e.target.files[0]; if(!f) return;
  const nameEl=document.getElementById("chatPhotoName");
  nameEl.textContent="Processing…";
  document.getElementById("chatPreviewWrap").style.display="flex";
  try{
    const {dataUrl, base64, media}=await compressImage(f, 1024, 0.8);
    QA_IMAGE=base64; QA_MEDIA=media;
    document.getElementById("chatPreview").src=dataUrl;
    const kb=Math.round(base64.length*0.75/1024);
    nameEl.textContent=`${f.name} (${kb} KB)`;
  }catch(err){
    // fall back to raw if canvas fails for some reason
    const reader=new FileReader();
    reader.onload=()=>{ QA_IMAGE=reader.result.split(",")[1]; QA_MEDIA=f.type||"image/jpeg";
      document.getElementById("chatPreview").src=reader.result; nameEl.textContent=f.name; };
    reader.readAsDataURL(f);
  }
});
document.getElementById("chatPhotoClear").addEventListener("click",()=>{
  QA_IMAGE=null; QA_MEDIA=null; document.getElementById("chatPhoto").value="";
  document.getElementById("chatPhotoName").textContent="";
  document.getElementById("chatPreviewWrap").style.display="none";
});

function addBubble(who, text, imgSrc){
  const thread=document.getElementById("chatThread");
  const wrap=document.createElement("div");
  const mine = who==="me";
  wrap.style.cssText=`display:flex; ${mine?'justify-content:flex-end':'justify-content:flex-start'}; gap:8px; align-items:flex-start`;
  if(!mine){
    const avatar=document.createElement("div");
    avatar.className="coachAvatar small";
    setAvatar(avatar, selectedCoach());
    wrap.appendChild(avatar);
  }
  const b=document.createElement("div");
  b.style.cssText=`max-width:80%; padding:10px 13px; border-radius:14px; font-size:14px; line-height:1.5; `
    +(mine?`background:var(--amber); color:#1a1205; border-bottom-right-radius:4px;`
          :`background:var(--panel2); color:var(--ink); border:1px solid var(--line); border-bottom-left-radius:4px;`);
  if(imgSrc){ const im=document.createElement("img"); im.src=imgSrc; im.style.cssText="max-width:160px; border-radius:8px; display:block; margin-bottom:6px"; b.appendChild(im); }
  if(text){
    const t=document.createElement("div");
    t.className="chatText";
    if(mine) t.textContent=text;
    else t.innerHTML=renderCoachText(text);
    b.appendChild(t);
  }
  wrap.appendChild(b); thread.appendChild(wrap);
  thread.scrollTop=thread.scrollHeight;
  return b;
}
function escapeHtml(value){
  return String(value).replace(/[&<>"']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[ch]));
}
function inlineCoachText(value){
  return escapeHtml(value).replace(/\*\*(.+?)\*\*/g,"<strong>$1</strong>");
}
function renderCoachText(text){
  const lines=String(text).replace(/\r\n/g,"\n").split("\n");
  let html="", list=null;
  const closeList=()=>{ if(list){ html+=`</${list}>`; list=null; } };
  lines.forEach(raw=>{
    const line=raw.trim();
    if(!line){ closeList(); return; }
    const bullet=line.match(/^[-*]\s+(.+)/);
    const numbered=line.match(/^\d+[.)]\s+(.+)/);
    if(bullet||numbered){
      const type=bullet?"ul":"ol";
      if(list!==type){ closeList(); html+=`<${type}>`; list=type; }
      html+=`<li>${inlineCoachText((bullet||numbered)[1])}</li>`;
      return;
    }
    closeList();
    html+=`<p>${inlineCoachText(line)}</p>`;
  });
  closeList();
  return html;
}
function addTyping(){
  const thread=document.getElementById("chatThread");
  const wrap=document.createElement("div"); wrap.id="typingBubble"; wrap.style.cssText="display:flex; justify-content:flex-start";
  wrap.innerHTML=`<div style="background:var(--panel2); border:1px solid var(--line); border-radius:14px; padding:11px 15px; color:var(--muted); font-size:13px">…</div>`;
  thread.appendChild(wrap); thread.scrollTop=thread.scrollHeight;
}
function removeTyping(){ const t=document.getElementById("typingBubble"); if(t) t.remove(); }

function dayContext(){
  // build a compact snapshot of today's numbers for the coach
  try{
    const p=profile(); const today=localDateString();
    // Oura API data must not be submitted to third-party AI services.
    const t=dayTotals(today,{includeOura:false});
    const proTarget=Math.round((p.weight_kg||0)*(p.protein_per_kg||2));
    const proEaten=Math.round(t.protein||0);
    const foods=(t.foods||[]).map(f=>f.name).join(", ")||"nothing yet";
    const trainedToday=entries().filter(e=>e.date===today).map(e=>e.kind==="cardio"?(e.activity||"cardio"):(e.type||"strength")).join(", ")||"no workout logged";
    return `Maintenance ${Math.round(t.maint)} kcal, workout burn ${Math.round(t.workout)} kcal, total out ${Math.round(t.out)} kcal. `
      +`Eaten ${Math.round(t.intake)} kcal so far (${t.net<0?Math.abs(Math.round(t.net))+' kcal under maintenance':Math.round(t.net)+' kcal over'}). `
      +`Protein ${proEaten}g of ${proTarget}g target (${Math.max(0,proTarget-proEaten)}g to go). `
      +`Today's food: ${foods}. Training today: ${trainedToday}. Goal: getting leaner while keeping muscle.`;
  }catch(e){ return ""; }
}

function historyContext(){
  // Compact, coach-useful summary of the full history (not raw sets) to keep tokens low.
  try{
    const all=entries();
    const strength=all.filter(e=>e.kind==="strength");
    const cardio=all.filter(e=>e.kind==="cardio");
    if(!all.length) return "No training history yet.";
    const firstDate=all[0].date, lastDate=all[all.length-1].date;

    // PR / progression for the main compound lifts (by e1RM)
    const keyLifts=["Bench Press","Squat","Deadlift","Incline Dumbbell Press","Seated Dumbbell Shoulder Press"];
    const liftBits=[];
    keyLifts.forEach(name=>{
      const s=exerciseSeries(name,"e1rm");
      if(s.length>=1){
        const start=Math.round(s[0].value*10)/10, recent=Math.round(s[s.length-1].value*10)/10;
        const best=Math.round(Math.max(...s.map(x=>x.value))*10)/10;
        const delta=Math.round((recent-start)*10)/10;
        liftBits.push(`${name}: e1RM ${start}→${recent}kg (${delta>=0?'+':''}${delta}, best ${best}, ${s.length} sessions)`);
      }
    });

    // training frequency + split balance
    const types={Push:0,Pull:0,Legs:0,Other:0};
    strength.forEach(s=>{ types[s.type]=(types[s.type]||0)+1; });
    const weeks=Math.max(1,(new Date(lastDate)-new Date(firstDate))/(86400000*7));
    const perWeek=(strength.length/weeks).toFixed(1);

    // weight trend
    const w=(STORE.weights||[]).slice().sort((a,b)=>a.date<b.date?-1:1);
    let weightBit="No weight logged.";
    if(w.length>=1){
      const latest=w[w.length-1].kg;
      if(w.length>=3){
        const avg=w.map((p,i)=>rollingAvg(w,i,7));
        const lastAvg=avg[avg.length-1];
        // rate vs ~7 days earlier
        const lastDateW=new Date(w[w.length-1].date); let refIdx=0;
        for(let i=0;i<w.length;i++){ if((lastDateW-new Date(w[i].date))/86400000<=7){ refIdx=i; break; } }
        const days=Math.max(1,(lastDateW-new Date(w[refIdx].date))/86400000);
        const rate=((avg[avg.length-1]-avg[refIdx])/days*7).toFixed(2);
        weightBit=`Weight ${latest}kg, 7-day avg ${lastAvg.toFixed(1)}kg, trend ${rate}kg/week.`;
      } else { weightBit=`Weight ${latest}kg (${w.length} weigh-in${w.length>1?'s':''} so far).`; }
    }

    // cardio recap
    let cardioBit="No cardio logged.";
    if(cardio.length){
      const last=cardio[cardio.length-1];
      const totDist=cardio.reduce((a,c)=>a+(c.distance_km||0),0).toFixed(1);
      cardioBit=`${cardio.length} cardio sessions, ${totDist}km total. Last: ${last.activity} ${last.distance_km||''}km${last.pace_min_km?' @ '+Math.floor(last.pace_min_km)+':'+String(Math.round((last.pace_min_km%1)*60)).padStart(2,'0')+'/km':''}.`;
    }

    return `[History ${firstDate}–${lastDate}] ${strength.length} strength sessions (~${perWeek}/week; Push ${types.Push}/Pull ${types.Pull}/Legs ${types.Legs}). `
      +`Main lifts — ${liftBits.join("; ")||"none with weights yet"}. `
      +`${weightBit} ${cardioBit}`;
  }catch(e){ return ""; }
}

async function chatSend(){
  const input=document.getElementById("chatText");
  const text=input.value.trim();
  if(!text && !QA_IMAGE){ return; }
  // user bubble (with image if present)
  const imgSrc = QA_IMAGE ? ("data:"+QA_MEDIA+";base64,"+QA_IMAGE) : null;
  addBubble("me", text, imgSrc);
  input.value="";
  const sentImage=QA_IMAGE, sentMedia=QA_MEDIA;
  document.getElementById("chatPhotoClear").click();
  addTyping();
  try{
    const res=await fetch("/api/parse",{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({idToken:ID_TOKEN, text, image:sentImage, mediaType:sentMedia, context:dayContext(), history:historyContext(), conversation:CHAT_CONTEXT.slice(-10), onboarding:ONBOARDING_ACTIVE, coachName:selectedCoach().label, localDate:localDateString()})});
    const j=await res.json();
    removeTyping();
    if(j.usage) recordAiUsage(j.usage);
    if(!j.ok){ addBubble("coach", j.error||"Hmm, I couldn't process that — try rephrasing?"); return; }
    const out=j.result||{};
    CHAT_CONTEXT.push({role:"user",text:text||"[Shared a photo]"});
    if(out.reply && out.reply.trim()) addBubble("coach", out.reply.trim());
    if(out.reply && out.reply.trim()) CHAT_CONTEXT.push({role:"coach",text:out.reply.trim()});
    if(CHAT_CONTEXT.length>12) CHAT_CONTEXT=CHAT_CONTEXT.slice(-12);
    if(out.log) showLogCard(out.log);
    if(!out.log && (!out.reply||!out.reply.trim())) addBubble("coach","I wasn't sure what you meant there — want to try again?");
  }catch(e){ removeTyping(); addBubble("coach","I couldn't reach the server just now. Check your connection and try again."); }
}
document.getElementById("chatSend").addEventListener("click",chatSend);
document.getElementById("chatText").addEventListener("keydown",e=>{ if(e.key==="Enter") chatSend(); });

// An inline, editable confirmation card placed in the chat thread
function showLogCard(r){
  const thread=document.getElementById("chatThread");
  const today=localDateString();
  const wrap=document.createElement("div"); wrap.style.cssText="display:flex; justify-content:flex-start";
  const box=document.createElement("div");
  box.style.cssText="max-width:90%; background:var(--panel2); border:1px solid var(--line); border-radius:14px; border-bottom-left-radius:4px; padding:12px 13px; font-size:13px";
  wrap.appendChild(box); thread.appendChild(wrap);

  function done(msg){
    saveStore(STORE);
    box.innerHTML=`<span style="color:var(--green); font-weight:650">✓ ${msg}</span>`;
    buildStrip(); buildSelect(); renderStrength(); rebuildDatalist();
    if(document.getElementById("view-cardio").classList.contains("on")) buildCardio();
    if(document.getElementById("view-calories").classList.contains("on")) renderCalories();
    thread.scrollTop=thread.scrollHeight;
  }

  if(r.kind==="weight"){
    const kg=Number(r.kg);
    const date=/^\d{4}-\d{2}-\d{2}$/.test(r.date||"") ? r.date : today;
    box.innerHTML=`<div style="font-weight:650; margin-bottom:8px">Weigh-in</div>
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-bottom:8px">
        <label style="font-size:11px;color:var(--muted)">Weight kg<input data-w="kg" type="number" min="20" max="400" step="0.1" value="${Number.isFinite(kg)?kg:''}" style="width:100%;margin-top:4px;background:var(--bg);border:1px solid var(--line);border-radius:6px;color:var(--ink);padding:7px"></label>
        <label style="font-size:11px;color:var(--muted)">Date<input data-w="date" type="date" value="${date}" style="width:100%;margin-top:4px;background:var(--bg);border:1px solid var(--line);border-radius:6px;color:var(--ink);padding:7px"></label>
      </div>
      <div style="display:flex; gap:8px; justify-content:flex-end; margin-top:6px"><button class="ghost" data-x="c">Skip</button><button class="primary" data-x="ok">Log weight</button></div>`;
    box.querySelector('[data-x="ok"]').onclick=()=>{
      const weight=parseFloat(box.querySelector('[data-w="kg"]').value);
      const weighDate=box.querySelector('[data-w="date"]').value;
      if(!Number.isFinite(weight)||weight<20||weight>400){ toast("Check the weight"); return; }
      if(!/^\d{4}-\d{2}-\d{2}$/.test(weighDate)){ toast("Check the date"); return; }
      STORE.weights=STORE.weights||[];
      const existing=STORE.weights.find(w=>w.date===weighDate);
      if(existing) existing.kg=weight; else STORE.weights.push({date:weighDate,kg:weight});
      done(`Logged ${weight.toFixed(1)} kg for ${fmtDate(weighDate)}`);
      renderWeight();
    };
  } else if(r.kind==="profile"){
    const activityOptions={sedentary:1.2,light:1.375,moderate:1.55,very:1.725};
    const activityLabel={sedentary:"Sedentary (desk)",light:"Lightly active",moderate:"Moderately active",very:"Very active"};
    const activity=(r.activity_level||"sedentary").toLowerCase();
    box.innerHTML=`<div style="font-weight:650; margin-bottom:8px">Profile setup</div>
      <div style="display:grid; grid-template-columns:repeat(2, minmax(0,1fr)); gap:8px; margin-bottom:8px">
        <label style="font-size:11px;color:var(--muted)">Weight kg<input data-p="weight" type="number" value="${r.weight_kg||''}" style="width:100%;margin-top:4px;background:var(--bg);border:1px solid var(--line);border-radius:6px;color:var(--ink);padding:7px"></label>
        <label style="font-size:11px;color:var(--muted)">Height cm<input data-p="height" type="number" value="${r.height_cm||''}" style="width:100%;margin-top:4px;background:var(--bg);border:1px solid var(--line);border-radius:6px;color:var(--ink);padding:7px"></label>
        <label style="font-size:11px;color:var(--muted)">Age<input data-p="age" type="number" value="${r.age||''}" style="width:100%;margin-top:4px;background:var(--bg);border:1px solid var(--line);border-radius:6px;color:var(--ink);padding:7px"></label>
        <label style="font-size:11px;color:var(--muted)">Target kg<input data-p="target" type="number" value="${r.target_weight_kg||''}" style="width:100%;margin-top:4px;background:var(--bg);border:1px solid var(--line);border-radius:6px;color:var(--ink);padding:7px"></label>
      </div>
      <div style="color:var(--muted); font-size:12px; margin-bottom:8px">Activity: <b style="color:var(--ink)">${activityLabel[activity]||activityLabel.sedentary}</b></div>
      <div style="display:flex; gap:8px; justify-content:flex-end; margin-top:6px"><button class="ghost" data-x="c">Skip</button><button class="primary" data-x="ok">Set up profile</button></div>`;
    box.querySelector('[data-x="ok"]').onclick=()=>{
      const weight=parseFloat(box.querySelector('[data-p="weight"]').value);
      const height=parseFloat(box.querySelector('[data-p="height"]').value);
      const age=parseInt(box.querySelector('[data-p="age"]').value,10);
      const targetWeight=parseFloat(box.querySelector('[data-p="target"]').value);
      if(!weight||!height||!age||!targetWeight){ toast("Check the profile numbers"); return; }
      applyWelcomeProfile({weight,height,age,activityMult:activityOptions[activity]||1.2,targetWeight});
      ONBOARDING_ACTIVE=false;
      done("Profile set up. Your calories tab is ready.");
    };
  } else if(r.kind==="food" && r.items && r.items.length){
    const rows=r.items.map((it,i)=>`<div style="display:flex; gap:6px; align-items:center; margin-bottom:6px">
      <input data-f="name" data-i="${i}" value="${(it.name||'').replace(/"/g,'&quot;')}" style="flex:1; min-width:80px; background:var(--bg); border:1px solid var(--line); border-radius:6px; color:var(--ink); padding:6px 8px; font-size:13px">
      <input data-f="kcal" data-i="${i}" type="number" value="${it.kcal||0}" style="width:62px; background:var(--bg); border:1px solid var(--line); border-radius:6px; color:var(--ink); padding:6px; font-size:13px">kcal
      <input data-f="p" data-i="${i}" type="number" value="${it.p||0}" style="width:48px; background:var(--bg); border:1px solid var(--line); border-radius:6px; color:var(--ink); padding:6px; font-size:13px">P</div>`).join("");
    box.innerHTML=`<div style="font-weight:650; margin-bottom:8px">🍽 Food → today</div>${rows}
      <div style="display:flex; gap:8px; justify-content:flex-end; margin-top:6px"><button class="ghost" data-x="c">Skip</button><button class="primary" data-x="ok">Add</button></div>`;
    box.querySelector('[data-x="ok"]').onclick=()=>{
      const items=r.items.map((it,i)=>({name:box.querySelector(`[data-f="name"][data-i="${i}"]`).value,
        kcal:parseFloat(box.querySelector(`[data-f="kcal"][data-i="${i}"]`).value)||0,
        p:parseFloat(box.querySelector(`[data-f="p"][data-i="${i}"]`).value)||0, c:it.c||0, fat:it.fat||0}));
      STORE.food=STORE.food||[];
      items.forEach(it=> STORE.food.push({_id:"f"+Date.now()+Math.random().toString(36).slice(2,6), date:today, ...it}));
      done("Added "+items.length+" item"+(items.length>1?"s":"")+" to today");
    };
  } else if(r.kind==="strength" && r.exercises && r.exercises.length){
    const summary=r.exercises.map(ex=>`${ex.name} — ${ex.sets.map(s=>`${s.reps}×${s.weight===0?'BW':s.weight}`).join(", ")}`).join("<br>");
    box.innerHTML=`<div style="font-weight:650; margin-bottom:8px">🏋 ${r.type||'Strength'} session → today</div>
      <div style="color:var(--muted); line-height:1.6">${summary}</div>
      <div style="display:flex; gap:8px; justify-content:flex-end; margin-top:8px"><button class="ghost" data-x="c">Skip</button><button class="primary" data-x="ok">Add session</button></div>`;
    box.querySelector('[data-x="ok"]').onclick=()=>{
      STORE.entries.push({kind:"strength", date:today, type:r.type||"Other",
        exercises:r.exercises.map(ex=>({name:ex.name, muscle:(MUSCLE[ex.name]||"Other"), sets:ex.sets}))});
      done((r.type||"Strength")+" session added");
    };
  } else if(r.kind==="cardio"){
    const pc = (r.distance_km&&r.duration_min)? (r.duration_min/r.distance_km):null;
    const desc=`${r.activity||'Cardio'}${r.distance_km?' · '+r.distance_km+'km':''}${r.duration_min?' · '+r.duration_min+'min':''}${r.calories?' · '+r.calories+'kcal':''}`;
    box.innerHTML=`<div style="font-weight:650; margin-bottom:8px">🏃 Cardio → today</div>
      <div style="color:var(--muted)">${desc}</div>
      <div style="display:flex; gap:8px; justify-content:flex-end; margin-top:8px"><button class="ghost" data-x="c">Skip</button><button class="primary" data-x="ok">Add</button></div>`;
    box.querySelector('[data-x="ok"]').onclick=()=>{
      const e={kind:"cardio", date:today, activity:r.activity||"Run"};
      if(r.distance_km) e.distance_km=r.distance_km; if(r.duration_min) e.duration_min=r.duration_min;
      if(pc) e.pace_min_km=pc; if(r.calories) e.calories=r.calories;
      STORE.entries.push(e); done((r.activity||"Cardio")+" added");
    };
  } else { box.innerHTML=`<span style="color:var(--muted)">Nothing to log there.</span>`; }

  const skip=box.querySelector('[data-x="c"]'); if(skip) skip.onclick=()=>{ box.innerHTML=`<span style="color:var(--faint)">Skipped.</span>`; };
  thread.scrollTop=thread.scrollHeight;
}

document.getElementById("importBtn").addEventListener("click",()=>{
  const box=document.getElementById("importBox");
  box.style.display = box.style.display==="none" ? "block" : "none";
});
function setImportGuide(open){
  const guide=document.getElementById("importGuide");
  const toggle=document.getElementById("importGuideToggle");
  guide.style.display=open?"block":"none";
  toggle.textContent=open?"Hide guide":"Show me how";
  toggle.setAttribute("aria-expanded",String(open));
}
document.getElementById("importGuideToggle").addEventListener("click",e=>{
  setImportGuide(e.currentTarget.getAttribute("aria-expanded")!=="true");
});
document.getElementById("importCancel").addEventListener("click",()=>{
  document.getElementById("importBox").style.display="none";
  document.getElementById("importText").value="";
  document.getElementById("workoutCsvFile").value="";
  setImportGuide(false);
});
document.getElementById("workoutCsvConfirm").addEventListener("click",async ()=>{
  const input=document.getElementById("workoutCsvFile");
  const file=input.files&&input.files[0];
  if(!file){ setSyncStatus("Choose a workout CSV first.","err"); return; }
  let result;
  try{ result=parseWorkoutCsv(await file.text()); }
  catch(e){ setSyncStatus(e.message||"Could not read that workout CSV.","err"); return; }
  STORE.entries=STORE.entries||[];
  const knownIds=new Set(STORE.entries.map(entry=>entry.importId).filter(Boolean));
  const additions=result.entries.filter(entry=>!knownIds.has(entry.importId));
  STORE.entries.push(...additions);
  STORE.seedImported=true;
  saveStore(STORE);
  input.value="";
  document.getElementById("importBox").style.display="none";
  buildStrip(); buildSelect(); renderStrength(); rebuildDatalist();
  if(document.getElementById("view-cardio").classList.contains("on")) buildCardio();
  if(document.getElementById("view-calories").classList.contains("on")) renderCalories();
  const duplicates=result.entries.length-additions.length;
  const details=[`${additions.length} workout${additions.length===1?'':'s'} imported`];
  if(duplicates) details.push(`${duplicates} already present`);
  if(result.skippedRows) details.push(`${result.skippedRows} unsupported row${result.skippedRows===1?'':'s'} skipped`);
  setSyncStatus(details.join(" · ")+". Saving to your account…","wait");
  await pushNow();
  setSyncStatus(details.join(" · ")+" ✓","ok");
});
function workoutFingerprint(entry){
  const value=JSON.stringify({date:entry.date,type:entry.type,name:entry.name,exercises:entry.exercises});
  let hash=2166136261;
  for(let i=0;i<value.length;i++){ hash^=value.charCodeAt(i); hash=Math.imul(hash,16777619); }
  return `ai-workout:${(hash>>>0).toString(36)}`;
}
document.getElementById("workoutAiConfirm").addEventListener("click",async ()=>{
  const input=document.getElementById("workoutCsvFile");
  const file=input.files&&input.files[0];
  if(!file){ setSyncStatus("Choose a workout export first.","err"); return; }
  if(file.size>250000){ setSyncStatus("AI import supports files up to 250 KB.","err"); return; }
  const extension=(file.name.split(".").pop()||"").toLowerCase();
  if(!["csv","tsv","json","txt"].includes(extension)){ setSyncStatus("AI import currently supports CSV, TSV, JSON, and TXT files.","err"); return; }
  setSyncStatus("AI is reading and converting the workout file…","wait");
  let response;
  try{
    response=await fetch("/api/import-workouts",{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({idToken:ID_TOKEN,fileName:file.name,fileText:await file.text()})});
  }catch(e){ setSyncStatus("Could not reach the AI importer.","err"); return; }
  const result=await response.json().catch(()=>({ok:false,error:"Invalid response from the AI importer."}));
  if(result.usage) recordAiUsage(result.usage);
  if(!result.ok){ setSyncStatus(result.error||"The AI could not import this file.","err"); return; }
  STORE.entries=STORE.entries||[];
  result.entries.forEach(entry=>{ entry.importId=workoutFingerprint(entry); });
  const knownIds=new Set(STORE.entries.map(entry=>entry.importId).filter(Boolean));
  const additions=result.entries.filter(entry=>!knownIds.has(entry.importId));
  STORE.entries.push(...additions);
  STORE.seedImported=true;
  saveStore(STORE);
  input.value="";
  document.getElementById("importBox").style.display="none";
  buildStrip(); buildSelect(); renderStrength(); rebuildDatalist();
  if(document.getElementById("view-cardio").classList.contains("on")) buildCardio();
  if(document.getElementById("view-calories").classList.contains("on")) renderCalories();
  const duplicates=result.entries.length-additions.length;
  const details=[`${additions.length} workout${additions.length===1?'':'s'} imported by AI`];
  if(duplicates) details.push(`${duplicates} already present`);
  if(result.warnings&&result.warnings.length) details.push(result.warnings[0]);
  setSyncStatus(details.join(" · ")+". Saving…","wait");
  await pushNow();
  setSyncStatus(details.join(" · ")+" ✓","ok");
});
document.getElementById("importConfirm").addEventListener("click",async ()=>{
  const raw=document.getElementById("importText").value.trim();
  if(!raw){ setSyncStatus("Paste your JSON first.","err"); return; }
  let parsed;
  try{ parsed=JSON.parse(raw); }catch(e){ setSyncStatus("That isn't valid JSON — check you copied the whole cell.","err"); return; }
  if(!parsed.entries && !parsed.weights && !parsed.food && !parsed.aiUsage){ setSyncStatus("JSON loaded but has no entries/weights/food/aiUsage — is this the right data?","err"); return; }
  // load into STORE and persist + push to the sheet
  applyPayload(parsed);
  STORE.seedImported=true;
  FIRST_PULL_DONE=true;
  try{ localStorage.setItem(LS_KEY, JSON.stringify(STORE)); }catch(e){}
  document.getElementById("importBox").style.display="none";
  document.getElementById("importText").value="";
  setSyncStatus("Imported — saving to your account…","wait");
  await pushNow();
  // refresh all views
  buildStrip(); buildSelect(); renderStrength(); rebuildDatalist();
  if(document.getElementById("view-cardio").classList.contains("on")) buildCardio();
  if(document.getElementById("view-calories").classList.contains("on")) renderCalories();
  setSyncStatus("Imported and saved ✓","ok");
});
document.getElementById("signOutBtn").addEventListener("click",()=>{
  syncModal.style.display="none";
  try{ google.accounts.id.disableAutoSelect(); }catch(e){}
  requireSignIn();
});

rebuildDatalist();
renderCoachIdentity();
buildStrip();
buildSelect();
renderStrength();

// Auth init: try to restore a session token, else show sign-in
(function initAuth(){
  const saved=sessionStorage.getItem("idtoken");
  if(saved){
    ID_TOKEN=saved;
    try{ const p=JSON.parse(atob(saved.split(".")[1]));
      // basic expiry check
      if(p.exp && p.exp*1000>Date.now()){ CURRENT_USER={email:p.email,name:p.name||p.email}; showApp(); pullNow().finally(handleOuraReturn); return; }
    }catch(e){}
  }
  initGoogle();
})();
