function parseMoney(s){ const n=parseInt(String(s||'').replace(/[^\d]/g,''),10); return isNaN(n)?0:n; }

// витягуємо ціну з тексту прев'ю: "1 250 грн", "₴1250", "3200 UAH", "від 4500 грн"
function extractPrice(t){
  const s=String(t||'');
  let m=s.match(/(?:₴|UAH)\s*([\d][\d\s.,]{1,9}\d|\d)/i);
  if(m){ const n=m[1].replace(/[\s.,]/g,''); if(n) return n+' грн'; }
  m=s.match(/([\d][\d\s.,]{1,9}\d|\d)\s*(?:грн|₴|uah|грн\.|гривень)/i);
  if(m){ const n=m[1].replace(/[\s.,]/g,''); if(n) return n+' грн'; }
  return '';
}

// винесено з renderBudget: planned/paid/remaining + перевищення бюджетної стелі
function computeBudgetTotals(items, cap){
  const planned=items.reduce((s,b)=>s+(Number(b.planned)||0),0);
  const paid=items.reduce((s,b)=>s+(Number(b.paid)||0),0);
  const remaining=planned-paid;
  const capNum=Number(cap)||0;
  const capDiff=capNum>0?capNum-planned:null;   // null = стелю не задано
  return {planned, paid, remaining, capDiff};
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseMoney, extractPrice, computeBudgetTotals };
}
