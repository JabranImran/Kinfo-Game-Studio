const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;

const WORLD_WIDTH = 1200;
const WORLD_HEIGHT = 800;

const TICK = 1000 / 30;

const TARGET_ASTEROIDS = 18;

const players = new Map();
const asteroids = new Map();

let asteroidID = 0;


/* =========================================================
   UTILITIES
========================================================= */

function id(){
    return Math.random()
        .toString(36)
        .slice(2,10);
}

function random(a,b){
    return a + Math.random()*(b-a);
}

function clamp(v,a,b){
    return Math.max(a,Math.min(b,v));
}

function dist(a,b){
    return Math.hypot(a.x-b.x,a.y-b.y);
}

function send(ws,data){
    if(ws && ws.readyState === WebSocket.OPEN){
        ws.send(JSON.stringify(data));
    }
}

function broadcast(data){
    const text=JSON.stringify(data);

    for(const ws of wss.clients){
        if(ws.readyState === WebSocket.OPEN){
            ws.send(text);
        }
    }
}


/* =========================================================
   ASTEROIDS
========================================================= */

function asteroidRadius(size){
    if(size === 3) return 28;
    if(size === 2) return 20;
    return 13;
}


function asteroidSpeed(size){
    if(size === 3) return random(18,30);
    if(size === 2) return random(28,45);
    return random(45,70);
}


/*
 * Spawn from an edge, just like the original game.
 */

function edgeSpawn(){

    const side=
        Math.floor(
            Math.random()*4
        );

    const margin=70;

    if(side===0){
        return {
            x:-margin,
            y:random(0,WORLD_HEIGHT)
        };
    }

    if(side===1){
        return {
            x:WORLD_WIDTH+margin,
            y:random(0,WORLD_HEIGHT)
        };
    }

    if(side===2){
        return {
            x:random(0,WORLD_WIDTH),
            y:-margin
        };
    }

    return {
        x:random(0,WORLD_WIDTH),
        y:WORLD_HEIGHT+margin
    };
}


/*
 * Aim broadly towards the centre, matching the original
 * asteroid spawning behaviour.
 */

function createAsteroid(
    x=null,
    y=null,
    size=null
){

    const pos=
        x===null
        ?edgeSpawn()
        :{x,y};

    const actualSize=
        size ||
        (
            Math.random()<.18
            ?3
            :Math.random()<.38
            ?2
            :1
        );


    const targetX=
        WORLD_WIDTH/2+
        random(
            -WORLD_WIDTH*.25,
            WORLD_WIDTH*.25
        );

    const targetY=
        WORLD_HEIGHT/2+
        random(
            -WORLD_HEIGHT*.25,
            WORLD_HEIGHT*.25
        );


    const dx=
        targetX-pos.x;

    const dy=
        targetY-pos.y;

    const length=
        Math.hypot(dx,dy)||1;

    const speed=
        asteroidSpeed(actualSize);


    const asteroid={

        id:"a"+asteroidID++,

        x:pos.x,

        y:pos.y,

        size:actualSize,

        radius:
            asteroidRadius(actualSize),

        vx:
            dx/length*speed,

        vy:
            dy/length*speed,

        angle:
            random(0,Math.PI*2),

        rotation:
            random(-.015,.015),

        hitFlash:0,

        chainQueued:false

    };


    asteroids.set(
        asteroid.id,
        asteroid
    );


    return asteroid;
}


function maintainAsteroids(){

    while(
        asteroids.size<
        TARGET_ASTEROIDS
    ){
        createAsteroid();
    }

}


/* =========================================================
   ASTEROID UPDATE
========================================================= */

function updateAsteroids(dt){

    const remove=[];

    for(
        const a of asteroids.values()
    ){

        a.x+=a.vx*dt;
        a.y+=a.vy*dt;

        a.angle+=
            a.rotation*
            dt*
            60;

        if(a.hitFlash>0){
            a.hitFlash-=dt;
        }


        /*
         * IMPORTANT:
         *
         * No screen wrapping.
         *
         * Once an asteroid leaves the field it is simply
         * removed and another is spawned.
         */

        const margin=
            a.radius+80;

        if(
            a.x < -margin ||
            a.x > WORLD_WIDTH+margin ||
            a.y < -margin ||
            a.y > WORLD_HEIGHT+margin
        ){

            remove.push(a.id);

        }

    }


    for(const id of remove){
        asteroids.delete(id);
    }


    maintainAsteroids();

}


/* =========================================================
   ASTEROID SERIALISATION
========================================================= */

function asteroidState(a){

    return {

        id:a.id,

        x:a.x,

        y:a.y,

        vx:a.vx,

        vy:a.vy,

        size:a.size,

        radius:a.radius,

        angle:a.angle,

        rotation:a.rotation,

        hitFlash:a.hitFlash

    };

}


/* =========================================================
   PLAYER
========================================================= */

function createPlayer(
    id,
    socket
){

    return {

        id,

        socket,

        x:WORLD_WIDTH/2,

        y:WORLD_HEIGHT/2,

        angle:-Math.PI/2,

        lives:3,

        score:0,

        alive:true,

        respawnTimer:0,

        name:"Rocket"

    };

}


function playerState(p){

    return {

        id:p.id,

        x:p.x,

        y:p.y,

        angle:p.angle,

        lives:p.lives,

        score:p.score,

        alive:p.alive,

        name:p.name

    };

}


/* =========================================================
   WORLD
========================================================= */

function worldState(){

    return {

        type:"world",

        width:WORLD_WIDTH,

        height:WORLD_HEIGHT,

        players:
            [...players.values()]
            .map(playerState),

        asteroids:
            [...asteroids.values()]
            .map(asteroidState)

    };

}


function sendWorld(ws){
    send(ws,worldState());
}


function broadcastWorld(){
    broadcast(worldState());
}


/* =========================================================
   EXPLOSION
========================================================= */

function detonateAsteroid(
    player,
    target
){

    if(
        !target ||
        !asteroids.has(target.id)
    ){
        return;
    }


    /*
     * Remove ONLY the asteroid that was actually tapped.
     */

    asteroids.delete(
        target.id
    );


    /*
     * Original game's power scaling:
     *
     * size 3 = 1.8
     * size 2 = 1.35
     * size 1 = 1
     */

    const power=
        target.size===3
        ?1.8
        :target.size===2
        ?1.35
        :1;


    const radius=
        110*power;


    /*
     * Deflect nearby asteroids.
     *
     * They are NOT destroyed.
     */

    for(
        const other
        of asteroids.values()
    ){

        const dx=
            other.x-target.x;

        const dy=
            other.y-target.y;

        const distance=
            Math.hypot(dx,dy);


        if(
            distance>=radius ||
            distance<=1
        ){
            continue;
        }


        const falloff=
            1-
            distance/radius;


        const strength=
            falloff*
            220*
            power;


        const nx=
            dx/distance;

        const ny=
            dy/distance;


        /*
         * Radial push.
         */

        other.vx+=
            nx*strength;

        other.vy+=
            ny*strength;


        /*
         * Small tangential kick.
         */

        other.vx+=
            -ny*
            strength*
            .35;

        other.vy+=
            nx*
            strength*
            .35;


        other.hitFlash=.18;


        /*
         * Very small chance of a genuine chain reaction,
         * matching the original concept.
         */

        const chance=
            .025+
            falloff*.12;


        if(
            Math.random()<chance &&
            !other.chainQueued
        ){

            other.chainQueued=true;

            setTimeout(
                ()=>{

                    const current=
                        asteroids.get(
                            other.id
                        );

                    if(current){

                        current.chainQueued=
                            false;

                        detonateAsteroid(
                            player,
                            current
                        );

                    }

                },
                random(40,180)
            );

        }

    }


    /*
     * Split larger asteroids.
     *
     * Original:
     *
     * size 3 -> 3 size 2
     * size 2 -> 2 size 1
     */

    if(
        target.size>1
    ){

        const pieces=
            target.size===3
            ?3
            :2;


        for(
            let i=0;
            i<pieces;
            i++
        ){

            const angle=
                Math.PI*2/pieces*i+
                random(-.4,.4);


            const child=
                createAsteroid(
                    target.x+
                    Math.cos(angle)*15,

                    target.y+
                    Math.sin(angle)*15,

                    target.size-1
                );


            /*
             * Split pieces shoot away from the destroyed
             * asteroid, as in the original.
             */

            const speed=
                random(50,120);


            child.vx=
                Math.cos(angle)*speed;

            child.vy=
                Math.sin(angle)*speed;

        }

    }


    /*
     * Score.
     */

    const points=
        target.size===3
        ?100
        :target.size===2
        ?50
        :24;


    player.score+=points;


    /*
     * Send visual explosion.
     *
     * No asteroid list is sent here because the next world
     * snapshot contains the authoritative result.
     */

    broadcast({

        type:"blast",

        x:target.x,

        y:target.y,

        power,

        asteroidId:target.id

    });


    broadcast({

        type:"score",

        playerId:player.id,

        score:player.score

    });

}


/*
 * Find the ONE asteroid under the tap.
 */

function blastAt(
    player,
    x,
    y
){

    if(!player.alive){
        return;
    }


    let target=null;

    let closest=Infinity;


    for(
        const asteroid
        of asteroids.values()
    ){

        const d=
            Math.hypot(
                asteroid.x-x,
                asteroid.y-y
            );


        /*
         * Small forgiving hitbox.
         *
         * Crucially this is ONLY for selecting the asteroid.
         * It is NOT the explosion radius.
         */

        if(
            d<=
            asteroid.radius+16 &&
            d<closest
        ){

            closest=d;
            target=asteroid;

        }

    }


    if(!target){
        return;
    }


    detonateAsteroid(
        player,
        target
    );

}


/* =========================================================
   PLAYER COLLISION
========================================================= */

function checkPlayerCollisions(){

    for(
        const player
        of players.values()
    ){

        if(!player.alive){
            continue;
        }


        /*
         * Same basic collision concept as the original:
         *
         * player radius ≈ 30
         */

        for(
            const asteroid
            of asteroids.values()
        ){

            const d=
                Math.hypot(
                    player.x-asteroid.x,
                    player.y-asteroid.y
                );


            if(
                d<
                asteroid.radius+30
            ){

                killPlayer(
                    player
                );

                break;

            }

        }

    }

}


/* =========================================================
   PLAYER DEATH
========================================================= */

function killPlayer(
    player
){

    if(!player.alive){
        return;
    }


    player.lives--;

    player.alive=false;

    player.respawnTimer=90;


    send(
        player.socket,
        {

            type:"death",

            lives:player.lives

        }
    );


    broadcast({

        type:"playerDeath",

        id:player.id,

        lives:player.lives

    });


    if(
        player.lives<=0
    ){

        send(
            player.socket,
            {

                type:"gameOver",

                score:player.score

            }
        );

    }

}


/* =========================================================
   RESPAWN
========================================================= */

function respawnPlayer(
    player
){

    player.x=
        WORLD_WIDTH/2+
        random(-100,100);

    player.y=
        WORLD_HEIGHT/2+
        random(-100,100);

    player.angle=
        -Math.PI/2;

    player.alive=true;

    player.respawnTimer=0;


    send(
        player.socket,
        {

            type:"respawn",

            player:
                playerState(player)

        }
    );


    broadcast({

        type:"playerRespawn",

        player:
            playerState(player)

    });

}


/* =========================================================
   UPDATE PLAYERS
========================================================= */

function updatePlayers(){

    for(
        const player
        of players.values()
    ){

        if(player.alive){
            continue;
        }


        if(
            player.lives<=0
        ){
            continue;
        }


        player.respawnTimer--;


        if(
            player.respawnTimer<=0
        ){

            respawnPlayer(
                player
            );

        }

    }

}


/* =========================================================
   HTTP
========================================================= */

const httpServer=
    http.createServer(
        (req,res)=>{

            res.writeHead(
                200,
                {
                    "Content-Type":
                        "text/plain"
                }
            );

            res.end(
                "Rocket Impact Multiplayer Server is running!"
            );

        }
    );


/* =========================================================
   WEBSOCKET
========================================================= */

const wss=
    new WebSocket.Server({
        server:httpServer
    });


wss.on(
    "connection",
    socket=>{

        const playerID=id();

        const player=
            createPlayer(
                playerID,
                socket
            );


        players.set(
            playerID,
            player
        );


        socket.playerID=
            playerID;


        console.log(
            "Player connected:",
            playerID
        );


        send(
            socket,
            {

                type:"welcome",

                id:playerID,

                worldWidth:
                    WORLD_WIDTH,

                worldHeight:
                    WORLD_HEIGHT

            }
        );


        sendWorld(
            socket
        );


        broadcast({

            type:"playerJoined",

            player:
                playerState(player)

        });


        socket.on(
            "message",
            raw=>{

                let msg;

                try{

                    msg=
                        JSON.parse(
                            raw.toString()
                        );

                }catch{

                    return;

                }


                const p=
                    players.get(
                        playerID
                    );


                if(!p){
                    return;
                }


                /* -----------------------------------------
                   JOIN
                ----------------------------------------- */

                if(
                    msg.type==="join"
                ){

                    if(
                        typeof msg.name==="string"
                    ){

                        p.name=
                            msg.name
                            .trim()
                            .slice(0,16)
                            ||
                            "Rocket";

                    }


                    sendWorld(socket);

                    return;
                }


                /* -----------------------------------------
                   PLAYER STATE
                ----------------------------------------- */

                if(
                    msg.type==="state"
                ){

                    if(!p.alive){
                        return;
                    }


                    if(
                        Number.isFinite(
                            Number(msg.x)
                        )
                    ){

                        p.x=
                            clamp(
                                Number(msg.x),
                                0,
                                WORLD_WIDTH
                            );

                    }


                    if(
                        Number.isFinite(
                            Number(msg.y)
                        )
                    ){

                        p.y=
                            clamp(
                                Number(msg.y),
                                0,
                                WORLD_HEIGHT
                            );

                    }


                    if(
                        Number.isFinite(
                            Number(msg.angle)
                        )
                    ){

                        p.angle=
                            Number(msg.angle);

                    }


                    return;
                }


                /* -----------------------------------------
                   BLAST
                ----------------------------------------- */

                if(
                    msg.type==="blast"
                ){

                    const x=
                        Number(msg.x);

                    const y=
                        Number(msg.y);


                    if(
                        Number.isFinite(x) &&
                        Number.isFinite(y)
                    ){

                        blastAt(
                            p,
                            x,
                            y
                        );

                    }

                    return;
                }

            }
        );


        socket.on(
            "close",
            ()=>{

                /*
                 * IMPORTANT:
                 *
                 * Only a real WebSocket disconnect removes
                 * the player.
                 *
                 * Dying does NOT create another player.
                 */

                players.delete(
                    playerID
                );


                broadcast({

                    type:"playerLeft",

                    id:playerID

                });


                console.log(
                    "Player disconnected:",
                    playerID
                );

            }
        );

    });


/* =========================================================
   START
========================================================= */

maintainAsteroids();


setInterval(
    ()=>{

        const dt=
            TICK/1000;

        updateAsteroids(dt);

        updatePlayers();

        checkPlayerCollisions();

        maintainAsteroids();

        broadcastWorld();

    },
    TICK
);


httpServer.listen(
    PORT,
    "0.0.0.0",
    ()=>{
        console.log(
            "Rocket Impact Multiplayer running on port",
            PORT
        );
    }
);