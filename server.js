const http=require('http');
const WebSocket=require('ws');
const PORT=process.env.PORT||3000;
const players=new Map();
const server=http.createServer((req,res)=>{res.writeHead(200,{'Content-Type':'text/plain'});res.end('Rocket Impact multiplayer server is running.');});
const wss=new WebSocket.Server({server});
function send(ws,m){if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify(m));}
function snapshot(){return [...players.values()].map(p=>({id:p.id,name:p.name,x:p.x,y:p.y,angle:p.angle,lives:p.lives,score:p.score,active:p.active!==false}));}
function broadcast(m,except){for(const ws of wss.clients)if(ws!==except)send(ws,m);}
function playersUpdate(){broadcast({type:'players',players:snapshot()});}
wss.on('connection',ws=>{
 const id=Math.random().toString(36).slice(2,10);
 const p={id,name:'Player',x:400,y:300,angle:-Math.PI/2,lives:3,score:0,active:true,ws};
 players.set(id,p); send(ws,{type:'welcome',id}); playersUpdate();
 ws.on('message',raw=>{
  let m;try{m=JSON.parse(raw.toString())}catch{return}
  if(m.type==='join'||m.type==='restart'){
   p.name=String(m.name||p.name||'Player').slice(0,16);
   if(Number.isFinite(m.x))p.x=m.x;if(Number.isFinite(m.y))p.y=m.y;if(Number.isFinite(m.angle))p.angle=m.angle;
   p.lives=Number.isFinite(m.lives)?Math.max(0,Math.floor(m.lives)):3;
   p.score=Number.isFinite(m.score)?Math.max(0,Math.floor(m.score)):0;
   p.active=true;
   playersUpdate();return;
  }
  if(m.type==='state'){
   if(Number.isFinite(m.x))p.x=m.x;if(Number.isFinite(m.y))p.y=m.y;if(Number.isFinite(m.angle))p.angle=m.angle;
   if(Number.isFinite(m.lives))p.lives=Math.max(0,Math.floor(m.lives));if(Number.isFinite(m.score))p.score=Math.max(0,Math.floor(m.score));p.active=p.lives>0;
   playersUpdate();return;
  }
  if(m.type==='hit'){
   p.lives=Number.isFinite(m.lives)?Math.max(0,Math.floor(m.lives)):p.lives;
   p.score=Number.isFinite(m.score)?Math.max(0,Math.floor(m.score)):p.score;
   broadcast({type:'playerHit',id,lives:p.lives},ws);playersUpdate();return;
  }
  if(m.type==='death'){p.lives=0;p.active=false;broadcast({type:'playerHit',id,lives:0});playersUpdate();return;}
  if(m.type==='blast')broadcast({type:'blast',x:Number(m.x)||0,y:Number(m.y)||0,power:Number(m.power)||260,from:id},ws);
  if(m.type==='requestPlayers')send(ws,{type:'players',players:snapshot()});
 });
 ws.on('close',()=>{players.delete(id);playersUpdate()});
 ws.on('error',()=>{players.delete(id);playersUpdate()});
});
server.listen(PORT,()=>console.log('Rocket Impact multiplayer server listening on '+PORT));
