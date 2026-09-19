const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;

const WORLD_WIDTH = 2400;
const WORLD_HEIGHT = 1600;

const TICK = 1000 / 30;
const TARGET_ASTEROIDS = 20;

const INVULNERABILITY_MS = 2500;

const POWERUP_THRESHOLDS = {
    speed: 1000,
    laser: 5000,
    heart: 10000
};

const players = new Map();
const asteroids = new Map();
const powerups = new Map();

let asteroidID = 0;
let powerupID = 0;


/* =========================================================
   UTILITIES
========================================================= */

function id() {
    return Math.random().toString(36).slice(2, 10);
}

function random(a, b) {
    return a + Math.random() * (b - a);
}

function clamp(v, a, b) {
    return Math.max(a, Math.min(b, v));
}

function wrap(v, max) {
    if (v < 0) return v + max;
    if (v >= max) return v - max;
    return v;
}

function send(ws, data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(data));
    }
}

function broadcast(data) {
    const text = JSON.stringify(data);

    for (const ws of wss.clients) {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(text);
        }
    }
}


/* =========================================================
   PLAYER
========================================================= */

function createPlayer(id, socket) {

    return {
        id,
        socket,

        x: random(200, WORLD_WIDTH - 200),
        y: random(200, WORLD_HEIGHT - 200),

        angle: -Math.PI / 2,

        lives: 3,
        score: 0,

        alive: true,

        invulnerableUntil: 0,

        username: "Rocket",
        colour: "#4fdcff",

        speedBoostUntil: 0,

        equippedPowerup: "tow",
        powerupCharges: 1,

        towAsteroidId: null,

        unlocked: {
            speed: false,
            laser: false,
            heart: false
        },

        lastScoreForPowerups: 0
    };
}


function playerState(p) {

    return {
        id: p.id,

        x: p.x,
        y: p.y,

        angle: p.angle,

        lives: p.lives,
        score: p.score,

        alive: p.alive,

        username: p.username,
        colour: p.colour,

        invulnerable:
            Date.now() < p.invulnerableUntil,

        speedBoost:
            Date.now() < p.speedBoostUntil,

        equippedPowerup:
            p.equippedPowerup,

        powerupCharges:
            p.powerupCharges,

        unlocked: p.unlocked
    };
}


/* =========================================================
   ASTEROIDS
========================================================= */

function asteroidRadius(size) {

    if (size === 3) return 30;
    if (size === 2) return 21;

    return 14;
}


function asteroidSpeed(size) {

    if (size === 3) return random(18, 30);
    if (size === 2) return random(28, 45);

    return random(45, 70);
}


function edgeSpawn() {

    const side = Math.floor(Math.random() * 4);
    const margin = 50;

    if (side === 0) {
        return {
            x: -margin,
            y: random(0, WORLD_HEIGHT)
        };
    }

    if (side === 1) {
        return {
            x: WORLD_WIDTH + margin,
            y: random(0, WORLD_HEIGHT)
        };
    }

    if (side === 2) {
        return {
            x: random(0, WORLD_WIDTH),
            y: -margin
        };
    }

    return {
        x: random(0, WORLD_WIDTH),
        y: WORLD_HEIGHT + margin
    };
}


function createAsteroid(
    x = null,
    y = null,
    size = null,
    ownerId = null,
    special = null
) {

    const pos =
        x === null
            ? edgeSpawn()
            : { x, y };


    const actualSize =
        size ||
        (
            Math.random() < 0.18
                ? 3
                : Math.random() < 0.38
                    ? 2
                    : 1
        );


    const targetX =
        WORLD_WIDTH / 2 +
        random(
            -WORLD_WIDTH * 0.25,
            WORLD_WIDTH * 0.25
        );


    const targetY =
        WORLD_HEIGHT / 2 +
        random(
            -WORLD_HEIGHT * 0.25,
            WORLD_HEIGHT * 0.25
        );


    const dx = targetX - pos.x;
    const dy = targetY - pos.y;

    const length =
        Math.hypot(dx, dy) || 1;

    const speed =
        asteroidSpeed(actualSize);


    const asteroid = {

        id: "a" + asteroidID++,

        x: pos.x,
        y: pos.y,

        size: actualSize,

        radius:
            asteroidRadius(actualSize),

        vx:
            dx / length * speed,

        vy:
            dy / length * speed,

        angle:
            random(0, Math.PI * 2),

        rotation:
            random(-0.015, 0.015),

        ownerId,

        special,

        hitFlash: 0

    };


    asteroids.set(
        asteroid.id,
        asteroid
    );


    return asteroid;
}


/* =========================================================
   SPECIAL POWERUP ASTEROIDS
========================================================= */

function spawnPowerupAsteroid(
    player,
    type
) {

    const angle =
        Math.random() *
        Math.PI *
        2;

    const distance =
        random(180, 330);


    const x =
        wrap(
            player.x +
            Math.cos(angle) * distance,
            WORLD_WIDTH
        );


    const y =
        wrap(
            player.y +
            Math.sin(angle) * distance,
            WORLD_HEIGHT
        );


    const asteroid =
        createAsteroid(
            x,
            y,
            2,
            player.id,
            type
        );


    asteroid.vx =
        Math.cos(angle + Math.PI) *
        random(15, 35);

    asteroid.vy =
        Math.sin(angle + Math.PI) *
        random(15, 35);


    broadcast({
        type: "specialAsteroid",
        x,
        y,
        powerup: type
    });
}


/* =========================================================
   POWERUP MILESTONES
========================================================= */

function checkPowerupMilestones(player) {

    const previous =
        player.lastScoreForPowerups;

    const current =
        player.score;


    /*
     * Speed every 1000 points.
     */

    const oldSpeedLevel =
        Math.floor(
            previous /
            POWERUP_THRESHOLDS.speed
        );

    const newSpeedLevel =
        Math.floor(
            current /
            POWERUP_THRESHOLDS.speed
        );


    for (
        let level = oldSpeedLevel + 1;
        level <= newSpeedLevel;
        level++
    ) {

        spawnPowerupAsteroid(
            player,
            "speed"
        );

    }


    /*
     * Laser every 5000 points.
     */

    const oldLaserLevel =
        Math.floor(
            previous /
            POWERUP_THRESHOLDS.laser
        );

    const newLaserLevel =
        Math.floor(
            current /
            POWERUP_THRESHOLDS.laser
        );


    for (
        let level = oldLaserLevel + 1;
        level <= newLaserLevel;
        level++
    ) {

        spawnPowerupAsteroid(
            player,
            "laser"
        );

    }


    /*
     * Hearts every 10000 points.
     */

    const oldHeartLevel =
        Math.floor(
            previous /
            POWERUP_THRESHOLDS.heart
        );

    const newHeartLevel =
        Math.floor(
            current /
            POWERUP_THRESHOLDS.heart
        );


    for (
        let level = oldHeartLevel + 1;
        level <= newHeartLevel;
        level++
    ) {

        spawnPowerupAsteroid(
            player,
            "heart"
        );

    }


    player.lastScoreForPowerups =
        current;
}


/* =========================================================
   ASTEROID UPDATE
========================================================= */

function updateAsteroids(dt) {

    for (
        const a of asteroids.values()
    ) {

        a.x += a.vx * dt;
        a.y += a.vy * dt;

        /*
         * Asteroids also wrap.
         */

        a.x = wrap(
            a.x,
            WORLD_WIDTH
        );

        a.y = wrap(
            a.y,
            WORLD_HEIGHT
        );


        a.angle +=
            a.rotation *
            dt *
            60;


        if (a.hitFlash > 0) {
            a.hitFlash -= dt;
        }
    }


    maintainAsteroids();
}


function maintainAsteroids() {

    while (
        asteroids.size <
        TARGET_ASTEROIDS
    ) {

        createAsteroid();

    }
}


/* =========================================================
   PLAYER WRAP
========================================================= */

function updatePlayerPosition(
    p
) {

    p.x =
        wrap(
            p.x,
            WORLD_WIDTH
        );

    p.y =
        wrap(
            p.y,
            WORLD_HEIGHT
        );
}


/* =========================================================
   ROCKET HITBOX
========================================================= */

const ROCKET_HITBOX = [

    { x: 0, y: -22 },

    { x: -9, y: 9 },

    { x: -6, y: 13 },

    { x: 0, y: 8 },

    { x: 6, y: 13 },

    { x: 9, y: 9 }

];


function rotatePoint(
    x,
    y,
    angle
) {

    const c = Math.cos(angle);
    const s = Math.sin(angle);

    return {
        x: x * c - y * s,
        y: x * s + y * c
    };
}


function pointSegmentDistance(
    px,
    py,
    ax,
    ay,
    bx,
    by
) {

    const abx = bx - ax;
    const aby = by - ay;

    const ab2 =
        abx * abx +
        aby * aby;


    if (ab2 === 0) {

        return Math.hypot(
            px - ax,
            py - ay
        );

    }


    const t = clamp(
        (
            (px - ax) * abx +
            (py - ay) * aby
        ) / ab2,
        0,
        1
    );


    const cx =
        ax + abx * t;

    const cy =
        ay + aby * t;


    return Math.hypot(
        px - cx,
        py - cy
    );
}


function pointInPolygon(
    px,
    py,
    polygon
) {

    let inside = false;


    for (
        let i = 0,
        j = polygon.length - 1;

        i < polygon.length;

        j = i++
    ) {

        const xi = polygon[i].x;
        const yi = polygon[i].y;

        const xj = polygon[j].x;
        const yj = polygon[j].y;


        const intersect =
            (
                yi > py
            ) !==
            (
                yj > py
            ) &&
            px <
            (
                xj - xi
            ) *
            (
                py - yi
            ) /
            (
                yj - yi
            ) +
            xi;


        if (intersect) {
            inside = !inside;
        }
    }


    return inside;
}


function wrappedDistance(
    a,
    b,
    size
) {

    let d =
        Math.abs(a - b);

    return Math.min(
        d,
        size - d
    );
}


function rocketHitsAsteroid(
    player,
    asteroid
) {

    const dx =
        wrappedDistance(
            player.x,
            asteroid.x,
            WORLD_WIDTH
        );

    const dy =
        wrappedDistance(
            player.y,
            asteroid.y,
            WORLD_HEIGHT
        );


    /*
     * Broad phase.
     */

    if (
        Math.hypot(dx, dy) >
        asteroid.radius + 30
    ) {
        return false;
    }


    /*
     * Find the nearest wrapped copy.
     */

    let ax = asteroid.x;
    let ay = asteroid.y;


    if (
        Math.abs(
            player.x - asteroid.x
        ) >
        WORLD_WIDTH / 2
    ) {

        ax +=
            player.x >
            asteroid.x
                ? WORLD_WIDTH
                : -WORLD_WIDTH;

    }


    if (
        Math.abs(
            player.y - asteroid.y
        ) >
        WORLD_HEIGHT / 2
    ) {

        ay +=
            player.y >
            asteroid.y
                ? WORLD_HEIGHT
                : -WORLD_HEIGHT;

    }


    const polygon =
        ROCKET_HITBOX.map(
            p => {

                const r =
                    rotatePoint(
                        p.x,
                        p.y,
                        player.angle
                    );

                return {
                    x: player.x + r.x,
                    y: player.y + r.y
                };

            }
        );


    if (
        pointInPolygon(
            ax,
            ay,
            polygon
        )
    ) {

        return true;

    }


    for (
        let i = 0;
        i < polygon.length;
        i++
    ) {

        const a =
            polygon[i];

        const b =
            polygon[
                (i + 1) %
                polygon.length
            ];


        if (
            pointSegmentDistance(
                ax,
                ay,
                a.x,
                a.y,
                b.x,
                b.y
            ) <=
            asteroid.radius
        ) {

            return true;

        }
    }


    return false;
}


/* =========================================================
   PLAYER COLLISIONS
========================================================= */

function checkPlayerCollisions() {

    const now =
        Date.now();


    for (
        const player of players.values()
    ) {

        if (!player.alive) {
            continue;
        }


        if (
            now <
            player.invulnerableUntil
        ) {
            continue;
        }


        /*
         * Speed powerup gives invulnerability.
         */

        if (
            now <
            player.speedBoostUntil
        ) {
            continue;
        }


        for (
            const asteroid of asteroids.values()
        ) {

            if (
                rocketHitsAsteroid(
                    player,
                    asteroid
                )
            ) {

                damagePlayer(
                    player,
                    asteroid.ownerId
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
    victim,
    killerId
) {

    if (!victim.alive) {
        return;
    }


    const now =
        Date.now();


    if (
        now <
        victim.invulnerableUntil
    ) {
        return;
    }


    victim.lives--;


    victim.invulnerableUntil =
        now +
        INVULNERABILITY_MS;


    /*
     * 10% of victim's score goes to the killer.
     */

    let stolen = 0;

    if (
        killerId &&
        killerId !== victim.id
    ) {

        const killer =
            players.get(killerId);


        if (killer) {

            stolen =
                Math.floor(
                    victim.score * 0.10
                );


            victim.score =
                Math.max(
                    0,
                    victim.score -
                    stolen
                );


            killer.score += stolen;


            checkPowerupMilestones(
                killer
            );


            send(
                killer.socket,
                {
                    type: "killReward",
                    amount: stolen,
                    victim: victim.username
                }
            );

        }
    }


    broadcast({

        type: "playerHit",

        id: victim.id,

        lives: victim.lives,

        invulnerableUntil:
            victim.invulnerableUntil,

        stolen

    });


    if (
        victim.lives <= 0
    ) {

        victim.alive = false;


        /*
         * Remove tow asteroid.
         */

        if (
            victim.towAsteroidId
        ) {

            asteroids.delete(
                victim.towAsteroidId
            );

            victim.towAsteroidId =
                null;
        }


        send(
            victim.socket,
            {
                type: "gameOver",
                score: victim.score
            }
        );


        broadcast({

            type: "playerGameOver",

            id: victim.id,

            username:
                victim.username

        });


    } else {

        send(
            victim.socket,
            {

                type: "hit",

                lives: victim.lives,

                invulnerableUntil:
                    victim.invulnerableUntil

            }
        );
    }
}


/* =========================================================
   EXPLOSION / DEFLECTION
========================================================= */

function detonateAsteroid(
    player,
    target
) {

    if (
        !target ||
        !asteroids.has(target.id)
    ) {
        return;
    }


    /*
     * Special asteroid gives its powerup rather than
     * behaving like an ordinary asteroid.
     */

    if (target.special) {

        collectPowerup(
            player,
            target.special
        );

        asteroids.delete(
            target.id
        );


        broadcast({

            type: "blast",

            x: target.x,
            y: target.y,

            power: 1.4,

            asteroidId: target.id

        });


        return;
    }


    asteroids.delete(
        target.id
    );


    const power =
        target.size === 3
            ? 1.8
            : target.size === 2
                ? 1.35
                : 1;


    const radius =
        110 * power;


    for (
        const other of asteroids.values()
    ) {

        const dx =
            other.x -
            target.x;

        const dy =
            other.y -
            target.y;


        const distance =
            Math.hypot(dx, dy);


        if (
            distance >= radius ||
            distance <= 1
        ) {
            continue;
        }


        const falloff =
            1 -
            distance / radius;


        const strength =
            falloff *
            220 *
            power;


        const nx =
            dx / distance;

        const ny =
            dy / distance;


        other.vx +=
            nx * strength;

        other.vy +=
            ny * strength;


        other.vx +=
            -ny *
            strength *
            0.35;

        other.vy +=
            nx *
            strength *
            0.35;


        /*
         * The player who caused the deflection becomes
         * responsible for this asteroid.
         */

        other.ownerId =
            player.id;


        other.hitFlash =
            0.18;
    }


    /*
     * Split larger asteroids.
     */

    if (target.size > 1) {

        const pieces =
            target.size === 3
                ? 3
                : 2;


        for (
            let i = 0;
            i < pieces;
            i++
        ) {

            const angle =
                Math.PI * 2 /
                pieces * i +
                random(-0.4, 0.4);


            const child =
                createAsteroid(
                    target.x,
                    target.y,
                    target.size - 1,
                    player.id
                );


            const speed =
                random(50, 120);


            child.vx =
                Math.cos(angle) *
                speed;

            child.vy =
                Math.sin(angle) *
                speed;
        }
    }


    const points =
        target.size === 3
            ? 100
            : target.size === 2
                ? 50
                : 24;


    const previous =
        player.score;


    player.score += points;


    checkPowerupMilestones(
        player
    );


    broadcast({

        type: "score",

        playerId: player.id,

        score: player.score

    });


    broadcast({

        type: "blast",

        x: target.x,
        y: target.y,

        power,

        asteroidId: target.id

    });
}


/* =========================================================
   POWERUPS
========================================================= */

function collectPowerup(
    player,
    type
) {

    player.equippedPowerup =
        type;


    /*
     * One immediate charge.
     */

    player.powerupCharges =
        Math.max(
            1,
            player.powerupCharges
        );


    if (
        type === "heart"
    ) {

        player.lives =
            Math.min(
                3,
                player.lives + 1
            );
    }


    if (
        type === "speed"
    ) {

        /*
         * Speed powerup itself lasts when activated,
         * not immediately when collected.
         */

    }


    broadcast({

        type: "powerupCollected",

        playerId: player.id,

        powerup: type,

        charges:
            player.powerupCharges,

        lives:
            player.lives

    });
}


/* =========================================================
   USE POWERUP
========================================================= */

function usePowerup(
    player
) {

    if (
        !player.alive ||
        player.powerupCharges <= 0
    ) {
        return;
    }


    const type =
        player.equippedPowerup;


    player.powerupCharges--;


    if (
        type === "tow"
    ) {

        /*
         * Spawn an asteroid that follows the player.
         */

        if (
            player.towAsteroidId
        ) {

            asteroids.delete(
                player.towAsteroidId
            );
        }


        const tow =
            createAsteroid(
                player.x,
                player.y,
                2,
                player.id,
                null
            );


        tow.isTow = true;

        player.towAsteroidId =
            tow.id;


        send(
            player.socket,
            {
                type: "powerupUsed",
                powerup: "tow",
                charges:
                    player.powerupCharges
            }
        );


        return;
    }


    if (
        type === "speed"
    ) {

        player.speedBoostUntil =
            Date.now() + 6000;


        send(
            player.socket,
            {
                type: "powerupUsed",
                powerup: "speed",
                charges:
                    player.powerupCharges,
                duration: 6000
            }
        );


        return;
    }


    if (
        type === "laser"
    ) {

        send(
            player.socket,
            {
                type: "laserReady",
                charges:
                    player.powerupCharges
            }
        );


        return;
    }


    if (
        type === "heart"
    ) {

        player.lives =
            Math.min(
                3,
                player.lives + 1
            );


        send(
            player.socket,
            {
                type: "powerupUsed",
                powerup: "heart",
                charges:
                    player.powerupCharges,
                lives:
                    player.lives
            }
        );
    }
}


/* =========================================================
   TOW ASTEROIDS
========================================================= */

function updateTowAsteroids() {

    for (
        const player of players.values()
    ) {

        if (
            !player.towAsteroidId
        ) {
            continue;
        }


        const tow =
            asteroids.get(
                player.towAsteroidId
            );


        if (!tow) {

            player.towAsteroidId =
                null;

            continue;
        }


        const behind =
            player.angle +
            Math.PI;


        tow.x =
            wrap(
                player.x +
                Math.cos(behind) * 45,
                WORLD_WIDTH
            );


        tow.y =
            wrap(
                player.y +
                Math.sin(behind) * 45,
                WORLD_HEIGHT
            );


        tow.vx = 0;
        tow.vy = 0;
    }
}


/* =========================================================
   BLAST AT POSITION
========================================================= */

function blastAt(
    player,
    x,
    y
) {

    if (!player.alive) {
        return;
    }


    let target = null;
    let closest = Infinity;


    for (
        const asteroid of asteroids.values()
    ) {

        let dx =
            Math.abs(
                asteroid.x - x
            );

        let dy =
            Math.abs(
                asteroid.y - y
            );


        dx =
            Math.min(
                dx,
                WORLD_WIDTH - dx
            );

        dy =
            Math.min(
                dy,
                WORLD_HEIGHT - dy
            );


        const d =
            Math.hypot(dx, dy);


        if (
            d <=
            asteroid.radius + 20 &&
            d < closest
        ) {

            closest = d;
            target = asteroid;

        }
    }


    if (target) {

        detonateAsteroid(
            player,
            target
        );
    }
}


/* =========================================================
   LEADERBOARD
========================================================= */

function leaderboard() {

    return [...players.values()]
        .filter(p => p.alive || p.score > 0)
        .sort(
            (a, b) =>
                b.score -
                a.score
        )
        .slice(0, 10)
        .map(
            (p, index) => ({
                rank: index + 1,
                id: p.id,
                username: p.username,
                score: p.score,
                colour: p.colour,
                alive: p.alive
            })
        );
}


/* =========================================================
   WORLD STATE
========================================================= */

function worldState() {

    return {

        type: "world",

        width: WORLD_WIDTH,
        height: WORLD_HEIGHT,

        players:
            [...players.values()]
                .map(playerState),

        asteroids:
            [...asteroids.values()]
                .map(a => ({
                    id: a.id,
                    x: a.x,
                    y: a.y,
                    vx: a.vx,
                    vy: a.vy,
                    size: a.size,
                    radius: a.radius,
                    angle: a.angle,
                    rotation: a.rotation,
                    special: a.special,
                    isTow: !!a.isTow,
                    hitFlash: a.hitFlash
                })),

        leaderboard:
            leaderboard()
    };
}


/* =========================================================
   CONNECTION
========================================================= */

const httpServer =
    http.createServer(
        (req, res) => {

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
        server: httpServer
    });


wss.on(
    "connection",
    socket => {

        const playerID =
            id();


        const player =
            createPlayer(
                playerID,
                socket
            );


        players.set(
            playerID,
            player
        );


        socket.playerID =
            playerID;


        send(
            socket,
            {
                type: "welcome",
                id: playerID,
                worldWidth: WORLD_WIDTH,
                worldHeight: WORLD_HEIGHT
            }
        );


        send(
            socket,
            worldState()
        );


        broadcast({
            type: "playerJoined",
            player: playerState(player)
        });


        socket.on(
            "message",
            raw => {

                let msg;


                try {

                    msg =
                        JSON.parse(
                            raw.toString()
                        );

                } catch {

                    return;

                }


                const p =
                    players.get(
                        playerID
                    );


                if (!p) {
                    return;
                }


                /* -------------------------
                   JOIN / PROFILE
                ------------------------- */

                if (
                    msg.type === "join"
                ) {

                    if (
                        typeof msg.name ===
                        "string"
                    ) {

                        p.username =
                            msg.name
                                .trim()
                                .slice(0, 16)
                                ||
                                "Rocket";
                    }


                    if (
                        typeof msg.colour ===
                        "string" &&
                        /^#[0-9a-fA-F]{6}$/
                            .test(msg.colour)
                    ) {

                        p.colour =
                            msg.colour;
                    }


                    broadcast({
                        type: "profileChanged",
                        player:
                            playerState(p)
                    });


                    send(
                        socket,
                        worldState()
                    );


                    return;
                }


                /* -------------------------
                   PLAYER STATE
                ------------------------- */

                if (
                    msg.type === "state"
                ) {

                    if (!p.alive) {
                        return;
                    }


                    if (
                        Number.isFinite(
                            Number(msg.x)
                        )
                    ) {

                        p.x =
                            Number(msg.x);

                    }


                    if (
                        Number.isFinite(
                            Number(msg.y)
                        )
                    ) {

                        p.y =
                            Number(msg.y);

                    }


                    if (
                        Number.isFinite(
                            Number(msg.angle)
                        )
                    ) {

                        p.angle =
                            Number(msg.angle);

                    }


                    updatePlayerPosition(
                        p
                    );


                    return;
                }


                /* -------------------------
                   ASTEROID TAP
                ------------------------- */

                if (
                    msg.type === "blast"
                ) {

                    const x =
                        Number(msg.x);

                    const y =
                        Number(msg.y);


                    if (
                        Number.isFinite(x) &&
                        Number.isFinite(y)
                    ) {

                        blastAt(
                            p,
                            x,
                            y
                        );
                    }


                    return;
                }


                /* -------------------------
                   POWERUP
                ------------------------- */

                if (
                    msg.type === "usePowerup"
                ) {

                    usePowerup(p);

                    return;
                }


                /* -------------------------
                   LASER
                ------------------------- */

                if (
                    msg.type === "laser"
                ) {

                    if (
                        p.equippedPowerup !==
                        "laser"
                    ) {
                        return;
                    }


                    if (
                        p.powerupCharges <= 0
                    ) {
                        return;
                    }


                    p.powerupCharges--;


                    /*
                     * Destroy the first asteroid
                     * in the rocket's forward cone.
                     */

                    let best = null;
                    let bestDistance =
                        Infinity;


                    for (
                        const a of asteroids.values()
                    ) {

                        let dx =
                            a.x - p.x;

                        let dy =
                            a.y - p.y;


                        /*
                         * Wrapped vector.
                         */

                        if (
                            Math.abs(dx) >
                            WORLD_WIDTH / 2
                        ) {

                            dx +=
                                dx > 0
                                    ? -WORLD_WIDTH
                                    : WORLD_WIDTH;
                        }


                        if (
                            Math.abs(dy) >
                            WORLD_HEIGHT / 2
                        ) {

                            dy +=
                                dy > 0
                                    ? -WORLD_HEIGHT
                                    : WORLD_HEIGHT;
                        }


                        const distance =
                            Math.hypot(
                                dx,
                                dy
                            );


                        if (
                            distance >
                            650
                        ) {
                            continue;
                        }


                        const direction =
                            Math.atan2(
                                dy,
                                dx
                            );


                        let difference =
                            direction -
                            p.angle;


                        while (
                            difference >
                            Math.PI
                        ) {
                            difference -=
                                Math.PI * 2;
                        }


                        while (
                            difference <
                            -Math.PI
                        ) {
                            difference +=
                                Math.PI * 2;
                        }


                        if (
                            Math.abs(
                                difference
                            ) < 0.15 &&
                            distance <
                            bestDistance
                        ) {

                            best =
                                a;

                            bestDistance =
                                distance;
                        }
                    }


                    if (best) {

                        detonateAsteroid(
                            p,
                            best
                        );
                    }


                    send(
                        p.socket,
                        {
                            type:
                                "laserFired",
                            charges:
                                p.powerupCharges
                        }
                    );


                    return;
                }
            }
        );


        socket.on(
            "close",
            () => {

                /*
                 * Remove tow asteroid.
                 */

                if (
                    player.towAsteroidId
                ) {

                    asteroids.delete(
                        player.towAsteroidId
                    );
                }


                players.delete(
                    playerID
                );


                broadcast({
                    type: "playerLeft",
                    id: playerID
                });

            }
        );
    });


/* =========================================================
   GAME LOOP
========================================================= */

maintainAsteroids();


setInterval(
    () => {

        const dt =
            TICK / 1000;


        updateAsteroids(dt);

        updateTowAsteroids();

        checkPlayerCollisions();

        maintainAsteroids();


        broadcast(
            worldState()
        );

    },
    TICK
);


httpServer.listen(
    PORT,
    "0.0.0.0",
    () => {

        console.log(
            "Rocket Impact Multiplayer running on port",
            PORT
        );

    }
);