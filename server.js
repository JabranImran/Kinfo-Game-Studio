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
const fs=require('fs');
const path=require('path');
const crypto=require('crypto');
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

/*
 * A per-player secret, issued on host/join and required to resume
 * that same seat later — the player id itself is visible to every
 * room-mate (it's in the roster), so it can't double as proof of
 * identity on its own.
 */
function makeToken(){

    return crypto.randomBytes(18).toString('hex');

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

/*
 * Every member gets a colour nobody else in the room is using —
 * it's what tells players apart on name tags, tap rings and the
 * crew scoreboard, so two players sharing one would make all of
 * those ambiguous. Assigned by the server (the only place that can
 * see the whole room), first free colour in this order.
 */
const PLAYER_PALETTE=[
    '#6ee7ff','#ff7ab6','#ffd166',
    '#8ef0ae','#b39dff','#ff9f6b'
];

function pickFreeColour(room,forPlayer){

    const used=new Set(
        [...room.players.values()]
            .filter(p=>p!==forPlayer)
            .map(p=>p.colour)
    );

    return(
        PLAYER_PALETTE.find(c=>!used.has(c)) ||
        PLAYER_PALETTE[
            room.players.size %
            PLAYER_PALETTE.length
        ]
    );

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
            hasSave:!!p.planetSave,
            online:!!p.online,
            lastSeen:p.lastSeen
        })
    );

}

function sendRoster(room){

    broadcastToRoom(
        room,
        {
            type:'roster',
            players:rosterFor(room),
            hostId:room.hostId
        },
        null
    );

}

/*
 * Releases everything LIVE a player was holding — ship claims they
 * were piloting, crew seats they'd taken — whether they're leaving
 * the room for good or just going offline. A ship can't stay locked
 * to someone who isn't there to fly it.
 */
function releasePlayerClaims(room,player){

    /*
     * A player who disconnects mid-flight shouldn't leave a ship
     * permanently locked for everyone else in the room — release
     * every claim they were holding (as pilot) and tell the room.
     * A disconnecting CO-pilot is a lighter case: just drop them
     * from that crew and tell the room, since the pilot and the
     * flight itself are unaffected by one co-pilot disappearing.
     */
    room.claimedShips.forEach(
        (claim,shipKey)=>{

            if(claim.byId===player.id){

                room.claimedShips.delete(
                    shipKey
                );

                broadcastToRoom(
                    room,
                    {
                        type:'shipReleased',
                        shipKey,
                        coPilotIds:
                            (claim.coPilots || []).
                            map(c=>c.id)
                    },
                    null
                );

            }else if(
                Array.isArray(
                    claim.coPilots
                ) &&
                claim.coPilots.some(
                    c=>c.id===player.id
                )
            ){

                claim.coPilots=
                    claim.coPilots.filter(
                        c=>c.id!==player.id
                    );

                broadcastToRoom(
                    room,
                    {
                        type:'crewUpdated',
                        shipKey,
                        byId:claim.byId,
                        byName:claim.byName,
                        coPilots:claim.coPilots
                    },
                    null
                );

            }

        }
    );

}

/*
 * A closed connection is NOT leaving — the player stays a member of
 * the room (their planet stays visible to everyone, their seat is
 * kept for when they come back) and is just marked offline. Only an
 * explicit 'leave' removes them. `ws` guards against a stale socket's
 * close event arriving after the same player already reconnected on
 * a new one.
 */
function markPlayerOffline(player,ws){

    if(!player || player.ws!==ws)
        return;

    player.ws=null;

    player.online=false;

    player.presence=null;

    if(!player.roomCode)
        return;

    const room=
        rooms.get(player.roomCode);

    if(!room)
        return;

    releasePlayerClaims(room,player);

    /*
     * Also free claims OTHER players held on this player's ships —
     * those can't be launched while the owner is away. (A flight
     * already under way is unaffected: its results are queued for
     * the owner instead, see shipLifecycle.)
     */
    room.claimedShips.forEach(
        (claim,shipKey)=>{

            if(
                shipKey.indexOf(
                    player.id+':'
                )===0
            ){

                room.claimedShips.delete(
                    shipKey
                );

                broadcastToRoom(
                    room,
                    {
                        type:'shipReleased',
                        shipKey,
                        coPilotIds:
                            (claim.coPilots || []).
                            map(cp=>cp.id)
                    },
                    null
                );

            }

        }
    );

    broadcastToRoom(
        room,
        {type:'playerOffline',id:player.id},
        null
    );

    sendRoster(room);

    schedulePersist();

}

function removePlayerFromRoom(player){

    if(!player || !player.roomCode)
        return;

    const room=
        rooms.get(player.roomCode);

    if(!room)
        return;

    releasePlayerClaims(room,player);

    room.players.delete(player.id);

    broadcastToRoom(
        room,
        {type:'left',id:player.id},
        null
    );

    if(room.players.size===0){

        rooms.delete(room.code);

    }else{

        /*
         * The host's system sits at the centre of everyone's star
         * map — if the host themselves leaves, someone still has
         * to hold that position, so the room isn't left pointing
         * at a player who's no longer there. Whoever's been
         * connected longest (the map's insertion order) takes over,
         * the same predictable rule every remaining client can
         * compute identically without the server needing to pick
         * favourites.
         */
        if(room.hostId===player.id){

            const members=
                [...room.players.values()];

            room.hostId=
                (
                    members.find(p=>p.online) ||
                    members[0]
                ).id;

        }

        sendRoster(room);

    }

    player.roomCode=null;

    schedulePersist();

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

        /*
         * conn.player can be SWAPPED by a successful 'resume' — this
         * connection then speaks as the stored member it reclaimed,
         * not the throwaway identity it started with.
         */
        const conn={
            player:{
                id:makePlayerId(),
                token:null,
                ws,
                online:true,
                name:'Player',
                colour:'#6ee7ff',
                roomCode:null,
                planetSave:null,
                presence:null,
                lastSeen:Date.now()
            }
        };

        const player=conn.player;

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

                conn.player.lastSeen=Date.now();

                if(message.type==='resume'){

                    resumePlayer(conn,ws,message);

                    return;

                }

                /*
                 * Leaving while NOT currently resumed (pressed Leave
                 * while the app was still reconnecting) — proven by
                 * the same token, so a seat can always be given up,
                 * not only while connected.
                 */
                if(message.type==='leaveRoom'){

                    const room=
                        rooms.get(
                            String(message.code || '')
                                .trim().toUpperCase()
                        );

                    const member=
                        room &&
                        room.players.get(
                            String(message.id || '')
                        );

                    if(
                        member &&
                        member.token &&
                        member.token===message.token
                    ){

                        if(member.ws && member.ws!==ws){

                            try{ member.ws.close(); }catch(error){}

                        }

                        member.ws=null;

                        removePlayerFromRoom(member);

                    }

                    send(ws,{type:'leftRoom'});

                    try{ ws.close(); }catch(error){}

                    return;

                }

                handleMessage(
                    conn.player,
                    message
                );

            }
        );

        ws.on(
            'close',
            ()=>markPlayerOffline(conn.player,ws)
        );

        ws.on(
            'error',
            ()=>markPlayerOffline(conn.player,ws)
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
            /*
             * The player who created the room — the star map's
             * layout uses this to put their system at the centre
             * and everyone else's arranged around it, the same way
             * on every client, since they all read this one shared
             * fact from the server rather than each guessing.
             */
            hostId:player.id,
            /*
             * shipKey -> {byId, byName}. Namespaced by ownerId+':'+
             * shipId rather than bare shipId, since each player's
             * save generates its own ship ids independently (two
             * different players can each have a "ship_1") — without
             * the owner prefix those would collide and one player's
             * claim could wrongly block another player's unrelated
             * ship.
             */
            claimedShips:new Map(),
            createdAt:Date.now()
        };

        rooms.set(code,room);

        room.players.set(
            player.id,
            player
        );

        player.roomCode=code;

        player.token=makeToken();

        player.online=true;

        player.colour=
            pickFreeColour(room,player);

        send(
            player.ws,
            {
                type:'hosted',
                code,
                id:player.id,
                token:player.token,
                colour:player.colour
            }
        );

        schedulePersist();

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
                        ' members — offline members '+
                        'keep their seat until they '+
                        'leave the room).'
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

        player.token=makeToken();

        player.online=true;

        player.colour=
            pickFreeColour(room,player);

        send(
            player.ws,
            {
                type:'joined',
                code,
                id:player.id,
                token:player.token,
                colour:player.colour
            }
        );

        schedulePersist();

        /*
         * Catch the new arrival up on everyone already there —
         * their most recent full planet save and presence each,
         * so the newcomer's star map and field don't sit empty
         * until those players next happen to act or move.
         */
        if(room.claimedShips.size){

            send(
                player.ws,
                {
                    type:'shipClaims',
                    claims:
                        [...room.claimedShips.entries()].map(
                            ([shipKey,claim])=>({
                                shipKey,
                                byId:claim.byId,
                                byName:claim.byName,
                                coPilots:
                                    claim.coPilots || []
                            })
                        )
                }
            );

        }

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

                if(
                    existing.online &&
                    existing.presence
                ){

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

        schedulePersist();

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

        /*
         * A flat, generic bag rather than one schema per space —
         * orbital flight needs x/y/vx/vy/angle, roaming needs
         * lat/lon and which pet is walking around; ownerId is
         * common to both (whose planet this presence is actually
         * happening on, since a visitor's own presence is reported
         * against the planet they're currently on, not their own).
         * The server never interprets any of these, only relays
         * them — but it does relay ONLY the fields listed here, so
         * a new presence field genuinely needs adding below too.
         */
        player.presence={
            space:message.space || null,
            planetId:message.planetId || null,
            ownerId:message.ownerId || null,
            x:Number(message.x) || 0,
            y:Number(message.y) || 0,
            angle:Number(message.angle) || 0,
            vx:Number(message.vx) || 0,
            vy:Number(message.vy) || 0,
            lat:
                Number.isFinite(message.lat)
                ?message.lat
                :null,
            lon:
                Number.isFinite(message.lon)
                ?message.lon
                :null,
            petSpecies:
                message.petSpecies || null,
            petId:message.petId || null,
            lives:
                Number.isFinite(message.lives)
                ?message.lives
                :null,
            styleId:
                typeof message.styleId==='string'
                ?message.styleId.slice(0,32)
                :null,
            styleOwnerId:
                typeof message.styleOwnerId==='string'
                ?message.styleOwnerId.slice(0,64)
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

    if(message.type==='claimShip'){

        const shipKey=
            String(message.ownerId || '')+
            ':'+
            String(message.shipId || '');

        const existing=
            room.claimedShips.get(shipKey);

        if(
            existing &&
            existing.byId!==player.id
        ){

            send(
                player.ws,
                {
                    type:'shipClaimDenied',
                    shipKey,
                    byName:existing.byName
                }
            );

            return;

        }

        /*
         * coPilots lives alongside the pilot's own claim, under the
         * same shipKey — a fresh array on every new claim (claiming
         * an unclaimed ship always starts crewless), since a stale
         * array from a PREVIOUS claim of this same ship would
         * otherwise list people who were never actually invited to
         * this one.
         */
        room.claimedShips.set(
            shipKey,
            {
                byId:player.id,
                byName:player.name,
                coPilots:[]
            }
        );

        broadcastToRoom(
            room,
            {
                type:'shipClaimed',
                shipKey,
                byId:player.id,
                byName:player.name,
                coPilots:[]
            },
            null
        );

        return;

    }

    if(message.type==='releaseShip'){

        const shipKey=
            String(message.ownerId || '')+
            ':'+
            String(message.shipId || '');

        const existing=
            room.claimedShips.get(shipKey);

        if(
            !existing ||
            existing.byId!==player.id
        ){

            return;

        }

        room.claimedShips.delete(shipKey);

        /*
         * The whole crew needs telling, not just whoever released
         * it — a co-pilot who'd readied up has no other way to
         * learn the flight they were waiting on just evaporated.
         */
        broadcastToRoom(
            room,
            {
                type:'shipReleased',
                shipKey,
                coPilotIds:
                    (existing.coPilots || []).
                    map(c=>c.id)
            },
            null
        );

        return;

    }

    if(
        message.type==='joinCoPilot' ||
        message.type==='leaveCoPilot' ||
        message.type==='setCoPilotReady'
    ){

        const shipKey=
            String(message.ownerId || '')+
            ':'+
            String(message.shipId || '');

        const claim=
            room.claimedShips.get(shipKey);

        /*
         * No crew to join/leave/ready-up on if nobody has actually
         * claimed this ship yet, or if this player somehow IS the
         * pilot (co-piloting your own claimed ship makes no sense).
         */
        if(
            !claim ||
            claim.byId===player.id
        ){

            return;

        }

        if(!Array.isArray(claim.coPilots)){

            claim.coPilots=[];

        }

        if(message.type==='joinCoPilot'){

            if(
                !claim.coPilots.some(
                    c=>c.id===player.id
                )
            ){

                claim.coPilots.push({
                    id:player.id,
                    name:player.name,
                    ready:false
                });

            }

        }else if(message.type==='leaveCoPilot'){

            claim.coPilots=
                claim.coPilots.filter(
                    c=>c.id!==player.id
                );

        }else{

            const entry=
                claim.coPilots.find(
                    c=>c.id===player.id
                );

            if(entry){

                entry.ready=
                    !!message.ready;

            }

        }

        broadcastToRoom(
            room,
            {
                type:'crewUpdated',
                shipKey,
                byId:claim.byId,
                byName:claim.byName,
                coPilots:claim.coPilots
            },
            null
        );

        return;

    }

    if(message.type==='crewLaunch'){

        /*
         * Sent by the pilot the moment they actually launch — the
         * cue every READY co-pilot's own client is waiting for to
         * start their own session of the same flight. Only the
         * real pilot of this exact ship can send it; a message
         * claiming to be a launch from anyone else is simply
         * dropped rather than trusted.
         */
        const shipKey=
            String(message.ownerId || '')+
            ':'+
            String(message.shipId || '');

        const claim=
            room.claimedShips.get(shipKey);

        if(
            !claim ||
            claim.byId!==player.id
        ){

            return;

        }

        broadcastToRoom(
            room,
            {
                type:'crewLaunch',
                shipKey,
                ownerId:message.ownerId,
                shipId:message.shipId,
                byId:claim.byId,
                byName:claim.byName,
                destinationOwnerId:
                    message.destinationOwnerId ||
                    null,
                destinationPlanetId:
                    message.destinationPlanetId ||
                    null,
                mode:message.mode || 'field',
                styleId:message.styleId || null,
                styleOwnerId:
                    message.styleOwnerId || null
            },
            player.id
        );

        return;

    }

    if(message.type==='crewLanded'){

        /*
         * The matching "come back down" cue — also pilot-only,
         * same verification. Broadcast so every co-pilot's client
         * knows to end its own session of this flight at the same
         * moment the pilot's real one does, rather than being left
         * mid-field with no ship to return to.
         */
        const shipKey=
            String(message.ownerId || '')+
            ':'+
            String(message.shipId || '');

        const claim=
            room.claimedShips.get(shipKey);

        if(
            !claim ||
            claim.byId!==player.id
        ){

            return;

        }

        broadcastToRoom(
            room,
            {
                type:'crewLanded',
                shipKey
            },
            player.id
        );

        return;

    }

    if(message.type==='planetAction'){

        /*
         * A visitor's mutating action on a planet they don't own —
         * relayed as-is to the room; only the actual owner's client
         * (matching message.ownerId to its own id) will recognise
         * it as theirs to execute. See handleRemotePlanetAction on
         * the client for how it's replayed against the owner's
         * real save using the exact same local action-handling code
         * a click from the owner themselves would run.
         */
        broadcastToRoom(
            room,
            Object.assign(
                {type:'planetAction',fromId:player.id,
                 fromName:player.name},
                message.payload || {}
            ),
            player.id
        );

        return;

    }

    if(message.type==='shipLifecycle'){

        /*
         * The launch/landing/death handoff for a claimed ship
         * someone is flying from a planet they don't own — just a
         * relay, same shape as planetAction: only the real owner's
         * client (message.ownerId matching its own id) acts on it.
         * "launch" marks the ship in-flight in the owner's own save
         * without removing it; "landing" carries the finished run's
         * actual results back to be written in; "lost" means the
         * flight ended in death rather than a landing, and the
         * owner's record is removed entirely rather than updated.
         * The server never inspects which is which, only relays.
         */
        const lifecycleMessage=
            Object.assign(
                {type:'shipLifecycle',fromId:player.id,
                 fromName:player.name},
                message.payload || {}
            );

        /*
         * The owner's device is what applies this — if they're
         * offline (closed the app mid-way through someone flying
         * their ship), hold it and deliver it the moment they
         * reconnect, rather than losing that flight's results.
         */
        const owner=
            room.players.get(
                lifecycleMessage.ownerId
            );

        if(owner && !owner.online){

            owner.pendingLifecycle=
                (owner.pendingLifecycle || [])
                    .concat([lifecycleMessage])
                    .slice(-50);

            schedulePersist();

        }

        broadcastToRoom(
            room,
            lifecycleMessage,
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
                            p.online &&
                            now-p.lastSeen>
                            STALE_MS
                        ){

                            const staleWs=p.ws;

                            markPlayerOffline(p,staleWs);

                            try{

                                staleWs.terminate();

                            }catch(error){}

                        }

                    }
                );

            }
        );

    },
    15*1000
);

/*
 * Rooms are only ever removed by their last member leaving — or,
 * so abandoned rooms don't accumulate forever, after nobody in them
 * has been online for this long.
 */
const ROOM_EXPIRY_MS=30*24*60*60*1000;

setInterval(
    ()=>{

        const now=Date.now();

        rooms.forEach(
            (room,code)=>{

                const members=
                    [...room.players.values()];

                if(
                    !members.some(p=>p.online) &&
                    members.every(
                        p=>now-(p.lastSeen || 0)>
                        ROOM_EXPIRY_MS
                    )
                ){

                    rooms.delete(code);

                    schedulePersist();

                }

            }
        );

    },
    60*60*1000
);

/* ---- RESUME: reclaim a stored seat on a new connection ---- */
function resumePlayer(conn,ws,message){

    const code=
        String(message.code || '')
            .trim()
            .toUpperCase();

    const room=
        rooms.get(code);

    const member=
        room &&
        room.players.get(
            String(message.id || '')
        );

    if(
        !member ||
        !member.token ||
        member.token!==message.token
    ){

        send(
            ws,
            {
                type:'resumeFailed',
                message:
                    room
                    ?'Your seat in room "'+code+
                     '" could not be restored.'
                    :'Room "'+code+
                     '" no longer exists.'
            }
        );

        return;

    }

    /*
     * Already connected elsewhere (a second tab, or a reconnect that
     * beat the old socket's close) — the newest connection wins.
     */
    if(
        member.ws &&
        member.ws!==ws
    ){

        const oldWs=member.ws;

        member.ws=null;

        try{

            oldWs.close();

        }catch(error){}

    }

    member.ws=ws;

    member.online=true;

    member.lastSeen=Date.now();

    conn.player=member;

    if(
        [...room.players.values()].some(
            p=>p!==member &&
            p.colour===member.colour
        )
    ){

        member.colour=
            pickFreeColour(room,member);

    }

    send(
        ws,
        {
            type:'resumed',
            code,
            id:member.id,
            token:member.token,
            colour:member.colour,
            isHost:room.hostId===member.id
        }
    );

    if(room.claimedShips.size){

        send(
            ws,
            {
                type:'shipClaims',
                claims:
                    [...room.claimedShips.entries()].map(
                        ([shipKey,claim])=>({
                            shipKey,
                            byId:claim.byId,
                            byName:claim.byName,
                            coPilots:
                                claim.coPilots || []
                        })
                    )
            }
        );

    }

    room.players.forEach(
        existing=>{

            if(existing.id===member.id)
                return;

            if(existing.planetSave){

                send(
                    ws,
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

        }
    );

    sendRoster(room);

    (member.pendingLifecycle || []).forEach(
        queued=>send(ws,queued)
    );

    member.pendingLifecycle=[];

    schedulePersist();

}

/* ---- PERSISTENCE: rooms survive a server restart ---- */
let persistFile=null;

let persistTimer=null;

function schedulePersist(){

    if(!persistFile)
        return;

    clearTimeout(persistTimer);

    persistTimer=
        setTimeout(persistNow,2000);

}

function persistNow(){

    if(!persistFile)
        return;

    const data=
        [...rooms.values()].map(
            room=>({
                code:room.code,
                hostId:room.hostId,
                createdAt:room.createdAt,
                players:
                    [...room.players.values()].map(
                        p=>({
                            id:p.id,
                            token:p.token,
                            name:p.name,
                            colour:p.colour,
                            planetSave:p.planetSave,
                            lastSeen:p.lastSeen,
                            pendingLifecycle:
                                p.pendingLifecycle || []
                        })
                    )
            })
        );

    try{

        const tmp=persistFile+'.tmp';

        fs.writeFileSync(
            tmp,
            JSON.stringify(data)
        );

        fs.renameSync(tmp,persistFile);

    }catch(error){

        console.error(
            'Could not save rooms:',
            error.message
        );

    }

}

function enablePersistence(file){

    persistFile=file;

    try{

        if(!fs.existsSync(file))
            return;

        const data=
            JSON.parse(
                fs.readFileSync(file,'utf8')
            );

        (Array.isArray(data)?data:[]).forEach(
            r=>{

                if(!r || !r.code)
                    return;

                const room={
                    code:r.code,
                    hostId:r.hostId,
                    createdAt:r.createdAt || Date.now(),
                    claimedShips:new Map(),
                    players:new Map()
                };

                (r.players || []).forEach(
                    p=>{

                        if(!p || !p.id)
                            return;

                        room.players.set(
                            p.id,
                            {
                                id:p.id,
                                token:p.token,
                                ws:null,
                                online:false,
                                name:p.name || 'Player',
                                colour:p.colour || '#6ee7ff',
                                roomCode:r.code,
                                planetSave:p.planetSave || null,
                                presence:null,
                                lastSeen:p.lastSeen || 0,
                                pendingLifecycle:
                                    p.pendingLifecycle || []
                            }
                        );

                    }
                );

                if(room.players.size){

                    rooms.set(r.code,room);

                }

            }
        );

        console.log(
            'Restored '+rooms.size+
            ' room(s) from disk.'
        );

    }catch(error){

        console.error(
            'Could not load saved rooms:',
            error.message
        );

    }

}

if(require.main===module){

    enablePersistence(
        process.env.ROOMS_FILE ||
        path.join(
            __dirname,
            'rooms-data.json'
        )
    );

    const shutdown=()=>{

        persistNow();

        process.exit(0);

    };

    process.on('SIGTERM',shutdown);

    process.on('SIGINT',shutdown);

    server.listen(
        PORT,
        ()=>console.log(
            'Asteroid Impact multiplayer '+
            'server listening on '+PORT
        )
    );

}

module.exports={server,wss,rooms,enablePersistence,persistNow};
