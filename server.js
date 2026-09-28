/*
 * Asteroid Impact — multiplayer relay server.
 *
 * Rewritten from the original dummy relay (which had no concept of
 * rooms, and only ever carried a tiny flat player record meant for
 * a different, much simpler test game) into what the real game
 * actually needs: room-based hosting/joining, a full live mirror of
 * each player's planet save broadcast to everyone else in their
 * room, lightweight position ticks for orbital flight and roaming,
 * and relayed field events (hits, material drops) for players who
 * are actually in the same shared space at the same time.
 *
 * Deliberately still just a relay, the same way the original was —
 * nothing is persisted to disk, a room lives only as long as the
 * process remembers it and at least one connection is holding it
 * open. That matches how this was already running (Render's free
 * tier restarts the process on redeploy/sleep anyway, so in-memory
 * state was never going to outlive that), and keeps this a drop-in
 * replacement: same package.json, same start command, same host.
 */

const http=require('http');
const WebSocket=require('ws');

const PORT=process.env.PORT || 3000;

/*
 * roomCode -> Room. A Room is { code, players: Map<playerId,Player>,
 * createdAt }. A Player is { id, ws, name, colour, roomCode,
 * planetSave (the last full snapshot this player broadcast — kept
 * server-side so a player who joins partway through a room's life,
 * or reconnects, can be caught up immediately instead of staring at
 * nothing until the other player's next real action), presence
 * (their last position tick), lastSeen }.
 */
const rooms=new Map();

const ROOM_CODE_CHARS='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const MAX_PLAYERS_PER_ROOM=6;

/*
 * A full planetSave for an active player can be a genuinely large
 * object (every planet's structures, ships, pets, stock — this
 * whole game's save file). Capped generously above what a real save
 * should ever reach, purely so a malformed or hostile payload can't
 * be relayed to every other player in the room at full size.
 */
const MAX_MESSAGE_BYTES=2*1024*1024;

function makeRoomCode(){

    let code;

    do{

        code='';

        for(let i=0;i<5;i++){

            code+=ROOM_CODE_CHARS[
                Math.floor(
                    Math.random()*
                    ROOM_CODE_CHARS.length
                )
            ];

        }

    }while(rooms.has(code));

    return code;

}

function makePlayerId(){

    return Math.random().toString(36).slice(2,10)+
        Date.now().toString(36).slice(-4);
}

function send(ws,message){

    if(ws && ws.readyState===WebSocket.OPEN){

        try{

            ws.send(JSON.stringify(message));

        }catch(error){

            /* a bad payload here is a bug in what we sent, not
               something the client can do anything about — just
               don't crash the process over it */

        }

    }

}

function broadcastToRoom(room,message,exceptId){

    if(!room)
        return;

    room.players.forEach(
        player=>{

            if(player.id!==exceptId){

                send(player.ws,message);

            }

        }
    );

}

/*
 * name/colour trusted only loosely — clamped/validated, never
 * executed or templated into anything, and every message this
 * server relays is JSON, never HTML, so there's no injection
 * surface even if a player sends something odd through them.
 */
function sanitizeName(name){

    return String(name || 'Player')
        .slice(0,18)
        .replace(/[\r\n\t]/g,' ')
        .trim() || 'Player';

}

function sanitizeColour(colour){

    return(
        typeof colour==='string' &&
        /^#[0-9a-fA-F]{6}$/.test(colour)
    )
        ?colour
        :'#6ee7ff';

}

function rosterFor(room){

    return[...room.players.values()].map(
        p=>({
            id:p.id,
            name:p.name,
            colour:p.colour,
            hasSave:!!p.planetSave
        })
    );

}

function sendRoster(room){

    broadcastToRoom(
        room,
        {
            type:'roster',
            players:rosterFor(room)
        },
        null
    );

}

function removePlayerFromRoom(player){

    if(!player || !player.roomCode)
        return;

    const room=
        rooms.get(player.roomCode);

    if(!room)
        return;

    room.players.delete(player.id);

    broadcastToRoom(
        room,
        {type:'left',id:player.id},
        null
    );

    if(room.players.size===0){

        rooms.delete(room.code);

    }else{

        sendRoster(room);

    }

    player.roomCode=null;

}

const server=http.createServer(
    (req,res)=>{

        res.writeHead(
            200,
            {'Content-Type':'text/plain'}
        );

        res.end(
            'Asteroid Impact multiplayer '+
            'server is running. '+
            rooms.size+' room(s) active.'
        );

    }
);

const wss=new WebSocket.Server({
    server,
    maxPayload:MAX_MESSAGE_BYTES
});

wss.on(
    'connection',
    ws=>{

        const player={
            id:makePlayerId(),
            ws,
            name:'Player',
            colour:'#6ee7ff',
            roomCode:null,
            planetSave:null,
            presence:null,
            lastSeen:Date.now()
        };

        send(
            ws,
            {type:'welcome',id:player.id}
        );

        ws.on(
            'message',
            raw=>{

                let message;

                try{

                    message=JSON.parse(
                        raw.toString()
                    );

                }catch(error){

                    return;

                }

                if(
                    !message ||
                    typeof message.type!==
                    'string'
                ){

                    return;

                }

                player.lastSeen=Date.now();

                handleMessage(
                    player,
                    message
                );

            }
        );

        ws.on(
            'close',
            ()=>removePlayerFromRoom(player)
        );

        ws.on(
            'error',
            ()=>removePlayerFromRoom(player)
        );

    }
);

function handleMessage(player,message){

    /*
     * host/join are the only two ways a connection actually enters
     * a room; every other message type is a no-op until one of
     * those has succeeded, since nothing else makes sense without
     * a room to relay it into.
     */
    if(message.type==='host'){

        if(player.roomCode)
            removePlayerFromRoom(player);

        player.name=
            sanitizeName(message.name);

        player.colour=
            sanitizeColour(message.colour);

        const code=
            makeRoomCode();

        const room={
            code,
            players:new Map(),
            createdAt:Date.now()
        };

        rooms.set(code,room);

        room.players.set(
            player.id,
            player
        );

        player.roomCode=code;

        send(
            player.ws,
            {
                type:'hosted',
                code,
                id:player.id
            }
        );

        sendRoster(room);

        return;

    }

    if(message.type==='join'){

        const code=
            String(message.code || '')
                .trim()
                .toUpperCase();

        const room=
            rooms.get(code);

        if(!room){

            send(
                player.ws,
                {
                    type:'error',
                    message:
                        'Room "'+code+
                        '" was not found. '+
                        'Double check the code.'
                }
            );

            return;

        }

        if(
            room.players.size>=
            MAX_PLAYERS_PER_ROOM
        ){

            send(
                player.ws,
                {
                    type:'error',
                    message:
                        'That room is full ('+
                        MAX_PLAYERS_PER_ROOM+
                        ' players).'
                }
            );

            return;

        }

        if(player.roomCode)
            removePlayerFromRoom(player);

        player.name=
            sanitizeName(message.name);

        player.colour=
            sanitizeColour(message.colour);

        room.players.set(
            player.id,
            player
        );

        player.roomCode=code;

        send(
            player.ws,
            {
                type:'joined',
                code,
                id:player.id
            }
        );

        /*
         * Catch the new arrival up on everyone already there —
         * their most recent full planet save and presence each,
         * so the newcomer's star map and field don't sit empty
         * until those players next happen to act or move.
         */
        room.players.forEach(
            existing=>{

                if(existing.id===player.id)
                    return;

                if(existing.planetSave){

                    send(
                        player.ws,
                        {
                            type:'sync',
                            id:existing.id,
                            name:existing.name,
                            colour:existing.colour,
                            planetSave:
                                existing.planetSave
                        }
                    );

                }

                if(existing.presence){

                    send(
                        player.ws,
                        Object.assign(
                            {
                                type:'presence',
                                id:existing.id
                            },
                            existing.presence
                        )
                    );

                }

            }
        );

        sendRoster(room);

        return;

    }

    const room=
        rooms.get(player.roomCode);

    if(!room)
        return;

    if(message.type==='sync'){

        /*
         * The full live mirror — see savePlanetProgress on the
         * client, which is what actually triggers this. Kept
         * server-side on the player record (not just relayed) so
         * a late joiner can be caught up immediately, above.
         */
        player.planetSave=
            message.planetSave || null;

        broadcastToRoom(
            room,
            {
                type:'sync',
                id:player.id,
                name:player.name,
                colour:player.colour,
                planetSave:player.planetSave
            },
            player.id
        );

        return;

    }

    if(message.type==='presence'){

        player.presence={
            space:message.space || null,
            planetId:message.planetId || null,
            targetPlayerId:
                message.targetPlayerId || null,
            x:Number(message.x) || 0,
            y:Number(message.y) || 0,
            angle:Number(message.angle) || 0,
            vx:Number(message.vx) || 0,
            vy:Number(message.vy) || 0,
            lives:
                Number.isFinite(message.lives)
                ?message.lives
                :null
        };

        broadcastToRoom(
            room,
            Object.assign(
                {type:'presence',id:player.id},
                player.presence
            ),
            player.id
        );

        return;

    }

    if(message.type==='fieldEvent'){

        /*
         * Asteroid hits, material drops, deflections between
         * players sharing one field — relayed as-is, the sending
         * client already resolved what actually happened locally
         * (it's the one whose field this is, when it's hosting its
         * own planet's field for visitors) and just needs everyone
         * else present told about it.
         */
        broadcastToRoom(
            room,
            Object.assign(
                {type:'fieldEvent',id:player.id},
                {event:message.event || {}}
            ),
            player.id
        );

        return;

    }

    if(message.type==='leave'){

        removePlayerFromRoom(player);

        return;

    }

    if(message.type==='ping'){

        send(player.ws,{type:'pong'});

        return;

    }

}

/*
 * A connection that goes quiet without a clean close (phone locks,
 * app backgrounds, network drops) never fires 'close' on some
 * platforms until much later, if at all — this is what actually
 * frees their room slot and tells everyone else they've left.
 */
const STALE_MS=45*1000;

setInterval(
    ()=>{

        const now=Date.now();

        rooms.forEach(
            room=>{

                room.players.forEach(
                    p=>{

                        if(
                            now-p.lastSeen>
                            STALE_MS
                        ){

                            try{

                                p.ws.terminate();

                            }catch(error){}

                            removePlayerFromRoom(p);

                        }

                    }
                );

            }
        );

    },
    15*1000
);

if(require.main===module){

    server.listen(
        PORT,
        ()=>console.log(
            'Asteroid Impact multiplayer '+
            'server listening on '+PORT
        )
    );

}

module.exports={server,wss,rooms};
