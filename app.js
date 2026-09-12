const $ = (id) => document.getElementById(id);

const urlInput = $("urlInput");
const analyzeBtn = $("analyzeBtn");
const pasteBtn = $("pasteBtn");
const clearBtn = $("clearBtn");
const result = $("result");
const errorPanel = $("error");
const errorText = $("errorText");
const filenameEl = $("filename");
const metaEl = $("meta");
const downloadBtn = $("downloadBtn");
const copySourceBtn = $("copySourceBtn");
const scanPanel = $("scanPanel");
const scanStatus = $("scanStatus");
const scanPercent = $("scanPercent");
const scanBar = $("scanBar");
const networkState = $("networkState");
const historyGrid = $("historyGrid");
const historyEmpty = $("historyEmpty");
const clearHistoryBtn = $("clearHistoryBtn");
const themeGlowBtn = $("themeGlowBtn");
const toast = $("toast");

let currentSource = "";
let scanTimer = null;
const HISTORY_KEY = "neonfetch-x-history-v2";

$("year").textContent = new Date().getFullYear();
$("clientType").textContent = /Mobi|Android/i.test(navigator.userAgent) ? "MOBILE" : "WEB";

function formatBytes(n){
  if(!n) return "size unknown";
  const units=["B","KB","MB","GB"];
  let i=0,v=n;
  while(v>=1024 && i<units.length-1){v/=1024;i++}
  return `${v.toFixed(v>=10||i===0?0:1)} ${units[i]}`;
}

function showToast(message){
  toast.textContent = message;
  toast.classList.add("show");
  window.clearTimeout(showToast._t);
  showToast._t = window.setTimeout(() => toast.classList.remove("show"), 1800);
}

function setInputButtons(){
  clearBtn.classList.toggle("hidden", !urlInput.value.trim());
}

function hideOutput(){
  result.classList.add("hidden");
  errorPanel.classList.add("hidden");
}

function showError(message){
  result.classList.add("hidden");
  errorText.textContent = message;
  errorPanel.classList.remove("hidden");
  networkState.textContent = "BLOCKED";
  networkState.style.color = "#ff8798";
}

function showResult(data){
  errorPanel.classList.add("hidden");
  filenameEl.textContent = data.filename;
  metaEl.textContent = `${data.contentType} • ${formatBytes(data.size)}`;
  downloadBtn.href = data.downloadUrl;
  result.classList.remove("hidden");
  networkState.textContent = "READY";
  networkState.style.color = "#b8c7df";
}

function resetScan(){
  clearInterval(scanTimer);
  scanPanel.classList.add("hidden");
  scanBar.style.width = "0%";
  scanPercent.textContent = "0%";
  document.querySelectorAll(".scan-steps span").forEach(s => s.classList.remove("active","done"));
}

function beginScanAnimation(){
  clearInterval(scanTimer);
  scanPanel.classList.remove("hidden");
  const phases = [
    {p:14, t:"Parsing source URL...", step:1},
    {p:34, t:"Resolving and validating host...", step:2},
    {p:58, t:"Inspecting remote media headers...", step:3},
    {p:78, t:"Validating content stream...", step:3},
    {p:92, t:"Building secure download route...", step:4}
  ];
  let index = 0;
  const apply = () => {
    if(index >= phases.length) return;
    const x = phases[index++];
    scanBar.style.width = `${x.p}%`;
    scanPercent.textContent = `${x.p}%`;
    scanStatus.textContent = x.t;
    document.querySelectorAll(".scan-steps span").forEach((el, i) => {
      const n=i+1;
      el.classList.toggle("done", n < x.step);
      el.classList.toggle("active", n === x.step);
    });
  };
  apply();
  scanTimer = setInterval(apply, 420);
}

function finishScan(success=true){
  clearInterval(scanTimer);
  scanBar.style.width = "100%";
  scanPercent.textContent = "100%";
  scanStatus.textContent = success ? "Inspection complete. Media route ready." : "Inspection terminated.";
  document.querySelectorAll(".scan-steps span").forEach(el => {
    el.classList.remove("active");
    if(success) el.classList.add("done");
  });
  setTimeout(() => scanPanel.classList.add("hidden"), success ? 700 : 1100);
}

function loadHistory(){
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]"); }
  catch { return []; }
}

function saveHistoryItem(item){
  const existing = loadHistory().filter(x => x.url !== item.url);
  existing.unshift(item);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(existing.slice(0,6)));
  renderHistory();
}

function renderHistory(){
  const items = loadHistory();
  historyGrid.innerHTML = "";
  historyEmpty.classList.toggle("hidden", items.length > 0);
  clearHistoryBtn.classList.toggle("hidden", items.length === 0);
  items.forEach(item => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "history-card";
    card.innerHTML = `
      <div class="h-top"><span class="h-type">${escapeHtml((item.type||"MEDIA").split(";")[0].toUpperCase())}</span><span class="h-time">${escapeHtml(item.time||"")}</span></div>
      <strong>${escapeHtml(item.filename||"media")}</strong>
      <p>${escapeHtml(item.url||"")}</p>`;
    card.addEventListener("click", () => {
      urlInput.value = item.url;
      setInputButtons();
      document.getElementById("engine").scrollIntoView({behavior:"smooth",block:"center"});
      showToast("SOURCE RESTORED");
    });
    historyGrid.appendChild(card);
  });
}

function escapeHtml(s){
  return String(s).replace(/[&<>'"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c]));
}

async function analyze(){
  const url = urlInput.value.trim();
  if(!url){ showError("Paste a direct media-file URL first."); return; }

  hideOutput();
  currentSource = url;
  analyzeBtn.disabled = true;
  analyzeBtn.querySelector("b").textContent = "SCANNING SOURCE";
  networkState.textContent = "SCANNING";
  networkState.style.color = "#75eafa";
  beginScanAnimation();

  try{
    const response = await fetch("/api/inspect", {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({url})
    });
    const data = await response.json();
    if(!response.ok || !data.ok) throw new Error(data.error || "Could not inspect this URL.");
    finishScan(true);
    window.setTimeout(() => showResult(data), 260);
    saveHistoryItem({
      url,
      filename:data.filename,
      type:data.contentType,
      time:new Date().toLocaleString([], {month:"short",day:"2-digit",hour:"2-digit",minute:"2-digit"})
    });
  }catch(err){
    finishScan(false);
    showError(err.message || "Something went wrong while inspecting the media source.");
  }finally{
    analyzeBtn.disabled = false;
    analyzeBtn.querySelector("b").textContent = "INITIALIZE SCAN";
  }
}

analyzeBtn.addEventListener("click", analyze);
urlInput.addEventListener("keydown", e => { if(e.key === "Enter") analyze(); });
urlInput.addEventListener("input", setInputButtons);

pasteBtn.addEventListener("click", async () => {
  try{
    const text = await navigator.clipboard.readText();
    urlInput.value = text.trim();
    setInputButtons();
    urlInput.focus();
    showToast("PASTED FROM CLIPBOARD");
  }catch{
    showError("Clipboard access was blocked by the browser. Paste the URL manually.");
  }
});

clearBtn.addEventListener("click", () => {
  urlInput.value = "";
  currentSource = "";
  hideOutput();
  resetScan();
  setInputButtons();
  urlInput.focus();
});

copySourceBtn.addEventListener("click", async () => {
  try{
    await navigator.clipboard.writeText(currentSource || urlInput.value.trim());
    showToast("SOURCE COPIED");
  }catch{ showToast("COPY BLOCKED"); }
});

downloadBtn.addEventListener("click", () => showToast("DOWNLOAD ROUTE OPENED"));

clearHistoryBtn.addEventListener("click", () => {
  localStorage.removeItem(HISTORY_KEY);
  renderHistory();
  showToast("LOCAL HISTORY CLEARED");
});

themeGlowBtn.addEventListener("click", () => {
  document.body.classList.toggle("low-glow");
  localStorage.setItem("neonfetch-low-glow", document.body.classList.contains("low-glow") ? "1" : "0");
  showToast(document.body.classList.contains("low-glow") ? "GLOW REDUCED" : "GLOW ENHANCED");
});
if(localStorage.getItem("neonfetch-low-glow") === "1") document.body.classList.add("low-glow");

// Futuristic particle field (purely decorative, lightweight)
(function particles(){
  const canvas = $("particleCanvas");
  const ctx = canvas.getContext("2d");
  let width=0,height=0,dpr=1,points=[];
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  function resize(){
    dpr=Math.min(window.devicePixelRatio||1,2); width=innerWidth; height=innerHeight;
    canvas.width=width*dpr; canvas.height=height*dpr; canvas.style.width=width+"px"; canvas.style.height=height+"px";
    ctx.setTransform(dpr,0,0,dpr,0,0);
    const count=Math.max(18,Math.min(62,Math.floor(width/26)));
    points=Array.from({length:count},()=>({x:Math.random()*width,y:Math.random()*height,vx:(Math.random()-.5)*.12,vy:(Math.random()-.5)*.12,r:Math.random()*1.25+.35}));
  }
  function frame(){
    ctx.clearRect(0,0,width,height);
    for(const p of points){
      if(!reduced){p.x+=p.vx;p.y+=p.vy;if(p.x<0)p.x=width;if(p.x>width)p.x=0;if(p.y<0)p.y=height;if(p.y>height)p.y=0;}
      ctx.beginPath();ctx.arc(p.x,p.y,p.r,0,Math.PI*2);ctx.fillStyle="rgba(111,232,255,.34)";ctx.fill();
    }
    for(let i=0;i<points.length;i++) for(let j=i+1;j<points.length;j++){
      const a=points[i],b=points[j],dx=a.x-b.x,dy=a.y-b.y,d=Math.hypot(dx,dy);
      if(d<115){ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.strokeStyle=`rgba(91,173,255,${(1-d/115)*.07})`;ctx.lineWidth=.6;ctx.stroke();}
    }
    requestAnimationFrame(frame);
  }
  addEventListener("resize",resize,{passive:true}); resize(); frame();
})();

renderHistory();
setInputButtons();
