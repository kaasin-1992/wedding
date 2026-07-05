const today = () => new Date(new Date().toDateString());
const daysUntil = s => s ? Math.ceil((new Date(s) - today()) / 86400000) : null;
// WEDDING - глобальна const, яку в браузері визначає index.html (перший рядок
// інлайнового скрипта), а в тестах треба виставити вручну через globalThis
// перед викликом daysUntilWedding().
const daysUntilWedding = () => Math.ceil((WEDDING - today()) / 86400000);

function getStatus(t){
  if(t.done) return'done';
  if(t.asap&&!t.deadline) return'asap';
  const d=daysUntil(t.deadline);
  if(d===null) return'ok';
  if(d<0||d<=7) return'hot';
  if(d<=21) return'warn';
  return'ok';
}

function plDays(n){ const a=n%100, b=n%10; if(a>10&&a<20)return'днів'; if(b===1)return'день'; if(b>=2&&b<=4)return'дні'; return'днів'; }
function timeMask(v){ const d=String(v||'').replace(/\D/g,'').slice(0,4); return d.length>2?d.slice(0,2)+':'+d.slice(2):d; }
function timeNorm(v){ const m=/^(\d{1,2}):?(\d{2})$/.exec(String(v||'').trim()); if(!m)return''; const h=+m[1],mn=+m[2]; if(h>23||mn>59)return''; return String(h).padStart(2,'0')+':'+String(mn).padStart(2,'0'); }

// БЕЗПЕКА: те, що прилітає гостю (?guest) з Firestore-снапшота, ніколи не повинно
// лишатись у пам'яті/localStorage гостя повністю — раніше лише рендер ховав бюджет,
// а самі дані все одно летіли в браузер і осідали в localStorage. Викликається лише коли IS_GUEST.
function stripGuestData(state){
  return {
    budget: [],
    tasks: state.tasks||[],
    scriptSofia: state.scriptSofia||[],
    scriptWave: state.scriptWave||[],
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { today, daysUntil, daysUntilWedding, getStatus, plDays, timeMask, timeNorm, stripGuestData };
}
