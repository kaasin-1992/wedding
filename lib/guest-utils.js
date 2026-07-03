const NICK_GROUPS=[
  ['олександр','саша','сашко','санько','алекс'],
  ['олександра','сашка','леся'],
  ['катерина','катя','катруся','катеринка'],
  ['олена','оленка','аленка'],
  ['ольга','оля'],
  ['михайло','міша','мишко'],
  ['дмитро','діма','дмитрик'],
  ['володимир','вова','володя','вовка'],
  ['наталія','наталя','наташа','ната'],
  ['анна','аня','анничка'],
  ['марія','маша','маруся'],
  ['іван','ваня','іванко'],
  ['юлія','юля','юлька'],
  ['тетяна','таня','танюша'],
  ['ірина','іра','іринка'],
  ['сергій','сергійко','сєрьожа'],
  ['андрій','андрійко'],
  ['вікторія','віка'],
  ['євген','женя','жека'],
  ['артем','тьома','артемко'],
  ['назар','назарко'],
  ['богдан','бодя'],
  ['софія','соня','софійка'],
  ['дарина','даша','даря','даринка'],
  ['христина','христя'],
  ['роман','рома','ромчик'],
  ['петро','петрик','петя'],
  ['василь','вася','васько'],
  ['микола','коля','миколка'],
  ['григорій','гриша','грицько'],
  ['павло','паша','павлик'],
  ['денис','деня'],
  ['максим','макс','максимко'],
  ['людмила','люда','люся'],
  ['валентина','валя'],
  ['валерій','валера'],
  ['станіслав','стас'],
  ['ярослав','ярік','слава'],
  ['владислав','влад'],
  ['віталій','віталік'],
  ['олег','олежко'],
  ['ігор','ігорьок'],
  ['юрій','юра','юрко'],
];
const NICK_MAP=(()=>{const m={};NICK_GROUPS.forEach((g,i)=>g.forEach(n=>{if(m[n]===undefined)m[n]=i;}));return m;})();
function normName(s){ return String(s||'').toLowerCase().replace(/[ʼ'’`.,!?]/g,'').replace(/\s+/g,' ').trim(); }
function canon(tok){ return NICK_MAP[tok]!==undefined ? 'g'+NICK_MAP[tok] : tok; }
function lev(a,b){
  const m=a.length,n=b.length; if(!m)return n; if(!n)return m;
  let prev=Array.from({length:n+1},(_,i)=>i);
  for(let i=1;i<=m;i++){ const cur=[i];
    for(let j=1;j<=n;j++){ cur[j]=Math.min(prev[j]+1,cur[j-1]+1,prev[j-1]+(a[i-1]===b[j-1]?0:1)); }
    prev=cur;
  }
  return prev[n];
}
function similarTok(a,b){
  if(!a||!b)return false;
  if(a===b)return true;
  const min=Math.min(a.length,b.length);
  if(min>=3&&(a.startsWith(b)||b.startsWith(a)))return true;
  const mx=Math.max(a.length,b.length);
  return mx>0 && (1-lev(a,b)/mx)>=0.8;
}
// guestList передається явно (раніше замикалась на глобальний `guests`), щоб функція була тестованою
function findDuplicateGuest(name, guestList){
  const inFull=normName(name), inFirst=inFull.split(' ')[0], inCanon=canon(inFirst);
  for(const g of guestList){
    const exFull=normName(g.name), exFirst=exFull.split(' ')[0];
    if(exFull===inFull) return g.name;
    if(canon(exFirst)===inCanon) return g.name;
    if(similarTok(inFirst,exFirst)) return g.name;
  }
  return null;
}

const headCount=g=>1+(g.plus1==='confirmed'?1:0)+(Number(g.kids)||0);
const totalPeople=guestList=>guestList.filter(g=>g.status!=='declined').reduce((s,g)=>s+headCount(g),0);
const peopleAt=(guestList,ev)=>guestList.filter(g=>g.status!=='declined'&&(g.event===ev||g.event==='both')).reduce((s,g)=>s+headCount(g),0);

function applyFilter(g,f){
  if(f==='all')return true;
  if(f==='her')return g.side==='her';
  if(f==='his')return g.side==='his';
  if(f==='family')return (g.group||'friends')==='family';
  if(f==='friends')return (g.group||'friends')==='friends';
  if(f==='ceremony')return g.event==='ceremony'||g.event==='both';
  if(f==='party')return g.event==='party'||g.event==='both';
  if(f==='plus1')return g.plus1!=='none';
  if(f==='maybe')return !!g.maybe;
  if(f==='backup')return !!g.backup;
  if(f==='wparty')return !!g.wparty;
  if(f==='pending')return g.status==='pending';
  return true;
}
/* порядок у списку: підтверджені → запрошені → під питанням → запасні → відмовили */
function guestRank(g){
  if(g.status==='confirmed') return 0;
  if(g.status==='declined')  return 4;
  if(g.backup)               return 3;
  if(g.maybe)                return 2;
  return 1;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { NICK_GROUPS, NICK_MAP, normName, canon, lev, similarTok, findDuplicateGuest, headCount, totalPeople, peopleAt, applyFilter, guestRank };
}
