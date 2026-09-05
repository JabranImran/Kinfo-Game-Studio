const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;

const httpServer = http.createServer((req, res) => {
    res.writeHead(200, {
        "Content-Type": "text/plain"
    });

    res.end("Rocket Impact multiplayer server is running!");
});

const wss = new WebSocket.Server({
    server: httpServer
});

const players = new Map();

function makeID() {
    return Math.random()
        .toString(36)
        .substring(2, 10);
}

function broadcastPlayers() {

    const playerList = [];

    for (const [id, player] of players) {

        playerList.push({
            id,
            x: player.x,
            y: player.y,
            angle: player.angle
        });

    }

    const message = JSON.stringify({
        type: "players",
        players: playerList
    });

    for (const client of wss.clients) {

        if (
            client.readyState ===
            WebSocket.OPEN
        ) {

            client.send(message);

        }

    }

}

function broadcast(data, except = null) {

    const message =
        JSON.stringify(data);

    for (const client of wss.clients) {

        if (
            client !== except &&
            client.readyState ===
            WebSocket.OPEN
        ) {

            client.send(message);

        }

    }

}


wss.on("connection", socket => {

    const id = makeID();

    players.set(id, {

        x: 0,
        y: 0,
        angle: -Math.PI / 2

    });


    socket.playerId = id;


    console.log(
        "Player connected:",
        id
    );


    socket.send(
        JSON.stringify({

            type: "welcome",

            id

        })
    );


    broadcastPlayers();


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


        const player =
            players.get(id);

        if (!player)
            return;


        /*
        PLAYER JOINED
        */

        if (
            message.type ===
            "join"
        ) {

            broadcastPlayers();

        }


        /*
        PLAYER POSITION
        */

        else if (
            message.type ===
            "state"
        ) {

            player.x =
                Number(message.x) || 0;

            player.y =
                Number(message.y) || 0;

            player.angle =
                Number(message.angle) || 0;


            broadcastPlayers();

        }


        /*
        ASTEROID BLAST
        */

        else if (
            message.type ===
            "blast"
        ) {

            broadcast({

                type: "blast",

                id,

                x:
                    Number(message.x) || 0,

                y:
                    Number(message.y) || 0,

                size:
                    Number(message.size) || 25

            }, socket);

        }

    });


    socket.on("close", () => {

        players.delete(id);

        console.log(
            "Player disconnected:",
            id
        );

        broadcastPlayers();

    });


    socket.on("error", error => {

        console.log(
            "WebSocket error:",
            error.message
        );

    });

});


httpServer.listen(
    PORT,
    () => {

        console.log(
            `Rocket Impact server running on port ${PORT}`
        );

    }
);