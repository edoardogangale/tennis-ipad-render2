'use strict';
const path=require('path');
const http=require('http');
const express=require('express');
const {Server}=require('socket.io');
const app=express();
const server=http.createServer(app);
const io=new Server(server,{cors:{origin:'*'},pingInterval:10000,pingTimeout:20000});
app.use(express.static(path.join(__dirname,'public')));
app.get('/health',(_,res)=>res.json({ok:true,game:'tennis-ipad-reborn'}));

const COURT={halfW:5.485,baseline:11.885,service:6.4,netH:.91};
const TICK=60, NET=30, DT=1/TICK;
const COURTS={
 hard:{speed:3.9,accel:.15,decel:.28,bounce:.66,friction:.88},
 clay:{speed:3.7,accel:.22,decel:.46,bounce:.74,friction:.78},
 grass:{speed:4.1,accel:.12,decel:.16,bounce:.55,friction:.96}
};
const COLORS=['#5DA9FF','#FF5C6C','#7BE495','#FFD166','#B79CFF','#FF9F68'];
const state={phase:'lobby',court:'hard',players:new Map(),serverId:null,receiverId:null,ball:null,score:newScore(),events:[],energy:{A:0,B:0},seq:0};
function newScore(){return {games:{A:0,B:0},sets:[{A:0,B:0}],points:{A:0,B:0},setsWon:{A:0,B:0},deuce:false,advantage:null,tiebreak:false,tb:{A:0,B:0},matchOver:false,winner:null};}
function players(){return [...state.players.values()];}
function other(t){return t==='A'?'B':'A';}
function clamp(v,a,b){return Math.max(a,Math.min(b,v));}
function teamForJoin(){const a=players().filter(p=>p.team==='A').length,b=players().filter(p=>p.team==='B').length;return a<=b?'A':'B';}
function setupPoint(){
 const sv=state.players.get(state.serverId); if(!sv)return;
 state.phase='serving'; state.receiverId=null; state._fault=0;
 for(const p of players()){p.targetX=0;p.targetZ=0;p.hitUntil=0;p.charging=false;p.charge=0;p.moveLock=0;}
 const recv=players().filter(p=>p.team!==sv.team).sort((a,b)=>Math.abs(a.x-(sv.team==='A'?2.4:-2.4))-Math.abs(b.x-(sv.team==='A'?2.4:-2.4)));
 state.receiverId=recv[0]?.id||null;
 const face=sv.team==='A'?1:-1; const right=face; const side=((state.score.points.A+state.score.points.B)%2===0)?right:-right;
 sv.x=side*1.9;sv.z=-face*(COURT.baseline+.15);sv.vx=sv.vz=0;
 for(const p of players()){
   if(p.id===sv.id)continue;
   const isRecv=p.team!==sv.team;
   p.x=isRecv?(p.id===state.receiverId?-side*2.4:side*1.4):(-side*1.8);
   p.z=isRecv?face*(p.id===state.receiverId?COURT.baseline-.4:COURT.service-1.2):-face*(COURT.service-1.2);
   p.vx=p.vz=0;
 }
 state.ball={x:sv.x,y:.9,z:sv.z,vx:0,vy:0,vz:0,held:true,inPlay:false,type:'serve',lastHitter:null,lastTeam:null,allowedTeam:other(sv.team),bounces:0,crossed:false,marks:[],spin:0,curve:0,sideKick:0};
}
function resetMatch(){state.score=newScore();state.energy={A:0,B:0};state.phase='lobby';state.ball=null;state.serverId=players()[0]?.id||null;state.events.push({type:'reset'});}
function point(team,reason){
 if(state.score.matchOver)return;
 state.phase='pointEnd';state.events.push({type:'point',team,reason});
 const s=state.score,o=other(team);
 if(s.tiebreak){
   s.tb[team]++;
   if(s.tb[team]>=7&&s.tb[team]-s.tb[o]>=2){
     s.games[team]++; finishSet(team);
   }
 }else{
   s.points[team]++;
   if(s.points[team]>=4&&s.points[team]-s.points[o]>=2){
     s.games[team]++;s.points={A:0,B:0};s.deuce=false;s.advantage=null;state.events.push({type:'game',team});
     if(s.games[team]>=6&&s.games[team]-s.games[o]>=2)finishSet(team);
     else if(s.games.A===6&&s.games.B===6){s.tiebreak=true;s.tb={A:0,B:0};state.events.push({type:'tiebreak'});}
   }else{
     s.deuce=s.points.A>=3&&s.points.B>=3&&s.points.A===s.points.B;
     s.advantage=s.points.A>=3&&s.points.B>=3?(s.points.A>s.points.B?'A':s.points.B>s.points.A?'B':null):null;
   }
 }
 if(!s.matchOver){
   rotateServer();
   clearTimeout(state.nextPointTimer);
   state.nextPointTimer=setTimeout(()=>{if(!state.score.matchOver&&players().length>=2)setupPoint();},850);
 }
}
function finishSet(team){const s=state.score;s.sets[s.sets.length-1]={A:s.games.A,B:s.games.B,tb:s.tiebreak?{...s.tb}:null};s.setsWon[team]++;state.events.push({type:'set',team});if(s.setsWon[team]>=2){s.matchOver=true;s.winner=team;state.phase='gameEnd';state.events.push({type:'match',team});return;}s.games={A:0,B:0};s.points={A:0,B:0};s.deuce=false;s.advantage=null;s.tiebreak=false;s.tb={A:0,B:0};s.sets.push({A:0,B:0});}
function rotateServer(){const list=players();if(!list.length){state.serverId=null;return;}const cur=list.findIndex(p=>p.id===state.serverId);const current=list[cur>=0?cur:0];const opp=list.filter(p=>p.team===other(current.team));state.serverId=(opp[0]||list[(cur+1)%list.length]).id;}
function hit(p,type,charge,aim){
 const b=state.ball;if(!b||!b.inPlay||b.held||b.allowedTeam!==p.team)return;
 const d=Math.hypot(b.x-p.x,b.z-p.z);if(d>2.9||b.y>3.7)return;
 const c=clamp(charge,0,1);let speed=(16+22*c)*(p.isEmbrando?1.5:1);if(type==='lob')speed*=.82;if(type==='drop')speed*=.62;if(type==='slice')speed*=.88;speed=Math.min(speed,42);
 const dir=p.team==='A'?1:-1;let tx=(aim?.x||0)*2.2+p.x, tz=p.z+dir*(type==='lob'?9:type==='drop'?6.5:10.5);const dx=tx-b.x,dz=tz-b.z,len=Math.hypot(dx,dz)||1;
 b.vx=dx/len*speed;b.vz=dz/len*speed;b.vy=5.5+3.4*c+(type==='lob'?3:0);b.spin=type==='slice'?.2:type==='lob'?.55:.05;b.sideKick=type==='slice'?(aim?.x||0)*3:0;b.lastHitter=p.id;b.lastTeam=p.team;b.allowedTeam=other(p.team);b.bounces=0;b.crossed=false;
 state.events.push({type:'hit',id:p.id,team:p.team,shot:type,charge:c,x:p.x,z:p.z});
}
function serve(p,charge,type,aim){const b=state.ball;if(!b||!b.held||state.serverId!==p.id)return;const face=p.team==='A'?1:-1;let speed=(type==='slice'?25:type==='kick'?23:29)*(0.55+.45*clamp(charge,0,1))*(p.isEmbrando?1.5:1);const boxX=(state.score.points.A+state.score.points.B)%2===0?face:-face;const tx=boxX*2.0+(aim?.x||0)*1.5,tz=face*(COURT.service-1.1);const dx=tx-b.x,dz=tz-b.z,len=Math.hypot(dx,dz)||1;b.x=p.x;b.z=p.z+face*.25;b.y=2.5;b.vx=dx/len*speed;b.vz=dz/len*speed;b.vy=6.2;b.held=false;b.inPlay=true;b.type='serve';b.lastHitter=p.id;b.lastTeam=p.team;b.allowedTeam=other(p.team);b.bounces=0;b.crossed=false;b.spin=type==='kick'?.7:type==='slice'?.15:.05;state.phase='rally';state.events.push({type:'serve',id:p.id,kmh:Math.round(speed*3.6)});}
function stepPlayers(){const prof=COURTS[state.court];for(const p of players()){
 if(state.phase==='serving'&&p.id===state.serverId){p.vx=p.vz=0;continue;}
 let max=prof.speed*1.4*(p.isEmbrando?2:1),k=1-Math.exp(-DT/(Math.hypot(p.targetX,p.targetZ)>.05?prof.accel:prof.decel));
 let tx=p.targetX*max,tz=p.targetZ*max;p.vx+=(tx-p.vx)*k;p.vz+=(tz-p.vz)*k;p.x+=p.vx*DT;p.z+=p.vz*DT;
 p.x=clamp(p.x,-COURT.halfW-2.2,COURT.halfW+2.2);p.z=p.team==='A'?clamp(p.z,-COURT.baseline-3,-.45):clamp(p.z,.45,COURT.baseline+3);
 if(state.phase==='serving'&&p.id===state.receiverId){if(p.team==='A')p.z=Math.min(p.z,-COURT.service);else p.z=Math.max(p.z,COURT.service);p.vz=0;if(p.team==='A')p.targetZ=Math.min(0,p.targetZ);else p.targetZ=Math.max(0,p.targetZ);}
 p.stamina=clamp(p.stamina+(Math.hypot(p.vx,p.vz)<max*.8?.25:-.05)*DT,0,1);
 }}
function stepBall(){const b=state.ball;if(!b||!b.inPlay)return;const prof=COURTS[state.court];b.vx-=b.vx*.024*DT;b.vz-=b.vz*.024*DT;b.vy-=9.8*DT;b.x+=b.vx*DT;b.y+=b.vy*DT;b.z+=b.vz*DT;
 if(!b.crossed&&Math.abs(b.z)<.12&&b.y<COURT.netH){b.vx*=.2;b.vz*=-.2;b.vy=Math.abs(b.vy)*.2; if(b.type==='serve'){fault();}else point(other(b.lastTeam),'net');return;}
 if(!b.crossed&&((b.z>0&&b.z-DT*b.vz<0)||(b.z<0&&b.z-DT*b.vz>0)))b.crossed=true;
 if(b.y<=.034){b.y=.034;const side=b.z<0?'A':'B';if(b.bounces===0){if(b.type==='serve'){const valid=Math.abs(b.x)<=COURT.halfW&&Math.abs(b.z)<=COURT.service;if(!valid){fault();return;}}else if(side===b.lastTeam){point(other(b.lastTeam),'own court');return;}else if(Math.abs(b.x)>COURT.halfW||Math.abs(b.z)>COURT.baseline){point(other(b.lastTeam),'out');return;}}
 else {point(b.lastTeam,'double bounce');return;} b.bounces++;b.vy=-b.vy*prof.bounce;b.vx*=prof.friction*.85;b.vz*=prof.friction*.85;b.vz+=b.spin*2.2;b.spin*=.55;state.events.push({type:'bounce',x:b.x,z:b.z,court:state.court});}
 if(Math.abs(b.x)>14||Math.abs(b.z)>20||b.y>25)point(other(b.lastTeam),'out');}
function fault(){state.events.push({type:'fault'});state.phase='pointEnd';state._fault=(state._fault||0)+1;if(state._fault>=2){state._fault=0;point(other(state.players.get(state.serverId)?.team||'A'),'double fault');}else{setTimeout(()=>{if(!state.score.matchOver){state._fault=1;setupPoint();}},650);}}
function snapshot(){const s=state.score;const labels=(t)=>{const a=s.points[t],o=s.points[other(t)];if(s.tiebreak)return s.tb[t]+'';if(a>=3&&o>=3)return a===o?'40':a>o?'AD':'40';return ['0','15','30','40'][Math.min(3,a)];};return {seq:state.seq++,phase:state.phase,court:state.court,serverId:state.serverId,receiverId:state.receiverId,energy:state.energy,score:{...s,labels:{A:labels('A'),B:labels('B')}},players:players().map(p=>({id:p.id,name:p.name,team:p.team,color:p.color,x:+p.x.toFixed(3),z:+p.z.toFixed(3),vx:+p.vx.toFixed(3),vz:+p.vz.toFixed(3),stamina:+p.stamina.toFixed(3),charging:p.charging,charge:p.charge,isEmbrando:p.isEmbrando})),ball:state.ball?{...state.ball,marks:state.ball.marks.slice(-10)}:null,events:state.events};}
setInterval(()=>{stepPlayers();if(state.phase==='rally')stepBall();},1000/TICK);
setInterval(()=>{io.emit('state',snapshot());state.events=[];},1000/NET);

io.on('connection',socket=>{
 socket.emit('hello',{court:state.court,count:players().length});
 socket.on('join',data=>{if(state.players.has(socket.id))return;const name=String(data?.name||'Player').slice(0,14);if(players().length===0&&COURTS[data?.court])state.court=data.court;const p={id:socket.id,name,team:teamForJoin(),color:COLORS[players().length%COLORS.length],x:0,z:0,vx:0,vz:0,targetX:0,targetZ:0,stamina:1,charging:false,charge:0,isEmbrando:name.trim().toLowerCase()==='embrando'};state.players.set(p.id,p);if(players().length===1)state.serverId=p.id;if(players().length>=2&&state.phase==='lobby'){resetMatch();state.serverId=players()[0].id;setupPoint();}socket.emit('joined',{id:p.id,team:p.team,color:p.color,isEmbrando:p.isEmbrando});});
 socket.on('input',({mx=0,mz=0})=>{const p=state.players.get(socket.id);if(!p)return;const m=Math.hypot(mx,mz)||1;p.targetX=clamp(mx/m,-1,1);p.targetZ=clamp(mz/m,-1,1);});
 socket.on('chargeStart',()=>{const p=state.players.get(socket.id);if(p){p.charging=true;p.charge=0;}});
 socket.on('chargeTick',({t=0})=>{const p=state.players.get(socket.id);if(p)p.charge=clamp(t/1.5,0,1);});
 socket.on('shot',d=>{const p=state.players.get(socket.id);if(!p)return;p.charging=false;const c=clamp(d?.charge||p.charge,0,1);if(state.phase==='serving')serve(p,c,d?.serveType||'flat',d?.angle);else if(state.phase==='rally')hit(p,d?.shot||'drive',c,d?.angle);p.charge=0;});
 socket.on('emote',key=>state.events.push({type:'emote',id:socket.id,key}));
 socket.on('disconnect',()=>{const was=state.serverId===socket.id;state.players.delete(socket.id);if(!players().length){state.phase='lobby';state.serverId=null;state.ball=null;state.score=newScore();return;}if(was){state.serverId=players()[0].id;state.phase=players().length>=2?'lobby':'lobby';state.ball=null;} if(players().length<2){state.phase='lobby';state.ball=null;} });
});
server.listen(process.env.PORT||3000,()=>console.log('Tennis iPad Reborn running'));
