require("dotenv").config();

const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");

const app = express();

const PORT = process.env.PORT || 5000;
const CLIENT_URL = process.env.CLIENT_URL || "http://localhost:3000";

app.use(cors({ origin: CLIENT_URL }));
app.use(express.json());

app.get("/", (req, res) => {
  res.json({ message: "CineRate server running" });
});

app.get("/search", async (req, res) => {
  try {
    const { query } = req.query;

    if (!query) {
      return res.status(400).json({
        error: "Missing search query",
      });
    }

    const url = `https://www.omdbapi.com/?apikey=${process.env.OMDB_API}&type=movie&s=${encodeURIComponent(query)}`;

    const resp = await fetch(url);
    const data = await resp.json();
    const filteredResults = data.Search?.filter((movie) => movie.imdbID) || [];

    res.json(filteredResults);

  } catch (err) {
    console.error("OMDb search error", err);
    res.status(500).json({
      error: "Search failed",
    });
  }
});

app.get("/movie", async (req, res) => {
  try {
    const { imdbID } = req.query;

    if (!imdbID) {
      return res.status(400).json({
        error: "Missing imdbID",
      });
    }

    const url = `https://www.omdbapi.com/?apikey=${process.env.OMDB_API}&i=${imdbID}`;

    const resp = await fetch(url);
    const data = await resp.json();

    console.log("MOVIE DETAILS", data)

    res.json(data);

  } catch (err) {
    console.error("Movie details error", err);
    res.status(500).json({
      error: "Movie lookup failed",
    });
  }
});

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: CLIENT_URL,
    methods: ["GET", "POST"],
  },
});

function generateRoomID(){
    return crypto.randomUUID()
}

//active users; key = socket id
const users = {};

//active games; key = room id (random)
const games = {};

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  //add to users{}
  users[socket.id] = {
    name: socket.id,
    socketID: socket.id
  }

  //send online users to clients
  io.emit('online_users', Object.keys(users).length);

   //send games clients
  io.emit('games', games);

  //update player name
  socket.on ("update_name", ({socketid, name}) => {
    users[socketid].name = name;
  })

  //join game
  socket.on("join_game", ({targetGame, targetUser}) => {
    //add target user to target game
    games[targetGame].players.push(users[targetUser]);

     //join socket room
    socket.join(games[targetGame].roomID); 

    //send games clients
    io.emit('games', games);

    //send game to target user
    io.to(targetUser).emit("update_game", { gameData: games[targetGame] });

    //send updated game to other users in the room
    io.to(targetGame).emit("update_game", { gameData: games[targetGame] });
  })

  //create game
    socket.on ("create_game", ({socketid, gameName, playerCount, password, winCount}) => {
        //generate random room ID
        const roomID = generateRoomID();

        //create new game
        const newGame = {
            host: socketid,
            password: password,
            playerCount: playerCount,
            players: [users[socketid]],
            gameName: gameName,
            active: false,
            roomID: roomID,
            winCount: winCount
        }

        //add to games[]
        games[roomID] = newGame;
        
        //send games to clients
        io.emit('games', games);

        //join socket room
        socket.join(roomID); 

        //send new game to host
        io.to(socketid).emit("update_game", { gameData: newGame });
  })

  socket.on ("start_game", (game) => {
        //make game active
        game.active = true;
        game.state = "choose movie";
        
        //set guesses
        game.guesses = [];

        //random dealer
        let dealer = Math.floor(Math.random() * game.players.length);
        game.dealer = game.players[dealer]
        
        //set scores
        game.scores = JSON.parse(JSON.stringify(game.players)).map((user, index) => ({
            ...user,
            score: 0,
        }));

        //update games{}
        games[game.roomID] = game;
        
        //send games to clients
        io.emit('games', games);

        //send updated game to roomID
        io.to(game.roomID).emit("update_game", { gameData: game });
        io.to(game.roomID).emit("started_game", { gameData: game });
  })

    socket.on ("set_movie", ({game, movie}) => {
       //set guess movie
        game.guessMovie = movie;
        game.state = "submit rating";

        games[game.roomID] = game;

        //send updated game to roomID
        io.to(game.roomID).emit("update_game", { gameData: game });
        io.to(game.roomID).emit("movie_set", { gameData: game });
  })


      socket.on ("submit_rating", ({game, user, movieRating}) => {

        function checkForWinner(data) {
            console.log("CHECK FOR WINNERS", data)
            const winners = data.scores.filter((player) => player.score >= data.winCount);

            // No winners yet
            if (winners.length === 0) {
                return data;
            }

            // Add winners to data state
            data.winners = winners;
            console.log("WINNERS:", winners);
            return winners;
        }

function addScore(game) {
  console.log("ADD SCORE", game);

  const actualRating = Number(game.guessMovie.imdbRating);

  const validGuesses = game.guesses
    .map((guess) => ({
      ...guess,
      movieRating: Number(guess.movieRating),
    }))
    .filter((guess) => guess.movieRating <= actualRating);

  // Everyone went over
  if (validGuesses.length === 0) {
    console.log("Everyone went over. No points awarded.");

    game.roundWinners = [];

    return game;
  }

  const closestGuess = Math.max(
    ...validGuesses.map((guess) => guess.movieRating)
  );

  const winners = validGuesses.filter(
    (guess) => guess.movieRating === closestGuess
  );

  game.roundWinners = winners;

  game.scores = game.scores.map((playerScore) => {
    const wonPoint = winners.some(
      (winner) => winner.user === playerScore.socketID
    );

    return {
      ...playerScore,
      score: wonPoint
        ? playerScore.score + 1
        : playerScore.score,
    };
  });

  console.log("ROUND WINNERS:", winners);
  console.log("UPDATED SCORES:", game.scores);

  return game;
}

          function nextRound (data){
            console.log("NEXT ROUND CALLED", data);
            
            //check winner
            if(Array.isArray(checkForWinner(games[data.roomID]))){
                //game is over 
                games[data.roomID].state = "game over"
            }else{
                games[data.roomID].state = "choose movie"
                //reset round winners
                games[data.roomID].roundWinners = [];
                //reset guesses
                games[data.roomID].guesses = [];
            }
            console.log("PRIOR TO SEND", games[data.roomID])
            io.to(game.roomID).emit("update_game", { gameData: games[data.roomID] });
  }

        //add user guess to guesses[]
        game.guesses.push({user, movieRating})
       
        //check if all guesses are in
        if(game.guesses.length === game.players.length){
            //update game state
            game.state = "view round results";
            addScore(game);
            setTimeout(() => nextRound(game), 10000)
        }
        
        //update games{}
        games[game.roomID] = game;

        //send updated game to roomID
        io.to(game.roomID).emit("update_game", { gameData: game });
  })

  //disconnect
  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);

    //remove from any games

    //remove from users{}
    delete users[socket.id];

    //update online count
    io.emit('online_users', users.length);
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});