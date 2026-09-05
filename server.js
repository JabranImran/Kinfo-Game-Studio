const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;

const WORLD_WIDTH = 1200;
const WORLD_HEIGHT = 800;

const MAX_ASTEROIDS = 28;
const TICK_RATE = 30;

const httpServer = http.createServer((req, res) => {
    res.writeHead(200, {
        "Content-Type": "text/plain"
    });

    res.end("Rocket Impact Multiplayer Server is running!");
});

const wss = new WebSocket.Server({
    server: httpServer
});

const players = new Map();
const asteroids = new Map();

let asteroidCounter = 0;

/* ---------------------------------------------------------
   UTILITIES
--------------------------------------------------------- */

function makeID() {
    return Math.random().toString(36).substring(2, 10);
}

function random(min, max) {
    return Math.random() * (max - min) + min;
}

function distance(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;

    return Math.sqrt(dx * dx + dy * dy);
}

function send(socket, data) {
    if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(data));
    }
}

function broadcast(data) {
    const message = JSON.stringify(data);

    for (const socket of wss.clients) {
        if (socket.readyState === WebSocket.OPEN) {
            socket.send(message);
        }
    }
}

/* ---------------------------------------------------------
   ASTEROIDS
--------------------------------------------------------- */

function createAsteroid(size = null) {
    const asteroid = {
        id: `a${asteroidCounter++}`,

        x: random(40, WORLD_WIDTH - 40),
        y: random(40, WORLD_HEIGHT - 40),

        vx: random(-1.4, 1.4),
        vy: random(-1.4, 1.4),

        size: size || random(22, 48),

        rotation: random(0, Math.PI * 2),
        rotationSpeed: random(-0.025, 0.025)
    };

    asteroids.set(asteroid.id, asteroid);

    return asteroid;
}

function fillAsteroids() {
    while (asteroids.size < MAX_ASTEROIDS) {
        createAsteroid();
    }
}

function removeAsteroid(id) {
    asteroids.delete(id);
}

/* ---------------------------------------------------------
   PLAYER STATE
--------------------------------------------------------- */

function createPlayer(id, socket) {
    return {
        id,
        socket,

        x: WORLD_WIDTH / 2,
        y: WORLD_HEIGHT / 2,

        angle: -Math.PI / 2,

        lives: 3,
        score: 0,

        alive: true,

        respawnTimer: 0,

        name: "Rocket"
    };
}

/* ---------------------------------------------------------
   STATE PACKETS
--------------------------------------------------------- */

function playerState(player) {
    return {
        id: player.id,
        x: player.x,
        y: player.y,
        angle: player.angle,
        lives: player.lives,
        score: player.score,
        alive: player.alive,
        name: player.name
    };
}

function asteroidState(asteroid) {
    return {
        id: asteroid.id,
        x: asteroid.x,
        y: asteroid.y,
        vx: asteroid.vx,
        vy: asteroid.vy,
        size: asteroid.size,
        rotation: asteroid.rotation,
        rotationSpeed: asteroid.rotationSpeed
    };
}

function sendWorld(socket) {
    send(socket, {
        type: "world",
        width: WORLD_WIDTH,
        height: WORLD_HEIGHT,

        players: Array.from(players.values()).map(playerState),

        asteroids: Array.from(asteroids.values()).map(asteroidState)
    });
}

/* ---------------------------------------------------------
   PLAYER BROADCAST
--------------------------------------------------------- */

function broadcastWorld() {
    const packet = {
        type: "world",

        width: WORLD_WIDTH,
        height: WORLD_HEIGHT,

        players: Array.from(players.values()).map(playerState),

        asteroids: Array.from(asteroids.values()).map(asteroidState)
    };

    broadcast(packet);
}

/* ---------------------------------------------------------
   BLAST
--------------------------------------------------------- */

function performBlast(player, x, y, blastSize) {

    if (!player.alive) {
        return;
    }

    const destroyed = [];

    for (const asteroid of asteroids.values()) {

        const d = Math.hypot(
            asteroid.x - x,
            asteroid.y - y
        );

        const radius =
            blastSize +
            asteroid.size;

        if (d < radius) {

            /* Bigger asteroids split instead of simply vanishing */

            if (asteroid.size > 34) {

                const newSize = asteroid.size * 0.58;

                removeAsteroid(asteroid.id);

                const a1 = createAsteroid(newSize);
                const a2 = createAsteroid(newSize);

                a1.x = asteroid.x;
                a1.y = asteroid.y;

                a2.x = asteroid.x;
                a2.y = asteroid.y;

                a1.vx = asteroid.vx + random(-1.5, 1.5);
                a1.vy = asteroid.vy + random(-1.5, 1.5);

                a2.vx = asteroid.vx + random(-1.5, 1.5);
                a2.vy = asteroid.vy + random(-1.5, 1.5);

            } else {

                removeAsteroid(asteroid.id);

            }

            destroyed.push(asteroid.id);

            player.score += Math.round(
                asteroid.size * 10
            );

            continue;
        }

        /* Deflection */

        if (d < blastSize * 3) {

            let dx = asteroid.x - x;
            let dy = asteroid.y - y;

            const length =
                Math.sqrt(dx * dx + dy * dy) || 1;

            dx /= length;
            dy /= length;

            const force =
                (1 - d / (blastSize * 3)) * 3;

            asteroid.vx += dx * force;
            asteroid.vy += dy * force;
        }
    }

    broadcast({
        type: "blast",

        playerId: player.id,

        x,
        y,

        size: blastSize,

        destroyed
    });

    broadcast({
        type: "score",

        playerId: player.id,

        score: player.score
    });
}

/* ---------------------------------------------------------
   PLAYER DAMAGE
--------------------------------------------------------- */

function killPlayer(player) {

    if (!player.alive) {
        return;
    }

    player.lives--;

    player.alive = false;

    player.respawnTimer = 90;

    send(player.socket, {
        type: "death",

        lives: player.lives
    });

    broadcast({
        type: "playerDeath",

        id: player.id,

        lives: player.lives
    });

    /* Game over */

    if (player.lives <= 0) {

        send(player.socket, {
            type: "gameOver",

            score: player.score
        });

        return;
    }
}

/* ---------------------------------------------------------
   RESPAWN
--------------------------------------------------------- */

function respawnPlayer(player) {

    player.x = WORLD_WIDTH / 2 + random(-120, 120);
    player.y = WORLD_HEIGHT / 2 + random(-120, 120);

    player.angle = -Math.PI / 2;

    player.alive = true;

    player.respawnTimer = 0;

    send(player.socket, {
        type: "respawn",

        player: playerState(player)
    });

    broadcast({
        type: "playerRespawn",

        player: playerState(player)
    });
}

/* ---------------------------------------------------------
   GAME LOOP
--------------------------------------------------------- */

function updateWorld() {

    /* Move asteroids */

    for (const asteroid of asteroids.values()) {

        asteroid.x += asteroid.vx;
        asteroid.y += asteroid.vy;

        asteroid.rotation += asteroid.rotationSpeed;

        /* Wrap around */

        if (asteroid.x < -asteroid.size) {
            asteroid.x =
                WORLD_WIDTH + asteroid.size;
        }

        if (asteroid.x > WORLD_WIDTH + asteroid.size) {
            asteroid.x =
                -asteroid.size;
        }

        if (asteroid.y < -asteroid.size) {
            asteroid.y =
                WORLD_HEIGHT + asteroid.size;
        }

        if (asteroid.y > WORLD_HEIGHT + asteroid.size) {
            asteroid.y =
                -asteroid.size;
        }

        /* Limit speed */

        const speed =
            Math.sqrt(
                asteroid.vx * asteroid.vx +
                asteroid.vy * asteroid.vy
            );

        const maxSpeed = 4;

        if (speed > maxSpeed) {

            asteroid.vx =
                asteroid.vx / speed * maxSpeed;

            asteroid.vy =
                asteroid.vy / speed * maxSpeed;
        }
    }

    /* Player / asteroid collisions */

    for (const player of players.values()) {

        if (!player.alive) {

            if (player.respawnTimer > 0) {
                player.respawnTimer--;
            }

            if (
                player.respawnTimer <= 0 &&
                player.lives > 0
            ) {
                respawnPlayer(player);
            }

            continue;
        }

        for (const asteroid of asteroids.values()) {

            const d = distance(player, asteroid);

            if (
                d <
                asteroid.size + 18
            ) {

                killPlayer(player);

                break;
            }
        }
    }

    fillAsteroids();
}

/* ---------------------------------------------------------
   WEBSOCKET
--------------------------------------------------------- */

wss.on("connection", socket => {

    const id = makeID();

    const player =
        createPlayer(id, socket);

    players.set(id, player);

    socket.playerId = id;

    console.log(
        "Player connected:",
        id
    );

    /* Tell client its permanent ID */

    send(socket, {
        type: "welcome",

        id,

        worldWidth: WORLD_WIDTH,

        worldHeight: WORLD_HEIGHT
    });

    /* Immediately send current universe */

    sendWorld(socket);

    broadcast({
        type: "playerJoined",

        player: playerState(player)
    });

    socket.on("message", raw => {

        let message;

        try {
            message =
                JSON.parse(
                    raw.toString()
                );
        } catch {
            return;
        }

        const currentPlayer =
            players.get(id);

        if (!currentPlayer) {
            return;
        }

        /* ---------------------------------------------
           JOIN
        --------------------------------------------- */

        if (message.type === "join") {

            if (
                typeof message.name === "string" &&
                message.name.trim()
            ) {
                currentPlayer.name =
                    message.name
                        .trim()
                        .substring(0, 16);
            }

            sendWorld(socket);

            broadcast({
                type: "playerUpdated",

                player:
                    playerState(currentPlayer)
            });

            return;
        }

        /* ---------------------------------------------
           PLAYER STATE
        --------------------------------------------- */

        if (message.type === "state") {

            if (!currentPlayer.alive) {
                return;
            }

            if (
                Number.isFinite(
                    Number(message.x)
                )
            ) {
                currentPlayer.x =
                    Math.max(
                        0,
                        Math.min(
                            WORLD_WIDTH,
                            Number(message.x)
                        )
                    );
            }

            if (
                Number.isFinite(
                    Number(message.y)
                )
            ) {
                currentPlayer.y =
                    Math.max(
                        0,
                        Math.min(
                            WORLD_HEIGHT,
                            Number(message.y)
                        )
                    );
            }

            if (
                Number.isFinite(
                    Number(message.angle)
                )
            ) {
                currentPlayer.angle =
                    Number(message.angle);
            }

            return;
        }

        /* ---------------------------------------------
           BLAST
        --------------------------------------------- */

        if (message.type === "blast") {

            if (!currentPlayer.alive) {
                return;
            }

            const x =
                Number(message.x);

            const y =
                Number(message.y);

            const size =
                Number(message.size);

            if (
                !Number.isFinite(x) ||
                !Number.isFinite(y)
            ) {
                return;
            }

            performBlast(
                currentPlayer,
                x,
                y,
                Math.max(
                    10,
                    Math.min(
                        100,
                        Number.isFinite(size)
                            ? size
                            : 30
                    )
                )
            );

            return;
        }

        /* ---------------------------------------------
           REQUEST WORLD
        --------------------------------------------- */

        if (message.type === "requestWorld") {

            sendWorld(socket);

            return;
        }
    });

    socket.on("close", () => {

        /*
         * THIS IS THE IMPORTANT FIX:
         *
         * A player is only removed when their actual
         * WebSocket connection closes.
         *
         * Death does NOT remove the player.
         */

        players.delete(id);

        console.log(
            "Player disconnected:",
            id
        );

        broadcast({
            type: "playerLeft",

            id
        });
    });

    socket.on("error", error => {

        console.log(
            "WebSocket error:",
            error.message
        );
    });
});

/* ---------------------------------------------------------
   SERVER LOOP
--------------------------------------------------------- */

fillAsteroids();

setInterval(
    () => {

        updateWorld();

        broadcastWorld();

    },
    1000 / TICK_RATE
);

/* ---------------------------------------------------------
   START
--------------------------------------------------------- */

httpServer.listen(
    PORT,
    "0.0.0.0",
    () => {

        console.log(
            `Rocket Impact multiplayer server running on port ${PORT}`
        );

        console.log(
            `World: ${WORLD_WIDTH} x ${WORLD_HEIGHT}`
        );

        console.log(
            `Asteroids: ${MAX_ASTEROIDS}`
        );
    }
);