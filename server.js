const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;

const WORLD_WIDTH = 1200;
const WORLD_HEIGHT = 800;

const MAX_ASTEROIDS = 28;

const TICK_RATE = 30;

const players = new Map();
const asteroids = new Map();

let asteroidCounter = 0;


/* =========================================================
   UTILITIES
========================================================= */

function makeID(){

    return Math.random()
        .toString(36)
        .substring(2,10);

}


function random(
    min,
    max
){

    return Math.random()*
        (max-min)+min;

}


function distance(
    a,
    b
){

    return Math.hypot(
        a.x-b.x,
        a.y-b.y
    );

}


function send(
    socket,
    data
){

    if(
        socket.readyState===
        WebSocket.OPEN
    ){

        socket.send(
            JSON.stringify(data)
        );

    }

}


function broadcast(
    data
){

    const message=
        JSON.stringify(data);

    for(
        const socket
        of wss.clients
    ){

        if(
            socket.readyState===
            WebSocket.OPEN
        ){

            socket.send(
                message
            );

        }

    }

}


/* =========================================================
   ASTEROIDS
========================================================= */

function createAsteroid(
    size=null,
    x=null,
    y=null
){

    const asteroid={

        id:
            `a${asteroidCounter++}`,

        x:
            x===null
            ?random(
                40,
                WORLD_WIDTH-40
            )
            :x,

        y:
            y===null
            ?random(
                40,
                WORLD_HEIGHT-40
            )
            :y,

        vx:
            random(
                -1.4,
                1.4
            ),

        vy:
            random(
                -1.4,
                1.4
            ),

        size:
            size ||
            random(
                22,
                48
            ),

        rotation:
            random(
                0,
                Math.PI*2
            ),

        rotationSpeed:
            random(
                -.025,
                .025
            )

    };


    asteroids.set(
        asteroid.id,
        asteroid
    );


    return asteroid;

}


function fillAsteroids(){

    while(
        asteroids.size<
        MAX_ASTEROIDS
    ){

        createAsteroid();

    }

}


function removeAsteroid(
    id
){

    asteroids.delete(id);

}


/* =========================================================
   PLAYERS
========================================================= */

function createPlayer(
    id,
    socket
){

    return {

        id,

        socket,

        x:
            WORLD_WIDTH/2,

        y:
            WORLD_HEIGHT/2,

        angle:
            -Math.PI/2,

        lives:3,

        score:0,

        alive:true,

        respawnTimer:0,

        name:"Rocket"

    };

}


function playerState(
    player
){

    return {

        id:
            player.id,

        x:
            player.x,

        y:
            player.y,

        angle:
            player.angle,

        lives:
            player.lives,

        score:
            player.score,

        alive:
            player.alive,

        name:
            player.name

    };

}


function asteroidState(
    asteroid
){

    return {

        id:
            asteroid.id,

        x:
            asteroid.x,

        y:
            asteroid.y,

        vx:
            asteroid.vx,

        vy:
            asteroid.vy,

        size:
            asteroid.size,

        rotation:
            asteroid.rotation,

        rotationSpeed:
            asteroid.rotationSpeed

    };

}


/* =========================================================
   WORLD STATE
========================================================= */

function sendWorld(
    socket
){

    send(
        socket,
        {

            type:"world",

            width:
                WORLD_WIDTH,

            height:
                WORLD_HEIGHT,

            players:
                Array.from(
                    players.values()
                ).map(
                    playerState
                ),

            asteroids:
                Array.from(
                    asteroids.values()
                ).map(
                    asteroidState
                )

        }
    );

}


function broadcastWorld(){

    broadcast({

        type:"world",

        width:
            WORLD_WIDTH,

        height:
            WORLD_HEIGHT,

        players:
            Array.from(
                players.values()
            ).map(
                playerState
            ),

        asteroids:
            Array.from(
                asteroids.values()
            ).map(
                asteroidState
            )

    });

}


/* =========================================================
   ASTEROID EXPLOSION / DEFLECTION
========================================================= */

/*
 * IMPORTANT:
 *
 * The asteroid that was actually tapped is destroyed.
 *
 * The other asteroids nearby are NOT destroyed.
 *
 * They are simply pushed away by the explosion.
 *
 * This mirrors the original game's behaviour.
 */

function performBlast(
    player,
    x,
    y,
    blastSize
){

    if(
        !player.alive
    ){

        return;

    }


    /*
     * -------------------------------------------------------
     * STEP 1
     *
     * Find the ONE asteroid actually being tapped.
     * -------------------------------------------------------
     *
     * We choose the closest asteroid whose body is under
     * the tap point.
     *
     * This is deliberately NOT the same as the explosion
     * radius.
     */

    let target=null;

    let targetDistance=Infinity;


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
         * A generous tap hitbox makes mobile controls feel
         * forgiving without allowing the blast to destroy
         * everything nearby.
         */

        const hitRadius=
            asteroid.size+
            18;


        if(
            d<=hitRadius &&
            d<targetDistance
        ){

            target=
                asteroid;

            targetDistance=
                d;

        }

    }


    /*
     * If the player didn't actually tap an asteroid, the
     * explosion does nothing.
     */

    if(!target){

        return;

    }


    /*
     * -------------------------------------------------------
     * STEP 2
     *
     * Remove ONLY the asteroid that was tapped.
     * -------------------------------------------------------
     */

    const targetX=
        target.x;

    const targetY=
        target.y;

    const targetSize=
        target.size;


    removeAsteroid(
        target.id
    );


    /*
     * Score is based on the asteroid that was actually hit.
     */

    player.score+=
        Math.round(
            targetSize*10
        );


    /*
     * -------------------------------------------------------
     * STEP 3
     *
     * Explosion power.
     *
     * Larger asteroids create a stronger explosion.
     * -------------------------------------------------------
     */

    let explosionPower=
        targetSize>=40
        ?1.8
        :targetSize>=30
        ?1.35
        :1;


    /*
     * The physical blast radius.
     */

    const radius=
        110*
        explosionPower;


    /*
     * -------------------------------------------------------
     * STEP 4
     *
     * DEFLECT nearby asteroids.
     *
     * They survive.
     *
     * Their velocity is changed.
     * -------------------------------------------------------
     */

    for(
        const other
        of asteroids.values()
    ){

        const dx=
            other.x-
            targetX;

        const dy=
            other.y-
            targetY;


        const dist=
            Math.hypot(
                dx,
                dy
            );


        /*
         * Ignore rocks outside the explosion.
         */

        if(
            dist>=radius ||
            dist<=1
        ){

            continue;

        }


        /*
         * How strong is the explosion at this distance?
         *
         * 1.0 = directly beside explosion
         * 0.0 = edge of explosion
         */

        const falloff=
            1-
            dist/radius;


        /*
         * Same basic force relationship as the original game.
         *
         * The important part is that this changes velocity
         * rather than deleting the asteroid.
         */

        const strength=
            falloff*
            220*
            explosionPower;


        /*
         * Normal pointing AWAY from the explosion.
         */

        const nx=
            dx/dist;

        const ny=
            dy/dist;


        /*
         * Radial kick.
         */

        other.vx+=
            nx*
            strength;

        other.vy+=
            ny*
            strength;


        /*
         * Tangential kick.
         *
         * This gives the rocks a nice curved / chaotic
         * deflection rather than every asteroid simply flying
         * directly away from the blast.
         */

        other.vx+=
            -ny*
            strength*
            .35;

        other.vy+=
            nx*
            strength*
            .35;


        /*
         * Give the client a little visual feedback.
         */

        other.hitFlash=
            .18;


        /*
         * ---------------------------------------------------
         * SMALL CHAIN REACTION CHANCE
         * ---------------------------------------------------
         *
         * Being near a blast can occasionally trigger another
         * asteroid.
         *
         * This is deliberately LOW.
         *
         * The normal behaviour is:
         *
         *       💥 asteroid
         *          ↓
         *      nearby rocks
         *       ↙ ↓ ↘
         *     💨 💨 💨
         *
         * NOT:
         *
         *       💥
         *      💥💥💥
         */

        const chance=
            .025+
            falloff*
            .12;


        if(
            Math.random()<
            chance
        ){

            /*
             * Queue a delayed chain reaction.
             *
             * Re-check that the asteroid still exists before
             * detonating it.
             */

            const asteroidId=
                other.id;


            setTimeout(
                ()=>{

                    const chained=
                        asteroids.get(
                            asteroidId
                        );


                    if(
                        !chained
                    ){

                        return;

                    }


                    /*
                     * Chain detonation destroys THIS asteroid,
                     * then deflects the ones around it.
                     */

                    performChainExplosion(
                        player,
                        chained
                    );

                },
                random(
                    60,
                    180
                )
            );

        }

    }


    /*
     * -------------------------------------------------------
     * STEP 5
     *
     * Split the destroyed asteroid.
     *
     * This is intentionally done AFTER the explosion force is
     * applied, so the nearby original rocks are pushed away.
     * -------------------------------------------------------
     */

    if(
        targetSize>34
    ){

        const childSize=
            targetSize*.58;


        const childCount=2;


        for(
            let i=0;
            i<childCount;
            i++
        ){

            const angle=
                Math.PI*2/
                childCount*
                i+
                random(
                    -.4,
                    .4
                );


            const child=
                createAsteroid(
                    childSize,

                    targetX+
                    Math.cos(angle)*
                    15,

                    targetY+
                    Math.sin(angle)*
                    15
                );


            /*
             * Shards fly away from the destroyed asteroid.
             */

            const speed=
                random(
                    1.8,
                    3.5
                );


            child.vx=
                Math.cos(angle)*
                speed;

            child.vy=
                Math.sin(angle)*
                speed;

        }

    }


    /*
     * Send the visual explosion to everyone.
     */

    broadcast({

        type:"blast",

        playerId:
            player.id,

        x:
            targetX,

        y:
            targetY,

        size:
            32,

        destroyed:[
            target.id
        ]

    });


    /*
     * Update score.

     */

    broadcast({

        type:"score",

        playerId:
            player.id,

        score:
            player.score

    });

}


/* =========================================================
   CHAIN EXPLOSION
========================================================= */

/*
 * Same rules as a normal explosion, except there is no
 * additional player input.
 *
 * The asteroid itself dies.
 *
 * Nearby asteroids are deflected.
 */

function performChainExplosion(
    player,
    target
){

    if(
        !asteroids.has(
            target.id
        )
    ){

        return;

    }


    const targetX=
        target.x;

    const targetY=
        target.y;

    const targetSize=
        target.size;


    removeAsteroid(
        target.id
    );


    player.score+=
        Math.round(
            targetSize*10
        );


    let explosionPower=
        targetSize>=40
        ?1.8
        :targetSize>=30
        ?1.35
        :1;


    const radius=
        110*
        explosionPower;


    /*
     * Deflect neighbours.
     */

    for(
        const other
        of asteroids.values()
    ){

        const dx=
            other.x-
            targetX;

        const dy=
            other.y-
            targetY;

        const dist=
            Math.hypot(
                dx,
                dy
            );


        if(
            dist>=radius ||
            dist<=1
        ){

            continue;

        }


        const falloff=
            1-
            dist/radius;


        const strength=
            falloff*
            220*
            explosionPower;


        const nx=
            dx/dist;

        const ny=
            dy/dist;


        other.vx+=
            nx*
            strength;

        other.vy+=
            ny*
            strength;


        other.vx+=
            -ny*
            strength*
            .35;

        other.vy+=
            nx*
            strength*
            .35;


        other.hitFlash=
            .18;

    }


    /*
     * Tell clients about the chain explosion.
     */

    broadcast({

        type:"blast",

        playerId:
            player.id,

        x:
            targetX,

        y:
            targetY,

        size:
            32,

        destroyed:[
            target.id
        ]

    });


    broadcast({

        type:"score",

        playerId:
            player.id,

        score:
            player.score

    });

}


/* =========================================================
   PLAYER DAMAGE
========================================================= */

function killPlayer(
    player
){

    if(
        !player.alive
    ){

        return;

    }


    player.lives--;

    player.alive=
        false;

    player.respawnTimer=
        90;


    send(
        player.socket,
        {

            type:"death",

            lives:
                player.lives

        }
    );


    broadcast({

        type:"playerDeath",

        id:
            player.id,

        lives:
            player.lives

    });


    /*
     * No lives remaining.
     */

    if(
        player.lives<=0
    ){

        send(
            player.socket,
            {

                type:"gameOver",

                score:
                    player.score

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
        random(
            -120,
            120
        );

    player.y=
        WORLD_HEIGHT/2+
        random(
            -120,
            120
        );

    player.angle=
        -Math.PI/2;

    player.alive=
        true;

    player.respawnTimer=
        0;


    send(
        player.socket,
        {

            type:"respawn",

            player:
                playerState(
                    player
                )

        }
    );


    broadcast({

        type:"playerRespawn",

        player:
            playerState(
                player
            )

    });

}


/* =========================================================
   ASTEROID PHYSICS
========================================================= */

function updateWorld(){

    /*
     * Move asteroids.
     */

    for(
        const asteroid
        of asteroids.values()
    ){

        asteroid.x+=
            asteroid.vx;

        asteroid.y+=
            asteroid.vy;


        asteroid.rotation+=
            asteroid.rotationSpeed;


        /*
         * World wrapping.
         */

        if(
            asteroid.x<
            -asteroid.size
        ){

            asteroid.x=
                WORLD_WIDTH+
                asteroid.size;

        }


        if(
            asteroid.x>
            WORLD_WIDTH+
            asteroid.size
        ){

            asteroid.x=
                -asteroid.size;

        }


        if(
            asteroid.y<
            -asteroid.size
        ){

            asteroid.y=
                WORLD_HEIGHT+
                asteroid.size;

        }


        if(
            asteroid.y>
            WORLD_HEIGHT+
            asteroid.size
        ){

            asteroid.y=
                -asteroid.size;

        }


        /*
         * Limit maximum speed.
         *
         * Explosions can give a very large impulse, so this
         * keeps the field playable.
         */

        const speed=
            Math.hypot(
                asteroid.vx,
                asteroid.vy
            );


        const maxSpeed=
            7;


        if(
            speed>
            maxSpeed
        ){

            asteroid.vx=
                asteroid.vx/
                speed*
                maxSpeed;

            asteroid.vy=
                asteroid.vy/
                speed*
                maxSpeed;

        }

    }


    /*
     * Player collisions.
     */

    for(
        const player
        of players.values()
    ){

        if(
            !player.alive
        ){

            if(
                player.respawnTimer>0
            ){

                player.respawnTimer--;

            }


            if(
                player.respawnTimer<=0 &&
                player.lives>0
            ){

                respawnPlayer(
                    player
                );

            }

            continue;

        }


        for(
            const asteroid
            of asteroids.values()
        ){

            const d=
                distance(
                    player,
                    asteroid
                );


            if(
                d<
                asteroid.size+
                18
            ){

                killPlayer(
                    player
                );

                break;

            }

        }

    }


    /*
     * Maintain asteroid population.
     */

    fillAsteroids();

}


/* =========================================================
   HTTP SERVER
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
   WEBSOCKET SERVER
========================================================= */

const wss=
    new WebSocket.Server({

        server:
            httpServer

    });


wss.on(
    "connection",
    socket=>{

        const id=
            makeID();


        const player=
            createPlayer(
                id,
                socket
            );


        players.set(
            id,
            player
        );


        socket.playerId=
            id;


        console.log(
            "Player connected:",
            id
        );


        /*
         * Permanent ID for this connection.
         */

        send(
            socket,
            {

                type:"welcome",

                id,

                worldWidth:
                    WORLD_WIDTH,

                worldHeight:
                    WORLD_HEIGHT

            }
        );


        /*
         * Send current universe.
         */

        sendWorld(
            socket
        );


        broadcast({

            type:"playerJoined",

            player:
                playerState(
                    player
                )

        });


        socket.on(
            "message",
            raw=>{

                let message;


                try{

                    message=
                        JSON.parse(
                            raw.toString()
                        );

                }catch{

                    return;

                }


                const currentPlayer=
                    players.get(
                        id
                    );


                if(
                    !currentPlayer
                ){

                    return;

                }


                /* -----------------------------------------
                   JOIN
                ----------------------------------------- */

                if(
                    message.type===
                    "join"
                ){

                    if(
                        typeof
                        message.name===
                        "string" &&
                        message.name.trim()
                    ){

                        currentPlayer.name=
                            message.name
                            .trim()
                            .substring(
                                0,
                                16
                            );

                    }


                    sendWorld(
                        socket
                    );


                    broadcast({

                        type:
                            "playerUpdated",

                        player:
                            playerState(
                                currentPlayer
                            )

                    });


                    return;

                }


                /* -----------------------------------------
                   PLAYER STATE
                ----------------------------------------- */

                if(
                    message.type===
                    "state"
                ){

                    if(
                        !currentPlayer.alive
                    ){

                        return;

                    }


                    const x=
                        Number(
                            message.x
                        );

                    const y=
                        Number(
                            message.y
                        );

                    const angle=
                        Number(
                            message.angle
                        );


                    if(
                        Number.isFinite(x)
                    ){

                        currentPlayer.x=
                            Math.max(
                                0,
                                Math.min(
                                    WORLD_WIDTH,
                                    x
                                )
                            );

                    }


                    if(
                        Number.isFinite(y)
                    ){

                        currentPlayer.y=
                            Math.max(
                                0,
                                Math.min(
                                    WORLD_HEIGHT,
                                    y
                                )
                            );

                    }


                    if(
                        Number.isFinite(angle)
                    ){

                        currentPlayer.angle=
                            angle;

                    }


                    return;

                }


                /* -----------------------------------------
                   BLAST
                ----------------------------------------- */

                if(
                    message.type===
                    "blast"
                ){

                    if(
                        !currentPlayer.alive
                    ){

                        return;

                    }


                    const x=
                        Number(
                            message.x
                        );

                    const y=
                        Number(
                            message.y
                        );


                    if(
                        !Number.isFinite(x) ||
                        !Number.isFinite(y)
                    ){

                        return;

                    }


                    /*
                     * IMPORTANT:
                     *
                     * The server ignores the client's requested
                     * blast size for destruction.
                     *
                     * It finds the actual asteroid under the tap.
                     */

                    performBlast(

                        currentPlayer,

                        x,

                        y,

                        32

                    );


                    return;

                }


                /* -----------------------------------------
                   REQUEST WORLD
                ----------------------------------------- */

                if(
                    message.type===
                    "requestWorld"
                ){

                    sendWorld(
                        socket
                    );

                    return;

                }

            }
        );


        socket.on(
            "close",
            ()=>{

                /*
                 * Death does NOT reach this code.
                 *
                 * Only a genuine WebSocket disconnect removes
                 * the player.
                 */

                players.delete(
                    id
                );


                console.log(
                    "Player disconnected:",
                    id
                );


                broadcast({

                    type:"playerLeft",

                    id

                });

            }
        );


        socket.on(
            "error",
            error=>{

                console.log(
                    "WebSocket error:",
                    error.message
                );

            }
        );

    });


/* =========================================================
   INITIAL ASTEROIDS
========================================================= */

fillAsteroids();


/* =========================================================
   SERVER GAME LOOP
========================================================= */

setInterval(

    ()=>{

        updateWorld();

        broadcastWorld();

    },

    1000/TICK_RATE

);


/* =========================================================
   START SERVER
========================================================= */

httpServer.listen(

    PORT,

    "0.0.0.0",

    ()=>{

        console.log(
            `Rocket Impact Multiplayer Server running on port ${PORT}`
        );

        console.log(
            `World: ${WORLD_WIDTH} x ${WORLD_HEIGHT}`
        );

        console.log(
            `Asteroids: ${MAX_ASTEROIDS}`
        );

    }

);