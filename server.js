const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;

const WORLD_WIDTH = 1200;
const WORLD_HEIGHT = 800;

const TICK = 1000 / 30;
const TARGET_ASTEROIDS = 18;

const INVULNERABILITY_SECONDS = 2.5;

const players = new Map();
const asteroids = new Map();

let asteroidID = 0;


/* =========================================================
   UTILITIES
========================================================= */

function id(){
    return Math.random().toString(36).slice(2,10);
}

function random(a,b){
    return a + Math.random() * (b-a);
}

function clamp(v,a,b){
    return Math.max(a,Math.min(b,v));
}

function send(ws,data){
    if(ws && ws.readyState === WebSocket.OPEN){
        ws.send(JSON.stringify(data));
    }
}

function broadcast(data){
    const text = JSON.stringify(data);

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

function edgeSpawn(){

    const side = Math.floor(Math.random()*4);
    const margin = 70;

    if(side === 0){
        return {
            x:-margin,
            y:random(0,WORLD_HEIGHT)
        };
    }

    if(side === 1){
        return {
            x:WORLD_WIDTH+margin,
            y:random(0,WORLD_HEIGHT)
        };
    }

    if(side === 2){
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


function createAsteroid(
    x=null,
    y=null,
    size=null
){

    const pos =
        x === null
        ? edgeSpawn()
        : {x,y};

    const actualSize =
        size ||
        (
            Math.random() < .18
            ? 3
            : Math.random() < .38
            ? 2
            : 1
        );

    const targetX =
        WORLD_WIDTH/2 +
        random(
            -WORLD_WIDTH*.25,
            WORLD_WIDTH*.25
        );

    const targetY =
        WORLD_HEIGHT/2 +
        random(
            -WORLD_HEIGHT*.25,
            WORLD_HEIGHT*.25
        );

    const dx = targetX-pos.x;
    const dy = targetY-pos.y;

    const length =
        Math.hypot(dx,dy) || 1;

    const speed =
        asteroidSpeed(actualSize);

    const asteroid = {

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
        asteroids.size <
        TARGET_ASTEROIDS
    ){
        createAsteroid();
    }

}


/* =========================================================
   ASTEROID UPDATE
========================================================= */

function updateAsteroids(dt){

    const remove = [];

    for(
        const a of asteroids.values()
    ){

        a.x += a.vx * dt;
        a.y += a.vy * dt;

        a.angle +=
            a.rotation *
            dt *
            60;

        if(a.hitFlash > 0){
            a.hitFlash -= dt;
        }

        const margin =
            a.radius + 80;

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
   ASTEROID STATE
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

        /*
         * Time until another asteroid can damage the player.
         */
        invulnerableUntil:0,

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

        invulnerable:
            Date.now() <
            p.invulnerableUntil,

        name:p.name

    };

}


/* =========================================================
   ROCKET HITBOX
========================================================= */

/*
 * Coordinates are relative to the rocket centre.
 *
 * The rocket points upwards when angle = -PI/2.
 *
 * This polygon deliberately follows the visible rocket
 * silhouette rather than using a large circular hitbox.
 */

const ROCKET_HITBOX = [

    {x:0,   y:-22},

    {x:-9,  y:9},

    {x:-6,  y:13},

    {x:0,   y:8},

    {x:6,   y:13},

    {x:9,   y:9}

];


function rotatePoint(
    x,
    y,
    angle
){

    const c=Math.cos(angle);
    const s=Math.sin(angle);

    return {

        x:
            x*c -
            y*s,

        y:
            x*s +
            y*c

    };

}


/*
 * Closest-point distance from a point to a line segment.
 */

function pointSegmentDistance(
    px,
    py,
    ax,
    ay,
    bx,
    by
){

    const abx=bx-ax;
    const aby=by-ay;

    const ab2=
        abx*abx+
        aby*aby;

    if(ab2===0){

        return Math.hypot(
            px-ax,
            py-ay
        );

    }

    const t=clamp(
        (
            (px-ax)*abx+
            (py-ay)*aby
        )/ab2,
        0,
        1
    );

    const cx=
        ax+abx*t;

    const cy=
        ay+aby*t;

    return Math.hypot(
        px-cx,
        py-cy
    );

}


/*
 * Point inside polygon.
 */

function pointInPolygon(
    px,
    py,
    polygon
){

    let inside=false;

    for(
        let i=0,
        j=polygon.length-1;

        i<polygon.length;

        j=i++
    ){

        const xi=polygon[i].x;
        const yi=polygon[i].y;

        const xj=polygon[j].x;
        const yj=polygon[j].y;

        const intersect =
            (
                yi>py
            ) !== (
                yj>py
            ) &&
            px <
            (
                xj-xi
            ) *
            (
                py-yi
            ) /
            (
                yj-yi
            ) +
            xi;

        if(intersect){
            inside=!inside;
        }

    }

    return inside;

}


/*
 * Test an asteroid circle against the rocket polygon.
 *
 * A tiny tolerance keeps the collision fair without making
 * the hitbox visibly larger.
 */

function rocketHitsAsteroid(
    player,
    asteroid
){

    const polygon =
        ROCKET_HITBOX.map(
            point =>
                rotatePoint(
                    point.x,
                    point.y,
                    player.angle
                )
        );


    /*
     * Move polygon into world coordinates.
     */

    for(const p of polygon){

        p.x+=player.x;
        p.y+=player.y;

    }


    /*
     * First test whether asteroid centre is inside the
     * rocket polygon.
     */

    if(
        pointInPolygon(
            asteroid.x,
            asteroid.y,
            polygon
        )
    ){
        return true;
    }


    /*
     * Then test distance to each rocket edge.
     */

    for(
        let i=0;
        i<polygon.length;
        i++
    ){

        const a=
            polygon[i];

        const b=
            polygon[
                (i+1)%
                polygon.length
            ];


        const d=
            pointSegmentDistance(
                asteroid.x,
                asteroid.y,
                a.x,
                a.y,
                b.x,
                b.y
            );


        if(
            d<=
            asteroid.radius
        ){
            return true;
        }

    }


    return false;

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
     * Only the selected asteroid disappears.
     */

    asteroids.delete(target.id);


    const power =
        target.size===3
        ?1.8
        :target.size===2
        ?1.35
        :1;


    const radius =
        110*power;


    /*
     * Deflect nearby asteroids.
     * They survive.
     */

    for(
        const other of asteroids.values()
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


        const falloff =
            1-distance/radius;


        const strength =
            falloff*
            220*
            power;


        const nx=
            dx/distance;

        const ny=
            dy/distance;


        other.vx +=
            nx*strength;

        other.vy +=
            ny*strength;


        /*
         * Small tangential component.
         */

        other.vx +=
            -ny*
            strength*
            .35;

        other.vy +=
            nx*
            strength*
            .35;


        other.hitFlash=.18;


        /*
         * Very rare chain reaction.
         */

        const chance =
            .025+
            falloff*.12;


        if(
            Math.random()<chance &&
            !other.chainQueued
        ){

            other.chainQueued=true;

            setTimeout(
                ()=>{

                    const current =
                        asteroids.get(
                            other.id
                        );

                    if(current){

                        current.chainQueued=false;

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
     */

    if(target.size>1){

        const pieces =
            target.size===3
            ?3
            :2;


        for(
            let i=0;
            i<pieces;
            i++
        ){

            const angle =
                Math.PI*2/pieces*i+
                random(-.4,.4);


            const child =
                createAsteroid(
                    target.x+
                    Math.cos(angle)*15,

                    target.y+
                    Math.sin(angle)*15,

                    target.size-1
                );


            const speed =
                random(50,120);


            child.vx=
                Math.cos(angle)*speed;

            child.vy=
                Math.sin(angle)*speed;

        }

    }


    const points =
        target.size===3
        ?100
        :target.size===2
        ?50
        :24;


    player.score+=points;


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


/* =========================================================
   TAP ASTEROID
========================================================= */

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
        const asteroid of asteroids.values()
    ){

        const d=
            Math.hypot(
                asteroid.x-x,
                asteroid.y-y
            );


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

    const now=Date.now();


    for(
        const player of players.values()
    ){

        if(!player.alive){
            continue;
        }


        /*
         * Temporary shield after a hit.
         */

        if(
            now <
            player.invulnerableUntil
        ){
            continue;
        }


        for(
            const asteroid of asteroids.values()
        ){

            if(
                rocketHitsAsteroid(
                    player,
                    asteroid
                )
            ){

                damagePlayer(
                    player
                );

                break;

            }

        }

    }

}


/* =========================================================
   PLAYER DAMAGE
========================================================= */

function damagePlayer(
    player
){

    if(!player.alive){
        return;
    }


    const now=Date.now();


    if(
        now <
        player.invulnerableUntil
    ){
        return;
    }


    player.lives--;


    /*
     * The player DOES NOT respawn.
     *
     * They remain where they are.
     */

    player.invulnerableUntil =
        now+
        INVULNERABILITY_SECONDS*1000;


    broadcast({

        type:"playerHit",

        id:player.id,

        lives:player.lives,

        invulnerableUntil:
            player.invulnerableUntil

    });


    if(
        player.lives<=0
    ){

        player.alive=false;


        send(
            player.socket,
            {

                type:"gameOver",

                score:player.score

            }
        );


        broadcast({

            type:"playerGameOver",

            id:player.id

        });

    }else{

        /*
         * The rocket remains alive and exactly where it is.
         */

        send(
            player.socket,
            {

                type:"hit",

                lives:player.lives,

                invulnerableUntil:
                    player.invulnerableUntil

            }
        );

    }

}


/* =========================================================
   CONNECTION
========================================================= */

const httpServer =
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


const wss =
    new WebSocket.Server({
        server:httpServer
    });


wss.on(
    "connection",
    socket=>{

        const playerID=id();


        const player =
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


        sendWorld(socket);


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


                if(
                    msg.type==="join"
                ){

                    if(
                        typeof msg.name===
                        "string"
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