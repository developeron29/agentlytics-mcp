// Served at GET /t.js. Usage: <script defer src="https://YOUR-WORKER/t.js"></script>
export const TRACKER_JS = `(()=>{
var s=document.currentScript;if(!s)return
var ep=new URL("/collect",s.src).href;
function send(t,n,p){
var b=JSON.stringify({t:t,n:n,u:location.href,r:document.referrer,p:p});
if(navigator.sendBeacon&&navigator.sendBeacon(ep,b))return;
fetch(ep,{method:"POST",body:b,keepalive:true}).catch(function(){});
}
var last;function pv(){if(location.href===last)return;last=location.href;send("pageview");}
var hp=history.pushState;history.pushState=function(){hp.apply(this,arguments);pv();};
addEventListener("popstate",pv);
window.agentlytics={track:function(n,p){send("event",n,p);}};
function mark(e){var t=e.target,el=t&&t.closest&&t.closest("[data-agentlytics-event]");if(!el||(e.type==="click"&&el.tagName==="FORM"))return;var n=el.getAttribute("data-agentlytics-event"),p;if(!n)return;try{p=JSON.parse(el.getAttribute("data-agentlytics-props")||"")}catch(_){}window.agentlytics.track(n,p);}
document.addEventListener("click",mark,true);document.addEventListener("submit",mark,true);
pv();
})();`;
