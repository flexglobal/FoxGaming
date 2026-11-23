/* Mono Chess — chess rules without external dependencies. MIT license, created for this project. */
(function(global){
'use strict';
const initial='rnbqkbnrpppppppp................................PPPPPPPPRNBQKBNR';
const ROW=i=>Math.floor(i/8), COL=i=>i%8;
const white=p=>!!p&&p!=='.'&&p===p.toUpperCase();
const pieceSide=p=>p==='.'?null:white(p)?'w':'b';
const enemy=s=>s==='w'?'b':'w';
const within=(r,c)=>r>=0&&r<8&&c>=0&&c<8;
const idx=(r,c)=>r*8+c;
const coord=i=>'abcdefgh'[COL(i)]+String(8-ROW(i));
const fromCoord=t=>{if(!/^[a-h][1-8]$/.test(t))return -1;return (8-Number(t[1]))*8+t.charCodeAt(0)-97};
const offsetsK=[[1,1],[1,0],[1,-1],[0,1],[0,-1],[-1,1],[-1,0],[-1,-1]];
const offsetsN=[[2,1],[2,-1],[-2,1],[-2,-1],[1,2],[1,-2],[-1,2],[-1,-2]];
const diagonal=[[1,1],[1,-1],[-1,1],[-1,-1]];
const ortho=[[1,0],[-1,0],[0,1],[0,-1]];
function start(){return {b:initial.split(''),turn:'w',castle:'KQkq',ep:-1,half:0,full:1,counts:Object.create(null),last:null}}
function attacked(s,sq,by){
  const b=s.b,r=ROW(sq),c=COL(sq),pawn=by==='w'?'P':'p',pr=r+(by==='w'?1:-1);
  for(let d of [-1,1])if(within(pr,c+d)&&b[idx(pr,c+d)]===pawn)return true;
  for(const [dr,dc] of offsetsN){const rr=r+dr,cc=c+dc;if(within(rr,cc)&&b[idx(rr,cc)]===(by==='w'?'N':'n'))return true}
  for(const [dr,dc] of offsetsK){const rr=r+dr,cc=c+dc;if(within(rr,cc)&&b[idx(rr,cc)]===(by==='w'?'K':'k'))return true}
  for(const [dirs,ps] of [[diagonal,['b','q']],[ortho,['r','q']]]){
    for(const [dr,dc] of dirs){let rr=r+dr,cc=c+dc;while(within(rr,cc)){
      const p=b[idx(rr,cc)];if(p!=='.'){if(pieceSide(p)===by&&ps.includes(p.toLowerCase()))return true;break}rr+=dr;cc+=dc;
    }}
  }
  return false;
}
function inCheck(s,side){const i=s.b.indexOf(side==='w'?'K':'k');return i<0||attacked(s,i,enemy(side))}
function pseudo(s,side=s.turn){
 const b=s.b,moves=[];const push=(from,to,extra={})=>moves.push({from,to,...extra});
 for(let i=0;i<64;i++){const p=b[i];if(pieceSide(p)!==side)continue;
  const kind=p.toLowerCase(),r=ROW(i),c=COL(i);
  if(kind==='p'){
    const dir=side==='w'?-1:1,promo=side==='w'?0:7,startRow=side==='w'?6:1;
    const forward=r+dir;if(within(forward,c)&&b[idx(forward,c)]==='.'){
      if(forward===promo)for(const promote of ['q','r','b','n'])push(i,idx(forward,c),{promote});
      else push(i,idx(forward,c));
      const r2=r+dir*2;if(r===startRow&&b[idx(r2,c)]==='.')push(i,idx(r2,c),{double:true});
    }
    for(const dc of [-1,1]){const cc=c+dc;if(!within(forward,cc))continue;const dst=idx(forward,cc);const tgt=b[dst];
      if(tgt!=='.'&&pieceSide(tgt)===enemy(side)&&tgt.toLowerCase()!=='k'){
        if(forward===promo)for(const promote of ['q','r','b','n'])push(i,dst,{promote}); else push(i,dst);
      }else if(dst===s.ep&&tgt==='.'){const capture=idx(r,cc);if(b[capture]===(side==='w'?'p':'P'))push(i,dst,{enpassant:true})}
    }
  }else if(kind==='n'||kind==='k'){
    for(const [dr,dc] of (kind==='n'?offsetsN:offsetsK)){const rr=r+dr,cc=c+dc;if(!within(rr,cc))continue;const target=idx(rr,cc);const piece=b[target];if(piece==='.'||(pieceSide(piece)===enemy(side)&&piece.toLowerCase()!=='k'))push(i,target)}
    if(kind==='k'&&!inCheck(s,side)){
      const home=side==='w'?60:4,rank=ROW(home),enemySide=enemy(side);
      if(i===home){
        if(s.castle.includes(side==='w'?'K':'k')&&b[idx(rank,7)]===(side==='w'?'R':'r')&&b[home+1]==='.'&&b[home+2]==='.'&&!attacked(s,home+1,enemySide)&&!attacked(s,home+2,enemySide))push(i,home+2,{castle:'k'});
        if(s.castle.includes(side==='w'?'Q':'q')&&b[idx(rank,0)]===(side==='w'?'R':'r')&&b[home-1]==='.'&&b[home-2]==='.'&&b[home-3]==='.'&&!attacked(s,home-1,enemySide)&&!attacked(s,home-2,enemySide))push(i,home-2,{castle:'q'});
      }
    }
  }else {
    const dirs=kind==='b'?diagonal:kind==='r'?ortho:[...diagonal,...ortho];
    for(const [dr,dc] of dirs){let rr=r+dr,cc=c+dc;while(within(rr,cc)){
      const target=idx(rr,cc),tgt=b[target];if(tgt==='.')push(i,target);else {if(pieceSide(tgt)===enemy(side)&&tgt.toLowerCase()!=='k')push(i,target);break}rr+=dr;cc+=dc;
    }}
  }
 }
 return moves;
}
function apply(s,m,real=false){
 const b=s.b.slice(),piece=b[m.from],side=pieceSide(piece),target=b[m.to];b[m.from]='.';b[m.to]=m.promote?(side==='w'?m.promote.toUpperCase():m.promote):piece;
 if(m.enpassant)b[m.to+(side==='w'?8:-8)]='.';
 if(m.castle){const r=ROW(m.from);if(m.castle==='k'){b[idx(r,5)]=b[idx(r,7)];b[idx(r,7)]='.'}else{b[idx(r,3)]=b[idx(r,0)];b[idx(r,0)]='.'}}
 let rights=s.castle;
 if(piece==='K')rights=rights.replace(/[KQ]/g,''); if(piece==='k')rights=rights.replace(/[kq]/g,'');
 if(m.from===63||m.to===63)rights=rights.replace('K','');if(m.from===56||m.to===56)rights=rights.replace('Q','');
 if(m.from===7||m.to===7)rights=rights.replace('k','');if(m.from===0||m.to===0)rights=rights.replace('q','');
 const ep=m.double?(m.from+m.to)/2:-1,half=(piece.toLowerCase()==='p'||target!=='.'||m.enpassant)?0:s.half+1;
 const next={b,turn:enemy(side),castle:rights,ep,half,full:s.full+(side==='b'?1:0),counts:real?{...s.counts}:s.counts,last:{from:m.from,to:m.to}};
 if(real){const key=signature(next);next.counts[key]=(next.counts[key]||0)+1}
 return next;
}
function legal(s){const side=s.turn;return pseudo(s,side).filter(m=>!inCheck(apply(s,m),side))}
function signature(s){return s.b.join('')+' '+s.turn+' '+s.castle+' '+s.ep}
function insufficient(s){const active=s.b.map((p,i)=>({p,i})).filter(v=>v.p!=='.'&&!['K','k'].includes(v.p));if(!active.length)return true;if(active.length===1&&'bn'.includes(active[0].p.toLowerCase()))return true;
 if(active.length===2&&active.every(v=>v.p.toLowerCase()==='b')&&((ROW(active[0].i)+COL(active[0].i))%2)==((ROW(active[1].i)+COL(active[1].i))%2))return true;
 return false;
}
function outcome(s){const ms=legal(s);if(!ms.length)return inCheck(s,s.turn)?{over:true,winner:enemy(s.turn),reason:'Мат'}:{over:true,winner:null,reason:'Пат'};
 if(s.half>=100)return {over:true,winner:null,reason:'Правило 50 ходов'};
 if((s.counts[signature(s)]||0)>=3)return {over:true,winner:null,reason:'Троекратное повторение'};
 if(insufficient(s))return {over:true,winner:null,reason:'Недостаточно материала'};
 return {over:false,winner:null,reason:inCheck(s,s.turn)?'Шах':''};
}
function move(s,from,to,promotion='q'){
 const candidates=legal(s).filter(m=>m.from===from&&m.to===to), m=candidates.find(m=>m.promote===promotion)||candidates.find(m=>!m.promote);
 return m?{state:apply(s,m,true),move:m}:null;
}
function fen(s){let res='';for(let r=0;r<8;r++){let n=0;for(let c=0;c<8;c++){const p=s.b[idx(r,c)];if(p==='.'){n++}else{if(n){res+=n;n=0}res+=p}}if(n)res+=n;if(r!==7)res+='/'}return res+' '+s.turn+' '+(s.castle||'-')+' '+(s.ep<0?'-':coord(s.ep))+' '+s.half+' '+s.full}
function moveUci(m){return coord(m.from)+coord(m.to)+(m.promote||'')}
const value={p:100,n:320,b:335,r:500,q:900,k:0};
function evaluate(s,forSide){let sum=0;for(let i=0;i<64;i++){const p=s.b[i];if(p==='.')continue;const side=pieceSide(p),kind=p.toLowerCase(),base=value[kind];const c=COL(i),r=ROW(i);const dist=Math.abs(c-3.5)+Math.abs(r-3.5);
   const pos=(kind==='p'?(side==='w'?6-r:r-1)*6:kind==='n'||kind==='b'?(7-dist)*4:kind==='k'?-Math.max(0,5-dist)*4:0);
   sum+=(side===forSide?1:-1)*(base+pos);
 }return sum}
function bestMove(s,level='normal'){
 let moves=legal(s);if(!moves.length)return null; const depth=level==='easy'?1:level==='hard'?3:2;const side=s.turn;
 const scoreMove=m=>{const p=s.b[m.to];return (p!=='.'?value[p.toLowerCase()]*11:0)+(m.promote?9000:0)+(m.castle?140:0)};
 moves=moves.sort((a,b)=>scoreMove(b)-scoreMove(a));
 function minimax(pos,d,alpha,beta){const ms=legal(pos);if(!ms.length)return inCheck(pos,pos.turn)?(pos.turn===side?-100000-d:100000+d):0;if(d===0)return evaluate(pos,side);
   const maximize=pos.turn===side;let best=maximize?-Infinity:Infinity;
   ms.sort((a,b)=>{const aCapture=pos.b[a.to]!=='.'?value[pos.b[a.to].toLowerCase()]:0,bCapture=pos.b[b.to]!=='.'?value[pos.b[b.to].toLowerCase()]:0;return bCapture-aCapture});
   for(const m of ms){const v=minimax(apply(pos,m),d-1,alpha,beta);if(maximize){best=Math.max(best,v);alpha=Math.max(alpha,best)}else{best=Math.min(best,v);beta=Math.min(beta,best)}if(beta<=alpha)break;}return best;
 }
 let best=-Infinity,choice=[];
 for(const m of moves){const child=apply(s,m),v=level==='easy'?evaluate(child,side):minimax(child,depth-1,-Infinity,Infinity)+(Math.random()-.5)*(level==='hard'?0:7);if(v>best+.0001){best=v;choice=[m]}else if(Math.abs(v-best)<.0001)choice.push(m)}
 return choice[Math.floor(Math.random()*choice.length)]||moves[0];
}
const API={start,coord,fromCoord,legal,move,apply,fen,signature,attacked,inCheck,outcome,bestMove,moveUci,enemy,pieceSide};
if(typeof module!=='undefined'&&module.exports)module.exports=API;
global.MonoChessEngine=API;
})(typeof window!=='undefined'?window:globalThis);
